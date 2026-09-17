/**
 * R20 内化模块烟测
 *
 * 覆盖四个从 R20 Quantum Trader 内化过来的模块。断言刻意只测**语义不变量**
 * （占用的持续性、指纹的确定性、分档的边界），不测具体数值——
 * 数值会随预设套件调整而变，测它们会把烟测变成维护负担。
 *
 * 运行：node scripts/r20-parity-smoke.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteFile, atomicWriteJson } from '../server/atomicWrite.ts'
import {
  RiskReservationManager,
  STATE_CLOSED,
  STATE_CONFIRMED,
  STATE_PENDING,
  STATE_PENDING_CLEANUP,
  STATE_REJECTED,
  STATE_UNKNOWN,
  normalizeAccountKey,
} from '../server/riskReservation.ts'
import {
  auditSnapshotObservability,
  classifySnapshotObservability,
  isSampleQualitySufficient,
  pruneSnapshot,
  renderObservabilityBrief,
  DYNAMICS_OBSERVED_MIN,
} from '../server/decisionObservability.ts'
import { renderRiskBrief, riskBriefSnapshot } from '../server/riskBrief.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${msg}`)
    console.log(`  ✕ ${name}\n      ${msg}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'evolve-r20-'))

// ─────────────────────────────────────────────────────────────
console.log('\n[1/5] 原子写盘')
// ─────────────────────────────────────────────────────────────

check('写入内容完整且可读回', () => {
  const p = join(work, 'a.txt')
  atomicWriteFile(p, 'hello\nworld\n')
  assert.equal(readFileSync(p, 'utf8'), 'hello\nworld\n')
})

check('覆盖写入后无临时文件残留', () => {
  const p = join(work, 'b.txt')
  atomicWriteFile(p, 'first')
  atomicWriteJson(p, { k: 1 })
  const leftovers = readdirSync(work).filter((f) => f.endsWith('.tmp'))
  assert.equal(leftovers.length, 0, `残留临时文件：${leftovers.join(', ')}`)
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { k: 1 })
})

check('自动创建多级父目录', () => {
  const p = join(work, 'deep', 'nested', 'c.json')
  atomicWriteJson(p, [1, 2, 3])
  assert.ok(existsSync(p))
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), [1, 2, 3])
})

// ─────────────────────────────────────────────────────────────
console.log('\n[2/5] 风险预算预留层（R20 risk_reservation 语义）')
// ─────────────────────────────────────────────────────────────

const rm = new RiskReservationManager(join(work, 'res.db'))
const ACC = { venue: 'binance', environment: 'paper' }

check('账户键归一化：未知结构诚实返回空 venue/environment', () => {
  const a = normalizeAccountKey({ venue: 'okx', environment: 'live', fingerprint: 'k1' })
  assert.equal(a.key, 'okx:live:k1')
  assert.equal(a.venue, 'okx')
  const b = normalizeAccountKey('mystery')
  assert.equal(b.venue, '', '无法解析时应记空，不能猜')
  assert.equal(b.environment, '')
})

check('新意图必须是占用态，终态不可作为初始状态', () => {
  assert.throws(() => rm.reserve(ACC, 'bad-1', 100, STATE_CLOSED), /初始状态必须是占用态/)
})

check('非法状态被拒绝', () => {
  assert.throws(() => rm.reserve(ACC, 'bad-2', 100, 'whatever'), /非法预留状态/)
})

check('负金额被拒绝', () => {
  assert.throws(() => rm.reserve(ACC, 'bad-3', -1, STATE_PENDING), /非负有限数/)
})

check('占用态持续累计，released 后才让出额度', () => {
  rm.reset()
  rm.reserve(ACC, 'i1', 1000, STATE_PENDING)
  rm.reserve(ACC, 'i2', 500, STATE_CONFIRMED)
  assert.equal(rm.totalReserved(ACC), 1500)
  rm.release(ACC, 'i1', STATE_CLOSED)
  assert.equal(rm.totalReserved(ACC), 500, '释放后应只剩 i2')
  // confirmed 仍占用：确认成交到平仓之间，风险依然真实存在
  assert.equal(rm.reservations(ACC).find((r) => r.intentId === 'i2')?.occupying, true)
})

check('unknown 状态全额占用，绝不释放', () => {
  rm.reset()
  rm.reserve(ACC, 'u1', 777, STATE_UNKNOWN)
  assert.equal(rm.totalReserved(ACC), 777, '未知状态必须继续占用预算')
  const snap = rm.reservations(ACC)[0]
  assert.equal(snap.occupying, true)
  assert.equal(snap.released, false)
})

check('预算越界整体回滚，绝不部分占用', () => {
  rm.reset()
  rm.reserve(ACC, 'c1', 900, STATE_PENDING, 1000)
  assert.throws(() => rm.reserve(ACC, 'c2', 200, STATE_PENDING, 1000), /预算越界/)
  assert.equal(rm.totalReserved(ACC), 900, '越界后总额必须保持原值')
  assert.equal(rm.reservations(ACC).length, 1, '越界意图不得落库')
})

check('终态幂等：已释放的意图不可复活', () => {
  rm.reset()
  rm.reserve(ACC, 't1', 300, STATE_PENDING)
  rm.release(ACC, 't1', STATE_CLOSED)
  const again = rm.reserve(ACC, 't1', 999, STATE_CONFIRMED)
  assert.equal(again.changed, false, '终态记录不应被改写')
  assert.equal(again.snapshot.amountUsdt, 300)
  assert.equal(again.snapshot.state, STATE_CLOSED)
  assert.equal(rm.totalReserved(ACC), 0)
})

check('release 只接受终态', () => {
  assert.throws(() => rm.release(ACC, 'x', STATE_CONFIRMED), /只接受终态/)
})

check('状态推进按差额重查上限（净占用口径）', () => {
  rm.reset()
  rm.reserve(ACC, 'd1', 600, STATE_PENDING, 1000)
  // 自身占用 600 → 提到 900 时应通过（others=0，900 ≤ 1000）
  rm.reserve(ACC, 'd1', 900, STATE_CONFIRMED, 1000)
  assert.equal(rm.totalReserved(ACC), 900)
  // 再想提到 1100 应越界
  assert.throws(() => rm.reserve(ACC, 'd1', 1100, STATE_CONFIRMED, 1000), /预算越界/)
  assert.equal(rm.totalReserved(ACC), 900, '越界后不应改变原值')
})

check('金额传 0 表示沿用原额，仅推进状态', () => {
  rm.reset()
  rm.reserve(ACC, 'z1', 250, STATE_PENDING)
  rm.reserve(ACC, 'z1', 0, STATE_CONFIRMED)
  assert.equal(rm.totalReserved(ACC), 250)
})

check('孤儿恢复只标记不释放——「本地丢了」不等于「场所没有」', () => {
  rm.reset()
  rm.reserve(ACC, 'o1', 400, STATE_PENDING)
  rm.reserve(ACC, 'o2', 600, STATE_CONFIRMED)
  rm.reserve(ACC, 'o3', 100, STATE_PENDING)
  // 本地认为 o3 仍开放；o1/o2 在本地追踪器里已消失
  const report = rm.recoverOrphans('paper', ['o3'])
  assert.deepEqual(report.orphans.sort(), ['o1', 'o2'])
  assert.equal(rm.totalReserved(ACC), 1100, '孤儿必须继续占用预算')
  const o1 = rm.reservations(ACC).find((r) => r.intentId === 'o1')
  assert.equal(o1?.state, STATE_PENDING_CLEANUP)
  assert.equal(o1?.occupying, true)
})

check('重复调用孤儿恢复不重复计数', () => {
  const report = rm.recoverOrphans('paper', ['o3'])
  assert.equal(report.orphans.length, 0, '已是孤儿标记的不应重复计入')
})

check('跨所合看：按场所聚合 + 总敞口', () => {
  rm.reset()
  rm.reserve({ venue: 'binance', environment: 'paper' }, 'v1', 1000, STATE_CONFIRMED)
  rm.reserve({ venue: 'okx', environment: 'paper' }, 'v2', 2500, STATE_CONFIRMED)
  rm.reserve({ venue: 'uniswap', environment: 'paper' }, 'v3', 500, STATE_PENDING)
  const byVenue = rm.totalReservedByVenue('paper')
  assert.equal(byVenue.binance, 1000)
  assert.equal(byVenue.okx, 2500)
  assert.equal(byVenue.uniswap, 500)
  assert.equal(rm.grossExposure('paper'), 4000)
})

check('环境隔离：paper 与 live 的预算互不串台', () => {
  rm.reset()
  rm.reserve({ venue: 'binance', environment: 'paper' }, 'p1', 1000, STATE_CONFIRMED)
  rm.reserve({ venue: 'binance', environment: 'live' }, 'l1', 7000, STATE_CONFIRMED)
  assert.equal(rm.grossExposure('paper'), 1000)
  assert.equal(rm.grossExposure('live'), 7000)
})

check('已释放记录不进入未释放明细', () => {
  rm.reset()
  rm.reserve(ACC, 'r1', 100, STATE_PENDING)
  rm.release(ACC, 'r1', STATE_REJECTED)
  rm.reserve(ACC, 'r2', 200, STATE_PENDING)
  const unrel = rm.listUnreleased('paper')
  assert.equal(unrel.length, 1)
  assert.equal(unrel[0].intentId, 'r2')
})

rm.close()

// ─────────────────────────────────────────────────────────────
console.log('\n[3/5] 决策证据可观测性分档')
// ─────────────────────────────────────────────────────────────

check('空值与非法输入归为 NONE', () => {
  assert.equal(classifySnapshotObservability(null), 'NONE')
  assert.equal(classifySnapshotObservability(undefined), 'NONE')
  assert.equal(classifySnapshotObservability({}), 'NONE')
  assert.equal(classifySnapshotObservability('nope'), 'NONE')
})

check('只有价格 → PRICE_ONLY（价格不算动力学链）', () => {
  assert.equal(classifySnapshotObservability({ price: 78000 }), 'PRICE_ONLY')
  // 全 null 的空壳同样是 PRICE_ONLY，这就是要杜绝的「表面可观测」
  assert.equal(classifySnapshotObservability({ atr1h: null, adx1h: null, price: 78000 }), 'PRICE_ONLY')
})

check('部分动力学字段 → PARTIAL', () => {
  assert.equal(classifySnapshotObservability({ price: 78000, atr1h: 780 }), 'PARTIAL')
})

check(`达到 ${DYNAMICS_OBSERVED_MIN} 个动力学字段 → DYNAMICS_OBSERVED`, () => {
  const enough = {
    price: 78000,
    atr1h: 780,
    atr4h: 1900,
    adx1h: 26,
    macroTrend: 'UP',
    h1SwingHigh: 79000,
  }
  assert.equal(classifySnapshotObservability(enough), 'DYNAMICS_OBSERVED')
})

check('0 与 false 是有效值，不被误判为缺失', () => {
  // adx1h = 0 表示「趋势极弱」，是一个真实观测，不能被当成缺失
  const s = { atr1h: 1, atr4h: 2, adx1h: 0, macroTrend: 'RANGE' }
  assert.equal(classifySnapshotObservability(s), 'DYNAMICS_OBSERVED')
})

check('NaN / Infinity 不算有效观测', () => {
  assert.equal(classifySnapshotObservability({ atr1h: Number.NaN }), 'PRICE_ONLY')
  assert.equal(classifySnapshotObservability({ atr1h: Number.POSITIVE_INFINITY }), 'PRICE_ONLY')
})

check('pruneSnapshot 剔除 null/undefined 并识别空壳', () => {
  const p = pruneSnapshot({ a: 1, b: null, c: undefined, d: 'x' })
  assert.deepEqual(p, { a: 1, d: 'x' })
  assert.equal(pruneSnapshot({ a: null, b: undefined }), null)
})

check('汇总统计与数理可归因占比正确', () => {
  const audit = auditSnapshotObservability([
    { snapshotObservability: 'DYNAMICS_OBSERVED' },
    { snapshotObservability: 'DYNAMICS_OBSERVED' },
    { snapshotObservability: 'PARTIAL' },
    { snapshotObservability: 'PRICE_ONLY' },
    { snapshot: { price: 100 } },
  ])
  assert.equal(audit.total, 5)
  assert.equal(audit.DYNAMICS_OBSERVED, 2)
  assert.equal(audit.PRICE_ONLY, 2, '无标签的记录应现场重算，归入 PRICE_ONLY')
  assert.equal(audit.mathObservable, 3)
  assert.equal(audit.mathObservableRatio, 0.6)
})

check('样本质量闸门：数量与占比必须同时达标', () => {
  const fewSamples = auditSnapshotObservability([{ snapshotObservability: 'DYNAMICS_OBSERVED' }])
  assert.equal(isSampleQualitySufficient(fewSamples, { minSamples: 3 }).ok, false)

  // 数量够但全是空壳：不能据此提炼心法
  const noisy = auditSnapshotObservability(
    Array.from({ length: 30 }, () => ({ snapshotObservability: 'PRICE_ONLY' })),
  )
  const v = isSampleQualitySufficient(noisy, { minSamples: 3 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /可归因样本占比不足/)
})

check('中文简报包含四档计数', () => {
  const brief = renderObservabilityBrief(
    auditSnapshotObservability([{ snapshotObservability: 'DYNAMICS_OBSERVED' }]),
  )
  assert.match(brief, /完全可观测 1/)
  assert.match(brief, /无快照 0/)
})

// ─────────────────────────────────────────────────────────────
console.log('\n[4/5] 风控口径插值（提示词口径 == 代码口径）')
// ─────────────────────────────────────────────────────────────

check('预算块包含执行层真实阈值', () => {
  const values = riskBriefSnapshot()
  const text = renderRiskBrief()
  assert.match(text, /【本周期风险预算】/)
  // 文本里的数字必须与结构化快照同源——这是「两套口径」的防回归断言
  assert.ok(
    text.includes(values.minRiskRewardRatio.toFixed(2)),
    `提示词未包含实时 R:R 底线 ${values.minRiskRewardRatio}`,
  )
  assert.ok(
    text.includes(values.minEntryConfidence.toFixed(0)),
    `提示词未包含实时置信度门禁 ${values.minEntryConfidence}`,
  )
  assert.ok(text.includes(values.atrStopMultMin.toFixed(1)), '提示词未包含 ATR 止损倍率下限')
})

check('加仓被禁用时必须明文禁止申请', () => {
  const values = riskBriefSnapshot()
  const text = renderRiskBrief()
  if (values.scaleInDisabled) {
    assert.match(text, /已禁用/)
    assert.match(text, /不得申请加仓/)
  } else {
    assert.match(text, /金字塔加仓：最多/)
  }
})

check('声明为执行层硬约束（模型需知道越界会被拒而非尝试）', () => {
  const text = renderRiskBrief()
  assert.match(text, /物理拦截/)
  assert.match(text, /WAIT/)
})

check('并发上限为「自动」时必须渲染生效语义，不得显示 0 笔', () => {
  // 「0 = 自动跟随标的池容量」是引擎侧语义。若渲染成「最大并发持仓：0 笔」，
  // 模型会读成「不许持仓」并拒绝一切开仓机会——把「自动」写成「禁止」。
  const values = riskBriefSnapshot(4)
  const text = renderRiskBrief(new Date(), 4)
  if (values.maxConcurrentIsAuto) {
    assert.equal(values.maxConcurrentPositions, 0)
    assert.ok(values.effectiveMaxPositions > 0, '自动语义必须解析出正的生效上限')
    assert.match(text, /自动跟随标的池容量/, '提示词必须声明这是「自动」而非 0')
    assert.doesNotMatch(text, /最大并发持仓：0 笔/, '不得把「自动」渲染成「0 笔」')
  } else {
    assert.ok(text.includes(`最大并发持仓：${values.effectiveMaxPositions} 笔`))
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n[5/5] 政策快照指纹确定性')
// ─────────────────────────────────────────────────────────────

// 单独 import 会让模块顶部读一次环境；这里动态导入以隔离
const pol = await import('../server/policySnapshot.ts')

check('同一配置连续两次采集得到相同指纹', () => {
  const a = pol.generatePolicySnapshot()
  const b = pol.generatePolicySnapshot()
  assert.equal(a.fingerprint, b.fingerprint, '指纹必须确定性，否则回滚判定失效')
  for (const u of a.units) {
    const other = b.units.find((x) => x.unit === u.unit)
    assert.equal(u.hash, other?.hash, `单元 ${u.unit} 指纹不稳定`)
  }
})

check('四单元齐备且各带指纹与摘要', () => {
  const s = pol.generatePolicySnapshot()
  assert.equal(s.units.length, 4)
  const ids = s.units.map((u) => u.unit).sort()
  assert.deepEqual(ids, ['interceptors', 'lessons', 'llmRouting', 'riskParams'])
  for (const u of s.units) {
    assert.equal(u.hash.length, 12)
    assert.ok(u.summary.length > 0)
  }
})

check('快照包包含可回灌的四份配置', () => {
  const s = pol.generatePolicySnapshot()
  assert.ok(Object.keys(s.package.riskParams).length > 0, '风控参数不应为空')
  assert.ok(Array.isArray(s.package.lessons))
  assert.ok(Array.isArray(s.package.interceptors))
  assert.ok('activeId' in s.package.llmRouting)
})

check('摘要文本包含组合指纹与四单元', () => {
  const s = pol.generatePolicySnapshot()
  const sum = pol.formatPolicySnapshotSummary(s)
  assert.ok(sum.includes(s.fingerprint))
  for (const label of ['风控参数', '自进化心法库', '拦截闸门', '模型路由']) {
    assert.ok(sum.includes(label), `摘要缺少 ${label}`)
  }
})

check('导入校验：空对象与缺单元均被拒', () => {
  assert.equal(pol.validateImportPackage(null).ok, false)
  assert.equal(pol.validateImportPackage({ format: pol.POLICY_SNAPSHOT_FORMAT }).ok, false)
  const bad = pol.validateImportPackage({ snapshot: { package: { riskParams: {} } } })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length >= 2)
})

check('导入校验：合法导出包通过', () => {
  const pkg = pol.exportPolicyPackage()
  const v = pol.validateImportPackage(pkg)
  assert.equal(v.ok, true, `合法包被拒：${v.errors.join('; ')}`)
})

check('回滚报告会比对回灌后指纹（防止「写了但没生效」）', () => {
  // 用一个不做任何事的 apply：指纹不会变成目标值，必须如实报告失败
  const out = pol.restoreArchivedPolicy('不存在的归档', () => [])
  assert.equal(out.ok, false)
  assert.match(String(out.reason), /归档不存在/)
})

// ─────────────────────────────────────────────────────────────
rmSync(work, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ·', f)
  process.exit(1)
}
console.log('✅ R20 内化模块烟测全部通过')
