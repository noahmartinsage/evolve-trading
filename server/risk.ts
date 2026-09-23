import { LEVERAGE_HARD_CEILING, SPOT_MAX_LEVERAGE } from './riskConstants.ts'
import type { OrchState, RiskConfig } from './types.ts'

export interface OrderIntentInput {
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  /**
   * 数量，**始终以基础币计价**（如 0.01 BTC），不是合约张数。
   *
   * 这个约定必须在本层就钉死：SWAP 在交易所侧的 `sz` 单位是「张」，
   * 换算只在 venue 适配器内做（见 `okxSwapSpec.ts`）。
   * 若把张数一路透传上来，风控层用 `price × qty` 算出的名义本金
   * 与实际下单规模会相差 ctVal 倍（BTC 合约是 100 倍），
   * 而闸门照常放行 —— 风控校验的数和真正成交的数成了两个数。
   */
  qty: number
  leverage?: number
  /** 品种形态：缺省 SPOT；SWAP 才存在 >10x 的杠杆。 */
  instType?: 'SPOT' | 'SWAP'
  /** 合约结算方式（仅 SWAP 有意义）：linear=U 本位，inverse=币本位。 */
  settle?: 'linear' | 'inverse'
  /**
   * 止盈 / 止损 —— **绝对价**。
   *
   * ★ 这两个字段原先不存在，而「不存在」的表现不是报错：`parseProtection`
   *   解析对了、`describeContractOrder` 念回了、`VOICE_COMMAND` 记下了，
   *   然后 `submitToBroker` 只传 5 个字段 —— 下一张**裸单**。
   *   用户以为设了保护、实际在裸跑（2026-08-22 实测确认）。
   *
   * ★ 为什么是价不是比例：见 `protection.ts`。比例会随标记价漂移，
   *   用户在 86000 说的"止损 1%"指的是 85140 这个价位。
   */
  takeProfit?: number
  stopLoss?: number
}

export type RiskDecision = { ok: true; notional: number } | { ok: false; reason: string }

/**
 * 下单前风控。
 *
 * ★★ `markPrice` 是 `number | null`，`null` = **没有真实报价**（见 `markPriceOf`）。
 *   2026-09-22 修：这里原来是 `markPrice: number`，而调用方传的是 `?? 0` 的结果。
 *   于是市价单的 `refPrice = 0` ⇒ `notional = 0` ⇒ 下面那道
 *   `NOTIONAL_EXCEEDS_LIMIT` **永远不触发** —— 一道上限被静默拆掉。
 *   ⇒ 现在**拿不到参考价就直接拒**（fail-closed），拒的理由要说出"是拿不到报价"，
 *     而不是伪装成"名义额没超"。这两件事指向的动作完全不同（判据 C5）：
 *     前者去查行情通道，后者去改资金帽。
 */
export function preTradeCheck(state: OrchState, intent: OrderIntentInput, markPrice: number | null): RiskDecision {
  if (state.killswitch) return { ok: false, reason: 'KILLSWITCH_ACTIVE' }
  if (!intent.clientOrderId) return { ok: false, reason: 'MISSING_CLIENT_ORDER_ID' }
  if (!Number.isFinite(intent.qty) || intent.qty <= 0) return { ok: false, reason: 'INVALID_QTY' }
  if (intent.type === 'limit' && !(Number.isFinite(intent.price) && (intent.price ?? 0) > 0)) {
    return { ok: false, reason: 'LIMIT_REQUIRES_PRICE' }
  }

  const refPrice = intent.type === 'limit' ? (intent.price as number) : markPrice
  if (refPrice === null || !Number.isFinite(refPrice) || refPrice <= 0) {
    return {
      ok: false,
      reason:
        `NO_REFERENCE_PRICE（${intent.symbol} 还没有真实报价，算不出名义额）` +
        `—— 不是"名义额没超限"，是这道上限**这次没能被检查**`,
    }
  }

  // ── 参数配伍检查（必须早于规模检查）─────────────────────────────
  // 「高杠杆」与「现货」各自合法、组合非法。若不在此拦下，场所会用
  // 「保证金不足」这类间接理由拒单，把排查引向余额而不是品种形态。
  const lev = Number.isFinite(intent.leverage) && (intent.leverage ?? 0) > 0 ? (intent.leverage as number) : 1
  if (intent.instType !== 'SWAP' && lev > SPOT_MAX_LEVERAGE) {
    return {
      ok: false,
      reason: `LEVERAGE_REQUIRES_SWAP (${lev}x > 现货杠杆上限 ${SPOT_MAX_LEVERAGE}x；请设 instType='SWAP')`,
    }
  }
  if (lev > LEVERAGE_HARD_CEILING) {
    return { ok: false, reason: `LEVERAGE_ABOVE_HARD_CEILING (${lev}x > ${LEVERAGE_HARD_CEILING}x)` }
  }

  const notional = refPrice * intent.qty
  if (notional > state.risk.maxNotionalPerOrder) {
    return { ok: false, reason: `NOTIONAL_EXCEEDS_LIMIT (${notional.toFixed(0)} > ${state.risk.maxNotionalPerOrder})` }
  }

  if (markPrice !== null && markPrice > 0 && Number.isFinite(refPrice)) {
    const devBps = Math.abs(refPrice - markPrice) / markPrice * 10_000
    if (devBps > state.risk.priceDeviationBps) {
      return { ok: false, reason: `PRICE_DEVIATION_TOO_WIDE (${devBps.toFixed(0)}bps)` }
    }
  }

  // 熔断检查先于频控：频控不能掩盖爆仓风险
  const equity = currentEquity(state)
  const ddPct = ((state.peakEquity - equity) / state.peakEquity) * 100
  if (ddPct >= state.risk.maxDrawdownPct) {
    state.killswitch = true
    return { ok: false, reason: `DRAWDOWN_BREAKER (${ddPct.toFixed(1)}% >= ${state.risk.maxDrawdownPct}%) · KILLSWITCH ENGAGED` }
  }

  const now = Date.now()
  state.submitTimestamps = state.submitTimestamps.filter((t) => now - t < 60_000)
  if (state.submitTimestamps.length >= state.risk.maxOrdersPerMinute) {
    return { ok: false, reason: 'ORDER_RATE_EXCEEDED' }
  }

  return { ok: true, notional }
}

export function currentEquity(state: OrchState): number {
  let eq = state.balanceUSDC
  for (const [symbol, pos] of state.positions) {
    const px = state.lastPrice.get(symbol)
    if (px) eq += pos.qty * px
  }
  return eq
}

export function updateRiskConfig(state: OrchState, patch: Partial<RiskConfig>): void {
  state.risk = { ...state.risk, ...patch }
}
