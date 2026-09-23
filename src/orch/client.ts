import { useEffect, useRef, useState } from 'react'

export interface OrchRiskConfig {
  maxNotionalPerOrder: number
  maxOrdersPerMinute: number
  maxDrawdownPct: number
  priceDeviationBps: number
}

export interface OrchPosition {
  symbol: string
  qty: number
  avgPrice: number
}

export interface OrchOrderView {
  id: string
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  qty: number
  filledQty: number
  status: string
  createdAt: number
}

export interface OrchFullState {
  mode: string
  killswitch: boolean
  balanceUSDC: number
  equity: number
  peakEquity: number
  positions: OrchPosition[]
  orders: OrchOrderView[]
  risk: OrchRiskConfig
  lastPrice: Record<string, number>
}

export interface OrchEvent {
  seq: number
  ts: number
  kind: string
  payload: Record<string, unknown>
}

export type OrchStatus = 'connecting' | 'online' | 'offline'

async function orchFetch<T>(base: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-orch-token': token, ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`)
  }
  return (await res.json()) as T
}

export interface OrchLiveState {
  status: OrchStatus
  full: OrchFullState | null
  lastError: string | null
  refresh: () => void
}

export function useOrch(base: string, token: string, pollMs = 3000): OrchLiveState {
  const [status, setStatus] = useState<OrchStatus>('connecting')
  const [full, setFull] = useState<OrchFullState | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const pollRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    aliveRef.current = true
    setStatus('connecting')
    setFull(null)
    const poll = async () => {
      try {
        const s = await orchFetch<OrchFullState>(base, token, '/state')
        if (!aliveRef.current) return
        setFull(s)
        setStatus('online')
        setLastError(null)
      } catch (e) {
        if (!aliveRef.current) return
        setStatus('offline')
        setLastError(e instanceof Error ? e.message : String(e))
      }
    }
    pollRef.current = poll
    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      aliveRef.current = false
      clearInterval(t)
      pollRef.current = null
    }
  }, [base, token, pollMs])

  return { status, full, lastError, refresh: () => { void pollRef.current?.() } }
}

export function useOrchEvents(base: string, token: string, enabled: boolean, pollMs = 4000): OrchEvent[] {
  const [events, setEvents] = useState<OrchEvent[]>([])
  const sinceRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setEvents([])
      sinceRef.current = 0
      return
    }
    let alive = true
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const res = await orchFetch<{ events: OrchEvent[] }>(base, token, `/events?since=${sinceRef.current}`)
        if (!alive) return
        if (res.events.length > 0) {
          sinceRef.current = res.events[res.events.length - 1].seq
          // 窗口放大到 200：编排器会产生大量 SLO_BREACH，窗口太小会把真正的决策事件挤出可视范围
          setEvents((prev) => [...res.events.slice().reverse(), ...prev].slice(0, 200))
        }
      } catch {
        /* 下轮重试 */
      } finally {
        busy = false
      }
    }
    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [base, token, enabled, pollMs])

  return events
}

export async function setKillswitch(base: string, token: string, active: boolean): Promise<{ killswitch: boolean; cancelledOrders?: number }> {
  return orchFetch(base, token, '/killswitch', { method: 'POST', body: JSON.stringify({ active }) })
}

export interface OrderIntentInput {
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  qty: number
}

export interface OrderOutcome {
  ok: boolean
  clientOrderId: string
  orderId?: string
  status?: string
  reason?: string
}

export function submitOrderIntent(base: string, token: string, intent: OrderIntentInput): Promise<OrderOutcome> {
  return orchFetch<OrderOutcome>(base, token, '/orders', { method: 'POST', body: JSON.stringify(intent) })
}

export function cancelOrchOrder(base: string, token: string, clientOrderId: string): Promise<{ ok: boolean }> {
  return orchFetch<{ ok: boolean }>(base, token, `/orders/${encodeURIComponent(clientOrderId)}`, { method: 'DELETE' })
}

export interface PromotionRecordView {
  id: string
  stage: string
  submittedTs: number
  fitness: { version: string; value: number } | null
  /**
   * 过拟合判定留痕。取代了原先自报的 `wfRobust: boolean`。
   *
   * 只取面板要显示的几个标量；完整凭据（逐折分位等）在
   * `GET /promotions` 的原始记录里，需要复核时从那里取。
   */
  overfit: {
    outcome: string
    summary: string
    pbo: number | null
    avgWinnerW: number | null
    folds: number
    candidates: number
    dataHash: string
  } | null
  paperStats: { firstTradeTs: number | null; trades: number; maxDrawdownPct: number } | null
  approvedBy: string | null
  capUsd: number | null
  history: { ts: number; from: string; to: string; reason: string }[]
}

export interface PromotionsResponse {
  pipelineVersion: string
  records: PromotionRecordView[]
}

export function listPromotions(base: string, token: string): Promise<PromotionsResponse> {
  return orchFetch<PromotionsResponse>(base, token, '/promotions')
}

export async function promotionAction(base: string, token: string, id: string, action: string, body?: Record<string, unknown>): Promise<{ ok: boolean; stage?: string; error?: string }> {
  const res = await fetch(`${base}/promotions/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify(body ?? {}),
  })
  return (await res.json()) as { ok: boolean; stage?: string; error?: string }
}

export interface MetricsView {
  uptimeSec: number
  ts: number
  orders: {
    acked: number
    rejected: number
    rejectTopReasons: { reason: string; count: number }[]
    ackLatencyMs: { p50: number; p95: number; p99: number; max: number; samples: number }
  }
  fills: { paper: number; live: number }
  cancels: number
  killswitchActivations: number
  feed: { symbol: string; lastBarAgeSec: number | null }[]
  wsClients: number
  events: { memoryCount: number }
}

export function getMetrics(base: string, token: string): Promise<MetricsView> {
  return orchFetch<MetricsView>(base, token, '/metrics')
}

export interface SloTargetView {
  key: string
  label: string
  compare: 'lte' | 'gte'
  limit: number
  unit: string
}

export interface AlertWebhookView {
  at: number
  /** 四档互不顶替：没配 / 已送出 / 被白名单拦下 / 没发出去。 */
  outcome: 'not-configured' | 'sent' | 'blocked' | 'failed'
  host: string
  /** 服务端给的那句完整说明。界面直接展示，不重写。 */
  note: string
}

export interface SloView {
  targets: SloTargetView[]
  ts: number
  breaches: { key: string; label: string; value: number; limit: number; unit: string }[]
  values: Record<string, number>
  /**
   * 最近一次告警外发的结果。
   *
   * ★ `null` = **从没触发过告警**（不是"通道正常"）；字段缺失 = 这个端点还没升级。
   *   两者都不许显示成"正常"（判据 C7：缺数据要说出来）。
   */
  alertWebhook?: AlertWebhookView | null
}

export function getSlo(base: string, token: string): Promise<SloView> {
  return orchFetch<SloView>(base, token, '/slo')
}

export interface MirrorStatusView {
  enabled: boolean
  url: string | null
  paused: boolean
  lastLocalSeq: number
  remoteMaxSrcSeq?: number | null
  missing: number
  repairedTotal: number
  originMismatches: number
  lastError: string | null
  lastCheckAt: number | null
}

export function getMirrorStatus(base: string, token: string): Promise<MirrorStatusView> {
  return orchFetch<MirrorStatusView>(base, token, '/mirror/status')
}

export interface SurveillanceFlagView {
  ts: number
  type: 'SELF_TRADE' | 'ORDER_CHURN' | 'SMALL_NOTIONAL_BURST'
  detail: string
}

export interface SurveillanceView {
  config: {
    selfTradeWindowSec: number
    selfTradePriceBps: number
    churnWindowSec: number
    churnCancelRatio: number
    churnMinSubmits: number
    burstWindowSec: number
    burstMinOrders: number
    burstMaxNotionalUsdt: number
    burstMaxTotalUsdt: number
  }
  counters: {
    flaggedSelfTrades: number
    flaggedChurn: number
    flaggedSmallNotionalBursts: number
    trackedFills: number
    trackedOrders: number
    trackedNotionalUsdt: number
  }
  recentFlags: SurveillanceFlagView[]
}

export function getSurveillance(base: string, token: string): Promise<SurveillanceView> {
  return orchFetch<SurveillanceView>(base, token, '/surveillance')
}

export interface SandboxEvalResult {
  ok: boolean
  reason?: string
  strategyId?: string
  fitness?: number
  fitnessVersion?: string
  report?: Record<string, number>
  fills?: number
  stderrTail?: string
}

export async function evaluateSandbox(base: string, token: string, code: string, timeoutMs = 15_000): Promise<SandboxEvalResult> {
  const res = await fetch(`${base}/sandbox/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify({ code, timeoutMs }),
  })
  return (await res.json()) as SandboxEvalResult
}

export interface AutopilotStatusView {
  running: boolean
  stage: string
  mode: string
  symbol: string
  targetPct: number
  baselineEquity: number | null
  equity: number
  pnlPct: number | null
  cycles: number
  barsAccumulated: number
  winner: string | null
  /**
   * 最近一次被过拟合门否决的样本内选择（F-47）。`null` = 尚未发生过拒绝。
   *
   * 前端必须把「门拒绝」与「正在正常累积」区分开：两者 stage 都是 `accumulating`，
   * 只看 stage 会以为系统卡住了，而实际上是「证据还不够，再等等」。
   */
  gateRefusal: {
    at: number
    outcome: 'PASS' | 'REJECT' | 'UNVERIFIABLE'
    summary: string
    bars: number
    folds: number
    pbo: number | null
    retryAtBars: number
  } | null
}

export function getAutopilotStatus(base: string, token: string): Promise<AutopilotStatusView> {
  return orchFetch<AutopilotStatusView>(base, token, '/autopilot')
}

export type VenueStatusState = 'online' | 'configured_offline' | 'not_configured' | 'unsupported' | 'error'

export interface VenueStatusView {
  exchange: 'binance' | 'okx'
  mode: 'testnet' | 'live'
  supported: boolean
  configured: boolean
  attached: boolean
  handshakeComplete: boolean | null
  killswitch: boolean | null
  venueOutboundDisabledReason: string | null
  balanceUsdt: number | null
  status: VenueStatusState
  error: string | null
}

export function getVenueStatuses(base: string): Promise<{ venues: VenueStatusView[] }> {
  return orchFetch<{ venues: VenueStatusView[] }>(base, '', '/venues/status')
}

export function syncVenueLedger(base: string, token: string): Promise<{ ok: boolean; venueCash: number; reason?: string }> {
  return orchFetch(base, token, '/reconciliation/sync-venue', { method: 'POST', body: '{}' })
}

export function autopilotStart(base: string, token: string, targetPct: number): Promise<{ ok: boolean; reason?: string }> {
  return orchFetch(base, token, '/autopilot/start', { method: 'POST', body: JSON.stringify({ targetPct }) })
}

export function autopilotStop(base: string, token: string): Promise<{ ok: boolean }> {
  return orchFetch(base, token, '/autopilot/stop', { method: 'POST', body: JSON.stringify({}) })
}

export interface LlmProviderView {
  id: string
  name: string
  baseUrl: string
  flavor: 'openai' | 'anthropic'
  models: string[]
  activeModel: string | null
  enabled: boolean
  lastProbeAt: number | null
  lastStatus: string
  keyHint: string
}

export function listLlmProviders(base: string): Promise<{ providers: LlmProviderView[] }> {
  return orchFetch(base, '', '/llm/providers')
}

export async function addLlmProvider(base: string, token: string, input: { name?: string; baseUrl: string; apiKey: string; flavor?: 'openai' | 'anthropic' }): Promise<{ ok: boolean; reason?: string; id?: string; models?: string[]; probeStatus?: string }> {
  const res = await fetch(`${base}/llm/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify(input),
  })
  return (await res.json()) as { ok: boolean; reason?: string; id?: string; models?: string[]; probeStatus?: string }
}

export async function llmProviderAction(base: string, token: string, id: string, action: 'probe' | 'select-model' | 'enable', body?: Record<string, unknown>): Promise<{ ok: boolean; models?: string[]; reason?: string }> {
  const res = await fetch(`${base}/llm/providers/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify(body ?? {}),
  })
  return (await res.json()) as { ok: boolean; models?: string[]; reason?: string }
}

export async function removeLlmProvider(base: string, token: string, id: string): Promise<void> {
  await fetch(`${base}/llm/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-orch-token': token },
  })
}

// ─────────────────────────────────────────────────────────────
// 风控参数体系（R20 风控 SSOT 内化）── 供风控管理中心使用
// ─────────────────────────────────────────────────────────────

export interface RiskParamView {
  key: string
  label: string
  desc: string
  group: string
  unit: string
  type: 'int' | 'float'
  min: number
  max: number
  step: number
  displayScale: number
  default: number
}

export interface RiskGroupView {
  id: string
  label: string
  desc: string
}

export interface RiskSchemaView {
  groups: RiskGroupView[]
  params: RiskParamView[]
  values: Record<string, number>
  errors: string[]
}

export interface RiskSuiteView {
  id: string
  name: string
  tagline: string
  desc: string
  values: Record<string, number>
  active: boolean
}

export function getRiskSchema(base: string): Promise<RiskSchemaView> {
  return orchFetch<RiskSchemaView>(base, '', '/risk/schema')
}

export function getRiskSuites(base: string): Promise<{ suites: RiskSuiteView[] }> {
  return orchFetch<{ suites: RiskSuiteView[] }>(base, '', '/risk/suites')
}

export function applyRiskValues(
  base: string,
  token: string,
  body: { values?: Record<string, number>; suiteId?: string },
): Promise<{
  ok: boolean
  source?: string
  /** 发生变化的参数键。 */
  changed?: string[]
  /** 键 + 变更前后值，供界面展示「从多少改到多少」。 */
  transitions?: { key: string; from: number; to: number }[]
  values?: Record<string, number>
  error?: string
}> {
  return orchFetch(base, token, '/risk/env', { method: 'POST', body: JSON.stringify(body) })
}

// ─────────────────────────────────────────────────────────────
// 拦截闸门管线（Fail-Closed 内化）
// ─────────────────────────────────────────────────────────────

export interface InterceptorView {
  id: string
  name: string
  desc: string
  builtin: boolean
  /** 安全地板：不可停用（关掉它等于关掉物理兜底）。 */
  mandatory: boolean
  enabled: boolean
  order: number
}

export interface SandboxStepView {
  id: string
  name: string
  passed: boolean
  reason?: string
  code?: string
}

export interface SandboxResultView {
  name: string
  /** 该场景预期被哪道闸拦下（'—' 表示预期放行）。 */
  expected: string
  actual: string
  verdict: 'pass' | 'unexpected_pass' | 'unexpected_block' | 'wrong_interceptor'
  reason: string
  trail: SandboxStepView[]
}

export function listInterceptors(base: string): Promise<{ interceptors: InterceptorView[] }> {
  return orchFetch<{ interceptors: InterceptorView[] }>(base, '', '/interceptors')
}

export function toggleInterceptor(base: string, token: string, id: string, enabled: boolean): Promise<{ ok: boolean; interceptor?: InterceptorView; error?: string }> {
  return orchFetch(base, token, '/interceptors/toggle', { method: 'POST', body: JSON.stringify({ id, enabled }) })
}

export function reorderInterceptors(base: string, token: string, ids: string[]): Promise<{ ok: boolean; interceptors?: InterceptorView[]; error?: string }> {
  return orchFetch(base, token, '/interceptors/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
}

export function resetInterceptors(base: string, token: string): Promise<{ ok: boolean; interceptors: InterceptorView[] }> {
  return orchFetch(base, token, '/interceptors/reset', { method: 'POST', body: '{}' })
}

export function runInterceptorSandbox(base: string, token: string): Promise<{ total: number; passed: number; results: SandboxResultView[] }> {
  return orchFetch(base, token, '/interceptors/sandbox', { method: 'POST', body: '{}' })
}

// ─────────────────────────────────────────────────────────────
// 自进化宪法红线（心法库）
// ─────────────────────────────────────────────────────────────

export interface LessonView {
  id: string
  category: string
  ruleText: string
  healthScore: number
  enabled: boolean
  createdAt: number
  ttlDays: number
  sampleSize: number
  /** 样本量来源凭据（服务端从审计账本现算）；老记录为 null。 */
  evidence: { source: string; tradeObservations: number } | null
  isBaseline: boolean
  shieldStatus: string
  source: string
}

export interface LessonStatsView {
  total: number
  active: number
  /** 被宪法红线拦下、未入库的提议数。 */
  blocked: number
  /** 健康分衰减到失效阈值的条数。 */
  decayed: number
  avgHealth: number
}

export function getLessons(base: string): Promise<{ lessons: LessonView[]; stats: LessonStatsView }> {
  return orchFetch<{ lessons: LessonView[]; stats: LessonStatsView }>(base, '', '/evolution/lessons')
}

/**
 * 提议一条心法。
 *
 * ★ 注意这里**没有 `sampleSize`** —— 样本量由服务端从审计账本现算，
 * 客户端传什么都不参与判断（原先是 `body.sampleSize ?? 0`，见 DEV_PROGRESS §3.11 F-44）。
 * `evidence` 只是一个自由文本备注，不是证据本身。
 */
export function proposeLesson(
  base: string,
  token: string,
  body: { ruleText: string; category?: string; evidence?: string },
): Promise<{ accepted: boolean; reason: string; lesson?: LessonView }> {
  return orchFetch(base, token, '/evolution/lessons', { method: 'POST', body: JSON.stringify(body) })
}

export function decayLessons(base: string, token: string): Promise<{ ok: boolean; decayed: number; archived: number; stats: LessonStatsView }> {
  return orchFetch(base, token, '/evolution/lessons/decay', { method: 'POST', body: '{}' })
}

export function toggleLesson(base: string, token: string, id: string, enabled: boolean): Promise<{ ok: boolean; lesson?: LessonView; error?: string }> {
  return orchFetch(base, token, '/evolution/lessons/toggle', { method: 'POST', body: JSON.stringify({ id, enabled }) })
}

export function resetLessons(base: string, token: string): Promise<{ ok: boolean; lessons: LessonView[] }> {
  return orchFetch(base, token, '/evolution/lessons/reset', { method: 'POST', body: '{}' })
}

// ─────────────────────────────────────────────────────────────
// 本周期风险预算（内化 R20：提示词口径 == 面板口径 == 引擎口径）
// ─────────────────────────────────────────────────────────────

export interface RiskBriefValues {
  maxConcurrentPositions: number
  maxConcurrentIsAuto: boolean
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

export interface RiskBriefView {
  heading: string
  text: string
  values: RiskBriefValues
}

export function getRiskBrief(base: string): Promise<RiskBriefView> {
  return orchFetch<RiskBriefView>(base, '', '/risk/brief')
}

// ─────────────────────────────────────────────────────────────
// 组合风险预算预留台账（内化 R20 risk_reservation）
// ─────────────────────────────────────────────────────────────

export interface ReservationView {
  id: number
  accountKey: string
  venue: string
  environment: string
  intentId: string
  amountUsdt: number
  state: string
  released: boolean
  /** 是否仍占用预算（判据与 totalReserved 同源） */
  occupying: boolean
  /** 孤儿预留：占用中但本地已无对应开放意图 */
  isOrphan: boolean
  createdAt: string
  updatedAt: string
}

export interface ReservationSummaryView {
  environment: string
  byVenue: Record<string, number>
  grossExposure: number
  unreleased: ReservationView[]
  totalLimitUsdt: number | null
}

export interface ReserveResultView {
  ok?: boolean
  error?: string
  snapshot?: ReservationView
  changed?: boolean
  idempotentReason?: string
}

export interface RecoveryReportView {
  ok: boolean
  orphans: string[]
  skippedNoTimestamp: string[]
  activeCount: number
  activeTotal: number
}

export function getReservations(
  base: string,
  environment?: string,
): Promise<{ reservations: ReservationView[]; totalReserved?: number }> {
  const q = environment ? `?environment=${encodeURIComponent(environment)}` : ''
  return orchFetch(base, '', `/reservations${q}`)
}

export function getReservationSummary(base: string, environment = 'paper'): Promise<ReservationSummaryView> {
  return orchFetch(base, '', `/reservations/summary?environment=${encodeURIComponent(environment)}`)
}

export function reserveRisk(
  base: string,
  token: string,
  body: { accountKey?: unknown; intentId: string; amountUsdt: number; state: string; totalLimitUsdt?: number | null },
): Promise<ReserveResultView> {
  return orchFetch(base, token, '/reservations/reserve', { method: 'POST', body: JSON.stringify(body) })
}

export function releaseRisk(
  base: string,
  token: string,
  body: { accountKey?: unknown; intentId: string; state?: string },
): Promise<ReserveResultView> {
  return orchFetch(base, token, '/reservations/release', { method: 'POST', body: JSON.stringify(body) })
}

export function recoverReservations(
  base: string,
  token: string,
  body: { environment?: string; openIntentIds?: string[] },
): Promise<RecoveryReportView> {
  return orchFetch(base, token, '/reservations/recover', { method: 'POST', body: JSON.stringify(body) })
}

// ─────────────────────────────────────────────────────────────
// 策略政策快照与一键回滚（内化 R20 policy_snapshot）
// ─────────────────────────────────────────────────────────────

export interface UnitFingerprintView {
  unit: string
  label: string
  hash: string
  count: number
  summary: string
}

export interface PolicySnapshotView {
  format: string
  version: number
  fingerprint: string
  createdAt: string
  package: {
    riskParams: Record<string, number>
    lessons: Array<{
      id: string
      enabled: boolean
      ruleText: string
      healthScore: number
      category: string
      ttlDays: number
    }>
    interceptors: Array<{ id: string; enabled: boolean; order: number }>
    llmRouting: { activeId: string | null; activeModel: string | null; enabledIds: string[] }
  }
  units: UnitFingerprintView[]
  note?: string
}

export interface ArchiveEntryView {
  id: string
  fingerprint: string
  createdAt: string
  note?: string
  units: UnitFingerprintView[]
  isCurrent?: boolean
}

export interface RestoreResultView {
  ok: boolean
  id: string
  fingerprint: string
  appliedFingerprint?: string
  changedUnits: string[]
  reason?: string
}

export function getPolicySnapshot(base: string): Promise<{ snapshot: PolicySnapshotView; summary: string }> {
  return orchFetch(base, '', '/policy/snapshot')
}

export function getPolicyArchives(base: string): Promise<{ archives: ArchiveEntryView[]; archiveDir: string }> {
  return orchFetch(base, '', '/policy/archives')
}

export function archivePolicy(
  base: string,
  token: string,
  body: { note?: string; force?: boolean },
): Promise<{ ok: boolean; entry?: ArchiveEntryView; skipped?: boolean; reason?: string }> {
  return orchFetch(base, token, '/policy/archive', { method: 'POST', body: JSON.stringify(body) })
}

export function restorePolicy(base: string, token: string, id: string): Promise<RestoreResultView> {
  return orchFetch(base, token, '/policy/restore', { method: 'POST', body: JSON.stringify({ id }) })
}

export function deletePolicyArchive(base: string, token: string, id: string): Promise<{ ok: boolean }> {
  return orchFetch(base, token, '/policy/archives/delete', { method: 'POST', body: JSON.stringify({ id }) })
}

export function exportPolicy(base: string, id?: string): Promise<Record<string, unknown>> {
  const q = id ? `?id=${encodeURIComponent(id)}` : ''
  return orchFetch(base, '', `/policy/export${q}`)
}

export function importPolicy(
  base: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean
  errors?: string[]
  validated?: boolean
  staged?: string
  archivedExportOfCurrent?: string
  summary?: string
}> {
  return orchFetch(base, token, '/policy/import', { method: 'POST', body: JSON.stringify(payload) })
}

// ─────────────────────────────────────────────────────────────
// 决策证据可观测性（内化 R20 snapshot_observability）
// ─────────────────────────────────────────────────────────────

export interface ObservabilityAuditView {
  total: number
  DYNAMICS_OBSERVED: number
  PARTIAL: number
  PRICE_ONLY: number
  NONE: number
  mathObservable: number
  mathObservableRatio: number
}

export interface ObservabilityView {
  audit: ObservabilityAuditView
  brief: string
  quality: { ok: boolean; reason: string }
  labels: Record<string, string>
  hints: Record<string, string>
}

export function getDecisionsObservability(base: string): Promise<ObservabilityView> {
  return orchFetch(base, '', '/decisions/observability')
}

// ─────────────────────────────────────────────────────────────
// 双通道可信接缝：成本闸门 / 对手方信任 / 跨通道结算 /
// 人类在环审批 / 声称核验 / 上下文预算
//
// 六者共用一个 /trust 前缀，因为它们回答的是同一个问题：
// 「这笔交易凭什么可以自动做出去」。分开看像六个工具，
// 合起来才构成一条可审计的接缝。
// ─────────────────────────────────────────────────────────────

export interface CostBriefView {
  heading: string
  text: string
  values: {
    cexTakerFeeBps: number
    cexMakerFeeBps: number
    cexExpectedSlippageBps: number
    dexLpFeeBps: number
    cexRoundTripBps: number
    dexRoundTripBps: number
    fundingBpsPer8h: number
    dexMaxImpactBps: number
    minEdgeCostMultiple: number
    maxCostShareBps: number
    minViableNotionalUsdt: number
    approvalThresholdUsdt: number
  }
}

export interface CostItemView {
  label: string
  usdt: number
  bps: number
  fixed: boolean
  note?: string
}

export interface CostAssessmentView {
  ok: boolean
  verdict: string
  grossEdgeUsdt: number
  totalCostUsdt: number
  netEdgeUsdt: number
  edgeMultiple: number
  requiredMultiple: number
  costShareBps: number
  maxCostShareBps: number
  reason: string
  requiredNotionalUsdt: number | null
  maxViableNotionalUsdt: number | null
  breakdown: {
    channel: string
    venue: string
    notionalUsdt: number
    items: CostItemView[]
    totalUsdt: number
    totalBps: number
    fixedUsdt: number
    variableUsdt: number
    assumptionsComplete: boolean
    missingAssumptions: string[]
  }
}

export interface CounterpartyRecordView {
  identity: {
    id: string
    channel: string
    venue: string
    chainId?: number
    chainName?: string
    contractAddress?: string
    identitySource: string
  }
  validation: string
  validationNote: string
  reputation: {
    samples: number
    settlementRate: number
    costRealizationRatio: number
    avgSlippageBps: number
    incidents: number
    score: number | null
  }
}

export interface CounterpartySummaryView {
  total: number
  byVerdict: Record<string, number>
  unproven: string[]
  rejected: { id: string; reason: string }[]
}

export interface CounterpartyTrustView {
  id: string
  allowed: boolean
  verdict: string
  sizeMultiplier: number
  reason: string
  record: CounterpartyRecordView | null
}

export interface SettlementObligationView {
  id: string
  intentId: string
  counterpartyId: string
  environment: string
  asset: { symbol: string; chainId: number | null }
  direction: 'receive' | 'deliver'
  amountUsdt: number
  amountAsset: number
  state: string
  note: string
  createdAt: string
}

export interface NettingGroupView {
  assetKey: string
  symbol: string
  domain: string
  totalReceive: number
  totalDeliver: number
  netTotal: number
  selfClearing: boolean
}

export interface NettingView {
  environment: string
  groups: NettingGroupView[]
  crossDomain: { symbol: string; from: string; to: string; amount: number; reason: string }[]
  outstandingTransferUsdt: number
}

export interface SettlementView {
  summary: {
    environment: string
    open: number
    settled: number
    disputed: number
    voided: number
    openAmountUsdt: number
    assets: string[]
  }
  obligations: SettlementObligationView[]
  netting: NettingView
}

export interface ApprovalRequestView {
  id: string
  kind: string
  environment: string
  amountUsdt: number
  dedupeKey: string
  summary: string
  status: string
  requestedAt: string
  expiresAt: string
  decidedBy: string | null
  decisionNote: string | null
}

export interface ApprovalView {
  requests: ApprovalRequestView[]
  summary: { pending: number; approvedUnconsumed: number; expired: number; denied: number }
  alwaysApprovalKinds: string[]
  thresholdUsdt: number
}

export interface ClaimVerdictView {
  claim: { kind: string; text: string; value?: number; direction?: string; timeframe?: string }
  verdict: 'SUPPORTED' | 'CONTRADICTED' | 'UNVERIFIABLE'
  measured: number | string | null
  reason: string
}

export interface ClaimReportView {
  outcome: 'VERIFIED' | 'REJECTED' | 'UNVERIFIED'
  ok: boolean
  fatal: boolean
  supported: number
  contradicted: number
  unverifiable: number
  mathObservable: boolean
  reason: string
  claims: ClaimVerdictView[]
}

export interface TrustOverviewView {
  environment: string
  cost: CostBriefView['values']
  counterparties: CounterpartySummaryView
  settlement: SettlementView['summary']
  approvals: ApprovalView['summary']
}

// ── 下单预检：把「这笔交易凭什么可以出去」在下单**之前**问清楚 ──────────────
//
// ★ 四态**不在前端合并**。前端只负责原样显示：把 `blocked` 与 `unverifiable`
//   合成一个"失败"会让操作者去改一个本来没问题的止盈价
//   （真正该做的是去查行情连接）。判据 25：拒绝三态互不顶替。
export type PrecheckVerdictView = 'pass' | 'blocked' | 'approval_required' | 'unverifiable'

export interface PrecheckLegView {
  id: string
  name: string
  passed: boolean
  detail: string
  code?: string
}

export interface PrecheckResultView {
  verdict: PrecheckVerdictView
  /** 只有 `pass` 是 true。**它是给按钮用的，不是给归因用的** —— 归因看 `verdict`。 */
  submitAllowed: boolean
  summary: string
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  legs: PrecheckLegView[]
  blockers: PrecheckLegView[]
  /** 管线扫到哪就停了 —— `checked` 可能小于 `total`，界面必须显示出来。 */
  pipeline: { checked: number; total: number; blockedBy: string | null; reachedGeometry: boolean }
  approval: { required: boolean; reason: string }
  /** 未评估时为 null（不是零值对象）。 */
  cost:
    | {
        ok: boolean
        verdict: string
        edgeMultiple: number
        requiredMultiple: number
        costShareBps: number
        maxCostShareBps: number
        totalCostUsdt: number
        reason: string
        requiredNotionalUsdt: number | null
        maxViableNotionalUsdt: number | null
      }
    | null
  geometry: { valid: boolean; rr: number; reason?: string; risk?: number; reward?: number } | null
  exposure: {
    grossBeforeUsdt: number
    thisOrderUsdt: number
    grossAfterUsdt: number
    limitUsdt: number | null
    unreleasedCount: number
    overLimit: boolean
  }
  market: {
    price: number
    atr: number
    adx1h?: number
    macroTrend: string
    macroTrendSource: string
    dataQuality: string
    snapshotAt: number | null
    stale: boolean | null
  }
  confidenceUsed: number
  /**
   * 引擎口径的止盈/止损建议（由服务端 `computeStopGeometry` + `deriveStructureTarget` 产出）。
   *
   * ★ 大厅的默认值必须读它，**不许**自己写 `price * 1.03` 这种式子 ——
   *   那正是"同一个事实两份口径"：面板显示 3%、引擎按 ATR 算出 1.9%，
   *   两边都在正常工作，于是没人会发现不一致。
   * 快照缺失或价不可用时为 `null`。
   */
  suggested: {
    stopLoss: number
    takeProfit: number
    stopDistance: number
    stopPct: number
    atrMultiplier: number
    stopBasis: string
    targetBasis: string
  } | null
  assumptions: string[]
  disclosures: string[]
  /**
   * 走势预测在这一笔里的角色。
   *
   * ★ `claims` 与 `outcome` 是**两件事**，界面必须分开显示：
   *   `claims:false` ⇒ 预测没参与这笔决策（**不是**"预测同意了"）；
   *   `claims:true, outcome:null` ⇒ 声称了但没评（取数失败那一支）；
   *   `claims:true, outcome:'no-edge'` ⇒ 预测参与了，并说"没有统计优势"。
   *   把前两种画成同一个绿勾，用户会以为每笔单都有预测背书。
   */
  forecast: {
    claims: boolean
    outcome: 'actionable' | 'no-edge' | 'unverifiable' | null
    gate: string | null
    direction: 'up' | 'down' | null
    target: number | null
    proposal: {
      ok: boolean
      side: 'buy' | 'sell' | null
      entry: number | null
      target: number | null
      lo: number | null
      hi: number | null
      reason: string
    } | null
  }
}

export interface PrecheckOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  entry: number
  takeProfit: number
  stopLoss: number
  confidence?: number
  channel?: 'cex' | 'dex'
  venue?: string
  markPrice?: number
  refresh?: boolean
  /**
   * 这笔单是否**声称以走势预测为依据**。缺省 `false`。
   *
   * ★ 前端只能传这个布尔，**不能传预测结论** —— 结论由服务端现算。
   *   理由：依据是一句凭据，而凭据不能由被审的那一方自己填。
   */
  forecastClaims?: boolean
  forecastHorizonMinutes?: number
}

/**
 * 下单预检。**只读** —— 不改状态、不占台账、不写审批单。
 *
 * ★ 走服务端而不是在浏览器里算：闸门只有一份实现（`interceptors.runPipeline`），
 *   前端自己算一份就是判据 8 说的"同一业务动作两条路径"。
 *   前端在这里的职责只有一个 —— **显示**。
 */
export function precheckOrder(base: string, input: PrecheckOrderInput): Promise<PrecheckResultView> {
  return orchFetch(base, '', '/orders/precheck', { method: 'POST', body: JSON.stringify(input) })
}

export function getCostBrief(base: string): Promise<CostBriefView> {
  return orchFetch(base, '', '/trust/cost/brief')
}

/** 走势图上的一个点：第 `step` 步之后价位的 10/50/90 分位。 */
export interface ForecastPathPointView {
  step: number
  p10: number
  p50: number
  p90: number
}

/**
 * 走势预测的只读视图（`GET /forecast?symbol=&minutes=`）。
 *
 * ── 为什么大厅要自己问一次预测，而不是只用预检返回的那条预测腿 ──────────
 * 屏幕上那张走势图是给人在**下单之前**看的：先看见"未来一小时大概会走到哪、
 * 有多不确定"，人才有依据去决定要不要按这个方向下单。
 * 预检那条腿回答的是**另一个问题** —— "这一单声称以预测为依据，这句话成立吗"，
 * 它只在点了检查之后才有，而且它只给结论、不给分位带（画不出图）。
 *
 * ★ 但两者**必须读同一个 horizon 控件**：`TerminalPage` 把同一个 `fcMinutes`
 *   同时喂给这张图与 `precheck`。若各用各的默认值，屏幕上就会同时出现两个
 *   "未来多久"的数 —— 两个口径不同的数不能放在一起看（判据 31）。
 *
 * ── 这张图为什么是"带"而不是"一条线" ────────────────────────────────────
 * 预测给出的是未来收益的**经验分布**。任何一条单点曲线都是在假装确定，
 * 而带宽本身就是"确定性有多低"的读数。`path` 为空时**不许**画一条平的假线出来
 * （判据 24：说不出来的事要显式说，别用默认值顶）。
 */
export interface ForecastView {
  symbol: string
  barMinutes: number
  horizonBars: number
  /** 预测所站的那根 bar 的时间戳（"as of"）。 */
  asOf: number
  spot: number
  method: string
  /**
   * ★ 三态判决。`no-edge` 不是"算失败"，而是**算成功了、结论是没有优势** ——
   *   界面必须把这两件事分开说，否则用户会把"没有优势"读成"系统坏了"。
   */
  outcome: 'actionable' | 'no-edge' | 'unverifiable'
  gate: string
  direction: 'up' | 'down' | null
  target: number | null
  medianBps: number | null
  interval: { lo: number; hi: number; coverage: number } | null
  path: ForecastPathPointView[]
  netEdgeBps: number | null
  oneWayCostBps: number
  roundTripCostBps: number
  state: { slug: string; nameCn: string; trainIc: number }[]
  sample: { candidates: number; matched: number; separated: number; trainBars: number; testBars: number }
  calibration: {
    anchors: number
    hits: number
    hitRate: number
    baseRate: number
    baseRule: string
    se: number
    edgeZ: number
    pValue: number
    coverageNominal: number
    coverageActual: number
    flatAnchors: number
  } | null
  reasons: { from: string; text: string }[]
  disclosures: string[]
  dataHash: string
  origin: string
  elapsedMs: number
  cache: { hit: boolean; computedAt: number }
}

export interface ForecastResponseView {
  ok: true
  headline: string
  /**
   * 服务端归一出来的分辨率。★ 调用方**不能**自报 `barMinutes` ——
   * 端点只收 `minutes`，由服务端唯一的 `resolveHorizon()` 翻译。
   * `rounded` 为真 = 你要的分钟数对不齐证据底座，被并到最近的一档
   * （例：要 5 分钟，证据只有 15 分钟一根 ⇒ 按 15 分钟给，并**说出来**）。
   */
  horizon: {
    barMinutes: number
    horizonBars: number
    askedMinutes: number
    actualMinutes: number
    rounded: boolean
  }
  result: ForecastView
}

/**
 * 走势预测。**只读** —— 不落盘、不下单、不改任何状态。
 *
 * ★ 参数只有「标的」与「未来多少分钟」两个。分辨率**刻意不可传**：
 *   传错了会去找不存在的历史文件，然后静默回落成合成价格，
 *   而返回里每个字段都看着像真的（判据 13）。端点会明确拒绝这类参数。
 *
 * ★★ 为什么必须传 `token`（原先这里传的是 `''`，界面上是 401）：
 *   `/forecast` 与它的同族 `/factors/index`、`/breadth/index` 一样，
 *   是**服务端现算的分析指数**，路由层要 `authorized(req)`。
 *   我先前只用 `curl -H "x-orch-token: …"` 验过端点，于是"验通了"，
 *   而**真正读它的那条路（界面）一次都没通过** —— 判据 10 的镜像：
 *   「有端点 ≠ 有人读」之外还要加一句「**我用我的凭据测通 ≠ 调用方能读**」。
 *   验证必须走**调用方自己的那条路**，否则验的是另一件事。
 */
export function getForecast(
  base: string,
  token: string,
  input: { symbol: string; minutes: number },
): Promise<ForecastResponseView> {
  const q = new URLSearchParams({ symbol: input.symbol, minutes: String(input.minutes) })
  return orchFetch(base, token, `/forecast?${q.toString()}`)
}

export function assessCost(base: string, input: Record<string, unknown>): Promise<{ assessment: CostAssessmentView }> {
  return orchFetch(base, '', '/trust/cost/assess', { method: 'POST', body: JSON.stringify(input) })
}

export function listCounterparties(
  base: string,
): Promise<{ records: CounterpartyRecordView[]; summary: CounterpartySummaryView }> {
  return orchFetch(base, '', '/trust/counterparties')
}

export function assessCounterparty(
  base: string,
  id: string,
): Promise<{ trust: CounterpartyTrustView; record: CounterpartyRecordView | null }> {
  return orchFetch(base, '', '/trust/counterparties?id=' + encodeURIComponent(id))
}

export function setCounterpartyValidation(
  base: string,
  token: string,
  input: { id: string; status: string; note?: string; by: string },
): Promise<{ ok: boolean; reason: string }> {
  return orchFetch(base, token, '/trust/counterparties/validate', { method: 'POST', body: JSON.stringify(input) })
}

export function getSettlement(base: string, environment = 'paper'): Promise<SettlementView> {
  return orchFetch(base, '', '/trust/settlement?environment=' + encodeURIComponent(environment))
}

export function openSettlementObligation(
  base: string,
  token: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; reason: string; idempotent: boolean }> {
  return orchFetch(base, token, '/trust/settlement/open', { method: 'POST', body: JSON.stringify(input) })
}

export function advanceSettlement(
  base: string,
  token: string,
  input: { id: string; state: string; settledAmountUsdt?: number; note?: string },
): Promise<{ ok: boolean; reason: string }> {
  return orchFetch(base, token, '/trust/settlement/advance', { method: 'POST', body: JSON.stringify(input) })
}

export function reconcileSettlement(
  base: string,
  token: string,
  input: { environment?: string; closedIntents?: { intentId: string; amountUsdt: number }[] },
): Promise<{ findings: { kind: string; severity: string; obligationId: string; reason: string }[]; consistent: boolean }> {
  return orchFetch(base, token, '/trust/settlement/reconcile', { method: 'POST', body: JSON.stringify(input) })
}

export function getApprovals(base: string, status?: string): Promise<ApprovalView> {
  return orchFetch(base, '', '/trust/approvals' + (status ? '?status=' + encodeURIComponent(status) : ''))
}

export function approvalRequires(
  base: string,
  input: { kind: string; environment: string; amountUsdt: number },
): Promise<{ required: boolean; reason: string }> {
  return orchFetch(base, '', '/trust/approvals/requires', { method: 'POST', body: JSON.stringify(input) })
}

export function decideApproval(
  base: string,
  token: string,
  input: { id: string; decision: 'approved' | 'denied'; by: string; note?: string },
): Promise<{ ok: boolean; reason: string }> {
  return orchFetch(base, token, '/trust/approvals/decide', { method: 'POST', body: JSON.stringify(input) })
}

export function approvalGate(
  base: string,
  token: string,
  input: { kind: string; environment: string; amountUsdt: number; dedupeKey: string; summary: string; actor?: string },
): Promise<{ allowed: boolean; approvalId: string | null; approvalRequired: boolean; reason: string }> {
  return orchFetch(base, token, '/trust/approvals/gate', { method: 'POST', body: JSON.stringify(input) })
}

export function validateClaimText(
  base: string,
  input: { text: string; facts?: Record<string, unknown>; requireVerified?: boolean },
): Promise<{ report: ClaimReportView; summary: string; facts: Record<string, unknown> }> {
  return orchFetch(base, '', '/trust/claims/validate', { method: 'POST', body: JSON.stringify(input) })
}

export function getTrustOverview(base: string, environment = 'paper'): Promise<TrustOverviewView> {
  return orchFetch(base, '', '/trust/overview?environment=' + encodeURIComponent(environment))
}

// ───────────────────────── 任务层（mission）─────────────────────────
// 这一层不是"又一个下单入口"：它只做两件事 —— 量目标、发许可。
// 真正动手仍然是 `startAutopilot` 那条老路，所以这里**不需要**任何执行函数。

export type MissionVerdict = 'feasible' | 'infeasible' | 'unverifiable'

/**
 * 四档，不是三档。`hold` = 「我还不知道」，`block` = 「不行」。
 * 面板上这两档必须长得不一样 —— 合成一档就等于把"缺证据"说成"做不成"。
 */
export type MissionSeverity = 'block' | 'hold' | 'warn' | 'info'

export interface MissionReasonView {
  code: string
  severity: MissionSeverity
  text: string
  numbers?: Record<string, number | string | null>
}

export interface MissionSpecView {
  raw: string
  venue: string | null
  execution: string
  symbol: string | null
  startNotional: number | null
  targetNotional: number | null
  targetMultiple: number | null
  deadlineMs: number | null
  allowHighLeverage: boolean
  explicitLeverage: number | null
  missing: string[]
  confidence: number
  matched: string[]
}

export interface MissionSizingView {
  riskBudget: number
  notionalByRisk: number
  notionalByMargin: number
  plannedNotional: number
  binding: string
  minViableNotional: number
  minViableEquity: number | null
  maxSafeLeverage: number
  configuredLeverage: number
}

/** 比率类字段一律是**分数**（0.02 = 2%），不是百分数。见 `MissionPlanView.targetPct` 的反例说明。 */
export interface RequiredTradesView {
  /** 分数。0.02 = 单笔 +2%。 */
  winPct: number
  /** 分数。0.01 = 单笔 -1%。 */
  lossPct: number
  maxLosses: number
  requiredWins: number
  /** 分数。0.643 = 64.3%。 */
  impliedWinRate: number
  winsPerHour: number
}

export interface MissionAlternativeView {
  targetPct: number
  minEquity: number | null
  notes: string[]
}

export interface MissionPlanView {
  planId: string
  assessedAt: number
  spec: MissionSpecView
  verdict: MissionVerdict
  targetMultiple: number | null
  /**
   * ★ **已经是百分数**（12 = +12%），与 `RequiredTradesView` 里的分数**不同口径**。
   *
   * 同一个接口里 `...Pct` 后缀表示两种单位，是这次实测的一个真教训：
   * 面板把 `winPct` 当百分数显示，于是「单笔盈利 +2%」被渲成「+0.02%」，
   * 而那个错值看起来完全像个正常数字。改动这一层时**必须逐字段确认单位**。
   */
  targetPct: number | null
  required: RequiredTradesView | null
  sizing: MissionSizingView | null
  reasons: MissionReasonView[]
  alternative: MissionAlternativeView | null
}

/** 上同：`stopPct` 是分数（0.018 = 1.8%）。 */
export interface MissionEnvView {
  wiredVenue: string
  accountingVenue: string
  equity: number
  /** 分数。0.018 = 止损垫 1.8%。 */
  stopPct: number
  maxSafeLeverage: number
  maxLeverage: number
  overfit: unknown
}

/**
 * 待用口令的**元数据**。有意不含口令码 ——
 * 明文只在签发起的那一刻出现过一次，重取不到（见 `MissionPlanResponse.consent`）。
 */
export interface ConsentMetaView {
  planId: string
  issuedAt: number
  expiresAt: number
  attempts: number
  remainingAttempts: number
  expired: boolean
}

/** 签发结果。`code` 明文只在这一处存在，刷新页面就没了 —— 这是刻意的。 */
export interface StartConsentView extends ConsentMetaView {
  code: string
  /** 给嘴念的形态：各位之间留一个空格（`4 8 2 1`），否则合成语音会念成"四千八百二十一"。 */
  spoken: string
}

export interface MissionPlanResponse {
  isMission: boolean
  planId: string | null
  verdict: MissionVerdict | null
  spec: MissionSpecView
  plan: MissionPlanView | null
  spoken: string
  redaction: { hits: number; hitNames: string[]; refusedNames: string[] }
  consent: StartConsentView | null
}

export interface MissionStatusView {
  env: MissionEnvView
  autopilot: { running: boolean; stage: string; targetPct: number }
  overfitFromLedger: unknown
  targetMaxPct: number
  counts: { plans: number }
  consent: ConsentMetaView | null
}

export interface MissionStartResult {
  ok: boolean
  code?: string
  reason?: string
  plan?: MissionPlanView
  reassessedPlanId?: string
  started?: boolean
  remainingAttempts?: number
}

/**
 * 与 `orchFetch` 同一套请求头与令牌，但**不在 4xx 上抛**，而是把状态码与已解析的 body 一起交回。
 *
 * ★ 只给一类端点用：那些拿 4xx 表达**业务拒绝**而不是"你调用错了"的端点。
 *   把它当异常抛出，调用方手里就只剩一个字符串，于是
 *   「口令不对，还有 2 次机会」会在界面上变成「服务没有回应，去查端口」——
 *   用户会照着这句话去排查一个**不存在**的问题，而真正该做的（重念口令）他不会做。
 *   实测踩到过：口令故意错一位，界面提示却是"编排服务没有回应"。
 */
async function orchFetchResult<T>(
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-orch-token': token, ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    // 非 JSON 的错误体（网关 HTML 之类）不能丢：原样塞进 body，至少能看见它说了什么。
    body = { ok: false, code: 'NON_JSON_BODY', reason: text.slice(0, 200) }
  }
  return { status: res.status, body: body as T }
}

/** 启动结果 + HTTP 状态码。**没有 httpStatus 就无法区分"被拒"与"没连上"**。 */
export interface MissionStartOutcomeView extends MissionStartResult {
  httpStatus: number
}

export function getMissionStatus(base: string, token: string): Promise<MissionStatusView> {
  return orchFetch(base, token, '/mission')
}

/** 裁定结果。`data` 为 null 表示服务端用 4xx 拒绝了这个请求（`errorCode` 是原因）。 */
export interface MissionPlanOutcome {
  httpStatus: number
  data: MissionPlanResponse | null
  /** 机器可判的稳定标识，如 `EMPTY_TEXT` / `TEXT_TOO_LONG` / `UNAUTHORIZED`。 */
  errorCode: string | null
}

/**
 * 裁定一句话。
 *
 * 与 `startMission` 同样**不在 4xx 上抛** —— 理由一样：
 * 「超过 300 字」是一个可以直接照做的提示，不该被包装成"服务没回应"。
 */
export async function planMission(base: string, token: string, text: string): Promise<MissionPlanOutcome> {
  const r = await orchFetchResult<MissionPlanResponse & { error?: string }>(base, token, '/mission/plan', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (r.status === 200) return { httpStatus: r.status, data: r.body, errorCode: null }
  return { httpStatus: r.status, data: null, errorCode: r.body?.error ?? null }
}

/**
 * 启动。**`phrase` 与 `code` 传同一句话**（如「确认启动 4821」）。
 *
 * 这不是偷懒：服务端是自己从整句里抽口令词与口令码的，
 * 语音通道送的就是这样一句话。面板另造一种"已拆好的"入参，
 * 就等于给同一件事开了第二条路 —— 两条路迟早对不上，
 * 而它们对不上的时候表现为"语音能启动、面板不能"，最难查的那类。
 */
export async function startMission(
  base: string,
  token: string,
  input: { planId?: string; utterance: string },
): Promise<MissionStartOutcomeView> {
  const r = await orchFetchResult<MissionStartResult>(base, token, '/mission/start', {
    method: 'POST',
    body: JSON.stringify({ planId: input.planId, phrase: input.utterance, code: input.utterance }),
  })
  // 被拒时服务端会带 `reason`/`code`/`remainingAttempts`，一律原样上抛给界面 ——
  // 界面负责显示，不负责改写。翻译过的拒绝理由会离事实越来越远。
  if (!r.body) {
    // 空响应本身就是一条事实，别让它退化成一个"ok 默认 false"的沉默。
    return { ok: false, code: 'EMPTY_BODY', reason: '编排层回了空响应（HTTP ' + r.status + '）。', httpStatus: r.status }
  }
  return { ...r.body, httpStatus: r.status }
}

// ─────────────────────────────────────────────────────────────────────────────
// 因子生产线（台账 + 策略层筛查）
// ─────────────────────────────────────────────────────────────────────────────

/** 因子台账的一行。字段全来自服务端，前端不做任何加工。 */
export interface FactorIndexRowView {
  slug: string
  nameCn: string
  category: string
  base: string
  transform: string
  window: number
  state: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  reason: string
  /** 判决所依据的数据来源。非 `history` 时**永远不该出现 accepted**（fail-closed）。 */
  origin: string
  /** 判决时那份行情的指纹。与当前行情不同 ⇒ 这行结论已过时。 */
  dataHash: string
  bars: number
  coverage: number
  icMean5: number | null
  icir: number | null
  turnover: number | null
  quantileSpreadBps: number | null
  firstSeenAt: string
  lastEvaluatedAt: string
}

/** 台账概况。`inconsistent` 是判定器升级后遗留的**陈旧判决**条数。 */
export interface FactorIndexSummaryView {
  available: boolean
  total: number
  accepted: number
  rejected: number
  unverifiable: number
  inconsistent: number
  inconsistentReason: string | null
  historyShare: number
  updatedAt: string | null
  reason: string
}

export interface FactorIndexResponse {
  ok: boolean
  damaged: string | null
  summary: FactorIndexSummaryView
  /** **当前**行情的指纹。与某一行的 `dataHash` 不同 ⇒ 那一行的判决已过时。 */
  currentDataHash: string
  /** 判决与自身指标自相矛盾的行（判定器升级后遗留的陈旧判决）。 */
  inconsistentSlugs: string[]
  index: { thresholds: Record<string, number>; horizons: number[]; rows: FactorIndexRowView[]; updatedAt: string }
}

/**
 * 策略层台账的一行：因子**扣掉成本与滑点之后**还赚不赚钱。
 *
 * ★ `worstFoldGrossReturnPct` 与 `worstFoldReturnPct` 必须成对读：
 *   毛正净负 ⇒ 信号有方向、被成本吃掉（该降换手）；毛本身就负 ⇒ 方向不成立。
 *   只有一个数字时，这两种局面长得一模一样。
 */
export interface FactorStrategyRowView {
  slug: string
  sign: 1 | -1 | null
  state: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  reason: string
  trainIc: number | null
  origin: string
  factorDataHash: string
  screenDataHash: string
  /** false ⇒ 这一行的判决是**另一份行情**上做的，已经过时。 */
  dataHashMatch: boolean
  folds: number
  worstFoldReturnPct: number | null
  worstFoldGrossReturnPct: number | null
  costDragPct: number | null
  /**
   * 各折毛收益的**均值**。必须与 `worstFoldGrossReturnPct` 并列读 ——
   * 单折毛收益的 σ≈13% 而均值只有几个百分点，所以"最差折"天然为负，
   * 拿它当判据会把真有边际的策略全判成"方向不成立"（15 轮实测 1/14 vs 11/14）。
   */
  meanFoldGrossReturnPct: number | null
  /** 每笔成交的毛边际 / 成本，单位 bps。**归因唯一判据**：前者 ≤ 0 ⇒ 方向不成立。 */
  meanGrossBpsPerFill: number | null
  meanCostBpsPerFill: number | null
  /** 每折成交笔数均值 —— 上面两个 bps 的**分母来源**。 */
  meanFillsPerFold: number | null
  /** 比例（0..1），**不是**百分数。 */
  winRate: number | null
  closedTrades: number
  signAgreement: number | null
  reverseChecked: boolean
  bothDirectionsPass: boolean
  lastEvaluatedAt: string
}

export interface FactorStrategySummaryView {
  available: boolean
  total: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 其中有几个**当下可用**（指纹与当前行情一致）。 */
  usableNow: number
  stale: number
  updatedAt: string | null
  reason: string
}

export interface FactorStrategyResponse {
  ok: boolean
  damaged: string | null
  summary: FactorStrategySummaryView
  index: { thresholds: Record<string, number>; config: Record<string, unknown>; rows: FactorStrategyRowView[]; updatedAt: string }
}

export function getFactorIndex(base: string, token: string): Promise<FactorIndexResponse> {
  return orchFetch(base, token, '/factors/index')
}

export function getFactorStrategies(base: string, token: string): Promise<FactorStrategyResponse> {
  return orchFetch(base, token, '/factors/strategies')
}

// ─────────────────────────── 横截面（breadth） ───────────────────────────
//
// 因子线的**第三层**。类型与 `server/breadthService.ts` 的 `BreadthRow`
// 逐字段对应，不在这里另起名字：两套名字（`state` vs `outcome`）是这一类
// 接口层最常见的分叉来源 —— 服务端加了字段、前端读旧名，表现是
// **界面上某一格永远空着，而且不报任何错**（判据 11 的一种）。

export interface BreadthRowView {
  slug: string
  nameCn: string
  category: string
  base: string
  transform: string
  window: number
  horizon: number
  outcome: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  reason: string
  headline: string
  panelHash: string
  symbols: number
  panelBars: number
  topK: number
  /** 方向来自**训练段** IC 的符号。`null` = 训练段定不了方向。 */
  sign: 1 | -1 | null
  trainSections: number
  trainMeanIc: number | null
  trainTStat: number | null
  sections: number
  icSkipped: number
  meanIc: number | null
  tStat: number | null
  positiveShare: number | null
  bothDirectionsPass: boolean
  rebalances: number
  skipped: number
  /** 每腿毛边际（bps）。null = 没跑出轮次（**不是 0**）。 */
  grossBpsPerLeg: number | null
  costBpsPerLeg: number
  netBpsPerLeg: number | null
  longBpsPerLeg: number | null
  shortBpsPerLeg: number | null
  marketBpsPerLeg: number | null
  winRate: number | null
  turnoverPerRebalance: number | null
  lastEvaluatedAt: string
}

export interface BreadthPanelFactView {
  origin: string
  symbols: string[]
  bars: number
  from: number
  to: number
  dropped: number
  missing: string[]
  sources: {
    symbol: string
    bars: number
    kept: number
    from: number
    to: number
    contentHash: string
    file: string
  }[]
}

export interface BreadthSummaryView {
  available: boolean
  reason: string
  rows: number
  accepted: number
  rejected: number
  unverifiable: number
  byGate: Record<string, number>
  panelSymbols: number
  panelBars: number
  updatedAt: string
}

export interface BreadthResponse {
  ok: boolean
  damaged: string | null
  summary: BreadthSummaryView
  index: {
    thresholds: Record<string, number>
    /** ★ 只是**最近一次**运行用的配置 —— 台账可同时含多套（同一面板 × 多个持有期）。
     *  逐行配置看 `rows[].horizon` / `rows[].topK`。名字与 `breadthService` 逐字一致。 */
    lastRunConfig: Record<string, unknown>
    panel: BreadthPanelFactView | null
    rows: BreadthRowView[]
    updatedAt: string
  }
}

export function getBreadthIndex(base: string, token: string): Promise<BreadthResponse> {
  return orchFetch(base, token, '/breadth/index')
}

// ─────────────────────────── Agent 舰队 ───────────────────────────
//
// ★ 这些类型刻意与 `server/fleet/service.ts` 的视图**逐字段对应**，而不是
//   在这里另起一套名字。两套名字（`state` vs `status`、`lastRun` vs `last`）
//   是这类"接口层"最常见的分叉来源：服务端加了字段、前端读的是旧名，
//   表现是**界面上一格永远空着**，而且不报任何错。

export interface FleetConsumerView {
  id: string
  label: string
  kind: string
}

export interface FleetAgentView {
  id: string
  label: string
  duty: string
  kind: 'read' | 'act'
  cost: string
  reuses: string
  output: string
  consumers: FleetConsumerView[]
  emits: string[]
  consumes: string[]
  /** `never` 不是"健康"，是"还没跑过" —— 面板必须把它画得与「正常」不同。 */
  state: 'never' | 'ok' | 'failed'
  runCount: number
  okCount: number
  failCount: number
  lastRun: { at: number; ok: boolean; summary: string; durationMs: number; dryRun: boolean } | null
  inbox: { topic: string; msgId: string; from: string; note: string; ts: number }[]
}

export interface FleetProblem {
  /** 机器可判的代号 —— 与 `server/fleet/registry.ts` 的字段名逐字对齐。 */
  code: string
  agentId: string
  problem: string
}

export interface FleetTaskStepView {
  agentId: string
  label: string
  ok: boolean
  summary: string
  reason?: string
  durationMs: number
  inputFrom: string[]
  independent: boolean
  emitted: { topic: string; msgId: string; deliveredTo: string[] }[]
  dryRun: boolean
}

export interface FleetTaskReceiptView {
  taskId: string
  goal: string
  why: string
  steps: FleetTaskStepView[]
  ok: boolean
  failedAt: string | null
  refusal: string | null
  durationMs: number
  ledgerEvents: number
  messageCount: number
}

export interface FleetSnapshotResponse {
  snapshot: {
    generatedAt: number
    registry: { agents: number; problems: FleetProblem[] }
    bus: { topics: number; subscriptions: number; messages: number; subscribers: Record<string, string[]> }
    agents: FleetAgentView[]
    recentMessages: { id: string; topic: string; from: string; ts: number; taskId: string | null }[]
    lastTask: FleetTaskReceiptView | null
    provenance: string
  }
  roster: { id: string; label: string; kind: string; cost: string; duty: string }[]
  topics: { id: string; label: string; kind: string; meaning: string }[]
  consumers: { id: string; label: string; kind: string }[]
  plans: { id: string; label: string; chain: string[]; why: string }[]
}

export interface FleetRunReceiptView {
  agentId: string
  label: string
  ok: boolean
  summary: string
  steps: string[]
  reason?: string
  durationMs: number
  dryRun: boolean
  emitted: { topic: string; msgId: string; deliveredTo: string[] }[]
  inputFrom: string[]
}

export function getFleet(base: string, token: string): Promise<FleetSnapshotResponse> {
  return orchFetch(base, token, '/fleet')
}

export function runFleetAgent(
  base: string,
  token: string,
  input: { agentId: string; arg?: string; confirmed?: boolean; dryRun?: boolean },
): Promise<FleetRunReceiptView> {
  return orchFetch(base, token, '/fleet/run', { method: 'POST', body: JSON.stringify(input) })
}

export function runFleetTask(
  base: string,
  token: string,
  input: { goal: string; confirmed?: boolean; dryRun?: boolean },
): Promise<FleetTaskReceiptView & { brief: string }> {
  return orchFetch(base, token, '/fleet/task', { method: 'POST', body: JSON.stringify(input) })
}

/**
 * 只问"这句话能不能接"，**不执行**。
 *
 * 界面与语音都要在跑之前先问一次 —— 否则用户看到的是系统先动起来、
 * 半秒后才被告知"这个我听不懂"。
 */
export function planFleetTask(
  base: string,
  token: string,
  goal: string,
): Promise<{ ok: boolean; plan: { id: string; label: string; chain: string[] } | null; why: string }> {
  return orchFetch(base, token, '/fleet/plan', { method: 'POST', body: JSON.stringify({ goal }) })
}

export interface FleetLiveState {
  data: FleetSnapshotResponse | null
  error: string | null
  refresh: () => void
}

/**
 * 舰队实况轮询。
 *
 * 失败**不清空已有数据**：舰队页最怕的是"网络抖一下，整页变成一片空"，
 * 用户会以为成员都没了。错误单独放 `error`，界面照旧显示上一份快照并标出
 * "这份数据是 N 秒前的"。
 */
export function useFleet(base: string, token: string, pollMs = 5000): FleetLiveState {
  const [data, setData] = useState<FleetSnapshotResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const res = await getFleet(base, token)
        if (!alive) return
        setData(res)
        setError(null)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    }
    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [base, token, pollMs, tick])

  return { data, error, refresh: () => setTick((n) => n + 1) }
}

// ═══════════════════ 新闻雷达（第十八轮 · 推送面）═══════════════════
//
// 内化来源（GitHub 上几个专业加密新闻雷达的共性做法）：
//   · sentix / chainpulse 的「News Feed + Market Overview」—— 顶部指标 + 可筛条目
//   · nlp3 的「Source Intelligence」—— **按源**统计战绩，用来判断哪个源该留
//   · crypto-sentiment-monitor 的「Real-Time News Ticker / Topic Radar」—— 滚动情报条 + 热度榜
//   · swarm-trading-console.html 的「集群情报流 + KPI 卡带色条 + 人类决策队列」
// 本项目**不抄**它们的 NLP 情感打分：本系统的相关性判据必须是确定性规则
// （`RELEVANCE_TERMS`），否则"为什么觉得这条相关"就答不上来。

export interface NewsItemView {
  id: string
  title: string
  url: string
  source: string
  summary: string
  publishedAt: number | null
  score: number
  matched: string[]
  reasons: string[]
}

export interface NewsSourceStatView {
  id: string
  label: string
  /**
   * `null` = 最近一轮的报告里没有这个源的记录（还没跑过 / 新加的源）。
   *
   * ★ 它**不是** `false`。`false` 是"这一轮没通"（要去查源或换词），
   *   `null` 是"我不知道"（等下一轮）。两种都画成红色会让用户在
   *   系统从没跑过的时候去改一个本来好好的源。
   */
  ok: boolean | null
  /** 这一轮抓了几条。`null` 同 `ok` 的理由 —— 它不是 0。 */
  got: number | null
  /** 从当天速览里数出来的过门条数（累计，不是这一轮）。 */
  kept: number
  scoreSum: number
  avgScore: number
}

export interface NewsTickerHitView {
  ticker: string
  mentions: number
  weighted: number
  samples: string[]
}

export interface NewsProposalRowView {
  noteId: string
  index: number
  at: number
  source: 'model' | 'rules'
  title: string
  evidence: string
  action: string
  risk: 'low' | 'middle' | 'high'
  observations: string[]
  decision: 'approve' | 'reject' | null
  decidedAt: number | null
  decidedBy: string | null
  decisionWhy: string | null
}

export interface NewsPanelResponse {
  latest: NewsItemView[]
  threshold: number
  sources: { id: string; label: string; kind: string; why: string }[]
  sourceStats: NewsSourceStatView[]
  terms: { term: string; weight: number; why: string }[]
  /** `null` 表示读不到榜单 —— 与 `ticks: []`（空榜）是两件事，界面上必须分开画。 */
  trending: { at: number; ticks: NewsTickerHitView[] } | null
  universe: { symbols: string[]; note: string }
  proposals: NewsProposalRowView[]
  pending: number
  pendingSpeech: string
  /**
   * 最近一轮的报告。`null` = 这个工作目录还从来没跑过一轮。
   *
   * ★ 它是各源战绩与"最近一轮速览"时刻的**唯一**来源（服务端那边读的是
   *   `data/news/last-run.json`）。所以界面**不许**在 `null` 时自己编一个 0 ——
   *   "还没跑过"与"跑了但什么都没抓到"是两件事（判据 24）。
   */
  lastRun: { at: number; fetched: number; kept: number; fresh: number; speech: string } | null
  /**
   * 服务端自己那句「跑一轮」的说法（= 自治循环里 `news_watch` 那一项的 `goal`）。
   *
   * ★ 界面**不许**自己拼这句话。拼了之后，按钮跑的东西与定时跑的东西
   *   就不再是同一件事了 —— 而它们长得一模一样，谁也不会发现（判据 8）。
   */
  runGoal: string
  recentEvents: { at: number; kind: string; payload: Record<string, unknown> }[]
}

export function getNews(base: string, token: string, limit = 20): Promise<NewsPanelResponse> {
  return orchFetch<NewsPanelResponse>(base, token, `/fleet/news?limit=${limit}`)
}

// ─────────────────── UI 动作通道（桌宠驱动界面）───────────────────
//
// ★ 这一组与其它端点有一处**结构上的不同**：它的消费者是**界面自己**。
//   界面每 2 秒来取一次"有没有人要你按什么"，按完把结果报回去。
//   于是"桌宠说按一下"与"人手点一下"最终落到同一个 DOM 元素上 ——
//   这就是它存在的全部意义：不给桌宠开一条绕过界面的旁路。

export interface UiActionSpecView {
  id: string
  page: string
  label: string
  writes: boolean
  speaks: string
  /**
   * 这颗按钮接受哪些参数。**只读的说明**，不是校验依据 ——
   * 校验在服务端（那里有行情注册表与预测层），界面这份只是用来
   * 在面板上显示"这一下带的是哪几个参数"。
   */
  payloadKeys?: readonly string[]
}

export interface UiTaskView {
  id: string
  actionId: string
  page: string
  at: number
  requestedBy: string
  status: 'pending' | 'done' | 'failed'
  stale: boolean
  detail?: string
  /**
   * 按这一下时**用什么参数**（如 `{ symbol: 'BTCUSDT', minutes: 60 }`）。
   *
   * ★ 执行器拿它去驱动页面 —— 没有它，桌宠念的是 BTC / 60 分钟，
   *   而界面按下后画的是**屏幕当前选着的**那个标的与尺度。
   *   两个数各自都对，放在一起看没有意义（判据 31）。
   * ★ 键的合法性在服务端就已经校验过（白名单 + 归一），这里拿到的是**归一后**的那一份。
   */
  payload?: Record<string, unknown>
  spec: UiActionSpecView
}

export interface UiActionsView {
  pages: { id: string; label: string }[]
  actions: UiActionSpecView[]
  tasks: UiTaskView[]
  queueSpeech: string
}

export function getUiActions(base: string, token: string): Promise<UiActionsView> {
  return orchFetch<UiActionsView>(base, token, '/ui/actions')
}

export interface UiPendingView {
  tasks: UiTaskView[]
  /** 服务端读队列失败时的原因。**有它就说明这次是"读不到"，不是"没有"。** */
  error?: string
}

/**
 * 取待执行动作。
 *
 * ★ `client` 是**这个窗口**的标识，服务端会把它写进认领记录。
 *   不传的话服务端只能记一个笼统的 `'ui'` —— 于是"两个窗口都在跑"时，
 *   事后查账只能看到"有界面按了它"，**分不出是哪一窗按的**。
 *   多窗口是本系统明确支持的用法（取活即认领就是为了它），
 *   所以认领记录必须能指名到窗 —— 否则出问题时归因不了。
 */
export function getPendingUiActions(base: string, token: string, client: string): Promise<UiPendingView> {
  return orchFetch<UiPendingView>(base, token, `/ui/actions/pending?by=${encodeURIComponent(client)}`)
}

export function postUiActionResult(
  base: string,
  token: string,
  id: string,
  body: { ok: boolean; detail: string; client: string },
): Promise<{ ok: boolean; reason?: string }> {
  return orchFetch<{ ok: boolean; reason?: string }>(base, token, `/ui/actions/${id}/result`, {
    method: 'POST',
    body: JSON.stringify({ ok: body.ok, detail: body.detail, by: body.client }),
  })
}

/**
 * 排一条界面动作。
 *
 * ★ `confirmed` 与新闻裁决那条是同一个约定：`writes: true` 的动作
 *   服务端在没有它时回 422，且这个 true 只能来自人的第二次点击。
 */
export function postUiAction(
  base: string,
  token: string,
  body: { actionId: string; confirmed?: boolean; payload?: Record<string, unknown> },
): Promise<{ ok: boolean; reason?: string; speech?: string; task?: UiTaskView }> {
  return orchFetch(base, token, '/ui/actions', { method: 'POST', body: JSON.stringify(body) })
}

export interface NewsVerdictResult {
  ok: boolean
  writtenTo?: string
  decision?: string
  pending?: number
  speech?: string
  error?: string
  note?: string
}

/**
 * 人对提案拍板。
 *
 * ★ `confirmed` 由调用方显式给 true —— 服务端在没有它时回 422。
 *   界面负责让这个 true 一定来自**第二次**点击（两段式），
 *   而不是把这个字段当成一个可以顺手写上的常量。
 */
export function postNewsVerdict(
  base: string,
  token: string,
  body: { noteId: string; index: number; decision: 'approve' | 'reject'; why?: string; confirmed: boolean },
): Promise<NewsVerdictResult> {
  return orchFetch<NewsVerdictResult>(base, token, '/fleet/news/verdict', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface NewsLiveState {
  data: NewsPanelResponse | null
  error: string | null
  refresh: () => void
}

export function useNews(base: string, token: string, pollMs = 20_000): NewsLiveState {
  const [data, setData] = useState<NewsPanelResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const res = await getNews(base, token)
        if (!alive) return
        setData(res)
        setError(null)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    }
    void poll()
    const t = setInterval(poll, pollMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [base, token, pollMs, tick])

  return { data, error, refresh: () => setTick((n) => n + 1) }
}
