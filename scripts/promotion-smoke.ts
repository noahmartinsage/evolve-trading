import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PromotionPipeline,
  DEFAULT_PIPELINE_CONFIG,
  PROMOTION_PIPELINE_VERSION,
  FITNESS_VERSION,
} from '../src/engine/index.ts'
import { failingReceipt, receipt } from './overfit-fixture.ts'

function fail(msg: string): never {
  console.error(`❌ PROMOTION SMOKE FAIL · ${msg}`)
  process.exit(1)
}

function expectStage(actual: string | undefined, expected: string, ctx: string): void {
  if (actual !== expected) fail(`${ctx}: 期望 ${expected} 实际 ${actual}`)
}

function throws(ctx: string, fn: () => unknown): void {
  try {
    fn()
    fail(`${ctx}: 应抛异常但未抛`)
  } catch {
    /* 预期异常 */
  }
}

const T0 = Date.UTC(2026, 7, 1)
const pipe = new PromotionPipeline({ ...DEFAULT_PIPELINE_CONFIG })
// ⚠️ 必须引用 FITNESS_VERSION，不要写字面量 'fitness-v1'/'fitness-v2'。
// 这里曾硬编码 'fitness-v1' 去构造"版本不匹配"用例，而引擎已升到 'fitness-v2'
// —— 于是"不匹配"变成了"匹配"，断言反转、本道门失效（F-1 的复发形态）。
// 版本号只允许有一个出处：src/engine/fitness.ts。
const STALE_FITNESS_VERSION = `${FITNESS_VERSION}-stale`
// 过拟合凭据。**基线是一份在默认阈值下通过的凭据**，各反例在它之上做单点破坏。
// 这与 `wfRobust: true` 那种自报不同：凭据里只有可观测量（PBO / 赢家分位 /
// 折数 / 候选数 / 数据指纹），阈值由流水线的 config 施加，构造者瞒不过它。
const RECEIPT = receipt()
const GATE = { fitness: { version: FITNESS_VERSION, value: 80 }, overfit: RECEIPT, purityHomogeneous: false }

pipe.submit('v-mismatch', T0)
throws('适应度版本不匹配', () =>
  pipe.evaluateBacktestGate('v-mismatch', { fitness: { version: STALE_FITNESS_VERSION, value: 99 }, overfit: RECEIPT, purityHomogeneous: false }, T0),
)
console.log(`✅ 门1a · 非 ${FITNESS_VERSION} 版本 → 抛 FITNESS_VERSION_MISMATCH`)

pipe.submit('low-fit', T0)
expectStage(pipe.evaluateBacktestGate('low-fit', { ...GATE, fitness: { version: FITNESS_VERSION, value: 10 } }, T0), 'rejected', '低适应度')
console.log('✅ 门1b · fitness < 阈值 → rejected')

pipe.submit('no-receipt', T0)
// 关键的回归断言：把**旧的自报格式**喂进来，必须被拒。
// 改造前这里传 `wfRobust: false` 也会拒 —— 但那是因为调用方"老实自报"；
// 而 `wfRobust: true` 就会被放行，尽管从来没有任何东西算过它。
expectStage(
  pipe.evaluateBacktestGate('no-receipt', { ...GATE, overfit: { wfRobust: true } as never }, T0),
  'rejected',
  '自报格式无凭据',
)
console.log('✅ 门1c · 凭据缺失/是旧的自报布尔量 → rejected（不再采信自报）')

pipe.submit('overfit-fail', T0)
expectStage(pipe.evaluateBacktestGate('overfit-fail', { ...GATE, overfit: failingReceipt() }, T0), 'rejected', '过拟合不达标')
console.log('✅ 门1d · 凭据完好但 PBO 超标 → rejected')

pipe.submit('homo', T0)
expectStage(pipe.evaluateBacktestGate('homo', { ...GATE, purityHomogeneous: true }, T0), 'rejected', '同质化')
console.log('✅ 门1e · 候选同质化 → rejected')

throws('未知策略回滚', () => pipe.rollback('ghost', T0, '测试'))

pipe.submit('thin-paper', T0)
pipe.evaluateBacktestGate('thin-paper', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades - 1; i++) pipe.recordPaperTrade('thin-paper', T0 + i)
expectStage(pipe.closePaperObservation('thin-paper', T0 + 100), 'rejected', '笔数不足')
console.log(`✅ 门2a · 纸交易笔数 < ${DEFAULT_PIPELINE_CONFIG.paperMinTrades} → rejected`)

pipe.submit('dd-breach', T0)
pipe.evaluateBacktestGate('dd-breach', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('dd-breach', T0 + i)
pipe.recordPaperDrawdown('dd-breach', DEFAULT_PIPELINE_CONFIG.paperMaxDrawdownPct + 1)
expectStage(pipe.closePaperObservation('dd-breach', T0 + 200), 'rejected', '纸交易回撤超限')
console.log(`✅ 门2b · 纸交易回撤 > ${DEFAULT_PIPELINE_CONFIG.paperMaxDrawdownPct}% → rejected`)

pipe.submit('good', T0)
expectStage(pipe.evaluateBacktestGate('good', GATE, T0), 'paper_observing', 'backtest门通过')
throws('观察期未满不可审批', () => pipe.approveSmallCap('good', 'human-a', T0))
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades + 5; i++) pipe.recordPaperTrade('good', T0 + i)
pipe.recordPaperDrawdown('good', 4.2)
expectStage(pipe.closePaperObservation('good', T0 + 300), 'ready_for_small_cap', '观察期通过')
console.log('✅ 门2c · 观察期达标 → ready_for_small_cap')

// ── 门2.5 测试网实测（用户要求：自进化策略必须先经测试网实测检验通过，才可被采纳进实盘）──
throws('场所缺失不得进入实测', () => pipe.beginTestnetVerification('good', T0 + 301, ''))
throws('观察期未通过的策略不得进入实测', () => pipe.beginTestnetVerification('thin-paper', T0 + 301, 'okx-testnet'))
expectStage(pipe.beginTestnetVerification('good', T0 + 301, 'okx-testnet'), 'testnet_verifying', '进入测试网实测')
console.log('✅ 门2.5a · ready_for_small_cap → testnet_verifying（需显式场所）')

throws('实测进行中不得直接审批实盘', () => pipe.approveSmallCap('good', 'human-a', T0 + 302))
expectStage(pipe.closeTestnetVerification('good', T0 + 303), 'rejected', '实测零成交')
console.log('✅ 门2.5b · 零成交 → rejected（订单被拒不是样本）')

// 观测时长不足：笔数够但挤在几分钟内 → 拒绝（防"短时间刷笔数"形式达标）
pipe.submit('tn-fast', T0)
pipe.evaluateBacktestGate('tn-fast', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('tn-fast', T0 + i)
pipe.closePaperObservation('tn-fast', T0 + 100)
pipe.beginTestnetVerification('tn-fast', T0 + 200, 'okx-testnet')
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.testnetMinFills + 2; i++) pipe.recordTestnetFill('tn-fast', T0 + 200 + i * 60_000)
expectStage(pipe.closeTestnetVerification('tn-fast', T0 + 400), 'rejected', '观测时长不足')
console.log(`✅ 门2.5c · 笔数够但观测 < ${DEFAULT_PIPELINE_CONFIG.testnetMinHours}h → rejected`)

// 违规一票否决：笔数、时长、回撤三项都达标，但出现一次违规
pipe.submit('tn-violation', T0)
pipe.evaluateBacktestGate('tn-violation', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('tn-violation', T0 + i)
pipe.closePaperObservation('tn-violation', T0 + 100)
pipe.beginTestnetVerification('tn-violation', T0 + 200, 'okx-testnet')
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.testnetMinFills + 2; i++) {
  pipe.recordTestnetFill('tn-violation', T0 + 200 + i * 3_600_000)
}
pipe.recordTestnetDrawdown('tn-violation', 3.5)
pipe.recordTestnetViolation('tn-violation', '预留被误释放（unknown 状态）')
expectStage(pipe.closeTestnetVerification('tn-violation', T0 + 90_000_000), 'rejected', '违规一票否决')
console.log('✅ 门2.5d · 违规 → rejected（一票否决，不参与收益折算）')

const TN_HOURS = DEFAULT_PIPELINE_CONFIG.testnetMinHours + 1

// 缺尾部风险样本：笔数/时长/回撤/违规四项全达标，但从未回传逐笔收益 → 必须拒绝。
// 若此处改成放行，不回传收益的策略就会比老实回传的更安全（反向激励）。
pipe.submit('tn-noret', T0)
pipe.evaluateBacktestGate('tn-noret', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('tn-noret', T0 + i)
pipe.closePaperObservation('tn-noret', T0 + 100)
pipe.beginTestnetVerification('tn-noret', T0 + 200, 'okx-testnet')
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.testnetMinFills + 3; i++) {
  pipe.recordTestnetFill('tn-noret', T0 + 200 + i * 3_600_000)
}
expectStage(
  pipe.closeTestnetVerification('tn-noret', T0 + 200 + TN_HOURS * 3_600_000),
  'rejected',
  '缺尾部风险样本 → 默认拒绝',
)
console.log('✅ 门2.5e · 未回传逐笔收益 → rejected（缺样本按默认拒绝，不给反向激励）')

// 尾部过肥：回撤达标（≈7.3% < 10%），但最差 5% 平均亏 5.5% > 4% 上限 → 拒绝。
// 这条用例正是回撤守不住的那类策略：曲线看起来还算体面，亏损却高度集中在两笔。
pipe.submit('tn-tail', T0)
pipe.evaluateBacktestGate('tn-tail', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('tn-tail', T0 + i)
pipe.closePaperObservation('tn-tail', T0 + 100)
pipe.beginTestnetVerification('tn-tail', T0 + 200, 'okx-testnet')
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.testnetMinFills + 3; i++) {
  pipe.recordTestnetFill('tn-tail', T0 + 200 + i * 3_600_000)
}
const TAIL_RETURNS = [-5.5, ...Array.from({ length: 19 }, () => 0.2), -5.5, ...Array.from({ length: 19 }, () => 0.2)]
for (const r of TAIL_RETURNS) pipe.recordTestnetReturn('tn-tail', r)
const tailStats = pipe.get('tn-tail').testnetStats
if (tailStats === null || tailStats.cvarLossPct === null) fail('尾部统计未生成')
if (tailStats.cvarLossPct <= DEFAULT_PIPELINE_CONFIG.testnetMaxCvarPct) fail(`CVaR 未超限: ${tailStats.cvarLossPct}`)
if (tailStats.maxDrawdownPct > DEFAULT_PIPELINE_CONFIG.testnetMaxDrawdownPct) {
  fail(`回撤用例设计有误：应由 CVaR 而非回撤拦下，实际回撤 ${tailStats.maxDrawdownPct}%`)
}
expectStage(
  pipe.closeTestnetVerification('tn-tail', T0 + 200 + TN_HOURS * 3_600_000),
  'rejected',
  '尾部平均损失超限',
)
console.log(
  `✅ 门2.5f · 回撤 ${tailStats.maxDrawdownPct.toFixed(2)}% 达标但 CVaR ${tailStats.cvarLossPct.toFixed(2)}%` +
    ` > ${DEFAULT_PIPELINE_CONFIG.testnetMaxCvarPct}% → rejected（回撤看不见尾部形状）`,
)

// 正常通过：笔数与观测时长均达标、零违规、回撤与尾部风险均达标
pipe.submit('tn-ok', T0)
pipe.evaluateBacktestGate('tn-ok', GATE, T0)
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) pipe.recordPaperTrade('tn-ok', T0 + i)
pipe.closePaperObservation('tn-ok', T0 + 100)
pipe.beginTestnetVerification('tn-ok', T0 + 200, 'okx-testnet')
for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.testnetMinFills + 3; i++) {
  pipe.recordTestnetFill('tn-ok', T0 + 200 + i * 3_600_000)
}
// 逐笔收益：多数小赚、少数小亏 —— 尾部平均损失远低于上限
for (const r of [0.8, -0.6, 1.1, -0.5, 0.7, 0.9, -0.7, 0.4, 1.2, -0.55, 0.6, 0.3, -0.4]) {
  pipe.recordTestnetReturn('tn-ok', r)
}
pipe.recordTestnetDrawdown('tn-ok', 4.8)
expectStage(pipe.closeTestnetVerification('tn-ok', T0 + 200 + TN_HOURS * 3_600_000), 'testnet_verified', '实测达标')
const tnStats = pipe.get('tn-ok').testnetStats
if (!tnStats || tnStats.fills < DEFAULT_PIPELINE_CONFIG.testnetMinFills) fail(`实测统计异常: ${JSON.stringify(tnStats)}`)
if (tnStats.violations !== 0) fail('零违规策略被记了违规')
console.log(`✅ 门2.5e · 实测达标 → testnet_verified（${tnStats.fills} 笔 · 零违规 · 场所 ${tnStats.venue}）`)

throws('未经实测通过的策略不得审批进实盘', () => {
  const bad = new PromotionPipeline({ ...DEFAULT_PIPELINE_CONFIG })
  bad.submit('no-tn', T0)
  bad.evaluateBacktestGate('no-tn', GATE, T0)
  for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) bad.recordPaperTrade('no-tn', T0 + i)
  bad.closePaperObservation('no-tn', T0)
  bad.approveSmallCap('no-tn', 'human-a', T0)
})
console.log('✅ 门2.5f · 跳过测试网实测 → 审批被拒（实盘采纳必须有实测实证）')

// ── 门3 人工审批（前置条件已收紧为「测试网实测通过」）──
// 'good' 已在门2.5b 被 rejected（零成交）—— 实测被拒的策略不得进实盘，这本身就是要守住的性质
throws('实测被拒的策略不得进实盘', () => pipe.approveSmallCap('good', 'human-a', T0 + 304))
throws('空审批人', () => pipe.approveSmallCap('tn-ok', '', T0 + 90_000_000))
expectStage(pipe.approveSmallCap('tn-ok', 'human-a', T0 + 90_000_001), 'small_cap_live', '人工审批')
const approved = pipe.get('tn-ok')
if (approved.capUsd !== DEFAULT_PIPELINE_CONFIG.smallCapUsd) fail(`资金帽未设置: ${approved.capUsd}`)
if (approved.approvedBy !== 'human-a') fail('审批人未记录')
console.log(`✅ 门3 · 实测通过 + 人工审批 → small_cap_live（资金帽 $${approved.capUsd}）`)

const good = 'tn-ok'
throws('未过小资金阶段不可全量', () => {
  const bad = new PromotionPipeline({ ...DEFAULT_PIPELINE_CONFIG })
  bad.submit('skip', T0)
  bad.evaluateBacktestGate('skip', GATE, T0)
  for (let i = 0; i < DEFAULT_PIPELINE_CONFIG.paperMinTrades; i++) bad.recordPaperTrade('skip', T0 + i)
  bad.closePaperObservation('skip', T0)
  bad.promoteFull('skip', T0)
})

expectStage(pipe.promoteFull(good, T0 + 90_000_400), 'full_live', '解除资金帽')
if (pipe.get(good).capUsd !== null) fail('全量后资金帽未解除')
console.log('✅ 门4 · small_cap → full_live（资金帽解除）')

expectStage(pipe.rollback(good, T0 + 90_000_500, '实盘异常触发回滚'), 'rolled_back', '回滚')
throws('rolled_back 状态重复回滚', () => pipe.rollback(good, T0 + 90_000_501, 'x'))
expectStage(pipe.restoreFromRollback(good, T0 + 90_000_600), 'full_live', '回滚恢复')
console.log('✅ 回滚/恢复闭环')

const hist = pipe.get(good).history
for (let i = 1; i < hist.length; i++) {
  if (hist[i].ts <= hist[i - 1].ts) fail('history 时间戳非单调')
  if (hist[i].from !== hist[i - 1].to) fail(`history 断链于 #${i}: ${hist[i].from} != ${hist[i - 1].to}`)
}
console.log(`✅ 晋升历史完整 · ${hist.length} 次转移 · 链条无断点`)

const dir = join(process.cwd(), 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'promotion-latest.json'),
  JSON.stringify({
    pipelineVersion: PROMOTION_PIPELINE_VERSION,
    config: pipe.getConfig(),
    finishedAt: new Date().toISOString(),
    strategies: pipe.list().map((r) => ({ id: r.id, stage: r.stage, transitions: r.history.length })),
    goodChain: pipe.get(good).history,
  }, null, 2),
)

console.log('\n🧾 晋升报告已归档 artifacts/promotion-latest.json')
console.log('🎉 PROMOTION SMOKE PASSED')
