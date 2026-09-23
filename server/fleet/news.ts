/**
 * 新闻雷达 —— 「定时看新闻，主动学习并内化」
 *
 * ── 用户的原话与它对应的三个动作 ──────────────────────────────────────
 * 「语音栏还需要能联网，主动调用大模型完成任务，例如定时给自己学习，
 *   写升级代码进化自己……设计一个定时任务功能能主动推送新闻主动学习并内化的机制」
 * 拆开是三件事，缺一件这条链就是假的：
 *   ① **定时去读**（不是"用户问才查"）—— 所以在 `AUTONOMY_JOBS` 里有一项 `news_watch`；
 *   ② **判断哪条值得内化**（不是把新闻原文丢给人）；
 *   ③ **把内化结论落成可核对的提案**（不是"我学到了"这句话）。
 *
 * ── 为什么打分必须是**确定性规则**，模型只用来"写方案" ────────────────
 * 「哪条和本系统相关」这件事如果交给模型，它就不可复现、不可断言、
 * 也没法回答"你为什么觉得这条相关"。所以判据是规则：命中哪些词、各值多少分，
 * 全部落在 `RELEVANCE_TERMS` 里，每条都会出现在 `matched` 里（可核对）。
 * 模型只负责**把已经选中的条目读一遍、写出内化方案** —— 那是它擅长的部分。
 *
 * ── 为什么新闻源选 GitHub 搜索 + 网页搜索 ─────────────────────────────
 * 本机实测（`server/net/egress.ts` 顶部记着）：`api.github.com` 与 `bing.com`
 * 可达，而 `api.coingecko.com`、`raw.githubusercontent.com`、`zh.wikipedia.org`
 * **超时**。所以源必须是实测可达的 —— 写一堆"看起来应该能通"的源，
 * 只会让每次定时任务都安静地失败一次。
 *
 * ── 三条不可越过的线 ──────────────────────────────────────────────────
 *   ① **不写源码**。内化产出的是提案单（`data/learn/notes.jsonl`），
 *      改码是不可逆动作，必须由人点（与 `learner` 同一条红线）；
 *   ② **不抓未知域名**。所有出网走 `net/egress.ts` 的白名单，
 *      不在白名单里的域名会被拒，而**拒绝本身会被记下来**；
 *   ③ **额度爆了不装死**。抓取与落盘不依赖模型（额度爆了照做），
 *      只有"写内化方案"这一步需要模型 —— 那一步被跳过时必须**说出来**，
 *      因为"今天没学习"与"今天学了但没问题"在账本上不能长得一样。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { appendEvent, getEvents } from '../ledger.ts'
import { poolSnapshot } from '../llmPool.ts'
import { routeChat } from '../modelRouter.ts'
import { fetchPage, webSearch } from '../net/egress.ts'
import { appendLearnNote, learnNotesPath, parseProposals, type LearnNote, type LearnProposal } from './learner.ts'

// ─────────────────────────── 源 ───────────────────────────

export interface NewsSource {
  id: string
  label: string
  kind: 'github' | 'web'
  query: string
  why: string
}

/**
 * 新闻源清单。
 *
 * ★ 每一条都要写 `why`：一个说不出"为什么订阅它"的源，半年后没人敢删。
 * ★ `kind: 'github'` 走 `api.github.com/search/repositories` —— 结构化 JSON，
 *   零解析脆弱性（网页解析会随对方改版而静默失效，这是本项目记过的坑）。
 */
export const NEWS_SOURCES: readonly NewsSource[] = [
  {
    id: 'gh-agent',
    label: 'GitHub · Agent 工程化',
    kind: 'github',
    query: 'agent harness OR "agent framework" OR "llm agent" in:name,description,readme',
    why: '对标"Agent = Model + Harness"这一层：薄核心 + 插件 + 日志即事实源，直接对应本系统第 4 层。',
  },
  {
    id: 'gh-quant',
    label: 'GitHub · 量化交易与回测',
    kind: 'github',
    query: 'trading bot backtest walk-forward in:name,description,readme',
    why: '盯"回测与实盘同码 + 真实摩擦"这类工程做法 —— 它是本系统 ledger mismatch 的根治方向。',
  },
  {
    id: 'gh-guard',
    label: 'GitHub · Agent 安全与护栏',
    kind: 'github',
    query: 'prompt injection guardrail sandbox agent in:name,description,readme',
    why: '沙箱 / egress 白名单 / 能力分离：对应本系统"决策与执行解耦 + 受控出网"这两条红线。',
  },
  {
    id: 'web-agent',
    label: '网页搜索 · Agent 新范式',
    kind: 'web',
    query: 'AI agent harness append-only log observability',
    why: '网页侧补 GitHub 搜不到的东西：新范式、新论文、工程实践总结。',
  },
  {
    id: 'web-quant',
    label: '网页搜索 · 加密量化生产实践',
    kind: 'web',
    query: 'crypto quant trading realistic backtest slippage funding rate',
    why: '真实摩擦（滑点/资金费/延迟）的建模做法，直接喂给成本侧。',
  },
]

// ─────────────────────── 相关性打分（确定性） ───────────────────────

export interface RelevanceTerm {
  /** 命中的词（不区分大小写，按子串匹配）。 */
  term: string
  weight: number
  why: string
}

/**
 * 「这条和本系统有关」的全部判据。
 *
 * ★ 权重分三档，理由不是"感觉重要"，而是**命中之后能改哪一处代码**：
 *   · 8 分：命中就能指出一条已登记的能力或红线（harness / walk-forward / 沙箱 / 内化…）
 *   · 5 分：命中说明是同一个领域（回测 / 交易机器人 / 审计 / 技能）
 *   · 2 分：只是同题材（agent / llm / crypto）—— 单独命中**过不了门**，
 *          这是有意的：只谈 AI 的新闻每天几百条，放进来就是噪音。
 */
export const RELEVANCE_TERMS: readonly RelevanceTerm[] = [
  { term: 'harness', weight: 8, why: 'Agent 的运行时骨架，本系统第 4 层正在做的同一件事' },
  { term: 'walk-forward', weight: 8, why: '自进化的验证方式，直接对应过拟合门' },
  { term: 'bit-exact', weight: 8, why: '回测与实盘同码 —— ledger mismatch 的根治方向' },
  { term: 'prompt injection', weight: 8, why: '注入防御，对应本系统的输入不可信假设' },
  { term: 'append-only', weight: 8, why: '日志即事实源，对应账本的哈希链' },
  { term: 'sandbox', weight: 8, why: '执行隔离，对应"不可逆动作必须人确认"' },
  { term: 'egress', weight: 8, why: '受控出网，对应 net/egress.ts 的白名单' },
  { term: 'skill', weight: 8, why: '技能供应链安全（扫描 / 签名 / 作用域授权）' },
  { term: 'maker', weight: 8, why: '挂单成本侧 —— 本系统因子线的瓶颈就在成本' },
  { term: 'factor', weight: 8, why: '因子挖掘，对应因子生产线' },
  { term: 'backtest', weight: 5, why: '回测，同一领域' },
  { term: 'trading bot', weight: 5, why: '交易机器人，同一领域' },
  { term: 'audit', weight: 5, why: '审计链，对应账本与回执' },
  { term: 'drift', weight: 5, why: '漂移检测，对应证据新鲜度' },
  { term: 'friction', weight: 5, why: '真实摩擦（成本建模）' },
  { term: 'slippage', weight: 5, why: '滑点，成本侧输入' },
  { term: 'funding', weight: 5, why: '资金费，成本侧输入' },
  { term: 'quant', weight: 5, why: '量化，同一领域' },
  { term: 'portfolio', weight: 5, why: '组合层，对应多品种 breadth' },
  { term: 'mcp', weight: 5, why: '工具接入协议' },
  { term: 'agent', weight: 2, why: '同题材（单独命中不算相关）' },
  { term: 'llm', weight: 2, why: '同题材（单独命中不算相关）' },
  { term: 'crypto', weight: 2, why: '同题材（单独命中不算相关）' },
]

/** 过门线。一条只写 "AI agent" 的新闻得 4 分，进不来。 */
export const KEEP_THRESHOLD = 8

export function scoreText(text: string): { score: number; matched: string[]; reasons: string[] } {
  const lower = text.toLowerCase()
  let score = 0
  const matched: string[] = []
  const reasons: string[] = []
  for (const t of RELEVANCE_TERMS) {
    if (lower.includes(t.term)) {
      score += t.weight
      matched.push(t.term)
      reasons.push(`${t.term}(+${t.weight}：${t.why})`)
    }
  }
  return { score, matched, reasons }
}

// ─────────────────────────── 数据结构 ───────────────────────────

export interface NewsItem {
  /** 稳定 id（链接的哈希前 12 位）—— 同一条新闻不重复内化。 */
  id: string
  title: string
  url: string
  source: string
  summary: string
  publishedAt: number | null
  score: number
  matched: string[]
  reasons: string[]
}

export interface SourceReport {
  source: string
  ok: boolean
  got: number
  note: string
}

export interface NewsDeps {
  now: () => number
  cwd: string
  /** 抓 JSON 接口（GitHub 搜索）。**可注入** —— 让烟测不依赖真实网络。 */
  fetchJson: (url: string) => Promise<{ ok: boolean; status: number | null; json: unknown; note: string }>
  /** 网页搜索。**可注入**。 */
  search: (q: string, limit?: number) => Promise<{ ok: boolean; hits: { title: string; url: string; snippet: string }[]; note: string }>
  /** 问模型（只有"写内化方案"这一步用）。**可注入**。 */
  chat: (system: string, user: string) => Promise<{ ok: boolean; text: string | null; model: string | null; reason: string }>
  /**
   * 账号池现状。**可注入**。
   *
   * ★ 必须能注入的理由是判据 2：不注入的话，"额度爆了 ⇒ 跳过内化"这条分支
   *   在测试里的红绿取决于**跑测试那台机器今天有没有把免费额度用光**。
   *   一条会随环境变色的断言，比没有断言更费人 —— 它会训练人忽略红色。
   */
  pool: () => { allExhausted: boolean; speech: string }
}

function defaultDeps(cwd: string): NewsDeps {
  return {
    now: () => Date.now(),
    cwd,
    fetchJson: async (url) => {
      const r = await fetchPage(url, { timeoutMs: 15_000, maxBytes: 256 * 1024 })
      if (!r.ok) return { ok: false, status: r.status, json: null, note: `${r.reason ?? 'FETCH_FAILED'}：${r.note}` }
      try {
        return { ok: true, status: r.status, json: JSON.parse(r.raw) as unknown, note: 'OK' }
      } catch {
        // 非 JSON 的 200 也要说清是"解析不了"而不是"网络失败"——两者的下一步不同。
        return { ok: false, status: r.status, json: null, note: 'HTTP_OK 但正文不是 JSON（多半是被登录页/验证码挡了）' }
      }
    },
    search: async (q, limit = 6) => {
      const r = await webSearch(q, { limit })
      if (!r.ok || r.parseFailed) {
        // ★ 「搜不到」与「页面结构变了导致我没读懂」必须分开报：前者换个词再试，
        //   后者要去改解析器。合并成一句"搜索失败"，半年后没人知道该动哪一处。
        const why = r.parseFailed ? '页面结构变了（解析出 0 条），要改解析器' : '这次没搜到结果'
        return { ok: false, hits: [], note: `${why} · ${r.note}` }
      }
      return { ok: true, hits: r.hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet })), note: `命中 ${r.hits.length} 条` }
    },
    chat: async (system, user) => {
      // 用 `execute` 档：输入是**已经算好并选好**的条目，模型要做的是"写方案"。
      // 放在 `plan` 档会让这个周期任务持续吃掉最贵的通道（与 learner 同一个理由）。
      const r = await routeChat('execute', system, user, 0.4)
      return { ok: r.ok, text: r.text, model: r.model, reason: r.reason }
    },
    pool: () => {
      const p = poolSnapshot()
      return { allExhausted: p.allExhausted, speech: p.speech }
    },
  }
}

// ─────────────────────────── 落盘 ───────────────────────────

export function newsDir(cwd: string): string {
  return join(cwd, 'data', 'news')
}
/** 已见条目（append-only）。它让"同一条新闻不重复提内化"这件事可追溯。 */
export function newsSeenPath(cwd: string): string {
  return join(newsDir(cwd), 'seen.jsonl')
}
/** 每天一份速览（append-only，按日期命名 ⇒ 永不重命名/覆盖）。 */
export function newsDigestPath(cwd: string, at: number): string {
  return join(newsDir(cwd), `digest-${new Date(at).toISOString().slice(0, 10)}.jsonl`)
}

function itemId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12)
}

/** 已见过的条目 id。 */
export function seenIds(cwd: string): Set<string> {
  const p = newsSeenPath(cwd)
  const out = new Set<string>()
  if (!existsSync(p)) return out
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s) as { id?: string }
        if (o.id) out.add(o.id)
      } catch {
        /* 坏行跳过，不让它挡住整轮读取 */
      }
    }
  } catch {
    /* 读不到当没有 */
  }
  return out
}

function appendLines(path: string, rows: unknown[]): void {
  if (rows.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

// ─────────────────────────── 抓取 ───────────────────────────

/** GitHub 搜索 URL。`pushed:>` 限定近期活跃，否则会捞到一堆死仓库。 */
export function githubSearchUrl(query: string, sinceDays: number, now: number): string {
  const since = new Date(now - sinceDays * 86_400_000).toISOString().slice(0, 10)
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} pushed:>${since}`)}&sort=updated&order=desc&per_page=5`
}

interface GithubRepo {
  full_name?: string
  html_url?: string
  description?: string | null
  pushed_at?: string | null
  stargazers_count?: number
}

function reposFrom(json: unknown): GithubRepo[] {
  const items = (json as { items?: unknown })?.items
  return Array.isArray(items) ? (items as GithubRepo[]) : []
}

/** 抓一个源 → 原始条目（还没打分）。 */
export async function collectFrom(
  deps: NewsDeps,
  src: NewsSource,
  sinceDays: number,
): Promise<{ items: { title: string; url: string; summary: string; publishedAt: number | null; source: string }[]; report: SourceReport }> {
  if (src.kind === 'github') {
    const r = await deps.fetchJson(githubSearchUrl(src.query, sinceDays, deps.now()))
    if (!r.ok) return { items: [], report: { source: src.id, ok: false, got: 0, note: r.note } }
    const repos = reposFrom(r.json)
    return {
      items: repos
        .filter((x) => x.full_name && x.html_url)
        .map((x) => ({
          title: String(x.full_name),
          url: String(x.html_url),
          summary: `${String(x.description ?? '（无描述）')} · ★${Number(x.stargazers_count ?? 0)}`,
          publishedAt: x.pushed_at ? Date.parse(String(x.pushed_at)) || null : null,
          source: src.label,
        })),
      report: { source: src.id, ok: true, got: repos.length, note: `拿到 ${repos.length} 个仓库` },
    }
  }
  const r = await deps.search(src.query, 6)
  if (!r.ok) return { items: [], report: { source: src.id, ok: false, got: 0, note: r.note } }
  return {
    items: r.hits.map((h) => ({ title: h.title, url: h.url, summary: h.snippet, publishedAt: null, source: src.label })),
    report: { source: src.id, ok: true, got: r.hits.length, note: r.note },
  }
}

// ─────────────────────────── 内化 ───────────────────────────

/**
 * 内化提示词。
 *
 * ★★ 输出格式**必须与 `learner.parseProposals` 认的格式逐字一致**。
 *   第一版这里写的是"输出 JSON 数组"，而解析器只认三行文本格式 ——
 *   结果模型老老实实回了 `[]`，系统报"没读懂"。这是烟测 N3 当场抓出来的
 *   （判据 8：同一个产出有两条实现路径，就一定会有给出不同答案的一天）。
 *   所以在改这里之前先想清楚：**改格式就必须同时改解析器**。
 */
export const NEWS_INTERNALIZE_PROMPT = [
  '你是 EVOLVE 自进化量化交易系统的技术雷达。',
  '你会收到若干条**刚刚抓到的、与本系统相关的外部信号**（每条带链接与命中词）。',
  '你的任务：判断其中哪些值得内化进本系统，并写成可执行的改进提案。',
  '',
  '硬要求：',
  '1. 每条提案必须引用某条信号里的**具体做法或数字**作为依据，不许写"这个项目很先进/值得关注"。',
  '2. 提案必须是**动作**（改哪一层、加什么、停什么），不是"建议进一步研究"。',
  '3. 不许建议放宽风险门限（过拟合门 / 成本门 / 三态门）来提高产出 —— 那是把门关掉，不是改进。',
  '4. 每条提案后面用 [低]/[中]/[高] 标注风险档。',
  '5. 如果这些信号里**没有值得内化的东西**，就直说"没有发现需要改的地方"，不要凑数。',
  '6. 你**不负责改代码** —— 你产出的是一份给人看的提案单，改码由人点。',
  '',
  '输出格式（严格遵守，每条三行）：',
  '提案：<一句话标题>',
  '依据：<引用的信号 + 其中的具体做法>',
  '动作：<改哪一层 + 具体做什么> [风险档]',
].join('\n')

export interface InternalizeResult {
  /** 送进模型的条目数。 */
  considered: number
  proposals: LearnProposal[]
  noteId: string | null
  writtenTo: string | null
  source: 'model' | 'rules'
  model: string | null
  /** 为什么退化。`source==='rules'` 时必须有值。 */
  degraded: string | null
  raw: string | null
  speech: string
}

/**
 * 把选中的条目交给模型 → 产内化提案 → 落进**与自学习同一份**提案单。
 *
 * ★ 三态必须分开（本项目复现过四次的坑）：
 *   · 模型产出了提案            ⇒ `proposals.length > 0`
 *   · 模型明确说"无需改进"（`[]`）⇒ `proposals.length === 0` 且 `degraded === null`
 *   · 模型没读懂 / 输出不是格式  ⇒ `parseFailed`，**必须说出来**（这是第三种事因）
 *   少了第三种的后果：一份解析失败的输出会被当成"模型说没问题"，
 *   而这两者给出的下一步完全相反（重试 vs 收工）。
 */
export async function internalizeTop(
  depsIn: Partial<NewsDeps> & { cwd: string },
  items: readonly NewsItem[],
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<InternalizeResult> {
  const deps: NewsDeps = { ...defaultDeps(depsIn.cwd), ...depsIn }
  const max = opts.max ?? 3
  const pick = [...items].sort((a, b) => b.score - a.score).slice(0, max)
  const pool = deps.pool()

  if (pick.length === 0) {
    return {
      considered: 0,
      proposals: [],
      noteId: null,
      writtenTo: null,
      source: 'rules',
      model: null,
      degraded: null,
      raw: null,
      speech: '这一轮没有条目过相关性门，所以没有可内化的东西（这不是"模型说没问题"）。',
    }
  }
  if (pool.allExhausted) {
    // ★ 额度爆了：**跳过并说明**。静默跳过会让"今天没学习"与"检查过、没东西可学"
    //   在账本上长得一模一样。
    return {
      considered: pick.length,
      proposals: [],
      noteId: null,
      writtenTo: null,
      source: 'rules',
      model: null,
      degraded: `模型额度今天用完了，所以这一轮只做了规则层筛选、没有产出内化方案。${pool.speech}`,
      raw: null,
      speech: `读到 ${pick.length} 条相关信号，但 ${pool.speech}内化方案等额度回来再写。`,
    }
  }

  const user = pick
    .map(
      (it, i) =>
        `【${i + 1}】${it.title}\n来源：${it.source}\n链接：${it.url}\n正文摘要：${it.summary}\n相关性：${it.score} 分（命中 ${it.matched.join(' / ')}）`,
    )
    .join('\n\n')
  const r = await deps.chat(NEWS_INTERNALIZE_PROMPT, user)

  let proposals: LearnProposal[] = []
  let degraded: string | null = null
  let source: 'model' | 'rules' = 'rules'
  if (r.ok && r.text) {
    source = 'model'
    const p = parseProposals(r.text)
    proposals = p.proposals
    if (p.parseFailed) {
      degraded = '模型答了，但输出不是约定格式，**一条提案都没提取到** —— 这不是"模型说没问题"。原始输出留在 raw 里。'
    }
  } else {
    degraded = `模型这条路没走通（${r.reason}），所以这一轮只有规则层筛选结果。`
  }

  const at = deps.now()
  const note: LearnNote = {
    id: `N${at.toString(36)}`,
    at,
    source,
    // ★ `observations` 里逐条带**链接与分数**：事后要能回答"这条提案是根据哪条新闻写的"。
    observations: pick.map((it) => `[${it.score}分] ${it.title} — ${it.url}（命中：${it.matched.join('/')}）`),
    proposals,
    raw: r.text,
    model: r.model,
    degraded,
    ledgerEvents: getEvents(0).length,
  }

  let writtenTo: string | null = null
  if (!opts.dryRun) {
    writtenTo = appendLearnNote(deps.cwd, note)
    appendLines(newsDigestPath(deps.cwd, at), pick.map((it) => ({ ...it, internalizedWith: note.id })))
    appendEvent('NEWS_INTERNALIZED', {
      noteId: note.id,
      source,
      considered: pick.length,
      proposals: proposals.length,
      degraded: degraded !== null,
      model: r.model,
      urls: pick.map((it) => it.url),
    })
  } else {
    // 试跑也要有一条记录 —— 否则"跑过但没写"与"没跑过"分不开。
    appendEvent('NEWS_INTERNALIZE_DRYRUN', { considered: pick.length, proposals: proposals.length })
  }

  const speech =
    proposals.length > 0
      ? `我读了 ${pick.length} 条相关信号，写下了 ${proposals.length} 条内化提案（最高分那条是「${pick[0].title}」）。提案在 data/learn/notes.jsonl，改码等你点。`
      : degraded
        ? `我读了 ${pick.length} 条相关信号，但没能写出内化方案：${degraded}`
        : `我读了 ${pick.length} 条相关信号，判断都不需要动本系统（这是模型给的结论，原始输出已留档）。`

  return { considered: pick.length, proposals, noteId: note.id, writtenTo, source, model: r.model, degraded, raw: r.text, speech }
}

// ─────────────────────────── 主入口 ───────────────────────────

export interface NewsWatchResult {
  at: number
  items: NewsItem[]
  kept: NewsItem[]
  fresh: NewsItem[]
  sources: SourceReport[]
  /** 这一轮算出的品种热度 —— 它会被写成 `data/news/trending.json`，供 breadth 取候选。 */
  trending: TickerHit[]
  internalize: InternalizeResult | null
  dryRun: boolean
  writtenTo: string | null
  speech: string
}

/**
 * 跑一轮新闻雷达。
 *
 * 顺序是刻意的：**先落盘再内化**。抓取与去重不依赖模型，
 * 所以即使后面模型那一步失败（没额度 / 输出看不懂），"今天读到了什么"这件事
 * 仍然留下了完整记录 —— 否则一次额度事故会让这一天的雷达变成空白。
 */
export async function runNewsWatch(
  depsIn: Partial<NewsDeps> & { cwd: string },
  opts: { dryRun?: boolean; maxInternalize?: number; sinceDays?: number; sources?: readonly NewsSource[] } = {},
): Promise<NewsWatchResult> {
  const base = defaultDeps(depsIn.cwd)
  const deps: NewsDeps = { ...base, ...depsIn }
  const now = deps.now()
  const sources = opts.sources ?? NEWS_SOURCES
  const sinceDays = opts.sinceDays ?? 14

  const seen = seenIds(deps.cwd)
  const raw: NewsItem[] = []
  const reports: SourceReport[] = []

  for (const src of sources) {
    const r = await collectFrom(deps, src, sinceDays)
    reports.push(r.report)
    for (const it of r.items) {
      const id = itemId(it.url)
      const sc = scoreText(`${it.title} ${it.summary}`)
      raw.push({ ...it, id, score: sc.score, matched: sc.matched, reasons: sc.reasons })
    }
  }

  const kept = raw.filter((it) => it.score >= KEEP_THRESHOLD)
  // 同一次运行里同一个 URL 可能出现两次（两个源都命中）—— 取分高的那条。
  const dedup = new Map<string, NewsItem>()
  for (const it of kept) {
    const prev = dedup.get(it.id)
    if (!prev || it.score > prev.score) dedup.set(it.id, it)
  }
  const fresh = [...dedup.values()].filter((it) => !seen.has(it.id))

  // 品种热度：用**全部抓到的条目**算（不是只用过门的那些）。
  //
  // ★ 为什么这一处刻意放宽，而别处都收紧：这份榜的用途是给 breadth 一个
  //   "去哪找候选品种"的范围，它**不是**一个交易信号 —— 缩得太紧（只看到
  //   过门的 3 条）会让它长期是空榜，那这根线就白接了。
  //   精度由 `weighted`（相关性分加权）保证：排在前面的仍然是相关信号里
  //   反复出现的品种，而只被无关条目捎带提到的会排在后面。
  const trending = tickerHeat(raw, { top: 10 })

  if (!opts.dryRun) {
    // 落盘分两份，理由不同：
    //   · seen.jsonl  —— 状态（下次不再重复提这些）
    //   · digest-<日期>.jsonl —— 当天速览（永不重命名/覆盖，可回放）
    appendLines(newsSeenPath(deps.cwd), fresh.map((it) => ({ id: it.id, at: now, title: it.title, url: it.url, score: it.score })))
    appendLines(newsDigestPath(deps.cwd, now), raw.map((it) => ({ ...it, kept: it.score >= KEEP_THRESHOLD })))
    // trending.json 是**状态**：每轮覆写（要回放就去看 digest 那几份）。
    writeTrending(deps.cwd, now, trending)
  }

  // 推送面：**每轮都写一条**事件，哪怕 0 条 —— "今天没有值得看的"本身是要说出来的事实。
  appendEvent('NEWS_DIGEST', {
    at: now,
    fetched: raw.length,
    kept: kept.length,
    fresh: fresh.length,
    sources: reports.map((r) => ({ source: r.source, ok: r.ok, got: r.got })),
    // 品种热度也进事件：这样"breadth 的候选清单是哪一轮定的"可追溯。
    trending: trending.map((h) => ({ ticker: h.ticker, mentions: h.mentions, weighted: h.weighted })),
    dryRun: opts.dryRun === true,
  })

  const internalize =
    fresh.length > 0 ? await internalizeTop(deps, fresh, { dryRun: opts.dryRun, max: opts.maxInternalize ?? 3 }) : null

  const failed = reports.filter((r) => !r.ok)
  const head =
    raw.length === 0
      ? `这一轮一个源都没拿到东西（${failed.length}/${reports.length} 个源失败）`
      : `读了 ${raw.length} 条，其中 ${kept.length} 条与本系统相关，${fresh.length} 条是新的`
  const speakTrend = trending.length > 0
    ? `品种热度前 ${Math.min(3, trending.length)} 是 ${trending.slice(0, 3).map((h) => h.ticker).join('、')}。`
    : ''
  const speech = `${head}${failed.length > 0 ? `；有 ${failed.length} 个源失败：${failed.map((f) => f.source).join('、')}` : ''}。${speakTrend}${internalize ? internalize.speech : '没有新条目，所以没有触发内化。'}`

  // 落一份**给人看、也给面板读**的报告。放在最后（speech 要等内化那一步），
  // 但它在 dryRun 时不写 —— dryRun 的定义就是"不落任何盘"。
  if (!opts.dryRun) {
    writeLastRun(deps.cwd, {
      v: 1,
      at: now,
      fetched: raw.length,
      kept: kept.length,
      fresh: fresh.length,
      dryRun: false,
      sources: reports,
      speech,
    })
  }

  return { at: now, items: raw, kept, fresh, sources: reports, trending, internalize, dryRun: opts.dryRun === true, writtenTo: newsSeenPath(deps.cwd), speech }
}

/**
 * 把一轮结果写成**给人看的**简报。
 *
 * ★ 三个数字缺一不可，因为它们回答三个不同的问题：
 *   `items` = 网通不通；`kept` = 判据在不在工作；`fresh` = 是不是重复劳动。
 *   只报一个"相关 3 条"的话，网全挂了与判据全放行在简报上长得一样（判据 24）。
 */
export function renderNewsBrief(r: NewsWatchResult): string {
  const okSources = r.sources.filter((s) => s.ok).length
  const failed = r.sources.filter((s) => !s.ok)
  const lines = [
    `读了 ${r.items.length} 条（${okSources}/${r.sources.length} 个源成功），其中 ${r.kept.length} 条与本系统相关、${r.fresh.length} 条是新的。`,
  ]
  // ★ 下面这几行必须**说清自己列的是哪一批**。原来只有干巴巴的 `· [分] 标题`，
  //   于是"3 条相关"下面跟着 2 条，读的人无从知道差的那 1 条去哪了 ——
  //   而它其实是"上一轮已经见过、入了台账"的。同一个数字两种口径却不写口径，
  //   是这类简报最容易被读错的地方（判据 17：这句话会把用户引向哪个动作？）。
  if (r.fresh.length > 0) {
    const shown = r.fresh.slice(0, 3)
    lines.push(`新的条目（这一轮第一次见到的，列前 ${shown.length} 条 / 共 ${r.fresh.length} 条）：`)
    for (const it of shown) {
      lines.push(`· [${it.score} 分] ${it.title} —— ${it.matched.slice(0, 3).join(' / ')}`)
    }
    if (r.kept.length > r.fresh.length) {
      lines.push(`（相关 ${r.kept.length} 条里另有 ${r.kept.length - r.fresh.length} 条上一轮已经见过，没在内化范围里）`)
    }
  }
  if (failed.length > 0) {
    lines.push(`失败的源（必须说出来，否则"网挂了"会被当成"今天没事"）：${failed.map((f) => `${f.source}（${f.note}）`).join('；')}`)
  }
  if (r.trending.length > 0) {
    lines.push(`品种热度：${r.trending.slice(0, 5).map((h) => `${h.ticker}(${h.weighted})`).join('、')} —— 它会成为 breadth 的候选清单`)
  }
  lines.push(r.internalize ? r.internalize.speech : '没有新条目，没有触发内化。')
  if (r.dryRun) lines.push('试跑：内化提案没有落盘。')
  return lines.join('\n')
}

/** 读回最近一轮速览（面板/语音要能回答"最近看了什么"）。 */
export function latestDigest(cwd: string, limit = 20): NewsItem[] {
  const dir = newsDir(cwd)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    // 文件名带日期 ⇒ 直接按字典序取最后一个就是最新的一份（不需要 stat；少一次系统调用）。
    files = readdirSync(dir).filter((f) => /^digest-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  } catch {
    return []
  }
  const last = files[files.length - 1]
  if (!last) return []
  try {
    return readFileSync(join(dir, last), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as NewsItem)
      .slice(-limit)
  } catch {
    return []
  }
}

// ═══════════════════════ 品种热度 ═══════════════════════
//
// 内化来源：chainpulse 的 "Trending Coins / Smart Coin Matching"、
// nlp3 的 "Ticker Analysis"、crypto-sentiment-monitor 的 "Topic Radar"。
// 它们的共同做法是：从新闻正文里**确定性**地抽出被提到的品种并排名 ——
// 而不是让模型说"最近什么热"。
//
// ── 这一块为什么不是装饰 ──────────────────────────────────────────────
// 它是新闻雷达**唯一真正接回系统行为**的一根线：抽出来的品种热度
// 直接成为 breadth（多品种）的候选清单。没有它的新闻雷达只是一个好看的
// 信息流 —— 而"信息流的读者是人"意味着它永远不会影响决策（判据 10：
// 谁在读它的输出？答不出这个名字，它就是个孤岛）。

/** 一个可被新闻提到的品种。`aliases` 与 `ticker` 都要能认出来。 */
export interface TickerTerm {
  ticker: string
  aliases: readonly string[]
  why: string
}

/**
 * 品种词表。
 *
 * ★ 只收**词边界清楚**的名字。这一步比看起来重要：本表是按子串以外、
 *   按**词边界**匹配的（见 `countTicker`），而 `SOL` / `ADA` / `DOT` / `LINK` / `OP`
 *   这几个在英文里是常见词的碎片 —— `console` 里含 `sol`、`adapt` 里含 `ada`、
 *   `linkedin` 里含 `link`、`optimistic` 里含 `op`。
 *   放进来一个"名字太普通"的品种，热度榜就会长期被某个常见英文词霸占，
 *   而这份榜是要喂给 breadth 去选交易品种的（判据 2：对正确的输入报错）。
 *   ⇒ 所以 `NEAR` / `TON` / `OP` 这类**只留全名**，不留裸 ticker。
 */
export const TICKERS: readonly TickerTerm[] = [
  { ticker: 'BTC', aliases: ['bitcoin', 'btc'], why: '大盘基准，任何因子都要先对它做超额' },
  { ticker: 'ETH', aliases: ['ethereum', 'ether', 'eth'], why: '第二大市值，本系统已在其上跑过一轮证据' },
  { ticker: 'SOL', aliases: ['solana', 'sol'], why: '高波动主流，做 breadth 的天然候选' },
  { ticker: 'BNB', aliases: ['binance coin', 'bnb'], why: '交易所生态，与资金费结构相关' },
  { ticker: 'XRP', aliases: ['ripple', 'xrp'], why: '监管题材高频出现，事件驱动可验证' },
  { ticker: 'DOGE', aliases: ['dogecoin', 'doge'], why: '情绪驱动，与新闻相关性最强的一类' },
  { ticker: 'ADA', aliases: ['cardano', 'ada'], why: '老牌主流，与 BTC 相关性较低' },
  { ticker: 'AVAX', aliases: ['avalanche', 'avax'], why: 'L1 板块代表' },
  { ticker: 'LINK', aliases: ['chainlink', 'link'], why: '预言机 / 基础设施板块' },
  { ticker: 'DOT', aliases: ['polkadot', 'dot'], why: '跨链板块代表' },
  { ticker: 'LTC', aliases: ['litecoin', 'ltc'], why: '老牌主流，流动性好' },
  { ticker: 'MATIC', aliases: ['polygon', 'matic'], why: 'L2 板块代表' },
  { ticker: 'UNI', aliases: ['uniswap', 'uni'], why: 'DEX 板块；本系统的 DEX 执行面与它同源' },
  { ticker: 'ARB', aliases: ['arbitrum', 'arb'], why: 'L2 板块代表' },
  { ticker: 'ATOM', aliases: ['cosmos', 'atom'], why: '跨链板块代表' },
]

/** 把别名编成一个"整词匹配"的正则。 */
function tickerRe(alias: string): RegExp {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 前后都不许是字母数字 —— 这就是 `console` 不算 SOL、`adapt` 不算 ADA 的原因。
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i')
}

/** 一段文字里提到了这个品种几次。 */
export function countTicker(text: string, t: TickerTerm): number {
  let n = 0
  for (const a of [t.ticker, ...t.aliases]) {
    const re = new RegExp(tickerRe(a).source, 'gi')
    const m = text.match(re)
    if (m) n += m.length
  }
  return n
}

export interface TickerHit {
  ticker: string
  /** 被提到的条目数（不是次数 —— 同一条里提三次仍算一条）。 */
  mentions: number
  /** 加权分：命中条目的相关性分之和。高频低分与低频高分是两件事。 */
  weighted: number
  /** 两条样例标题，人要能核对"它凭什么上榜"。 */
  samples: string[]
}

/**
 * 从一批条目里算出品种热度。
 *
 * ★ 排序键是 `weighted`（相关性加权），不是 `mentions`。
 *   只数次数的话，一篇列举了 15 个币的"涨幅榜"会把所有品种都顶到同一条线上；
 *   而我们要的是"与本系统相关的信号里，哪个品种反复出现"。
 */
export function tickerHeat(
  items: readonly { title: string; summary: string; score: number }[],
  opts: { minMentions?: number; top?: number } = {},
): TickerHit[] {
  const minMentions = opts.minMentions ?? 1
  const acc = new Map<string, TickerHit>()
  for (const it of items) {
    const text = `${it.title} ${it.summary}`
    for (const t of TICKERS) {
      if (countTicker(text, t) === 0) continue
      const cur = acc.get(t.ticker) ?? { ticker: t.ticker, mentions: 0, weighted: 0, samples: [] }
      cur.mentions += 1
      cur.weighted += it.score
      if (cur.samples.length < 2) cur.samples.push(it.title)
      acc.set(t.ticker, cur)
    }
  }
  return [...acc.values()]
    .filter((h) => h.mentions >= minMentions)
    .sort((a, b) => b.weighted - a.weighted || b.mentions - a.mentions)
    .slice(0, opts.top ?? 10)
}

/** 品种热度落盘处（**状态**，每轮覆写；要追溯去看 digest-*.jsonl）。 */
export function newsTrendingPath(cwd: string): string {
  return join(newsDir(cwd), 'trending.json')
}

export function writeTrending(cwd: string, at: number, ticks: TickerHit[]): void {
  mkdirSync(newsDir(cwd), { recursive: true })
  writeFileSync(newsTrendingPath(cwd), JSON.stringify({ v: 1, at, ticks }, null, 2))
}

export function readTrending(cwd: string): { at: number; ticks: TickerHit[] } | null {
  const p = newsTrendingPath(cwd)
  if (!existsSync(p)) return null
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as { at?: number; ticks?: TickerHit[] }
    if (!Array.isArray(o.ticks)) return null
    return { at: Number(o.at ?? 0), ticks: o.ticks }
  } catch {
    // 读不懂就是读不懂 —— 返回 null 让上层说"读不到"，不要返回一个空榜
    // 假装"最近没有任何品种被提到"（判据 13：读路径静默陈旧最危险）。
    return null
  }
}

/**
 * 最近一轮跑完的**报告**（不是状态）。
 *
 * ══ 为什么要落盘，而不是留在内存的事件里 ═══════════════════════════════
 * 这件事是**实测发现的**：来源情报原来从 `NEWS_DIGEST` 事件里取各源的 `got`/`ok`，
 * 而事件是 `ledger.ts` 里的**进程内存**。编排器一重启，那一轮的事件就没了 ——
 * 于是面板把 5 个源全画成「0 条」，而这一栏的用途正是"哪个源该留、哪个该换词"。
 * 更要紧的是它**看起来完全正常**：0 条是个合法数字，与"源真的什么都没拿到"
 * 长得一模一样，而两者的下一步完全相反（等下一轮 vs 去改源）（判据 24）。
 *
 * 所以：**跑一轮就落一份报告**，面板只读这份报告。
 * `ok=false`（没通）与 `got=0`（通了但没有）在报告里是两个字段，不许合并。
 */
export interface NewsLastRun {
  v: 1
  at: number
  /** 这一轮抓到几条（去重前）。 */
  fetched: number
  /** 几条过了相关性门。 */
  kept: number
  /** 几条是这 14 天里没见过的（= 这一轮真的干了活）。 */
  fresh: number
  dryRun: boolean
  sources: SourceReport[]
  speech: string
}

export function newsLastRunPath(cwd: string): string {
  return join(newsDir(cwd), 'last-run.json')
}

export function writeLastRun(cwd: string, r: NewsLastRun): void {
  mkdirSync(newsDir(cwd), { recursive: true })
  writeFileSync(newsLastRunPath(cwd), JSON.stringify(r, null, 2))
}

/**
 * 读最近一轮的报告。
 *
 * `null` 的两种含义（**上层必须分开说**）：
 *   · 文件不存在 —— 这个工作目录还从来没跑过一轮；
 *   · 文件读不懂 —— 跑过，但记录坏了。
 * 这里都返回 null，但**不许**把它当成"各源都抓了 0 条"（判据 13）。
 */
export function readLastRun(cwd: string): NewsLastRun | null {
  const p = newsLastRunPath(cwd)
  if (!existsSync(p)) return null
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as Partial<NewsLastRun>
    if (typeof o.at !== 'number' || !Array.isArray(o.sources)) return null
    return {
      v: 1,
      at: o.at,
      fetched: Number(o.fetched ?? 0),
      kept: Number(o.kept ?? 0),
      fresh: Number(o.fresh ?? 0),
      dryRun: o.dryRun === true,
      sources: o.sources,
      speech: String(o.speech ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * 给 breadth（多品种）的候选清单。
 *
 * ★ 这是新闻雷达**唯一直接改系统行为**的出口。它只给候选，不决定用哪些 ——
 *   "用哪些品种去交易"要过 `breadth` 自己的证据门（数据够不够、成本扛不扛得住），
 *   新闻热度只是把**搜索空间**缩小到有信息的地方。
 * ★ 空榜与读不到必须分开说：前者是"这轮没有品种被提到"，后者是"我没读到"。
 */
export function suggestedUniverse(cwd: string, max = 8): { symbols: string[]; note: string } {
  const t = readTrending(cwd)
  if (!t) {
    return { symbols: [], note: '没读到品种热度（trending.json 不存在或读不懂）—— 这与"最近没有品种被提到"是两件事' }
  }
  if (t.ticks.length === 0) {
    return { symbols: [], note: '最近这一轮没有任何品种被提到 —— 这是空榜，不是读不到' }
  }
  const symbols = t.ticks.slice(0, max).map((h) => `${h.ticker}USDT`)
  return {
    symbols,
    note: `取自 ${new Date(t.at).toISOString().slice(0, 16)} 那一轮：${t.ticks
      .slice(0, max)
      .map((h) => `${h.ticker}(相关分 ${h.weighted})`)
      .join('、')}`,
  }
}

// ═══════════════════════ 人对提案的裁决 ═══════════════════════
//
// 内化来源：参考控制台的「人类决策队列 · 治理留痕」。
// 它的做法值得抄：**机器的建议与人的裁决分成两份记录**，
// 人的那一份带时间与理由，事后能回答"这条是谁拍的、什么时候拍的"。
//
// ── 为什么这是"闭环"的最后一环 ────────────────────────────────────────
// 上一轮这条件是**半闭环**：新闻雷达写提案，然后……没有然后。
// 提案单没有任何读者，"内化"就停在"我学到了"这句话上。
// 现在：提案 → 面板上看得见 → 人点确认/驳回 → 裁决落进**独立的一份追加记录**
// → 待办数被启动器与语音读出来（有名字的读者）。

export type ProposalDecision = 'approve' | 'reject'

/** 一次人的裁决。 */
export interface NewsVerdict {
  /** 哪一份提案单（`LearnNote.id`）。 */
  noteId: string
  /** 该提案单里的第几条（从 0 起）。 */
  index: number
  decision: ProposalDecision
  at: number
  /** 谁拍的。留空则记 `operator` —— 但字段必须存在，"谁拍的"不能没有答案。 */
  by: string
  why: string | null
}

/** 裁决记录（append-only，独立于提案单）。 */
export function newsVerdictPath(cwd: string): string {
  return join(newsDir(cwd), 'verdicts.jsonl')
}

export function proposalKey(noteId: string, index: number): string {
  return `${noteId}#${index}`
}

function validate(noteId: string, index: number): void {
  if (!noteId) throw new Error('裁决必须指出是哪一份提案单（noteId）')
  if (!Number.isInteger(index) || index < 0) throw new Error(`提案序号必须是非负整数，收到 ${index}`)
}

export function appendNewsVerdict(cwd: string, v: NewsVerdict): string {
  validate(v.noteId, v.index)
  const p = newsVerdictPath(cwd)
  mkdirSync(newsDir(cwd), { recursive: true })
  appendFileSync(p, JSON.stringify(v) + '\n')
  appendEvent('NEWS_PROPOSAL_VERDICT', {
    noteId: v.noteId,
    index: v.index,
    decision: v.decision,
    by: v.by,
    why: v.why,
  })
  return p
}

export function readNewsVerdicts(cwd: string): Map<string, NewsVerdict> {
  const out = new Map<string, NewsVerdict>()
  const p = newsVerdictPath(cwd)
  if (!existsSync(p)) return out
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const v = JSON.parse(s) as NewsVerdict
        // 后写的覆盖先写的：同一条被改过主意时，**最新的那次**才算数，
        // 但旧记录仍然在文件里（append-only ⇒ 改主意这件事本身可追溯）。
        out.set(proposalKey(v.noteId, v.index), v)
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 读不到当没有 */
  }
  return out
}

/** 面板上的一行提案（提案本体 + 人的裁决 + 它依据了哪些观察）。 */
export interface ProposalRow {
  noteId: string
  index: number
  at: number
  /** `model` = 模型写的；`rules` = 只有规则层（**必须显示出来**）。 */
  source: 'model' | 'rules'
  title: string
  evidence: string
  action: string
  risk: 'low' | 'middle' | 'high'
  observations: string[]
  decision: ProposalDecision | null
  decidedAt: number | null
  decidedBy: string | null
  decisionWhy: string | null
}

/** 读提案单（与自学习**同一份**）。读不懂的行跳过而不是抛。 */
export function readLearnNotes(cwd: string, limit = 40): LearnNote[] {
  const p = learnNotesPath(cwd)
  if (!existsSync(p)) return []
  try {
    return readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LearnNote
        } catch {
          return null
        }
      })
      .filter((n): n is LearnNote => n !== null)
      .slice(-limit)
  } catch {
    return []
  }
}

/**
 * 把提案单与裁决合成面板要的行。
 *
 * ★ 编号按**文件顺序**（第几行就是第几号），而不是按读取顺序 ——
 *   裁决记录里存的是这个序号，两边必须用同一个编号方式，
 *   否则"确认第 2 条"会指到另一条上（判据 8：两条实现路径）。
 */
export function proposalRows(cwd: string, limit = 40): ProposalRow[] {
  const notes = readLearnNotes(cwd, limit)
  const verdicts = readNewsVerdicts(cwd)
  const rows: ProposalRow[] = []
  for (const n of notes) {
    n.proposals.forEach((p, i) => {
      const v = verdicts.get(proposalKey(n.id, i)) ?? null
      rows.push({
        noteId: n.id,
        index: i,
        at: n.at,
        source: n.source,
        title: p.title,
        evidence: p.evidence,
        action: p.action,
        risk: p.risk,
        observations: n.observations.slice(0, 4),
        decision: v ? v.decision : null,
        decidedAt: v ? v.at : null,
        decidedBy: v ? v.by : null,
        decisionWhy: v ? v.why : null,
      })
    })
  }
  return rows
}

/** 还没被人裁决的提案数。启动器与语音读它。 */
export function pendingProposalCount(cwd: string): number {
  return proposalRows(cwd).filter((r) => r.decision === null).length
}

/** 读不到提案单时的说法：**不许**把"读不到"说成"没有待办"。 */
export function pendingSpeech(cwd: string): string {
  const p = learnNotesPath(cwd)
  if (!existsSync(p)) return '还没有任何提案单（不是"没有待办"，是这份清单还没建起来）'
  const rows = proposalRows(cwd)
  if (rows.length === 0) return '提案单是空的 —— 没有待你点的东西'
  const pending = rows.filter((r) => r.decision === null).length
  const approved = rows.filter((r) => r.decision === 'approve').length
  if (pending === 0) return `${rows.length} 条提案全部裁决过了（确认 ${approved} 条），没有待办`
  return `${pending} 条提案等你点（一共 ${rows.length} 条，已确认 ${approved} 条）`
}

