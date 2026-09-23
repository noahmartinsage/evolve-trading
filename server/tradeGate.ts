/**
 * 交易闸门 —— 回答**「这笔交易凭什么可以出去」**的唯一事实源。
 *
 * ## 它为什么必须存在
 *
 * 在它出现之前，本项目有**两条下单路径**，而闸门只装在一条上：
 *
 * | 路径 | 发起人 | 过不过 9 道拦截闸门 |
 * |---|---|---|
 * | 自治循环 `autopilot.tryOpenLong()` | 机器 | ✅ 全部 |
 * | 交易大厅 `TerminalPage.submit()` | 人 | ❌ 一道都不过 |
 *
 * 这是判据 8（同一业务动作两条实现路径 = 隐患）最典型的一种形态。
 * 而且它比一般隐患更隐蔽：**两条路径不会同时红**。
 * 机器那条一直在被门禁测（`test:autopilot` / `test:risk-guard`），
 * 人那条从来没有任何测试 —— 于是「人手能下出机器下不出的单」这件事，
 * 在日志与门禁里**一个痕迹都没有**。
 *
 * ## 它不做什么（这条比做什么更重要）
 *
 * 本模块**不重新实现任何检查**：
 *   几何 → `orderRisk.validateQuoteGeometry`
 *   闸门 → `interceptors.runPipeline`
 *   成本 → `costModel.assessEdge`
 *   审批 → `approvalGate.requiresApproval`
 *   敞口 → `riskReservation`
 *
 * 如果这里出现了第二份检查逻辑，那这个模块就从「解法」变成了「新的病」：
 * 两份检查一定会漂移，而漂移之后**看起来更严的那份不一定是生效的那份**。
 *
 * ## 四态而不是三态、也不是两态
 *
 * | 裁决 | 指向的下一步动作 |
 * |---|---|
 * | `pass` | 提交 |
 * | `blocked` | **改报价**（这笔本身不合格：赔率、趋势、置信度…） |
 * | `approval_required` | **去找人**（合规上要人工批，不是单子有问题） |
 * | `unverifiable` | **先修数据源**（查不了 ⇒ 不放行，但和"被拒绝"不是一回事） |
 *
 * ★ 把 `blocked` 与 `unverifiable` 合成一个「失败」是这里最容易犯的错：
 * 前者让人去改止盈价，后者让人去查行情连接 —— **指向相反的动作**。
 * 判据 25：拒绝三态互不顶替；判据 13 的同族。
 */

import { checkCooldown, computeStopGeometry, listPositions } from './positionGuard.ts'
// ★ 预测层是**只读**的，而且它**不反向依赖**本模块（`forecast-smoke` 的 D3
//   有一条断言钉着 forecastService 的源码里不许出现 `tradeGate`）——
//   所以这个引用是单向的，不会长出"预测自己下单"那条第二路径。
import { describeForecastGate, forecast, plainText, proposeForecastOrder, resolveHorizon } from './forecastService.ts'
import type { ForecastOrderProposal, ForecastOutcome, ForecastResult } from './forecastService.ts'
import {
  listInterceptors,
  runPipeline,
  type InterceptorContext,
  type MacroTrend,
  type MarketPackage,
  type PipelineResult,
  type TradeDecision,
} from './interceptors.ts'
import { validateQuoteGeometry, type GeometryCheck } from './orderRisk.ts'
import { assessEdge, liveCexCostInput, type CostInput, type EdgeAssessment } from './costModel.ts'
import { requiresApproval, type ApprovalEnvironment } from './approvalGate.ts'
import type { RegimeSnapshot } from './marketRegime.ts'
import { deriveStructureTarget } from './marketRegime.ts'
import { ATR_PERIOD, MIN_ENTRY_CONFIDENCE } from './riskConstants.ts'
// ★ 裸单安全判据的唯一主人（见 `nakedProtectionLeg()` 的说明）。
import { judgeLeverage } from './voice/leverageGuard.ts'

// ─────────────────────────────────────────────────────────────
// 第一部分：闸门输入的唯一构造处
// ─────────────────────────────────────────────────────────────

/**
 * 构造「决策时刻的市场特征包」。
 *
 * ★ 抽出来的理由：这段构造原先内联在 `autopilot.tryOpenLong()` 里。
 *   交易大厅要用同一套语义时，只有两个选择 —— 抄一份，或者抽出来。
 *   抄一份的后果不是"多几行代码"，而是**同一个 `dataQuality` 判定会有两种写法**，
 *   然后某一次改动只更新了其中一份：自治循环拒绝开仓、交易大厅照常放行，
 *   而两边读的都是"同一份行情"。
 */
export interface MarketSnapshotInput {
  symbol: string
  price: number
  /** 止损几何的尺子（1H ATR）。不可用时传 0 —— 由调用方决定这算不算「查不了」。 */
  atr: number
  bars: number
  dataQuality: 'valid' | 'stale' | 'insufficient'
  adx1h?: number
  macroTrend?: MacroTrend
  macroTrendSource?: string
}

export function buildMarketPackage(m: MarketSnapshotInput): MarketPackage {
  return {
    symbol: m.symbol,
    dataQuality: m.dataQuality,
    price: m.price,
    atr: m.atr,
    bars: m.bars,
    adx1h: m.adx1h,
    // 高周期趋势不可用时判 RANGE 而不是「猜一个方向」：
    // 猜错会让 `filter.macro_trend` 用一条不存在的趋势去拦截真实机会。
    macroTrend: m.macroTrend ?? 'RANGE',
    macroTrendSource: m.macroTrendSource ?? '高周期趋势不可用',
  }
}

export interface GuardContextInput {
  symbol: string
  /** 打算开的方向。冷静期是**按方向**记的（多空各有一段），所以必须传对。 */
  side: 'long' | 'short'
  now: number
  equity: number
  killswitch: boolean
  dailyLoss?: number
  dailyLossLimit?: number
}

/**
 * 构造拦截器的「守护上下文」。
 *
 * ★ 传**全部**守护持仓，而不是只传本标的：
 *   `core.position_conflict` 自己按 `symbol` 过滤，多传无害；
 *   而少传一条会让「已有反向持仓」这道**强制地板**在某些标的上形同虚设 ——
 *   它在 pkg.symbol 与持仓 symbol 不一致时会静默判定为"没有冲突"。
 *   这是本模块抽出时顺手修掉的一个真实缺口（原先只传了自治循环自己那一个标的）。
 */
export function buildInterceptorContext(g: GuardContextInput): InterceptorContext {
  const cooldown = checkCooldown(g.symbol, g.side, g.now)
  return {
    now: g.now,
    equity: g.equity,
    killswitch: g.killswitch,
    openPositions: listPositions().map((p) => ({ symbol: p.symbol, side: p.side })),
    cooldownBlocked: cooldown.blocked,
    cooldownReason: cooldown.reason,
    dailyLoss: g.dailyLoss,
    dailyLossLimit: g.dailyLossLimit,
  }
}

// ─────────────────────────────────────────────────────────────
// 第二部分：合成裁决
// ─────────────────────────────────────────────────────────────

/**
 * ★ 四态。**不要把它压成布尔之后再拿布尔去归因** ——
 * 那正是判据 13 说的「分不清『能力没有』『额度用完』『名字烂了』『本机网络』」的形状。
 */
export type PrecheckVerdict = 'pass' | 'blocked' | 'approval_required' | 'unverifiable'

export interface GateLeg {
  /** 稳定标识，供界面对位与日志归因（例 `pipeline.core.cooldown`）。 */
  id: string
  name: string
  passed: boolean
  /** 中文完整句 —— 它会直接显示给操作者。本项目禁用缩写式拒绝理由。 */
  detail: string
  code?: string
  /**
   * ★★ **这道门这次没查** —— 既不是"通过"，也不是"不合格"。
   *
   * ── 为什么必须是第三种状态，而不是二选一 ──────────────────────────
   * 只有两种状态时，一个查不了的门只有两条出路，而**两条都是错的**：
   *   · 记成 `passed: true`  ⇒ 灰区伪装成绿灯。用户看到一个勾，
   *     以为"盈亏比查过了、没问题"，而实际上没有任何东西被检查过。
   *   · 记成 `passed: false` ⇒ 伪装成不合格。用户会去改止盈价 ——
   *     而这道门压根没跑，改到什么时候都不会让它变绿。
   * ⇒ 判据 C4（"检查扫到哪就停了？"）与红线「灰区（未验证）必须配观测点」的落法：
   *   `notChecked` 的腿**进 `legs`、不进 `blockers`**，且**永远不能**被算成通过。
   *
   * ★ 目前唯一的产出者是裸单通道（用户**显式**放弃保护价 ⇒ 没有 R:R 可算）。
   *   它由 `protectionWaived === true` 才会出现，**不会**由"参数缺失"顺带产生 ——
   *   静默缺保护走的是 `unverifiable`，不是这里。
   */
  notChecked?: boolean
}

/**
 * ★ 这些 code 表示「**查不了**」而不是「**不合格**」。
 *
 * 区别是动作：行情不完整时，把止盈价改到 3:1 也没用（改报价改不好数据源）；
 * 而赔率不足时，去查行情连接也没用。
 * 分组只在这里维护一份，`verdict` 由它派生。
 */
const UNVERIFIABLE_CODES = new Set([
  'DATA_QUALITY', // 行情不完整/过期
  'GEOMETRY_MISSING', // 三价没给全 —— 无从校验几何
  // ★ 预测腿的两条。它们与「预测看反了」是**相反的动作**：
  //   看反了 ⇒ 别做这笔；查不了 ⇒ 去修数据/攒样本，然后**再看一次**。
  //   混成一个 code 会把后者读成前者，于是用户永远不知道"再等等就会有答案"。
  'FORECAST_MISSING', // 声称以预测为依据，却没给预测结论
  'FORECAST_UNVERIFIABLE', // 预测自己说"判不了"
])

/**
 * 本笔单与**走势预测**的关系。
 *
 * ★ 为什么是一个"声明"而不是强制每笔单都带预测：预测层是**若干个预测器之一**
 *   （策略单有自己的样本外证据、走的是 `walkForward`；人工单有自己的判断）。
 *   把预测做成"每笔单都必须通过的前置门"，等于宣称**只有模拟近邻法有权批准交易** ——
 *   而它现在的实测结论恰恰是 `no-edge`，那会让整个系统一单都发不出去。
 *   那不是"稳健"，那是把一道闸门的作用域搞错了。
 *
 * ★ 所以这道腿守的是一件具体得多的事：**当一笔单声称"我是按走势预测下的"，
 *   系统去核这句话是否成立**。这正是本仓库 `claimValidator` 那一族
 *   （自报的东西不许当凭据）。它有牙的地方在于：宣称之后
 *   `no-edge` 会**当场拒**，缺预测会**当场报查不了** —— 而不是被静默放过。
 */
export interface ForecastClaim {
  /** 这笔单是不是**以走势预测为依据**下的。缺省 `false`（绝大多数字都不来自预测层）。 */
  claims: boolean
  /**
   * 依据的那次预测结论。
   *
   * ★ 生产路径上它由**服务端现算**（`precheckLiveTrade` 自己去调预测层），
   *   不许由调用方塞进来 —— 调用方给什么就是什么，那等于凭据可以自己开。
   *   纯函数这一层接受注入，只是为了烟测能把三态都造出来（门要可注入才好断言）。
   */
  result: ForecastResult | null
}

export interface ExposureSnapshot {
  /** 台账口径的现有组合总敞口（USDT，仅未释放的）。 */
  grossUsdt: number
  /** 组合层上限。null = 未设置（不构成约束）。 */
  limitUsdt: number | null
  /** 未释放的预留条数 —— 含 `unknown`/`pending_cleanup` 这类「本地丢了但场所可能有」的记录。 */
  unreleasedCount: number
}

export interface PrecheckInput {
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  entry: number
  takeProfit: number
  stopLoss: number
  /**
   * 信号置信度（%）。缺省按全局基准门禁计入，并**在 `assumptions` 里说出来**。
   * 刻意不给一个"100=必然通过"的默认值：那会把置信度闸门悄悄摘掉，
   * 而界面上看起来它还在。
   */
  confidence?: number
  environment: ApprovalEnvironment
  /**
   * 成本口径：`cex` 走 `liveCexCostInput`（费率+滑点同源假设）；
   * `dex` 需要池深，本版**未接入** ⇒ 如实返回 `unverifiable`，不静默放行。
   */
  channel: 'cex' | 'dex'
  venue?: string
  /** 预期毛收益（bps）。缺省由止盈距离推算，并在 `assumptions` 里说明口径。 */
  expectedEdgeBps?: number
  holdingHours?: number
  /** 由 `buildMarketPackage()` 造。 */
  pkg: MarketPackage
  /** 由 `buildInterceptorContext()` 造。 */
  ctx: InterceptorContext
  /** 台账口径敞口。刻意由调用方注入 —— 纯函数才好断言，也才能在烟测里造边界。 */
  exposure: ExposureSnapshot
  /**
   * 走势预测的声明（见 `ForecastClaim`）。缺省 = 不以下单依据是预测。
   * ★ 它与 `expectedEdgeBps` 的区别：后者是"这笔单**预期**赚多少"（一个假设），
   *   前者是"这笔单**凭什么**这么想"（一个依据）。两者都要有，但只能有一个来源。
   */
  forecastClaim?: ForecastClaim
  /**
   * ★★ 用户**显式放弃**保护价（"裸单"）。
   *
   * ── 它与"字段忘了填"是两个完全相反的东西 ──────────────────────────
   * 字段没填 ⇒ `unverifiable` + `pipeline 0/9`：系统**不知道**该按什么标准评这笔单，
   *   所以一道门都不跑、不放行。下一步动作是"去把保护填上"。
   * 显式放弃 ⇒ 系统**知道**该按什么标准评：裸单唯一的安全问题是
   *   **强平会不会先于任何退出到来**。下一步动作是"接受这笔单唯一的价格保护是强平"。
   *
   * ★ 为什么必须由调用方显式给、且缺省 `false`：
   *   若把"没给保护价"自动读成"用户不要保护"，那么**任何一次上游忘了填**
   *   （例如语音解析漏了、界面表单没提交）都会静默降级成裸单放行 ——
   *   那是把"缺输入"变成一个更弱的规则。凭据只能由**用户的明确表态**产生。
   */
  protectionWaived?: boolean
  /**
   * 生效杠杆（**已被 `judgeLeverage` 裁决过的那个数**）。裸单判据要用它算强平距离。
   *
   * ★ 与 `markPrice` 同一处置：闸门自己观测不到杠杆，所以由调用方交进来 ——
   *   但交进来的是**原始量**（一个倍数），闸门**自己现算结论**（强平距离够不够远）。
   *   若这里收的是"裸单安全不安全"这种结论字段，那伪造它就能把闸门打开。
   */
  leverage?: number
  /** 品种形态。裸单几何只在合约（`SWAP`）上有意义 —— 现货没有强平。 */
  instType?: 'SPOT' | 'SWAP'
}

export interface PrecheckResult {
  verdict: PrecheckVerdict
  /**
   * 能不能直接提交。**只有 `pass` 是 true**。
   * ★ 这个布尔是给按钮用的，**不是给归因用的** —— 归因请看 `verdict`。
   */
  submitAllowed: boolean
  /** 一句话结论（中文完整句），可直接显示。 */
  summary: string
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  /** 全部闸门腿（含通过的）。★ 只到"拦截发生的那一道"为止 —— 见 `pipeline`。 */
  legs: GateLeg[]
  /** 未通过的腿（`legs` 的子集）—— 界面上折叠展示用。 */
  blockers: GateLeg[]
  /**
   * 管线这一次**扫到哪就停了**。
   *
   * ★ 必须有这个字段：`runPipeline` 在第一道不通过时就返回，`trail` 只到那里为止。
   *   于是「闸门全部通过」和「第 2 道就停了」在界面上都表现为"没有更多腿"。
   *   没有 `checked/total`，一个在第 2 道被拦的裁决会看起来像是"检查了很多项"。
   *   （判据 11：检查扫到哪就停了 —— 报 0 ≠ 没错。）
   */
  pipeline: { checked: number; total: number; blockedBy: string | null; reachedGeometry: boolean }
  approval: { required: boolean; reason: string }
  /**
   * 成本裁决。**未评估时是 `null`，不是零值对象**。
   * 造一个 `verdict:'UNVERIFIABLE'` 的假对象会往 `EdgeVerdict` 里塞一个它不认识的档位，
   * 于是下游任何 `switch` 都会走 default 分支 —— 而 default 分支的措辞恰好又像"通过"。
   * `null` 表达「没算」是唯一不会说谎的表示法（红线 ⑱：`null` 不许退化成 0）。
   */
  cost: EdgeAssessment | null
  /**
   * 几何校验结果。★ 与闸门里的 `core.quote_geometry_rr` 是**同一次调用**的结果
   * （`runPipeline` 内部调的就是同一个 `validateQuoteGeometry`）——
   * 这里带出来只是为了让界面能显示 R:R 这个数字。
   * 烟测里有一条断言钉死「两者必须一致」，防止它将来变成第二份口径。
   * 同样：未评估时为 `null`。
   */
  geometry: GeometryCheck | null
  exposure: {
    grossBeforeUsdt: number
    thisOrderUsdt: number
    grossAfterUsdt: number
    limitUsdt: number | null
    unreleasedCount: number
    overLimit: boolean
  }
  /**
   * 预测层在这一笔里的实际角色。
   *
   * ★ 必须有这个字段，否则"预测没参与"与"预测参与了但通过了"在界面上长得一样 ——
   *   而用户以为自己看到的是后者的次数会非常多（判据 11：报 0 ≠ 没错）。
   */
  forecast: {
    /** 这笔单有没有声称以预测为依据。 */
    claims: boolean
    /** 参与的那次预测的三态判决（没参与时是 null）。 */
    outcome: ForecastOutcome | null
    gate: string | null
    direction: 'up' | 'down' | null
    target: number | null
    /** 拿去下单的提案。判决不是 `actionable` 时 `ok:false` 并带原因。 */
    proposal: ForecastOrderProposal | null
  }
  market: {
    price: number
    atr: number
    adx1h?: number
    macroTrend: MacroTrend
    macroTrendSource: string
    dataQuality: MarketPackage['dataQuality']
    /**
     * 行情快照的采集时刻与陈旧标记。
     * ★ 必须带出来：`refreshRegime` 命中 5 分钟 TTL 缓存时不会重新取数，
     *   于是「闸门刚刚拒绝了你」这句话背后可能是一份几分钟前的行情。
     *   不显示它，操作者会以为闸门看的是当下的盘口。
     *   （`precision/regime` 的经典坑：regime 是 TTL 滚动缓存，不落盘则复盘时
     *   读到的是当下的市场，不是决策时的市场。）
     */
    snapshotAt: number | null
    stale: boolean | null
  }
  confidenceUsed: number
  /**
   * 引擎口径的止损/止盈建议。
   *
   * ★ 必须**由服务端算**。交易大厅原先的默认值是硬编码的 `price×1.03` / `price×0.97`，
   *   而引擎的止损几何是 `ATR × 1.8~2.2`，并夹在 `1.8%~3%` 的安全带里 ——
   *   **同一个事实的两份口径**。两份都在"正常工作"，于是没人会发现它们不一致：
   *   面板显示 3%，引擎按 ATR 算出来的可能是 1.9%，而下单时用的是面板那个。
   *
   * 纯函数层产不出它（需要高周期结构位）⇒ 那里是 `null`，由活体外壳填。
   */
  suggested: {
    stopLoss: number
    takeProfit: number
    stopDistance: number
    stopPct: number
    atrMultiplier: number
    /** 止损距离的依据（ATR 倍数 + 安全带夹取结果）。 */
    stopBasis: string
    /** 止盈价的依据（结构阻力位，还是等距测幅外推）。 */
    targetBasis: string
  } | null
  /**
   * ★ 本次裁决里**被显式声明**的假设。空数组 = 全部数值都是调用方给定的。
   *
   * 为什么要有这个字段：缺省值是这个模块最危险的东西。
   * 「按基准置信度计入」「按止盈距离推算毛收益」都会让一个**本不完整的输入**
   * 产出一个看起来完整的裁决。不说出来，操作者会以为闸门评估了他给的全部信息。
   * （判据 24：缺数据要说出来，而且要在**每一处**说。）
   */
  assumptions: string[]
  /**
   * ★ 本次裁决**已知覆盖不到的范围**。与 `assumptions` 是两件事：
   *   `assumptions` = 「这个数是我替你补的」
   *   `disclosures` = 「这一块我根本没在看」
   *
   * 后者更危险：一个绿色的裁决会让人以为它管住了全部风险。
   * 说不出来的缺口就是静默缺口（判据 24：缺数据要说出来，而且要在每一处说）。
   */
  disclosures: string[]
}

/** 把闸门 trail 摊平成腿。id 加前缀，避免与其它腿撞名。 */
function pipelineLegs(p: PipelineResult): GateLeg[] {
  return p.trail.map((t) => ({
    id: `pipeline.${t.id}`,
    name: t.name,
    passed: t.passed,
    detail: t.passed ? `通过（${t.name}）` : (t.reason ?? '未通过（未给出理由）'),
    code: t.code,
  }))
}

/**
 * 「根本没跑」时的管线摘要。
 *
 * ★ `checked: 0` 配 `total: 启用的闸门数` —— 而不是 `0/0`。
 *   `0/0` 会被读成"没有闸门"，`0/9` 才是"九道一道都没跑"，
 *   而这两句话指向完全不同的动作。
 */
function notRunPipeline(): PrecheckResult['pipeline'] {
  return {
    checked: 0,
    total: listInterceptors().filter((i) => i.enabled).length,
    blockedBy: null,
    reachedGeometry: false,
  }
}

function pipelineOf(p: PipelineResult): PrecheckResult['pipeline'] {
  return {
    checked: p.checked,
    total: p.total,
    blockedBy: p.blockedBy ?? null,
    // 几何闸门（order 50）只有在前 4 道都通过时才会被走到。
    // 界面上「R:R = 2.6，合法」这句话在前 4 道就挂了的时候是不成立的 ——
    // 所以"走没走到"必须和"结论是什么"分开报。
    //
    // ★ 2026-09-23 收紧：**走到 ≠ 算出来了**。裸单（显式放弃保护）时这道门确实被
    //   走到，但它报的是 `RR_NOT_CHECKED` —— 没有三价就没有 R:R 可算，
    //   此时报 `reachedGeometry: true` 会让界面在 `geometry === null` 的旁边
    //   显示一句"几何走到了"，读起来像"几何查过了"。
    //   （`GEOMETRY_MISSING` 同样排除：那条路是"该跑却缺输入"，也没算出东西。）
    reachedGeometry: p.trail.some(
      (t) => t.id === 'core.quote_geometry_rr' && t.code !== 'GEOMETRY_MISSING' && t.code !== 'RR_NOT_CHECKED',
    ),
  }
}

export function precheckTrade(input: PrecheckInput): PrecheckResult {
  const assumptions: string[] = []
  const action: 'BUY_LONG' | 'SELL_SHORT' = input.side === 'buy' ? 'BUY_LONG' : 'SELL_SHORT'

  // ── 缺省值：每一个都必须留下痕迹 ──
  const confidence = input.confidence ?? MIN_ENTRY_CONFIDENCE
  if (input.confidence === undefined) {
    assumptions.push(
      `未提供信号置信度，按全局基准门禁 ${MIN_ENTRY_CONFIDENCE}% 计入（人工下单没有独立于策略的信号置信度）`,
    )
  }
  const edgeBps =
    input.expectedEdgeBps ?? (input.entry > 0 ? (Math.abs(input.takeProfit - input.entry) / input.entry) * 10_000 : 0)
  if (input.expectedEdgeBps === undefined) {
    assumptions.push(
      `预期毛收益按「止盈价到入场价的距离」推算为 ${edgeBps.toFixed(1)} bps —— ` +
        '这是**假设止盈成交**的口径，成本闸门只在这个假设下判断成本占比是否可接受',
    )
  }

  const market = {
    price: input.pkg.price,
    atr: input.pkg.atr,
    adx1h: input.pkg.adx1h,
    macroTrend: input.pkg.macroTrend,
    macroTrendSource: input.pkg.macroTrendSource,
    dataQuality: input.pkg.dataQuality,
    // 纯函数这一层不知道快照时刻；活体外壳 `precheckLiveTrade()` 会填上真实值。
    snapshotAt: null,
    stale: null,
  }

  const base = {
    symbol: input.symbol,
    side: input.side,
    notionalUsdt: input.notionalUsdt,
    confidenceUsed: confidence,
    market,
    assumptions,
    // 纯函数这一层只看得见喂进来的东西，所以它**不许**声称知道覆盖范围之外的事；
    // 已知缺口由活体外壳 `precheckLiveTrade()` 填入。
    disclosures: [] as string[],
    // 建议价需要高周期结构位，纯函数层没有 ⇒ null（由活体外壳填）。
    suggested: null as PrecheckResult['suggested'],
    forecast: forecastView(input),
  }

  // ── ⓪ 先判「能不能评」：不能评就不要产出一个像结论的东西 ──
  //
  // ★ 这一段的形状取决于 `protectionWaived`，而**豁免只有在保护真的缺席时才生效**。
  //   若调用方既声明了"放弃保护"、又给了止盈止损 —— 那就有保护可评，不该豁免：
  //   把它读成豁免会产出一句"这笔单没有止盈止损价"的**假话**（那个数就在单子上），
  //   并且顺手把一道本可以查的门标成"未查"。缺什么说什么，多什么也别抹掉。
  const hasProtection = Number.isFinite(input.takeProfit) && input.takeProfit > 0 && Number.isFinite(input.stopLoss) && input.stopLoss > 0
  const waived = input.protectionWaived === true && !hasProtection
  // ★★ 裸单要落一条 `disclosures`（界面上以"本次检查覆盖不到：…"显示）。
  //   判据 D7：这句话把用户引向"我接受了什么"。只写在 `summary` 里不够 ——
  //   `summary` 会随裁决好坏换措辞，而"这次哪一块没覆盖到"是**不随裁决变**的事实，
  //   必须住在那个专门放这件事的地方（`disclosures`），否则界面在
  //   `approval_required` 或 `blocked` 时就再也不提这笔单没有保护了。
  if (waived) {
    base.disclosures.push(
      '「真实盈亏比门禁」**这次没查** —— 这笔单没有止盈价与止损价（用户显式放弃保护），' +
        '唯一的价格保护是强平距离，它由「裸单的强平距离」那条腿单独验过',
    )
  }
  if (input.protectionWaived === true && hasProtection) {
    base.disclosures.push(
      '调用方声明了"放弃保护价"，但同时也给了止盈价与止损价 ⇒ 按**有保护**评估：' +
        '那道盈亏比门禁照常跑了。这条声明因此没有生效，不是"保护被忽略"',
    )
  }
  const cannotEvaluate: string[] = []
  if (!(input.notionalUsdt > 0)) cannotEvaluate.push('名义本金必须大于 0')
  // ★「没填全」与「填了但赔率不够」是两件事：
  //   前者去把表单补完，后者去改报价。混成一种会让空表单收到一句"你的盈亏比不足" ——
  //   而那时候根本还没有盈亏比。
  //
  // ★ 入场价**两条路都要**（裸单也要）：它是强平距离的基准，也是"这笔单多大"的分母。
  //   而止盈/止损只在**没豁免**时才是必填 —— 豁免是用户显式给的，见 `protectionWaived`。
  if (!(input.entry > 0)) {
    cannotEvaluate.push(
      waived
        ? '裸单也要有入场价，没有它算不出强平距离'
        : '入场价/止盈价/止损价必须都填写为大于 0 的数值',
    )
  } else if (!waived && !hasProtection) {
    cannotEvaluate.push('入场价/止盈价/止损价必须都填写为大于 0 的数值')
  }
  // ★ 裸单的合约单必须知道**生效杠杆**，否则那道"强平距离够不够远"根本算不出来。
  //   不许拿"缺杠杆就按 1 倍算"顶替：1 倍的强平距离是 Infinity，
  //   于是**任何**漏传杠杆的合约裸单都会拿到一个绿色的强平检查 —— 一道自动开门的门。
  if (waived && input.instType === 'SWAP' && !(Number.isFinite(input.leverage) && (input.leverage ?? 0) > 0)) {
    cannotEvaluate.push('裸单的合约单必须先有生效杠杆（倍数），否则算不出强平距离')
  }
  if (input.channel === 'dex') {
    cannotEvaluate.push('DEX 通道的预检尚未接入（需要池深口径才能算价格冲击）')
  }

  if (cannotEvaluate.length > 0) {
    const legs: GateLeg[] = [
      { id: 'input', name: '可评估性', passed: false, detail: cannotEvaluate.join('；'), code: 'INPUT_INCOMPLETE' },
    ]
    return {
      verdict: 'unverifiable',
      submitAllowed: false,
      summary: `无法评估这笔交易：${cannotEvaluate.join('；')}。**这不是被拒绝，是查不了** —— 不放行。`,
      legs,
      blockers: legs,
      approval: { required: false, reason: '未评估' },
      cost: null,
      geometry: null,
      pipeline: notRunPipeline(),
      exposure: exposureOf(input.exposure, input.notionalUsdt, false),
      ...base,
    }
  }

  // ── ① 闸门管线（唯一入口 `runPipeline`，与自治循环同一条）──
  //
  // ★★ 裸单走**同一条管线**，而不是另起一条"裸单专用检查表"（红线㉙）。
  //   唯一差别是**喂进去的决策本身**：没有止盈止损价，就把它们**留空**，
  //   于是「真实盈亏比门禁」会如实返回 `GEOMETRY_MISSING`（"缺三价之一"）。
  //
  //   ★ 这里曾经有一个更"顺手"的写法：拿引擎的建议价当保护补上再判一遍。
  //     **那条路是错的**，而且错得隐蔽 —— 那一次裁决评的是"建议保护版"的那笔单，
  //     而**真正出网的是裸单**。裁决与执行成了两个东西（判据 B2 / 红线⑯）。
  //     现在的处置是：留空 ⇒ 那道门报"没查"，由 `notChecked` 如实标出来。
  const decision: TradeDecision = waived
    ? { action, confidence, entryPrice: input.entry, protectionWaived: true }
    : { action, confidence, entryPrice: input.entry, takeProfitPrice: input.takeProfit, stopLossPrice: input.stopLoss }
  const pipeline = runPipeline(input.pkg, decision, input.ctx)
  const legs: GateLeg[] = pipelineLegs(pipeline)

  // ── ①b 裸单：把那条"没查"的盈亏比腿**改名成它真实的样子** ──────────
  //
  // ★ 为什么必须改名而不能就这么留着：`pipelineLegs` 产出的那条腿叫
  //   「真实盈亏比门禁」，`detail` 是"通过（真实盈亏比门禁）"。
  //   留着它会有两个后果：
  //     ① 名字与事实不符：`passed: true` 让它在任何按"过/不过"读的地方
  //        都变成一道**绿色的、其实没查过的门**（红线：灰区必须配观测点）；
  //     ② 它会作为一条通过的腿留在 `legs` 里，事后无法从裁决里回答
  //        "这次到底有几道门真的被查了"（判据 C4）。
  //   ⇒ 换成一条 id/名字/code 都说清"这道门这次没查"的腿（`notChecked: true`）。
  if (waived) {
    const idx = legs.findIndex((l) => l.id === 'pipeline.core.quote_geometry_rr')
    if (idx >= 0 && legs[idx].code === 'RR_NOT_CHECKED') {
      legs[idx] = {
        id: 'naked.reward_risk',
        name: '真实盈亏比门禁',
        passed: false,
        notChecked: true,
        code: 'RR_NOT_CHECKED',
        detail:
          '这道门**这次没查**：这笔单没有止盈价与止损价，算不出盈亏比。' +
          '不是"赔率不合格"（那要去改报价），也不是"通过了"——它没有参与这次放行。',
      }
    }
  }

  // ── ② 成本腿（不在管线里 —— 管线管的是"这个信号能不能动"，成本管的是"这笔值不值得动"）──
  const costInput: CostInput =
    input.channel === 'cex'
      ? liveCexCostInput({
          venue: input.venue ?? 'binance',
          notionalUsdt: input.notionalUsdt,
          expectedEdgeBps: edgeBps,
          holdingHours: input.holdingHours,
        })
      : {
          channel: 'dex',
          venue: input.venue ?? 'uniswap-v3',
          notionalUsdt: input.notionalUsdt,
          expectedEdgeBps: edgeBps,
          holdingHours: input.holdingHours,
        }
  const cost = assessEdge(costInput)
  legs.push({
    id: 'cost.edge',
    name: '成本吃掉多少边际',
    passed: cost.ok,
    detail: cost.reason,
    code: cost.ok ? undefined : `COST_${cost.verdict}`,
  })

  // ── ③ 敞口腿：本笔加上去会不会越组合上限 ──
  const grossAfter = input.exposure.grossUsdt + input.notionalUsdt
  const overLimit = input.exposure.limitUsdt !== null && grossAfter > input.exposure.limitUsdt
  legs.push({
    id: 'exposure.portfolio',
    name: '组合敞口上限',
    passed: !overLimit,
    detail:
      input.exposure.limitUsdt === null
        ? `组合上限未设置，本笔不因此被拦（现有未释放敞口 ${input.exposure.grossUsdt.toFixed(2)} USDT，本笔 ${input.notionalUsdt.toFixed(2)} USDT）`
        : overLimit
          ? `组合敞口越界：现有 ${input.exposure.grossUsdt.toFixed(2)} + 本笔 ${input.notionalUsdt.toFixed(2)} = ${grossAfter.toFixed(2)} USDT，超过上限 ${input.exposure.limitUsdt.toFixed(2)} USDT`
          : `组合敞口 ${grossAfter.toFixed(2)} / 上限 ${input.exposure.limitUsdt.toFixed(2)} USDT`,
    code: overLimit ? 'EXPOSURE_LIMIT' : undefined,
  })

  // ── ④ 预测腿：**声明校验**，不是"方向必须与预测一致" ──
  //
  // ★ 它守的是一件具体的事：当这笔单声称"我是按走势预测下的"，
  //   系统去核这句话是否成立。没声称就**不构成拦截** —— 但那条腿会
  //   明说"预测没参与这笔决策"，而不是安静地显示一个绿勾。
  //
  // ★ 为什么 `no-edge` 是**拒**（blocked）而不是放行：
  //   用户说"按预测买"，而这个预测器的样本外命中率与"永远猜训练段方向"
  //   分不开（实测 z=0.60）。这时候放行 = 系统明知依据是噪声还照办。
  //   拒的理由会逐字说清"这是没有统计优势，不是预测看跌" ——
  //   因为它俩指向的动作完全不同（一个换方法/攒数据，一个改方向）。
  legs.push(forecastLeg(input))

  // ── ④b 裸单腿：这笔单**唯一的价格保护**是强平距离，它够远吗 ──────────
  //
  // ★ 只有显式豁免才走这里。静默缺保护在 ⓪ 就被 `unverifiable` 挡住了，
  //   根本走不到这一行 —— 这条腿的存在**不允许**变成"缺保护也能被评"的后门。
  if (waived) legs.push(nakedProtectionLeg(input))

  // ── ⑤ 规则义务（审批）：**不是**「单子有问题」，是「要走流程」 ──
  const need = requiresApproval('live_order', input.environment, input.notionalUsdt)

  // ── ⑥ 几何：与闸门内部同一次调用的结果，带出来只为显示 R:R ──
  // ★ 裸单**没有** R:R 可显示 ⇒ `null`（不是 0，也不是一个用 0 价算出来的鬼值）。
  //   红线㉟：`null` 表示"没有这项数据"，界面显示 `—`；退化成 0 会被读成"赔率极差"。
  const geometry = waived
    ? null
    : validateQuoteGeometry({
        action,
        entry: input.entry,
        takeProfit: input.takeProfit,
        stopLoss: input.stopLoss,
      })

  // ★★ `notChecked` 的腿**不进 blockers**：它不是拦截项，是"这次没查"的观测点。
  //   把它算成拦截会让一笔被用户明确接受的裸单收到一句它没犯的错（判据 A1）。
  //   反过来，它也**不算通过** —— 它只是留在 `legs` 里，谁看都能看见。
  const blockers = legs.filter((l) => !l.passed && l.notChecked !== true)
  const notCheckedLegs = legs.filter((l) => l.notChecked === true)
  const exposure = exposureOf(input.exposure, input.notionalUsdt, overLimit)

  if (blockers.length > 0) {
    // ★ 「查不了」优先于「不合格」：如果有一腿是查不了，那么把它报成"不合格"
    //   会让人去改报价 —— 而真正该做的是修数据源。这不是严重程度排序，是动作排序。
    const unverifiable = blockers.some((b) => b.code !== undefined && UNVERIFIABLE_CODES.has(b.code))
    const verdict: PrecheckVerdict = unverifiable ? 'unverifiable' : 'blocked'
    return {
      verdict,
      submitAllowed: false,
      summary:
        verdict === 'unverifiable'
          ? `无法评估这笔交易：${blockers[0].detail}。**这不是被拒绝，是查不了** —— 不放行。`
          : `这笔交易被闸门拒绝（${blockers[0].name}）：${blockers[0].detail}`,
      legs,
      blockers,
      pipeline: pipelineOf(pipeline),
      approval: { required: need.required, reason: need.reason },
      cost,
      geometry,
      exposure,
      ...base,
    }
  }

  // ── 「全部通过」这句话在有一道门没查时**不能说** ────────────────────
  // ★ 判据 D7：这句话把用户引向"可以提交"。而九道门里有几道其实没跑过，
  //   那就必须当场说出来 —— 否则"未查"被这句总结吞掉，
  //   用户在界面上再也看不到自己放弃保护带来的那部分风险。
  // ★ 这里只放**短语**，不放那条腿的完整 `detail`：`summary` 会直接被念出来，
  //   塞进一整段解释会让这句话变成一段独白（它的完整说明在 `legs` 里，一直可见）。
  const waivedNote = waived ? '（这笔单没有止盈止损价，唯一的价格保护是强平距离）' : ''
  const notCheckedNote =
    notCheckedLegs.length > 0 ? `；其中「${notCheckedLegs.map((l) => l.name).join('、')}」**未查**${waivedNote}` : ''

  if (need.required) {
    return {
      verdict: 'approval_required',
      submitAllowed: false,
      summary: `闸门通过（${pipeline.checked}/${pipeline.total}）${notCheckedNote}，但这笔需要人工审批：${need.reason}`,
      legs,
      blockers,
      pipeline: pipelineOf(pipeline),
      approval: { required: true, reason: need.reason },
      cost,
      geometry,
      exposure,
      ...base,
    }
  }

  return {
    verdict: 'pass',
    submitAllowed: true,
    summary: `闸门通过（${pipeline.checked}/${pipeline.total}）${notCheckedNote}，成本与敞口均在界内，可以提交。`,
    legs,
    blockers,
    pipeline: pipelineOf(pipeline),
    approval: { required: false, reason: need.reason },
    cost,
    geometry,
    exposure,
    ...base,
  }
}

/**
 * 裸单腿：**这笔单唯一的价格保护是强平距离**，它够不够远？
 *
 * ── 为什么是"调用 `judgeLeverage`"而不是在这里重写判据 ──────────────
 * 「多少倍在没有止损时才算安全」这件事在本仓库**只有一个主人**：
 * `voice/leverageGuard.judgeLeverage()` 的 ②③ 两档（强平距离 ≥ `STOP_SAFETY_PCT_MIN`，
 * 否则必须给止损、或降到由 `leverageForLiquidationDistance` 反解出的那个整数倍）。
 * 判据：同一个业务动作只许有一条规矩。在这里再写一份"强平距离够不够远"，
 * 两份必然分岔 —— 而分岔之后**看起来更严的那份不一定是生效的那份**。
 *
 * ★★ 这个 import 方向（core → `voice/`）是**刻意**的，不是笔误。
 *   要理顺层次，正确的做法是把 `leverageGuard.ts` 从 `voice/` 提到 `server/`
 *   （它本来就只依赖 `riskConstants` 与 `positionGuard`，是纯函数），
 *   **而不是**在闸门里抄一份自己的判据。
 */
function nakedProtectionLeg(input: PrecheckInput): GateLeg {
  const id = 'naked.liquidation'
  const name = '裸单的强平距离'
  const verdict = judgeLeverage({
    entryPrice: input.entry,
    side: input.side === 'buy' ? 'long' : 'short',
    instType: input.instType ?? 'SPOT',
    requested: input.leverage,
    // ★ 显式给 0：这条腿问的正是"**没有**止损时安不安全"，
    //   带上止损就是在问另一个问题（那也是另一条腿的事）。
    stopLossPct: 0,
  })
  return {
    id,
    name,
    passed: verdict.ok,
    detail: verdict.speech,
    code: verdict.ok ? undefined : (verdict.reason ?? 'NAKED_LEVERAGE_NEEDS_STOP').split(' ')[0],
  }
}

/**
 * 预测腿。
 *
 * 六个分支各自对应**不同的事因**（判据 20：事因不同的拒绝必须各有各的词），
 * 每个分支的下一动作都不一样：
 *
 * | 情形 | 腿 | 下一步动作 |
 * |---|---|---|
 * | 没声称以预测为依据 | 通过（但明说没参与） | 无 —— 这不是"预测通过了" |
 * | 声称了却没给结论 | `unverifiable` / `FORECAST_MISSING` | 去把预测跑出来 |
 * | 预测的标的与本单不同 | `blocked` / `FORECAST_SYMBOL_MISMATCH` | 别拿别的品种的结论 |
 * | 预测自己说"判不了" | `unverifiable` / `FORECAST_UNVERIFIABLE` | 修数据源 / 攒样本，再看一次 |
 * | 预测说"没有统计优势" | `blocked` / `FORECAST_NO_EDGE` | 换方法或攒数据，**不是**改方向 |
 * | 有优势但方向相反 | `blocked` / `FORECAST_CONTRADICTS` | 这笔是逆着信号做的，改方向或撤 |
 * | 有优势且方向一致 | 通过 | 可以按它下单 |
 */
function forecastLeg(input: PrecheckInput): GateLeg {
  const id = 'alpha.forecast'
  const name = '下单依据（走势预测）'
  const claim = input.forecastClaim
  if (claim?.claims !== true) {
    return {
      id,
      name,
      passed: true,
      detail:
        '这笔单没有以走势预测为依据（策略单有自己的样本外证据，人工单有自己的判断），' +
        '所以这一道不构成拦截。注意：这不是"预测通过了"，而是"预测没参与这笔决策"。',
    }
  }
  const r = claim.result
  if (!r) {
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_MISSING',
      detail: '这笔单声称以走势预测为依据，却没有给出预测结论 ⇒ 这属于查不了，不放行（缺证据不等于没有风险）。',
    }
  }
  if (r.symbol.toUpperCase() !== input.symbol.toUpperCase()) {
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_SYMBOL_MISMATCH',
      detail: `预测的标的是 ${r.symbol}，本单是 ${input.symbol} —— 拿另一个品种的结论支撑这笔单，不成立。`,
    }
  }
  if (r.outcome === 'unverifiable') {
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_UNVERIFIABLE',
      detail:
        `预测自己说"无法给出可靠预测"（${describeForecastGate(r.gate)}），所以它不能当依据。` +
        `${plainText(r.reasons[0]?.text ?? '')}`,
    }
  }
  if (r.outcome === 'no-edge') {
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_NO_EDGE',
      detail:
        `预测的结论是没有统计优势（${describeForecastGate(r.gate)}）：${plainText(r.reasons[0]?.text ?? '')}` +
        '拿它当依据等于把噪声当信号。',
    }
  }
  if (r.direction === null) {
    // 判决说"有优势"，方向却是空的 —— 内部自相矛盾。这是异常，不是"数据少一点"。
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_UNVERIFIABLE',
      detail: '预测的判决是有优势，但方向为空 —— 两处结论互相矛盾，属于异常，不放行。',
    }
  }
  const wants: 'buy' | 'sell' = r.direction === 'up' ? 'buy' : 'sell'
  if (wants !== input.side) {
    return {
      id,
      name,
      passed: false,
      code: 'FORECAST_CONTRADICTS',
      detail:
        `这笔单是${input.side === 'buy' ? '买入' : '卖出'}，而预测方向是${r.direction === 'up' ? '偏上' : '偏下'} —— ` +
        '一个有统计优势的信号正指向相反方向，也就是这笔单是逆着它做的。',
    }
  }
  return {
    id,
    name,
    passed: true,
    detail:
      `预测支持这个方向：中位目标 ${r.target === null ? 'n/a' : r.target.toFixed(2)}，` +
      `净边际 ${r.netEdgeBps === null ? 'n/a' : r.netEdgeBps.toFixed(1)} bps` +
      `（已扣往返成本 ${r.roundTripCostBps} bps）。`,
  }
}

/** 预测在本笔里的角色的视图。 */
function forecastView(input: PrecheckInput): PrecheckResult['forecast'] {
  const claim = input.forecastClaim
  const r = claim?.result ?? null
  return {
    claims: claim?.claims === true,
    outcome: r?.outcome ?? null,
    gate: r?.gate ?? null,
    direction: r?.direction ?? null,
    target: r?.target ?? null,
    proposal: r ? proposeForecastOrder(r) : null,
  }
}

/** 台账口径敞口的视图。`limitUsdt` 为 null 表示未设上限 —— **不是 `0`**。 */
function exposureOf(  e: ExposureSnapshot,
  notional: number,
  overLimit: boolean,
): PrecheckResult['exposure'] {
  return {
    grossBeforeUsdt: e.grossUsdt,
    thisOrderUsdt: notional,
    grossAfterUsdt: e.grossUsdt + notional,
    limitUsdt: e.limitUsdt,
    unreleasedCount: e.unreleasedCount,
    overLimit,
  }
}

// ─────────────────────────────────────────────────────────────
// 第三部分：活体外壳（读真实行情快照 + 真实账户状态）
// ─────────────────────────────────────────────────────────────

/**
 * 用**引擎自己的几何函数**算建议价。
 *
 * ★ 这里一个公式都不新写：止损距离来自 `computeStopGeometry`（与自治循环同一把尺子），
 *   止盈价来自 `deriveStructureTarget`（结构位/等距测幅）。
 *   如果这里手算 `price * 0.97`，那就等于把两份口径的问题原样搬了过来，
 *   只不过搬进了服务端 —— 而搬进服务端更难被发现。
 */
function suggestPrices(
  side: 'buy' | 'sell',
  price: number,
  snapshot: RegimeSnapshot,
): PrecheckResult['suggested'] {
  if (!(price > 0)) return null
  const geometry = computeStopGeometry(price, snapshot.atr1h)
  if (!(geometry.distance > 0)) return null
  const stopLoss = side === 'buy' ? price - geometry.distance : price + geometry.distance
  const target = deriveStructureTarget(side === 'buy' ? 'long' : 'short', snapshot, price)
  // 结构目标有时会落在"和入场价一样"（高周期结构位不可用）——
  // 那种情况下如实把 basis 一并给出，让界面能说清"这个建议不是结构位推出来的"。
  return {
    stopLoss,
    takeProfit: target.price,
    stopDistance: geometry.distance,
    stopPct: geometry.distancePct,
    atrMultiplier: geometry.atrMultiplier,
    stopBasis: `${geometry.atrMultiplier.toFixed(1)}×ATR（1H ATR=${snapshot.atr1h.toFixed(2)}，夹在安全带内后距离 ${geometry.distance.toFixed(2)}）`,
    targetBasis: target.basis,
  }
}

/**
 * 账户状态。**刻意不从本模块内部去取** ——
 * 让它由调用方注入，是为了让「这个数从哪来」在每一处都被写出来一次。
 * 藏一个默认实现（"没有就取 0"）会让 equity=0 的静默降级一路走到
 * 「日亏上限按 0 权益算 → 熔断线变成 0 → 一切都拒绝」，而界面上看不出哪里不对。
 */
export interface TraderAccountState {
  equity: number
  killswitch: boolean
  dailyLoss: number
  dailyLossLimit: number
}

export interface LivePrecheckDeps {
  refreshRegime: (symbol: string, atrPeriod: number) => Promise<RegimeSnapshot>
  getRegime: (symbol: string) => RegimeSnapshot | undefined
  account: () => TraderAccountState
  exposure: () => ExposureSnapshot
}

export interface LivePrecheckRequest {
  /** 交易所符号（如 `BTCUSDC`）。**用交易所符号而不是内部交易对**：
   *  这一层要跟交易所对账，多一次映射就多一个两侧不一致的机会。 */
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  entry: number
  takeProfit: number
  stopLoss: number
  confidence?: number
  environment: ApprovalEnvironment
  channel: 'cex' | 'dex'
  venue?: string
  expectedEdgeBps?: number
  holdingHours?: number
  /** 标记价。缺省用高周期快照的最新收盘价 —— 并在 `assumptions` 里说出来。 */
  markPrice?: number
  /** 强制刷新行情快照。默认用 5 分钟 TTL 缓存（避免每次按键都打交易所）。 */
  refresh?: boolean
  /**
   * 这笔单是否**声称以走势预测为依据**。缺省 `false`。
   *
   * ★ 调用方给的是**一个布尔**，不是预测结论本身：结论由这里现算
   *   （下面的 `forecast()`）。理由与 `file_lesson` 那条一模一样 ——
   *   凭据一旦可以由调用方填，门就等于可以自己开。调用方唯一能选择的是
   *   "要不要让预测参与"，而不是"预测说什么"。
   */
  forecastClaims?: boolean
  /** 预测的跨度（分钟）。缺省 60（预测层的默认档 = 15m × 4 根）。 */
  forecastHorizonMinutes?: number
  /** 用户**显式放弃**保护价（裸单）。缺省 `false` ⇒ 缺保护一律 `unverifiable`。见 `PrecheckInput`。 */
  protectionWaived?: boolean
  /** 生效杠杆（已被 `judgeLeverage` 裁决过）。裸单的合约单必填。 */
  leverage?: number
  /** 品种形态。裸单几何只在 `SWAP` 上有意义。 */
  instType?: 'SPOT' | 'SWAP'
}

/**
 * 读真实行情与账户状态，跑一次完整预检。
 *
 * ★ 与 `precheckTrade()` 的分工：这里只负责**取数**，判断全在纯函数那边。
 *   这样烟测能把行情换成确定性数据（`configureRegimeSource`），
 *   而产出的裁决仍然是人手那份代码路径 —— 不测两份实现。
 */
export async function precheckLiveTrade(
  req: LivePrecheckRequest,
  deps: LivePrecheckDeps,
): Promise<PrecheckResult> {
  const assumptionsExtra: string[] = []

  let snapshot: RegimeSnapshot | undefined
  try {
    snapshot = req.refresh ? await deps.refreshRegime(req.symbol, ATR_PERIOD) : deps.getRegime(req.symbol)
    if (!snapshot) snapshot = await deps.refreshRegime(req.symbol, ATR_PERIOD)
  } catch (e) {
    snapshot = undefined
    assumptionsExtra.push(`行情快照取数失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const acct = deps.account()
  const markPrice = req.markPrice ?? snapshot?.h1Close ?? 0

  if (!snapshot) {
    const missing: GateLeg[] = [
      {
        id: 'market.snapshot',
        name: '行情快照',
        passed: false,
        detail: `取不到 ${req.symbol} 的高周期行情快照，无法评估`,
        code: 'DATA_QUALITY',
      },
    ]
    return {
      verdict: 'unverifiable',
      submitAllowed: false,
      summary: `无法评估这笔交易：取不到 ${req.symbol} 的行情快照。**这不是被拒绝，是查不了** —— 不放行。`,
      symbol: req.symbol,
      side: req.side,
      notionalUsdt: req.notionalUsdt,
      legs: missing,
      blockers: missing,
      approval: { required: false, reason: '未评估' },
      cost: null,
      geometry: null,
      pipeline: notRunPipeline(),
      exposure: exposureOf(deps.exposure(), req.notionalUsdt, false),
      market: {
        price: markPrice,
        atr: 0,
        adx1h: undefined,
        macroTrend: 'RANGE',
        macroTrendSource: '高周期趋势不可用',
        dataQuality: 'insufficient',
        snapshotAt: null,
        stale: null,
      },
      confidenceUsed: req.confidence ?? MIN_ENTRY_CONFIDENCE,
      assumptions: assumptionsExtra,
      suggested: null,
      disclosures: [],
      // ★ 连行情快照都取不到 ⇒ 预测根本没被评估过。
      //   这里必须把 `claims` 如实带上：如果它写着 `claims:true` 而 outcome 是 null，
      //   读的人应当明白"声称了，但没评"——**不是**"预测通过了"。
      forecast: {
        claims: req.forecastClaims === true,
        outcome: null,
        gate: null,
        direction: null,
        target: null,
        proposal: null,
      },
    }
  }

  if (req.markPrice === undefined) {
    assumptionsExtra.push(
      `标记价未提供，取用 1H 快照的收盘价 ${snapshot.h1Close}（更新时间 ${new Date(snapshot.updatedAt).toLocaleString('zh-CN')}）`,
    )
  }

  const pkg = buildMarketPackage({
    symbol: req.symbol,
    price: markPrice,
    atr: snapshot.atr1h,
    // ★ `bars` 传 0 而不是编一个数：逐条核对过 9 道闸门的输入，**没有任何一条读 bars**，
    //   真正决定数据可信度的是 `dataQuality`。给一个看起来像样本量的假数字，
    //   比给 0 更危险 —— 它会让人以为这里有依据。
    bars: 0,
    dataQuality: snapshot.stale ? 'stale' : 'valid',
    adx1h: snapshot.adx1h,
    macroTrend: snapshot.macroTrend,
    macroTrendSource: snapshot.macroTrendSource,
  })

  const ctx = buildInterceptorContext({
    symbol: req.symbol,
    side: req.side === 'buy' ? 'long' : 'short',
    now: Date.now(),
    equity: acct.equity,
    killswitch: acct.killswitch,
    dailyLoss: acct.dailyLoss,
    dailyLossLimit: acct.dailyLossLimit,
  })

  // ── 声称以预测为依据时：**由服务端现算**，不采信调用方给的东西 ──
  //
  // ★ 为什么在活体外壳里算而不是让前端传上来：前端能传的东西就等于前端能编的东西。
  //   "这笔单有预测支持"是一句**凭据**，凭据只能由能对其负责的那一层签发。
  // ★ 为什么这里不做缓存：预测层自己有一层按 `dataHash + 因子选中集` 做的结果缓存
  //   （实测复用时 80ms vs 冷算 6.4s），在这一层再包一层只会把"陈旧"藏得更深。
  let forecastResult: ForecastResult | null = null
  if (req.forecastClaims === true) {
    try {
      const h = resolveHorizon(req.forecastHorizonMinutes ?? 60)
      forecastResult = forecast({ symbol: req.symbol, config: { horizonBars: h.horizonBars, barMinutes: h.barMinutes } })
    } catch (e) {
      forecastResult = null
      assumptionsExtra.push(
        `这笔单声称以走势预测为依据，但预测层取数/计算失败：${e instanceof Error ? e.message : String(e)}。` +
          '按"查不了"处理，不放行。',
      )
    }
  }

  const result = precheckTrade({
    symbol: req.symbol,
    side: req.side,
    notionalUsdt: req.notionalUsdt,
    entry: req.entry,
    takeProfit: req.takeProfit,
    stopLoss: req.stopLoss,
    confidence: req.confidence,
    environment: req.environment,
    channel: req.channel,
    venue: req.venue,
    expectedEdgeBps: req.expectedEdgeBps,
    holdingHours: req.holdingHours,
    pkg,
    ctx,
    exposure: deps.exposure(),
    forecastClaim: { claims: req.forecastClaims === true, result: forecastResult },
    // ★ 裸单三件套原样透传。**不做任何"就近推断"** ——
    //   特别是不拿 `req.leverage` 缺省成 1：见 `PrecheckInput.leverage`，
    //   缺杠杆的合约裸单必须在 ⓪ 被拦住（否则强平检查自动变绿）。
    protectionWaived: req.protectionWaived === true,
    leverage: req.leverage,
    instType: req.instType,
  })

  return {
    ...result,
    market: {
      ...result.market,
      snapshotAt: snapshot.updatedAt,
      stale: snapshot.stale,
    },
    assumptions: [...assumptionsExtra, ...result.assumptions],
    // ★ 建议价由**引擎的几何函数**产出，前端不许自己算一份：
    //   这正是"大厅硬编码 ±3% vs 引擎 ATR 止损"那个两份口径的收口处。
    suggested: suggestPrices(req.side, markPrice, snapshot),
    disclosures: [
      // ① 敞口腿只反映**引擎台账**口径。交易大厅的纸面成交发生在浏览器内存里，
      //    引擎的预留台账看不到它 —— 所以「敞口在界内」不代表把大厅这些单加进去还在界内。
      //    这一条不能省：省掉之后，绿色裁决会让人以为它管住了大厅的全部敞口。
      `组合敞口只计引擎台账（预留层）口径；交易大厅的纸面成交在浏览器内存里，不占用台账，因此未计入本笔之外的大厅挂单`,
      // ② 当日亏损同理：熔断线读的是引擎自己的已实现亏损账。
      `当日亏损熔断读的是引擎账本口径；大厅纸面成交不计入其中`,
    ],
  }
}
