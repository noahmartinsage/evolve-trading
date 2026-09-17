import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SandboxAdapter } from '../server/venue/sandbox.ts'
import { ExecutionGateway } from '../server/gateway/executor.ts'
import { runReconciliation, getLastReconciliation } from '../server/reconciliation.ts'
import { createState, submitToBroker } from '../server/orchEngine.ts'
import type { OrchState } from '../server/types.ts'

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
