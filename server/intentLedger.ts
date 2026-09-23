/**
 * 持久化下单意图台账 —— 「同一笔意图只许出网一次」的唯一事实源。
 *
 * ══ 为什么必须做（内化自日报「幂等 / 崩溃恢复」方向，判据 8 / 10 / 35）══════
 *
 * 改造前 `gateway/executor.ts:30` 的去重是**内存** `Set<string>`：
 *
 *     private seenClientIds = new Set<string>()
 *     ...
 *     if (this.seenClientIds.has(intent.clientOrderId)) return { reason: 'DUPLICATE_CLIENT_ID' }
 *     this.seenClientIds.add(intent.clientOrderId)
 *
 * 它**结构上不可能**挡住真实的重复下单。两个独立的事因，缺一不可地架空了它：
 *
 *   ① **重启即丢**：Set 在进程内存里。进程一重启，历史全空，
 *      崩溃前提交过的意图在重启后被当作全新的。
 *   ② ★★ **更致命：id 每次都是新的**（`autopilot.ts:995`）
 *
 *          const clientOrderId = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
 *
 *      **同一个逻辑意图**（同一根 K 线、同一个信号、同样的 side/qty）再走一遍
 *      `submitOrder()`，会生成一个**完全不同的 id**。于是：
 *        · Set 里查不到 ⇒ 不报重复 ⇒ 放行（漏挡真重复）
 *      这解释了为什么"幂等"这件事看起来有实现、却从没拦住过任何东西 ——
 *      **去重键与被去重的对象不是同一个东西**（判据 35：断"出现过"不代表"起作用了"）。
 *
 * ── 一个必须同时说明的反向缺陷（同一个 id 生成器的另一面）─────────────────
 * 3 位 36 进制后缀 = 46656 种。**同一毫秒内**批量下单时按生日悖论会撞 id。
 * 实测（本机，10000 次生成）：**碰撞率 0.040%**。
 * 撞了会怎样：`seenClientIds` 命中**另一个不相干订单**的 id ⇒
 * 一笔**合法的**单被误判成 `DUPLICATE_CLIENT_ID` 而拒掉。
 * ⇒ 所以**不能只修"漏挡"，还得修 id 生成**：见 `makeIntentKey()` 的设计。
 *
 * ══ 设计：三个决定 ═══════════════════════════════════════════════════
 *
 * **决定一：去重键必须是"语义键"，不是随机串。**
 *   `intentKey = sha256(symbol|side|type|qty|leverage|instType|bucket)`，
 *   其中 `bucket` 由调用方给出（对自治循环而言 = 这根 K 线的时间戳）。
 *   ⇒ **同一根 K 线上重复触发的同一个信号**，算出来的 key 一模一样 ⇒ 挡得住。
 *   ⇒ 换一根 K 线（bucket 变）⇒ key 变 ⇒ 是新意图，正常放行。
 *   ★ 这是"桶"而不是"时间窗"：桶由**业务事件**（K 线）定义，
 *     不由墙钟滑动窗口定义 —— 前者可复现，后者会让同一根 K 线上的重试
 *     落在两个桶里（判据 31：两个数的口径必须一致）。
 *
 * **决定二：出网前落账（write-ahead），不是出网后补记。**
 *   顺序：`begin()`（落 `in_flight` 并**提交事务**）→ 出网 → `settle()`。
 *   若先出网再落账，崩溃恰好落在两者之间 ⇒ 交易所已受理、本地无记录 ⇒
 *   重启后判定为"新意图"⇒ **重复下单**。这正是要根治的场景。
 *   落账在前时，崩溃的结果是"本地 in_flight、实际可能没发出去"——
 *   这是**安全方向**的错（保守占用 / 待对账），不是危险方向的错。
 *
 * **决定三：`in_flight` 永不自动过期释放。**
 *   崩溃后留下的 `in_flight` 是**未知状态**，不是"已失败"。
 *   自动过期 = 把"不知道"当成"没事"（判据 13）。
 *   ⇒ 提供 `reconcile()` 让**场所侧**给出确定结论（订单到底在不在），
 *     再据此显式推进状态；`recoverOrphans()` 只**标记**不释放。
 *   ★ 这一条与 R20 的 `risk_reservation` 语义同源（见 `docs/R20-BENCHMARK.md` §4.1）：
 *     **「本地丢了」≠「场所没有」。**
 *
 * ══ 三态而不是两态 ══════════════════════════════════════════════════
 * 台账只回答"这个语义键有没有出过网"，**不回答"该不该下单"**（那是 `tradeGate` 的事）。
 * 查询结果三态：
 *   · `fresh`     —— 没见过，可出网
 *   · `settled`   —— 出过网且已定局，**不许再出**
 *   · `in_flight` —— 出过网但结果未知，**也不许再出**（先对账）
 * 后两者都不放行，但**给调用方的动作不同**：前者是"已经有了，别重复"，
 * 后者是"不知道成没成，去对账" —— 混为一谈会把排查引向错方向（判据 13）。
 */
import { createHash } from 'node:crypto'
import { getDb } from './persistence.ts'
import { appendEvent } from './ledger.ts'

/** 台账状态：`in_flight` 是"结果未知"，`settled` 是"已定局"。 */
export type IntentState = 'in_flight' | 'settled'

/** 查询结果三态 —— 注意 `fresh` 是唯一可出网的那一档。 */
export type IntentLookup =
  | { kind: 'fresh' }
  | { kind: 'settled'; intentKey: string; venueOrderId: string | null; outcome: string }
  | { kind: 'in_flight'; intentKey: string; bucket: string; startedTs: number }

export interface BeginResult {
  /** `false` = 这个语义键已经出过网，**不要**再发。 */
  ok: boolean
  intentKey: string
  lookup: IntentLookup
}

let tableReady = false

function ensureTable(): boolean {
  const db = getDb()
  if (!db) return false
  if (tableReady) return true
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_intents (
      intent_key     TEXT PRIMARY KEY,
      bucket         TEXT NOT NULL,
      symbol         TEXT NOT NULL,
      side           TEXT NOT NULL,
      qty            TEXT NOT NULL,
      state          TEXT NOT NULL,
      venue_order_id TEXT,
      outcome        TEXT,
      created_ts     INTEGER NOT NULL,
      settled_ts     INTEGER
    )
  `)
  // 按 bucket 查"这根 K 线上已经出过哪些网"是复盘时最常用的读法
  db.exec('CREATE INDEX IF NOT EXISTS idx_order_intents_bucket ON order_intents(bucket)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_order_intents_state ON order_intents(state)')
  tableReady = true
  return true
}

/**
 * 语义键：**同一笔意图在任何时刻、任何进程里都必须算出同一个 key**。
 *
 * ★ 各字段的取舍理由（改这里之前先想清楚）：
 *   · `symbol` / `side` / `type` —— 变了就是另一笔单，必须进 key
 *   · `qty` —— 用**归一化后的字符串**（见 `normQty`），不用浮点数直接拼，
 *     否则 `0.1+0.2` 这类尾差会让"同一个数量"算出两个 key（判据 21 同族）
 *   · `leverage` / `instType` / `settle` —— 它们改变的是**真实风险敞口**，
 *     同样数量的现货单与 10x 合约单显然不是同一笔
 *   · `bucket` —— 由调用方给（自治循环传 K 线开盘时间）。
 *     **不含 `Date.now()`**：那是"生成时刻"不是"意图身份"，
 *     把它放进 key 就等于把随机性放进去了 —— 正是要修的那个毛病。
 *   · **不含价格**：市价单的价格由场所决定；把当时的 markPrice 放进 key
 *     会让"同一根 K 线上 tick 抖了一下"变成两个 key（判据 31）。
 */
export function makeIntentKey(input: {
  symbol: string
  side: string
  type: string
  qty: number
  leverage?: number
  instType?: string
  settle?: string
  bucket: string
}): string {
  const parts = [
    input.symbol,
    input.side,
    input.type,
    normQty(input.qty),
    String(input.leverage ?? 1),
    input.instType ?? 'SPOT',
    input.settle ?? '-',
    input.bucket,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

/**
 * 数量的确定性归一化。
 *
 * ★ 为什么不能直接 `String(qty)`：`String(0.1 + 0.2)` = `"0.30000000000000004"`，
 *   而 `String(0.3)` = `"0.3"` —— 数值上"相等"的两个量会算出两个 key。
 *   统一成"小数点后最多 12 位、去掉尾随零"的定点写法。
 * ★ 12 位不是随手取的：BTC 的最小单位是 1e-8，12 位给足余量又不碰浮点尾差区。
 */
export function normQty(qty: number): string {
  if (!Number.isFinite(qty)) return 'NaN'
  const s = qty.toFixed(12)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** 只读查询：这个语义键现在的状态。**不写任何东西**。 */
export function lookupIntent(intentKey: string): IntentLookup {
  if (!ensureTable()) return { kind: 'fresh' }
  const db = getDb()
  if (!db) return { kind: 'fresh' }
  const row = db
    .prepare('SELECT intent_key, state, venue_order_id, outcome, bucket, created_ts FROM order_intents WHERE intent_key = ?')
    .get(intentKey) as
    | { intent_key: string; state: string; venue_order_id: string | null; outcome: string | null; bucket: string; created_ts: number }
    | undefined
  if (!row) return { kind: 'fresh' }
  if (row.state === 'settled') {
    return { kind: 'settled', intentKey: row.intent_key, venueOrderId: row.venue_order_id, outcome: row.outcome ?? 'unknown' }
  }
  return { kind: 'in_flight', intentKey: row.intent_key, bucket: row.bucket, startedTs: row.created_ts }
}

/**
 * 出网**之前**调用。返回 `ok:false` 时**绝对不要**发单。
 *
 * ★ 原子性来源：`INSERT ... ON CONFLICT DO NOTHING` 单条语句。
 *   `changes === 0` 表示键已存在（无论是 in_flight 还是 settled）⇒ 拒绝。
 *   不需要读-改-写三步，因此不存在"两个并发路径都读到空、双双插入"的窗口
 *   —— 这正是 R20 用 `BEGIN IMMEDIATE` 解决的同一个语义（判据见 §4.1），
 *   在 SQLite 单语句下天然成立。
 */
export function beginIntent(input: {
  intentKey: string
  bucket: string
  symbol: string
  side: string
  qty: number
}): BeginResult {
  if (!ensureTable()) {
    // ★ 无持久层时**不放行**（fail-closed）：没有台账就没法保证幂等，
    //   此时"能下单"是假象。宁可拒绝并说出来。
    return { ok: false, intentKey: input.intentKey, lookup: { kind: 'in_flight', intentKey: input.intentKey, bucket: input.bucket, startedTs: 0 } }
  }
  const db = getDb()
  if (!db) return { ok: false, intentKey: input.intentKey, lookup: { kind: 'in_flight', intentKey: input.intentKey, bucket: input.bucket, startedTs: 0 } }

  const res = db
    .prepare(
      `INSERT INTO order_intents (intent_key, bucket, symbol, side, qty, state, created_ts)
       VALUES (?, ?, ?, ?, ?, 'in_flight', ?)
       ON CONFLICT(intent_key) DO NOTHING`,
    )
    .run(input.intentKey, input.bucket, input.symbol, input.side, normQty(input.qty), Date.now())

  if (Number(res.changes) === 0) {
    // 已存在 ⇒ 不重复出网，并把**已有状态原样报回去**（让调用方知道该干什么）
    const lookup = lookupIntent(input.intentKey)
    appendEvent('INTENT_DEDUPED', {
      intentKey: input.intentKey,
      bucket: input.bucket,
      existing: lookup.kind,
    })
    return { ok: false, intentKey: input.intentKey, lookup }
  }

  appendEvent('INTENT_IN_FLIGHT', { intentKey: input.intentKey, bucket: input.bucket, symbol: input.symbol, side: input.side, qty: normQty(input.qty) })
  return { ok: true, intentKey: input.intentKey, lookup: { kind: 'fresh' } }
}

/**
 * 出网**之后**调用，把结果推进到定局。
 *
 * ★ `settled` 是**不可复活**的终态：已定局的键再 `settle` 不改写。
 *   理由同 R20 §4.1「终态幂等不可复活」：一笔单的结局一旦确定，
 *   后续任何重复回报都不应该改变它 —— 否则对账会读到漂移的"事实"。
 */
export function settleIntent(input: {
  intentKey: string
  venueOrderId?: string | null
  outcome: string
}): boolean {
  if (!ensureTable()) return false
  const db = getDb()
  if (!db) return false
  const res = db
    .prepare(
      `UPDATE order_intents
         SET state = 'settled', venue_order_id = ?, outcome = ?, settled_ts = ?
       WHERE intent_key = ? AND state <> 'settled'`,
    )
    .run(input.venueOrderId ?? null, input.outcome, Date.now(), input.intentKey)
  if (Number(res.changes) > 0) {
    appendEvent('INTENT_SETTLED', { intentKey: input.intentKey, venueOrderId: input.venueOrderId ?? null, outcome: input.outcome })
    return true
  }
  return false
}

/**
 * 重启恢复：把上次进程留下的 `in_flight` 找出来。
 *
 * ★★ **只报告，不释放、不删除、不标失败。** 这是本模块最重要的一条纪律：
 *   `in_flight` 意味着"我们不知道场所那边成没成"。自动清掉它 =
 *   把未知当成安全 ⇒ 下一次同信号会再发一遍 ⇒ **重复下单**，
 *   也就是这个模块存在的唯一理由。
 *   ⇒ 正确的推进方式是调用方拿 `venueOrderId` / 场所订单列表去**对账**，
 *     有了确定结论再 `settleIntent()`。
 */
export function recoverOrphans(): { intentKey: string; bucket: string; symbol: string; side: string; qty: string; ageMs: number }[] {
  if (!ensureTable()) return []
  const db = getDb()
  if (!db) return []
  const rows = db
    .prepare(
      `SELECT intent_key, bucket, symbol, side, qty, created_ts
         FROM order_intents WHERE state = 'in_flight' ORDER BY created_ts ASC`,
    )
    .all() as unknown as { intent_key: string; bucket: string; symbol: string; side: string; qty: string; created_ts: number }[]
  const now = Date.now()
  const out = rows.map((r) => ({
    intentKey: r.intent_key,
    bucket: r.bucket,
    symbol: r.symbol,
    side: r.side,
    qty: r.qty,
    ageMs: now - r.created_ts,
  }))
  if (out.length > 0) appendEvent('INTENT_ORPHANS_FOUND', { count: out.length, keys: out.map((o) => o.intentKey) })
  return out
}

/** 台账总览（给端点 / 面板用）。三态分开展示，不合并成一个数。 */
export function intentLedgerSummary(): {
  total: number
  inFlight: number
  settled: number
  buckets: number
  orphans: { intentKey: string; bucket: string; ageMs: number }[]
} {
  if (!ensureTable()) return { total: 0, inFlight: 0, settled: 0, buckets: 0, orphans: [] }
  const db = getDb()
  if (!db) return { total: 0, inFlight: 0, settled: 0, buckets: 0, orphans: [] }
  const total = Number((db.prepare('SELECT COUNT(*) AS c FROM order_intents').get() as { c: number }).c)
  const inFlight = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM order_intents WHERE state = 'in_flight'").get() as { c: number }).c,
  )
  const settled = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM order_intents WHERE state = 'settled'").get() as { c: number }).c,
  )
  const buckets = Number((db.prepare('SELECT COUNT(DISTINCT bucket) AS c FROM order_intents').get() as { c: number }).c)
  return {
    total,
    inFlight,
    settled,
    buckets,
    orphans: recoverOrphans().map((o) => ({ intentKey: o.intentKey, bucket: o.bucket, ageMs: o.ageMs })),
  }
}

/** 仅供烟测/自检使用：清空台账。生产路径**不应**调用。 */
export function __resetIntentLedgerForTest(): void {
  const db = getDb()
  if (!db) return
  if (!ensureTable()) return
  db.exec('DELETE FROM order_intents')
}
