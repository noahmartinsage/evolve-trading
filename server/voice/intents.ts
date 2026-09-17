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
import { extractAmount, resolveAmount } from './numerals.ts'
import { resolveVoiceRequest } from './voices.ts'
import { looksLikeMission, hasExecutionSignal, parseGoal } from '../mission/goal.ts'
import { heardStartPhrase } from '../mission/consent.ts'

export interface IntentContext {
  /** 当前标的池。**必须**由调用方传入，不允许本模块自己另立一份清单 —— 否则就是两套口径。 */
  symbols: string[]
  /** 取标记价的函数，用于「两百块钱 → 多少个」的回话推算。 */
  markPrice: (symbol: string) => number
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
 * 把话里的标的名解析成池子里的交易对。
 * 命中不了返回 null —— 由上层回一句「池子里没有这个标的」，不猜。
 */
export function resolveSymbol(text: string, symbols: string[]): string | null {
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
  return null
}

const BUY_WORDS = /(买入|买进|买点|买些|买|开多|做多|加仓|补仓|多单|long)/
const SELL_WORDS = /(卖出|卖掉|卖点|卖|开空|做空|空单|short)/
const CLOSE_WORDS = /(平仓|清仓|全平|全清|关掉|退出|止损离场|close)/
/** 判「实盘」的词。缺省一律 paper —— 语音最容易误触发，默认必须是最安全的那个模式。 */
const LIVE_WORDS = /(实盘|真钱|真金白银|真实资金|上真仓|live)/
const PAPER_WORDS = /(模拟|仿真|纸面|沙盒|paper|sandbox)/

export function parseIntent(text: string, ctx: IntentContext): ParsedIntent {
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
    const symbol = resolveSymbol(raw, ctx.symbols) ?? undefined
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
    const symbol = resolveSymbol(raw, ctx.symbols)
    const amt = extractAmount(raw)

    const slots: OrderSlots = { side, symbol: symbol ?? '' }
    const live = LIVE_WORDS.test(s) ? true : PAPER_WORDS.test(s) ? false : false
    slots.live = live

    let confidence = 0.55
    if (ambiguousSide) confidence -= 0.25
    if (!symbol) confidence -= 0.25
    if (!amt) confidence -= 0.2

    if (amt) {
      const mark = symbol ? ctx.markPrice(symbol) : Number.NaN
      const resolved = resolveAmount(amt, mark)
      if ('error' in resolved) {
        // 数量解析失败仍然报 place_order，但把原因带出去：
        // 上层据此回一句具体的「我没听出金额」，而不是笼统的"没听懂"。
        return { intent: 'place_order', confidence: 0.2, matched: raw, slots, error: resolved.error }
      }
      if (resolved.basis === 'qty') slots.qty = resolved.qty
      else slots.notional = resolved.notional
      slots.amountBasis = resolved.basis
      confidence += 0.2
      return { intent: 'place_order', confidence: Math.max(0, Math.min(1, confidence)), matched: raw, slots }
    }
    return { intent: 'place_order', confidence: Math.max(0, Math.min(1, confidence)), matched: raw, slots, error: 'VOICE_AMOUNT_MISSING（没听到数量）' }
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
    const symbol = resolveSymbol(raw, ctx.symbols)
    return {
      intent: 'query_market',
      confidence: symbol ? 0.92 : 0.7,
      matched: raw,
      slots: { side: 'buy', symbol: symbol ?? '' },
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

  // 兜底：认出标的但没有任何动作词 —— 当成问行情
  //
  // ★ 这条兜底之所以是安全的，唯一的原因是**上面的任务判定先接走了所有执行诉求**，
  // 用的是同一个判据（`hasExecutionSignal`）。不要在这里再写一份"是不是任务"的正则：
  // 两份迟早对同一句话给出不同答案，而分歧的方向恰好是"任务被换成一个报价"。
  const bareSymbol = resolveSymbol(raw, ctx.symbols)
  if (bareSymbol) {
    return {
      intent: 'query_market',
      confidence: 0.6,
      matched: raw,
      slots: { side: 'buy', symbol: bareSymbol },
    }
  }

  return { intent: 'unknown', confidence: 0, matched: raw }
}

/** 供面板展示：意图 → 中文名。 */
export const INTENT_LABEL: Record<VoiceIntentName, string> = {
  query_position: '查持仓',
  query_equity: '查权益',
  query_orders: '查挂单',
  query_risk: '查风控额度',
  query_market: '查行情',
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
  'place_order',
  'close_position',
  'cancel_all',
  'killswitch_on',
  'killswitch_off',
]

export function isDangerous(intent: VoiceIntentName): boolean {
  return DANGEROUS.includes(intent)
}
