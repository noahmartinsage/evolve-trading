/**
 * 物理拦截闸门管线 (Interceptor Pipeline) —— Fail-Closed 语义。
 *
 * 内化自 R20 Quantum Trader 的 `r20_backend/interceptor_manager.py` +
 * `plugins/interceptors/*.py` 体系。
 *
 * ## 核心思想
 *
 * 决策链路上有两类规则，危险程度完全不同：
 *   - **模型层规则**（写在提示词里）：「不要逆势开仓」「盈亏比要够」。
 *     LLM 会遵守 95% 的次数 —— 而金融系统里那 5% 就是全部风险。
 *   - **物理层规则**（写在这里）：同理，但**由代码强制**，模型无论如何都想不通、
 *     幻觉、被提示词注入操纵，都过不去。
 *
 * R20 把后者叫「物理拦截插件」：模型规则完全透明可见，但底座用代码物理兜底。
 * 本模块就是 EVOLVE 的底座。
 *
 * ## 一处刻意不照搬 R20 的设计
 *
 * R20 用 `importlib` 从磁盘动态加载任意 Python 文件作为拦截器，靠 `deepcopy`
 * 隔离输入来防插件篡改。**EVOLVE 不这么做**：
 *   本进程与账本、执行网关同进程运行，一旦允许动态执行外部代码，
 *   攻击面就不再是「插件写错规则」，而是「插件直接改 state / 关掉风控 / 读密钥」——
 *   深拷贝挡得住参数篡改，挡不住 `process.env` 与 `require('fs')`。
 *
 * 所以这里的内置拦截器是**仓内受控模块**：类型化、可评审、进 CI。
 * 「热插拔」通过运行期 **启停 + 排序** 实现，而不是任意代码注入。
 * 这是有意的安全取舍，不是能力缺失。
 */

import { MIN_ENTRY_CONFIDENCE, MIN_RISK_REWARD_RATIO } from './riskConstants.ts'
import { validateQuoteGeometry } from './orderRisk.ts'

export type MacroTrend = 'BULL' | 'BEAR' | 'RANGE'

/** 决策时刻的「市场特征包」——拦截器只能读它，不能改它（见 runPipeline 的深拷贝隔离）。 */
export interface MarketPackage {
  symbol: string
  dataQuality: 'valid' | 'stale' | 'insufficient'
  price: number
  atr: number
  bars: number
  /** 1H ADX（趋势强度）；K 线不足时为 undefined，视为「未知」并放行（不阻塞）。 */
  adx1h?: number
  /** 高周期趋势方向，由 resample 后判定。 */
  macroTrend: MacroTrend
  macroTrendSource: string
}

export interface TradeDecision {
  action: 'BUY_LONG' | 'SELL_SHORT' | 'WAIT'
  confidence: number
  entryPrice?: number
  takeProfitPrice?: number
  stopLossPrice?: number
  strategyId?: string
}

export interface InterceptorContext {
  now: number
  equity: number
  killswitch: boolean
  openPositions: { symbol: string; side: 'long' | 'short' }[]
  /** 止损冷静期是否处于封锁状态（由 positionGuard 判定后传入，保持管线无状态）。 */
  cooldownBlocked: boolean
  cooldownReason?: string
  /** 已实现的当日亏损（正数表示亏损额）。 */
  dailyLoss?: number
  dailyLossLimit?: number
}

export interface InterceptorResult {
  passed: boolean
  reason?: string
  /** 结构化拒绝码，便于归因统计与 UI 着色。 */
  code?: string
}

export interface Interceptor {
  id: string
  name: string
  desc: string
  /** 官方内置 vs 自定义。内置不可删除，只能停用。 */
  builtin: boolean
  /** 安全地板级拦截器：不可停用（关掉它等于关掉物理兜底）。 */
  mandatory: boolean
  enabled: boolean
  /** 数字越小越先执行。 */
  order: number
  check: (pkg: MarketPackage, decision: TradeDecision, ctx: InterceptorContext) => InterceptorResult
}

const PASS: InterceptorResult = { passed: true }

function reject(code: string, reason: string): InterceptorResult {
  return { passed: false, code, reason }
}

// ─────────────────────────────────────────────────────────────
// 内置拦截器（官方预设）
// ─────────────────────────────────────────────────────────────

const BUILTIN_INTERCEPTORS: Interceptor[] = [
  {
    id: 'core.data_quality',
    name: '行情数据完整性',
    desc: '关键原始行情不完整或已过期时拒绝开仓。数据不可信的决策比不决策更危险。',
    builtin: true,
    mandatory: true,
    enabled: true,
    order: 10,
    check: (pkg, decision) => {
      if (decision.action === 'WAIT') return PASS
      if (pkg.dataQuality !== 'valid') {
        return reject('DATA_QUALITY', `关键原始行情不完整（${pkg.dataQuality}），安全降级为 WAIT`)
      }
      if (!(pkg.price > 0) || !Number.isFinite(pkg.price)) {
        return reject('DATA_QUALITY', '标记价缺失或非有限数值，安全降级为 WAIT')
      }
      return PASS
    },
  },
  {
    id: 'core.killswitch',
    name: '熔断总闸',
    desc: 'killswitch 激活期间拒绝一切新开仓意图。',
    builtin: true,
    mandatory: true,
    enabled: true,
    order: 20,
    check: (_pkg, decision, ctx) => {
      if (decision.action === 'WAIT') return PASS
      if (ctx.killswitch) return reject('KILLSWITCH', '熔断已激活，拒绝一切新开仓意图')
      return PASS
    },
  },
  {
    id: 'core.cooldown',
    name: '止损后冷静期',
    desc: '某标的止损出局后同向在窗口内禁止再开仓，防情绪化反手与连续磨损。',
    builtin: true,
    mandatory: false,
    enabled: true,
    order: 30,
    check: (_pkg, decision, ctx) => {
      if (decision.action === 'WAIT') return PASS
      if (ctx.cooldownBlocked) {
        return reject('STOP_COOLDOWN', ctx.cooldownReason ?? '该标的处于止损冷静期内，禁止再开仓')
      }
      return PASS
    },
  },
  {
    id: 'core.position_conflict',
    name: '反向持仓冲突',
    desc: '已有反向持仓时禁止借决策通道反向开仓（会先平后开，来回磨损）。',
    builtin: true,
    mandatory: true,
    enabled: true,
    order: 40,
    check: (pkg, decision, ctx) => {
      if (decision.action === 'WAIT') return PASS
      const want: 'long' | 'short' = decision.action === 'BUY_LONG' ? 'long' : 'short'
      const existing = ctx.openPositions.find((p) => p.symbol.toUpperCase() === pkg.symbol.toUpperCase())
      if (existing && existing.side !== want) {
        return reject('POSITION_CONFLICT', `已有反向持仓（${existing.side}），禁止借决策通道反向开仓，安全降级为 WAIT`)
      }
      return PASS
    },
  },
  {
    id: 'core.quote_geometry_rr',
    name: '真实盈亏比门禁',
    desc: `入场/止盈/止损必须构成合法几何，且 R:R ≥ ${MIN_RISK_REWARD_RATIO.toFixed(1)}。拒绝赔率不足的劣质交易。`,
    builtin: true,
    mandatory: true,
    enabled: true,
    order: 50,
    check: (_pkg, decision) => {
      if (decision.action === 'WAIT') return PASS
      const { entryPrice: e, takeProfitPrice: t, stopLossPrice: s } = decision
      if (e === undefined || t === undefined || s === undefined) {
        return reject('GEOMETRY_MISSING', '开仓报价缺少入场/止盈/止损三价之一，安全降级为 WAIT')
      }
      const check = validateQuoteGeometry({ action: decision.action, entry: e, takeProfit: t, stopLoss: s })
      if (!check.valid) return reject('RISK_REWARD', check.reason)
      return PASS
    },
  },
  {
    id: 'filter.macro_trend',
    name: '高周期顺势铁律',
    desc: '高周期处于多头通道时严禁逆势摸顶开空；空头承压时严禁逆势接飞刀做多。',
    builtin: true,
    mandatory: false,
    enabled: true,
    order: 60,
    check: (pkg, decision) => {
      if (decision.action === 'WAIT') return PASS
      if (decision.action === 'SELL_SHORT' && pkg.macroTrend === 'BULL') {
        return reject('MACRO_TREND', `${pkg.macroTrendSource} 处于多头主升通道，顺势铁律拦截逆势摸顶开空，安全降级为 WAIT`)
      }
      if (decision.action === 'BUY_LONG' && pkg.macroTrend === 'BEAR') {
        return reject('MACRO_TREND', `${pkg.macroTrendSource} 处于空头承压通道，顺势铁律拦截逆势接飞刀做多，安全降级为 WAIT`)
      }
      return PASS
    },
  },
  {
    id: 'filter.adx_regime',
    name: '震荡杂波过滤',
    desc: '1H ADX 低于 18（R20 基准）时视为无序震荡市，拒绝开仓——猴市横盘只会被手续费磨死。',
    builtin: true,
    mandatory: false,
    enabled: true,
    order: 70,
    check: (pkg, decision) => {
      if (decision.action === 'WAIT') return PASS
      const adxValue = pkg.adx1h
      // 数据不足时「未知」，不阻塞。宁可放过一个机会，也不因指标算不出来就冻结系统。
      if (adxValue === undefined || !Number.isFinite(adxValue)) return PASS
      if (adxValue > 0 && adxValue < 18) {
        return reject('ADX_REGIME', `1H ADX 趋势强度仅 ${adxValue.toFixed(1)}（< 18），处于无序震荡杂波市，安全降级为 WAIT`)
      }
      return PASS
    },
  },
  {
    id: 'gate.entry_confidence',
    name: '高置信度质量门禁',
    desc: `置信度低于 ${MIN_ENTRY_CONFIDENCE}%（全局基准）时禁止新开仓，兼顾开仓欲望与胜率质量。`,
    builtin: true,
    mandatory: false,
    enabled: true,
    order: 80,
    check: (_pkg, decision) => {
      if (decision.action === 'WAIT') return PASS
      const conf = Number(decision.confidence)
      if (!Number.isFinite(conf)) {
        return reject('CONFIDENCE', '置信度必须是有效数字，安全降级为 WAIT')
      }
      if (conf < MIN_ENTRY_CONFIDENCE) {
        return reject('CONFIDENCE', `置信度 ${conf.toFixed(1)}% 低于全局基准门禁 ${MIN_ENTRY_CONFIDENCE.toFixed(0)}%，安全降级为 WAIT`)
      }
      return PASS
    },
  },
  {
    id: 'gate.daily_loss',
    name: '日亏熔断门禁',
    desc: '当日累计已实现亏损达到限额时，本日停止新开仓（存量仓位仍由止损守护）。',
    builtin: true,
    mandatory: false,
    enabled: true,
    order: 90,
    check: (_pkg, decision, ctx) => {
      if (decision.action === 'WAIT') return PASS
      const loss = ctx.dailyLoss
      const limit = ctx.dailyLossLimit
      if (loss === undefined || limit === undefined || !(limit > 0)) return PASS
      if (loss >= limit) {
        return reject('DAILY_LOSS_BREAKER', `当日已实现亏损 ${loss.toFixed(2)} 已达熔断线 ${limit.toFixed(2)}，本日停止新开仓`)
      }
      return PASS
    },
  },
]

// ─────────────────────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────────────────────

const registry = new Map<string, Interceptor>()

for (const it of BUILTIN_INTERCEPTORS) registry.set(it.id, { ...it })

export function listInterceptors(): Interceptor[] {
  return [...registry.values()].sort((a, b) => a.order - b.order)
}

/** 启停拦截器。mandatory 的不可停用（关掉它等于关掉物理兜底）。 */
export function setInterceptorEnabled(id: string, enabled: boolean): Interceptor {
  const it = registry.get(id)
  if (!it) throw new Error(`未知拦截器: ${id}`)
  if (it.mandatory && !enabled) throw new Error(`拦截器 [${it.name}] 属于强制地板，不可停用`)
  it.enabled = enabled
  return it
}

export function reorderInterceptors(ids: string[]): Interceptor[] {
  const unknown = ids.filter((id) => !registry.has(id))
  if (unknown.length > 0) throw new Error(`未知拦截器: ${unknown.join(', ')}`)
  ids.forEach((id, i) => {
    const it = registry.get(id)!
    it.order = (i + 1) * 10
  })
  return listInterceptors()
}

/** 仅供测试与状态重置使用。 */
export function resetInterceptors(): void {
  registry.clear()
  for (const it of BUILTIN_INTERCEPTORS) registry.set(it.id, { ...it })
}

// ─────────────────────────────────────────────────────────────
// 管线执行
// ─────────────────────────────────────────────────────────────

export interface PipelineResult {
  /** 最终动作：全通过时等于原始动作，任一拦截则降级为 WAIT。 */
  finalAction: 'BUY_LONG' | 'SELL_SHORT' | 'WAIT'
  reason: string
  code?: string
  /** 被哪个拦截器拦下的（用于归因与 UI 定位）。 */
  blockedBy?: string
  /** 通过了几道闸 / 共几道（透明化：让人看到「这次决策过了多少道检查」）。 */
  checked: number
  total: number
  trail: { id: string; name: string; passed: boolean; reason?: string; code?: string }[]
}

/**
 * 执行拦截闸门管线。
 *
 * Fail-Closed 的三条具体落法（缺一不可）：
 *   ① 拦截器**抛异常** → 降级为 WAIT，而不是「跳过这个继续下一个」；
 *   ② 拦截器**返回非法结构** → 降级为 WAIT；
 *   ③ 标记为 **mandatory 的拦截器缺失** → 整条管线降级为 WAIT。
 *
 * 第 ③ 条最容易被忽略：如果攻击者能移除一个检查项而系统继续放行，
 * 那么「有风控」就是错觉。所以这里对缺失的强制项零容忍。
 */
export function runPipeline(pkg: MarketPackage, decision: TradeDecision, ctx: InterceptorContext): PipelineResult {
  const interceptors = listInterceptors().filter((i) => i.enabled)
  const trail: PipelineResult['trail'] = []

  // 强制地板缺失检查 —— 先于一切
  const enabledIds = new Set(interceptors.map((i) => i.id))
  const missingMandatory = BUILTIN_INTERCEPTORS.filter((i) => i.mandatory && !enabledIds.has(i.id))
  if (missingMandatory.length > 0) {
    return {
      finalAction: 'WAIT',
      reason: `强制风控项缺失（${missingMandatory.map((m) => m.name).join('、')}），系统拒绝出决策`,
      code: 'MANDATORY_MISSING',
      blockedBy: 'pipeline',
      checked: 0,
      total: interceptors.length,
      trail,
    }
  }

  const normalized: TradeDecision = { ...decision }
  if (normalized.action !== 'BUY_LONG' && normalized.action !== 'SELL_SHORT' && normalized.action !== 'WAIT') {
    normalized.action = 'WAIT'
    normalized.confidence = 0
  }

  // 原始动作就是 WAIT：没有要放行的东西，直接返回（跳过后续检查，但仍回报闸数）
  if (normalized.action === 'WAIT') {
    return { finalAction: 'WAIT', reason: '', checked: interceptors.length, total: interceptors.length, trail }
  }

  let checked = 0
  for (const it of interceptors) {
    checked += 1
    try {
      // 输入隔离：拦截器拿到的是深拷贝，无法通过改参数绕过后续检查
      const pkgCopy: MarketPackage = structuredClone(pkg)
      const decCopy: TradeDecision = structuredClone(normalized)
      const ctxCopy: InterceptorContext = structuredClone(ctx)

      const result = it.check(pkgCopy, decCopy, ctxCopy)

      if (!result || typeof result.passed !== 'boolean') {
        trail.push({ id: it.id, name: it.name, passed: false, reason: '拦截器返回结构非法', code: 'INVALID_RESULT' })
        return {
          finalAction: 'WAIT',
          reason: `风控拦截器 [${it.name}] 返回结构非法，安全降级为 WAIT`,
          code: 'INVALID_RESULT',
          blockedBy: it.id,
          checked,
          total: interceptors.length,
          trail,
        }
      }

      trail.push({ id: it.id, name: it.name, passed: result.passed, reason: result.reason, code: result.code })

      if (!result.passed) {
        return {
          finalAction: 'WAIT',
          reason: result.reason ?? `触发风控拦截器 [${it.name}]`,
          code: result.code,
          blockedBy: it.id,
          checked,
          total: interceptors.length,
          trail,
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      trail.push({ id: it.id, name: it.name, passed: false, reason: `运行异常: ${msg}`, code: 'INTERCEPTOR_ERROR' })
      return {
        finalAction: 'WAIT',
        reason: `风控拦截器 [${it.name}] 运行异常（${msg}），安全降级为 WAIT`,
        code: 'INTERCEPTOR_ERROR',
        blockedBy: it.id,
        checked,
        total: interceptors.length,
        trail,
      }
    }
  }

  return { finalAction: normalized.action, reason: '', checked, total: interceptors.length, trail }
}

// ─────────────────────────────────────────────────────────────
// 沙箱单测（一键验证拦截器是否真的在拦）
// ─────────────────────────────────────────────────────────────

export interface SandboxScenario {
  name: string
  expectBlockedBy?: string
  package: MarketPackage
  decision: TradeDecision
  context: Partial<InterceptorContext>
}

export interface SandboxResult {
  name: string
  expected: string
  actual: string
  verdict: 'pass' | 'unexpected_pass' | 'unexpected_block' | 'wrong_interceptor'
  reason: string
  trail: PipelineResult['trail']
}

function baseContext(overrides: Partial<InterceptorContext> = {}): InterceptorContext {
  return {
    now: 1_700_000_000_000,
    equity: 100_000,
    killswitch: false,
    openPositions: [],
    cooldownBlocked: false,
    ...overrides,
  }
}

function basePackage(overrides: Partial<MarketPackage> = {}): MarketPackage {
  return {
    symbol: 'BTCUSDT',
    dataQuality: 'valid',
    price: 78_000,
    atr: 780,
    bars: 1200,
    adx1h: 26,
    macroTrend: 'RANGE',
    macroTrendSource: '高周期(240根聚合)',
    ...overrides,
  }
}

/** 标准场景集：每个场景对应一道拦截器，验证「该拦的确实拦住了」。 */
const SCENARIOS: SandboxScenario[] = [
  {
    name: '场景 1 · 4H 多头通道中逆势摸顶开空（应被顺势铁律拦截）',
    expectBlockedBy: 'filter.macro_trend',
    package: basePackage({ macroTrend: 'BULL' }),
    decision: { action: 'SELL_SHORT', confidence: 90, entryPrice: 78_000, takeProfitPrice: 74_000, stopLossPrice: 79_000 },
    context: {},
  },
  {
    name: '场景 2 · 无序震荡市 ADX 仅 12（应被震荡过滤拦截）',
    expectBlockedBy: 'filter.adx_regime',
    package: basePackage({ adx1h: 12 }),
    decision: { action: 'BUY_LONG', confidence: 90, entryPrice: 78_000, takeProfitPrice: 80_000, stopLossPrice: 77_000 },
    context: {},
  },
  {
    name: '场景 3 · 盈亏比仅 1.0R（应被赔率门禁拦截）',
    expectBlockedBy: 'core.quote_geometry_rr',
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 90, entryPrice: 78_000, takeProfitPrice: 79_000, stopLossPrice: 77_000 },
    context: {},
  },
  {
    name: '场景 4 · 买多但止损高于入场价（几何非法，应被拦截）',
    expectBlockedBy: 'core.quote_geometry_rr',
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 90, entryPrice: 78_000, takeProfitPrice: 82_000, stopLossPrice: 79_000 },
    context: {},
  },
  {
    name: '场景 5 · 置信度仅 55%（应被置信度门禁拦截）',
    expectBlockedBy: 'gate.entry_confidence',
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 55, entryPrice: 78_000, takeProfitPrice: 82_000, stopLossPrice: 76_500 },
    context: {},
  },
  {
    name: '场景 6 · 止损冷静期内再开仓（应被冷静期拦截）',
    expectBlockedBy: 'core.cooldown',
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 90, entryPrice: 78_000, takeProfitPrice: 82_000, stopLossPrice: 76_500 },
    context: { cooldownBlocked: true, cooldownReason: '该标的多向刚止损出局，冷静期剩余 20 分钟' },
  },
  {
    name: '场景 7 · 熔断激活期开仓（应被熔断总闸拦截）',
    expectBlockedBy: 'core.killswitch',
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 90, entryPrice: 78_000, takeProfitPrice: 82_000, stopLossPrice: 76_500 },
    context: { killswitch: true },
  },
  {
    name: '场景 8 · 合法报价（应全部放行）',
    expectBlockedBy: undefined,
    package: basePackage(),
    decision: { action: 'BUY_LONG', confidence: 88, entryPrice: 78_000, takeProfitPrice: 82_500, stopLossPrice: 76_500 },
    context: {},
  },
]

const PASS_LABEL = '(放行)'

function judge(scenario: SandboxScenario): SandboxResult {
  const outcome = runPipeline(scenario.package, scenario.decision, baseContext(scenario.context))
  const expected = scenario.expectBlockedBy ?? PASS_LABEL
  const actual = outcome.finalAction === 'WAIT' ? (outcome.blockedBy ?? '(未知拦截者)') : PASS_LABEL

  let verdict: SandboxResult['verdict']
  if (expected === actual) verdict = 'pass'
  else if (actual === PASS_LABEL) verdict = 'unexpected_pass'
  else if (expected === PASS_LABEL) verdict = 'unexpected_block'
  else verdict = 'wrong_interceptor'

  return { name: scenario.name, expected, actual, verdict, reason: outcome.reason, trail: outcome.trail }
}

/**
 * 沙箱自测：拿标准场景集跑一遍管线，验证「该拦的确实拦住了、该放行的确实放行了」。
 * 这是给风控管理页的「一键验证」按钮用的 —— 风控最怕的不是规则不对，
 * 而是有人以为自己配了规则、实际因为顺序或启停状态根本没生效。
 */
export function runSandboxTest(scenarios: SandboxScenario[] = SCENARIOS): {
  total: number
  passed: number
  results: SandboxResult[]
} {
  const results = scenarios.map(judge)
  return { total: results.length, passed: results.filter((r) => r.verdict === 'pass').length, results }
}
