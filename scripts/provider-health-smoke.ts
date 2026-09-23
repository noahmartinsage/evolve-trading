/**
 * 厂商体检判据烟测（第十八轮）
 *
 * ── 这一道门在防什么 ──────────────────────────────────────────────────
 * `providerHealth.decideProvider()` 的输出会**改厂商的 enabled** ——
 * 也就是"关掉一条可能还活着的通道"。它错了不会报错，只会安静地少一条路。
 * 所以它必须被断言，而且断言要选**只有那个判决才会命中**的输入。
 *
 * 最要紧的一组是 D4/D5/D6：额度用完、网络不通、名字下线这三种
 * 在"一个都回不来"这个观察面上完全一样，但**都不该停用**。
 * 如果把其中任何一种做成 disable，本机换个网络就能把一家好厂商关掉
 * 且毫无提示（判据 2：会不会对正确的输入报错）。
 *
 * ── 为什么不真出网 ────────────────────────────────────────────────────
 * 全部注入样本。真出网的断言会在没网/被限流时把红色喂给一个完全正确的实现；
 * 真实出网留给 `scripts/provider-reset.ts`（刻意不进 CI）。
 */
import assert from 'node:assert/strict'

import {
  classifyProbe,
  decideProvider,
  disableStatus,
  pruneDeadModels,
  renderVerdict,
  type ProbeSample,
  type ProbeClass,
} from '../server/providerHealth.ts'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name} —— ${msg}`)
    console.log(`  ✗ ${name}\n      ${msg}`)
  }
}

/** 拿到响应的样本。 */
function http(model: string, status: number, body: string, ms = 500): ProbeSample {
  return { model, responded: true, status, body, ms }
}
/** 真答上来的样本（2xx 且解析出了正文）。 */
function okSample(model: string, ms: number): ProbeSample {
  return { model, responded: true, status: 200, body: '1+1=2。', ms, hasContent: true }
}
/** HTTP 200 但没正文 —— 哑的成功，不算可用。 */
function silentOk(model: string, ms = 800): ProbeSample {
  return { model, responded: true, status: 200, body: 'HTTP 200 但没有正文（返回体结构不认识）', ms, hasContent: false }
}
/** 连响应都没拿到的样本。 */
function down(model: string, netError = 'fetch failed', ms = 30000): ProbeSample {
  return { model, responded: false, netError, ms }
}

// 下面这几段正文是**真实抓到的原文**（2026-09-19 探针输出），不是编的。
const REAL_403_POLICY =
  '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}'
const REAL_400_GONE = '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}'
const REAL_402_FUNDS = '{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}'
const REAL_429_QUOTA =
  '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free models per day"}}'
/**
 * 真实抓到的 404 原文（2026-09-23，OpenRouter 的
 * `deepseek/deepseek-v4-flash-0731:free`）。
 *
 * ★ 它的措辞是**定价变了**而不是"这个模型没了" —— 同一个 slug 的**付费版**
 *   正在被推荐。但对本系统而言结论一样：`...:free` 这个字符串**再也不会成功**，
 *   所以它该离开名单。这一条正是"名单腐烂"里最容易被漏掉的一种：
 *   `models_json` 是厂商自报的，它照样列着这个名字。
 */
const REAL_404_FREE =
  '{"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash-0731","code":404}}'

console.log('厂商体检判据烟测')
console.log('')

// ───────────────────────── 组 1：分类器 ─────────────────────────
check('C1 真实 403 FreeTierError 原文 ⇒ 厂商政策', () => {
  assert.equal(classifyProbe(http('m', 403, REAL_403_POLICY)), 'policy')
})
check('C2 真实 400 Model is unavailable 原文 ⇒ 名字已下线', () => {
  assert.equal(classifyProbe(http('m', 400, REAL_400_GONE)), 'model-gone')
})
check('C3 402 Insufficient account funds ⇒ 余额不足（不是额度用完）', () => {
  assert.equal(classifyProbe(http('m', 402, REAL_402_FUNDS)), 'no-funds')
})
check('C4 429 free-models-per-day ⇒ 额度用完', () => {
  assert.equal(classifyProbe(http('m', 429, REAL_429_QUOTA)), 'quota')
})
check('C5 没拿到响应 ⇒ 网络没通（responded=false 才是唯一判据）', () => {
  assert.equal(classifyProbe(down('m')), 'network')
})
// ★ 专属输入：只有这一条会把"403"与"限流"撞在一起。若分类器先按状态码判，
//   它会被错记成"厂商政策"，判决就从"等额度"变成"停用它"。
check('C6 403 但正文是限流 ⇒ 额度用完（状态码不许顶替正文）', () => {
  assert.equal(classifyProbe(http('m', 403, 'Rate limit exceeded, please retry later')), 'quota')
})
check('C7 403 但正文佐证不了任何原因 ⇒ 认不出来（不硬塞原因）', () => {
  assert.equal(classifyProbe(http('m', 403, '{"detail":"nope"}')), 'unknown')
})
check('C8 200 但没有正文 ⇒ 认不出来（哑的成功不算可用）', () => {
  assert.equal(classifyProbe(silentOk('m')), 'unknown')
})

// ───────────────────────── 组 2：判决 ─────────────────────────
check('D1 有能用的 ⇒ 换模型，且选延迟最低的那一个', () => {
  const v = decideProvider('甲家', [okSample('slow-model', 9000), okSample('fast-model', 400)])
  assert.equal(v.kind, 'switch-model')
  assert.equal(v.model, 'fast-model', '两个都能用时必须选快的那个')
  assert.ok(/不用停用/.test(v.speech), v.speech)
})
check('D2 全是厂商政策拒绝 ⇒ 停用，且话说出"政策"', () => {
  const v = decideProvider('甲家', [http('a-free', 403, REAL_403_POLICY), http('b-free', 403, REAL_403_POLICY)])
  assert.equal(v.kind, 'disable')
  assert.ok(/政策/.test(v.speech), v.speech)
})
check('D3 全是余额不足 ⇒ 停用，且话说出"余额"（指向的动作与政策不同）', () => {
  const v = decideProvider('甲家', [http('claude-x', 402, REAL_402_FUNDS), http('gpt-y', 402, REAL_402_FUNDS)])
  assert.equal(v.kind, 'disable')
  assert.ok(/余额/.test(v.speech), v.speech)
})
// ★ 下面三条是这道门真正的价值：三种"一个都回不来"**都不许停用**。
//
// ★★ 这里刻意**不用** `/停用/` 当负向断言 —— 本分支的文案里就写着
//    "不用停用它"/"不是停用"，那是一条**对正确输出报错**的断言
//    （判据 30：选的那个词会不会在本分支里以否定形式出现）。
//    所以改成选**只有停用那一支才会出现的动作词**"换名字救不了"。
const ONLY_DISABLE_BRANCH = /换名字救不了/
check('D4 全是额度用完 ⇒ 保留等复位，不许停用', () => {
  const v = decideProvider('甲家', [http('m1', 429, REAL_429_QUOTA), http('m2', 429, REAL_429_QUOTA)])
  assert.equal(v.kind, 'keep')
  assert.ok(/额度/.test(v.speech), v.speech)
  assert.ok(/零点|明天/.test(v.speech), `要说清什么时候自己会好：${v.speech}`)
  assert.ok(!ONLY_DISABLE_BRANCH.test(v.speech), `等额度的话里不许出现"停用"那一支的说法：${v.speech}`)
})
check('D5 一个请求都没通 ⇒ 保留，且话说出是网络（本机问题不当成厂商问题）', () => {
  const v = decideProvider('甲家', [down('m1'), down('m2')])
  assert.equal(v.kind, 'keep')
  assert.ok(/网络/.test(v.speech), v.speech)
  assert.ok(/查网络/.test(v.speech), `要说清下一步做什么：${v.speech}`)
  assert.ok(!ONLY_DISABLE_BRANCH.test(v.speech), `网络问题不许走到"停用"那一支：${v.speech}`)
})
check('D6 全是名字已下线 ⇒ 保留去换名字，不许停用', () => {
  const v = decideProvider('甲家', [http('m1', 400, REAL_400_GONE), http('m2', 400, REAL_400_GONE)])
  assert.equal(v.kind, 'keep')
  assert.ok(/名单|名字/.test(v.speech), v.speech)
  assert.ok(!ONLY_DISABLE_BRANCH.test(v.speech), `名单腐烂不等于厂商死了：${v.speech}`)
})
check('D7 一个样本都没有 ⇒ 保留，而且明说"没有证据"', () => {
  const v = decideProvider('甲家', [])
  assert.equal(v.kind, 'keep', '缺证据时不动作 —— 停用会把可能还活着的通道关掉')
  assert.ok(/没动它/.test(v.speech), v.speech)
  assert.ok(/证据/.test(v.speech), v.speech)
})
check('D8 政策失败 + 网络失败混着 ⇒ 仍判停用（拿到过响应就证明网是通的）', () => {
  const v = decideProvider('甲家', [http('a-free', 403, REAL_403_POLICY), down('b-free')])
  assert.equal(v.kind, 'disable', '网络类是"没拿到响应"；有 403 就说明网通，不该被网络类带偏')
})
check('D9 只要有一个能用 ⇒ 就不许停用（哪怕其余全是政策拒绝）', () => {
  const v = decideProvider('甲家', [
    http('a-free', 403, REAL_403_POLICY),
    http('b-free', 403, REAL_403_POLICY),
    okSample('c-free', 700),
  ])
  assert.equal(v.kind, 'switch-model')
  assert.equal(v.model, 'c-free')
})

// ─────────────────── 组 3：判决要能被自己解释 ───────────────────
check('D10 两种事因的动作必须相反（判据 24：长得一样，动作不同）', () => {
  const policy = decideProvider('甲家', [http('a', 403, REAL_403_POLICY)])
  const quota = decideProvider('甲家', [http('a', 429, REAL_429_QUOTA)])
  assert.notEqual(policy.kind, quota.kind, '"厂商政策"与"额度用完"不许给出同一个动作')
})
check('D11 都判停用，但两条话必须不一样（政策 vs 余额）', () => {
  const a = decideProvider('甲家', [http('a', 403, REAL_403_POLICY)])
  const b = decideProvider('甲家', [http('a', 402, REAL_402_FUNDS)])
  assert.equal(a.kind, b.kind)
  assert.notEqual(a.speech, b.speech, '都停用，但一个让人别再试、一个让人去充值')
})
check('D12 tally 之和等于样本数（判决能被它自己的计数解释）', () => {
  const samples = [http('a', 403, REAL_403_POLICY), http('b', 400, REAL_400_GONE), down('c'), okSample('d', 100)]
  const v = decideProvider('甲家', samples)
  const sum = (Object.values(v.tally) as number[]).reduce((x, y) => x + y, 0)
  assert.equal(sum, samples.length)
  const kinds: ProbeClass[] = ['ok', 'policy', 'no-funds', 'quota', 'model-gone', 'network', 'unknown']
  for (const k of kinds) assert.equal(typeof v.tally[k], 'number', `tally 少了 ${k} 这一类`)
})
check('D13 每条证据都指到具体模型（不是一句"全挂了"）', () => {
  const v = decideProvider('甲家', [http('alpha-free', 403, REAL_403_POLICY), http('beta-free', 400, REAL_400_GONE)])
  assert.equal(v.evidence.length, 2)
  assert.ok(v.evidence[0].includes('alpha-free'), v.evidence[0])
  assert.ok(v.evidence[1].includes('beta-free'), v.evidence[1])
})
check('D14 停用结论带日期（可核对，不是一句无期限的判决）', () => {
  const v = decideProvider('甲家', [http('a', 403, REAL_403_POLICY)])
  const s = disableStatus(v, '2026-09-19')
  assert.ok(s.includes('2026-09-19'), s)
  assert.ok(s.includes('DISABLED'), s)
})
check('D15 每一条给人听的话都不含 markdown 星号（同一句会被语音念出来）', () => {
  const cases: ProbeSample[][] = [
    [okSample('a', 100)],
    [http('a', 403, REAL_403_POLICY)],
    [http('a', 402, REAL_402_FUNDS)],
    [http('a', 429, REAL_429_QUOTA)],
    [down('a')],
    [http('a', 400, REAL_400_GONE)],
    [],
    [http('a', 403, '{"detail":"nope"}')],
  ]
  for (const c of cases) {
    const v = decideProvider('甲家', c)
    assert.ok(!/[*`#]/.test(v.speech), `话里不许有 markdown 记号：${v.speech}`)
  }
})
check('D16 排版能一次看全判决与证据（控制台/面板共用一份）', () => {
  const v = decideProvider('甲家', [http('a-free', 403, REAL_403_POLICY), http('b-free', 429, REAL_429_QUOTA)])
  const lines = renderVerdict('甲家', v)
  assert.ok(lines[0].includes('甲家'), lines[0])
  assert.ok(lines.some((l) => l.includes('厂商政策拒绝 1')), lines.join(' | '))
  assert.ok(lines.some((l) => l.includes('额度用完 1')), lines.join(' | '))
  assert.ok(lines.some((l) => l.includes('a-free')), '证据要出现在排版里')
})

// ─────────────────── 组 4：名字级修剪（P1–P7）───────────────────
// 这一组防的是什么：`pruneDeadModels` 会**真的删掉名单里的一行**。
// 删错一行的代价是"一条本来能用的路被永久静默删掉"，而且没有任何报错。
// 所以每一条断言都要有一个**只有它才会命中**的输入（判据 B1）。

check('P1 真实 404「不再免费」原文确实被判成名字已下线（修剪的前提）', () => {
  assert.equal(classifyProbe(http('m:free', 404, REAL_404_FREE)), 'model-gone')
  assert.equal(classifyProbe(http('m:free', 404, '{"error":{"message":"Not Found"}}')), 'model-gone')
})
check('P2 P1 的那个名字会被摘掉，且只摘它一个', () => {
  const all = ['good/a:free', 'deepseek/deepseek-v4-flash-0731:free', 'good/b:free']
  const r = pruneDeadModels(all, [http('deepseek/deepseek-v4-flash-0731:free', 404, REAL_404_FREE)])
  assert.deepEqual(r.removed, ['deepseek/deepseek-v4-flash-0731:free'], JSON.stringify(r))
  assert.deepEqual(r.kept, ['good/a:free', 'good/b:free'], JSON.stringify(r.kept))
  assert.equal(r.emptied, false)
})
// ★ 配对断言（判据 A1）：下面是"不许被摘"的四类，它们**都会自己恢复**。
//   少了这一条，一个"什么都摘"的实现能让 P2 照样绿。
check('P3 额度用完 / 网络不通 / 余额不足 / 厂商政策 —— 四类一律不摘', () => {
  const all = ['a', 'b', 'c', 'd']
  const r = pruneDeadModels(all, [
    http('a', 429, REAL_429_QUOTA),
    down('b'),
    http('c', 402, REAL_402_FUNDS),
    http('d', 403, REAL_403_POLICY),
  ])
  assert.deepEqual(r.removed, [], JSON.stringify(r))
  assert.deepEqual(r.kept, all, JSON.stringify(r.kept))
})
// ★ 只有它能命中：探测用的**付费档名字**本来就不在 `models_json` 里。
//   不过滤的话 `removed` 会报出一个从未存在过的名字，而那句话会被写进
//   `last_status` 让人照着核对 —— 一个假事实。
check('P4 不在名单里的名字不许出现在 removed 里（否则留痕是假话）', () => {
  // ★ 名单**必须留一个活的**：只放一个死名会走进 `emptied` 分支（见 P5），
  //   那时 `removed` 恒为空 —— 这条断言就变成了在验另一件事（判据 D9）。
  const all = ['only/this:free', 'keeper/x:free']
  const r = pruneDeadModels(all, [
    http('paid/not-in-list', 404, REAL_404_FREE),
    http('only/this:free', 404, REAL_404_FREE),
  ])
  assert.deepEqual(r.removed, ['only/this:free'], JSON.stringify(r))
  assert.deepEqual(r.kept, ['keeper/x:free'], JSON.stringify(r.kept))
})
// ★ 全死 ≠ 摘空。空名单会让这个账号"连一个候选名字都没有"，
//   而恢复它要人去手工补名单；留着死名只是每天多一次失败尝试。
check('P5 名单会被摘空时，一份都不摘（emptied 单独成档）', () => {
  const all = ['x:free', 'y:free']
  const r = pruneDeadModels(all, [http('x:free', 404, REAL_404_FREE), http('y:free', 404, REAL_404_FREE)])
  assert.equal(r.emptied, true)
  assert.deepEqual(r.removed, [], JSON.stringify(r))
  assert.deepEqual(r.kept, all, '摘空时必须退回原名单')
})
check('P6 修剪不许摘掉判决刚选中的那个名字（两个集合不相交）', () => {
  const all = ['good:free', 'dead:free']
  const samples = [okSample('good:free', 320), http('dead:free', 404, REAL_404_FREE)]
  const v = decideProvider('甲家', samples)
  assert.equal(v.kind, 'switch-model')
  assert.equal(v.model, 'good:free')
  const r = pruneDeadModels(all, samples)
  assert.ok(!r.removed.includes(v.model as string), `修剪把刚选中的名字摘掉了：${JSON.stringify(r)}`)
})
check('P7 一个样本都没有时什么都不摘（缺证据 ≠ 名字死了）', () => {
  const all = ['a', 'b']
  const r = pruneDeadModels(all, [])
  assert.deepEqual(r.removed, [], JSON.stringify(r))
  assert.equal(r.emptied, false, '没有观测时不该报 emptied —— 那是"全下线"，不是"没证据"')
})

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] PROVIDER HEALTH SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`PROVIDER HEALTH SMOKE PASSED (${passed}/${passed}) · 三种"一个都回不来"里 2 种判保留 · 停用只在有响应且可归因时给出 · 修剪只摘"名字已下线"，额度/网络/余额/政策四类一律不摘`)
