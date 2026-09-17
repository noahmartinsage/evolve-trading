/**
 * 崩溃遗言 —— 让「子进程为什么没了」这件事**留下证据**
 *
 * ── 为什么必须有它（实测，不是推测）────────────────────────────────────
 * 本机 Windows 实测（`scripts/stack-smoke.ts` S-K1 把它固化成断言）：
 *
 *   ① 自己 `process.exit(1)`
 *   ② 被 `taskkill /PID x /T /F` 打死
 *   ③ 未捕获异常崩溃
 *
 * 父进程拿到的三份 `exit` 事件**逐字节相同**：`{ code: 1, signal: null }`。
 * ⇒ 监督进程**永远**无法从退出状态分辨「它崩了」和「它被外面打死了」。
 *   上一轮那个「账本静默 exit 1、复现不出来」的事故正卡在这里：
 *   现象真实存在，结论写不出来 —— 因为当时根本没有**可分辨的观测量**，
 *   而 `onUnexpectedExit(name, code)` 连 `signal` 都丢掉了。
 *
 * 唯一能区分的证据是**子进程自己临死前说了什么**。所以这个文件做的事只有一件：
 * 让每一个可能的崩溃路径都**先留下遗言**。
 * 装上它之后就有了判定规则（`stackCore.inferExitCause`）：
 *   有崩溃记录 ⇒ 自崩溃；armed 过但没记录 ⇒ 被外部打死；没 armed ⇒ 无法判定。
 *
 * ── 为什么先落盘、再打印、最后才退 ────────────────────────────────────
 * 本机往管道写 stdout/stderr 是**异步**的 —— `stackCore.shutdown` 早就为此让出 200ms
 * （那里的注释写着「立刻退出会偶发把最后几行（往往正是结论）丢掉」）。
 * 但同一条道理从未应用到**子进程的崩溃路径**上：`console.error` 之后立刻 `process.exit`，
 * 在 Windows 上有机会把最后几行丢掉，而那些行恰好就是原因本身。
 * ⇒ 顺序固定为：① `appendFileSync` 真同步落盘 ② 尽力 `writeSync(2)` ③ 延时再退。
 *   只要 ① 成功，父进程就一定能从记录文件里读到原因，**哪怕管道一个字都没传过去**。
 *
 * ── 为什么启动时要写一行 armed ────────────────────────────────────────
 * 父进程靠「有没有崩溃记录」来反推「这次不是自崩溃」。但**光看有没有记录会骗人**：
 * 哪天有人从这个角色里摘掉 guard，父进程会继续得出「没记录 ⇒ 不是崩溃」这个
 * **看起来完全合理、实际是假的**结论。（本项目最贵的一类错误：不报错的错。）
 * ⇒ guard 装上的第一件事是写 `armed` 行；父进程**只在看到 armed 行时**才敢下
 *   「不是自崩溃」的判断，否则一律「无法判定」——fail-closed，缺证据不放行。
 * ⇒ 另外用 `writeFileSync` **截断**写 armed 行：这样文件里的内容必然属于本次启动，
 *   不需要按 mtime 去猜哪些行是上一轮的。
 */
import { appendFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { CRASH_ARM_MARK, CRASH_MARK, crashLogPathFor, stampLocal } from './stackCore.ts'

export interface CrashGuard {
  /** 崩溃记录文件的绝对/相对路径。 */
  file: string
  /** 本次调用真的装上了（重复安装返回 false —— 幂等，避免同一崩溃写两遍）。 */
  installed: boolean
}

export interface CrashGuardOptions {
  /** 覆盖记录文件路径（默认取 `EVOLVE_CRASH_LOG`，再默认 `data/crash-<role>.log`）。 */
  file?: string
  /** 落盘/打印之后等多久再退出。给异步管道一点时间；文件早已写好，所以这只是尽力而为。 */
  flushMs?: number
  /** 覆盖退出动作（测试注入用，避免把测试进程本身杀掉）。 */
  exit?: (code: number) => void
}

/** 已经装过 guard 的角色名。重复调用不该再挂一遍 handler。 */
const armed = new Set<string>()

export function crashLogPathOf(role: string, override?: string): string {
  return override ?? process.env.EVOLVE_CRASH_LOG ?? crashLogPathFor(role)
}

/**
 * 把任意抛出物转成可读的两段：一句话 + 栈。
 *
 * ★ 显式格式化，不用 `String(reason)` —— 那样遇到对象会念出 `[object Object]`，
 *   两个完全不同的崩溃会变成同一句遗言（本项目在语音层踩过同一个坑）。
 */
export function describeReason(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name, stack: reason.stack ?? '' }
  }
  if (typeof reason === 'string') return { message: reason, stack: '' }
  let message: string
  try {
    message = JSON.stringify(reason) ?? String(reason)
  } catch {
    message = '<无法序列化的抛出物: ' + typeof reason + '>'
  }
  return { message: message.slice(0, 500), stack: '' }
}

function appendLine(file: string, line: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line + '\n', 'utf8')
    return true
  } catch {
    // 记录写不进去不该引发第二次崩溃 —— guard 自己崩掉比没有 guard 更糟。
    return false
  }
}

export function installCrashGuard(role: string, opts: CrashGuardOptions = {}): CrashGuard {
  const file = crashLogPathOf(role, opts.file)
  if (armed.has(role)) return { file, installed: false }
  armed.add(role)

  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const flushMs = opts.flushMs ?? 150

  // 截断写：文件内容必然属于本次启动 ⇒ 父进程不需要按时间猜。
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, CRASH_ARM_MARK + ' role=' + role + ' pid=' + String(process.pid) + ' at=' + stampLocal() + '\n', 'utf8')
  } catch {
    /* 同上：写不进去也不许拦启动 */
  }

  const die = (kind: string, reason: unknown): void => {
    const d = describeReason(reason)
    appendLine(file, CRASH_MARK + ' kind=' + kind + ' role=' + role + ' pid=' + String(process.pid) + ' uptimeMs=' + String(Math.round(process.uptime() * 1000)) + ' at=' + stampLocal())
    appendLine(file, CRASH_MARK + ' message=' + d.message)
    for (const l of d.stack.split('\n')) {
      if (l.trim()) appendLine(file, CRASH_MARK + ' ' + l.trimEnd())
    }
    // 尽力同步写到 fd 2（管道可能丢，文件不会 —— 所以上面那步才是主证据）
    try {
      writeSync(2, CRASH_MARK + ' ' + role + ' ' + kind + ': ' + d.message + '\n' + d.stack + '\n')
    } catch {
      /* 尽力而为 */
    }
    setTimeout(() => exit(1), flushMs)
  }

  process.on('uncaughtException', (e) => die('uncaughtException', e))
  process.on('unhandledRejection', (r) => die('unhandledRejection', r))
  return { file, installed: true }
}
