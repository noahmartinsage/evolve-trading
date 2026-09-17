/**
 * 目标解析：把「一句话的诉求」变成结构化的 `MissionSpec`
 *
 * ── 为什么又是确定性规则，而不是丢给大模型 ────────────────────────────
 * 与 `voice/intents.ts` 同一条理由，且这里更硬：这一层决定了
 * **系统接下来会不会启动一个自治循环去动钱**。把这种判断交给一个
 * 概率性、不可离线复现、会随厂商静默换版本的组件，代价是：
 * 今天「10U 做到 100U」被解析成"本金 10、目标 100"，
 * 明天同一个模型版本升级后变成"目标 100 倍"（差 10 倍），
 * 而这个过程没有任何 CI 能发现。
 *
 * 所以分工与意图层完全一致：
 *   - **槽位**（哪个场所、多少钱、多久、能不能上杠杆）→ 本模块的确定性规则。
 *   - **措辞**（怎么把裁定结论讲得好听）→ 才允许交给 LLM。
 *
 * ── 缺槽位不补默认值（这一条最容易被"顺手"违反）──────────────────────
 * 最容易写出来的"贴心"实现是：
 *     `const deadlineMs = parseDeadline(text) ?? 24 * 3600e3`
 * 它看起来无害，实际上**把"用户没说"变成了"用户说了 24 小时"**，
 * 于是上层再也无法区分「他指定了一天」和「他只是没提时间」。
 * 而这两件事在裁定里结论不同：前者要按 24 小时算可达笔数，
 * 后者应当直接问清楚。所以缺槽位一律进 `missing`，由上层转澄清。
 *
 * ── 数值口径必须与既有系统对齐 ──────────────────────────────────────
 * 杠杆的"高倍"没有独立含义 —— 它最终要落到 `EV_MAX_LEVERAGE` 与
 * 强平几何上（见 `positionGuard.maxSafeLeverage`）。本模块**只解析意图**，
 * 不做任何钳制；钳制由裁定层用真实常量做。两处都钳一次就会分岔。
 */
import type { MissionExecution, MissionSlot, MissionSpec, MissionVenue } from './types.ts'

export interface GoalContext {
  /** 当前可交易标的池。**必须**由调用方传入，不允许本模块另立一份清单。 */
  symbols: string[]
  /**
   * 标的名 → 交易对。注入而不是自己实现：
   * 语音层已经有一份经过 S1 断言的解析器（含中文别名、报价币后缀切分），
   * 在任务层再写一份就是**同一个动作的第二条实现路径**——
   * 两份迟早对「以太坊」能不能落到池子里给出不同答案。
   */
  resolveSymbol: (text: string, symbols: string[]) => string | null
  /** 解析时刻。用于把「今天」「半天」这类相对说法折成时长。 */
  nowMs: number
}

/** 槽位 → 中文名（供澄清回话使用，改它不会改变行为）。 */
export const MISSION_SLOT_LABEL: Record<MissionSlot, string> = {
  venue: '在哪做（哪个场所）',
  startNotional: '起步本金',
  targetNotional: '目标金额',
  deadline: '截止时间',
  symbol: '标的',
}

// ─────────────────────────── 场所 ───────────────────────────

/**
 * 场所词 → 适配器名。
 *
 * 取值必须与 `server/venue/*.ts` 里 `readonly name` 逐字一致，
 * 由 mission-smoke 的 S-M4 断言钉住 —— 这类"字符串即契约"的地方
 * 一旦写错，症状是"任务指定了 OKX，系统却报场所没接线"，很难查。
 */
const VENUE_WORDS: Array<{ re: RegExp; venue: MissionVenue }> = [
  { re: /(okx|欧易)/i, venue: 'okx-testnet' },
  { re: /(币安|安网|binance)/i, venue: 'cex-testnet' },
  { re: /(沙盒|sandbox|本地模拟)/i, venue: 'sandbox' },
]

/** 判「模拟环境」的词。 */
const TESTNET_WORDS = /(测试网|测试环境|模拟盘|模拟交易|模拟环境|仿真|testnet|paper)/i
/** 判「真钱」的词。缺省一律不是真钱 —— 语音最容易误触发，默认必须最安全。 */
const LIVE_WORDS = /(实盘|真钱|真金白银|真实资金|上真仓|live)/i
/** 判「真的跑起来」而不是回测。 */
const EXECUTE_WORDS = /(实测|实跑|跑一遍|执行|开始做|做一次)/

// ─────────────────────────── 金额 ───────────────────────────

/**
 * 计价金额。中英文后缀都认。
 *
 * ⚠️ 刻意**不**匹配裸数字：句子里「1 天内」「125 倍」「3 个标的」里的数字
 * 都不是金额。只认带计价后缀的形态，宁可漏也不要错——
 * 漏了会走澄清，错了会开出一个金额不对的循环。
 */
const MONEY_RE = /(\d+(?:\.\d+)?)\s*(?:USDT|USDC|USD|U\b|刀|美元|美金|块钱|块)/gi

/** 「A 做到 B」的连接词 —— 用它把两个金额分成起点与终点。 */
const GOAL_CONNECT_RE = /(?:做到|打到|干到|翻到|赚到|变成|涨到|跑到|到)\s*$/

interface Amount {
  value: number
  at: number
}

function scanAmounts(text: string): Amount[] {
  const out: Amount[] = []
  MONEY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MONEY_RE.exec(text)) !== null) {
    const v = Number(m[1])
    if (!Number.isFinite(v) || v <= 0) continue
    out.push({ value: v, at: m.index })
  }
  return out
}

/** 「翻 10 倍」形态的目标倍数。 */
const MULTIPLE_RE = /(?:翻|涨|变成|达到|做到)\s*(\d+(?:\.\d+)?)\s*倍/

/**
 * 不带数字的倍数说法 —— 「翻倍」「翻一番」「三倍」。
 *
 * ★ 这一条是补一个**真实事故**：旧实现只认 `翻\s*(\d+)\s*倍`，
 * 而中文里最常用的说法恰恰不带数字（"翻倍"就是 2 倍）。
 * 于是「在 OKX 测试网做 BTC 永续，3 天内翻倍」被解析成
 * **没有目标**（`targetMultiple === null`）⇒ 不满足 `looksLikeMission`
 * ⇒ 落到语音层的兜底"认出标的就当问行情"⇒ 用户收到一句 **BTC 的报价**。
 *
 * 这个失败最恶劣的地方是**它看起来是对的**：报价确实是真价，
 * 用户没有任何线索知道自己的任务被丢掉了。所以必须在这里修，
 * 而不是靠上层"猜用户其实想问什么"。
 *
 * 后面紧跟「杠杆」的不算（那是仓位倍率，不是收益目标）——
 * 那一类由 `LEVERAGE_RE` 负责，两处各管一件事，不重叠。
 */
const BARE_MULTIPLE_RE = /(翻一番|翻一翻|翻倍|翻番|([两二三四五六七八九十]|\d+(?:\.\d+)?)\s*倍(?!\s*(?:杠杆|杠杠|leverage|lev)))/i
const CN_NUM: Record<string, number> = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 解析裸倍数说法。`翻倍/翻番/翻一番` 一律是 2 倍。 */
function bareMultipleOf(text: string): { times: number; matched: string } | null {
  const m = BARE_MULTIPLE_RE.exec(text)
  if (!m) return null
  if (m[1].startsWith('翻')) return { times: 2, matched: m[1] }
  const digits = m[2]
  const times = CN_NUM[digits] ?? Number(digits)
  // 1 倍不是目标（等于不赚），0 倍更不是 —— 认不出来比认错好
  if (!Number.isFinite(times) || times < 2) return null
  return { times, matched: m[0] }
}

/** 「125 倍杠杆」形态的显式杠杆。刻意要求后面跟"杠杆"字样。 */
const LEVERAGE_RE = /(\d+(?:\.\d+)?)\s*倍\s*(?:合约)?\s*(?:杠杆|杠杠|leverage|lev)/i
const HIGH_LEVERAGE_WORDS = /(高倍|高杠杆|拉满杠杆|满杠杆|尽量高|越高越好|高倍合约)/

// ─────────────────────────── 时长 ───────────────────────────

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * 相对时长。
 *
 * 「今天 / 今日」需要 clock 才能折成时长，所以走 `ctx.nowMs` 算到当天 24 点。
 * 注意这带来一个**正确但容易被误读**的性质：同一句话在不同时刻解析，
 * 得到的 `deadlineMs` 不同，于是 `planId` 也不同。
 * 这是对的（截止时间确实是相对于"你问的那一刻"），
 * 所以任务资产必须连 `assessedAt` 一起引用，不能只引用 `planId`。
 */
function parseDeadline(text: string, nowMs: number): { ms: number; matched: string } | null {
  let m = /(\d+(?:\.\d+)?)\s*个?\s*(?:天|日)(?:内|之内|以内)?/.exec(text)
  if (m) return { ms: Number(m[1]) * DAY_MS, matched: m[0] }
  m = /(\d+(?:\.\d+)?)\s*个?\s*(?:小时|钟头)(?:内|之内|以内)?/.exec(text)
  if (m) return { ms: Number(m[1]) * HOUR_MS, matched: m[0] }
  m = /(\d+(?:\.\d+)?)\s*分钟(?:内|之内|以内)?/.exec(text)
  if (m) return { ms: Number(m[1]) * 60_000, matched: m[0] }
  if (/半天/.test(text)) return { ms: DAY_MS / 2, matched: '半天' }
  if (/(今天|今日)/.test(text)) {
    const d = new Date(nowMs)
    d.setHours(24, 0, 0, 0)
    return { ms: Math.max(d.getTime() - nowMs, 0), matched: '今天' }
  }
  // 「一整天」「一天」在中文里不带数字也能表达一天
  if (/(一整天|一天|一日)(?:内|之内|以内)?/.test(text)) return { ms: DAY_MS, matched: '一天' }
  return null
}

// ─────────────────────────── 主入口 ───────────────────────────

export function parseGoal(text: string, ctx: GoalContext): MissionSpec {
  const raw = text.trim()
  const matched: string[] = []

  // ── 场所（默认 null，不猜）──
  let venue: MissionVenue | null = null
  for (const v of VENUE_WORDS) {
    const m = v.re.exec(raw)
    if (m) {
      venue = v.venue
      matched.push(m[0])
      break
    }
  }

  // ── 执行形态 ──
  // 顺序刻意：显式"实盘"优先于"测试网"，但两者同时出现视为矛盾，
  // 由裁定层拦（这里只如实记录，不替用户二选一 —— 二选一等于猜）。
  const saysLive = LIVE_WORDS.test(raw)
  const saysTestnet = TESTNET_WORDS.test(raw)
  let execution: MissionExecution
  if (saysLive && !saysTestnet) execution = 'live'
  else if (saysTestnet || venue === 'okx-testnet' || venue === 'cex-testnet') execution = 'testnet'
  else execution = 'paper'
  if (saysLive && saysTestnet) matched.push('实盘+测试网(矛盾)')
  if (EXECUTE_WORDS.test(raw)) matched.push('要求真跑(非回测)')

  // ── 金额：先按连接词切成"起点 → 终点" ──
  const amounts = scanAmounts(raw)
  let startNotional: number | null = null
  let targetNotional: number | null = null
  let targetMultiple: number | null = null

  const multipleMatch = MULTIPLE_RE.exec(raw)
  if (multipleMatch) {
    targetMultiple = Number(multipleMatch[1])
    matched.push(multipleMatch[0])
  } else {
    const bare = bareMultipleOf(raw)
    if (bare) {
      targetMultiple = bare.times
      matched.push(bare.matched)
    }
  }
  // 说了倍数时，句子里唯一的金额就是本金（「10U 翻倍」里的 10U 是起点）
  if (targetMultiple !== null && amounts.length >= 1) startNotional = amounts[0].value

  if (amounts.length >= 2) {
    // 判断两个金额之间是否隔着"做到"类连接词；没有的话不猜先后
    const between = raw.slice(amounts[0].at, amounts[1].at)
    if (GOAL_CONNECT_RE.test(between)) {
      startNotional = amounts[0].value
      targetNotional = amounts[1].value
    } else {
      // 两个金额但不是「A 做到 B」结构（例如「本金 10，止损 2」）——
      // 不猜，全留 null，走澄清。
      matched.push('两个金额但未识别到"做到"结构')
    }
  } else if (amounts.length === 1 && targetMultiple === null) {
    // 只有一个金额时，先看它**前面**是不是「做到」这类连接词。
    //
    // 「帮我做到 100U」里的 100 是**目标**，不是本金。把它一股脑记成本金，
    // 系统就会回一句"你没说目标金额" —— 而这句话是**假的**，用户明明说了。
    // 缺槽位要如实说缺，但不能把说过的槽位说成没说：
    // 后者会让用户去补一个他已经给过的信息，而且他补的方式通常是再说一遍原话。
    const lead = raw.slice(0, amounts[0].at)
    if (GOAL_CONNECT_RE.test(lead)) {
      targetNotional = amounts[0].value
      matched.push('单一金额判为目标（前有"做到"类连接词）')
    } else {
      startNotional = amounts[0].value
    }
  }

  if (targetNotional !== null && startNotional !== null && targetMultiple === null) {
    if (startNotional > 0) targetMultiple = targetNotional / startNotional
  }
  // 只说了倍数、没说本金 → 本金仍是 null；只说本金没目标 → 目标为 null。都不补。

  // ── 杠杆 ──
  const levMatch = LEVERAGE_RE.exec(raw)
  const explicitLeverage = levMatch ? Number(levMatch[1]) : null
  if (levMatch) matched.push(levMatch[0])
  const allowHighLeverage = explicitLeverage !== null || HIGH_LEVERAGE_WORDS.test(raw)
  if (HIGH_LEVERAGE_WORDS.test(raw)) matched.push('允许高杠杆(未指定倍数)')

  // ── 时长 ──
  const dl = parseDeadline(raw, ctx.nowMs)
  if (dl) matched.push(dl.matched)

  // ── 标的 ──
  const symbol = ctx.resolveSymbol(raw, ctx.symbols)
  if (symbol) matched.push(symbol)

  // ── 缺槽位（显式，不补默认值 —— 见文件头）──
  const missing: MissionSlot[] = []
  if (!venue) missing.push('venue')
  if (startNotional === null) missing.push('startNotional')
  if (targetNotional === null && targetMultiple === null) missing.push('targetNotional')
  if (!dl) missing.push('deadline')
  // 标的刻意**不算**缺槽位：系统有默认标的池（自动驾驶单标的），
  // 不指定标的等于"用系统当前的池子"，这与"用户没说本金"性质不同。

  // 置信度：槽位齐 + 认出这是个执行诉求，才高。
  let confidence = 0.4
  if (venue) confidence += 0.15
  if (startNotional !== null) confidence += 0.1
  if (targetNotional !== null || targetMultiple !== null) confidence += 0.15
  if (dl) confidence += 0.1
  if (saysLive || saysTestnet) confidence += 0.1
  if (missing.length >= 3) confidence = Math.min(confidence, 0.4)

  return {
    raw,
    venue,
    execution,
    symbol,
    startNotional,
    targetNotional,
    targetMultiple,
    deadlineMs: dl ? dl.ms : null,
    allowHighLeverage,
    explicitLeverage,
    missing,
    confidence: Math.round(Math.min(confidence, 1) * 100) / 100,
    matched,
  }
}

/**
 * 判断这句话**是不是一个任务**。
 *
 * 存在的理由：`parseGoal` 对任何字符串都会吐出 spec（字段全 null），
 * 于是"今天天气不错"也会被当成"缺槽位的任务"而去问用户补槽位，
 * 用户会觉得系统在自说自话。
 *
 * 判据刻意保守：至少要有"一个金额 + 一个目标/倍数"或"一个倍数"，
 * 才认为这是任务而非闲聊。门槛低会把闲聊拖进裁定，门槛高会漏掉真任务 ——
 * 这里选**宁可漏**：漏了会回落到既有的"没听懂"，代价是一次重说；
 * 误判会启动澄清流程追问用户本金，代价是"它怎么突然问我钱"。
 */
export function looksLikeMission(spec: MissionSpec): boolean {
  const hasAmount = spec.startNotional !== null
  const hasTarget = spec.targetNotional !== null || spec.targetMultiple !== null
  return (hasAmount && hasTarget) || spec.targetMultiple !== null
}

// ───────────────────── 执行诉求词（判"是不是在说一件事"）─────────────────────

/**
 * 目标类词。「赚/做到/翻 X 倍」这类意图只会在**执行诉求**里出现，
 * 不会出现在一句问数里。
 */
const GOAL_WORDS = /(做到|打到|干到|赚到|盈利|赚|翻倍|翻番|翻一番|翻\s*\d+\s*倍|\d+\s*倍|本金|目标)/
/** 产品类词。「永续/合约/杠杆/仓位」是交易动作的名词形态。 */
const PRODUCT_WORDS = /(合约|永续|现货|杠杆|仓位|开仓|开单|挂单|做多|做空|平仓|下单|交易)/
/**
 * 动作词。刻意不含裸「做」「开」——"做得好""开什么玩笑"不是执行诉求。
 *
 * 「做…」这一支允许中间夹标的（"做 BTC 永续"、"做一笔 ETH 合约"）：
 * 真实说法里标的就夹在动词和产品之间，写成只认"做永续"会漏掉绝大多数。
 */
const ACTION_WORDS = /(做多|做空|做[^，,。！？；]{0,10}(永续|合约|单|笔|交易|任务)|跑一遍|实测|实跑|执行|启动|来一单|下单|建仓)/

/**
 * 这句话在提一个**执行诉求**，只是槽位没说全。
 *
 * ── 为什么不直接复用 `looksLikeMission` ─────────────────────────────
 * 后者要求「金额 + 目标」齐（或至少有倍数），门槛刻意保守 —— 它对闲聊很安全，
 * 但对**真任务**太紧：槽位缺一个就整个判成"不是任务"。
 *
 * 而"不是任务"在语音层的后果不是"回一句没听懂"，是掉进那条兜底
 * 「认出标的就当问行情」——系统会把用户的任务**静默换成一个报价**。
 * 用户拿到一个真实的价格，看不出自己的话被丢了。这是最坏的一类失败：
 * 不报错、不崩、答案还都对，只有用户的意图没了。
 *
 * ── 判据（两段，先强后弱）─────────────────────────────────────────
 * ① 两个及以上「强信号」→ 就是执行诉求。
 *    强信号 = 说了场所 / 有金额 / 有目标 / 有倍数 / 提了杠杆 /
 *             **没提场所却显式说了测试网或实盘**（提了场所时那条不算独立信号，
 *             因为 `execution` 是从场所派生的 —— 见函数体里的说明）。
 *    「在 OKX 测试网做 BTC 永续，3 天内翻倍」在此命中（场所 + 倍数）。
 *
 * ② 只有一个强信号时，必须再有**执行味的词**佐证。
 *    这一段的唯一目的是不误伤「看看币安」这种句子 ——
 *    它只有一个场所信号，而被追问本金同样是答非所问。
 *
 * ── 为什么不在兜底那里再判一次 ─────────────────────────────────────
 * 兜底用的就是本函数（`voice/intents.ts` 里任务分支的同一个判据）。
 * 若在那里另写一份正则，两份迟早对同一句话给出不同答案，
 * 而分歧的方向恰好是"任务被换成一个报价"—— 也就是这个函数要防的事。
 */
export function hasExecutionSignal(spec: MissionSpec): boolean {
  const strongSignals = [
    spec.venue !== null,
    // ★ 只说「币安」「沙盒」而不说"测试网/实盘"时，`execution` 是**从场所派生**出来的
    //   （见 parseGoal 里 `venue === 'cex-testnet'` 那一支），它不是独立证据。
    //   把它当第二个信号数的后果：一句「看看币安」就凑够两个信号、被判成执行诉求，
    //   然后系统反过来追问"你的本金是多少" —— 那是**同一个答非所问的镜像**。
    //   所以只有"没提场所却显式说了环境"才算独立信号。
    spec.execution !== 'paper' && spec.venue === null,
    spec.startNotional !== null,
    spec.targetNotional !== null,
    spec.targetMultiple !== null,
    spec.allowHighLeverage,
  ].filter(Boolean).length

  if (strongSignals >= 2) return true
  if (strongSignals === 0) return false

  const saysGoal = GOAL_WORDS.test(spec.raw)
  const saysProduct = PRODUCT_WORDS.test(spec.raw)
  const saysAction = ACTION_WORDS.test(spec.raw)
  return (saysGoal || saysProduct) && saysAction
}
