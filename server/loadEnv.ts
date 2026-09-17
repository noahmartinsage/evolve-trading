import { readFileSync, existsSync } from 'node:fs'
import { atomicWriteFile } from './atomicWrite.ts'

/** 最小 .env 加载器：仅用于本地开发，避免将密钥写进进程命令行 / 日志。生产应走机密管理。 */
export function loadDotEnv(path = '.env'): void {
  try {
    const txt = readFileSync(path, 'utf8')
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      const key = m[1]
      const val = m[2].replace(/^["']|["']$/g, '')
      if (process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    /* 无 .env 文件则跳过 */
  }
}

/**
 * 更新 .env 中的若干键（存在则就地替换，不存在则追加）。
 *
 * 为什么风控参数要落盘到 .env 而不是只留在内存：
 *   执行层（autopilot / positionGuard）在 import 常量模块时读的是 **进程环境变量**，
 *   只改内存里的 OrchState.risk 会让「管理页显示的值」与「引擎实际生效的值」两套口径。
 *   落盘 + 同步 process.env 才能保证下一次巡检周期读到的就是面板上看到的那一个。
 *
 * 注意：只写非密钥类参数。密钥绝不经过此函数。
 *
 * 落盘必须是**原子替换**（见 atomicWrite.ts）：这个文件一旦被写坏，全部风控参数
 * 会静默回落到代码默认值，引擎将以用户没批准过的敞口运行，而面板仍显示旧值。
 */
export function updateDotEnv(entries: Record<string, string>, path = '.env'): void {
  const lines: string[] = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const remaining = new Map(Object.entries(entries))

  // split('\n') 在文件以换行结尾时会留下一个空尾元素。若原样保留，
  // 下面的「补空行」逻辑再 push 一次，重建出来的文件就会多出一个空行。
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i])
    if (!m) continue
    if (remaining.has(m[1])) {
      lines[i] = `${m[1]}=${remaining.get(m[1])}`
      remaining.delete(m[1])
    }
  }

  if (remaining.size > 0 && lines.length > 0) lines.push('')
  for (const [k, v] of remaining) lines.push(`${k}=${v}`)

  atomicWriteFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '')

  // 同步到当前进程环境：常量模块虽然已解析，但运行时读取处（如 currentRiskValues）会用到
  for (const [k, v] of Object.entries(entries)) process.env[k] = v
}
