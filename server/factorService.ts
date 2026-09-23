/**
 * 因子批量生产线 —— 把「因子」变成一类有台账、有证据、有判决的系统资产。
 *
 * ══ 它和 `proposalEngine` / `evidence.ts` 的分工 ═══════════════════════
 *   proposalEngine  产**策略**（带仓位、成本、执行），评价靠回测曲线
 *   evidence.ts     判**策略集**会不会过拟合（PBO / walk-forward）
 *   factorService   产**因子**（纯信号，与交易无关），评价靠 IC / ICIR
 *
 * 三者是上下游：因子有预测力是策略有效的**必要非充分**条件。
 * 分开的理由是归因：现在"信号没用"与"信号有用但被成本吃掉"在系统里
 * 长得完全一样（都是 fitness 低），于是没人知道该改哪一头。
 *
 * ══ 一处刻意不重新实现的东西：取数 ═══════════════════════════════════
 * 数据一律走 `loadEvidence()`——真实历史优先、没有才回落合成、并把 origin 标出来。
 * 另写一个取数函数是本项目最忌讳的形态（同一个事实两份实现然后悄悄漂移），
 * 而且这里有一个更硬的后果：**如果因子线和门禁线吃不同的数据，
 * 那么"因子通过了"与"策略没过门"就永远无法互相解释**，
 * 两边都会坚称自己算得对。F-47 已经因为同一原因拒绝过一次捷径。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FACTOR_GATE,
  DEFAULT_HORIZONS,
  DEFAULT_WINDOWS,
  evaluateFactorBatch,
  generateFactorBatch,
} from '../src/engine/index.ts'
import type {
  BatchResult,
  Candle,
  FactorGateThresholds,
  FactorOrigin,
  FactorSpec,
} from '../src/engine/index.ts'
import { loadEvidence } from './evidence.ts'
import { atomicWriteJson } from './atomicWrite.ts'

export const FACTOR_INDEX_VERSION = 'factor-index-v1'

export interface FactorIndexRow {
  slug: string
  nameCn: string
  category: string
  base: string
  transform: string
  window: number
  state: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  reason: string
  /** **判决的前提**：这份判决是在哪种数据上做出的。 */
  origin: FactorOrigin
  /** 行情指纹。换了数据，旧结论就不再适用 —— 有了它才看得出来。 */
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

export interface FactorIndex {
  version: typeof FACTOR_INDEX_VERSION
  horizons: number[]
  thresholds: FactorGateThresholds
  rows: FactorIndexRow[]
  updatedAt: string
}

export function defaultIndexPath(cwd = process.cwd()): string {
  return join(cwd, 'data', 'factors', 'index.json')
}

export function emptyIndex(th: FactorGateThresholds = DEFAULT_FACTOR_GATE): FactorIndex {
  return {
    version: FACTOR_INDEX_VERSION,
    horizons: [...DEFAULT_HORIZONS],
    thresholds: th,
    rows: [],
    updatedAt: new Date(0).toISOString(),
  }
}

/**
 * 读索引。
 *
 * 缺文件 → 返回空索引（**不是报错**：第一次跑生产线时本来就没有索引）。
 * 有文件但格式不对 → 同样返回空索引，但把 `damaged` 标出来。
 * 这里刻意不抛：读路径抛异常会让"索引坏了"表现为"整个面板打不开"，
 * 而后者掩盖了前者。损坏必须被**说出来**，不是被放大成别的问题。
 */
export function readFactorIndex(path: string): { index: FactorIndex; damaged: string | null } {
  if (!existsSync(path)) return { index: emptyIndex(), damaged: null }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as FactorIndex
    if (!raw || !Array.isArray(raw.rows)) return { index: emptyIndex(), damaged: '索引结构不合法（rows 不是数组）' }
    return { index: raw, damaged: null }
  } catch (e) {
    return { index: emptyIndex(), damaged: `索引解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 索引写入前的自检：**slug 必须唯一**。
 *
 * 这条检查是整条生产线里最便宜也最容易被省掉的一条。省掉它的后果不是
 * "多一行数据"，而是台账从此不可信：同一个 slug 两条互相矛盾的结论，
 * 下游读哪条取决于遍历顺序 —— 这正是"同一个事实存了两份"的教科书形态。
 * 上游 factory 的验收清单里把它列为必查项（no duplicate slug），照抄。
 */
export function assertIndexUnique(index: FactorIndex): void {
  const seen = new Set<string>()
  const dups: string[] = []
  for (const r of index.rows) {
    if (seen.has(r.slug)) dups.push(r.slug)
    seen.add(r.slug)
  }
  if (dups.length > 0) {
    throw new Error(`因子索引存在重复 slug：${[...new Set(dups)].join(', ')}`)
  }
}

export interface IndexInconsistency {
  slug: string
  /** 按**当前**判定口径它应该是什么。 */
  expected: string
  /** 台账里实际记的是什么。 */
  actual: string
  why: string
}

/**
 * 台账**自洽审计**：每一行的判决，能不能被它自己记下的指标解释？
 *
 * 存在的理由是一条实测过的失效：判定器更正了闸门顺序之后，旧行仍然写着
 * **旧判定器**的结论，而那些结论在新口径下**是错的**。实测形态：5 条
 * `price_volume_corr_*_4` 记着"证据不足、再攒点数据"，而它们的 coverage 是 0 ——
 * 零覆盖 + 样本达标在更正后的口径下**必然是 rejected**。
 * 台账不会因为判定器升级而自己重写，于是读路径**静默陈旧**：
 * 面板、语音、下游全基于它下结论，而结论看着完全正常。
 *
 * 只做**能从行内字段判定**的事，不重算、不猜：
 *   · 覆盖率 0 且样本量达标 ⇒ 新口径下必为 rejected，行里不是 ⇒ 不自洽；
 *   · 非真实历史却判 accepted ⇒ 违反 fail-closed 不变量 ⇒ 不自洽。
 * 判不了的（例如 IC 数值漂移）**一律不报** —— 宁可漏报也不制造假警报，
 * 因为对正确输入报错的检查会训练人忽略它的红。
 */
export function auditIndexRows(index: FactorIndex): IndexInconsistency[] {
  const out: IndexInconsistency[] = []
  const minBars = index.thresholds?.minBars ?? DEFAULT_FACTOR_GATE.minBars
  for (const r of index.rows) {
    if (r.state === 'accepted' && r.origin !== 'history') {
      out.push({
        slug: r.slug,
        expected: 'unverifiable(origin)',
        actual: `${r.state}/${r.gate}`,
        why: '非真实数据上不得产出"通过"（fail-closed 不变量）',
      })
      continue
    }
    if (r.coverage <= 0 && r.bars >= minBars && r.state !== 'rejected') {
      out.push({
        slug: r.slug,
        expected: 'rejected(coverage)',
        actual: `${r.state}/${r.gate}`,
        why: `覆盖率 0 且样本 ${r.bars} 根已达标 —— 零产出不等于"证据不足"，此行由旧版判定器写入`,
      })
    }
  }
  return out
}

export function upsertRows(index: FactorIndex, rows: FactorIndexRow[], th: FactorGateThresholds): FactorIndex {
  const byslug = new Map(index.rows.map((r) => [r.slug, r]))
  for (const r of rows) {
    const prev = byslug.get(r.slug)
    byslug.set(r.slug, prev ? { ...r, firstSeenAt: prev.firstSeenAt } : r)
  }
  const next: FactorIndex = {
    version: FACTOR_INDEX_VERSION,
    horizons: [...DEFAULT_HORIZONS],
    thresholds: th,
    rows: [...byslug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    updatedAt: new Date().toISOString(),
  }
  assertIndexUnique(next)
  return next
}

export interface ProduceOptions {
  count?: number
  symbol?: string
  barMinutes?: number
  thresholds?: FactorGateThresholds
  indexPath?: string
  cwd?: string
  /** 直接注入 K 线与来源，供测试构造"合成/样本不足"等路径。 */
  candles?: Candle[]
  origin?: FactorOrigin
  dataHash?: string
  /** 只算不落盘。生产线的烟测需要它 —— 否则每跑一次测试都改台账。 */
  dryRun?: boolean
  /**
   * 把**指纹与当前行情不符**的行重判一遍。默认开。
   *
   * 不开的后果是过时判决成为**终态**：`generateFactorBatch` 只产新 slug，
   * 老 slug 一律跳过，所以生产者永远碰不到那些行。实测：5 条 accepted 里
   * 4 条是旧版行情的，策略层只能把它们全部标成 stale ⇒ 因子接生产产出 0 个策略。
   */
  refreshStale?: boolean
  /**
   * 本次展开用的窗口组。默认 `DEFAULT_WINDOWS`。
   *
   * ★ 它是"扩候选基因空间"的**唯一有效手段**，所以必须可注入：
   *   机制（base）× 变换（transform）× 窗口（window）是全部维度，
   *   而前两维已固定，只有窗口是能加的。实测：默认 7 个窗口共 490 格，
   *   台账跑满 490 行之后，再按同一组窗口请求生产会返回 **0 个候选** ——
   *   那不是"挖了没挖到"，是"没得挖了"，而这个区别要靠 `space` 说出来。
   */
  windows?: readonly number[]
}

export interface ProduceResult {
  origin: FactorOrigin
  dataHash: string
  bars: number
  specs: number
  /** 其中属于**重判过时行**的条数（不是新候选）。 */
  refreshed: number
  accepted: number
  rejected: number
  unverifiable: number
  /**
   * 立案时**待重判**的行数：指纹与当前行情不符的 + 判决与自身指标自相矛盾的。
   * 不论这次有没有真的重判（`refreshStale: false` 时它照样反映现状）。
   */
  staleInIndex: number
  /** 被拦下的因子按闸门分组，用来回答"哪道闸门最常拦人"。 */
  byGate: Record<string, number>
  /**
   * 候选空间的余量。
   *
   * ★ 没有这三个数，"跑了 0 个候选"会被读成"挖了但没挖到"，而真相通常是
   *   "这个空间里已经没有未挖的格子了"—— 两种事因在旧观测上完全一样，
   *   而下一步动作完全相反（继续加大 count vs 去加窗口维度）。
   *   `total` 与生产用的是**同一份**展开器（同一窗口集、同一机制下限），
   *   所以它不会与真实可产出的数量漂移。
   */
  space: { total: number; used: number; remaining: number; windows: number[] }
  rows: FactorIndexRow[]
  batch: BatchResult
  indexPath: string
  written: boolean
}

/**
 * 从台账行还原因子定义 —— **唯一一份**（策略层也用它，不许各写一份）。
 *
 * 为什么必须从台账读、而不是解析 slug：slug 形如 `base_transform_window`，
 * 但 `base` 与 `transform` 里**都**含下划线（`price_volume_corr`、`vol_scaled`），
 * 所以 `price_volume_corr_vol_scaled_4` 会被拆成
 * `base=price_volume_corr_vol` + `transform=scaled` —— 一个不存在的因子，
 * 而且它**不报错**，构造出来的东西照样能跑出数字。slug 是给人看的键，不是编码。
 */
export function specFromRow(r: FactorIndexRow): FactorSpec {
  return { slug: r.slug, nameCn: r.nameCn, category: r.category, base: r.base, transform: r.transform, window: r.window }
}

function rowFrom(spec: FactorSpec, entry: BatchResult['entries'][number], origin: FactorOrigin, dataHash: string, now: string): FactorIndexRow {
  const m = entry.metrics
  return {
    slug: spec.slug,
    nameCn: spec.nameCn,
    category: spec.category,
    base: spec.base,
    transform: spec.transform,
    window: spec.window,
    state: entry.verdict.state,
    gate: entry.verdict.gate,
    reason: entry.verdict.reason,
    origin,
    dataHash,
    bars: m.bars,
    coverage: m.coverage,
    icMean5: m.icMean5,
    icir: m.icir,
    turnover: m.turnover,
    quantileSpreadBps: m.quantileSpreadBps,
    firstSeenAt: now,
    lastEvaluatedAt: now,
  }
}

/**
 * 跑一批因子生产。
 *
 * 顺序固定为「读索引 → 跳过已有 slug → 展开候选 → 评价 → 过门 → 落盘」。
 * **落盘放在最后**：中途抛异常时索引保持原样，不会留下"写了一半的台账"。
 */
export function produceFactors(opts: ProduceOptions = {}): ProduceResult {
  const cwd = opts.cwd ?? process.cwd()
  const indexPath = opts.indexPath ?? defaultIndexPath(cwd)
  const th = opts.thresholds ?? DEFAULT_FACTOR_GATE
  const count = Math.max(1, Math.min(opts.count ?? 12, 200))
  const windows = opts.windows ?? DEFAULT_WINDOWS

  const injected = opts.candles !== undefined
  let candles: Candle[]
  let origin: FactorOrigin
  let dataHash: string
  if (injected) {
    candles = opts.candles as Candle[]
    origin = opts.origin ?? 'injected'
    dataHash = opts.dataHash ?? `injected:${candles.length}`
  } else {
    // 唯一取数入口：真实历史优先，缺失才回落合成 —— 与门禁同源。
    const ev = loadEvidence(opts.symbol ?? 'BTCUSDT', opts.barMinutes ?? 15)
    candles = ev.candles
    origin = ev.origin
    dataHash = ev.dataHash
  }

  const { index } = readFactorIndex(indexPath)
  const staleRows = index.rows.filter((r) => r.dataHash !== dataHash)
  // 第二类待重判的行：**判决与它自己记下的指标自相矛盾**（判定器升级后遗留）。
  // 只按指纹挑是不够的 —— 实测里那 5 条 `price_volume_corr_*_4` 的指纹**是对的**，
  // 只是结论由旧版闸门顺序写入（覆盖率 0 却记着"证据不足"）。
  // 审计（`auditIndexRows`）负责发现，这里负责修 —— 少了这一半，
  // 审计就成了一份永远没人能消掉的抱怨，而抱怨会训练人忽略它。
  const flagged = new Set(auditIndexRows(index).map((x) => x.slug))
  const inconsistentRows = index.rows.filter((r) => flagged.has(r.slug) && r.dataHash === dataHash)
  // 默认重判。放在**新候选之前**：它们本来就在台账里（多数已 accepted），
  // 让它们先进去冗余池，新候选才是"相对既有一切"去重的那一个。
  const refresh = opts.refreshStale ?? true
  const staleSpecs = refresh ? [...staleRows, ...inconsistentRows].map(specFromRow) : []
  const specs = [...staleSpecs, ...generateFactorBatch(index.rows.map((r) => r.slug), count, windows)]

  // 候选空间余量。用**同一份展开器**把整个空间列出来（只做字符串拼接，
  // 490 格级别代价可忽略），所以 total 不会与真实可产出数量漂移 ——
  // 各算一份的代价是本项目反复付过的那种"两个唯一来源"缺陷。
  const allSlugs = generateFactorBatch([], Number.MAX_SAFE_INTEGER, windows).map((s) => s.slug)
  const known = new Set(index.rows.map((r) => r.slug))
  const used = allSlugs.filter((s) => known.has(s)).length
  const space = { total: allSlugs.length, used, remaining: allSlugs.length - used, windows: [...windows] }
  // ★ 合成**一批**评价，不是两次调用：去冗余池只在一次批内共享。
  //   拆成两次会让新旧候选各自建池，同一个事实就出现了两份实现。
  const batch = evaluateFactorBatch(specs, candles, origin, dataHash, th)

  const now = new Date().toISOString()
  const rows = batch.entries.map((e, i) => rowFrom(specs[i], e, origin, dataHash, now))
  const byGate: Record<string, number> = {}
  for (const r of rows) {
    if (r.state === 'accepted') continue
    byGate[r.gate] = (byGate[r.gate] ?? 0) + 1
  }

  const written = !opts.dryRun
  if (written) {
    atomicWriteJson(indexPath, upsertRows(index, rows, th))
  }

  return {
    origin,
    dataHash,
    bars: candles.length,
    specs: specs.length,
    refreshed: staleSpecs.length,
    accepted: batch.accepted,
    rejected: batch.rejected,
    unverifiable: batch.unverifiable,
    staleInIndex: staleRows.length + inconsistentRows.length,
    byGate,
    space,
    rows,
    batch,
    indexPath,
    written,
  }
}

export interface GateReachability {
  reachable: boolean
  reason: string
  bars: number
  minBars: number
}

/**
 * 「这道门在这份数据上有没有可能给出通过？」—— 启动期自检。
 *
 * 带阈值的闸门有一个隐蔽的失效方式：**它永远不可能通过**。
 * 例如 `minBars` 设成 5000，而真实历史只有 2880 根 —— 于是每个因子
 * 都被判 `unverifiable`，生产线看着在跑、台账一直在长，却永远不会
 * 产生一个"通过"。不报错、不崩、没有任何日志指向真因。
 *
 * 所以这里把「阈值 vs 实际数据规模」这条不等式显式检查一次：
 * 历史存在却太短 → 直接抛（这是配置矛盾，不该带着它跑）；
 * 历史不存在 → 返回不可达并说明原因（这是环境缺失，可以跑，但结论只能是不放行）。
 *
 * 注意这不是"放宽阈值就完事"：真因是**证据规模不够**，
 * 修法是攒更长的历史（`npm run data:fetch`），不是把门槛调低。
 */
export function checkGateReachable(
  symbol = 'BTCUSDT',
  th: FactorGateThresholds = DEFAULT_FACTOR_GATE,
  barMinutes = 15,
): GateReachability {
  const ev = loadEvidence(symbol, barMinutes)
  if (ev.origin !== 'history') {
    return {
      reachable: false,
      reason: `${symbol} 没有真实历史数据集，因子门只会给出 unverifiable（这是正确行为，不是故障）`,
      bars: ev.bars,
      minBars: th.minBars,
    }
  }
  if (ev.bars < th.minBars) {
    throw new Error(
      `因子门在此数据上永远不可能通过：真实历史 ${ev.bars} 根 < minBars ${th.minBars}。` +
        `要解锁只有两条路：拉更长历史（npm run data:fetch），或明确降低 minBars 并承认证据更弱 —— 不要默默把它调低。`,
    )
  }
  return { reachable: true, reason: `真实历史 ${ev.bars} 根 ≥ minBars ${th.minBars}`, bars: ev.bars, minBars: th.minBars }
}

/** 台账概况，供语音/面板做三态披露用。 */
export interface FactorIndexSummary {
  available: boolean
  total: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 判决与自身指标**自相矛盾**的行数（判定器升级后遗留的陈旧判决）。 */
  inconsistent: number
  /** 上面那些行的具体说明；没有则 null。 */
  inconsistentReason: string | null
  /** 台账里的判决是在真实历史上做出的比例（0..1）。 */
  historyShare: number
  updatedAt: string | null
  reason: string
}

export function factorIndexSummary(path = defaultIndexPath()): FactorIndexSummary {
  const { index, damaged } = readFactorIndex(path)
  if (damaged) {
    return {
      available: false,
      total: 0,
      accepted: 0,
      rejected: 0,
      unverifiable: 0,
      inconsistent: 0,
      inconsistentReason: null,
      historyShare: 0,
      updatedAt: null,
      reason: damaged,
    }
  }
  if (index.rows.length === 0) {
    return {
      available: false,
      total: 0,
      accepted: 0,
      rejected: 0,
      unverifiable: 0,
      inconsistent: 0,
      inconsistentReason: null,
      historyShare: 0,
      updatedAt: null,
      reason: '因子台账还是空的，生产线还没有跑过任何一批',
    }
  }
  const accepted = index.rows.filter((r) => r.state === 'accepted').length
  const unverifiable = index.rows.filter((r) => r.state === 'unverifiable').length
  const onHistory = index.rows.filter((r) => r.origin === 'history').length
  // 陈旧判决必须**说出来**：它们长得和正常判决一模一样，不讲出来就没人会去看。
  const inc = auditIndexRows(index)
  const incReason =
    inc.length > 0
      ? `其中 ${inc.length} 条是判定器升级前写入的陈旧判决（指标与结论自相矛盾）：` +
        inc.slice(0, 3).map((x) => `${x.slug} 记着 ${x.actual}、应为 ${x.expected}`).join('；') +
        (inc.length > 3 ? ` 等 ${inc.length} 条` : '')
      : null
  return {
    available: true,
    total: index.rows.length,
    accepted,
    rejected: index.rows.length - accepted - unverifiable,
    unverifiable,
    inconsistent: inc.length,
    inconsistentReason: incReason,
    historyShare: index.rows.length > 0 ? onHistory / index.rows.length : 0,
    updatedAt: index.updatedAt,
    reason:
      `台账 ${index.rows.length} 条，其中 ${onHistory} 条在真实历史上判决` + (incReason ? `；${incReason}` : ''),
  }
}
