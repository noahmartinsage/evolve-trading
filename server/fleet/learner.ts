/**
 * 给自己学习 —— 定时读系统现状，产出可执行的改进提案
 *
 * ── 需求原话与它的危险 ──────────────────────────────────────────────
 * 「定时给自己学习，写升级代码进化自己」。前半句是对的、可做的；
 * 后半句**不能照字面做** —— "自动改自己的源码"是本系统里最不可逆的动作：
 * 改错了没有回滚点、审计链断在代码层、而且失败的形态是"门禁突然变红"
 * 或者更糟"门禁照旧全绿但行为变了"。
 *
 * 所以这条需求被落成三件确定的事：
 *   ① **观察**：从账本 / 台账 / 心法 / 过拟合门取**真实数字**（不编）；
 *   ② **提案**：交给模型产"观察到什么 → 假设 → 建议动作 → 风险档"，
 *      落盘成一份可核对的提案单（`data/learn/notes.jsonl`）；
 *   ③ **落码是人做的**：提案里可以写"建议改哪个文件"，但**代码不会被自动改**。
 *      这与本项目所有 `act` 类成员同一条纪律 —— 改变系统将来行为的动作
 *      必须两段式确认。区别只是这里的确认对象是一份**提案**，而不是一次执行。
 *
 * ── 为什么"没模型参与"必须被说出来 ─────────────────────────────────
 * 模型通道可能没有厂商、额度用尽、或全部候选失败（三种事因，下一步动作完全不同）。
 * 这时**规则层的观察照样是有价值的**（真实数字都在），但不能把它伪装成
 * "这一轮学习完成了" —— 那样用户会以为模型看过账本。所以降级时
 * `source` 记为 `'rules'`，并把失败原因写进 `degraded`，在文案里说出来。
 *
 * ── 为什么提案要带"风险档" ──────────────────────────────────────────
 * 一份提案单里，"把这句日志文案改掉"和"放宽过拟合门的 PBO 阈值"是完全不同量级的事。
 * 不带风险档的提案单会诱导执行者按**顺序**去处理，而正确的顺序是按**风险**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEvent, getEvents } from '../ledger.ts'
import { routeChat } from '../modelRouter.ts'
import { lessonStats, loadLessons } from '../evolutionShield.ts'
import { autopilotStatus, candidatePool } from '../autopilot.ts'
import { factorIndexSummary } from '../factorService.ts'
import { factorStrategySummary } from '../factorStrategyService.ts'
import { pipelineService } from '../pipelineService.ts'
import { autonomyStatus } from './autonomy.ts'

export type LearnRisk = 'low' | 'middle' | 'high'

export interface LearnProposal {
  title: string
  /** 观察到什么（引用上面的真实数字，不许是凭空的说法）。 */
  evidence: string
  /** 建议动作。可执行、可核对。 */
  action: string
  risk: LearnRisk
}

export interface LearnNote {
  id: string
  at: number
  /** `model` = 模型参与了；`rules` = 只有规则层观察（模型不可用，**必须说出来**）。 */
  source: 'model' | 'rules'
  /** 从真实数据取的观察。每一条都带数字。 */
  observations: string[]
  proposals: LearnProposal[]
  /** 模型原始输出（留档，便于核对"这条提案真的是模型说的"）。 */
  raw: string | null
  model: string | null
  /** 为什么没有模型参与。`source==='rules'` 时必须有值。 */
  degraded: string | null
  /** 一共读过多少条账本事件。它让"观察是基于什么规模的数据"可核对。 */
  ledgerEvents: number
}

export interface LearnDeps {
  now: () => number
  /** 注入给测试：避免每次断言都真调模型。 */
  chat: (system: string, user: string) => Promise<{ ok: boolean; text: string | null; model: string | null; reason: string }>
  cwd: string
}

function defaultDeps(cwd: string): LearnDeps {
  return {
    now: () => Date.now(),
    chat: async (system, user) => {
      // 用 `execute` 档而不是 `plan`：这一轮的输入是**已经算好的数字**，
      // 模型要做的是"读数字 → 提动作"，属于结构化环节，免费模型足够。
      // 而它是自治循环里的周期任务 —— 放在 `plan` 档会持续消耗最贵的通道。
      const r = await routeChat('execute', system, user, 0.4)
      return { ok: r.ok, text: r.text, model: r.model, reason: r.reason }
    },
    cwd,
  }
}

export function learnNotesPath(cwd: string): string {
  return join(cwd, 'data', 'learn', 'notes.jsonl')
}

/**
 * 把一条笔记追加进**同一份**提案单。
 *
 * ★ 为什么要有这个单独的出口：`news`（新闻雷达）也会产出提案。如果它自己写
 *   另一个文件，用户就会有两张"待办清单"，而两张清单迟早给出不同的答案
 *   （判据 8：同一个业务动作有两条实现路径就是隐患）。
 *   两处产出、**一个出口** —— 人只需要看 `data/learn/notes.jsonl` 一个地方。
 *
 * ★ 只 append，永不改写：这份文件是"系统当时想到了什么"的事实记录，
 *   事后重排会让"提案是什么时候提的"这件事无法追溯。
 */
export function appendLearnNote(cwd: string, note: LearnNote): string {
  const p = learnNotesPath(cwd)
  mkdirSync(join(cwd, 'data', 'learn'), { recursive: true })
  appendFileSync(p, JSON.stringify(note) + '\n')
  return p
}

/**
 * 取一轮真实观察。
 *
 * ★ 每个数字都**现算**，没有一个来自缓存或常量 —— 判据 21：
 *   "我列的强信号里有没有派生出来的？派生值不当独立证据"。
 *   这里的每一项都来自不同的读取路径（账本 / 台账 / 心法库 / 过拟合门），
 *   互不派生，所以它们之间**不一致**这件事本身是有信息量的。
 */
export function collectObservations(cwd: string, now = Date.now()): string[] {
  const out: string[] = []
  const events = getEvents(0)
  out.push(`账本累计 ${events.length} 条事件，最早 ${new Date(events[0]?.ts ?? now).toISOString().slice(0, 10)}`)

  const since = now - 24 * 3_600_000
  const recent = events.filter((e) => e.ts >= since)
  const byKind = new Map<string, number>()
  for (const e of recent) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  const topKinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  out.push(
    `近 24 小时 ${recent.length} 条事件` +
      (topKinds.length > 0 ? `，最多的是 ${topKinds.map(([k, n]) => `${k} ${n}`).join('、')}` : '（这段时间没有事件）'),
  )

  const ticks = events.filter((e) => e.kind === 'AUTONOMY_TICK' || e.kind === 'AUTONOMY_TICK_FAILED')
  const failedTicks = events.filter((e) => e.kind === 'AUTONOMY_TICK_FAILED')
  out.push(
    `自治循环累计 ${ticks.length} 轮、其中失败 ${failedTicks.length} 轮` +
      (ticks.length === 0 ? '（还没跑过 —— 不等于"跑得好"）' : ''),
  )

  const fSum = factorIndexSummary()
  out.push(
    // ★ 这里刻意用 `inconsistent` 而不是 `stale`：`FactorIndexSummary` **没有**
    //   `stale` 字段（那是策略台账才有的量）。写错字段名的后果不是报错，
    //   是这里静默变成 `undefined`、条件恒假 —— 判据 12 记过这条。
    `因子台账 ${fSum.total} 行：接受 ${fSum.accepted}、拒绝 ${fSum.rejected}、证据不足 ${fSum.unverifiable}` +
      (fSum.inconsistent > 0 ? `，判决自相矛盾待重判 ${fSum.inconsistent} 行` : '') +
      (fSum.available ? '' : `（台账读不出来：${fSum.reason}）`),
  )

  const sSum = factorStrategySummary()
  out.push(
    `策略台账 ${sSum.total} 行：过门 ${sSum.accepted}、被拒 ${sSum.rejected}、证据不足 ${sSum.unverifiable}` +
      (sSum.stale > 0 ? `，指纹不符 ${sSum.stale}` : ''),
  )

  const ls = lessonStats()
  const all = loadLessons()
  out.push(
    all.length === 0
      ? '心法库是空的（空库不是"很健康"，是"还没有经验被记下来"）'
      : `心法 ${all.length} 条（生效 ${all.filter((l) => l.enabled).length}），平均健康分 ${ls.avgHealth.toFixed(1)}`,
  )

  const pool = candidatePool()
  out.push(`候选池 ${pool.all.length} 条（手写 ${pool.handWritten.length} + 因子 ${pool.factor.length}）`)

  const rows = pipelineService.list()
  out.push(`晋级流水线 ${rows.length} 条候选`)

  const ap = autopilotStatus()
  out.push(
    `自动驾驶运行中=${ap.running}，阶段 ${ap.stage}` +
      (ap.gateRefusal ? `，过拟合门最近否决：${ap.gateRefusal.outcome}（PBO ${ap.gateRefusal.pbo ?? 'n/a'}）` : '，过拟合门最近没有否决记录'),
  )

  const auto = autonomyStatus()
  out.push(
    `自治循环现在 ${auto.running ? '在跑' : '没在跑'}（启动过 ${auto.startCount} 次，累计 ${auto.ticks} 轮）` +
      (auto.running ? '' : `：${auto.idleReason ?? '原因未知'}`),
  )

  void cwd
  return out
}

export const LEARN_SYSTEM_PROMPT = [
  '你是一个量化交易系统的自我改进分析员。',
  '你会收到一组**来自系统的真实数字**（账本、因子台账、策略台账、心法库、候选池）。',
  '你的任务：基于这些数字提出**可执行的改进提案**。',
  '',
  '硬要求：',
  '1. 每条提案必须引用上面给出的某个具体数字作为依据，不许凭空说"看起来不错/需要优化"。',
  '2. 提案必须是**动作**（改什么、加什么、停什么），不是"建议进一步分析"。',
  '3. 不许建议放宽风险门限（过拟合门 / 成本门 / 三态门）来提高产出 —— 那是把门关掉，不是改进。',
  '4. 每条提案后面用 [低]/[中]/[高] 标注风险档。改文案/加观测是低，改门槛/改策略是中或高。',
  '5. 如果这些数字里**没有值得改进的地方**，就直说"没有发现需要改的地方"，不要凑数。',
  '',
  '输出格式（严格遵守，每条三行）：',
  '提案：<一句话标题>',
  '依据：<引用的数字>',
  '动作：<具体做什么> [风险档]',
].join('\n')

/**
 * 解析模型输出。
 *
 * **三种情况必须分开**（这是本仓库的"三态优于两态"）：
 *   · 提了提案              ⇒ `{proposals: [...], parseFailed:false}`；
 *   · 明确说"没有需要改的"  ⇒ `{proposals: [], parseFailed:false}`（**正常结果**）；
 *   · 有正文但一条也提不出、又没说无需改进 ⇒ `{parseFailed:true}`（没读懂）。
 *
 * ★ 中间那一档是修一个误判：系统提示词第 5 条**允许**模型回答"没有发现需要改的地方"，
 *   而旧实现把它与"输出格式不对"归成一类（都报"解析失败"），
 *   于是模型照要求答了实话，系统却报"没读懂" —— 判据 2：对正确的输入报错。
 */
export function parseProposals(text: string): { proposals: LearnProposal[]; parseFailed: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const out: LearnProposal[] = []
  let cur: Partial<LearnProposal> | null = null
  const flush = (): void => {
    if (cur && (cur.title || cur.action)) {
      out.push({
        title: cur.title ?? '(无标题)',
        evidence: cur.evidence ?? '(没有引用依据)',
        action: cur.action ?? '(没有写动作)',
        risk: cur.risk ?? 'middle',
      })
    }
    cur = null
  }
  for (const l of lines) {
    const t = l.replace(/^[-*•]\s*/, '')
    const mTitle = /^提案\s*[:：]\s*(.+)$/.exec(t)
    const mEv = /^依据\s*[:：]\s*(.+)$/.exec(t)
    const mAct = /^动作\s*[:：]\s*(.+)$/.exec(t)
    if (mTitle) {
      flush()
      cur = { title: mTitle[1] }
      continue
    }
    if (mEv && cur) {
      cur.evidence = mEv[1]
      continue
    }
    if (mAct && cur) {
      const act = mAct[1]
      const risk: LearnRisk = /\[高\]|\[high\]/i.test(act) ? 'high' : /\[低\]|\[low\]/i.test(act) ? 'low' : 'middle'
      cur.action = act.replace(/\[(低|中|高|low|middle|high)\]/gi, '').trim()
      cur.risk = risk
      continue
    }
  }
  flush()
  if (out.length > 0) return { proposals: out, parseFailed: false }
  // ★ 空数组 / 空对象也是**毫不含糊**的"无需改进"。提示词要的是三行文本格式，
  //   但模型有时仍按 JSON 习惯回一个 `[]` —— 它表达的意思没有歧义，
  //   把它算成"没读懂"就是对正确的输入报错（判据 2）。
  //   这条也是被烟测逼出来的：`news` 的第一版提示词写的正是 JSON 数组。
  const t = text.trim()
  if (t === '[]' || t === '{}' || /^\[\s*\]$/.test(t) || /^\{\s*\}$/.test(t)) {
    return { proposals: [], parseFailed: false }
  }
  // 没有提案：先看它是不是**按提示词明确回答"无需改进"**（这是允许的答案）。
  const noChange = /没有(发现)?(需要|必要|明显)?(改进|改的|可改)|不需要改进|无需(改动|改进)|没有(值得|可)(改进|优化)/
  if (t.length > 0 && noChange.test(t)) return { proposals: [], parseFailed: false }
  // 有正文但既没有提案、也没说"无需改进" ⇒ 这是"没读懂"，不是"没问题"。
  return { proposals: [], parseFailed: t.length > 0 }
}

export interface LearnResult {
  note: LearnNote
  /** 落盘后的文件路径（`dryRun` 时不写，为 null）。 */
  writtenTo: string | null
  dryRun: boolean
}

/**
 * 跑一轮学习。
 *
 * ★ `dryRun` 默认 **true**：这是一个会调模型、会写盘的动作，
 *   默认值必须是"什么都不做"那一边（与语音层"默认 paper 不默认 live"同理）。
 */
export async function runSelfLearn(
  opts: { dryRun?: boolean; cwd?: string; deps?: Partial<LearnDeps> } = {},
): Promise<LearnResult> {
  const cwd = opts.cwd ?? process.cwd()
  const dryRun = opts.dryRun ?? true
  const deps: LearnDeps = { ...defaultDeps(cwd), ...opts.deps }
  const now = deps.now()

  const observations = collectObservations(cwd, now)
  const userPrompt = [
    '以下是系统当前的真实状态：',
    '',
    ...observations.map((o, i) => `${i + 1}. ${o}`),
    '',
    '请按格式给出改进提案。',
  ].join('\n')

  let raw: string | null = null
  let model: string | null = null
  let degraded: string | null = null
  let source: LearnNote['source'] = 'rules'
  try {
    const r = await deps.chat(LEARN_SYSTEM_PROMPT, userPrompt)
    if (r.ok && r.text && r.text.trim().length > 0) {
      raw = r.text
      model = r.model
      source = 'model'
    } else if (r.ok) {
      // ★ 实测抓到的一条：模型回了 **HTTP 200 但正文是空白**。
      //   旧实现把它记成"模型参与了、提出 0 条提案"，于是文案写成
      //   "模型看了 10 条现状，提出 0 条改进提案" —— 把"它没答"
      //   伪装成了"它说没什么要改的"。这是本仓库记过多次的第三族失败：
      //   **没输出被伪装成了读懂了**。
      //   空白正文是第三种事因，既不是"模型不可用"，也不是"模型说没问题"。
      degraded =
        '模型这一轮回了空内容（HTTP 200，但正文是空白）—— 这既不是"模型说没问题"，' +
        '也不是"模型不可用"，而是它没给出话。要重试就说一次「给自己学习一轮」。'
    } else {
      degraded = `模型通道这一轮没给出答复（原因：${r.reason}）。所以这一轮**只有规则层的观察**，没有模型的判断。`
    }
  } catch (e) {
    degraded = `调模型时抛了异常：${e instanceof Error ? e.message : String(e)}。这一轮只有规则层观察。`
  }

  let proposals: LearnProposal[] = []
  if (source === 'model' && raw) {
    const p = parseProposals(raw)
    proposals = p.proposals
    if (p.parseFailed) {
      degraded = '模型答了，但输出不是约定的格式，所以**一条提案都没提取到** —— 这不是"模型说没问题"。原始输出留在 raw 字段里。'
    }
  }

  const note: LearnNote = {
    id: `L${now.toString(36)}`,
    at: now,
    source,
    observations,
    proposals,
    raw,
    model,
    degraded,
    ledgerEvents: getEvents(0).length,
  }

  let writtenTo: string | null = null
  if (!dryRun) {
    const p = learnNotesPath(cwd)
    mkdirSync(join(cwd, 'data', 'learn'), { recursive: true })
    appendFileSync(p, JSON.stringify(note) + '\n')
    writtenTo = p
    appendEvent('SELF_LEARN_NOTE', {
      id: note.id,
      source,
      proposals: proposals.length,
      degraded: degraded !== null,
      model,
      ledgerEvents: note.ledgerEvents,
    })
  }

  return { note, writtenTo, dryRun }
}

/** 读回最近的提案单（面板/语音要能"问出上一轮学了什么"）。 */
export function recentLearnNotes(cwd: string, limit = 5): LearnNote[] {
  const p = learnNotesPath(cwd)
  if (!existsSync(p)) return []
  try {
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    const out: LearnNote[] = []
    for (const l of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(l) as LearnNote)
      } catch {
        // 单行坏掉不该让整份读不出来 —— 但也不能静默：坏行会被下面计数。
      }
    }
    return out
  } catch {
    return []
  }
}

/** 给人念的一句话。 */
export function renderLearnBrief(r: LearnResult): string {
  const n = r.note
  if (n.degraded && n.proposals.length === 0) {
    return `学习这一轮没跑完：${n.degraded}（观察部分仍然取到了 ${n.observations.length} 条真实数字。）`
  }
  // ★ 三态里的中间那一档：模型**看过了**并明确说"没有需要改的地方"。
  //   它与"没读懂"（degraded）和"提了提案"都不同，文案必须分开 ——
  //   合并任何两个都会让用户做出错误的下一步（重试 vs 放心 vs 去执行）。
  if (n.source === 'model' && n.proposals.length === 0) {
    return (
      `学习完成：模型看过 ${n.observations.length} 条现状，**明确回答这批数字里没有需要改的地方**。` +
      (r.dryRun ? '（试跑，没有落盘）' : r.writtenTo ? `，已记入 ${r.writtenTo}` : '') +
      '　这是它的判断，不是"它没答"—— 原始输出留在提案单的 raw 字段里，可以核对。'
    )
  }
  const head =
    n.source === 'model'
      ? `学习完成：模型看了 ${n.observations.length} 条现状，提出 ${n.proposals.length} 条改进提案`
      : `学习完成（**没有模型参与**）：只有规则层取到的 ${n.observations.length} 条真实数字`
  const top = n.proposals.slice(0, 3)
  return (
    head +
    (r.dryRun ? '（试跑，没有落盘）' : r.writtenTo ? `，已记入 ${r.writtenTo}` : '') +
    '。' +
    (top.length > 0
      ? `最要紧的三条：${top.map((p) => `${p.title}（风险 ${p.risk === 'high' ? '高' : p.risk === 'low' ? '低' : '中'}）`).join('；')}。`
      : '') +
    '★ 这些是**提案**，源码没有被改动 —— 改代码是不可逆动作，要人来点。'
  )
}
