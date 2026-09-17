// 审计哈希链：每条事件携带 hash = SHA256(prevHash | seq | ts | kind | canonicalJson(payload))。
// 链头为创世哈希；任何一条历史记录被篡改都会导致其后整条链校验失败（防篡改锚定）。
// 内存账本与 SQLite 持久层各自成链，可分别独立校验。
import { createHash } from 'node:crypto'

export const GENESIS_HASH = '0'.repeat(64)

export function computeEventHash(prevHash: string, seq: number, ts: number, kind: string, payloadJson: string): string {
  return createHash('sha256').update(`${prevHash}|${seq}|${ts}|${kind}|${payloadJson}`).digest('hex')
}

export interface ChainRow {
  seq: number
  ts: number
  kind: string
  payload: string
  hash: string
}

export interface ChainVerdict {
  ok: boolean
  checked: number
  brokenAtSeq: number | null
  scope: string
  skippedPreChain?: number
}

export function verifyRows(rows: ChainRow[], scope: string): ChainVerdict {
  let prev = GENESIS_HASH
  let started = false
  let skipped = 0
  for (const r of rows) {
    // 哈希链启用之前的历史行（hash 为空）视为 pre-chain 基线，不参与校验
    if (!started && r.hash === '') {
      skipped += 1
      continue
    }
    if (!started) {
      started = true
      prev = GENESIS_HASH
    }
    const expect = computeEventHash(prev, r.seq, r.ts, r.kind, r.payload)
    if (expect !== r.hash) return { ok: false, checked: rows.length - skipped, brokenAtSeq: r.seq, scope }
    prev = r.hash
  }
  return { ok: true, checked: rows.length - skipped, brokenAtSeq: null, scope, skippedPreChain: skipped }
}

/** 校验持久层事件表 + 审计链表的一致性（重启后仍可验证历史不可篡改） */
export function verifyPersistedChain(db: {
  prepare(sql: string): { all(...args: unknown[]): unknown[] }
}): ChainVerdict {
  const rows = db.prepare(
    `SELECT e.seq AS seq, e.ts AS ts, e.kind AS kind, e.payload AS payload, COALESCE(c.hash, '') AS hash
     FROM events e LEFT JOIN audit_chain c ON c.seq = e.seq ORDER BY e.seq ASC`,
  ).all() as unknown as { seq: number; ts: number; kind: string; payload: string; hash: string }[]
  return verifyRows(rows, 'sqlite')
}
