/**
 * UI 动作通道 —— 让桌宠/语音能真的去按界面上的按钮
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 用户实测反馈：「它需要能操作系统内所有功能页面和按钮」。
 * 现在的桌宠能查、能派活，但**碰不到界面** —— 用户说「把总览那页打开」
 * 或「按一下因子工厂的刷新」，它只能回一句"我不会"。
 *
 * ── 为什么是注册表，而不是"按选择器点任意元素" ────────────────────────
 * 一个"给我个选择器我就点"的服务端，等价于一条**任意动作通道**：
 * 谁能跟它说话，谁就能点到任何东西 —— 包括那些设计上要人点两下才生效的按钮。
 * 所以这里只有注册表：`UI_ACTIONS` 里登记过的 id 才排得进队列。
 *
 * ★ 那"所有按钮"怎么保证？靠**可核对的完整性**：
 *   每一个登记项都必须在源码里有一个 `data-ui="<id>"` 的按钮与之对应，
 *   由 `test:ui-actions` 逐条 grep 核对。少一个就报红，多一个也报红。
 *   于是"新增一个按钮"这件事变成了"加一行注册表 + 加一个属性"，
 *   而不是"再写一条实现"。
 *
 * ── 两段式确认怎么落在这里 ──────────────────────────────────────────
 * `writes: true` 的动作会**真的改变系统状态**（启动自动驾驶、提交下单、保存风控参数），
 * 它们与语音层的危险动作同一档：必须带 `confirmed: true` 才排得进队列，
 * 而这个 `true` 只能由人点出来（与 `POST /fleet/news/verdict` 同一条纪律）。
 *
 * ── 队列为什么是 append-only 文件而不是内存数组 ──────────────────────
 * 内存队列有两个问题：重启即丢（用户点过什么没人知道），
 * 以及"排进去"和"做完了"分属两个进程时无从对齐。落成追加记录之后：
 *   · 每条动作有唯一 id，可被引用；
 *   · 状态由**最后一条记录**推出，不依赖任何进程的存活；
 *   · 审计链上能回答"是谁让它按的、按了之后成没成"。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
// ★ 复用舰队那份疑问句判据，不另写一份（判据只写一份，两份迟早不一致）。
//   它只认字符串、不 import 任何执行侧模块，所以这条依赖很轻。
import { looksInterrogative } from './fleet/plans.ts'
// ★ 标的与时长都**不许在这里再写一份**（判据 8）：
//   「这个标的存不存在」归行情注册表；「这个时长有没有证据底座」归预测层。
//   注册表是 `src/**` 里的纯数据模块，而 `server → src` 是本仓库既有的方向
//   （`server/autopilot.ts` 等一长串都这么引）。
import { MARKET, byExchange } from '../src/market/registry.ts'
import { resolveHorizon } from './forecastService.ts'

/**
 * 参数里「未来多少分钟」的上限。
 *
 * ★ 为什么要设上限：这台机器只有 30 天历史（见 `data/history/`）。
 *   传 100000 分钟进来，`resolveHorizon` 会老老实实算出 100005 分钟、
 *   界面会多出一个「1667小时」的档位 —— 每个环节都没报错，
 *   而那个数**没有任何证据支撑**，图上画的是一条靠外推撑出来的带。
 *   拒收比"画一张看着很正常的图"诚实（判据 25）。
 */
const MAX_FORECAST_MINUTES = 1440

/** 与 `src/store/Store.tsx` 的 `PageId` 必须逐字一致（门禁断言）。 */
export const UI_PAGES = [
  { id: 'overview', label: '总览控制台' },
  { id: 'voice', label: '语音管家 · 桌宠' },
  { id: 'mission', label: '任务' },
  { id: 'brain', label: '决策大脑' },
  { id: 'terminal', label: '交易终端' },
  { id: 'agents', label: 'Agent 舰队' },
  { id: 'evo', label: '进化实验室' },
  { id: 'factors', label: '因子工厂' },
  { id: 'news', label: '新闻雷达' },
  { id: 'protocol', label: '协议栈' },
  { id: 'risk', label: '风控中心' },
  { id: 'seam', label: '可信接缝' },
  { id: 'monitor', label: '系统监控' },
  { id: 'settings', label: '参数设置' },
] as const

export type UiPageId = (typeof UI_PAGES)[number]['id']

export interface UiActionSpec {
  /** 全局唯一的动作 id，也是源码里 `data-ui` 的值。 */
  id: string
  page: UiPageId
  /** 按钮上的字。**必须与源码里的按钮文案一致**（门禁会核对）——
   *  对不上的话，用户说"按一下启动"我们却按了另一个东西，而两边的名字都看着合理。 */
  label: string
  /** 会不会改变系统状态。`true` 的一律要人确认过才排得进队列。 */
  writes: boolean
  /** 说出来给用户听的一句话，讲清楚"按下去会发生什么"。 */
  speaks: string
  /**
   * 这个按钮在语音侧**已经有一个专属主人**：舰队计划 id。
   *
   * ★ 为什么需要这一栏：同一句话只许有一个主人。
   *   「一键启动自治循环」在 `fleet/plans.ts` 里已经是一条计划（`autonomy-start`），
   *   而 `intents.ts` 里白纸黑字写着"给它单开一个意图就会多出一条通路，
   *   两条通路迟早对同一件事给出不同文案（判据 8）"。
   *   如果 `resolveUiAction` 也来认领这颗按钮，就等于把那句话交给两个主人：
   *   一个去跑计划链、一个去点按钮 —— 后者还会**真的再点一次**。
   *
   * ★ 所以声明了这一栏的动作，`resolveUiAction` **不认领**，
   *   而是返回 `kind: 'owned'` 把话递回给舰队调度器。用户说法的效果不变
   *   （那颗按钮的状态会跟着变，因为两条路最终调的是**同一个** `startAutopilot()`），
   *   但执行只发生一次。
   */
  voicePlan?: string
  /**
   * 两段式按钮：**点一次只是上膛，要点第二次才真跑**。
   *
   * ★ 为什么必须标出来：桌宠只能点一次。盲点一下的后果不是"什么都没发生"，
   *   而是**上膛了但没跑**，然后它会回报"已按下"—— 这正是用户实测反馈的
   *   「只完成了一半却报成功」那一类失效。宁可拒绝并说清楚，
   *   也不要制造一个看着成功的半成品。
   */
  twoStage?: boolean
  /**
   * 这颗按钮**只能人点**，桌宠不代按。
   *
   * ★ 判据：按下去的后果取决于"面板里现在填着什么"或"上一步人做了什么"，
   *   而这些是**桌宠看不见**的东西。盲按一次的结局不是"什么都没发生"，
   *   而是**拿旧内容提交了一笔**，然后回报"已按下" ——
   *   与两段式那颗按钮同一类失效（看着成功的半成品）。
   *
   * ★ 为什么不能用 `voicePlan` 兼表这件事：那一栏的意思是"这句话归舰队计划"，
   *   它的下一步动作是**去找舰队的计划链**；而这里的下一步动作是
   *   **让人自己说清楚要买什么，或者自己点**。两件事的下一步相反，
   *   压成一个字段就会给出错误指引（判据 25）。
   */
  operatorOnly?: boolean
  /**
   * 用户**可能说的其它说法**（匹配用）。
   *
   * 随状态变化的按钮（"立即跑一轮" / "再点开跑" / "抓取中…"）没法只用一个 `label`
   * 覆盖。这里放的是"用户嘴上可能怎么说"，不是"屏幕上写了什么"——
   * 后者归 `screenText`，两件事刻意分开：混在一起时，一个动态按钮会逼着
   * 注册表去写一句屏幕上的话，而屏幕上那句话**每一帧都不一样**。
   */
  labelAlt?: readonly string[]
  /**
   * 屏幕上真实存在的、**可核对**的那段字。这是本注册表里唯一能被机器验证的名字。
   *
   * ★ 为什么必须有：用户是**照着屏幕念**的。屏幕上写的字如果和注册表里的名字
   *   对不上，那么"我说的话它听不懂、它说的名字我找不到"就同时成立 ——
   *   而两边单独看都很合理。实测里 20 颗按钮有 9 颗是这样：
   *   注册表写「刷新舰队实况」，屏幕上写的是「刷新」。
   *
   * ★ 静态按钮就用按钮文案本身；动态按钮（"保存并生效（3）"、
   *   "买入 BTC · 市价"）用其中**不变的那一段**（"保存并生效"）。
   *
   * ★ 真的没有屏幕文案时写 `null`，但必须在 `screenTextNote` 里写明为什么 ——
   *   不许沉默地留空（判据 24：缺数据要说出来，`null` 不许退化成"随便填一个"）。
   */
  screenText: string | null
  /** `screenText` 为 `null` 时**必须**写：这颗按钮为什么没有可核对的屏幕文案。 */
  screenTextNote?: string
  /**
   * 这颗按钮**接受哪些参数**。没有这一栏 = 不接受任何参数。
   *
   * ── 为什么按钮要有参数（本轮用户实测）────────────────────────────────
   * 用户：「桌宠说到可以做到，顺手把走势图调出来，方便同步查看」。
   * 它问的是「比特币未来一小时」，嘴里念的也是 BTC / 60 分钟；而队列里那条
   * 动作原先只有一个 `actionId` ⇒ 界面按下之后画的是**屏幕当前选着的标的**。
   * 于是屏幕上同时出现两个口径不同的数：嘴里 60 分钟、图上 15 分钟。
   * 两个数各自都对，放在一起看没有意义（判据 31）。
   *
   * ── 为什么必须是**白名单 + 服务端归一**，而不是原样透传 ────────────────
   * 参数最终决定"去算哪个标的、未来多久"。不校验的话，一个注册表里没有的
   * 标的会被拿去算 —— 而**预测层对不存在的历史会静默回落成合成序列**，
   * 返回的方向、目标价、分位带一应俱全，与真实历史算出来的长得一模一样。
   * 两个的下一步动作却相反（判据 13）。所以这里是拒收，不是"尽力而为"。
   */
  payloadKeys?: readonly string[]
  /**
   * 把调用方给的参数**归一成界面能直接用的那一份**；不顺眼就拒收。
   *
   * ★ 归一放在服务端而不是界面：界面那份是"照着参数画"，它没有立场
   *   去判断"这个标的存不存在"（那需要行情注册表）与"这个时长有没有证据底座"
   *   （那需要预测层）。让界面自己猜，就会长出第二份口径（判据 8）。
   *
   * ★ 返回的 `payload` 必须**只含 `payloadKeys` 里的键** —— 界面据此渲染，
   *   多出来的键没人读，而"没人读的键"是最容易悄悄错掉的那种。
   */
  normalizePayload?: (
    p: Readonly<Record<string, unknown>>,
  ) => { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string }
}

/**
 * 登记在册的按钮。
 *
 * ★ 只登记**有独立语义**的按钮，不登记「上移」「下移」「删除第 3 行」这类
 *   需要参数又没有名字的操作 —— 它们的语义是"对某一行做某事"，
 *   硬塞进一个无参动作里只会让 id 长得像参数编码，谁都不敢改。
 *
 * ★ `label` 与 `screenText` 是**两件事**，别把它们并成一个：
 *   `label` 是"我们用一句话称呼它"（写日志、播报、给模型看），
 *   `screenText` 是"屏幕上真的写着这几个字"（门禁核对，用户照念的凭据）。
 *   实测里 20 颗按钮有 9 颗这两个对不上 —— 屏幕写「刷新」、注册表写「刷新舰队实况」。
 *   对不上的后果不是"匹配变差"，而是**照着屏幕念永远点不着**，
 *   而注册表自己看着完全合理。
 */
export const UI_ACTIONS: readonly UiActionSpec[] = [
  {
    id: 'overview.autopilot.start',
    page: 'overview',
    label: '一键启动自治循环',
    screenText: '一键启动自治循环',
    writes: true,
    voicePlan: 'autonomy-start',
    speaks: '按下去会启动纸面自动驾驶（因子挖掘 → 门禁 → 执行 → 目标追踪），总览那颗按钮会变成「停止自治循环」。',
  },
  {
    id: 'overview.autopilot.stop',
    page: 'overview',
    label: '停止自治循环',
    screenText: '停止自治循环',
    writes: true,
    voicePlan: 'autonomy-stop',
    speaks: '按下去会停掉纸面自动驾驶。已开的仓位不会被自动平掉 —— 平仓是另一件事。',
  },
  {
    id: 'overview.factors.detail',
    page: 'overview',
    label: '查看因子挖掘详情',
    screenText: '查看因子挖掘详情',
    writes: false,
    speaks: '按下去会切到「进化实验室」页面。只切页，不动任何状态。',
  },
  {
    id: 'agents.refresh',
    page: 'agents',
    label: '刷新舰队实况',
    screenText: '刷新',
    labelAlt: ['刷新'],
    writes: false,
    speaks: '重新读一遍舰队实况与账本事件。只读。',
  },
  {
    id: 'agents.plan.check',
    page: 'agents',
    label: '试跑计划',
    screenText: '这计划能接吗',
    labelAlt: ['试跑计划', '这计划能接吗'],
    writes: false,
    speaks: '把计划链逐个成员试算一遍，不动真东西 —— 跑完只是给你看结论。',
  },
  {
    id: 'agents.run.task',
    page: 'agents',
    label: '跑这个任务',
    screenText: '跑这个任务',
    writes: true,
    speaks: '真的按计划链顺序跑一遍成员 —— 链上若含写台账的成员，它就会写。',
  },
  {
    id: 'news.run',
    page: 'news',
    label: '跑一轮新闻雷达',
    // 源码里这颗按钮的文案是**三态**的，取其中不变的那一段。
    screenText: '立即跑一轮',
    labelAlt: ['立即跑一轮', '再点开跑'],
    writes: true,
    // ★ 同一个道理：这颗按钮背后就是定时任务那一句（源码 title 写着
    //   "跑的就是定时任务那一句"），所以语音侧的主人也是舰队 `news` 计划。
    voicePlan: 'news',
    // ★ 它是两段式：第一下"上膛"（`runArmed`），第二下才真抓。
    twoStage: true,
    speaks: '抓一遍新闻源、按确定性规则判相关、把值得内化的写成提案。提案要人来点才算数。',
  },
  {
    id: 'news.refresh',
    page: 'news',
    label: '刷新雷达数据',
    screenText: '刷新',
    labelAlt: ['刷新'],
    writes: false,
    speaks: '重新读一遍雷达现状。只读。',
  },
  {
    id: 'news.filter.kept',
    page: 'news',
    label: '只看过门的',
    screenText: '只看过门的',
    writes: false,
    speaks: '清单只显示过了相关度门线的条目。只切换显示，不改数据。',
  },
  {
    id: 'news.filter.all',
    page: 'news',
    label: '连拦下的一起看',
    screenText: '连拦下的一起看',
    writes: false,
    speaks: '清单把被门拦下的条目也显示出来，附带拦下的理由。',
  },
  {
    id: 'factors.refresh',
    page: 'factors',
    label: '刷新因子台账',
    screenText: '刷新台账',
    labelAlt: ['刷新台账'],
    writes: false,
    speaks: '重新读一遍因子台账与策略台账。只读，不触发新的挖掘。',
  },
  {
    id: 'factors.auto.toggle',
    page: 'factors',
    label: '自动刷新开关',
    // 两个状态的原话分别是「停止自动刷新」「每 12s 自动刷新」，共有的片段是它。
    screenText: '自动刷新',
    labelAlt: ['自动刷新', '停止自动刷新', '自动刷新开关'],
    writes: false,
    speaks: '切换这一页的自动轮询。只影响显示。',
  },
  {
    id: 'monitor.autopilot.start',
    page: 'monitor',
    label: '启动',
    screenText: '启动',
    writes: true,
    voicePlan: 'autonomy-start',
    speaks: '从系统监控页启动纸面自动驾驶 —— 与总览那颗按钮是同一个东西。',
  },
  {
    id: 'monitor.autopilot.stop',
    page: 'monitor',
    label: '停止',
    screenText: '停止',
    writes: true,
    voicePlan: 'autonomy-stop',
    speaks: '从系统监控页停掉纸面自动驾驶。',
  },
  {
    id: 'risk.sandbox.run',
    page: 'risk',
    label: '跑一次沙盒演练',
    screenText: '一键沙箱自检',
    labelAlt: ['沙盒演练', '一键沙箱自检', '沙箱自检'],
    writes: true,
    speaks: '按当前风控参数跑一次演练，验证它们真的会拦下该拦的动作。不改参数。',
  },
  {
    id: 'risk.params.save',
    page: 'risk',
    label: '保存风控参数',
    // 屏幕上是「保存并生效（3）」，括号里是变化的那部分。
    screenText: '保存并生效',
    labelAlt: ['保存并生效', '保存参数'],
    writes: true,
    speaks: '把改过的风控参数写进系统。这会改变所有后续下单的判定，所以它要人确认。',
  },
  {
    id: 'risk.lesson.submit',
    page: 'risk',
    label: '提交心法',
    screenText: '提交并校验',
    labelAlt: ['提交并校验', '提交心法'],
    writes: true,
    speaks: '把这条心法写进心法库并生效 —— 它会被回注进之后每一次提案的上下文。',
  },
  {
    id: 'terminal.gate.precheck',
    page: 'terminal',
    label: '执行前置检查',
    /*
     * 这颗按钮在两态间切换文案（还没有结论 → `立即检查`；已有结论 → `重新检查`），
     * 所以 `screenText` 取**初始态**那一句，另一句进 `labelAlt`。
     * 与 `terminal.submit` 的 `null` 不同：这里两句话都是"这颗按钮的名字"
     * （整段就是在说它要干什么），只是随时间变了一次 —— 照着念是能念准的。
     */
    screenText: '立即检查',
    labelAlt: ['执行前置检查', '立即检查', '重新检查', '前置检查', '预检', '检查一下'],
    // ★ 只读：它调 `POST /orders/precheck`，不改状态、不占台账、不写审批单。
    //   所以它**不需要**两段式确认 —— 确认要给的是"会改状态"的动作。
    writes: false,
    speaks: '问引擎一次：这笔单凭什么可以出去。只读 —— 不改任何状态、不会下单。',
  },
  {
    /*
     * 「以走势预测为依据」那颗勾选框。
     *
     * ★ 为什么它是一颗**具名界面元素**而不是一个前端内部状态：桌宠能按到人手上能按的
     *   每一颗按钮（`data-ui` 的语义就是这个）。少登记它，用户说
     *   「勾上按走势预测下的单」时桌宠会回"找不到这颗按钮" ——
     *   而它明明在屏幕上（判据 11：报 0 ≠ 没错）。
     *
     * ★ `writes: false`：它只改**这一次预检的输入**，不改任何系统状态、不落台账。
     *   勾上之后真正发生的是一次只读预检，而"预测有没有优势"由服务端现算说了算 ——
     *   这个勾**不能**让任何东西变绿。
     */
    id: 'terminal.gate.forecast-claim',
    page: 'terminal',
    label: '以走势预测为依据',
    screenText: '这笔单以走势预测为依据',
    labelAlt: ['以走势预测为依据', '按走势预测下的单', '按预测下单', '以预测为依据', '按预测买', '按预测卖'],
    writes: false,
    speaks:
      '声明这笔单是按走势预测下的。勾上之后闸门会去核这句话：预测有没有统计优势、方向对不对、标的是不是同一个。它自己不会让任何东西变绿。',
  },
  {
    /*
     * 「算一次 / 重新算」—— 走势预测那颗按钮。
     *
     * ★ 为什么这颗按钮值得登记：用户要的是"**看得见**的走势图"。
     *   桌宠能念出结论（`forecastSpeech`），但念完屏幕上什么都没有 ——
     *   用户没法核对"它说的目标价在图上是什么位置、不确定性有多宽"。
     *
     * ★★ `labelAlt` 里**刻意不写「走势预测」「预测一下」「走势图」**。
     *   那几个词已经被 `query_forecast` 意图拥有（`voice/intents.ts` 的
     *   `FORECAST_WORDS` 正含它们）。写进来就是**同一句话两个主人**（判据 29），
     *   而且两边争到之后做的事完全不同：
     *     语音意图 ⇒ 念一段行情判断（方向 + 目标价 + 命中率 + 为什么）
     *     这颗按钮 ⇒ 只把图算出来画上屏，一个字的分析都不给
     *   用户问"帮我看一下走势图"时，被按钮认领就等于**只画图、不回答** ——
     *   它明明做了事、界面上也真动了，看起来完全正常。
     *   ⇒ 所以这里的说法一律是**按键语言**（算一次 / 重新算），不是**提问语言**。
     *
     * ★ 与 `terminal.gate.precheck` 同一类：只读。
     *   它调 `GET /forecast` —— 不落盘、不下单、不改任何状态，
     *   所以**不需要**两段式确认（确认要给的是"会改状态"的动作）。
     */
    id: 'terminal.forecast.run',
    page: 'terminal',
    label: '算一次',
    /*
     * 这颗按钮在**三态**间切换文案（还没有结论 → `算一次`；已有结论 → `重新算`；
     * 正在算 → `算中…`），所以 `screenText` 取**初始态**那一句，另两句进 `labelAlt`。
     * 与 `terminal.gate.precheck` 同一个形状。
     */
    screenText: '算一次',
    labelAlt: ['算一次', '重新算', '重算一次', '再算一次'],
    writes: false,
    speaks:
      '算一次未来走势预测：拿当前状态在历史上找相似时刻，看它们之后的收益分布，并用样本外数据核对这个预测器准不准。只读 —— 不会下单。',
    /*
     * ★ 这两个键合起来才是"哪一次预测"：光有标的不够（同一个标的还有 15 分 / 1 小时
     *   / 4 小时三种尺度），光有时长也不够。所以它们必须**一起来**。
     *   原先是无参按钮 —— 界面按下后用自己的当前选择去算，于是桌宠念 60 分钟、
     *   图上画 15 分钟，两个数各自都对、放在一起没有意义（判据 31）。
     */
    payloadKeys: ['symbol', 'minutes'],
    normalizePayload: (p) => {
      const raw = String(p.symbol ?? '').trim().toUpperCase()
      // ★ 认"交易所口径"的名字（`BTCUSDT`）—— 桌宠的预测与 `/forecast` 都用它。
      //   用 `byExchange` 而不是自己 startsWith：注册表是唯一一份名单。
      const m = byExchange(raw)
      if (!m) {
        return {
          ok: false,
          reason: `行情注册表里没有「${raw}」（共 ${MARKET.length} 个标的）。我不会让界面去画一个不存在的标的 —— 预测层对找不到的历史会静默回落成合成序列，那张图看起来会完全正常。`,
        }
      }
      const asked = Number(p.minutes)
      if (!Number.isFinite(asked) || asked <= 0) {
        return { ok: false, reason: `「未来多少分钟」必须是个正数，收到的是「${String(p.minutes)}」。` }
      }
      if (asked > MAX_FORECAST_MINUTES) {
        return {
          ok: false,
          reason: `这台机器的历史只有 30 天，「未来 ${asked} 分钟」超出了证据能支撑的范围（最多 ${MAX_FORECAST_MINUTES} 分钟）。我不会画一条靠外推撑起来的带。`,
        }
      }
      // ★ 归一到**证据底座对得齐**的那一档，并把归一后的值记下来 ——
      //   桌宠念的、界面上选中的、接口真正算的必须是**同一个数**（判据 31）。
      const h = resolveHorizon(asked)
      return { ok: true, payload: { symbol: m.exchange, minutes: h.actualMinutes } }
    },
  },
  {
    id: 'terminal.side.buy',
    page: 'terminal',
    label: '买入',
    screenText: '买入',
    writes: false,
    speaks: '把下单面板切到买入方向。只切方向，不提交。',
  },
  {
    id: 'terminal.side.sell',
    page: 'terminal',
    label: '卖出',
    screenText: '卖出',
    writes: false,
    speaks: '把下单面板切到卖出方向。只切方向，不提交。',
  },
  {
    id: 'terminal.submit',
    page: 'terminal',
    label: '提交下单',
    /*
     * ★ 这颗按钮**没有**稳定的屏幕文案：它渲染的是
     *   `{买入|卖出} {品种} · {市价|挂单|带止损开仓}`，整段都是随选择变的。
     *   所以"照着屏幕念"在这里不成立 —— 用户说它靠的是**习惯说法**（"提交下单"）。
     *   这里刻意写 `null` 而不是随便挑一个片段（比如"市价"）填进去：
     *   随便填的那一个会让门禁变绿，而它并不能让用户照着屏幕念准这颗按钮。
     */
    screenText: null,
    screenTextNote:
      '整段文案都是动态的（方向 + 品种 + 类型三段都在变），没有任何一段是"这颗按钮的名字"；对它的称呼是用户习惯说法，不是读屏。',
    labelAlt: ['提交下单', '提交订单', '下单'],
    writes: true,
    // ★ 只能人点：它提交的是"面板里现在填着的那份内容"，
    //   而桌宠看不见面板里填了什么。盲按一次的结局不是"什么都没发生"，
    //   而是**拿上面残留的内容提交了一笔**，然后回报"已按下"。
    //   语音侧做同一件事的正确入口是**说出完整指令**（品种/方向/金额），
    //   那条路会走下单意图、带金额复述与风控 —— 严格优于"按一下碰运气"。
    operatorOnly: true,
    speaks: '按面板上填的内容提交一笔单。这是真的下单，所以它要人确认。',
  },
]

/** 造一条"切页"动作的规格。**只有这一个出处** —— 解析、入队、列表三处共用它。 */
export function navSpec(pageId: string): UiActionSpec | null {
  const p = uiPage(pageId)
  if (!p) return null
  return {
    id: `nav.${p.id}`,
    page: p.id as UiPageId,
    label: p.label,
    // 侧边栏那一项上写的就是页面名，所以它同样是"照着屏幕念"的凭据。
    screenText: p.label,
    writes: false,
    speaks: `切到「${p.label}」页面。只切页，不动任何状态。`,
  }
}

/**
 * 按 id 取规格。**导航动作也在这里解析**。
 *
 * ★ 这一条是端到端实测抓出来的真实死路：
 *   `resolveUiAction` 会产出合成的导航 id（`nav.<page>`），而它不在 `UI_ACTIONS` 里。
 *   于是 `enqueueUiAction` 判它"没有这个动作"⇒ **语音说「打开交易终端」必然失败**；
 *   而 `listTasks` 找不到 spec 就直接 `continue` ⇒ 即使排进去了**也不会出现在队列里**。
 *   链路每一段单看都正常（解析产出了 id、执行器有 nav 分支），
 *   但那个 nav 分支**永远收不到任何东西** —— 判据 10 的形状：写了执行路径，没人能走到它。
 */
export function uiAction(id: string): UiActionSpec | null {
  const direct = UI_ACTIONS.find((a) => a.id === id)
  if (direct) return direct
  if (id.startsWith('nav.')) return navSpec(id.slice(4))
  return null
}

export function uiPage(id: string): { id: string; label: string } | null {
  return UI_PAGES.find((p) => p.id === id) ?? null
}

// ─────────────────────────── 工作区根 ───────────────────────────

/**
 * 队列文件写在哪。
 *
 * ★ 刻意做成**可注入**而不是直接读 `process.cwd()`：
 *   HTTP 那侧与语音那侧必须落在**同一份**队列上，而它们各自的进程 cwd
 *   在测试里是刻意不同的。让两边各自调一次 `process.cwd()`
 *   就等于把"它们是不是同一个"交给运气 —— 表现是"桌宠说排了、界面说队列是空的"，
 *   而两边单独看都没错。
 *   生产启动时由 `server/index.ts` 注入真实工作区。
 */
let wsRoot: string | null = null
export function setUiWorkspaceRoot(dir: string): void {
  wsRoot = dir
}
export function uiWorkspaceRoot(): string {
  return wsRoot ?? process.cwd()
}

// ─────────────────────────── 队列（append-only）───────────────────────────

export function uiDir(cwd: string): string {
  return join(cwd, 'data', 'ui')
}
export function uiQueuePath(cwd: string): string {
  return join(uiDir(cwd), 'actions.jsonl')
}

/** 一条队列记录。状态完全由**最后一条**记录推出，不依赖任何进程。 */
export interface UiTaskRecord {
  type: 'enqueue' | 'claim' | 'done' | 'failed'
  id: string
  at: number
  actionId: string
  page: string
  /** 排它的人/入口。用于审计："是谁让它按的"。 */
  requestedBy: string
  /** 人点过的确认凭证（`writes` 动作必需）。 */
  confirmed?: boolean
  /**
   * 按这一下时**用什么参数**（只含 `spec.payloadKeys` 里的键）。
   *
   * ★ 必须跟着 `enqueue` 与 `claim` **两条记录一起走**：任务视图由
   *   `listTasks` 取**最后一条**记录拼出 —— 只写在 `enqueue` 上的话，
   *   认领那一刻视图就换成 claim 那条，参数当场消失。
   *   而表现是"界面上按了、图的尺度却是屏幕上原本那个"，看不出任何异常。
   *   （`test:ui` 的 U34 专门钉这一条，`_mutate_ui.mjs` 里有对应的变异。）
   */
  payload?: Record<string, unknown>
  /** 执行结果的一句话（`done` / `failed` 时）。 */
  detail?: string
}

/** 一条待执行动作的完整视图。 */
export interface UiTask extends UiTaskRecord {
  status: 'pending' | 'claimed' | 'done' | 'failed'
  /** 过了 TTL 还没被执行 —— 与"没排过"**不是**一回事，必须分得开。 */
  stale: boolean
  spec: UiActionSpec
}

/** 待执行动作的存活时间。**要远大于**界面轮询间隔（2s），
 *  否则一个正常轮询的空档就会把刚排的动作判成过期。 */
export const UI_TASK_TTL_MS = 60_000

/**
 * 认领的有效期。
 *
 * ★ 为什么需要"认领"这一步：界面上可能同时开着**多个窗口**
 *   （主窗口 + 桌宠悬浮窗 + 用户自己开的另一个标签页）。
 *   没有认领的话，所有窗口都会看见同一条待执行动作并各按一次 ——
 *   而其中有些动作是**不幂等**的（提交下单、提交心法）。
 *   认领之后只有第一个窗口执行，其余窗口看得见它已被认领。
 *
 * ★ 认领会过期，理由与任务 TTL 一样：认领的窗口可能直接被杀掉
 *   （用户关掉标签页）。过期后允许别人重新认领 —— 宁可重复执行一次可幂等的动作，
 *   也不要因为一个死窗口把整条队列卡住。这个取舍写在这里，不藏在代码里。
 */
export const UI_CLAIM_TTL_MS = 15_000

function readAll(cwd: string): UiTaskRecord[] {
  const p = uiQueuePath(cwd)
  if (!existsSync(p)) return []
  const out: UiTaskRecord[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as UiTaskRecord
      if (r && typeof r.id === 'string' && typeof r.actionId === 'string') out.push(r)
    } catch {
      // 坏行跳过而不是整体失败：一个被截断的尾行不该让整个队列读不出来。
      continue
    }
  }
  return out
}

/**
 * 把追加记录折叠成任务视图。
 *
 * ★ `status` 取**最后一条**记录，所以顺序敏感 —— 追加写保证了顺序。
 * ★ 过期任务**保留在列表里**（标 `stale`），不静默丢弃：
 *   "排了但没人执行"与"根本没排"是两回事，前者说明界面那一侧断了。
 */
export function listTasks(cwd: string, opts: { limit?: number } = {}): UiTask[] {
  const now = Date.now()
  const byId = new Map<string, UiTaskRecord[]>()
  const order: string[] = []
  for (const r of readAll(cwd)) {
    if (!byId.has(r.id)) order.push(r.id)
    const arr = byId.get(r.id) ?? []
    arr.push(r)
    byId.set(r.id, arr)
  }
  const tasks: UiTask[] = []
  for (const id of order) {
    const recs = byId.get(id)!
    const last = recs[recs.length - 1]!
    const spec = uiAction(last.actionId)
    if (!spec) continue
    const status: UiTask['status'] =
      last.type === 'enqueue' ? 'pending' : last.type === 'claim' ? 'claimed' : last.type === 'done' ? 'done' : 'failed'
    // ★ 过期判定按**当前状态那一条记录**的时间算，不是按 enqueue 的时间：
    //   否则一条刚被认领的动作会因为"排了很久"被同时标成过期与已认领，
    //   而界面上那两个标记指向相反的动作（重排 / 继续执行）。
    const stale =
      (status === 'pending' && now - last.at > UI_TASK_TTL_MS) ||
      (status === 'claimed' && now - last.at > UI_CLAIM_TTL_MS)
    tasks.push({ ...last, status, stale, spec })
  }
  const lim = opts.limit ?? 50
  return tasks.slice(-lim)
}

/**
 * 界面来取活时**顺手认领**。
 *
 * ★ 返回的是**这一轮已经属于你**的任务：服务端在同一个函数里做"读 + 认领"，
 *   所以两个窗口同时来取时，只有第一个拿到（后一个看到的是 claimed 且没过期）。
 *   如果让界面自己"先查再认领"，两步之间就有窗口 —— 而那个窗口里两个窗口
 *   会同时认为自己拿到了活。
 *
 * ★ 过期认领会被**重新认领**（写一条新的 claim 记录），
 *   所以不会因为一个被关掉的标签页把队列卡死。
 */
export function claimPendingTasks(cwd: string, claimedBy: string): UiTask[] {
  const now = Date.now()
  const claimable = listTasks(cwd, { limit: 200 }).filter(
    (t) => (t.status === 'pending' && !t.stale) || (t.status === 'claimed' && t.stale),
  )
  for (const t of claimable) {
    append(cwd, {
      type: 'claim',
      id: t.id,
      at: now,
      actionId: t.actionId,
      page: t.page,
      requestedBy: claimedBy,
      // ★ 参数必须跟着认领记录一起走 —— 视图由**最后一条**记录拼出，
      //   漏了它，参数就在"排队 → 认领"这一步静默消失（判据 11）。
      ...(t.payload ? { payload: t.payload } : {}),
    })
  }
  return claimable.map((t) => ({ ...t, status: 'claimed' as const, stale: false }))
}

export function pendingTasks(cwd: string): UiTask[] {
  return listTasks(cwd, { limit: 200 }).filter((t) => t.status === 'pending')
}

export type EnqueueResult =
  | { ok: true; task: UiTask }
  | { ok: false; reason: string; speech: string }

function append(cwd: string, rec: UiTaskRecord): void {
  const p = uiQueuePath(cwd)
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, JSON.stringify(rec) + '\n')
}

/**
 * 按声明的键序重排参数。
 *
 * ★ 为什么要多这一步：`JSON.stringify` 的键序就是对象自身的键序，而调用方
 *   组装对象时的顺序不受控。键序一变，队列文件里同一件事的两行就长得不一样，
 *   "拿两行 diff 一下"这种最省事的排查手段当场失效。
 */
function orderByKeys(
  p: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of order) {
    if (k in p) out[k] = p[k]
  }
  // 声明之外的键不该存在（上面已经拒收过），真出现了也**不许默默丢**。
  for (const k of Object.keys(p)) {
    if (!(k in out)) out[k] = p[k]
  }
  return out
}

/**
 * 等一条排出去的动作被**某个窗口真的领走并回报**。
 *
 * ── 为什么需要它（判据 10：有端点 ≠ 有人读）────────────────────────────
 * 桌宠排一条动作之后能说三句不同的话："已经调出来了" / "排上了但没人按" /
 * "有人按了但报错"。**只有第一句是用户期待的**，而它们要靠"队列里最后一条
 * 记录是什么"来分辨 —— 不是靠猜。不等的后果是桌宠把"排上了"说成"调出来了"，
 * 而屏幕上一片安静：它明明做了事、账本里也真有那条记录，看起来完全正常。
 *
 * ── 为什么是同步轮询而不是回调 ────────────────────────────────────────
 * 调用方（语音服务）是同步的请求-应答形状，回话必须在这一轮里给出。
 * 所以这里就是"睡一下再看一眼"，上限刻意给得比界面轮询间隔（2s）宽裕。
 *
 * ★ 返回三态而不是布尔：`pending`（还没人领）与 `failed`（领了但没成）
 *   指向相反的动作（去开界面 / 去修那个功能），压成 `false` 就再也分不开。
 */
export type UiAckOutcome =
  | { state: 'done'; detail: string; by: string }
  | { state: 'failed'; detail: string; by: string }
  | { state: 'pending' }
  | { state: 'unknown'; reason: string }

export function waitForUiAck(cwd: string, id: string, timeoutMs = 5_000): UiAckOutcome {
  const deadline = Date.now() + timeoutMs
  // 先看一次再睡：多数情况下它已经回报了（桌面窗口 2 秒轮询一次）。
  for (;;) {
    let t: UiTask | undefined
    try {
      t = listTasks(cwd, { limit: 200 }).find((x) => x.id === id)
    } catch (e) {
      // ★ 读队列失败必须与"没人按"分开 —— 它们指向的动作相反。
      return { state: 'unknown', reason: e instanceof Error ? e.message : String(e) }
    }
    if (!t) return { state: 'unknown', reason: `队列里已经没有 ${id} 这条记录了` }
    if (t.status === 'done' || t.status === 'failed') {
      return { state: t.status, detail: t.detail ?? '', by: t.requestedBy }
    }
    if (Date.now() >= deadline) return { state: 'pending' }
    sleepSync(120)
  }
}

/**
 * 同步睡一小会儿。
 *
 * ★ 为什么不用 `await new Promise(setTimeout)`：这个函数要能被**同步**调用方用，
 *   也要能被门禁直接断言（`test:ui` 里跑的是同步断言）。`Atomics.wait` 是
 *   Node 里唯一"不空转 CPU 的同步等待"。
 */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

/**
 * 排一条动作。
 *
 * ★ 校验顺序刻意是「登记了吗 → 要不要人确认」：
 *   反过来（先查确认）会让"这个动作根本不存在"被报成"缺确认"，
 *   而用户据此去点一个永远点不出来的确认。
 */
export function enqueueUiAction(
  cwd: string,
  actionId: string,
  opts: { requestedBy: string; confirmed?: boolean; payload?: Readonly<Record<string, unknown>> },
): EnqueueResult {
  const spec = uiAction(actionId)
  if (!spec) {
    const near = UI_ACTIONS.filter((a) => a.id.includes(actionId) || a.label.includes(actionId)).slice(0, 3)
    return {
      ok: false,
      reason: 'NO_SUCH_UI_ACTION',
      speech:
        `界面上没有登记叫「${actionId}」的按钮，所以我没按。` +
        (near.length > 0 ? `你是不是想说：${near.map((a) => `「${a.label}」`).join('、')}？` : `我登记了 ${UI_ACTIONS.length} 个按钮，可以用「界面上有哪些按钮」问我要清单。`),
    }
  }
  if (spec.writes && opts.confirmed !== true) {
    return {
      ok: false,
      reason: 'UI_ACTION_NEEDS_CONFIRM',
      speech: `${spec.label} 会改变系统状态：${spec.speaks}这是我不能替你点的 —— 需要你确认一次。`,
    }
  }
  // ★ 两段式按钮拒绝排在确认之后：先问"要不要人确认"更贴近用户的下一步，
  //   但如果一个两段式按钮**同时**需要确认，两句话都该说 —— 所以两段式
  //   只挡住"已经确认过了"的那一步，而不是把 NEEDS_CONFIRM 顶替掉。
  if (spec.twoStage) {
    return {
      ok: false,
      reason: 'UI_ACTION_TWO_STAGE',
      speech:
        `${spec.label} 这颗按钮是两段式的：第一下只是上膛，第二下才真跑。` +
        '我只能点一下，点了就是"上膛了但没跑"—— 那种"看着成功"的假完成比直接失败更坑人，所以我不点。' +
        '这件事在语音侧有专门的说法，你说一句「' +
        (spec.page === 'news' ? '看新闻，有值得内化的就写提案' : spec.label) +
        '」我就能整件事一起做完。',
    }
  }
  // ── 参数校验：排在确认/两段式**之后、入队之前** ──────────────────────
  //
  // ★ 顺序理由：参数错与"缺人确认"指向的动作不同（一个去改参数、一个去点确认），
  //   但"缺确认"更靠近用户的下一步（他马上要点一下），所以先报它。
  //   而两段式那颗按钮**根本不接受参数**（它连自己会做什么都不确定），
  //   所以参数校验排在它后面 —— 报"参数不对"而真实原因是"这按钮我不点"，
  //   会把用户引去改一个改了也没用的参数（判据 17）。
  const given = opts.payload ?? {}
  const keys = Object.keys(given)
  let payload: Record<string, unknown> | undefined
  if (keys.length > 0) {
    /*
     * ★ 先取成一个**一定存在**的数组，而不是后面用 `spec.payloadKeys!` 断言非空。
     *   理由不是"少一个感叹号更好看"：断言写在**判断之后**的另一条语句上时，
     *   判断本身一旦被改动（或被上面的分支短路），断言就当场变成运行时崩溃。
     *   实测过（`_mutate_ui.mjs` M25 的第一版）：变异把这条 `if` 拿掉，
     *   烟测不是"某条断言变红"，而是整个进程 `TypeError` 退出 ——
     *   于是变异验证只能报"探针坏了"，既有缺陷**也**没被指名。
     *   取成局部变量之后，`unknown` 至多算出"这几个键都不认"，仍然是红的。
     */
    const declared = spec.payloadKeys ?? []
    if (declared.length === 0) {
      return {
        ok: false,
        reason: 'UI_ACTION_NO_PAYLOAD',
        speech: `「${spec.label}」不接受参数，但你（或我）给它带了 ${keys.join('、')}。我不带着没人读的东西去按按钮 —— 那样看着像是"参数生效了"，其实没有。`,
      }
    }
    const unknown = keys.filter((k) => !declared.includes(k))
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: 'UI_ACTION_BAD_PAYLOAD',
        speech: `「${spec.label}」只认这几个参数：${declared.join('、')}；多了 ${unknown.join('、')}。多出来的键没人读，所以我拒收而不是丢掉它们。`,
      }
    }
    if (spec.normalizePayload) {
      const n = spec.normalizePayload(given)
      if (!n.ok) {
        return { ok: false, reason: 'UI_ACTION_BAD_PAYLOAD', speech: `${spec.label}这次没排上：${n.reason}` }
      }
      // ★ 存的是**归一后**的那一份，不是调用方给的那一份 ——
      //   界面照着它渲染，桌宠照着它念。两处读的必须是同一个数（判据 31）。
      payload = n.payload
    } else {
      payload = { ...given }
    }
  }
  const rec: UiTaskRecord = {
    type: 'enqueue',
    id: randomUUID().slice(0, 12),
    at: Date.now(),
    actionId,
    page: spec.page,
    requestedBy: opts.requestedBy,
    ...(spec.writes ? { confirmed: true } : {}),
    // ★ 归一后的参数按 `payloadKeys` 的**声明顺序**写，键序稳定 ⇒ 队列文件可比对。
    ...(payload ? { payload: orderByKeys(payload, spec.payloadKeys ?? []) } : {}),
  }
  append(cwd, rec)
  const task = listTasks(cwd, { limit: 200 }).find((t) => t.id === rec.id)
  if (!task) {
    return { ok: false, reason: 'ENQUEUE_READBACK_FAILED', speech: '排进去了但我读不回来 —— 这说明队列文件有问题，不是动作有问题。' }
  }
  return { ok: true, task }
}

/** 界面回报执行结果。重复回报是幂等的（后来的覆盖先前的结论）。 */
export function completeUiAction(
  cwd: string,
  id: string,
  result: { ok: boolean; detail?: string; requestedBy: string },
): { ok: boolean; reason?: string } {
  const t = listTasks(cwd, { limit: 400 }).find((x) => x.id === id)
  if (!t) return { ok: false, reason: 'NO_SUCH_UI_TASK' }
  append(cwd, {
    type: result.ok ? 'done' : 'failed',
    id,
    at: Date.now(),
    actionId: t.actionId,
    page: t.page,
    requestedBy: result.requestedBy,
    detail: result.detail ?? '',
  })
  return { ok: true }
}

/** 给面板/语音用的一段话：队列现在什么情况。三态分开，别把"没人执行"说成"没排过"。 */
export function renderQueueSpeech(cwd: string): string {
  const all = listTasks(cwd, { limit: 200 })
  const pending = all.filter((t) => t.status === 'pending')
  const fresh = pending.filter((t) => !t.stale)
  const stale = pending.filter((t) => t.stale)
  const claimed = all.filter((t) => t.status === 'claimed' && !t.stale)
  const claimedStale = all.filter((t) => t.status === 'claimed' && t.stale)
  if (all.length === 0) return '界面动作队列是空的 —— 还没有人通过这条路按过任何按钮。'
  const parts = [`队列里累计 ${all.length} 条。`]
  if (fresh.length > 0) parts.push(`有 ${fresh.length} 条等着界面执行：${fresh.map((t) => `「${t.spec.label}」`).join('、')}。`)
  if (claimed.length > 0) parts.push(`另有 ${claimed.length} 条已被某个窗口认领、正在执行。`)
  if (stale.length > 0) {
    // ★ 这一句是整段话里最重要的一句：过期**不是**"没排过"。
    parts.push(
      `另外 ${stale.length} 条排了但界面没来取（超过 ${Math.round(UI_TASK_TTL_MS / 1000)} 秒），` +
        '这**不等于没排过** —— 说明界面那一侧没在轮询，去查前端而不是重复点。',
    )
  }
  if (claimedStale.length > 0) {
    parts.push(
      `${claimedStale.length} 条的认领已经过期（认领的窗口没回报，可能被关掉了），` +
        '它们会被下一个来取的窗口重新认领 —— 这是刻意允许的重复，因为卡住比重复一次更贵。',
    )
  }
  const done = all.filter((t) => t.status === 'done')
  const failed = all.filter((t) => t.status === 'failed')
  if (done.length > 0 || failed.length > 0) parts.push(`已经执行过 ${done.length} 条成功、${failed.length} 条失败。`)
  return parts.join('')
}

// ─────────────────────────── 桌宠的自然语言入口 ───────────────────────────

/**
 * 从一句话里找出要按的那个按钮。
 *
 * ★ 为什么是确定性匹配而不是交给模型挑：
 *   挑按钮 = 决定"系统接下来会动什么"，这属于 `intents.ts` 开头写的
 *   「LLM 可以决定怎么说，不可以决定做什么」。所以这里用打分的确定性规则，
 *   而且 `< 0.6` 一律返回 null 让上层去澄清，不猜。
 *
 * ★ 打分刻意要求**同时**命中页面名与按钮名（或按钮名整段出现）：
 *   只按按钮名匹配的话，「启动」这种两个字的名字会命中一大片 ——
 *   「启动」在总览、系统监控两页都有，而它们现在恰好是同一个东西，
 *   将来却不一定。带页面名就把它钉住了。
 */
/**
 * 解析结果。
 *
 * ★ 刻意不是 `spec | null` 两态而是**四态**，每一档的下一步动作都不一样：
 *   · `action` —— 归界面通道，去点；
 *   · `owned`  —— 听出来了但这句不归我，去找舰队。
 *     压成 `null` 的后果是用户听到"没听懂"，而系统其实听懂了，只是主人不是它（判据 25）；
 *   · `weak`   —— 有候选但没把握，把候选**列出来**问一句。
 *     这一档治的是「按一下启动」这种短名字：两个字，不带页面名时分数过不了门线，
 *     旧实现直接返回 `null` ⇒ 用户得到"没听懂"，而屏幕上明明写着「启动」。
 *     列出来问一句，一次交互就解决了。
 */
export type UiResolution =
  | { kind: 'action'; spec: UiActionSpec; score: number; why: string }
  | { kind: 'owned'; spec: UiActionSpec; plan: string; why: string }
  | { kind: 'human'; spec: UiActionSpec; why: string }
  | { kind: 'weak'; candidates: UiActionSpec[]; why: string }

/** 没把握时仍值得列出来的下限。低于它连"你是不是想说"都不该问（那是瞎猜）。 */
const WEAK_FLOOR = 0.45

/**
 * **明确**的"按下去"动作词。
 *
 * ★ 它比 `resolveUiAction` 里那套宽口径的动作词严格得多，而两者用途完全不同：
 *   · 宽口径（含「帮我 / 看看 / 跑一下」）用在**兜底前**：所有规则都没接住时，
 *     最后问一句"你是不是想按那颗按钮"。这里宁可宽，因为再往后就是模型了。
 *   · 严格口径用在**只读问答之前**：只许在用户**明说"按 / 点"**时才抢。
 *
 * ★ 为什么必须分两档（端到端实测抓出来的）：
 *   「Agent 舰队页按一下这计划能接吗」里的「Agent 舰队」被 `ask_agents` 接走，
 *   「风控中心页跑一次沙盒演练」里的「风控」被 `query_risk` 接走 ——
 *   两句都是**用户要按按钮、却收到一份状态汇报**。
 *   根因是那几条只读规则看到"提到页面 / 领域"就认领，而"按一下"是比"提到"强得多的信号。
 *   但它不能把宽口径那套词也搬上来：那样「帮我看看总览控制台」会被当成按按钮。
 */
export function looksLikeExplicitPress(text: string): boolean {
  return /(按一下|按这|按下|按那个|点一下|点开|点这|点那个|戳一下|跑一次|跑这|执行一下)/.test(text)
}

interface ScoredButton {
  spec: UiActionSpec
  score: number
  why: string
}

/**
 * 按"按钮名（含说法变体）"给所有登记按钮打分。
 *
 * ★ **严格档与宽档共用这一份。** 两份打分迟早会对同一句话选出不同的按钮，
 *   而那正是"同一句话两个主人"（判据 29）最难查的形态：两边都说得通。
 */
function scoreNamedButtons(s: string): ScoredButton[] {
  const scored: ScoredButton[] = []
  for (const a of UI_ACTIONS) {
    // ★ 说法变体也算命中：否则"立即跑一轮"这种真实按钮文案匹配不上，
    //   而用户嘴上说的恰恰是屏幕上那句话。
    const nameHit = s.includes(a.label) || (a.labelAlt ?? []).some((v) => s.includes(v))
    if (!nameHit) continue
    const page = uiPage(a.page)
    const pageHit = page ? s.includes(page.label) || s.includes(page.id) : false
    // ★ 长名字更具体，给更高分：避免「启动」这种短名字抢走「一键启动自治循环」。
    const byLen = Math.min(0.15, a.label.length * 0.015)
    const score = (pageHit ? 0.8 : 0.55) + byLen
    scored.push({
      spec: a,
      score,
      why: `命中按钮「${a.label}」${pageHit ? `，且点名了页面「${page?.label ?? a.page}」` : '（没点名页面）'}`,
    })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored
}

/**
 * 把打分结果折成四态里的某一态。**严格档与宽档共用这一份。**
 *
 * `strict` 只改一件事：没把握时**直接放弃**，而不是列候选问一句。
 * 理由：严格档站在只读问答**之前**，用"你是不是想说"去顶掉一条
 * 本来答得上来的只读回答，是拿一次**答非所问**换一次**反问** —— 不划算。
 */
function decideUiResolution(scored: ScoredButton[], opts: { strict: boolean }): UiResolution | null {
  if (scored.length === 0) return null
  const best = scored[0]!

  // 没把握：宽档列出候选，严格档放弃。
  if (best.score < 0.6) {
    if (opts.strict) return null
    const near = scored.filter((x) => x.score >= WEAK_FLOOR)
    if (near.length === 0) return null
    return {
      kind: 'weak',
      candidates: near.map((x) => x.spec),
      why: `命中「${best.spec.label}」但没点名页面，分数 ${best.score.toFixed(2)} 没过 0.60 门线`,
    }
  }

  // 只许人点的按钮（见 `UiActionSpec.operatorOnly`）：听出来了，但**不代按**。
  if (best.spec.operatorOnly) {
    return {
      kind: 'human',
      spec: best.spec,
      why: `「${best.spec.label}」的后果取决于面板里现在填着什么，而那是我看不见的`,
    }
  }

  // 有专属主人的按钮不认领（见 `UiActionSpec.voicePlan`）：
  // 按下去会让执行发生**两次**（计划链一次、点按钮一次），
  // 而两次都成功、两次都留痕，看日志也发现不了重复。
  if (best.spec.voicePlan) {
    return {
      kind: 'owned',
      spec: best.spec,
      plan: best.spec.voicePlan,
      why: `「${best.spec.label}」在语音侧的主人是舰队计划「${best.spec.voicePlan}」，不是界面按钮通道`,
    }
  }
  return { kind: 'action', spec: best.spec, score: best.score, why: best.why }
}

/**
 * **严格档**：只许在用户**明说"按 / 点 / 跑一次"**时认领一颗具名按钮。
 *
 * 它站在只读问答（`ask_agents` / `query_risk`）**之前**，因为那些规则看到
 * "提到页面 / 领域"就认领 —— 端到端实测：用户说「风控中心页跑一次沙盒演练」，
 * 收到的是一份**风控状态汇报**，而他要做的是**把那个按钮按下去**。
 * "按一下"是比"提到"强得多的信号，所以它有权先挑。
 *
 * ★ 它**不做页面导航**：导航在宽档那一份里。把 nav 也搬上来会让
 *   「打开 Agent 舰队页」在只读问答之前被抢，而"打开某页"本来就不是发布命令。
 *
 * ★ 它比宽档多担一点风险（宽的动词表含「帮我 / 看看」，太容易误伤，
 *   所以宽档只能排在最后）—— 严格档用"必须明说按 / 点"把这个风险抵掉。
 */
export function resolveExplicitPress(text: string): UiResolution | null {
  const s = text.trim()
  if (s.length === 0) return null
  if (!looksLikeExplicitPress(s)) return null
  const scored = scoreNamedButtons(s)
  const best = scored[0]
  if (best) {
    // ★ 疑问句仍然挡 —— 但**先挖掉命中的按钮文案**再判。
    //   因为有的按钮文案本身就是疑问句（屏幕上写着「这计划能接吗」），
    //   用户是**照着屏幕念**的，那不是在提问。
    //   挖掉后还剩疑问标记的才是真提问（「刷新是什么意思」⇒ 剩"是什么意思"，仍被挡下）。
    let residue = s
    for (const name of [best.spec.label, ...(best.spec.labelAlt ?? [])]) residue = residue.split(name).join('')
    if (looksInterrogative(residue)) return null
  } else if (looksInterrogative(s)) {
    return null
  }
  return decideUiResolution(scored, { strict: true })
}

export function resolveUiAction(text: string): UiResolution | null {
  const s = text.trim()
  if (s.length === 0) return null

  // ⓪ **疑问句不是命令**。
  //
  // ★ 这一条是接进语音层之后立刻暴露出来的：`pressVerb` 里有「帮我」，
  //   而「帮我解释一下什么是启动」既有「帮我」又有「启动」（监控页那颗按钮的名字）
  //   ⇒ 会被判成"要按按钮"，于是用户问一句、系统按一下。
  //   这正是本项目最贵的一类错误，`fleet/plans.ts` 里已经有一份判据，
  //   这里**复用**它而不是再写一份（判据只写一份，两份迟早不一致）。
  //
  // ★ 但它排在导航之前：`navVerb` 里的「看看 / 看一下」本身就常出现在提问里
  //   （「总览控制台是干什么的，打开看看」是命令，「系统监控能干什么」是提问），
  //   所以疑问句一律先挡掉。
  if (looksInterrogative(s)) return null

  // ① 页面导航：「打开交易终端」「切到风控中心」「进入新闻雷达」
  const navVerb = /(打开|切到|切换到|进入|跳到|去|看看|看一下|显示)/.test(s)
  if (navVerb) {
    for (const p of UI_PAGES) {
      if (!s.includes(p.label) && !s.includes(p.id)) continue
      // 页面导航用一个**合成 id**：`nav.<page>`。它不是按钮，是"切页"这个动作，
      // 所以不走 `UI_ACTIONS`（那边是按钮表），但同样要能被日志引用、被断言覆盖。
      const spec = navSpec(p.id)
      if (!spec) continue
      return {
        kind: 'action',
        spec,
        score: 0.9,
        why: `「${s}」里有切页动作词，且点名了页面「${p.label}」`,
      }
    }
  }

  // ② 具名按钮：要求"动作词 + 按钮名"。动作词缺了就变成"提到按钮"，
  //    而"提到"不等于"要按" —— 那正是本项目最贵的一类错误（问一句、写一笔）。
  const pressVerb = /(按|点|戳|点一下|按一下|点开|执行|跑一下|来一下|帮我)/.test(s)
  if (!pressVerb) return null

  return decideUiResolution(scoreNamedButtons(s), { strict: false })
}
