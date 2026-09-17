/**
 * 过拟合凭据夹具 —— 供各烟测构造「能过 / 过不了」的凭据。
 *
 * ══ 为什么烟测里可以构造凭据 ════════════════════════════════════════
 * 凭据的**接口契约**是：只装可观测量，阈值由消费方施予。
 * 因此「给定一份结构完好、指标达标的凭据，流水线应放行」与
 * 「给定一份指标不达标的凭据，流水线应拒绝」这两条，本就应该用
 * 构造出来的凭据去测 —— 那才是被测的那一层。
 *
 * 至于**统计量本身算得对不对**，由 `scripts/overfit-smoke.ts` 负责：
 * 那里用的是零假设分布与已知答案的合成场，不构造任何凭据。
 * 分工是清楚的：本文件测"门禁行为"，overfit-smoke 测"统计量正确性"。
 *
 * ⚠️ 正因为凭据可构造，它才**必须不含结论字段** ——
 * 若凭据里带 `pass: true`，构造一份"达标凭据"就等于伪造结论。
 * 现在构造者只能填可观测量，瞒不过消费方自己的阈值（阈值在流水线 config 里）。
 */

import { buildOverfitReceipt } from '../src/engine/overfit.ts'
import type { OverfitReceipt } from '../src/engine/overfit.ts'

export interface ReceiptOverrides {
  pbo?: number | null
  avgWinnerW?: number | null
  folds?: number
  candidates?: number
  dataHash?: string
  bars?: number
  /** 逐折分位。给了就会覆盖按 folds 生成的那一份。 */
  perFoldWinnerW?: number[]
  /** 让 PBO 缺失（凭据里 pboSlices/combinations 归零）。 */
  dropPbo?: boolean
}

/**
 * 生成一份凭据。默认参数在 `DEFAULT_OVERFIT_THRESHOLDS` 下**通过**：
 * folds=5 ≥ 4、candidates=20 ≥ 8、PBO=0.10 < 0.25、赢家分位 0.70 > 0.6，
 * 且 pboCombinations 取自真实 CSCV 规模（252 ≥ 70）。
 */
export function receipt(over: ReceiptOverrides = {}): OverfitReceipt {
  const folds = over.folds ?? 5
  const perFold =
    over.perFoldWinnerW ??
    Array.from({ length: folds }, (_, i) => 0.66 + ((i % 3) * 0.04))
  const pboValue = over.pbo === undefined ? 0.1 : over.pbo
  return buildOverfitReceipt({
    dataHash: over.dataHash ?? 'c0ffee00c0ffee00',
    bars: over.bars ?? 2880,
    candidates: over.candidates ?? 20,
    perFoldWinnerW: perFold,
    isFitness: perFold.map((_, i) => 80 + i),
    oosFitness: perFold.map((_, i) => 40 + i),
    perFoldSelectionEdge: perFold.map((_, i) => 5 + i),
    pbo:
      over.dropPbo || pboValue === null
        ? null
        : { slices: 10, combinations: 252, pbo: pboValue, medianLogit: 0.7, blockRows: 288 },
  })
}

/** 结构完好但指标不达标（PBO 超标）的凭据。 */
export function failingReceipt(): OverfitReceipt {
  return receipt({ pbo: 0.83 })
}
