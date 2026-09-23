import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SandboxAdapter } from '../server/venue/sandbox.ts'
import { CexTestnetAdapter } from '../server/venue/cexTestnet.ts'
import { attachAlgo } from '../server/venue/okxTestnet.ts'
import type { VenueFill } from '../server/venue/types.ts'
import { ExecutionGateway } from '../server/gateway/executor.ts'
import { makeIntentKey } from '../server/intentLedger.ts'
import { initLedger } from '../server/ledger.ts'
import { isPersistent } from '../server/persistence.ts'

// ★★ 隔离必须在**模块加载期**就定好（判据 C10：隔离是"第一件事"）。
//   `initLedger()` 走 `initPersistence()`，而它在 `db === null` 时**立即**按
//   `process.env.ORCH_DB` 打开库并锁死。所以 ORCH_DB 一旦晚设（例如放到 main() 里），
//   后面再调 `initLedger()` 就会沿用**默认的 `data/orch.db`**（= 用户应用的真库）。
//   放在顶层 import 之后、任何 `init*()` 之前，是唯一稳妥的位置。
const RUN_TAG = `${process.pid}-${Date.now()}`
process.env.ORCH_DB = join('data', `gateway-drill-${RUN_TAG}.db`)
const DRILL_DB = process.env.ORCH_DB

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
  // ★★ 必须先 `initLedger()`：出网幂等的判据是**持久化**语义键台账，
  //   而台账在 `getDb() === null` 时**刻意 fail-closed**（返回 `ok:false`）。
  //   原因（判据 C10）：没有台账就没法保证"同一笔只出网一次"，
  //   此时放行是假象 —— 宁可拒绝。
  //   ★ 代价是：**忘了 init 的症状是"第一笔就被判重复"**，而报文写的是
  //     `INTENT_IN_FLIGHT_RECONCILE_REQUIRED`（"结果未知，去对账"）——
  //     这句话在"库根本没打开"这个事因下是**误导性的**（D7：注释/文案要说真在跑的逻辑）。
  //     本轮不在这里改台账的文案（那是另一个接口面），而是用下面这条**前置断言**
  //     把"没 init"从"看起来像幂等生效"里分辨出来。
  initLedger()

  const rec: DrillRecord = { startedAt: new Date().toISOString(), finishedAt: '', scenarios: [], finalStatus: null as unknown as ReturnType<ExecutionGateway['status']> }

  // 前置条件：库真的开了。否则后面所有"被拦住了"的绿都可能是假绿
  // （台账 fail-closed 会让**第一笔**就报"重复"，看着像幂等生效）。
  if (!isPersistent()) fail(rec, 'S0 台账可用', `持久层未就绪（ORCH_DB=${DRILL_DB}）⇒ 无法区分"幂等生效"与"根本没台账"`)
  pass(rec, 'S0 台账可用', `持久化意图台账就绪 · ${DRILL_DB}`)

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
  // ★ S3 断言的是「第二笔被拦住了」，**不是**「报文等于某个字符串」。
  //
  // 出网幂等已改为 `server/intentLedger.ts` 的**持久化语义键**，报文随之分成三态
  // （判据 13：三态必须分开，因为调用方该做的动作不同）：
  //   · INTENT_ALREADY_SETTLED…        —— 已定局，别重发，去读 venueOrderId
  //   · INTENT_IN_FLIGHT_RECONCILE…    —— 结果未知，**去对账**，不是重发
  //   （旧实现的内存 Set 报 `DUPLICATE_CLIENT_ID`，已废弃）
  //
  // ★ 为什么**两个前缀都接受**：SandboxAdapter 的 `place()` 是立即 resolve 的，
  //   所以第一笔通常在断言执行前就已经 `settle()` 了 ⇒ 实际命中的是 `settled`。
  //   若把断言钉死在某一个前缀上，这个场景会**因为时序**而随机红或绿
  //   （判据 D5：我要下的结论，在另一种事因下会不会长得一模一样）。
  //   真正要断的是"**被持久化台账拦住了，且原因出自台账**"，这两条合起来才是它的牙。
  const ledgerPrefixes = ['INTENT_ALREADY_SETTLED:', 'INTENT_IN_FLIGHT_RECONCILE_REQUIRED:']
  if (!rDup.ok) fail(rec, 'S3 前置', `第一笔就该成功出网，实际 ${JSON.stringify(rDup)}`)
  if (rDup2.ok) fail(rec, 'S3 幂等去重', `第二笔同一语义键未被拦截（真的发出去了）: ${JSON.stringify(rDup2)}`)
  if (!ledgerPrefixes.some((p) => rDup2.reason?.startsWith(p))) {
    fail(rec, 'S3 幂等去重', `被拦了但不是台账拦的（可能是别的检查）：${JSON.stringify(rDup2.reason)}`)
  }
  // ★ 反向咬合：**换一个语义键必须放行**。否则"什么都拦"也能让上面全绿
  //   （判据 B1：这条断言必须有一个"只有它能命中"的输入）。
  const rDifferent = await gw.submit({ clientOrderId: 'dup-test-other-bar', bucket: 'TEST:other-bar', symbol: 'TEST', side: 'buy', type: 'market', qty: 1, mode: 'live' })
  if (!rDifferent.ok) fail(rec, 'S3 幂等去重', `换了 bucket 的**新**意图被误挡：${JSON.stringify(rDifferent)}`)
  pass(rec, 'S3 幂等去重', `同一语义键被台账拦截（${rDup2.reason?.split(':')[0]}）· 换 bucket 正常放行`)

  // ── S3b ★★ 语义键的**确定性**：这是整套幂等的物理前提 ──────────────────
  //
  // 旧实现的 `clientOrderId` 由 `Date.now()+Math.random()` 生成 ⇒ **同一个逻辑意图
  // 每次算出不同的键** ⇒ 台账/场所两道防线都形同虚设。所以"确定性"本身必须被断言，
  // 否则把它改回随机的任何一种写法（哪怕只有一行）都不会被任何场景抓到。
  //
  // ★ 断言方式刻意选"**两次独立计算必须逐字相等**"，而不是"长度是 32"这类形状检查：
  //   形状对而值随机是**完全可能**的（`randomBytes(16).toString('hex')` 就是 32 位）。
  const keyA = makeIntentKey({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1 + 0.2, bucket: 'BTCUSDT:1758451200000' })
  const keyB = makeIntentKey({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.3, bucket: 'BTCUSDT:1758451200000' })
  if (keyA !== keyB) fail(rec, 'S3b 语义键确定性', `数量尾差导致两个键：${keyA} vs ${keyB}`)
  const keyOtherBar = makeIntentKey({ symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.3, bucket: 'BTCUSDT:1758454800000' })
  if (keyOtherBar === keyB) fail(rec, 'S3b 语义键确定性', '换了一根 K 线却仍是同一个键 ⇒ 会把新信号误判成重复')
  pass(rec, 'S3b 语义键确定性', '同意图同键（含浮点尾差归一）· 换 K 线换键')

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

  // ══ S10–S12 ★★ 场所侧条件单（止盈/止损）══════════════════════════════
  //
  // 这一组断的是本仓库付过代价的那句话：「解析对了 / 念回了 / 审计记了」
  // **≠「挂上了」**。在此之前 `OrderIntentInput.takeProfit/stopLoss` 早就存在，
  // 却没有任何一层把它交给适配器（`submitToBroker` 只传 5 个字段）——
  // 于是系统把一张**没有任何保护的裸单**当成"已按用户要求设了保护"。
  //
  // ★ 为什么另开一对全新的 gw2/venue2，而不是接着上面那一套：
  //   S4–S8 已经往 venue 里塞了挂单、成交、故障注入与一次撤单风暴，
  //   计数类观测（`openConditionalCount()`）就再也分不清"新增的"与"上面剩的"
  //   （判据 C2：先清零再比绝对值）。"全新"必须显式构造，不能靠
  //   "我觉得上面应该已经清干净了"。
  const venue2 = new SandboxAdapter()
  const gw2 = new ExecutionGateway()
  const protFills: VenueFill[] = []
  gw2.setFillSink((f) => protFills.push(f))
  gw2.attachAdapter(venue2)
  gw2.completeRiskHandshake()

  const caps = gw2.venueCapabilities()
  if (caps.venueProtection !== true || caps.adapterName !== 'sandbox') {
    fail(rec, 'S10 能力位', `sandbox 应自报可原子附挂保护，实际 ${JSON.stringify(caps)}`)
  }

  // ★★ 配对断言（判据 A1 / D9）：**不带保护的单不许凭空长出条件单**。
  //   缺了它，下面 `openConditionalCount() === 1` 在"夹具每次 place 都建一张
  //   条件单"这种坏法下**依然是绿的** —— 那时这条断言不区分任何东西。
  const noProt = await gw2.submit({ clientOrderId: 's10-noprot', symbol: 'PROT', side: 'buy', type: 'limit', price: 100, qty: 5, mode: 'live' })
  if (!noProt.ok) fail(rec, 'S10 配对', `不带保护的单提交失败：${JSON.stringify(noProt)}`)
  if (venue2.openConditionalCount() !== 0) {
    fail(rec, 'S10 配对', `没给保护却凭空出现 ${venue2.openConditionalCount()} 张条件单`)
  }

  const withProt = await gw2.submit({
    clientOrderId: 's10-prot',
    symbol: 'PROT',
    side: 'buy',
    type: 'limit',
    price: 100,
    qty: 5,
    takeProfit: 106,
    stopLoss: 94,
    mode: 'live',
  })
  if (!withProt.ok) fail(rec, 'S10 附挂', `带保护的单提交失败：${JSON.stringify(withProt)}`)

  const condSnap = venue2.conditionalSnapshot()
  if (condSnap.length !== 1) fail(rec, 'S10 附挂', `期望恰好 1 张条件单，实际 ${condSnap.length}`)
  const cond = condSnap[0]
  // ★ 断的是**价格原值**，不是"有没有保护"：两道被对调时数量仍是 1、
  //   仍然"触发了"，而后果相反（该止损离场的仓位会在止盈价上被平掉）。
  if (cond.takeProfit !== 106 || cond.stopLoss !== 94) {
    fail(rec, 'S10 附挂', `保护价没按原值到达场所：tp=${cond.takeProfit} sl=${cond.stopLoss}`)
  }
  if (cond.posSide !== 'long' || cond.closeSide !== 'sell') {
    fail(rec, 'S10 附挂', `多头应对应 long/sell，实际 ${cond.posSide}/${cond.closeSide}`)
  }
  // ★ 对账口径：未触发的条件单**也是场所侧的挂单**。看不见它的后果是
  //   对账得出"场所没有挂单、本地却有保护"这个**相反**的结论。
  if (!venue2.openOrderIds().includes(cond.id)) {
    fail(rec, 'S10 对账口径', `条件单 ${cond.id} 不在 openOrderIds 里 ⇒ 对账看不见场所侧保护`)
  }
  pass(rec, 'S10 场所侧附挂', `止盈 106 / 止损 94 按原值到达场所 · long/sell · ${cond.id} 计入场所挂单`)

  // ── S11 触发：中间价不动、穿止损才动、且记的是哪一道 ──────────────────
  venue2.ingestTick('PROT', 100)
  if (protFills.length !== 2) fail(rec, 'S11 前置', `两张限价单应各成交一次，实际 ${protFills.length}`)
  // ★ 先断"入场价附近一道都不许触发"。它同时是**对调**这个坏法的鉴别器：
  //   若 tp/sl 被对调（多头 tp=94 / sl=106），tick 100 会立刻触发 sl
  //   —— 数量仍是 1、仍然"触发了"，只有这一步能把它区分出来。
  if (venue2.triggeredConditionalCount() !== 0) {
    fail(rec, 'S11 中间价', `入场价附近不该触发保护，却触发了 ${venue2.triggeredConditionalCount()} 次`)
  }
  const processedBefore = gw2.status().processedFills
  venue2.ingestTick('PROT', 94)
  if (venue2.triggeredConditionalCount() !== 1) {
    fail(rec, 'S11 触发', `穿过止损未触发（${venue2.triggeredConditionalCount()}）`)
  }
  const fired = venue2.conditionalSnapshot()[0]
  // ★ 止损必须优先于止盈判定。只断"触发了"的话，把顺序换过来同样是绿的 ——
  //   而那会把一次止损离场记成一次落袋为安（指向相反的动作）。
  if (fired.triggerKind !== 'stop-loss') {
    fail(rec, 'S11 触发', `穿过的是止损，记的却是 ${fired.triggerKind}`)
  }
  if (gw2.status().processedFills !== processedBefore + 1) {
    fail(rec, 'S11 触发', `平仓回报没送达网关（${gw2.status().processedFills} vs ${processedBefore + 1}）`)
  }
  const closeFill = protFills[protFills.length - 1]
  if (closeFill.side !== 'sell' || closeFill.qty !== 5 || closeFill.venueOrderId !== cond.id) {
    fail(rec, 'S11 触发', `平仓回报不符：${JSON.stringify(closeFill)}`)
  }

  // ── 做空：`closeSide` 与做多**相反**，写反了就是把平仓单下成开仓单 ──────
  const shortOpen = await gw2.submit({ clientOrderId: 's11-short-open', symbol: 'PROTS', side: 'sell', type: 'market', qty: 2, mode: 'live' })
  if (!shortOpen.ok) fail(rec, 'S11 做空', `开空失败：${JSON.stringify(shortOpen)}`)
  const shortProt = await gw2.submit({
    clientOrderId: 's11-short-prot',
    symbol: 'PROTS',
    side: 'sell',
    type: 'market',
    qty: 2,
    takeProfit: 94,
    stopLoss: 106,
    mode: 'live',
  })
  if (!shortProt.ok) fail(rec, 'S11 做空', `带保护的开空失败：${JSON.stringify(shortProt)}`)
  const sCond = venue2.conditionalSnapshot().find((c) => c.symbol === 'PROTS')
  if (!sCond) fail(rec, 'S11 做空', '做空仓位的条件单没建起来')
  if (sCond.posSide !== 'short' || sCond.closeSide !== 'buy') {
    fail(rec, 'S11 做空', `空头应对应 short/buy，实际 ${sCond.posSide}/${sCond.closeSide}`)
  }
  venue2.ingestTick('PROTS', 100)
  if (venue2.conditionalSnapshot().find((c) => c.symbol === 'PROTS')?.triggered) {
    fail(rec, 'S11 做空', '中间价不该触发空头保护（空头应在 ≤94 止盈 / ≥106 止损）')
  }
  const shortFillsBefore = protFills.length
  venue2.ingestTick('PROTS', 93)
  const sHit = venue2.conditionalSnapshot().find((c) => c.symbol === 'PROTS')
  if (sHit?.triggerKind !== 'take-profit') {
    fail(rec, 'S11 做空', `穿过 93 应触发 take-profit，实际 ${sHit?.triggerKind ?? '未触发'}`)
  }
  const sFill = protFills[protFills.length - 1]
  if (protFills.length !== shortFillsBefore + 1 || sFill.side !== 'buy' || sFill.qty !== 2) {
    fail(rec, 'S11 做空', `空头平仓回报应为 buy/qty=2，实际 ${JSON.stringify(protFills.slice(shortFillsBefore))}`)
  }
  pass(rec, 'S11 场所侧触发', '入场价附近不触发 · 穿止损记 stop-loss 且回报送达 · 空头走 take-profit 平仓方向 buy')

  // ── S12 撤条件单 与 撤单风暴 ─────────────────────────────────────────
  const c3 = await gw2.submit({
    clientOrderId: 's12-cancel',
    symbol: 'PROTC',
    side: 'buy',
    type: 'limit',
    price: 100,
    qty: 1,
    takeProfit: 110,
    mode: 'live',
  })
  if (!c3.ok) fail(rec, 'S12 撤条件单', `只设止盈的单提交失败：${JSON.stringify(c3)}`)
  const c3snap = venue2.conditionalSnapshot().find((c) => c.symbol === 'PROTC')
  if (!c3snap) fail(rec, 'S12 撤条件单', '只设止盈的单没建起条件单')
  // ★ 配对：只给了一道就只挂一道，另一道不许被"替用户补"出来。
  if (c3snap.takeProfit !== 110 || c3snap.stopLoss !== undefined) {
    fail(rec, 'S12 撤条件单', `只设了止盈却出现 tp=${c3snap.takeProfit} sl=${c3snap.stopLoss}`)
  }
  const openBefore = venue2.openConditionalCount()
  if (!(await venue2.cancel(c3snap.id))) fail(rec, 'S12 撤条件单', `撤条件单 ${c3snap.id} 返回 false`)
  if (venue2.openConditionalCount() !== openBefore - 1) {
    fail(rec, 'S12 撤条件单', `撤掉后未触发条件单数没回落（${openBefore} → ${venue2.openConditionalCount()}）`)
  }
  if (venue2.openOrderIds().includes(c3snap.id)) fail(rec, 'S12 撤条件单', '撤掉的条件单仍占着场所挂单')
  if (await venue2.cancel(c3snap.id)) fail(rec, 'S12 撤条件单', '重复撤同一张条件单竟返回 true')

  // ★★ 撤单风暴（killswitch）必须把条件单**一起**撤掉。
  //   漏掉它的后果不是"少撤一张单"，而是停机之后：仓位还活着、
  //   而账面以为保护也一起清掉了 —— 两边都看起来正常，只有仓位在裸奔。
  const c4 = await gw2.submit({
    clientOrderId: 's12-storm',
    symbol: 'PROTS2',
    side: 'buy',
    type: 'limit',
    price: 100,
    qty: 1,
    stopLoss: 90,
    mode: 'live',
  })
  if (!c4.ok) fail(rec, 'S12 撤单风暴', `挂单失败：${JSON.stringify(c4)}`)
  if (venue2.openConditionalCount() < 1) {
    fail(rec, 'S12 撤单风暴', '风暴前没有待撤的条件单 ⇒ 这条断言测不到任何东西')
  }
  gw2.setKillswitch(true)
  const stormed = await gw2.cancelAllAtVenue()
  if (stormed < 0) fail(rec, 'S12 撤单风暴', '风暴未清空场所挂单（openOrderIds 仍有残留）')
  if (venue2.openConditionalCount() !== 0) {
    fail(rec, 'S12 撤单风暴', `风暴后仍有 ${venue2.openConditionalCount()} 张条件单没撤`)
  }
  gw2.setKillswitch(false)
  pass(rec, 'S12 撤条件单与风暴', `单张可撤且不可重复撤 · 风暴连条件单一起撤销 ${stormed} 笔`)

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

  // ── S13 场所**不能**原子附挂保护时，必须拒单而不是凑合 ───────────────
  //
  // ★ 配对断言（判据 B1）：同一个场所、同一副假凭证，**唯一差别**是带不带
  //   保护字段。少了这一条，"被拒"完全可能是凭证无效造成的 —— 那时
  //   这条断言在"保护压根没被转过去"这个坏法下**也是绿的**。
  if (cexGw.venueCapabilities().venueProtection !== false) {
    fail(rec, 'S13 能力位', 'cex-testnet 是现货、做不到随主单原子附挂，应自报 false')
  }
  if (cexRes.reason?.includes('CEX_PROTECTION_UNSUPPORTED')) {
    fail(rec, 'S13 能力位', 'S9 那笔**没带**保护却被保护检查拒了 ⇒ 上面的配对不成立')
  }
  const cexProt = await cexGw.submit({
    clientOrderId: `drill-prot-${Date.now().toString(36)}`,
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'limit',
    price: 1,
    qty: 0.001,
    takeProfit: 2,
    stopLoss: 0.5,
    mode: 'live',
  })
  if (cexProt.ok || !cexProt.reason?.includes('CEX_PROTECTION_UNSUPPORTED')) {
    fail(rec, 'S13 拒单', `带保护的 CEX 单未被硬停：${JSON.stringify(cexProt)}`)
  }
  pass(rec, 'S13 CEX 拒收保护', 'cex-testnet 自报 false，带保护的单在**出网前**被硬停（不留无保护窗口）')

  // ── S14 OKX 的 `attachAlgoOrds` 载荷（纯函数，离线可断）───────────────
  //
  // ★ 这一段能写出来，是因为 `attachAlgo` 被导出成纯函数。它此前在测试里
  //   **一个字都没被断过** —— 因为它在适配器内部，而适配器的 `place()` 要出网。
  const algoFull = attachAlgo({ takeProfitPrice: 105.123, stopLossPrice: 94.987 }, 'linear')
  const algoWant = JSON.stringify({ tpTriggerPx: '105.12', tpOrdPx: '-1', slTriggerPx: '94.99', slOrdPx: '-1' })
  if (JSON.stringify(algoFull) !== algoWant) {
    fail(rec, 'S14 OKX 载荷', `完整载荷不符：${JSON.stringify(algoFull)} ≠ ${algoWant}`)
  }
  // ★ `-1` = 触发后**市价**成交。挂限价会在剧烈行情里"触发而不成交"
  //   （价格穿过去了、单子还挂着）—— 那比没有保护更难发现。
  const algoSlOnly = attachAlgo({ stopLossPrice: 94.99 }, 'linear')
  if (JSON.stringify(algoSlOnly) !== JSON.stringify({ slTriggerPx: '94.99', slOrdPx: '-1' })) {
    fail(rec, 'S14 OKX 载荷', `只设止损时不该替用户补出止盈：${JSON.stringify(algoSlOnly)}`)
  }
  if (attachAlgo(undefined, 'linear') !== undefined || attachAlgo({}, 'linear') !== undefined) {
    fail(rec, 'S14 OKX 载荷', '没有保护时不该产出 attachAlgoOrds 元素（空对象=主单带一个没内容的 algo）')
  }
  pass(rec, 'S14 OKX attachAlgoOrds 载荷', '触发价按精度取整 · 触发后市价(-1)成交 · 只挂给出的那一道 · 无保护不产出元素')

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
