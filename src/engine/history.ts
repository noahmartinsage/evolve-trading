import type { Candle } from './types.ts'

export const HISTORY_FORMAT_VERSION = 'hist-v1'

export interface HistoryGap {
  afterOpenTime: number
  missingBars: number
}

export interface HistoryMeta {
  formatVersion: typeof HISTORY_FORMAT_VERSION
  source: 'binance-rest'
  symbol: string
  interval: string
  barMinutes: number
  from: number
  to: number
  count: number
  gaps: HistoryGap[]
  contentHash: string
}

export interface HistoryFile {
  meta: HistoryMeta
  candles: Candle[]
}

const INTERVAL_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
}

export function intervalToMinutes(interval: string): number {
  const m = INTERVAL_MINUTES[interval]
  if (!m) throw new Error(`unsupported interval ${interval}`)
  return m
}

export function detectGaps(candles: Candle[], barMinutes: number): HistoryGap[] {
  const barMs = barMinutes * 60_000
  const gaps: HistoryGap[] = []
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].t - candles[i - 1].t
    if (delta > barMs) {
      gaps.push({ afterOpenTime: candles[i - 1].t, missingBars: Math.round(delta / barMs) - 1 })
    }
  }
  return gaps
}

export function contentHash(candles: Candle[]): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const feed = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0
    h2 = Math.imul(h2 + b, 0x85ebca6b) >>> 0
  }
  const s = candles
    .map((c) => `${c.t}:${c.o}:${c.h}:${c.l}:${c.c}:${c.v}`)
    .join('|')
  for (let i = 0; i < s.length; i++) {
    feed(s.charCodeAt(i) & 0xff)
    feed((s.charCodeAt(i) >>> 8) & 0xff)
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export function buildHistory(
  candles: Candle[],
  opts: { symbol: string; interval: string },
): HistoryFile {
  if (candles.length === 0) throw new Error('empty candle list')
  const barMinutes = intervalToMinutes(opts.interval)
  return {
    meta: {
      formatVersion: HISTORY_FORMAT_VERSION,
      source: 'binance-rest',
      symbol: opts.symbol,
      interval: opts.interval,
      barMinutes,
      from: candles[0].t,
      to: candles[candles.length - 1].t,
      count: candles.length,
      gaps: detectGaps(candles, barMinutes),
      contentHash: contentHash(candles),
    },
    candles,
  }
}

export function validateHistory(file: HistoryFile): string[] {
  const errors: string[] = []
  if (file.meta.formatVersion !== HISTORY_FORMAT_VERSION) errors.push('formatVersion 不匹配')
  if (file.meta.count !== file.candles.length) errors.push('count 与实际 K 线数不一致')
  if (file.meta.contentHash !== contentHash(file.candles)) errors.push('contentHash 校验失败')
  const detected = detectGaps(file.candles, file.meta.barMinutes)
  if (JSON.stringify(detected) !== JSON.stringify(file.meta.gaps)) errors.push('gaps 与实际不连续点不一致')
  return errors
}
