/**
 * 语音意图解析
 *
 * ── 为什么是确定性的规则，而不是把话丢给大模型 ──────────────────────
 * 这一层决定了「系统接下来会不会动钱」。把这样一个判断交给一个
 * **概率性、不可离线复现、且会随厂商静默换版本**的组件，代价是：
 * 今天「买两百」被解析成开仓，明天同一个模型版本升级后变成查行情 ——
 * 而这个过程没有任何 CI 能发现。
 *
 * 所以分工是硬的：
 *   - **意图与槽位**（要干什么、买哪个、多少钱、是不是实盘）→ 本模块的确定性规则。
 *     它可以离线跑、可以被逐条断言、结果与温度/模型无关。
 *   - **措辞**（怎么把结论说得好听）→ 才允许交给 LLM，且失败时降级为模板句。
 *
 * 换句话说：**LLM 可以决定怎么说，不可以决定做什么。**
 *
 * ── 「不确定」要显式表达 ────────────────────────────────────────────
 * 每个结果都带 `confidence`。凡是缺关键槽位（没说买什么/没说多少钱）的，
 * 一律给低分并在上层转为「请再说一遍」，而不是用默认值补齐 ——
 * 语音缺省的默认值就是「猜」，而下单场景下猜错的代价是真实的。
 */
import type { ParsedIntent, OrderSlots, VoiceIntentName, Verbosity } from './types.ts'
import { extractAmount, parseChineseNumber, resolveAmount } from './numerals.ts'
// ★ 合约槽位（杠杆 / 形态 / 止盈 / 止损）的判据全部住在 `contract.ts`，这里只调用。
//   在这里再写一套正则的后果实测过：同一句话两处给出不同答案，
//   而分歧方向恰好是"用户要 125 倍、系统记了 1 倍"。
import { parseLeverage, parseInstType, parseProtection, parseProtectionWaiver, mentionsProtection, maskContractFigures } from './contract.ts'
import { resolveVoiceRequest } from './voices.ts'
import { looksLikeMission, hasExecutionSignal, parseGoal } from '../mission/goal.ts'
import { heardStartPhrase } from '../mission/consent.ts'
// ★ 「这句话是不是派活」的判据**住在舰队侧**（`fleet/plans.ts`），语音层只调它。
//   为什么必须这样：这里原本有一份自己写的硬编码白名单，与舰队的计划表
//   构成两条口径。实测后果很具体 ——「检查文件是否有用」「没有用的垃圾及时清洗」
//   舰队层能接（hygiene 计划），语音层却回"没听懂"。用户看到的是
//   "它明明能做这件事，却说不会"。判据 8：同一个业务动作不许有两条实现路径。
import { planTask } from '../fleet/plans.ts'

export interface IntentContext {
  /** 当前标的池。**必须**由调用方传入，不允许本模块自己另立一份清单 —— 否则就是两套口径。 */
  symbols: string[]
  /** 取标记价的函数，用于「两百块钱 → 多少个」的回话推算。 */
  /**
   * 标记价。★ `null` = **没有真实报价**（不是 0）。
   * 消费方必须把 `null` 当"我不知道"处理：要么换一种说法，要么拒，
   * 绝不许退化成 0 —— `0 × qty = 0` 会让"名义额上限"这道门永远不触发（红线㉟）。
   */
  markPrice: (symbol: string) => number | null
  /**
   * 指代消解目标：**上一句明确说过的标的**。（`null` = 没有，或不知道。）
   *
   * ── 为什么放在 `ctx` 里，而不是在 `parseIntent` 外面"先补一个标的再调用" ──
   * 在外面补的写法要求调用方**先判断这句话缺不缺标的**，而那个判断本身就是
   * 一份新的解析逻辑：调用方按 A 判"缺"，`parseIntent` 按 B 判"不缺" ——
   * 两处必然分岔，症状是"有时候它听懂了，有时候没有"，而两句都是
   * 合理的实现（判据 D2：一件事只许有一个主人）。
   *
   * 放进 `ctx` 之后，消解发生在**唯一的那个** `resolveSymbol` 里，
   * 而且只在三条常规判据**全部落空**之后才用（见该函数注释）。
   *
   * ★ 用它补出来的结果必须能被**说出来**（`ParsedIntent.resolvedByReference`）。
   *   记忆/上文是**推断**，不是用户这句话说的；不声明就等于"猜"（判据 D7）。
   */
  referTo?: string | null
}

/**
 * 基础资产的中文别名。
 *
 * 映射到**基础资产**（BTC / ETH）而不是直接映射到交易对，
 * 这样「比特币」能不能下单，最终由 `ctx.symbols` 决定 ——
 * 池子里没有就老实说没有，而不是替用户拼一个 BTCUSDT 出来。
 */
const BASE_ASSET_ALIASES: Record<string, string[]> = {
  BTC: ['比特币', '比特', '大饼', 'btc'],
  ETH: ['以太坊', '以太', '姨太', '二饼', 'eth'],
  SOL: ['索拉纳', '索拉娜', 'sol'],
  BNB: ['币安币', 'bnb'],
  DOGE: ['狗狗币', '狗币', 'doge'],
  XRP: ['瑞波', 'xrp'],
  ADA: ['艾达', 'cardano', 'ada'],
}

/** 从交易对里切出基础资产（BTCUSDT → BTC）。已知报价币后缀才切，避免误切。 */
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH']

function baseOf(symbol: string): string {
  const up = symbol.toUpperCase()
  for (const q of QUOTE_SUFFIXES) {
    if (up.endsWith(q) && up.length > q.length) return up.slice(0, -q.length)
  }
  return up
}

/**
 * 指代词表（**窄表**）。
 *
 * ★ 刻意不含「这个」：它是"当下这个"，可以指页面、指按钮、指一行字，
 *   误命中率高。一个误命中的指代会让用户拿到**另一个标的**的答案，
 *   而那个答案在字面上完全说得通（判据 D5 的那类失败）。
 * ★ 与 `memoryExtract` 里那张表**故意不同步**：那里判"要不要记",
 *   这里判"这句话在指谁"。共用一个表 ⇒ 改任一方静默影响另一方。
 */
const REFERENTIAL_WORDS: readonly string[] = ['它', '那个', '那只', '这只', '该标的', '刚才那个', '刚才说的']

/** 这句话里有没有**指代**。纯函数，可离线穷举反例。 */
export function mentionsReferent(text: string): boolean {
  // ★ 先摘掉「其他 / 其它」：它们是"别的"，不是指代。
  const cleaned = text.replace(/其[他它]/g, '')
  return REFERENTIAL_WORDS.some((w) => cleaned.includes(w))
}

/**
 * 把话里的标的名解析成池子里的交易对。
 * 命中不了返回 null —— 由上层回一句「池子里没有这个标的」，不猜。
 *
 * ── 判据的顺序不可交换（第 ④ 条必须在最后）──────────────────────────────
 * ①②③ 是**字面**命中，④ 是**指代**命中。
 * 把 ④ 提前的后果：「比特币现在多少钱」在池子里有 BTCUSDT 时会被
 * 指代目标（比如上一句说的 ETHUSDT）抢走 —— 用户明说了标的，
 * 系统给了另一个币的价，而那个价**是真的**（判据 D5 的镜像）。
 */
export function resolveSymbol(text: string, symbols: string[], referTo?: string | null): string | null {
  const low = text.toLowerCase()
  // ① 整对名直命（btcusdt / btc-usdt / btc/usdt）
  const compact = low.replace(/[-/_\s]/g, '')
  for (const s of symbols) {
    if (compact.includes(s.toLowerCase())) return s
  }
  // ② 基础资产别名 → 在池子里找同基础资产的交易对
  for (const [base, aliases] of Object.entries(BASE_ASSET_ALIASES)) {
    if (!aliases.some((a) => low.includes(a))) continue
    const hit = symbols.find((s) => baseOf(s) === base)
    if (hit) return hit
    return null // 说了这个币但池子里没有 —— 显式失败，不要 fallback 到别的标的
  }
  // ③ 只说基础资产代码（「买点 eth」）
  for (const s of symbols) {
    const b = baseOf(s).toLowerCase()
    if (b.length >= 2 && new RegExp(`\\b${b}\\b`).test(low)) return s
  }
  // ④ 指代消解：字面全落空、且这句话在指代、且上一句的标的还在池子里
  if (referTo != null && referTo !== '' && symbols.includes(referTo) && mentionsReferent(text)) {
    return referTo
  }
  return null
}

const BUY_WORDS = /(买入|买进|买点|买些|买|开多|做多|加仓|补仓|多单|long)/
const SELL_WORDS = /(卖出|卖掉|卖点|卖|开空|做空|空单|short)/
/**
 * 平仓的触发词。
 *
 * ★★ 第四十六轮补词（`memory-smoke` 的 M9 抓到的**真缺陷**，不是记忆层引入的）：
 *    原表只有「平仓 / 清仓 / 全平 / 全清 / 关掉 / 退出 / close」，于是
 *    **口语中最常说的那几种说法全部漏掉**：
 *
 *      「平掉它」  → 判成 `query_market`（答了一个现价，**没有平仓**）
 *      「把它平了」→ 同上
 *      「清掉它」  → 同上
 *
 *    这是本项目已记录过的**第三族缺陷**（"答案看起来完全正确 ——
 *    系统没报错、给的数还是真的，只有用户的意图在过程里没了"）：
 *    用户以为它要平仓，系统答了一句现价，而他没有任何线索能发现
 *    "平仓"这件事被换成了"报个价"。比 `unknown` 更坏 ——
 *   至少 `unknown` 还看得出"没听懂"。
 *
 * ★ 为什么它现在才暴露：在此之前「平掉**它**」根本认不出标的（`unknown`），
 *   而 `unknown` 会走到兜底问模型，那条路至少不会装成"我要平仓"。
 *   指代消解让这句话**第一次真正可达**，可达就必须正确 ——
 *   这也是"补能力会连带暴露旧欠账"的又一个实例。
 *
 * ★ 补词的取舍：「平」单字**刻意不收**（会误命中「平价 / 水平 / 公平」），
 *   只收「平掉 / 平了」这类双字组合。宁可少收一个说法（落到兜底问模型），
 *   不要多收一个（把无关的话判成平仓，那是不可逆的动作）。
 */
const CLOSE_WORDS = /(平仓|平掉|平了|清仓|清掉|清光|全平|全清|关掉|退出|止损离场|close)/
/** 判「实盘」的词。缺省一律 paper —— 语音最容易误触发，默认必须是最安全的那个模式。 */
const LIVE_WORDS = /(实盘|真钱|真金白银|真实资金|上真仓|live)/
const PAPER_WORDS = /(模拟|仿真|纸面|沙盒|paper|sandbox)/

/**
 * 「这句话在问**未来**会到哪」，而不是在问"现在多少"。
 *
 * ★ 词表的取舍：刻意**不含裸「行情」「价格」「多少钱」** —— 那三个词是
 *   `query_market` 的合法触发词（「比特币现价多少」必须继续回现价）。
 *   含了它们的后果是每一句查行情都被升级成一次 6 秒的预测，
 *   而用户只是想知道现在多少钱。
 * ★ 也不含裸「未来」「接下来」：这两个是**时间副词**，可以修饰任何问题
 *   （「接下来我该看哪个页面」）。只认"未来 + 会到哪"的味道。
 */
const FORECAST_WORDS =
  /(预测|预判|预估|前瞻|走势图|走势|行情走向|会怎么走|怎么个走法|后市|方向性判断|会涨还是会跌|涨还是跌|能不能涨|能涨到|能跌到|能到多少|目标价|看到哪)/

/**
 * 把「未来 N 小时 / N 分钟 / 半小时」听成分钟数。
 *
 * ★ 只认**带单位**的数。裸数字不认 —— 「预测 4」里的 4 是什么意思？
 *   猜一个等于替用户填槽位，而槽位猜错的下场是给他一个别的时间跨度的结论，
 *   那句结论在字面上完全说得通（判据 24：说不出来就别说，别拿默认值顶）。
 * ★ 中文数词走 `parseChineseNumber`（与金额解析同一个实现），
 *   不在这里再写一份"一二三"映射 —— 两套迟早对「十二」这种给出不同答案。
 */
export function parseHorizonMinutes(s: string): number | null {
  const m = /([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十百]+|半)\s*(?:个)?\s*(小时|钟头|hour|hrs|h|分钟|min)/i.exec(s)
  if (!m) return null
  const tok = m[1]
  const unit = m[2].toLowerCase()
  const n = tok === '半' ? 0.5 : /^[0-9.]/.test(tok) ? Number(tok) : parseChineseNumber(tok)
  if (n === null || !Number.isFinite(n) || n <= 0) return null
  const minutes = /^(分钟|min)$/.test(unit) ? n : n * 60
  return minutes > 0 ? minutes : null
}

/**
 * 这句话的标的**是不是靠上文才认出来的**。
 *
 * ★ 判据刻意**复用** `resolveSymbol` 而不是另写一份"这句子缺不缺标的"：
 *   另写一份的下场是两处对同一句话给出不同答案 ——
 *   上层按 A 判"用了指代"于是念了一句"我按上一句理解"，
 *   而解析层按 B 根本没消解，用户听到的解释与系统实际做的事**不一致**
 *   （判据 18：文案描述的不是真正在跑的逻辑）。
 *
 * 四条缺一不可：有指代目标 · 目标还在池子里 · 这句话在指代 · 字面判据全落空。
 */
function usedReference(text: string, ctx: IntentContext): boolean {
  const ref = ctx.referTo
  if (ref == null || ref === '') return false
  if (!ctx.symbols.includes(ref)) return false
  if (!mentionsReferent(text)) return false
  // ★ 不传 `referTo` 再算一次：返回 null 才说明"字面真的认不出来"。
  //   字面能认出来时**不许**标成指代 —— 那会在回话里凭空多一句
  //   "我按上一句理解的"，而用户明明说了标的。
  return resolveSymbol(text, ctx.symbols) === null
}

export function parseIntent(text: string, ctx: IntentContext): ParsedIntent {
  const r = parseIntentOnce(text, ctx)
  // ★ 包装而不是在每个 return 点插一个字段：`parseIntentOnce` 里有二十来处
  //   early return，逐个手改**必漏**（而漏掉的那一处表现是"偶尔不声明指代"，
  //   几乎不可能被人工发现）。包装的写法只有一处判据。
  if (!usedReference(text, ctx)) return r
  const sym = r.slots?.symbol ?? null
  if (sym === null || sym !== ctx.referTo) return r
  return { ...r, resolvedByReference: true }
}

function parseIntentOnce(text: string, ctx: IntentContext): ParsedIntent {
  const raw = text.trim()
  const s = raw.toLowerCase()
  if (raw.length === 0) return { intent: 'unknown', confidence: 0 }

  // ── 启动口令（任务）**必须排在通用确认之前** ──────────────────────────
  //
  // 两个确认通道共用「确认」二字，含义却完全不同：
  //   通用确认   → 对一笔**待确认的订单**复述金额（两段式确认的第二段）
  //   启动口令   → 对一份**已裁定的任务**说出口令词 + 四位口令码
  //
  // 顺序反了的后果不是报错，是**串台**：「确认启动 4821」会被通用确认接走，
  // 用户收到一句"现在没有待确认的操作" —— 而他明明在授权启动。
  // 今天通用确认恰好因为"其余部分必须是纯数字"这条约束而放过了它，
  // 但那是**侥幸**：将来有人放宽那个词表（比如允许「确认」后跟中文），
  // 串台会变成静默的，而且它落在最不该出错的那条路径上。
  // 所以位置钉在这里，不靠下一条规则的副作用。
  if (heardStartPhrase(raw)) {
    return { intent: 'confirm_mission_start', confidence: 1, matched: raw }
  }

  // ── 确认 / 取消：优先于一切，否则「确认」二字会被当成查询 ──
  //
  // 确认有两种说法，必须都认：
  //   ① 光说「确认」
  //   ② 复述金额：「确认 800」「确认两百」
  // 第二种是**主要形态** —— 两段式确认要用户把金额念回来，
  // 只认第一种的话，规范操作反而会被判成"没听懂"。
  //
  // 但「确认一下我的持仓」不能被误判成确认，所以加了"其余部分必须是纯数字"
  // 这个约束：确认动作只携带一个数，多余的词一律视为别的意图。
  const confirmLead = /^(确认|确定|confirm|yes|ok|好的|执行|下单吧|干吧)\s*/
  if (confirmLead.test(s)) {
    const rest = s.replace(confirmLead, '').trim()
    if (rest === '' || /^[\d零〇一幺二两三四五六七八九十百千万亿.]+$/.test(rest)) {
      return { intent: 'confirm', confidence: 1, matched: raw }
    }
  }
  if (/^(取消|算了|别了|不用了|不要了|再想想|no|cancel)\s*$/.test(s)) {
    return { intent: 'reject', confidence: 1, matched: raw }
  }

  // ── 静音 / 停止播报 ──
  if (/(别说了|闭嘴|安静|静一静|停止播报|别播了|勿扰|停一下播报|shut up)/.test(s)) {
    return { intent: 'stop_talking', confidence: 0.95, matched: raw }
  }
  // ── 重复 ──
  if (/(再说一遍|重复一遍|没听清|刚才说什么|念一遍|重说)/.test(s)) {
    return { intent: 'repeat', confidence: 0.95, matched: raw }
  }
  // ── 换音色（要在其它查询之前判，因为「安静」也可能是音色诉求）──
  const voiceId = resolveVoiceRequest(s)
  if (voiceId) {
    return { intent: 'switch_voice', confidence: 0.9, matched: raw, voiceId }
  }
  // ── 播报详略 ──
  if (/(啰嗦|多说点|详细播报|全都要听|多说|话多)/.test(s)) {
    return { intent: 'set_verbosity', confidence: 0.9, matched: raw, verbosity: 'chatty' }
  }
  if (/(简洁|说重点|少说点|只说报警|只报报警|话少|别啰嗦)/.test(s)) {
    const v: Verbosity = /(只说报警|只报报警)/.test(s) ? 'alarm-only' : 'normal'
    return { intent: 'set_verbosity', confidence: 0.9, matched: raw, verbosity: v }
  }
  // ── 介绍自己 / 帮助 ──
  //
  // 两者都是"问我是谁、能干什么"，但内容不同，所以是两个意图：
  //   介绍自己 → 我是谁、我替你管什么（身份与职责）
  //   帮助     → 具体怎么说（操作清单）
  //
  // ★ 为什么单列一条而不是并进「帮助」：用户问"介绍一下你自己"时，
  // 想听的不是操作手册，而是"你是个什么东西、能替我做哪些事"。
  // 旧实现里没有"介绍"这个词，这句话会一路走到兜底 —— 结果是**没听懂**。
  // 一个连自我都介绍不出来的助手，用户不会把交易交给它。
  //
  // 正则刻意只认"介绍自己"这类自指，不认裸「介绍」：
  // 「介绍一下比特币」是在问标的，不该被这一条接走（它会落到兜底问行情）。
  if (/(自我介绍|介绍(一下|下)?(你)?自己|介绍一下你|你是谁|你是什么|你叫什么|认识一下你)/.test(s)) {
    return { intent: 'introduce', confidence: 0.95, matched: raw }
  }
  if (/(你能干什么|你会干什么|会干什么|怎么用|帮助|使用说明|help|有什么功能|有什么本事)/.test(s)) {
    return { intent: 'help', confidence: 0.9, matched: raw }
  }

  // ── 关于「系统本身」的四条（管家是独立智能体，不只是账户播报器）──────────
  //
  // ★ 为什么必须排在这里（介绍/帮助之后、熔断与下单之前）：
  //   ① 排在「熔断 / 撤单 / 下单」之后会被抢走："系统状态"里那个"状态"二字
  //      会被下面的 `query_status` 吃掉，用户问的是全系统，收到的是自动驾驶的近况。
  //   ② 排在 `query_market` 兜底之后则永远轮不到 —— 兜底会把"认出标的就当问行情"接走。
  //   ③ 这一组只**解析**，不动任何状态：产出的都是只读意图。
  //
  // ★ 顺序在组内也有讲究：`self_upgrade` 必须排在 `ask_lab` **之前**。
  //   否则「进化一下自己」会先命中 `ask_lab` 里的"进化"二字，
  //   变成一段"实验室现状介绍" —— 用户要的是动手，收到的是一篇说明书。
  //   同理 `record_lesson` 排在 `ask_lab` 之前：「记住这条」不能被当成"问心法库"。

  // ① Agent 舰队成员状态（只读）
  //
  // ★ 必须排在 `ask_fleet` **之前**：`ask_fleet` 认裸「舰队」二字，
  //   而那两个字在这句里出现的含义完全不同 —— 用户问的是"那几个干活的成员"。
  //   排后面的后果是问"Agent 舰队现在什么样"会收到一段策略排名（答非所问、
  //   却听起来像在回答，正是本仓库记过的第三族失败）。
  //
  // ★ 但**光有"舰队"不够**：S14 里那句「Agent 舰队里哪个策略盈利最高」问的是
  //   **策略排行**，不是成员状态。第一版规则只看 `agent 舰队` 就命中，
  //   被 smoke 当场抓出来（期望 ask_fleet、实际 ask_agents）。
  //   所以判据拆成两条：要成员/状态的味道，**且不能有策略/收益的味道**。
  //   缺了后半条，这个意图会把流水线那一整类问题全抢走。
  const memberStatusAsk = /(agent\s*舰队|智能体舰队|舰队(的)?(成员|状态|什么样|跑没跑|跑过没)|(成员|智能体).{0,4}(状态|跑没跑|跑过没|有没有在跑)|哪个\s*agent|哪些\s*agent|几个\s*agent|谁在(干活|跑))/i.test(
    s,
  )
  const strategyRankAsk = /(策略|候选|盈利|收益|赚|排名|排行|表现|胜率)/.test(s)
  if (memberStatusAsk && !strategyRankAsk) {
    return { intent: 'ask_agents', confidence: 0.88, matched: raw }
  }

  // ② 派舰队干活（有副作用：链上可能含写台账的动作成员）
  //
  // ★ 这一条治的是用户实测反馈的原话：「连一键启动自治循环都启动不了，
  //   扩候选基因空间和换因子族等都听不懂」。
  //
  // ★ 判据**不在这一层** —— 这里只把原话原样交给舰队的 `planTask()`，
  //   由它决定能不能接。语音层自己再实现一套匹配就会长出第二条"能听懂什么"
  //   的口径，而两条口径迟早不一致。实测抓到的正是这个：语音层那份**硬编码
  //   白名单**漏掉了「检查文件是否有用」「没有用的垃圾及时清洗」，
  //   而舰队层本来就能接（hygiene 计划）—— 用户收到的是"没听懂"。
  //
  // ★ 它必须排在 `self_upgrade` 之前：「挖因子」这种说法交给因子生产链
  //   （生产 → 筛查 → 核对）比交给提案引擎更贴原意 —— 提案引擎产的是策略，
  //   而用户说的是因子。
  const planned = planTask(raw)
  if (planned.plan) {
    return { intent: 'dispatch_task', confidence: 0.9, matched: raw, taskGoal: raw }
  }

  // ③ 跑一轮提案（有副作用：往晋级流水线写候选）
  if (/(进化(一下|下|一)?(你)?自己|升级(一下|下|一)?(你)?自己|改进(一下|下|一)?自己|优化(一下|下|一)?自己|自己(进化|升级|改进|改代码)|跑一轮(因子|提案|策略)|生成(因子|策略)?提案|研发(一个|个|一套)?策略|自我进化)/.test(s)) {
    return { intent: 'self_upgrade', confidence: 0.9, matched: raw }
  }

  // ④ 登记一条心法（有副作用：写心法库，而心法会被回注进提案上下文）
  //
  // 触发词之后的部分**整段当心法正文**。刻意不做任何"提炼" ——
  // 让模型改写用户的原话，等于把一条可核对的规则变成一句可能是幻觉的转述，
  // 而心法是长期污染面。
  const lessonTrigger = /^\s*(?:请?你?帮我)?(?:记住|记一下|记下来|记录一下|把这条记(?:下|住|上)?|加一条心法|登记一条心法|存成心法|沉淀成心法)\s*[：:，,]?\s*/
  if (lessonTrigger.test(raw)) {
    const body = raw.replace(lessonTrigger, '').trim()
    return { intent: 'record_lesson', confidence: 0.85, matched: raw, lessonText: body }
  }

  // ⑤ 系统实况（只读）
  //
  // ★★ 这里是「系统 + 问状态」这类话的**唯一主人**。舰队计划表里的 `status` 计划
  //   刻意**不认「系统」**（只认"整体/全局"），否则同一句话被两层同时认领，
  //   而本层排在计划表**之后** ⇒ 用户问一句"系统现在什么情况"，收到的是
  //   **四个成员的巡检汇报** —— `test:voice` S14 当场变红，就是这么抓出来的。
  //   归属划清：**系统 → 这里**（只读实况，语音管家自己的出口）；
  //   **整体/全局 → 舰队 status 计划**（真去查四个读类成员）。两边都有断言钉着。
  //   `怎么样 / 如何` 也收在这里，是为了**堵住上面这个改动带来的洞**：既然计划表
  //   不再认「系统」，那"系统怎么样"就必须由这里接住，否则它会一路掉到行情兜底上去。
  if (/(系统(现在)?(什么|啥|的)?(情况|状态|总览|怎么样|如何)|全系统|整个系统|系统体检|体检一下|你都知道(什么|些什么)|你都(了解|管|掌握)(什么|些什么|哪些)|全局(情况|状态)|(汇报|报告)一下(全部|所有|整体|全局)|系统总览|总览一下)/.test(s)) {
    return { intent: 'ask_system', confidence: 0.9, matched: raw }
  }

  // ④ 舰队排行（只读）
  //
  // ★ 判据刻意要求"排行/列举"的味道，不认裸「策略」二字：
  // 「研发一个策略去达成目标」是在提执行诉求，属于任务层 ——
  // 让裸「策略」命中这里，那句会被降级成"给你看看流水线"，任务就丢了。
  // 这与「任务不许被换成一个报价」是同一类失败，只是换了个方向。
  if (/(舰队|策略(池|排名|排行|列表|清单)|哪个策略|哪些策略|策略.{0,4}(赚|盈利|赚钱|收益|表现)|(盈利|收益)最高|表现最好|哪个(agent|智能体)|几条候选|候选策略)/.test(s)) {
    return { intent: 'ask_fleet', confidence: 0.88, matched: raw }
  }

  // ⑦ 进化实验室（只读）
  if (/(进化实验室|实验室|心法|谱系|晋级流水线|晋升流水线|流水线|自进化|进化(能力|机制|了没)|evolution)/.test(s)) {
    return { intent: 'ask_lab', confidence: 0.85, matched: raw }
  }

  // ── 熔断（必须在普通下单之前判，「全部撤单并熔断」不能被听成一次下单）──
  if (/(熔断|紧急停止|全部停下|停止一切交易|一键清仓并停止)/.test(s)) {
    return { intent: 'killswitch_on', confidence: 0.95, matched: raw }
  }
  const liftKill = /(解除熔断|恢复交易|取消熔断)/.test(s)
  if (liftKill) return { intent: 'killswitch_off', confidence: 0.95, matched: raw }

  if (/(全部撤单|撤掉所有单|撤所有|清空挂单|一键撤单)/.test(s)) {
    return { intent: 'cancel_all', confidence: 0.95, matched: raw }
  }
  if (/(撤单|取消订单|取消挂单)/.test(s)) {
    const m = /(?:单号|订单号|id)\s*([A-Za-z0-9_-]{3,})/.exec(raw)
    return { intent: 'cancel_order', confidence: m ? 0.9 : 0.5, matched: raw, orderId: m?.[1] }
  }

  if (/(暂停|停一下|先停下|别交易了|挂起)/.test(s) && !/(暂停播报)/.test(s)) {
    return { intent: 'pause', confidence: 0.92, matched: raw }
  }
  if (/(继续|恢复|接着跑|重启自动|上班吧)/.test(s)) {
    return { intent: 'resume', confidence: 0.9, matched: raw }
  }

  // ── 平仓 ──
  if (CLOSE_WORDS.test(s)) {
    const symbol = resolveSymbol(raw, ctx.symbols, ctx.referTo) ?? undefined
    const all = /(全部|所有|都|清空|全平)/.test(s)
    return {
      intent: 'close_position',
      confidence: symbol || all ? 0.9 : 0.7,
      matched: raw,
      slots: { side: 'sell', symbol: symbol ?? '', live: LIVE_WORDS.test(s) },
    }
  }

  // ── 下单 ──
  const wantsBuy = BUY_WORDS.test(s)
  const wantsSell = SELL_WORDS.test(s)
  if (wantsBuy || wantsSell) {
    const side: 'buy' | 'sell' = wantsBuy && !wantsSell ? 'buy' : wantsSell && !wantsBuy ? 'sell' : 'buy'
    const ambiguousSide = wantsBuy && wantsSell
    const symbol = resolveSymbol(raw, ctx.symbols, ctx.referTo)
    // ★ `?? Number.NaN`：下游 `numerals.ts` 用 `Number.isFinite(markPrice) && markPrice > 0`
    //   判"能不能折算个数"。给 NaN 就是"折不出来"，而给 0 会被它当成一个合法价位。
    const mark = symbol ? (ctx.markPrice(symbol) ?? Number.NaN) : Number.NaN

    const slots: OrderSlots = { side, symbol: symbol ?? '' }
    const live = LIVE_WORDS.test(s) ? true : PAPER_WORDS.test(s) ? false : false
    slots.live = live

    // ── 合约槽位（杠杆 / 形态 / 止盈 / 止损）────────────────────────────
    //
    // ★★ 这一段的存在理由就是用户实测那次偏离：
    //   「BTC 10 美金 125 倍合约做多，止盈 10 成，止损 1 成」→ 现货 10 U 买入。
    //   当时这四个信息在**解析层就被丢掉了**，之后每一层看到的都是
    //   "一笔 10 U 现货买入"，逐层合法 ⇒ 没有任何门会响。
    //   所以它们是**必须先在这里装起来**的，不能指望下游再补。
    //
    // ★ 解析全部委托给 `contract.ts`（判据只留一份）：
    //   如果这里再写一套正则，两套迟早对同一句话给出不同答案，
    //   而这个分歧的方向恰好是"用户要 125 倍，系统记了 1 倍"。
    const instType = parseInstType(raw)
    const lev = parseLeverage(raw)
    const protectMentions = mentionsProtection(raw)
    if (instType === 'SWAP') {
      slots.instType = 'SWAP'
      // 只认 U 本位。币本位要用户明说「币本位」才切 —— 它改变的是保证金币种，
      // 猜错的代价是拿一个币去抵押另一个币的仓位。
      slots.settle = /(币本位|inverse|反向合约)/.test(s) ? 'inverse' : 'linear'
    }
    if (lev) slots.leverage = lev.value

    const tp = protectMentions.tp ? parseProtection(raw, 'takeProfit', mark) : {}
    const sl = protectMentions.sl ? parseProtection(raw, 'stopLoss', mark) : {}

    // ── ★★ 显式放弃保护（裸单）──────────────────────────────────────────
    //
    // ★ 为什么这一支必须排在装保护之前：用户说「不要止损」时，
    //   `mentionsProtection` 会**如实**返回 `sl: true`（句子里确实有"止损"二字），
    //   接着 `parseProtection` 找不出比例 ⇒ 旧行为会给他一句
    //   "你说了止损但我没解析出比例" —— 而他的意思正好相反。
    //   ⇒ 先问"这句话是不是在**放弃**保护"，是的话就**不要再装**，
    //     也不许报"说了没解析出来"。
    //
    // ★ 同句既说放弃、又给了数字（「止盈 5% 不要保护」）⇒ **拒绝并要求重说**。
    //   这是本仓库对自相矛盾的既定处置（见 `judgeLeverage`：
    //   "两个方向你挑一个说，我不替你改"）。不挑的理由：挑错的方向是
    //   **把一笔用户想要保护的单裸下出去**，而那个错误没有任何下游会响。
    const waiver = parseProtectionWaiver(raw)
    if (waiver.waived) {
      if (tp.pct || sl.pct) {
        return {
          intent: 'place_order',
          confidence: 0.2,
          matched: raw,
          slots,
          error:
            'VOICE_PROTECTION_CONTRADICTS（这句话里既有"放弃保护"又有止盈/止损的数字，' +
            '我不替你挑一个 —— 要保护就把数字留下、别说不要，要裸单就把数字去掉）',
        }
      }
      slots.protectionWaived = true
      slots.protectionWaiverMatched = waiver.matched
    } else {
      if (tp.pct) slots.takeProfitPct = tp.pct
      if (sl.pct) slots.stopLossPct = sl.pct
      if (tp.matched || sl.matched) {
        slots.protectionMatched = { takeProfit: tp.matched, stopLoss: sl.matched }
      }
      // 说了却解析不出比例 —— 记下来，回话里必须念出来（判据 24）。
      if ((protectMentions.tp && !tp.pct) || (protectMentions.sl && !sl.pct)) {
        slots.protectionUnparsed = {
          ...(protectMentions.tp && !tp.pct ? { takeProfit: true } : {}),
          ...(protectMentions.sl && !sl.pct ? { stopLoss: true } : {}),
        }
      }
    }
    // 「说了止盈/止损，但比例没解析出来」——必须显式说出来。
    // 沉默的后果是：用户以为设了保护，实际上一手裸单在跑，而界面上什么都不缺。
    // ★ 走豁免那支时它是 `undefined`：那两个字是"不要"的一部分，不是"要"。
    const protectError = waiver.waived ? undefined : (tp.error ?? sl.error)

    // ★★ 抽金额之前**先把不归它管的数遮掉**（杠杆 / 止盈 / 止损那几个数）。
    //   不遮的后果实测过：「开 125 倍合约做多 BTC 10U」拿到了 125 当金额，
    //   名义额成了 125×125=15625，比 1250 大一个数量级，而它照样是合法单。
    //   判据 29 那一族：一句话里有几个数，就得先问"这个数归谁"。
    const amt = extractAmount(maskContractFigures(raw))

    let confidence = 0.55
    if (ambiguousSide) confidence -= 0.25
    if (!symbol) confidence -= 0.25
    if (!amt) confidence -= 0.2
    // 说了合约却没给倍数：不是错，但必须让用户知道现在按几个倍算。
    if (instType === 'SWAP' && !lev) confidence -= 0.15
    if (protectError) confidence -= 0.15

    if (amt) {
      const resolved = resolveAmount(amt, mark)
      if ('error' in resolved) {
        // 数量解析失败仍然报 place_order，但把原因带出去：
        // 上层据此回一句具体的「我没听出金额」，而不是笼统的"没听懂"。
        return { intent: 'place_order', confidence: 0.2, matched: raw, slots, error: resolved.error }
      }
      if (resolved.basis === 'qty') {
        slots.qty = resolved.qty
        slots.amountBasis = 'qty'
      } else {
        // ★★ 合约 + 明确杠杆 + 说的是钱 ⇒ 这个钱是**保证金**，不是名义本金。
        //
        //   中文口语里「10 美金开 125 倍合约」说的是我出 10 U，
        //   敞口是 1250 U。而风控量的是名义本金 ——
        //   若按名义 10 U 走，用户拿到的是他想要敞口的 1/125，
        //   单子照样成交、账本照样平，**没有任何一处会显示异常**。
        //
        //   这个判断只在"合约 + 说了倍数"时成立：
        //   现货说「买两百块钱」就是名义 200 U，那个语义没变，不许一起改。
        //
        // ★ 先把名义额取出来并校验，再决定乘不乘倍数。
        //   直接写 `resolved.notional * lev` 时，若 notional 是 undefined，
        //   表达式会静默变成 NaN，而 NaN 能一路通过大部分数值比较 ——
        //   最后表现为"下单成功但数量是 0"或直接崩在 venue 里。
        const base = resolved.notional
        if (!Number.isFinite(base) || (base as number) <= 0) {
          return {
            intent: 'place_order',
            confidence: 0.2,
            matched: raw,
            slots,
            error: `VOICE_AMOUNT_INVALID（名义额解析为 ${String(base)}）`,
          }
        }
        const asMargin = instType === 'SWAP' && lev !== null && lev.value > 1
        if (asMargin) {
          slots.notional = (base as number) * lev!.value
          slots.amountBasis = 'margin'
        } else {
          slots.notional = base as number
          slots.amountBasis = 'notional'
        }
      }
      confidence += 0.2
      const err = protectError
      return {
        intent: 'place_order',
        confidence: Math.max(0, Math.min(1, confidence)),
        matched: raw,
        slots,
        ...(err ? { error: err } : {}),
      }
    }
    return {
      intent: 'place_order',
      confidence: Math.max(0, Math.min(1, confidence)),
      matched: raw,
      slots,
      error: 'VOICE_AMOUNT_MISSING（没听到数量）',
    }
  }

  // ── 走势预测（只读）────────────────────────────────────────────────────
  //
  // ★★ 位置三条理由（按重要性排）：
  //
  //   ① **不排在这里，用户的原话就走错路。** 实测 2026-09-21（`_iprobe_r24.txt`）：
  //      「帮我预测比特币未来1小时的走势图」→ `query_market`（置信度 0.6）——
  //      被最后那条**裸标的兜底**接走，回一句 BTC 现价。他问的是"未来会到哪、
  //      为什么"，收到一个当前价格。它报的数字是对的，只是不是他问的那件事 ——
  //      本仓库记过多次的第三族失败：**答非所问，却听起来像在回答**。
  //   ② **必须排在订单之后。**「预测一下然后帮我买」里的"买"字优先：下单是更具体的
  //      动作，而且预测结论不会因此丢失 —— 它会作为**证据**被交易闸门吃进去
  //      （`server/tradeGate.ts` 的预测闸门），所以让路不等于丢掉。
  //   ③ 顺带堵住 `query_status`：「比特币接下来一小时会涨还是会跌」里的"接下来"
  //      在它的词表里，实测被抢成 `query_status`（0.93）—— 回的是"我在忙什么"。
  //      本分支排它前面，两处一起好。
  //
  // ★ 解释性提问仍然交给大模型，用的是**与 `query_market` 同一份** `looksExplanatory`：
  //   「预测模型的原理是什么」问的是机制，不该收到一段行情数字。
  //   （实测这句现在落到 `unknown`，由模型答 —— 加了这个分支之后它必须继续落在那儿，
  //    所以这里的解释性判据不是可选项，否则这句会被预测分支抢走。）
  //
  // ★ 认不出标的也照样接：由 service 层回一句"你要我预测哪个标的"。
  //   在这里返回 `unknown` 的后果是这句话掉进大模型兜底，而模型并不知道
  //   这台机器上有预测能力 —— 用户会得到一段泛泛而谈的行情科普。
  if (FORECAST_WORDS.test(s) && !looksExplanatory(s)) {
    const symbol = resolveSymbol(raw, ctx.symbols, ctx.referTo)
    return {
      intent: 'query_forecast',
      confidence: symbol ? 0.9 : 0.75,
      matched: raw,
      forecastSymbol: symbol ?? undefined,
      // ★ 缺省 60 分钟 = 预测层的默认档（15m × 4 根恰好 1 小时）。
      //   用户说"未来一小时"就是 60；一个字没提时间也用 60，
      //   但那必须在回话里说出来（service 层会念"按未来一小时算"）。
      horizonMinutes: parseHorizonMinutes(s) ?? 60,
    }
  }

  // ── 查询类 ──
  if (/(持仓|仓位|手里有什么|拿着什么|我的仓)/.test(s)) {
    return { intent: 'query_position', confidence: 0.95, matched: raw }
  }
  if (/(权益|余额|赚了多少|亏了多少|收益|盈亏|市值|还有多少钱|账户还剩)/.test(s)) {
    return { intent: 'query_equity', confidence: 0.95, matched: raw }
  }
  if (/(挂单|委托|未成交|订单列表|有哪些单)/.test(s)) {
    return { intent: 'query_orders', confidence: 0.92, matched: raw }
  }
  if (/(风控|额度|剩余额度|还能下多少|风险预算|限制)/.test(s)) {
    return { intent: 'query_risk', confidence: 0.92, matched: raw }
  }
  if (/(行情|价格|现价|多少钱一个|多少价位|报价)/.test(s)) {
    // ★ 解释性提问不许被这一条接走。
    //   实测（2026-09-19）：「资金费率是怎么影响永续合约价格的？」含"价格"二字
    //   ⇒ 被当成查行情，回的是「还没收到行情」。
    //   这是本项目记过的第三族失败 —— **没读懂被伪装成读懂了**：
    //   用户收到"还没收到行情"，看不出那是"系统没数据"还是"它压根没听懂"，
    //   于是他要么重复问、要么以为系统坏了，而真相是这句话该由模型来答。
    //   判据：句子里有解释性词时，只有**同时**在直接问价才算查行情。
    //   （"解释性词"的名单只留一份，在文件末尾的 `looksExplanatory`：这一处
    //    和下面那个"认出标的就当问行情"的兜底共用它。）
    const askingPrice = /(多少钱|报价|现价|什么价格|价格是|多少价位|行情是|行情怎么样|价格怎么样)/.test(s)
    // 判据只此一份（见下方 `looksExplanatory`），与裸标的兜底共用同一份。
    if (!looksExplanatory(s) || askingPrice) {
      const symbol = resolveSymbol(raw, ctx.symbols, ctx.referTo)
      return {
        intent: 'query_market',
        confidence: symbol ? 0.92 : 0.7,
        matched: raw,
        slots: { side: 'buy', symbol: symbol ?? '' },
      }
    }
  }
  if (/(日报|今天怎么样|今天的报告|复盘|简报|今天做了什么|今日总结)/.test(s)) {
    return { intent: 'query_daily_report', confidence: 0.93, matched: raw }
  }
  if (/(你在干什么|在忙什么|在做什么|状态|进度|下一步|接下来|有什么打算)/.test(s)) {
    return { intent: 'query_status', confidence: 0.93, matched: raw }
  }
  if (/(数据|统计|多少笔|成交几次)/.test(s)) {
    return { intent: 'query_orders', confidence: 0.7, matched: raw }
  }

  // ── 任务：接一个「目标」而不是一条命令（必须排在兜底问行情之前）──
  //
  // 为什么位置在这里：上面每一条都要求**更具体的动作词**，而任务句往往
  // 一个买卖字都没有（「10U 做到 100U，一天内」）。放前面会抢走「买两百块钱的比特币」
  // 这种真下单；放在兜底之后则永远轮不到它 —— 因为"认出标的就当问行情"会先接走。
  //
  // ★ 判据是**两个函数取或**，不是只取 `looksLikeMission`：
  //   后者要求"金额 + 目标"齐，槽位缺一个就判"不是任务"，
  //   于是「在 OKX 测试网做 BTC 永续，3 天内翻倍」掉进兜底，
  //   用户收到一句 BTC 报价 —— **他的任务被静默换成了一个数字**。
  //   `hasExecutionSignal` 专判"这是在提一件事，只是没说全"，
  //   接住那类句子后由裁定层去追问缺的槽位。
  //
  // ★ 这里只**解析**，不做任何裁定、不写账本、不启动任何东西。
  // 判定的副作用（落账、回话）留在 service 层，这样这个纯解析函数
  // 仍然可以离线逐条断言 —— 与整个 intents.ts 的既有性质一致。
  const missionSpec = parseGoal(raw, { symbols: ctx.symbols, resolveSymbol, nowMs: Date.now() })
  if (looksLikeMission(missionSpec) || hasExecutionSignal(missionSpec)) {
    return { intent: 'start_mission', confidence: missionSpec.confidence, matched: raw, mission: missionSpec }
  }

  // ── 联网查（只读，但会出网）────────────────────────────────────────
  //
  // ★ 判据要求**显式的出网动作词**，不认裸「查一下」：
  //   裸"查"在这个系统里已经有确定含义（查持仓/查行情），抢走它会让
  //   「查一下持仓」变成一次网络请求 —— 那既慢又可能把持仓数字换成网页上抄来的。
  // ★ 排在这里（任务判定之前、裸标的兜底之前）：带"上网/联网/搜一下"的句子
  //   没有别的合理解释；而排到裸标的兜底之后，它会被"认出标的就当问行情"吃掉。
  const webTrigger = /^\s*(?:请?你?帮我)?(?:上网|联网|网上)?(?:查|搜|找|看)一?(?:下)?\s*(?:网上|网页|网站|网络|联网|最新|现在)?\s*[：:]?\s*(.+)$/
  const webHit = webTrigger.exec(raw)
  if (webHit && /(上网|联网|网上|网页|网站|搜索|搜一下|百度|谷歌|google|网络)/i.test(raw)) {
    const q = (webHit[1] ?? '').trim()
    if (q.length >= 2) return { intent: 'web_lookup', confidence: 0.85, matched: raw, webQuery: q }
  }

  // 兜底：认出标的但没有任何动作词 —— 当成问行情
  //
  // ★ 这条兜底之所以是安全的，唯一的原因是**上面的任务判定先接走了所有执行诉求**，
  // 用的是同一个判据（`hasExecutionSignal`）。不要在这里再写一份"是不是任务"的正则：
  // 两份迟早对同一句话给出不同答案，而分歧的方向恰好是"任务被换成一个报价"。
  //
  // ★ 解释性提问同样不许被它接走。实测：「比特币价格为什么跌了」里的
  //   "价格"已经被上面的疑问句保护放行了，接着**在这里又被认出标的** ⇒
  //   回的是「还没收到行情」。也就是说同一族缺陷有两处入口，
  //   只堵第一处会让烟测红在第二处 —— 所以判据只留一份（`looksExplanatory`），
  //   两处共用。带疑问词的句子交给大模型答，比拿一个报价去回答"为什么"好得多。
  const bareSymbol = resolveSymbol(raw, ctx.symbols, ctx.referTo)
  if (bareSymbol && !looksExplanatory(s)) {
    return {
      intent: 'query_market',
      confidence: 0.6,
      matched: raw,
      slots: { side: 'buy', symbol: bareSymbol },
    }
  }

  return { intent: 'unknown', confidence: 0, matched: raw }
}

/**
 * 「这句在问"为什么/怎么"，而不是在问一个数」。
 *
 * ★ 判据只此一份，`query_market` 的两处入口（带"价格"的直接判定、与裸标的兜底）
 *   都调它。两处各写一份的后果实测过：第一处堵上、第二处照样把解释性提问
 *   变成一次报价查询，而且表现为"烟测红在第二处"，排查方向容易偏到别的地方。
 *
 * ★ 刻意**不认裸「怎么」「如何」**：第一版写成 /(为什么|怎么|如何|…)/ 之后，
 *   `voice-smoke` 当场报红 —— 「行情怎么样」含"怎么"⇒ 不再当问行情。
 *   那正是"检查器对正确的输入报错"（判据 2），而且它会把最基础的
 *   「行情怎么样」变成一次模型调用。所以只认**成词的**解释性搭配。
 */
export function looksExplanatory(s: string): boolean {
  return /(为什么|为啥|为何|是什么|什么叫|什么原理|原理|影响|区别|机制|含义|是什么意思|怎么(影响|算|判断|理解|看|用)|如何(影响|计算|判断|理解|用)|为什么会)/.test(
    s,
  )
}

/** 供面板展示：意图 → 中文名。 */
export const INTENT_LABEL: Record<VoiceIntentName, string> = {
  query_position: '查持仓',
  query_equity: '查权益',
  query_orders: '查挂单',
  query_risk: '查风控额度',
  query_market: '查行情',
  query_forecast: '预测走势',
  query_status: '查工作状态',
  query_daily_report: '读日报',
  start_mission: '接目标',
  confirm_mission_start: '启动口令',
  place_order: '下单',
  close_position: '平仓',
  cancel_order: '撤单',
  cancel_all: '全部撤单',
  pause: '暂停',
  resume: '继续',
  killswitch_on: '熔断',
  killswitch_off: '解除熔断',
  confirm: '确认',
  reject: '取消',
  switch_voice: '换音色',
  set_verbosity: '调播报详略',
  repeat: '重复',
  stop_talking: '静音',
  introduce: '介绍自己',
  help: '帮助',
  ask_system: '查系统实况',
  ask_fleet: '查舰队排行',
  ask_lab: '查进化实验室',
  ask_agents: '查 Agent 舰队',
  dispatch_task: '派舰队干活',
  ask_model: '问大模型',
  web_lookup: '联网查',
  self_upgrade: '自我进化',
  record_lesson: '登记心法',
  ui_action: '按界面按钮',
  unknown: '听不懂',
}

/**
 * 哪些意图**会改变资金/运行状态** —— 这些必须走两段式确认。
 *
 * `start_mission` 在列：它启动的是一个会自己反复下单的自治循环，
 * 破坏力比单笔下单更大而不是更小。把它当"查询"放过去，
 * 等于开了一条**一次口头授权、长期自动执行**的后门。
 */
const DANGEROUS: VoiceIntentName[] = [
  'start_mission',
  /**
   * 启动口令也在列 —— 它是**真的把循环起起来**的那一步。
   *
   * `start_mission` 只是接目标（裁定，无副作用）；这一个有副作用。
   * 两者都在名单里，是为了让将来任何"通用危险处理"都不会把它当查询放过去 ——
   * 而它现在的处理分支**排在通用处理之前**（见 `service.ts`），
   * 因为通用处理会去要一个**金额**，而任务没有金额（见 mission/consent.ts 文件头）。
   */
  'confirm_mission_start',
  /**
   * 跑一轮提案、登记一条心法 —— 也是在**改变系统将来的行为**。
   *
   * 两者的副作用都比一笔小额下单更持久：
   *   `self_upgrade`  往晋级流水线写候选，那些候选可能一路走到实盘；
   *   `record_lesson` 写心法库，而心法会被回灌进**每一次**提案的上下文 ——
   *                   一条写错的心法是长期污染面，不是一次性的。
   * 所以在名单里，走与下单同一套两段式确认。
   *
   * ★ 它们对应的 `tools.ts` 工具（`propose_upgrade` / `file_lesson`）
   *   必须声明这两个意图，且由 `auditToolRegistry()` 断言它们确实在名单里 ——
   *   这样"新加一个动作工具忘了进危险名单"会在门禁里当场报红。
   */
  'self_upgrade',
  'record_lesson',
  /**
   * 派舰队干活。链上可能含 `act` 成员（写因子台账 / 写策略台账），
   * 所以它与 `self_upgrade` 同档：改变的是系统将来的行为，不是一次可撤回的查询。
   */
  'dispatch_task',
  'place_order',
  'close_position',
  'cancel_all',
  'killswitch_on',
  'killswitch_off',
]

export function isDangerous(intent: VoiceIntentName): boolean {
  return DANGEROUS.includes(intent)
}
