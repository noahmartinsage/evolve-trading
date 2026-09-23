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
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import {
  createStack,
  inferExitCause,
  renderExitReport,
  renderRuntimeSummary,
  resolveLoopbackService,
  stackRoles,
  type RoleExitReport,
  type StackRole,
} from '../server/stackCore.ts'
import { HEALTH_ROLE_FIELD, SERVICE_ROLE_NAMES } from '../server/serviceIdentity.ts'

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

// ── S-I 的夹具：**真的**在两条回环地址上起两个服务 ──────────────────────
//
// ★ 为什么不用 mock：要证的正是"同一个端口号可以被两条回环路上的两个进程分别绑住"
//   这个**平台事实**。mock 掉它，测的就是另一种情况了。

function listenOn(host: string, port: number, body: unknown): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture')
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Not Found' }))
    })
    s.once('error', reject)
    s.listen(port, host, () => resolve(s))
  })
}

function closeServer(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()))
}

async function canBind(host: string, port: number): Promise<boolean> {
  try {
    await closeServer(await listenOn(host, port, {}))
    return true
  } catch {
    return false
  }
}

/**
 * 找一个「能同时在 `127.0.0.1` 与 `::1` 上绑定」的端口号。
 *
 * ★ 找不到就**抛**，不要退化成"跳过这一组"。跳过的检查与不存在没有区别，
 *   而它的绿会让上面那些断言看起来像验过了。
 */
async function pickDualLoopbackPort(): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const port = 18000 + Math.floor(Math.random() * 20000)
    if ((await canBind('::1', port)) && (await canBind('127.0.0.1', port))) return port
  }
  throw new Error('本机找不到能同时绑定 127.0.0.1 与 ::1 的端口 —— 造不出"同一端口两个服务"的夹具')
}

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
  // ⚠️ 这里**不许**写"静默期要 > 300ms"这类阈值。原先就是那么写的，它是一条
  //   随机地雷：本用例的 kill 走 `execFileSync('taskkill')`，**同步**调用会把
  //   父进程的事件循环整个挡住，子进程那行 'steady-up' 的 data 事件要等
  //   taskkill 返回后才被处理 —— 处理时刻与观测到退出的时刻落在同一毫秒，
  //   静默期就是 0。实测抓到过：silentForMs=0 uptimeMs=2284。
  //   0 在这里是**真实观测**（父进程确实没观察到那段空隙），不是缺陷；
  //   而"静默期真的被量出来了"改由 S-K5 用**自己退出**的夹具去证 ——
  //   那条路上没人堵事件循环，间隔是确定的。
  assertTrue(
    'S-K3 静默期与存活时长都非空',
    kr.silentForMs !== null && kr.silentForMs >= 0 && kr.silentForMs <= kr.uptimeMs && kr.uptimeMs > 100,
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
  // ★ "静默期是量出来的"只能在这一条路上断言：夹具自己 exit(1)，
  //   没有任何同步调用堵住父进程的事件循环，且间隔由夹具自己决定
  //   （SMOKE_EXIT_AFTER_MS=300）。S-K3 那条路做不到（见那里的注释）。
  //   下限取 200 而不是 300：300 是从 console.log 之后开始算的，而时间戳只到
  //   毫秒级、node 启动本身也有抖动 ⇒ 拿 300 当线就成了"预算与正常耗时同量级"
  //   的假警报。上限 3000 抓的是"根本没算"（恒 0）或"算成了别的量纲"（uptime）。
  const s5 = selfRun.report.silentForMs
  assertTrue(
    'S-K5 静默期是量出来的（非 0、非 uptime）',
    s5 !== null && s5 >= 200 && s5 <= 3000 && s5 < selfRun.report.uptimeMs,
    'silentForMs=' + String(s5) + ' uptimeMs=' + String(selfRun.report.uptimeMs),
  )

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

  // ── S-A 启动器的「运行态」摘要 ───────────────────────────────────────
  //
  // 这四组断言要证明的是**同一件事**：那一行字是**读回来的**，不是念常量。
  // 失败模式很具体：把"自治循环已常开""账号池已就绪"写成固定文案之后，
  // 额度爆掉 / 循环被关掉 / 账号一个都没配的时候，启动器**照样一片绿**。
  //
  // ★ 全部用固定时刻算期望值，不依赖机器时区：
  //   `new Date('2026-09-19T14:47:00')` 不带 Z ⇒ 按**本地**时间解析，
  //   所以"本地几点"这件事在任何时区下都等于字面值。
  const NOW = new Date('2026-09-19T14:47:00').getTime()
  const HOUR_MS = 3_600_000
  const newsAt = NOW + 2 * HOUR_MS // 本地 16:47
  const lateAt = newsAt + 5 * HOUR_MS // 本地 21:47

  // S-A1 三项全读不到 ⇒ 必须说"读不到"，且**不许**被渲染成"正常/0"
  {
    const lines = renderRuntimeSummary({ fleet: null, autonomy: null, news: null, errors: { fleet: 'HTTP 401', autonomy: 'HTTP 401', news: 'HTTP 401' } }, NOW)
    const text = lines.join('\n')
    assertEq('S-A1 三行一行不少', lines.length, 3)
    for (const what of ['自治循环', '模型账号池', '新闻雷达']) {
      assertTrue('S-A1 ' + what + ' 读不到要说读不到', text.includes(what) && text.includes('读不到'), text)
    }
    // 判据 2/3：这两句只可能出现在"真读到了"的分支里 —— 读不到时出现它们，
    // 就等于把"没读上"伪装成了"一切正常"。
    assertTrue('S-A1 读不到不许冒充运行中', !text.includes('运行中'), text) // 原因文本来自本夹具的 HTTP 401，不会含「运行中」；换夹具时请复查这一行
    assertTrue('S-A1 读不到不许冒充有账号', !text.includes('个账号，'), text) // negation-ok: 同上：原因文本由本夹具给定
    // 读不到必须带上原因，否则用户没法查（"未知原因"是兜底，不是不该出现）。
    assertTrue('S-A1 读不到要带原因', text.includes('HTTP 401'), text)
    pass('S-A1 读不到就说读不到', '3 行全部显式标注 + 带原因，且没有冒充"运行中/有账号"')
  }

  // S-A2 真读到了 ⇒ 印刷程时刻与账号条数；且**不许**再出现"读不到"
  {
    const lines = renderRuntimeSummary(
      {
        fleet: { pool: { total: 3, ready: 2, allExhausted: false, nextRecoveryAt: null, accounts: [{ name: '主账号' }, { name: '备用一号' }, { name: '备用二号' }] } },
        autonomy: {
          status: {
            running: true,
            startCount: 1,
            jobs: [
              // ★ 顺序有意为之：**不是最近的那一项排在最前面**。
              //   若实现偷懒取 `jobs[0]`，它就会印出 21:47 —— 下面两条断言会同时报红。
              { id: 'status', label: '系统巡检', nextAt: lateAt, skippedCount: 0, runCount: 1 },
              { id: 'news_watch', label: '新闻雷达', nextAt: newsAt, skippedCount: 4, runCount: 0 },
            ],
          },
        },
        // ★ 这里必须把**这一轮新加的字段也补全**。少写 `pendingSpeech` 的话，
        //   下面那条"读到了就不许再说读不到"会因为**夹具不完整**而报红 ——
        //   那是夹具过时，不是实现错了。夹具缺字段与接口缺字段是两件事，
        //   而它们在这里长得一模一样，所以只能靠补齐夹具来区分。
        news: {
          latest: [{ title: 'x' }],
          threshold: 8,
          pending: 1,
          pendingSpeech: '1 条提案等你点（一共 1 条，已确认 0 条）',
          trending: { at: NOW, ticks: [{ ticker: 'ETH', weighted: 22, mentions: 3 }] },
          universe: { symbols: ['ETHUSDT'], note: '取自某一轮' },
        },
        errors: {},
      },
      NOW,
    )
    const text = lines.join('\n')
    assertTrue('S-A2 在跑要说明在跑', text.includes('运行中'), text)
    assertTrue('S-A2 不许只说"在跑"不给下次时刻', text.includes('16:47'), text)
    assertTrue('S-A2 最近一项要按时刻挑而不是按顺序挑', !text.includes('21:47'), text)
    assertTrue('S-A2 账号要给出条数', text.includes('3 个账号') && text.includes('2 个今天还能用'), text)
    // 「我新加的那把 key 认到没有」只有这一句能回答。没有它，池子安静时
    // 用户看到的"2 个账号"无法核对到具体是谁（判据 10：谁在读这个输出）。
    assertTrue('S-A2 账号要能核到具体是谁', text.includes('主账号') && text.includes('备用二号'), text)
    assertTrue('S-A2 因额度跳过要单独记一列', text.includes('跳过 4 次'), text)
    // ★ 改成 miss() 独有的标记：这句话只有「读不到」那一支会印。
    //   用裸词「读不到」会误伤 —— 新闻行在自治循环没跑时本来就会说「下次时刻读不到」。
    assertTrue('S-A2 读到了就不许再说读不到', !text.includes('这不等于'), text)
    pass('S-A2 真读到了就印真值', '运行中 · 最近一项 16:47（按时刻挑，不是按数组顺序）· 3 个账号 2 个可用 · 跳过 4 次')
  }

  // S-A3 池子全爆 ⇒ 要给出"什么时候恢复"，且不许把爆掉的账号说成可用
  {
    const rec = NOW + 9 * HOUR_MS // 本地 23:47
    const lines = renderRuntimeSummary({ fleet: { pool: { total: 4, ready: 0, allExhausted: true, speech: '池子里 4 个账号的免费额度今天都用完了。', nextRecoveryAt: rec } }, autonomy: null, news: null, errors: {} }, NOW)
    const poolLine = lines.find((l) => l.includes('模型账号池')) ?? ''
    assertTrue('S-A3 全爆要说全用完了', poolLine.includes('今天全用完了'), poolLine)
    assertTrue('S-A3 全爆要给恢复时刻', poolLine.includes('23:47'), poolLine)
    // 有确切恢复时刻时**不许**退化成"明天" —— 那是取不到时刻时的兜底话术，
    // 两者混用会让用户以为系统只知道"大概明天"。
    assertTrue('S-A3 有确切时刻就不能说"明天"', !poolLine.includes('明天'), poolLine) // inWords() 只输出「X 小时 Y 分后」，产不出「明天」；若改成相对时间就要复查这一行
    assertTrue('S-A3 爆掉的账号不许说成可用', !poolLine.includes('今天还能用'), poolLine) // 「今天还能用」只属于「还有可用账号」那一支，爆掉那一支写的是「今天全用完了」
    // 没拿到明细时**不许**印一对空括号 —— 那是"我打印了名单"的假象，
    // 而括号里什么都没有，用户无从判断是"没读到"还是"真的一个都没有"。
    assertTrue('S-A3 没有名单就别印空括号', !poolLine.includes('（）'), poolLine)
    pass('S-A3 额度爆掉给出恢复时刻', poolLine.trim())
  }

  // S-A4 新闻行的"下次"必须来自 news_watch 那一项
  {
    const lines = renderRuntimeSummary(
      {
        fleet: null,
        autonomy: {
          status: {
            running: true,
            startCount: 1,
            jobs: [
              { id: 'propose', label: '提案', nextAt: lateAt, skippedCount: 0, runCount: 0 },
              { id: 'news_watch', label: '新闻雷达', nextAt: newsAt, skippedCount: 0, runCount: 0 },
            ],
          },
        },
        news: { latest: [{ title: '旧的这条' }, { title: '最新这条' }], threshold: 8 },
        errors: {},
      },
      NOW,
    )
    const newsLine = lines.find((l) => l.startsWith('· 新闻雷达')) ?? ''
    assertTrue('S-A4 新闻行要给出下次时刻', newsLine.includes('16:47'), newsLine)
    assertTrue('S-A4 来源要写出来（读到几条）', newsLine.includes('2 条'), newsLine)
    // ★ 专属输入：「最新的一条」在 `latestDigest()` 的返回里是**最后一项**。
    //   取 `[0]` 的实现在下面两条里同时报红（印了旧的、没印新的），
    //   而它印出来的东西看着完全正常（有标题、只是过时）。
    assertTrue('S-A4 要印最新那条（末尾才是最新）', newsLine.includes('最新这条') && !newsLine.includes('旧的这条'), newsLine)
    // ★ 专属输入：别的任务的 21:47 **一次都不许出现** —— 出现即说明这一行
    //   取的是"手上第一个排程"而不是新闻那一项。
    assertTrue('S-A4 不许借用别的任务的排程', !lines.join('\n').includes('21:47'), lines.join('\n'))
    pass('S-A4 新闻行认的是 news_watch', newsLine.trim())
  }

  // S-A5 新闻条目缺标题时不许印一对空引号；一条都没有时要真的说出 0
  {
    const lineWith = (n: { title?: string }[]) =>
      renderRuntimeSummary({ fleet: null, autonomy: null, news: { latest: n, threshold: 8 }, errors: {} }, NOW).find(
        (l) => l.startsWith('· 新闻雷达'),
      ) ?? ''
    const noTitle = lineWith([{}])
    assertTrue('S-A5 没标题就别印空引号', !noTitle.includes('「」'), noTitle)
    assertTrue('S-A5 有 1 条就说 1 条', noTitle.includes('1 条'), noTitle)
    // 0 条必须被**说出来**，不能靠"没有标题可印"来暗示（判据 24：
    // 沉默说得清的事，会被别的文案顶替 —— 那时用户分不清"没读到"与"读到了但没有"）。
    const none = lineWith([])
    assertTrue('S-A5 一条都没有也要说 0 条', none.includes('0 条'), none)
    pass('S-A5 缺标题不造假', noTitle.trim() + ' ｜ ' + none.trim())
  }

  // S-A6 内化提案的待办数必须**原样引用服务端那句话**
  {
    const speech = '3 条提案等你点（一共 5 条，已确认 1 条）'
    const lines = renderRuntimeSummary(
      {
        fleet: null,
        autonomy: null,
        news: {
          latest: [],
          threshold: 8,
          pending: 3,
          pendingSpeech: speech,
          trending: { at: NOW, ticks: [{ ticker: 'ETH', weighted: 30, mentions: 4 }] },
          universe: { symbols: ['ETHUSDT'], note: '取自某一轮' },
        },
        errors: {},
      },
      NOW,
    )
    const propLine = lines.find((l) => l.startsWith('· 内化提案')) ?? ''
    // ★ 专属输入：整句话必须**逐字**出现。启动器另写一套判断的实现会印出
    //   "待办 3 条"之类**看着也对**的文字 —— 然后它和服务端的面板就会各说各话。
    assertTrue('S-A6 待办那句要原样引用服务端', propLine.includes(speech), propLine)
    pass('S-A6 提案待办有人读', propLine.trim())
  }

  // S-A7 品种热度的三种状态必须分开画
  {
    type TrendInput = { at?: number; ticks?: { ticker: string; weighted: number; mentions: number }[] } | null
    const lineFor = (trending: TrendInput, universe?: { symbols?: string[]; note?: string }) =>
      renderRuntimeSummary(
        { fleet: null, autonomy: null, news: { latest: [], threshold: 8, pendingSpeech: 'x', trending, universe }, errors: {} },
        NOW,
      ).find((l) => l.startsWith('· 品种热度')) ?? ''

    const missing = lineFor(null)
    const empty = lineFor({ at: NOW, ticks: [] })
    const filled = lineFor({ at: NOW, ticks: [{ ticker: 'ETH', weighted: 30, mentions: 4 }] }, { symbols: ['ETHUSDT'] })

    assertTrue('S-A7 读不到要说读不到', missing.includes('读不到'), missing)
    assertTrue('S-A7 空榜要说空榜（不是读不到）', empty.includes('空榜') && !empty.includes('这不等于'), empty)
    assertTrue('S-A7 有榜要印品种与候选', filled.includes('ETH') && filled.includes('ETHUSDT'), filled)
    // ★ 三条必须**两两不同** —— 任何一种"合并画法"都会让其中两条撞在一起。
    assertTrue('S-A7 三种状态不许长一样', new Set([missing, empty, filled]).size === 3, [missing, empty, filled].join(' ｜ '))
    pass('S-A7 品种热度三态分明', filled.trim())
  }

  // S-A8 读不到的那几项要各自点名（原因不同 ⇒ 下一步不同）
  {
    const lines = renderRuntimeSummary(
      {
        fleet: null,
        autonomy: null,
        news: { latest: [], threshold: 8, trending: null },
        errors: { 'news.pending': 'HTTP 500', 'news.trending': '文件读不懂' },
      },
      NOW,
    )
    const text = lines.join('\n')
    // ★ 专属输入：两个不同的错因。合并成一个键的实现只能印出一个原因，
    //   于是其中一项的"下一步"就永远查不到。
    assertTrue('S-A8 两个错因都要印出来', text.includes('HTTP 500') && text.includes('文件读不懂'), text)
    // ★ 光"两个错因都在"还不够：它们必须各自挂在**自己那一项**的句子上。
    //   把两个原因拼进同一行（"内化提案／品种热度 读不到（HTTP 500；文件读不懂）"）
    //   同样能过上面那条，但用户看不出哪个原因属于哪一项 —— 那就等于没点名。
    const mine = lines.find((l) => l.includes('内化提案')) ?? ''
    const trend = lines.find((l) => l.includes('品种热度')) ?? ''
    assertTrue('S-A8 错因要挂在对应那一项上', mine.includes('HTTP 500') && trend.includes('文件读不懂'), text)
    pass('S-A8 读不到各自点名', '两项错因各挂在各自那一项上')
  }

  // ══════════════ S-I：端口上「能连上」不等于「是我们」 ══════════════
  //
  // 本机真实事故（2026-09-21）：隔壁工作区的 Python `dash_server.py` 占着
  // `127.0.0.1:8790`，我们的编排层占着 `[::1]:8790` —— **同一个端口号，两个服务**。
  // 启动器用「HTTP 有没有响应」当健康判据 ⇒ 认错人、报"就绪"；
  // 运行时自检读 `/fleet/autonomy` 拿到别人的 404 ⇒ 印出三行
  // 「⚠ 读不到 —— 这不等于「没有」」，而**真正该做的动作是去查谁占了端口**。
  //
  // ★ 这一组不用 mock：**真的起两个服务**，一个在 `[::1]`、一个在 `127.0.0.1`，
  //   端口号相同。造不出这个形状的平台上它会红 —— 那是它该有的行为
  //   （因为"这条检查能不能成立"本身就是结论的一部分）。
  {
    // ① 自报身份的角色名单，必须与"真的会被拉起来的角色"逐字一致。
    //   对不上时等待会一直超时，而表现是"启动失败"（看着像服务挂了，其实是名字不同）。
    const spawned = stackRoles({ web: 'preview' }).map((r) => r.name)
    assertEq(
      'S-I1 自报身份的角色 = 被拉起的服务角色',
      [...SERVICE_ROLE_NAMES].sort().join(','),
      spawned.filter((n) => n !== 'web').sort().join(','),
      '多一个 = 有人永远等不到；少一个 = 那个角色只能靠"有人应答"判，也就是会认错人',
    )

    // ② 两个服务都要**真的把那一格写出来**（不是文档里说写了）。
    //   ★ 用剥过注释的源码：注释里提到字段名会让这条假绿（判据 32）。
    const stripComments = (t: string): string =>
      t
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
    for (const f of ['server/index.ts', 'server/ledgerServer.ts']) {
      const src = stripComments(readFileSync(join(ROOT, f), 'utf8'))
      assertTrue(
        'S-I2 ' + f + ' 自报身份',
        src.includes('[HEALTH_ROLE_FIELD]') && src.includes('serviceIdentity.ts'),
        '这个服务没有回答「你是谁」，于是只能靠"有人应答"判 ⇒ 端口上有别人时会认错人',
      )
    }

    // ③ 启动器必须**先认身份再采信**：两个服务角色走认身份的那条路。
    const appSrc = stripComments(readFileSync(join(ROOT, 'scripts', 'app.ts'), 'utf8'))
    assertTrue('S-I3 启动器对服务角色是认身份的', /waitForLoopbackService\(/.test(appSrc), '没有这一步就还是"有人应答就算就绪"')
    assertTrue(
      'S-I4 写死地址的那条老路已经不在',
      !/health\[role\.name\]/.test(appSrc),
      '旧的 `health[role.name]`（三个角色共用一张写死 127.0.0.1 的表）还在 ⇒ 认错人的问题原样保留',
    )

    // ④ **用真服务造出"同一端口两个服务"这个形状**，再看它认的是谁。
    const port = await pickDualLoopbackPort()
    const ourBody = { ok: true, [HEALTH_ROLE_FIELD]: 'orch' }
    const dashBody = { ok: true, service: 'dash', html: 'swarm-trading-console.html' }
    const a = await listenOn('::1', port, ourBody)
    const b = await listenOn('127.0.0.1', port, dashBody)
    try {
      const res = await resolveLoopbackService(port, '/healthz', 'orch')
      assertEq('S-I5 认出的是我们自己那一条', res.base, 'http://[::1]:' + String(port), JSON.stringify(res.tries))
      // ★ 「两条都看了」单独一条：找到就 return 的实现只会留下 1 条，
      //   于是"另一条路上坐着别人"这条隐患**永远不会被报出来**。
      assertEq('S-I6 两条回环地址都看过', res.tries.length, 2, JSON.stringify(res.tries))
      assertTrue(
        'S-I7 别人那个被点名，且与"没人应答"分得开',
        res.tries.some((t) => !t.ours && t.answered && t.verdict.includes('不是我们')),
        JSON.stringify(res.tries),
      )
    } finally {
      await closeServer(a)
      await closeServer(b)
    }

    // ⑤ 反向：把"我们的"换到 127.0.0.1，base 必须跟着换。
    //   不换 ⇒ ④ 可能是碰巧绿的（比如实现里写死了 [::1]）。
    const port2 = await pickDualLoopbackPort()
    const c = await listenOn('127.0.0.1', port2, ourBody)
    const d = await listenOn('::1', port2, dashBody)
    try {
      const res = await resolveLoopbackService(port2, '/healthz', 'orch', 2000)
      assertEq('S-I8 我们换到另一条路上时也认得出来', res.base, 'http://127.0.0.1:' + String(port2), JSON.stringify(res.tries))
    } finally {
      await closeServer(c)
      await closeServer(d)
    }

    // ⑥ 端口上只有陌生人（连"我们"都不在）时，**不许**把 base 报成有的东西 ——
    //   否则上层会拿一个陌生地址去读它自己的数据。
    const port3 = await pickDualLoopbackPort()
    const e = await listenOn('127.0.0.1', port3, dashBody)
    try {
      const res = await resolveLoopbackService(port3, '/healthz', 'orch', 1500)
      assertEq('S-I9 只有陌生人时不许认下一个 base', res.base, null, JSON.stringify(res.tries))
      assertTrue(
        'S-I10 陌生人那条说清了"有人但不是我们"',
        res.tries.some((t) => t.answered && !t.ours && t.verdict.includes('不是我们')),
        JSON.stringify(res.tries),
      )
    } finally {
      await closeServer(e)
    }

    pass('S-I 认身份再做判据', '同一端口两条路、两个服务 —— 认对的那个，另一个被点名')
  }

  archive()
  appendFileSync(join(ROOT, 'artifacts', 'stack-latest.json'), '\n', 'utf8')
  console.log('')
  console.log('[OK] STACK SMOKE PASS - ' + String(scenarios.length) + ' 组')
}

main().catch((e) => {
  fail('uncaught', e instanceof Error ? e.message : String(e))
})
