/**
 * 进程监督烟测
 *
 * ── 这份测试要证明的五件事（缺一条"意外退出"就还是查不出来）──────────
 * ① **退出状态不带信息。** 本机 Windows 上，「自己 exit 1」「被 taskkill /T /F」
 *    「未捕获异常崩溃」在父进程侧是**逐字节相同**的 `{code:1, signal:null}`。
 *    这条不是推测，是 S-K1 当场跑出来的断言 —— 它是"为什么必须有遗言机制"的
 *    唯一依据。若哪天它不再成立（换平台/换 Node），S-K1 会先报红，
 *    我们才知道可以重新相信退出码。
 * ② **有遗言 ⇒ 判定自崩溃。** 且遗言要落进文件（管道会丢），
 *    所以断言同时查 `report.crashed` 与崩溃记录文件的内容。
 * ③ **armed 过、无遗言 ⇒ 不是自崩溃。** 这是唯一一条能定性为
 *    "被外面打死"的路径，也是上一轮那个事故真正的答案。
 * ④ **没 armed ⇒ 无法判定，且不许写原因。** 这条是防止最贵的一类错误：
 *    有人把 guard 从某个角色里摘掉之后，监督进程继续自信地宣布
 *    "没有记录 ⇒ 不是崩溃" —— 一个不报错的假结论。
 *    所以既要断言"提示是 unknown"，还要断言渲染出来的文字里
 *    **没有**"不是自崩溃"这句话。
 * ⑤ **正常收尾不许触发告警。** 否则这份报告会变成噪音，
 *    而噪音的代价是"下次真的崩了也没人看"。
 *    ★ 成对问：⑤ 单独看可能是假绿（比如 handler 根本没接上）。
 *      所以用**同一个夹具**跑两条路：自己 exit(1) → 必须触发；被收尾 → 必须不触发。
 *      两者只差"谁结束了它"。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { createStack, inferExitCause, renderExitReport, type RoleExitReport, type StackRole } from '../server/stackCore.ts'

const ROOT = process.cwd()
const FIXTURE_DIR = join(ROOT, 'data', '_stacksmoke')
const NODE = process.execPath

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function archive(): void {
  const dir = join(ROOT, 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'stack-latest.json'),
    JSON.stringify({ startedAt: startedAt, finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error('[FAIL] STACK SMOKE FAIL - ' + name + ' - ' + msg)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log('[OK] ' + name + ' - ' + detail)
}

function assertEq<T>(name: string, actual: T, expected: T, extra = ''): void {
  if (actual !== expected) {
    fail(name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + (extra ? ' · ' + extra : ''))
  }
}

function assertTrue(name: string, cond: boolean, msg: string): void {
  if (!cond) fail(name, msg)
}

const startedAt = new Date().toISOString()

// ── 夹具 ────────────────────────────────────────────────────────────────
// 写成真文件（不是 `-e`）：本机 shell 会吃掉反引号与 `$(`，多行中文更是不敢过 shell。
// 放在 `data/` 下：tsconfig 的 include 只有 src/scripts/server，这些夹具不会被 typecheck/lint 扫到。
mkdirSync(FIXTURE_DIR, { recursive: true })

writeFileSync(
  join(FIXTURE_DIR, 'steady.ts'),
  [
    "console.log('steady-up')",
    "const ms = Number(process.env.SMOKE_EXIT_AFTER_MS ?? '0')",
    'if (ms > 0) setTimeout(() => process.exit(1), ms)',
    'else setInterval(() => undefined, 1000)',
    '',
  ].join('\n'),
)

writeFileSync(
  join(FIXTURE_DIR, 'guarded-steady.ts'),
  [
    "import { installCrashGuard } from '../../server/crashGuard.ts'",
    "installCrashGuard('guarded-steady')",
    "console.log('steady-up')",
    "const ms = Number(process.env.SMOKE_EXIT_AFTER_MS ?? '0')",
    'if (ms > 0) setTimeout(() => process.exit(1), ms)',
    'else setInterval(() => undefined, 1000)',
    '',
  ].join('\n'),
)

writeFileSync(
  join(FIXTURE_DIR, 'crash.ts'),
  [
    "import { installCrashGuard } from '../../server/crashGuard.ts'",
    "installCrashGuard('crash-fixture')",
    "console.log('about-to-crash')",
    "setTimeout(() => { throw new Error('fixture boom') }, 200)",
    '',
  ].join('\n'),
)

// 声明了崩溃记录路径，却**从不装 guard** —— 模拟"有人把 guard 摘掉了"。
writeFileSync(
  join(FIXTURE_DIR, 'no-guard.ts'),
  ["console.log('steady-up')", 'setInterval(() => undefined, 1000)', ''].join('\n'),
)

// ── 工具 ────────────────────────────────────────────────────────────────

function taskkill(pid: number | undefined): void {
  if (typeof pid !== 'number') return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 可能已经退干净了 —— 这条路径上失败不该让测试挂掉 */
  }
}

/** 直接 spawn 一个短命进程，只观察父进程侧拿到的退出状态。 */
function observeExit(args: string[], killAfterMs: number | null): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const p = spawn(NODE, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout?.on('data', () => undefined)
    p.stderr?.on('data', () => undefined)
    p.on('exit', (code, signal) => resolve({ code, signal }))
    if (killAfterMs !== null) {
      setTimeout(() => taskkill(p.pid), killAfterMs)
    }
  })
}

interface RunResult {
  report: RoleExitReport | null
  logs: string[]
}

/**
 * 起一个角色并等它**意外**退出。
 *
 * `exit` 注入成空函数：`shutdown()` 会调用它，而这里绝不能把测试进程自己收掉。
 */
function runRole(name: string, fixture: string, env: NodeJS.ProcessEnv, opts: { killAfterMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const logs: string[] = []
    let report: RoleExitReport | null = null
    let done = false
    const stack = createStack({
      log: (l) => logs.push(l),
      onUnexpectedExit: (r) => {
        report = r
        if (!done) {
          done = true
          resolve({ report, logs })
        }
      },
      exit: () => undefined,
    })
    const role: StackRole = { name, command: NODE, args: [fixture], env }
    stack.start(role)
    if (typeof opts.killAfterMs === 'number') {
      setTimeout(() => taskkill(stack.pids()[0]?.pid), opts.killAfterMs)
    }
    setTimeout(() => {
      if (!done) {
        done = true
        resolve({ report, logs })
      }
    }, 8000)
  })
}

function crashLogFor(name: string): string {
  const f = join(FIXTURE_DIR, name + '.log')
  // ★ 不用 `rmSync` 清旧文件，而是**覆盖写一行 stale 标记**。
  //   本机的删除配额是按轮计数的（阈值 50，`scope:"turn"`）：配额一满，`rmSync` 就抛
  //   `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，于是"准备夹具"这一步能把整道门禁打红 ——
  //   而它守的不变量一点问题都没有。这就是本项目中"对完全正确的输入报错"的检查，
  //   比不报错的更费人（它会训练人忽略这道门的红）。
  //   覆盖写达到同样的"干净"效果，**且顺带让 S-K4 更强**：
  //   记录文件里确实**有内容**、但没有 armed 行 —— 证明判据不是"文件存不存在"。
  writeFileSync(f, 'leftover-from-a-previous-run\n', 'utf8')
  return f
}

async function main(): Promise<void> {
  // ── S-K1 退出状态不带信息 ────────────────────────────────────────────
  const selfExit = await observeExit(['-e', 'process.exit(1)'], null)
  const killed = await observeExit([join(FIXTURE_DIR, 'steady.ts')], 700)
  const crashed = await observeExit(['-e', 'throw new Error("k1 boom")'], null)
  const control = await observeExit(['-e', 'process.exit(7)'], null)

  assertTrue(
    'S-K1 control 退出码读得准',
    control.code === 7 && control.signal === null,
    '对照用例期望 exit 7，实际 ' + JSON.stringify(control),
  )
  const triple = JSON.stringify({ selfExit, killed, crashed })
  assertTrue(
    'S-K1 三种事因退出状态逐字节相同',
    selfExit.code === 1 && selfExit.signal === null &&
      killed.code === 1 && killed.signal === null &&
      crashed.code === 1 && crashed.signal === null,
    '期望三者都是 {code:1,signal:null}（本机 Windows 实测），实际 ' + triple,
  )
  pass('S-K1 退出状态不带信息', '自己 exit / taskkill 打死 / 未捕获异常 → 都是 code=1 signal=null（对照 exit 7 = ' + String(control.code) + '）')

  // ── S-K2 自崩溃：必须留下遗言，且落进文件 ─────────────────────────────
  const crashFile = crashLogFor('crash')
  const crashedRun = await runRole('crash-fixture', join(FIXTURE_DIR, 'crash.ts'), { EVOLVE_CRASH_LOG: crashFile })
  const cr = crashedRun.report
  assertTrue('S-K2 收到了意外退出报告', cr !== null, '8 秒内没有收到 onUnexpectedExit')
  if (!cr) return
  assertEq('S-K2 判定为自崩溃', inferExitCause(cr), 'self_crash')
  assertTrue('S-K2 report.crashed 为真', cr.crashed, '期望 crashed=true，实际 false · tail=' + cr.tail.join(' | '))
  assertTrue('S-K2 guard 已装上', cr.crashGuardArmed, '崩溃记录里没有 armed 行')
  assertTrue(
    'S-K2 崩溃记录文件里真的有原因',
    existsSync(crashFile) && readFileSync(crashFile, 'utf8').includes('fixture boom'),
    '文件里找不到 fixture boom：' + (existsSync(crashFile) ? readFileSync(crashFile, 'utf8').slice(0, 300) : '文件不存在'),
  )
  assertTrue('S-K2 临终输出非空', cr.lastLine.length > 0 && cr.lastLineAt !== null, 'lastLine=' + JSON.stringify(cr.lastLine))
  assertTrue('S-K2 uptime 是真实的', cr.uptimeMs > 100, 'uptimeMs=' + String(cr.uptimeMs))
  assertTrue(
    'S-K2 渲染文字给出结论',
    renderExitReport(cr).some((l) => l.includes('它自己崩了')),
    '渲染结果里没有"它自己崩了"：' + renderExitReport(cr).join(' / '),
  )
  pass('S-K2 自崩溃留下遗言', 'crashed=true · 文件含 fixture boom · uptime ' + String(cr.uptimeMs) + 'ms')

  // ── S-K3 被外部打死：armed 过、无遗言 ⇒ 不是自崩溃 ────────────────────
  const killFile = crashLogFor('killed')
  const killedRun = await runRole('guarded-steady', join(FIXTURE_DIR, 'guarded-steady.ts'), { EVOLVE_CRASH_LOG: killFile }, { killAfterMs: 900 })
  const kr = killedRun.report
  assertTrue('S-K3 收到了意外退出报告', kr !== null, '8 秒内没有收到 onUnexpectedExit')
  if (!kr) return
  assertEq('S-K3 判定为不是自崩溃', inferExitCause(kr), 'not_self_crash')
  assertTrue('S-K3 report.crashed 为假', !kr.crashed, '被 taskkill 打死的却写了崩溃记录')
  assertTrue('S-K3 guard 已装上', kr.crashGuardArmed, 'armed=false ⇒ 这条判定不可信')
  assertTrue('S-K3 临终输出记下了最后一句', kr.lastLine.includes('steady-up'), 'lastLine=' + JSON.stringify(kr.lastLine))
  assertTrue(
    'S-K3 静默期与存活时长都非空',
    kr.silentForMs !== null && kr.silentForMs > 300 && kr.uptimeMs >= kr.silentForMs,
    'silentForMs=' + String(kr.silentForMs) + ' uptimeMs=' + String(kr.uptimeMs),
  )
  // ★ 这一条是整份测试的重点：两种完全不同的事因，退出状态**一模一样**。
  assertTrue(
    'S-K3 它的退出状态与自崩溃完全相同',
    kr.code === cr.code && kr.signal === cr.signal,
    '自崩溃 ' + JSON.stringify({ code: cr.code, signal: cr.signal }) + ' vs 被打死 ' + JSON.stringify({ code: kr.code, signal: kr.signal }),
  )
  const killedText = renderExitReport(kr).join(' / ')
  assertTrue('S-K3 渲染文字指向"别翻代码"', killedText.includes('不是自崩溃'), '渲染结果：' + killedText)
  pass('S-K3 被打死 ≠ 崩溃', 'crashed=false · armed=true · 退出状态与 S-K2 逐字节相同（code=' + String(kr.code) + '）—— 只有遗言能区分')

  // ── S-K4 没 armed ⇒ 无法判定，且不许下结论 ───────────────────────────
  const noGuardFile = crashLogFor('noguard')
  const ngRun = await runRole('no-guard', join(FIXTURE_DIR, 'no-guard.ts'), { EVOLVE_CRASH_LOG: noGuardFile }, { killAfterMs: 900 })
  const ng = ngRun.report
  assertTrue('S-K4 收到了意外退出报告', ng !== null, '8 秒内没有收到 onUnexpectedExit')
  if (!ng) return
  assertTrue('S-K4 声明了崩溃记录', ng.crashLogDeclared && ng.crashLogPath === noGuardFile, 'crashLogDeclared=' + String(ng.crashLogDeclared))
  assertTrue('S-K4 guard 确实没装上', !ng.crashGuardArmed, '意外读到了 armed 行')
  assertEq('S-K4 判定为无法判定', inferExitCause(ng), 'unknown')
  const ngText = renderExitReport(ng).join(' / ')
  assertTrue('S-K4 渲染文字是"无法判定"', ngText.includes('无法判定'), '渲染结果：' + ngText)
  // ★ 防止假结论：这一路绝不能说出"不是自崩溃"。
  assertTrue(
    'S-K4 不许宣称"不是自崩溃"',
    !ngText.includes('不是自崩溃'),
    '没有遗言机制却下了结论（这正是最贵的一类错误）：' + ngText,
  )
  pass('S-K4 缺证据不放行', 'guard 未装上 → unknown，且文字里不含"不是自崩溃"（fail-closed）')

  // ── S-K5 成对：自己退出要报，正常收尾不许报 ──────────────────────────
  const pairFile = crashLogFor('pair')
  const selfRun = await runRole(
    'guarded-steady',
    join(FIXTURE_DIR, 'guarded-steady.ts'),
    { EVOLVE_CRASH_LOG: pairFile, SMOKE_EXIT_AFTER_MS: '300' },
  )
  assertTrue('S-K5 自己退出必须触发告警', selfRun.report !== null, '同一夹具自己 exit(1) 却没触发 onUnexpectedExit')
  if (!selfRun.report) return
  assertEq('S-K5 自己退出也不叫崩溃', inferExitCause(selfRun.report), 'not_self_crash')

  const logs: string[] = []
  const notified = { hit: false }
  const calm = createStack({
    log: (l) => logs.push(l),
    onUnexpectedExit: () => {
      notified.hit = true
    },
    exit: () => undefined,
  })
  calm.start({ name: 'guarded-steady', command: NODE, args: [join(FIXTURE_DIR, 'guarded-steady.ts')], env: { EVOLVE_CRASH_LOG: crashLogFor('calm') } })
  await new Promise((r) => setTimeout(r, 600))
  assertTrue('S-K5 正常收尾前角色是活的', calm.alive('guarded-steady'), '夹具没起来：' + logs.join(' | '))
  calm.shutdown(0)
  await new Promise((r) => setTimeout(r, 900))
  assertTrue('S-K5 正常收尾不许触发告警', !notified.hit, 'shutdown 也触发了 onUnexpectedExit ⇒ 这份报告会变成噪音')
  pass('S-K5 收尾不告警', '同一夹具：自己 exit(1) → 告警；被 shutdown → 不告警')

  // ── S-K6 时间戳带本地偏移 ────────────────────────────────────────────
  const stamp = selfRun.report.startedAt
  assertTrue(
    'S-K6 时间戳是本地时间且带偏移',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(stamp),
    '期望形如 2026-09-17 11:50:27 +08:00，实际 ' + JSON.stringify(stamp),
  )
  const off = new Date().getTimezoneOffset()
  const wantSign = off <= 0 ? '+' : '-'
  assertTrue('S-K6 偏移符号与机器时区一致', stamp.includes(wantSign + String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')), 'offset=' + String(off) + '，stamp=' + stamp)
  pass('S-K6 时间戳可对表', stamp + '（本机 UTC 偏移 ' + String(off) + ' 分钟）')

  archive()
  appendFileSync(join(ROOT, 'artifacts', 'stack-latest.json'), '\n', 'utf8')
  console.log('')
  console.log('[OK] STACK SMOKE PASS - ' + String(scenarios.length) + ' 组')
}

main().catch((e) => {
  fail('uncaught', e instanceof Error ? e.message : String(e))
})
