import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildHistory, validateHistory } from '../src/engine/history.ts'
import type { Candle } from '../src/engine/types.ts'

const REST = process.env.BINANCE_REST ?? 'https://api.binance.com'

interface Args {
  symbol: string
  interval: string
  days: number
  outdir: string
}

function parseArgs(): Args {
  const get = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const symbol = (get('--symbol') ?? 'ETHUSDT').toUpperCase()
  const interval = get('--interval') ?? '15m'
  const days = Number(get('--days') ?? '30')
  const outdir = get('--outdir') ?? join('data', 'history')
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days 必须为正数')
  return { symbol, interval, days, outdir }
}

async function fetchKlinesPage(symbol: string, interval: string, startTime: number): Promise<any[][]> {
  const url = `${REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${await res.text().then((t) => t.slice(0, 120))}`)
  return (await res.json()) as any[][]
}

function toCandle(row: any[]): Candle {
  return {
    t: row[0],
    o: parseFloat(row[1]),
    h: parseFloat(row[2]),
    l: parseFloat(row[3]),
    c: parseFloat(row[4]),
    v: parseFloat(row[5]),
  }
}

async function main() {
  const args = parseArgs()
  const endTime = Date.now()
  const startTime = endTime - args.days * 24 * 60 * 60 * 1000
  console.log(`⬇️ 拉取 ${args.symbol} ${args.interval} · 近 ${args.days} 天 · 起点 ${new Date(startTime).toISOString()}`)

  const candles: Candle[] = []
  let cursor = startTime
  while (cursor < endTime) {
    const rows = await fetchKlinesPage(args.symbol, args.interval, cursor)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) candles.push(toCandle(r))
    const lastOpen = rows[rows.length - 1][0] as number
    cursor = lastOpen + 1
    if (rows.length < 1000) break
    await new Promise((r) => setTimeout(r, 250))
  }

  if (candles.length === 0) {
    console.error('❌ 未获取到任何 K 线（网络或符号问题）')
    process.exit(1)
  }

  const file = buildHistory(candles, { symbol: args.symbol, interval: args.interval })
  const errors = validateHistory(file)
  if (errors.length > 0) {
    console.error(`❌ 历史数据自检失败: ${errors.join('; ')}`)
    process.exit(1)
  }

  const outPath = join(args.outdir, `${args.symbol}_${args.interval}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(file))

  const totalGaps = file.meta.gaps.reduce((s, g) => s + g.missingBars, 0)
  console.log(`✅ 已写入 ${outPath}`)
  console.log(`   区间 ${new Date(file.meta.from).toISOString()} → ${new Date(file.meta.to).toISOString()}`)
  console.log(`   K线 ${file.meta.count} 根 · 间隙 ${file.meta.gaps.length} 处（缺 ${totalGaps} 根）· hash=${file.meta.contentHash}`)
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
