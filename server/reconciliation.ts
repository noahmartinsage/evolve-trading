import type { BalanceSnapshot } from './venue/types.ts'
import type { OrchState } from './types.ts'
import { appendEvent } from './ledger.ts'
import type { ExecutionGateway } from './gateway/executor.ts'

export interface ReconciliationReport {
  ts: number
  consistent: boolean
  toleranceUsd: number
  internal: { cash: number; positions: { symbol: string; qty: number }[] }
  venue: BalanceSnapshot | null
  cashDeltaAbs: number
  positionDeltas: { symbol: string; qtyDelta: number }[]
  action: 'none' | 'venue_outbound_disabled' | 'no_adapter'
}

export interface ReconciliationConfig {
  toleranceUsd: number
  positionTolerance: number
}

const DEFAULT_CONFIG: ReconciliationConfig = { toleranceUsd: 1, positionTolerance: 1e-6 }

let lastReport: ReconciliationReport | null = null

export function getLastReconciliation(): ReconciliationReport | null {
  return lastReport
}

function round(v: number, d = 6): number {
  const m = Math.pow(10, d)
  return Math.round(v * m) / m
}

export async function runReconciliation(state: OrchState, gateway: ExecutionGateway, config: ReconciliationConfig = DEFAULT_CONFIG): Promise<ReconciliationReport> {
  const venueSnap = await gateway.venueSnapshot()
  const internalCash = round(state.balanceUSDC, 2)
  const internalPositions = [...state.positions.values()].map((p) => ({ symbol: p.symbol, qty: round(p.qty) }))

  let cashDeltaAbs = Number.NaN
  const deltas: { symbol: string; qtyDelta: number }[] = []

  if (venueSnap) {
    cashDeltaAbs = round(Math.abs(internalCash - venueSnap.cash), 2)
    const venueBySymbol = new Map(venueSnap.positions.map((p) => [p.symbol, p.qty]))
    for (const ip of internalPositions) {
      const vq = venueBySymbol.get(ip.symbol) ?? 0
      const d = round(Math.abs(ip.qty - vq))
      if (d > config.positionTolerance) deltas.push({ symbol: ip.symbol, qtyDelta: round(ip.qty - vq, 8) })
    }
    for (const vp of venueSnap.positions) {
      if (!internalPositions.some((ip) => ip.symbol === vp.symbol)) {
        if (Math.abs(vp.qty) > config.positionTolerance) deltas.push({ symbol: vp.symbol, qtyDelta: round(-vp.qty, 8) })
      }
    }
  }

  const consistent = venueSnap === null ? true : cashDeltaAbs <= config.toleranceUsd && deltas.length === 0

  let action: ReconciliationReport['action'] = venueSnap ? 'none' : 'no_adapter'
  if (!consistent) {
    const reason = `LEDGER_MISMATCH cashΔ=${cashDeltaAbs} posΔ=${JSON.stringify(deltas)}`
    gateway.setVenueOutboundDisabled(reason)
    action = 'venue_outbound_disabled'
  }

  lastReport = {
    ts: Date.now(),
    consistent,
    toleranceUsd: config.toleranceUsd,
    internal: { cash: internalCash, positions: internalPositions },
    venue: venueSnap,
    cashDeltaAbs,
    positionDeltas: deltas,
    action,
  }

  if (!consistent) {
    appendEvent('RECONCILIATION_MISMATCH', {
      cashDeltaAbs,
      positionDeltas: deltas,
      action,
      internalCash,
      venueCash: venueSnap?.cash ?? null,
    })
  }

  return lastReport
}
