/**
 * 横截面（breadth）引擎 —— 把"一个标的上的择时"换成"一批标的上的排序"。
 *
 * ══ 为什么非要有这一层（第十五~十八轮逐条证伪之后的结论）═══════════════
 * 因子线卡住的**不是**方向、也不是成本模型，而是这两个量差一个数量级：
 *
 *     每笔毛边际 ≈ 0.51 bps   vs   每笔往返成本 ≈ 6.48 bps
 *
 * 而且它**不是**通过下面任何一条修好的（每条都实测过）：
 *   空间不够大 ✗ / 不能做空 ✗ / 阈值映射 ✗ / 该降换手 ✗（408→11 笔，成本 −26×，
 *   毛同步从 +4.0% 塌到 −1.8%）/ 该换因子族 ✗。
 *
 * 剩下的那条路是**换问题本身**：不再问"BTC 接下来涨还是跌"，
 * 而是问"这一批标的里，谁比谁强"。这一步同时解决两件事：
 *
 *   ① **市场方向被消掉**。上一轮"39/12 条方向不成立"是在
 *      **纯多头 + BTC 十二个月 −34%** 的背景下算出来的 —— 那是市场给的，
 *      不是因子给的。多空对冲后这一项直接归零（见 `marketBpsPerRebalance`）。
 *   ② **每个调仓时刻的样本从 1 个变成 N 个**。同一个横截面上有 N 个标的，
 *      IC 是**同一时刻**横截面上的秩相关，不再依赖"这只票自己历史上像不像"。
 *
 * ══ 这一层刻意不做的事 ═══════════════════════════════════════════════
 *   · **不碰模型**：排序、收益、成本全是确定性算术。任何"让模型看看哪只好"
 *     都会让"它凭什么选这个"变成一句答不上来的话（本仓库红线）。
 *   · **不碰真实下单链路**：它只产出证据与判决，进不进池由既有的门决定。
 *   · **不发明新的成本口径**：每腿毛边际与每腿成本，与 `factorStrategy.ts`
 *     的「每笔毛边际(bps) vs 每笔成本(bps)」是同一对量、同一个分母。
 *
 * ══ 三态 ═════════════════════════════════════════════════════════════
 * 判决沿用因子线那三态，**不许**把"证据不够"压成"拒绝"：
 *   rejected     有证据说它不行（排序没方向 / 毛本身就负 / 毛不够付成本）
 *   accepted     有证据说它行（毛 > 成本且 IC 与 0 可区分）
 *   unverifiable 证据不够（横截面次数太少 / IC 算不出 t / 毛≥成本却净不给）
 */

import type { Candle } from './types.ts'
import { rankCorr } from './factorEval.ts'

const BPS = 10_000

// ─────────────────────────── ① 对齐成面板 ───────────────────────────

export interface PanelInput {
  symbol: string
  candles: Candle[]
}

export interface Panel {
  symbols: string[]
  /** 共同时间戳（升序）。只有**每一个**标的都有这根 bar 时才算共同。 */
  times: number[]
  /** `closes[i][k]` = 第 i 个标的在 `times[k]` 的收盘价。 */
  closes: number[][]
  /** 每个标的：原始几根、进了面板几根。 */
  coverage: { symbol: string; bars: number; kept: number }[]
  bars: number
  /**
   * 被丢掉的 bar 数（各标的原始根数之和 − 面板占用）。
   *
   * ★ 它是**面板可信度**的观测量：丢了 2% 与丢了 60% 都能算出一个看着正常的
   *   IC，但后者其实只剩一小撮时间上的交集（判据 13：读路径静默陈旧最危险）。
   */
  dropped: number
  /** 时间轴两端（各标的并不一定同起同止 —— 这个差本身要说出来）。 */
  from: number
  to: number
}

/**
 * 把多个标的的 K 线对齐成一张面板。
 *
 * ★ 判据是**交集**，不是"补零"或"取并集再前向填充"：补出来的 bar 会让
 *   "这个标的当时没交易"变成"它当时价格没动"，而后者是一个**真实的观测**，
 *   会直接进 IC 计算（判据 2：对正确的输入报错）。
 */
export function alignPanel(inputs: readonly PanelInput[]): Panel {
  const symbols = inputs.map((x) => x.symbol)
  const maps = inputs.map((x) => {
    const m = new Map<number, number>()
    for (const c of x.candles) if (!m.has(c.t)) m.set(c.t, c.c)
    return m
  })
  // 共同时间戳：按第一个标的的时间轴走，逐个要求其它标的也有。
  const first = maps[0]
  const times: number[] = []
  if (first) {
    for (const t of first.keys()) {
      let all = true
      for (let i = 1; i < maps.length; i++) {
        if (!maps[i].has(t)) {
          all = false
          break
        }
      }
      if (all) times.push(t)
    }
  }
  times.sort((a, b) => a - b)

  const closes = maps.map((m) => times.map((t) => m.get(t) as number))
  const coverage = inputs.map((x) => ({ symbol: x.symbol, bars: x.candles.length, kept: times.length }))
  const dropped = inputs.reduce((s, x) => s + x.candles.length, 0) - times.length * inputs.length
  return {
    symbols,
    times,
    closes,
    coverage,
    bars: times.length,
    dropped,
    from: times[0] ?? 0,
    to: times[times.length - 1] ?? 0,
  }
}

/**
 * 把"在某标的自己的 K 线上算好的因子"搓到面板的时间轴上。
 *
 * ★ 为什么不在面板上直接算因子：因子在**原始** K 线上算，预热用的那几根
 *   不能因为"别的标的当时没有"就被砍掉 —— 那会让面板上每个标的的因子
 *   在最前面几根全是 null，而 null 会被下游当成"没有信号"而不是"没算"。
 */
export function projectFactor(panel: Panel, candles: Candle[], series: readonly (number | null)[]): (number | null)[] {
  const byTime = new Map<number, number | null>()
  for (let i = 0; i < candles.length; i++) if (!byTime.has(candles[i].t)) byTime.set(candles[i].t, series[i] ?? null)
  const out = new Array<number | null>(panel.bars).fill(null)
  for (let k = 0; k < panel.bars; k++) {
    const v = byTime.get(panel.times[k])
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  return out
}

// ─────────────────────────── ② 池化 IC ───────────────────────────

export interface IcPoint {
  t: number
  ic: number
  n: number
}

export interface PooledIcResult {
  points: IcPoint[]
  /** 各横截面 IC 的均值（不是"把所有标的混在一起算一次"）。 */
  meanIc: number | null
  /** IC 的 t 统计量 = mean / (σ/√n)。|t| < 2 ⇒ 与 0 分不开。 */
  tStat: number | null
  /** 参与计算的横截面次数。 */
  sections: number
  /** 因为有效标的数不够被丢掉的横截面次数。 */
  skipped: number
  /** 单次横截面上最少用了几个标的。 */
  minNames: number
  /** 正向横截面占比（IC > 0 的比例）。方向是否稳定看它。 */
  positiveShare: number | null
}

export interface IcOptions {
  /** 每几根 bar 取一个横截面（默认 = horizon，即不重叠）。 */
  step?: number
  /** 一个横截面至少要有几个有效标的（默认 6）。 */
  minNames?: number
  /** 只在这个 k 区间上取横截面（半开区间 `[from, to)`）。用于**训练段定方向**。 */
  range?: { from: number; to: number }
}

/**
 * 池化横截面 IC。
 *
 * ★ 两次都是"IC"，但**口径完全不同**，不许混着看：
 *   · 时序 IC（`computeFactorMetrics`）：一个标的自己历史上"因子高时后面涨不涨"。
 *   · 横截面 IC（这里）：**同一时刻**这一批标的里"因子高的比因子低的多涨多少"。
 *   前者的样本是"这只票的每一根 bar"，后者是"每一个时刻的一组票"。
 *   混用会得出"样本很多所以很显著"的假结论 —— 同一时刻的 N 个标的
 *   不是 N 份独立证据（判据 28：派生值不当独立证据）。
 */
export function pooledIc(
  panel: Panel,
  factors: readonly (number | null)[][],
  horizon: number,
  opts: IcOptions = {},
): PooledIcResult {
  const step = Math.max(1, opts.step ?? horizon)
  const minNames = Math.max(3, opts.minNames ?? 6)
  const kFrom = Math.max(0, Math.min(opts.range?.from ?? 0, panel.bars))
  const kTo = Math.max(kFrom, Math.min(opts.range?.to ?? panel.bars, panel.bars))
  const points: IcPoint[] = []
  let skipped = 0
  let minUsed = Number.POSITIVE_INFINITY

  for (let k = kFrom; k + horizon < kTo; k += step) {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < panel.symbols.length; i++) {
      const f = factors[i]?.[k]
      const c0 = panel.closes[i]?.[k]
      const c1 = panel.closes[i]?.[k + horizon]
      if (typeof f !== 'number' || !Number.isFinite(f)) continue
      if (!(typeof c0 === 'number' && c0 > 0) || !(typeof c1 === 'number' && c1 > 0)) continue
      xs.push(f)
      ys.push((c1 / c0 - 1) * BPS)
    }
    if (xs.length < minNames) {
      skipped += 1
      continue
    }
    const ic = rankCorr(xs, ys, minNames)
    if (ic === null) {
      skipped += 1
      continue
    }
    minUsed = Math.min(minUsed, xs.length)
    points.push({ t: panel.times[k], ic, n: xs.length })
  }

  const ics = points.map((p) => p.ic)
  const meanIc = ics.length > 0 ? ics.reduce((a, b) => a + b, 0) / ics.length : null
  let tStat: number | null = null
  if (ics.length >= 3 && meanIc !== null) {
    const varr = ics.reduce((s, x) => s + (x - meanIc) ** 2, 0) / (ics.length - 1)
    const sd = Math.sqrt(varr)
    if (sd > 0) tStat = meanIc / (sd / Math.sqrt(ics.length))
  }
  return {
    points,
    meanIc,
    tStat,
    sections: points.length,
    skipped,
    minNames: Number.isFinite(minUsed) ? minUsed : 0,
    positiveShare: ics.length > 0 ? ics.filter((x) => x > 0).length / ics.length : null,
  }
}

// ─────────────────────────── ③ 横截面回测 ───────────────────────────

export interface CrossSectionConfig {
  /** 每边持几个（多头 = 因子最高 topK，空头 = 最低 topK）。 */
  topK: number
  /** 持有多少根 bar 换仓。 */
  horizon: number
  /** **单边**手续费（bps）。 */
  feeBps: number
  /** **单边**滑点（bps）。 */
  slipBps: number
  /** 每几根 bar 调一次仓（默认 = horizon ⇒ 不重叠）。 */
  step?: number
  /** 一个横截面至少要有几个标的（默认 2·topK + 1 ⇒ 至少还有一个中间的不参与）。 */
  minNames?: number
  /**
   * 排序方向。`+1`（默认）= 因子值大的一边做多；`-1` = 反过来。
   *
   * ★ 方向**不该由在这里看图决定**。它必须来自**另一段数据**
   *   （训练段 IC 的符号），否则"换个方向就正了"是一次数据窥探 ——
   *   同一批数据上定方向又评表现，反向的毛为正几乎是恒等式，不是证据。
   *   `sign` 参数在这里，是为了让调用方能**按训练段定的方向**跑检验段；
   *   它不是一个"试两下挑好的"的旋钮。
   */
  sign?: 1 | -1
  /**
   * 只在这个 k 区间上跑（半开区间 `[from, to)`）。缺省 = 全区间。
   *
   * ★ 有了它，"训练段定方向 + 检验段判决"在同一份面板上就能做，
   *   不需要切两份面板 —— 后者会让两段各自重新对齐，交集不同，
   *   于是"训练段与检验段说的是同一批品种"这句话不再成立。
   */
  range?: { from: number; to: number }
}

export interface CrossSectionLogRow {
  t: number
  long: string[]
  short: string[]
  /** 这一次调仓的腿均毛收益（bps）。 */
  grossBpsPerLeg: number
  /** 全体标的的等权收益（bps）—— 多空是否真的把市场方向消掉了，看这一列。 */
  marketBpsPerLeg: number
  /** 换手（0~1，被换掉的腿占比）。 */
  turnover: number
}

export interface CrossSectionResult {
  rebalances: number
  /** **每腿**毛收益均值（bps）。符号已按多空方向处理过。 */
  grossBpsPerLeg: number | null
  /** **每腿**每轮成本均值（bps）。与毛同分母，两者可直接比。 */
  costBpsPerLeg: number
  /** 毛 − 成本（bps）。 */
  netBpsPerLeg: number | null
  /** 只算多头腿 / 只算空头腿的腿均收益。分辨"是不是只有一边有用"。 */
  longBpsPerLeg: number | null
  shortBpsPerLeg: number | null
  /** 全体标的等权收益（bps/轮）—— 市场给的那一份。 */
  marketBpsPerLeg: number | null
  /** 腿胜率（`side·r > 0` 的比例）。 */
  winRate: number | null
  /** 每轮换掉多少腿（0~1）。 */
  turnoverPerRebalance: number | null
  /** 因为凑不齐标的被跳过的调仓次数。 */
  skipped: number
  /** 逐轮明细（可回放、可核对）。 */
  log: CrossSectionLogRow[]
}

/**
 * 横截面多空回测。
 *
 * 记账口径（与 `factorStrategy.ts` 的每笔口径**同一对量**）：
 *   · 每一腿的名义金额相同；`side_i ∈ {+1, −1}`。
 *   · 腿均毛收益 = `mean(side_i · r_i)`（r 是持有期内该腿的收益，bps）。
 *   · 腿均成本   = `(fee + slip) · mean(|Δside_i|)`（换掉一整条腿就是一次单边）。
 *   · 于是 "毛 vs 成本" 是同一个分母上的两个数 —— 这正是判定
 *     "该换因子族还是该降成本"的那一对（判据 28）。
 */
export function crossSectionBacktest(
  panel: Panel,
  factors: readonly (number | null)[][],
  cfg: CrossSectionConfig,
): CrossSectionResult {
  const topK = Math.max(1, cfg.topK)
  const horizon = Math.max(1, cfg.horizon)
  const step = Math.max(1, cfg.step ?? horizon)
  const oneWay = cfg.feeBps + cfg.slipBps
  const minNames = Math.max(2 * topK + 1, cfg.minNames ?? 0)
  const sign = cfg.sign ?? 1
  const kFrom = Math.max(0, Math.min(cfg.range?.from ?? 0, panel.bars))
  const kTo = Math.max(kFrom, Math.min(cfg.range?.to ?? panel.bars, panel.bars))

  const prev = new Map<string, number>()
  const log: CrossSectionLogRow[] = []
  let skipped = 0
  let grossSum = 0
  let costSum = 0
  let longSum = 0
  let longN = 0
  let shortSum = 0
  let shortN = 0
  let marketSum = 0
  let winN = 0
  let legN = 0

  for (let k = kFrom; k + horizon < kTo; k += step) {
    const rows: { sym: string; f: number; r: number }[] = []
    for (let i = 0; i < panel.symbols.length; i++) {
      const f = factors[i]?.[k]
      const c0 = panel.closes[i]?.[k]
      const c1 = panel.closes[i]?.[k + horizon]
      if (typeof f !== 'number' || !Number.isFinite(f)) continue
      if (!(typeof c0 === 'number' && c0 > 0) || !(typeof c1 === 'number' && c1 > 0)) continue
      rows.push({ sym: panel.symbols[i], f, r: (c1 / c0 - 1) * BPS })
    }
    if (rows.length < minNames) {
      skipped += 1
      continue
    }

    // 排序：因子值大的一边在前。**哪一边做多由 `sign` 决定**（来自训练段）。
    rows.sort((a, b) => b.f - a.f || (a.sym < b.sym ? -1 : 1))
    const longs = sign === 1 ? rows.slice(0, topK) : rows.slice(-topK)
    const shorts = sign === 1 ? rows.slice(-topK) : rows.slice(0, topK)
    const cur = new Map<string, number>()
    for (const x of longs) cur.set(x.sym, 1)
    for (const x of shorts) cur.set(x.sym, -1)

    // 换手：|Δside| 之和 ÷ 腿数。（0.5 表示"换掉了一半的腿"。）
    let delta = 0
    const keys = new Set<string>([...prev.keys(), ...cur.keys()])
    for (const s of keys) delta += Math.abs((cur.get(s) ?? 0) - (prev.get(s) ?? 0))
    const legs = 2 * topK
    // ★ 第一条横截面没有"上一本"，`|Δ| = 1` 是**开仓**的一次单边；之后换腿
    //   才会出现"平旧 + 开新"的两次单边。用 Δ 表达这两件事是同一件事，
    //   不需要为第一次另写一条分支（分支越多，"第一次忘了算成本"越难发现）。
    const turnover = delta / legs

    let g = 0
    for (const x of longs) {
      g += 1 * x.r
      longSum += x.r
      longN += 1
      if (x.r > 0) winN += 1
    }
    for (const x of shorts) {
      g += -1 * x.r
      shortSum += -x.r
      shortN += 1
      if (-x.r > 0) winN += 1
    }
    legN += legs
    grossSum += g / legs
    costSum += oneWay * turnover
    marketSum += rows.reduce((s, x) => s + x.r, 0) / rows.length

    log.push({
      t: panel.times[k],
      long: longs.map((x) => x.sym),
      short: shorts.map((x) => x.sym),
      grossBpsPerLeg: g / legs,
      marketBpsPerLeg: rows.reduce((s, x) => s + x.r, 0) / rows.length,
      turnover,
    })
    prev.clear()
    for (const [s, v] of cur) prev.set(s, v)
  }

  const n = log.length
  const grossBpsPerLeg = n > 0 ? grossSum / n : null
  const costBpsPerLeg = n > 0 ? costSum / n : 0
  return {
    rebalances: n,
    grossBpsPerLeg,
    costBpsPerLeg,
    netBpsPerLeg: grossBpsPerLeg === null ? null : grossBpsPerLeg - costBpsPerLeg,
    longBpsPerLeg: longN > 0 ? longSum / longN : null,
    shortBpsPerLeg: shortN > 0 ? shortSum / shortN : null,
    marketBpsPerLeg: n > 0 ? marketSum / n : null,
    winRate: legN > 0 ? winN / legN : null,
    turnoverPerRebalance: n > 0 ? log.reduce((s, x) => s + x.turnover, 0) / n : null,
    skipped,
    log,
  }
}

// ─────────────────────────── ④ 判决（与因子线三态一致）───────────────────────────

export interface CrossSectionThresholds {
  /** IC 的 |t| 至少要多大才算"方向与 0 分得开"。 */
  minAbsT: number
  /** 至少要多少个横截面才敢下结论。 */
  minSections: number
  /** 腿胜率下限。低于它就算毛为正也不接受。 */
  minWinRate: number
}

/**
 * 默认阈值。**与因子线同一套数字**（`DEFAULT_FACTOR_STRATEGY_GATE` 的口径）：
 * 同一件事只该有一套阈值（判据 8），否则改一处就会两处说不同的话。
 */
export const DEFAULT_CROSS_SECTION_GATE: CrossSectionThresholds = {
  minAbsT: 2,
  minSections: 60,
  minWinRate: 0.5,
}

export type CrossSectionOutcome = 'accepted' | 'rejected' | 'unverifiable'

export interface CrossSectionVerdict {
  outcome: CrossSectionOutcome
  /**
   * 命中的闸门 id，便于统计"哪道闸门最常拦人"。
   *
   * ★ 三种 `rejected` **必须各有各的 gate**，不许共用一个 `'rejected'`：
   *   它们指向的动作完全相反（换因子族 / 把排序反过来 / 降换手降费率）。
   *   共用一个词会让台账里"被拒 12 条"变成一句不可行动的话 ——
   *   这正是判据 20 的镜像：用哪个统计量把两种事因分开。
   */
  gate: string
  /** 逐条理由。**必须能被它自己记下的指标解释**（红线 12）。 */
  reasons: string[]
  /** 一句话结论（面板/语音共用同一句）。 */
  headline: string
}

/**
 * 判定。
 *
 * ★ 三种 rejected 的话必须**互不相同**，因为它们指向相反的动作：
 *     · 排序没方向      → 换因子族
 *     · 毛本身就是负的  → 排序反着做，或者这个因子在横截面上不成立
 *     · 毛够大但被成本吃 → 降换手 / 降费率，**不要**换因子
 *   这三件事在"净收益为负"这一个数字上长得完全一样（判据 24）。
 */
export function judgeCrossSection(
  r: CrossSectionResult,
  ic: PooledIcResult,
  th: CrossSectionThresholds = DEFAULT_CROSS_SECTION_GATE,
): CrossSectionVerdict {
  const reasons: string[] = []
  const money = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(2))

  if (r.rebalances < th.minSections) {
    return {
      outcome: 'unverifiable',
      gate: 'sections',
      reasons: [`只凑出 ${r.rebalances} 个横截面（要求 ≥ ${th.minSections}）`, `跳过了 ${r.skipped} 个`, '这不是"不行"，是"还没测够"'],
      headline: `横截面样本不够（${r.rebalances}/${th.minSections}），不下结论`,
    }
  }
  if (ic.meanIc === null || ic.tStat === null) {
    return {
      outcome: 'unverifiable',
      gate: 'ic-unknown',
      reasons: [`IC 算不出 t 统计量（sections=${ic.sections}）`, '多半是各横截面的 IC 完全相同（方差为 0）'],
      headline: 'IC 的 t 统计量算不出来，不下结论',
    }
  }

  const dirOk = Math.abs(ic.tStat) >= th.minAbsT
  reasons.push(
    `横截面 IC 均值 ${ic.meanIc.toFixed(4)} · t=${ic.tStat.toFixed(2)}（门槛 |t| ≥ ${th.minAbsT}）· ${ic.sections} 个横截面`,
  )
  reasons.push(
    `每腿毛边际 ${money(r.grossBpsPerLeg)} bps vs 每腿成本 ${money(r.costBpsPerLeg)} bps · ` +
      `换手 ${r.turnoverPerRebalance === null ? 'n/a' : (r.turnoverPerRebalance * 100).toFixed(1) + '%'} · ` +
      `胜率 ${r.winRate === null ? 'n/a' : (r.winRate * 100).toFixed(1) + '%'}`,
  )
  reasons.push(
    `市场那份（全体等权）${money(r.marketBpsPerLeg)} bps/轮 · 空头腿 ${money(r.shortBpsPerLeg)} bps —— ` +
      `多空成立时这两列应当明显分开（市场方向被消掉了）`,
  )

  if (!dirOk) {
    // ★ 这一档**单独说**：它不能与"被成本吃掉"共用一句话（判据 24）。
    return {
      outcome: 'rejected',
      gate: 'ic-t',
      reasons: [...reasons, `|t| < ${th.minAbsT} ⇒ 这个排序与"随机排"分不开`],
      headline: '横截面排序没有方向（IC 与 0 分不开）—— 这是该换因子族的信号，不是该降成本的信号',
    }
  }
  const gross = r.grossBpsPerLeg ?? Number.NEGATIVE_INFINITY
  if (gross <= 0) {
    return {
      outcome: 'rejected',
      gate: 'gross',
      reasons: [...reasons, '毛边际本身就是负的 ⇒ 排序方向反了，或者这个因子在横截面上不成立'],
      headline: '每腿毛边际为负 —— 信号本身没用（不是成本问题）',
    }
  }
  if (gross < r.costBpsPerLeg) {
    return {
      outcome: 'rejected',
      gate: 'cost',
      reasons: [...reasons, `毛 ${money(gross)} < 成本 ${money(r.costBpsPerLeg)} ⇒ 每一腿都在给交易所打工`],
      headline: '每腿毛边际不够付一次单边成本 —— 这是该降换手/降费率的信号，不是该换因子的信号',
    }
  }
  const net = gross - r.costBpsPerLeg
  if (net > 0 && (r.winRate ?? 0) >= th.minWinRate) {
    return {
      outcome: 'accepted',
      gate: 'pass',
      reasons: [...reasons, `净 ${money(net)} bps/腿 · 胜率达标`],
      headline: `横截面成立：每腿净 ${money(net)} bps（毛 ${money(gross)} − 成本 ${money(r.costBpsPerLeg)}）`,
    }
  }
  // 毛 ≥ 成本却净不给 / 胜率不够：**证据不够统一档**，不许压成"拒绝"。
  // ★ 为什么这一档不能算 rejected：毛已经盖过成本、只是胜率或几段样本没跟上 ——
  //   把它写成"拒绝"会把一条**可能能用**的策略按死，而它缺的只是更长的样本。
  return {
    outcome: 'unverifiable',
    gate: net > 0 ? 'winrate' : 'net',
    reasons: [
      ...reasons,
      net > 0
        ? `净为正（${money(net)} bps）但胜率 ${((r.winRate ?? 0) * 100).toFixed(1)}% 低于 ${(th.minWinRate * 100).toFixed(0)}%`
        : `净 ${money(net)} bps —— 正好卡在"刚好够本"的边界上`,
    ],
    headline: '毛与成本同量级、净结果不稳定 —— 证据不够，不下结论',
  }
}
