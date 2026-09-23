import crypto from 'node:crypto'
import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'

const DEFAULT_REST = 'https://testnet.binance.vision'

export class CexTestnetAdapter implements VenueAdapter {
  readonly name = 'cex-testnet'
  /**
   * ★★ `false` —— 而且这是一个**结论**，不是"还没做"。
   *
   * ── 为什么不能报 true ────────────────────────────────────────────────
   * 币安现货确实能挂止损/止盈单（`STOP_LOSS_LIMIT` / `TAKE_PROFIT_LIMIT`，
   * 或 `orderList/oco`），但它们都只能**针对已经存在的持仓**下，
   * 没有任何一个接口能把它们**随开仓单一起**提交。
   * 于是"先开仓、再挂保护"之间必然有一段真实的裸窗：两次网络往返 +
   * 两次撮合。那一段里仓位是活的、保护是没有的，而本地账本与场所账本
   * **两边都看起来正常** —— 这正是本项目最忌讳的形态
   * （见 `VenueProtection` 那段注释）。
   *
   * ★ 另一个方向（报 `true` 然后在有窗口的前提下凑合）的代价是不可观测的：
   *   一切都"成功"了，只是有一段时间没有保护。而报 `false` 的代价是**明确拒单**，
   *   用户当场知道"这条路不支持带保护的实盘开仓"，可以换场所（OKX）或用纸面。
   *   两个方向的代价不对称，所以选后者。
   *
   * ★ 将来若接入币安合约（U 本位），`STOP_MARKET` + `closePosition=true`
   *   仍然是**另一张单**，同样有窗口；那时正确的改法是把合约路径做成
   *   一次批量下单（`/fapi/v1/batchOrders`，同一请求里受理主单与条件单），
   *   改完再把这里改成 `true`。
   */
  readonly supportsVenueProtection = false
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
    // ★ 硬停：能力位说 `false`，上游就不该把保护交过来。真交来了说明
    //   有人绕过了那个判断（或把能力位改错了）—— 那种情况下**静默丢掉保护**
    //   比拒单危险得多，所以这里直接抛，让它变成一条一眼能看到的错误。
    if (intent.protection !== undefined) {
      throw new Error(
        'CEX_PROTECTION_UNSUPPORTED: 币安现货没有"随开仓单原子附挂止盈止损"的接口，' +
          '另下条件单会留一段无保护的真实窗口',
      )
    }
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

  /**
   * 权限自检的**原始材料**：`/api/v3/account` 的**原样返回**。
   *
   * ★★ 为什么这个方法是必需的（2026-09-22 接进来时发现的缺口）──────────────
   * `server/keyScope.ts` 的 `classifyKeyScope()` 早在 2026-09-16 就写好了，
   * 判定逻辑完整、三态清楚、P0/P1 分级也对 —— 但它**只有脚本调用**（`key-scope-audit` /
   * `keyscope-smoke`），**没有任何生产入口**。于是：
   *   · 它算出的 `danger`（密钥带提币权限）永远不会在任何一次真下单前被问一遍；
   *   · 唯一会看的时机是操作员**主动**跑 `npm run keys:audit`。
   * 而这条判定恰恰是"所有金额型闸门还算不算数"的前提（能提币的 key 面前，
   * 1R/资金帽/宪法红线都只是"系统自己愿意遵守"）—— **它是闸门的闸门**。
   * ⇒ 判据 C1：**有语义 ≠ 有人读**。这里补的就是那个"生产入口"。
   *
   * ★ 刻意返回**原始 JSON 而不是结论**：`classifyKeyScope(venue, raw)` 的入参里
   *   不许有结论字段（一旦有，伪造它就能把"不过"变成"通过"）。
   *   所以适配器只负责"取到场所说了什么"，判定留给纯函数。
   */
  async fetchAccountRaw(): Promise<unknown> {
    return this.signedRequest<Record<string, unknown>>('GET', '/api/v3/account', {})
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
