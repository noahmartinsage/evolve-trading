import crypto from 'node:crypto'
import { loadDotEnv } from '../server/loadEnv.ts'
loadDotEnv()
const key = process.env.OKX_TESTNET_API_KEY!
const secret = process.env.OKX_TESTNET_API_SECRET!
const pass = process.env.OKX_TESTNET_PASSPHRASE!
const REST = 'https://www.okx.com'
function sign(ts: string, method: string, path: string, body = ''): string { return crypto.createHmac('sha256', secret).update(ts + method.toUpperCase() + path + body).digest('base64') }
async function post(path: string, payload: Record<string, unknown>) {
  const ts = new Date().toISOString(); const body = JSON.stringify(payload); const sig = sign(ts, 'POST', path, body)
  const res = await fetch(REST + path, { method: 'POST', headers: { 'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': sig, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': pass, 'x-simulated-trading': '1', 'content-type': 'application/json' }, body })
  return { status: res.status, body: await res.text() }
}
const base = { instType: 'SPOT', tdMode: 'cash', instId: 'BTC-USDT', side: 'sell', ordType: 'market', sz: '0.001' }
for (const [name, p] of Object.entries({ 'hyphen': {...base, clOrdId:'live-test-0009'}, 'underscore': {...base, clOrdId:'live_test_0010'}, 'no-cloid': {...base} })) {
  const r = await post('/api/v5/trade/order', p); console.log(name, '=>', r.status, r.body.slice(0,140))
}
