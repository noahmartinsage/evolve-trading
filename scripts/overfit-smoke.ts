/**
 * 过拟合度量与凭据裁定的门禁。
 *
 * ══ 这个文件要守住的到底是什么 ══════════════════════════════════════
 * F-34 的表象是「walk-forward OOS 衰减」，真因却是**两道都失效**：
 *   ① 唯一的过拟合判据（requireWfRobust）吃的是调用方自报的布尔量，
 *      UI 硬编码 true、API 直接透传 ⇒ 这道门在产品路径上永不触发；
 *   ② 判据本身没有零假设对照（positiveOosShare>=0.5 测的是"行情涨没涨"）。
 *
 * 所以本文件分两半，缺一不可：
 *   A 半 —— 证明**统计量是对的**：给它已知答案的合成候选场，
 *          看它是否给出应有的结论（纯噪声≈中位、真有本事≈0、全同=1）。
 *   B 半 —— 证明**凭据不可能被伪装成通过**：结构不全、版本不符、
 *          样本不足一律 UNVERIFIABLE 且不放行；且在构造上就不含 pass 字段。
 *
 * A 半的意义：一个恒返回 0.5 的假 PBO 也能让所有"拒绝"用例通过，
 * 所以必须先钉死它在**已知答案**上的行为，那些拒绝断言才有意义。
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_OVERFIT_THRESHOLDS,
  OVERFIT_VERSION,
  buildOverfitReceipt,
  judgeOverfit,
  pboCscv,
  rankOf,
  verifyOverfitReceipt,
} from '../src/engine/overfit.ts'
import { makeRng } from '../src/engine/rng.ts'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`      ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

// ── 确定性合成候选场 ────────────────────────────────────────────────

/**
 * 生成「行=时间、列=候选」的表现矩阵。
 * `skilled` 里的列号会被注入真实优势 —— 即"这个候选真有本事"。
 */
function field(seed: number, rows: number, cols: number, skilled: number[] = [], edge = 0.5): number[][] {
  const rng = makeRng(seed)
  const out: number[][] = []
  for (let i = 0; i < rows; i++) {
    const row: number[] = []
    for (let c = 0; c < cols; c++) row.push(rng.norm() * 1 + (skilled.includes(c) ? edge : 0))
    out.push(row)
  }
  return out
}

console.log('\n【A. 统计量正确性 —— 用已知答案的合成场钉死行为】')

check('rankOf 基本名次：最差 w→0、最好 w→1、单调', () => {
  const f = [1, 2, 3, 4]
  assert.equal(rankOf(f, 0)?.ascRank, 1)
  assert.equal(rankOf(f, 3)?.ascRank, 4)
  assert.ok((rankOf(f, 0)?.w ?? 1) < (rankOf(f, 3)?.w ?? 0), '名次应随表现单调')
  assert.equal(Math.round((rankOf(f, 0)?.w ?? 0) * 1000) / 1000, 0.2)
  assert.equal(Math.round((rankOf(f, 3)?.w ?? 0) * 1000) / 1000, 0.8)
})

check('rankOf 并列取平均：全同值落在正中位 0.5，而不是被算成最好', () => {
  // 若并列按 `<=` 计数，3 个全同值会各自拿到名次 3 ⇒ w=0.75 ⇒ 判成"优于中位数"。
  // 那正是"跑得一样好的一批候选互相抬高对方"的伪优势。
  const r = rankOf([5, 5, 5], 0)
  assert.equal(r?.ascRank, 2, `并列应取平均名次 2，实际 ${r?.ascRank}`)
  assert.equal(r?.w, 0.5)
})

check('rankOf 退化输入返回 null 而不是 0：样本不足 ≠ 表现最差', () => {
  assert.equal(rankOf([1], 0), null)
  assert.equal(rankOf([1, 2, 3], 5), null)
  assert.equal(rankOf([1, Number.NaN, 3], 0), null)
})

check('pboCscv 退化输入返回 null，而不是一个假装中性的 0', () => {
  assert.equal(pboCscv([]), null)
  assert.equal(pboCscv([[1], [2], [3], [4]]), null, '单列没有"挑一个"这件事')
  assert.equal(pboCscv([[1, 2], [3, 4], [5, 6]]), null, '行数不足 4')
  assert.equal(pboCscv([[1, 2], [3, 4], [5, 6], [7, Number.NaN]]), null, '含非有限值')
  assert.equal(pboCscv([[1, 2], [3, 4], [5, 6], [7, 8, 9]]), null, '行长不一致')
})

check('纯噪声候选场 → PBO 无偏（均值≈0.5），且组合数按 C(S,S/2) 给出', () => {
  const r = pboCscv(field(11, 600, 20), 10)
  assert.ok(r, 'PBO 不应为 null')
  assert.equal(r!.combinations, 252, `S=10 应枚举 C(10,5)=252 个组合，实际 ${r!.combinations}`)
  // 单个种子的 PBO 波动很大（σ≈0.2），对单点设窄区间是错的断言写法。
  // 正确做法是看**分布**，见下一条。
})

check('**PBO 零假设校准**：纯噪声上均值≈0.5，且默认阈值能把它压到低误放行率', () => {
  // 这条断言是默认阈值 maxPbo 的依据，二者必须一起改。
  // 同时它钉死了一个容易被忽略的事实：**增加组合数并不降低离散度**
  // （252 → 3432 组合，σ 几乎不动），因为 CSCV 各组合共享时间块、
  // 高度相关，有效样本量由块数决定。所以 maxPbo 不能取 0.5
  // —— 那在纯噪声上是 53% 通过，等于没有门。
  const N = 40
  const vals: number[] = []
  for (let s = 1; s <= N; s++) {
    const r = pboCscv(field(1000 + s, 600, 20), 10)
    if (r) vals.push(r.pbo)
  }
  assert.equal(vals.length, N, '所有种子都应算出 PBO')
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1))
  // 区间刻意留到 ±3.9σ（SE = σ/√40 ≈ 0.031）。曾出现过 seed 集不同时
  // 均值落在 0.487 与 0.575 两侧的情况 —— 那是正常抽样波动，
  // 若把区间收紧到 ±0.05，CI 会随机翻红。真正的判据是下面的误放行率。
  assert.ok(mean > 0.38 && mean < 0.62, `纯噪声 PBO 均值应≈0.5（无偏），实际 ${mean.toFixed(3)}`)

  const passRate = vals.filter((v) => v < DEFAULT_OVERFIT_THRESHOLDS.maxPbo).length / vals.length
  assert.ok(
    passRate <= 0.25,
    `默认 maxPbo=${DEFAULT_OVERFIT_THRESHOLDS.maxPbo} 在纯噪声上的误放行率应 ≤25%，实际 ${(passRate * 100).toFixed(0)}%` +
      `（若偏高，说明阈值没按零假设分布定价）`,
  )
  assert.ok(
    vals.filter((v) => v < 0.5).length / vals.length > 0.3,
    'maxPbo 若取 0.5 会放行过半噪声场 —— 这正是它不能当默认值的理由',
  )
  console.log(`      （实测 n=${N} 均值=${mean.toFixed(3)} σ=${sd.toFixed(3)} 默认阈值误放行=${(passRate * 100).toFixed(0)}%）`)
})

check('存在真实优势的候选 → PBO 应趋近 0（有本事就该认得出来）', () => {
  const r = pboCscv(field(12, 600, 20, [3], 0.5), 10)
  assert.ok(r, 'PBO 不应为 null')
  assert.ok(r!.pbo < 0.05, `存在明显优势时 PBO 应接近 0，实际 ${r!.pbo}`)
  assert.ok(r!.medianLogit > 0, `真优势场的中位 logit 应为正，实际 ${r!.medianLogit}`)
})

check('全部候选完全相同 → PBO = 1（并列到中位数按"优势未兑现"计）', () => {
  const rows: number[][] = []
  for (let i = 0; i < 600; i++) rows.push(new Array(20).fill(i % 7))
  const r = pboCscv(rows, 10)
  assert.ok(r)
  assert.equal(r!.pbo, 1, `无区分度时应判满额过拟合，实际 ${r!.pbo}`)
})

check('**仓位暴露陷阱**：只有暴露差异、毫无预测能力的候选，结果必须与纯噪声逐位相同', () => {
  // 这是本模块第一版真栽过的坑，用一条**确定性等价**断言钉死，
  // 而不是对单一种子设区间（单点波动 σ≈0.2，区间断言会时红时绿）。
  //
  // 第一版用「平均收益」在样本内选优，于是 10× 暴露那一列在样本内外
  // 都稳居第一 —— 不需要任何预测能力，"一直重仓"就够了 —— PBO 假性偏低。
  // 换成风险调整后统计量后，暴露被完全约掉：
  // 两份矩阵（一份含 10× 暴露列，一份不含）的 PBO 必须**完全相等**。
  // 12 个种子拼成一份大矩阵（每个种子 600 行 × 20 列）——
  // 单一矩阵内既有独立噪声列，又含那一列 10× 暴露，比较才成立。
  const plain: number[][][] = []
  const exposed: number[][][] = []
  for (let s = 1; s <= 12; s++) {
    const rng = makeRng(2000 + s)
    const p: number[][] = []
    for (let i = 0; i < 600; i++) {
      const row: number[] = []
      for (let c = 0; c < 20; c++) {
        // ⚠️ 每列必须取**独立**的噪声。第一版这里把 rng.norm() 提到列循环外，
        // 于是 20 列在整个矩阵里逐值相同（只剩"放大 10 倍"这一个区别），
        // 测的变成「全同值 + 一列缩放」而不是「独立噪声 + 一列杠杆」。
        const noise = rng.norm()
        // 第 0 列是纯噪声的 10 倍仓位，其余列是同等纯噪声
        row.push(c === 0 ? noise * 10 : noise)
      }
      p.push(row)
    }
    plain.push(p.map((row) => row.map((v, c) => (c === 0 ? v / 10 : v))))
    exposed.push(p)
  }
  const a = pboCscv(exposed.flat(), 10)
  const b = pboCscv(plain.flat(), 10)
  assert.ok(a && b, 'PBO 不应为 null')
  assert.equal(
    a!.pbo,
    b!.pbo,
    `10× 暴露列的 PBO (${a!.pbo}) 必须与折算回 1× 后完全相同 (${b!.pbo})；` +
      '若不等，说明选优统计量没有做风险调整，"重仓"被误认成了"本事"',
  )
})

check('PBO 可复现：同输入两次结果按位一致', () => {
  const m = field(13, 400, 12)
  const a = pboCscv(m, 8)
  const b = pboCscv(m, 8)
  assert.deepEqual(a, b)
})

check('切片数按数据量自动收缩：数据不足以每块 2 行时返回 null', () => {
  assert.equal(pboCscv(field(14, 6, 6), 10), null, '6 行切不出每块 2 行的 4 个块')
  const ok = pboCscv(field(14, 40, 6), 10) // 40 行切 10 块 → 每块 4 行
  assert.ok(ok, '40 行应能切出 10 块')
  assert.equal(ok!.blockRows, 4)
})

check('数据偏少时自动降档而非返回 null —— 但降档后的粗糙度必须被判为"不足"', () => {
  // 10 行会被降到 4 切片 = 仅 6 个组合。这时 PBO 只能取 7 个离散值，
  // 它不是统计量而是抛硬币，且完全可能碰巧落在低档。函数本身如实返回，
  // 「够不够格当证据」由 judgeOverfit 按 minPboCombinations 裁定。
  const r = pboCscv(field(15, 10, 6), 10)
  assert.ok(r, '函数应如实返回降档后的结果，而不是假装算不出来')
  assert.equal(r!.slices, 4)
  assert.equal(r!.combinations, 6, `C(4,2)=6，实际 ${r!.combinations}`)
  const v = judgeOverfit(
    buildOverfitReceipt({
      dataHash: 'beefbeefbeefbeef',
      bars: 10,
      candidates: 20,
      perFoldWinnerW: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      isFitness: [1, 2, 3, 4, 5, 6],
      oosFitness: [1, 2, 3, 4, 5, 6],
      perFoldSelectionEdge: [1, 1, 1, 1, 1, 1],
      pbo: r,
    }),
  )
  assert.equal(v.outcome, 'UNVERIFIABLE', '组合数不足时必须判为无从判断，不得因为分位好看就放行')
  assert.ok(v.reasons.some((x) => x.includes('组合数')), `理由应指出组合数，实际：${v.reasons.join('；')}`)
})

console.log('\n【B. 凭据不可伪装 —— 结构不全/样本不足一律不放行】')

/** 一份"看起来达标"的基线凭据，仅供反例在此基础上做单点破坏。 */
function healthyReceipt() {
  return buildOverfitReceipt({
    dataHash: 'abcd1234abcd1234',
    bars: 2400,
    candidates: 20,
    perFoldWinnerW: [0.7, 0.65, 0.8, 0.72, 0.68, 0.75],
    isFitness: [100, 110, 120, 105, 115, 108],
    oosFitness: [50, 55, 60, 48, 58, 52],
    perFoldSelectionEdge: [10, 12, 14, 9, 11, 13],
    pbo: { slices: 10, combinations: 252, pbo: 0.12, medianLogit: 0.8, blockRows: 60 },
  })
}

check('**凭据在构造上不含任何结论字段** —— 放不下 pass 就伪装不了 pass', () => {
  const r = healthyReceipt() as unknown as Record<string, unknown>
  for (const k of ['pass', 'ok', 'passed', 'robust', 'verdict', 'outcome', 'approved']) {
    assert.ok(!(k in r), `凭据里不应存在判定字段 ${k} —— 一旦自带结论，闸门就退化成采信信封上的字`)
  }
  assert.ok(!verifyOverfitReceipt(healthyReceipt()).length, '基线凭据本身应结构完好')
  // 版本漂移守卫：构造函数打的版本号必须与常量一致。
  // 少了这条，"改了常量却忘了改构造函数"会表现为**旧凭据被静默接受或拒绝**，
  // 且排查方向会指向数据而不是版本。
  assert.equal(healthyReceipt().version, OVERFIT_VERSION)
})

check('基线凭据在默认阈值下 PASS（否则下面所有拒绝断言都失去意义）', () => {
  const v = judgeOverfit(healthyReceipt())
  assert.equal(v.outcome, 'PASS', `期望 PASS，实际 ${v.outcome}：${v.reasons.join('；')}`)
  assert.equal(v.pass, true)
  assert.equal(v.fatal, false)
})

check('PBO 超阈值 → REJECT 且 fatal（凭据完整，结论明确）', () => {
  const r = healthyReceipt()
  r.pbo = 0.83
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'REJECT')
  assert.equal(v.fatal, true)
  assert.equal(v.pass, false)
  assert.ok(v.reasons.some((x) => x.includes('PBO')), `理由应指出 PBO，实际：${v.reasons.join('；')}`)
})

check('赢家样本外分位不优于中位数 → REJECT（PBO 低也救不了）', () => {
  // 这正是黄金数据集上的真实情形：PBO 只有 9%，但赢家 OOS 分位 0.417。
  // 两个统计量问的是不同问题，任一不过都不放行 —— 本用例把这条语义钉死。
  const r = healthyReceipt()
  r.pbo = 0.09
  r.avgWinnerW = 0.417
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'REJECT')
  assert.equal(v.fatal, true)
  assert.ok(v.reasons.some((x) => x.includes('分位')), `理由应指出分位，实际：${v.reasons.join('；')}`)
})

check('边界取闭合：PBO 恰为上限 / 分位恰为下限 → 不放行（刻意与其他闸门不同）', () => {
  // 其他闸门（minFitness、testnetMaxDrawdownPct）用"严格越界才拒"，
  // 因为那些阈值是任意调参值。这两个不同：0.5 是有内在含义的临界点
  // —— PBO 50% = 与抛硬币无异；分位 0.5 = 恰好中位、毫无选择优势。
  // 在"等价于抛硬币"这一点上，没有理由偏乐观。若改成严格越界，
  // 纯运气（PBO 恰 50%）的策略会被放行。
  const r = healthyReceipt()
  r.pbo = DEFAULT_OVERFIT_THRESHOLDS.maxPbo
  assert.equal(judgeOverfit(r).outcome, 'REJECT', 'PBO 恰等于上限应拒绝')
  const r2 = healthyReceipt()
  r2.avgWinnerW = DEFAULT_OVERFIT_THRESHOLDS.minAvgWinnerW
  assert.equal(judgeOverfit(r2).outcome, 'REJECT', '分位恰等于下限应拒绝')
})

check('只是一线之差时方向正确（上限内侧通过、外侧拒绝）', () => {
  const below = healthyReceipt()
  below.pbo = DEFAULT_OVERFIT_THRESHOLDS.maxPbo - 0.01
  assert.equal(judgeOverfit(below).outcome, 'PASS')
  const above = healthyReceipt()
  above.pbo = DEFAULT_OVERFIT_THRESHOLDS.maxPbo + 0.01
  assert.equal(judgeOverfit(above).outcome, 'REJECT')
  const wBelow = healthyReceipt()
  wBelow.avgWinnerW = DEFAULT_OVERFIT_THRESHOLDS.minAvgWinnerW - 0.01
  assert.equal(judgeOverfit(wBelow).outcome, 'REJECT')
  const wAbove = healthyReceipt()
  wAbove.avgWinnerW = DEFAULT_OVERFIT_THRESHOLDS.minAvgWinnerW + 0.01
  assert.equal(judgeOverfit(wAbove).outcome, 'PASS')
})

check('缺凭据 / 非对象 → UNVERIFIABLE 且不放行', () => {
  for (const bad of [undefined, null, 0, 'PASS', []]) {
    const v = judgeOverfit(bad)
    assert.equal(v.outcome, 'UNVERIFIABLE')
    assert.equal(v.pass, false, '无从判断绝不能被判成通过')
  }
  // 旧版自报格式（只有 wfRobust 布尔）必须是不可用的
  const legacy = judgeOverfit({ wfRobust: true })
  assert.equal(legacy.outcome, 'UNVERIFIABLE')
  assert.equal(legacy.pass, false, '旧的自报布尔量必须被判为不可用，而不是被兼容成通过')
})

check('版本不符 → UNVERIFIABLE（旧口径的凭据不得被当成本版结论）', () => {
  const r = healthyReceipt() as unknown as Record<string, unknown>
  r.version = 'overfit-v0'
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'UNVERIFIABLE')
  assert.equal(v.pass, false)
})

check('缺数据指纹 → UNVERIFIABLE（凭据必须钉死在某一批行情上）', () => {
  const r = healthyReceipt()
  r.dataHash = ''
  assert.equal(judgeOverfit(r).outcome, 'UNVERIFIABLE')
})

check('折数不足 → UNVERIFIABLE：3 折在 rolling 窗口下不构成独立样本', () => {
  const r = healthyReceipt()
  r.perFoldWinnerW = [0.9, 0.9, 0.9]
  r.isFitness = [1, 2, 3]
  r.oosFitness = [1, 2, 3]
  r.folds = 3
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'UNVERIFIABLE')
  assert.ok(v.reasons.some((x) => x.includes('折数')), `理由应指出折数，实际：${v.reasons.join('；')}`)
})

check('候选数不足 → UNVERIFIABLE：候选太少时"挑一个"这件事不成立', () => {
  const r = healthyReceipt()
  r.candidates = 5
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'UNVERIFIABLE')
  assert.ok(v.reasons.some((x) => x.includes('候选数')), `理由应指出候选数，实际：${v.reasons.join('；')}`)
})

check('PBO 缺失 → UNVERIFIABLE，而不是"没有 PBO 就当它没问题"', () => {
  const r = healthyReceipt()
  r.pbo = null
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'UNVERIFIABLE')
  assert.equal(v.pass, false)
})

check('逐折数组与 folds 不等长 → UNVERIFIABLE（拼出来的凭据必须露馅）', () => {
  const r = healthyReceipt() as unknown as Record<string, unknown>
  r.perFoldWinnerW = [0.7, 0.8]
  const v = judgeOverfit(r)
  assert.equal(v.outcome, 'UNVERIFIABLE')
  assert.ok(v.reasons.some((x) => x.includes('perFoldWinnerW')), `理由应指出长度不符，实际：${v.reasons.join('；')}`)
})

check('数值越界（PBO>1 / 分位<=0）→ UNVERIFIABLE：越界说明凭据不可信，不是"超标"', () => {
  const a = healthyReceipt()
  a.pbo = 1.4
  assert.equal(judgeOverfit(a).outcome, 'UNVERIFIABLE')
  const b = healthyReceipt()
  b.avgWinnerW = 0
  assert.equal(judgeOverfit(b).outcome, 'UNVERIFIABLE')
})

check('非有限值（NaN/Infinity）→ UNVERIFIABLE', () => {
  const a = healthyReceipt()
  a.avgSelectionEdge = Number.NaN
  assert.equal(judgeOverfit(a).outcome, 'UNVERIFIABLE')
  const b = healthyReceipt()
  b.oosFitness = [1, 2, Number.POSITIVE_INFINITY, 4, 5, 6]
  assert.equal(judgeOverfit(b).outcome, 'UNVERIFIABLE')
})

check('放宽阈值不会把结构缺陷变成通过（阈值只管指标，不管凭据是否可用）', () => {
  const loose = { maxPbo: 1, minAvgWinnerW: 0, minFolds: 0, minCandidates: 0, minPboCombinations: 0 }
  assert.equal(judgeOverfit(undefined, loose).outcome, 'UNVERIFIABLE')
  assert.equal(judgeOverfit({ wfRobust: true }, loose).outcome, 'UNVERIFIABLE')
  const r = healthyReceipt()
  r.perFoldWinnerW = [0.9]
  assert.equal(judgeOverfit(r, loose).outcome, 'UNVERIFIABLE', '长度不符是结构缺陷，放宽阈值也救不了')
})

console.log('\n【C. 与真实引擎的接线证明】')

const { genSynthCandles, buildCandidateSet, walkForward, DEFAULT_GRID_EXEC, contentHash } = await import('../src/engine/index.ts')
const { GOLDEN_DATA_SPEC } = await import('../src/engine/index.ts')

check('真实引擎跑出的凭据结构完好，且能独立重算均值（不是相信一个标量）', () => {
  const candles = genSynthCandles(GOLDEN_DATA_SPEC).slice(0, 1200)
  const candidates = buildCandidateSet()
  const r = walkForward(candles, candidates, {
    trainBars: 480,
    testBars: 120,
    barMinutes: GOLDEN_DATA_SPEC.barMinutes,
    exec: DEFAULT_GRID_EXEC,
  }, { dataHash: contentHash(candles), slices: 8 })

  assert.ok(r.aggregate.folds >= 4, `折数应≥4，实际 ${r.aggregate.folds}`)
  assert.deepEqual(verifyOverfitReceipt(r.receipt), [], '凭据应结构完好')
  assert.equal(r.receipt.bars, 1200)
  assert.equal(r.receipt.candidates, candidates.length)
  assert.equal(r.receipt.dataHash, contentHash(candles), '数据指纹必须来自真实行情')

  // 汇总值必须能由逐折明细重算 —— 否则审计者只能相信一个孤立标量
  const recomputed = r.receipt.perFoldWinnerW.reduce((a, b) => a + b, 0) / r.receipt.perFoldWinnerW.length
  assert.equal(Math.round(recomputed * 1e9) / 1e9, Math.round((r.receipt.avgWinnerW ?? 0) * 1e9) / 1e9)
  assert.equal(r.aggregate.robust, judgeOverfit(r.receipt).pass, 'robust 便利字段必须与凭据裁定一致')
})

check('同一批行情、换一批候选 → 数据指纹不变、凭据随之变化（凭据绑定的是数据，不是结论）', () => {
  const candles = genSynthCandles(GOLDEN_DATA_SPEC).slice(0, 960)
  const wf = { trainBars: 360, testBars: 120, barMinutes: GOLDEN_DATA_SPEC.barMinutes, exec: DEFAULT_GRID_EXEC }
  const full = walkForward(candles, buildCandidateSet(), wf, { dataHash: contentHash(candles), slices: 8 })
  const half = walkForward(candles, buildCandidateSet().slice(0, 10), wf, { dataHash: contentHash(candles), slices: 8 })
  assert.equal(full.receipt.dataHash, half.receipt.dataHash)
  assert.notEqual(full.receipt.candidates, half.receipt.candidates)
})

console.log('\n' + '─'.repeat(64))
if (failures.length === 0) {
  console.log(`✅ 过拟合门禁 PASSED · ${passed} 项断言全通过`)
} else {
  console.log(`❌ 过拟合门禁 FAILED · ${passed} 通过 / ${failures.length} 失败`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
