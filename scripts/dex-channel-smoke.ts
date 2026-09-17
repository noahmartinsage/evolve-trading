/**
 * DEX 通道贯通性门禁。
 *
 * 需求原话是「检验所有 DEX 交易都要被正常使用」。这话拆开是可判定的四件事：
 *   ① 五条链的合约地址齐备且格式合法 —— 缺一条，那条链就是**静默不可用**
 *   ② 合理规模下每条链的成本裁决都能 PASS —— 不被结构性拒绝
 *   ③ 超额名义 / 浅池时必须被**正确拒绝** —— 证明 ② 不是靠放宽阈值换来的
 *   ④ 每条链的对手方可准入、且地址与执行层**同源**、结算域互不混淆
 *
 * 第 ④ 条里的「同源」是本项目最看重的一类断言：
 * 对手方登记表里的 router 地址若和执行层各写一份，两边会各自漂移，
 * 而漂移的后果是「准入检查对着一个地址、真实下单发给另一个地址」——
 * 不报错、不崩溃，只是把钱发到了错的地方。
 */

import assert from 'node:assert/strict'
import { contractsByChain } from '../src/dex/uniswap.ts'
import type { DexChainId } from '../src/dex/uniswap.ts'
import { assessEdge } from '../server/costModel.ts'
import { getCounterpartyRegistry } from '../server/counterpartyRegistry.ts'
import { assetKeyOf } from '../server/settlementLedger.ts'
import {
  DEX_LP_FEE_BPS,
  DEX_MAX_PRICE_IMPACT_BPS,
  MAX_COST_SHARE_BPS,
  MIN_VIABLE_NOTIONAL_USDT,
} from '../server/riskConstants.ts'

let passed = 0
const failures: string[] = []

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

/** 五条链及其**报价侧可动用池深**的保守估计（USDT）。 */
const CHAINS: { id: DexChainId; name: string; depthUsdt: number }[] = [
  { id: 1, name: 'Ethereum', depthUsdt: 150_000_000 },
  { id: 8453, name: 'Base', depthUsdt: 15_000_000 },
  { id: 42161, name: 'Arbitrum', depthUsdt: 25_000_000 },
  { id: 10, name: 'OP Mainnet', depthUsdt: 6_000_000 },
  { id: 137, name: 'Polygon', depthUsdt: 2_000_000 },
]

/** 预期毛收益 3%：DEX 往返光 LP 费就 60bps，再叠冲击与 gas，薄利机会本就不该走链上。 */
const EDGE_BPS = 300
/**
 * 名义取池深的 0.08% → 单腿冲击固定为 8bps，各链之间的差异只剩 gas 与 LP 费。
 *
 * 为什么不统一用一个固定金额：DEX 的「通道可用」本来就**依赖规模与池深匹配**。
 * 同一个 $5,000 单，砸进 Ethereum 的 $150M 池毫无感觉，
 * 砸进 Polygon 的 $2M 池要付 25bps 冲击，叠加 LP 费后成本是毛收益的 2.61 倍 ——
 * 被拒是**正确的经济结论**，不是通道坏了。
 *
 * 反过来说：在「成本超标直接拒绝」的当前策略下（有意不降级为最小可行规模），
 * 浅池链上的大额单本来就应该被拒。这条门禁要验证的是「通」，不是「一律放行」。
 */
const DEPTH_RATIO = 0.0008

function dexInput(chainId: DexChainId, notionalUsdt: number, depthUsdt: number) {
  return {
    channel: 'dex' as const,
    venue: `uniswap-v3@${chainId}`,
    notionalUsdt,
    expectedEdgeBps: EDGE_BPS,
    poolDepthUsdt: depthUsdt,
    chainGasUsdt: 1.2,
  }
}

console.log('\n【① 合约配置齐备性】')
check('五条链的 quoter/router/weth/usdc 齐备且地址格式合法', () => {
  for (const c of CHAINS) {
    const cfg = contractsByChain[c.id]
    assert.ok(cfg, `链 ${c.id}(${c.name}) 未配置`)
    for (const k of ['quoter', 'router', 'weth', 'usdc'] as const) {
      const v: string = cfg[k]
      assert.ok(
        /^0x[0-9a-fA-F]{40}$/.test(v),
        `${c.name}.${k} 地址非法：${v}`,
      )
    }
  }
})

console.log('\n【② 与池深匹配的规模下每条链都能走通】')
check('五条链在「池深匹配规模」下成本裁决全部 PASS', () => {
  for (const c of CHAINS) {
    const notional = Math.max(MIN_VIABLE_NOTIONAL_USDT, c.depthUsdt * DEPTH_RATIO)
    const a = assessEdge(dexInput(c.id, notional, c.depthUsdt))
    assert.equal(
      a.ok,
      true,
      `${c.name} 在 $${Math.round(notional)} 下被拒：[${a.verdict}] ${a.reason}`,
    )
  }
})

check('同一笔大额单在浅池链上被拒、在深池链上放行（规模必须与池深挂钩）', () => {
  const big = 50_000
  const shallow = assessEdge(dexInput(137, big, 2_000_000))
  const deep = assessEdge(dexInput(1, big, 150_000_000))
  assert.equal(shallow.ok, false, 'Polygon 浅池上的大额单竟放行')
  assert.equal(deep.ok, true, `Ethereum 深池上的大额单被拒：${deep.reason}`)
})

console.log('\n【③ 拒绝侧：②不是靠放宽阈值换来的】')
check('浅池 + 超额名义被正确拒绝（Polygon 池深 $2M 下砸 $500k）', () => {
  const a = assessEdge(dexInput(137, 500_000, 2_000_000))
  assert.equal(a.ok, false, `竟通过了：${JSON.stringify(a).slice(0, 200)}`)
})

check(`低于最小可行名义（$${MIN_VIABLE_NOTIONAL_USDT}）被拒`, () => {
  const a = assessEdge(dexInput(1, MIN_VIABLE_NOTIONAL_USDT - 1, 150_000_000))
  assert.equal(a.ok, false, '低于最小可行名义竟通过 —— 固定成本摊不开的交易不该放行')
})

check('薄利机会被拒：预期收益 20bps 覆盖不了 DEX 往返成本', () => {
  const a = assessEdge({ ...dexInput(8453, 20_000, 15_000_000), expectedEdgeBps: 20 })
  assert.equal(a.ok, false, '20bps 预期收益竟通过，说明成本没有真正参与裁决')
})

console.log('\n【④ 对手方准入 / 地址同源 / 结算域】')
check('五条链的 DEX 对手方均已登记，且判定不是 UNKNOWN_COUNTERPARTY', () => {
  const reg = getCounterpartyRegistry()
  for (const c of CHAINS) {
    const t = reg.assess(`uniswap-v3@${c.id}`)
    assert.notEqual(t.verdict, 'UNKNOWN_COUNTERPARTY', `${c.name} 的对手方未登记`)
  }
})

check('对手方登记的 router 地址与执行层 contractsByChain **同源**', () => {
  const reg = getCounterpartyRegistry()
  for (const c of CHAINS) {
    const rec = reg.get(`uniswap-v3@${c.id}`)
    assert.ok(rec, `${c.name} 对手方记录缺失`)
    assert.equal(
      rec.identity.contractAddress,
      contractsByChain[c.id].router,
      `${c.name} 对手方地址(${rec.identity.contractAddress}) 与执行层(${contractsByChain[c.id].router}) 不一致`,
    )
  }
})

check('同一符号 USDC 在五条链上是五个不同资产键（跨域不可相互抵扣）', () => {
  const keys = CHAINS.map((c) => assetKeyOf({ symbol: 'USDC', chainId: c.id }))
  assert.equal(new Set(keys).size, CHAINS.length, `资产键发生碰撞：${keys.join(', ')}`)
  assert.ok(!keys.includes(assetKeyOf({ symbol: 'USDC', chainId: null })), '链上 USDC 与 CEX 的 USDC 被当成了同一个资产')
})

console.log('\n【⑤ 阈值结构守护】')
check('往返 LP 费没有占满成本占比上限（否则 DEX 通道被结构性关闭）', () => {
  // 这条断言来自一次真实事故：MAX_COST_SHARE_BPS 曾被设成 60，
  // 恰好等于 DEX 往返 LP 费（30×2），于是**每一笔** DEX 交易都被判「成本占比过高」，
  // 而每条拒绝理由看起来都合理（「这一笔太贵了」），没有一条指向真因。
  const roundTripLp = DEX_LP_FEE_BPS * 2
  assert.ok(
    roundTripLp < MAX_COST_SHARE_BPS,
    `往返 LP 费 ${roundTripLp}bps 已用尽成本上限 ${MAX_COST_SHARE_BPS}bps，DEX 通道被静默关闭`,
  )
})

check('成本阈值之间的关系被显式记录（防止漂移成永不生效的死参数）', () => {
  const shareRoomBps = (MAX_COST_SHARE_BPS - DEX_LP_FEE_BPS * 2) / 2
  console.log(
    `      · 单腿冲击容许：成本占比口径 ${shareRoomBps}bps / 独立上限 ${DEX_MAX_PRICE_IMPACT_BPS}bps`,
  )
  if (DEX_MAX_PRICE_IMPACT_BPS > shareRoomBps) {
    console.log(
      `      · 注：独立上限更宽，因此实际约束来自成本占比口径 ——` +
        `DEX_MAX_PRICE_IMPACT_BPS 当前不会成为任何一笔交易的拒绝原因。` +
        `这是已知的口径重叠（待决，见 docs/SEAM-BENCHMARK.md），此处记录以防无声变化。`,
    )
  } else {
    console.log('      · 独立上限更紧，它是实际生效的那一道')
  }
  assert.ok(shareRoomBps > 0)
})

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] DEX CHANNEL SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`DEX CHANNEL SMOKE PASSED (${passed}/${passed})`)
