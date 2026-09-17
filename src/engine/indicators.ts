export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  if (period <= 0) return out
  const k = 2 / (period + 1)
  let prev = Number.NaN
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isNaN(prev)) {
      // 用 SMA 作为初始种子，避免前 period 个全为 NaN
      if (i >= period - 1) {
        let sum = 0
        for (let j = i - period + 1; j <= i; j++) sum += values[j]
        prev = sum / period
        out[i] = prev
      }
    } else {
      prev = v * k + prev * (1 - k)
      out[i] = prev
    }
  }
  return out
}

/** 滚动标准差（基于 SMA 的波动率） */
export function stddev(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += values[j]
    const mean = sum / period
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2
    out[i] = Math.sqrt(sq / period)
  }
  return out
}

/** MACD：快线 EMA - 慢线 EMA，返回 { macd, signal, hist } */
export function macd(values: number[], fast: number, slow: number, signalPeriod: number): { macd: number[]; signal: number[]; hist: number[] } {
  const ef = ema(values, fast)
  const es = ema(values, slow)
  const macdLine = values.map((_, i) => (Number.isNaN(ef[i]) || Number.isNaN(es[i]) ? Number.NaN : ef[i] - es[i]))
  const valid = macdLine.map((v) => (Number.isNaN(v) ? 0 : v))
  const sig = ema(valid, signalPeriod)
  const hist = macdLine.map((v, i) => (Number.isNaN(v) || Number.isNaN(sig[i]) ? Number.NaN : v - sig[i]))
  return { macd: macdLine, signal: sig, hist }
}

/**
 * 真实波幅 True Range：max(H−L, |H−prevC|, |L−prevC|)。
 * 单看 H−L 会漏掉跳空缺口——而缺口恰恰是插针扫损最常发生的形态。
 */
export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const out: number[] = new Array(high.length).fill(Number.NaN)
  for (let i = 0; i < high.length; i++) {
    const prevClose = i > 0 ? close[i - 1] : close[i]
    out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose))
  }
  return out
}

/**
 * ATR（平均真实波幅）—— Wilder 平滑。
 *
 * 这是「抗噪宽止损」的尺子：止损距离 = k × ATR 而不是固定百分比，
 * 波动放大时止损自动放宽、波动收缩时自动收紧。
 * 用固定百分比止损在单边市必被扫，在死水市又浪费风险预算。
 */
export function atr(high: number[], low: number[], close: number[], period: number): number[] {
  const out: number[] = new Array(high.length).fill(Number.NaN)
  if (period <= 0 || high.length === 0) return out
  const tr = trueRange(high, low, close)

  let sum = 0
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      sum += tr[i]
      if (i === period - 1) out[i] = sum / period
    } else {
      // Wilder: ATR_i = (ATR_{i-1} × (n−1) + TR_i) / n
      const prev = out[i - 1]
      out[i] = Number.isNaN(prev) ? tr[i] : (prev * (period - 1) + tr[i]) / period
    }
  }
  return out
}

/**
 * ADX（平均趋向指数）—— Wilder 标准算法，返回 { adx, plusDI, minusDI }。
 *
 * 用途是「过滤无序震荡垃圾市」：ADX 低于阈值说明没有趋势，
 * 此时任何方向性策略的期望都是负的（手续费 + 假信号双杀）。
 * R20 官方基准是 1H ADX < 18 严禁开仓。
 */
export function adx(
  high: number[],
  low: number[],
  close: number[],
  period: number,
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = high.length
  const adxOut: number[] = new Array(n).fill(Number.NaN)
  const plusOut: number[] = new Array(n).fill(Number.NaN)
  const minusOut: number[] = new Array(n).fill(Number.NaN)
  if (period <= 0 || n <= period) return { adx: adxOut, plusDI: plusOut, minusDI: minusOut }

  const plusDM: number[] = new Array(n).fill(0)
  const minusDM: number[] = new Array(n).fill(0)
  const tr = trueRange(high, low, close)

  for (let i = 1; i < n; i++) {
    const upMove = high[i] - high[i - 1]
    const downMove = low[i - 1] - low[i]
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0
  }

  // Wilder 累加平滑（首值 = 前 period 项之和），后续为 累加 - 累加/n + 新值
  let trS = 0
  let plusS = 0
  let minusS = 0
  const dx: number[] = new Array(n).fill(Number.NaN)

  for (let i = 1; i < n; i++) {
    if (i <= period) {
      trS += tr[i]
      plusS += plusDM[i]
      minusS += minusDM[i]
    } else {
      trS = trS - trS / period + tr[i]
      plusS = plusS - plusS / period + plusDM[i]
      minusS = minusS - minusS / period + minusDM[i]
    }
    if (i >= period && trS > 0) {
      const pdi = (plusS / trS) * 100
      const mdi = (minusS / trS) * 100
      plusOut[i] = pdi
      minusOut[i] = mdi
      const denom = pdi + mdi
      dx[i] = denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : 0
    }
  }

  // ADX = 首个有效 DX 的均值，其后 Wilder 平滑
  let seedSum = 0
  let seedCount = 0
  let prevAdx = Number.NaN
  for (let i = period; i < n; i++) {
    if (Number.isNaN(dx[i])) continue
    if (Number.isNaN(prevAdx)) {
      seedSum += dx[i]
      seedCount += 1
      if (seedCount === period) {
        prevAdx = seedSum / period
        adxOut[i] = prevAdx
      }
    } else {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period
      adxOut[i] = prevAdx
    }
  }
  return { adx: adxOut, plusDI: plusOut, minusDI: minusOut }
}

export function rsi(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    const gain = Math.max(0, diff)
    const loss = Math.max(0, -diff)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    }
  }
  return out
}
