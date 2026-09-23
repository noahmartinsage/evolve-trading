/**
 * 门禁实测报表 —— 在当前证据基座上把过拟合门完整跑一遍并打印全部凭据。
 *
 * 为什么要有这个脚本（而不是靠面板点一下）：
 * 「投真钱可不可行」是这条产线**唯一真正重要的结论**，而它必须能被
 * 反复、可复现、带全部中间量地问出来。只看一个 PASS/REJECT 无法区分
 * "牌面好"与"证据不足"—— 这两种都会显示 REJECT，但下一步动作完全不同：
 * 前者该改策略，后者该去补数据。所以这里把 `insufficient` 的理由一并摊开。
 *
 * 退出码语义（fail-closed）：
 *   只要任何一个标的的裁定是**在合成数据上得出的**，就 exit 1。
 *   理由：合成行情里不存在可被策略捕捉的结构，"在合成数据上过了回测"
 *   在原理上不能作为进实盘的依据；这种结论一旦被当成真实证据，
 *   是"答案看起来完全正确"那一族缺陷（判据 17）。
 *
 * 用法：npm run gate:report
 */
import { performance } from 'node:perf_hooks'
import { computeEvidenceReceipt, loadEvidence } from '../server/evidence.ts'
import { DEFAULT_OVERFIT_THRESHOLDS } from '../src/engine/overfit.ts'

const SYMBOLS = ['BTCUSDT', 'ETHUSDT']

/** 30 天基座上的历史实测值，用于前后对比（取自 DEV_PROGRESS §3.16）。 */
const BASELINE_30D: Record<string, { bars: number; pbo: number }> = {
  BTCUSDT: { bars: 2880, pbo: 0.401 },
  ETHUSDT: { bars: 2880, pbo: 0.591 },
}

let syntheticOnly = false

console.log(`门禁阈值：${JSON.stringify(DEFAULT_OVERFIT_THRESHOLDS)}`)
console.log('')

for (const symbol of SYMBOLS) {
  const ev = loadEvidence(symbol, 15)
  const t0 = performance.now()
  const r = computeEvidenceReceipt(symbol, 15)
  const ms = performance.now() - t0

  console.log(`═══ ${symbol} ═══`)
  console.log(`  证据基座   ${r.evidence.origin}/${r.evidence.symbol} · ${r.evidence.bars} 根 · 缺口 ${r.evidence.gaps} · hash=${ev.dataHash}`)
  console.log(`  读取路径   ${ev.triedPath}`)
  console.log(`  折数        ${r.result.aggregate.folds}  ·  候选 ${r.receipt.candidates}  ·  PBO 组合 ${r.receipt.pboCombinations}`)
  console.log(
    `  PBO         ${r.receipt.pbo === null ? 'n/a' : (r.receipt.pbo * 100).toFixed(1) + '%'}` +
      `  （阈值 ${(DEFAULT_OVERFIT_THRESHOLDS.maxPbo * 100).toFixed(0)}%，越小越好）`,
  )
  console.log(
    `  赢家样本外分位 ${r.receipt.avgWinnerW === null ? 'null' : r.receipt.avgWinnerW.toFixed(3)}` +
      `  （阈值 ≥ ${DEFAULT_OVERFIT_THRESHOLDS.minAvgWinnerW}）`,
  )
  console.log(
    `  选择净收益  ${r.receipt.avgSelectionEdge === null ? 'null' : r.receipt.avgSelectionEdge.toFixed(2)}`,
  )
  console.log(
    `  折内 Δ      平均样本内 ${r.result.aggregate.avgIsFitness.toFixed(2)} → 平均样本外 ${r.result.aggregate.avgOosFitness.toFixed(2)}` +
      `  · 衰减比 ${r.result.aggregate.decayRatio.toFixed(3)}` +
      `  · 样本外为正的折占比 ${(r.result.aggregate.positiveOosShare * 100).toFixed(0)}%`,
  )
  console.log(`  同质化      平均相关 ${r.purity.avgCorr} · 最大 ${r.purity.maxCorr} · homogeneous=${r.purity.homogeneous}`)
  console.log(`  裁定        ${r.verdict.outcome}`)
  for (const reason of r.verdict.reasons) console.log(`              · ${reason}`)

  const base = BASELINE_30D[symbol]
  if (base) {
    console.log(
      `  对比 30 天  bars ${base.bars} → ${r.evidence.bars}（×${(r.evidence.bars / base.bars).toFixed(1)}）` +
        ` · PBO ${(base.pbo * 100).toFixed(1)}% → ${r.receipt.pbo === null ? 'n/a' : (r.receipt.pbo * 100).toFixed(1) + '%'}`,
    )
  }
  console.log(`  耗时        ${ms.toFixed(0)}ms`)
  console.log('')

  if (r.evidence.origin !== 'history') syntheticOnly = true
}

if (syntheticOnly) {
  console.error('❌ 至少一个标的的裁定是在合成数据上得出的 —— 该结论不能作为进实盘的依据。')
  process.exit(1)
}
console.log('✅ 全部裁定都在真实历史基座上得出。')
