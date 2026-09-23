/**
 * 语音管家的能力注册表（工具层）
 *
 * ── 这一层要解决什么 ────────────────────────────────────────────────
 * 只读实况（`awareness.ts`）让管家"知道"，但知道不等于能办事。
 * 用户说「进化一下自己」，需要真的有人去跑提案引擎；说「记住这条教训」，
 * 需要真的有人去写进心法库。这一层就是那双手。
 *
 * ── 为什么每个工具**必须**声明 `reuses` ──────────────────────────────
 * 本仓库有一条从语音层第一天起就立着的红线：
 * **不允许任何"语音专用实现"。**
 * 一条语音单的拒绝理由必须与界面按钮得到的**逐字相同**，
 * 因为"再写一条判断"看着一样，实际上风控根本没被执行到。
 *
 * 光靠纪律记不住，所以把它做成机制：每个工具强制填 `reuses`（它复用哪条既有路径），
 * 空字符串 = 注册失败，由 `auditToolRegistry()` 在门禁里当场报红
 * （`test:voice` S14）。将来有人想在语音层"就地造一个"，
 * 他会先卡在"这一栏填什么"上 —— 那一刻他就会去看既有实现在哪。
 *
 * ── act 工具必须经确认 ──────────────────────────────────────────────
 * 每个 `kind: 'act'` 的工具都必须给出 `intent`，且该意图必须在
 * `intents.ts` 的 `DANGEROUS` 名单里。断言在 `auditToolRegistry()`。
 * 这条不是形式主义：`file_lesson` 改的是**未来所有决策都要读的心法库**，
 * 副作用比一笔小额下单更持久。
 */
import { getOrchState } from '../core.ts'
import { generateProposals, type GenerateResult } from '../proposalEngine.ts'
import {
  LESSON_CATEGORIES,
  lessonEvidenceFromEvents,
  loadLessons,
  proposeLesson,
  type LessonCategory,
} from '../evolutionShield.ts'
import { auditSnapshotObservability, renderObservabilityBrief } from '../decisionObservability.ts'
import { getEvents } from '../ledger.ts'
import { isDangerous } from './intents.ts'
import type { VoiceIntentName } from './types.ts'
// ★ 只引三个 `speak*` 出口，不引底层的 `situation()` / `fleetStandings()` / `labOverview()`：
// 那些是"数据"，而工具产出的必须是"话"。多引一个，就多一条绕过统一措辞的机会。
import { speakAgentFleet, speakFleet, speakLab, speakSituation } from './awareness.ts'
// 舰队任务链：与面板的「跑这个任务」、`POST /fleet/task` 是**同一个调度器**。
// 语音层不自己拼成员链 —— 那会长出第二条"能听懂什么"的口径。
import { renderTaskBrief, runTask } from '../fleet/index.ts'
// 受控出网：白名单 + 私网拦截 + 截断都在 `net/egress.ts` 里，这里只用它的结果。
import { webSearch } from '../net/egress.ts'
// 走势预测：只读。工具层**不自己实现**任何预测/措辞逻辑 ——
// `forecastSpeech` 与面板念的是同一个出口（判据 8）。
import { forecast, forecastSpeech, resolveHorizon } from '../forecastService.ts'
import { askModel } from './model.ts'

export type VoiceToolKind = 'read' | 'act'
export type VoiceToolCost = 'instant' | 'slow'

export interface VoiceToolResult {
  ok: boolean
  speech: string
  /** 执行过程逐步留痕 —— 由 service 层逐条播报，是"实时报告工作进度"的数据源。 */
  steps: string[]
  detail?: unknown
  /** 未通过时的原因。**必须可念**（不能是 JSON 片段），否则用户听不懂。 */
  reason?: string
}

export interface VoiceTool {
  id: string
  label: string
  kind: VoiceToolKind
  cost: VoiceToolCost
  /** ★ 复用哪条既有路径。空字符串 = 注册失败。 */
  reuses: string
  /** `kind: 'act'` 必填，且必须是 DANGEROUS 里的意图。 */
  intent?: VoiceIntentName
  run: (arg?: string) => VoiceToolResult | Promise<VoiceToolResult>
}

// ─────────────────────────── 只读工具 ───────────────────────────

const READ_TOOLS: VoiceTool[] = [
  {
    id: 'situation',
    label: '系统实况',
    kind: 'read',
    cost: 'instant',
    reuses: 'voice/awareness.ts 的 situation()（内部读 autopilotStatus / pipelineService / lessonStats / 账本）',
    run: () => ({ ok: true, speech: speakSituation(), steps: ['读取系统实况（只读，无副作用）'] }),
  },
  {
    id: 'fleet',
    label: '舰队排行',
    kind: 'read',
    cost: 'instant',
    reuses: 'voice/awareness.ts 的 fleetStandings()（内部读 pipelineService.list() + autopilotStatus().winner）',
    run: () => ({ ok: true, speech: speakFleet(), steps: ['读取晋级流水线', '按晋级阶段再按适应度排序'] }),
  },
  {
    id: 'lab',
    label: '进化实验室',
    kind: 'read',
    cost: 'instant',
    reuses: 'voice/awareness.ts 的 labOverview()（内部读 lessonStats / loadLessons / pipelineService.list()）',
    run: () => ({ ok: true, speech: speakLab(), steps: ['读取心法库', '读取晋级流水线阶段分布'] }),
  },
  {
    id: 'brain',
    label: '决策大脑可观测量',
    kind: 'read',
    cost: 'instant',
    reuses: 'decisionObservability.auditSnapshotObservability()（与 GET /decisions/observability 同一批记录、同一判据）',
    run: () => {
      const records = getEvents(0)
        .filter((e) => e.kind === 'AUTOPILOT_POSITION_OPENED')
        .map((e) => e.payload as Record<string, unknown>)
      const audit = auditSnapshotObservability(records)
      return {
        ok: true,
        speech:
          audit.total === 0
            ? '决策大脑还没有已结束的决策样本，所以数理归因这一项现在没有数。'
            : `${renderObservabilityBrief(audit)}。占比越高，从这批样本里提炼心法才越站得住。`,
        steps: [`按 AUTOPILOT_POSITION_OPENED 取到 ${audit.total} 条已结束决策`],
        detail: audit,
      }
    },
  },
  {
    id: 'lessons',
    label: '心法库',
    kind: 'read',
    cost: 'instant',
    reuses: 'evolutionShield.loadLessons()（与 GET /evolution/lessons 同一个读取函数）',
    run: () => {
      const all = loadLessons()
      const active = all.filter((l) => l.enabled)
      const top = [...active].sort((a, b) => b.healthScore - a.healthScore).slice(0, 3)
      return {
        ok: true,
        speech:
          all.length === 0
            ? '心法库是空的。'
            : `心法库共 ${all.length} 条，生效 ${active.length} 条。健康分最高的三条是：` +
              top.map((l) => `${l.ruleText}（${l.healthScore.toFixed(1)} 分，${l.sampleSize} 笔证据）`).join('；') +
              '。',
        steps: [`读取心法库 ${all.length} 条`],
        detail: { total: all.length, active: active.length },
      }
    },
  },
  {
    id: 'agent_fleet',
    label: 'Agent 舰队成员状态',
    kind: 'read',
    cost: 'instant',
    reuses:
      'server/fleet/service.ts 的 fleetSnapshot()（与 GET /fleet 同一份实况、同一批 FLEET_AGENT_RUN 账本事件）',
    run: () => ({
      ok: true,
      speech: speakAgentFleet(),
      steps: ['读账本里的 FLEET_AGENT_RUN 事件', '审计舰队注册表（孤岛 / 非法动作意图 / 无订阅者主题）', '读消息总线投递记录'],
    }),
  },
  {
    id: 'forecast',
    label: '走势预测（只读，不下单）',
    kind: 'read',
    cost: 'slow',
    reuses:
      'server/forecastService.ts 的 forecast() / forecastSpeech()（与 GET /forecast 同一个出口、同一份成本口径与门槛；下单仍然只走 POST /orders/precheck 的交易闸门）',
    run: (arg?: string) => {
      // `arg` 是 JSON：`{ symbol, horizonMinutes }`。
      // ★ 解析失败就**拒绝**，不给默认值 —— 缺省的 symbol 会变成"预测了另一个币"。
      let req: { symbol?: string; horizonMinutes?: number } = {}
      try {
        req = JSON.parse(arg ?? '{}') as typeof req
      } catch {
        return { ok: false, reason: 'BAD_FORECAST_ARGS', speech: '我没听出要预测哪个标的。请说「预测一下比特币未来一小时」。', steps: [] }
      }
      const symbol = (req.symbol ?? '').trim().toUpperCase()
      if (!symbol) {
        return { ok: false, reason: 'FORECAST_SYMBOL_MISSING', speech: '你要我预测哪个标的？说「预测一下比特币未来一小时」这样。', steps: [] }
      }
      // ★「未来一小时」→ 多少根，由**预测层**决定（只有它有"哪一档分辨率有真证据"的知识）。
      //   语音层只交出分钟数。实测过的坑：直接用 1m × 60 根会去找不存在的
      //   `BTCUSDT_1m.json`，静默回落到合成 GBM，判决变成"样本不足，攒数据" ——
      //   事因指错了方向，而用户看到的是一句完全合理的话（判据 25）。
      const h = resolveHorizon(req.horizonMinutes ?? 60)
      const r = forecast({ symbol, config: { horizonBars: h.horizonBars, barMinutes: h.barMinutes } })

      const steps: string[] = [
        `取 ${symbol} 的 ${r.barMinutes} 分钟历史：${r.sample.candidates} 根，来源 ${r.origin}`,
        `用 ${r.state.length} 个状态量在历史里找相似的时刻：命中 ${r.sample.matched} 个，因未来重叠跳过 ${r.sample.separated} 个`,
        r.calibration
          ? `样本外校准：${r.calibration.anchors} 个锚点，命中率 ${(r.calibration.hitRate * 100).toFixed(1)}%，基准线 ${(r.calibration.baseRate * 100).toFixed(1)}%`
          : '样本外校准：锚点不足，没算出来',
        // ★ 复用要**说出来**。不说的话，用户以为每次都是现算的，
        //   而"看起来一样、实际是半小时前的数"这件事在界面上完全看不出来（判据 11）。
        r.cache.hit ? '这份结论是复用的（同一份证据、同一个候选集，数字与现算一致）' : `现算了一遍，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`,
      ]
      const head = h.rounded
        ? // ★ 分辨率对不齐必须说 —— 不说的话，用户以为自己拿到的是"未来 5 分钟"的预测。
          `先说一句：你要的是 ${h.askedMinutes} 分钟，但这台机器的历史只有 ${h.barMinutes} 分钟一根，所以我按 ${h.actualMinutes} 分钟算。`
        : ''
      return {
        ok: true,
        speech: head + forecastSpeech(r),
        steps,
        detail: {
          symbol: r.symbol,
          outcome: r.outcome,
          gate: r.gate,
          direction: r.direction,
          target: r.target,
          interval: r.interval,
          medianBps: r.medianBps,
          netEdgeBps: r.netEdgeBps,
          path: r.path,
          calibration: r.calibration,
          state: r.state,
          sample: r.sample,
          cache: r.cache,
          horizonMinutes: h.actualMinutes,
          asOf: r.asOf,
          spot: r.spot,
          reasons: r.reasons,
          disclosures: r.disclosures,
        },
      }
    },
  },
  {
    id: 'web_lookup',
    label: '联网查一件事',
    kind: 'read',
    cost: 'slow',
    reuses: 'server/net/egress.ts 的 webSearch()（受控出网：域名白名单 + 拒私网回环与云元数据地址 + 正文截断）',
    run: async (arg?: string) => {
      const q = (arg ?? '').trim()
      if (q.length < 2) {
        return {
          ok: false,
          reason: 'QUERY_TOO_SHORT',
          speech: '你得告诉我要查什么。比如说「上网查一下资金费率怎么算」。',
          steps: [],
        }
      }
      const s = await webSearch(q)
      if (!s.ok) {
        // ★ 失败原因里区分"没连上/被白名单拦"与"页面结构变了"。
        //   两者的下一步动作完全不同：前者去改白名单，后者去改解析器。
        return {
          ok: false,
          reason: s.parseFailed ? 'PARSE_FAILED' : 'EGRESS_FAILED',
          speech: s.parseFailed
            ? `我拿到了搜索结果页，但一条都没解析出来 —— ${s.note}。这更可能是页面结构变了，不是没有结果。`
            : `这次联网没成：${s.note}。`,
          steps: [`搜索「${q}」`, s.note],
        }
      }
      const evidence = s.hits
        .slice(0, 5)
        .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`)
        .join('\n\n')
      // 搜到之后交给模型总结 —— 直接把 5 条网页标题念出来对用户没有用。
      const a = await askModel(`用户问：${q}\n\n下面是刚从网上搜到的结果。请用两三句中文总结要点，并在句末用 [1] 这样的角标标出依据来自第几条。不要编造结果里没有的内容。`, {
        extraContext: evidence,
      })
      if (!a.ok) {
        // 模型不可用时**不能装总结**：把原始结果如实报出来，并说明只报不析。
        return {
          ok: true,
          speech: `搜到了 ${s.hits.length} 条，但我现在没法替你总结（${a.reason === 'NO_PROVIDER' ? '没有可用模型' : '模型调用失败'}）。原始结果前两条是：${s.hits
            .slice(0, 2)
            .map((h) => `${h.title} —— ${h.snippet.slice(0, 80)}`)
            .join('；')}。`,
          steps: [`搜索「${q}」：${s.note}`, `总结失败：${a.reason}`],
          detail: s,
        }
      }
      return {
        ok: true,
        speech: `${a.speech}（来源：${s.hits.slice(0, 3).map((h) => h.title.slice(0, 24)).join('、')}）`,
        steps: [`搜索「${q}」：${s.note}`, `由 ${a.model} 总结${a.degraded ? '（发生降级）' : ''}`],
        detail: { hits: s.hits, answer: a.speech, model: a.model },
      }
    },
  },
  {
    id: 'ask_model',
    label: '问大模型（兜底）',
    kind: 'read',
    cost: 'slow',
    reuses: 'server/modelRouter.ts 的 routeChat()（与提案引擎同一条候选链、同一份已验证名单）',
    run: async (arg?: string) => {
      const a = await askModel(arg ?? '')
      return { ok: a.ok, speech: a.speech, steps: a.steps, reason: a.reason, detail: { model: a.model, degraded: a.degraded } }
    },
  },
]

// ─────────────────────────── 动作工具 ───────────────────────────

/**
 * 从一句话里判心法类别。
 *
 * ★ 判不出来就**拒绝**，并列合法值 —— 绝不猜一个类别写进去。
 * 猜错的后果不是"这条心法没用"，而是它会以错误的类别被回注进提案上下文，
 * 从而**长期污染方向性判断**（这正是心法库存在风险的地方）。
 */
export function inferLessonCategory(text: string): { category: LessonCategory | null; label: string } {
  const hints: { re: RegExp; category: LessonCategory; label: string }[] = [
    { re: /(风控|止损|回撤|爆仓|杠杆|仓位上限|亏损)/, category: 'RISK_CONTROL', label: '风控' },
    { re: /(趋势|突破|追涨|顺走势)/, category: 'TREND_FOLLOWING', label: '趋势跟随' },
    { re: /(胜率|连亏|连赢|盈亏比)/, category: 'WIN_RATE_LOCK', label: '胜率锁定' },
    { re: /(分散|相关性|组合|对冲)/, category: 'PORTFOLIO_DIVERSIFICATION', label: '组合分散' },
    { re: /(滑点|成交|手续费|成本|流动性|深度|盘口)/, category: 'EXECUTION_QUALITY', label: '执行质量' },
    { re: /(行情|市况|震荡|波动|时段|夜里|周末)/, category: 'REGIME_ADAPTATION', label: '市况适应' },
  ]
  const hit = hints.find((h) => h.re.test(text))
  return hit ? { category: hit.category, label: hit.label } : { category: null, label: '' }
}

/** `generateProposals` 的结果 → 已发生的、可播报的事实。不美化、不预测。 */
function summariseGeneration(r: GenerateResult): string[] {
  const steps: string[] = []
  steps.push(`提案引擎跑了 ${r.gridTop.length} 条网格候选的评估`)
  steps.push(r.llmUsed ? '模型来源：可用的大模型' : `模型来源：确定性引擎（${r.source}）`)
  steps.push(`本轮收到 ${r.verdicts.length} 条提案裁决`)
  if (r.promotedStrategyIds.length > 0) {
    steps.push(`晋级流水线新增 ${r.promotedStrategyIds.length} 条候选：${r.promotedStrategyIds.slice(0, 3).join('、')}`)
  } else {
    steps.push('本轮没有提案达到晋级门槛，流水线没有新增候选')
  }
  if (r.context.droppedIds.length > 0) {
    steps.push(`上下文预算裁掉了 ${r.context.droppedIds.length} 个块（裁剪是可见的，不是静默的）`)
  }
  return steps
}

const ACT_TOOLS: VoiceTool[] = [
  {
    id: 'dispatch_task',
    label: '派舰队干一件活',
    kind: 'act',
    cost: 'slow',
    reuses:
      'server/fleet/service.ts 的 runTask()（与 POST /fleet/task、面板上的「跑这个任务」同一个调度器、同一条成员链）',
    intent: 'dispatch_task',
    run: async (arg?: string) => {
      const goal = (arg ?? '').trim()
      if (goal.length === 0) {
        return { ok: false, reason: 'EMPTY_GOAL', speech: '你要我干什么？比如说「扩候选基因空间」或者「文件体检」。', steps: [] }
      }
      // ★ 先把原话交给舰队调度器判"能不能接"，再决定跑不跑 ——
      //   顺序反过来的话，用户会看到系统先动起来、半秒后才被告知听不懂。
      //   确认已经在语音层收过了（`dispatch_task` 在 DANGEROUS 名单里），
      //   所以这里传 confirmed: true。
      const r = await runTask(goal, { confirmed: true })
      const steps = r.steps.map((s) => `${s.label}${s.independent ? '（独立核对）' : ''}：${s.ok ? '成了' : '没成'} —— ${s.summary}`)
      if (r.refusal) {
        return {
          ok: false,
          reason: r.refusal,
          speech: `这个我没接：${r.why}`,
          steps: ['舰队调度器判定这条计划不成立'],
          detail: r,
        }
      }
      return {
        ok: r.ok,
        speech: renderTaskBrief(r),
        steps,
        reason: r.ok ? undefined : `FAILED_AT:${r.failedAt ?? 'unknown'}`,
        detail: { taskId: r.taskId, plan: r.why, steps: r.steps.map((s) => ({ agentId: s.agentId, ok: s.ok })) },
      }
    },
  },
  {
    id: 'propose_upgrade',
    label: '跑一轮因子提案',
    kind: 'act',
    cost: 'slow',
    reuses: 'proposalEngine.generateProposals()（与 POST /proposals/generate 同一个入口、同一批 K 线）',
    intent: 'self_upgrade',
    run: async () => {
      try {
        const r = await generateProposals(getOrchState(), {})
        const steps = summariseGeneration(r)
        const speech =
          r.promotedStrategyIds.length > 0
            ? `跑完了，晋级流水线新增 ${r.promotedStrategyIds.length} 条候选，分别是 ${r.promotedStrategyIds.join('、')}。` +
              '它们现在都在「候选」阶段，要往实盘走得过过拟合门、纸交易观察和测试网实测。'
            : `跑完了，本轮没有提案达到晋级门槛，所以流水线没有新增候选。` +
              '这不是失败 —— 门槛就是为了拦住不够好的提案，具体理由我记进账本了。'
        return { ok: true, speech, steps, detail: { promoted: r.promotedStrategyIds, llmUsed: r.llmUsed, source: r.source } }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          ok: false,
          reason: `提案引擎报错：${msg.slice(0, 160)}`,
          speech: `提案引擎跑到一半报错了：${msg.slice(0, 120)}。我没有重试 —— 重试之前得先知道为什么错。`,
          steps: ['调用提案引擎', '收到异常'],
        }
      }
    },
  },
  {
    id: 'file_lesson',
    label: '登记一条心法',
    kind: 'act',
    cost: 'instant',
    reuses: 'evolutionShield.proposeLesson()（与 POST /evolution/lessons 同一个入口；证据由服务端从审计账本现算）',
    intent: 'record_lesson',
    run: (arg?: string) => {
      const text = (arg ?? '').trim()
      if (text.length < 4) {
        return { ok: false, reason: 'LESSON_TEXT_TOO_SHORT', speech: '这条太短了，我没听清要记什么。请说「记住：不要在流动性差的时候加仓」这样。', steps: [] }
      }
      const { category, label } = inferLessonCategory(text)
      if (!category) {
        return {
          ok: false,
          reason: 'LESSON_CATEGORY_UNKNOWN',
          speech:
            `「${text}」我没听出属于哪一类，所以我不猜。合法类别有六种：` +
            '趋势跟随、风控、胜率锁定、组合分散、执行质量、市况适应。' +
            '你可以在话里带上这类词，比如提到止损回撤我就归风控，提到滑点成本我就归执行质量。',
          steps: [],
        }
      }
      // ★ 证据绝不由调用方给：从审计账本现算（F-44 的教训 —— 自报样本量能让门槛恒为真）。
      const evidence = lessonEvidenceFromEvents(getEvents())
      const out = proposeLesson({ ruleText: text, category, evidence, source: 'voice' })
      if (!out.accepted) {
        return {
          ok: false,
          reason: out.reason,
          speech: `这条没能进心法库，理由是：${out.reason}`,
          steps: ['用审计账本现算证据', '宪法 lint 未通过'],
        }
      }
      return {
        ok: true,
        speech:
          `记住了，归在「${label}」类，证据是账本里的 ${evidence.tradeObservations} 笔成交。` +
          '它现在已经生效 —— 下次提案引擎干活时会把它装进上下文，也就是模型会看见这条教训。' +
          '它会随时间衰减，如果一直没再被验证会自动失效，到时候我会说。',
        steps: [`用审计账本现算证据：${evidence.tradeObservations} 笔成交`, `宪法 lint 通过，归入「${label}」类`, '写入心法库并生效'],
        detail: { lessonId: out.lesson?.id ?? null, category },
      }
    },
  },
]

export const VOICE_TOOLS: readonly VoiceTool[] = [...READ_TOOLS, ...ACT_TOOLS]

export function getTool(id: string): VoiceTool | null {
  return VOICE_TOOLS.find((t) => t.id === id) ?? null
}

export interface RegistryProblem {
  toolId: string
  problem: string
}

/**
 * 注册表自检。返回空数组才算健康 —— 由 `test:voice` S14 断言 0 问题。
 *
 * ★ 参数可注入（默认查真实注册表），理由与本仓库其它门一致：
 *   一道"只能报绿"的检查等于没有检查。测试要能喂一个**坏工具**进来，
 *   证明这四条真的会报红 —— 否则将来有人把 `reuses` 检查删掉，
 *   门禁照样全绿，而那正是"语音专用实现"重新长出来的那天。
 *
 * 检查的四条对应四类真实失误：
 *   ① id 重复 —— 后注册的会静默覆盖前一个，调用方拿到的东西不是它以为的那个；
 *   ② 没有 `reuses` —— 那就是一个"语音专用实现"，红线；
 *   ③ act 却没有 intent，或 intent 不在 DANGEROUS 里 —— 动作绕过了两段式确认；
 *   ④ 没有 label —— 面板上会渲染成空白，用户看不到自己有什么能力。
 */
export function auditToolRegistry(tools: readonly VoiceTool[] = VOICE_TOOLS): RegistryProblem[] {
  const problems: RegistryProblem[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    if (seen.has(t.id)) problems.push({ toolId: t.id, problem: 'id 重复' })
    seen.add(t.id)
    if (!t.label.trim()) problems.push({ toolId: t.id, problem: '缺 label，面板上会显示空白' })
    if (!t.reuses.trim()) {
      problems.push({ toolId: t.id, problem: '未声明 reuses —— 这就是一个"语音专用实现"，违反语音层红线' })
    }
    if (t.kind === 'act') {
      if (!t.intent) problems.push({ toolId: t.id, problem: 'act 工具未声明 intent，无法验证它是否走两段式确认' })
      else if (!isDangerous(t.intent)) {
        problems.push({ toolId: t.id, problem: `act 工具的意图 ${t.intent} 不在 DANGEROUS 名单里 —— 动作会绕过确认` })
      }
    }
  }
  if (!LESSON_CATEGORIES.every((c) => typeof c === 'string' && c.length > 0)) {
    problems.push({ toolId: '*', problem: '心法类别清单里出现空值' })
  }
  return problems
}

/** 供面板/自述使用的能力清单（只读工具 + 动作工具分开列，用户才知道哪些会改系统）。 */
export function describeTools(): { reads: string[]; acts: string[] } {
  return {
    reads: READ_TOOLS.map((t) => t.label),
    acts: ACT_TOOLS.map((t) => t.label),
  }
}
