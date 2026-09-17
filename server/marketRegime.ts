/**
 * 市场状态（高周期）—— 为拦截闸门与止损几何提供真实的多周期输入。
 *
 * ## 为什么不「把 1m K 线聚合当 4H 用」
 *
 * 一个诱人但错误的做法：手上有 1m K 线，直接每 240 根合成一根 4H。
 * 问题在于 autopilot 的 K 线缓冲上限是 3000 根 1m（≈50 小时），
 * 合成出来只有 12 根「4H」—— 用 12 根 K 线判断高周期趋势，
 * 得到的是噪声而不是结构，而拦截器会**真的**拿它去阻断开仓。
 * 一个基于伪高周期的拦截器，比没有拦截器更危险：它会给系统注入虚假的确定感。
 *
 * 所以这里走真实数据源：向 Binance 公开 API 直接取 4h / 1h K 线。
 * 该数据源在本项目里已被验证可用（行情层本来就用它，无需密钥）。
 *
 * 缓存策略：高周期结构不会分钟级变化，5 分钟 TTL 足够；
 * 取数失败时**保留上一次成功的值**而不是清空——宁可让拦截器基于略旧的真实结构，
 * 也不要让它因为一次网络抖动就失去判断依据（那会让风控时开时关）。
 */

import { adx as computeAdx, atr as computeAtr, ema } from '../src/engine/indicators.ts'
import type { MacroTrend } from './interceptors.ts'

const BINANCE_BASE = 'https://data-api.binance.vision/api/v3/klines'

export interface Ohlc {
  high: number[]
  low: number[]
  close: number[]
}

/** 高周期 K 线取数函数。可注入，见 `configureRegimeSource()`。 */
export type KlinesFetcher = (symbol: string, interval: string, limit: number) => Promise<Ohlc>

export interface RegimeSnapshot {
  symbol: string
  macroTrend: MacroTrend
  macroTrendSource: string
  /** 1H ATR —— 止损几何的尺子（R20 的 1.8~2.2x ATR 指的就是这个周期）。 */
  atr1h: number
  /** 4H ATR，备用参考。 */
  atr4h: number
  adx1h: number | undefined
  /** 近 24 根 1H 的最高价 = 头顶最近的阻力结构位。 */
  h1SwingHigh: number
  /** 近 24 根 1H 的最低价 = 脚下最近的支撑结构位。 */
  h1SwingLow: number
  h1Close: number
  h4Close: number
  updatedAt: number
  stale: boolean
  error?: string
}

const REGIME_TTL_MS = 5 * 60_000
const cache = new Map<string, RegimeSnapshot>()
const inflight = new Map<string, Promise<RegimeSnapshot>>()

let fetchImpl: KlinesFetcher = fetchKlines

/**
 * 注入高周期取数源（null 恢复真实 Binance）。
 *
 * ## 为什么必须有这个口子
 *
 * 默认走真实 API 意味着：**任何依赖本模块的门禁，其结果都由当天的真实行情决定**。
 * 实测事故：autopilot 冒烟长期为红，真因是当天 BTC 的 1H ADX 恰好是 13.3（震荡），
 * 于是震荡过滤器拦下了合成数据里的每一次开仓 —— 而合成数据本身是一条
 * 教科书级的单边上行。代码一行问题都没有，红灯却稳定复现。
 *
 * **一个结果由外部行情决定的门禁，不是门禁，是一个不可复现的随机数。**
 * 所以测试必须能把这一层换成确定性的数据，否则它验证的不是逻辑，
 * 而是「今天市场怎么样」。
 *
 * 注入时会清空缓存 —— 否则注入前抓到的真实快照会继续被 TTL 复用 5 分钟，
 * 表现为「注入明明生效了，但前几次调用还是老数据」。
 */
export function configureRegimeSource(fetcher: KlinesFetcher | null): void {
  fetchImpl = fetcher ?? fetchKlines
  cache.clear()
  inflight.clear()
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Ohlc> {
  const url = `${BINANCE_BASE}?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`klines ${interval} HTTP ${res.status}`)
  const rows = (await res.json()) as unknown[][]
  const high: number[] = []
  const low: number[] = []
  const close: number[] = []
  for (const r of rows) {
    high.push(Number(r[2]))
    low.push(Number(r[3]))
    close.push(Number(r[4]))
  }
  return { high, low, close }
}

/**
 * 由 4H K 线判定宏观趋势。
 *
 * 判据是「价格相对 4H EMA(20) 的位置 + EMA 自身斜率」的组合，而不是单看价格：
 *   - 只看价格会在 EMA 附近反复横跳（假信号）；
 *   - 加上斜率后，只有「价格在均线同侧 **且** 均线朝同方向走」才判为趋势，
 *     否则为 RANGE。这直接对应 V20 的「顺势铁律」语义。
 */
function classifyMacroTrend(h4: Ohlc): { trend: MacroTrend; reason: string } {
  const closes = h4.close
  if (closes.length < 25) return { trend: 'RANGE', reason: `4H 样本不足（${closes.length} 根）` }

  const ema20 = ema(closes, 20)
  const last = closes.length - 1
  const current = ema20[last]
  const prior = ema20[last - 6] // 6 根 4H = 24 小时，足够看出斜率方向
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return { trend: 'RANGE', reason: '4H EMA 未成形' }

  const price = closes[last]
  const slopePct = ((current - prior) / prior) * 100
  const aboveEma = price > current

  // 带宽阈值 0.35%：低于此视为均线走平，不构成趋势
  if (Math.abs(slopePct) < 0.35) {
    return { trend: 'RANGE', reason: `4H EMA20 斜率 ${slopePct.toFixed(2)}%（< 0.35% 视为走平）` }
  }
  if (slopePct > 0 && aboveEma) {
    return { trend: 'BULL', reason: `4H 价格高于 EMA20 且均线上行（斜率 +${slopePct.toFixed(2)}%/24h）` }
  }
  if (slopePct < 0 && !aboveEma) {
    return { trend: 'BEAR', reason: `4H 价格低于 EMA20 且均线下行（斜率 ${slopePct.toFixed(2)}%/24h）` }
  }
  return {
    trend: 'RANGE',
    reason: `4H 价格与均线方向背离（斜率 ${slopePct.toFixed(2)}%，价格${aboveEma ? '上' : '下'}方），视为区间`,
  }
}

function lastFinite(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i]
  }
  return 0
}

/**
 * 刷新并缓存市场状态。同一 symbol 的并发调用会合并为一次网络请求
 * （autopilot 每根 K 线都会问一次，不去重会打出无谓的请求量）。
 */
export async function refreshRegime(symbol: string, atrPeriod: number): Promise<RegimeSnapshot> {
  const key = symbol.toUpperCase()
  const cachedSnapshot = cache.get(key)
  const now = Date.now()
  if (cachedSnapshot && now - cachedSnapshot.updatedAt < REGIME_TTL_MS) return cachedSnapshot

  const pending = inflight.get(key)
  if (pending) return pending

  const task = (async (): Promise<RegimeSnapshot> => {
    try {
      const [h1, h4] = await Promise.all([fetchImpl(key, '1h', 120), fetchImpl(key, '4h', 80)])
      const { trend, reason } = classifyMacroTrend(h4)
      const atr1h = lastFinite(computeAtr(h1.high, h1.low, h1.close, atrPeriod))
      const atr4h = lastFinite(computeAtr(h4.high, h4.low, h4.close, atrPeriod))
      const adx1h = lastFinite(computeAdx(h1.high, h1.low, h1.close, 14).adx)

      const swingWindow = 24
      const h1SwingHigh = Math.max(...h1.high.slice(-swingWindow))
      const h1SwingLow = Math.min(...h1.low.slice(-swingWindow))

      const snapshot: RegimeSnapshot = {
        symbol: key,
        macroTrend: trend,
        macroTrendSource: `4H 结构（${reason}）`,
        atr1h,
        atr4h,
        adx1h: adx1h > 0 ? adx1h : undefined,
        h1SwingHigh: Number.isFinite(h1SwingHigh) ? h1SwingHigh : 0,
        h1SwingLow: Number.isFinite(h1SwingLow) ? h1SwingLow : 0,
        h1Close: h1.close[h1.close.length - 1] ?? 0,
        h4Close: h4.close[h4.close.length - 1] ?? 0,
        updatedAt: Date.now(),
        stale: false,
      }
      cache.set(key, snapshot)
      return snapshot
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 取数失败：保留上次成功的结构判定，只标记 stale。
      // 清空成 RANGE 会让宏观拦截器静默失效——那是最坏的结果。
      const fallback: RegimeSnapshot = cachedSnapshot
        ? { ...cachedSnapshot, stale: true, error: msg }
          : {
            symbol: key,
            macroTrend: 'RANGE',
            macroTrendSource: `4H 结构不可用（${msg}），趋势过滤降级为区间（不构成顺势拦截依据）`,
            atr1h: 0,
            atr4h: 0,
            adx1h: undefined,
            h1SwingHigh: 0,
            h1SwingLow: 0,
            h1Close: 0,
            h4Close: 0,
            updatedAt: Date.now(),
            stale: true,
            error: msg,
          }
      cache.set(key, fallback)
      return fallback
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

export function getRegime(symbol: string): RegimeSnapshot | undefined {
  return cache.get(symbol.toUpperCase())
}

/**
 * 取用于止损几何的 ATR。
 *
 * 优先用 **1H ATR**（R20 明确以 1H 为尺），因为「抗噪」的本质是
 * 让止损活过更高一级别的波动；用交易周期的 ATR 会把止损拖回噪声里。
 * 高周期不可用时退化为传入的回退值（调用方用交易周期 ATR 兜底）。
 */
export function stopAtrFor(symbol: string, fallbackAtr: number): { atr: number; source: string } {
  const snapshot = cache.get(symbol.toUpperCase())
  if (snapshot && snapshot.atr1h > 0 && Number.isFinite(snapshot.atr1h)) {
    return { atr: snapshot.atr1h, source: snapshot.stale ? '1H ATR（缓存，取数失败）' : '1H ATR' }
  }
  return { atr: fallbackAtr, source: '交易周期 ATR（1H 不可用，回退）' }
}

export interface StructureTarget {
  price: number
  basis: string
}

/**
 * 由**高周期结构位**推导止盈目标（而非按 R 倍数硬凑）。
 *
 * ## 为什么必须用结构位，而不是「入场价 + 2R」
 *
 * 如果用 `target = entry + MIN_RR × 止损距离` 去构造报价，
 * 那么盈亏比门禁永远算出恰好等于底线的 R:R —— 门禁就成了恒真式，白设。
 *
 * 更关键的是它掩盖了真正该拒绝的交易：**当头顶 0.4% 就是阻力、而活过噪声的止损需要 2% 时，
 * 这笔交易在结构上根本无法支付自己的风险**。按 R 倍数硬凑目标，
 * 等于假装前面那道墙不存在，然后在下单后一次次被墙弹回来止损。
 *
 * 所以这里取 1H 结构位：
 *   - 价格尚在区间内 → 目标 = 头顶最近阻力（多头）/ 脚下最近支撑（空头）；
 *   - 价格已突破区间（创新高/新低）→ 用**等距测幅**外推（区间高度 × 测幅系数），
 *     这是突破交易的标准目标算法，而不是拍脑袋。
 *
 * 目标太近导致 R:R 不达标时，门禁会如实拒绝——那正是它存在的意义。
 */
export function deriveStructureTarget(
  side: 'long' | 'short',
  regime: RegimeSnapshot | undefined,
  price: number,
  measuredMoveFactor = 0.5,
): StructureTarget {
  if (!regime || !(regime.h1SwingHigh > 0) || !(regime.h1SwingLow > 0) || regime.h1SwingHigh <= regime.h1SwingLow) {
    return { price, basis: '高周期结构位不可用，无法推导有效目标' }
  }

  const rangeHeight = regime.h1SwingHigh - regime.h1SwingLow
  const tolerance = price * 0.001 // 0.1% 容差，避免「贴着新高」被误判为已突破

  if (side === 'long') {
    const resistance = regime.h1SwingHigh
    if (resistance > price + tolerance) {
      return { price: resistance, basis: `24h 结构阻力 ${resistance.toFixed(2)}` }
    }
    const projected = price + rangeHeight * measuredMoveFactor
    return { price: projected, basis: `已突破 24h 高点，等距测幅目标 ${projected.toFixed(2)}（区间高度 ${rangeHeight.toFixed(2)} × ${measuredMoveFactor}）` }
  }

  const support = regime.h1SwingLow
  if (support < price - tolerance) {
    return { price: support, basis: `24h 结构支撑 ${support.toFixed(2)}` }
  }
  const projected = price - rangeHeight * measuredMoveFactor
  return { price: projected, basis: `已跌破 24h 低点，等距测幅目标 ${projected.toFixed(2)}（区间高度 ${rangeHeight.toFixed(2)} × ${measuredMoveFactor}）` }
}
