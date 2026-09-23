import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadDotEnv, updateDotEnv } from './loadEnv.ts'
import { INSECURE_DEFAULT_TOKEN, authzHint, createAuthGate, createDedupedNotifier } from './orchAuth.ts'
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
import { gateInputFromOrderIntent, gateOrderForExecution, describeGateRefusal } from './orderGate.ts'
import { markPriceOf } from './orchEngine.ts'
import { getActiveLlm } from './llmProviders.ts'
import { classifyKeyScope } from './keyScope.ts'
import type { OrderIntentInput } from './risk.ts'
import { liveGateway } from './gateway/executor.ts'
import { isPersistent, persistSnapshot, queryEvents, getDb, claimInstance, heartbeatInstance, releaseInstance } from './persistence.ts'
import { bindRetentionDb, startRetentionLoop } from './retention.ts'
import { pipelineService } from './pipelineService.ts'
import { computeEvidenceReceipt, evidenceCacheInfo, loadEvidence, warmEvidence } from './evidence.ts'
import { auditIndexRows, checkGateReachable, factorIndexSummary, readFactorIndex, defaultIndexPath, produceFactors } from './factorService.ts'
import {
  defaultStrategyIndexPath,
  factorStrategySummary,
  readStrategyIndex,
} from './factorStrategyService.ts'
import { breadthSummary, defaultBreadthIndexPath, readBreadthIndex } from './breadthService.ts'
import { forecast, forecastHeadline, parseForecastQuery } from './forecastService.ts'
import { proposals } from './proposals.ts'
import { listProviders, addProvider, removeProvider, probeAndPersist, setActiveModel, setEnabled, bindLlmProvidersDb, ensureEnvProvider } from './llmProviders.ts'
import { routerConfigView } from './modelRouter.ts'
import { OkxTestnetAdapter } from './venue/okxTestnet.ts'
import { metrics } from './metrics.ts'
import { verifyPersistedChain } from './audit.ts'
import { generateProposals, measureFacts } from './proposalEngine.ts'
import { evaluateSlo, checkAndAlert, SLO_TARGETS, lastAlertWebhook } from './slo.ts'
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
  // 「聊过什么」的查阅出口（Task #114）。与 `handleUtterance` 同一个模块 ——
  // 记的人和读的人必须看同一份事实源。
  voiceTranscript,
  voiceMemoryView,
} from './voice/service.ts'
// ── 手机端远程指挥（Telegram）─────────────────────────────────────────
// ★ 只从这里取**搬运**用的四个名字，没有一个是"顺手加的能力"：
//   `startTelegramPolling` 只负责去拉消息，消息交回 `handleUtterance`。
//   本模块里没有任何下单/风控逻辑，也不许有（红线②：它不是一个新通道）。
import {
  allowChat as allowTelegramChat,
  revokeChat as revokeTelegramChat,
  startTelegramPolling,
  stopTelegramPolling,
  telegramView,
} from './voice/telegram.ts'
import { missionStatusView, planMission, startMissionByPlan } from './mission/service.ts'
// 附件是**一轮对话的载荷**：类型定义在语音层，因为它只在这条链路上流动。
import type { RawAttachment } from './voice/attachments.ts'
// ── Agent 舰队 ────────────────────────────────────────────────────────
// 只从 `server/fleet/index.ts` 取（那一层是唯一对外面）。**七个名字一一对应
// 七个真实动作**，没有一个是"留着以后用"的占位 —— 占位 import 会让
// "这个能力有生产入口吗"这个问题得到一个看着像"有"的答案。
import {
  ensureFleetInstalled,
  fleetSnapshot,
  fleetRoster,
  runAgent,
  runTask,
  renderTaskBrief,
  planTask,
  FLEET_TASK_PLANS,
  FLEET_TOPICS,
  FLEET_CONSUMERS,
  autonomyStatus,
  autonomyTicks,
  autostartAutonomy,
  AUTONOMY_JOBS,
  // 新闻雷达（第十八轮）：`latestDigest` 是那个只读端点的唯一数据来源。
  latestDigest,
  KEEP_THRESHOLD,
  NEWS_SOURCES,
  RELEVANCE_TERMS,
  // 新闻雷达的**推送面与闭环**（第十八轮第二批）：
  //   trending / universe 是雷达唯一接回系统行为的那根线（breadth 取候选）；
  //   proposalRows / pending* 是"人对提案拍板"这条链的读数；
  //   appendNewsVerdict 是裁决的唯一落盘出口。
  readTrending,
  suggestedUniverse,
  proposalRows,
  pendingProposalCount,
  pendingSpeech,
  appendNewsVerdict,
  // `readLastRun` 是各源战绩的**唯一**来源。原来这里从 `NEWS_DIGEST` 事件取，
  // 而事件活在进程内存里 —— 编排器一重启，面板就把所有源显示成「0 条」，
  // 与"源真的什么都没拿到"长得一样（判据 24）。实测踩过，改成读落盘报告。
  readLastRun,
} from './fleet/index.ts'
import type { SourceReport } from './fleet/index.ts'
// 账号池现状**直接来自池子本身**，不从舰队那一层转手 —— 它不是舰队的成员，
// 而是所有成员共用的那条通道。启动器与控制台都要读它，而"还有几个账号能用"
// 这件事只有一个真相来源（判据 8：同一件事不给第二条实现路径）。
import { poolSnapshot } from './llmPool.ts'
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
import { HEALTH_ROLE_FIELD, type ServiceRole } from './serviceIdentity.ts'
import {
  UI_PAGES,
  UI_ACTIONS,
  claimPendingTasks,
  completeUiAction,
  enqueueUiAction,
  listTasks,
  renderQueueSpeech,
  setUiWorkspaceRoot,
  uiWorkspaceRoot,
} from './uiActions.ts'

loadDotEnv()

// ★ 界面动作队列的工作区根**只在这里定一次**。
//   语音层（它按同一份队列排动作）走 `uiWorkspaceRoot()` 读这个值 ——
//   两边各自调一次 `process.cwd()` 就等于把"它们是不是同一份队列"交给运气，
//   而表现是"桌宠说排了、界面说队列是空的"，两边单独看都没错。
setUiWorkspaceRoot(process.cwd())

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
// ★ 默认令牌那个字符串**只住在 `server/orchAuth.ts` 里**（判据 ⑯）——
//   以前它在本文件里出现三遍，改一处必漏一处。
if (process.env.NODE_ENV === 'production' && (!process.env.ORCH_TOKEN || process.env.ORCH_TOKEN === INSECURE_DEFAULT_TOKEN)) {
  console.error('❌ NODE_ENV=production 要求显式设置 ORCH_TOKEN')
  process.exit(1)
}
const TOKEN = process.env.ORCH_TOKEN ?? INSECURE_DEFAULT_TOKEN

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

/**
 * "有人带着公开默认令牌从**别的设备**来敲门" —— 这件事必须留痕。
 *
 * ★ 去重与有界住在 `createDedupedNotifier` 里（判据 C7 的反面：不去重的话
 *   一次端口扫描就能把账本写成几万行、把真正的事件挤出去）。
 * ★ 只记来源地址，**不复述令牌**（那一格说的是"有人试过"，不是"口令是 X"）。
 * ★ 包在 try 里：记账失败**不许**改变鉴权结论 —— 那会变成"账本坏了就放行"。
 */
const noteInsecureRemoteOnce = createDedupedNotifier({
  max: 32,
  emit: (key) => {
    try {
      appendEvent('ORCH_REMOTE_WITH_DEFAULT_TOKEN', {
        remote: key,
        hint: authzHint('insecure-remote'),
      })
    } catch {
      /* 记账失败不改判 */
    }
  },
})

/**
 * **谁能通过它下指令。规矩只有这一条**（二十多个端点共用它，
 * 所以改一处即全站生效；判据本身住在 `server/orchAuth.ts`，账本服务用的是同一份）。
 *
 * ★ 这里只剩"把请求翻译成判据的入参"这一件事。任何一条业务判断都**不许**
 *   再写回来 —— 那正是它当初变成两份副本、且"接线可达"只能靠读源码去验的原因。
 */
const authGate = createAuthGate({ token: TOKEN, onInsecureRemote: noteInsecureRemoteOnce })

function authorized(req: import('node:http').IncomingMessage): boolean {
  return authGate(req.headers['x-orch-token'], req.socket.remoteAddress)
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
      // ★ `[HEALTH_ROLE_FIELD]`：**「你是谁」是这个端点最要紧的一格**。
      //   同一个端口上可能有别人的服务（本机实测：隔壁工作区的 dash 服务占着
      //   127.0.0.1:8790）。少了这一格，启动器就只能用"HTTP 有响应"当判据 ——
      //   那会**认错人**，而且错得完全看不出来（见 stackCore 里那段注释）。
      return json(res, 200, {
        ok: true,
        [HEALTH_ROLE_FIELD]: 'orch' satisfies ServiceRole,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        killswitch: s.killswitch,
        mode: s.mode,
      })
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

      // ── 出单前**必须**过一次闸门 ────────────────────────────────────────
      //
      // ★ 在 `orderGate.ts` 出现之前，这个端点**一道闸门都不过**：交易大厅会先
      //   问一次 `/orders/precheck`（只读），而这条**真正出单**的路从来不问。
      //   于是"闸门"只挡得住愿意先问一声的人 —— 判据 8 的典型形态。
      //   现在三条出单路（自治循环 / 这里 / 语音）走的是**同一次调用的同一份结果**。
      //
      // ★ 平仓单**不适用**开仓闸门：闸门守的是"要不要新增一笔风险"。
      //   但 `OrderIntentInput` 目前**没有** `reduceOnly` 字段 ⇒ 这里识别不了平仓。
      //   已知代价（必须说出来）：若有调用方拿它平仓，会被闸门拦，而平仓本该随时可做。
      //   真要用它平仓，先给 `OrderIntentInput` 加 `reduceOnly` 再在下面放行 ——
      //   在那之前**宁可拦错也不放错**（每一次裁决都有 `ORDER_GATE` 留痕，可复盘）。
      const s0 = getOrchState()
      const env: 'paper' | 'live' = intent.mode === 'live' ? 'live' : 'paper'
      const mark = markPriceOf(s0, intent.symbol)
      const gi = gateInputFromOrderIntent(intent, { environment: env, mark })
      if (!gi.ok) {
        // ★ 闸门没跑起来 ⇒ 不会有 `ORDER_GATE` 留痕，所以这一条必须在这里记。
        appendEvent('ORDER_GATE_REFUSED', {
          symbol: intent.symbol,
          side: intent.side,
          reason: gi.reason,
          stage: 'gate-input',
        })
        return json(res, 422, { ok: false, clientOrderId: intent.clientOrderId, reason: gi.reason })
      }
      const gate = await gateOrderForExecution(gi.req, { source: 'orders' })
      if (!gate.submitAllowed) {
        return json(res, 422, {
          ok: false,
          clientOrderId: intent.clientOrderId,
          reason: gate.summary,
          verdict: gate.verdict,
          blockers: gate.blockers.map((b) => b.id),
          pipeline: gate.pipeline,
          // ★ 拒绝要**说清是哪一道门**并带上**可照做的数字**（判据 D7）——
          //   只回一句"被风控拒绝"会把人引向"那我再点一次"，而那个动作没有用。
          detail: describeGateRefusal(gate),
        })
      }

      if (intent.mode === 'live') {
        const outcome = await processLiveIntent({ ...intent, strategyId: intent.strategyId ?? '' })
        return json(res, outcome.ok ? 200 : 422, outcome)
      }
      const outcome = processOrderIntent(intent)
      return json(res, outcome.ok ? 200 : 422, outcome)
    }

    // ── 下单预检：把「这笔交易凭什么可以出去」在**下单之前**回答掉 ────────
    //
    // ★ 这个端点存在的唯一理由：交易大厅（人工下单）原先**一道闸门都不过**，
    //   而自治循环（机器下单）过全部 9 道。同一个业务动作两条路径，
    //   且人那条从来没有任何测试覆盖 —— 判据 8 的典型形态。
    //
    // ★ 它是 `runPipeline` 的**第二个生产入口**，不是第二份实现：
    //   判断全在 `tradeGate.precheckTrade()`，那里只是编排既有模块。
    //   只读语义：不改状态、不占台账、不写审批单。
    if (req.method === 'POST' && url.pathname === '/orders/precheck') {
      const body = JSON.parse(await readBody(req)) as {
        symbol?: string
        side?: string
        notionalUsdt?: number
        entry?: number
        takeProfit?: number
        stopLoss?: number
        confidence?: number
        channel?: string
        venue?: string
        expectedEdgeBps?: number
        holdingHours?: number
        markPrice?: number
        refresh?: boolean
        /**
         * 这笔单是否**声称以走势预测为依据**（见 `tradeGate.ForecastClaim`）。
         *
         * ★ 请求体里**只接受这个布尔**，不接受预测结论本身 ——
         *   结论由 `precheckLiveTrade()` 内部现算。允许调用方传结论，
         *   等于把"依据"交给被审的那一方自己开（`file_lesson` 那条凭据纪律同源）。
         */
        forecastClaims?: boolean
        forecastHorizonMinutes?: number
        /**
         * 用户**显式放弃**保护价（裸单）。缺省 `false`。
         * ★ 缺省必须是 `false`：把"没给保护价"自动读成"用户不要保护"，
         *   会让任何一次调用方漏填静默降级成裸单放行（见 `tradeGate.PrecheckInput`）。
         */
        protectionWaived?: boolean
        /** 生效杠杆（已被 `judgeLeverage` 裁决过）。裸单的合约单必填。 */
        leverage?: number
        instType?: 'SPOT' | 'SWAP'
      }
      if (!body.symbol) return json(res, 400, { error: 'MISSING_SYMBOL' })
      if (body.side !== 'buy' && body.side !== 'sell') return json(res, 400, { error: 'BAD_SIDE' })

      const s = getOrchState()
      const environment: 'paper' | 'live' = s.mode === 'live' ? 'live' : 'paper'
      const bodyEnv = (body as { environment?: string }).environment
      const env: 'paper' | 'live' = bodyEnv === 'live' || bodyEnv === 'paper' ? bodyEnv : environment

      // ★ 闸门走**唯一入口** `orderGate.ts` —— 与 `/orders`、与语音是**同一次调用的
      //   同一份结果**。原先这里 inline 了一份 deps 与一次 `precheckLiveTrade(...)`，
      //   于是闸门在服务端有了两个调用面：这个端点问一句，而真正出单的那条路不问。
      //   判据 8：一个业务动作一条实现路径 —— 收口到一处。
      const result = await gateOrderForExecution(
        {
          symbol: body.symbol,
          side: body.side,
          notionalUsdt: Number(body.notionalUsdt ?? 0),
          entry: Number(body.entry ?? 0),
          takeProfit: Number(body.takeProfit ?? 0),
          stopLoss: Number(body.stopLoss ?? 0),
          ...(body.confidence === undefined ? {} : { confidence: Number(body.confidence) }),
          environment: env,
          channel: body.channel === 'dex' ? 'dex' : 'cex',
          ...(typeof body.venue === 'string' && body.venue ? { venue: body.venue } : {}),
          ...(body.expectedEdgeBps === undefined ? {} : { expectedEdgeBps: Number(body.expectedEdgeBps) }),
          ...(body.holdingHours === undefined ? {} : { holdingHours: Number(body.holdingHours) }),
          ...(body.markPrice === undefined ? {} : { markPrice: Number(body.markPrice) }),
          refresh: body.refresh === true,
          forecastClaims: body.forecastClaims === true,
          ...(body.forecastHorizonMinutes === undefined
            ? {}
            : { forecastHorizonMinutes: Number(body.forecastHorizonMinutes) }),
          // ★ `=== true`（不是 `?? false` 也不是真假值转换）：豁免只认**布尔真**，
          //   字符串 "false" / 数字 1 一律不算 —— 凭据只由一个明确的表态产生。
          protectionWaived: body.protectionWaived === true,
          ...(body.leverage === undefined ? {} : { leverage: Number(body.leverage) }),
          ...(body.instType === 'SWAP' || body.instType === 'SPOT' ? { instType: body.instType } : {}),
        },
        { source: 'precheck' },
      )

      // 留痕：预检是**只读**的，但它必须可核 —— 否则「当时闸门到底怎么判的」
      // 又变成只能靠界面上那一眼（判据 C1 的另一半：有端点 ≠ 有人读；有人读 ≠ 有据可查）。
      // ★ 记在 `orderGate.ts` 里（`source: 'precheck'` ⇒ 事件名仍是 `ORDER_PRECHECK`），
      //   段留痕代码与 `/orders`、与语音共用同一份。这里**不再自己记一遍**：
      //   同一件事两个主人，改一处不会让另一处报错（红线 ⑯）。
      return json(res, 200, result)
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

    // ── 因子批量生产线 ────────────────────────────────────────────────
    // 与 /proposals/generate 是两条独立的产线：那条产"策略"（含仓位成本），
    // 这条产"因子"（纯信号，只问有没有预测力）。分开是为了能做归因：
    // "信号没用"和"信号有用但被成本吃掉"必须能被区分开。
    if (url.pathname === '/factors/index' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const { index, damaged } = readFactorIndex(defaultIndexPath())
      const summary = factorIndexSummary()
      // 面板要能逐行标出"这行的判决已经过时"，所以除了概况还要两个**逐行**的判据：
      //   · `inconsistentSlugs` —— 判决与自己记下的指标自相矛盾的行（判定器升级遗留）；
      //   · `currentDataHash`   —— 当前行情的指纹。台账行自带 `dataHash`，
      //     两者一比就知道这一行的结论是不是在**别的一份行情**上做出的。
      // 少了后一个，面板只能显示一个 12 位十六进制串 —— 那对用户等于没显示。
      const currentDataHash = loadEvidence('BTCUSDT', 15).dataHash
      return json(res, 200, {
        ok: damaged === null,
        damaged,
        summary,
        currentDataHash,
        inconsistentSlugs: auditIndexRows(index).map((x) => x.slug),
        index,
      })
    }

    // 策略层台账（因子 → 可交易策略这一步的结论）。
    // 与 /factors/index 是**上下游两层**：上一层回答"这个信号有没有预测力"，
    // 这一层回答"它扣掉成本与滑点之后还赚不赚钱"。两层分开是刻意的 ——
    // 合成一个数字就再也分不清"信号没用"和"信号有用但被成本吃掉"。
    if (url.pathname === '/factors/strategies' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const { index, damaged } = readStrategyIndex(defaultStrategyIndexPath())
      const summary = factorStrategySummary()
      return json(res, 200, { ok: damaged === null, damaged, summary, index })
    }

    // 横截面（breadth）台账 —— 因子线的第三层。
    // 三层的关系：/factors/index 问"信号有没有预测力" → /factors/strategies 问
    // "扣掉成本还赚不赚钱" → 这一层问"**换到一批标的上做排序**，毛与成本谁大"。
    // 第三层存在的理由：前两层测出来的「每笔毛边际 vs 每笔成本」差 12~40 倍，
    // 而横截面是唯一还没被真正跑过的那条路（多空对冲消掉市场方向、
    // 每个时刻有 N 个样本而不是 1 个）。
    if (url.pathname === '/breadth/index' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const { index, damaged } = readBreadthIndex(defaultBreadthIndexPath())
      const summary = breadthSummary()
      // 面板事实与逐行结论**一起**返回：一条"通过"如果不知道自己在哪些品种、
      // 哪段时间、哪个 horizon 上得出的，它就不能被复核，也不能在数据变化后作废。
      // 与 /factors/index 返回 currentDataHash 是同一个立场。
      return json(res, 200, { ok: damaged === null, damaged, summary, index })
    }

    // 走势预测 —— 桌宠问「帮我预测一下比特币未来一小时的走势」时走这里。
    //
    // ★ 它是**只读**的：不落盘、不下单、不改任何状态。要不要下单由既有的
    //   `POST /orders/precheck`（交易闸门）决定 —— 预测只产出证据与裁决，
    //   判据 8：同一个业务动作（下一笔单）只许有一条路径。
    // ★ 它**永远带 `outcome` 与 `calibration`**：`no-edge` 时也照样返回方向与价位，
    //   但把"命中率与平凡规则分不开"这句话一起返回。少这一句，接口就在教用户
    //   把噪声当信号（`headline` 里也带同一句，两处同源）。
    if (url.pathname === '/forecast' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      /*
       * ★ 参数怎么读、拒哪些，全部归 `parseForecastQuery` —— 那是个**纯函数**，
       *   所以门禁（`test:forecast` F8）能直接钉住"分辨率不许调用方自报"这条红线。
       *   写在端点里的话，断言就得先起一个 HTTP 服务：那是"只有测试可达"的
       *   反面 —— **不可测的东西等于没被钉住**。
       */
      const parsed = parseForecastQuery(url.searchParams)
      if (!parsed.ok) return json(res, parsed.status, { error: parsed.error, message: parsed.message })
      const { symbol, horizon } = parsed
      const result = forecast({
        symbol,
        config: { horizonBars: horizon.horizonBars, barMinutes: horizon.barMinutes },
      })
      // ★ `horizon` 一起返回：调用方从响应里就能读回"你要的 5 分钟被并成了 15 分钟"，
      //   而不必从 `barMinutes × horizonBars` 反算（反算的口径未必与这里相同）。
      return json(res, 200, { ok: true, headline: forecastHeadline(result), horizon, result })
    }

    if (req.method === 'POST' && url.pathname === '/factors/generate') {      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = (await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({}))) as {
        count?: number
        symbol?: string
        dryRun?: boolean
      }
      // 刻意不接受 body 里的 thresholds：阈值只能来自代码里的唯一出处。
      // 允许请求体传阈值 = 把"证据门槛"交给调用方，那等于门可以自己开。
      const r = produceFactors({ count: body.count, symbol: body.symbol, dryRun: body.dryRun })
      return json(res, 200, {
        origin: r.origin,
        dataHash: r.dataHash,
        bars: r.bars,
        specs: r.specs,
        accepted: r.accepted,
        rejected: r.rejected,
        unverifiable: r.unverifiable,
        byGate: r.byGate,
        indexPath: r.indexPath,
        written: r.written,
        rows: r.rows,
      })
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
      // ★ 告警通道的状态必须有一个**有人读**的出口（监控页的 SLO 面板在轮询它）。
      //   这条通道坏掉之后，外表与"系统一直很健康"完全一样 —— 两种情形都是
      //   "屏幕上没有任何告警"。`null` = 从没触发过告警，与"配好了、发得出去"
      //   是两件不同的事，不许显示成同一种样子（判据 C7/D7）。
      return json(res, 200, { targets: SLO_TARGETS, ...evaluation, alertWebhook: lastAlertWebhook() })
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

    // ── Agent 舰队 ────────────────────────────────────────────────────
    // 在这一段出现之前，`server/fleet/**` 有 1938 行实现、**零个调用方** ——
    // 那是本项目里最贵的一类缺陷：逻辑正确、有断言、跑得通，但没有任何生产
    // 路径会走到它（判据 11）。这几个端点就是它的"生产入口"。
    //
    // 全部要求令牌：舰队实况里含文件体检员的**绝对路径清单**，
    // 那不是可以随便给人看的量。
    if (url.pathname === '/fleet' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      return json(res, 200, {
        snapshot: fleetSnapshot(),
        roster: fleetRoster(),
        // 通道现状：**"还有几个账号能用"必须能被问出来**，否则用户没法判断
        // "系统不动了"是坏了还是额度爆了（判据 13：这两种事指向相反的动作）。
        pool: poolSnapshot(),
        topics: FLEET_TOPICS,
        consumers: FLEET_CONSUMERS,
        // 「能听懂哪些说法」必须能**被问出来**。用户实测反馈是
        // "扩候选基因空间和换因子族等都听不懂" —— 一个既听不懂也说不清
        // 自己能听懂什么的助手，用户没有任何办法把它用起来。
        plans: FLEET_TASK_PLANS.map((p) => ({ id: p.id, label: p.label, chain: p.chain, why: p.why })),
      })
    }

    // 只做"这句话我能不能接"的判定，**不执行**。语音层要在跑之前先问一句，
    // 否则用户会看到系统先动起来、再被拒绝。
    if (url.pathname === '/fleet/plan' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as { goal?: string }
      const r = planTask(String(body.goal ?? ''))
      return json(res, 200, { ok: r.plan !== null, plan: r.plan ? { id: r.plan.id, label: r.plan.label, chain: r.plan.chain } : null, why: r.why })
    }

    if (url.pathname === '/fleet/run' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as {
        agentId?: string
        arg?: string
        confirmed?: boolean
        dryRun?: boolean
      }
      // ★ `confirmed` 与 `dryRun` **必须原样透传**，不能在这里给默认值：
      //   `runAgent` 靠 `confirmed !== true` 决定要不要拒。若这里写
      //   `confirmed: body.confirmed ?? true`，act 类成员就永远拒不了了 ——
      //   而那正是"用户没确认却改了系统状态"这条红线的唯一实现。
      const receipt = await runAgent(String(body.agentId ?? ''), {
        arg: body.arg,
        confirmed: body.confirmed === true,
        dryRun: body.dryRun === true,
      })
      return json(res, receipt.ok ? 200 : 422, receipt)
    }

    if (url.pathname === '/fleet/task' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = await readBody(req).then((t) => (t ? JSON.parse(t) : {})).catch(() => ({})) as {
        goal?: string
        confirmed?: boolean
        dryRun?: boolean
      }
      const receipt = await runTask(String(body.goal ?? ''), {
        confirmed: body.confirmed === true,
        dryRun: body.dryRun === true,
      })
      return json(res, receipt.ok ? 200 : 422, { ...receipt, brief: renderTaskBrief(receipt) })
    }

    // ── 自治循环的现状（只读）─────────────────────────────────────────
    //
    // ★ 启停**不在这里**：它们走 `POST /fleet/task`（goal=「一键启动自治循环」/
    //   「停止自治循环」）。给启停单开端点就是给同一件事造第二条实现路径 ——
    //   而两条路径迟早对同一件事给出不同的确认与文案（判据 8）。
    //   需要这个只读端点，是因为**状态与排程时刻无法从别处得到**：
    //   `runTask` 的凭据里只有"这一次"的结果，没有"下一次什么时候"。
    if (url.pathname === '/fleet/autonomy' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const st = autonomyStatus()
      return json(res, 200, {
        status: st,
        jobs: AUTONOMY_JOBS.map((j) => ({ id: j.id, label: j.label, everyMs: j.everyMs, goal: j.goal, why: j.why, reversible: j.reversible })),
        // 循环自己干过活的取证：从**账本**读，不读内存计数器 ——
        // 进程重启后计数器归零，而账本不会。
        ticks: autonomyTicks(30),
        // 「哪些说法能承接」必须能被问出来（与 /fleet 的 plans 同一理由）。
        plans: FLEET_TASK_PLANS.map((p) => ({ id: p.id, label: p.label, chain: p.chain, writes: p.writes })),
      })
    }

    // ── 新闻雷达（只读）────────────────────────────────────────────────
    //
    // ★ 它只**读**：真正的抓取与内化走 `POST /fleet/task`（goal 被 `news` 计划接住）。
    //   与 `/fleet/autonomy` 同一条纪律 —— 同一件事不给第二条实现路径。
    //   这个端点存在的理由是"**最近读到了什么**"这个问题没有别的出口：
    //   账本里有 `NEWS_DIGEST` 事件，但没有条目正文与命中词。
    if (url.pathname === '/fleet/news' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
      const items = latestDigest(process.cwd(), limit)
      const events = getEvents(0)
      const recent = events
        .filter((e) => e.kind === 'NEWS_DIGEST' || e.kind === 'NEWS_INTERNALIZED' || e.kind === 'NEWS_PROPOSAL_VERDICT')
        .slice(-10)
        .map((e) => ({ at: e.ts, kind: e.kind, payload: e.payload }))

      // ── 来源情报（内化自 nlp3 的 Source Intelligence）──────────────────
      // 每个源各自的战绩：抓了几条、有几条过门、平均分多少。
      // ★ 这一块不是为了好看 —— 它回答的是"哪个源该留、哪个源该换词"，
      //   也就是**让雷达能改进自己**的唯一依据。少了它，源清单就没人敢动。
      // ★★ 数据来自**落盘的那份运行报告**（`data/news/last-run.json`），
      //   不是进程内存里的事件。理由是实测出来的：事件活在内存里，编排器一重启就没了，
      //   面板会把 5 个源全画成「0 条」—— 而 0 是个**合法数字**，
      //   与"源真的什么都没拿到"长得一模一样，两者的下一步却完全相反（判据 24）。
      //   读不到就给 `null`，让界面说"还没跑过一轮"，而不是替它编一个 0
      //   （判据 13：读路径静默陈旧最危险 —— 下游会一起失效且看着还对）。
      const run = readLastRun(process.cwd())
      const fromRun = new Map<string, SourceReport>()
      for (const s of run?.sources ?? []) fromRun.set(s.source, s)
      const srcStat = new Map<
        string,
        { id: string; label: string; ok: boolean | null; got: number | null; kept: number; scoreSum: number }
      >()
      for (const s of NEWS_SOURCES) {
        const r = fromRun.get(s.id)
        srcStat.set(s.id, { id: s.id, label: s.label, ok: r?.ok ?? null, got: r?.got ?? null, kept: 0, scoreSum: 0 })
      }
      // 报告里有、而当前源清单里没有的源：**照实画出来**。
      // 悄悄丢掉它等于把"这个源上一轮还在用"这件事抹掉，而源清单的增删
      // 正是靠这一栏判断的。
      for (const [id, r] of fromRun) {
        if (!srcStat.has(id)) srcStat.set(id, { id, label: id, ok: r.ok, got: r.got, kept: 0, scoreSum: 0 })
      }
      for (const it of items) {
        const hit = [...srcStat.values()].find((s) => s.label === it.source)
        if (!hit) continue
        if (it.score >= KEEP_THRESHOLD) hit.kept += 1
        hit.scoreSum += it.score
      }

      const trend = readTrending(process.cwd())
      const uni = suggestedUniverse(process.cwd())
      return json(res, 200, {
        latest: items,
        // 每条都带 `matched` 与 `reasons`：面板要能回答"**为什么**觉得这条相关"。
        threshold: KEEP_THRESHOLD,
        sources: NEWS_SOURCES.map((s) => ({ id: s.id, label: s.label, kind: s.kind, why: s.why })),
        sourceStats: [...srcStat.values()].map((s) => ({
          ...s,
          // 分母优先用"这一轮抓了几条"（有报告时），没有报告就退回"几条过门"。
          // ★ 不写 `?? 0` —— null 会静默变成"平均 0 分"，那是个看着正常的错值。
          avgScore: Number((s.scoreSum / Math.max(1, s.got ?? s.kept)).toFixed(1)),
        })),
        terms: RELEVANCE_TERMS.map((t) => ({ term: t.term, weight: t.weight, why: t.why })),
        // 品种热度：这是雷达接回系统行为的那根线（breadth 的候选清单）。
        trending: trend ? { at: trend.at, ticks: trend.ticks } : null,
        universe: uni,
        proposals: proposalRows(process.cwd()).slice(-30).reverse(),
        pending: pendingProposalCount(process.cwd()),
        pendingSpeech: pendingSpeech(process.cwd()),
        // 「立即跑一轮」要用的那句话 = 自治循环里 news_watch 那一项的 goal。
        // ★ 不让界面自己拼：拼出来的目标与定时跑的目标就不是同一件事了，
        //   而两者长得一模一样（判据 8：同一件事不给第二条实现路径）。
        //   `?? ''` 而不是给个默认句子 —— 空串会让界面把按钮画成不可用，
        //   而不是偷偷跑一个"自己编的目标"。
        runGoal: AUTONOMY_JOBS.find((j) => j.id === 'news_watch')?.goal ?? '',
        recentEvents: recent,
        // 最近一轮的**报告**（各源战绩 + 那个时刻）。
        // ★ `null` = 这个工作目录还从来没跑过一轮 —— 界面必须把它与
        //   "跑了但全是 0"分开画，否则第一次打开面板的人会把"没有数据"
        //   读成"新闻源全挂了"。
        lastRun: run
          ? { at: run.at, fetched: run.fetched, kept: run.kept, fresh: run.fresh, speech: run.speech }
          : null,
      })
    }

    // 人对内化提案拍板（确认 / 驳回）。
    //
    // ★ 为什么是两段式（`confirmed` 必须显式为 true）：与舰队 `act` 类成员同一条红线 ——
    //   这是一次**治理动作**，会被写进账本。一次点击就落的裁决等于没有留痕。
    // ★ 裁决**只写不放行**：它不改任何交易状态、不放松任何门限。
    //   它记下"人看过这条提案了、这么判的"，仅此而已。
    if (url.pathname === '/fleet/news/verdict' && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const raw = await readBody(req)
      let body: { noteId?: unknown; index?: unknown; decision?: unknown; why?: unknown; by?: unknown; confirmed?: unknown }
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        return json(res, 400, { error: 'INVALID_JSON' })
      }
      const noteId = String(body.noteId ?? '')
      const index = Number(body.index ?? NaN)
      const decision = String(body.decision ?? '')
      const why = body.why
      const by = String(body.by ?? 'operator').slice(0, 40)
      if (decision !== 'approve' && decision !== 'reject') {
        return json(res, 400, { error: 'BAD_DECISION', note: 'decision 只能是 approve 或 reject' })
      }
      if (body.confirmed !== true) {
        return json(res, 422, {
          error: 'NEEDS_CONFIRMATION',
          note: '这是一次治理动作，会写进账本与 data/news/verdicts.jsonl —— 需要 confirmed:true 才落',
        })
      }
      // 提案必须真的存在。凭一个不存在的编号写裁决，等于往留痕里塞幽灵。
      const exists = proposalRows(process.cwd()).some((r) => r.noteId === noteId && r.index === index)
      if (!exists) {
        return json(res, 404, { error: 'NO_SUCH_PROPOSAL', note: `提案单里没有 ${noteId}#${index}` })
      }
      try {
        const p = appendNewsVerdict(process.cwd(), {
          noteId,
          index,
          decision,
          at: Date.now(),
          by,
          why: typeof why === 'string' && why.trim() ? why.trim().slice(0, 400) : null,
        })
        return json(res, 200, {
          ok: true,
          writtenTo: p,
          decision,
          pending: pendingProposalCount(process.cwd()),
          speech: pendingSpeech(process.cwd()),
        })
      } catch (e) {
        return json(res, 400, { error: 'BAD_VERDICT', note: e instanceof Error ? e.message : String(e) })
      }
    }

    // ── UI 动作通道（桌宠/语音 → 界面按钮）────────────────────────────────
    //
    // 这一组端点的**消费者是界面自己**：界面每 2 秒来取一次"有没有人要你按什么"，
    // 按完把结果报回去。于是"桌宠说按一下"与"人手点一下"落到同一个 DOM 元素上 ——
    // 这就是它存在的全部意义：不给桌宠开一条绕开界面的旁路。
    //
    // ★ 三条纪律：
    //   ① 只能排**注册表里登记过**的按钮（`UI_ACTIONS`）——
    //      一个"给我选择器我就点"的服务端等于一条任意动作通道；
    //   ② `writes: true` 的动作必须带 `confirmed: true`（人点出来的那一下）；
    //   ③ 取活时**顺手认领**（在服务端一步完成），否则两个窗口会同时按同一颗按钮。
    if (req.method === 'GET' && url.pathname === '/ui/actions') {
      return json(res, 200, {
        pages: UI_PAGES,
        actions: UI_ACTIONS,
        tasks: listTasks(uiWorkspaceRoot(), { limit: 40 }),
        queueSpeech: renderQueueSpeech(uiWorkspaceRoot()),
      })
    }

    if (req.method === 'GET' && url.pathname === '/ui/actions/pending') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      // ★ 读失败必须与"没有待执行"分开。把异常吞成空数组的后果是：
      //   界面上一切正常，而桌宠排的动作永远不会被执行 —— 沉默的半闭环。
      try {
        const who = String(url.searchParams.get('by') ?? 'ui').slice(0, 40)
        return json(res, 200, { tasks: claimPendingTasks(process.cwd(), who) })
      } catch (e) {
        return json(res, 200, {
          tasks: [],
          error: `QUEUE_UNREADABLE：${e instanceof Error ? e.message : String(e)} —— 这不等于「没有待执行」，是队列没读上`,
        })
      }
    }

    if (req.method === 'POST' && url.pathname === '/ui/actions') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      let body: { actionId?: unknown; confirmed?: unknown; by?: unknown; payload?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as typeof body
      } catch {
        return json(res, 400, { error: 'INVALID_JSON' })
      }
      // ★ `payload` 只收**对象**。收字符串/数组的话，`Object.keys('abc')` 会给出
      //   `['0','1','2']`，「参数校验」会一本正经地报"多了 0、1、2 这几个键"——
      //   看着像在做校验，其实是把类型错误翻译成了一句谁都看不懂的话。
      if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))) {
        return json(res, 400, { error: 'INVALID_PAYLOAD', message: 'payload 必须是一个对象（键值对），因为界面是按名字读它的。' })
      }
      const r = enqueueUiAction(uiWorkspaceRoot(), String(body.actionId ?? ''), {
        requestedBy: String(body.by ?? 'operator').slice(0, 40),
        confirmed: body.confirmed === true,
        ...(body.payload === undefined ? {} : { payload: body.payload as Record<string, unknown> }),
      })
      if (!r.ok) {
        // 422 只留给"缺人确认"这一种 —— 它和"这个动作不存在"的下一步动作完全不同，
        // 压成同一个状态码会让前端只能给出同一句话。
        return json(res, r.reason === 'UI_ACTION_NEEDS_CONFIRM' ? 422 : 404, { ok: false, reason: r.reason, speech: r.speech })
      }
      appendEvent('UI_ACTION_ENQUEUED', { id: r.task.id, actionId: r.task.actionId, page: r.task.page, requestedBy: r.task.requestedBy, confirmed: r.task.confirmed === true, ...(r.task.payload ? { payload: r.task.payload } : {}) })
      return json(res, 200, { ok: true, task: r.task })
    }

    const uiResult = /^\/ui\/actions\/([A-Za-z0-9_-]{4,40})\/result$/.exec(url.pathname)
    if (uiResult && req.method === 'POST') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      let body: { ok?: unknown; detail?: unknown; by?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as typeof body
      } catch {
        return json(res, 400, { error: 'INVALID_JSON' })
      }
      const r = completeUiAction(uiWorkspaceRoot(), uiResult[1]!, {
        ok: body.ok === true,
        detail: typeof body.detail === 'string' ? body.detail.slice(0, 300) : '',
        requestedBy: String(body.by ?? 'ui').slice(0, 40),
      })
      if (!r.ok) return json(res, 404, { error: r.reason })
      appendEvent('UI_ACTION_RESULT', { id: uiResult[1]!, ok: body.ok === true, detail: typeof body.detail === 'string' ? body.detail.slice(0, 300) : '' })
      return json(res, 200, { ok: true })
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
     * 查阅桌宠对话记录（Task #114）。
     *
     * ★ 为什么需要一个**端点**而不是让前端直接读文件：桌宠的两种形态
     *   （控制台页 / 悬浮窗）与将来任何客户端都要看同一份记录，
     *   而"读文件"这件事只能有一个实现（判据 8）。
     *
     * ★ 分页按 `beforeAt`（时间戳）而不是 `turnId`：`turnId` 是进程内自增，
     *   重启后会重复，拿它翻页会跳过或重复整段记录。
     *
     * ★ 端点**不改任何状态**：查阅不影响会话，也不写盘。
     */
    if (req.method === 'GET' && url.pathname === '/voice/transcript') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const limitRaw = Number(url.searchParams.get('limit') ?? '')
      const beforeRaw = Number(url.searchParams.get('beforeAt') ?? '')
      return json(
        res,
        200,
        voiceTranscript({
          ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
          ...(Number.isFinite(beforeRaw) && beforeRaw > 0 ? { beforeAt: beforeRaw } : {}),
        }),
      )
    }

    /**
     * 永久记忆查阅。
     *
     * ★ 它是**只读**的：查阅记忆不改变记忆（不写盘、不改会话）。
     *   与 `/voice/transcript` 同一条纪律 —— 一个"看一次就变一次"的查页面
     *   会让用户不敢用（而这正是他验收"你记不记得"的唯一手段）。
     *
     * ★ 为什么必须有这个端点：没有它的话，"桌宠记住了"这件事
     *   **无法被验收** —— 用户只能从"它答得对不对"反推，
     *   而猜对与记住在输出上长得一模一样（判据 D5）。
     */
    if (req.method === 'GET' && url.pathname === '/voice/memory') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      return json(res, 200, voiceMemoryView())
    }

    /**
     * ── 手机端远程指挥（Telegram）───────────────────────────────────────
     *
     * 读：通道状态 + 人话 + **待放行的会话清单**。
     *
     * ★ 为什么"待放行清单"是这里最要紧的一格：它第一次配置时**唯一**需要
     *   的信息就是"我那个会话的 chat id 是什么"。没有它，用户只能对着
     *   一段日志找 id，而那条日志在别的机器/别的窗口里。
     *   有了它，整个开通动作是：手机发一句 → 面板上点一下。
     *
     * ★ 需要授权：它带着陌生人的 chat id（可能是真名/用户名），
     *   也暴露"这道门现在的状态"。与 `/voice/memory` 同一条纪律。
     */
    if (req.method === 'GET' && url.pathname === '/voice/telegram') {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      return json(res, 200, telegramView())
    }

    /**
     * 放行 / 收回一个会话。
     *
     * ★★ 这个端点**只能由人**（拿着本地令牌的面板）调用，而且**绝不自动绑定**。
     *   "第一个发消息的人就是主人"是本模块最危险的一个默认值：
     *   它把一个"谁都能搜到的 bot username"变成"谁先说话谁就能下单"。
     *   所以开通动作必须是一次**人的点击**，不能由消息内容触发。
     *
     * ★ 两个方向都提供（allow / revoke），因为一个只能加不能减的权限表
     *   是一个死门：抄错一位数字之后，用户唯一的补救手段是手工改 JSON。
     */
    if (req.method === 'POST' && (url.pathname === '/voice/telegram/allow' || url.pathname === '/voice/telegram/revoke')) {
      if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
      const body = JSON.parse((await readBody(req)) || '{}') as { chatId?: unknown; label?: unknown }
      const chatId = String(body.chatId ?? '').trim()
      if (chatId.length === 0) return json(res, 422, { error: 'CHAT_ID_REQUIRED' })
      const label = String(body.label ?? '').slice(0, 40)
      const isAllow = url.pathname.endsWith('/allow')
      const ok = isAllow ? allowTelegramChat(chatId, label) : revokeTelegramChat(chatId)
      // ★ 返回**整份新状态**而不是 `{ok:true}`：面板上那一栏（白名单条数、
      //   待放行清单、人话）都得跟着变。只回一个布尔值时，前端要再拉一次，
      //   而那一次拉到的可能是"还没写完"的中间态。
      return json(res, ok ? 200 : 500, { ...telegramView(), changed: { chatId, action: isAllow ? 'allow' : 'revoke', ok } })
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
      const body = JSON.parse(await readBody(req)) as {
        text?: string
        attachments?: { name?: string; mimeType?: string; dataBase64?: string }[]
      }
      const text = typeof body.text === 'string' ? body.text : ''
      // 附件受理放在这一层，是因为它必须能被**单独观测**：
      // 「用户给了图但系统没看到图」这件事，事后只能靠这一条事件分辨。
      const attachments: RawAttachment[] = Array.isArray(body.attachments)
        ? body.attachments
            .filter((a) => a && typeof a.dataBase64 === 'string' && a.dataBase64.length > 0)
            .map((a) => ({ name: String(a.name ?? '未命名附件'), mimeType: a.mimeType, dataBase64: String(a.dataBase64) }))
        : []
      // ★ 只有附件、没有文字是合法输入（贴一张图问"这是什么"）。
      //   旧判据是"文字为空就 422"，那会把这条路径直接废掉。
      if (text.trim().length === 0 && attachments.length === 0) {
        return json(res, 422, { error: 'EMPTY_UTTERANCE' })
      }
      const r = await handleUtterance(text, attachments)
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

/**
 * ★★ 挂载**之前**先把这把钥匙的权限范围问清楚（2026-09-22 接进生产路径）。
 *
 * 为什么要在 attach 之前、而不是"以后有空再查"：
 * `attachAdapter()` 一旦返回，网关就认为"可以出网了"。而 `classifyKeyScope` 判的是
 * 一件**比单笔金额更根本**的事 —— 这把钥匙能不能**绕过本系统把资金提走**。
 * 能提币的 key 面前，1R 定规模 / 资金帽 / 宪法红线全都只是"系统自己愿意遵守"
 * （判据见 `keyScope.ts` 顶部）。所以它必须和"挂载"同一个时点被问到，
 * 否则它在时间线上就永远排在"已经可以下单了"之后。
 *
 * ★ 三态严格对应三种处置，**不许合并**（判据 13 / ㉚ 四态互不顶替的精神）：
 *   · ok           → 挂载
 *   · danger (P0)  → **不挂载**。这是 P0，不参与任何压制（红线 ⑤）。
 *   · unverifiable → **挂载，但把事说出来**。
 *     ★ 这里刻意**不**因为 unverifiable 而拒绝挂载，理由是本项目已确立的分工：
 *       权限取证失败的原因通常是**场所不支持该接口 / 网络不通**，而这类原因
 *       与"这笔交易该不该发"无关；把它升级成"拒绝挂载"会让一个**与交易无关的
 *       故障**停掉整条通道（判据 A1：误报比不报错更费人）。
 *       而 danger 不同：它是一个**已确证的**能力，危害是确定性的。
 *     ★ 但"挂载"不等于"沉默"：走 `appendEvent` + `console.warn` 两处都留痕，
 *       并写进下面的 `keyScopeNote`，让交易大厅能显示出来。
 *
 * ★ 失败不许吞：`fetchAccountRaw()` 抛错（401/网络）留给调用方 catch，
 *   由调用方决定是"本次是 unverifiable"还是"直接不挂载"。
 */
async function verifyAttachedKeyScope(venue: string, adapter: { fetchAccountRaw?: () => Promise<unknown> }): Promise<{ allow: boolean; note: string | null }> {
  if (typeof adapter.fetchAccountRaw !== 'function') {
    // 适配器没提供取证口（SandboxAdapter 等）—— 说清楚"没查"，不假装"查过了没问题"
    return { allow: true, note: null }
  }
  let raw: unknown
  try {
    raw = await adapter.fetchAccountRaw()
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 120) : String(e)
    appendEvent('KEY_SCOPE_UNVERIFIABLE', { venue, reason: msg })
    console.warn(`⚠️ [key-scope] ${venue} 权限未能确认（${msg}）· 交易通道保持可用，但请人工核对 BINANCE/OKX 后台的 key 权限`)
    return { allow: true, note: `权限未确认（${msg}）` }
  }

  const v = classifyKeyScope(venue, raw)
  appendEvent('KEY_SCOPE_CHECKED', {
    venue,
    status: v.status,
    read: v.read,
    trade: v.trade,
    withdraw: v.withdraw,
    severity: v.severity,
    summary: v.summary,
  })

  if (v.status === 'danger') {
    // P0：不挂载，且要用一段能直接照着做的处置说明
    console.error(`⛔ [key-scope] ${v.summary}`)
    for (const r of v.reasons) console.error(`   · ${r}`)
    return { allow: false, note: v.summary }
  }
  if (v.status === 'unverifiable') {
    console.warn(`⚠️ [key-scope] ${v.summary}`)
    for (const r of v.reasons) console.warn(`   · ${r}`)
    return { allow: true, note: v.summary }
  }
  console.log(`[OK] [key-scope] ${v.summary}`)
  return { allow: true, note: null }
}

async function attachVenue(): Promise<void> {
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
    // ★ 先问权限，再挂载（顺序不能反 —— 理由见 verifyAttachedKeyScope 顶部注释）
    const scope = await verifyAttachedKeyScope('binance-testnet', a)
    if (!scope.allow) return
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
    const scope = await verifyAttachedKeyScope('okx-testnet', a)
    if (!scope.allow) return
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
  // ★ 这个回调必须是 `async`：`attachVenue()` 现在要 await 一次权限自检
  //   （`verifyAttachedKeyScope`）。`.finally()` 的返回值会被串进链里，
  //   所以异步回调也能被正确等待 —— 下面的 `await attachVenue()` 不会变成悬空 promise。
  .finally(async () => {
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
    // 把"环境里已经有凭据的厂商"接进来。
    //
    // ★ 为什么必须做、且必须在启动时做：实测唯一启用的厂商（opencode）
    //   免费档对外部调用 403、付费档 402 —— 在修好这一点之前，整个系统里
    //   **没有任何一条路能真的调到模型**，于是桌宠对任何问题都只能回"我不会"。
    //   它不联网、也不动已有厂商，只新增一条被真调过的路（见 llmCatalog.ts）。
    const envProv = ensureEnvProvider()
    if (!envProv.registered) {
      console.log(`[llm] 未从环境变量注册厂商：${envProv.note}`)
      if (!getActiveLlm()) {
        console.log('[llm] ⚠️ 当前没有任何可用厂商 —— 桌宠会退化成"只能查系统数据"，无法回答开放问题')
      }
    } else {
      console.log(`[llm] 厂商 ${envProv.name} ${envProv.note} · ${envProv.models} 个已验证模型 · 首选 ${envProv.activeModel}`)
      // ★ 逐条打印账号明细：用户说「我多给配一些账号」，那他就要能一眼看见
      //   "系统到底认出几个、哪一个在册、哪一个新增"。只打一句"认出 3 个账号"
      //   回答不了"我新加的那一行生效了吗"这个问题。
      for (const d of envProv.details) console.log(`[llm]   · 账号 ${d}`)
      if (envProv.accounts > 1) {
        console.log(`[llm] 账号池 ${envProv.accounts} 个：某个账号额度打满会自动换下一个（额度按天复位，不永久拉黑）`)
      }
    }
    // ★ `await` 是刻意的：权限自检（`verifyAttachedKeyScope`）必须在"网关可用"
    //   这件事对外成立**之前**完成。若改成 fire-and-forget，会出现一个时间窗 ——
    //   窗口内网关已经能出网，而"这把钥匙能不能提币"还没问过。
    //   代价是启动多一次交易所往返（仅 VENUE != sandbox 时发生）。
    await attachVenue()
    bindRetentionDb(() => getDb() as never)
    startRetentionLoop(true)
    // 舰队注册表与消息总线在启动时就装好。装上才会有订阅者 ——
    // 而"某个主题没有订阅者"是注册表审计的一条硬红线，所以这一步是
    // `/fleet` 第一次被读时不会报红的前提，不能等到有请求才做。
    ensureFleetInstalled()

    // ── 自治循环：开机自启（用户要求「自循环需要长开」）──────────────────
    // ★ 必须放在 `ensureFleetInstalled()` **之后**：循环里的每一项都通过
    //   `runTask` 走注册表，注册表没装好就排程，第一次触发时每一项都会失败。
    // ★ 它只排程、不立即执行 —— 每一项都有自己的 initialDelayMs（最短 1 分钟），
    //   这是为了让启动过程本身干净（启动瞬间把所有任务一起打出去，
    //   会把"启动失败"与"任务失败"两种现象搅在一起）。
    {
      const auto = autostartAutonomy()
      const st = auto.status
      if (auto.reason === 'STARTED') {
        console.log(`[fleet] 自治循环已开机自启（${st.jobs.length} 项）：${st.jobs.map((j) => j.label).join(' / ')}`)
        for (const j of st.jobs) {
          const next = j.nextAt ? new Date(j.nextAt).toLocaleTimeString('zh-CN', { hour12: false }) : '未排程'
          console.log(`[fleet]   · ${j.label}：每 ${Math.round(j.everyMs / 3_600_000)} 小时一次，首次 ${next}`)
        }
        console.log('[fleet] 循环里只跑**可逆**动作；不可逆的（真删 / 下单 / 改码）只报告不动手。要关掉设 EV_AUTONOMY=off')
      } else if (auto.reason === 'ALREADY_RUNNING') {
        console.log('[fleet] 自治循环本来就在跑（幂等：没有重复排程）')
      } else if (auto.reason === 'DISABLED_BY_ENV') {
        console.log('[fleet] 自治循环被 EV_AUTONOMY 显式关掉了 —— 它不会自己动，只能人工触发')
      } else {
        console.log(`[fleet] ⚠️ 自治循环自启失败：${auto.detail}`)
      }
    }

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
      console.log(`  REST http://localhost:${PORT}/healthz /state /orders /killswitch /gateway/status /metrics /audit/verify /promotions /proposals /factors/index /factors/strategies /factors/generate /fleet /fleet/run /fleet/task /autopilot`)
      console.log(`  语音 http://localhost:${PORT}/voice/config /voice/state /voice/daily /voice/utterance /voice/interrupt /voice/stream(SSE)`)
      console.log(`  记忆/记录 http://localhost:${PORT}/voice/memory /voice/transcript   手机端 http://localhost:${PORT}/voice/telegram`)
      // 语音层必须在 initLedger 之后启动：它要从账本链尾对齐播报游标，
      // 早于持久层初始化会被当成"链是空的"从而把历史事件全部念一遍。
      startVoice()

      // ── 手机端通道（Telegram）─────────────────────────────────────────
      // ★ 启动**不带条件地尝试**，但结果必须**说出来**。四种状态里最危险的一种
      //   是"配了 token、白名单却是空的"：通道在跑、日志有"已启动"、
      //   而任何人的消息都会被拒 —— 用户看到的现象是"手机发了没反应"，
      //   会去查网络。所以这里一次把 configured / allowed / polling 报全。
      {
        const r = startTelegramPolling()
        if (!r.ok) {
          console.log(`[--] 手机端通道（Telegram）：未启动 —— ${r.reason}。配好 TELEGRAM_BOT_TOKEN 后重启即可。`)
        } else {
          const tv = telegramView()
          if (tv.allowedChats === 0) {
            console.warn(
              `[!!] 手机端通道（Telegram）在跑，但放行名单是空的 —— 现在**谁都不能**通过它下指令。` +
                `在手机上给 bot 发一句话，然后到监控页 /voice/telegram 点「放行」。`,
            )
          } else {
            console.log(`[OK] 手机端通道（Telegram）：${tv.allowedChats} 个会话可下指令 · ${tv.speech}`)
          }
          if (tv.chatListError) console.warn(`[!!] Telegram 白名单文件有问题：${tv.chatListError}`)
        }
        // ★ 退出时显式停一轮，好让账本里留下 `TELEGRAM_POLLING_STOPPED`。
        //   没有它的话，"被要求退出"与"自己死了"在事后查证里长得一模一样
        //   —— 而这两件事的处置方向完全相反（一个什么都不用做，一个要查异常）。
        //   `exit` 处理里抛异常会盖掉真正的退出码，所以这里一律吞掉。
        process.on('exit', () => {
          try {
            stopTelegramPolling()
          } catch {
            /* 退出路径不许再抛 */
          }
        })
      }
      // 后台预热过拟合证据：一次完整 walk-forward 约 20 秒。
      // 不预热则第一次点「跑 backtest 门」要干等 20 秒；预热失败不影响可用性。
      warmEvidence(SYMBOLS[0] ?? 'BTCUSDT')
      // 因子门的可达性自检：带阈值的闸门最隐蔽的失效是"永远不可能通过"
      // （门槛比数据规模还大 ⇒ 全部 unverifiable，不报错、台账照长）。
      // 历史存在却太短 ⇒ 直接抛；历史不存在 ⇒ 说出来但继续跑。
      try {
        const reach = checkGateReachable(SYMBOLS[0] ?? 'BTCUSDT')
        console.log(`[OK] 因子门可达性：${reach.reason}`)
      } catch (e) {
        console.error(`[FAIL] 因子门配置矛盾：${e instanceof Error ? e.message : e}`)
        throw e
      }
      const fi = factorIndexSummary()
      console.log(
        fi.available
          ? `[OK] 因子台账 ${fi.total} 条（通过 ${fi.accepted} / 不可验证 ${fi.unverifiable}）· ${fi.reason}`
          : `[--] 因子台账：${fi.reason}`,
      )
    })
  })
