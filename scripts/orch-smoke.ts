import {
  activateKillswitch,
  cancelOrder,
  deactivateKillswitch,
  getOrchState,
  onMarketBar,
  processLiveIntent,
  processOrderIntent,
  resetOrch,
  seedPrice,
} from '../server/core.ts'
import { eventCount, getEvents, resetLedger, initLedger } from '../server/ledger.ts'
import { liveGateway } from '../server/gateway/executor.ts'
import { pipelineService } from '../server/pipelineService.ts'
import { receipt } from './overfit-fixture.ts'
import { SandboxAdapter } from '../server/venue/sandbox.ts'
import { __resetIntentLedgerForTest } from '../server/intentLedger.ts'
import { isPersistent } from '../server/persistence.ts'
import { join } from 'node:path'
import type { Candle } from '../src/engine/index.ts'

// ★★ 隔离必须先于任何 `init*()`（判据 C10）。本烟测会走**真实的 live 出网链路**
//   （`processLiveIntent` → 网关 → 台账），所以它需要一个属于自己的库：
//     ① 不污染用户正在运行的应用的真库（`data/orch.db`）；
//     ② 不被上一次运行留下的 `in_flight` 行挡住 —— 幂等台账一旦记下
//        `live-ok` 这个语义键，**下次再跑同一个键就会被正确地拦住**，
//        于是 `live-ok` 那条断言会报"合法单失败"，**红在了"幂等生效"这件事上**。
//        ★ 这是纯粹的环境假红（判据 A1），不是代码缺陷 —— 所以修隔离，不改断言。
//   ★ 命名带 pid + 时间戳：天然是新文件，清理失败也不会让门禁变红。
process.env.ORCH_DB = join('data', `orch-smoke-${process.pid}-${Date.now()}.db`)

function fail(msg: string): never {
  console.error(`❌ ORCH SMOKE FAIL · ${msg}`)
  process.exit(1)
}

function bar(t: number, o: number, c: number): Candle {
  return { t, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 10_000 }
}

// ★★ 必须显式 `initLedger()`：出网幂等已改为**持久化**语义键台账
//   （`server/intentLedger.ts`），而台账在 `getDb() === null` 时**刻意 fail-closed**
//   （判据 C10：没有台账就没法保证"同一笔只出网一次"，此时放行是假象）。
//   ★ 忘了这一步的症状极具误导性：**第一笔 live 单**就被判"重复"，
//     报文写的是 `INTENT_IN_FLIGHT_RECONCILE_REQUIRED`（"结果未知，去对账"）——
//     而真因是"库根本没打开"。两者都表现为"下单失败"，却指向**完全相反的动作**
//     （一个是去对账、一个是去补 init）。所以下面紧跟一条前置断言把它分开。
initLedger()
if (!isPersistent()) fail(`持久层未就绪（ORCH_DB=${process.env.ORCH_DB}）⇒ 无法区分"幂等生效"与"根本没台账"`)

resetLedger()
resetOrch(100_000)
seedPrice('TEST', 100)
getOrchState().risk.maxNotionalPerOrder = 5_000_000

const r1 = processOrderIntent({ clientOrderId: 'ok-mkt', symbol: 'TEST', side: 'buy', type: 'market', qty: 900 })
if (!r1.ok) fail(`合法市价单被拒: ${r1.reason}`)

onMarketBar('TEST', bar(1, 100, 101))
const s = getOrchState()
const pos = s.positions.get('TEST')
if (!pos || pos.qty <= 0) fail('市价成交后仓位未建立')
if (s.balanceUSDC >= 100_000) fail('买入后余额未扣减')
const fillEv = getEvents().filter((e) => e.kind === 'ORDER_FILL')
if (fillEv.length !== 1) fail(`ORDER_FILL 事件数=${fillEv.length}`)
console.log(`✅ 市价下单→撮合→账本 · 成交价 ${fillEv[0].payload.price} · 费 ${fillEv[0].payload.fee}`)

const big = processOrderIntent({ clientOrderId: 'too-big', symbol: 'TEST', side: 'buy', type: 'limit', price: 101, qty: 100_000 })
if (big.ok || !big.reason?.startsWith('NOTIONAL')) fail(`超大名义本金未被拒: ${JSON.stringify(big)}`)

const dev = processOrderIntent({ clientOrderId: 'off-price', symbol: 'TEST', side: 'buy', type: 'limit', price: 200, qty: 1 })
if (dev.ok || !dev.reason?.startsWith('PRICE_DEVIATION')) fail(`价格偏离未被拒: ${JSON.stringify(dev)}`)
console.log('✅ 名义本金上限 + 价格偏离保护')

const lim = processOrderIntent({ clientOrderId: 'resting', symbol: 'TEST', side: 'buy', type: 'limit', price: 99, qty: 1 })
if (!lim.ok) fail(`限价挂单失败: ${lim.reason}`)
if (!cancelOrder('resting')) fail('撤单失败')
onMarketBar('TEST', bar(2, 99, 99.5))
const stillCancelled = getOrchState().orders.find((o) => o.clientOrderId === 'resting')
if (!stillCancelled || stillCancelled.status !== 'cancelled') fail('已撤单仍被撮合')
console.log('✅ 限价挂单 → 撤单 → 不再成交')

const usedBefore = getOrchState().submitTimestamps.length
const capacity = Math.max(0, 30 - usedBefore)
for (let i = 0; i < 40; i++) {
  const r = processOrderIntent({ clientOrderId: `rate-${i}`, symbol: 'TEST', side: 'sell', type: 'market', qty: 0.001 })
  if (i < capacity && !r.ok) fail(`频控误伤第 ${i} 笔: ${r.reason}`)
  if (i >= capacity && r.ok) fail(`第 ${i} 笔应被频控拒绝（窗口容量 ${capacity}）`)
}
console.log(`✅ 下单频率限制（30/分钟 · 窗口已用 ${usedBefore}）`)

let t = 3
let probeSeq = 0
while (t < 200 && !getOrchState().killswitch) {
  onMarketBar('TEST', bar(t, 100 - t, 99 - t * 1.2))
  const probe = processOrderIntent({ clientOrderId: `probe-${probeSeq++}`, symbol: 'TEST', side: 'sell', type: 'market', qty: 0.001 })
  if (!probe.ok) {
    const acceptable = probe.reason?.startsWith('DRAWDOWN_BREAKER')
      || probe.reason === 'KILLSWITCH_ACTIVE'
      || probe.reason?.startsWith('ORDER_RATE')
    if (!acceptable) fail(`探测单异常被拒: ${JSON.stringify(probe)}`)
  }
  t += 1
}
if (!getOrchState().killswitch) fail('回撤熔断未触发 killswitch')
const breaker = getEvents().some((e) => e.kind === 'RISK_CIRCUIT_BREAK' || e.kind === 'KILLSWITCH_ON')
if (!breaker) fail('熔断事件未入账本')
const blocked = processOrderIntent({ clientOrderId: 'after-dd', symbol: 'TEST', side: 'buy', type: 'market', qty: 0.001 })
if (blocked.ok || blocked.reason !== 'KILLSWITCH_ACTIVE') fail(`熔断后订单未被 KILLSWITCH_ACTIVE 拒绝: ${JSON.stringify(blocked)}`)
console.log('✅ 回撤熔断 → 自动 killswitch → 后续订单默认拒绝')

deactivateKillswitch()
getOrchState().submitTimestamps.length = 0
seedPrice('TEST', 90)
const resumed = processOrderIntent({ clientOrderId: 'after-resume', symbol: 'TEST', side: 'sell', type: 'market', qty: 0.001 })
if (!resumed.ok) fail(`解除 killswitch 后恢复失败: ${resumed.reason}`)
console.log('✅ 解除 killswitch 后恢复接单')

const seqMonotonic = getEvents().every((e, i, arr) => i === 0 || e.seq > arr[i - 1].seq)
if (!seqMonotonic) fail('账本 seq 非单调递增')
console.log(`✅ 账本追加写 · 共 ${eventCount()} 条事件 · seq 单调`)

liveGateway.reset()
// ★ 意图台账也要清 —— 但走**专门的测试钩子**，不是 `liveGateway.reset()`。
//   理由见 `executor.ts` 的 `reset()` 注释：台账记录的是"哪些意图已经出过网"这个
//   **历史事实**，reset 掉它等于给调用方一条绕过幂等的后门。烟测要清，只能显式调它。
__resetIntentLedgerForTest()
seedPrice('LT', 50)

// 晋升内禁：无策略身份 / 未知策略 一律拒绝（授权闸在握手之前，纯内存检查 fail-fast）
const liveNoStrategy = await processLiveIntent({ clientOrderId: 'live-no-strategy', symbol: 'LT', side: 'buy', type: 'market', qty: 0.001 } as never)
if (liveNoStrategy.ok || !liveNoStrategy.reason?.startsWith('LIVE_REQUIRES_STRATEGY_ID')) {
  fail(`缺 strategyId 的 live 单未被拒: ${JSON.stringify(liveNoStrategy)}`)
}
const liveUnknownStrategy = await processLiveIntent({ clientOrderId: 'live-unknown-strategy', symbol: 'LT', side: 'buy', type: 'market', qty: 0.001, strategyId: 'no-such-strategy' })
if (liveUnknownStrategy.ok || !liveUnknownStrategy.reason?.startsWith('STRATEGY_UNKNOWN')) {
  fail(`未知策略的 live 单未被拒: ${JSON.stringify(liveUnknownStrategy)}`)
}
console.log('✅ live 意图 · 策略身份前置校验')

// 走完整晋升链到 small_cap_live，才允许 live
pipelineService.submit('smoke-strategy-1')
const gateRejected = await processLiveIntent({ clientOrderId: 'live-candidate', symbol: 'LT', side: 'buy', type: 'market', qty: 0.001, strategyId: 'smoke-strategy-1' })
if (gateRejected.ok || !gateRejected.reason?.startsWith('STRATEGY_NOT_AUTHORIZED_FOR_LIVE')) {
  fail(`candidate 阶段的 live 单未被拒: ${JSON.stringify(gateRejected)}`)
}
pipelineService.evaluateGate('smoke-strategy-1', { fitnessValue: 100, overfit: receipt(), purityHomogeneous: false })
for (let i = 0; i < 20; i++) pipelineService.recordPaperTrade('smoke-strategy-1')
pipelineService.closePaper('smoke-strategy-1', 3)
// 测试网实测是实盘的前置：纸交易通过后必须先经真实场所实测验证执行链路。
// 用注入时钟把"观测 ≥ 6h"这条规则在毫秒内跑完 —— 否则这条规则**无法被任何断言守住**
// （等真实数小时不可行，放弃断言则规则无人守护）。
const TN0 = Date.now()
pipelineService.beginTestnet('smoke-strategy-1', 'okx-testnet', TN0)
for (let i = 0; i < 13; i++) pipelineService.recordTestnetFill('smoke-strategy-1', TN0 + i * 3_600_000)
for (const r of [0.8, -0.6, 1.1, -0.5, 0.7, -0.55, 0.9]) pipelineService.recordTestnetReturn('smoke-strategy-1', r)
pipelineService.closeTestnet('smoke-strategy-1', 3, TN0 + 14 * 3_600_000)
pipelineService.approve('smoke-strategy-1', 'smoke-approver')
console.log('✅ 晋升内禁 · candidate/观察期/待审批阶段均无法触达 live')

// 已授权策略仍受 gateway 握手门约束：未握手 → 出站拒绝
const liveBeforeHandshake = await processLiveIntent({ clientOrderId: 'live-no-hs', symbol: 'LT', side: 'buy', type: 'market', qty: 0.001, strategyId: 'smoke-strategy-1' })
if (liveBeforeHandshake.ok || liveBeforeHandshake.reason !== 'HANDSHAKE_INCOMPLETE') {
  fail(`已授权 live 意图未过握手门: ${JSON.stringify(liveBeforeHandshake)}`)
}
console.log('✅ live 意图 · 握手前置拦截')

const liveVenue = new SandboxAdapter()
liveGateway.attachAdapter(liveVenue)
liveGateway.completeRiskHandshake()

const eventsBeforeLive = eventCount()
const liveOk = await processLiveIntent({ clientOrderId: 'live-ok', symbol: 'LT', side: 'buy', type: 'limit', price: 49, qty: 1, strategyId: 'smoke-strategy-1' })
if (!liveOk.ok) fail(`晋升授权后的 live 合法单失败: ${JSON.stringify(liveOk)}`)
liveVenue.ingestTick('LT', 48)
const liveFillEvents = getEvents(eventsBeforeLive).filter((e) => e.kind === 'ORDER_FILL' && (e.payload as { scope?: string }).scope === 'live')
if (liveFillEvents.length !== 1) {
  fail(`live 成交回报未落账本: ${JSON.stringify(getEvents(eventsBeforeLive).map((e) => e.kind))}`)
}
console.log(`✅ live 成交落账 · ${liveFillEvents[0].payload.symbol} @ ${liveFillEvents[0].payload.price}`)

// 资金帽硬上限（默认 $500）：已用 49 + 本笔 480 > 500 → 必须拒绝（标记价对齐，避开偏离保护）
seedPrice('LT', 48)
const capExceeded = await processLiveIntent({ clientOrderId: 'live-over-cap', symbol: 'LT', side: 'buy', type: 'limit', price: 48, qty: 10, strategyId: 'smoke-strategy-1' })
if (capExceeded.ok || !capExceeded.reason?.startsWith('STRATEGY_CAP_EXCEEDED')) {
  fail(`资金帽未被强制执行: ${JSON.stringify(capExceeded)}`)
}
console.log('✅ 小资金帽硬上限 · 累计名义本金超限即默认拒绝')

activateKillswitch('SMOKE_TEST')
await new Promise((r) => setTimeout(r, 20))
if (liveGateway.status().killswitch !== true) fail('killswitch 激活后 gateway 出站闸未同步关闭')
const liveBlocked = await processLiveIntent({ clientOrderId: 'live-after-ks', symbol: 'LT', side: 'buy', type: 'market', qty: 0.001, strategyId: 'smoke-strategy-1' })
if (liveBlocked.ok || liveBlocked.reason !== 'KILLSWITCH_ACTIVE') fail(`熔断后 live 单未被拒: ${JSON.stringify(liveBlocked)}`)
deactivateKillswitch()
if (liveGateway.status().killswitch !== false) fail('解除 killswitch 后 gateway 出站闸未恢复')
console.log('✅ live 链路 · 握手门→晋升闸→风控→成交落账→资金帽→killswitch 全联动')

console.log('\n🎉 ORCHESTRATION SMOKE PASSED')
