/**
 * 三条红线的门禁（第十八轮，内化自 2026-09-19 日报 ①③⑤ 条）
 *
 * ── 为什么这三条要放进**同一道**门 ────────────────────────────────────
 * 它们有一个共同的形状：**机制已经存在，但"它还在不在"这件事没人管**。
 *   · 回测与纸面撮合**此刻**确实共用同一个撮合器（`PaperBroker` → `MatchingEngine`），
 *     但没有任何东西阻止下一个人在 `server/` 里另写一套成交价公式 ——
 *     那正是 ledger mismatch 的成因类型（回测与实盘代码路径不一致）；
 *   · 模型调用日志的核心是 append-only，它的失效方式很安静：
 *     有人在模块里加一个 `writeFileSync` 去"规整一下格式"，历史就没了；
 *   · 出网拦截的告警价值全在"被拦 vs 没通"这个区分上，
 *     合并回一类只需要删掉一个三元表达式。
 * 三条都是**删掉一处代码就会静默失效**的东西 —— 所以它们是断言，不是文档。
 *
 * ── 这道门不测什么（避免它变成维护负担）──────────────────────────────
 * 不测撮合的具体数值（`backtest:golden` 已经在测，重造是浪费），
 * 不真出网（`test:news` 与 `news:probe` 分工不同），不真调模型。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_EXEC } from '../src/engine/types.ts'
import { buildEntry, journalStats, readJournal, reconstruct, recordCall } from '../server/llmJournal.ts'
import { egressAudit, egressAuditNote, fetchPage, postJson } from '../server/net/egress.ts'
import { routeChat } from '../server/modelRouter.ts'
import { getEvents } from '../server/ledger.ts'
import { checkAndAlert, lastAlertWebhook } from '../server/slo.ts'
import type { ActiveLlm } from '../server/llmProviders.ts'
import type { MetricsSnapshot } from '../server/metrics.ts'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name} —— ${msg}`)
    console.log(`  ✗ ${name}\n      ${msg}`)
  }
}

const ROOT = process.cwd()
const TMP = join(ROOT, 'artifacts', `parity-smoke-${process.pid}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/**
 * 剥掉注释再扫。
 *
 * ★★★ 这一步是**必须**的，而且是被这道门自己逼出来的：
 *   第一版直接扫原文，于是 `llmJournal.ts` 的注释里那句
 *   「全模块只有 appendFileSync，没有任何 writeFileSync / rename / unlink」
 *   被当成了代码 —— 一条**对完全正确的实现**报红的断言（判据 2）。
 *   对正确的输入报错比不报错更费人：它会训练人把解释删掉，
 *   而不是去修被解释的东西。
 *
 * ★ 顺带记下本仓库反复踩的另一个坑：块注释里写 markdown 粗体**紧挨着**斜杠
 *   （粗体的结束标记后面直接跟一个斜杠）会让注释**提前闭合** —— 本文件的第一版
 *   就因为这个原因直接语法错。所以这里的剥除用非贪婪匹配到最近的结束标记，
 *   宁可少剥一段，也不要吞掉后面的真实代码。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/(\s)\/\/.*$/gm, '$1')
}

/** 读源码（已剥注释）。代码级断言一律用它。 */
function read(p: string): string {
  return stripComments(readFileSync(join(ROOT, p), 'utf8'))
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n── P1 同码：回测与纸面撮合必须是同一个撮合器 ──')
//
// 日报 ④ 的原话：「bit-exact 回测/实盘 —— 模拟不撒谎，所以回测好看的实盘也好看」。
// 它治的正是本仓库记过的 ledger mismatch：**回测与实盘代码路径不一致**。

await check('P1 纸面撮合器必须用引擎的撮合器（而不是自己写一套）', () => {
  const broker = read('src/engine/broker.ts')
  assert.ok(
    /from '\.\/matching\.ts'/.test(broker) && /new MatchingEngine\(/.test(broker),
    'src/engine/broker.ts 必须用 MatchingEngine —— 它一旦自己算成交价，"回测好看⇒实盘好看"这个推论就断了',
  )
})

await check('P1 所有 PaperBroker 的构造点必须用同一个配置来源（不许内联字面量）', () => {
  const hits: { file: string; arg: string }[] = []
  const scan = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        scan(rel)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      const src = read(rel)
      const re = /new PaperBroker\(([^)]*)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) hits.push({ file: rel, arg: m[1].trim() })
    }
  }
  for (const d of ['server', 'src', 'scripts']) scan(d)
  assert.ok(hits.length >= 3, `应当找到多个 PaperBroker 构造点（实测 ${hits.length} 个）—— 找不到说明扫描器坏了`)
  const inline = hits.filter((h) => h.arg.startsWith('{'))
  assert.deepEqual(
    inline.map((h) => h.file),
    [],
    '★ 内联的配置对象意味着各处可以有不同的费率/滑点 —— 那就不再是同一个市场假设，bit-exact 立刻失效',
  )
  assert.ok(
    hits.every((h) => /DEFAULT_EXEC|DEFAULT_GRID_EXEC|EXEC/.test(h.arg)),
    `构造参数必须是命名常量（同一个来源），实际：${hits.map((h) => `${h.file}(${h.arg})`).join(' / ')}`,
  )
})

await check('P1 摩擦不许是 0：零摩擦的回测就是在撒谎', () => {
  assert.ok(DEFAULT_EXEC.makerFeeBps > 0, 'maker 费率必须为正')
  assert.ok(DEFAULT_EXEC.takerFeeBps > 0, 'taker 费率必须为正')
  assert.ok(DEFAULT_EXEC.slippageBps > 0, '滑点必须为正')
  assert.ok(DEFAULT_EXEC.latencyBars >= 1, '延迟至少 1 根 K 线 —— 0 延迟意味着"看到收盘价就立刻成交"')
  // ★ 这条断言的边界要说清（不是补充说明，是判据的一部分）：
  //   bit-exact 只在 **paper 内部**成立（回测 ↔ 纸面撮合）。到 live 那一层，
  //   成交价由交易所给，同码不再可控 ⇒ 摩擦常量**对不对**只能靠实盘回执校准。
  //   把它写成断言只能保证"不是零摩擦"，保证不了"摩擦是真的"。
  console.log(
    `      （摩擦常量：maker ${DEFAULT_EXEC.makerFeeBps}bps / taker ${DEFAULT_EXEC.takerFeeBps}bps / ` +
      `滑点 ${DEFAULT_EXEC.slippageBps}bps / 延迟 ${DEFAULT_EXEC.latencyBars} bar —— 它们的**真实性**只能靠实盘回执校准）`,
  )
})

await check('P1 server/ 里不许自己实现成交价公式（两条路径就是隐患）', () => {
  const suspicious: string[] = []
  const scan = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        scan(rel)
        continue
      }
      if (!/\.ts$/.test(e.name)) continue
      const src = read(rel)
      // 在 server 层自己乘滑点的痕迹（引擎之外不该有第二处）
      if (/slippageBps\s*\*|feeBps\s*\*/.test(src)) suspicious.push(rel)
    }
  }
  scan('server')
  assert.deepEqual(suspicious, [], `这些文件在引擎之外自己算了成交价，回测/实盘立刻分叉：${suspicious.join('、')}`)
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n── P2 日志即事实源：凡到达模型的内容必须能重建 ──')
//
// 日报 ① 的原话：「Model-visible means logged —— 凡到达模型的内容必须可从日志重建；
// 已提交日志永不重命名/替换/删除」。

const ACCOUNT: ActiveLlm = {
  id: 'j-acc',
  name: '账号甲',
  baseUrl: 'https://journal-stub.invalid/v1',
  apiKey: 'sk-journal-1',
  flavor: 'openai',
  model: 'free-model-a:free',
}

await check('P2 一次成功调用 ⇒ 日志里有一条，且能逐字节重建当时的输入', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  const system = '你是 EVOLVE 的语音管家。'
  const prompt = '资金费率是怎么影响永续合约的？'
  const res = await routeChat('execute', system, prompt, 0.4, {
    accounts: [ACCOUNT],
    call: async () => '资金费率是多空之间的周期性支付。',
    journal: (e) => recordCall(TMP, e),
    poolSnapshot: () => ({ total: 1, ready: 1, allExhausted: false, speech: '' }),
  })
  assert.equal(res.ok, true, `前提：这次调用必须成功（${res.reason}）`)
  const entries = readJournal(TMP)
  assert.equal(entries.length, 1, `日志应当恰好有一条，实际 ${entries.length}`)
  const r = reconstruct(entries[0])
  assert.equal(r.status, 'ok', `必须能完整重建：${r.note}`)
  assert.equal(r.text, `${system}\n\n---\n\n${prompt}`, '★ 重建出来的文本必须与喂进去的**逐字节相同** —— 这是这条不变量的全部内容')
  assert.equal(entries[0].output, '资金费率是多空之间的周期性支付。', '模型的回复也要留档')
  assert.equal(entries[0].account, '账号甲', '要记清是哪个账号产出的（多账号池下这决定了额度归属）')
})

await check('P2 失败的调用也要留痕（否则日志会出现看不出缺口的洞）', async () => {
  const before = readJournal(TMP).length
  await routeChat('execute', 's', 'u', 0.4, {
    accounts: [ACCOUNT],
    call: async () => null,
    journal: (e) => recordCall(TMP, e),
    lastHttpFailure: () => null,
    poolSnapshot: () => ({ total: 1, ready: 1, allExhausted: false, speech: '' }),
  })
  const after = readJournal(TMP)
  assert.equal(after.length, before + 1, '失败也要写一条 —— 只记成功的日志会把"通道挂了的那段时间"整段抹掉')
  assert.equal(after[after.length - 1].ok, false)
})

await check('P2 记录被改过 ⇒ 报"完整性对不上"，不许静默当成正常', () => {
  const e = buildEntry({
    at: Date.now(),
    tier: 'execute',
    model: 'm',
    account: null,
    ok: true,
    reason: 'OK',
    system: '真系统',
    prompt: '真提问',
    output: '真回答',
    hadImages: false,
  })
  assert.equal(reconstruct(e).status, 'ok', '原样时应当可重建')
  const tampered = { ...e, prompt: '被换过的提问' }
  const r = reconstruct(tampered)
  assert.equal(r.status, 'mismatch', `★ 正文被改过必须报 mismatch，实际 ${r.status}`)
  assert.equal(r.text, null, '对不上的记录不许把正文交出去 —— 那等于把篡改过的内容当成取证材料')
})

await check('P2 截断与"对不上"必须分开说（两种事因、两个动作）', () => {
  const e = buildEntry({
    at: Date.now(),
    tier: 'execute',
    model: 'm',
    account: null,
    ok: true,
    reason: 'OK',
    system: 'x'.repeat(200_000),
    prompt: 'p',
    output: null,
    hadImages: false,
  })
  assert.equal(e.truncated, true, '超长输入必须被标记为截断')
  assert.ok(e.bytes.system > 100_000, `要记住原文的真实规模（实际 ${e.bytes.system}）`)
  const r = reconstruct(e)
  assert.equal(r.status, 'truncated', `截断不是完整性事故，要分开报，实际 ${r.status}`)
  assert.ok(/截断/.test(r.note), `说明里要讲清是截断：${r.note}`)
})

await check('P2 append-only 是机制化的：日志模块里没有改写/删除调用', () => {
  const src = read('server/llmJournal.ts')
  const banned = ['writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync']
  const found = banned.filter((b) => new RegExp(`\\b${b}\\b`).test(src))
  assert.deepEqual(found, [], `★ 日志模块里出现了会改写历史的调用：${found.join('、')} —— append-only 是这条不变量的全部价值所在`)
  // 对照半边：appendFileSync 必须**在**（否则上面那条可以被"什么都不写"满足）
  assert.ok(/appendFileSync/.test(src), '对照半边：它必须是靠 appendFileSync 写的')
})

await check('P2 日志读数把"条数/可重建/截断/对不上"四个数分开', () => {
  const s = journalStats(TMP)
  assert.ok(s.entries >= 2, `应当统计到至少 2 条，实际 ${s.entries}`)
  assert.equal(s.mismatch, 0, `正常写入不该有完整性事故，实际 ${s.mismatch}`)
  assert.ok(/可完整重建/.test(s.note), `读数要说人话：${s.note}`)
  const empty = journalStats(join(TMP, 'never-used'))
  assert.ok(/从来没记过/.test(empty.note), `"没有日志"与"日志是空的"要分开说：${empty.note}`)
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n── P3 出网：被拦与没通必须是两种事件 ──')
//
// 日报 ⑤ 的原话：「egress allowlist 且记录被拦截的调用（被拦的异常地址常是首个告警信号）」。

await check('P3 白名单外的域名 ⇒ EGRESS_BLOCKED', async () => {
  const before = egressAudit().blockedCount
  const r = await fetchPage('https://evil.example.invalid/steal')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'HOST_NOT_ALLOWED')
  const a = egressAudit()
  assert.equal(a.blockedCount, before + 1, '被拦必须落一条 EGRESS_BLOCKED')
  assert.equal(a.blocked[a.blocked.length - 1].host, 'evil.example.invalid')
})

await check('P3 解析到内网地址 ⇒ 也是被拦（这是 SSRF，不是网络问题）', async () => {
  const before = egressAudit().blockedCount
  const r = await fetchPage('https://example.com/probe', {
    // example.com 在白名单里，所以这一次拦它的是**地址判据**
    resolve: async () => ['169.254.169.254'],
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'PRIVATE_ADDRESS')
  assert.equal(egressAudit().blockedCount, before + 1, 'SSRF 拦截同样要落 BLOCKED —— 它比"域名不在名单里"更值得报警')
})

await check('P3 网络没通 ⇒ EGRESS_FAILED（不许混进 BLOCKED）', async () => {
  const beforeB = egressAudit().blockedCount
  const beforeF = egressAudit().failedCount
  const r = await fetchPage('https://example.com/ok', {
    fetchImpl: (() => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch,
  })
  assert.equal(r.ok, false)
  const a = egressAudit()
  assert.equal(a.failedCount, beforeF + 1, '网络失败要记成 FAILED')
  assert.equal(a.blockedCount, beforeB, '★ 网络失败**不许**记成被拦 —— 混在一起会让真正的告警被每天的抖动淹没')
})

await check('P3 读数要能回答"谁被拦得最多"，并对两种情形说不同的话', () => {
  const a = egressAudit()
  assert.ok(a.blockedCount > 0, '前提：上面几条已经制造了拦截')
  assert.equal(a.topBlockedHost, 'evil.example.invalid', `被拦最多的域名要是它，实际 ${a.topBlockedHost}`)
  assert.ok(/拦下/.test(a.note), `读数要说人话：${a.note}`)
  // 对照半边：一条拦截都没有时，说的必须是**另一句话**（否则"没人攻击"会读成"一直在攻击"）
  const clean = egressAuditNote(0, 3, null)
  const dirty = egressAuditNote(2, 0, 'evil.example.invalid')
  assert.notEqual(clean, dirty, '“没有拦截”与“有拦截”必须是两句不同的话')
  assert.ok(/从来没有/.test(clean), `干净时要说"从来没有"：${clean}`)
  assert.ok(/拦下 2 次/.test(dirty) && /evil.example.invalid/.test(dirty), `有拦截时要报条数与头号域名：${dirty}`)
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n── P3b 受控 POST：告警外发不许另开一条出网路径 ──')
//
// ★ 为什么这条 POST 值得单独一组断言
//   `ALERT_WEBHOOK_URL` 的目标主机**由环境变量给** —— 也就是"由配置决定的任意主机"。
//   而它送出去的是**系统内部事件**（SLO 违约细节、权益、拒绝率）：本仓库里
//   唯一一类"把内部数据送出去"的通道。
//   它坏掉的方式特别安静：只要有人图省事在调用点直接写 `fetch`，
//   白名单、SSRF 判据、账本记账三件事**一起消失**，而外表毫无变化。
//   （"调用点有没有用 fetch"这件事由 `lint:egress` + `egress-registry-check`
//    从源码层管；这一组管的是"这条通道自己的行为对不对"。）

/** 只声明我们真会去看的字段（`RequestInit['headers']` 是联合类型，直接索引过不了 tsc）。 */
interface CapturedPost {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  redirect?: string
}
type PostInit = { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: string }

/**
 * 造一个**注入用的假 fetch** —— 它一次真实请求都不会发。
 *
 * ★ 为什么收敛成一处，而不是每处写一遍 `as unknown as typeof fetch`：
 *   ① 写四遍的话，读的人会以为这一段在出网，其实全是替身；
 *   ② 出网登记册按 `typeof fetch` 计数，而那个计数是**刻意**的 ——
 *      `server/net/egress.ts` 里真正发请求的那一行就是 `opts.fetchImpl ?? fetch`，
 *      漏掉裸引用会让登记册得出"受控通道自己不出网"这个恰好相反的结论。
 *      集中成一处之后，登记册上只需要回答**一次**。
 */
const injectedFetch = (fn: (url: string, init: PostInit) => Promise<Response>) => fn as unknown as typeof fetch

await check('P3b POST 走的是同一份判据：解析到内网地址照样被拦，且请求**根本没发出去**', async () => {
  const beforeB = egressAudit().blockedCount
  const beforeF = egressAudit().failedCount
  let called = 0
  const r = await postJson('https://example.com/hook', { type: 'slo_breach' }, {
    resolve: async () => ['169.254.169.254'],
    fetchImpl: injectedFetch(() => {
      called += 1
      throw new Error('判据跑在了请求之后 —— 这一行不该被执行')
    }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'PRIVATE_ADDRESS')
  // ★ 这条是"判据在请求之前跑完"的唯一证据。判据挪到 fetch 之后，这里会变成 1，
  //   而其它断言全都还是绿的 —— 因为"被拦住了"这个结论本身没有变，
  //   变的是**SSRF 已经发生过了**。
  assert.equal(called, 0, '★ 三层判据必须在发请求之前跑完；跑在之后，拦不拦都已经晚了')
  const a = egressAudit()
  assert.equal(a.blockedCount, beforeB + 1, '被拦的 POST 同样要落 EGRESS_BLOCKED')
  assert.equal(a.failedCount, beforeF, '★ 被拦不许记成"没通"')
})

await check('P3b POST 的协议层与域名层判据与读路径完全一致', async () => {
  const bad1 = await postJson('file:///etc/passwd', { x: 1 })
  assert.equal(bad1.reason, 'SCHEME_NOT_ALLOWED', '协议白名单对 POST 同样有效')
  const bad2 = await postJson('https://evil.example.invalid/hook', { x: 1 })
  assert.equal(bad2.reason, 'HOST_NOT_ALLOWED')
  assert.match(bad2.note, /EV_EGRESS_HOSTS/, `被拦时要说清"怎么才能放行"，否则用户只会去查网络：${bad2.note}`)
})

await check('P3b POST 真的把 JSON 按 POST 送出去（"记了一笔"不等于"发出去了"）', async () => {
  const seen: CapturedPost[] = []
  const r = await postJson('https://example.com/hook', { type: 'slo_breach', n: 3 }, {
    resolve: async () => ['93.184.216.34'],
    fetchImpl: injectedFetch((url, init) => {
      seen.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect })
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  })
  assert.equal(r.ok, true, `这一次该成功：${r.note}`)
  assert.equal(seen.length, 1, '成功路径只许发一次请求')
  assert.equal(seen[0].method, 'POST')
  assert.match(String(seen[0].headers?.['content-type'] ?? ''), /application\/json/)
  // ★ 送上路的就是告警正文本身。这一条治的是"审计记了一笔、账本也留痕了，
  //   但正文压根没送出去"—— 保护单那一课的形状（观测点必须问到"真的进去了没有"）。
  assert.deepEqual(JSON.parse(String(seen[0].body)), { type: 'slo_breach', n: 3 }, '★ 送上路的必须是告警正文本身')
  assert.equal(r.note, 'example.com 已接收（HTTP 204）')
})

await check('P3b POST 不跟随重定向，且真的向底层要了 manual', async () => {
  let called = 0
  let sawRedirect: string | undefined
  const r = await postJson('https://example.com/hook', { type: 'slo_breach' }, {
    resolve: async () => ['93.184.216.34'],
    fetchImpl: injectedFetch((_url, init) => {
      called += 1
      sawRedirect = init.redirect
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com/elsewhere' } }))
    }),
  })
  assert.equal(r.ok, false, '3xx 对 POST 而言是失败，不是"再走一趟"')
  assert.equal(r.reason, 'HTTP_ERROR')
  assert.match(r.note, /不跟随重定向/, `要说清为什么不跟：${r.note}`)
  // ★ 配对半边一：跟随实现会再打一次 doFetch —— 这里必须恰好 1 次。
  assert.equal(called, 1, '★ 只有"没跟随"才会恰好只发一次')
  // ★ 配对半边二：上面那条用的是假 fetch，它**不会**替我们跟随，
  //   所以"删掉 redirect:manual"这件事它抓不到。抓它的是这一条。
  assert.equal(sawRedirect, 'manual', '★ 必须把 manual 传给底层；否则真实 fetch 会自己跟走，方法被降级成 GET、正文丢掉，而对端还回 200')
})

await check('P3b POST 没通 ⇒ EGRESS_FAILED（与"被拦"分开记账）', async () => {
  const beforeB = egressAudit().blockedCount
  const beforeF = egressAudit().failedCount
  const r = await postJson('https://example.com/hook', { type: 'slo_breach' }, {
    resolve: async () => ['93.184.216.34'],
    fetchImpl: injectedFetch(() => {
      throw new Error('socket hang up')
    }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'HTTP_ERROR')
  const a = egressAudit()
  assert.equal(a.failedCount, beforeF + 1, '没通要记成 FAILED')
  assert.equal(a.blockedCount, beforeB, '★ 没通不许记成被拦 —— 两类混在一起，真告警会被日常抖动淹没')
})

// ═══════════════════════════════════════════════════════════════════════
console.log('\n── P3c 告警通道：三种结局各自说得清 ──')

/** 告警外发的落盘条数。用「先清零再比绝对值」的写法（判据 C2：截断会让恒等式骗人）。 */
const countHookEvents = () => getEvents(0).filter((e) => e.kind === 'SLO_ALERT_WEBHOOK').length

/**
 * 造一个**只在一个指标上违约**的快照。
 *
 * ★ 为什么要这么抠：`checkAndAlert` 对同一条 breached key 有 10 分钟冷却，
 *   第二次调用**不会真的外发**（那是它的正确行为）。想连测两条出口路径，
 *   只能让两次触发落在**不同的 key** 上 —— 否则第二段断言其实什么都没测到，
 *   而它看起来还是绿的（判据 B1：这条输入只有它能命中吗）。
 */
function baseSnap(): MetricsSnapshot {
  return {
    uptimeSec: 1,
    ts: Date.now(),
    orders: {
      acked: 10,
      rejected: 0,
      rejectTopReasons: [],
      ackLatencyMs: { p50: 100, p95: 200, p99: 900, max: 900, samples: 10 },
    },
    fills: { paper: 0, live: 0 },
    cancels: 0,
    killswitchActivations: 0,
    feed: [{ symbol: 'BTCUSDT', lastBarAgeSec: 1 }],
    wsClients: 0,
    events: { memoryCount: 0 },
    gateway: {
      adapterAttached: false,
      adapterName: '',
      handshakeComplete: false,
      killswitch: false,
      queued: 0,
      processedFills: 0,
      drainedDuplicates: 0,
    },
  }
}
/** 违约在 `ackP99Ms`（900 > 300）。 */
function snapAckBreach(): MetricsSnapshot {
  return baseSnap()
}
/** 违约在 `feedStalenessSec`（900 > 120），ack 已经正常。 */
function snapFeedBreach(): MetricsSnapshot {
  const s = baseSnap()
  s.orders.ackLatencyMs = { p50: 1, p95: 2, p99: 3, max: 4, samples: 10 }
  s.feed = [{ symbol: 'BTCUSDT', lastBarAgeSec: 900 }]
  return s
}

await check('P3c 没配 webhook ⇒ 说"没配"，落一条盘，且返回体里的结果就是**这一次**的', async () => {
  const saved = process.env.ALERT_WEBHOOK_URL
  try {
    delete process.env.ALERT_WEBHOOK_URL
    const beforeHook = countHookEvents()
    const ev = await checkAndAlert(snapAckBreach())
    assert.ok(ev.breaches.some((b) => b.key === 'ackP99Ms'), '前提：这一份快照确实违约')
    const w = lastAlertWebhook()
    assert.ok(w, '★ checkAndAlert 之后必须能读到"发出去没有" —— 只写 console 的话，重定向一关就没了')
    assert.equal(w.outcome, 'not-configured')
    assert.match(w.note, /ALERT_WEBHOOK_URL/, `要说清缺的是哪个配置：${w.note}`)
    // ★ 这一条治的是"没配"曾经是唯一不留痕的一种结局：不落盘的话，事后翻账本
    //   看到的"什么都没有"与"系统一直很健康"完全一样，而它其实是**所有告警都只在控制台里**。
    assert.equal(countHookEvents(), beforeHook + 1, '★ "没配 webhook"也必须留痕，一次一条')
    // ★ 这条断言只能证明"没配"这一档也把状态填上了。它**抓不到**"慢一拍" ——
    //   因为 not-configured 分支是**同步**赋值的，`void sendWebhook` 也照样赋值成功。
    //   真正能抓"慢一拍"的是下面那条 blocked（它前面有一次 await）。
    assert.ok(ev.alertWebhook, '返回体里必须带上这次外发的结局（哪怕是"没配"）')
    assert.equal(ev.alertWebhook?.outcome, 'not-configured')
  } finally {
    if (saved === undefined) delete process.env.ALERT_WEBHOOK_URL
    else process.env.ALERT_WEBHOOK_URL = saved
  }
})

await check('P3c webhook 域名不在白名单 ⇒ 说"被拦"并指到 EV_EGRESS_HOSTS（不是笼统的"发送失败"）', async () => {
  const saved = process.env.ALERT_WEBHOOK_URL
  try {
    // 换一个违约 key（见 baseSnap 的说明）：同一条 key 会被冷却挡下，测了个寂寞
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.invalid/slo'
    const beforeHook = countHookEvents()
    const ev = await checkAndAlert(snapFeedBreach())
    assert.ok(ev.breaches.some((b) => b.key === 'feedStalenessSec'), '前提：这一份快照确实违约（且是另一条 key）')
    // ★ "慢一拍"的探测器，**刻意放在最前面**：`check()` 只报第一条失败，
    //   排在别条后面的话会被短路掉，于是"它到底有没有牙"就无从判断（实测踩过）。
    //   这一档前面有一次 `await postJson`，所以 `void sendWebhook(fresh)` 时
    //   这里读到的是**上一次**的结局（实测：读到 not-configured，
    //   而这条通道刚刚才被白名单拦下）。
    assert.equal(ev.alertWebhook?.outcome, 'blocked', '★ 返回体里的告警结果必须是**这一次**外发的结果，不是上一次的')
    const w = lastAlertWebhook()
    assert.ok(w)
    assert.equal(w.outcome, 'blocked', `被白名单拦下要单独成一类，实际 ${w.outcome}：${w.note}`)
    assert.match(w.note, /EV_EGRESS_HOSTS/, `★ 被拦时要人**改配置**；说成"发送失败"会把人打发去查网络：${w.note}`)
    // 配对半边：被拦的这一次**也要**落一条，且账本里记的结局与读数一致（两处不许各说各的）
    assert.equal(countHookEvents(), beforeHook + 1, '被拦的这一次同样要落一条')
    const last = getEvents(0).filter((e) => e.kind === 'SLO_ALERT_WEBHOOK').pop()?.payload as Record<string, unknown>
    assert.equal(String(last.outcome), 'blocked', '账本里的结局要与 `lastAlertWebhook()` 一致')
    assert.match(String(last.host), /hooks\.example\.invalid/)
  } finally {
    if (saved === undefined) delete process.env.ALERT_WEBHOOK_URL
    else process.env.ALERT_WEBHOOK_URL = saved
  }
})

// 清理：临时目录，删失败不影响结论
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] PARITY SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `PARITY SMOKE PASSED (${passed}/${passed}) · 同码 ${DEFAULT_EXEC.takerFeeBps}bps taker · 日志与账本事件 ${getEvents(0).length} 条`,
)
