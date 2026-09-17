/**
 * Maker-Checker 独立复核 —— 把「验证」从加分项变成第一公民。
 *
 * 内化自 2026-09-14 日报第 ② 条（AI Coding 竞争重心上移到验证与治理）：
 *   「验证闭环决定你能放多少自主权给 agent」；OpenAI Harness Engineering 的
 *   实证是 3 名工程师 + 智能体交付 100 万行代码，支撑它成立的不是模型更强，
 *   而是**每一份产出都有一个独立于作者的复核**。
 *   落到交易上，这条对应本项目已经吃过的两次亏：
 *     · 合理误购 —— 每一步都"有理由"，合起来却是一笔不该做的交易
 *     · LEDGER_MISMATCH —— 本地记的规模与场所实际成交的规模是两个数
 *
 * ── 与「再检查一遍」的本质区别：上下文隔离 ──────────────────────────
 * 复核若能看到生成者的推理链，就必然被它的叙事锚定（每一步都有理由 ⇒ 整体显得合理）。
 * 所以本模块的输入结构**在类型层面**就只接受：
 *   ① thesis   —— 需求侧：策略想做什么、凭的是什么（人类可读的理由）
 *   ② artifact —— 产物侧：真正要发出去的订单字段
 *   ③ claims   —— 生成者**声称**的量（不采信，只用于比对）
 *   ④ context  —— 复核者**自己取**的客观事实（权益、市价、冻结 ATR）
 * **没有**任何字段可以承载生成者的推算过程 —— 这不是约定，是签名强制。
 *
 * ── 复核方式：重新推导，而不是读结论 ────────────────────────────────
 * 复核者对同一批原始输入**独立重算**：止损几何、按风险预算反推的数量、
 * 名义本金、保证金、强平安全比、盈亏比。任何一项与声称值不一致即判定 disagree。
 * 这样做的意义在于：生成者算错时，它的"结论"是自洽的（错得内部一致），
 * 只有从原始输入重算才能发现。**读结论的复核等于没有复核。**
 *
 * ── 缺上下文时拒绝，而不是放行 ──────────────────────────────────────
 * `insufficient_context` 是拒绝。理由是：如果缺数据能换来放行，
 * 那么"让复核拿不到数据"就成了绕过复核的最短路径。
 */

import {
  ATR_STOP_MULT_MIN,
  LEVERAGE_HARD_CEILING,
  LIQUIDATION_SAFETY_MULT,
  MAX_LEVERAGE,
  MIN_RISK_REWARD_RATIO,
  SPOT_MAX_LEVERAGE,
  riskBudgetPerTrade,
} from './riskConstants.ts'
import {
  assertStopBeforeLiquidation,
  marginRequired,
  sizePositionFromRisk,
} from './positionGuard.ts'
import { validateQuoteGeometry } from './orderRisk.ts'
import { appendEvent } from './ledger.ts'

export type VerdictStatus = 'agree' | 'disagree' | 'insufficient_context'

/** 需求侧：策略想做什么，以及凭什么。刻意只有人类可读的理由，没有推算过程。 */
export interface OrderThesis {
  strategyId: string
  symbol: string
  side: 'long' | 'short'
  rationale: string
}

/** 产物侧：真正要发出去的订单字段。 */
export interface OrderArtifact {
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  /** 基础币数量（SWAP 亦然 —— 张数换算在适配器内完成）。 */
  qty: number
  leverage?: number
  instType?: 'SPOT' | 'SWAP'
}

/** 生成者声称的量。复核者不采信，仅用于比对。 */
export interface MakerClaims {
  entryPrice: number
  stopPrice: number
  targetPrice: number
  riskAmountUsd: number
  notionalUsd: number
  marginUsd: number
  rrRatio: number
}

/** 复核者自行取得的客观事实。 */
export interface CheckerContext {
  equity: number
  /** 决策时刻的市价。市价单的入场价必须来自这里，而不是生成者的声称值。 */
  markPrice: number
  /** 决策时刻冻结的 ATR。 */
  atrAtEntry: number
  /** 已有的成本裁决（若有）。复核者据此比对而非自己编造成本假设。 */
  costVerdict?: { ok: boolean; verdict: string; notionalUsdt: number }
}

export interface ReviewPacket {
  thesis: OrderThesis
  artifact: OrderArtifact
  claims: MakerClaims
  context: CheckerContext
}

export interface CheckerCheck {
  id: string
  ok: boolean
  detail: string
}

export interface DerivedFigures {
  referenceEntry: number
  stopDistance: number
  stopDistancePct: number
  qtyFromRisk: number
  riskBudgetUsd: number
  riskAmountUsd: number
  notionalUsd: number
  marginUsd: number
  rrRatio: number
  leverage: number
  liqSafetyRatio: number
}

export interface CheckerVerdict {
  ok: boolean
  status: VerdictStatus
  checks: CheckerCheck[]
  reasons: string[]
  derived: DerivedFigures | null
}

/** 数量比对容差：下游有 5 位小数取整与张数向下取整，2% 足以覆盖而不是掩盖漂移。 */
const QTY_TOLERANCE = 0.02
/** 金额比对容差（相对）。 */
const MONEY_TOLERANCE = 0.02

function relDiff(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12)
  return Math.abs(a - b) / scale
}

/**
 * 独立复核一笔开仓意图。
 *
 * 返回 `ok === false` 时调用方**必须放弃这笔交易**（而不是降级为"记录一下继续"）。
 * 与强平守卫的"钳制"策略不同：那里存在唯一正确的调整（降杠杆），
 * 这里没有 —— 声称与推导不一致时，"哪个是对的"本身未知，任何自动修正都是猜。
 */
export function reviewOrderIntent(packet: ReviewPacket): CheckerVerdict {
  const { thesis, artifact, claims, context } = packet
  const checks: CheckerCheck[] = []
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail })

  // ── 上下文完整性：缺即拒绝 ──────────────────────────────────────
  const ctxOk =
    Number.isFinite(context.equity) &&
    context.equity > 0 &&
    Number.isFinite(context.markPrice) &&
    context.markPrice > 0 &&
    Number.isFinite(context.atrAtEntry) &&
    context.atrAtEntry > 0
  if (!ctxOk) {
    return {
      ok: false,
      status: 'insufficient_context',
      checks: [
        {
          id: 'CONTEXT_COMPLETE',
          ok: false,
          detail: `复核所需客观事实缺失（equity=${context.equity}, markPrice=${context.markPrice}, atr=${context.atrAtEntry}）`,
        },
      ],
      reasons: ['缺少客观事实无法独立推导。按默认拒绝处理，避免"让复核拿不到数据"成为绕过路径。'],
      derived: null,
    }
  }

  // ── 入场价的来源：市价单必须锚在市价上，而不是生成者自己填的数 ──
  const referenceEntry =
    artifact.type === 'limit' && Number.isFinite(artifact.price) && (artifact.price as number) > 0
      ? (artifact.price as number)
      : context.markPrice
  const entryMatch = relDiff(claims.entryPrice, referenceEntry) <= 0.002
  push(
    'ENTRY_PRICE_SOURCE',
    entryMatch,
    entryMatch
      ? `入场价 ${claims.entryPrice} 与${artifact.type === 'limit' ? '限价' : '市价'} ${referenceEntry} 一致`
      : `声称入场价 ${claims.entryPrice} 与参考价 ${referenceEntry} 不一致（偏差 ${(relDiff(claims.entryPrice, referenceEntry) * 100).toFixed(3)}%）`,
  )

  // ── 止损几何：方向 + 盈亏比，用与拦截器同一个校验器、独立喂入原始价位 ──
  const action = thesis.side === 'long' ? 'BUY_LONG' : 'SELL_SHORT'
  const geometry = validateQuoteGeometry({
    action,
    entry: claims.entryPrice,
    takeProfit: claims.targetPrice,
    stopLoss: claims.stopPrice,
  })
  push('QUOTE_GEOMETRY', geometry.valid, geometry.valid ? `几何合法，R:R=${geometry.rr.toFixed(2)}` : geometry.reason)

  const rrOk = Number.isFinite(geometry.rr) && geometry.rr >= MIN_RISK_REWARD_RATIO && entryMatch && geometry.valid
  push(
    'RR_MINIMUM',
    rrOk,
    rrOk
      ? `真实盈亏比 ${geometry.rr.toFixed(2)} ≥ ${MIN_RISK_REWARD_RATIO}`
      : `真实盈亏比 ${geometry.rr.toFixed(2)} < ${MIN_RISK_REWARD_RATIO}（或几何/入场价不可信）`,
  )

  const stopDistance = Math.abs(claims.entryPrice - claims.stopPrice)
  const stopDistancePct = stopDistance / claims.entryPrice

  // ── 止损是否用足了冻结 ATR：止损窄于 1 ATR 视为"没给波动留空间" ──
  const atrFloor = ATR_STOP_MULT_MIN * context.atrAtEntry
  const atrOk = stopDistance >= atrFloor * 0.98
  push(
    'STOP_USES_FROZEN_ATR',
    atrOk,
    atrOk
      ? `止损距离 ${stopDistance.toFixed(2)} ≥ ${ATR_STOP_MULT_MIN}×ATR(${atrFloor.toFixed(2)})`
      : `止损距离 ${stopDistance.toFixed(2)} 窄于 ${ATR_STOP_MULT_MIN}×ATR = ${atrFloor.toFixed(2)}，会被杂波扫损`,
  )

  // ── 数量可复现：按风险预算重算，而不是接受声称的规模 ─────────────
  const leverage = artifact.leverage ?? 1
  const sizing = sizePositionFromRisk(context.equity, claims.entryPrice, stopDistance, 0, leverage)
  const qtyMatches = sizing.qty > 0 && relDiff(artifact.qty, sizing.qty) <= QTY_TOLERANCE
  push(
    'QTY_REPRODUCIBLE',
    qtyMatches,
    qtyMatches
      ? `数量 ${artifact.qty} 与独立推导 ${sizing.qty} 一致（约束 ${sizing.bindingConstraint}）`
      : `数量 ${artifact.qty} 与独立推导 ${sizing.qty} 不一致（约束 ${sizing.bindingConstraint}）——说明规模不是按 1R 预算算出来的`,
  )

  // ── 风险预算：实际风险额不得超过预算（这是"看似 1R、实际 3R"那一类的防线）──
  const riskBudget = riskBudgetPerTrade(context.equity)
  const actualRisk = artifact.qty * stopDistance
  const budgetOk = actualRisk <= riskBudget * (1 + QTY_TOLERANCE)
  push(
    'RISK_WITHIN_BUDGET',
    budgetOk,
    budgetOk
      ? `实际单笔风险 ${actualRisk.toFixed(2)} ≤ 预算 ${riskBudget.toFixed(2)}`
      : `实际单笔风险 ${actualRisk.toFixed(2)} 超过预算 ${riskBudget.toFixed(2)}（超 ${(actualRisk / riskBudget).toFixed(2)} 倍）`,
  )

  // ── 名义 / 保证金：声称值必须与独立推导一致 ─────────────────────
  const derivedNotional = artifact.qty * claims.entryPrice
  const notionalOk = relDiff(derivedNotional, claims.notionalUsd) <= MONEY_TOLERANCE
  push(
    'NOTIONAL_CLAIM_MATCH',
    notionalOk,
    notionalOk
      ? `声称名义本金 ${claims.notionalUsd.toFixed(2)} 与推导 ${derivedNotional.toFixed(2)} 一致`
      : `声称名义本金 ${claims.notionalUsd.toFixed(2)} ≠ 推导 ${derivedNotional.toFixed(2)}`,
  )

  const derivedMargin = marginRequired(derivedNotional, leverage)
  const marginOk = relDiff(derivedMargin, claims.marginUsd) <= MONEY_TOLERANCE
  push(
    'MARGIN_CLAIM_MATCH',
    marginOk,
    marginOk
      ? `声称保证金 ${claims.marginUsd.toFixed(2)} 与推导 ${derivedMargin.toFixed(2)} 一致`
      : `声称保证金 ${claims.marginUsd.toFixed(2)} ≠ 推导 ${derivedMargin.toFixed(2)}（杠杆 ${leverage}x）`,
  )

  // ── 强平安全：杠杆必须让强平晚于止损 ────────────────────────────
  //
  // ⚠️ 这里的判据是「**请求的杠杆本身安全**」，而不是「守卫能把请求钳到安全」。
  //   强平守卫是**最后的兜底**（它选择钳制而不是拒绝，见 positionGuard.ts 的说明），
  //   但复核的职责是守住"提交方给出的参数已经自洽"这条前提。
  //   若按"守卫没报错即算通过"，一个请求 125x、止损 6% 的意图会被判为合规 ——
  //   而它真正会被提交出去的杠杆与这个意图完全不同，复核就变成了走过场。
  const liq = assertStopBeforeLiquidation(claims.entryPrice, thesis.side, stopDistancePct, leverage)
  const clampNeeded = liq.leverage < leverage
  const liqOk = liq.ok && !clampNeeded
  push(
    'LIQUIDATION_SAFETY',
    liqOk,
    liqOk
      ? `${leverage}x 安全：强平安全比 ${liq.safetyRatio === Number.POSITIVE_INFINITY ? '∞（现货）' : liq.safetyRatio.toFixed(2)} ≥ ${LIQUIDATION_SAFETY_MULT}`
      : clampNeeded
        ? `请求 ${leverage}x 会被钳制到 ${liq.leverage}x（止损 ${(stopDistancePct * 100).toFixed(2)}% 太宽）——` +
          `${leverage}x 下强平会先于止损触发，提交方必须自己给出安全杠杆`
        : liq.reason,
  )

  // ── 杠杆与品种形态的配伍 ───────────────────────────────────────
  const instType = artifact.instType ?? 'SPOT'
  const pairOk = leverage <= 1 || instType === 'SWAP'
  push(
    'LEVERAGE_INSTTYPE_PAIR',
    pairOk,
    pairOk ? `形态配伍正确（${instType} / ${leverage}x）` : `${instType} 不支持 ${leverage}x（现货杠杆上限 ${SPOT_MAX_LEVERAGE}x）`,
  )
  const ceiling = Math.min(MAX_LEVERAGE, LEVERAGE_HARD_CEILING)
  const ceilingOk = leverage <= ceiling
  push('LEVERAGE_CEILING', ceilingOk, ceilingOk ? `${leverage}x ≤ 天花板 ${ceiling}x` : `${leverage}x 超过天花板 ${ceiling}x`)

  // ── 成本裁决：若上游已裁决，其规模必须与真实规模同源 ─────────────
  if (context.costVerdict) {
    const cv = context.costVerdict
    const sameScale = relDiff(cv.notionalUsdt, derivedNotional) <= MONEY_TOLERANCE
    const costOk = cv.ok && sameScale
    push(
      'COST_VERDICT_ALIGNED',
      costOk,
      costOk
        ? `成本裁决 ${cv.verdict} 基于同源规模 ${cv.notionalUsdt.toFixed(2)}`
        : `成本裁决不成立或不同源（${cv.verdict} @ ${cv.notionalUsdt.toFixed(2)} vs 真实 ${derivedNotional.toFixed(2)}）——` +
          '规模对不上时，"这笔成本划算"证明的是另一笔交易',
    )
  }

  // ── 人类可读的理由不能为空：无法陈述理由的决策，复核无从谈起 ────
  const rationaleOk = typeof thesis.rationale === 'string' && thesis.rationale.trim().length > 0
  push('RATIONALE_PRESENT', rationaleOk, rationaleOk ? '决策理由已提供' : '决策理由为空（无法复核一个说不出理由的决策）')

  const failed = checks.filter((c) => !c.ok)
  const derived: DerivedFigures = {
    referenceEntry,
    stopDistance,
    stopDistancePct,
    qtyFromRisk: sizing.qty,
    riskBudgetUsd: riskBudget,
    riskAmountUsd: actualRisk,
    notionalUsd: derivedNotional,
    marginUsd: derivedMargin,
    rrRatio: geometry.rr,
    leverage,
    liqSafetyRatio: liq.safetyRatio,
  }

  return {
    ok: failed.length === 0,
    status: failed.length === 0 ? 'agree' : 'disagree',
    checks,
    reasons: failed.map((c) => `${c.id}: ${c.detail}`),
    derived,
  }
}

/**
 * 复核并留痕。**这是实盘路径该调用的入口** —— 只返回 verdict 而不落审计的复核，
 * 事后无法回答"这笔是谁放行的、复核了什么"。
 */
export function reviewAndAudit(packet: ReviewPacket): CheckerVerdict {
  const verdict = reviewOrderIntent(packet)
  appendEvent('VERIFIER_VERDICT', {
    strategyId: packet.thesis.strategyId,
    symbol: packet.thesis.symbol,
    side: packet.thesis.side,
    status: verdict.status,
    ok: verdict.ok,
    failedChecks: verdict.checks.filter((c) => !c.ok).map((c) => c.id),
    // 留痕失败原因本身：只有 status 的话，事后无法区分
    // 「系统拦对了」与「复核器自己坏了」——这两种情况的处置完全相反。
    reasons: verdict.reasons.slice(0, 5),
    derived: verdict.derived,
    qty: packet.artifact.qty,
    leverage: packet.artifact.leverage ?? 1,
    instType: packet.artifact.instType ?? 'SPOT',
  })
  return verdict
}
