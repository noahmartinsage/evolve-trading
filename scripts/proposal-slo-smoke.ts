import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getOrchState, resetOrch, seedPrice } from '../server/core.ts'
import { generateProposals } from '../server/proposalEngine.ts'
import { proposals, validateProposal } from '../server/proposals.ts'
import { pipelineService } from '../server/pipelineService.ts'
import { metrics } from '../server/metrics.ts'
import { evaluateSlo, checkAndAlert } from '../server/slo.ts'
import { getEvents } from '../server/ledger.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] PROPOSAL-SLO SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'proposal-slo-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function countBreachEvents(): number {
  return getEvents(0).filter((e) => e.kind === 'SLO_BREACH').length
}

function gwStub() {
  return {
    adapterAttached: false,
    adapterName: 'none',
    handshakeComplete: false,
    killswitch: false,
    venueOutboundDisabledReason: null as string | null,
    queued: 0,
    processedFills: 0,
    drainedDuplicates: 0,
  }
}

async function main() {
  resetOrch(100_000)
  seedPrice('T', 100)
  const state = getOrchState()

  // S1 deterministic generation without LLM env
  const gen = await generateProposals(state)
  if (gen.source !== 'human' || gen.llmUsed) fail('S1 deterministic generation', `source=${gen.source} llmUsed=${gen.llmUsed}`)
  if (gen.verdicts.length === 0 || gen.verdicts.some((v) => !v.ok)) {
    fail('S1 deterministic generation', `invalid verdicts: ${JSON.stringify(gen.verdicts.map((v) => v.reason ?? 'ok'))}`)
  }
  pass('S1 deterministic generation', `${gen.verdicts.length} valid proposals from real backtest grid (no LLM configured)`)

  // S2 new-strategy proposals reach pipeline ONLY as candidate records
  if (gen.promotedStrategyIds.length === 0) fail('S2 candidate-only exit', 'nothing promoted')
  for (const id of gen.promotedStrategyIds) {
    const stage = pipelineService.get(id).stage
    if (stage !== 'candidate') fail('S2 candidate-only exit', `stage=${stage} for ${id}`)
  }
  pass('S2 candidate-only exit', `${gen.promotedStrategyIds.length} promoted to candidate (cannot trade)`)

  // S3 malformed proposals rejected at validation boundary (receive returns verdicts, never throws)
  const r1 = proposals.receive({ proposalId: 'bad-proposal-1', source: 'llm', kind: 'new-strategy', rationale: 'x', createdBy: 't' })
  if (r1.ok || !r1.reason?.startsWith('PARAMS_REQUIRED')) fail('S3 malformed rejection', `missing params: ${JSON.stringify(r1)}`)

  const r2 = proposals.receive({ proposalId: 'bad-proposal-2', source: 'llm', kind: 'new-strategy', params: { fast: Number.NaN }, rationale: 'x', createdBy: 't' })
  if (r2.ok || !r2.reason?.startsWith('PARAM_NOT_FINITE')) fail('S3 malformed rejection', `non-finite param: ${JSON.stringify(r2)}`)

  const r3 = proposals.receive({ proposalId: 'xx', source: 'human', kind: 'risk-param', params: { a: 1 }, rationale: 'x', createdBy: 't' })
  if (r3.ok || !r3.reason?.startsWith('INVALID_PROPOSAL_ID')) fail('S3 malformed rejection', `bad id: ${JSON.stringify(r3)}`)

  const r4 = proposals.receive({ proposalId: 'good-id-01', source: 'llm', kind: 'param-mutation', params: { fast: 8 }, rationale: 'no target', createdBy: 't' })
  if (r4.ok || !r4.reason?.startsWith('PARAM_MUTATION_REQUIRES_TARGET')) fail('S3 malformed rejection', `mutation w/o target: ${JSON.stringify(r4)}`)

  const okV = validateProposal({ proposalId: 'ok-proposal-1', source: 'human', kind: 'risk-param', params: { maxDrawdownPct: 5 }, rationale: 'tighten dd limit', createdBy: 'smoke' })
  if (!okV.ok) fail('S3 malformed rejection', `well-formed rejected: ${okV.reason}`)

  pass('S3 malformed rejection', 'missing params / non-finite / bad id / mutation-without-target rejected; well-formed accepted')

  // S4 SLO breach detection on real measurements
  metrics.recordAck(500)
  metrics.recordAck(520)
  metrics.recordAck(480)
  metrics.recordBar('T', Date.now())
  const snap = () => metrics.snapshot({ gateway: gwStub(), eventMemoryCount: 0 })
  const evaluation = evaluateSlo(snap())
  if (!evaluation.breaches.some((b) => b.key === 'ackP99Ms')) fail('S4 SLO breach detection', `breaches=${JSON.stringify(evaluation.breaches)}`)
  pass('S4 SLO breach detection', `ack p99=${evaluation.values.ackP99Ms}ms exceeds 300ms target`)

  // S5 alert channel: event appended once, cooldown dedupes repeats
  const before = countBreachEvents()
  await checkAndAlert(snap())
  if (countBreachEvents() <= before) fail('S5 alert channel', 'SLO_BREACH not appended')
  await checkAndAlert(snap())
  await checkAndAlert(snap())
  if (countBreachEvents() > before + 1) fail('S5 alert channel', `cooldown failed: +${countBreachEvents() - before} events`)
  pass('S5 alert channel', 'breach appended once, repeat checks deduplicated by cooldown')

  archive()
  console.log('')
  console.log('[ARCHIVED] artifacts/proposal-slo-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('PROPOSAL-SLO SMOKE PASSED')
}

main().catch((e) => {
  console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
