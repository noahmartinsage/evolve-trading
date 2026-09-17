import type { Candle, ExecConfig, Fill, Order, OrderSide, OrderType } from './types.ts'

export class MatchingEngine {
  private seq = 0
  private cfg: ExecConfig
  private symbol: string
  readonly orders: Order[] = []
  readonly fills: Fill[] = []

  constructor(cfg: ExecConfig, symbol = 'SYNTH') {
    this.cfg = cfg
    this.symbol = symbol
  }

  submit(side: OrderSide, type: OrderType, price: number, qty: number, bar: number): Order {
    this.seq += 1
    const id = `O${this.seq.toString(36).padStart(4, '0')}`
    if (!(qty > 0) || !Number.isFinite(qty)) {
      const rejected: Order = {
        id, symbol: this.symbol, side, type,
        price, qty: 0, filledQty: 0, status: 'rejected',
        createdAtBar: bar, eligibleFromBar: bar + this.cfg.latencyBars,
      }
      this.orders.push(rejected)
      return rejected
    }
    const order: Order = {
      id, symbol: this.symbol, side, type, price,
      qty, filledQty: 0, status: 'new',
      createdAtBar: bar, eligibleFromBar: bar + this.cfg.latencyBars,
    }
    this.orders.push(order)
    return order
  }

  cancel(orderId: string): boolean {
    const o = this.orders.find((x) => x.id === orderId)
    if (!o || o.status === 'filled' || o.status === 'cancelled' || o.status === 'rejected') return false
    o.status = 'cancelled'
    return true
  }

  activeOrders(): Order[] {
    return this.orders.filter((o) => o.status === 'new' || o.status === 'ack' || o.status === 'partial')
  }

  onBar(bar: number, candle: Candle): void {
    for (const o of this.activeOrders()) {
      if (bar < o.eligibleFromBar) continue
      if (o.status === 'new') o.status = 'ack'
      const remaining = o.qty - o.filledQty
      const capQty = Math.min(remaining, candle.v * this.cfg.maxParticipation)
      if (!(capQty > 0)) continue

      let fillPrice = Number.NaN
      let feeBps = this.cfg.takerFeeBps

      if (o.type === 'market') {
        fillPrice = o.side === 'buy'
          ? candle.o * (1 + this.cfg.slippageBps / 10_000)
          : candle.o * (1 - this.cfg.slippageBps / 10_000)
      } else if (o.side === 'buy') {
        if (candle.l <= o.price) {
          fillPrice = candle.o < o.price ? candle.o : o.price
          feeBps = this.cfg.makerFeeBps
        }
      } else {
        if (candle.h >= o.price) {
          fillPrice = candle.o > o.price ? candle.o : o.price
          feeBps = this.cfg.makerFeeBps
        }
      }

      if (!Number.isFinite(fillPrice)) continue
      const fillQty = capQty
      const fee = (fillPrice * fillQty * feeBps) / 10_000
      this.fills.push({ orderId: o.id, side: o.side, price: fillPrice, qty: fillQty, fee, bar, ts: candle.t })
      o.filledQty += fillQty
      o.status = o.filledQty >= o.qty ? 'filled' : 'partial'
    }
  }
}
