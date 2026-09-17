/**
 * 报价几何与盈亏比校验 —— 无状态、确定性、可离线单测。
 *
 * 内化自 R20 Quantum Trader 的 `scripts/order_risk.py`。
 *
 * 为什么把「几何」单独拎出来校验：
 *   交易系统里最危险的一类错误不是「算错」，而是**几何自相矛盾却仍然下单**——
 *   例如多头单的止损高于入场价（一个永远不会触发的止损），
 *   或者止盈低于入场价（开仓即注定亏损）。
 *   这类错误在数学模型上「有解」，在下单语义上却是垃圾。
 *   所以必须先验证 s < e < t 这种方向性关系，再谈赔率。
 *
 * 三条不可协商的检查（任一不过即拒绝，Fail-Closed）：
 *   ① 三个价格都是有限正数（NaN / Infinity 直接拒绝，不允许「容错」）；
 *   ② 几何关系符合方向语义；
 *   ③ R:R ≥ 全局硬底线（默认 2.0）。
 */

import { MIN_RISK_REWARD_RATIO } from './riskConstants.ts'

export interface QuoteGeometry {
  action: 'BUY_LONG' | 'SELL_SHORT'
  entry: number
  takeProfit: number
  stopLoss: number
}

export type GeometryCheck =
  | { valid: true; risk: number; reward: number; rr: number }
  | { valid: false; reason: string; rr: number }

/**
 * 校验开仓报价的几何合法性与盈亏比。
 * 拒绝理由刻意写成中文完整句——它会直接显示在决策流里给操作者看，
 * 「R:R 不足」这种缩写对复盘没有帮助，「盈亏比不足 2.0（当前 1.42:1）」才能定位问题。
 */
export function validateQuoteGeometry(q: QuoteGeometry): GeometryCheck {
  const { entry: e, takeProfit: t, stopLoss: s } = q

  if (![e, t, s].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { valid: false, reason: '核心风控拦截：入场价、止盈价、止损价必须是有限数值（NaN / Inf 拒绝）', rr: 0 }
  }
  if (!(e > 0) || !(t > 0) || !(s > 0)) {
    return { valid: false, reason: '核心风控拦截：入场价、止盈价、止损价必须大于 0', rr: 0 }
  }

  let risk: number
  let reward: number
  if (q.action === 'BUY_LONG') {
    if (!(s < e && e < t)) {
      return { valid: false, reason: `核心风控拦截：买多几何不合法（须 止损 ${s} < 限价 ${e} < 止盈 ${t}）`, rr: 0 }
    }
    risk = e - s
    reward = t - e
  } else {
    if (!(t < e && e < s)) {
      return { valid: false, reason: `核心风控拦截：卖空几何不合法（须 止盈 ${t} < 限价 ${e} < 止损 ${s}）`, rr: 0 }
    }
    risk = s - e
    reward = e - t
  }

  if (!(risk > 0)) return { valid: false, reason: '核心风控拦截：单笔承担风险必须大于 0', rr: 0 }

  const rr = reward / risk
  if (!Number.isFinite(rr)) return { valid: false, reason: '核心风控拦截：盈亏比计算异常', rr: 0 }

  if (rr < MIN_RISK_REWARD_RATIO) {
    return {
      valid: false,
      reason: `核心风控拦截：盈亏比不足 ${MIN_RISK_REWARD_RATIO.toFixed(1)}（当前 R:R = ${rr.toFixed(2)}:1，底线 ${MIN_RISK_REWARD_RATIO.toFixed(1)}:1）`,
      rr,
    }
  }

  return { valid: true, risk, reward, rr }
}
