/**
 * 语音交互服务：把"听到的话"转交给既有系统
 *
 * ── 这一层唯一的职责边界 ────────────────────────────────────────────
 * 解析 → （必要时）确认 → **转交** → 回话。转交的目标永远是既有函数：
 *   仿真/纸面 → `processOrderIntent`
 *   实盘      → `processLiveIntent`（内含晋升门禁 + 资金帽）
 * 本文件里**不允许出现任何自行构造订单并绕过上述函数的代码路径**。
 * 语音的危险在于"张嘴即动作"，一旦给它一条捷径，它就成了全系统唯一
 * 一条没有风控的通道 —— 而它偏偏是最好用的那条。
 *
 * ── 安全开关只能往严的方向调 ────────────────────────────────────────
 * 配置里 `confirmPolicy` 只有两个取值：`graded`（按金额/模式分档，默认）
 * 与 `always`（一律复述金额）。**刻意不提供 `off`** ——
 * 一个能把确认关掉的开关，在压力下（"太烦了"）一定会被关掉，
 * 而它关掉的那一天恰好就是出事的那一天。
 * 设计上只允许用户把系统调得更保守，不允许调得更激进。
 *
 * ── 溯源 ────────────────────────────────────────────────────────────
 * 语音来的订单，`clientOrderId` 前缀固定为 `V-`，并在转交前后各写一条
 * 审计事件（`VOICE_COMMAND` / `VOICE_ORDER_DISPATCHED`）。
 * 于是"这笔单是谁下的"在审计链里是可查的，而不是只能靠回忆。
 * （对应 2026-09-15 日报第 ④ 条 Deltr 的 Provenance 思路。）
 */
import { randomUUID } from 'node:crypto'
import type {
  NarrationLine,
  VoiceStatus,
  VoiceTurn,
  Verbosity,
  OrderSlots,
  PendingConfirmation,
  VoiceIntentName,
} from './types.ts'
import { parseIntent, isDangerous, resolveSymbol, INTENT_LABEL, type IntentContext } from './intents.ts'
// ── 永久记忆层 ──────────────────────────────────────────────────────────
// ★ 记忆**不是**新的行动通道（红线①）。它只做两件事：消解指代、补空的槽位，
//   且补出来的必须**说出来**（`resolvedByReference` / `speakRecall`）。
//   为什么这条要写在 import 旁边：这是最容易在后续"顺手加个功能"时越界的一层 ——
//   让记忆直接决定意图，代码上只差一行，而后果是下单参数由**推断**产生。
import {
  lastMentionedSymbol,
  noteTurn,
  recall,
  recallAsContext,
  remember,
  speakRecall,
  currentFacts,
  factByKey,
  readFacts,
  memoryHealth,
  recentTurns,
  forget,
  hydrateWorkingFromTranscript,
  bindWorkingSid,
} from './memory.ts'
import { extractFacts, detectCorrection } from './memoryExtract.ts'
// 任务层的**裁定**入口。语音这一层只裁定、不启动：
// 启动走 `startMissionByPlan`（带二次裁定 + 执行线占用），由 /mission/start 端点触发。
// 不在这里启动的理由见 `handleUtteranceInner` 里 mission 分支的说明 ——
// "启动许可"需要一个不会被认错的口令，而现有的两段式确认是拿"金额"做口令的。
import { planMission, startMissionByPlan } from '../mission/service.ts'
import { resetStartConsent } from '../mission/consent.ts'
import { extractAmount } from './numerals.ts'
import { VOICE_CATALOG, defaultVoice, getVoice, spokenVoiceList } from './voices.ts'
import type { VoiceEngine } from './voices.ts'
import {
  NEURAL_VOICES,
  defaultNeuralVoice,
  getNeuralVoice,
  handshakeDebug,
  synthesizeNeural,
} from './tts.ts'
import {
  beginTurn,
  commitReply,
  currentGeneration,
  interrupt,
  createPending,
  createPendingUiAction,
  confirmPending,
  consumePending,
  clearPending,
  getPending,
  sessionStatus,
  resetSession,
  setTurnMeta,
  sessionId,
} from './session.ts'
import { readTranscript, transcriptHealth, type TranscriptPage } from './transcript.ts'
import {
  configureNarrator,
  setPolicy,
  observeEvent,
  observeTick,
  drain,
  recentNarrations,
  narratorCounters,
  renderStatusNow,
  tickNarration,
  resetNarrator,
  announce,
  type WorkStatusView,
} from './narrator.ts'
import { anomalyCounters, configureAnomaly, resetAnomaly } from './anomaly.ts'
// ★ 只引工具注册表，**不直接引 `awareness.ts`**。
// 走注册表而不是走函数，是为了让"这条路径复用了哪条既有实现"有一个可断言的落点
// （见 tools.ts 的 `reuses` 与 auditToolRegistry）。直接调函数就绕过了那道检查，
// 而这个文件正是"加一条语音专用实现"最容易被塞进来的地方。
import { getTool, inferLessonCategory, type VoiceToolResult } from './tools.ts'
// ★ 合约单的杠杆裁决：**手动单与自治单规则不同**（见模块头）。
//   两处调用（确认回话 / 真正派单）共用这一个函数，所以"确认时说 3 倍、
//   派单时下 1 倍"这种分岔在结构上不可能发生。
import { judgeLeverage } from './leverageGuard.ts'
import { describePct, parseProtectionWaiver } from './contract.ts'
// 附件是**一轮对话的载荷**，不是一项能力，所以它不进 `tools.ts` 的注册表
// （注册表里每个工具的签名都是 `(arg?: string)`，硬塞结构化载荷会让 `reuses`
// 那道检查退化成形式）。真正的能力是 `ask_model`，附件只是它这一次的入参。
import { digestAttachments, type RawAttachment } from './attachments.ts'
import { askModel } from './model.ts'
// 舰队调度器：判"能不能接"与"按哪条链走"。语音层只用这几个出口。
// ★ `planNeedsConfirm` 是"要不要先问人"的**唯一裁决点**；`undoPlanOf` 用来
//   在回话里指名"要撤就说哪句话"。两个都从这一张表来，语音层不自己判可逆性。
import { FLEET_TASK_PLANS, fleetAgent, planNeedsConfirm, planTask, undoPlanOf } from '../fleet/index.ts'
// ★ 界面动作通道：桌宠能按到的按钮**只认这一张表**。
//   走注册表而不是让本文件自己挑选择器，理由与 `tools.ts` 同源：
//   "能按哪些按钮"必须有一个可断言的落点，否则语音层会慢慢长出一份
//   与界面脱节的白名单（而脱节的表现是"它说按了、界面上没动"）。
import {
  enqueueUiAction,
  resolveExplicitPress,
  resolveUiAction,
  uiPage,
  uiWorkspaceRoot,
  waitForUiAck,
  type UiActionSpec,
  type UiResolution,
} from '../uiActions.ts'
import { appendEvent, getEvents } from '../ledger.ts'
import { getOrchState, processOrderIntent, processLiveIntent, cancelOrder, activateKillswitch, deactivateKillswitch } from '../core.ts'
import { describeGateRefusal, gateOrderForExecution } from '../orderGate.ts'
// ★ 场所能力位（"能不能把保护随主单原子挂上"）读的是**挂着的那个适配器自己**的回答，
//   不是这里硬编码的一张名单 —— 名单一定会与适配器漂移，而漂移的方向是
//   "代码以为能挂、实际挂不上"（一张用户以为有保护的实盘裸仓）。
import { liveGateway } from '../gateway/executor.ts'
import { markPriceOf, cancelAll } from '../orchEngine.ts'
import { buildProtection } from '../protection.ts'
import { currentEquity } from '../risk.ts'
import { autopilotStatus, startAutopilot, stopAutopilot } from '../autopilot.ts'
import { surveillanceSnapshot } from '../surveillance.ts'
import { getRegime } from '../marketRegime.ts'
import { riskBriefSnapshot } from '../riskBrief.ts'
import { getLastReconciliation } from '../reconciliation.ts'

// ───────────────────────────── 配置 ─────────────────────────────

export type ConfirmPolicy = 'graded' | 'always'

export interface VoiceConfig {
  enabled: boolean
  voiceId: string
  verbosity: Verbosity
  muted: boolean
  /** 语速倍率，叠在音色自身的 rate 上。 */
  rate: number
  /** 音高倍率。 */
  pitch: number
  /** 只允许往严的方向调（见文件头）。 */
  confirmPolicy: ConfirmPolicy
  /**
   * 实盘语音下单要用的策略身份。
   *
   * 刻意不给默认值：实盘必须携带**已过晋升门禁**的策略身份，
   * 由 `pipelineService.authorizeLive` 裁决。系统替用户挑一个"看起来还行"的
   * 策略去下真钱单，是这一层最不该做的事。
   */
  defaultLiveStrategyId: string | null
  /** 是否自动播报工作状态（关掉后仍可用嘴问）。 */
  autoNarrate: boolean
}

let cfg: VoiceConfig = {
  enabled: true,
  voiceId: defaultVoice().id,
  verbosity: 'normal',
  muted: false,
  rate: 1,
  pitch: 1,
  confirmPolicy: 'graded',
  defaultLiveStrategyId: process.env.VOICE_LIVE_STRATEGY ?? null,
  autoNarrate: true,
}

/**
 * 对外配置视图 = 配置本体 + 音色目录。
 *
 * ★ 这个别名存在的原因是**这里曾经有两种形状**：`GET /voice/config` 返回带 catalog 的，
 * 而 `setVoiceConfig` 返回不带 catalog 的裸 `cfg`。前端 `config?.catalog.find(...)`
 * 的可选链只保护了 `config`、**没有保护 `catalog`** —— 于是每次点「换音色」都崩进
 * ErrorBoundary（界面提示"发生未捕获错误"），同时音色列表整块消失（表现为"选不了其他音色"）。
 * 两个症状同源，都是"配置被换成缺字段的版本"。
 *
 * 修法是**唯一生产**：两条路径都由 `voiceConfigView()` 给出，形状不可能再漂移。
 * 前端也补了防御，但那是兜底 —— 类型的正确性不该靠调用方小心。
 */
export type VoiceConfigView = VoiceConfig & { catalog: typeof VOICE_CATALOG }

export function voiceConfigView(): VoiceConfigView {
  return { ...cfg, catalog: VOICE_CATALOG }
}

/** 兼容旧名。GET 端点与写入端点必须返回同一形状 —— 见 `VoiceConfigView` 的说明。 */
export const voiceConfig = voiceConfigView

export function setVoiceConfig(patch: Partial<VoiceConfig>): { ok: boolean; reason?: string; config: VoiceConfigView } {
  if (patch.voiceId !== undefined && !getVoice(patch.voiceId)) {
    return { ok: false, reason: `UNKNOWN_VOICE（可选：${VOICE_CATALOG.map((v) => v.id).join(', ')}）`, config: voiceConfigView() }
  }
  if (patch.verbosity !== undefined && !['alarm-only', 'normal', 'chatty'].includes(patch.verbosity)) {
    return { ok: false, reason: 'UNKNOWN_VERBOSITY', config: voiceConfigView() }
  }
  if (patch.confirmPolicy !== undefined && !['graded', 'always'].includes(patch.confirmPolicy)) {
    return { ok: false, reason: 'CONFIRM_POLICY_MUST_BE_GRADED_OR_ALWAYS（不提供关闭项，见设计说明）', config: voiceConfigView() }
  }
  if (patch.rate !== undefined && (!Number.isFinite(patch.rate) || patch.rate < 0.5 || patch.rate > 2)) {
    return { ok: false, reason: 'RATE_OUT_OF_RANGE(0.5~2)', config: voiceConfigView() }
  }
  if (patch.pitch !== undefined && (!Number.isFinite(patch.pitch) || patch.pitch < 0.5 || patch.pitch > 2)) {
    return { ok: false, reason: 'PITCH_OUT_OF_RANGE(0.5~2)', config: voiceConfigView() }
  }
  cfg = { ...cfg, ...patch }
  setPolicy({ verbosity: cfg.verbosity, muted: cfg.muted })
  appendEvent('VOICE_CONFIG_UPDATED', { ...patch })
  return { ok: true, config: voiceConfigView() }
}

// ───────────────────────────── 上下文 ─────────────────────────────

/** 意图解析上下文：标的池直接取编排层的实时价格表 —— 唯一真源，不另立一份。 */
export function intentContext(): IntentContext {
  const s = getOrchState()
  const symbols = [...new Set([...s.lastPrice.keys(), ...s.positions.keys()])]
  return {
    symbols,
    markPrice: (sym) => markPriceOf(s, sym),
    // ★ 指代消解目标 = 上一句里出现过的标的（记忆层提供）。
    //   `null` 时解析层照旧只走字面判据 —— 也就是说，没有记忆的时候
    //   这一层的行为与加它之前**逐字节一致**（配对断言要能证明这一点）。
    referTo: lastMentionedSymbol(),
  }
}

/**
 * 任务解析上下文。
 *
 * 标的解析器用**语音层那一份**（注入，不重写）：任务句里也会出现标的
 * （「在 okx 测试网做比特币」），而"以太坊能不能落到池子里"这种判断
 * 在这个仓库里必须只有一处答案 —— 两份迟早分岔。
 */
export function missionGoalContext(): { symbols: string[]; resolveSymbol: typeof resolveSymbol; nowMs: number } {
  return {
    symbols: intentContext().symbols,
    resolveSymbol,
    nowMs: Date.now(),
  }
}

function workStatusView(): WorkStatusView {
  const ap = autopilotStatus()
  const stageLabel: Record<string, string> = {
    idle: '待命',
    accumulating: '收集样本',
    optimizing: '选优',
    trading: '持仓交易',
    target_reached: '目标已达成',
    drawdown_stopped: '回撤停机',
  }
  const nextStep: Record<string, string> = {
    idle: '等你说开始',
    accumulating: `再攒够样本就去跑过拟合门`,
    optimizing: '等这一轮门禁结论出来',
    trading: '继续盯止损和目标位',
    target_reached: '等你决定要不要接着跑',
    drawdown_stopped: '等你确认风险之后再重启',
  }
  let activity = ''
  if (ap.stage === 'accumulating') {
    const need = ap.gateRefusal?.retryAtBars ?? 0
    const have = ap.barsAccumulated
    activity = need > have ? `已经收了 ${have} 根 K 线，约到 ${need} 根时再判一次` : `已经收了 ${have} 根 K 线`
  } else if (ap.stage === 'trading' && ap.guard) {
    // PositionSide 是 'long' | 'short'，不是 'buy' | 'sell' —— 别把两套方向词汇混着用
    activity = `持有 ${ap.guard.side === 'long' ? '多' : '空'}仓 ${ap.guard.qty}，浮盈 ${ap.guard.unrealizedRoiPct.toFixed(2)}%，当前在 ${ap.guard.r.toFixed(2)} 倍风险`
  }
  const gateRefusal = ap.gateRefusal
    ? `过拟合门上次没放行：${ap.gateRefusal.summary}`
    : null
  return {
    running: ap.running,
    stageLabel: stageLabel[ap.stage] ?? ap.stage,
    nextStep: nextStep[ap.stage] ?? '待定',
    activity,
    strategyId: ap.winner,
    targetPct: ap.targetPct,
    pnlPct: ap.pnlPct ?? undefined,
    gateRefusal,
  }
}

function equityView(): { equity: number; starting: number; peak: number } {
  const s = getOrchState()
  return { equity: currentEquity(s), starting: s.startingBalance, peak: s.peakEquity }
}

// ───────────────────────────── 播报接线 ─────────────────────────────

let tickTimer: ReturnType<typeof setInterval> | null = null
/** 已消费到的事件序号，保证播报与账本一一对应、不重复不遗漏。 */
let lastObservedSeq = 0

/**
 * 订阅账本事件 → 播报。
 *
 * 用**轮询游标**而不是在 `appendEvent` 里回调，是为了不让账本反向依赖语音层：
 * 账本是全系统最底层的组件，一旦它开始 import 业务模块，任何业务模块的
 * 加载失败都会把审计链一起拖死。
 */
function pumpEvents(): void {
  if (!cfg.enabled || !cfg.autoNarrate) return
  const evs = getEvents(lastObservedSeq)
  for (const e of evs) {
    lastObservedSeq = Math.max(lastObservedSeq, e.seq)
    observeEvent(e.kind, e.payload, e.seq, e.ts)
  }
}

export function startVoice(): void {
  configureNarrator({ workStatus: workStatusView, equity: equityView })
  // 异动检测的波动率尺子直接用 1H ATR —— 与止损几何同一把，不另立口径
  configureAnomaly(undefined, (symbol) => {
    const r = getRegime(symbol)
    return r?.atr1h ?? Number.NaN
  })
  setPolicy({ verbosity: cfg.verbosity, muted: cfg.muted })
  // ── ★★ 回填工作记忆：这就是"永久"两个字的落点 ─────────────────────────
  // 不回填的话，每次重启桌宠都会重新变成陌生人 —— 而它**看起来完全正常**
  // （照样答得上话，只是不记得任何前情）。用户对这一层的期待恰恰是
  // "我昨天跟你说的那件事"。
  try {
    bindWorkingSid(sessionId())
    const page = readTranscript({ limit: 12, days: 3 })
    // ★ 标的识别只有一份判据（`resolveSymbol`）。在这里另写一个正则的后果是
    //   "回填认出的标的"与"实时认出的标的"不一致 ⇒ 症状是
    //   "重启前听得懂同一句话、重启后听不懂"。
    const ctx0 = intentContext()
    const n = hydrateWorkingFromTranscript(page, (t) => {
      const one = resolveSymbol(t, ctx0.symbols)
      return one === null ? [] : [one]
    })
    if (n > 0) appendEvent('VOICE_MEMORY_HYDRATED', { turns: n, files: page.files })
    if (page.unreadable !== null) {
      // ★ 读不到要**说出来**：否则"重启后失忆"与"本来就没聊过"长得一样。
      appendEvent('VOICE_MEMORY_HYDRATE_FAILED', { reason: page.unreadable })
    }
  } catch (e) {
    appendEvent('VOICE_MEMORY_HYDRATE_FAILED', { reason: e instanceof Error ? e.message : String(e) })
  }
  // 从当前链尾开始消费，避免启动瞬间把历史事件全部念一遍
  const evs = getEvents(0)
  lastObservedSeq = evs.length > 0 ? evs[evs.length - 1].seq : 0
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      pumpEvents()
      tickNarration()
    }, 3_000)
    // 定时器不应阻止进程退出
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
  }
  appendEvent('VOICE_LAYER_STARTED', { voiceId: cfg.voiceId, verbosity: cfg.verbosity, confirmPolicy: cfg.confirmPolicy })
}

export function stopVoice(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

export function resetVoice(): void {
  stopVoice()
  resetNarrator()
  resetAnomaly()
  resetSession()
  // 待用启动口令也要清。**不清的后果是测试之间互相污染**：
  // 上一个用例签发的口令在下一个用例里仍然有效，
  // 于是"没有口令就不放行"这条断言会在**运气好**的时候通过。
  resetStartConsent()
  lastObservedSeq = 0
  cfg = {
    enabled: true,
    voiceId: defaultVoice().id,
    verbosity: 'normal',
    muted: false,
    rate: 1,
    pitch: 1,
    confirmPolicy: 'graded',
    defaultLiveStrategyId: null,
    autoNarrate: true,
  }
}

/** 由行情 tick 调用。 */
export function onVoicePriceTick(symbol: string, price: number): void {
  if (!cfg.enabled || !cfg.autoNarrate) return
  observeTick(symbol, price)
}

// ───────────────────────────── 日报 ─────────────────────────────

function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface DailyBrief {
  sinceTs: number
  /** 账本最早事件晚于今天零点时为 true —— 说明统计是从进程启动算起的，必须如实说。 */
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
  reconciliation: string
  riskUsage: { notionalCap: number; ordersPerMinuteCap: number; drawdownCapPct: number; currentDrawdownPct: number }
  topRejectReasons: { reason: string; count: number }[]
  narration: string
}

export function dailyBrief(now = Date.now()): DailyBrief {
  const s = getOrchState()
  const eq = currentEquity(s)
  const since = startOfToday(now)
  const evs = getEvents(0)
  const today = evs.filter((e) => e.ts >= since)
  const earliest = evs.length > 0 ? evs[0].ts : now
  const partialDay = earliest > since

  let fills = 0
  let rejects = 0
  let submits = 0
  const rejectReasons = new Map<string, number>()
  for (const e of today) {
    if (e.kind === 'ORDER_FILL') fills += 1
    else if (e.kind === 'ORDER_REJECT') {
      rejects += 1
      const r = String(e.payload.reason ?? 'UNKNOWN')
      rejectReasons.set(r, (rejectReasons.get(r) ?? 0) + 1)
    } else if (e.kind === 'ORDER_SUBMIT') submits += 1
  }

  const ap = autopilotStatus()
  const surv = surveillanceSnapshot()
  const recon = getLastReconciliation()
  const rb = riskBriefSnapshot()
  const pnlPct = s.startingBalance > 0 ? ((eq - s.startingBalance) / s.startingBalance) * 100 : 0
  const ddPct = s.peakEquity > 0 ? ((s.peakEquity - eq) / s.peakEquity) * 100 : 0

  const topRejectReasons = [...rejectReasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  // 对账状态：**没有报告过**与"报告了一致"是两件事，不能都说成"一致"
  const reconKnown = recon !== null
  const reconConsistent = recon?.consistent === true

  const lines: string[] = []
  lines.push(`今天是${partialDay ? '从进程启动开始的统计' : '今天的统计'}。`)
  lines.push(`权益 ${eq.toFixed(2)}，相对起点${pnlPct >= 0 ? '盈' : '亏'} ${Math.abs(pnlPct).toFixed(2)}%。`)
  lines.push(`当前持仓 ${s.positions.size} 个，今天成交 ${fills} 笔，提交 ${submits} 笔，被拒 ${rejects} 笔。`)
  if (topRejectReasons.length > 0) {
    lines.push(`被拒最多的是：${topRejectReasons.map((r) => `${r.reason} ${r.count} 次`).join('；')}。`)
  }
  lines.push(
    `自动驾驶现在是${ap.running ? `${ap.stage} 阶段，目标 ${ap.targetPct}%` : '停着的'}${ap.gateRefusal ? `，过拟合门上次没放行：${ap.gateRefusal.summary}` : ''}。`,
  )
  lines.push(`监控标记 ${surv.recentFlags.length} 条，其中小额高频 ${surv.counters.flaggedSmallNotionalBursts} 次。`)
  lines.push(
    reconKnown
      ? `对账${reconConsistent ? '一致' : '不一致，需要处理'}。`
      : '对账还没跑过，不知道本地账本和柜台对不对得上。',
  )
  lines.push(
    `风控余量：回撤已用 ${ddPct.toFixed(2)}%，上限 ${s.risk.maxDrawdownPct}%；` +
      `逐笔名义额上限 ${s.risk.maxNotionalPerOrder} 美元，单笔风险额是权益的 ${(rb.riskPerTradeRatio * 100).toFixed(2)}%。`,
  )
  if (s.killswitch) lines.push('注意：熔断现在是开着的。')

  return {
    sinceTs: since,
    partialDay,
    equity: Math.round(eq * 100) / 100,
    starting: s.startingBalance,
    pnlPct: Math.round(pnlPct * 100) / 100,
    positions: s.positions.size,
    fills,
    rejects,
    submits,
    killswitch: s.killswitch,
    autopilotStage: ap.stage,
    gateRefusalSummary: ap.gateRefusal?.summary ?? null,
    surveillanceFlags: surv.recentFlags.length,
    reconciliation: reconKnown ? (reconConsistent ? 'consistent' : 'inconsistent') : 'unknown',
    riskUsage: {
      notionalCap: s.risk.maxNotionalPerOrder,
      ordersPerMinuteCap: s.risk.maxOrdersPerMinute,
      drawdownCapPct: s.risk.maxDrawdownPct,
      currentDrawdownPct: Math.round(ddPct * 100) / 100,
    },
    topRejectReasons,
    narration: lines.join(''),
  }
}

// ───────────────────────────── 轮次 ─────────────────────────────

export interface VoiceReply {
  turnId: number
  /** 该轮答复是否已被更晚的打断作废（前端据此**不要**念出来）。 */
  dropped: boolean
  intent: VoiceIntentName
  intentLabel: string
  confidence: number
  reply: string
  detail?: string
  pending: ReturnType<typeof getPending>
  executed?: { ok: boolean; reason?: string; clientOrderId?: string; orderId?: string; status?: string }
  /** 本轮顺带产生的播报（已入队的部分）。 */
  narration: NarrationLine[]
}

/** 把「确认」这条口令接回上下文。 */
async function handleConfirm(text: string, turnId: number, gen: number): Promise<VoiceReply> {
  const amt = extractAmount(text)
  const pendingBefore = getPending()
  // 「always」策略下即使金额很小也要求复述。
  //
  // ★ `expectedAmount > 0` 这个条件是本轮补的，它修的是一条**真实死路**：
  //   熔断 / 全部撤单 / 登记心法 / 自我进化这四个动作都没有金额，`expectedAmount` 恒为 0。
  //   在 `always` 档下旧代码会要求用户"把金额念一遍"，而**没有任何数字能对上 0** ——
  //   用户反复念、反复被判不符，最终只能放弃，且他无从知道原因。
  //   复述金额的作用是校验 ASR 有没有听错数字（见 session.ts 文件头），
  //   一个没有数字的动作没有可校验的对象，不该被要求复述。
  if (cfg.confirmPolicy === 'always' && pendingBefore && !amt && pendingBefore.expectedAmount > 0) {
    const ask = `请把金额念一遍我才敢执行：说「确认 ${pendingBefore.expectedAmount}」。`
    const r: VoiceReply = {
      turnId,
      dropped: false,
      intent: 'confirm',
      intentLabel: INTENT_LABEL.confirm,
      confidence: 1,
      reply: ask,
      pending: pendingBefore,
      narration: [],
    }
    if (!commitReply(turnId, ask, gen)) r.dropped = true
    return r
  }

  const check = confirmPending(amt ? { value: amt.value, basis: amt.basis } : null)
  if (!check.ok) {
    if (check.reason.startsWith('VOICE_CONFIRM_AMOUNT_MISMATCH')) {
      // 复述金额不符＝强证据表明 ASR 听错了数字，必须单独留痕：
      // 这是「语音下单听错数字」这一风险类别的唯一可观测信号。
      appendEvent('VOICE_CONFIRM_MISMATCH', { expected: check.expected, heard: amt?.value })
    }
    const r: VoiceReply = {
      turnId,
      dropped: false,
      intent: 'confirm',
      intentLabel: INTENT_LABEL.confirm,
      confidence: 1,
      reply: `还不能执行：${check.reason}`,
      detail: check.reason,
      pending: getPending(),
      narration: [],
    }
    if (!commitReply(turnId, r.reply, gen)) r.dropped = true
    return r
  }

  const p = consumePending()!
  appendEvent('VOICE_CONFIRMED', { token: p.token, action: p.action, intent: p.intent, expectedAmount: p.expectedAmount })
  // ★ 界面按钮走**另一条出口**：确认这一步校验的是"人有没有批准"，
  //   真正动手的仍然是界面上那颗按钮的同一个 onClick。
  //   服务端在这里只做"排进队列"，它按不到那颗按钮（见 uiActions.ts 文件头）。
  const exec = p.uiActionId
    ? dispatchUiAction(p.uiActionId, p.uiActionLabel ?? p.action)
    : await dispatchDangerous(p.slots, p.intent, p.intentArg)
  const reply = exec.ok
    ? `已执行：${p.action}。${exec.detail ?? ''}`
    : // 失败时同时给出机器原因与可读解释：前者可核对（与界面上同源），
      // 后者才不会让用户只看到一串错误码而不知道该改什么。
      `执行被拒：${exec.reason ?? '未知原因'}。${exec.detail ? exec.detail : ''}`
  const r: VoiceReply = {
    turnId,
    dropped: false,
    intent: 'confirm',
    intentLabel: INTENT_LABEL.confirm,
    confidence: 1,
    reply,
    detail: exec.reason,
    pending: null,
    executed: { ok: exec.ok, reason: exec.reason, clientOrderId: exec.clientOrderId, orderId: exec.orderId, status: exec.status },
    narration: [],
  }
  if (!commitReply(turnId, r.reply, gen)) r.dropped = true
  return r
}

/**
 * 把成员链翻成**成员表里的拟人名**，用来在回话里说清"谁会来干这件事"。
 *
 * ── 这里为什么不再念计划表的 `why` ──────────────────────────────────────
 * 上一轮这里是一个 `speakable(text)`，把 `plan.why` 里的 markdown 星号剥掉再念。
 * 那是**治标**：星号没了，但 `why` 本身是**写给开发者与面板看的**设计说明，
 * 里面写着「根因是『自治循环』这个词有两个主人…」「用户实测反馈是『让它一键
 * 启动自治循环…』」。用户实测听到的原话，就是自己上一次的反馈被原样念回来，
 * 中间还夹着一段内部归因 —— 他不该从我嘴里听到我的笔记。
 *
 * ★ 判据 19 说的正是这个：**注释/说明文描述的是给谁看的**。
 *   `why` 的读者是维护者和面板，不是耳朵。所以出口这里换成人名 ——
 *   成员表里本来就有「自治循环启动员」「交易自动驾驶启动员」这样的拟人名，
 *   它才是"这件事会由谁办"的准确说法（判据 10：要有读者，也得有听者）。
 *
 * ★ 于是 `speakable()` 被**删掉**而不是留着：它唯一的用途就是念 `why`，
 *   留着它就是一条没有任何调用点的死代码 —— 而死代码会让人以为
 *   "某处还在念 why"（判据 13：分得清"能力没有"与"名字烂了"）。
 */
function planCast(plan: { chain: readonly string[] }): string {
  return plan.chain.map((id) => fleetAgent(id)?.label ?? id).join(' → ')
}

/** 没把握时把候选列出来问一句。**列出页面名**是这段话的全部价值所在 —— 不然用户不知道该加什么限定词。 */
function weakCandidatesSpeech(candidates: UiActionSpec[]): string {
  const list = candidates.map((c) => `「${uiPage(c.page)?.label ?? c.page}」页的「${c.label}」`).join('、')
  return `我没把握你说的是哪一颗按钮 —— 你可能是想按：${list}。把页面名字一起说，我就能定下来（比如「系统监控页按一下启动」）。`
}

/** `prepareUiClick` 的结果。`pending` 有值 = 这一步只是**问人**，还没排。 */
interface UiClickPrep {
  speech: string
  pending?: PendingConfirmation
}

/**
 * 处置"要按一颗按钮"。**这是唯一一份实现** —— 严格档与宽档共用它。
 *
 * ★ 严格档（`looksLikeExplicitPress`）与宽档只是**什么时候允许抢**的区别；
 *   "抢到之后怎么办"必须只有一处 —— 否则两条路迟早对同一颗按钮
 *   给出不同的确认文案，而用户只会看到其中一条。
 */
function prepareUiClick(spec: UiActionSpec, turnId: number): UiClickPrep {
  if (spec.writes) {
    // 两段式：先问人。**不**在这里排 —— 排了就变成"没人批准也执行"。
    const p = createPendingUiAction(spec.id, spec.label, turnId)
    appendEvent('VOICE_CONFIRM_REQUESTED', {
      action: spec.label,
      intent: 'ui_action',
      expectedNotional: 0,
      uiActionId: spec.id,
    })
    return {
      speech:
        `我打算按「${spec.label}」这颗按钮。${spec.speaks}` +
        '它会动到系统状态，所以先问你一句：确认吗？说「确认」我就把它排给界面去按。不用复述数字，它不涉及金额。',
      pending: p,
    }
  }
  // 只读动作不用问，但**必须说清"排了"和"按了"是两件事**。
  const r = dispatchUiAction(spec.id, spec.label)
  return {
    speech: r.ok
      ? `好，我把「${spec.label}」排给界面了。${spec.speaks}界面下一次轮询会自己去按 —— 要是没生效你说一声「队列里有什么」，我告诉你它到底执行了没有。`
      : `这个我按不了：${r.detail ?? r.reason ?? '未知原因'}`,
  }
}

interface DispatchOutcome {
  ok: boolean
  reason?: string
  detail?: string
  clientOrderId?: string
  orderId?: string
  status?: string
}

/**
 * 把一条界面按钮排进队列（确认之后才走到这里）。
 *
 * ★ `confirmed: true` 是**这里**给的，而且只有这一条路给得起 ——
 *   它的上游是 `consumePending()`，也就是"人刚刚确认过"这件事本身。
 *   桌面宠物或别的调用方想自己传一个 `confirmed: true` 进来，
 *   那条路不经过 `consumePending`，它拿不到这个值。
 */
function dispatchUiAction(actionId: string, label: string): DispatchOutcome {
  const dir = uiWorkspaceRoot()
  const r = enqueueUiAction(dir, actionId, { requestedBy: 'voice', confirmed: true })
  appendEvent('VOICE_UI_ACTION', {
    action: actionId,
    label,
    ok: r.ok,
    reason: r.ok ? null : r.reason,
  })
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.speech }
  // ★ 排进去 ≠ 按下去。界面要下一次轮询才来取，所以这里的说法是
  //   "我已经把它排上了"，不是"已经按了" —— 后者是这轮改动要治的
  //   那类假成功（用户实测反馈的"只完成了一半"）。
  return {
    ok: true,
    detail: `已经排进界面队列了，界面下一次轮询（最多 2 秒）会自己去按「${label}」那颗按钮。`,
  }
}

/**
 * 危险动作的统一出口。
 *
 * **所有**会改变资金/运行状态的动作都必须从这里走，且这里只调用既有函数。
 * 新增一类动作时，如果发现需要在本函数里"自己构造"点什么，那就说明
 * 该动作在既有系统里没有对应实现 —— 应当先去补那边的实现，
 * 而不是在语音层就地造一个。
 */
async function dispatchDangerous(
  slots: OrderSlots,
  intent: VoiceIntentName,
  /** 非订单类动作的文字参数（心法正文）。经 `PendingConfirmation.intentArg` 原样传回来。 */
  intentArg?: string,
): Promise<DispatchOutcome> {
  const s = getOrchState()

  // ── 自我进化：跑一轮因子提案 ────────────────────────────────────────
  //
  // ★ 用户要的"能自我调用大模型修改代码升级进化自己"，在本系统的落点是**提案引擎**，
  //   而不是自动改源码。理由不是保守，是这套系统唯一一道"改动必须留下证据"的闸
  //   就是晋级流水线：候选 → 过拟合门 → 纸交易观察 → 测试网实测 → 小资金 → 全量。
  //   给语音意图开一条绕过它去改码的路，等于把闸拆了 ——
  //   而拆掉之后没有任何东西会报红，只有钱会慢慢少。
  //   所以它能做的是：提提案、把证据落账、等门和人批。
  //
  // ★ 先报"开始了"：这一步要几十秒。不先出声的话，用户面对的是几十秒的沉默，
  //   而他无法区分"在跑"和"没听见"。这是"实时报告工作进度"在这条路径上的实现。
  if (intent === 'self_upgrade') {
    const tool = getTool('propose_upgrade')
    if (!tool) return { ok: false, reason: 'TOOL_NOT_REGISTERED:propose_upgrade' }
    const started = appendEvent('VOICE_TOOL_RUN_STARTED', { tool: tool.id, reuses: tool.reuses })
    announce({
      text: '开始跑因子提案了。这一步要几十秒，跑完我就报结果。',
      category: 'work-state',
      priority: 'P2_STATUS',
      seq: started.seq,
      kind: 'VOICE_TOOL_RUN_STARTED',
      dedupeKey: `tool-start:${started.seq}`,
    })
    const r = await tool.run()
    const done = appendEvent('VOICE_TOOL_RUN', {
      tool: tool.id,
      ok: r.ok,
      steps: r.steps,
      reason: r.reason ?? null,
      reuses: tool.reuses,
    })
    for (const step of r.steps) {
      announce({ text: step, category: 'work-state', priority: 'P2_STATUS', seq: done.seq, kind: 'VOICE_TOOL_RUN' })
    }
    return { ok: r.ok, reason: r.reason, detail: r.speech }
  }

  // ── 登记心法：走 proposeLesson，证据由服务端从审计账本现算 ─────────────
  if (intent === 'record_lesson') {
    const tool = getTool('file_lesson')
    if (!tool) return { ok: false, reason: 'TOOL_NOT_REGISTERED:file_lesson' }
    const r = await tool.run(intentArg)
    const done = appendEvent('VOICE_TOOL_RUN', {
      tool: tool.id,
      ok: r.ok,
      steps: r.steps,
      reason: r.reason ?? null,
      reuses: tool.reuses,
      // 只记长度，**不记正文**：心法正文是用户原话，可能含个人信息，
      // 而落账的那一份是最容易被导出、被贴进别处的。要读正文去心法库读
      // （那里本来就要存它），审计链只留"有人在这一刻写了一条多长的心法"。
      contentLength: (intentArg ?? '').length,
    })
    for (const step of r.steps) {
      announce({ text: step, category: 'work-state', priority: 'P2_STATUS', seq: done.seq, kind: 'VOICE_TOOL_RUN' })
    }
    return { ok: r.ok, reason: r.reason, detail: r.speech }
  }

  // ── 派舰队干活：走 `tools.ts` 的 `dispatch_task` ──────────────────────
  //
  // ★ 它调的是舰队调度器 `runTask()`，与面板上的「跑这个任务」、
  //   `POST /fleet/task` 是**同一个函数**。语音层不自己拼成员链 ——
  //   自己拼就等于承认"语音能干的活"与"界面能干的活"是两回事，
  //   而它们必须是一回事（否则风控/门槛会出现两条路径，本仓库为此付过代价）。
  //
  // ★ 先播报"开跑了"：慢成员（因子生产 / 策略筛查）实测分钟级。
  //   不先出声的话用户会以为它卡住了，而他无法区分"在跑"和"没听见"。
  if (intent === 'dispatch_task') {
    const tool = getTool('dispatch_task')
    if (!tool) return { ok: false, reason: 'TOOL_NOT_REGISTERED:dispatch_task' }
    const started = appendEvent('VOICE_TOOL_RUN_STARTED', { tool: tool.id, reuses: tool.reuses, goalLength: (intentArg ?? '').length })
    announce({
      text: '开始派舰队干活了。慢的那几步要几十秒到几分钟，跑完我逐条报。',
      category: 'work-state',
      priority: 'P2_STATUS',
      seq: started.seq,
      kind: 'VOICE_TOOL_RUN_STARTED',
      dedupeKey: `tool-start:${started.seq}`,
    })
    const r = await tool.run(intentArg)
    const done = appendEvent('VOICE_TOOL_RUN', { tool: tool.id, ok: r.ok, steps: r.steps, reason: r.reason ?? null, reuses: tool.reuses })
    for (const step of r.steps) {
      announce({ text: step, category: 'work-state', priority: 'P2_STATUS', seq: done.seq, kind: 'VOICE_TOOL_RUN' })
    }
    return { ok: r.ok, reason: r.reason, detail: r.speech }
  }

  if (intent === 'close_position') {
    const symbol = slots.symbol
    const pos = symbol ? s.positions.get(symbol) : undefined
    if (!pos) return { ok: false, reason: `NO_POSITION（${symbol || '全部标的'}当前无持仓）` }
    if (pos.qty <= 0) {
      return { ok: false, reason: 'POSITION_IS_SHORT（空头平仓请走交易终端，语音暂不支持）' }
    }
    return slots.live ? submitLiveOrder({ ...slots, side: 'sell', qty: pos.qty }, true) : submitOrder({ ...slots, side: 'sell', qty: pos.qty }, true)
  }

  if (intent === 'cancel_all') {
    const n = cancelAll(s)
    appendEvent('VOICE_CANCEL_ALL', { cancelledOrders: n })
    return { ok: true, detail: `已撤销 ${n} 笔本地挂单。`, status: 'cancelled' }
  }

  if (intent === 'killswitch_on') {
    const n = activateKillswitch('VOICE_COMMAND')
    return { ok: true, detail: `熔断已开启，撤销 ${n} 笔挂单。`, status: 'killswitch' }
  }
  if (intent === 'killswitch_off') {
    deactivateKillswitch()
    return { ok: true, detail: '熔断已解除。', status: 'killswitch-off' }
  }

  // 默认：下单（仿真与实盘走各自的既有函数）
  return slots.live ? submitLiveOrder(slots, false) : submitOrder(slots, false)
}

/**
 * 把「合约槽位」落成可执行参数，并在不可行时**明确拒绝**。
 *
 * ★ 它同时被两处调用：**确认回话**（念给用户复核）与**真正派单**（决定杠杆）。
 *   共用同一个函数，是因为这两处一旦各算一遍，"确认时说 3 倍、下单时下 1 倍"
 *   就会成为可能 —— 而用户在确认那一刻点过头，等于为另一个数签了字。
 *
 * ★ 返回的 `echo` 是**完整解释**，不是摘要。用户实测那次偏离之所以没人发现，
 *   就是因为回话里只说了"买入 BTC 10 美元"，杠杆/合约/止盈/止损一个字都没有：
 *   复核的人看到的是一句他自己也没说过的话，却挑不出错。
 */
export interface ContractReadback {
  ok: boolean
  /** 生效杠杆。 */
  leverage: number
  instType: 'SPOT' | 'SWAP'
  /** 一句话念回：这笔单到底是什么。 */
  echo: string
  /** 杠杆裁决的理由（ok 与不 ok 都有话要说）。 */
  speech: string
  /** 不可行时的原因码，落账用。 */
  reason?: string
}

export function describeContractOrder(sl: OrderSlots, mark: number): ContractReadback {
  const instType = sl.instType ?? 'SPOT'
  const side: 'long' | 'short' = sl.side === 'buy' ? 'long' : 'short'
  const v = judgeLeverage({
    entryPrice: mark,
    side,
    instType,
    requested: sl.leverage,
    stopLossPct: sl.stopLossPct,
  })

  const parts: string[] = []
  // ★ 念回用的是**用户报的倍数**，不是生效倍数。
  //   被拒时 `effective` 是 1（占位），拿它去念会得到「1 倍合约」——
  //   而用户说的是 125 倍。回话与他的原话对不上，他就没法复核。
  //   生效倍数由下面 `speech` 里的裁决说明负责讲清楚。
  const shownLev = v.heard ? v.requested : v.effective
  parts.push(shownLev > 1 || instType === 'SWAP' ? `${shownLev} 倍合约` : '现货')

  if (sl.amountBasis === 'margin' && sl.notional !== undefined && shownLev > 0) {
    const margin = sl.notional / shownLev
    parts.push(`保证金 ${fmtU(margin)} 美元（名义 ${fmtU(sl.notional)} 美元）`)
  } else if (sl.notional !== undefined) {
    parts.push(`名义 ${fmtU(sl.notional)} 美元`)
  } else if (sl.qty !== undefined) {
    parts.push(`数量 ${sl.qty} 个`)
  }

  const tp = sl.takeProfitPct
  const sp = sl.stopLossPct
  if (tp !== undefined) parts.push(`止盈 ${describePct(tp)}`)
  if (sp !== undefined) parts.push(`止损 ${describePct(sp)}`)
  // ★ 「说了保护但没解析出比例」必须显式说出来。
  //   沉默的后果不是"少一个数"，是**用户以为设了保护、实际在裸跑**，
  //   而界面和账本上都看不出任何缺口。判据 24 那一族：缺数据要说出来。
  if (sl.protectionUnparsed?.takeProfit) parts.push('止盈（你说了，但我没解析出比例）')
  if (sl.protectionUnparsed?.stopLoss) parts.push('止损（你说了，但我没解析出比例）')
  if (tp === undefined && sp === undefined && !sl.protectionUnparsed?.takeProfit && !sl.protectionUnparsed?.stopLoss) {
    parts.push('未设止盈止损')
  }

  const echo = `${sl.side === 'buy' ? '做多' : '做空'} ${sl.symbol || '（缺标的）'}：${parts.join(' · ')}`
  return {
    ok: v.ok,
    leverage: v.effective,
    instType,
    echo,
    speech: v.speech,
    reason: v.reason,
  }
}

/**
 * 「刚才我问过一句：这笔单要不要带保护」。
 *
 * ── 为什么需要它（而不是让用户每次都把话重说一遍）────────────────────
 * 缺保护时系统的动作是**问一句**（用户裁决：fail-closed + 反问，
 * 而不是替用户编一个保护价）。既然问了，用户最自然的回答就是一句
 * 「不要」—— 而「不要」**不是一笔新订单**，它是对**上一个问题**的回答。
 * 没有这份状态时，那句「不要」会被当成一笔只有两个字的订单去解析，
 * 结果是"没听到数量"，然后用户必须把整句话带上"不带保护"重说一遍。
 * 那不是"更安全"，那是**把系统的状态推给用户去记**。
 *
 * ★ 它**刻意**只记"我问了什么"，不记"我打算做什么决定"：
 *   用户回答之后走的仍然是**同一条** `place_order` 路径、同一次确认、
 *   同一道闸门 —— 这份状态只负责把**上一句被问到的订单**端回来。
 *   一但它开始携带"结论"（例如"用户已经同意了"），它就会变成第二条确认通道，
 *   而那正是本项目反复付代价的那种形态。
 *
 * ★ TTL：问题过期之后不再认那句回答（用户可能隔了很久才说"不要"，
 *   那时他指的未必是这笔单）⇒ 过期就按普通输入解析，并如实说"我没在等你回答"。
 */
interface PendingProtectionQuestion {
  at: number
  slots: OrderSlots
  notional: number
}

let pendingProtectionQuestion: PendingProtectionQuestion | null = null
const PROTECTION_QUESTION_TTL_MS = 3 * 60_000

/**
 * 这句话是不是在回答"要不要带保护"。
 *
 * ★ 只认**短句**（≤ 12 字）且是纯否定/纯肯定的形状。
 *   放宽成"句子里含'不要'"会把「不要止损，改成止盈 5%」这类**带新内容**的话
 *   误判成回答 —— 而那种话里带着用户的新要求，应当走正常解析。
 */
function readProtectionQuestionAnswer(text: string): 'waive' | 'cancel' | null {
  const t = text.trim().replace(/[。．.!！?？,，、]+$/u, '')
  if (t.length === 0 || t.length > 12) return null
  // ── 取消：只认**明确的"这笔不做了"** ────────────────────────────────
  // ★ 这一组刻意收得很窄。判据是**读错方向的代价不对称**：
  //   把"取消"读成"裸单" ⇒ 用户面对一句"不挂保护"的确认，若是顺口答了「确认」，
  //     就下出了一张他不想要、且**没有保护**的单（两错叠加）；
  //   把"裸单"读成"取消" ⇒ 用户只是少了一步、把话重说一遍。
  if (/(取消|撤回|算了|不下了|不买了|不下单了)/.test(t)) return 'cancel'
  // ① 带保护名词的说法（"不要止损"/"不带保护"/"裸单"）—— 与意图层同一份判据
  if (parseProtectionWaiver(t).waived) return 'waive'
  // ② ★ 裸否定词。**只有在这个上下文里才成立**，而这正是本函数只在
  //    `pendingProtectionQuestion` 非空时被调用的原因：
  //    上一轮系统问的就是"要不要带保护"，所以「不要」已经**没有别的所指**。
  //    同一个词在没有待答问题时必须走正常解析 —— 那时它是"取消"（`reject`）。
  if (/^(不要|不用|不带|不需要|不必|不设|否|no|nope)$/i.test(t)) return 'waive'
  return null
}

/** 金额可读化：小数位按大小自适应，避免「0.00000143 美元」这种念不出来的数。 */
function fmtU(x: number): string {
  if (!Number.isFinite(x)) return '—'
  if (Math.abs(x) >= 1000) return x.toFixed(0)
  if (Math.abs(x) >= 1) return x.toFixed(2)
  return x.toFixed(4)
}

/**
 * 仿真/纸面下单：先过**同一道闸门**，再转交 `processOrderIntent`。
 *
 * ★ 为什么是 `async`：闸门（`gateOrderForExecution`）要现取行情快照与账户状态。
 *   它**不能**被先算好缓存起来再同步返回 —— 裁决的时效性就是它的全部意义
 *   （红线 ㉜：裁决过期即失效）。
 */
async function submitOrder(slots: OrderSlots, isClose: boolean): Promise<DispatchOutcome> {
  const s = getOrchState()
  const symbol = slots.symbol
  if (!symbol) return { ok: false, reason: 'VOICE_SYMBOL_REQUIRED（没听出标的）' }
  const mark = markPriceOf(s, symbol)
  // ★ `markPriceOf` 现在返回 `number | null`（`null` = 没有真实报价）。见它的注释：
  //   以前返回 0 会让风控的名义额上限静默失效。这里拒单的理由必须说"拿不到报价"，
  //   而不是让 0 一路走下去。
  if (mark === null || !Number.isFinite(mark) || mark <= 0) {
    return { ok: false, reason: `NO_MARK_PRICE（${symbol} 还没有行情，无法定价）` }
  }

  let qty = slots.qty
  if (qty === undefined) {
    if (slots.notional === undefined) return { ok: false, reason: 'VOICE_AMOUNT_REQUIRED（没听出数量）' }
    qty = slots.notional / mark
  }
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: `INVALID_QTY（${qty}）` }

  const clientOrderId = `V-${randomUUID().slice(0, 12)}`

  // ★★ 保护单：**必须真的挂上去**，不能只念回、只记审计。
  //   2026-09-22 实测确认：这两个字段原先压根没进 `processOrderIntent`
  //   ⇒ 用户说「止盈 10 成 止损 0.1 成」、系统念回「止盈 100% · 止损 1%」、
  //   然后下出一张**没有任何保护的裸单**。保护是**凭据**，凭据不能只写在回话里。
  //   ★ 只在**开仓**时挂：给平仓单挂止盈是语义错误（它下一 tick 就没了）。
  //   ★ 算不出保护就**拒单**，不降级成"先裸着"。这一条是 fail-closed：
  //     宁可这单不成，也不要一张用户以为有保护、实际没有的仓位。
  let protFields: { takeProfit?: number; stopLoss?: number } = {}
  if (!isClose && (slots.takeProfitPct !== undefined || slots.stopLossPct !== undefined)) {
    const built = buildProtection({
      mark,
      side: slots.side === 'buy' ? 'long' : 'short',
      takeProfitPct: slots.takeProfitPct,
      stopLossPct: slots.stopLossPct,
      origin: 'voice',
    })
    if (!built.ok) {
      appendEvent('VOICE_ORDER_REFUSED', { symbol, reason: `PROTECTION_UNBUILDABLE: ${built.reason}`, scope: 'paper' })
      return { ok: false, reason: `PROTECTION_UNBUILDABLE（${built.reason}）` }
    }
    const bp = built.protection
    protFields = {
      ...(bp.takeProfit !== undefined ? { takeProfit: bp.takeProfit } : {}),
      ...(bp.stopLoss !== undefined ? { stopLoss: bp.stopLoss } : {}),
    }
  }

  // ★ 杠杆裁决在这里**再判一次**（第一次在确认回话里）。
  //   两处调的是同一个纯函数，所以不会出现"确认时说 3 倍、这里下 1 倍"。
  //   再判一次的价值在于：确认通道之外的调用方（将来可能有的批量入口）
  //   也拿不到一条绕过裁决的路径 —— 判据 8，一个业务动作一条实现路径。
  const rd = describeContractOrder(slots, mark)
  if (!rd.ok) {
    appendEvent('VOICE_ORDER_REFUSED', {
      symbol,
      requestedLeverage: slots.leverage ?? 1,
      instType: slots.instType ?? 'SPOT',
      reason: rd.reason ?? 'LEVERAGE_REFUSED',
      scope: 'paper',
    })
    return { ok: false, reason: rd.reason ?? 'LEVERAGE_REFUSED' }
  }

  // 语音来源留痕：审计链里必须能区分"人点出来的单"和"嘴说出来的单"，
  // 也必须能区分"现货单"和"125 倍的合约单"——两者的风险不是一个量级。
  appendEvent('VOICE_COMMAND', {
    action: isClose ? 'close_position' : 'open_position',
    symbol,
    side: slots.side,
    qty,
    notionalUsd: Math.round(qty * mark * 100) / 100,
    basis: slots.amountBasis ?? 'notional',
    instType: rd.instType,
    leverage: rd.leverage,
    requestedLeverage: slots.leverage ?? null,
    takeProfitPct: slots.takeProfitPct ?? null,
    stopLossPct: slots.stopLossPct ?? null,
    protectionUnparsed: slots.protectionUnparsed ?? null,
    live: false,
    clientOrderId,
  })

  // ── ★★ 出单前过一次闸门（与交易大厅、与 `/orders` 是同一份裁决）──────────
  //
  // 在这之前，语音这条路**一道闸门都不过**：`describeContractOrder`（杠杆几何）
  // 与 `buildProtection`（保护单）答的都是"这笔单的**形式**对不对"，
  // 而"这笔单**该不该动**"—— 行情结构、成本吃掉多少边际、组合敞口、熔断日亏、
  // 预测依据 —— **一条都没问**。于是同一句话从嘴里说出来能过、从界面上点出来
  // 会被拦，而两条路都宣称自己"走了风控"（判据 8 的典型形态）。
  //
  // ★ 平仓**刻意**不适用开仓闸门：闸门守的是"要不要**新增**一笔风险"，
  //   而平仓是**减**风险，任何时候都该允许。
  //   说清代价：平仓不受敞口/成本检查约束（用户想止损时，这些检查本来也不该拦他）。
  //   但"跳过了"这件事必须留痕，否则事后无法区分"查了通过"与"根本没查"
  //   （判据 C4：报 0 ≠ 没错）。
  if (isClose) {
    appendEvent('VOICE_ORDER_GATE_SKIPPED', {
      symbol,
      clientOrderId,
      reason: 'close_position 是减风险动作，不适用开仓闸门',
      scope: 'paper',
    })
  } else {
    const gate = await gateOrderForExecution(
      {
        symbol,
        side: slots.side,
        notionalUsdt: qty * mark,
        entry: mark,
        // ★ 缺保护传 0（不传 `undefined`）：闸门据此读成"没有保护价"并如实判 `unverifiable`，
        //   而不是替用户编一个。建议价照常回给我们，由人决定要不要照它挂。
        takeProfit: protFields.takeProfit ?? 0,
        stopLoss: protFields.stopLoss ?? 0,
        environment: 'paper',
        markPrice: mark,
        // ★★ 裸单三件套。豁免是**用户显式给的**（见 `OrderSlots.protectionWaived`）：
        //   没给就必须原样报 `false`，闸门那边会如实判"查不了"。
        //   杠杆与形态必须一起给 —— 闸门靠它算强平距离，而"缺杠杆"在那里是**拒**不是放行。
        protectionWaived: slots.protectionWaived === true,
        leverage: rd.leverage,
        instType: rd.instType,
      },
      { source: 'voice' },
    )
    if (!gate.submitAllowed) {
      // ★ 拒绝理由必须**说清是哪一道门**并带上**可照做的数字**（判据 D7）：
      //   只说"被风控拒绝"会把用户引向"那我再说一遍"，而那个动作没有用。
      const reason = `GATE_${gate.verdict.toUpperCase()}：${describeGateRefusal(gate)}`
      appendEvent('VOICE_ORDER_REFUSED', {
        symbol,
        clientOrderId,
        reason,
        scope: 'paper',
        verdict: gate.verdict,
        blockers: gate.blockers.map((b) => b.id),
        pipeline: gate.pipeline,
      })
      return { ok: false, reason, clientOrderId }
    }
  }

  const outcome = processOrderIntent({
    clientOrderId,
    symbol,
    side: slots.side,
    type: 'market',
    qty,
    leverage: rd.leverage,
    instType: rd.instType,
    ...(rd.instType === 'SWAP' ? { settle: slots.settle ?? 'linear' } : {}),
    ...protFields,
  })
  appendEvent('VOICE_ORDER_DISPATCHED', {
    clientOrderId,
    ok: outcome.ok,
    reason: outcome.reason,
    mode: 'paper',
  })
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    detail: outcome.ok ? `订单号 ${outcome.orderId ?? outcome.clientOrderId}。` : undefined,
    clientOrderId,
    orderId: outcome.orderId,
    status: outcome.status,
  }
}

/** 实盘下单：转交 `processLiveIntent`（内含晋升门禁 + 资金帽）。 */
async function submitLiveOrder(slots: OrderSlots, isClose: boolean): Promise<DispatchOutcome> {
  const s = getOrchState()
  const symbol = slots.symbol
  if (!symbol) return { ok: false, reason: 'VOICE_SYMBOL_REQUIRED（没听出标的）' }
  const mark = markPriceOf(s, symbol)
  if (mark === null || !Number.isFinite(mark) || mark <= 0) return { ok: false, reason: `NO_MARK_PRICE（${symbol}）` }

  let qty = slots.qty
  if (qty === undefined) {
    if (slots.notional === undefined) return { ok: false, reason: 'VOICE_AMOUNT_REQUIRED（没听出数量）' }
    qty = slots.notional / mark
  }
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: `INVALID_QTY（${qty}）` }

  const strategyId = slots.strategyId ?? cfg.defaultLiveStrategyId
  if (!strategyId) {
    const reason =
      'VOICE_LIVE_REQUIRES_STRATEGY（实盘语音下单必须携带已过晋升门禁的策略身份，' +
      '请先指定 defaultLiveStrategyId）'
    appendEvent('VOICE_ORDER_REFUSED', { symbol, reason })
    return { ok: false, reason }
  }

  const clientOrderId = `V-${randomUUID().slice(0, 12)}`

  // ── ★★ 实盘的止盈止损：**只能**挂在场所侧，而且只有"能原子附挂"的场所才行 ──
  //
  // ★ 为什么不能挂本地：本地巡检（`core.ts` 的 `enforceProtection`）跑在**这个进程**里。
  //   进程一死、机器一断网、或这段代码被部署成多实例，保护就没了，
  //   而**场所那侧什么都不知道** —— 那张裸仓会一直开着。
  //
  // ★★ 而"挂在场所侧"还分两档，差别是**有没有一段裸窗**：
  //   · 能把条件单**随开仓单同一笔请求**提交（OKX 的 `attachAlgoOrds`）⇒ 可以带保护下；
  //   · 只能"成交之后再另下一张条件单"（币安现货）⇒ **拒**。
  //     那两次网络往返 + 两次撮合之间，仓位是活的、保护是没有的，
  //     而本地账本与场所账本**两边都看起来正常** —— 那正是本项目最忌讳的形态。
  //   ⇒ 判断依据是**适配器自报的能力位**（`supportsVenueProtection`），
  //     不是这里的 if。新增适配器时它必须在编译期回答这个问题。
  //
  // ★ 用户显式放弃保护时**照样放行**（走裸单判据）—— 那是 ⑦ 那条通道，
  //   判它该不该过的是闸门（强平距离够不够远），不是这里。
  const caps = liveGateway.venueCapabilities()
  const liveProtection: { takeProfit?: number; stopLoss?: number } = {}
  if (!isClose && (slots.takeProfitPct !== undefined || slots.stopLossPct !== undefined)) {
    if (slots.protectionWaived === true) {
      // 意图层已经拦过这一种（`VOICE_PROTECTION_CONTRADICTS`），这里是第二道：
      // 只要两个字段同时存在，就说明上游有一条路绕过了那道判断。
      const reason = 'VOICE_PROTECTION_CONTRADICTS（既说不要保护、又给了止盈/止损的数字，我不替你挑一个）'
      appendEvent('VOICE_ORDER_REFUSED', { symbol, reason, scope: 'live' })
      return { ok: false, reason }
    }
    if (!caps.venueProtection) {
      const reason =
        `LIVE_PROTECTION_NEEDS_VENUE_STOP（当前场所 ${caps.adapterName} 不能把止盈止损` +
        `**随开仓单一起**挂上，只能等成交后再另下一张条件单 —— 中间有一段没有保护的真实窗口。` +
        `换一个支持原子附挂的场所（okx-testnet / sandbox），或者改用纸面模式带保护）`
      appendEvent('VOICE_ORDER_REFUSED', { symbol, reason, scope: 'live', adapter: caps.adapterName })
      return { ok: false, reason }
    }
    // ★ 比例 → 绝对价，**方向校验也在这里**（做多时止盈必须在上、止损必须在下）。
    //   复用 `buildProtection` 而不是自己乘一遍：它是"这道保护对着哪个价"的唯一主人。
    const built = buildProtection({
      mark,
      side: slots.side === 'buy' ? 'long' : 'short',
      ...(slots.takeProfitPct === undefined ? {} : { takeProfitPct: slots.takeProfitPct }),
      ...(slots.stopLossPct === undefined ? {} : { stopLossPct: slots.stopLossPct }),
      origin: 'voice-live',
    })
    if (!built.ok) {
      appendEvent('VOICE_ORDER_REFUSED', { symbol, reason: built.reason, scope: 'live' })
      return { ok: false, reason: built.reason }
    }
    if (built.protection.takeProfit !== undefined) liveProtection.takeProfit = built.protection.takeProfit
    if (built.protection.stopLoss !== undefined) liveProtection.stopLoss = built.protection.stopLoss
  }
  if (slots.protectionWaived === true && !isClose) {
    appendEvent('VOICE_PROTECTION_WAIVED', {
      symbol,
      side: slots.side,
      instType: slots.instType ?? 'SPOT',
      leverage: slots.leverage ?? 1,
      matched: slots.protectionWaiverMatched ?? null,
      live: true,
    })
  }

  // 与仿真路径同一道裁决、同一个函数（见上面 submitOrder 的说明）。
  const rd = describeContractOrder(slots, mark)
  if (!rd.ok) {
    appendEvent('VOICE_ORDER_REFUSED', {
      symbol,
      requestedLeverage: slots.leverage ?? 1,
      instType: slots.instType ?? 'SPOT',
      reason: rd.reason ?? 'LEVERAGE_REFUSED',
      scope: 'live',
    })
    return { ok: false, reason: rd.reason ?? 'LEVERAGE_REFUSED' }
  }

  appendEvent('VOICE_COMMAND', {
    action: isClose ? 'close_position' : 'open_position',
    symbol,
    side: slots.side,
    qty,
    notionalUsd: Math.round(qty * mark * 100) / 100,
    instType: rd.instType,
    leverage: rd.leverage,
    requestedLeverage: slots.leverage ?? null,
    takeProfitPct: slots.takeProfitPct ?? null,
    stopLossPct: slots.stopLossPct ?? null,
    live: true,
    strategyId,
    clientOrderId,
  })
  // ── ★★ 实盘开仓同样要过闸门（与纸面同一次调用的同一份结果）──────────────
  //
  // ★★ 2026-09-23 改：这里原先把 `takeProfit`/`stopLoss` **写死成 0** ——
  //   那在"场所侧条件单通道不存在"的世界里是对的（那时实盘必然没有保护，
  //   闸门如实判 `unverifiable` 就是正确行为）。但那条通道现在建好了
  //   （见上面 `caps.venueProtection` 那段），再写死 0 就会造出一种新的缺陷：
  //   **单子上挂了场所侧止损，闸门却被告知"没有保护"** ——
  //   裁决与实际出网的订单不是同一笔（判据 B2 / 红线⑯）。
  //   ⇒ 现在传的是**真正会挂上去的那两个价**（`liveProtection`）。
  //
  // ★ 平仓同样跳过（减风险）。
  if (isClose) {
    appendEvent('VOICE_ORDER_GATE_SKIPPED', {
      symbol,
      clientOrderId,
      reason: 'close_position 是减风险动作，不适用开仓闸门',
      scope: 'live',
    })
  } else {
    const gate = await gateOrderForExecution(
      {
        symbol,
        side: slots.side,
        notionalUsdt: qty * mark,
        entry: mark,
        takeProfit: liveProtection.takeProfit ?? 0,
        stopLoss: liveProtection.stopLoss ?? 0,
        environment: 'live',
        markPrice: mark,
        protectionWaived: slots.protectionWaived === true,
        leverage: rd.leverage,
        instType: rd.instType,
      },
      { source: 'voice' },
    )
    if (!gate.submitAllowed) {
      const reason = `GATE_${gate.verdict.toUpperCase()}：${describeGateRefusal(gate)}`
      appendEvent('VOICE_ORDER_REFUSED', {
        symbol,
        clientOrderId,
        reason,
        scope: 'live',
        verdict: gate.verdict,
        blockers: gate.blockers.map((b) => b.id),
        pipeline: gate.pipeline,
      })
      return { ok: false, reason, clientOrderId }
    }
  }

  const outcome = await processLiveIntent({
    clientOrderId,
    symbol,
    side: slots.side,
    type: 'market',
    qty,
    leverage: rd.leverage,
    instType: rd.instType,
    ...(rd.instType === 'SWAP' ? { settle: slots.settle ?? 'linear' } : {}),
    strategyId,
    // ★★ 这两个价会一路走到适配器的 `attachAlgoOrds`。
    //   闸门刚才是拿**同样这两个价**评的这笔单 —— 裁决与出网必须是同一笔，
    //   这两行就是那句话的落点。
    ...(liveProtection.takeProfit === undefined ? {} : { takeProfit: liveProtection.takeProfit }),
    ...(liveProtection.stopLoss === undefined ? {} : { stopLoss: liveProtection.stopLoss }),
  })
  appendEvent('VOICE_ORDER_DISPATCHED', { clientOrderId, ok: outcome.ok, reason: outcome.reason, mode: 'live', strategyId })
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    detail: outcome.ok ? `柜台单号 ${outcome.orderId ?? ''}。` : undefined,
    clientOrderId,
    orderId: outcome.orderId,
    status: outcome.status,
  }
}

// ───────────────────────── 非危险的查询类 ─────────────────────────

function positionsSpeech(): string {
  const s = getOrchState()
  if (s.positions.size === 0) return '现在没有持仓。'
  const parts: string[] = []
  for (const p of s.positions.values()) {
    const px = markPriceOf(s, p.symbol)
    // ★★ 红线㉟：拿不到现价时**不许退化成 0**。
    //   旧写法 `Number.isFinite(px) ? ... : 0` 有三个后果，全都不像缺陷：
    //   ① 报"浮动 盈利 0.00%" —— 一个"什么都不知道"被说成了"持平"；
    //   ② `markPriceOf` 那时返回的是 0 而不是 null，所以 `Number.isFinite(0)` 为真，
    //      连 `现价 0.00` 都会念出来；
    //   ③ 用户听到的是"行情在、就是价格怪"，而真相是"这个标的根本没有报价"。
    const pnl = px === null || p.avgPrice <= 0 ? null : ((px - p.avgPrice) / p.avgPrice) * 100
    parts.push(
      `${p.symbol} 持有 ${p.qty}，均价 ${p.avgPrice.toFixed(2)}，` +
        (px === null
          ? '现价我这边还没有（缺报价时我不会按 0 折算，所以这次也不报浮动）'
          : `现价 ${px.toFixed(2)}，浮动 ${
              pnl === null ? '算不出' : `${pnl >= 0 ? '盈利' : '亏损'} ${Math.abs(pnl).toFixed(2)}%`
            }`),
    )
  }
  return `现在有 ${s.positions.size} 个持仓：${parts.join('；')}。`
}

function equitySpeech(): string {
  const s = getOrchState()
  const eq = currentEquity(s)
  const pnlPct = s.startingBalance > 0 ? ((eq - s.startingBalance) / s.startingBalance) * 100 : 0
  const ddPct = s.peakEquity > 0 ? ((s.peakEquity - eq) / s.peakEquity) * 100 : 0
  return (
    `账户权益 ${eq.toFixed(2)} 美元，起始 ${s.startingBalance.toFixed(2)}，` +
    `${pnlPct >= 0 ? '盈' : '亏'} ${Math.abs(pnlPct).toFixed(2)}%。` +
    `可用现金 ${s.balanceUSDC.toFixed(2)}，从峰值回撤 ${ddPct.toFixed(2)}%，回撤上限是 ${s.risk.maxDrawdownPct}%。` +
    (s.killswitch ? '注意，熔断现在是开着的。' : '')
  )
}

function ordersSpeech(): string {
  const s = getOrchState()
  const open = s.orders.filter((o) => o.status === 'new' || o.status === 'ack' || o.status === 'partial')
  if (open.length === 0) return '现在没有未成交的挂单。'
  return `有 ${open.length} 笔未成交：${open
    .slice(0, 5)
    .map((o) => `${o.symbol} ${o.side === 'buy' ? '买' : '卖'} ${o.qty}，状态 ${o.status}`)
    .join('；')}。`
}

function riskSpeech(): string {
  const s = getOrchState()
  const rb = riskBriefSnapshot()
  const eq = currentEquity(s)
  const ddPct = s.peakEquity > 0 ? ((s.peakEquity - eq) / s.peakEquity) * 100 : 0
  const recent = s.submitTimestamps.filter((t) => Date.now() - t < 60_000).length
  return (
    `风控额度：单笔名义额上限 ${s.risk.maxNotionalPerOrder} 美元，` +
    `每分钟最多 ${s.risk.maxOrdersPerMinute} 笔（近一分钟已用 ${recent} 笔），` +
    `回撤上限 ${s.risk.maxDrawdownPct}%（当前已用 ${ddPct.toFixed(2)}%）。` +
    `单笔风险额是权益的 ${(rb.riskPerTradeRatio * 100).toFixed(2)}%，盈亏比底线 ${rb.minRiskRewardRatio}，开仓置信度门槛 ${rb.minEntryConfidence}%。`
  )
}

function marketSpeech(symbol: string): string {
  const s = getOrchState()
  if (!symbol) {
    const ks = [...s.lastPrice.keys()]
    if (ks.length === 0) return '还没收到行情。'
    return (
      ks
        .map((k) => {
          const px = markPriceOf(s, k)
          return `${k} 现价 ${px === null ? '—（没有有效报价）' : px.toFixed(2)}`
        })
        .join('；') + '。'
    )
  }
  const px = markPriceOf(s, symbol)
  if (px === null) return `${symbol} 还没有行情数据（我拿不到它的报价，不会编一个数给你）。`
  const regime = getRegime(symbol)
  const regimeNote = regime ? `宏观趋势判断为 ${regime.macroTrend}，1 小时 ATR ${regime.atr1h.toFixed(2)}` : ''
  return `${symbol} 现价 ${px.toFixed(2)}。${regimeNote}`
}

/**
 * 「介绍一下你自己」的回答。
 *
 * ── 为什么这段文案值得单独写、还写得这么具体 ────────────────────────
 * 用户问这句话时，要的不是功能清单，是**"你是个什么东西、我能不能把事交给你"**。
 * 旧实现里没有"介绍"这个词，这句话会一路走到兜底 → 回一句"这句我没听懂"。
 * 一个连自己是谁都说不出来的助手，用户不会把交易交给它。
 *
 * ── 这段是**念出来**的字符串，两条硬约束 ─────────────────────────────
 * ① 不许出现 Markdown 记号（`**` 之类）—— 会被逐字念成"星号星号"。
 * ② 不许出现长破折号与括号夹注 —— TTS 要么跳过要么念出来，都很怪。
 * 所以这里只用「：，。」，且句子都短。
 *
 * ── 内容顺序刻意如此 ────────────────────────────────────────────────
 * 先说身份（我是谁）→ 再说职责（报信 / 回话 / 干活，按"主动到被动"排）
 * → 再说最特别的一条（接目标，先裁定再执行）→ 最后**如实交代边界**
 * （投真钱还没解锁、语音不是新通道）。边界放在最后但仍然在，是因为
 * 一个只说能力不说边界的自我介绍，会让人以为它现在就能动真钱。
 */
function introduceSpeech(): string {
  return (
    '我是你这套交易系统的语音管家，也是它的一个独立智能体。你把我当秘书使唤就行。' +
    '我先说我是谁、再说什么都知道、最后交代边界。' +
    '平时我替你管三件事。' +
    '第一件是报信：成交、被风控拒绝、报警、自动驾驶的状态变化，我会主动开口，不用你问。' +
    '第二件是回话：持仓、权益、挂单、风控额度、行情、今天的日报，你问我就答。' +
    '第三件是干活：下单、平仓、撤单、暂停和继续自动驾驶、熔断，都能办。' +
    '除了账户，我还查得到这台机器本身。' +
    '你可以问我系统实况，我会把自动驾驶、权益、决策大脑的样本质量、心法库、晋级流水线一次报给你。' +
    '可以问我舰队排行，我会告诉你每条候选策略走到了哪一阶段。' +
    '也可以问我进化实验室，那是系统里真正在跑的自进化部件。' +
    '我不只是查，我还能指挥它们干活。' +
    '你直接给我一个目标，比如说，用十美元本金一天之内做到一百美元，' +
    '我会先拿系统自己的尺子量一遍：做不做得到、要打多少笔、第一笔开不开得出来，报给你之后你点头我才启动。' +
    '你说进化一下自己，我就让提案引擎在真实行情上跑一轮因子提案，出来的候选进晋级流水线，' +
    '往后要过过拟合门、纸交易观察、测试网实测，一步一步才可能碰真钱。' +
    '你说记住一条教训，我把它登记成心法，以后每次提案都会带上它。' +
    '有几件事我必须如实交代，不然你会高估我。' +
    '一是系统里没有按策略的盈亏数据，所以我答不出哪个策略最赚钱 —— 界面上舰队那一页的收益数字是演示值。' +
    '二是实验室页面上的谱系树是演示文案，系统里没有这份数据，所以我不念它。' +
    '三是投真钱还没解锁，下单走的是仿真或者测试网。' +
    '四是我的每一个动作走的都是界面上那套风控，语音不是一条新的通道。' +
    '五是改代码这件事我不能自己拍板 —— 我只能提提案、走门禁，真正上线要你来批。' +
    '想听具体怎么说，问「帮助」。'
  )
}

function helpSpeech(): string {
  return (
    '我可以做这些：问持仓、问权益、问挂单、问风控额度、问行情；' +
    '问你我在干什么、下一步干什么；让我读今天的日报；' +
    '让我暂停或者继续自动驾驶；换音色、调播报详略、让我闭嘴或者重复一遍。' +
    '要下单的话直接说，比如「买两百块钱的比特币」，我会先复述一遍让你确认，' +
    '然后走的是跟界面上完全一样的风控。'
  )
}

// ───────────────────────────── 主入口 ─────────────────────────────

/**
 * 处理一句话。
 *
 * 生命周期刻意分成两段：**先算、后提交**。
 * 中间隔着（可能发生的）打断 —— 如果算完直接返回，用户的插话就白插了。
 *
 * 收尾处显式泵一次事件队列，是为了让本轮自己产生的事件（下单、被拒）
 * **立刻**变成播报，而不是等 3 秒后的定时器 —— 用户说完话到听见反馈之间
 * 的这 3 秒，正好是他怀疑"是不是没听见"的时长。
 */
export async function handleUtterance(rawText: string, attachments: readonly RawAttachment[] = []): Promise<VoiceReply> {
  const reply = await handleUtteranceInner(rawText, attachments)
  pumpEvents()
  // ── ★★ 记忆的写入点就在这里（唯一必经点）────────────────────────────
  //
  // 位置是刻意的，三个候选都试过了：
  //   · `finish`（service 内的闭包）—— **不是**唯一出口，`handleConfirm`
  //     有自己的返回构造，落在那里会让"确认那一轮"永不进记忆；
  //   · 各分支里各写一次 —— 十几处，必漏，而漏掉的表现是"偶尔记不住"，
  //     没有任何断言抓得住；
  //   · `session.commitReply` —— 它拿不到标的池（`intentContext` 在 service 层）。
  // 落在唯一必经点上，才能断言"凡是有过一轮对话，就一定进过记忆"。
  try {
    recordMemoryAfterTurn(rawText, reply)
  } catch {
    // ★ 记忆是**旁路**：写不进去绝不能让用户说不出话（与 transcript 同一条纪律）。
    //   但也不许沉默 —— 失败由 `memoryHealth()` / 账本事件带出去。
  }
  return reply
}

/**
 * 合约单没提杠杆时，把"用户以前说过什么"**念出来** —— 但**不改参数**。
 *
 * ══ 为什么不自动套用（这是本模块最容易做错的一处）══════════════════════
 * 记忆里有"他习惯 3 倍杠杆"，于是用户说「买 100 U 的 BTC」时自动补 3 倍 ——
 * 这在代码上只多一行，看起来还"贴心"，但它是**用推断改变了下单参数**：
 *   · 用户没有任何线索能发现自己被"猜"了（他确实没说杠杆）；
 *   · 而猜对猜错的结果差 3 倍名义敞口，且那笔单**完全合法**，
 *     不会有任何一道门报错。
 * 所以这里只做一件事：**告诉他我原本会怎么做、以及他以前是怎么说的**，
 * 让他一句话就能纠回来。参数一个都不动（红线①：记忆不是行动通道）。
 *
 * ★ 判据必须窄：只在**合约单**、且**用户没说杠杆**时才提示。
 *   现货单提示杠杆是纯噪声；用户说了杠杆还提示，等于把他刚说的话
 *   又报成"你没说"（判据 2d：说过的槽位不许被报成没说）。
 */
function leverageMemoryNote(sl: OrderSlots): string {
  if (sl.instType !== 'SWAP') return ''
  if (sl.leverage !== undefined) return ''
  const pref = factByKey('leverage')
  if (!pref || typeof pref.value !== 'number') return ''
  return `（你以前说过${pref.text}。这一笔没说杠杆，我按 1 倍算 —— 要用 ${pref.value} 倍就说一声。）`
}

/**
 * 一轮对话结束后更新记忆。
 *
 * ★ 三件事的输入**只有 `text`（用户原话）与 `reply`（系统回了什么）**，
 *   而且只有第 ① 件会用到 `reply`（记"这一轮发生过"）。
 *   ②③ 只吃 `text` —— 从**系统自己的回话**里抽事实，会把系统的措辞
 *   记成"用户说过的话"，而用户从未说过（判据 C3：来源必须是真的）。
 */
function recordMemoryAfterTurn(text: string, reply: VoiceReply): void {
  const now = Date.now()
  const sid = sessionId()

  // ── ① 工作记忆：这一轮说的是哪个标的（供下一次指代消解）──────────────
  // ★ 用 `resolveSymbol` 现算而**不是**从 `reply.slots` 读：后者要求给
  //   `VoiceReply` 加一个只给记忆用的字段，而那个字段会随着每个分支的
  //   构造方式不同而有时有、有时没有（`handleConfirm` 那条路就不带 slots）。
  const ctx = intentContext()
  const sym = resolveSymbol(text, ctx.symbols, ctx.referTo)
  noteTurn({
    turnId: reply.turnId,
    at: now,
    user: text.slice(0, 200),
    assistant: reply.reply.slice(0, 200),
    symbols: sym === null ? [] : [sym],
    intent: reply.intent,
  })

  // ── ② 长期事实（判据只一份：`extractFacts`）──────────────────────────
  for (const f of extractFacts(text)) {
    const r = remember({
      kind: f.kind,
      key: f.key,
      text: f.text,
      value: f.value,
      source: { sid, turnId: reply.turnId, at: now, confidence: f.confidence },
    })
    if (r.ok) {
      appendEvent('VOICE_MEMORY_REMEMBERED', {
        key: f.key,
        kind: f.kind,
        value: f.value,
        superseded: r.supersededId,
        // ★ 出处必须进账本：事后要能回答"这条偏好是从哪一轮来的"。
        //   只记 key 的话，查证时只能知道"记过"，不知道"凭什么记的"。
        fromTurn: reply.turnId,
      })
    } else if (r.reason === 'budget-exceeded') {
      // ★★ 超限**不许静默淘汰**（学 Hermes）：记不下了要说出来，并附上现状。
      //   不落这条事件的后果很具体：用户说过一句要紧的话而系统没记住，
      //   事后查账本与"他从来没说过"长得一模一样。
      appendEvent('VOICE_MEMORY_FULL', {
        key: f.key,
        kind: f.kind,
        neededTokens: r.neededTokens,
        budgetTokens: r.budgetTokens,
        currentIds: r.current.map((x) => x.id),
      })
    } else {
      appendEvent('VOICE_MEMORY_WRITE_FAILED', { key: f.key, error: r.error })
    }
  }

  // ── ③ 纠正：用户说"你记错了" ────────────────────────────────────────
  const corr = detectCorrection(text)
  if (!corr) return
  if (corr.key === null) {
    // ★ 推不出针对哪一条 ⇒ **不动库**，只留痕。
    //   猜一个 key 去删是最坏的一种处置：用户只说了"你记错了"，
    //   系统却抹掉了一条他根本没提的偏好，而且**不会报错**。
    appendEvent('VOICE_MEMORY_CORRECTION_UNCLEAR', { raw: corr.raw.slice(0, 120) })
    return
  }
  // 找出那条事实（kind 不定，按语义键后缀匹配 —— 与 `factIdOf` 的拼接规则一致）
  const victim = currentFacts().find((x) => x.id.endsWith(':' + corr.key))
  if (!victim) {
    // ★ 「纠正了一条不存在的事实」也要落账：它说明抽取层曾经漏过，
    //   或者用户记错了自己说过什么。两种情形指向不同的动作，不能合并。
    appendEvent('VOICE_MEMORY_CORRECTION_NO_SUCH', { key: corr.key, raw: corr.raw.slice(0, 120) })
    return
  }
  forget(victim.id, { sid, turnId: reply.turnId, at: now })
  appendEvent('VOICE_MEMORY_FORGOTTEN', {
    key: corr.key,
    id: victim.id,
    reason: 'user-said-wrong',
    rejected: corr.rejected,
    corrected: corr.corrected,
    raw: corr.raw.slice(0, 120),
  })
}

async function handleUtteranceInner(rawText: string, attachments: readonly RawAttachment[] = []): Promise<VoiceReply> {
  const text = rawText.trim()
  // 附件只把**元信息**带进会话记录（名字 / 类型 / 字节数）：聊天记录是给人查
  // "我当时贴了什么"的，不是第二份附件库 —— 图片正文进记录会把这份文件撑爆。
  const turn = beginTurn(
    text,
    attachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType ?? '未知',
      bytes: Buffer.byteLength(a.dataBase64, 'base64'),
    })),
  )
  const gen = currentGeneration()
  // 附件在**意图解析之前**先受理：因为"只给了图没打字"是一种合法输入，
  // 而它必须能落到问模型那条路上，不能被当成"空话"直接丢掉。
  const batch = attachments.length > 0 ? digestAttachments(attachments) : null

  const ctx = intentContext()
  // ★ `let`：上一句问过"要不要带保护"时，这句回答会被折回成一笔 `place_order`
  //   （见下面那段），所以它必须可重新赋值。
  let parsed = parseIntent(text, ctx)
  // 意图补记进本轮（`beginTurn` 时还不知道）—— 它同时供聊天记录与面板显示。
  setTurnMeta(turn.turnId, { intent: parsed.intent })
  const base = {
    turnId: turn.turnId,
    intent: parsed.intent,
    intentLabel: INTENT_LABEL[parsed.intent],
    confidence: parsed.confidence,
    narration: [] as NarrationLine[],
  }

  const finish = (reply: string, extra?: Partial<VoiceReply>): VoiceReply => {
    /**
     * ★★ 指代消解**必须声明**（判据 D7）。
     *
     * 它是系统替用户补上了一个他**没说**的标的 —— 不声明就等于"猜"，
     * 而猜错的代价在下单场景是真实的钱（用户说「平掉它」，
     * 系统消解成了另一个持仓）。声明之后他才有机会说"不是那个"。
     *
     * ★ 加在 `finish` 里而不是各分支里：这是**唯一的措辞出口**，
     *   而各分支有十几处 —— 漏掉的那一处只是"偶尔不说"，没有任何断言抓得住。
     * ★ `extra?.intent === undefined` 这个条件挡的是"分支把意图改写掉了"：
     *   那时 `parsed.resolvedByReference` 说的已经不是本轮真正发生的事了
     *   （典型：兜底把它改成 `ask_model`）。不挡的话会念出一句
     *   与系统实际做的事对不上的前提（判据 18）。
     */
    const notes: string[] = []
    if (parsed.resolvedByReference === true && extra?.intent === undefined) {
      notes.push(`（这句里的"它"，我按你上一句提到的 ${parsed.slots?.symbol ?? '那个标的'} 理解。）`)
    }
    if (parsed.slots !== undefined) {
      const n = leverageMemoryNote(parsed.slots)
      if (n) notes.push(n)
    }
    const shown = notes.length > 0 ? notes.join('') + reply : reply
    const r: VoiceReply = { ...base, dropped: false, reply: shown, pending: getPending(), ...extra }
    // ★ 落盘的正文用 `shown`：聊天记录回答的是"桌宠当时**念了什么**"，
    //   而不是"我们打算念什么"。两者不一致时，用户回看会发现记录里少了一句
    //   他明明听到过的话（判据 C3：记录必须与事实一致）。
    if (!commitReply(turn.turnId, shown, gen)) r.dropped = true
    return r
  }

  // ── ★★ 先答上一个问题：这笔单要不要带保护 ─────────────────────────────
  //
  // ★ 为什么必须排在 `confirm` / `reject` **之前**："不要"这两个字，
  //   既可能是对"要不要保护"的回答，也可能是"这笔单不做了"。
  //   分开它们靠的不是猜语义，而是**上一轮系统问的到底是哪一句**：
  //   只有刚问过保护那件事，才存在这个歧义；没问过时这两个字照旧走 `reject`。
  //
  // ★ 回答折回去之后走的仍然是**同一条** `place_order` 路径 ——
  //   同一次 `createPending` 确认、同一道闸门、同一份 `VOICE_COMMAND` 留痕。
  //   这里**不许**另起一条"裸单专用下单分支"（红线㉙：同一个业务动作只许有一条规矩）。
  if (pendingProtectionQuestion) {
    const q = pendingProtectionQuestion
    const answer = readProtectionQuestionAnswer(text)
    if (answer !== null && Date.now() - q.at <= PROTECTION_QUESTION_TTL_MS) {
      pendingProtectionQuestion = null
      // 豁免的唯一来源就是这句话 ⇒ 必须落账，且带上是哪笔单、隔了多久。
      appendEvent('VOICE_PROTECTION_ANSWERED', {
        answer,
        symbol: q.slots.symbol,
        side: q.slots.side,
        ageMs: Date.now() - q.at,
      })
      if (answer === 'cancel') {
        clearPending()
        return finish('好，那这笔单不下了。')
      }
      parsed = {
        ...parsed,
        intent: 'place_order',
        slots: { ...q.slots, protectionWaived: true, protectionWaiverMatched: text.trim() },
        confidence: 1,
        matched: text.trim(),
      }
      setTurnMeta(turn.turnId, { intent: parsed.intent })
      base.intent = parsed.intent
      base.intentLabel = INTENT_LABEL[parsed.intent]
      base.confidence = parsed.confidence
    } else if (Date.now() - q.at > PROTECTION_QUESTION_TTL_MS) {
      // 过期就不再认那句回答；但要**说出来**，否则用户以为系统在装没听见。
      pendingProtectionQuestion = null
      appendEvent('VOICE_PROTECTION_QUESTION_EXPIRED', { symbol: q.slots.symbol, ageMs: Date.now() - q.at })
    }
  }

  // ── 确认 / 取消 ──
  if (parsed.intent === 'confirm') return await handleConfirm(text, turn.turnId, gen)
  if (parsed.intent === 'reject') {
    const had = getPending() !== null
    clearPending()
    // ★ 待确认被取消时，"我在等你回答的那笔单"也跟着作废 ——
    //   否则用户取消之后说一句"不要"，会被拿去回答一个已经过期的上下文。
    pendingProtectionQuestion = null
    return finish(had ? '好的，这笔取消了。' : '当前没有等你确认的操作。')
  }

  // ── 会话控制 ──
  if (parsed.intent === 'stop_talking') {
    setVoiceConfig({ muted: true })
    return finish('好，我不出声了。有报警我还是会说的 —— 这个不能关。想让我开口说「恢复播报」。')
  }
  if (parsed.intent === 'repeat') {
    const last = recentNarrations(1)[0]
    return finish(last ? `我再说一遍：${last.text}` : '刚才没说什么。')
  }
  if (parsed.intent === 'switch_voice') {
    const v = parsed.voiceId ? getVoice(parsed.voiceId) : null
    if (!v) return finish('没听出你想换哪个音色。可选的有：' + spokenVoiceList())
    setVoiceConfig({ voiceId: v.id, muted: v.id === 'silent' ? true : cfg.muted })
    appendEvent('VOICE_SWITCHED', { voiceId: v.id, label: v.label })
    return finish(`换好了，现在是${v.label}。${v.note}`)
  }
  if (parsed.intent === 'set_verbosity') {
    const v = parsed.verbosity ?? 'normal'
    setVoiceConfig({ verbosity: v, muted: false })
    const desc = v === 'alarm-only' ? '只说报警' : v === 'chatty' ? '全都说' : '报警加重要事件'
    return finish(`好，播报档位调成「${desc}」。`)
  }
  if (parsed.intent === 'introduce') return finish(introduceSpeech())
  if (parsed.intent === 'help') return finish(helpSpeech())

  // ── 处置"要按一颗界面按钮"的**唯一一份实现**（严格档与宽档共用）───────
  //
  // ★ 为什么必须是闭包里的**一份**：它要用 `finish`（本轮的回话出口），
  //   而 `finish` 是 `handleUtteranceInner` 的局部闭包。两档各写一份的话，
  //   同一颗按钮会在两种说法下给出**不同的下一步动作** ——
  //   而那正是"同一件事两条实现路径"（判据 8），且两条都看着合理。
  //
  // ★ 四态里 `weak` 的处理**由调用方决定**（这是两档唯一的差别）：
  //   · 严格档（站在只读问答之前）**放弃** —— 用"你是不是想说"顶掉一条
  //     本来答得上来的只读回答，是拿一次答非所问换一次反问，不划算；
  //   · 宽档（站在兜底之前）**列候选问一句** —— 它后面就是模型兜底了，问一句更好。
  const handleUiResolution = (
    ui: UiResolution | null,
    opts: { allowWeak: boolean },
  ): VoiceReply | null => {
    if (!ui) return null
    if (ui.kind === 'action') {
      const prep = prepareUiClick(ui.spec, turn.turnId)
      return finish(prep.speech, {
        pending: prep.pending,
        intent: 'ui_action',
        intentLabel: INTENT_LABEL.ui_action,
      })
    }
    if (ui.kind === 'human') {
      // ★ 这一档的下一步动作与 `owned` **相反**：不是"去找舰队"，而是
      //   "把完整指令告诉我 / 你自己在面板上点"。压成一档就会给出错误指引。
      return finish(
        `「${ui.spec.label}」这颗按钮我不代按 —— 它提交的是面板里现在填着的那份内容，而我看不见你填了什么。` +
          '盲按一次的结局不是"什么都没发生"，是拿上面残留的内容真提交一笔，然后我还会跟你说"已按下"。' +
          '你要下单，直接把品种、方向、金额说全（比如「买入 BTC 一百 U」），我走下单那条路 —— 那条路会复述金额、过风控、留痕。',
        { intent: 'ui_action', intentLabel: INTENT_LABEL.ui_action },
      )
    }
    if (ui.kind === 'owned') {
      const plan = FLEET_TASK_PLANS.find((x) => x.id === ui.plan)
      if (!plan) {
        return finish(
          `「${ui.spec.label}」归舰队计划「${ui.plan}」管，但我现在找不到那条计划 —— 这是接线断了，请查账本。`,
          { intent: 'ui_action', intentLabel: INTENT_LABEL.ui_action },
        )
      }
      return finish(
        '这件事的主人是舰队计划，不是那颗按钮 —— 所以我不点它（点了会和计划链一起跑，两次都成功、看日志也发现不了）。' +
          `按「${plan.label}」来，上手的是 ${planCast(plan)}。` +
          `你直接把这件事说一遍（比如「${plan.label}」）我就整条跑起来 —— ` +
          (plan.undoPlan ? '它能原样退回去，所以我不会再问你第二遍。' : '它会改系统状态，所以我会先问你一句。'),
        { intent: 'ui_action', intentLabel: INTENT_LABEL.ui_action },
      )
    }
    if (!opts.allowWeak) return null
    return finish(weakCandidatesSpeech(ui.candidates), {
      intent: 'ui_action',
      intentLabel: INTENT_LABEL.ui_action,
    })
  }

  // ── 用户**明说"按 / 点 / 跑一次"**时，界面按钮通道有权先挑 ────────────────
  //
  // ★ 为什么排在这里（只读问答之前）：端到端实测抓出来的 ——
  //   「风控中心页跑一次沙盒演练」里的「风控」被 `query_risk` 接走，
  //   「Agent 舰队页按一下这计划能接吗」被 `ask_agents` 接走。
  //   两句都是**用户要按按钮、却收到一份状态汇报**，而两条路在账本里都写着"成功"。
  //   "按一下"是比"提到某个领域"强得多的信号，所以它有权先挑。
  //
  // ★ 为什么不是排在最前面：动作词表里含「跑一次」，而下单也可能说
  //   「按一下买入」—— 所以危险意图必须先被排除在外。
  //
  // ★ 这条护栏刻意用 `isDangerous` 而不是靠"排在订单后面"：
  //   只读问答本身就排在订单处理之前，所以"既在只读前、又在订单后"在结构上不可能。
  //   靠位置就保不住的事，只能靠**紧邻的否定条件**保 ——
  //   而它同时是可断言的（见 voice-smoke 的 S15）。
  if (!isDangerous(parsed.intent)) {
    const pressed = handleUiResolution(resolveExplicitPress(text), { allowWeak: false })
    if (pressed) return pressed
  }

  // ── 关于「系统本身」的只读问答（管家是独立智能体，不只是账户播报器）──────
  //
  // 三条共用同一个形状：**跑一次只读工具 → 落一条账 → 把过程当播报说出来 → 回话**。
  //
  // ★ 为什么要落账：用户听到的每个结论都必须能在审计链里找到出处，
  //   否则"秘书自己编了个状态"这类失效无法被发现（与播报溯源同一条理由）。
  //
  // ★ 为什么要播报过程："实时报告工作进度"在一次只读问答里没有异步可报
  //   （耗时是毫秒级，硬造一个进度条就是表演）。但"我查了哪几处"是**真实发生的事**，
  //   说出来有两个实际作用：用户知道我不是瞎猜；出问题时他知道该去哪一处核。
  //   真正需要异步进度的场景是下面的 act 工具（跑提案要几十秒），那里会先报"开始跑"。
  /**
   * 跑一个只读工具：**落账 + 播报过程**，然后把结果交回来。
   *
   * ★ 为什么把它从 `readTool` 里拆出来：走势预测那一条要在拿到结果**之后**
   *   再做一件与结果有关的事（把"算的是哪个标的、未来多久"排给界面去画图）。
   *   留在 `readTool` 里就得把 `finish` 的返回值再拆开，或者把那段逻辑
   *   抄一遍 —— 抄一遍就是"落账 + 播报"有了两个主人（判据 8）。
   */
  const runTool = async (
    toolId: string,
    eventKind: string,
    arg?: string,
  ): Promise<{ r: VoiceToolResult; seq: number } | null> => {
    const tool = getTool(toolId)
    if (!tool) return null
    const r = await tool.run(arg)
    const ev = appendEvent(eventKind, {
      tool: toolId,
      ok: r.ok,
      // 把"复用哪条既有路径"一起落账：事后可以核对这个结论是**从哪读出来的**，
      // 而不是只能相信一句自然语言。
      reuses: tool.reuses,
      steps: r.steps,
    })
    for (const step of r.steps) {
      announce({ text: step, category: 'work-state', priority: 'P2_STATUS', seq: ev.seq, kind: eventKind })
    }
    return { r, seq: ev.seq }
  }

  const readTool = async (toolId: string, eventKind: string, arg?: string): Promise<VoiceReply> => {
    const out = await runTool(toolId, eventKind, arg)
    if (out === null) {
      return finish('这个能力我还没接上 —— 这是异常，请查账本。')
    }
    return finish(out.r.speech, {
      detail: JSON.stringify({ tool: toolId, reuses: getTool(toolId)?.reuses, steps: out.r.steps }),
    })
  }

  if (parsed.intent === 'ask_system') return await readTool('situation', 'VOICE_ASK_SYSTEM')
  if (parsed.intent === 'ask_fleet') return await readTool('fleet', 'VOICE_ASK_FLEET')
  if (parsed.intent === 'ask_lab') return await readTool('lab', 'VOICE_ASK_LAB')
  // Agent 舰队**成员**状态（与 `ask_fleet` 的"策略排行"是两件事，见 intents.ts 的注释）
  if (parsed.intent === 'ask_agents') return await readTool('agent_fleet', 'VOICE_ASK_AGENTS')
  // 联网查。慢（要真出网 + 一次模型总结），所以先播报"开始了" ——
  // 不先出声的话用户面对的是十几秒沉默，而他无法区分"在查"和"没听见"。
  if (parsed.intent === 'web_lookup') {
    const q = (parsed.webQuery ?? '').trim()
    const started = appendEvent('VOICE_LOOKUP_STARTED', { query: q })
    announce({
      text: `开始联网查「${q}」。这一步要十几秒。`,
      category: 'work-state',
      priority: 'P2_STATUS',
      seq: started.seq,
      kind: 'VOICE_LOOKUP_STARTED',
      dedupeKey: `lookup-start:${started.seq}`,
    })
    return await readTool('web_lookup', 'VOICE_LOOKUP_WEB', q)
  }

  // ── 走势预测（只读，但**慢**：实测冷缓存一次 6.4 秒）──────────────────
  //
  // ★ 为什么先出声再算：6 秒的沉默里用户分不清"在算"和"没听见"。
  //   与 `web_lookup` 是同一条理由（那里十几秒）。这不是表演进度条 ——
  //   它报的是**真实发生的事**（要去历史上找相似时刻、还要做样本外校准）。
  //
  // ★ 为什么没指名标的就**问一句**而不是默认 BTCUSDT：默认的后果是把
  //   "以太坊的预测"当成"比特币的预测"讲出来，而那句话在字面上完全说得通。
  //   本仓库的纪律是缺槽位就显式失败（见 `numerals.ts` 的 `resolveAmount`），
  //   这里照同一条办。
  //
  // ★ 它排在只读问答组里、`query_market` 之前由**意图层**保证（见 `intents.ts`
  //   的那段长注释）。服务层这里只负责"算出来、说清楚、留痕"。
  if (parsed.intent === 'query_forecast') {
    const sym = (parsed.forecastSymbol ?? '').trim()
    if (!sym) {
      return finish('你要我预测哪个标的？说「预测一下比特币未来一小时」这样，我就把方向和价位一起报给你。')
    }
    const mins = parsed.horizonMinutes ?? 60
    const started = appendEvent('VOICE_FORECAST_STARTED', { symbol: sym, horizonMinutes: mins })
    announce({
      text: `开始算 ${sym} 未来 ${mins} 分钟的走势。这一步要在历史上找相似的时刻，再拿样本外数据校准一遍，大概几秒。`,
      category: 'work-state',
      priority: 'P2_STATUS',
      seq: started.seq,
      kind: 'VOICE_FORECAST_STARTED',
      dedupeKey: `forecast-start:${started.seq}`,
    })
    const out = await runTool('forecast', 'VOICE_FORECAST', JSON.stringify({ symbol: sym, horizonMinutes: mins }))
    if (out === null) return finish('这个能力我还没接上 —— 这是异常，请查账本。')
    const r = out.r
    // ── 「说得出来就调得出来」：把图**真的**排到界面上 ────────────────────
    //
    // ★★ 参数必须取**工具回给的那一份**（`r.detail`），不是用户原话里解析出来的
    //   那一份。两者的差别在"归一"：用户说「未来半小时」，预测层只有 15 分钟
    //   一根的历史 ⇒ 实际按 30 分钟算；而用户说「未来 5 分钟」会被并到 15 分钟。
    //   我要是把原话的分钟数排给界面，图上画的就是**另一个时长**，
    //   而两个数各自都算得对（判据 31，见 `_mutate_ui.mjs` 的 M20）。
    const d = (r.detail ?? {}) as { symbol?: unknown; horizonMinutes?: unknown }
    const uiSymbol = typeof d.symbol === 'string' && d.symbol ? d.symbol : sym
    const uiMinutes = typeof d.horizonMinutes === 'number' && d.horizonMinutes > 0 ? d.horizonMinutes : mins
    const enq = r.ok
      ? enqueueUiAction(uiWorkspaceRoot(), 'terminal.forecast.run', {
          requestedBy: 'voice',
          payload: { symbol: uiSymbol, minutes: uiMinutes },
        })
      : null
    // ★ 只说"排上了"是不够的（判据 10：有端点 ≠ 有人读）。要等**某个窗口真的
    //   领走并回报**，然后按回报的三态说三种话 —— 它们指向的动作完全不同：
    //     done    → 图已经在屏幕上，一起看
    //     pending → 界面没开着（去开终端页）
    //     failed  → 通道或按钮有问题（去看那一句 detail）
    //   全说成"调出来了"的后果：屏幕一片安静，而它账本里确实排过一条 ——
    //   看起来完全正常（用户实测原话就是"它说可以做到，但界面没动"）。
    const ack = enq && enq.ok ? waitForUiAck(uiWorkspaceRoot(), enq.task.id) : null
    const chartLine = (() => {
      if (!enq) return ''
      if (!enq.ok) return `顺带一句：我没能把图排到界面上 —— ${enq.speech}`
      if (ack === null) return ''
      if (ack.state === 'done') {
        return `图已经在你屏幕上的交易终端里调出来了（${uiSymbol} · 未来 ${uiMinutes} 分钟），你可以照着它看。`
      }
      if (ack.state === 'failed') {
        return `我把调图排上了，但界面回报说没成功：${ack.detail || '没有给出原因'}。`
      }
      if (ack.state === 'unknown') {
        return `我把调图排上了，但读队列时出了问题（${ack.reason}）—— 所以我不能说图已经出来了。`
      }
      return '图我排上了，但没有窗口来领 —— 交易终端那一页现在没开着吧？你打开它，我再排一次就画得出来了。'
    })()
    return finish(r.speech + (chartLine ? ` ${chartLine}` : ''), {
      detail: JSON.stringify({
        tool: 'forecast',
        reuses: getTool('forecast')?.reuses,
        steps: r.steps,
        chart: { actionId: 'terminal.forecast.run', symbol: uiSymbol, minutes: uiMinutes, enqueued: enq?.ok === true, ack: ack?.state ?? null },
      }),
    })
  }

  // ── 查询类 ──
  if (parsed.intent === 'query_position') return finish(positionsSpeech())
  if (parsed.intent === 'query_equity') return finish(equitySpeech())
  if (parsed.intent === 'query_orders') return finish(ordersSpeech())
  if (parsed.intent === 'query_risk') return finish(riskSpeech())
  if (parsed.intent === 'query_market') return finish(marketSpeech(parsed.slots?.symbol ?? ''))
  if (parsed.intent === 'query_status') return finish(renderStatusNow())
  if (parsed.intent === 'query_daily_report') {
    const b = dailyBrief()
    appendEvent('VOICE_DAILY_REPORT', { partialDay: b.partialDay, equity: b.equity, pnlPct: b.pnlPct })
    return finish(b.narration, { detail: JSON.stringify(b) })
  }

  // ── 暂停 / 继续（可逆，不走复述；但仍进账本）──
  if (parsed.intent === 'pause') {
    stopAutopilot('VOICE_COMMAND')
    appendEvent('VOICE_PAUSE', {})
    return finish('已经把自动驾驶停了，先不交易。')
  }
  if (parsed.intent === 'resume') {
    const r = await startAutopilot(placeholderTargetPct())
    appendEvent('VOICE_RESUME', { ok: r.ok, reason: r.reason })
    return finish(r.ok ? '自动驾驶已重新开始。' : `启动没成功：${r.reason ?? '未知原因'}。`)
  }

  if (parsed.intent === 'cancel_order') {
    if (!parsed.orderId) return finish('要撤哪一笔？请说「撤单，单号 xxx」。')
    const ok = cancelOrder(parsed.orderId)
    appendEvent('VOICE_CANCEL_ORDER', { clientOrderId: parsed.orderId, ok })
    return finish(ok ? `已撤销 ${parsed.orderId}。` : `没找到这笔单：${parsed.orderId}。`)
  }

  // ── 接目标（任务裁定）────────────────────────────────────────────────
  //
  // ★ 为什么它必须排在 `isDangerous` 那块**之前**：
  // `start_mission` 在 DANGEROUS 名单里（它启动的是会自己反复下单的循环），
  // 而那块通用的处理会去 `createPending(...)` 要一个**金额**。任务没有金额 ——
  // 它的口径是目标百分比。用一个"复述金额"的口令来顶"启动许可"，
  // 界面上会把 50% 显示成 50 美元，用户按字面理解为"投入 50 美元"。
  // 所以这里只**裁定并回话**，不构造确认凭证；启动由 /mission/start 触发。
  if (parsed.intent === 'start_mission') {
    const r = planMission(text, missionGoalContext(), parsed.mission)
    if (!r.isMission || !r.plan) {
      // 意图层判"是任务"、裁定层判"不是" —— 两处口径不一致时如实说，
      // 不猜（猜的代价是给用户一个错误的裁定结论）。
      return finish(
        '这句像是个目标，但我没解析出本金和目标金额。可以说「用 10 美元本金，一天内做到 100 美元」这样。',
      )
    }
    const plan = r.plan
    const detail = JSON.stringify({
      planId: plan.planId,
      verdict: plan.verdict,
      targetMultiple: plan.targetMultiple,
      targetPct: plan.targetPct,
      required: plan.required,
      sizing: plan.sizing,
      reasons: plan.reasons,
      alternative: plan.alternative,
      redactionHits: r.redaction.hits,
      // 只记"有没有签发口令"，**绝不记口令码**：口播里已经念过它（那是必须的），
      // 而转写记录是最容易被导出、被贴进聊天窗口的东西。
      consentArmed: r.consent !== null,
    })
    if (plan.verdict === 'feasible') {
      // ★ 这里**不再**说"语音直接启动我还没接"。
      // 上一轮的实现把启动留给面板，理由是"启动许可需要一个不会被认错的口令" ——
      // 那条理由现在已经被满足（见 `mission/consent.ts`）。
      // 留着那句旧话会变成一句**关于系统的假陈述**：用户听完去面板上找，
      // 而口令码只在这次口播和这一次 plan 响应里存在过。
      return finish(r.spoken + '这份裁定编号 ' + plan.planId.slice(0, 10) + '，已经记进账本。', { detail })
    }
    return finish(r.spoken, { detail })
  }

  // ── 启动口令（真的把循环起起来）──────────────────────────────────────
  //
  // 与上面「接目标」分成两条路径，是因为**后果不同**：
  // 接目标只产出一份结论（无副作用），这一条会启动一个会自己反复下单的循环。
  // 合成一条的后果是：一次误识别 = 一次长期授权。
  //
  // ★ 它也排在 `isDangerous` 那块**之前**，理由与「接目标」同源：
  //   通用危险处理会去 `createPending(...)` 要一个**金额**，
  //   而启动口令里那个四位数**不是金额**。交给它处理，用户会收到
  //   "请复述金额 4821" 这种指令 —— 那串数字的真实含义是"本次批准"，
  //   复述它并不构成对任何金额的批准，两边的理解完全不同。
  if (parsed.intent === 'confirm_mission_start') {
    const r = await startMissionByPlan({ phrase: text, code: text }, missionGoalContext())
    appendEvent('VOICE_MISSION_START', {
      ok: r.ok,
      code: r.code ?? null,
      planId: r.plan?.planId ?? null,
      remainingAttempts: r.remainingAttempts ?? null,
    })
    if (r.ok) {
      const pct = r.plan?.targetPct ?? 0
      return finish(
        '已启动。目标 +' + pct + '%，执行线已经占住。' +
          '接下来每笔成交和每次门禁拒绝我都会报告。',
        { detail: JSON.stringify({ planId: r.plan?.planId ?? null, targetPct: pct, started: true }) },
      )
    }
    return finish(r.reason ?? '启动没通过，但我也说不出为什么 —— 这是异常，请查账本。', {
      detail: JSON.stringify({ code: r.code ?? null, remainingAttempts: r.remainingAttempts ?? null }),
    })
  }

  // ── 自我进化 / 登记心法：两个"改变系统将来行为"的动作 ──────────────────
  //
  // ★ 为什么必须自己构造待确认、而不是交给下面那块通用危险处理：
  //   通用处理会去 `createPending` 要一个**金额**（它服务的是下单/平仓），
  //   而这两个动作的副作用不是一笔交易 —— 交给它，确认回话就变成
  //   "确认要 自我进化 吗"，用户复核的是一个没有含义的字符串。
  //
  // ★ 但它**不是第二条确认通道**：同一个 `createPending`、同一个 `confirmPending`、
  //   同一个 `dispatchDangerous` 出口。这里只是把"要复述什么"换成了正确的东西。
  //
  // ★ 也不在这里执行 —— 与 `start_mission` 同一条纪律：
  //   听懂一个诉求（无副作用）与批准它（有副作用）必须分成两轮，
  //   否则一次误识别就等于一次长期授权。
  if (parsed.intent === 'self_upgrade' || parsed.intent === 'record_lesson') {
    const isLesson = parsed.intent === 'record_lesson'
    const lessonText = (parsed.lessonText ?? '').trim()

    let ask: string
    if (isLesson) {
      if (lessonText.length < 4) {
        return finish('这句太短了，我没听清要记什么。请说「记住：不要在流动性差的时候加仓」这样。')
      }
      // 类别判不出来就**现在拒**，不等确认之后 ——
      // 让用户确认一件注定失败的事，比直接说不更像耍人。
      // 也绝不猜一个类别：写错类别的心法会被回灌进每次提案的上下文，是长期污染面。
      const { category, label } = inferLessonCategory(lessonText)
      if (!category) {
        return finish(
          `「${lessonText}」我没听出属于哪一类，所以我不猜。合法类别有六种：` +
            '趋势跟随、风控、胜率锁定、组合分散、执行质量、市况适应。' +
            '你在话里带上这类词就行，比如提到止损回撤我归风控，提到滑点成本我归执行质量。',
        )
      }
      ask = `我准备把这条登记成心法：${lessonText}。归类是「${label}」，类别是我按词判的，你确认之前可以纠正。`
    } else {
      ask =
        '我准备让提案引擎在真实行情上跑一轮因子提案，出来的候选会进晋级流水线。' +
        '这一步会调用大模型、可能要几十秒，但不会动钱。'
    }

    const p = createPending(
      parsed.intent,
      isLesson ? `登记心法：${lessonText.slice(0, 30)}` : '跑一轮因子提案',
      { side: 'buy', symbol: '' },
      0,
      turn.turnId,
      isLesson ? lessonText : undefined,
    )
    appendEvent('VOICE_CONFIRM_REQUESTED', {
      action: p.action,
      intent: parsed.intent,
      expectedNotional: 0,
      hasContentArg: isLesson,
    })
    return finish(`${ask}确认吗？说「确认」我就执行。这次不用复述数字，因为它不涉及金额。`, { pending: p })
  }

  // ── 派舰队干活（一句话 → 一串真实动作）────────────────────────────────
  //
  // ★ 这一条治的是用户实测反馈的原话：「连一键启动自治循环都启动不了，
  //   扩候选基因空间和换因子族等都听不懂」。
  //
  // ★ 排在 `isDangerous` 之前，理由与 `self_upgrade` 同源：通用危险处理会去
  //   `createPending(...)` 要一个**金额**，而这件事没有金额。交给它处理，
  //   确认回话会变成"请复述金额 0"—— 用户复核的是一个没有含义的数字。
  //
  // ★ 但**听懂 ≠ 一律立刻执行**：「要不要先问一句」由计划表自己说了算
  //   （`planNeedsConfirm`）—— 用户点名说出 + 能原样退回去 + 纸面 ⇒ 直接跑；
  //   退不回来 / 实盘 ⇒ 先问。一次误识别不该等于一次写台账。
  if (parsed.intent === 'dispatch_task') {
    const goal = (parsed.taskGoal ?? text).trim()
    const planArgs = planTaskForVoice(goal)
    if (!planArgs.plan) {
      // 听不懂就**现在说实话**，并列出能听懂的说法。不构造待确认 ——
      // 让用户确认一件注定失败的事，比直接说不更像耍人。
      return finish(
        `「${goal}」这个我听不懂。${listUnderstoodPlans()}` +
          '另外，你要是想让我回答开放问题（不是办事），直接问就行，我会去调模型。',
      )
    }
    const plan = planArgs.plan
    const cast = planCast(plan)
    const undo = undoPlanOf(plan)
    // ★★ 模式**现读**，不由调用方自报 —— 这是"免确认"成立的第二个条件。
    //   `autopilotStatus().mode` 是全系统唯一的模式口径，于是"这里以为的纸面"
    //   与"执行时以为的纸面"在结构上不可能分岔。
    const mode = autopilotStatus().mode

    // ── 免二次确认：用户**点名说出了**这件事 + 它能原样退回去 + 现在是纸面 ──
    //
    // ★ 治的是用户实测的原话：「说『启动自治循环』，总览那颗按钮还是没有变成
    //   『停止自治循环』」。根因是**每一次都要他再说一句「确认」**，
    //   而他不知道还得说第二遍 —— 在他眼里这就是"说了没用"。
    //
    // ★ 为什么这不算放宽安全：二次确认的全部价值在于"不可逆的动作不许被
    //   一次误识别做掉"。`planNeedsConfirm` 把免确认**只发给明确声明了撤销
    //   路径、且不在实盘**的计划；退得回来的动作，本来就不需要预授权。
    //   看不清的那些（propose / hygiene / self-learn）照旧问，一个字没动。
    if (!planNeedsConfirm(plan, mode !== 'live')) {
      const exec = await dispatchDangerous({ side: 'buy', symbol: '' }, 'dispatch_task', goal)
      // ★ 留痕：免确认是一次"少问了一句"的决定，必须能事后核对
      //   （判据 17：可逆动作才允许自动跑 —— 这里把判据的输入一起记下来）。
      appendEvent('VOICE_PLAN_AUTORUN', {
        planId: plan.id,
        chain: plan.chain,
        undoPlan: plan.undoPlan ?? null,
        mode,
        ok: exec.ok,
      })
      if (!exec.ok) {
        return finish(
          `这个没整条跑成：${exec.reason ?? '原因没给出来'}。${exec.detail ?? ''}` +
            '界面上那颗按钮读的是同一份状态 —— 我到底起没起来，看它最准。' +
            (undo ? `要收尾就说一句「${undo.label}」。` : ''),
          { intent: parsed.intent },
        )
      }
      return finish(
        `好，我直接开跑了 —— 这件事能原样退回去，所以我没再问你第二遍：「${goal}」。` +
          `按「${plan.label}」来，上手的是 ${cast}。${exec.detail ?? ''}` +
          '界面上你去总览看那颗按钮：它显示的就是这件事的真实状态。' +
          (undo ? `要撤就说一句「${undo.label}」，能退回现在这样。` : ''),
        { intent: parsed.intent },
      )
    }

    // ── 得先授权的那些：照旧问人，但**把"为什么问"说成依据**，而不是替世界下结论 ──
    //   （判据 24：`undoPlan` 为空只能说"本名单里没有"，不能说"世上没法撤"。）
    const askWhy = plan.undoPlan
      ? '现在是实盘模式：撤销路径能退回系统状态，但已经打到交易所的单退不回来，'
      : '这件事不在「能原样退回来」的名单里（名单只收在计划表里写明了撤销路径的动作），'
    const p = createPending('dispatch_task', goal.slice(0, 40), { side: 'buy', symbol: '' }, 0, turn.turnId, goal)
    appendEvent('VOICE_CONFIRM_REQUESTED', {
      action: p.action,
      intent: parsed.intent,
      expectedNotional: 0,
      planId: plan.id,
      chain: plan.chain,
    })
    return finish(
      `我打算派舰队干这件事：${goal}。` +
        `按「${plan.label}」来，上手的是 ${cast}。` +
        `${askWhy}所以先问你一句：确认吗？说「确认」我就开跑。不涉及金额，不用复述数字。`,
      { pending: p },
    )
  }

  // ── 危险动作：一律先要确认 ──
  if (isDangerous(parsed.intent)) {
    // 置信度不足时不猜，直接澄清 —— 猜错的代价是真实资金
    if (parsed.confidence < 0.6 || !parsed.slots) {
      return finish(`这句我没把握，${parsed.error ?? '能不能再说一遍，说清楚买什么、多少钱'}？`)
    }
    if (parsed.intent === 'place_order') {
      const sl = parsed.slots
      if (!sl.symbol) return finish('没听出要买哪个标的。这个池子里有：' + (intentContext().symbols.join('、') || '（当前没有可交易标的）'))
      if (sl.notional === undefined && sl.qty === undefined) {
        return finish(`没听出数量。${parsed.error ?? ''}你可以说「买两百块钱的比特币」或者「买 0.01 个比特币」。`)
      }
      const markRaw = markPriceOf(getOrchState(), sl.symbol)
      // ★★ 缺报价在**这里**就停下来，理由与 `preTradeCheck` 的 `NO_REFERENCE_PRICE` 是同一条：
      //   没有参考价 ⇒ 算不出名义额 ⇒ 名义额上限那道门**这次没能被检查**。
      //   旧代码把 `markPriceOf` 当 `number` 用（缺报价返回 0），于是
      //   "算不出来"被讲成了"约 0.00 美元"——用户会以为这单不花钱，而风控也确实没拦。
      //   ⇒ 同一件事只给一个说法：拿不到报价就是**不下单**，不是"按 0 下"。
      if (markRaw === null) {
        appendEvent('VOICE_ORDER_REFUSED', { symbol: sl.symbol, reason: 'NO_MARK_PRICE' })
        return finish(
          `我这边还没有 ${sl.symbol} 的真实报价 —— 算不出名义额、保证金和强平价，` +
            `所以这次不下单。等行情通道通了，把这句话再说一遍就行。`,
        )
      }
      const mark = markRaw
      const notional = sl.notional ?? (sl.qty !== undefined && Number.isFinite(mark) ? sl.qty * mark : 0)

      // ── 合约槽位裁决：不可行就**现在说清楚**，不构造待确认 ─────────────
      //
      // ★ 让用户确认一件注定失败的事，比直接说不更像耍人（与上面两处同一条理由）。
      // ★ 更要紧的是**不许静默替换**：用户说 125 倍、我们按 1 倍下，
      //   与用户说 125 倍、我们回一句"做不到，原因是…"，是两件完全不同的事。
      const rd = describeContractOrder(sl, mark)
      if (!rd.ok) {
        appendEvent('VOICE_ORDER_REFUSED', {
          symbol: sl.symbol,
          requestedLeverage: sl.leverage ?? 1,
          instType: sl.instType ?? 'SPOT',
          reason: rd.reason ?? 'LEVERAGE_REFUSED',
        })
        return finish(`${rd.echo}。但我没执行：${rd.speech}`)
      }
      if (sl.instType === 'SWAP' && !(mark > 0)) {
        return finish(`这个标的（${sl.symbol}）还没有行情，合约单要先有标记价才算得出保证金和强平价。`)
      }

      // ── ★★ 保护价：闸门要它，所以**在这里先问**，而不是等确认后被拒 ────────
      //
      // ★ 闸门（`orderGate.ts` → `tradeGate.precheckTrade()`）在
      //   「入场 / 止盈 / 止损没有**全部** > 0」时会**短路**成
      //   `unverifiable` + **`pipeline 0/9`**（九道门一道都不跑），`submitAllowed` 为假。
      //   而这两个字段只在用户**说了**止盈/止损时才存在（见 `submitOrder` 里
      //   `slots.takeProfitPct !== undefined || …` 那段）
      //   ⇒ 不补一句就直接确认，这笔单**一定**会在闸门那里变成一句"查不了"。
      //   实测（2026-09-23）：连**额度以内**的 100U 单都会被拒。
      //
      // ★ 用户裁决（2026-09-23）= **保持 fail-closed**：
      //   不替用户编保护、也不开"裸单"旁路，而是**先问人**。
      //   · 不编保护：保护是**凭据**，替用户填一个等于替他签了他没签过的东西
      //     （红线⑯ 的同族：一句话只能有一个主人）。
      //   · 不开旁路：一个"用户说不要就绕开闸门"的分支，就是红线㉙ 那条"同一个业务
      //     动作只许有一条规矩"的裂缝 —— 真要开，得单独裁决。
      //   · **不建待确认**：用户下一句带上保护重说一遍，走的是**同一条路**
      //     （判据 8）。理由与上面那条"让用户确认一件注定失败的事，比直接说不更像耍人"一致。
      // ★ **只对纸面问**。实盘开仓**不接本地保护**（见 `submitLiveOrder` 里
      //   `LIVE_PROTECTION_NEEDS_VENUE_STOP` 那条）—— 对实盘问"带上止盈止损"
      //   会把用户推进一个**没有用**的动作：他照做了，然后拿到
      //   `LIVE_PROTECTION_NEEDS_VENUE_STOP`（判据 D7）。
      //   实盘那条路的现状：闸门如实判 `unverifiable` ⇒ 拒；真正的修法是
      //   **场所侧条件单通道**（另开一轮），不是在这里替它编一个保护价。
      const lacksProtection = sl.takeProfitPct === undefined || sl.stopLossPct === undefined
      // ★★ 已经明确说了"不带保护"就**不再问** —— 问了就是让用户把同一句话说两遍。
      //   这一条不是优化：判据 D7 问的是"这个输出把用户引向哪个动作"，
      //   而"再问一遍他刚回答过的问题"引向的动作是**重复劳动**。
      if (sl.live !== true && lacksProtection && sl.protectionWaived !== true) {
        const missing =
          sl.takeProfitPct === undefined && sl.stopLossPct === undefined
            ? '止盈和止损都还没说'
            : sl.takeProfitPct === undefined
              ? '还缺止盈'
              : '还缺止损'
        appendEvent('VOICE_PROTECTION_REQUIRED', {
          symbol: sl.symbol,
          side: sl.side,
          notional,
          instType: sl.instType ?? 'SPOT',
          hasTakeProfit: sl.takeProfitPct !== undefined,
          hasStopLoss: sl.stopLossPct !== undefined,
        })
        // ★ 记下"我问的是哪一笔"。用户下一句「不要」就是对它的回答（见那个接口的注释）。
        pendingProtectionQuestion = { at: Date.now(), slots: { ...sl }, notional }
        return finish(
          `${rd.echo}。但这笔单${missing} —— 下单闸门要止盈和止损**都填了**才肯评估，` +
            `缺一个它只会回一句"查不了"，不会放行。` +
            `带上保护再说一遍就行，例如「买一百块钱的比特币，止盈 5% 止损 1%」。` +
            `或者回一句「不带保护」，我就按**裸单**下 —— 那种单没有止盈止损，` +
            `唯一的保护是强平距离：系统会先验它的杠杆强平距离够不够远，` +
            `不够远就把这笔单退回来让你降倍数或给止损。`,
        )
      }
      // ★★ 用户显式放弃保护 ⇒ 留痕。判据：**"豁免生效了"必须有一个自己的观测点**，
      //   否则事后只能看到一笔"正常放行"的裸单，看不出用户当时说过什么。
      if (sl.protectionWaived === true) {
        appendEvent('VOICE_PROTECTION_WAIVED', {
          symbol: sl.symbol,
          side: sl.side,
          notional,
          instType: sl.instType ?? 'SPOT',
          leverage: rd.leverage,
          matched: sl.protectionWaiverMatched ?? null,
          live: false,
        })
      }

      const p = createPending('place_order', `${sl.live ? '实盘' : '仿真'} ${rd.echo}`, sl, notional, turn.turnId)
      appendEvent('VOICE_CONFIRM_REQUESTED', {
        action: p.action,
        expectedAmount: p.expectedAmount,
        expectedNotional: p.expectedNotional,
        live: sl.live === true,
        instType: sl.instType ?? 'SPOT',
        leverage: rd.leverage,
      })
      const needAmount = sl.live === true || notional > 50
      const ask = needAmount
        ? `请说「确认 ${p.expectedAmount}」来完成。${sl.live ? '这是实盘单，不复述金额我不会执行。' : '金额超过 50 美元，需要你复述一遍防止我听错。'}`
        : '说「确认」我就执行。'
      // ★ 念回的是**完整解释**：契约、方向、名义、杠杆、止盈、止损，一个都不省。
      //   用户实测那次"10 美金 125 倍合约被做成现货 10 元"之所以没人发现，
      //   是因为旧回话只说了"买入 BTC 10 美元"—— 复核的人看不到任何异常。
      const echoNote =
        sl.amountBasis === 'margin' && rd.leverage > 0
          ? `保证金 ${(notional / rd.leverage).toFixed(2)} 美元 × ${rd.leverage} 倍 = 名义 ${notional.toFixed(2)} 美元。`
          : sl.amountBasis === 'qty'
            ? `按数量 ${sl.qty} 个处理，约 ${notional.toFixed(2)} 美元。`
            : `按名义额 ${sl.notional} 美元处理，约 ${(notional / Math.max(mark, 1e-9)).toFixed(6)} 个。`
      // ★★ 裸单必须在**确认这一步**被念出来。
      //   确认是用户唯一一次复核"系统理解成了什么"的机会；而"有没有保护"
      //   正是他最能一眼看出理解错没错的字段 —— `rd.echo` 里写的是
      //   "止盈没设、止损没设"，与"根本没打算设"在字面上分不开。
      //   没有这一句，用户有可能为一张他以为带止损的裸单签了字。
      const waivedNote =
        sl.protectionWaived === true
          ? `你说的是「${sl.protectionWaiverMatched ?? '不带保护'}」—— 这笔单**不挂**止盈止损，` +
            `确认后按裸单下，唯一的保护是强平距离。`
          : ''
      return finish(`我准备下这笔：${rd.echo}。${echoNote}${rd.speech}${waivedNote}${ask}`, { pending: p })
    }
    // close / cancel_all / killswitch
    const sl = parsed.slots ?? { side: 'sell' as const, symbol: '' }
    const notional = 0
    const p = createPending(parsed.intent, `${INTENT_LABEL[parsed.intent]} ${sl.symbol || '全部'}`, sl, notional, turn.turnId)
    appendEvent('VOICE_CONFIRM_REQUESTED', { action: p.action, intent: parsed.intent, expectedNotional: 0 })
    return finish(`确认要${p.action}吗？说「确认」我就执行。`, { pending: p })
  }

  // ── 按界面上一颗具名按钮（**宽档**，排在兜底之前）────────────────────
  //
  // ★ 为什么这里是**宽档**、而上面那条严格档不能省：
  //   这条路的动作词含「帮我 / 看看 / 跑一下」—— 它够宽，所以能接住
  //   「帮我按一下库存那个刷新」这类说法；但也正因为宽，它排在最后：
  //   订单 / 任务 / 舰队的规则先挑，都没接住才轮到它。
  //   （严格档见上面 `resolveExplicitPress` 那一处：用户**明说"按/点"**时
  //     才允许抢在只读问答前面，否则「风控中心」这种词会被 `query_risk` 抢走。）
  //
  // ★ 处置逻辑**不在这里**：`handleUiResolution` 是唯一一份实现，
  //   这一档与严格档的差别只有 `allowWeak: true`（没把握时列候选问一句）。
  const ui = handleUiResolution(resolveUiAction(text), { allowWeak: true })
  if (ui) return ui

  // ── 兜底：**不再说"我不会"** ─────────────────────────────────────────
  //
  // ★ 这是本轮改动里对用户体感影响最大的一处。
  //   旧实现在这里回「这句我没听懂。你可以问持仓、权益、行情……」——
  //   也就是说，任何一句不在规则表里的话（开放知识、解释性提问、
  //   "这个指标怎么算"）都得到同一句拒绝。用户的原话是：
  //   「不能再说不会了」。
  //
  // ★ 新的判据不是"尽量答对"，而是**永远不说"我不会"**：
  //   · 有附件或属于开放提问 → 交给模型；
  //   · 模型不可用 → 说清是哪一种不可用（没配厂商 / 候选全失败），
  //     并给出下一步动作；
  //   · 回答不落地（纯模型知识）时，措辞里不许说成"系统数据显示"。
  const openQuestion = text.length > 0 || (batch?.ok ?? false)
  if (!openQuestion) {
    return finish('我这边什么都没收到 —— 你可以直接问我事情，也可以贴一张图或者一份文本给我看。')
  }

  const q = text.length > 0 ? text : '（没有文字，只有附件）请看一下附件，告诉我你看到了什么、有没有要注意的地方。'
  // ── ★ 长期记忆进模型上下文 ────────────────────────────────────────────
  // 这是"它记得我"在**开放问答**上的落点（规则层那条落点是 `ctx.referTo`）。
  // ★ 只在真的召回出东西时才传：传一个空的「【我对这位用户已确认的记忆】」
  //   会让模型以为"这位用户没有任何已确认的记忆"，而它其实只是**这一轮没命中** ——
  //   两种情况的正确回答完全不同（一个是"你没告诉过我"，一个是"这次用不上"）。
  const mem = recall(q)
  const memCtx = recallAsContext(mem)
  if (mem.state !== 'empty' || mem.expiredCount > 0 || mem.failureReason !== null) {
    appendEvent('VOICE_MEMORY_RECALLED', {
      state: mem.state,
      hits: mem.hits.length,
      ids: mem.hits.map((h) => h.fact.id),
      expired: mem.expiredCount,
      // ★ 被预算裁掉的东西要落账（文件头 ③：静默裁剪 = 不可观测的能力降级）
      dropped: mem.droppedIds,
      truncated: mem.truncatedIds,
      tokens: mem.tokens,
      budgetTokens: mem.budgetTokens,
      assemblyFailure: mem.failureReason,
    })
  }
  const a = await askModel(q, {
    attachments: batch?.digests ?? [],
    ...(memCtx ? { extraContext: memCtx } : {}),
  })
  const ev = appendEvent('VOICE_ASK_MODEL', {
    ok: a.ok,
    model: a.model,
    degraded: a.degraded,
    reason: a.reason ?? null,
    // ★ 只记长度与类型，**不记正文**：附件正文与用户提问都可能含个人信息，
    //   而落账的那一份是最容易被导出、被贴进别处的。
    questionChars: q.length,
    attachments: (batch?.digests ?? []).map((d) => ({ name: d.name, kind: d.kind, bytes: d.bytes })),
    attempts: a.attempts ?? [],
  })
  for (const step of a.steps) {
    announce({ text: step, category: 'work-state', priority: 'P2_STATUS', seq: ev.seq, kind: 'VOICE_ASK_MODEL' })
  }
  const attachNote = batch ? batch.summary + ' ' : ''
  return finish(attachNote + a.speech, {
    // ★ 走了模型并答出来了，就不能在意图上还显示「听不懂」。
    //   实测里这一栏会同时出现「意图 听不懂 · 系统回：资金费率就是多头和空头
    //   之间定期互转的一笔小费用……」—— 两句互相矛盾，而这类矛盾会让用户
    //   不知道该相信哪一句（判据 18：文案描述的不是真正在跑的逻辑）。
    //   规则层判不出来时，系统实际做的是「问模型」，那就记成 ask_model；
    //   原解析结果留在 detail 的 parsedAs 里，不丢。
    intent: 'ask_model',
    intentLabel: INTENT_LABEL.ask_model,
    detail: JSON.stringify({ model: a.model, degraded: a.degraded, reason: a.reason ?? null, parsedAs: parsed.intent }),
  })
}

/**
 * 「继续」时使用的目标收益。
 *
 * 刻意取回上次启动的目标值（从任务状态里读），而不是新拍一个 ——
 * 用户说「继续」的意思是"接着刚才那样跑"，不是"换个目标"。
 */
function placeholderTargetPct(): number {
  const ap = autopilotStatus()
  return ap.targetPct > 0 ? ap.targetPct : 2
}

/**
 * 把一句话交给舰队的调度器判"能不能接"。
 *
 * ★ 语音层**不自己匹配**：它只把原话递过去。自己再写一套匹配的后果是
 *   长出第二条"能听懂什么"的口径，而两条口径迟早给出不同答案 ——
 *   一处说能接、另一处说不懂，用户看到的是自相矛盾。
 */
function planTaskForVoice(goal: string): ReturnType<typeof planTask> {
  return planTask(goal)
}

/** 把它能听懂的说法列成一句能念的话。用户实测反馈过"什么都听不懂"，这一句是解药的一半。 */
function listUnderstoodPlans(): string {
  return `我现在能接的说法有：${FLEET_TASK_PLANS.map((p) => p.label).join('、')}。` + '你也可以直接说「文件体检」，我让文件体检员给你一份可回收清单。'
}

/** 打断。返回新的世代号，前端应把在此之前收到的答复全部丢弃。 */
export function interruptVoice(reason = 'USER_BARGE_IN'): { generation: number; droppedPending: boolean } {
  const r = interrupt(reason)
  appendEvent('VOICE_INTERRUPTED', { reason, generation: r.generation, droppedPending: r.droppedPending })
  return r
}

/**
 * 查阅"我和桌宠聊过什么"。
 *
 * ★ 放在 service（而不是让端点直接读模块）：这样"记的人"（会话状态机）与
 *   "读的人"（这个函数）走的是同一份事实源，端点不可能读到一份别的地方
 *   拼出来的对话。
 *
 * ★ 一并带出 `sessionId` 与落盘健康状态：前端要能区分
 *   「这几轮是当前会话」与「这几轮是上次重启前的」，也要能看见
 *   「记录写不进去」——后者缺了的话，"没有新记录"会看起来像"没聊过"。
 */
/** 查阅结果里的一轮。比事实源多一个 `intentLabel`（见下）。 */
export type VoiceTranscriptTurn = TranscriptPage['turns'][number] & { intentLabel: string | null }

export function voiceTranscript(
  opts: { limit?: number; beforeAt?: number; days?: number } = {},
): Omit<TranscriptPage, 'turns'> & { turns: VoiceTranscriptTurn[]; sessionId: string; root: string } {
  const health = transcriptHealth()
  const page = readTranscript(opts)
  return {
    ...page,
    turns: page.turns.map((t) => ({
      ...t,
      // ★ 意图 → 中文的标签表**只有一份**（`intents.ts` 的 `INTENT_LABEL`）。
      //   前端不复刻第二份：复刻出来的那份一定会漂移，而漂移出来的
      //   那一栏恰好没有人在测（判据 29：同一句话只能有一个主人）。
      //   解析不出来的意图名**原样显示** —— 不许替换成"未知"把线索抹掉。
      intentLabel: t.user?.intent ? (INTENT_LABEL[t.user.intent as keyof typeof INTENT_LABEL] ?? t.user.intent) : null,
    })),
    sessionId: sessionId(),
    root: health.root,
  }
}

/**
 * 记忆查阅视图。
 *
 * ★ 与 `/voice/transcript` **并列**而不合并：它们回答三个不同的追问 ——
 *   「聊过什么」（正文）/「记住了什么」（本函数）/「系统认为你是谁」。
 *   合并会让任一方被另一方的体量与语义污染（对话正文很长，记忆很短）。
 *
 * ★ 「记住了什么」必须**看得见**，否则这一层无法验收：用户能看到的只有
 *   "它答得对不对"，而他无法区分"记住了"与"这一轮恰好蒙对"。
 */
export function voiceMemoryView(opts: { now?: number } = {}) {
  const now = opts.now ?? Date.now()
  const health = memoryHealth()
  const read = readFacts()
  const all = currentFacts(read)
  const isExpired = (f: { expiresAt: number | null }) => f.expiresAt !== null && f.expiresAt <= now
  const alive = all.filter((f) => !isExpired(f) && f.text.length > 0)

  return {
    /**
     * ★ 三态分开说（判据 C7）：`unreadable` 非 null ⇒ **读不到**；
     *   `facts` 为空且 `unreadable` 为 null ⇒ **真的没记过**。
     *   两者在界面上必须长得不一样 —— 否则"文件权限坏了"会显示成"它失忆了"。
     */
    facts: all.map((f) => ({
      id: f.id,
      kind: f.kind,
      key: f.key,
      text: f.text,
      value: f.value ?? null,
      confidence: f.source.confidence,
      /** 出处：能回到对话记录的**哪一轮**（判据 C3：有出处才叫证据）。 */
      from: { sid: f.source.sid, turnId: f.source.turnId, at: f.source.at },
      at: f.at,
      expiresAt: f.expiresAt,
      expired: isExpired(f),
    })),
    /** 最近几轮工作记忆 —— 这就是「记得上一句」的实体，指代消解读的就是它。 */
    working: recentTurns().map((t) => ({
      turnId: t.turnId,
      at: t.at,
      user: t.user,
      assistant: t.assistant,
      symbols: t.symbols,
      intent: t.intent,
    })),
    /**
     * ★ 系统会怎么把这些念出来 —— 界面显示的必须是**系统真正会说的话**，
     *   而不是界面自己拼的另一种说法（判据 D2：一句话一个主人）。
     */
    speech: speakRecall(alive, all.length - alive.length),
    unreadable: read.unreadable,
    badLines: read.badLines,
    badReasons: read.badReasons,
    expiredCount: all.filter(isExpired).length,
    /** 落盘侧最近一次失败（写不进去必须能被看见）。 */
    writeFailure: health.writeFailure,
    path: health.path,
    sessionId: sessionId(),
  }
}

export function voiceStatus(): VoiceStatus & {
  config: VoiceConfig
  session: ReturnType<typeof sessionStatus>
  narrator: ReturnType<typeof narratorCounters>
  anomaly: ReturnType<typeof anomalyCounters>
  turn: VoiceTurn | null
} {
  const sess = sessionStatus()
  return {
    enabled: cfg.enabled,
    voiceId: cfg.voiceId,
    verbosity: cfg.verbosity,
    turn: sess.turn,
    generation: sess.generation,
    interruptedCount: sess.interruptedCount,
    spokenCount: narratorCounters().emitted,
    suppressedCount:
      narratorCounters().suppressedByMute +
      narratorCounters().suppressedByVerbosity +
      narratorCounters().suppressedByDedupe +
      narratorCounters().suppressedByRate,
    pending: sess.pending,
    recentNarrations: recentNarrations(40),
    config: voiceConfigView(),
    session: sess,
    narrator: narratorCounters(),
    anomaly: anomalyCounters(),
  }
}

/** 取待播内容（SSE 消费）。 */
export function drainNarrations(limit = 10): NarrationLine[] {
  return drain(limit)
}

/** 供 index.ts 在行情 tick 里调用，避免 index 直接依赖 narrator 细节。 */
export function voiceOnPriceTick(symbol: string, price: number): void {
  onVoicePriceTick(symbol, price)
}

// ───────────────────────────── 合成引擎 ─────────────────────────────

/**
 * 神经合成的运行统计。
 *
 * ★ 为什么必须记这个而不是只抛错：
 * 这两个引擎的听感差距是**质变**（神经合成 vs SAPI5 拼接音），
 * 但"降级"本身是静默的 —— 用户只会觉得"音色还是那么生硬"，
 * 然后去反复点音色按钮。所以每一次云端失败都必须留下痕迹，
 * 并且要在面板上如实显示"当前实际用的是哪条引擎"。
 */
const neuralStats = {
  attempts: 0,
  ok: 0,
  failed: 0,
  lastError: null as string | null,
  lastKind: null as string | null,
  lastAt: null as number | null,
  lastLatencyMs: null as number | null,
}

export interface TtsEngineView {
  /** 神经引擎的目录与健康度。 */
  neural: {
    voices: typeof NEURAL_VOICES
    stats: typeof neuralStats
    handshake: ReturnType<typeof handshakeDebug>
    /**
     * 说明当前为什么是"可用"还是"不可用"。
     * 刻意不叫 `available` 布尔量：真实情况是"还在试"，
     * 而一个自报的布尔量无法被观测反驳（本项目反复踩过的坑）。
     */
    note: string
  }
  /** 浏览器合成永远是兜底，且**不需要联网**。 */
  local: { note: string }
  /**
   * 音色 id → 走哪条引擎。
   *
   * 存在的理由：这条映射本来在前端各写一遍（面板判一次、合成器判一次），
   * 于是"面板说这条是云端、合成器却按本机处理"这种错误可以完全没有报错地活着。
   * 现在由服务端从目录推出，两边读同一份。
   */
  engineOf: Record<string, VoiceEngine>
}

export function ttsEngineView(): TtsEngineView {
  return {
    neural: {
      voices: NEURAL_VOICES,
      stats: { ...neuralStats },
      handshake: handshakeDebug(),
      note:
        neuralStats.attempts === 0
          ? '还没调用过。首次播报时才会真正探测这条链路。'
          : neuralStats.failed === 0
            ? `最近 ${neuralStats.attempts} 次全部成功。`
            : `最近 ${neuralStats.attempts} 次里有 ${neuralStats.failed} 次失败，` +
              `失败时前端会退回本机合成（听感会明显变差，那说明云端此刻不可用）。`,
    },
    local: {
      note: '浏览器/操作系统自带的语音包。无需联网，但 Windows 上多为拼接式合成，听感生硬 —— 它只是兜底，不是目标。',
    },
    // 音色 id → 引擎。**从目录推出，不手写**：手写的那份一定会与目录分岔，
    // 而分岔的后果是"面板说这条走云端、合成器却按本机处理"这种无声的错误。
    engineOf: Object.fromEntries(VOICE_CATALOG.map((v) => [v.id, v.engine])),
  }
}

export function resetTtsStats(): void {
  neuralStats.attempts = 0
  neuralStats.ok = 0
  neuralStats.failed = 0
  neuralStats.lastError = null
  neuralStats.lastKind = null
  neuralStats.lastAt = null
  neuralStats.lastLatencyMs = null
}

export interface VoiceSpeechResult {
  ok: true
  audio: Buffer
  mime: string
  bytes: number
  latencyMs: number
}

export interface VoiceSpeechFailure {
  ok: false
  /** 供前端决定降级策略：`forbidden` 是"参数过期"（可修），其余多为网络或端点问题。 */
  kind: string
  /** 面向使用者的中文说明。**不允许**放原始英文异常。 */
  message: string
}

/**
 * 合成一段播报语音。
 *
 * 返回失败而**不抛**：调用方（HTTP 端点）要把失败原因如实交给前端，
 * 由前端决定退回本机合成；抛异常会让这条路径变成 500，
 * 而 500 在界面上只会显示成"服务出错了"，看不出"云端音色不可用、已退回本机"。
 */
export async function synthesizeForVoice(
  text: string,
  opts: { voiceId?: string; rate?: number } = {},
): Promise<VoiceSpeechResult | VoiceSpeechFailure> {
  /**
   * ★ 前两道闸必须在**计数之前**。
   *
   * `neuralStats` 是要拿到面板上显示"云端链路健康度"的。如果"用户选的是本机音色"
   * 也被记成 attempts+failed，那面板会长期显示"云端失败 N 次" —— 而这个数字
   * 完全来自用户的正常选择。**把一个正常状态报成故障，比不报更糟**：
   * 它会训练用户忽略这个指标。
   */
  const requestedId = (opts.voiceId ?? '').trim() || cfg.voiceId
  const requested = getVoice(requestedId)
  if (!requested) {
    return { ok: false, kind: 'unknown-voice', message: `未收录的音色「${requestedId}」，请重新选择后再试` }
  }
  if (requested.engine === 'local') {
    return { ok: false, kind: 'local-engine', message: '当前选的是本机音色，这一档本来就由本机合成' }
  }

  const started = Date.now()
  neuralStats.attempts += 1
  try {
    // 音色的本音语速叠在用户微调上 —— 与 voiceId 目录同一套语义
    const profile = getNeuralVoice(requested.neuralId ?? requested.id) ?? defaultNeuralVoice()
    const r = await synthesizeNeural(text, {
      voiceId: profile.id,
      rate: profile.rate * (opts.rate ?? 1),
    })
    neuralStats.ok += 1
    neuralStats.lastError = null
    neuralStats.lastKind = null
    neuralStats.lastAt = Date.now()
    neuralStats.lastLatencyMs = Date.now() - started
    appendEvent('VOICE_TTS_SYNTHESIZED', { engine: 'neural', voiceId: profile.id, bytes: r.bytes })
    return { ok: true, audio: r.audio, mime: r.mime, bytes: r.bytes, latencyMs: Date.now() - started }
  } catch (e) {
    const err = e as { kind?: string; message?: string }
    const kind = err.kind ?? 'unknown'
    const raw = err.message ?? String(e)
    neuralStats.failed += 1
    neuralStats.lastError = raw
    neuralStats.lastKind = kind
    neuralStats.lastAt = Date.now()
    neuralStats.lastLatencyMs = Date.now() - started
    appendEvent('VOICE_TTS_FAILED', { engine: 'neural', kind })
    return { ok: false, kind, message: neuralFailureReason(kind) }
  }
}

/**
 * 把引擎错误翻成**能照着修的中文**。
 *
 * 直接把 `NeuralTtsError: 握手被拒（403）…` 丢给界面是不负责任的：
 * 使用者要的是"现在怎么办"。而三种失败的处置完全不同 ——
 * 版本过期要改环境变量、网络问题要等、超时是服务端慢。
 */
export function neuralFailureReason(kind: string): string {
  if (kind === 'forbidden') return '云端音色握手被拒（版本参数可能已过期），已退回本机合成'
  if (kind === 'timeout') return '云端音色响应超时，已退回本机合成'
  if (kind === 'network') return '连不上云端音色服务，已退回本机合成'
  return '云端音色返回了异常数据，已退回本机合成'
}
