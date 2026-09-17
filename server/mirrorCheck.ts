import { setMirror } from './ledger.ts'
import { loadLastChainRow, queryEvents, loadChainRows } from './persistence.ts'

export interface MirrorStatus {
  enabled: boolean
  url: string | null
  paused: boolean
  lastLocalSeq: number
  remoteMaxSrcSeq: number | null
  missing: number
  repairedTotal: number
  originMismatches: number
  lastError: string | null
  lastCheckAt: number | null
}

interface PendingEvent {
  seq: number
  ts: number
  kind: string
  payload: Record<string, unknown>
  hash: string
}

let url: string | null = null
let token = ''
let paused = false
const pending: PendingEvent[] = []
let repairedTotal = 0
let originMismatches = 0
let lastError: string | null = null
let lastCheckAt: number | null = null
let lastRemoteSrcSeq: number | null = null
let flushing = false

export function enableMirror(mirrorUrl: string, mirrorToken: string): void {
  url = mirrorUrl.replace(/\/+$/, '')
  token = mirrorToken
  paused = false
  setMirror((ev) => {
    pending.push({ seq: ev.seq, ts: ev.ts, kind: ev.kind, payload: ev.payload, hash: ev.hash })
    void flush()
  })
}

export function disableMirror(): void {
  url = null
  paused = false
  pending.length = 0
  setMirror(null)
}

export function setPaused(v: boolean): void {
  paused = v
}

async function postEvent(ev: PendingEvent): Promise<void> {
  const res = await fetch(`${url}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': token },
    body: JSON.stringify({ kind: ev.kind, payload: ev.payload, src: { seq: ev.seq, hash: ev.hash } }),
  })
  if (!res.ok) throw new Error(`mirror POST HTTP ${res.status}`)
}

async function flush(): Promise<void> {
  if (!url || paused || flushing) return
  flushing = true
  try {
    while (pending.length > 0 && !paused) {
      const ev = pending[0]
      await postEvent(ev)
      pending.shift()
      lastError = null
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message.slice(0, 120) : String(e)
  } finally {
    flushing = false
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${url}${path}`, { headers: { 'x-orch-token': token } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/** 双向互查：远端缺失则补投；远端存储的来源哈希与本地持久链逐一比对 */
export async function checkMirror(): Promise<MirrorStatus> {
  const st = getStatus()
  if (!st.enabled || paused) return st
  try {
    await flush()

    const head = await fetchJson<{ lastSeq: number; maxSrcSeq: number | null }>('/audit/head')
    const local = loadLastChainRow()
    const localSeq = local?.seq ?? 0
    const remoteSrc = head.maxSrcSeq ?? 0

    let repairedThisRun = 0
    if (remoteSrc < localSeq) {
      for (const row of queryEvents(remoteSrc)) {
        await postEvent({ seq: row.seq, ts: row.ts, kind: row.kind, payload: JSON.parse(row.payload), hash: '' })
        repairedThisRun += 1
      }
    }

    const after = await fetchJson<{ origins: { seq: number; src_seq: number; src_hash: string }[]; maxSrcSeq?: number | null }>('/origins?sinceSrc=0')
    const chainHashes = new Map(loadChainRows().map((r) => [r.seq, r.hash]))
    let mismatches = 0
    for (const o of after.origins) {
      if (chainHashes.get(o.src_seq) !== o.src_hash) mismatches += 1
    }
    originMismatches = mismatches
    lastRemoteSrcSeq = after.maxSrcSeq ?? lastRemoteSrcSeq
    repairedTotal += repairedThisRun
    lastCheckAt = Date.now()
    lastError = null
  } catch (e) {
    lastError = e instanceof Error ? e.message.slice(0, 140) : String(e)
  }
  return getStatus()
}

export function getStatus(): MirrorStatus {
  const local = loadLastChainRow()
  return {
    enabled: url !== null,
    url,
    paused,
    lastLocalSeq: local?.seq ?? 0,
    remoteMaxSrcSeq: lastRemoteSrcSeq,
    missing: local ? Math.max(0, local.seq - (lastRemoteSrcSeq ?? 0)) : 0,
    repairedTotal,
    originMismatches,
    lastError,
    lastCheckAt,
  }
}

export function isMirrorEnabled(): boolean {
  return url !== null
}
