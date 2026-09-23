/**
 * 从用户的话里抽取**可长期记住的事实**。
 *
 * ══ 这一层为什么不许交给模型（红线②）══════════════════════════════════
 * 「什么值得记」是一个**会改变系统下一步行为**的判断：记错了，下一笔单会被
 * 静默套上一个用户没要求的默认值。本系统里这类判断一律走确定性规则
 * （见 `intents.ts` 文件头：LLM 可以决定怎么说，不可以决定做什么）。
 * 好处是它可离线复跑、可逐条断言、结果与温度/模型版本无关。
 *
 * ══ 这一层最危险的一处（写在这里，因为它是本模块的默认风险）═════════════
 * **抽取太宽 ⇒ 每一次下单都会改写长期偏好。**
 *
 * 用户说「用 3 倍杠杆买 100 U 的 BTC」—— 这是一笔**具体订单**，不是偏好。
 * 如果抽取规则只认「杠杆」两个字，那么：
 *   ① 用户下了一笔 3 倍的单 ⇒ 库里出现 `preference.leverage = 3`；
 *   ② 第二天他说「买 100 U 的 BTC」（没说杠杆），召回把它当默认值补上
 *     ⇒ 这笔单**被静默套成了 3 倍合约**，而他以为自己在买现货；
 *   ③ 全程没有任何一道门报错 —— 那笔单本身完全合法。
 *
 * 所以判据刻意**窄**，而且要求**成对**：
 *   · 必须出现**长期性标记**（「以后 / 每次都 / 一向 / 习惯 / 一直 / 总是 / 记住」）；
 *   · **且**整句里不许出现下单动作词（买/卖/开多/做空/平仓…）——
 *     一句话里有动作词，它首先是一笔订单，其次才可能顺带表达偏好；
 *   · **且**不许出现具体的数量/金额（「用 3 倍杠杆」是偏好，
 *     「用 3 倍杠杆开 100 U」是订单）。
 *
 * ★ 「现在」「这次」「这一笔」都不算长期性标记 —— 它们说的是**当下**。
 *   把它们当标记，等于每次下单都在改偏好（同一个坑的另一种写法）。
 */

import type { FactKind } from './memory.ts'

/** 抽取结果。`kind` + `key` 决定它是"同一件事"还是"另一件事"（判据 D2）。 */
export interface ExtractedFact {
  kind: FactKind
  key: string
  /** 中性的事实陈述（消费方自己加「你跟我说过：」之类的前缀）。 */
  text: string
  value: string | number | boolean
  /**
   * `explicit` = 用户明确说了长期约定；`inferred` = 从措辞推出来的。
   * ★ 这个字段决定消费方式：`inferred` 的**必须先念出来**再当默认值用。
   */
  confidence: 'explicit' | 'inferred'
}

/**
 * 长期性标记。
 *
 * ★ 为什么逐词列出而不是用 `(以后|每次|…)+` 之类：逐词才能被**逐一断言**
 *   （"哪些词算标记"是一个必须能被核对的事实，不是风格）。
 * ★ 刻意不含：「现在」「这次」「这一笔」「今天」—— 见文件头。
 */
export const DURABLE_MARKERS: readonly string[] = [
  '以后',
  '每次都',
  '每次',
  '以后都',
  '一向',
  '向来',
  '习惯',
  '一直',
  '总是',
  '从来',
  '记住',
  '记得',
  '往后',
  '今后',
  '设置成',
  '默认',
]

/**
 * 下单动作词 —— **只收带方向的**。
 *
 * ★★ 这里我在第一版里踩过一次，值得写下来：表里原本还有「下单」「开仓」
 *    这两个**不含方向**的词，于是「以后下单都要带止损」被整句拒抽 ——
 *    而那恰恰是最典型的一条长期约定。它的形状很隐蔽：
 *    抽取层静默地少记了一条约定，用户不会知道，**直到某天下单时
 *    系统没按他要求的那样带上止损**。
 *
 * 判据因此收成两条**并列**（任一条成立即跳过），而不是"提到下单就跳过"：
 *   ① 有**方向**的动作词（买/卖/开多/做空/平仓…）—— 它在描述一笔具体的单；
 *   ② 有金额/数量痕迹（见 `AMOUNT_TRACES`）—— 它在描述一笔**有量**的单。
 * 「以后下单都要带止损」两条都不满足 ⇒ 正确抽中。
 * 「用 3 倍杠杆买 100 U 的 BTC」两条都满足 ⇒ 正确跳过。
 *
 * ★ 与 `intents.ts` 的 `BUY_WORDS` / `SELL_WORDS` / `CLOSE_WORDS` **刻意独立**：
 *   那三个是"这句话是不是订单"的判据（意图层），本表是"这句话要不要跳过抽取"。
 *   两者的变更理由不同 —— 意图层加词是因为"系统该认得这个说法"，
 *   本层加词是因为"这种句子会污染偏好"。共用一张表 ⇒ 改任一方静默影响另一方。
 */
export const ORDER_ACTION_WORDS: readonly string[] = [
  '买入', '买进', '买点', '买些', '买',
  '卖出', '卖掉', '卖点', '卖',
  '开多', '做多', '多单', '加仓', '补仓',
  '开空', '做空', '空单',
  '平仓', '清仓', '全平', '全清', '止损离场',
  'long', 'short', 'buy', 'sell',
]

/** 数量/金额痕迹：出现即说明这是一笔具体订单。 */
const AMOUNT_TRACES = /[0-9０-９]+\s*(?:u|usdt|usdc|刀|块|元|美金|美元|万|个|张|股)|\d+\s*%|百分之/

function hasDurableMarker(s: string): boolean {
  return DURABLE_MARKERS.some((m) => s.includes(m))
}
function hasOrderAction(s: string): boolean {
  return ORDER_ACTION_WORDS.some((m) => s.includes(m))
}

/**
 * 抽取入口。**纯函数**：给定同一句话与同一份上下文，永远给同一个结果。
 *
 * ★ 返回数组而不是单条：一句话可以同时表达两件事
 *   （「以后都用仿真，杠杆固定 3 倍」）。压成单条会让后一句覆盖前一句 ——
 *   而覆盖是静默的。
 */
export function extractFacts(utterance: string): ExtractedFact[] {
  const s = utterance.trim()
  if (s.length === 0) return []

  // ── 显式要求记忆：「记住 X」 无条件抽（用户已经明说了这是要记的）──────
  const explicitRemember = /(?:记住|记得|你要记得)[：:，,]?\s*(.{2,80})$/.exec(s)
  if (explicitRemember) {
    const body = explicitRemember[1].trim().replace(/[。！!？?]+$/, '')
    if (body.length > 0) {
      return [{ kind: 'convention', key: `explicit:${hashKey(body)}`, text: body, value: body, confidence: 'explicit' }]
    }
  }

  // ── 以下全部要求"长期性标记"，，且**不含动作词、不含金额** ─────────────
  if (!hasDurableMarker(s)) return []
  if (hasOrderAction(s)) return []
  if (AMOUNT_TRACES.test(s)) return []

  const out: ExtractedFact[] = []

  // 杠杆偏好：「以后合约都用 3 倍杠杆」
  const lev = /(\d+(?:\.\d+)?)\s*倍/.exec(s)
  if (lev) {
    const n = Number(lev[1])
    if (Number.isFinite(n) && n >= 1 && n <= 200) {
      out.push({
        kind: 'preference',
        key: 'leverage',
        text: `习惯用 ${n} 倍杠杆`,
        value: n,
        // ★ 「记住我用 3 倍杠杆」是 explicit；「以后都用 3 倍」也是明说的。
        //   本层没有 inferred 的分支了 —— 那正是刻意的：所有抽出来的都必须
        //   有长期性标记撑腰，凭空推断的偏好不该进库（见文件头）。
        confidence: 'explicit',
      })
    }
  }

  // 保护偏好：「以后都带止损」「以后下单都要保护」
  if (/(带|要|加|有)\s*(止盈)?\s*(止损|保护|止盈止损)/.test(s) || /都带保护/.test(s)) {
    out.push({
      kind: 'convention',
      key: 'protection',
      text: '要求下单都带止盈止损',
      value: true,
      confidence: 'explicit',
    })
  }
  // 反向：「以后不要止损」也是约定，但它与上面是**同一件事的两面** ⇒ 同一个 key。
  // 同一个 key 的后写覆盖前写，正是"用户改主意了"该有的行为。
  if (/(不|别|不用|不要)\s*(止损|保护)/.test(s)) {
    out.push({
      kind: 'convention',
      key: 'protection',
      text: '不要在单子上加止损',
      value: false,
      confidence: 'explicit',
    })
  }

  // 场所偏好：「以后都在 OKX 测试网做」
  const venue = /(okx|okex|币安|binance|测试网|沙盒|sandbox|simulate)/i.exec(s)
  if (venue) {
    const raw = venue[1].toLowerCase()
    const name = raw === 'okex' || raw === 'okx' ? 'OKX' : raw === 'binance' || raw === '币安' ? 'Binance' : 'sandbox'
    const testnet = /测试网|沙盒|sandbox|simulate/i.test(s)
    out.push({
      kind: 'fact',
      key: 'venue',
      text: `主要在 ${name}${testnet ? ' 测试网' : ''} 上活动`,
      value: `${name}${testnet ? ':testnet' : ''}`,
      confidence: 'explicit',
    })
  }

  // 模式偏好：「以后都用仿真 / 一律走实盘」
  if (/都|一律|固定/.test(s)) {
    if (/仿真|模拟|纸面|paper/.test(s)) {
      out.push({ kind: 'preference', key: 'live', text: '要求用仿真模式', value: false, confidence: 'explicit' })
    } else if (/实盘|真钱|真金白银/.test(s)) {
      out.push({ kind: 'preference', key: 'live', text: '要求用实盘模式', value: true, confidence: 'explicit' })
    }
  }

  // 播报偏好：「以后只说报警」「以后别念那么细」
  if (/只说报警|只报报警|别念|少说|不要念/.test(s)) {
    out.push({ kind: 'preference', key: 'verbosity', text: '希望播报更克制', value: 'alarm-only', confidence: 'explicit' })
  } else if (/多说|详细说|都告诉我/.test(s)) {
    out.push({ kind: 'preference', key: 'verbosity', text: '希望播报更详细', value: 'chatty', confidence: 'explicit' })
  }

  return out
}

/**
 * 纠正：「不是 X，是 Y」/「你记错了」。
 *
 * ★ 单列一个函数的原因：它**要求一个已存在的 key 才能生效**。
 *   与 `extractFacts` 分开，是为了让"纠正"这条路的输入多一个来源
 *   （当前库里有什么），从而可以断言"纠正不能凭空空造一条新事实"。
 */
export interface Correction {
  /** 要推翻哪个 key。`null` = 没指明，调用方不许猜。 */
  key: string | null
  /** 用户否定的那个值。 */
  rejected: string | null
  /** 用户给出的正确值。 */
  corrected: string | null
  raw: string
}

/**
 * 明确指出"记忆有错"的词。
 *
 * ★ 刻意**不含裸「不对」「不是这样」** —— 这两个词在日常对话里到处都是
 *   （「这个数不对吧」「不是这样算的」），拿它当触发词会让**每一次普通否定**
 *   都变成一次"删记忆"。而删记忆的效果是**静默**的：用户不会知道自己刚才
 *   那句话把一条偏好抹掉了，他下次选杠杆时才发现。
 * ★ 要求的是"针对记忆本身"的措辞（记错 / 我说错 / 之前说的不对 / 更正）。
 */
const CORRECTION_WORDS = /(记错|记反|你搞错|弄错|我说错|说错了|之前说的不对|纠正一下|更正)/

export function detectCorrection(utterance: string): Correction | null {
  const s = utterance.trim()
  const hasWord = CORRECTION_WORDS.test(s)
  // 「不是 3 倍，是 5 倍」/「不是三倍杠杆」
  const notRight = /不是\s*([^，,。；;]{1,20}?)\s*[，,]\s*(?:而)?是\s*([^，,。；;]{1,20})/.exec(s)
  const key = inferKeyFrom(s)

  // ★ 成对判据（两条**都要**写，缺任一条就是一种坏法）：
  //   · 漏了后半条 ⇒ 「不是这样算的」会被当成一次记忆纠正；
  //   · 漏了前半条 ⇒ 一句明确的「你记错了我不用杠杆」反而漏掉。
  if (!hasWord) {
    if (!notRight || key === null) return null
  }

  if (notRight) {
    return { key, rejected: notRight[1].trim(), corrected: notRight[2].trim(), raw: s }
  }
  const onlyWrong = /不是\s*([^，,。；;]{1,20})/.exec(s)
  if (onlyWrong) {
    return { key, rejected: onlyWrong[1].trim(), corrected: null, raw: s }
  }
  // ★ 走到这里说明有"记错"类词但推不出 key（例如「你记错了」）。
  //   `key: null` 是**有效结果**，不是失败 —— 调用方据此**不动库**，
  //   只回一句"你说哪一条记错了？"。不许猜一个 key 去删（那是最坏的一种处置：
  //   用户只说了"你记错了"，系统却抹掉了一条他根本没提的偏好）。
  return { key, rejected: null, corrected: null, raw: s }
}

/** 从纠正句里推它针对哪个 key。推不出来返回 `null` —— **不许猜**。 */
export function inferKeyFrom(s: string): string | null {
  if (/倍|杠杆/.test(s)) return 'leverage'
  if (/止损|保护/.test(s)) return 'protection'
  if (/okx|币安|测试网|沙盒|场所/i.test(s)) return 'venue'
  if (/实盘|仿真|模拟/.test(s)) return 'live'
  if (/音色|声音/.test(s)) return 'voice'
  if (/播报|说你|念/.test(s)) return 'verbosity'
  return null
}

/** 稳定短哈希（用于「记住 X」这类自由文本的 key）。确定性，不受环境影响。 */
function hashKey(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).slice(0, 8)
}

/** 供面板/文档核对"哪些词算长期性标记"，避免它只活在注释里。 */
export function durableMarkers(): readonly string[] {
  return DURABLE_MARKERS
}
