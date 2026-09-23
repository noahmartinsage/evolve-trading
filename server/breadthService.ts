/**
 * 横截面（breadth）生产层 —— 把 `src/engine/crossSection.ts` 的引擎接到真实数据上。
 *
 * ══ 它补的是什么 ═══════════════════════════════════════════════════════
 * 引擎（对齐面板 / 池化 IC / 多空回测 / 三态判决）早就写完了，
 * `data/history/` 里也**已经有 10 个品种 × 35,040 根**的真实 K 线，
 * 但 `crossSection.ts` 在全仓库只有一个引用：`src/engine/index.ts` 的 re-export。
 *
 * 也就是说它是一个**没有生产入口的模块**（判据 10：只有测试/探针可达 ≠ 可达）。
 * 十七轮以来「策略层过门 0」这个结论一直挂在"唯一钥匙是 breadth"上，
 * 而那条钥匙从来没被插进锁里 —— 因为没有任何一条路径能把面板跑出来。
 *
 * 本模块就是那条路径，结构与 `factorService` 一致：
 *
 *     读历史 → 对齐面板 → 逐因子算序列 → 池化 IC + 横截面回测 → 过闸门 → 落台账
 *
 * ══ 三件刻意不做的事 ═══════════════════════════════════════════════════
 * ① **不回落合成数据**。
 *    `loadEvidence`（单品种）在找不到历史文件时回落到 GBM 合成行情，
 *    并靠 `origin` 字段让调用方分辨。那个设计对**单品种**是对的 ——
 *    但横截面**不能**这么干：10 个合成品种之间没有任何真实相关性，
 *    在它们上面算出来的"横截面 IC"会是一个看着完全正常的数字，
 *    而它测的是随机数生成器。所以这里**只认真历史**，缺了就报缺、并拒绝下结论。
 *    ★ 这不是"同一动作的第二条路径"（判据 8）：单品种证据 vs 多品种面板
 *      是两个不同的业务动作，前者允许降级、后者不允许。
 *
 * ② **不自己造候选因子**。候选来自因子台账里 `state === 'accepted'` 的那批 ——
 *    台账是因子结论的唯一事实源。想试新因子就去跑 `npm run factors:run`。
 *
 * ③ **不发明成本口径**。费率与滑点取自 `DEFAULT_EXEC`（与策略层回测同一份），
 *    换成任何"更乐观的假设"都会让这里的"净为正"变成一句不能兑现的话。
 *
 * ══ 台账为什么必须记面板指纹 ═══════════════════════════════════════════
 * 一条"通过"如果不知道自己是在哪些品种、哪段时间、哪个 horizon 上得出的，
 * 它就不能被复核，也不能在数据变化后自动作废。所以指纹里带上
 * 品种集 + 面板 bar 数 + 各品种 contentHash + topK/horizon/step，
 * 任何一项变了 ⇒ 旧结论标记为过时（与因子台账的 `stale` 同一立场）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { getHeapStatistics } from 'node:v8'
import { join } from 'node:path'
import { DEFAULT_EXEC } from '../src/engine/types.ts'
import { factorSeries, type FactorSpec } from '../src/engine/factorEval.ts'
import type { Candle } from '../src/engine/types.ts'
import type { HistoryFile } from '../src/engine/history.ts'
import {
  DEFAULT_CROSS_SECTION_GATE,
  alignPanel,
  crossSectionBacktest,
  judgeCrossSection,
  pooledIc,
  projectFactor,
  type CrossSectionConfig,
  type CrossSectionResult,
  type CrossSectionThresholds,
  type CrossSectionVerdict,
  type Panel,
  type PanelInput,
  type PooledIcResult,
} from '../src/engine/crossSection.ts'
import { atomicWriteJson } from './atomicWrite.ts'
import { defaultIndexPath, readFactorIndex, specFromRow } from './factorService.ts'

/**
 * ★ v1 → v2 的原因值得记一笔：v1 的 `config` 字段在多持有期并存时会被读成
 * "这些行的配置"（实际只是最近一次），而且 v1 的合并逻辑**只留一个持有期**。
 * 改语义就换版本号，让旧文件走"损坏 ⇒ 重建"这条路（`readBreadthIndex` 会
 * 把 `damagedFrom` 写进新台账）——**不许**让旧文件按新语义被静默读进来。
 */
export const BREADTH_INDEX_VERSION = 'breadth-index-v2'

export function defaultBreadthIndexPath(cwd = process.cwd()): string {
  return join(cwd, 'data', 'breadth', 'index.json')
}

export function defaultHistoryDir(cwd = process.cwd()): string {
  return join(cwd, 'data', 'history')
}

// ─────────────────────────── 配置 ───────────────────────────

export interface BreadthConfig {
  /** 每边持几个（多头 = 因子最高 topK，空头 = 最低 topK）。 */
  topK: number
  /** 持有多少根 bar 换仓。 */
  horizon: number
  /** 每几根 bar 调一次仓。默认 = horizon ⇒ 横截面不重叠。 */
  step: number
  /**
   * **单边**费率（bps）。默认取 `DEFAULT_EXEC.takerFeeBps`。
   * ★ 别在这里传更小的数：市价单手往返 16 bps 是这套系统的成本现实，
   *   把它调小只是让判决好看，不会让交易所少收钱。
   */
  feeBps: number
  /** **单边**滑点（bps）。默认取 `DEFAULT_EXEC.slippageBps`。 */
  slipBps: number
  /**
   * 训练段占面板的比例（默认 0.6）。
   *
   * ★ 它存在的唯一理由是**把"定方向"和"评表现"分到两段数据上**：
   *   同一批数据上既定方向又评表现，反向的毛为正几乎是恒等式
   *   （`毛_rev ≈ −毛`），那不是证据。与策略层 `determineSign` 用训练集
   *   定方向、样本外逐折验证是同一个立场。
   */
  trainShare: number
}

/**
 * 默认配置。★ 默认值刻意"不利"：止步于 `DEFAULT_EXEC` 的市价单成本，
 * 不做 maker 假设 —— maker-only 单独量过（差 4 倍），那是另一条待裁决的路，
 * 不该偷偷混进 breadth 的第一步里。
 */
export function defaultBreadthConfig(over: Partial<BreadthConfig> = {}): BreadthConfig {
  const horizon = over.horizon ?? 12
  return {
    topK: over.topK ?? 3,
    horizon,
    step: over.step ?? horizon,
    feeBps: over.feeBps ?? DEFAULT_EXEC.takerFeeBps,
    slipBps: over.slipBps ?? DEFAULT_EXEC.slippageBps,
    trainShare: over.trainShare ?? 0.6,
  }
}

export function toCrossSectionConfig(cfg: BreadthConfig, range: { from: number; to: number }, sign: 1 | -1): CrossSectionConfig {
  return {
    topK: cfg.topK,
    horizon: cfg.horizon,
    step: cfg.step,
    feeBps: cfg.feeBps,
    slipBps: cfg.slipBps,
    sign,
    range,
  }
}

/** 训练段 / 检验段的分界（k 下标）。返回半开区间，调用方两次都从这里取，避免各算各的。 */
export function splitRanges(bars: number, trainShare: number): { train: { from: number; to: number }; test: { from: number; to: number } } {
  const cut = Math.max(0, Math.min(Math.floor(bars * trainShare), bars))
  return { train: { from: 0, to: cut }, test: { from: cut, to: bars } }
}

/** 单边成本（bps）= 费 + 滑。全换仓时一轮 = 往返 = 2×它。 */
export function oneWayCostBps(cfg: BreadthConfig): number {
  return cfg.feeBps + cfg.slipBps
}

// ─────────────────────────── 取数（只认真历史）───────────────────────────

export interface PanelSymbol {
  symbol: string
  bars: number
  kept: number
  from: number
  to: number
  contentHash: string
  file: string
}

export interface BracketedPanel {
  panel: Panel
  /**
   * 与 `panel.symbols` **同序**的原始 K 线。
   *
   * ★ 为什么要把 K 线一起带出来、而不是让下游按符号去重新读文件：
   *   ① 一个因子要投影 10 个品种，一次跑 N 个因子就是 N×10 次 `JSON.parse`
   *      一个 2.7MB 的文件 —— 这是实打实的 N 倍浪费；
   *   ② 更要紧的是**两次读之间文件可能变**（横截面跑一轮要几十秒），
   *      那样面板与因子就来自两份不同的数据，而结果"看着完全正常"。
   *      带上原始数组 ⇒ 面板与因子在内存里同源。
   */
  candles: Candle[][]
  /** 每个品种的来源事实 —— 缺一个都要能指名道姓。 */
  sources: PanelSymbol[]
  /**
   * 被请求但**没找到**的品种。
   *
   * ★ 它是这个模块最重要的一个观测量：面板"少一个品种"与"全都在"
   *   算出来的 IC 都会是一个看着正常的数，唯一的区别就在这里。
   */
  missing: string[]
  /** 实际用到的品种数（panels.symbols.length 的别名，避免下游各数各的）。 */
  symbols: number
  /**
   * **谁把公共窗口拉短了** —— 柱子最少的那些品种。
   *
   * ★★ 为什么必须有这个观测量（2026-09-22 抓到的静默失效）：
   *   `listHistorySymbols` 返回目录里**全部** `_15m.json`。于是往 `data/history`
   *   里多放一个只有 30 天的品种，整个面板的交集就从 **36,000 根塌成 2,880 根** ——
   *   而面板会报出**更多**品种（"品种从 10 涨到 44"），看起来像进步。
   *   品种数上涨、证据量下跌 12 倍，输出里没有任何一处会红。
   *   ⇒ 「多了一个品种」与「少了一个数量级的证据」在结果上长得一模一样。
   *
   *   所以这里把**约束者**指名出来。它不是"少品种"（那是 `missing`），
   *   而是"品种都在，但其中一个把大家绑在了很短的一段上"。
   */
  binding: string[]
  /** 各品种柱子数的最小/最大值。两者差得多 ⇒ 面板被短序列绑住了。 */
  barsMin: number
  barsMax: number
  /** 合成/注入来源。生产路径永远是 'history'。 */
  origin: 'history' | 'injected'
}

/** 列出现有历史文件里可用的品种（不猜、不补，就是文件系统里真实存在的那些）。 */
export function listHistorySymbols(historyDir: string, barMinutes = 15): string[] {
  if (!existsSync(historyDir)) return []
  const suffix = `_${barMinutes}m.json`
  return readdirSync(historyDir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort()
}

export interface LoadPanelOptions {
  cwd?: string
  historyDir?: string
  barMinutes?: number
  /** 指定品种。缺省 = 目录里全部。指定的品种缺文件会被记进 `missing`。 */
  symbols?: string[]
  /** 注入（烟测用）。给了就完全不走文件系统。 */
  inputs?: PanelInput[]
  injectedHashes?: string[]
}

/**
 * 读多品种历史并对齐成面板。
 *
 * ★ 缺品种**不抛异常**：抛了会让调用方看到"崩了"，而真相是"少了一个品种"——
 *   二者指向的动作不同（修数据 vs 修代码）。缺哪个由 `missing` 带回，
 *   由调用方决定要不要下结论（`evaluateBreadth` 的处置是：不足以构成横截面时才拒）。
 */
export function loadBreadthPanel(opts: LoadPanelOptions = {}): BracketedPanel {
  const cwd = opts.cwd ?? process.cwd()
  const historyDir = opts.historyDir ?? defaultHistoryDir(cwd)
  const barMinutes = opts.barMinutes ?? 15

  if (opts.inputs) {
    return {
      panel: alignPanel(opts.inputs),
      candles: opts.inputs.map((x) => x.candles),
      sources: opts.inputs.map((x, i) => ({
        symbol: x.symbol,
        bars: x.candles.length,
        kept: 0, // 由 panel.coverage 统一填，见下
        from: x.candles[0]?.t ?? 0,
        to: x.candles[x.candles.length - 1]?.t ?? 0,
        contentHash: opts.injectedHashes?.[i] ?? `injected:${x.candles.length}`,
        file: '(injected)',
      })),
      missing: [],
      symbols: opts.inputs.length,
      binding: [],
      barsMin: Math.min(...opts.inputs.map((x) => x.candles.length)),
      barsMax: Math.max(...opts.inputs.map((x) => x.candles.length)),
      origin: 'injected',
    }
  }

  const requested = opts.symbols ?? listHistorySymbols(historyDir, barMinutes)
  const inputs: PanelInput[] = []
  const candles: Candle[][] = []
  const sources: PanelSymbol[] = []
  const missing: string[] = []

  for (const symbol of requested) {
    const file = join(historyDir, `${symbol}_${barMinutes}m.json`)
    if (!existsSync(file)) {
      missing.push(symbol)
      continue
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as HistoryFile
    const cs: Candle[] = Array.isArray(raw.candles) ? raw.candles : []
    if (cs.length === 0) {
      missing.push(symbol)
      continue
    }
    inputs.push({ symbol, candles: cs })
    candles.push(cs)
    sources.push({
      symbol,
      bars: cs.length,
      kept: 0,
      from: raw.meta?.from ?? cs[0].t,
      to: raw.meta?.to ?? cs[cs.length - 1].t,
      contentHash: raw.meta?.contentHash ?? '(无指纹)',
      file,
    })
  }

  const panel = alignPanel(inputs)
  // kept 从 panel.coverage 回填 —— 不在这里另算一遍（同一事实两份实现的下场是某天只改一处）。
  const keptBy = new Map(panel.coverage.map((c) => [c.symbol, c.kept]))
  for (const s of sources) s.kept = keptBy.get(s.symbol) ?? 0

  // ★ 指名"谁把窗口拉短了"：柱子数最少的那一批（容忍 ±1% 的抖动，那是各所开盘时间差）。
  const bars = sources.map((s) => s.bars)
  const barsMin = bars.length > 0 ? Math.min(...bars) : 0
  const barsMax = bars.length > 0 ? Math.max(...bars) : 0
  const binding = sources.filter((s) => s.bars <= barsMin * 1.01).map((s) => s.symbol).sort()

  return { panel, candles, sources, missing, symbols: inputs.length, binding, barsMin, barsMax, origin: 'history' }
}

/**
 * **面板身份**（只有"这些价格数据是什么"）。
 *
 * ★ 它和 `configKeyOf` 必须分开，因为两者的**失效语义完全不同**：
 *   · 面板变了 ⇒ 行内容与面板事实交叉矛盾 ⇒ 旧行**整体作废**；
 *   · 配置变了（换持有期 / 换 topK / 换成本）⇒ 面板没变，旧行**依然成立**，
 *     是**另一个格子**，必须**并存**。
 * 早先把两者拼成一个 `panelFingerprint` 直接当"要不要保留旧行"的判据，
 * 结果是：跑第二个持有期时，第一个持有期的行被当成"过时"删掉了 ——
 * 台账永远只装得下**一个**持有期，而验收点要看的正是**跨持有期的趋势**。
 * 一个字符串装了两件事，失效语义就被最粗的那件事接管了（判据 21）。
 */
export function panelKeyOf(p: BracketedPanel): string {
  return [
    p.origin,
    p.panel.symbols.join(','),
    String(p.panel.bars),
    String(p.panel.from),
    String(p.panel.to),
    p.sources.map((s) => s.contentHash).join(','),
  ].join('|')
}

/** **评估配置**（只有"怎么评"）。顺序必须与 `panelKeyOf` 之后的部分保持稳定。 */
export function configKeyOf(cfg: BreadthConfig, th: CrossSectionThresholds): string {
  return [
    `topK=${cfg.topK}`,
    `h=${cfg.horizon}`,
    `step=${cfg.step}`,
    `fee=${cfg.feeBps}`,
    `slip=${cfg.slipBps}`,
    `train=${cfg.trainShare}`,
    `minT=${th.minAbsT}`,
    `minSec=${th.minSections}`,
    `minWin=${th.minWinRate}`,
  ].join('|')
}

/**
 * 面板指纹 = 面板身份 + 评估配置。**行身份**用它（同一格重跑要覆盖），
 * 但"要不要保留旧行"**不能**用它 —— 那个判据是 `samePanel`。
 *
 * 任何一项变了旧结论即过时（与因子台账按 `dataHash` 判过时同一立场）。
 */
export function panelFingerprint(p: BracketedPanel, cfg: BreadthConfig, th: CrossSectionThresholds): string {
  return `${panelKeyOf(p)}|${configKeyOf(cfg, th)}`
}

/**
 * 两条指纹是不是**同一块面板**（忽略评估配置部分）。
 *
 * 单独抽成函数而不是在调用点写 `startsWith(prefix)`：`panelFingerprint` 的
 * 拼装顺序一旦被改，`startsWith` 会**静默**开始返回 false（旧行被悄悄丢掉，
 * 表现与当初那个 bug 一模一样，而且不报错）。抽成函数之后，
 * 烟测 `E9/E10` 可以直接把它钉在"同面板不同配置 ⇒ true / 不同面板 ⇒ false"上。
 */
export function samePanel(hashA: string, hashB: string): boolean {
  const cut = (s: string) => s.split('|topK=')[0] ?? s
  return cut(hashA) === cut(hashB)
}

// ─────────────────────────── 评估 ───────────────────────────

export interface BreadthRow {
  slug: string
  nameCn: string
  category: string
  base: string
  transform: string
  window: number
  /** 与面板指纹共用同一套配置，所以读台账能复现。 */
  horizon: number
  outcome: 'accepted' | 'rejected' | 'unverifiable'
  gate: string
  /** 逐条理由拼成一句（与因子台账的 `reason` 同构）。 */
  reason: string
  headline: string

  panelHash: string
  symbols: number
  panelBars: number
  topK: number

  /**
   * 排序方向。来自**训练段 IC 的符号**，不是看图选的。
   * `null` = 训练段 IC 算不出来 ⇒ 连方向都定不了。
   */
  sign: 1 | -1 | null
  /** 训练段（**只用来定方向**，它的收益数字不参与判决）。 */
  trainSections: number
  trainMeanIc: number | null
  trainTStat: number | null
  /** 检验段：**判决只用这一段**。 */
  sections: number
  icSkipped: number
  meanIc: number | null
  tStat: number | null
  positiveShare: number | null
  /**
   * 反向（`sign` 取反）在检验段上也通过。
   *
   * ★ 这是**门质量**诊断，不是加分项：两向都过说明这道门对方向没有区分力
   *   （对齐策略层的 `bothDirectionsPass`）。只在主方向通过时才跑 ——
   *   一个已经被拒的候选不需要回答"反过来会不会也过"。
   */
  bothDirectionsPass: boolean

  rebalances: number
  skipped: number
  /** 每腿毛边际（bps）。null = 没跑出任何一轮（**不是 0**）。 */
  grossBpsPerLeg: number | null
  /** 每腿每轮成本（bps）。无轮次时为 0 —— 那是"没有成本发生"，不是"没测"。 */
  costBpsPerLeg: number
  netBpsPerLeg: number | null
  longBpsPerLeg: number | null
  shortBpsPerLeg: number | null
  marketBpsPerLeg: number | null
  winRate: number | null
  turnoverPerRebalance: number | null

  lastEvaluatedAt: string
}

export interface BreadthIndex {
  version: typeof BREADTH_INDEX_VERSION
  thresholds: CrossSectionThresholds
  /**
   * ★ **最近一次**落盘那次运行的评估配置。
   *
   * 台账里可以同时躺着多套配置的行（同一面板 × 多个持有期）—— 这是设计意图，
   * 不是脏数据，验收点要看的正是跨持有期的趋势。⇒ 拿这个字段去描述"全部行"
   * 会得到一份**只对最后一行成立**的口径（判据 21）。
   * 逐行的权威配置在行内的 `horizon` / `topK` / `feeBps` / `slipBps` /
   * `trainShare`，以及 `panelHash` 里 `|topK=` 之后那一段。
   * 名字带 `lastRun` 就是为了让"拿它描述全部行"这件事**写不出来**。
   */
  lastRunConfig: BreadthConfig
  /** 上一次落盘时的面板事实（台账自证适用条件）。 */
  panel: {
    origin: 'history' | 'injected'
    symbols: string[]
    bars: number
    from: number
    to: number
    dropped: number
    missing: string[]
    sources: PanelSymbol[]
    /**
     * 谁把公共窗口拉短了（柱子最少的那些品种）。见 `BracketedPanel.binding`。
     * ★ 没有它的话，「品种从 10 涨到 51」与「证据从 36,000 根塌到 2,579 根」
     *   会同时出现在同一行里，而那一行看着完全正常（2026-09-22 实测）。
     */
    binding: string[]
    barsMin: number
    barsMax: number
  } | null
  rows: BreadthRow[]
  updatedAt: string
  /**
   * 上一次读盘时台账是坏的（有值就说明这一版是**在损坏之上重建**的）。
   * 记它不是为了好看：一份"重建后看着完全正常"的台账必须能回答
   * "那之前的数据去哪了"——否则它就是把一次数据丢失伪装成了正常演化。
   */
  damagedFrom?: string
}

export function emptyBreadthIndex(
  th: CrossSectionThresholds = DEFAULT_CROSS_SECTION_GATE,
  cfg: BreadthConfig = defaultBreadthConfig(),
): BreadthIndex {
  return { version: BREADTH_INDEX_VERSION, thresholds: th, lastRunConfig: cfg, panel: null, rows: [], updatedAt: '' }
}

export function readBreadthIndex(path: string): { index: BreadthIndex; damaged: string | null } {
  if (!existsSync(path)) return { index: emptyBreadthIndex(), damaged: null }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as BreadthIndex
    if (raw.version !== BREADTH_INDEX_VERSION) {
      return { index: emptyBreadthIndex(), damaged: `version 不匹配（磁盘 ${String(raw.version)}）` }
    }
    if (!Array.isArray(raw.rows)) return { index: emptyBreadthIndex(), damaged: 'rows 不是数组' }
    return { index: raw, damaged: null }
  } catch (e) {
    return { index: emptyBreadthIndex(), damaged: e instanceof Error ? e.message : String(e) }
  }
}

export interface EvaluateBreadthOptions {
  cwd?: string
  historyDir?: string
  indexPath?: string
  barMinutes?: number
  symbols?: string[]
  /** 候选因子。缺省 = 因子台账里 accepted 的那批。 */
  specs?: FactorSpec[]
  config?: Partial<BreadthConfig>
  thresholds?: CrossSectionThresholds
  dryRun?: boolean
  /** 只跑前 N 个候选（按 slug 排序）。给实跑时"先量一小批的耗时"用。 */
  limit?: number
  /** 注入面板（烟测用）。 */
  inputs?: PanelInput[]
  injectedHashes?: string[]
  /**
   * ★★ 进度观测点。**缺省不输出**（烟测与其它调用方不该被它改变行为）。
   *
   * 为什么必须有它：2026-09-22 实测 —— 用 46 个品种、187 个候选跑一轮，
   * 脚本在 **418 秒**时以 `Ineffective mark-compacts near heap limit` 直接 OOM 死掉，
   * 输出里只剩一段 V8 原生栈，**没有任何一行说它跑到第几个因子、用了多少内存**。
   * 那正是判据 C5 说的"观测通道坏了"：失败与"算完了但没有结论"在屏幕上长得一样。
   *
   * ★ 带上的两个数必须是**已经发生过的事实**（第几个 / 用了多少），不是估计值。
   */
  onProgress?: (p: BreadthProgress) => void
}

/** 一行进度：第几个候选、总共几个、面板规模、当前堆占用。 */
export interface BreadthProgress {
  done: number
  total: number
  slug: string
  symbols: number
  bars: number
  /** `process.memoryUsage().heapUsed`，单位 MB。 */
  heapUsedMb: number
  /** `v8.getHeapStatistics().heap_size_limit`，单位 MB —— 用来判断"离上限还有多远"。 */
  heapLimitMb: number
}

export interface EvaluateBreadthResult {
  origin: 'history' | 'injected'
  panelHash: string
  panel: BreadthIndex['panel']
  symbols: number
  panelBars: number
  /** 面板本身是否够做横截面。false ⇒ 所有行都会落 `panel` 闸门。 */
  panelUsable: boolean
  panelProblem: string | null
  candidates: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 被拦下的因子按闸门分组 —— 回答"哪道闸门最常拦人"。 */
  byGate: Record<string, number>
  rows: BreadthRow[]
  indexPath: string
  written: boolean
  elapsedMs: number
}

function rowFrom(
  spec: FactorSpec,
  cfg: BreadthConfig,
  panelHash: string,
  panel: BracketedPanel,
  icTrain: PooledIcResult,
  sign: 1 | -1,
  r: CrossSectionResult,
  ic: PooledIcResult,
  v: CrossSectionVerdict,
  bothDirectionsPass: boolean,
  now: string,
): BreadthRow {
  return {
    slug: spec.slug,
    nameCn: spec.nameCn,
    category: spec.category,
    base: spec.base,
    transform: spec.transform,
    window: spec.window,
    horizon: cfg.horizon,
    outcome: v.outcome,
    gate: v.gate,
    reason: v.reasons.join(' · '),
    headline: v.headline,
    panelHash,
    symbols: panel.symbols,
    panelBars: panel.panel.bars,
    topK: cfg.topK,
    sign,
    trainSections: icTrain.sections,
    trainMeanIc: icTrain.meanIc,
    trainTStat: icTrain.tStat,
    sections: ic.sections,
    icSkipped: ic.skipped,
    meanIc: ic.meanIc,
    tStat: ic.tStat,
    positiveShare: ic.positiveShare,
    bothDirectionsPass,
    rebalances: r.rebalances,
    skipped: r.skipped,
    grossBpsPerLeg: r.grossBpsPerLeg,
    costBpsPerLeg: r.costBpsPerLeg,
    netBpsPerLeg: r.netBpsPerLeg,
    longBpsPerLeg: r.longBpsPerLeg,
    shortBpsPerLeg: r.shortBpsPerLeg,
    marketBpsPerLeg: r.marketBpsPerLeg,
    winRate: r.winRate,
    turnoverPerRebalance: r.turnoverPerRebalance,
    lastEvaluatedAt: now,
  }
}

/** 未开跑就落定的行（面板不够 / 训练段定不了方向）。**不是** rejected —— 它们指向相反的动作。 */
function blockedRow(
  spec: FactorSpec,
  cfg: BreadthConfig,
  panelHash: string,
  gate: 'panel' | 'train-ic',
  why: string,
  headline: string,
  now: string,
): BreadthRow {
  return {
    slug: spec.slug,
    nameCn: spec.nameCn,
    category: spec.category,
    base: spec.base,
    transform: spec.transform,
    window: spec.window,
    horizon: cfg.horizon,
    outcome: 'unverifiable',
    gate,
    reason: why,
    headline,
    panelHash,
    symbols: 0,
    panelBars: 0,
    topK: cfg.topK,
    sign: null,
    trainSections: 0,
    trainMeanIc: null,
    trainTStat: null,
    sections: 0,
    icSkipped: 0,
    meanIc: null,
    tStat: null,
    positiveShare: null,
    bothDirectionsPass: false,
    rebalances: 0,
    skipped: 0,
    grossBpsPerLeg: null,
    costBpsPerLeg: 0,
    netBpsPerLeg: null,
    longBpsPerLeg: null,
    shortBpsPerLeg: null,
    marketBpsPerLeg: null,
    winRate: null,
    turnoverPerRebalance: null,
    lastEvaluatedAt: now,
  }
}

/**
 * 跑一轮横截面评估。
 *
 * 顺序固定为「取面板 → 判面板可用 → 逐因子算 → 落盘」，与 `produceFactors` 同构：
 * **落盘放最后**，中途抛异常时台账保持原样，不会留下"写了一半的台账"。
 */
export function evaluateBreadth(opts: EvaluateBreadthOptions = {}): EvaluateBreadthResult {
  const cwd = opts.cwd ?? process.cwd()
  const indexPath = opts.indexPath ?? defaultBreadthIndexPath(cwd)
  const th = opts.thresholds ?? DEFAULT_CROSS_SECTION_GATE
  const cfg = defaultBreadthConfig(opts.config)
  const t0 = Date.now()

  const bp = loadBreadthPanel({
    cwd,
    historyDir: opts.historyDir,
    barMinutes: opts.barMinutes,
    symbols: opts.symbols,
    inputs: opts.inputs,
    injectedHashes: opts.injectedHashes,
  })
  const panelHash = panelFingerprint(bp, cfg, th)

  // 候选来自因子台账（唯一事实源）。注入时以注入为准 —— 烟测要能构造任意因子。
  let specs: FactorSpec[]
  if (opts.specs) {
    specs = [...opts.specs]
  } else {
    const { index } = readFactorIndex(defaultIndexPath(cwd))
    specs = index.rows
      .filter((r) => r.state === 'accepted')
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(specFromRow)
  }
  if (opts.limit !== undefined) specs = specs.slice(0, Math.max(0, opts.limit))

  // ── 面板可用性：这是"横截面"这个词的前提，必须先于任何因子讨论 ──
  //   ★ 需要 ≥ 2·topK + 1 个品种（每边 topK，且至少剩一个在中间不参与），
  //     否则"排序"会退化成"全部做多 / 全部做空"，那就不是横截面了。
  const needNames = 2 * cfg.topK + 1
  let panelUsable = true
  let panelProblem: string | null = null
  if (bp.symbols < needNames) {
    panelUsable = false
    panelProblem = `只有 ${bp.symbols} 个品种，凑不出每边 ${cfg.topK} 的横截面（至少需要 ${needNames} 个）`
  } else if (bp.panel.bars < cfg.horizon + 1) {
    panelUsable = false
    panelProblem = `面板只有 ${bp.panel.bars} 根共同 bar，不足一个持有期（${cfg.horizon} 根）`
  }
  if (panelUsable && bp.missing.length > 0) {
    // 缺品种不阻止下结论（用现有的能跑的品种跑），但**必须说出来**：
    // "少了一个品种的横截面"与"完整的横截面"看起来一样（判据 24）。
    panelProblem = `以下品种被请求但没找到，已从面板剔除：${bp.missing.join('、')}`
  }

  const now = new Date().toISOString()
  const rows: BreadthRow[] = []
  const panelForRow: Panel = bp.panel

  if (!panelUsable) {
    for (const spec of specs) {
      rows.push(
        blockedRow(
          spec,
          cfg,
          panelHash,
          'panel',
          panelProblem ?? '面板不可用',
          '面板不足以构成横截面 —— 这不是"因子不行"，是"这批标的凑不齐"',
          now,
        ),
      )
    }
  } else {
    // 逐品种投影。★ 因子在**原始** K 线上算，再投影到面板时间轴 ——
    //   预热用的那几根不能因为"别的标的当时没有"就被砍掉（见 projectFactor 的说明）。
    //   `bp.candles` 与 `panel.symbols` 同序，所以这里不需要按符号名查表
    //   （按名字查会在重名时静默取到第一个）。
    //
    // ★★ 训练段 / 检验段的分界在这里取一次，下面两处都用它 ——
    //    各算各的会让"两段拼起来是不是整个面板"变成一个只能靠巧合成立的性质。
    const { train: trainRange, test: testRange } = splitRanges(panelForRow.bars, cfg.trainShare)
    // ★ 进度在**每个候选开始之前**报一次（不是在结束时）：OOM 是"跑到一半没了"，
    //   只在结束时报的话，恰恰是失败那一轮什么都看不到。
    let doneCount = 0
    for (const spec of specs) {
      if (opts.onProgress) {
        doneCount += 1
        opts.onProgress({
          done: doneCount,
          total: specs.length,
          slug: spec.slug,
          symbols: bp.symbols,
          bars: panelForRow.bars,
          heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
          heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1_048_576),
        })
      }
      const factors = bp.candles.map((cs) => projectFactor(panelForRow, cs, factorSeries(spec, cs)))

      // ── ① 训练段：**只用来定方向**，它的收益数字不参与判决 ──
      const icTrain = pooledIc(panelForRow, factors, cfg.horizon, { step: cfg.step, range: trainRange })
      if (icTrain.meanIc === null) {
        rows.push(
          blockedRow(
            spec,
            cfg,
            panelHash,
            'train-ic',
            `训练段（前 ${(cfg.trainShare * 100).toFixed(0)}%，${icTrain.sections} 个横截面）算不出 IC ⇒ 连方向都定不了` +
              `（跳过了 ${icTrain.skipped} 个横截面）`,
            '训练段定不了方向，不下结论',
            now,
          ),
        )
        continue
      }
      const sign: 1 | -1 = icTrain.meanIc >= 0 ? 1 : -1

      // ── ② 检验段：判决**只用这一段** ──
      const icTest = pooledIc(panelForRow, factors, cfg.horizon, { step: cfg.step, range: testRange })
      const rTest = crossSectionBacktest(panelForRow, factors, toCrossSectionConfig(cfg, testRange, sign))
      const v = judgeCrossSection(rTest, icTest, th)

      // ── ③ 门质量：**只有通过时才问**"反过来会不会也过" ──
      //    一个已经被拒的候选不需要回答这个问题（对齐策略层的 reverseChecked）。
      let both = false
      if (v.outcome === 'accepted') {
        const rRev = crossSectionBacktest(
          panelForRow,
          factors,
          toCrossSectionConfig(cfg, testRange, sign === 1 ? -1 : 1),
        )
        both = judgeCrossSection(rRev, icTest, th).outcome === 'accepted'
      }
      rows.push(rowFrom(spec, cfg, panelHash, bp, icTrain, sign, rTest, icTest, v, both, now))
    }
  }

  const byGate: Record<string, number> = {}
  for (const r of rows) {
    if (r.outcome === 'accepted') continue
    byGate[r.gate] = (byGate[r.gate] ?? 0) + 1
  }
  const accepted = rows.filter((r) => r.outcome === 'accepted').length
  const unverifiable = rows.filter((r) => r.outcome === 'unverifiable').length

  const panelFact: BreadthIndex['panel'] = {
    origin: bp.origin,
    symbols: bp.panel.symbols,
    bars: bp.panel.bars,
    from: bp.panel.from,
    to: bp.panel.to,
    dropped: bp.panel.dropped,
    missing: bp.missing,
    sources: bp.sources,
    binding: bp.binding,
    barsMin: bp.barsMin,
    barsMax: bp.barsMax,
  }

  const written = !opts.dryRun
  if (written) {
    const { index: prev, damaged } = readBreadthIndex(indexPath)
    // ★ 换**面板** ⇒ 旧行整体作废（不是合并）：留着会让面板事实与行内容
    //   交叉矛盾，而读的人只看行不看面板。与因子台账按指纹判过时同一立场。
    // ★ 换**评估配置**（持有期/topK/成本）⇒ 面板没变，旧行**依然成立**，
    //   只是另一个格子 ⇒ 必须**并存**。判据是 `samePanel` 而不是指纹相等，
    //   否则跑第二个持有期就把第一个删了（详见 `panelKeyOf` 的注释）。
    const keep = prev.panel && prevRowsReusable(prev, panelHash) ? prev.rows.filter((r) => samePanel(r.panelHash, panelHash)) : []
    const merged = upsertBreadthRows(keep, rows)
    atomicWriteJson(indexPath, {
      version: BREADTH_INDEX_VERSION,
      thresholds: th,
      lastRunConfig: cfg,
      panel: panelFact,
      rows: merged,
      updatedAt: now,
      ...(damaged ? { damagedFrom: damaged } : {}),
    } satisfies BreadthIndex)
  }

  return {
    origin: bp.origin,
    panelHash,
    panel: panelFact,
    symbols: bp.symbols,
    panelBars: bp.panel.bars,
    panelUsable,
    panelProblem,
    candidates: rows.length,
    accepted,
    rejected: rows.length - accepted - unverifiable,
    unverifiable,
    byGate,
    rows,
    indexPath,
    written,
    elapsedMs: Date.now() - t0,
  }
}

/** 旧行能不能复用：**同一面板**即可（配置不同是"另一个格子"，不是"过时"）。 */
function prevRowsReusable(prev: BreadthIndex, panelHash: string): boolean {
  return prev.rows.some((r) => samePanel(r.panelHash, panelHash))
}

/** 同 slug + 同 horizon 视为同一格；后写的覆盖先写的。 */
export function upsertBreadthRows(prev: readonly BreadthRow[], next: readonly BreadthRow[]): BreadthRow[] {
  const key = (r: BreadthRow) => `${r.slug}@h${r.horizon}`
  const map = new Map<string, BreadthRow>()
  for (const r of prev) map.set(key(r), r)
  for (const r of next) map.set(key(r), r)
  return [...map.values()].sort((a, b) => key(a).localeCompare(key(b)))
}

export interface BreadthSummary {
  available: boolean
  reason: string
  rows: number
  accepted: number
  rejected: number
  unverifiable: number
  byGate: Record<string, number>
  /** 面板事实：读这份台账的人第一眼该看到的适用条件。 */
  panelSymbols: number
  panelBars: number
  updatedAt: string
}

export function breadthSummary(path = defaultBreadthIndexPath()): BreadthSummary {
  const { index, damaged } = readBreadthIndex(path)
  const accepted = index.rows.filter((r) => r.outcome === 'accepted').length
  const unverifiable = index.rows.filter((r) => r.outcome === 'unverifiable').length
  const byGate: Record<string, number> = {}
  for (const r of index.rows) {
    if (r.outcome === 'accepted') continue
    byGate[r.gate] = (byGate[r.gate] ?? 0) + 1
  }
  return {
    available: index.rows.length > 0 && !damaged,
    reason: damaged
      ? `台账损坏：${damaged}`
      : index.rows.length === 0
        ? '还没有横截面结论（跑 npm run breadth:run）'
        : `${index.rows.length} 条结论 · 通过 ${accepted} · 拒绝 ${index.rows.length - accepted - unverifiable} · 证据不足 ${unverifiable}`,
    rows: index.rows.length,
    accepted,
    rejected: index.rows.length - accepted - unverifiable,
    unverifiable,
    byGate,
    panelSymbols: index.panel?.symbols.length ?? 0,
    panelBars: index.panel?.bars ?? 0,
    updatedAt: index.updatedAt,
  }
}
