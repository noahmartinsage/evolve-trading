/**
 * 桌宠永久记忆层 —— 「它得记得上一句，也得记得上个月」
 *
 * ══ 它修的是一条什么故障 ══════════════════════════════════════════════
 * 2026-09-23 用户原话：「目前它还不记得上一句问题无法连续工作」。
 * 核实结果比这句话更严重 —— 桌宠**根本没有对话工作记忆**：
 *
 *   · `parseIntent(text, ctx)` 只吃**当前这一句** + 标的池 + 标记价；
 *   · LLM 兜底也只发 `[system, user]` 两条消息（`llmProviders.ts` 的 messages）；
 *   · `transcript.ts` 落了 800+ 轮对话，却**只写不读回** —— 它是取证用的，
 *     不是记忆；
 *   · 唯一的跨轮状态是三个**内存变量**（`pendingProtectionQuestion` /
 *     `pending` / `cfg`），进程一重启全部归零。
 *
 * 于是"连续对话"这件事在系统里**没有任何地方承载**。它的表现形式全都不报错：
 *   「它现在多少钱」→ 不知道"它"是谁
 *   「刚才那个再改一下止损」→ 记不得刚才那个
 *   「以后下单都带止损」→ 下一轮就忘
 *   重启之后 → 它连自己刚才在等一个确认都不记得
 *
 * ══ 对标：上游最强的那四处，学的是语义不是实现 ═══════════════════════════
 * 精读来源见 `docs/MEMORY-BENCHMARK.md`。四处被内化的语义：
 *
 * ① **Zep/Graphiti —— 事实必须带溯源。** 上游把每条事实记成
 *    `{fact, created_at, updated_at, source}`，理由是"Agent 不仅要知道用户
 *    喜欢靠窗，还要知道这个偏好**从哪来、多久了**，才能判断要不要重新确认"。
 *    ⇒ 本模块的 `MemoryFact.source` **不允许只有一个自由文本**：
 *      它必须带 `sid#turnId`，能回到 `transcript.ts` 逐字核对。
 *      一条查不到出处的事实，在本模块里等于**没有证据**（判据 C3）。
 *
 * ② **Hermes 三层记忆 —— 写入超限要显式失败，不许静默淘汰。**
 *    上游给 `MEMORY.md` 定 2200 字符硬上限，超限时 `add` **直接失败**，
 *    并把当前全部条目**交还**给写入方，由它决定替换哪一条。理由是
 *    "容量有限迫使它挑重要的记"。
 *    ⇒ 本模块的 `remember()` 超限时返回 `budget-exceeded` **并附上全部现有
 *      条目**，绝不悄悄挤掉一条。静默淘汰的后果是：用户说过一句要紧的话，
 *      三天后系统"记得"的是另一句无关的 —— 而**没有任何地方报错**。
 *
 * ③ **Databricks / OpenDev —— context rot 是真的，必须压缩。**
 *    "历史越长推理质量越差"，没有 trim/summarize 策略的长会话会**性能悬崖**。
 *    ⇒ 本模块的 `assembleRecall()` 复用 `../contextBudget.ts` 的
 *      `assembleContext`：**强制块放不下就整体失败**，其余块超预算时
 *      先按行截断、再丢弃，且 `droppedIds` 是返回值的一部分 ——
 *      调用方必须把它写进事件流，"这一轮记忆被裁了多少"要可回溯。
 *      刻意**不重写**一份预算逻辑（判据 D2：同一个事实只许有一个主人）。
 *
 * ④ **OpenDev —— instruction fade-out 要靠周期重述对抗。**
 *    只注入一次的记忆，会在长会话里被后续内容稀释掉。
 *    ⇒ 本模块对**长期约定类**（`convention` / `promise`）在每一轮都重述，
 *      而**事实类**只在相关时召回（`scoreFact` 里的 kind 权重）。
 *
 * ══ 明确不内化的三处（理由具体，不是"暂不需要"）════════════════════════
 * · **向量库 / 嵌入检索（Mem0 / Letta archival）** —— 与红线⑭冲突：
 *   嵌入要出网调 API。本机离线要求是硬的（CI 不能依赖外网），
 *   所以召回走**确定性关键词打分**，代价是语义泛化弱，收益是**可离线断言**。
 * · **让模型自主决定记什么（Letta）** —— 与红线②冲突：本系统里
 *   "LLM 只决定怎么说，不决定做什么"。记忆写入由**确定性规则**判定，
 *   模型只能"建议"，建议落不落盘走同一条规则。
 * · **时序知识图谱（Zep/Graphiti 的图库）** —— 这是**技术纵深**不是配置成熟度，
 *   而桌宠的对话复杂度远低于客服/知识助手场景：实体关系图的收益在这里
 *   抵不过一个图数据库依赖的代价。用"事实 + 时间戳 + 失效规则"轻量替代。
 *
 * ══ 与另外两份记录的分工（有意不合并，判据 D2）══════════════════════════
 *   · `transcript.ts` —— **对话正文**的唯一事实源（append-only、不删、
 *     供人查阅）。本模块**不复制对话正文**，只存从对话里**派生**出来的事实。
 *   · `ledger.ts` —— **业务上发生了什么**（下单/风控/审批），带哈希链。
 *   · 本模块 —— **系统对用户的认识**：偏好、约定、纠正过什么。可失效、可被推翻。
 *
 * ══ 红线 ══════════════════════════════════════════════════════════════
 * ★★ **记忆不是新的行动通道。** 召回出来的东西**不许**让 `parseIntent` 多认出
 *    一个意图。它只能做两件事：
 *      ① 消解指代（「它」→ 上一轮的标的）；
 *      ② 在**槽位为空**时提供一个默认值 —— 且**必须先念出来**
 *         （「我记得你习惯 3 倍杠杆，这次也按 3 倍算 —— 不对就说一声」）。
 *    为什么这条是红线：记忆是**推断**，不是用户这句话说的。拿推断去下单，
 *    用户没有任何线索能发现自己被"猜"了（判据 D7）。
 * ★ **读不到 ≠ 没有。** 三态 `remembered` / `empty` / `unreadable` 互不顶替
 *    （判据 C7）。把"文件读不了"显示成"没记过"，会让用户以为系统失忆。
 * ★ **过期的记忆要能说出来。** 过期的条目不参与召回，但 `expiredCount`
 *    要带出去 —— 否则"我记得但过期了"与"我从没记过"长得一模一样。
 * ★ **写失败不能拖垮对话，但也不能沉默。** 与 `transcript.ts` 同一条纪律：
 *    `remember()` 不抛异常，失败记进 `memoryHealth()`。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleContext, estimateTokens, type ContextBlock } from '../contextBudget.ts'

// ───────────────────────────── 类型 ─────────────────────────────

/**
 * 事实的类别。
 *
 * ★ 分类不是为了好看：它决定**召回权重**与**是否每轮重述**（见文件头 ④）。
 *   `convention` / `promise` 是"要对每一轮都生效"的，而 `fact` 是"问到才用"的。
 *   把两者混成一档，就会出现"每一轮都在念一条无关的事实"（噪声）
 *   或者"约定被稀释掉"（丢约束）—— 两种都有各自的一族缺陷。
 */
export type FactKind = 'preference' | 'convention' | 'fact' | 'promise' | 'correction'

/**
 * 事实的出处。
 *
 * ★★ 为什么 `source` 不能是一个自由文本（学 Zep 的溯源）：
 *   自由文本的出处**无法核对** —— 写一句"用户说过"和写一句"系统推断的"，
 *   在事后查证时长得一样。所以这里强制带 `sid#turnId`，
 *   可以回到 `transcript.ts` 逐字读出当时的原话。
 *
 * ★ `explicit` 与 `inferred` 必须分开（判据 C7）：
 *   前者是用户**说了**的，可以直接当默认值用；后者是系统**推**的，
 *   用它之前必须先念出来并给用户否决的机会。压成一档的后果是
 *   "系统猜的"会在用户眼里变成"系统问过的"。
 */
export interface FactSource {
  /** 产生的会话与轮次。回到对话正文的唯一把手。 */
  sid: string
  turnId: number
  at: number
  /** 用户明确说的，还是系统推断的。 */
  confidence: 'explicit' | 'inferred'
}

export interface MemoryFact {
  /** 稳定 id。由 `kind + key` 派生 ⇒ 同一个事实重复写入不会产生第二个 id。 */
  id: string
  kind: FactKind
  /**
   * 语义键，用于**去重**（判据 D2：一句话只能有一个主人）。
   *
   * ★ 没有它会发生什么：用户说「以后都用 3 倍杠杆」，说了三次，
   *   库里出现三条 `preference`，其中一条是"1 倍"（第一次说的）。
   *   召回时三条一起出来，系统念的是哪一条取决于排序 —— 而三条都"有出处"。
   */
  key: string
  /** 事实本身，一句**人话**（它会被原样念给用户听，所以不许是 JSON）。 */
  text: string
  /** 结构化取值（便于消解指代时直接读，不用再解析 `text`）。 */
  value?: string | number | boolean
  source: FactSource
  at: number
  /**
   * 失效时刻。`null` = 永不过期。
   *
   * ★ 为什么需要它（学 Zep）："用户现在在 OKX 测试网试"是一个**会变**的事实。
   *   永不失效的后果是三个月后系统还在按"测试网"理解用户的下单指令 ——
   *   而那是**实盘**。
   */
  expiresAt: number | null
  /** 被这条事实覆盖掉的前一条（append-only 的代价：覆盖要留痕）。 */
  supersedes: string | null
  /**
   * 墓碑行。`forget()` 写它，**不物理删除**。
   *
   * ★ 为什么不是 `unlink`/重写文件：本项目已复现多次"清理动作本身成为故障源"
   *   （批量删除护栏假红、`process.exit` 跳过 finally 导致还原静默累积）。
   *   日志保持 append-only 之后，"忘掉"这个动作**本身也可查** ——
   *   能回答"它什么时候忘的、是谁让它忘的"。
   * ★ `key` 字段在墓碑行里装的是**被删事实的 id**。
   */
  tombstone?: true
}

// ───────────────────────────── 配置 ─────────────────────────────

/** 长期事实的总预算。超了就**写入失败**，不静默淘汰（文件头 ②）。 */
export const FACT_BUDGET_TOKENS = 1200

/** 工作记忆（最近几轮）预算。与 `DEFAULT_CONTEXT_BUDGET_TOKENS`(1800) 同量级的一部分。 */
export const WORKING_BUDGET_TOKENS = 700

/** 每轮最多注入多少 token 的记忆。超过就按优先级裁，并**报告裁了什么**。 */
export const RECALL_BUDGET_TOKENS = 900

/** 工作记忆保留的轮数上限（滑动窗口）。 */
export const WORKING_TURNS = 8

/** 各类事实的召回权重。`convention`/`promise` 高是因为它们**跨轮生效**。 */
const KIND_WEIGHT: Record<FactKind, number> = {
  promise: 1.0,
  convention: 0.95,
  correction: 0.9,
  preference: 0.75,
  fact: 0.5,
}

/** 新事实的默认存活天数。`null` = 永不过期。 */
const KIND_TTL_DAYS: Record<FactKind, number | null> = {
  preference: null,
  convention: null,
  promise: null,
  correction: null,
  // ★ `fact` 是唯一会过期的：环境事实（在哪条链、哪个场所、什么模式）会变。
  fact: 30,
}

// ───────────────────────────── 注入点 ─────────────────────────────

let root: string | null = null

/**
 * 指定记忆根目录（测试用来隔离）。
 *
 * ★ 与 `transcript.setTranscriptRoot` 同一条理由：烟测会走真实的
 *   `remember()` 路径，如果它写进 `data/voice/`，就会往用户的**真实记忆**里
 *   灌假事实 —— 而假事实比假日志危险得多：它会被当成"用户说过的话"召回。
 */
export function setMemoryRoot(dir: string | null): void {
  root = dir
}

export function memoryRoot(): string {
  return root ?? process.cwd()
}

export function memoryDir(base = memoryRoot()): string {
  return join(base, 'data', 'voice')
}

/** 事实日志文件名。**刻意与 transcript 同目录不同文件**，便于一眼看出是两份东西。 */
export function memoryFileName(): string {
  return 'facts.jsonl'
}

function factsPath(): string {
  return join(memoryDir(), memoryFileName())
}

// ───────────────────────────── 健康度 ─────────────────────────────

let lastWriteFailure: { at: number; reason: string } | null = null

export function memoryHealth(): { path: string; writeFailure: { at: number; reason: string } | null } {
  return { path: factsPath(), writeFailure: lastWriteFailure }
}

export function resetMemoryHealth(): void {
  lastWriteFailure = null
}

// ───────────────────────────── 读（唯一入口）─────────────────────────────

/**
 * 读全部事实。
 *
 * ★ 三态（判据 C7）：
 *   ① 文件不存在 ⇒ `unreadable: null` + 0 条 —— 这是**真的没记过**；
 *   ② 文件在但读不了 ⇒ `unreadable: '<原因>'` —— 这是**读不到**；
 *   ③ 有行解析不了 ⇒ `badLines > 0` —— 这是**部分读到了**，更不该沉默。
 *   ★ 把 ① 和 ② 合成"0 条"是本类模块最典型的失效：用户问"你记得吗"，
 *     系统答"没记过"，而真相是文件权限坏了。
 */
export interface FactReadResult {
  facts: MemoryFact[]
  /** `null` = 真的读到了（哪怕 0 条）。非 null = 读不到，原因在这里。 */
  unreadable: string | null
  badLines: number
  badReasons: string[]
}

export function readFacts(): FactReadResult {
  const p = factsPath()
  if (!existsSync(p)) return { facts: [], unreadable: null, badLines: 0, badReasons: [] }

  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    return { facts: [], unreadable: e instanceof Error ? e.message : String(e), badLines: 0, badReasons: [] }
  }

  const facts: MemoryFact[] = []
  let badLines = 0
  const badReasons: string[] = []
  for (const row of raw.split('\n')) {
    if (row.trim().length === 0) continue
    try {
      const f = JSON.parse(row) as MemoryFact
      if (typeof f?.id !== 'string' || typeof f?.key !== 'string' || typeof f?.text !== 'string') {
        throw new Error('缺 id/key/text')
      }
      facts.push(f)
    } catch (e) {
      badLines += 1
      if (badReasons.length < 3) badReasons.push(e instanceof Error ? e.message : String(e))
    }
  }
  return { facts, unreadable: null, badLines, badReasons }
}

/**
 * 折叠成"当前有效的事实表"。
 *
 * 两件事都必须做对，否则症状都是"它记错了"：
 *
 * ① **同一 id 取后写的那条**（用户改主意了）。
 * ② **墓碑必须真的让它失效** —— 这是我在第一版里写漏的一处：
 *    只写墓碑不折叠，等于墓碑行进了库、被它标记的那条事实**照旧有效**，
 *    于是"你说忘掉"和"你没说过"在库里长得一样。而 `forget()` 还返回成功。
 *
 * ★ 时序：墓碑**只对写在它之前的事实生效**。用户在 `forget` 之后
 *   又改口说了一遍同样的话，那条新事实必须能复活 ——
 *   不带时间比较的写法会把"重新记起"也一并杀掉，而那是**相反**的错。
 */
export function currentFacts(read: FactReadResult = readFacts()): MemoryFact[] {
  const tombstoneAt = new Map<string, number>()
  for (const f of read.facts) {
    if (f.tombstone !== true) continue
    // 墓碑的 `key` 装的是被删事实的 id
    const prev = tombstoneAt.get(f.key) ?? -Infinity
    if (f.at > prev) tombstoneAt.set(f.key, f.at)
  }

  const byId = new Map<string, MemoryFact>()
  for (const f of read.facts) {
    if (f.tombstone === true) continue
    if ((tombstoneAt.get(f.id) ?? -Infinity) >= f.at) continue
    const prev = byId.get(f.id)
    if (!prev || f.at >= prev.at) byId.set(f.id, f)
  }
  return [...byId.values()].sort((a, b) => b.at - a.at)
}

// ───────────────────────────── 写（唯一入口）─────────────────────────────

export type RememberResult =
  | { ok: true; fact: MemoryFact; supersededId: string | null }
  /**
   * ★ 超预算 ⇒ **写入失败**，并把当前全部事实交还给调用方。
   *   调用方（人 / 模型建议）必须显式选一条淘汰，或者放弃写这条。
   *   刻意**不**自动淘汰最老的：那会让"用户说过一句要紧的话"在三天后
   *   被一条无关的新事实挤掉，而**没有任何地方报错**。
   */
  | { ok: false; reason: 'budget-exceeded'; current: MemoryFact[]; neededTokens: number; budgetTokens: number }
  | { ok: false; reason: 'unwritable'; error: string }

export interface RememberInput {
  kind: FactKind
  key: string
  text: string
  value?: string | number | boolean
  source: FactSource
  /** 覆盖哪个已有事实。不传时按 `kind + key` 自动派生 id（同一个 key 只会有一条）。 */
  supersedesId?: string
}

/** 事实 id = 类别的语义键。同一个 key 重复写 ⇒ 覆盖而不是新增。 */
export function factIdOf(kind: FactKind, key: string): string {
  return `${kind}:${key}`
}

function appendFact(f: MemoryFact): string | null {
  const dir = memoryDir()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(factsPath(), JSON.stringify(f) + '\n', 'utf8')
    return null
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    lastWriteFailure = { at: Date.now(), reason }
    return reason
  }
}

/**
 * 记一条事实。
 *
 * ★ 顺序（不可换）：**先算总量 → 再判超限 → 最后落盘**。
 *   反过来（先落盘再检查）会留下一个超预算的事实，而它的存在本身就是
 *   下一次注入被静默截断的原因。
 */
export function remember(input: RememberInput): RememberResult {
  const id = factIdOf(input.kind, input.key)
  const read = readFacts()
  const existing = currentFacts(read)

  // 同一 id 覆盖 ⇒ 先把旧的那条从总量里扣掉，否则"改主意"这个动作
  // 会因为总量不变而被误判成超限（用户想改，系统说"记不下了"）。
  const superseded = existing.find((f) => f.id === id) ?? null
  const others = existing.filter((f) => f.id !== id)

  const baseTokens = others.reduce((a, f) => a + estimateTokens(f.text), 0)
  const neededTokens = baseTokens + estimateTokens(input.text)
  if (neededTokens > FACT_BUDGET_TOKENS) {
    return { ok: false, reason: 'budget-exceeded', current: others, neededTokens, budgetTokens: FACT_BUDGET_TOKENS }
  }

  const ttlDays = KIND_TTL_DAYS[input.kind]
  const fact: MemoryFact = {
    id,
    kind: input.kind,
    key: input.key,
    text: input.text,
    ...(input.value !== undefined ? { value: input.value } : {}),
    source: input.source,
    at: input.source.at,
    expiresAt: ttlDays === null ? null : input.source.at + ttlDays * 24 * 60 * 60 * 1000,
    supersedes: input.supersedesId ?? superseded?.id ?? null,
  }

  const failure = appendFact(fact)
  if (failure) return { ok: false, reason: 'unwritable', error: failure }
  return { ok: true, fact, supersededId: superseded?.id ?? null }
}

/**
 * 删一条事实（真正意义上的"忘掉"）。
 *
 * ★ 与 `transcript.ts` 的红线**刻意不同**：那里"不提供删除接口"，
 *   因为对话是**发生过的事**，删掉就是篡改取证。
 *   而记忆是**系统对用户的认识** —— 认识可以被推翻、可以是错的。
 *   用户说"你记错了，我不用杠杆"，那就必须能真的忘掉。
 *   ⇒ 这里用 **tombstone（墓碑行）**而不是物理删除：日志仍然 append-only，
 *     但折叠时墓碑会让那条事实失效。这样"忘掉"这件事本身也可查。
 */
export function forget(id: string, opts: { at?: number; sid?: string; turnId?: number } = {}): boolean {
  const at = opts.at ?? Date.now()
  const tombstone: MemoryFact = {
    id: `tombstone:${id}`,
    kind: 'fact',
    key: id, // ★ 墓碑行里 `key` 装的是**被删事实的 id**（见 `currentFacts` 的折叠规则）
    text: '',
    at,
    expiresAt: null,
    supersedes: null,
    // ★ 墓碑**也要有出处**：事后要能回答"它是什么时候、因为哪一轮对话忘掉的"。
    //   一个没有出处的墓碑与"这条事实从来不存在"在查证时长得一样。
    source: { sid: opts.sid ?? currentSid(), turnId: opts.turnId ?? 0, at, confidence: 'explicit' },
    tombstone: true,
  }
  return appendFact(tombstone) === null
}

// ───────────────────────────── 召回 ─────────────────────────────

/** 把一句话切成可比较的检索词。CJK 走 2-gram，ASCII 走词。**确定性**。 */
export function tokenizeForRecall(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]{2,}/g)) out.add(m[0])
  const cjk = text.replace(/[^\u3400-\u9fff]/g, '')
  for (let i = 0; i + 2 <= cjk.length; i += 1) out.add(cjk.slice(i, i + 2))
  return [...out]
}

/**
 * 单条事实对一次查询的相关度。
 *
 * ★ 打分必须是**纯函数且确定性**（同输入同输出）—— 否则同一句话两次召回
 *   给出不同的记忆，用户会觉得"它今天记性不一样"。
 */
export function relevanceOf(fact: MemoryFact, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0
  const factTokens = new Set(tokenizeForRecall(`${fact.key} ${fact.text}`))
  let hit = 0
  for (const t of queryTokens) if (factTokens.has(t)) hit += 1
  return hit / queryTokens.length
}

export interface ScoredFact {
  fact: MemoryFact
  score: number
  /** 分数由哪几项构成。★ 可解释性：用户问"你凭什么记得这个"要答得上来。 */
  parts: { relevance: number; recency: number; kind: number }
}

/**
 * 时间衰减：半衰期 14 天。
 *
 * ★ 用指数而不是线性：线性衰减会让"30 天前的约定"与"29 天前的"几乎同分，
 *   而用户对"上个月说的"与"上周说的"的感觉是**数量级**差别。
 */
export function recencyOf(at: number, now: number): number {
  const days = Math.max(0, (now - at) / (24 * 60 * 60 * 1000))
  return Math.pow(0.5, days / 14)
}

export function scoreFact(fact: MemoryFact, queryTokens: readonly string[], now: number): ScoredFact {
  const relevance = relevanceOf(fact, queryTokens)
  // ★ 长期约定/承诺即使**与当前这句话无关**也要有底分 —— 这是文件头 ④
  //   说的"周期重述对抗 instruction fade-out"。没有这一条，
  //   用户说过的"以后都带止损"会在第三轮之后彻底消失。
  const durability = KIND_WEIGHT[fact.kind] >= 0.95 ? 0.6 : 0
  const relevanceFinal = Math.max(relevance, durability)
  const recency = recencyOf(fact.at, now)
  const kind = KIND_WEIGHT[fact.kind]
  return { fact, score: 0.5 * relevanceFinal + 0.3 * recency + 0.2 * kind, parts: { relevance: relevanceFinal, recency, kind } }
}

export interface RecallResult {
  /**
   * ★ 三态（判据 C7）：
   *   `remembered` —— 有命中；
   *   `empty`      —— **真的读到了**，但没有相关的（不是错误）；
   *   `unreadable` —— 读不到，原因在 `note` 里。
   *   把 `empty` 与 `unreadable` 合成"没记过"，用户就无从知道系统是失忆还是没数据。
   */
  state: 'remembered' | 'empty' | 'unreadable'
  hits: ScoredFact[]
  /** 过期的条数。★ 不参与召回，但**必须被说出来**（"有 N 条已过期"）。 */
  expiredCount: number
  /** 命中里被预算裁掉的 id。调用方要把它写进事件流（文件头 ③）。 */
  droppedIds: string[]
  truncatedIds: string[]
  /** 组装失败的原因（强制块放不下时）。 */
  failureReason: string | null
  /** 给用户听的一句话。`null` = 这一轮没什么可说的（不该硬凑）。 */
  speech: string | null
  /** 读不到 / 部分读坏时的说明。 */
  note: string | null
  tokens: number
  budgetTokens: number
}

/**
 * 召回并组装。
 *
 * ★ 为什么"组装"与"打分"放在一起：调用方拿到的是**能直接用的文本 + 一句话**，
 *   而不是一堆需要它自己再拼的条目。分散拼装的后果是每个调用点拼法不同，
 *   于是"桌宠记不记得"会随着调用点变化 —— 而用户看到的只是"它有时记得有时不记得"。
 */
export function recall(query: string, opts: { now?: number; limit?: number; budgetTokens?: number } = {}): RecallResult {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 6
  const budgetTokens = opts.budgetTokens ?? RECALL_BUDGET_TOKENS

  const read = readFacts()
  const all = currentFacts(read)
  const alive = all.filter((f) => f.text.length > 0 && (f.expiresAt === null || f.expiresAt > now))
  const expiredCount = all.filter((f) => f.text.length > 0 && f.expiresAt !== null && f.expiresAt <= now).length

  if (read.unreadable !== null) {
    // ★ 读不到时**不许**返回"没记过" —— 那两件事的下一步动作相反
    //   （一个要修文件权限，一个什么都不用做）。
    return {
      state: 'unreadable',
      hits: [],
      expiredCount: 0,
      droppedIds: [],
      truncatedIds: [],
      failureReason: null,
      speech: null,
      note: `记忆读不到（${read.unreadable}）—— 这一轮我按"没有记忆"回答，但这是**读不到**，不是没记过。`,
      tokens: 0,
      budgetTokens,
    }
  }

  const queryTokens = tokenizeForRecall(query)
  const scored = alive
    .map((f) => scoreFact(f, queryTokens, now))
    // 门槛：完全无关（relevance 为 0 且 durability 为 0）的条目不许进来。
    // 不设门槛的后果是每一轮都注入一堆无关记忆，把真正相关的挤掉。
    .filter((s) => s.parts.relevance > 0)
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, limit)

  if (scored.length === 0) {
    return {
      state: 'empty',
      hits: [],
      expiredCount,
      droppedIds: [],
      truncatedIds: [],
      failureReason: null,
      speech: null,
      note: expiredCount > 0 ? `我有 ${expiredCount} 条记忆已经过期，不参与这一轮。` : null,
      tokens: 0,
      budgetTokens,
    }
  }

  const blocks: ContextBlock[] = scored.map((s, i) => ({
    id: s.fact.id,
    // 优先级：分数高的排前面（`priority` 越小越先保留）
    priority: 10 + i,
    text: s.fact.text,
    truncatable: true,
    // ★ 「用户明确说过的约定/承诺」是**强制块**：它约束的是行为，
    //   放不下就必须整体失败，而不是"这一轮先忘了你要带止损"。
    mandatory: s.fact.source.confidence === 'explicit' && KIND_WEIGHT[s.fact.kind] >= 0.95,
  }))

  const asm = assembleContext(blocks, budgetTokens)

  // ★★ 组装失败（强制块放不下）**不许表现成"没有记忆"**。
  //   一处我已复现过的坑：`assembleContext` 失败时 `includedIds` 是空的，
  //   照直往下走就会得到一个 `state: 'remembered'` + `hits: []` + `speech: null`
  //   的结果 —— 与"真的没有相关记忆"**一模一样**。而两者的下一步动作相反：
  //   一个要人去调预算，一个什么都不用做。所以这里单独把失败说出来。
  if (!asm.ok) {
    return {
      state: 'remembered',
      hits: [],
      expiredCount,
      droppedIds: [],
      truncatedIds: [],
      failureReason: asm.failureReason ?? null,
      speech: '这一轮的记忆装不进上下文预算，我不拿它当依据 —— 该问的我还是会问你。',
      note: `记忆组装失败：${asm.failureReason ?? '未知原因'}`,
      tokens: 0,
      budgetTokens,
    }
  }

  const hits = scored.filter((s) => asm.includedIds.includes(s.fact.id))

  return {
    state: 'remembered',
    hits,
    expiredCount,
    droppedIds: asm.droppedIds,
    truncatedIds: asm.truncatedIds,
    failureReason: asm.ok ? null : (asm.failureReason ?? null),
    speech: speakRecall(hits.map((h) => h.fact), expiredCount),
    note: null,
    tokens: asm.estimatedTokens,
    budgetTokens,
  }
}

/** 按语义键精确取一条记忆。`null` = **真的没记过**（读不到时也是 `null`，另有 `readFacts().unreadable` 可查）。 */
export function factByKey(key: string, now = Date.now()): MemoryFact | null {
  for (const f of currentFacts()) {
    if (f.key !== key) continue
    if (f.expiresAt !== null && f.expiresAt <= now) return null
    return f
  }
  return null
}

/**
 * 把召回结果说成一句**人话**。
 *
 * ★ 为什么记忆必须"说出来"（判据 D7）：
 *   记忆是**推断**，不是用户这句话说的。用它之前不声明，用户就没有任何
 *   线索能发现自己被"猜"了 —— 而被猜错的代价在下单场景是真实的钱。
 * ★ 文案里**不含 markdown 星号**（红线⑥：播报文案是给人听的）。
 *
 * ★ 参数收成 `readonly MemoryFact[]` 而不是 `ScoredFact[]`：查阅视图
 *   （`/voice/memory`）手里只有条目、没有打分，而它要显示的是**同一句话**。
 *   收成 `ScoredFact[]` 会逼调用方现造一批假分数 ——
 *   于是"界面显示的措辞"与"播报念的措辞"变成两份，迟早分岔（判据 D2）。
 */
export function speakRecall(hits: readonly MemoryFact[], expiredCount: number): string | null {
  if (hits.length === 0) return expiredCount > 0 ? `我有 ${expiredCount} 条记忆过期了，这一轮用不上。` : null
  const explicit = hits.filter((h) => h.source.confidence === 'explicit')
  const inferred = hits.filter((h) => h.source.confidence === 'inferred')
  // ★ 用数组 join 而不是拼接句号：播报文案是**念给人听**的，
  //   「。。」在听觉上是两次停顿，用户会以为系统卡了一下（漏修过一次）。
  const bits: string[] = []
  if (explicit.length > 0) bits.push('你跟我说过：' + explicit.map((h) => h.text).join('；'))
  if (inferred.length > 0) bits.push('我按之前的对话推断：' + inferred.map((h) => h.text).join('；') + '（不对就说一声）')
  return bits.length === 0 ? null : bits.join('。') + '。'
}

/**
 * 供模型兜底用的上下文文本。
 *
 * ★ 与 `speakRecall` 分工不同：那个是**念给用户听**的，这个是**给模型看**的。
 *   给模型的那一份要带出处，因为模型可能会把它当事实引用。
 */
export function recallAsContext(r: RecallResult): string {
  if (r.state !== 'remembered' || r.hits.length === 0) return ''
  const lines = r.hits.map(
    (h) =>
      `- [${h.fact.kind}] ${h.fact.text}` +
      `（来源：${h.fact.source.confidence === 'explicit' ? '用户明确说过' : '系统推断'}，` +
      `第 ${h.fact.source.turnId} 轮，分数 ${h.score.toFixed(2)}）`,
  )
  return ['【我对这位用户已确认的记忆】', ...lines].join('\n')
}

// ───────────────────────────── 工作记忆 ─────────────────────────────

/** 一轮对话的**极简**摘要。正文仍然只有一个主人（`transcript.ts`）。 */
export interface WorkingTurn {
  turnId: number
  at: number
  /** 用户说了什么（截断到一句话的量级）。 */
  user: string
  /** 系统回了什么（截断）。 */
  assistant: string
  /** 这一轮涉及的标的。★ 指代消解就靠它（「它」→ 上一轮的标的）。 */
  symbols: string[]
  intent: string | null
}

const working = new Map<string, WorkingTurn[]>()

export function resetWorking(): void {
  working.clear()
}

/** 记一轮。由 `session.ts` 在提交答复时调用。 */
export function noteTurn(t: WorkingTurn): void {
  const sid = currentSid()
  const list = working.get(sid) ?? []
  const idx = list.findIndex((x) => x.turnId === t.turnId)
  if (idx >= 0) list[idx] = t
  else list.push(t)
  // 滑动窗口：只留最近 `WORKING_TURNS` 轮
  if (list.length > WORKING_TURNS) list.splice(0, list.length - WORKING_TURNS)
  working.set(sid, list)
}

let sidForWorking = 'default'
/** 由 `session.ts` 在生成 `sid` 后注入，让工作记忆按真实会话分组。 */
export function bindWorkingSid(sid: string): void {
  sidForWorking = sid
}
function currentSid(): string {
  return sidForWorking
}

export function recentTurns(sid = currentSid()): WorkingTurn[] {
  return [...(working.get(sid) ?? [])]
}

/**
 * 最近一轮里出现过的标的。
 *
 * ★ 这是**指代消解**的唯一数据来源：「它 / 那个 / 刚才那个」在上文里指的是谁。
 *   为什么不从 DB 里的持仓推：持仓里可能有五个标的，指代只可能是**刚说的那个**。
 */
export function lastMentionedSymbol(sid = currentSid()): string | null {
  const turns = recentTurns(sid)
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const s = turns[i].symbols
    if (s.length > 0) return s[0]
  }
  return null
}

/**
 * 从对话正文**回填**工作记忆。
 *
 * ★★ 这是"永久"两个字真正的落点。`working` 是内存 Map，进程重启就空 ——
 *    而用户对这一层的期待恰恰是"我昨天跟你说的那件事"。不回填的话，
 *    每次重启桌宠都会重新变成陌生人，而它**看起来完全正常**（照样答得上话，
 *    只是不记得任何前情）。
 *
 * ★ 带 `looksLike` 注入而不是在这里自己写一份标的识别正则：
 *    识别的正确判据只有一份（`intents.resolveSymbol`），在这里再写一套
 *    就会出现"回填认出的标的"与"实时认出的标的"不一致 ——
 *    而症状是"重启前能听懂、重启后听不懂同一句话"。
 *
 * ★ 读不到时**不清空**已有的工作记忆：宁可用旧的回填，也不要因为一次
 *    读盘失败把刚建立的上下文抹掉（那是最糟的：用户说了三句，第四句失效）。
 */
export function hydrateWorkingFromTranscript(
  page: { turns: { sid: string; turnId: number; at: number; state: string; user: { text: string; intent?: string } | null; assistant: { text: string } | null }[] },
  looksLike: (text: string) => string[],
  sid: string = currentSid(),
): number {
  const turns: WorkingTurn[] = []
  // 从旧到新灌（`page.turns` 是新的在前）
  for (const t of [...page.turns].reverse()) {
    if (!t.user) continue
    turns.push({
      /**
       * ★★ 历史轮次用**负数 id**，与本次会话的正数 `turnId` 必须不相交。
       *
       * 为什么（这是我在第一版里写错的一处）：`noteTurn` 按 `turnId`
       * **覆盖**同号的那一轮。而 transcript 的 `turnId` 是**进程内**序号，
       * 每次重启都从 1 重来 —— 所以历史几乎必然与本次会话撞号。
       * 撞上的后果很刁钻：用户重启后说第一句话，它会**顶掉**历史里的第 1 轮，
       * 而剩下的窗口顺序仍然看着正常。指代消解于是指到一个**错的人**，
       * 给出一句"我按上一句理解的"——听起来完全合理。
       */
      turnId: -turns.length - 1,
      at: t.at,
      user: t.user.text.slice(0, 200),
      assistant: (t.assistant?.text ?? '').slice(0, 200),
      symbols: looksLike(t.user.text),
      intent: t.user.intent ?? null,
    })
  }
  const tail = turns.slice(-WORKING_TURNS)
  /**
   * ★ **替换**而不是追加：`startVoice()` 可能被调用多次（测试、重连），
   *   追加会让同样的历史灌进来 N 遍，把 8 轮的窗口用重复内容填满。
   *   而它**不会报错** —— 只是"最近说的那句话"变成了很早以前的一句。
   */
  working.set(sid, tail)
  return tail.length
}
