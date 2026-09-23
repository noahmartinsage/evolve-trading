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
import { protectionTrigger } from './protection.ts'
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

  // ── 保护单：与"下单成功"**同一步**挂上 ────────────────────────────────
  // ★ 不留"先裸奔、待会儿再挂"的窗口：那个窗口里用户以为有保护、实际什么都没有，
  //   而它在界面上看不出任何缺口。
  // ★ 挂在 `state.protection` 而不是持仓上：纸面市价单要等下一根 bar 才成交
  //   （`matching.ts` 的 `eligibleFromBar`），若挂在持仓上就得等持仓出现才记 ——
  //   保护从"下单那一刻"退化成"成交那一刻"，窗口反而更长。
  // ★ 调用方**只在开仓时**传这两个字段（平仓单带上保护是语义错误）。
  if (intent.takeProfit !== undefined || intent.stopLoss !== undefined) {
    state.protection.set(intent.symbol, {
      ...(intent.takeProfit !== undefined ? { takeProfit: intent.takeProfit } : {}),
      ...(intent.stopLoss !== undefined ? { stopLoss: intent.stopLoss } : {}),
      side: intent.side === 'buy' ? 'long' : 'short',
      attachedAt: receivedAt,
      origin: intent.strategyId ? 'strategy' : 'manual',
    })
    appendEvent('PROTECTION_ATTACHED', {
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      side: intent.side === 'buy' ? 'long' : 'short',
      takeProfit: intent.takeProfit ?? null,
      stopLoss: intent.stopLoss ?? null,
      scope: 'paper',
    })
  }

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

  // ── ★★ 顺序：先出网，**成功之后**才写本地订单台账 ────────────────────────
  //
  // 改造前 `state.orders.push(...)` 在 `liveGateway.submit()` **之前**。
  // 后果：幂等命中（或任何网关侧拒绝）时，这笔单**根本没出网**，
  // 本地却已经多了一条 `ack` 订单 ⇒ 本地账本比场所多一笔。
  // 这正是本项目 `LEDGER_MISMATCH` 的一类成因，而且**方向最坏**：
  // 对账时看到"本地有、场所没有"，人会去场所找一笔不存在的单。
  //
  // ★ 那为什么不能"先落账再出网"来保证不丢？因为出网成功后崩溃时，
  //   "本地有、场所也有"是可恢复的（对账能匹配上）；
  //   而"本地有、场所没有"是不可恢复的假象。
  //   ⇒ 把不可恢复的那种排掉，代价是可能少记一笔已成交的单 ——
  //     那一笔由**成交回报**（`onFill` → `applyVenueFill`）补回来，
  //     回报是场所主动推的，不依赖本地是否记过账。
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
    // ★★ 保护价必须一路走到适配器。
    //   `OrderIntentInput` 早在 2026-08-22 就有了这两个字段，理由是实测过一次
    //   "解析对了/念回了/审计记了，然后下一张裸单"。但那一次只修到
    //   `OrderIntentInput` 为止 —— 它**没有被继续传下去**，所以实盘这条路
    //   仍然是"单子上有止损、场所那侧没有"。这一步补的就是最后一段。
    ...(intent.takeProfit === undefined ? {} : { takeProfit: intent.takeProfit }),
    ...(intent.stopLoss === undefined ? {} : { stopLoss: intent.stopLoss }),
    // ★ 业务桶：由调用方给出的"这一次决策"的标识（自治循环传 K 线时间戳）。
    //   它是幂等语义键里唯一区分"这一次"与"下一次"的成分。
    bucket: (intent as { bucket?: string }).bucket,
  })
  if (!r.ok) {
    metrics.recordRejected(r.reason ?? 'GATEWAY_REJECTED')
    appendEvent('ORDER_REJECT', { scope: 'live', clientOrderId: intent.clientOrderId, reason: r.reason })
    return { ok: false, clientOrderId: intent.clientOrderId, reason: r.reason }
  }

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
  enforceProtection(symbol, price)
}

/**
 * 保护单巡检：这一 tick 上有没有哪道保护被碰到了。
 *
 * ★ 它**只做判定与派单，不碰账本** —— 平仓走 `processOrderIntent`，
 *   也就是人点按钮、嘴下指令用的**同一条**路径。自己在这里改持仓与余额
 *   会造出第二条记账路径（判据 8），两条一定会漂移。
 *
 * ★★ 幂等键用**语义键**（`PROT-标的-attachedAt-哪一道`），不是随机 id：
 *   tick 是秒级的，同一个保护会被连续命中很多次；随机 id 会让每一次
 *   都变成一张新单 —— 用同一个语义键，重复派单会被意图台账按业务事件挡掉。
 *   这是红线㊷「幂等键必须是语义键」的直接应用。
 *
 * ⚠️ 纸面引擎的成交模型是**逐 bar**（`matching.ts`）：这张平仓单也要等
 *   下一根 bar 才成交。所以这里能保证的是"**发现得及时**"，
 *   不是"成交得及时"。实盘通道必须用**场所侧的**条件单，不能靠这条巡检
 *   —— 进程一死，本地巡检就没了。这一点写在派单的回话里。
 */
function enforceProtection(symbol: string, price: number): void {
  const p = state.protection.get(symbol)
  if (!p) return
  const trigger = protectionTrigger(p, price)
  if (!trigger) return

  const pos = state.positions.get(symbol)
  const qty = pos ? Math.abs(pos.qty) : 0
  if (!(qty > 1e-12)) {
    // 价格已经穿过去了，但持仓还没成型（纸面市价单等下一根 bar）。
    // ★ 不删保护、也不静默：留着它，等持仓出现时下一 tick 立刻平掉 ——
    //   这是**保守**那一侧（宁可开了就平，也不要裸着跑）。
    appendEvent('PROTECTION_TRIGGERED_NO_POSITION', {
      symbol,
      trigger,
      price,
      takeProfit: p.takeProfit ?? null,
      stopLoss: p.stopLoss ?? null,
      note: '价格已穿过保护位但持仓尚未成交（纸面引擎逐 bar 成交），保护保留待持仓成型后立即处置',
    })
    return
  }

  const clientOrderId = `PROT-${symbol}-${p.attachedAt}-${trigger}`
  appendEvent('PROTECTION_TRIGGERED', {
    symbol,
    trigger,
    price,
    qty,
    takeProfit: p.takeProfit ?? null,
    stopLoss: p.stopLoss ?? null,
    clientOrderId,
  })
  // 先摘保护再派单：派单失败时不该留下一个已经"用掉"的保护位。
  // 若派单被拒，下面把保护放回去 —— 顺序反过来会在拒单后留下裸仓。
  state.protection.delete(symbol)
  const outcome = processOrderIntent({
    clientOrderId,
    symbol,
    side: p.side === 'long' ? 'sell' : 'buy',
    type: 'market',
    qty,
  })
  appendEvent('PROTECTION_DISPATCHED', {
    symbol,
    trigger,
    clientOrderId,
    ok: outcome.ok,
    reason: outcome.reason ?? null,
  })
  if (!outcome.ok) {
    // 拒单 ⇒ 保护没兑现，必须放回去并说出来。静默丢掉它 =
    // "系统以为已经保护过了"，而仓位还开着。
    state.protection.set(symbol, p)
    appendEvent('PROTECTION_RESTORED', { symbol, trigger, clientOrderId, reason: outcome.reason ?? null })
  }
}
