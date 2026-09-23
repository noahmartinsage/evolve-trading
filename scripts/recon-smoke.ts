import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SandboxAdapter } from '../server/venue/sandbox.ts'
import { ExecutionGateway } from '../server/gateway/executor.ts'
import { runReconciliation, getLastReconciliation } from '../server/reconciliation.ts'
import { createState, submitToBroker } from '../server/orchEngine.ts'
import { initLedger } from '../server/ledger.ts'
import { isPersistent } from '../server/persistence.ts'
import type { OrchState } from '../server/types.ts'

// ★★ 隔离必须先于任何 `init*()`（判据 C10）。本烟测会走**真实的出网链路**，
//   于是需要一个属于自己的库：
//     ① 不污染用户正在运行的应用的真库（`data/orch.db`）；
//     ② 不被上次运行留下的 `in_flight` 行挡住 —— 幂等台账记下过的语义键
//        会被**正确地**再拦一次，那会让"手动清除后应当恢复"这条断言假红
//        （红在了"幂等生效"上，而它其实没坏）。
//   ★ 命名带 pid + 时间戳：天然是新文件，清理失败也不会让门禁变红。
process.env.ORCH_DB = join('data', `recon-smoke-${process.pid}-${Date.now()}.db`)

interface ReconRecord {
  startedAt: string
  scenarios: { name: string; pass: boolean; detail: string }[]
  finalReport: unknown
}

function fail(rec: ReconRecord, name: string, msg: string): never {
  rec.scenarios.push({ name, pass: false, detail: msg })
  archive(rec)
  console.error(`[FAIL] RECON SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(rec: ReconRecord, name: string, detail: string): void {
  rec.scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(rec: ReconRecord): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'recon-latest.json'), JSON.stringify({ ...rec, finishedAt: new Date().toISOString() }, null, 2))
}

async function main() {
  const rec: ReconRecord = { startedAt: new Date().toISOString(), scenarios: [], finalReport: null }

  // ★ `initLedger()` 必须在任何出网之前（判据 C10）：出网幂等的判据是**持久化**
  //   语义键台账，而台账在 `getDb() === null` 时**刻意 fail-closed**。
  //   ★ 忘了它的症状会伪装成"幂等生效" —— 第一笔就被拦、报文写"结果未知，去对账"，
  //     而真因是"库根本没打开"。两者动作相反，所以这里加一条前置断言把它们分开。
  initLedger()
  if (!isPersistent()) fail(rec, 'S0 台账可用', `持久层未就绪（ORCH_DB=${process.env.ORCH_DB}）⇒ 无法区分"幂等生效"与"根本没台账"`)
  pass(rec, 'S0 台账可用', `持久化意图台账就绪 · ${process.env.ORCH_DB}`)

  const state: OrchState = createState(100_000)
  const venue = new SandboxAdapter()
  const gw = new ExecutionGateway()
  gw.attachAdapter(venue)
  gw.completeRiskHandshake()

  state.lastPrice.set('TEST', 100)

  const r1res = submitToBroker(state, { clientOrderId: 'r1', symbol: 'TEST', side: 'buy', type: 'limit', price: 100, qty: 10 })
  if (r1res.status === 'rejected') fail(rec, 'S0 resting order', `rejected: ${r1res.status}`)
  venue.ingestTick('TEST', 100)

  const report1 = await runReconciliation(state, gw)
  if (!report1.consistent) {
    fail(rec, 'S1 consistency baseline', `initial recon inconsistent: cashDelta=${report1.cashDeltaAbs} deltas=${JSON.stringify(report1.positionDeltas)}`)
  }
  pass(rec, 'S1 consistency baseline', `cash delta $${report1.cashDeltaAbs}`)

  state.balanceUSDC += 500
  const report2 = await runReconciliation(state, gw)
  if (report2.consistent) fail(rec, 'S2 cash mismatch detection', '+$500 injection not detected')
  if (report2.action !== 'venue_outbound_disabled') fail(rec, 'S2 cash mismatch detection', `outbound not disabled: ${report2.action}`)
  const st2 = gw.status()
  if (st2.venueOutboundDisabledReason === null) fail(rec, 'S2 cash mismatch detection', 'gateway disable reason missing')
  const blocked = await gw.submit({ clientOrderId: 'post-mismatch', symbol: 'TEST', side: 'buy', type: 'limit', price: 100, qty: 1, mode: 'live' })
  if (blocked.ok || !blocked.reason?.startsWith('VENUE_OUTBOUND_DISABLED')) {
    fail(rec, 'S2 cash mismatch detection', `outbound not blocked after mismatch: ${JSON.stringify(blocked)}`)
  }
  pass(rec, 'S2 mismatch -> auto outbound stop', `cashDelta=$${report2.cashDeltaAbs} + live submit VENUE_OUTBOUND_DISABLED`)

  state.balanceUSDC -= 500
  gw.setVenueOutboundDisabled(null)
  const report3 = await runReconciliation(state, gw)
  if (!report3.consistent) fail(rec, 'S3 heal and resume', `still inconsistent after fix`)
  const unblocked = await gw.submit({ clientOrderId: 'post-heal', symbol: 'TEST', side: 'sell', type: 'market', qty: 0.001, mode: 'live' })
  if (!unblocked.ok) fail(rec, 'S3 heal and resume', `still rejected after manual clear: ${JSON.stringify(unblocked)}`)
  pass(rec, 'S3 heal and resume', 'manual clear restores outbound')

  const last = getLastReconciliation()
  if (!last || last.ts < Date.now() - 60_000) fail(rec, 'S4 report retention', 'lastReport missing or stale')
  rec.finalReport = last

  archive(rec)
  console.log('')
  console.log('[ARCHIVED] artifacts/recon-latest.json')
  console.log(`scenarios ${rec.scenarios.filter((x) => x.pass).length}/${rec.scenarios.length} passed`)
  console.log('RECONCILIATION SMOKE PASSED')
}

main().catch((e) => {
  console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
