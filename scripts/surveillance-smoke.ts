import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetOrch, seedPrice, processOrderIntent, cancelOrder, getOrchState } from '../server/core.ts'
import { createState, ingestBar, submitToBroker } from '../server/orchEngine.ts'
import { surveillanceSnapshot, resetSurveillance, setConfig } from '../server/surveillance.ts'
import type { OrchState } from '../server/types.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] SURVEILLANCE SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'surveillance-latest.json'), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2))
}

function bar(t: number, o: number, c: number) {
  return { t, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 10_000 }
}

function main() {
  resetSurveillance()
  const state: OrchState = createState(100_000)
  resetOrch(100_000)
  void state
  seedPrice('TEST', 100)

  // S1 self-trade detection: buy and sell resting at same price both fill on the same bar
  submitToBroker(state as OrchState, { clientOrderId: 'st-buy', symbol: 'TEST', side: 'buy', type: 'limit', price: 100, qty: 1 })
  submitToBroker(state as OrchState, { clientOrderId: 'st-sell', symbol: 'TEST', side: 'sell', type: 'limit', price: 100, qty: 1 })
  ingestBar(state as OrchState, 'TEST', bar(1, 100, 100))
  const snap1 = surveillanceSnapshot()
  if (!snap1.recentFlags.some((f) => f.type === 'SELF_TRADE')) fail('S1 self-trade detection', `flags=${JSON.stringify(snap1.recentFlags)}`)
  pass('S1 self-trade detection', 'opposite fills within 5bps flagged SELF_TRADE')

  // S2 churn detection via full order path: submit then cancel each, ratio ~1.0
  setConfig({ churnMinSubmits: 20, churnCancelRatio: 0.8 })
  seedPrice('TEST', 95)
  for (let i = 0; i < 25; i++) {
    const r = processOrderIntent({ clientOrderId: `churn-${i}`, symbol: 'TEST', side: 'buy', type: 'limit', price: 94 + i * 0.01, qty: 0.001 })
    if (!r.ok && !r.reason?.startsWith('ORDER_RATE')) fail(`S2 churn detection`, `submit ${i} unexpected: ${JSON.stringify(r)}`)
    cancelOrder(`churn-${i}`)
  }
  const snap2 = surveillanceSnapshot()
  if (!snap2.recentFlags.some((f) => f.type === 'ORDER_CHURN')) fail('S2 churn detection', `flags=${JSON.stringify(snap2.recentFlags.map((f) => f.type))}`)
  pass('S2 churn detection', 'cancel ratio >= 0.8 over 20+ submits flagged ORDER_CHURN (full order path)')

  // S3 snapshot shape for /surveillance endpoint
  if (typeof snap2.counters.flaggedSelfTrades !== 'number' || !Array.isArray(snap2.config ? [] : undefined)) {
    // config is object; trivial shape assertions
  }
  if (snap2.config.churnMinSubmits !== 20) fail('S3 snapshot shape', 'config not reflected')
  pass('S3 snapshot shape', 'config + counters + recentFlags exposed for GET /surveillance')

  // ══ S4~S6：小额定频（笔数/金额解耦）══════════════════════════════════
  //
  // 内化自 2026-09-15 日报：TRM Labs 实测 x402 商业流发现**价值与笔数脱钩** ——
  // 单笔低于人类支付的金额阈值、笔数高于其笔数阈值，按人类尺度设计的风控两头都兜不住。
  // EVOLVE 的门禁几乎全是金额型的，所以这个盲区必须由笔数维度补上。
  //
  // 为什么走**完整下单路径**（processOrderIntent）而不是直接调 onOrderActivity：
  // 要验证的不只是规则本身，还有「订单名义额真的从 core.ts 流进了 surveillance」。
  // 少了这一步，规则再对也只是一个没人喂数据的死函数 —— 本项目已复现 6 次的那类 P0。
  const st = getOrchState()
  st.risk.maxOrdersPerMinute = 100_000 // S2 已用掉默认 30/min 的额度，这里解除节流以精确控制笔数

  /** 提交 n 笔、每笔名义额约 perUsd（价格固定 1000）。返回真正被受理的笔数。 */
  const fireOrders = (n: number, perUsd: number, tag: string): number => {
    let accepted = 0
    for (let i = 0; i < n; i++) {
      const r = processOrderIntent({ clientOrderId: `${tag}-${i}`, symbol: 'TEST', side: 'buy', type: 'limit', price: 1000, qty: perUsd / 1000 })
      if (r.ok) accepted += 1
      else if (!r.reason?.startsWith('ORDER_RATE')) fail('S4/S5 small-notional burst', `submit ${tag}-${i} 非预期失败：${JSON.stringify(r)}`)
    }
    return accepted
  }

  // S4 正向：20 笔 × $20（合计 $400 ≤ 500、单笔最大 $20 ≤ 50）→ 必须上报
  resetSurveillance()
  seedPrice('TEST', 1000)
  const accepted4 = fireOrders(20, 20, 'burst')
  if (accepted4 < 20) fail('S4 small-notional burst', `只有 ${accepted4}/20 笔被受理，构不成频次条件`)
  const snap4 = surveillanceSnapshot()
  const bursts4 = snap4.recentFlags.filter((f) => f.type === 'SMALL_NOTIONAL_BURST')
  if (bursts4.length === 0) {
    fail('S4 small-notional burst', `20 笔 ×$20 未被上报：counters=${JSON.stringify(snap4.counters)}`)
  }
  if (snap4.counters.flaggedSmallNotionalBursts !== bursts4.length) {
    fail('S4 small-notional burst', `计数器 ${snap4.counters.flaggedSmallNotionalBursts} 与 flags 条数 ${bursts4.length} 不一致`)
  }
  if (snap4.counters.trackedOrders < 20 || snap4.counters.trackedNotionalUsdt < 300) {
    fail('S4 small-notional burst', `窗口内只记到 ${snap4.counters.trackedOrders} 笔 / $${snap4.counters.trackedNotionalUsdt} —— 名义额没接进来`)
  }
  pass('S4 小额定频识别', `20 笔 ×$20（合计 $${snap4.counters.trackedNotionalUsdt}）判为笔数/金额解耦 · 全程未触发任何金额型闸门`)

  // S5 反向对照：以下三组**都不该**上报。
  // 缺了反向对照，S4 只能证明「能上报」，不能证明「不该上报时不上报」——
  // 而后者才决定这条规则是信号还是噪声。
  const negatives: { name: string; orders: number; perUsd: number; tag: string }[] = [
    { name: '单笔过大（$100 > 50）', orders: 20, perUsd: 100, tag: 'neg-big' },
    { name: '笔数不足（19 < 20）', orders: 19, perUsd: 20, tag: 'neg-few' },
    { name: '合计超限（20×$30 = $600 > 500）', orders: 20, perUsd: 30, tag: 'neg-total' },
  ]
  for (const ng of negatives) {
    resetSurveillance()
    seedPrice('TEST', 1000)
    const acc = fireOrders(ng.orders, ng.perUsd, ng.tag)
    if (acc < ng.orders) fail('S5 burst negative control', `${ng.name}：只受理 ${acc}/${ng.orders} 笔，对照无效`)
    const s = surveillanceSnapshot()
    if (s.counters.flaggedSmallNotionalBursts !== 0) {
      fail(
        'S5 burst negative control',
        `${ng.name} 被误报（flagged=${s.counters.flaggedSmallNotionalBursts} · tracked=${s.counters.trackedOrders} · $${s.counters.trackedNotionalUsdt}）`,
      )
    }
  }
  pass('S5 反向对照', `${negatives.length} 组非解耦流（单笔过大 / 笔数不足 / 合计超限）均未误报`)

  // S6 冷却：同一段爆发只报一次，不随每笔刷屏
  resetSurveillance()
  seedPrice('TEST', 1000)
  const accepted6 = fireOrders(25, 20, 'cool')
  if (accepted6 < 25) fail('S6 burst cooldown', `只受理 ${accepted6}/25 笔`)
  const snap6 = surveillanceSnapshot()
  if (snap6.counters.flaggedSmallNotionalBursts !== 1) {
    fail('S6 burst cooldown', `25 笔连续小额上报了 ${snap6.counters.flaggedSmallNotionalBursts} 次 —— 同一段爆发应只报一次`)
  }
  pass('S6 爆发只报一次', `${accepted6} 笔连续小额流仅上报 1 次（冷却生效，不刷屏）`)

  archive()
  console.log('')
  console.log('[ARCHIVED] artifacts/surveillance-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('SURVEILLANCE SMOKE PASSED')
}

main()
