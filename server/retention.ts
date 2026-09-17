import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent } from './ledger.ts'
import { isPersistent } from './persistence.ts'

const DEFAULT_RETENTION_DAYS = 90

export interface DbLike {
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    run(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

let dbRef: (() => DbLike | null) | null = null

export function bindRetentionDb(getter: () => DbLike | null): void {
  dbRef = getter
}

export interface RetentionResult {
  ran: boolean
  archived: number
  deleted: number
  archiveFile: string | null
}

export async function runRetention(retentionDays = Number(process.env.ORCH_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)): Promise<RetentionResult> {
  const out: RetentionResult = { ran: false, archived: 0, deleted: 0, archiveFile: null }
  if (!isPersistent() || !dbRef) return out
  const db = dbRef()
  if (!db || retentionDays <= 0) return out

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const row = db.prepare('SELECT COUNT(*) AS c FROM events WHERE ts < ?').get(cutoff) as { c: number }
  const stale = Number(row.c)
  if (stale === 0) return out

  const dir = join(process.cwd(), 'data', 'archive')
  const file = join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`)

  const BATCH = 500
  let lastSeq = 0
  let archived = 0
  for (;;) {
    const rows = db.prepare('SELECT seq, ts, kind, payload FROM events WHERE ts < ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(cutoff, lastSeq, BATCH) as { seq: number; ts: number; kind: string; payload: string }[]
    if (rows.length === 0) break
    if (archived === 0) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, '')
      out.archiveFile = file
    }
    appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    lastSeq = rows[rows.length - 1].seq
    archived += rows.length
  }

  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)
  out.ran = true
  out.archived = archived
  out.deleted = archived
  appendEvent('RETENTION_PRUNE', { archived, deleted: archived, cutoffDays: retentionDays, archiveFile: out.archiveFile })
  return out
}

export function startRetentionLoop(runNow = true): void {
  const tick = () => {
    void runRetention().then((r) => {
      if (r.archived > 0) console.log(`🗄️ 保留策略执行 · 归档并清理 ${r.archived} 条旧事件 → ${r.archiveFile}`)
    }).catch((e) => console.warn(`⚠️ 保留策略失败: ${e instanceof Error ? e.message : e}`))
  }
  if (runNow) setTimeout(tick, 5_000)
  setInterval(tick, 6 * 60 * 60 * 1000)
}
