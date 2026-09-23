/**
 * 自治循环 —— 让舰队按周期自己干活
 *
 * ── 这一层治的是什么 ────────────────────────────────────────────────
 * 用户实测反馈的原话是「连一键启动自治循环都启动不了」。在那之前，
 * 舰队虽然接了真实执行路径，但**只有人工点按钮和语音说一句这两条触发方式** ——
 * 系统不会自己动。一个"必须有人戳一下才动"的舰队，和一个定时脚本没有区别。
 *
 * ── 为什么自治循环里只允许「可逆」动作自动跑 ─────────────────────────
 * 「一键启动自治循环」意味着用户把**周期性发起动作**的权利交给了系统。
 * 这类授权的危险不在"跑得对不对"，而在"跑错了能不能退回来"。所以这里按
 * **可逆 / 不可逆**分档，而不是按"重要 / 不重要"分：
 *   · 可逆（把文件移进 `.trash/`，随时能拿回来）⇒ 允许自动跑；
 *   · 不可逆（真删、下单、改源码）⇒ 循环里**只报告，不动手**，由人确认。
 * 这条不是保守，是本项目付过代价的：一次批量删会让随后所有构建**假红**，
 * 表现是"一个毫不相关的门禁突然崩了，而它上次跑是绿的"。
 *
 * ── 为什么是 setTimeout 链而不是 setInterval ─────────────────────────
 * 循环里的成员有 `slow` 档（分钟级全量评估）。`setInterval` 在任务比周期还慢时
 * 会把回调**堆叠**起来 —— 上一轮还没跑完，下一轮已经开始，账本里出现交错的
 * 同一任务多份记录。改成"这一轮跑完再排下一轮"（`setTimeout` 链），
 * 慢任务只是把周期顺延，不会叠加。
 *
 * ── 为什么时钟与执行器都要可注入 ─────────────────────────────────────
 * 判据 5：「这个状态/分支真可能发生吗？能用真实数据构造出来吗？」——
 * 周期默认是小时级，测试若不能换时钟，就只能断言"启动成功"这种废话。
 * 注入 `now` / `setTimer` 之后，测试可以让 6 小时的周期在毫秒内走完，
 * 从而真的断言"到期会跑、跑完会排下一次、停掉之后不再跑"。
 */
import { appendEvent, getEvents } from '../ledger.ts'
import { poolSnapshot } from '../llmPool.ts'
import {
  LOCK_HEARTBEAT_MS,
  acquireEvolutionLock,
  heartbeatEvolutionLock,
  releaseEvolutionLock,
  __resetEvolutionLockForTest,
} from '../evolutionLock.ts'

export interface AutonomyJob {
  id: string
  label: string
  /** 周期。 */
  everyMs: number
  /** 第一次触发的延迟，默认等于 period —— 启动瞬间不该把所有任务一起打出去。 */
  initialDelayMs: number
  /** 交给 `runTask` 的目标句。**必须是 `planTask` 真能接住的说法**（有断言钉住）。 */
  goal: string
  /** 自动跑这一项的理由，以及它的动作可不可逆。 */
  why: string
  /** 这一项的动作是否可逆。不可逆的不许进自动循环。 */
  reversible: boolean
  /**
   * 这一项要不要用大模型。
   *
   * ★ 它唯一的用途是**额度感知**：账号池全爆的时候，需要模型的任务跑起来
   *   只会得到一次注定失败的调用，然后把失败写进账本 —— 看起来像"这一项坏了"。
   *   标了 `true` 的任务在额度耗尽时会被**跳过并说明**（`AUTONOMY_TICK_SKIPPED`），
   *   不标的任务照跑（挖因子、清理、巡检都不依赖模型，额度爆了也该继续干活）。
   *
   * ★ 判据是"这一项**能不能**在没有模型的情况下产出有用的东西"，
   *   而不是"它内部会不会调到模型"。含混的结果是额度爆的那一天整个循环全停。
   */
  needsModel?: boolean
  /**
   * 这一项要不要**占进化单飞锁**（同一时刻只允许一轮进化在跑）。
   *
   * ★ 判据是"这一项会不会**写共享产物**"：
   *   · 写因子台账 / 策略台账 / `data/learn/notes.jsonl` / 移动项目根文件 ⇒ `true`
   *   · **纯只读**（巡检四个成员全只读）⇒ `false`
   *
   * ★ 为什么巡检不占锁：它一个字节都不写，占锁只会让一次慢的挖因子
   *   把巡检一起挡住 —— 那会把"只读的观察"降级成"看情况能不能观察"。
   *   锁要保护的**只有写者**。
   */
  evolution?: boolean
}

export const HOUR = 3_600_000

/**
 * 循环里登记的周期性任务。
 *
 * ★ 每一项的 `goal` 都必须是**已登记的舰队任务计划**能接住的说法。
 *   这里若写一句 `planTask` 听不懂的话，循环会每周期安静地失败一次 ——
 *   而"安静地失败"正是本仓库最贵的一类缺陷。`test:fleet` 用 `planTask(job.goal)`
 *   逐条断言它接得住。
 */
export const AUTONOMY_JOBS: readonly AutonomyJob[] = [
  {
    id: 'factor_mine',
    label: '挖一轮因子（扩空间 → 筛选 → 判达标）',
    everyMs: 12 * HOUR,
    initialDelayMs: 2 * 60_000,
    goal: '扩候选基因空间，再筛选测试',
    why: '每一轮都按"扩空间 → 过策略门 → 看还差什么"跑，自己决定要不要换窗口组。动作写台账，可被判据复核。',
    reversible: true,
    // 写因子台账 + 策略台账，且是 5 项里最慢的（分钟级）⇒ 必须占锁。
    evolution: true,
  },
  {
    id: 'hygiene',
    label: '文件体检 + 可逆清理',
    everyMs: 6 * HOUR,
    initialDelayMs: 90_000,
    goal: '清理垃圾',
    why: '把项目根的临时取证产物移进 .trash/（可随时取回），并报出 .trash 里已经过保留期的部分交人确认。移动可逆，所以允许自动。',
    reversible: true,
    // 会 rename 项目根的文件 —— 与"正在写临时产物的挖因子"叠在一起会互相踩。
    evolution: true,
  },
  {
    id: 'self_learn',
    label: '给自己学习一轮',
    everyMs: 8 * HOUR,
    initialDelayMs: 5 * 60_000,
    goal: '给自己学习一轮',
    why: '读账本与心法现状，交给模型产改进提案并落盘。**只产提案，不改源码** —— 改码是不可逆动作，必须人工确认。',
    reversible: true,
    needsModel: true,
    // 与 news_watch 写**同一份** data/learn/notes.jsonl ⇒ 必须互斥。
    evolution: true,
  },
  {
    // ★ 用户明确要求的"定时任务：主动推送新闻、主动学习并内化"。
    //   周期取 6 小时：再密就是重复读同一批（源里最近 14 天的东西变化没这么快），
    //   再疏就会错过当天的动静 —— 而"当天读到了什么"正是这个功能的全部价值。
    id: 'news_watch',
    label: '读一轮新闻并写内化提案',
    everyMs: 6 * HOUR,
    initialDelayMs: 3 * 60_000,
    goal: '读新闻，有值得内化的就写提案',
    why:
      '读 GitHub 搜索与网页搜索（都是实测可达的源），按确定性规则挑出与本系统相关的信号，' +
      '再交给模型写内化提案，落进与自学习**同一份** data/learn/notes.jsonl。' +
      '抓取与去重不依赖模型（额度爆了照做），只有"写方案"那一步要模型 —— ' +
      '那一步被跳过时它会明说，因为"今天没学习"与"学了没问题"在账本上不能长得一样。',
    reversible: true,
    needsModel: true,
    // 与 self_learn 写同一份 notes.jsonl ⇒ 必须互斥。
    evolution: true,
  },
  {
    id: 'status',
    label: '系统巡检',
    everyMs: 4 * HOUR,
    initialDelayMs: 60_000,
    goal: '系统巡检',
    why: '四个只读成员各查一角（闸门 / 决策样本 / 心法 / 磁盘），只读不写。',
    reversible: true,
  },
]

export interface AutonomyJobState {
  id: string
  label: string
  everyMs: number
  goal: string
  reversible: boolean
  why: string
  runCount: number
  okCount: number
  failCount: number
  /**
   * 「到期了但**故意没跑**」的次数。
   *
   * ★ 为什么要单独一列，而不是记进 `failCount`：跳过与失败指向**完全相反**的动作
   *   （跳过 = 等额度回来；失败 = 这一项坏了要去查）。混在一起的话，
   *   额度爆掉的那一天账本上会显示"自学习连失败 3 次"，
   *   而实际上系统一件事都没做错。判据 29：必须分得清"能力没有"与"额度用完了"。
   */
  skippedCount: number
  /**
   * 「到期了，但**被进化单飞锁挡下**」的次数。
   *
   * ★ 为什么不并进 `skippedCount`：两者在界面上都长成"这一项没跑"，
   *   但指向的动作**不同** ——
   *     · 额度跳（`skippedCount`）= 账号池全爆了，**该去加账号**；
   *     · 单飞挡（这一列）= 另一轮进化正常在跑，**什么都不用做**，等下一轮就好。
   *   混在一起的话，"正常互斥"会被读成"系统老是跑不动"（判据 C5）。
   */
  deferredCount: number
  lastRunAt: number | null
  lastOk: boolean | null
  /** 最近一句产出（来自 `runTask` 的凭据）。 */
  lastSummary: string | null
  /** 下一次触发时刻。停机时为 null —— null 不是"马上"，是"没有排程"。 */
  nextAt: number | null
}

export interface AutonomyStatus {
  running: boolean
  /** 这个循环一共被启动过几次。0 = 从来没启动过（不是"一直没在跑"）。 */
  startCount: number
  startedAt: number | null
  stoppedAt: number | null
  stopReason: string | null
  /** 已经真的触发过的轮数（每跑一项算一轮）。 */
  ticks: number
  jobs: AutonomyJobState[]
  /** 时钟现在几点了（`now` 注入进来，便于对照 nextAt）。 */
  now: number
  /** 为什么现在没在跑。running=true 时为 null。 */
  idleReason: string | null
}

/** `runTask` 的最小契约。**只依赖这个形状**，不 import service.ts —— 否则成环。 */
export interface AutonomyRunner {
  (goal: string, opts: { confirmed: boolean; dryRun?: boolean }): Promise<{ ok: boolean; summary: string }>
}

export interface AutonomyDeps {
  run: AutonomyRunner | null
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
}

let deps: AutonomyDeps = {
  run: null,
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

let runner: AutonomyRunner | null = null

/**
 * 装配执行器。放在模块顶层由 `service.ts` 调用（单向依赖：service → autonomy）。
 * ★ 不在这里 `import { runTask }` 的原因：`agents.ts` 要 import 本模块来提供
 *   「启停自治循环」这个成员，而 `agents.ts` 又被 `service.ts` import ——
 *   直接 import 会成环。注入把这条边拆掉了。
 */
export function bindAutonomyRunner(r: AutonomyRunner | null): void {
  runner = r
  deps.run = r
}

/** 仅供测试：换掉时钟与定时器，让小时级周期在毫秒内走完。 */
export function __setAutonomyDepsForTest(d: Partial<AutonomyDeps>): void {
  deps = { ...deps, ...d }
}

export function __resetAutonomyDepsForTest(): void {
  deps = {
    run: runner,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
}

// ─────────────────────────── 状态 ───────────────────────────

interface JobRuntime {
  job: AutonomyJob
  runCount: number
  okCount: number
  failCount: number
  skippedCount: number
  deferredCount: number
  lastRunAt: number | null
  lastOk: boolean | null
  lastSummary: string | null
  nextAt: number | null
  timer: unknown
}

let running = false
let startCount = 0
let startedAt: number | null = null
let stoppedAt: number | null = null
let stopReason: string | null = null
let ticks = 0
const runtimes = new Map<string, JobRuntime>()

function runtimeOf(job: AutonomyJob): JobRuntime {
  const found = runtimes.get(job.id)
  if (found) return found
  const fresh: JobRuntime = {
    job,
    runCount: 0,
    okCount: 0,
    failCount: 0,
    skippedCount: 0,
    deferredCount: 0,
    lastRunAt: null,
    lastOk: null,
    lastSummary: null,
    nextAt: null,
    timer: null,
  }
  runtimes.set(job.id, fresh)
  return fresh
}

/** 允许测试/调用方换一份任务表（默认 `AUTONOMY_JOBS`）。 */
function jobsIn(override?: readonly AutonomyJob[]): readonly AutonomyJob[] {
  return override ?? AUTONOMY_JOBS
}

/**
 * 跑一项任务。**失败必须留痕**：只记 ok/fail 而不记原因，会让
 * "上游没配好"和"这一项本身坏了"长得一模一样。
 */
async function fire(rt: JobRuntime): Promise<void> {
  const now = deps.now()
  rt.lastRunAt = now
  ticks += 1

  // ★★ 额度感知：需要模型的任务在**账号池全爆**时跳过，并说明原因。
  //   不这么做的话它每周期都会跑一次注定失败的调用，账本里留下一条"失败" ——
  //   而用户据此会去查一个根本没坏的东西。跳过与失败指向相反的动作（判据 29），
  //   所以用独立的事件与独立的计数器。
  if (rt.job.needsModel) {
    const pool = poolSnapshot(now)
    if (pool.allExhausted) {
      rt.skippedCount += 1
      rt.lastOk = null
      rt.lastSummary = `本次没跑：这一项需要模型，但${pool.speech}`
      appendEvent('AUTONOMY_TICK_SKIPPED', { job: rt.job.id, reason: 'QUOTA', detail: pool.speech })
      return
    }
  }

  if (!deps.run) {
    rt.runCount += 1
    rt.failCount += 1
    rt.lastOk = false
    rt.lastSummary = '自治循环没有装配执行器（bindAutonomyRunner 未被调用），所以这一轮没跑。'
    appendEvent('AUTONOMY_TICK_FAILED', { job: rt.job.id, reason: 'NO_RUNNER' })
    return
  }

  // ★★ 进化单飞锁（日报内化 #3）：同一时刻只允许一轮**会写共享产物**的进化在跑。
  //   `setTimeout` 链只保证"同一项不和自己重叠"，不保证**不同项之间**不重叠 ——
  //   `factor_mine` 没跑完时 `self_learn` 到期，两者会一起改台账 / notes.jsonl。
  //   三态各自走不同的路，互不顶替（理由见 evolutionLock.ts 文件头）。
  let heldLock: string | null = null
  let hbTimer: ReturnType<typeof setInterval> | null = null
  if (rt.job.evolution) {
    const got = acquireEvolutionLock(rt.job.id, now)
    if (got.kind === 'busy') {
      // 别人正在跑 ⇒ **跳过**，不是失败。它指向的动作是"等下一轮，什么都不用查"。
      rt.deferredCount += 1
      rt.lastOk = null
      rt.lastSummary = `本次没跑：进化单飞锁在「${got.task}」手里（pid ${got.pid}，持锁 ${Math.round(got.ageMs / 1000)} 秒）`
      appendEvent('AUTONOMY_TICK_DEFERRED', {
        job: rt.job.id,
        reason: 'SINGLE_FLIGHT',
        heldBy: got.task,
        heldByPid: got.pid,
        ageMs: got.ageMs,
      })
      return
    }
    if (got.kind === 'unverifiable') {
      // 判不了。★ 这里**刻意不 fail-closed**（与 intentLedger 相反，理由见 evolutionLock.ts）：
      //   拦的是可逆周期任务，误放代价可观察；而因持久层坏了让自进化整体停摆，
      //   代价是"系统静默不动" —— 那正是用户抱怨过的那件事。所以照跑，但留痕。
      appendEvent('AUTONOMY_TICK_LOCK_UNVERIFIABLE', { job: rt.job.id, reason: got.reason })
    } else {
      heldLock = got.task
      // 长任务必须续心跳，否则一个**正常**的分钟级任务会被别人判成"持有者已死"抢走。
      hbTimer = setInterval(() => {
        heartbeatEvolutionLock(rt.job.id)
      }, LOCK_HEARTBEAT_MS)
      hbTimer.unref?.()
    }
  }

  try {
    // ★ `confirmed: true` 的理由**只**是"这一项登记时被声明为可逆"。
    //   自动跑不可逆动作的授权不存在 —— 那种事必须回到人手里。
    const r = await deps.run(rt.job.goal, { confirmed: true })
    rt.runCount += 1
    rt.lastOk = r.ok
    rt.lastSummary = r.summary
    if (r.ok) rt.okCount += 1
    else rt.failCount += 1
    appendEvent('AUTONOMY_TICK', {
      job: rt.job.id,
      goal: rt.job.goal,
      ok: r.ok,
      summary: r.summary.slice(0, 300),
      reversible: rt.job.reversible,
    })
  } catch (e) {
    rt.runCount += 1
    rt.failCount += 1
    rt.lastOk = false
    const msg = e instanceof Error ? e.message : String(e)
    rt.lastSummary = `这一轮抛了异常：${msg}`
    appendEvent('AUTONOMY_TICK_FAILED', { job: rt.job.id, reason: msg.slice(0, 300) })
  } finally {
    // ★ 释放放 `finally`：任务抛异常时如果不释放，锁会一直挂到 15 分钟陈旧线才被接管，
    //   期间所有进化项全部被挡 —— 一个异常会把自进化停摆一刻钟。
    if (hbTimer) clearInterval(hbTimer)
    if (heldLock) releaseEvolutionLock(heldLock)
  }
}

function schedule(rt: JobRuntime, delayMs: number): void {
  rt.nextAt = deps.now() + delayMs
  rt.timer = deps.setTimer(() => {
    // 先清掉 nextAt：进入执行时它已经不再代表"下一次"了。
    // 留在那里会让面板显示"下次 3 秒后"，而那一轮其实正在跑。
    rt.nextAt = null
    void fire(rt).then(() => {
      if (running) schedule(rt, rt.job.everyMs)
    })
  }, delayMs)
}

export interface StartAutonomyResult {
  ok: boolean
  reason?: string
  status: AutonomyStatus
}

/** 一键启动自治循环。重复启动是**幂等**的，并且会如实说"本来就在跑"。 */
export function startAutonomy(opts: { jobs?: readonly AutonomyJob[]; reason?: string } = {}): StartAutonomyResult {
  if (running) {
    return { ok: false, reason: 'ALREADY_RUNNING', status: autonomyStatus() }
  }
  const jobs = jobsIn(opts.jobs)
  if (jobs.length === 0) {
    return { ok: false, reason: 'NO_JOBS', status: autonomyStatus() }
  }
  // ★ 不可逆的任务**不许**进自动循环。这是这里唯一一条硬拦截，
  //   拦在启动处而不是执行处：启动时就该说清楚，而不是跑到了才发现。
  const bad = jobs.find((j) => !j.reversible)
  if (bad) {
    return { ok: false, reason: `IRREVERSIBLE_JOB:${bad.id}`, status: autonomyStatus() }
  }
  running = true
  startCount += 1
  startedAt = deps.now()
  stoppedAt = null
  stopReason = null
  for (const j of jobs) schedule(runtimeOf(j), j.initialDelayMs)
  appendEvent('AUTONOMY_STARTED', {
    jobs: jobs.map((j) => j.id),
    reason: opts.reason ?? '用户启动',
  })
  return { ok: true, status: autonomyStatus() }
}

/**
 * 自治循环该不该**开机就起来**。
 *
 * ── 为什么默认是"开" ──────────────────────────────────────────────────
 * 用户的原话是「自循环需要长开」。在那之前它默认关闭，只有人说一句才动 ——
 * 而"必须有人戳一下才动"正是上一轮被抱怨的那件事的另一种形式。
 *
 * ── 为什么仍然留一个明确的关停开关 ────────────────────────────────────
 * 循环里有会消耗模型额度的任务（自学习 / 新闻内化）。开发时想让它安静，
 * 或者临时想省额度，都需要一个**说得出口**的方式，而不是去改代码。
 *
 * ★ 开关的默认值取反：只有 `off` / `0` / `false` / `no` 才算关，
 *   **其余任何值都是开**（含写错的值）。这条不是随意的——两个方向的错误代价不对称：
 *   · 以为开了其实关着 ⇒ 系统整天不动，而面板上"运行中"是假的（最坏的那一种）
 *   · 以为关了其实开着 ⇒ 它会照周期干活并留下记录，很快就会被发现
 *   所以默认落在"会留下记录"的那一侧。
 *   （`EV_AUTONOMY` 与 `.env` 里其它键同名，进程级覆盖有效：见 loadEnv.ts。）
 */
export function autonomyAutoStartWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.EV_AUTONOMY ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

export interface AutostartResult {
  started: boolean
  reason: 'STARTED' | 'ALREADY_RUNNING' | 'DISABLED_BY_ENV' | 'FAILED'
  detail?: string
  status: AutonomyStatus
}

/**
 * 开机自启。**幂等** —— 重复调用只会如实说"本来就在跑"。
 *
 * ★ 它必须在**编排层的启动序列**里被显式调用一次（见 `server/index.ts`）。
 *   不做成"import 本模块就自动执行"的原因：那会让一次 import 产生副作用，
 *   而烟测 import 本模块时就会意外把整个循环跑起来（判据 1：这种副作用
 *   一旦存在，"启动"这件事就没有任何输入能把它与"import"分开）。
 */
export function autostartAutonomy(env: NodeJS.ProcessEnv = process.env): AutostartResult {
  if (!autonomyAutoStartWanted(env)) {
    return { started: false, reason: 'DISABLED_BY_ENV', detail: 'EV_AUTONOMY 被显式关掉了', status: autonomyStatus() }
  }
  const r = startAutonomy({ reason: '开机自启（EV_AUTONOMY 默认常开）' })
  if (r.ok) return { started: true, reason: 'STARTED', status: r.status }
  if (r.reason === 'ALREADY_RUNNING') return { started: false, reason: 'ALREADY_RUNNING', status: r.status }
  return { started: false, reason: 'FAILED', detail: r.reason, status: r.status }
}

export function stopAutonomy(reason: string): AutonomyStatus {
  if (!running) return autonomyStatus()
  running = false
  stoppedAt = deps.now()
  stopReason = reason
  for (const rt of runtimes.values()) {
    if (rt.timer !== null) deps.clearTimer(rt.timer)
    rt.timer = null
    // 停机后 nextAt 必须是 null。留着一个过去的时刻，面板会显示
    // "下次触发：3 分钟前" —— 一个自相矛盾的读数。
    rt.nextAt = null
  }
  appendEvent('AUTONOMY_STOPPED', { reason })
  return autonomyStatus()
}

export function autonomyStatus(): AutonomyStatus {
  const jobs = [...runtimes.values()].map((rt) => ({
    id: rt.job.id,
    label: rt.job.label,
    everyMs: rt.job.everyMs,
    goal: rt.job.goal,
    reversible: rt.job.reversible,
    why: rt.job.why,
    runCount: rt.runCount,
    okCount: rt.okCount,
    failCount: rt.failCount,
    skippedCount: rt.skippedCount,
    deferredCount: rt.deferredCount,
    lastRunAt: rt.lastRunAt,
    lastOk: rt.lastOk,
    lastSummary: rt.lastSummary,
    nextAt: rt.nextAt,
  }))
  return {
    running,
    startCount,
    startedAt,
    stoppedAt,
    stopReason,
    ticks,
    jobs,
    now: deps.now(),
    idleReason: running ? null : stopReason ?? (startCount === 0 ? '从来没有启动过' : '已停止'),
  }
}

/**
 * 循环自己的取证：从账本读"自治循环真的跑过哪些轮"。
 *
 * ★ 为什么不直接信 `autonomyStatus()`：进程重启后内存里的计数器会归零，
 *   而账本不会。面板要回答"它到底干过活没有"，这个问题的答案只能来自账本 ——
 *   与本项目其它成员"状态从账本现算"是同一条纪律。
 */
export interface AutonomyTick {
  job: string
  ok: boolean
  summary: string
  reversible: boolean
  at: number
  failedOnly?: string
  /**
   * 这一轮是"到期了但**故意没跑**"（额度爆了）。
   *
   * ★ 与 `failedOnly` 分开是有意的：两者在界面上都表现为"这一项没干成"，
   *   但一个要等额度（什么都不用做），另一个要去查这一项（必须动手）。
   */
  skippedOnly?: string
  /**
   * 这一轮是"到期了但**被进化单飞锁挡下**"。
   *
   * ★ 与 `skippedOnly`（额度）分开：两者都表现为"这一项没跑"，
   *   但一个要等额度回来，另一个**什么都不用做**（另一轮进化正常在跑）。
   */
  deferredOnly?: string
}

export function autonomyTicks(limit = 20): AutonomyTick[] {
  const out: AutonomyTick[] = []
  for (const e of getEvents(0)) {
    if (e.kind === 'AUTONOMY_TICK') {
      const p = e.payload as Record<string, unknown>
      out.push({
        job: String(p.job ?? '?'),
        ok: p.ok === true,
        summary: String(p.summary ?? ''),
        reversible: p.reversible === true,
        at: e.ts,
      })
    } else if (e.kind === 'AUTONOMY_TICK_FAILED') {
      const p = e.payload as Record<string, unknown>
      out.push({ job: String(p.job ?? '?'), ok: false, summary: String(p.reason ?? ''), reversible: false, at: e.ts, failedOnly: String(p.reason ?? '') })
    } else if (e.kind === 'AUTONOMY_TICK_SKIPPED') {
      const p = e.payload as Record<string, unknown>
      const detail = String(p.detail ?? p.reason ?? '')
      out.push({ job: String(p.job ?? '?'), ok: false, summary: `本次没跑：${detail}`, reversible: true, at: e.ts, skippedOnly: detail })
    } else if (e.kind === 'AUTONOMY_TICK_DEFERRED') {
      const p = e.payload as Record<string, unknown>
      const by = String(p.heldBy ?? '?')
      const detail = `进化单飞锁在「${by}」手里`
      out.push({ job: String(p.job ?? '?'), ok: false, summary: `本次没跑：${detail}`, reversible: true, at: e.ts, deferredOnly: detail })
    }
  }
  return out.slice(-limit)
}

/** 仅供测试：把内存状态清干净（不动账本）。 */
export function __resetAutonomyForTest(): void {
  stopAutonomy('test reset')
  runtimes.clear()
  running = false
  startCount = 0
  startedAt = null
  stoppedAt = null
  stopReason = null
  ticks = 0
  // ★ 单飞锁住在 SQLite 里，不清的话上一条用例的持锁会漏给下一条
  //   （表现是"第二组测试莫名其妙全被挡住"，且看不出是谁持有的）。
  __resetEvolutionLockForTest()
}
