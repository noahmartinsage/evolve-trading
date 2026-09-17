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

export interface SloView {
  targets: SloTargetView[]
  ts: number
  breaches: { key: string; label: string; value: number; limit: number; unit: string }[]
  values: Record<string, number>
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

export function getCostBrief(base: string): Promise<CostBriefView> {
  return orchFetch(base, '', '/trust/cost/brief')
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
