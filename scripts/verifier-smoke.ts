/**
 * Maker-Checker 独立复核门禁。
 *
 * 要守住的是一条**结构性质**：复核者只从「需求 + 产物 + 复核者自取的客观事实」
 * 重新推导，任何与声称值的不一致都必须拦下。因此本文件的正例只有一条，
 * 其余全是**反例** —— 复核器的价值几乎全部体现在"能不能发现不一致"上。
 *
 * 反例覆盖本项目真实吃过亏的两类：
 *   · 合理误购：每一步都有理由，但规模/几何整体不对（声称 1R、实际 3R）
 *   · LEDGER_MISMATCH：闸门校的规模与实际下单规模是两个数（声称名义 ≠ 推导名义）
 */

process.env.EV_MAX_LEVERAGE = '125'

import assert from 'node:assert/strict'

const { reviewOrderIntent, reviewAndAudit } = await import('../server/makerChecker.ts')
const { sizePositionFromRisk, marginRequired } = await import('../server/positionGuard.ts')
const { getEvents } = await import('../server/ledger.ts')

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`      ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

/** 复核不通过的用例：断言 status/ok，以及**具体是哪一项**发现了问题。 */
function expectDisagree(name: string, mutate: (p: Packet) => void, expectCheck: string): void {
  check(name, () => {
    const p = baseline()
    mutate(p)
    const v = reviewOrderIntent(p)
    assert.equal(v.ok, false, '复核竟然放行了')
    assert.equal(v.status, 'disagree', `status=${v.status}`)
    const failed = v.checks.filter((c) => !c.ok).map((c) => c.id)
    assert.ok(failed.includes(expectCheck), `期望 ${expectCheck} 失败，实际失败项：${failed.join(', ')}`)
  })
}

const EQUITY = 10_000
const ENTRY = 60_000
const ATR = 600 // 1% of price
const STOP = 58_800 // 2% ⇒ 2×ATR，满足"用足冻结 ATR"
const TARGET = 63_600 // 3R
const LEVERAGE = 10
const STOP_DISTANCE = ENTRY - STOP

const sizing = sizePositionFromRisk(EQUITY, ENTRY, STOP_DISTANCE, 0, LEVERAGE)
if (sizing.qty <= 0) throw new Error(`基线规模为 0（约束 ${sizing.bindingConstraint}），用例无法成立`)

interface Packet {
  thesis: { strategyId: string; symbol: string; side: 'long' | 'short'; rationale: string }
  artifact: { side: 'buy' | 'sell'; type: 'market' | 'limit'; price?: number; qty: number; leverage?: number; instType?: 'SPOT' | 'SWAP' }
  claims: { entryPrice: number; stopPrice: number; targetPrice: number; riskAmountUsd: number; notionalUsd: number; marginUsd: number; rrRatio: number }
  context: { equity: number; markPrice: number; atrAtEntry: number; costVerdict?: { ok: boolean; verdict: string; notionalUsdt: number } }
}

function baseline(): Packet {
  const notional = sizing.qty * ENTRY
  return {
    thesis: { strategyId: 'strat-a', symbol: 'BTCUSDT', side: 'long', rationale: '多头环境 + RSI 回调，止损置于结构外' },
    artifact: { side: 'buy', type: 'market', qty: sizing.qty, leverage: LEVERAGE, instType: 'SWAP' },
    claims: {
      entryPrice: ENTRY,
      stopPrice: STOP,
      targetPrice: TARGET,
      riskAmountUsd: sizing.riskAmount,
      notionalUsd: notional,
      marginUsd: marginRequired(notional, LEVERAGE),
      rrRatio: (TARGET - ENTRY) / STOP_DISTANCE,
    },
    context: {
      equity: EQUITY,
      markPrice: ENTRY,
      atrAtEntry: ATR,
      costVerdict: { ok: true, verdict: 'PASS', notionalUsdt: notional },
    },
  }
}

console.log('\n── 正例：一致时放行 ──')
check('完全一致的意图 → agree（且每一项检查都通过）', () => {
  const v = reviewOrderIntent(baseline())
  assert.equal(v.status, 'agree', `失败项：${v.reasons.join(' | ')}`)
  assert.equal(v.ok, true)
  assert.equal(v.checks.filter((c) => !c.ok).length, 0)
  assert.ok(v.derived !== null)
})

/**
 * 在保持**内部自洽**的前提下换一套几何/杠杆，用来把单一检查项隔离出来。
 *
 * 为什么需要它：只改一个价位会连带触发几何、盈亏比、数量可复现三处失败，
 * 于是断言"某项必须失败"变成弱断言（失败项里凑巧包含它）。
 * 这里的做法是——除了**要考察的那一项**，其余全部按推导值对齐，
 * 这样失败项集合就能被精确断言。
 */
function rebase(p: Packet, opts: { stopPrice?: number; targetPrice?: number; leverage?: number }): void {
  const leverage = opts.leverage ?? p.artifact.leverage ?? 1
  const stopPrice = opts.stopPrice ?? p.claims.stopPrice
  const targetPrice = opts.targetPrice ?? p.claims.targetPrice
  const stopDistance = Math.abs(p.claims.entryPrice - stopPrice)
  const s = sizePositionFromRisk(EQUITY, p.claims.entryPrice, stopDistance, 0, leverage)
  const notional = s.qty * p.claims.entryPrice
  p.artifact.qty = s.qty
  p.artifact.leverage = leverage
  p.artifact.instType = 'SWAP'
  p.claims.stopPrice = stopPrice
  p.claims.targetPrice = targetPrice
  p.claims.riskAmountUsd = s.riskAmount
  p.claims.notionalUsd = notional
  p.claims.marginUsd = marginRequired(notional, leverage)
  p.claims.rrRatio = Math.abs(targetPrice - p.claims.entryPrice) / stopDistance
  p.context.costVerdict = { ok: true, verdict: 'PASS', notionalUsdt: notional }
}

console.log('\n── 反例：规模与声称不一致（LEDGER_MISMATCH 类）──')
expectDisagree(
  '数量被放大 3 倍（声称 1R、实际 3R）→ QTY_REPRODUCIBLE',
  (p) => {
    p.artifact.qty *= 3
    p.claims.notionalUsd *= 3
    p.claims.marginUsd *= 3
  },
  'QTY_REPRODUCIBLE',
)

expectDisagree(
  '数量放大 3 倍但声称值不变 → 风险越过预算',
  (p) => {
    p.artifact.qty *= 3
  },
  'RISK_WITHIN_BUDGET',
)

expectDisagree(
  '声称名义本金与实际数量不符 → NOTIONAL_CLAIM_MATCH',
  (p) => {
    p.claims.notionalUsd *= 0.5
  },
  'NOTIONAL_CLAIM_MATCH',
)

expectDisagree(
  '声称保证金与实际不符 → MARGIN_CLAIM_MATCH',
  (p) => {
    p.claims.marginUsd *= 0.5
  },
  'MARGIN_CLAIM_MATCH',
)

console.log('\n── 反例：几何与盈亏比 ──')
expectDisagree(
  '止损挂在入场价的错误一侧 → QUOTE_GEOMETRY',
  (p) => {
    p.claims.stopPrice = ENTRY + 1200
  },
  'QUOTE_GEOMETRY',
)

expectDisagree(
  '真实盈亏比不足（止盈缩到 1R）→ RR_MINIMUM',
  (p) => {
    p.claims.targetPrice = ENTRY + STOP_DISTANCE
  },
  'RR_MINIMUM',
)

expectDisagree(
  '市价单却声称一个偏离市价的入场价 → ENTRY_PRICE_SOURCE',
  (p) => {
    p.claims.entryPrice = ENTRY * 1.05
    p.claims.stopPrice = p.claims.entryPrice - STOP_DISTANCE
    p.claims.targetPrice = p.claims.entryPrice + STOP_DISTANCE * 3
  },
  'ENTRY_PRICE_SOURCE',
)

expectDisagree(
  '止损窄于 1×ATR（没给波动留呼吸空间）→ STOP_USES_FROZEN_ATR',
  (p) => {
    p.claims.stopPrice = ENTRY - ATR * 0.2
  },
  'STOP_USES_FROZEN_ATR',
)

console.log('\n── 反例：杠杆与强平（以小博大的失效模式）──')
expectDisagree(
  '高杠杆却是现货形态 → LEVERAGE_INSTTYPE_PAIR',
  (p) => {
    p.artifact.instType = 'SPOT'
  },
  'LEVERAGE_INSTTYPE_PAIR',
)

expectDisagree(
  '杠杆超过硬天花板 → LEVERAGE_CEILING',
  (p) => {
    p.artifact.leverage = 9999
    p.claims.marginUsd = marginRequired(p.claims.notionalUsd, 9999)
  },
  'LEVERAGE_CEILING',
)

expectDisagree(
  '止损过宽以致强平会先触发 → LIQUIDATION_SAFETY（其余项全部自洽）',
  (p) => {
    // 止损拉到 6%、止盈拉到 18%（盈亏比仍是 3），杠杆打满 125x。
    // 6% 止损下安全杠杆上限约 10x ⇒ 125x 必然让强平早于止损。
    rebase(p, { stopPrice: ENTRY * 0.94, targetPrice: ENTRY * 1.18, leverage: 125 })
    const v = reviewOrderIntent(p)
    const failed = v.checks.filter((c) => !c.ok).map((c) => c.id)
    assert.deepEqual(failed, ['LIQUIDATION_SAFETY'], `应只有强平一项失败，实际：${failed.join(', ')}`)
  },
  'LIQUIDATION_SAFETY',
)

console.log('\n── 反例：成本裁决必须与真实规模同源 ──')
expectDisagree(
  '成本裁决基于另一个规模 → COST_VERDICT_ALIGNED',
  (p) => {
    p.context.costVerdict = { ok: true, verdict: 'PASS', notionalUsdt: p.claims.notionalUsd * 4 }
  },
  'COST_VERDICT_ALIGNED',
)

expectDisagree(
  '成本裁决本身是拒绝 → COST_VERDICT_ALIGNED',
  (p) => {
    p.context.costVerdict = { ok: false, verdict: 'COST_DOMINATED', notionalUsdt: p.claims.notionalUsd }
  },
  'COST_VERDICT_ALIGNED',
)

console.log('\n── 反例：上下文与理由 ──')
check('缺少客观事实 → insufficient_context，且明确拒绝而不是放行', () => {
  const p = baseline()
  p.context.atrAtEntry = 0
  const v = reviewOrderIntent(p)
  assert.equal(v.ok, false, '缺上下文竟被放行 —— "拿不到数据"会成为绕过复核的最短路径')
  assert.equal(v.status, 'insufficient_context')
  assert.equal(v.derived, null)
})

expectDisagree(
  '策略说不出理由 → RATIONALE_PRESENT',
  (p) => {
    p.thesis.rationale = '   '
  },
  'RATIONALE_PRESENT',
)

check('理由写得多充分都不能改变结论（复核不读叙事，只重算数字）', () => {
  const convincing = baseline()
  convincing.thesis.rationale =
    '高周期多头排列，4H 结构突破确认，ATR 收缩后波动率扩张概率显著上升，' +
    '资金费率处于中性偏低区间，多空比健康，1H ADX 走强，基本面与资金面共振，故开多。'
  convincing.artifact.qty *= 3
  const v = reviewOrderIntent(convincing)
  assert.equal(v.ok, false, '一份有说服力的叙事让复核通过了 —— 这正是上下文隔离要防的锚定效应')
  assert.equal(v.status, 'disagree')
})

console.log('\n── 留痕 ──')
check('复核结论落入审计账本，且失败原因不被压缩成只有一个 status', () => {
  const before = getEvents(0).length
  const p = baseline()
  p.artifact.qty *= 3
  reviewAndAudit(p)
  const fresh = getEvents(before).filter((e) => e.kind === 'VERIFIER_VERDICT')
  assert.equal(fresh.length, 1, `应落 1 条复核事件，实际 ${fresh.length}`)
  const payload = fresh[0].payload as { ok?: boolean; status?: string; failedChecks?: string[]; reasons?: string[] }
  assert.equal(payload.ok, false)
  assert.equal(payload.status, 'disagree')
  assert.ok((payload.failedChecks ?? []).length > 0, '未记录失败的具体检查项')
  assert.ok((payload.reasons ?? []).length > 0, '未记录失败原因 —— 事后无法区分"拦对了"与"复核器坏了"')
})

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] VERIFIER SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`VERIFIER SMOKE PASSED (${passed}/${passed})`)
