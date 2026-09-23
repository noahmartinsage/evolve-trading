/**
 * 因子评价内核 —— 「这个信号本身有没有预测力」的度量。
 *
 * ══ 为什么需要它（对标 quantskills/skill-factor-* 后补的地基）═══════════
 * 本系统原先判一个候选好坏的唯一尺子是 `fitness-v2`，而它只看三样东西：
 * 年化收益 / 最大回撤 / 每日笔数。那是**一条回测曲线**的总结，
 * 不是**一个信号**的性质。两者混同的代价在 09-14 实测里已经付过：
 * BTC 真实 30 天上 PBO=40.1% —— 20 个候选里挑一个，挑中的那个
 * 有相当概率只是运气。**fitness 无法区分「有预测力」与「恰好蒙对」**，
 * 因为它把"信号与未来收益的关系"整个跳过了。
 *
 * 因子评价补的就是这一环：直接度量 `signal_t` 与 `未来 h 根收益` 的关系，
 * 且**与仓位、成本、执行完全无关**。这样"信号没用"和"信号有用但交易成本吃掉了"
 * 才能被分开归因——现在这两种情况在系统里长得一模一样（都是 fitness 低）。
 *
 * ══ 一处必须说清的适配（照抄上游会错）═══════════════════════════════
 * 上游 quantskills 是**截面**因子研究（A 股全市场几千只股票，
 * 逐日截面算 Rank IC、分五组做多空组合）。本项目只有 BTC/ETH 两个标的，
 * 截面宽度 = 2 —— 在两行数据上做截面排序没有任何统计意义。
 * 所以这里算的是**时序 IC**：把 `signal_t` 与 `forward_return(t→t+h)` 在时间轴
 * 上做秩相关。上游 SKILL.md 明确写着"不是时间序列 IC"，那条要求
 * 是针对"截面研究却误用时序口径"的，本项目没有截面可做，属如实适配而非照抄。
 * 因此：**分位差（quantileSpreadBps）在这里是诊断量，不是可交易的多空组合**，
 * 单标的时序分位上"做空下分位"没有对应的交易动作。别把它当收益预期读。
 *
 * ══ 未来函数检测为什么是一个"真的检查"══════════════════════════════
 * 因子写错最常见的形态不是算错，而是**偷看未来**（用了 t 之后的窗口、
 * 用了以全样本算出的均值做标准化）。这种因子在回测里表现极好，
 * 在实盘里完全无效，而且它**不报错**。
 *
 * 这里的检测不是"读代码看有没有用未来数据"，而是可执行的判据：
 * 把 K 线截到 t 再算一遍，最后一位必须与在完整序列上算出的第 t 位逐位相同。
 * 偷看未来的实现会在这两条路径上给出不同的值。
 * 返回三态（true / false / null）：`null` = 样本不足、这一位本来就是空值，
 * **没有任何可用样本可判**。`null` 绝不能被当成"通过"——见 judgeFactor 的注释。
 */
import type { Candle } from './types.ts'
import { memoDerived } from './seriesCache.ts'

/** 因子评价的数据来源。**这是判决的前提，不是元数据。** */
export type FactorOrigin = 'history' | 'injected' | 'synthetic'

/** 因子身份。`slug` 是索引键，必须全局唯一 —— 重复生产靠它拦。 */
export interface FactorSpec {
  slug: string
  nameCn: string
  category: string
  base: string
  transform: string
  window: number
}

/** 未来函数检测的三态结果。`null` = 无法判定（样本不足），不是"通过"。 */
export type LookaheadVerdict = true | false | null

export interface FactorMetrics {
  spec: FactorSpec
  bars: number
  /** 有效值占比，0..1 的**比例**（不是百分数）。 */
  coverage: number
  /** 各持有期(根)的时序 Rank IC 均值，取值 -1..1。null = 样本不足。 */
  icByHorizon: Record<string, number | null>
  /** 主期限（5 根）的 IC，便于排序展示。 */
  icMean5: number | null
  /** IC 的信息比 = 分块 IC 均值/标准差。无量纲。null = 分块不足。 */
  icir: number | null
  /** Top20% 与 Bottom20% 信号对应的未来 5 根收益差，单位 **bps**。 */
  quantileSpreadBps: number | null
  /** Top20% 成分每根 K 线的换手**比例**（0..1/根）。 */
  turnover: number | null
  /** 与已入池因子信号序列的最大 |秩相关|，0..1。null = 池里没有可比样本。 */
  maxAbsCorrWithPool: number | null
  /** 上面的相关性来自哪个 slug。 */
  nearestSlug: string | null
}

export interface FactorGateThresholds {
  /** |IC| 下限。低于它说明信号与未来收益基本无关。 */
  minAbsIc: number
  /** ICIR 下限。IC 均值高但忽正忽负的因子不可用。 */
  minIcir: number
  /** 换手上限（比例/根）。过高会把成本吃光。 */
  maxTurnover: number
  /** 覆盖率下限（比例）。 */
  minCoverage: number
  /** 样本根数下限。**证据不足一律不判"通过"**。 */
  minBars: number
  /** 与已有因子的秩相关上限，超过即视为重复生产。 */
  maxDuplicateCorr: number
}

/**
 * 默认阈值 —— **唯一出处**。
 *
 * 这些数字不是"行业标准"，它们是在本项目唯一可用的真实数据
 * （BTCUSDT 15m × 2880 根 = 30 天）上标定出来的**下限**，
 * 目的是拦住"明显没有预测力"的东西，不是"筛选出好因子"。
 * 谁要放宽它们，等于在样本量没变的前提下宣称自己发现了更弱的信号。
 */
export const DEFAULT_FACTOR_GATE: FactorGateThresholds = {
  minAbsIc: 0.02,
  minIcir: 0.15,
  maxTurnover: 0.6,
  minCoverage: 0.5,
  minBars: 2000,
  maxDuplicateCorr: 0.9,
}

/** 因子判决的三态。**少的那一档（unverifiable）必须能说出理由。** */
export type FactorVerdictState = 'accepted' | 'rejected' | 'unverifiable'

export interface FactorVerdict {
  state: FactorVerdictState
  /** 人可读理由。任何一档都必须非空 —— 无声的拒绝等于没拒绝。 */
  reason: string
  /** 命中的闸门 id，便于统计"哪道闸门最常拦人"。 */
  gate: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 截面工具
// ─────────────────────────────────────────────────────────────────────────────

/** 秩（平均秩处理并列），返回与输入等长的数组；非有限值保持 NaN。 */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).filter((p) => Number.isFinite(p.v))
  idx.sort((a, b) => a.v - b.v)
  const out = new Array<number>(xs.length).fill(Number.NaN)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++
    const avg = (i + j) / 2
    for (let k = i; k <= j; k++) out[idx[k].i] = avg
    i = j + 1
  }
  return out
}

/**
 * 秩相关**对样本量的要求**（配对数下限），样本级口径。
 *
 * 这个数必须由**调用方**显式给出，不能写在内核里 —— 因为本项目实测踩过
 * 一个静默失效：同一个函数被两种口径共用，
 *   · 样本级（IC / 去冗余）：样本量 = **整条序列**（几千根）
 *   · 滚动窗口（price_volume_corr）：样本量 = **窗口长度**（w 根）
 * 内核里写死 30 时，后者在 w < 30 上**每一位都返回 null**，整条因子恒为空、
 * 覆盖率 0，而它不报错 —— 上游只看到"未来函数检测无可用采样点"，
 * 读起来像"证据不足、再攒点数据"，攒再多它也不会有输出。
 *
 * 所以内核只负责算，**"够不够算"由调用方声明**。
 */
export const SPEARMAN_MIN_PAIRS = 30

/**
 * 秩相关内核。`minPairs` = 调用方要求的**最少配对数**（显式传入，见上）。
 *
 * 配对不足、或任一序列无离散度时返回 null —— null 表示**不可定义**，
 * 不是"无关"。返回 0 会让它被读成"无关"，那是另一个结论。
 */
export function rankCorr(xs: number[], ys: number[], minPairs: number): number | null {
  const px: number[] = []
  const py: number[] = []
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      px.push(xs[i])
      py.push(ys[i])
    }
  }
  if (px.length < minPairs) return null
  const rx = ranks(px)
  const ry = ranks(py)
  const n = rx.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += rx[i]
    my += ry[i]
  }
  mx /= n
  my /= n
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx
    const dy = ry[i] - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (vx <= 0 || vy <= 0) return null
  const r = cov / Math.sqrt(vx * vy)
  return Number.isFinite(r) ? r : null
}

/**
 * Spearman 秩相关（**样本级**口径）。
 *
 * 用秩而不是皮尔逊，是因为因子的**排序信息**才是可交易的：
 * 一个单调变换（乘以常数、取 z-score）会改变皮尔逊但不改变秩相关，
 * 而它显然不构成一个新因子。这也让"去冗余"能真的拦住
 * z/rank 这类仿射变换变体 —— 见 evaluateFactorBatch 里的说明。
 *
 * ⚠️ 这个入口要求 ≥ `SPEARMAN_MIN_PAIRS` 个配对，**只适用于样本级用法**
 *    （整条序列、宽度 ≥30 的分块）。要在滚动窗口里用，调
 *    `rankCorr(xs, ys, <该窗口自己的下限>)`，否则整条序列会恒为空。
 */
export function spearman(xs: number[], ys: number[]): number | null {
  return rankCorr(xs, ys, SPEARMAN_MIN_PAIRS)
}

function smaOf(xs: number[], period: number): number[] {
  const out = new Array<number>(xs.length).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]
    if (i >= period) sum -= xs[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function stdOf(xs: number[], period: number): number[] {
  const out = new Array<number>(xs.length).fill(Number.NaN)
  for (let i = period - 1; i < xs.length; i++) {
    let s = 0
    for (let j = i - period + 1; j <= i; j++) s += xs[j]
    const m = s / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (xs[j] - m) ** 2
    out[i] = Math.sqrt(sq / period)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 基础因子（全部因果：第 t 位只依赖 0..t）
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorBaseDef {
  id: string
  labelCn: string
  category: string
  /**
   * 这个机制能产出值的**最小窗口**。省略 = `FACTOR_MIN_WINDOW`。
   *
   * 有些机制在短窗口上**凑不齐它要的统计量**，于是每一位都是 null。
   * 那种候选不该被展开（`generateFactorBatch` 会跳过）：评价预算白花，
   * 而且它进了台账以后长得像"证据不足"—— 攒再多它也不会有输出。
   * `price_volume_corr` 就是这么被实测抓出来的。
   */
  minWindow?: number
  compute(candles: Candle[], window: number): (number | null)[]
}

/** 窗口的绝对下限，与 `factorSeries` 里 `window < 2` 的校验同源。 */
export const FACTOR_MIN_WINDOW = 2

/** 展开候选时该用哪个下限 —— **唯一出处**，生成与自检共用。 */
export function minWindowFor(base: Pick<FactorBaseDef, 'minWindow'>): number {
  return base.minWindow ?? FACTOR_MIN_WINDOW
}

function wrap(v: number): number | null {
  return Number.isFinite(v) ? v : null
}

const closeArr = (c: Candle[]) => c.map((x) => x.c)
const highArr = (c: Candle[]) => c.map((x) => x.h)
const lowArr = (c: Candle[]) => c.map((x) => x.l)
const volArr = (c: Candle[]) => c.map((x) => x.v)

/**
 * `price_volume_corr` 在窗口内至少凑齐的**配对样本数**。它同时是两件事，
 * 必须同源：
 *   · `compute` 里"配对不够就别算"的门槛；
 *   · `minWindow`（展开候选时的下限）—— 窗口 w 最多只能提供 w 个配对，
 *     所以 w < 5 的候选**结构上不可能产出值**，不该被展开。
 */
const PV_MIN_OBS = 5

export const FACTOR_BASES: FactorBaseDef[] = [
  {
    id: 'ret',
    labelCn: '收益动量',
    category: '动量',
    compute: (c, w) => {
      const px = closeArr(c)
      return px.map((v, i) => (i < w || px[i - w] <= 0 ? null : wrap(v / px[i - w] - 1)))
    },
  },
  {
    id: 'reversal',
    labelCn: '收益反转',
    category: '反转',
    compute: (c, w) => {
      const px = closeArr(c)
      return px.map((v, i) => (i < w || px[i - w] <= 0 ? null : wrap(-(v / px[i - w] - 1))))
    },
  },
  {
    id: 'sma_gap',
    labelCn: '均线偏离',
    category: '趋势',
    compute: (c, w) => {
      const px = closeArr(c)
      const m = smaOf(px, w)
      return px.map((v, i) => (Number.isFinite(m[i]) && m[i] !== 0 ? wrap(v / m[i] - 1) : null))
    },
  },
  {
    id: 'ema_gap',
    labelCn: 'EMA偏离',
    category: '趋势',
    compute: (c, w) => {
      const px = closeArr(c)
      const k = 2 / (w + 1)
      const out: (number | null)[] = new Array(px.length).fill(null)
      let prev = Number.NaN
      for (let i = 0; i < px.length; i++) {
        if (Number.isNaN(prev)) {
          if (i >= w - 1) {
            let s = 0
            for (let j = i - w + 1; j <= i; j++) s += px[j]
            prev = s / w
            out[i] = prev !== 0 ? wrap(px[i] / prev - 1) : null
          }
        } else {
          prev = px[i] * k + prev * (1 - k)
          out[i] = prev !== 0 ? wrap(px[i] / prev - 1) : null
        }
      }
      return out
    },
  },
  {
    id: 'rsi',
    labelCn: 'RSI强度',
    category: '震荡',
    compute: (c, w) => {
      const px = closeArr(c)
      const out: (number | null)[] = new Array(px.length).fill(null)
      let gain = 0
      let loss = 0
      for (let i = 1; i < px.length; i++) {
        const d = px[i] - px[i - 1]
        const g = d > 0 ? d : 0
        const l = d < 0 ? -d : 0
        gain += g
        loss += l
        if (i > w) {
          const dOld = px[i - w] - px[i - w - 1]
          gain -= dOld > 0 ? dOld : 0
          loss -= dOld < 0 ? -dOld : 0
        }
        if (i >= w) {
          const rs = loss === 0 ? Number.POSITIVE_INFINITY : gain / loss
          const rsi = loss === 0 ? 100 : 100 - 100 / (1 + rs)
          out[i] = wrap(rsi / 100 - 0.5)
        }
      }
      return out
    },
  },
  {
    id: 'range_pos',
    labelCn: '区间位置',
    category: '通道',
    compute: (c, w) => {
      const hi = highArr(c)
      const lo = lowArr(c)
      const out: (number | null)[] = new Array(c.length).fill(null)
      for (let i = w - 1; i < c.length; i++) {
        let h = -Infinity
        let l = Infinity
        for (let j = i - w + 1; j <= i; j++) {
          if (hi[j] > h) h = hi[j]
          if (lo[j] < l) l = lo[j]
        }
        out[i] = h > l ? wrap((c[i].c - l) / (h - l) - 0.5) : null
      }
      return out
    },
  },
  {
    id: 'atr_ratio',
    labelCn: 'ATR占比',
    category: '波动率',
    compute: (c, w) => {
      const tr: number[] = c.map((x, i) =>
        i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)),
      )
      const a = smaOf(tr, w)
      return c.map((x, i) => (Number.isFinite(a[i]) && x.c > 0 ? wrap(a[i] / x.c) : null))
    },
  },
  {
    id: 'realized_vol',
    labelCn: '实现波动率',
    category: '波动率',
    compute: (c, w) => {
      const px = closeArr(c)
      const r: number[] = px.map((v, i) => (i === 0 || px[i - 1] <= 0 ? Number.NaN : v / px[i - 1] - 1))
      const s = stdOf(r.map((v) => (Number.isFinite(v) ? v : 0)), w)
      return r.map((_, i) => (Number.isFinite(s[i]) ? wrap(s[i]) : null))
    },
  },
  {
    id: 'volume_z',
    labelCn: '成交量标准分',
    category: '量能',
    compute: (c, w) => {
      const v = volArr(c)
      const m = smaOf(v, w)
      const s = stdOf(v, w)
      return v.map((x, i) => (Number.isFinite(m[i]) && s[i] > 0 ? wrap((x - m[i]) / s[i]) : null))
    },
  },
  {
    id: 'price_volume_corr',
    labelCn: '量价相关',
    category: '量价',
    minWindow: PV_MIN_OBS,
    compute: (c, w) => {
      const px = closeArr(c)
      const v = volArr(c)
      const dr: number[] = new Array(c.length).fill(Number.NaN)
      const dv: number[] = new Array(c.length).fill(Number.NaN)
      for (let i = 1; i < c.length; i++) {
        dr[i] = px[i - 1] > 0 ? px[i] / px[i - 1] - 1 : Number.NaN
        dv[i] = v[i] - v[i - 1]
      }
      return c.map((_, i) => {
        if (i < w) return null
        const xs: number[] = []
        const ys: number[] = []
        for (let j = i - w + 1; j <= i; j++) {
          if (Number.isFinite(dr[j]) && Number.isFinite(dv[j])) {
            xs.push(dr[j])
            ys.push(dv[j])
          }
        }
        if (xs.length < PV_MIN_OBS) return null
        // ⚠️ 这里**不能**用 `spearman`：它要求 ≥30 个配对，而本因子的样本量
        //    就是窗口长度 w（默认窗口从 4 起），于是 w<30 的每一位都返回 null、
        //    整条因子恒为空。滚动窗口与样本级是两种口径，别共用一个下限。
        return rankCorr(xs, ys, PV_MIN_OBS)
      })
    },
  },
  {
    id: 'drawdown',
    labelCn: '距高点回撤',
    category: '回撤',
    compute: (c, w) => {
      const px = closeArr(c)
      const out: (number | null)[] = new Array(c.length).fill(null)
      // 滚动窗口内的最高收盘：用单调队列保证 O(n)，且只回看
      const dq: number[] = []
      for (let i = 0; i < c.length; i++) {
        while (dq.length > 0 && px[dq[dq.length - 1]] <= px[i]) dq.pop()
        dq.push(i)
        while (dq[0] < i - w + 1) dq.shift()
        const peak = px[dq[0]]
        out[i] = i >= w - 1 && peak > 0 ? wrap(px[i] / peak - 1) : null
      }
      return out
    },
  },
  {
    id: 'ts_rank',
    labelCn: '收盘时序排名',
    category: '排序',
    compute: (c, w) => {
      const px = closeArr(c)
      const out: (number | null)[] = new Array(c.length).fill(null)
      for (let i = w - 1; i < c.length; i++) {
        let below = 0
        for (let j = i - w + 1; j <= i; j++) if (px[j] < px[i]) below++
        out[i] = wrap(below / w - 0.5)
      }
      return out
    },
  },
  {
    id: 'efficiency',
    labelCn: '趋势效率',
    category: '趋势',
    compute: (c, w) => {
      const px = closeArr(c)
      const out: (number | null)[] = new Array(c.length).fill(null)
      for (let i = w; i < c.length; i++) {
        let path = 0
        for (let j = i - w + 1; j <= i; j++) path += Math.abs(px[j] - px[j - 1])
        out[i] = path > 0 ? wrap(Math.abs(px[i] - px[i - w]) / path) : null
      }
      return out
    },
  },
  {
    id: 'upper_wick',
    labelCn: '上影线压力',
    category: '形态',
    compute: (c, w) => {
      const raw = c.map((x) => {
        const span = x.h - x.l
        return span > 0 ? (x.h - Math.max(x.o, x.c)) / span : 0
      })
      const m = smaOf(raw, w)
      return raw.map((_, i) => (Number.isFinite(m[i]) ? wrap(m[i] - 0.3) : null))
    },
  },
]

const BASE_BY_ID = new Map(FACTOR_BASES.map((b) => [b.id, b]))

/**
 * 变换层。
 *
 * ⚠️ 刻意**不包含** z-score / 全样本标准化这类仿射变换：
 * 秩相关在仿射变换下不变，所以它们产出的"新因子"与原始因子
 * 在评价口径上完全等价 —— 上游按 slug 去重会把它们全部当成新因子收下，
 * 于是 33 个原始机制被放大成 2640 个"因子"。本项目靠 maxDuplicateCorr
 * 在评价阶段拦掉，但更省算力的做法是根本不生成它们。
 */
export const FACTOR_TRANSFORMS: Array<{ id: string; labelCn: string; apply(s: (number | null)[], w: number): (number | null)[] }> = [
  { id: 'raw', labelCn: '原值', apply: (s) => s },
  {
    id: 'delta',
    labelCn: '变化',
    apply: (s, w) =>
      s.map((v, i) => {
        const p = i - Math.max(1, Math.round(w / 5))
        if (v === null || p < 0 || s[p] === null) return null
        return wrap(v - (s[p] as number))
      }),
  },
  {
    id: 'smooth',
    labelCn: '平滑',
    apply: (s, w) => {
      const filled = s.map((v) => (v === null ? Number.NaN : v))
      const k = Math.max(2, Math.round(w / 3))
      const m = smaOf(filled.map((v) => (Number.isFinite(v) ? v : 0)), k)
      return s.map((v, i) => (v === null || !Number.isFinite(m[i]) ? null : wrap(m[i])))
    },
  },
  {
    id: 'vol_scaled',
    labelCn: '波动缩放',
    apply: (s, w) => {
      const filled = s.map((v) => (v === null ? 0 : v))
      const sd = stdOf(filled, w)
      return s.map((v, i) => (v === null || !Number.isFinite(sd[i]) || sd[i] <= 0 ? null : wrap(v / sd[i])))
    },
  },
  {
    id: 'compress',
    labelCn: '压缩',
    apply: (s) => s.map((v) => (v === null ? null : wrap(Math.tanh(v)))),
  },
]

/** 因子序列：基础机制 → 变换。返回与 K 线等长的数组，空值用 null。 */
export function factorSeries(spec: Pick<FactorSpec, 'base' | 'transform' | 'window'>, candles: Candle[]): (number | null)[] {
  const base = BASE_BY_ID.get(spec.base)
  if (!base) throw new Error(`未知因子基础机制：${spec.base}`)
  const tf = FACTOR_TRANSFORMS.find((t) => t.id === spec.transform)
  if (!tf) throw new Error(`未知因子变换：${spec.transform}`)
  if (!Number.isInteger(spec.window) || spec.window < 2) throw new Error(`因子窗口非法：${spec.window}`)
  // ★ base 序列只跟 (base, window, candles) 有关，**与 transform 无关**：
  //   5 个变换共用同一条 base 序列。不缓存的话，横截面扫描（142 因子 × N 个持有期
  //   × 10 个品种）会把同一条 base 序列重算 5N 遍 —— 那些时间全花在重复劳动上。
  //   缓存键含 base 与 window；`memoDerived` 以**数组身份**为一级键并核对
  //   (length, 首末 t) 指纹，所以调用方就地改数组不会被悄悄喂旧序列。
  const raw = memoDerived(candles, `factorBase:${spec.base}:${spec.window}`, () => base.compute(candles, spec.window))
  return tf.apply(raw, spec.window)
}

// ─────────────────────────────────────────────────────────────────────────────
// 未来函数检测
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「这个序列在 t 时刻的值，会不会随 t 之后的数据变化？」
 *
 * `compute` 是"把一段 K 线算成一条与它等长的序列"的函数。
 * 判据：对若干个采样点 t，`compute(candles.slice(0, t+1))[t]` 必须与
 * `compute(candles)[t]` 相同。偷看未来的实现（居中窗口、全样本均值标准化、
 * 用未来极值做归一）会在这两条路径上给出不同的数 —— 这是**可执行的**判据，
 * 不是"读代码看着像没有"。
 *
 * 三态返回：
 *   true  = 确认偷看未来
 *   false = 采样点全部一致（且至少有一个可用采样点）
 *   null  = **没有任何可用采样点**（都在预热区、值为空）⇒ 无法判定
 *
 * `null` 与 `false` 必须在消费方被分开对待。把它们写成 `if (!lookahead)`
 * 会让"没检查"静默变成"检查通过"—— 本项目已经栽过多次的形态。
 */
export function looksAhead(
  compute: (cs: Candle[]) => (number | null)[],
  candles: Candle[],
  samples = 5,
): LookaheadVerdict {
  if (candles.length < 60) return null
  const full = compute(candles)
  let usable = 0
  for (let s = 0; s < samples; s++) {
    // 采样点取在中后段：前段多半落在预热区（值恒为 null），检不出任何东西
    const t = Math.floor(candles.length * (0.5 + (0.45 * s) / Math.max(1, samples - 1)))
    if (t <= 0 || t >= candles.length) continue
    const a = full[t]
    const b = compute(candles.slice(0, t + 1))[t]
    if (a === null && b === null) continue
    usable++
    if (a === null || b === null) return true
    const scale = Math.max(1e-12, Math.abs(a), Math.abs(b))
    if (Math.abs(a - b) / scale > 1e-9) return true
  }
  return usable === 0 ? null : false
}

export function factorLooksAhead(
  spec: Pick<FactorSpec, 'base' | 'transform' | 'window'>,
  candles: Candle[],
  samples = 5,
): LookaheadVerdict {
  return looksAhead((cs) => factorSeries(spec, cs), candles, samples)
}

// ─────────────────────────────────────────────────────────────────────────────
// 指标计算
// ─────────────────────────────────────────────────────────────────────────────

/** 默认评价期限组（根）。上游用 1/3/5/10/20 日，这里是 15m K 线的根数。 */
export const DEFAULT_HORIZONS = [1, 4, 12, 48, 96] as const

export interface EvalOptions {
  horizons?: readonly number[]
  /** ICIR 的分块宽度（根）。 */
  blockBars?: number
}

function forwardReturns(candles: Candle[], h: number): number[] {
  const out: number[] = new Array(candles.length).fill(Number.NaN)
  for (let i = 0; i + h < candles.length; i++) {
    const a = candles[i].c
    const b = candles[i + h].c
    out[i] = a > 0 ? b / a - 1 : Number.NaN
  }
  return out
}

export function computeFactorMetrics(
  spec: FactorSpec,
  candles: Candle[],
  opts: EvalOptions = {},
  seriesOverride?: (number | null)[],
): FactorMetrics {
  const horizons = opts.horizons ?? DEFAULT_HORIZONS
  const blockBars = opts.blockBars ?? 240
  const n = candles.length
  const series = seriesOverride ?? factorSeries(spec, candles)

  let finite = 0
  for (const v of series) if (v !== null) finite++
  const coverage = n > 0 ? finite / n : 0

  const xs = series.map((v) => (v === null ? Number.NaN : v))
  // 主期限：优先 5 根；期限组里没有 5 就取中间那一档。
  // 分块 IC 只在这个期限上算 —— 把不同期限的 IC 混进同一个分布，
  // ICIR 就变成"跨期限离散度"，而它想表达的本来是"同一期限上的稳定性"。
  const primaryH = horizons.includes(5) ? 5 : horizons[Math.min(Math.floor(horizons.length / 2), horizons.length - 1)]
  const icByHorizon: Record<string, number | null> = {}
  const blockIcs: number[] = []

  for (const h of horizons) {
    const fwd = forwardReturns(candles, h)
    const ic = spearman(xs, fwd)
    icByHorizon[String(h)] = ic
    if (h !== primaryH) continue
    const blocks = Math.floor(n / blockBars)
    for (let b = 0; b < blocks; b++) {
      const lo = b * blockBars
      const hi = lo + blockBars
      const bic = spearman(xs.slice(lo, hi), fwd.slice(lo, hi))
      if (bic !== null) blockIcs.push(bic)
    }
  }
  const primary = icByHorizon[String(primaryH)] ?? null

  let icir: number | null = null
  if (blockIcs.length >= 3) {
    const m = blockIcs.reduce((a, b) => a + b, 0) / blockIcs.length
    const v = blockIcs.reduce((a, b) => a + (b - m) ** 2, 0) / blockIcs.length
    const sd = Math.sqrt(v)
    icir = sd > 0 ? m / sd : null
  }

  // 分位差与换手：都在主期限 5 根上算
  const fwd5 = forwardReturns(candles, 5)
  // ★ 必须把**原始 K 线序号**一起带上。`pairs` 是过滤后的列表，
  // 它的下标与 K 线下标不是一回事；曾经用过滤后的下标去查
  // "这根是不是在高信号区"，判定结果会整体错位，而换手看上去仍是个正常数字。
  const pairs: Array<{ i: number; s: number; r: number }> = []
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(xs[i]) || Number.isNaN(fwd5[i])) continue
    pairs.push({ i, s: xs[i], r: fwd5[i] })
  }
  let quantileSpreadBps: number | null = null
  let turnover: number | null = null
  if (pairs.length >= 50) {
    const sorted = [...pairs].sort((a, b) => a.s - b.s)
    const k = Math.max(1, Math.floor(sorted.length * 0.2))
    const bottom = sorted.slice(0, k)
    const top = sorted.slice(sorted.length - k)
    const mean = (vs: Array<{ r: number }>) => vs.reduce((a, x) => a + x.r, 0) / vs.length
    quantileSpreadBps = (mean(top) - mean(bottom)) * 10_000

    // 换手：Top20% 成分**相邻两根**之间是否变动。
    // 刻意不在"整个样本"上判成员资格之后再去数时间序列的自相关 ——
    // 那是另一件事（信号的自相关），不是换手。这里数的是：
    // 站在第 i 根上，该不该持有；与第 i-1 根比有没有变。
    const topIdx = new Set(top.map((p) => p.i))
    let flips = 0
    let counted = 0
    for (let i = 1; i < n; i++) {
      if (Number.isNaN(xs[i]) || Number.isNaN(xs[i - 1])) continue
      counted++
      if (topIdx.has(i) !== topIdx.has(i - 1)) flips++
    }
    turnover = counted > 0 ? flips / counted : null
  }

  return {
    spec,
    bars: n,
    coverage,
    icByHorizon,
    icMean5: primary,
    icir,
    quantileSpreadBps,
    turnover,
    maxAbsCorrWithPool: null,
    nearestSlug: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 三态门
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorGateInput {
  metrics: FactorMetrics
  origin: FactorOrigin
  lookahead: LookaheadVerdict
}

/**
 * 因子闸门。顺序**是有意义的**，不能重排：
 *
 *   ① 未来函数  —— 硬红线。它是**代码缺陷**，与数据来源无关；
 *                  诚实的合成数据配上偷看未来的因子，照样必须拒。
 *   ② 零产出    —— 一个有效值都没有 ⇒ rejected（支配性结论，见函数内注释）。
 *                  它必须排在 ③ 之前：空序列上未来函数检测只能返回"检不了"，
 *                  而那个状态会被读成"证据不足、再攒点数据"—— 错误的处置。
 *   ③ 未来函数的"检不了" —— 不放行（fail-closed）。
 *   ④ 数据来源  —— 非真实历史一律 `unverifiable`。这是本项目从
 *                  `server/evidence.ts` 继承的立场：合成 GBM 里不存在
 *                  可被捕捉的结构，在它上面"通过"的因子不构成任何证据。
 *   ⑤ 样本量    —— 不足一律 `unverifiable`（fail-closed，不放行）。
 *   ⑥ 覆盖率    —— 这里**不能**降级为 unverifiable：一个只在 3% 的根上有值的
 *                  因子不是"核不了"，是它确实不产出信号。判 rejected。
 *   ⑦ 重复生产  —— 与已入池因子秩相关过高的，判 rejected。
 *   ⑧ 门槛      —— |IC| / ICIR / 换手。
 *
 * 阈值全部走参数（默认 `DEFAULT_FACTOR_GATE`）：门必须可注入，
 * 否则测试只能验证"它在真实数据上的结论"，无法验证"它会不会拒绝"。
 */
export function judgeFactor(
  input: FactorGateInput,
  th: FactorGateThresholds = DEFAULT_FACTOR_GATE,
): FactorVerdict {
  const { metrics, origin, lookahead } = input

  if (lookahead === true) {
    return { state: 'rejected', gate: 'lookahead', reason: '因子偷看未来：截断到 t 重算后第 t 位与全量计算不一致' }
  }
  if (metrics.bars >= th.minBars && metrics.coverage <= 0) {
    // ── 「一个有效值都没有」必须先于「未来函数检不了」判 ──────────────
    // 空序列上 looksAhead 只能返回 null（没有采样点可比较），而 null 被读成
    // "证据不足、攒数据再来" —— 那是**错误的处置**：样本量已经达标，
    // 攒再多它也不会有输出，真因在因子自己身上（窗口小于统计量所需，
    // 或 compute 的前置条件恒不成立）。
    //
    // 顺序上也没问题：它是**支配性**结论 —— 无论这个因子偷不偷看未来，
    // 都不该被接受，所以提前判掉不可能把任何一个"通过"变成"不通过"。
    // 样本量不达标时不走这条路（那种情况本来就该 unverifiable，攒数据有用）。
    return {
      state: 'rejected',
      gate: 'coverage',
      reason:
        `覆盖率 0.0%（${metrics.bars} 根上没有任何有效值）：该因子一个时点都不产出信号，` +
        '这不是"证据不足"—— 查窗口是否小于统计量所需，或 compute 的前置条件是否恒不成立',
    }
  }
  if (lookahead === null) {
    // 刻意分开写。写成 `!lookahead` 会把"没检出"当成"没检查"，
    // 而这里两者含义相反：null 是"检不了"，必须不放行。
    return { state: 'unverifiable', gate: 'lookahead-unknown', reason: '未来函数检测无可用采样点，无法判定' }
  }
  if (origin !== 'history') {
    return {
      state: 'unverifiable',
      gate: 'origin',
      reason: `数据来源为 ${origin}，不构成因子有效性证据（合成/注入行情上通过的因子不得进入生产结论）`,
    }
  }
  if (metrics.bars < th.minBars) {
    return { state: 'unverifiable', gate: 'bars', reason: `样本 ${metrics.bars} 根 < 下限 ${th.minBars}，证据不足` }
  }
  if (metrics.coverage < th.minCoverage) {
    return {
      state: 'rejected',
      gate: 'coverage',
      reason: `覆盖率 ${(metrics.coverage * 100).toFixed(1)}% < ${(th.minCoverage * 100).toFixed(0)}%，该因子在多数时点不产出信号`,
    }
  }
  if (metrics.turnover !== null && metrics.turnover > th.maxTurnover) {
    return {
      state: 'rejected',
      gate: 'turnover',
      reason: `换手 ${(metrics.turnover * 100).toFixed(1)}%/根 > ${(th.maxTurnover * 100).toFixed(0)}%，成本会吃掉信号`,
    }
  }
  if (metrics.maxAbsCorrWithPool !== null && metrics.maxAbsCorrWithPool > th.maxDuplicateCorr) {
    return {
      state: 'rejected',
      gate: 'duplicate',
      reason: `与 ${metrics.nearestSlug} 秩相关 ${metrics.maxAbsCorrWithPool.toFixed(3)} > ${th.maxDuplicateCorr}，属重复生产`,
    }
  }
  const ic = metrics.icMean5
  if (ic === null) {
    return { state: 'unverifiable', gate: 'ic', reason: '主期限 IC 无法计算（有效配对不足）' }
  }
  if (Math.abs(ic) < th.minAbsIc) {
    return { state: 'rejected', gate: 'ic', reason: `|IC| ${Math.abs(ic).toFixed(4)} < ${th.minAbsIc}，信号与未来收益基本无关` }
  }
  if (metrics.icir === null) {
    // ICIR 算不出来有两种成因，两种都属于**证据不足**而不是"因子不行"：
    // 分块数 < 3（样本太短），或分块 IC 的标准差为 0（每个分块一模一样，
    // 那是数据退化，不是稳定）。把它们判成 rejected 会让"样本不够"
    // 表现为"因子被否定"，而前者的正确处置是攒数据后重试。
    return { state: 'unverifiable', gate: 'icir-unknown', reason: 'ICIR 无法计算（分块不足或分块 IC 无离散度）' }
  }
  if (Math.abs(metrics.icir) < th.minIcir) {
    return { state: 'rejected', gate: 'icir', reason: `ICIR ${metrics.icir.toFixed(3)} < ${th.minIcir}，IC 忽正忽负不可用` }
  }
  return {
    state: 'accepted',
    gate: 'pass',
    reason: `|IC| ${Math.abs(ic).toFixed(4)} · ICIR ${metrics.icir.toFixed(3)} · 覆盖 ${(metrics.coverage * 100).toFixed(1)}% · 换手 ${((metrics.turnover ?? 0) * 100).toFixed(1)}%/根`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 批量生产
// ─────────────────────────────────────────────────────────────────────────────

/** 生产用窗口组（根）。15m K 线下相当于 3 小时 ~ 5 天。 */
export const DEFAULT_WINDOWS = [4, 8, 16, 24, 48, 96, 192] as const

export function slugFor(base: string, transform: string, window: number): string {
  return `${base}_${transform}_${window}`
}

/**
 * 按声明的基因空间展开候选，并跳过索引里已有的 slug。
 *
 * 与上游 `all_candidate_specs` 的差别只有一处、但是关键的一处：
 * 上游按"笛卡尔积顺序取前 N 个"，本项目按**窗口由短到长、机制优先**
 * 的固定顺序取，且顺序不依赖运行时状态。原因是批量生产的输出要被
 * 写进索引并被后续批次增量消费 —— 顺序不稳定会导致"同一批请求产出不同的因子集"，
 * 而那种不确定性在台账里表现为"因子 ID 对不上"，事后无法复现任何结论。
 */
export function generateFactorBatch(
  existingSlugs: Iterable<string>,
  count: number,
  windows: readonly number[] = DEFAULT_WINDOWS,
): FactorSpec[] {
  const seen = new Set(existingSlugs)
  const out: FactorSpec[] = []
  for (const window of windows) {
    for (const base of FACTOR_BASES) {
      // 低于机制自己声明的下限 ⇒ 该窗口**算不出值**，展开它等于凭空造一个
      // 永远为空的候选。判据与产出共用 minWindowFor()，不各写一份。
      if (window < minWindowFor(base)) continue
      for (const tf of FACTOR_TRANSFORMS) {
        if (out.length >= count) return out
        const slug = slugFor(base.id, tf.id, window)
        if (seen.has(slug)) continue
        seen.add(slug)
        out.push({
          slug,
          nameCn: `${window}根${tf.labelCn}${base.labelCn}`,
          category: base.category,
          base: base.id,
          transform: tf.id,
          window,
        })
      }
    }
  }
  return out
}

export interface BatchEntry {
  metrics: FactorMetrics
  verdict: FactorVerdict
}

export interface BatchResult {
  origin: FactorOrigin
  dataHash: string
  entries: BatchEntry[]
  accepted: number
  rejected: number
  unverifiable: number
}

/**
 * 跑一批因子：算指标 → 过门 → 通过者进池（供后续去冗余）。
 *
 * 池只装**已通过**的因子。把被拒的也放进池会让去冗余拿一个
 * 本身无效的因子当参照物，于是"两个都没用的因子互相掩护"。
 */
export function evaluateFactorBatch(
  specs: FactorSpec[],
  candles: Candle[],
  origin: FactorOrigin,
  dataHash: string,
  th: FactorGateThresholds = DEFAULT_FACTOR_GATE,
  opts: EvalOptions = {},
): BatchResult {
  const poolXs: number[][] = []
  const poolSlugs: string[] = []
  const entries: BatchEntry[] = []
  let accepted = 0
  let rejected = 0
  let unverifiable = 0

  for (const spec of specs) {
    // 序列只算一次：指标、去冗余、入池三处用的是**同一份**序列。
    // 各算一遍不仅慢，更危险 —— 一旦某处口径漂移（例如忘了传 window），
    // 去冗余会拿一份序列、评价拿另一份，两者的结论互相矛盾且都"算对了"。
    const series = factorSeries(spec, candles)
    const xs = series.map((v) => (v === null ? Number.NaN : v))
    const metrics = computeFactorMetrics(spec, candles, opts, series)

    let best = -1
    let nearest: string | null = null
    for (let i = 0; i < poolXs.length; i++) {
      const r = spearman(xs, poolXs[i])
      if (r !== null && Math.abs(r) > best) {
        best = Math.abs(r)
        nearest = poolSlugs[i]
      }
    }
    metrics.maxAbsCorrWithPool = best >= 0 ? best : null
    metrics.nearestSlug = nearest

    const verdict = judgeFactor({ metrics, origin, lookahead: factorLooksAhead(spec, candles) }, th)
    if (verdict.state === 'accepted') {
      accepted++
      poolXs.push(xs)
      poolSlugs.push(spec.slug)
    } else if (verdict.state === 'rejected') {
      rejected++
    } else {
      unverifiable++
    }
    entries.push({ metrics, verdict })
  }

  return { origin, dataHash, entries, accepted, rejected, unverifiable }
}
