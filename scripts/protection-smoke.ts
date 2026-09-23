/**
 * 保护单烟测 —— 「用户说的止盈止损到底有没有真的挂上去」的回归门禁。
 *
 * ══ 它守的是什么 ══════════════════════════════════════════════════════
 * 2026-09-22 实测确认的缺陷：用户说「止盈 10 成 止损 0.1 成」，
 * `parseProtection` 解析对了、`describeContractOrder` 念回了、
 * `VOICE_COMMAND` 审计事件记下了 —— 而 `processOrderIntent` 的入参里
 * **根本没有这两个字段**，`submitToBroker` 只传 5 个。
 * 于是下出的是一张**没有任何保护的裸单**，用户以为设了保护。
 *
 * 这类缺陷**不会让任何测试变红**：解析层有测试、回话层有测试、
 * 审计层有测试，唯独"它到底有没有进到单子里"那一步从来没有任何观测点。
 * 本文件就是给那一步装上的观测点。
 *
 * ══ 断言的形状 ════════════════════════════════════════════════════════
 * ① 纯函数契约（`protection.ts`）——可离线逐条断言
 * ② 接线：入参带保护 ⇒ 台账里真的要出现；**不带 ⇒ 台账必须为空**（负向牙）
 * ③ 巡检：价格穿过保护位 ⇒ 真的派出一张平仓单，且走的是**既有那一条**路径
 * ④ 语音层到底有没有把这两个字段递下去（源码级，因为派单函数没有对外导出）
 *
 * ★ ④ 是**源码扫描**型断言，必须用剥过注释的代码（判据 C11）：
 *   否则我写在 `submitOrder` 旁边的解释性注释里只要出现 `protFields`
 *   这几个字，这条断言自己就绿了 —— 而与代码实际做了什么毫无关系。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProtection, describeProtection, protectionTrigger } from '../server/protection.ts'
import { getOrchState, onMarketBar, onPriceTick, processOrderIntent, resetOrch, seedPrice } from '../server/core.ts'

const ROOT = process.cwd()

let passed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1
    return
  }
  failures.push(`${name} - ${detail}`)
}

function eq(name: string, actual: unknown, expected: unknown, detail = ''): void {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${detail ? ' · ' + detail : ''}`)
}

/** 剥掉注释再扫源码 —— 见文件头 ④。 */
function readCode(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const SYM = 'PROTUSDT'
const MARK = 86_034
const BAR = (t: number, c: number) => ({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1_000 })

// ═══════════════ ① 纯函数契约 ═══════════════
{
  const long = { side: 'long' as const, stopLoss: 85_000, takeProfit: 95_000, attachedAt: 1, origin: 'test' }
  eq('P1 做多 · 价格跌到止损位', protectionTrigger(long, 85_000), 'stop-loss')
  eq('P2 做多 · 价格跌破止损位', protectionTrigger(long, 84_000), 'stop-loss')
  eq('P3 做多 · 价格涨到止盈位', protectionTrigger(long, 95_000), 'take-profit')
  eq('P4 做多 · 价格在两道之间', protectionTrigger(long, 90_000), null)
  eq('P5 价格非法（0）不许触发', protectionTrigger(long, 0), null)
  eq('P6 价格非法（NaN）不许触发', protectionTrigger(long, Number.NaN), null)

  const short = { side: 'short' as const, stopLoss: 90_000, takeProfit: 80_000, attachedAt: 1, origin: 'test' }
  eq('P7 做空 · 价格涨到止损位', protectionTrigger(short, 90_000), 'stop-loss')
  eq('P8 做空 · 价格跌到止盈位', protectionTrigger(short, 80_000), 'take-profit')
  eq('P9 做空 · 价格在两道之间', protectionTrigger(short, 85_000), null)

  // ★ 契约测试：同一次判定同时满足两道时，必须落**不利**那一侧。
  //   生产路径构造出来的保护不会走到这里（做多的止盈价必然高于止损价，
  //   一个价格不可能同时 ≥ 止盈 且 ≤ 止损）—— 但 `PositionProtection`
  //   是公开类型，别的调用方可以自己拼一个。契约必须先写死，
  //   否则"哪一道赢"由代码书写顺序决定，而它是会被人改的。
  const inverted = { side: 'long' as const, stopLoss: 99_000, takeProfit: 80_000, attachedAt: 1, origin: 'test' }
  eq('P10 两道同时满足时止损优先（不许把爆亏记成落袋）', protectionTrigger(inverted, 79_000), 'stop-loss')

  eq('P11 只设止损 · 止盈那栏没设也能判', protectionTrigger({ side: 'long', stopLoss: 85_000, attachedAt: 1, origin: 'test' }, 84_000), 'stop-loss')
  eq('P12 只设止盈 · 止损那栏没设也能判', protectionTrigger({ side: 'long', takeProfit: 95_000, attachedAt: 1, origin: 'test' }, 96_000), 'take-profit')
}

// ═══════════════ ② buildProtection：比例 → 绝对价 ═══════════════
{
  const long = buildProtection({ mark: MARK, side: 'long', takeProfitPct: 1.0, stopLossPct: 0.01, origin: 'test' })
  check('P20 做多 · 10 成止盈 + 0.1 成止损应当构造成功', long.ok, JSON.stringify(long))
  if (long.ok) {
    assert(Math.abs((long.protection.takeProfit as number) - MARK * 2) < 1e-6)
    assert(Math.abs((long.protection.stopLoss as number) - MARK * 0.99) < 1e-6)
    eq('P21 做多 · 止盈价 = 入场 × 2', Math.round(long.protection.takeProfit as number), MARK * 2)
    eq('P22 做多 · 止损价 = 入场 × 0.99', Math.round(long.protection.stopLoss as number), Math.round(MARK * 0.99))
    eq('P23 方向要记下来（判定"碰到"必须知道方向）', long.protection.side, 'long')
  }

  const short = buildProtection({ mark: MARK, side: 'short', takeProfitPct: 0.1, stopLossPct: 0.05, origin: 'test' })
  check('P24 做空 · 止盈止损方向必须反过来算', short.ok, JSON.stringify(short))
  if (short.ok) {
    check(
      'P25 做空 · 止盈价低于入场、止损价高于入场',
      (short.protection.takeProfit as number) < MARK && (short.protection.stopLoss as number) > MARK,
      describeProtection(short.protection),
    )
  }

  const none = buildProtection({ mark: MARK, side: 'long', origin: 'test' })
  eq('P26 两道都没给 ⇒ 明确拒绝（不是静默返回空保护）', none.ok, false)
  check('P26b 拒绝理由指名是"没给保护"', !none.ok && none.reason.includes('NO_PROTECTION'), JSON.stringify(none))

  const noMark = buildProtection({ mark: 0, side: 'long', stopLossPct: 0.01, origin: 'test' })
  eq('P27 没有真实报价 ⇒ 拒绝（不许拿 0 定价）', noMark.ok, false)
  check('P27b 理由指名是"没有真实报价"', !noMark.ok && noMark.reason.includes('NO_MARK_PRICE'), JSON.stringify(noMark))

  // ★ 关键的不对称：做多时止损幅度 ≥ 100% ⇒ 止损价算成 0 或负数。
  //   放行它会挂出一道**永远不会触发**、却看起来设置了保护的单。
  const over = buildProtection({ mark: MARK, side: 'long', stopLossPct: 1.2, origin: 'test' })
  eq('P28 做多 · 止损 120% ⇒ 该价位不存在，必须拒绝', over.ok, false)
  check('P28b 理由指名是止损价算不出来', !over.ok && over.reason.includes('SL_PRICE_INVALID'), JSON.stringify(over))

  const onlyTp = buildProtection({ mark: MARK, side: 'long', takeProfitPct: 0.5, origin: 'test' })
  check('P29 只给止盈也是合法诉求', onlyTp.ok, JSON.stringify(onlyTp))
  if (onlyTp.ok) eq('P29b 只给止盈时止损栏留空、不许编一个数', onlyTp.protection.stopLoss, undefined)
}

// ═══════════════ ③ 接线：入参带保护 ⇒ 台账里真出现 ═══════════════
{
  resetOrch(100_000)
  seedPrice(SYM, MARK)

  const r = processOrderIntent({
    clientOrderId: 'prot-open',
    symbol: SYM,
    side: 'buy',
    type: 'market',
    qty: 0.1,
    takeProfit: 95_000,
    stopLoss: 85_000,
  })
  check('P30 带保护的下单可以被受理', r.ok, JSON.stringify(r))

  const st = getOrchState()
  const p = st.protection.get(SYM)
  check('P31 ★★ 保护真的进了台账（这正是原先丢掉的那一步）', p !== undefined, '台账里没有这道保护 ⇒ 用户以为设了保护、实际在裸跑')
  if (p) {
    eq('P32 止盈价原样带过去，没有被改写', p.takeProfit, 95_000)
    eq('P33 止损价原样带过去，没有被改写', p.stopLoss, 85_000)
    eq('P34 方向由下单方向推出', p.side, 'long')
  }

  // ★ 负向牙：不带保护时台账必须为空。
  //   没有这一条的话，"台账里有东西"可能来自任何别的写入路径，
  //   而 P31 就成了一条"别的修复顺带也能让它变绿"的假绿（判据 A3）。
  resetOrch(100_000)
  seedPrice(SYM, MARK)
  processOrderIntent({ clientOrderId: 'prot-none', symbol: SYM, side: 'buy', type: 'market', qty: 0.1 })
  eq('P35 不带保护的下单不许凭空长出一道保护', getOrchState().protection.get(SYM), undefined)
}

// ═══════════════ ④ 巡检：穿过保护位真的派出平仓单 ═══════════════
{
  resetOrch(100_000)
  seedPrice(SYM, MARK)
  processOrderIntent({
    clientOrderId: 'prot-open2',
    symbol: SYM,
    side: 'buy',
    type: 'market',
    qty: 0.1,
    takeProfit: 95_000,
    stopLoss: 85_000,
  })

  // 纸面引擎是**逐 bar 成交**：先喂两根 bar 让持仓真的成型。
  onMarketBar(SYM, BAR(1, MARK))
  onMarketBar(SYM, BAR(2, MARK))
  const pos = getOrchState().positions.get(SYM)
  check('P40 前置：持仓已经成型（否则下面的巡检无从谈起）', (pos?.qty ?? 0) > 0, `qty=${pos?.qty}`)

  const before = getOrchState().orders.length
  onPriceTick(SYM, 90_000)
  eq('P41 价格在两道之间 ⇒ 不许触发任何平仓', getOrchState().orders.length, before)

  onPriceTick(SYM, 84_000)
  const after = getOrchState().orders.length
  check('P42 ★★ 价格跌破止损 ⇒ 真的派出一张平仓单', after > before, `orders ${before} → ${after}`)

  const closeOrder = getOrchState().orders.find((o) => o.clientOrderId.startsWith('PROT-'))
  check('P43 平仓单能被指名到（幂等键是语义键前缀）', closeOrder !== undefined, '没有找到 PROT- 前缀的订单')
  if (closeOrder) {
    eq('P44 平仓方向与持仓相反', closeOrder.side, 'sell')
    check(
      'P45 幂等键带上了"哪一道"（同一道保护重复命中必须是同一个键）',
      closeOrder.clientOrderId.includes('stop-loss'),
      closeOrder.clientOrderId,
    )
  }
}

// ═══════════════ ⑤ 语音层有没有把这两个字段递下去 ═══════════════
{
  // 派单函数 `submitOrder` 没有对外导出，所以只能做源码级断言。
  // ★ 用剥过注释的代码：否则注释里写一句 `protFields` 这条断言自己就绿了。
  const src = readCode('server/voice/service.ts')
  const i = src.indexOf('function submitOrder(')
  check('P50 找得到 voice 的纸面派单函数', i > 0, 'submitOrder 不见了（改名了？那这条断言要跟着改）')
  if (i > 0) {
    const body = src.slice(i, src.indexOf('function submitLiveOrder('))
    check(
      'P51 ★★ 纸面派单真的把保护字段传给了 processOrderIntent',
      /protFields/.test(body) && /processOrderIntent\(\{[\s\S]*\.\.\.protFields/.test(body),
      'protFields 没有出现在 processOrderIntent 的入参里 ⇒ 保护又变成只念不做',
    )
    check('P52 纸面派单会调 buildProtection（不是自己算一份比例换算）', /buildProtection\(/.test(body), '没找到 buildProtection 调用')
  }

  const liveIdx = src.indexOf('function submitLiveOrder(')
  check('P53 找得到 voice 的实盘派单函数', liveIdx > 0, 'submitLiveOrder 不见了')
  if (liveIdx > 0) {
    const body = src.slice(liveIdx, liveIdx + 6_000)
    check(
      'P54 实盘带保护一律拒绝（本地巡检不是场所侧条件单）',
      /LIVE_PROTECTION_NEEDS_VENUE_STOP/.test(body),
      '实盘那条路没有拒绝带保护的单 ⇒ 会下出"靠本地进程续命"的实盘仓',
    )
  }
}

// ═══════════════ 汇总 ═══════════════
if (failures.length > 0) {
  console.error('')
  for (const f of failures) console.error(`[FAIL] ${f}`)
  console.error('')
  console.error(`PROTECTION SMOKE FAIL - ${passed} 通过 / ${failures.length} 失败`)
  process.exit(1)
}
console.log('')
console.log(
  `PROTECTION SMOKE PASSED · ${passed} 项 · ` +
    `纯函数契约 + 保护真的进台账（带负向牙）+ 巡检真的派平仓单 + 语音层真的递下去了`,
)
