import { runBacktest, computeReport, computeFitness, genSynthCandles } from '../../src/engine/index.ts'
import type { Candle } from '../../src/engine/index.ts'

interface WorkerInput {
  code: string
  candles?: Candle[]
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as WorkerInput

  const candles = input.candles && input.candles.length >= 30
    ? input.candles.slice(0, 5_000)
    : genSynthCandles({ seed: 7, bars: 960, startPrice: 100, volDaily: 0.04, driftDaily: 0.0003, barMinutes: 15 })

  // 用户代码契约：定义 makeStrategy(E) 返回 { id, params, decide(ctx) }
  const factory = new Function('E', `"use strict";\n${input.code}\n;if (typeof makeStrategy !== 'function') throw new Error('MAKE_STRATEGY_REQUIRED');return makeStrategy(E);`)
  const factoryResult = factory({
    sma: (await import('../../src/engine/indicators.ts')).sma,
    rsi: (await import('../../src/engine/indicators.ts')).rsi,
  })
  const strategy = factoryResult as { id: string; params: Record<string, number>; decide: (ctx: unknown) => unknown }
  if (!strategy || typeof strategy.decide !== 'function') throw new Error('STRATEGY_DECIDE_REQUIRED')

  const exec = { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 }
  const result = runBacktest(candles as Candle[], strategy as never, exec, 100_000, 15)
  const report = computeReport(result, 15)
  const fit = computeFitness({
    annReturnPct: report.annReturnPct,
    maxDrawdownPct: report.maxDrawdownPct,
    tradesPerDay: report.tradesPerDay,
  })

  process.stdout.write(
    '###RESULT###' +
      JSON.stringify({
        ok: true,
        strategyId: String(strategy.id ?? 'unnamed').slice(0, 80),
        fitness: Math.round(fit.value * 1000) / 1000,
        fitnessVersion: fit.version,
        report: {
          annReturnPct: Math.round(report.annReturnPct * 100) / 100,
          maxDrawdownPct: Math.round(report.maxDrawdownPct * 100) / 100,
          sharpe: Math.round(report.sharpe * 100) / 100,
          tradesPerDay: Math.round(report.tradesPerDay * 100) / 100,
          totalFeesPaid: Math.round(report.totalFeesPaid * 100) / 100,
          horizonDays: Math.round(report.horizonDays * 100) / 100,
        },
        fills: result.fills.length,
      }),
  )
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e).slice(0, 200)
  process.stdout.write('###RESULT###' + JSON.stringify({ ok: false, error: msg }))
  process.exit(0)
})
