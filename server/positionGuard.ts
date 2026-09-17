/**
 * 持仓守护者 —— 抗噪宽止损 / 浮盈保本锁利 / 时间止损 / 止损冷静期 / 金字塔加仓门禁。
 *
 * 内化自 R20 Quantum Trader 的三条硬心法：
 *   ① 宽止损抗噪：止损必须设在结构外 1.8x~2.2x 1H ATR，给足波动呼吸空间，
 *      从物理上隔绝 15M/5M 杂波插针洗损。
 *   ② 浮盈 0.8R 保本锁利：浮盈达 0.8R 果断把止损拉到成本位，
 *      把「潜在亏损」彻底消除为零风险平仓——杜绝盈利变割肉。
 *   ③ 利润棘轮只上移绝不下移。
 *
 * 为什么 EVOLVE 需要这一层（现状诊断）：
 *   改造前 `autopilot.ts` 的 `tradeBar()` 每根 K 线调用策略 decide()，
 *   策略说什么就下什么 —— **全程没有任何止损**。同时 `StrategyContext.avgPrice`
 *   恒为 0，系统根本不知道自己的成本在哪，因此不具备判断「浮盈多少 R」的信息基础。
 *   结果是：策略只能在「买/卖」两个动作上做文章，无法表达「先拿住、破位再走」，
 *   这正是 paper 模式跑了几十小时仍以持仓被动升值为主、而非策略真实赚取的原因之一。
 *
 * 设计要点：
 *   - **1R 风险预算法**：仓位规模由「单笔可亏金额 ÷ 止损距离」反推，
 *     所以止损放宽时仓位自动缩小，单笔风险额恒定。这解开了「宽止损 = 高风险」的死结。
 *   - **纯状态机 + 注入时钟**：所有函数可离线单测，不依赖真实行情与系统时间。
 *   - **棘轮单调性**：止损只允许朝有利方向移动，任何情况都不放宽——
 *     这是「保本锁利」不变成「账面数字游戏」的物理保证。
 */

import {
  ATR_PERIOD,
  ATR_STOP_MULT_MAX,
  ATR_STOP_MULT_MIN,
  BREAKEVEN_BUFFER_PCT,
  BREAKEVEN_TRIGGER_R,
  EFFECTIVE_MIN_LEVERAGE,
  LEVERAGE_HARD_CEILING,
  LIQUIDATION_FEE_BUFFER_BPS,
  LIQUIDATION_MAINT_MARGIN_PCT,
  LIQUIDATION_SAFETY_MULT,
  MAX_LEVERAGE,
  MAX_MARGIN_EQUITY_RATIO,
  MAX_SCALE_IN_COUNT,
  MIN_SCALE_IN_CONFIDENCE,
  MIN_SCALE_IN_PROFIT_RATIO,
  PROFIT_LOCK_ATR_MULT,
  PROFIT_LOCK_TRIGGER_R,
  SINGLE_ASSET_EQUITY_RATIO,
  STOP_COOLDOWN_MINUTES,
  STOP_SAFETY_PCT_MAX,
  STOP_SAFETY_PCT_MIN,
  TIME_STOP_ATR_BAND,
  TIME_STOP_HOURS,
  TRAIL_ACTIVATE_R,
  riskBudgetPerTrade,
} from './riskConstants.ts'

export type PositionSide = 'long' | 'short'

export interface GuardPosition {
  symbol: string
  side: PositionSide
  entryPrice: number
  qty: number
  /** 建仓时锁定的 ATR —— 必须冻结，否则止损距离会随行情漂移，R 倍数失去意义。 */
  atrAtEntry: number
  initialStop: number
  currentStop: number
  openedAt: number
  breakevenArmed: boolean
  lockArmed: boolean
  scaleInCount: number
  /** 历史最高浮盈（R），用于峰值回撤保护。 */
  peakR: number
}

export type StopStage = 'breakeven' | 'lock' | 'trail'

export type GuardAction =
  | { action: 'hold'; r: number; reason: string }
  | { action: 'move_stop'; stop: number; stage: StopStage; r: number; reason: string }
  | { action: 'close'; trigger: 'stop_hit' | 'time_stop'; r: number; reason: string }

export interface GuardBar {
  high: number
  low: number
  close: number
}

// ─────────────────────────────────────────────────────────────
// 止损几何
// ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * 按波动强度在 [下限, 上限] 内选取 ATR 乘数。
 *
 * 为什么不固定成一个常数：死水行情里 2.2x ATR 可能只有 0.5% 的价格距离，
 * 松得毫无意义；极端行情里 1.8x ATR 可能是 8%，松到单笔就顶掉整个风险预算。
 * 让乘数跟随波动率自适应，才能让「止损距离」始终落在可用的价格带里。
 */
export function pickAtrMultiplier(entryPrice: number, atrValue: number): number {
  if (!(entryPrice > 0) || !(atrValue > 0)) return ATR_STOP_MULT_MIN
  const volPct = atrValue / entryPrice
  // 波动率 <0.4% 视为死水，>2.0% 视为剧烈；线性插值到乘数区间
  const t = clamp((volPct - 0.004) / (0.02 - 0.004), 0, 1)
  return ATR_STOP_MULT_MIN + (ATR_STOP_MULT_MAX - ATR_STOP_MULT_MIN) * t
}

export interface StopGeometry {
  distance: number
  distancePct: number
  atrMultiplier: number
  atrValue: number
}

/**
 * 计算止损距离：`clamp(乘数 × ATR, 1.8% × 价, 3.0% × 价)`。
 *
 * 语义澄清（这决定了「宽止损」到底是多宽）：
 *   - ATR 决定止损落在价格带内的**位置**：波动越大 → 取越宽乘数 → 越靠近 3%；
 *   - 价格带 [1.8%, 3.0%] 是**硬边界**，保证任何行情下止损都不会贴脸（洗损）也不会失控（风险臃肿）；
 *   - ATR 失效（NaN / 0，通常是 K 线不足）时退化到带宽上限 3%，即「宁可宽一点」。
 */
export function computeStopGeometry(entryPrice: number, atrValue: number, multOverride?: number): StopGeometry {
  const band = clamp(STOP_SAFETY_PCT_MIN, 0, STOP_SAFETY_PCT_MAX)
  const bandHi = Math.max(STOP_SAFETY_PCT_MAX, band)
  const floorDist = Math.max(band * entryPrice, 0)
  const ceilDist = Math.max(bandHi * entryPrice, 0)

  if (!(entryPrice > 0)) return { distance: 0, distancePct: 0, atrMultiplier: 0, atrValue: 0 }

  const mult = clamp(multOverride ?? pickAtrMultiplier(entryPrice, atrValue), ATR_STOP_MULT_MIN, ATR_STOP_MULT_MAX)

  if (!(atrValue > 0) || !Number.isFinite(atrValue)) {
    return { distance: ceilDist, distancePct: bandHi, atrMultiplier: mult, atrValue: 0 }
  }

  const raw = mult * atrValue
  const distance = clamp(raw, floorDist, ceilDist)
  return { distance, distancePct: distance / entryPrice, atrMultiplier: mult, atrValue }
}

/** 由入场价与止损距离推出初始止损价。 */
export function deriveInitialStop(side: PositionSide, entryPrice: number, geometry: StopGeometry): number {
  return side === 'long' ? entryPrice - geometry.distance : entryPrice + geometry.distance
}

// ─────────────────────────────────────────────────────────────
// 仓位规模（1R 风险预算反推）
// ─────────────────────────────────────────────────────────────

export interface SizingResult {
  qty: number
  riskAmount: number
  riskBudget: number
  bindingConstraint: 'risk_budget' | 'margin_cap' | 'single_asset_cap' | 'invalid'
  notional: number
}

/**
 * 按 1R 风险预算反推仓位规模。
 *
 * `qty = 风险预算 ÷ 每单位风险(止损距离)`，再受三道保证金/敞口上限约束取小。
 * 这样表达的核心意图：**风险管理的是「亏多少」，不是「买多少」**。
 * 止损越宽 → 每单位风险越大 → 买得越少，单笔亏损金额恒定。
 *
 * ── 杠杆的语义（⚠️ 这是本文件最容易被改错的一处） ──────────────────
 * **杠杆只影响「这笔仓位要占用多少保证金」，绝不影响「这笔仓位有多大」。**
 *
 * 仓位大小由 1R 风险预算决定；杠杆决定的是「同样大的仓位，需要压多少自有资金」。
 * 于是高杠杆带来的不是更大的仓位，而是**更少的保证金占用**——
 * 即「以小博大」的正确形态：小额保证金控制大额名义本金，但风险仍然是 1R。
 *
 * 曾经的写法是 `budget = riskBudgetPerTrade(equity) × lev`，即让杠杆**放大风险预算**。
 * 在 3x 时代它看起来"只是更激进"；在 125x 下它会算出 `1R = 权益的 125%`——
 * 一次止损打光整个账户。**杠杆放大收益的直觉在此处是致命的**，
 * 因为止损被打掉是高频事件，而不是尾部事件。
 *
 * ── 「以小博大」到底从哪里来 ────────────────────────────────────────
 * 不来自杠杆，来自**紧止损**：同样的 1R 预算，止损 0.4% 能开的仓位是止损 1.8% 的 4.5 倍。
 * 杠杆的作用只是让那个大仓位**付得起保证金**。所以本函数与
 * `maxSafeLeverage()` 必须联立使用——先由止损距离定杠杆上限，再定规模。
 */
export function sizePositionFromRisk(
  equity: number,
  entryPrice: number,
  stopDistance: number,
  existingAssetNotional = 0,
  leverage = 1,
): SizingResult {
  if (!(equity > 0) || !(entryPrice > 0) || !(stopDistance > 0)) {
    return { qty: 0, riskAmount: 0, riskBudget: 0, bindingConstraint: 'invalid', notional: 0 }
  }

  const lev = levScale(leverage)
  // 1R 风险预算：与杠杆**无关**。杠杆不能让人"愿意亏更多"。
  const budget = riskBudgetPerTrade(equity)
  const byRisk = budget / stopDistance
  // 保证金上限：杠杆在这里正确生效——同样名义本金，杠杆越高占用越少。
  const marginCapQty = (equity * MAX_MARGIN_EQUITY_RATIO * lev) / entryPrice
  const singleAssetRoom = Math.max(equity * SINGLE_ASSET_EQUITY_RATIO * lev - existingAssetNotional, 0)
  const singleAssetQty = singleAssetRoom / entryPrice

  let qty = byRisk
  let binding: SizingResult['bindingConstraint'] = 'risk_budget'
  if (marginCapQty < qty) {
    qty = marginCapQty
    binding = 'margin_cap'
  }
  if (singleAssetQty < qty) {
    qty = singleAssetQty
    binding = 'single_asset_cap'
  }

  qty = Math.max(0, Math.floor(qty * 1e5) / 1e5)
  return { qty, riskAmount: qty * stopDistance, riskBudget: budget, bindingConstraint: binding, notional: qty * entryPrice }
}

/** 杠杆钳制：永远落在 [下限, 上限]，非有限值退化为 1（不加杠杆）。 */
function levScale(leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return 1
  return clamp(leverage, EFFECTIVE_MIN_LEVERAGE, MAX_LEVERAGE)
}

// ─────────────────────────────────────────────────────────────
// 强平几何 —— 杠杆的安全边界（与规模计算联立，不可拆开读）
//
// 为什么必须有这一层：杠杆的失效方式**不是亏得多，而是止损从未生效**。
//   125x 的强平距离约 1/125 = 0.8%；扣掉维持保证金 0.5% 与费率缓冲 0.2%，
//   真实缓冲只剩 0.1%。而止损单挂在 1.8% 处 —— 价格走到 0.8% 就已被强平，
//   止损单还在簿上，账户已经没了。此时系统会记录一笔"正常止损"，
//   而实际发生的是爆仓：**账面叙事与真实因果完全脱钩**，这类缺陷最难发现。
// ─────────────────────────────────────────────────────────────

export interface LiquidationGeometry {
  /** 强平价。 */
  price: number
  /** 强平距离占入场价比例（含维持保证金与费率缓冲）。0 表示杠杆 ≤ 1（现货，无强平）。 */
  distancePct: number
}

/**
 * 由入场价、方向、杠杆推出强平价（逐仓/全仓近似式）。
 *
 * 公式（忽略资金费，费率以缓冲项单独扣）：
 *   多单：强平价 = 入场 × (1 − 1/L + 维持保证金率)
 *   空单：强平价 = 入场 × (1 + 1/L − 维持保证金率)
 * 即**有效强平距离 ≈ 1/L − 维持保证金率**，再扣费率缓冲。
 *
 * 为什么用近似式而不是交易所逐档维持保证金表：本函数是**风控下界**，
 * 取比交易所更保守的常数维持保证金率即可；引入逐档表会把「安全边界」
 * 变成「跟随交易所口径」——交易所调档时我们的边界就静默漂移了。
 */
export function liquidationGeometry(
  entryPrice: number,
  side: PositionSide,
  leverage: number,
): LiquidationGeometry {
  if (!(entryPrice > 0)) return { price: 0, distancePct: 0 }
  const lev = levScale(leverage)
  if (lev <= 1) return { price: 0, distancePct: 0 }

  const maint = clamp(LIQUIDATION_MAINT_MARGIN_PCT, 0, 0.5)
  const fee = Math.max(LIQUIDATION_FEE_BUFFER_BPS, 0) / 10_000
  const raw = 1 / lev - maint - fee
  const distancePct = Math.max(raw, 0)

  const price = side === 'long' ? entryPrice * (1 - distancePct) : entryPrice * (1 + distancePct)
  return { price, distancePct }
}

/**
 * 给定止损距离，反推**安全杠杆上限**。
 *
 * 约束：`强平距离 ≥ 止损距离 × 强平安全倍数`
 *   即 `1/L − 维持保证金率 − 费率缓冲 ≥ stopPct × mult`
 *   解得 `L ≤ 1 / (stopPct × mult + 维持保证金率 + 费率缓冲)`
 *
 * 返回值同时被 `MAX_LEVERAGE`（配置上限）与 `LEVERAGE_HARD_CEILING`（代码硬边界）钳制，
 * 且不小于 1（至少现货）。
 *
 * ⚠️ 关于 125x 的现实：取默认参数（mult=1.5、维持保证金 0.5%、费率缓冲 0.2%），
 *   要支撑 125x 需要 `stopPct ≤ 0.067%` —— 比多数合约的买卖价差还窄。
 *   所以 **125x 是天花板，不是可达目标**：真正能用的杠杆由这一笔的止损宽度决定。
 *   这不是限制，而是「止损必须先于强平」这条物理约束的直接推论。
 */
export function maxSafeLeverage(stopPct: number): number {
  return maxSafeLeverageDetail(stopPct).applied
}

export interface SafeLeverageDetail {
  /** 几何允许的倍数（钳制**之前**）。 */
  raw: number
  /** 实际生效的倍数。 */
  applied: number
  /** 是几何卡的、还是配置卡的。区分二者很重要：前者再调配置也没用。 */
  ceiling: 'geometry' | 'config' | 'hard-ceiling'
}

/**
 * 与 `maxSafeLeverage` 同源，额外把「钳制前 / 钳制后 / 谁卡的」一起给出来。
 *
 * 存在的理由：任务裁定层要向用户解释"为什么高杠杆没有帮助"，
 * 而这句话的两种成因处置完全不同 ——
 *   · `geometry` 卡住：与杠杆配置无关，是这一笔的止损太宽（调 EV_MAX_LEVERAGE 无效）；
 *   · `config` 卡住：几何还能给更高，是配置只给到这么多（可调，但对目标无贡献）。
 * 把两者混成一句"杠杆不够"，用户会去反复抬 EV_MAX_LEVERAGE，
 * 而其中一半情况下那个动作**完全无效**。
 *
 * ★ 公式只有这一份：`maxSafeLeverage` 是本函数的薄封装。
 * 抄第二份就一定会在某次调参后与真身分岔。
 */
export function maxSafeLeverageDetail(stopPct: number): SafeLeverageDetail {
  if (!(stopPct > 0)) return { raw: 0, applied: 1, ceiling: 'geometry' }
  const maint = clamp(LIQUIDATION_MAINT_MARGIN_PCT, 0, 0.5)
  const fee = Math.max(LIQUIDATION_FEE_BUFFER_BPS, 0) / 10_000
  const mult = Math.max(LIQUIDATION_SAFETY_MULT, 1)
  const denom = stopPct * mult + maint + fee
  if (!(denom > 0)) return { raw: LEVERAGE_HARD_CEILING, applied: LEVERAGE_HARD_CEILING, ceiling: 'hard-ceiling' }
  const raw = 1 / denom
  const byConfig = Math.min(MAX_LEVERAGE, LEVERAGE_HARD_CEILING)
  const applied = clamp(Math.floor(raw * 100) / 100, 1, byConfig)
  const ceiling: SafeLeverageDetail['ceiling'] =
    raw > byConfig ? (MAX_LEVERAGE > LEVERAGE_HARD_CEILING ? 'hard-ceiling' : 'config') : 'geometry'
  return { raw: Math.floor(raw * 100) / 100, applied, ceiling }
}

export interface LiquidationVerdict {
  ok: boolean
  /** 实际采用的杠杆（已被强平约束钳制）。 */
  leverage: number
  /** 请求的杠杆（可能被钳制，故与实际值分开保存）。 */
  requestedLeverage: number
  stopPct: number
  liqDistancePct: number
  /** 强平距离 ÷ 止损距离。≥ LIQUIDATION_SAFETY_MULT 才放行；杠杆 ≤ 1 时为 Infinity。 */
  safetyRatio: number
  reason: string
}

/**
 * 强平守卫：确认「止损一定先于强平触发」，否则把杠杆钳到安全上限。
 *
 * 设计选择：**钳制而不是拒绝**。
 *   拒绝会让「高杠杆请求」变成一次无声的机会损失（用户不知道为什么没成交）；
 *   钳制则让这笔交易以**能活下来的杠杆**成交，并把"原本想要更多倍"记录在返回值里。
 *   对于「止损先于强平」这条物理约束，降杠杆是保持交易意图的唯一可行调整——
 *   缩止损会改变策略语义（那是策略层的决定，不是风控层能替它做的）。
 *
 * 杠杆 ≤ 1 时（现货）没有强平，直接放行。
 */
export function assertStopBeforeLiquidation(
  entryPrice: number,
  side: PositionSide,
  stopPct: number,
  requestedLeverage: number,
): LiquidationVerdict {
  const requested = Number.isFinite(requestedLeverage) && requestedLeverage > 1 ? requestedLeverage : 1
  if (!(stopPct > 0) || !(entryPrice > 0)) {
    return {
      ok: false,
      leverage: 1,
      requestedLeverage: requested,
      stopPct,
      liqDistancePct: 0,
      safetyRatio: 0,
      reason: '止损距离或入场价无效，无法验证强平安全',
    }
  }
  if (requested <= 1) {
    return {
      ok: true,
      leverage: 1,
      requestedLeverage: 1,
      stopPct,
      liqDistancePct: 0,
      safetyRatio: Number.POSITIVE_INFINITY,
      reason: '现货（无杠杆），不存在强平',
    }
  }

  const requestedClamped = Math.min(requested, MAX_LEVERAGE, LEVERAGE_HARD_CEILING)
  const safe = maxSafeLeverage(stopPct)
  const leverage = Math.min(requestedClamped, safe)
  const liq = liquidationGeometry(entryPrice, side, leverage)
  const safetyRatio = stopPct > 0 ? liq.distancePct / stopPct : 0

  if (leverage < requested) {
    return {
      ok: true,
      leverage,
      requestedLeverage: requested,
      stopPct,
      liqDistancePct: liq.distancePct,
      safetyRatio,
      reason:
        `请求 ${requested}x 会使强平距离(${(liq.distancePct * 100).toFixed(3)}%) 不足止损距离` +
        `(${(stopPct * 100).toFixed(3)}%) 的 ${LIQUIDATION_SAFETY_MULT} 倍 —— 止损会晚于强平触发。` +
        `已钳制到安全杠杆 ${leverage}x。`,
    }
  }

  if (safetyRatio < LIQUIDATION_SAFETY_MULT) {
    // 理论上不可达（maxSafeLeverage 已保证），保留为断言而非静默通过
    return {
      ok: false,
      leverage: 1,
      requestedLeverage: requested,
      stopPct,
      liqDistancePct: liq.distancePct,
      safetyRatio,
      reason: `强平安全比 ${safetyRatio.toFixed(2)} < ${LIQUIDATION_SAFETY_MULT}，拒绝开仓（内部不变量被破坏）`,
    }
  }

  return {
    ok: true,
    leverage,
    requestedLeverage: requested,
    stopPct,
    liqDistancePct: liq.distancePct,
    safetyRatio,
    reason: `杠杆 ${leverage}x 安全：强平距离 ${(liq.distancePct * 100).toFixed(3)}% ≥ 止损 ${(stopPct * 100).toFixed(3)}% × ${LIQUIDATION_SAFETY_MULT}`,
  }
}

/** 由名义本金与杠杆反推所需保证金。杠杆 ≤ 1 时即名义本金本身（现货全额）。 */
export function marginRequired(notional: number, leverage: number): number {
  const lev = levScale(leverage)
  return lev > 1 ? notional / lev : notional
}

// ─────────────────────────────────────────────────────────────
// R 倍数
// ─────────────────────────────────────────────────────────────

/** 当前浮盈换算成 R 倍数。R = 初始风险距离；1R 意味着「赚到了一个止损的宽度」。 */
export function rMultiple(pos: GuardPosition, markPrice: number): number {
  const risk = Math.abs(pos.entryPrice - pos.initialStop)
  if (!(risk > 0)) return 0
  const move = pos.side === 'long' ? markPrice - pos.entryPrice : pos.entryPrice - markPrice
  return move / risk
}

/** 未实现盈亏率（相对成本价，不含杠杆）。加仓门禁与时间止损都用它。 */
export function unrealizedRoi(pos: GuardPosition, markPrice: number): number {
  if (!(pos.entryPrice > 0)) return 0
  const move = pos.side === 'long' ? markPrice - pos.entryPrice : pos.entryPrice - markPrice
  return move / pos.entryPrice
}

// ─────────────────────────────────────────────────────────────
// 止损棘轮 —— 只上移，绝不下移
// ─────────────────────────────────────────────────────────────

/**
 * 评估单根 K 线，决定「继续持有 / 上移止损 / 平仓」。
 *
 * 判定顺序刻意固定为：**先看止损有没有被打掉，再看是否该上移**。
 * 反过来的话，在插针那根 K 线上会先用新止损判 hold、再移动，
 * 等于用「事后才收紧的止损」去解释已经发生的破位，会漏掉本应离场的时点。
 */
export function evaluatePosition(pos: GuardPosition, bar: GuardBar, now: number): GuardAction {
  const r = rMultiple(pos, bar.close)

  // ① 止损是否被打掉（用 K 线极值，而非收盘价——插针正是靠影线扫损）
  const stopHit = pos.side === 'long' ? bar.low <= pos.currentStop : bar.high >= pos.currentStop
  if (stopHit) {
    const locked = pos.breakevenArmed || pos.lockArmed
    return {
      action: 'close',
      trigger: 'stop_hit',
      r,
      reason: locked
        ? `触发${pos.lockArmed ? '利润棘轮' : '保本'}止损 @${pos.currentStop.toFixed(2)}（已锁定，本笔不亏）`
        : `触发初始止损 @${pos.currentStop.toFixed(2)}，亏损 ${(r * 100).toFixed(0)}% R`,
    }
  }

  // ② 时间止损：超时且仍在横盘，主动释放仓位配比
  const heldHours = (now - pos.openedAt) / 3_600_000
  if (heldHours >= TIME_STOP_HOURS) {
    const band = TIME_STOP_ATR_BAND * pos.atrAtEntry
    const excursion = Math.abs(bar.close - pos.entryPrice)
    if (excursion < band) {
      return {
        action: 'close',
        trigger: 'time_stop',
        r,
        reason: `持仓 ${heldHours.toFixed(1)}h 未突破横盘带宽（波幅 ${excursion.toFixed(2)} < ${band.toFixed(2)}），时间止损释放保证金`,
      }
    }
  }

  // ③ 保本移损：浮盈达 0.8R，把潜在亏损消除为零（加一点点缓冲覆盖双边手续费）
  if (!pos.breakevenArmed && r >= BREAKEVEN_TRIGGER_R) {
    const buffer = Math.abs(pos.entryPrice) * BREAKEVEN_BUFFER_PCT
    const stop = pos.side === 'long' ? pos.entryPrice + buffer : pos.entryPrice - buffer
    if (betterStop(pos.side, stop, pos.currentStop)) {
      return {
        action: 'move_stop',
        stop,
        stage: 'breakeven',
        r,
        reason: `浮盈达 ${r.toFixed(2)}R ≥ ${BREAKEVEN_TRIGGER_R}R，止损上移至成本位保本锁利`,
      }
    }
  }

  // ④ 利润棘轮一级：浮盈达 1.5R，锁定至少 1x ATR 的利润
  if (!pos.lockArmed && r >= PROFIT_LOCK_TRIGGER_R) {
    const lockDist = PROFIT_LOCK_ATR_MULT * pos.atrAtEntry
    const stop = pos.side === 'long' ? pos.entryPrice + lockDist : pos.entryPrice - lockDist
    if (betterStop(pos.side, stop, pos.currentStop)) {
      return {
        action: 'move_stop',
        stop,
        stage: 'lock',
        r,
        reason: `浮盈达 ${r.toFixed(2)}R ≥ ${PROFIT_LOCK_TRIGGER_R}R，止损上移锁定 ${PROFIT_LOCK_ATR_MULT}x ATR 利润`,
      }
    }
  }

  // ⑤ 跟踪止损：浮盈达 2.2R 后按 ATR 跟随，只上移
  if (r >= TRAIL_ACTIVATE_R) {
    const stop = pos.side === 'long' ? bar.close - pos.atrAtEntry : bar.close + pos.atrAtEntry
    if (betterStop(pos.side, stop, pos.currentStop)) {
      return {
        action: 'move_stop',
        stop,
        stage: 'trail',
        r,
        reason: `浮盈 ${r.toFixed(2)}R 已达跟踪阈值，止损跟随至 ${stop.toFixed(2)}（棘轮只上移）`,
      }
    }
  }

  return { action: 'hold', r, reason: `持有中 · ${r.toFixed(2)}R` }
}

/** 「更好」= 对多头更高、对空头更低。棘轮单调性的唯一判定入口。 */
function betterStop(side: PositionSide, candidate: number, current: number): boolean {
  return side === 'long' ? candidate > current + 1e-9 : candidate < current - 1e-9
}

/** 应用 move_stop 动作，返回新持仓（不可变更新，便于回放与测试）。 */
export function applyStopAction(pos: GuardPosition, action: GuardAction): GuardPosition {
  if (action.action !== 'move_stop') return pos
  return {
    ...pos,
    currentStop: action.stop,
    breakevenArmed: pos.breakevenArmed || action.stage === 'breakeven' || action.stage === 'lock' || action.stage === 'trail',
    lockArmed: pos.lockArmed || action.stage === 'lock' || action.stage === 'trail',
    peakR: Math.max(pos.peakR, action.r),
  }
}

// ─────────────────────────────────────────────────────────────
// 开仓登记 / 止损冷静期
// ─────────────────────────────────────────────────────────────

const positions = new Map<string, GuardPosition>()
const cooldowns = new Map<string, number>()

function posKey(symbol: string): string {
  return symbol.toUpperCase()
}
function dirKey(symbol: string, side: PositionSide): string {
  return `${symbol.toUpperCase()}:${side}`
}

export interface OpenRequest {
  symbol: string
  side: PositionSide
  entryPrice: number
  qty: number
  atrValue: number
  now: number
  multOverride?: number
}

/** 登记一笔受守护的持仓，返回持仓对象（含初始止损）。 */
export function openPosition(req: OpenRequest): GuardPosition {
  const geometry = computeStopGeometry(req.entryPrice, req.atrValue, req.multOverride)
  const pos: GuardPosition = {
    symbol: posKey(req.symbol),
    side: req.side,
    entryPrice: req.entryPrice,
    qty: req.qty,
    atrAtEntry: req.atrValue > 0 && Number.isFinite(req.atrValue) ? req.atrValue : geometry.distance,
    initialStop: deriveInitialStop(req.side, req.entryPrice, geometry),
    currentStop: deriveInitialStop(req.side, req.entryPrice, geometry),
    openedAt: req.now,
    breakevenArmed: false,
    lockArmed: false,
    scaleInCount: 0,
    peakR: 0,
  }
  positions.set(posKey(req.symbol), pos)
  return pos
}

export function getPosition(symbol: string): GuardPosition | undefined {
  return positions.get(posKey(symbol))
}

export function listPositions(): GuardPosition[] {
  return [...positions.values()]
}

export function updatePosition(pos: GuardPosition): void {
  positions.set(posKey(pos.symbol), pos)
}

/** 平仓登记：记录止损出局并开启冷静期，防止情绪化反手。 */
export function closePosition(symbol: string, wasStoppedOut: boolean, now: number, side?: PositionSide): void {
  const key = posKey(symbol)
  const pos = positions.get(key)
  const exitSide = side ?? pos?.side
  positions.delete(key)
  if (wasStoppedOut && exitSide) {
    cooldowns.set(dirKey(symbol, exitSide), now + STOP_COOLDOWN_MINUTES * 60_000)
  }
}

export interface CooldownStatus {
  blocked: boolean
  remainingMs: number
  reason?: string
}

/** 冷静期检查：止损出局后同标的同向在窗口内禁止再开仓。 */
export function checkCooldown(symbol: string, side: PositionSide, now: number): CooldownStatus {
  const until = cooldowns.get(dirKey(symbol, side))
  if (until === undefined) return { blocked: false, remainingMs: 0 }
  const remaining = until - now
  if (remaining <= 0) {
    cooldowns.delete(dirKey(symbol, side))
    return { blocked: false, remainingMs: 0 }
  }
  const minutes = Math.ceil(remaining / 60_000)
  return {
    blocked: true,
    remainingMs: remaining,
    reason: `该标的 ${side === 'long' ? '多' : '空'}向刚止损出局，冷静期剩余 ${minutes} 分钟（防情绪化反手）`,
  }
}

/** 反向持仓冲突检查：已有反向仓时禁止借决策通道反向开仓。 */
export function hasConflictingPosition(symbol: string, side: PositionSide): boolean {
  const pos = positions.get(posKey(symbol))
  if (!pos) return false
  return pos.side !== side
}

// ─────────────────────────────────────────────────────────────
// 金字塔加仓门禁
// ─────────────────────────────────────────────────────────────

export interface ScaleInDecision {
  allowed: boolean
  reason: string
}

/**
 * 顺势浮盈加仓的三重门禁：次数 / 底仓浮盈 / 置信度。
 * 三条全过才允许，任何一条不过即拒绝——「绝不浮盈外加仓」是这里最硬的一条。
 */
export function canScaleIn(pos: GuardPosition, markPrice: number, confidence: number): ScaleInDecision {
  if (MAX_SCALE_IN_COUNT <= 0) {
    return { allowed: false, reason: '金字塔加仓已关闭（最大加仓次数 = 0）' }
  }
  if (pos.scaleInCount >= MAX_SCALE_IN_COUNT) {
    return { allowed: false, reason: `已达最大加仓次数 ${MAX_SCALE_IN_COUNT}` }
  }
  const roi = unrealizedRoi(pos, markPrice)
  if (roi < MIN_SCALE_IN_PROFIT_RATIO) {
    return {
      allowed: false,
      reason: `底仓浮盈 ${(roi * 100).toFixed(3)}% 未达 ${(MIN_SCALE_IN_PROFIT_RATIO * 100).toFixed(1)}%，禁止浮盈外加仓`,
    }
  }
  if (confidence < MIN_SCALE_IN_CONFIDENCE) {
    return { allowed: false, reason: `置信度 ${confidence.toFixed(1)}% 低于加仓门禁 ${MIN_SCALE_IN_CONFIDENCE}%` }
  }
  return { allowed: true, reason: `满足加仓三重门禁（第 ${pos.scaleInCount + 1}/${MAX_SCALE_IN_COUNT} 次）` }
}

// ─────────────────────────────────────────────────────────────
// 维护接口
// ─────────────────────────────────────────────────────────────

/** 服务重启 / 状态重置时清空，避免用陈旧止损守护新持仓。 */
export function resetGuard(): void {
  positions.clear()
  cooldowns.clear()
}

export function guardStatus(): {
  positions: GuardPosition[]
  cooldowns: { symbol: string; until: number }[]
  config: {
    atrPeriod: number
    atrMultRange: [number, number]
    stopBandPct: [number, number]
    breakevenTriggerR: number
    profitLockTriggerR: number
    trailActivateR: number
    timeStopHours: number
    cooldownMinutes: number
    maxScaleInCount: number
  }
} {
  return {
    positions: listPositions(),
    cooldowns: [...cooldowns.entries()].map(([k, until]) => ({ symbol: k, until })),
    config: {
      atrPeriod: ATR_PERIOD,
      atrMultRange: [ATR_STOP_MULT_MIN, ATR_STOP_MULT_MAX],
      stopBandPct: [STOP_SAFETY_PCT_MIN, STOP_SAFETY_PCT_MAX],
      breakevenTriggerR: BREAKEVEN_TRIGGER_R,
      profitLockTriggerR: PROFIT_LOCK_TRIGGER_R,
      trailActivateR: TRAIL_ACTIVATE_R,
      timeStopHours: TIME_STOP_HOURS,
      cooldownMinutes: STOP_COOLDOWN_MINUTES,
      maxScaleInCount: MAX_SCALE_IN_COUNT,
    },
  }
}
