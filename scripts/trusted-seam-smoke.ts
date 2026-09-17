/**
 * 双通道可信接缝烟测（内化能力回归门禁）
 *
 * 覆盖六个模块的**语义不变量**，全部离线、不依赖网络与交易所：
 *   ① 成本闸门（costModel）—— 成本是闸门不是报表；假设缺失即拒绝；固定成本摊薄方向
 *   ② 对手方信任（counterpartyRegistry）—— 三档信任；记录相互独立；声誉不能自封
 *   ③ 跨通道结算（settlementLedger）—— 同名不同域不合并；终态不可复活；幂等
 *   ④ 人类在环审批（approvalGate）—— 代码不能自我批准；一次性消费；过期不补批
 *   ⑤ 声称核验（claimValidator）—— 三态而非两态；跨周期不可比；冲突不可配置放宽
 *   ⑥ 上下文预算（contextBudget）—— 强制块永不丢；裁剪必须可见；输出确定性
 *   ⑦ 接线（proposalEngine）—— 两个强制提示词块真的进了提示词
 *
 * 为什么这些断言值得进 CI：它们守的是**静默失效**型缺陷 ——
 * 两个模块共用一个可变对象、终态被改写、UNVERIFIED 被当成 VERIFIED、
 * 强制约束被挤出窗口。这类问题都不抛异常，只会让系统在「看起来正常」的状态下
 * 慢慢丢掉可信度，靠人工 review 抓不住。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EXEC, genSynthCandles } from '../src/engine/index.ts'
import type { Candle } from '../src/engine/index.ts'
import {
  assessEdge,
  estimateCost,
  requiredNotionalFor,
  liveCexCostInput,
  costBriefSnapshot,
  renderCostBrief,
} from '../server/costModel.ts'
import type { CostInput } from '../server/costModel.ts'
import { CounterpartyRegistry } from '../server/counterpartyRegistry.ts'
import { SettlementLedger } from '../server/settlementLedger.ts'
import { ApprovalGate, ALWAYS_APPROVAL_KINDS, requiresApproval } from '../server/approvalGate.ts'
import { validateClaims, extractClaims } from '../server/claimValidator.ts'
import { assembleContext, estimateTokens } from '../server/contextBudget.ts'
import {
  CEX_EXPECTED_SLIPPAGE_BPS,
  MIN_VIABLE_NOTIONAL_USDT,
  MIN_VIABLE_NOTIONAL_CEX_USDT,
  APPROVAL_THRESHOLD_USDT,
} from '../server/riskConstants.ts'
import { generateProposals, measureFacts } from '../server/proposalEngine.ts'
import type { OrchState } from '../server/types.ts'
import { getOrchState, resetOrch, seedPrice, onMarketBar } from '../server/core.ts'
import { getEvents } from '../server/ledger.ts'
import { configureAutopilot, onAutopilotBar, stopAutopilot, startAutopilot } from '../server/autopilot.ts'
import { configureRegimeSource } from '../server/marketRegime.ts'
import { setInterceptorEnabled, resetInterceptors } from '../server/interceptors.ts'
import { resetGuard } from '../server/positionGuard.ts'

/**
 * 高周期数据换成确定性注入，而不是拉真实 Binance K 线。
 *
 * 两个原因，都不是"为了让测试通过"：
 *  ① **量级必须一致。** 真实 BTC 的 1H ATR 约 $611，而本烟测喂的合成价是 100~165。
 *     两者混用时，止损距离（约 4.8）与 ATR（611）差两个数量级，
 *     新接入的独立复核会（正确地）判定「止损窄于 1.8×ATR，会被杂波扫损」而拦下开仓。
 *     真因是**夹具口径不一致**，不是复核器过严 —— 真实系统里价格与 ATR 必然同量级。
 *  ② 依赖真实行情会让门禁结果随行情波动（见 docs/DEV_PROGRESS.md §3.8.6 第 1 条）。
 *
 * 锚点取 200（高于本烟测的价格区间 100~164.5），使结构阻力始终在价格之上、
 * 因而止盈目标始终来自"结构阻力"这一分支，R:R 保持充裕。
 */
function installRegimeSource(): void {
  configureRegimeSource(async (_symbol: string, interval: string, limit: number) => {
    const anchor = 200
    const n = interval === '1h' ? Math.max(limit, 120) : Math.max(limit, 80)
    const stepPct = interval === '1h' ? 0.004 : 0.012
    const close: number[] = []
    let p = anchor / Math.pow(1 + stepPct, n - 1)
    for (let i = 0; i < n; i++) {
      close.push(p)
      p *= 1 + stepPct
    }
    return { high: close.map((c) => c * 1.0015), low: close.map((c) => c * 0.9985), close }
  })
}

let passed = 0
const failures: string[] = []

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`      ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`      ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'evolve-trusted-seam-'))
const p = (n: string): string => join(tmp, n)

console.log('\n【① 成本闸门】')
{
  const bare: CostInput = { channel: 'cex', venue: 'binance', notionalUsdt: 50_000, expectedEdgeBps: 100 }

  check('CEX 缺少滑点假设 → MISSING_COST_ASSUMPTION（不把缺席项当 0 放行）', () => {
    const r = assessEdge(bare)
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'MISSING_COST_ASSUMPTION')
    assert.ok(r.reason.includes('成本假设不完整'), r.reason)
  })

  check('滑点口径与回测执行假设同源（漂移则进程起不来，这里再断言一次）', () => {
    assert.equal(CEX_EXPECTED_SLIPPAGE_BPS, DEFAULT_EXEC.slippageBps)
  })

  check('CEX 正常交易 → PASS，且净额 = 毛收益 − 总成本', () => {
    const r = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: 50_000, expectedEdgeBps: 100 }))
    assert.equal(r.ok, true, `应放行，实际 ${r.verdict}：${r.reason}`)
    assert.equal(r.verdict, 'PASS')
    const net = r.grossEdgeUsdt - r.totalCostUsdt
    assert.ok(Math.abs(net - r.netEdgeUsdt) < 1e-6, `${net} != ${r.netEdgeUsdt}`)
  })

  check('毛收益盖不住成本 → NEGATIVE_NET（方向对但幅度不够）', () => {
    const r = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: 50_000, expectedEdgeBps: 2 }))
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'NEGATIVE_NET')
  })

  check('CEX 名义本金低于 CEX 地板 → NOTIONAL_TOO_SMALL', () => {
    const r = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: MIN_VIABLE_NOTIONAL_CEX_USDT / 2, expectedEdgeBps: 500 }))
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'NOTIONAL_TOO_SMALL')
  })

  // 地板必须按通道取值：CEX 合约没有 gas / 跨链桥，其可行性地板远低于 DEX。
  // 若两处共用一个数字，就会出现「$20 在合约上完全正常却被判太小」这类类别错误。
  check('地板按通道区分：CEX 地板 < DEX 地板，且同一名义本金在两侧裁决相反', () => {
    assert.ok(
      MIN_VIABLE_NOTIONAL_CEX_USDT < MIN_VIABLE_NOTIONAL_USDT,
      `CEX 地板 ${MIN_VIABLE_NOTIONAL_CEX_USDT} 应低于 DEX 地板 ${MIN_VIABLE_NOTIONAL_USDT}`,
    )
    const mid = (MIN_VIABLE_NOTIONAL_CEX_USDT + MIN_VIABLE_NOTIONAL_USDT) / 2
    const cex = assessEdge(liveCexCostInput({ venue: 'binance', notionalUsdt: mid, expectedEdgeBps: 500 }))
    assert.notEqual(cex.verdict, 'NOTIONAL_TOO_SMALL', `CEX 侧 ${mid} 不应判太小，实际 ${cex.verdict}`)
    const dex = assessEdge({
      channel: 'dex',
      venue: 'uniswap-v3',
      notionalUsdt: mid,
      expectedEdgeBps: 500,
      // 必须给全成本假设，否则会先撞「成本假设缺失」（闸门①）而到不了地板判定（闸门②）
      poolDepthUsdt: 50_000_000,
      chainGasUsdt: 3,
      bridgeFeeUsdt: 1.5,
    })
    assert.equal(dex.verdict, 'NOTIONAL_TOO_SMALL', `DEX 侧 ${mid} 应判太小，实际 ${dex.verdict}`)
  })

  check('固定成本摊薄：DEX 下规模越小，成本占比越高（单调不减的逆命题）', () => {
    const mk = (n: number): CostInput => ({
      channel: 'dex',
      venue: 'uniswap-v3',
      notionalUsdt: n,
      expectedEdgeBps: 300,
      poolDepthUsdt: 50_000_000,
      chainGasUsdt: 3,
      bridgeFeeUsdt: 1.5,
    })
    const small = estimateCost(mk(1_000))
    const large = estimateCost(mk(100_000))
    assert.ok(small.totalBps > large.totalBps, `${small.totalBps} 应大于 ${large.totalBps}`)
  })

  check('DEX 池深不足 → IMPACT_TOO_HIGH（结构性不可行，与方向判断无关）', () => {
    const r = assessEdge({
      channel: 'dex',
      venue: 'uniswap-v3',
      notionalUsdt: 500_000,
      expectedEdgeBps: 400,
      poolDepthUsdt: 1_000_000,
    })
    assert.equal(r.ok, false)
    assert.equal(r.verdict, 'IMPACT_TOO_HIGH')
    assert.ok(r.maxViableNotionalUsdt !== null)
  })

  check('DEX 正常规模与池深 → PASS，且可行性区间有界', () => {
    const r = assessEdge({
      channel: 'dex',
      venue: 'uniswap-v3',
      notionalUsdt: 20_000,
      expectedEdgeBps: 400,
      poolDepthUsdt: 50_000_000,
      chainGasUsdt: 3,
      bridgeFeeUsdt: 1.5,
    })
    assert.equal(r.ok, true, `应放行，实际 ${r.verdict}：${r.reason}`)
    assert.ok(r.maxViableNotionalUsdt !== null && r.maxViableNotionalUsdt > r.breakdown.notionalUsdt)
  })

  check('requiredNotionalFor 不低于同通道的最小可行规模（同一约束不能有两套门槛）', () => {
    const need = requiredNotionalFor(liveCexCostInput({ venue: 'binance', notionalUsdt: 1_000, expectedEdgeBps: 50 }))
    if (need !== null) assert.ok(need >= MIN_VIABLE_NOTIONAL_CEX_USDT, `${need} < ${MIN_VIABLE_NOTIONAL_CEX_USDT}`)
    const needDex = requiredNotionalFor({ channel: 'dex', venue: 'uniswap-v3', notionalUsdt: 1_000, expectedEdgeBps: 50 })
    if (needDex !== null) assert.ok(needDex >= MIN_VIABLE_NOTIONAL_USDT, `${needDex} < ${MIN_VIABLE_NOTIONAL_USDT}`)
  })

  check('提示词成本口径块与面板快照同源', () => {
    const s = costBriefSnapshot()
    const text = renderCostBrief()
    assert.ok(text.includes(String(s.cexTakerFeeBps)), text)
    assert.ok(text.includes(String(s.minViableNotionalUsdt)), text)
    assert.ok(text.includes(String(s.cexExpectedSlippageBps)), text)
  })

  check('默认参数下 DEX 通道未被结构性关闭（占比上限必须高于往返 LP 费率地板）', () => {
    const s = costBriefSnapshot()
    assert.ok(
      s.maxCostShareBps > s.dexRoundTripBps,
      `EV_MAX_COST_SHARE_BPS=${s.maxCostShareBps} ≤ DEX 往返 LP 费率 ${s.dexRoundTripBps}bps，DEX 将全被拒绝`,
    )
  })
}

console.log('\n【② 对手方信任（身份 / 声誉 / 验证）】')
{
  const reg = new CounterpartyRegistry(p('cp.json'))

  check('种子记录 8 条，CEX 3 + DEX 5', () => {
    assert.equal(reg.list().length, 8, `${reg.list().length}`)
  })

  check('记录之间状态独立：一条累积结算不会渗到其它通道（两套口径型缺陷）', () => {
    const before = reg.get('uniswap-v3@8453')!.reputation.samples
    assert.equal(before, 0)
    reg.recordSettlement('binance-futures', {
      ok: true,
      expectedCostUsdt: 10,
      realizedCostUsdt: 10,
      slippageBps: 3,
    })
    assert.equal(reg.get('binance-futures')!.reputation.samples, 1)
    assert.equal(reg.get('uniswap-v3@8453')!.reputation.samples, 0, 'binance 的结算史不应出现在 DEX 通道上')
    assert.equal(reg.get('okx-swap')!.reputation.samples, 0)
  })

  check('未登记对手方 → UNKNOWN_COUNTERPARTY，敞口倍数 0', () => {
    const t = reg.assess('some-random-dex')
    assert.equal(t.allowed, false)
    assert.equal(t.verdict, 'UNKNOWN_COUNTERPARTY')
    assert.equal(t.sizeMultiplier, 0)
  })

  check('无样本 → UNPROVEN，允许半仓试探（不是 0 也不是 1）', () => {
    const t = reg.assess('okx-swap')
    assert.equal(t.verdict, 'UNPROVEN')
    assert.ok(t.sizeMultiplier > 0 && t.sizeMultiplier < 1, `${t.sizeMultiplier}`)
  })

  check('「已核验」拒绝 auto:* 自封', () => {
    const r = reg.setValidation('okx-swap', 'verified', '自封', 'auto:system')
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('auto'), r.reason)
  })

  check('隔离优先于声誉：即使有正向样本，隔离即拒', () => {
    reg.recordSettlement('sandbox-venue', { ok: true, expectedCostUsdt: 1, realizedCostUsdt: 1, slippageBps: 0 })
    reg.setValidation('sandbox-venue', 'quarantined', '演练用场所，不进真实链路', 'noah')
    const t = reg.assess('sandbox-venue')
    assert.equal(t.allowed, false)
    assert.equal(t.verdict, 'QUARANTINED')
  })

  check('声誉分由本项目自己的结算史派生，样本为 0 时不给分', () => {
    const rec = reg.get('uniswap-v3@10')!
    assert.equal(rec.reputation.samples, 0)
    assert.equal(rec.reputation.score, null)
  })
}

console.log('\n【③ 跨通道结算义务台账】')
{
  const led = new SettlementLedger(p('stl.json'))
  const open = (intentId: string, symbol: string, chainId: number | null): string => {
    const r = led.openObligation({
      intentId,
      counterpartyId: 'binance-futures',
      environment: 'paper',
      asset: { symbol, chainId },
      direction: 'deliver',
      amountUsdt: 1_000,
    })
    assert.equal(r.ok, true, r.reason)
    return r.obligation!.id
  }

  check('同名资产跨域不合并：USDC@8453 / USDC@cex / USDC@42161 分成 3 组', () => {
    open('intent-base', 'USDC', 8453)
    open('intent-cex', 'USDC', null)
    open('intent-arb', 'USDC', 42161)
    const n = led.netting('paper')
    const usdcGroups = n.groups.filter((g) => g.assetKey.startsWith('USDC@'))
    assert.equal(usdcGroups.length, 3, JSON.stringify(n.groups.map((g) => g.assetKey)))
  })

  check('跨域同符号被单列为提示项，而不是被当作可对冲', () => {
    const n = led.netting('paper')
    assert.ok(n.crossDomain.length >= 1, JSON.stringify(n.crossDomain))
    // 3 个域两两组合 = 3 对。若出现 6 条，说明同一对被报了两次。
    const keys = n.crossDomain.map((c) => [c.from, c.to].sort().join('|'))
    assert.equal(new Set(keys).size, keys.length, `域对被重复报告：${JSON.stringify(keys)}`)
  })

  check('幂等：同一 intentId 二次开立不产生第二条义务', () => {
    const before = led.list('paper').length
    const r = led.openObligation({
      intentId: 'intent-base',
      counterpartyId: 'binance-futures',
      environment: 'paper',
      asset: { symbol: 'USDC', chainId: 8453 },
      direction: 'deliver',
      amountUsdt: 999_999,
    })
    assert.equal(r.idempotent, true)
    assert.equal(led.list('paper').length, before)
  })

  check('终态不可复活：已结义务拒绝改回未结', () => {
    const id = open('intent-settle', 'USDC', 8453)
    assert.equal(led.advance(id, 'settled').ok, true)
    const back = led.advance(id, 'open')
    assert.equal(back.ok, false)
    assert.ok(back.reason.includes('终态'), back.reason)
  })

  check('作废必须给出理由', () => {
    const id = open('intent-void', 'USDC', 8453)
    assert.equal(led.advance(id, 'void').ok, false)
    assert.equal(led.advance(id, 'void', { note: '对手方变更，原义务失效' }).ok, true)
  })

  check('对账能检出孤儿义务与金额漂移', () => {
    const r = led.reconcile('paper', [{ intentId: 'intent-settle', amountUsdt: 1_000 }])
    const kinds = r.findings.map((f) => f.kind)
    assert.ok(kinds.includes('ORPHAN_OBLIGATION'), JSON.stringify(kinds))
  })
}

console.log('\n【④ 人类在环审批闸门】')
{
  const gate = new ApprovalGate(p('apr.json'))

  check('paper 环境免审批（不出真实资金）', () => {
    assert.equal(requiresApproval('live_order', 'paper', 10_000_000).required, false)
    // 结构性动作在 paper 下同样免审批：paper 环境不存在「改变能力边界」的后果。
    assert.equal(requiresApproval('venue_outbound_enable', 'paper', 0).required, false)
  })

  check('结构性动作不看金额一律需要审批', () => {
    for (const kind of ALWAYS_APPROVAL_KINDS) {
      const r = requiresApproval(kind, 'live', 0)
      assert.equal(r.required, true, `${kind} 竟然不需要审批`)
    }
  })

  check('未知动作类型按保守默认处理（Fail-Closed）', () => {
    assert.equal(requiresApproval('some-new-kind' as never, 'live', 1).required, true)
  })

  check('实盘低于门槛放行、达到门槛需审批（默认门槛取真实配置值）', () => {
    assert.equal(requiresApproval('live_order', 'live', APPROVAL_THRESHOLD_USDT - 1).required, false)
    assert.equal(requiresApproval('live_order', 'live', APPROVAL_THRESHOLD_USDT).required, true)
  })

  check('pending 请求被按 dedupeKey 复用，不重复排队', () => {
    gate.submit({ kind: 'live_order', environment: 'live', amountUsdt: 9_000, dedupeKey: 'k1', summary: 's1' })
    gate.submit({ kind: 'live_order', environment: 'live', amountUsdt: 9_000, dedupeKey: 'k1', summary: 's1' })
    assert.equal(gate.list({ status: 'pending' }).length, 1)
  })

  check('代码不能自我批准实盘动作（auto:* 署名被拒）', () => {
    const id = gate.list({ status: 'pending' })[0].id
    const r = gate.decide(id, 'approved', 'auto:autopilot')
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('auto'), r.reason)
  })

  check('闸门语义：批准一次、消费一次，第二次要重新报批', () => {
    const id = gate.list({ status: 'pending' })[0].id
    assert.equal(gate.decide(id, 'approved', 'noah').ok, true)
    const g1 = gate.gate({ kind: 'live_order', environment: 'live', amountUsdt: 9_000, dedupeKey: 'k1', summary: 's1' })
    assert.equal(g1.allowed, true, g1.reason)
    const g2 = gate.gate({ kind: 'live_order', environment: 'live', amountUsdt: 9_000, dedupeKey: 'k1', summary: 's1' })
    assert.equal(g2.allowed, false, '同一次批准不应被重复消费')
    assert.ok(g2.approvalId !== null, '第二次应留下新的待批记录')
  })

  check('过期请求不接受补批', () => {
    const past = new Date(Date.now() - 365 * 24 * 3600_000)
    const r = gate.submit({
      kind: 'live_order',
      environment: 'live',
      amountUsdt: 9_000,
      dedupeKey: 'k-expired',
      summary: '陈旧请求',
      now: past,
    })
    assert.equal(r.ok, true)
    const d = gate.decide(r.request!.id, 'approved', 'noah')
    assert.equal(d.ok, false)
    assert.ok(d.reason.includes('过期'), d.reason)
  })
}

console.log('\n【⑤ 声称核验（三态裁定）】')
{
  const facts = { adx: 12, atr: 300, price: 60_000, timeframe: '15M', rr: 1.4 }

  check('抽取器认得趋势 / ADX / ATR / 盈亏比 / 结构声明', () => {
    const claims = extractClaims('趋势向上，ADX 28，ATR 1.2%，盈亏比 3.1，突破前高')
    const kinds = claims.map((c) => c.kind).sort()
    assert.ok(kinds.includes('trend'), JSON.stringify(kinds))
    assert.ok(kinds.includes('adx'), JSON.stringify(kinds))
    assert.ok(kinds.includes('atr'), JSON.stringify(kinds))
    assert.ok(kinds.includes('rr'), JSON.stringify(kinds))
    assert.ok(kinds.includes('structure'), JSON.stringify(kinds))
  })

  check('编造的指标 → REJECTED（冲突足以否决整个提案）', () => {
    const r = validateClaims('ADX 28 显示强趋势，盈亏比 3.2', facts)
    assert.equal(r.outcome, 'REJECTED')
    assert.equal(r.fatal, true)
    assert.ok(r.contradicted >= 2, `${r.contradicted}`)
  })

  check('诚实的声明 → VERIFIED', () => {
    // 文本里刻意不含趋势词：本组 facts 没有 macroTrend，
    // 一旦提到「震荡/向上」就会（正确地）被判 UNVERIFIABLE，与本断言无关。
    const r = validateClaims('ADX 13，ATR 300，盈亏比 1.4', facts)
    assert.equal(r.outcome, 'VERIFIED', r.reason)
    assert.equal(r.ok, true)
  })

  check('实测缺失 → UNVERIFIED，而不是被当成通过', () => {
    const r = validateClaims('ADX 28 强趋势', { adx: undefined, timeframe: '15M' })
    assert.equal(r.outcome, 'UNVERIFIED')
    assert.equal(r.ok, false)
  })

  check('声明标注了周期且与实测不符 → 判不可核对（跨周期数值不可比）', () => {
    const r = validateClaims('ADX 15M 31.5', { adx: 31.5, timeframe: '1H' })
    assert.equal(r.outcome, 'UNVERIFIED')
    assert.ok(r.claims[0].reason.includes('跨周期'), r.claims[0].reason)
  })

  check('声明未标周期时比对成立，但理由必须写明按哪个口径比的', () => {
    const r = validateClaims('ADX 31.5', { adx: 31.5, timeframe: '1H' })
    assert.equal(r.outcome, 'VERIFIED')
    assert.ok(r.claims[0].reason.includes('未标注周期'), `理由缺少口径披露：${r.claims[0].reason}`)
    assert.ok(r.claims[0].reason.includes('1H'), r.claims[0].reason)
  })

  check('声明标了周期而实测未标 → 判不可核对（口径未知的比对不算比对）', () => {
    const r = validateClaims('ADX 1H 28', { adx: 28 })
    assert.equal(r.outcome, 'UNVERIFIED')
    assert.ok(r.reason.includes('未标注周期') || r.claims[0].reason.includes('未标注周期'), r.claims[0]?.reason ?? r.reason)
  })

  check('requireVerified=false 可放宽 UNVERIFIED，但绝不放宽 REJECTED', () => {
    const relaxed = validateClaims('ADX 28 强趋势', facts, { requireVerified: false })
    assert.equal(relaxed.outcome, 'REJECTED', '发现矛盾在任何配置下都不放行')
    const noClaim = validateClaims('觉得差不多可以试试', facts, { requireVerified: false })
    assert.equal(noClaim.outcome, 'VERIFIED')
    const noClaimStrict = validateClaims('觉得差不多可以试试', facts)
    assert.equal(noClaimStrict.outcome, 'UNVERIFIED', '「无法验证」不等于「验证通过」')
  })

  check('事实派生如实标注周期，且拿不到的字段留空而不是填一个像样的值', () => {
    const candles = genSynthCandles({ seed: 11, bars: 300, startPrice: 60_000, volDaily: 0.04, driftDaily: 0.0003, barMinutes: 15 })
    const m = measureFacts(candles)
    // 本引擎手里只有 15 分钟 K 线 —— 谎报成 1H 会让跨周期比对被误判为「一致」
    assert.equal(m.timeframe, '15M')
    // 高周期结构由 marketRegime 从 1H 数据派生，本引擎没有那份输入。
    // 填一个 'RANGE' 会让所有趋势声明被判「与实测冲突」（制造假冲突），所以必须留空。
    assert.equal(m.macroTrend, undefined)
    assert.ok(typeof m.adx === 'number' && Number.isFinite(m.adx), `ADX 未派生：${m.adx}`)
    assert.ok(typeof m.atr === 'number' && Number.isFinite(m.atr), `ATR 未派生：${m.atr}`)
    // 空白输入不得抛错 —— 它会被判「无从核对」，而不是崩掉提案引擎
    assert.deepEqual(measureFacts([]), {})
  })
}

console.log('\n【⑥ 上下文预算】')
{
  const blocks = [
    { id: 'task', text: '任务描述', priority: 1, mandatory: true },
    { id: 'risk-brief', text: '风控口径'.repeat(40), priority: 2, mandatory: true },
    { id: 'lesson-lib', text: '心法库内容'.repeat(2000), priority: 9, truncatable: true },
  ]

  check('强制块放不下时整体失败，而不是丢掉约束继续', () => {
    const a = assembleContext(blocks, 10)
    assert.equal(a.ok, false)
    assert.equal(a.text, '')
    assert.ok((a.failureReason ?? '').length > 0)
  })

  check('预算紧张时强制块存活、可选块被裁（预留制而非边填边看）', () => {
    // 预算取「强制块够放、可选大块放不下」的区间：
    // 强制块约 164 token（含 160 个中文字），心法库约 10000 token。
    const a = assembleContext(blocks, 400)
    assert.equal(a.ok, true, a.failureReason ?? '')
    assert.ok(a.includedIds.includes('risk-brief'), JSON.stringify(a.includedIds))
    assert.ok(a.droppedIds.length + a.truncatedIds.length >= 1, `未被裁剪：${JSON.stringify(a)}`)
  })

  check('裁剪与丢弃必须被如实报告（静默裁剪等于没有预算）', () => {
    const a = assembleContext(blocks, 400)
    assert.ok(a.truncatedIds.includes('lesson-lib') || a.droppedIds.includes('lesson-lib'), JSON.stringify(a))
  })

  check('确定性：同样的块集合，输入顺序不同输出相同', () => {
    const a = assembleContext(blocks, 400)
    const b = assembleContext([...blocks].reverse(), 400)
    assert.equal(a.text, b.text)
    assert.deepEqual(a.includedIds, b.includedIds)
  })

  check('token 估算对中文不低判（中文按 1 token/字计的保守侧）', () => {
    assert.ok(estimateTokens('中文十个字试试看') >= 8, `${estimateTokens('中文十个字试试看')}`)
  })
}

console.log('\n【⑦ 接线：提示词与开仓链路真的用上了这些闸门】')
await checkAsync('提案引擎的上下文里同时含风控口径与成本口径，且预算未超', async () => {
  const candles: Candle[] = genSynthCandles({
    seed: 7,
    bars: 400,
    startPrice: 60_000,
    volDaily: 0.04,
    driftDaily: 0.0003,
    barMinutes: 15,
  })
  const r = await generateProposals({} as OrchState, { source: 'human', candles, maxProposals: 1 })
  assert.ok(r.context.ok, r.context.report)
  assert.ok(r.context.includedIds.includes('risk-brief'), JSON.stringify(r.context.includedIds))
  assert.ok(r.context.includedIds.includes('cost-brief'), JSON.stringify(r.context.includedIds))
  assert.ok(r.context.estimatedTokens <= r.context.budgetTokens)
})

/**
 * 这一步刻意跑真实的自治循环，而不是只读代码确认「闸门被调用了」。
 *
 * 一个闸门最容易的失效方式不是算错，而是**根本没被调用**——
 * 它不报错、不留痕，只是从不出现在执行路径上。所以这里必须经由真实的
 * `onAutopilotBar → tradeBar → tryOpenLong` 链路，让证据落进只追加账本。
 *
 * 两个前置处理及其理由：
 *   · 关掉 `filter.adx_regime` / `filter.macro_trend`：合成行情里 ADX 只有个位数，
 *     上游过滤会把流程挡在 tryOpenLong 之前，成本闸门就永远走不到。
 *     把上游关掉是为了**让下游可达**，不是因为上游错了。
 *   · pin 动量突破族：用默认的均值回归族在单边上行里根本不产生多头信号，
 *     同样走不到开仓 —— 这也是既有 autopilot 烟测长期为红的真因。
 */
await checkAsync('成本闸门真接在开仓链路上：开仓事件带完整成本证据', async () => {
  process.env.AUTOPILOT_PRESEED = 'false'
  process.env.AUTOPILOT_LIVE = 'false'
  process.env.AUTOPILOT_PINNED_STRATEGY = 'breakout:{"period":10}'
  resetOrch(100_000)
  seedPrice('BTCUSDT', 100)
  configureAutopilot({ getState: getOrchState })
  installRegimeSource()
  getOrchState().risk.maxNotionalPerOrder = 5_000_000
  setInterceptorEnabled('filter.adx_regime', false)
  setInterceptorEnabled('filter.macro_trend', false)

  const started = await startAutopilot(2)
  assert.equal(started.ok, true, JSON.stringify(started))

  const bar = (t: number, c: number) => ({
    t,
    o: c - 0.3,
    h: Math.max(c - 0.3, c) * 1.001,
    l: Math.min(c - 0.3, c) * 0.999,
    c,
    v: 10_000,
  })
  let ts = Date.now() - 130 * 60_000
  for (let i = 0; i < 130; i++) {
    const px = 100 + i * 0.5
    onMarketBar('BTCUSDT', bar(ts, px))
    await onAutopilotBar(bar(ts, px))
    ts += 60_000
  }

  const opened = getEvents(0).filter((e) => e.kind === 'AUTOPILOT_POSITION_OPENED')
  assert.ok(opened.length > 0, '真实开仓链路未产生持仓事件——成本闸门是否被上游短路？')

  const cost = (opened[0].payload as { cost?: Record<string, unknown> }).cost
  assert.ok(cost, '开仓事件缺少成本证据：净收益将无法事后复算')
  assert.equal(cost.verdict, 'PASS')
  assert.ok(Number(cost.totalCostBps) > 0, '总成本占比为 0，说明某个成本项没被计进去')
  assert.ok(Number(cost.requiredMultiple) > 0, '缺少「edge 必须盖过成本几倍」的门槛，闸门失去意义')

  // 资金费项必须出现，且带上持仓时长口径 —— 漏掉它是一类静默低估
  const items = cost.items as { label: string; bps: number }[]
  assert.ok(items.length >= 3, `成本项少于 3 条（费率/滑点/资金费）：${JSON.stringify(items)}`)
  assert.ok(
    items.some((i) => i.label.includes('资金费')),
    `成本项里没有资金费：${JSON.stringify(items)}`,
  )

  stopAutopilot('trusted-seam smoke 收尾')
  resetGuard()
  resetInterceptors()
  // 行情源恢复为真实取数：注入只服务于本用例的确定性，
  // 留着它会让后续用例（乃至同进程的其它断言）静默跑在假数据上。
  configureRegimeSource(null)
  resetOrch(100_000)
  delete process.env.AUTOPILOT_PINNED_STRATEGY
})

// ── 收尾 ──
rmSync(tmp, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log('✅ 双通道可信接缝烟测全部通过')
