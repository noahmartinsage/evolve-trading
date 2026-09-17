/**
 * 本周期风险预算（内化 R20 `【本周期风险预算】` 提示词插值范式）
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────
 * 本项目的 LLM 提案器此前只知道「提出有区分度的变异」，完全看不到执行层
 * 当前生效的门槛。后果是双重的：
 *
 *   1. **有效自由度被浪费。** 模型按自己的先验猜一个置信度（例如 70），
 *      而执行层门禁是 80，报价被物理拦下——模型既不知道为什么被拒，
 *      也无法在下一轮修正。此前观测到的「提案被拦但理由看不见」即属此类。
 *   2. **口径分裂。** 风控管理页把 R:R 底线从 2.0 调到 2.5 之后，提示词里
 *      若还写着旧的 2.0，模型会持续产出必然被拒的报价，日志里表现为
 *      「模型很努力但成交为零」，而真因是提示词与代码两套口径。
 *
 * R20 的做法是每轮把执行层的**实时值**插值进提示词，并在措辞上明确
 * 「不满足将被执行层拒绝」——让模型在自己的决策空间里就能看到边界在哪。
 *
 * ── 实现约束 ────────────────────────────────────────────────────────
 * 必须读 `riskConstants.ts` 的**活绑定**（`let` + 热重载），而不是
 * `riskConfig.ts` 的 DEFAULTS 表。后者是给表单预填用的静态默认值，
 * 读它会得到「面板显示的值」而不是「引擎执行的值」——正是要消除的分裂。
 */
import {
  ATR_PERIOD,
  ATR_STOP_MULT_MAX,
  ATR_STOP_MULT_MIN,
  BREAKEVEN_BUFFER_PCT,
  BREAKEVEN_TRIGGER_R,
  EFFECTIVE_MIN_LEVERAGE,
  MAX_CONCURRENT_POSITIONS,
  MAX_DAILY_LOSS_USDC,
  MAX_LEVERAGE,
  MAX_SCALE_IN_COUNT,
  MAX_SAME_DIRECTION_POSITIONS,
  MIN_ENTRY_CONFIDENCE,
  MIN_RISK_REWARD_RATIO,
  MIN_SCALE_IN_CONFIDENCE,
  MIN_SCALE_IN_PROFIT_RATIO,
  PROFIT_LOCK_ATR_MULT,
  PROFIT_LOCK_TRIGGER_R,
  RISK_PER_TRADE_RATIO,
  STOP_COOLDOWN_MINUTES,
  STOP_SAFETY_PCT_MAX,
  STOP_SAFETY_PCT_MIN,
  TIME_STOP_ATR_BAND,
  TIME_STOP_HOURS,
  TRAIL_ACTIVATE_R,
  effectiveMaxPositions,
} from './riskConstants.ts'

/** 提示词插值块用的标题。放在用户消息里，形如 `【本周期风险预算】`。 */
export const RISK_BRIEF_HEADING = '【本周期风险预算】'

/**
 * 渲染本周期风险预算块。
 *
 * 措辞刻意包含三层信息，缺一不可：
 *   ① 当前值是多少（模型据此标定自己的输出）；
 *   ② 这是执行层硬约束（模型知道越界不会「尝试成功」，而是直接被拒）；
 *   ③ 已禁用的能力要显式说「不得申请」（否则模型仍会产出必然被拒的加仓申请）。
 */
export function renderRiskBrief(now = new Date(), poolSize = 0): string {
  const scaleInDisabled = MAX_SCALE_IN_COUNT <= 0
  const cooldownNote = STOP_COOLDOWN_MINUTES > 0 ? `${STOP_COOLDOWN_MINUTES} 分钟` : '已关闭'

  // 「0 = 自动跟随标的池容量」是引擎侧语义（见 riskConstants.effectiveMaxPositions）。
  // 直接把裸值渲染成「最大并发持仓：0 笔」会被模型读成「不许持仓」——
  // 一个把「自动」写成「禁止」的口径分裂，比不写还糟：模型会据此拒绝一切开仓机会。
  // 因此这里必须渲染**生效语义**，而不是配置值本身。
  const pos = effectiveMaxPositions(poolSize)
  const posLine =
    MAX_CONCURRENT_POSITIONS <= 0
      ? `· 最大并发持仓：自动跟随标的池容量（当前 ${pos.total} 笔，同向最多 ${pos.same} 笔）`
      : `· 最大并发持仓：${pos.total} 笔（同向最多 ${pos.same} 笔）`

  const lines: string[] = [
    RISK_BRIEF_HEADING,
    `（生成时刻 ${now.toISOString()}。以下为执行层当前**实时**硬约束，与引擎同一数据源；`,
    ' 任何不满足的报价会被物理拦截并降级为 WAIT，不会被「尝试执行」。请在此边界内做决策。）',
    '',
    posLine,
    `· 单笔风险额（1R）：可用权益的 ${(RISK_PER_TRADE_RATIO * 100).toFixed(2)}%`,
    `· 盈亏比硬底线：R:R ≥ ${MIN_RISK_REWARD_RATIO.toFixed(2)}（低于此值直接拒单，无例外）`,
    `· 开仓置信度门禁：≥ ${MIN_ENTRY_CONFIDENCE.toFixed(0)}%（含）`,
    `· 杠杆区间：${EFFECTIVE_MIN_LEVERAGE.toFixed(1)}x ~ ${MAX_LEVERAGE.toFixed(1)}x（超出会被钳制到区间内）`,
    `· 止损几何：结构失效点之外 ${ATR_STOP_MULT_MIN.toFixed(1)}x ~ ${ATR_STOP_MULT_MAX.toFixed(1)}x ${ATR_PERIOD} 周期 ATR，`,
    `  或现价外 ${(STOP_SAFETY_PCT_MIN * 100).toFixed(1)}% ~ ${(STOP_SAFETY_PCT_MAX * 100).toFixed(1)}% 安全垫（取更宽者）`,
    `· 保本移损：浮盈 ≥ ${BREAKEVEN_TRIGGER_R.toFixed(2)}R 时把止损拉至成本位 +${(BREAKEVEN_BUFFER_PCT * 100).toFixed(2)}%，切断本金风险`,
    `· 盈利保护：浮盈 ≥ ${PROFIT_LOCK_TRIGGER_R.toFixed(2)}R 后启用 ${PROFIT_LOCK_ATR_MULT.toFixed(2)}x ATR 追踪；`,
    `  浮盈 ≥ ${TRAIL_ACTIVATE_R.toFixed(2)}R 后止损只允许单向收紧，禁止放宽`,
    `· 时间止损：持仓超 ${TIME_STOP_HOURS.toFixed(1)} 小时且浮盈绝对值 < ${TIME_STOP_ATR_BAND.toFixed(2)}x ATR（横盘无突破）时退出`,
    `· 冷静期：止损被打掉后 ${cooldownNote} 内不得对该标的重新开仓`,
    `· 单日亏损上限：${MAX_DAILY_LOSS_USDC > 0 ? `${MAX_DAILY_LOSS_USDC} USDC` : '按权益比例约束'}，触发即停`,
  ]

  if (scaleInDisabled) {
    lines.push(
      `· 金字塔加仓：**本周期已禁用（上限 0 次）**。无论底仓浮盈多高，一律不得申请加仓，`,
      '  仅允许输出 HOLD / UPDATE_SL / CLOSE_MARKET。',
    )
  } else {
    lines.push(
      `· 金字塔加仓：最多 ${MAX_SCALE_IN_COUNT} 次，须同时满足——底仓浮盈 ≥ ${(MIN_SCALE_IN_PROFIT_RATIO * 100).toFixed(2)}%，`,
      `  已保本移损，置信度 ≥ ${MIN_SCALE_IN_CONFIDENCE.toFixed(0)}%，且加仓后单标的累计保证金不越上限。`,
      '  任一条件不满足时输出 WAIT，不要「试探性」提交。',
    )
  }

  return lines.join('\n')
}

/**
 * 结构化快照。给 API / 前端用——面板展示的口径必须与提示词一致，
 * 否则又会出现「提示词说一套、页面显示另一套」的新分裂。
 *
 * 刻意用显式接口而不是 `Record<string, number | boolean>`：
 * 联合类型会让每个消费方都得做类型收窄，而这里除了 `scaleInDisabled`
 * 之外全是数值。显式声明还顺带把「字段集合」变成可审查的契约——
 * 新增风控维度时漏加字段会直接编译失败，而不是静默少一个口径。
 */
export interface RiskBriefSnapshot {
  /** 配置值。0 表示「自动跟随标的池容量」，不是「禁止持仓」。 */
  maxConcurrentPositions: number
  /** 配置值是否为「自动」。UI 应据此显示「自动」而不是数字 0。 */
  maxConcurrentIsAuto: boolean
  /** 生效的总持仓上限（已把「自动」解析为标的池容量）。 */
  effectiveMaxPositions: number
  effectiveMaxSameDirection: number
  maxSameDirectionPositions: number
  riskPerTradeRatio: number
  minRiskRewardRatio: number
  minEntryConfidence: number
  effectiveMinLeverage: number
  maxLeverage: number
  atrPeriod: number
  atrStopMultMin: number
  atrStopMultMax: number
  stopSafetyPctMin: number
  stopSafetyPctMax: number
  breakevenTriggerR: number
  breakevenBufferPct: number
  profitLockTriggerR: number
  profitLockAtrMult: number
  trailActivateR: number
  timeStopHours: number
  timeStopAtrBand: number
  stopCooldownMinutes: number
  maxDailyLossUsdc: number
  maxScaleInCount: number
  minScaleInProfitRatio: number
  minScaleInConfidence: number
  scaleInDisabled: boolean
}

export function riskBriefSnapshot(poolSize = 0): RiskBriefSnapshot {
  const pos = effectiveMaxPositions(poolSize)
  return {
    maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
    maxConcurrentIsAuto: MAX_CONCURRENT_POSITIONS <= 0,
    effectiveMaxPositions: pos.total,
    effectiveMaxSameDirection: pos.same,
    maxSameDirectionPositions: MAX_SAME_DIRECTION_POSITIONS,
    riskPerTradeRatio: RISK_PER_TRADE_RATIO,
    minRiskRewardRatio: MIN_RISK_REWARD_RATIO,
    minEntryConfidence: MIN_ENTRY_CONFIDENCE,
    effectiveMinLeverage: EFFECTIVE_MIN_LEVERAGE,
    maxLeverage: MAX_LEVERAGE,
    atrPeriod: ATR_PERIOD,
    atrStopMultMin: ATR_STOP_MULT_MIN,
    atrStopMultMax: ATR_STOP_MULT_MAX,
    stopSafetyPctMin: STOP_SAFETY_PCT_MIN,
    stopSafetyPctMax: STOP_SAFETY_PCT_MAX,
    breakevenTriggerR: BREAKEVEN_TRIGGER_R,
    breakevenBufferPct: BREAKEVEN_BUFFER_PCT,
    profitLockTriggerR: PROFIT_LOCK_TRIGGER_R,
    profitLockAtrMult: PROFIT_LOCK_ATR_MULT,
    trailActivateR: TRAIL_ACTIVATE_R,
    timeStopHours: TIME_STOP_HOURS,
    timeStopAtrBand: TIME_STOP_ATR_BAND,
    stopCooldownMinutes: STOP_COOLDOWN_MINUTES,
    maxDailyLossUsdc: MAX_DAILY_LOSS_USDC,
    maxScaleInCount: MAX_SCALE_IN_COUNT,
    minScaleInProfitRatio: MIN_SCALE_IN_PROFIT_RATIO,
    minScaleInConfidence: MIN_SCALE_IN_CONFIDENCE,
    scaleInDisabled: MAX_SCALE_IN_COUNT <= 0,
  }
}
