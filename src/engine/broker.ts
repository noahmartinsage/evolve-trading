import type { Candle, ExecConfig, Fill, Order, OrderSide, OrderStatus, OrderType } from './types.ts'
import { MatchingEngine } from './matching.ts'

export interface OrderRequest {
  clientOrderId: string
  symbol: string
  side: OrderSide
  type: OrderType
  price?: number
  qty: number
}

export interface SubmitResult {
  orderId: string
  clientOrderId: string
  status: OrderStatus
}

export interface BrokerClient {
  readonly kind: 'paper' | 'live'
  submit(req: OrderRequest): SubmitResult
  cancel(orderId: string): boolean
  onBar(symbol: string, candle: Candle): void
  orders(): Order[]
  fills(): Fill[]
}

export class PaperBroker implements BrokerClient {
  readonly kind = 'paper' as const
  private cfg: ExecConfig
  private engines = new Map<string, MatchingEngine>()
  private idToClient = new Map<string, string>()
  private barIndex = new Map<string, number>()
  private allOrders: Order[] = []
  private allFills: Fill[] = []

  constructor(cfg: ExecConfig) {
    this.cfg = cfg
  }

  submit(req: OrderRequest): SubmitResult {
    let engine = this.engines.get(req.symbol)
    if (!engine) {
      engine = new MatchingEngine(this.cfg, req.symbol)
      this.engines.set(req.symbol, engine)
    }
    const currentBar = this.barIndex.get(req.symbol) ?? 0
    const order = engine.submit(req.side, req.type, req.price ?? 0, req.qty, currentBar)
    this.idToClient.set(order.id, req.clientOrderId)
    if (order.status !== 'rejected') this.allOrders.push(order)
    return { orderId: order.id, clientOrderId: req.clientOrderId, status: order.status }
  }

  cancel(orderId: string): boolean {
    for (const engine of this.engines.values()) {
      if (engine.orders.some((x) => x.id === orderId)) {
        const ok = engine.cancel(orderId)
        if (ok) this.allFills = this.collectFills()
        return ok
      }
    }
    return false
  }

  onBar(symbol: string, candle: Candle): void {
    const engine = this.engines.get(symbol)
    if (!engine) return
    const nextBar = (this.barIndex.get(symbol) ?? 0) + 1
    this.barIndex.set(symbol, nextBar)
    const before = engine.fills.length
    engine.onBar(nextBar, candle)
    if (engine.fills.length !== before) {
      this.allFills = this.collectFills()
    }
  }

  orders(): Order[] {
    return [...this.allOrders]
  }

  clientOrderIdFor(engineOrderId: string): string | undefined {
    return this.idToClient.get(engineOrderId)
  }

  fills(): Fill[] {
    return [...this.allFills]
  }

  private collectFills(): Fill[] {
    const out: Fill[] = []
    for (const e of this.engines.values()) out.push(...e.fills)
    return out.sort((a, b) => a.ts - b.ts)
  }
}
