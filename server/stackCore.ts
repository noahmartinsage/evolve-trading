/**
 * 本地栈的进程监管 + 角色清单 —— **全仓库唯一一份**
 *
 * ── 为什么必须唯一 ────────────────────────────────────────────────────
 * 「把账本 / 编排 / 前端这三个进程拉起来」在仓库里有两个入口：
 *   · `npm run stack`（开发用：前端跑热更 dev server）
 *   · 双击 `START-EVOLVE.cmd`（使用用：前端跑 `dist` 构建产物 + 桌面壳）
 * 两者的差别**只有第三个进程**，而端口、令牌、场所、账本地址必须逐字一致。
 * 各写一遍的后果不是"多几行代码"，而是那种最难归因的症状：
 * 开发环境一切正常、双击启动后页面打不开（端口或令牌对不上），
 * 而界面只会说一句 `Failed to fetch`。
 *
 * ── Windows 上收尾必须 `taskkill /T` ──────────────────────────────────
 * `child.kill()` 只打主进程。vite / electron 都会派生进程，主进程一死，
 * 子进程留成孤儿 —— 症状是"端口被占"和任务管理器里一排 node。
 * 这条在本机实测过，所以 `killTree` 是唯一的收尾路径。
 *
 * ── 为什么"意外退出"必须写一份取证报告，而不是一行 `exit 1` ───────────
 * 本机 Windows 实测（S-K1 固化）：自己 `exit 1`、被 `taskkill /T /F` 打死、
 * 未捕获异常崩溃 —— 父进程拿到的退出事件**逐字节相同**（`code:1, signal:null`）。
 * 所以「记下退出码」这个动作**本身不产生信息**：
 * 上一轮那个"账本静默 exit 1、复现不出来"的事故，不是没记，
 * 而是记下来的东西对应三个不同的事因，且与"我自己 taskkill 误伤"完全同形。
 * ⇒ 报告里真正有用的是三样**互相独立**的观测：
 *   ① 该角色临死前最后一行输出是什么、离死多久（静默期本身是证据）
 *   ② 它有没有写崩溃记录（`crashed`）—— 来自子进程的遗言，见 `crashGuard.ts`
 *   ③ 它的 guard 到底装上没有（`crashGuardArmed`）
 *   只有 ③ 成立时才敢用 ② 反推"不是自崩溃"；否则「无法判定」（fail-closed）。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export interface StackRole {
  name: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** 崩溃记录的两种标记。**只在 `crashGuard.ts` 里产生，只在这里被读**，不做第二份定义。 */
export const CRASH_MARK = '[CRASH]'
export const CRASH_ARM_MARK = '[CRASH-GUARD] armed'

/**
 * 崩溃记录文件的路径约定 —— **全仓库唯一一份**。
 * 设进角色 env、被 guard 读取、被监督进程回读，三处必须是同一个值；
 * 各写一遍的结果是"guard 写到了 A，监督进程去看 B"，而表现只是"没记录"（=假结论）。
 */
export function crashLogPathFor(role: string): string {
  return 'data/crash-' + role + '.log'
}

/**
 * 本地时间戳，带 UTC 偏移。
 *
 * ★ 为什么不直接用 `toISOString()`：它是 UTC。本机是 GMT+8，于是日志里
 *   11:50 发生的事记成 `03:50`，而文件管理器、任务管理器、用户看到的一切都是本地时间 ——
 *   排查时**按错 8 小时去找现场**（上一轮就这么绕过一次，把"8 分钟前"当成"很久以前"）。
 *   带上 `+08:00` 之后，两种格式在肉眼上就能区分，老日志也不用改写。
 */
export function stampLocal(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    ' ' + sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
  )
}

/** 该角色有没有声明崩溃记录（= `stackRoles` 给它设了 `EVOLVE_CRASH_LOG`）。 */
interface CrashLogProbe {
  declared: boolean
  path: string | null
  /** 记录文件里有 `armed` 行 ⇒ guard 真的活着装上了。 */
  armed: boolean
  /** 记录文件里有崩溃记录 ⇒ 它是自己崩的。 */
  crashed: boolean
}

function probeCrashLog(role: StackRole): CrashLogProbe {
  const path = typeof role.env.EVOLVE_CRASH_LOG === 'string' ? role.env.EVOLVE_CRASH_LOG : null
  if (!path) return { declared: false, path: null, armed: false, crashed: false }
  let text = ''
  try {
    if (existsSync(path)) text = readFileSync(path, 'utf8').slice(0, 64 * 1024)
  } catch {
    /* 读不到就当没写 ⇒ armed=false ⇒ 后面只会落到"无法判定"，不会假结论 */
  }
  return {
    declared: true,
    path,
    armed: text.includes(CRASH_ARM_MARK),
    // 崩溃记录一定带 kind=（见 crashGuard），比单纯 includes('[CRASH]') 更不容易被别的东西撞上
    crashed: new RegExp(CRASH_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' kind=').test(text),
  }
}

export interface RoleExitReport {
  name: string
  code: number | null
  signal: NodeJS.Signals | null
  startedAt: string
  exitedAt: string
  uptimeMs: number
  /** 最后一行输出。**空串本身就是证据**：它死前什么都没说。 */
  lastLine: string
  lastLineAt: string | null
  /** 距最后一次说话过了多久。null = 从头到尾没说过话。 */
  silentForMs: number | null
  /** 最近 20 行输出（**分组后的临终上下文**；完整上下文在总日志里但被其它角色穿插）。 */
  tail: string[]
  crashLogDeclared: boolean
  crashLogPath: string | null
  crashGuardArmed: boolean
  crashed: boolean
}

export type ExitCauseHint = 'self_crash' | 'not_self_crash' | 'unknown'

/**
 * 从报告反推事因。**三态，缺证据一律 `unknown`。**
 *
 * ★ 这里的 `unknown` 不是"偷懒"，它是本模块最重要的返回值：
 *   报告里那三个观测在"崩溃"和"被我自己的 taskkill 打死"两种情况下的前两个
 *   （`code` / `signal`）**完全相同**，唯一的分辨依据是子进程有没有留下遗言。
 *   而"没有遗言"只有在**确认guard 活着**（armed）时才成立。
 *   少了这一层，父进程会对每一次外部杀死都自信地宣布"不是崩溃"——
 *   一个不会报错的错结论。
 */
export function inferExitCause(r: RoleExitReport): ExitCauseHint {
  if (r.crashed) return 'self_crash'
  if (r.crashGuardArmed) return 'not_self_crash'
  return 'unknown'
}

/** 把报告渲染成人看的几行。**两个入口共用一份**，避免"开发日志和双击日志说法不一样"。 */
export function renderExitReport(r: RoleExitReport): string[] {
  const cause = inferExitCause(r)
  const out: string[] = []
  out.push('✗ [' + r.name + '] 意外退出 · exit=' + String(r.code) + ' signal=' + String(r.signal))
  out.push('    存活 ' + (r.uptimeMs / 1000).toFixed(1) + 's（' + r.startedAt + ' → ' + r.exitedAt + '）')
  if (r.lastLineAt === null) {
    out.push('    最后一句话：**从启动到死亡一个字都没输出**')
  } else {
    out.push('    最后一句话（' + ((r.silentForMs ?? 0) / 1000).toFixed(1) + 's 前）：' + r.lastLine)
  }
  if (r.crashLogPath) {
    out.push('    崩溃记录 ' + r.crashLogPath + ' · guard ' + (r.crashGuardArmed ? '已装上' : '**没看到 armed 行**') +
      ' · 崩溃记录 ' + (r.crashed ? '有' : '无'))
  } else {
    out.push('    崩溃记录：这个角色没有声明（`EVOLVE_CRASH_LOG` 未设）')
  }
  if (cause === 'self_crash') out.push('    ⇒ 判定：**它自己崩了**，原因见上面的崩溃记录。')
  else if (cause === 'not_self_crash') out.push('    ⇒ 判定：**不是自崩溃** —— 它是被要求退出的（外部 taskkill / 自己的 exit(code) / 系统回收），不是抛异常挂掉的。先查本轮谁动过进程，别去翻代码。')
  else out.push('    ⇒ 判定：**无法判定**（这个角色没有可用的遗言机制）—— 不要在这里写原因，先把它接上 `installCrashGuard`。')
  if (r.tail.length > 0) {
    out.push('    ── 临终前最后 ' + String(r.tail.length) + ' 行 ──')
    for (const l of r.tail) out.push('    | ' + l)
  }
  return out
}

export interface StackHandle {
  start(role: StackRole): void
  /** 杀整棵树后退出。`code` 是"这个栈的整体结论"。 */
  shutdown(code?: number): void
  /** 已启动角色的 pid，用于写 PID 文件（供一键停止）。 */
  pids(): Array<{ name: string; pid: number }>
  alive(name: string): boolean
  isShuttingDown(): boolean
}

/** 默认端口。★ 编排层必须是 8790：前端 `Store.tsx` 的默认连接地址就是它。 */
export const DEFAULT_PORTS = { ledger: 8791, orch: 8790, web: 4173 } as const

/** 本地默认令牌。**不用于生产**（生产走机密管理，见 loadEnv.ts 顶部）。 */
export const DEV_TOKEN = 'dev-insecure-token'

function killTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
    } catch {
      /* 已经退干净了 —— 这条路径上任何失败都不该让收尾卡住 */
    }
    return
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 同上 */
  }
}

/** 每个角色保留多少行临终输出。够看出"死前在干什么"，又不会把日志淹掉。 */
const TAIL_LINES = 20

export function createStack(opts: {
  /** 输出一行日志。两个入口的落点不同（控制台 / 日志文件），所以由调用方决定。 */
  log?: (line: string) => void
  /** 某个角色**意外**退出时回调（正常收尾不会触发）。收到的是取证报告，不是退出码。 */
  onUnexpectedExit?: (report: RoleExitReport) => void
  /**
   * 覆盖「退出自己」的动作。默认 `process.exit`。
   * ★ 做成可注入的，测试才能**同时**断言"收尾时会退出"与"正常退出不触发告警"——
   *   否则验证这个模块就必须把测试进程自己杀掉（本项目对门禁的一贯要求：可注入才可断言）。
   */
  exit?: (code: number) => void
} = {}): StackHandle {
  const children: Array<{ role: StackRole; proc: ChildProcess; startedMs: number; tail: Array<{ at: number; text: string }> }> = []
  let shuttingDown = false
  const log = opts.log ?? ((l: string) => console.log(l))
  const exit = opts.exit ?? ((code: number) => process.exit(code))

  return {
    start(role) {
      const proc = spawn(role.command, role.args, {
        env: { ...process.env, ...role.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const entry = { role, proc, startedMs: Date.now(), tail: [] as Array<{ at: number; text: string }> }
      children.push(entry)
      const pipe = (d: Buffer) => {
        for (const line of d.toString('utf8').split('\n')) {
          const t = line.trimEnd()
          if (!t.trim()) continue
          entry.tail.push({ at: Date.now(), text: t })
          if (entry.tail.length > TAIL_LINES) entry.tail.shift()
          log('[' + role.name + '] ' + t)
        }
      }
      proc.stdout?.on('data', pipe)
      proc.stderr?.on('data', pipe)
      proc.on('exit', (code, signal) => {
        if (shuttingDown) return
        const now = Date.now()
        const last = entry.tail[entry.tail.length - 1]
        const probe = probeCrashLog(role)
        opts.onUnexpectedExit?.({
          name: role.name,
          code,
          signal,
          startedAt: stampLocal(new Date(entry.startedMs)),
          exitedAt: stampLocal(new Date(now)),
          uptimeMs: now - entry.startedMs,
          lastLine: last?.text ?? '',
          lastLineAt: last ? stampLocal(new Date(last.at)) : null,
          silentForMs: last ? now - last.at : null,
          tail: entry.tail.map((x) => stampLocal(new Date(x.at)) + ' ' + x.text),
          crashLogDeclared: probe.declared,
          crashLogPath: probe.path,
          crashGuardArmed: probe.armed,
          crashed: probe.crashed,
        })
      })
    },
    shutdown(code = 0) {
      if (shuttingDown) return
      shuttingDown = true
      for (const c of children) killTree(c.proc)
      // 留一点时间让 stdout 刷完：本机往管道写是异步的，
      // 立刻退出会偶发把最后几行（往往正是结论）丢掉。
      setTimeout(() => exit(code), 200)
    },
    pids() {
      return children
        .filter((c) => typeof c.proc.pid === 'number')
        .map((c) => ({ name: c.role.name, pid: c.proc.pid as number }))
    },
    alive(name) {
      const c = children.find((x) => x.role.name === name)
      if (!c || typeof c.proc.pid !== 'number') return false
      try {
        process.kill(c.proc.pid, 0)
        return true
      } catch {
        return false
      }
    },
    isShuttingDown() {
      return shuttingDown
    },
  }
}

/**
 * 轮询等待某个 HTTP 端点可用。
 *
 * ★ 判定用**状态码存在**而不是"返回 200"：`/healthz` 之外的端点会 401，
 *   那也是"服务起来了"的证据。用 200 当判据会让等待永远超时，
 *   而超时的表现是"启动失败"，与真正的原因（判据写窄了）看起来毫无关系。
 */
export async function waitForHealth(url: string, timeoutMs = 25_000, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (r.status > 0) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  return false
}

export interface StackConfig {
  ports?: Partial<typeof DEFAULT_PORTS>
  token?: string
  /** 执行场所。**默认 sandbox**：本地预览不该走真钱。 */
  venue?: string
  binanceRest?: string
  /**
   * 前端形态。
   *   `preview` —— 跑 `dist` 构建产物（vite preview）。看起来像正式环境。
   *   `dev`     —— 跑热更 dev server。
   */
  web: 'preview' | 'dev'
  /**
   * 进程级环境覆盖。**它会赢过 `.env`** —— 因为 `loadDotEnv` 只补
   * `process.env` 里**还没有**的键（见 loadEnv.ts）。
   * 本地预览靠这一条把 `.env` 里的 `AUTOPILOT_LIVE=true` 按回 false。
   */
  overrides?: NodeJS.ProcessEnv
}

/** 三个角色。**端口与令牌只在这里出现一次。** */
export function stackRoles(cfg: StackConfig): StackRole[] {
  const ports = { ...DEFAULT_PORTS, ...cfg.ports }
  const token = cfg.token ?? DEV_TOKEN
  const rest = cfg.binanceRest ?? 'https://data-api.binance.vision'
  const overrides = cfg.overrides ?? {}
  const webArgs =
    cfg.web === 'preview'
      ? // `--strictPort`：预览端口被占时**直接失败**，不要静默换一个。
        // 桌宠窗口连的是写死的 4173，换端口的结果是"窗口连到别的东西上"，
        // 而它看起来只是"页面没反应"。
        ['node_modules/vite/bin/vite.js', 'preview', '--port', String(ports.web), '--strictPort']
      : ['node_modules/vite/bin/vite.js']

  return [
    {
      name: 'ledger',
      command: process.execPath,
      args: ['server/ledgerServer.ts'],
      env: {
        ORCH_DB: process.env.LEDGER_DB ?? 'data/ledger.db',
        LEDGER_PORT: String(ports.ledger),
        ORCH_TOKEN: token,
        BINANCE_REST: rest,
        // ★ 声明崩溃记录 = 告诉监督进程"这个角色会留遗言"。
        //   只有声明了、且记录文件里真有 armed 行，监督进程才敢用
        //   "没有崩溃记录"去反推"不是自崩溃"。web 角色（vite）不设它。
        EVOLVE_CRASH_LOG: crashLogPathFor('ledger'),
        ...overrides,
      },
    },
    {
      name: 'orch',
      command: process.execPath,
      args: ['server/index.ts'],
      env: {
        PORT: String(ports.orch),
        ORCH_TOKEN: token,
        BINANCE_REST: rest,
        VENUE: cfg.venue ?? 'sandbox',
        ORCH_LEDGER_URL: 'http://localhost:' + ports.ledger,
        EVOLVE_CRASH_LOG: crashLogPathFor('orch'),
        ...overrides,
      },
    },
    {
      name: 'web',
      command: process.execPath,
      args: webArgs,
      env: { ...overrides },
    },
  ]
}
