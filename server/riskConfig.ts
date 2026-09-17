/**
 * 风控管理中心 —— 参数 schema、服务端校验、预设套件。
 *
 * 内化自 R20 Quantum Trader 的 `r20_backend/risk_config.py`。
 *
 * 职责边界（刻意收窄）：
 *   - 单一事实源在 `riskConstants.ts`（执行层 import 时读 .env 生效）；
 *   - 本模块**只**负责：给前端渲染用的元数据、写入前的服务端校验、当前生效值读取、预设套件。
 *
 * 为什么校验必须在服务端做一遍：
 *   UI 的 min/max 只是输入体验，真正的门禁必须在写 .env 之前——
 *   否则一个绕过 UI 的 POST 就能把「最大回撤」写成 999%，风控形同虚设。
 */

import { DEFAULTS, RISK_ENV_KEYS, LEVERAGE_HARD_CEILING, type RiskEnvKey } from './riskConstants.ts'

export interface RiskParamMeta {
  key: RiskEnvKey
  group: RiskGroupId
  label: string
  desc: string
  type: 'int' | 'float'
  min: number
  max: number
  step: number
  unit: string
  /** 显示换算：比例类参数原生是小数（0.2），UI 按 ×100 显示为 20%。 */
  displayScale: number
}

export type RiskGroupId = 'exposure' | 'per_trade' | 'stop_geometry' | 'stop_loss' | 'pyramiding' | 'gateway' | 'cost_trust' | 'micro_leverage'

export const GROUPS: { id: RiskGroupId; label: string; desc: string }[] = [
  { id: 'exposure', label: '仓位与敞口', desc: '同时持多少仓、单边敞口多大、单标的能吃掉多少保证金。' },
  { id: 'per_trade', label: '单笔风险门禁', desc: '每笔开仓在下单前必须通过的底线质量门槛。' },
  { id: 'stop_geometry', label: '止损几何', desc: 'ATR 宽止损、浮盈保本锁利、利润棘轮——决定「会不会被杂波扫损割肉」。' },
  { id: 'stop_loss', label: '时间止损与熔断', desc: '亏损与时间兜底：横盘时间止损、止损后冷静期、日亏熔断。' },
  { id: 'pyramiding', label: '顺势金字塔加仓', desc: '浮盈加仓的三重门禁：次数、底仓浮盈、置信度。设为 0 次即彻底禁止。' },
  { id: 'gateway', label: '执行网关硬约束', desc: '订单出站前的最后一道物理限额（迁移自既有硬编码，默认值未变）。' },
  {
    id: 'cost_trust',
    label: '成本与可信执行',
    desc:
      '交易成本是一等决策输入而不是事后统计：费率、资金费、滑点假设与「edge 必须盖过成本几倍」的硬约束都在这里。' +
      '下方还有人类在环审批门槛与对手方声誉下限 —— 它们共同决定「这笔交易值不值得做」和「允不允许自动做」。',
  },
  {
    id: 'micro_leverage',
    label: '微资金以小博大',
    desc:
      '小保证金 + 高杠杆的几何约束组。这一组不是「阈值」而是「几何关系」：' +
      '有效杠杆由止损距离反推，因为 125 倍的强平距离只有约 0.8%——' +
      '止损比它宽，止损就永远碰不到，价格先被强平。' +
      '杠杆越高，止损必须越紧，两者不能各自独立调。',
  },
]

const PARAMS: RiskParamMeta[] = [
  // ── 组 1 仓位与敞口 ──
  { key: 'EV_MAX_CONCURRENT_POSITIONS', group: 'exposure', label: '最高持仓数', desc: '同时持有的仓位总数上限。0 = 自动跟随标的池容量，超过池容量的配置会被钳制。', type: 'int', min: 0, max: 50, step: 1, unit: '仓', displayScale: 1 },
  { key: 'EV_MAX_SAME_DIRECTION_POSITIONS', group: 'exposure', label: '同向持仓上限', desc: '纯多或纯空各自的笔数上限，防高相关标的同向堆叠踩踏。不会超过总仓上限。', type: 'int', min: 1, max: 50, step: 1, unit: '仓', displayScale: 1 },
  { key: 'EV_MAX_MARGIN_EQUITY_RATIO', group: 'exposure', label: '单笔保证金占比', desc: '单笔下单占用保证金不得超过可用权益的这个比例。', type: 'float', min: 0.01, max: 1, step: 0.01, unit: '%', displayScale: 100 },
  { key: 'EV_SINGLE_ASSET_EQUITY_RATIO', group: 'exposure', label: '单标的累计保证金占比', desc: '同一标的（含金字塔加仓后）累计占用保证金占可用权益的上限。', type: 'float', min: 0.01, max: 1, step: 0.01, unit: '%', displayScale: 100 },
  { key: 'EV_MIN_LEVERAGE', group: 'exposure', label: '杠杆下限', desc: '自治引擎自主裁决杠杆的区间下限。调高下限 = 强制放大名义敞口，请配合日亏熔断使用。', type: 'float', min: 1, max: 125, step: 1, unit: 'x', displayScale: 1 },
  { key: 'EV_MAX_LEVERAGE', group: 'exposure', label: '杠杆上限', desc: '执行层强制钳制不超过此倍数。硬天花板 125x（代码内安全边界，配置无法抬高）。注意：这是**天花板不是目标值**——真正用几倍由止损距离反推，见「微资金以小博大」组。', type: 'float', min: 1, max: 125, step: 1, unit: 'x', displayScale: 1 },
  // ── 组 2 单笔风险门禁 ──
  { key: 'EV_RISK_PER_TRADE_RATIO', group: 'per_trade', label: '单笔风险额占比（1R）', desc: '单笔止损被打掉时允许亏损的金额占可用权益比例。仓位规模由 1R 与止损距离反推——止损放宽会自动缩量。', type: 'float', min: 0.001, max: 0.2, step: 0.001, unit: '%', displayScale: 100 },
  { key: 'EV_MIN_RISK_REWARD', group: 'per_trade', label: '最小盈亏比 R:R', desc: '盈亏比低于该值的开仓报价会被物理拦截，无论来自自治引擎还是人工。', type: 'float', min: 1, max: 10, step: 0.1, unit: ': 1', displayScale: 1 },
  { key: 'EV_MIN_ENTRY_CONFIDENCE', group: 'per_trade', label: '新开仓最低置信度', desc: '置信度低于该百分比时禁止新开仓（加仓另有独立门禁）。', type: 'float', min: 0, max: 100, step: 1, unit: '%', displayScale: 1 },
  // ── 组 3 止损几何（内化 R20 核心） ──
  { key: 'EV_ATR_PERIOD', group: 'stop_geometry', label: 'ATR 周期', desc: '计算波动尺度的 K 线根数。周期越大，止损越稳但越钝。', type: 'int', min: 5, max: 100, step: 1, unit: '根', displayScale: 1 },
  { key: 'EV_ATR_STOP_MULT_MIN', group: 'stop_geometry', label: '止损 ATR 乘数下限', desc: '结构外最低 1.8x ATR —— 低于这个值就是在往 15M/5M 噪音区里设损，必被插针扫掉。', type: 'float', min: 0.5, max: 6, step: 0.1, unit: '× ATR', displayScale: 1 },
  { key: 'EV_ATR_STOP_MULT_MAX', group: 'stop_geometry', label: '止损 ATR 乘数上限', desc: '2.2x 上限。再宽则单笔风险臃肿，同样的 1R 预算只能开出很小的仓位。', type: 'float', min: 0.5, max: 8, step: 0.1, unit: '× ATR', displayScale: 1 },
  { key: 'EV_STOP_SAFETY_PCT_MIN', group: 'stop_geometry', label: '止损安全垫下限', desc: '死水行情下 ATR 极小，仍保留 1.8% 的价格垫，避免止损贴脸。', type: 'float', min: 0, max: 0.2, step: 0.001, unit: '%', displayScale: 100 },
  { key: 'EV_STOP_SAFETY_PCT_MAX', group: 'stop_geometry', label: '止损安全垫上限', desc: '3.0% 上限，防 ATR 爆炸时止损被推到天边、单笔风险失控。', type: 'float', min: 0.001, max: 0.3, step: 0.001, unit: '%', displayScale: 100 },
  { key: 'EV_BREAKEVEN_TRIGGER_R', group: 'stop_geometry', label: '保本触发（R）', desc: '浮盈达到多少 R 时把止损拉到成本位。0.8R 是官方基准——此时「最坏结果 = 不亏」，从物理上杜绝盈利变割肉。', type: 'float', min: 0.1, max: 3, step: 0.1, unit: 'R', displayScale: 1 },
  { key: 'EV_BREAKEVEN_BUFFER_PCT', group: 'stop_geometry', label: '保本缓冲', desc: '保本止损设在成本价上方（多单）的这个比例，覆盖双边手续费与滑点。', type: 'float', min: 0, max: 0.02, step: 0.0005, unit: '%', displayScale: 100 },
  { key: 'EV_PROFIT_LOCK_TRIGGER_R', group: 'stop_geometry', label: '利润棘轮触发（R）', desc: '浮盈达到该 R 时进入棘轮一级：止损上移，锁定至少「利润锁定量 × ATR」。', type: 'float', min: 0.5, max: 5, step: 0.1, unit: 'R', displayScale: 1 },
  { key: 'EV_PROFIT_LOCK_ATR_MULT', group: 'stop_geometry', label: '利润锁定量', desc: '棘轮一级至少锁定的利润幅度（× ATR）。', type: 'float', min: 0, max: 5, step: 0.1, unit: '× ATR', displayScale: 1 },
  { key: 'EV_TRAIL_ACTIVATE_R', group: 'stop_geometry', label: '跟踪止损激活（R）', desc: '浮盈达该 R 后启用 ATR 跟踪止损。棘轮**只上移绝不下移**，这是锁利的物理保证。', type: 'float', min: 0.5, max: 10, step: 0.1, unit: 'R', displayScale: 1 },
  // ── 组 4 时间止损与熔断 ──
  { key: 'EV_TIME_STOP_HOURS', group: 'stop_loss', label: '最长持仓时间', desc: '持仓超过该时长且波幅仍不足横盘带宽时主动平仓，释放保证金与仓位配比。', type: 'float', min: 0.5, max: 168, step: 0.5, unit: '小时', displayScale: 1 },
  { key: 'EV_TIME_STOP_ATR_BAND', group: 'stop_loss', label: '横盘判定带宽', desc: '浮盈绝对值小于「该系数 × ATR」才判定为无突破横盘。调大更易触发时间止损。', type: 'float', min: 0, max: 2, step: 0.05, unit: '× ATR', displayScale: 1 },
  { key: 'EV_STOP_COOLDOWN_MINUTES', group: 'stop_loss', label: '止损后冷静期', desc: '某标的止损出局后，同向在该分钟内禁止再次开仓，防情绪化反手与连续磨损。', type: 'int', min: 0, max: 1440, step: 5, unit: '分钟', displayScale: 1 },
  { key: 'EV_DAILY_LOSS_EQUITY_RATIO', group: 'stop_loss', label: '日亏熔断比例', desc: '当日累计已实现亏损达到可用权益的这个比例时，本日停止新开仓。', type: 'float', min: 0.005, max: 0.5, step: 0.005, unit: '%', displayScale: 100 },
  { key: 'EV_MAX_DAILY_LOSS_USDC', group: 'stop_loss', label: '日亏绝对封顶', desc: '熔断线的绝对金额封顶（USDC）。实际生效取 min(本值, 权益×比例)；0 = 只看比例。', type: 'float', min: 0, max: 1_000_000, step: 10, unit: 'USDC', displayScale: 1 },
  // ── 组 5 顺势金字塔加仓 ──
  { key: 'EV_MAX_SCALE_IN_COUNT', group: 'pyramiding', label: '最大加仓次数', desc: '每个标的允许的顺势浮盈加仓次数。0 = 彻底禁止加仓（只允许底仓）。', type: 'int', min: 0, max: 10, step: 1, unit: '次', displayScale: 1 },
  { key: 'EV_MIN_SCALE_IN_PROFIT_RATIO', group: 'pyramiding', label: '加仓最小底仓浮盈', desc: '底仓浮盈达到该比例（保本之上）才允许顺势追加，绝不浮盈外加仓。', type: 'float', min: 0, max: 0.2, step: 0.001, unit: '%', displayScale: 100 },
  { key: 'EV_MIN_SCALE_IN_CONFIDENCE', group: 'pyramiding', label: '加仓最低置信度', desc: '金字塔加仓需达到的置信度门槛，通常应高于新开仓门禁。', type: 'float', min: 0, max: 100, step: 1, unit: '%', displayScale: 1 },
  // ── 组 6 执行网关 ──
  { key: 'EV_MAX_NOTIONAL_PER_ORDER', group: 'gateway', label: '单笔名义上限', desc: '单笔委托名义本金硬顶（USDC）。BTC 全平一次即 ≈ 此值，太小会导致永远无法平仓。', type: 'float', min: 100, max: 10_000_000, step: 1000, unit: 'USDC', displayScale: 1 },
  { key: 'EV_PRICE_DEVIATION_BPS', group: 'gateway', label: '价格偏离上限', desc: '委托价偏离标记价超过该值即拒绝（bps）。', type: 'float', min: 10, max: 10_000, step: 10, unit: 'bps', displayScale: 1 },
  { key: 'EV_MAX_ORDERS_PER_MINUTE', group: 'gateway', label: '每分钟最大下单数', desc: '防失控循环的下单频控。', type: 'int', min: 1, max: 600, step: 1, unit: '单', displayScale: 1 },
  { key: 'EV_MAX_DRAWDOWN_PCT', group: 'gateway', label: '最大回撤熔断', desc: '组合权益自峰值回撤达到该百分比即联动 killswitch 停止一切出站。', type: 'float', min: 1, max: 90, step: 1, unit: '%', displayScale: 1 },
  // ── 组 7 成本与可信执行 ──
  { key: 'EV_CEX_TAKER_FEE_BPS', group: 'cost_trust', label: 'CEX 市价费率', desc: '市价成交按 taker 计费。执行路径是市价单，用 maker 费率算成本会系统性低估——把「回测赚」变成「实盘亏」。', type: 'float', min: 0, max: 100, step: 0.5, unit: 'bps', displayScale: 1 },
  { key: 'EV_CEX_MAKER_FEE_BPS', group: 'cost_trust', label: 'CEX 挂单费率', desc: '仅用于「改挂单能省多少」的对照显示，不参与成本裁决——挂单可能不成交，省下的费率换成了机会成本。', type: 'float', min: 0, max: 100, step: 0.5, unit: 'bps', displayScale: 1 },
  { key: 'EV_CEX_EXPECTED_SLIPPAGE_BPS', group: 'cost_trust', label: 'CEX 预期滑点（单腿）', desc: '市价单的单腿滑点假设。CEX 订单簿冲击无法由单一深度值推算，成本闸门因此拒绝推测、只认这个显式值。默认与回测执行假设 slippageBps 对齐——两边不同源，就等于把差额偷偷塞进了盈利里。', type: 'float', min: 0, max: 500, step: 0.5, unit: 'bps', displayScale: 1 },
  { key: 'EV_DEX_LP_FEE_BPS', group: 'cost_trust', label: 'DEX 池 LP 费率', desc: 'Uniswap V3 主流 0.3% 池 = 30bps。进出两条腿各收一次。', type: 'float', min: 0, max: 300, step: 1, unit: 'bps', displayScale: 1 },
  { key: 'EV_FUNDING_RATE_BPS_PER_8H', group: 'cost_trust', label: '资金费基准', desc: '永续每 8 小时的资金费基准。按持仓时长摊算，方向一律取不利侧计入成本——不能假设自己总在收钱的那一边。', type: 'float', min: 0, max: 100, step: 0.1, unit: 'bps/8h', displayScale: 1 },
  { key: 'EV_DEX_MAX_PRICE_IMPACT_BPS', group: 'cost_trust', label: 'DEX 冲击上限', desc: '单腿价格冲击超过该值即拒绝：池深不足，这笔交易结构上不可行，与方向判断无关。', type: 'float', min: 5, max: 2000, step: 5, unit: 'bps', displayScale: 1 },
  { key: 'EV_MIN_EDGE_COST_MULTIPLE', group: 'cost_trust', label: 'edge/成本 最小倍数', desc: '预期毛收益必须是往返总成本的多少倍。调成 1 = 只要净额为正就放行（任何估算误差都会翻负）；3 的含义是成本得错到 3 倍以上才会由赚转亏。', type: 'float', min: 1, max: 20, step: 0.5, unit: '× 成本', displayScale: 1 },
  { key: 'EV_MAX_COST_SHARE_BPS', group: 'cost_trust', label: '成本占名义上限', desc: '往返成本占名义本金的上限（bps）。超出说明单笔太小、固定成本摊不开——加仓比调参数更有效。注意它有下界：必须高于 DEX 往返 LP 费率（默认 60bps），否则 DEX 通道会被默认值结构性关闭（进程启动时会断言）。', type: 'float', min: 1, max: 1000, step: 1, unit: 'bps', displayScale: 1 },
  { key: 'EV_MIN_VIABLE_NOTIONAL_USDT', group: 'cost_trust', label: '最小可行名义本金', desc: '低于此金额一律不开仓。它与滑点无关，是被固定成本（链上 gas、跨链桥费）决定的——这些费用不随金额缩小。', type: 'float', min: 10, max: 1_000_000, step: 10, unit: 'USDC', displayScale: 1 },
  { key: 'EV_APPROVAL_THRESHOLD_USDT', group: 'cost_trust', label: '实盘审批门槛', desc: '实盘动作金额达到该值即进入人工审批队列，代码无法自行放行。paper 环境不走此队列（但仍留痕）。', type: 'float', min: 0, max: 10_000_000, step: 100, unit: 'USDC', displayScale: 1 },
  { key: 'EV_APPROVAL_TTL_MINUTES', group: 'cost_trust', label: '审批有效期', desc: '审批请求的存活时长。过期即失效且不可补批——陈旧的审批比没有审批更危险，因为它会放行一个早已不成立的市场前提。', type: 'int', min: 1, max: 1440, step: 1, unit: '分钟', displayScale: 1 },
  { key: 'EV_COUNTERPARTY_MIN_REPUTATION', group: 'cost_trust', label: '对手方声誉下限', desc: '声誉分低于该值（0~1）即禁止新开敞口。声誉由本项目自己的结算史派生，不采信任何自报数据。', type: 'float', min: 0, max: 1, step: 0.05, unit: '分', displayScale: 1 },
  { key: 'EV_UNPROVEN_SIZE_MULTIPLIER', group: 'cost_trust', label: '未证实对手方敞口倍数', desc: '无历史样本的对手方允许的敞口倍数（0.5 = 半仓试探）。刻意不是 1（无据可依）也不是 0（新人永远无法积累信用）。', type: 'float', min: 0, max: 1, step: 0.05, unit: '×', displayScale: 1 },
  { key: 'EV_SETTLEMENT_TOLERANCE_BPS', group: 'cost_trust', label: '结算对账容差', desc: '义务金额与预留金额的允许偏差（bps）。超出即判金额漂移并标红，不得静默抹平。', type: 'float', min: 0, max: 500, step: 1, unit: 'bps', displayScale: 1 },
  { key: 'EV_SETTLEMENT_STALE_HOURS', group: 'cost_trust', label: '长期未结判定', desc: '结算义务超过该时长仍处未结状态即告警。只告警不作废——「长期没结」不等于「不存在」，自动作废会把真实敞口抹掉。', type: 'float', min: 1, max: 720, step: 1, unit: '小时', displayScale: 1 },
  // ── 组 8 微资金以小博大 ──
  { key: 'EV_ALLOW_MICRO_CAPITAL', group: 'micro_leverage', label: '微资金模式', desc: '1 = 允许「小保证金 + 杠杆」放大名义本金以跨过成本可行性地板；0 = 名义本金只能由保证金 1:1 提供。', type: 'int', min: 0, max: 1, step: 1, unit: '开关', displayScale: 1 },
  { key: 'EV_MIN_MARGIN_USDT', group: 'micro_leverage', label: '单笔最小保证金', desc: '起步档 1~10~100U 的下界。低于此金额的保证金档位没有意义（交易所最小下单量通常先到达）。', type: 'float', min: 0.1, max: 10_000, step: 0.1, unit: 'USDT', displayScale: 1 },
  { key: 'EV_LIQUIDATION_MAINT_MARGIN_PCT', group: 'micro_leverage', label: '维持保证金率', desc: '交易所的维持保证金率（OKX 主流档位约 0.5%）。直接进入强平价公式——填小了会让你以为强平更远。', type: 'float', min: 0.001, max: 0.2, step: 0.001, unit: '%', displayScale: 100 },
  { key: 'EV_LIQUIDATION_SAFETY_MULT', group: 'micro_leverage', label: '强平安全倍数', desc: '强平距离必须 ≥ 止损距离 × 本值。取 1.5 = 止损被打掉后至少还剩一半缓冲才轮到强平。这个缓冲是给滑点与插针留的物理空间，不是保守。低于 1 会被启动断言拒绝。', type: 'float', min: 1, max: 5, step: 0.1, unit: '×', displayScale: 1 },
  { key: 'EV_LIQUIDATION_FEE_BUFFER_BPS', group: 'micro_leverage', label: '强平费率缓冲', desc: '强平距离计算中扣减的费率+滑点缓冲（单边 bps）。杠杆越高，这一项在强平距离中的占比越大。', type: 'float', min: 0, max: 200, step: 1, unit: 'bps', displayScale: 1 },
  { key: 'EV_MIN_VIABLE_NOTIONAL_CEX_USDT', group: 'micro_leverage', label: 'CEX 最小可行名义本金', desc: 'CEX 通道的可行性地板。与「成本与可信执行」组那个地板是**两个不同的事实**：那个由链上 gas / 跨链桥固定成本决定，而 CEX 合约没有 gas，成本是纯比例项。把 gas 地板套到 CEX 上会让小额单永远无法成交（类别错误）。启动时断言本值 ≤ DEX 地板。', type: 'float', min: 1, max: 1_000_000, step: 1, unit: 'USDT', displayScale: 1 },
]

const INDEX = new Map<RiskEnvKey, RiskParamMeta>(PARAMS.map((p) => [p.key, p]))

/**
 * Schema 漂移自检（内化 R20 的 assert 范式）。
 *
 * 为什么值得为它写一段会在启动时抛异常的代码：
 *   风控参数最典型的失效方式不是报错，而是「UI 显示一套、执行层生效另一套」。
 *   键集对不上时静默放过，等于让人对着失真的面板做资金决策。
 *   这里宁可让进程**起不来**，也不让口径悄悄漂移。
 */
const schemaKeys = new Set<string>(PARAMS.map((p) => p.key))
const defaultKeys = new Set<string>(RISK_ENV_KEYS)
const missingInSchema = [...defaultKeys].filter((k) => !schemaKeys.has(k))
const missingInDefaults = [...schemaKeys].filter((k) => !defaultKeys.has(k))
if (missingInSchema.length > 0 || missingInDefaults.length > 0) {
  throw new Error(
    `[risk] 风控 schema 漂移：schema 缺 [${missingInSchema.join(', ')}]，DEFAULTS 缺 [${missingInDefaults.join(', ')}]。` +
      '请在 server/riskConfig.ts 的 PARAMS 与 server/riskConstants.ts 的 DEFAULTS 之间补齐。',
  )
}

/** 跨字段一致性硬校验（R20 的 clamp 思路：坏的中间态必须拒绝，而不是静默钳制）。 */
function crossFieldErrors(v: Partial<Record<RiskEnvKey, number>>, base: Record<RiskEnvKey, number>): string[] {
  const errors: string[] = []
  const pick = (k: RiskEnvKey) => (v[k] !== undefined ? (v[k] as number) : base[k])

  const total = pick('EV_MAX_CONCURRENT_POSITIONS')
  const same = pick('EV_MAX_SAME_DIRECTION_POSITIONS')
  if (total > 0 && same > total) errors.push(`同向持仓上限 (${same}) 不能高于最高持仓数 (${total})`)

  const levMin = pick('EV_MIN_LEVERAGE')
  const levMax = pick('EV_MAX_LEVERAGE')
  if (levMin > levMax) errors.push(`杠杆下限 (${levMin}x) 不能高于杠杆上限 (${levMax}x)`)

  const atrMin = pick('EV_ATR_STOP_MULT_MIN')
  const atrMax = pick('EV_ATR_STOP_MULT_MAX')
  if (atrMin > atrMax) errors.push(`止损 ATR 乘数下限 (${atrMin}) 不能高于上限 (${atrMax})`)

  const padMin = pick('EV_STOP_SAFETY_PCT_MIN')
  const padMax = pick('EV_STOP_SAFETY_PCT_MAX')
  if (padMin > padMax) errors.push(`止损安全垫下限 (${(padMin * 100).toFixed(2)}%) 不能高于上限 (${(padMax * 100).toFixed(2)}%)`)

  // 保本必须在利润棘轮之前触发，否则「先锁利再保本」逻辑上颠倒
  const be = pick('EV_BREAKEVEN_TRIGGER_R')
  const lock = pick('EV_PROFIT_LOCK_TRIGGER_R')
  if (be >= lock) errors.push(`保本触发 (${be}R) 必须早于利润棘轮触发 (${lock}R)`)

  // 杠杆天花板是代码内安全边界，面板不接受超过它的值（后端兜底，UI 的 max 只是体验）
  const levMaxRaw = pick('EV_MAX_LEVERAGE')
  if (levMaxRaw > LEVERAGE_HARD_CEILING) {
    errors.push(`杠杆上限 (${levMaxRaw}x) 超过硬天花板 ${LEVERAGE_HARD_CEILING}x（代码内安全边界，不可抬高）`)
  }

  // CEX 无 gas / 跨链桥固定成本，其可行性地板不可能高于 DEX 地板
  const cexFloor = pick('EV_MIN_VIABLE_NOTIONAL_CEX_USDT')
  const dexFloor = pick('EV_MIN_VIABLE_NOTIONAL_USDT')
  if (cexFloor > dexFloor) {
    errors.push(
      `CEX 最小名义本金 (${cexFloor}) 不能高于 DEX 地板 (${dexFloor})：` +
        'CEX 合约没有 gas / 跨链桥成本，把固定成本地板套到 CEX 上是类别错误',
    )
  }

  return errors
}

export function schema(): { groups: typeof GROUPS; params: (RiskParamMeta & { default: number })[] } {
  return {
    groups: GROUPS,
    params: PARAMS.map((p) => ({ ...p, default: DEFAULTS[p.key] })),
  }
}

/**
 * 校验**当前生效**的配置是否自洽。
 *
 * 为什么要单独暴露给前端：面板上展示的一组数字可能每一项都在合法区间内，
 * 却互相矛盾（例如「保本触发 1.5R」配「利润棘轮 1.0R」——等于先锁利再保本）。
 * 这种配置肉眼看不出来，只有跨字段校验能发现。前端据此在页头挂一条红色告警，
 * 而不是等下单被拒才知道配错了。
 */
export function validateCurrent(): string[] {
  return crossFieldErrors({}, currentValues())
}

export function currentValues(): Record<RiskEnvKey, number> {
  const out = {} as Record<RiskEnvKey, number>
  for (const p of PARAMS) {
    const raw = process.env[p.key]
    const fallback = DEFAULTS[p.key]
    if (raw === undefined || raw === '') {
      out[p.key] = fallback
      continue
    }
    const n = Number(raw)
    out[p.key] = p.type === 'int' ? Math.trunc(n) : Number.isFinite(n) ? n : fallback
  }
  return out
}

/**
 * 校验并归一化前端提交的 `{envKey: nativeValue}`，返回可直接写入 .env 的字符串映射。
 * 越界、未知键、跨字段冲突一律抛错（fail-closed），不做静默钳制。
 */
export function normalize(values: Record<string, unknown>, base?: Record<RiskEnvKey, number>): Record<string, string> {
  const unknown = Object.keys(values).filter((k) => !INDEX.has(k as RiskEnvKey))
  if (unknown.length > 0) throw new Error(`未知风控参数: ${unknown.sort().join(', ')}`)

  const parsed: Partial<Record<RiskEnvKey, number>> = {}
  const errors: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    const param = INDEX.get(key as RiskEnvKey)!
    const num = Number(raw)
    if (!Number.isFinite(num)) {
      errors.push(`${param.label}: 必须是数字，收到 ${JSON.stringify(raw)}`)
      continue
    }
    const normalized = param.type === 'int' ? Math.trunc(num) : Math.round(num * 1e6) / 1e6
    if (normalized < param.min || normalized > param.max) {
      errors.push(
        `${param.label}: 须在 ${param.min * param.displayScale}~${param.max * param.displayScale} ${param.unit} 之间（收到 ${normalized * param.displayScale}）`,
      )
      continue
    }
    parsed[key as RiskEnvKey] = normalized
  }

  const effectiveBase = base ?? currentValues()
  errors.push(...crossFieldErrors(parsed, effectiveBase))
  if (errors.length > 0) throw new Error(errors.join('；'))

  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
}

// ─────────────────────────────────────────────────────────────
// 预设套件（一键应用）
// 每套都是自洽的组合：不是「把几个数字调大」，而是换一套风险哲学。
// ─────────────────────────────────────────────────────────────
export interface RiskSuite {
  id: string
  name: string
  tagline: string
  desc: string
  values: Record<RiskEnvKey, number>
}

export const SUITES: RiskSuite[] = [
  {
    id: 'conservative',
    name: '🛡️ 稳健防守',
    tagline: '本金安全绝对优先',
    desc:
      '适合新账户、小资金或高波动恶劣行情：单笔风险压到 0.5%、盈亏比门槛抬到 2.5R、杠杆锁 1x、' +
      '彻底禁止金字塔加仓、日亏 3% 熔断。止损乘数取上限 2.2x 并配 2.5% 安全垫——牺牲交易频率换极低回撤。',
    values: {
      ...DEFAULTS,
      EV_MAX_CONCURRENT_POSITIONS: 2,
      EV_MAX_SAME_DIRECTION_POSITIONS: 1,
      EV_MAX_MARGIN_EQUITY_RATIO: 0.1,
      EV_SINGLE_ASSET_EQUITY_RATIO: 0.15,
      EV_MIN_LEVERAGE: 1,
      EV_MAX_LEVERAGE: 1,
      EV_RISK_PER_TRADE_RATIO: 0.005,
      EV_MIN_RISK_REWARD: 2.5,
      EV_MIN_ENTRY_CONFIDENCE: 80,
      EV_ATR_STOP_MULT_MIN: 2.0,
      EV_ATR_STOP_MULT_MAX: 2.2,
      EV_STOP_SAFETY_PCT_MIN: 0.025,
      EV_STOP_SAFETY_PCT_MAX: 0.03,
      EV_BREAKEVEN_TRIGGER_R: 0.6,
      EV_TIME_STOP_HOURS: 12,
      EV_TIME_STOP_ATR_BAND: 0.1,
      EV_STOP_COOLDOWN_MINUTES: 60,
      EV_DAILY_LOSS_EQUITY_RATIO: 0.03,
      EV_MAX_SCALE_IN_COUNT: 0,
      EV_MIN_SCALE_IN_PROFIT_RATIO: 0.012,
      EV_MIN_SCALE_IN_CONFIDENCE: 85,
    },
  },
  {
    id: 'balanced',
    name: '⚖️ 均衡波段',
    tagline: '推荐默认 · 攻守兼备',
    desc:
      '系统出厂基线：同向 2 仓防共振、单笔保证金 20% 硬顶、1% 单笔风险、2.0R 盈亏比底线、' +
      '1.8~2.2x ATR 宽止损 + 0.8R 保本移损、8 小时时间止损释放配比、允许 1 次严格浮盈加仓。适合日常 1H~4H 波段运营。',
    values: { ...DEFAULTS },
  },
  {
    id: 'aggressive',
    name: '🚀 进取猎手',
    tagline: '单边趋势市 · 经验账户专用',
    desc:
      '适合明确单边主升/主跌浪与老手账户：同向放宽至 3 仓吃足趋势、置信度门禁降至 60% 抢先上车、' +
      '允许 2 次金字塔加仓放大盈利单、持仓时间放宽至 16 小时、杠杆放到 3x。' +
      '回撤与熔断线同步放大，风险自负。',
    values: {
      ...DEFAULTS,
      EV_MAX_CONCURRENT_POSITIONS: 0,
      EV_MAX_SAME_DIRECTION_POSITIONS: 3,
      EV_MAX_MARGIN_EQUITY_RATIO: 0.3,
      EV_SINGLE_ASSET_EQUITY_RATIO: 0.5,
      EV_MIN_LEVERAGE: 2,
      EV_MAX_LEVERAGE: 3,
      EV_RISK_PER_TRADE_RATIO: 0.02,
      EV_MIN_RISK_REWARD: 2.0,
      EV_MIN_ENTRY_CONFIDENCE: 60,
      EV_ATR_STOP_MULT_MIN: 1.8,
      EV_ATR_STOP_MULT_MAX: 2.0,
      EV_STOP_SAFETY_PCT_MIN: 0.018,
      EV_STOP_SAFETY_PCT_MAX: 0.025,
      EV_BREAKEVEN_TRIGGER_R: 1.0,
      EV_TIME_STOP_HOURS: 16,
      EV_TIME_STOP_ATR_BAND: 0.2,
      EV_STOP_COOLDOWN_MINUTES: 15,
      EV_DAILY_LOSS_EQUITY_RATIO: 0.08,
      EV_MAX_SCALE_IN_COUNT: 2,
      EV_MIN_SCALE_IN_PROFIT_RATIO: 0.006,
      EV_MIN_SCALE_IN_CONFIDENCE: 62,
    },
  },
]

// 套件自检：值必须落在 schema 区间内、且跨字段自洽。任一不合法即启动失败——
// 一个「点了就应用一套非法风控」的按钮，比没有按钮危险得多。
for (const suite of SUITES) {
  for (const [key, value] of Object.entries(suite.values)) {
    const param = INDEX.get(key as RiskEnvKey)
    if (!param) throw new Error(`[risk] 套件 ${suite.id} 含未知键 ${key}`)
    if (value < param.min || value > param.max) {
      throw new Error(`[risk] 套件 ${suite.id} 越界：${key}=${value} 不在 [${param.min}, ${param.max}]`)
    }
  }
  const errs = crossFieldErrors(suite.values, { ...DEFAULTS })
  if (errs.length > 0) throw new Error(`[risk] 套件 ${suite.id} 跨字段冲突：${errs.join('；')}`)
}

export function suiteValues(suiteId: string): Record<RiskEnvKey, number> {
  const suite = SUITES.find((s) => s.id === suiteId)
  if (!suite) throw new Error(`未知风控预设套件: ${suiteId}`)
  return { ...suite.values }
}
