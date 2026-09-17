import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { computeEventHash, GENESIS_HASH } from '../server/audit.ts'

const dbPath = process.env.ORCH_DB ?? join('data', 'orch.db')
if (!existsSync(dbPath)) {
  console.error(`❌ 数据库不存在: ${dbPath}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('CREATE TABLE IF NOT EXISTS audit_chain (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL)')

const rows = db.prepare('SELECT seq, ts, kind, payload FROM events ORDER BY seq ASC').all() as unknown as { seq: number; ts: number; kind: string; payload: string }[]

let prev = GENESIS_HASH
let fixed = 0
const update = db.prepare('INSERT OR REPLACE INTO audit_chain (seq, hash) VALUES (?, ?)')
for (const r of rows) {
  const hash = computeEventHash(prev, r.seq, r.ts, r.kind, r.payload)
  update.run(r.seq, hash)
  prev = hash
  fixed += 1
}

console.log(`✅ 审计链重建完成 · 共 ${fixed} 行 · 新链头 ${prev}`)
