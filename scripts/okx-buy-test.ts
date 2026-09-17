import { loadDotEnv } from '../server/loadEnv.ts'
import { OkxTestnetAdapter } from '../server/venue/okxTestnet.ts'

loadDotEnv()
const a = OkxTestnetAdapter.fromEnv()
if (!a) {
  console.error('no okx creds')
  process.exit(1)
}

async function raw(qty: string, tgtCcy?: string) {
  const payload: any = { instType: 'SPOT', tdMode: 'cash', instId: 'BTC-USDT', side: 'buy', ordType: 'market', sz: qty, clOrdId: `raw${Date.now().toString(36)}` }
  if (tgtCcy) payload.tgtCcy = tgtCcy
  try {
    const r = await (a as any).signed('POST', '/api/v5/trade/order', payload)
    console.log(`RAW BUY qty=${qty}${tgtCcy ? ' tgtCcy=' + tgtCcy : ''} -> FULL ${JSON.stringify(r)}`)
  } catch (e) {
    const err = e as Error
    console.log(`RAW BUY qty=${qty}${tgtCcy ? ' tgtCcy=' + tgtCcy : ''} -> ERR ${err.message}`)
  }
}

async function limitBuy(qty: string, px: string) {
  const payload: any = { instType: 'SPOT', tdMode: 'cash', instId: 'BTC-USDT', side: 'buy', ordType: 'limit', sz: qty, px, clOrdId: `lim${Date.now().toString(36)}` }
  try {
    const r = await (a as any).signed('POST', '/api/v5/trade/order', payload)
    console.log(`LIMIT BUY qty=${qty} px=${px} -> FULL ${JSON.stringify(r)}`)
  } catch (e) {
    const err = e as Error
    console.log(`LIMIT BUY qty=${qty} px=${px} -> ERR ${err.message}`)
  }
}

await raw('0.00129')
await raw('0.005')
await raw('0.01')
await raw('0.02')
await raw('0.03')
await limitBuy('0.001', '60000')
await limitBuy('0.002', '50000')

const snap = await a.reconcile()
console.log('VENUE SNAPSHOT:', JSON.stringify(snap, null, 2))
const rawBal = await (a as any).signed('GET', '/api/v5/account/balance', {})
console.log('RAW BALANCE:', JSON.stringify(rawBal, null, 2))
console.log('done')
