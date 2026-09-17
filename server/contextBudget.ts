/**
 * 上下文预算 —— 把「塞进提示词的东西」变成可计量、可裁剪、可审计的。
 *
 * ══ 它解决什么问题 ═══════════════════════════════════════════════════
 * 2026-09 的情报把「上下文经济」列为 AI Coding 的第一关切：
 * token 压缩、按需渐进加载（progressive disclosure）、
 * 「优化上下文窗口，其余一切持久化」。
 *
 * 对本项目而言这不是成本问题，而是**正确性问题**。
 * 决策提示词的构成是：候选网格 Top3 + 本周期风险预算 + 交易成本口径 + 进化心法 + 数据来源说明……
 * 而「进化心法」这一项**会随自进化持续增长**。于是会出现这样一条演进路径：
 *
 *   第 1 周：提示词 800 token，模型看得清全部约束；
 *   第 6 周：心法累积到 40 条，提示词 6000 token，风险预算被挤到中段；
 *   第 12 周：提示词被静默截断（或被服务端截断），**风险预算块整块消失**，
 *            模型开始按「无约束」提案，而日志上一切正常。
 *
 * 最后那一步是本类系统最典型的失效方式：**能力被静默降级，而没有任何地方记录这件事。**
 * 所以这里的原则是：
 *
 *   ① **强制块不可丢弃。** 风险预算、成本口径这类「模型必须看到」的内容标为 mandatory，
 *      一旦放不下就**整体失败**（`ok: false`），而不是把别的块挤掉后偷偷少给一条约束。
 *      宁可不发这次请求，也不要发一个约束不完整的请求。
 *   ② **丢弃必须报告。** `droppedIds` / `truncatedIds` 是返回值的一部分，
 *      调用方要把它们写进事件流。静默丢弃 = 不可观测的能力降级。
 *   ③ **裁剪按行，不按字符。** 从中间切断句子会产出半截约束
 *      （「……止损几何：结构失效点之外 1.8x」），比不给还危险。
 */

export interface ContextBlock {
  id: string
  /** 优先级：数字越小越先保留。同优先级按 id 字典序（保证同输入同输出）。 */
  priority: number
  text: string
  /** 超预算时是否允许按行截断保留前半部分。 */
  truncatable?: boolean
  /** 强制块：永不裁剪、永不丢弃；放不下则整体失败。 */
  mandatory?: boolean
}

export interface AssembledContext {
  text: string
  includedIds: string[]
  droppedIds: string[]
  truncatedIds: string[]
  estimatedTokens: number
  budgetTokens: number
  ok: boolean
  /** 强制块放不下时的说明。`ok === false` 时必然有值。 */
  failureReason?: string
}

/** 默认预算。刻意留出余量：估算值本身是保守上界，不是真值。 */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 1800

/** 截断标记。它本身也要占预算，所以参与裁剪计算。 */
const TRUNCATION_MARKER = (droppedLines: number): string => `…（本块已截断 ${droppedLines} 行，完整内容见服务端日志）`

/**
 * 估算 token 数（确定性、离线、无依赖）。
 *
 * 规则：CJK 字符按 1 token / 字，其余字符按 1 token / 3 字符。
 *
 * **这不是精确值，偏差方向也不单一** —— 说它是「保守上界」会误导人，
 * 所以这里如实说明：
 *   - 对**中文密集**文本：中文 BPE 平均约 1 token/字，罕见字更高。估算与真实值接近，
 *     偏向略低。因此预算要留出余量，不要按估算值顶格配置。
 *   - 对 **ASCII 密集**文本：取 1/3 而非常见的 1/4，偏向略高。
 * 本模块的用途是「防止上下文无界增长」，不是「精确计费」。
 * 需要精确值时应当由真实的 tokenizer 覆盖本函数，而不是把这里的系数调到「看起来准」。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、扩展区、日文假名、全角标点
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 3)
}

/** 把一段可裁剪文本裁到不超过 `budget` token，按行裁。 */
function truncateToBudget(text: string, budget: number): { text: string; droppedLines: number } {
  const lines = text.split('\n')
  if (estimateTokens(text) <= budget) return { text, droppedLines: 0 }

  // 从后往前丢行，直到「正文 + 标记」放得下
  let keep = lines.length
  while (keep > 0) {
    const candidate = lines.slice(0, keep).join('\n')
    const marker = TRUNCATION_MARKER(lines.length - keep)
    if (estimateTokens(candidate) + estimateTokens(marker) <= budget) {
      return { text: `${candidate}\n${marker}`, droppedLines: lines.length - keep }
    }
    keep -= 1
  }
  return { text: '', droppedLines: lines.length }
}

/**
 * 组装上下文。
 *
 * 算法（两步，顺序不可交换）：
 *   第 1 步：先给**强制块**留位。预留制而不是「边填边看」——
 *            边填边看会让强制块的存活依赖于它前面恰好没有大块，
 *            即「能不能看到风控约束」取决于心法库的大小，这是不可接受的耦合。
 *   第 2 步：其余块按 (priority, id) 升序装入；装不下时先尝试按行截断，再考虑丢弃。
 */
export function assembleContext(blocks: ContextBlock[], budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS): AssembledContext {
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  const mandatory = sorted.filter((b) => b.mandatory)
  const optional = sorted.filter((b) => !b.mandatory)

  const mandatoryTokens = mandatory.reduce((a, b) => a + estimateTokens(b.text), 0)
  if (mandatoryTokens > budgetTokens) {
    // 强制块放不下 → 整体失败。绝不「少给一条约束然后继续」。
    return {
      text: '',
      includedIds: [],
      droppedIds: sorted.map((b) => b.id),
      truncatedIds: [],
      estimatedTokens: 0,
      budgetTokens,
      ok: false,
      failureReason:
        `强制块合计 ${mandatoryTokens} token 已超出预算 ${budgetTokens} token` +
        `（强制块：${mandatory.map((b) => b.id).join(', ')}）。` +
        '这里刻意选择「整体失败」而不是「丢掉几条约束继续」——' +
        '一个缺少风控口径的提案请求，比一个没有发出的请求危险得多。',
    }
  }

  const included: string[] = []
  const truncated: string[] = []
  const dropped: string[] = []
  /** id → 最终文本。用 Map 而不是平行数组：平行数组在插入顺序变化时会错位。 */
  const rendered = new Map<string, string>()
  let used = mandatoryTokens

  for (const b of mandatory) {
    included.push(b.id)
    rendered.set(b.id, b.text)
  }

  for (const b of optional) {
    const cost = estimateTokens(b.text)
    if (used + cost <= budgetTokens) {
      included.push(b.id)
      rendered.set(b.id, b.text)
      used += cost
      continue
    }
    const remain = budgetTokens - used
    if (b.truncatable && remain > 40) {
      const t = truncateToBudget(b.text, remain)
      if (t.text) {
        included.push(b.id)
        truncated.push(b.id)
        rendered.set(b.id, t.text)
        used += estimateTokens(t.text)
        continue
      }
    }
    dropped.push(b.id)
  }

  // 输出顺序按原优先级（而非「强制块一律在前」），保持给模型阅读的逻辑连贯性
  const keptIds = new Set(included)
  const orderedIds = sorted.filter((b) => keptIds.has(b.id)).map((b) => b.id)

  return {
    text: orderedIds.map((id) => rendered.get(id) ?? '').join('\n\n'),
    includedIds: orderedIds,
    droppedIds: dropped,
    truncatedIds: truncated,
    estimatedTokens: used,
    budgetTokens,
    ok: true,
  }
}

/**
 * 渲染预算执行报告（一行）。调用方应把它写进事件流 ——
 * 「这一轮提示词有没有被裁」必须是可回溯的事实，而不是只有出问题时才被想起的问题。
 */
export function renderBudgetReport(a: AssembledContext): string {
  if (!a.ok) return `上下文预算：**组装失败** —— ${a.failureReason ?? '未知原因'}`
  const bits = [`${a.estimatedTokens}/${a.budgetTokens} token`, `纳入 ${a.includedIds.length} 块`]
  if (a.truncatedIds.length > 0) bits.push(`截断 ${a.truncatedIds.join('、')}`)
  if (a.droppedIds.length > 0) bits.push(`丢弃 ${a.droppedIds.join('、')}`)
  return `上下文预算：${bits.join(' · ')}`
}
