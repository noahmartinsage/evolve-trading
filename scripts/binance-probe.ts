import { loadDotEnv } from '../server/loadEnv.ts'
import { CexTestnetAdapter } from '../server/venue/cexTestnet.ts'

loadDotEnv()
const a = CexTestnetAdapter.fromEnv()
if (!a) {
  console.log('NO_BINANCE_CREDS')
  process.exit(2)
}
try {
  const snap = await a.reconcile()
  console.log('BINANCE_READONLY_OK cash(USDT)=', snap.cash, 'positions=', snap.positions.length)
  for (const p of snap.positions) console.log('  pos', p.symbol, p.qty, 'avgPx', p.avgPrice)
} catch (e) {
  const cause = (e as { cause?: Error }).cause
  console.log('BINANCE_READONLY_FAIL', e instanceof Error ? e.message : e, '| cause:', cause ? cause.message : 'none')
  process.exit(1)
}
