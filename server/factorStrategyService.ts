/**
 * 因子 → 策略生产的接线层。
 *
 * ══ 它解决的最后一个断点 ═══════════════════════════════════════════════
 * 因子层到上一轮为止的终点是「台账里有一行 accepted」。那一行**不会做任何事**：
 * 提案引擎构造候选池时走的是 `buildCandidateSet()`（12 个手写策略网格），
 * 跟因子台账毫无关系。于是「因子批量生产达标」这件事在生产上是**不可见的** ——
 * 系统照旧只搜它那 12 个老朋友，因子台账在磁盘上安静地长。
 *
 * 本模块把这条线接上，接法只有一处：把台账里 **state=accepted** 的行
 * 重建成真正的 `Strategy` 实例，并进候选池。
 *
 * ══ ★ 最要紧的一条：判决的时效性 ═══════════════════════════════════════
 * 台账里的每一行都带 `dataHash`（判决时那份行情的指纹）。若**现在**的行情
 * 与它不同（换了币种、拉长了历史、数据被重下），那一行的结论就不再适用。
 * 这不是理论风险：本轮刚把真实历史从 2,880 根扩到 35,040 根，
 * 所有旧行情的判决**同时**作废 —— 而台账上那行 accepted 看起来毫无异常。
 * `factorService` 只负责把指纹**记下来**，比对必须发生在读的一侧
 * （就是这里），否则记了也没人看。判据 11：读路径静默陈旧。
 *
 * 所以这里有两道时效性检查：
 *   ① `screenAcceptedFactors` 筛查时：指纹不符 ⇒ 该行判 `unverifiable`（不重算，因为它已过时）
 *   ② `buildAcceptedFactorStrategies` 供提案引擎取用时：指纹不符 ⇒ **拒绝进池**并说出来
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FACTOR_STRATEGY_GATE,
  factorTimingStrategy,
  screenFactorStrategy,
} from '../src/engine/index.ts'
import type {
  Candle,
  FactorOrigin,
  FactorStrategyConfig,
  FactorStrategyScreenResult,
  FactorStrategyThresholds,
  Strategy,
} from '../src/engine/index.ts'
import { DEFAULT_FACTOR_STRATEGY_WF, DEFAULT_EXEC } from '../src/engine/index.ts'
import { loadEvidence } from './evidence.ts'
import { atomicWriteJson } from './atomicWrite.ts'
import { defaultIndexPath, readFactorIndex, specFromRow } from './factorService.ts'
import type { FactorIndexRow } from './factorService.ts'

export const FACTOR_STRATEGY_INDEX_VERSION = 'factor-strategy-index-v1'

export interface FactorStrategyIndexRow {
  slug: string
  /** 交易方向。**由样本内 IC 符号决定**，null = 连方向都定不了。 */
  sign: 1 | -1 | null
  state: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  reason: string
  /** 样本内 IC（第一折训练窗）。 */
  trainIc: number | null
  origin: FactorOrigin
  /** 因子台账那行判决所依据的行情指纹。 */
  factorDataHash: string
  /** 本次筛查所用行情的指纹。 */
  screenDataHash: string
  /** 两者是否一致。**false 表示这行的判决已经过时。** */
  dataHashMatch: boolean
  folds: number
  worstFoldReturnPct: number | null
  /**
   * 最差折的**毛**收益（费用与滑点归零）。与净收益配对读才构成归因：
   * 毛正净负 ⇒ 信号有方向、被成本吃掉（该降换手）；毛本身就负 ⇒ 方向不成立。
   */
  worstFoldGrossReturnPct: number | null
  /** 各折成本拖累均值（毛 − 净）。换手越高它越大。 */
  costDragPct: number | null
  /**
   * 各折**毛**收益的均值。必须与 `worstFoldGrossReturnPct` 并列 ——
   * 15 轮实测这两个统计量在同一批数据上给出**相反**的归因结论。
   */
  meanFoldGrossReturnPct: number | null
  /**
   * 每笔成交的毛边际 / 成本（bps，各折均值）。**"该换因子族还是该降成本"就靠这一对。**
   * null = 没有任何成交，每笔口径建不起来。
   */
  meanGrossBpsPerFill: number | null
  meanCostBpsPerFill: number | null
  /** 各折成交笔数均值 —— 上面那两个 bps 的分母来源，一起报才可复核。 */
  meanFillsPerFold: number | null
  winRate: number | null
  closedTrades: number
  signAgreement: number | null
  /** 是否跑过"反方向也过吗"的门质量诊断（只在临放行时才跑）。 */
  reverseChecked: boolean
  bothDirectionsPass: boolean
  lastEvaluatedAt: string
}

export interface FactorStrategyIndex {
  version: typeof FACTOR_STRATEGY_INDEX_VERSION
  thresholds: FactorStrategyThresholds
  config: FactorStrategyConfig
  rows: FactorStrategyIndexRow[]
  updatedAt: string
}

export function defaultStrategyIndexPath(cwd = process.cwd()): string {
  return join(cwd, 'data', 'factors', 'strategies.json')
}

export function emptyStrategyIndex(th: FactorStrategyThresholds = DEFAULT_FACTOR_STRATEGY_GATE): FactorStrategyIndex {
  return {
    version: FACTOR_STRATEGY_INDEX_VERSION,
    thresholds: th,
    config: defaultStrategyConfig(),
    rows: [],
    updatedAt: new Date(0).toISOString(),
  }
}

export function defaultStrategyConfig(over: Partial<FactorStrategyConfig> = {}): FactorStrategyConfig {
  const wf = DEFAULT_FACTOR_STRATEGY_WF
  return {
    trainBars: over.trainBars ?? wf.trainBars,
    testBars: over.testBars ?? wf.testBars,
    barMinutes: over.barMinutes ?? 15,
    entry: over.entry ?? wf.entry,
    exit: over.exit ?? wf.exit,
    normWindow: over.normWindow ?? wf.normWindow,
    allowShort: over.allowShort ?? wf.allowShort,
    // 复用 DEFAULT_EXEC，不另写一份字面量：实测那两份逐字节相同，
    // 而"两份相同的常量"唯一的演化方向就是**某天只改其中一份**。
    exec: over.exec ?? DEFAULT_EXEC,
  }
}

/** 读索引。损坏不抛，标出来 —— 与因子台账同一立场。 */
export function readStrategyIndex(path: string): { index: FactorStrategyIndex; damaged: string | null } {
  if (!existsSync(path)) return { index: emptyStrategyIndex(), damaged: null }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as FactorStrategyIndex
    if (!raw || !Array.isArray(raw.rows)) return { index: emptyStrategyIndex(), damaged: '索引结构不合法（rows 不是数组）' }
    return { index: raw, damaged: null }
  } catch (e) {
    return { index: emptyStrategyIndex(), damaged: `索引解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 筛查
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenOptions {
  cwd?: string
  factorIndexPath?: string
  strategyIndexPath?: string
  symbol?: string
  barMinutes?: number
  thresholds?: FactorStrategyThresholds
  config?: Partial<FactorStrategyConfig>
  /** 注入 K 线与来源，供测试构造合成/样本不足等路径。 */
  candles?: Candle[]
  origin?: FactorOrigin
  dataHash?: string
  /** 只算不落盘。烟测必须用 —— 否则每跑一次测试都改台账。 */
  dryRun?: boolean
  /** 最多筛查多少个因子（按 slug 排序取前 N）。默认不限。 */
  limit?: number
  /**
   * **只筛这批 slug**（可选）。给定之后 `limit` 是在这批内部再截断。
   *
   * ★ 迭代挖掘必须用它：否则每轮筛的都是"排序最前的那几条"，
   *   新扩出来的因子永远轮不到 —— 而输出看起来像是"换了几组结果都一样"。
   */
  slugs?: readonly string[]
}

export interface ScreenResult {
  origin: FactorOrigin
  dataHash: string
  bars: number
  /** 因子台账里 state=accepted 的行数。 */
  candidates: number
  /** 因指纹不符而直接判过时的行数。 */
  stale: number
  accepted: number
  rejected: number
  unverifiable: number
  byGate: Record<string, number>
  rows: FactorStrategyIndexRow[]
  results: FactorStrategyScreenResult[]
  strategyIndexPath: string
  written: boolean
}

function rowFromResult(
  res: FactorStrategyScreenResult,
  src: FactorIndexRow,
  screenDataHash: string,
  now: string,
): FactorStrategyIndexRow {
  const rec = res.receipt
  return {
    slug: res.slug,
    sign: res.sign,
    state: res.verdict.outcome,
    gate: res.verdict.gate,
    reason: res.verdict.reason,
    trainIc: res.trainIc,
    origin: src.origin,
    factorDataHash: src.dataHash,
    screenDataHash,
    dataHashMatch: src.dataHash === screenDataHash,
    folds: rec ? rec.folds.length : 0,
    worstFoldReturnPct: rec ? rec.worstFoldReturnPct : null,
    worstFoldGrossReturnPct: rec ? rec.worstFoldGrossReturnPct : null,
    costDragPct: rec ? rec.costDragPct : null,
    meanFoldGrossReturnPct: rec ? rec.meanFoldGrossReturnPct : null,
    meanGrossBpsPerFill: rec ? rec.meanGrossBpsPerFill : null,
    meanCostBpsPerFill: rec ? rec.meanCostBpsPerFill : null,
    meanFillsPerFold: rec ? rec.meanFillsPerFold : null,
    winRate: rec ? rec.winRate : null,
    closedTrades: rec ? rec.closedTrades : 0,
    signAgreement: rec ? rec.signAgreement : null,
    reverseChecked: res.reverseChecked,
    bothDirectionsPass: rec ? rec.bothDirectionsPass : false,
    lastEvaluatedAt: now,
  }
}

/**
 * 对台账里所有 **accepted** 因子做策略层筛查。
 *
 * ★ 只查 accepted：因子层拒掉的东西不需要在这里再拒一次。
 *   这个过滤是"因子层 → 策略层"的接口语义，不是优化。
 *
 * ★ 指纹不符的行**不重算**，直接判过时。理由：重算出来的结论虽然更新，
 *   但它回答的是"在新数据上这个因子还行吗"，那是**重跑因子生产线**该做的事。
 *   在这里顺手重算会让两层的数据基线悄悄分开 —— 正是上一轮修掉的那个缺陷。
 */
export function screenAcceptedFactors(opts: ScreenOptions = {}): ScreenResult {
  const cwd = opts.cwd ?? process.cwd()
  const factorIndexPath = opts.factorIndexPath ?? defaultIndexPath(cwd)
  const strategyIndexPath = opts.strategyIndexPath ?? defaultStrategyIndexPath(cwd)
  const th = opts.thresholds ?? DEFAULT_FACTOR_STRATEGY_GATE
  const cfg = defaultStrategyConfig(opts.config)

  const injected = opts.candles !== undefined
  let candles: Candle[]
  let origin: FactorOrigin
  let dataHash: string
  if (injected) {
    candles = opts.candles as Candle[]
    origin = opts.origin ?? 'injected'
    dataHash = opts.dataHash ?? `injected:${candles.length}`
  } else {
    const ev = loadEvidence(opts.symbol ?? 'BTCUSDT', opts.barMinutes ?? 15)
    candles = ev.candles
    origin = ev.origin
    dataHash = ev.dataHash
  }

  const { index } = readFactorIndex(factorIndexPath)
  let acceptedRows = index.rows.filter((r) => r.state === 'accepted').sort((a, b) => a.slug.localeCompare(b.slug))
  // ★ 「只筛这一批」。
  //
  //   加这个选项是因为**迭代挖掘里实测抓到一个假进展**：调度器每轮都调
  //   `screenAcceptedFactors({limit})`，而 `limit` 的语义是"按 slug 排序取前 N 条" ——
  //   于是第 2、3 轮筛的**还是第 1 轮那批**，新扩出来的因子一条都没被筛到。
  //   表现是每轮输出逐字相同（"筛了 8 条，过门 0、被拒 4、证据不足 4"），
  //   看起来像"换了几组，结果都差不多"，而真相是**根本没换**。
  //   这条与判据 6 同源：一个"别的修复顺带也能造成"的绿，等于假绿。
  if (opts.slugs !== undefined) {
    const want = new Set(opts.slugs)
    acceptedRows = acceptedRows.filter((r) => want.has(r.slug))
  }
  const picked = opts.limit !== undefined ? acceptedRows.slice(0, Math.max(0, opts.limit)) : acceptedRows

  const now = new Date().toISOString()
  const rows: FactorStrategyIndexRow[] = []
  const results: FactorStrategyScreenResult[] = []
  let stale = 0

  for (const r of picked) {
    // ── 时效性：指纹不符 ⇒ 过时（不重算） ────────────────────────────
    if (r.dataHash !== dataHash) {
      stale += 1
      rows.push({
        slug: r.slug,
        sign: null,
        state: 'unverifiable',
        gate: 'stale',
        reason:
          `因子台账里这条判决依据的行情指纹是 ${r.dataHash.slice(0, 12)}…，` +
          `而当前行情是 ${dataHash.slice(0, 12)}… —— 两者不同，旧结论不再适用。` +
          `要更新它请重跑因子生产线（npm run factors:run），不是在这里顺手重算`,
        trainIc: r.icMean5,
        origin: r.origin,
        factorDataHash: r.dataHash,
        screenDataHash: dataHash,
        dataHashMatch: false,
        folds: 0,
        worstFoldReturnPct: null,
        worstFoldGrossReturnPct: null,
        costDragPct: null,
        // 过时的行连指标都没有 —— 一律 null，**不写 0**：0 会被读成"测出来是 0"，null 才是"没测"。
        meanFoldGrossReturnPct: null,
        meanGrossBpsPerFill: null,
        meanCostBpsPerFill: null,
        meanFillsPerFold: null,
        winRate: null,
        closedTrades: 0,
        signAgreement: null,
        reverseChecked: false,
        bothDirectionsPass: false,
        lastEvaluatedAt: now,
      })
      continue
    }
    const res = screenFactorStrategy(specFromRow(r), candles, injected ? origin : r.origin, {
      thresholds: th,
      config: cfg,
    })
    results.push(res)
    rows.push(rowFromResult(res, r, dataHash, now))
  }

  const byGate: Record<string, number> = {}
  for (const r of rows) {
    if (r.state === 'accepted') continue
    byGate[r.gate] = (byGate[r.gate] ?? 0) + 1
  }
  const accepted = rows.filter((r) => r.state === 'accepted').length
  const unverifiable = rows.filter((r) => r.state === 'unverifiable').length

  const written = !opts.dryRun
  if (written) {
    atomicWriteJson(strategyIndexPath, {
      version: FACTOR_STRATEGY_INDEX_VERSION,
      thresholds: th,
      config: cfg,
      rows: [...rows].sort((a, b) => a.slug.localeCompare(b.slug)),
      updatedAt: now,
    } satisfies FactorStrategyIndex)
  }

  return {
    origin,
    dataHash,
    bars: candles.length,
    candidates: picked.length,
    stale,
    accepted,
    rejected: rows.length - accepted - unverifiable,
    unverifiable,
    byGate,
    rows,
    results,
    strategyIndexPath,
    written,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 消费侧：给提案引擎的候选池
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildStrategiesResult {
  strategies: Strategy[]
  /** 没能进池的，每条都要说清为什么 —— 静默丢弃会让"因子接进生产"变成一句空话。 */
  skipped: Array<{ slug: string; reason: string }>
  dataHash: string
  origin: FactorOrigin
  bars: number
}

/**
 * 取"当下可用"的因子策略，供候选池使用。
 *
 * ★ 这是**纯读**：不重跑筛查（单因子要跑 5 折回测，几十秒，塞进提案路径不可接受）。
 *   代价是必须自己做时效性校验 —— 台账里的结论可能是在另一份行情上得出的。
 *   指纹不符就**拒绝进池**，并把它放进 `skipped` 让人看得见。
 *
 *   放在这里而不是筛查处的理由：筛查时数据是新鲜的，
 *   真正危险的是**后来**数据变了而台账没跟着变 —— 那一刻没人会来跑筛查。
 */
export function buildAcceptedFactorStrategies(opts: { cwd?: string; indexPath?: string; barMinutes?: number } = {}): BuildStrategiesResult {
  const cwd = opts.cwd ?? process.cwd()
  const indexPath = opts.indexPath ?? defaultStrategyIndexPath(cwd)
  const ev = loadEvidence('BTCUSDT', opts.barMinutes ?? 15)
  const { index, damaged } = readStrategyIndex(indexPath)
  const skipped: Array<{ slug: string; reason: string }> = []
  const strategies: Strategy[] = []
  // 因子定义**只能**从因子台账读回来 —— 不许从 slug 反推（理由见文件下方 specFromRow）。
  const { index: factorIndex, damaged: factorDamaged } = readFactorIndex(defaultIndexPath(cwd))
  const factorBySlug = new Map(factorIndex.rows.map((r) => [r.slug, r]))

  if (damaged || factorDamaged) {
    const why = [damaged, factorDamaged].filter((x): x is string => Boolean(x)).join('；')
    return { strategies, skipped: [{ slug: '*', reason: `台账不可读：${why}` }], dataHash: ev.dataHash, origin: ev.origin, bars: ev.bars }
  }

  for (const r of index.rows) {
    if (r.state !== 'accepted') continue
    if (r.sign !== 1 && r.sign !== -1) {
      skipped.push({ slug: r.slug, reason: '台账里没有可用方向（sign 为空）' })
      continue
    }
    if (r.screenDataHash !== ev.dataHash) {
      skipped.push({
        slug: r.slug,
        reason: `行情指纹已变（台账 ${r.screenDataHash.slice(0, 12)}… vs 当前 ${ev.dataHash.slice(0, 12)}…），判决过时，需重跑筛查`,
      })
      continue
    }
    const src = factorBySlug.get(r.slug)
    if (!src) {
      skipped.push({ slug: r.slug, reason: '因子台账里找不到该 slug 的定义（策略台账比因子台账旧？）' })
      continue
    }
    const spec = specFromRow(src)
    strategies.push(
      factorTimingStrategy({
        slug: r.slug,
        spec,
        sign: r.sign,
        entry: index.config.entry,
        exit: index.config.exit,
        normWindow: index.config.normWindow,
      }),
    )
  }
  return { strategies, skipped, dataHash: ev.dataHash, origin: ev.origin, bars: ev.bars }
}

/**
 * ★ 因子定义**只能**从因子台账读，**不许**从 slug 反推。
 *
 * 反推看着可行（slug 形如 `base_transform_window`），但它是错的：
 * `base` 与 `transform` 里**都**含下划线（`price_volume_corr`、`vol_scaled`），
 * 所以 `price_volume_corr_vol_scaled_4` 会被拆成
 * `base=price_volume_corr_vol` + `transform=scaled` —— 一个不存在的因子。
 * 更坏的是它**不报错**：构造出来的策略照样能跑、能回测、能给出数字，
 * 只是算的不是台账里那个因子（判据 17 那一族：没读懂被伪装成读懂了）。
 * slug 是给人看的键，不是可解析的编码。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 概况（供语音 / 面板三态披露）
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorStrategySummary {
  available: boolean
  total: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 其中有几个**当下可用**（指纹与当前行情一致）。 */
  usableNow: number
  /** 因行情指纹变化而失效的行数。 */
  stale: number
  updatedAt: string | null
  reason: string
}

export function factorStrategySummary(path = defaultStrategyIndexPath()): FactorStrategySummary {
  const { index, damaged } = readStrategyIndex(path)
  const ev = loadEvidence('BTCUSDT', 15)
  if (damaged) {
    return { available: false, total: 0, accepted: 0, rejected: 0, unverifiable: 0, usableNow: 0, stale: 0, updatedAt: null, reason: damaged }
  }
  if (index.rows.length === 0) {
    return {
      available: false,
      total: 0,
      accepted: 0,
      rejected: 0,
      unverifiable: 0,
      usableNow: 0,
      stale: 0,
      updatedAt: null,
      reason: '还没有对任何因子做过策略层筛查',
    }
  }
  const accepted = index.rows.filter((r) => r.state === 'accepted')
  const unverifiable = index.rows.filter((r) => r.state === 'unverifiable').length
  const stale = index.rows.filter((r) => r.screenDataHash !== ev.dataHash).length
  const usableNow = accepted.filter((r) => r.screenDataHash === ev.dataHash).length
  return {
    available: true,
    total: index.rows.length,
    accepted: accepted.length,
    rejected: index.rows.length - accepted.length - unverifiable,
    unverifiable,
    usableNow,
    stale,
    updatedAt: index.updatedAt,
    reason:
      `筛查 ${index.rows.length} 个已接受因子，${accepted.length} 个通过策略门，` +
      // 这个字符串会同时出现在**面板**和**语音**里，所以不许带 Markdown 记号：
      // 面板上 `**当前**` 会原样显示成两个星号（本轮实测截图里就是这么出现的），
      // 语音里会被念成"星号"。判据 16：它会把用户引向"这页面是不是坏了"，
      // 而真正该被读到的是"有几个能用"。
      `其中 ${usableNow} 个在当前行情上仍然有效` +
      (stale > 0 ? `（${stale} 个已因行情换版失效，需重跑筛查）` : ''),
  }
}
