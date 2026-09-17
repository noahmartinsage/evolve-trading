import crypto from 'node:crypto'
import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'

const DEFAULT_REST = 'https://testnet.binance.vision'

export class CexTestnetAdapter implements VenueAdapter {
  readonly name = 'cex-testnet'
  private apiKey: string
  private apiSecret: string
  private rest: string
  private fillListeners: ((f: VenueFill) => void)[] = []
  private lastTradeIdBySymbol = new Map<string, number>()
  private watchedSymbols = new Set<string>()
  private executedFills = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null

  static fromEnv(): CexTestnetAdapter | null {
    const key = process.env.BINANCE_TESTNET_API_KEY
    const secret = process.env.BINANCE_TESTNET_API_SECRET
    if (!key || !secret) return null
    return new CexTestnetAdapter(key, secret, process.env.BINANCE_TESTNET_REST ?? DEFAULT_REST)
  }

  constructor(apiKey: string, apiSecret: string, rest: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.rest = rest.replace(/\/+$/, '')
  }

  watchSymbol(symbol: string): void {
    this.watchedSymbols.add(symbol)
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollMyTrades()
      }, 10_000)
    }
  }

  private sign(query: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex')
  }

  private async signedRequest<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<T> {
    const q = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(Date.now()),
      recvWindow: '5000',
    })
    q.append('signature', this.sign(q.toString()))
    const hasBody = method === 'POST'
    const res = await fetch(`${this.rest}${path}${hasBody ? '' : `?${q.toString()}`}`, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(hasBody ? { body: q.toString() } : {}),
    })
    if (!res.ok) throw new Error(`CEX_TESTNET_HTTP_${res.status}: ${(await res.text()).slice(0, 120)}`)
    return (await res.json()) as T
  }

  async place(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    const params: Record<string, string | number> = {
      symbol: intent.symbol,
      side: intent.side.toUpperCase(),
      type: intent.type === 'market' ? 'MARKET' : 'LIMIT',
      quantity: intent.qty,
      newClientOrderId: intent.clientOrderId.slice(0, 36),
    }
    if (intent.type === 'limit') {
      params.price = intent.price as number
      params.timeInForce = 'GTC'
    }
    const res = await this.signedRequest<{ orderId: number; clientOrderId: string }>('POST', '/api/v3/order', params)
    this.watchSymbol(intent.symbol)
    return { venueOrderId: `C${res.orderId}` }
  }

  async cancel(venueOrderId: string): Promise<boolean> {
    const m = /^C(\d+)@(.+)$/.exec(venueOrderId)
    if (!m) return false
    try {
      await this.signedRequest('DELETE', '/api/v3/order', { symbol: m[2], orderId: Number(m[1]) })
      return true
    } catch {
      return false
    }
  }

  onFill(cb: (f: VenueFill) => void): void {
    this.fillListeners.push(cb)
  }

  async openOrderIds(): Promise<string[]> {
    try {
      const orders = await this.signedRequest<{ orderId: number; symbol: string }[]>('GET', '/api/v3/openOrders', {})
      return orders.map((o) => `C${o.orderId}@${o.symbol}`)
    } catch {
      return []
    }
  }

  async reconcile(): Promise<BalanceSnapshot> {
    const acct = await this.signedRequest<{ balances: { asset: string; free: string; locked: string }[] }>('GET', '/api/v3/account', {})
    let cash = 0
    const positions: BalanceSnapshot['positions'] = []
    for (const b of acct.balances) {
      const total = parseFloat(b.free) + parseFloat(b.locked)
      if (total <= 0) continue
      if (b.asset === 'USDT') cash = total
      else positions.push({ symbol: b.asset, qty: Math.round(total * 1e8) / 1e8, avgPrice: Number.NaN })
    }
    return { cash, positions, totalFills: this.executedFills }
  }

  async pollMyTrades(): Promise<void> {
    for (const symbol of this.watchedSymbols) {
      try {
        const trades = await this.signedRequest<{ id: number; orderId: number; price: string; qty: string; isBuyer: boolean; time: number }[]>('GET', '/api/v3/myTrades', { symbol })
        for (const t of trades) {
          const last = this.lastTradeIdBySymbol.get(symbol) ?? 0
          if (t.id <= last) continue
          this.lastTradeIdBySymbol.set(symbol, t.id)
          this.executedFills += 1
          const fill: VenueFill = {
            fillId: `T${t.id}`,
            venueOrderId: `C${t.orderId}`,
            clientOrderId: '',
            symbol,
            side: t.isBuyer ? 'buy' : 'sell',
            price: parseFloat(t.price),
            qty: parseFloat(t.qty),
            ts: t.time,
          }
          for (const cb of this.fillListeners) cb(fill)
        }
      } catch {
        /* 轮询失败静默重试 */
      }
    }
  }
}
