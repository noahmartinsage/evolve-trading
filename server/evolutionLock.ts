/**
 * 进化单飞锁 —— 「同一时刻只允许一轮进化在跑」
 *
 * ══ 这一层治的是什么 ═══════════════════════════════════════════════
 * 内化日报第 ③ 条（R20 §6.3 的 `fcntl.flock(LOCK_EX|LOCK_NB)` 语义）。
 * 本仓的自治循环登记了 5 项周期任务，其中 4 项会**写共享产物**：
 *   · `factor_mine`  写因子台账 / 策略台账（分钟级，最慢）
 *   · `self_learn`   写 `data/learn/notes.jsonl`
 *   · `news_watch`   写**同一份** `data/learn/notes.jsonl`
 *   · `hygiene`      移动项目根的临时产物
 * 而循环**只保证"同一个任务不会和自己重叠"**（`setTimeout` 链），
 * **不保证不同任务之间不重叠** —— `factor_mine` 还没跑完，`self_learn` 就到期了，
 * 两者会同时改台账。协作式并发在这里是无效的：它们不共享内存、也不 `await` 对方。
 *
 * ══ 为什么复用 SQLite，而不是引一把锁库（判据 D3）═══════════════════
 * 「同一业务动作只许有一条规矩」。本仓已经有一张 `instance_fence` 表在用
 * 「pid 存活 + 心跳新鲜度」判持有者死活（`persistence.ts:claimInstance`），
 * 那套判据在这里**完全适用**。再引一个第三方锁库会长出第二份判据，
 * 而两份判据迟早对不上。
 *
 * ══ ★★ 但**不能**照抄 `instance_fence` 的"同 pid 就刷新"逻辑 ═════════
 * `claimInstance()` 判的是**单例**（整台机器只许一个 orchestration 进程），
 * 所以它把 `row.pid === process.pid` 当作"就是我自己，刷新时间戳"——
 * 这在那里的语义下是对的。
 *
 * 这里的语义是**互斥**：要挡的恰恰是**同一个进程里的另一个任务**。
 * 若照抄那一句，`factor_mine` 持有锁时 `self_learn` 进来会看到
 * `row.pid === process.pid` ⇒ 判成"自己的锁" ⇒ **拿到锁并覆盖持有者** ——
 * 锁从此形同虚设，而且**任何测试都不会红**（因为动作确实都跑了）。
 * ⇒ 判据是**任务名**，不是 pid。pid 只用来判"持有者还活着吗"。
 *
 * ══ 三态，互不顶替（判据 C5 / ㉚ 四态互不顶替的精神）═════════════════
 *   · `acquired`    → 拿到，正常跑
 *   · `busy`        → **别人正在跑**。调用方该**跳过并说明**（`AUTONOMY_TICK_DEFERRED`）
 *                     —— 它指向的动作是"等下一轮"，**什么都不用查**。
 *   · `unverifiable`→ 台账不可用，**根本没法判**。调用方该**照跑但留痕**。
 *
 * ★ `busy` 与 `unverifiable` 在界面上都表现为"这一项没跑"，但指向**相反**的动作
 *   （一个是正常现象，一个是持久层坏了）。混成一个就必然把人引向错的方向。
 *
 * ★ 为什么 `unverifiable` 不 fail-closed（与 `intentLedger` 相反）：
 *   `intentLedger` 拦的是**下单**，误放的代价是真金白银，所以没有台账就不许下单。
 *   这里拦的是**可逆的周期任务**（循环里只允许可逆动作），误放的代价是
 *   "两轮进化叠了一次"——可观察、可重跑、不伤资金。而反过来，
 *   因为持久层不可用就让整个自进化停摆，代价是**系统静默不动**，
 *   那正是用户抱怨过的"必须有人戳一下才动"。两侧代价不对称，故选照跑 + 留痕。
 */
import { getDb } from './persistence.ts'
import { appendEvent } from './ledger.ts'

/** 心跳间隔：持有者每 30 秒续一次。 */
export const LOCK_HEARTBEAT_MS = 30_000

/**
 * 陈旧线：心跳超过这么久没续 + pid 已不存在 ⇒ 判持有者已死，接管。
 *
 * ★★ 阈值不许与"正常耗时"同量级（判据 D8：那样它不是保护，是一颗随机地雷）。
 *   实测正常耗时：`factors:screen` 一次 **164 秒**（`_fs.txt`），`forecast:run` 7 秒。
 *   最慢的那一项是分钟级 ⇒ 给 **15 分钟**（约为实测最慢值的 5 倍）。
 *   持有者存活时每 30 秒续心跳，所以这条线只在**真的死了**的时候才会到。
 */
export const LOCK_STALE_MS = 15 * 60_000

export type LockDecision =
  | { kind: 'acquired'; task: string }
  /** 别人正在跑。`task` 是**谁**在跑 —— 只说"有人"是没用的，要能指名。 */
  | { kind: 'busy'; task: string; pid: number; since: number; ageMs: number }
  /** 判不了（持久层不可用）。**不许当成拿到了，也不许当成忙**。 */
  | { kind: 'unverifiable'; reason: string }

interface FlightRow {
  task: string
  pid: number
  started_at: number
  heartbeat: number
}

function ensureTable(): boolean {
  const db = getDb()
  if (!db) return false
  db.exec(
    'CREATE TABLE IF NOT EXISTS evolution_flight (' +
      'id INTEGER PRIMARY KEY CHECK(id=1), ' +
      'task TEXT NOT NULL, pid INTEGER NOT NULL, ' +
      'started_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL)',
  )
  return true
}

/** 持有者还活着吗。★ 只用来判存活，**不参与"是不是我的"判定**（见文件头）。 */
function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 尝试拿锁。**原子性**靠"单条 `INSERT ... ON CONFLICT DO NOTHING` + `changes`"，
 * 不做"先读再写"（那中间有窗口，两个任务会同时认为自己拿到了）。
 */
export function acquireEvolutionLock(taskId: string, nowMs: number = Date.now()): LockDecision {
  if (!ensureTable()) {
    return { kind: 'unverifiable', reason: '持久层不可用（initPersistence 未跑或 ORCH_DB 打不开）' }
  }
  const db = getDb()!

  const row = db.prepare('SELECT task, pid, started_at, heartbeat FROM evolution_flight WHERE id=1').get() as
    | FlightRow
    | undefined

  if (row) {
    const ageMs = nowMs - row.heartbeat
    const expired = !pidAlive(row.pid) || ageMs >= LOCK_STALE_MS
    if (!expired) {
      // ★ 这里**刻意不看** row.pid === process.pid —— 同进程的另一个任务正是要挡的对象。
      return { kind: 'busy', task: row.task, pid: row.pid, since: row.started_at, ageMs }
    }
    // 接管前必须留痕：否则"我抢了别人的锁"这件事没有任何人知道，
    // 而"上一轮进化为什么没跑完"会永远查不出来（判据 C9：拿到证据前不许写原因）。
    db.prepare('DELETE FROM evolution_flight WHERE id=1').run()
    appendEvent('EVOLUTION_LOCK_STOLEN', {
      task: taskId,
      fromTask: row.task,
      fromPid: row.pid,
      heartbeatAgeMs: ageMs,
      pidGone: !pidAlive(row.pid),
      staleAfterMs: LOCK_STALE_MS,
    })
  }

  const res = db
    .prepare(
      'INSERT INTO evolution_flight (id, task, pid, started_at, heartbeat) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
    )
    .run(taskId, process.pid, nowMs, nowMs)

  if (Number(res.changes) === 0) {
    // 竞态：在我们读与写之间别人插进去了。**如实说忙，不许重试到拿到为止**。
    const again = db.prepare('SELECT task, pid, started_at, heartbeat FROM evolution_flight WHERE id=1').get() as
      | FlightRow
      | undefined
    if (again) {
      return { kind: 'busy', task: again.task, pid: again.pid, since: again.started_at, ageMs: nowMs - again.heartbeat }
    }
    return { kind: 'unverifiable', reason: '插入被拒但读不到持有者（台账状态异常）' }
  }

  appendEvent('EVOLUTION_LOCK_ACQUIRED', { task: taskId, pid: process.pid })
  return { kind: 'acquired', task: taskId }
}

/**
 * 续心跳。长任务在跑的时候必须周期性调用它 ——
 * 否则一个正常的分钟级任务会被误判成"持有者已死"而被别人抢走。
 * ★ 只更新**确实是自己的**那一行（按 task + pid 双条件），
 *   不做"无条件覆盖"——那会把别人的锁改成自己的。
 */
export function heartbeatEvolutionLock(taskId: string, nowMs: number = Date.now()): boolean {
  const db = getDb()
  if (!db) return false
  try {
    const res = db
      .prepare('UPDATE evolution_flight SET heartbeat = ? WHERE id=1 AND task = ? AND pid = ?')
      .run(nowMs, taskId, process.pid)
    return Number(res.changes) > 0
  } catch {
    return false
  }
}

/**
 * 释放。★ 同样带 `task = ?` 条件：锁被抢走过之后（stale 接管），
 * 原来那个持有者回来释放时**不许**把新持有者的锁删掉。
 */
export function releaseEvolutionLock(taskId: string): boolean {
  const db = getDb()
  if (!db) return false
  try {
    const res = db.prepare('DELETE FROM evolution_flight WHERE id=1 AND task = ? AND pid = ?').run(taskId, process.pid)
    const freed = Number(res.changes) > 0
    if (freed) appendEvent('EVOLUTION_LOCK_RELEASED', { task: taskId })
    return freed
  } catch {
    return false
  }
}

export interface LockSnapshot {
  /** 有台账才谈得上"现在锁在谁手里"。false ⇒ 下面全是 null，不是"没人持有"。 */
  readable: boolean
  task: string | null
  pid: number | null
  since: number | null
  heartbeatAgeMs: number | null
  /** 按当前心跳算，多久之后会被判为陈旧。`null` = 读不到。 */
  staleInMs: number | null
}

/** 给面板/巡检看的一眼读法。★ `readable:false` 时不许退化成"没人持有"。 */
export function evolutionLockSnapshot(nowMs: number = Date.now()): LockSnapshot {
  if (!ensureTable()) {
    return { readable: false, task: null, pid: null, since: null, heartbeatAgeMs: null, staleInMs: null }
  }
  const row = getDb()!.prepare('SELECT task, pid, started_at, heartbeat FROM evolution_flight WHERE id=1').get() as
    | FlightRow
    | undefined
  if (!row) {
    return { readable: true, task: null, pid: null, since: null, heartbeatAgeMs: null, staleInMs: null }
  }
  const age = nowMs - row.heartbeat
  return {
    readable: true,
    task: row.task,
    pid: row.pid,
    since: row.started_at,
    heartbeatAgeMs: age,
    staleInMs: Math.max(0, LOCK_STALE_MS - age),
  }
}

/**
 * 仅供测试：清干净。
 * ★ 刻意**不挂任何端点** —— 一个"把锁清掉"的接口就是一个绕过互斥的后门。
 */
export function __resetEvolutionLockForTest(): void {
  const db = getDb()
  if (!db) return
  try {
    db.prepare('DELETE FROM evolution_flight').run()
  } catch {
    /* 表可能还不存在 */
  }
}
