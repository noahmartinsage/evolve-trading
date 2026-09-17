export type SurfFlagType = 'SELF_TRADE' | 'ORDER_CHURN' | 'SMALL_NOTIONAL_BURST'

export interface SurfFlag {
  ts: number
  type: SurfFlagType
  detail: string
}

interface FillEvent {
  ts: number
  side: 'buy' | 'sell'
  price: number
  qty: number
  clientOrderId: string
}

export interface SurveillanceConfig {
  selfTradeWindowSec: number
  selfTradePriceBps: number
  churnWindowSec: number
  churnCancelRatio: number
  churnMinSubmits: number
  /**
   * ── 小额定频（value/count 解耦）──────────────────────────────────
   *
   * 内化自 2026-09-15 日报里 TRM Labs 对 x402 商业流的实测结论：
   * **价值与笔数会脱钩** —— 这些流的单笔金额低于人类支付的「金额阈值」、
   * 而笔数高于人类支付的「笔数阈值」，于是按人类尺度设计的风控**两头都兜不住**。
   *
   * 这条对 EVOLVE 是直接的自我检查，因为我们现有的门禁几乎全是**金额型**的：
   * `maxNotionalPerOrder`(500) / `MIN_VIABLE_NOTIONAL_CEX_USDT`(10) /
   * `MIN_VIABLE_NOTIONAL_USDT`(200, DEX gas 地板) / `RISK_MAX_NOTIONAL_USD`(500)。
   * 一笔 $500 的订单会被逐笔上限拦住；但 **20 笔各 $20 的订单每一笔都合法**，
   * 合计 $400 还不到一笔正常单 —— 没有任何金额型规则会响。
   * 这正是「解耦」的盲区，只能靠笔数维度补。
   *
   * 阈值取值的依据（不是拍脑袋，是对齐既有常量）：
   *   - `burstMinOrders = 20` 与 `churnMinSubmits` 同值 —— 同一个窗口里
   *     「多少笔算异常频次」在本模块内只应有一个口径。
   *   - `burstMaxTotalUsdt = 500` 取 `maxNotionalPerOrder` 的默认值 ——
   *     含义是「这么多次下单，合计起来还不如一笔正常单」。
   *   - `burstMaxNotionalUsdt = 50` 取该上限的 1/10 —— 单笔远低于任何逐笔闸门。
   */
  burstWindowSec: number
  burstMinOrders: number
  burstMaxNotionalUsdt: number
  burstMaxTotalUsdt: number
}

const DEFAULT_CONFIG: SurveillanceConfig = {
  selfTradeWindowSec: 60,
  selfTradePriceBps: 5,
  churnWindowSec: 300,
  churnCancelRatio: 0.8,
  churnMinSubmits: 20,
  burstWindowSec: 300,
  burstMinOrders: 20,
  burstMaxNotionalUsdt: 50,
  burstMaxTotalUsdt: 500,
}

let cfg: SurveillanceConfig = { ...DEFAULT_CONFIG }

const fills: FillEvent[] = []
const flags: SurfFlag[] = []
const window: { ts: number; submitted: boolean; cancelled: boolean }[] = []
/** 已提交订单的（时间，名义额）。小额定频判定只依赖这两个量。 */
const orderNotionals: { ts: number; notional: number }[] = []
let flaggedSelfTrades = 0
let flaggedChurn = 0
let flaggedSmallNotionalBursts = 0
/** 上一次「小额定频」上报时间 —— 同一段爆发只报一次，避免每来一笔就刷一条。 */
let lastBurstFlagAt = 0

function prune(now: number): void {
  const fillCut = now - cfg.selfTradeWindowSec * 1000
  while (fills.length > 0 && fills[0].ts < fillCut) fills.shift()
  const winCut = now - cfg.churnWindowSec * 1000
  while (window.length > 0 && window[0].ts < winCut) window.shift()
  // 名义额窗口独立裁剪：它用的是 burstWindowSec，与 churnWindowSec 可能不同宽。
  const burstCut = now - cfg.burstWindowSec * 1000
  while (orderNotionals.length > 0 && orderNotionals[0].ts < burstCut) orderNotionals.shift()
  if (flags.length > 500) flags.splice(0, flags.length - 500)
}

function flag(type: SurfFlagType, detail: string): void {
  flags.push({ ts: Date.now(), type, detail })
  if (type === 'SELF_TRADE') flaggedSelfTrades += 1
  else if (type === 'ORDER_CHURN') flaggedChurn += 1
  else flaggedSmallNotionalBursts += 1
}

/** 每笔成交回报后调用：检测同账户对向成交（self-trade / wash-trade 形态） */
export function onFill(f: { ts: number; side: 'buy' | 'sell'; price: number; qty: number; clientOrderId: string }): void {
  const opposite = f.side === 'buy' ? 'sell' : 'buy'
  for (const prev of fills) {
    if (prev.side !== opposite) continue
    const bps = Math.abs(f.price - prev.price) / Math.max(prev.price, 1e-9) * 10_000
    if (bps <= cfg.selfTradePriceBps) {
      flag('SELF_TRADE', `own ${prev.side}@${prev.price} (${prev.clientOrderId}) crossed by ${f.side}@${f.price} (${f.clientOrderId}) within ${cfg.selfTradePriceBps}bps`)
      break
    }
  }
  fills.push({ ts: f.ts, side: f.side, price: f.price, qty: f.qty, clientOrderId: f.clientOrderId })
  prune(f.ts)
}

/**
 * 订单活动计数：submit 成功 +1；cancel 成功 +1。
 *
 * @param notionalUsdt 本次提交的名义额（USDT）。可选 —— 撤单路径没有名义额，
 *   传 `undefined` 就只参与 churn 判定。**不传不等于「金额为 0」**，
 *   所以下面的解耦规则只在真的拿到了有限正数时才计分，避免把「没数据」
 *   当成「小额」而误报。
 */
export function onOrderActivity(now: number, submitted: boolean, cancelled: boolean, notionalUsdt?: number): void {
  window.push({ ts: now, submitted, cancelled })
  prune(now)
  let submits = 0
  let cancels = 0
  for (const w of window) {
    submits += w.submitted ? 1 : 0
    cancels += w.cancelled ? 1 : 0
  }
  if (submits >= cfg.churnMinSubmits && cancels / submits >= cfg.churnCancelRatio && flaggedChurn === 0) {
    flag('ORDER_CHURN', `${cancels}/${submits} cancel ratio in ${cfg.churnWindowSec}s window`)
  }

  // ── 小额定频（value/count 解耦）──────────────────────────────────
  // 成交笔数很高、但总额很小 —— 落到金额型门禁的盲区里（配置注释里有推导）。
  if (submitted && typeof notionalUsdt === 'number' && Number.isFinite(notionalUsdt) && notionalUsdt > 0) {
    orderNotionals.push({ ts: now, notional: notionalUsdt })
    prune(now)
    const total = orderNotionals.reduce((s, o) => s + o.notional, 0)
    const biggest = orderNotionals.reduce((m, o) => Math.max(m, o.notional), 0)
    const decoupled =
      orderNotionals.length >= cfg.burstMinOrders &&
      biggest <= cfg.burstMaxNotionalUsdt &&
      total <= cfg.burstMaxTotalUsdt
    if (decoupled && now - lastBurstFlagAt >= cfg.burstWindowSec * 1000) {
      lastBurstFlagAt = now
      flag(
        'SMALL_NOTIONAL_BURST',
        `${orderNotionals.length} 笔 / 合计 $${total.toFixed(2)} / 单笔最大 $${biggest.toFixed(2)} @${cfg.burstWindowSec}s —— ` +
          '笔数与金额解耦：每一笔都远低于逐笔金额闸门，合计又不到一笔正常单，金额型风控两头都看不见',
      )
    }
  }
}

export function setConfig(patch: Partial<SurveillanceConfig>): void {
  cfg = { ...cfg, ...patch }
}

export function getConfig(): SurveillanceConfig {
  return { ...cfg }
}

export function surveillanceSnapshot(): {
  config: SurveillanceConfig
  counters: {
    flaggedSelfTrades: number
    flaggedChurn: number
    flaggedSmallNotionalBursts: number
    trackedFills: number
    /** 小额定频窗口内的下单笔数与合计名义额 —— 让「解耦」本身可被观察，而不是只看到一个已经报警的结论。 */
    trackedOrders: number
    trackedNotionalUsdt: number
  }
  recentFlags: SurfFlag[]
} {
  const notional = orderNotionals.reduce((s, o) => s + o.notional, 0)
  return {
    config: { ...cfg },
    counters: {
      flaggedSelfTrades,
      flaggedChurn,
      flaggedSmallNotionalBursts,
      trackedFills: fills.length,
      trackedOrders: orderNotionals.length,
      trackedNotionalUsdt: Math.round(notional * 100) / 100,
    },
    recentFlags: flags.slice(-50),
  }
}

export function resetSurveillance(): void {
  fills.length = 0
  flags.length = 0
  window.length = 0
  orderNotionals.length = 0
  flaggedSelfTrades = 0
  flaggedChurn = 0
  flaggedSmallNotionalBursts = 0
  lastBurstFlagAt = 0
  cfg = { ...DEFAULT_CONFIG }
}
