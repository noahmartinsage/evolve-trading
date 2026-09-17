import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { initLedger, appendEvent, getEvents, eventCount, verifyMemoryChain, chainHead } from './ledger.ts'
import { isPersistent, queryEvents, queryEventsTail, countEvents, loadLastChainRow, saveOrigin, maxSrcSeq, loadOriginsSince } from './persistence.ts'
import { installCrashGuard } from './crashGuard.ts'

const TOKEN = process.env.ORCH_TOKEN ?? 'dev-insecure-token'

/** 默认条数；上限挡的是"一次拉爆内存"，不是"不许看全"（要看全请翻页）。 */
const EVENT_PAGE_DEFAULT = 500
const EVENT_PAGE_MAX = 5000

function clampLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return EVENT_PAGE_DEFAULT
  return Math.min(Math.floor(n), EVENT_PAGE_MAX)
}

export function createLedgerHttpServer(): import('node:http').Server {
  const startedAt = Date.now()

  function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
    res.end(data)
  }

  function authorized(req: import('node:http').IncomingMessage): boolean {
    return req.headers['x-orch-token'] === TOKEN
  }

  async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf-8')
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Access-Control-Allow-Origin', process.env.ORCH_ALLOWED_ORIGIN ?? '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-orch-token')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    try {
      if (url.pathname === '/healthz') {
        const last = loadLastChainRow()
        return json(res, 200, {
          ok: true,
          role: 'ledger',
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          persistent: isPersistent(),
          memoryEvents: eventCount(),
          lastSeq: last?.seq ?? 0,
          head: last?.hash ?? chainHead(),
        })
      }

      if (url.pathname === '/audit/head') {
        const last = loadLastChainRow()
        return json(res, 200, { lastSeq: last?.seq ?? 0, head: last?.hash ?? '', maxSrcSeq: maxSrcSeq() })
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        /**
         * 读取语义（两种模式，**由有没有传 `since` 决定**，返回值里用 `order` 自报）：
         *
         *   · 不传 `since`  → 返回**最新**的 `limit` 条（升序）。这是"最近发生了什么"。
         *   · 传了 `since`  → 返回 `since` 之后的 `limit` 条（升序）。这是翻页。
         *
         * 为什么默认必须是"最新"：默认返回最旧一段的话，账本越长这个读路径离现在越远，
         * 而条数一直是满的 —— 调用方**无法察觉自己看的是几周前的事**。
         * 实测过这个症状：账本已到 seq 32384，`/events` 稳定返回 seq 1..500。
         *
         * `truncated` 是刻意加的：拿到 500 条不等于"一共就 500 条"。
         * 不告诉调用方这件事，就等于逼他拿一份不完整的证据下结论。
         */
        const sinceRaw = url.searchParams.get('since')
        const limit = clampLimit(url.searchParams.get('limit'))
        if (isPersistent()) {
          const rows = sinceRaw === null ? queryEventsTail(limit) : queryEvents(Number(sinceRaw) || 0, limit)
          const total = countEvents()
          return json(res, 200, {
            events: rows.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload) })),
            order: sinceRaw === null ? 'newest' : 'since',
            limit,
            total,
            returned: rows.length,
            oldestSeq: rows[0]?.seq ?? null,
            newestSeq: rows[rows.length - 1]?.seq ?? null,
            truncated: sinceRaw === null ? total > rows.length : rows.length === limit,
          })
        }
        const mem = getEvents(Number(sinceRaw ?? '0') || 0)
        return json(res, 200, {
          events: mem,
          order: sinceRaw === null ? 'oldest' : 'since',
          limit,
          total: eventCount(),
          returned: mem.length,
          oldestSeq: mem[0]?.seq ?? null,
          newestSeq: mem[mem.length - 1]?.seq ?? null,
          truncated: false,
        })
      }

      if (req.method === 'GET' && url.pathname === '/origins') {
        const since = Number(url.searchParams.get('sinceSrc') ?? '0')
        return json(res, 200, {
          maxSrcSeq: maxSrcSeq(),
          origins: loadOriginsSince(Number.isFinite(since) ? since : 0),
        })
      }

      if (req.method === 'POST' && url.pathname === '/events') {
        if (!authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' })
        const body = JSON.parse(await readBody(req)) as {
          kind?: string
          payload?: Record<string, unknown>
          src?: { seq?: number; hash?: string }
        }
        if (!body.kind) return json(res, 422, { error: 'KIND_REQUIRED' })
        const ev = appendEvent(String(body.kind), body.payload ?? {})
        if (body.src && Number.isFinite(body.src.seq) && body.src.hash) {
          saveOrigin(ev.seq, Number(body.src.seq), String(body.src.hash))
        }
        return json(res, 200, { seq: ev.seq, hash: ev.hash, srcSeq: body.src?.seq ?? null })
      }

      if (url.pathname === '/audit/verify') {
        const m = verifyMemoryChain()
        return json(res, 200, { ok: m.ok, memory: m, head: chainHead() })
      }

      json(res, 404, { error: 'NOT_FOUND' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message.slice(0, 200) : 'BAD_REQUEST' })
    }
  })
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  // ★ 装上"遗言机制"必须排在**任何其它语句之前**，包括下面那条生产守卫：
  //   `initLedger()` / `listen()` 里任何一处抛出都要能被记下来。
  //   没有它，本进程的崩溃在父进程看来与"被 taskkill 打死"逐字节相同（见 crashGuard.ts）。
  installCrashGuard('ledger')
  if (process.env.NODE_ENV === 'production' && (!process.env.ORCH_TOKEN || process.env.ORCH_TOKEN === 'dev-insecure-token')) {
    console.error('❌ NODE_ENV=production 要求显式设置 ORCH_TOKEN')
    process.exit(1)
  }
  initLedger()
  const PORT = Number(process.env.LEDGER_PORT ?? 8791)
  const server = createLedgerHttpServer()
  server.listen(PORT, () => {
    console.log('[OK] EVOLVE ledger 服务已启动 port=' + PORT + ' persistent=' + isPersistent())
    console.log('  REST http://localhost:' + PORT + '/healthz /audit/head /events /audit/verify · POST /events(需令牌)')
  })
}
