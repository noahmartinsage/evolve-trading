import type { Candle } from '../src/engine/index.ts'
import type { OrchState } from './types.ts'
import { appendEvent } from './ledger.ts'
import { preTradeCheck, currentEquity } from './risk.ts'
import type { OrderIntentInput } from './risk.ts'
import { liveGateway } from './gateway/executor.ts'
import { metrics } from './metrics.ts'
import { pipelineService } from './pipelineService.ts'
import type { LiveIntentInput } from './pipelineService.ts'
import type { VenueFill } from './venue/types.ts'
import { onOrderActivity } from './surveillance.ts'
import { runReconciliation } from './reconciliation.ts'
import { marginRequired } from './positionGuard.ts'
import {
  cancelAll,
  cancelOnBroker,
  createState,
  ingestBar,
  markPriceOf,
  submitToBroker,
} from './orchEngine.ts'

export interface OrderOutcome {
  ok: boolean
  clientOrderId: string
  orderId?: string
  status?: string
  reason?: string
}

let state: OrchState = createState()

export function getOrchState(): OrchState {
  return state
}

export function resetOrch(startingBalance = 100_000): void {
  state = createState(startingBalance)
}

/** 将本地账本现金/持仓同步为真实 venue 余额，并解除 ledger-mismatch 出站闸。
 *  仅在 venue 已挂载且可读时执行；用于账户注资后让模拟盘账本与交易所对齐，从而放行实盘单。 */
export async function syncLedgerToVenue(): Promise<{ ok: boolean; venueCash: number; reason?: string }> {
  const snap = await liveGateway.venueSnapshot()
  if (!snap) return { ok: false, venueCash: Number.NaN, reason: 'NO_ADAPTER' }
  state.balanceUSDC = snap.cash
  state.startingBalance = snap.cash
  state.peakEquity = snap.cash
  state.positions = new Map(snap.positions.map((p) => [p.symbol, { symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice }]))
  liveGateway.setVenueOutboundDisabled(null)
  appendEvent('LEDGER_SYNCED_TO_VENUE', { venueCash: snap.cash, positions: snap.positions.length })
  const r = await runReconciliation(getOrchState(), liveGateway)
  return { ok: r.consistent, venueCash: snap.cash }
}

export function processOrderIntent(intent: OrderIntentInput & { strategyId?: string }): OrderOutcome {
  const receivedAt = Date.now()
  const mark = markPriceOf(state, intent.symbol)
  const decision = preTradeCheck(state, intent, mark)
  if (!decision.ok) {
    if (decision.reason.startsWith('DRAWDOWN_BREAKER')) {
      // 熔断必须走统一的 killswitch 通道：本地撤全单 + venue 撤单风暴 + gateway 出站闸关闭
      // （risk 层可能已提前置位 killswitch，故此处显式补记熔断审计事件，保证链上可追溯）
      appendEvent('RISK_CIRCUIT_BREAK', { scope: 'paper', reason: decision.reason, clientOrderId: intent.clientOrderId })
      activateKillswitch('DRAWDOWN_BREAKER')
      metrics.recordRejected('DRAWDOWN_BREAKER')
    } else {
      metrics.recordRejected(decision.reason)
    }
    appendEvent('ORDER_REJECT', { clientOrderId: intent.clientOrderId, reason: decision.reason })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: decision.reason }
  }

  state.submitTimestamps.push(Date.now())
  onOrderActivity(Date.now(), true, false, decision.notional)
  appendEvent('ORDER_SUBMIT', { clientOrderId: intent.clientOrderId, symbol: intent.symbol, side: intent.side, qty: intent.qty })
  const { engineOrderId, status } = submitToBroker(state, intent)
  if (status === 'rejected') {
    metrics.recordRejected('BROKER_REJECTED')
    appendEvent('ORDER_REJECT', { clientOrderId: intent.clientOrderId, reason: 'BROKER_REJECTED' })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: 'BROKER_REJECTED' }
  }
  metrics.recordAck(Date.now() - receivedAt)
  appendEvent('ORDER_ACK', { clientOrderId: intent.clientOrderId, orderId: engineOrderId, status })
  return { ok: true, clientOrderId: intent.clientOrderId, orderId: engineOrderId, status }
}

export async function processLiveIntent(intent: LiveIntentInput): Promise<OrderOutcome> {
  const receivedAt = Date.now()
  const mark = markPriceOf(state, intent.symbol)
  const decision = preTradeCheck(state, intent, mark)
  if (!decision.ok) {
    if (decision.reason.startsWith('DRAWDOWN_BREAKER')) {
      appendEvent('RISK_CIRCUIT_BREAK', { scope: 'live', reason: decision.reason, clientOrderId: intent.clientOrderId })
      activateKillswitch('DRAWDOWN_BREAKER')
      metrics.recordRejected('DRAWDOWN_BREAKER')
    } else {
      metrics.recordRejected(decision.reason)
    }
    appendEvent('ORDER_REJECT', { scope: 'live', clientOrderId: intent.clientOrderId, reason: decision.reason })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: decision.reason }
  }

  // 晋升内禁：live 意图必须携带已通过晋升门禁（small_cap_live 阶段）的策略身份，且受资金帽约束
  // 资金帽量的是**自有资金（保证金）**而不是名义本金 —— 「小资金」说的是我出多少钱，
  // 不是我能撬动多大敞口。杠杆越高，同样的帽能承载的名义本金越大，这正是以小博大的形态。
  const margin = marginRequired(decision.notional, intent.leverage ?? 1)
  const auth = pipelineService.authorizeLive(intent.strategyId, decision.notional, margin)
  if (!auth.ok) {
    metrics.recordRejected(auth.reason)
    appendEvent('ORDER_REJECT', { scope: 'live', clientOrderId: intent.clientOrderId, strategyId: intent.strategyId, reason: auth.reason })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: auth.reason }
  }

  state.submitTimestamps.push(Date.now())
  onOrderActivity(Date.now(), true, false, decision.notional)
  appendEvent('ORDER_SUBMIT', { scope: 'live', clientOrderId: intent.clientOrderId, strategyId: intent.strategyId, symbol: intent.symbol, side: intent.side, qty: intent.qty, instType: intent.instType ?? 'SPOT', settle: intent.settle, leverage: intent.leverage ?? 1, marginUsd: margin })
  state.orders.push({
    id: `L-${intent.clientOrderId}`,
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    side: intent.side,
    type: intent.type,
    price: intent.price,
    qty: intent.qty,
    filledQty: 0,
    status: 'ack',
    createdAt: Date.now(),
  })
  liveGateway.setFillSink((f) => {
    applyVenueFill(f)
    appendEvent('ORDER_FILL', {
      scope: 'live',
      fillId: f.fillId,
      venueOrderId: f.venueOrderId,
      clientOrderId: f.clientOrderId,
      symbol: f.symbol,
      side: f.side,
      price: f.price,
      qty: f.qty,
    })
  })
  const r = await liveGateway.submit({
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    side: intent.side,
    type: intent.type,
    price: intent.price,
    qty: intent.qty,
    mode: 'live',
    leverage: intent.leverage,
    instType: intent.instType,
    settle: intent.settle,
  })
  if (!r.ok) {
    metrics.recordRejected(r.reason ?? 'GATEWAY_REJECTED')
    appendEvent('ORDER_REJECT', { scope: 'live', clientOrderId: intent.clientOrderId, reason: r.reason })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: r.reason }
  }
  pipelineService.recordLiveSubmitted(intent.strategyId, decision.notional, margin)
  metrics.recordAck(Date.now() - receivedAt)
  appendEvent('ORDER_ACK', { scope: 'live', clientOrderId: intent.clientOrderId, strategyId: intent.strategyId, venueOrderId: r.venueOrderId })
  return { ok: true, clientOrderId: intent.clientOrderId, orderId: r.venueOrderId, status: 'ack' }
}

/** 将真实 venue 成交回写本地账本（现金/持仓/峰值权益），使实盘交易在监控页可见且 PnL 连续。 */
function applyVenueFill(f: VenueFill): void {
  const signedQty = f.side === 'buy' ? f.qty : -f.qty
  const notional = f.price * f.qty
  state.balanceUSDC += f.side === 'buy' ? -notional : notional
  const cur = state.positions.get(f.symbol)
  if (!cur) {
    if (Math.abs(signedQty) > 1e-9) state.positions.set(f.symbol, { symbol: f.symbol, qty: signedQty, avgPrice: f.price })
  } else {
    const newQty = cur.qty + signedQty
    if (f.side === 'buy') {
      const total = cur.qty * cur.avgPrice + notional
      cur.avgPrice = Math.abs(newQty) > 1e-9 ? total / newQty : 0
    }
    cur.qty = newQty
    if (Math.abs(newQty) < 1e-9) state.positions.delete(f.symbol)
    else state.positions.set(f.symbol, cur)
  }
  const eq = currentEquity(state)
  if (eq > state.peakEquity) state.peakEquity = eq
  metrics.recordFill('live')
}

export function cancelOrder(clientOrderId: string): boolean {
  const ok = cancelOnBroker(state, clientOrderId)
  if (ok) onOrderActivity(Date.now(), false, true)
  return ok
}

export function activateKillswitch(reason = 'MANUAL'): number {
  const wasActive = state.killswitch
  state.killswitch = true
  // 出站闸与编排层状态必须同步关闭：任何进入 killswitch 的路径都冻结 gateway 出站
  liveGateway.setKillswitch(true)
  metrics.recordKillswitch()
  const n = cancelAll(state)
  void liveGateway
    .cancelAllAtVenue()
    .then((venueCancelled: number) => {
      if (venueCancelled !== 0) appendEvent('KILLSWITCH_ON', { scope: 'live-venue', cancelledOrders: venueCancelled })
    })
    .catch(() => appendEvent('KILLSWITCH_ON', { scope: 'live-venue', error: 'CANCEL_ALL_FAILED' }))
  if (!wasActive) appendEvent('KILLSWITCH_ON', { reason, cancelledOrders: n })
  return n
}

export function deactivateKillswitch(): void {
  state.killswitch = false
  liveGateway.setKillswitch(false)
  appendEvent('KILLSWITCH_OFF', {})
}

export function onMarketBar(symbol: string, candle: Candle): void {
  metrics.recordBar(symbol, candle.t)
  ingestBar(state, symbol, candle)
}

export function seedPrice(symbol: string, price: number): void {
  state.lastPrice.set(symbol, price)
}

/** C-13 实时 tick：WebSocket 秒级最新价直接驱动标记价格与权益曲线 */
export function onPriceTick(symbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return
  const prev = state.lastPrice.get(symbol) ?? price
  state.lastPrice.set(symbol, price)
  if (price > prev) {
    const equity = currentEquity(state)
    if (equity > state.peakEquity) state.peakEquity = equity
  }
}
