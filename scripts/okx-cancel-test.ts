import { loadDotEnv } from '../server/loadEnv.ts'
import { OkxTestnetAdapter } from '../server/venue/okxTestnet.ts'

loadDotEnv()
const a = OkxTestnetAdapter.fromEnv()!
const r = await a.cancel('OKX-3877197841149005824@BTC-USDT')
console.log('cancel ok=', r)
const bal = await a.reconcile()
console.log('USDT availBal=', bal.cash)
console.log('done')
