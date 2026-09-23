/**
 * 派生序列缓存 —— 把回测里"每根 bar 重算全长指标"的 O(n²) 变成 O(n)。
 *
 * ══ 为什么必须有这个模块 ═══════════════════════════════════════════════
 * 2026-09-18 把真实历史从 2,880 根扩到 35,040 根（12 个月）后实测：
 *
 *   | bar 数  | 单次回测 | 每根成本 |
 *   |---------|----------|----------|
 *   |   2,880 |   400 ms | 0.139 ms |
 *   |  35,040 | 97,562 ms | 2.784 ms |
 *
 * bar 数涨 **12.2 倍**，耗时涨 **244 倍** —— 这是 O(n²)，不是"数据多了当然慢"。
 * 后果不是"慢一点"：`returnMatrix` 要 20 次全长回测 ⇒ 单是它就要 **32 分钟**，
 * 而编排层启动预热带 120 秒健康预算 ⇒ **整个栈会启动失败**。
 * 也就是说这次扩容会把系统从"能跑"直接推成"起不来"。
 *
 * 根因有三处，都是同一个反模式：**每根 bar 重扫一遍随 bar 数增长的结构**。
 *   ① `strategies.ts` 每个 `decide()` 里 `ctx.candles.map(c => c.c)` 重建全长
 *      收盘价数组，并重算全长 SMA/EMA/RSI/MACD。`decide` 每根 bar 调一次
 *      ⇒ 700,800 次 × 35,040 ≈ **246 亿次运算**（最大头）。
 *   ② `backtest.ts` 每根 bar 都 `engine.fills.filter(f => f.bar === i)`。
 *   ③ `matching.ts` 每根 bar 都 `this.orders.filter(...)` 找活动订单。
 *
 * 本模块修 ①。②③ 在同一轮里各自换成游标 / 活动表。
 *
 * ══ 为什么不直接在策略里算一次存起来 ═══════════════════════════════════
 * 因为"算一次"的边界不由策略决定，而由**调用方**决定：
 * `walkForward` 每折都 `candles.slice()` 造一个新数组，
 * `returnMatrix` 又拿全长数组跑 20 个候选。
 * 谁先调、调几次都不确定，所以缓存必须以**数据本身**为键。
 *
 * ══ 为什么键是"数组身份 + 指纹"而不是值哈希 ═══════════════════════════
 * 值哈希是 O(n)，每次调用都算一遍等于没优化。
 * 数组身份（WeakMap）是 O(1)，且天然按生命周期回收 —— 折内切片用完即释放。
 * 但只认身份会带来**读路径静默陈旧**这一族缺陷（判据 11）：
 * 若有人对同一个数组就地改写了内容，缓存会继续供应旧序列，
 * 而且算出来的结果"看着完全正常"。
 * 所以命中时额外核对 `length / 首根 t / 末根 t` 这一组 O(1) 指纹，
 * 对不上就重建。它抓不住"中间某根被改"，但能抓住追加、截断、
 * 换区间这三类真实会发生的操作，成本是三次比较。
 */

import type { Candle } from './types.ts'

interface Entry {
  /** O(1) 指纹：数组长度与首末时间戳。用于识别"同一数组被就地改动"。 */
  fp: string
  value: unknown
}

const store = new WeakMap<readonly Candle[], Map<string, Entry>>()

function fingerprint(candles: readonly Candle[]): string {
  // 只取长度与首末 t：O(1)。刻意**不做**内容哈希 —— 那会让缓存失去意义。
  if (candles.length === 0) return '0'
  return `${candles.length}|${candles[0].t}|${candles[candles.length - 1].t}`
}

/** 缓存命中/重建的计数，供烟测断言"真的复用了"而不是"碰巧快"。 */
const stats = { hit: 0, miss: 0, stale: 0 }

/**
 * 取（或构建）由 `candles` 派生出来的一份值。
 *
 * @param key   同一数组内区分不同派生量的键，需自带参数（如 `sma:20`）。
 * @param build 真正构建的闭包，只在未命中或指纹不符时执行。
 */
export function memoDerived<T>(candles: readonly Candle[], key: string, build: () => T): T {
  let inner = store.get(candles)
  if (!inner) {
    inner = new Map()
    store.set(candles, inner)
  }
  const fp = fingerprint(candles)
  const hit = inner.get(key)
  if (hit && hit.fp === fp) {
    stats.hit += 1
    return hit.value as T
  }
  if (hit) stats.stale += 1
  else stats.miss += 1
  const value = build()
  inner.set(key, { fp, value })
  return value
}

/** 收盘价序列。所有指标的同源输入。 */
export function closesOf(candles: readonly Candle[]): number[] {
  return memoDerived(candles, 'closes', () => candles.map((c) => c.c))
}

/**
 * 指标序列。`key` 必须唯一确定 `build` 的结果
 * （同一族不同参数不能共用一个键，否则会"拿 A 参数的指标算 B 参数"）。
 */
export function seriesOf(candles: readonly Candle[], key: string, build: (closes: number[]) => number[]): number[] {
  return memoDerived(candles, key, () => build(closesOf(candles)))
}

export interface SeriesCacheStats {
  hit: number
  miss: number
  /** 命中但指纹不符 = 同一数组被就地改动过。**非 0 说明调用方违反"数组不可变"约定。** */
  stale: number
}

export function seriesCacheStats(): SeriesCacheStats {
  return { ...stats }
}

/** 仅供测试：把计数清零，便于断言"这一段真的产生了命中"。 */
export function resetSeriesCacheStats(): void {
  stats.hit = 0
  stats.miss = 0
  stats.stale = 0
}
