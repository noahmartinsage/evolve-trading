import type { Candle, ExecConfig, Fill } from './types.ts'
import { MatchingEngine } from './matching.ts'
import type { Strategy, StrategyDecision } from './strategies.ts'

export interface EquityPoint {
  t: number
  equity: number
}

export interface BacktestMeta {
  engineVersion: string
  symbol: string
  bars: number
  barMinutes: number
  startingCash: number
  exec: ExecConfig
  strategyId: string
  params: Record<string, number>
}

export interface BacktestResult {
  equityCurve: EquityPoint[]
  fills: Fill[]
  realizedPnls: number[]
  meta: BacktestMeta
}

export const ENGINE_VERSION = 'engine-v0.1.0'

export function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  exec: ExecConfig,
  startingCash = 100_000,
  barMinutes = 1,
): BacktestResult {
  const engine = new MatchingEngine(exec)
  let cash = startingCash
  let posQty = 0
  let posCost = 0
  let avgPrice = 0
  const equityCurve: EquityPoint[] = []
  const realizedPnls: number[] = []

  const markEquity = (price: number) => cash + posQty * price

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    engine.onBar(i, c)

    const justFilled = engine.fills.filter((f) => f.bar === i)
    for (const f of justFilled) {
      const notional = f.price * f.qty
      if (f.side === 'buy') {
        cash -= notional + f.fee
        posQty += f.qty
        posCost += notional + f.fee
      } else if (posQty > 1e-12) {
        const closedQty = Math.min(f.qty, posQty)
        const unitCost = posCost / posQty
        const costBasis = unitCost * closedQty
        cash += notional - f.fee
        realizedPnls.push(notional - f.fee - costBasis)
        posQty -= closedQty
        posCost -= costBasis
      }
      if (posQty > 1e-12) avgPrice = posCost / posQty
      else {
        posQty = 0
        posCost = 0
        avgPrice = 0
      }
    }

    const decision: StrategyDecision | null = strategy.decide({
      i,
      candles,
      posQty,
      avgPrice,
      equity: markEquity(c.c),
    })

    if (decision) {
      if (decision.side === 'buy') {
        const budget = markEquity(c.c) * decision.frac
        const refPrice = decision.type === 'limit' ? decision.price ?? c.c : c.c
        const qty = budget / (refPrice * (1 + exec.slippageBps / 10_000))
        engine.submit('buy', decision.type, decision.price ?? refPrice, qty, i)
      } else {
        const qty = decision.frac >= 1 ? posQty : posQty * decision.frac
        engine.submit('sell', decision.type, decision.price ?? c.c, qty, i)
      }
    }

    equityCurve.push({ t: c.t, equity: markEquity(c.c) })
  }

  return {
    equityCurve,
    fills: engine.fills,
    realizedPnls,
    meta: {
      engineVersion: ENGINE_VERSION,
      symbol: 'SYNTH',
      bars: candles.length,
      barMinutes,
      startingCash,
      exec,
      strategyId: strategy.id,
      params: strategy.params,
    },
  }
}
