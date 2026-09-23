/**
 * 横截面（breadth）烟测 —— 只测**语义不变量**，不测数值。
 *
 * ══ 每条断言都必须能被"它自己"打红 ═════════════════════════════════
 * 本仓库已经栽过 8 次"不可能失败的检查"。所以：
 *   · 引擎层的断言用**手算得出的**合成面板（毛、市场、换手都是可手算的常数），
 *     这样"毛算错了"与"数据换了"能分开；
 *   · 判决层的断言**穷举 8 个分支**，每个分支构造只属于它的输入 ——
 *     改坏哪一个分支，红的就只有它那一条，不会靠邻居兜住；
 *   · 服务层的断言只碰**结构性**性质（sign 与训练段 IC 同号、判决只用检验段、
 *     缺品种不回落合成），不碰任何数值 —— 数值会随数据变化。
 *
 * 这条文件刻意**不依赖 data/ 里的真实历史**：CI 机器上跑一次必须与
 * "这台机器上有没有拉过历史"无关（否则它会变成环境依赖用例）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  alignPanel,
  crossSectionBacktest,
  judgeCrossSection,
  pooledIc,
  projectFactor,
  DEFAULT_CROSS_SECTION_GATE,
  type CrossSectionResult,
  type Panel,
  type PooledIcResult,
} from '../src/engine/crossSection.ts'
import { factorSeries } from '../src/engine/factorEval.ts'
import { memoDerived, resetSeriesCacheStats, seriesCacheStats } from '../src/engine/seriesCache.ts'
import type { Candle } from '../src/engine/types.ts'
import {
  defaultBreadthConfig,
  defaultBreadthIndexPath,
  evaluateBreadth,
  loadBreadthPanel,
  listHistorySymbols,
  oneWayCostBps,
  readBreadthIndex,
  samePanel,
  splitRanges,
} from '../server/breadthService.ts'

interface Result {
  name: string
  pass: boolean
  detail: string
}
const results: Result[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, pass: true, detail: '' })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, pass: false, detail: msg })
    console.error(`  ✗ ${name}\n      ${msg}`)
  }
}

/** 读源码并**剥掉注释**再断言 —— 否则断言会命中自己写的解释性注释（本项目踩过）。 */
function readCode(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ═══════════════════════════════════════════════════════════════════
// 合成面板：收益是每根 bar 的确定性常数，所以毛/市场/换手都能手算
// ═══════════════════════════════════════════════════════════════════

const SYMS = ['A', 'B', 'C', 'D', 'E', 'F']

/** 造面板：品种 j 每根 bar 的收益 = `retBps(j)` bps（乘性，所以持有期收益恒定）。 */
function makePanel(symbols: string[], bars: number, retBps: (j: number) => number): Panel {
  const times = Array.from({ length: bars }, (_, k) => (k + 1) * 900_000)
  const closes = symbols.map((_, j) => {
    let px = 100
    const row: number[] = []
    for (let k = 0; k < bars; k++) {
      px *= 1 + retBps(j) / 10_000
      row.push(px)
    }
    return row
  })
  return {
    symbols,
    times,
    closes,
    coverage: symbols.map((s) => ({ symbol: s, bars, kept: bars })),
    bars,
    dropped: 0,
    from: times[0],
    to: times[bars - 1],
  }
}

/** 常数因子：第 j 个品种的值 = j。⇒ 排序恒定、IC = ±1。 */
const constFactor = (panel: Panel) => panel.symbols.map((_, j) => new Array<number | null>(panel.bars).fill(j))

const BARS = 100
const TOPK = 2
const H = 1
// 6 个品种，因子 = j，收益 = j·10 bps ⇒
//   longs = j∈{4,5}（40/50 bps）、shorts = j∈{0,1}（0/10 bps）
//   毛/腿 = (40+50 − (0+10)) / 4 = 20 bps；市场 = mean(0,10,20,30,40,50) = 25 bps
const UP = makePanel(SYMS, BARS, (j) => j * 10)
const DOWN = makePanel(SYMS, BARS, (j) => -j * 10)
const CFG = { topK: TOPK, horizon: H, feeBps: 5, slipBps: 3 }

console.log('\n── A. 面板对齐：交集不是并集 ──')

check('A1 只保留**所有**标的都有的时间戳（交集），不是取并集再补零', () => {
  const c = (t: number, px: number): Candle => ({ t, o: px, h: px, l: px, c: px, v: 1 })
  const panel = alignPanel([
    { symbol: 'X', candles: [c(1, 10), c(2, 11), c(3, 12)] },
    { symbol: 'Y', candles: [c(1, 20), c(3, 22), c(4, 23)] },
  ])
  assert.deepEqual(panel.times, [1, 3], '共同时间戳应当是 [1,3] —— 取并集或补零会得到 [1,2,3,4]')
  assert.equal(panel.bars, 2)
  assert.equal(panel.closes.length, 2, '每个标的都要有一行')
  assert.deepEqual(panel.closes[1], [20, 22], 'Y 在 t=3 的收盘必须是真实值 22，不能是补出来的 0 或前值 20')
})

check('A2 dropped 反映"丢了多少"，不是恒 0', () => {
  const c = (t: number, px: number): Candle => ({ t, o: px, h: px, l: px, c: px, v: 1 })
  const panel = alignPanel([
    { symbol: 'X', candles: [c(1, 10), c(2, 11), c(3, 12)] },
    { symbol: 'Y', candles: [c(1, 20), c(3, 22), c(4, 23)] },
  ])
  // 原始 3+3=6 根，面板占 2×2=4 根 ⇒ 丢 2 根（X 的 t=2、Y 的 t=4）
  assert.equal(panel.dropped, 2)
})

check('A3 空输入不崩，且 bars=0（不是"随便给个 1"）', () => {
  const panel = alignPanel([])
  assert.equal(panel.bars, 0)
  assert.equal(panel.symbols.length, 0)
  assert.equal(panel.from, 0)
})

check('A4 交集为空时仍然是 0 而不是全量', () => {
  const c = (t: number): Candle => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 })
  const panel = alignPanel([
    { symbol: 'X', candles: [c(1), c(2)] },
    { symbol: 'Y', candles: [c(3), c(4)] },
  ])
  assert.equal(panel.bars, 0, '两个标的没有任何共同时间戳 ⇒ 面板必须是 0 根')
})

check('A5 因子投影按**时间轴**对齐，且面板上没有的时刻是 null（不是 0、不是前值）', () => {
  const c = (t: number, px: number): Candle => ({ t, o: px, h: px, l: px, c: px, v: 1 })
  const x = [c(1, 10), c(2, 11), c(3, 12)]
  const y = [c(1, 20), c(3, 22), c(4, 23)]
  const panel = alignPanel([
    { symbol: 'X', candles: x },
    { symbol: 'Y', candles: y },
  ])
  // 序列是在**原始** K 线上算的（3 根），面板只有 2 个时刻
  assert.deepEqual(projectFactor(panel, x, [10, 20, 30]), [10, 30], '面板 t=[1,3] 应取原始序列的第 0、2 位')
  assert.deepEqual(projectFactor(panel, y, [1, 2, 3]), [1, 2], 'Y 的时刻是 [1,3,4]，面板取到的是它的第 0、1 位')
  // ★ null 必须是 null：退化成 0 会让"这个标的当时没算出来"变成"因子值等于 0"，
  //   而 0 在横截面排序里是一个**明确的位置**（往往还是最极端的那个）。
  assert.deepEqual(projectFactor(panel, x, [10, null, 30]), [10, 30])
  assert.deepEqual(projectFactor(panel, x, [null, 20, null]), [null, null])
})

check('A6 不传阈值时用 DEFAULT_CROSS_SECTION_GATE —— 门槛真的在起作用', () => {
  const ok = judgeCrossSection(res(), ic())
  assert.equal(ok.outcome, 'accepted', '默认阈值下这份输入应当通过')
  const below = judgeCrossSection(res({ rebalances: DEFAULT_CROSS_SECTION_GATE.minSections - 1 }), ic())
  assert.equal(below.gate, 'sections', '差一个横截面就应当落到"样本不够" —— 说明默认门槛被读到了')
})

console.log('\n── B. 池化 IC：横截面，不是时序 ──')

check('B1 IC 是**同一时刻**横截面上的秩相关（常数因子 + 单调收益 ⇒ IC=1）', () => {
  const ic = pooledIc(UP, constFactor(UP), H, { step: H })
  assert.ok(ic.meanIc !== null, 'IC 不该是 null')
  assert.ok(Math.abs((ic.meanIc as number) - 1) < 1e-9, `完全单调的横截面 IC 应当是 1，实得 ${ic.meanIc}`)
  assert.ok(ic.sections > 0)
})

check('B2 反相关时 IC = −1（符号真的被算出来，不是取了绝对值）', () => {
  const ic = pooledIc(DOWN, constFactor(DOWN), H, { step: H })
  assert.ok(ic.meanIc !== null)
  assert.ok(Math.abs((ic.meanIc as number) + 1) < 1e-9, `应当 −1，实得 ${ic.meanIc}`)
})

check('B3 有效标的数不足的横截面进 skipped，**不**凑一个 IC 出来', () => {
  // 因子全为 null ⇒ 没有任何有效标的
  const empty = UP.symbols.map(() => new Array<number | null>(UP.bars).fill(null))
  const ic = pooledIc(UP, empty, H, { step: H })
  assert.equal(ic.sections, 0, '一个有效标的都没有 ⇒ 0 个横截面')
  assert.ok(ic.skipped > 0, '被跳过时必须计数 —— 报 0 个横截面但 skipped=0 会让人以为"没数据"')
  assert.equal(ic.meanIc, null, 'meanIc 必须是 null，不能退化成 0')
})

check('B4 range 真的限制取样区间（只跑后半段 ⇒ sections 大约减半）', () => {
  const all = pooledIc(UP, constFactor(UP), H, { step: H })
  const half = pooledIc(UP, constFactor(UP), H, { step: H, range: { from: 50, to: 100 } })
  assert.ok(half.sections < all.sections, `限制区间后 sections 必须变少（${half.sections} < ${all.sections}）`)
  assert.ok(half.sections > 0)
})

console.log('\n── C. 回测记账：毛与成本同分母 ──')

check('C1 腿均毛 = mean(side·r)，手算值 20 bps', () => {
  const r = crossSectionBacktest(UP, constFactor(UP), CFG)
  assert.ok(r.grossBpsPerLeg !== null)
  assert.ok(Math.abs((r.grossBpsPerLeg as number) - 20) < 1e-6, `手算 20 bps，实得 ${r.grossBpsPerLeg}`)
})

check('C2 marketBpsPerLeg 是全体等权（手算 25 bps）—— 多空对冲的对照量', () => {
  const r = crossSectionBacktest(UP, constFactor(UP), CFG)
  assert.ok(r.marketBpsPerLeg !== null)
  assert.ok(Math.abs((r.marketBpsPerLeg as number) - 25) < 1e-6, `手算 25 bps，实得 ${r.marketBpsPerLeg}`)
})

check('C3 sign=−1 时多空互换（毛 = −20 bps）—— 方向旋钮真的接在排序上', () => {
  const r = crossSectionBacktest(UP, constFactor(UP), { ...CFG, sign: -1 })
  assert.ok(r.grossBpsPerLeg !== null)
  assert.ok(Math.abs((r.grossBpsPerLeg as number) + 20) < 1e-6, `反向应当 −20 bps，实得 ${r.grossBpsPerLeg}`)
})

check('C4 第一条横截面的换手是 1.0（开仓那次单边成本必须被算进去）', () => {
  const p = makePanel(SYMS, 30, (j) => j * 10)
  const r = crossSectionBacktest(p, constFactor(p), CFG)
  assert.equal(r.log[0].turnover, 1, '第一次没有"上一本"，|Δ|=1 是开仓 —— 漏了它等于开仓不要钱')
})

check('C5 因子恒定时后续换手为 0（不无中生有地收费）', () => {
  const p = makePanel(SYMS, 30, (j) => j * 10)
  const r = crossSectionBacktest(p, constFactor(p), CFG)
  assert.equal(r.log[1].turnover, 0, '持仓没变 ⇒ 换手必须为 0')
  // ★ 用容差而不是 `===`：乘性价格算出来的 20 在浮点下是 20.00000000000002，
  //   写成精确相等就是对**正确的输入**报错（判据 2）。
  assert.ok(
    Math.abs((r.log[1].grossBpsPerLeg as number) - 20) < 1e-6,
    `毛与换手无关，仍是 20，实得 ${r.log[1].grossBpsPerLeg}`,
  )
})

check('C6 costBpsPerLeg = 单边成本 × 平均换手（同分母，可直接与毛相减）', () => {
  const p = makePanel(SYMS, 30, (j) => j * 10)
  const r = crossSectionBacktest(p, constFactor(p), CFG)
  const oneWay = CFG.feeBps + CFG.slipBps
  const avgTurnover = r.log.reduce((s, x) => s + x.turnover, 0) / r.log.length
  assert.ok(
    Math.abs(r.costBpsPerLeg - oneWay * avgTurnover) < 1e-9,
    `成本应当 = ${oneWay} × ${avgTurnover}，实得 ${r.costBpsPerLeg}`,
  )
  assert.ok(r.netBpsPerLeg !== null && Math.abs(r.netBpsPerLeg - ((r.grossBpsPerLeg as number) - r.costBpsPerLeg)) < 1e-9)
})

check('C7 long/short 两列是**同一个口径**（都是 side·r：这条腿作为仓位赚了多少）', () => {
  // DOWN 面板：品种 j 的收益 = −j·10 bps；sign=−1 ⇒ 做多因子最小的 j∈{0,1}、做空最大的 j∈{4,5}
  //   手算：long = mean(0, −10) = −5；short = mean(−(−40), −(−50)) = +45
  //   ⇒ 毛/腿 = (2×(−5) + 2×45) / 4 = +20（与 C3 在 UP 面板上的 −20 互为镜像）
  const r = crossSectionBacktest(DOWN, constFactor(DOWN), { ...CFG, sign: -1 })
  assert.ok(
    Math.abs((r.longBpsPerLeg as number) + 5) < 1e-6,
    `多头腿（做多跌得最少的）应当是 −5 bps，实得 ${r.longBpsPerLeg} —— ` +
      '若它是 +5，说明这一列取的是"做空的视角"（两列口径不一致，读的人会以为它们同向）',
  )
  assert.ok(Math.abs((r.shortBpsPerLeg as number) - 45) < 1e-6, `空头腿应当是 +45 bps，实得 ${r.shortBpsPerLeg}`)
  assert.ok(Math.abs((r.grossBpsPerLeg as number) - 20) < 1e-6, `毛/腿应当是 +20，实得 ${r.grossBpsPerLeg}`)
})

check('C8 标的不足 minNames 的横截面进 skipped，不给结果', () => {
  const p = makePanel(SYMS.slice(0, 4), BARS, (j) => j * 10) // 4 个标的，topK=2 ⇒ 需要 ≥5
  const r = crossSectionBacktest(p, constFactor(p), CFG)
  assert.equal(r.rebalances, 0)
  assert.ok(r.skipped > 0)
  assert.equal(r.grossBpsPerLeg, null, '没有轮次 ⇒ 毛必须是 null，不能是 0')
})

console.log('\n── D. 判决：三态互不顶替，三种 rejected 各有各的 gate ──')

/** 造一个"什么都好"的回测结果，再按需覆盖 —— 让每个分支只被它自己的输入命中。 */
function res(over: Partial<CrossSectionResult> = {}): CrossSectionResult {
  return {
    rebalances: 100,
    grossBpsPerLeg: 20,
    costBpsPerLeg: 8,
    netBpsPerLeg: 12,
    longBpsPerLeg: 20,
    shortBpsPerLeg: 20,
    marketBpsPerLeg: 3,
    winRate: 0.6,
    turnoverPerRebalance: 1,
    skipped: 0,
    log: [],
    ...over,
  }
}
function ic(over: Partial<PooledIcResult> = {}): PooledIcResult {
  return { points: [], meanIc: 0.03, tStat: 3, sections: 100, skipped: 0, minNames: 6, positiveShare: 0.7, ...over }
}

check('D1 通过：净 > 0 且胜率达标 ⇒ accepted / pass', () => {
  const v = judgeCrossSection(res(), ic())
  assert.equal(v.outcome, 'accepted')
  assert.equal(v.gate, 'pass')
})

check('D2 三种 rejected 的 gate **互不相同**（否则归因会糊成一句不可行动的话）', () => {
  const noDir = judgeCrossSection(res(), ic({ tStat: 1.2, meanIc: 0.001 }))
  const negGross = judgeCrossSection(res({ grossBpsPerLeg: -2, netBpsPerLeg: -10 }), ic())
  const costEaten = judgeCrossSection(res({ grossBpsPerLeg: 1, costBpsPerLeg: 8, netBpsPerLeg: -7 }), ic())
  assert.equal(noDir.outcome, 'rejected')
  assert.equal(negGross.outcome, 'rejected')
  assert.equal(costEaten.outcome, 'rejected')
  const gates = new Set([noDir.gate, negGross.gate, costEaten.gate])
  assert.equal(gates.size, 3, `三种 rejected 必须有三个不同的 gate，实得 ${[...gates].join('、')}`)
  // 三句话也必须互不相同 —— 它们指向的动作相反（换因子族 / 反向 / 降换手）
  assert.equal(new Set([noDir.headline, negGross.headline, costEaten.headline]).size, 3)
})

check('D3 样本不够是 unverifiable 而不是 rejected（"还没测够"≠"不行"）', () => {
  const v = judgeCrossSection(res({ rebalances: 10 }), ic())
  assert.equal(v.outcome, 'unverifiable')
  assert.equal(v.gate, 'sections')
})

check('D4 IC 的 t 算不出来也是 unverifiable，且 gate 与"样本不够"不同', () => {
  const v = judgeCrossSection(res(), ic({ tStat: null, meanIc: null }))
  assert.equal(v.outcome, 'unverifiable')
  assert.notEqual(v.gate, 'sections', '两种"证据不足"指向不同动作（攒样本 vs 因子本身没输出），不许共用一个 gate')
})

check('D5 毛 ≥ 成本但胜率不足 ⇒ unverifiable（不是 rejected：它可能只是样本不够）', () => {
  const v = judgeCrossSection(res({ winRate: 0.3 }), ic())
  assert.equal(v.outcome, 'unverifiable')
  assert.equal(v.gate, 'winrate')
})

check('D6 净正好贴在 0 上 ⇒ unverifiable，gate 与"胜率不足"分开', () => {
  const v = judgeCrossSection(res({ grossBpsPerLeg: 8, costBpsPerLeg: 8, netBpsPerLeg: 0 }), ic())
  assert.equal(v.outcome, 'unverifiable')
  assert.equal(v.gate, 'net')
})

check('D7 每一条判决都必须带非空 reasons（没有理由的判决等于没判）', () => {
  const cases = [
    judgeCrossSection(res(), ic()),
    judgeCrossSection(res(), ic({ tStat: 1.2 })),
    judgeCrossSection(res({ grossBpsPerLeg: -2 }), ic()),
    judgeCrossSection(res({ grossBpsPerLeg: 1, costBpsPerLeg: 8 }), ic()),
    judgeCrossSection(res({ rebalances: 1 }), ic()),
  ]
  for (const c of cases) {
    assert.ok(c.reasons.length >= 2, `${c.outcome}/${c.gate} 的理由太少：${JSON.stringify(c.reasons)}`)
    assert.ok(c.headline.length > 0)
  }
})

console.log('\n── E. 服务层：训练段定方向、检验段判决 ──')

/** 造一段 K 线（乘性常数收益）。 */
function candles(symbol: string, bars: number, retBps: number): Candle[] {
  let px = 100
  return Array.from({ length: bars }, (_, k) => {
    px *= 1 + retBps / 10_000
    return { t: (k + 1) * 900_000, o: px, h: px * 1.001, l: px * 0.999, c: px, v: 100 }
  })
}

const SPEC = { slug: 'sma_gap_raw_4', nameCn: '测试', category: '测试', base: 'sma_gap', transform: 'raw', window: 4 }

check('E1 方向 sign 必须与**训练段** IC 的符号一致（不是全段，也不是看图选的）', () => {
  const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, (j - 2.5) * 8) }))
  const r = evaluateBreadth({ inputs, specs: [SPEC], config: { horizon: 4, topK: 2 }, dryRun: true })
  const row = r.rows[0]
  assert.ok(row.trainMeanIc !== null, '训练段必须能算出 IC')
  assert.equal(row.sign, (row.trainMeanIc as number) >= 0 ? 1 : -1, 'sign 必须来自训练段 IC 的符号')
})

check('E2 训练段与检验段是**两段**（各自都有横截面，不是全段算两遍）', () => {
  const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, (j - 2.5) * 8) }))
  const cfg = { horizon: 4, topK: 2, trainShare: 0.6 }
  const r = evaluateBreadth({ inputs, specs: [SPEC], config: cfg, dryRun: true })
  const row = r.rows[0]
  assert.ok(row.trainSections > 0 && row.sections > 0, '两段都要有横截面')
  // 面板 400 根、检验段 40% = 160 根、horizon 4 ⇒ 检验段横截面数必须明显小于训练段
  assert.ok(row.sections < row.trainSections, `检验段(${row.sections}) 应当比训练段(${row.trainSections}) 少`)
  const { train, test } = splitRanges(400, 0.6)
  assert.deepEqual(train, { from: 0, to: 240 })
  assert.deepEqual(test, { from: 240, to: 400 })
})

check('E3 被拒的行**不跑**反向诊断（bothDirectionsPass 必须是 false，不是"没测所以 true"）', () => {
  const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, (j - 2.5) * 8) }))
  const r = evaluateBreadth({ inputs, specs: [SPEC], config: { horizon: 4, topK: 2 }, dryRun: true })
  for (const row of r.rows) {
    if (row.outcome !== 'accepted') assert.equal(row.bothDirectionsPass, false, `${row.slug} 未通过却标了 bothDirectionsPass`)
  }
})

check('E4 面板凑不出横截面 ⇒ gate=panel 且 unverifiable（不是 rejected）', () => {
  const inputs = SYMS.slice(0, 2).map((s, j) => ({ symbol: s, candles: candles(s, 400, j * 8) }))
  const r = evaluateBreadth({ inputs, specs: [SPEC], config: { horizon: 4, topK: 3 }, dryRun: true })
  assert.equal(r.panelUsable, false)
  assert.ok(r.panelProblem !== null && r.panelProblem.length > 0, '面板不可用时必须说明原因')
  for (const row of r.rows) {
    assert.equal(row.outcome, 'unverifiable')
    assert.equal(row.gate, 'panel')
    // ★ null 不许退化成 0：没跑过就是 null，"算出来是 0"是另一件事
    assert.equal(row.grossBpsPerLeg, null)
    assert.equal(row.meanIc, null)
    assert.equal(row.sign, null)
  }
})

check('E5 缺品种进 missing 并且**绝不**回落合成数据（symbols 数如实反映）', () => {
  const bp = loadBreadthPanel({ symbols: ['BTCUSDT', 'NOSUCHPAIR'] })
  assert.ok(bp.missing.includes('NOSUCHPAIR'), '找不到的品种必须被指名')
  assert.ok(!bp.panel.symbols.includes('NOSUCHPAIR'), '找不到的品种不许出现在面板里')
  assert.equal(bp.symbols, bp.panel.symbols.length, 'symbols 必须等于面板实际品种数')
  // 关键：面板里所有品种都必须来自磁盘上真实存在的文件（injected 除外）
  for (const s of bp.sources) {
    assert.ok(existsSync(s.file), `${s.symbol} 的来源文件不存在却被放进了面板`)
    assert.ok(!/SYNTH/i.test(s.symbol), 'breadth 绝不允许用合成数据顶替 —— 横截面里合成品种之间没有真实相关性')
  }
})

check('E6 台账行必须带面板指纹（没有指纹的结论无法复核，也无法在数据变化后作废）', () => {
  const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, (j - 2.5) * 8) }))
  const r = evaluateBreadth({ inputs, specs: [SPEC], config: { horizon: 4, topK: 2 }, dryRun: true })
  assert.ok(r.panelHash.length > 0)
  for (const row of r.rows) assert.equal(row.panelHash, r.panelHash)
})

check('E7 指纹对配置敏感：换 horizon / topK / 成本，指纹必须变', () => {
  const mk = (config: Record<string, number>) => {
    const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, (j - 2.5) * 8) }))
    return evaluateBreadth({ inputs, specs: [SPEC], config, dryRun: true }).panelHash
  }
  const a = mk({ horizon: 4, topK: 2 })
  const b = mk({ horizon: 8, topK: 2 })
  const c = mk({ horizon: 4, topK: 3 })
  assert.notEqual(a, b, '换 horizon 指纹必须变，否则旧结论会被拿去给新配置背书')
  assert.notEqual(a, c, '换 topK 指纹必须变')
})

check('E8 空候选不崩，且报告 candidates=0（不是假装跑过了）', () => {
  const inputs = SYMS.map((s, j) => ({ symbol: s, candles: candles(s, 400, j * 8) }))
  const r = evaluateBreadth({ inputs, specs: [], config: { horizon: 4, topK: 2 }, dryRun: true })
  assert.equal(r.candidates, 0)
  assert.equal(r.rows.length, 0)
})

// ═══════════════════════════════════════════════════════════════════
// E9~E12 台账合并：**"面板"与"配置"是两种失效语义**
//
// 这里曾经有一个真 bug（2026-09-20 第二十三轮发现）：`panelFingerprint` 把
// 面板身份和评估配置拼成一个字符串，合并旧行时按"指纹相等"过滤 ⇒ 跑第二个
// 持有期时把第一个持有期的行当"过时"删了 ⇒ **台账永远只装得下一个持有期**，
// 而 UI 卡片正是按持有期分组来展示"1 小时差 40 倍 → 2 天反超"这条趋势的。
// 面板没变、只是换了个评法 —— 旧结论依然成立，它是**另一个格子**。
//
// ★ E9 与 E10 必须**同时**存在：E9 单独可以被"永不清理"满足，
//   E10 单独可以被"总是清理"满足，两条一起才唯一确定那个行为（判据 3）。
// ═══════════════════════════════════════════════════════════════════

/** 唯一临时台账路径：目录名随机 ⇒ 天然是新文件，**不需要任何删除动作**。 */
function freshIndexPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'breadth-smoke-')), 'index.json')
}

/** 造一批"同一个品种 j 有不同收益斜率"的注入 K 线（`phase` 用来模拟换面板）。 */
const mkInputs = (phase: number, bars = 600) =>
  SYMS.map((s, j) => ({ symbol: s, candles: candles(s, bars, (j - 2.5) * 8 + phase) }))

/** 同一块面板（同一批 candles 复用）跑多套配置并**真落盘**。 */
function landConfigs(indexPath: string, cfgs: Record<string, number>[], inputs = mkInputs(0)): void {
  for (const config of cfgs) evaluateBreadth({ inputs, specs: [SPEC], config, indexPath, dryRun: false })
}

check('E9 ★ 同面板只换**持有期** ⇒ 旧持有期的行必须保留（台账要装得下多套配置）', () => {
  const indexPath = freshIndexPath()
  landConfigs(indexPath, [
    { horizon: 4, topK: 2 },
    { horizon: 8, topK: 2 },
  ])
  const { index } = readBreadthIndex(indexPath)
  const horizons = new Set(index.rows.map((r) => r.horizon))
  assert.ok(
    horizons.has(4) && horizons.has(8),
    `换持有期后台账里只剩 h=${[...horizons].join(',')} —— 旧配置的行被当成"过时"删掉了。` +
      `验收点要看的正是**跨持有期的趋势**，只剩一档就看不出来`,
  )
  assert.equal(index.rows.length, 2, `两档 × 1 个候选应当是 2 行，实际 ${index.rows.length}`)
})

check('E10 ★ 但换**面板** ⇒ 旧行必须整体作废（否则 E9 的修法会退化成"永不清理"）', () => {
  const indexPath = freshIndexPath()
  // 注入面板的内容指纹默认只含 bar 数，不含价格 ⇒ 必须显式给哈希才能模拟"换面板"
  const a = mkInputs(0)
  const b = mkInputs(50)
  evaluateBreadth({
    inputs: a,
    injectedHashes: SYMS.map((_, i) => `panel-A-${i}`),
    specs: [SPEC],
    config: { horizon: 4, topK: 2 },
    indexPath,
    dryRun: false,
  })
  const oldHashes = readBreadthIndex(indexPath).index.rows.map((r) => r.panelHash)
  assert.equal(oldHashes.length, 1)
  evaluateBreadth({
    inputs: b,
    injectedHashes: SYMS.map((_, i) => `panel-B-${i}`),
    specs: [SPEC],
    config: { horizon: 8, topK: 2 },
    indexPath,
    dryRun: false,
  })
  const { index } = readBreadthIndex(indexPath)
  assert.equal(
    index.rows.filter((r) => oldHashes.includes(r.panelHash)).length,
    0,
    '面板变了，旧面板的行还在 —— 面板事实与行内容会交叉矛盾，而读的人只看行不看面板',
  )
  assert.equal(index.rows.length, 1, `换面板后应当只剩新面板的行，实际 ${index.rows.length}`)
})

check('E11 同一格重跑 ⇒ 覆盖，不产生重复行（否则"多档并存"会变成"越跑越多"）', () => {
  const indexPath = freshIndexPath()
  landConfigs(indexPath, [
    { horizon: 4, topK: 2 },
    { horizon: 4, topK: 2 },
  ])
  const { index } = readBreadthIndex(indexPath)
  assert.equal(index.rows.length, 1, `同一格跑了两次应当仍是 1 行，实际 ${index.rows.length}`)
})

check('E12 samePanel 是唯一的"同面板"判据：对配置不敏感、对面板敏感', () => {
  const a = mkInputs(0)
  const hashOf = (config: Record<string, number>) =>
    evaluateBreadth({ inputs: a, specs: [SPEC], config, dryRun: true }).panelHash
  const base = hashOf({ horizon: 4, topK: 2 })
  const otherCfg = hashOf({ horizon: 192, topK: 5 }) // 同面板、配置全不同
  assert.notEqual(base, otherCfg, '指纹整体必须对配置敏感（E7 已钉）')
  assert.equal(
    samePanel(base, otherCfg),
    true,
    '★ 同面板不同配置必须判为"同一面板" —— 否则旧行被静默丢掉（就是那个 bug）',
  )
  const moved = mkInputs(0)
  moved[0] = { symbol: moved[0].symbol, candles: candles(moved[0].symbol, 599, 0) } // 少一根 ⇒ 面板变
  assert.equal(
    samePanel(base, evaluateBreadth({ inputs: moved, specs: [SPEC], config: { horizon: 4, topK: 2 }, dryRun: true }).panelHash),
    false,
    '面板实际变了（bar 数不同）必须判为不同面板',
  )
  // 顶层那个字段名必须自证"只描述最近一次"：叫 config 会被读成"这些行的配置"
  const { index } = readBreadthIndex(freshIndexPath())
  assert.ok('lastRunConfig' in index, '顶层配置字段必须叫 lastRunConfig（名字里带 lastRun）')
  assert.ok(
    !('config' in (index as unknown as Record<string, unknown>)),
    '旧的 config 键不许留着 —— 多档并存时它会被读成"全部行的配置"（判据 21）',
  )
})

console.log('\n── F. 系统级：同一件事只有一个来源 ──')

check('F1 成本口径来自 DEFAULT_EXEC，没有第二份费率字面量', () => {
  const code = readCode('server/breadthService.ts')
  assert.ok(/DEFAULT_EXEC\.takerFeeBps/.test(code), '费率必须取自 DEFAULT_EXEC（与策略层回测同一份）')
  assert.ok(/DEFAULT_EXEC\.slippageBps/.test(code), '滑点必须取自 DEFAULT_EXEC')
})

check('F2 breadth 不许出现合成数据入口（genSynthCandles / loadEvidence）', () => {
  const code = readCode('server/breadthService.ts')
  assert.ok(!/genSynthCandles/.test(code), 'breadth 面板绝不能用合成行情 —— 10 个合成品种之间没有真实相关性')
  assert.ok(
    !/loadEvidence/.test(code),
    '不许复用 loadEvidence：它是(单品种 + 缺失回落合成)的语义，横截面不允许回落',
  )
})

check('F3 候选因子的唯一来源是因子台账（breadth 不自己造候选）', () => {
  const code = readCode('server/breadthService.ts')
  assert.ok(/readFactorIndex/.test(code), '必须从因子台账读候选')
  assert.ok(/state === 'accepted'/.test(code), '只跑台账里 accepted 的因子')
})

check('F4 项目里没有第二份横截面回测实现', () => {
  const code = readCode('server/breadthService.ts')
  assert.ok(/crossSectionBacktest/.test(code), '必须调用引擎里的 crossSectionBacktest')
  // 不许自己排序选 topK —— 那是"同一动作的第二条路径"
  assert.ok(!/\.sort\(\s*\(a,\s*b\)\s*=>\s*b\.f/.test(code), '排序必须发生在引擎里，服务层不许再排一次')
})

check('F5 单边成本 = 费 + 滑（对外解释口径只有这一份）', () => {
  const cfg = defaultBreadthConfig()
  assert.equal(oneWayCostBps(cfg), cfg.feeBps + cfg.slipBps)
  assert.equal(oneWayCostBps(cfg), 8, `默认单边成本应当是 8 bps（taker 5 + slip 3），实得 ${oneWayCostBps(cfg)}`)
})

check('F6 台账默认路径在 data/breadth/ 下，不写进别的目录', () => {
  const p = defaultBreadthIndexPath('/tmp/whatever')
  assert.ok(p.includes(join('data', 'breadth')), `实际 ${p}`)
  assert.ok(p.endsWith('.json'))
})

check('F7 阈值来自 DEFAULT_CROSS_SECTION_GATE，调用方不能自己传一套', () => {
  const code = readCode('server/breadthService.ts')
  assert.ok(/DEFAULT_CROSS_SECTION_GATE/.test(code))
})

check('F8 真实历史目录枚举不猜文件名（按后缀实际列出）', () => {
  const list = listHistorySymbols('data/history')
  // 本机有就跑真断言，没有就只验"不抛异常且返回数组"（CI 机器可能没拉过历史）
  assert.ok(Array.isArray(list))
  for (const s of list) assert.ok(/^[A-Z0-9]+$/.test(s), `枚举出的品种名可疑：${s}`)
})

check('F9 factorSeries 复用 base 序列：同一 (base,window) 只构建一次', () => {
  // ★ 为什么这条挂在 breadth 上：横截面扫描是 142 因子 × N 持有期 × 10 品种，
  //   而**同一条 base 序列被 5 个变换共用**。不缓存的话那些时间全花在重复劳动上，
  //   而"慢"会被误读成"数据太大"，真正的修法就此被掩盖。
  // ★ 先清零，再断言**绝对值**（`miss === 1` 而不是 `after.miss - before.miss === 1`）。
  //   差值的口径不稳：同一个进程里只要别处也构建过序列，差值就能被顶替成 1，
  //   而这与"这条 base 只构建了一次"是两件不同的事（判据 31：口径要同源）。
  //   这个清零函数原先被 import 进来却从没调用过 —— 等于一条"写了没接线"的护栏。
  resetSeriesCacheStats()
  const cs = candles('CACHE', 200, 5)
  factorSeries({ base: 'sma_gap', transform: 'raw', window: 4 }, cs)
  factorSeries({ base: 'sma_gap', transform: 'smooth', window: 4 }, cs)
  factorSeries({ base: 'sma_gap', transform: 'vol_scaled', window: 4 }, cs)
  const after = seriesCacheStats()
  const miss = after.miss
  const hit = after.hit
  assert.equal(miss, 1, `同一条 base 序列应当只构建一次，实际 miss=${miss}`)
  assert.ok(hit >= 2, `后两个变换应当命中缓存，实际 hit=${hit}`)
  assert.equal(after.stale, 0, 'stale>0 说明调用方就地改了 K 线数组 —— 缓存会继续供应旧序列')
})

check('F10 就地改过的数组必须被认出来（这是"读路径静默陈旧"唯一的护栏）', () => {
  // ★ 这条补的是 `memoDerived` 里**唯一防止静默陈旧**的那道 O(1) 指纹核对。
  //   原先 F9 只断言 `stale === 0`——那只说明"这条用例里没发生陈旧"，
  //   而**陈旧真的发生时认不认得出**，一条断言都没有（判据 3：没有"只有它才会
  //   命中的输入"，这条护栏就一直没被测过）。
  //   打坏它：把 `if (hit && hit.fp === fp)` 改成 `if (hit)` ⇒ 这里红。
  //
  // ★ 直接用底层原语 `memoDerived` 而**不是** `seriesOf`：后者内部还有一层
  //   `closesOf` 也在同一个数组上记账，一次就地改动会让两个键各记一次 stale
  //   （实测拿到 2 而不是 1）。用一个键的探针，计数才是"这件事发生了几次"。
  resetSeriesCacheStats()
  const cs: Candle[] = candles('STALE', 120, 11)
  const key = 'f10-probe'
  const build = () => cs.length
  assert.equal(memoDerived(cs, key, build), 120)
  assert.equal(seriesCacheStats().stale, 0, '第一次是 miss，不是 stale —— 两个计数不许混')

  // 同一个数组、同一个键、**内容没变** ⇒ 必须命中（这是反向对照：
  // 少了它，"每次都重建"也能让 stale 恒为 0，把这条断言变成假绿）。
  assert.equal(memoDerived(cs, key, build), 120)
  assert.equal(seriesCacheStats().hit, 1, '内容没变却不命中 ⇒ 缓存没起作用，stale 恒 0 就没有意义')
  assert.equal(seriesCacheStats().stale, 0, '没有就地改动就不许记 stale（否则这个计数会变成噪声，没人再信它）')

  // 就地追加一根（一个真实的违规操作：`walkForward` 之外的调用方改数组）
  cs.push({ ...cs[cs.length - 1], t: cs[cs.length - 1].t + 900_000, c: cs[cs.length - 1].c + 1 })
  assert.equal(memoDerived(cs, key, build), 121, '重建必须发生在**新数组**上（拿到 120 = 供应了旧序列）')
  assert.equal(seriesCacheStats().stale, 1, '就地改过的数组必须被记成 stale —— 否则缓存会继续供应旧序列，而结果"看着完全正常"')
})

check('F11 换区间（截断）也必须被认出来，不许只认追加', () => {
  // ★ 与 F10 配对：指纹取的是「长度 + 首末 t」，所以截断、换区间、追加三类
  //   真实会发生的操作都要能被识别。只测其中一类时，另外两类是怎么坏的没人知道。
  resetSeriesCacheStats()
  const full: Candle[] = candles('TRUNC', 120, 13)
  const key = 'f11-probe'
  const build = () => full.length
  assert.equal(memoDerived(full, key, build), 120)

  // 同一个数组对象被换成了"后半段"（真实形态：调用方 `arr.length = 60`）
  full.length = 60
  assert.equal(memoDerived(full, key, build), 60, '拿到 120 = 供应了旧序列（区间已经不是调用方要的那一段了）')
  assert.equal(seriesCacheStats().stale, 1, '截断也是一种就地改动，必须被认出来')
})

check('F12 换区间但长度不变（首末 t 都变了）也必须被认出来', () => {
  // ★ 第三类：把整段换成**长度相同、区间不同**的数据（真实形态：调用方
  //   `arr.splice(0, n, ...other)` 或复用了同一个数组装另一个品种的 K 线）。
  //   只按长度做指纹的实现会在这一条上静默供应旧序列 —— 而那种实现同样
  //   能通过"追加"那条（长度变了）。
  resetSeriesCacheStats()
  const arr: Candle[] = candles('SWAP-A', 120, 17)
  const key = 'f12-probe'
  const build = () => arr[0].t
  const t0 = memoDerived(arr, key, build) as number
  assert.equal(t0, arr[0].t)
  // ★ 夹具必须**自己保证**"首末 t 变了"：`candles()` 的 `t` 只由下标决定
  //   （`(k+1)*900_000`），两段数据的时间戳天然相同 —— 直接换内容的话
  //   指纹一模一样、缓存**应该**命中，这条断言就测不到任何东西
  //   （第一版就是这么写的，结果红的是"夹具前提"而不是"缓存"）。
  const other = candles('SWAP-B', 120, 19).map((c, i) => ({ ...c, t: c.t + 8_640_000 + i }))
  for (let i = 0; i < arr.length; i++) arr[i] = other[i]
  assert.notEqual(arr[0].t, t0, '夹具本身要保证两段数据的首根 t 不同，否则这条断言测不到东西')
  assert.equal(memoDerived(arr, key, build), arr[0].t, '换了整段数据却拿到旧序列的首根时间戳 = 静默陈旧')
  assert.equal(seriesCacheStats().stale, 1)
})

// ═══════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════

const pass = results.filter((r) => r.pass).length
const fail = results.length - pass

const dir = join(process.cwd(), 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'breadth-latest.json'),
  JSON.stringify(
    { finishedAt: new Date().toISOString(), pass, fail, results: results.map((r) => ({ name: r.name, pass: r.pass, detail: r.detail })) },
    null,
    2,
  ),
)

console.log('')
console.log(`${fail === 0 ? '✅' : '❌'} 横截面：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.error('\n失败的断言：')
  for (const r of results.filter((x) => !x.pass)) console.error(`  · ${r.name}\n    ${r.detail}`)
  process.exit(1)
}
