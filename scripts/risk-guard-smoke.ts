/**
 * 风控内核烟测（R20 内化能力回归门禁）
 *
 * 覆盖四层风控里的**纯逻辑**部分，全部不依赖网络与交易所：
 *   ① 风控 SSOT：schema 无漂移、预设套件自洽、非法值被拒
 *   ② 止损几何：宽止损、0.8R 保本、棘轮只上移、1R 定规模
 *   ③ 拦截闸门：Fail-Closed 三条落法 + 沙箱场景集
 *   ④ 进化红线：毒化模式被拦、官方基线不被误伤
 *
 * 为什么这些断言值得进 CI：
 *   它们守的都是「静默失效」型缺陷——参数拼错、止损方向反了、
 *   拦截器被停用后管线照样放行。这类问题不会抛异常，只会让账户慢慢流血，
 *   靠人工 review 是抓不住的。
 */

import { strict as assert } from 'node:assert'
import {
  ATR_PERIOD,
  BREAKEVEN_TRIGGER_R,
  PROFIT_LOCK_TRIGGER_R,
  MIN_RISK_REWARD_RATIO,
  RISK_PER_TRADE_RATIO,
  reloadRiskConstants,
  currentRiskValues,
  riskBudgetPerTrade,
} from '../server/riskConstants.ts'
import { schema, currentValues, normalize, SUITES, suiteValues, validateCurrent } from '../server/riskConfig.ts'
import {
  computeStopGeometry,
  deriveInitialStop,
  sizePositionFromRisk,
  evaluatePosition,
  openPosition,
  applyStopAction,
  rMultiple,
  resetGuard,
} from '../server/positionGuard.ts'
import { listInterceptors, runSandboxTest, runPipeline, resetInterceptors, setInterceptorEnabled } from '../server/interceptors.ts'
import type { MarketPackage, TradeDecision, InterceptorContext } from '../server/interceptors.ts'
import { auditProposedLesson, loadLessons, resetToBaseline, proposeLesson, lessonEvidenceFromEvents } from '../server/evolutionShield.ts'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

console.log('\n[1/4] 风控 SSOT 与预设套件')

check('schema 覆盖全部环境键（无漂移）', () => {
  const s = schema()
  const keys = new Set(s.params.map((p) => p.key))
  const values = currentValues()
  for (const k of Object.keys(values)) {
    assert.ok(keys.has(k as never), `schema 缺少 ${k}`)
  }
  assert.ok(s.params.length > 20, 'schema 参数数量异常偏少')
})

check('三套预设均通过跨字段自洽校验', () => {
  assert.equal(SUITES.length, 3)
  for (const suite of SUITES) {
    const v = suite.values
    assert.ok(v.EV_BREAKEVEN_TRIGGER_R < v.EV_PROFIT_LOCK_TRIGGER_R, `${suite.id}: 保本必须先于棘轮`)
    assert.ok(v.EV_ATR_STOP_MULT_MIN <= v.EV_ATR_STOP_MULT_MAX, `${suite.id}: ATR 乘数区间倒置`)
    assert.ok(v.EV_MIN_LEVERAGE <= v.EV_MAX_LEVERAGE, `${suite.id}: 杠杆区间倒置`)
  }
})

check('稳健套件的风险敞口必须严格小于进取套件', () => {
  const c = suiteValues('conservative')
  const a = suiteValues('aggressive')
  assert.ok(c.EV_RISK_PER_TRADE_RATIO < a.EV_RISK_PER_TRADE_RATIO, '单笔风险未随档位放开')
  assert.ok(c.EV_MAX_SAME_DIRECTION_POSITIONS < a.EV_MAX_SAME_DIRECTION_POSITIONS, '同向仓上限未随档位放开')
  assert.equal(c.EV_MAX_SCALE_IN_COUNT, 0, '稳健档必须禁止加仓')
})

check('越界值被拒（fail-closed，不静默钳制）', () => {
  assert.throws(() => normalize({ EV_ATR_STOP_MULT_MIN: 99 }), /须在/)
  assert.throws(() => normalize({ EV_BREAKEVEN_TRIGGER_R: 2.5, EV_PROFIT_LOCK_TRIGGER_R: 1.5 }), /必须早于/)
  assert.throws(() => normalize({ EV_NOT_A_REAL_KEY: 1 }), /未知风控参数/)
  assert.throws(() => normalize({ EV_ATR_PERIOD: 'abc' }), /必须是数字/)
})

check('环境变量热重载可即时生效（无需重启）', () => {
  const original = process.env.EV_ATR_PERIOD
  const before = ATR_PERIOD
  process.env.EV_ATR_PERIOD = String(before + 7)
  reloadRiskConstants()
  assert.equal(ATR_PERIOD, before + 7, '热重载未改变进程内常量')
  // 同时校验「快照视图」与「活绑定」两条读路径没有跑偏：
  // currentRiskValues() 是给 /risk/schema 用的，若它读的是另一份缓存，
  // 就会出现面板显示新值、引擎跑旧值的静默分裂。
  assert.equal(
    currentRiskValues().EV_ATR_PERIOD,
    before + 7,
    '快照视图与活绑定不一致（面板会与引擎脱节）',
  )
  if (original === undefined) delete process.env.EV_ATR_PERIOD
  else process.env.EV_ATR_PERIOD = original
  reloadRiskConstants()
  assert.equal(ATR_PERIOD, before, '回滚后未恢复')
})

check('当前生效配置自洽（validateCurrent 返回空）', () => {
  assert.deepEqual(validateCurrent(), [])
})

console.log('\n[2/4] 止损几何引擎')

check('宽止损：ATR 乘数落在配置区间内', () => {
  const g = computeStopGeometry(78_000, 780)
  assert.ok(g.distance > 0)
  assert.ok(g.atrMultiplier > 0)
  const pct = g.distancePct
  assert.ok(pct > 0.001 && pct < 0.3, `止损幅度异常：${(pct * 100).toFixed(2)}%`)
})

check('多空止损方向正确（多单在下、空单在上）', () => {
  const g = computeStopGeometry(78_000, 780)
  assert.ok(deriveInitialStop('long', 78_000, g) < 78_000, '多单止损必须低于入场价')
  assert.ok(deriveInitialStop('short', 78_000, g) > 78_000, '空单止损必须高于入场价')
})

check('1R 不变量：任何情况下实际风险敞口都不超过单笔风险预算', () => {
  const equity = 100_000
  const budget = riskBudgetPerTrade(equity)
  // 覆盖从「极窄止损」到「极宽止损」的全谱，逐个校验同一个不变量
  for (const dist of [120, 400, 1_200, 3_900, 7_800, 20_000]) {
    const s = sizePositionFromRisk(equity, 78_000, dist, 0, 1)
    assert.ok(s.qty > 0, `止损距离 ${dist} 下无法开仓（约束：${s.bindingConstraint}）`)
    const actualRisk = s.qty * dist
    assert.ok(
      actualRisk <= budget * 1.001,
      `止损距离 ${dist}：实际风险 ${actualRisk.toFixed(2)} 超过 1R 预算 ${budget.toFixed(2)}`,
    )
    assert.ok(Math.abs(s.riskAmount - actualRisk) < 1e-6, 'riskAmount 与实际风险不一致')
  }
})

check('止损放宽时缩量（当风险预算成为约束时）', () => {
  // 止损距离需大于价格的 5%，风险预算才会比保证金帽更紧——
  // 这一条本身就是「为什么宽止损必须配小仓位」的量化解释。
  const equity = 100_000
  const tight = sizePositionFromRisk(equity, 78_000, 4_000, 0, 1)
  const wide = sizePositionFromRisk(equity, 78_000, 8_000, 0, 1)
  assert.equal(tight.bindingConstraint, 'risk_budget', `窄止损场景约束应为风险预算，实际 ${tight.bindingConstraint}`)
  assert.equal(wide.bindingConstraint, 'risk_budget', `宽止损场景约束应为风险预算，实际 ${wide.bindingConstraint}`)
  assert.ok(wide.qty < tight.qty, `止损放宽后仓位未缩小：${tight.qty} → ${wide.qty}`)
  // 风险金额应守恒
  assert.ok(Math.abs(tight.riskAmount - wide.riskAmount) < 1, '1R 金额未保持恒定')
})

check('保证金帽约束被如实标注（不谎报为风险预算约束）', () => {
  // 极窄止损下，风险预算允许的量远超保证金可承载量，此时应报告 margin_cap
  const s = sizePositionFromRisk(100_000, 78_000, 120, 0, 1)
  assert.equal(s.bindingConstraint, 'margin_cap', `实际约束标注为 ${s.bindingConstraint}`)
  const cap = (100_000 * 0.2) / 78_000
  assert.ok(Math.abs(s.qty - cap) < 1e-6, '受保证金帽约束时数量应恰好等于帽值')
})

check('0.8R 保本：盈利达标后止损移至成本上方（绝不亏损）', () => {
  resetGuard()
  const atr = 780
  const g = computeStopGeometry(78_000, atr)
  const pos = openPosition({ symbol: 'BTCUSDT', side: 'long', entryPrice: 78_000, qty: 1, atrValue: atr, now: Date.now() })
  const target = 78_000 + g.distance * BREAKEVEN_TRIGGER_R + 1
  const action = evaluatePosition(pos, { high: target, low: 78_000, close: target }, Date.now())
  assert.equal(action.action, 'move_stop')
  const moved = applyStopAction(pos, action)
  assert.ok(moved.currentStop >= 78_000, `保本止损必须不低于成本价，实际 ${moved.currentStop}`)
  assert.ok(moved.breakevenArmed, '保本标记未置位')
})

check('棘轮只上移绝不下移（锁利的物理保证）', () => {
  resetGuard()
  const atr = 780
  const pos = openPosition({ symbol: 'BTCUSDT', side: 'long', entryPrice: 78_000, qty: 1, atrValue: atr, now: Date.now() })
  const big = 78_000 + computeStopGeometry(78_000, atr).distance * PROFIT_LOCK_TRIGGER_R
  const a1 = evaluatePosition(pos, { high: big, low: 78_000, close: big }, Date.now())
  const p1 = a1.action === 'move_stop' ? applyStopAction(pos, a1) : pos
  const stopAfter1 = p1.currentStop
  // 价格回落到保本触发之前，止损不得被下调
  const a2 = evaluatePosition(p1, { high: 78_100, low: 78_000, close: 78_050 }, Date.now())
  const p2 = a2.action === 'move_stop' ? applyStopAction(p1, a2) : p1
  assert.ok(p2.currentStop >= stopAfter1, `止损被下调：${stopAfter1} → ${p2.currentStop}`)
})

check('R 倍数计算与几何一致', () => {
  resetGuard()
  const atr = 780
  const g = computeStopGeometry(78_000, atr)
  const pos = openPosition({ symbol: 'BTCUSDT', side: 'long', entryPrice: 78_000, qty: 1, atrValue: atr, now: Date.now() })
  const r1 = rMultiple(pos, 78_000 + g.distance)
  assert.ok(Math.abs(r1 - 1) < 0.02, `1 倍止损距离应等于 1R，实际 ${r1}`)
  assert.ok(rMultiple(pos, 78_000) === 0 || Math.abs(rMultiple(pos, 78_000)) < 0.01, '入场价处 R 应为 0')
})

check('1R 风险预算不超过权益的配置比例', () => {
  const equity = 100_000
  const budget = riskBudgetPerTrade(equity)
  assert.ok(budget > 0)
  assert.ok(budget <= equity * RISK_PER_TRADE_RATIO + 1e-6)
})

console.log('\n[3/4] Fail-Closed 拦截闸门')

/** 构造一个「无可挑剔」的行情包：任何一道闸门都不该因为它的字段缺失而误拦。 */
function pkg(over: Partial<MarketPackage> = {}): MarketPackage {
  return {
    symbol: 'BTCUSDT',
    dataQuality: 'valid',
    price: 78_000,
    atr: 780,
    bars: 999,
    adx1h: 26,
    macroTrend: 'RANGE',
    macroTrendSource: '4H 结构判定',
    ...over,
  }
}

/** 构造一个合法报价：止损与止盈都远离入场价，R:R 充足。 */
const validDecision: TradeDecision = {
  action: 'BUY_LONG',
  confidence: 90,
  entryPrice: 78_000,
  takeProfitPrice: 80_000,
  stopLossPrice: 77_000,
  strategyId: 'smoke',
}

/**
 * 一个「什么都不拦」的上下文。
 *
 * 覆盖参数刻意写成显式可选字段、并在返回时逐个填默认值，
 * 而不是 `{ ...defaults, ...over }` —— 后者会把可选字段以 `undefined` 的形式
 * 覆盖掉已填好的默认值，展开结果不再是合法的 InterceptorContext。
 */
function ctx(
  over: {
    killswitch?: boolean
    cooldownBlocked?: boolean
    dailyLoss?: number
    dailyLossLimit?: number
    openPositions?: { symbol: string; side: 'long' | 'short' }[]
  } = {},
): InterceptorContext {
  return {
    now: 1_700_000_000_000,
    equity: 100_000,
    killswitch: over.killswitch ?? false,
    openPositions: over.openPositions ?? [],
    cooldownBlocked: over.cooldownBlocked ?? false,
    dailyLoss: over.dailyLoss,
    dailyLossLimit: over.dailyLossLimit,
  }
}

check('拦截器清单非空且含强制地板', () => {
  resetInterceptors()
  const list = listInterceptors()
  assert.ok(list.length >= 9, `拦截器数量异常：${list.length}`)
  assert.ok(list.some((i) => i.mandatory), '缺少 mandatory 强制地板')
})

check('沙箱场景集全部符合预期', () => {
  resetInterceptors()
  const r = runSandboxTest()
  const bad = r.results.filter((x) => x.verdict !== 'pass')
  assert.equal(r.passed, r.total, `未通过场景：${bad.map((x) => `${x.name}(${x.verdict})`).join(', ')}`)
})

check('合法报价放行（不误杀）', () => {
  resetInterceptors()
  const r = runPipeline(pkg(), validDecision, ctx())
  assert.equal(r.finalAction, 'BUY_LONG', '合格报价不应被拦截')
  assert.ok(r.checked > 0 && r.total >= r.checked, '未如实统计通过闸门数')
})

check('强制地板不可被停用（接口层硬拒绝）', () => {
  resetInterceptors()
  const mand = listInterceptors().find((i) => i.mandatory)
  assert.ok(mand, '不存在 mandatory 拦截器，地板机制失效')
  assert.throws(() => setInterceptorEnabled(mand.id, false), /不可停用/)
  // 非强制项仍应可自由启停
  const soft = listInterceptors().find((i) => !i.mandatory)
  if (soft) {
    setInterceptorEnabled(soft.id, false)
    assert.equal(listInterceptors().find((i) => i.id === soft.id)?.enabled, false)
    setInterceptorEnabled(soft.id, true)
  }
  resetInterceptors()
})

check('熔断激活时一切开仓被拒', () => {
  resetInterceptors()
  const r = runPipeline(pkg(), validDecision, ctx({ killswitch: true }))
  assert.equal(r.finalAction, 'WAIT', 'killswitch 激活时必须拒绝开仓')
})

check('R:R 低于硬底线必被拦截', () => {
  resetInterceptors()
  // 止损 1000、止盈 1000 → R:R = 1.0，低于默认 2.0 底线
  const r = runPipeline(pkg(), { ...validDecision, takeProfitPrice: 79_000 }, ctx())
  assert.equal(r.finalAction, 'WAIT', `R:R=1.0 应被拦截（门槛 ${MIN_RISK_REWARD_RATIO}）`)
  assert.ok(r.blockedBy, '被拦截时必须给出归因')
})

console.log('\n[4/4] 自进化宪法红线')

check('确定性幻觉措辞被拦截', () => {
  const v = auditProposedLesson('只要出现金叉就一定必涨，直接满仓做多不要犹豫。', 50)
  assert.equal(v.passed, false, '「一定必涨」类表述必须拦截')
})

check('过度集中与豁免风控被拦截', () => {
  assert.equal(auditProposedLesson('随波逐流地全仓杀入做多，不用设止损。', 50).passed, false)
  assert.equal(auditProposedLesson('亏损以后加倍摊平，必然回本盈利。', 50).passed, false)
})

check('样本量不足被拒（防单次噪点入册）', () => {
  assert.equal(auditProposedLesson('当 4H ADX 高于 30 时允许顺势加仓一次。', 1).passed, false)
  assert.equal(auditProposedLesson('当 4H ADX 高于 30 时允许顺势加仓一次。', 30).passed, true)
})

check('官方基线心法不被红线误伤（进程能正常启动）', () => {
  const list = loadLessons()
  assert.ok(list.length >= 5, `基线心法缺失：${list.length}`)
  for (const l of list) {
    const v = auditProposedLesson(l.ruleText, l.sampleSize)
    assert.equal(v.passed, true, `基线心法 ${l.id} 被误判为有毒：${v.reason}`)
  }
})

// ── F-44：样本量不可自报 ──
// 原先 `proposeLesson` 吃的是调用方传的 `sampleSize`，HTTP 层更是
// `sampleSize: body.sampleSize ?? 0` —— 写 9999 就能把"单笔偶发插针"
// 登记成"9999 笔证据"，而门禁恒为真。与 F-41（自报 wfRobust）同病。

check('心法样本量不可自报（F-44）', () => {
  const base = '当 4H ADX 高于 30 时允许顺势加仓一次。'

  const forgedOnly = proposeLesson({ ruleText: base, category: 'RISK_CONTROL', sampleSize: 9999 } as never)
  assert.equal(forgedOnly.accepted, false, '只有自报 sampleSize、没有凭据的请求必须被拒')

  const foreignSource = proposeLesson({
    ruleText: base,
    category: 'RISK_CONTROL',
    evidence: { source: 'manual-review', tradeObservations: 9999 },
  } as never)
  assert.equal(foreignSource.accepted, false, '非账本来源的凭据必须被拒')

  const fractional = proposeLesson({
    ruleText: base,
    category: 'RISK_CONTROL',
    evidence: { source: 'audit-ledger', tradeObservations: 1.5 },
  } as never)
  assert.equal(fractional.accepted, false, '非整数观测数必须被拒')

  const negative = proposeLesson({
    ruleText: base,
    category: 'RISK_CONTROL',
    evidence: { source: 'audit-ledger', tradeObservations: -5 },
  } as never)
  assert.equal(negative.accepted, false, '负观测数必须被拒')
})

check('合法凭据可通过，且记录值取自凭据（F-44）', () => {
  const base = '当 4H ADX 高于 30 时允许顺势加仓一次。'
  const ok = proposeLesson({
    ruleText: base,
    category: 'RISK_CONTROL',
    evidence: { source: 'audit-ledger', tradeObservations: 30 },
  })
  assert.equal(ok.accepted, true, `合法凭据应被接受：${ok.reason}`)
  assert.equal(ok.lesson?.sampleSize, 30, '记录的样本量必须等于凭据里的观测数')
  assert.equal(ok.lesson?.evidence?.source, 'audit-ledger')

  // 观测数低于门槛 → 即便凭据合法也必须被拒（门槛真的能失败）
  const tooFew = proposeLesson({
    ruleText: base,
    category: 'RISK_CONTROL',
    evidence: { source: 'audit-ledger', tradeObservations: 1 },
  })
  assert.equal(tooFew.accepted, false, '成交观测仅 1 笔必须被拒（防单次噪点入册）')
})

check('未知心法类别被拒（不再 as never 静默接受）', () => {
  const v = proposeLesson({
    ruleText: '当 4H ADX 高于 30 时允许顺势加仓一次。',
    category: 'entry',
    evidence: { source: 'audit-ledger', tradeObservations: 30 },
  })
  assert.equal(v.accepted, false, "旧接口默认值 'entry' 不在合法枚举内，必须被拒而不是静默接受")
})

check('lessonEvidenceFromEvents 只数 ORDER_FILL', () => {
  const ev = lessonEvidenceFromEvents([
    { kind: 'ORDER_FILL' },
    { kind: 'ORDER_FILL' },
    { kind: 'RISK_REJECTED' },
    { kind: 'ORDER_FILL' },
  ])
  assert.equal(ev.source, 'audit-ledger')
  assert.equal(ev.tradeObservations, 3, '只应计入 ORDER_FILL')
  assert.equal(lessonEvidenceFromEvents([]).tradeObservations, 0, '空账本必须是 0 而不是别的数')
})

// ── 收尾：无论断言成败都把守卫与拦截器恢复到官方默认，避免污染后续测试 ──
resetGuard()
resetInterceptors()
resetToBaseline()

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log('✅ 风控内核烟测全部通过')
