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
  VoiceIntentName,
} from './types.ts'
import { parseIntent, isDangerous, resolveSymbol, INTENT_LABEL, type IntentContext } from './intents.ts'
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
  confirmPending,
  consumePending,
  clearPending,
  getPending,
  sessionStatus,
  resetSession,
} from './session.ts'
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
  type WorkStatusView,
} from './narrator.ts'
import { anomalyCounters, configureAnomaly, resetAnomaly } from './anomaly.ts'
import { appendEvent, getEvents } from '../ledger.ts'
import { getOrchState, processOrderIntent, processLiveIntent, cancelOrder, activateKillswitch, deactivateKillswitch } from '../core.ts'
import { markPriceOf, cancelAll } from '../orchEngine.ts'
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
  return { symbols, markPrice: (sym) => markPriceOf(s, sym) }
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
  // 「always」策略下即使金额很小也要求复述
  if (cfg.confirmPolicy === 'always' && pendingBefore && !amt) {
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
  const exec = await dispatchDangerous(p.slots, p.intent)
  const reply = exec.ok
    ? `已执行：${p.action}。${exec.detail ?? ''}`
    : `执行被拒：${exec.reason ?? '未知原因'}。`
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

interface DispatchOutcome {
  ok: boolean
  reason?: string
  detail?: string
  clientOrderId?: string
  orderId?: string
  status?: string
}

/**
 * 危险动作的统一出口。
 *
 * **所有**会改变资金/运行状态的动作都必须从这里走，且这里只调用既有函数。
 * 新增一类动作时，如果发现需要在本函数里"自己构造"点什么，那就说明
 * 该动作在既有系统里没有对应实现 —— 应当先去补那边的实现，
 * 而不是在语音层就地造一个。
 */
async function dispatchDangerous(slots: OrderSlots, intent: VoiceIntentName): Promise<DispatchOutcome> {
  const s = getOrchState()

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

/** 仿真/纸面下单：转交 `processOrderIntent`（与界面上的按钮完全同一条路）。 */
function submitOrder(slots: OrderSlots, isClose: boolean): DispatchOutcome {
  const s = getOrchState()
  const symbol = slots.symbol
  if (!symbol) return { ok: false, reason: 'VOICE_SYMBOL_REQUIRED（没听出标的）' }
  const mark = markPriceOf(s, symbol)
  if (!Number.isFinite(mark) || mark <= 0) {
    return { ok: false, reason: `NO_MARK_PRICE（${symbol} 还没有行情，无法定价）` }
  }

  let qty = slots.qty
  if (qty === undefined) {
    if (slots.notional === undefined) return { ok: false, reason: 'VOICE_AMOUNT_REQUIRED（没听出数量）' }
    qty = slots.notional / mark
  }
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: `INVALID_QTY（${qty}）` }

  const clientOrderId = `V-${randomUUID().slice(0, 12)}`

  // 语音来源留痕：审计链里必须能区分"人点出来的单"和"嘴说出来的单"
  appendEvent('VOICE_COMMAND', {
    action: isClose ? 'close_position' : 'open_position',
    symbol,
    side: slots.side,
    qty,
    notionalUsd: Math.round(qty * mark * 100) / 100,
    basis: slots.amountBasis ?? 'notional',
    live: false,
    clientOrderId,
  })

  const outcome = processOrderIntent({
    clientOrderId,
    symbol,
    side: slots.side,
    type: 'market',
    qty,
    leverage: 1,
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
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, reason: `NO_MARK_PRICE（${symbol}）` }

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
  appendEvent('VOICE_COMMAND', {
    action: isClose ? 'close_position' : 'open_position',
    symbol,
    side: slots.side,
    qty,
    notionalUsd: Math.round(qty * mark * 100) / 100,
    live: true,
    strategyId,
    clientOrderId,
  })
  const outcome = await processLiveIntent({
    clientOrderId,
    symbol,
    side: slots.side,
    type: 'market',
    qty,
    leverage: 1,
    strategyId,
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
    const pnl = Number.isFinite(px) && p.avgPrice > 0 ? ((px - p.avgPrice) / p.avgPrice) * 100 : 0
    parts.push(
      `${p.symbol} 持有 ${p.qty}，均价 ${p.avgPrice.toFixed(2)}，现价 ${Number.isFinite(px) ? px.toFixed(2) : '未知'}，浮动 ${pnl >= 0 ? '盈利' : '亏损'} ${Math.abs(pnl).toFixed(2)}%`,
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
    return ks.map((k) => `${k} 现价 ${s.lastPrice.get(k)?.toFixed(2)}`).join('；') + '。'
  }
  const px = markPriceOf(s, symbol)
  if (!Number.isFinite(px) || px <= 0) return `${symbol} 还没有行情数据。`
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
    '我是你这套交易系统的语音管家，你把我当秘书使唤就行。' +
    '我替你管三件事。' +
    '第一件是报信：成交、被风控拒绝、报警、自动驾驶的状态变化，我会主动开口，不用你问。' +
    '第二件是回话：持仓、权益、挂单、风控额度、行情、今天的日报，你问我就答。' +
    '第三件是干活：下单、平仓、撤单、暂停和继续自动驾驶、熔断，都能办。' +
    '你还可以直接给我一个目标，比如说，用十美元本金，一天之内做到一百美元。' +
    '我会先拿系统自己的尺子量一遍：做不做得到、要打多少笔、第一笔开不开得出来，报给你之后你点头我才启动。' +
    '两件事先说清楚：投真钱现在还没解锁，下单走的是仿真或者测试网；' +
    '还有，我的每一个动作走的都是界面上那套风控，语音不是一条新的通道。' +
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
export async function handleUtterance(rawText: string): Promise<VoiceReply> {
  const reply = await handleUtteranceInner(rawText)
  pumpEvents()
  return reply
}

async function handleUtteranceInner(rawText: string): Promise<VoiceReply> {
  const text = rawText.trim()
  const turn = beginTurn(text)
  const gen = currentGeneration()

  const ctx = intentContext()
  const parsed = parseIntent(text, ctx)
  const base = {
    turnId: turn.turnId,
    intent: parsed.intent,
    intentLabel: INTENT_LABEL[parsed.intent],
    confidence: parsed.confidence,
    narration: [] as NarrationLine[],
  }

  const finish = (reply: string, extra?: Partial<VoiceReply>): VoiceReply => {
    const r: VoiceReply = { ...base, dropped: false, reply, pending: getPending(), ...extra }
    if (!commitReply(turn.turnId, reply, gen)) r.dropped = true
    return r
  }

  // ── 确认 / 取消 ──
  if (parsed.intent === 'confirm') return await handleConfirm(text, turn.turnId, gen)
  if (parsed.intent === 'reject') {
    const had = getPending() !== null
    clearPending()
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
      const mark = markPriceOf(getOrchState(), sl.symbol)
      const notional = sl.notional ?? (sl.qty !== undefined && Number.isFinite(mark) ? sl.qty * mark : 0)
      const p = createPending(
        'place_order',
        `${sl.live ? '实盘' : '仿真'}${sl.side === 'buy' ? '买入' : '卖出'} ${sl.symbol} ${sl.notional ?? sl.qty} ${sl.amountBasis === 'qty' ? '个' : '美元'}`,
        sl,
        notional,
        turn.turnId,
      )
      appendEvent('VOICE_CONFIRM_REQUESTED', {
        action: p.action,
        expectedAmount: p.expectedAmount,
        expectedNotional: p.expectedNotional,
        live: sl.live === true,
      })
      const needAmount = sl.live === true || notional > 50
      const ask = needAmount
        ? `请说「确认 ${p.expectedAmount}」来完成。${sl.live ? '这是实盘单，不复述金额我不会执行。' : '金额超过 50 美元，需要你复述一遍防止我听错。'}`
        : '说「确认」我就执行。'
      const echoNote =
        sl.amountBasis === 'notional'
          ? `按名义额 ${sl.notional} 美元处理，约 ${(notional / Math.max(mark, 1e-9)).toFixed(6)} 个。`
          : `按数量 ${sl.qty} 个处理，约 ${notional.toFixed(2)} 美元。`
      return finish(`我准备${p.action}。${echoNote}${ask}`, { pending: p })
    }
    // close / cancel_all / killswitch
    const sl = parsed.slots ?? { side: 'sell' as const, symbol: '' }
    const notional = 0
    const p = createPending(parsed.intent, `${INTENT_LABEL[parsed.intent]} ${sl.symbol || '全部'}`, sl, notional, turn.turnId)
    appendEvent('VOICE_CONFIRM_REQUESTED', { action: p.action, intent: parsed.intent, expectedNotional: 0 })
    return finish(`确认要${p.action}吗？说「确认」我就执行。`, { pending: p })
  }

  return finish('这句我没听懂。你可以问持仓、权益、行情，或者说「帮助」听一遍能做的事。')
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

/** 打断。返回新的世代号，前端应把在此之前收到的答复全部丢弃。 */
export function interruptVoice(reason = 'USER_BARGE_IN'): { generation: number; droppedPending: boolean } {
  const r = interrupt(reason)
  appendEvent('VOICE_INTERRUPTED', { reason, generation: r.generation, droppedPending: r.droppedPending })
  return r
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
