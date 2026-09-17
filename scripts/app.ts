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
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORTS, createStack, renderExitReport, stackRoles, stampLocal, waitForHealth } from '../server/stackCore.ts'
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

// `loadDotEnv` 只补 process.env 里还没有的键 ⇒ 显式设过的值赢。
loadDotEnv(join(ROOT, '.env'))

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

  const roles = stackRoles({ web: 'preview', venue: process.env.VENUE ?? 'sandbox', overrides })
  const health: Record<string, string> = {
    ledger: 'http://127.0.0.1:' + DEFAULT_PORTS.ledger + '/healthz',
    orch: 'http://127.0.0.1:' + DEFAULT_PORTS.orch + '/healthz',
    web: 'http://127.0.0.1:' + DEFAULT_PORTS.web + '/',
  }

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
    const ok = await waitForHealth(health[role.name], budget)
    if (!ok) {
      say('✗ [' + role.name + '] ' + String(Math.round(budget / 1000)) + ' 秒内没有起来（' + health[role.name] + '）。上面是它的输出。')
      if (role.name === 'orch') {
        say('  （它启动时要同步预热过拟合证据，实测约 21~22 秒；若上面停在"过拟合证据已预热"之后，多半是历史数据拉取或 venue 握手卡住）')
      }
      if (role.name === 'web') say('  （若提示端口被占：4173 上还挂着上一次没退干净的进程，先跑 STOP-EVOLVE.cmd）')
      stack.shutdown(1)
      return
    }
    say('· [' + role.name + '] 就绪 ' + health[role.name])
  }

  writeFileSync(
    PID_FILE,
    JSON.stringify({ startedAt: new Date().toISOString(), live: ALLOW_LIVE, roles: stack.pids() }, null, 2),
    'utf8',
  )

  const panelUrl = 'http://localhost:' + DEFAULT_PORTS.web + '/'
  say('')
  say('  控制台   ' + panelUrl)
  say('  编排 API http://localhost:' + DEFAULT_PORTS.orch + '（令牌 ' + (process.env.ORCH_TOKEN ?? 'dev-insecure-token') + '）')
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
