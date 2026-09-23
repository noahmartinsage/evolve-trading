/**
 * 因子生产线 CLI —— 手工跑一批因子并把结果落进台账。
 *
 * 刻意**不进 CI**：它会写 `data/factors/index.json`（生产台账）。
 * 门禁里跑它会变成"每跑一次 CI 就改一次台账"，那台账就不再是证据。
 * 烟测用 `--dry-run` 或临时路径（见 `scripts/factor-smoke.ts`）。
 *
 * 用法：
 *   npm run factors:run                      # 产 12 个候选并落盘（同时重判过时行）
 *   npm run factors:run -- --count 40        # 产 40 个
 *   npm run factors:run -- --dry-run         # 只算不落盘
 *   npm run factors:run -- --no-refresh      # 跳过重判，只产新候选
 *   npm run factors:run -- --symbol ETHUSDT  # 换标的
 *
 * ★ 默认会**重判过时行**（指纹与当前行情不符的那些）。理由：老 slug 会被
 *   `generateFactorBatch` 一直跳过，不重判就**永远是过时的** ——
 *   实测过这个后果：5 条 accepted 里 4 条过时 ⇒ 策略层全部判 stale ⇒
 *   "已接受因子接进生产"产出 0 个策略。
 */
import { checkGateReachable, factorIndexSummary, produceFactors } from '../server/factorService.ts'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const count = Number(arg('count', '12'))
const symbol = arg('symbol', 'BTCUSDT') as string
const dryRun = process.argv.includes('--dry-run')
const refreshStale = !process.argv.includes('--no-refresh')

const reach = checkGateReachable(symbol)
console.log(`因子门可达性：${reach.reason}`)

const r = produceFactors({ count, symbol, dryRun, refreshStale })

console.log('')
console.log(`数据来源 ${r.origin} · ${r.bars} 根 · 指纹 ${r.dataHash}`)
console.log(
  `候选 ${r.specs}` +
    (r.refreshed > 0 ? `（其中重判过时行 ${r.refreshed} 条）` : '') +
    ` · 通过 ${r.accepted} · 拒绝 ${r.rejected} · 证据不足 ${r.unverifiable}`,
)
if (r.staleInIndex > r.refreshed) {
  console.log(`⚠️ 台账里还有 ${r.staleInIndex - r.refreshed} 条过时行没有重判（本轮已跳过重判？）`)
}
console.log(`按闸门分布 ${JSON.stringify(r.byGate)}`)
console.log('')
console.log('slug'.padEnd(26) + 'state'.padEnd(15) + 'IC'.padStart(9) + 'ICIR'.padStart(8) + '覆盖'.padStart(8) + '换手'.padStart(8) + '  判定')
for (const row of r.rows) {
  const f = (v: number | null, d = 4) => (v === null ? 'n/a' : v.toFixed(d))
  console.log(
    row.slug.padEnd(26) +
      row.state.padEnd(15) +
      f(row.icMean5).padStart(9) +
      f(row.icir, 3).padStart(8) +
      `${(row.coverage * 100).toFixed(0)}%`.padStart(8) +
      `${row.turnover === null ? 'n/a' : (row.turnover * 100).toFixed(0) + '%'}`.padStart(8) +
      `  ${row.reason}`,
  )
}

const s = factorIndexSummary()
console.log('')
console.log(`台账：${s.reason}${s.available ? ` · 通过 ${s.accepted} / 不可验证 ${s.unverifiable}` : ''}`)
console.log(dryRun ? '（dry-run：未落盘）' : `已落盘 ${r.indexPath}`)
