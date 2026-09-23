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

import { HEALTH_ROLE_FIELD, healthRoleOf, isServiceRole, type ServiceRole } from './serviceIdentity.ts'
import { INSECURE_DEFAULT_TOKEN } from './orchAuth.ts'

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

/**
 * 本地默认令牌。**不用于生产**（生产走机密管理，见 loadEnv.ts 顶部）。
 *
 * ★★ 值本身住在 `server/orchAuth.ts`（那里才是判据的家）。
 *   这里原来又写了一遍字面量 —— 于是"默认令牌"在仓库里有四个主人，
 *   而这次给它加回环限制时就正好踩到了：改了三个地方、漏了第四个，
 *   症状是"启动了但连不上"，看起来像网络问题。
 *   现在它只是个别名，`npm run test:authz` 会盯着"server/** 里这个字面量只许出现一次"。
 */
export const DEV_TOKEN = INSECURE_DEFAULT_TOKEN

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
          // ★ 钳到 ≥0：stdout 管道可能**比 exit 事件晚**被读到 —— 父进程自己的
          //   事件循环被判给 taskkill 的同步调用挡住时尤其明显。此时
          //   `last.at > now`，差值为负。负数对"距最后一次说话过了多久"
          //   没有含义：它不是"提前说了话"，只是父进程读到它的时刻晚于
          //   它观测到退出的时刻。实测形态见 smoke 的 S-K3。
          silentForMs: last ? Math.max(0, now - last.at) : null,
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
 * 本机的**全部**回环写法。**必须都试。**
 *
 * ★ `127.0.0.1` 与 `[::1]` 在 Windows 上是两条独立的路：同一个端口可以被两个
 *   不同进程分别占住。只试一条，就等于把"另一个进程"误当成"服务没起来"
 *   （或反过来，误当成"服务好了"）。两种误判都会把排查引向错误的方向。
 *   实证与"为什么必须问『你是谁』"见 `serviceIdentity.ts`。
 */
export const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'] as const

export interface LoopbackTry {
  url: string
  /** 人话结论。失败时**必须**能从这个字段看出下一步该查什么。 */
  verdict: string
  ours: boolean
  /**
   * 有东西应答了吗（HTTP 层面收到了响应）。
   * ★ 与 `ours` **分开**：`answered && !ours` = 「有别人的进程占着这个端口」，
   *   而 `!answered` = 「这条路没人」。两者要做的事完全不同（查占端口 vs 查服务为什么不起来）。
   */
  answered: boolean
  body?: unknown
}

export interface LoopbackResolution {
  /** 真的是我们的那个 base（`http://<host>:<port>`）。全都没认出来时是 `null`。 */
  base: string | null
  body: unknown
  /** 逐个地址的判定。**`base === null` 时它是唯一能看的东西**，所以永远都返回。 */
  tries: LoopbackTry[]
}

/**
 * 在**所有回环写法**上找一个「真的是我们的」服务。
 *
 * ★ 不认识的一律算「有人但不是我们」——**不许当成"没有服务"**。
 *   这两件事指向相反的动作：前者要去查是谁占了端口，后者才是"服务挂了"。
 *   判据 13 的同一条：分得清"能力没有"和"名字烂了"。
 */
export async function resolveLoopbackService(
  port: number,
  path: string,
  role: ServiceRole,
  perTryMs = 2000,
): Promise<LoopbackResolution> {
  const tries: LoopbackTry[] = []
  let found: { base: string; body: unknown } | null = null
  // ★ **不许找到就返回**：两个地址都要看一眼。
  //   因为"另一条路上坐着别人的服务"本身就是一条要报出来的隐患 ——
  //   它不是本次启动的问题，而是**下一个**去连 `127.0.0.1` 的工具的坑，
  //   而那时表现是"端点 404 / 数据是别人的"，与今天的现象毫无相似之处。
  for (const host of LOOPBACK_HOSTS) {
    const url = `http://${host}:${port}${path}`
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(perTryMs) })
      const text = await r.text()
      let body: unknown = null
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = null
      }
      const got = healthRoleOf(body)
      if (r.ok && isServiceRole(body, role)) {
        tries.push({ url, verdict: '是我们的（自报 ' + HEALTH_ROLE_FIELD + '=' + got + '）', ours: true, answered: true, body })
        if (found === null) found = { base: `http://${host}:${port}`, body }
        continue
      }
      if (got !== null) {
        tries.push({
          url,
          verdict: '★ 有人，但不是我们 —— 它自报 ' + HEALTH_ROLE_FIELD + '=' + got + '，要查是谁占了这个端口',
          ours: false,
          answered: true,
          body,
        })
      } else if (r.status > 0) {
        tries.push({
          url,
          verdict:
            '★ 有人，但不是我们 —— HTTP ' +
            String(r.status) +
            ' 且没有 ' +
            HEALTH_ROLE_FIELD +
            ' 声明（多半是**另一个程序**占着这个端口）',
          ours: false,
          answered: true,
          body,
        })
      } else {
        tries.push({ url, verdict: '有人，但不是我们（空响应）', ours: false, answered: true, body })
      }
    } catch (e) {
      tries.push({ url, verdict: '没人应答（' + (e instanceof Error ? e.message : String(e)) + '）', ours: false, answered: false })
    }
  }
  return { base: found?.base ?? null, body: found?.body ?? null, tries }
}

/**
 * 反复找，直到找到我们自己的那个地址或超时。返回的是**最后一次**的逐条判定 ——
 * 超时时它才是唯一能看的东西（"谁在答话"比"超时了"有用得多）。
 */
export async function waitForLoopbackService(
  port: number,
  path: string,
  role: ServiceRole,
  timeoutMs = 25_000,
  intervalMs = 500,
): Promise<LoopbackResolution> {
  const deadline = Date.now() + timeoutMs
  let last = await resolveLoopbackService(port, path, role)
  while (last.base === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    last = await resolveLoopbackService(port, path, role)
  }
  return last
}

/** 把 `resolveLoopbackService` 的逐条判定渲染成人读的几行。 */
export function renderLoopbackTries(tries: LoopbackTry[]): string[] {
  return tries.map((t) => '    · ' + t.url + ' → ' + t.verdict)
}

/**
 * 轮询等待某个 HTTP 端点可用。
 *
 * ★ 判定用**状态码存在**而不是"返回 200"：`/healthz` 之外的端点会 401，
 *   那也是"服务起来了"的证据。用 200 当判据会让等待永远超时，
 *   而超时的表现是"启动失败"，与真正的原因（判据写窄了）看起来毫无关系。
 *
 * ★ 传了 `role` 就**必须**认身份：端口上可能坐着别人的服务（见 `HEALTH_ROLE_FIELD`），
 *   此时"通了"是假绿。`web`（vite preview）没有身份端点，所以它不传 `role` ——
 *   这是**唯一**允许不认身份的角色，且原因写在调用点上。
 */
export async function waitForHealth(
  url: string,
  timeoutMs = 25_000,
  intervalMs = 300,
  role?: ServiceRole,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (r.status > 0) {
        if (role === undefined) return true
        let body: unknown = null
        try {
          body = (await r.json()) as unknown
        } catch {
          body = null
        }
        if (isServiceRole(body, role)) return true
      }
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
   * 要不要让**别的设备**（手机）连上这个前端。
   *
   * ★ 默认 `false`。`vite preview` 不给 `--host` 时只监听回环，
   *   于是手机连着同一个 WiFi 也打不开 —— 那正是"默认安全"的那一侧。
   *
   * ★★ 打开它必须**同时**有个真令牌，否则等于把出单端点挂到路由器上：
   *   前端只是壳，真正能下单的是编排层，而编排层本来就在监听所有网卡。
   *   令牌那一半的判据在 `server/index.ts` 的 `authorized()`（默认令牌只在回环上算数）。
   *   `scripts/app.ts` 在起服务**之前**就把"远程 + 默认令牌"这一组合拒掉。
   */
  remote?: boolean
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
        //
        // `--host` 只在 `remote` 时加：不加的时候 vite 只监听回环，
        // 手机同一个 WiFi 也打不开 —— 那是默认该有的样子。
        [
          'node_modules/vite/bin/vite.js',
          'preview',
          '--port',
          String(ports.web),
          '--strictPort',
          ...(cfg.remote ? ['--host'] : []),
        ]
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

// ── 启动之后的「运行态」摘要 ─────────────────────────────────────────
//
// 为什么要有这一段：**启动器打印的东西必须是它真的读到的东西。**
// "自循环已常开"「账号池已就绪」这类话如果只是把常量念一遍，那么额度爆掉、
// 循环被 EV_AUTONOMY 关掉、账号一个都没配的时候，启动器会**照样这么说** ——
// 用户看到一片绿，而系统其实什么都干不了。所以这三行全部来自刚起来的服务：
// `/fleet`（通道现状）、`/fleet/autonomy`（循环与下次时刻）、`/fleet/news`（最近读到什么）。
//
// ★ 读不到时必须**说读不到**，不许退化成 0：`null` 不是"零个账号"，也不是"没在跑"。
//   这两件事指向完全相反的动作（去配账号 vs 去启动循环），
//   而它们的显示形式如果都是"0"，用户没有任何办法分辨（判据 13）。

/** 三个只读探针的原始响应体。`null` = 这一项没读到。 */
export interface RuntimeProbe {
  fleet: {
    pool?: {
      total?: number
      ready?: number
      allExhausted?: boolean
      speech?: string
      nextRecoveryAt?: number | null
      /** 池里每个账号。用于回答"我新加的 key 认到没有"。 */
      accounts?: { name?: string; exhausted?: boolean }[]
    }
  } | null
  autonomy: {
    status?: {
      running?: boolean
      startCount?: number
      jobs?: { id: string; label: string; nextAt?: number | null; skippedCount?: number; runCount?: number }[]
    }
  } | null
  news: {
    latest?: { title?: string; score?: number }[]
    threshold?: number
    /** 还没被人裁决的内化提案数。 */
    pending?: number
    /** 服务端给的那句话（"读不到提案单"与"没有待办"是两句不同的话）。 */
    pendingSpeech?: string
    /** `null` = 读不到榜单；`{ticks: []}` = 空榜。两种必须分开画。 */
    trending?: { at?: number; ticks?: { ticker: string; weighted: number; mentions: number }[] } | null
    universe?: { symbols?: string[]; note?: string }
  } | null
  /** 没读到的那几项各自的**原因**。读不到的句子必须带上它，否则没法查。 */
  errors?: Partial<Record<MissKey, string>>
  /**
   * 真的读到「我们自己」的那个地址（`null` = 没找到）。
   * ★ 必须印出来：本机 `127.0.0.1:8790` 与 `[::1]:8790` **可以是两个不同的服务**，
   *   不写清楚"这几行是从谁的嘴里读的"，出问题时连该查哪条路都不知道。
   */
  base?: string | null
  /** 同一端口上**别人**在答话的地址（已渲染成人话）。下一次别的人还会踩，所以要说出来。 */
  squatters?: string[]
}

/**
 * 「读不到」的条目名。
 *
 * ★ 为什么连这个都要显式列出：每一项读不到时的**下一步动作**不同 ——
 *   自治循环读不到要去看编排日志；提案待办数读不到要去看
 *   `data/learn/notes.jsonl` 在不在；品种热度读不到要去看
 *   `data/news/trending.json`。合成一个 `news` 键的话，
 *   三种不同的下一步会被同一句话糊住。
 */
export type MissKey = 'fleet' | 'autonomy' | 'news' | 'news.pending' | 'news.trending'

/** 相对时刻的人话。`null` 与"马上"是两件事，所以这里没有默认值。 */
function inWords(ms: number): string {
  if (ms <= 0) return '已到期'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' 秒后'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分后'
  return Math.floor(m / 60) + ' 小时 ' + String(m % 60).padStart(2, '0') + ' 分后'
}

function clockOf(ts: number): string {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/**
 * 渲染那三行。**纯函数**：给它一份探针结果，输出几行文字，不碰网络也不碰磁盘 ——
 * 所以"读不到时会说什么"这件事可以用构造出来的输入断言（`test:stack` S-A1）。
 */
export function renderRuntimeSummary(p: RuntimeProbe, now: number = Date.now()): string[] {
  const miss = (key: MissKey, what: string): string =>
    '· ' + what + '  ⚠ 读不到（' + (p.errors?.[key] ?? '未知原因') + '）—— 这不等于「没有」，是这一项没读上，别当成正常'

  const lines: string[] = []

  // ⓪ 先说清楚**这几行是从谁的嘴里读的**。
  //   本机实测：`127.0.0.1:8790` 上坐着的是**别的程序**，我们的编排层在 `[::1]` 那边。
  //   不写这一行，下面那三行"读不到"就会被读成"服务坏了"，而真正该做的是去查哪个进程占了端口。
  if (p.base) {
    lines.push('· 编排层   ' + p.base + '（自报身份已核对：是我们自己的那个）')
  } else if (p.base === null) {
    lines.push('· 编排层   ⚠ **两条回环地址上都没有我们的服务** —— 上面的三项读不到是这个原因，不是"没有数据"')
  }
  for (const s of p.squatters ?? []) {
    lines.push('· ⚠ 同一端口的另一条回环地址上是**别人的服务**：' + s + ' ⇒ 谁写死那条地址去连，谁就会连到它上面（读到的数据是别人的，而端点看着"通"）')
  }

  // ① 自治循环
  if (p.autonomy === null || !p.autonomy.status) {
    lines.push(miss('autonomy', '自治循环'))
  } else {
    const st = p.autonomy.status
    const jobs = st.jobs ?? []
    if (st.running) {
      // 「下次什么时候」是这一行的重点：用户问"它到底有没有在动"，
      // 能回答的只有排程时刻，而它不是常量。
      const upcoming = jobs
        .filter((j) => typeof j.nextAt === 'number')
        .sort((a, b) => (a.nextAt as number) - (b.nextAt as number))[0]
      const next = upcoming
        ? ' · 最近一项 ' + upcoming.label + ' ' + clockOf(upcoming.nextAt as number) + '（' + inWords((upcoming.nextAt as number) - now) + '）'
        : ' · 这一轮还没有排程时刻'
      const skipped = jobs.reduce((s, j) => s + (j.skippedCount ?? 0), 0)
      lines.push(
        '· 自治循环  运行中 · ' + jobs.length + ' 项排程' + next + (skipped > 0 ? ' · 累计因额度跳过 ' + skipped + ' 次' : ''),
      )
    } else {
      lines.push('· 自治循环  没在跑（自启动过 ' + (st.startCount ?? 0) + ' 次）→ 要它自己动，在控制台说「一键启动自治循环」')
    }
  }

  // ② 账号池（免费模型通道）
  if (p.fleet === null || !p.fleet.pool) {
    lines.push(miss('fleet', '模型账号池'))
  } else {
    const pool = p.fleet.pool
    const total = pool.total ?? 0
    const ready = pool.ready ?? 0
    // 是不是把用户配的 key 认到了 —— 这一行是**唯一**能回答它的地方：
    // 池子安静时 `exhausted` 是空的，那既可能是"都好好的"，也可能是"根本没读进来"。
    const names = (pool.accounts ?? []).map((a) => a.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
    const who = names.length > 0 ? '（' + names.slice(0, 4).join(' / ') + (names.length > 4 ? ' 等 ' + names.length + ' 个' : '') + '）' : ''
    if (total === 0) {
      lines.push('· 模型账号池  一个账号都没配 —— 这是「通道没配」，不是额度用完了（去 .env 的 EV_LLM_ACCOUNTS 加）')
    } else if (ready > 0) {
      lines.push('· 模型账号池  ' + total + ' 个账号' + who + '，' + ready + ' 个今天还能用')
    } else {
      const when = typeof pool.nextRecoveryAt === 'number' ? clockOf(pool.nextRecoveryAt) + '（' + inWords(pool.nextRecoveryAt - now) + '）' : '明天'
      lines.push('· 模型账号池  ' + total + ' 个账号' + who + '今天全用完了，' + when + '自动恢复' + (pool.speech ? ' —— ' + pool.speech : ''))
    }
  }

  // ③ 新闻雷达
  const newsJob = p.autonomy?.status?.jobs?.find((j) => j.id === 'news_watch')
  const newsNext =
    newsJob && typeof newsJob.nextAt === 'number'
      ? ' · 下次 ' + clockOf(newsJob.nextAt) + '（' + inWords(newsJob.nextAt - now) + '）'
      : ' · 下次时刻读不到（自治循环没在跑就没有排程）'
  if (p.news === null) {
    lines.push(miss('news', '新闻雷达'))
  } else {
    const items = p.news.latest ?? []
    // ★ 取**最后一条**而不是第一条：`latestDigest()` 返回的是「最近 limit 条、
    //   按时间正序」，所以最新的一条在末尾。取 `[0]` 会把最旧的一条当"最新"，
    //   而那个错误看起来完全正常（有标题、有链接，只是过时了）。
    const newest = items[items.length - 1]
    const title = typeof newest?.title === 'string' ? newest.title.trim() : ''
    const head = title.length > 0 ? ' · 最新「' + (title.length > 44 ? title.slice(0, 44) + '…' : title) + '」' : ''
    lines.push('· 新闻雷达  最近 ' + items.length + ' 条够相关（门线 ' + (p.news.threshold ?? '?') + ' 分）' + head + newsNext)

    // 内化提案的待办数。★ 这一段是"提案有人读"的证据：没有它，
    //   提案躺在 data/learn/notes.jsonl 里没有任何人知道（判据 10）。
    //   话术直接用**服务端那一句** —— 在本地另写一套判断，
    //   迟早会出现"启动器说没有待办、面板说有 3 条"这种自相矛盾。
    const speech = p.news.pendingSpeech
    if (typeof speech === 'string' && speech.length > 0) {
      lines.push('· 内化提案  ' + speech)
    } else {
      lines.push(miss('news.pending', '内化提案待办数'))
    }

    // 品种热度 → breadth 候选。这一行是雷达**唯一接回系统行为**的那根线，
    // 所以它必须出现在启动画面上：坏了要第一时间看见。
    const ticks = p.news.trending?.ticks
    if (p.news.trending === null || p.news.trending === undefined) {
      lines.push(miss('news.trending', '品种热度（breadth 的候选清单来源）'))
    } else if (ticks && ticks.length === 0) {
      lines.push('· 品种热度  空榜 —— 这一轮没有任何品种被提到（不是读不到）')
    } else {
      const top = (ticks ?? []).slice(0, 5).map((t) => t.ticker).join('、')
      const sym = p.news.universe?.symbols ?? []
      lines.push('· 品种热度  ' + top + ' → breadth 候选 ' + (sym.length > 0 ? sym.join('、') : '（空）'))
    }
  }

  return lines
}
