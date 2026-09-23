import type { Candle, ExecConfig } from './types.ts'
import { runBacktest } from './backtest.ts'
import { computeReport } from './report.ts'
import type { Report } from './report.ts'
import { computeFitness } from './fitness.ts'
import type { Strategy } from './strategies.ts'
import {
  DEFAULT_OVERFIT_THRESHOLDS,
  OVERFIT_VERSION,
  buildOverfitReceipt,
  judgeOverfit,
  pboCscv,
  rankOf,
} from './overfit.ts'
import type { OverfitReceipt, OverfitThresholds, OverfitVerdict, PboResult } from './overfit.ts'

/**
 * 折宽（训练窗 / 验证窗的根数）。
 */
export interface WfWidth {
  trainBars: number
  testBars: number
}

/**
 * 阈值标定时的**折数口径** —— 不许随意改。
 *
 * `overfit.ts` 的默认阈值是在这个折数上标定的，原文：
 *   「赢家分位同理：均匀名次下 **8 折**均值 ≈0.5、σ≈0.10，
 *     0.60 = 0.50 + 1.0×0.10 → 单条误放行 ~16%」
 * 也就是说 `minAvgWinnerW = 0.6` 这条线只在 8 折口径下才有那个误放行率。
 *
 * 2026-09-18 实测：同一份行情、同一批候选，只把折宽从 960/240 改成
 * 14400/4800，裁定就从 REJECT 翻成 PASS（赢家分位 0.547 → 0.774）。
 * 所以折宽不是"性能参数"，它是**判据的适用条件**。
 */
export const OVERFIT_CALIBRATION_FOLDS = 8

/**
 * 折宽的**绝对下限** —— 取自原始口径（2,880 根上的 960 / 240）。
 *
 * ★ 为什么必须有下限：没有它，`trainBars = bars / 3` 在极小样本上会给出
 *   「320 根数据切成 8 折、每折训练窗 106 根」这种荒谬切法 —— 而门不会报错，
 *   它会**一本正经地给出 PASS / REJECT**。
 *
 *   这不是假设。2026-09-18 实测就是这么被抓住的：`test:autopilot` 的 S7
 *   喂约 320 根 K 线，期望 `UNVERIFIABLE`（样本不足以切折），实得 `REJECT`。
 *   根因是折数被 _上面两行_ 之外的代码固定住了 ⇒ 「样本不足」那道门
 *   （`minFolds`）**永远不可能触发** —— 又一道不可能变红的检查。
 *
 *   所以下限的作用正是：**数据不够时让折数自然变少**，把 `minFolds` 还给系统。
 */
export const WF_MIN_TRAIN_BARS = 960
export const WF_MIN_TEST_BARS = 240

/**
 * 按数据长度反推折叠宽度 —— **唯一出处**。
 *
 * ══ 为什么不能写死 bar 数 ═════════════════════════════════════════
 * 原先 autopilot 与 evidence 各写死一份 `960/240`。它是在
 * **2,880 根（30 天）** 上标定的：训练窗占 1/3、得 8 折。
 * 把真实历史扩到 35,040 根（12 个月）之后，同样的 960/240 给出
 * **142 折**，而每折训练窗仍是 10 天 —— 折数涨了 17.75 倍，
 * 同时把判据的标定条件悄悄破坏了（见 `OVERFIT_CALIBRATION_FOLDS`）。
 *
 * 两条约束（训练窗占 1/3、折数 = 8）在 2,880 根上**同时**成立，
 * 所以它们共同确定了一个唯一解，而它随数据长度自然伸缩：
 *
 *   | bar 数 | trainBars | testBars | 折数 | 训练窗 |
 *   |--------|-----------|----------|------|--------|
 *   |  2,880 |       960 |      240 |   8  |  10 天 |  ← 与原口径逐位相同
 *   | 35,040 |    11,680 |    2,920 |   8  | 121 天 |
 *
 * ★ 2,880 根那一行是一条**可断言的性质**：这个函数在原始数据规模上必须
 *   逐位退化成 `{ trainBars: 960, testBars: 240 }`。
 *   它把"我没改变原有行为"变成一条能变红的检查，而不是一句"应该没影响"。
 */
export function wfWidthFor(bars: number, targetFolds = OVERFIT_CALIBRATION_FOLDS): WfWidth {
  if (!Number.isFinite(bars) || bars < 12) return { trainBars: WF_MIN_TRAIN_BARS, testBars: WF_MIN_TEST_BARS }
  const folds = Math.max(1, Math.floor(targetFolds))
  const trainBars = Math.max(WF_MIN_TRAIN_BARS, Math.floor(bars / 3))
  const testBars = Math.max(WF_MIN_TEST_BARS, Math.floor((bars - trainBars) / folds))
  return { trainBars, testBars }
}

export interface WFConfig {
  trainBars: number
  testBars: number
  barMinutes: number
  exec: ExecConfig
}

export interface WFFold {
  fold: number
  trainRange: [number, number]
  testRange: [number, number]
  bestId: string
  isFitness: number
  oosFitness: number
  oosAnnReturnPct: number
  oosMaxDrawdownPct: number
  /**
   * 样本外**候选场的均值**。
   *
   * 为什么必须有这个数，而不是只看赢家一个人的 OOS：
   *   它是「零假设下的期望」—— 即不挑不选、随便拿一个候选的预期表现。
   *   赢家 OOS 单独看没有意义（行情好时人人皆赚），
   *   赢家 OOS 与它的**差**才是选择贡献。
   */
  oosFieldMean: number
  /** 赢家在候选场中的升序名次（1 = 最差，n = 最好）。 */
  winnerAscRank: number
  /** 赢家的归一化分位 w = ascRank/(n+1)。w > 0.5 表示优于中位数。 */
  winnerW: number
  /** 赢家 OOS − 候选场 OOS 均值 = 扣掉多重性之后的选择净收益。 */
  selectionEdge: number
  /** 该折参与比较的候选数。 */
  candidates: number
}

export interface WFAggregate {
  folds: number
  avgIsFitness: number
  avgOosFitness: number
  decayRatio: number
  /** 赢家 OOS 为正的折数占比。**保留但不再作为稳健性判据**（见 overfit.ts 的文件头）。 */
  positiveOosShare: number
  /** 赢家样本外分位均值。判据之一。 */
  avgWinnerW: number | null
  /** 选择净收益均值。判据的解读辅助量。 */
  avgSelectionEdge: number | null
  /** 回测过拟合概率。判据之一。 */
  pbo: number | null
  pboSlices: number
  pboCombinations: number
  /** 折数 / 赢家分位 / PBO 三重条件全部满足才为 true。 */
  robust: boolean
  /** 三态裁定，便于审计与 UI 展示「为什么没过」。 */
  outcome: string
  verdictSummary: string
}

export interface WFResult {
  config: WFConfig
  folds: WFFold[]
  aggregate: WFAggregate
  /** 机器凭据。**只装可观测量**，阈值判定由消费方（晋升流水线）自己做。 */
  receipt: OverfitReceipt
}

export interface PurityResult {
  candidates: number
  pairs: number
  avgCorr: number
  maxCorr: number
  homogeneous: boolean
}

export interface WFOptions {
  /** 预计算的「行=时间、列=候选」收益率矩阵。不传则由本函数按候选逐个回测生成。 */
  perf?: number[][]
  /** CSCV 切片数（偶数）。 */
  slices?: number
  /** 判定阈值。仅影响 `aggregate.robust` 这个便利字段，凭据本身不含结论。 */
  thresholds?: OverfitThresholds
  /** 数据指纹。不传时凭据里的 dataHash 为 ''，会被结构检查判为不可用 —— 这是有意的。 */
  dataHash?: string
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return Number.NaN
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const den = Math.sqrt(da * db)
  return den > 1e-12 ? num / den : Number.NaN
}

export function combinationPurity(
  candles: Candle[],
  candidates: Strategy[],
  trainBars: number,
  wf: WFConfig,
): PurityResult {
  const rets: number[][] = candidates.map((s) => {
    const segment = candles.slice(0, trainBars)
    const r = runBacktest(segment, s, wf.exec, 100_000, wf.barMinutes)
    const curve = r.equityCurve
    return curve.map((p, i) => (i === 0 ? 0 : p.equity / curve[i - 1].equity - 1))
  })

  let sum = 0
  let count = 0
  let maxAbs = 0
  for (let i = 0; i < rets.length; i++) {
    for (let j = i + 1; j < rets.length; j++) {
      const c = pearson(rets[i], rets[j])
      if (!Number.isFinite(c)) continue
      sum += c
      count += 1
      if (Math.abs(c) > maxAbs) maxAbs = Math.abs(c)
    }
  }
  const avg = count > 0 ? sum / count : Number.NaN
  return {
    candidates: candidates.length,
    pairs: count,
    avgCorr: Number.isFinite(avg) ? Math.round(avg * 1000) / 1000 : 0,
    maxCorr: Math.round(maxAbs * 1000) / 1000,
    homogeneous: Number.isFinite(avg) && avg > 0.8,
  }
}

function fitnessOf(candles: Candle[], start: number, end: number, strategy: Strategy, wf: WFConfig): { value: number; report: Report } {
  const segment = candles.slice(start, end)
  const result = runBacktest(segment, strategy, wf.exec, 100_000, wf.barMinutes)
  const report = computeReport(result, wf.barMinutes)
  const fit = computeFitness({
    annReturnPct: report.annReturnPct,
    maxDrawdownPct: report.maxDrawdownPct,
    tradesPerDay: report.tradesPerDay,
  })
  return { value: fit.value, report }
}

/**
 * 「行=时间、列=候选」的逐根收益率矩阵 —— PBO 的输入。
 *
 * 为什么用**逐根收益率**而不是每折的汇总适应度：
 *   CSCV 靠枚举时间切分来估计过拟合概率，切分的粒度越细，
 *   能枚举出的组合越多、估计越稳。若只喂「每折一个数」，
 *   总共就只有 6 个时间点，连切成 4 块都做不到，PBO 直接算不出来。
 */
function returnMatrix(candles: Candle[], candidates: Strategy[], wf: WFConfig): number[][] {
  const cols = candidates.map((s) => {
    const r = runBacktest(candles, s, wf.exec, 100_000, wf.barMinutes)
    const curve = r.equityCurve
    const rets: number[] = []
    for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1)
    return rets
  })
  const t = cols.length === 0 ? 0 : Math.min(...cols.map((c) => c.length))
  const rows: number[][] = []
  for (let i = 0; i < t; i++) rows.push(cols.map((c) => c[i]))
  return rows
}

export function walkForward(
  candles: Candle[],
  candidates: Strategy[],
  wf: WFConfig,
  opts: WFOptions = {},
): WFResult {
  if (candidates.length === 0) throw new Error('候选集为空')
  const folds: WFFold[] = []
  let cursor = 0
  let foldNo = 0
  while (cursor + wf.trainBars + wf.testBars <= candles.length) {
    foldNo += 1
    const trainStart = cursor
    const trainEnd = cursor + wf.trainBars
    const testEnd = trainEnd + wf.testBars

    // 样本内：逐个候选评估，选出适应度最高者。
    const isScores: number[] = []
    let bestIdx = -1
    let bestValue = Number.NEGATIVE_INFINITY
    let bestStrategy: Strategy | null = null
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i]
      const r = fitnessOf(candles, trainStart, trainEnd, s, wf)
      isScores.push(r.value)
      if (r.value > bestValue) {
        bestValue = r.value
        bestIdx = i
        bestStrategy = s
      }
    }
    if (!bestStrategy || bestIdx < 0) throw new Error('fold 内未选出最优候选')

    // 样本外：**对全部候选**评估，而不只是赢家。
    // 这一步是本次修复的核心 —— 缺了候选场，就无法回答
    // 「赢家的样本外表现，比随便挑一个更好吗」。
    const oosScores: number[] = []
    for (const s of candidates) {
      oosScores.push(fitnessOf(candles, trainEnd, testEnd, s, wf).value)
    }
    const oos = fitnessOf(candles, trainEnd, testEnd, bestStrategy, wf)
    const oosFieldMean = oosScores.reduce((a, b) => a + b, 0) / oosScores.length
    const rank = rankOf(oosScores, bestIdx)

    folds.push({
      fold: foldNo,
      trainRange: [candles[trainStart].t, candles[trainEnd - 1].t],
      testRange: [candles[trainEnd].t, candles[testEnd - 1].t],
      bestId: `${bestStrategy.id}:${JSON.stringify(bestStrategy.params)}`,
      isFitness: Math.round(bestValue * 1000) / 1000,
      oosFitness: Math.round(oos.value * 1000) / 1000,
      oosAnnReturnPct: Math.round(oos.report.annReturnPct * 100) / 100,
      oosMaxDrawdownPct: Math.round(oos.report.maxDrawdownPct * 100) / 100,
      oosFieldMean: Math.round(oosFieldMean * 1000) / 1000,
      winnerAscRank: rank ? rank.ascRank : 0,
      winnerW: rank ? Math.round(rank.w * 1000) / 1000 : 0,
      selectionEdge: Math.round((oos.value - oosFieldMean) * 1000) / 1000,
      candidates: candidates.length,
    })
    cursor += wf.testBars
  }

  const n = folds.length || 1
  const avgIs = folds.reduce((s, f) => s + f.isFitness, 0) / n
  const avgOos = folds.reduce((s, f) => s + f.oosFitness, 0) / n
  const positiveShare = folds.filter((f) => f.oosFitness > 0).length / n
  const decayRatio = avgIs !== 0 ? avgOos / avgIs : 0

  const perf = opts.perf ?? returnMatrix(candles, candidates, wf)
  const pbo: PboResult | null = pboCscv(perf, opts.slices ?? 10)

  const receipt = buildOverfitReceipt({
    dataHash: opts.dataHash ?? '',
    bars: candles.length,
    candidates: candidates.length,
    perFoldWinnerW: folds.map((f) => f.winnerW),
    isFitness: folds.map((f) => f.isFitness),
    oosFitness: folds.map((f) => f.oosFitness),
    perFoldSelectionEdge: folds.map((f) => f.selectionEdge),
    pbo,
  })

  const verdict: OverfitVerdict = judgeOverfit(receipt, opts.thresholds ?? DEFAULT_OVERFIT_THRESHOLDS)

  return {
    config: wf,
    folds,
    receipt,
    aggregate: {
      folds: folds.length,
      avgIsFitness: Math.round(avgIs * 1000) / 1000,
      avgOosFitness: Math.round(avgOos * 1000) / 1000,
      decayRatio: Math.round(decayRatio * 1000) / 1000,
      positiveOosShare: Math.round(positiveShare * 1000) / 1000,
      avgWinnerW: receipt.avgWinnerW,
      avgSelectionEdge: receipt.avgSelectionEdge,
      pbo: receipt.pbo,
      pboSlices: receipt.pboSlices,
      pboCombinations: receipt.pboCombinations,
      robust: verdict.pass,
      outcome: verdict.outcome,
      verdictSummary: verdict.summary,
    },
  }
}

/**
 * 一步产出可直接交给晋升流水线的过拟合凭据。
 *
 * 存在的意义是让**调用方没有机会只传一个布尔量**：
 * 想提交凭据就必须真的把 walk-forward 跑完，
 * 而凭据里的 dataHash 会把「针对哪批行情算的」钉死。
 */
export function computeOverfitReceipt(
  candles: Candle[],
  candidates: Strategy[],
  wf: WFConfig,
  opts: WFOptions = {},
): { receipt: OverfitReceipt; verdict: OverfitVerdict; result: WFResult } {
  const result = walkForward(candles, candidates, wf, opts)
  return {
    receipt: result.receipt,
    verdict: judgeOverfit(result.receipt, opts.thresholds ?? DEFAULT_OVERFIT_THRESHOLDS),
    result,
  }
}

export { OVERFIT_VERSION }
