import { initPersistence, isPersistent, persistEvent, getDb, loadLastChainRow, withDbLockRetry } from './persistence.ts'
import type { DatabaseSync } from 'node:sqlite'
import { computeEventHash, GENESIS_HASH } from './audit.ts'

const MAX_EVENTS = 50_000

interface MemoryEvent {
  seq: number
  ts: number
  kind: string
  payload: Record<string, unknown>
  hash: string
}

let seq = 0
let prevHash = GENESIS_HASH
let memBaselinePrev = GENESIS_HASH
const events: MemoryEvent[] = []

type MirrorFn = (ev: { seq: number; ts: number; kind: string; payload: Record<string, unknown>; hash: string }) => void
let mirror: MirrorFn | null = null

export function setMirror(fn: MirrorFn | null): void {
  mirror = fn
}

export function initLedger(): void {
  initPersistence()
  // 跨重启续链：以持久层最后一行哈希为锚，避免重启后 prev 归零造成链断裂
  if (isPersistent()) {
    const last = loadLastChainRow()
    if (last && last.hash) {
      seq = last.seq
      prevHash = last.hash
      memBaselinePrev = last.hash
    }
  }
}

export function appendEvent(kind: string, payload: Record<string, unknown>): MemoryEvent {
  const payloadJson = JSON.stringify(payload)
  const ev: MemoryEvent = { seq: seq + 1, ts: Date.now(), kind, payload, hash: '' }
  const dbh = (isPersistent() ? getDb() : null) as unknown as DatabaseSync | null
  if (dbh) {
    // 事件行 + 链哈希必须原子落盘：历史上链哈希静默丢失正是持久链断裂的另一诱因
    try {
      // ★ 2026-09-23：锁争用先**有界重试**，再谈失败。
      //   改之前这里一遇到 `database is locked` 就直接走 catch —— 那一段会
      //   `seq += 1` 然后把事件**只留在内存里**，账本上悄悄地少一条。
      //   账本少一条的后果是审计链从那一行起对不上，而且没有任何提示。
      //   `BEGIN IMMEDIATE` 是立刻取写锁，重试时它必须从 BEGIN 整体重放，
      //   所以整段（BEGIN → 写 → COMMIT）都放进 `withDbLockRetry` 的回调里。
      withDbLockRetry('appendEvent', () => {
        dbh.exec('BEGIN IMMEDIATE')
        try {
          const dbSeq = persistEvent(ev.ts, ev.kind, payloadJson)
          ev.seq = dbSeq
          seq = Math.max(seq, dbSeq)
          // 哈希在最终 seq 确定后计算，保证内存链与持久链对同一事件得出相同 hash
          ev.hash = computeEventHash(prevHash, ev.seq, ev.ts, ev.kind, payloadJson)
          dbh.prepare('INSERT OR REPLACE INTO audit_chain (seq, hash) VALUES (?, ?)').run(ev.seq, ev.hash)
          dbh.exec('COMMIT')
        } catch (e) {
          try {
            dbh.exec('ROLLBACK')
          } catch {
            /* 已经回滚过 */
          }
          // 原样抛出：由 `withDbLockRetry` 判"这是锁争用（可重试）"还是"这是真错"。
          throw e
        }
      })
    } catch (e) {
      console.error(`[audit] 事件持久化失败 seq~${ev.seq} kind=${kind}: ${e instanceof Error ? e.message : e}`)
      seq += 1
      ev.seq = seq
      ev.hash = computeEventHash(prevHash, ev.seq, ev.ts, ev.kind, payloadJson)
    }
  } else {
    seq += 1
    ev.seq = seq
    ev.hash = computeEventHash(prevHash, ev.seq, ev.ts, ev.kind, payloadJson)
  }
  prevHash = ev.hash
  events.push(ev)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  if (isPersistent()) {
    try {
      getDb()?.prepare('INSERT OR REPLACE INTO audit_chain (seq, hash) VALUES (?, ?)').run(ev.seq, ev.hash)
    } catch {
      /* 链表写入失败不阻断业务事件 */
    }
  }
  try {
    mirror?.({ seq: ev.seq, ts: ev.ts, kind: ev.kind, payload: ev.payload, hash: ev.hash })
  } catch {
    /* 远程镜像失败不影响本地账本 */
  }
  return ev
}

export function getEvents(sinceSeq = 0): MemoryEvent[] {
  return events.filter((e) => e.seq > sinceSeq)
}

export function eventCount(): number {
  return events.length
}

/**
 * 内存链完整性校验：从创世哈希起重放全部事件，逐条比对 seq 与 hash。
 *
 * ★ 2026-09-23：这行注释此前是乱码（`鍐呭瓨閾惧畬鏁存€?…`）—— 它是 UTF-8 字节被
 *   按 GBK 读过一遍的产物，也就是说这个文件曾在某条**编码不对的路径**上被写过。
 *   乱码本身不影响运行，但它说明"文件被写坏过"，而写坏这文件的那条路径
 *   同样可能写坏别的东西。已按上下文复原为原意。
 */
export function verifyMemoryChain(): { ok: boolean; checked: number; brokenAtSeq: number | null; scope: string } {
  let prev = memBaselinePrev
  for (const e of events) {
    const expect = computeEventHash(prev, e.seq, e.ts, e.kind, JSON.stringify(e.payload))
    if (expect !== e.hash) return { ok: false, checked: events.length, brokenAtSeq: e.seq, scope: 'memory' }
    prev = e.hash
  }
  return { ok: true, checked: events.length, brokenAtSeq: null, scope: 'memory' }
}

export function chainHead(): string {
  return prevHash
}

export function resetLedger(): void {
  seq = 0
  memBaselinePrev = GENESIS_HASH
  prevHash = GENESIS_HASH
  events.length = 0
}
