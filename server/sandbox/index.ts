import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Candle } from '../../src/engine/index.ts'

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'worker.ts')
const LOCKDOWN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'network-lockdown.ts')

/**
 * 沙箱子进程的启动参数 —— **唯一出处**。
 *
 * 生产沙箱（`runInSandbox`）与验证探针（`scripts/sandbox-smoke.ts`）都从这里取，
 * 这样「测试验证的那把锁」与「生产用的那把锁」保证是同一把。
 * 曾经探针自己拼了一份 `--permission`，验证的是「某个 flag 有效」，
 * 而那个 flag 恰好不挡网络 —— 于是红灯长期存在，且指向了错误的方向。
 */
export function sandboxNodeArgs(): string[] {
  // `--import` 的值会被当作 **ESM specifier** 解析，而不是文件路径。
  // Windows 上 `process.cwd()` 风格的反斜杠绝对路径（`C:\…\x.ts`）不是合法 specifier，
  // Node 会把它当成 bare package name 去找包 → 启动即失败，
  // 表现出来是子进程早死 + 父进程写 stdin 报 `Error: write EOF`
  // （一个和真因毫无关系的错误信息）。所以这里必须转成 file:// URL。
  return ['--permission', `--allow-fs-read=${process.cwd()}`, '--import', pathToFileURL(LOCKDOWN_PATH).href]
}

export interface SandboxResult {
  ok: boolean
  reason?: string
  strategyId?: string
  fitness?: number
  fitnessVersion?: string
  report?: Record<string, number>
  fills?: number
  stderrTail?: string
}

const MAX_CODE_CHARS = 20_000
const MAX_CANDLES = 5_000

function safeEnv(): NodeJS.ProcessEnv {
  // 沙箱子进程不继承任何业务/凭证环境变量（C6 联动）
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', 'windir', 'WINDIR']
  const env: NodeJS.ProcessEnv = {}
  for (const k of keep) {
    if (process.env[k] !== undefined) env[k] = process.env[k]
  }
  env.NODE_OPTIONS = ''
  return env
}

export async function runInSandbox(code: string, candles: Candle[] | undefined, timeoutMs = 10_000): Promise<SandboxResult> {
  if (typeof code !== 'string' || code.length === 0) return { ok: false, reason: 'CODE_REQUIRED' }
  if (code.length > MAX_CODE_CHARS) return { ok: false, reason: `CODE_TOO_LARGE (${code.length} > ${MAX_CODE_CHARS})` }
  const trimmedCandles = candles && candles.length > 0 ? candles.slice(0, MAX_CANDLES) : undefined

  const child = spawn(
    process.execPath,
    [...sandboxNodeArgs(), WORKER_PATH],
    { env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
  )

  return new Promise<SandboxResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8')
      if (stdout.length > 1_000_000) child.kill('SIGKILL')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8')
    })

    const finish = (result: SandboxResult): void => {
      clearTimeout(timer)
      resolve(result)
    }

    child.on('error', (e) => finish({ ok: false, reason: `SANDBOX_SPAWN_ERROR:${e.message.slice(0, 120)}` }))

    child.on('close', () => {
      const marker = stdout.lastIndexOf('###RESULT###')
      if (killed && marker < 0) return finish({ ok: false, reason: 'SANDBOX_TIMEOUT', stderrTail: stderr.slice(-300) })
      if (marker < 0) return finish({ ok: false, reason: 'SANDBOX_NO_RESULT', stderrTail: stderr.slice(-300) })
      try {
        const payload = JSON.parse(stdout.slice(marker + '###RESULT###'.length)) as SandboxResult & { error?: string }
        if (!payload.ok) return finish({ ok: false, reason: `SANDBOX_CODE_ERROR:${payload.error ?? 'unknown'}`, stderrTail: stderr.slice(-200) })
        finish(payload)
      } catch {
        finish({ ok: false, reason: 'SANDBOX_BAD_OUTPUT', stderrTail: stderr.slice(-200) })
      }
    })

    child.stdin.write(JSON.stringify({ code, candles: trimmedCandles }))
    child.stdin.end()
  })
}
