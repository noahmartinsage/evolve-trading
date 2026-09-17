/**
 * EVOLVE 执行层风控参数 —— 单一事实源 (Single Source of Truth)
 *
 * 内化自 R20 Quantum Trader 的 `scripts/risk_constants.py` 设计范式。
 *
 * 为什么需要这个文件（而不是继续 `process.env.X ?? 50000` 散落各处）：
 *   1. 阈值散落在 autopilot / risk / gateway 三处时，改一个漏一个，风控口径会悄悄漂移；
 *   2. 提示词侧（LLM 提案器）必须读到与执行层**同一口径**的风险预算，
 *      否则模型以为自己是 2% 风险、执行层却是 0.5%，两边对不上；
 *   3. 后台「风控管理中心」写入 .env 后，执行层在**下一个巡检周期** import 本模块即自动生效，
 *      无需重启进程（重启会中断正在跑的自治循环）。
 *
 * 三条纪律：
 *   - 每个参数以 EV_ 前缀命名，默认值与迁移前的硬编码值**完全一致**（迁移不改行为）；
 *   - `DEFAULTS` 必须是字面量，**绝不能引用上面已按 .env 解析过的常量**——
 *     否则用户应用过预设套件后 DEFAULTS 被 .env 污染，UI 的「恢复默认」会失真；
 *   - `EVOLVE_RISK_SCHEMA`（riskConfig.ts）必须与本文件 DEFAULTS 键集一一对应，
 *     不一致时**启动即断言失败**（见文件末尾自检）。
 */

import { loadDotEnv } from './loadEnv.ts'

// 独立运行（直接 node server/xxx.ts）时也要拿到 .env；backend 调度路径下重复加载无害（幂等）。
loadDotEnv()

function envNum(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function envInt(key: string, fallback: number): number {
  const n = envNum(key, fallback)
  return Math.trunc(n)
}

// ─────────────────────────────────────────────────────────────
// 组 1 · 仓位与敞口
// ─────────────────────────────────────────────────────────────
/** 最大并发持仓数。0 = 自动跟随标的池容量。 */
export let MAX_CONCURRENT_POSITIONS = envInt('EV_MAX_CONCURRENT_POSITIONS', 0)
/** 同向持仓上限：防高相关标的同向堆叠踩踏（纸交易单标的场景下等价于「不叠仓」）。 */
export let MAX_SAME_DIRECTION_POSITIONS = envInt('EV_MAX_SAME_DIRECTION_POSITIONS', 2)
/** 单笔下单保证金占可用权益硬顶。 */
export let MAX_MARGIN_EQUITY_RATIO = envNum('EV_MAX_MARGIN_EQUITY_RATIO', 0.2)
/** 单标的累计占用保证金占可用权益上限（含金字塔加仓）。 */
export let SINGLE_ASSET_EQUITY_RATIO = envNum('EV_SINGLE_ASSET_EQUITY_RATIO', 0.35)
/** 杠杆上限：执行层强制钳制不超过此倍数。 */
export let MAX_LEVERAGE = envNum('EV_MAX_LEVERAGE', 3)
/** 杠杆下限：自治引擎在 [下限, 上限] 内取值，低于下限会被抬升钳制。 */
export let MIN_LEVERAGE = envNum('EV_MIN_LEVERAGE', 1)
/** 交叉守卫：不允许下限越过上限（分次保存 .env 时的中间态兜底）。 */
export let EFFECTIVE_MIN_LEVERAGE = Math.min(MIN_LEVERAGE, MAX_LEVERAGE)

// ─────────────────────────────────────────────────────────────
// 组 2 · 单笔风险门禁（1R 定义）
// ─────────────────────────────────────────────────────────────
/**
 * 单笔 1R 风险额占可用权益比例。
 * 「1R」= 该笔交易在止损被打掉时允许亏损的金额。仓位规模由 1R 与止损距离反推，
 * 这是把「止损宽度」与「下单量」解耦的关键——止损放宽时自动缩量，风险额恒定。
 */
export let RISK_PER_TRADE_RATIO = envNum('EV_RISK_PER_TRADE_RATIO', 0.01)
/** 最小盈亏比硬底线，低于该值的报价被 orderRisk 物理拦截。 */
export let MIN_RISK_REWARD_RATIO = envNum('EV_MIN_RISK_REWARD', 2.0)
/** 新开仓最低置信度门禁（%）。 */
export let MIN_ENTRY_CONFIDENCE = envNum('EV_MIN_ENTRY_CONFIDENCE', 70)

// ─────────────────────────────────────────────────────────────
// 组 3 · 止损几何（内化 R20「抗噪宽止损 + 浮盈保本锁利」核心）
// ─────────────────────────────────────────────────────────────
/** ATR 周期（根），用于计算波动尺度。 */
export let ATR_PERIOD = envInt('EV_ATR_PERIOD', 14)
/** 止损 ATR 乘数下限：结构外 1.8x 1H ATR 是「给足呼吸空间」的最低配。 */
export let ATR_STOP_MULT_MIN = envNum('EV_ATR_STOP_MULT_MIN', 1.8)
/** 止损 ATR 乘数上限：2.2x，超过则单笔风险过于臃肿。 */
export let ATR_STOP_MULT_MAX = envNum('EV_ATR_STOP_MULT_MAX', 2.2)
/** 止损安全垫下限（占价格比例）：ATR 极小的死水行情下仍保留 1.8% 垫子。 */
export let STOP_SAFETY_PCT_MIN = envNum('EV_STOP_SAFETY_PCT_MIN', 0.018)
/** 止损安全垫上限：3.0%，防 ATR 爆炸时止损被推到天边。 */
export let STOP_SAFETY_PCT_MAX = envNum('EV_STOP_SAFETY_PCT_MAX', 0.03)
/** 浮盈达到多少 R 时把止损拉到成本位（保本锁利）。R20 官方基准 = 0.8R。 */
export let BREAKEVEN_TRIGGER_R = envNum('EV_BREAKEVEN_TRIGGER_R', 0.8)
/** 保本止损相对成本价的缓冲（覆盖双边手续费 + 滑点），默认 +0.1%。 */
export let BREAKEVEN_BUFFER_PCT = envNum('EV_BREAKEVEN_BUFFER_PCT', 0.001)
/** 利润棘轮一级：浮盈达到该 R 时，止损上移到「锁定至少 PROFIT_LOCK_ATR_MULT × ATR」。 */
export let PROFIT_LOCK_TRIGGER_R = envNum('EV_PROFIT_LOCK_TRIGGER_R', 1.5)
/** 棘轮一级至少锁定的利润幅度（× ATR）。 */
export let PROFIT_LOCK_ATR_MULT = envNum('EV_PROFIT_LOCK_ATR_MULT', 1.0)
/** 移动止损激活阈值：浮盈达该 R 后启用 ATR 跟踪止损（只用棘轮上移，绝不下移）。 */
export let TRAIL_ACTIVATE_R = envNum('EV_TRAIL_ACTIVATE_R', 2.2)

// ─────────────────────────────────────────────────────────────
// 组 4 · 时间停止与熔断
// ─────────────────────────────────────────────────────────────
/** 最长持仓时间（小时）：超时且波幅不足横盘带宽 → 时间止损平仓，释放仓位配比。 */
export let TIME_STOP_HOURS = envNum('EV_TIME_STOP_HOURS', 8)
/** 时间止损的「横盘」判定带宽（× ATR）：浮盈绝对值小于该带宽才视为无突破。 */
export let TIME_STOP_ATR_BAND = envNum('EV_TIME_STOP_ATR_BAND', 0.15)
/** 止损出局后同标的同向冷静期（分钟）：防情绪化反手与连续磨损。 */
export let STOP_COOLDOWN_MINUTES = envInt('EV_STOP_COOLDOWN_MINUTES', 30)
/** 单日亏损熔断绝对封顶（USDC）。0 = 只看比例。 */
export let MAX_DAILY_LOSS_USDC = envNum('EV_MAX_DAILY_LOSS_USDC', 0)
/** 单日亏损熔断占权益比例（与绝对封顶取小）。 */
export let DAILY_LOSS_EQUITY_RATIO = envNum('EV_DAILY_LOSS_EQUITY_RATIO', 0.05)

// ─────────────────────────────────────────────────────────────
// 组 5 · 顺势金字塔加仓门禁
// ─────────────────────────────────────────────────────────────
/** 单标的最大顺势加仓次数。0 = 彻底禁止加仓（只允许底仓）。 */
export let MAX_SCALE_IN_COUNT = envInt('EV_MAX_SCALE_IN_COUNT', 1)
/** 允许加仓的最小底仓浮盈率（0.008 = +0.8%）。绝不浮盈外加仓。 */
export let MIN_SCALE_IN_PROFIT_RATIO = envNum('EV_MIN_SCALE_IN_PROFIT_RATIO', 0.008)
/** 加仓需要达到的最低置信度（%），通常应高于新开仓门禁。 */
export let MIN_SCALE_IN_CONFIDENCE = envNum('EV_MIN_SCALE_IN_CONFIDENCE', 75)

// ─────────────────────────────────────────────────────────────
// 组 6 · 执行网关（迁移自既有硬编码，默认值保持完全一致）
// ─────────────────────────────────────────────────────────────
/** 单笔名义本金上限（USDC）。 */
export let MAX_NOTIONAL_PER_ORDER = envNum('EV_MAX_NOTIONAL_PER_ORDER', 50_000)
/** 价格偏离标记价上限（bps）。 */
export let PRICE_DEVIATION_BPS = envNum('EV_PRICE_DEVIATION_BPS', 300)
/** 每分钟最大下单数。 */
export let MAX_ORDERS_PER_MINUTE = envInt('EV_MAX_ORDERS_PER_MINUTE', 30)
/** 组合最大回撤熔断（%）：触及即联动 killswitch。 */
export let MAX_DRAWDOWN_PCT = envNum('EV_MAX_DRAWDOWN_PCT', 20)

// ─────────────────────────────────────────────────────────────
// 组 7 · 成本硬约束与可信执行
//
// 为什么成本参数必须进这张表，而不是留在成本模块的私有默认值里：
//   费率、资金费、滑点假设都是**会变的场所事实**，且直接决定一笔交易的可行性。
//   它们若只存在于某个模块内部，风控面板看不到、提示词读不到，
//   模型就会在一个「无成本世界」里提提案 —— 回测赚、实盘亏，差额全在这里。
//   放进本表后：面板可调 → 提示词插值同源 → 执行层闸门同源，三处一个口径。
//
// 实证依据：lazi-nhr/AI-Trading-Agent 的样本外结论是，费率从 0 → 1.44bps → 4.50bps，
//   夏普与最大回撤急剧劣化 —— 交易成本是高频策略的关键限制因子，
//   而不是事后统计项。所以这里把它做成**决策闸门**，不是报表。
// ─────────────────────────────────────────────────────────────
/** CEX 市价单（taker）费率（bps）。执行路径是市价成交，用 maker 费率会系统性低估成本。 */
export let CEX_TAKER_FEE_BPS = envNum('EV_CEX_TAKER_FEE_BPS', 5)
/** CEX 挂单（maker）费率（bps）。仅用于「改挂单能省多少」的对照显示，不参与成本裁决。 */
export let CEX_MAKER_FEE_BPS = envNum('EV_CEX_MAKER_FEE_BPS', 2)
/**
 * CEX 市价单预期**单腿**滑点（bps）。
 *
 * 为什么必须是显式参数、而不是由某个「深度值」推算：
 *   CEX 的成交代价来自订单簿逐档吃单，单个深度数字无法还原冲击曲线——
 *   拿它线性外推会得到「2 万美金砸出 40bps」这类荒谬结论（真实约 1~3bps），
 *   而荒谬的成本估计会把**所有**正常交易都判成不划算。
 *   所以成本闸门在此处明确拒绝推测：要么由本参数给出，要么这笔交易按「假设缺失」拒绝放行。
 *
 * 默认值与执行层 `DEFAULT_EXEC.slippageBps` 对齐（见 costModel.ts 的启动漂移自检）：
 *   回测里假定的成交代价，必须与实盘闸门用的是同一个数，
 *   否则「回测赚、实盘亏」的差额会以「假设不一致」的形式偷偷回来。
 */
export let CEX_EXPECTED_SLIPPAGE_BPS = envNum('EV_CEX_EXPECTED_SLIPPAGE_BPS', 3)
/** DEX 池 LP 费率（bps）：Uniswap V3 主流 0.3% 池 = 30bps。 */
export let DEX_LP_FEE_BPS = envNum('EV_DEX_LP_FEE_BPS', 30)
/** 永续资金费基准（bps / 8 小时）。按持仓时长摊算，方向一律取不利侧计入成本。 */
export let FUNDING_RATE_BPS_PER_8H = envNum('EV_FUNDING_RATE_BPS_PER_8H', 1)
/** DEX 单腿可接受价格冲击上限（bps）。超过说明池深不足，这笔交易结构上不可行。 */
export let DEX_MAX_PRICE_IMPACT_BPS = envNum('EV_DEX_MAX_PRICE_IMPACT_BPS', 100)
/**
 * 预期毛收益相对**往返总成本**的最小倍数。
 * 这是「成本硬约束」的核心：edge 只是成本的 1.5 倍时，任何估算误差都会把净收益翻负。
 * 要求 3 倍的含义是 —— 成本估算得错到 3 倍以上，这笔交易才会由赚转亏。
 */
export let MIN_EDGE_COST_MULTIPLE = envNum('EV_MIN_EDGE_COST_MULTIPLE', 3)
/**
 * 往返成本占名义本金的硬上限（bps）。超过说明单笔太小、固定成本摊不开。
 *
 * ⚠️ 这个默认值有一条**必须成立的下界约束**：它必须大于 DEX 的往返 LP 费率
 * （`DEX_LP_FEE_BPS × 2` = 60bps）。否则 DEX 通道会在**默认参数下被结构性关闭**——
 * 任何 DEX 交易的成本占比天然就 ≥60bps，闸门会以「成本占比过高」拒绝全部交易，
 * 而错误信息看起来像是「这一笔太贵了」，真因却是两个默认值互斥。
 * 这类缺陷不报错、不崩溃，只是让整条通道静默不可用（见 costModel.ts 的启动自检）。
 */
export let MAX_COST_SHARE_BPS = envNum('EV_MAX_COST_SHARE_BPS', 120)
/** 最小可行名义本金（USDT）。与滑点无关，由固定成本（gas / 跨链桥费）决定。 */
export let MIN_VIABLE_NOTIONAL_USDT = envNum('EV_MIN_VIABLE_NOTIONAL_USDT', 200)
/** 实盘动作触发人工审批的金额门槛（USDT）。结构性动作不受此门槛保护，见 approvalGate。 */
export let APPROVAL_THRESHOLD_USDT = envNum('EV_APPROVAL_THRESHOLD_USDT', 5_000)
/** 审批请求有效期（分钟）。过期即失效且不得补批 —— 陈旧审批比没有审批更危险。 */
export let APPROVAL_TTL_MINUTES = envInt('EV_APPROVAL_TTL_MINUTES', 30)
/** 对手方声誉分下限（0~1）。低于该值禁止新开敞口。「无样本」不属于低分，另行处置。 */
export let COUNTERPARTY_MIN_REPUTATION = envNum('EV_COUNTERPARTY_MIN_REPUTATION', 0.6)
/** 无历史样本的对手方允许的敞口倍数（0.5 = 半仓试探）。刻意不是 1，也不是 0。 */
export let UNPROVEN_SIZE_MULTIPLIER = envNum('EV_UNPROVEN_SIZE_MULTIPLIER', 0.5)
/** 结算对账容差（bps）。超出即判金额漂移，不得静默抹平。 */
export let SETTLEMENT_TOLERANCE_BPS = envNum('EV_SETTLEMENT_TOLERANCE_BPS', 5)
/** 结算义务「长期未结」判定（小时）。超时即告警，不自动作废 —— 未结不等于不存在。 */
export let SETTLEMENT_STALE_HOURS = envNum('EV_SETTLEMENT_STALE_HOURS', 24)

// ─────────────────────────────────────────────────────────────
// 组 8 · 微资金以小博大（杠杆 + 强平几何）
//
// 为什么这一组必须与组 3（止损几何）**联立**、不能各自独立调：
//   杠杆与止损距离是同一个约束的两面。125 倍的强平距离约 1/125 = 0.8%，
//   而组 3 的止损垫下限是 1.8% —— 止损**永远碰不到**，价格走到 0.8% 就已被强平。
//   那时止损单还在簿上，账户已经没了。这不是"风险更大"，是**风控失效**：
//   你以为在按 1R 止损，实际止损从未执行过。
//
// 所以本组的每个参数都不是"阈值"，而是**几何约束**：
//   有效杠杆由止损距离反推（见 positionGuard.maxSafeLeverage），而不是自由选取。
//   用户要的"最高 125 倍"是**天花板**，真正用几倍取决于这一笔的止损有多宽。
// ─────────────────────────────────────────────────────────────
/**
 * 杠杆硬天花板（倍）。**不可被 env 抬高**，代码内只读。
 *
 * 为什么硬编码在代码而不是放进 `DEFAULTS`：它是一条**安全边界**，不是可调参数。
 * `EV_MAX_LEVERAGE` 若被配成任意大（例如误填 1250，多一个 0），
 * 在「杠杆放大收益」的直觉下不会有人觉得异常，直到一次插针把账户清零。
 * 任何超过本值的配置都会被**钳到本值并告警**，而不是照做。
 */
export const LEVERAGE_HARD_CEILING = 125
/**
 * 现货（含杠杆现货）可用的杠杆上限（倍），代码内只读。
 *
 * 存在的理由：`leverage=125` 与 `instType='SPOT'` **各自都合法，组合起来非法**。
 * 这类"参数配伍"错误不会在本地报错，只会被场所用一个间接理由拒掉
 * （通常是「保证金不足」），把排查方向引到余额上，而真因是选错了品种形态。
 * 所以必须在出站之前显式断言：高于本值的杠杆只能走 SWAP。
 */
export const SPOT_MAX_LEVERAGE = 10
/** 交易所维持保证金率。OKX 主流合约档位约 0.5%；计入强平距离。 */
export let LIQUIDATION_MAINT_MARGIN_PCT = envNum('EV_LIQUIDATION_MAINT_MARGIN_PCT', 0.005)
/**
 * 强平安全倍数：强平距离必须 ≥ 止损距离 × 本值。
 * 取 1.5 的含义 —— 止损被打掉之后，账户还剩至少 50% 的缓冲才轮到强平。
 * 这个缓冲不是保守，是**给滑点与插针留的物理空间**：
 * 极端行情里价格会跳过止损价直接成交，缓冲为零时"止损"只是心理安慰。
 */
export let LIQUIDATION_SAFETY_MULT = envNum('EV_LIQUIDATION_SAFETY_MULT', 1.5)
/** 强平距离计算中扣减的费率+滑点缓冲（bps，单边）。杠杆越高，这一项占比越大。 */
export let LIQUIDATION_FEE_BUFFER_BPS = envNum('EV_LIQUIDATION_FEE_BUFFER_BPS', 20)
/**
 * 微资金模式开关。1 = 允许「小保证金 + 杠杆」放大名义本金以跨过成本可行性地板。
 * 0 = 退回旧行为（名义本金只能由保证金 1:1 提供）。
 */
export let ALLOW_MICRO_CAPITAL = envInt('EV_ALLOW_MICRO_CAPITAL', 1)
/** 单笔最小保证金（USDT）。用户起步档位 1~10~100U 的下界；低于此值保证金档位无意义。 */
export let MIN_MARGIN_USDT = envNum('EV_MIN_MARGIN_USDT', 1)
/**
 * CEX 通道最小可行名义本金（USDT）。
 *
 * ⚠️ 与组 7 的 `MIN_VIABLE_NOTIONAL_USDT` 是**两个不同的事实**，不可合并：
 *   组 7 那个地板是**固定成本**决定的 —— 链上 gas、跨链桥费，它们不随金额等比缩小。
 *   但 CEX 合约**没有 gas、没有跨链桥**，它的成本是纯比例项（taker 费率 + 滑点 bps）。
 *   把 gas 地板套到 CEX 上，是一个**类别错误**：会让「$100 名义本金」这种
 *   在 CEX 上完全正常的小额单被判 `NOTIONAL_TOO_SMALL` 而永远无法成交。
 *   本参数就是把这个事实分开表达。
 */
export let MIN_VIABLE_NOTIONAL_CEX_USDT = envNum('EV_MIN_VIABLE_NOTIONAL_CEX_USDT', 10)

// ─────────────────────────────────────────────────────────────
// 默认值表（供风控管理中心 schema 引用；键 = 环境变量名）
// ⚠️ 必须是字面量，不得引用上面已解析的常量（见文件头纪律第 2 条）
// ─────────────────────────────────────────────────────────────
export const DEFAULTS = {
  EV_MAX_CONCURRENT_POSITIONS: 0,
  EV_MAX_SAME_DIRECTION_POSITIONS: 2,
  EV_MAX_MARGIN_EQUITY_RATIO: 0.2,
  EV_SINGLE_ASSET_EQUITY_RATIO: 0.35,
  EV_MIN_LEVERAGE: 1,
  EV_MAX_LEVERAGE: 3,
  EV_RISK_PER_TRADE_RATIO: 0.01,
  EV_MIN_RISK_REWARD: 2.0,
  EV_MIN_ENTRY_CONFIDENCE: 70,
  EV_ATR_PERIOD: 14,
  EV_ATR_STOP_MULT_MIN: 1.8,
  EV_ATR_STOP_MULT_MAX: 2.2,
  EV_STOP_SAFETY_PCT_MIN: 0.018,
  EV_STOP_SAFETY_PCT_MAX: 0.03,
  EV_BREAKEVEN_TRIGGER_R: 0.8,
  EV_BREAKEVEN_BUFFER_PCT: 0.001,
  EV_PROFIT_LOCK_TRIGGER_R: 1.5,
  EV_PROFIT_LOCK_ATR_MULT: 1.0,
  EV_TRAIL_ACTIVATE_R: 2.2,
  EV_TIME_STOP_HOURS: 8,
  EV_TIME_STOP_ATR_BAND: 0.15,
  EV_STOP_COOLDOWN_MINUTES: 30,
  EV_MAX_DAILY_LOSS_USDC: 0,
  EV_DAILY_LOSS_EQUITY_RATIO: 0.05,
  EV_MAX_SCALE_IN_COUNT: 1,
  EV_MIN_SCALE_IN_PROFIT_RATIO: 0.008,
  EV_MIN_SCALE_IN_CONFIDENCE: 75,
  EV_MAX_NOTIONAL_PER_ORDER: 50_000,
  EV_PRICE_DEVIATION_BPS: 300,
  EV_MAX_ORDERS_PER_MINUTE: 30,
  EV_MAX_DRAWDOWN_PCT: 20,
  // 组 7 · 成本硬约束与可信执行
  EV_CEX_TAKER_FEE_BPS: 5,
  EV_CEX_MAKER_FEE_BPS: 2,
  EV_CEX_EXPECTED_SLIPPAGE_BPS: 3,
  EV_DEX_LP_FEE_BPS: 30,
  EV_FUNDING_RATE_BPS_PER_8H: 1,
  EV_DEX_MAX_PRICE_IMPACT_BPS: 100,
  EV_MIN_EDGE_COST_MULTIPLE: 3,
  EV_MAX_COST_SHARE_BPS: 120,
  EV_MIN_VIABLE_NOTIONAL_USDT: 200,
  EV_APPROVAL_THRESHOLD_USDT: 5_000,
  EV_APPROVAL_TTL_MINUTES: 30,
  EV_COUNTERPARTY_MIN_REPUTATION: 0.6,
  EV_UNPROVEN_SIZE_MULTIPLIER: 0.5,
  EV_SETTLEMENT_TOLERANCE_BPS: 5,
  EV_SETTLEMENT_STALE_HOURS: 24,
  // 组 8 · 微资金以小博大（注意：LEVERAGE_HARD_CEILING 不在本表，它是代码内安全边界）
  EV_LIQUIDATION_MAINT_MARGIN_PCT: 0.005,
  EV_LIQUIDATION_SAFETY_MULT: 1.5,
  EV_LIQUIDATION_FEE_BUFFER_BPS: 20,
  EV_ALLOW_MICRO_CAPITAL: 1,
  EV_MIN_MARGIN_USDT: 1,
  EV_MIN_VIABLE_NOTIONAL_CEX_USDT: 10,
} as const

export type RiskEnvKey = keyof typeof DEFAULTS

export const RISK_ENV_KEYS = Object.keys(DEFAULTS) as RiskEnvKey[]

/** 当前生效值（原生单位）：读进程环境变量，缺省回退默认值。供 UI 回显与变更留痕。 */
export function currentRiskValues(): Record<RiskEnvKey, number> {
  const out = {} as Record<RiskEnvKey, number>
  for (const key of RISK_ENV_KEYS) {
    const raw = process.env[key]
    const fallback = DEFAULTS[key]
    if (raw === undefined || raw === '') {
      out[key] = fallback
      continue
    }
    const n = Number(raw)
    out[key] = Number.isFinite(n) ? n : fallback
  }
  return out
}

/**
 * 单笔 1R 风险额（绝对金额）。同时受「权益比例」与「单标的保证金封顶」约束，取小。
 * 这是把仓位规模与止损宽度解耦的入口：止损越宽，可下数量越小，风险额恒定。
 */
export function riskBudgetPerTrade(equity: number): number {
  const byRatio = Math.max(equity, 0) * RISK_PER_TRADE_RATIO
  const cap = Math.max(equity, 0) * SINGLE_ASSET_EQUITY_RATIO
  return Math.max(Math.min(byRatio, cap), 0)
}

/** 当日亏损熔断阈值：绝对封顶与比例取小（封顶为 0 时只看比例）。 */
export function dailyLossLimit(equity: number): number {
  const byRatio = Math.max(equity, 0) * DAILY_LOSS_EQUITY_RATIO
  if (MAX_DAILY_LOSS_USDC <= 0) return byRatio
  return Math.min(MAX_DAILY_LOSS_USDC, byRatio)
}

/** 并发持仓上限：0 = 跟随池容量；同向上限再钳制不超过总上限。 */
export function effectiveMaxPositions(poolSize: number): { total: number; same: number } {
  const pool = Math.max(Math.trunc(poolSize) || 0, 1)
  const configured = MAX_CONCURRENT_POSITIONS
  const total = configured <= 0 ? pool : Math.max(1, Math.min(configured, pool))
  const same = Math.max(1, Math.min(MAX_SAME_DIRECTION_POSITIONS, total))
  return { total, same }
}

// ─────────────────────────────────────────────────────────────
// 运行时热重载
// ─────────────────────────────────────────────────────────────

/**
 * 重新从环境变量解析全部风控常量。
 *
 * 为什么这些常量声明为 `let` 而不是 `const`：
 *   它们的值来自 `process.env`，在模块 **import 时**求值一次。风控管理页改完 .env 后，
 *   如果不重新求值，就会出现本项目最忌讳的一类故障——**面板显示新值、引擎仍按旧值执行**。
 *   改写 32 处调用点为 getter 是另一种解法，但那会把风险散布到全仓库；
 *   改成 ESM 的 `let` 绑定后，导入方看到的是**活的绑定**，
 *   调用点一行不用动就能拿到新值，改动面收敛在这一个文件内。
 *
 * 调用时机：`POST /risk/env` 落盘成功后立即调用（见 server/index.ts），
 * 保证「写盘 → 进程内生效」两步不出现窗口期。
 */
export function reloadRiskConstants(): Record<string, number> {
  MAX_CONCURRENT_POSITIONS = envInt('EV_MAX_CONCURRENT_POSITIONS', DEFAULTS.EV_MAX_CONCURRENT_POSITIONS)
  MAX_SAME_DIRECTION_POSITIONS = envInt('EV_MAX_SAME_DIRECTION_POSITIONS', DEFAULTS.EV_MAX_SAME_DIRECTION_POSITIONS)
  MAX_MARGIN_EQUITY_RATIO = envNum('EV_MAX_MARGIN_EQUITY_RATIO', DEFAULTS.EV_MAX_MARGIN_EQUITY_RATIO)
  SINGLE_ASSET_EQUITY_RATIO = envNum('EV_SINGLE_ASSET_EQUITY_RATIO', DEFAULTS.EV_SINGLE_ASSET_EQUITY_RATIO)
  MIN_LEVERAGE = envNum('EV_MIN_LEVERAGE', DEFAULTS.EV_MIN_LEVERAGE)
  MAX_LEVERAGE = envNum('EV_MAX_LEVERAGE', DEFAULTS.EV_MAX_LEVERAGE)
  // 交叉守卫必须在两个杠杆值都刷新之后重算，否则会留下「下限 > 上限」的中间态
  EFFECTIVE_MIN_LEVERAGE = Math.min(MIN_LEVERAGE, MAX_LEVERAGE)

  RISK_PER_TRADE_RATIO = envNum('EV_RISK_PER_TRADE_RATIO', DEFAULTS.EV_RISK_PER_TRADE_RATIO)
  MIN_RISK_REWARD_RATIO = envNum('EV_MIN_RISK_REWARD', DEFAULTS.EV_MIN_RISK_REWARD)
  MIN_ENTRY_CONFIDENCE = envNum('EV_MIN_ENTRY_CONFIDENCE', DEFAULTS.EV_MIN_ENTRY_CONFIDENCE)

  ATR_PERIOD = envInt('EV_ATR_PERIOD', DEFAULTS.EV_ATR_PERIOD)
  ATR_STOP_MULT_MIN = envNum('EV_ATR_STOP_MULT_MIN', DEFAULTS.EV_ATR_STOP_MULT_MIN)
  ATR_STOP_MULT_MAX = envNum('EV_ATR_STOP_MULT_MAX', DEFAULTS.EV_ATR_STOP_MULT_MAX)
  STOP_SAFETY_PCT_MIN = envNum('EV_STOP_SAFETY_PCT_MIN', DEFAULTS.EV_STOP_SAFETY_PCT_MIN)
  STOP_SAFETY_PCT_MAX = envNum('EV_STOP_SAFETY_PCT_MAX', DEFAULTS.EV_STOP_SAFETY_PCT_MAX)
  BREAKEVEN_TRIGGER_R = envNum('EV_BREAKEVEN_TRIGGER_R', DEFAULTS.EV_BREAKEVEN_TRIGGER_R)
  BREAKEVEN_BUFFER_PCT = envNum('EV_BREAKEVEN_BUFFER_PCT', DEFAULTS.EV_BREAKEVEN_BUFFER_PCT)
  PROFIT_LOCK_TRIGGER_R = envNum('EV_PROFIT_LOCK_TRIGGER_R', DEFAULTS.EV_PROFIT_LOCK_TRIGGER_R)
  PROFIT_LOCK_ATR_MULT = envNum('EV_PROFIT_LOCK_ATR_MULT', DEFAULTS.EV_PROFIT_LOCK_ATR_MULT)
  TRAIL_ACTIVATE_R = envNum('EV_TRAIL_ACTIVATE_R', DEFAULTS.EV_TRAIL_ACTIVATE_R)

  TIME_STOP_HOURS = envNum('EV_TIME_STOP_HOURS', DEFAULTS.EV_TIME_STOP_HOURS)
  TIME_STOP_ATR_BAND = envNum('EV_TIME_STOP_ATR_BAND', DEFAULTS.EV_TIME_STOP_ATR_BAND)
  STOP_COOLDOWN_MINUTES = envInt('EV_STOP_COOLDOWN_MINUTES', DEFAULTS.EV_STOP_COOLDOWN_MINUTES)
  MAX_DAILY_LOSS_USDC = envNum('EV_MAX_DAILY_LOSS_USDC', DEFAULTS.EV_MAX_DAILY_LOSS_USDC)
  DAILY_LOSS_EQUITY_RATIO = envNum('EV_DAILY_LOSS_EQUITY_RATIO', DEFAULTS.EV_DAILY_LOSS_EQUITY_RATIO)

  MAX_SCALE_IN_COUNT = envInt('EV_MAX_SCALE_IN_COUNT', DEFAULTS.EV_MAX_SCALE_IN_COUNT)
  MIN_SCALE_IN_PROFIT_RATIO = envNum('EV_MIN_SCALE_IN_PROFIT_RATIO', DEFAULTS.EV_MIN_SCALE_IN_PROFIT_RATIO)
  MIN_SCALE_IN_CONFIDENCE = envNum('EV_MIN_SCALE_IN_CONFIDENCE', DEFAULTS.EV_MIN_SCALE_IN_CONFIDENCE)

  MAX_NOTIONAL_PER_ORDER = envNum('EV_MAX_NOTIONAL_PER_ORDER', DEFAULTS.EV_MAX_NOTIONAL_PER_ORDER)
  PRICE_DEVIATION_BPS = envNum('EV_PRICE_DEVIATION_BPS', DEFAULTS.EV_PRICE_DEVIATION_BPS)
  MAX_ORDERS_PER_MINUTE = envInt('EV_MAX_ORDERS_PER_MINUTE', DEFAULTS.EV_MAX_ORDERS_PER_MINUTE)
  MAX_DRAWDOWN_PCT = envNum('EV_MAX_DRAWDOWN_PCT', DEFAULTS.EV_MAX_DRAWDOWN_PCT)

  CEX_TAKER_FEE_BPS = envNum('EV_CEX_TAKER_FEE_BPS', DEFAULTS.EV_CEX_TAKER_FEE_BPS)
  CEX_MAKER_FEE_BPS = envNum('EV_CEX_MAKER_FEE_BPS', DEFAULTS.EV_CEX_MAKER_FEE_BPS)
  CEX_EXPECTED_SLIPPAGE_BPS = envNum('EV_CEX_EXPECTED_SLIPPAGE_BPS', DEFAULTS.EV_CEX_EXPECTED_SLIPPAGE_BPS)
  DEX_LP_FEE_BPS = envNum('EV_DEX_LP_FEE_BPS', DEFAULTS.EV_DEX_LP_FEE_BPS)
  FUNDING_RATE_BPS_PER_8H = envNum('EV_FUNDING_RATE_BPS_PER_8H', DEFAULTS.EV_FUNDING_RATE_BPS_PER_8H)
  DEX_MAX_PRICE_IMPACT_BPS = envNum('EV_DEX_MAX_PRICE_IMPACT_BPS', DEFAULTS.EV_DEX_MAX_PRICE_IMPACT_BPS)
  MIN_EDGE_COST_MULTIPLE = envNum('EV_MIN_EDGE_COST_MULTIPLE', DEFAULTS.EV_MIN_EDGE_COST_MULTIPLE)
  MAX_COST_SHARE_BPS = envNum('EV_MAX_COST_SHARE_BPS', DEFAULTS.EV_MAX_COST_SHARE_BPS)
  MIN_VIABLE_NOTIONAL_USDT = envNum('EV_MIN_VIABLE_NOTIONAL_USDT', DEFAULTS.EV_MIN_VIABLE_NOTIONAL_USDT)
  APPROVAL_THRESHOLD_USDT = envNum('EV_APPROVAL_THRESHOLD_USDT', DEFAULTS.EV_APPROVAL_THRESHOLD_USDT)
  APPROVAL_TTL_MINUTES = envInt('EV_APPROVAL_TTL_MINUTES', DEFAULTS.EV_APPROVAL_TTL_MINUTES)
  COUNTERPARTY_MIN_REPUTATION = envNum('EV_COUNTERPARTY_MIN_REPUTATION', DEFAULTS.EV_COUNTERPARTY_MIN_REPUTATION)
  UNPROVEN_SIZE_MULTIPLIER = envNum('EV_UNPROVEN_SIZE_MULTIPLIER', DEFAULTS.EV_UNPROVEN_SIZE_MULTIPLIER)
  SETTLEMENT_TOLERANCE_BPS = envNum('EV_SETTLEMENT_TOLERANCE_BPS', DEFAULTS.EV_SETTLEMENT_TOLERANCE_BPS)
  SETTLEMENT_STALE_HOURS = envNum('EV_SETTLEMENT_STALE_HOURS', DEFAULTS.EV_SETTLEMENT_STALE_HOURS)

  LIQUIDATION_MAINT_MARGIN_PCT = envNum('EV_LIQUIDATION_MAINT_MARGIN_PCT', DEFAULTS.EV_LIQUIDATION_MAINT_MARGIN_PCT)
  LIQUIDATION_SAFETY_MULT = envNum('EV_LIQUIDATION_SAFETY_MULT', DEFAULTS.EV_LIQUIDATION_SAFETY_MULT)
  LIQUIDATION_FEE_BUFFER_BPS = envNum('EV_LIQUIDATION_FEE_BUFFER_BPS', DEFAULTS.EV_LIQUIDATION_FEE_BUFFER_BPS)
  ALLOW_MICRO_CAPITAL = envInt('EV_ALLOW_MICRO_CAPITAL', DEFAULTS.EV_ALLOW_MICRO_CAPITAL)
  MIN_MARGIN_USDT = envNum('EV_MIN_MARGIN_USDT', DEFAULTS.EV_MIN_MARGIN_USDT)
  MIN_VIABLE_NOTIONAL_CEX_USDT = envNum('EV_MIN_VIABLE_NOTIONAL_CEX_USDT', DEFAULTS.EV_MIN_VIABLE_NOTIONAL_CEX_USDT)
  // 杠杆天花板是硬边界，不被 env 抬高；越界只告警不照做
  MAX_LEVERAGE = clampLeverageCeiling(MAX_LEVERAGE)

  return currentRiskValues()
}

/**
 * 把杠杆上限钳到 `LEVERAGE_HARD_CEILING`。
 *
 * 刻意「静默钳制 + 告警」而不是抛异常：杠杆上限可能被风控面板写入 .env，
 * 抛异常会让整个进程起不来（连面板都打不开，用户没法把值改回来），
 * 而**照做**则是把一次误填放大成真实爆仓。钳制是唯一既安全又可恢复的处置。
 */
function clampLeverageCeiling(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  if (v > LEVERAGE_HARD_CEILING) {
    console.warn(
      `⚠️ EV_MAX_LEVERAGE=${v} 超过硬天花板 ${LEVERAGE_HARD_CEILING}，已钳制。` +
        '该天花板是代码内安全边界，不可通过配置抬高。',
    )
    return LEVERAGE_HARD_CEILING
  }
  return v
}

// 模块加载时立即对初始值做一次同样的钳制（reload 之外的首次 import 路径）
MAX_LEVERAGE = clampLeverageCeiling(MAX_LEVERAGE)

/**
 * 组 8 跨参数不变量：CEX 可行性地板不得高于 DEX 地板。
 *
 * 理由是一条事实而非风格：DEX 有 gas / 跨链桥固定成本，CEX 没有。
 * 若 CEX 地板反而更高，说明两个数字中至少有一个写错了位置，
 * 而症状会是「CEX 通道静默变窄或静默变宽」——不报错、只是成交变少或变多。
 * 与组 7 的 `MAX_COST_SHARE_BPS > DEX_LP_FEE_BPS×2` 同类：宁可启动失败，不要静默漂移。
 */
export function assertMicroCapitalInvariants(): void {
  if (MIN_VIABLE_NOTIONAL_CEX_USDT > MIN_VIABLE_NOTIONAL_USDT) {
    throw new Error(
      `成本地板口径矛盾：CEX 地板 ${MIN_VIABLE_NOTIONAL_CEX_USDT} USDT > DEX 地板 ${MIN_VIABLE_NOTIONAL_USDT} USDT。` +
        'CEX 无 gas / 跨链桥固定成本，其可行性地板不可能高于 DEX。请检查 EV_MIN_VIABLE_NOTIONAL_CEX_USDT。',
    )
  }
  if (LIQUIDATION_SAFETY_MULT < 1) {
    throw new Error(
      `强平安全倍数 ${LIQUIDATION_SAFETY_MULT} < 1：止损与强平之间不留缓冲，` +
        '极端行情下止损会被跳过、强平先执行。请检查 EV_LIQUIDATION_SAFETY_MULT。',
    )
  }
}

assertMicroCapitalInvariants()
