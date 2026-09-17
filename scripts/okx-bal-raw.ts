import crypto from 'node:crypto'
import { loadDotEnv } from '../server/loadEnv.ts'

loadDotEnv()
const key = process.env.OKX_TESTNET_API_KEY
const secret = process.env.OKX_TESTNET_API_SECRET
const pass = process.env.OKX_TESTNET_PASSPHRASE
const REST = 'https://www.okx.com'
console.log('key?', !!key, 'secret?', !!secret, 'pass?', !!pass)

function sign(timestamp: string, method: string, path: string, body = ''): string {
  const prehash = timestamp + method.toUpperCase() + path + body
  return crypto.createHmac('sha256', secret!).update(prehash).digest('base64')
}
async function get(path: string) {
  const ts = new Date().toISOString()
  const sig = sign(ts, 'GET', path)
  const res = await fetch(REST + path, {
    headers: {
      'OK-ACCESS-KEY': key!,
      'OK-ACCESS-SIGN': sig,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': pass!,
      'x-simulated-trading': '1',
    },
  })
  return { status: res.status, body: await res.text() }
}
const r1 = await get('/api/v5/account/balance')
const j = JSON.parse(r1.body)
console.log('BALANCE status:', r1.status, 'code:', j.code)
for (const d of j.data?.[0]?.details ?? []) {
  console.log(`  ${d.ccy}: availBal=${d.availBal} eqUsd=${d.eqUsd}`)
}
