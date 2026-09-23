import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildHistory, validateHistory } from '../src/engine/history.ts'
import type { Candle } from '../src/engine/types.ts'

/**
 * 行情主机。
 *
 * ★★ 默认值**必须与生产同一台**：`server/index.ts` 与 `src/data/market.ts` 用的
 *   都是 `data-api.binance.vision`。这里原来写的是 `api.binance.com`，
 *   于是本机实测：脚本 8 个标的全 `fetch failed`（每个卡 10 秒），
 *   而同一个时刻应用里的行情是好的 —— 排查方向被引到了"网络/符号名"上，
 *   真正的原因只是**默认值和生产不一样**（判据 8：同一件事不给第二条口径）。
 *   2026-09-19 实测：`api.binance.com` 20 秒超时（HTTP 000），
 *   `data-api.binance.vision` 200 / 0.43 秒。
 */
const REST = process.env.BINANCE_REST ?? 'https://data-api.binance.vision'

interface Args {
  /** 要拉的标的。单标的用 `--symbol`，多标的用 `--symbols A,B,C`。 */
  symbols: string[]
  interval: string
  days: number
  outdir: string
}

function parseArgs(): Args {
  const get = (flag: string) => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  // ★ 多标的是 breadth（横截面）的前提：只有一个标的时"横截面"这个词无从谈起。
  //   做成同一个脚本的第二个参数，而不是新开一个 `breadth-fetch.ts` ——
  //   抓 K 线这件事只能有一份实现（判据 8）。
  const many = get('--symbols')
  const symbols = many
    ? many
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : [(get('--symbol') ?? 'ETHUSDT').toUpperCase()]
  if (symbols.length === 0) throw new Error('--symbols 至少要有一个标的')
  const interval = get('--interval') ?? '15m'
  const days = Number(get('--days') ?? '30')
  const outdir = get('--outdir') ?? join('data', 'history')
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days 必须为正数')
  return { symbols, interval, days, outdir }
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

/** 拉一个标的并写盘。失败返回 false（多标的时**不中断其它标的**）。 */
async function fetchOne(symbol: string, interval: string, days: number, outdir: string): Promise<boolean> {
  const endTime = Date.now()
  const startTime = endTime - days * 24 * 60 * 60 * 1000
  console.log(`⬇️ 拉取 ${symbol} ${interval} · 近 ${days} 天 · 起点 ${new Date(startTime).toISOString()}`)

  const candles: Candle[] = []
  let cursor = startTime
  while (cursor < endTime) {
    const rows = await fetchKlinesPage(symbol, interval, cursor)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) candles.push(toCandle(r))
    const lastOpen = rows[rows.length - 1][0] as number
    cursor = lastOpen + 1
    if (rows.length < 1000) break
    await new Promise((r) => setTimeout(r, 250))
  }

  if (candles.length === 0) {
    // ★ 多标的时这里**不能 exit** —— 一个标的名写错就把另外 9 个也带走了，
    //   而结果是"只拿到了 1 个标的"，看着像是别的标的没数据。
    console.error(`❌ ${symbol}：未获取到任何 K 线（网络或符号问题）`)
    return false
  }

  const file = buildHistory(candles, { symbol, interval })
  const errors = validateHistory(file)
  if (errors.length > 0) {
    console.error(`❌ ${symbol}：历史数据自检失败: ${errors.join('; ')}`)
    return false
  }

  const outPath = join(outdir, `${symbol}_${interval}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(file))

  const totalGaps = file.meta.gaps.reduce((s, g) => s + g.missingBars, 0)
  console.log(`✅ ${outPath}`)
  console.log(`   区间 ${new Date(file.meta.from).toISOString()} → ${new Date(file.meta.to).toISOString()}`)
  console.log(`   K线 ${file.meta.count} 根 · 间隙 ${file.meta.gaps.length} 处（缺 ${totalGaps} 根）· hash=${file.meta.contentHash}`)
  return true
}

async function main() {
  const args = parseArgs()
  let ok = 0
  const bad: string[] = []
  for (const symbol of args.symbols) {
    // 一个标的失败不许影响后面的：横截面最怕"少了一个标的但没人发现"。
    const r = await fetchOne(symbol, args.interval, args.days, args.outdir).catch((e) => {
      console.error(`❌ ${symbol}：${e instanceof Error ? e.message : String(e)}`)
      return false
    })
    if (r) ok += 1
    else bad.push(symbol)
  }
  console.log(`\n合计：成功 ${ok}/${args.symbols.length}${bad.length > 0 ? ` · 失败 ${bad.join('、')}` : ''}`)
  // ★ 只要有一个标的不成，就以非 0 退出 —— 让"少了一个标的"这件事能被脚本调用方看见。
  if (bad.length > 0) process.exit(1)
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
