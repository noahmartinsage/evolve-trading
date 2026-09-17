import type { Candle } from './types.ts'
import { sma, rsi, ema, stddev, macd } from './indicators.ts'
import { runBacktest } from './backtest.ts'
import type { BacktestResult } from './backtest.ts'
import { computeReport } from './report.ts'
import type { Report } from './report.ts'
import { computeFitness } from './fitness.ts'

export interface StrategyContext {
  i: number
  candles: Candle[]
  posQty: number
  avgPrice: number
  equity: number
}

export interface StrategyDecision {
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  frac: number
}

export interface Strategy {
  id: string
  params: Record<string, number>
  decide(ctx: StrategyContext): StrategyDecision | null
}

/**
 * 策略参数自洽性校验（fail-closed）。
 *
 * 这些约束不是「防御性编程」，而是**真实事故的补丁**：
 * 曾经有人用环境变量把 `rsi-rev` 钉成 `{period:5, lower:100, upper:55}`，
 * 系统照单全收，然后那个策略在单边上行里永不产生多头信号，
 * 表现为「系统在上涨行情里一笔都不做」，而所有日志看起来都正常
 * （它确实在按参数执行，只是那组参数没有意义）。
 *
 * 非法参数必须在**构造时就炸掉**，而不是变成一条安静的死策略。
 */
function assertParams(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`策略参数非法：${msg}`)
}

export function maCrossStrategy(fast: number, slow: number): Strategy {
  assertParams(fast >= 1 && slow > fast, `macross 需要 fast >= 1 且 slow > fast，收到 fast=${fast} slow=${slow}`)
  const params = { fast, slow }
  return {
    id: 'macross',
    params,
    decide(ctx) {
      if (ctx.i < slow + 1) return null
      const closes = ctx.candles.map((c) => c.c)
      const f = sma(closes, fast)
      const s = sma(closes, slow)
      const prevGap = f[ctx.i - 1] - s[ctx.i - 1]
      const currGap = f[ctx.i] - s[ctx.i]
      if (Number.isNaN(prevGap) || Number.isNaN(currGap)) return null
      if (prevGap <= 0 && currGap > 0 && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'market', frac: 0.95 }
      }
      if (prevGap >= 0 && currGap < 0 && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

export function rsiReversionStrategy(period: number, lower: number, upper: number): Strategy {
  assertParams(
    period >= 2 && lower > 0 && upper < 100 && lower < upper,
    `rsi-rev 需要 period >= 2 且 0 < lower < upper < 100，收到 period=${period} lower=${lower} upper=${upper}`,
  )
  const params = { period, lower, upper }
  return {
    id: 'rsi-rev',
    params,
    decide(ctx) {
      if (ctx.i < period + 2) return null
      const closes = ctx.candles.map((c) => c.c)
      const values = rsi(closes, period)
      const v = values[ctx.i]
      if (Number.isNaN(v)) return null
      if (v < lower && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'limit', price: ctx.candles[ctx.i].c, frac: 0.9 }
      }
      if (v > upper && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

/** 动量突破因子族：N 根高点/低点突破入场 */
export function breakoutStrategy(period: number): Strategy {
  const params = { period }
  return {
    id: 'breakout',
    params,
    decide(ctx) {
      if (ctx.i < period + 1) return null
      const window = ctx.candles.slice(ctx.i - period, ctx.i)
      const hi = Math.max(...window.map((c) => c.h))
      const lo = Math.min(...window.map((c) => c.l))
      const c = ctx.candles[ctx.i].c
      if (c > hi && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'market', frac: 0.9 }
      }
      if (c < lo && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

/** 布林带均值回归：价格偏离下轨 z 分位买入，回归中轨附近卖出（震荡市更稳） */
export function bollingerReversionStrategy(period: number, numStd: number): Strategy {
  assertParams(
    period >= 2 && Number.isFinite(numStd) && numStd > 0,
    `boll-rev 需要 period >= 2 且 numStd > 0，收到 period=${period} numStd=${numStd}`,
  )
  const params = { period, numStd }
  return {
    id: 'boll-rev',
    params,
    decide(ctx) {
      if (ctx.i < period + 1) return null
      const closes = ctx.candles.map((c) => c.c)
      const mid = sma(closes, period)
      const sd = stddev(closes, period)
      const m = mid[ctx.i]
      const s = sd[ctx.i]
      if (Number.isNaN(m) || Number.isNaN(s) || s === 0) return null
      const price = closes[ctx.i]
      const z = (price - m) / s
      if (z < -numStd && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'limit', price: price, frac: 0.9 }
      }
      if (z > numStd && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

/**
 * MACD 趋势因子：柱状体由负转正且价格高于快线时顺势做多，
 * 由正转负平仓。捕捉波段行情，单笔空间大于均值回归。
 */
export function macdTrendStrategy(fast: number, slow: number, signalPeriod: number): Strategy {
  assertParams(
    fast >= 1 && slow > fast && signalPeriod >= 1,
    `macd-trend 需要 fast >= 1、slow > fast、signalPeriod >= 1，收到 fast=${fast} slow=${slow} signal=${signalPeriod}`,
  )
  const params = { fast, slow, signalPeriod }
  return {
    id: 'macd-trend',
    params,
    decide(ctx) {
      if (ctx.i < slow + signalPeriod + 1) return null
      const closes = ctx.candles.map((c) => c.c)
      const { hist } = macd(closes, fast, slow, signalPeriod)
      const h0 = hist[ctx.i]
      const h1 = hist[ctx.i - 1]
      if (Number.isNaN(h0) || Number.isNaN(h1)) return null
      if (h1 <= 0 && h0 > 0 && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'market', frac: 0.9 }
      }
      if (h1 >= 0 && h0 < 0 && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

/**
 * 趋势中的回调（pullback）因子：价格站在 EMA 之上（多头 regime）且 RSI 超卖时买入，
 * 多头 regime 破位（价格跌破 EMA）或 RSI 超买时卖出。兼顾胜率与趋势空间。
 */
/**
 * EMA 趋势 + RSI 回调的组合策略。
 *
 * ## 修复记录：入场条件曾经**在数学上不可能成立**
 *
 * 旧写法是 `价格 > EMA && RSI < lower`（lower 取 25~35）。
 * 这两个条件互斥：价格站上 EMA 时市场处于上行，RSI 的中位数在 59 附近、
 * p05 也有 48；而 RSI 跌到 30 以下时价格早已跌破 EMA。
 * 实测 2400 根 K 线：「价格 > EMA50」1176 根、「RSI < 30」157 根、
 * **同时成立 0 根**。于是该族三个候选全部 `fills=0`，
 * 常年以 fitness=0 挂在候选池里——既污染进化搜索，又拉低排行榜区分度，
 * 最坏情况下被选为冠军，让系统进入「永不建仓」的静默状态。
 *
 * 修正后的语义是**多头环境下的回调入场**（RSI 阈值从「超卖」改为「回调」）：
 *   - 多头环境 = 价格 > EMA **且** EMA 上行
 *     （只判价格位置会在均线走平时来回横跳，所以补上斜率条件）
 *   - 入场 = 多头环境 + RSI 回落至 `lower` 之下（回调买点，不追高）
 *   - 出场 = 跌破 EMA 或 RSI 超买（`upper`）
 *
 * 相应地 `buildCandidateSet()` 里的 `lower` 取 40~50，与「回调」语义匹配。
 */
export function emaRsiComboStrategy(emaPeriod: number, rsiPeriod: number, lower: number, upper: number): Strategy {
  assertParams(
    emaPeriod >= 2 && rsiPeriod >= 2 && lower > 0 && upper < 100 && lower < upper,
    `ema-rsi 需要 emaPeriod>=2、rsiPeriod>=2 且 0 < lower < upper < 100，收到 ema=${emaPeriod} rsi=${rsiPeriod} lower=${lower} upper=${upper}`,
  )
  const params = { emaPeriod, rsiPeriod, lower, upper }
  return {
    id: 'ema-rsi',
    params,
    decide(ctx) {
      if (ctx.i < Math.max(emaPeriod, rsiPeriod) + 1) return null
      const closes = ctx.candles.map((c) => c.c)
      const e = ema(closes, emaPeriod)
      const r = rsi(closes, rsiPeriod)
      const emaV = e[ctx.i]
      const emaPrev = e[ctx.i - 1]
      const rsiV = r[ctx.i]
      if (!Number.isFinite(emaV) || !Number.isFinite(emaPrev) || !Number.isFinite(rsiV)) return null
      const price = closes[ctx.i]
      const bullEnv = price > emaV && emaV > emaPrev
      if (bullEnv && rsiV < lower && ctx.posQty <= 1e-12) {
        return { side: 'buy', type: 'limit', price, frac: 0.9 }
      }
      if ((price < emaV || rsiV > upper) && ctx.posQty > 1e-12) {
        return { side: 'sell', type: 'market', frac: 1 }
      }
      return null
    },
  }
}

export interface CandidateResult {
  id: string
  label: string
  result: BacktestResult
  report: Report
  fitness: number
  fitnessVersion: string
}

export const DEFAULT_GRID_EXEC = {
  makerFeeBps: 2,
  takerFeeBps: 5,
  slippageBps: 3,
  maxParticipation: 0.1,
  latencyBars: 1,
}

export function buildCandidateSet(): Strategy[] {
  const set: Strategy[] = []
  for (const [fast, slow] of [[5, 20], [10, 30], [20, 60], [12, 48]] as const) {
    set.push(maCrossStrategy(fast, slow))
  }
  for (const [period, lower, upper] of [[14, 30, 70], [9, 25, 65], [7, 20, 60], [21, 35, 75]] as const) {
    set.push(rsiReversionStrategy(period, lower, upper))
  }
  for (const period of [20, 55]) {
    set.push(breakoutStrategy(period))
  }
  for (const [period, numStd] of [[20, 2], [20, 2.5], [14, 2], [30, 2]] as const) {
    set.push(bollingerReversionStrategy(period, numStd))
  }
  for (const [fast, slow, sig] of [[12, 26, 9], [8, 21, 5], [5, 35, 5]] as const) {
    set.push(macdTrendStrategy(fast, slow, sig))
  }
  // ema-rsi 的 `lo` 是「回调阈值」而不是「超卖阈值」——与策略实现里的
  // 「多头环境 + RSI 回调」入场语义对应。取 40~50 是因为多头上行中
  // RSI 的 p05 落在 41~50 之间；若沿用旧的超卖数值（25~35），
  // 入场条件将永久不可能成立（详见 emaRsiComboStrategy 的修复记录）。
  for (const [ep, rp, lo, hi] of [[50, 14, 45, 70], [100, 9, 40, 65], [20, 14, 50, 75]] as const) {
    set.push(emaRsiComboStrategy(ep, rp, lo, hi))
  }
  return set
}

function evaluate(candles: Candle[], strategy: Strategy, barMinutes: number): CandidateResult {
  const result = runBacktest(candles, strategy, DEFAULT_GRID_EXEC, 100_000, barMinutes)
  const report = computeReport(result, barMinutes)
  const fit = computeFitness({
    annReturnPct: report.annReturnPct,
    maxDrawdownPct: report.maxDrawdownPct,
    tradesPerDay: report.tradesPerDay,
  })
  return {
    id: `${strategy.id}:${JSON.stringify(strategy.params)}`,
    label: `${strategy.id} ${JSON.stringify(strategy.params)}`,
    result,
    report,
    fitness: Math.round(fit.value * 1000) / 1000,
    fitnessVersion: fit.version,
  }
}

export function evaluateStrategy(candles: Candle[], strategy: Strategy, barMinutes = 15): CandidateResult {
  return evaluate(candles, strategy, barMinutes)
}

export function evaluateCandidateGrid(candles: Candle[], barMinutes = 15): CandidateResult[] {
  return buildCandidateSet()
    .map((s) => evaluate(candles, s, barMinutes))
    .sort((a, b) => b.fitness - a.fitness)
}
