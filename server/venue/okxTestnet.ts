import crypto from 'node:crypto'
import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'
import {
  contractsFromBaseQty,
  toSwapInstId,
  type SwapInstrumentSpec,
  type SwapSettlement,
} from './okxSwapSpec.ts'

/**
 * 报价精度：OKX 现货报价按 0.1 处理即可满足模拟盘成交；
 * 合约（尤其 inverse）tickSz 通常更细，统一保留 2 位小数——
 * 报价被"四舍五入到远离盘口"是限价单不成交的常见原因。
 */
function roundQuote(px: number, settle: SwapSettlement): number {
  const digits = settle === 'inverse' ? 2 : 2
  const f = 10 ** digits
  return Math.round(px * f) / f
}

/** 受限网络（如 OKX 被 geo-block）下通过 HTTP/HTTPS 代理出海。仅当设置了 HTTPS_PROXY/HTTP_PROXY 时启用；不影响模拟盘本质。 */
let proxyConfigured = false
async function ensureProxy(): Promise<void> {
  if (proxyConfigured) return
  proxyConfigured = true
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (!proxy) return
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(proxy))
    console.log(`[OK] OKX adapter 使用代理出海 (${proxy.replace(/\/\/.*@/, '//***@')})`)
  } catch {
    console.warn('⚠️ 设置了代理但 undici 不可用，忽略（直连）')
  }
}

/**
 * OKX 测试网（模拟盘）适配器。
 *
 * 安全约束（硬编码，不可通过配置绕过）：
 *  - 仅连接 https://www.okx.com 且始终携带 x-simulated-trading: 1 —— 即 OKX 模拟交易环境，
 *    任何订单均为零真实资金的模拟单，不存在主网通路。
 *  - 凭证仅从环境变量读取，绝不写入日志 / 落库明文。
 *  - 凭证缺失时 fromEnv() 返回 null，编排层保持 gateway 未挂载（fail-closed）。
 */
const OKX_BASE = 'https://www.okx.com'

function toInstId(symbol: string): string {
  if (symbol.includes('-')) return symbol.toUpperCase()
  return symbol.replace(/(USDT|USDC|USD|T)$/, '-$1').toUpperCase()
}

function toSymbol(instId: string): string {
  return instId.replace('-', '').toUpperCase()
}

function sanitizeClOrdId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
  return cleaned.length > 0 ? cleaned : `E${crypto.randomBytes(6).toString('hex')}`
}

export class OkxTestnetAdapter implements VenueAdapter {
  readonly name = 'okx-testnet'
  private apiKey: string
  private apiSecret: string
  private passphrase: string
  private fillListeners: ((f: VenueFill) => void)[] = []
  private lastTradeIdByInst = new Map<string, string>()
  private watchedInst = new Set<string>()
  private executedFills = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null

  static fromEnv(): OkxTestnetAdapter | null {
    const key = process.env.OKX_TESTNET_API_KEY
    const secret = process.env.OKX_TESTNET_API_SECRET
    const pass = process.env.OKX_TESTNET_PASSPHRASE
    if (!key || !secret || !pass) return null
    return new OkxTestnetAdapter(key, secret, pass)
  }

  constructor(apiKey: string, apiSecret: string, passphrase: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.passphrase = passphrase
  }

  watchSymbol(symbol: string): void {
    const inst = toInstId(symbol)
    this.watchedInst.add(inst)
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollFills()
      }, 10_000)
    }
  }

  private async signed<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}): Promise<T> {
    await ensureProxy()
    const ts = new Date().toISOString()
    let qs = ''
    let body = ''
    if (method === 'GET' && Object.keys(params).length > 0) {
      qs = '?' + new URLSearchParams(params as Record<string, string>).toString()
    } else if (method === 'POST') {
      body = JSON.stringify(params)
    }
    const preHash = ts + method + path + qs + body
    const sign = crypto.createHmac('sha256', this.apiSecret).update(preHash).digest('base64')
    const res = await fetch(`${OKX_BASE}${path}${qs}`, {
      method,
      headers: {
        'OK-ACCESS-KEY': this.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
        'x-simulated-trading': '1',
        'content-type': 'application/json',
      },
      ...(body ? { body } : {}),
    })
    const json = (await res.json().catch(() => ({}))) as { code?: string; msg?: string; data?: unknown[] }
    if (json.code !== '0' || !res.ok) {
      const detail = json.data && json.data.length ? JSON.stringify(json.data[0]) : ''
      throw new Error(`OKX_HTTP_${res.status}: ${json.msg ?? 'unknown'} (${json.code ?? '?'})${detail ? ' · ' + detail : ''}`)
    }
    return json as T
  }

  async place(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    if (intent.instType === 'SWAP') return this.placeSwap(intent)

    const instId = toInstId(intent.symbol)
    const leverage = Number.isFinite(intent.leverage) && (intent.leverage ?? 1) > 1 ? (intent.leverage as number) : 1
    const marginMode = leverage > 1 ? 'cross' : 'cash'
    const payload: Record<string, unknown> = {
      instType: 'SPOT',
      tdMode: marginMode,
      instId,
      side: intent.side,
      ordType: intent.type === 'market' ? 'limit' : 'limit',
      sz: String(intent.qty),
      clOrdId: sanitizeClOrdId(intent.clientOrderId),
    }
    // 以小博大：全仓保证金下 OKX 自动以现有持仓（如 BTC）为抵押物借币成交
    if (leverage > 1) {
      payload.lever = String(leverage)
      // 保证金买入借报价币（USDT），卖出借基础币（BTC），否则 OKX 报 50014
      const [baseCcy, quoteCcy] = instId.split('-')
      payload.ccy = intent.side === 'buy' ? quoteCcy : baseCcy
    }
    if (intent.type === 'limit' && intent.price !== undefined) {
      payload.px = String(intent.price)
    } else if (intent.type === 'market') {
      // OKX 模拟盘对市价单的买入支持不稳定（sCode 51020），改为以当前盘口限价单成交
      const tp = await this.lastPrice(instId)
      const px = intent.side === 'buy' ? tp * 1.001 : tp * 0.999
      payload.px = String(Math.round(px * 10) / 10)
    }
    const res = await this.signed<{ code: string; msg: string; data: { ordId: string }[] }>('POST', '/api/v5/trade/order', payload)
    this.watchSymbol(intent.symbol)
    return { venueOrderId: `OKX-${res.data[0].ordId}@${instId}` }
  }

  /**
   * 永续合约下单（U 本位 / 币本位）。
   *
   * 与现货路径的三个关键差异，每一个都会导致"下单成功但规模完全不对"：
   *   ① `sz` 的单位是**张**，不是币量 ⇒ 必须经 `contractsFromBaseQty` 换算（见 okxSwapSpec.ts）；
   *   ② `tdMode` 必须显式给 `cross`（逐仓/全仓），合约没有 `cash` 模式；
   *   ③ inventory 里必须带 `lever`，否则场所按默认杠杆（通常 3x）下单，
   *      而我们按 125x 算的保证金根本不够 —— 场所会用"保证金不足"拒单，
   *      排查方向极易被引到"余额不够"而不是"杠杆没传进去"。
   */
  private async placeSwap(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    const settle = intent.settle ?? 'linear'
    const instId = toSwapInstId(intent.symbol, settle)
    const spec = await this.swapSpec(instId, settle)

    const refPrice =
      intent.price !== undefined && intent.price > 0
        ? intent.price
        : await this.lastPrice(instId)
    if (!(refPrice > 0)) throw new Error(`SWAP_PRICE_UNAVAILABLE:${instId}`)

    const contracts = contractsFromBaseQty(intent.qty, spec, refPrice)
    if (contracts <= 0) {
      // 不静默抬到最小可下量：抬起规模等于风控失效。让上游显式决定是否放大。
      throw new Error(
        `SWAP_QTY_BELOW_MIN:${instId} 计划 ${intent.qty} 基础币 → 不足最小下单量 ${spec.minSz} 张（1 张 = ${spec.ctVal} ${spec.ctValCcy}）`,
      )
    }

    const leverage = Number.isFinite(intent.leverage) && (intent.leverage ?? 1) > 0 ? (intent.leverage as number) : 1
    const payload: Record<string, unknown> = {
      instType: 'SWAP',
      tdMode: 'cross',
      instId,
      side: intent.side,
      ordType: 'limit',
      sz: String(contracts),
      lever: String(leverage),
      clOrdId: sanitizeClOrdId(intent.clientOrderId),
    }
    // 模拟盘市价单不稳定，统一以盘口限价成交（与现货路径同一处置）
    const px = intent.type === 'limit' && intent.price !== undefined ? intent.price : intent.side === 'buy' ? refPrice * 1.001 : refPrice * 0.999
    payload.px = String(roundQuote(px, settle))

    const res = await this.signed<{ code: string; msg: string; data: { ordId: string }[] }>('POST', '/api/v5/trade/order', payload)
    if (res.data[0] && !res.data[0].ordId) {
      throw new Error(`SWAP_ORDER_NO_ORDID:${instId}`)
    }
    this.watchSymbol(intent.symbol)
    return { venueOrderId: `OKX-${res.data[0].ordId}@${instId}` }
  }

  /** 合约规格缓存：ctVal/lotSz 是场所侧事实，短期不变，逐单查询会浪费配额并放大延迟。 */
  private swapSpecs = new Map<string, SwapInstrumentSpec>()

  private async swapSpec(instId: string, settle: 'linear' | 'inverse'): Promise<SwapInstrumentSpec> {
    const hit = this.swapSpecs.get(instId)
    if (hit) return hit
    const r = await this.signed<{
      code: string
      data: { instId: string; ctVal: string; ctValCcy: string; lotSz: string; minSz: string }[]
    }>('GET', '/api/v5/public/instruments', { instType: 'SWAP', instId })
    const d = r.data[0]
    if (!d) throw new Error(`SWAP_SPEC_NOT_FOUND:${instId}`)
    const spec: SwapInstrumentSpec = {
      instId: d.instId,
      ctVal: parseFloat(d.ctVal),
      ctValCcy: d.ctValCcy,
      lotSz: parseFloat(d.lotSz),
      minSz: parseFloat(d.minSz),
      settle,
    }
    if (!(spec.ctVal > 0) || !(spec.lotSz > 0)) {
      throw new Error(`SWAP_SPEC_INVALID:${instId} ctVal=${d.ctVal} lotSz=${d.lotSz}`)
    }
    this.swapSpecs.set(instId, spec)
    return spec
  }

  private async lastPrice(instId: string): Promise<number> {
    const r = await this.signed<{ code: string; msg: string; data: { last: string }[] }>('GET', '/api/v5/market/ticker', { instId })
    return parseFloat(r.data[0]?.last ?? '0')
  }

  async cancel(venueOrderId: string): Promise<boolean> {
    const m = /^OKX-(.+?)@(.+)$/.exec(venueOrderId)
    if (!m) return false
    try {
      await this.signed('POST', '/api/v5/trade/cancel-order', { instId: m[2], ordId: m[1] })
      return true
    } catch {
      return false
    }
  }

  onFill(cb: (f: VenueFill) => void): void {
    this.fillListeners.push(cb)
  }

  async openOrderIds(): Promise<string[]> {
    const out: string[] = []
    for (const instType of ['SPOT', 'SWAP'] as const) {
      try {
        const res = await this.signed<{ code: string; data: { ordId: string; instId: string }[] }>(
          'GET',
          '/api/v5/trade/orders-pending',
          { instType },
        )
        out.push(...res.data.map((o) => `OKX-${o.ordId}@${o.instId}`))
      } catch {
        /* 单一品种类型查询失败不影响另一类；返回已取到的部分而不是整体抛错 */
      }
    }
    return out
  }

  async reconcile(): Promise<BalanceSnapshot> {
    const bal = await this.signed<{
      code: string
      data: { details: { ccy: string; availBal: string; accAvgPx: string; eqUsd: string; liab?: string }[] }[]
    }>('GET', '/api/v5/account/balance', {})
    let cash = 0
    const positions: BalanceSnapshot['positions'] = []
    for (const d of bal.data[0]?.details ?? []) {
      const ccy = d.ccy
      const avail = parseFloat(d.availBal)
      if (ccy === 'USDT' || ccy === 'USDC') {
        // 减去保证金借币负债（liab），否则杠杆会虚增权益
        const liab = parseFloat(d.liab ?? '0') || 0
        cash += avail - liab
        continue
      }
      if (Math.abs(avail) > 1e-12) {
        positions.push({ symbol: `${ccy}USDT`, qty: avail, avgPrice: d.accAvgPx ? parseFloat(d.accAvgPx) : Number.NaN })
      }
    }
    return { cash, positions, totalFills: this.executedFills }
  }

  async pollFills(): Promise<void> {
    for (const instId of this.watchedInst) {
      try {
        const res = await this.signed<{ code: string; data: { tradeId: string; ordId: string; side: string; fillPx: string; fillSz: string; ts: string }[] }>(
          'GET',
          '/api/v5/trade/fills',
          { instType: 'SPOT', instId, limit: '100' },
        )
        for (const t of res.data) {
          const last = this.lastTradeIdByInst.get(instId) ?? '0'
          if (t.tradeId <= last) continue
          this.lastTradeIdByInst.set(instId, t.tradeId)
          this.executedFills += 1
          const fill: VenueFill = {
            fillId: `O${t.tradeId}`,
            venueOrderId: `OKX-${t.ordId}@${instId}`,
            clientOrderId: '',
            symbol: toSymbol(instId),
            side: t.side === 'buy' ? 'buy' : 'sell',
            price: parseFloat(t.fillPx),
            qty: parseFloat(t.fillSz),
            ts: Number(t.ts),
          }
          for (const cb of this.fillListeners) cb(fill)
        }
      } catch {
        /* 轮询失败静默重试 */
      }
    }
  }
}
