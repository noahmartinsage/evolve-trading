import { loadDotEnv } from '../server/loadEnv.ts'
import { OkxTestnetAdapter } from '../server/venue/okxTestnet.ts'

loadDotEnv()

const a = OkxTestnetAdapter.fromEnv()
if (!a) {
  console.log('NO_OKX_CREDS')
  process.exit(2)
}
try {
  const snap = await a.reconcile()
  console.log('OKX_READONLY_OK cash(USDT)=', snap.cash, 'positions=', snap.positions.length)
  for (const p of snap.positions) console.log('  pos', p.symbol, p.qty, 'avgPx', p.avgPrice)
} catch (e) {
  const cause = (e as { cause?: Error }).cause
  console.log('OKX_READONLY_FAIL', e instanceof Error ? e.message : e, '| cause:', cause ? cause.message : 'none')
  process.exit(1)
}
