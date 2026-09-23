/**
 * 门：**出网面登记册** —— 系统里每一条出网路径，都必须有人为它做过一次显式决定。
 *
 * ══ 它对应日报里的哪一条 ═══════════════════════════════════════════════
 * 2026-09-23 日报第 ⑤ 条：8 家 MCP 安全平台 + OWASP Agent Control Standard
 * 2026 + 零信任（gVisor）。那批东西真正可迁移的一句话是
 * **「先做 Shadow 发现：把实际存在、但没被登记的组件盘出来」** ——
 * 安全事故几乎都不出在登记过的面上，而出在"谁都不知道它在那儿"的那条路径上。
 *
 * 本仓库的红线 ⑭ 早就写着「出网只走受控通道」，`server/net/egress.ts` 也真的
 * 建好了（协议白名单 + 解析后 IP 判据 + 域名白名单）。但在这道门之前，
 * **那条红线是靠纪律守的**：全仓有二十多个文件在直接 `fetch`，没有任何机制
 * 知道它们存在。纪律守红线的表现是——新加一条出网路径时不会有人察觉，
 * 而它一旦出现就是**一个新的、零测试覆盖的信任边界**。
 *
 * ══ 它**不**做什么（说清楚，免得被当成安全检查）═══════════════════════
 * 它不判断某条出网"危不危险"，也不拦任何请求。它只回答一个问题：
 * **这条路径在册不在册**。在册 ≠ 安全（场所适配器必须直连交易所 API，
 * 那是对的），不在册 = 有人得为它写一句话说明它为什么不能走受控通道。
 *
 * ══ 为什么判据是「文件 + 调用点**个数**」而不是"文件在不在册" ══════════
 * 只登记文件名的话，往一个**已登记**的文件里再加一条 `fetch(`
 * 会**完全静默** —— 而"往行情文件里顺手加一个上报接口"正是最该被拦下的那种改动。
 * 所以个数也要对得上：多了 ⇒ 新出网路径；少了 ⇒ 登记册已经陈旧，同样是漂移。
 * 判据 C2：两个数的口径必须是同一个；先清零，再比绝对值。
 *
 * ★ 代价与取舍：这是一道**会因无关改动变红**的门（重构掉一条 fetch 也会红）。
 *   之所以接受：它的红**只需要 5 秒**就能修（把数字改对），而它挡住的那种改动
 *   代价是"多了一条没人知道的出网路径"。不过——它绝不能变成"闭着眼睛改数字"，
 *   所以下面每一条都必须带一句**为什么它不能走受控通道**，
 *   且那句话短于 12 个字符直接判红（"todo" 不算回答）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['server', 'src', 'scripts', 'desktop']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.trash', '_upstream', '.preview-pylibs'])

/**
 * 出网调用点的判据（判据 C11：一律用**剥掉注释**的代码）。
 *
 * ★ 为什么 `fetch` 要拆成两条、而且要带后顾断言 ────────────────────────
 * 初版写的是裸 `\bfetch\b`，实测立刻造出 5 个**纯误报**：本仓库有个脚本叫
 * `data:fetch`，于是凡是提示里写了
 *     先跑 npm run data:fetch（多品种用 --symbols A,B,C）
 * 的文件都被算成了"出网点"（`breadth-run` / `factor-smoke` / `factorService` /
 * `mission/feasibility` …），另外还有界面文案里的 `Failed to fetch…`、
 * 沙箱封锁名单里的字符串 `'fetch'`。
 * 误报比漏报贵（判据 A1）：让登记册里躺着 5 条"这个文件其实不出网"的条目，
 * 唯一的后果是**训练人忽略这道门**。所以判据收紧成两条：
 *   · 真调用：`fetch(`（且前面不是 `:` 或 `data:` 这种被点名的一部分）；
 *   · 裸引用：`?? fetch` / `typeof fetch` —— **必须留着这一条**，因为
 *     `server/net/egress.ts` 真正发请求的那一行就是
 *         const doFetch = opts.fetchImpl ?? fetch
 *     一个裸引用，后面没有括号。漏掉它，登记册会得出
 *     「受控通道自己不出网」这个**恰好相反**的结论（判据 C2）。
 * ★ 前不是 `:`/单词字符：`doFetch` / `fetchPage` 都不是出网点，
 *   而 `data:fetch` 这种点名要排除掉。
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'fetch', re: /(?<![:\w.])fetch\s*\(/g },
  { name: 'fetch-ref', re: /(?:\?\?|typeof)\s+fetch\b/g },
  { name: 'http.request', re: /\bhttps?\.(request|get)\s*\(/g },
  { name: 'websocket', re: /\bnew\s+WebSocket\s*\(/g },
  { name: 'eventsource', re: /\bnew\s+EventSource\s*\(/g },
  { name: 'net.connect', re: /\bnet\.connect\s*\(/g },
  { name: 'tls.connect', re: /\btls\.connect\s*\(/g },
]

/** 分类枚举。新增分类要同时想清楚"它为什么可以不走受控通道"。 */
const CATEGORIES = [
  'controlled-egress', // 受控通道本体
  'im-gateway', // 即时通讯入口（手机远程指挥）：★ 唯一一类把**外部输入**带进系统
  'venue-adapter', // 场所适配器：必须直连交易所 REST/WS（自带签名与凭证）
  'venue-probe', // 诊断脚本里直连交易所（排障用，不进 CI 产物）
  'market-stream', // 交易所公开行情流（只读、只订阅）
  'market-data-public', // 交易所公开行情 REST（只读、无需密钥）
  'llm-gateway', // 模型网关（API key 由配置提供）
  'alert-webhook', // 告警外发（**唯一一类把系统内部数据送出去**的通道）
  'local-loopback', // 只连本机端口（带本地令牌，不出主机）
  'browser-market', // 浏览器侧直连交易所（不经本机进程）
  'browser-local-orch', // 浏览器侧连本机编排器
  'probe', // 诊断/探针脚本（不进 CI 产物）
] as const
type Category = (typeof CATEGORIES)[number]

interface Entry {
  file: string
  /** 该文件里出网调用点的**个数**。口径：剥注释后按 PATTERNS 的命中总数。 */
  sites: number
  category: Category
  /** 一句话：它为什么**不能**（或不必）走 `server/net/egress.ts`。 */
  why: string
}

/**
 * 出网面登记册。
 *
 * 基数口径：2026-09-23 首次盘点 = 30 个文件 / 64 处调用点（`server` 12 · `src` 3 · `scripts` 15）。
 * ★ 每一行都是**一次显式决定**，不是"白名单"：`why` 回答的是"它为什么不能走受控通道"。
 */
const REGISTRY: Entry[] = [
  // ── 受控通道本体 ────────────────────────────────────────────────────
  {
    file: 'server/net/egress.ts',
    sites: 4,
    category: 'controlled-egress',
    why: '受控通道自己：4 处都是 `?? fetch` / `typeof fetch` 这类**裸引用**（真正的调用是 doFetch(...)）。它就是那条通道，不能再套一层。★ 2026-09-23 从 3 涨到 4：新增的 `postJson` 是告警 webhook 的那条 POST 路径 —— 它必须住在这里，否则"收进受控通道"就只是把 `fetch` 从 slo.ts 挪了个地方。',
  },

  // ── 外部输入入口：手机端远程指挥（★ 唯一一类把外界的话带进来）───────────
  {
    file: 'server/voice/telegram.ts',
    sites: 1,
    category: 'im-gateway',
    why:
      '它**恰恰是走受控通道的**（`getUpdates` 用 `fetchPage`、`sendMessage` 用 `postJson`），' +
      '登记的这 1 处是注入依赖的**类型引用**（`typeof fetch`），不是调用 —— 与 `parity-smoke` 同款。' +
      '★ 单列一个分类的理由不是"它可以绕开"，而是：它是全仓**唯一**一个把**外部输入**带进系统的出网面，' +
      '审计需要能一眼数出"有几个这样的入口"（现在是 1 个）。' +
      '这条通道的两道门是**互相独立**的：出网白名单只管"连不连得上"，' +
      '而"谁的话算数"由会话白名单决定、且默认为空 —— 混成一件就是"能连上即可信"。',
  },

  // ── 进程出网：场所适配器（自带签名与凭证，必须直连）────────────────────
  {
    file: 'server/venue/cexTestnet.ts',
    sites: 1,
    category: 'venue-adapter',
    why: '币安签名请求：受控通道是"抓网页"用的（域名白名单 + 正文截断），不承载带 HMAC 签名的下单请求。',
  },
  {
    file: 'server/venue/okxTestnet.ts',
    sites: 1,
    category: 'venue-adapter',
    why: 'OKX 签名请求 + 代理直连；同 cexTestnet，交易请求必须走适配器自己的签名链路。',
  },

  // ── 进程出网：公开行情（只读、无凭证、无上传）──────────────────────────
  {
    file: 'server/index.ts',
    sites: 2,
    category: 'market-data-public',
    why: 'Binance 公开 K 线（data-api.binance.vision），只读无密钥；受控通道是 HTML 抓取器，不是 JSON 客户端。',
  },
  {
    file: 'server/autopilot.ts',
    sites: 1,
    category: 'market-data-public',
    why: '自动驾驶启动前的公开 K 线预热（1m×200），同上：只读、无凭证。',
  },
  {
    file: 'server/marketRegime.ts',
    sites: 1,
    category: 'market-data-public',
    why: '市场状态（趋势/震荡）所需的公开行情快照，只读。',
  },
  {
    file: 'server/feed.ts',
    sites: 1,
    category: 'market-stream',
    why: '交易所行情 **WebSocket 长连接**（只订阅）。受控通道是 HTTP 抓页，不承载长连接。',
  },

  // ── 进程出网：模型网关 ──────────────────────────────────────────────
  {
    file: 'server/llmProviders.ts',
    sites: 3,
    category: 'llm-gateway',
    why: '模型网关三处（/models、/messages、/chat/completions）；API key 由配置提供，是刻意保留的第三方信任面。',
  },
  {
    file: 'server/providerProbe.ts',
    sites: 1,
    category: 'llm-gateway',
    why: '模型可用性探针：与 llmProviders 打同一批网关，只是探活不发正文。',
  },

  // ── 进程出网：告警外发 ★ 唯一把系统内部数据送出去的通道 ─────────────────
  // ★ 2026-09-23 已收口：`server/slo.ts` 不再直接出网，它改走
  //   `server/net/egress.ts` 的 `postJson()`（协议白名单 → 解析后 IP 判据 →
  //   域名白名单三层齐全，与读路径**同一份**实现，且被拦/没通分别记账）。
  //   所以这里不再登记它 —— 留一条"已失效"的条目只会训练人忽略这道门。
  //   ★ 代价（必须说出来）：webhook 的目标域现在必须显式登记在
  //     `DEFAULT_ALLOWED_SUFFIXES` 或 `EV_EGRESS_HOSTS` 里，否则告警会被
  //     自己的白名单拦下。这不是静默失效：`slo.ts` 会写 `SLO_ALERT_WEBHOOK`
  //     事件、打一行 `[ALERT]` 错误、并把结果挂上 `lastAlertWebhook()`。

  // ── 进程出网：只连本机（不出主机）───────────────────────────────────
  {
    file: 'server/mirrorCheck.ts',
    sites: 2,
    category: 'local-loopback',
    why: '对账时读本机镜像事件（带 x-orch-token），目标是本机编排器端口。',
  },
  {
    file: 'server/stackCore.ts',
    sites: 2,
    category: 'local-loopback',
    why: '栈探活（healthz），打本机端口；受控通道的 DNS/IP 判据**刻意拒绝**回环地址，走它反而探不了自己。',
  },

  // ── 浏览器侧出网（不由本机进程发起）─────────────────────────────────
  {
    file: 'src/data/market.ts',
    sites: 3,
    category: 'browser-market',
    why: '浏览器直连交易所公开行情（REST×2 + WebSocket×1）。受控通道在 Node 侧，管不到浏览器。',
  },
  {
    file: 'src/orch/client.ts',
    sites: 7,
    category: 'browser-local-orch',
    why: '前端调本机编排器（7 处）。同源/本机令牌，出网主体是浏览器。',
  },
  {
    file: 'src/voice/client.ts',
    sites: 2,
    category: 'browser-local-orch',
    why: '前端调本机语音服务（含 SSE 流），同 src/orch/client。',
  },

  // ── 诊断脚本：进不了 CI 产物，只在人手动跑时执行 ──────────────────────
  {
    file: 'scripts/fetch-history.ts',
    sites: 1,
    category: 'market-data-public',
    why: '批量拉历史 K 线的 CLI，同 server/index.ts 的公开端点；它是数据入口，不是运行时通道。',
  },
  {
    file: 'scripts/key-scope-audit.ts',
    sites: 2,
    category: 'venue-probe',
    why: '用真凭证探测 key 作用域（币安 /account、OKX /api/v5/…）——**就是要用凭证去打**，包一层受控通道反而测不出真实作用域。',
  },
  {
    file: 'scripts/okx-bal-raw.ts',
    sites: 1,
    category: 'venue-probe',
    why: 'OKX 余额原始报文排障；同 key-scope-audit，目的是看真实响应。',
  },
  {
    file: 'scripts/okx-order-diag.ts',
    sites: 1,
    category: 'venue-probe',
    why: 'OKX 下单报文排障；同 key-scope-audit。',
  },
  {
    file: 'scripts/vision-probe.ts',
    sites: 1,
    category: 'probe',
    why: '模型视觉能力探针（openrouter /models）；一次性结论工具，不进 CI。',
  },
  {
    file: 'scripts/sandbox-smoke.ts',
    sites: 2,
    category: 'probe',
    why: '两处都是**故意出网**：一处是喂给沙箱的"恶意策略"载荷，一处是探"通道到底封没封"。它们出不去才是通过。',
  },
  {
    file: 'scripts/parity-smoke.ts',
    sites: 2,
    category: 'probe',
    why: '两处都是**类型引用**（`injectedFetch` 那一个 helper + P3 里直接写的一处），没有一处是调用：它们是注入进 `fetchPage` / `postJson` 的替身，用来造"网络没通""解析到内网"这些档，本身不发请求。★ 2026-09-23 从 1 涨到 2：新增的 `injectedFetch` 是受控 POST 那组断言要用的，把它收敛成一处（而不是四处处处 `as unknown as typeof fetch`）之后，登记册上只需要回答一次。',
  },
  {
    file: 'scripts/telegram-smoke.ts',
    sites: 1,
    category: 'probe',
    why: '一处**类型引用**：`injectedFetch` helper 把假 fetch 塞进 `setTelegramDeps`，用来造"被拦 / token 错 / 网络没通"三档。这条烟测**一次真请求都不发** —— 它发的每一句都是判据要看的输入，而不是真的要去连 Telegram（真连的话，测试结果会取决于本机网络，而"没网"与"通道坏了"长得一样）。',
  },

  // ── 诊断脚本：只连本机 ──────────────────────────────────────────────
  {
    file: 'scripts/app.ts',
    sites: 1,
    category: 'local-loopback',
    why: '启动器探活本机编排器（带 x-orch-token），不出主机。',
  },
  {
    file: 'scripts/mirror-smoke.ts',
    sites: 10,
    category: 'local-loopback',
    why: '镜像/事件分页烟测 ×6 + 全局 fetch 替身 ×4，目标全是本机编排器。',
  },
  {
    file: 'scripts/_wait-cdp.mjs',
    sites: 1,
    category: 'local-loopback',
    why: '等本机 Chrome 调试端口起来（localhost:9222/json/list）。',
  },
  {
    file: 'scripts/_bundle-probe.mjs',
    sites: 1,
    category: 'local-loopback',
    why: '探本机预览产物（localhost:4173）。',
  },
  {
    file: 'scripts/e2e-ui-actions.ts',
    sites: 3,
    category: 'local-loopback',
    why: 'CDP 驱浏览器（本机调试端口 + 本机页面）。',
  },
  {
    file: 'scripts/ui-shot.ts',
    sites: 2,
    category: 'local-loopback',
    why: 'CDP 截图，同 e2e-ui-actions。',
  },
  {
    file: 'scripts/probe-ui-payload.ts',
    sites: 4,
    category: 'local-loopback',
    why: 'CDP 读界面载荷，同 e2e-ui-actions。',
  },
  {
    file: 'scripts/probe-terminal-upgrade.ts',
    sites: 2,
    category: 'local-loopback',
    why: 'CDP 核验交易大厅升级，同 e2e-ui-actions。',
  },
]

/** 剥注释：块注释 + 整行注释。留下的是"会真的跑"的那部分。 */
function readCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * 再剥掉**单行引号字符串**（`'…'` / `"…"`）。
 *
 * ★ 为什么必须剥它：这道门自己的 `REGISTRY` 里写着判据示例（`?? fetch` 这类
 *   字面量），于是**门禁把自己判成了出网点** —— 首次运行就报
 *   「未登记 scripts/egress-registry-check.ts (fetch-ref×3)」。
 *   靠改写自己的注释来躲开它，属于"为了让检查器闭嘴而改正确的代码"，不做。
 *
 * ★ 为什么**不**剥模板字符串：喂给沙箱的"恶意策略"载荷就住在模板串里
 *   （`scripts/sandbox-smoke.ts`），那是**真实的出网尝试**，登记册必须看得见它 ——
 *   剥掉会让这道门从"漏掉一次真实尝试"变成"更干净"，方向正好相反。
 *
 * ★ 为什么这不会制造盲区：**真调用不可能住在字符串字面量里**。
 *   被剥掉的只有"文本"。
 * ★ 只处理**同行闭合**的引号：跨行的单个撇号（例如模板串里写 `it's`）一旦被
 *   贪心地吃到下一个引号，会连带吃掉后面的真代码 —— 那才是真盲区。
 */
function stripQuotedStrings(code: string): string {
  return code
    .split('\n')
    .map((line) => line.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""'))
    .join('\n')
}

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

interface Found {
  file: string
  sites: number
  kinds: string[]
}

const found: Found[] = []
let scannedFiles = 0

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    scannedFiles += 1
    const code = stripQuotedStrings(readCode(readFileSync(file, 'utf8')))
    const kinds: string[] = []
    let sites = 0
    for (const p of PATTERNS) {
      const n = [...code.matchAll(p.re)].length
      if (n > 0) {
        sites += n
        kinds.push(`${p.name}×${n}`)
      }
    }
    if (sites > 0) found.push({ file: relative(ROOT, file).replace(/\\/g, '/'), sites, kinds })
  }
}

// ── 反空转（判据 B1/A3）：先证明"这道门扫到了东西" ──────────────────────
// 少了这一段，一次改坏的目录名或正则会让它扫到 0 处、然后**以 0 个问题通过**。
const totalSites = found.reduce((a, f) => a + f.sites, 0)
console.log(
  `扫描 ${SCAN_DIRS.join(' / ')} · ${scannedFiles} 个文件 · 命中出网调用点 ${totalSites} 处 · 分布在 ${found.length} 个文件 · 登记在册 ${REGISTRY.length} 个`,
)
if (totalSites === 0) {
  console.error('❌ 一处出网调用点都没扫到 —— 目录名或判据正则坏了，这道门此刻是空转的，不能当成"通过".')
  process.exit(1)
}

const byFile = new Map(found.map((f) => [f.file, f]))
const registered = new Map(REGISTRY.map((e) => [e.file, e]))

const problems: string[] = []

// ① 未登记 —— 这就是「Shadow 发现」要找的东西。
for (const f of found) {
  if (!registered.has(f.file)) {
    problems.push(`未登记  ${f.file}  (${f.kinds.join(' ')})`)
  }
}

// ② 已登记但口径对不上 —— 多了 = 新出网路径；少了 = 登记册陈旧。
for (const e of REGISTRY) {
  const f = byFile.get(e.file)
  if (!f) {
    problems.push(`已失效  ${e.file}  登记册写着 ${e.sites} 处，实际 0 处 ⇒ 它已经不出网了，请删掉这条登记`)
  } else if (f.sites !== e.sites) {
    const dir = f.sites > e.sites ? '变多了（新增出网路径）' : '变少了（登记册已陈旧）'
    problems.push(`数不符  ${e.file}  登记 ${e.sites} · 实际 ${f.sites} · ${dir}  (${f.kinds.join(' ')})`)
  }
}

// ③ 登记项必须说得出理由，且分类合法。
for (const e of REGISTRY) {
  if (!CATEGORIES.includes(e.category)) problems.push(`分类非法  ${e.file}  「${e.category}」不在枚举内`)
  if (e.why.trim().length < 12) problems.push(`理由太短  ${e.file}  「${e.why}」不足以回答"为什么它能不经受控通道"`)
}

if (problems.length > 0) {
  console.error('')
  console.error('❌ 出网面登记册与实际代码对不上：')
  for (const p of problems.sort()) console.error(`  · ${p}`)
  console.error('')
  console.error('★ 不要为了让这道门闭嘴而把文件里那条出网调用删掉或藏起来 —— 它此刻就会真的发请求。')
  console.error('  正确的下一步，二选一：')
  console.error('    ① 它就该走受控通道  ⇒ 改成 server/net/egress.ts 的 fetchPage()，这道门自然不再看它；')
  console.error('    ② 它确实不能走      ⇒ 在 scripts/egress-registry-check.ts 的 REGISTRY 里加一条，')
  console.error('       写清 category 与「它为什么不能走受控通道」那一句话。')
  console.error('   数字对不上时，改数字**之前**先回答：这次变化是不是真的多/少了一条出网路径？')
  process.exit(1)
}

console.log(`✅ ${found.length} 个文件的 ${totalSites} 处出网调用点全部在册，且分类与理由齐全`)
