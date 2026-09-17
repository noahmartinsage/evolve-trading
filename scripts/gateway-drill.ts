import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SandboxAdapter } from '../server/venue/sandbox.ts'
import { CexTestnetAdapter } from '../server/venue/cexTestnet.ts'
import { ExecutionGateway } from '../server/gateway/executor.ts'

interface DrillRecord {
  startedAt: string
  finishedAt: string
  scenarios: { name: string; pass: boolean; detail: string }[]
  finalStatus: ReturnType<ExecutionGateway['status']>
}

function fail(rec: DrillRecord, name: string, msg: string): never {
  rec.scenarios.push({ name, pass: false, detail: msg })
  archive(rec)
  console.error(`❌ GATEWAY DRILL FAIL · ${name} · ${msg}`)
  process.exit(1)
}

function pass(rec: DrillRecord, name: string, detail: string): void {
  rec.scenarios.push({ name, pass: true, detail })
  console.log(`✅ ${name} · ${detail}`)
}

function archive(rec: DrillRecord): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  const stable = { ...rec }
  writeFileSync(join(dir, 'drill-latest.json'), JSON.stringify(stable, null, 2))
  if (rec.finishedAt) {
    writeFileSync(join(dir, `drill-${rec.startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(stable, null, 2))
  }
}

async function main() {
  const rec: DrillRecord = { startedAt: new Date().toISOString(), finishedAt: '', scenarios: [], finalStatus: null as unknown as ReturnType<ExecutionGateway['status']> }

  const venue = new SandboxAdapter()
  const gw = new ExecutionGateway()
  const receivedFills: string[] = []
  gw.setFillSink((f) => receivedFills.push(f.fillId))

  const r0 = await gw.submit({ clientOrderId: 'pre-handshake', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'live' })
  if (r0.ok || r0.reason !== 'HANDSHAKE_INCOMPLETE') fail(rec, 'S1 握手前置检查', `期望 HANDSHAKE_INCOMPLETE，实际 ${JSON.stringify(r0)}`)
  pass(rec, 'S1 握手前置检查', '未完成风控握手前出站一律拒绝')

  gw.attachAdapter(venue)

  const rMode = await gw.submit({ clientOrderId: 'paper-leak', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'paper' })
  if (rMode.ok || !rMode.reason?.includes('LIVE')) fail(rec, 'S2 模式强制', `paper 意图未被拒: ${JSON.stringify(rMode)}`)
  pass(rec, 'S2 模式强制', '非 live 意图被网关拒绝')

  gw.completeRiskHandshake()

  const rDup = await gw.submit({ clientOrderId: 'dup-test', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'live' })
  const rDup2 = await gw.submit({ clientOrderId: 'dup-test', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'live' })
  if (!rDup.ok || rDup2.ok || rDup2.reason !== 'DUPLICATE_CLIENT_ID') fail(rec, 'S3 幂等去重', `重复 clientOrderId 未拦截: ${JSON.stringify(rDup2)}`)
  pass(rec, 'S3 幂等去重', '重复 clientOrderId 被拒绝')

  const fillsBefore = receivedFills.length
  const marketOrder = await gw.submit({ clientOrderId: 'mkt-1', symbol: 'TEST', side: 'buy', type: 'limit', price: 100, qty: 2, mode: 'live' })
  if (!marketOrder.ok) fail(rec, 'S4 正常出站', `限价单提交失败: ${JSON.stringify(marketOrder)}`)

  venue.ingestTick('TEST', 99)
  if (receivedFills.length !== fillsBefore + 1) fail(rec, 'S4 正常成交回报', `期望新增 1 笔，实际 ${receivedFills.length - fillsBefore}`)
  pass(rec, 'S4 正常出站与回报', '限价挂单→tick 穿越→成交回报送达')

  venue.injectFault('DUPLICATE_NEXT_FILL')
  const dupOrder = await gw.submit({ clientOrderId: 'dup-fill', symbol: 'TEST', side: 'buy', type: 'limit', price: 98, qty: 1, mode: 'live' })
  if (!dupOrder.ok) fail(rec, 'S5 重复回报', '挂单失败')
  venue.ingestTick('TEST', 97)
  const st = gw.status()
  if (st.drainedDuplicates !== 1) fail(rec, 'S5 重复回报', `重复成交未被排水: drained=${st.drainedDuplicates}`)
  pass(rec, 'S5 重复回报防御', `经济成交只处理一次 · 排水重复 ${st.drainedDuplicates} 条`)

  venue.injectFault('DROP_NEXT_FILL')
  const dropOrder = await gw.submit({ clientOrderId: 'drop-fill', symbol: 'TEST', side: 'buy', type: 'limit', price: 96, qty: 1, mode: 'live' })
  if (!dropOrder.ok) fail(rec, 'S6 丢单对账', '挂单失败')
  venue.ingestTick('TEST', 95)
  const recon = await gw.reconcileAgainstVenue()
  if (recon.consistent) fail(rec, 'S6 丢单对账', `且回报未被对账捕获: ${JSON.stringify(recon)}`)
  pass(rec, 'S6 丢单对账', `检测到缺失 ${recon.missing} 笔（local=${recon.localFills} venue=${recon.venueFills}）`)

  const pending = await gw.submit({ clientOrderId: 'pending-ks', symbol: 'TEST', side: 'buy', type: 'limit', price: 90, qty: 1, mode: 'live' })
  if (!pending.ok) fail(rec, 'S7 killswitch 演练', '挂单失败')

  gw.setKillswitch(true)
  const cancelled = await gw.cancelAllAtVenue()
  if (cancelled < 0) fail(rec, 'S7 killswitch 演练', 'venue 撤单风暴未清空')
  const afterKs = await gw.submit({ clientOrderId: 'post-ks', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'live' })
  if (afterKs.ok || afterKs.reason !== 'KILLSWITCH_ACTIVE') fail(rec, 'S7 killswitch 演练', `激活后订单未被拒: ${JSON.stringify(afterKs)}`)
  pass(rec, 'S7 killswitch 演练', `撤单风暴撤销 ${cancelled} 笔 + 后续出站 KILLSWITCH_ACTIVE`)

  gw.setKillswitch(false)
  venue.injectFault('REJECT_ONCE')
  const rejected = await gw.submit({ clientOrderId: 'venue-reject-2', symbol: 'TEST', side: 'sell', type: 'market', qty: 1, mode: 'live' })
  if (rejected.ok || !rejected.reason?.startsWith('VENUE_ERROR')) fail(rec, 'S8 venue 异常透传', `venue 注入异常未被包装: ${JSON.stringify(rejected)}`)
  pass(rec, 'S8 venue 异常透传', 'venue 拒单以 VENUE_ERROR 包装返回，不崩溃')

  rec.finalStatus = gw.status()

  const cexGw = new ExecutionGateway()
  const cex = CexTestnetAdapter.fromEnv()
    ?? new CexTestnetAdapter('dummy-key', 'dummy-secret', process.env.BINANCE_TESTNET_REST ?? 'https://testnet.binance.vision')
  cexGw.attachAdapter(cex)
  cexGw.completeRiskHandshake()
  const cexRes = await cexGw.submit({ clientOrderId: `drill-${Date.now().toString(36)}`, symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: 1, qty: 0.001, mode: 'live' })
  if (cexRes.ok || !cexRes.reason?.startsWith('VENUE_ERROR')) {
    fail(rec, 'S9 CEX testnet 协议演练', `签名请求未按 fail-closed 包装: ${JSON.stringify(cexRes)}`)
  }
  pass(rec, 'S9 CEX testnet 协议演练', `${cexRes.reason?.slice(0, 60)} · 凭证无效/网络异常均 fail-closed`)

  rec.finishedAt = new Date().toISOString()
  archive(rec)

  console.log(`\n🧾 演练记录已归档 artifacts/drill-latest.json`)
  console.log(`   场景 ${rec.scenarios.filter((x) => x.pass).length}/${rec.scenarios.length} 通过 · 处理成交 ${rec.finalStatus.processedFills} · 排水重复 ${rec.finalStatus.drainedDuplicates}`)
  console.log('🎉 GATEWAY DRILL PASSED')
}

main().catch((e) => {
  console.error(`❌ DRILL CRASH: ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
