/**
 * 中文语音数字与金额归一
 *
 * ── 为什么值得单独一个模块 ──────────────────────────────────────────
 * ASR 吐出来的是**汉字数字**（「两百」「一千五」「百分之五」），
 * 而风控层只认数字。中间这一步如果做糙，后果不是"报错"而是**静默下错单**：
 *
 *   「一千五」→ 若按字面读成 1 + 5 = 15，订单规模差 100 倍；
 *   「两百五十」→ 若丢掉末位读成 200，差 25%；
 *   而这两种情况风控都**照常放行**（15 U 和 1500 U 都在逐笔上限内）。
 *
 * 也就是说：数字解析错误在系统里表现为"一次完全合法的小额交易"，
 * 没有任何一道门会响。这类错误只能靠**单元级断言**挡住，
 * 因此本模块是 voice-smoke 里断言最密的一块。
 *
 * ── 支持面 ──────────────────────────────────────────────────────────
 * - 阿拉伯数字与分隔符：「200」「1,000」「1.5万」
 * - 汉字数字：「两百」「二百五」「一千五」「两万三」「十万」「一亿二千万」
 * - 口语省略（末位无单位）：「一千五」= 1500、「两万三」= 23000
 * - 「半」：「半仓」「一半」→ 0.5（比例语义由调用方决定）
 * - 百分比：「百分之五」「5%」
 * - 单位归一：元/块/块钱/U/USDT/美元 → 名义额；个/枚/张/份 → 数量
 */

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 低位单位。 */
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
/** 高位节单位。 */
const CN_SECTIONS: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

export interface AmountParse {
  value: number
  /** 值是从哪段原文来的（面板要能显示"我从这句话里听出的数字"）。 */
  matched: string
  /** 量的语义：货币单位 → notional；件数单位 → qty；没单位 → unknown。 */
  basis: 'notional' | 'qty' | 'unknown'
  /** 是否命中「半」这类比例词。 */
  ratio?: boolean
}

/**
 * 解析一个汉字/阿拉伯数字串。
 *
 * 算法是经典的中文读数逆运算，它天然处理口语省略：
 * 遇到低位单位就先记下 `lastUnit`；此后再来一个**没有跟单位**的数字，
 * 说明用户省掉了单位，按 `lastUnit / 10` 折算。
 *
 *   一千五 → 1*1000，然后裸 5 落在 lastUnit=1000 ⇒ +5*100 = 1500 ✓
 *   两万三 → 2*10000，然后裸 3 落在 lastUnit=10000 ⇒ +3*1000 = 23000 ✓
 *   两百五 → 2*100，裸 5 ⇒ +5*10 = 250 ✓
 *
 * 这正是口语里「一千五」一定是 1500 而不是 15 的原因，
 * 也是**不能**用"逐字符相加"实现它的原因。
 */
export function parseChineseNumber(raw: string): number | null {
  const s = raw.replace(/[,，\s]/g, '')
  if (s.length === 0) return null

  // 纯阿拉伯数字（含小数、含"万/亿"后缀）
  const arabic = /^(\d+(?:\.\d+)?)([万亿])?$/.exec(s)
  if (arabic) {
    const base = Number(arabic[1])
    if (!Number.isFinite(base)) return null
    const suffix = arabic[2]
    return suffix ? base * CN_SECTIONS[suffix] : base
  }

  let total = 0
  let section = 0
  let current = 0
  let lastUnit = 0
  let sawAny = false
  /**
   * 是否见过「零」。
   *
   * 这个标志专门用来切开两个声学上完全一样、数值却差 100 倍的口语：
   *   一千五   = 1500（省略了「百」，末位是缩略）
   *   一千零五 = 1005（「零」显式声明了这是进位占位，末位是字面个位）
   * 没有它的话，用户说「一千零五」会被听成 1500 —— 一个合法的小额单，
   * 不会有任何闸门报警。见文件头的说明：这类错误只能靠单元断言挡住。
   */
  let sawZero = false

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]
      if (ch === '零' || ch === '〇') sawZero = true
      sawAny = true
      continue
    }
    if (ch in CN_UNITS) {
      const u = CN_UNITS[ch]
      // 「十五」这种省略了前导一：十位前一个数字都没有时按 1 算
      if (current === 0 && u === 10 && !sawAny) current = 1
      section += current * u
      current = 0
      lastUnit = u
      sawZero = false
      sawAny = true
      continue
    }
    if (ch in CN_SECTIONS) {
      const sec = CN_SECTIONS[ch]
      section += current
      total += (section === 0 ? 1 : section) * sec
      section = 0
      current = 0
      lastUnit = sec
      sawZero = false
      sawAny = true
      continue
    }
    // 出现无法识别的字符即判定整体不是数字，交给上层走别的分支
    return null
  }

  // 收尾的裸数字：见过「零」按字面个位处理，否则按上一级单位折算（口语省略）
  if (current !== 0) {
    if (sawZero || lastUnit <= 10) {
      section += current
    } else {
      section += current * (lastUnit / 10)
    }
  }

  if (!sawAny) return null
  const v = total + section
  return Number.isFinite(v) ? v : null
}

/** 货币量词：出现即认定用户在说**名义额**。 */
const NOTIONAL_UNITS = [
  '块钱', '块钱的', '块', '元', '美元', '美金', 'usdt', 'u', 'usd', '刀',
  '名义', '仓位价值', '货值',
]
/** 件数量词：出现即认定用户在说**币的数量**。 */
const QTY_UNITS = ['个', '枚', '张', '份', '颗', '手', 'btc', 'eth', '币']

function unitBasis(segment: string): 'notional' | 'qty' | 'unknown' {
  const low = segment.toLowerCase()
  for (const u of NOTIONAL_UNITS) if (low.includes(u)) return 'notional'
  for (const u of QTY_UNITS) if (low.includes(u)) return 'qty'
  return 'unknown'
}

/**
 * 从一段话里抽出第一个数量，并判定它的语义。
 *
 * 抽取顺序刻意是「先找带单位的长片段，再找裸数字」：
 * 因为裸数字单独出现时语义最含糊，必须让更明确的形式优先命中。
 */
export function extractAmount(text: string): AmountParse | null {
  const s = text.trim()
  if (s.length === 0) return null

  // ① 半 / 一半 —— 比例语义，具体基准由调用方给
  if (/(一半|半仓|半个|半)/.test(s)) {
    const m = /(一半|半仓|半个|半)/.exec(s)!
    // 「半小时」这类时长词不参与金额解析，避免误判
    if (!/(半\s*(小时|分钟|天|周|个月))/.test(s)) {
      return { value: 0.5, matched: m[1], basis: 'unknown', ratio: true }
    }
  }

  // ② 带"万/亿"或带货币/件数量词的片段
  //    数字部分允许汉字或阿拉伯
  const numPat = '(\\d+(?:\\.\\d+)?|[零〇一幺二两三四五六七八九十百千万亿]+)'
  const unitPat = [...NOTIONAL_UNITS, ...QTY_UNITS].join('|')
  const withUnit = new RegExp(`${numPat}\\s*(${unitPat})`).exec(s)
  if (withUnit) {
    const v = parseChineseNumber(withUnit[1])
    if (v !== null) {
      const basis = unitBasis(withUnit[2])
      return { value: v, matched: withUnit[0], basis }
    }
  }

  // ③ 裸数字（含"万/亿"后缀）—— 语义 unknown，交由两段式确认做消歧
  const bare = new RegExp(`(\\d+(?:\\.\\d+)?|[零〇一幺二两三四五六七八九十百千万亿]{1,})`).exec(s)
  if (bare) {
    const v = parseChineseNumber(bare[1])
    if (v !== null) return { value: v, matched: bare[1], basis: 'unknown' }
  }
  return null
}

/** 百分比解析：「百分之五」「5%」「五个点」→ 0.05。 */
export function extractPercent(text: string): { ratio: number; matched: string } | null {
  const pct = /百分之\s*(\d+(?:\.\d+)?|[零〇一幺二两三四五六七八九十百千万亿]+)/.exec(text)
  if (pct) {
    const v = parseChineseNumber(pct[1])
    if (v !== null) return { ratio: v / 100, matched: pct[0] }
  }
  const sym = /(\d+(?:\.\d+)?)\s*%/.exec(text)
  if (sym) return { ratio: Number(sym[1]) / 100, matched: sym[0] }
  const dian = /([零〇一幺二两三四五六七八九十\d]+)\s*个点/.exec(text)
  if (dian) {
    const v = parseChineseNumber(dian[1])
    if (v !== null) return { ratio: v / 100, matched: dian[0] }
  }
  return null
}

/**
 * 把解析出的数量落成可执行的名义额/数量。
 *
 * 单位缺失时的默认规则，是这里唯一需要"拍"的决定，所以把理由写下来：
 *   缺省按**名义额**处理。理由是它更安全 —— 名义额直接受 `maxNotionalPerOrder`
 *   约束，且不随价格漂移；而把「两百」当成 200 个 BTC 会瞬间越过所有闸门。
 *   代价是可能把想表达"200 个"的用户听错，所以这一步**必须**由两段式确认
 *   把解释结果念回去让用户复核（「确认两百块钱」），不能省。
 */
export function resolveAmount(
  amount: AmountParse,
  markPrice: number,
): { notional?: number; qty?: number; basis: 'notional' | 'qty'; note: string } | { error: string } {
  if (amount.ratio) {
    return { error: 'VOICE_RATIO_NOT_SUPPORTED（请说具体金额，如「两百块钱」，不要说「半仓」）' }
  }
  if (!Number.isFinite(amount.value) || amount.value <= 0) {
    return { error: `VOICE_AMOUNT_INVALID（解析到 ${amount.value}）` }
  }
  if (amount.basis === 'qty') {
    return { qty: amount.value, basis: 'qty', note: `按数量 ${amount.value} 处理` }
  }
  if (amount.basis === 'notional') {
    return { notional: amount.value, basis: 'notional', note: `按名义额 ${amount.value} USDT 处理` }
  }
  // unknown：默认名义额，但要在回话里说清楚
  const note =
    Number.isFinite(markPrice) && markPrice > 0
      ? `未听到单位，按名义额 ${amount.value} USDT 处理（约 ${(amount.value / markPrice).toFixed(6)} 个）`
      : `未听到单位，按名义额 ${amount.value} USDT 处理`
  return { notional: amount.value, basis: 'notional', note }
}
