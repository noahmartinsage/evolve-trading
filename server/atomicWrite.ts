/**
 * 原子写盘工具（内化 R20 `atomic_write_json` 范式）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 朴素的 `writeFileSync(path, data)` 是「先截断、再写入」，中间存在一个
 * **文件已被清空但新内容尚未落盘** 的窗口。这个窗口在两种现实情况下会被命中：
 *
 *   1. 进程在写入过程中被 kill（开发期热重启、CI 超时、容器 OOM）；
 *   2. 磁盘写满 / 配额耗尽，写到一半返回 ENOSPC。
 *
 * 对本项目而言，被这样写坏的若是 `.env`，后果不是「丢一次配置」而是
 * **全部风控参数回落到代码默认值**——引擎会以用户从未批准过的风险敞口运行，
 * 而面板显示的仍是上一次成功读取的值。这类「配置静默降级」比崩溃更难排查。
 *
 * ── 做法 ────────────────────────────────────────────────────────────
 * 同目录临时文件 → 写入 → fsync 落盘 → rename 覆盖。
 * POSIX 与 Windows 的 `rename` 对同目录同卷目标都是原子替换：
 * 读者要么看到完整的旧文件，要么看到完整的新文件，不存在中间态。
 *
 * fsync 不可省略：只做 rename 而不 fsync，操作系统仍可能把「rename 元数据」
 * 先于「文件内容」刷到磁盘，断电后得到一个长度为 0 的目标文件。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

/** 临时文件后缀。以 `.` 开头 + `.tmp` 结尾，便于被 git / 清理脚本识别。 */
const TMP_SUFFIX = '.tmp'

/**
 * 原子地把 `data` 写入 `path`。
 *
 * @param path      目标文件
 * @param data      文本内容
 * @param encoding  编码，默认 utf8
 * @returns         写入的字节数
 */
export function atomicWriteFile(path: string, data: string, encoding: BufferEncoding = 'utf8'): number {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })

  // 临时文件名带上 pid 与纳秒时间戳：同一进程内并发写同一路径、以及多进程共存时
  // 都不会互相踩掉对方的临时文件。R20 用 mkstemp 达到同样效果，这里用等价命名法。
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}${TMP_SUFFIX}`)

  const buf = Buffer.from(data, encoding)
  let fd: number | null = null
  try {
    // 'w' 会创建或截断；临时文件是我们独占的，截断无副作用
    fd = openSync(tmp, 'w')
    writeSync(fd, buf)
    // 先 fsync 文件内容，再关闭；顺序反了 fsync 就无效
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    // 原子替换：此刻起读者只能看到完整的新内容
    renameSync(tmp, path)
    return buf.byteLength
  } catch (e) {
    // 失败路径必须清掉临时文件，否则崩溃循环会留下一地 `.xxx.tmp`
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 关闭失败无需处理，下面统一清理 */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 清理失败不应掩盖原始错误 */
    }
    throw e
  }
}

/** 原子地写入 JSON（UTF-8，带缩进，末尾换行）。 */
export function atomicWriteJson(path: string, payload: unknown, indent = 2): number {
  return atomicWriteFile(path, `${JSON.stringify(payload, null, indent)}\n`, 'utf8')
}

/**
 * 原子地写入 NDJSON 之外的行数组（每行一条，末尾换行）。供 `.env` 这类行式文件使用。
 */
export function atomicWriteLines(path: string, lines: string[]): number {
  return atomicWriteFile(path, `${lines.join('\n')}\n`, 'utf8')
}
