/**
 * 模型调用日志 —— 「凡到达模型的内容，必须能从日志重建」
 *
 * ── 这份模块内化自哪一条 ──────────────────────────────────────────────
 * 2026-09-19 日报第 ① 条（DeepSeek Harness）：它把
 * **「Model-visible means logged」** 当作一条不变量 —— 凡是到达模型的内容，
 * 必须可以从会话日志里重建；日志是 append-only 的 JSONL，
 * 已提交的行**永不重命名、永不替换、永不删除**；
 * UI、模型历史、审计回放全部从同一份日志投影。
 *
 * ── 为什么本系统需要它（不是"多存一份日志"）────────────────────────────
 * 本仓库已经有 `LLM_ROUTE_DECISION` 事件，但它只记了**结论**
 * （用了哪个模型、成没成、失败原因）。出了问题时真正要回答的是另一类问题：
 *   · "模型当时看到的 system prompt 是什么？"—— 心法库那阵子改过一版，是哪一版？
 *   · "这条策略提案是模型自己编的，还是我们喂给它的数字里就有？"
 *   · "同一个问题重问一次结果不同，是模型的随机性还是输入变了？"
 * 这三个问题**只能靠重建输入**来回答。只记结论的日志在这三个问题面前一律失声，
 * 而失声会伪装成"没问题"（判据 19：哑的失败必须另造观测点）。
 *
 * ── 与账本的分工（不要合并）────────────────────────────────────────────
 *   · 账本（`ledger.ts`）：**发生了什么**。带哈希链、可证完整、面向业务事件。
 *   · 本日志：**模型看到了什么、回了什么**。体量大、正文全、面向取证与回放。
 * 合并的代价是账本被几万条长正文撑爆，而哈希链的价值恰恰在于它小且可校验。
 * 所以两者都保留，但**入口只有一个**（`recordCall`，由 `modelRouter` 调用）。
 *
 * ── append-only 是怎么被保证的 ────────────────────────────────────────
 *   ① 文件名带日期（`calls-YYYY-MM-DD.jsonl`）⇒ **当天那份是新文件**，
 *      不需要改写历史文件（判据：不要依赖"能删能改"来维持正确性）；
 *   ② 全模块**只有 appendFileSync**，没有任何 writeFileSync / rename / unlink
 *      （这条由 `test:parity` 的源码扫描断言钉住）；
 *   ③ 截断只发生在**写入时**，且带 `truncated: true` 与原文长度 ——
 *      事后看到的每一行都与写它的那一刻逐字节相同。
 *
 * ★ 截断与"重建失败"必须分清（判据 29）：
 *   截断是**我们主动做的**（上限 64KB），原文长度与哈希仍然记全，
 *   所以"这条记录被截断了"与"这条记录对不上"是两件事，不能报同一句话。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appendEvent } from './ledger.ts'

/** 单个字段的上限（system / prompt / output 各自算）。 */
export const MAX_FIELD_BYTES = 64 * 1024

export interface LlmJournalEntry {
  at: number
  tier: string
  model: string | null
  /** 哪个账号产的（多账号池下"用谁调的不一样"是要能查的）。 */
  account: string | null
  ok: boolean
  reason: string
  /** 发给模型的 system 原文（超限时截断）。 */
  system: string
  /** 发给模型的 user 原文（超限时截断）。 */
  prompt: string
  /** 模型回的原文（超限时截断）。 */
  output: string | null
  /** **全长**哈希（不是截断后那一段的哈希）—— 截断也不能让身份对不上。 */
  systemHash: string
  promptHash: string
  outputHash: string | null
  /** 原文各有多少字节（截断前的真实规模）。 */
  bytes: { system: number; prompt: number; output: number }
  /** 有没有任一字段被截断。 */
  truncated: boolean
  /** 是否带图片（图片进不了日志，所以要把这件事说出来）。 */
  hadImages: boolean
}

export function journalDir(cwd: string): string {
  return join(cwd, 'data', 'llm-journal')
}

/** 按天命名 ⇒ 已经写过的文件永不需要被改写（append-only 的第一条保障）。 */
export function journalPath(cwd: string, at: number): string {
  return join(journalDir(cwd), `calls-${new Date(at).toISOString().slice(0, 10)}.jsonl`)
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function clip(s: string): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(s, 'utf8')
  if (bytes <= MAX_FIELD_BYTES) return { text: s, bytes, truncated: false }
  return { text: s.slice(0, MAX_FIELD_BYTES), bytes, truncated: true }
}

/**
 * 组装一条日志。
 *
 * ★ 为什么由本模块负责 clip/hash/bytes 而不是让调用方自己拼：
 *   `truncated` 与 `hash` 的关系是这份日志**唯一一条容易写错**的约定
 *   —— 哈希算的是**全长**、而正文存的是**截断后**的那一段。
 *   调用方各写一遍，迟早出现"截断后算哈希"的记录：那种记录在事后看起来
 *   完全正常，只是永远校验不过（判据 26：刚加的检查与刚改的内容要分别怀疑一次）。
 */
export function buildEntry(input: {
  at: number
  tier: string
  model: string | null
  account: string | null
  ok: boolean
  reason: string
  system: string
  prompt: string
  output: string | null
  hadImages: boolean
}): LlmJournalEntry {
  const s = clip(input.system)
  const p = clip(input.prompt)
  const o = input.output === null ? null : clip(input.output)
  return {
    at: input.at,
    tier: input.tier,
    model: input.model,
    account: input.account,
    ok: input.ok,
    reason: input.reason,
    system: s.text,
    prompt: p.text,
    output: o?.text ?? null,
    // ★ 全长哈希（不是截断后那一段的）
    systemHash: hash(input.system),
    promptHash: hash(input.prompt),
    outputHash: input.output === null ? null : hash(input.output),
    bytes: { system: s.bytes, prompt: p.bytes, output: o?.bytes ?? 0 },
    truncated: s.truncated || p.truncated || (o?.truncated ?? false),
    hadImages: input.hadImages,
  }
}

/** 打一条日志。**唯一入口** —— 别的模块不许自己拼 JSON 往这个目录写。 */
export function recordCall(cwd: string, e: LlmJournalEntry): void {
  const p = journalPath(cwd, e.at)
  try {
    mkdirSync(journalDir(cwd), { recursive: true })
    appendFileSync(p, JSON.stringify(e) + '\n')
  } catch (err) {
    // ★ 日志写不进去**不阻断业务**，但绝**不静默**：留一条账本事件说明
    //   "这一次的模型调用没有被记下来"。否则日志会出现一个看不出缺口的洞。
    try {
      appendEvent('LLM_JOURNAL_WRITE_FAILED', { at: e.at, model: e.model, reason: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    } catch {
      /* 连账本都写不进去，已经没有更好的办法了 */
    }
  }
}

/**
 * 从一条日志重建"当时发给模型的内容"。
 *
 * ★ 返回三态而不是布尔：`ok` / `truncated`（我们主动截断，无法重建全文）/
 *   `mismatch`（哈希对不上 —— 文件被改过）。后两者要报警的动作完全不同：
 *   前者什么也不用做（本就是不完整的存档），后者是**完整性事故**。
 */
export function reconstruct(
  e: LlmJournalEntry,
): { status: 'ok' | 'truncated' | 'mismatch'; text: string | null; note: string } {
  const sysOk = hash(e.system) === e.systemHash
  const prOk = hash(e.prompt) === e.promptHash
  if (e.truncated) {
    // 截断时哈希是**全长**的，所以这里只校验"字段本身没被篡改"这一层做不到 ——
    // 于是明确说"截断了，只能给出前 MAX_FIELD_BYTES 字节"，不冒充完整。
    return {
      status: 'truncated',
      text: `${e.system}\n\n---\n\n${e.prompt}`,
      note: `这条记录写入时被截断（system ${e.bytes.system} 字节 / prompt ${e.bytes.prompt} 字节，上限 ${MAX_FIELD_BYTES}），所以只能还原前一段。`,
    }
  }
  if (!sysOk || !prOk) {
    return { status: 'mismatch', text: null, note: '日志里的正文与它自带的全长哈希对不上 —— 这份存档被改过。' }
  }
  return { status: 'ok', text: `${e.system}\n\n---\n\n${e.prompt}`, note: '可完整重建' }
}

/** 读回某一天的日志（默认最新一天）。 */
export function readJournal(cwd: string, opts: { at?: number; limit?: number } = {}): LlmJournalEntry[] {
  const dir = journalDir(cwd)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  } catch {
    return []
  }
  const want = opts.at !== undefined ? `calls-${new Date(opts.at).toISOString().slice(0, 10)}.jsonl` : files[files.length - 1]
  if (!want) return []
  try {
    const lines = readFileSync(join(dir, want), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    const picked = opts.limit ? lines.slice(-opts.limit) : lines
    const out: LlmJournalEntry[] = []
    for (const l of picked) {
      try {
        out.push(JSON.parse(l) as LlmJournalEntry)
      } catch {
        /* 坏行跳过，不让它挡住整轮读取 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 日志现状。**三个数要分开**：条数 / 可完整重建的条数 / 完整性对不上的条数。 */
export function journalStats(cwd: string): {
  files: number
  entries: number
  reconstructable: number
  truncated: number
  mismatch: number
  failed: number
  note: string
} {
  const dir = journalDir(cwd)
  if (!existsSync(dir)) {
    return { files: 0, entries: 0, reconstructable: 0, truncated: 0, mismatch: 0, failed: 0, note: '还没有任何模型调用被记录过（不是"日志是空的"，是"从来没记过"）。' }
  }
  let files = 0
  const entries = readJournal(cwd, { limit: 100_000 })
  // 上一步只读了"最新一天"，所以这里另外数一遍文件数 —— 两个数回答不同的问题。
  try {
    files = readdirSync(dir).filter((f) => /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length
  } catch {
    /* ignore */
  }
  let ok = 0
  let trunc = 0
  let mismatch = 0
  let failed = 0
  for (const e of entries) {
    if (!e.ok) failed += 1
    const r = reconstruct(e)
    if (r.status === 'ok') ok += 1
    else if (r.status === 'truncated') trunc += 1
    else mismatch += 1
  }
  return {
    files,
    entries: entries.length,
    reconstructable: ok,
    truncated: trunc,
    mismatch,
    failed,
    note: `最近一天 ${entries.length} 条调用记录，可完整重建 ${ok} 条，截断 ${trunc} 条，完整性对不上 ${mismatch} 条。`,
  }
}
