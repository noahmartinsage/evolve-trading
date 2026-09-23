/**
 * 桌宠对话记录 —— 「聊过的话必须能被找回」
 *
 * ── 为什么必须有这一份 ────────────────────────────────────────────────
 * 语音层原本只有**内存里**的日志（前端 `useVoiceSession` 的 `log`）。它有三个
 * 天生的缺口，而这三个缺口一个都不会报错：
 *   ① 刷新页面就没了 —— 用户想问"我刚才让你干的什么来着"，系统失声；
 *   ② 进程重启就没了 —— 崩溃之后想复盘"最后一句说了什么"，无从查起；
 *   ③ 它记的是**播报**（narration），不是**对话**：用户的原话根本不在里面。
 * 于是"桌宠和我聊过什么"这个问题，在系统里没有一个地方能回答它。
 * 这不是"少存一份日志"，而是**取证能力缺失**：凡是没有落地的对话，
 * 事后都只能靠回忆，而回忆与事实不一致时**无法分辨**（判据 19）。
 *
 * ── 与另外两份记录的分工（有意不合并）─────────────────────────────────
 *   · 账本 `ledger.ts`：**业务上发生了什么**（下单 / 风控 / 审批），带哈希链。
 *   · 模型日志 `llmJournal.ts`：**到达模型的内容**。
 *   · 本模块：**人对桌宠说了什么、桌宠回了什么**，含"这句话被作废了"。
 * 三者面向三个不同的追问。合并会让任一方被另两方的体量与语义污染：
 * 账本的价值恰恰在于它小且可校验，而对话正文很长。
 *
 * ── append-only 是怎么被保证的 ────────────────────────────────────────
 *   ① 文件按日分（`turns-YYYY-MM-DD.jsonl`）⇒ 当天那份**是新文件**，
 *      永远不需要改写历史（判据：不要靠"能删能改"来维持正确性）；
 *   ② 全模块**只有 `appendFileSync`**，没有 writeFileSync / rename / unlink
 *      （这条由 `scripts/voice-smoke.ts` 的源码扫描断言钉住）；
 *   ③ **不提供删除接口**。要清掉某天的记录，由用户自己删那个文件 ——
 *      这个动作有意留在系统之外：程序悄悄删掉"聊过的话"是不可接受的形状。
 *
 * ── 红线 ──────────────────────────────────────────────────────────────
 * ★ **只落本地，不出网、不喂模型。** 对话里有持仓、金额、订单细节。
 *   这份文件是给用户自己查的，不是给任何远端看的。
 * ★ **`dropped` 不能省。** 被打断而作废的答复，也是一次真实发生过的事。
 *   它必须能被读出来，且必须与"答了"分开显示 —— 把两者合成一个数字，
 *   用户会看到"系统答了"而实际上一个字都没听到（判据 25：三态互不顶替）。
 * ★ **配对键是 `sid + turnId`，不是 `turnId`。** `turnId` 是**进程内**的自增
 *   序号，重启后从 1 重来。只按它配对，会把"昨天第 3 轮"和"今天第 3 轮"
 *   串成同一轮 —— 而串出来的那一轮**看着完全正常**（判据 29：一句话只能有
 *   一个主人）。所以每行都带 `sid`，配对只认复合键。
 * ★ **写失败不能拖垮语音，但也不能沉默。** 落盘是尽力而为的旁路：
 *   失败时 `record*` 不抛异常（不能因为写不了记录就让用户说不出话），
 *   但失败会被记在 `transcriptHealth()` 里、并由端点带出去
 *   —— 沉默的失败会让"没有记录"看起来像"没聊过"（判据 24）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 单条正文的落盘上限。超出部分截断，但**原长必须记下来**。 */
export const MAX_TEXT_BYTES = 8 * 1024

/** 一次最多返回多少轮。 */
export const DEFAULT_PAGE = 50

let root: string | null = null

/**
 * 指定记录根目录（测试用来隔离）。
 *
 * ★ 为什么要可注入：`scripts/voice-smoke.ts` 会走真实的会话状态机，
 *   如果它写进 `data/voice/`，测试就会往用户的真实聊天记录里灌假对话。
 *   判据「门要可注入，才能同时断言过与不过」—— 注入之后，
 *   "生产写哪儿"和"测试写哪儿"变成两件可分别观察的事。
 */
export function setTranscriptRoot(dir: string | null): void {
  root = dir
}

/** 记录根目录。默认跟着工作目录走 —— 忘了注入也不会变成"静默不记"。 */
export function transcriptRoot(): string {
  return root ?? process.cwd()
}

export function transcriptDir(base = transcriptRoot()): string {
  return join(base, 'data', 'voice')
}

/** 按**本地**日期分文件 —— 用户是按自己的日历找"那天的记录"。 */
export function transcriptFileName(at: number): string {
  return `turns-${dayKey(at)}.jsonl`
}

function dayKey(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface TranscriptLine {
  at: number
  /** 会话 id。与 `turnId` 一起构成配对键（见文件头红线）。 */
  sid: string
  turnId: number
  role: 'user' | 'assistant'
  text: string
  /** 正文是否被截断。截断是**我们主动做的**，不是数据丢了。 */
  truncated?: boolean
  /** 截断前的原始字节数（便于判断"到底说了多长"）。 */
  textBytes?: number
  /** 意图名。解析发生在 `beginTurn` 之后，所以是补记的，可能缺。 */
  intent?: string
  /** 仅 assistant：提交时的世代号。 */
  gen?: number
  /** 仅 assistant：这条答复**有没有真的被念出来**。 */
  dropped?: boolean
  /**
   * 仅 assistant：作废的原因。
   * `generation` = 用户插话把在途答复作废（预期内）；`turn` = 轮次已经翻篇（异常信号）。
   * ★ 分开记，因为这两件事**指向相反的动作**：前者是打断功能正常工作，
   *   后者说明提交流程出了问题。合成一个 `dropped: true` 就再也分不出来。
   */
  dropReason?: 'generation' | 'turn'
  /** 仅 user：附件摘要（不含内容，只记"当时贴了什么"）。 */
  attachments?: { name: string; mimeType: string; bytes: number }[]
}

/** 一轮对话：用户说了什么 + 桌宠回了什么。 */
export interface TranscriptTurn {
  sid: string
  turnId: number
  at: number
  /**
   * 三态，互不顶替（判据 25）：
   *   `answered`   —— 问了，也答了
   *   `unanswered` —— 问了，但没有答复落盘（在途 / 崩溃 / 进程被重启）
   *   `orphan`     —— 只有答复没有提问（写入被腰斩；出现即说明有问题）
   */
  state: 'answered' | 'unanswered' | 'orphan'
  user: TranscriptLine | null
  assistant: TranscriptLine | null
}

export interface TranscriptPage {
  /** 最近的一批轮次，时间**从新到旧**。 */
  turns: TranscriptTurn[]
  /**
   * 读不到的原因。`null` 表示**真的读到了**（哪怕 0 条）。
   * ★ `null` 与"0 条"是两件事：前者是"记录是空的"，后者才可能是"读不到"。
   */
  unreadable: string | null
  /** 解析失败的行数。> 0 必须在界面上说出来，不许静默跳过。 */
  badLines: number
  /** 坏在哪（最多 3 条）。只诊断用 —— 没有它，"读坏了"就只能靠猜。 */
  badReasons: string[]
  /** 因为分页而被切掉的更早轮次数（还有更多）。 */
  more: boolean
  /** 本次实际扫了哪些日文件（便于核对"到底读了哪几天"）。 */
  files: string[]
  /** 落盘侧最近一次失败（写不进去时必须能被看见）。 */
  writeFailure: { at: number; reason: string } | null
}

// ─────────────────────────── 写（唯一入口）───────────────────────────

let lastWriteFailure: { at: number; reason: string } | null = null

/** 落盘侧最近一次失败。`null` = 迄今为止没失败过。 */
export function transcriptHealth(): { root: string; writeFailure: { at: number; reason: string } | null } {
  return { root: transcriptDir(), writeFailure: lastWriteFailure }
}

export function resetTranscriptHealth(): void {
  lastWriteFailure = null
}

function truncate(text: string): { text: string; truncated?: boolean; textBytes?: number } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_TEXT_BYTES) return { text }
  // 按字节切会切开多字节字符 —— 用 Buffer 切完再解回来，多余的半个字符会被
  // 替换成 U+FFFD。宁可留一个替换符，也不要产生一个"看着正常但已经不是原话"的字符串。
  const cut = Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8')
  return { text: cut, truncated: true, textBytes: bytes }
}

/**
 * 追加一行。**写失败绝不抛**（见文件头红线），但要记在 `lastWriteFailure` 里。
 * 返回是否写成功 —— 调用方不需要据此改行为，但测试可以据此断言。
 */
function append(line: TranscriptLine): boolean {
  const dir = transcriptDir()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, transcriptFileName(line.at)), JSON.stringify(line) + '\n', 'utf8')
    return true
  } catch (e) {
    lastWriteFailure = { at: Date.now(), reason: e instanceof Error ? e.message : String(e) }
    return false
  }
}

export interface UserTurnInput {
  sid: string
  turnId: number
  text: string
  at: number
  attachments?: { name: string; mimeType: string; bytes: number }[]
}

export function recordUserTurn(input: UserTurnInput): boolean {
  const t = truncate(input.text)
  return append({
    at: input.at,
    sid: input.sid,
    turnId: input.turnId,
    role: 'user',
    text: t.text,
    ...(t.truncated ? { truncated: true, textBytes: t.textBytes } : {}),
    ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
  })
}

export interface AssistantTurnInput {
  sid: string
  turnId: number
  text: string
  at: number
  gen: number
  /** 这条答复有没有真的被念出来。`false` = 被打断作废。 */
  dropped: boolean
  /** 作废原因（见 `TranscriptLine.dropReason`）。 */
  dropReason?: 'generation' | 'turn'
  intent?: string
}

export function recordAssistantTurn(input: AssistantTurnInput): boolean {
  const t = truncate(input.text)
  return append({
    at: input.at,
    sid: input.sid,
    turnId: input.turnId,
    role: 'assistant',
    text: t.text,
    ...(t.truncated ? { truncated: true, textBytes: t.textBytes } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    gen: input.gen,
    dropped: input.dropped,
    ...(input.dropReason ? { dropReason: input.dropReason } : {}),
  })
}

/**
 * 补记意图。
 *
 * 追加不是改写 —— 意图解析发生在 `beginTurn` 之后，而我们已经把用户那句话
 * 写下去了。这里补一行 `intent` 记录，读取时按 `(sid, turnId)` 合并。
 * 这样"追加顺序 = 事件顺序"这条性质不会被破坏（判据：不改写已提交的行）。
 */
export function recordTurnIntent(sid: string, turnId: number, intent: string, at: number): boolean {
  return append({ at, sid, turnId, role: 'user', text: '', intent })
}

// ─────────────────────────── 读（唯一入口）───────────────────────────

function listDayFiles(): { name: string; at: number }[] {
  const dir = transcriptDir()
  const out: { name: string; at: number }[] = []
  for (const name of readdirSync(dir)) {
    const m = /^turns-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
    if (!m) continue
    out.push({ name, at: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime() })
  }
  // 新的排前面，翻页时优先看最近的
  return out.sort((a, b) => b.at - a.at)
}

/**
 * 读一页对话。
 *
 * ★ 三态分明（判据 24：缺数据要说出来）：
 *   ① 目录不存在 ⇒ `unreadable: null` + 0 条 —— 这是**真的没聊过**，不是错误；
 *   ② 目录在但读不了 ⇒ `unreadable: '<原因>'` —— 这是**读不到**，与 ① 不同；
 *   ③ 有行解析不了 ⇒ `badLines > 0` —— 这是**部分读到了**，更不该沉默。
 */
export function readTranscript(opts: { limit?: number; beforeAt?: number; days?: number } = {}): TranscriptPage {
  const limit = Math.max(1, Math.min(500, opts.limit ?? DEFAULT_PAGE))
  const days = Math.max(1, Math.min(90, opts.days ?? 7))
  const dir = transcriptDir()

  if (!existsSync(dir)) {
    return { turns: [], unreadable: null, badLines: 0, badReasons: [], more: false, files: [], writeFailure: lastWriteFailure }
  }

  let names: { name: string; at: number }[]
  try {
    names = listDayFiles()
  } catch (e) {
    return {
      turns: [],
      unreadable: e instanceof Error ? e.message : String(e),
      badLines: 0,
      badReasons: [],
      more: false,
      files: [],
      writeFailure: lastWriteFailure,
    }
  }

  const scanned = names.slice(0, days)
  const lines: TranscriptLine[] = []
  let badLines = 0
  const badReasons: string[] = []
  for (const f of scanned) {
    let raw: string
    try {
      raw = readFileSync(join(dir, f.name), 'utf8')
    } catch (e) {
      badLines += 1
      badReasons.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    for (const row of raw.split('\n')) {
      if (row.trim().length === 0) continue
      try {
        const parsed = JSON.parse(row) as TranscriptLine
        if (typeof parsed?.turnId !== 'number' || typeof parsed?.sid !== 'string') throw new Error('缺 sid/turnId')
        lines.push(parsed)
      } catch (e) {
        badLines += 1
        if (badReasons.length < 3) badReasons.push(e instanceof Error ? e.message : String(e))
      }
    }
  }

  // 配对：键是 sid+turnId（见文件头红线）
  const grouped = new Map<string, TranscriptTurn>()
  for (const line of lines) {
    const key = `${line.sid}#${line.turnId}`
    let turn = grouped.get(key)
    if (!turn) {
      turn = { sid: line.sid, turnId: line.turnId, at: line.at, state: 'unanswered', user: null, assistant: null }
      grouped.set(key, turn)
    }
    turn.at = Math.min(turn.at, line.at)
    if (line.role === 'assistant') {
      turn.assistant = line
    } else if (line.text.length > 0) {
      // 只有带正文的 user 行才算"提问"；补记意图的空正文行只贡献 intent
      turn.user = turn.user ? { ...turn.user, ...(line.intent ? { intent: line.intent } : {}) } : line
    } else if (line.intent) {
      if (turn.user) turn.user = { ...turn.user, intent: line.intent }
      else if (turn.assistant) turn.assistant = { ...turn.assistant, intent: line.intent }
    }
  }

  const all = [...grouped.values()].sort((a, b) => b.at - a.at || b.turnId - a.turnId)
  const filtered = opts.beforeAt === undefined ? all : all.filter((t) => t.at < opts.beforeAt!)

  const page = filtered.slice(0, limit).map((t) => ({
    ...t,
    state: (t.user && t.assistant ? 'answered' : t.user ? 'unanswered' : 'orphan') as TranscriptTurn['state'],
  }))

  return {
    turns: page,
    unreadable: null,
    badLines,
    badReasons: badReasons.slice(0, 3),
    more: filtered.length > page.length,
    files: scanned.map((s) => s.name),
    writeFailure: lastWriteFailure,
  }
}
