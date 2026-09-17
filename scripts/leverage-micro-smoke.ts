/**
 * 微资金 × 高杠杆 门禁 —— 「以小博大」这条路的物理边界与配伍约束。
 *
 * 需求原话是「自动交易必须要允许使用小资金，必须用以小博大策略，
 * 允许使用最高 125 倍合约，先使用 1~10~100U 资金测试」。
 * 这句话能不能成立，取决于六件可判定的事：
 *   ① 杠杆**不放大风险预算** —— 否则 125x 下 1R = 权益的 125%，一次止损清空账户
 *   ② 强平距离**必须大于**止损距离 —— 否则止损从未生效，系统却会记一笔"正常止损"
 *   ③ 125x 是**天花板而非可达目标** —— 有效杠杆由止损宽度反推，这是几何事实
 *   ④ $1~$100 保证金配杠杆后能跨过 CEX 成本地板 —— 否则"小资金"只是无法成交
 *   ⑤ 币本位 / U 本位的张数换算正确 —— 这类错误**不报错**，只是量级差 100 倍
 *   ⑥ 资金帽量的是**自有资金**而非名义本金 —— 否则帽会把小资金策略结构性锁死
 *
 * ⚠️ 本文件在**任何读取 riskConstants 的模块被加载之前**改写环境变量。
 *    那些常量是模块加载时求值的 `let`，先 import 再赋值不会有任何效果 ——
 *    测试会"通过"在一个与生产不同的收敛值上。所以此处刻意使用动态 import。
 */

process.env.EV_MAX_LEVERAGE = '125'
process.env.EV_ALLOW_MICRO_CAPITAL = '1'
process.env.AUTOPILOT_LIVE_CAP_USD = '100'

import assert from 'node:assert/strict'

const {
  sizePositionFromRisk,
  maxSafeLeverage,
  assertStopBeforeLiquidation,
  liquidationGeometry,
  marginRequired,
} = await import('../server/positionGuard.ts')
const {
  LIQUIDATION_FEE_BUFFER_BPS,
  LIQUIDATION_MAINT_MARGIN_PCT,
  LIQUIDATION_SAFETY_MULT,
  LEVERAGE_HARD_CEILING,
  MAX_LEVERAGE,
  MIN_MARGIN_USDT,
  MIN_VIABLE_NOTIONAL_CEX_USDT,
  MIN_VIABLE_NOTIONAL_USDT,
  RISK_PER_TRADE_RATIO,
  SPOT_MAX_LEVERAGE,
  riskBudgetPerTrade,
} = await import('../server/riskConstants.ts')
const { contractsFromBaseQty, notionalFromContracts, parseSymbol, toSwapInstId } = await import(
  '../server/venue/okxSwapSpec.ts'
)
const { assessEdge, liveCexCostInput } = await import('../server/costModel.ts')
const { preTradeCheck } = await import('../server/risk.ts')
const { createState } = await import('../server/orchEngine.ts')
const { pipelineService } = await import('../server/pipelineService.ts')
const { receipt } = await import('./overfit-fixture.ts')

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((e: unknown) => {
      failures.push(name)
      console.log(`  ✗ ${name}`)
      console.log(`      ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    })
}

/** BTC 参考价与保证金档位（用户给的三档起点）。 */
const PX = 60_000
const MARGIN_TIERS = [1, 10, 100]

console.log('\n── ① 杠杆不得放大风险预算 ──')

await check('风险预算与杠杆无关（1x 与 125x 的 riskBudget 完全相同）', () => {
  const d = PX * 0.02
  const at1 = sizePositionFromRisk(100, PX, d, 0, 1)
  const at125 = sizePositionFromRisk(100, PX, d, 0, 125)
  assert.equal(at1.riskBudget, at125.riskBudget, `1x=${at1.riskBudget} vs 125x=${at125.riskBudget}`)
  assert.equal(at1.riskBudget, riskBudgetPerTrade(100))
})

await check('单笔风险额恒 ≤ 风险预算（旧写法在 125x 下会放大 125 倍）', () => {
  const d = PX * 0.02
  const budget = riskBudgetPerTrade(100)
  for (const lev of [1, 3, 10, 25, 125]) {
    const s = sizePositionFromRisk(100, PX, d, 0, lev)
    assert.ok(
      s.riskAmount <= budget * (1 + 1e-9),
      `${lev}x 下单笔风险额 ${s.riskAmount} > 预算 ${budget}（杠杆被错误地乘进了风险预算）`,
    )
  }
})

await check('1R 锚定权益而非杠杆：100 权益下各杠杆的单笔最大亏损都 ≈ 1% 权益', () => {
  const d = PX * 0.02
  for (const lev of [1, 10, 125]) {
    const s = sizePositionFromRisk(100, PX, d, 0, lev)
    assert.ok(s.riskAmount <= 100 * RISK_PER_TRADE_RATIO + 1e-9, `${lev}x riskAmount=${s.riskAmount}`)
  }
})

await check('杠杆的真实作用：放松保证金上限，让同样的仓位付得起', () => {
  const d = PX * 0.02
  const at1 = sizePositionFromRisk(100, PX, d, 0, 1)
  const at125 = sizePositionFromRisk(100, PX, d, 0, 125)
  assert.equal(at1.bindingConstraint, 'margin_cap', '1x 下应由保证金上限约束')
  assert.equal(at125.bindingConstraint, 'risk_budget', '125x 下应由风险预算约束')
  assert.ok(at125.qty > at1.qty, '杠杆应能开出更大仓位（因为保证金不再是瓶颈）')
})

console.log('\n── ② 强平距离必须大于止损距离 ──')

await check('125x 的裸强平距离只有 0.1%（远窄于 1.8% 的止损垫下限）', () => {
  const liq = liquidationGeometry(PX, 'long', 125)
  const expected = 1 / 125 - LIQUIDATION_MAINT_MARGIN_PCT - LIQUIDATION_FEE_BUFFER_BPS / 10_000
  assert.ok(Math.abs(liq.distancePct - expected) < 1e-12, `${liq.distancePct} != ${expected}`)
  assert.ok(liq.distancePct < 0.018, '若强平比止损还宽，本用例失去意义')
})

await check('125x + 2% 止损 ⇒ 守卫把杠杆钳到安全值，且强平距离 ≥ 止损 × 安全倍数', () => {
  const stopPct = 0.02
  const v = assertStopBeforeLiquidation(PX, 'long', stopPct, 125)
  assert.equal(v.ok, true)
  assert.equal(v.requestedLeverage, 125)
  assert.ok(v.leverage < 125, `杠杆未被钳制：${v.leverage}`)
  assert.ok(v.safetyRatio >= LIQUIDATION_SAFETY_MULT, `安全比 ${v.safetyRatio} < ${LIQUIDATION_SAFETY_MULT}`)
  const liq = liquidationGeometry(PX, 'long', v.leverage)
  assert.ok(liq.distancePct >= stopPct * LIQUIDATION_SAFETY_MULT - 1e-12)
})

await check('性质测试：任意止损宽度下，返回的杠杆都保证强平晚于止损', () => {
  for (const stopPct of [0.002, 0.005, 0.008, 0.01, 0.018, 0.03, 0.05]) {
    const v = assertStopBeforeLiquidation(PX, 'long', stopPct, LEVERAGE_HARD_CEILING)
    assert.ok(v.ok, `stop ${stopPct} 被拒：${v.reason}`)
    const liq = liquidationGeometry(PX, 'long', v.leverage)
    assert.ok(
      liq.distancePct >= stopPct * LIQUIDATION_SAFETY_MULT - 1e-12,
      `stop ${stopPct}: 强平 ${liq.distancePct} 未达止损 × ${LIQUIDATION_SAFETY_MULT}`,
    )
  }
})

await check('空单方向对称：强平价在入场价之上', () => {
  const lev = maxSafeLeverage(0.02)
  const liq = liquidationGeometry(PX, 'short', lev)
  assert.ok(liq.price > PX, `空单强平价 ${liq.price} 应高于入场价 ${PX}`)
})

await check('现货（杠杆 ≤ 1）无强平：安全比记为 Infinity 而不是 0', () => {
  const v = assertStopBeforeLiquidation(PX, 'long', 0.03, 1)
  assert.equal(v.leverage, 1)
  assert.equal(v.safetyRatio, Number.POSITIVE_INFINITY)
})

console.log('\n── ③ 125x 是天花板，不是可达目标 ──')

await check(`硬天花板生效：请求 9999x 与请求 ${LEVERAGE_HARD_CEILING}x 得到同一规模`, () => {
  assert.ok(MAX_LEVERAGE <= LEVERAGE_HARD_CEILING, `MAX_LEVERAGE ${MAX_LEVERAGE} 超过硬天花板`)
  const d = PX * 0.02
  const huge = sizePositionFromRisk(100, PX, d, 0, 9999)
  const ceiling = sizePositionFromRisk(100, PX, d, 0, LEVERAGE_HARD_CEILING)
  assert.equal(huge.qty, ceiling.qty)
})

await check('要支撑 125x 需要 0.067% 的止损 —— 现实止损拿到的是几十倍以内', () => {
  const for125 = maxSafeLeverage(0.00067)
  assert.ok(for125 >= 120 && for125 <= LEVERAGE_HARD_CEILING, `0.067% 止损应支持接近 125x，实际 ${for125}`)
  const realistic = maxSafeLeverage(0.018)
  assert.ok(realistic < 30, `1.8% 止损下安全杠杆应远低于 30，实际 ${realistic}`)
  console.log(`      · 止损 0.067% → 安全杠杆 ${for125}x；止损 1.8% → ${realistic}x；止损 3% → ${maxSafeLeverage(0.03)}x`)
})

console.log('\n── ④ 小资金 + 杠杆跨过 CEX 成本地板 ──')

await check('CEX 与 DEX 的最小可行规模是两个不同的事实，不可合并', () => {
  assert.notEqual(
    MIN_VIABLE_NOTIONAL_CEX_USDT,
    MIN_VIABLE_NOTIONAL_USDT,
    '两者相等说明"gas 决定的地板"又被套回了没有 gas 的 CEX',
  )
  assert.ok(MIN_VIABLE_NOTIONAL_CEX_USDT < MIN_VIABLE_NOTIONAL_USDT)
})

await check('$1 / $10 / $100 保证金配杠杆后，CEX 侧均不被判 NOTIONAL_TOO_SMALL', () => {
  for (const margin of MARGIN_TIERS) {
    for (const lev of [10, 125]) {
      const notional = margin * lev
      const r = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: notional, expectedEdgeBps: 200 }))
      assert.notEqual(
        r.verdict,
        'NOTIONAL_TOO_SMALL',
        `$${margin} 保证金 × ${lev}x = $${notional} 名义被成本闸门判为太小`,
      )
    }
  }
})

await check('同位名义本金在 DEX 侧仍被正确拒绝（证明放松是本通道的、不是全局的）', () => {
  const smallNotional = MARGIN_TIERS[0] * 125 // $125 < DEX 地板 $200
  const cex = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: smallNotional, expectedEdgeBps: 200 }))
  const dex = assessEdge({
    channel: 'dex',
    venue: 'uniswap-v3',
    notionalUsdt: smallNotional,
    expectedEdgeBps: 200,
    poolDepthUsdt: 50_000_000,
  })
  assert.notEqual(cex.verdict, 'NOTIONAL_TOO_SMALL', 'CEX 应放行')
  assert.equal(dex.verdict, 'NOTIONAL_TOO_SMALL', `DEX 应拒绝，实际 ${dex.verdict}`)
})

await check('保证金与名义本金往返一致（幂等，无隐藏取整）', () => {
  for (const margin of MARGIN_TIERS) {
    for (const lev of [1, 10, 125]) {
      const notional = margin * lev
      assert.ok(Math.abs(marginRequired(notional, lev) - margin) < 1e-9, `${margin}×${lev} 往返 ${marginRequired(notional, lev)}`)
    }
  }
})

await check('单笔最小保证金档位下界被显式记录（1U 是用户起点，不是随意值）', () => {
  assert.ok(MIN_MARGIN_USDT > 0)
  assert.ok(MIN_MARGIN_USDT <= MARGIN_TIERS[0], `最小保证金 ${MIN_MARGIN_USDT} 应 ≤ 起点档位 ${MARGIN_TIERS[0]}`)
})

console.log('\n── ⑤ 币本位 / U 本位的张数换算（错误不报错，只差 100 倍）──')

await check('符号解析：长稳定币后缀不被短后缀截断；形状非法一律返回 null', () => {
  assert.deepEqual(parseSymbol('BTCUSDT'), { base: 'BTC', quote: 'USDT' })
  assert.deepEqual(parseSymbol('BTC-USD'), { base: 'BTC', quote: 'USD' })
  assert.deepEqual(parseSymbol('ethusdc'), { base: 'ETH', quote: 'USDC' })
  // 形状校验：split('-') 对任意串都能"成功"，若不校验就会造出 NOT-A-SWAP 这种
  // 看起来合法、一路送到场所才被拒的 instId
  assert.equal(parseSymbol('not-a-symbol'), null)
  assert.equal(parseSymbol('BTC'), null)
  assert.throws(() => toSwapInstId('not-a-symbol'), /SWAP_SYMBOL_UNPARSEABLE/)
})

await check('instId 生成：inverse 一律落到 USD 结算，不是 USDC', () => {
  assert.equal(toSwapInstId('BTCUSDT', 'linear'), 'BTC-USDT-SWAP')
  assert.equal(toSwapInstId('BTCUSDT', 'inverse'), 'BTC-USD-SWAP')
})

await check('U 本位：1 张 = 0.01 BTC，0.01 BTC 恰好 1 张；不足 1 张返回 0 而非抬到最小量', () => {
  const linear = { ctVal: 0.01, ctValCcy: 'BTC', lotSz: 1, minSz: 1, settle: 'linear' as const }
  assert.equal(contractsFromBaseQty(0.01, linear), 1)
  assert.equal(contractsFromBaseQty(0.005, linear), 0, '不足最小下单量必须返回 0，静默抬规模等于擅自放大仓位')
  assert.equal(contractsFromBaseQty(0.03, linear), 3)
  assert.equal(notionalFromContracts(1, linear, PX), 600)
})

await check('把"张"当"币"传会差 100 倍 —— 这正是本模块必须存在的原因', () => {
  const linear = { ctVal: 0.01, ctValCcy: 'BTC', lotSz: 1, minSz: 1, settle: 'linear' as const }
  const asBaseQty = notionalFromContracts(contractsFromBaseQty(1, linear), linear, PX) // 1 BTC 正确解读
  const asContracts = notionalFromContracts(1, linear, PX) // 误把 1 张当成 1 BTC
  assert.ok(Math.abs(asBaseQty / asContracts - 100) < 0.5, `倍数 ${asBaseQty / asContracts} 应为 100`)
})

await check('币本位：张数 = 名义价值(USD) / ctVal(USD)，缺价格必须抛错而不是猜', () => {
  const inverse = { ctVal: 100, ctValCcy: 'USD', lotSz: 1, minSz: 1, settle: 'inverse' as const }
  assert.equal(contractsFromBaseQty(0.01, inverse, PX), 6) // 0.01 BTC × 60000 = 600 USD ⇒ 6 张
  assert.throws(() => contractsFromBaseQty(0.01, inverse), /INVERSE_SWAP_REQUIRES_PRICE/)
  assert.equal(notionalFromContracts(6, inverse, PX), 600)
})

await check('币本位小资金路径：$100 保证金 × 125x = $12500 名义 ⇒ 125 张', () => {
  const inverse = { ctVal: 100, ctValCcy: 'USD', lotSz: 1, minSz: 1, settle: 'inverse' as const }
  const notional = MARGIN_TIERS[2] * 125
  const contracts = contractsFromBaseQty(notional / PX, inverse, PX)
  assert.equal(contracts, 125)
  assert.ok(Math.abs(notionalFromContracts(contracts, inverse, PX) - notional) < 1e-9)
})

console.log('\n── ⑥ 参数配伍与资金帽口径 ──')

await check('现货 + 高杠杆必须被拒（各自合法、组合非法的典型）', () => {
  const state = createState(1_000)
  const base = { clientOrderId: 'x', symbol: 'BTCUSDT', side: 'buy' as const, type: 'market' as const, qty: 0.001 }
  const spot = preTradeCheck(state, { ...base, leverage: 125 }, PX)
  assert.equal(spot.ok, false)
  assert.match(spot.ok === false ? spot.reason : '', /LEVERAGE_REQUIRES_SWAP/)
  const swap = preTradeCheck(state, { ...base, leverage: 125, instType: 'SWAP' }, PX)
  assert.equal(swap.ok, true, `SWAP + 125x 应放行：${swap.ok === false ? swap.reason : ''}`)
})

await check('超过硬天花板一律拒绝，不给场所任何"间接理由拒单"的机会', () => {
  const state = createState(1_000)
  const r = preTradeCheck(
    state,
    { clientOrderId: 'y', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.001, leverage: LEVERAGE_HARD_CEILING + 1, instType: 'SWAP' },
    PX,
  )
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /LEVERAGE_ABOVE_HARD_CEILING/)
})

await check(`现货杠杆上限被显式限制在 ${SPOT_MAX_LEVERAGE}x 以内`, () => {
  const state = createState(1_000)
  const ok = preTradeCheck(
    state,
    { clientOrderId: 'z', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.001, leverage: SPOT_MAX_LEVERAGE },
    PX,
  )
  assert.equal(ok.ok, true, `现货 ${SPOT_MAX_LEVERAGE}x 应放行`)
})

/** 把一条策略推到 small_cap_live（走完 纸交易 → 测试网实测 → 人工审批 全链路）。 */
function promoteToLive(id: string): void {
  const T0 = 1_800_000_000_000
  const HOUR = 3_600_000
  pipelineService.submit(id)
  pipelineService.evaluateGate(id, { fitnessValue: 120, overfit: receipt(), purityHomogeneous: false })
  for (let i = 0; i < 22; i++) pipelineService.recordPaperTrade(id)
  pipelineService.closePaper(id, 2)
  pipelineService.beginTestnet(id, 'okx-testnet', T0)
  for (let i = 0; i < 14; i++) pipelineService.recordTestnetFill(id, T0 + i * HOUR)
  for (const r of [0.9, -0.7, 1.2, -0.6, 0.8, -0.5, 1.0, -0.65, 0.7, 1.1]) pipelineService.recordTestnetReturn(id, r)
  pipelineService.closeTestnet(id, 3, T0 + 16 * HOUR)
  pipelineService.approve(id, 'smoke')
}

await check('资金帽量的是自有资金：$100 帽允许多大敞口由杠杆决定', () => {
  promoteToLive('lev-cap-strat')
  const rec = pipelineService.get('lev-cap-strat')
  assert.equal(rec.stage, 'small_cap_live', `晋升链路未走通：${rec.stage}`)

  // 100 保证金 × 10x = 1000 名义 ⇒ 用满帽，放行
  const full = pipelineService.authorizeLive('lev-cap-strat', 1_000, 100)
  assert.equal(full.ok, true, `按自有资金口径应放行：${full.ok === false ? full.reason : ''}`)
  assert.equal(full.ok === true ? full.capUsd : 0, 100)

  // 自有资金超帽 ⇒ 拒绝（帽不会因为杠杆变大而变大）
  const over = pipelineService.authorizeLive('lev-cap-strat', 1_500, 150)
  assert.equal(over.ok, false)
  assert.match(over.ok === false ? over.reason : '', /STRATEGY_CAP_ORDER_EXCEEDS/)
})

await check('量纲不变量：名义本金 > 自有资金 × 硬天花板 ⇒ 拒绝（杠杆在传递途中丢了）', () => {
  const bad = pipelineService.authorizeLive('lev-cap-strat', 1_000, 1)
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.reason : '', /CAP_MARGIN_NOTIONAL_MISMATCH/)
})

await check('累计口径同样按自有资金：已用 $100 后再开 $1 也应超帽', () => {
  pipelineService.recordLiveSubmitted('lev-cap-strat', 1_000, 100)
  const r = pipelineService.authorizeLive('lev-cap-strat', 125, 1)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /STRATEGY_CAP_EXCEEDED/)
})

await check('未走完测试网实测的策略不得获得实盘资格', () => {
  pipelineService.submit('lev-not-verified')
  pipelineService.evaluateGate('lev-not-verified', { fitnessValue: 120, overfit: receipt(), purityHomogeneous: false })
  for (let i = 0; i < 22; i++) pipelineService.recordPaperTrade('lev-not-verified')
  pipelineService.closePaper('lev-not-verified', 2)
  assert.equal(pipelineService.isLiveEligible('lev-not-verified'), false, '仅通过纸交易阶段就取得实盘资格')
  const r = pipelineService.authorizeLive('lev-not-verified', 1_000, 100)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /STRATEGY_NOT_AUTHORIZED_FOR_LIVE/)
})

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] LEVERAGE MICRO SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`LEVERAGE MICRO SMOKE PASSED (${passed}/${passed})`)
