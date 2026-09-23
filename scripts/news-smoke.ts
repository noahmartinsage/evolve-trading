/**
 * 新闻雷达烟测（第十八轮）
 *
 * ── 为什么必须有这一道门，而不是靠"跑一次看看" ────────────────────────
 * 「定时读新闻 + 主动学习内化」这条链上有三个独立的失败模式，
 * 而且它们在**最终输出上长得一样**（都是"今天学了点东西/没学东西"）：
 *   ① 源挂了（网不通 / 被白名单拒）—— 要改网络或白名单
 *   ② 判据全放行或全拦（阈值/词表错）—— 要改判据
 *   ③ 模型那一步没读懂（输出不是格式）—— 要重试或改提示词
 * 所以下面每一组断言都把这三件事**分别**喂一个只有它才会命中的输入（判据 3）。
 *
 * ── 为什么全部注入、一次网络都不真出 ──────────────────────────────────
 * 判据 2：会随环境变色的断言比没有断言更费人。真出网的烟测在没网/被限流时
 * 会把红色喂给一个**完全正确**的实现。真实出网留给手工探针（`news:probe`）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  appendNewsVerdict,
  countTicker,
  internalizeTop,
  KEEP_THRESHOLD,
  latestDigest,
  newsDigestPath,
  newsLastRunPath,
  newsSeenPath,
  newsTrendingPath,
  NEWS_SOURCES,
  pendingProposalCount,
  pendingSpeech,
  proposalRows,
  readLastRun,
  readNewsVerdicts,
  readTrending,
  renderNewsBrief,
  runNewsWatch,
  scoreText,
  seenIds,
  suggestedUniverse,
  TICKERS,
  tickerHeat,
  writeTrending,
  type NewsDeps,
  type NewsItem,
} from '../server/fleet/news.ts'
import { appendLearnNote, learnNotesPath, type LearnNote } from '../server/fleet/learner.ts'
import { planTask } from '../server/fleet/plans.ts'
import { getEvents } from '../server/ledger.ts'

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
const TMP = join(ROOT, 'artifacts', `news-smoke-${process.pid}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const NOW = new Date('2026-09-19T10:00:00+08:00').getTime()

/** 造一个源返回的仓库对象（与 GitHub 搜索的真实形状一致）。 */
function repo(fullName: string, desc: string, stars = 100): Record<string, unknown> {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: desc,
    pushed_at: '2026-09-18T00:00:00Z',
    stargazers_count: stars,
  }
}

interface StubOpts {
  repos?: Record<string, unknown>[]
  webHits?: { title: string; url: string; snippet: string }[]
  ghOk?: boolean
  webOk?: boolean
  chat?: NewsDeps['chat']
  poolExhausted?: boolean
}

function stubDeps(opts: StubOpts = {}): Partial<NewsDeps> & { cwd: string } {
  return {
    cwd: TMP,
    now: () => NOW,
    fetchJson: async () =>
      opts.ghOk === false
        ? { ok: false, status: 403, json: null, note: 'HOST_NOT_ALLOWED：不在白名单' }
        : { ok: true, status: 200, json: { items: opts.repos ?? [] }, note: 'OK' },
    search: async () =>
      opts.webOk === false
        ? { ok: false, hits: [], note: '解析出 0 条，要改解析器' }
        : { ok: true, hits: opts.webHits ?? [], note: `命中 ${(opts.webHits ?? []).length} 条` },
    chat: opts.chat ?? (async () => ({ ok: true, text: '[]', model: 'stub', reason: 'OK' })),
    pool: () => ({
      allExhausted: opts.poolExhausted === true,
      speech: opts.poolExhausted === true ? '池子里 2 个账号的免费额度今天都用完了，明天会自动恢复。' : '模型账号还有 1 个能用（一共 1 个）。',
    }),
  }
}

/** 只留一个源，让断言不受源数量影响。 */
const ONE_SRC = [NEWS_SOURCES[0]]

console.log('\n── N1 相关性判据：分数与命中词必须逐条可核对 ──')

await check('N1 高分条目过门、低分条目被拦（配对半边）', () => {
  const hi = scoreText('A new agent harness with append-only session log')
  const lo = scoreText('A new AI agent startup raises money')
  assert.ok(hi.score >= KEEP_THRESHOLD, `高分条目应当过门，实际 ${hi.score}`)
  assert.ok(lo.score < KEEP_THRESHOLD, `只提 AI/agent 的条目不该过门，实际 ${lo.score}（门线 ${KEEP_THRESHOLD}）`)
  assert.ok(hi.matched.includes('harness') && hi.matched.includes('append-only'), `命中词要能说出来：${hi.matched.join(',')}`)
  assert.ok(
    hi.reasons.every((r) => r.includes('+')),
    '每一条命中都要带权重与理由 —— 面板要能回答"为什么觉得它相关"',
  )
  // 负向：低分条目不该在 matched 里混进高分词
  assert.ok(!lo.matched.includes('harness'), '低分条目不该命中 harness')
})

console.log('\n── N2 抓取 → 打分 → 去重 ──')

await check('N2 只有过门的条目进 kept，且带来源与链接', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  const r = await runNewsWatch(
    stubDeps({
      repos: [
        repo('acme/agent-harness', 'thin core + plugin agent harness with append-only log'),
        repo('acme/random-ai', 'an AI agent that does something'),
      ],
    }),
    { sources: ONE_SRC },
  )
  assert.equal(r.items.length, 2, `应当读到 2 条，实际 ${r.items.length}`)
  assert.equal(r.kept.length, 1, `只有 1 条该过门，实际 ${r.kept.length}`)
  assert.equal(r.kept[0].title, 'acme/agent-harness')
  assert.ok(r.kept[0].url.startsWith('https://github.com/'), '条目必须带链接（内化提案要靠它回溯）')
  assert.ok(r.kept[0].source.length > 0, '条目必须带来源')
})

await check('N2 同一批读第二次：fresh 必须归零（否则每天都在重复内化同一条）', async () => {
  const r2 = await runNewsWatch(
    stubDeps({ repos: [repo('acme/agent-harness', 'thin core + plugin agent harness with append-only log')] }),
    { sources: ONE_SRC },
  )
  assert.equal(r2.kept.length, 1, '条目仍然是相关的（判据没变）')
  assert.equal(r2.fresh.length, 0, `已经见过的条目不该算"新的"，实际 ${r2.fresh.length}`)
})

await check('N2 部分源失败时：成功的那些照常产出，失败的要被点名', async () => {
  const r = await runNewsWatch(
    stubDeps({ ghOk: false, webHits: [{ title: 'bit-exact backtest with real funding', url: 'https://example.com/a', snippet: 'walk-forward + slippage' }] }),
    { sources: NEWS_SOURCES.slice(0, 2) }, // 第 1 个是 GitHub（失败），第 2 个是 GitHub… 用前两个都是 gh
  )
  assert.equal(r.sources.filter((s) => !s.ok).length, 2, '两个 GitHub 源都该报失败')
  assert.ok(r.speech.includes('失败'), `全源失败必须说出来：${r.speech}`)
  assert.equal(r.items.length, 0)
})

console.log('\n── N3 内化：三种事因必须分开 ──')

function item(title: string, score = 20): NewsItem {
  return {
    id: 'x' + title.length,
    title,
    url: 'https://example.com/' + encodeURIComponent(title),
    source: 'stub',
    summary: 's',
    publishedAt: null,
    score,
    matched: ['harness'],
    reasons: ['harness(+8)'],
  }
}

await check('N3 模型给出提案 → 落进与自学习同一份提案单', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  const before = existsSync(join(TMP, 'data', 'learn', 'notes.jsonl')) ? readFileSync(join(TMP, 'data', 'learn', 'notes.jsonl'), 'utf8').length : 0
  const r = await internalizeTop(
    stubDeps({
      chat: async () => ({
        ok: true,
        model: 'stub',
        reason: 'OK',
        // ★ 回的是**三行文本格式**（与 NEWS_INTERNALIZE_PROMPT 里写的一致）。
        //   第一版提示词写的是 JSON 数组而解析器只认文本格式 ⇒ 模型老老实实回了
        //   `[]`、系统报"没读懂"。这条断言就是那次失误的钉子。
        text: ['提案：抄 dsh 的"日志即事实源"', '依据：信号里的 harness 带 append-only 会话日志', '动作：在决策层补 LLM 调用日志 [低]'].join('\n'),
      }),
    }),
    [item('agent-harness')],
  )
  assert.equal(r.source, 'model')
  assert.equal(r.proposals.length, 1, `应当提取到 1 条提案，实际 ${r.proposals.length}`)
  assert.equal(r.degraded, null, '成功路径不该标降级')
  const p = join(TMP, 'data', 'learn', 'notes.jsonl')
  assert.ok(existsSync(p), '提案单必须落盘')
  const after = readFileSync(p, 'utf8').length
  assert.ok(after > before, '提案单是 append-only：内容只增')
  const lastLine = readFileSync(p, 'utf8').trim().split('\n').pop() ?? '{}'
  const note = JSON.parse(lastLine) as { observations: string[]; proposals: unknown[] }
  assert.ok(
    note.observations.some((o) => o.includes('https://example.com/')),
    '观察里必须带**原始链接** —— 事后要能回答"这条提案是根据哪条新闻写的"',
  )
})

await check('N3 模型说"无需改进"（[]）→ 与"没读懂"必须分开', async () => {
  const a = await internalizeTop(stubDeps({ chat: async () => ({ ok: true, text: '[]', model: 'stub', reason: 'OK' }) }), [item('a')])
  assert.equal(a.proposals.length, 0)
  assert.equal(a.degraded, null, '模型明确说无需改进，不该标成降级')
  assert.ok(/不需要动本系统/.test(a.speech), `这句要说成"判断不需要动"，实际：${a.speech}`)

  const b = await internalizeTop(
    stubDeps({ chat: async () => ({ ok: true, text: '这几条看起来都很有价值，建议关注。', model: 'stub', reason: 'OK' }) }),
    [item('b')],
  )
  assert.equal(b.proposals.length, 0)
  assert.ok(b.degraded !== null, '★ 输出不是约定格式时必须标降级 —— 否则"没读懂"会被当成"模型说没问题"')
  assert.ok(/一条提案都没提取到/.test(b.degraded ?? ''), `降级说明要讲清事因：${b.degraded}`)
  assert.ok(b.raw !== null, '原始输出必须留档（否则无法核对模型到底说了什么）')
})

await check('N3 模型通道不通 → 第三种降级，且不冒充结论', async () => {
  const r = await internalizeTop(
    stubDeps({ chat: async () => ({ ok: false, text: null, model: null, reason: 'ACCOUNTS_ALL_EXHAUSTED：额度用完' }) }),
    [item('c')],
  )
  assert.equal(r.proposals.length, 0)
  assert.ok(r.degraded !== null && r.degraded.includes('ACCOUNTS_ALL_EXHAUSTED'), `要说清是通道问题：${r.degraded}`)
  assert.ok(!/不需要动本系统/.test(r.speech), '通道不通**不许**说成"不需要改进" —— 那会让人以为系统已评估过') // 该短语只出现在「模型说无需改动」那一支，本支的降级文案里没有它的否定式引用
})

console.log('\n── N4 额度爆了：抓取照做，只有"写方案"那步跳过并说明 ──')

await check('N4 额度爆了：条目照常落盘、内化被跳过并说出原因', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  let chatCalls = 0
  const r = await runNewsWatch(
    stubDeps({
      repos: [repo('acme/agent-harness', 'thin core + plugin agent harness with append-only log')],
      poolExhausted: true,
      chat: async () => {
        chatCalls += 1
        return { ok: true, text: '[]', model: 'stub', reason: 'OK' }
      },
    }),
    { sources: ONE_SRC },
  )
  assert.equal(chatCalls, 0, '额度爆了就不该再去调模型（那是白撞一次）')
  assert.equal(r.fresh.length, 1, '抓取不依赖模型 ⇒ 条目必须照常拿到')
  assert.ok(existsSync(newsSeenPath(TMP)), 'seen 台账必须落盘 —— 否则额度回来的那天会重复内化同一批')
  assert.ok(r.internalize !== null && r.internalize.degraded !== null, '必须有一条"为什么没写方案"的记录')
  assert.ok(/额度/.test(r.internalize?.degraded ?? ''), `降级说明要提到额度：${r.internalize?.degraded}`)
  assert.ok(!/不需要动本系统/.test(r.speech), '额度问题不许说成"评估后无需改进"') // 同上：额度那一支写的是「只做了规则层筛选、没有产出内化方案」
})

console.log('\n── N5 追责面：账本事件与只读出口 ──')

await check('N5 每一轮都写 NEWS_DIGEST（0 条也要写）', async () => {
  const before = getEvents(0).filter((e) => e.kind === 'NEWS_DIGEST').length
  await runNewsWatch(stubDeps({ repos: [] }), { sources: ONE_SRC })
  const after = getEvents(0).filter((e) => e.kind === 'NEWS_DIGEST').length
  assert.equal(after, before + 1, '即使一条没读到，也要留一条"今天读过"的记录')
  const last = getEvents(0).filter((e) => e.kind === 'NEWS_DIGEST').pop()
  const p = last?.payload as Record<string, unknown>
  assert.ok(typeof p.fetched === 'number' && typeof p.kept === 'number' && typeof p.fresh === 'number', '三个数都要有：网通不通 / 判据在不在工作 / 是不是重复劳动')
})

await check('N5 只读出口读得回最近一轮速览', () => {
  const items = latestDigest(TMP, 20)
  assert.ok(items.length > 0, 'latestDigest 应当读得回条目')
  assert.ok(items.every((i) => typeof i.title === 'string'), '每条要有标题')
})

await check('N5 简报必须同时报"读了几条"和"几条相关"', () => {
  const brief = renderNewsBrief({
    at: NOW,
    items: [],
    kept: [],
    fresh: [],
    sources: [{ source: 'gh-agent', ok: false, got: 0, note: 'HOST_NOT_ALLOWED' }],
    trending: [],
    internalize: null,
    dryRun: true,
    writtenTo: null,
    speech: '',
  })
  assert.ok(/读了 0 条/.test(brief), `要报读了多少条：${brief}`)
  assert.ok(/HOST_NOT_ALLOWED/.test(brief), '失败的源要被点名（否则"网挂了"会被当成"今天没事"）')
})

await check('N5 简报列的是"新的"那批，且说清有几个没列出来（判据 17）', () => {
  const brief = renderNewsBrief({
    at: NOW,
    items: [],
    // ★ 专属输入：相关 3 条、其中新的 2 条 ⇒ 1 条"上一轮见过"。
    //   原来的实现只会印 2 个 `·`，而抬头写着"3 条相关"，差的那 1 条无从解释。
    kept: [
      { id: 'k1', url: 'u1', title: 'K1', summary: '', publishedAt: null, source: 'gh-agent', score: 15, matched: [], reasons: [] },
      { id: 'k2', url: 'u2', title: 'K2', summary: '', publishedAt: null, source: 'gh-agent', score: 12, matched: [], reasons: [] },
      { id: 'k3', url: 'u3', title: 'K3', summary: '', publishedAt: null, source: 'gh-agent', score: 10, matched: [], reasons: [] },
    ] as never,
    fresh: [
      { id: 'k1', url: 'u1', title: 'K1', summary: '', publishedAt: null, source: 'gh-agent', score: 15, matched: ['harness'], reasons: [] },
      { id: 'k2', url: 'u2', title: 'K2', summary: '', publishedAt: null, source: 'gh-agent', score: 12, matched: ['skill'], reasons: [] },
    ] as never,
    sources: [{ source: 'gh-agent', ok: true, got: 5, note: '拿到 5 个仓库' }],
    trending: [],
    internalize: null,
    dryRun: false,
    writtenTo: null,
    speech: '',
  })
  assert.ok(/3 条与本系统相关/.test(brief), `抬头要报相关条数：${brief}`)
  assert.ok(/新的条目/.test(brief), '列的那批必须说清是"新的"，不能只印一串 ·')
  // ★ 差的那 1 条要能解释 —— 否则读的人只能猜。
  assert.ok(/已经见过/.test(brief), `没列出来的那些要说清去哪了：${brief}`)
})

console.log('\n── N6 红线：这条链不许碰源码 ──')

await check('N6 跑一轮之后源码目录没有被写过（mtime 不变）', async () => {
  const watch = [join(ROOT, 'server', 'fleet', 'news.ts'), join(ROOT, 'server', 'fleet', 'learner.ts'), join(ROOT, 'server', 'index.ts')]
  const before = watch.map((f) => statSync(f).mtimeMs)
  await runNewsWatch(
    stubDeps({ repos: [repo('acme/agent-harness', 'harness append-only')], chat: async () => ({ ok: true, text: '[]', model: 's', reason: 'OK' }) }),
    { sources: ONE_SRC },
  )
  const after = watch.map((f) => statSync(f).mtimeMs)
  assert.deepEqual(after, before, '★ 新闻雷达的产出是**提案单**；任何对源码的写入都意味着有人给它加了改码能力（不可逆动作）')
})

console.log('\n── N7 与计划表对齐：这句话真能被接住 ──')

await check('N7 「读新闻」落到 news 计划，而不是别的计划', () => {
  const r = planTask('读新闻，有值得内化的就写提案')
  assert.equal(r.plan?.id, 'news', `计划表要能接住自治循环里的那句话，实际：${r.plan?.id ?? 'null'} —— ${r.why}`)
  assert.equal(r.plan?.writes, true, '它会落提案单，必须标成 writes（疑问句下就不接）')
})

await check('N7 自治循环里那条 goal 必须被计划表接住（逐条）', async () => {
  const { AUTONOMY_JOBS } = await import('../server/fleet/autonomy.ts')
  for (const j of AUTONOMY_JOBS) {
    const p = planTask(j.goal)
    assert.equal(p.plan !== null, true, `自治任务「${j.id}」的 goal「${j.goal}」没有人接得住 —— 它会每周期安静地失败一次`)
  }
  assert.ok(
    AUTONOMY_JOBS.some((j) => j.id === 'news_watch'),
    '定时新闻必须登记在自治任务表里（否则"定时"这两个字是假的）',
  )
  const nw = AUTONOMY_JOBS.find((j) => j.id === 'news_watch')
  assert.equal(nw?.needsModel, true, '新闻内化要用模型，必须标 needsModel —— 否则额度爆了会去撞一次注定失败的调用')
  assert.equal(nw?.reversible, true, '它落的是提案单（可撤），所以允许进自动循环')
})

console.log('\n── N8 幂等与坏输入 ──')

await check('N8 append-only：连跑两次，seen 行数只增不减', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  const deps = stubDeps({ repos: [repo('acme/agent-harness', 'harness append-only')] })
  await runNewsWatch(deps, { sources: ONE_SRC })
  const n1 = readFileSync(newsSeenPath(TMP), 'utf8').trim().split('\n').filter(Boolean).length
  const r2 = await runNewsWatch(deps, { sources: ONE_SRC })
  const n2 = readFileSync(newsSeenPath(TMP), 'utf8').trim().split('\n').filter(Boolean).length
  assert.ok(n2 >= n1, `只增不减，${n1} → ${n2}`)
  assert.equal(r2.fresh.length, 0, '第二次没有新条目，不该再写 seen（写了就会重复计数）')
})

await check('N8 seen 台账里有一行坏数据时，读取不许整体失败', () => {
  const p = newsSeenPath(TMP)
  writeFileSync(p, readFileSync(p, 'utf8') + '这不是 JSON\n', 'utf8')
  const ids = seenIds(TMP)
  assert.ok(ids.size > 0, '坏行必须被跳过，而不是让整个台账读不出来')
})

await check('N8 空 items 调内化：给出明确的"没有可内化的"，不报错', async () => {
  const r = await internalizeTop(stubDeps(), [])
  assert.equal(r.considered, 0)
  assert.equal(r.proposals.length, 0)
  assert.equal(r.degraded, null, '"没有条目"是一种明确的结论，不是降级')
  assert.ok(/没有条目过相关性门/.test(r.speech), `要说清是"没有条目"：${r.speech}`)
})

// ═══════════════════ N9 品种热度（雷达接回系统行为的那根线）═══════════════════
//
// ★ 这一组为什么最要紧：它是新闻雷达**唯一直接改系统行为**的出口 ——
//   抽出来的品种热度会成为 breadth（多品种）的候选清单。
//   一份被常见英文词污染的榜会让系统去交易错误的品种，
//   而它在页面上看起来完全正常（"SOL 很热"）。

console.log('\n── N9 品种热度：词边界、排序键、空榜与读不到 ──')

await check('N9 整词匹配：console/adapt/linkedin 不许被算成 SOL/ADA/LINK', () => {
  const txt = 'A console for adapting linkedin dotcom workflows'
  for (const bad of ['SOL', 'ADA', 'LINK', 'DOT']) {
    const t = TICKERS.find((x) => x.ticker === bad) as (typeof TICKERS)[number]
    assert.equal(countTicker(txt, t), 0, `"${txt}" 里不该认出 ${bad}（子串匹配会让常见英文词长期霸榜）`)
  }
})

await check('N9 真提到才认，且大小写不敏感、别名等价', () => {
  const sol = TICKERS.find((x) => x.ticker === 'SOL') as (typeof TICKERS)[number]
  const eth = TICKERS.find((x) => x.ticker === 'ETH') as (typeof TICKERS)[number]
  assert.ok(countTicker('Solana fees drop', sol) > 0, 'Solana 要认')
  assert.ok(countTicker('SOL breaks out', sol) > 0, 'SOL 要认')
  assert.ok(countTicker('sol up 5%', sol) > 0, '小写 sol 要认')
  assert.ok(countTicker('Ethereum and ether', eth) >= 2, '别名都要认：Ethereum / ether')
  assert.equal(countTicker('ethan went home', eth), 0, 'ethan 不是 ether —— 词边界必须挡住它')
})

await check('N9 排序键是相关性加权，不是出现次数', () => {
  // ★ 专属输入：A 出现 3 条但都很不相关；B 只出现 1 条但很相关。
  //   只有"按 weighted 排"才会把 B 排在前面 —— 只数次数的话 A 一定在前。
  const heat = tickerHeat([
    { title: 'BTC fees', summary: '', score: 1 },
    { title: 'BTC blocks', summary: '', score: 1 },
    { title: 'BTC mempool', summary: '', score: 1 },
    { title: 'Harness for SOL with append-only log', summary: '', score: 24 },
  ])
  assert.equal(heat[0].ticker, 'SOL', `相关的少数派要排在前面，实际榜 ${heat.map((h) => `${h.ticker}(${h.weighted})`).join(' ')}`)
  const btc = heat.find((h) => h.ticker === 'BTC')
  assert.ok(btc && btc.mentions === 3, 'BTC 出现 3 条这件事本身也要留着')
})

await check('N9 mentions 数的是条目数，不是出现次数', () => {
  // ★ 专属输入：同一条里把 BTC 写三遍。只有"按条目计数"才会得到 1。
  const heat = tickerHeat([{ title: 'BTC BTC and BTC again', summary: 'bitcoin bitcoin', score: 5 }])
  assert.equal(heat[0].mentions, 1, `同一条里提多次仍算一条，实际 ${heat[0].mentions}`)
})

await check('N9 空榜与读不到必须说不同的话（判据 24）', async () => {
  rmSync(newsTrendingPath(TMP), { force: true })
  const missing = suggestedUniverse(TMP)
  assert.equal(missing.symbols.length, 0)
  assert.ok(/没读到/.test(missing.note), `读不到要说读不到：${missing.note}`)
  assert.ok(!/没有任何品种/.test(missing.note), '读不到 ≠ 没有品种被提到，这两句不许混') // 读不到那一句写的是「没有品种被提到」（少一个"任何"），两者不同字

  writeTrending(TMP, NOW, [])
  const empty = suggestedUniverse(TMP)
  assert.ok(/空榜/.test(empty.note), `空榜要说空榜：${empty.note}`)
  // 用**行首锚定**：读不到那一支的文案以「没读到品种热度」开头，空榜那一支的文案里
  // 出现的「读不到」是在说「这是空榜，不是读不到」—— 拿裸词去否定就是对正确输出报错。
  assert.ok(!/^没读到/.test(empty.note), '空榜不是读不到')
})

await check('N9 候选清单给出可直接用的交易对形状，并带上依据', () => {
  writeTrending(TMP, NOW, [
    { ticker: 'ETH', mentions: 4, weighted: 30, samples: ['a'] },
    { ticker: 'SOL', mentions: 2, weighted: 16, samples: ['b'] },
  ])
  const u = suggestedUniverse(TMP, 8)
  assert.deepEqual(u.symbols, ['ETHUSDT', 'SOLUSDT'])
  assert.ok(/ETH/.test(u.note) && /加权|相关分/.test(u.note), `要说清候选是怎么来的：${u.note}`)
})

await check('N9 跑一轮会落 trending.json，且内容是真算出来的', async () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  const r = await runNewsWatch(
    stubDeps({ repos: [repo('acme/sol-harness', 'Solana harness with append-only log and walk-forward backtest')] }),
    { sources: ONE_SRC },
  )
  assert.ok(r.trending.some((h) => h.ticker === 'SOL'), `这一轮的榜里该有 SOL：${r.trending.map((h) => h.ticker).join(',')}`)
  const back = readTrending(TMP)
  assert.ok(back, 'trending.json 要落盘（breadth 靠它取候选）')
  assert.ok(back.ticks.some((h) => h.ticker === 'SOL'), '读回来的内容要与这一轮一致')
})

// ═══════════════════ N10 人对提案的裁决（闭环的最后一环）═══════════════════

console.log('\n── N10 裁决：可追溯、可改主意、不许写幽灵 ──')

function learnNote(id: string, titles: string[]): LearnNote {
  return {
    id,
    at: NOW,
    source: 'model',
    observations: ['观察一', '观察二'],
    proposals: titles.map((t, i) => ({ title: t, evidence: `依据${i}`, action: `动作${i}`, risk: 'low' as const })),
    raw: null,
    model: 'stub',
    degraded: null,
    ledgerEvents: 0,
  }
}

await check('N10 裁决能读回来，且带"谁拍的/什么时候"', () => {
  rmSync(join(TMP, 'data'), { recursive: true, force: true })
  appendLearnNote(TMP, learnNote('N1', ['提案甲', '提案乙']))
  appendNewsVerdict(TMP, { noteId: 'N1', index: 1, decision: 'approve', at: NOW + 1000, by: 'noah', why: '这条值得做' })
  const m = readNewsVerdicts(TMP)
  const v = m.get('N1#1')
  assert.ok(v, '裁决要能按 提案单#序号 读回来')
  assert.equal(v.by, 'noah', '"谁拍的"不能没有答案')
  assert.equal(v.why, '这条值得做', '理由要留下来')
})

await check('N10 改主意时最后一次算数，但旧记录仍在（append-only）', () => {
  appendNewsVerdict(TMP, { noteId: 'N1', index: 1, decision: 'reject', at: NOW + 2000, by: 'noah', why: '想清楚了，不做' })
  const m = readNewsVerdicts(TMP)
  assert.equal(m.get('N1#1')?.decision, 'reject', '最新那次才算数')
  const raw = readFileSync(join(TMP, 'data', 'news', 'verdicts.jsonl'), 'utf8').trim().split('\n')
  assert.equal(raw.length, 2, '"改过主意"这件事本身也要留在文件里')
})

await check('N10 非法编号不写盘（不许往留痕里塞幽灵）', () => {
  assert.throws(() => appendNewsVerdict(TMP, { noteId: '', index: 0, decision: 'approve', at: NOW, by: 'x', why: null }), /noteId/)
  assert.throws(() => appendNewsVerdict(TMP, { noteId: 'N1', index: -1, decision: 'approve', at: NOW, by: 'x', why: null }), /非负整数/)
})

await check('N10 合成行时序号与文件行一致（确认第 2 条不许指到第 1 条上）', () => {
  const rows = proposalRows(TMP)
  const a = rows.find((r) => r.noteId === 'N1' && r.index === 0)
  const b = rows.find((r) => r.noteId === 'N1' && r.index === 1)
  assert.ok(a && b, '两条提案都要在')
  assert.equal(a.title, '提案甲', '序号 0 必须是第一条')
  assert.equal(b.title, '提案乙', '序号 1 必须是第二条')
  assert.equal(a.decision, null, '没被裁决的那条要保持未裁决')
  assert.equal(b.decision, 'reject', '被裁决的那条要带上裁决')
  assert.equal(a.observations.length, 2, '每行要能追溯到它依据的观察')
})

await check('N10 待办数只数未裁决的', () => {
  assert.equal(proposalRows(TMP).length, 2)
  assert.equal(pendingProposalCount(TMP), 1, '2 条里 1 条已裁决 ⇒ 待办 1')
})

await check('N10 三种"没待办"必须说三句不同的话（判据 24）', () => {
  const noFile = pendingSpeech(join(TMP, 'nowhere'))
  const emptyDir = join(TMP, 'empty-case')
  mkdirSync(join(emptyDir, 'data', 'learn'), { recursive: true })
  writeFileSync(learnNotesPath(emptyDir), '')
  const empty = pendingSpeech(emptyDir)
  const hasPending = pendingSpeech(TMP)
  assert.ok(/还没有任何提案单/.test(noFile), `读不到提案单要说读不到：${noFile}`)
  assert.ok(/空的/.test(empty), `空单要说空单：${empty}`)
  assert.ok(/等你点/.test(hasPending), `有待办要说待办：${hasPending}`)
  assert.notEqual(noFile, empty)
  assert.notEqual(empty, hasPending)
  // ★★ 判据 30 —— 这一条在本仓库已经**复现过两次**（provider-health D4/D5、这里）。
  //   负向断言选的那个词，会不会在本分支里以**否定形式**出现？
  //   "读不到"那一句自己就写着「不是"没有待办"」⇒ 拿 /没有待办/ 去断言，
  //   就是对一份**完全正确**的输出报错（判据 2）。
  //   ⇒ 只能选**别的分支独有的动作词**："等你点" 只在真有待办时出现。
  const ONLY_WHEN_PENDING = /等你点/
  assert.ok(!ONLY_WHEN_PENDING.test(noFile), `"读不到"不许说出"有待办"的那句话：${noFile}`)
  assert.ok(!ONLY_WHEN_PENDING.test(empty), `空单不许说出"有待办"的那句话：${empty}`)
})


// ═══════════ N11 各源战绩必须**落盘**（编排器重启后还在）═══════════
//
// ★ 这一组是「实测踩到的缺陷」的回填，不是设想出来的检查：
//   各源战绩原来取自 `NEWS_DIGEST` 事件，而事件活在 `ledger.ts` 的**进程内存**里。
//   编排器一重启，面板就把 5 个源全画成「0 条」—— 而 0 是个**合法数字**，
//   与"源真的什么都没拿到"长得一模一样，两者的下一步却完全相反（判据 24）。
//   现在面板读的是落盘的 `data/news/last-run.json`，下面把这条钉死：
//   真的落盘了 / 数字与这一轮相符 / 读不到时**不许退化成 0**。

await check('N11 从没跑过 → 读不到，而不是"各源都是 0 条"', () => {
  rmSync(newsLastRunPath(TMP), { force: true })
  assert.equal(readLastRun(TMP), null, '文件不存在时必须返回 null（界面据此说"还没跑过一轮"）')
})

await check('N11 报告读不懂也说读不到，而且不许抛', () => {
  writeFileSync(newsLastRunPath(TMP), '{ 这不是 JSON', 'utf8')
  assert.equal(readLastRun(TMP), null, '坏文件必须返回 null —— 不许抛，也不许当成一份空报告')
  rmSync(newsLastRunPath(TMP), { force: true })
})

await check('N11 跑一轮就落报告，各源战绩与这一轮实际抓到的条数一致', async () => {
  const r = await runNewsWatch(
    stubDeps({
      repos: [repo('acme/a', 'agent harness with append-only session log'), repo('acme/b', 'a backtest harness')],
    }),
    { sources: ONE_SRC },
  )
  const run = readLastRun(TMP)
  assert.notEqual(run, null, '跑完一轮必须落 last-run.json（否则面板重启后又是 0 条）')
  assert.equal(run!.sources.length, ONE_SRC.length, `报告里每个源都要有一条：${JSON.stringify(run!.sources)}`)
  const s0 = run!.sources[0]
  assert.equal(s0.source, ONE_SRC[0].id, '报告里的源要写 id —— 面板靠它与源清单对齐')
  // ★ 专属输入：这一轮真抓到 2 条。任何"把 got 写成常量 0"的实现会在这里报红。
  assert.equal(s0.got, r.items.length, `got 必须等于真的抓到几条（报告 ${s0.got} / 实际 ${r.items.length}）`)
  assert.equal(run!.fetched, r.items.length, `fetched 要等于抓到的总条数（报告 ${run!.fetched}）`)
  assert.equal(run!.kept, r.kept.length, `kept 要等于过门条数（报告 ${run!.kept}）`)
})

await check('N11 源没通记成 ok=false + got=0（它仍是一条"有记录"）', async () => {
  await runNewsWatch(stubDeps({ ghOk: false }), { sources: ONE_SRC })
  const run = readLastRun(TMP)
  const s0 = run!.sources[0]
  assert.equal(s0.ok, false, `网/白名单不通必须记成 false：${JSON.stringify(s0)}`)
  // ★ 这条与上一条合起来才完整：`got=0`（有记录、真的没拿到）与
  //   "报告里根本没有这个源"（= 面板给 null）是**两件事**，不许合并成一个 0。
  assert.equal(s0.got, 0, '没通就是 0 条')
})

await check('N11 dryRun 不落任何盘 —— 报告也不能例外', async () => {
  rmSync(newsLastRunPath(TMP), { force: true })
  await runNewsWatch(stubDeps({ repos: [repo('acme/a', 'agent harness with append-only session log')] }), {
    sources: ONE_SRC,
    dryRun: true,
  })
  assert.equal(existsSync(newsLastRunPath(TMP)), false, 'dryRun 的定义就是"不落盘"，报告不许偷偷写一份')
})

// 清理：这是临时目录，删失败不影响结论（不要因为它去改门禁的判据）
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* ignore */
}
console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] NEWS SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `NEWS SMOKE PASSED (${passed}/${passed}) · 源 ${NEWS_SOURCES.length} 个 · 门线 ${KEEP_THRESHOLD} 分 · 品种词表 ${TICKERS.length} 个 · 词表 ${scoreText('harness').score >= KEEP_THRESHOLD ? '可用' : '异常'}`,
)
void newsDigestPath
void newsTrendingPath
