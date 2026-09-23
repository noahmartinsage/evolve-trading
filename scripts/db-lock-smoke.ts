/**
 * 门禁：SQLite `database is locked` 不许打死任何角色，也不许静默丢事件。
 *
 * ── 这道门保护的是一条**真发生过**的崩溃链（2026-09-23，`data/app-stack.log` 6657–6671 行）
 *   ① **初始化顺序**：`persistence.ts` 里 `busy_timeout` 必须在 `journal_mode` **之前**。
 *      原顺序反了 ⇒ "唯一会争锁的那条语句"恰好没有超时保护。栈回溯精确指向它：
 *        at initPersistence (server/persistence.ts:23:6)
 *        at initLedger (server/ledger.ts:28:3)
 *      进程存活 **0.6 秒**即死。
 *   ② **围栏是 TOCTOU**：`claimInstance()` 原本"先 SELECT 再 INSERT"，中间没有任何事务。
 *      两个同时启动的进程会双双读到空行、双双写入、双双 `{ok:true}` ——
 *      也就是说这道围栏对「同时启动」这个**唯一需要它的场景**恰好无效。
 *   ③ **ledger 一侧压根不占围栏**：`claimInstance()` 只被 orch 调用，而 orch 写的是
 *      `data/orch.db`；ledger 写的是 `data/ledger.db`（见 `stackCore.ts:502`）。
 *      ⇒ 那个库没有任何单写者保护，两个 ledger 可以同时写它。
 *
 * ── 为什么不能只 grep 源码（判据 B2）─────────────────────────────────────────
 *   「`withDbLockRetry(` 出现过」不等于「它起作用了」：把 `return` 插到它前面、
 *   或把它挪进 `if (false)`，grep 一样绿。所以下面每一处机制都跑**真事因**、
 *   断**可观测后果**；只有 A/E1 两处纯结构断言，且它们各自配了运行时配对。
 *
 * ── 三种 `database is locked` 的**处置相反**（判据 C5）───────────────────────
 *   单写者争用        ⇒ 等一会儿就好（`busy_timeout` 生效，实测等满 3358ms/3000ms）
 *   死锁 / 读快照过期 ⇒ `busy_timeout` **完全无效**（实测 **0ms** 立刻抛，不走 busy handler）
 *   把这两类混成"重试就好"会得到一个永远重试不成功的循环；
 *   混成"报错就好"则把一次可恢复的忙等升级成一次进程崩溃。
 *   ★ B 区就是在**钉住这个前提**：哪天 Node 改了行为（这两类也开始等了），
 *     `withDbLockRetry` 的理由就消失了，这道门必须红着提醒重审（判据 A2）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_TAG = `${process.pid}-${Date.now()}`
const TMP = mkdtempSync(join(tmpdir(), 'evolve-dblock-'))
const SELF = fileURLToPath(import.meta.url)

// ═══════════════════════════════════════════════════════════════════
// 断言助手（与既有烟测同形）
// ═══════════════════════════════════════════════════════════════════

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
let groupName = '(未分组)'

function group(name: string): void {
  groupName = name
  console.log(`\n── ${groupName} ──`)
}
function ok(name: string, detail: string): void {
  checks.push({ name, pass: true, detail })
  console.log(`  ✅ ${name} · ${detail}`)
}
function bad(name: string, detail: string): void {
  checks.push({ name, pass: false, detail })
  console.log(`  ❌ ${name} · ${detail}`)
}
/** 三态断言：`cond === null` 记"未验证"（并要说出**被什么造成的**，判据 C5）。 */
function check(name: string, cond: boolean | null, detail: string): void {
  if (cond === null) bad(name, `未验证 · ${detail}`)
  else if (cond) ok(name, detail)
  else bad(name, detail)
}
function eq<T>(name: string, got: T, want: T, detail: string): void {
  check(name, Object.is(got, want), `${detail}（期望 ${String(want)}，实得 ${String(got)}）`)
}

/**
 * 从子进程 stderr 里挑出**真正有意义**的行。
 *
 * ★ 不挑的话，Node 的 `ExperimentalWarning: SQLite ...` 会把要断言的那句
 *   淹在噪音里，而失败信息里出现的是警告 —— 看的人会去查一个不相干的方向。
 */
function relevantStderr(raw: string, limit = 6): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/ExperimentalWarning|trace-warnings/.test(l))
  if (lines.length === 0) return '(stderr 空)'
  return lines.slice(-limit).join(' │ ')
}

/**
 * 在**捕获 `console.warn`** 的前提下跑一段代码，把"说过的话"和返回值一起带回来。
 *
 * ★ 为什么包成一个函数：直接写"先换掉 warn → try/finally 还原 → 变量声明在外"
 *   会让那个初始值在任何路径上都读不到（try 里必然覆盖，抛了就跳出后面全部），
 *   `no-useless-assignment` 会（正确地）报错。这个写法把"读完再还原"和
 *   "返回值"绑在一起，初始值就不存在了。
 */
function withCapturedWarn<T>(fn: () => T): { value: T; warns: string[] } {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '))
  }
  try {
    return { value: fn(), warns }
  } finally {
    console.warn = orig
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ═══════════════════════════════════════════════════════════════════
// 子进程助手：用真实进程造"两个 writer"的形状
//
// ★ 为什么必须跨进程：同一个进程内两个 `DatabaseSync` 连接**无法**复现
//   "两个 writer" —— POSIX 文件锁按进程持有，同进程内的第二个连接看到的
//   是同一个锁持有者。用一条连接模拟"两个进程"会造出一个**生产里不存在**的形状
//   （判据 D9）。所以这里 fork 真进程。
// ═══════════════════════════════════════════════════════════════════

interface ChildRun {
  proc: ChildProcess
  pid: number
  /** 等某一行 stdout（按前缀）。超时返回 null —— 调用方有权把它记成"未验证"。 */
  waitFor(prefix: string, timeoutMs: number): Promise<string | null>
  exited: Promise<number | null>
  stderr(): string
  stdoutAll(): string
}
const liveChildren: ChildRun[] = []

function runChild(mode: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildRun {
  const proc = spawn(process.execPath, [SELF, '--child', mode, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let outBuf = ''
  let errBuf = ''
  const lines: string[] = []
  const waiters: (() => void)[] = []
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (d: string) => {
    outBuf += d
    let i = outBuf.indexOf('\n')
    while (i >= 0) {
      lines.push(outBuf.slice(0, i))
      outBuf = outBuf.slice(i + 1)
      i = outBuf.indexOf('\n')
    }
    for (const w of waiters.splice(0)) w()
  })
  proc.stderr?.on('data', (d: string) => {
    errBuf += d
  })
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code))
  })
  const run: ChildRun = {
    proc,
    pid: proc.pid ?? -1,
    waitFor(prefix, timeoutMs) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs
        const tick = (): void => {
          const hit = lines.find((l) => l.startsWith(prefix))
          if (hit !== undefined) return resolve(hit)
          if (Date.now() > deadline) return resolve(null)
          waiters.push(tick)
          setTimeout(tick, 25).unref?.()
        }
        tick()
      })
    },
    exited,
    stderr: () => errBuf,
    stdoutAll: () => lines.join('\n'),
  }
  liveChildren.push(run)
  return run
}

function killAll(): void {
  for (const c of liveChildren) {
    try {
      c.proc.kill()
    } catch {
      /* 已经退出 */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 子进程入口（同一个文件，靠 `--child` 分流）
// ═══════════════════════════════════════════════════════════════════

async function runChildMode(mode: string, args: string[]): Promise<number> {
  if (mode === 'claim-race') {
    // 等到父进程放开闸门再抢 —— 这才是"同时启动"的形状。
    //
    // ★★ 抢到之后**必须占住不放**（最后那个 holdMs）。第一版没占，于是：
    //    赢家打印完 RESULT 就退出，输家拿到锁一读，发现前任**已经死了** ⇒
    //    按设计**接管** ⇒ 两个都 ok=true。那不是缺陷，是**夹具造错了形状**：
    //    真实的"两套栈同时启动"里，先到的那个是**活着并在服务的**
    //    （判据 D9 —— 夹具必须照生产的形状造，否则测试在检测一个不存在的世界）。
    const [dbPath, gatePath, holdMsRaw] = args
    process.env.ORCH_DB = dbPath
    const { initPersistence, claimInstance } = await import('../server/persistence.ts')
    // ★ 建库要排在闸门**之前**。第一版排在闸门之后，于是两个进程的
    //   `CREATE TABLE IF NOT EXISTS` 先互相争一次锁、把它们错开了几毫秒 ——
    //   竞态窗口还没开始就已经过去，夹具名为"同时抢"实则"一先一后"（判据 D9）。
    //   挪到这里之后，闸门放开时两边都只剩 `claimInstance()`，才是真的同刻。
    initPersistence()
    process.stdout.write('#READY_FOR_GATE\n')
    // ★★ 等闸门必须**紧自旋** `existsSync`，不能碰任何定时器。
    //
    //   两次失败的尝试记在这里，省得下一个人再走一遍：
    //   ① 第一版 `await sleep(2)` 轮询 ⇒ 粒度 ~15ms，两边醒来差十几毫秒，
    //      而 TOCTOU 的窗口只有几毫秒（判据 D9 的教训：夹具不够同刻）。
    //   ② 第二版改成"闸门文件里存目标时刻 + `Atomics.wait(…, 1)` 自旋"
    //      ⇒ `Atomics.wait` 的 1ms 超时同样受系统定时器粒度拖累；
    //      换成 `Date.now()` 纯自旋也一样 —— `Date.now()` 本身在 Windows 上
    //      的分辨率就是 ~15ms，拿它当同步钟等于没有同步。
    //   `existsSync` 是同步系统调用，紧循环里没有定时器参与 ⇒ 微秒级。
    //   父进程在确认所有抢锁者都 `#READY` 之后才写闸门文件，此刻大家都在转。
    for (let i = 0; i < 5_000_000 && !existsSync(gatePath); i += 1) {
      /* 紧自旋 */
    }
    // ★ 把自己"看到闸门 ⟶ 开始抢"的耗时报出来。
    //   它不是装饰：所有进程都是从**同一个闸门文件出现**起算，所以这几个数
    //   放一起就是"夹具到底同不同刻"的直接读数（判据 D9）。
    //   没有它，我只能猜 D1 为什么抓不到 TOCTOU。
    const t0 = Date.now()
    const fence = claimInstance()
    process.stdout.write(`RESULT|${fence.ok}|${fence.heldByPid ?? ''}|lag=${Date.now() - t0}\n`)
    await sleep(Number(holdMsRaw ?? 1500))
    return 0
  }
  if (mode === 'claim') {
    const [dbPath] = args
    process.env.ORCH_DB = dbPath
    const { initPersistence, claimInstance } = await import('../server/persistence.ts')
    initPersistence()
    const fence = claimInstance()
    process.stdout.write(`RESULT|${fence.ok}|${fence.heldByPid ?? ''}\n`)
    return 0
  }
  if (mode === 'stale-then-claim') {
    // 把现任的心跳改成 2 分钟前 —— 模拟"进程还活着但卡住了"。
    const [dbPath] = args
    process.env.ORCH_DB = dbPath
    const { initPersistence, claimInstance, getDb } = await import('../server/persistence.ts')
    initPersistence()
    getDb()?.prepare('UPDATE instance_fence SET heartbeat = ? WHERE id = 1').run(Date.now() - 120_000)
    const fence = claimInstance()
    process.stdout.write(`RESULT|${fence.ok}|${fence.heldByPid ?? ''}\n`)
    return 0
  }
  if (mode === 'hold-fence') {
    // 占着围栏不放，保持进程存活 —— 用来测"活着的持有者会拒绝别人"。
    const [dbPath, holdMsRaw] = args
    process.env.ORCH_DB = dbPath
    const { initPersistence, claimInstance } = await import('../server/persistence.ts')
    initPersistence()
    const fence = claimInstance()
    process.stdout.write(`RESULT|${fence.ok}|${fence.heldByPid ?? ''}\n`)
    await sleep(Number(holdMsRaw))
    return 0
  }
  if (mode === 'hold-write') {
    // 原生长事务：占住写锁 N 毫秒后提交。**不做任何重试** —— 它是"另一个进程"，
    // 就是要让它成为父进程那个可恢复的忙等。
    const [dbPath, holdMsRaw] = args
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout = 500;')
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('BEGIN IMMEDIATE')
    db.exec('CREATE TABLE IF NOT EXISTS probe_t (id INTEGER PRIMARY KEY, v TEXT)')
    db.exec("INSERT INTO probe_t (id, v) VALUES (1, 'held')")
    process.stdout.write('#HOLDING\n')
    await sleep(Number(holdMsRaw))
    db.exec('COMMIT')
    process.stdout.write('#RELEASED\n')
    db.close()
    return 0
  }
  if (mode === 'hold-lock') {
    // 库**保持 delete 模式**（不转 WAL）+ 持写锁，直到父进程写 release 文件放行。
    //
    // ★ 为什么由父进程决定何时释放：第一版用固定 holdMs，于是"初始化进程何时
    //   走到那条 PRAGMA"（Node 启动耗时）与"持锁多久"两个随机量必须刚好错开，
    //   否则要么争用没发生（假绿）、要么锁还没放（假红）——实测错过一次。
    //   改成"父进程等到初始化进程就位，再决定释放"就把启动耗时的方差消掉了。
    const [dbPath, releasePath] = args
    const db = new DatabaseSync(dbPath)
    const h0 = Date.now()
    db.exec('PRAGMA busy_timeout = 500;')
    db.exec('CREATE TABLE IF NOT EXISTS holder_t (id INTEGER PRIMARY KEY)')
    db.exec('BEGIN IMMEDIATE')
    db.exec('INSERT INTO holder_t (id) VALUES (1)')
    process.stdout.write(`#HOLDING ${Date.now() - h0}ms\n`)
    for (let i = 0; i < 10_000 && !existsSync(releasePath); i += 1) await sleep(2)
    db.exec('COMMIT')
    process.stdout.write(`#RELEASED ${Date.now() - h0}ms\n`)
    db.close()
    return 0
  }
  if (mode === 'init-under-lock') {
    const [dbPath] = args
    process.env.ORCH_DB = dbPath
    const { initPersistence, dbLockRetryCount } = await import('../server/persistence.ts')
    process.stdout.write('#ABOUT_TO_INIT\n')
    const t0 = Date.now()
    try {
      initPersistence()
    } catch (e) {
      process.stdout.write(`#INIT_FAIL ${Date.now() - t0}ms ${e instanceof Error ? e.message : String(e)}\n`)
      return 3
    }
    // ★ 把重试次数报出来：它是区分"重试救了它"与"根本没错过争用"的唯一观测点。
    process.stdout.write(`#INIT_OK ${Date.now() - t0}ms retries=${dbLockRetryCount()}\n`)
    return 0
  }
  process.stderr.write(`未知子模式: ${mode}\n`)
  return 2
}

// ═══════════════════════════════════════════════════════════════════
// A 区：声明层 —— 初始化顺序
//
// ★ 这条为什么值得单列：`busy_timeout` 是**每条连接**的设定，而 `journal_mode`
//   是要拿文件锁的。两者顺序写反，症状是"设了超时却立刻崩"，而看代码
//   "明明设了超时" —— 一个自证清白的错误。
// ═══════════════════════════════════════════════════════════════════

/** 读源码并**剥掉注释**再断言 —— 否则断言会命中自己写的解释性注释（本项目踩过）。 */
function readCode(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** 取某个顶层 `export function <name>` 的函数体（到下一个顶层 `export` 为止）。 */
function topLevelBody(code: string, name: string): string | null {
  const start = code.indexOf(`export function ${name}(`)
  if (start < 0) return null
  const next = code.indexOf('\nexport ', start + 1)
  return code.slice(start, next < 0 ? code.length : next)
}

/** 在函数体里找两个 PRAGMA 的先后。返回 null 表示**找不到**（不许当成通过）。 */
function pragmaOrder(body: string): { busyAt: number; journalAt: number } | null {
  const busyAt = body.indexOf('busy_timeout')
  const journalAt = body.indexOf('journal_mode')
  if (busyAt < 0 || journalAt < 0) return null
  return { busyAt, journalAt }
}

/**
 * 用**合成文本**证明顺序探测器看得见坏顺序。
 *
 * ★ 第一版写成"把现有两行对调再探测"，结果它随源码状态摆动：
 *   源码本来就是反的时，对调反而变正 ⇒ 断言自己红（A1 误报）。
 *   合成文本与源码状态无关，才是真的自证。
 */
function detectorSeesBothOrders(): boolean {
  const good = "db.exec('PRAGMA busy_timeout = 5000;')\nwithDbLockRetry('x', () => db?.exec('PRAGMA journal_mode = WAL;'))"
  const bad = "withDbLockRetry('x', () => db?.exec('PRAGMA journal_mode = WAL;'))\ndb.exec('PRAGMA busy_timeout = 5000;')"
  const g = pragmaOrder(good)
  const b = pragmaOrder(bad)
  return g !== null && b !== null && g.busyAt < g.journalAt && b.journalAt < b.busyAt
}

function sectionA(): void {
  group('A 初始化顺序（busy_timeout 必须早于 journal_mode）')
  const code = readCode('server/persistence.ts')
  const body = topLevelBody(code, 'initPersistence')
  check('A1 找得到 initPersistence 函数体', body !== null, body === null ? '找不到函数体 ⇒ 探测器本身失效，整道门是空转的' : `函数体 ${body.length} 字符`)
  if (body === null) return
  const order = pragmaOrder(body)
  check('A2 两条 PRAGMA 都在函数体里', order !== null, order === null ? 'busy_timeout 或 journal_mode 消失 ⇒ 要重审初始化逻辑，别急着判"顺序对"' : '两条都能定位')
  if (order === null) return
  check(
    'A3 ★ busy_timeout 排在 journal_mode 之前',
    order.busyAt < order.journalAt,
    `实测偏移 busy=${order.busyAt} journal=${order.journalAt} —— 反了就等于让唯一会争锁的语句裸奔（2026-09-23 那次 0.6 秒崩溃的根因）`,
  )
  check(
    'A4 顺序探测器有牙',
    detectorSeesBothOrders(),
    '拿两段合成文本喂给它：正序必须判对、反序必须判错（否则 A3 是假绿）',
  )
  // ★★ 一条必须写下来的边界（G 区实测）：`busy_timeout` 对 `journal_mode`
  //   **不起作用** —— 转 journal 模式拿的是 EXCLUSIVE 锁，拿不到时立刻返回
  //   `SQLITE_BUSY`，不走 busy handler。所以 A3 的顺序**不是**这一行的保险，
  //   `withDbLockRetry` 才是；顺序管的是它后面那些 CREATE TABLE / 写入。
  //   别把这两件事混成一件（否则下一个人会以为"顺序对就够了"）。
  check(
    'A5 顺序不是 journal_mode 的保险（重试才是）',
    /withDbLockRetry\(\s*'initPersistence:journal_mode'/.test(body),
    'journal_mode 这条必须单独包重试 —— 实测 busy_timeout 对它无效（见 G 区）',
  )
}

// ═══════════════════════════════════════════════════════════════════
// B 区：前提层 —— busy_timeout 覆盖不到哪两类（真实复现）
// ═══════════════════════════════════════════════════════════════════

const BUSY_MS = 1200

function openLockDb(): DatabaseSync {
  const db = new DatabaseSync(join(TMP, 'lock.db'))
  db.exec('PRAGMA busy_timeout = ' + BUSY_MS + ';')
  db.exec('PRAGMA journal_mode = WAL;')
  return db
}

function timedThrew(fn: () => void): { ms: number; msg: string | null } {
  const t = Date.now()
  try {
    fn()
    return { ms: Date.now() - t, msg: null }
  } catch (e) {
    return { ms: Date.now() - t, msg: e instanceof Error ? e.message : String(e) }
  }
}

function sectionB(): void {
  group(`B busy_timeout 的覆盖边界（预算 ${BUSY_MS}ms）`)
  const a = openLockDb()
  const b = openLockDb()
  a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
  a.exec("INSERT INTO t (id, v) VALUES (1, 'seed')")

  // B1 单写者争用：A 持写锁，B 想写 ⇒ 应**等满**预算才抛
  a.exec('BEGIN IMMEDIATE')
  a.exec("INSERT INTO t (id, v) VALUES (2, 'a')")
  const r1 = timedThrew(() => {
    b.exec('BEGIN IMMEDIATE')
    b.exec("INSERT INTO t (id, v) VALUES (3, 'b')")
  })
  try {
    b.exec('ROLLBACK')
  } catch {
    /* 没进事务 */
  }
  a.exec('COMMIT')
  check('B1 夹具真的造出了争用', r1.msg !== null && /database is locked|SQLITE_BUSY/.test(r1.msg), `实得 ${r1.msg ?? '（没抛错 —— 夹具失效）'}`)
  check(
    'B2 单写者争用：超时机制生效（等满预算）',
    r1.ms >= BUSY_MS * 0.8,
    `耗时 ${r1.ms}ms（预算 ${BUSY_MS}ms）—— 若它变成"立刻抛"，说明 busy_timeout 已失效`,
  )

  // B3 死锁：A、B 各持 SHARED 再同时想升级 ⇒ busy handler **不被调用**，立刻抛
  a.exec('BEGIN')
  a.prepare('SELECT COUNT(*) AS c FROM t').get()
  b.exec('BEGIN')
  b.prepare('SELECT COUNT(*) AS c FROM t').get()
  a.exec("INSERT INTO t (id, v) VALUES (4, 'a')")
  const r2 = timedThrew(() => b.exec("INSERT INTO t (id, v) VALUES (5, 'b')"))
  try {
    b.exec('ROLLBACK')
  } catch {
    /* 没进事务 */
  }
  a.exec('COMMIT')
  check('B3 死锁：立刻抛（busy_timeout 被跳过）', r2.msg !== null && r2.ms < 200, `耗时 ${r2.ms}ms · ${r2.msg ?? '（没抛）'}`)

  // B4 读快照过期：一方提交后另一方再写 ⇒ 同样立刻抛
  const c1 = openLockDb()
  const c2 = openLockDb()
  c1.exec('BEGIN')
  c1.prepare('SELECT COUNT(*) AS c FROM t').get()
  c2.exec('BEGIN')
  c2.prepare('SELECT COUNT(*) AS c FROM t').get()
  c1.exec("INSERT INTO t (id, v) VALUES (6, 'c1')")
  c1.exec('COMMIT')
  const r3 = timedThrew(() => c2.exec("INSERT INTO t (id, v) VALUES (7, 'c2')"))
  try {
    c2.exec('ROLLBACK')
  } catch {
    /* 没进事务 */
  }
  check('B4 读快照过期：立刻抛（busy_timeout 被跳过）', r3.msg !== null && r3.ms < 200, `耗时 ${r3.ms}ms · ${r3.msg ?? '（没抛）'}`)

  // ★ B5 是这道门存在的**理由**：这三类里只有第一类能靠"设超时"解决。
  check(
    'B5 ★ 前提仍成立：至少一类锁错绕过超时',
    r2.ms < 200 || r3.ms < 200,
    `死锁 ${r2.ms}ms / 快照过期 ${r3.ms}ms —— 若两类都开始等超时了，` +
      '`withDbLockRetry` 就失去理由，这道门**该红**并提示重审（判据 A2）',
  )

  for (const d of [a, b, c1, c2]) {
    try {
      d.close()
    } catch {
      /* ignore */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// C 区：机制层 —— withDbLockRetry 的边界
// ═══════════════════════════════════════════════════════════════════

async function sectionC(): Promise<void> {
  group('C 等锁重试的边界（只对锁错重试 / 有界 / 说得出重试过）')
  const { withDbLockRetry, isDbLockError, dbLockRetryCount, DB_LOCK_RETRY } = await import('../server/persistence.ts')

  // C1 判据本身：锁错认得出来，真错不认
  check('C1 isDbLockError 认得 node:sqlite 的锁错', isDbLockError(new Error('database is locked')), '文案是 node:sqlite 的原文')
  check('C2 isDbLockError 不把真错当锁错', !isDbLockError(new Error('NOT NULL constraint failed: events.kind')), '真错若被当成锁错，会被重试若干次后以一个不相干的错误现形（判据 A1）')

  // C3 短暂锁错 ⇒ 重试后成功，且**说出来**
  const before = dbLockRetryCount()
  let calls = 0
  const cap = withCapturedWarn(() =>
    withDbLockRetry(
      'smoke:C3',
      () => {
        calls += 1
        if (calls < 3) throw new Error('database is locked')
        return 'done'
      },
      { baseMs: 1, capMs: 2 },
    ),
  )
  eq('C3 锁错重试后成功', cap.value, 'done', '')
  eq('C3 重试次数符合预期', calls, 3, '')
  eq('C3 ★ 重试过就要计数', dbLockRetryCount(), before + 1, '静默重试成功与"一次就成功"在账面上必须长得不一样（判据 C5）')
  check(
    'C4 ★ 重试过就要说出来',
    cap.warns.some((w) => w.includes('等锁后第')),
    cap.warns.length > 0 ? `实得「${cap.warns[0]}」` : '一条日志都没有 ⇒ "并发在变多"这件事永远没有观测点',
  )

  // C5 ★ 真错不许重试（误报比漏报贵）
  let errCalls = 0
  let caught: string | null = null
  try {
    withDbLockRetry('smoke:C5', () => {
      errCalls += 1
      throw new Error('NOT NULL constraint failed: events.kind')
    }, { baseMs: 1, capMs: 2 })
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e)
  }
  eq('C5 ★ 真错只调用一次（不许重试）', errCalls, 1, '对真错重试会把可诊断的错误埋在若干次等待之后')
  check('C5 真错原样抛出', caught !== null && caught.includes('NOT NULL constraint failed'), `实得 ${caught ?? '（没抛）'}`)

  // C6 一直锁错 ⇒ 有界放弃，不无限重试
  let alwaysCalls = 0
  let bounded: string | null = null
  try {
    withDbLockRetry('smoke:C6', () => {
      alwaysCalls += 1
      throw new Error('database is locked')
    }, { attempts: 3, baseMs: 1, capMs: 2 })
  } catch (e) {
    bounded = e instanceof Error ? e.message : String(e)
  }
  eq('C6 一直锁错 ⇒ 调用次数 = attempts', alwaysCalls, 3, '')
  check('C6 一直锁错 ⇒ 抛出去（不吞）', bounded !== null && /database is locked/.test(bounded), `实得 ${bounded ?? '（没抛）'}`)

  // C7 最坏预算不许失控
  const worstMs = DB_LOCK_RETRY.baseMs * (2 ** (DB_LOCK_RETRY.attempts - 1) - 1) + DB_LOCK_RETRY.capMs
  const t0 = Date.now()
  try {
    withDbLockRetry('smoke:C7', () => {
      throw new Error('database is locked')
    })
  } catch {
    /* 预期抛出 */
  }
  const realMs = Date.now() - t0
  check('C7 最坏等待与 busy_timeout 同量级', realMs < 5000, `实测 ${realMs}ms · 估算上界 ${worstMs}ms（busy_timeout=5000ms）—— 比它长就意味着重试把一次慢查询放大成一次假挂起`)
}

// ═══════════════════════════════════════════════════════════════════
// D 区：竞态层 —— claimInstance 真的原子吗
// ═══════════════════════════════════════════════════════════════════

async function sectionD(): Promise<void> {
  group('D 单写者围栏的原子性（跨真实进程）')

  // D1 三个进程**同时**抢，必须恰好一个成功
  //
  // ★★ 这一条**抓不到 TOCTOU**，别指望它。实测（4 次）：把 `claimInstance` 的
  //    SELECT 挪到 `BEGIN IMMEDIATE` 之前（即复原旧的 TOCTOU 写法），D1 全绿；
  //    抓它的是 D5（结构断言，3/3 稳定红）。原因有两条，都量过：
  //      ① 同刻性读数 lag = 5 / 10 / 26 ms —— 三个进程根本不在同一毫秒上；
  //      ② 更根本的是 `claimInstance()` 自己开头那句
  //         `CREATE TABLE IF NOT EXISTS instance_fence` 要读 schema，
  //         会撞上赢家的写事务而退避，**天然把后来者推后到赢家提交之后**。
  //    试过三种同步方式都不够（sleep 轮询 / 目标时刻 + Atomics.wait /
  //    紧自旋 existsSync）—— 这是平台级的跨进程调度粒度问题，不是夹具写法问题。
  //    ⇒ 所以 D1 守的是"围栏对同时启动这件事**端到端有效**"（一个赢、其余被指名挡下），
  //      原子性的守门人是 D5。对外说明时不许把这条算成原子性的保险。
  // ★ 用 3 个而不是 2 个：期望值仍是"恰好 1 个成功"，但更接近"多套栈同时起"的形状。
  const raceDb = join(TMP, 'race.db')
  const gate = join(TMP, 'race.gate')
  const HOLD_MS = 1500
  const racers = [1, 2, 3].map(() => runChild('claim-race', [raceDb, gate, String(HOLD_MS)]))
  const readies = await Promise.all(racers.map((r) => r.waitFor('#READY_FOR_GATE', 20_000)))
  const allReady = readies.every((x) => x !== null)
  check(
    'D1 所有抢锁者都到齐（夹具形状对）',
    allReady,
    allReady ? `${racers.length}/${racers.length} 就位（都只差最后一次 claim）` : `就位 ${readies.filter(Boolean).length}/${racers.length} —— 没到齐就没造出"同时启动"`,
  )
  if (allReady) {
    // 此刻所有进程都还没抢（都在紧自旋），才放开闸门 ⇒ 竞态窗口是真的。
    writeFileSync(gate, 'go')
    const outs = await Promise.all(racers.map((r) => r.waitFor('RESULT|', 20_000)))
    const okCount = outs.filter((o) => o?.startsWith('RESULT|true')).length
    const lags = outs.map((o) => Number(/lag=(\d+)/.exec(o ?? '')?.[1] ?? NaN))
    check(
      'D1 抢锁者没有卡住（夹具没被人拖住）',
      lags.length === racers.length && lags.every((n) => Number.isFinite(n) && n < 200),
      `各自"看到闸门 ⟶ 抢完"耗时 ${lags.join(' / ')} ms —— 有任何一个特别大就说明这一轮没测成并发`,
    )
    check(
      'D1 ★ 恰好一个拿到围栏',
      okCount === 1,
      `拿到围栏的有 ${okCount} 个（${outs.join(' / ')}）。` +
        '≥2 个 true 就是围栏真的漏了；1 个才说明它对"同时启动"有效',
    )
    const losers = outs.filter((o) => o?.startsWith('RESULT|false'))
    check(
      'D1 落败方指名持有者 pid',
      losers.length === racers.length - 1 && losers.every((l) => /RESULT\|false\|\d+/.test(l ?? '')),
      losers.length === racers.length - 1 ? losers.join(' / ') : `只有 ${losers.length} 个落败方（应 ${racers.length - 1}）⇒ 围栏没能挡住同时启动的其它进程`,
    )
  }
  await Promise.all(racers.map((r) => r.exited))

  // D2 活着的持有者必须挡住后来者（并且指名它是谁）
  const holderDb = join(TMP, 'holder.db')
  const holder = runChild('hold-fence', [holderDb, '4000'])
  const hRes = await holder.waitFor('RESULT|', 20_000)
  check('D2 持有者拿到围栏', hRes === 'RESULT|true|', `实得 ${hRes ?? '超时'}`)
  const challenger = runChild('claim', [holderDb])
  const cRes = await challenger.waitFor('RESULT|', 20_000)
  check('D2 ★ 活着且心跳新鲜 ⇒ 拒绝', cRes?.startsWith('RESULT|false') === true, `实得 ${cRes ?? '超时'}`)
  check('D2 拒绝时指名持有者是哪个 pid', cRes === `RESULT|false|${holder.pid}`, `实得 ${cRes ?? '超时'} · 持有者 pid=${holder.pid}`)
  await challenger.exited

  // D3 心跳过期（进程卡住）⇒ 必须可接管，否则一次卡住会把系统永久锁死
  const stale = runChild('stale-then-claim', [holderDb])
  const sRes = await stale.waitFor('RESULT|', 20_000)
  check('D3 ★ 心跳过期 ⇒ 可接管', sRes?.startsWith('RESULT|true') === true, `实得 ${sRes ?? '超时'} —— 不许"一次卡住 = 永久锁死"`)
  await stale.exited
  await holder.exited

  // D4 心跳新鲜但进程**已经死了** ⇒ 同样必须可接管（走 process.kill 那条判据）
  const deadDb = join(TMP, 'dead.db')
  const reaper = runChild('claim', [join(TMP, 'noop.db')])
  const deadPid = reaper.pid
  await reaper.exited
  const raw = new DatabaseSync(deadDb)
  raw.exec(
    'CREATE TABLE IF NOT EXISTS instance_fence (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL)',
  )
  raw.prepare('INSERT OR REPLACE INTO instance_fence (id, pid, started_at, heartbeat) VALUES (1, ?, ?, ?)').run(deadPid, Date.now(), Date.now())
  raw.close()
  const taker = runChild('claim', [deadDb])
  const tRes = await taker.waitFor('RESULT|', 20_000)
  check(
    'D4 ★ 心跳新鲜但进程已死 ⇒ 可接管',
    tRes?.startsWith('RESULT|true') === true,
    `实得 ${tRes ?? '超时'}（前任 pid=${deadPid} 已退出，心跳却还是"新鲜"的）`,
  )
  await taker.exited

  // D5 结构：原子性靠的是 `BEGIN IMMEDIATE` 包住"读+判+写"
  const code = readCode('server/persistence.ts')
  const claimBody = topLevelBody(code, 'claimInstance')
  check('D5 找得到 claimInstance 函数体', claimBody !== null, claimBody === null ? '找不到 ⇒ D 区其余断言失去对象' : `函数体 ${claimBody.length} 字符`)
  if (claimBody !== null) {
    const beginAt = claimBody.indexOf('BEGIN IMMEDIATE')
    const selectAt = claimBody.indexOf('instance_fence WHERE id=1')
    const commitAt = claimBody.indexOf('COMMIT')
    check(
      'D5 ★ 读之前就先取写锁',
      beginAt >= 0 && selectAt > beginAt && commitAt > selectAt,
      `偏移 BEGIN=${beginAt} SELECT=${selectAt} COMMIT=${commitAt} —— 顺序必须是 取写锁 → 读 → 判 → 写 → 提交`,
    )
  }
}

// ═══════════════════════════════════════════════════════════════════
// E 区：生产入口层 —— ledger 真的占它自己那份围栏
//
// ★ 这一区是判据 C1：「只有测试可达」不算可达。A/D 两区证明机制对，
//   但它们都没证明**真实启动路径**会用到它。
// ═══════════════════════════════════════════════════════════════════

async function sectionE(): Promise<void> {
  group('E 生产入口：ledger 角色自己占围栏（复现 2026-09-23 那次启动形状）')

  // E1 结构：围栏在 listen 之前
  const code = readCode('server/ledgerServer.ts')
  const claimAt = code.indexOf('claimInstance()')
  const listenAt = code.indexOf('server.listen(')
  check(
    'E1 围栏取用排在 listen 之前',
    claimAt >= 0 && listenAt > claimAt,
    `偏移 claimInstance=${claimAt} listen=${listenAt} —— 排在后面等于"先接了客再验票"`,
  )

  // E2 运行时：第一台在跑时，第二台必须**活着走到围栏**并被拒，而不是崩在 journal_mode
  const fenceDb = join(TMP, 'fence.db')
  const crashLog = join(TMP, 'crash-ledger.log')
  const env = {
    ORCH_DB: fenceDb,
    ORCH_TOKEN: 'dev-insecure-token',
    EVOLVE_CRASH_LOG: crashLog,
  }
  const a = runChild('__ledger', [], { ...env, LEDGER_PORT: '18991' })
  const aUp = await a.waitFor('[OK] EVOLVE ledger 服务已启动', 30_000)
  check('E2 第一台 ledger 起来了（夹具前提）', aUp !== null, aUp ?? `30s 内没起来 · ${relevantStderr(a.stderr())}`)
  if (aUp !== null) {
    const b = runChild('__ledger', [], { ...env, LEDGER_PORT: '18992' })
    const bCode = await Promise.race([b.exited, sleep(30_000).then(() => 'timeout' as const)])
    const bErr = b.stderr()
    check('E2 第二台在 30s 内退出（不是挂住）', bCode !== 'timeout', `实得 ${String(bCode)}`)
    eq('E2 第二台以非零码退出', bCode, 1, '')
    check(
      'E2 ★ 第二台被围栏拒绝（说得出被谁占着）',
      /拒绝启动：账本正被 PID \d+ 占用/.test(bErr),
      relevantStderr(bErr),
    )
    check(
      'E2 ★★ 第二台**没有**崩在 database is locked',
      !/database is locked/.test(bErr) && !/uncaughtException/.test(bErr),
      '这正是 2026-09-23 那次 0.6 秒崩溃的形状：两台同时启动 ⟹ 一台死在 journal_mode',
    )
  }
  killAll()
}

// ═══════════════════════════════════════════════════════════════════
// G 区：把 2026-09-23 那次崩溃在**真争用**下重放一遍
//
// ★★ 这一区是本文件里最强的一条，因为它是**唯一**能同时证明下面两件事的夹具：
//   ① 初始化会在争用中活下来；
//   ② 救它的**不是** `busy_timeout` —— 实测转 journal 模式拿的是 EXCLUSIVE 锁，
//      拿不到时**立刻**返回 SQLITE_BUSY，完全不进 busy handler。
//      ⇒ 每次尝试都是 0ms 抛，全靠 `withDbLockRetry` 的等待把它拖过争用窗口。
//   所以断言必须是"成功 **且** 重试次数 > 0"：只断成功，会被"夹具没造出争用"骗过；
//   只断重试，会被"重试了但最终仍失败"骗过。
// ═══════════════════════════════════════════════════════════════════

async function sectionG(): Promise<void> {
  group('G 初始化遇上真争用：必须活下来，且靠的是重试')
  const lockDb = join(TMP, 'initlock.db')
  const release = join(TMP, 'initlock.release')

  const holder = runChild('hold-lock', [lockDb, release])
  const held = await holder.waitFor('#HOLDING', 20_000)
  check('G1 夹具持住了写锁（且库仍是 delete 模式）', held !== null, held ?? '没进入 HOLDING ⇒ 没造出争用，本区失去意义')
  if (held !== null) {
    const init = runChild('init-under-lock', [lockDb])
    const about = await init.waitFor('#ABOUT_TO_INIT', 20_000)
    check('G2 初始化进程已就位（此刻锁还在别人手上）', about !== null, about ?? '没就位')
    // 就位之后再决定何时放锁 ⇒ 消掉子进程启动耗时的方差（判据 D9）
    await sleep(300)
    writeFileSync(release, 'go')
    const line = await init.waitFor('#INIT_OK', 20_000)
    const failLine = init.stdoutAll()
      .split('\n')
      .find((l) => l.startsWith('#INIT_FAIL'))
    check(
      'G3 ★ 初始化在争用中活下来了',
      line !== null,
      line ?? failLine ?? '既没成功也没报失败（可能挂住）—— 这正是 2026-09-23 那次 0.6 秒崩溃的形状',
    )
    if (line !== null) {
      const m = /retries=(\d+)/.exec(line)
      check(
        'G4 ★ 它靠的是重试，不是 busy_timeout',
        m !== null && Number(m[1]) > 0,
        m === null
          ? '拿不到重试计数'
          : `${line}（实测：第一次尝试在 busy_timeout 里等了一段**有界**的时长后仍返回 BUSY，` +
              '是下一次重试才撞上已释放的锁 —— 所以这里断的是"重试过"，不是"等得够久"）· 持锁方 ' +
              (holder.stdoutAll().split('\n').find((l) => l.startsWith('#RELEASED')) ?? '未释放'),
      )
    }
    await init.exited
  }
  await holder.waitFor('#RELEASED', 20_000)
  await holder.exited
}

// ═══════════════════════════════════════════════════════════════════
// F 区：记账层 —— 遇锁不许静默丢事件
// ═══════════════════════════════════════════════════════════════════

async function sectionF(): Promise<void> {
  group('F appendEvent 遇锁不许静默丢事件')
  const parentDb = join(TMP, 'parent.db')
  process.env.ORCH_DB = parentDb
  const { initLedger, appendEvent, getEvents } = await import('../server/ledger.ts')
  const { countEvents, dbLockRetryCount, isPersistent, getDb } = await import('../server/persistence.ts')
  initLedger()
  check('F1 持久层真的开了（否则本区是空转）', isPersistent(), `ORCH_DB=${parentDb} 已打开并可用`)

  // ★ 把父进程的等待预算调短：夹具要造的是"等满之后仍失败"这一刻。
  //   这不是改产品行为（产品里是 5000ms），只是把同一次实验压缩到 1 秒内。
  getDb()?.exec('PRAGMA busy_timeout = 300;')

  const beforeCount = countEvents()
  const beforeRetries = dbLockRetryCount()
  const beforeMem = getEvents().length

  const holder = runChild('hold-write', [parentDb, '900'])
  const holding = await holder.waitFor('#HOLDING', 20_000)
  check('F2 夹具真的持住了写锁', holding !== null, holding ?? '子进程没进入 HOLDING ⇒ 没造出争用')
  let threw: string | null = null
  if (holding !== null) {
    try {
      appendEvent('dblock_probe', { note: 'lock-contention' })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
  }
  const released = await holder.waitFor('#RELEASED', 20_000)
  await holder.exited
  check('F3 夹具按时释放', released !== null, released ?? '子进程没释放（后面的断言会失去意义）')

  check('F4 appendEvent 没有把异常抛给调用方', threw === null, `实得 ${threw ?? '（无）'} —— 锁争用是可恢复的，不该升级成调用方的失败`)
  eq('F4 ★ 事件真的落进了台账', countEvents(), beforeCount + 1, '丢一条的后果是审计链从那一行起对不上，而且没有任何提示')
  eq('F4 内存链条数也 +1（两份记账一致）', getEvents().length, beforeMem + 1, '')
  check('F4 ★ 这一次确实靠重试才成功', dbLockRetryCount() > beforeRetries, `重试计数 ${beforeRetries} ⇒ ${dbLockRetryCount()} —— 若没涨，说明要么没争用（夹具失效）、要么改回了"遇锁就丢"`)

  // F5 配对断言：正常路径不许被这道修复误挡（判据 A1）
  const okCount = countEvents()
  appendEvent('dblock_probe', { note: 'no-contention' })
  eq('F5 ★ 无争用的正常路径照常落账', countEvents(), okCount + 1, '加了重试之后，正常写入必须一次就过')
}

// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<number> {
  console.log(`db-lock 门禁 · 临时目录 ${TMP}`)
  console.log(`Node ${process.version} · 运行标签 ${RUN_TAG}`)

  sectionA()
  sectionB()
  await sectionC()
  await sectionD()
  await sectionE()
  await sectionG()
  await sectionF()

  const failed = checks.filter((c) => !c.pass)
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'db-lock-latest.json'), JSON.stringify({ runTag: RUN_TAG, tmp: TMP, checks }, null, 2))

  // 反空转：一道门若只剩两三条断言，它挡不住任何人。
  if (checks.length < 50) {
    console.error(`\n❌ 只跑了 ${checks.length} 条断言（应 ≥50）—— 这道门正在被静默削弱`)
    return 1
  }

  console.log('\n────────────────────────────────────────')
  if (failed.length === 0) {
    console.log(`DB LOCK SMOKE PASSED · ${checks.length} passed / 0 failed`)
    return 0
  }
  console.log(`DB LOCK SMOKE FAILED · ${checks.length - failed.length} passed / ${failed.length} failed`)
  for (const f of failed) console.log(`  ❌ ${f.name} · ${f.detail}`)
  return 1
}

// ═══════════════════════════════════════════════════════════════════
// 入口分流。`--ledger` 不是本文件的模式：它直接拉起真实角色。
// ═══════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2)

if (argv[0] === '--child') {
  const mode = argv[1]
  if (mode === '__ledger') {
    // 直接跑真实入口，不引入任何测试专用分支（判据 C1）。
    const child: ChildProcess = spawn(process.execPath, ['server/ledgerServer.ts'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    child.on('exit', (code) => process.exit(code ?? 1))
  } else {
    runChildMode(mode, argv.slice(2)).then(
      (code) => process.exit(code),
      (e) => {
        process.stderr.write(`CHILD_ERR ${e instanceof Error ? e.stack : String(e)}\n`)
        process.exit(9)
      },
    )
  }
} else {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`❌ 探针本身抛出: ${e instanceof Error ? e.stack : e}`)
      killAll()
      process.exit(1)
    },
  )
}

// 兜底：任何退出路径都不该留下孤儿进程。
process.on('exit', () => killAll())
