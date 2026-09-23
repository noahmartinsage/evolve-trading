/**
 * 免费模型账号池 —— 「一个账号的额度打满了，就换下一个账号」
 *
 * ── 这一层治的是什么 ────────────────────────────────────────────────
 * 实测反馈的原话是「免费模型额度打满，一个免费模型额度打满换新的免费模型，
 * 我多给配一些账号」。上一轮做到的是**说清**额度用完了（`quota` 三态），
 * 但系统当时只有一个账号 —— 说清之后仍然什么也做不了，用户还得等明天。
 *
 * 这里补的是另一半：**账号是一个池**。某个账号当天额度爆了，就把它挪到一边，
 * 换池里下一个继续干活；全都爆了才轮到"等明天"那句话出场。
 *
 * ── 为什么"额度爆了"必须按账号记，而不是按模型名记 ──────────────────
 * 这两个事因长得极像（都表现为"候选全部失败"），却指向**相反的动作**：
 *   · 模型名烂了 ⇒ 该换名单（`modelRouter.deadUntil` 记的正是这个，10 分钟）
 *   · 账号额度爆了 ⇒ 该换账号（本模块记的，**当天有效**）
 * 混淆的代价是实测付过的：上一轮探针原文写着 `HTTP 429 free-models-per-day`，
 * 而回话却让用户"重跑探针看是哪个名字烂掉了"。所以两个判据各记一份、各有时效，
 * 并且**永不共用一张表**（判据 24：要主动去找那个会让结论一模一样的另一种事因）。
 *
 * ── 为什么复位时间是"次日零点"而不是"10 分钟后" ──────────────────────
 * 免费额度是按**天**给的（`free-models-per-day`）。用固定 TTL 会造出两个坏行为：
 *   · TTL 太短 ⇒ 当天反复去撞一个已经爆掉的账号，每一次都白等一次往返；
 *   · TTL 太长 ⇒ 额度已经回来了（次日）却仍然不用它，白放着一条可用通道。
 * 所以复位时刻取**次日零点**，而且到期是**惰性判定**（读取时才比时间），
 * 不依赖任何定时器 —— 系统没在跑的时候时间也在走，这一点不该需要进程参与。
 *
 * ── 为什么要把"今天哪个账号爆了"落盘 ─────────────────────────────────
 * 只记在内存里的话，**每次重启都会重新撞一遍已经爆掉的账号**（重启在开发期很频繁）。
 * 用户看到的是"启动后第一句话总是慢一拍且失败一次"。落盘之后，重启也记得。
 * ★ 落盘失败**不许影响主流程** —— 额度记账是优化，不是业务。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { listAccounts, maskKey, type ActiveLlm } from './llmProviders.ts'

/**
 * 429 / 配额类原文的公共形状。各家的措辞不同，所以只按**可观测的字符串**认。
 *
 * ★ 判据只写一份：`modelRouter`（决定换不换账号）与 `voice/model`（决定怎么说）
 *   都从这里 import。写两份的后果是"一处认为该换账号、另一处认为该换名单"，
 *   而那正是本模块开头记着的那次实测失误。
 *
 * ★ `ACCOUNT_EXHAUSTED` 是**我们自己**发出的记号：路由层在"所有账号今天都爆了"
 *   时会把这句话写进 reason。它必须算进额度类 —— 否则这条结论会被上层判成
 *   `no-candidate-worked`，回话就变成"去重跑探针看哪个名字烂了"，方向完全反了
 *   （判据 24：另一种事因会让结论长得一模一样，要主动去堵它）。
 */
export const QUOTA_RE = /HTTP 429|free-models-per-day|Rate limit|rate_limit|quota|额度|ACCOUNT_EXHAUSTED/i

/** 一次账号耗尽的记账。 */
export interface AccountExhaustion {
  accountId: string
  reason: string
  /** 什么时候爆的。 */
  at: number
  /** 什么时候可以再试（次日零点）。 */
  until: number
  /** 当天被撞到几次（>1 说明有调用方绕过了池子，值得看一眼）。 */
  hits: number
}

/**
 * 池里的一个账号。
 *
 * ★ 它**就是** `ActiveLlm`（路由层要拿它原样去发请求），只多一个 `createdTs` 用来定顺序。
 *   不另造一个平行类型的原因：平行类型会让"池里选出来的账号"与"路由真正发请求用的账号"
 *   成为两个形状，中间必须做一次字段搬运 —— 而搬运点正是**字段名写错、静默变 undefined**
 *   最容易发生的地方（本项目已经踩过一次）。
 */
export interface PoolAccount extends ActiveLlm {
  createdTs: number
}

/** 面板/语音要看的账号状态。**必须能回答"现在到底有几个能用"**。 */
export interface AccountState {
  id: string
  name: string
  keyHint: string
  model: string
  exhausted: boolean
  reason: string | null
  until: number | null
  hits: number
  /** 人话：这个账号现在什么处境。 */
  note: string
}

export interface PoolSnapshot {
  /** 池子里一共几个账号（已启用、且有模型名）。 */
  total: number
  /** 现在能用几个。 */
  ready: number
  /**
   * **池里每一个账号**（不只是爆掉的那些）。
   *
   * ★ 这一列是实测逼出来的：只有 `exhausted` 的时候，"我新加的那把 key 到底认到没有"
   *   没有任何出口可以回答 —— 池子安静的时候它返回一个空数组，而那既可能是
   *   "两个账号都好好的"，也可能是"我配的 key 根本没被读进来"。
   *   两者指向**相反的动作**（什么都不用做 vs 去查配置），却长得一模一样（判据 24）。
   */
  accounts: AccountState[]
  exhausted: AccountState[]
  /** 最早一个账号恢复的时刻；全都没爆时为 null（null 不是"永远"）。 */
  nextRecoveryAt: number | null
  /** 全都爆了。**这才是"该等明天"成立的唯一条件**。 */
  allExhausted: boolean
  /** 可念的一句话。 */
  speech: string
  now: number
}

// ─────────────────────────── 记账 ───────────────────────────

const exhaustions = new Map<string, AccountExhaustion>()

/**
 * 次日零点（本地时间）。
 *
 * ★ 用本地时间而不是 UTC：额度是**按发放方的天**算的，而用户看到的
 *   也是本地时间。写成 UTC 会让"明天恢复"落在本地下午 8 点，
 *   面板上的倒计时与用户的直觉差 8 小时（本机 GMT+8）。
 */
export function nextDayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 这个账号现在是不是"爆着"。到期惰性清除 —— 时间过了就是回来了。 */
export function isExhausted(accountId: string, now = Date.now()): boolean {
  const e = exhaustions.get(accountId)
  if (!e) return false
  if (now >= e.until) {
    // 到期即忘：留着一条已经过期的记录，会让面板显示"已耗尽"而实际上能用。
    exhaustions.delete(accountId)
    persistState()
    return false
  }
  return true
}

/**
 * 记一次失败。返回**这次失败是否导致该账号被记为"今天别用它了"**。
 *
 * 只有额度类原文才算 —— 网络抖动、模型名写错都不该让一个账号整天停用
 * （那是把"临时"当"当天"，代价是真有一条能用的通道被闲置）。
 */
export function noteAccountFailure(accountId: string, reason: string, now = Date.now()): boolean {
  if (!QUOTA_RE.test(reason)) return false
  const prev = exhaustions.get(accountId)
  const until = nextDayStart(now)
  const hits = (prev && now < prev.until ? prev.hits : 0) + 1
  exhaustions.set(accountId, { accountId, reason: reason.slice(0, 200), at: now, until, hits })
  persistState()
  return true
}

/** 供运维/面板读取：现在被记为"今天爆了"的账号。 */
export function exhaustedSnapshot(now = Date.now()): AccountExhaustion[] {
  return [...exhaustions.values()].filter((e) => now < e.until)
}

// ─────────────────────── 选账号 ───────────────────────

/** 池里所有"可用账号"（已启用 + 有 activeModel）。 */
export function poolAccounts(): PoolAccount[] {
  return listAccounts()
    .filter((p) => p.enabled && p.activeModel)
    .map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      flavor: p.flavor,
      model: p.activeModel as string,
      createdTs: p.createdTs,
    }))
}

/**
 * 按"该先用谁"排好序的账号链。
 *
 * ★ 未耗尽的排在前面，耗尽的**排在最后而不是删掉**。
 *   删掉的后果是"全部耗尽 ⇒ 候选链为空 ⇒ 理由变成 `NO_PROVIDER`"，
 *   而 `NO_PROVIDER` 的下一步是"去配厂商"—— 完全错的方向（判据 24）。
 *   留着它们，失败链里就会带着 `ACCOUNT_EXHAUSTED` 这条真原因。
 */
export function pickAccounts(now = Date.now()): { ready: PoolAccount[]; exhausted: PoolAccount[] } {
  const all = poolAccounts().sort((a, b) => a.createdTs - b.createdTs)
  const ready: PoolAccount[] = []
  const dead: PoolAccount[] = []
  for (const a of all) (isExhausted(a.id, now) ? dead : ready).push(a)
  return { ready, exhausted: dead }
}

/** 账号池现状。给面板、语音、自治循环三处共用（判据只写一份）。 */
export function poolSnapshot(now = Date.now()): PoolSnapshot {
  const { ready } = pickAccounts(now)
  const states: AccountState[] = []
  for (const a of poolAccounts()) {
    const e = exhaustions.get(a.id)
    const dead = isExhausted(a.id, now)
    states.push({
      id: a.id,
      name: a.name,
      keyHint: maskKey(a.apiKey),
      model: a.model,
      exhausted: dead,
      reason: dead ? (e?.reason ?? '额度类失败') : null,
      until: dead ? (e?.until ?? null) : null,
      hits: dead ? (e?.hits ?? 0) : 0,
      note: dead
        ? `${a.name}（${maskKey(a.apiKey)}）今天额度已用尽：${(e?.reason ?? '').slice(0, 60)}`
        : `${a.name}（${maskKey(a.apiKey)}）可用`,
    })
  }
  const allExhausted = states.length > 0 && ready.length === 0
  const untils = exhaustedSnapshot(now)
    .map((e) => e.until)
    .sort((a, b) => a - b)
  return {
    total: states.length,
    ready: ready.length,
    accounts: states,
    exhausted: states.filter((s) => s.exhausted),
    nextRecoveryAt: untils.length > 0 ? untils[0] : null,
    allExhausted,
    speech: poolSpeech(states.length, ready.length, untils[0] ?? null),
    now,
  }
}

/** 池子现状的人话。**三种条数分明**（没配 / 还有能用 / 全爆了）。 */
export function poolSpeech(total: number, ready: number, nextRecoveryAt: number | null): string {
  if (total === 0) return '我手上一个模型账号都没有 —— 这是通道没配，不是额度问题。'
  if (ready > 0) return `模型账号还有 ${ready} 个能用（一共 ${total} 个）。`
  const when = nextRecoveryAt
    ? new Date(nextRecoveryAt).toLocaleString('zh-CN', { hour12: false })
    : '明天'
  return `池子里 ${total} 个账号的免费额度今天都用完了，${when} 会自动恢复。多配几个账号（见 .env 里的 EV_LLM_ACCOUNTS）就能继续跑。`
}

// ─────────────────────── 落盘 ───────────────────────

/**
 * 状态文件的位置。
 *
 * ★ 可注入的原因：烟测必须能在**临时目录**里跑，否则测试会去读/写**真实的**池状态
 *   （把开发机上"某账号今天爆过"这件事带进测试，或反过来把测试的假状态写脏生产）。
 *   这是本项目在临时台账上已经用过一次的做法。
 */
let statePath: string | null = null

export function bindPoolStatePath(p: string | null): void {
  statePath = p
  loadState()
}

function defaultStatePath(): string {
  return join(process.cwd(), 'data', 'llm-pool.json')
}

function pathOf(): string | null {
  return statePath ?? defaultStatePath()
}

interface PersistedPool {
  v: 1
  exhaustions: AccountExhaustion[]
}

function loadState(): void {
  const p = pathOf()
  if (!p || !existsSync(p)) return
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as PersistedPool
    if (parsed?.v !== 1 || !Array.isArray(parsed.exhaustions)) return
    exhaustions.clear()
    const now = Date.now()
    // ★ 过期的直接不进内存：读进来再惰性清，等于让"昨天的爆"在启动瞬间假装还在。
    for (const e of parsed.exhaustions) if (e && e.accountId && now < e.until) exhaustions.set(e.accountId, e)
  } catch {
    /* 坏文件当没有：额度记账是优化，不是业务 */
  }
}

function persistState(): void {
  const p = pathOf()
  if (!p) return
  try {
    mkdirSync(dirname(p), { recursive: true })
    const body: PersistedPool = { v: 1, exhaustions: exhaustedSnapshot() }
    writeFileSync(p, JSON.stringify(body, null, 2), 'utf8')
  } catch {
    /* 落盘失败不许影响业务 */
  }
}

/** 仅供测试：清空记账（不动文件）。 */
export function __resetPoolForTest(): void {
  exhaustions.clear()
}

/** 供测试直接读原始记录（断言"复位时刻是不是次日零点"要用）。 */
export function __rawExhaustions(): AccountExhaustion[] {
  return [...exhaustions.values()]
}
