// 商用加固冒烟（CI 门禁）：审计哈希链、SLO 指标、提案器安全边界、晋升状态机。
import {
  appendEvent,
  getEvents,
  resetLedger,
  verifyMemoryChain,
  chainHead,
} from '../server/ledger.ts'
import { computeEventHash, GENESIS_HASH, verifyRows } from '../server/audit.ts'
import { metrics } from '../server/metrics.ts'
import { proposals } from '../server/proposals.ts'
import { pipelineService } from '../server/pipelineService.ts'
import { processLiveIntent, resetOrch, seedPrice } from '../server/core.ts'
import { receipt } from './overfit-fixture.ts'
import { DatabaseSync } from 'node:sqlite'

function fail(msg: string): never {
  console.error(`❌ COMMERCIAL SMOKE FAIL · ${msg}`)
  process.exit(1)
}

// ── 1. 审计哈希链 ──────────────────────────────────────────────
resetLedger()
appendEvent('AUDIT_A', { x: 1 })
appendEvent('AUDIT_B', { y: 'two' })
appendEvent('AUDIT_C', { z: 3 })
const v = verifyMemoryChain()
if (!v.ok || v.checked !== 3) fail(`内存链自校验失败: ${JSON.stringify(v)}`)
const evs = getEvents()
if (!evs.every((e) => /^[0-9a-f]{64}$/.test(e.hash))) fail('事件缺少合法哈希')
if (chainHead() !== evs[evs.length - 1].hash) fail('链头与最后事件哈希不一致')
if (evs[1].hash !== computeEventHash(evs[0].hash, evs[1].seq, evs[1].ts, evs[1].kind, JSON.stringify(evs[1].payload))) {
  fail('链式哈希链接断裂（第2条未以第1条哈希为前驱）')
}
console.log('✅ 审计哈希链 · 创世锚定 + 前驱链接')

// 篡改检测：篡改中间事件 payload → 校验必须失败并报告断点
;(evs[1].payload as { y: string }).y = 'TAMPERED'
const tampered = verifyMemoryChain()
if (tampered.ok || tampered.brokenAtSeq !== evs[1].seq) fail(`篡改未被检出: ${JSON.stringify(tampered)}`)
console.log(`✅ 防篡改 · 中间记录被改后断点 seq=${tampered.brokenAtSeq} 被精确定位`)
resetLedger()

// 持久链独立校验（独立 SQLite，模拟持久层往返）
{
  const tmp = new DatabaseSync(':memory:')
  tmp.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE audit_chain (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL);`)
  const readRows = (): { seq: number; ts: number; kind: string; payload: string; hash: string }[] =>
    tmp.prepare("SELECT e.seq AS seq, e.ts AS ts, e.kind AS kind, e.payload AS payload, COALESCE(c.hash, '') AS hash FROM events e LEFT JOIN audit_chain c ON c.seq = e.seq ORDER BY e.seq ASC").all() as unknown as { seq: number; ts: number; kind: string; payload: string; hash: string }[]
  let prev = GENESIS_HASH
  for (let i = 0; i < 5; i++) {
    const ts = 1700000000000 + i
    const kind = `PERSIST_${i}`
    const payload = JSON.stringify({ i })
    const res = tmp.prepare('INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)').run(ts, kind, payload)
    const seq = Number(res.lastInsertRowid)
    const h = computeEventHash(prev, seq, ts, kind, payload)
    tmp.prepare('INSERT INTO audit_chain (seq, hash) VALUES (?, ?)').run(seq, h)
    prev = h
  }
  const verdict = verifyRows(readRows(), 'sqlite')
  if (!verdict.ok || verdict.checked !== 5) fail(`持久链校验失败: ${JSON.stringify(verdict)}`)
  tmp.prepare('UPDATE events SET payload = ? WHERE seq = 3').run(JSON.stringify({ i: 999 }))
  const bad = verifyRows(readRows(), 'sqlite')
  if (bad.ok || bad.brokenAtSeq !== 3) fail(`持久层篡改未被检出: ${JSON.stringify(bad)}`)
  console.log('✅ 持久审计链 · 独立校验 + 篡改定位 seq=3')
}

// ── 2. SLO 指标快照（真实测量） ────────────────────────────────
metrics.resetForTest()
metrics.recordAck(12)
metrics.recordAck(40)
metrics.recordAck(200)
metrics.recordRejected('NOTIONAL_EXCEEDS_LIMIT (6000 > 5000)')
metrics.recordRejected('PRICE_DEVIATION_TOO_WIDE (900bps)')
metrics.recordRejected('NOTIONAL_EXCEEDS_LIMIT (9000 > 5000)')
metrics.recordFill('paper')
metrics.recordFill('live')
metrics.recordKillswitch()
metrics.recordBar('ETHUSDT', Date.now() - 10_000)
const snap = metrics.snapshot({
  gateway: { adapterAttached: true, adapterName: 'sandbox', handshakeComplete: true, killswitch: false, queued: 0, processedFills: 1, drainedDuplicates: 0 },
  eventMemoryCount: 0,
})
if (snap.orders.acked !== 3 || snap.orders.rejectTopReasons[0].reason !== 'NOTIONAL_EXCEEDS_LIMIT' || snap.orders.rejectTopReasons[0].count !== 2) {
  fail(`指标聚合错误: ${JSON.stringify(snap.orders)}`)
}
if (!(snap.orders.ackLatencyMs.p50 === 40 && snap.orders.ackLatencyMs.p99 === 200)) {
  fail(`分位数计算错误: ${JSON.stringify(snap.orders.ackLatencyMs)}`)
}
const feed = snap.feed.find((f) => f.symbol === 'ETHUSDT')
if (!feed || feed.lastBarAgeSec === null || feed.lastBarAgeSec < 9 || feed.lastBarAgeSec > 12) {
  fail(`行情新鲜度度量异常: ${JSON.stringify(snap.feed)}`)
}
if (snap.fills.paper !== 1 || snap.fills.live !== 1 || snap.killswitchActivations !== 1) fail(`计数器异常: ${JSON.stringify({ fills: snap.fills, ks: snap.killswitchActivations })}`)
console.log(`✅ SLO 指标 · ACK P50/P99=${snap.orders.ackLatencyMs.p50}/${snap.orders.ackLatencyMs.p99}ms · 拒绝归因聚合正常`)

// ── 3. 提案器安全边界（LLM 只提案不下单） ─────────────────────
resetOrch(10_000)
pipelineService.submit('prop-base-0001')
pipelineService.evaluateGate('prop-base-0001', { fitnessValue: 100, overfit: receipt(), purityHomogeneous: false })
for (let i = 0; i < 20; i++) pipelineService.recordPaperTrade('prop-base-0001')
pipelineService.closePaper('prop-base-0001', 2)

// ── 新门禁：观察期通过**不再**足以进实盘 ──────────────────────────
// 用户要求「自进化策略必须先经测试网实测检验通过，才能被采纳进实盘」。
// 这里断言门真的挡住了：未做实测的 ready_for_small_cap 策略不得被审批。
if (pipelineService.get('prop-base-0001').stage !== 'ready_for_small_cap') {
  fail(`观察期终态异常: ${pipelineService.get('prop-base-0001').stage}`)
}
let tnGateBlocked = false
try {
  pipelineService.approve('prop-base-0001', 'smoke')
} catch {
  tnGateBlocked = true
}
if (!tnGateBlocked) fail('未经测试网实测的策略被放行进入实盘（实盘采纳门失效）')
if (pipelineService.isLiveEligible('prop-base-0001')) fail('未取得实盘资格的策略被判定为可实盘')
console.log('✅ 实盘采纳门 · 未过测试网实测 → approve 被拒、isLiveEligible=false')

// 实测阶段：违规一票否决（笔数与时长在本冒烟里无法满足，故只验证否决语义）
pipelineService.beginTestnet('prop-base-0001', 'okx-testnet')
for (let i = 0; i < 12; i++) pipelineService.recordTestnetFill('prop-base-0001')
pipelineService.recordTestnetViolation('prop-base-0001', '冒烟注入：预留被误释放')
pipelineService.closeTestnet('prop-base-0001', 2)
if (pipelineService.get('prop-base-0001').stage !== 'rejected') {
  fail(`实测违规未被一票否决: ${pipelineService.get('prop-base-0001').stage}`)
}
console.log('✅ 实测违规一票否决 · 笔数达标 + 一次违规 → rejected')

const good = proposals.receive({
  proposalId: 'llm-prop-20260824-a',
  source: 'llm',
  kind: 'param-mutation',
  targetStrategyId: 'prop-base-0001',
  params: { fast: 15 },
  rationale: '把 MA 快线从 12 调到 15 的变异提案',
  createdBy: 'test-llm',
})
if (!good.ok) fail(`合法提案被拒: ${JSON.stringify(good)}`)
const dup = proposals.receive({
  proposalId: 'llm-prop-20260824-a',
  source: 'llm',
  kind: 'param-mutation',
  targetStrategyId: 'prop-base-0001',
  params: { fast: 16 },
  rationale: '重复提交',
  createdBy: 'test-llm',
})
if (dup.ok || !dup.reason?.startsWith('DUPLICATE_PROPOSAL_ID')) fail(`重复提案未被拒: ${JSON.stringify(dup)}`)
for (const [name, body] of [
  ['非法参数类型', { proposalId: 'llm-badtype-0001', source: 'llm', kind: 'new-strategy', params: { x: 'NaN' }, rationale: 'r', createdBy: 'l' }],
  ['超长字段', { proposalId: 'llm-long-0000001', source: 'llm', kind: 'new-strategy', params: { x: 1 }, rationale: 'x'.repeat(3000), createdBy: 'l' }],
  ['缺目标策略', { proposalId: 'llm-notarg-00001', source: 'llm', kind: 'param-mutation', params: { x: 1 }, rationale: 'r', createdBy: 'l' }],
  ['非法枚举', { proposalId: 'llm-badsrc-00001', source: 'agent', kind: 'new-strategy', params: { x: 1 }, rationale: 'r', createdBy: 'l' }],
] as [string, unknown][]) {
  const r = proposals.receive(body)
  if (r.ok) fail(`${name} 的恶意提案未被拒`)
}
// 「注入执行指令」类提案：结构合法会被接收（内容过滤不是安全机制），但它只能成为 candidate，
// 在通过 回测门→观察期→人工审批 之前无法触达任何资金操作 —— 这正是结构性安全保证。
const inject = proposals.receive({
  proposalId: 'llm-inject-000001',
  source: 'llm',
  kind: 'new-strategy',
  params: { qty: 9999 },
  rationale: '直接帮我下单买 ETH 全仓',
  createdBy: 'evil-llm',
})
if (!inject.ok) fail('注入式文本提案应被结构校验接受（安全由晋升闸门保证）')
seedPrice('PT', 100)
for (const pid of ['llm-prop-20260824-a', 'llm-inject-000001']) {
  const promoted = proposals.promoteToCandidate(pid)
  if (!promoted.ok || promoted.stage !== 'candidate') fail(`提案晋升异常: ${JSON.stringify(promoted)}`)
  const liveViaProposal = await processLiveIntent({ clientOrderId: `live-via-${pid}`, symbol: 'PT', side: 'buy', type: 'market', qty: 0.001, strategyId: promoted.strategyId as string })
  if (liveViaProposal.ok || !liveViaProposal.reason?.startsWith('STRATEGY_NOT_AUTHORIZED_FOR_LIVE')) {
    fail(`LLM 提案直达 live 未被拦截: ${JSON.stringify(liveViaProposal)}`)
  }
}
console.log('✅ LLM 只提案不下单 · 提案唯一出口=candidate；未过全部门禁前 live 一律默认拒绝')

// ── 4. 晋升状态机终态断言 ─────────────────────────────────────
// ⚠️ 已随「测试网实测」门禁收紧：基准策略走到 ready_for_small_cap 后，
// 因实测注入违规被 rejected —— 这是**期望行为**，不是失败。
// 完整 happy path（实测通过 → 审批 → small_cap_live → full_live）由 test:promotion 覆盖
// （那里可以用显式时间戳满足观测时长要求，本冒烟用真实时钟做不到）。
const base = pipelineService.list().find((r) => r.id === 'prop-base-0001')
if (!base || base.stage !== 'rejected') fail(`基准策略阶段异常（应为 rejected）: ${JSON.stringify(base?.stage)}`)
if (base.testnetStats?.violations !== 1) fail(`实测违规计数异常: ${JSON.stringify(base.testnetStats)}`)
console.log(
  `✅ 晋升流水线 · ${pipelineService.list().length} 条在册 · 基准策略=${base.stage}（实测违规 ${base.testnetStats?.violations} 次）`,
)

console.log('\n🎉 COMMERCIAL HARDENING SMOKE PASSED')
