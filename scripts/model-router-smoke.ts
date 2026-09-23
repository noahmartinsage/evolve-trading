/**
 * 模型分层路由门禁 —— 贵/免费分层、智能降级、保守判定。
 *
 * 这一层最贵的错误不是"调不通"，而是**静默用付费模型烧钱**：
 * 它不出现在任何失败日志里，只在账单上出现。
 * 所以本文件的反例比重远大于正例。
 */

import assert from 'node:assert/strict'
import {
  __resetDeadModelsForTest,
  __resetPaidWindowForTest,
  isFreeModel,
  paidQuotaSnapshot,
  routeChat,
  routerConfigView,
} from '../server/modelRouter.ts'
import type { ActiveLlm } from '../server/llmProviders.ts'
import { envAccountSpecs, getActiveLlm, listProviders } from '../server/llmProviders.ts'
// ★ 账号池（第十七轮）：额度打满 ⇒ 换下一个账号。
//   `bindPoolStatePath` 在下面被指到临时目录 —— **烟测绝不许写真实 data/llm-pool.json**：
//   否则跑一次测试就把开发机上"某账号今天爆过"这件事写进生产状态（或反过来被它污染）。
import {
  __resetPoolForTest,
  bindPoolStatePath,
  isExhausted,
  nextDayStart,
  noteAccountFailure,
  QUOTA_RE,
} from '../server/llmPool.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERIFIED_TEXT_MODELS } from '../server/llmCatalog.ts'

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
  // ★ 账号额度记账也要清。不清的后果是**测试之间互相污染**：
  //   上一条断言喂了一个 429，账号就被记成"今天爆了"，
  //   下一条断言拿到的失败原因变成 `ACCOUNT_EXHAUSTED` 而不是它要测的那一种。
  //   实测就这么红过两条（"失败不许借给别的模型" / "过期失败不算证据"）。
  __resetPoolForTest()
}

// 池状态落到临时目录：测试的状态不是生产的性质。
bindPoolStatePath(join(tmpdir(), `evolve-pool-smoke-${process.pid}.json`))

console.log('\n── 分层路由 ──')

// ── 环境自举：模型通道必须在**任何入口**都可用，而不只是整服务启动时 ──────
//
// ★ 实测（2026-09-19）：环境里明明有 OPENROUTER_API_KEY、探针也真调通过，
//   桌宠却对每个开放问题都回「没有任何可用的大模型厂商」—— 因为自举原先只在
//   `server/index.ts` 的启动序列里跑一次。凡是**不经过那次启动**的入口
//   （烟测、探针脚本、CLI、桌宠独立进程）都拿不到厂商，于是看图 / 读文档 /
//   联网总结 / 开放提问全被卡死在同一句上。
//   这条断言钉的就是「读取侧也要自举」：只调 `listProviders()`，
//   不再显式调 `ensureEnvProvider()`。
//
// 环境变量放在这里设，是因为它必须早于**第一次** `getActiveLlm()`——自举是
// 一次性闸门，跑过之后再设 env 就不生效了，那样这条断言会假红。
process.env.EV_LLM_BASE_URL = 'https://env-bootstrap.invalid/v1'
process.env.EV_LLM_API_KEY = 'sk-env-bootstrap-smoke-0123456789'

await check('环境里配了凭据时，读取侧就会自举出可用厂商', () => {
  const envOne = listProviders().find((v) => v.baseUrl.startsWith('https://env-bootstrap.invalid'))
  assert.ok(envOne, '读取侧没有触发环境自举 —— 非服务入口（脚本 / 桌宠独立进程）会拿不到模型')
  assert.ok(
    VERIFIED_TEXT_MODELS.some((m) => m.id === envOne.activeModel),
    `自举必须选**已验证名单**里的模型，实际选了 ${envOne.activeModel ?? '（空）'} —— 名单外的名字曾经把我们引到一个 400 Model is unavailable`,
  )
  const active = getActiveLlm()
  assert.ok(active && active.model.length > 0, '自举之后 getActiveLlm() 仍为空')
})

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

console.log('\n── HTTP 非 200 的原因必须能走出这一层 ──')
//
// ★ 实测（2026-09-19）：三个免费视觉候选全败，桌宠回话写的是
//   "重跑探针能看出是哪一个名字烂掉了"；而探针给出的原文是
//   `HTTP 429 free-models-per-day` —— **额度打满，不是名字烂了**。
//   根因在这一层：`chatCompleteParts` 对上层只给一个 `null`，
//   路由于是把三种原因（429 额度 / 403 地区 / 404 名字）一律记成 `EMPTY_RESPONSE`。
//   两种事因长得一样，却把用户引向相反的动作（等额度 vs 换名单）。

await check('429 的原厂报错会被带进 attempt.reason', async () => {
  clearEnv()
  __resetDeadModelsForTest()
  setTier('execute', 'free-model-a:free,free-model-b:free')
  const clock = 1_000_000
  const r = recorder(() => null)
  const res = await routeChat('execute', 's', 'u', 0.7, {
    provider: PROVIDER,
    call: r.call,
    now: () => clock,
    lastHttpFailure: () => ({
      model: 'free-model-a:free',
      status: 429,
      snippet: 'Rate limit exceeded: free-models-per-day',
      at: clock - 500,
    }),
  })
  assert.equal(res.ok, false)
  const first = res.attempts.find((a) => a.model === 'free-model-a:free')
  assert.ok(/HTTP 429/.test(first?.reason ?? ''), `首个候选的 reason 丢了状态码：${first?.reason ?? '（空）'}`)
  assert.ok(
    /free-models-per-day/.test(first?.reason ?? ''),
    'reason 里没有原厂报错片段 —— 上层无法区分"额度用完"与"名字写错"',
  )
})

// ★ **配对断言**：同一个注入，但那条失败**不属于**当前候选，或者已经过期。
//   只留上面那一条的话，任何"无条件把最近一次失败带上去"的实现都会变绿（判据 6），
//   而那种实现会把 A 模型的 429 记到 B 模型头上 —— 于是探针查的是错的那一个。
await check('失败属于别的模型时不许借用（配对）', async () => {
  clearEnv()
  __resetDeadModelsForTest()
  setTier('execute', 'free-model-a:free,free-model-b:free')
  const clock = 1_000_000
  const r = recorder(() => null)
  const res = await routeChat('execute', 's', 'u', 0.7, {
    provider: PROVIDER,
    call: r.call,
    now: () => clock,
    lastHttpFailure: () => ({ model: 'some-other-model', status: 429, snippet: 'Rate limit exceeded', at: clock - 500 }),
  })
  const first = res.attempts.find((a) => a.model === 'free-model-a:free')
  assert.equal(first?.reason, 'EMPTY_RESPONSE', `把别的模型的失败安到了当前候选头上：${first?.reason ?? '（空）'}`)
})

await check('过期的失败也不算证据（时间窗配对）', async () => {
  clearEnv()
  __resetDeadModelsForTest()
  setTier('execute', 'free-model-a:free,free-model-b:free')
  const clock = 1_000_000
  const r = recorder(() => null)
  const res = await routeChat('execute', 's', 'u', 0.7, {
    provider: PROVIDER,
    call: r.call,
    now: () => clock,
    lastHttpFailure: () => ({
      model: 'free-model-a:free',
      status: 429,
      snippet: 'Rate limit exceeded',
      at: clock - 60_000,
    }),
  })
  const first = res.attempts.find((a) => a.model === 'free-model-a:free')
  assert.equal(first?.reason, 'EMPTY_RESPONSE', `把一分钟前的旧失败当成了本次的理由：${first?.reason ?? '（空）'}`)
})

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── 账号池：一个账号额度打满 ⇒ 换下一个账号 ──')
//
// 用户原话：「免费模型额度打满，一个免费模型额度打满换新的免费模型，我多给配一些账号」。
// 上一轮只做到"说清这是额度问题"（回话不再说"名字烂了"），这一轮要做到
// **换一个账号接着干**。下面每条都对应一次真实的失败模式。

/**
 * ★ 两个账号故意用**非 openrouter 的域名**：`catalogFor` 只对 openrouter 追加
 *   已验证名单，用真域名会让每个账号被撞 4~5 个模型，
 *   于是"到底换没换账号"这件事被埋在十几条尝试里（断言只能放宽到去重后比较，
 *   而放宽的断言抓不住"换了但换错了"）。用桩域名 ⇒ 每个账号只试它自己的模型。
 */
const A1: ActiveLlm = {
  id: 'acc-1',
  name: '账号甲',
  baseUrl: 'https://pool-stub.invalid/v1',
  apiKey: 'sk-aaaa1111',
  flavor: 'openai',
  model: 'free-model-a:free',
}
const A2: ActiveLlm = {
  id: 'acc-2',
  name: '账号乙',
  baseUrl: 'https://pool-stub.invalid/v1',
  apiKey: 'sk-bbbb2222',
  flavor: 'openai',
  model: 'free-model-a:free',
}
/** 注入一个"注册表里没有账号"的快照 —— 让池状态与跑测试那台机器无关。 */
const EMPTY_POOL = (): { total: number; ready: number; allExhausted: boolean; speech: string } => ({
  total: 0,
  ready: 0,
  allExhausted: false,
  speech: '',
})

await check('甲爆了 ⇒ 真的换到乙并成功，且说清用的是哪个账号', async () => {
  clearEnv()
  const clock = new Date('2026-09-19T14:00:00+08:00').getTime()
  const hits: string[] = []
  const res = await routeChat('execute', 's', 'u', 0.7, {
    accounts: [A1, A2],
    now: () => clock,
    call: async (active) => {
      hits.push(active.name)
      return active.name === '账号甲' ? null : '来自乙的回答'
    },
    lastHttpFailure: () => ({
      model: 'free-model-a:free',
      status: 429,
      snippet: 'Rate limit exceeded: free-models-per-day',
      at: clock - 100,
    }),
    noteFailure: (id, reason) => noteAccountFailure(id, reason, clock),
    poolSnapshot: EMPTY_POOL,
  })
  assert.equal(res.ok, true, `换账号之后应当成功，实际：${res.reason}`)
  assert.deepEqual(hits, ['账号甲', '账号乙'], `必须真的换到乙，实际打了：${hits.join(' → ')}`)
  assert.deepEqual(
    [...new Set(res.attempts.map((a) => a.account))],
    ['账号甲', '账号乙'],
    '尝试链里要能看出"从甲换到了乙"（attempts 带 account 列就是为了这个）',
  )
  assert.ok(/账号乙/.test(res.reason), `成功理由要说清用的是哪个账号：${res.reason}`)
  assert.equal(res.degraded, true, '换了账号必须标降级 —— 不标的话下游会以为是主通道给的答案')

  // ★ 配对半边：同一个账号**第二次**再问，绝不许再去撞一次已经爆掉的甲。
  hits.length = 0
  const again = await routeChat('execute', 's', 'u', 0.7, {
    accounts: [A1, A2],
    now: () => clock + 60_000,
    call: async (active) => {
      hits.push(active.name)
      return '再来一次'
    },
    noteFailure: (id, reason) => noteAccountFailure(id, reason, clock),
    poolSnapshot: EMPTY_POOL,
  })
  assert.equal(again.ok, true)
  assert.deepEqual(hits, ['账号乙'], `额度爆掉的账号当天不该再被撞：实际打了 ${hits.join(' → ')}`)
  const skipped = again.attempts.find((a) => /ACCOUNT_EXHAUSTED/.test(a.reason ?? ''))
  assert.equal(
    skipped?.account,
    '账号甲',
    '跳过爆掉的账号要留下 ACCOUNT_EXHAUSTED 记录 —— 否则事后只看到"少了一个候选"，看不出是额度问题',
  )
})

await check('额度按天复位：不是永久拉黑，也不是立刻重试', async () => {
  clearEnv()
  const t = new Date('2026-09-19T14:00:00+08:00').getTime()
  const until = nextDayStart(t)
  const d = new Date(until)
  assert.equal(d.getHours(), 0, '复位时刻必须是次日零点（额度是按天给的）')
  assert.equal(d.getMinutes(), 0, '复位时刻必须是整点零点')
  assert.equal(d.getDate(), 20, '复位发生在次日')
  noteAccountFailure('acc-x', 'HTTP 429 free-models-per-day', t)
  assert.equal(isExhausted('acc-x', t + 1000), true, '刚爆的账号当天必须是"别用它"')
  assert.equal(
    isExhausted('acc-x', until + 1000),
    false,
    '过了零点必须能再用 —— 否则等于永久拉黑一个**只是当天**爆了的账号（而额度次日就回来了）',
  )
})

await check('只有额度类失败才停用账号（网络抖动不该整天停用）', async () => {
  clearEnv()
  noteAccountFailure('acc-y', 'CALL_FAILED: socket hang up', Date.now())
  assert.equal(isExhausted('acc-y'), false, '网络抖动是临时的，按"当天"停用会把一条能用的通道白白闲置一整天')
  noteAccountFailure('acc-y', 'EMPTY_RESPONSE: HTTP 429 free-models-per-day', Date.now())
  assert.equal(isExhausted('acc-y'), true, '额度类失败必须停用 —— 这是"换账号"的触发条件')
})

await check('全爆 / 没配 / 注册表全爆是三种要分开说的话（配对）', async () => {
  clearEnv()
  const clock = 4_000_000
  // ① 注入的账号被逐个撞爆 ⇒ 额度那句
  const allDead = await routeChat('execute', 's', 'u', 0.7, {
    accounts: [A1, A2],
    now: () => clock,
    call: async () => null,
    lastHttpFailure: () => ({
      model: 'free-model-a:free',
      status: 429,
      snippet: 'Rate limit exceeded: free-models-per-day',
      at: clock - 100,
    }),
    noteFailure: (id, reason) => noteAccountFailure(id, reason, clock),
    poolSnapshot: EMPTY_POOL,
  })
  assert.ok(/ACCOUNTS_ALL_EXHAUSTED/.test(allDead.reason), `全爆必须给出 ACCOUNTS_ALL_EXHAUSTED：${allDead.reason}`)
  assert.ok(!/NO_PROVIDER/.test(allDead.reason), '全爆不许说成 NO_PROVIDER —— 那会把人引去"配厂商"，而厂商早就配好了')
  assert.ok(QUOTA_RE.test(allDead.reason), '全爆必须落进"额度类"，否则回话会让人去换模型名单（方向相反）')

  // ② 一个账号都没配 ⇒ 通道那句
  clearEnv()
  const none = await routeChat('execute', 's', 'u', 0.7, { provider: null, call: async () => 'never', poolSnapshot: EMPTY_POOL })
  assert.ok(/NO_PROVIDER/.test(none.reason), `没配账号要给 NO_PROVIDER：${none.reason}`)
  assert.ok(!/ACCOUNT_EXHAUSTED/.test(none.reason), '没配账号不许说成"额度爆了" —— 那会让人白等一天')

  // ③ 注册表里有账号、且它们全爆了（provider 为 null 但池子非空）
  clearEnv()
  const regAllDead = await routeChat('execute', 's', 'u', 0.7, {
    provider: null,
    call: async () => 'never',
    poolSnapshot: () => ({ total: 3, ready: 0, allExhausted: true, speech: '池子里 3 个账号的免费额度今天都用完了，明天会自动恢复。' }),
  })
  assert.ok(/ACCOUNTS_ALL_EXHAUSTED/.test(regAllDead.reason), '注册表里的账号全爆，也要给出额度那句（不能退化成 NO_PROVIDER）')
})

await check('用户加账号的入口：环境变量里多写一行就多一个账号', async () => {
  clearEnv()
  const r = envAccountSpecs({
    OPENROUTER_API_KEY: 'sk-or-v1-aaaaaaaaaaaa',
    OPENROUTER_API_KEY_2: 'sk-or-v1-bbbbbbbbbbbb',
    OPENROUTER_API_KEY_3: 'sk-or-v1-cccccccccccc',
  })
  assert.equal(r.specs.length, 3, `三个 key 应该认出三个账号，实际 ${r.specs.length}`)
  assert.deepEqual(
    r.specs.map((s) => s.name),
    ['OpenRouter', 'OpenRouter #2', 'OpenRouter #3'],
    '账号名要能区分是第几个 —— 播报里会说"现在用的是哪个账号"',
  )
  assert.equal(r.bad.length, 0, '正常配置不该报错')
  // 显式条目：可以指定 baseUrl 与首选模型
  const x = envAccountSpecs({
    EV_LLM_ACCOUNTS: '备用|https://openrouter.ai/api/v1|sk-or-v1-dddddddddddd|nex-agi/nex-n2.5-pro:free',
  })
  assert.equal(x.specs.length, 1)
  assert.equal(x.specs[0].model, 'nex-agi/nex-n2.5-pro:free', '显式条目可以指定首选模型')
  // 同一个 key 写两处，不该占两个账号位
  const dup = envAccountSpecs({
    OPENROUTER_API_KEY: 'sk-or-v1-aaaaaaaaaaaa',
    EV_LLM_ACCOUNTS: '重复|https://openrouter.ai/api/v1|sk-or-v1-aaaaaaaaaaaa',
  })
  assert.equal(dup.specs.length, 1, '同一个 key 出现两次只算一个账号')
  // ★ 写错的配置要**说出来**：安静吃掉会让用户以为"我明明配了"
  const bad = envAccountSpecs({ EV_LLM_ACCOUNTS: '字段不足|https://openrouter.ai/api/v1' })
  assert.equal(bad.specs.length, 0)
  assert.equal(bad.bad.length, 1, '写错的账号配置必须报出来')
})

clearEnv()

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] MODEL ROUTER SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`MODEL ROUTER SMOKE PASSED (${passed}/${passed})`)
