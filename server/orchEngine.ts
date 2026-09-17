import { PaperBroker, DEFAULT_EXEC } from '../src/engine/index.ts'
import type { Candle, Fill } from '../src/engine/index.ts'
import type { OrchOrder, OrchState } from './types.ts'
import { DEFAULT_RISK } from './types.ts'
import { appendEvent } from './ledger.ts'
import { currentEquity } from './risk.ts'
import { onFill } from './surveillance.ts'
import { metrics } from './metrics.ts'
import { pipelineService } from './pipelineService.ts'

const broker = new PaperBroker(DEFAULT_EXEC)

interface IntentMeta {
  intent: {
    clientOrderId: string
    symbol: string
    side: 'buy' | 'sell'
    type: 'market' | 'limit'
    price?: number
    qty: number
    strategyId?: string
  }
  orchOrder: OrchOrder
}

const metaByEngineId = new Map<string, IntentMeta>()
const engineIdByClient = new Map<string, string>()

export function createState(startingBalance = 100_000): OrchState {
  return {
    mode: 'paper',
    killswitch: false,
    balanceUSDC: startingBalance,
    startingBalance,
    peakEquity: startingBalance,
    positions: new Map(),
    orders: [],
    lastPrice: new Map(),
    equityCurve: [],
    risk: { ...DEFAULT_RISK },
    submitTimestamps: [],
  }
}

export function submitToBroker(state: OrchState, intent: IntentMeta['intent']): { engineOrderId: string; status: string } {
  const res = broker.submit({
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    side: intent.side,
    type: intent.type,
    price: intent.price,
    qty: intent.qty,
  })
  const orchOrder: OrchOrder = {
    id: res.orderId,
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    side: intent.side,
    type: intent.type,
    price: intent.price,
    qty: intent.qty,
    filledQty: 0,
    status: res.status,
    createdAt: Date.now(),
  }
  state.orders.unshift(orchOrder)
  if (state.orders.length > 500) state.orders.length = 500
  if (res.status !== 'rejected') {
    metaByEngineId.set(res.orderId, { intent, orchOrder })
    engineIdByClient.set(intent.clientOrderId, res.orderId)
  }
  return { engineOrderId: res.orderId, status: res.status }
}

export function cancelOnBroker(state: OrchState, clientOrderId: string): boolean {
  const engineId = engineIdByClient.get(clientOrderId)
  if (!engineId) return false
  const ok = broker.cancel(engineId)
  if (ok) {
    const ord = state.orders.find((o) => o.clientOrderId === clientOrderId)
    if (ord && ord.status !== 'filled') ord.status = 'cancelled'
    engineIdByClient.delete(clientOrderId)
    metaByEngineId.delete(engineId)
    metrics.recordCancel()
    appendEvent('ORDER_CANCEL', { clientOrderId })
  }
  return ok
}

export function cancelAll(state: OrchState): number {
  let n = 0
  for (const o of [...state.orders]) {
    if (o.status === 'new' || o.status === 'ack' || o.status === 'partial') {
      if (cancelOnBroker(state, o.clientOrderId)) n += 1
    }
  }
  return n
}

export function ingestBar(state: OrchState, symbol: string, candle: Candle): Fill[] {
  state.lastPrice.set(symbol, candle.c)
  const before = broker.fills().length
  broker.onBar(symbol, candle)
  const fresh = broker.fills().slice(before)

  for (const f of fresh) {
    const meta = metaByEngineId.get(f.orderId)
    if (!meta) continue
    applyFillAccounting(state, meta.intent, f.price, f.qty, f.fee)
    onFill({ ts: Date.now(), side: meta.intent.side, price: f.price, qty: f.qty, clientOrderId: meta.intent.clientOrderId })
    meta.orchOrder.filledQty += f.qty
    meta.orchOrder.status = meta.orchOrder.filledQty >= meta.orchOrder.qty ? 'filled' : 'partial'
    metrics.recordFill('paper')
    pipelineService.recordPaperTradeAuto(meta.intent.strategyId)
    appendEvent('ORDER_FILL', {
      clientOrderId: meta.intent.clientOrderId,
      strategyId: meta.intent.strategyId,
      symbol: meta.intent.symbol,
      side: meta.intent.side,
      price: f.price,
      qty: f.qty,
      fee: Math.round(f.fee * 1e6) / 1e6,
    })
  }

  const equity = currentEquity(state)
  if (equity > state.peakEquity) state.peakEquity = equity
  const lastPoint = state.equityCurve[state.equityCurve.length - 1]
  if (!lastPoint || lastPoint.t !== candle.t) {
    state.equityCurve.push({ t: candle.t, equity })
    if (state.equityCurve.length > 5_000) state.equityCurve.shift()
  }
  return fresh
}

function applyFillAccounting(
  state: OrchState,
  intent: IntentMeta['intent'],
  fillPrice: number,
  fillQty: number,
  fee: number,
): void {
  const notional = fillPrice * fillQty
  if (intent.side === 'buy') {
    state.balanceUSDC -= notional + fee
    const pos = state.positions.get(intent.symbol)
    if (!pos || pos.qty <= 1e-12) {
      state.positions.set(intent.symbol, { symbol: intent.symbol, qty: fillQty, avgPrice: fillPrice })
    } else {
      const newQty = pos.qty + fillQty
      pos.avgPrice = (pos.avgPrice * pos.qty + notional + fee) / newQty
      pos.qty = newQty
    }
  } else {
    state.balanceUSDC += notional - fee
    const pos = state.positions.get(intent.symbol)
    if (pos) {
      pos.qty -= fillQty
      if (pos.qty <= 1e-12) state.positions.delete(intent.symbol)
    }
  }
}

export function markPriceOf(state: OrchState, symbol: string): number {
  return state.lastPrice.get(symbol) ?? 0
}
