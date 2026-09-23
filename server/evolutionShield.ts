/**
 * 进化护盾 —— 宪法红线 lint + 白盒心法健康衰减。
 *
 * 内化自 R20 Quantum Trader 的 `scripts/evolution_shield.py`。
 *
 * ## 为什么自进化系统必须自带「防污染」
 *
 * 自进化是把双刃剑。一个会从交易台账里自动学习心法并回注决策的系统，
 * 在遇到一次闪崩、一根插针之后，很可能总结出这样一条「经验」：
 *
 *   「BTC 做空很危险，以后永远不要做空。」
 *
 * 这条心法**看起来是从真实数据学到的**，实际上是把一次偶发噪声当成了长期规律。
 * 一旦回注进决策上下文，整个系统的方向性判断就被永久污染——
 * 而且在单边上涨行情里它还会持续「表现良好」，直到趋势反转那天一次性把前面赚的全吐回去。
 *
 * 所以护栏必须有，且必须分层：
 *   ① **宪法红线**（硬）：极端方向偏见、放宽止损、马丁格尔加仓、推翻风控 —— 直接拒绝写入；
 *   ② **样本量门槛**（硬）：单笔偶发事件不允许沉淀为长期心法；
 *   ③ **健康分 + 半衰期**（软）：与近期表现矛盾的心法自动降权、过期归档。
 *
 * 没有 ③ 的护栏只挡得住「明显的坏」，挡不住「随周期失效的好」——
 * 三个月前的震荡市心法在趋势市里就是毒药。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type LessonCategory =
  | 'TREND_FOLLOWING'
  | 'RISK_CONTROL'
  | 'WIN_RATE_LOCK'
  | 'PORTFOLIO_DIVERSIFICATION'
  | 'EXECUTION_QUALITY'
  | 'REGIME_ADAPTATION'

/**
 * 合法类别的**运行时**清单（单一出处）。
 *
 * 为什么需要它：原先接口层写的是 `category: (body.category as never) ?? 'entry'` ——
 * `as never` 让任意字符串都能通过类型检查，而默认值 `'entry'` 根本不在上面的联合类型里。
 * 于是"类别"这一列可以是任何东西，并且会原样渲染进 `AI_TRADING_MEMORY.md` 的表格。
 * 类型只在编译期起作用；**进数据库之前必须有一次运行时校验**。
 */
export const LESSON_CATEGORIES: readonly LessonCategory[] = [
  'TREND_FOLLOWING',
  'RISK_CONTROL',
  'WIN_RATE_LOCK',
  'PORTFOLIO_DIVERSIFICATION',
  'EXECUTION_QUALITY',
  'REGIME_ADAPTATION',
]

/** 运行时校验类别；非法返回 null（调用方据此拒绝，不要静默 fallback 到某个默认值）。 */
export function validateCategory(raw: unknown): LessonCategory | null {
  return typeof raw === 'string' && (LESSON_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as LessonCategory)
    : null
}

/**
 * 心法证据凭据 —— **只装可观测量**。
 *
 * 它存在的唯一理由：原先把 `sampleSize` 当普通参数收，于是"样本量门槛"吃的是
 * **调用方自报的数字** —— 客户端写 `sampleSize: 9999` 就能把"单笔偶发插针"
 * 登记成"9999 笔证据"，而门禁恒为真。这与 F-34 的自报 `wfRobust` 布尔量、
 * F-41 的空洞门是**同一个病**（见 DEV_PROGRESS §3.11）。
 *
 * 现在门槛只认这个凭据，而凭据由**服务端从审计账本现算**
 * （`server/index.ts` 的 `lessonEvidenceFromLedger()`）；
 * HTTP 请求体里传什么数都不进到这里。伪造凭据 = 伪造一个服务端才算得出来的量。
 */
export type LessonEvidenceSource = 'audit-ledger'

export interface LessonEvidence {
  source: LessonEvidenceSource
  /** 已成交（`ORDER_FILL`）事件计数 —— 服务端从审计链点出来的真实观测数。 */
  tradeObservations: number
}

export interface Lesson {
  id: string
  category: LessonCategory
  ruleText: string
  healthScore: number
  enabled: boolean
  createdAt: number
  /** 半衰期（天）：超过这个时长未再被验证，健康分持续衰减。 */
  ttlDays: number
  sampleSize: number
  /**
   * 样本量的**来源凭据**。老记录（本字段引入前）为 null —— 归一化而不回填，
   * 因为回填一个"看起来合理"的来源就是编造证据。
   */
  evidence: LessonEvidence | null
  isBaseline: boolean
  shieldStatus: 'PASSED' | 'BLOCKED' | 'DECAYED'
  source?: string
}

// ─────────────────────────────────────────────────────────────
// 宪法红线（Constitution Red-Lines）
// ─────────────────────────────────────────────────────────────
/**
 * 任何心法只要命中以下模式，**物理阻断**，无论它背后有多少正收益样本。
 *
 * 注意这些规则的写法：它们拦的不是「某条具体策略」，而是**一类会自我强化的错误**。
 * 放宽止损、马丁格尔、方向偏见之所以致命，是因为它们在小样本上往往表现为「更赚钱」——
 * 这正是它们能骗过统计门槛的原因，所以必须靠模式匹配硬拦，而不是靠指标筛选。
 */
export const POISON_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(永远不|绝对不|严禁|彻底禁止|再也不要).{0,12}(做多|开多|买入|多单)/, reason: '极端方向偏见：永久禁多' },
  { pattern: /(永远不|绝对不|严禁|彻底禁止|再也不要).{0,12}(做空|开空|卖出|空单)/, reason: '极端方向偏见：永久禁空' },
  { pattern: /(扩大|放宽|取消|不设|移除|关闭).{0,8}(止损|stop\s*loss|\bSL\b)/i, reason: '违规抗单：放宽或取消止损' },
  { pattern: /(加倍|翻倍|重仓|梭哈|满仓|全仓).{0,8}(亏损|抗单|摊平|补仓)/, reason: '马丁格尔：亏损加倍摊平' },
  { pattern: /(忽视|不看|废弃|绕过|跳过).{0,10}(4H|4小时|宏观|ATR|风控|拦截|盈亏比|晋升门禁)/, reason: '治理推翻：企图绕过硬风控' },
  { pattern: /(直接|立即|马上).{0,6}(上实盘|跑实盘|接实盘|开实盘)/, reason: '晋升门禁绕过：跳过审批直上实盘' },
  { pattern: /(忽略|不设|取消).{0,6}(手续费|滑点)/, reason: '成本隐瞒：心法建立在无摩擦的幻觉上' },
  // ── 以下三组来自一次真实漏检 ──
  // 测试提交「只要出现金叉就一定必涨，直接满仓做多不要犹豫」时，旧规则集判定为 PASSED 并成功入册。
  // 根因：原规则只覆盖了「方向偏见 / 抗单 / 马丁格尔」三类**结构性**毒化，漏掉了**认知层面**的毒化。
  // 这类心法最危险之处在于它不会立刻亏钱——它让系统在连续止损之后仍然坚信「这次一定行」，
  // 于是把一次正常的概率回撤放大成账户级事故。
  {
    pattern: /(一定|必然|肯定|绝对|保证|必定|稳赚|包赚|必赚|躺赚|无风险|零风险).{0,8}(涨|跌|盈利|获利|赚|不亏|翻倍|起飞)/,
    reason: '确定性幻觉：把概率事件表述为必然结果，会诱导系统在连亏后继续加注',
  },
  {
    pattern: /(满仓|梭哈|全仓|all[\s-]*in|一把).{0,6}(做多|做空|开多|开空|买入|卖出|进场|入场)/i,
    reason: '过度集中：单笔押上全部资金，与单笔 1R 风险预算机制直接冲突',
  },
  {
    pattern: /(不用|无需|不需要|没必要).{0,6}(止损|仓位|风控|分散|对冲)/,
    reason: '治理推翻：以「这次不一样」为由豁免硬风控',
  },
]

// ─────────────────────────────────────────────────────────────
// 官方基准心法（不可删除，可一键回滚到此）
// ─────────────────────────────────────────────────────────────
export const BASELINE_LESSONS: Lesson[] = [
  {
    id: 'lesson_trend_pullback',
    category: 'TREND_FOLLOWING',
    ruleText:
      '【顺势回踩低吸、反弹承压高抛】高周期多头通道内禁止逆势摸顶开空；空单只在高周期空头反弹受阻时限价挂单。区间震荡的上下边界双向高抛低吸。',
    healthScore: 98,
    enabled: true,
    createdAt: 0,
    ttlDays: 14,
    sampleSize: 42,
    evidence: null,
    isBaseline: true,
    shieldStatus: 'PASSED',
    source: 'baseline',
  },
  {
    id: 'lesson_wide_atr_stop',
    category: 'RISK_CONTROL',
    ruleText:
      '【宽止损抗噪，杜绝随意割肉】止损必须设在结构外 1.8x~2.2x ATR 之外，给足波动呼吸空间，从物理上隔绝短周期杂波插针洗损。',
    healthScore: 95,
    enabled: true,
    createdAt: 0,
    ttlDays: 14,
    sampleSize: 38,
    evidence: null,
    isBaseline: true,
    shieldStatus: 'PASSED',
    source: 'baseline',
  },
  {
    id: 'lesson_breakeven_lock',
    category: 'WIN_RATE_LOCK',
    ruleText:
      '【浮盈 0.8R 坚决保本锁利】浮盈达 0.8R 执行保本移损，把潜在亏损彻底消除为零风险平仓，锁死胜率下限，杜绝盈利变割肉。',
    healthScore: 99,
    enabled: true,
    createdAt: 0,
    ttlDays: 14,
    sampleSize: 50,
    evidence: null,
    isBaseline: true,
    shieldStatus: 'PASSED',
    source: 'baseline',
  },
  {
    id: 'lesson_anti_resonance',
    category: 'PORTFOLIO_DIVERSIFICATION',
    ruleText:
      '【严禁同向共振堆叠单边敞口】对高相关标的不允许同向无节制开仓，必须对总同向在手仓位施加硬性约束，防系统性 beta 踩踏。',
    healthScore: 92,
    enabled: true,
    createdAt: 0,
    ttlDays: 7,
    sampleSize: 15,
    evidence: null,
    isBaseline: true,
    shieldStatus: 'PASSED',
    source: 'baseline',
  },
  {
    id: 'lesson_execution_maker_first',
    category: 'EXECUTION_QUALITY',
    ruleText:
      '【入场优先限价、严禁市价追单】挂在支撑/阻力附近 0.1%~0.6% 的纪律位；市价追单等于把滑点和手续费白送，直接侵蚀 fitness 里的换手惩罚项。',
    healthScore: 88,
    enabled: true,
    createdAt: 0,
    ttlDays: 10,
    sampleSize: 22,
    evidence: null,
    isBaseline: true,
    shieldStatus: 'PASSED',
    source: 'baseline',
  },
]

// ─────────────────────────────────────────────────────────────
// 宪法 lint
// ─────────────────────────────────────────────────────────────

export interface AuditVerdict {
  passed: boolean
  reason: string
}

/** 单条心法的宪法审查。样本量门槛放在红线之后——先拦「明显有毒」，再谈统计显著性。 */
export function auditProposedLesson(ruleText: string, sampleSize = 1): AuditVerdict {
  const text = (ruleText ?? '').trim()
  if (text.length < 10) {
    return { passed: false, reason: '心法文本过短（< 10 字），缺乏明确可复用的交易情境依据' }
  }

  for (const { pattern, reason } of POISON_PATTERNS) {
    if (pattern.test(text)) return { passed: false, reason: `触发宪法红线拦截：${reason}` }
  }

  if (sampleSize < 2) {
    return { passed: false, reason: `样本量不足（${sampleSize} 笔）——单笔偶发事件或极端插针噪点，拒绝写入长期心法` }
  }

  return { passed: true, reason: 'PASSED' }
}

// ─────────────────────────────────────────────────────────────
// 红线自检（内化 R20 的 assert 范式）
// ─────────────────────────────────────────────────────────────
/**
 * 官方基准心法**必须**全部通过红线审查。
 *
 * 为什么把这条检查放在模块加载期，而不是写成单元测试：
 *   红线是模式匹配，改一个正则就可能从「拦截毒化」滑向「拦截一切」。
 *   一旦误伤基线，系统会在下一次巡检时把全部官方心法判为有毒并清库，
 *   而这个过程是静默的——外部只表现为「AI 好像突然变笨了」。
 *   让进程在启动时直接失败，是把这类事故从「运行数周后才发现」提前到「改完 5 秒内发现」。
 */
const baselineViolations = BASELINE_LESSONS.map((l) => ({ l, v: auditProposedLesson(l.ruleText, l.sampleSize) })).filter(
  (x) => !x.v.passed,
)
if (baselineViolations.length > 0) {
  throw new Error(
    `[evolutionShield] 红线规则误伤了官方基线心法，进程拒绝启动：\n` +
      baselineViolations.map((x) => `  · ${x.l.id}: ${x.v.reason}`).join('\n'),
  )
}

// ─────────────────────────────────────────────────────────────
// 存储
// ─────────────────────────────────────────────────────────────

const MEMORY_FILE = resolve(process.cwd(), 'data/structured_trading_memory.json')
const MEMORY_MD_FILE = resolve(process.cwd(), 'data/AI_TRADING_MEMORY.md')

interface MemoryFile {
  version: number
  lessons: Lesson[]
  updatedAt: number
}

let cache: Lesson[] | null = null

function persist(lessons: Lesson[]): void {
  const payload: MemoryFile = { version: 1, lessons, updatedAt: Date.now() }
  try {
    const dir = dirname(MEMORY_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(MEMORY_FILE, JSON.stringify(payload, null, 2), 'utf8')
    writeFileSync(MEMORY_MD_FILE, renderMarkdown(lessons), 'utf8')
  } catch {
    /* 落盘失败不应阻断决策链路；内存态仍然有效 */
  }
}

export function loadLessons(): Lesson[] {
  if (cache) return cache
  try {
    if (existsSync(MEMORY_FILE)) {
      const parsed = JSON.parse(readFileSync(MEMORY_FILE, 'utf8')) as MemoryFile
      if (Array.isArray(parsed.lessons) && parsed.lessons.length > 0) {
        const kept: Lesson[] = []
        const dropped: string[] = []
        for (const raw of parsed.lessons) {
          const cat = validateCategory(raw?.category)
          if (!cat) {
            // 类别非法的记录一律不进决策上下文 —— 与"文件损坏时退回基准心法"同一原则。
            // 但不静默：把它报出来，否则"AI 好像变笨了"会是唯一的症状。
            dropped.push(`${raw?.id ?? '<no-id>'}(${String(raw?.category)})`)
            continue
          }
          // 归一化而不回填：老记录没有 evidence，置 null 而不是补一个看着合理的来源。
          kept.push({ ...raw, category: cat, evidence: raw.evidence ?? null })
        }
        if (dropped.length > 0) {
          console.warn(`[evolutionShield] 丢弃类别非法的心法 ${dropped.length} 条：${dropped.join(', ')}`)
        }
        if (kept.length > 0) {
          cache = kept
          return cache
        }
      }
    }
  } catch {
    /* 文件损坏时退回基准心法，绝不让损坏内容进入决策上下文 */
  }
  cache = BASELINE_LESSONS.map((l) => ({ ...l }))
  persist(cache)
  return cache
}

// ─────────────────────────────────────────────────────────────
// 认知衰减 / 健康分
// ─────────────────────────────────────────────────────────────

export interface DecayResult {
  decayed: string[]
  archived: string[]
}

/**
 * 按半衰期衰减健康分，并把跌破归档线的心法停用。
 *
 * 衰减公式：`health -= 100 × (elapsedDays / ttlDays) × 0.5`，
 * 即「一个半衰期扣掉一半健康分」。
 *
 * ⚠️ **基准心法不参与自动衰减** —— 见下方 `if (lesson.isBaseline) continue`。
 * 它们由人工经 `/evolution/lessons/reset` 显式回滚管理。
 *
 * 历史注记（F-46）：这段注释原先写的是「基准心法同样参与衰减……不能因为官方就永久豁免」，
 * **与代码正好相反**。注释描述必须是真的在跑的那套逻辑，否则下一个人会照注释去推理行为。
 * 两种设计都成立；当前取舍的理由是：基准心法是"认知被污染时的唯一干净出口"，
 * 它不能自己衰减掉 —— 否则一次长时间停机后回来，系统连一个可信基线都不剩。
 *
 * 阈值：健康分 < 40 视为失效，自动 enabled=false（保留记录以便审计，不物理删除）。
 */
export interface DecayForecastRow {
  id: string
  ruleText: string
  healthNow: number
  healthNext: number
  willArchive: boolean
}

export interface DecayForecast {
  now: number
  archiveThreshold: number
  /** 参与衰减的心法（基准心法与已停用的不在内）。 */
  rows: DecayForecastRow[]
  wouldDecay: string[]
  wouldArchive: string[]
}

/**
 * 衰减的**只读预演**：按当前时间算一遍"下一轮衰减会动谁"，但不落盘。
 *
 * ★ 提出来是为了让"衰减公式"只存在一份。此前这套公式只写在 `decayLessons`
 * 里，于是任何想回答"哪些心法快失效了"的地方（面板、语音、巡检 agent）
 * 只能**抄一遍公式**或者**真的跑一次衰减再回滚** —— 前者必然漂移，
 * 后者是在只读问句上做写操作。现在两边都调它。
 *
 * 它也是"未执行"与"已执行"的区分点：`decayLessons` 是**执行**，
 * 这个是**预演**。两者返回值形状一致，所以调用方不会把预演当执行。
 */
export function decayForecast(now: number = Date.now(), archiveThreshold = 40): DecayForecast {
  const rows: DecayForecastRow[] = []
  for (const lesson of loadLessons()) {
    if (lesson.isBaseline) continue // 基准心法由人工回滚管理，不参与自动衰减
    if (!lesson.enabled) continue
    const elapsedDays = Math.max((now - lesson.createdAt) / 86_400_000, 0)
    const decayAmount = 100 * (elapsedDays / Math.max(lesson.ttlDays, 1)) * 0.5
    const healthNext = Math.round(Math.max(lesson.healthScore - decayAmount, 0) * 10) / 10
    rows.push({
      id: lesson.id,
      ruleText: lesson.ruleText,
      healthNow: lesson.healthScore,
      healthNext,
      willArchive: healthNext > 0 && healthNext < archiveThreshold,
    })
  }
  return {
    now,
    archiveThreshold,
    rows,
    wouldDecay: rows.filter((r) => r.healthNext !== r.healthNow).map((r) => r.id),
    wouldArchive: rows.filter((r) => r.willArchive).map((r) => r.id),
  }
}

export function decayLessons(now: number = Date.now(), archiveThreshold = 40): DecayResult {
  // 公式住在 `decayForecast` 里，这里只负责**执行**它算出来的结果。
  const fc = decayForecast(now, archiveThreshold)
  if (fc.wouldDecay.length === 0 && fc.wouldArchive.length === 0) return { decayed: [], archived: [] }

  const lessons = loadLessons()
  const byId = new Map(fc.rows.map((r) => [r.id, r]))
  const decayed: string[] = []
  const archived: string[] = []

  for (const lesson of lessons) {
    const row = byId.get(lesson.id)
    if (!row) continue
    if (row.healthNext !== lesson.healthScore) {
      lesson.healthScore = row.healthNext
      decayed.push(lesson.id)
    }
    if (row.willArchive) {
      lesson.enabled = false
      lesson.shieldStatus = 'DECAYED'
      archived.push(lesson.id)
    }
  }

  persist(lessons)
  return { decayed, archived }
}

// ─────────────────────────────────────────────────────────────
// 写入 / 管理
// ─────────────────────────────────────────────────────────────

/**
 * 从审计事件里点出心法的证据凭据 —— **唯一的凭据产出点**。
 *
 * 观测数取 `ORDER_FILL` 计数：每一次撮合成交都落一条 `ORDER_FILL`
 * （paper 与 live 同路径，见 `server/core.ts` / `server/orchEngine.ts`），
 * 因此它天然就是"这个系统实际发生过多少笔成交"的可核对口径，
 * 而不是谁在表单里填的数字。
 *
 * 它做成纯函数（吃事件数组而不是自己去读账本）的理由：可测试，且不把
 * 服务端模块的依赖反向引入这里。调用点在 `server/index.ts` 的
 * `POST /evolution/lessons`，用 `getEvents()` 现算。
 */
export function lessonEvidenceFromEvents(events: readonly { kind: string }[]): LessonEvidence {
  return {
    source: 'audit-ledger',
    tradeObservations: events.reduce((n, e) => (e.kind === 'ORDER_FILL' ? n + 1 : n), 0),
  }
}

export interface ProposeLessonInput {
  /** 运行时校验的类别（传 string 而非 LessonCategory —— 编译期类型挡不住 HTTP 请求体）。 */
  category: string
  ruleText: string
  /**
   * ★ 证据凭据。**必须由服务端从审计账本现算**（`lessonEvidenceFromLedger()`）。
   * 不再接受裸的 `sampleSize`：那正是 F-44 —— 门禁吃调用方自报的数字，
   * 于是"样本量门槛"在产品路径上恒为真。
   */
  evidence: LessonEvidence
  ttlDays?: number
  source?: string
}

export interface ProposeLessonResult {
  accepted: boolean
  lesson?: Lesson
  reason: string
}

/**
 * 提议一条新心法。必须过宪法 lint 才会落库——
 * 被拒的提案**也会返回完整拒绝理由**，因为「为什么这条经验不能学」
 * 本身就是提供给研究者的信号，而不只是一个 error。
 *
 * ★ 校验顺序是刻意的：**先验凭据结构，再用凭据里的观测数过样本量门槛**。
 * 反过来（先看数字）就等于给了自报值一个参与判断的机会。
 */
export function proposeLesson(input: ProposeLessonInput, now: number = Date.now()): ProposeLessonResult {
  const category = validateCategory(input.category)
  if (!category) {
    return {
      accepted: false,
      reason: `未知心法类别「${String(input.category)}」——合法值：${LESSON_CATEGORIES.join(' / ')}`,
    }
  }

  const ev = input.evidence
  if (
    !ev ||
    ev.source !== 'audit-ledger' ||
    !Number.isInteger(ev.tradeObservations) ||
    ev.tradeObservations < 0
  ) {
    return {
      accepted: false,
      reason:
        '缺少可核验的证据凭据：样本量必须由服务端从审计账本现算，不接受调用方自报的数字（见 DEV_PROGRESS §3.11 F-44）',
    }
  }

  const verdict = auditProposedLesson(input.ruleText, ev.tradeObservations)
  if (!verdict.passed) return { accepted: false, reason: verdict.reason }

  const lessons = loadLessons()
  const lesson: Lesson = {
    id: `lesson_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    category,
    ruleText: input.ruleText.trim(),
    healthScore: 70,
    enabled: true,
    createdAt: now,
    ttlDays: input.ttlDays ?? 14,
    sampleSize: ev.tradeObservations,
    evidence: { source: ev.source, tradeObservations: ev.tradeObservations },
    isBaseline: false,
    shieldStatus: 'PASSED',
    source: input.source ?? 'evolution',
  }
  lessons.push(lesson)
  persist(lessons)
  return { accepted: true, lesson, reason: 'PASSED' }
}

export function setLessonEnabled(id: string, enabled: boolean): Lesson {
  const lessons = loadLessons()
  const lesson = lessons.find((l) => l.id === id)
  if (!lesson) throw new Error(`未知心法: ${id}`)
  lesson.enabled = enabled
  if (enabled) lesson.shieldStatus = 'PASSED'
  persist(lessons)
  return lesson
}

/** 一键回滚到官方基准心法（丢弃全部自动学习成果）。认知被污染时的唯一干净出口。 */
export function resetToBaseline(now: number = Date.now()): Lesson[] {
  cache = BASELINE_LESSONS.map((l) => ({ ...l, createdAt: now }))
  persist(cache)
  return cache
}

/** 注入决策上下文的心法文本（只取启用的、按健康分降序，最多 8 条防止上下文爆炸）。 */
export function activeLessonTexts(limit = 8): string[] {
  return loadLessons()
    .filter((l) => l.enabled)
    .sort((a, b) => b.healthScore - a.healthScore)
    .slice(0, limit)
    .map((l) => l.ruleText)
}

export function lessonStats(): {
  total: number
  active: number
  blocked: number
  decayed: number
  avgHealth: number
} {
  const lessons = loadLessons()
  const active = lessons.filter((l) => l.enabled)
  return {
    total: lessons.length,
    active: active.length,
    blocked: lessons.filter((l) => l.shieldStatus === 'BLOCKED').length,
    decayed: lessons.filter((l) => l.shieldStatus === 'DECAYED').length,
    avgHealth: active.length > 0 ? Math.round((active.reduce((s, l) => s + l.healthScore, 0) / active.length) * 10) / 10 : 0,
  }
}

function renderMarkdown(lessons: Lesson[]): string {
  const lines: string[] = [
    '# EVOLVE 交易心法（白盒自动维护）',
    '',
    '> 本文件由 `server/evolutionShield.ts` 自动生成，**请勿手工编辑**——',
    '> 下次进化循环会覆盖它。要改心法请通过风控管理页或 `/evolution/lessons` 接口。',
    '',
    `最后更新：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| 状态 | 类别 | 健康分 | 样本 | 心法 |',
    '|---|---|---|---|---|',
  ]
  for (const l of [...lessons].sort((a, b) => b.healthScore - a.healthScore)) {
    const status = !l.enabled ? (l.shieldStatus === 'DECAYED' ? '🔻 已失效' : '⏸️ 已停用') : '✅ 生效'
    lines.push(`| ${status} | ${l.category} | ${l.healthScore.toFixed(1)} | ${l.sampleSize} | ${l.ruleText} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 仅供测试：清空内存缓存，强制下次从磁盘重读。 */
export function _resetCache(): void {
  cache = null
}
