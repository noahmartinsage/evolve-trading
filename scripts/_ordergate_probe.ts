// 探针：验证 orderGate 的唯一入口在真实依赖下能跑，并给出可断言的稳定不变量。
import { gateOrderForExecution } from '../server/orderGate.ts'
import { initLedger } from '../server/ledger.ts'
import { initPersistence } from '../server/persistence.ts'

process.env.ORCH_DB = `data/_ordergate-probe-${process.pid}.db`
initPersistence()
initLedger()

const cases = [
  { name: '缺保护（开仓）', req: { symbol: 'BTCUSDT', side: 'buy' as const, notionalUsdt: 10, entry: 80000, takeProfit: 0, stopLoss: 0, environment: 'paper' as const } },
  { name: '全给（开仓）', req: { symbol: 'BTCUSDT', side: 'buy' as const, notionalUsdt: 10, entry: 80000, takeProfit: 88000, stopLoss: 79000, environment: 'paper' as const } },
  { name: 'notional=0', req: { symbol: 'BTCUSDT', side: 'buy' as const, notionalUsdt: 0, entry: 80000, takeProfit: 88000, stopLoss: 79000, environment: 'paper' as const } },
]

for (const c of cases) {
  const r = await gateOrderForExecution(c.req, { source: 'orders' })
  console.log(
    `[${c.name}] verdict=${r.verdict} submit=${r.submitAllowed} pipeline=${r.pipeline.checked}/${r.pipeline.total} ` +
      `blockers=${r.blockers.map((b) => b.id).join(',')} sugg=${r.suggested ? 'yes' : 'no'}`,
  )
  console.log(`    summary=${r.summary.slice(0, 120)}`)
}
console.log('PROBE_OK')
process.exit(0)
