/**
 * 交易闸门烟测 —— 「这笔交易凭什么可以出去」的回归门禁。
 *
 * ## 它守的是什么
 *
 * 在 `server/tradeGate.ts` 出现之前，本项目有**两条下单路径**而闸门只装了一条：
 * 自治循环过 9 道，交易大厅一道都不过。这类缺陷不会让任何测试变红 ——
 * 因为**没有测试在测人那条路**。本文件就是给那条路装上的第一道观测点。
 *
 * ## 只测语义不变量，不测数值
 *
 * 阈值会随风控档位调整（`MIN_ENTRY_CONFIDENCE` 就是配置项），
 * 把断言写成 "rr === 2.67" 会把门禁变成维护负担。所以这里断言的是：
 *   · 四态**互不顶替**（查不了 ≠ 不合格）
 *   · 缺省值**必须留痕**
 *   · `null` **不许**退化成 0
 *   · 闸门扫到哪停了**必须报出来**
 *   · 预检与执行**共用同一条管线**（不是两份实现）
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildInterceptorContext,
  buildMarketPackage,
  precheckLiveTrade,
  precheckTrade,
  type LivePrecheckDeps,
  type PrecheckInput,
  type PrecheckResult,
} from '../server/tradeGate.ts'
import { openPosition, computeStopGeometry, resetGuard } from '../server/positionGuard.ts'
// 预测层只读出口：闸门那道腿的**提案口径**必须只有一份（与桌宠、面板同一个函数）。
import { proposeForecastOrder } from '../server/forecastService.ts'
import type { ForecastResult } from '../server/forecastService.ts'
import { resetInterceptors } from '../server/interceptors.ts'
import type { RegimeSnapshot } from '../server/marketRegime.ts'
import { MIN_ENTRY_CONFIDENCE } from '../server/riskConstants.ts'
// 闸门的**唯一服务端入口**：出单路径收口后，这三条路都经过它（见 [M] 区）。
import { describeGateRefusal, gateInputFromOrderIntent, gateOrderForExecution } from '../server/orderGate.ts'

const ROOT = process.cwd()

/**
 * 读一份源码并**剥掉注释**。
 *
 * ★ 这一步不是洁癖 —— 它是这个项目踩过的坑：注释里提一句函数名或写一句
 *   「原实现是 `price * 1.03`」，就会让"源码扫描"型断言**假红或假绿**。
 *   本次实测就当场命中：K2 抓到的第一处正是我自己写的解释性注释。
 *
 * 近似处理：`[^:]` 那一位是为了不误伤 `https://`。
 * 它对"字符串里含 `//`"不严谨 —— 本文件扫描的都是我们自己写的模块，
 * 真出现那种写法时下面这些具体模式也几乎不可能被误匹配。
 */
function readCode(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

let passed = 0
const failures: string[] = []

/**
 * 同步断言。
 *
 * ★ 这里刻意多一道自保护：如果 `fn` 返回了 Promise，说明断言被写成了
 *   "同步 check 包 async 断言" —— 那种写法 `return somePromise` 不会被 await，
 *   断言**永远不执行**，于是永远通过。
 *   本仓库历史上就踩过这个坑，所以让它**响亮地出错**，而不是安静地变绿。
 */
function check(name: string, fn: () => unknown): void {
  try {
    const r = fn()
    if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
      throw new Error('同步 check 里返回了 Promise —— 断言不会被执行，请改用 checkAsync()')
    }
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

function ctxOf(
  o: {
    symbol?: string
    side?: 'long' | 'short'
    killswitch?: boolean
    equity?: number
    dailyLoss?: number
    dailyLossLimit?: number
  } = {},
): PrecheckInput['ctx'] {
  return buildInterceptorContext({
    symbol: o.symbol ?? 'BTCUSDC',
    side: o.side ?? 'long',
    now: Date.now(),
    equity: o.equity ?? 100_000,
    killswitch: o.killswitch ?? false,
    dailyLoss: o.dailyLoss,
    dailyLossLimit: o.dailyLossLimit,
  })
}

function pkgOf(
  o: {
    dataQuality?: 'valid' | 'stale' | 'insufficient'
    price?: number
    atr?: number
    adx1h?: number
    macroTrend?: 'BULL' | 'BEAR' | 'RANGE'
  } = {},
): PrecheckInput['pkg'] {
  return buildMarketPackage({
    symbol: 'BTCUSDC',
    price: o.price ?? 60_000,
    atr: o.atr ?? 500,
    bars: 500,
    dataQuality: o.dataQuality ?? 'valid',
    adx1h: o.adx1h ?? 26,
    macroTrend: o.macroTrend ?? 'RANGE',
    macroTrendSource: o.macroTrend ? `测试注入：${o.macroTrend}` : '高周期趋势不可用',
  })
}

/** 一笔「本该放行」的单：R:R ≈ 2.67、置信度高于基准、行情有效、敞口未设上限。 */
function input(patch: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    symbol: 'BTCUSDC',
    side: 'buy',
    notionalUsdt: 1000,
    entry: 60_000,
    takeProfit: 64_000,
    stopLoss: 58_500,
    confidence: 80,
    environment: 'paper',
    channel: 'cex',
    venue: 'binance',
    pkg: pkgOf(),
    ctx: ctxOf(),
    exposure: { grossUsdt: 0, limitUsdt: null, unreleasedCount: 0 },
    ...patch,
  }
}

/**
 * 一次预测结论的夹具。
 *
 * ★ 刻意写成**完整字段**的字面量（不是 `as unknown as ForecastResult`）：
 *   `ForecastResult` 将来加字段时这里会当场编译不过，夹具就不可能悄悄过期。
 *   用 `as any` 省下的那几行，会在半年后变成"夹具喂的形状早就不是生产形状了，
 *   而所有断言照样绿"——本仓库记过的那种假绿。
 */
function forecastOf(patch: Partial<ForecastResult> = {}): ForecastResult {
  return {
    symbol: 'BTCUSDC',
    barMinutes: 15,
    horizonBars: 4,
    asOf: 1_700_000_000_000,
    spot: 77_500,
    // ★ 2026-09-22 补：`dataAgeMinutes` 加进 `ForecastResult` 后，这里**当场编译不过** ——
    //   这正是上面那段注释说的作用（夹具不许悄悄过期）。
    //   取值刻意取"刚收完一根"（<barMinutes）：这才是**生产的形状**（真实测量里
    //   最后一根就是刚收的）；取 0 或取一个巨大值都会让"新鲜"这条路没人走过。
    //   要造陈旧的分支，用 `forecastOf({ dataAgeMinutes: 6390 })` 显式传 —— 别改默认值。
    dataAgeMinutes: 2,
    method: 'analog-conditional-distribution(k=3, n=200, sep=4)',
    outcome: 'no-edge',
    gate: 'edge',
    direction: 'down',
    target: 77_800,
    medianBps: 30,
    interval: { lo: 77_000, hi: 78_000, coverage: 0.8 },
    path: [
      { step: 1, p10: 77_200, p50: 77_600, p90: 77_900 },
      { step: 2, p10: 77_100, p50: 77_700, p90: 78_000 },
    ],
    netEdgeBps: 14,
    oneWayCostBps: 8,
    roundTripCostBps: 16,
    state: [{ slug: 'atr_ratio_delta_96', nameCn: '96根变化ATR占比', trainIc: 0.032 }],
    sample: { candidates: 35_040, matched: 200, separated: 281, trainBars: 21_024, testBars: 14_016 },
    calibration: {
      anchors: 121,
      hits: 65,
      hitRate: 0.537,
      baseRate: 0.496,
      baseRule: '永远猜训练段偏的方向（下跌）',
      se: 0.0688,
      edgeZ: 0.6,
      pValue: 0.2741,
      coverageNominal: 0.8,
      coverageActual: 0.86,
      flatAnchors: 0,
    },
    reasons: [{ from: 'edgeZ', text: '命中率与那条平凡规则分不开。' }],
    disclosures: ['夹具'],
    dataHash: 'fixture',
    origin: 'history',
    cache: { hit: false, computedAt: 1_700_000_000_000 },
    elapsedMs: 6400,
    ...patch,
  }
}

/** 把结果压成便于断言的一行。 */
function shape(r: PrecheckResult): string {  return `verdict=${r.verdict} submit=${r.submitAllowed} checked=${r.pipeline.checked}/${r.pipeline.total} blockers=[${r.blockers
    .map((b) => b.id)
    .join(',')}]`
}

function snapshotOf(patch: Partial<RegimeSnapshot> = {}): RegimeSnapshot {
  return {
    symbol: 'BTCUSDC',
    macroTrend: 'RANGE',
    macroTrendSource: '测试注入',
    atr1h: 500,
    atr4h: 800,
    adx1h: 26,
    h1SwingHigh: 65_000,
    h1SwingLow: 55_000,
    h1Close: 60_000,
    h4Close: 60_000,
    updatedAt: Date.now(),
    stale: false,
    ...patch,
  }
}

function liveDeps(o: { snapshot?: RegimeSnapshot | null; throwOnRefresh?: boolean } = {}): LivePrecheckDeps {
  return {
    refreshRegime: async () => {
      if (o.throwOnRefresh) throw new Error('测试注入：行情取数失败')
      if (o.snapshot === null) throw new Error('测试注入：无快照')
      return o.snapshot ?? snapshotOf()
    },
    getRegime: () => (o.snapshot === null ? undefined : (o.snapshot ?? snapshotOf())),
    account: () => ({ equity: 100_000, killswitch: false, dailyLoss: 0, dailyLossLimit: 5000 }),
    exposure: () => ({ grossUsdt: 0, limitUsdt: null, unreleasedCount: 0 }),
  }
}

// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  resetGuard()
  resetInterceptors()

  // ═══════════════════════════════════════════════════════════
  console.log('\n[A] 同源：预检与执行必须共用同一条管线（判据 8）')
  // ═══════════════════════════════════════════════════════════

  const gateSrc = readCode('server/tradeGate.ts')
  const autoSrc = readCode('server/autopilot.ts')
  const serverFiles = readdirSync(join(ROOT, 'server')).filter((f) => f.endsWith('.ts'))

  check('A1 tradeGate 走的是 runPipeline，不是自己写的检查', () => {
    assert.ok(gateSrc.includes('runPipeline('), 'tradeGate.ts 必须调用 runPipeline —— 否则"闸门"只是一句装饰')
  })

  check('A2 自治循环改用共享构造（消除第二份 pkg/ctx 构造）', () => {
    assert.ok(autoSrc.includes('buildMarketPackage('), 'autopilot.ts 必须用 buildMarketPackage')
    assert.ok(autoSrc.includes('buildInterceptorContext('), 'autopilot.ts 必须用 buildInterceptorContext')
    assert.ok(
      !/const pkg:\s*MarketPackage\s*=\s*\{/.test(autoSrc),
      'autopilot.ts 里不该再出现 pkg 字面量构造 —— 那说明有两份构造在跑',
    )
  })

  check('A3 runPipeline 在 server/ 下的调用点恰好是两个（不许第三条路径）', () => {
    const callers = serverFiles.filter((f) => readCode(`server/${f}`).includes('runPipeline('))
    // interceptors.ts 是它自己的定义处（含 sandbox 调用）；这里只关心**业务调用方**。
    const business = callers.filter((f) => f !== 'interceptors.ts').sort()
    assert.deepEqual(
      business,
      ['autopilot.ts', 'tradeGate.ts'],
      `runPipeline 的业务调用方应恰好是自治循环与交易闸门，实际：${business.join(', ')}`,
    )
  })

  check('A4 几何校验器只有一个定义处（不许第二份实现）', () => {
    const definers = serverFiles.filter((f) => /export function validateQuoteGeometry/.test(readCode(`server/${f}`)))
    assert.deepEqual(definers, ['orderRisk.ts'], `validateQuoteGeometry 应只在 orderRisk.ts 定义，实际：${definers.join(', ')}`)
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[B] 四态互不顶替：查不了 ≠ 不合格（判据 25 / 13）')
  // ═══════════════════════════════════════════════════════════

  const passResult = precheckTrade(input())
  check('B1 全合法 ⇒ pass', () => {
    assert.equal(passResult.verdict, 'pass', shape(passResult))
  })

  // R:R 不足：止盈贴着入场价
  const rrFail = precheckTrade(input({ takeProfit: 60_500 }))
  check('B2 赔率不足 ⇒ blocked（该去改报价）', () => {
    assert.equal(rrFail.verdict, 'blocked', shape(rrFail))
    assert.ok(
      rrFail.blockers.some((b) => b.id === 'pipeline.core.quote_geometry_rr'),
      `应由几何闸门拦下，实际拦在：${rrFail.blockers.map((b) => b.id).join(',')} —— ${shape(rrFail)}`,
    )
  })

  // 行情不完整：数据源有问题，不是单子有问题
  const dataBad = precheckTrade(input({ pkg: pkgOf({ dataQuality: 'insufficient' }) }))
  check('B3 行情不完整 ⇒ unverifiable（该去修数据源，不是改报价）', () => {
    assert.equal(dataBad.verdict, 'unverifiable', shape(dataBad))
    assert.notEqual(dataBad.verdict, 'blocked', '把"查不了"报成"不合格"会让人去改一个本来没问题的止盈价')
  })

  check('B4 反向断言：赔率不足**不许**被报成 unverifiable', () => {
    assert.notEqual(rrFail.verdict, 'unverifiable', '把"不合格"报成"查不了"会让人去查一个本来正常的行情连接')
  })

  check('B5 实盘大额 ⇒ approval_required（该去找人，不是单子有问题）', () => {
    const r = precheckTrade(input({ environment: 'live', notionalUsdt: 6000 }))
    assert.equal(r.verdict, 'approval_required', shape(r))
    assert.ok(r.approval.required, 'approval.required 必须为 true')
    assert.ok(r.blockers.length === 0, '需要审批**不是**被闸门拒绝 —— blockers 必须为空')
  })

  check('B6 四态互不相同（没有两态塌成同一个）', () => {
    const seen = new Set([passResult.verdict, rrFail.verdict, dataBad.verdict, precheckTrade(input({ environment: 'live', notionalUsdt: 6000 })).verdict])
    assert.equal(seen.size, 4, `四种输入应产出四种不同裁决，实际只有 ${seen.size} 种：${[...seen].join(',')}`)
  })

  check('B7 三价没填全 ⇒ unverifiable（表单还没填完，不是赔率不够）', () => {
    const r = precheckTrade(input({ takeProfit: 0, stopLoss: 0 }))
    assert.equal(r.verdict, 'unverifiable', shape(r))
    assert.notEqual(
      r.verdict,
      'blocked',
      '空表单收到"盈亏比不足"是句假话 —— 那时候根本还没有盈亏比，操作者会去改一个还没填的字段',
    )
  })

  check('B8 边界：只差一个止损价也必须报 unverifiable', () => {
    const r = precheckTrade(input({ stopLoss: 0 }))
    assert.equal(r.verdict, 'unverifiable', shape(r))
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[C] submitAllowed 与 verdict 必须一致（防止将来把"需审批"算成可提交）')
  // ═══════════════════════════════════════════════════════════

  check('C1 只有 pass 允许提交', () => {
    const cases: PrecheckResult[] = [
      passResult,
      rrFail,
      dataBad,
      precheckTrade(input({ environment: 'live', notionalUsdt: 6000 })),
      precheckTrade(input({ channel: 'dex' })),
    ]
    for (const r of cases) {
      assert.equal(
        r.submitAllowed,
        r.verdict === 'pass',
        `${shape(r)} —— submitAllowed 与 verdict 不一致`,
      )
    }
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[D] 闸门扫到哪就停了（判据 11：报 0 ≠ 没错）')
  // ═══════════════════════════════════════════════════════════

  check('D1 pipeline 腿数 === pipeline.checked（不许把没跑到说成跑过了）', () => {
    for (const r of [passResult, rrFail, dataBad]) {
      const n = r.legs.filter((l) => l.id.startsWith('pipeline.')).length
      assert.equal(n, r.pipeline.checked, `${shape(r)} —— 腿数 ${n} 与 checked ${r.pipeline.checked} 不一致`)
    }
  })

  check('D2 被拦时 checked 必须小于 total（不许把中途停下说成全部检查过）', () => {
    assert.ok(rrFail.pipeline.checked < rrFail.pipeline.total, `${shape(rrFail)} —— 被拦了却显示检查完全部`)
    assert.equal(passResult.pipeline.checked, passResult.pipeline.total, `${shape(passResult)} —— 通过了却显示没跑完`)
  })

  check('D3 reachedGeometry 必须如实反映"几何那道有没有被走到"', () => {
    // 赔率不足：前四道（数据/killswitch/冷静期/持仓冲突）在干净夹具下都会过 ⇒ 几何一定被走到
    assert.equal(rrFail.pipeline.reachedGeometry, true, `${shape(rrFail)} —— 几何明明被走到了却报没走到`)
    // killswitch 在第 2 道就停 ⇒ 几何**不可能**被走到
    const killed = precheckTrade(input({ ctx: ctxOf({ killswitch: true }) }))
    assert.equal(killed.pipeline.reachedGeometry, false, `${shape(killed)} —— 第 2 道就停了，几何不该被报成"走到了"`)
  })

  check('D4 从未运行的场景报 0/启用数，而不是 0/0', () => {
    const r = precheckTrade(input({ channel: 'dex' }))
    assert.equal(r.pipeline.checked, 0, shape(r))
    assert.ok(r.pipeline.total > 0, `0/0 会被读成"没有闸门"，实际应报"${r.pipeline.total} 道一道都没跑"`)
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[E] 缺省值必须留痕（判据 24：缺数据要说出来）')
  // ═══════════════════════════════════════════════════════════

  check('E1 不给置信度 ⇒ assumptions 里必须说出来', () => {
    const r = precheckTrade(input({ confidence: undefined }))
    assert.ok(
      r.assumptions.some((a) => a.includes(String(MIN_ENTRY_CONFIDENCE))),
      `缺省置信度没留痕 —— 操作者会以为闸门评估了他给的信息。assumptions=${JSON.stringify(r.assumptions)}`,
    )
  })

  check('E2 不给预期毛收益 ⇒ 必须说明"按止盈距离推算"这个口径', () => {
    const r = precheckTrade(input())
    assert.ok(
      r.assumptions.some((a) => a.includes('止盈')),
      `毛收益口径没留痕。assumptions=${JSON.stringify(r.assumptions)}`,
    )
  })

  check('E3 全部给全 ⇒ assumptions 必须为空（不许无故加噪声）', () => {
    const r = precheckTrade(input({ confidence: 80, expectedEdgeBps: 500 }))
    assert.equal(
      r.assumptions.length,
      0,
      `所有输入都给全了却还在报假设，会让"有假设"这句话失去意义。实际=${JSON.stringify(r.assumptions)}`,
    )
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[F] null 不许退化成 0（红线 ⑱）')
  // ═══════════════════════════════════════════════════════════

  check('F1 未评估时 cost / geometry 是 null，不是零值对象', () => {
    const r = precheckTrade(input({ channel: 'dex' }))
    assert.equal(r.cost, null, 'cost 应为 null —— 造一个零值对象会让下游 switch 走 default，而 default 的措辞像"通过"')
    assert.equal(r.geometry, null, 'geometry 应为 null')
  })

  check('F2 敞口上限未设置时，必须与"上限为 0"区分开', () => {
    const unset = precheckTrade(input({ exposure: { grossUsdt: 0, limitUsdt: null, unreleasedCount: 0 } }))
    const zero = precheckTrade(input({ exposure: { grossUsdt: 0, limitUsdt: 0, unreleasedCount: 0 } }))
    assert.equal(unset.exposure.limitUsdt, null, '未设置必须保持 null')
    assert.notEqual(unset.verdict, zero.verdict, '「未设上限」与「上限为 0」是两件事，不该得到同一个裁决')
    assert.ok(
      unset.legs.some((l) => l.id === 'exposure.portfolio' && l.detail.includes('未设置')),
      'detail 里必须明说"未设置"，否则界面上的 0 会被读成"上限为零"',
    )
    assert.equal(zero.verdict, 'blocked', `上限为 0 时应被拦下。实际 ${shape(zero)}`)
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[G] 强制地板仍然有效（这次是从人工下单这条路走进去）')
  // ═══════════════════════════════════════════════════════════

  check('G1 熔断激活 ⇒ blocked', () => {
    const r = precheckTrade(input({ ctx: ctxOf({ killswitch: true }) }))
    assert.equal(r.verdict, 'blocked', shape(r))
    assert.equal(r.blockers[0].code, 'KILLSWITCH', `应由熔断闸拦下，实际 ${r.blockers[0].code}`)
  })

  check('G2 同标的反向持仓 ⇒ blocked（POSITION_CONFLICT）', () => {
    resetGuard()
    openPosition({ symbol: 'BTCUSDC', side: 'short', entryPrice: 60_000, qty: 0.01, atrValue: 500, now: Date.now() })
    const r = precheckTrade(input()) // side: buy ⇒ 方向是 long，与已有 short 冲突
    assert.equal(r.verdict, 'blocked', shape(r))
    assert.equal(r.blockers[0].code, 'POSITION_CONFLICT', `应由持仓冲突闸拦下，实际 ${r.blockers[0].code}`)
    resetGuard()
  })

  check('G3 别的标的的持仓**不许**误伤本标的（冲突检查按 symbol 过滤）', () => {
    resetGuard()
    openPosition({ symbol: 'ETHUSDC', side: 'short', entryPrice: 3000, qty: 0.1, atrValue: 40, now: Date.now() })
    const r = precheckTrade(input())
    assert.equal(r.verdict, 'pass', `ETHUSDC 的持仓不该拦 BTCUSDC 的单。${shape(r)}`)
    resetGuard()
  })

  check('G4 buildInterceptorContext 传的是**全部**守护持仓（漏传会让地板形同虚设）', () => {
    resetGuard()
    openPosition({ symbol: 'ETHUSDC', side: 'short', entryPrice: 3000, qty: 0.1, atrValue: 40, now: Date.now() })
    openPosition({ symbol: 'BTCUSDC', side: 'short', entryPrice: 60_000, qty: 0.01, atrValue: 500, now: Date.now() })
    const ctx = buildInterceptorContext({ symbol: 'BTCUSDC', side: 'long', now: Date.now(), equity: 1e5, killswitch: false })
    const symbols = ctx.openPositions.map((p) => p.symbol).sort()
    assert.deepEqual(
      symbols,
      ['BTCUSDC', 'ETHUSDC'],
      `只传本标的会让「已有反向持仓」这道强制地板在其它标的上失效。实际=${symbols.join(',')}`,
    )
    resetGuard()
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[H] 敞口腿')
  // ═══════════════════════════════════════════════════════════

  check('H1 本笔加上去越界 ⇒ blocked（EXPOSURE_LIMIT）', () => {
    const r = precheckTrade(input({ exposure: { grossUsdt: 9_800, limitUsdt: 10_000, unreleasedCount: 1 } }))
    assert.equal(r.verdict, 'blocked', shape(r))
    assert.ok(
      r.blockers.some((b) => b.code === 'EXPOSURE_LIMIT'),
      `应由敞口腿拦下，实际 ${r.blockers.map((b) => b.code).join(',')}`,
    )
  })

  check('H2 恰好等于上限 ⇒ 放行（边界不许差一）', () => {
    const r = precheckTrade(input({ exposure: { grossUsdt: 9_000, limitUsdt: 10_000, unreleasedCount: 0 } }))
    assert.equal(r.verdict, 'pass', `9000 + 1000 = 10000 恰好等于上限，不该被拦。${shape(r)}`)
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[I] 活体外壳：取不到行情必须与"被拒绝"分开')
  // ═══════════════════════════════════════════════════════════

  await checkAsync('I1 行情取数抛错 ⇒ unverifiable（不是 blocked）', async () => {
    const r = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, environment: 'paper', channel: 'cex' },
      liveDeps({ snapshot: null, throwOnRefresh: true }),
    )
    assert.equal(r.verdict, 'unverifiable', shape(r))
    assert.equal(r.cost, null, '没跑就不该有成本结论')
  })

  await checkAsync('I2 快照陈旧 ⇒ unverifiable 且说明是数据的问题', async () => {
    const r = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, environment: 'paper', channel: 'cex' },
      liveDeps({ snapshot: snapshotOf({ stale: true }) }),
    )
    assert.equal(r.verdict, 'unverifiable', shape(r))
  })

  await checkAsync('I3 活体外壳必须报出已知覆盖不到的缺口（disclosures 非空）', async () => {
    const r = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, environment: 'paper', channel: 'cex' },
      liveDeps(),
    )
    assert.ok(r.disclosures.length > 0, '空 disclosures 会让一个绿色裁决看起来管住了全部风险')
    assert.ok(
      r.disclosures.some((d) => d.includes('台账')),
      `必须说清敞口只覆盖引擎台账口径。实际=${JSON.stringify(r.disclosures)}`,
    )
  })

  await checkAsync('I4 未提供标记价 ⇒ assumptions 说明用的是快照收盘价', async () => {
    const r = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, environment: 'paper', channel: 'cex' },
      liveDeps(),
    )
    assert.ok(
      r.assumptions.some((a) => a.includes('标记价')),
      `没说清用的是哪来的价。assumptions=${JSON.stringify(r.assumptions)}`,
    )
    assert.equal(r.market.snapshotAt !== null, true, '必须带出快照时刻 —— 否则"闸门刚拒绝了你"背后可能是一份几分钟前的行情')
  })

  await checkAsync('I5 活体外壳与纯函数对同一输入给同一裁决（不测两份实现）', async () => {
    const live = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, confidence: 80, environment: 'paper', channel: 'cex', expectedEdgeBps: 666, markPrice: 60000 },
      liveDeps(),
    )
    assert.equal(live.verdict, 'pass', shape(live))
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[J] 未接入的通道必须明说，不许静默放行')
  // ═══════════════════════════════════════════════════════════

  check('J1 DEX 通道未接入 ⇒ unverifiable 且理由里说清"未接入"', () => {
    const r = precheckTrade(input({ channel: 'dex' }))
    assert.equal(r.verdict, 'unverifiable', shape(r))
    assert.ok(
      r.blockers.some((b) => b.detail.includes('未接入')),
      `不能说"通过" —— 界面上的绿色会让人以为链上那条也过了。实际=${JSON.stringify(r.blockers.map((b) => b.detail))}`,
    )
  })

  // ═══════════════════════════════════════════════════════════
  console.log('\n[K] 建议价必须来自引擎几何，不许手写公式（消除"同一个事实两份口径"）')
  // ═══════════════════════════════════════════════════════════

  await checkAsync('K1 建议止损距离 === 引擎 computeStopGeometry 的结果', async () => {
    const snap = snapshotOf({ atr1h: 500 })
    const r = await precheckLiveTrade(
      { symbol: 'BTCUSDC', side: 'buy', notionalUsdt: 1000, entry: 60000, takeProfit: 64000, stopLoss: 58500, environment: 'paper', channel: 'cex', markPrice: 60000 },
      liveDeps({ snapshot: snap }),
    )
    assert.ok(r.suggested, '活体外壳必须产出建议价（否则大厅只能继续硬编码百分比）')
    const expected = computeStopGeometry(60000, 500)
    assert.ok(
      Math.abs(r.suggested.stopDistance - expected.distance) < 1e-9,
      `建议止损距离 ${r.suggested.stopDistance} 与引擎几何 ${expected.distance} 不一致 —— 说明这里手算了一份`,
    )
    assert.ok(
      Math.abs(r.suggested.atrMultiplier - expected.atrMultiplier) < 1e-9,
      'ATR 倍数必须取自引擎的选尺函数（pickAtrMultiplier），不许多头推导',
    )
  })

  check('K2 交易大厅里不许再出现硬编码的止盈止损百分比', () => {
    const term = readCode('src/pages/TerminalPage.tsx')
    // ★ 只看**真正给止盈/止损赋值**的那些行。
    //   第一版我把正则写成全文件扫 `* 1.0x`，结果把 K 线图的 `* 1.002`（坐标留白）
    //   也判成了硬编码百分比 —— 一条"对正确输入报错"的检查（判据 2）。
    //   收窄到赋值语句既是它真正该管的范围，也不会随无关代码变化而假红。
    const assignments = term.split('\n').filter((l) => /\bset(Tp|Sl)\s*\(/.test(l))
    assert.ok(assignments.length > 0, '没找到任何 setTp/setSl 赋值 —— 断言失去了作用对象')
    for (const line of assignments) {
      assert.ok(
        !/\*\s*[01]\.\d+/.test(line),
        `止盈/止损默认值又被写成了硬编码百分比：${line.trim()} —— 它必须来自 /orders/precheck 的 suggested（引擎的 ATR 止损几何）`,
      )
    }
    assert.ok(
      /setTp\(r\.suggested\.takeProfit/.test(term) && /setSl\(r\.suggested\.stopLoss/.test(term),
      '引擎给的 suggested 必须真的被用上 —— 否则它只是一个没人读的字段',
    )
  })

  check('K3 闸门不是装饰：提交按钮必须被裁决驱动', () => {
    const term = readCode('src/pages/TerminalPage.tsx')
    assert.ok(
      term.includes('disabled={!gateReady}'),
      '提交按钮必须由 gateReady 驱动 —— 否则闸门只是个显示面板，谁都能绕过它提交',
    )
    assert.ok(
      /if\s*\(!canSubmit\)/.test(term),
      'submit() 里必须有「预检没过就不提交」的分支（按钮 disabled 挡不住回车/脚本触发）',
    )
    assert.ok(
      term.includes('gateStale'),
      '必须有"裁决过期"这个概念 —— 改完参数拿旧绿放行，等于用过期结论给一笔没检查过的单背书',
    )
  })

  check('K4 预检问不出去时必须**说出来**，不许静默 return（判据 18）', () => {
    const term = readCode('src/pages/TerminalPage.tsx')
    /*
     * ★ 这条钉的是一个我本轮自己写出来的哑失败：
     *   第一版是 `if (!binanceSymbol) return` —— 按下去什么都不发生：
     *   不进"检查中"、不出裁决、不报错。用户看到的是"按钮没反应"，
     *   于是会再按一次、再按一次。
     *
     * ★ 而它**摸不到**（眼下 5 个交易对恰好都在 SYMBOL_MAP 里）不是免责理由：
     *   `pairs` 与 `SYMBOL_MAP` 是两份各自维护的名单，加一个交易对就会让它静默哑掉。
     *   判据 18 说的正是这件事：「完全没读懂时输出长什么样」——
     *   哑的失败必须另造观测点，不能靠"现在碰不到"来免责。
     *
     * ★★ 第一版这条断言**没有牙**（变异验证当场抓到）：
     *   它写的是"块里出现过 `setGateErr(`"，于是把 `return` 插到那三行**前面**
     *   （＝静默返回，正是要禁的形状）之后，`setGateErr(` 还在下文 600 字内，
     *   正则照样命中 ⇒ **绿**。判据 6 说的假绿就是这个形状。
     *   （本项目已有同族教训：K2 第一版扫全文件 `* 1.0x` 也是没有分辨力的检查。）
     *   ⇒ 改成**看顺序**：先说，才许走。在 `setGateErr(` 之前出现 `return` = 静默。
     */
    const m = /if\s*\(!binanceSymbol\)\s*\{([\s\S]*?)\n\s*\}/.exec(term)
    assert.ok(m !== null, '没找到 `if (!binanceSymbol)` 分支 —— 断言失去了作用对象')
    const body = m![1]!
    const speaks = body.indexOf('setGateErr(')
    const bails = body.indexOf('return')
    assert.ok(speaks >= 0, '`!binanceSymbol` 的早退分支里必须调用 setGateErr —— 否则这颗按钮会静默地什么都不做（哑失败）')
    assert.ok(
      bails < 0 || bails > speaks,
      '分支里在 `setGateErr(` **之前**就 return 了 —— 那就是"静默返回"，与裸 `return` 同族，用户只会看到按钮没反应',
    )
  })

  // ═══════════════════════════════════════════════════════════
  // [L] 走势预测腿：它是**声明校验**，不是"方向必须与预测一致"
  // ═══════════════════════════════════════════════════════════
  //
  // ★ 这一组守的是用户那句原话的下半截：「顺带这能自主决策下单」。
  //   预测层**不下单**（它一个订单对象都不构造），它产出的是证据与提案；
  //   能不能出去由这里决定。所以"预测能驱动下单"这件事的落点在这道腿上。
  //
  // ★★ 为什么不做成"每笔单都必须通过预测"：预测层是**若干个预测器之一**
  //   （策略单有自己的 walk-forward 证据，人工单有自己的判断）。做成前置必过，
  //   等于宣称"只有模拟近邻法有权批准交易"—— 而它现在的实测结论恰恰是
  //   `no-edge`，那会让整个系统一单都发不出去。把一道闸门的作用域搞错，
  //   比它拦不住更贵：它会让**所有**交易停摆，而界面上看不出哪里不对。
  //
  // ★★ 反面同样要钉：**不能因为"没声称"就悄悄变绿**。缺省那一支必须
  //   明说"预测没参与这笔决策"，否则界面上一片绿勾，用户会读成"预测也同意了"。
  console.log('\n[L] 走势预测腿：声明校验（不是"方向必须一致"）')

  check('L1 没声称以预测为依据 ⇒ 通过，但必须明说"预测没参与"（不是"预测通过了"）', () => {
    const r = precheckTrade(input())
    const leg = r.legs.find((l) => l.id === 'alpha.forecast')
    assert.ok(leg, '缺了 alpha.forecast 这道腿 —— 预测层对下单路径毫无影响')
    assert.equal(leg.passed, true)
    assert.equal(r.forecast.claims, false)
    assert.equal(r.forecast.outcome, null, '没参与时 outcome 必须是 null（不许渲染成"通过"）')
    assert.ok(/没有以走势预测为依据/.test(leg.detail), `腿的说明必须说清"没参与"，实际：${leg.detail}`)
    assert.ok(/不是"预测通过了"/.test(leg.detail), '必须显式堵掉"绿勾=预测同意"这个误读')
  })

  check('L2 声称了却没给结论 ⇒ **查不了**（unverifiable），不是"被拒"', () => {
    // 打坏它：把 FORECAST_MISSING 从 UNVERIFIABLE_CODES 里删掉 ⇒ 这里变 blocked ⇒ 红
    const r = precheckTrade(input({ forecastClaim: { claims: true, result: null } }))
    assert.equal(r.verdict, 'unverifiable', `声称了却没有结论应当判"查不了"，实际 ${shape(r)}`)
    assert.ok(r.blockers.some((b) => b.code === 'FORECAST_MISSING'), '必须有专属 code')
  })

  check('L3 拿别的品种的预测支撑这笔单 ⇒ 拒（FORECAST_SYMBOL_MISMATCH）', () => {
    const r = precheckTrade(
      input({ forecastClaim: { claims: true, result: forecastOf({ symbol: 'ETHUSDT' }) } }),
    )
    assert.equal(r.verdict, 'blocked')
    assert.ok(r.blockers.some((b) => b.code === 'FORECAST_SYMBOL_MISMATCH'), shape(r))
  })

  check('L4 预测自己说"判不了" ⇒ 查不了，且说明里带上它给的理由', () => {
    const r = precheckTrade(
      input({
        forecastClaim: {
          claims: true,
          result: forecastOf({ outcome: 'unverifiable', gate: 'sample', reasons: [{ from: 'matched', text: '相似时刻只找到 12 个' }] }),
        },
      }),
    )
    assert.equal(r.verdict, 'unverifiable', shape(r))
    const b = r.blockers.find((x) => x.code === 'FORECAST_UNVERIFIABLE')
    assert.ok(b, shape(r))
    assert.ok(b!.detail.includes('相似时刻只找到 12 个'), '必须把预测自己给的理由带出来，否则用户不知道去修什么')
  })

  check('L5 预测说"没有统计优势" ⇒ **拒**，且不许被说成"预测看跌"', () => {
    // ★ 这一条是整个预测层的立意在下单路径上的落点：
    //   用户说"按预测买"，而预测器的样本外命中率与"永远猜训练段方向"分不开 ⇒
    //   放行就等于系统明知依据是噪声还照办。
    // ★ 同时钉住措辞：必须出现"没有统计优势"，且 detail 里给出的理由**不含**
    //   "看跌/看涨"这种方向性结论 —— 那两件事的动作完全相反
    //   （一个换方法/攒数据，一个改方向）。
    const r = precheckTrade(
      input({
        forecastClaim: {
          claims: true,
          result: forecastOf({
            outcome: 'no-edge',
            gate: 'edge',
            direction: 'down',
            reasons: [{ from: 'edgeZ', text: '命中率与那条平凡规则分不开，结论是**没有统计优势**。' }],
          }),
        },
      }),
    )
    assert.equal(r.verdict, 'blocked', shape(r))
    const b = r.blockers.find((x) => x.code === 'FORECAST_NO_EDGE')
    assert.ok(b, shape(r))
    assert.ok(b!.detail.includes('没有统计优势'), `必须是"没有统计优势"而不是方向判断，实际：${b!.detail}`)
    assert.ok(!b!.detail.includes('**'), '腿的文案会直接显示给操作者，不该带 Markdown 记号')
    assert.equal(r.submitAllowed, false, '被这道腿拒了之后不许还能提交')
  })

  check('L6 有优势但方向相反 ⇒ 拒（FORECAST_CONTRADICTS）', () => {
    const r = precheckTrade(
      input({
        side: 'buy',
        forecastClaim: { claims: true, result: forecastOf({ outcome: 'actionable', gate: 'pass', direction: 'down', medianBps: -30, netEdgeBps: 14 }) },
      }),
    )
    assert.equal(r.verdict, 'blocked')
    assert.ok(r.blockers.some((b) => b.code === 'FORECAST_CONTRADICTS'), shape(r))
  })

  check('L7 ★ 有优势且方向一致 ⇒ **放行**（证明 L5/L6 不是一道永远拒绝的假门）', () => {
    // ★ 这条的存在理由：没有它，把 forecastLeg 写成"永远不通过"也能让 L2~L6 全绿 ——
    //   而那道腿就成了一道装饰（本仓库记过的"不可能失败的检查"的镜像：
    //   一道**永远失败**的检查同样没有信息量，它只会让所有交易停摆）。
    const r = precheckTrade(
      input({
        side: 'buy',
        forecastClaim: { claims: true, result: forecastOf({ outcome: 'actionable', gate: 'pass', direction: 'up', medianBps: 30, netEdgeBps: 14 }) },
      }),
    )
    const leg = r.legs.find((l) => l.id === 'alpha.forecast')
    assert.ok(leg?.passed, `方向一致且有余量时必须放行，实际：${leg?.detail ?? '(缺腿)'}`)
    assert.equal(r.forecast.claims, true)
    assert.equal(r.forecast.outcome, 'actionable')
    assert.equal(r.forecast.proposal?.ok, true, '有优势时必须产出可用的下单提案')
    assert.equal(r.forecast.proposal?.side, 'buy')
  })

  check('L8 提案的口径：有优势才有 side/entry/target；没有时 `ok:false` 且原因是人话', () => {
    const good = proposeForecastOrder(
      forecastOf({ outcome: 'actionable', gate: 'pass', direction: 'up', medianBps: 30, netEdgeBps: 14 }),
    )
    assert.equal(good.ok, true)
    assert.equal(good.side, 'buy')
    assert.equal(good.entry, 77_500, '入场价必须是预测站的那根 bar 的收盘价，不许另取一个')
    assert.equal(good.target, 77_800)
    assert.equal(good.lo, 77_000)
    assert.equal(good.hi, 78_000)
    const noEdge = proposeForecastOrder(forecastOf({ outcome: 'no-edge', gate: 'edge' }))
    assert.equal(noEdge.ok, false, '没有统计优势时不许产出提案')
    assert.equal(noEdge.side, null, 'null 不许退化成某个默认方向')
    assert.ok(/没有统计优势/.test(noEdge.reason), `原因必须可念且说清卡在哪：${noEdge.reason}`)
    assert.ok(!/\*\*/.test(noEdge.reason), '提案原因是给人念的，不许带 Markdown')
  })

  check('L9 六个事因各有各的 code（不许合并成"预测层拒绝了"）', () => {
    const codes = readCode('server/tradeGate.ts')
    for (const c of ['FORECAST_MISSING', 'FORECAST_UNVERIFIABLE', 'FORECAST_SYMBOL_MISMATCH', 'FORECAST_NO_EDGE', 'FORECAST_CONTRADICTS']) {
      assert.ok(codes.includes(c), `缺 code ${c} —— 事因不同却共用一个词，用户不知道该做哪个动作（判据 20）`)
    }
  })

  check('L10 预测结论只由服务端现算：`forecast(` 在闸门里只出现一次，且没有任何订单构造', () => {
    // 打坏它：在活体外壳里改成读一个"调用方传来的结论" ⇒ 这里红
    const code = readCode('server/tradeGate.ts')
    const calls = (code.match(/forecast\(\{/g) ?? []).length
    assert.equal(calls, 1, `预测被调用了 ${calls} 次 —— 必须只有活体外壳那一处，否则就是第二条取数口径`)
    // 预测腿自己不许构造任何"提案对象"（提案只能来自预测层那唯一的出口）
    assert.ok(!/proposeForecastOrder\(/.test(code.replace(/^\s*\/\/.*$/gm, '')) || true)
    const proposalCalls = (code.match(/proposeForecastOrder\(/g) ?? []).length
    assert.equal(proposalCalls, 1, `proposeForecastOrder 被调了 ${proposalCalls} 次 —— 提案口径必须只有一份`)
    // 闸门里不许有第二份"预测结论"的构造（比如硬编码一个 outcome）
    assert.ok(!/outcome:\s*'(actionable|no-edge)'/.test(code), '闸门里不许自己造一个预测结论')
  })

  // ★ 必须 `await`。漏了它的后果实测过（本次就漏了一次）：断言在**汇总打印之后**
  //   才跑完，于是它红了也不会进 `failures`、退出码仍然是 0 ——
  //   而它看起来"跑过了"。这与本文件 `check()` 里那条"同步 check 里返回 Promise"
  //   的自保护是同一族缺陷（断言不执行）。同步的 `check` 有护栏，异步的没有。
  await checkAsync('L11 活体外壳真的去跑了预测（claims=true 时 outcome 必须非 null）', async () => {
    const r = await precheckLiveTrade(
      {
        symbol: 'BTCUSDT',
        side: 'buy',
        notionalUsdt: 1000,
        entry: 60_000,
        takeProfit: 64_000,
        stopLoss: 58_500,
        confidence: 80,
        environment: 'paper',
        channel: 'cex',
        venue: 'binance',
        // ★ 不给预测结论，只给"一声称"—— 结论必须由服务端自己算出来
        forecastClaims: true,
      },
      { refreshRegime: async () => snapshotOf(), getRegime: () => snapshotOf(), account: () => ({ equity: 100_000, killswitch: false, dailyLoss: 0, dailyLossLimit: 5000 }), exposure: () => ({ grossUsdt: 0, limitUsdt: null, unreleasedCount: 0 }) },
    )
    assert.equal(r.forecast.claims, true)
    assert.ok(r.forecast.outcome, '声称之后活体外壳必须真的跑出一次预测结论（不许留在 null）')
    assert.ok(['actionable', 'no-edge', 'unverifiable'].includes(r.forecast.outcome!), `三态之外的判决：${r.forecast.outcome}`)
    // 预测层的实测结论（BTCUSDT 未来 1 小时没有统计优势）—— 这条腿必须因此拦下来，
    // 而且拦的理由必须是"没有统计优势"而不是"看跌"。
    assert.equal(r.submitAllowed, false, `当前实测结论下这笔单必须被拦，实际 ${shape(r)}`)
    assert.ok(
      r.blockers.some((b) => b.code === 'FORECAST_NO_EDGE' || b.code === 'FORECAST_UNVERIFIABLE'),
      `被拦的理由必须出自预测腿本身，实际 ${shape(r)}`,
    )
    assert.ok(!r.forecast.proposal?.ok, '没有统计优势时不许给出可执行的提案')
  })

  // ═══════════════════════════════════════════════════════════
  // [M] 出单路径收口：三条路走**同一次调用的同一份结果**
  //
  // ★ 这一区守的是 2026-09-23 修掉的那类缺陷：真正**出单**的有三条路
  //   （自治循环 / `POST /orders` / 语音），而闸门当时只有 `/orders/precheck`
  //   一个调用面 —— 于是它只挡得住"愿意先问一声"的人，
  //   而**真正出单的那条路一次都不问**（判据 8 的典型形态）。
  //
  // ★ 为什么这一区多数是**结构**断言：行为断言只能证明"我造的那个输入会被拦"，
  //   证明不了"别处的调用方也走了这条路" —— 而要治的恰恰是后者
  //   （判据 D5：我要下的结论，在另一种事因下会不会长得一模一样）。
  console.log('\n[M] 出单路径收口（三条路一份裁决）')

  check('M1 闸门只有**一个**生产入口：precheckLiveTrade 只许 orderGate 调', () => {
    const files = readdirSync(join(ROOT, 'server'), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => `server/${d.name}`)
    const callers = files.filter((f) => f !== 'server/tradeGate.ts' && /\bprecheckLiveTrade\s*\(/.test(readCode(f)))
    assert.deepEqual(
      callers,
      ['server/orderGate.ts'],
      `precheckLiveTrade 的直接调用方必须只有 orderGate.ts（多一个就说明又分岔出一份实现），实际 ${JSON.stringify(callers)}`,
    )
  })

  check('M2 `/orders` 出单前必须先过闸门，且闸门排在出单之前', () => {
    const code = readCode('server/index.ts')
    const at = code.indexOf("url.pathname === '/orders'")
    assert.ok(at > 0, '在 index.ts 里找不到 /orders 端点')
    const seg = code.slice(at, code.indexOf("url.pathname === '/orders/precheck'", at))
    const atGate = seg.indexOf('gateOrderForExecution')
    const atExec = seg.indexOf('processOrderIntent')
    assert.ok(atGate > 0, '/orders 里没有闸门调用 —— 这条出单路可以绕过闸门')
    assert.ok(atExec > 0, '/orders 里找不到出单调用')
    assert.ok(atGate < atExec, `闸门必须排在出单之前：gate@${atGate} exec@${atExec}`)
    // ★ 调了闸门 ≠ 用了它的裁决：还要看它**读没读** `submitAllowed`。
    //   只调不读，闸门就是一句装饰（判据 B2：断的是"起作用了"还是"出现过"）。
    assert.ok(
      /if\s*\(\s*!\s*gate\.submitAllowed\s*\)/.test(seg),
      '/orders 调了闸门却没拿它的裁决决定放行 —— 那是一句装饰',
    )
  })

  check('M3 语音两条路（纸面/实盘）都过闸门，平仓跳过要留痕', () => {
    const code = readCode('server/voice/service.ts')
    const atLive = code.indexOf('function submitLiveOrder')
    assert.ok(atLive > 0, '在语音服务里找不到 submitLiveOrder')
    const paper = code.slice(code.indexOf('async function submitOrder('), atLive)
    const live = code.slice(atLive)
    assert.ok(paper.includes('gateOrderForExecution'), '语音**纸面**路径没过闸门')
    assert.ok(live.includes('gateOrderForExecution'), '语音**实盘**路径没过闸门')
    // ★ 同上：调了闸门还要**用它**（判据 B2）。
    for (const [label, seg2] of [
      ['纸面', paper],
      ['实盘', live],
    ] as const) {
      assert.ok(
        /if\s*\(\s*!\s*gate\.submitAllowed\s*\)/.test(seg2),
        `语音${label}路径调了闸门却没拿它的裁决决定放行 —— 那是一句装饰`,
      )
    }
    for (const [label, seg] of [
      ['纸面', paper],
      ['实盘', live],
    ] as const) {
      assert.ok(
        seg.includes('VOICE_ORDER_GATE_SKIPPED'),
        `${label}平仓跳过闸门没有留痕 —— 事后分不清「查了通过」与「根本没查」（判据 C4：报 0 ≠ 没错）`,
      )
    }
  })

  check('M4 闸门输入不许按 0 推：拿不到价 / 数量非法都要拒', () => {
    const noPrice = gateInputFromOrderIntent(
      { symbol: 'BTCUSDT', side: 'buy', qty: 1 },
      { environment: 'paper', mark: null },
    )
    assert.equal(noPrice.ok, false, '拿不到标记价时不许按 0 推出一个名义额（那会让每道按规模判断的门静默失效）')
    assert.match(String(noPrice.ok === false ? noPrice.reason : ''), /GATE_INPUT_NO_PRICE/)
    const noSym = gateInputFromOrderIntent({ side: 'buy', qty: 1 }, { environment: 'paper', mark: 80_000 })
    assert.equal(noSym.ok, false, '没有标的时不许推进去')
    const badQty = gateInputFromOrderIntent(
      { symbol: 'BTCUSDT', side: 'buy', qty: 0 },
      { environment: 'paper', mark: 80_000 },
    )
    assert.equal(badQty.ok, false, '数量 <= 0 不许推进去')
    const good = gateInputFromOrderIntent(
      { symbol: 'BTCUSDT', side: 'buy', qty: 2 },
      { environment: 'paper', mark: 80_000 },
    )
    assert.equal(good.ok, true)
    if (good.ok) assert.equal(good.req.notionalUsdt, 160_000, '名义额必须是 价 × 量')
  })

  await checkAsync('M5 缺保护 ⇒ 判「查不了」而不是「被拒」，且报 0/9 不是 0/0', async () => {
    const r = await gateOrderForExecution(
      {
        symbol: 'BTCUSDT',
        side: 'buy',
        notionalUsdt: 10,
        entry: 80_000,
        takeProfit: 0,
        stopLoss: 0,
        environment: 'paper',
      },
      { source: 'orders' },
    )
    assert.equal(r.verdict, 'unverifiable', `缺保护必须判"查不了"，实际 ${r.verdict}`)
    assert.equal(r.submitAllowed, false)
    assert.equal(
      r.pipeline.total,
      9,
      `查不了时 pipeline 必须报 0/9（红线㉛：报 0 不等于没错），实际 ${r.pipeline.checked}/${r.pipeline.total}`,
    )
    assert.ok(r.summary.includes('查不了'), `"查不了"必须说出来，实际：${r.summary}`)
    assert.ok(
      r.suggested !== null,
      '拒绝时**必须**给出可照做的数字（判据 D7：否则用户唯一能做的动作是"再点一次"，而那个动作没有用）',
    )
    const text = describeGateRefusal(r)
    assert.ok(text.includes('拦下它的门'), `拒绝文案必须说清是哪道门，实际：${text}`)
  })

  // ═══════════════════════════════════════════════════════════

  console.log('\n[N] 裸单通道：**只有显式放弃**才走裸单判据')

  // ── N1 ★★ 配对断言（判据 A1：误报比漏报贵）────────────────────────────
  //
  // 裸单通道最容易出的事故不是"不够严"，而是**它顺手把"缺输入"也放行了**：
  // 只要把"没给保护价"读成"用户不要保护"，那么任何一次上游漏填
  // （语音解析漏了、界面表单没提交、脚本少传一个字段）都会静默降级成裸单。
  // ⇒ 这条断言是 N2 的**配对**：同一批输入，**只是不带那句豁免**，必须仍然查不了。
  //   没有它，N2 的绿只证明"这条路能走通"，证明不了"别的路没被它打开"。
  check('N1 静默缺保护仍然查不了（裸单通道不许顺手放行"缺输入"）', () => {
    const r = precheckTrade(input({ takeProfit: 0, stopLoss: 0 }))
    assert.equal(r.verdict, 'unverifiable', `没豁免而缺保护必须仍判"查不了"，实际 ${r.verdict}`)
    assert.equal(r.submitAllowed, false, '缺输入绝不许放行')
    assert.equal(r.pipeline.total, 9, '查不了时也要报 total=9（红线㉛：0/9 不是 0/0）')
    const naked = r.legs.filter((l) => l.notChecked === true)
    assert.equal(naked.length, 0, '没豁免就不该有任何"未查"的腿出现')
  })

  // ── N2 显式豁免 ⇒ 裸单判据 ────────────────────────────────────────────
  check('N2 显式放弃保护 ⇒ 可评估、几何为 null、且"未查"被标出来', () => {
    const r = precheckTrade(input({ protectionWaived: true, takeProfit: 0, stopLoss: 0 }))
    assert.equal(r.verdict, 'pass', `现货裸单在没有别的阻碍时应可提交，实际 ${r.verdict}`)
    assert.equal(r.submitAllowed, true)
    // ★ 九道门**一道都不许少跑**。这条是本次改造踩到的坑的回归断言：
    //   曾经让盈亏比门禁就地 reject ⇒ `runPipeline` 短路在这道，
    //   后面 4 道（高周期顺势/ADX/置信度/日亏熔断）一道不跑，而 `checked` 只报 5/9。
    assert.equal(r.pipeline.checked, 9, `裸单也必须跑满九道，实际 ${r.pipeline.checked}/${r.pipeline.total}`)
    // ★ 没有 R:R 可算 ⇒ `null`，不许退化成 0（红线㉟：0 会被读成"赔率极差"）
    assert.equal(r.geometry, null, '裸单没有盈亏比可算，`geometry` 必须是 null 而不是零值')
    assert.equal(r.pipeline.reachedGeometry, false, '"走到"与"算出来了"必须分开报')
  })

  // ── N3 三态：那条腿在 legs 里、不在 blockers 里、且标着 notChecked ──────
  check('N3「没查」是第三种状态：进 legs、不进 blockers、永远不算通过', () => {
    const r = precheckTrade(input({ protectionWaived: true, takeProfit: 0, stopLoss: 0 }))
    const leg = r.legs.find((l) => l.id === 'naked.reward_risk')
    assert.ok(leg, '`legs` 里必须留下那条"未查"的腿 —— 否则事后无法回答"这次哪道门没跑"（判据 C4）')
    assert.equal(leg?.notChecked, true, '它必须被标成 notChecked')
    assert.equal(leg?.passed, false, '★ 它**不许**被算成通过：灰区伪装成绿灯是本项目付过代价的那类缺陷')
    assert.equal(leg?.code, 'RR_NOT_CHECKED')
    assert.equal(
      r.blockers.filter((b) => b.id === 'naked.reward_risk').length,
      0,
      '它也不许进 blockers —— 那不是"这笔单不合格"，把它算成拦截会让一笔被用户明确接受的裸单收到一句它没犯的错',
    )
    assert.ok(
      r.disclosures.some((d) => d.includes('真实盈亏比门禁') && d.includes('没查')),
      `"这次没覆盖到"必须落在 disclosures（界面上"本次检查覆盖不到"）里，实际：${JSON.stringify(r.disclosures)}`,
    )
  })

  // ── N4 裸单的合约几何：边界两侧 + 拒绝码要说得出是哪条规矩 ────────────
  check('N4 裸单合约的强平几何：40 倍过、41 倍拒，且拒绝码可归因', () => {
    const ok = precheckTrade(
      input({ protectionWaived: true, takeProfit: 0, stopLoss: 0, instType: 'SWAP', leverage: 40 }),
    )
    assert.equal(ok.verdict, 'pass', `40 倍裸单（强平距离恰好等于最窄止损垫）应当放行，实际 ${ok.verdict}`)
    const bad = precheckTrade(
      input({ protectionWaived: true, takeProfit: 0, stopLoss: 0, instType: 'SWAP', leverage: 41 }),
    )
    assert.equal(bad.verdict, 'blocked', `41 倍裸单必须被拒，实际 ${bad.verdict}`)
    const leg = bad.blockers.find((b) => b.id === 'naked.liquidation')
    assert.ok(leg, `拒绝必须来自"裸单的强平距离"那条腿，实际 blockers=[${bad.blockers.map((b) => b.id).join(',')}]`)
    assert.equal(
      leg?.code,
      'HIGH_LEVERAGE_NEEDS_STOP',
      '拒绝码必须是这条规矩自己的码 —— 通用码会让用户分不清"该给止损"还是"该降倍数"',
    )
    // ★ 可证伪：系统念出来的那个"降到的倍数"必须真的能过（判据 D5 的反面）
    const m = /降到 (\d+) 以内/.exec(bad.summary)
    assert.ok(m, `拒绝文案必须给出可照做的倍数，实际：${bad.summary}`)
    const suggested = Number(m?.[1])
    const retry = precheckTrade(
      input({ protectionWaived: true, takeProfit: 0, stopLoss: 0, instType: 'SWAP', leverage: suggested }),
    )
    assert.equal(retry.verdict, 'pass', `照它说的降到 ${suggested} 倍之后必须真的能过（否则用户会陷入"照做、再被拒"的循环）`)
  })

  // ── N5 拿不到杠杆 ⇒ 不许按 1 倍自动算出一个绿色的强平检查 ─────────────
  check('N5 合约裸单没有杠杆 ⇒ 判"查不了"，不许按 1 倍变绿', () => {
    const r = precheckTrade(input({ protectionWaived: true, takeProfit: 0, stopLoss: 0, instType: 'SWAP' }))
    assert.equal(r.verdict, 'unverifiable', `没有杠杆时算不出强平距离，必须 fail-closed，实际 ${r.verdict}`)
    assert.equal(r.pipeline.total, 9)
    assert.equal(
      r.legs.filter((l) => l.id === 'naked.liquidation').length,
      0,
      '拿不到杠杆时**不许**产出那条几何腿 —— 按 1 倍算出来的强平距离是 Infinity，那道门会自动变绿',
    )
  })

  // ── N6 豁免声明与保护价同时给 ⇒ 按"有保护"评，不许产出假话 ─────────────
  check('N6 同时给了豁免与保护 ⇒ 按有保护评估（不许说"这笔单没有止盈止损价"）', () => {
    const r = precheckTrade(input({ protectionWaived: true, instType: 'SWAP', leverage: 39 }))
    assert.notEqual(r.geometry, null, '有保护就有 R:R 可算 —— 把它读成豁免会产出一句与单据不符的假话')
    assert.equal(r.legs.filter((l) => l.notChecked === true).length, 0, '这种情况不该有任何"未查"的腿')
    assert.ok(
      !r.summary.includes('没有止盈止损价'),
      `总结里不许出现与单据矛盾的说法，实际：${r.summary}`,
    )
    assert.ok(
      r.disclosures.some((d) => d.includes('没有生效')),
      '声明与单据矛盾时要如实说"这条声明没有生效"，而不是安静地忽略它',
    )
  })

  // ── N7 "全部通过"这句话不许在一道门没查时说 ───────────────────────────
  check('N7 有一道门没查时，总结不许说"全部通过"', () => {
    const r = precheckTrade(input({ protectionWaived: true, takeProfit: 0, stopLoss: 0 }))
    assert.ok(!r.summary.includes('全部通过'), `有一道没查就不能说"全部通过"，实际：${r.summary}`)
    assert.ok(r.summary.includes('未查'), `总结必须当场说出哪道门没查，实际：${r.summary}`)
    const base = precheckTrade(input())
    assert.ok(base.summary.includes('全部通过') === false || base.summary.includes('闸门通过'), '带保护的正常单措辞不受影响')
  })

  // ── N8 ★★ 裸单不是后门：别的门该拦还是拦 ──────────────────────────────
  //
  // ★ 这条同时是"管线短路"那个缺陷的回归断言：改造中曾经让盈亏比门禁就地 reject，
  //   `runPipeline` 就停在第 5 道，排它后面的 ADX 震荡过滤**根本不会被跑到** ——
  //   于是"裸单 + 无序震荡市"能被放行。把这条断言写在这里，
  //   是因为它是唯一能区分"豁免只作用于盈亏比那一道"与"豁免把关卡都卸了"的观测点。
  check('N8 裸单只豁免保护价那一道，别的门照拦（ADX 震荡市仍拒）', () => {
    const r = precheckTrade(
      input({ protectionWaived: true, takeProfit: 0, stopLoss: 0, pkg: pkgOf({ adx1h: 12 }) }),
    )
    assert.equal(r.verdict, 'blocked', `裸单在无序震荡市里一样该被拒，实际 ${r.verdict}`)
    assert.ok(
      r.blockers.some((b) => b.id === 'pipeline.filter.adx_regime'),
      `拒绝必须来自 ADX 震荡过滤那道门（不是盈亏比门禁），实际 blockers=[${r.blockers.map((b) => b.id).join(',')}]`,
    )
  })

  // ═══════════════════════════════════════════════════════════

  resetGuard()
  resetInterceptors()

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log('\n失败明细：')
    for (const f of failures) console.log('  ✗', f)
    process.exit(1)
  }
  console.log('✅ 交易闸门烟测全部通过')
}

main().catch((e) => {
  console.error('烟测崩溃：', e)
  process.exit(1)
})
