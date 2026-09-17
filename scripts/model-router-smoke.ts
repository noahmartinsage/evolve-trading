/**
 * 模型分层路由门禁 —— 贵/免费分层、智能降级、保守判定。
 *
 * 这一层最贵的错误不是"调不通"，而是**静默用付费模型烧钱**：
 * 它不出现在任何失败日志里，只在账单上出现。
 * 所以本文件的反例比重远大于正例。
 */

import assert from 'node:assert/strict'
import {
  __resetPaidWindowForTest,
  isFreeModel,
  paidQuotaSnapshot,
  routeChat,
  routerConfigView,
} from '../server/modelRouter.ts'
import type { ActiveLlm } from '../server/llmProviders.ts'

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const PROVIDER: ActiveLlm = {
  id: 'p1',
  name: 'stub',
  baseUrl: 'https://example.invalid',
  apiKey: 'k',
  flavor: 'openai',
  model: 'paid-default',
}

/** 记录每次调用用到的模型，便于断言"到底调了谁"。 */
function recorder(behavior: (model: string, n: number) => string | null): {
  calls: string[]
  call: (a: ActiveLlm) => Promise<string | null>
} {
  const calls: string[] = []
  return {
    calls,
    call: async (a: ActiveLlm) => {
      calls.push(a.model)
      return behavior(a.model, calls.length)
    },
  }
}

function setTier(tier: string, models: string): void {
  process.env[`EV_LLM_TIER_${tier.toUpperCase()}_MODELS`] = models
}

function clearEnv(): void {
  delete process.env.EV_LLM_TIER_PLAN_MODELS
  delete process.env.EV_LLM_TIER_EXECUTE_MODELS
  delete process.env.EV_LLM_TIER_PROBE_MODELS
  delete process.env.EV_LLM_ALLOW_PAID
  delete process.env.EV_LLM_PAID_HOURLY_CAP
  __resetPaidWindowForTest()
}

console.log('\n── 分层路由 ──')

await check('规划层按配置走贵模型，执行层走免费模型', async () => {
  clearEnv()
  setTier('plan', 'gpt-6-astra')
  setTier('execute', 'deepseek-v4-flash-free')
  process.env.EV_LLM_ALLOW_PAID = '1'
  process.env.EV_LLM_PAID_HOURLY_CAP = '10'

  const plan = recorder(() => 'plan-output')
  const r1 = await routeChat('plan', 's', 'u', 0.7, { provider: PROVIDER, call: plan.call })
  assert.equal(r1.ok, true)
  assert.equal(r1.model, 'gpt-6-astra')
  assert.deepEqual(plan.calls, ['gpt-6-astra'])

  const exec = recorder(() => 'exec-output')
  const r2 = await routeChat('execute', 's', 'u', 0.7, { provider: PROVIDER, call: exec.call })
  assert.equal(r2.model, 'deepseek-v4-flash-free')
  assert.equal(r2.degraded, false)
})

await check('降级链：首个候选失败则顺位到下一个，并标记 degraded', async () => {
  clearEnv()
  setTier('execute', 'a-free,b-free')
  const r = recorder((m) => (m === 'a-free' ? null : 'ok-from-b'))
  const res = await routeChat('execute', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  assert.equal(res.ok, true)
  assert.equal(res.model, 'b-free')
  assert.equal(res.degraded, true, '降级必须被标记，否则事后无法解释产出质量变化')
  assert.deepEqual(r.calls, ['a-free', 'b-free'])
})

await check('全部候选失败时返回完整尝试链（而不是只说失败）', async () => {
  clearEnv()
  setTier('execute', 'a-free')
  const r = recorder(() => null)
  const res = await routeChat('execute', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  assert.equal(res.ok, false)
  assert.ok(res.attempts.length >= 2, `尝试链过短：${res.attempts.length}`)
  assert.ok(res.attempts.every((a) => a.reason !== undefined), '失败的尝试必须带原因')
  assert.match(res.reason, /全部候选失败/)
})

await check('未启用厂商 → 明确失败，不虚构模型调用', async () => {
  clearEnv()
  const res = await routeChat('plan', 's', 'u', 0.7, { provider: null, call: async () => 'never' })
  assert.equal(res.ok, false)
  assert.match(res.reason, /NO_PROVIDER/)
  assert.equal(res.text, null)
})

console.log('\n── 保守判定：未识别即视为付费 ──')

await check('免费识别只认显式标记（认不出即付费）', () => {
  assert.equal(isFreeModel('deepseek-v4-flash-free'), true)
  assert.equal(isFreeModel('qwen:free'), true)
  assert.equal(isFreeModel('llama-local'), true)
  assert.equal(isFreeModel('gpt-6-astra'), false)
  // 关键：未知命名必须落在"付费"一侧。反向误判会静默烧钱且无任何日志。
  assert.equal(isFreeModel('some-brand-new-model-2026'), false)
})

await check('默认禁止付费：未开开关时付费候选被跳过并说明原因', async () => {
  clearEnv()
  const r = recorder(() => 'should-not-be-called')
  const res = await routeChat('plan', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  assert.equal(res.ok, false, '默认配置下不应使用付费模型')
  const paidAttempt = res.attempts.find((a) => a.model === 'paid-default')
  assert.ok(paidAttempt, '未对兜底模型做付费判定')
  assert.match(paidAttempt?.reason ?? '', /PAID_NOT_ALLOWED/)
  assert.deepEqual(r.calls, [], '付费模型被实际调用了')
})

await check('付费额度按小时滚动封顶，用尽后降级而不是继续花', async () => {
  clearEnv()
  process.env.EV_LLM_ALLOW_PAID = '1'
  process.env.EV_LLM_PAID_HOURLY_CAP = '2'
  setTier('plan', 'paid-a,x-free')
  let clock = 1_000_000
  const call = async (a: ActiveLlm): Promise<string | null> => a.model
  const deps = { provider: PROVIDER, call, now: () => clock }

  assert.equal((await routeChat('plan', 's', 'u', 0.7, deps)).ok, true)
  assert.equal(paidQuotaSnapshot(clock).used, 1)
  assert.equal((await routeChat('plan', 's', 'u', 0.7, deps)).ok, true)
  assert.equal(paidQuotaSnapshot(clock).used, 2)

  // 第三次：付费额度用尽 → 顺位到免费候选
  const third = await routeChat('plan', 's', 'u', 0.7, deps)
  assert.equal(third.model, 'x-free', `应降级到免费候选，实际 ${third.model}`)
  assert.equal(third.ok, true)

  // 付费候选被跳过的原因必须是额度，而不是别的
  const paidAttempt = third.attempts.find((a) => a.model === 'paid-a')
  assert.match(paidAttempt?.reason ?? '', /PAID_BUDGET_EXHAUSTED/)

  // 一小时后额度窗口滚动 → 付费可用
  clock += 3_600_001
  const after = await routeChat('plan', 's', 'u', 0.7, deps)
  assert.equal(after.model, 'paid-a', '额度窗口未滚动')
})

await check('探测层永远不占用付费额度', async () => {
  clearEnv()
  process.env.EV_LLM_ALLOW_PAID = '1'
  process.env.EV_LLM_PAID_HOURLY_CAP = '10'
  setTier('probe', 'paid-probe')
  const r = recorder(() => 'ok')
  const res = await routeChat('probe', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  const paidAttempt = res.attempts.find((a) => a.model === 'paid-probe')
  assert.match(paidAttempt?.reason ?? '', /PROBE_NEVER_PAID/)
  assert.equal(paidQuotaSnapshot().used, 0)
})

await check('配置写错模型名不会让链路失效（厂商激活模型永远兜底）', async () => {
  clearEnv()
  process.env.EV_LLM_ALLOW_PAID = '1'
  process.env.EV_LLM_PAID_HOURLY_CAP = '10'
  setTier('execute', 'typo-model-xyz')
  const r = recorder((m) => (m === 'paid-default' ? 'fallback-ok' : null))
  const res = await routeChat('execute', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  assert.equal(res.ok, true, '写错一个模型名就让整条链路不可用')
  assert.equal(res.model, 'paid-default')
  assert.equal(res.degraded, true)
  assert.deepEqual(r.calls, ['typo-model-xyz', 'paid-default'])
})

await check('默认禁付费时兜底候选仍在尝试链上但被跳过（可解释，而非静默缺席）', async () => {
  clearEnv()
  const r = recorder(() => 'should-not-be-called')
  const res = await routeChat('execute', 's', 'u', 0.7, { provider: PROVIDER, call: r.call })
  assert.equal(res.ok, false)
  assert.deepEqual(r.calls, [], '默认禁付费时付费兜底被实际调用')
  assert.ok(
    res.attempts.some((a) => a.model === 'paid-default' && /PAID_NOT_ALLOWED/.test(a.reason ?? '')),
    '兜底候选既未被调用、也未在尝试链上解释原因 —— 事后无法回答"为什么没成功"',
  )
})

await check('路由配置视图可供管理页展示（含额度快照）', () => {
  clearEnv()
  setTier('plan', 'gpt-6-astra')
  const view = routerConfigView()
  assert.equal(view.tiers.length, 3)
  assert.ok(view.tiers.some((t) => t.id === 'plan' && t.models.includes('gpt-6-astra')))
  assert.equal(view.allowPaid, false)
  assert.equal(view.paidHourlyCap, 0)
})

clearEnv()

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] MODEL ROUTER SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`MODEL ROUTER SMOKE PASSED (${passed}/${passed})`)
