/**
 * 受控出网 —— 桌宠「能联网」的唯一出口
 *
 * ── 为什么必须是"受控"，而不是一个 fetch 包装 ──────────────────────────
 * 一旦这个系统能自己发请求，它面对的第一件事就是 **SSRF**：
 * 一条"帮我抓一下 http://169.254.169.254/latest/meta-data/"的指令，
 * 在云主机上会直接把实例元数据（里面通常有临时凭据）读回来。
 * 而 `http://127.0.0.1:8790/...` 这种回环地址更近 —— 那是**它自己**，
 * 并且带着本地令牌就能改风控参数。
 *
 * 所以这里有三层，缺一层都不算实现：
 *   ① **协议白名单**：只允许 http/https（挡住 file:// 与 gopher:// 这类协议级绕过）；
 *   ② **地址判据**：先把域名解析成 IP，逐个拒掉回环 / 私网 / 链路本地 /
 *      云元数据段。★ 判据必须在**解析之后**看 IP —— 只看域名的话，
 *      `foo.example.com` 之类解析到 127.0.0.1 的名字会直接绕过；
 *   ③ **域名白名单**：只有登记过的域才出得去。它是"能访问什么"的显式清单，
 *      不是安全边界（安全边界是 ②）—— 所以它允许通过环境变量扩展，
 *      但**不改成"未登记的一律放行"**。
 *
 * ── 一个实测出的事实，决定了白名单的内容 ──────────────────────────────
 * 本机实测（2026-09-19）能直连的只有一部分站点：`data-api.binance.vision`、
 * `openrouter.ai`、`api.github.com`、`www.bing.com`、`api.frankfurter.app`、
 * `mempool.space`、`api.llama.fi` 可达；而 `zh.wikipedia.org`、`api.coingecko.com`、
 * `api.duckduckgo.com`、`raw.githubusercontent.com` **超时**（本机没有代理在跑）。
 * ⇒ 白名单里放一堆"看起来应该能通"的域名，只会让每次查询都失败一次；
 *   所以名单就是**实测可达且有实际用处**的那一批。
 *
 * ── 失败要说清是哪一种 ────────────────────────────────────────────────
 * 「联网失败」这四个字对用户没有用。这里把失败分成：不在白名单 / 域名解析不了 /
 * 解析到内网地址被拒 / 请求超时 / 目标返回非 2xx / 正文被截断。
 * 每一种都能被念出来，也都能被断言。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { appendEvent, getEvents } from '../ledger.ts'

/** 实测可达且有用的域名后缀。子域自动匹配（`api.github.com` 归 `github.com`）。 */
export const DEFAULT_ALLOWED_SUFFIXES: readonly string[] = [
  'data-api.binance.vision', // 行情（本系统已有引用，属同一个数据面）
  'openrouter.ai', // 模型网关（可用性探针走它）
  'api.github.com', // 开源仓库信息（对标与依赖查证）
  'bing.com', // 通用网页搜索（www 会 302 到 cn）
  'frankfurter.app', // 汇率
  'er-api.com', // 汇率（备用）
  'mempool.space', // 比特币链上状态
  'blockchain.info', // 链上状态（备用）
  'llama.fi', // DeFi TVL
  'example.com', // 连通性自检：一个永远不会变的页面
  // ── Telegram：手机端远程指挥的那条链路（2026-09-23 加入默认名单）─────────
  // ★ 为什么进**默认**名单而不是靠 `EV_EGRESS_HOSTS`：
  //   手机远程控制是本系统的一个**产品能力**，不是一个可选的外部依赖。
  //   放进环境变量的话，用户配好 bot token 之后第一次发消息，得到的会是
  //   「被出网白名单拦下了」—— 而他没有任何线索知道要去改一个环境变量名。
  //   这条通道**只有出网**（long polling 主动去拉），本机不开任何入站端口。
  //
  // ★★ **允许出网 ≠ 允许任何人下指令。** 这是两个完全独立的门：
  //   · 这一层只管「本机能不能连到 api.telegram.org」；
  //   · 「谁说的话算数」由 `server/voice/telegram.ts` 的**会话白名单**决定，
  //     且那份白名单**默认为空**（谁都不放行）。
  //   把这两件事混成一件（例如"能连上就认为可信"）会让任何找到这个 bot
  //   的人都能对 EVOLVE 下单 —— 那是本系统最不能出的一种错。
  'api.telegram.org',
]

/**
 * 额外白名单（逗号分隔的后缀）。扩展是显式的、由人决定的 ——
 * 这里刻意**不**读取 `*` 或"允许全部"这类开关。
 */
function extraSuffixes(): string[] {
  return (process.env.EV_EGRESS_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

export function allowedSuffixes(): string[] {
  return [...DEFAULT_ALLOWED_SUFFIXES, ...extraSuffixes()]
}

/** 正文上限。抓一整个 90KB 的搜索结果页已经够用，再大就不是"查证"而是"下载"。 */
export const MAX_BODY_BYTES = 512 * 1024
export const DEFAULT_TIMEOUT_MS = 20_000

const UA = 'EvolveAssistant/1.0 (+local research; contact: local user)'

export type EgressFailure =
  | 'BAD_URL'
  | 'SCHEME_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'DNS_FAILED'
  | 'PRIVATE_ADDRESS'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'EMPTY_BODY'

export interface EgressResult {
  ok: boolean
  url: string
  host: string
  status: number | null
  /** 正文（HTML 已剥标签）。失败时为空串。 */
  text: string
  /**
   * 原始正文（未剥标签，仍受 `maxBytes` 上限约束）。
   *
   * ★ 它是被一个**真实缺陷**逼出来的：搜索解析原本读的是 `text`，
   *   而 `text` 已经把标签剥掉了 —— 于是解析器在一个没有 `<h2>` 的字符串里
   *   找 `<h2>`，永远得到 0 条，并且报出来的话还很像模像样
   *   （"拿到了 95554 字节的结果页，但一条结果都没解析出来"）。
   *   需要结构化内容的调用方必须读 `raw`，不要读 `text`。
   */
  raw: string
  /** 原始字节数（截断前）。 */
  bytes: number
  /** 是否因为超过上限被截断 —— 截断必须说出来，不能悄悄少一段。 */
  truncated: boolean
  reason?: EgressFailure
  /** 可念的失败说明。 */
  note: string
}

/** 判断域名是否落在白名单里（后缀匹配，且要求是**域名边界**匹配）。 */
export function hostAllowed(host: string, suffixes: readonly string[] = allowedSuffixes()): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return suffixes.some((s) => h === s || h.endsWith('.' + s))
}

/** 是不是"不该被访问到的地址"。判据针对 IP 字面量，域名要先解析。 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.some((n) => !Number.isFinite(n))) return true
    const [a, b] = p
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // 链路本地 + **云元数据 169.254.169.254**
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // 组播 / 保留
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === '::' || s === '::1') return true
    if (s.startsWith('fe80')) return true // 链路本地
    if (/^f[cd]/.test(s)) return true // 唯一本地
    // IPv4 映射地址（::ffff:127.0.0.1）—— 不拦就等于绕过了上面整段判断
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (m) return isPrivateAddress(m[1])
    return false
  }
  return true // 认不出来的当危险处理
}

/** 极简 HTML → 文本。只做去标签 / 去脚本 / 去注释 / 折叠空白，不做渲染。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export interface FetchPageOptions {
  timeoutMs?: number
  maxBytes?: number
  /** 依赖注入：测试用它造出"解析到内网"这类输入，而不需要真的配一次 DNS。 */
  resolve?: (host: string) => Promise<string[]>
  fetchImpl?: typeof fetch
  suffixes?: readonly string[]
  /**
   * 记账前要**抹掉**的串（调用方 URL 里的凭据）。
   *
   * ★★ 它是被一个真实缺陷逼出来的：账本里的 `EGRESS_BLOCKED` / `EGRESS_FAILED`
   *   事件会带上 `url`，而 Telegram 的 bot token **就住在 URL 的路径里**
   *   （`/bot<token>/getUpdates`）。于是"一次被白名单拦下的轮询"会把控制权
   *   写进账本 —— 而账本恰恰是本机最持久、最可能被导出的一份文件。
   *
   * ★ 为什么是"抹串"而不是"给一个替代 URL"：URL 会出现在**不止一个字段**里
   *   （`url` 字段、`BAD_URL` 的说明、重定向说明、各种 note）。
   *   只换 `url` 字段的话，一句 `${host} 不行：${rawUrl}` 就把凭据又带回来了。
   *   抹串只写一遍，而且覆盖**所有**出口 —— 包括将来新加的出口。
   *
   * ★ 默认不抹。默认值刻意保守：这条通道不可能猜到哪个串是凭据，
   *   所以每一个"URL 里带凭据"的调用方都**必须显式说**（说不说这件事
   *   在烟测里有配对断言钉着）。
   */
  redact?: readonly string[]
}

/**
 * 抓一个页面。
 *
 * ★ **不跟随重定向**：`redirect: 'manual'`。跟随的话，白名单里的域名可以
 *   用一次 302 把请求引到任何地方 —— 而白名单是"能去哪"的清单，
 *   一条能被绕过的清单不算清单。
 */
export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<EgressResult> {
  const suffixes = opts.suffixes ?? allowedSuffixes()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES
  const doFetch = opts.fetchImpl ?? fetch
  const resolve = opts.resolve ?? defaultResolve
  const redact = opts.redact ?? []

  const fail = makeFail(rawUrl, redact)

  // ★ 三层判据（协议 → 白名单 → 解析后看地址）抽成 `preflight` 一份，
  //   POST 那条路（告警外发）走的是**同一份**。两份校验迟早只有一份是最新的，
  //   而旧的那份会安静地放行 —— 这正是 SSRF 的入口形态。
  const guard = await preflight(rawUrl, suffixes, resolve, fail)
  if (!guard.ok) return guard.blocked
  const u = guard.u
  const host = guard.host

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await doFetch(u.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' },
      signal: ac.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? ''
      // ★ 重定向不再"一律拒绝"，而是**重新走一遍全部判据**（见下方 followRedirect）。
      //   起初这里是直接拒绝的，理由是"白名单会被一次 302 绕过" —— 那个理由成立，
      //   但它的正确解法是"每一跳都重新校验"，而不是"不支持重定向"：
      //   实测 www.bing.com 会 302 到 cn.bing.com，一律拒绝等于把搜索整条功能废掉。
      //   校验逻辑与首跳**同一份代码**，所以绕过的可能性不会因为多一跳而增加。
      if (loc.length === 0) return fail('HTTP_ERROR', `${host} 返回 ${res.status} 但没给跳转目标`, host, res.status)
      return await followRedirect(new URL(loc, u).toString(), host, {
        suffixList: suffixes,
        maxBytes,
        timeoutMs,
        resolve,
        doFetch,
        depth: 0,
      })
    }
    if (!res.ok) {
      return fail('HTTP_ERROR', `${host} 返回 ${res.status} ${res.statusText}`, host, res.status)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const truncated = buf.length > maxBytes
    const slice = truncated ? buf.subarray(0, maxBytes) : buf
    const ctype = res.headers.get('content-type') ?? ''
    const raw = slice.toString('utf8')
    const text = /json|text\/plain|xml/i.test(ctype) ? raw.trim() : htmlToText(raw)
    if (text.length === 0) return fail('EMPTY_BODY', `${host} 返回了空正文（${buf.length} 字节）`, host, res.status)
    return {
      ok: true,
      url: u.toString(),
      host,
      status: res.status,
      text,
      raw,
      bytes: buf.length,
      truncated,
      note: `${host} 返回 ${res.status}，${buf.length} 字节${truncated ? `（超过 ${maxBytes} 字节上限，已截断）` : ''}`,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/abort/i.test(msg)) return fail('TIMEOUT', `${host} 在 ${timeoutMs} 毫秒内没有回应`, host)
    return fail('HTTP_ERROR', `${host} 请求失败：${msg.slice(0, 120)}`, host)
  } finally {
    clearTimeout(timer)
  }
}

type FailFn = (reason: EgressFailure, note: string, host?: string, status?: number | null) => EgressResult

/**
 * 造一个失败结果 —— **并且把这次拦截/失败记进账本**。
 *
 * ★★ 拦截必须留痕，而且**"被拦"与"没通"要分成两种事件**（内化自 2026-09-19
 *   日报 ③⑤ 两条的同一句话：「被拦的异常地址常是首个告警信号」）。
 *   · 被拦（不在白名单 / 解析到内网 / 协议不对）⇒ 这是**安全信号**：
 *     说明有东西在让本系统访问它不该访问的地址，要人看一眼；
 *   · 没通（超时 / DNS 失败 / 对端非 2xx）⇒ 只是网络问题。
 *   合并成一类的话，真正的告警会被每天的普通网络抖动淹没 —— 而"被淹没的告警"
 *   与"没有告警"在界面上完全一样。
 *
 * ★ 抽成独立函数（而不是留在 `fetchPage` 里的闭包）是因为它现在有**两个调用方**：
 *   `fetchPage`（读）与 `postJson`（告警外发）。留成闭包的话第二个调用方
 *   要么复制一份判据、要么就**没有账本** —— 而"告警发不出去"恰恰是最需要留痕的一件事。
 */
function makeFail(rawUrl: string, redact: readonly string[] = []): FailFn {
  // ★ 抹串在**写账本之前**做，且同时作用于 `url` 与 `note` —— 见
  //   `FetchPageOptions.redact` 的注释：凭据会从不止一个字段漏出去。
  const scrub = (s: string): string => {
    let out = s
    for (const r of redact) if (r.length > 0) out = out.split(r).join('＜已隐去＞')
    return out
  }
  return (reason, note, host = '', status = null) => {
    const blocked = reason === 'HOST_NOT_ALLOWED' || reason === 'PRIVATE_ADDRESS' || reason === 'SCHEME_NOT_ALLOWED'
    try {
      appendEvent(blocked ? 'EGRESS_BLOCKED' : 'EGRESS_FAILED', {
        reason,
        host: host || null,
        url: scrub(rawUrl).slice(0, 200),
        note: scrub(note).slice(0, 200),
      })
    } catch {
      /* 记账失败不许改变出网本身的结论：结论是"没拿到"，不是"记账失败" */
    }
    return {
      ok: false,
      // ★ 返回值里的 url 是**给调用方自己看**的，保持原样（它手上本来就有）；
      //   被抹掉的是**落盘的那一份**。抹返回值等于让"到底是哪个 URL 失败了"
      //   变成不可调试 —— 而调试用的信息不需要落盘。
      url: rawUrl,
      host,
      status,
      text: '',
      raw: '',
      bytes: 0,
      truncated: false,
      reason,
      note,
    }
  }
}

type Preflight = { ok: true; u: URL; host: string } | { ok: false; blocked: EgressResult }

/**
 * 出网三层判据的**唯一实现**：协议白名单 → 域名白名单 → 解析后看地址。
 *
 * ★ 顺序不可换（每一层都有它专属的绕过形态）：
 *   ① 先卡协议 —— `file://`、`gopher://` 这类在解析层面就绕过后面两层；
 *   ② 再卡域名 —— 不在名单里的域名连 DNS 都不该查（查了就是一次信息泄漏）；
 *   ③ **最后**看地址，且必须在 `resolve` 之后 —— 只看域名的话，
 *      `foo.example.com` 之类解析到 127.0.0.1 的名字直接绕过第二层。
 */
async function preflight(
  rawUrl: string,
  suffixes: readonly string[],
  resolve: (host: string) => Promise<string[]>,
  fail: FailFn,
): Promise<Preflight> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, blocked: fail('BAD_URL', `这不是一个合法的网址：${rawUrl.slice(0, 80)}`) }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, blocked: fail('SCHEME_NOT_ALLOWED', `只允许 http 与 https，不接受 ${u.protocol}`, u.hostname) }
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!hostAllowed(host, suffixes)) {
    return {
      ok: false,
      blocked: fail(
        'HOST_NOT_ALLOWED',
        `${host} 不在出网白名单里。名单是 ${suffixes.join('、')}；要加域名请设 EV_EGRESS_HOSTS`,
        host,
      ),
    }
  }
  let addrs: string[]
  try {
    addrs = await resolve(host)
  } catch {
    return { ok: false, blocked: fail('DNS_FAILED', `${host} 解析不了（本机可能没有到它的网络路径）`, host) }
  }
  if (addrs.length === 0) return { ok: false, blocked: fail('DNS_FAILED', `${host} 没有解析到任何地址`, host) }
  const bad = addrs.find((a) => isPrivateAddress(a))
  if (bad) {
    return {
      ok: false,
      blocked: fail('PRIVATE_ADDRESS', `${host} 解析到内网地址 ${bad}，按不回环、不进内网的原则拒绝了这次请求`, host),
    }
  }
  return { ok: true, u, host }
}

/** 最多跟三跳。再多就不像"查证一件事"，更像被牵着走。 */
const MAX_REDIRECTS = 3

interface RedirectCtx {
  suffixList: readonly string[]
  maxBytes: number
  timeoutMs: number
  resolve: (host: string) => Promise<string[]>
  doFetch: typeof fetch
  depth: number
}

/**
 * 跟一跳重定向 —— **重新走一遍协议 / 白名单 / 地址三层判据**。
 * 这里刻意复用 `fetchPage` 本身，而不是另写一份简化版校验：
 * 两份校验迟早只有一份是最新的，而旧的那份会安静地放行。
 */
async function followRedirect(target: string, fromHost: string, c: RedirectCtx): Promise<EgressResult> {
  if (c.depth >= MAX_REDIRECTS) {
    return {
      ok: false,
      url: target,
      host: fromHost,
      status: null,
      text: '',
      raw: '',
      bytes: 0,
      truncated: false,
      reason: 'HTTP_ERROR',
      note: `${fromHost} 连续跳了 ${MAX_REDIRECTS} 次还没到终点，我不再跟了`,
    }
  }
  const r = await fetchPage(target, {
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytes,
    resolve: c.resolve,
    fetchImpl: c.doFetch,
    suffixes: c.suffixList,
  })
  if (r.ok) return r
  // 重定向目标被三层判据挡下：把"从哪跳过来的"写进说明，否则用户只看到
  // 一个他没听说过的域名被拒，会以为是系统乱发请求。
  return { ...r, note: `${fromHost} 跳到了 ${r.host}，但${r.note}` }
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isIP(host)) return [host]
  const r = await lookup(host, { all: true, verbatim: true })
  return r.map((x) => x.address)
}

// ─────────────────────── 受控 POST（告警外发） ───────────────────────

export interface PostJsonResult {
  ok: boolean
  host: string
  status: number | null
  reason?: EgressFailure
  note: string
}

/**
 * 受控通道里**唯一**允许 POST 的一个口子 —— 给告警 webhook 用。
 *
 * ── 为什么它必须走这里，而不是在调用点直接 `fetch` ────────────────────
 * `ALERT_WEBHOOK_URL` 的目标域**由环境变量给**，也就是**由配置决定的任意主机**。
 * 那个字符串一旦被写错或被别人改掉（比如指向 `http://127.0.0.1:8790/risk`），
 * 直连 `fetch` 会把**系统内部事件**（SLO 违约细节、权益、订单拒绝率）
 * 送到一个我们既没登记、也没校验过的地方去。这是本仓库里唯一一类
 * **把内部数据送出去**的通道，所以它必须和"联网查资料"共用同一套三层判据。
 *
 * ── 与 `fetchPage` 的两处刻意不同 ────────────────────────────────────
 *   ① **不跟随重定向**：POST 跟一跳之后，303/302 会把方法**降级成 GET**
 *      （HTTP 的历史包袱），等于把告警正文悄悄丢掉，而对端还回 200。
 *      所以遇到 3xx 就明确失败，把"跳哪儿去了"写进说明。
 *   ② **不看正文**：告警是单向的，回什么内容与"有没有送到"无关；
 *      只看状态码。要正文的调用方该用 `fetchPage`。
 *
 * ── 失败也要留痕 ─────────────────────────────────────────────────────
 * 所有失败（被拦 / 没通 / 非 2xx / 超时）都经 `makeFail` 记账 ——
 * 与读路径同一份实现。"告警发不出去"这件事如果只留在调用点的 catch 里，
 * 那就等于没有告警（判据 C7：缺数据要说出来，而且是**每一处**都说了）。
 */
export async function postJson(rawUrl: string, payload: unknown, opts: FetchPageOptions = {}): Promise<PostJsonResult> {
  const suffixes = opts.suffixes ?? allowedSuffixes()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  const resolve = opts.resolve ?? defaultResolve
  // ★ 这一行与读路径**同一份**（`fetchPage` 里也有一份）。
  //   我第一版就漏了它：`fetchPage` 改了、`postJson` 没改，于是
  //   "发消息失败"那条路上的凭据照样落盘 —— 而读路径的断言全绿。
  //   烟测里那条"整份账本序列化里不许有凭据"正是这么抓出来的。
  const fail = makeFail(rawUrl, opts.redact ?? [])
  const fromFail = (r: EgressResult): PostJsonResult => ({
    ok: false,
    host: r.host,
    status: r.status,
    reason: r.reason,
    note: r.note,
  })

  const guard = await preflight(rawUrl, suffixes, resolve, fail)
  if (!guard.ok) return fromFail(guard.blocked)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await doFetch(guard.u.toString(), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'user-agent': UA, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') ?? '（没给目标）'
      return fromFail(
        fail('HTTP_ERROR', `${guard.host} 回了 ${res.status} 跳转到 ${loc.slice(0, 80)}；POST 不跟随重定向（跟着会把方法降级成 GET、正文丢掉）`, guard.host, res.status),
      )
    }
    if (!res.ok) {
      return fromFail(fail('HTTP_ERROR', `${guard.host} 返回 ${res.status} ${res.statusText}`, guard.host, res.status))
    }
    return { ok: true, host: guard.host, status: res.status, note: `${guard.host} 已接收（HTTP ${res.status}）` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/abort/i.test(msg)) {
      return fromFail(fail('TIMEOUT', `${guard.host} 在 ${timeoutMs} 毫秒内没有回应`, guard.host))
    }
    return fromFail(fail('HTTP_ERROR', `${guard.host} 请求失败：${msg.slice(0, 120)}`, guard.host))
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────── 通用搜索 ───────────────────────────

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/**
 * 用 Bing 的 HTML 端点做一次通用搜索。
 *
 * ── 为什么是它，而不是某个"搜索 API" ──────────────────────────────────
 * 实测本机可达的搜索入口里，`api.duckduckgo.com` 与 `zh.wikipedia.org` 都超时，
 * 而 `www.bing.com/search` 返回 200 与 89KB 真实结果页。
 * 不用需要付费/需要密钥的方案，是因为这一条链路的定位是"查证一件事"，
 * 不值得为它再引入一个可能过期的凭据。
 *
 * ── 解析失败要说出来 ──────────────────────────────────────────────────
 * 结果页结构随时会变。解析出 0 条时**不返回空数组当答案**，而是给
 * `parseFailed` —— 因为"这次没搜到"和"页面结构变了导致我没读懂"
 * 是两件事，后者需要人去改解析器。
 */
export interface SearchResult {
  ok: boolean
  query: string
  hits: SearchHit[]
  /** 拿到了页面但一条也没解析出来 —— 与"搜不到"必须分开。 */
  parseFailed: boolean
  note: string
}

/**
 * 从 Bing 结果页里取出条目。
 *
 * ── 为什么不写成"匹配 `<li class="b_algo">` 块" ────────────────────────
 * 第一版就是这么写的，实测在 cn.bing.com 上一条也取不到（结构里确实有
 * 8 个 `b_algo`，但块级正则没匹配上），而失败信息看起来还很有道理。
 * 现在改成**锚一段更稳定的东西**：结果标题永远是
 * `<h2 ...><a href="...">标题</a></h2>`，摘要在它之后的 `<p ...>` 里。
 * 这个形状对中英文两个入口都成立。
 *
 * ★ 摘要只在标题之后 **900 字符**内找。不设这个窗口的话，遇到没有摘要的
 *   条目会把**下一条**的摘要挂到这一条上 —— 一个张冠李戴的结果比没有结果更坏。
 */
export function extractBingHits(html: string, limit = 6): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const headRe = /<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi
  let m: RegExpExecArray | null
  while ((m = headRe.exec(html)) !== null) {
    const url = decodeEntities(m[1])
    // Bing 会把结果链接包一层跳转；只收直接指向外站的，避免把自家导航当结果。
    if (!/^https?:\/\//.test(url)) continue
    if (/(^https?:\/\/(www\.)?bing\.com)|(^https?:\/\/go\.microsoft\.com)/i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const title = htmlToText(m[2]).slice(0, 160)
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 900)
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(rest)
    hits.push({ title, url, snippet: p ? htmlToText(p[1]).slice(0, 320) : '' })
    if (hits.length >= limit) break
  }
  return hits
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export async function webSearch(query: string, opts: FetchPageOptions & { limit?: number } = {}): Promise<SearchResult> {
  const q = query.trim()
  if (q.length < 2) return { ok: false, query: q, hits: [], parseFailed: false, note: '查询词太短，至少两个字' }
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN'
  const r = await fetchPage(url, opts)
  if (!r.ok) return { ok: false, query: q, hits: [], parseFailed: false, note: r.note }
  // ★ 读 `raw` 而不是 `text`：解析器要的是标签结构，而 `text` 已经把它们剥掉了。
  const hits = extractBingHits(r.raw, opts.limit ?? 6)
  if (hits.length === 0) {
    return {
      ok: false,
      query: q,
      hits: [],
      parseFailed: true,
      note: `拿到了 ${r.bytes} 字节的结果页，但一条结果都没解析出来。这通常是页面结构变了，不是"没有结果" —— 需要有人改解析器`,
    }
  }
  return { ok: true, query: q, hits, parseFailed: false, note: `搜到 ${hits.length} 条（来源 ${r.host}）` }
}

// ─────────────────────── 出网审计（拦截要能被告警） ───────────────────────

export interface EgressAudit {
  /** 被拦下的调用（安全信号，要人看一眼）。 */
  blocked: { reason: string; host: string | null; url: string; at: number }[]
  /** 只是没通（网络问题）。 */
  failed: { reason: string; host: string | null; at: number }[]
  blockedCount: number
  failedCount: number
  /** 被拦得最多的域名 —— 它就是"有人在让系统碰不该碰的东西"的第一嫌疑。 */
  topBlockedHost: string | null
  note: string
}

/**
 * 审计读数的人话。
 *
 * ★ 抽成独立函数**是为了两种情形都能被断言**（有拦截 / 一条都没有）。
 *   留在 `egressAudit` 里的话，"没有拦截时它说什么"就只能靠真的去清空账本，
 *   而那在测试里做不到 —— 一条喂不到的判据（判据 5）。
 */
export function egressAuditNote(blockedCount: number, failedCount: number, topBlockedHost: string | null): string {
  if (blockedCount === 0) return `从来没有地址被白名单拦下过（网络失败 ${failedCount} 次是另一回事）。`
  return `共拦下 ${blockedCount} 次访问${topBlockedHost ? `，其中 ${topBlockedHost} 被拦得最多` : ''}；另有无害的网络失败 ${failedCount} 次。`
}

/**
 * 读一读出网审计。
 *
 * ★ 为什么需要一个**读数**，而不是"账本里有事件就够了"：
 *   内化自日报的那句话是「被拦的异常地址常是首个告警信号」——
 *   要成为信号，它必须**出现在人看得见的地方**。只写进账本的告警与没写
 *   在界面上是一回事（判据 10：谁在读它的输出）。
 */
export function egressAudit(limit = 50): EgressAudit {
  const blocked: EgressAudit['blocked'] = []
  const failed: EgressAudit['failed'] = []
  for (const e of getEvents(0)) {
    const p = e.payload as Record<string, unknown>
    if (e.kind === 'EGRESS_BLOCKED') {
      blocked.push({ reason: String(p.reason ?? '?'), host: p.host ? String(p.host) : null, url: String(p.url ?? ''), at: e.ts })
    } else if (e.kind === 'EGRESS_FAILED') {
      failed.push({ reason: String(p.reason ?? '?'), host: p.host ? String(p.host) : null, at: e.ts })
    }
  }
  const tally = new Map<string, number>()
  for (const b of blocked) if (b.host) tally.set(b.host, (tally.get(b.host) ?? 0) + 1)
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
  const topBlockedHost = top ? top[0] : null
  return {
    blocked: blocked.slice(-limit),
    failed: failed.slice(-limit),
    blockedCount: blocked.length,
    failedCount: failed.length,
    topBlockedHost,
    note: egressAuditNote(blocked.length, failed.length, topBlockedHost),
  }
}
