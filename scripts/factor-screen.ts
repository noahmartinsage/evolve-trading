/**
 * 策略层筛查 CLI —— 把「台账里 state=accepted 的因子」送进策略门，并把结论落盘。
 *
 * ══ 它补的是一个**没有生产入口的生产步骤** ═════════════════════════════
 * `screenAcceptedFactors()` 写出来之后，唯一的调用者是取证脚本 `_probe46.ts`。
 * 也就是说「已接受因子接进策略生产」这条链在生产上**跑不起来**：
 *   · 因子层有 CLI（`npm run factors:run`）
 *   · 消费侧有接线（`proposalEngine` / `autopilot` 调 `buildAcceptedFactorStrategies`）
 *   · 中间那道筛查**只有探针能触发** ⇒ `data/factors/strategies.json` 永远不存在
 * ⇒ `buildAcceptedFactorStrategies` 每轮读到一个空台账，静默产出 0 个策略。
 * 这不是"少个脚本"，是把一个业务动作的实现路径留在了测试里。
 *
 * ══ 为什么不进 CI ═════════════════════════════════════════════════════
 * 与 `factors:run` 同理：它会写 `data/factors/strategies.json`（生产台账）。
 * 门禁里跑它 = 每跑一次 CI 就改一次台账，台账就不再是证据。
 * 烟测走 `--dry-run` 或临时路径。
 *
 * 用法：
 *   npm run factors:screen                    # 筛查全部 accepted 因子并落盘
 *   npm run factors:screen -- --symbol ETHUSDT
 *   npm run factors:screen -- --limit 5       # 只筛前 5 个（按 slug 排序）
 *   npm run factors:screen -- --dry-run       # 只算不落盘
 */
import { defaultIndexPath, readFactorIndex } from '../server/factorService.ts'
import {
  factorStrategySummary,
  screenAcceptedFactors,
} from '../server/factorStrategyService.ts'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const symbol = arg('symbol', 'BTCUSDT') as string
const dryRun = process.argv.includes('--dry-run')
const rawLimit = arg('limit')
const limit = rawLimit === undefined ? undefined : Number(rawLimit)

// 先回答"有没有东西可筛"。空批次值得单独说一句 —— 否则脚本会以
// "筛查 0 个、通过 0 个"正常退出，看起来像跑过了而实际什么都没做。
const { index: factorIndex, damaged } = readFactorIndex(defaultIndexPath())
const accepted = factorIndex.rows.filter((r) => r.state === 'accepted')
console.log(`因子台账 ${factorIndex.rows.length} 条，其中 accepted ${accepted.length} 条` + (damaged ? `（台账损坏：${damaged}）` : ''))
if (accepted.length === 0) {
  console.log('没有 accepted 因子可筛 —— 先跑 npm run factors:run 产一批。脚本到此结束，不落盘。')
  process.exit(0)
}

const t0 = Date.now()
const r = screenAcceptedFactors({ symbol, dryRun, limit })
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log('')
console.log(`数据来源 ${r.origin} · ${r.bars} 根 · 指纹 ${r.dataHash.slice(0, 12)}… · 耗时 ${secs}s`)
console.log(
  `候选 ${r.candidates}` +
    (r.stale > 0 ? `（其中 ${r.stale} 条因指纹过时被直接判过时，未重算）` : '') +
    ` · 通过 ${r.accepted} · 拒绝 ${r.rejected} · 不可验证 ${r.unverifiable}`,
)
console.log(`按闸门分布 ${JSON.stringify(r.byGate)}`)
console.log('')
console.log(
  'slug'.padEnd(30) +
    '方向'.padEnd(6) +
    '结论'.padEnd(15) +
    '训练IC'.padStart(9) +
    '毛最差折'.padStart(10) +
    '净最差折'.padStart(10) +
    '成本拖累'.padStart(10) +
    '胜率'.padStart(8) +
    '笔数'.padStart(7) +
    '  判定',
)
/**
 * ★ 单位是两套，务必分清（本项目已经踩过一次）：
 *   `trainIc` 是**原值**；`winRate` 是**分数**（0..1，判定器里写的是 `winRate * 100`）；
 *   `worstFoldReturnPct` 是**百分数**（字段名里就有 `Pct`）。
 * 一开始照抄 `toFixed(1) + '%'` 打印 winRate，得到的 "0.3%" 看着完全像一个正常数字，
 * 实际是 27%。⇒ 单位写进函数名，别写进注释。
 */
const pct01 = (v: number | null, d = 1) => (v === null ? 'n/a' : (v * 100).toFixed(d) + '%')
const pctRaw = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d) + '%')
for (const row of r.rows) {
  const dir = row.sign === 1 ? '正向' : row.sign === -1 ? '反向' : 'n/a'
  console.log(
    row.slug.padEnd(30) +
      dir.padEnd(6) +
      `${row.state}${row.dataHashMatch ? '' : '(过时)'}`.padEnd(15) +
      (row.trainIc === null ? 'n/a' : row.trainIc.toFixed(4)).padStart(9) +
      pctRaw(row.worstFoldGrossReturnPct).padStart(10) +
      pctRaw(row.worstFoldReturnPct).padStart(10) +
      pctRaw(row.costDragPct).padStart(10) +
      pct01(row.winRate).padStart(8) +
      String(row.closedTrades).padStart(7) +
      `  ${row.reason}`,
  )
}

const s = factorStrategySummary()
console.log('')
// ── 归因小结 ────────────────────────────────────────────────────────────
// 这一行是整条产线最该被读到的一行：它把"该回去找信号"和"该回去降换手"
// 分开。没有它，两种截然不同的局面在输出里长得一模一样。
const rm = r.rows.filter((x) => x.gate === 'return' && x.worstFoldGrossReturnPct !== null)
const costDriven = rm.filter((x) => (x.worstFoldGrossReturnPct as number) > 0)
const signalDriven = rm.filter((x) => (x.worstFoldGrossReturnPct as number) <= 0)
if (rm.length > 0) {
  console.log(
    `被 return 门拒的 ${rm.length} 条里：${costDriven.length} 条**毛收益为正**（信号有方向、被成本吃掉 ⇒ 该降换手），` +
      `${signalDriven.length} 条毛收益也为负（方向不成立 ⇒ 该换因子）`,
  )
  if (costDriven.length > 0) {
    const drags = costDriven.map((x) => x.costDragPct ?? 0).sort((a, b) => a - b)
    console.log(`其中成本拖累中位数 ${drags[Math.floor(drags.length / 2)].toFixed(1)}%`)
  }
}
console.log(`策略台账：${s.reason}`)
console.log(dryRun ? '（dry-run：未落盘）' : `已落盘 ${r.strategyIndexPath}`)
