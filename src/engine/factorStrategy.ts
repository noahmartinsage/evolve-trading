/**
 * 因子 → 策略：把因子台账里**通过三态门**的因子接进策略生产链。
 *
 * ══ 这一层要回答的问题 ═════════════════════════════════════════════════
 * 因子层的结论是「这个信号与未来收益有单调关系」，那**不是**「能赚钱」。
 * 两者之间隔着三样东西，任何一样都能把 IC 吃掉：
 *   ① 手续费与滑点（因子层完全不含成本）
 *   ② 换手（信号强但每根翻转 ⇒ 全交给交易所）
 *   ③ 方向（IC 为负的因子，照原方向做就是稳定亏钱）
 * 所以「接进策略生产」不是把 slug 抄过来，而是**重新在策略语义下过一遍门**。
 *
 * ══ ★ 关于「取反」—— 它是被允许的，但**不是免费后门** ═══════════════════
 * 产品上允许：稳定负 IC 的因子被接受后，消费方可以取反。
 * 这条许可的条件就写在 `deriveSignFromTrain` 里：
 *
 *     符号必须由**样本内** IC 决定 → 然后在**样本外**逐折验证它是否一致。
 *
 * 如果反过来，拿全样本（含样本外）算 IC 再定方向，那"取反"就变成了
 * 「我先看看哪边赚钱，再宣称那边是我的方向」—— 这是过拟合最标准的形态，
 * 而且它伪装得极好：回测曲线漂亮、胜率也高，看不出任何异常。
 * 所以本模块里**没有任何一处**允许调用方传入方向。
 *
 * ══ ★ 关于「保证胜率」—— 0 笔平仓不是 0% 胜率 ═════════════════════════
 * `Report.winRatePct` 的分母是 `realizedPnls.length`（**平仓**笔数）。
 * 一笔都没平过时它返回 0 —— 看上去就是"胜率不达标，拒绝"。
 * 但真相是"没有证据"，两者要做的事完全不同（一个是换因子，一个是换窗口）。
 * 因此闸门里把「平仓笔数不足」放在「胜率不达标」**之前**，判 `unverifiable`。
 * 判据 17 那一族：哑的失败必须额外造一个观测点，否则它不会被发现。
 *
 * ══ 三态，且少的那一档必须能说出理由 ═════════════════════════════════
 *   accepted      —— 符号稳定 + 每折扣费后不亏 + 胜率/笔数/回撤全过
 *   rejected      —— 有证据说它不行（方向不稳定、成本吃光、胜率不够）
 *   unverifiable  —— 核不了（非真实数据、折数不够、样本内 IC 都定不了方向）
 */
import type { Candle, ExecConfig } from './types.ts'
import { DEFAULT_EXEC } from './types.ts'
import { runBacktest } from './backtest.ts'
import { computeReport } from './report.ts'
import { contentHash } from './history.ts'
import { computeFactorMetrics, factorSeries } from './factorEval.ts'
import type { FactorOrigin, FactorSpec } from './factorEval.ts'
import { memoDerived } from './seriesCache.ts'
import type { Strategy, StrategyDecision } from './strategies.ts'

export const FACTOR_STRATEGY_VERSION = 'factor-strategy-v1'

/**
 * ★ 成本拖累这一列的**显示名**。名字里必须带"均值"。
 *
 * 为什么把它做成一个导出的常量、而不是直接写在面板的 JSX 里：
 * `costDragPct` 是**各折拖累的均值**，而它左边两列（毛最差折 / 净最差折）是**各自的最小值**，
 * 那两个最小值**可以来自不同的折**。三列并排却不写"均值"，用户会照着相减 ——
 * 实测某行相减得 54.23，而引擎报的是 58.2，于是这张表上出现了同一个事实的两份副本，
 * 且用户无从判断哪个对。做成常量之后，`test:factors` 的 F15 能把它钉住。
 */
export const COST_DRAG_LABEL = '成本拖累(均值)'

/** 三列并排时必须一起出现的读法说明。同样由 F15 钉住。 */
export const COST_DRAG_NOTE = '成本拖累是各折均值；两个「最差折」可能来自不同的折 ⇒ 三列不可相减'

/**
 * ★ 每笔口径两列的显示名与读法。**理由与 `COST_DRAG_LABEL` 完全一样**：
 *   列名写死在 JSX 里就会被顺手缩写成"边际"/"成本"，而缩写之后**没有任何门禁会红**，
 *   于是"每笔"这个关键限定词消失，读者会把它当成"每折"的数。
 *   由 `test:factors` 的 F17 钉住。
 */
export const EDGE_PER_FILL_LABEL = '每笔毛边际(bps)'
export const COST_PER_FILL_LABEL = '每笔成本(bps)'
export const PER_FILL_NOTE =
  '每笔口径 = 该折毛收益(bps) ÷ 该折成交笔数；成本按腿收，所以分母用成交笔数而不是回合数 ⇒ 两者可直接比。' +
  '这一对是「该换因子族还是该降成本」的唯一判据'

// ─────────────────────────────────────────────────────────────────────────────
// 信号归一化：把因子值变成**零中心、无量纲**的交易信号
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把因子序列转成"相对自身近期水平的偏离"（稳健 z 分数）。
 *
 * 为什么必须做这一步：因子值本身往往不是零中心的
 * （`range_pos` ∈ [0,1]、`realized_vol` > 0、`sma_gap` 有量纲），
 * 直接拿 "值 > 0" 当买入条件，等价于拿一个**常数**当条件 ——
 * 要么全时段持仓，要么全时段空仓，两种都不是"用上了这个因子"。
 *
 * ★ 窗口取 `[i-w, i-1]`，**不含第 i 根自己**。
 *   含自己的话，一个孤立的大值会把中位数和 MAD 一起抬高、
 *   从而把自己的 z 压低 —— 信号最强的那些根反而被自己抹平。
 *   更严重的是它构成**自我参照**：判定第 i 根用的统计量里含第 i 根的信息。
 *   （它不算严格的未来函数，未来函数检测抓不到，所以必须在这里说清楚。）
 *
 * ★ MAD 过小时返回 NaN 而不是 0。窗口内因子值几乎不变 ⇒ 没有区分度，
 *   此时任何"偏离"都是浮点噪声被放大成信号，是最坏的一种假信号。
 *
 * 复杂度 O(n·w log w)，只在构建时算一次（由 memoDerived 缓存）。
 */
export function normalizeSignal(f: (number | null)[], w: number): number[] {
  const n = f.length
  const out = new Array<number>(n).fill(Number.NaN)
  // 窗口内至少要有这么多有效值，否则"中位数"没有统计意义。
  const minSamples = Math.max(8, Math.floor(w / 4))
  for (let i = 0; i < n; i++) {
    const cur = f[i]
    if (cur === null || !Number.isFinite(cur)) continue
    const lo = Math.max(0, i - w)
    const buf: number[] = []
    for (let k = lo; k < i; k++) {
      const v = f[k]
      if (v !== null && Number.isFinite(v)) buf.push(v)
    }
    if (buf.length < minSamples) continue
    buf.sort((a, b) => a - b)
    const mid = buf.length >> 1
    const med = buf.length % 2 === 1 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2
    const dev = buf.map((v) => Math.abs(v - med)).sort((a, b) => a - b)
    const dm = dev.length >> 1
    const mad = dev.length % 2 === 1 ? dev[dm] : (dev[dm - 1] + dev[dm]) / 2
    if (!(mad > 1e-12)) continue
    // 1.4826 是 MAD → σ 的一致性系数（正态下两者相等）。
    const denom = 1.4826 * mad
    if (!(denom > 1e-12)) continue
    out[i] = (cur - med) / denom
  }
  return out
}

/** 信号序列的缓存键。**必须自带全部参数**，否则会"拿 A 参数的信号算 B 参数"。 */
export function signalKey(spec: Pick<FactorSpec, 'base' | 'transform' | 'window'>, normWindow: number): string {
  return `fsig:${spec.base}:${spec.transform}:${spec.window}:nz${normWindow}`
}

function signalOf(candles: Candle[], spec: Pick<FactorSpec, 'base' | 'transform' | 'window'>, normWindow: number): number[] {
  return memoDerived(candles, signalKey(spec, normWindow), () => normalizeSignal(factorSeries(spec, candles), normWindow))
}

// ─────────────────────────────────────────────────────────────────────────────
// 策略：因子择时
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorTimingOptions {
  slug: string
  spec: Pick<FactorSpec, 'base' | 'transform' | 'window'>
  /** +1 = 因子值高则做多；-1 = 取反。**只能由 deriveSignFromTrain 产出。** */
  sign: 1 | -1
  /** 偏差超过它才入场（与 exit 构成迟滞带，避免在阈值附近来回翻转）。 */
  entry: number
  /** 偏差跌破它才出场（纯多头模式）。 */
  exit: number
  normWindow: number
  /**
   * 允许做空 ⇒ **对称择时**：偏差跌破 `-entry` 就持空，而不是清仓。
   *
   * ★ 这一项改变了策略**能不能表达看空**，而这不只是收益高低的问题：
   *   纯多头择时在下跌行情里，理论上限就是"不亏"（信号弱时清仓），
   *   毛收益**不可能为正**。实测 BTC 12 个月买入持有 −34.01%、
   *   逐折 3/5 下跌 ⇒ 70 个通过因子层的候选在策略层全灭，
   *   而当时的结论是"41 条方向不成立"。那是**错的**：
   *   同一个观测量（毛收益为负）在"信号没用"与"策略不能做空"下长得一样。
   */
  allowShort?: boolean
}

/**
 * 因子择时策略。
 *
 * 入场用 `market` 而**不是** `limit`：限价单在单边行情里可能一直不成交，
 * 候选会以 `fills=0` 静默挂在池子里 —— 本项目在 `emaRsiComboStrategy`
 * 上已经踩过同型的坑（入场条件在数学上不可能成立，策略"存在"但永远不动）。
 * 用市价单的代价是 taker 费率，那是真实的成本，不该藏。
 *
 * ★ 持仓状态有**三种**（多 / 空 / 平），而原实现只认前两种的一半：
 *   它把 `posQty <= 0` 一律当空仓。对称模式下 `posQty < 0` 是"持空"，
 *   必须与"空仓"分开处理，否则「信号转多」时会去开多而不是平空。
 */
export function factorTimingStrategy(opts: FactorTimingOptions): Strategy {
  const { slug, spec, sign, entry, exit, normWindow } = opts
  const allowShort = opts.allowShort ?? false
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !(entry > exit)) {
    throw new Error(`因子策略参数非法：需要 entry > exit，收到 entry=${entry} exit=${exit}`)
  }
  if (normWindow < 4) throw new Error(`因子策略参数非法：normWindow 至少 4，收到 ${normWindow}`)
  const EPS = 1e-12
  return {
    id: `factor:${slug}`,
    params: { sign, entry, exit, normWindow, window: spec.window, allowShort: allowShort ? 1 : 0 },
    decide(ctx): StrategyDecision | null {
      const sig = signalOf(ctx.candles, spec, normWindow)
      const v = sig[ctx.i]
      if (!Number.isFinite(v)) return null
      const dir = sign * v
      const long = ctx.posQty > EPS
      const short = ctx.posQty < -EPS
      const flat = !long && !short

      if (dir > entry) {
        if (short) return { side: 'buy', type: 'market', frac: 1 } // 平空
        if (flat) return { side: 'buy', type: 'market', frac: 0.95 } // 开多
        return null // 已持多，不动
      }
      if (allowShort) {
        if (dir < -entry) {
          if (long) return { side: 'sell', type: 'market', frac: 1 } // 平多
          if (flat) return { side: 'sell', type: 'market', frac: 0.95 } // 开空
        }
        return null
      }
      // 纯多头模式：下跌信号只清仓，不建空头（现货语义）。
      if (dir < exit && long) return { side: 'sell', type: 'market', frac: 1 }
      return null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 符号推导：只准用样本内
// ─────────────────────────────────────────────────────────────────────────────

export interface SignDerivation {
  sign: 1 | -1 | null
  /** 样本内 IC（主期限 5 根）。null = 算不出来。 */
  ic: number | null
  bars: number
  reason: string
}

/**
 * 由**样本内** IC 的符号决定交易方向。
 *
 * |IC| 不达标时返回 `sign: null` —— 因为"符号"本身此刻就是噪声。
 * 一个 |IC| = 0.001 的因子，它的正负号是抛硬币的结果，
 * 拿它当方向等于"随机选一边"，而选出来的那一边在样本外当然也会输。
 */
export function deriveSignFromTrain(
  candles: Candle[],
  spec: FactorSpec,
  minAbsIc: number,
): SignDerivation {
  const m = computeFactorMetrics(spec, candles, { horizons: [5] })
  const ic = m.icMean5
  if (ic === null || !Number.isFinite(ic)) {
    return { sign: null, ic: null, bars: candles.length, reason: '样本内 IC 算不出来（有效值不足）' }
  }
  if (Math.abs(ic) < minAbsIc) {
    return {
      sign: null,
      ic,
      bars: candles.length,
      reason: `样本内 |IC|=${Math.abs(ic).toFixed(4)} < ${minAbsIc}，符号本身是噪声`,
    }
  }
  return { sign: ic > 0 ? 1 : -1, ic, bars: candles.length, reason: '符号取自样本内 IC' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 折内评估
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorStrategyFold {
  fold: number
  sign: 1 | -1
  trainBars: number
  testBars: number
  /** 样本内 IC。 */
  trainIc: number | null
  /** 样本外 IC。用来判断"方向在这个窗口里还成立吗"。 */
  oosIc: number | null
  /** 两者符号一致。null = 有一边算不出来。 */
  signAgree: boolean | null
  /** 样本外净收益（已扣手续费与滑点），百分数。 */
  netReturnPct: number
  /**
   * 样本外**毛**收益：同一批成交、把手续费与滑点置零重跑一遍，百分数。
   *
   * ★ 这个字段存在的唯一理由是**归因**，而它是本模块开头那句承诺的落地形式：
   *   "信号没用"与"信号有用但被成本吃掉"在系统里长得完全一样（都是净收益为负）。
   *   没有毛收益，策略门给出 `rejected/return` 时没人知道该改哪一头 ——
   *   是回去找信号，还是回去降换手。
   *   ★ 实测数字写在 `docs/DEV_PROGRESS.md` 的本轮小节里，**不写在这里** ——
   *     注释里的数字不会随数据更新，它过期得比代码快，而且没人会来改它。
   */
  grossReturnPct: number
  /** 成本拖累 = 毛 − 净（百分数，正值表示成本吃掉的收益）。 */
  costDragPct: number
  /** 样本外胜率（比例，非百分数）。 */
  winRate: number
  /** 平仓笔数 —— 胜率的分母。**单独记，因为它是"有没有证据"的判据。** */
  closedTrades: number
  maxDrawdownPct: number
  fills: number
  /**
   * 每笔**成交**（fill，即一腿）的毛边际，单位 **bps**。
   *
   * ★ 为什么要有这个字段（15 轮实测逼出来的）：
   *   一个候选"亏钱"有两件完全不同的事因 —— 信号没有方向、或者每笔赚的
   *   不够付一次手续费。实测基线配置下：毛 +4.0%/折 ÷ 408 笔 ≈ **1 bp/笔**，
   *   而市价单手往返成本 **16 bps**。差 16 倍。
   *   这个 16 倍是**唯一能判定"该换因子还是该降成本"的量**，
   *   而它在毛/净/成本拖累三列里都读不出来（那三列是"每折"口径）。
   *
   * ★ 分母用 `fills` 而不是 `closedTrades`：成本是按**腿**收的
   *   （开仓一腿、平仓一腿），用回合数当分母会让两边差 2 倍 ——
   *   正是判据 22 那个"同一个后缀两种单位"的坑。
   *   毛与成本用**同一个分母**，两者才可以直接比。
   */
  grossBpsPerFill: number | null
  /** 每笔成交（fill）被成本吃掉多少，单位 **bps**。与 `grossBpsPerFill` 同分母。 */
  costBpsPerFill: number | null
  /** 该折是否爆过仓（权益归零）。**做空独有**：现货最多亏到 0。 */
  liquidated: boolean
}

export interface FactorStrategyReceipt {
  version: string
  slug: string
  origin: FactorOrigin
  dataHash: string
  bars: number
  folds: FactorStrategyFold[]
  /** 平仓笔数合计。胜率的分母。 */
  closedTrades: number
  wins: number
  /** 汇总胜率（比例）。平仓笔数为 0 时为 null，**不是 0**。 */
  winRate: number | null
  /** 最差一折的净收益。门要求每折都不亏，所以这是关键数。 */
  worstFoldReturnPct: number
  /**
   * 最差一折的**毛**收益。与 `worstFoldReturnPct` 配对读才有意义：
   * 毛正净负 ⇒ 信号有方向、被成本吃掉；毛本身就负 ⇒ 信号没用。
   */
  worstFoldGrossReturnPct: number
  /** 各折成本拖累的均值（毛 − 净，百分数）。换手越高它越大。 */
  costDragPct: number
  /**
   * 各折**毛**收益的均值（百分数）。
   *
   * ★ 它必须与 `worstFoldGrossReturnPct` **并列存在**，而不是取代它。
   *   15 轮实测：同一批数据，拿**最差折**毛收益比 0 ⇒ 1/14 条判"被成本吃掉"；
   *   拿**均值**比 0 ⇒ **11/14** 条。两个统计量给出相反结论。
   *   原因：单折毛收益 σ = 13.33%、均值仅 +4.41% ⇒ 5 抽样的最小值**天然为负**
   *   ⇒ 用 min 当判据，对**任何**弱边际策略都会判"方向不成立"。
   *   只报其中一个都会把人引错方向，所以两个都报。
   */
  meanFoldGrossReturnPct: number
  /**
   * 每笔成交的毛边际 / 成本，单位 **bps**，各折取均值。**判定"该换因子还是该降成本"就靠这一对。**
   *
   * null = 没有任何成交（连每笔口径都建不起来）—— 那是"没有证据"，不是"边际为零"。
   */
  meanGrossBpsPerFill: number | null
  meanCostBpsPerFill: number | null
  /** 各折成交笔数的均值。每笔口径的**分母来源**，必须一起报，否则那个 bps 无法复核。 */
  meanFillsPerFold: number
  worstFoldDrawdownPct: number
  /** 样本外 IC 与样本内同号的折数占比（比例）。null = 没有可判定的折。 */
  signAgreement: number | null
  /** 爆过仓的折数。**单独记** —— 否则爆仓只表现为"回撤很大"，与"亏得多"分不开。 */
  liquidatedFolds: number
  /** 门槛参数（快照）。判定由消费方做，凭据只装可观测量 + 参数快照。 */
  config: FactorStrategyConfig
  /**
   * ★ 门质量诊断：**反方向也过了**。
   *
   * 若一个候选按 A 方向通过、把因子取反后**也**通过，说明这道门对方向
   * 不敏感 —— 而"能不能赚钱"本来就应该对方向敏感。
   * 这时真正的问题不在候选，在门本身，所以判 `unverifiable` 而不是 `accepted`。
   * 判据 2 的形态：不问"它会不会红"，问"它会不会对错误的输入也放行"。
   */
  bothDirectionsPass: boolean
}

export interface FactorStrategyConfig {
  trainBars: number
  testBars: number
  barMinutes: number
  entry: number
  exit: number
  normWindow: number
  exec: ExecConfig
  /**
   * 是否对称多空。**必须进配置快照** —— 它改变的是策略语义而不是调参，
   * 一条 `accepted` 凭据若不记下它是哪种语义，事后读回去会以为
   * "这条在纯多头上也赚"，而那次评估可能压根没允许做空。
   */
  allowShort: boolean
}

export const DEFAULT_FACTOR_STRATEGY_WF = {
  /**
   * 训练窗要够长才能定符号：9600 根 15m = 100 天。
   * 再短的训练窗算出的 IC 符号在 35040 根（12 个月）上会来回翻。
   */
  trainBars: 9600,
  /**
   * 验证窗 4800 根 = 50 天。
   * ★ 它必须**远大于**因子的预热长度（window + normWindow ≤ 384），
   *   否则前 384 根不产生信号，剩下的样本既算不出胜率也算不出 IC。
   *   这是从 `walkForward` 的固定折宽继承来的约束：折内切片没有"预热前缀"，
   *   指标要自己从零算起。
   */
  testBars: 4800,
  normWindow: 96,
  entry: 0.5,
  exit: -0.25,
  /**
   * ★ 默认开：因子择时必须能表达看空，否则在下跌行情里毛收益不可能为正。
   *   打开之前实测：70 个通过因子层的候选 → 0 条通过策略门。
   *   对称化之后同一批候选的对比数字记在 `docs/DEV_PROGRESS.md`。
   */
  allowShort: true,
} as const

/**
 * 逐折结果 → 汇总观测量。**这是这三个数唯一的计算处**（面板、语音、台账都读它的输出）。
 *
 * ★ 三个量各有各的聚合方式，**不能互相推导**：
 *   - `worstFoldReturnPct` = 各折 `netReturnPct` 的**最小值**
 *   - `worstFoldGrossReturnPct` = 各折 `grossReturnPct` 的**最小值**
 *   - `costDragPct` = 各折 `costDragPct` 的**均值**（四舍五入到 2 位）
 *
 * 前两个最小值**可以来自不同的折**。所以
 * `worstFoldGrossReturnPct − worstFoldReturnPct ≠ costDragPct`
 * —— 实测某行是 54.23 vs 58.2。那个差**不代表任何一折的拖累**，
 * 所以面板上这三列的列头必须写"均值"、并且不许把它们摆成可相减的样子。
 * 这条语义由 `test:factors` 的 F15 钉住（F15 用的夹具专门让两个最小值落在不同的折上）。
 */
export function summarizeStrategyFolds(folds: FactorStrategyFold[]): {
  closedTrades: number
  wins: number
  winRate: number | null
  worstFoldReturnPct: number
  worstFoldGrossReturnPct: number
  meanFoldGrossReturnPct: number
  costDragPct: number
  meanGrossBpsPerFill: number | null
  meanCostBpsPerFill: number | null
  meanFillsPerFold: number
  worstFoldDrawdownPct: number
  signAgreement: number | null
  liquidatedFolds: number
} {
  const closedTrades = folds.reduce((s, f) => s + f.closedTrades, 0)
  const wins = folds.reduce((s, f) => s + Math.round(f.winRate * f.closedTrades), 0)
  const judged = folds.filter((f) => f.signAgree !== null)
  const r2 = (v: number) => Math.round(v * 100) / 100
  // ★ 每笔口径只在**有成交的折**上取均值。把"0 笔成交"按"每笔 0 bps"算进去，
  //   等于拿一个哑掉的观测去拉低均值 —— 那是把"没有证据"当成"边际为零"。
  const gpf = folds.map((f) => f.grossBpsPerFill).filter((v): v is number => v !== null)
  const cpf = folds.map((f) => f.costBpsPerFill).filter((v): v is number => v !== null)
  return {
    closedTrades,
    wins,
    // ★ 分母为 0 时返回 null，而不是 0。
    //   返回 0 会让下游把"没平过仓"读成"胜率 0%"，进而做出错误动作。
    winRate: closedTrades > 0 ? wins / closedTrades : null,
    worstFoldReturnPct: folds.length > 0 ? Math.min(...folds.map((f) => f.netReturnPct)) : 0,
    worstFoldGrossReturnPct: folds.length > 0 ? Math.min(...folds.map((f) => f.grossReturnPct)) : 0,
    // ★ 均值与最小值**并列**，不互相取代：15 轮实测同一批数据下两者给出**相反**的归因
    //   （min 判 1/14 条"被成本吃掉"，mean 判 11/14）。只报一个必然把人引错方向。
    meanFoldGrossReturnPct:
      folds.length > 0 ? r2(folds.reduce((s, f) => s + f.grossReturnPct, 0) / folds.length) : 0,
    costDragPct:
      folds.length > 0
        ? Math.round((folds.reduce((s, f) => s + f.costDragPct, 0) / folds.length) * 100) / 100
        : 0,
    meanGrossBpsPerFill: gpf.length > 0 ? r2(gpf.reduce((s, v) => s + v, 0) / gpf.length) : null,
    meanCostBpsPerFill: cpf.length > 0 ? r2(cpf.reduce((s, v) => s + v, 0) / cpf.length) : null,
    meanFillsPerFold: folds.length > 0 ? r2(folds.reduce((s, f) => s + f.fills, 0) / folds.length) : 0,
    worstFoldDrawdownPct: folds.length > 0 ? Math.max(...folds.map((f) => f.maxDrawdownPct)) : 0,
    signAgreement: judged.length > 0 ? judged.filter((f) => f.signAgree).length / judged.length : null,
    liquidatedFolds: folds.filter((f) => f.liquidated === true).length,
  }
}

/**
 * 在**一个**方向上跑逐折样本外评估。
 *
 * 折切分与 `walkForward` 一致（步进 = testBars，训练窗滚动），
 * 但这里不选候选 —— 候选是给定的单个策略，要判的是**它自己**在样本外行不行。
 * 选择问题（哪个候选更好）属于因子层与策略层的另一道门（PBO），
 * 混在一起会让"这个候选不行"和"这次选择不行"分不开。
 */
export function evaluateFactorStrategy(
  spec: FactorSpec,
  candles: Candle[],
  origin: FactorOrigin,
  sign: 1 | -1,
  cfg: FactorStrategyConfig,
): FactorStrategyReceipt {
  const folds: FactorStrategyFold[] = []
  let cursor = 0
  let foldNo = 0
  const strategy = factorTimingStrategy({
    slug: spec.slug,
    spec,
    sign,
    entry: cfg.entry,
    exit: cfg.exit,
    normWindow: cfg.normWindow,
    allowShort: cfg.allowShort,
  })

  while (cursor + cfg.trainBars + cfg.testBars <= candles.length) {
    foldNo += 1
    const trainStart = cursor
    const trainEnd = cursor + cfg.trainBars
    const testEnd = trainEnd + cfg.testBars

    const train = candles.slice(trainStart, trainEnd)
    const test = candles.slice(trainEnd, testEnd)

    const trainIc = computeFactorMetrics(spec, train, { horizons: [5] }).icMean5
    const oosIc = computeFactorMetrics(spec, test, { horizons: [5] }).icMean5
    const signAgree =
      trainIc === null || oosIc === null || !Number.isFinite(trainIc) || !Number.isFinite(oosIc)
        ? null
        : Math.sign(trainIc) === Math.sign(oosIc)

    const result = runBacktest(test, strategy, cfg.exec, 100_000, cfg.barMinutes, {
      allowShort: cfg.allowShort,
    })
    const report = computeReport(result, cfg.barMinutes)
    // ── 毛收益：同一批成交、费用与滑点归零重跑 ──────────────────────────
    // 为什么是"重跑一次"而不是"把成交的手续费加回去"：后者要重新实现一遍
    // 成本模型（费用 + 滑点 + 参与率上限），那就等于**同一个事实两份实现**，
    // 而且两份会在下一次改成本模型时悄悄分叉 —— 正是本项目最忌讳的形态。
    // 重跑用的是同一个 `runBacktest`，只是 exec 参数不同：口径天然一致。
    // ★ 代价实测比预期小得多：14 个因子整轮筛查 14.2s（加它之前）→ 14.1s（之后）。
    //   原因是大头在因子指标（IC / 归一化信号）而不是回测，回测这一遍被摊薄了。
    //   最初这里写的是"耗时翻倍" —— 一个**没量过**的估计，而它正好是错的。
    //   （判据 14：在拿到证据之前给一件事写原因，写下去的往往是"听起来很合理"的那个。）
    const grossReport = computeReport(
      runBacktest(
        test,
        strategy,
        { ...cfg.exec, makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0 },
        100_000,
        cfg.barMinutes,
        { allowShort: cfg.allowShort },
      ),
      cfg.barMinutes,
    )
    const closed = result.realizedPnls.length
    const wins = result.realizedPnls.filter((p) => p > 0).length
    const r2 = (v: number) => Math.round(v * 100) / 100

    folds.push({
      fold: foldNo,
      sign,
      trainBars: train.length,
      testBars: test.length,
      trainIc,
      oosIc,
      signAgree,
      netReturnPct: r2(report.totalReturnPct),
      grossReturnPct: r2(grossReport.totalReturnPct),
      // 定义成"毛 − 净"而不是"手续费合计"：它是**观测到的差额**，
      // 不需要相信成本模型算得对。三个人各自算一遍手续费，得到的数会不一样；
      // 同一次回测跑两遍的差额只有一个答案。
      costDragPct: r2(grossReport.totalReturnPct - report.totalReturnPct),
      winRate: closed > 0 ? wins / closed : 0,
      closedTrades: closed,
      maxDrawdownPct: r2(report.maxDrawdownPct),
      fills: result.fills.length,
      // ── 每笔口径：把"每折百分数"换成"每笔 bps"，才能和手续费直接比 ──────
      // 换算：1% = 100 bps ⇒ 百分数 × 100 ÷ 成交笔数。
      // 分母是 fills（腿）而不是 closedTrades（回合）：成本按腿收，
      // 用回合当分母会让毛与成本差 2 倍，而那个 2 倍会伪装成"成本比我算的小一半"。
      grossBpsPerFill: result.fills.length > 0 ? r2((grossReport.totalReturnPct * 100) / result.fills.length) : null,
      costBpsPerFill: result.fills.length > 0 ? r2(((grossReport.totalReturnPct - report.totalReturnPct) * 100) / result.fills.length) : null,
      liquidated: result.meta.liquidated,
    })
    cursor += cfg.testBars
  }

  return {
    version: FACTOR_STRATEGY_VERSION,
    slug: spec.slug,
    origin,
    dataHash: contentHash(candles),
    bars: candles.length,
    folds,
    // ★ 汇总口径只有一处实现（`summarizeStrategyFolds`）——
    //   min / min / 均值 这三者的区别本身就是判据，散在两处必然各走各的。
    ...summarizeStrategyFolds(folds),
    config: cfg,
    bothDirectionsPass: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 三态门
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorStrategyThresholds {
  /** 样本内 |IC| 下限。低于它连方向都定不了 ⇒ unverifiable。 */
  minAbsTrainIc: number
  /** 样本外 IC 与样本内同号的折数占比下限。低于它 = 因子没有稳定方向。 */
  minSignAgreement: number
  /** 每折样本外净收益下限（百分数）。默认 0 = 一折都不许亏。 */
  minOosReturnPct: number
  /** 汇总胜率下限（比例）。这是产品明确要求的"保证胜率"。 */
  minWinRate: number
  /** 汇总平仓笔数下限。**它是"有没有证据"的判据，必须排在胜率之前。** */
  minClosedTrades: number
  /** 每折最大回撤上限（百分数）。 */
  maxFoldDrawdownPct: number
  /** 折数下限。不够就判 unverifiable，不放行。 */
  minFolds: number
  /** 样本根数下限。 */
  minBars: number
  /** 与已接受策略的收益相关上限（去冗余，与因子层同源）。 */
  maxDuplicateCorr: number
}

/**
 * 默认阈值 —— **唯一出处**。这些数字是在本项目唯一可用的真实数据
 * （BTCUSDT 15m × 35040 根 = 12 个月）上标定的**下限**，
 * 目的是拦住"明显不能拿去做交易"的东西，不是"筛出好策略"。
 *
 * `minOosReturnPct: 0` 与 `minWinRate: 0.5` 都是**每折/汇总都要过**的硬条件：
 * 允许"平均下来赚"是危险的 —— 5 折里 1 折大赚 4 折小亏也会让平均值变正，
 * 而那种形态拿到实盘就是连续小亏加一次侥幸。
 */
export const DEFAULT_FACTOR_STRATEGY_GATE: FactorStrategyThresholds = {
  minAbsTrainIc: 0.02,
  minSignAgreement: 0.6,
  minOosReturnPct: 0,
  minWinRate: 0.5,
  minClosedTrades: 30,
  maxFoldDrawdownPct: 25,
  minFolds: 4,
  minBars: 20000,
  maxDuplicateCorr: 0.9,
}

/** 因子策略判决的三态。少的那一档必须能说出理由。 */
export type FactorStrategyOutcome = 'accepted' | 'rejected' | 'unverifiable'

export interface FactorStrategyVerdict {
  outcome: FactorStrategyOutcome
  /** 人可读理由。任何一档都必须非空。 */
  reason: string
  /** 命中的闸门 id，便于统计"哪道闸门最常拦人"。 */
  gate: string
}

/**
 * 因子策略闸门。顺序**是有意义的**，不能重排：
 *
 *   ① 数据来源  —— 非真实历史一律 unverifiable（与因子层同一立场）
 *   ② 样本量    —— 不足一律 unverifiable（fail-closed）
 *   ③ 折数      —— 不足一律 unverifiable。**折数是这道门最稀缺的资源**：
 *                  4 折才勉强能说"不是一次巧合"，1 折什么都没说。
 *   ④ 符号      —— 样本内方向不稳定的 ⇒ unverifiable（连方向都定不了，
 *                  不是"方向错了"）。样本外同号比例过低的 ⇒ rejected
 *                  （= 有证据说这个因子没有稳定方向）。
 *   ⑤ 平仓笔数  —— ★ 必须**排在胜率之前**。0 笔平仓时胜率读数是 0%，
 *                  但那是"没证据"不是"胜率差"，两者要做的事完全不同。
 *   ⑥ 盈利      —— 每折扣费后都不能亏。
 *   ⑦ 胜率      —— 汇总结算。
 *   ⑧ 回撤      —— 每折都不许超过上限。
 *   ⑨ 门质量    —— 反方向也过了 ⇒ 这道门对方向不敏感 ⇒ unverifiable。
 *
 * 阈值全部走参数：门必须可注入，否则测试只能验证"它在真实数据上的结论"，
 * 无法验证"它会不会拒绝"（本项目复现过 7 次的 P0）。
 */
export function judgeFactorStrategy(
  r: FactorStrategyReceipt,
  th: FactorStrategyThresholds = DEFAULT_FACTOR_STRATEGY_GATE,
): FactorStrategyVerdict {
  if (r.origin !== 'history') {
    return {
      outcome: 'unverifiable',
      gate: 'origin',
      reason: `数据来源是 ${r.origin}，不是真实历史行情 —— 在合成数据上"能赚"不构成任何证据`,
    }
  }
  if (r.bars < th.minBars) {
    return {
      outcome: 'unverifiable',
      gate: 'bars',
      reason: `样本 ${r.bars} 根 < ${th.minBars} 根，样本外结论不可信`,
    }
  }
  if (r.folds.length < th.minFolds) {
    return {
      outcome: 'unverifiable',
      gate: 'folds',
      reason: `只有 ${r.folds.length} 折样本外（需 ${th.minFolds} 折）—— 一折的结论无法区分"有效"与"这一次恰好"`,
    }
  }
  if (r.signAgreement === null) {
    return {
      outcome: 'unverifiable',
      gate: 'sign-unknown',
      reason: '样本内/样本外 IC 至少有一边算不出来，方向是否稳定无法判定',
    }
  }
  if (r.signAgreement < th.minSignAgreement) {
    return {
      outcome: 'rejected',
      gate: 'sign',
      reason:
        `样本外 IC 与样本内同号的折数只占 ${(r.signAgreement * 100).toFixed(0)}%` +
        `（需 ≥ ${(th.minSignAgreement * 100).toFixed(0)}%）—— 这个因子没有稳定方向，` +
        `取反更不解决问题（取反后同样在样本外翻来翻去）`,
    }
  }
  if (r.closedTrades < th.minClosedTrades) {
    return {
      outcome: 'unverifiable',
      gate: 'closed-trades',
      reason:
        `样本外只平仓 ${r.closedTrades} 笔（需 ≥ ${th.minClosedTrades} 笔）—— ` +
        `笔数不够时胜率是个没有意义的读数（0 笔平仓会被读成 0% 胜率，实际是"没有证据"）`,
    }
  }
  if (r.winRate === null) {
    return { outcome: 'unverifiable', gate: 'winrate-unknown', reason: '平仓笔数足够但胜率算不出来' }
  }
  if (r.worstFoldReturnPct <= th.minOosReturnPct) {
    const bad = r.folds.filter((f) => f.netReturnPct <= th.minOosReturnPct)
    // ★ 归因：把"该改哪一头"写进拒绝理由。
    //   只看净收益时，"信号没用"与"信号有用但不够付手续费"长得一模一样，
    //   而这两者的下一步动作完全相反（回去找更强的信号 / 回去降成本）。
    //   拒绝理由是这个系统里唯一会被人读到的输出，归因不是文案修饰。
    //
    // ★★ 15 轮修掉的一处真实缺陷：这里原本判的是 `worstFoldGrossReturnPct > 0`，
    //   即拿**最差那一折**的毛收益去和 0 比。而单折毛收益 σ=13.33%、均值仅 +4.41%
    //   ⇒ 5 抽样的最小值**天然为负** ⇒ 一个真有正边际的策略也会被判成"方向本身不成立"。
    //   实测同一批数据：用 min ⇒ 1/14 条判"成本问题"；用 mean ⇒ **11/14** 条。
    //   这条规则本来是用来分开"信号没用 / 被成本吃掉"的（判据 14），
    //   它自己却把 14 轮引向了"换因子族"。
    //   ⇒ 判据换成**每笔毛边际 bps vs 每笔成本 bps**：同分母、可直接比，
    //     且不受"哪一折恰好最差"这种抽样运气的摆布。
    const gpf = r.meanGrossBpsPerFill
    const cpf = r.meanCostBpsPerFill
    const grossLine = `毛收益：最差折 ${r.worstFoldGrossReturnPct}% / 平均折 ${r.meanFoldGrossReturnPct}%`
    const head =
      `${bad.length}/${r.folds.length} 折样本外净收益 ≤ ${th.minOosReturnPct}%` +
      `（最差 ${r.worstFoldReturnPct}%）；${grossLine}`
    if (gpf === null || cpf === null) {
      return {
        outcome: 'rejected',
        gate: 'return',
        reason: `${head}；且没有任何成交（每折平均 ${r.meanFillsPerFold} 笔）⇒ 每笔口径建不起来，"亏在哪"无法归因`,
      }
    }
    if (gpf <= 0) {
      return {
        outcome: 'rejected',
        gate: 'return',
        reason:
          `${head}；每笔毛边际 ${gpf} bps ≤ 0（每折平均 ${r.meanFillsPerFold} 笔）⇒ ` +
          `连不扣费的收益都守不住，**方向本身不成立**`,
      }
    }
    if (gpf < cpf) {
      return {
        outcome: 'rejected',
        gate: 'return',
        reason:
          `${head}；每笔毛边际 ${gpf} bps < 每笔成本 ${cpf} bps（差 ${(cpf / gpf).toFixed(1)} 倍）⇒ ` +
          `方向是有的，但**每笔赚的不够付一次手续费**：该降成本（maker 挂单 / 拉长持有），` +
          `**不是回去换因子族**`,
      }
    }
    // ★ fail-closed 的第三态：每笔边际明明覆盖了每笔成本，净收益却还是负的。
    //   这时该查的是这条链的算法，不是这个候选 —— 硬套一个理由会把口径错误藏起来。
    return {
      outcome: 'unverifiable',
      gate: 'attribution-inconsistent',
      reason:
        `${head}；但每笔毛边际 ${gpf} bps ≥ 每笔成本 ${cpf} bps，净收益不该为负 ⇒ ` +
        `**口径自相矛盾**，该查的是这条链的算法而不是这个候选`,
    }
  }
  if (r.winRate < th.minWinRate) {
    return {
      outcome: 'rejected',
      gate: 'winrate',
      reason: `汇总胜率 ${(r.winRate * 100).toFixed(1)}% < ${(th.minWinRate * 100).toFixed(0)}%`,
    }
  }
  if (r.worstFoldDrawdownPct > th.maxFoldDrawdownPct) {
    return {
      outcome: 'rejected',
      gate: 'drawdown',
      reason: `最差一折回撤 ${r.worstFoldDrawdownPct}% > ${th.maxFoldDrawdownPct}%`,
    }
  }
  if (r.bothDirectionsPass) {
    return {
      outcome: 'unverifiable',
      gate: 'gate-not-discriminating',
      reason:
        '正反两个方向都通过了这道门 —— 说明门本身对方向不敏感。' +
        '"能不能赚钱"本该对方向敏感，所以这时该查的是门而不是放行候选',
    }
  }
  return {
    outcome: 'accepted',
    gate: 'ok',
    reason:
      `${r.folds.length} 折样本外全部扣费为正（最差 ${r.worstFoldReturnPct}%）· ` +
      `胜率 ${(r.winRate * 100).toFixed(1)}%（${r.closedTrades} 笔）· ` +
      `方向一致率 ${(r.signAgreement * 100).toFixed(0)}%`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编排：一个因子 → 一条裁定（含门质量诊断）
// ─────────────────────────────────────────────────────────────────────────────

export interface FactorStrategyScreenResult {
  slug: string
  sign: 1 | -1 | null
  trainIc: number | null
  receipt: FactorStrategyReceipt | null
  verdict: FactorStrategyVerdict
  /** 反方向诊断是否被执行（只在主方向临放行时才跑）。 */
  reverseChecked: boolean
}

/**
 * 对一个因子做完整筛查：定符号 → 样本外逐折 → 判门 → 门质量诊断。
 *
 * ★ 反方向诊断只在**主方向已经通过**之后才跑。
 *   这不是为了省时间（虽然确实省 90%+），而是因为：
 *   诊断要回答的是"这道门放行了一个候选时，它的放行有区分力吗"。
 *   一个已经被拒的候选不需要这个问题 —— 拒它不是因为方向，是因为别的。
 */
export function screenFactorStrategy(
  spec: FactorSpec,
  candles: Candle[],
  origin: FactorOrigin,
  opts: {
    thresholds?: FactorStrategyThresholds
    config?: Partial<FactorStrategyConfig>
  } = {},
): FactorStrategyScreenResult {
  const th = opts.thresholds ?? DEFAULT_FACTOR_STRATEGY_GATE
  const wf = DEFAULT_FACTOR_STRATEGY_WF
  const cfg: FactorStrategyConfig = {
    trainBars: opts.config?.trainBars ?? wf.trainBars,
    testBars: opts.config?.testBars ?? wf.testBars,
    barMinutes: opts.config?.barMinutes ?? 15,
    entry: opts.config?.entry ?? wf.entry,
    exit: opts.config?.exit ?? wf.exit,
    normWindow: opts.config?.normWindow ?? wf.normWindow,
    // ★ 新增 config 字段时必须同时改这里与 `defaultStrategyConfig`。
    //   实测遗漏的后果：tsc 会红（好），但**只在有人真的跑 typecheck 时**；
    //   而字段漏抄导致的语义漂移（比如 allowShort 忘了传 ⇒ 悄悄退回纯多头）
    //   不会让任何回测数字看起来异常。烟测 F16 钉住"两处的键集必须完整"。
    allowShort: opts.config?.allowShort ?? wf.allowShort,
    // 执行成本必须显式给：用同一个 `exec`，否则"扣费后为正"这句话不成立。
    // 见 strategies.ts 的 DEFAULT_GRID_EXEC —— 刻意共用，不另立一套费率。
    exec: opts.config?.exec ?? DEFAULT_EXEC,
  }

  // ── ① 符号只能由样本内决定 ──────────────────────────────────────────
  const firstFoldTrain = candles.slice(0, cfg.trainBars)
  const sd = deriveSignFromTrain(firstFoldTrain, spec, th.minAbsTrainIc)
  if (sd.sign === null) {
    return {
      slug: spec.slug,
      sign: null,
      trainIc: sd.ic,
      receipt: null,
      verdict: { outcome: 'unverifiable', gate: 'train-ic', reason: sd.reason },
      reverseChecked: false,
    }
  }

  // ── ② 主方向：逐折样本外 ────────────────────────────────────────────
  const receipt = evaluateFactorStrategy(spec, candles, origin, sd.sign, cfg)
  const verdict = judgeFactorStrategy(receipt, th)

  // ── ③ 门质量诊断：只有临放行时才问"反方向会不会也过" ────────────────
  if (verdict.outcome !== 'accepted') {
    return { slug: spec.slug, sign: sd.sign, trainIc: sd.ic, receipt, verdict, reverseChecked: false }
  }
  const reverse = evaluateFactorStrategy(
    spec,
    candles,
    origin,
    (sd.sign === 1 ? -1 : 1) as 1 | -1,
    cfg,
  )
  const reverseVerdict = judgeFactorStrategy({ ...reverse, bothDirectionsPass: false }, th)
  const bothDirectionsPass = reverseVerdict.outcome === 'accepted'
  const withFlag = { ...receipt, bothDirectionsPass }
  return {
    slug: spec.slug,
    sign: sd.sign,
    trainIc: sd.ic,
    receipt: withFlag,
    verdict: judgeFactorStrategy(withFlag, th),
    reverseChecked: true,
  }
}
