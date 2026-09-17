/**
 * 语音层的**线上契约类型**（与服务端 `/voice/*` 一一对应）
 *
 * ── 为什么把它们从 `client.ts` 搬出来 ────────────────────────────────
 * `client.ts` 里有 React（hook、命令式合成器），于是任何想复用它类型的地方
 * 都得先把 React 拖进来。而 `speechPath.ts` 那套路径决策是纯逻辑，
 * 要被烟测直接导入断言 —— 它需要的只有 `NarrationPriority` 这一个联合类型。
 *
 * 若为了它把联合类型在两边各抄一遍，就又多了一处"看起来一样、改一处不会同步"
 * 的定义。这类漂移在本项目里出现的次数已经够多了：**类型也只允许有一份。**
 *
 * 所以：契约类型全部住在这里，`client.ts` 原样再导出（`export type * `），
 * 既有调用点的 `from './client.ts'` 一行都不用改。
 */

export type NarrationPriority = 'P0_ALARM' | 'P1_IMPORTANT' | 'P2_STATUS' | 'P3_MARKET'

export type NarrationCategory =
  | 'work-state'
  | 'next-step'
  | 'risk-alarm'
  | 'surveillance'
  | 'market-anomaly'
  | 'order'
  | 'gate'
  | 'daily-report'
  | 'chat'

export interface NarrationLine {
  id: string
  ts: number
  priority: NarrationPriority
  category: NarrationCategory
  text: string
  detail?: string
  /** 溯源：这条播报由账本第几号事件推出。面板显示它，「秘书不会撒谎」才是可核的。 */
  sourceSeq?: number
  sourceKind?: string
  dedupeKey: string
}

export type Verbosity = 'alarm-only' | 'normal' | 'chatty'
export type ConfirmPolicy = 'graded' | 'always'

/** 合成引擎：`neural` = 云端神经合成（拟人）；`local` = 浏览器/系统语音包（兜底）。 */
export type VoiceEngineKind = 'neural' | 'local'

export interface VoiceProfileView {
  id: string
  label: string
  gender: 'female' | 'male' | 'neutral'
  locale: string
  pitch: number
  rate: number
  tags: string[]
  /**
   * 浏览器音色名匹配候选（子串匹配），不是保证 —— 见服务端 voices.ts 文件头。
   * ★ 神经音色恒为空数组：它们由音色 id 直接寻址，不经操作系统语音包。
   */
  matchNames: string[]
  note: string
  /** 这一档由哪条引擎出声。面板据此分组，也据此决定要不要挂云端合成器。 */
  engine: VoiceEngineKind
  /** 神经音色专属：Edge 音色标识（`zh-CN-XiaoxiaoNeural` 这类）。本机音色为 undefined。 */
  neuralId?: string
}

export interface VoiceConfigView {
  enabled: boolean
  voiceId: string
  verbosity: Verbosity
  muted: boolean
  rate: number
  pitch: number
  confirmPolicy: ConfirmPolicy
  defaultLiveStrategyId: string | null
  autoNarrate: boolean
  catalog: VoiceProfileView[]
}

export interface OrderSlotsView {
  side: 'buy' | 'sell'
  symbol: string
  notional?: number
  qty?: number
  amountBasis?: 'notional' | 'qty'
  live?: boolean
  strategyId?: string
}

export interface PendingConfirmationView {
  token: string
  ts: number
  expiresAt: number
  intent: string
  /** 给人看的动作描述。**路由不认它**，只用于展示。 */
  action: string
  expectedAmount: number
  amountBasis: 'notional' | 'qty'
  expectedNotional: number
  slots: OrderSlotsView
  originTurnId: number
}

export type TurnState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'done' | 'failed'

export interface VoiceTurnView {
  turnId: number
  state: TurnState
  utterance: string
  reply: string
  intent?: string
  ts: number
  pending?: PendingConfirmationView
  reason?: string
}

export interface VoiceCountersView {
  emitted: number
  emittedByPriority: Record<NarrationPriority, number>
  suppressedByMute: number
  suppressedByVerbosity: number
  suppressedByDedupe: number
  suppressedByRate: number
  coalesced: number
  fromAnomaly: number
  queued: number
}

export interface VoiceStatusView {
  enabled: boolean
  voiceId: string
  verbosity: Verbosity
  turn: VoiceTurnView | null
  generation: number
  interruptedCount: number
  spokenCount: number
  suppressedCount: number
  pending: PendingConfirmationView | null
  recentNarrations: NarrationLine[]
  config: VoiceConfigView
  session: {
    generation: number
    turn: VoiceTurnView | null
    pending: PendingConfirmationView | null
    interruptedCount: number
    turnsStarted: number
    repliesCommitted: number
    droppedReplies: number
  }
  narrator: VoiceCountersView
  anomaly: { hits: number; lastBySymbol: Record<string, number> }
}

export interface VoiceExecutedView {
  ok: boolean
  reason?: string
  clientOrderId?: string
  orderId?: string
  status?: string
}

export interface VoiceReplyView {
  turnId: number
  /** true = 已被更晚的打断作废，前端**必须不念**。 */
  dropped: boolean
  intent: string
  intentLabel: string
  confidence: number
  reply: string
  detail?: string
  pending: PendingConfirmationView | null
  executed?: VoiceExecutedView
  narration: NarrationLine[]
}

export interface DailyBriefView {
  sinceTs: number
  /** true = 账本最早事件晚于今天零点，统计是从进程启动算起的 —— 面板必须如实标注。 */
  partialDay: boolean
  equity: number
  starting: number
  pnlPct: number
  positions: number
  fills: number
  rejects: number
  submits: number
  killswitch: boolean
  autopilotStage: string
  gateRefusalSummary: string | null
  surveillanceFlags: number
  reconciliation: 'consistent' | 'inconsistent' | 'unknown'
  riskUsage: { notionalCap: number; ordersPerMinuteCap: number; drawdownCapPct: number; currentDrawdownPct: number }
  topRejectReasons: { reason: string; count: number }[]
  narration: string
}

// ── 合成引擎视图（`GET /voice/engine`）──

export interface NeuralVoiceView {
  id: string
  label: string
  gender: 'female' | 'male'
  /** 该音色的本音语速。实测这是本引擎上唯一生效的风格旋钮，见服务端 tts.ts 实测表。 */
  rate: number
  tags: string[]
  note: string
}

export interface TtsStatsView {
  attempts: number
  ok: number
  failed: number
  lastError: string | null
  lastKind: string | null
  lastAt: number | null
  lastLatencyMs: number | null
}

export interface TtsEngineView {
  neural: {
    voices: NeuralVoiceView[]
    stats: TtsStatsView
    handshake: { host: string; secVersion: string; gecHead: string }
    /** 人话版的健康度结论。面板直接显示它，不要自己再拼一句话。 */
    note: string
  }
  local: { note: string }
  /** 音色 id → 走哪条引擎。面板与合成器**都读它**，不允许各自再推导一遍。 */
  engineOf: Record<string, VoiceEngineKind>
}
