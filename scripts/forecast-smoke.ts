/**
 * 走势预测（forecast）烟测 —— 只测**语义不变量**，不测"准不准"。
 *
 * ══ 为什么不测"准不准" ══════════════════════════════════════════════════
 * "准不准"是**数据相关**的：换一段行情结论就变，写进 CI 会变成随机地雷
 * （这个仓库已经栽过一次：断言写死"通过 == 20"，注册表长到 21 就变红）。
 * 所以这里只钉**结构**：什么东西**必须**为 null、哪一种输入**必须**不给
 * actionable、哪一段数据**不许**被用到。
 *
 * ══ 每条断言都要能被"它自己"打红（本仓库栽过 8 次"不可能失败的检查"）══
 * 每类断言下面都留了"打坏它会在哪一条上变红"的注释；
 * 变异验证见 `_mutate_forecast.mjs`（刻意保留 —— 它是"这些断言有牙"的唯一证据）。
 *
 * ★ 刻意**不依赖磁盘**：证据与候选因子都由用例注入
 *   （否则 CI 机器上"跑没跑过因子生产"会决定这条门禁红不红）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Candle } from '../src/engine/types.ts'
import { DEFAULT_EXEC } from '../src/engine/types.ts'
import type { FactorSpec } from '../src/engine/factorEval.ts'
import type { ForecastResult } from '../server/forecastService.ts'
import {
  DEFAULT_FORECAST_GATE,
  EVIDENCE_BAR_MINUTES,
  describeDataAge,
  describeForecastGate,
  parseForecastQuery,
  defaultForecastConfig,
  forecast,
  forecastHeadline,
  forecastSpeech,
  mean,
  normalUpper,
  pickAnalog,
  quantile,
  resetForecastCache,
  resolveHorizon,
  rollingZ,
} from '../server/forecastService.ts'

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

/** 读源码并**剥掉注释**再断言 —— 否则会命中自己写的解释性注释（本项目踩过）。 */
function readCode(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const SRC = 'server/forecastService.ts'
const CODE = readCode(SRC)

// ═══════════════════════════════════════════════════════════════════
// 合成证据：一条确定性的正弦+漂移序列（可复现，不依赖网盘/历史文件）
// ═══════════════════════════════════════════════════════════════════

const BARS = 3000

function synth(bars = BARS, seed = 1): Candle[] {
  let px = 100
  const out: Candle[] = []
  for (let i = 0; i < bars; i++) {
    // 确定性"行情"：低频漂移 + 中频周期 + 一个由 seed 决定的相位。
    // 不含随机数 —— 同一入参必须每次得到同一条序列（断言 D1 依赖这一点）。
    const r = Math.sin((i + seed * 37) / 47) * 40 + Math.cos((i + seed * 11) / 13) * 15 + 2
    px *= 1 + r / 10_000
    out.push({ t: (i + 1) * 900_000, o: px, h: px * 1.0005, l: px * 0.9995, c: px, v: 10 })
  }
  return out
}

/** 三个"真"因子：用引擎里确实存在的 base/transform 组合。 */
const SPECS: FactorSpec[] = [
  { slug: 'ts_rank_raw_8', nameCn: '测试时序排名', category: '测试', base: 'ts_rank', transform: 'raw', window: 8 },
  { slug: 'atr_ratio_raw_16', nameCn: '测试ATR占比', category: '测试', base: 'atr_ratio', transform: 'raw', window: 16 },
  { slug: 'ret_raw_4', nameCn: '测试收益动量', category: '测试', base: 'ret', transform: 'raw', window: 4 },
  { slug: 'sma_gap_raw_8', nameCn: '测试均线缺口', category: '测试', base: 'sma_gap', transform: 'raw', window: 8 },
]

const CFG = { horizonBars: 4, stateDims: 2, neighbors: 50, calibAnchors: 20, barMinutes: 15 }

/**
 * 测试用的门槛：**必须与上面的小配置自洽**。
 *
 * ★ 第一版直接用 `DEFAULT_FORECAST_GATE`（`minSamples: 100`）配 `neighbors: 50`，
 *   于是每条用例都被 `sample` 闸门截住 —— C1 想测 `origin` 却拿到 `sample`。
 *   这不是闸门的问题（顺序是对的），是**夹具自相矛盾**：一个测不出目标的夹具
 *   比没有夹具更费人，因为它会红在一个与你要测的东西无关的地方。
 */
const TH = { ...DEFAULT_FORECAST_GATE, minSamples: 20, minAnchors: 10 }

/** 补齐成完整的 `ForecastConfig`（`pickAnalog` 要完整配置，`forecast()` 收 Partial）。 */
const fullCfg = (patch: Record<string, unknown> = {}) =>
  defaultForecastConfig({ ...CFG, ...patch } as Parameters<typeof defaultForecastConfig>[0])

/**
 * 按**内容**算证据指纹。
 *
 * ★ 旧版写的是 `test-${candles.length}-${origin}` —— 与 seed 无关。
 *   加了结果级缓存之后，这条立刻变成一个真缺陷：`synth(3000,3)` 与
 *   `synth(3000,5)` 指纹相同 ⇒ 后者直接复用前者的结论，而用例全绿。
 *   这正是本仓库记过的那族**假绿**：检查与被检查的东西其实用了同一份数据。
 *   （判据 33：数字/身份要与事实源比，不与一个"看着像标识"的副本比。）
 */
function fingerprint(candles: Candle[]): string {
  const mid = candles[Math.floor(candles.length / 2)]
  const last = candles[candles.length - 1]
  return `test-${candles.length}-${candles[0].c.toFixed(6)}-${mid.c.toFixed(6)}-${last.c.toFixed(6)}`
}

function run(
  patch: Record<string, unknown> = {},
  candles = synth(),
  origin: 'history' | 'synthetic' = 'history',
  thresholds = TH,
  // ★ "现在"必须可给：默认让最后一根刚收完 2 分钟（生产的形状）。
  //   ★★ 这是判据 D9 的直接应用 —— 宿主若不钉住"现在"，夹具时间戳落在 1970
  //   会让每一条用例都报"数据到 56 年前为止"，于是关于数据年龄的断言
  //   测的是夹具、不是产品。
  now: number = nowFor(candles),
) {
  resetForecastCache()
  return forecast({
    symbol: 'TESTUSDT',
    specs: SPECS,
    thresholds,
    evidence: { candles, origin, dataHash: fingerprint(candles) },
    config: { ...CFG, ...patch },
    now,
  })
}

console.log('\n── A. 统计小工具：缺样本必须说"算不出来"，不许退化成 0 ──')

check('A1 空数组的分位数/均值是 null（不是 0）', () => {
  // 打坏它：把 `if (sorted.length === 0) return null` 改成 `return 0`
  assert.equal(quantile([], 0.5), null, '空数组的分位数必须是 null —— 0 是一个"看着正常"的假答案')
  assert.equal(mean([]), null, '空数组的均值必须是 null')
  const s = [1, 2, 3, 4, 5].sort((a, b) => a - b)
  assert.equal(quantile(s, 0.5), 3)
  assert.equal(quantile(s, 0), 1)
  assert.equal(quantile(s, 1), 5)
})

check('A2 normalUpper 在半整数点上的值是已知的（否则一切 z 都不可信）', () => {
  // 打坏它：erfc 的系数表被改错 ⇒ 这里立刻红（且只有这里红）
  assert.ok(Math.abs(normalUpper(0) - 0.5) < 1e-6, `normalUpper(0) 应为 0.5，实际 ${normalUpper(0)}`)
  assert.ok(Math.abs(normalUpper(1.96) - 0.025) < 1e-3, `normalUpper(1.96) 应≈0.025，实际 ${normalUpper(1.96)}`)
  assert.ok(Math.abs(normalUpper(-1.96) - 0.975) < 1e-3, '上尾概率在负 z 上必须 > 0.5（符号弄错会让一切都"显著"）')
  assert.ok(normalUpper(5) < 1e-5)
})

check('A3 rollingZ 绝不用未来数据（改未来必须不影响前缀）', () => {
  // ★ 这是本文件最重要的一条：未来函数会让整个校准变成恒等式。
  //   打坏它：把窗口从 [i-lookback, i] 改成全序列标准化 ⇒ 这里立刻红。
  const xs = Array.from({ length: 500 }, (_, i) => Math.sin(i / 9) * 10 + i * 0.01)
  const z1 = rollingZ(xs, 64)
  const xs2 = [...xs]
  for (let i = 300; i < xs2.length; i++) xs2[i] = xs2[i] * 100 + 5_000
  const z2 = rollingZ(xs2, 64)
  for (let i = 0; i <= 299; i++) {
    assert.equal(z1[i], z2[i], `第 ${i} 根的 z 被"未来的数据"改变了 —— 这是未来函数`)
  }
  let diff = 0
  for (let i = 320; i < 500; i++) if (z1[i] !== z2[i]) diff++
  assert.ok(diff > 0, '改了未来却一根 z 都没变 ⇒ 这条断言没有牙（它测不到任何东西）')
})

check('A4 rollingZ 的滚动统计必须与"从头重算"逐点一致（含 null 洞）', () => {
  // ★ 这条抓的是一个真 bug（2026-09-21 修复）：窗口"进"用 xs[i]、"出"用
  //   `window.shift()`（= 最老的非空值）。当离窗位置是 null 时队列不动而 sum 照扣，
  //   两套表示法错位 ⇒ 累计量漂到 varI < 0 ⇒ 整根 z 变 null ⇒
  //   **短序列上一个近邻都找不到**（表现与"数据太少"一模一样）。
  //   对照物必须是**独立实现**（这里用朴素的双重循环），不能复用被测逻辑。
  const lookback = 32
  const xs: (number | null)[] = []
  for (let i = 0; i < 400; i++) {
    // 每 7 根插一个 null，制造"离窗位置是 null"的情形（bug 的触发条件）
    xs.push(i % 7 === 3 ? null : Math.sin(i / 11) * 5 + (i % 13) + (i % 5 === 0 ? 0 : 1e-3 * i))
  }
  const got = rollingZ(xs, lookback)
  const ref = (i: number): number | null => {
    const win: number[] = []
    for (let k = i - lookback + 1; k <= i; k++) {
      const v = k >= 0 ? xs[k] : null
      if (v !== null && Number.isFinite(v)) win.push(v)
    }
    const v = xs[i]
    if (win.length < 20 || v === null || !Number.isFinite(v)) return null
    const m = win.reduce((s, x) => s + x, 0) / win.length
    const varI = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length
    if (varI <= 0) return null
    return (v - m) / Math.sqrt(varI)
  }
  let compared = 0
  for (let i = 0; i < xs.length; i++) {
    const a = got[i]
    const b = ref(i)
    if (a === null && b === null) continue
    compared++
    assert.ok(a !== null && b !== null, `第 ${i} 根：一个是 null 一个不是（${a} vs ${b}）—— 窗口进出没配对`)
    assert.ok(
      Math.abs((a as number) - (b as number)) < 1e-9,
      `第 ${i} 根 z 与从头重算不一致：${a} vs ${b}（差 ${Math.abs((a as number) - (b as number)).toExponential(3)}）`,
    )
  }
  assert.ok(compared > 300, `只比了 ${compared} 根 ⇒ 这条断言覆盖面不够（要警惕恒真）`)
})



check('B1 被选中的近邻两两相隔 ≥ horizon（重叠样本会把有效样本量虚高）', () => {
  // 打坏它：删掉 blocked 的 clash 判断 ⇒ 相邻的几百根会全被选中 ⇒ 这里立刻红
  const candles = synth()
  const r = run({ horizonBars: 12, neighbors: 40, calibAnchors: 5 }, candles)
  // 借服务内部的取样结果：matched 的锚点下标不可见，所以直接用 pickAnalog 复现一次
  //   —— 导出它是为了让这条不变量能被**直接断言**，而不是"读源码看见有个 blocked 数组"
  const { matched } = pickAnalog(
    { specs: [], zs: [Array.from({ length: candles.length }, (_, i) => Math.sin(i / 30) * 3)], trainIc: [0], firstUsable: 100 },
    candles,
    candles.length - 1,
    100,
    candles.length,
    fullCfg({ horizonBars: 12, neighbors: 40 }),
  )
  assert.ok(matched.length > 1, `至少要取到 2 个近邻才谈得上"两两相隔"，实际 ${matched.length}`)
  const at = matched.map((m) => m.at).sort((a, b) => a - b)
  for (let i = 1; i < at.length; i++) {
    assert.ok(
      at[i] - at[i - 1] >= 12,
      `第 ${i - 1} 与第 ${i} 个近邻相隔只有 ${at[i] - at[i - 1]} 根 < horizon=12 ⇒ 它们共享同一段未来`,
    )
  }
  // 而且它必须真的**筛掉过**东西（否则上面的断言可能因为"候选本来就稀疏"而恒真）
  assert.ok(r.sample.separated > 0, '一个重叠样本都没筛掉 ⇒ 这条断言在真实数据上可能是恒真的，要警惕')
})

check('B2 近邻池不许跨过"未来已实现"的边界（否则就是在用未来数据选样本）', () => {
  // 打坏它：把 pickAnalog 的 `i + horizon < searchTo` 改成 `i < searchTo` ⇒ 这里红
  const candles = synth(600)
  const zs = [Array.from({ length: candles.length }, (_, i) => Math.sin(i / 30) * 3)]
  const { matched } = pickAnalog(
    { specs: [], zs, trainIc: [0], firstUsable: 100 },
    candles,
    candles.length - 1,
    100,
    candles.length,
    fullCfg({ horizonBars: 20, neighbors: 10 }),
  )
  for (const m of matched) {
    assert.ok(m.at + 20 <= candles.length - 1, `锚点 ${m.at} 的未来第 20 根还没有收盘 —— 那是未来数据`)
  }
})

console.log('\n── C. 三态判决：没有优势必须说出来 ──')

check('C1 ★ 合成数据一律不给 actionable（合成序列里没有真实市场结构）', () => {
  // 打坏它：把 `origin !== 'history'` 那道闸门删掉 ⇒ 这里立刻红
  const r = run({}, synth(), 'synthetic')
  assert.equal(r.outcome, 'unverifiable')
  assert.equal(r.gate, 'origin')
  assert.ok(
    r.disclosures.some((d) => d.includes('合成')),
    '合成数据必须在 disclosures 里被点名 —— 只说 origin 字段等于没说',
  )
})

check('C2a 数据长度不足 ⇒ 不给方向，target/区间/netEdge 全是 null（不是 0）', () => {
  // ★ 这条**必须**走到 `blank()`（数据长度那条路）。第一版用的是 200 根，
  //   而那条序列其实走的是"近邻池为空"的**另一条路** —— 断言名字在测 A、
  //   实际测的是 B，于是把 `blank()` 改坏也照绿（变异验证 M1 抓出来的）。
  //   现在用 120 根：`minBars = 96+20+neighbors+horizon = 170` ⇒ 必然落到 blank()。
  const r = run({}, synth(120))
  assert.equal(r.outcome, 'unverifiable')
  assert.equal(r.gate, 'sample')
  assert.equal(r.direction, null, '"算不出来"不许退化成"持平"或某个方向')
  assert.equal(r.target, null)
  assert.equal(r.interval, null)
  assert.equal(r.netEdgeBps, null)
  assert.deepEqual(r.path, [], '样本不足时走势图必须是空的，不许画一条凭空的线')
  assert.ok(r.reasons.length > 0 && r.reasons[0].text.includes('攒数据'), '样本不足要指向"攒数据"这个动作')
})

check('C2b 数据够长但门槛不满足 ⇒ 走另一条路，语义必须与 C2a **一致**（都不给数字）', () => {
  // 判据 8：同一个判决不许有两条行为不同的路径。
  // 这一条明确构造"运行期样本不足"：neighbors=50 但门槛要 500 ⇒ 候选池非空却不够。
  const r = run({}, synth(3000, 23), 'history', { ...TH, minSamples: 500 })
  assert.ok(r.sample.matched > 0, `这条要测的是"池子非空但不够"，实际 matched=${r.sample.matched} ⇒ 走错路了`)
  assert.equal(r.outcome, 'unverifiable')
  assert.equal(r.gate, 'sample')
  assert.equal(r.direction, null, '两条路的语义必须一致：判不了就不给方向')
  assert.equal(r.target, null)
  assert.deepEqual(r.path, [])
  assert.ok(r.sample.matched > 0 && r.sample.trainBars > 0, '运行期这条路要把样本事实如实带上（blank 的默认值会丢信息）')
})

check('C3 命中率与基准分不开时 ⇒ no-edge（gate=edge），而不是 actionable', () => {
  // ★ 这一条测的是整个模块的立意：**没有优势要如实说**。
  //   用一条确定性的周期序列（没有可利用方向性）跑，它必须落到 no-edge 或 unverifiable，
  //   绝不允许"因为中位数为负"就变成 actionable。
  const r = run({}, synth(3000, 3))
  assert.notEqual(r.outcome, 'actionable', `确定性周期序列不该被判成 actionable（实际 ${r.outcome}/${r.gate}）`)
  const text = forecastHeadline(r)
  assert.ok(
    /没有统计优势|无法给出可靠预测/.test(text),
    `念给用户的话必须把"不可信"说出来，实际：「${text}」`,
  )
})

check('C4 方向与中位幅度必须同号；target 必须落在 current 与 interval 的内侧关系上', () => {
  const r = run({}, synth(3000, 5))
  if (r.medianBps !== null && r.target !== null && r.direction !== null) {
    assert.equal(r.direction, r.medianBps > 0 ? 'up' : 'down', 'direction 必须由中位幅度的符号推出')
    assert.equal(r.direction, r.target > r.spot ? 'up' : 'down', 'target 与 spot 的相对关系必须与 direction 一致')
    if (r.interval) {
      assert.ok(r.interval.lo <= r.target && r.target <= r.interval.hi, '中位目标必须落 80% 区间之内')
    }
  }
})

check('C5 走势图的分位带必须有序，且 50% 线不等于 10% 线（否则区间是假的）', () => {
  const r = run({}, synth(3000, 7))
  if (r.path.length > 0) {
    for (const p of r.path) {
      assert.ok(p.p10 <= p.p50 && p.p50 <= p.p90, `第 ${p.step} 步分位带无序：${p.p10}/${p.p50}/${p.p90}`)
      assert.ok(p.p90 - p.p10 > 0, `第 ${p.step} 步区间宽度为 0 —— 一条线不是预测`)
    }
    assert.equal(r.path.length, Math.min(4, r.horizonBars), '逐步带应当覆盖 horizon 的每一步')
  }
})

console.log('\n── D. 确定性、口径、与"同一事实只有一个来源" ──')

check('D1 同一输入必须给出逐字段相同的输出（确定性）', () => {
  // 打坏它：在服务里引入 Math.random / 未排序的 Map 迭代 ⇒ 这里红
  const a = run({}, synth(3000, 11))
  const b = run({}, synth(3000, 11))
  assert.deepEqual(
    { o: a.outcome, g: a.gate, d: a.direction, t: a.target, m: a.medianBps, c: a.calibration },
    { o: b.outcome, g: b.gate, d: b.direction, t: b.target, m: b.medianBps, c: b.calibration },
    '两次同参调用的结果不同 ⇒ 里面有非确定性来源',
  )
})

check('D2 成本口径只有一份：单边 = DEFAULT_EXEC 的 fee + slip，往返 = 2×单边', () => {
  const r = run({})
  const oneWay = DEFAULT_EXEC.takerFeeBps + DEFAULT_EXEC.slippageBps
  assert.equal(r.oneWayCostBps, oneWay)
  assert.equal(r.roundTripCostBps, oneWay * 2)
  assert.ok(
    !/=\s*8\b|8\s*bps/.test(CODE.replace(/DEFAULT_EXEC[^\n]*/g, '')),
    '源码里不许出现第二份费率字面量（成本口径必须只来自 DEFAULT_EXEC）',
  )
})

check('D3 特征只来自 factorSeries 与因子台账，不自己造特征', () => {
  // 打坏它：在服务里手写一个"动量 = close[i]-close[i-1]（但不是这个数）" ⇒ 这里红
  assert.ok(CODE.includes('factorSeries('), '特征必须由引擎的 factorSeries 算')
  assert.ok(/acceptedSpecs|specsOverride/.test(CODE), '候选因子必须来自台账 accepted（或测试注入）')
  assert.ok(/readFactorIndex/.test(CODE), '必须读因子台账，不许自带候选')
  // 不许出现横截面/策略/回测的实现（同一动作两条路径）
  for (const banned of ['crossSectionBacktest', 'judgeCrossSection', 'runPipeline', 'tradeGate']) {
    assert.ok(!CODE.includes(banned), `预测层不许调用 ${banned}（下单与横截面判决是别的层的职责）`)
  }
})

check('D4 生产数据路径只有一条：loadEvidence 与因子台账各只被调用一次', () => {
  // ★ 第一版这条写的是"注入口被引用了几次"，数的是**属性访问次数**（7 次）——
  //   那不是"调用点"，是一条会随重构乱红的坏检查（判据 2：对正确的输入报错）。
  //   改成数**真正的调用点**：多一处就是在绕开唯一事实源。
  const dataCalls = (CODE.match(/loadEvidence\(/g) ?? []).length
  assert.equal(dataCalls, 1, `loadEvidence 被调了 ${dataCalls} 次 —— 数据来源必须只有一处`)
  // 注：`acceptedSpecs(cwd)` 带实参，所以不会命中函数**定义**处（那里是 `cwd: string`）
  const specCalls = (CODE.match(/acceptedSpecs\(cwd\)/g) ?? []).length
  assert.equal(specCalls, 1, `acceptedSpecs 被调了 ${specCalls} 次 —— 候选因子只能有一个来源`)
  assert.ok(!/process\.env/.test(CODE), '不许用环境变量切换"要不要读真数据"——那会让 CI 与生产的路径不同')
})

console.log('\n── E. 校准：无泄漏 ──')

check('E1 校准锚点必须全部落在训练段之后（同一批数据不许既选状态向量又评命中率）', () => {
  const r = run({}, synth(3000, 13))
  if (r.calibration) {
    assert.ok(r.calibration.anchors > 0)
    // anchors 数 ≤ 检验段长度 / horizon（这是锚点密度的上界，能抓到"锚点落进训练段"）
    const testBars = r.sample.testBars
    assert.ok(
      r.calibration.anchors <= Math.ceil(testBars / r.horizonBars) + 2,
      `锚点 ${r.calibration.anchors} 超过检验段能容纳的上界（检验段 ${testBars} 根 / horizon ${r.horizonBars}）` +
        ` ⇒ 锚点落进了训练段，而状态向量正是在那一段上挑的`,
    )
  }
  // 源码层：锚点下界必须挂在 trainEnd 上（不是 0，也不是 firstUsable）
  assert.ok(
    /usableFrom\s*=\s*Math\.max\([^)]*trainEnd\)/.test(CODE),
    '锚点下界必须取 max(…, trainEnd) —— 少了 trainEnd 就等于在训练段上评自己',
  )
})

check('E2 基准规则必须被写出来（不许在消费方"猜"基准是哪个方向）', () => {
  const r = run({}, synth(3000, 17))
  if (r.calibration) {
    assert.ok(r.calibration.baseRule.length > 0, 'baseRule 必须非空')
    assert.ok(
      /训练段/.test(r.calibration.baseRule),
      `基准规则必须说明它来自训练段（无泄漏），实际：「${r.calibration.baseRule}」`,
    )
  }
})

check('E3 z 值与命中率/基准率同源（配对差），不是两个独立比例的差', () => {
  // ★ 容差必须是**数值精度级**（1e-6），不能是 0.35 那种"差不多"：
  //   配对差构造上就等于 (命中率 − 基准率)，所以这条等价于"diffs 里必须同时
  //   含两个预测器的指示变量"。容差一松，它就成了恒真式（本仓库栽过的假绿）。
  //   打坏它：把 `diffs.push((dirHit?1:0) - (baseHit?1:0))` 改成只推 dirHit ⇒ 这里红。
  const r = run({}, synth(3000, 19))
  if (r.calibration && r.calibration.se > 0) {
    const impliedDiff = r.calibration.edgeZ * r.calibration.se
    const naiveDiff = r.calibration.hitRate - r.calibration.baseRate
    assert.ok(
      Math.abs(impliedDiff - naiveDiff) < 1e-6,
      `配对差均值 ${impliedDiff} 与 (命中率−基准率) ${naiveDiff} 不等（差 ${(impliedDiff - naiveDiff).toExponential(3)}）` +
        ` ⇒ z 与命中率不是同一批锚点算出来的`,
    )
    assert.ok(
      Math.abs(r.calibration.baseRate - 0.5) > 1e-9 || r.calibration.baseRate > 0,
      '基准率必须真的被算出来',
    )
  }
})

check('E4 门槛住在服务层配置里，调用方不许自报（判据：阈值只在消费方）', () => {
  assert.ok(DEFAULT_FORECAST_GATE.minAnchors > 0 && DEFAULT_FORECAST_GATE.minEdgeZ > 0)
  assert.ok(/opts\.thresholds \?\? DEFAULT_FORECAST_GATE/.test(CODE), '缺省门槛必须来自 DEFAULT_FORECAST_GATE')
})

check('E5 gate 名必须能唯一区分事因（没有优势 / 被成本吃掉 / 校准不了 / 攒数据）', () => {
  for (const g of ["'edge'", "'cost'", "'coverage'", "'calibration'", "'sample'", "'origin'", "'pass'"]) {
    assert.ok(CODE.includes(g), `缺少 gate ${g} —— 事因不同的拒绝必须各有各的词（判据 20）`)
  }
})

console.log('\n── F. 缓存不许改变结论、两个出口不许分歧、分辨率不许自报 ──')

/**
 * 夹具的"现在"。
 *
 * ★★ 为什么必须显式给：合成序列的时间戳从 epoch 起（`t = (i+1)*900_000`），
 *   3000 根的最后一根落在 **1970-01-31**。若让 `forecast` 自己去取
 *   `Date.now()`，**每一条**夹具都会报"数据到 56 年前为止" ——
 *   关于数据年龄的断言就变成了夹具自己的产物，与生产行为无关（判据 D9）。
 *
 * ★ 默认 **offsetMin = 2**：最后一根刚收完 2 分钟 ⇒ 这是**生产的形状**
 *   （真实测量里最后一根就是刚收的），走"数据是最新的"那一支。
 *   要造陈旧的分支，显式传一个更大的 offset —— 别改默认值（改了之后
 *   "新鲜"这条路就没人走过，而它才是生产每天都走的那条）。
 */
function nowFor(candles: Candle[], barMinutes = CFG.barMinutes, offsetMin = 2): number {
  const last = candles[candles.length - 1]
  return last.t + barMinutes * 60_000 + offsetMin * 60_000
}

/** 不走 `run()`（它每次清缓存），用于缓存语义的用例。 */
function raw(
  candles: Candle[],
  origin: 'history' | 'synthetic',
  specs: FactorSpec[],
  hash?: string,
  now: number = nowFor(candles),
) {
  return forecast({
    symbol: 'TESTUSDT',
    specs,
    thresholds: TH,
    evidence: { candles, origin, dataHash: hash ?? fingerprint(candles) },
    config: { ...CFG },
    // ★ 必须钉住"现在"：缓存命中会**重算** `dataAgeMinutes`（这是刻意的 ——
    //   年龄不许跟着结果一起被冻住）。若这里不钉，F1 的"逐字段相同"会被
    //   两次调用之间几微秒的差打红，而那是夹具的问题，不是产品的（判据 A1）。
    now,
  })
}

/** 除 `cache` 与 `disclosures` 之外的**全部**字段（复用的语义就是这些必须一模一样）。 */
function substantive(r: ReturnType<typeof forecast>) {
  const { cache: _c, disclosures: _d, ...rest } = r
  void _c
  void _d
  return rest
}
check('F1 缓存命中 ⇒ 结论逐字段相同，且"命中"这件事**看得见**', () => {
  // 打坏它：命中时对结果做任何二次加工（比如重算 target）⇒ 这里红
  resetForecastCache()
  const c = synth(3000, 31)
  const a = raw(c, 'history', SPECS)
  const b = raw(c, 'history', SPECS)
  assert.equal(a.cache.hit, false, '第一次必须是真算的')
  assert.equal(b.cache.hit, true, '第二次必须命中缓存（否则每次问都要等 6 秒）')
  assert.deepEqual(substantive(a), substantive(b), '复用不许改变任何一个字段')
  assert.ok(
    b.disclosures.some((d) => /复用了/.test(d)),
    '复用必须在 disclosures 里说出来 —— 静默复用会让人以为这是刚算的（判据 11）',
  )
})

check('F2 行情内容变了 ⇒ 必须重算（键里必须有数据指纹）', () => {
  // 打坏它：把 `ev.dataHash` 从 `forecastCacheKey` 的参数里删掉 ⇒ 这里红
  resetForecastCache()
  raw(synth(3000, 33), 'history', SPECS)
  const again = raw(synth(3000, 34), 'history', SPECS)
  assert.equal(again.cache.hit, false, '同长度但内容不同的序列不许复用上一条的结论')
})

check('F3 因子台账的 accepted 集变了 ⇒ 必须重算（★ 它与行情数据毫无关系）', () => {
  // 打坏它：把 `specsFp` 从键里删掉 ⇒ 这里红。
  // 这是最隐蔽的一格：重跑一轮因子生产之后市场一根都没变、dataHash 一模一样，
  // 但状态向量按定义已经不同了 —— 只按 dataHash 做键会**把旧结论发出去**。
  resetForecastCache()
  const c = synth(3000, 35)
  const a = raw(c, 'history', SPECS)
  const b = raw(c, 'history', SPECS.slice(0, 2))
  assert.equal(a.cache.hit, false)
  assert.equal(b.cache.hit, false, '候选因子换了之后不许复用（哪怕行情数据一模一样）')
})

check('F4 证据来源变了 ⇒ 必须重算（同一份内容可以对应合成/真实两种来源）', () => {
  // 打坏它：把 `origin` 从键里删掉 ⇒ 这里红
  resetForecastCache()
  const c = synth(3000, 37)
  const h = fingerprint(c)
  const a = raw(c, 'history', SPECS, h)
  const b = raw(c, 'synthetic', SPECS, h)
  assert.equal(a.cache.hit, false)
  assert.equal(b.cache.hit, false, 'origin 变了必须重算 —— 否则会拿"真实历史"的结论回答合成数据的问题')
  assert.notEqual(a.outcome, b.outcome, '来源不同，判决本来就不同（这正是不能共用缓存的原因）')
})

check('F5 屏幕版与口播版不许出现内容分歧，口播版不许带 Markdown 记号', () => {
  // 打坏它：给口播版另起一套说法（比如把「没有统计优势」改成「优势不明显」）⇒ 这里红
  const say = (t: string, why: string) => assert.ok(t.includes(why), `${why} —— ${t.slice(0, 80)}`)
  for (const seed of [3, 5, 41]) {
    const r = run({}, synth(3000, seed))
    const screen = forecastHeadline(r)
    const speech = forecastSpeech(r)
    assert.ok(!/\*\*/.test(speech), `口播版出现了 ** 记号，TTS 会念成"星号星号"：「${speech.slice(0, 60)}…」`)
    assert.ok(!/`/.test(speech), '口播版不许出现反引号')
    assert.ok(!/⚠️/.test(speech), '口播版不许出现 emoji 警告符')
    if (r.outcome === 'unverifiable') {
      say(screen, '无法给出可靠预测')
      say(speech, '无法给出可靠预测')
    } else if (r.outcome === 'no-edge') {
      say(screen, '没有统计优势')
      say(speech, '没有统计优势')
      const dir = r.direction === 'up' ? '偏上' : r.direction === 'down' ? '偏下' : '方向不明'
      say(screen, dir)
      say(speech, dir)
      if (r.target !== null) {
        say(screen, r.target.toFixed(2))
        say(speech, String(Math.round(r.target)))
      }
    }
  }
  // ★ 单独跑一条**数据太短**的用例：它的 `reasons[0].text` 里带 `**`，
  //   是唯一能验"口播出口真的剥过记号"的路径（no-edge 那支本来就不带记号）。
  //   打坏它：把 `plainText` 的 `**` 替换改成空操作 ⇒ 这条红。
  const tiny = run({}, synth(120))
  assert.equal(tiny.outcome, 'unverifiable', '120 根必须走"数据太短"这条路')
  const tinySpeech = forecastSpeech(tiny)
  assert.ok(!/\*\*/.test(tinySpeech), `口播版漏剥了 ** 记号：「${tinySpeech.slice(0, 80)}…」`)
  say(tinySpeech, '无法给出可靠预测')
})

// ═══════════════════════════════════════════════════════════════════
// ★ F5b：`no-edge` 有**三个**事因，交付句不许把事因说错、也不许重复标签
//
// 为什么单开一条：F5 用的三个夹具（seed 3/5/41）**实测全部落 `gate='edge'`**
// —— 也就是 `cost` / `coverage` 这两支**从来没有被喂过**（判据 B6）。
// 而它们指向的动作与 `edge` **完全相反**（降成本 vs 换方法）：
// 说错就是把人引向错的动作。
// ═══════════════════════════════════════════════════════════════════
check('F5b 三种 no-edge 事因各说各的话；标签不许重复出现', () => {
  const base = run({}, synth(3000, 3))
  assert.equal(base.outcome, 'no-edge', `夹具前提变了：期望 no-edge，实际 ${base.outcome}/${base.gate}`)
  const label = describeForecastGate(base.gate)

  // ① 重复形态 `<标签>（<同一个标签>）` —— 2026-09-22 修掉的那个结巴。
  //    打坏它：屏幕版改回写死「没有统计优势」再把 gate 名塞进括号 ⇒ 这条红。
  const dup = `${label}（${label}）`
  assert.ok(
    !forecastHeadline(base).includes(dup),
    `交付句把同一个标签写了两遍（"${dup}"）—— 同一句话两个主人（红线⑯）`,
  )

  // ② 事因张冠李戴：`cost` 事因下"命中率与平凡规则分不开"是**假话**
  //    —— 那条路上 edge 检验恰恰**过了**，卡住的是幅度付不起成本。
  //    打坏它：把句尾改回写死的那一句 ⇒ 这条红。
  const costCase: ForecastResult = {
    ...base,
    gate: 'cost',
    reasons: [
      {
        from: 'netEdgeBps',
        text: '中位幅度 1.00 bps，往返成本 16 bps ⇒ 净 -15.00 bps。**方向可能对，但幅度不够付成本** —— 该降换手/降费率，不是该换方法。',
      },
    ],
  }
  const costText = forecastHeadline(costCase)
  const costSpeech = forecastSpeech(costCase)
  assert.ok(
    costText.includes('幅度不够付成本'),
    `cost 事因必须把"成本"说出来：「${costText.slice(0, 100)}」`,
  )
  assert.ok(
    !costText.includes('分不开'),
    `cost 事因说了"命中率与平凡规则分不开" —— 那是 edge 事因的话，在这里是假话：「${costText.slice(0, 100)}」`,
  )
  assert.ok(
    !costSpeech.includes('分不开'),
    `口播版同样不许把 cost 事因说成 edge 事因：「${costSpeech.slice(0, 100)}」`,
  )

  // ③ 两个出口对同一个拒绝必须说同一个理由。
  //    ★ 按 gate 取词，而不是钉一个写死的字面量 —— 原来钉字面量，
  //      所以在别的 gate 上"绿"其实是靠那句写死的错话顶着的（假绿）。
  for (const gate of ['edge', 'cost', 'coverage']) {
    const r: ForecastResult = { ...base, gate }
    const w = describeForecastGate(gate)
    assert.ok(forecastHeadline(r).includes(w), `屏幕版没说「${w}」`)
    assert.ok(forecastSpeech(r).includes(w), `口播版没说「${w}」`)
  }
})

check('F6 分辨率钉在唯一有证据的那一档上，四舍五入必须说出来', () => {
  // 打坏它：把 `resolveHorizon` 里的 `asked / barMinutes` 改成直接取 asked ⇒ 这里红
  // 实测根据：`1m × 60 根` 会去找不存在的 BTCUSDT_1m.json，静默回落到合成 GBM，
  // 而用户看到的是"样本不足，攒数据" —— 事因完全指错（判据 25）。
  const hour = resolveHorizon(60)
  assert.equal(hour.barMinutes, EVIDENCE_BAR_MINUTES, '分辨率只能是 EVIDENCE_BAR_MINUTES')
  assert.equal(hour.horizonBars, 4, '1 小时 = 15m × 4 根')
  assert.equal(hour.rounded, false, '1 小时能被 15 分钟整除，不算四舍五入')
  const five = resolveHorizon(5)
  assert.equal(five.horizonBars, 1)
  assert.equal(five.rounded, true, '5 分钟在 15m 底座上只能给到 15 分钟 —— 必须标出"对不齐"')
  assert.equal(five.actualMinutes, 15)
  const day = resolveHorizon(24 * 60)
  assert.equal(day.horizonBars, 96)
  assert.equal(day.rounded, false)
  assert.ok(resolveHorizon(0).horizonBars >= 1, '非法输入必须回落到 1 根，不许给出 0 根')
})

check('F7 交付的每一段文案都不带 markdown 记号，且两条构造路（算得出 / 算不出）都剥干净', () => {
  // 打坏它：把 `finalize()` 从 `forecast()` 的出口摘掉（或把 `markupFree`
  // 改成只 `.trim()`）⇒ 这里红。
  //
  // ★ 为什么这条必须单独存在：本项目**没有任何 markdown 渲染器** ——
  //   CLI 的 console.log、面板的 React 文本节点都会把 `**` 原样显示出来，
  //   口播会念成"星号星号"。而 `reasons` 有**两个**构造出口
  //   （`computeForecast` 的正常路、`blank` 的样本不足路）。
  //   只在其中一个剥，就是"同一个动作两条路径"（判据 8）。
  //
  // ★ 反空转（判据 3）：光断言"没有 `**`"是能被"压根没造出文案"顶替的绿。
  //   所以每个用例都先要求 `reasons.length > 0` 且文本非空 ——
  //   没有文案可查时这条断言必须自己去死，而不是悄悄通过。
  const MARK = /\*\*|`/
  const checkOne = (label: string, r: ReturnType<typeof run>) => {
    assert.ok(r.reasons.length > 0, `${label}：这条用例没造出任何 reasons ⇒ 下面的检查是空转，先把它修成"真的有话说"`)
    const texts = [...r.reasons.map((x) => x.text), ...r.disclosures, forecastHeadline(r)]
    assert.ok(
      texts.every((t) => t.trim().length > 0),
      `${label}：有空的文案段（空串会被"没有记号"这条断言白放过）`,
    )
    for (const t of texts) {
      assert.ok(!MARK.test(t), `${label}：交付文案里出现了 markdown 记号，屏幕会显示成星号/反引号，口播会念出来：「${t.slice(0, 90)}…」`)
    }
    return texts.join(' ')
  }

  // ① 正常路：`no-edge / gate=edge` 那条 reason 在源码里白纸黑字写着 `**…**`，
  //    它是这条断言**真正咬住**的地方（否则就是"变异了也不红"的假门）。
  const edge = checkOne('正常路(seed=3)', run({}, synth(3000, 3)))
  assert.ok(
    edge.includes('分不开') || edge.includes('没有统计优势') || edge.includes('成本'),
    `这条用例没走到带强调记号的判决分支（实际 gate=${run({}, synth(3000, 3)).gate}）⇒ 它证明不了剥离真的发生过`,
  )

  // ② 校准不足那条路（源码里也带 `**`）：把锚点门槛抬到天上去，逼它走那里。
  checkOne('校准不足路', run({}, synth(3000, 3), 'history', { ...TH, minAnchors: 999_999 }))

  // ③ 样本不足路（`blank()`）：这是**另一个**构造出口，判据 8 说的"第二条路"就是它。
  checkOne('样本不足路(blank)', run({}, synth(120)))

  // ④ 合成来源路：它的披露里白纸黑字写着 `**合成/注入**` ——
  //    这一条是 `disclosures` 那半边**唯一**能咬住东西的地方（只查 reasons 会漏掉它）。
  const synthText = checkOne('合成来源路', run({}, synth(3000, 3), 'synthetic'))
  assert.ok(
    synthText.includes('合成'),
    '这条用例没走到"合成数据要明说"那条披露 ⇒ disclosures 那半边的检查是空转',
  )

  // ⑤ 缓存命中时**追加**的那条披露也走同一个出口（它是在 `forecast()` 里拼的，
  //    若出口挪到 `computeForecast` 里就会漏掉这一条）。
  resetForecastCache()
  const c = synth(3000, 3)
  const h = fingerprint(c)
  const first = raw(c, 'history', SPECS, h)
  const second = raw(c, 'history', SPECS, h)
  assert.equal(second.cache.hit, true, '这一条需要真的命中缓存才测得到追加的披露')
  const cachedTexts = [...second.disclosures]
  assert.ok(cachedTexts.length > first.disclosures.length, '缓存命中必须追加一条"复用了旧结论"的披露（否则用户分不清新旧）')
  for (const t of cachedTexts) {
    assert.ok(!MARK.test(t), `缓存路：追加的披露带 markdown 记号：「${t.slice(0, 90)}…」`)
  }
})

check('F8 GET /forecast 只收「未来多少分钟」——分辨率不许调用方自报', () => {
  // 打坏它：把 `parseForecastQuery` 里那段 legacy 检查删掉（或改成静默忽略）
  // ⇒ 这里红。
  //
  // ★ 为什么这条红线要有自己的门：端点本体在 `index.ts`，一 import 就 listen，
  //   断言它只能起一个真服务。把"读哪些参数"抽成纯函数之后，
  //   "传 `barMinutes=1` 会静默回落合成价格"这件事**不需要网络**就能钉住。
  const qs = (s: string) => {
    const u = new URLSearchParams(s)
    return { get: (k: string) => u.get(k), has: (k: string) => u.has(k) }
  }

  // ① 旧参数必须**明确拒绝**，不能静默忽略（静默忽略 = 调用方以为在问 1 分钟，
  //    拿到的是 15 分钟的答案，而两边都不报错）。
  for (const legacy of ['barMinutes=1', 'horizon=60', 'symbol=ETHUSDT&barMinutes=1']) {
    const bad = parseForecastQuery(qs(legacy))
    assert.equal(bad.ok, false, `带 "${legacy}" 的请求必须被拒（它决定去找哪个历史文件）`)
    if (!bad.ok) {
      assert.equal(bad.status, 400)
      assert.equal(bad.error, 'BAR_RESOLUTION_NOT_CALLER_SUPPLIED')
      assert.ok(
        /minutes/.test(bad.message),
        `拒绝的话里必须给出**正确的用法**，否则调用方只知道被拒、不知道改什么：「${bad.message}」`,
      )
    }
  }

  // ② 正常路径：只给分钟数。
  const min60 = parseForecastQuery(qs('minutes=60'))
  assert.equal(min60.ok, true)
  if (min60.ok) {
    assert.equal(min60.symbol, 'BTCUSDT', '缺省标的是 BTCUSDT')
    assert.equal(min60.horizon.barMinutes, EVIDENCE_BAR_MINUTES)
    assert.equal(min60.horizon.horizonBars, 4)
    assert.equal(min60.horizon.rounded, false)
  }

  // ③ 对不齐的必须**标出来**（5 分钟在 15m 底座上只能给 15 分钟）。
  const min5 = parseForecastQuery(qs('minutes=5&symbol=ethusdt'))
  assert.equal(min5.ok, true)
  if (min5.ok) {
    assert.equal(min5.symbol, 'ETHUSDT', '标的必须归一成大写（否则会去找 ethusdt_15m.json）')
    assert.equal(min5.horizon.horizonBars, 1)
    assert.equal(min5.horizon.rounded, true, '"对不齐"必须说出来，不许悄悄按 15 分钟答 5 分钟的问题')
  }

  // ④ 缺省与垃圾输入不许崩、也不许给出 0 根。
  for (const junk of ['', 'minutes=abc', 'minutes=-3', 'minutes=0']) {
    const p = parseForecastQuery(qs(junk))
    assert.equal(p.ok, true, `"${junk}" 应当走缺省而不是报错`)
    if (p.ok) assert.ok(p.horizon.horizonBars >= 1, `"${junk}" 给出的根数是 ${p.horizon.horizonBars}，不许是 0`)
  }
})

/**
 * F9 · 凭据接线：`/forecast` 在路由层要 `x-orch-token`，客户端就必须把 token 传下去。
 *
 * ★★ 这条门是一次**真事故**的反回归（2026-09-21 在交易终端上实测到）：
 *   屏幕上写着「算不出来：HTTP 401 {"error":"UNAUTHORIZED"}」，
 *   而端点本身是好的 —— 我先前用 `curl -H "x-orch-token: …"` 验过它，拿到 200。
 *   ⇒ 判据 10 的镜像：**「我用我的凭据测通」≠「调用方能读」**。
 *     验证必须走**调用方那条路**（界面真的点一次），否则验的是另一件事。
 *   实测走界面那条路时它一次都没通过 —— 端点写好了一整轮，界面根本读不到它。
 *
 * ★ 为什么是这一条精准断言，而不是"扫全仓库找空 token"的通用检查：
 *   我写过那版通用检查，它**误报**两处（`/llm/providers` 的 GET 是开放的；
 *   `/orders/precheck` 实测不带 token 也是 200）。根因是"同一路径可以有多个路由块
 *   （方法不同、鉴权不同）"，而按文本切块会把后面路由的 `authorized()` 吞进来。
 *   ⇒ 一条**会对正确代码报错**的检查比没有检查更费人（判据 2），所以退回精准断言。
 *   （想重做通用版的话：必须先按**方法**归属，并逐条拿真服务核过没有误报。）
 */
check('F9 要凭据的路由，客户端必须把 token 传下去（空 token = 界面上 401）', () => {
  const route = readCode('server/index.ts')
  const at = route.indexOf("url.pathname === '/forecast'")
  assert.ok(at >= 0, '服务端找不到 /forecast 路由 —— 解析器失效，这条断言此刻是空转的')
  assert.ok(
    /authorized\(req\)/.test(route.slice(at, at + 400)),
    '/forecast 路由不再要求凭据了？若是有意放开，请同时改这条断言与客户端（两处必须一致）',
  )

  const src = readCode('src/orch/client.ts')
  const fnAt = src.indexOf('export function getForecast')
  assert.ok(fnAt >= 0, '客户端找不到 getForecast')
  // ★ 切到**下一个 `export`** 为止，不许用固定字数：
  //   第一版写 `fnAt + 700`，结果窗口伸进了下一个函数 `assessCost`（它本来就该传空 token），
  //   于是这条断言**对正确的代码报错**（判据 2）—— 当场红，红得对。
  const nextAt = src.indexOf('\nexport ', fnAt + 1)
  const fnBody = src.slice(fnAt, nextAt > fnAt ? nextAt : fnAt + 700)
  assert.ok(fnBody.includes('orchFetch'), `切出来的函数体里没有 orchFetch —— 窗口切错了：${fnBody.slice(0, 60)}`)
  assert.ok(
    /orchFetch\(\s*base,\s*token,/.test(fnBody),
    "getForecast 必须把 token 原样传下去；写成 '' 会让界面永远 401",
  )
  assert.ok(!/orchFetch\(\s*base,\s*'',/.test(fnBody), 'getForecast 的第二参数不许是空 token')
})

check('F10 数据年龄必须是可观测量，并且两个出口都要说出来（用户报的「报价总是出错」）', () => {
  // ══ 这一条在防什么 ═══════════════════════════════════════════════════
  // 2026-09-22 实测：`data/history/BTCUSDT_15m.json` 最后一根 K 线是
  // **2026-09-18T04:45Z**（四天半以前），而桌宠照旧念「现在 77429 美元」。
  // 数字没算错，**是它被贴了个错的时间标签**，而整条链路上没有一处会红。
  //
  // 打坏它（三条独立的变异，各自只该让这一条红）：
  //   ① 把 `dataAgeMinutes` 从 `ForecastResult` 的返回里删掉 ⇒ 末尾那条 `typeof` 红
  //   ② 把 `describeDataAge(...)` 从 `buildHeadline` 里摘掉 ⇒ "屏幕版"红
  //   ③ 把 `describeDataAge(...)` 从 `forecastSpeech` 里摘掉 ⇒ "口播版"红
  //   ④ 缓存命中时沿用旧的 `dataAgeMinutes`（不重算）⇒ 最后一段红

  // ── ① 纯函数本身的语义：先说清"该在什么条件下说哪一句"（判据 A2）──
  const bar = 15
  const fresh = describeDataAge(2, bar)
  const stale = describeDataAge(6390, bar) // 实测值：4.4 天
  const none = describeDataAge(null, bar)
  assert.ok(!fresh.includes('本该又有'), `2 分钟不该被判成陈旧：「${fresh}」`)
  assert.ok(fresh.includes('最新'), `2 分钟（< 一根）必须说成"最新的"：「${fresh}」`)
  assert.ok(stale.includes('本该又有'), `4.4 天必须说出"本该又收完若干根"：「${stale}」`)
  // ★ 算术必须与分辨率一致：6390 / 15 = 426 根，不许是"随便一个数"。
  assert.ok(
    stale.includes(String(Math.floor(6390 / bar))),
    `陈旧的根数必须是 floor(年龄/barMinutes)=${Math.floor(6390 / bar)}，实际：「${stale}」`,
  )
  // ★ null 不许退化成 0 分钟（红线㉟："缺数据"必须说出来，不许假装是"最新的"）。
  assert.ok(none.includes('一根 K 线都没有'), `没有 K 线时必须如实说，实际：「${none}」`)
  assert.ok(!none.includes('最新'), 'null 绝不许被讲成"数据是最新的" —— 那是最坏的一种谎（红线㉟）')
  // ★ 换分辨率它必须跟着走（派生量只由 barMinutes 决定，不许有第二个常数）。
  assert.notEqual(describeDataAge(6390, 60), describeDataAge(6390, 15), '换分辨率必须改变根数读数')
  // ★ 口播会逐字念它 ⇒ 不许带 markdown 记号、不许带句号（句号由出口加）。
  assert.ok(!/\*\*|`/.test(fresh + stale + none), '年龄文案里不许有 markdown 记号（会被念成"星号星号"）')
  assert.ok(!/[。]$/.test(fresh) && !/[。]$/.test(stale) && !/[。]$/.test(none), '年龄文案末尾不许自带句号')

  // ── ② 新鲜路（生产的形状）：三个出口都说出"最新的" ──
  const okFresh = run({}, synth(3000, 41))
  assert.equal(okFresh.dataAgeMinutes, 2, `夹具给的是"刚收完 2 分钟"，实际 ${okFresh.dataAgeMinutes}`)
  // ★ 反空转（判据 B1）：先证明这条用例**真的**走到了"新鲜"分支，
  //   否则下面三条可能在一条完全不同的路上绿掉。
  assert.ok(
    describeDataAge(okFresh.dataAgeMinutes, okFresh.barMinutes).includes('最新'),
    '这条用例没走到"数据是新的"那一支 ⇒ 下面的检查是空转',
  )
  const freshHead = forecastHeadline(okFresh)
  const freshSpeech = forecastSpeech(okFresh)
  assert.ok(freshHead.includes('最新一根 K 线收于'), `屏幕版没说数据年龄：「${freshHead.slice(0, 90)}…」`)
  assert.ok(freshSpeech.includes('最新一根 K 线收于'), `口播版没说数据年龄：「${freshSpeech.slice(0, 90)}…」`)
  assert.ok(
    okFresh.disclosures.some((d) => d.includes('最新一根 K 线收于')),
    'disclosures 里也要有 —— 面板读的是它，别只在两个出口各写一份（红线⑯）',
  )

  // ── ③ 陈旧路：这是**用户实际遇到的那一条**（数据 4.4 天没更新）──
  const c = synth(3000, 41)
  const staleRun = run({}, c, 'history', TH, nowFor(c, CFG.barMinutes, 6390))
  assert.ok(
    (staleRun.dataAgeMinutes as number) > 6000,
    `夹具没造出陈旧数据（实际 ${staleRun.dataAgeMinutes} 分钟）⇒ 这条用例没测到东西`,
  )
  const staleHead = forecastHeadline(staleRun)
  const staleSpeech = forecastSpeech(staleRun)
  assert.ok(staleHead.includes('本该又有'), `屏幕版没说出"数据没在更新"：「${staleHead.slice(0, 90)}…」`)
  assert.ok(staleSpeech.includes('本该又有'), `口播版没说出"数据没在更新"：「${staleSpeech.slice(0, 90)}…」`)
  // ★★ 这一条是本轮的核心：陈旧的价位**不许**被念成"现在"。
  //   打坏它：把 `forecastSpeech` 里那句 `起点是` 改回 `现在` ⇒ 这里红。
  assert.ok(
    !/现在 \d/.test(staleSpeech),
    `口播把四天前的收盘价念成了"现在" —— 这正是用户报的「报价总是出错」：「${staleSpeech.slice(0, 120)}…」`,
  )

  // ── ④ 缓存命中必须重算年龄，不许把年龄一起冻住 ──
  // 打坏它：把 `forecast()` 命中分支里的 `dataAgeMinutes` / `disclosures` 重建删掉
  //         （改回 `...cached`）⇒ 这里红。
  resetForecastCache()
  const c2 = synth(3000, 42)
  const t0 = nowFor(c2, CFG.barMinutes, 2)
  const first = raw(c2, 'history', SPECS, undefined, t0)
  // 同一份证据、同一个指纹 ⇒ 必然命中；但"现在"往后推了 5 小时。
  const later = raw(c2, 'history', SPECS, undefined, t0 + 300 * 60_000)
  assert.equal(later.cache.hit, true, '这一条需要真的命中缓存，否则测的是首次计算那条路')
  assert.ok(
    (later.dataAgeMinutes as number) > (first.dataAgeMinutes as number) + 299,
    `缓存命中时年龄没重算：首算 ${first.dataAgeMinutes} 分钟、五小时后仍是 ${later.dataAgeMinutes} 分钟` +
      `⇒ 界面会理直气壮地说"数据是最新的"，而它已经老了两小时（比不报年龄更坏）`,
  )
  assert.ok(
    later.disclosures.some((d) => d.includes('本该又有')),
    `命中时 disclosures 里的年龄那句也没跟着更新：「${later.disclosures.join(' ｜ ').slice(0, 160)}…」`,
  )
  // ★ 说明与实现必须一致（判据 D7）：那句"一模一样"不许再声称覆盖每一个数字。
  const cacheNote = later.disclosures.filter((d) => d.includes('复用了')).join(' ')
  assert.ok(cacheNote.length > 0, '命中必须留下"复用了旧结论"的说明')
  assert.ok(
    cacheNote.includes('年龄'),
    `"复用了旧结论"那句仍在声称每个数字都一样，而年龄每次都重算 —— 注释/说明与实现矛盾（判据 D7）：「${cacheNote}」`,
  )
})

console.log('')
const pass = results.filter((r) => r.pass).length
const fail = results.filter((r) => !r.pass)
console.log(`预测层烟测：${pass} 通过 / ${fail.length} 失败 / 共 ${results.length} 条`)
if (fail.length > 0) {
  console.error('\n失败的断言：')
  for (const f of fail) console.error(`  · ${f.name}\n      ${f.detail}`)
  process.exit(1)
}
console.log('✅ 走势预测：语义不变量全部成立')
