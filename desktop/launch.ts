/**
 * 桌宠 · 启动器（GUI 与冒烟共用一条路径）
 *
 * ── 它存在的第一理由：摘掉 `ELECTRON_RUN_AS_NODE` ─────────────────────
 * 这台机器（以及不少装过 VS Code / 各类扩展宿主的开发机）的环境里
 * **全局设着 `ELECTRON_RUN_AS_NODE=1`**。它的作用是让 Electron 退化成纯 Node：
 * 没有 `app`、没有 `BrowserWindow`、没有窗口 —— 而**不会报任何错**。
 *
 * 症状是 `require('electron')` 解析到 `node_modules/electron/index.js`（那个 npm 包壳，
 * 导出的是一个路径字符串），`import { app } from 'electron'` 则报
 * "does not provide an export named 'app'"。两个报错都指向"模块导入写法不对"，
 * 而真正的原因在环境变量上 —— 这类误导是本层最花时间的一个坑。
 *
 * 所以：**在这里删掉它**，并把它是否被删掉打印出来（藏起来就又变成玄学）。
 *
 * ── 第二理由：`PET_SMOKE=1 electron ...` 在 Windows 上不成立 ───────────
 * npm 脚本由 `cmd.exe` 执行，`VAR=value cmd` 前缀写法在 cmd 下不是设环境变量，
 * 而是被当成一个不存在的命令。为一个环境变量引 `cross-env` 不划算，
 * 所以在 Node 里设好再 spawn。
 *
 * ── 第三理由：拿得到 Electron 真实二进制路径 ──────────────────────────
 * `import electronPath from 'electron'` 得到的就是 `path.txt` 里的二进制路径，
 * 不依赖 npm 把 `node_modules/.bin` 塞进 PATH（那样在 `npm run` 之外就会失败）。
 *
 * ── 第四理由（最反直觉的一条）：`child.on('exit')` 在这台机器上不可信 ──
 * 实测（`_probe_min.ts` / `_probe_win.ts`，最小 Electron 也能复现）：
 *   Electron 子进程**确实终止**了（`process.kill(pid, 0)` 立刻探到不存在），
 *   但父进程的 `exit` / `close` 事件**始终不触发**，`child.exitCode` 恒为 `null`。
 *   `stdio: 'inherit'` 与 `stdio: 'pipe'` 表现完全一致 —— 不是管道的问题。
 *   `app.quit()` / `app.exit(0)` / `process.exit(0)` 三种退出方式都实测过，
 *   三者都能让进程终止；坏掉的只有"通知父进程"这一步。
 *
 * ★ 这个坑的代价：**"没收到退出通知"极容易被读成"进程没退出"**。
 *   顺着那个误读，桌宠主进程的退出逻辑被白改了一轮（app.exit → app.quit →
 *   process.exit 挨个换），而它们本来都是对的。
 *
 * 所以判定权不能交给进程生命周期，得交给**协议行**：
 *   主进程把结论打在 stdout 上（`PET_SMOKE_OK <json>` / `PET_SMOKE_FAIL <msg>`），
 *   启动器读到即定论，然后**主动收尾**（杀掉进程树）—— 不等一个不会来的事件。
 * 再补两条兜底，覆盖"结论行一个字都没打"的形态：
 *   · 存活轮询：`process.kill(pid, 0)` 探到进程消失 → 按已有结论收尾；
 *   · 超时：冒烟 60s 内没有任何结论 → 失败退出（否则 CI 会静默挂住）。
 *
 * 用法：
 *   npm run pet          正常启动（需先起 web 预览：vite preview --port 4173）
 *   npm run pet:smoke    冒烟：真起窗 → 截图落盘 → 打印窗口诊断 → 退出
 */

import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import electronPath from 'electron'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE = process.argv.includes('--smoke')
const DEBUG = process.env.PET_DEBUG === '1'

/**
 * 冒烟截图落盘位置。
 *
 * ★ 默认放系统临时目录，**不放项目里**：这张图是内部验证产物（证明窗真的画出来了），
 *   不是交付物。放进仓库只会让每跑一次冒烟就多一个需要人判断"要不要提交"的文件。
 */
const OUT = process.env.PET_SMOKE_OUT ?? join(tmpdir(), 'evolve-pet-smoke.png')

/** 协议行。两端逐字一致 —— 改名要同时改 `desktop/main.ts` 与 `scripts/pet-smoke.ts`。 */
const OK_LINE = 'PET_SMOKE_OK'
const FAIL_LINE = 'PET_SMOKE_FAIL'

if (typeof electronPath !== 'string' || electronPath.length === 0) {
  console.error('PET_FAIL 拿不到 Electron 二进制路径 —— 依赖可能只装了 npm 包壳。')
  console.error('（该二进制由 postinstall 从 github.com 拉取；内网环境可设 ELECTRON_MIRROR 走国内镜像后重跑 postinstall）')
  process.exit(4)
}

const env = { ...process.env }
// ★ 必须摘掉，否则 Electron 以纯 Node 模式运行：没有 app / 没有窗口 / 不报错
const hadRunAsNode = Boolean(env.ELECTRON_RUN_AS_NODE)
delete env.ELECTRON_RUN_AS_NODE
if (SMOKE && hadRunAsNode) {
  console.log('PET_INFO 已摘除本机的 ELECTRON_RUN_AS_NODE=1（不摘的话 Electron 会退化成纯 Node，窗口不会出现且无报错）')
}

if (SMOKE) {
  env.PET_SMOKE = '1'
  env.PET_SMOKE_OUT = OUT
}

/**
 * 传给 Electron 的启动开关。
 *
 * ── 为什么默认关掉 GPU ────────────────────────────────────────────────
 * 这台机器的 GPU 进程起不来（虚拟/远程环境的常见情况），而 Electron 的反应
 * **不是降级到软件渲染，而是 FATAL 直接退出**：
 *   `GPU process isn't usable. Goodbye.`
 * 表现是"桌宠闪一下就没了"，日志里全是 `gpu_process_host` 报错。
 *
 * 更关键的是：**没法在崩之前探测**（崩在启动阶段，那时候还没有 app 对象）。
 * 所以这里选了默认关：桌宠是一个 360×540 的小窗，头像动画只是 CSS transform，
 * 软件合成完全够用；而"GPU 不可用就整个起不来"的代价与收益不对等。
 *
 * 有可用 GPU 的机器想恢复硬件加速：设 `PET_GPU=1`。
 */
function switches(): string[] {
  if (process.env.PET_GPU === '1') return []
  // `--no-sandbox` 与 `--disable-gpu` 是配套的：
  // 这台机器上 GPU 进程是**秒退**（exit_code=1），而不是报显存不足之类，
  // 典型原因是 Chromium 的沙箱在本环境里建不起来。
  // 只加 `--disable-gpu` 没用 —— Electron 仍然会去拉一个 GPU 进程，
  // 拉不起来就 FATAL。
  return ['--no-sandbox', '--disable-gpu']
}

// `stdio` 必须是 `pipe` 而不是 `inherit`：结论行要从 stdout 读出来。
// （与退出事件无关 —— 上面实测过，两种 stdio 下 exit 事件都不来。）
const child = spawn(electronPath, [...switches(), join(HERE, 'main.ts')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
})

let settled = false
/** 已有结论：0 通过 / 1 失败 / null 还没说法。 */
let verdict: number | null = null

/**
 * 杀掉整棵进程树。
 *
 * Windows 上**不能用 `child.kill()`**：它只打主进程，而 Electron 的
 * renderer / GPU / utility 是各自独立的进程，主进程一死它们会变成孤儿窗口
 * 留在桌面上（表现为"退出后还剩一层透明蒙皮"）。`taskkill /T` 才是整棵树。
 *
 * 失败是正常的：进程可能已经自己退干净了，那时 taskkill 会报"找不到进程"。
 * 这条路径上任何一个失败都不该让启动器挂掉。
 */
function killTree(): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
    } catch {
      /* 已经退干净了 */
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 同上 */
  }
}

function finish(code: number, why: string): void {
  if (settled) return
  settled = true
  if (timer) clearTimeout(timer)
  clearInterval(poll)
  killTree()
  if (DEBUG) console.log(`PET_DEBUG finish code=${code} why=${why} verdict=${verdict}`)
  // 给 stdout 一点时间刷干净：Windows 上往管道/文件写是异步的，
  // 立刻 `process.exit()` 会偶发把最后几行丢掉 —— 而最后几行恰好是结论。
  setTimeout(() => process.exit(code), 150)
}

// 冒烟要等 ready-to-show + 3s 兜底定时器 + 截图，给足余量；
// 超时按失败处理，否则 CI 会在这里静默挂住。
const TIMEOUT_MS = Number(process.env.PET_SMOKE_TIMEOUT_MS ?? (SMOKE ? 60_000 : 0))
let timer: NodeJS.Timeout | null = null
if (TIMEOUT_MS > 0) {
  timer = setTimeout(() => {
    console.error(`${FAIL_LINE} 超过 ${TIMEOUT_MS}ms 未返回`)
    finish(5, 'timeout')
  }, TIMEOUT_MS)
}

/**
 * 存活轮询 —— 覆盖"进程没了、但一个字都没打"的形态。
 *
 * 之所以轮询能work：**进程是否存在是可观测的**（`process.kill(pid, 0)`），
 * 只是"它什么时候退出"这个事件不可观测。那就把事件换成状态查询。
 *
 * 1500ms 一次：桌宠正常退出要 2~4s，这个粒度足够；
 * 再密就是白白烧 CPU（轮询本身在父进程里，冒烟期间一直跑着）。
 */
const poll = setInterval(() => {
  const pid = child.pid
  if (!pid) return
  let alive = true
  try {
    process.kill(pid, 0)
  } catch {
    alive = false
  }
  if (alive) return
  // 有结论就用结论；没有结论说明它是"闷声死掉"的 —— 冒烟算失败，
  // 交互启动（非冒烟）算正常收尾（用户自己关掉了桌宠）。
  finish(verdict ?? (SMOKE ? 1 : 0), 'process-gone')
}, 1500)

if (DEBUG) {
  console.log(`PET_DEBUG spawned pid=${child.pid} args=${JSON.stringify([...switches(), 'main.ts'])}`)
}

/**
 * 把子进程的输出转发到自己 stdout，**同时**从中读结论。
 *
 * 转发是必须的（`stdio: 'pipe'` 之后子进程的输出没人自动接），
 * 而"顺便解析"让协议行不需要另开一条通道 —— 冒烟的结论本来就是给人看的日志里的一行。
 */
function relay(input: NodeJS.ReadableStream, sink: (line: string) => void): void {
  const rl = createInterface({ input })
  rl.on('line', (line) => {
    sink(line)
    if (!SMOKE || verdict !== null) return
    if (line.startsWith(OK_LINE)) {
      verdict = 0
      finish(0, 'protocol-ok')
    } else if (line.startsWith(FAIL_LINE)) {
      verdict = 1
      finish(1, 'protocol-fail')
    }
  })
}

relay(child.stdout as NodeJS.ReadableStream, (l) => console.log(l))
relay(child.stderr as NodeJS.ReadableStream, (l) => console.error(l))

// 保留退出事件的处理：本机不来，但别的环境会来，来了就当一条更早的收尾信号。
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`${FAIL_LINE} 被信号终止 ${signal}`)
    finish(6, 'signal')
    return
  }
  finish(verdict ?? code ?? 1, 'exit-event')
})
child.on('error', (err) => {
  console.error(`${FAIL_LINE} ${String(err)}`)
  finish(7, 'spawn-error')
})

// 启动器被 Ctrl+C 时，子进程不能留成孤儿 —— 用户以为关掉了，桌宠还在桌面上。
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    killTree()
    process.exit(130)
  })
}
