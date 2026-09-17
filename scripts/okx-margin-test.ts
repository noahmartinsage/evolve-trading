import { loadDotEnv } from '../server/loadEnv.ts'
import { OkxTestnetAdapter } from '../server/venue/okxTestnet.ts'

loadDotEnv()
const a = OkxTestnetAdapter.fromEnv()
if (!a) {
  console.error('no okx creds')
  process.exit(1)
}

async function marginBuy(qty: string, lev: number, px: string) {
  const payload: any = {
    instType: 'SPOT',
    tdMode: 'cross',
    instId: 'BTC-USDT',
    side: 'buy',
    ordType: 'limit',
    sz: qty,
    px,
    lever: String(lev),
    ccy: 'USDT',
    clOrdId: `mg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  }
  try {
    const r = await (a as any).signed('POST', '/api/v5/trade/order', payload)
    console.log(`MARGIN BUY qty=${qty} lev=${lev} px=${px} -> OK ${JSON.stringify(r.data)}`)
  } catch (e) {
    const err = e as Error
    console.log(`MARGIN BUY qty=${qty} lev=${lev} px=${px} -> ERR ${err.message}`)
  }
}

async function rawBal() {
  const r = await (a as any).signed('GET', '/api/v5/account/balance', {})
  console.log('RAW BALANCE:', JSON.stringify(r.data?.[0]?.details?.slice(0, 6)))
}

async function enableCollateral(ccy: string) {
  try {
    const r = await (a as any).signed('POST', '/api/v5/account/set-collateral-asset', { ccy, collateralEnabled: true })
    console.log(`SET COLLATERAL ${ccy} -> ${JSON.stringify(r.data)}`)
  } catch (e) {
    console.log(`SET COLLATERAL ${ccy} ERR ${(e as Error).message}`)
  }
}

async function setLever(instId: string, lev: number) {
  try {
    const r = await (a as any).signed('POST', '/api/v5/account/set-leverage', { instId, lever: String(lev), mgnMode: 'cross' })
    console.log(`SET LEVER ${instId} ${lev}x cross -> ${JSON.stringify(r.data)}`)
  } catch (e) {
    console.log(`SET LEVER ERR ${(e as Error).message}`)
  }
}

const tp = await (a as any).signed('GET', '/api/v5/market/ticker', { instId: 'BTC-USDT' })
const last = parseFloat(tp.data[0].last)
console.log('last=', last)
await enableCollateral('BTC')
await enableCollateral('ETH')
await enableCollateral('OKB')
await setLever('BTC-USDT', 3)
// 复现 autopilot 实盘买单：cross + lever 3 + ccy USDT + px=tp*1.001
await marginBuy('0.64', 3, String(Math.round(last * 1.001 * 10) / 10))
await rawBal()
console.log('done')
