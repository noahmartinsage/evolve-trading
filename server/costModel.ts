/**
 * 交易成本模型 —— 「成本硬约束」。
 *
 * ══ 它解决什么问题 ═══════════════════════════════════════════════════
 * 本模块此前**不存在**：全仓库没有一处代码知道「做这一笔要付多少钱」。
 * 后果不是「成本没算精确」，而是**根本没人算**——决策层看到的只有一个「预期收益」，
 * 于是一个在回测里 +0.35%、在实盘里必然亏钱的方案，会被一致地评为「值得做」。
 *
 * 实证依据（2026-09 情报）：lazi-nhr/AI-Trading-Agent 的样本外结论是，
 * 同一策略在 0 / 1.44bps / 4.50bps 三档费率下，夏普与最大回撤**急剧劣化**——
 * 交易成本是高频率策略的关键限制因子。也就是说：
 *   「回测能赚」与「实盘能赚」之间的差额，主要不是模型能力，而是**成本项漏算**。
 * 对 EVOLVE 尤其致命：CEX 侧有 taker 费 + 资金费，DEX 侧有 LP fee + 价格冲击 + 跨链桥费 + gas，
 * 两侧成本结构**差一个量级**，而双通道决策却要在一个平台上比较两个通道的收益。
 *
 * ══ 三条设计纪律 ═════════════════════════════════════════════════════
 *
 * ① **成本是闸门，不是报表。**
 *    `assessEdge()` 返回的不是数字而是一个裁决。原因：把成本做成事后统计，
 *    它永远追不上已经下出去的单；做成前置闸门，它才真的能拦下人。
 *
 * ② **成本假设缺失即拒绝（Fail-Closed）。**
 *    本类系统最贵的失败模式不是「成本估高了」，而是「某个成本项根本没被建模，
 *    于是静默地按 0 计入」。所以当既没有池深、也没有显式滑点假设时，
 *    这里返回 `MISSING_COST_ASSUMPTION` 而不是「滑点按 0 算」。
 *    这一条刻意与 `risk.ts` 的「默认拒绝」保持同一哲学。
 *
 * ③ **费率一律走活绑定，绝不硬编码。**
 *    费率是**会变的场所事实**（交易所调费、池子换档、链上 gas 波动）。
 *    它们住在 `riskConstants.ts` 的组 7，于是「面板显示 / 提示词插值 / 执行闸门」
 *    三处必然同源。硬编码在本文件里会立刻制造一套新口径。
 *
 * ══ 一个必须讲清楚的建模选择 ═════════════════════════════════════════
 * 价格冲击用 **恒定乘积(AMM) 的小额近似**。推导（不凭印象，附在这里免得后人重推）：
 *   池：报价侧储备 D，标的侧储备 B，现货价 P = D/B。
 *   投入 N 个报价单位，按 x·y=k 得到标的 ΔB = B·N/(D+N)，
 *   故**平均成交价** = N/ΔB = (D+N)/B = P·(1 + N/D)。
 *   ⇒ 单腿平均冲击率 = **N / D**（即「吃掉池子百分之一，就付百分之一的价」）。
 *   ⇒ 往返（进出各一次）冲击成本 ≈ 2 · N² / D。
 *
 * 这个式子有三个必须记住的含义：
 *   - **非线性**：规模翻倍，冲击成本翻 4 倍。所以 DEX 上加仓有硬上限。
 *   - **可行区间**：太小则固定成本（gas/桥费）摊不开，太大则冲击吃掉 edge。
 *     「这笔交易值不值得做」和「做多大才值得」是两个问题，这里都要回答。
 *   - **`poolDepthUsdt` 的语义必须是「报价侧可动用储备」**，不是池子总市值。
 *     用总市值会让冲击被低估 2 倍 —— 典型的「口径不同、数字看着差不多」。
 * CEX 侧**不套用**上面的线性式。订单簿逐档吃单的冲击曲线无法由单一深度值还原，
 * 拿线性式硬套会给出「2 万美金砸出 40bps」这类结论（真实约 1~3bps），
 * 而荒谬的成本估计会**把所有正常交易都判成不划算**——把闸门焊死与不设闸门一样糟。
 * 所以 CEX 分支明确拒绝推测：成本假设必须由 `CEX_EXPECTED_SLIPPAGE_BPS`（默认与回测执行假设同源）
 * 或调用方显式传入的 `expectedSlippageBps` 给出；两者都没有 → `MISSING_COST_ASSUMPTION`。
 * 换句话说：**CEX 的成本缺口不允许被「大概估个滑点」补上，只允许被一个具名假设补上。**
 */

import { DEFAULT_EXEC } from '../src/engine/index.ts'
import {
  APPROVAL_THRESHOLD_USDT,
  CEX_EXPECTED_SLIPPAGE_BPS,
  CEX_MAKER_FEE_BPS,
  CEX_TAKER_FEE_BPS,
  DEX_LP_FEE_BPS,
  DEX_MAX_PRICE_IMPACT_BPS,
  FUNDING_RATE_BPS_PER_8H,
  MAX_COST_SHARE_BPS,
  MIN_EDGE_COST_MULTIPLE,
  MIN_VIABLE_NOTIONAL_USDT,
  MIN_VIABLE_NOTIONAL_CEX_USDT,
} from './riskConstants.ts'

/**
 * 口径漂移自检：回测的执行假设与实盘成本闸门必须同源。
 *
 * 为什么值得写一段会抛异常的代码：这两处一旦不同源，表现的形态**不是报错**，
 * 而是「回测年化 30%、实盘年化 4%」这种没人能一眼归因的偏差——
 * 差额比例恰好就是两个滑点假设之比，但没人会往那儿想。
 * 宁可让进程起不来，也不让口径悄悄漂移（与 riskConfig 的 schema 自检同一哲学）。
 */
if (CEX_EXPECTED_SLIPPAGE_BPS !== DEFAULT_EXEC.slippageBps) {
  throw new Error(
    `[cost] 滑点口径漂移：EV_CEX_EXPECTED_SLIPPAGE_BPS=${CEX_EXPECTED_SLIPPAGE_BPS} ` +
      `≠ 回测执行假设 DEFAULT_EXEC.slippageBps=${DEFAULT_EXEC.slippageBps}。` +
      '若确实要在实盘用更保守的滑点，请同步调整 src/engine/types.ts 的 DEFAULT_EXEC，' +
      '否则回测与实盘将以两套成交代价各自计算收益。',
  )
}

/**
 * 通道可行性自检：成本占比上限必须高于 DEX 的往返 LP 费率下界。
 *
 * DEX 的成本里有一块**跑不掉的地板**：进出两条腿各收一次 LP 费。
 * 如果上限设得低于或等于这块地板，那么**任何** DEX 交易都会被判「成本占比过高」——
 * 整条通道在默认参数下静默不可用，而每一条拒绝理由看起来都很合理
 * （「这一笔太贵了」），没有一条会指向真因（两个默认值互斥）。
 * 这正是本项目最忌讳的那类缺陷：不报错、不崩溃，只是安静地什么都不做。
 */
if (MAX_COST_SHARE_BPS <= DEX_LP_FEE_BPS * 2) {
  throw new Error(
    `[cost] 默认参数互斥，DEX 通道将被结构性关闭：` +
      `EV_MAX_COST_SHARE_BPS=${MAX_COST_SHARE_BPS} ≤ DEX 往返 LP 费率 ${DEX_LP_FEE_BPS * 2}bps。` +
      'DEX 任何一笔交易的成本占比天然就不低于这个数，闸门将拒绝全部 DEX 交易。' +
      '请把成本占比上限调到高于该地板（默认 120bps），或下调 DEX_LP_FEE_BPS（若所选池档确实更便宜）。',
  )
}

export type Channel = 'cex' | 'dex'

export interface CostInput {
  channel: Channel
  venue: string
  /** 名义本金（USDT）。成本全部按它折算。 */
  notionalUsdt: number
  /**
   * 预期**毛**收益，以名义本金的 bps 表示（例：预期涨 0.4% → 40）。
   * 刻意用比率而非绝对金额：比率不随仓位规模漂移，
   * 用绝对金额会让「同样的机会」在大仓位下自动显得更划算。
   */
  expectedEdgeBps: number
  /** 预期持仓时长（小时），用于资金费摊算。缺省视为 0（不摊资金费，并在 note 里注明）。 */
  holdingHours?: number
  /** 该交易对可动用池深（USDT）。与 `expectedSlippageBps` 至少给一个。 */
  poolDepthUsdt?: number
  /** 显式滑点假设（单腿 bps）。与 `poolDepthUsdt` 同时给出时**取更保守者**。 */
  expectedSlippageBps?: number
  /** 跨链桥费（USDT）。固定成本，只计一次（进链那一趟）。 */
  bridgeFeeUsdt?: number
  /** 单腿链上 gas（USDT）。固定成本，进出各一次。 */
  chainGasUsdt?: number
  /** 是否市价单。默认 true → 用 taker 费率。用 maker 费率算市价单会系统性低估成本。 */
  isTaker?: boolean
}

export interface CostItem {
  label: string
  usdt: number
  bps: number
  /** 固定成本不随名义金额缩小，是「最小可行规模」的决定者。 */
  fixed: boolean
  note?: string
}

export interface CostBreakdown {
  channel: Channel
  venue: string
  notionalUsdt: number
  items: CostItem[]
  totalUsdt: number
  totalBps: number
  fixedUsdt: number
  variableUsdt: number
  /** 往返滑点的单腿估算（bps），用于对外解释「这笔为什么贵」。 */
  singleLegImpactBps: number
  /**
   * 成本假设是否完整。false 表示**有成本项没被建模**——
   * 此时绝不允许把缺席项当 0（见文件头纪律 ②）。
   */
  assumptionsComplete: boolean
  missingAssumptions: string[]
}

export type EdgeVerdict =
  | 'PASS'
  | 'MISSING_COST_ASSUMPTION'
  | 'NOTIONAL_TOO_SMALL'
  | 'IMPACT_TOO_HIGH'
  | 'NEGATIVE_NET'
  | 'COST_DOMINATED'
  | 'COST_SHARE_TOO_HIGH'

export interface EdgeAssessment {
  ok: boolean
  verdict: EdgeVerdict
  grossEdgeUsdt: number
  totalCostUsdt: number
  netEdgeUsdt: number
  /** 毛收益 ÷ 总成本。核心指标：它衡量「成本估算可以错多少倍才由赚转亏」。 */
  edgeMultiple: number
  requiredMultiple: number
  costShareBps: number
  maxCostShareBps: number
  /** 中文完整句，可直接展示在决策流里（本项目禁用缩写式拒绝理由）。 */
  reason: string
  breakdown: CostBreakdown
  /**
   * 可行区间：名义本金低于 `required` 则固定成本摊不开；
   * 高于 `max` 则价格冲击吃掉 edge（仅 DEX 有限）。null = 该方向不构成约束。
   */
  requiredNotionalUsdt: number | null
  maxViableNotionalUsdt: number | null
}

function bpsOf(usdt: number, notional: number): number {
  if (!(notional > 0)) return 0
  return (usdt / notional) * 10_000
}

function round(v: number, d = 4): number {
  const m = Math.pow(10, d)
  return Math.round(v * m) / m
}

/**
 * 单腿价格冲击（bps）。
 *
 * **按通道分别处理，这不是不一致，而是因为两个通道的物理模型不同：**
 *
 *   DEX：恒定乘积有闭式解（见文件头推导），池深是唯一必要输入 → 可由池深推算。
 *
 *   CEX：订单簿冲击是**次线性**的（经验上接近 √N），且真实值取决于逐档挂单分布，
 *        一个「池深」标量根本不足以推算它。用 N/D 去套会把一笔 $20k 的单子
 *        估成 40bps 冲击（真实约 1~3bps），于是所有 CEX 交易都会被误拦。
 *        所以这里**拒绝猜**：CEX 想算滑点就必须显式给出 `expectedSlippageBps`，
 *        否则计入「成本假设缺失」并拒绝放行。
 *        这与本项目 `normalizeAccountKey` 的处理一致 —— 拿不到的信息就承认拿不到，
 *        不要用一个看起来合理的数把它填上。
 */
function resolveSingleLegImpactBps(input: CostInput): { bps: number; source: string } {
  const { channel, notionalUsdt, poolDepthUsdt, expectedSlippageBps } = input
  const explicit =
    expectedSlippageBps !== undefined && Number.isFinite(expectedSlippageBps) && expectedSlippageBps >= 0
      ? expectedSlippageBps
      : undefined

  if (channel === 'cex') {
    if (explicit !== undefined) return { bps: explicit, source: '显式假设' }
    return {
      bps: Number.NaN,
      source:
        poolDepthUsdt !== undefined && poolDepthUsdt > 0
          ? '缺失（CEX 订单簿冲击无法由单一深度值推算，请显式给出 expectedSlippageBps）'
          : '缺失（未提供 expectedSlippageBps）',
    }
  }

  const fromDepth =
    poolDepthUsdt !== undefined && poolDepthUsdt > 0 ? (notionalUsdt / poolDepthUsdt) * 10_000 : undefined

  if (fromDepth !== undefined && explicit !== undefined) {
    return fromDepth >= explicit
      ? { bps: fromDepth, source: '池深推算（与显式假设取保守者）' }
      : { bps: explicit, source: '显式假设（与池深推算取保守者）' }
  }
  if (fromDepth !== undefined) return { bps: fromDepth, source: '池深推算' }
  if (explicit !== undefined) return { bps: explicit, source: '显式假设' }
  return {
    bps: Number.NaN,
    source: '缺失（既未提供 poolDepthUsdt，也未提供 expectedSlippageBps）',
  }
}

/** 逐项估算往返成本。纯函数、可离线单测、不读时钟也不写盘。 */
export function estimateCost(input: CostInput): CostBreakdown {
  const { channel, venue, notionalUsdt, isTaker = true } = input
  const notional = Math.max(notionalUsdt, 0)
  const items: CostItem[] = []
  const missing: string[] = []

  const impact = resolveSingleLegImpactBps(input)
  if (!Number.isFinite(impact.bps)) {
    missing.push(`滑点：${impact.source}`)
  }

  // ── 手续费：进出两条腿各收一次 ──────────────────────────────
  const feeBps = channel === 'cex' ? (isTaker ? CEX_TAKER_FEE_BPS : CEX_MAKER_FEE_BPS) : DEX_LP_FEE_BPS
  const feeUsdt = notional * (feeBps / 10_000) * 2
  items.push({
    label: channel === 'cex' ? `手续费（往返 2 腿 × ${feeBps.toFixed(1)}bps，${isTaker ? 'taker' : 'maker'}）` : `池 LP 费（往返 2 腿 × ${feeBps.toFixed(1)}bps）`,
    usdt: feeUsdt,
    bps: bpsOf(feeUsdt, notional),
    fixed: false,
  })

  // ── 滑点 / 价格冲击 ────────────────────────────────────────
  if (Number.isFinite(impact.bps)) {
    // 往返：两腿各承受一次同幅度冲击 → 成本的单腿率 × 2
    const slipUsdt = notional * (impact.bps / 10_000) * 2
    items.push({
      label: `价格冲击（单腿 ${round(impact.bps, 2)}bps，往返 2 腿；${impact.source}）`,
      usdt: slipUsdt,
      bps: bpsOf(slipUsdt, notional),
      fixed: false,
    })
  }

  // ── 资金费：永续持有成本，方向一律取不利侧 ──────────────────
  if (channel === 'cex') {
    const hours = Math.max(input.holdingHours ?? 0, 0)
    if (hours > 0) {
      // 刻意用绝对值：不能假设自己总是站在「收资金费」的那一边。
      // 假设对手方向不利，是成本估算该有的悲观。
      const fundUsdt = notional * (Math.abs(FUNDING_RATE_BPS_PER_8H) / 10_000) * (hours / 8)
      items.push({
        label: `资金费（${FUNDING_RATE_BPS_PER_8H.toFixed(2)}bps/8h × ${round(hours, 2)}h，按不利侧计）`,
        usdt: fundUsdt,
        bps: bpsOf(fundUsdt, notional),
        fixed: false,
      })
    } else {
      items.push({
        label: '资金费',
        usdt: 0,
        bps: 0,
        fixed: false,
        note: '未提供持仓时长，资金费按 0 计入——持仓跨越结算点时实际成本会高于此估算',
      })
    }
  }

  // ── 链上固定成本 ────────────────────────────────────────────
  if (channel === 'dex') {
    const gas = Math.max(input.chainGasUsdt ?? 0, 0)
    if (gas > 0) {
      const gasUsdt = gas * 2
      items.push({
        label: `链上 gas（进出各一次 × ${round(gas, 3)} USDT）`,
        usdt: gasUsdt,
        bps: bpsOf(gasUsdt, notional),
        fixed: true,
      })
    }
    const bridge = Math.max(input.bridgeFeeUsdt ?? 0, 0)
    if (bridge > 0) {
      items.push({
        label: `跨链桥费（固定项 × 1）`,
        usdt: bridge,
        bps: bpsOf(bridge, notional),
        fixed: true,
      })
    }
  }

  const totalUsdt = items.reduce((a, i) => a + i.usdt, 0)
  const fixedUsdt = items.reduce((a, i) => a + (i.fixed ? i.usdt : 0), 0)
  return {
    channel,
    venue,
    notionalUsdt: notional,
    items: items.map((i) => ({ ...i, usdt: round(i.usdt, 6), bps: round(i.bps, 3) })),
    totalUsdt: round(totalUsdt, 6),
    totalBps: round(bpsOf(totalUsdt, notional), 3),
    fixedUsdt: round(fixedUsdt, 6),
    variableUsdt: round(totalUsdt - fixedUsdt, 6),
    singleLegImpactBps: Number.isFinite(impact.bps) ? round(impact.bps, 3) : Number.NaN,
    assumptionsComplete: missing.length === 0,
    missingAssumptions: missing,
  }
}

/**
 * 成本闸门：判断这笔交易在**扣掉往返成本之后**是否还值得做。
 *
 * 裁决顺序刻意从「物理不可行」到「经济不划算」排列 ——
 * 先拒绝那些无论方向判断多对都做不成的（假设缺失、规模不够、冲击过大），
 * 再谈收益。反过来排会出现「先算出正收益再发现规模不可行」的荒谬结论。
 */
export function assessEdge(input: CostInput): EdgeAssessment {
  const breakdown = estimateCost(input)
  const notional = Math.max(input.notionalUsdt, 0)
  const grossEdgeUsdt = notional * (input.expectedEdgeBps / 10_000)
  const totalCostUsdt = breakdown.totalUsdt
  const netEdgeUsdt = grossEdgeUsdt - totalCostUsdt
  const edgeMultiple = totalCostUsdt > 0 ? grossEdgeUsdt / totalCostUsdt : Number.POSITIVE_INFINITY
  const costShareBps = breakdown.totalBps

  const base = {
    grossEdgeUsdt: round(grossEdgeUsdt, 6),
    totalCostUsdt: round(totalCostUsdt, 6),
    netEdgeUsdt: round(netEdgeUsdt, 6),
    edgeMultiple: Number.isFinite(edgeMultiple) ? round(edgeMultiple, 3) : Number.POSITIVE_INFINITY,
    requiredMultiple: MIN_EDGE_COST_MULTIPLE,
    costShareBps: round(costShareBps, 3),
    maxCostShareBps: MAX_COST_SHARE_BPS,
    breakdown,
  }

  const reject = (verdict: EdgeVerdict, reason: string, required: number | null, max: number | null): EdgeAssessment => ({
    ok: false,
    verdict,
    ...base,
    reason,
    requiredNotionalUsdt: required,
    maxViableNotionalUsdt: max,
  })

  // ① 成本假设缺失 —— 缺席的成本项不能当 0
  if (!breakdown.assumptionsComplete) {
    return reject(
      'MISSING_COST_ASSUMPTION',
      `成本假设不完整，拒绝按残缺口径放行：${breakdown.missingAssumptions.join('；')}。` +
        '把未建模的成本当 0 计，正是「回测赚实盘亏」的常见成因。',
      null,
      null,
    )
  }

  // ② 规模下限：固定成本不随金额缩小
  //
  // ⚠️ 地板按**通道**取值，这是两类不同的事实，不是同一个数字的两个副本：
  //   · DEX：gas + 跨链桥费是**固定成本**，不随金额等比缩小 → 地板高（默认 200 USDT）。
  //   · CEX 合约：没有 gas、没有桥，成本是纯比例项（taker 费率 + 滑点 bps）→ 地板低（默认 10 USDT）。
  //   早期把 DEX 地板套用到 CEX，会让「$100 名义本金」这种在合约上完全正常的小额单
  //   被判 NOTIONAL_TOO_SMALL 而**永远无法成交**——不报错、只是静默不开仓。
  //   那是一个**类别错误**（把固定成本事实搬到没有固定成本的地方），不是数值调优问题。
  const viableFloor = input.channel === 'cex' ? MIN_VIABLE_NOTIONAL_CEX_USDT : MIN_VIABLE_NOTIONAL_USDT
  if (notional < viableFloor) {
    const basis =
      input.channel === 'cex'
        ? 'CEX 合约没有链上 gas / 跨链桥固定成本，该下限是纯比例成本下的最小有意义规模'
        : '该下限由固定成本（链上 gas、跨链桥费）决定，它们不随金额等比缩小——缩小仓位并不能等比降低成本'
    return reject(
      'NOTIONAL_TOO_SMALL',
      `名义本金 ${round(notional, 2)} USDT 低于最小可行规模 ${viableFloor} USDT（通道 ${input.channel}）。${basis}。`,
      viableFloor,
      maxViableFromDepth(input),
    )
  }

  // ③ 冲击上限：池深不足时这笔交易结构上不可行，与方向判断无关
  if (Number.isFinite(breakdown.singleLegImpactBps) && breakdown.singleLegImpactBps > DEX_MAX_PRICE_IMPACT_BPS) {
    // 单腿冲击率 = N / D → 反解冲击恰好等于上限时的规模
    const depth = input.poolDepthUsdt ?? 0
    const maxViable = depth > 0 ? depth * (DEX_MAX_PRICE_IMPACT_BPS / 10_000) : null
    return reject(
      'IMPACT_TOO_HIGH',
      `单腿价格冲击 ${round(breakdown.singleLegImpactBps, 1)}bps 超过上限 ${DEX_MAX_PRICE_IMPACT_BPS}bps` +
        (maxViable !== null ? `（该池深下最大可行规模约 ${round(maxViable, 0)} USDT）` : '') +
        '。这是资金规模问题，不是信号质量问题——换个方向判断也解决不了。',
      null,
      maxViable !== null ? round(maxViable, 2) : null,
    )
  }

  // ④ 净额为负
  if (netEdgeUsdt <= 0) {
    return reject(
      'NEGATIVE_NET',
      `扣掉往返成本后净额为负（毛收益 ${round(grossEdgeUsdt, 2)} − 成本 ${round(totalCostUsdt, 2)} = ${round(netEdgeUsdt, 2)} USDT）。` +
        '方向判断可能完全正确，但幅度不足以覆盖成交代价。',
      requiredNotionalFor(input),
      null,
    )
  }

  // ⑤ 成本占比过高：说明单笔太小，固定成本摊不开
  if (costShareBps > MAX_COST_SHARE_BPS) {
    return reject(
      'COST_SHARE_TOO_HIGH',
      `往返成本占名义本金 ${round(costShareBps, 1)}bps，超过上限 ${MAX_COST_SHARE_BPS}bps。` +
        '此时「把仓位做大」比「调参数」更有效——固定成本被更大的本金摊薄。',
      requiredNotionalFor(input),
      null,
    )
  }

  // ⑥ 成本主导：这是本模块的核心裁决
  if (edgeMultiple < MIN_EDGE_COST_MULTIPLE) {
    return reject(
      'COST_DOMINATED',
      `毛收益仅为往返成本的 ${round(edgeMultiple, 2)} 倍，低于要求的 ${MIN_EDGE_COST_MULTIPLE} 倍。` +
        '倍数门槛的含义是「成本估算可以错多少倍才由赚转亏」——' +
        `当前只需估算偏差 ${round((1 - 1 / Math.max(edgeMultiple, 1e-9)) * 100, 1)}% 就会把净收益抹平。`,
      requiredNotionalFor(input),
      null,
    )
  }

  return {
    ok: true,
    verdict: 'PASS',
    ...base,
    reason:
      `毛收益 ${round(grossEdgeUsdt, 2)} USDT（${round(input.expectedEdgeBps, 1)}bps）、` +
      `往返成本 ${round(totalCostUsdt, 2)} USDT（${round(costShareBps, 1)}bps）、` +
      `净收益 ${round(netEdgeUsdt, 2)} USDT，成本倍数 ${round(edgeMultiple, 2)}× ≥ ${MIN_EDGE_COST_MULTIPLE}×。`,
    requiredNotionalUsdt: null,
    // 通过也要报出上界：它告诉调用方「这个通道还能加多大仓位」，
    // 而不是让它自己去猜一个不可见的悬崖在哪。
    maxViableNotionalUsdt: maxViableFromDepth(input),
  }
}

/** 由池深推出的「冲击刚好触顶」的规模上限（USDT）。无池深信息时为 null。 */
function maxViableFromDepth(input: CostInput): number | null {
  const depth = input.poolDepthUsdt ?? 0
  if (!(depth > 0)) return null
  return round(depth * (DEX_MAX_PRICE_IMPACT_BPS / 10_000), 2)
}

/**
 * 反解「固定成本刚好被摊薄到可接受」所需的最小名义本金（闭式解）。
 *
 * 设 e = 毛收益率，v = 可变成本率（含滑点率，按单腿率×2 折算），F = 固定成本。
 * 要求 e·N ≥ M·(v·N + F)  →  N ≥ M·F / (e − M·v)
 * 分母 ≤ 0 时说明「无论做多大都盖不住」——返回 null 而不是编造一个数字。
 *
 * ⚠️ 这是**下界**而不是精确值：DEX 上滑点本身随规模增长（∝ N/D），
 * 这里把当前规模下的滑点率当成常数，因此真实所需规模只会比它更大。
 * 作为「最小可行规模」的估计，取偏小的方向是安全的（不会误拦）。
 */
export function requiredNotionalFor(input: CostInput): number | null {
  const e = input.expectedEdgeBps / 10_000
  const M = MIN_EDGE_COST_MULTIPLE
  const F = Math.max(input.bridgeFeeUsdt ?? 0, 0) + 2 * Math.max(input.chainGasUsdt ?? 0, 0)

  // 可变成本率：手续费率 + 滑点率（都是「按名义本金」的项），与规模无关
  const feeRate = (input.channel === 'cex' ? (input.isTaker ?? true ? CEX_TAKER_FEE_BPS : CEX_MAKER_FEE_BPS) : DEX_LP_FEE_BPS) / 10_000 * 2
  const impact = resolveSingleLegImpactBps(input)
  const slipRate = Number.isFinite(impact.bps) ? (impact.bps / 10_000) * 2 : 0
  const fundRate =
    input.channel === 'cex' ? (Math.abs(FUNDING_RATE_BPS_PER_8H) / 10_000) * (Math.max(input.holdingHours ?? 0, 0) / 8) : 0
  const v = feeRate + slipRate + fundRate

  const denom = e - M * v
  if (!(denom > 0)) return null
  // 地板同样按通道取值：CEX 无 gas / 跨链桥固定成本，其下限比 DEX 低一个量级。
  // 两处（拒绝判定与"需要多大才可行"的建议值）必须用同一个地板，
  // 否则会出现「闸门说 $20 不可行、建议值却说 $20 可行」这种自相矛盾。
  const floor = input.channel === 'cex' ? MIN_VIABLE_NOTIONAL_CEX_USDT : MIN_VIABLE_NOTIONAL_USDT
  if (F <= 0) return floor
  return round(Math.max(M * F / denom, floor), 2)
}

/** 提示词插值块标题。与 `RISK_BRIEF_HEADING` 并列注入用户消息。 */
export const COST_BRIEF_HEADING = '【交易成本硬约束】'

/**
 * 渲染成本口径块，供提示词插值。
 *
 * 为什么成本必须进提示词（而不是只在执行层拦截）：
 *   只在执行层拦，模型只知道「提案被拒」，不知道「为什么被拒」，
 *   于是它会持续提出「毛收益 20bps、成本 60bps」这类必然被拒的方案。
 *   把成本口径写进提示词，模型的输出空间才与执行层的可接受空间对齐。
 */
export function renderCostBrief(): string {
  const takerRoundTrip = CEX_TAKER_FEE_BPS * 2
  const dexRoundTrip = DEX_LP_FEE_BPS * 2
  return [
    COST_BRIEF_HEADING,
    '（以下为执行层**实时**成本口径，与引擎同一数据源；毛收益盖不住往返成本的报价会被物理拦截。）',
    '',
    `· CEX 市价费率：${CEX_TAKER_FEE_BPS.toFixed(1)} bps/腿（往返 ${takerRoundTrip.toFixed(1)} bps）；挂单 ${CEX_MAKER_FEE_BPS.toFixed(1)} bps 仅作对照`,
    `· CEX 预期滑点：${CEX_EXPECTED_SLIPPAGE_BPS.toFixed(1)} bps/腿（与回测执行假设同源，不是估计值）`,
    `· DEX 池 LP 费率：${DEX_LP_FEE_BPS.toFixed(1)} bps/腿（往返 ${dexRoundTrip.toFixed(1)} bps）`,
    `· 资金费：${FUNDING_RATE_BPS_PER_8H.toFixed(2)} bps / 8 小时，按持仓时长摊算，方向一律取**不利侧**`,
    `· DEX 单腿价格冲击上限：${DEX_MAX_PRICE_IMPACT_BPS} bps（超出即拒，与方向判断无关）`,
    `· **毛收益必须是往返成本的 ${MIN_EDGE_COST_MULTIPLE}× 以上**；成本占名义本金不得超过 ${MAX_COST_SHARE_BPS} bps`,
    `· 最小可行名义本金：${MIN_VIABLE_NOTIONAL_USDT} USDC（由 gas / 跨链桥费等固定成本决定，缩小仓位不会等比降成本）`,
    '',
    '★ 两个通道的成本结构差一个量级：同样的价格波动幅度，在 DEX 上需要大得多的幅度才能净赚。',
    '  请在提案时按「净收益 = 毛收益 − 往返成本」估算，只提出净收益显著为正的方案；',
    `  毛收益只比成本略高的方案在回测里好看，在实盘里会被成本吃平——那不是策略问题，是账没算全。`,
    `· 实盘动作金额达到 ${APPROVAL_THRESHOLD_USDT} USDC 即进入人工审批，代码无法自行放行。`,
  ].join('\n')
}

/** 结构化快照。面板口径与提示词口径必须同源，否则又是两套口径。 */
export interface CostBriefSnapshot {
  cexTakerFeeBps: number
  cexMakerFeeBps: number
  cexExpectedSlippageBps: number
  dexLpFeeBps: number
  cexRoundTripBps: number
  dexRoundTripBps: number
  fundingBpsPer8h: number
  dexMaxImpactBps: number
  minEdgeCostMultiple: number
  maxCostShareBps: number
  minViableNotionalUsdt: number
  approvalThresholdUsdt: number
}

export function costBriefSnapshot(): CostBriefSnapshot {
  return {
    cexTakerFeeBps: CEX_TAKER_FEE_BPS,
    cexMakerFeeBps: CEX_MAKER_FEE_BPS,
    cexExpectedSlippageBps: CEX_EXPECTED_SLIPPAGE_BPS,
    dexLpFeeBps: DEX_LP_FEE_BPS,
    cexRoundTripBps: CEX_TAKER_FEE_BPS * 2,
    dexRoundTripBps: DEX_LP_FEE_BPS * 2,
    fundingBpsPer8h: FUNDING_RATE_BPS_PER_8H,
    dexMaxImpactBps: DEX_MAX_PRICE_IMPACT_BPS,
    minEdgeCostMultiple: MIN_EDGE_COST_MULTIPLE,
    maxCostShareBps: MAX_COST_SHARE_BPS,
    minViableNotionalUsdt: MIN_VIABLE_NOTIONAL_USDT,
    approvalThresholdUsdt: APPROVAL_THRESHOLD_USDT,
  }
}

/**
 * CEX 实盘/纸面路径的标准成本输入装配器。
 *
 * 存在的意义只有一个：**让「CEX 的成本假设是什么」这件事只有一个定义处**。
 * 调用方（autopilot / 面板 / 烟测）各自拼一份 `CostInput`，
 * 就会出现「模拟盘用 3bps、真实路径用 5bps」这种不会报错的分裂——
 * 而它们的差异最终只会表现为收益曲线对不上。所以装配逻辑收在这里。
 *
 * 注意 `expectedSlippageBps` 是**显式传入**的（默认取同源常量的当前值），
 * 不是「没给就算 0」：这是纪律 ② 在装配层的落地。
 */
export function liveCexCostInput(args: {
  venue: string
  notionalUsdt: number
  expectedEdgeBps: number
  holdingHours?: number
  /** 覆盖默认滑点假设（仅用于对照实验/烟测，不要在生产路径随手传）。 */
  expectedSlippageBps?: number
  isTaker?: boolean
}): CostInput {
  return {
    channel: 'cex',
    venue: args.venue,
    notionalUsdt: args.notionalUsdt,
    expectedEdgeBps: args.expectedEdgeBps,
    holdingHours: args.holdingHours,
    expectedSlippageBps: args.expectedSlippageBps ?? CEX_EXPECTED_SLIPPAGE_BPS,
    isTaker: args.isTaker ?? true,
  }
}
