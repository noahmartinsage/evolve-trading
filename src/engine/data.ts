import type { Candle } from './types.ts'
import { makeRng } from './rng.ts'

export const SYNTH_DATA_VERSION = 'synthetic-gbm-v1'

export interface SynthDataSpec {
  seed: number
  bars: number
  startPrice: number
  volDaily: number
  driftDaily: number
  barMinutes: number
}

export const GOLDEN_DATA_SPEC: SynthDataSpec = {
  seed: 20260823,
  bars: 2400,
  startPrice: 3500,
  volDaily: 0.04,
  driftDaily: 0.0003,
  barMinutes: 15,
}

export function genSynthCandles(spec: SynthDataSpec, startTs = Date.UTC(2026, 0, 1)): Candle[] {
  const rng = makeRng(spec.seed)
  const volBar = spec.volDaily / Math.sqrt(1440 / spec.barMinutes)
  const driftBar = spec.driftDaily * (spec.barMinutes / 1440)
  const out: Candle[] = []
  let price = spec.startPrice
  for (let i = 0; i < spec.bars; i++) {
    const o = price
    const c = o * Math.exp(driftBar + volBar * rng.norm())
    const upWick = rng.next()
    const dnWick = rng.next()
    const h = Math.max(o, c) * (1 + upWick * volBar * 0.6)
    const l = Math.min(o, c) * (1 - dnWick * volBar * 0.6)
    const v = 100 * (0.5 + rng.next()) * (1 + Math.abs(c - o) / (o * volBar))
    out.push({ t: startTs + i * spec.barMinutes * 60_000, o, h, l, c, v })
    price = c
  }
  return out
}
