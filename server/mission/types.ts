/**
 * 任务层（Mission）—— 共享契约
 *
 * ── 这一层为什么必须存在 ──────────────────────────────────────────────
 * 在它之前，系统的入口只有**命令**：下单、平仓、暂停、查权益。
 * `startAutopilot(targetPct)` 已经是目标驱动，但它接的是一个**数字**，
 * 而不是人嘴里的一句话。于是「10U 做到 100U，一天内，可以用高倍杠杆」
 * 这句话在系统里根本没有落点 —— 它既不是下单命令，也不是一个百分比，
 * 只能被丢进「听不懂」。
 *
 * 补上这一层，是为了让「一个目标」先被**裁定**，再被**执行**。
 * 顺序不能反：如果先执行再发现目标不成立，用户看到的是一台
 * 看起来很忙、实际上一步也走不动的机器，而所有日志都写着「正常」。
 *
 * ── 三个硬约束（违反其一就不算完成任务层）──────────────────────────
 * ① **裁定必须用系统自己的尺子，不能另立一套。**
 *    目标能不能达成，要用 1R 风险预算、当日亏损熔断、止损几何、
 *    成本地板、过拟合门这些**已经在跑**的约束去量。
 *    另立一套「目标合理性评估」等于造了第二份口径，两份迟早分岔。
 *
 * ② **缺槽位就说缺，不用默认值补。**
 *    语音里缺省就是猜，而猜错的代价是真实资金。
 *    所以 `MissionSpec.missing` 是**显式字段**：没说截止时间就是没说，
 *    不允许用「默认 24 小时」把它填平 —— 那会让用户以为自己说了。
 *
 * ③ **不可行要给出数，不能只给结论。**
 *    「做不到」是可被反驳的判断；「需要 119 笔盈利、只剩 5 笔亏损额度」
 *    是可被核对的事实。后者才是这一层交付的东西。
 */

/** 执行形态。刻意与 `voice/types.ts` 的 live 布尔量分开：这里是三态，不是两态。 */
export type MissionExecution =
  /** 本地记账，不连任何场所。 */
  | 'paper'
  /** 场所的模拟盘（OKX 模拟交易、测试网）。有真实撮合语义，零真实资金。 */
  | 'testnet'
  /** 真实资金。 */
  | 'live'

/**
 * 场所标识。
 *
 * 取值必须与 `server/venue/*.ts` 里各适配器的 `readonly name` **逐字一致** ——
 * 这是本层唯一一处「字符串即契约」的地方，所以要有断言钉住（见 mission-smoke）。
 */
export type MissionVenue = 'sandbox' | 'cex-testnet' | 'okx-testnet'

/** 一句话里必须凑齐的槽位。缺任意一个都不得进入执行。 */
export type MissionSlot = 'venue' | 'startNotional' | 'targetNotional' | 'deadline' | 'symbol'

export interface MissionSpec {
  /** 用户原话。留档用，且是内容寻址身份的一部分。 */
  raw: string
  venue: MissionVenue | null
  execution: MissionExecution
  symbol: string | null
  /** 起始权益/本金（计价币）。 */
  startNotional: number | null
  /** 目标权益/本金。 */
  targetNotional: number | null
  /** 目标倍数 = target / start。由两者推出，**不允许用户直接指定**（两个来源必分岔）。 */
  targetMultiple: number | null
  /**
   * 截止时长（毫秒）。
   *
   * 刻意是**时长**而不是绝对时间戳：语音里说「一天内」是相对于
   * "任务被接到的那一刻"，落成时间戳就需要一个"现在"，而那个"现在"
   * 在解析时、确认时、执行时是三处不同的值。任务被拖了两小时才确认时，
   * 时间戳口径会静默缩短或延长任务的窗口。
   */
  deadlineMs: number | null
  /** 用户是否说了「可以用高倍杠杆」。 */
  allowHighLeverage: boolean
  /** 用户明说的杠杆倍数（如「125 倍」）。没说为 null —— 不替用户选。 */
  explicitLeverage: number | null
  /** 缺哪些槽位。**显式列出**，绝不用默认值补齐（见文件头②）。 */
  missing: MissionSlot[]
  /** 解析置信度 0~1。低置信度由上层转澄清，不猜。 */
  confidence: number
  /** 命中的原始片段，便于面板回答「你是从哪句里听出来的」。 */
  matched: string[]
}

export type MissionVerdict =
  | 'feasible'
  /** 有硬矛盾，做不成。理由里必须有可核对的数。 */
  | 'infeasible'
  /** **缺证据 ≠ 不可行**：样本/配置/门禁结论不足时一律这里，fail-closed。 */
  | 'unverifiable'

/**
 * 理由的严重程度。**四档，不是三档。**
 *
 * `hold` 是这一层能不能成立的关键：它表示「我不知道」，而 `block` 表示「不行」。
 * 两者一旦合成一档，`unverifiable` 就成了一条**永远走不到的分支** ——
 * 因为"缺槽位"本身就必然带一条理由，那条理由若是 block，
 * 判定就永远落在 `infeasible` 上。
 *
 * 这正是本项目最高频的那类 P0，只是失效方向相反：
 * 它不是"不可能失败的检查"，而是**不可能被命中的状态** ——
 * 类型里有这个取值、文档里有这段说明、接口上一切正常，
 * 而它永远不会发生。所以三态的**可实现性**必须由档位保证，并由烟测钉住。
 */
export type MissionReasonSeverity =
  /** 硬矛盾，做不成。理由必须带可核对的数。 */
  | 'block'
  /** **证据不足**：不是"不行"，是"还不知道"。补齐前置条件后可以重来。 */
  | 'hold'
  | 'warn'
  | 'info'

export interface MissionReason {
  /** 机器可判的稳定标识（`TARGET_ABOVE_AUTOPILOT_RANGE` 等）。文案改它不变。 */
  code: string
  severity: MissionReasonSeverity
  /** 面向人的中文说明。**不允许**放原始英文异常。 */
  text: string
  /** 支撑这条结论的数。可复算，是"可被反驳"的载体。 */
  numbers?: Record<string, number | string | null>
}

/** 目标达成所需的交易量级 —— 由 1R、盈亏比、当日亏损熔断三者解出。 */
export interface RequiredTrades {
  /** 单笔盈利对权益的增幅（0.02 = +2%）。 */
  winPct: number
  /** 单笔亏损对权益的减幅（0.01 = -1%）。 */
  lossPct: number
  /** 一天允许的亏损笔数（= 当日亏损熔断线 ÷ 1R）。 */
  maxLosses: number
  /** 用满亏损额度时，仍需要的**盈利笔数下界**。 */
  requiredWins: number
  /** 隐含胜率下界 = requiredWins / (requiredWins + maxLosses)。 */
  impliedWinRate: number
  /** 摊到截止窗口上，每小时至少要打出几笔盈利。 */
  winsPerHour: number
}

/** 第一笔仓位到底能不能开出来 —— 这是比「赚不赚得到」更早的一道坎。 */
export interface MissionSizing {
  /** 1R 风险额（绝对金额）。 */
  riskBudget: number
  /** 按风险预算反推的名义本金。 */
  notionalByRisk: number
  /** 按保证金上限反推的名义本金。 */
  notionalByMargin: number
  /** 三者取小后的拟做名义本金。 */
  plannedNotional: number
  /** 真正卡住规模的是哪一项。 */
  binding: string
  /** 场所/通道的最小可行名义本金。 */
  minViableNotional: number
  /** 让第一笔刚好能开到 `minViableNotional` 所需的最小权益；算不出为 null。 */
  minViableEquity: number | null
  /** 由止损距离反推出的安全杠杆上限。 */
  maxSafeLeverage: number
  /** 当前配置允许的杠杆上限（`EV_MAX_LEVERAGE`，已被硬天花板钳制）。 */
  configuredLeverage: number
}

export interface MissionAlternative {
  /** 系统能接受的最高目标（%）。 */
  targetPct: number
  /** 让第一笔能开出来所需的最小权益（USDT）；不需要为 null。 */
  minEquity: number | null
  /** 每条都是**能照着做**的动作，不是安慰话。 */
  notes: string[]
}

/**
 * 一份任务裁定书。
 *
 * ★ 它同时是**可引用资产**：`planId` 由内容寻址得出（见 `asset.ts`），
 * 于是「我说的就是那次 10U→100U 的评估」指向的对象不可被静默替换 ——
 * 这条内化自 AgentGit 的「一分支一会话，永不复用」。
 */
export interface MissionPlan {
  planId: string
  assessedAt: number
  spec: MissionSpec
  verdict: MissionVerdict
  targetMultiple: number | null
  targetPct: number | null
  required: RequiredTrades | null
  sizing: MissionSizing | null
  reasons: MissionReason[]
  /** 不可行时的替代方案。为 null 表示原目标本身没问题。 */
  alternative: MissionAlternative | null
}

/**
 * 裁定所依据的环境。
 *
 * ★ **一律可注入。**
 * 不是为了留后门，是为了让烟测能**分别**构造出「可行 / 不可行 / 证据不足」
 * 三条支路。一个无法被构造出拒绝场景的裁定器，和没有裁定器是一回事
 * （本项目已复现 7 次的 P0 类型）。
 */
export interface MissionEnv {
  /**
   * 编排层**实际挂载**的场所（`VENUE`）。
   *
   * 这是"订单真的去哪儿"的唯一答案 —— 网关适配器就是这么选的
   * （见 `server/index.ts` 的 `attachVenue`）。任务指定的场所与它不一致时，
   * 只能拒绝，不能改道（改道会让"在做 OKX 实测"这句话变成假的）。
   */
  wiredVenue: string
  /**
   * 成本口径用的场所名（`AUTOPILOT_VENUE`）。
   *
   * 与 `wiredVenue` **是两个不同的东西**，所以必须分开记录：
   * 成本模型的场所名决定用哪套费率/滑点假设，执行场所决定订单去哪。
   * 两者不一致时，成本闸门是在**为一个不是它实际交易的市场**算成本 ——
   * 这种偏差不报错、不崩溃，只会让每一笔的成本裁决都建立在错的假设上。
   */
  accountingVenue: string
  autopilotLive: boolean
  instType: 'SPOT' | 'SWAP'
  /** 当前权益。 */
  equity: number
  /**
   * 止损距离占价格的比例。
   *
   * 取**最紧的止损垫**（`EV_STOP_SAFETY_PCT_MIN`）来算所需本金下限，
   * 得到的是最乐观的那个数 —— 连最乐观的都不够，就真的不够。
   */
  stopPct: number
  riskPerTradeRatio: number
  minRiskReward: number
  dailyLossEquityRatio: number
  /** `startAutopilot` 接受的目标上限（%）。 */
  autoTargetMaxPct: number
  maxMarginEquityRatio: number
  minViableNotionalCex: number
  minMarginUsdt: number
  /**
   * 安全杠杆上限（**已被配置与硬天花板钳制后的实际值**）。
   *
   * 由 `positionGuard.maxSafeLeverage(stopPct)` 现算后注入，而不是在本层
   * 重写一遍公式 —— 那份公式是「止损必须先于强平」这条物理约束的载体，
   * 抄第二份就一定会在某次调参后与真身分岔。
   */
  maxSafeLeverage: number
  /** 几何允许的原始倍数（钳制**之前**）。用来区分「几何不允许」与「配置不给」。 */
  maxSafeLeverageRaw: number
  /** 当前配置的杠杆上限（`EV_MAX_LEVERAGE`）。 */
  maxLeverage: number
  /** 代码内硬天花板（不可被配置抬高）。 */
  leverageHardCeiling: number
  /** 过拟合门的最近结论。`null` = 还没跑过 → 证据不足，不放行。 */
  overfit: { outcome: string; pbo: number | null; maxPbo: number; passed: boolean } | null
}
