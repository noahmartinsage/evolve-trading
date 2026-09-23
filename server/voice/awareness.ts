/**
 * 系统实况 —— 语音管家「什么都知道」的唯一读取层
 *
 * ── 这一层解决的是什么问题 ──────────────────────────────────────────
 * 改造前，管家只知道自己那一小块（持仓 / 权益 / 挂单 / 行情 / 风控额度），
 * 不知道系统里还有决策大脑、Agent 舰队、进化实验室，也不知道候选策略走到哪一步了。
 * 用户问「舰队里哪个策略盈利最高」，它连「系统里有没有这个数据」都答不上来 ——
 * 那已经不是回答得好不好的问题，而是它对自己的系统一无所知。
 *
 * ── 为什么每个事实都必须带三态，而不能只返回一个值 ──────────────────
 * 本模块的每一项都带 `source`：
 *   `live`        有真实来源，`evidence` 写明去哪个模块核对；
 *   `demo`        有数据，但那是演示数据（页面上自己标着"非真实"），不能当答案；
 *   `unavailable` 系统里根本没有这个数据，`evidence` 写明缺的是什么、为什么缺。
 *
 * 这不是洁癖。这一层最严重的失败不是「答不出来」，而是**答出一个看起来很对的数**：
 * 用户问「舰队里哪个策略盈利最高」，如果我把 Agent 舰队页上那几个演示数字
 * （+$12,480 / 62% 胜率）念出来，他会真的据此决定投钱 ——
 * 而那几个数字在页面上明确标着「DEMO 演示数字 · 非真实 PnL」。
 * 这属于本仓库反复出现的第三族 P0（前两族是"不可能失败的检查""不可能命中的状态"）：
 * **答案看起来完全正确，只有真相没了。**
 *
 * ⇒ 规矩：**凡是 `source !== 'live'` 的事实，回话里必须说出来**。
 *    `test:voice` S14 直接断言这一点。
 *
 * ── 只读，不写 ──────────────────────────────────────────────────────
 * 本模块**只读不写**：不 appendEvent、不改任何状态、不触发任何模型调用。
 * 需要动作请走 `tools.ts` 的 act 工具（那条路会写账本、要用户确认）。
 * 分开的理由是「回答问题」与「改变系统」必须能被分开审计。
 */
import { getOrchState } from '../core.ts'
import { autopilotStatus } from '../autopilot.ts'
import { currentEquity } from '../risk.ts'
import { pipelineService } from '../pipelineService.ts'
import { lessonStats, loadLessons } from '../evolutionShield.ts'
import { auditSnapshotObservability } from '../decisionObservability.ts'
import { getEvents } from '../ledger.ts'
import { surveillanceSnapshot } from '../surveillance.ts'
import { PROMOTION_STAGE_LABEL, PROMOTION_STAGE_RANK, type Stage } from '../../src/engine/promotion.ts'
import { factorIndexSummary } from '../factorService.ts'
import { factorStrategySummary } from '../factorStrategyService.ts'
// ★ 舰队实况从 `fleet/index.ts` 这一个面取（那里是舰队对外的唯一入口）。
//   直接从 `service.ts` 取会让"舰队有两个入口"，而两个入口迟早会长成两套口径。
import { fleetSnapshot } from '../fleet/index.ts'

export type FactSource = 'live' | 'demo' | 'unavailable'

export interface Fact<T> {
  value: T | null
  source: FactSource
  /** 证据落在哪 —— 一句话能让人自己去核对；`unavailable` 时写的是"缺什么、为什么缺"。 */
  evidence: string
}

const live = <T>(value: T, evidence: string): Fact<T> => ({ value, source: 'live', evidence })
const demo = <T>(value: T, evidence: string): Fact<T> => ({ value, source: 'demo', evidence })
const absent = <T>(why: string): Fact<T> => ({ value: null, source: 'unavailable', evidence: why })

/** 数字收口：非有限值一律当"没有"，绝不让 NaN 走到要出声的字符串里。 */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 可念的百分数。与面板上显示的算式**同源**（分数 / 百分数不要在这里再猜一次单位）。 */
function pct(v: number | null, digits = 2): string {
  if (v === null) return '未知'
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

// ─────────────────────────── 系统实况 ───────────────────────────

export interface Situation {
  mode: Fact<'paper' | 'live'>
  killswitch: Fact<boolean>
  equity: Fact<{ equity: number; starting: number; pnlPct: number | null }>
  positions: Fact<{ count: number; symbols: string[] }>
  openOrders: Fact<number>
  autopilot: Fact<{
    running: boolean
    targetPct: number | null
    pnlPct: number | null
    cycles: number
    bars: number
    hasGuard: boolean
    gateRefusal: string | null
    winner: string | null
  }>
  decisionBrain: Fact<{ ended: number; mathObservable: number; ratio: number }>
  surveillance: Fact<{ trackedFills: number; flagged: number }>
  lessons: Fact<{ total: number; active: number; blocked: number; decayed: number; avgHealth: number }>
  pipeline: Fact<{ total: number; furthestId: string | null; furthestStage: Stage | null }>
  /** 「哪个策略盈利最高」的答案本身。**恒为 unavailable** —— 见下方 `fleetPnlVerdict()`。 */
  fleetPnl: Fact<never>
}

/**
 * 采集一次系统实况。**只读**，可在任意时刻调用。
 *
 * 每一项都从**既有服务函数**读数（`autopilotStatus` / `pipelineService` /
 * `lessonStats` …），不自己拼一份 —— 再拼一份就是第二个口径，
 * 而两个口径迟早会对同一个问题给出不同答案。
 */
export function situation(): Situation {
  const s = getOrchState()
  const ap = autopilotStatus()
  const equityNow = currentEquity(s)
  const starting = finite(s.startingBalance) ?? 0
  const pnlPct = starting > 0 ? ((equityNow - starting) / starting) * 100 : null

  // 决策大脑：只统计**已结束**的决策（`AUTOPILOT_POSITION_OPENED`），
  // 与 `/decisions/observability` 端点取的是同一批记录、同一个判据。
  const brainRecords = getEvents(0)
    .filter((e) => e.kind === 'AUTOPILOT_POSITION_OPENED')
    .map((e) => e.payload as Record<string, unknown>)
  const brain = auditSnapshotObservability(brainRecords)

  const surf = surveillanceSnapshot()
  const ls = lessonStats()
  const rows = pipelineService.list()
  const furthest = [...rows].sort(
    (a, b) => PROMOTION_STAGE_RANK[b.stage] - PROMOTION_STAGE_RANK[a.stage] || (b.fitness?.value ?? 0) - (a.fitness?.value ?? 0),
  )[0]

  return {
    mode: live(s.mode, 'server/core.ts 的 getOrchState().mode（进程级按死 AUTOPILOT_LIVE，见 stackRoles）'),
    killswitch: live(s.killswitch, 'server/core.ts 的 getOrchState().killswitch'),
    equity: live(
      { equity: equityNow, starting, pnlPct },
      'server/risk.ts 的 currentEquity(state)（持仓按 lastPrice 折算，不是只算现金）',
    ),
    positions: live(
      { count: s.positions.size, symbols: [...s.positions.keys()] },
      'getOrchState().positions',
    ),
    openOrders: live(s.orders.length, 'getOrchState().orders'),
    autopilot: live(
      {
        running: ap.running,
        targetPct: finite(ap.targetPct),
        pnlPct: finite(ap.pnlPct),
        cycles: ap.cycles,
        bars: ap.barsAccumulated,
        hasGuard: ap.guard !== null && ap.guard !== undefined,
        gateRefusal: ap.gateRefusal?.summary ?? null,
        winner: ap.winner ?? null,
      },
      'server/autopilot.ts 的 autopilotStatus()（含 winner / 目标 / 守护持仓 / 门禁拒绝）',
    ),
    decisionBrain: live(
      { ended: brain.total, mathObservable: brain.mathObservable, ratio: brain.mathObservableRatio },
      'server/decisionObservability.ts 的 auditSnapshotObservability(AUTOPILOT_POSITION_OPENED 的 payload)',
    ),
    surveillance: live(
      { trackedFills: surf.counters.trackedFills, flagged: surf.counters.flaggedSelfTrades + surf.counters.flaggedChurn + surf.counters.flaggedSmallNotionalBursts },
      'server/surveillance.ts 的 surveillanceSnapshot()',
    ),
    lessons: live(
      { total: ls.total, active: ls.active, blocked: ls.blocked, decayed: ls.decayed, avgHealth: ls.avgHealth },
      'server/evolutionShield.ts 的 lessonStats()（数据落在 data/AI_TRADING_MEMORY.md）',
    ),
    pipeline: live(
      { total: rows.length, furthestId: furthest?.id ?? null, furthestStage: furthest?.stage ?? null },
      'server/pipelineService.ts 的 list()（persist 在 data/pipeline-*.json）',
    ),
    fleetPnl: absent(fleetPnlVerdict().reason),
  }
}

// ─────────────────── 「哪个策略盈利最高」的真实答案 ───────────────────

/**
 * 这个问题的答案**就是** `unavailable`。
 *
 * 三条事实，逐条核过：
 *   ① `src/engine/promotion.ts` 的 `PaperStats` 只有 `trades` 与 `maxDrawdownPct`，
 *      **没有盈亏金额**；`TestnetStats` 同样没有。这是刻意设计 —— 测试网的意义是
 *      "在真钱之前暴露系统级缺陷"，不是"用假钱赚一遍"。
 *   ② 「Agent 舰队」页的收益/胜率是页面内的演示常量，页面自己标着
 *      「DEMO 演示数字 · 非真实 PnL」。
 *   ③ `autopilotStatus()` 里的 `pnlPct` 是**整条自动驾驶**的权益变化，
 *      可以归属到"当前在跑的那一条"，但**不能**拆成分策略排名。
 *
 * ⇒ 把它写成函数而不是内联字符串，是为了让"为什么答不了"可以被单独断言，
 *    也让将来真的接上分策略盈亏时**只有一个地方要改**。
 */
export function fleetPnlVerdict(): {
  available: false
  reason: string
  /** 真实可查的替代口径 —— 回答不能只有"不知道"，还要给出下一个能查的东西。 */
  substitute: string
} {
  return {
    available: false,
    reason:
      '系统里没有按策略的盈亏数据：晋级流水线的 paper 统计只有成交笔数与最大回撤，' +
      '测试网统计同样没有金额；界面上 Agent 舰队那一页的收益数字是演示值，页面自己标着「非真实 PnL」',
    substitute: '能真实回答的是：当前自动驾驶在跑哪一条策略、它的权益变化是多少，以及每条候选在晋级流水线上走到了哪一阶段',
  }
}

// ─────────────────────────── 舰队排行 ───────────────────────────

export interface StrategyStanding {
  id: string
  stage: Stage
  stageLabel: string
  stageRank: number
  fitness: number | null
  paperTrades: number
  paperMaxDrawdownPct: number | null
  testnetFills: number
  testnetViolations: number
  venue: string | null
  /**
   * 这条记录里**有没有**盈亏金额。
   *
   * 恒为 `false`，而且**故意保留这个字段**：`false` 是一个可断言的事实，
   * 比"查不到"更能表达"系统确实不记这个"。字段消失时，
   * `test:voice` S14 会报红提醒有人改了数据模型。
   */
  hasPnl: false
}

export interface FleetStandings {
  rows: StrategyStanding[]
  total: number
  /** 排行口径必须写在数据里，否则"第一名"是谁取决于读的人怎么想。 */
  rankedBy: 'stage_then_fitness'
  source: FactSource
  evidence: string
  pnl: ReturnType<typeof fleetPnlVerdict>
  /** 当前真正在跑的那一条（真实来源：autopilot 的 winner）。 */
  running: { id: string; fitness: number | null; pnlPct: number | null; equity: number } | null
}

function toStanding(r: ReturnType<typeof pipelineService.list>[number]): StrategyStanding {
  const stage = r.stage
  return {
    id: r.id,
    stage,
    stageLabel: PROMOTION_STAGE_LABEL[stage],
    stageRank: PROMOTION_STAGE_RANK[stage],
    fitness: finite(r.fitness?.value),
    paperTrades: r.paperStats?.trades ?? 0,
    paperMaxDrawdownPct: finite(r.paperStats?.maxDrawdownPct),
    testnetFills: r.testnetStats?.fills ?? 0,
    testnetViolations: r.testnetStats?.violations ?? 0,
    venue: r.testnetStats?.venue ?? null,
    hasPnl: false,
  }
}

/**
 * "有记录 → live，无记录 → unavailable" 这条映射单独提出来。
 *
 * ★ 提出来是为了**能被双向断言**：内联在 `fleetStandings()` 里的话，
 * 测试只能断言"当前这一种环境下的那个值"，而一个恒返回 `'unavailable'` 的实现
 * 在空流水线环境下照样全绿（那正是本项目记过多次的"不可能失败的检查"）。
 * 提成纯函数之后，`test:voice` S14 可以喂 0 与 3 两个输入，一次把两个方向都钉住。
 */
export function standingsSourceOf(rowCount: number): FactSource {
  return rowCount > 0 ? 'live' : 'unavailable'
}

/**
 * 舰队排行。
 *
 * ★ 排序口径是 `stage_then_fitness`，**不是收益** —— 因为收益不存在（见 `fleetPnlVerdict`）。
 * 把口径写进返回值，是为了让"谁是第一"这个问题有一个可核对的定义，
 * 而不是让读者各自理解成"最赚钱的那个"。
 *
 * 空流水线时返回 `source: 'unavailable'`，**而不是一个空数组当作答案**：
 * "一条候选都没有"和"有候选但排不出来"是两件事，前者要告诉用户
 * "进化实验室还没产出过候选，得先跑一次提案"。
 */
export function fleetStandings(): FleetStandings {
  const raw = pipelineService.list()
  const rows = raw.map(toStanding).sort((a, b) => b.stageRank - a.stageRank || (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity))
  const ap = autopilotStatus()
  const s = getOrchState()

  const running =
    ap.winner && ap.running
      ? {
          id: ap.winner,
          fitness: rows.find((r) => ap.winner!.startsWith(r.id))?.fitness ?? null,
          pnlPct: finite(ap.pnlPct),
          equity: finite(ap.equity) ?? currentEquity(s),
        }
      : null

  return {
    rows,
    total: rows.length,
    rankedBy: 'stage_then_fitness',
    source: standingsSourceOf(rows.length),
    evidence:
      rows.length > 0
        ? 'server/pipelineService.ts 的 list()；排行按晋级阶段（PROMOTION_STAGE_RANK）再按适应度'
        : '晋级流水线里一条候选都没有 —— 还没跑过提案生成（说「进化一下自己」可以让我跑一轮）',
    pnl: fleetPnlVerdict(),
    running,
  }
}

// ─────────────────────────── 进化实验室 ───────────────────────────

export interface LabOverview {
  lessons: Fact<{
    total: number
    active: number
    blocked: number
    decayed: number
    avgHealth: number
    /** 健康分最高的几条心法 —— 只取文本与分数，供回话里举例。 */
    top: { ruleText: string; healthScore: number; sampleSize: number }[]
  }>
  pipeline: Fact<{ total: number; byStage: { stage: Stage; label: string; count: number }[] }>
  /**
   * 谱系树。
   *
   * ★ 这里是 `demo` 这一档**唯一**的真实用例，而且它恰好说明了 `demo` 与
   *   `unavailable` 的区别：进化实验室页**确实**画了一棵谱系树（事实存在、用户看得见），
   *   但它的内容是页面里的静态常量，不是从系统读出来的。
   *   ⇒ 对"系统里有没有谱系数据"这个问题，答案是 `unavailable`；
   *     对"用户在页面上看到的是什么"这个问题，答案是 `demo`。
   *   两件事分开说，用户才不会以为"页面画了 = 系统有"。
   */
  lineage: Fact<{ renderedAs: 'static-demo' }>
  /**
   * 因子台账。
   *
   * 这是"因子"第一次成为系统里的一等事实，所以它的三态尤其重要：
   * `unavailable` 不等于"没有因子"，而可能是三件不同的事 ——
   * 台账空（没跑过）、台账损坏、或者跑了但结论全部落在非真实数据上。
   * `evidence` 必须把是哪一件说出来，否则"没有可用的因子"和"系统根本没有这项能力"
   * 在用户听来是同一句话。
   */
  factors: Fact<{
    total: number
    accepted: number
    rejected: number
    unverifiable: number
    onHistoryShare: number
    updatedAt: string | null
    /**
     * ★ 策略层筛完之后，**真的能拿去交易**的有几个。
     *
     * 为什么必须和 `accepted` 并列：只念「通过 14 个」会把用户引到一个
     * 不存在的结论上 —— 他会以为有 14 个能用的因子，而实际上这 14 个
     * 是「信号有预测力」，离「扣掉成本还赚钱」还隔着一道门。
     * 实测：2026-09-18 那 14 个在策略门上是 **0 通过**。
     * 判据 16：这个输出会把用户引向哪个动作？那个动作有用吗？
     */
    tradeable: number
    /** 是否跑过策略层筛查。false ⇒ `tradeable` 是"还没算"而不是"算出来是 0"。 */
    screened: boolean
    /** 筛查结论里因行情换版失效的条数（>0 时下游必须提示重跑）。 */
    staleScreen: number
  }>
  capabilities: string[]
}

/**
 * 进化实验室实况。
 *
 * ★ 这里是"用户不知道还有进化实验室"这个问题的正解：不只是告诉他有这个地方，
 * 而是**说清它能干什么、以及能让他怎么用**（`capabilities`）。
 * `lineage` 恒为 `unavailable`：页面上那棵谱系树是演示文案，系统里没有谱系数据 ——
 * 与其编，不如说清"这部分还没有"。
 */
export function labOverview(): LabOverview {
  const ls = lessonStats()
  const rows = pipelineService.list()
  const byStageMap = new Map<Stage, number>()
  for (const r of rows) byStageMap.set(r.stage, (byStageMap.get(r.stage) ?? 0) + 1)
  const byStage = [...byStageMap.entries()]
    .map(([stage, count]) => ({ stage, label: PROMOTION_STAGE_LABEL[stage], count }))
    .sort((a, b) => PROMOTION_STAGE_RANK[b.stage] - PROMOTION_STAGE_RANK[a.stage])

  const top = [...loadLessons()]
    .filter((l) => l.enabled)
    .sort((a, b) => b.healthScore - a.healthScore)
    .slice(0, 3)
    .map((l) => ({ ruleText: l.ruleText, healthScore: l.healthScore, sampleSize: l.sampleSize }))

  const fs = factorIndexSummary()
  // 策略层：把「有预测力」和「能拿去交易」分开报。少了这一句，
  // 上面那个 `accepted` 数字会被用户直接读成"可用的因子数"。
  const ss = factorStrategySummary()

  return {
    lessons: live({ ...ls, top }, 'server/evolutionShield.ts 的 lessonStats() + loadLessons()'),
    pipeline: live({ total: rows.length, byStage }, 'server/pipelineService.ts 的 list() 按 stage 归类'),
    factors: fs.available
      ? live(
          {
            total: fs.total,
            accepted: fs.accepted,
            rejected: fs.rejected,
            unverifiable: fs.unverifiable,
            onHistoryShare: fs.historyShare,
            updatedAt: fs.updatedAt,
            tradeable: ss.available ? ss.usableNow : 0,
            screened: ss.available,
            staleScreen: ss.available ? ss.stale : 0,
          },
          `server/factorService.ts 的 factorIndexSummary()（data/factors/index.json）` +
            ` + factorStrategyService.ts 的 factorStrategySummary()（data/factors/strategies.json）· ${fs.reason} · ${ss.reason}`,
        )
      : absent(`因子台账不可用：${fs.reason}`),
    lineage: demo(
      { renderedAs: 'static-demo' as const },
      '进化实验室页的谱系树由页面内静态常量渲染（src/pages/EvoPage.tsx），不是从系统读出来的 —— ' +
        '系统里没有谱系数据（没有父代/子代/变异来源的存储）',
    ),
    capabilities: [
      '生成因子提案：说「进化一下自己」，我会让提案引擎在真实 K 线上跑一轮候选评估，并把结果落进晋级流水线',
      '登记一条心法：把你的一句教训沉淀成可复用资产，它会被回注进提案引擎的上下文',
      '查实验室现状：心法多少条、健康分多少、候选走到哪一阶段',
    ],
  }
}

// ─────────────────────────── 播报文案 ───────────────────────────

/**
 * 回话文案的三条硬约束（由 `test:voice` S12 / S14 断言）：
 *   ① 不得出现 Markdown 星号（它会被念成"星星星"）；
 *   ② 不得出现 `undefined` / `NaN` / `[object Object]`；
 *   ③ **`source !== 'live'` 的事实在文案里必须被说出来** ——
 *      沉默地跳过一项，用户会以为系统没有这一项，而不是以为数据缺失。
 */
export function speakSituation(): string {
  const x = situation()
  const parts: string[] = []

  const ap = x.autopilot.value!
  if (!ap.running) {
    parts.push('自动驾驶现在是停的')
  } else if (ap.bars < 60) {
    parts.push(`自动驾驶在跑，但你来得早，行情还在攒，已经攒了 ${ap.bars} 根 K 线`)
  } else {
    parts.push(`自动驾驶在跑，已经走了 ${ap.cycles} 轮，攒了 ${ap.bars} 根 K 线`)
  }
  if (ap.winner) parts.push(`现在用的是 ${ap.winner}`)
  if (ap.hasGuard) parts.push('手上有守护持仓')

  const eq = x.equity.value!
  parts.push(`权益 ${eq.equity.toFixed(2)} 美元，相对起点 ${pct(eq.pnlPct)}`)

  const pos = x.positions.value!
  parts.push(pos.count === 0 ? '没有持仓' : `持仓 ${pos.count} 笔：${pos.symbols.join('、')}`)
  parts.push(`挂单 ${x.openOrders.value} 笔`)
  if (x.killswitch.value) parts.push('熔断是开着的，所有新单都会被拒')

  const brain = x.decisionBrain.value!
  parts.push(
    brain.ended === 0
      ? '决策大脑还没有已结束的决策样本'
      : `决策大脑有 ${brain.ended} 笔已结束决策，其中能用于数理归因的占 ${(brain.ratio * 100).toFixed(1)}%`,
  )

  const ls = x.lessons.value!
  parts.push(`心法库 ${ls.total} 条，生效 ${ls.active} 条，平均健康分 ${ls.avgHealth}`)

  const pl = x.pipeline.value!
  parts.push(
    pl.total === 0
      ? '晋级流水线是空的，还没跑过提案生成'
      : `晋级流水线 ${pl.total} 条候选，走得最远的那条在「${PROMOTION_STAGE_LABEL[pl.furthestStage!]}」`,
  )
  if (ap.gateRefusal) parts.push(`过拟合门最近拒绝过一次，理由是 ${ap.gateRefusal}`)

  // ★ 这一句不能删：它是"系统里没有这个数据"被主动说出来的唯一位置。
  parts.push('有一件事我先说清楚：系统里没有按策略的盈亏数据，所以别问我哪个策略最赚钱')
  parts.push(`我在「进化实验室」那一页能做的事，问我就行`)

  return parts.join('。') + '。'
}

export function speakFleet(): string {
  const f = fleetStandings()

  if (f.total === 0) {
    return (
      '晋级流水线里一条候选都没有，所以没有排名可报。' +
      '这不是坏了 —— 候选是提案引擎跑出来的，我还没跑过。你说「进化一下自己」，我就去真实 K 线上跑一轮。' +
      '准确说不止一层，我把能说的都说清楚。' +
      '第一层和候选数量有关：流水线得先有候选，才谈得上排名。' +
      '第二层是数据本身不存在：系统里没有按策略的盈亏数据，所以就算有候选，我也报不出谁赚得最多这种排名。' +
      '界面上 Agent 舰队那一页显示的收益数字是演示值，页面上自己标着非真实盈亏，我不会拿它当答案。' +
      '我能真实给你的是：每条候选走到了哪一阶段，还有当前在跑那条策略的权益变化。'
    )
  }

  const parts: string[] = []
  parts.push(`晋级流水线里一共 ${f.total} 条候选`)
  const top = f.rows.slice(0, 3)
  parts.push(
    '按走得远近排，前面的是：' +
      top
        .map((r, i) => `${i + 1} 号 ${r.id}，在「${r.stageLabel}」${r.fitness !== null ? `，适应度 ${r.fitness.toFixed(2)}` : ''}`)
        .join('；'),
  )
  if (f.running) {
    parts.push(
      `现在真正在跑的是 ${f.running.id}` +
        (f.running.pnlPct !== null ? `，它的 paper 权益 ${f.running.equity.toFixed(2)} 美元，相对起点 ${pct(f.running.pnlPct)}` : ''),
    )
  }
  const deepest = f.rows.find((r) => r.paperTrades > 0)
  if (deepest) {
    parts.push(
      `${deepest.id} 在纸交易里成交 ${deepest.paperTrades} 笔` +
        (deepest.paperMaxDrawdownPct !== null ? `，最大回撤 ${deepest.paperMaxDrawdownPct.toFixed(2)}%` : ''),
    )
  }

  // ★ 排行口径与"缺什么"都必须被念出来 —— 否则用户会把"走得最远"听成"最赚钱"。
  parts.push('这里的排名是按晋级阶段再按适应度排的，不是按收益')
  parts.push(
    '原因我得如实说：系统里没有按策略的盈亏数据。流水线的纸交易统计只有成交笔数和最大回撤，测试网统计同样没有金额。' +
      '界面上 Agent 舰队那一页的收益数字是演示值，页面上自己标着非真实盈亏，我不会拿它当答案',
  )
  parts.push('要真实数字的话，我能给你的是当前在跑那条策略的权益变化，还有每条候选走到了哪一阶段')

  return parts.join('。') + '。'
}

export function speakLab(): string {
  const lab = labOverview()
  const ls = lab.lessons.value!
  const pl = lab.pipeline.value!
  const parts: string[] = []

  parts.push('进化实验室是真的在跑的，它有两个部件')
  parts.push(
    `第一个是心法库。现在共 ${ls.total} 条，生效 ${ls.active} 条，被盾拦下 ${ls.blocked} 条，已失效 ${ls.decayed} 条，生效的平均健康分 ${ls.avgHealth}`,
  )
  if (ls.top.length > 0) {
    parts.push(`健康分最高的一条是：${ls.top[0].ruleText}`)
  }
  parts.push('这些心法不是摆设 —— 提案引擎每提一个提案，都会把它们装进上下文，也就是模型看得见这些教训')
  parts.push(
    pl.total === 0
      ? '第二个是晋级流水线，现在还是空的，还没有候选走进去过'
      : `第二个是晋级流水线，现在有 ${pl.total} 条候选，分布是：${pl.byStage.map((b) => `${b.label} ${b.count} 条`).join('，')}`,
  )
  parts.push('流水线的路径是：候选、纸交易观察、测试网实测、小资金实盘、全量实盘，任何一步不过就回滚')
  // 因子线必须被说出来，且**三态都要能被听见**。
  // 台账空 → 说"还没跑过"，不说"没有因子"；台账不可用 → 把缺什么说清楚。
  const fc = lab.factors
  if (fc.source === 'live' && fc.value) {
    const v = fc.value
    const histPct = (v.onHistoryShare * 100).toFixed(0)
    parts.push(
      `第三个是因子生产线。台账里有 ${v.total} 个因子，通过 ${v.accepted} 个，被拒 ${v.rejected} 个，` +
        `证据不足 ${v.unverifiable} 个；其中 ${histPct}% 的判决是在真实历史上做出的`,
    )
    if (v.onHistoryShare < 1) {
      // 非真实数据上的判决必须明说 —— 它在数字上"通过"了，但它不是证据。
      parts.push('没落在真实历史上的那部分判决不作数，它们只是诊断，我不会拿它们当因子有效的依据')
    }
    // ★ 「通过几个」不等于「能用几个」。这两个数字必须一起念出来，
    //   否则用户会拿着 `accepted` 去下单 —— 而那一步另有成本门挡着。
    if (!v.screened) {
      parts.push(
        '但我还没对它跑过策略层筛查，所以现在没有任何因子是可以拿去交易的。' +
          '要拿到那个数字，得跑一次因子筛查：把已通过的因子逐折丢进样本外回测，扣掉手续费和滑点再看还赚不赚钱',
      )
    } else if (v.tradeable === 0) {
      parts.push(
        `扣掉手续费和滑点之后，真正能拿去交易的是 ${v.tradeable} 个 —— ` +
          '也就是说，那些通过的因子在成本之上守不住，这一步不算完，还不能拿它们下单',
      )
    } else {
      parts.push(`扣掉手续费和滑点之后，真正能拿去交易的是 ${v.tradeable} 个`)
    }
    if (v.staleScreen > 0) {
      parts.push(`其中 ${v.staleScreen} 条筛查结论的行情指纹已经变了，结论过时，要重跑一次筛查才算数`)
    }
  } else {
    parts.push(`第三个是因子生产线，它现在没有可报的台账：${fc.evidence}`)
  }
  parts.push('我用得上它的方式有四种：让我跑一轮因子提案，让我跑一批因子生产，让我把你的一句教训登记成心法，或者让我报实验室现状')
  parts.push('一处我不说假话：实验室页面上的谱系树是演示文案，系统里没有谱系数据，所以我不念它')

  return parts.join('。') + '。'
}

// ─────────────────────────── Agent 舰队实况 ───────────────────────────

/**
 * 「Agent 舰队现在什么样」。
 *
 * ── 它和 `speakFleet()` 不是一回事 ────────────────────────────────────
 * `speakFleet()` 说的是**晋级流水线的排行**（哪个候选策略走得远）。
 * 这个说的是**七个干活成员**：谁跑过、谁没跑过、产出被谁读。
 * 两件事都用过「舰队」这个词是历史遗留，所以在话里要把区别说出来，
 * 否则用户问"舰队怎么样"会拿到一个答非所问却像在回答的答案。
 *
 * ── 为什么必须把「没跑过」单独念出来 ──────────────────────────────────
 * 这一页在改造之前是写死的演示数字：六个成员永远显示"运行中 + 今日盈利"。
 * 现在换成真实账本之后，最可能出现的状态其实是**七个成员全都没跑过**。
 * 那是一个诚实的状态，但它长得和"坏了"很像 —— 所以要说清
 * 「没跑过」不等于失败，并且立刻告诉用户**怎么让它跑起来**。
 *
 * ── 只读性 ───────────────────────────────────────────────────────────
 * `fleetSnapshot()` 会读账本事件、审计注册表，并在**进程内**装一次订阅
 * （幂等、不落盘、不改账本）。它不写任何事件 —— 与"本模块只读不写"一致。
 */
export function speakAgentFleet(): string {
  const snap = fleetSnapshot()
  const agents = snap.agents
  const ran = agents.filter((a) => a.state !== 'never')
  const failed = agents.filter((a) => a.state === 'failed')
  const islands = agents.filter((a) => a.consumers.length === 0)

  const parts: string[] = []

  // ① 先把"这说的是哪个舰队"讲清楚，避免与流水线排行混淆。
  parts.push(
    '这里说的是 Agent 舰队 —— 真正干活的七个成员，不是晋级流水线的策略排行。' +
      '你要是想听策略排名，说「舰队排行」；想听这几个成员的状态，就问「Agent 舰队」',
  )

  // ② 真实数字：成员数、跑过的、没跑过的。三者分开报。
  parts.push(`舰队一共 ${agents.length} 个成员，跑过的有 ${ran.length} 个，还没跑过的有 ${agents.length - ran.length} 个`)
  if (snap.registry.problems.length > 0) {
    // 注册表问题必须念 —— 它是"某个成员是孤岛"这类结构缺陷的唯一出口。
    parts.push(
      `注册表有 ${snap.registry.problems.length} 个问题要修，最要紧的一条是：${snap.registry.problems[0].problem}`,
    )
  }
  if (islands.length > 0) {
    parts.push(
      `有 ${islands.length} 个成员的产出没有任何人读：${islands.map((a) => a.label).join('、')}。` +
        '产出没人读的成员等于没接进系统，这不叫"在跑"',
    )
  }

  // ③ 每个跑过的成员报一句它自己给的产出；失败的报原因。
  if (ran.length > 0) {
    parts.push(
      '跑过的成员，最近那次的结果是：' +
        ran
          .slice(0, 5)
          .map((a) => `${a.label}${a.lastRun?.ok ? '成了' : '没成'}，${a.lastRun?.summary ?? ''}`)
          .join('；'),
    )
  }
  if (failed.length > 0) {
    parts.push(`其中 ${failed.length} 个上次是失败的：${failed.map((a) => a.label).join('、')}。失败也留了痕，能查`)
  }

  // ④ 没跑过 ⇒ 说清这不是故障，并给出让它跑起来的说法。
  if (ran.length === 0) {
    parts.push(
      '这七个成员一个都还没跑过。那不是坏了，是还没被用过 —— 以前这一页上那些收益和胜率数字是写死的演示值，' +
        '现在换成账本里的真实记录，所以一开始就是"没跑过"',
    )
  }
  parts.push(
    '要让它跑起来，直接跟我说一件事就行：说「扩候选基因空间」，我会让因子生产官和策略筛官员接着干；' +
      '说「跑一轮提案」，提案专员就去真实行情上跑；说「文件体检」，文件体检员给你一份可回收清单',
  )

  // ⑤ 总线：协同的物理形态。空总线要说成"还没协同过"，不是"正常"。
  parts.push(
    snap.bus.messages === 0
      ? '成员之间还没有互相递过消息，也就是说还没发生过一次真正的协同'
      : `成员之间一共递过 ${snap.bus.messages} 条消息，经过 ${snap.bus.subscriptions} 个订阅关系`,
  )

  // ⑥ 只报告不删除这条必须说 —— 用户最容易误解的就是"清理"两个字。
  parts.push('一处我不含糊：文件体检员只出清单，不删任何东西。删要你拿着清单自己点头')

  return parts.join('。') + '。'
}
