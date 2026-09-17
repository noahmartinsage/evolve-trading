/**
 * EVOLVE 一键停止（`STOP-EVOLVE.cmd` 的唯一调用目标）
 *
 * ── 为什么不能只靠"关窗口" ────────────────────────────────────────────
 * 桌宠是无边框托盘窗口，点右上角的"关闭"在托盘可用时是**收进托盘**（不是退出）。
 * 而 `START-EVOLVE.cmd` 那个控制台窗口又很容易被当成"日志窗口"直接关掉 ——
 * 关掉它等于杀掉监管进程，三个子进程（node ×2 + vite）会留成孤儿：
 * 端口一直占着，下次双击启动就直接失败。所以必须有一个**显式收尾**入口。
 *
 * ── 为什么杀完还要再看一眼 ────────────────────────────────────────────
 * 本项目实测过：`Remove-Item` 报"删 0 个/失败 41 个"，而重新列目录时 41 个
 * 全都不在了。**处置动作的返回码不是结果，重新观测一次才是。**
 * 所以这里 kill 之后逐个复查存活，报告的是复查结论而不是 taskkill 的退出码。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PID_FILE = join(ROOT, 'data', 'app-stack.json')

interface PidFile {
  startedAt?: string
  live?: boolean
  roles?: Array<{ name: string; pid: number }>
  petPid?: number | null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 这个 pid 现在是不是我们的 node / electron。
 *
 * ★ 存在的理由只有一条：**pid 会被复用**。一个上次留下的记录文件，
 *   几天后再点"停止"，那个 pid 可能已经属于完全不相干的进程 ——
 *   而 `taskkill /T /F` 会连它的子进程一起带走。
 *   宁可少杀一个，也不要误杀一个。
 */
function looksOurs(pid: number): 'yes' | 'no' | 'unknown' {
  try {
    const out = execFileSync('tasklist', ['/FI', 'PID eq ' + String(pid), '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (/node\.exe/i.test(out) || /electron\.exe/i.test(out)) return 'yes'
    return 'no'
  } catch {
    return 'unknown'
  }
}

function killTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {
    /* 已经退干净了；真正的结论看后面的复查 */
  }
}

if (!existsSync(PID_FILE)) {
  console.log('没有记录在案的启动（data/app-stack.json 不存在）。')
  console.log('若栈是 `npm run stack` 起的，它没有写 PID 文件 —— 请在它的窗口里按 Ctrl+C。')
  process.exit(0)
}

let rec: PidFile
try {
  rec = JSON.parse(readFileSync(PID_FILE, 'utf8')) as PidFile
} catch (e) {
  console.log('PID 文件读不出来（' + (e instanceof Error ? e.message : String(e)) + '），按"没有记录"处理。')
  unlinkSync(PID_FILE)
  process.exit(0)
}

const targets: Array<{ name: string; pid: number }> = [
  ...(rec.roles ?? []).map((r) => ({ name: r.name, pid: Number(r.pid) })),
  ...(typeof rec.petPid === 'number' ? [{ name: 'pet', pid: rec.petPid }] : []),
].filter((t) => Number.isFinite(t.pid) && t.pid > 0)

console.log('记录来自 ' + (rec.startedAt ?? '未知时间') + '，共 ' + targets.length + ' 个进程。')

const skipped: string[] = []
for (const t of targets) {
  if (!alive(t.pid)) {
    console.log('· ' + t.name + ' (pid ' + t.pid + ') 已经不在')
    continue
  }
  const ours = looksOurs(t.pid)
  if (ours === 'no') {
    skipped.push(t.name + ' (pid ' + t.pid + ')')
    console.log('· ' + t.name + ' (pid ' + t.pid + ') 已被别的进程复用 —— 跳过（不误杀）')
    continue
  }
  if (ours === 'unknown') {
    console.log('· ' + t.name + ' (pid ' + t.pid + ') 无法核对进程名，仍然按记录停止')
  }
  killTree(t.pid)
}

if (skipped.length > 0) console.log('跳过的：' + skipped.join('、') + '（它们会继续占端口）')

// ★ 复查：报告的是"现在还剩谁"，不是"taskkill 说了什么"
const remaining = targets.filter((t) => alive(t.pid))
if (remaining.length === 0) {
  console.log('✓ 已全部停止。')
  unlinkSync(PID_FILE)
  process.exit(0)
}
console.log('✗ 仍有 ' + remaining.length + ' 个进程存活：' + remaining.map((t) => t.name + '/' + t.pid).join('、'))
console.log('  再点一次「停止」；若还不行，用任务管理器按端口找（8790 / 8791 / 4173）。')
process.exit(1)
