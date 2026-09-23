import { evaluateCandidateGrid, genSynthCandles } from '../src/engine/index.ts'
import { buildAcceptedFactorStrategies } from './factorStrategyService.ts'
import type { CandidateResult, Candle } from '../src/engine/index.ts'
import { adx as computeAdx, atr as computeAtr } from '../src/engine/indicators.ts'
import { proposals } from './proposals.ts'
import type { ProposalVerdict } from './proposals.ts'
import { getActiveLlm, chatComplete } from './llmProviders.ts'
import { renderRiskBrief } from './riskBrief.ts'
import { renderCostBrief } from './costModel.ts'
import { activeLessonTexts } from './evolutionShield.ts'
import { assembleContext, renderBudgetReport, DEFAULT_CONTEXT_BUDGET_TOKENS } from './contextBudget.ts'
import type { AssembledContext } from './contextBudget.ts'
import { validateClaims, summarizeReport } from './claimValidator.ts'
import type { MeasuredFacts, ValidationReport } from './claimValidator.ts'
import { loadEvidence } from './evidence.ts'
import type { OrchState } from './types.ts'

export interface GenerateOptions {
  source?: 'llm' | 'human'
  maxProposals?: number
  autoPromoteCandidate?: boolean
  candles?: Candle[]
}

/** 单个提案声称核验结果。 */
export interface ClaimCheck {
  proposalId: string
  outcome: ValidationReport['outcome']
  summary: string
  reason: string
  /** 因声称与实测冲突而被本引擎丢弃（未进入提案队列）。 */
  dropped: boolean
}

export interface GenerateResult {
  source: 'llm' | 'human'
  llmUsed: boolean
  verdicts: ProposalVerdict[]
  promotedStrategyIds: string[]
  gridTop: { id: string; fitness: number }[]
  /** 本轮提案所用的**数据来源**。这个事实必须可观测： */
  dataOrigin: string
  /** 声称核验：模型说的与实测是否对得上。空数组表示本轮无 LLM 提案或未启用核验。 */
  claimChecks: ClaimCheck[]
  /** 上下文预算执行情况。提示词有没有被裁必须是可回溯事实，而不是出问题时才想起的问题。 */
  context: Pick<AssembledContext, 'includedIds' | 'droppedIds' | 'truncatedIds' | 'estimatedTokens' | 'budgetTokens' | 'ok'> & {
    report: string
  }
}

/**
 * 从**本轮实际用于决策的 K 线**里算出可核对的实测事实。
 *
 * 两个刻意的克制：
 *   ① 周期必须如实标注。本引擎拿到的是 15 分钟合成/注入 K 线，
 *      所以 `timeframe` 就是 '15M'。谎报成 '1H' 会让「模型声称 1H ADX 28、
 *      实测 15M ADX 28」被判成一致 —— 而这两个数根本不是同一个量。
 *   ② 拿不到就不填。`macroTrend` 在本函数里**刻意留空**：
 *      高周期结构由 marketRegime 从 1H 数据派生，本引擎手里没有那份输入。
 *      留空 → 相关声称判 UNVERIFIABLE（诚实地说「核不了」），
 *      而不是填一个 'RANGE' 让所有趋势声称都被判成「与实测冲突」（那是在制造假冲突）。
 *
 * 导出给 HTTP 层复用：面板/接口要核验一段理由时，
 * 必须用与提案引擎**同一套**事实派生逻辑。各写一份就会出现
 * 「引擎算出 ADX 18 判通过、面板算出 ADX 22 判冲突」这种谁都没错的矛盾。
 */
export function measureFacts(candles: Candle[]): MeasuredFacts {
  const n = candles.length
  if (n === 0) return {}
  const high = candles.map((c) => c.h)
  const low = candles.map((c) => c.l)
  const close = candles.map((c) => c.c)
  const price = close[n - 1]
  const atrArr = computeAtr(high, low, close, 14)
  const adxArr = computeAdx(high, low, close, 14).adx
  const fact = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) ? v : undefined)
  return {
    timeframe: '15M',
    price: Number.isFinite(price) ? price : undefined,
    atr: fact(atrArr[n - 1]),
    adx: fact(adxArr[n - 1]),
  }
}

function buildCandles(state: OrchState, injected?: Candle[]): { candles: Candle[]; origin: string } {
  if (injected && injected.length >= 120) return { candles: injected, origin: 'injected' }
  // ── 数据来源：优先真实历史，与门禁同源 ──────────────────────────────
  //
  // 旧写法是"种子按小时轮换的合成 GBM"，而下游的过拟合门禁
  // （`server/evidence.ts`）吃的是 `data/history/*.json` 真实历史 ——
  // 于是**提案在被挑选时用的是一套数据、被判决时用的是另一套**。
  //
  // 这不是"精度不够"，是两个具体且已发生的后果：
  //   ① 合成 GBM 里不存在可被策略捕捉的结构（evidence.ts 的开篇实测表
  //      已把这条钉死）。在这一套数据上按 fitness 取 Top-N，选出来的
  //      **是噪声排名**，而不是"候选里最好的那个"。
  //   ② 种子每小时换一次，所以同一批候选每隔一小时就得到一套不同的排名，
  //      产出的提案与写进心法库的经验都在跟着漂 —— 事后无法复现任何结论。
  //
  // 改法就是让两级吃同一份数据。回落到合成时**把 origin 标出来**，
  // 让下游能分辨"这份提案是在真行情上挑的还是在合成行情上挑的"。
  const ev = loadEvidence('BTCUSDT', 15)
  if (ev.origin === 'history' && ev.candles.length >= 120) {
    return { candles: ev.candles, origin: `history:${ev.symbol}:${ev.bars}bars:${ev.dataHash}` }
  }
  // 没有真实历史时的兜底保持原样（确定性合成），但 origin 里必须写明是合成。
  const seed = 42 + Math.floor(Date.now() / 3_600_000)
  void state
  return {
    candles: genSynthCandles({ seed, bars: 960, startPrice: 3500, volDaily: 0.04, driftDaily: 0.0003, barMinutes: 15 }),
    origin: `synthetic:seed=${seed}`,
  }
}

function heuristicProposals(grid: CandidateResult[], origin: string, max: number): Array<Record<string, unknown>> {
  // 取适应度降序的 Top-N（含负值）：提案仅进入 candidate 观察阶段，负适应度会在 backtest 门被拒绝
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < Math.min(max, grid.length); i++) {
    const c = grid[i]
    const params = Object.fromEntries(Object.entries(c.result.meta.params).map(([k, v]) => [k, Number(v)]))
    const kind = i === 0 ? 'new-strategy' : 'param-mutation'
    // 候选 id 含 JSON 片段，需压缩为合法标识符 [A-Za-z0-9._:-]
    const safeTarget = c.id.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/-+/g, '-').slice(0, 80)
    const negTag = c.fitness <= 0 ? ' negative-fitness (will be rejected at backtest gate)' : ''
    out.push({
      proposalId: `pe-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'human',
      kind,
      targetStrategyId: kind === 'param-mutation' ? safeTarget : undefined,
      params,
      rationale: `[proposal-engine] rank#${i + 1} by ${c.fitnessVersion} on ${origin}: fitness=${c.fitness} ann=${c.report.annReturnPct.toFixed(1)}% dd=${c.report.maxDrawdownPct.toFixed(1)}%${negTag}`,
      createdBy: 'proposal-engine:deterministic',
    })
  }
  return out
}

const SYSTEM_PROMPT =
  '你是量化策略变异提案器。只输出 JSON 数组，元素字段：proposalId(8-80位 [A-Za-z0-9._:-])、kind("param-mutation"|"new-strategy")、targetStrategyId(param-mutation 必填)、params(数值映射)、rationale(<=500字)。' +
  '用户消息中的【本周期风险预算】是执行层实时硬约束，你的提案参数必须落在其中声明的边界内；' +
  '越界提案不会"被执行失败"，而是直接被物理拦截并降级为 WAIT。禁止输出任何其他文本。'

/**
 * LLM 给出的 proposalId 经常不合规（过短、含中文、含空格或标点）。
 * 引擎强制修正，不信任模型输出——实测 deepseek-v4-flash-free 首次调用即因
 * id 非法被拒（INVALID_PROPOSAL_ID），必须兜底。
 */
function sanitizeProposalId(raw: unknown): string {
  const fallback = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  if (typeof raw !== 'string') return fallback
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/-+/g, '-').slice(0, 80)
  return cleaned.length >= 8 ? cleaned : fallback
}

async function callLlm(prompt: string): Promise<Array<Record<string, unknown>> | null> {
  const active = getActiveLlm()
  if (!active) return null
  const content = await chatComplete(active, SYSTEM_PROMPT, prompt)
  if (!content) return null
  const jsonStart = content.indexOf('[')
  const jsonEnd = content.lastIndexOf(']')
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null
  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1))
    if (!Array.isArray(parsed)) return null
    // 来源由引擎强制标注，关键字段由引擎校正，不信任 LLM 自报
    const out: Array<Record<string, unknown>> = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      item.source = 'llm'
      item.createdBy = `llm:${active.name}/${active.model}`
      item.proposalId = sanitizeProposalId(item.proposalId)
      // kind 必须是两者之一；param-mutation 还要求有 targetStrategyId，否则降级为 new-strategy
      if (item.kind !== 'param-mutation' && item.kind !== 'new-strategy') item.kind = 'param-mutation'
      if (item.kind === 'param-mutation' && typeof item.targetStrategyId !== 'string') item.kind = 'new-strategy'
      if (typeof item.params !== 'object' || item.params === null) item.params = {}
      if (typeof item.rationale !== 'string' || !item.rationale) {
        item.rationale = `[llm:${active.model}] 未提供理由`
      } else if (item.rationale.length > 500) {
        item.rationale = item.rationale.slice(0, 500)
      }
      out.push(item)
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export async function generateProposals(state: OrchState, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const max = Math.max(1, Math.min(opts.maxProposals ?? 2, 5))
  const { candles, origin } = buildCandles(state, opts.candles)
  // ── 因子生产线 → 候选池的唯一接线点 ──────────────────────────────────
  //
  // 在这一行之前，本项目有两条彼此看不见的线：
  //   ① 因子生产线把 accepted 写进 `data/factors/index.json`
  //   ② 提案引擎只搜它那 12 个手写策略
  // 结果"因子批量生产达标"在生产上不可见 —— 台账在磁盘上安静地长。
  //
  // ★ `buildAcceptedFactorStrategies` 会**拒绝**行情指纹已变的台账行，
  //   并把原因放进 `skipped`。这里把它说出来而不是吞掉：
  //   一条"因子明明接受了却没进候选池"的静默失效，排查成本极高。
  const factorPick = buildAcceptedFactorStrategies()
  if (factorPick.skipped.length > 0) {
    console.log(
      `[proposal-engine] 因子策略未入池 ${factorPick.skipped.length} 条：` +
        factorPick.skipped.map((s) => `${s.slug}(${s.reason})`).join(' · '),
    )
  }
  const grid = evaluateCandidateGrid(candles, 15, factorPick.strategies)

  // 有可用 LLM 时默认走模型提案（测试期统一用免费模型），无可用 LLM 时自动降级确定性引擎。
  // 此前默认 'human'，导致即使 provider 已启用，Agent 团队也不会参与因子挖掘。
  let source: 'llm' | 'human' = opts.source ?? (getActiveLlm() ? 'llm' : 'human')
  let raws: Array<Record<string, unknown>> | null = null

  // 实测事实由**本轮真正拿去优化的同一批 K 线**算出（不是另拉一份数据）。
  // 另拉一份会出现「优化用 A 数据、核验用 B 数据」，两边都对但结论不一致。
  const facts = measureFacts(candles)

  // 上下文组装：强制块（风控口径 + 成本口径）优先占位，其余按优先级装入。
  // 为什么不能简单拼接字符串：拼接没有预算概念，心法库一长就会把风控约束挤出窗口，
  // 而模型不会报错——它只是开始提越界提案。裁剪必须可见（见 context.report）。
  const topSummary = grid.slice(0, 3).map((c) => ({ id: c.id, fitness: c.fitness, params: c.result.meta.params }))
  // ★ 心法库（白盒自动维护的经验）必须真的进上下文，否则整个心法库就是"只写不读"。
  // 原状的教训：`activeLessonTexts()` 曾被导出却**零调用方** ——
  // 提案/健康分/衰减/UI 全都在跑，唯独"回注决策"这一环断了（F-45）。
  // 而这恰恰是该模块存在的理由：注释写着"一旦回注进决策上下文，方向性判断就被永久污染"，
  // 说明设计上它是**会**被回注的。断了以后外部没有任何症状 —— 这正是它危险的地方。
  // 优先级 4、非强制、可裁：它必须能被裁掉，否则心法一长就会把风控/成本口径挤出窗口。
  const lessonTexts = activeLessonTexts()
  const assembled = assembleContext(
    [
      { id: 'task', text: `请提出最多 ${max} 条有区分度的变异提案。`, priority: 10, mandatory: true },
      // 两个强制块都不可裁：缺少任一，模型就在「无风险边界」或「无成本世界」里提案，
      // 而它永远不知道自己越界了 —— 表现只是成交长期为零。
      { id: 'risk-brief', text: renderRiskBrief(), priority: 20, mandatory: true },
      { id: 'cost-brief', text: renderCostBrief(), priority: 21, mandatory: true },
      ...(lessonTexts.length > 0
        ? [
            {
              id: 'lessons',
              text: `【交易心法（按健康分降序，最多 8 条）】\n${lessonTexts.map((t) => `- ${t}`).join('\n')}`,
              priority: 4,
              truncatable: true,
            },
          ]
        : []),
      { id: 'grid-top3', text: `当前候选网格 Top3: ${JSON.stringify(topSummary)}`, priority: 5, truncatable: true },
      { id: 'data-origin', text: `数据来源 ${origin}。`, priority: 3 },
    ],
    DEFAULT_CONTEXT_BUDGET_TOKENS,
  )

  const contextInfo = {
    includedIds: assembled.includedIds,
    droppedIds: assembled.droppedIds,
    truncatedIds: assembled.truncatedIds,
    estimatedTokens: assembled.estimatedTokens,
    budgetTokens: assembled.budgetTokens,
    ok: assembled.ok,
    report: renderBudgetReport(assembled),
  }

  if (!assembled.ok) {
    // 强制块放不下时**不发起请求**：一个缺少风控口径的提案请求比不请求危险得多。
    // 同时如实把 source 回落为确定性引擎，避免「看起来调了模型其实没调」。
    source = 'human'
  }

  const claimChecks: ClaimCheck[] = []

  if (source === 'llm') {
    // 把执行层的实时风控口径与成本口径插值进用户消息（R20「提示词口径 == 代码口径」范式）。
    // 不插值的话，模型只能凭先验猜门槛，产出的提案会被物理拦下而它无从修正——
    // 表现为「模型很努力但成交为零」，真因却是提示词里没有边界。
    raws = await callLlm(assembled.text)
    if (!raws) {
      source = 'human'
    } else {
      // ── 声称核验：模型说的趋势/ADX/ATR/盈亏比，与实测对得上吗 ──────────
      // 刻意用 `requireVerified: false`：本引擎手里只有 15M K 线、没有高周期结构，
      // 实测输入本就稀缺，此时把「核不了」当成「不合格」会让所有提案无差别阵亡。
      // 但 `REJECTED`（声称与实测**直接冲突**）任何情况下都不放行 ——
      // 一个敢声称「ADX 28」而实测只有 12 的提案，问题不在它算错了，在它编了。
      const kept: Array<Record<string, unknown>> = []
      for (const raw of raws) {
        const rationale = typeof raw.rationale === 'string' ? raw.rationale : ''
        const report = validateClaims(rationale, facts, { requireVerified: false })
        const proposalId = typeof raw.proposalId === 'string' ? raw.proposalId : '(未命名)'
        const dropped = report.outcome === 'REJECTED'
        claimChecks.push({
          proposalId,
          outcome: report.outcome,
          summary: summarizeReport(report),
          reason: report.reason,
          dropped,
        })
        if (!dropped) kept.push(raw)
      }
      raws = kept.length > 0 ? kept : null
      if (!raws) source = 'human'
    }
  }
  if (!raws) raws = heuristicProposals(grid, origin, max)

  const verdicts: ProposalVerdict[] = []
  const promotedStrategyIds: string[] = []
  for (const raw of raws.slice(0, max)) {
    const v = proposals.receive(raw)
    verdicts.push(v)
    if (v.ok && v.proposal && v.proposal.kind === 'new-strategy' && (opts.autoPromoteCandidate ?? true)) {
      const pr = proposals.promoteToCandidate(v.proposal.proposalId)
      if (pr.ok && pr.strategyId) promotedStrategyIds.push(pr.strategyId)
    }
  }

  return {
    source,
    llmUsed: source === 'llm' && raws !== null,
    dataOrigin: origin,
    verdicts,
    promotedStrategyIds,
    gridTop: grid.slice(0, max).map((c) => ({ id: c.id, fitness: c.fitness })),
    claimChecks,
    context: contextInfo,
  }
}
