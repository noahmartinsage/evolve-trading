import type { Candle, ExecConfig, Fill, Order, OrderSide, OrderType } from './types.ts'

export class MatchingEngine {
  private seq = 0
  private cfg: ExecConfig
  private symbol: string
  readonly orders: Order[] = []
  readonly fills: Fill[] = []
  /**
   * 活动订单表。与 `orders` 并存，只为让 `onBar` 不必每根 bar 重扫全部历史订单。
   * 旧写法 `activeOrders()` 内部是 `this.orders.filter(...)` —— O(bar × 订单数)，
   * 是 12 个月数据下单次回测 97 秒的第二大成因。
   */
  private active: Order[] = []

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
    this.active.push(order)
    return order
  }

  cancel(orderId: string): boolean {
    const o = this.orders.find((x) => x.id === orderId)
    if (!o || o.status === 'filled' || o.status === 'cancelled' || o.status === 'rejected') return false
    o.status = 'cancelled'
    this.active = this.active.filter((x) => x !== o)
    return true
  }

  /**
   * 活动订单（对外语义不变：仍然是"状态属于 new/ack/partial 的订单"）。
   * 实现改为在活动表上过滤 —— 活动表是全部这类订单的超集，
   * 状态只会在提交后向下流转，所以两者恒等。
   */
  activeOrders(): Order[] {
    return this.active.filter((o) => o.status === 'new' || o.status === 'ack' || o.status === 'partial')
  }

  onBar(bar: number, candle: Candle): void {
    // 读/写双游标就地压缩：只遍历活动订单，并把本根变满/作废的移出。
    // 不用 `splice` —— 在循环里反复 splice 本身又是 O(n²)。
    let write = 0
    for (let read = 0; read < this.active.length; read++) {
      const o = this.active[read]
      if (o.status === 'filled' || o.status === 'cancelled' || o.status === 'rejected') continue
      this.active[write] = o
      write += 1
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
    this.active.length = write
  }
}
