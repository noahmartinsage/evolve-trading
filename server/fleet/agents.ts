/**
 * Agent 舰队的七名成员
 *
 * ── 每个成员都是一条**已存在的真实路径**的包装，不是新实现 ─────────────
 * 这条是硬约束（`auditFleetRegistry` 会核对它指出的文件真的存在）：
 * 舰队存在的意义是把系统里已有的能力**组织**起来去完成任务，
 * 不是在旁边再长一套。凡是"舰队专用实现"都会立刻制造两条实现路径，
 * 而两条路径就意味着其中一条不会被风控/门槛经过 —— 本仓库为这件事付过代价。
 *
 * ── 为什么每个 run 都要在文案里写出**真实数字** ────────────────────────
 * 之前这一页是写死的演示数字，正因为写死的数字看起来也很像真的。
 * 所以每个成员的产出必须来自本次真实调用：跑了几根 K 线、几百条候选、
 * 几折、多少条被哪道闸门拦下。说不出数字的成员，等于没干活。
 *
 * ── 慢成员为什么单独标 `cost: 'slow'` ────────────────────────────────
 * `factor_produce` / `factor_screen` 要在几万根 K 线上做全量评估，实测分钟级。
 * 把一个分钟级的动作塞进一次语音回合是设计错误（用户会以为它卡住了），
 * 所以调度器按 cost 决定要不要同步跑 —— 这个档位是给调度用的，不是装饰。
 */
import { getOrchState } from '../core.ts'
import { autopilotStatus, candidatePool, startAutopilot, stopAutopilot } from '../autopilot.ts'
import { generateProposals } from '../proposalEngine.ts'
import { produceFactors } from '../factorService.ts'
import { screenAcceptedFactors } from '../factorStrategyService.ts'
import { pipelineService } from '../pipelineService.ts'
import { decayForecast, lessonStats, loadLessons } from '../evolutionShield.ts'
import { auditSnapshotObservability, renderObservabilityBrief } from '../decisionObservability.ts'
import { getEvents } from '../ledger.ts'
import { PROMOTION_STAGE_LABEL, type Stage } from '../../src/engine/promotion.ts'
import { scanHygiene, renderHygieneBrief, formatBytes } from './hygiene.ts'
import { runClean, listTrash, renderCleanBrief } from './cleaner.ts'
import { mineFactors, WINDOW_SETS } from './factorMine.ts'
import { runSelfLearn, renderLearnBrief } from './learner.ts'
import { runNewsWatch, renderNewsBrief, KEEP_THRESHOLD } from './news.ts'
import { startAutonomy, stopAutonomy, autonomyStatus, AUTONOMY_JOBS } from './autonomy.ts'
import type { FleetAgent, FleetRawResult, FleetRunArg, FleetMessage } from './types.ts'

/** `arg` 里取一个正整数（用于"只跑 N 个"这类限流），取不到就用默认值。 */
function intArg(arg: string | undefined, fallback: number, max: number): number {
  const n = Number((arg ?? '').trim())
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

/** dryRun 必须**写在产出里** —— 否则一次"只算不落盘"的试跑会被当成真跑过。 */
function dryTag(dry: boolean): string {
  return dry ? '（试跑：只算不落盘）' : ''
}

function countStages(rows: { stage: Stage }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.stage] = (out[r.stage] ?? 0) + 1
  return out
}

// ─────────────────────────── 七名成员 ───────────────────────────

export const FLEET_AGENTS: readonly FleetAgent[] = [
  {
    id: 'proposal',
    label: '提案专员',
    duty: '在真实 K 线上跑一轮提案，把够格的候选送进晋级流水线',
    kind: 'act',
    cost: 'fast',
    reuses: 'server/proposalEngine.ts 的 generateProposals()（与 POST /proposals/generate 同一入口、同一批 K 线）',
    output: '本轮提案裁决与晋级流水线新增候选的 id',
    consumers: ['ui:fleet', 'voice:fleet', 'agent:gate'],
    emits: ['proposal.generated'],
    intent: 'self_upgrade',
    run: async (_arg: FleetRunArg): Promise<FleetRawResult> => {
      const r = await generateProposals(getOrchState(), {})
      const steps = [
        `提案引擎在真实 K 线上评估了 ${r.gridTop.length} 条网格候选`,
        r.llmUsed ? '模型来源：可用的大模型' : `模型来源：确定性引擎（${r.source}）`,
        `本轮收到 ${r.verdicts.length} 条提案裁决`,
        r.promotedStrategyIds.length > 0
          ? `晋级流水线新增 ${r.promotedStrategyIds.length} 条候选`
          : '本轮没有提案达到晋级门槛，流水线没有新增候选',
      ]
      if (r.context.droppedIds.length > 0) {
        steps.push(`上下文预算裁掉了 ${r.context.droppedIds.length} 个块（裁剪是可见的，不是静默的）`)
      }
      return {
        ok: true,
        summary:
          `提案跑完了：${r.verdicts.length} 条裁决，` +
          (r.promotedStrategyIds.length > 0
            ? `晋级流水线新增 ${r.promotedStrategyIds.length} 条候选。`
            : '没有新增候选 —— 门槛把这一轮全拦下了，理由记在账本里。'),
        steps,
        outputs: {
          'proposal.generated': {
            verdicts: r.verdicts.length,
            promoted: r.promotedStrategyIds.length,
            promotedIds: r.promotedStrategyIds.slice(0, 5),
            gridTop: r.gridTop.length,
            llmUsed: r.llmUsed,
            source: r.source,
          },
        },
        detail: { promoted: r.promotedStrategyIds, llmUsed: r.llmUsed, source: r.source },
      }
    },
  },

  {
    id: 'factor_produce',
    label: '因子生产官',
    duty: '扩候选基因空间：在一批新因子上做门禁评估，写进因子台账',
    kind: 'act',
    cost: 'slow',
    reuses: 'server/factorService.ts 的 produceFactors()（与 POST /factors/generate / npm run factors:run 同一入口）',
    output: '因子台账新增 / 重判的条数与三态分布',
    consumers: ['ui:factors', 'agent:factor_screen'],
    emits: ['factor.produced'],
    intent: 'self_upgrade',
    run: (arg: FleetRunArg): FleetRawResult => {
      const count = intArg(arg.arg, 3, 200)
      const dry = arg.dryRun ?? false
      // ★ 试跑时**关掉"重判过时行"**：那一步会把台账里所有指纹不符的行重判一遍，
      //   在生产上是对的（过时判决不能成为终态），但一条探针不该触发一次全量重判。
      //   这个差异必须在文案里说出来，不能让试跑与真跑看起来一样。
      const r = produceFactors({ count, dryRun: dry, refreshStale: dry ? false : true })
      const byGate = Object.entries(r.byGate)
        .sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `${g} ${n}`)
        .join('、')
      // ★ 「0 个候选」有两种事因，下一步动作完全相反，必须分开说：
      //   ① 这一批候选都已被挖过（空间耗尽）⇒ 该加窗口维度 / 换标的池；
      //   ② 生成器出问题了 ⇒ 该查代码。
      //   旧文案只报 "跑了 0 个候选：接受 0、拒绝 0"，读起来像"挖了没挖到"，
      //   而实测 490 格跑满之后它就恒为这个数 —— 一个会让人持续投错方向的输出。
      const idle = r.specs === 0
      const spaceLine = `候选空间余量：${r.space.remaining}/${r.space.total} 格未挖（窗口组 ${r.space.windows.join('/')}）`
      return {
        ok: true,
        summary: idle
          ? `本次没有可评估的候选${dryTag(dry)}：当前窗口组下的候选空间已经用完` +
            `（${r.space.used}/${r.space.total} 格都在台账里）。这不是"挖了没挖到"，是"没得挖了" —— ` +
            `要扩空间得加窗口维度，或者换一批标的（同一批公开行情上的因子族都落在同一个 IC 量级）。`
          : `因子生产跑了 ${r.specs} 个候选${dryTag(dry)}：接受 ${r.accepted}、拒绝 ${r.rejected}、` +
            `证据不足 ${r.unverifiable}。数据来源 ${r.origin}，${r.bars} 根 K 线。` +
            (byGate ? `拦得最多的是 ${byGate}。` : ''),
        steps: [
          `取数：${r.origin}（${r.bars} 根）`,
          `批量生成 ${r.specs} 个候选并逐条过三态门`,
          `接受 ${r.accepted} / 拒绝 ${r.rejected} / 证据不足 ${r.unverifiable}`,
          spaceLine,
          dry ? '试跑：没有写台账' : `已写台账：${r.indexPath}`,
        ],
        outputs: {
          'factor.produced': {
            specs: r.specs,
            accepted: r.accepted,
            rejected: r.rejected,
            unverifiable: r.unverifiable,
            byGate: r.byGate,
            dataHash: r.dataHash,
            bars: r.bars,
            dryRun: dry,
            spaceRemaining: r.space.remaining,
            spaceTotal: r.space.total,
            spaceExhausted: r.space.remaining === 0,
          },
        },
        detail: { indexPath: r.indexPath, written: r.written, refreshed: r.refreshed, space: r.space },
      }
    },
  },

  {
    id: 'factor_screen',
    label: '策略筛官员',
    duty: '把台账里已接受的因子过一遍策略门，看扣掉成本之后还剩不剩钱',
    kind: 'act',
    cost: 'slow',
    reuses: 'server/factorStrategyService.ts 的 screenAcceptedFactors()（与 npm run factors:screen 同一入口）',
    output: '策略台账的三态分布与每道闸门拦下的条数',
    consumers: ['ui:factors', 'agent:gate'],
    emits: ['strategy.screened'],
    consumes: ['factor.produced'],
    intent: 'self_upgrade',
    // ★ 这个 onMessage 是"上游真的把东西交过来了"的落点。它只记一句笔记，
    //   因为筛选的口径**不能由消息决定** —— 门槛住在代码里的唯一出处，
    //   消息里若带得动门槛，那条消息就等于一把能开门的钥匙。
    onMessage: (m: FleetMessage): string =>
      `收到因子生产产出：本轮 ${String(m.payload.specs ?? '?')} 个候选，接受 ${String(m.payload.accepted ?? '?')} 个。` +
      '筛选按台账现算，不采信消息里的数字。',
    run: (arg: FleetRunArg): FleetRawResult => {
      const limit = intArg(arg.arg, 2, 200)
      const dry = arg.dryRun ?? false
      const r = screenAcceptedFactors({ limit, dryRun: dry })
      const byGate = Object.entries(r.byGate)
        .sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `${g} ${n}`)
        .join('、')
      return {
        ok: true,
        summary:
          `策略筛查跑了 ${r.candidates} 条已接受因子里的前 ${limit} 条${dryTag(dry)}：` +
          `过门 ${r.accepted}、被拒 ${r.rejected}、证据不足 ${r.unverifiable}` +
          (r.stale > 0 ? `，另有 ${r.stale} 条行情指纹不符直接判过时` : '') +
          '。' +
          (byGate ? `拦得最多的是 ${byGate}。` : ''),
        steps: [
          `读因子台账：accepted ${r.candidates} 条，本次取前 ${limit} 条`,
          `逐条在 ${r.bars} 根 K 线上做逐折策略回测`,
          `过门 ${r.accepted} / 被拒 ${r.rejected} / 证据不足 ${r.unverifiable}`,
          dry ? '试跑：没有写策略台账' : `已写策略台账：${r.strategyIndexPath}`,
        ],
        outputs: {
          'strategy.screened': {
            candidates: r.candidates,
            screened: limit,
            accepted: r.accepted,
            rejected: r.rejected,
            unverifiable: r.unverifiable,
            stale: r.stale,
            byGate: r.byGate,
            dataHash: r.dataHash,
            dryRun: dry,
          },
        },
        detail: { strategyIndexPath: r.strategyIndexPath, written: r.written },
      }
    },
  },

  {
    id: 'gate',
    label: '过拟合守门人',
    duty: '核对过拟合门与晋级阶段的现状，回答"候选卡在哪一道"',
    kind: 'read',
    cost: 'instant',
    reuses: 'server/autopilot.ts 的 autopilotStatus() 与 candidatePool()（与 GET /autopilot 同源）',
    output: '过拟合门的最近一次否决理由 + 候选池规模 + 各晋级阶段的分布',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['gate.checked'],
    consumes: ['proposal.generated', 'strategy.screened'],
    onMessage: (m: FleetMessage): string =>
      `收到上游产出（${m.topic}，来自 ${m.from}）：把它计入本次核对的范围。`,
    run: (arg: FleetRunArg): FleetRawResult => {
      const ap = autopilotStatus()
      const rows = pipelineService.list()
      const stages = countStages(rows)
      const pool = candidatePool()
      const stageText =
        Object.keys(stages).length > 0
          ? Object.entries(stages)
              .sort((a, b) => b[1] - a[1])
              .map(([s, n]) => `${PROMOTION_STAGE_LABEL[s as Stage] ?? s} ${n}`)
              .join('、')
          : ''
      const refusal = ap.gateRefusal
      const steps = [
        `读候选池：手写策略 ${pool.handWritten.length} 条、因子策略 ${pool.factor.length} 条`,
        `读晋级流水线 ${rows.length} 条候选` + (stageText ? `（${stageText}）` : ''),
        refusal
          ? `过拟合门最近否决过一次：${refusal.outcome}（PBO ${refusal.pbo ?? 'n/a'}，需 ${refusal.bars} 根 K 线，下次重判在 ${refusal.retryAtBars} 根）`
          : '过拟合门没有留下否决记录',
      ]
      return {
        ok: true,
        summary:
          `守门人核对完了：候选池共 ${pool.all.length} 条（手写 ${pool.handWritten.length} + 因子 ${pool.factor.length}）；` +
          `晋级流水线 ${rows.length} 条` +
          (stageText ? `，阶段分布 ${stageText}` : '，还没有候选') +
          '。' +
          (refusal
            ? `过拟合门最近一次是「${refusal.outcome}」，理由是：${refusal.summary}`
            : '过拟合门最近没有否决记录 —— 这不是"通过了"，是"最近没被触发过"。'),
        steps,
        outputs: {
          'gate.checked': {
            poolAll: pool.all.length,
            poolHandWritten: pool.handWritten.length,
            poolFactor: pool.factor.length,
            factorSkipped: pool.factorSkipped.length,
            pipelineRows: rows.length,
            stages,
            gateRefusalOutcome: refusal?.outcome ?? null,
            gateRefusalPbo: refusal?.pbo ?? null,
            autopilotStage: ap.stage,
            autopilotRunning: ap.running,
            inputFrom: arg.inputFrom ?? [],
          },
        },
        detail: { refusal, stages },
      }
    },
  },

  {
    id: 'brain',
    label: '决策大脑观察员',
    duty: '数一遍已结束决策的样本质量，回答"从这批样本里能不能提炼心法"',
    kind: 'read',
    cost: 'instant',
    reuses: 'server/decisionObservability.ts 的 auditSnapshotObservability()（与 GET /decisions/observability 同一批记录、同一判据）',
    output: '决策样本的可观测性分档计数与覆盖率',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['brain.observed'],
    // ★ 必须收 `arg`：下面的产出里要写 `inputFrom`（"这次核对吃的是哪条上游消息"）。
    //   类型检查在这里救过一次 —— 漏了参数会让那行变成 `Cannot find name 'arg'`，
    //   而如果当初写的是 `arg?.inputFrom`，它就会**静默**变成 undefined 且不报错。
    run: (arg: FleetRunArg): FleetRawResult => {
      const records = getEvents(0)
        .filter((e) => e.kind === 'AUTOPILOT_POSITION_OPENED')
        .map((e) => e.payload as Record<string, unknown>)
      const audit = auditSnapshotObservability(records)
      return {
        ok: true,
        summary:
          audit.total === 0
            ? '决策大脑还没有已结束的决策样本，所以这一项现在没有数 —— 不是"质量差"，是"还没有"。'
            : `${renderObservabilityBrief(audit)}。占比越高，从这批样本里提炼心法才越站得住。`,
        steps: [
          `按 AUTOPILOT_POSITION_OPENED 取到 ${audit.total} 条已结束决策`,
          '逐条分档：完整动力观测 / 部分 / 仅价格 / 无',
        ],
        outputs: {
          'brain.observed': {
            total: audit.total,
            dynamicsObserved: audit.DYNAMICS_OBSERVED,
            partial: audit.PARTIAL,
            priceOnly: audit.PRICE_ONLY,
            none: audit.NONE,
            mathObservable: audit.mathObservable,
            mathObservableRatio: audit.mathObservableRatio,
            inputFrom: arg.inputFrom ?? [],
          },
        },
        detail: audit,
      }
    },
  },

  {
    id: 'lesson',
    label: '心法健康观察员',
    duty: '读心法库现状并报出哪些心法正在接近失效线',
    kind: 'read',
    cost: 'instant',
    reuses: 'server/evolutionShield.ts 的 lessonStats() 与 decayForecast()（与 GET /evolution/lessons 同一读取路径）',
    output: '心法条数、健康分分布与接近失效阈值的条目',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['lesson.audited'],
    run: (): FleetRawResult => {
      const all = loadLessons()
      const st = lessonStats()
      const forecast = decayForecast()
      const atRisk = [...all]
        .filter((l) => l.enabled)
        .sort((a, b) => a.healthScore - b.healthScore)
        .slice(0, 3)
        .filter((l) => l.healthScore < 60)
      const steps = [
        `读心法库 ${all.length} 条，生效 ${all.filter((l) => l.enabled).length} 条`,
        `平均健康分 ${st.avgHealth.toFixed(1)}`,
        forecast.wouldArchive.length > 0
          ? `按当前时间推算，下一轮衰减会归档 ${forecast.wouldArchive.length} 条`
          : '按当前时间推算，下一轮衰减不会归档任何心法',
      ]
      return {
        ok: true,
        summary:
          all.length === 0
            ? '心法库是空的 —— 空库不是"很健康"，是"还没有经验被记下来"。'
            : `心法库 ${all.length} 条（生效 ${all.filter((l) => l.enabled).length} 条），平均健康分 ${st.avgHealth.toFixed(1)}。` +
              (atRisk.length > 0
                ? `健康分最低的三条是：${atRisk.map((l) => `${l.ruleText}（${l.healthScore.toFixed(1)} 分，${l.sampleSize} 笔证据）`).join('；')}。`
                : '没有低于 60 分的心法。') +
              (forecast.wouldArchive.length > 0
                ? `按当前时间推算，下一轮衰减会归档 ${forecast.wouldArchive.length} 条。`
                : ''),
        steps,
        outputs: {
          'lesson.audited': {
            total: all.length,
            active: all.filter((l) => l.enabled).length,
            avgHealth: st.avgHealth,
            wouldArchive: forecast.wouldArchive.length,
            atRisk: atRisk.map((l) => ({ id: l.id, health: l.healthScore, samples: l.sampleSize })),
          },
        },
        detail: { stats: st, forecastCount: forecast.wouldArchive.length },
      }
    },
  },

  {
    id: 'hygiene',
    label: '文件体检员',
    duty: '扫一遍工作区，产出可回收清单与理由（只报告，不删除）',
    kind: 'read',
    cost: 'fast',
    reuses: 'server/fleet/hygiene.ts 的 scanHygiene()（只读扫描的唯一实现，没有任何删除调用）',
    output: '分组后的可回收清单、各组体积与需要人看一眼的条目',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['hygiene.scanned'],
    run: (): FleetRawResult => {
      const report = scanHygiene(process.cwd(), { maxEntries: 120 })
      const top = report.groups.slice(0, 4)
      return {
        ok: true,
        summary: renderHygieneBrief(report),
        steps: [
          `扫描根 ${report.root}`,
          `扫到 ${report.totalFiles} 个文件，合计 ${formatBytes(report.totalBytes)}`,
          `按组归类：${top.map((g) => `${g.label} ${g.files} 个 / ${formatBytes(g.bytes)}`).join('；')}`,
          `跳过：${report.skippedDirs.join('、')}`,
          report.note,
        ],
        outputs: {
          'hygiene.scanned': {
            totalFiles: report.totalFiles,
            totalBytes: report.totalBytes,
            reclaimableBytes: report.reclaimableBytes,
            keepBytes: report.keepBytes,
            groups: report.groups.map((g) => ({ id: g.id, files: g.files, bytes: g.bytes, verdict: g.verdict })),
            scannedAt: report.scannedAt,
            // 只报告不删除 —— 把这条写进产出，下游就不能假装它是"已清理"。
            deleted: 0,
          },
        },
        detail: report,
      }
    },
  },

  // ══════════════ 第十七轮新增：让"主动干活"这件事真的成立 ══════════════
  //
  // 这五个成员治的是用户实测反馈的三句话：
  //   · 「连一键启动自治循环都启动不了」  ⇒ autonomy_start / autonomy_stop
  //   · 「扩候选基因空间…直到挖掘出很多个能稳定盈利的因子」⇒ factor_mine（**迭代**，不是跑一次）
  //   · 「没用的垃圾及时清理」            ⇒ hygiene_clean（可逆清理）
  //   · 「定时给自己学习」                ⇒ learner
  //
  // ★ 一条贯穿五个成员的设计：**动作可不可逆，决定它能不能自动跑**。
  //   `hygiene_clean` 只把文件移进 .trash/（能拿回来）⇒ 允许进自治循环；
  //   `learner` 只落一份提案单、**不改源码**⇒ 允许；
  //   `autonomy_*` 是唯一的"授权类"动作，它本身就要求人确认。
  //   真删、下单、改码这三件不可逆的事，一个都没有进循环。

  {
    id: 'factor_mine',
    label: '因子挖掘调度员',
    duty: '迭代挖掘：扩一批候选 → 过策略门 → 不够就换窗口组再来一轮，直到达标或空间用尽',
    kind: 'act',
    cost: 'slow',
    reuses:
      'server/fleet/factorMine.ts 的 mineFactors()（内部调 server/factorService.ts 的 produceFactors() 与 ' +
      'server/factorStrategyService.ts 的 screenAcceptedFactors()，与 npm run factors:run / factors:screen 同一入口）',
    output: '每轮扩/筛/过门的条数、换了几组窗口、以及退出原因（达标 / 所有窗口组挖尽 / 轮次用尽）',
    consumers: ['ui:factors', 'voice:fleet'],
    emits: ['factor.mined'],
    intent: 'self_upgrade',
    run: (arg: FleetRunArg): FleetRawResult => {
      const dry = arg.dryRun === true
      const maxRounds = intArg(arg.arg, 3, 10)
      const r = mineFactors(
        {
          now: () => Date.now(),
          produce: (o) => {
            // ★ 迭代里**关掉"重判过时行"**：那一步会把台账里所有指纹不符的行重判一遍。
            //   它对单次生产是对的（过时判决不能成为终态），但放进循环就等于
            //   每一轮都把时间花在同一批旧行上，而循环的目的是**找新因子**。
            //   要重判请单独跑 `factor_produce` —— 两者的差异写在文案里，不静默。
            const pr = produceFactors({ count: o.count, windows: o.windows, dryRun: o.dryRun, refreshStale: false })
            return {
              specs: pr.specs,
              accepted: pr.accepted,
              rejected: pr.rejected,
              unverifiable: pr.unverifiable,
              spaceRemaining: pr.space.remaining,
              spaceTotal: pr.space.total,
              // ★ 本轮**真的新扩出来**的 slug —— 下一轮只筛这一批。
              //   不传它的话，筛选器会按 slug 排序取前 N，于是每轮筛的都是同一批，
              //   输出逐字相同（实测抓到的假进展）。
              slugs: pr.rows.map((r) => r.slug),
              dryRun: o.dryRun,
            }
          },
          screen: (o) => {
            const sr = screenAcceptedFactors({ slugs: o.slugs, limit: o.limit, dryRun: o.dryRun })
            return {
              screened: sr.candidates,
              accepted: sr.accepted,
              rejected: sr.rejected,
              unverifiable: sr.unverifiable,
              acceptedSlugs: sr.rows.filter((x) => x.state === 'accepted').map((x) => x.slug),
              rejectedReasons: sr.rows
                .filter((x) => x.state !== 'accepted')
                .map((x) => ({ slug: x.slug, reason: x.reason })),
              stale: sr.stale,
              dryRun: o.dryRun,
            }
          },
        },
        { maxRounds, countPerRound: 8, screenLimit: 8, dryRun: dry },
      )
      return {
        ok: true,
        summary: r.verdict,
        steps: [
          `登记 ${WINDOW_SETS.length} 组窗口（= ${WINDOW_SETS.length} 个因子族），本轮最多跑 ${maxRounds} 轮`,
          ...r.rounds.map((x) => `第 ${x.round} 轮（${x.windowSetLabel}）：${x.note}`),
          `累计扩候选 ${r.totalProduced} 个，过策略门 ${r.profitable.length} 个`,
          dry ? '试跑：没有写因子/策略台账' : '已写因子台账与策略台账',
        ],
        outputs: {
          'factor.mined': {
            rounds: r.rounds.length,
            windowSetsTried: new Set(r.rounds.map((x) => x.windowSetId)).size,
            totalProduced: r.totalProduced,
            totalFactorAccepted: r.totalFactorAccepted,
            profitable: r.profitable.length,
            profitableSlugs: r.profitable.slice(0, 5),
            stopReason: r.stopReason,
            durationMs: r.durationMs,
            dryRun: dry,
          },
        },
        detail: r,
      }
    },
  },

  {
    id: 'hygiene_clean',
    label: '临时产物清理员',
    duty: '把项目根的临时取证产物**移进** .trash/（可逆），并报出已经过期的那部分交人确认',
    kind: 'act',
    cost: 'fast',
    reuses: 'server/fleet/cleaner.ts 的 runClean() 与 listTrash()（本模块没有任何 unlink 调用，只有 rename）',
    output: '移动了几个文件、移动了多少字节、失败几条、.trash 批次路径与已过期批次数',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['hygiene.cleaned'],
    consumes: ['hygiene.scanned'],
    intent: 'dispatch_task',
    // ★ 这个 onMessage 要把"我不采信消息里的清单"说出来。理由是安全边界：
    //   体检结论是**上一次扫描的快照**，而清理要动的是**此刻的磁盘**。
    //   两者之间可能已经过去了很久（自治循环里差一个周期），
    //   按快照删等于拿一张过期的清单去动文件。
    onMessage: (m: FleetMessage): string =>
      `收到体检结论（${m.from}，扫到 ${String(m.payload.totalFiles ?? '?')} 个文件、可回收 ${String(m.payload.reclaimableBytes ?? '?')} 字节）。` +
      '但清理按**当前磁盘**现算一份计划，不采信这条消息里的清单 —— 快照可能已经过期。',
    run: (arg: FleetRunArg): FleetRawResult => {
      // ★ `confirmed` 由 `runAgent` 在调用前就把关（act 且未确认 ⇒ 当场拒、连 run 都不进）。
      //   所以这里只认 `dryRun`：`dryRun === true` 才试跑。
      const dry = arg.dryRun === true
      const r = runClean(process.cwd(), { dryRun: dry, limit: 12 })
      const trash = listTrash(process.cwd())
      return {
        ok: r.moved.length > 0 || r.candidates.length === 0 || dry,
        summary: renderCleanBrief(r),
        steps: [
          ...r.candidates.slice(0, 6).map((c) => `候选：${c.path}（${formatBytes(c.bytes)}，${c.reason}）`),
          r.candidates.length > 6 ? `另有 ${r.candidates.length - 6} 个候选未逐条列出` : '',
          ...r.skipped.slice(0, 4).map((s) => `挡下：${s.path} —— ${s.why}`),
          `现在 .trash 里共 ${trash.totalFiles} 个文件 / ${formatBytes(trash.totalBytes)}，其中已过保留期的批次 ${trash.expiredBatches} 个`,
          trash.note,
        ].filter((s) => s.length > 0),
        outputs: {
          'hygiene.cleaned': {
            dryRun: dry,
            planned: r.candidates.length,
            moved: r.moved.length,
            failed: r.failed.length,
            movedBytes: r.movedBytes,
            skipped: r.skipped.length,
            batch: r.batchDir,
            trashFiles: trash.totalFiles,
            trashBytes: trash.totalBytes,
            trashExpiredBatches: trash.expiredBatches,
            // ★ 写死这条：本成员的产物里**没有**"删除了 N 个"这个量。
            //   有它的话，下游（面板/语音/文档）就能引用一个不存在的动作。
            deleted: 0,
          },
        },
        detail: { moved: r.moved, failed: r.failed, skipped: r.skipped, trash },
      }
    },
  },

  {
    id: 'learner',
    label: '自我学习员',
    duty: '读账本与各台账的真实数字，交给模型产改进提案并落盘（**不改源码**）',
    kind: 'act',
    cost: 'fast',
    reuses:
      'server/fleet/learner.ts 的 runSelfLearn()（读 server/ledger.ts 与各台账，调 server/modelRouter.ts 的 routeChat）',
    output: '观察条数、提案条数、模型是否参与（三态）、落盘路径',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['learn.noted'],
    intent: 'self_upgrade',
    run: async (arg: FleetRunArg): Promise<FleetRawResult> => {
      // ★ 默认 `dryRun: true`：这一步会**调模型**（消耗额度、可能几十秒）。
      //   一个会花钱的动作，默认值必须是"什么都不做"那一边 ——
      //   与语音层"默认 paper 不默认 live"是同一条纪律。
      const dry = arg.dryRun !== false
      const r = await runSelfLearn({ dryRun: dry, cwd: process.cwd() })
      return {
        ok: r.note.proposals.length > 0 || r.note.source === 'rules',
        summary: renderLearnBrief(r),
        steps: [
          `读了 ${r.note.observations.length} 条现状：`,
          ...r.note.observations.map((o) => `· ${o}`),
          r.note.source === 'model'
            ? `模型（${r.note.model ?? '未署名'}）提出 ${r.note.proposals.length} 条提案`
            : `这一轮没有模型参与：${r.note.degraded ?? '原因未记录'}`,
          ...r.note.proposals.map((p) => `提案：${p.title}（风险 ${p.risk}）→ ${p.action}`),
          dry ? '试跑：提案单没有落盘' : `已落盘：${r.writtenTo}`,
          '★ 源码没有被改动 —— 改代码是不可逆动作，必须由人来点。',
        ],
        outputs: {
          'learn.noted': {
            source: r.note.source,
            observations: r.note.observations.length,
            proposals: r.note.proposals.length,
            model: r.note.model,
            degraded: r.note.degraded !== null,
            ledgerEvents: r.note.ledgerEvents,
            dryRun: r.dryRun,
            // 让下游能核对"确实没有改码"这件事：这个量恒为 0，
            // 而它一旦不为 0 就说明有人给这条路径加了写码能力。
            sourceFilesTouched: 0,
          },
        },
        detail: r.note,
      }
    },
  },

  {
    id: 'news_watch',
    label: '新闻雷达',
    duty: '定时读新闻源 → 用确定性规则挑出与本系统相关的信号 → 交给模型写内化提案（**不改源码**）',
    kind: 'act',
    cost: 'slow',
    reuses:
      'server/fleet/news.ts 的 runNewsWatch()（抓取走 server/net/egress.ts 的受控出网；' +
      '提案落进 server/fleet/learner.ts 的**同一份** data/learn/notes.jsonl）',
    output: '读了多少条 / 几条相关 / 几条是新的 / 哪几个源失败 / 内化提案条数与落盘路径',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['news.digested', 'news.internalized'],
    intent: 'self_upgrade',
    run: async (arg: FleetRunArg): Promise<FleetRawResult> => {
      // ★ 与 `learner` 同一条纪律：这一步会**真的出网**（并可能调模型）。
      //   会花钱/会出网的动作，默认值必须是"什么都不做"那一边 ⇒ 默认 dryRun。
      const dry = arg.dryRun !== false
      const r = await runNewsWatch({ cwd: process.cwd() }, { dryRun: dry })
      // ★ `ok` 的判据是"**源**通不通"，不是"有没有找到相关的"。
      //   全部源失败 ⇒ 这是故障；源通了但一条都不相关 ⇒ 这是个**有效结论**
      //   （今天确实没有值得内化的东西），不能报失败。
      const anySourceOk = r.sources.some((s) => s.ok)
      return {
        ok: anySourceOk,
        summary: renderNewsBrief(r),
        steps: [
          ...r.sources.map((s) => `${s.ok ? '成' : '败'} ${s.source}：${s.note}`),
          `共 ${r.items.length} 条，过相关性门 ${r.kept.length} 条（门线 ${KEEP_THRESHOLD} 分），其中新的 ${r.fresh.length} 条`,
          ...r.fresh.slice(0, 3).map((it) => `· [${it.score} 分] ${it.title}（命中 ${it.matched.join('/')}）`),
          r.internalize ? r.internalize.speech : '没有新条目 ⇒ 没有触发内化（这是结论，不是失败）',
          dry ? '试跑：没有落盘' : `已落盘：${r.writtenTo ?? '（无）'}`,
          '★ 源码没有被改动 —— 改代码是不可逆动作，必须由人来点。',
        ],
        outputs: {
          'news.digested': {
            fetched: r.items.length,
            kept: r.kept.length,
            fresh: r.fresh.length,
            sourcesOk: r.sources.filter((s) => s.ok).length,
            sourcesTotal: r.sources.length,
            threshold: KEEP_THRESHOLD,
            dryRun: r.dryRun,
          },
          'news.internalized': {
            considered: r.internalize?.considered ?? 0,
            proposals: r.internalize?.proposals.length ?? 0,
            source: r.internalize?.source ?? 'rules',
            degraded: (r.internalize?.degraded ?? null) !== null,
            noteId: r.internalize?.noteId ?? null,
            // 让下游能核对"确实没有改码"：这个量恒为 0，一旦不为 0 就说明有人给它加了写码能力。
            sourceFilesTouched: 0,
          },
        },
        detail: { speech: r.speech, sources: r.sources, top: r.fresh.slice(0, 5) },
      }
    },
  },

  {
    id: 'autonomy_start',
    label: '自治循环启动员',
    duty: '把周期性发起动作的权利交给舰队：按周期跑挖因子 / 体检清理 / 自我学习 / 巡检',
    kind: 'act',
    cost: 'instant',
    reuses: 'server/fleet/autonomy.ts 的 startAutonomy()（任务表 AUTONOMY_JOBS，每次触发走 runTask 同一条路径）',
    output: '排程了几项、每项的下次触发时刻与周期、以及"不可逆任务已被拦下"的事实',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['autonomy.changed'],
    intent: 'dispatch_task',
    run: (): FleetRawResult => {
      const r = startAutonomy({ reason: '用户启动（语音 / 面板 / HTTP）' })
      const st = r.status
      if (!r.ok && r.reason === 'ALREADY_RUNNING') {
        return {
          ok: true,
          summary:
            `自治循环**本来就在跑**（这是第 ${st.startCount} 次被要求启动），所以我没有重复排程 —— ` +
            '重复排一份会让同一个任务存在两条定时链，跑起来会出现同一轮被跑两次。',
          steps: st.jobs.map((j) => `${j.label}：每 ${Math.round(j.everyMs / 3_600_000)} 小时一次，下次 ${j.nextAt ? new Date(j.nextAt).toISOString() : '未排程'}`),
          outputs: { 'autonomy.changed': { action: 'noop', running: true, startCount: st.startCount } },
          detail: st,
        }
      }
      if (!r.ok) {
        return {
          ok: false,
          summary: `没能启动自治循环：${r.reason}`,
          steps: [],
          reason: r.reason,
          outputs: {},
        }
      }
      return {
        ok: true,
        summary:
          `自治循环起来了：${st.jobs.length} 项任务按周期排上（${AUTONOMY_JOBS.map((j) => j.label).join('、')}）。` +
          '★ 循环里**只有可逆动作**：清理是把文件移进 .trash/（能拿回来），学习只落提案单（不改源码）。' +
          '真删、下单、改码都不在里面 —— 那三件要人点。',
        steps: [
          ...st.jobs.map(
            (j) =>
              `排上「${j.label}」：每 ${Math.round(j.everyMs / 3_600_000)} 小时一次，首次 ${j.nextAt ? new Date(j.nextAt).toISOString() : '未排程'}`,
          ),
          `循环里的每一项都声明为可逆；不可逆的任务在启动时就被拦下（原因码 IRREVERSIBLE_JOB）`,
          '每跑完一项，账本里会留下 AUTONOMY_TICK 事件 —— 面板与"学到了什么"都从账本读，不读内存计数器',
        ],
        outputs: {
          'autonomy.changed': {
            action: 'start',
            running: true,
            startCount: st.startCount,
            jobs: st.jobs.map((j) => ({ id: j.id, everyMs: j.everyMs, nextAt: j.nextAt, reversible: j.reversible })),
          },
        },
        detail: st,
      }
    },
  },

  {
    id: 'autonomy_stop',
    label: '自治循环停机员',
    duty: '把还在排程里的下一轮全部撤掉',
    kind: 'act',
    cost: 'instant',
    reuses: 'server/fleet/autonomy.ts 的 stopAutonomy()（清除所有已排程的定时器，幂等）',
    output: '停了几项、停机时刻、以及"本来就停着"的事实',
    consumers: ['ui:fleet', 'voice:fleet'],
    emits: ['autonomy.changed'],
    intent: 'dispatch_task',
    run: (): FleetRawResult => {
      const before = autonomyStatus()
      const st = stopAutonomy('用户停止（语音 / 面板 / HTTP）')
      if (!before.running) {
        return {
          ok: true,
          summary:
            '自治循环**本来就没在跑**，所以没什么可停的。' +
            (before.startCount === 0 ? '它从来没有被启动过 —— 这跟"跑完自己停了"是两件事。' : `它上次是被「${before.stopReason ?? '未知原因'}」停掉的。`),
          steps: [],
          outputs: { 'autonomy.changed': { action: 'noop', running: false, startCount: st.startCount } },
          detail: st,
        }
      }
      return {
        ok: true,
        summary:
          `自治循环停了：${before.jobs.filter((j) => j.nextAt !== null).length} 项已排程的任务全部撤下，` +
          `本轮之前累计跑过 ${before.ticks} 轮。已经跑完的那些留在账本里，不受影响。`,
        steps: [
          `停机时刻 ${new Date().toISOString()}`,
          '已排程的定时器全部清掉（停在半路的一项会跑完当前这一轮再停 —— 它不会被腰斩）',
          '账本里留下 AUTONOMY_STOPPED 事件',
        ],
        outputs: {
          'autonomy.changed': {
            action: 'stop',
            running: false,
            startCount: st.startCount,
            ticksBefore: before.ticks,
            stoppedAt: st.stoppedAt,
          },
        },
        detail: st,
      }
    },
  },

  // ══════════ 第二十轮新增：让"启动自治循环"与总览面板是同一件事 ══════════
  //
  // ★★ 治的是用户实测的那句话：
  //   「让它一键启动自治循环的时候，总览控制台内的『一键启动自治循环』按钮应该被按下」。
  //
  //   实测的现象是：语音说「一键启动自治循环」，它确实"启动了" ——
  //   启动了**舰队的周期排程**；而总览页那颗按钮控制的是**交易自动驾驶**
  //   （`/autopilot/start`，托管在 `autopilot.ts`）。两件不同的东西共用一个名字，
  //   于是用户看到的是"嘴上说成功了，界面上按钮没动"。
  //
  //   修法不是把按钮改成看舰队状态（那只是把表象对齐），
  //   而是**让名字只有一个主人**：「自治循环」= 周期排程 + 交易自动驾驶，
  //   启动就一起启动。于是"界面显示什么"由"系统实际在跑什么"决定，
  //   没有第二个真相来源 —— 这正是判据 29（同一句话只能有一个主人）
  //   在**按钮与语音**这一层上的同一条。
  //
  // ★ 为什么是加成员而不是在语音里直接调 startAutopilot：
  //   加了成员之后，"启动自治循环"这件事**只有一条路径**
  //   （舰队的 autonomy-start 计划链），面板、语音、HTTP 三条入口都走它。
  //   在语音层再调一次 `startAutopilot` 就等于承认"嘴启动"与"面板启动"是两回事。
  {
    id: 'autopilot_start',
    label: '交易自动驾驶启动员',
    duty: '把纸面自动驾驶跑起来：因子挖掘 → 门禁评估 → 执行 → 盈利目标追踪',
    kind: 'act',
    cost: 'instant',
    reuses: 'server/autopilot.ts 的 startAutopilot()（与 POST /autopilot/start、总览页那颗按钮同一个函数）',
    output: '启动是否成功、目标百分比、以及当前阶段；已在跑时如实说"本来就在跑"',
    consumers: ['ui:overview', 'ui:fleet', 'voice:fleet'],
    emits: ['autopilot.changed'],
    intent: 'dispatch_task',
    run: async (arg: FleetRunArg): Promise<FleetRawResult> => {
      const before = autopilotStatus()
      // ★★ 「已经在跑」必须在**调 `startAutopilot` 之前**判掉。
      //
      //   旧写法是先调、再拿 `!r.ok` 分流，而 `startAutopilot` 在已运行时返回
      //   `{ ok: false, reason: 'ALREADY_RUNNING' }` ⇒ 走到失败分支，
      //   用户听到的是「交易自动驾驶没起来：ALREADY_RUNNING」；
      //   而下面那段"本来就在跑"的文案**永远不可达** ——
      //   那是一段构造不出来的逻辑（判据 5：真会发生吗？构造得出来吗？）。
      //   幂等是这件事写在 `duty` 里的对外承诺，所以顺序要跟着承诺走。
      if (before.running) {
        return {
          ok: true,
          summary:
            `交易自动驾驶**本来就在跑**（阶段「${before.stage}」，目标 +${before.targetPct}%），` +
            '所以我没有重复启动它 —— 重复启动会把已经积累的行情缓冲和基线清掉。',
          steps: ['读启动前的状态：已在运行', '不重启（重启会丢基线）'],
          outputs: { 'autopilot.changed': { action: 'already-running', running: true, targetPct: before.targetPct } },
          detail: before,
        }
      }
      const target = intArg(arg.arg, 2, 200)
      const r = await startAutopilot(target)
      const after = autopilotStatus()
      if (!r.ok) {
        // ★ 失败要能被念出来，且**不许含糊成"启动失败"**：
        //   用户下一步动作完全取决于原因（资金帽？killswitch？没行情？）。
        return {
          ok: false,
          summary: `交易自动驾驶没起来：${r.reason ?? '原因没给出来'}。`,
          steps: [`请求的目标 +${target}%`, `启动返回 ${r.reason ?? '无原因'}`],
          outputs: { 'autopilot.changed': { action: 'start-failed', reason: r.reason ?? null, running: after.running } },
          reason: r.reason ?? 'AUTOPILOT_START_FAILED',
        }
      }
      return {
        ok: true,
        summary:
          `交易自动驾驶起来了：阶段「${after.stage}」，标的 ${after.symbol}，目标 +${after.targetPct}%，` +
          `基线权益 ${after.baselineEquity?.toFixed(2) ?? '未给出'}。` +
          '它只跑**纸交易**面 —— 真钱要另过晋升门禁与人工审批。',
        steps: [
          `请求的目标 +${target}%`,
          `启动后的阶段：${after.stage}`,
          '总览控制台的按钮会跟着变成「停止自治循环」（它读的是同一个状态）',
        ],
        outputs: { 'autopilot.changed': { action: 'start', running: true, targetPct: after.targetPct, stage: after.stage } },
        detail: after,
      }
    },
  },

  {
    id: 'autopilot_stop',
    label: '交易自动驾驶停机员',
    duty: '把交易自动驾驶停掉（幂等，本来就没跑就如实说）',
    kind: 'act',
    cost: 'instant',
    reuses: 'server/autopilot.ts 的 stopAutopilot()（与 POST /autopilot/stop、总览页那颗按钮同一个函数）',
    output: '停之前的阶段、停机原因、以及"本来就停着"的事实',
    consumers: ['ui:overview', 'ui:fleet', 'voice:fleet'],
    emits: ['autopilot.changed'],
    intent: 'dispatch_task',
    run: (): FleetRawResult => {
      const before = autopilotStatus()
      if (!before.running) {
        return {
          ok: true,
          summary: '交易自动驾驶**本来就没在跑**，所以没什么可停的。',
          steps: ['读启动前的状态：未运行'],
          outputs: { 'autopilot.changed': { action: 'noop', running: false } },
          detail: before,
        }
      }
      stopAutopilot('用户停止（语音 / 面板 / HTTP）')
      return {
        ok: true,
        summary: `交易自动驾驶停了。停机前它在「${before.stage}」阶段，累计跑到目标 +${before.targetPct}% 的进度是 ${before.pnlPct === null ? '还没算出来' : `${before.pnlPct >= 0 ? '+' : ''}${before.pnlPct.toFixed(2)}%`}。`,
        steps: [`停机前阶段：${before.stage}`, '已开仓位不因停机被自动平掉（平仓是另一件事，要另说）'],
        outputs: { 'autopilot.changed': { action: 'stop', running: false, stageBefore: before.stage } },
        detail: before,
      }
    },
  },
]

export function fleetAgent(id: string): FleetAgent | null {
  return FLEET_AGENTS.find((a) => a.id === id) ?? null
}

/** 供面板/语音用的成员名录。 */
export function fleetRoster(): { id: string; label: string; kind: string; cost: string; duty: string }[] {
  return FLEET_AGENTS.map((a) => ({ id: a.id, label: a.label, kind: a.kind, cost: a.cost, duty: a.duty }))
}
