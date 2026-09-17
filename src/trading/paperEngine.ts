import { PaperBroker, DEFAULT_EXEC } from '../engine/index.ts'
import type { Candle, Fill } from '../engine/index.ts'
import type { Order } from '../store/Store'

export const paperBroker = new PaperBroker(DEFAULT_EXEC)

const BAR_MS = 60_000
const PAPER_VOLUME = 10_000

interface AccBar {
  start: number
  o: number
  h: number
  l: number
  c: number
}

const accBars = new Map<string, AccBar>()

export function recordPrice(symbol: string, price: number, now = Date.now()): void {
  if (!Number.isFinite(price) || price <= 0) return
  const start = Math.floor(now / BAR_MS) * BAR_MS
  const cur = accBars.get(symbol)
  if (!cur || cur.start !== start) {
    accBars.set(symbol, { start, o: price, h: price, l: price, c: price })
  } else {
    cur.c = price
    if (price > cur.h) cur.h = price
    if (price < cur.l) cur.l = price
  }
}

export function takeClosedBars(now = Date.now()): { symbol: string; candle: Candle }[] {
  const out: { symbol: string; candle: Candle }[] = []
  for (const [symbol, b] of [...accBars.entries()]) {
    if (now >= b.start + BAR_MS) {
      out.push({ symbol, candle: { t: b.start, o: b.o, h: b.h, l: b.l, c: b.c, v: PAPER_VOLUME } })
      accBars.delete(symbol)
    }
  }
  return out.sort((a, b) => a.candle.t - b.candle.t)
}

const clientIdByEngineId = new Map<string, string>()
const engineIdByClientId = new Map<string, string>()
let processedFillCount = 0

export function submitPaperLimit(order: Pick<Order, 'id' | 'pair' | 'side' | 'price' | 'qty'>): void {
  const res = paperBroker.submit({
    clientOrderId: order.id,
    symbol: order.pair,
    side: order.side,
    type: 'limit',
    price: order.price,
    qty: order.qty,
  })
  engineIdByClientId.set(order.id, res.orderId)
  clientIdByEngineId.set(res.orderId, order.id)
}

export function cancelPaperOrder(clientOrderId: string): boolean {
  const engineId = engineIdByClientId.get(clientOrderId)
  if (!engineId) return false
  const ok = paperBroker.cancel(engineId)
  if (ok) {
    engineIdByClientId.delete(clientOrderId)
    clientIdByEngineId.delete(engineId)
  }
  return ok
}

export interface PaperFillEvent {
  clientOrderId: string
  fillQty: number
  fillPrice: number
  fee: number
}

function drainFills(): Fill[] {
  const all = paperBroker.fills()
  if (all.length <= processedFillCount) return []
  const fresh = all.slice(processedFillCount)
  processedFillCount = all.length
  return fresh
}

export function collectPaperFillEvents(): PaperFillEvent[] {
  return drainFills().flatMap((f) => {
    const clientOrderId = paperBroker.clientOrderIdFor(f.orderId)
    if (!clientOrderId) return []
    return [{ clientOrderId, fillQty: f.qty, fillPrice: f.price, fee: f.fee }]
  })
}
