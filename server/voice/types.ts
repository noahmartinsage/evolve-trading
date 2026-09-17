/**
 * 实时语音交互层 —— 共享契约
 *
 * ── 这一层在系统里的位置 ────────────────────────────────────────────
 * 语音**不是**一条新的交易通道，它是既有编排层的一个**新入口**。
 * 这句话是整个模块的设计前提，凡是违反它的写法都算 bug：
 *
 *   麦克风 → ASR → 意图解析 → [既有风控门] → 既有执行路径 → 回话 + 播报
 *                                ↑
 *                        这一格子里不允许出现任何"语音专用的下单实现"
 *
 * 之所以要把这条写进文件头：语音天然带三个危险属性 ——
 *   ① 没有确认对话框，张嘴就是动作；
 *   ② 识别会错（「两百」和「两千」在声学上极近）；
 *   ③ 用户看不见自己刚才说的到底是什么。
 * 任何一条配上"语音专用的捷径"，就变成绕过风控的后门。
 * 因此本层只做四件事：**解析、确认、转交、播报**，绝不自己碰订单。
 */

import type { MissionSpec } from '../mission/types.ts'

/** 播报优先级。数值越小越先出声。 */
export type NarrationPriority =
  /** 必须打断一切、静音也照说的报警（熔断、拒单、对账不一致、强异动）。 */
  | 'P0_ALARM'
  /** 重要但可排队（成交、策略切换、门禁结论、日报）。 */
  | 'P1_IMPORTANT'
  /** 工作状态与下一步 —— 「我在干什么、下一步干什么」就是这一档。 */
  | 'P2_STATUS'
  /** 盘面异动等参考信息。 */
  | 'P3_MARKET'

export type NarrationCategory =
  | 'work-state'
  | 'next-step'
  | 'risk-alarm'
  | 'surveillance'
  | 'market-anomaly'
  | 'order'
  | 'gate'
  | 'daily-report'
  | 'chat'

export interface NarrationLine {
  id: string
  ts: number
  priority: NarrationPriority
  category: NarrationCategory
  /** 直接可朗读的中文口语化文案。合成器拿到的就是它。 */
  text: string
  /** 面板展示用的精确数据（可含数字、原始 reason），语音里念不出来的部分放这里。 */
  detail?: string
  /**
   * 溯源：这条播报是从账本第几号事件推出来的。
   *
   * 为什么必须带上：这一层最像"会撒谎的组件" —— 它把结构化数据翻译成自然语言，
   * 而自然语言无法被机器核验。带上 seq 之后，「每一条播报都能在审计链里找到出处」
   * 就变成了一个**可自动断言**的性质（见 voice-smoke 的溯源用例），
   * 从而堵死"秘书自己编了个状态"这类最难查的失效。
   */
  sourceSeq?: number
  sourceKind?: string
  /** 同键在冷却期内只播一次。 */
  dedupeKey: string
}

/** 发言方。 */
export type Speaker = 'user' | 'assistant' | 'system'

/** 会话轮次状态。 */
export type TurnState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'done'
  | 'failed'

export interface VoiceTurn {
  turnId: number
  state: TurnState
  /** 用户原话（ASR 结果）。 */
  utterance: string
  /** 助手回话（给合成器念）。 */
  reply: string
  intent?: VoiceIntentName
  ts: number
  /** 若意图危险，这里挂着待确认凭证。 */
  pending?: PendingConfirmation
  /** 解析/执行失败的原因，供面板显示。 */
  reason?: string
}

export type VoiceIntentName =
  | 'query_position'
  | 'query_equity'
  | 'query_orders'
  | 'query_risk'
  | 'query_market'
  | 'query_status'
  | 'query_daily_report'
  /**
   * 接一个**目标**，而不是一条命令。
   *
   * 为什么它必须是独立意图、且必须是危险动作：
   * "10U 做到 100U，一天内"里没有买入卖出，也没有数量 —— 它启动了
   * 一个会自己反复下单的自治循环。把它当查询处理，用户会以为系统只是
   * 听懂了，而实际上什么都没发生（或者更糟：被后续规则拆成一次下单）。
   */
  | 'start_mission'
  /**
   * 启动口令：说出固定口令词 + 服务端签发的一次性四位口令码。
   *
   * 与 `start_mission` 的分工是**只读 vs 写**：前者只裁定（拿一份结论），
   * 这一个才真的有副作用（把自治循环起起来）。分开成两个意图，
   * 是为了让"听懂一个目标"与"批准启动它"在日志、账本、门禁里都是两件事 ——
   * 合成一个的话，一次误识别就直接等于一次授权。
   */
  | 'confirm_mission_start'
  | 'place_order'
  | 'close_position'
  | 'cancel_order'
  | 'cancel_all'
  | 'pause'
  | 'resume'
  | 'killswitch_on'
  | 'killswitch_off'
  | 'confirm'
  | 'reject'
  | 'switch_voice'
  | 'set_verbosity'
  | 'repeat'
  | 'stop_talking'
  /**
   * 介绍自己：我是谁、替你管哪些事。
   *
   * 与 `help` 分开是因为问的是两件事：这一个答**身份与职责**
   * （"你是我的秘书还是整个系统的管家"），`help` 答**具体怎么说**（操作清单）。
   * 合并的话，用户问"介绍一下你自己"会收到一份操作手册 —— 他没得到回答。
   */
  | 'introduce'
  | 'help'
  | 'unknown'

/** 解析后的下单诉求。金额单位刻意分两类 —— 混淆二者是语音里最容易出人命的一处。 */
export interface OrderSlots {
  side: 'buy' | 'sell'
  symbol: string
  /**
   * 名义额（报价币计价，如 USDT）。
   *
   * 与 `qty` 二选一。**「买两百块钱的比特币」和「买两百个比特币」是两件事**，
   * 前者 200 U，后者在 BTC 上是 1.3 亿 U。ASR 无法区分两者，
   * 只能靠量词判断；量词缺失时本层默认按名义额处理（受逐笔上限约束、
   * 且不随价格漂移），并由两段式确认把解释结果**念回给用户复核**。
   */
  notional?: number
  /** 基础币数量（如 0.01 BTC）。 */
  qty?: number
  /** 数量语义来自哪个量词，用于确认回话里说清"我理解成了什么"。 */
  amountBasis?: 'notional' | 'qty'
  /** 用户是否明确说了"实盘/真钱"。缺省为仿真（paper）。 */
  live?: boolean
  /** 实盘所需的策略身份（必须已过晋升门禁，由流水线层裁决）。 */
  strategyId?: string
}

export interface ParsedIntent {
  intent: VoiceIntentName
  slots?: OrderSlots
  /** 解析置信度 0~1。低置信度一律走确认或直接澄清，不猜。 */
  confidence: number
  /** 命中的原始片段，便于面板展示"我是从哪句里听出来的"。 */
  matched?: string
  voiceId?: string
  verbosity?: Verbosity
  /**
   * 解析过程的显式失败原因（如数量单位不支持、标的缺失）。
   *
   * 为什么要单独一个字段而不是塞进 `matched`：这一层的失败**必须能被念出来**。
   * 「我没听出要买多少」和「我以为是 200 U」对用户是两回事，
   * 压成同一个"没听懂"会让用户反复重说同一句话。
   */
  error?: string
  /** 撤单等按单号操作的意图，把单号单独带出来，不塞进 `slots`。 */
  orderId?: string
  /**
   * 目标解析结果（仅 `start_mission` 携带）。
   *
   * 由意图层解析一次就带出来，而不是让处理层再解析一遍 ——
   * 解析两次的后果不是性能，是**两处可能给出不同的 spec**：
   * 意图层按 A 判成"是任务"，处理层按 B 判成"缺槽位"，
   * 于是系统会先答应再反问，用户看到的是自相矛盾。
   */
  mission?: MissionSpec
}

/**
 * 播报档位。
 *
 * ★ `normal` 的定义在 2026-09-17 改过一次，起因是一个**功能性失效**：
 * 它原本只放行 P0/P1，而「我正在干什么、下一步干什么」是 **P2_STATUS** ——
 * 后端一直在生成这些句子（`tickStatus` 由 3 秒一次的泵驱动），
 * 默认档位却把它们**整批丢掉**。用户的体感就是"它一点都不智能、从不报告在做什么"。
 *
 * 这不是缺功能，是**缺功能的可见性**：一份永远不会被消费的输出，
 * 和没写这段代码没有区别（本项目反复出现的"算而不用"，这里又是一次）。
 *
 * 分层按"离钱的距离"排，而不是按"实现顺序"排：
 *   · alarm-only —— 只 P0。盯盘时不想被打扰。
 *   · normal（默认）—— P0/P1/P2，含工作状态与下一步。**桌宠的默认人格**。
 *   · chatty —— 全部，再加 P3 盘面异动与闲聊。
 */
export type Verbosity =
  /** 只说报警。连成交都不播 —— 适合盯盘时不想被打扰。 */
  | 'alarm-only'
  /** 报警 + 重要事件 + **工作状态与下一步**。 */
  | 'normal'
  /** 全部，含盘面异动明细与闲聊。 */
  | 'chatty'

/**
 * 两段式确认凭证。
 *
 * 语音没有"撤销"，所以任何**会改变资金状态**的动作都必须先拿到这个东西。
 * 关键设计：确认不是简单回一句「确认」——
 * 那样一句含糊的"确认"就能放行，而含糊正是 ASR 的常态。
 * 这里要求用户**把解释后的数量复述一遍**（「确认两百」），
 * 于是确认动作同时完成两件事：授权 + 校验识别是否听错。
 */
export interface PendingConfirmation {
  token: string
  ts: number
  expiresAt: number
  /**
   * 待执行动作的**机器标识**。
   *
   * 刻意与下面的 `action`（给人看的描述）分开，且路由只认这一个。
   * 曾经想过「用 action 字符串前缀判断该走哪条分支」——那等于让展示文案
   * 承担路由职责：改一个中文字就不分叉了，而且编译器一声不吭。
   */
  intent: VoiceIntentName
  /** 给人看的动作描述，用于回话与面板。改它不会改变行为。 */
  action: string
  /** 必须被复述出来的数值（名义额或数量）。用户念别的数一律不放行。 */
  expectedAmount: number
  amountBasis: 'notional' | 'qty'
  /**
   * 服务端按实时标记价折算出的名义额。
   *
   * 存在的意义：风险分档必须量**钱**，不能量"用户嘴里那个数"。
   * 「买一个比特币」里 qty=1 看着无害，实际名义额十万量级 ——
   * 只按 qty 分档的话这笔会被判成小额单而免去复核。
   */
  expectedNotional: number
  /** 已解析好、确认后原样转交的槽位。 */
  slots: OrderSlots
  /** 触发它的轮次，便于把「确认」关联回上下文。 */
  originTurnId: number
}

/** 语音层对外暴露的状态快照（给面板与烟测）。 */
export interface VoiceStatus {
  enabled: boolean
  voiceId: string
  verbosity: Verbosity
  /** 当前轮次。 */
  turn: VoiceTurn | null
  /** 世代号：每发生一次打断就 +1，用于作废在途回话。 */
  generation: number
  interruptedCount: number
  spokenCount: number
  suppressedCount: number
  pending: PendingConfirmation | null
  recentNarrations: NarrationLine[]
}
