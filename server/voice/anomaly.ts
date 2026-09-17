/**
 * 盘面异动检测
 *
 * ── 判据为什么不能只看"涨跌幅超过 X%" ──────────────────────────────
 * 固定百分比阈值在两种市况下都会失效，而且失效方向相反：
 *   - **高波动期**：BTC 单日振幅 5% 时，1% 的波动每分钟都在发生，
 *     固定阈值会把播报淹掉 —— 秘书变成复读机，用户把它静音，
 *     于是真正的那次异动也听不见了。
 *   - **低波动期**：横盘时 0.4% 就已经是"今天最大的事"，固定阈值一声不响。
 *
 * 所以判据取**两者取或**：
 *   ① 绝对幅度（兜底，保证低波动期不漏）
 *   ② 相对 ATR 的倍数（自适应，保证高波动期不吵）
 * ATR 直接取 `marketRegime` 的 1H ATR —— 与止损几何用的是同一把尺子，
 * 不另立一套波动率口径（本项目最反复出现的失效就是"两套口径"）。
 *
 * ── 还要能报"尖峰回撤" ──────────────────────────────────────────────
 * 只看首尾价会漏掉**冲高回落**：一分钟插针 2% 又收回来，
 * 首尾净变化接近 0，而持仓刚被打掉止损。因此净变化与窗口内极差
 * 分开算，任一越界都算异动。
 */

export interface AnomalyConfig {
  /** 观察窗。 */
  windowSec: number
  /** 绝对幅度：净变化达到该值即算异动。 */
  mildMovePct: number
  strongMovePct: number
  /** 窗口内极差达到该值即算异动（抓插针）。 */
  rangePct: number
  /** 相对 ATR 的倍数门槛（自适应项）。 */
  atrMultiple: number
  /** 同一标的同方向的冷却，避免连续报。 */
  cooldownSec: number
  /** 判定所需最少样本数 —— 样本不足时不报，避免把"刚启动"误报成异动。 */
  minSamples: number
}

const DEFAULT_CONFIG: AnomalyConfig = {
  windowSec: 300,
  mildMovePct: 0.6,
  strongMovePct: 1.5,
  rangePct: 1.5,
  atrMultiple: 2.0,
  cooldownSec: 180,
  minSamples: 8,
}

export interface AnomalyHit {
  symbol: string
  ts: number
  direction: 'up' | 'down'
  /** 首尾净变化（%）。 */
  movePct: number
  /** 窗口内极差（%）。 */
  rangePct: number
  from: number
  to: number
  windowSec: number
  severity: 'strong' | 'mild'
  /** 触发原因是净变化还是极差；两者都命中时优先报净变化。 */
  trigger: 'net-move' | 'range' | 'atr-multiple'
  /** 相对 ATR 的倍数（ATR 不可得时为 undefined）。 */
  atrMultiple?: number
  atr?: number
}

type Tick = { ts: number; price: number }

const samples = new Map<string, Tick[]>()
let cfg: AnomalyConfig = { ...DEFAULT_CONFIG }
const lastHitAt = new Map<string, number>() // key = `${symbol}:${direction}`
let suppressedByCooldown = 0
let suppressedBySamples = 0
let detected = 0

/** ATR 供给：注入而非直接 import，方便烟测喂合成波动率，也让本模块不依赖网络。 */
type AtrProvider = (symbol: string) => number
let atrProvider: AtrProvider | null = null

export function configureAnomaly(patch?: Partial<AnomalyConfig>, atr?: AtrProvider | null): void {
  if (patch) cfg = { ...cfg, ...patch }
  if (atr !== undefined) atrProvider = atr
}

export function anomalyConfig(): AnomalyConfig {
  return { ...cfg }
}

function prune(symbol: string, now: number): Tick[] {
  const arr = samples.get(symbol) ?? []
  const cut = now - cfg.windowSec * 1000
  while (arr.length > 0 && arr[0].ts < cut) arr.shift()
  samples.set(symbol, arr)
  return arr
}

/**
 * 记录一个价格 tick，必要时返回一次异动。
 *
 * 注意 tick 是**秒级**的（`onPriceTick` 的调用频率），而窗口是分钟级，
 * 所以这里不做降采样 —— 插针恰恰发生在连续几个 tick 之间，
 * 降采样会把要抓的东西先过滤掉。
 */
export function observeTick(symbol: string, price: number, now = Date.now()): AnomalyHit | null {
  if (!Number.isFinite(price) || price <= 0) return null
  const arr = prune(symbol, now)
  arr.push({ ts: now, price })

  if (arr.length < cfg.minSamples) {
    suppressedBySamples += 1
    return null
  }

  const first = arr[0].price
  const last = arr[arr.length - 1].price
  let hi = -Infinity
  let lo = Infinity
  for (const t of arr) {
    if (t.price > hi) hi = t.price
    if (t.price < lo) lo = t.price
  }

  const netPct = (last / first - 1) * 100
  const rangePct = (hi / lo - 1) * 100
  const atr = atrProvider ? atrProvider(symbol) : Number.NaN
  const atrPct = Number.isFinite(atr) && atr > 0 ? (atr / last) * 100 : Number.NaN
  const atrMult = Number.isFinite(atrPct) && atrPct > 0 ? Math.abs(netPct) / atrPct : Number.NaN

  const strongByNet = Math.abs(netPct) >= cfg.strongMovePct
  const mildByNet = Math.abs(netPct) >= cfg.mildMovePct
  const byRange = rangePct >= cfg.rangePct
  const byAtr = Number.isFinite(atrMult) && atrMult >= cfg.atrMultiple

  if (!strongByNet && !mildByNet && !byRange && !byAtr) return null

  // 方向：净变化优先；净变化接近 0 而由极差触发时，用极值偏离更远的一侧
  let direction: 'up' | 'down'
  if (Math.abs(netPct) >= 0.05) {
    direction = netPct > 0 ? 'up' : 'down'
  } else {
    direction = hi / first - 1 >= 1 - lo / first ? 'up' : 'down'
  }

  const key = `${symbol}:${direction}`
  // 与 narrator 的去重同源：必须用 `has` 区分「从未报过」与「上次报过」。
  // 用 `?? 0` 会把缺失值当成"上次报于 epoch 0"，于是任何时间基准小于冷却窗的
  // 输入都会被静默吃掉 —— 生产时间戳大得看不出来，只有喂小时间戳的测试才会暴露。
  // 这个坑在本模块和 narrator 里各出现了一次。
  const prev = lastHitAt.get(key)
  if (prev !== undefined && now - prev < cfg.cooldownSec * 1000) {
    suppressedByCooldown += 1
    return null
  }
  lastHitAt.set(key, now)
  detected += 1

  const trigger: AnomalyHit['trigger'] = mildByNet || strongByNet ? 'net-move' : byRange ? 'range' : 'atr-multiple'
  const severity: AnomalyHit['severity'] = strongByNet || byAtr ? 'strong' : 'mild'

  return {
    symbol,
    ts: now,
    direction,
    movePct: Math.round(netPct * 100) / 100,
    rangePct: Math.round(rangePct * 100) / 100,
    from: first,
    to: last,
    windowSec: cfg.windowSec,
    severity,
    trigger,
    atrMultiple: Number.isFinite(atrMult) ? Math.round(atrMult * 100) / 100 : undefined,
    atr: Number.isFinite(atr) ? atr : undefined,
  }
}

export function anomalyCounters(): {
  detected: number
  suppressedByCooldown: number
  suppressedBySamples: number
  trackedSymbols: number
  config: AnomalyConfig
} {
  return {
    detected,
    suppressedByCooldown,
    suppressedBySamples,
    trackedSymbols: samples.size,
    config: { ...cfg },
  }
}

export function resetAnomaly(): void {
  samples.clear()
  lastHitAt.clear()
  cfg = { ...DEFAULT_CONFIG }
  suppressedByCooldown = 0
  suppressedBySamples = 0
  detected = 0
  atrProvider = null
}

/** 把一次异动渲染成口语化播报。 */
export function renderAnomaly(hit: AnomalyHit): string {
  const dir = hit.direction === 'up' ? '快速拉升' : '快速下挫'
  const pct = Math.abs(hit.movePct).toFixed(2)
  const strong = hit.severity === 'strong' ? '【强异动】' : ''
  const atrNote = hit.atrMultiple !== undefined ? `，约为 1 小时 ATR 的 ${hit.atrMultiple} 倍` : ''
  // 插针形态要单独点出来：用户看到的报价已经回来，但止损可能已经打掉了
  const spikeNote =
    hit.trigger !== 'net-move' && hit.rangePct > Math.abs(hit.movePct) * 2
      ? `（期间极差 ${hit.rangePct.toFixed(2)}%，疑似插针后回落，注意止损是否被打掉）`
      : ''
  return `${strong}${hit.symbol} 在 ${hit.windowSec} 秒内${dir} ${pct}%${atrNote}${spikeNote}`
}

export { DEFAULT_CONFIG as DEFAULT_ANOMALY_CONFIG }
export type { AtrProvider }
