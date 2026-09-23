import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface PersistedEvent {
  seq: number
  ts: number
  kind: string
  payload: string
}

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync | null {
  return db
}

/**
 * 这个抛出物是不是"锁争用"（可以等一等再试），而不是逻辑错误。
 *
 * ★ 为什么单独抽一个判据：`database is locked` 有两类，**处置完全相反**。
 *   一类等一会儿就好了（单写者争用），另一类是**死锁/快照过期**，
 *   重试也不解决，必须回滚整个事务再来。把它们混成一个"重试就好"
 *   会得到一个永远重试不成功的循环；混成"报错就好"则会把可恢复的忙等
 *   升级成一次崩溃。见 `scripts/db-lock-smoke.ts` 的三场景实测。
 */
export function isDbLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(msg)
}

/**
 * 等锁重试的默认参数。`attempts` 取 8 ⇒ 最坏 ~1.3 秒，与 busy_timeout 同量级。
 *
 * ★★ 刻意**不写 `as const`**（2026-09-23，被 `tsc` 抓到）：
 *   写了它，`Partial<typeof DB_LOCK_RETRY>` 就把三个字段锁成**字面量类型**
 *   （`attempts?: 8`、`capMs?: 400`）⇒ 参数**根本没法调**，调用方想传
 *   `{ attempts: 3 }` 直接编译不过。而"能调小参数"正是夹具需要的
 *   （否则测一次有界放弃要等满 1.3 秒）。运行期因为类型被剥掉看不出问题，
 *   所以这个错一路活到 `tsc` 才现形 —— 又一个"绿不等于对"的实例。
 */
export const DB_LOCK_RETRY: { attempts: number; baseMs: number; capMs: number } = { attempts: 8, baseMs: 10, capMs: 400 }

/**
 * 把一段会争锁的操作包成"等锁重试"。
 *
 * ★ 三条纪律，缺一条这个函数就会变成遮丑布：
 *   ① **只**对锁争用重试（`isDbLockError`）—— 真错必须原样抛出去，
 *      否则它会被重试八次然后以一个不相干的错误现形（判据 A1）。
 *   ② **把重试次数说出来** —— 静默重试成功与"一次就成功"在账本上必须长得不一样，
 *      否则"磁盘/并发已经在退化"这件事永远没有观测点（判据 C5）。
 *   ③ 调用方传进来的 `fn` 必须是**可整体重放**的（自己回滚干净），
 *      否则第二次重试会接在一个半途的事务上。
 */
export function withDbLockRetry<T>(label: string, fn: () => T, opts: Partial<typeof DB_LOCK_RETRY> = {}): T {
  const attempts = opts.attempts ?? DB_LOCK_RETRY.attempts
  const baseMs = opts.baseMs ?? DB_LOCK_RETRY.baseMs
  const capMs = opts.capMs ?? DB_LOCK_RETRY.capMs
  let waitMs: number = baseMs
  for (let i = 1; ; i += 1) {
    try {
      const out = fn()
      if (i > 1) {
        // ② 重试过就要说 —— 这条日志本身就是"锁争用在变多"的唯一观测量。
        console.warn(`[db] ${label} 等锁后第 ${i} 次才成功（并发写争用）`)
        dbLockRetries += 1
      }
      return out
    } catch (e) {
      if (!isDbLockError(e) || i >= attempts) throw e
      // node:sqlite 是同步 API —— 忙等期间只能阻塞事件循环。
      // 这是刻意的：重试窗口只有毫秒级，而"把同步 API 变成异步"要改动
      // 整个持久层，代价远大于收益（且会让调用方的顺序假设失效）。
      sleepSync(waitMs)
      waitMs = Math.min(capMs, waitMs * 2)
    }
  }
}

/** 本次进程内"等锁重试后才成功"的累计次数。给巡检/自检用。 */
let dbLockRetries = 0

export function dbLockRetryCount(): number {
  return dbLockRetries
}

/** 同步睡一小会儿。只用于等锁重试，别拿它做别的事。 */
function sleepSync(ms: number): void {
  const until = Date.now() + ms
  // Atomics.wait 在 Node 主线程可用（`SharedArrayBuffer` 不需要额外开关）。
  const sab = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < until) {
    Atomics.wait(sab, 0, 0, Math.min(5, Math.max(1, until - Date.now())))
  }
}

export function initPersistence(): void {
  if (db) return
  const path = process.env.ORCH_DB ?? join('data', 'orch.db')
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  // ★★ `busy_timeout` 必须排在 `journal_mode` **之前**。这不是风格问题。
  //
  //   实测（2026-09-23，`data/app-stack.log` 第 6657/6658 行）：两套栈在**同一秒**启动，
  //   两个 ledger 进程同时对同一个 `data/ledger.db` 执行下面这条 `PRAGMA journal_mode = WAL`，
  //   其中一个抛 `database is locked`，进程在 **0.6 秒**时崩掉。栈回溯精确指向这一行：
  //     at initPersistence (server/persistence.ts:23:6)
  //     at initLedger (server/ledger.ts:28:3)
  //
  //   为什么"设了 busy_timeout 也没用"：它是在**下一行**才设的。等锁机制必须在
  //   **第一条会争锁的语句之前**生效，而 `journal_mode` 恰好就是那条 ——
  //   把它放在超时之前，等于让唯一会争锁的语句在没有保护的情况下裸奔。
  //
  //   ★ 另一半原因（同样实测）：`busy_timeout` 对**死锁 / 读快照过期**这两类
  //   `SQLITE_BUSY` 是**无效**的 —— 它们会立刻返回，不走 busy handler。
  //   实测见 `scripts/db-lock-smoke.ts`：单写者争用等满 3358ms，
  //   而死锁与过期快照都是 **0ms 立刻抛**。所以只调顺序还不够，
  //   整段初始化必须再包一层**有界等锁重试**（`withDbLockRetry`）。
  db.exec('PRAGMA busy_timeout = 5000;')
  withDbLockRetry('initPersistence:journal_mode', () => db?.exec('PRAGMA journal_mode = WAL;'))
  withDbLockRetry('initPersistence:schema', () => {
    const d = db
    if (!d) return
    d.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)')
    d.exec('CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, equity REAL NOT NULL, balance REAL NOT NULL, killswitch INTEGER NOT NULL)')
    d.exec('CREATE TABLE IF NOT EXISTS promotions (id TEXT PRIMARY KEY, updated_ts INTEGER NOT NULL, data TEXT NOT NULL)')
    d.exec('CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, stage TEXT NOT NULL, submitted_ts INTEGER NOT NULL, fitness_version TEXT, fitness_value REAL, wf_robust INTEGER, purity_homog INTEGER, paper_trades INTEGER, paper_dd REAL, approved_by TEXT, cap_usd REAL, rolled_back_to TEXT, live_notional REAL NOT NULL DEFAULT 0, history_json TEXT NOT NULL DEFAULT \'[]\')')
    d.exec('CREATE TABLE IF NOT EXISTS audit_chain (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL)')
    d.exec('CREATE TABLE IF NOT EXISTS proposals (proposal_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL)')
    d.exec('CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)')
  })
}

export function upsertPromotion(id: string, ts: number, dataJson: string): void {
  if (!db) throw new Error('persistence not initialized')
  db.prepare('INSERT INTO promotions (id, updated_ts, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_ts = excluded.updated_ts, data = excluded.data').run(id, ts, dataJson)
}

export function ensureOriginTable(): void {
  if (!db) return
  db.exec('CREATE TABLE IF NOT EXISTS event_origins (seq INTEGER PRIMARY KEY, src_seq INTEGER NOT NULL, src_hash TEXT NOT NULL)')
}

export function saveOrigin(seq: number, srcSeq: number, srcHash: string): void {
  if (!db) return
  ensureOriginTable()
  db.prepare('INSERT OR REPLACE INTO event_origins (seq, src_seq, src_hash) VALUES (?, ?, ?)').run(seq, srcSeq, srcHash)
}

export interface OriginRow {
  seq: number
  src_seq: number
  src_hash: string
}

export function loadOriginsSince(srcSeq: number): OriginRow[] {
  if (!db) return []
  ensureOriginTable()
  return db.prepare('SELECT seq, src_seq, src_hash FROM event_origins WHERE src_seq > ? ORDER BY src_seq ASC').all(srcSeq) as unknown as OriginRow[]
}

export function maxSrcSeq(): number | null {
  if (!db) return null
  ensureOriginTable()
  const row = db.prepare('SELECT MAX(src_seq) AS m FROM event_origins').get() as { m: number | null }
  return row.m ?? null
}

export interface ChainRowLite {
  seq: number
  hash: string
}

export function loadChainRows(): ChainRowLite[] {
  if (!db) return []
  return db.prepare(
    `SELECT e.seq AS seq, COALESCE(c.hash, '') AS hash
     FROM events e LEFT JOIN audit_chain c ON c.seq = e.seq ORDER BY e.seq ASC`,
  ).all() as unknown as ChainRowLite[]
}

export function loadPromotions(): { id: string; updated_ts: number; data: string }[] {
  if (!db) return []
  return db.prepare('SELECT id, updated_ts, data FROM promotions ORDER BY updated_ts DESC').all() as unknown as { id: string; updated_ts: number; data: string }[]
}

export interface LastChainRow {
  seq: number
  ts: number
  kind: string
  payload: string
  hash: string
}

export function loadLastChainRow(): LastChainRow | null {
  if (!db) return null
  const row = db.prepare(
    `SELECT e.seq AS seq, e.ts AS ts, e.kind AS kind, e.payload AS payload, COALESCE(c.hash, '') AS hash
     FROM events e LEFT JOIN audit_chain c ON c.seq = e.seq ORDER BY e.seq DESC LIMIT 1`,
  ).get() as unknown as LastChainRow | undefined
  return row ?? null
}

export function isPersistent(): boolean {
  return db !== null
}

/**
 * 单写者围栏：同一账本文件同时只允许一个实例写入。
 * 历史审计链分叉（seq 154 事件）的根因就是多实例并发追加导致 prevHash 分叉，
 * 因此第二实例必须 fail-closed 拒绝启动，而不是静默污染账本。
 *
 * ★★ 2026-09-23 修：原实现是**先 SELECT 再 INSERT**，中间没有任何事务 ——
 *   两个同时启动的进程会双双读到空行、双双写入、双双 `{ok:true}`。
 *   也就是说这道围栏对"同时启动"这个**唯一需要它的场景**恰好无效。
 *   实测证据：`data/app-stack.log` 第 6657/6658 行，两套栈在同一秒启动；
 *   紧接着 6671 行一个 ledger 因 `database is locked` 在 0.6 秒时崩掉。
 *   ⇒ 改成 `BEGIN IMMEDIATE` 把"读 + 判 + 写"包成一次原子操作：
 *     第二个进程会在**读之前**就拿到写锁，从而必然看见第一个进程写下的行。
 */
export function claimInstance(): { ok: boolean; heldByPid?: number; heldSince?: number } {
  if (!db) throw new Error('persistence not initialized')
  withDbLockRetry('claimInstance', () => db?.exec('CREATE TABLE IF NOT EXISTS instance_fence (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL)'))
  return withDbLockRetry('claimInstance', () => {
    const d = db
    if (!d) throw new Error('persistence not initialized')
    d.exec('BEGIN IMMEDIATE')
    try {
      const row = d.prepare('SELECT pid, started_at, heartbeat FROM instance_fence WHERE id=1').get() as
        | { pid: number; started_at: number; heartbeat: number }
        | undefined
      const now = Date.now()
      if (row && row.pid !== process.pid) {
        // 用「默认存活、信号失败即判死」的写法：初始 false 再在 catch 里重复赋值 false
        // 是冗余的，且容易让人误以为两个分支语义不同。
        let alive = true
        try {
          process.kill(row.pid, 0)
        } catch {
          alive = false
        }
        if (alive && now - row.heartbeat < 60_000) {
          d.exec('COMMIT')
          return { ok: false, heldByPid: row.pid, heldSince: row.started_at }
        }
      }
      const startedAt = row && row.pid === process.pid ? row.started_at : now
      d.prepare('INSERT OR REPLACE INTO instance_fence (id, pid, started_at, heartbeat) VALUES (1, ?, ?, ?)').run(process.pid, startedAt, now)
      d.exec('COMMIT')
      return { ok: true }
    } catch (e) {
      try {
        d.exec('ROLLBACK')
      } catch {
        /* 已经回滚过 */
      }
      throw e
    }
  })
}

export function heartbeatInstance(): void {
  if (!db) return
  try {
    db.prepare('UPDATE instance_fence SET heartbeat = ? WHERE id = 1 AND pid = ?').run(Date.now(), process.pid)
  } catch {
    /* 心跳失败不阻断业务 */
  }
}

export function releaseInstance(): void {
  if (!db) return
  try {
    db.prepare('DELETE FROM instance_fence WHERE id = 1 AND pid = ?').run(process.pid)
  } catch {
    /* ignore */
  }
}

export function persistEvent(ts: number, kind: string, payloadJson: string): number {
  if (!db) throw new Error('persistence not initialized')
  const res = db.prepare('INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)').run(ts, kind, payloadJson)
  return Number(res.lastInsertRowid)
}

export function queryEvents(sinceSeq: number, limit = 500): PersistedEvent[] {
  if (!db) return []
  return db.prepare('SELECT seq, ts, kind, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(sinceSeq, limit) as unknown as PersistedEvent[]
}

/**
 * 取**最新**的 N 条（返回时按 seq 升序，方便调用方直接顺序阅读）。
 *
 * ★ 与 `queryEvents` 的区别不是排序偏好，而是"读到的是哪一段"：
 *   `ORDER BY seq ASC LIMIT N` 永远返回**最旧**的一段 —— 账本越长，
 *   它离现在越远，而返回的条数一直是满的，所以**看不出被截断**。
 *   实测：本地账本已到 seq 32384，`GET /events` 却稳定返回 seq 1..500，
 *   全是几周前的旧事件，且没有任何提示。一个"看起来正常、永远看不到新东西"
 *   的读路径比直接报错更危险。
 *
 *   这里刻意 `DESC` 取尾再翻回升序：`LIMIT` 只有在倒序时才作用在尾部。
 */
export function queryEventsTail(limit = 500): PersistedEvent[] {
  if (!db) return []
  const rows = db.prepare('SELECT seq, ts, kind, payload FROM events ORDER BY seq DESC LIMIT ?').all(limit) as unknown as PersistedEvent[]
  return rows.reverse()
}

export function countEvents(): number {
  if (!db) return 0
  const row = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
  return Number(row.c)
}

export function lastEventTs(): number | null {
  if (!db) return null
  const row = db.prepare('SELECT MAX(ts) AS m FROM events').get() as { m: number | null }
  return row.m ?? null
}

export function persistSnapshot(ts: number, equity: number, balance: number, killswitch: boolean): void {
  if (!db) return
  db.prepare('INSERT OR REPLACE INTO snapshots (ts, equity, balance, killswitch) VALUES (?, ?, ?, ?)').run(
    ts,
    Math.round(equity * 100) / 100,
    Math.round(balance * 100) / 100,
    killswitch ? 1 : 0,
  )
}

export function latestSnapshots(limit = 50): { ts: number; equity: number; balance: number; killswitch: number }[] {
  if (!db) return []
  return db.prepare('SELECT ts, equity, balance, killswitch FROM snapshots ORDER BY ts DESC LIMIT ?').all(limit) as unknown as { ts: number; equity: number; balance: number; killswitch: number }[]
}
