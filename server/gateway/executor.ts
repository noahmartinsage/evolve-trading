import type { BalanceSnapshot, VenueAdapter, VenueFill } from '../venue/types.ts'
import type { OrderIntentInput } from '../risk.ts'

export interface GatewayStatus {
  adapterAttached: boolean
  adapterName: string
  handshakeComplete: boolean
  killswitch: boolean
  venueOutboundDisabledReason: string | null
  queued: number
  processedFills: number
  drainedDuplicates: number
}

export interface GatewaySubmitResult {
  ok: boolean
  venueOrderId?: string
  reason?: string
}

type FillSink = (f: VenueFill) => void

const LIVE_MODE_REQUIRED = 'GATEWAY_ACCEPTS_LIVE_INTENTS_ONLY'

export class ExecutionGateway {
  private adapter: VenueAdapter | null = null
  private handshake = false
  private killswitchActive = false
  private venueStopReason: string | null = null
  private seenClientIds = new Set<string>()
  private seenEconomicFills = new Set<string>()
  private processedFills = 0
  private drainedDuplicates = 0
  private fillSink: FillSink | null = null
  private queueDepth = 0

  attachAdapter(a: VenueAdapter): void {
    this.adapter = a
    a.onFill((f) => this.handleVenueFill(f))
  }

  completeRiskHandshake(): void {
    this.handshake = true
  }

  setKillswitch(active: boolean): void {
    this.killswitchActive = active
  }

  /** venue 级出站禁用（区别于全局 killswitch）：对账失配等场景自动触发，需人工清除 */
  setVenueOutboundDisabled(reason: string | null): void {
    this.venueStopReason = reason
  }

  setFillSink(sink: FillSink): void {
    this.fillSink = sink
  }

  status(): GatewayStatus {
    return {
      adapterAttached: this.adapter !== null,
      adapterName: this.adapter?.name ?? 'none',
      handshakeComplete: this.handshake,
      killswitch: this.killswitchActive,
      venueOutboundDisabledReason: this.venueStopReason,
      queued: this.queueDepth,
      processedFills: this.processedFills,
      drainedDuplicates: this.drainedDuplicates,
    }
  }

  async submit(intent: OrderIntentInput & { mode?: string }): Promise<GatewaySubmitResult> {
    if (intent.mode !== 'live') return { ok: false, reason: LIVE_MODE_REQUIRED }
    if (!this.handshake) return { ok: false, reason: 'HANDSHAKE_INCOMPLETE' }
    if (!this.adapter) return { ok: false, reason: 'NO_ADAPTER_ATTACHED' }
    if (this.killswitchActive) return { ok: false, reason: 'KILLSWITCH_ACTIVE' }
    if (this.venueStopReason !== null) return { ok: false, reason: `VENUE_OUTBOUND_DISABLED:${this.venueStopReason}` }
    if (this.seenClientIds.has(intent.clientOrderId)) return { ok: false, reason: 'DUPLICATE_CLIENT_ID' }

    this.seenClientIds.add(intent.clientOrderId)
    this.queueDepth += 1
    try {
      const res = await this.adapter.place({
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        price: intent.price,
        qty: intent.qty,
        leverage: intent.leverage,
        // 品种形态必须一路透传：适配器靠它决定 instId 与下单量单位
        // （SPOT 的 sz 是币量、SWAP 的 sz 是张）。这里漏传不会报错，
        // 只会让一笔 125x 合约单以现货形态发出去 —— 场所会用一个
        // 与真因无关的理由拒掉（例如保证金不足），排查方向就此跑偏。
        instType: intent.instType,
        settle: intent.settle,
      })
      return { ok: true, venueOrderId: res.venueOrderId }
    } catch (e) {
      return { ok: false, reason: `VENUE_ERROR: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}` }
    } finally {
      this.queueDepth -= 1
    }
  }

  async cancelAllAtVenue(): Promise<number> {
    if (!this.adapter) return 0
    let n = 0
    for (let round = 0; round < 20; round++) {
      const ids = await this.adapter.openOrderIds()
      if (ids.length === 0) break
      for (const id of ids) {
        if (await this.adapter.cancel(id)) n += 1
      }
    }
    const remaining = await this.adapter.openOrderIds()
    return remaining.length === 0 ? n : -1
  }

  reset(): void {
    this.seenClientIds.clear()
    this.seenEconomicFills.clear()
    this.processedFills = 0
    this.drainedDuplicates = 0
    this.handshake = false
    this.killswitchActive = false
    this.venueStopReason = null
    this.queueDepth = 0
  }

  venueSnapshot(): Promise<BalanceSnapshot | null> {
    return this.adapter ? this.adapter.reconcile() : Promise.resolve(null)
  }

  handleVenueFill(f: VenueFill): void {
    const economicKey = `${f.venueOrderId}|${f.side}|${f.price}|${f.qty}`
    if (this.seenEconomicFills.has(economicKey)) {
      this.drainedDuplicates += 1
      return
    }
    this.seenEconomicFills.add(economicKey)
    this.processedFills += 1
    this.fillSink?.(f)
  }

  async reconcileAgainstVenue(): Promise<{ consistent: boolean; localFills: number; venueFills: number; missing: number }> {
    if (!this.adapter) return { consistent: true, localFills: 0, venueFills: 0, missing: 0 }
    const snap: BalanceSnapshot = await this.adapter.reconcile()
    const missing = snap.totalFills - this.processedFills - this.drainedDuplicates * 0
    return {
      consistent: missing === 0,
      localFills: this.processedFills,
      venueFills: snap.totalFills,
      missing,
    }
  }

  venueCash(): Promise<number> {
    return this.adapter ? this.adapter.reconcile().then((s) => s.cash) : Promise.resolve(Number.NaN)
  }
}

export const liveGateway = new ExecutionGateway()

