/**
 * 组合风险预算原子预留层（内化 R20 `risk_reservation.py` 范式）
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────
 * 本项目历史上的 `LEDGER_MISMATCH` 有两类成因，预留层分别给出对策：
 *
 *   A. **本地追踪器一消失就当作仓位不存在。** 进程重启、适配器超时、
 *      订单状态未知时，本地记录被清掉，交易所侧仓位却还在。下一个周期
 *      引擎认为「空仓」，于是重复开仓，实际敞口翻倍。
 *      → 对策：**未知状态显式化**。`unknown` / `pending` / `partial` 一律
 *        全额占用预算，只有确认终态（rejected / closed）才释放。
 *        本地追踪器消失 **不等于** 交易所仓位消失。
 *
 *   B. **预算判断与占用写入之间有窗口。** 「查已用额度 → 判断够不够 → 写入」
 *      三步若不在同一个不可分割的临界区里，并发路径（多标的巡检、提案器与
 *      自治循环同时下单）会各自读到旧总额，双双通过检查，合计越界。
 *      → 对策：SQLite `BEGIN IMMEDIATE` 事务把三步包成原子操作，越界整体回滚，
 *        **绝不部分占用**。
 *
 * 另外补上 EVOLVE 缺失的第三个视角：**同环境跨所合看风险，但账户资金不混**
 * （`grossExposure` / `totalReservedByVenue`）。多链 DEX + CEX 并存时，
 * 单个所看着都在限额内，合计敞口却可能远超承受力。
 *
 * ── 与 R20 的差异 ───────────────────────────────────────────────────
 * R20 以 `(venue, environment, fingerprint)` 三元组做账户键；EVOLVE 的执行层
 * 目前只有「本地虚拟账本 / 场所账户」两级，去掉 fingerprint 维度会更贴合现状，
 * 但**保留三段键的解析器**——将来接入多 API Key 分账户时不必改数据模型。
 * 存储沿用 EVOLVE 已有的 `node:sqlite`（与 `persistence.ts` 同一技术选型），
 * 不引入新依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ─────────────────────────────────────────────────────────────
// 状态词表
// ─────────────────────────────────────────────────────────────

/** 待确认：意图已发出，尚无任何回执。 */
export const STATE_PENDING = 'pending'
/** 部分成交：一部分已成交，剩余部分状态未知。 */
export const STATE_PARTIAL = 'partial'
/** 未知：适配器超时 / 回执解析失败。**绝不能当作「没有持仓」**。 */
export const STATE_UNKNOWN = 'unknown'
/** 已确认成交：仍占用预算，直到平仓。 */
export const STATE_CONFIRMED = 'confirmed'
/** 已拒单（终态）。 */
export const STATE_REJECTED = 'rejected'
/** 已平仓（终态）。 */
export const STATE_CLOSED = 'closed'

/**
 * 占用态。注意 `confirmed` 也在其中——确认成交后到平仓前，占用必须持续存在，
 * 否则同一笔风险会被后续开仓重复计入可用额度。
 */
export const OCCUPYING_STATES: ReadonlySet<string> = new Set([
  STATE_PENDING,
  STATE_PARTIAL,
  STATE_UNKNOWN,
  STATE_CONFIRMED,
])

/** 终态：到达后释放预算，且**不可复活**。 */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([STATE_REJECTED, STATE_CLOSED])

/** 合法状态全集。 */
export const VALID_STATES: ReadonlySet<string> = new Set([...OCCUPYING_STATES, ...TERMINAL_STATES])

/**
 * 孤儿预留标记。进程重启恢复时，若一条占用中记录找不到对应的开放意图，
 * 只标记为 `pending_cleanup`，**仍然占用**，等待人工或对账器裁决。
 * 自动释放它，就等于默认「本地丢了 = 场所也没有」——正是成因 A 的复发。
 */
export const STATE_PENDING_CLEANUP = 'pending_cleanup'

export class ReservationError extends Error {}
export class ReservationExceeded extends ReservationError {}

// ─────────────────────────────────────────────────────────────
// 账户键
// ─────────────────────────────────────────────────────────────

export interface AccountParts {
  key: string
  venue: string
  environment: string
}

/**
 * 归一化账户键。接受 `{venue, environment, fingerprint?}` 对象、三段/两段元组，
 * 或 `"venue:environment[:fingerprint]"` 串。
 *
 * 无法解析时诚实返回空 venue/environment，**不猜、不冒充**——把未知标成已知
 * 是风控里最危险的静默失败。
 */
export function normalizeAccountKey(accountKey: unknown): AccountParts {
  const o = accountKey as { venue?: unknown; environment?: unknown; fingerprint?: unknown } | null
  if (o && typeof o === 'object' && 'venue' in o && 'environment' in o) {
    const venue = String(o.venue ?? '')
    const environment = String(o.environment ?? '')
    const fingerprint = String(o.fingerprint ?? '')
    return { key: `${venue}:${environment}:${fingerprint}`, venue, environment }
  }
  if (Array.isArray(accountKey) && (accountKey.length === 2 || accountKey.length === 3)) {
    const [venue, environment, fingerprint = ''] = accountKey.map(String)
    return { key: `${venue}:${environment}:${fingerprint}`, venue, environment }
  }
  const s = String(accountKey ?? '')
  const parts = s.split(':')
  if (parts.length === 2) return { key: `${s}:`, venue: parts[0], environment: parts[1] }
  if (parts.length === 3) return { key: s, venue: parts[0], environment: parts[1] }
  return { key: s, venue: '', environment: '' }
}

// ─────────────────────────────────────────────────────────────
// 快照类型
// ─────────────────────────────────────────────────────────────

export interface ReservationSnapshot {
  id: number
  accountKey: string
  venue: string
  environment: string
  intentId: string
  amountUsdt: number
  state: string
  released: boolean
  /** 是否仍占用预算（判据：released 标志，与 totalReserved 完全同源）。 */
  occupying: boolean
  /** 是否为孤儿预留：占用中但本地已无对应开放意图，等待对账裁决。 */
  isOrphan: boolean
  createdAt: string
  updatedAt: string
}

export interface RecoveryReport {
  /** 恢复时被标记为孤儿（占用中但无对应开放意图）的意图 ID */
  orphans: string[]
  /** 因缺少时间戳无法判定 TTL 的意图 ID */
  skippedNoTimestamp: string[]
  /** 恢复后仍在占用的预留条数 */
  activeCount: number
  /** 恢复后占用的预算合计 */
  activeTotal: number
}

// ─────────────────────────────────────────────────────────────
// 预留管理器
// ─────────────────────────────────────────────────────────────

const DDL = `CREATE TABLE IF NOT EXISTS risk_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL DEFAULT '',
  intent_id TEXT NOT NULL,
  amount_usdt REAL NOT NULL,
  state TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_key, intent_id)
)`

const DDL_IDX = `CREATE INDEX IF NOT EXISTS idx_reservations_active
  ON risk_reservations(account_key, released, state)`

export interface ReserveResult {
  snapshot: ReservationSnapshot
  /** 本次调用是否真的改变了状态（幂等命中时为 false） */
  changed: boolean
  /** 幂等命中原因，便于审计 */
  idempotentReason?: string
}

export class RiskReservationManager {
  private db: DatabaseSync
  /** 组合层总预算上限（USDT）。null 表示不限，交由单标的/单笔闸门约束。 */
  totalLimitUsdt: number | null
  readonly dbPath: string

  constructor(dbPath = join('data', 'risk_reservations.db'), totalLimitUsdt: number | null = null) {
    this.dbPath = dbPath
    this.totalLimitUsdt = totalLimitUsdt
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(DDL)
    this.db.exec(DDL_IDX)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 已关闭或未打开，忽略 */
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private activeTotalInTx(keyStr: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(amount_usdt), 0) AS t FROM risk_reservations WHERE account_key = ? AND released = 0')
      .get(keyStr) as { t: number } | undefined
    return Number(row?.t ?? 0)
  }

  private toSnapshot(row: Record<string, unknown>): ReservationSnapshot {
    const state = String(row.state)
    const released = Number(row.released) === 1
    return {
      id: Number(row.id),
      accountKey: String(row.account_key),
      venue: String(row.venue ?? ''),
      environment: String(row.environment ?? ''),
      intentId: String(row.intent_id),
      amountUsdt: Number(row.amount_usdt),
      state,
      released,
      // 「是否仍占用预算」的唯一判据就是 released 标志，而不是状态词表。
      // 曾经写成 `!released && OCCUPYING_STATES.has(state)`，结果被标记为孤儿
      // （pending_cleanup 不在 OCCUPYING_STATES 里）的记录金额仍计入
      // totalReserved，occupying 却报 false——台账与视图两套口径。
      // 这类分裂正是本模块存在的意义所在，不能自己制造一个。
      occupying: !released,
      /** 是否为孤儿（占用中但本地已无对应开放意图）。 */
      isOrphan: !released && state === STATE_PENDING_CLEANUP,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    }
  }

  /**
   * 原子预留 / 状态推进。
   *
   * 语义（与 R20 一致，逐条刻意设计）：
   *  - 新意图：状态必须是占用态，预算足够则插入；越界抛 `ReservationExceeded`，**整体回滚**；
   *  - 已存在且占用中：推进状态（confirmed 仍占用；rejected/closed 释放），
   *    金额变化时按**差额**重查上限；
   *  - 已释放（终态）的意图**不可复活**：后续调用原样返回当前记录。
   *
   * 幂等键是 `(accountKey, intentId)`：同一个交易意图被重复提交（网络重试、
   * 轮询重入）不会重复占用预算。
   */
  reserve(
    accountKey: unknown,
    intentId: string,
    amountUsdt: number,
    state: string,
    totalLimitUsdt?: number | null,
  ): ReserveResult {
    const st = String(state).trim().toLowerCase()
    if (!VALID_STATES.has(st)) {
      throw new ReservationError(`非法预留状态: "${String(state)}"，允许 ${[...VALID_STATES].sort().join('/')}`)
    }
    const amount = Number(amountUsdt)
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ReservationError('amount_usdt 必须是非负有限数')
    }
    const { key, venue, environment } = normalizeAccountKey(accountKey)
    const intent = String(intentId)
    if (!intent) throw new ReservationError('intentId 不可为空')

    const limit = totalLimitUsdt === undefined ? this.totalLimitUsdt : totalLimitUsdt
    const ts = this.now()

    // BEGIN IMMEDIATE：立刻取得写锁，而不是等到第一次写才升级。
    // 「读总额 → 判断 → 写」三步必须在同一把写锁下完成，否则并发下单会双双通过检查。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare('SELECT * FROM risk_reservations WHERE account_key = ? AND intent_id = ?')
        .get(key, intent) as Record<string, unknown> | undefined

      if (!row) {
        if (!OCCUPYING_STATES.has(st)) {
          throw new ReservationError(`新预留 ${intent} 的初始状态必须是占用态，收到 ${st}`)
        }
        if (limit !== null) {
          const cur = this.activeTotalInTx(key)
          // 1e-9 容差：金额经过浮点运算，不能用严格相等判越界
          if (cur + amount > Number(limit) + 1e-9) {
            throw new ReservationExceeded(
              `预算越界：已占 ${cur} + 新增 ${amount} > 上限 ${limit}（账户 ${key}）`,
            )
          }
        }
        this.db
          .prepare(
            `INSERT INTO risk_reservations
             (account_key, venue, environment, intent_id, amount_usdt, state, released, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(key, venue, environment, intent, amount, st, ts, ts)
      } else {
        const released = Number(row.released) === 1
        const prevState = String(row.state)
        if (released || TERMINAL_STATES.has(prevState)) {
          // 终态幂等：不复活、不改写。这里刻意不回滚事务也无写入，直接补一次 COMMIT。
          const snap = this.toSnapshot(row)
          this.db.exec('COMMIT')
          return { snapshot: snap, changed: false, idempotentReason: `意图 ${intent} 已处于终态 ${prevState}` }
        }
        // amount 为 0 表示「沿用原金额」，只推进状态
        const newAmount = amount > 0 ? amount : Number(row.amount_usdt)
        if (limit !== null) {
          const others = this.activeTotalInTx(key) - Number(row.amount_usdt)
          if (others + newAmount > Number(limit) + 1e-9) {
            throw new ReservationExceeded(
              `预算越界：其他占用 ${others} + 调整后 ${newAmount} > 上限 ${limit}（账户 ${key}）`,
            )
          }
        }
        if (TERMINAL_STATES.has(st)) {
          this.db
            .prepare('UPDATE risk_reservations SET amount_usdt = ?, state = ?, released = 1, updated_at = ? WHERE id = ?')
            .run(newAmount, st, ts, Number(row.id))
        } else {
          this.db
            .prepare('UPDATE risk_reservations SET amount_usdt = ?, state = ?, updated_at = ? WHERE id = ?')
            .run(newAmount, st, ts, Number(row.id))
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 事务可能已因错误自动回滚 */
      }
      throw e
    }

    const final = this.db
      .prepare('SELECT * FROM risk_reservations WHERE account_key = ? AND intent_id = ?')
      .get(key, intent) as Record<string, unknown>
    return { snapshot: this.toSnapshot(final), changed: true }
  }

  /** 显式释放（`reserve(..., 0, 终态)` 的语义糖）。只接受终态。 */
  release(accountKey: unknown, intentId: string, state: string = STATE_CLOSED): ReserveResult {
    if (!TERMINAL_STATES.has(state)) {
      throw new ReservationError(`release 只接受终态 ${[...TERMINAL_STATES].sort().join('/')}`)
    }
    return this.reserve(accountKey, intentId, 0, state)
  }

  /** 单个账户维度的当前占用合计（含 pending_cleanup 与 unknown）。 */
  totalReserved(accountKey: unknown): number {
    const { key } = normalizeAccountKey(accountKey)
    return this.activeTotalInTx(key)
  }

  /** 同环境按场所聚合的占用视图——「合看风险，不混资金」。 */
  totalReservedByVenue(environment: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT venue, SUM(amount_usdt) AS total FROM risk_reservations
         WHERE environment = ? AND released = 0 GROUP BY venue`,
      )
      .all(String(environment)) as Array<{ venue: string; total: number }>
    const out: Record<string, number> = {}
    for (const r of rows) out[String(r.venue ?? '')] = Number(r.total ?? 0)
    return out
  }

  /** 同环境跨场所聚合总敞口。多链多所并存时，这是唯一能看到真实总风险的视角。 */
  grossExposure(environment: string): number {
    const byVenue = this.totalReservedByVenue(environment)
    return Number(Object.values(byVenue).reduce((a, b) => a + b, 0).toFixed(10))
  }

  /** 预留快照列表（诊断用）。 */
  reservations(accountKey?: unknown): ReservationSnapshot[] {
    const rows = (
      accountKey === undefined
        ? this.db.prepare('SELECT * FROM risk_reservations ORDER BY id').all()
        : this.db
            .prepare('SELECT * FROM risk_reservations WHERE account_key = ? ORDER BY id')
            .all(normalizeAccountKey(accountKey).key)
    ) as Array<Record<string, unknown>>
    return rows.map((r) => this.toSnapshot(r))
  }

  /** 未释放预留明细（含时间戳，供周期对账器判 TTL）。只读、零副作用。 */
  listUnreleased(environment: string): ReservationSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM risk_reservations WHERE released = 0 AND environment = ? ORDER BY id')
      .all(String(environment)) as Array<Record<string, unknown>>
    return rows.map((r) => this.toSnapshot(r))
  }

  /**
   * 进程重启恢复：把「占用中但没有对应开放意图」的预留标记为孤儿。
   *
   * **只标记，不释放。** 自动释放等于断言「本地不知道 ⇒ 场所也没有」，
   * 而这正是账本错配的成因 A。真要让它们退出占用，必须由对账器拿到场所
   * 侧的确定结论（已拒单 / 已平仓）后再显式调 `release`。
   *
   * @param environment      限定环境；不传则恢复全部
   * @param openIntentIds    当前本地认为仍开放的意图 ID 集合
   */
  recoverOrphans(environment?: string, openIntentIds: Iterable<string> = []): RecoveryReport {
    const open = new Set([...openIntentIds].map(String))
    const rows = (
      environment === undefined
        ? this.db.prepare('SELECT * FROM risk_reservations WHERE released = 0').all()
        : this.db.prepare('SELECT * FROM risk_reservations WHERE released = 0 AND environment = ?').all(String(environment))
    ) as Array<Record<string, unknown>>

    const orphans: string[] = []
    const ts = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const intentId = String(row.intent_id)
        const state = String(row.state)
        // 已经是孤儿标记的不重复计数；已被本地视为开放的跳过
        if (state === STATE_PENDING_CLEANUP || open.has(intentId)) continue
        orphans.push(intentId)
        this.db
          .prepare('UPDATE risk_reservations SET state = ?, updated_at = ? WHERE id = ?')
          .run(STATE_PENDING_CLEANUP, ts, Number(row.id))
      }
      this.db.exec('COMMIT')
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 已回滚 */
      }
      throw e
    }

    const after = (
      environment === undefined
        ? this.db.prepare('SELECT * FROM risk_reservations WHERE released = 0').all()
        : this.db.prepare('SELECT * FROM risk_reservations WHERE released = 0 AND environment = ?').all(String(environment))
    ) as Array<Record<string, unknown>>

    const activeTotal = after.reduce((a, r) => a + Number(r.amount_usdt ?? 0), 0)
    return {
      orphans,
      skippedNoTimestamp: after.filter((r) => !r.created_at).map((r) => String(r.intent_id)),
      activeCount: after.length,
      activeTotal: Number(activeTotal.toFixed(10)),
    }
  }

  /** 清空全部预留（仅测试与「重置账本」使用，会同时清掉孤儿标记）。 */
  reset(): void {
    this.db.exec('DELETE FROM risk_reservations')
  }
}

// ─────────────────────────────────────────────────────────────
// 进程级单例
// ─────────────────────────────────────────────────────────────

let singleton: RiskReservationManager | null = null

/**
 * 取进程级预留管理器。
 *
 * 为什么必须是单例而不是每处 new 一个：预留层的全部价值建立在
 * 「所有人看同一本台账」之上。自治循环、对账器、订单网关各持一份实例时，
 * 各自的内存视图会漂移，越界检查就形同虚设。这里刻意只暴露 getter，
 * 不提供 `createReservationManager` 之外的注入路径。
 */
export function getReservationManager(): RiskReservationManager {
  if (!singleton) {
    const dbPath = process.env.EV_RESERVATION_DB ?? join('data', 'risk_reservations.db')
    const limitRaw = process.env.EV_PORTFOLIO_RISK_BUDGET_USDT
    const limit = limitRaw ? Number(limitRaw) : null
    singleton = new RiskReservationManager(dbPath, Number.isFinite(limit as number) ? (limit as number) : null)
  }
  return singleton
}

/** 切换/重置单例（测试用）。传 null 会关闭并释放当前实例。 */
export function setReservationManager(m: RiskReservationManager | null): void {
  if (singleton && singleton !== m) singleton.close()
  singleton = m
}
