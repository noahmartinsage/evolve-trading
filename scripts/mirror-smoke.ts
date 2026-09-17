import { spawn } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ★ 每个 run 用**独占的库文件名**，不再"先删掉旧库再建"。
 *
 * ── 为什么必须改（本机实测，2026-09-17 第九轮）──────────────────────────
 * 原写法是固定文件名 + 开局 `rmSync` 清干净。问题是**这个动作依赖文件系统允许删除**，
 * 而本机有一条按轮计数的删除配额（阈值 50，`scope:"turn"`）——配额一旦被别的动作打爆，
 * `rmSync` 就抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，**这道门禁当场变红**，
 * 而它守护的东西（镜像互查 + `/events` 语义）一个问题都没有。
 *
 * 这正是本项目最忌讳的那类检查：**对完全正确的输入报错**。
 * 它会训练人忽略这道门的红 —— 于是下次真红了也没人看。
 * （同轮 `test:stack` 与 `vite build`（清空 `dist/`）也栽在同一个配额上，
 * 三条红其实是**一个原因**，而上一轮把它归成了"`dist` 句柄冲突"。）
 *
 * ⇒ 正确做法：**别依赖删除**。文件名带 pid + 时间戳 ⇒ 天然是新库，不需要清；
 *   收尾仍尽力删（`cleanup`），删不掉就**说出来**（不静默），但不因此判失败 ——
 *   因为"清理没做成"与"这层不变量坏了"是两件事。
 */
const RUN_TAG = String(process.pid) + '-' + String(Date.now())
const ORCH_DB = join('data', 'mirror-orch-test-' + RUN_TAG + '.db')
const LEDGER_DB = join('data', 'mirror-ledger-test-' + RUN_TAG + '.db')
const PORT = 30000 + Math.floor(Math.random() * 20000)
const TOKEN = 'smoke-token'
const BASE = `http://localhost:${PORT}`

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []
let child: ReturnType<typeof spawn> | null = null

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  finish()
  console.error(`[FAIL] MIRROR SMOKE FAIL - ${name} - ${msg}`)
  cleanup()
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function finish(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'mirror-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

/**
 * 收尾：杀子进程 + **尽力**删掉本次的临时库。
 *
 * ★ 删除失败**不许**让门禁变红：文件名已经是本次独占的（见文件头），
 *   所以"没删掉"只影响磁盘上多几个临时文件，不影响这道门禁要守的任何不变量。
 *   但也不静默 —— 把那几个文件的名字打出来，让人知道它们在那儿、可以手动清。
 */
function cleanup(): void {
  if (child) child.kill()
  const leftovers: string[] = []
  for (const f of [ORCH_DB, LEDGER_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(f + suffix, { force: true })
      } catch {
        leftovers.push(f + suffix)
      }
    }
  }
  if (leftovers.length > 0) {
    console.warn('[WARN] 临时库未能删除（本机删除配额可能已满）· 与门禁结论无关 · 可手动清：')
    for (const l of leftovers) console.warn('       ' + l)
  }
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`, { headers: { 'x-orch-token': TOKEN } })
      if (r.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('ledger service did not become healthy')
}

async function main() {
  // ★ 这里**没有**"先删旧库"那一步了 —— 库名带 pid+时间戳，天然是新的（理由见文件头）。
  //   直接建库，把"干净"这件事交给命名，而不是交给"文件系统允不允许我删"。

  child = spawn(process.execPath, [join('server', 'ledgerServer.ts')], {
    env: { ...process.env, ORCH_DB: LEDGER_DB, LEDGER_PORT: String(PORT), ORCH_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (d) => process.stderr.write(d))

  // Isolated orchestrator-side DB: must be set before persistence module initializes
  process.env.ORCH_DB = ORCH_DB

  const { initLedger, appendEvent } = await import('../server/ledger.ts')
  const { enableMirror, checkMirror, getStatus, setPaused } = await import('../server/mirrorCheck.ts')

  await waitHealthy(15_000)
  console.log('[OK] ledger child service ready')

  initLedger()
  let fetchCount = 0
  const realFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetchCount += 1
    const u = String(input)
    if (!u.includes('/healthz')) console.log('[TRACE] fetch #' + fetchCount + ' -> ' + u)
    return realFetch(input as any, init)
  }) as typeof fetch

  enableMirror(BASE, TOKEN)

  appendEvent('MIRROR_A', { n: 1 })
  appendEvent('MIRROR_B', { n: 2 })
  appendEvent('MIRROR_C', { n: 3 })
  await new Promise((r) => setTimeout(r, 1500))

  const head = await (await fetch(`${BASE}/audit/head`, { headers: { 'x-orch-token': TOKEN } })).json() as { maxSrcSeq: number | null; lastSeq: number }
  console.log('[DEBUG] mirror status:', JSON.stringify(getStatus()))
  if ((head.maxSrcSeq ?? 0) !== 3) fail('S1 realtime mirror', `remote maxSrcSeq=${head.maxSrcSeq} status=${JSON.stringify(getStatus())}`)
  pass('S1 realtime mirror', `maxSrcSeq=${head.maxSrcSeq}`)

  // Simulate mirror outage: pause, then append 2 local-only events
  setPaused(true)
  appendEvent('MIRROR_D', { n: 4 })
  appendEvent('MIRROR_E', { n: 5 })
  await new Promise((r) => setTimeout(r, 800))
  setPaused(false)

  const stAfterGap = getStatus()
  if (stAfterGap.lastLocalSeq !== 5) fail('S2 outage detection', `localSeq=${stAfterGap.lastLocalSeq}`)

  // Bidirectional check should detect the gap and self-heal by re-posting missing events
  const checked = await checkMirror()
  if ((checked.remoteMaxSrcSeq ?? 5) < 5) fail('S2 outage detection', `remote still behind after repair: ${JSON.stringify(checked)}`)

  const afterRepair = await (await fetch(`${BASE}/audit/head`, { headers: { 'x-orch-token': TOKEN } })).json() as { maxSrcSeq: number | null; lastSeq: number }
  if ((afterRepair.maxSrcSeq ?? 0) !== 5) fail('S3 self-heal backfill', `remote still behind after repair: ${JSON.stringify(afterRepair)}`)

  const verified = await checkMirror()
  if (verified.originMismatches !== 0) fail('S4 origin hash comparison', `mismatches=${verified.originMismatches}`)
  pass('S2+S3+S4 outage / self-heal / hash comparison', 'gap auto-backfilled to srcSeq=5, origin hashes 0 mismatches')

  // ══════════ S5 `GET /events` 的读取语义 ══════════
  // 这一组的起因是实测到的一个真缺陷：账本已经到 seq 32384，
  // 而 `GET /events` 稳定返回 seq 1..500（最旧的一段），条数一直是满的、
  // 也没有任何截断提示。用它去回答"最近发生了什么"，拿到的是几周前的事。
  //
  // 断言刻意**成对**，因为单边断言在这件事上是无效的：
  //  · 只断言"返回了 3 条" —— 旧的错误实现也返回 3 条，永远绿；
  //  · 必须再断言"不传 since 与传 since=0 取到的是**不同**的两段"，
  //    这样"取错了一段"才会真的报红。
  {
    const pageLimit = 3

    const newest = await (await fetch(`${BASE}/events?limit=${pageLimit}`, { headers: { 'x-orch-token': TOKEN } })).json() as {
      events: { seq: number; kind: string }[]
      order: string
      total: number
      newestSeq: number | null
      truncated: boolean
    }
    if (newest.order !== 'newest') fail('S5 默认取最新一段', `order=${newest.order}（期望 newest）`)
    if (newest.newestSeq !== 5) fail('S5 默认取最新一段', `newestSeq=${newest.newestSeq}（期望 5，也就是最后追加的那条）`)
    if (newest.events.length !== pageLimit) fail('S5 默认取最新一段', `条数=${newest.events.length}（期望 ${pageLimit}）`)
    if (!newest.truncated) fail('S5 截断必须自报', `total=${newest.total} returned=${newest.events.length} 却没标 truncated`)

    const oldest = await (await fetch(`${BASE}/events?since=0&limit=${pageLimit}`, { headers: { 'x-orch-token': TOKEN } })).json() as {
      events: { seq: number }[]
      order: string
      newestSeq: number | null
    }
    if (oldest.order !== 'since') fail('S5 传 since 时是翻页语义', `order=${oldest.order}（期望 since）`)
    if (oldest.newestSeq === newest.newestSeq) {
      fail(
        'S5 两种模式必须取到不同段',
        `不传 since 与 since=0 都取到了 seq 尾部 ${newest.newestSeq} —— 说明"最新"没生效，默认仍在返回最旧一段`,
      )
    }
    if (oldest.events[0]?.seq !== 1) fail('S5 传 since=0 回到最旧段', `最旧段首条 seq=${oldest.events[0]?.seq}（期望 1）`)
    pass('S5 /events 读取语义', `默认取最新（newestSeq=${newest.newestSeq}）· 传 since 才是翻页（最旧段首条 seq=1）· 截断自报`)

    // 越界 limit 不能变成"要多少给多少"
    const clamped = await (await fetch(`${BASE}/events?limit=999999`, { headers: { 'x-orch-token': TOKEN } })).json() as { limit: number }
    if (clamped.limit > 5000) fail('S5 limit 有上限', `limit=${clamped.limit}（上限 5000）`)
  }

  finish()

  console.log('')
  console.log('[ARCHIVED] artifacts/mirror-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('MIRROR SMOKE PASSED')
  cleanup()
}

main().catch((e) => {
  console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
  cleanup()
  process.exit(1)
})
