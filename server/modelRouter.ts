/**
 * 模型分层路由 —— 贵 / 免费分层 + 智能降级（内化自 2026-09-14 日报第 ⑤ 条 OmniRoute）。
 *
 * 日报的原话是「统一接入多厂商、智能降级、贵免费分层」。落到 EVOLVE 上，
 * 要解决的是一件具体的事：**决策大脑里不同环节愿意为智能付的钱差很多**。
 *   · 规划类（策略提案、复盘心法提炼）—— 值得用贵模型
 *   · 机械类（结构化抽取、格式化、摘要）—— 免费模型足够，用贵的纯属浪费
 *   · 探测类（连通性、模型列表）—— 必须永远免费，它是"还能不能用"的探针
 *
 * ── 本模块最看重的一条设计：**未识别的模型按付费处理** ──────────────
 * "免费"的判定天然是启发式的：模型名五花八门（`:free` 后缀、`-free` 后缀、
 * 厂商自定的额度套餐……），任何白名单都会漏。而漏判的两个方向代价完全不对称：
 *   · 把付费误判成免费 → 静默烧钱，等到账单出来才发现
 *   · 把免费误判成付费 → 少用了一个便宜档位，只是不够省
 * 所以默认取**保守侧**：认不出就当付费。付费需要显式开关（`EV_LLM_ALLOW_PAID`），
 * 默认关闭 —— 与项目「风控默认拒绝」的哲学一致。
 *
 * ── 降级链为什么要落审计 ────────────────────────────────────────────
 * "这次用了哪个模型"直接决定产出的可信度。若降级是静默的，
 * 事后看到一份质量下降的策略提案，无法区分是"策略本身不成熟"
 * 还是"其实跑在降级后的免费模型上"。所以每次路由都留痕。
 */

import { appendEvent } from './ledger.ts'
import { getActiveLlm, lastLlmHttpFailure } from './llmProviders.ts'
import type { ActiveLlm, LlmHttpFailure } from './llmProviders.ts'
// ★ 账号池：某个账号当天额度爆了 ⇒ 换下一个账号，而不是把整条链判死。
//   依赖方向是单向的（modelRouter → llmPool → llmProviders），没有环。
import { isExhausted, nextDayStart, noteAccountFailure, pickAccounts, poolSnapshot, poolSpeech } from './llmPool.ts'
// ★ 「Model-visible means logged」（内化自 2026-09-19 日报 ① DeepSeek Harness）：
//   凡到达模型的内容必须能从日志重建。这份日志与账本分工不同 ——
//   账本记"发生了什么"，它记"模型看到了什么、回了什么"。
import { buildEntry, recordCall, type LlmJournalEntry } from './llmJournal.ts'
// ★ 已验证名单是"列在 /models 里 ≠ 能回话"这条教训的落点。
//   不要在这里就地写一串模型名 —— 名单必须带验证日期与验证方式（见 llmCatalog.ts）。
import { CATALOG_VERIFIED_AT, catalogAgeDays, preferredModelChain, VERIFIED_TEXT_MODELS, VERIFIED_VISION_MODELS } from './llmCatalog.ts'

export type ModelTier = 'plan' | 'execute' | 'probe'

export const MODEL_TIERS: { id: ModelTier; label: string; desc: string }[] = [
  { id: 'plan', label: '规划', desc: '策略提案、复盘心法提炼等需要强推理的环节。' },
  { id: 'execute', label: '执行', desc: '结构化抽取、格式化、摘要等机械环节，免费模型足够。' },
  { id: 'probe', label: '探测', desc: '连通性与能力探测。永远不占用付费额度。' },
]

/**
 * 「免费」判定：保守启发式。认不出即为付费。
 *
 * 为什么不做白名单：模型名由各厂商自由命名，白名单漏一个就等于把它当付费
 * （安全但白费一个档位）；而**反向**错误（把付费当免费）会静默烧钱。
 * 一个只认显式免费标记的规则，两个方向的错误都落在"安全"那一侧。
 */
export function isFreeModel(modelName: string): boolean {
  const m = modelName.toLowerCase()
  return m.includes('free') || m.includes('local') || m.endsWith(':0')
}

/** 路由结果的一次尝试。 */
export interface RouteAttempt {
  model: string
  free: boolean
  ok: boolean
  reason?: string
  latencyMs: number
  /**
   * 这次尝试打在**哪个账号**上。
   *
   * ★ 同一个模型名可能存在于两个账号里，而失败原因完全不同（一个是额度爆了、
   *   另一个是这个模型在它这儿没有）。没有这一列，失败链读起来就是
   *   "同一个模型失败了三次"，而实际是"三个账号各失败了一次" —— 判据 12。
   */
  account?: string
}

export interface RouteResult {
  ok: boolean
  tier: ModelTier
  model: string | null
  text: string | null
  attempts: RouteAttempt[]
  /** 是否发生了降级（首个候选未成功）。 */
  degraded: boolean
  reason: string
}

/** 每小时允许的付费调用次数上限。0 = 完全禁止付费（默认）。 */
function paidHourlyCap(): number {
  const v = Number(process.env.EV_LLM_PAID_HOURLY_CAP ?? 0)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

function allowPaid(): boolean {
  return (process.env.EV_LLM_ALLOW_PAID ?? '0') === '1'
}

/** 环境变量里配置的候选模型链（逗号分隔）。未配置时返回空数组。 */
function configuredModels(tier: ModelTier): string[] {
  const key = `EV_LLM_TIER_${tier.toUpperCase()}_MODELS`
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 已验证名单**只对它的东家有效**。
 *
 * 名单里的 id（`nex-agi/nex-n2.5-pro:free` 之类）是 OpenRouter 的命名空间。
 * 把它们发给 DeepSeek 官方端点只会得到 400 —— 而那个 400 会以"某个模型失败"
 * 的形式混进尝试链里，让真正的失败原因（厂商本身挂了）变得难认。
 * 所以先看厂商是不是那一家，不是就不加这段候选。
 *
 * ★ 参数类型是 `{ baseUrl: string }` 而不是 `ActiveLlm`：本函数只读 baseUrl，
 *   而调用方要传的是**池里的账号**（`PoolAccount`）。收窄到真正用到的形状，
 *   调用方就不必为了类型匹配去凑一个完整的 provider 对象。
 */
function catalogFor(provider: { baseUrl: string }, needVision: boolean): string[] {
  if (!/openrouter\.ai/i.test(provider.baseUrl)) return []
  return preferredModelChain(needVision)
}

/**
 * 刚失败过的模型，短时间内不再试。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 上面那条"候选链逐个试"在没有记忆的时候，每次调用都会先撞一次已经死掉的模型。
 * opencode 那次故障里，`Model is unavailable` 是**稳定复现**的（不是抖动），
 * 而每次都要先花 0.4~1.2 秒撞一次才轮到能用的那个。
 * 单次无所谓，但桌宠是交互路径：用户每一句话都先等一秒撞墙。
 *
 * 记 10 分钟而不是永久：模型可能只是临时下线，永久拉黑会让"厂商恢复了"
 * 这件事永远不被发现。到期自动重试是唯一能自愈的做法。
 */
const DEAD_TTL_MS = 10 * 60_000
/**
 * 暂时拉黑的键是 **`账号 + 模型`**（用 NUL 分隔）。
 *
 * ★ 早先这里只存模型名。加上账号池之后那样就是错的：账号 A 上某个模型 429 了，
 *   会把账号 B 上**同一个模型名**一起拉黑 —— 而"这家不行换那家"正是账号池的全部意义。
 *   键里带账号之后，两类失败各停各的。
 */
const deadUntil = new Map<string, number>()

/** 拉黑键。**唯一出处** —— 写入与判定必须用同一个函数，手拼字符串迟早写错一处。 */
function deadKey(accountId: string, model: string): string {
  return accountId + '\u0000' + model
}

/** 从拉黑键拆回可读的模型名（面板要显示人话，不能显示 NUL 分隔的内部键）。 */
function deadKeyModel(key: string): string {
  const i = key.indexOf('\u0000')
  return i >= 0 ? key.slice(i + 1) : key
}

/** 判断一次失败值不值得记成"这个模型暂时别试了"。 */
function isDeadly(reason: string | undefined): boolean {
  if (!reason) return false
  return (
    /Model is unavailable|not support|No endpoints found|FreeTierError|Insufficient account funds|HTTP 40[234]|CALL_FAILED/.test(
      reason,
    )
  )
}

function isDead(model: string, now: number): boolean {
  const t = deadUntil.get(model)
  if (t === undefined) return false
  if (now >= t) {
    deadUntil.delete(model)
    return false
  }
  return true
}

/** 测试用：清空"刚失败过"的记忆。 */
export function __resetDeadModelsForTest(): void {
  deadUntil.clear()
}

/** 供运维/面板读取：现在被暂时拉黑的模型。`account` 为空 = 老格式（不带账号）的遗留键。 */
export function deadModelsSnapshot(now = Date.now()): { model: string; account: string | null; until: number }[] {
  return [...deadUntil.entries()]
    .filter(([, t]) => t > now)
    .map(([key, until]) => {
      const i = key.indexOf('\u0000')
      return { model: deadKeyModel(key), account: i >= 0 ? key.slice(0, i) : null, until }
    })
}


// ── 付费额度计时窗口（滚动 1 小时）────────────────────────────────
let paidWindow: number[] = []

/** 记录一次付费调用。 */
function notePaidCall(now: number): void {
  paidWindow = paidWindow.filter((t) => now - t < 3_600_000)
  paidWindow.push(now)
}

function paidUsedInWindow(now: number): number {
  paidWindow = paidWindow.filter((t) => now - t < 3_600_000)
  return paidWindow.length
}

/** 仅供测试/运维读取的额度快照。 */
export function paidQuotaSnapshot(now = Date.now()): { used: number; cap: number; allowed: boolean } {
  return { used: paidUsedInWindow(now), cap: paidHourlyCap(), allowed: allowPaid() }
}

/** 测试用：重置额度窗口（生产代码不应调用）。 */
export function __resetPaidWindowForTest(): void {
  paidWindow = []
}

export interface RouterDeps {
  provider: ActiveLlm | null
  /**
   * 账号链（未耗尽的在前，耗尽的在最后）。
   *
   * ★ 为什么是"链"而不是"一个 provider"：这是本轮的核心改动。原实现只认
   *   `getActiveLlm()` 给出的**第一个**账号 —— 那个账号额度爆了，整条路就断了，
   *   而池子里可能还有别的账号。现在逐个账号试，爆掉的换下一个。
   *
   * ★ 显式传 `provider`（含传 `null`）时**不读池子**：烟测要靠这一点构造
   *   "没有任何厂商"的输入（判据 5：分支能用真实数据构造出来）。
   */
  accounts?: ActiveLlm[]
  /** 注入的调用实现。生产为 llmProviders.chatCompleteParts；测试注入桩。 */
  call: (
    active: ActiveLlm,
    systemPrompt: string,
    parts: LlmContentPart[],
    temperature: number,
  ) => Promise<string | null>
  now: () => number
  /**
   * 取"最近一次 HTTP 失败"。生产 = `llmProviders.lastLlmHttpFailure`。
   *
   * ★ **必须可注入**：否则"HTTP 非 200 的原因会不会被带进 attempt.reason"
   *   这条判据在测试里**永远喂不到**（判据 1），也就没人能证明它会变红。
   */
  lastHttpFailure?: () => LlmHttpFailure | null
  /** 账号额度记账。生产 = `llmPool.noteAccountFailure`；可注入以便断言"换账号真的发生了"。 */
  noteFailure?: (accountId: string, reason: string) => void
  /**
   * 池快照。生产 = `llmPool.poolSnapshot`。
   *
   * ★ 为什么也要可注入：`NO_PROVIDER` 与 `ACCOUNTS_ALL_EXHAUSTED` 这两句话的
   *   分岔要能**在测试里构造出来**（判据 5），否则"没有账号"与"账号全爆了"
   *   谁是红的取决于**跑测试那台机器今天有没有把额度用光** —— 一条会随环境变色的判据，
   *   比没有判据更坏（判据 2：对正确的输入报错）。
   */
  poolSnapshot?: () => { total: number; ready: number; allExhausted: boolean; speech: string }
  /**
   * 日志写入口。生产 = `llmJournal.recordCall(process.cwd(), e)`。
   *
   * ★ 可注入的理由：烟测要在**临时目录**里断言"这条调用被记下来了、
   *   而且能从记录重建当次的输入"。写进真实 `data/llm-journal/` 会让
   *   "测试有没有跑过"这件事混进生产取证里。
   */
  journal?: (e: LlmJournalEntry) => void
}

/** 路由层不关心"多模态"这件事本身，只需要一个能表达它的话筒。 */
export type LlmContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * 组装依赖。
 *
 * ★ 关键判据：**调用方有没有显式说"用哪个账号"**。
 *   · 说了（`provider` 出现在 deps 里，哪怕值是 null）⇒ 就按它来，**一次都不去读池子**。
 *     这让"没有任何厂商"这个分支在测试里可构造（`provider: null` ⇒ `NO_PROVIDER`）。
 *   · 没说 ⇒ 从**账号池**现算一条链：未耗尽的在前，耗尽的排在最后
 *     （排在最后而不是删掉，理由见 `llmPool.pickAccounts` 的注释）。
 */
function defaultDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  const base: RouterDeps = {
    provider: null,
    accounts: [],
    call: async (active, systemPrompt, parts, temperature) => {
      const mod = await import('./llmProviders.ts')
      return mod.chatCompleteParts(active, systemPrompt, parts, temperature)
    },
    now: () => Date.now(),
    lastHttpFailure: () => lastLlmHttpFailure(),
    noteFailure: (id, reason) => {
      noteAccountFailure(id, reason)
    },
    poolSnapshot: () => poolSnapshot(),
    journal: (e) => {
      recordCall(process.cwd(), e)
    },
  }
  if ('provider' in overrides) {
    return {
      ...base,
      ...overrides,
      accounts: overrides.accounts ?? (overrides.provider ? [overrides.provider] : []),
    }
  }
  const { ready, exhausted } = pickAccounts()
  // ★ 顺序要紧：`overrides` 展开后**不能**再无条件覆盖 `accounts`。
  //   否则"只注入账号链、不注入 provider"的调用方（烟测就是这么写的）
  //   会被悄悄换成真实环境的账号池 —— 而这条路径的红绿会随跑测试那台机器
  //   今天有没有配账号而变（判据 2：对正确的输入报错）。
  const accounts = overrides.accounts ?? [...ready, ...exhausted]
  return { ...base, ...overrides, accounts, provider: getActiveLlm() }
}

/**
 * 按层级路由一次对话调用。
 *
 * 候选顺序 = 「该层配置的模型链」→「**已验证名单**（仅当厂商是名单的东家）」→「厂商当前激活模型（兜底）」。
 * 逐个尝试，第一个成功即返回；全部失败返回 ok:false 并把每次尝试都带回去 ——
 * **失败也要返回完整尝试链**，否则"为什么没成功"只能靠猜。
 *
 * ★ 已验证名单插在中间，是为了治实测的那次故障：厂商的 `/models` 返回 200
 *   并列了 63 个模型，其中激活的那一个上游已经下线。有了这段，
 *   即使 activeModel 是坏的，也还有一条**被真调过**的路可走。
 */
export async function routeChat(
  tier: ModelTier,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.7,
  deps: Partial<RouterDeps> = {},
): Promise<RouteResult> {
  return routeParts(tier, systemPrompt, [{ type: 'text', text: userPrompt }], temperature, deps)
}

/**
 * 带附件的路由（图片/文档）。`needVision` 为真时优先走视觉档。
 *
 * ★ 视觉档与文本档分开，是因为它们的**失败方式不同**：文本模型收到图
 *   会回 404 `No endpoints found that support image input`（明确），
 *   而某些标着支持图片的模型会回 200 **但答错内容**（隐蔽）。
 *   后者只有靠"答对颜色才算能读图"这条判据才拦得住 —— 判据在 `vision-probe.ts`。
 */
export async function routeMultimodal(
  tier: ModelTier,
  systemPrompt: string,
  parts: LlmContentPart[],
  temperature = 0.7,
  deps: Partial<RouterDeps> = {},
): Promise<RouteResult> {
  const needVision = parts.some((p) => p.type === 'image_url')
  return routeParts(tier, systemPrompt, parts, temperature, deps, needVision)
}

async function routeParts(
  tier: ModelTier,
  systemPrompt: string,
  parts: LlmContentPart[],
  temperature: number,
  deps: Partial<RouterDeps> = {},
  needVision = false,
): Promise<RouteResult> {
  const d: RouterDeps = defaultDeps(deps)
  const attempts: RouteAttempt[] = []
  const now = d.now()
  // 日志要的是**当次真的发出去的文字**。图片进不了 JSONL，所以只记文本部分，
  // 并在 entry 上用 `hadImages` 把"这次还有图"这件事说出来 —— 否则一份只有文字的
  // 记录会让人误以为当时的输入就是这些（判据 19：哑的失败要另造观测点）。
  const promptText = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')

  const finish = (ok: boolean, model: string | null, text: string | null, reason: string): RouteResult => {
    const result: RouteResult = {
      ok,
      tier,
      model,
      text,
      attempts,
      degraded: ok && attempts.length > 1,
      reason,
    }
    appendEvent('LLM_ROUTE_DECISION', {
      tier,
      ok,
      model,
      reason,
      degraded: result.degraded,
      needVision,
      // ★ 换过账号要单独留一列。它只体现在 `attempts` 里的话，事后看账本
      //   得逐条翻才能发现"某个账号今天真的爆了、这一轮是换了账号才成的"。
      rotatedFrom: [
        ...new Set(attempts.filter((a) => /ACCOUNT_EXHAUSTED/.test(a.reason ?? '')).map((a) => a.account ?? '?')),
      ],
      accountsTried: [...new Set(attempts.map((a) => a.account).filter((x): x is string => !!x))],
      attempts: attempts.map((a) => ({ model: a.model, free: a.free, ok: a.ok, account: a.account, reason: a.reason })),
    })

    // ★★ 「模型可见即已记录」—— 把**当次真的发出去的内容**与模型回的原文写进日志。
    //   它与上面那条账本事件回答的是两个问题，缺一不可：
    //     · 账本事件：发生了什么（小、带哈希链、可证完整）
    //     · 这份日志：模型当时看到了什么（大、正文全、用于回放与取证）
    //   只有结论没有输入的日志，在"这条提案是模型编的还是我们喂的"面前一律失声。
    //
    //   `account` 取**最后一次尝试落在哪个账号**：失败时它是"最后撞的那个"，
    //   成功时它就是产出这条回答的那个账号 —— 两种情况下都是最该被记住的那个。
    const lastAccount = [...attempts].reverse().find((a) => a.account)?.account ?? null
    d.journal?.(
      buildEntry({
        at: d.now(),
        tier,
        model: ok ? model : null,
        account: lastAccount,
        ok,
        reason,
        system: systemPrompt,
        prompt: promptText,
        output: ok ? text : null,
        hadImages: needVision,
      }),
    )

    return result
  }

  const accounts = d.accounts ?? (d.provider ? [d.provider] : [])
  if (accounts.length === 0) {
    // ★★ 两种"没有账号可用"必须分开说 —— 它们的下一步**完全相反**（判据 24 / 29）：
    //   · 一个都没配      ⇒ 去配厂商（`NO_PROVIDER`）
    //   · 配了但全爆了    ⇒ 等次日恢复 / 再加账号（`ACCOUNTS_ALL_EXHAUSTED`）
    //   合并成一句"没有可用厂商"，用户会去改一个根本没错的地方。
    const snap = d.poolSnapshot?.() ?? poolSnapshot(now)
    if (snap.total > 0 && snap.allExhausted) {
      return finish(false, null, null, `ACCOUNTS_ALL_EXHAUSTED：${snap.speech}`)
    }
    return finish(false, null, null, 'NO_PROVIDER：未启用任何厂商，按确定性模式处理（不虚构模型调用）')
  }

  const configured = configuredModels(tier)

  for (const account of accounts) {
    // ★ 账号当天爆了 ⇒ **整条账号跳过**，只留一条可核对的记录。
    //   逐个模型各记一条会把 attempts 变成"账号数 × 模型数"条噪音，
    //   而这里唯一有用的事实是：这个账号今天别用了。
    if (isExhausted(account.id, now)) {
      attempts.push({
        model: account.model,
        free: isFreeModel(account.model),
        ok: false,
        account: account.name,
        reason: `ACCOUNT_EXHAUSTED：账号「${account.name}」今日免费额度已用尽（这是账号额度，不是模型名烂了）`,
        latencyMs: 0,
      })
      continue
    }

    // 候选链：显式配置优先 → 已验证名单 → 该账号的激活模型永远作为最后一根兜底。
    // 兜底必须存在 —— 否则配置写错一个模型名就会让整条链路无法工作。
    const chain = [...new Set([...configured, ...catalogFor(account, needVision), account.model])]

    for (const model of chain) {
      const free = isFreeModel(model)
      if (!free) {
        if (tier === 'probe') {
          attempts.push({ model, free, ok: false, account: account.name, reason: 'PROBE_NEVER_PAID：探测层不占用付费额度', latencyMs: 0 })
          continue
        }
        if (!allowPaid()) {
          attempts.push({ model, free, ok: false, account: account.name, reason: 'PAID_NOT_ALLOWED：未开启 EV_LLM_ALLOW_PAID', latencyMs: 0 })
          continue
        }
        const cap = paidHourlyCap()
        if (paidUsedInWindow(d.now()) >= cap) {
          attempts.push({ model, free, ok: false, account: account.name, reason: `PAID_BUDGET_EXHAUSTED：本小时已用 ${cap} 次`, latencyMs: 0 })
          continue
        }
      }
      // ★ 拉黑键必须带账号：`账号A:模型X` 死了不代表 `账号B:模型X` 也死了。
      //   不带账号会让一个账号上的临时故障把**所有**账号上的同名模型一起停掉
      //   —— 而账号池的意义正是"这家不行换那家"。
      const dkey = deadKey(account.id, model)
      if (isDead(dkey, now)) {
        attempts.push({
          model,
          free,
          ok: false,
          account: account.name,
          reason: `SKIPPED_RECENT_FAILURE：这个账号上这个模型 10 分钟内失败过，本次跳过（到期自动重试）`,
          latencyMs: 0,
        })
        continue
      }

      const startedAt = d.now()
      let text: string | null = null
      let reason: string | undefined
      try {
        text = await d.call({ ...account, model }, systemPrompt, parts, temperature)
        if (text === null) {
          // ★ 非 200 的原厂报错必须跟着往上走：只留一个 `EMPTY_RESPONSE`，
          //   上层就没有任何证据区分"额度用完(429)"与"名字写错(404)"，
          //   而这两者给出的下一步是相反的（等额度 vs 换名单）。
          //   归属判据：**只有落在同一个模型头上的、刚刚发生的失败才算证据** ——
          //   换一个模型时不许把上一条的失败借用过来当理由。
          const f = d.lastHttpFailure?.() ?? null
          const fresh = f && f.model === model && d.now() - f.at >= 0 && d.now() - f.at < 10_000 ? f : null
          reason = fresh ? `EMPTY_RESPONSE: HTTP ${fresh.status} ${fresh.snippet.slice(0, 100)}` : 'EMPTY_RESPONSE'
        }
      } catch (e) {
        reason = `CALL_FAILED: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`
      }
      const latencyMs = Math.max(0, d.now() - startedAt)

      if (text !== null) {
        if (!free) notePaidCall(d.now())
        attempts.push({ model, free, ok: true, account: account.name, latencyMs })
        return finish(
          true,
          model,
          text,
          free ? `使用免费模型（账号 ${account.name}）` : `使用付费模型（本小时第 ${paidUsedInWindow(d.now())}/${paidHourlyCap()} 次）`,
        )
      }
      // ★★ 一次失败要**同时**记两处，因为它们治的不是同一个病：
      //   · 账号额度（当天，`noteAccountFailure`）⇒ 换账号
      //   · 模型名坏掉（10 分钟，`deadUntil`）  ⇒ 换名单
      //   顺序无所谓，但**两处都得记**：只记模型会让 429 把好模型停 10 分钟（白停），
      //   只记账号会让真坏掉的名字每次都重撞一遍。
      if (reason) d.noteFailure?.(account.id, reason)
      if (isDeadly(reason)) deadUntil.set(dkey, d.now() + DEAD_TTL_MS)
      attempts.push({ model, free, ok: false, account: account.name, reason, latencyMs })
    }
  }

  // ★★ 结尾这一问，问的必须是「**现在**池子里还有没有能用的账号」，
  //    而不是「本次每一条尝试的原因是不是都写着额度」。
  //    差别在**多账号轮流爆的那个当口**：前面的账号是"这次调用中刚撞爆"的，
  //    它们的 `reason` 是原厂 429 原文而不是 `ACCOUNT_EXHAUSTED` ——
  //    用后者当判据的话，明明已经把账号全撞爆了，结论却会退化成
  //    "全部候选失败（3 个）"，而"该加账号了"这句话就丢了（判据 7：逐项复查）。
  if (accounts.every((a) => isExhausted(a.id, d.now()))) {
    const snap = d.poolSnapshot?.() ?? poolSnapshot(d.now())
    // 烟测注入的账号不在注册表里，池快照可能不包含它们 —— 那种情况下
    // 用**注入的账号数**自己算一句话，不去借一个不含它们的结论。
    const speech = snap.total > 0 && snap.allExhausted ? snap.speech : poolSpeech(accounts.length, 0, nextDayStart(d.now()))
    return finish(false, null, null, `ACCOUNTS_ALL_EXHAUSTED：${speech}`)
  }

  return finish(
    false,
    null,
    null,
    `全部候选失败（${attempts.length} 个）：${attempts.map((a) => `${a.account ?? '?'}:${a.model}[${a.reason ?? '-'}]`).join(' ')}`,
  )
}

/** 供监控/管理页读取的路由配置视图。 */
export function routerConfigView(): {
  tiers: { id: ModelTier; label: string; desc: string; models: string[] }[]
  allowPaid: boolean
  paidHourlyCap: number
  paidUsedThisHour: number
  /** 已验证名单与它的验证日期 —— 面板必须能显示"这份证据有多新"。 */
  catalog: { verifiedAt: string; ageDays: number; text: string[]; vision: string[] }
  deadModels: { model: string; account: string | null; until: number }[]
  /**
   * 账号池现状。
   *
   * ★ 它是"额度打满自动换账号"这条能力的**观测面**：没有它，用户只能看到
   *   "今天模型回答变慢了/开始失败"，而看不到"其实是第 1 个账号爆了、现在用的是第 3 个"。
   */
  pool: { total: number; ready: number; allExhausted: boolean; nextRecoveryAt: number | null; speech: string; exhausted: { name: string; keyHint: string; reason: string | null }[] }
} {
  const pool = poolSnapshot()
  return {
    tiers: MODEL_TIERS.map((t) => ({ ...t, models: [...configuredModels(t.id), getActiveLlm()?.model ?? '（未配置厂商）'].filter((m, i, a) => a.indexOf(m) === i) })),
    allowPaid: allowPaid(),
    paidHourlyCap: paidHourlyCap(),
    paidUsedThisHour: paidUsedInWindow(Date.now()),
    catalog: {
      verifiedAt: CATALOG_VERIFIED_AT,
      ageDays: Math.round(catalogAgeDays() * 10) / 10,
      text: privilegedText(),
      vision: privilegedVision(),
    },
    deadModels: deadModelsSnapshot(),
    pool: {
      total: pool.total,
      ready: pool.ready,
      allExhausted: pool.allExhausted,
      nextRecoveryAt: pool.nextRecoveryAt,
      speech: pool.speech,
      exhausted: pool.exhausted.map((e) => ({ name: e.name, keyHint: e.keyHint, reason: e.reason })),
    },
  }
}

function privilegedText(): string[] {
  return [...VERIFIED_TEXT_MODELS].map((m) => m.id)
}

function privilegedVision(): string[] {
  return [...VERIFIED_VISION_MODELS].map((m) => m.id)
}
