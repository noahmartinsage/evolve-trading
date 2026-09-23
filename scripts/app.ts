/**
 * EVOLVE 双击启动（`START-EVOLVE.cmd` 的唯一调用目标）
 *
 * ── 它做什么 ─────────────────────────────────────────────────────────
 *   ① 需要时先构建（`dist` 不存在，或 `src` 里有比 `dist` 更新的文件）
 *   ② 账本 :8791 → 编排 :8790 → 前端 :4173（跑构建产物，不是 dev server）
 *   ③ 起桌宠窗口（Electron），并把完整控制台也开在浏览器里
 *   ④ 桌宠退出 → 整栈收尾
 *
 * ── 为什么是"构建产物 + vite preview"而不是 dev server ────────────────
 * 双击启动的语义是"使用"，不是"开发"。dev server 会在端口被占时**静默换一个**，
 * 而桌宠窗口连的是写死的 4173 —— 结果就是窗口连到别的东西上，
 * 界面上只表现为"没反应"。预览模式配 `--strictPort`，端口被占直接失败，
 * 失败是可见的。
 *
 * ── 为什么进程级按死 `AUTOPILOT_LIVE=false` ──────────────────────────
 * 本机 `.env` 里 `AUTOPILOT_LIVE=true`（那是给真实验证留的）。
 * 双击启动是**日常使用**入口，它不该因为一个沿用下来的 .env 值就走真钱通路。
 * `loadDotEnv` 只补"还没有的键"，所以进程级覆盖是有效的（见 loadEnv.ts）。
 * 要跑实盘请显式设 `EVOLVE_ALLOW_LIVE=1` —— 那个名字与 .env 里的键不同，
 * 不会被误当成"上次留下的配置"。
 *
 * 用法：
 *   npm run app                   双击的等价命令
 *   node scripts/app.ts --no-pet  只起服务（调试用）
 *   node scripts/app.ts --force-build  忽略新鲜度判断，强制重新构建
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PORTS,
  DEV_TOKEN,
  createStack,
  renderExitReport,
  renderLoopbackTries,
  renderRuntimeSummary,
  resolveLoopbackService,
  stackRoles,
  stampLocal,
  waitForHealth,
  waitForLoopbackService,
  type RuntimeProbe,
} from '../server/stackCore.ts'
import { loadDotEnv } from '../server/loadEnv.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'data')
const PID_FILE = join(DATA_DIR, 'app-stack.json')
const LOG_FILE = join(DATA_DIR, 'app-stack.log')

const ARGS = new Set(process.argv.slice(2))
const NO_PET = ARGS.has('--no-pet')
const FORCE_BUILD = ARGS.has('--force-build')
const NO_BROWSER = ARGS.has('--no-browser')
const ALLOW_LIVE = process.env.EVOLVE_ALLOW_LIVE === '1'

/**
 * ★★ `.env` 必须在**取任何配置之前**加载完。
 *
 *   这里原来排在第 96 行（`say()` / `stamp()` 那些工具函数定义完之后），
 *   而 `const TOKEN = process.env.ORCH_TOKEN ?? DEV_TOKEN` 排在第 70 行 ——
 *   于是 `.env` 里写的 `ORCH_TOKEN` **永远读不到**，启动器一律用默认令牌，
 *   而它还会在控制台把那个默认令牌**印出来**（"令牌 dev-insecure-token"）。
 *   下面那段注释本来就是为了防"两处各算一次"，结果同一类问题换了个入口又来了一遍：
 *   写在 `.env` 里的令牌被静默忽略 —— 而用户以为自己已经换成真令牌了。
 *   （判据 D7：如果这个值没被采纳，用户要靠什么看出来？）
 */
loadDotEnv(join(ROOT, '.env'))

/**
 * 编排层令牌。**只在这里取一次，然后显式喂给两个地方**（子进程环境 / 探针请求头）。
 *
 * ★ 原来两个地方各算一次：子进程走 `stackRoles()` 的默认值（DEV_TOKEN），
 *   而启动器自己打印时读 `process.env.ORCH_TOKEN`。这两个表达式**在绝大多数
 *   机器上得到同一个字符串**，所以看不出问题；但只要外部 shell 导出了
 *   `ORCH_TOKEN`，启动器就会拿一个服务不认的令牌去问，得到 401 ——
 *   而它会把这解释成"读不到运行态"，用户看到的是三行 ⚠。
 *   同一件事的凭据只能有一个来源（判据 8）。
 */
const TOKEN = process.env.ORCH_TOKEN ?? DEV_TOKEN

/**
 * 远程模式：允许**别的设备**（手机）连前端。
 *
 * ★★ 开关本身不危险，"开关 + 公开默认令牌"才危险：编排层本来就监听所有网卡，
 *   而前端只是它的遥控器。所以这一组合在**起任何服务之前**就拒掉 ——
 *   fail-closed，且条件窄到只有"既要远程、又没换令牌"这一个（判据 4）。
 *   拒绝发生在 `mkdir` / `stack.start()` 之前，不会留下半启动的栈。
 */
const REMOTE = process.env.EVOLVE_REMOTE === '1'
if (REMOTE && TOKEN === DEV_TOKEN) {
  console.error('')
  console.error('❌ EVOLVE_REMOTE=1，但 ORCH_TOKEN 还是默认的公开令牌。')
  console.error('   开了远程就等于把出单端点挂到路由器上：同一个 WiFi 底下任何人都能')
  console.error('   用它出单，也能把自己的 Telegram 会话放行成主人。')
  console.error('')
  console.error('   请先在 .env 里设一个只有你知道的令牌，再启动：')
  console.error('     ORCH_TOKEN=<随机串>')
  console.error('   生成一个：node -e "console.log(require(\'node:crypto\').randomBytes(24).toString(\'hex\'))"')
  console.error('')
  console.error('   只想本机用？把 EVOLVE_REMOTE 去掉或设成 0 即可。')
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })

/**
 * ★ 本地时间 + 偏移（`2026-09-17 11:50:27 +08:00`），不是 `toISOString()`。
 *   原来写的是 UTC，本机在 GMT+8 ⇒ 日志里一切时间都比现实**早 8 小时**，
 *   而文件管理器 / 任务管理器 / 用户的记忆全是本地时间。
 *   上一轮排查"账本为什么没了"时，`03:50` 这个时间戳直接把人带偏了
 *   （实际上就是 11:50，事件发生在此前 8 分钟而不是"很久以前"）。
 *   带偏移之后，老日志（无偏移后缀）与新日志一眼可分，不必回头改写历史。
 */
function stamp(): string {
  return stampLocal()
}

function say(line: string): void {
  console.log(line)
  try {
    appendFileSync(LOG_FILE, '[' + stamp() + '] ' + line + '\n', 'utf8')
  } catch {
    /* 日志写不进去不该拦住启动 */
  }
}

// ★ `.env` 的加载**已经挪到文件上方**（取 `TOKEN` 之前）——
//   `loadDotEnv` 只补 `process.env` 里还没有的键，所以顺序决定了它到底有没有用。
//   放在这里等于完全失效：`TOKEN` 那时已经算完了。

/**
 * 桌面壳自己写的那些变量**不要**带进来。
 *
 * `ELECTRON_RUN_AS_NODE=1` 在这台机器上是全局设着的（VS Code 系工具留下的）。
 * 它会让 Electron 退化成纯 Node：没有窗口、**也不报错**。
 * `desktop/launch.ts` 会摘掉它，但这里也摘一次是有意为之 —— 这一层要保证
 * "不管从哪继承来的环境，桌面壳都能拿到一个干净的环境变量集"。
 */
delete process.env.ELECTRON_RUN_AS_NODE

/** 源码里最新的 mtime（用于判断 `dist` 是否过期）。 */
function newestSourceMtime(dir: string, depth = 0): number {
  if (depth > 6) return 0
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) newest = Math.max(newest, newestSourceMtime(full, depth + 1))
    else if (/\.(ts|tsx|css|html|json)$/.test(e.name)) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs)
      } catch {
        /* 竞态：文件刚好被删 */
      }
    }
  }
  return newest
}

/**
 * 本机能被**别的设备**连上的地址（内网 IPv4）。没有就返回空数组。
 *
 * ★ 为什么要筛：`ipconfig` 里排在前面的常常是虚拟网卡（WSL / VirtualBox / VPN），
 *   那个地址手机连不上，表现是"页面一直转圈" —— 用户会去查防火墙，而问题在这里。
 *   `internal: true` 的是回环，手机上写它等于写"手机自己"，所以一起去掉。
 * ★ 拿不到时说"拿不到"，不编一个地址出来（判据 ㉟：`null` 不许退化成 0）。
 */
function lanAddresses(): string[] {
  const out: string[] = []
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue
        out.push(ni.address)
      }
    }
  } catch {
    return []
  }
  return out
}

/** 单个文件的 mtime；不存在返回 0（"比任何产物都旧"）。 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 判"要不要构建"。
 *
 * ★ 判据是**时间**而不是"存在与否"：只查 `dist/index.html` 在不在的话，
 *   改完 `src/**` 双击启动会打开一份**旧界面** —— 而它看起来完全正常。
 *   那种"我看到的就是当前代码"的错觉，比构建慢几秒贵得多。
 *
 * ★ 比的**只有构建的输入**（`src/` + `index.html` + `vite.config.ts`），
 *   不是整个仓库目录。把 `artifacts/`、`data/` 也算进来的话，
 *   每跑一次冒烟（写 `artifacts/*.json`）就会让下次启动白构建一遍。
 */
function needsBuild(): { needed: boolean; why: string } {
  const distIndex = join(ROOT, 'dist', 'index.html')
  if (!existsSync(distIndex)) return { needed: true, why: 'dist 还没构建过' }
  if (FORCE_BUILD) return { needed: true, why: '--force-build' }
  const distAt = statSync(distIndex).mtimeMs
  const srcAt = Math.max(
    newestSourceMtime(join(ROOT, 'src')),
    mtimeOf(join(ROOT, 'index.html')),
    mtimeOf(join(ROOT, 'vite.config.ts')),
  )
  if (srcAt > distAt) return { needed: true, why: 'src 里有比 dist 更新的文件' }
  return { needed: false, why: 'dist 是最新的' }
}

function build(): boolean {
  say('· 正在构建前端（npm run build）…')
  const r = spawnSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    say('✗ 构建失败（exit ' + String(r.status) + '）。修掉再双击一次 —— 这里不会用旧产物凑合启动。')
    return false
  }
  say('· 构建完成')
  return true
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 打不开浏览器只是少一个入口，页面地址已经打印出来了 */
  }
}

/**
 * 从**已经起来的编排层**读回运行态。
 *
 * ★ 这里是启动器与"汇报"之间最容易出事的地方：启动器想说的话（"自循环常开"
 *   "账号池就绪"）都是**关于服务内部**的，而它自己看不到那些内部状态。
 *   如果这里改成"打印常量"，那么额度爆掉、循环被关掉、账号没配的时候，
 *   启动器会照样一片绿 —— 用户据此判断"系统在跑"，而它其实什么也做不了。
 *   ⇒ 只打印读回来的东西；读不到就把**读不到**和**原因**打出来（判据 13：
 *   「没有能力」与「没有额度」必须分得清）。
 */
async function probeRuntime(): Promise<RuntimeProbe> {
  // ★ 地址不写死成 `127.0.0.1`（原来就是写死的，于是**连到了别人的服务上**：
  //   本机实测 `127.0.0.1:8790` 被隔壁工作区的 dash 服务占着，我们的编排层在 `[::1]` 那边）。
  //   现在先问「你是谁」，再拿这个地址去读 —— 读到的才可能是我们自己的东西。
  const res = await resolveLoopbackService(DEFAULT_PORTS.orch, '/healthz', 'orch')
  const sq = res.tries.filter((t) => !t.ours && t.answered).map((t) => t.url + ' → ' + t.verdict)
  const errors: NonNullable<RuntimeProbe['errors']> = {}
  if (res.base === null) {
    // 连"我们是哪个地址"都没定下来 ⇒ 三项都读不到，且**原因必须带上逐条判定**
    // （否则用户只看到三行"读不到"，不知道下一步去查谁）。
    const why = '找不到我们自己的编排层：\n' + renderLoopbackTries(res.tries).join('\n')
    for (const k of ['fleet', 'autonomy', 'news'] as const) errors[k] = why
    return { fleet: null, autonomy: null, news: null, errors, base: null, squatters: sq }
  }
  const base = res.base
  const token = TOKEN
  const get = async (path: string, name: 'fleet' | 'autonomy' | 'news'): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetch(base + path, { headers: { 'x-orch-token': token }, signal: AbortSignal.timeout(5000) })
      if (!r.ok) {
        errors[name] = 'HTTP ' + String(r.status)
        return null
      }
      return (await r.json()) as Record<string, unknown>
    } catch (e) {
      errors[name] = e instanceof Error ? e.message : String(e)
      return null
    }
  }
  const [fleet, autonomy, news] = await Promise.all([
    get('/fleet', 'fleet'),
    get('/fleet/autonomy', 'autonomy'),
    // 取 5 条而不是 1 条：要印的是"最新的一条"，而最新的一条在**末尾**，
    // 只取 1 条就只剩最旧的那条可印。取 5 也让"这几天读到几条"有个量。
    get('/fleet/news?limit=5', 'news'),
  ])
  return {
    fleet: fleet as RuntimeProbe['fleet'],
    autonomy: autonomy as RuntimeProbe['autonomy'],
    news: news as RuntimeProbe['news'],
    errors,
    base,
    squatters: sq,
  }
}

async function main(): Promise<void> {
  say('════ EVOLVE 启动 ════')
  say('· 目录 ' + ROOT)

  const fresh = needsBuild()
  say('· 前端产物：' + fresh.why + (fresh.needed ? ' → 先构建' : ''))
  if (fresh.needed && !build()) process.exit(1)

  const stack = createStack({
    log: say,
    onUnexpectedExit: (report) => {
      // 一整份取证报告，而不是一行 `exit 1`。理由见 `stackCore.ts` 顶部：
      // exit code + signal 在这三种事因下逐字节相同（自崩溃 / taskkill / 未捕获异常），
      // 所以真正能定性的只有"子进程有没有留下遗言"。
      for (const line of renderExitReport(report)) say(line)
      stack.shutdown(1)
    },
  })

  const overrides: NodeJS.ProcessEnv = { AUTOPILOT_LIVE: ALLOW_LIVE ? 'true' : 'false' }
  if (ALLOW_LIVE) say('⚠ EVOLVE_ALLOW_LIVE=1：编排层会走实盘通路（这是你显式要求的）。')
  else say('· 实盘通路按死为 false（要开请设 EVOLVE_ALLOW_LIVE=1）')

  const roles = stackRoles({
    web: 'preview',
    venue: process.env.VENUE ?? 'sandbox',
    overrides,
    token: TOKEN,
    remote: REMOTE,
  })

  /**
   * 每个角色的健康检查预算 —— **必须比该角色的正常启动耗时宽出一个量级**。
   *
   * ★ 原来三个角色共用 `waitForHealth` 的 25s 默认值，而 `orch` 启动时要
   *   **同步预热过拟合证据**：日志实测 `✅ 过拟合证据已预热 … 21254ms / 21838ms`，
   *   加上种子/握手/挂载，正常耗时就在 22~28s。
   *   预算正好压在正常耗时的区间里 ⇒ **偶发判"启动失败"并 `stack.shutdown(1)` 把整栈收掉**。
   *   表现是用户看到"启动失败"，而系统本身完全正常（第九轮实测踩到过一次，见 DEV_PROGRESS §3.20.10）。
   *
   * ⇒ 通用判据：**任何超时预算若与正常耗时同量级，它就不是保护，是一颗随机地雷。**
   *   要么显著放宽，要么把慢的那步从启动路径上挪走（本层选前者，因为预热本身是有意的）。
   */
  const HEALTH_BUDGET_MS: Record<string, number> = { ledger: 30_000, orch: 120_000, web: 60_000 }

  for (const role of roles) {
    stack.start(role)
    const budget = HEALTH_BUDGET_MS[role.name] ?? 30_000

    if (role.name === 'web') {
      // ★ web（vite preview）是**唯一**允许"只要有人应答就算就绪"的角色：
      //   它没有自报身份的端点。另两个角色都必须认身份 —— 端口上可能坐着别人的服务
      //   （本机实测，见 serviceIdentity.ts），此时"通了"是假绿。
      const ok = await waitForHealth('http://127.0.0.1:' + DEFAULT_PORTS.web + '/', budget)
      if (!ok) {
        say('✗ [web] ' + String(Math.round(budget / 1000)) + ' 秒内没有起来（http://127.0.0.1:' + DEFAULT_PORTS.web + '/）。上面是它的输出。')
        say('  （若提示端口被占：4173 上还挂着上一次没退干净的进程，先跑 STOP-EVOLVE.cmd）')
        stack.shutdown(1)
        return
      }
      say('· [web] 就绪 http://127.0.0.1:' + DEFAULT_PORTS.web + '/（vite 不报身份，这一条只用"有人应答"判）')
      continue
    }

    const svcRole = role.name as 'ledger' | 'orch'
    const res = await waitForLoopbackService(DEFAULT_PORTS[svcRole], '/healthz', svcRole, budget)
    if (res.base === null) {
      say('✗ [' + role.name + '] ' + String(Math.round(budget / 1000)) + ' 秒内没有起来。上面是它的输出。')
      say('  逐条判定（端口 ' + String(DEFAULT_PORTS[svcRole]) + '）：')
      for (const line of renderLoopbackTries(res.tries)) say(line)
      say('  ⇒ 「有人但不是我们」= 去查是谁占了端口；「没人应答」= 才是我们的服务没起来。**这两件事要做的事相反。**')
      if (role.name === 'orch') {
        say('  （它启动时要同步预热过拟合证据，实测约 21~22 秒；若上面停在"过拟合证据已预热"之后，多半是历史数据拉取或 venue 握手卡住）')
      }
      stack.shutdown(1)
      return
    }

    say('· [' + role.name + '] 就绪 ' + res.base + '/healthz（自报身份 = 我们自己的）')
    // ★ 找到自己的了，但另一条回环地址上坐着别人 —— 这不是本次启动的问题，
    //   是**下一个**去连那条地址的工具的坑（它会读到别人的数据，而端点看着"通"）。
    //   本机真实发生过（隔壁工作区的 dash 服务占着 127.0.0.1:8790），所以每次启动都印出来。
    for (const t of res.tries) {
      if (!t.ours && t.answered) say('  ⚠ ' + t.url + ' 上是**别人的服务**：' + t.verdict + '（谁连它，谁就拿到别人的数据）')
    }
  }

  writeFileSync(
    PID_FILE,
    JSON.stringify({ startedAt: new Date().toISOString(), live: ALLOW_LIVE, roles: stack.pids() }, null, 2),
    'utf8',
  )

  const panelUrl = 'http://localhost:' + DEFAULT_PORTS.web + '/'

  // ── 运行态：从活着的服务读回来 ────────────────────────────────────
  say('')
  for (const line of renderRuntimeSummary(await probeRuntime())) say(line)

  say('')
  say('  控制台   ' + panelUrl)
  say('  编排 API http://localhost:' + DEFAULT_PORTS.orch + '（令牌 ' + TOKEN + '）')
  if (REMOTE) {
    // ★ 手机要照着一个**真的存在**的地址输。不印的话用户只能自己去 ipconfig 里翻，
    //   而翻出来的可能是虚拟网卡（WSL / VirtualBox / VPN）—— 那个地址手机连不上，
    //   表现是"一直转圈"，用户会以为是防火墙的问题。
    // ★ 只列内网 IPv4：回环手机上没意义，外网地址不是手机要用的那个。
    const lan = lanAddresses()
    if (lan.length === 0) {
      say('⚠ EVOLVE_REMOTE=1，但没找到内网 IPv4 地址 —— 手机可能连不上（VPN / 虚拟网卡会让它更复杂）。')
    } else {
      const pet = '?pet=1'
      say('  📱 手机（同一个 WiFi）   ' + lan.map((a) => 'http://' + a + ':' + DEFAULT_PORTS.web + '/').join('  '))
      say('     桌宠形态（手机）      ' + lan.map((a) => 'http://' + a + ':' + DEFAULT_PORTS.web + '/' + pet).join('  '))
      say('     手机上打开后，把「连接」里的地址改成  http://' + lan[0] + ':' + DEFAULT_PORTS.orch)
      say('     令牌就填上面那个（本机 .env 里 ORCH_TOKEN 的值）')
    }
  }
  say('  口令怎么用  在控制台或桌宠里说/写一个目标 → 裁定为可行时会给四位口令 → 说「确认启动 四位数字」')
  say('')
  if (!NO_BROWSER) openBrowser(panelUrl)

  if (NO_PET) {
    say('· --no-pet：只起服务。按 Ctrl+C 停止。')
    return
  }

  // ── 桌宠窗口 ─────────────────────────────────────────────────────
  const startedAt = Date.now()
  const pet = spawn(process.execPath, [join(ROOT, 'desktop', 'launch.ts')], {
    cwd: ROOT,
    env: { ...process.env, PET_URL: panelUrl + '?pet=1' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: false,
  })
  say('· 桌宠窗口已拉起（pid ' + String(pet.pid) + '）')
  // 桌宠的 pid 也要写进 PID 文件：它是 `launch.ts` 的子进程（electron 是孙进程），
  // 而「一键停止」杀的是整棵树 —— 少了这个 pid，收尾就会把 electron 留成孤儿窗。
  writeFileSync(
    PID_FILE,
    JSON.stringify(
      { startedAt: new Date().toISOString(), live: ALLOW_LIVE, roles: stack.pids(), petPid: pet.pid ?? null },
      null,
      2,
    ),
    'utf8',
  )

  pet.on('exit', (code) => {
    const ranMs = Date.now() - startedAt
    if (code === 0) {
      say('· 桌宠已退出 → 整栈收尾')
      stack.shutdown(0)
      return
    }
    // ★ 桌宠起不来（缺 GPU、缺 Electron 二进制、镜像拉不到）时**不拆整栈**。
    //   服务本身是好的，浏览器里那份控制台完全可用；
    //   把服务一起关掉等于因为一个可选的窗口让整个系统不可用。
    say('✗ 桌宠退出（exit ' + String(code) + '，运行了 ' + Math.round(ranMs / 1000) + ' 秒）。')
    say('  服务仍在运行：' + panelUrl + '。要全部停掉跑 STOP-EVOLVE.cmd，或在此窗口按 Ctrl+C。')
  })

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      say('· 收到 ' + sig + ' → 整栈收尾')
      stack.shutdown(0)
    })
  }
}

main().catch((e) => {
  say('✗ 启动器自身出错：' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
