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

export function initPersistence(): void {
  if (db) return
  const path = process.env.ORCH_DB ?? join('data', 'orch.db')
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, equity REAL NOT NULL, balance REAL NOT NULL, killswitch INTEGER NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS promotions (id TEXT PRIMARY KEY, updated_ts INTEGER NOT NULL, data TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, stage TEXT NOT NULL, submitted_ts INTEGER NOT NULL, fitness_version TEXT, fitness_value REAL, wf_robust INTEGER, purity_homog INTEGER, paper_trades INTEGER, paper_dd REAL, approved_by TEXT, cap_usd REAL, rolled_back_to TEXT, live_notional REAL NOT NULL DEFAULT 0, history_json TEXT NOT NULL DEFAULT \'[]\')')
  db.exec('CREATE TABLE IF NOT EXISTS audit_chain (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS proposals (proposal_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)')
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
 * 单写者围栏：同一账本文件同时只允许一个 orchestration 实例写入。
 * 历史审计链分叉（seq 154 事件）的根因就是多实例并发追加导致 prevHash 分叉，
 * 因此第二实例必须 fail-closed 拒绝启动，而不是静默污染账本。
 */
export function claimInstance(): { ok: boolean; heldByPid?: number; heldSince?: number } {
  if (!db) throw new Error('persistence not initialized')
  db.exec('CREATE TABLE IF NOT EXISTS instance_fence (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, started_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL)')
  const row = db.prepare('SELECT pid, started_at, heartbeat FROM instance_fence WHERE id=1').get() as
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
    if (alive && now - row.heartbeat < 60_000) return { ok: false, heldByPid: row.pid, heldSince: row.started_at }
  }
  const startedAt = row && row.pid === process.pid ? row.started_at : now
  db.prepare('INSERT OR REPLACE INTO instance_fence (id, pid, started_at, heartbeat) VALUES (1, ?, ?, ?)').run(process.pid, startedAt, now)
  return { ok: true }
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
