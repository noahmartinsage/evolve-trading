import type { BacktestResult } from './backtest.ts'

export interface Report {
  totalReturnPct: number
  annReturnPct: number
  sharpe: number
  maxDrawdownPct: number
  turnoverNotional: number
  tradesPerDay: number
  totalFeesPaid: number
  winRatePct: number
  horizonDays: number
}

export function computeReport(result: BacktestResult, barMinutes = 1): Report {
  const curve = result.equityCurve
  const n = curve.length
  if (n < 2) {
    return {
      totalReturnPct: 0, annReturnPct: 0, sharpe: 0, maxDrawdownPct: 0,
      turnoverNotional: 0, tradesPerDay: 0, totalFeesPaid: 0, winRatePct: 0, horizonDays: 0,
    }
  }

  const barsPerYear = (365 * 24 * 60) / Math.max(1, barMinutes)
  const starting = result.meta.startingCash
  const ending = curve[n - 1].equity
  const totalReturnPct = ((ending - starting) / starting) * 100

  const barReturns: number[] = []
  for (let i = 1; i < n; i++) {
    barReturns.push(curve[i].equity / curve[i - 1].equity - 1)
  }
  const mean = barReturns.reduce((s, r) => s + r, 0) / barReturns.length
  const variance = barReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, barReturns.length - 1)
  const std = Math.sqrt(variance)
  const sharpe = std > 1e-12 ? (mean / std) * Math.sqrt(barsPerYear) : 0

  let peak = curve[0].equity
  let maxDd = 0
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity
    const dd = (peak - p.equity) / peak
    if (dd > maxDd) maxDd = dd
  }

  const notional = result.fills.reduce((s, f) => s + f.price * f.qty, 0)
  const fees = result.fills.reduce((s, f) => s + f.fee, 0)
  const minutes = (curve[n - 1].t - curve[0].t) / 60_000
  const days = Math.max(minutes / 1440, barMinutes / 1440)

  const annReturnPct = mean * barsPerYear * 100

  const wins = result.realizedPnls.filter((p) => p > 0).length
  const winRatePct = result.realizedPnls.length > 0 ? (wins / result.realizedPnls.length) * 100 : 0

  return {
    totalReturnPct,
    annReturnPct,
    sharpe,
    maxDrawdownPct: maxDd * 100,
    turnoverNotional: notional / Math.max(starting, 1),
    tradesPerDay: result.fills.length / days,
    totalFeesPaid: fees,
    winRatePct,
    horizonDays: days,
  }
}
