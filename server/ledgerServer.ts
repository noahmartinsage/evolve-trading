import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { initLedger, appendEvent, getEvents, eventCount, verifyMemoryChain, chainHead } from './ledger.ts'
import { isPersistent, queryEvents, queryEventsTail, countEvents, loadLastChainRow, saveOrigin, maxSrcSeq, loadOriginsSince, claimInstance, heartbeatInstance, releaseInstance } from './persistence.ts'
import { installCrashGuard } from './crashGuard.ts'
import { HEALTH_ROLE_FIELD, type ServiceRole } from './serviceIdentity.ts'
import { INSECURE_DEFAULT_TOKEN, decideAuth } from './orchAuth.ts'

const TOKEN = process.env.ORCH_TOKEN ?? INSECURE_DEFAULT_TOKEN

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

  // ★★ 与编排层走**同一份**判据（`server/orchAuth.ts`）。
  //   账本服务同样 `listen(PORT)` 不带 host ⇒ 也监听所有网卡，
  //   而它的令牌是同一个环境变量、默认值也是同一个公开常量 ——
  //   只给编排层加守卫、把这一层留着，等于"同一个业务动作两条规矩"（判据 ㉙）。
  //
  //   ⚠️ 这里**没有**那一笔留痕：账本服务正是**写账本的那一个**，
  //      让它因为一个被拒的请求去 append 事件，会把"谁能写账本"这条边界搞浑
  //      （而且被拒的请求恰恰可能来自攻击者 —— 那就成了他可以往账本里塞行）。
  //      留痕由编排层负责，那儿已经有一条 `ORCH_REMOTE_WITH_DEFAULT_TOKEN`。
  function authorized(req: import('node:http').IncomingMessage): boolean {
    return decideAuth({
      token: TOKEN,
      presented: req.headers['x-orch-token'],
      remoteAddress: req.socket.remoteAddress,
    }).ok
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
          [HEALTH_ROLE_FIELD]: 'ledger' satisfies ServiceRole,
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
  if (process.env.NODE_ENV === 'production' && (!process.env.ORCH_TOKEN || process.env.ORCH_TOKEN === INSECURE_DEFAULT_TOKEN)) {
    console.error('❌ NODE_ENV=production 要求显式设置 ORCH_TOKEN')
    process.exit(1)
  }
  initLedger()
  // ★★ 单写者围栏：**ledger 这一侧此前完全不占锁** —— `claimInstance()` 只被
  //   `server/index.ts`（orch 角色）调用，而 orch 的库是 `data/orch.db`。
  //   结果是：`data/ledger.db` **没有任何围栏**，两个 ledger 进程可以同时写它。
  //
  //   这正是 2026-09-23 那次崩溃的完整成因链（`data/app-stack.log` 第 6657–6671 行）：
  //     ① 两套栈在同一秒启动（6657/6658 两行 `════ EVOLVE 启动 ════`）
  //     ② 两个 ledger 同时执行 `PRAGMA journal_mode = WAL`（当时 busy_timeout 还没设）
  //     ③ 一个抛 `database is locked`，存活 0.6 秒即死
  //   所以修法有两半：把 busy_timeout 提到 journal_mode 之前（见 persistence.ts），
  //   **以及**让 ledger 也去占它自己那份库的围栏 —— 否则"别人也能起第二个 ledger"
  //   这件事一直成立，只是早晚再撞一次。
  try {
    const fence = claimInstance()
    if (!fence.ok) {
      console.error(`❌ 拒绝启动：账本正被 PID ${fence.heldByPid} 占用（single-writer 保护）`)
      process.exit(1)
    }
  } catch (e) {
    console.error(`❌ 账本围栏获取失败，拒绝启动: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  setInterval(() => heartbeatInstance(), 15_000)
  process.on('SIGINT', () => {
    releaseInstance()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    releaseInstance()
    process.exit(0)
  })
  process.on('exit', () => releaseInstance())
  const PORT = Number(process.env.LEDGER_PORT ?? 8791)
  const server = createLedgerHttpServer()
  server.listen(PORT, () => {
    console.log('[OK] EVOLVE ledger 服务已启动 port=' + PORT + ' persistent=' + isPersistent())
    console.log('  REST http://localhost:' + PORT + '/healthz /audit/head /events /audit/verify · POST /events(需令牌)')
  })
}
