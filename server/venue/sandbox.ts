import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'

export type SandboxFault = 'REJECT_ONCE' | 'DROP_NEXT_FILL' | 'DUPLICATE_NEXT_FILL'

interface SandboxOrder {
  venueOrderId: string
  intent: VenueIntent
  filledQty: number
  cancelled: boolean
}

export class SandboxAdapter implements VenueAdapter {
  readonly name = 'sandbox'
  private seq = 0
  private orders = new Map<string, SandboxOrder>()
  private fillListeners: ((f: VenueFill) => void)[] = []
  private faults: SandboxFault[] = []
  private cash = 100_000
  private positions = new Map<string, { qty: number; avgPrice: number }>()
  private totalFills = 0

  injectFault(f: SandboxFault): void {
    this.faults.push(f)
  }

  async place(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    if (this.faults[0] === 'REJECT_ONCE') {
      this.faults.shift()
      throw new Error('SANDBOX_INJECTED_REJECT')
    }
    this.seq += 1
    const venueOrderId = `V${this.seq.toString(36).padStart(5, '0')}`
    this.orders.set(venueOrderId, { venueOrderId, intent, filledQty: 0, cancelled: false })
    if (intent.type === 'market') {
      const px = (intent.price ?? 100) * (intent.side === 'buy' ? 1.0005 : 0.9995)
      this.emitFill(this.orders.get(venueOrderId) as SandboxOrder, px)
      const o = this.orders.get(venueOrderId) as SandboxOrder
      o.cancelled = true
    }
    return { venueOrderId }
  }

  async cancel(venueOrderId: string): Promise<boolean> {
    const o = this.orders.get(venueOrderId)
    if (!o || o.cancelled) return false
    o.cancelled = true
    return true
  }

  onFill(cb: (f: VenueFill) => void): void {
    this.fillListeners.push(cb)
  }

  openOrderCount(): number {
    return this.openOrderIds().length
  }

  openOrderIds(): string[] {
    const out: string[] = []
    for (const o of this.orders.values()) {
      if (!o.cancelled && o.filledQty < o.intent.qty) out.push(o.venueOrderId)
    }
    return out
  }

  async reconcile(): Promise<BalanceSnapshot> {
    return {
      cash: Math.round(this.cash * 100) / 100,
      positions: [...this.positions.entries()].map(([symbol, p]) => ({
        symbol,
        qty: Math.round(p.qty * 1e8) / 1e8,
        avgPrice: Math.round(p.avgPrice * 1e6) / 1e6,
      })),
      totalFills: this.totalFills,
    }
  }

  ingestTick(symbol: string, price: number): void {
    for (const o of this.orders.values()) {
      if (o.cancelled || o.intent.symbol !== symbol || o.intent.type !== 'limit') continue
      const limitPx = o.intent.price ?? 0
      const crossed = o.intent.side === 'buy' ? price <= limitPx : price >= limitPx
      if (!crossed || o.filledQty >= o.intent.qty) continue
      this.emitFill(o, limitPx)
      if (o.filledQty >= o.intent.qty) o.cancelled = true
    }
  }

  private emitFill(o: SandboxOrder, price: number): void {
    const remaining = o.intent.qty - o.filledQty
    if (remaining <= 1e-12) return
    const px = Math.round(price * 1e4) / 1e4

    this.totalFills += 1
    o.filledQty += remaining
    this.applyAccounting(o.intent.side, o.intent.symbol, px, remaining)

    const base: VenueFill = {
      fillId: `${o.venueOrderId}-F${this.totalFills}`,
      venueOrderId: o.venueOrderId,
      clientOrderId: o.intent.clientOrderId,
      symbol: o.intent.symbol,
      side: o.intent.side,
      price: px,
      qty: remaining,
      ts: Date.now(),
    }

    if (this.faults[0] === 'DROP_NEXT_FILL') {
      this.faults.shift()
      return
    }

    for (const cb of this.fillListeners) cb(base)

    if (this.faults[0] === 'DUPLICATE_NEXT_FILL') {
      this.faults.shift()
      for (const cb of this.fillListeners) cb({ ...base, fillId: `${base.fillId}-dup` })
    }
  }

  private applyAccounting(side: 'buy' | 'sell', symbol: string, price: number, qty: number): void {
    const notional = price * qty
    if (side === 'buy') {
      this.cash -= notional
      const pos = this.positions.get(symbol)
      if (!pos || pos.qty <= 1e-9) {
        this.positions.set(symbol, { qty, avgPrice: price })
      } else {
        const nq = pos.qty + qty
        pos.avgPrice = (pos.avgPrice * pos.qty + notional) / nq
        pos.qty = nq
      }
    } else {
      this.cash += notional
      const pos = this.positions.get(symbol)
      if (pos) {
        pos.qty -= qty
        if (pos.qty <= 1e-9) this.positions.delete(symbol)
      }
    }
  }
}
