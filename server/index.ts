import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadDotEnv, updateDotEnv } from './loadEnv.ts'
import {
  cancelOrder,
  deactivateKillswitch,
  activateKillswitch,
  getOrchState,
  syncLedgerToVenue,
  onMarketBar,
  processLiveIntent,
  processOrderIntent,
  onPriceTick,
  seedPrice,
} from './core.ts'
import { getEvents, initLedger, eventCount, verifyMemoryChain, chainHead, appendEvent } from './ledger.ts'
import { currentEquity, updateRiskConfig } from './risk.ts'
import type { OrderIntentInput } from './risk.ts'
import { liveGateway } from './gateway/executor.ts'
import { isPersistent, persistSnapshot, queryEvents, getDb, claimInstance, heartbeatInstance, releaseInstance } from './persistence.ts'
import { bindRetentionDb, startRetentionLoop } from './retention.ts'
import { pipelineService } from './pipelineService.ts'
import { computeEvidenceReceipt, evidenceCacheInfo, loadEvidence, warmEvidence } from './evidence.ts'
import { proposals } from './proposals.ts'
import { listProviders, addProvider, removeProvider, probeAndPersist, setActiveModel, setEnabled, bindLlmProvidersDb } from './llmProviders.ts'
import { routerConfigView } from './modelRouter.ts'
import { OkxTestnetAdapter } from './venue/okxTestnet.ts'
import { metrics } from './metrics.ts'
import { verifyPersistedChain } from './audit.ts'
import { generateProposals, measureFacts } from './proposalEngine.ts'
import { evaluateSlo, checkAndAlert, SLO_TARGETS } from './slo.ts'
import { surveillanceSnapshot } from './surveillance.ts'
import { runInSandbox } from './sandbox/index.ts'
import { runReconciliation, getLastReconciliation } from './reconciliation.ts'
import { enableMirror, checkMirror, getStatus as getMirrorStatus } from './mirrorCheck.ts'
import { connectTickerStream } from './feed.ts'
import { configureAutopilot, onAutopilotBar, autopilotStatus, startAutopilot, stopAutopilot } from './autopilot.ts'
import {
  startVoice,
  voiceConfig,
  setVoiceConfig,
  voiceStatus,
  handleUtterance,
  interruptVoice,
  drainNarrations,
  voiceOnPriceTick,
  dailyBrief,
  ttsEngineView,
  synthesizeForVoice,
  missionGoalContext,
} from './voice/service.ts'
import { missionStatusView, planMission, startMissionByPlan } from './mission/service.ts'
import { SandboxAdapter } from './venue/sandbox.ts'
import { CexTestnetAdapter } from './venue/cexTestnet.ts'
import type { VenueAdapter, BalanceSnapshot } from './venue/types.ts'
import type { RiskConfig } from './types.ts'
import type { Candle } from '../src/engine/index.ts'
import { schema, currentValues, normalize, SUITES, suiteValues, validateCurrent } from './riskConfig.ts'
import type { RiskEnvKey } from './riskConstants.ts'
import { reloadRiskConstants } from './riskConstants.ts'
import {
  listInterceptors,
  setInterceptorEnabled,
  reorderInterceptors,
  resetInterceptors,
  runSandboxTest,
} from './interceptors.ts'
import { loadLessons, lessonStats, proposeLesson, decayLessons, setLessonEnabled, resetToBaseline, lessonEvidenceFromEvents } from './evolutionShield.ts'
import { getReservationManager, STATE_CLOSED } from './riskReservation.ts'
import { RISK_BRIEF_HEADING, renderRiskBrief, riskBriefSnapshot } from './riskBrief.ts'
// ── 成本硬约束与可信执行（内化：成本闸门 / 对手方信任 / 跨通道结算 / 人类在环 / 声称核验 / 上下文预算）──
import {
  COST_BRIEF_HEADING,
  renderCostBrief,
  costBriefSnapshot,
  assessEdge,
  estimateCost,
  liveCexCostInput,
} from './costModel.ts'
import type { CostInput } from './costModel.ts'
import { getCounterpartyRegistry } from './counterpartyRegistry.ts'
import { getSettlementLedger } from './settlementLedger.ts'
import { getApprovalGate, requiresApproval, ALWAYS_APPROVAL_KINDS } from './approvalGate.ts'
import { validateClaims, extractClaims, summarizeReport } from './claimValidator.ts'
import type { MeasuredFacts } from './claimValidator.ts'
import { assembleContext, renderBudgetReport, DEFAULT_CONTEXT_BUDGET_TOKENS } from './contextBudget.ts'
import type { ContextBlock } from './contextBudget.ts'
import {
  archiveCurrentPolicy,
  archiveDir,
  deleteArchive,
  exportPolicyPackage,
  formatPolicySnapshotSummary,
  getCurrentPolicySnapshot,
  listArchives,
  restoreArchivedPolicy,
  validateImportPackage,
} from './policySnapshot.ts'
import type { PolicyUnit } from './policySnapshot.ts'
import { auditSnapshotObservability, isSampleQualitySufficient, renderObservabilityBrief, OBSERVABILITY_LABEL, OBSERVABILITY_HINT } from './decisionObservability.ts'
import { installCrashGuard } from './crashGuard.ts'

loadDotEnv()

// ★ 遗言机制，尽量排在最前面：本文件是纯主模块（没有任何脚本 import 它），
//   所以这里挂 handler 不会污染测试进程。挂在 loadDotEnv 之后、
//   其它初始化之前 —— `seedHistory()` / `attachVenue()` / 镜像互查里的任何一处抛出，
//   都要能留下可分辨的证据（否则与"被 taskkill 打死"在父进程侧完全同形，见 crashGuard.ts）。
installCrashGuard('orch')

// 以小博大：允许通过环境变量放宽单笔名义上限（受晋升/资金帽与熔断约束）
if (process.env.RISK_MAX_NOTIONAL_USD) {
  getOrchState().risk.maxNotionalPerOrder = Number(process.env.RISK_MAX_NOTIONAL_USD)
}

const PORT = Number(process.env.PORT ?? 8787)
const SYMBOLS = (process.env.ORCH_SYMBOLS ?? 'ETHUSDT,BTCUSDT').split(',').map((s) => s.trim().toUpperCase())
const INTERVAL = process.env.ORCH_INTERVAL ?? '1m'
const REST = process.env.BINANCE_REST ?? 'https://data-api.binance.vision'
const ALLOWED_ORIGIN = process.env.ORCH_ALLOWED_ORIGIN ?? '*'

// 密钥治理（C6）：生产环境必须显式提供令牌，fail-closed 拒绝启动
if (process.env.NODE_ENV === 'production' && (!process.env.ORCH_TOKEN || process.env.ORCH_TOKEN === 'dev-insecure-token')) {
  console.error('❌ NODE_ENV=production 要求显式设置 ORCH_TOKEN')
  process.exit(1)
}
const TOKEN = process.env.ORCH_TOKEN ?? 'dev-insecure-token'

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function authorized(req: import('node:http').IncomingMessage): boolean {
  return req.headers['x-orch-token'] === TOKEN
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

const startedAt = Date.now()

function cors(res: import('node:http').ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-orch-token')
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  try {
    if (url.pathname === '/healthz') {
      const s = getOrchState()
      return json(res, 200, { ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), killswitch: s.killswitch, mode: s.mode })
    }

    if (url.pathname === '/state') {
      const s = getOrchState()
      return json(res, 200, {
        mode: s.mode,
        killswitch: s.killswitch,
        balanceUSDC: Math.round(s.balanceUSDC * 100) / 100,
        equity: Math.round(currentEquity(s) * 100) / 100,
        peakEquity: Math.round(s.peakEquity * 100) / 100,
        positions: [...s.positions.values()],
        orders: s.orders.slice(0, 50),
        risk: s.risk,
        lastPrice: Object.fromEntries(s.lastPrice),
      })
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') ?? '0')
      if (isPersistent()) {
        const rows = queryEvents(Number.isFinite(since) ? since : 0)
        return json(res, 200, { events: rows.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) })) })
      }
      return json(res, 200, { events: getEvents(Number.isFinite(since) ? since : 0) })
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const intent = JSON.parse(await readBody(req)) as OrderIntentInput & { mode?: 'paper' | 'live'; strategyId?: string }
      if (intent.mode === 'live') {
        const outcome = await processLiveIntent({ ...intent, strategyId: intent.strategyId ?? '' })
        return json(res, outcome.ok ? 200 : 422, outcome)
      }
      const outcome = processOrderIntent(intent)
      return json(res, outcome.ok ? 200 : 422, outcome)
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/orders/')) {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const id = decodeURIComponent(url.pathname.slice('/orders/'.length))
      const ok = cancelOrder(id)
      return json(res, ok ? 200 : 404, { ok })
    }

    if (url.pathname === '/gateway/status') {
      return json(res, 200, liveGateway.status())
    }

    if (url.pathname === '/venues/status') {
      const venues = await gatherVenueStatuses()
      return json(res, 200, { venues })
    }

    if (url.pathname === '/mirror/status') {
      return json(res, 200, getMirrorStatus())
    }

    if (req.method === 'POST' && url.pathname === '/mirror/check') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const st = await checkMirror()
      return json(res, 200, st)
    }

    if (url.pathname === '/surveillance') {
      return json(res, 200, surveillanceSnapshot())
    }

    // Autopilot（paper 面全自动循环：挖掘→门禁→执行→目标追踪）
    if (url.pathname === '/autopilot') {
      return json(res, 200, autopilotStatus())
    }

    if (req.method === 'POST' && url.pathname === '/autopilot/start') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { targetPct?: number }
      const r = await startAutopilot(Number(body.targetPct ?? 2))
      return json(res, r.ok ? 200 : 422, r)
    }

    if (req.method === 'POST' && url.pathname === '/autopilot/stop') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      stopAutopilot('manual stop')
      return json(res, 200, { ok: true })
    }

    if (url.pathname === '/reconciliation') {
      return json(res, 200, getLastReconciliation())
    }

    if (req.method === 'POST' && url.pathname === '/reconciliation/run') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const report = await runReconciliation(getOrchState(), liveGateway)
      return json(res, 200, report)
    }

    if (req.method === 'POST' && url.pathname === '/reconciliation/clear-stop') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      liveGateway.setVenueOutboundDisabled(null)
      appendEvent('RECONCILIATION_CLEARED', {})
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/reconciliation/sync-venue') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const r = await syncLedgerToVenue()
      return json(res, r.ok ? 200 : 422, r)
    }

    if (url.pathname === '/metrics') {
      return json(res, 200, metrics.snapshot({ gateway: liveGateway.status(), eventMemoryCount: eventCount() }))
    }

    if (url.pathname === '/audit/verify') {
      const memory = verifyMemoryChain()
      const persisted = isPersistent() && getDb()
        ? verifyPersistedChain(getDb() as unknown as { prepare(sql: string): { all(...args: unknown[]): unknown[] } })
        : { ok: true, checked: 0, brokenAtSeq: null, scope: 'sqlite-skipped' }
      return json(res, 200, { ok: memory.ok && persisted.ok, memory, persisted, head: chainHead() })
    }

    if (req.method === 'POST' && url.pathname === '/proposals') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      let raw: unknown
      try {
        raw = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { ok: false, reason: 'INVALID_JSON' })
      }
      const verdict = proposals.receive(raw)
      return json(res, verdict.ok ? 200 : 422, verdict)
    }

    if (req.method === 'GET' && url.pathname === '/proposals') {
      const since = Number(url.searchParams.get('since') ?? '0')
      return json(res, 200, { proposals: proposals.list(Number.isFinite(since) ? since : 0) })
    }
    if (req.method === 'POST' && url.pathname === '/proposals/call') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      let raw: unknown
      try {
        raw = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { ok: false, reason: 'INVALID_JSON' })
      }
      const v = await proposals.callModel(raw as import('./proposals.ts').ModelCallParams)
      return json(res, v.ok ? 200 : 422, v)
    }

    if (req.method === 'POST' && url.pathname === '/proposals/generate') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as { source?: 'llm' | 'human'; maxProposals?: number }
      const result = await generateProposals(getOrchState(), body)
      return json(res, 200, result)
    }

    // LLM 厂商注册表（C-6/E5：自定义厂商 + 自动识别可用模型）
    if (url.pathname === '/llm/providers' && req.method === 'GET') {
      return json(res, 200, { providers: listProviders() })
    }

    // 模型分层路由视图：贵/免费分层、付费开关与额度快照。
    // 只读且不触发任何模型调用 —— 展示当前成本口径，不产生成本。
    if (url.pathname === '/llm/router' && req.method === 'GET') {
      return json(res, 200, routerConfigView())
    }

    // 过拟合门禁的证据视图。
    // 三个作用：① 让"门禁到底拿哪批行情在判"可见（origin/bars/dataHash）；
    // ② 让 PBO / 赢家分位 / 逐折明细可查，而不是只有一个"通过与否"；
    // ③ `?compute=1` 时现算（会走 20 秒，但结果进缓存），
    //    否则只报缓存状态 —— 只读探测不应该让服务器卡 20 秒。
    if (url.pathname === '/gate/overfit' && req.method === 'GET') {
      const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT'
      if (url.searchParams.get('compute') === '1') {
        const ev = computeEvidenceReceipt(symbol, undefined, undefined, undefined, url.searchParams.get('refresh') === '1')
        return json(res, 200, {
          evidence: ev.evidence,
          elapsedMs: ev.elapsedMs,
          verdict: { outcome: ev.verdict.outcome, pass: ev.verdict.pass, summary: ev.verdict.summary },
          receipt: ev.receipt,
          purity: ev.purity,
          aggregate: ev.result.aggregate,
          folds: ev.result.folds.map((f) => ({
            fold: f.fold,
            bestId: f.bestId,
            isFitness: f.isFitness,
            oosFitness: f.oosFitness,
            oosFieldMean: f.oosFieldMean,
            winnerAscRank: f.winnerAscRank,
            winnerW: f.winnerW,
            selectionEdge: f.selectionEdge,
            candidates: f.candidates,
          })),
        })
      }
      const ev = loadEvidence(symbol)
      return json(res, 200, {
        evidence: { origin: ev.origin, symbol: ev.symbol, bars: ev.bars, gaps: ev.gaps, dataHash: ev.dataHash },
        cache: evidenceCacheInfo(),
        hint: '加 ?compute=1 现算（约 20 秒，结果进缓存）；?refresh=1 强制重算',
      })
    }

    if (req.method === 'POST' && url.pathname === '/llm/providers') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { name?: string; baseUrl?: string; apiKey?: string; flavor?: 'openai' | 'anthropic' }
      const r = addProvider({ name: body.name, baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), flavor: body.flavor })
      if (!r.ok) return json(res, 422, r)
      const probe = await probeAndPersist(r.id as string)
      return json(res, 200, { ...r, models: probe.models, probeStatus: probe.reason ?? 'OK' })
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/llm/providers/')) {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const id = decodeURIComponent(url.pathname.slice('/llm/providers/'.length))
      return json(res, removeProvider(id) ? 200 : 404, { ok: true })
    }

    if (req.method === 'POST' && url.pathname.startsWith('/llm/providers/')) {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const rest = url.pathname.slice('/llm/providers/'.length)
      const segs = rest.split('/')
      const id = decodeURIComponent(segs[0])
      const action = segs[1] ?? ''
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as Record<string, unknown>
      try {
        if (action === 'probe') {
          const r = await probeAndPersist(id)
          return json(res, r.ok ? 200 : 422, { ok: r.ok, models: r.models, reason: r.reason })
        }
        if (action === 'select-model') {
          const r = setActiveModel(id, String(body.model ?? ''))
          return json(res, r.ok ? 200 : 422, r)
        }
        if (action === 'enable') {
          return json(res, 200, { ok: setEnabled(id, Boolean(body.enabled)) })
        }
        return json(res, 404, { error: `UNKNOWN_ACTION:${action}` })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message.slice(0, 140) : 'LLM_ACTION_ERROR' })
      }
    }

    if (url.pathname === '/slo') {
      const evaluation = evaluateSlo(metrics.snapshot({ gateway: liveGateway.status(), eventMemoryCount: eventCount() }))
      return json(res, 200, { targets: SLO_TARGETS, ...evaluation })
    }

    if (req.method === 'POST' && url.pathname === '/slo/check') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const result = await checkAndAlert(metrics.snapshot({ gateway: liveGateway.status(), eventMemoryCount: eventCount() }))
      return json(res, 200, result)
    }

    if (req.method === 'POST' && url.pathname === '/sandbox/evaluate') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { code?: string; candles?: Candle[]; timeoutMs?: number }
      const result = await runInSandbox(String(body.code ?? ''), body.candles, Math.min(Math.max(body.timeoutMs ?? 10_000, 2_000), 30_000))
      return json(res, result.ok ? 200 : 422, result)
    }

    if (url.pathname === '/promotions' && req.method === 'GET') {
      return json(res, 200, { records: pipelineService.list() })
    }

    if (req.method === 'POST' && url.pathname.startsWith('/promotions/')) {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const parts = url.pathname.split('/').filter(Boolean)
      const id = decodeURIComponent(parts[1] ?? '')
      const action = parts[2] ?? ''
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as Record<string, unknown>
      try {
        if (action === 'submit') {
          const rec = pipelineService.submit(id)
          return json(res, 200, { ok: true, stage: rec.stage })
        }
        pipelineService.get(id)
        let stage: string
        switch (action) {
          case 'gate': {
            // ⚠️ 过拟合凭据与同质化判定**都由服务端从证据数据现算**，
            // 不再从请求体读取。改造前这三项分别是
            // `Boolean(body.wfRobust)` / `Boolean(body.purityHomogeneous)`
            // 以及请求体里的 fitnessValue，前端把它们一并硬编码成"能过"的值
            // —— 于是三道门一起失效。这是 F-34 的真因。
            const ev = computeEvidenceReceipt(
              typeof body.symbol === 'string' ? body.symbol : 'BTCUSDT',
              undefined,
              undefined,
              undefined,
              body.refreshEvidence === true,
            )
            stage = String(pipelineService.evaluateGate(id, {
              fitnessValue: Number(body.fitnessValue),
              fitnessVersion: typeof body.fitnessVersion === 'string' ? body.fitnessVersion : undefined,
              overfit: ev.receipt,
              purityHomogeneous: ev.purity.homogeneous,
            }))
            break
          }
          case 'paper-trade':
            pipelineService.recordPaperTrade(id)
            stage = pipelineService.get(id).stage
            break
          case 'close-paper':
            pipelineService.closePaper(id, Number(body.drawdownPct ?? 0))
            stage = pipelineService.get(id).stage
            break
          case 'approve':
            pipelineService.approve(id, String(body.approver ?? ''))
            stage = pipelineService.get(id).stage
            break
          case 'promote-full':
            pipelineService.promoteFull(id)
            stage = pipelineService.get(id).stage
            break
          case 'rollback':
            pipelineService.rollback(id, String(body.reason ?? ''))
            stage = pipelineService.get(id).stage
            break
          case 'restore':
            pipelineService.restoreFromRollback(id)
            stage = pipelineService.get(id).stage
            break
          default:
            return json(res, 404, { error: `UNKNOWN_ACTION:${action}` })
        }
        return json(res, 200, { ok: true, stage })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : 'PIPELINE_ERROR' })
      }
    }

    // 运行时风控配置：此前 maxNotionalPerOrder 只能通过环境变量在启动时设置，
    // 调一次额度就要重启（会中断已运行数十小时的 autopilot）。这里开放运行时调整。
    if (req.method === 'GET' && url.pathname === '/risk/config') {
      const s0 = getOrchState()
      return json(res, 200, { risk: s0.risk })
    }

    if (req.method === 'POST' && url.pathname === '/risk/config') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as Partial<RiskConfig>
      const s1 = getOrchState()
      const before = { ...s1.risk }
      // 只允许调整数值型风控项，且必须为正有限数，避免误传把风控关掉
      const patch: Partial<RiskConfig> = {}
      const numKeys = ['maxNotionalPerOrder', 'maxOrdersPerMinute', 'maxDrawdownPct', 'priceDeviationBps'] as const
      for (const k of numKeys) {
        const v = (body as Record<string, unknown>)[k]
        if (v === undefined) continue
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return json(res, 422, { error: `INVALID_${k}` })
        ;(patch as Record<string, number>)[k] = n
      }
      if (Object.keys(patch).length === 0) return json(res, 422, { error: 'NO_VALID_FIELD' })
      updateRiskConfig(s1, patch)
      return json(res, 200, { ok: true, before, after: s1.risk })
    }

    // ── 风控参数体系（内化 R20 的「风控 SSOT + 预设套件」）─────────────────
    // 设计要点：schema 与当前值分两个端点返回。schema 是**静态契约**（前端据此渲染表单、
    // 显示单位与合法区间），currentValues 是**运行时事实**。合并成一个端点会让前端无法
    // 区分「参数没配」与「参数被配成了默认值」——这两件事在风控上是完全不同的状态。
    if (req.method === 'GET' && url.pathname === '/risk/schema') {
      const s = schema()
      return json(res, 200, {
        groups: s.groups,
        params: s.params,
        values: currentValues(),
        errors: validateCurrent(),
      })
    }

    if (req.method === 'GET' && url.pathname === '/risk/suites') {
      return json(res, 200, {
        suites: SUITES.map((x) => ({
          id: x.id,
          name: x.name,
          tagline: x.tagline,
          desc: x.desc,
          values: x.values,
          active: suiteMatches(x.id),
        })),
      })
    }

    // ── 本周期风险预算（内化 R20 的「提示词口径 == 代码口径」）────────────
    // 返回结构化值 + 已渲染好的提示词块。两者必须同源：面板展示的口径
    // 与插值进 LLM 提示词的口径只要不同步，就会出现「页面说 2.5、模型按 2.0 提案」
    // 这类看不见的分裂，所以这里直接复用 renderRiskBrief。
    if (req.method === 'GET' && url.pathname === '/risk/brief') {
      // poolSize 传标的池容量：把「自动跟随池容量」解析成模型能理解的确定数字，
      // 否则「0 笔」会被读成「不许持仓」——一个把自动写成禁止的口径分裂。
      const poolSize = SYMBOLS.length
      return json(res, 200, {
        heading: RISK_BRIEF_HEADING,
        text: renderRiskBrief(new Date(), poolSize),
        values: riskBriefSnapshot(poolSize),
      })
    }

    // ═══════════════════════════════════════════════════════════════
    // 双通道可信接缝（内化 2026-09 情报：成本闸门 / 对手方信任 /
    // 跨通道结算 / 人类在环审批 / 声称核验 / 上下文预算）
    //
    // 六者共同回答同一个问题：**「这笔交易凭什么可以自动做出去」**。
    // 拆开看每个都像一个独立工具，合起来才是一条可审计的接缝——
    // 所以端点的路径也放在同一个 /trust 前缀下，而不是散在各处。
    // ═══════════════════════════════════════════════════════════════

    // ── 成本口径：面板与提示词同源 ────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/trust/cost/brief') {
      return json(res, 200, {
        heading: COST_BRIEF_HEADING,
        text: renderCostBrief(),
        values: costBriefSnapshot(),
      })
    }

    // ── 成本闸门试算：给定一笔打算做的交易，问它值不值得做 ──────────────
    // 刻意做成「试算」而不是「只读口径」：口径本身没有判断力，
    // 能回答 PASS / 拒绝原因才让人真的用得上它。
    if (req.method === 'POST' && url.pathname === '/trust/cost/assess') {
      const body = JSON.parse(await readBody(req)) as Partial<CostInput> & { channel?: 'cex' | 'dex' }
      const channel = body.channel === 'dex' ? 'dex' : 'cex'
      // 场所名按通道给出各自的默认值：两个通道的成本结构不同（一处 LP 费 + 冲击 + 桥费，
      // 一处 taker 费 + 订单簿滑点），把 DEX 的试算标成 "binance"
      // 会让面板上出现一条看起来属于 CEX 的成本记录。
      const defaultVenue = channel === 'dex' ? 'uniswap-v3' : (process.env.AUTOPILOT_VENUE ?? 'binance')
      const base: CostInput = {
        channel,
        venue: typeof body.venue === 'string' && body.venue ? body.venue : defaultVenue,
        notionalUsdt: Number(body.notionalUsdt ?? 0),
        expectedEdgeBps: Number(body.expectedEdgeBps ?? 0),
        holdingHours: body.holdingHours === undefined ? undefined : Number(body.holdingHours),
        poolDepthUsdt: body.poolDepthUsdt === undefined ? undefined : Number(body.poolDepthUsdt),
        expectedSlippageBps: body.expectedSlippageBps === undefined ? undefined : Number(body.expectedSlippageBps),
        bridgeFeeUsdt: body.bridgeFeeUsdt === undefined ? undefined : Number(body.bridgeFeeUsdt),
        chainGasUsdt: body.chainGasUsdt === undefined ? undefined : Number(body.chainGasUsdt),
        isTaker: body.isTaker === undefined ? true : Boolean(body.isTaker),
      }
      // CEX 未显式给滑点时，装配器补上同源假设；显式给了就用给的（便于对照实验）。
      const input =
        channel === 'cex' && body.expectedSlippageBps === undefined
          ? liveCexCostInput({
              venue: base.venue,
              notionalUsdt: base.notionalUsdt,
              expectedEdgeBps: base.expectedEdgeBps,
              holdingHours: base.holdingHours,
            })
          : base
      const assessment = assessEdge(input)
      return json(res, 200, {
        assessment,
        breakdown: estimateCost(input),
      })
    }

    // ── 对手方身份/声誉/验证三档信任 ──────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/trust/counterparties') {
      const reg = getCounterpartyRegistry()
      const id = url.searchParams.get('id')
      if (id) return json(res, 200, { trust: reg.assess(id), record: reg.get(id) })
      return json(res, 200, { records: reg.list(), summary: reg.summary() })
    }

    if (req.method === 'POST' && url.pathname === '/trust/counterparties/settlement') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        id?: string
        ok?: boolean
        expectedCostUsdt?: number
        realizedCostUsdt?: number
        slippageBps?: number
        /** 事故标签（字符串）。空/缺省 = 无事故；给标签比给布尔更能解释「为什么扣分」。 */
        incident?: string
      }
      if (!body.id) return json(res, 400, { error: 'MISSING_ID' })
      const r = getCounterpartyRegistry().recordSettlement(body.id, {
        ok: Boolean(body.ok),
        expectedCostUsdt: Number(body.expectedCostUsdt ?? 0),
        realizedCostUsdt: Number(body.realizedCostUsdt ?? 0),
        slippageBps: Number(body.slippageBps ?? 0),
        incident: body.incident || undefined,
      })
      return json(res, r.ok ? 200 : 400, r)
    }

    if (req.method === 'POST' && url.pathname === '/trust/counterparties/validate') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { id?: string; status?: string; note?: string; by?: string }
      if (!body.id || !body.status) return json(res, 400, { error: 'MISSING_ID_OR_STATUS' })
      // 不在这里把 status 强转成合法值：非法值应当被如实拒绝并说明，
      // 而不是被悄悄纠正成一个看起来合法的状态（那会让调用方以为它成功了）。
      const r = getCounterpartyRegistry().setValidation(
        body.id,
        body.status as 'verified' | 'unverified' | 'quarantined',
        body.note ?? '',
        body.by ?? 'unknown',
      )
      return json(res, r.ok ? 200 : 400, r)
    }

    // ── 跨通道结算义务台账（净额 + 对账）──────────────────────────────
    if (req.method === 'GET' && url.pathname === '/trust/settlement') {
      const env = url.searchParams.get('environment') ?? 'paper'
      const ledger = getSettlementLedger()
      return json(res, 200, {
        summary: ledger.summary(env),
        obligations: ledger.list(env),
        // 净额报告**按 (symbol, domain) 分组**：USDC@8453 与 USDC@cex 绝不合并。
        // 把「不同域的同名资产」加总，是跨通道结算里最容易犯、也最贵的一个错。
        netting: ledger.netting(env),
      })
    }

    if (req.method === 'POST' && url.pathname === '/trust/settlement/open') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        intentId?: string
        counterpartyId?: string
        environment?: 'paper' | 'live'
        asset?: { symbol?: string; chainId?: number | null }
        direction?: 'receive' | 'deliver'
        amountUsdt?: number
        amountAsset?: number
        estimatedCostUsdt?: number
        note?: string
      }
      if (!body.intentId || !body.counterpartyId || !body.asset?.symbol || !body.direction) {
        return json(res, 400, { error: 'MISSING_FIELDS', required: ['intentId', 'counterpartyId', 'asset.symbol', 'direction'] })
      }
      const r = getSettlementLedger().openObligation({
        intentId: body.intentId,
        counterpartyId: body.counterpartyId,
        environment: body.environment ?? 'paper',
        asset: { symbol: body.asset.symbol, chainId: body.asset.chainId ?? null },
        direction: body.direction,
        amountUsdt: Number(body.amountUsdt ?? 0),
        amountAsset: body.amountAsset === undefined ? undefined : Number(body.amountAsset),
        estimatedCostUsdt: body.estimatedCostUsdt === undefined ? undefined : Number(body.estimatedCostUsdt),
        note: body.note,
      })
      return json(res, r.ok ? 200 : 400, r)
    }

    if (req.method === 'POST' && url.pathname === '/trust/settlement/advance') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        id?: string
        state?: string
        settledAmountUsdt?: number
        note?: string
      }
      if (!body.id || !body.state) return json(res, 400, { error: 'MISSING_ID_OR_STATE' })
      const r = getSettlementLedger().advance(body.id, body.state as 'open' | 'settling' | 'settled' | 'disputed' | 'void', {
        settledAmountUsdt: body.settledAmountUsdt === undefined ? undefined : Number(body.settledAmountUsdt),
        note: body.note,
      })
      return json(res, r.ok ? 200 : 400, r)
    }

    if (req.method === 'POST' && url.pathname === '/trust/settlement/reconcile') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        environment?: string
        closedIntents?: { intentId: string; amountUsdt: number }[]
      }
      const report = getSettlementLedger().reconcile(body.environment ?? 'paper', body.closedIntents ?? [])
      return json(res, 200, report)
    }

    // ── 人类在环审批闸门 ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/trust/approvals') {
      const status = url.searchParams.get('status') as 'pending' | 'approved' | 'denied' | 'expired' | null
      const gate = getApprovalGate()
      gate.expireStale()
      return json(res, 200, {
        requests: gate.list(status ? { status } : {}),
        summary: gate.summary(),
        alwaysApprovalKinds: [...ALWAYS_APPROVAL_KINDS],
        thresholdUsdt: costBriefSnapshot().approvalThresholdUsdt,
      })
    }

    // 先问「要不要审批」，再决定要不要发起动作 —— 顺序不能反。
    if (req.method === 'POST' && url.pathname === '/trust/approvals/requires') {
      const body = JSON.parse(await readBody(req)) as { kind?: string; environment?: string; amountUsdt?: number }
      const r = requiresApproval(
        (body.kind ?? '') as never,
        body.environment === 'live' ? 'live' : 'paper',
        Number(body.amountUsdt ?? 0),
      )
      return json(res, 200, r)
    }

    if (req.method === 'POST' && url.pathname === '/trust/approvals/decide') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        id?: string
        decision?: 'approved' | 'denied'
        by?: string
        note?: string
      }
      if (!body.id || !body.decision) return json(res, 400, { error: 'MISSING_ID_OR_DECISION' })
      const r = getApprovalGate().decide(body.id, body.decision, body.by ?? '', body.note ?? '')
      return json(res, r.ok ? 200 : 400, r)
    }

    if (req.method === 'POST' && url.pathname === '/trust/approvals/gate') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        kind?: string
        environment?: string
        amountUsdt?: number
        dedupeKey?: string
        summary?: string
        detail?: Record<string, unknown>
        actor?: string
      }
      if (!body.dedupeKey || !body.summary) return json(res, 400, { error: 'MISSING_DEDUPE_KEY_OR_SUMMARY' })
      const r = getApprovalGate().gate({
        kind: (body.kind ?? '') as never,
        environment: body.environment === 'live' ? 'live' : 'paper',
        amountUsdt: Number(body.amountUsdt ?? 0),
        dedupeKey: body.dedupeKey,
        summary: body.summary,
        detail: body.detail,
        actor: body.actor,
      })
      return json(res, 200, r)
    }

    // ── 声称核验：把「模型说的」与「实测的」对起来 ──────────────────────
    // 三态结果（已验证 / 已否决 / 未验证）刻意都走 200：
    // 「核不了」是一种有效的裁决结果，不是一次请求失败。
    if (req.method === 'POST' && url.pathname === '/trust/claims/validate') {
      const body = JSON.parse(await readBody(req)) as {
        text?: string
        facts?: MeasuredFacts
        candles?: Candle[]
        requireVerified?: boolean
      }
      const text = body.text ?? ''
      const claims = extractClaims(text)
      // 事实来源二选一：显式给 facts（用于回放），或给 candles 由服务端派生（与提案引擎同源）。
      const facts: MeasuredFacts = body.facts ?? (body.candles ? measureFacts(body.candles) : {})
      const report = validateClaims(text, facts, { requireVerified: body.requireVerified ?? true })
      return json(res, 200, { report, summary: summarizeReport(report), extracted: claims, facts })
    }

    // ── 上下文预算装配：让「这轮提示词有没有被裁」成为可回溯事实 ────────
    if (req.method === 'POST' && url.pathname === '/trust/context/assemble') {
      const body = JSON.parse(await readBody(req)) as {
        blocks?: ContextBlock[]
        budgetTokens?: number
        render?: boolean
      }
      if (!Array.isArray(body.blocks)) return json(res, 400, { error: 'MISSING_BLOCKS' })
      const budget = body.budgetTokens === undefined ? DEFAULT_CONTEXT_BUDGET_TOKENS : Number(body.budgetTokens)
      const assembled = assembleContext(body.blocks, budget)
      return json(res, 200, {
        includedIds: assembled.includedIds,
        droppedIds: assembled.droppedIds,
        truncatedIds: assembled.truncatedIds,
        estimatedTokens: assembled.estimatedTokens,
        budgetTokens: assembled.budgetTokens,
        ok: assembled.ok,
        failureReason: assembled.failureReason,
        report: renderBudgetReport(assembled),
        text: body.render === false ? undefined : assembled.text,
      })
    }

    // ── 汇总：一条接缝的整体健康度 ────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/trust/overview') {
      const env = url.searchParams.get('environment') ?? 'paper'
      const gate = getApprovalGate()
      gate.expireStale()
      return json(res, 200, {
        environment: env,
        cost: costBriefSnapshot(),
        counterparties: getCounterpartyRegistry().summary(),
        settlement: getSettlementLedger().summary(env),
        approvals: gate.summary(),
      })
    }

    // ── 风险预算预留台账（内化 R20 risk_reservation）─────────────────────
    if (req.method === 'GET' && url.pathname === '/reservations') {
      const env = url.searchParams.get('environment') ?? undefined
      const rm = getReservationManager()
      const all = rm.reservations(env ? { venue: '', environment: env } : undefined)
      // environment 维度过滤走 listUnreleased 更准确（account_key 里的 venue 分段可能为空）
      const list = env ? all.filter((r) => r.environment === env) : all
      return json(res, 200, {
        reservations: list,
        totalReserved: env ? undefined : list.filter((r) => !r.released).reduce((a, r) => a + r.amountUsdt, 0),
      })
    }

    if (req.method === 'GET' && url.pathname === '/reservations/summary') {
      const env = url.searchParams.get('environment') ?? 'paper'
      const rm = getReservationManager()
      const byVenue = rm.totalReservedByVenue(env)
      return json(res, 200, {
        environment: env,
        byVenue,
        grossExposure: rm.grossExposure(env),
        unreleased: rm.listUnreleased(env),
        totalLimitUsdt: rm.totalLimitUsdt,
      })
    }

    if (req.method === 'POST' && url.pathname === '/reservations/reserve') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        accountKey?: unknown
        intentId?: string
        amountUsdt?: number
        state?: string
        totalLimitUsdt?: number | null
      }
      if (!body.intentId || !body.state) return json(res, 422, { error: 'MISSING_INTENT_OR_STATE' })
      try {
        const r = getReservationManager().reserve(
          body.accountKey ?? { venue: 'local', environment: 'paper' },
          body.intentId,
          body.amountUsdt ?? 0,
          body.state,
          body.totalLimitUsdt,
        )
        appendEvent('RESERVATION_RESERVED', {
          intentId: r.snapshot.intentId,
          state: r.snapshot.state,
          amountUsdt: r.snapshot.amountUsdt,
          changed: r.changed,
        })
        return json(res, 200, r)
      } catch (e) {
        // 越界与非法状态都是 422：它们都是「请求本身不合法」，不是服务端故障。
        // 区分二者的价值在于：调用方能据此判断该重试还是该改参数。
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'RESERVE_FAILED' })
      }
    }

    if (req.method === 'POST' && url.pathname === '/reservations/release') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { accountKey?: unknown; intentId?: string; state?: string }
      if (!body.intentId) return json(res, 422, { error: 'MISSING_INTENT' })
      try {
        const r = getReservationManager().release(body.accountKey ?? { venue: 'local', environment: 'paper' }, body.intentId, body.state ?? STATE_CLOSED)
        appendEvent('RESERVATION_RELEASED', { intentId: r.snapshot.intentId, state: r.snapshot.state })
        return json(res, 200, r)
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'RELEASE_FAILED' })
      }
    }

    // 重启恢复：把「占用中但无对应开放意图」的预留标记孤儿。**只标记不释放**。
    if (req.method === 'POST' && url.pathname === '/reservations/recover') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { environment?: string; openIntentIds?: string[] }
      const report = getReservationManager().recoverOrphans(body.environment, body.openIntentIds ?? [])
      appendEvent('RESERVATIONS_RECOVERED', {
        environment: body.environment ?? null,
        orphans: report.orphans.length,
        activeCount: report.activeCount,
        activeTotal: report.activeTotal,
      })
      return json(res, 200, { ok: true, ...report })
    }

    // ── 策略政策快照与回滚（内化 R20 policy_snapshot）───────────────────
    if (req.method === 'GET' && url.pathname === '/policy/snapshot') {
      const snap = getCurrentPolicySnapshot()
      return json(res, 200, { snapshot: snap, summary: formatPolicySnapshotSummary(snap) })
    }

    if (req.method === 'GET' && url.pathname === '/policy/archives') {
      return json(res, 200, { archives: listArchives(), archiveDir: archiveDir() })
    }

    if (req.method === 'POST' && url.pathname === '/policy/archive') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { note?: string; force?: boolean }
      const out = archiveCurrentPolicy(body.note, { skipIfUnchanged: !body.force })
      appendEvent('POLICY_ARCHIVED', {
        id: out.entry?.id ?? null,
        fingerprint: out.entry?.fingerprint ?? null,
        skipped: out.skipped ?? false,
        note: body.note ?? null,
      })
      return json(res, 200, out)
    }

    // 一键回滚。回灌跨越四条通道，故由本层注入 apply；回滚后再采一次指纹比对，
    // 避免「写了但没生效」被当成成功。
    if (req.method === 'POST' && url.pathname === '/policy/restore') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { id?: string }
      if (!body.id) return json(res, 422, { error: 'MISSING_ARCHIVE_ID' })
      const out = restoreArchivedPolicy(body.id, (snap) => {
        const changed: PolicyUnit[] = []
        // ① 风控参数：先校验后落盘，整批拒绝语义与 /risk/env 保持一致
        const strMap = normalize(snap.package.riskParams as unknown as Record<string, unknown>, currentValues())
        updateDotEnv(strMap)
        reloadRiskConstants()
        changed.push('riskParams')
        // ② 心法库：只恢复「启用状态」，不删改规则文本——
        //    规则文本是宪法红线的审查产物，回滚配置不应绕开那层审查。
        for (const l of snap.package.lessons) {
          try {
            setLessonEnabled(l.id, l.enabled)
          } catch {
            /* 归档中的心法可能已被删除，跳过 */
          }
        }
        changed.push('lessons')
        // ③ 拦截闸门：恢复启用状态；顺序若与当前不一致则一并还原
        for (const i of snap.package.interceptors) {
          try {
            setInterceptorEnabled(i.id, i.enabled)
          } catch {
            /* 拦截器可能已不存在 */
          }
        }
        const restoredOrder = [...snap.package.interceptors].sort((a, b) => a.order - b.order).map((i) => i.id)
        try {
          reorderInterceptors(restoredOrder)
        } catch {
          /* 顺序还原失败不阻断其余单元 */
        }
        changed.push('interceptors')
        // ④ 模型路由：只恢复「激活模型」与启用集合，绝不动 API Key
        if (snap.package.llmRouting.activeId && snap.package.llmRouting.activeModel) {
          setActiveModel(snap.package.llmRouting.activeId, snap.package.llmRouting.activeModel)
        }
        for (const p of listProviders()) {
          setEnabled(p.id, snap.package.llmRouting.enabledIds.includes(p.id))
        }
        changed.push('llmRouting')
        return changed
      })
      appendEvent('POLICY_RESTORED', {
        id: out.id,
        targetFingerprint: out.fingerprint,
        appliedFingerprint: out.appliedFingerprint ?? null,
        ok: out.ok,
        changedUnits: out.changedUnits,
      })
      return json(res, out.ok ? 200 : 422, out)
    }

    if (req.method === 'POST' && url.pathname === '/policy/archives/delete') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { id?: string }
      if (!body.id) return json(res, 422, { error: 'MISSING_ARCHIVE_ID' })
      const ok = deleteArchive(body.id)
      appendEvent('POLICY_ARCHIVE_DELETED', { id: body.id, ok })
      return json(res, ok ? 200 : 404, { ok })
    }

    if (req.method === 'GET' && url.pathname === '/policy/export') {
      const id = url.searchParams.get('id') ?? undefined
      try {
        return json(res, 200, exportPolicyPackage(id ?? undefined))
      } catch (e) {
        return json(res, 404, { error: e instanceof Error ? e.message : 'EXPORT_FAILED' })
      }
    }

    // 导入只做校验与归档，不直接回灌：外部 JSON 不应有权直接改风控闸门。
    if (req.method === 'POST' && url.pathname === '/policy/import') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      const v = validateImportPackage(body)
      if (!v.ok || !v.snapshot) return json(res, 422, { ok: false, errors: v.errors })
      const out = archiveCurrentPolicy(`imported:${v.snapshot.fingerprint}`, { skipIfUnchanged: false })
      appendEvent('POLICY_IMPORTED', {
        sourceFingerprint: v.snapshot.fingerprint,
        archivedAs: out.entry?.id ?? null,
      })
      // 返回需回灌的包与校验结果，由调用方显式调 /policy/restore 才生效
      return json(res, 200, {
        ok: true,
        validated: true,
        staged: v.snapshot.fingerprint,
        archivedExportOfCurrent: out.entry?.id ?? null,
        summary: formatPolicySnapshotSummary(v.snapshot),
      })
    }

    // ── 决策证据可观测性（内化 R20 snapshot_observability）───────────────
    // 从事件流里取出所有开仓决策，按证据完整度分档，并给出样本质量是否
    // 足以支撑心法提炼的裁决。这让「复盘样本好不好」变成可度量的量。
    if (req.method === 'GET' && url.pathname === '/decisions/observability') {
      const events = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_POSITION_OPENED')
      // payload 在账本里已是对象（appendEvent 接收 Record），无需再 JSON.parse
      const records = events.map((e) => e.payload as Record<string, unknown>)
      const audit = auditSnapshotObservability(records)
      const quality = isSampleQualitySufficient(audit, { minSamples: 6 })
      return json(res, 200, {
        audit,
        brief: renderObservabilityBrief(audit),
        quality,
        labels: OBSERVABILITY_LABEL,
        hints: OBSERVABILITY_HINT,
      })
    }

    // 写入风控参数（单参数或整套）。**先校验后落盘**，任一项非法则整批拒绝——
    // 部分写入会制造出「半套风控」，比不写更危险。
    if (req.method === 'POST' && url.pathname === '/risk/env') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { values?: Record<string, unknown>; suiteId?: string }
      try {
        const before = currentValues()
        const raw = body.suiteId ? suiteValues(body.suiteId) : (body.values ?? {})
        if (Object.keys(raw).length === 0) return json(res, 422, { error: 'NO_VALID_FIELD' })
        const strMap = normalize(raw as Record<string, unknown>, before)
        updateDotEnv(strMap)
        // 关键第二步：把新值推进**进程内**的常量绑定。
        // 只写 .env 不重载，引擎会继续按旧值运行到下次重启为止——
        // 这一窗口期正是「面板显示已改、实际没生效」的来源。
        reloadRiskConstants()
        const after = currentValues()
        const changed = Object.keys(strMap).filter((k) => before[k as keyof typeof before] !== after[k as keyof typeof after])
        // 返回「键 + 变更前后值」而不只是键列表：前端要展示「从 0.01 调到 0.005」，
        // 只给键名会让用户无法确认自己到底改了多少，而这正是风控最需要可核对的地方。
        const transitions = changed.map((k) => ({
          key: k,
          from: before[k as keyof typeof before],
          to: after[k as keyof typeof after],
        }))
        appendEvent('RISK_PARAMS_UPDATED', {
          source: body.suiteId ? `suite:${body.suiteId}` : 'manual',
          changedCount: changed.length,
          changed: transitions,
        })
        console.log(`[risk] 风控参数已更新（${body.suiteId ? '套件 ' + body.suiteId : '手动'}）：${changed.length} 项生效`)
        return json(res, 200, { ok: true, source: body.suiteId ?? 'manual', changed, transitions, values: after })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'RISK_VALIDATION_FAILED' })
      }
    }

    // ── 拦截闸门管线（内化 R20 的 Fail-Closed 拦截器）─────────────────────
    // 注意这里对拦截器做了**显式投影**而不是直接返回对象：拦截器自带 check 函数，
    // 直接 JSON.stringify 会把不可序列化的字段静默丢掉，前端拿到的字段集随实现漂移。
    // 显式列出契约字段，才不会「改个内部实现前端就少一个字段」。
    if (req.method === 'GET' && url.pathname === '/interceptors') {
      return json(res, 200, { interceptors: interceptorView() })
    }

    if (req.method === 'POST' && url.pathname === '/interceptors/toggle') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { id?: string; enabled?: boolean }
      if (!body.id || typeof body.enabled !== 'boolean') return json(res, 422, { error: 'INVALID_PAYLOAD' })
      try {
        const next = setInterceptorEnabled(body.id, body.enabled)
        appendEvent('INTERCEPTOR_TOGGLED', { id: next.id, enabled: next.enabled })
        return json(res, 200, { ok: true, interceptor: projectInterceptor(next) })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'TOGGLE_FAILED' })
      }
    }

    if (req.method === 'POST' && url.pathname === '/interceptors/reorder') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { ids?: string[] }
      if (!Array.isArray(body.ids)) return json(res, 422, { error: 'INVALID_PAYLOAD' })
      try {
        const list = reorderInterceptors(body.ids)
        appendEvent('INTERCEPTORS_REORDERED', { ids: list.map((x) => x.id) })
        return json(res, 200, { ok: true, interceptors: list.map(projectInterceptor) })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'REORDER_FAILED' })
      }
    }

    if (req.method === 'POST' && url.pathname === '/interceptors/reset') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      resetInterceptors()
      appendEvent('INTERCEPTORS_RESET', {})
      return json(res, 200, { ok: true, interceptors: interceptorView() })
    }

    // 沙箱单测：用构造场景验证每个拦截器「该拦的拦住了、不该拦的放行」。
    // 这是风控上线前的**唯一可执行证据**——没有它，拦截器配置只是声明。
    if (req.method === 'POST' && url.pathname === '/interceptors/sandbox') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const result = runSandboxTest()
      appendEvent('INTERCEPTORS_SANDBOX_RUN', {
        passed: result.passed,
        failed: result.total - result.passed,
        total: result.total,
      })
      return json(res, 200, result)
    }

    // ── 自进化宪法红线（心法库）───────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/evolution/lessons') {
      return json(res, 200, { lessons: loadLessons(), stats: lessonStats() })
    }

    if (req.method === 'POST' && url.pathname === '/evolution/lessons') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as {
        ruleText?: string
        category?: string
        /** @deprecated 客户端自报的样本量。**已停用**（见 DEV_PROGRESS §3.11 F-44）。 */
        sampleSize?: number
        evidence?: string
      }
      if (!body.ruleText) return json(res, 422, { error: 'MISSING_RULETEXT' })

      // ★ 样本量由服务端从审计账本现算，**请求体里的 sampleSize 不参与判断**。
      // 原先是 `sampleSize: body.sampleSize ?? 0` —— 门禁吃调用方自报的数字，
      // 写 9999 就能把"单笔偶发插针"登记成"9999 笔证据"（F-44，与 F-41 同病）。
      // 现在客户端若仍在传，就把它记进审计：自报值本身是"有人在试探证据门槛"的信号。
      const ledgerEvidence = lessonEvidenceFromEvents(getEvents())
      const out = proposeLesson({
        ruleText: body.ruleText,
        category: String(body.category ?? ''),
        evidence: ledgerEvidence,
        source: body.evidence,
      })
      appendEvent('EVOLUTION_LESSON_PROPOSED', {
        accepted: out.accepted,
        reason: out.reason,
        ruleText: body.ruleText.slice(0, 200),
        evidenceSource: ledgerEvidence.source,
        tradeObservations: ledgerEvidence.tradeObservations,
        ...(body.sampleSize !== undefined ? { clientDeclaredSampleSize: body.sampleSize } : {}),
      })
      return json(res, out.accepted ? 200 : 422, out)
    }

    if (req.method === 'POST' && url.pathname === '/evolution/lessons/decay') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const result = decayLessons()
      appendEvent('EVOLUTION_LESSONS_DECAYED', { archived: result.archived.length, decayed: result.decayed.length })
      return json(res, 200, { ok: true, ...result, stats: lessonStats() })
    }

    if (req.method === 'POST' && url.pathname === '/evolution/lessons/toggle') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { id?: string; enabled?: boolean }
      if (!body.id || typeof body.enabled !== 'boolean') return json(res, 422, { error: 'INVALID_PAYLOAD' })
      try {
        return json(res, 200, { ok: true, lesson: setLessonEnabled(body.id, body.enabled) })
      } catch (e) {
        return json(res, 422, { ok: false, error: e instanceof Error ? e.message : 'TOGGLE_FAILED' })
      }
    }

    if (req.method === 'POST' && url.pathname === '/evolution/lessons/reset') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const list = resetToBaseline()
      appendEvent('EVOLUTION_LESSONS_RESET', { count: list.length })
      return json(res, 200, { ok: true, lessons: list })
    }

    if (req.method === 'POST' && url.pathname === '/killswitch') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { active?: boolean }
      if (body.active) {
        const cancelled = activateKillswitch()
        return json(res, 200, { killswitch: true, cancelledOrders: cancelled })
      }
      deactivateKillswitch()
      return json(res, 200, { killswitch: false })
    }

    if (req.method === 'POST' && url.pathname === '/gateway/cancel-all') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const n = await liveGateway.cancelAllAtVenue()
      appendEvent('VENUE_CANCEL_ALL', { cancelledOrders: n })
      return json(res, 200, { ok: n >= 0, cancelledOrders: n })
    }

    // ───────────────────────────── 任务层 ─────────────────────────────
    // 任务层**不新开交易通道**：裁定只产出一份"能不能做 + 为什么"的结论，
    // 启动仍然落到 `startAutopilot` —— 与面板上的「开始」是同一个函数。
    // 这一点是硬的：一个能自己启动自治循环的新入口，如果它也自己下单，
    // 就等于给系统加了第二条风控之外的通路。
    if (req.method === 'GET' && url.pathname === '/mission') {
      return json(res, 200, missionStatusView())
    }

    if (req.method === 'POST' && url.pathname === '/mission/plan') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { text?: string }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length === 0) return json(res, 422, { error: 'EMPTY_TEXT' })
      // 300 字上限：一段超过 300 字的"目标"本来就该被拆开说清楚，
      // 而且裁定结论是要被念出来的，源文本越长越容易把澄清与目标混在一起。
      if (text.length > 300) return json(res, 422, { error: 'TEXT_TOO_LONG', limit: 300 })
      const r = planMission(text, missionGoalContext())
      return json(res, 200, {
        isMission: r.isMission,
        planId: r.plan?.planId ?? null,
        verdict: r.plan?.verdict ?? null,
        spec: r.spec,
        plan: r.plan,
        spoken: r.spoken,
        // 只回计数与**变量名**，永远不回值 —— 见 mission/asset.ts 的说明
        redaction: { hits: r.redaction.hits, hitNames: r.redaction.hitNames, refusedNames: r.redaction.refusedNames },
        // 启动口令。**这是它唯一一次以明文出现的地方**（见 mission/consent.ts）。
        // 只有 `feasible` 才有 —— 前端据此决定要不要渲染启动入口。
        consent: r.consent,
      })
    }

    if (req.method === 'POST' && url.pathname === '/mission/start') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { planId?: string; phrase?: string; code?: string }
      const planId = typeof body.planId === 'string' ? body.planId.trim() : undefined
      const phrase = typeof body.phrase === 'string' ? body.phrase.trim() : ''
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      // 口令缺失一律 422 早退：**不放行"没给口令但别的地方也许能过"这条路**。
      // 面板少传一个字段就变成"能启动"，那才是真正的漏洞形态。
      if (!phrase || !code) return json(res, 422, { error: 'CONSENT_REQUIRED', need: ['phrase', 'code'] })
      const r = await startMissionByPlan({ planId, phrase, code }, missionGoalContext())
      return json(res, r.ok ? 200 : 422, r)
    }

    // ───────────────────────── 实时语音交互层 ─────────────────────────
    // 语音层不新开执行通道：`/voice/utterance` 里的下单最终仍然走
    // `processOrderIntent` / `processLiveIntent`，与界面上点按钮是同一条路。

    if (req.method === 'GET' && url.pathname === '/voice/config') {
      return json(res, 200, voiceConfig())
    }

    if (req.method === 'POST' && url.pathname === '/voice/config') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as Parameters<typeof setVoiceConfig>[0]
      const r = setVoiceConfig(body)
      return json(res, r.ok ? 200 : 422, r)
    }

    if (req.method === 'GET' && url.pathname === '/voice/state') {
      return json(res, 200, voiceStatus())
    }

    if (req.method === 'GET' && url.pathname === '/voice/daily') {
      return json(res, 200, dailyBrief())
    }

    /**
     * 合成引擎状态。
     *
     * 暴露它是因为"音色太生硬"这个抱怨有两个完全不同的成因：
     * 云端神经引擎降级了，或者用户只是选了个不合口味的音色。
     * 面板必须能区分这两者 —— 否则用户会反复点音色按钮，
     * 而问题根本不在那里。
     */
    if (req.method === 'GET' && url.pathname === '/voice/engine') {
      return json(res, 200, ttsEngineView())
    }

    /**
     * 神经合成：返回 MP3 字节流。
     *
     * ★ 失败时返回 502 + 结构化原因，**而不是**静默给一段空音频：
     * 前端据此明确退回浏览器合成，并在面板上说明"这次是退回的"。
     * 静默降级的后果是用户以为音色选项失效 —— 那正是这次要修的抱怨之一。
     *
     * 文本长度上限 600 字：一段超过 600 字的播报本来就该被拆开念，
     * 而且这个接口是逐字合成的，长文本会让延迟线性上涨。
     */
    if (req.method === 'POST' && url.pathname === '/voice/tts') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { text?: string; voiceId?: string; rate?: number }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length === 0) return json(res, 422, { error: 'EMPTY_TEXT' })
      if (text.length > 600) return json(res, 422, { error: 'TEXT_TOO_LONG', limit: 600 })
      const r = await synthesizeForVoice(text, { voiceId: body.voiceId, rate: body.rate })
      if (!r.ok) return json(res, 502, r)
      res.writeHead(200, {
        'content-type': r.mime,
        'content-length': String(r.audio.length),
        'cache-control': 'no-store',
        'x-tts-engine': 'neural',
        'x-tts-latency-ms': String(r.latencyMs),
      })
      res.end(r.audio)
      return
    }

    if (req.method === 'POST' && url.pathname === '/voice/utterance') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse(await readBody(req)) as { text?: string }
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim().length === 0) return json(res, 422, { error: 'EMPTY_UTTERANCE' })
      const r = await handleUtterance(text)
      // 400 表示"没执行"（被打断或解析不出来），200 表示轮次正常结束。
      // 被打断的轮次仍返回 200 但带 dropped=true —— 前端必须据此**不要**念出来。
      return json(res, 200, r)
    }

    if (req.method === 'POST' && url.pathname === '/voice/interrupt') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse((await readBody(req)) || '{}') as { reason?: string }
      return json(res, 200, interruptVoice(body.reason ?? 'USER_BARGE_IN'))
    }

    /**
     * SSE 播报通道：服务端 → 客户端的单向推送。
     *
     * 用 SSE 而不是复用既有的 `/ws` WebSocket，是因为 `/ws` 已经被 2 秒一次的
     * 状态广播占用，而 `ws` 库在同端口挂两个带 `path` 的 WebSocketServer 会
     * 在 upgrade 事件上互相摘掉对方的连接（"谁先拿到 upgrade 谁处理"）。
     * 播报是纯单向的，SSE 语义正好，也不必处理重连升级。
     */
    if (req.method === 'GET' && url.pathname === '/voice/stream') {
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': evolve voice stream open\n\n')
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        send('status', voiceStatus())
        const timer = setInterval(() => {
          const lines = drainNarrations(20)
          if (lines.length > 0) send('narration', lines)
          else res.write(': ping\n\n')
        }, 1_000)
        req.on('close', () => {
          clearInterval(timer)
          try {
            res.end()
          } catch {
            /* 客户端已断开 */
          }
        })
      } catch {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
      return
    }

    json(res, 404, { error: 'NOT_FOUND' })
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message.slice(0, 200) : 'BAD_REQUEST' })
  }
})

/** 拦截器 → 前端契约投影（剥离 check 闭包，只留可序列化的展示字段）。 */
function projectInterceptor(i: ReturnType<typeof listInterceptors>[number]) {
  return {
    id: i.id,
    name: i.name,
    desc: i.desc,
    builtin: i.builtin,
    mandatory: i.mandatory,
    enabled: i.enabled,
    order: i.order,
  }
}

function interceptorView() {
  return listInterceptors().map(projectInterceptor)
}

/**
 * 判断某个预设套件是否**正是**当前生效配置。
 *
 * 用途是前端「当前使用中」高亮。刻意做全量比对而非只比几个关键项：
 * 手工改过一个参数之后，套件就不再是「生效中」了，此时高亮会误导用户
 * 以为自己是稳健配置，实际已经不是。
 */
function suiteMatches(suiteId: string): boolean {
  let target: Record<RiskEnvKey, number>
  try {
    target = suiteValues(suiteId)
  } catch {
    return false
  }
  const now = currentValues()
  return (Object.keys(target) as RiskEnvKey[]).every((k) => now[k] === target[k])
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

setInterval(() => {
  const s = getOrchState()
  const msg = JSON.stringify({
    type: 'state',
    ts: Date.now(),
    killswitch: s.killswitch,
    balanceUSDC: Math.round(s.balanceUSDC * 100) / 100,
    equity: Math.round(currentEquity(s) * 100) / 100,
    openOrders: s.orders.filter((o) => o.status === 'new' || o.status === 'ack' || o.status === 'partial').length,
    lastPrice: Object.fromEntries(s.lastPrice),
  })
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg)
  }
}, 2_000)

async function seedHistory(): Promise<void> {
  for (const symbol of SYMBOLS) {
    try {
      const endTime = Date.now()
      const startTime = endTime - 180 * 60_000
      const u = `${REST}/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${startTime}&limit=180`
      const res = await fetch(u)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const rows = (await res.json()) as any[][]
      for (const r of rows) {
        const candle: Candle = {
          t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]),
        }
        onMarketBar(symbol, candle)
        void onAutopilotBar(candle)
      }
      const s = getOrchState()
      seedPrice(symbol, s.lastPrice.get(symbol) ?? 0)
      console.log(`[OK] ${symbol} 历史种子 ${rows.length} 根 (${INTERVAL})`)
    } catch (e) {
      console.warn(`⚠️ ${symbol} 行情种子失败: ${e instanceof Error ? e.message : e}`)
    }
  }
}

// K 线轮询：为撮合引擎提供 OHLC bar（实时定价由 WebSocket tick 流承担）
setInterval(() => {
  void (async () => {
    for (const symbol of SYMBOLS) {
      try {
        const res = await fetch(`${REST}/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=2`)
        if (!res.ok) continue
        const rows = (await res.json()) as any[][]
        if (!Array.isArray(rows) || rows.length === 0) continue
        const last = rows[rows.length - 1]
        const candle: Candle = {
          t: last[0], o: parseFloat(last[1]), h: parseFloat(last[2]), l: parseFloat(last[3]), c: parseFloat(last[4]), v: parseFloat(last[5]),
        }
        onMarketBar(symbol, candle)
        void onAutopilotBar(candle)
      } catch {
        /* 静默重试 */
      }
    }
  })()
}, 30_000)

function attachVenue(): void {
  const kind = (process.env.VENUE ?? 'sandbox').toLowerCase()
  if (kind === 'sandbox') {
    liveGateway.attachAdapter(new SandboxAdapter())
    liveGateway.completeRiskHandshake()
    console.log('[OK] venue=sandbox 已挂载 · 风控握手完成')
    return
  }
  if (kind === 'cex-testnet') {
    const a = CexTestnetAdapter.fromEnv()
    if (!a) {
      console.warn('⚠️ VENUE=cex-testnet 但缺少 BINANCE_TESTNET_API_KEY/SECRET · gateway 保持未挂载（fail-closed）')
      return
    }
    liveGateway.attachAdapter(a)
    liveGateway.completeRiskHandshake()
    console.log('[OK] venue=cex-testnet 已挂载 · 风控握手完成')
    return
  }
  if (kind === 'okx-testnet') {
    const a = OkxTestnetAdapter.fromEnv()
    if (!a) {
      console.warn('⚠️ VENUE=okx-testnet 但缺少 OKX_TESTNET_API_KEY/SECRET/PASSPHRASE · gateway 保持未挂载（fail-closed）')
      return
    }
    liveGateway.attachAdapter(a)
    liveGateway.completeRiskHandshake()
    console.log('[OK] venue=okx-testnet (模拟盘/零真实资金) 已挂载 · 风控握手完成')
    return
  }
  console.warn(`⚠️ 未知 VENUE=${kind} · gateway 未挂载（fail-closed）`)
}

interface VenueStatusView {
  exchange: 'binance' | 'okx'
  mode: 'testnet' | 'live'
  supported: boolean
  configured: boolean
  attached: boolean
  handshakeComplete: boolean | null
  killswitch: boolean | null
  venueOutboundDisabledReason: string | null
  balanceUsdt: number | null
  status: 'online' | 'configured_offline' | 'not_configured' | 'unsupported' | 'error'
  error: string | null
}

async function probeVenueBalance(adapter: VenueAdapter, ms = 15000): Promise<number> {
  const to = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('PROBE_TIMEOUT')), ms))
  const bal = (await Promise.race([adapter.reconcile(), to])) as BalanceSnapshot
  return bal.cash
}

// 只读交易所链接状态：覆盖币安/OKX 的测试网与实盘，仅展示连接与余额，不触发任何下单。
async function gatherVenueStatuses(): Promise<VenueStatusView[]> {
  const running = liveGateway.status()
  const runningName = running.adapterName
  const candidates: { exchange: 'binance' | 'okx'; mode: 'testnet' | 'live'; kind: string; supported: boolean; env: string[] }[] = [
    { exchange: 'binance', mode: 'testnet', kind: 'cex-testnet', supported: true, env: ['BINANCE_TESTNET_API_KEY', 'BINANCE_TESTNET_API_SECRET'] },
    { exchange: 'okx', mode: 'testnet', kind: 'okx-testnet', supported: true, env: ['OKX_TESTNET_API_KEY', 'OKX_TESTNET_API_SECRET', 'OKX_TESTNET_PASSPHRASE'] },
    { exchange: 'binance', mode: 'live', kind: 'binance-live', supported: false, env: ['BINANCE_LIVE_API_KEY', 'BINANCE_LIVE_API_SECRET'] },
    { exchange: 'okx', mode: 'live', kind: 'okx-live', supported: false, env: ['OKX_LIVE_API_KEY', 'OKX_LIVE_API_SECRET', 'OKX_LIVE_PASSPHRASE'] },
  ]
  const out: VenueStatusView[] = []
  for (const c of candidates) {
    const configured = c.env.every((k) => !!process.env[k])
    const attached = runningName === c.kind
    if (!c.supported) {
      out.push({ exchange: c.exchange, mode: c.mode, supported: false, configured, attached: false, handshakeComplete: null, killswitch: null, venueOutboundDisabledReason: null, balanceUsdt: null, status: configured ? 'unsupported' : 'not_configured', error: null })
      continue
    }
    if (!configured) {
      out.push({ exchange: c.exchange, mode: c.mode, supported: true, configured: false, attached: false, handshakeComplete: null, killswitch: null, venueOutboundDisabledReason: null, balanceUsdt: null, status: 'not_configured', error: null })
      continue
    }
    let balanceUsdt: number | null = null
    let err: string | null = null
    try {
      const adapter = c.kind === 'okx-testnet' ? OkxTestnetAdapter.fromEnv() : CexTestnetAdapter.fromEnv()
      if (adapter) balanceUsdt = await probeVenueBalance(adapter)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    const healthy = attached && running.handshakeComplete && !running.killswitch && !running.venueOutboundDisabledReason && err === null
    out.push({
      exchange: c.exchange, mode: c.mode, supported: true, configured: true, attached,
      handshakeComplete: attached ? running.handshakeComplete : null,
      killswitch: attached ? running.killswitch : null,
      venueOutboundDisabledReason: attached ? running.venueOutboundDisabledReason : null,
      balanceUsdt,
      status: err ? 'error' : healthy ? 'online' : 'configured_offline',
      error: err,
    })
  }
  return out
}

configureAutopilot({ getState: getOrchState })

seedHistory()
  .catch(() => undefined)
  .finally(() => {
    initLedger()
    // 单写者围栏：同一账本只允许一个实例写入（防审计链分叉，见 seq 154 事故）
    try {
      const fence = claimInstance()
      if (!fence.ok) {
        console.error(`❌ 拒绝启动：账本正被 PID ${fence.heldByPid} 占用（single-writer 保护）`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`❌ 账本围栏获取失败，拒绝启动: ${e instanceof Error ? e.message : e}`)
      process.exit(1)
    }
    setInterval(() => heartbeatInstance(), 15_000)
    process.on('SIGINT', () => { releaseInstance(); process.exit(0) })
    process.on('SIGTERM', () => { releaseInstance(); process.exit(0) })
    process.on('exit', () => releaseInstance())
    pipelineService.init()
    const db = getDb()
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS proposals (proposal_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL)')
      proposals.bindDb(db as unknown as Parameters<typeof proposals.bindDb>[0])
      bindLlmProvidersDb(db as unknown as Parameters<typeof bindLlmProvidersDb>[0])
    }
    attachVenue()
    bindRetentionDb(() => getDb() as never)
    startRetentionLoop(true)

    // C-12 镜像互查：事件携带来源 seq+hash 镜像至独立账本；周期性双向校验与自愈补投
    const mirrorUrl = process.env.ORCH_LEDGER_URL
    if (mirrorUrl) {
      enableMirror(mirrorUrl, TOKEN)
      setInterval(() => {
        void checkMirror()
      }, 60_000)
      console.log('[OK] 镜像互查已启用 → ' + mirrorUrl + ' (check every 60s)')
    }

    // C-11 日终对账：启动后 10s 首跑，之后每 6 小时
    const reconTick = () => {
      void runReconciliation(getOrchState(), liveGateway).then((r) => {
        if (!r.consistent) console.error('❌ 对账失配 · venue 出站已禁用 · ' + JSON.stringify({ cashDeltaAbs: r.cashDeltaAbs, deltas: r.positionDeltas }))
      }).catch(() => undefined)
    }
    setTimeout(reconTick, 10_000)
    setInterval(reconTick, 6 * 60 * 60 * 1000)

    // C-7 SLO 周期评估与告警（ALERT_WEBHOOK_URL 可配置通知通道）
    setInterval(() => {
      void checkAndAlert(metrics.snapshot({ gateway: liveGateway.status(), eventMemoryCount: eventCount() }))
    }, 60_000)

    // C-13 实时 tick 流：秒级最新价驱动标记价格与权益曲线
    const feed = connectTickerStream(
      SYMBOLS,
      REST,
      (tick) => {
        try {
          onPriceTick(tick.symbol, tick.price)
          // 语音层的盘面异动检测搭在同一个 tick 上：不新开订阅，
          // 也就不会出现"播报看到的价"和"引擎看到的价"是两个快照。
          voiceOnPriceTick(tick.symbol, tick.price)
        } catch {
          /* 单 tick 失败不影响流 */
        }
      },
      (online, stale) => {
        if (!online) console.warn('⚠️ 实时行情流断开 · 指数退避重连中 · stale=' + stale.join(','))
      },
    )
    process.on('exit', () => feed.close())

    setInterval(() => {
      const s = getOrchState()
      persistSnapshot(Date.now(), currentEquity(s), s.balanceUSDC, s.killswitch)
    }, 15_000)

    httpServer.listen(PORT, () => {
      console.log(`[OK] EVOLVE orchestration 已启动 port=${PORT} mode=paper symbols=${SYMBOLS.join(',')}`)
      console.log(`  REST http://localhost:${PORT}/healthz /state /orders /killswitch /gateway/status /metrics /audit/verify /promotions /proposals /autopilot`)
      console.log(`  语音 http://localhost:${PORT}/voice/config /voice/state /voice/daily /voice/utterance /voice/interrupt /voice/stream(SSE)`)
      // 语音层必须在 initLedger 之后启动：它要从账本链尾对齐播报游标，
      // 早于持久层初始化会被当成"链是空的"从而把历史事件全部念一遍。
      startVoice()
      // 后台预热过拟合证据：一次完整 walk-forward 约 20 秒。
      // 不预热则第一次点「跑 backtest 门」要干等 20 秒；预热失败不影响可用性。
      warmEvidence(SYMBOLS[0] ?? 'BTCUSDT')
    })
  })
