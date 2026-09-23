/**
 * 手动跑一次走势预测，把**全部**字段打出来看（不只是念给用户的那一句）。
 *
 * 保留它：这是 `forecastService` 输出的"人眼可读的第二来源" ——
 * 桌宠/面板上看到的那句话是不是从这些数字来的，靠它对。
 *
 * ★ 它**只读**：不落盘、不下单、不改任何状态。预测本身不产生副作用，
 *   要不要下单由既有 `tradeGate` 前置检查决定（判据 8：一条业务动作一条路）。
 *
 * 用法：npm run forecast:run -- [symbol] [horizonBars] [barMinutes]
 *   例：npm run forecast:run -- BTCUSDT 4 15   （未来 1 小时）
 */
import { forecast, forecastHeadline } from '../server/forecastService.ts'

const symbol = process.argv[2] ?? 'BTCUSDT'
const horizonBars = Number(process.argv[3] ?? '4')
const barMinutes = Number(process.argv[4] ?? '15')

const t0 = Date.now()
const r = forecast({ symbol, config: { horizonBars, barMinutes } })
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? 'null' : x.toFixed(d))

console.log('══════ 预测 ══════')
console.log(`标的 ${r.symbol} · 未来 ${r.horizonBars} 根（${((r.horizonBars * r.barMinutes) / 60).toFixed(1)} 小时）`)
console.log(`as of ${new Date(r.asOf).toISOString()} · 现价 ${f(r.spot)} · 数据 ${r.origin} · ${r.elapsedMs}ms`)
console.log(`方法 ${r.method}`)
console.log('')
console.log(`★ 判决 ${r.outcome} / gate=${r.gate}`)
console.log(`  方向 ${r.direction ?? 'null（样本不足时不许给"持平"）'}`)
console.log(`  中位目标 ${f(r.target)} · 中位幅度 ${f(r.medianBps)} bps`)
console.log(`  80% 区间 ${r.interval ? `${f(r.interval.lo)} ~ ${f(r.interval.hi)}` : 'null'}`)
console.log(`  净边际 ${f(r.netEdgeBps)} bps（往返成本 ${r.roundTripCostBps} = 2 × ${r.oneWayCostBps}）`)
console.log('')
console.log('── 走势图（未来逐步分位带）──')
for (const p of r.path) console.log(`  +${p.step}  ${f(p.p10)}  ${f(p.p50)}  ${f(p.p90)}`)
if (r.path.length === 0) console.log('  （空）')
console.log('')
console.log('── 状态向量 ──')
for (const s of r.state) console.log(`  ${s.slug}  IC=${f(s.trainIc, 3)}  ${s.nameCn}`)
console.log('')
console.log('── 样本 ──')
console.log(`  候选 ${r.sample.candidates} 根 · 命中近邻 ${r.sample.matched} · 因重叠跳过 ${r.sample.separated}`)
console.log(`  训练段 ${r.sample.trainBars} / 检验段 ${r.sample.testBars}`)
console.log('')
console.log('── 样本外校准（决定"能不能信"的就是这一段）──')
const c = r.calibration
if (!c) console.log('  null —— 锚点不足，无法校准')
else {
  console.log(`  锚点 ${c.anchors}（其中收益恰好为 0 的 ${c.flatAnchors} 个不进分母）`)
  console.log(`  命中 ${c.hits} ⇒ 命中率 ${(c.hitRate * 100).toFixed(1)}%`)
  console.log(`  ★ 基准规则「${c.baseRule}」命中率 ${(c.baseRate * 100).toFixed(1)}%`)
  console.log(`  逐锚点配对差 z=${f(c.edgeZ)} · p=${f(c.pValue, 4)} · SE ${f(c.se, 4)}`)
  console.log(`  区间覆盖：名义 ${(c.coverageNominal * 100).toFixed(0)}% 实际 ${(c.coverageActual * 100).toFixed(1)}%`)
}
console.log('')
console.log('── 原因（每条都指向一个可核验的观测量）──')
for (const x of r.reasons) console.log(`  [${x.from}] ${x.text}`)
console.log('')
console.log('── 披露（覆盖不到什么）──')
for (const d of r.disclosures) console.log(`  · ${d}`)
console.log('')
console.log('── 念给用户的那一句 ──')
console.log(forecastHeadline(r))
console.log(`\n（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
