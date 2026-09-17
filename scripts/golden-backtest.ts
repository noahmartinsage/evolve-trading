import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  genSynthCandles,
  GOLDEN_DATA_SPEC,
  SYNTH_DATA_VERSION,
  evaluateCandidateGrid,
  buildCandidateSet,
  walkForward,
  combinationPurity,
  DEFAULT_GRID_EXEC,
  PaperBroker,
  validateHistory,
  contentHash,
  verifyOverfitReceipt,
  judgeOverfit,
  ENGINE_VERSION,
  FITNESS_VERSION,
  FITNESS_DOMAIN,
} from '../src/engine/index.ts'
import type { HistoryFile } from '../src/engine/index.ts'

interface GoldenArtifact {
  meta: {
    engineVersion: string
    fitnessVersion: string
    dataVersion: string
    dataSpec: typeof GOLDEN_DATA_SPEC
    generatedAt: string
    historyDatasets: { file: string; hash: string; count: number; gaps: number }[]
  }
  winner: {
    id: string
    fitness: number
    annReturnPct: number
    maxDrawdownPct: number
    sharpe: number
    tradesPerDay: number
    totalFeesPaid: number
    winRatePct: number
    fills: number
  }
  leaderboard: { id: string; fitness: number }[]
  walkForward: {
    folds: number
    avgIsFitness: number
    avgOosFitness: number
    decayRatio: number
    positiveOosShare: number
    robust: boolean
    outcome: string
    verdictSummary: string
    perFold: {
      fold: number
      bestId: string
      isFitness: number
      oosFitness: number
      oosFieldMean: number
      winnerAscRank: number
      winnerW: number
      selectionEdge: number
    }[]
  }
  /**
   * 过拟合凭据与裁定。
   *
   * ⚠️ 这里记的是**统计量是否成立**，不是"策略好不好"。
   * golden 的职责是把引擎行为钉死（可复现、不退化），
   * 而"这个候选集有没有真优势"属于策略质量问题，归晋升门禁管 ——
   * 两者混在一道门里会是另一种类别错误。
   *
   * 但 golden **必须**守住的是：这套统计量真的被算出来了、且内部自洽。
   * 改造前它只断言 `Number.isFinite(decayRatio)`，于是 `robust=false`
   * 也不会让 golden 失败 —— 算完写进 artifact 就没人消费了（F-34 的一半真因）。
   */
  overfit: {
    version: string
    dataHash: string
    bars: number
    candidates: number
    folds: number
    pbo: number | null
    pboSlices: number
    pboCombinations: number
    avgWinnerW: number | null
    avgSelectionEdge: number | null
    outcome: string
  }
  purity: {
    avgCorr: number
    maxCorr: number
    homogeneous: boolean
  }
  brokerSmoke: {
    marketFillPrice: string
    limitCancelled: boolean
    filledCount: number
  }
}

function fail(msg: string): never {
  console.error(`❌ GOLDEN FAIL · ${msg}`)
  process.exit(1)
}

const candlesA = genSynthCandles(GOLDEN_DATA_SPEC)
const candlesB = genSynthCandles(GOLDEN_DATA_SPEC)

if (JSON.stringify(candlesA) !== JSON.stringify(candlesB)) {
  fail('数据生成不可复现：同 seed 两次生成结果不一致')
}
console.log(`✅ 数据可复现 · ${SYNTH_DATA_VERSION} · ${candlesA.length} 根 K 线`)

const run1 = evaluateCandidateGrid(candlesA)
const run2 = evaluateCandidateGrid(candlesB)

const stripRuns = (rs: ReturnType<typeof evaluateCandidateGrid>) =>
  JSON.stringify(
    rs.map((r) => ({
      id: r.id,
      fitness: r.fitness,
      report: r.report,
      equityTail: r.result.equityCurve.slice(-5),
      fillsCount: r.result.fills.length,
    })),
  )

if (stripRuns(run1) !== stripRuns(run2)) {
  fail('回测不可复现：同输入两次运行结果不一致')
}
console.log('✅ 回测可复现 · 同输入两次运行 bit 级一致')

for (const r of run1) {
  for (const key of ['annReturnPct', 'maxDrawdownPct', 'sharpe', 'tradesPerDay'] as const) {
    if (!Number.isFinite(r.report[key])) fail(`${r.id} 指标 ${key} 非有限值`)
  }
  if (r.report.maxDrawdownPct < 0 || r.report.maxDrawdownPct > 100) fail(`${r.id} 回撤越界`)
  // 定义域从 FITNESS_DOMAIN 读 —— 不在这里写死上界。
  // 曾经这里自己写着 120，而 fitness.ts 的 clamp 上界是 200，
  // 于是守卫长期红灯，且错误信息把矛头指向「策略越界」而不是「两个数字不一致」。
  if (r.fitness < FITNESS_DOMAIN.min || r.fitness > FITNESS_DOMAIN.max) {
    fail(`${r.id} fitness 越界 [${FITNESS_VERSION} 定义域 ${FITNESS_DOMAIN.min}..${FITNESS_DOMAIN.max}]`)
  }
  // 触顶本身就是信号：公式对这批数据失去区分度（对数压缩被 clamp 截平）。
  if (r.fitness === FITNESS_DOMAIN.max || r.fitness === FITNESS_DOMAIN.min) {
    fail(`${r.id} fitness 触顶饱和于 ${r.fitness} —— 适应度公式对当前数据失去区分度`)
  }
  if (Math.abs(r.report.annReturnPct) > 10_000) fail(`${r.id} 年化外推失控（>${10000}%），年化算法或数据跨度有问题`)
  const ending = r.result.equityCurve[r.result.equityCurve.length - 1].equity
  if (!Number.isFinite(ending) || ending <= 0) fail(`${r.id} 权益非法`)
}
console.log(`✅ 指标健全性通过 · ${run1.length} 个候选全部有限值`)

const distinctFitness = new Set(run1.map((r) => r.fitness))
if (distinctFitness.size < run1.length - 1) fail('多个候选 fitness 饱和到同一值，排行榜失去区分度 —— 检查数据跨度与适应度定义')

const winner = run1[0]

const historyDir = join(process.cwd(), 'data', 'history')
const historyDatasets: GoldenArtifact['meta']['historyDatasets'] = []
if (existsSync(historyDir)) {
  for (const fname of readdirSync(historyDir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(join(historyDir, fname), 'utf-8')) as HistoryFile
    const errs = validateHistory(raw)
    if (errs.length > 0) fail(`历史数据集 ${fname} 校验失败: ${errs.join('; ')}`)
    historyDatasets.push({
      file: fname,
      hash: raw.meta.contentHash,
      count: raw.meta.count,
      gaps: raw.meta.gaps.reduce((s, g) => s + g.missingBars, 0),
    })
  }
  console.log(`✅ 历史数据集校验通过 · ${historyDatasets.length} 个（hash 锁定）`)
}

const wf = walkForward(candlesA, buildCandidateSet(), {
  trainBars: 960,
  testBars: 240,
  barMinutes: GOLDEN_DATA_SPEC.barMinutes,
  exec: DEFAULT_GRID_EXEC,
}, { dataHash: contentHash(candlesA), slices: 10 })
if (wf.aggregate.folds < 4) fail(`walk-forward 折数不足: ${wf.aggregate.folds}（<4 时过拟合判定会判为"无从判断"）`)
if (!Number.isFinite(wf.aggregate.decayRatio)) fail('walk-forward decayRatio 非有限值')
console.log(
  `✅ Walk-forward · ${wf.aggregate.folds} 折 · IS ${wf.aggregate.avgIsFitness} → OOS ${wf.aggregate.avgOosFitness} · decay=${wf.aggregate.decayRatio} · OOS为正比例=${wf.aggregate.positiveOosShare}`,
)

// ── 过拟合统计量：结构 + 内部自洽 ────────────────────────────────
// 这一段是 F-34 的防退化解。改造前 golden 只算不判、算完就写 artifact，
// 于是"过拟合判定"整条链路上没有任何一处会因它不达标而变红 ——
// 统计量退化成装饰，没人会注意到它算错了。
const oErr = verifyOverfitReceipt(wf.receipt)
if (oErr.length > 0) fail(`过拟合凭据结构不完整：${oErr.join('；')}`)
if (wf.receipt.bars !== candlesA.length) fail(`凭据 bars=${wf.receipt.bars} 与行情根数 ${candlesA.length} 不符`)
if (wf.receipt.candidates !== buildCandidateSet().length) fail('凭据候选数与候选集不符')
if (wf.receipt.dataHash !== contentHash(candlesA)) fail('凭据数据指纹与本次行情不符（凭据必须钉死在具体数据上）')
if (wf.receipt.avgWinnerW === null || !Number.isFinite(wf.receipt.avgWinnerW)) fail('赢家分位缺失或非有限')
if (wf.receipt.avgWinnerW <= 0 || wf.receipt.avgWinnerW >= 1) fail(`赢家分位越界: ${wf.receipt.avgWinnerW} 应∈(0,1)`)
if (wf.receipt.pbo === null || !Number.isFinite(wf.receipt.pbo)) fail('PBO 缺失或非有限（CSCV 应能在本数据集上切分）')
if (wf.receipt.pbo < 0 || wf.receipt.pbo > 1) fail(`PBO 越界: ${wf.receipt.pbo}`)
if (wf.receipt.pboCombinations < 70) {
  fail(`CSCV 组合数不足: ${wf.receipt.pboCombinations}（<70 时 PBO 分辨率太粗，不足以当证据）`)
}
// 组合数必须与切片数自洽：C(S, S/2)。
const expectCombos = (() => {
  const s = wf.receipt.pboSlices
  let c = 1
  for (let i = 0; i < s / 2; i++) c = (c * (s - i)) / (i + 1)
  return Math.round(c)
})()
if (wf.receipt.pboCombinations !== expectCombos) {
  fail(`CSCV 组合数 ${wf.receipt.pboCombinations} ≠ C(${wf.receipt.pboSlices},${wf.receipt.pboSlices / 2})=${expectCombos}`)
}
// 汇总值必须能由逐折明细重算 —— 否则审计者只能相信一个孤立标量。
const recomputedW = wf.receipt.perFoldWinnerW.reduce((a, b) => a + b, 0) / wf.receipt.perFoldWinnerW.length
if (Math.abs(recomputedW - wf.receipt.avgWinnerW) > 1e-9) {
  fail(`赢家分位均值不可由逐折明细重算: ${recomputedW} ≠ ${wf.receipt.avgWinnerW}`)
}
// 每折的内部自洽：selectionEdge 必须等于 oosFitness − oosFieldMean。
// 这条把"赢家 OOS 与候选场均值是两个独立的数"钉死 ——
// 若有人把 oosFieldMean 直接赋成 oosFitness 来省掉那一轮回测，这里会立刻变红。
//
// ⚠️ 容差必须**推导**出来，不能随手取：
// 三个量各自在 walkforward.ts 里被四舍五入到 3 位小数，
// 单量误差 ≤ 5e-4，故 |e3| + |e1| + |e2| ≤ 1.5e-3。
// 第一版写死 1e-3，结果 fold3 上真实差值是 0.0010000000000012221
// —— 差在浮点尾数上，门禁随机翻红。取 2e-3 留出裕度。
const SELECTION_EDGE_TOL = 2e-3
let fieldDiffers = false
for (const f of wf.folds) {
  if (f.winnerAscRank < 1 || f.winnerAscRank > f.candidates) fail(`fold${f.fold} 赢家名次越界 ${f.winnerAscRank}/${f.candidates}`)
  if (!(f.winnerW > 0 && f.winnerW < 1)) fail(`fold${f.fold} 赢家分位越界 ${f.winnerW}`)
  if (Math.abs(f.selectionEdge - (f.oosFitness - f.oosFieldMean)) > SELECTION_EDGE_TOL) {
    fail(
      `fold${f.fold} 选择净收益 ${f.selectionEdge} 与 (oosFitness ${f.oosFitness} − oosFieldMean ${f.oosFieldMean}) ` +
        `不符，超出四舍五入容差 ${SELECTION_EDGE_TOL}`,
    )
  }
  if (Math.abs(f.oosFieldMean - f.oosFitness) > 1e-9) fieldDiffers = true
}
if (!fieldDiffers) {
  fail('所有折的 oosFieldMean 都等于 oosFitness —— 候选场从未被真正评估，selectionEdge 是伪造的零')
}
if (wf.aggregate.robust !== judgeOverfit(wf.receipt).pass) {
  fail('aggregate.robust 与凭据裁定不一致 —— 便利字段与凭据出现了两套口径')
}
console.log(
  `✅ 过拟合统计量 · PBO=${wf.receipt.pbo} (${wf.receipt.pboSlices} 切片 / ${wf.receipt.pboCombinations} 组合) · ` +
    `赢家分位=${wf.receipt.avgWinnerW.toFixed(3)} · 选择净收益=${wf.receipt.avgSelectionEdge?.toFixed(3)} · 裁定=${wf.aggregate.outcome}`,
)
console.log(`   ↳ ${wf.aggregate.verdictSummary}`)

const purity = combinationPurity(candlesA, buildCandidateSet(), 960, {
  trainBars: 960,
  testBars: 240,
  barMinutes: GOLDEN_DATA_SPEC.barMinutes,
  exec: DEFAULT_GRID_EXEC,
})
if (!Number.isFinite(purity.avgCorr)) fail('组合净化 avgCorr 非有限值')
if (purity.homogeneous) fail(`候选同质化（平均相关性 ${purity.avgCorr} > 0.8），净化失败 —— 候选集缺乏多样性`)
console.log(`✅ 组合净化 · 候选 ${purity.candidates} 个 · 平均相关性 ${purity.avgCorr} · 最大 ${purity.maxCorr}`)

const broker = new PaperBroker(DEFAULT_GRID_EXEC)
const sub = broker.submit({ clientOrderId: 'smoke-mkt', symbol: 'TEST', side: 'buy', type: 'market', qty: 1 })
if (sub.status !== 'new') fail('PaperBroker 市价单提交状态异常')
broker.onBar('TEST', { t: 1, o: 100, h: 101, l: 99, c: 100, v: 50 })
const smokeFills = broker.fills()
if (smokeFills.length !== 1 || Math.abs(smokeFills[0].price - 100 * (1 + DEFAULT_GRID_EXEC.slippageBps / 10_000)) > 1e-9) {
  fail('PaperBroker 市价成交价与滑点模型不符')
}
const lim = broker.submit({ clientOrderId: 'smoke-lmt', symbol: 'TEST', side: 'buy', type: 'limit', price: 90, qty: 1 })
const cancelled = broker.cancel(lim.orderId)
broker.onBar('TEST', { t: 2, o: 100, h: 101, l: 89, c: 95, v: 50 })
if (!cancelled) fail('PaperBroker 撤单失败')
console.log('✅ PaperBroker 冒烟通过 · 市价成交/滑点/撤单')

const artifact: GoldenArtifact = {
  meta: {
    engineVersion: ENGINE_VERSION,
    fitnessVersion: FITNESS_VERSION,
    dataVersion: SYNTH_DATA_VERSION,
    dataSpec: GOLDEN_DATA_SPEC,
    generatedAt: new Date().toISOString(),
    historyDatasets,
  },
  winner: {
    id: winner.id,
    fitness: winner.fitness,
    annReturnPct: Math.round(winner.report.annReturnPct * 1e4) / 1e4,
    maxDrawdownPct: Math.round(winner.report.maxDrawdownPct * 1e4) / 1e4,
    sharpe: Math.round(winner.report.sharpe * 1e4) / 1e4,
    tradesPerDay: Math.round(winner.report.tradesPerDay * 1e4) / 1e4,
    totalFeesPaid: Math.round(winner.report.totalFeesPaid * 1e2) / 1e2,
    winRatePct: Math.round(winner.report.winRatePct * 1e2) / 1e2,
    fills: winner.result.fills.length,
  },
  leaderboard: run1.map((r) => ({ id: r.id, fitness: r.fitness })),
  walkForward: {
    folds: wf.aggregate.folds,
    avgIsFitness: wf.aggregate.avgIsFitness,
    avgOosFitness: wf.aggregate.avgOosFitness,
    decayRatio: wf.aggregate.decayRatio,
    positiveOosShare: wf.aggregate.positiveOosShare,
    robust: wf.aggregate.robust,
    outcome: wf.aggregate.outcome,
    verdictSummary: wf.aggregate.verdictSummary,
    perFold: wf.folds.map((f) => ({
      fold: f.fold,
      bestId: f.bestId,
      isFitness: f.isFitness,
      oosFitness: f.oosFitness,
      oosFieldMean: f.oosFieldMean,
      winnerAscRank: f.winnerAscRank,
      winnerW: f.winnerW,
      selectionEdge: f.selectionEdge,
    })),
  },
  overfit: {
    version: wf.receipt.version,
    dataHash: wf.receipt.dataHash,
    bars: wf.receipt.bars,
    candidates: wf.receipt.candidates,
    folds: wf.receipt.folds,
    pbo: wf.receipt.pbo,
    pboSlices: wf.receipt.pboSlices,
    pboCombinations: wf.receipt.pboCombinations,
    avgWinnerW: wf.receipt.avgWinnerW,
    avgSelectionEdge: wf.receipt.avgSelectionEdge,
    outcome: wf.aggregate.outcome,
  },
  purity: {
    avgCorr: purity.avgCorr,
    maxCorr: purity.maxCorr,
    homogeneous: purity.homogeneous,
  },
  brokerSmoke: {
    marketFillPrice: smokeFills[0].price.toString(),
    limitCancelled: cancelled,
    filledCount: smokeFills.length,
  },
}

const artifactsDir = join(process.cwd(), 'artifacts')
mkdirSync(artifactsDir, { recursive: true })
writeFileSync(join(artifactsDir, 'golden-report.json'), JSON.stringify(artifact, null, 2))

const stableJson = (a: GoldenArtifact) =>
  JSON.stringify({
    meta: {
      engineVersion: a.meta.engineVersion,
      fitnessVersion: a.meta.fitnessVersion,
      dataVersion: a.meta.dataVersion,
      dataSpec: a.meta.dataSpec,
    },
    winner: a.winner,
    leaderboard: a.leaderboard,
  })

const baselinePath = join(artifactsDir, 'golden-baseline.json')
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, stableJson(artifact))
  console.log('✅ 基线已更新（--update）')
} else if (!existsFile(baselinePath)) {
  writeFileSync(baselinePath, stableJson(artifact))
  console.log('ℹ️ 首次运行，已写入基线')
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
  if (stableJson(artifact) !== JSON.stringify(baseline)) {
    fail('与 golden-baseline.json 不一致 —— 引擎行为发生变化且未更新基线。若为预期变更，请运行 npm run backtest:golden -- --update 并在 PR 中说明')
  }
  console.log('✅ 与基线一致（golden-baseline.json）')
}

console.log('\n── 排行榜 ──')
for (const [i, r] of run1.entries()) {
  console.log(
    `${i === 0 ? '🏆' : '  '} ${r.label.padEnd(28)} fitness=${String(r.fitness).padStart(8)} ann=${r.report.annReturnPct.toFixed(2)}% dd=${r.report.maxDrawdownPct.toFixed(2)}% sharpe=${r.report.sharpe.toFixed(2)} trades/day=${r.report.tradesPerDay.toFixed(1)}`,
  )
}
console.log(`\n🏆 冠军: ${winner.id} · fitness=${winner.fitness} (${FITNESS_VERSION})`)
console.log(
  `🧪 Walk-forward 汇总: robust=${wf.aggregate.robust} · OOS正收益折占比=${(wf.aggregate.positiveOosShare * 100).toFixed(0)}%`,
)
console.log('🎉 GOLDEN BACKTEST PASSED')

function existsFile(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}
