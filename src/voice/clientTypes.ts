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

// ── 对话记录视图（`GET /voice/transcript`，Task #114）──
//
// ★ 这套类型是服务端 `server/voice/transcript.ts` 落盘格式的**投影**，
//   不是另一份真相。字段名与服务端逐字一致，是因为面板要显示的就是
//   落盘文件里那一行 —— 中间任何一次"顺手改名/换算"都会让
//   "界面上看到的"与"文件里写着的"变成两件事。

export interface TranscriptAttachmentView {
  name: string
  mimeType: string
  bytes: number
}

export interface TranscriptLineView {
  at: number
  sid: string
  turnId: number
  role: 'user' | 'assistant'
  text: string
  /** 正文被截断了（我们主动截的，原长在 `textBytes`）。 */
  truncated?: boolean
  textBytes?: number
  intent?: string
  gen?: number
  /** 仅 assistant：这条答复有没有真的被念出来。 */
  dropped?: boolean
  /** 仅 assistant：作废原因。`generation`=用户插话（正常），`turn`=轮次翻篇（异常信号）。 */
  dropReason?: 'generation' | 'turn'
  /** 仅 user：当时贴了什么。 */
  attachments?: TranscriptAttachmentView[]
}

export interface TranscriptTurnView {
  sid: string
  turnId: number
  at: number
  /**
   * 三态**互不顶替**：
   *   `answered`   问了，也答了
   *   `unanswered` 问了，没等到答复（在途 / 崩溃 / 进程被重启）
   *   `orphan`     只有答复没有提问（写入被腰斩；出现即说明有问题）
   */
  state: 'answered' | 'unanswered' | 'orphan'
  user: TranscriptLineView | null
  assistant: TranscriptLineView | null
  /**
   * 意图的中文标签，**由服务端给**（`intents.ts` 的 `INTENT_LABEL`）。
   * `null` = 这一轮没解析出意图。前端刻意不维护第二份标签表。
   */
  intentLabel: string | null
}

export interface VoiceTranscriptView {
  turns: TranscriptTurnView[]
  /** `null` = **真的读到了**（哪怕 0 条）。有值 = 读不到，这就是原因。 */
  unreadable: string | null
  /** 解析失败的行数。> 0 必须在界面上说出来。 */
  badLines: number
  badReasons: string[]
  /** 还有更早的记录没取（可翻页）。 */
  more: boolean
  /** 本次扫了哪些日文件。 */
  files: string[]
  /** 落盘侧最近一次失败。`null` = 迄今没失败过。 */
  writeFailure: { at: number; reason: string } | null
  /** 当前进程的会话 id —— 面板用它标出"哪几轮是这次开机聊的"。 */
  sessionId: string
  /** 记录落在哪个目录（给人核对"去哪找文件"）。 */
  root: string
}

/**
 * 手机端远程指挥通道（Telegram）的状态视图。
 *
 * ★ 与 `server/voice/telegram.ts` 的 `TelegramView` **逐字段对应**。
 *   这一份是前端契约（不能 import 服务端类型），所以它必须被
 *   "字段有没有漏"这件事钉住：面板少显示一格，用户就少一个判断依据，
 *   而不会报错。四组容易漏而且都很要紧的：
 *     · `pending`     —— 待放行的会话（用户唯一能自己完成开通的入口）
 *     · `allowedIds`  —— 名单里的具体 id（收回操作需要一个能点名的对象）
 *     · `polling`/`configured` —— "在不在跑"与"配没配"
 *     · `chatListError` —— 白名单文件坏了（四种坏法里唯一一种要去修文件的）
 */
export interface TelegramPendingChatView {
  chatId: string
  /** 对方的显示名（可能为空 —— 有人没设用户名）。 */
  name: string
  at: number
  /** 敲了几次门。> 1 说明他是真想连上，不是误发。 */
  tries: number
}

export interface TelegramView {
  configured: boolean
  /** 白名单**条数**。0 = 谁都不放行（fail-closed）。 */
  allowedChats: number
  /** 白名单里的**具体 id**（与上面那条是两个口径：一个计数、一个清单）。 */
  allowedIds: string[]
  polling: boolean
  /** 当前轮询器的代号。变了说明上一个已经作废（两个循环会重复处理消息）。 */
  loopId: number
  polls: number
  failures: number
  handled: number
  rejected: number
  lastPollAt: number | null
  lastHandledAt: number | null
  lastError: string | null
  /** 待放行的会话 —— 已放行的会被剔掉。 */
  pending: TelegramPendingChatView[]
  /** 一段**可直接显示**的人话（服务端给的，前端不自己拼）。 */
  speech: string
  /** 白名单文件读不出来的原因。`null` = 正常。 */
  chatListError: string | null
  /** 白名单文件路径（用户要能知道"它究竟把名单存哪了"）。 */
  chatFile: string
}
