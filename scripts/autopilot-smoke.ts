import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
process.env.AUTOPILOT_PRESEED = 'false'
process.env.AUTOPILOT_LIVE = 'false'
// 与运行时的 `.env` **解耦**：正式配置里可能残留调试用的 pin，
// 那会让本测试跑的其实是「那条 pin」而不是「自动挖掘」——
// 测试看起来在验证策略选择，实际上一个候选都没评估过。
// 依赖注入优于依赖环境：测试要自己声明它需要什么前提。
delete process.env.AUTOPILOT_PINNED_STRATEGY
import { getOrchState, resetOrch, seedPrice, onMarketBar, onPriceTick } from '../server/core.ts'
import { configureAutopilot, startAutopilot, stopAutopilot, autopilotStatus, onAutopilotBar, configureOverfitGate } from '../server/autopilot.ts'
import { configureRegimeSource } from '../server/marketRegime.ts'
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
  console.error(`[FAIL] AUTOPILOT SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'autopilot-latest.json'), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2))
}

function bar(t: number, o: number, c: number) {
  return { t, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 10_000 }
}

/**
 * 注入确定性的高周期（1H/4H）结构。
 *
 * ## 为什么必须注入
 *
 * 本测试喂给 autopilot 的是合成 K 线（$100 起步），
 * 而 `marketRegime` 默认向**真实 Binance** 拉 1H/4H 数据。两者价格量级差三个数量级；
 * 更关键的是，真实行情当天是什么形态是随机的 —— 实测那次 BTC 的 1H ADX 恰好是 13.3
 * （震荡市），震荡过滤器于是拦下了合成数据里的**每一次**开仓，
 * 而这个门禁的通过与否就变成了「今天 BTC 怎么走」，与代码质量毫无关系。
 *
 * **结果由外部行情决定的门禁不是门禁，是一个不可复现的随机数。**
 *
 * ## 注入什么样的结构
 *
 * 一条可控的单边上行曲线，终点锚定在 `regimeAnchor`：
 *   - 4H 上行 → macroTrend = BULL，趋势过滤放行做多
 *   - 1H 上行 → ADX 走高（> 18），震荡过滤放行
 *   - anchor 取**略低于当前喂价** → 当前价处于「已突破 24h 高点」状态，
 *     `deriveStructureTarget` 走等距测幅分支，得到一个与量级相符的止盈目标
 *     （否则会拿真实 BTC 的 6 万级结构位去比合成数据的 100 级价格，
 *      算出 `R:R = 16113` 这种把盈亏比门禁变成摆设的失真值）
 */
let regimeAnchor = 160

function installRegimeSource(): void {
  configureRegimeSource(async (_symbol: string, interval: string, limit: number) => {
    const n = interval === '1h' ? Math.max(limit, 120) : Math.max(limit, 80)
    const stepPct = interval === '1h' ? 0.004 : 0.012
    const close: number[] = []
    let p = regimeAnchor / Math.pow(1 + stepPct, n - 1)
    for (let i = 0; i < n; i++) {
      close.push(p)
      p *= 1 + stepPct
    }
    return { high: close.map((c) => c * 1.0015), low: close.map((c) => c * 0.9985), close }
  })
}

/**
 * 过拟合门（F-47）的**接线探针**。
 *
 * ## 为什么要注入而不是直接用默认门
 * 默认门要跑 20 候选 × 多折 walk-forward，至少需要 `trainBars + testBars + 1 = 1201` 根 K 线；
 * 本测试只喂 130 根，默认门必然返回 `UNVERIFIABLE` —— 于是 S2~S4 那一串生命周期断言
 * （选策略 → 建仓 → 止盈 → 回撤保护）会全部因为「压根没进 trading」而跑不起来。
 *
 * ## 为什么注入的不是「一个返回 true 的假门」
 * 那正是 F-41（自报布尔量）的形状。所以这个门**必须留下调用记录**：
 * S2 之后立刻断言它被调过、以及调用时的 K 线根数。
 * 少了这条断言，「门接在选择了」就只是代码里的一句自述。
 * 真实的默认门另有 S7 专门验证（恢复默认 → 必须拒绝）。
 */
const gateCalls: { bars: number; at: number }[] = []

function installPassingGateProbe(): void {
  configureOverfitGate((cs) => {
    gateCalls.push({ bars: cs.length, at: Date.now() })
    return { outcome: 'PASS', pass: true, summary: 'smoke 注入探针：放行', bars: cs.length, folds: 8, pbo: 0.1, elapsedMs: 0 }
  })
}

async function main() {
  // 隔离：不触碰持久层（smoke 进程未调 initPersistence，persist 全部跳过）
  resetOrch(100_000)
  seedPrice('BTCUSDT', 100)
  configureAutopilot({ getState: getOrchState })
  // 高周期结构换成确定性注入，摆脱对真实行情的依赖（见 installRegimeSource 注释）
  installRegimeSource()
  // 过拟合门换成记录型放行探针（见 installPassingGateProbe 注释）
  installPassingGateProbe()

  const r0 = await startAutopilot(999)
  if (r0.ok) fail('S1 target validation', 'target=999 should be rejected')
  pass('S1 target validation', 'target 越界被拒（0 < t <= 50）')

  getOrchState().risk.maxNotionalPerOrder = 5_000_000

  const r1 = await startAutopilot(2)
  if (!r1.ok) fail('S1 start', JSON.stringify(r1))
  const dup = await startAutopilot(1)
  if (dup.ok) fail('S1 start', '重复启动未被拒')
  pass('S1 启动与防重入', 'target=2% · baseline=$100000')

  // 累积阶段：喂 130 根上行 K 线（触发 optimize → trading）
  let ts = Date.now() - 130 * 60_000
  for (let i = 0; i < 130; i++) {
    const px = 100 + i * 0.5
    onMarketBar('BTCUSDT', bar(ts, px - 0.3, px))
    await onAutopilotBar(bar(ts, px - 0.3, px))
    ts += 60_000
  }
  await new Promise((r) => setTimeout(r, 300))
  const st1 = autopilotStatus()
  if (!getEvents(0).some((e) => e.kind === 'AUTOPILOT_STRATEGY_SELECTED')) fail(`S2 stage machine`, `winner=${st1.winner}`)
  if (!st1.winner) fail('S2 stage machine', 'winner 未选出')
  pass(`S2 挖掘→门禁→执行`, `胜出=${st1.winner?.slice(0, 40)}…`)

  // S2b：门**确实挂在选择路径上**（F-47 的接线证明，不是「代码看起来接上了」）。
  // 断言的是一条从外部可观测的事实：门被调用过，且拿到的是喂给选择的那批 K 线。
  if (gateCalls.length === 0) {
    fail('S2b overfit gate wired', '过拟合门从未被调用 —— 样本内选择仍然无门（F-47 未接线）')
  }
  // 第一次触发选取的时机是累积到 MIN_BARS=120 的那一根。
  if (gateCalls[0].bars < 120) {
    fail('S2b overfit gate wired', `门收到的 K 线只有 ${gateCalls[0].bars} 根，少于 MIN_BARS=120 —— 门与选择用的可能不是同一批数据`)
  }
  const gateEvents = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_OVERFIT_GATE')
  if (gateEvents.length === 0) fail('S2b overfit gate wired', '门跑了但没落审计事件 —— 事后无法核对当时的判据')
  const ge0 = gateEvents[0].payload as { pass?: boolean; bars?: number; candidates?: number }
  if (ge0.pass !== true) fail('S2b overfit gate wired', `探针放行却记成 pass=${ge0.pass}`)
  if ((ge0.candidates ?? 0) < 8) fail('S2b overfit gate wired', `候选场只有 ${ge0.candidates} 个 —— 少于门要求的 8 个，PBO 无意义`)
  pass('S2b 过拟合门已接线', `门被调用 ${gateCalls.length} 次 · 首调 ${gateCalls[0].bars} 根 · 候选 ${ge0.candidates} 个 · 事件已落账`)

  // 行情继续上行 → 持仓浮盈 → 达标止盈
  let ts2 = ts
  for (let i = 0; i < 20 && autopilotStatus().stage === 'trading'; i++) {
    ts2 += 60_000
    const px = 165 + i * 2
    onMarketBar('BTCUSDT', bar(ts2, px - 0.5, px))
    await onAutopilotBar(bar(ts2, px - 0.5, px))
    onPriceTick('BTCUSDT', px)
    await new Promise((r) => setTimeout(r, 5))
  }
  const st2 = autopilotStatus()
  if (st2.stage !== 'target_reached') fail('S3 target reached', `stage=${st2.stage} pnl=${st2.pnlPct}%`)
  if ((st2.pnlPct ?? 0) < 2) fail('S3 target reached', `pnlPct=${st2.pnlPct}%`)
  pass('S3 盈利目标达成自动止盈', `pnl=+${st2.pnlPct}% ≥ target +${st2.targetPct}%`)

  // 回撤保护：先建多仓（缓涨段进入 trading 并成交），再砸盘触发权益回撤
  stopAutopilot('smoke reset')
  await startAutopilot(50)
  // 这一段的价格在 200~260 一线，结构锚点要与之同量级，
  // 否则会拿上一段的 165 级结构去比这一段的价格
  regimeAnchor = 240
  installRegimeSource()
  // 缓涨段必须**接续上一段的终点价**：S3 收在 203 一线，
  // 若这里从 90 重新开始，喂价会瞬间腰斩，权益回撤保护会在建仓之前就触发
  // （表现为 `未能进入 trading: drawdown_stopped` —— 看起来像策略问题，
  //   其实是夹具把价格撕裂了）。
  let ts3 = ts2 + 60_000
  let lastPx = 200
  for (let i = 0; i < 130 && autopilotStatus().stage !== 'trading'; i++) {
    ts3 += 60_000
    lastPx = 200 + i * 0.5
    onMarketBar('BTCUSDT', bar(ts3, lastPx - 0.5, lastPx))
    await onAutopilotBar(bar(ts3, lastPx - 0.5, lastPx))
    onPriceTick('BTCUSDT', lastPx)
  }
  if (autopilotStatus().stage !== 'trading') fail('S4 setup', `未能进入 trading: ${autopilotStatus().stage}`)

  // ⚠️ 切到 trading 的那一根只负责**选策略**，不交易（tradeBar 从下一根才开始跑）。
  // 所以必须再给一段上涨，让策略有机会产生突破买入信号 ——
  // 否则紧接着的砸盘会让 breakout 永远等不到创新高，
  // S4 就退化成「一个从不建仓的回撤保护测试」：它永远不会失败，也就永远没有价值。
  for (let i = 0; i < 30 && autopilotStatus().running; i++) {
    ts3 += 60_000
    lastPx += 0.6
    onMarketBar('BTCUSDT', bar(ts3, lastPx - 0.6, lastPx))
    await onAutopilotBar(bar(ts3, lastPx - 0.6, lastPx))
    onPriceTick('BTCUSDT', lastPx)
    await new Promise((r) => setTimeout(r, 5))
  }

  // 闪崩：**单根 K 线内**把价格打到脚踝。
  //
  // 为什么不逐根慢慢跌：回撤保护判定盯市权益，但它与移动止损在**同一根** K 线里，
  // 且回撤检查先执行。价格若一点一点往下走，移动止损会在半路（约 -1%）把仓位平掉，
  // 权益就永远碰不到 -10% —— 这是分层风控的健康表现（止损先于全局保护生效），
  // 但也就验证不到回撤保护这一层。真实的闪崩同样是在一根之内完成的，
  // 所以用单根暴跌来打这一层，既符合现实、也才测得到。
  let crashPx = lastPx
  for (let i = 0; i < 12 && autopilotStatus().running; i++) {
    ts3 += 60_000
    const prev = crashPx
    crashPx *= 0.35
    onMarketBar('BTCUSDT', bar(ts3, prev, crashPx))
    await onAutopilotBar(bar(ts3, prev, crashPx))
    onPriceTick('BTCUSDT', crashPx)
    await new Promise((r) => setTimeout(r, 5))
  }
  const st3 = autopilotStatus()
  if (st3.stage !== 'drawdown_stopped') fail('S4 drawdown protection', `stage=${st3.stage} pnl=${st3.pnlPct}%`)
  pass('S4 回撤保护', `pnl=${st3.pnlPct}% ≤ -10% 自动平仓停机`)

  // 审计事件存在性
  const kinds = ['AUTOPILOT_STARTED', 'AUTOPILOT_STRATEGY_SELECTED', 'AUTOPILOT_TARGET_REACHED', 'AUTOPILOT_FLATTEN', 'AUTOPILOT_DRAWDOWN_STOP']
  for (const k of kinds) {
    if (!getEvents(0).some((e) => e.kind === k)) fail('S5 audit trail', `缺少 ${k} 事件`)
  }
  pass('S5 审计留痕', `${kinds.length} 类生命周期事件全部落账本`)

  // S6：独立复核确实接在**开仓路径**上（不是一段没人调用的函数）。
  // 这条断言存在的理由：复核器本身单测通过，与"它真的在开仓前被执行"是两件事。
  // 历史教训是「新加的风控只挂了 paper 或只挂了 live 一条通路」——
  // 所以必须从账本事件反证它被执行过，而不是相信代码看起来接上了。
  const verifierEvents = getEvents(0).filter((e) => e.kind === 'VERIFIER_VERDICT')
  if (verifierEvents.length === 0) fail('S6 maker-checker', '开仓路径上没有任何复核证据（复核器可能未接线）')
  const agreed = verifierEvents.filter((e) => (e.payload as { ok?: boolean }).ok === true).length
  if (agreed === 0) fail('S6 maker-checker', '复核从未放行任何一笔（接线方式可疑）')
  pass('S6 maker-checker', `${verifierEvents.length} 次复核落账，其中 ${agreed} 次放行`)

  // ══ S7：恢复**默认门**，验证它真的会拒绝（F-47） ═════════════════════════
  //
  // 为什么必须有这一条：S2~S6 跑的是注入的放行探针。若只有探针，
  // 「门整个坏掉、什么都放行」在整套测试里**永远不会变红** ——
  // 那正是本项目已复现 6 次的那类 P0（不可能失败的检查）。
  //
  // 这里把门恢复成默认实现（真实 walk-forward + CSCV-PBO）再跑一次选择。
  // 默认门至少要 trainBars+testBars+1 = 1201 根才切得出第一折，而此刻只有约 320 根，
  // 因此它**必须**判 UNVERIFIABLE 且不许选出冠军。
  // 断言的是「失败」本身：门在证据不足时放行，才是真缺陷。
  // 盘面切到 trading，说明失败。
  configureOverfitGate(null)
  stopAutopilot('smoke: 进入默认门验证')
  const r7 = await startAutopilot(2)
  if (!r7.ok) fail('S7 default gate refuses', `重启失败：${JSON.stringify(r7)}`)

  const selectedBefore = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_STRATEGY_SELECTED').length
  const gateBefore = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_OVERFIT_GATE').length

  // 只喂一根：累积量早已越过 MIN_BARS，随即触发一次「选择 + 门判定」
  ts3 += 60_000
  lastPx += 0.6
  onMarketBar('BTCUSDT', bar(ts3, lastPx - 0.6, lastPx))
  await onAutopilotBar(bar(ts3, lastPx - 0.6, lastPx))
  await new Promise((r) => setTimeout(r, 100))

  const st7 = autopilotStatus()
  const gateAfterFirst = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_OVERFIT_GATE').length
  if (gateAfterFirst <= gateBefore) {
    fail('S7 default gate refuses', `默认门在这根 K 线上根本没跑（事件数 ${gateBefore}→${gateAfterFirst}）`)
  }
  const refused = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_OPTIMIZE_REFUSED')
  if (refused.length === 0) {
    fail('S7 default gate refuses', `默认门在 ${st7.barsAccumulated} 根 K 线上未拒绝 —— 证据不足却放行，正是 F-47 要根治的行为`)
  }
  const rp = refused[refused.length - 1].payload as { outcome?: string; bars?: number; retryAtBars?: number }
  if (rp.outcome !== 'UNVERIFIABLE') {
    fail('S7 default gate refuses', `期望 UNVERIFIABLE（样本不足以切折），实得 ${rp.outcome}`)
  }
  if (st7.stage !== 'accumulating') {
    fail('S7 default gate refuses', `被拒后 stage=${st7.stage} —— 应留在 accumulating 继续累积，而不是进交易或停机`)
  }
  if (!st7.running) fail('S7 default gate refuses', '被拒后停机了 —— 「证据还不够」被误判成了「永不可行」')
  if (!st7.gateRefusal) fail('S7 default gate refuses', '拒绝没写进状态出口 —— 静默拒绝等于没有拒绝')
  if (st7.gateRefusal?.outcome !== 'UNVERIFIABLE') {
    fail('S7 default gate refuses', `状态里的 outcome=${st7.gateRefusal?.outcome} 与事件不一致`)
  }
  const selectedAfter = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_STRATEGY_SELECTED').length
  if (selectedAfter !== selectedBefore) fail('S7 default gate refuses', '门拒绝了却仍然选出了冠军')

  // 冷却：再喂一根，门不得重跑。一次门是秒级同步计算，每根 K 线跑一次会拖垮行情管线。
  ts3 += 60_000
  lastPx += 0.6
  onMarketBar('BTCUSDT', bar(ts3, lastPx - 0.6, lastPx))
  await onAutopilotBar(bar(ts3, lastPx - 0.6, lastPx))
  await new Promise((r) => setTimeout(r, 50))
  const gateAfterSecond = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_OVERFIT_GATE').length
  if (gateAfterSecond !== gateAfterFirst) {
    fail('S7 default gate refuses', '冷却期内门被重跑 —— 每根 K 线一次秒级 walk-forward 会拖垮行情管线')
  }
  pass(
    'S7 默认门拒绝样本不足',
    `门在 ${rp.bars} 根上判 ${rp.outcome} · 拒选冠军 · 仍在 accumulating 累积至 ${rp.retryAtBars} 根 · 冷却生效`,
  )

  archive()
  console.log('')
  console.log('[ARCHIVED] artifacts/autopilot-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('AUTOPILOT SMOKE PASSED')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
    process.exit(1)
  })
