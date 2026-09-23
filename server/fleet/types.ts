/**
 * Agent 舰队 —— 类型与常量表
 *
 * ── 这一层要解决什么 ────────────────────────────────────────────────
 * 在这之前 `AgentsPage.tsx` 上的六张卡片是**写死的演示数字**：收益、胜率、
 * 成交笔数全是常量，启停 / 孵化按钮只弹一个 toast。那是本项目 B 项检验里
 * 唯一的「孤岛」档 —— 有页面、有按钮，但没有一条真实的执行路径，
 * 也没有任何下游会读它的输出。
 *
 * 这一层的做法与语音层 `voice/tools.ts` 同源，四条声明**缺一即注册失败**：
 *   · `reuses`    —— 复用哪条既有路径。这条守的是"不许为舰队再实现一套"。
 *   · `output`    —— 产出什么可观测量。说不出产出，就不是能力。
 *   · `consumers` —— **谁读它的输出**。空 = 孤岛。这是判模块是否真接线的唯一判据。
 *   · `emits`     —— 产出发到哪个主题，且该主题**必须有真实的订阅者**。
 *                    没有订阅者的主题不是通道，是死信箱。
 * 另加一条红线：`act` 类 agent 必须声明 `intent`，且该意图**必须已在**
 * `voice/intents.ts` 的 DANGEROUS 名单里 —— 舰队不给"改变系统将来行为"的动作开后门。
 *
 * ── 为什么 `consumers` 要带"证据"而不是只写一句话 ─────────────────────
 * 只写一句话的声明退化成注释：删掉真实接线之后，那句声明还在，
 * 门禁照样全绿 —— 那正是本项目记过多次的"不可能失败的检查"。
 * 所以每个消费面必须给出**可被脚本核对的证据**：
 *   · `agent` 类 —— 结构核对：那个 agent 必须真的存在，且它 `consumes` 的主题
 *                   必须落在本 agent 的 `emits` 里（不看文档，看注册表本身）；
 *   · `ui` / `voice` 类 —— 源码核对：那个文件里必须真的出现指定标记。
 * 两者都能被"撤掉接线"这个动作弄红。
 */

/** 主题的订阅者分两种：舰队内部 agent，或舰队外的消费面（面板 / 语音 / 账本）。 */
export type FleetTopicKind = 'agent' | 'surface'

export interface FleetTopic {
  id: string
  label: string
  kind: FleetTopicKind
  /** 这个主题上的消息表示什么已经发生的事。给面板与语音用。 */
  meaning: string
}

export type FleetConsumerKind = 'ui' | 'voice' | 'agent'

export interface FleetConsumer {
  id: string
  label: string
  kind: FleetConsumerKind
  /**
   * 这个消费面**真的**在读舰队产出吗？给出可被脚本核对的证据。
   * `agent` 类不需要它（结构核对更强：直接看那个 agent 的 `consumes`）。
   */
  evidence?: { file: string; marker: string }
}

/** 舰队 agent 的类别。`act` 会改变系统状态（写台账 / 写心法 / 写候选）。 */
export type FleetAgentKind = 'read' | 'act'

/**
 * 成本档。它决定调度器在做任务规划时**愿不愿意把它排进一次交互**：
 * `slow` 的那两个要跑几万根 K 线的全量评估，实测分钟级，
 * 不能在一个语音回合里同步跑完。
 */
export type FleetCost = 'instant' | 'fast' | 'slow'

export interface FleetRunArg {
  /** 自由参数（可能是一句话）。由调度器从上游产出或用户话里取。 */
  arg?: string
  /** `act` 类必填。false / 缺省一律拒绝 —— 与语音层同一套两段式确认语义。 */
  confirmed?: boolean
  /** 只算不落盘。烟测必须用它，否则每跑一次测试都改台账。 */
  dryRun?: boolean
  /** 上游产出（由总线投递）。`consumes` 非空的 agent 会拿到这个。 */
  inputs?: Record<string, Record<string, unknown>>
  /** 上游消息 id，用于把"这个 agent 的输入来自哪条消息"写进凭据。 */
  inputFrom?: string[]
}

export interface FleetRawResult {
  ok: boolean
  /** 给人看的**一句话**。面板与语音都直接用它 —— 所以必须已显式格式化。 */
  summary: string
  /** 逐步留痕，"实时报告工作进度"的数据源。 */
  steps: string[]
  /** 主题 → 载荷。键必须是本 agent `emits` 里登记过的主题。 */
  outputs: Record<string, Record<string, unknown>>
  /** 未通过时的原因。**必须可念**，不许是 JSON 片段。 */
  reason?: string
  detail?: unknown
}

/** 总线消息。有 id 是为了让凭据能引用"我吃的是哪一条"。 */
export interface FleetMessage {
  id: string
  topic: string
  /** 发布者 agent id。 */
  from: string
  taskId: string | null
  ts: number
  payload: Record<string, unknown>
}

/** 下游 agent 收到消息时的处理。返回一句笔记，进它的收件箱。 */
export type FleetMessageHandler = (msg: FleetMessage) => string

export interface FleetAgent {
  id: string
  /** 中文名。面板、语音、凭据统一用它 —— 只留一个名字，避免两处措辞分叉。 */
  label: string
  duty: string
  kind: FleetAgentKind
  cost: FleetCost
  /** ★ 复用哪条既有路径。空 = 注册失败。至少要被解析出一个**存在**的文件路径。 */
  reuses: string
  /** ★ 产出什么可观测量。空 = 注册失败。 */
  output: string
  /** ★ 谁读它的输出。空 = 孤岛 = 注册失败。 */
  consumers: string[]
  /** ★ 产出发到哪个主题。空 = 注册失败。`agent` 类主题必须有真实订阅者。 */
  emits: string[]
  /** 它吃哪些主题。声明了就必须有 `onMessage`，反之亦然（防"声明了但不消费"）。 */
  consumes?: string[]
  onMessage?: FleetMessageHandler
  /** `act` 必填，且必须在 DANGEROUS 名单里。 */
  intent?:
    | 'self_upgrade'
    | 'record_lesson'
    | 'start_mission'
    | 'confirm_mission_start'
    | 'dispatch_task'
    | 'place_order'
    | 'close_position'
    | 'cancel_all'
    | 'killswitch_on'
    | 'killswitch_off'
  run: (arg: FleetRunArg) => FleetRawResult | Promise<FleetRawResult>
}

// ─────────────────────────── 主题表 ───────────────────────────

/**
 * 登记在册的主题。**只有登记过的主题才能被 `emits` 引用** ——
 * 这样"新加一个 agent 发到没人听的频道上"会在门禁当场报红，
 * 而不是变成一个安静的、谁也不知道存在的队列。
 */
export const FLEET_TOPICS: readonly FleetTopic[] = [
  { id: 'proposal.generated', label: '提案已生成', kind: 'agent', meaning: '提案引擎跑完一轮，晋级流水线可能新增候选' },
  { id: 'factor.produced', label: '因子已生产', kind: 'agent', meaning: '因子台账新增 / 重判了若干行' },
  { id: 'strategy.screened', label: '策略已筛查', kind: 'agent', meaning: '已接受因子过了一遍策略门，有结论了' },
  { id: 'gate.checked', label: '闸门已核对', kind: 'surface', meaning: '过拟合门与晋级阶段的现状被核对过一次（读它的面板与语音，没有下游 agent）' },
  { id: 'brain.observed', label: '决策已观测', kind: 'surface', meaning: '决策大脑的样本质量被数过一次' },
  { id: 'lesson.audited', label: '心法已体检', kind: 'surface', meaning: '心法库的健康分被数过一次（只读，不改库）' },
  { id: 'hygiene.scanned', label: '文件已体检', kind: 'surface', meaning: '工作区扫过一次，产出了一份可回收清单' },
  // ── 第十七轮新增：自治循环、迭代挖掘、可逆清理、自我学习 ──────────────
  //
  // ★ 四个都登记为 `surface` 类，理由是**它们真的被面板与语音读**，
  //   而没有别的 agent 会订阅它们。登记成 `agent` 类会立刻触发
  //   `TOPIC_NO_SUBSCRIBER`（死信箱）—— 而"为了让它过门随便找个 agent 订阅"
  //   才是更坏的做法：那会造出一条没有任何语义的假依赖。
  //   本项目的判据是"消费面必须具名可核对"，而不是"必须有 agent 读"。
  { id: 'factor.mined', label: '因子已迭代挖掘', kind: 'surface', meaning: '多轮扩空间→筛选跑完了，凭据里带着退出原因（达标 / 空间挖尽 / 轮次用尽）' },
  { id: 'hygiene.cleaned', label: '临时产物已清理', kind: 'surface', meaning: '若干临时产物被**移进** .trash/（可逆），附批次路径' },
  { id: 'learn.noted', label: '已学完一轮', kind: 'surface', meaning: '读现状 → 产改进提案并落盘；**源码没有被改**' },
  { id: 'autonomy.changed', label: '自治循环已变更', kind: 'surface', meaning: '自治循环被启动或停止，附排程现状' },
  // ── 第十八轮新增：新闻雷达（定时读 → 判相关 → 写内化提案）──────────────
  //
  // ★ 同样登记为 `surface`：这两个主题的读者**目前只有一个只读出口**
  //   `GET /fleet/news`（外加账本里的 `NEWS_DIGEST` / `NEWS_INTERNALIZED` 事件
  //   与启动器那行"最新读到什么"）。登记成 agent 类会触发死信箱判据
  //   （TOPIC_NO_SUBSCRIBER），而"随便找个 agent 订阅它"会造出一条没有任何语义的假依赖。
  //
  // ★★ 但按本项目自己的四档位口径，这一块目前是**半闭环**，不是闭环：
  //   真正"推到用户眼前"的只有启动器那一行；面板与语音都还没读它
  //   （`ui:fleet` 只显示总线的**计数**，不显示主题明细）。
  //   写在这里是为了不让下一轮的人把"有端点"当成"有人读"。
  { id: 'news.digested', label: '新闻已读一轮', kind: 'surface', meaning: '定时读了新闻源，算出多少条与本系统相关、多少条是新的（0 条也要说）' },
  { id: 'news.internalized', label: '新闻内化提案已落盘', kind: 'surface', meaning: '相关信号被写成内化提案，落进**与自学习同一份** data/learn/notes.jsonl；源码没有被改' },
  // ── 第二十轮新增：交易自动驾驶的启停面 ────────────────────────────────
  //
  // ★★ 这个主题存在的唯一理由是**消除第二个真相来源**。
  //   用户实测反馈：「让它一键启动自治循环的时候，总览控制台那颗按钮应该被按下」。
  //   根因是「自治循环」这个词有两个主人 —— 语音启动的是舰队周期排程，
  //   而总览那颗按钮控制的是交易自动驾驶；两件事共用一个名字，
  //   用户看到的就必然是"嘴上说成功了、界面上没动"。
  //
  //   登记成 `surface` 而不是 `agent`：读它的是**总览面板与语音**，
  //   没有别的 agent 会订阅它。登记成 agent 类会立刻触发死信箱判据
  //   （TOPIC_NO_SUBSCRIBER），而"为了过门随便找个 agent 订阅"会造出一条
  //   没有任何语义的假依赖 —— 那比不登记更坏。
  { id: 'autopilot.changed', label: '自动驾驶已变更', kind: 'surface', meaning: '交易自动驾驶被启动或停止，附阶段与目标；总览面板的按钮状态由它决定' },
]

// ─────────────────────────── 消费面表 ───────────────────────────

/**
 * 舰队产出的消费面。**`consumers` 只能填这里的 id** ——
 * 这条不是形式主义：本仓库的真实教训是"有 HTTP 端点但没人读"就是半闭环，
 * 所以消费面必须是**具名的、可核对的**，不能是一句自由文本。
 *
 * `evidence` 的 marker 选用"删掉接线就会消失"的字符串：
 *   · 表单现在 `fleetSnapshot` / `fleetRunAgent` 这类**函数名**，
 *     而不是 `import`（import 可能与使用分家：import 了不用也是绿的）；
 *   · 语音层选它读舰队时调的那个函数名。
 */
export const FLEET_CONSUMERS: readonly FleetConsumer[] = [
  {
    id: 'ui:fleet',
    label: '「Agent 舰队」面板',
    kind: 'ui',
    evidence: { file: 'src/pages/AgentsPage.tsx', marker: 'useFleet' },
  },
  {
    id: 'ui:factors',
    label: '「因子工厂」面板（读策略台账产出）',
    kind: 'ui',
    // ★ marker 选的是**读取函数名**而不是 `import`：import 了不用也是绿的，
    //   而"撤掉接线"这个动作一定会让函数名消失。
    evidence: { file: 'src/pages/FactorsPage.tsx', marker: 'getFactorStrategies' },
  },
  {
    id: 'voice:fleet',
    label: '语音管家（问「舰队现在什么样」）',
    kind: 'voice',
    evidence: { file: 'server/voice/awareness.ts', marker: 'speakAgentFleet' },
  },
  {
    id: 'ui:overview',
    label: '「总览」面板（那颗「一键启动自治循环」按钮）',
    kind: 'ui',
    // ★ marker 选 `getAutopilotStatus`（轮询那个函数名）而不是组件名：
    //   按钮的**按下状态**完全由这一次轮询的返回值决定，
    //   撤掉这条接线，按钮就会永远停在"可启动"上 —— 而那正是用户实测看到的现象。
    evidence: { file: 'src/pages/OverviewPage.tsx', marker: 'getAutopilotStatus' },
  },
  {
    id: 'agent:gate',
    label: '过拟合守门人（吃上游产出）',
    kind: 'agent',
  },
  {
    id: 'agent:factor_screen',
    label: '策略筛官员（吃因子生产产出）',
    kind: 'agent',
  },
]

export function fleetConsumer(id: string): FleetConsumer | null {
  return FLEET_CONSUMERS.find((c) => c.id === id) ?? null
}

export function fleetTopic(id: string): FleetTopic | null {
  return FLEET_TOPICS.find((t) => t.id === id) ?? null
}
