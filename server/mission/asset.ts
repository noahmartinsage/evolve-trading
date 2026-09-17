/**
 * 任务资产：把一次「目标 → 裁定 → 执行」变成**可引用、可交接、不可静默替换**的东西
 *
 * ── 本模块内化自 AgentGit（https://github.com/Einsia/agent-git）的四处设计 ──
 *
 * ① **身份 = 内容地址，且 id 不写进被哈希的内容里。**
 *    AgentGit 的快照 id 就是 git commit SHA —— 它覆盖 parent→tree→blobs 全树，
 *    改一个字节就换 id，而 id 本身**不写进 meta.json**（自指会引入第二层哈希）。
 *    对应到本项目：`planId` 由「影响结论的字段」算出，并显式**排除原文 `raw`**。
 *    排除原文不是省事 —— 是让"同一件事换个说法"映射到同一个 id，
 *    否则引用会碎成一堆语义相同、id 不同的副本，等于没有引用。
 *
 * ② **密钥在离开机器的边缘就被抹掉，而不是到了目的地再检查。**
 *    AgentGit 的 supervisor 在把帧交给 journal 与 WSS **之前**就地脱敏，
 *    原文永不先到达 hub。本项目的对应动作是：任务资产可能被导出、
 *    被念出来、被上屏、被交给别的 agent，所以脱敏必须在**资产构造时**发生，
 *    而不是在导出函数里 —— 后者一定会漏掉某条新加的出口。
 *
 * ③ **不做"高熵即密钥"的猜测，只做已知格式 + 显式登记。**
 *    AgentGit 明确拒绝把短口令/易记短语当密钥（误报风暴），改为让用户**显式登记**。
 *    这一条对本项目尤其致命：我们的资产里大量出现 40 位十六进制内容地址
 *    （就是本模块自己的 id）、以及 `dataHash` 这类哈希值 ——
 *    任何基于熵值的判据都会把它们全部标成密钥，**在完全正确的资产上疯狂报红**。
 *    这与本项目已经踩过的那次"文档表格列数校验器把转义竖线当分隔符"
 *    是同一类错误：先修检查器，再相信它的红。
 *
 * ④ **一分支一会话，永不换手 —— 因为静默替换是不可被发现的。**
 *    AgentGit 原文：`Once a session occupies a branch, that branch never changes hands.`
 *    理由是引用者无法察觉被引用的东西已经变成另一段对话。
 *    对应到本项目：**一份裁定书只能绑定一条执行线**。
 *    「引用的是 10U→100U 那次评估，实际跑的是另一次实验」是这一层必须堵死的失效。
 *
 * ⑤ **仅追加 = 已提交序列必须是实时序列的前缀。**
 *    AgentGit 的 commit 要求"信封哈希序列是实时可解析行哈希序列的前缀"，
 *    中间有任何改动就在**碰盘之前**拒绝。
 *    本项目的账本已是仅追加，任务步骤流沿用同一判据。
 */
import { createHash } from 'node:crypto'

// ─────────────────────────── 内容寻址 ───────────────────────────

/**
 * 规范化 JSON：按键名排序、剔除 undefined。
 *
 * 为什么不能直接用 `JSON.stringify`：对象键序在 JS 里是**插入顺序**，
 * 于是同样的内容由两条代码路径构造出来会得到不同的字符串与不同的哈希 ——
 * 而哈希不稳定等于内容寻址失效（引用会对不上自己）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

/**
 * 内容地址：`前缀-` + sha256(规范 JSON) 前 40 位。
 *
 * 40 位而不是完整 64 位：与 AgentGit 的 `agit-` + 40 位一致，
 * 也刚好是 git short-hash 的量级，念得出来、贴得进聊天记录。
 */
export function missionContentId(value: unknown, prefix = 'm'): string {
  const h = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
  return prefix + '-' + h.slice(0, 40)
}

// ─────────────────────────── 边缘脱敏 ───────────────────────────

/** 已知格式的密钥规则。**不做熵值猜测** —— 理由见文件头 ③。 */
const KNOWN_FORMAT_RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'agit-token', re: /\bagit_[0-9a-f]{64}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  { name: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
]

const REDACTED = '[redacted:registered-secret]'

/**
 * 环境变量名里被认为**装着密钥**的那些。
 *
 * 判据刻意只认**名字**，不认值的长相：我们无法从内容判断一个字符串是不是密钥
 * （这就是熵值判据必然误报的根因），但我们**知道**哪个环境变量是干什么的。
 */
const SECRET_KEY_NAME_RE = /(API_?KEY|API_?SECRET|SECRET_?KEY|PASSPHRASE|_TOKEN|ACCESS_?TOKEN|PRIVATE_?KEY|MNEMONIC|_SEED|WEBHOOK_?URL)/i

/**
 * 最短可登记长度（UTF-8 字节）。
 *
 * 4 是硬下限：再短的串（如 `1`、`true`、`ok`）会匹配到几乎任何文本，
 * 于是**在完全正确的资产上把所有内容抹成占位符**。
 * AgentGit 取的是"默认最小 8 字节，4~7 需显式确认"，本项目更保守地取 4 并拒登记。
 */
const MIN_REGISTERED_BYTES = 4

export interface SecretRegistry {
  /** 已登记的密钥字面量与其来源变量名。**值绝不出现在任何返回结构里。** */
  entries: Array<{ keyName: string; bytes: number; value: string }>
  /** 因过短被**拒绝登记**的变量名。必须可观测 —— 静默拒绝等于没有保护。 */
  refused: Array<{ keyName: string; bytes: number; reason: string }>
}

/**
 * 从当前进程环境构建登记表。
 *
 * ⚠️ 返回值里的 `value` 字段是**内存内的匹配用字面量**，
 * 调用方（`redactSecrets`）用完即弃，**不得写进日志、事件、响应体**。
 * 这一点由 S-M7 断言钉住：脱敏后的文本里不得含任何登记值。
 */
export function buildSecretRegistry(env: Record<string, string | undefined> = process.env): SecretRegistry {
  const entries: SecretRegistry['entries'] = []
  const refused: SecretRegistry['refused'] = []
  for (const [keyName, raw] of Object.entries(env)) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (!SECRET_KEY_NAME_RE.test(keyName)) continue
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes < MIN_REGISTERED_BYTES) {
      refused.push({ keyName, bytes, reason: 'SHORTER_THAN_' + MIN_REGISTERED_BYTES + '_BYTES' })
      continue
    }
    entries.push({ keyName, bytes, value: raw })
  }
  return { entries, refused }
}

export interface RedactReport {
  text: string
  /** 命中次数（按**实例**计，重叠已合并）。 */
  hits: number
  /** 命中的是哪些**规则名/变量名**。**永远只有名字，没有值。** */
  hitNames: string[]
  /** 过短被拒登记的变量名 —— 它们是"未受保护面"的诚实披露。 */
  refusedNames: string[]
}

/**
 * 边缘脱敏。
 *
 * 重叠命中按**出现顺序**替换即可：登记值来自不同的环境变量，
 * 实际互相包含的情形（一个 token 是另一个的前缀）罕见且无害 ——
 * 先替换掉的那个已经变成占位符，第二个不会再匹配到原文。
 * 刻意不引入"按字节范围合并"的复杂度：那是为流式缓冲准备的，
 * 资产构造是一次性全文，用不上。
 */
export function redactSecrets(text: string, registry: SecretRegistry = buildSecretRegistry()): RedactReport {
  let out = text
  const hitNames: string[] = []
  let hits = 0

  for (const rule of KNOWN_FORMAT_RULES) {
    const matches = out.match(rule.re)
    if (matches && matches.length > 0) {
      hits += matches.length
      hitNames.push(rule.name)
      out = out.replace(rule.re, REDACTED)
    }
  }

  // 登记值按**长度降序**替换：长的先吃掉，避免短的是长的子串时留下残尾。
  const sorted = [...registry.entries].sort((a, b) => b.value.length - a.value.length)
  for (const e of sorted) {
    if (!out.includes(e.value)) continue
    let count = 0
    let idx = out.indexOf(e.value)
    while (idx >= 0) {
      count += 1
      idx = out.indexOf(e.value, idx + e.value.length)
    }
    hits += count
    hitNames.push(e.keyName)
    out = out.split(e.value).join(REDACTED)
  }

  return { text: out, hits, hitNames, refusedNames: registry.refused.map((r) => r.keyName) }
}

// ─────────────────────── 一任务一执行线 ───────────────────────

export interface MissionLine {
  planId: string
  runId: string
  boundAt: number
}

export type BindOutcome = { ok: true; line: MissionLine } | { ok: false; reason: string; existing: MissionLine }

/**
 * 把裁定书绑定到一条执行线。
 *
 * **绑定后不可换手。** 想改方向就另开一条执行线（对应 AgentGit 的
 * `To change direction, open a new branch; the old one stays.`），
 * 而不是把已发布的引用指到另一次实验上 —— 后者引用者无法察觉。
 */
export function bindMissionLine(planId: string, runId: string, existing: MissionLine | null, now: number): BindOutcome {
  if (existing && existing.planId === planId && existing.runId !== runId) {
    return {
      ok: false,
      reason:
        'MISSION_LINE_ALREADY_BOUND（这份裁定书已绑定执行线 ' + existing.runId + '）。' +
        '已发布的引用不可换手 —— 要改方向请对同一个目标重新裁定（会得到新的 planId）。',
      existing,
    }
  }
  if (existing && existing.planId === planId && existing.runId === runId) {
    return { ok: true, line: existing }
  }
  return { ok: true, line: { planId, runId, boundAt: now } }
}

// ─────────────────────── 仅追加：前缀校验 ───────────────────────

export type AppendOnlyVerdict =
  /** 已提交序列是实时序列的前缀 —— 一致。 */
  | 'prefix'
  /** 已提交序列超过了实时序列 —— 不可能，说明实时序列被回退或被替换了。 */
  | 'ahead'
  /** 中间分岔。 */
  | 'diverged'

/**
 * 仅追加序列的一致性判定。
 *
 * 判据与 AgentGit 的 `agit commit` 同形：**已提交的哈希序列必须是实时序列的前缀**。
 * 中间任何一处不同都意味着有人改写了历史，而不是"追加了新内容"。
 *
 * 为什么比较哈希而不是比较原始字节：原始字节里空格、换行、编码的差异
 * 都会造成假分岔；哈希比对的是**语义内容**（这正是内容寻址的用途）。
 */
export function appendOnlyVerdict(committed: readonly string[], live: readonly string[]): AppendOnlyVerdict {
  if (committed.length > live.length) return 'ahead'
  for (let i = 0; i < committed.length; i += 1) {
    if (committed[i] !== live[i]) return 'diverged'
  }
  return 'prefix'
}
