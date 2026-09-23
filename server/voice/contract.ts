/**
 * 合约槽位解析：杠杆 / 品种形态 / 止盈 / 止损
 *
 * ── 这个模块为什么必须存在 ────────────────────────────────────────────
 * 用户实测原话：
 *
 *   「下单 BTC 10 美金 125 倍合约做多，止盈 10 成，止损 1 成」
 *
 * 得到的是**现货 10 U 买入** —— 一个完全合法的单，和用户要的东西毫无关系。
 * 根因不是某条正则写错了，是解析层**根本没有这几栏槽位**：
 * 杠杆、合约形态、止盈、止损四个信息在进入系统的那一刻就被丢掉了，
 * 之后每一层（风控、确认、账本）看到的都是一个"10 U 现货买入"，
 * 而它逐层都合法 ⇒ **没有任何一道门会响**。
 *
 * 这类失败在本仓库的判据表里排在最贵的一族：**合法但不是用户要的**。
 * 它不能靠"风控更严"来挡（那笔单本来就没问题），只能靠在解析层
 * 把槽位**显式装起来**，并在回话里把解释结果念回去让人复核。
 *
 * ── 三条设计约定 ─────────────────────────────────────────────────────
 * ① **只认成词的说法，不猜。** 听不出来就不填那一栏，由上层判低置信度、
 *    转成澄清问句。给一个"默认 1 倍"看着温和，实际是把"没听懂"伪装成
 *    "听懂了"，用户拿到 1 倍现货时无法分辨是哪一种。
 * ② **幅度一律归一成"相对入场价的比例"。** 「一成」= 0.1、「10%」= 0.1、
 *    「止盈 78000」（绝对价）也换算成比例。上层只需要认一种单位 ——
 *    同一栏出现两种单位是本仓库记过的坑（`...Pct` 既可能是 0.1 也可能是 10）。
 * ③ **绝对价形式需要入场价才成立。** 拿不到标记价时**拒绝解析**而不是
 *    拿 0 顶替：用 0 算出来的比例是 Infinity 或 NaN，
 *    而 NaN 会一路静默通过大部分数值比较。
 */
import { parseChineseNumber } from './numerals.ts'

/** 「成」= 十分之一。中文口语里「三成」= 30%，这是**价差**不是概率。 */
export const CHENG = 0.1


export interface ProtectionParse {
  /** 相对入场价的比例。0.1 = 10%。 */
  pct?: number
  /** 命中的原文片段，用于确认回话里原样念回。 */
  matched?: string
  /** 命中了形式但算不出比例时的原因（必须可念，不能是 JSON）。 */
  error?: string
}

/**
 * 杠杆。
 *
 * 认这几种说法：「125 倍」「125倍杠杆」「杠杆 125」「125x」「125X」。
 *
 * ★ 为什么 `x` 那一条要求后面**不是字母数字**：
 *   `BTCUSDT` 里没有数字，但 `10usdt` / `xrp` 这类串里 `x` 很常见。
 *   不加边界的话「买 10 个 xrp」会命中 `x` 分支，把杠杆听成 0 —— 而 0 杠杆
 *   在多数实现里会被 `|| 1` 悄悄兜成 1，于是用户什么都没说，系统记了一笔
 *   "他要求 1 倍"，将来排查时这个记录是**假证据**。
 *
 * ★ 只认整数与一位小数，上限 4 位数字：`1250.5` 这种再大就不是杠杆了。
 *   真正的上界由 `riskConstants.LEVERAGE_HARD_CEILING` 卡，
 *   这里只负责"这是不是一个杠杆数字"。
 */
export function parseLeverage(text: string): { value: number; matched: string } | null {
  const patterns: RegExp[] = [
    // 「125 倍」「125倍杠杆」「三倍」（汉字数字留给上层，这里只认阿拉伯）
    /(\d{1,4}(?:\.\d)?)\s*倍/,
    // 「杠杆 125」「倍数 20」
    /(?:杠杆|倍数)\s*(?:开到|设成|调到|用)?\s*(\d{1,4}(?:\.\d)?)/,
    // 「125x」「125X」「125 x」
    /(\d{1,4}(?:\.\d)?)\s*[xX](?![0-9A-Za-z_])/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (!m) continue
    const v = Number(m[1])
    if (!Number.isFinite(v) || v <= 0) continue
    return { value: v, matched: m[0] }
  }
  return null
}

/**
 * 品种形态。说了「合约 / 永续 / swap / perpetual」才是 SWAP。
 *
 * ★ 刻意**不认裸「期」**：「预期」「期间」「到期」都会命中它，
 *   而把现货听成合约的代价不是报错 —— 是同一句话变成一笔带杠杆的单。
 *   宁可漏判（用户再说一次），不许误判。
 */
export function parseInstType(text: string): 'SPOT' | 'SWAP' {
  return /(合约|永续|swap|perpetual|perp\b)/i.test(text) ? 'SWAP' : 'SPOT'
}

/**
 * 止盈 / 止损。
 *
 * 支持这几种说法，**按单位的明确程度**依次匹配：
 *   ① 成数：`止盈 10 成` / `止盈一成` → 0.1 × n
 *   ② 单位在前的百分比：`止损百分之五` → n/100
 *   ③ 单位在后的百分比：`止损 5%` / `止损 5 个点` → n/100
 *   ④ 绝对价：`止损于 77000` → |77000 − 入场价| / 入场价
 *
 * ★ 「成」与「%」**必须分开算**：`10成` = 100%，`10%` = 10%，差 10 倍。
 *   合成一条正则会让人以为它们一样，而错的那一版照样能通过大多数测试
 *   （因为很少有测试同时写这两种说法）—— 所以烟测里专门有一条
 *   断言"两者之比恰好是 10"。
 *
 * ★ 「百分之五」的单位在**前面**，与「5%」的单位在后面，是两种词序。
 *   只写后一种的实现会把 ASR 最常吐出的那种说法整条漏掉，
 *   而漏掉的表现是**那一栏是空的**（不是报错）—— 用户以为设了保护。
 *
 * ★ 绝对价形式拿不到入场价时**报错而不是默认**：见文件头约定③。
 */
export function parseProtection(
  text: string,
  kind: 'takeProfit' | 'stopLoss',
  entryPrice?: number,
): ProtectionParse {
  // 关键词：止盈 / 止赢 / 获利 / 目标位；止损 / 停损 / 保底
  const kw = kind === 'takeProfit' ? '(?:止盈|止赢|获利|盈利目标|目标位)' : '(?:止损|停损|保底|亏损上限)'
  // ★ 关键词与数字之间允许出现的连接字。少一个就意味着一种说法听不出来，
  //   而"听不出来"在这里表现为**那一栏是空的**（不是报错）——
  //   所以这个连接串越宽越好，它不会误伤：能被它接住的必然是关键词后面的数。
  const gap = '\\s*(?:为|是|到|于|在|设成|设置成|定在|放|挂)?\\s*'
  // 数字：阿拉伯或汉字（ASR 吐汉字是常态）
  const num = '(\\d{1,3}(?:\\.\\d+)?|[零〇一幺二两三四五六七八九十百]+)'
  const numOf = (raw: string): number | null => {
    if (/^[\d.]+$/.test(raw)) {
      const v = Number(raw)
      return Number.isFinite(v) ? v : null
    }
    return parseChineseNumber(raw)
  }

  // ① 成数（单位在后）
  const cheng = new RegExp(`${kw}${gap}${num}\\s*成`).exec(text)
  if (cheng) {
    const v = numOf(cheng[1])
    if (v !== null && v > 0) return { pct: v * CHENG, matched: cheng[0] }
  }

  // ② 百分之…（单位在**前**）—— 词序与 ③ 相反，必须单独一条
  const pctCn = new RegExp(`${kw}${gap}百分之\\s*${num}`).exec(text)
  if (pctCn) {
    const v = numOf(pctCn[1])
    if (v !== null && v > 0) return { pct: v / 100, matched: pctCn[0] }
  }

  // ③ 符号百分号 / 口语「个点」（单位在后）
  const pctSym = new RegExp(`${kw}${gap}${num}\\s*(?:[%％]|个点)`).exec(text)
  if (pctSym) {
    const v = numOf(pctSym[1])
    if (v !== null && v > 0) return { pct: v / 100, matched: pctSym[0] }
  }

  // ④ 绝对价
  const abs = new RegExp(`${kw}${gap}(\\d{2,9}(?:[.,]\\d{1,8})?)`).exec(text)
  if (abs) {
    const price = Number(abs[1].replace(/,/g, ''))
    if (!Number.isFinite(price) || price <= 0) {
      return { error: `${kind}_PRICE_UNREADABLE（读到的价是「${abs[1]}」）`, matched: abs[0] }
    }
    if (!Number.isFinite(entryPrice ?? Number.NaN) || (entryPrice ?? 0) <= 0) {
      return {
        error: `${kind}_NEEDS_ENTRY_PRICE（你给的是绝对价 ${price}，但我现在没有该标的的行情，换算不出比例）`,
        matched: abs[0],
      }
    }
    const v = Math.abs(price - entryPrice!) / entryPrice!
    if (!Number.isFinite(v) || v <= 0) {
      return { error: `${kind}_PRICE_EQUALS_ENTRY（${price} 与现价相同，止盈止损幅度为 0）`, matched: abs[0] }
    }
    return { pct: v, matched: abs[0] }
  }

  return {}
}

/** 「这句话里有没有提到止盈/止损」—— 用来判"用户说了但我没解析出比例"。 */
export function mentionsProtection(text: string): { tp: boolean; sl: boolean } {
  return {
    tp: /(止盈|止赢|获利|盈利目标|目标位)/.test(text),
    sl: /(止损|停损|保底|亏损上限)/.test(text),
  }
}

/**
 * 用户**显式放弃**保护价的说法（"裸单"）。
 *
 * ── 为什么它必须住在 `contract.ts`，而不是散在意图层 ────────────────────
 * 「止盈/止损」这套词义的判据全部住在这个文件（`mentionsProtection` /
 * `parseProtection` / `maskContractFigures`）。豁免是同一套词义的**第三种取值**
 * （不是"要 5%"，也不是"没提"，而是"明确不要"），分开放会让两处对同一句话
 * 给出不同答案 —— 而这个分歧的方向恰好是"用户说不要保护，系统以为他要保护"，
 * 或者反过来（更糟）："用户说要 5% 止损，系统当成不要保护"。
 *
 * ★★ 这些正则**要求"否定词"与"保护词"相邻**。
 *   放宽成"同句出现"会误命中一大类正常句子，例如
 *   「止损不要太大」（主体是"要止损"，只是嫌宽）——
 *   而误判的方向是**把一笔带保护的单读成裸单**（判据 A1：误报比漏报贵）。
 *
 * ★ 刻意**不**收录「没有止损」「不带仓位」这类更松的说法：它们与
 *   "我这次没打算设"和"这个标的没被设过"分不开，而不确定时正确的动作是
 *   **问**，不是猜（那一问由 `service.ts` 出）。
 */
export function parseProtectionWaiver(text: string): { waived: boolean; matched?: string } {
  const t = text.trim()
  const patterns: RegExp[] = [
    /(不带|不要|不用|不需要|不设|不加|不挂|放弃|免了?)(保护|止盈|止赢|止损|停损|止盈止损)/,
    /(保护|止盈|止赢|止损|停损)(就不要|不用|不设|不加|不挂|免了)/,
    /(裸单|裸下|裸奔|裸开)/,
    /(无保护|没有保护|不要任何保护|不做保护)/,
  ]
  for (const re of patterns) {
    const m = re.exec(t)
    if (m) return { waived: true, matched: m[0] }
  }
  return { waived: false }
}

/** 把比例说成人话：「10%」「100%（十倍价的价差）」。 */
export function describePct(pct: number): string {
  const p = pct * 100
  const shown = p >= 100 ? `${p.toFixed(0)}%` : `${p.toFixed(p < 1 ? 2 : 1)}%`
  return shown
}

/**
 * 把「属于杠杆 / 止盈 / 止损的那几个数」从句子里遮掉，只留金额那一段。
 *
 * ── 为什么必须有这一步 ────────────────────────────────────────────────
 * 一句话里常常有好几个数，而 `extractAmount` 的兜底分支只做一件事：
 * **从左往右取第一个数**。于是
 *
 *   「开 125 倍合约做多 BTC 10U」
 *
 * 在单位识别失败时会拿到 **125**（杠杆那个数）当金额 ——
 * 名义额于是被算成 `125 × 125 = 15625` 而不是 `10 × 125 = 1250`，
 * 差了一个数量级还多，而它照样是一笔**合法**的单，所有闸门照常放行。
 *
 * 修法是**按归属划界**：这个词属于谁，那个数就归谁。
 * 遮掉而不是删除（用等长空格替换），是为了让后续按位置做事的代码
 * 不会因为字符串变短而错位。
 */
export function maskContractFigures(text: string): string {
  let out = text
  const blank = (frag: string) => {
    if (!frag) return
    out = out.replace(frag, ' '.repeat(frag.length))
  }
  const lev = parseLeverage(text)
  if (lev) blank(lev.matched)
  // 止盈/止损各自的关键词与数字一起遮掉。这里**不传 entryPrice**：
  // 绝对价形式在拿不到入场价时也会返回 `matched`（只是带一个 error），
  // 而遮它是安全的 —— 一个换算不出比例的绝对价，本来也不该被当成金额。
  for (const kind of ['takeProfit', 'stopLoss'] as const) {
    blank(parseProtection(out, kind).matched ?? '')
  }
  return out
}
