import {
  runBacktest,
  computeReport,
  computeFitness,
  evaluateCandidateGrid,
  buildCandidateSet,
  contentHash,
  walkForward,
  DEFAULT_GRID_EXEC,
} from '../src/engine/index.ts'
import type { Candle, Strategy, StrategyContext } from '../src/engine/index.ts'
import { DEFAULT_OVERFIT_THRESHOLDS, judgeOverfit } from '../src/engine/overfit.ts'
import type { OverfitOutcome } from '../src/engine/overfit.ts'
import { atr as computeAtr } from '../src/engine/indicators.ts'
import { appendEvent } from './ledger.ts'
import { processLiveIntent, processOrderIntent } from './core.ts'
import type { OrchState } from './types.ts'
import { ATR_PERIOD, MIN_MARGIN_USDT, MIN_VIABLE_NOTIONAL_CEX_USDT, SPOT_MAX_LEVERAGE, TIME_STOP_HOURS, dailyLossLimit } from './riskConstants.ts'
import { assessEdge, liveCexCostInput } from './costModel.ts'
import {
  applyStopAction,
  canScaleIn,
  checkCooldown,
  closePosition,
  computeStopGeometry,
  evaluatePosition,
  getPosition,
  marginRequired,
  openPosition,
  rMultiple,
  sizePositionFromRisk,
  unrealizedRoi,
  updatePosition,
} from './positionGuard.ts'
import type { PositionSide } from './positionGuard.ts'
import { reviewAndAudit } from './makerChecker.ts'
import { deriveStructureTarget, getRegime, refreshRegime, stopAtrFor } from './marketRegime.ts'
import type { RegimeSnapshot } from './marketRegime.ts'
import { runPipeline } from './interceptors.ts'
import type { InterceptorContext, MarketPackage, TradeDecision } from './interceptors.ts'
import { classifySnapshotObservability, pruneSnapshot } from './decisionObservability.ts'
import type { Observability } from './decisionObservability.ts'
import { getReservationManager } from './riskReservation.ts'
import { STATE_CONFIRMED, STATE_CLOSED, STATE_PENDING, STATE_REJECTED, STATE_UNKNOWN } from './riskReservation.ts'

export type AutopilotStage = 'idle' | 'accumulating' | 'optimizing' | 'trading' | 'target_reached' | 'drawdown_stopped'

export interface AutopilotStatus {
  running: boolean
  stage: AutopilotStage
  mode: 'paper' | 'live'
  symbol: string
  targetPct: number
  startedAt: number | null
  baselineEquity: number | null
  equity: number
  pnlPct: number | null
  cycles: number
  barsAccumulated: number
  winner: string | null
  lastActionAt: number | null
  /** 持仓守护状态（内化 R20 的宽止损 + 保本锁利），无持仓时为 null。 */
  guard: {
    side: PositionSide
    entryPrice: number
    qty: number
    initialStop: number
    currentStop: number
    r: number
    unrealizedRoiPct: number
    breakevenArmed: boolean
    lockArmed: boolean
    openedAgoMin: number
    atrAtEntry: number
  } | null
  /** 最近一次被风控拦截的决策——回答「为什么系统没做这笔交易」。 */
  lastInterception: { at: number; reason: string; code?: string; blockedBy?: string } | null
  /**
   * 最近一次被**过拟合门**否决的策略选择（F-47）。
   *
   * 与 `lastInterception` 并列而不是合并：那个回答「为什么这单没下」，
   * 这个回答「为什么连交易阶段都没进」。合成一个字段会让
   * 「策略一直在被挑、只是挑不出来」和「挑出来了但下单被拦」看起来是同一件事。
   */
  gateRefusal: {
    at: number
    outcome: OverfitOutcome
    summary: string
    bars: number
    folds: number
    pbo: number | null
    /** 下一次重判所需的 K 线根数（= 本次 bars + GATE_RETRY_BARS）。 */
    retryAtBars: number
  } | null
  /** 当日已实现亏损与熔断线（USDC）。 */
  dailyLoss: number
  dailyLossLimit: number
  /** 高周期市场状态快照。 */
  regime: {
    macroTrend: string
    macroTrendSource: string
    atr1h: number
    adx1h: number | null
    stale: boolean
  } | null
}

interface Deps {
  getState(): OrchState
}

let deps: Deps | null = null

const SYMBOL = process.env.AUTOPILOT_SYMBOL ?? 'BTCUSDT'
const MIN_BARS = 120
/** 自动驾驶自身的回撤保护线（区别于编排器 killswitch 的 EV_MAX_DRAWDOWN_PCT）。 */
const AUTOPILOT_DRAWDOWN_PCT = 10

/**
 * 自动驾驶接受的目标收益上限（%）。
 *
 * ⚠️ 导出它是因为**它已经被第二个地方依赖**：任务裁定层要用它回答
 * 「这个目标越过自动驾驶的硬界了吗」。此前这个 50 只写在 `startAutopilot`
 * 的校验表达式里 —— 那种写法下，任务层要么抄一个字面量 50（改一处漏一处），
 * 要么根本不检查（于是用户会收到"目标可以做"，然后启动时被拒）。
 * 两个都是"同一个事实存了两份"的形态，所以在源头把它提成常量。
 */
export const AUTOPILOT_TARGET_MAX_PCT = 50

/**
 * 风险预算预留层的账户键。
 *
 * 自动驾驶当前只有 BTCUSDT 一条腿，但账户键刻意按 `{venue, environment}`
 * 建模而不是写成裸字符串常量：`environment` 取运行模式（paper/live），
 * 这样 paper 与 live 的预算天然隔离——不会出现「纸交易占了实盘的额度」，
 * 也保证将来接第二个场所时无需改数据模型。
 */
const ACCOUNT_KEY = {
  venue: process.env.AUTOPILOT_VENUE ?? 'binance',
  environment: (process.env.AUTOPILOT_LIVE ?? 'false') === 'true' ? 'live' : 'paper',
}

/** 本次开仓意图的预留 ID。平仓时据此释放预算。 */
let openReservationIntent: string | null = null

/** 短随机后缀，用于构造可读且低碰撞的意图 ID。 */
function qxRandom(): string {
  return Math.random().toString(36).slice(2, 6)
}

/**
 * 把下单失败原因映射为预留层的终态判定。
 *
 * **这是整个预留层最需要克制的一处判断。** 只有场所给出明确拒绝时才可以释放预算；
 * 其余一切失败（适配器缺失、握手未完成、网络超时、限流）都意味着
 * 「我们不知道场所那边发生了什么」，必须记为 unknown 并继续占用。
 *
 * 直觉容易反过来——「下单都失败了，当然没建仓，赶紧把额度还回去」。
 * 但正是这个直觉造成了历史账本错配：额度被还回去、下一轮又开一次，
 * 而第一次的订单可能已经在场所侧成交了。
 */
function classifyOrderFailure(reason: string | undefined): string {
  const r = String(reason ?? '').toUpperCase()
  // 场所明确拒绝：订单在场所侧确定未成立，可安全释放
  const HARD_REJECTS = ['BROKER_REJECTED', 'REJECTED', 'INSUFFICIENT_BALANCE', 'INVALID_QTY', 'MIN_NOTIONAL', 'PRICE_DEVIATION_EXCEEDED', 'NOTIONAL_EXCEEDS_LIMIT', 'RATE_LIMIT_EXCEEDED', 'SYMBOL_NOT_TRADABLE']
  return HARD_REJECTS.some((x) => r.includes(x)) ? STATE_REJECTED : STATE_UNKNOWN
}
function autopilotLiveStrategy(): string {
  return process.env.AUTOPILOT_LIVE_STRATEGY ?? 'e2e-strat'
}
function autopilotMaxNotional(): number {
  return Number(process.env.AUTOPILOT_MAX_NOTIONAL_USD ?? 500)
}

/** 以小博大：杠杆倍数（以 BTC 等持仓作抵押物借币，不卖出 BTC） */
function autopilotLeverage(): number {
  const v = Number(process.env.AUTOPILOT_LEVERAGE ?? 1)
  return Number.isFinite(v) && v > 1 ? v : 1
}

/**
 * 品种形态。默认 SPOT（现货）。
 *
 * 为什么要显式配置而不是「杠杆 > 10 就自动切 SWAP」：
 * 自动切换会让「我想加杠杆」这个意图**静默地改变品种形态** ——
 * 现货与合约是两种不同的产品（前者买币、后者是衍生品敞口），
 * 资金费、强平、结算方式全都不同。形态必须是显式选择。
 */
function autopilotInstType(): 'SPOT' | 'SWAP' {
  const v = (process.env.AUTOPILOT_INST_TYPE ?? 'SPOT').toUpperCase()
  return v === 'SWAP' ? 'SWAP' : 'SPOT'
}

/** 合约结算方式（仅 SWAP 有意义）。默认 linear（U 本位）。 */
function autopilotSettle(): 'linear' | 'inverse' {
  return (process.env.AUTOPILOT_SETTLE ?? 'linear').toLowerCase() === 'inverse' ? 'inverse' : 'linear'
}

function isAutopilotLive(): boolean {
  // ⚠️ 安全默认值必须是 false。历史版本写作 `?? 'true'`，
  // 意味着新克隆的仓库、或 .env 漏了这一行时，自动驾驶**默认走实盘路径**。
  // 一个「缺省即实盘」的开关违背本项目「风控默认拒绝」的哲学，也与
  // `EVOLVE` 自己的 live 门禁设计（必须显式晋升 + 人工审批）自相矛盾。
  return (process.env.AUTOPILOT_LIVE ?? 'false').toLowerCase() === 'true'
}

/**
 * 实盘启动前的**配置自检**：只告警不阻断。
 *
 * 存在的理由是一类反复出现的缺陷形态 —— **两个各自合理的默认值组合起来互斥**。
 * 最具代表性的一次：单笔名义上限 $100 与成本闸门地板 $200 同时生效，
 * 结果是**每一笔实盘都必然被拒**，而日志里显示的是一条看起来像"行情不好"的
 * 成本裁决。这类缺陷不报错、不崩溃，只是让整条通道静默不可用。
 *
 * 所以这里在**启动的第一秒**把互斥关系直接喊出来，而不是等运维从成百上千条
 * 拒绝日志里反推。检查项都是「不满足则必然零成交」的硬互斥，不是风格建议。
 */
function warnOnLiveConfigConflicts(): void {
  const instType = autopilotInstType()
  const leverage = autopilotLeverage()
  const perOrderCap = autopilotMaxNotional()
  const cap = Number(process.env.AUTOPILOT_LIVE_CAP_USD ?? NaN)
  const marginFloor = Number.isFinite(cap) ? cap : NaN

  if (perOrderCap < MIN_VIABLE_NOTIONAL_CEX_USDT) {
    console.warn(
      `⚠️ [config] 单笔名义上限 $${perOrderCap} < CEX 成本可行地板 $${MIN_VIABLE_NOTIONAL_CEX_USDT}：` +
        '每一笔都会被成本闸门判 NOTIONAL_TOO_SMALL，实盘**零成交**。请抬高 AUTOPILOT_MAX_NOTIONAL_USD。',
    )
  }
  if (instType !== 'SWAP' && leverage > SPOT_MAX_LEVERAGE) {
    console.warn(
      `⚠️ [config] AUTOPILOT_LEVERAGE=${leverage}x 但 AUTOPILOT_INST_TYPE=${instType}：` +
        `现货杠杆上限约 ${SPOT_MAX_LEVERAGE}x，每一笔都会以 LEVERAGE_REQUIRES_SWAP 被拒。` +
        "请设 AUTOPILOT_INST_TYPE=SWAP 才能用到合约杠杆。",
    )
  }
  if (Number.isFinite(marginFloor) && marginFloor < MIN_MARGIN_USDT) {
    console.warn(
      `⚠️ [config] 自有资金帽 $${marginFloor} < 单笔最小保证金 $${MIN_MARGIN_USDT}：` +
        '帽太小，连最小档位都下不去。',
    )
  }
  if (Number.isFinite(marginFloor) && marginFloor * leverage < MIN_VIABLE_NOTIONAL_CEX_USDT) {
    console.warn(
      `⚠️ [config] 自有资金帽 $${marginFloor} × 杠杆 ${leverage}x = $${(marginFloor * leverage).toFixed(2)}` +
        ` < CEX 成本可行地板 $${MIN_VIABLE_NOTIONAL_CEX_USDT}：即使打满杠杆也过不了成本闸门。` +
        '请同时抬高 AUTOPILOT_LIVE_CAP_USD 与 AUTOPILOT_LEVERAGE。',
    )
  }
}

let running = false
let stage: AutopilotStage = 'idle'
let targetPct = 2
let startedAt: number | null = null
let baselineEquity: number | null = null
let cycles = 0
let winner: Strategy | null = null
const candles: Candle[] = []
let lastBarTs = 0
let apPosQty = 0
/** 本周期胜出策略的适应度（用于反推决策置信度）。 */
let winnerFitness = 0
/** 本轮寻优的相对优势（冠军 vs 亚军），用于置信度第二项。 */
let winnerEdge = 0
/** 本周期是否由运维手动 pin 了策略（此时置信度按人工授权计）。 */
let winnerPinned = false
/** 当日已实现亏损累计（USDC，正数表示亏损额）。 */
let dailyRealizedLoss = 0
let dailyLossDay = ''
/** 最近一次拦截原因，供决策大脑页面展示「为什么没做这笔」。 */
let lastInterception: { at: number; reason: string; code?: string; blockedBy?: string } | null = null

/**
 * ══ F-47：样本内选择必须过过拟合门 ══════════════════════════════════
 *
 * 改造前 `optimize()` 的全部逻辑是：`evaluateCandidateGrid(candles)` 取 fitness 最高的那个，
 * 直接进入 `trading`。20 个候选里挑第一名叫「选择」，而被挑中的那个从未被问过一句
 * 「你换一段行情还站得住吗」。同一文件里 `winnerEdge`（冠军−亚军）长得像是这个问题的答案，
 * 但它只进入 `deriveConfidence()` 去压低一个展示分数，**不否决任何东西**。
 *
 * 于是系统里同时存在两套标准：
 *   - 升级门（promotion）要求 `OverfitReceipt` 并跑 CSCV-PBO，过不了不许升；
 *   - 自动驾驶自己选策略时，这道门**一次都没出现过**。
 * 而 live 正是从 `optimize()` 直接进 `trading` 下单的 —— 门禁最严的地方，恰好是它唯一不在的地方。
 *
 * ══ 为什么门必须算在**同一批 K 线**上 ═════════════════════════════════
 * 现成的 `computeEvidenceReceipt()`（server/evidence.ts）已经能算凭据，但它读的是
 * `data/history/<SYMBOL>_15m.json`。直接拿来用看着省事，实则是最典型的**夹具口径错位**：
 * 选择在 A 数据集上做、门在 B 数据集上判，两者根本不是同一个问题。
 * 所以这里对 `candles`（喂给 `evaluateCandidateGrid` 的同一批）现算，
 * 并把 `contentHash(candles)` 写进审计事件 —— 事后可核对「当时判的是哪批数据」。
 *
 * ══ 为什么它是可注入的 ═══════════════════════════════════════════════
 * 不是为了留后门，是为了让烟测能**分别**验证放行与拒绝两条分支。
 * 一个无法被构造出拒绝场景的门，和没有门是一回事（本项目已复现 6 次的 P0 类型）。
 * 默认实现恒为真实 walk-forward，`configureOverfitGate(null)` 恢复默认。
 */
export interface OverfitGateOutcome {
  outcome: OverfitOutcome
  pass: boolean
  summary: string
  /** 参与计算的 K 线根数 —— 拒绝理由里的「样本不足」要能对上这个数。 */
  bars: number
  /** 实际切出的折数与 PBO；样本不足时为 0 / null。 */
  folds: number
  pbo: number | null
  /** 门的耗时。它在 live 下同步阻塞事件循环，所以必须可观测。 */
  elapsedMs: number
}

export type OverfitGate = (candles: readonly Candle[]) => OverfitGateOutcome

/**
 * 自动驾驶的 walk-forward 切分。
 *
 * 与 `evidence.ts` 的 `DEFAULT_WF` 同值：960/240 在 2880 根上得 8 折。
 * `barMinutes` 取 15 同样是**跟随选择口径** —— `evaluateCandidateGrid(candles)` 默认 15，
 * 门若用别的值，年化与每日笔数的换算就和选择时不一致，又是一次口径错位。
 */
const AUTOPILOT_OVERFIT_WF = { trainBars: 960, testBars: 240, barMinutes: 15, slices: 10 }

function defaultOverfitGate(candlesIn: readonly Candle[]): OverfitGateOutcome {
  const t0 = Date.now()
  const series = candlesIn as Candle[]
  // 折数不足时 walkForward 返回 0 折凭据，judgeOverfit 自会判 UNVERIFIABLE。
  // 这里**不**再做一次「样本够不够」的前置判断：门槛只应存在于一处，
  // 否则两处阈值各自漂移，且「到底哪一处拒的」将无法从事由里分辨。
  const result = walkForward(
    series,
    buildCandidateSet(),
    { ...AUTOPILOT_OVERFIT_WF, exec: DEFAULT_GRID_EXEC },
    { dataHash: contentHash(series), slices: AUTOPILOT_OVERFIT_WF.slices },
  )
  const verdict = judgeOverfit(result.receipt, DEFAULT_OVERFIT_THRESHOLDS)
  return {
    outcome: verdict.outcome,
    pass: verdict.pass,
    summary: verdict.summary,
    bars: series.length,
    folds: result.receipt.folds,
    pbo: result.receipt.pbo,
    elapsedMs: Date.now() - t0,
  }
}

let overfitGate: OverfitGate = defaultOverfitGate

/** 注入过拟合门。传 `null` 恢复默认（真实 walk-forward + CSCV-PBO）。 */
export function configureOverfitGate(g: OverfitGate | null): void {
  overfitGate = g ?? defaultOverfitGate
}

export function runOverfitGate(candlesIn: readonly Candle[]): OverfitGateOutcome {
  return overfitGate(candlesIn)
}

/**
 * 门拒绝后的重试冷却：再多积累这么多根 K 线才重判一次。
 *
 * 为什么不「拒了就停机」：`UNVERIFIABLE` 的含义是**证据还不够**，而证据会随 K 线累积变多。
 * 停机等于把「再等等」判成了「永不可行」。
 * 为什么不「每根都重判」：20 候选 × N 根 × 多折的 walk-forward 是秒级同步计算，
 * 每根 K 线跑一次会拖垮行情管线。
 */
const GATE_RETRY_BARS = 60

/** 最近一次门拒绝的详情。**拒绝必须可观测** —— 静默拒绝等于没有拒绝。 */
let lastGateRefusal: {
  at: number
  outcome: OverfitOutcome
  summary: string
  bars: number
  folds: number
  pbo: number | null
  retryAtBars: number
} | null = null

/** 下一次允许重跑门的 K 线根数。 */
let gateRetryAtBars = 0

export function configureAutopilot(d: Deps): void {
  deps = d
}

function markedEquity(s: OrchState): number {
  let eq = s.balanceUSDC
  const px = s.lastPrice.get(SYMBOL)
  const pos = s.positions.get(SYMBOL)
  if (px && pos) eq += pos.qty * px
  return eq
}

export async function startAutopilot(targetPercent: number): Promise<{ ok: boolean; reason?: string }> {
  if (!deps) return { ok: false, reason: 'AUTOPILOT_NOT_CONFIGURED' }
  if (running) return { ok: false, reason: 'ALREADY_RUNNING' }
  if (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > AUTOPILOT_TARGET_MAX_PCT) {
    return { ok: false, reason: 'TARGET_OUT_OF_RANGE (0 < t ≤ ' + AUTOPILOT_TARGET_MAX_PCT + ' %)' }
  }
  const s = deps.getState()
  if (s.killswitch) return { ok: false, reason: 'KILLSWITCH_ACTIVE' }

  running = true
  stage = 'accumulating'
  targetPct = targetPercent
  startedAt = Date.now()
  cycles = 0
  winner = null
  apPosQty = 0
  winnerFitness = 0
  winnerEdge = 0
  winnerPinned = false
  lastInterception = null
  // 门的状态必须随一次 start 归零：否则上一次运行留下的冷却门槛
  // 会让新一轮在「还没到重判点」上白白空转。
  lastGateRefusal = null
  gateRetryAtBars = 0
  dailyRealizedLoss = 0
  dailyLossDay = dayKey(Date.now())
  baselineEquity = markedEquity(s)

  const scope = isAutopilotLive() ? 'live' : 'paper'
  appendEvent('AUTOPILOT_STARTED', { scope, symbol: SYMBOL, targetPct, baselineEquity, strategyId: isAutopilotLive() ? autopilotLiveStrategy() : undefined })
  console.log(
    `[autopilot] START ${scope} ${SYMBOL} · 目标 +${targetPct}% · 基线 $${baselineEquity?.toFixed(2)}` +
      ` · 单笔名义上限 $${autopilotMaxNotional()}` +
      ` · 品种 ${autopilotInstType()}${autopilotInstType() === 'SWAP' ? `/${autopilotSettle()}` : ''}` +
      ` · 杠杆 ${autopilotLeverage()}x`,
  )
  if (isAutopilotLive()) warnOnLiveConfigConflicts()
  await seedAutopilotBars()
  // 先取一次高周期状态，让首个交易 bar 就有真实 ATR / ADX / 4H 趋势可用
  await refreshRegime(SYMBOL, ATR_PERIOD).catch(() => null)
  return { ok: true }
}

/** 预热历史 K 线（公开行情，无需密钥），使 autopilot 立即越过 MIN_BARS 进入交易，无需等待数十分钟。*/
async function seedAutopilotBars(): Promise<void> {
  if (process.env.AUTOPILOT_PRESEED === 'false') return
  try {
    const u = `https://data-api.binance.vision/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=200`
    const res = await fetch(u)
    if (!res.ok) return
    const rows = (await res.json()) as unknown[][]
    for (const r of rows) {
      const candle: Candle = { t: Number(r[0]), o: parseFloat(String(r[1])), h: parseFloat(String(r[2])), l: parseFloat(String(r[3])), c: parseFloat(String(r[4])), v: parseFloat(String(r[5])) }
      if (candle.t <= lastBarTs) continue
      lastBarTs = candle.t
      candles.push(candle)
    }
    console.log(`[autopilot] 预热 ${candles.length} 根历史 K 线 · 越过 MIN_BARS=${MIN_BARS}`)
  } catch {
    /* 忽略，靠实时 K 线累积 */
  }
}

export function stopAutopilot(reason: string): void {
  if (!running) return
  running = false
  stage = 'idle'
  // scope 必须动态判定：此前硬编码为 'paper'，导致 live 模式停机也被记成 paper，
  // 审计链事后复盘时会得出错误结论。同一文件的 STARTED / FLATTEN 都用了动态值。
  appendEvent('AUTOPILOT_STOPPED', { scope: isAutopilotLive() ? 'live' : 'paper', reason })
  console.log('[autopilot] STOP · ' + reason)
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** 跨日重置当日亏损计数（熔断按自然日重置）。 */
function rollDailyLossIfNeeded(now: number): void {
  const today = dayKey(now)
  if (dailyLossDay !== today) {
    dailyLossDay = today
    dailyRealizedLoss = 0
  }
}

/** 交易周期 ATR（1H ATR 不可用时的回退尺子）。 */
function tradingTimeframeAtr(): number {
  if (candles.length < ATR_PERIOD + 1) return 0
  const high: number[] = []
  const low: number[] = []
  const close: number[] = []
  for (const c of candles) {
    high.push(c.h)
    low.push(c.l)
    close.push(c.c)
  }
  const series = computeAtr(high, low, close, ATR_PERIOD)
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i])) return series[i]
  }
  return 0
}

/**
 * 由适应度反推决策置信度（0~100）。
 *
 * 为什么需要它：拦截闸门里有置信度门禁，而 EVOLVE 的策略是确定性纯函数，
 * 本身不输出置信度。硬塞一个常数（比如恒等于 75）会让门禁永远形同虚设 ——
 * 一个恒真的门禁比没有门禁更糟，因为它会让人误以为有这层保护。
 *
 * 这里用两个真实可得、且与「这笔交易值不值得做」直接相关的信号：
 *   ① 胜出策略的绝对适应度水平 —— 它本身是收益/回撤比的压缩值；
 *   ② 冠军相对亚军的**领先幅度** —— 候选池里只有微弱领先，说明信号不稳定，
 *      这正是「同一份行情、换个窗口就换冠军」的过拟合征兆，理应压低置信度。
 *
 * 标定说明（为什么是 50/25/25、门槛 40 与 2 倍斜率）：
 *   本项目 fitness 的实际取值域大致在 −100~120，一个「像样的」策略通常落在 15~40。
 *   若按 fitness/60 线性映射，正常策略只能拿到 45~60 分，会**恒被 70 分门禁拦下**——
 *   风控于是从「过滤垃圾」退化成「冻结系统」。所以这里以 fitness 40 为满格基准、
 *   edge 取 2 倍斜率，使「fitness≥20 且冠军明显领先」的正常机会落在 85 分附近，
 *   而「fitness 10 且冠军几乎不领先」落在 60 分附近被拦。门禁由此恢复区分度。
 */
function deriveConfidence(fitness: number, edge: number): number {
  const level = Math.min(Math.max(fitness, 0) / 40, 1)
  const stability = Math.min(Math.max(edge * 2, 0), 1)
  const score = 50 + 25 * level + 25 * stability
  return Math.round(Math.min(Math.max(score, 0), 100) * 10) / 10
}

/**
 * 本周期用于拦截门禁的置信度。
 *
 * 人工 pin 策略时寻优统计量不存在，此时置信度来自**人工授权**而非寻优稳定性 ——
 * 按 85 计（高于默认 70 门禁），否则运维手动指定的策略会永远开不出仓，
 * 让 `AUTOPILOT_PINNED_STRATEGY` 这个既有功能被新门禁静默废掉。
 */
function currentConfidence(): number {
  return winnerPinned ? 85 : deriveConfidence(winnerFitness, winnerEdge)
}

/** 每根收盘 K 线驱动一次自治循环（由 index 的行情管线调用） */
export async function onAutopilotBar(candle: Candle): Promise<void> {
  if (!running || !deps) return
  if (candle.t <= lastBarTs) return
  lastBarTs = candle.t
  candles.push(candle)
  if (candles.length > 3_000) candles.splice(0, candles.length - 3_000)

  const s = deps.getState()
  const equity = markedEquity(s)
  if (baselineEquity === null) baselineEquity = equity
  const pnlPct = ((equity - baselineEquity) / baselineEquity) * 100

  // 硬性回撤保护：先于一切目标逻辑
  if (pnlPct <= -AUTOPILOT_DRAWDOWN_PCT) {
    await flatten('DRAWDOWN_PROTECTION')
    running = false
    stage = 'drawdown_stopped'
    appendEvent('AUTOPILOT_DRAWDOWN_STOP', { pnlPct: Math.round(pnlPct * 100) / 100, limit: -AUTOPILOT_DRAWDOWN_PCT })
    return
  }

  // 目标达成：平仓锁定 paper 收益
  if (stage === 'trading' && pnlPct >= targetPct) {
    await flatten('TARGET_REACHED')
    stage = 'target_reached'
    cycles += 1
    appendEvent('AUTOPILOT_TARGET_REACHED', { pnlPct: Math.round(pnlPct * 100) / 100, targetPct, cycles })
    console.log(`[autopilot] 🎯 TARGET REACHED +${pnlPct.toFixed(2)}%`)
    return
  }

  // 选择期：累积够 MIN_BARS 后做一次样本内寻优 —— 但寻优结果必须先过过拟合门（F-47）。
  // 门拒绝时**继续累积**而不是停机（理由见 GATE_RETRY_BARS），
  // 且在冷却期内直接返回，不再重跑一遍 walk-forward。
  if (stage === 'accumulating' && candles.length >= MIN_BARS) {
    if (candles.length < gateRetryAtBars) return
    stage = 'optimizing'
    const picked = optimize()
    if (!picked.ok) {
      if (picked.refusal) {
        gateRetryAtBars = candles.length + GATE_RETRY_BARS
        stage = 'accumulating'
        lastGateRefusal = {
          at: Date.now(),
          outcome: picked.refusal.outcome,
          summary: picked.refusal.summary,
          bars: picked.refusal.bars,
          folds: picked.refusal.folds,
          pbo: picked.refusal.pbo,
          retryAtBars: gateRetryAtBars,
        }
        appendEvent('AUTOPILOT_OPTIMIZE_REFUSED', {
          outcome: picked.refusal.outcome,
          summary: picked.refusal.summary,
          bars: picked.refusal.bars,
          folds: picked.refusal.folds,
          pbo: picked.refusal.pbo,
          candidates: picked.candidateCount ?? null,
          gateElapsedMs: picked.refusal.elapsedMs,
          selected: picked.selected ?? null,
          retryAtBars: gateRetryAtBars,
        })
        console.log(
          `[autopilot] ⛔ 样本内选择未过过拟合门（${picked.refusal.outcome}）· 不进入交易` +
            ` · ${picked.refusal.summary} · 下次重判于 ${gateRetryAtBars} 根`,
        )
        return
      }
      appendEvent('AUTOPILOT_OPTIMIZE_FAILED', { reason: picked.reason })
      stopAutopilot('optimize failed: ' + picked.reason)
      return
    }
    winner = picked.strategy
    stage = 'trading'
    cycles += 1
    appendEvent('AUTOPILOT_STRATEGY_SELECTED', {
      strategyId: picked.id,
      fitness: picked.fitness,
      fitnessVersion: picked.fitnessVersion,
      dataBars: candles.length,
      overfit: picked.overfit,
    })
    console.log(`[autopilot] 胜出策略 ${picked.id} fitness=${picked.fitness}`)
    return
  }

  if (stage === 'trading' && winner) {
    cycles += 1
    await tradeBar(candles.length - 1)
  }
}

type OptimizeResult =
  | {
      ok: true
      id: string
      strategy: Strategy
      fitness: number
      fitnessVersion: string
      /** 门通过时的可观测量，写进 `AUTOPILOT_STRATEGY_SELECTED` 事件。`null` = 未经门（pin 绕过）。 */
      overfit: {
        outcome: OverfitOutcome
        summary: string
        bars: number
        folds: number
        pbo: number | null
        elapsedMs: number
      } | null
    }
  | {
      ok: false
      reason: string
      /** 存在即表示「被过拟合门否决」——与真正的故障区分开，前者继续累积、后者停机。 */
      refusal?: OverfitGateOutcome
      /** 被否决时，本来会被选中的那个候选项（留证据：拒的是谁）。 */
      selected?: string
      candidateCount?: number
    }

function optimize(): OptimizeResult {
  const pinned = pinnedStrategy()
  if (pinned) {
    // ⚠️ pin **故意**不过过拟合门。
    //
    // 这道门的命题是「这一次**选择**是否过拟合」，而 pin 的过程里没有任何选择 ——
    // 它是人工指定，走的是另一条授权路径（且 live 下已被 pinnedStrategy() 直接拒掉）。
    // 但「绕过了门」这件事必须留在事件里：否则事后无法从账本分辨
    // 「这个冠军是挖出来的」还是「这个冠军是人指定的」——而这恰恰是两种不同的可信度。
    winner = pinned.strategy
    winnerPinned = true
    winnerFitness = 0
    winnerEdge = 0
    appendEvent('AUTOPILOT_STRATEGY_SELECTED', {
      strategyId: pinned.id,
      fitness: pinned.fitness,
      fitnessVersion: pinned.fitnessVersion,
      pinned: true,
      overfitGate: 'bypassed-by-pin',
      dataBars: candles.length,
    })
    return { ok: true, id: pinned.id, strategy: pinned.strategy, fitness: pinned.fitness, fitnessVersion: pinned.fitnessVersion, overfit: null }
  }
  winnerPinned = false
  const grid = evaluateCandidateGrid(candles)
  const best = grid[0]
  if (!best) return { ok: false, reason: 'empty grid' }
  // 因子族重建策略实例（策略为无状态工厂产物）
  const rebuilt = rebuildStrategy(best.id.replace(/[:{"].*$/, ''), best.result.meta.params)
  if (!rebuilt) return { ok: false, reason: `cannot rebuild ${best.id}` }

  // ── F-47：选择必须过过拟合门 ──────────────────────────────────────
  // 位置刻意在 rebuild 之后、fitness 复核之前：门是**否决权**，
  // 没过门就不必再花一次回测去做门后的确认动作。
  const gate = runOverfitGate(candles)
  appendEvent('AUTOPILOT_OVERFIT_GATE', {
    outcome: gate.outcome,
    pass: gate.pass,
    bars: gate.bars,
    folds: gate.folds,
    pbo: gate.pbo,
    candidates: grid.length,
    elapsedMs: gate.elapsedMs,
    dataHash: contentHash(candles),
    selected: best.id,
    summary: gate.summary,
  })
  if (!gate.pass) {
    return { ok: false, reason: `OVERFIT_GATE_${gate.outcome}`, refusal: gate, selected: best.id, candidateCount: grid.length }
  }

  // 复核：在全部累积数据上重跑，fitness 必须仍为有限值（防过拟合快照漂移）
  const verify = runBacktest(candles, rebuilt, {
    makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1,
  }, 100_000, 15)
  const report = computeReport(verify, 15)
  const fit = computeFitness({
    annReturnPct: report.annReturnPct,
    maxDrawdownPct: report.maxDrawdownPct,
    tradesPerDay: report.tradesPerDay,
  })

  // 冠军相对亚军的领先幅度 → 决策置信度的一项输入。
  // 候选池里只有微弱领先，说明「换一个窗口就换冠军」，是过拟合征兆，理应压低置信度。
  //
  // 注意：这不是过拟合门。它只是一个**展示用**的启发式，不否决任何东西 ——
  // 真正的否决权在上一段的 `gate`。两者并存不是冗余：门回答「能不能用」，
  // 它回答「用得多有信心」，前者是闸门、后者是标尺。
  winnerFitness = fit.value
  const runnerUp = grid[1]?.fitness ?? 0
  const denom = Math.max(Math.abs(fit.value), 1)
  winnerEdge = Math.min(Math.max((fit.value - runnerUp) / denom, 0), 1)

  return {
    ok: true,
    id: best.id,
    strategy: rebuilt,
    fitness: fit.value,
    fitnessVersion: fit.version,
    overfit: {
      outcome: gate.outcome,
      summary: gate.summary,
      bars: gate.bars,
      folds: gate.folds,
      pbo: gate.pbo,
      elapsedMs: gate.elapsedMs,
    },
  }
}

function rebuildStrategy(family: string, params: Record<string, number>): Strategy | null {
  const mod = engineRef
  if (family === 'macross') return mod.maCrossStrategy(params.fast ?? 10, params.slow ?? 30)
  if (family === 'rsi-rev') return mod.rsiReversionStrategy(params.period ?? 14, params.lower ?? 30, params.upper ?? 70)
  if (family === 'breakout') return mod.breakoutStrategy(params.period ?? 20)
  if (family === 'boll-rev') return mod.bollingerReversionStrategy(params.period ?? 20, params.numStd ?? 2)
  if (family === 'macd-trend') return mod.macdTrendStrategy(params.fast ?? 12, params.slow ?? 26, params.signalPeriod ?? 9)
  if (family === 'ema-rsi') return mod.emaRsiComboStrategy(params.emaPeriod ?? 50, params.rsiPeriod ?? 14, params.lower ?? 30, params.upper ?? 70)
  return null
}

function pinnedStrategy(): { ok: true; id: string; strategy: Strategy; fitness: number; fitnessVersion: string } | null {
  const raw = process.env.AUTOPILOT_PINNED_STRATEGY
  if (!raw) return null

  // ⚠️ live 下**禁止** pin。
  //
  // pin 的作用是跳过策略挖掘、直接让某个固定策略成为冠军。这在演练里有价值，
  // 但在真币环境下等于「用一行环境变量把进化引擎静默旁路掉」——
  // 而这个系统的名字就叫自进化，那是它的核心。真要用固定策略，
  // 应该走策略晋升门禁留下审计痕迹，而不是靠一个环境变量。
  //
  // 事故背景：`.env` 里曾长期留着一条调试用的 pin（还是参数非法的），
  // 于是「自动挖掘」在纸面上是开着的，实际上从来没跑过。
  if (isAutopilotLive()) {
    console.log('[autopilot] ⛔ 忽略 AUTOPILOT_PINNED_STRATEGY：live 环境禁止绕过策略挖掘')
    appendEvent('AUTOPILOT_PIN_REJECTED', {
      reason: 'live 环境禁止 pin：它会绕过进化引擎的策略挖掘',
      requested: raw.slice(0, 80),
    })
    return null
  }

  const ci = raw.indexOf(':')
  const fam = ci >= 0 ? raw.slice(0, ci) : raw
  const pstr = ci >= 0 ? raw.slice(ci + 1) : ''
  let params: Record<string, number> = {}
  if (pstr) {
    try {
      params = JSON.parse(pstr) as Record<string, number>
    } catch {
      console.log(`[autopilot] ⛔ 忽略 pin：参数不是合法 JSON → ${pstr.slice(0, 60)}`)
      appendEvent('AUTOPILOT_PIN_REJECTED', { reason: 'pin 参数不是合法 JSON', requested: raw.slice(0, 80) })
      return null
    }
  }

  let s: Strategy | null
  try {
    s = rebuildStrategy(fam, params)
  } catch (e) {
    // 参数自洽性校验（如 rsi-rev 的 lower < upper）会在这里抛出。
    // 拒绝并回退到正常挖掘 —— 一个参数非法的 pin 若被接受，
    // 系统会带着一条「永不产生信号」的策略进入 trading，且所有日志看起来都正常。
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[autopilot] ⛔ 忽略 pin：${msg}`)
    appendEvent('AUTOPILOT_PIN_REJECTED', { reason: msg, requested: raw.slice(0, 80) })
    return null
  }
  if (!s) {
    console.log(`[autopilot] pinned family unknown: ${fam}`)
    appendEvent('AUTOPILOT_PIN_REJECTED', { reason: `未知策略族 ${fam}`, requested: raw.slice(0, 80) })
    return null
  }
  console.log(`[autopilot] pinned strategy ${s.id} ${JSON.stringify(s.params)}`)
  return { ok: true, id: `${s.id}:${JSON.stringify(s.params)}`, strategy: s, fitness: 0, fitnessVersion: 'pinned' }
}

import * as engineRef from '../src/engine/index.ts'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round5(n: number): number {
  return Math.max(0, Math.round(n * 1e5) / 1e5)
}

/**
 * 守卫持仓 ↔ 编排器账本 对账。
 *
 * 为什么必须有这一步：守卫是**进程内状态**，重启即清零；而账本持仓是持久事实。
 * 两者不对账会出现两种都是致命的偏差：
 *   - 账上有货、守卫不知情 → 持仓**裸奔没有任何止损**（本项目改造前就是这个状态）；
 *   - 守卫有货、账上已空 → 系统会对一个不存在的仓位反复「平仓」，
 *     而这正是历史上账本对不上（LEDGER_MISMATCH）的形态。
 *
 * 结论：以**账本为准**，守卫向账本看齐。这也是「账本是唯一事实来源」原则在守卫层的落实。
 */
function reconcileGuardWithLedger(s: OrchState, price: number, stopAtr: number, now: number): void {
  const ledgerQty = s.positions.get(SYMBOL)?.qty ?? 0
  const ledgerAvg = s.positions.get(SYMBOL)?.avgPrice ?? 0
  const guard = getPosition(SYMBOL)
  const EPS = 1e-5

  // 情况一：守卫有仓、账上已空 → 幽灵持仓，清掉（不触发冷静期，因为并非止损出局）
  if (guard && Math.abs(ledgerQty) <= EPS) {
    closePosition(SYMBOL, false, now, guard.side)
    appendEvent('AUTOPILOT_GUARD_RECONCILED', {
      action: 'clear_phantom',
      guardQty: guard.qty,
      ledgerQty,
      detail: '账本已无持仓，清除幽灵守卫（避免对不存在的仓位反复平仓）',
    })
    console.log('[guard] 对账：账本无持仓，已清除幽灵守卫')
    return
  }

  // 情况二：账上有仓、守卫不知情 → 认领并立即上线止损（这正是「遗留仓裸奔」的修复点）
  if (!guard && ledgerQty > EPS) {
    const adopted = openPosition({
      symbol: SYMBOL,
      side: 'long',
      entryPrice: ledgerAvg > 0 ? ledgerAvg : price,
      qty: ledgerQty,
      atrValue: stopAtr,
      now,
    })
    appendEvent('AUTOPILOT_GUARD_ADOPTED', {
      entryPrice: round2(adopted.entryPrice),
      qty: adopted.qty,
      stop: round2(adopted.currentStop),
      initialStop: round2(adopted.initialStop),
      detail: '发现账本存量持仓但守卫缺失，已认领并立即上线止损（恢复抗噪宽止损保护）',
    })
    console.log(`[guard] 对账：认领账本持仓 ${adopted.qty} @${adopted.entryPrice.toFixed(2)}，止损 ${adopted.currentStop.toFixed(2)}`)
    return
  }

  // 情况三：双方都有但数量不符 → 以账本为准修正守卫数量
  if (guard && ledgerQty > EPS && Math.abs(guard.qty - ledgerQty) > 1e-4) {
    const before = guard.qty
    updatePosition({ ...guard, qty: ledgerQty })
    appendEvent('AUTOPILOT_GUARD_RECONCILED', {
      action: 'sync_qty',
      guardQty: before,
      ledgerQty,
      detail: '守卫数量与账本不一致，以账本为准修正',
    })
    console.log(`[guard] 对账：数量修正 ${before} → ${ledgerQty}`)
  }
}

/**
 * 统一下单入口。
 *
 * 把 paper / live 两条路径的差异收在一处，是为了避免「新加的风控只挂了其中一条通路」——
 * 本项目历史上就出现过 live 有策略身份校验、paper 没有的隐性不对称。
 */
async function submitOrder(side: 'buy' | 'sell', qty: number): Promise<{ ok: boolean; reason?: string }> {
  if (!(qty > 0)) return { ok: false, reason: 'INVALID_QTY' }
  const clientOrderId = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`

  if (isAutopilotLive()) {
    const instType = autopilotInstType()
    const outcome = await processLiveIntent({
      clientOrderId,
      symbol: SYMBOL,
      side,
      type: 'market',
      qty,
      strategyId: autopilotLiveStrategy(),
      mode: 'live',
      leverage: autopilotLeverage() > 1 ? autopilotLeverage() : undefined,
      instType,
      settle: instType === 'SWAP' ? autopilotSettle() : undefined,
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    apPosQty += side === 'buy' ? qty : -qty
    return { ok: true }
  }

  const outcome = await processOrderIntent({ clientOrderId, symbol: SYMBOL, side, type: 'market', qty })
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  apPosQty += side === 'buy' ? qty : -qty
  return { ok: true }
}

async function tradeBar(lastIdx: number): Promise<void> {
  if (!winner || !deps) return
  const s = deps.getState()
  const candle = candles[lastIdx]
  const price = s.lastPrice.get(SYMBOL) ?? candle.c
  const equity = markedEquity(s)
  const now = Date.now()
  rollDailyLossIfNeeded(now)

  // ── ① 高周期状态：真实的 4H 趋势 / 1H ATR / 1H ADX
  const regime = await refreshRegime(SYMBOL, ATR_PERIOD)
  const fallbackAtr = tradingTimeframeAtr()
  const { atr: stopAtr, source: atrSource } = stopAtrFor(SYMBOL, fallbackAtr)

  // ── ①.5 守卫状态与账本对账
  reconcileGuardWithLedger(s, price, stopAtr, now)

  // ── ② 先守护存量持仓（顺序刻意在策略决策之前）
  //
  // 为什么必须先止损、后听策略：止损是「物理约束」，策略是「愿望」。
  // 如果先问策略再判止损，在破位那根 K 线上，策略说「继续持有」就会把已经触发的
  // 止损推后一根 bar 才执行 —— 滑点就是这么吃出来的。
  let guarded = getPosition(SYMBOL)
  if (guarded) {
    const action = evaluatePosition(guarded, { high: candle.h, low: candle.l, close: candle.c }, now)

    if (action.action === 'move_stop') {
      updatePosition(applyStopAction(guarded, action))
      guarded = getPosition(SYMBOL) ?? guarded
      appendEvent('AUTOPILOT_STOP_MOVED', {
        stage: action.stage,
        side: guarded.side,
        entryPrice: round2(guarded.entryPrice),
        stop: round2(action.stop),
        r: round2(action.r),
        reason: action.reason,
      })
      console.log(`[guard] 止损上移(${action.stage}) → ${action.stop.toFixed(2)} · R=${action.r.toFixed(2)}`)
    } else if (action.action === 'close') {
      const isStopHit = action.trigger === 'stop_hit'
      const exitSide: 'buy' | 'sell' = guarded.side === 'long' ? 'sell' : 'buy'
      const qty = round5(Math.abs(guarded.qty))
      const outcome = await submitOrder(exitSide, qty)
      if (!outcome.ok) {
        // 平仓被拒是严重信号：持仓失去守护。如实记录，不改止损，下一根 K 线重试。
        appendEvent('AUTOPILOT_ORDER_REJECTED', { reason: outcome.reason, side: exitSide, context: action.trigger })
        console.log(`[guard] ⚠️ 平仓被拒（${action.trigger}）：${outcome.reason}`)
        return
      }
      const pnl = (exitSide === 'sell' ? price - guarded.entryPrice : guarded.entryPrice - price) * qty
      if (pnl < 0) dailyRealizedLoss += Math.abs(pnl)
      closePosition(SYMBOL, isStopHit, now, guarded.side)
      appendEvent(isStopHit ? 'AUTOPILOT_STOP_HIT' : 'AUTOPILOT_TIME_STOP', {
        side: guarded.side,
        reason: action.reason,
        entryPrice: round2(guarded.entryPrice),
        exitPrice: round2(price),
        stop: round2(guarded.currentStop),
        qty,
        pnl: round2(pnl),
        r: round2(action.r),
        breakevenArmed: guarded.breakevenArmed,
        lockArmed: guarded.lockArmed,
        dailyLoss: round2(dailyRealizedLoss),
      })
      console.log(`[guard] ${isStopHit ? '止损出场' : '时间止损'} · R=${action.r.toFixed(2)} · PnL=${pnl.toFixed(2)} · ${action.reason}`)
      return
    }
  }

  // ── ③ 策略决策（avgPrice 现在是真的：此前恒为 0，策略无法感知成本）
  const ctx: StrategyContext = {
    i: lastIdx,
    candles,
    posQty: apPosQty,
    avgPrice: guarded?.entryPrice ?? 0,
    equity,
  }
  const d = winner.decide(ctx)
  if (!d) return

  if (d.side === 'sell') {
    // 多头离场：策略主动信号出场（非止损），不触发冷静期
    if (guarded && guarded.side === 'long') {
      const frac = Math.min(Math.max(d.frac, 0), 1)
      const qty = round5(Math.abs(guarded.qty) * frac)
      const outcome = await submitOrder('sell', qty)
      if (!outcome.ok) {
        appendEvent('AUTOPILOT_ORDER_REJECTED', { reason: outcome.reason, side: 'sell', context: 'strategy_exit' })
        return
      }
      const pnl = (price - guarded.entryPrice) * qty
      if (pnl < 0) dailyRealizedLoss += Math.abs(pnl)
      const remaining = round5(Math.abs(guarded.qty) - qty)
      if (remaining <= 0) {
        closePosition(SYMBOL, false, now, guarded.side)
      } else {
        updatePosition({ ...guarded, qty: remaining })
      }
      appendEvent('AUTOPILOT_STRATEGY_EXIT', {
        side: 'long',
        reason: '策略发出离场信号',
        entryPrice: round2(guarded.entryPrice),
        exitPrice: round2(price),
        qty,
        pnl: round2(pnl),
        r: round2(rMultiple(guarded, price)),
      })
      return
    }
    // 无多头持仓时的卖出信号：本项目当前**不支持做空**（编排器持仓记账为多头语义）。
    // 如实记录为忽略，而不是静默变成反向开仓 —— 那会制造出账本对不上的仓位。
    if (!guarded) {
      appendEvent('AUTOPILOT_SIGNAL_IGNORED', {
        side: 'sell',
        reason: '当前无多头持仓，且系统未启用做空（编排器持仓为多头语义），卖出信号忽略',
      })
    }
    return
  }

  // ── ④ 买入信号：已有持仓走金字塔门禁，无持仓走完整开仓链路
  if (guarded && guarded.side === 'long') {
    const scaleIn = canScaleIn(guarded, price, currentConfidence())
    if (scaleIn.allowed) {
      const geometry = computeStopGeometry(guarded.entryPrice, guarded.atrAtEntry)
      const existingNotional = guarded.qty * price
      const sizing = sizePositionFromRisk(equity, price, geometry.distance, existingNotional, autopilotLeverage())
      const addQty = round5(sizing.qty)
      if (addQty > 0) {
        const outcome = await submitOrder('buy', addQty)
        if (outcome.ok) {
          const newQty = round5(guarded.qty + addQty)
          const newEntry = round2((guarded.entryPrice * guarded.qty + price * addQty) / newQty)
          updatePosition({ ...guarded, qty: newQty, entryPrice: newEntry, scaleInCount: guarded.scaleInCount + 1 })
          appendEvent('AUTOPILOT_SCALE_IN', {
            side: 'long',
            qty: addQty,
            notional: round2(addQty * price),
            newEntry,
            newQty,
            count: guarded.scaleInCount + 1,
            reason: scaleIn.reason,
          })
          console.log(`[guard] 顺势加仓 ${addQty} @${price.toFixed(2)} · ${scaleIn.reason}`)
        } else {
          appendEvent('AUTOPILOT_ORDER_REJECTED', { reason: outcome.reason, side: 'buy', context: 'scale_in' })
        }
      }
    } else {
      appendEvent('AUTOPILOT_SCALE_IN_BLOCKED', { reason: scaleIn.reason })
    }
    return
  }
  if (guarded) return // 存在反向持仓，交由 core 的持仓冲突逻辑处理，不在此处反向

  await tryOpenLong(price, equity, regime, stopAtr, atrSource, s, now)
}

/**
 * 完整开仓链路：几何 → 拦截闸门 → 1R 风险定规模 → 下单 → 登记守护。
 *
 * 注意这里的顺序不可调换：**必须先过闸门再算仓位**。
 * 反过来（先算仓位再拦截）会让「被拒绝的交易」也在日志里留下一个具体数量，
 * 事后复盘极易被误读为「系统本来要下这么多」，污染归因。
 */
async function tryOpenLong(
  price: number,
  equity: number,
  regime: RegimeSnapshot | undefined,
  stopAtr: number,
  atrSource: string,
  s: OrchState,
  now: number,
): Promise<void> {
  if (!winner) return

  const geometry = computeStopGeometry(price, stopAtr)
  if (!(geometry.distance > 0)) {
    appendEvent('AUTOPILOT_INTERCEPTED', { code: 'NO_GEOMETRY', reason: '止损距离为 0（ATR 不可用），无法定价风险，放弃开仓' })
    return
  }
  const stop = price - geometry.distance
  const target = deriveStructureTarget('long', regime, price)
  const confidence = currentConfidence()

  const decision: TradeDecision = {
    action: 'BUY_LONG',
    confidence,
    entryPrice: price,
    takeProfitPrice: target.price,
    stopLossPrice: stop,
    strategyId: `${winner.id}:${JSON.stringify(winner.params)}`,
  }

  const pkg: MarketPackage = {
    symbol: SYMBOL,
    dataQuality: candles.length >= MIN_BARS ? 'valid' : 'insufficient',
    price,
    atr: stopAtr,
    bars: candles.length,
    adx1h: regime?.adx1h,
    macroTrend: regime?.macroTrend ?? 'RANGE',
    macroTrendSource: regime?.macroTrendSource ?? '高周期不可用',
  }

  const cooldown = checkCooldown(SYMBOL, 'long', now)
  const openGuard = getPosition(SYMBOL)
  const context: InterceptorContext = {
    now,
    equity,
    killswitch: s.killswitch,
    openPositions: openGuard ? [{ symbol: SYMBOL, side: openGuard.side }] : [],
    cooldownBlocked: cooldown.blocked,
    cooldownReason: cooldown.reason,
    dailyLoss: dailyRealizedLoss,
    dailyLossLimit: dailyLossLimit(equity),
  }

  const result = runPipeline(pkg, decision, context)

  // 盈亏比：用于事件留痕，让「为什么这笔被拒」有可核对的数字
  const rr = geometry.distance > 0 ? (target.price - price) / geometry.distance : 0

  if (result.finalAction === 'WAIT') {
    lastInterception = { at: now, reason: result.reason, code: result.code, blockedBy: result.blockedBy }
    appendEvent('AUTOPILOT_INTERCEPTED', {
      code: result.code,
      blockedBy: result.blockedBy,
      reason: result.reason,
      checked: result.checked,
      total: result.total,
      geometry: {
        entry: round2(price),
        stop: round2(stop),
        target: round2(target.price),
        targetBasis: target.basis,
        stopPct: round2(geometry.distancePct * 100),
        atrMultiplier: round2(geometry.atrMultiplier),
        atrSource,
        rr: round2(rr),
      },
      confidence,
    })
    console.log(`[guard] 拦截（${result.blockedBy}）：${result.reason}`)
    return
  }

  const existingNotional = Math.max((s.positions.get(SYMBOL)?.qty ?? 0) * price, 0)
  const sizing = sizePositionFromRisk(equity, price, geometry.distance, existingNotional, autopilotLeverage())
  const qty = round5(sizing.qty)
  if (qty <= 0) {
    appendEvent('AUTOPILOT_ORDER_REJECTED', {
      reason: `风险预算不足以开出最小仓位（约束：${sizing.bindingConstraint}）`,
      side: 'buy',
      context: 'sizing',
    })
    return
  }

  // ── 成本闸门：扣掉往返成本之后，这笔交易还划不划算 ────────────────────
  // 位置刻意放在「定完规模之后、预留之前」，两个约束同时满足才成立：
  //   · 不能更早：成本随名义本金变化（费率是比例、冲击是非线性），
  //     在不知道「打算做多大」之前算成本，算的是一笔虚构的交易；
  //   · 不能更晚：必须在预留/发单之前，否则等成本算出来时单已经在场所那边了。
  //
  // 与上游拦截流水线的分工：上游回答「这笔交易合不合规」（风控、冷却、日亏、置信度），
  // 这一道回答「这笔交易划不划算」（成本是否盖得住）。两者都会拒绝，
  // 但**合规优先**：所以本闸门排在上游之后，不抢上游的裁决权。
  //
  // 期望毛收益取自结构目标位——这正是「止损几何」已经算好的那笔盈利预期，
  // 不另设一套预测口径（否则又是两套口径：优化器按 A 估计收益、风控按 B 卡成本）。
  const plannedNotional = qty * price
  const expectedEdgeBps = price > 0 ? ((target.price - price) / price) * 10_000 : 0
  const cost = assessEdge(
    liveCexCostInput({
      venue: ACCOUNT_KEY.venue,
      notionalUsdt: plannedNotional,
      expectedEdgeBps,
      holdingHours: TIME_STOP_HOURS,
    }),
  )

  if (!cost.ok) {
    lastInterception = { at: now, reason: cost.reason, code: `COST_${cost.verdict}`, blockedBy: '成本闸门' }
    appendEvent('AUTOPILOT_INTERCEPTED', {
      code: `COST_${cost.verdict}`,
      blockedBy: '成本闸门',
      reason: cost.reason,
      // `submitted: false` + `planned*` 命名是刻意的：这里的数量只是**被拒交易**的拟做规模。
      // 不标注的话，事后复盘会把日志里那个具体数字误读成「系统本来要下这么多」，
      // 把一次成功的拦截读成一次失败的发单。
      submitted: false,
      plannedNotional: round2(plannedNotional),
      plannedQty: qty,
      expectedEdgeBps: round2(expectedEdgeBps),
      grossEdgeUsdt: cost.grossEdgeUsdt,
      totalCostUsdt: cost.totalCostUsdt,
      netEdgeUsdt: cost.netEdgeUsdt,
      edgeMultiple: cost.edgeMultiple,
      requiredMultiple: cost.requiredMultiple,
      costShareBps: cost.costShareBps,
      maxCostShareBps: cost.maxCostShareBps,
      costItems: cost.breakdown.items.map((i) => ({ label: i.label, bps: i.bps, usdt: i.usdt, fixed: i.fixed })),
      geometry: { entry: round2(price), target: round2(target.price), stop: round2(stop) },
    })
    console.log(`[cost] 拦截（${cost.verdict}）：${cost.reason}`)
    return
  }

  // 预留 ID 在发单**之前**生成：若进程在 submitOrder 与落账之间崩溃，
  // 重启后 recoverOrphans 仍能找到这条占用记录并标记为孤儿，
  // 而不是因为「没有 ID」而彻底丢失这笔未知敞口。
  // 预留 ID 在发单**之前**生成并落账：若进程在 submitOrder 期间崩溃，
  // 重启后 recoverOrphans 仍能找到这条占用记录并标记为孤儿。
  // 反过来（先发单后落账）会出现一个既没有场所回执、也没有本地记录的敞口，
  // 那才是真正无法对账的黑洞。
  const intentId = `ap-open-${now.toString(36)}-${qxRandom()}`
  const reservation = getReservationManager()
  const notional = qty * price
  const snapshotMeta = decisionSnapshot(regime, price, stopAtr, {
    atrMultiplier: round2(geometry.atrMultiplier),
    rr: round2(rr),
    stopPct: round2(geometry.distancePct * 100),
  })

  // ── 独立复核（maker-checker）──────────────────────────────────────
  // 位置刻意放在成本闸门**之后**、预留与发单**之前**：
  //   · 成本闸门回答「这笔值不值得做」（经济性）
  //   · 复核回答「这笔是不是它声称的那一笔」（一致性）
  // 两者失效方式不同，不能互相替代：一笔成本划算的交易，规模仍可能与声称的差 100 倍。
  // 复核不通过即放弃开仓 —— 声称与推导不一致时，"哪个是对的"本身未知，
  // 任何自动修正都是猜（详见 makerChecker.ts 的设计说明）。
  const review = reviewAndAudit({
    thesis: {
      strategyId: decision.strategyId ?? `${winner.id}:${JSON.stringify(winner.params)}`,
      symbol: SYMBOL,
      side: 'long',
      rationale: `${winner.id}/${JSON.stringify(winner.params)} · 置信度 ${confidence.toFixed(2)} · 适应度 ${winnerFitness.toFixed(1)}`,
    },
    artifact: {
      side: 'buy',
      type: 'market',
      qty,
      leverage: autopilotLeverage(),
      instType: autopilotInstType(),
    },
    claims: { entryPrice: price, stopPrice: stop, targetPrice: target.price, riskAmountUsd: sizing.riskAmount, notionalUsd: qty * price, marginUsd: marginRequired(qty * price, autopilotLeverage()), rrRatio: rr },
    context: {
      equity,
      markPrice: price,
      atrAtEntry: stopAtr,
      costVerdict: { ok: cost.ok, verdict: cost.verdict, notionalUsdt: plannedNotional },
    },
  })
  if (!review.ok) {
    lastInterception = {
      at: now,
      reason: review.reasons.join('；') || '独立复核未通过',
      code: `VERIFIER_${review.status.toUpperCase()}`,
      blockedBy: '独立复核',
    }
    appendEvent('AUTOPILOT_INTERCEPTED', {
      code: `VERIFIER_${review.status.toUpperCase()}`,
      blockedBy: '独立复核',
      reason: review.reasons.join('；'),
      submitted: false,
      failedChecks: review.checks.filter((c) => !c.ok).map((c) => c.id),
      plannedQty: qty,
      plannedNotional: round2(qty * price),
    })
    console.log(`[verifier] 拦截（${review.status}）：${review.reasons[0] ?? '未通过'}`)
    return
  }

  // ── 预留先行：占用预算 → 发单 → 按回执推进状态 ──────────────────────
  // 这一步若抛 ReservationExceeded（组合预算越界），必须**放弃开仓**——
  // 不能因为「预留层出错」就跳过风控直接下单，那等于把闸门拆了。
  try {
    const r = reservation.reserve(ACCOUNT_KEY, intentId, notional, STATE_PENDING)
    if (r.changed) {
      appendEvent('AUTOPILOT_RESERVATION_CREATED', {
        intentId,
        notional: round2(notional),
        state: STATE_PENDING,
        reservedAfter: round2(reservation.totalReserved(ACCOUNT_KEY)),
      })
    }
  } catch (e) {
    appendEvent('AUTOPILOT_RESERVATION_BLOCKED', {
      intentId,
      notional: round2(notional),
      reason: e instanceof Error ? e.message : String(e),
      context: 'open',
    })
    console.warn(`[reservation] 拒绝开仓：${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const outcome = await submitOrder('buy', qty)

  if (!outcome.ok) {
    // 关键判断：下单失败**不等于**没建仓。只有「场所明确拒绝」才能释放预算；
    // 适配器缺失、握手未完成、超时这类失败，场所侧状态是未知的，
    // 必须记为 unknown 继续占用——否则下一周期引擎会认为空仓而重复开仓，
    // 实际敞口翻倍。这正是历史上 LEDGER_MISMATCH 的成因 A。
    try {
      const verdict = classifyOrderFailure(outcome.reason)
      reservation.reserve(ACCOUNT_KEY, intentId, notional, verdict)
      appendEvent('AUTOPILOT_RESERVATION_SETTLED', {
        intentId,
        outcome: 'failed',
        reason: outcome.reason,
        reservationState: verdict,
        heldBudget: verdict === STATE_UNKNOWN,
      })
    } catch (e) {
      // 预留层自身出错不能阻断交易主流程，但必须留痕——静默失败比越界更危险
      appendEvent('AUTOPILOT_RESERVATION_ERROR', {
        intentId,
        phase: 'settle_failed_order',
        error: e instanceof Error ? e.message : String(e),
      })
    }
    appendEvent('AUTOPILOT_ORDER_REJECTED', { reason: outcome.reason, side: 'buy', context: 'open' })
    return
  }

  try {
    reservation.reserve(ACCOUNT_KEY, intentId, notional, STATE_CONFIRMED)
    openReservationIntent = intentId
  } catch (e) {
    appendEvent('AUTOPILOT_RESERVATION_ERROR', {
      intentId,
      phase: 'confirm_filled_order',
      error: e instanceof Error ? e.message : String(e),
    })
  }

  openPosition({ symbol: SYMBOL, side: 'long', entryPrice: price, qty, atrValue: stopAtr, now })

  appendEvent('AUTOPILOT_POSITION_OPENED', {
    side: 'long',
    entryPrice: round2(price),
    qty,
    notional: round2(qty * price),
    stop: round2(stop),
    stopPct: round2(geometry.distancePct * 100),
    target: round2(target.price),
    targetBasis: target.basis,
    rr: round2(rr),
    atr: round2(stopAtr),
    atrMultiplier: round2(geometry.atrMultiplier),
    atrSource,
    riskAmount: round2(sizing.riskAmount),
    riskBudget: round2(sizing.riskBudget),
    bindingConstraint: sizing.bindingConstraint,
    confidence,
    interceptorTrail: result.trail.length,
    strategyId: decision.strategyId,
    reservationIntent: intentId,
    // 决策时刻的动力学快照 + 证据完整度分档，复盘与心法提炼的依据
    snapshot: snapshotMeta.snapshot,
    snapshotObservability: snapshotMeta.snapshotObservability,
    // 成本闸门放行时的完整成本构成。留痕的理由是「净收益」必须可复算：
    // 只记一个「通过」，事后无法回答「当时按什么费率算的」，
    // 也就无法判断这笔盈利是不是建立在过期的成本假设上。
    cost: {
      verdict: cost.verdict,
      grossEdgeBps: round2(expectedEdgeBps),
      grossEdgeUsdt: cost.grossEdgeUsdt,
      totalCostUsdt: cost.totalCostUsdt,
      totalCostBps: cost.costShareBps,
      netEdgeUsdt: cost.netEdgeUsdt,
      edgeMultiple: cost.edgeMultiple,
      requiredMultiple: cost.requiredMultiple,
      items: cost.breakdown.items.map((i) => ({ label: i.label, bps: i.bps, usdt: i.usdt })),
    },
  })
  console.log(
    `[guard] 开多 ${qty} @${price.toFixed(2)} · 止损 ${stop.toFixed(2)}(${(geometry.distancePct * 100).toFixed(2)}%) · 目标 ${target.price.toFixed(2)} · R:R=${rr.toFixed(2)} · 1R=${sizing.riskAmount.toFixed(0)}`,
  )
}

/**
 * 分批平仓。
 *
 * 改造前这里有一个会**永久丢失持仓**的缺陷：单笔数量被 `maxNotionalPerOrder` 截断后，
 * 只提交了其中一部分，却无条件把 `apPosQty` 置 0。结果是「本地以为空了、账上还有货」——
 * 这正是历史上账本对不上（LEDGER_MISMATCH）的成因之一，
 * 也是 BTC 持仓 1.0002 个（≈7.8 万 USDC）却单笔上限 5 万、导致 122 次下单全被拒的直接原因。
 *
 * 现在按单笔上限**切片多次提交**，只有全部成交才清零；任何一片失败即停止并如实记录剩余量。
 */
async function flatten(reason: string): Promise<void> {
  const guard = getPosition(SYMBOL)
  const startQty = Math.abs(apPosQty) > 1e-9 ? Math.abs(apPosQty) : Math.abs(guard?.qty ?? 0)
  if (!deps || startQty < 1e-9) return

  const s = deps.getState()
  const price = s.lastPrice.get(SYMBOL) ?? candles[candles.length - 1]?.c ?? 0
  if (price <= 0) return

  const side: 'buy' | 'sell' = (guard?.side ?? (apPosQty > 0 ? 'long' : 'short')) === 'long' ? 'sell' : 'buy'

  // 单笔可承载的数量：live 用资金帽，paper 用编排器风控的单价上限，
  // 留 2% 余量防止因价格微动刚好越界被拒。
  const perOrderNotionalCap = isAutopilotLive() ? autopilotMaxNotional() : s.risk.maxNotionalPerOrder
  const perOrderCap = (perOrderNotionalCap * 0.98) / price
  const maxChunks = 20

  let remaining = round5(startQty)
  let sent = 0
  let chunks = 0

  while (remaining > 1e-5 && chunks < maxChunks) {
    const slice = round5(Math.min(remaining, perOrderCap))
    if (slice <= 0) break
    const outcome = await submitOrder(side, slice)
    if (!outcome.ok) {
      appendEvent('AUTOPILOT_FLATTEN_PARTIAL', {
        scope: isAutopilotLive() ? 'live' : 'paper',
        reason,
        slice,
        sent,
        remaining,
        error: outcome.reason,
      })
      console.log(`[autopilot] ⚠️ 分批平仓中断：剩余 ${remaining.toFixed(5)}（${outcome.reason}）`)
      // 剩余量同步回守卫，下一周期继续尝试，绝不清零
      if (guard) updatePosition({ ...guard, qty: remaining })
      return
    }
    remaining = round5(remaining - slice)
    sent += slice
    chunks += 1
  }

  const fullyFlat = remaining <= 1e-5
  if (fullyFlat) {
    apPosQty = 0
    closePosition(SYMBOL, false, Date.now())
    // 只有**全部**平掉才释放风险预算。部分平仓时继续占用：
    // 剩余那一截依然是真实敞口，提前还额度会让组合层误判可用风险。
    if (openReservationIntent) {
      try {
        const r = getReservationManager().release(ACCOUNT_KEY, openReservationIntent, STATE_CLOSED)
        appendEvent('AUTOPILOT_RESERVATION_RELEASED', {
          intentId: openReservationIntent,
          state: r.snapshot.state,
          reason,
          reservedAfter: round2(getReservationManager().totalReserved(ACCOUNT_KEY)),
        })
      } catch (e) {
        appendEvent('AUTOPILOT_RESERVATION_ERROR', {
          intentId: openReservationIntent,
          phase: 'release_on_close',
          error: e instanceof Error ? e.message : String(e),
        })
      }
      openReservationIntent = null
    }
  } else if (guard) {
    updatePosition({ ...guard, qty: remaining })
  }

  appendEvent('AUTOPILOT_FLATTEN', {
    scope: isAutopilotLive() ? 'live' : 'paper',
    reason,
    qty: round5(sent),
    side,
    ok: fullyFlat,
    chunks,
    remaining: round5(remaining),
  })
}

export function autopilotStatus(): AutopilotStatus {
  const s = deps?.getState()
  const equity = s ? markedEquity(s) : null
  const pnlPct = equity !== null && baselineEquity ? ((equity - baselineEquity) / baselineEquity) * 100 : null
  return {
    running,
    stage,
    mode: isAutopilotLive() ? 'live' : 'paper',
    symbol: SYMBOL,
    targetPct,
    startedAt,
    baselineEquity,
    equity: equity ?? 0,
    pnlPct: pnlPct !== null ? Math.round(pnlPct * 100) / 100 : null,
    cycles,
    barsAccumulated: candles.length,
    winner: winner ? `${winner.id}:${JSON.stringify(winner.params)}` : null,
    lastActionAt: lastBarTs,
    guard: guardView(s),
    lastInterception,
    gateRefusal: lastGateRefusal,
    dailyLoss: round2(dailyRealizedLoss),
    dailyLossLimit: equity !== null ? round2(dailyLossLimit(equity)) : 0,
    regime: regimeView(),
  }
}

/** 把守护持仓摊平成前端可渲染的视图（含实时 R 倍数与浮盈率）。 */
function guardView(s: OrchState | undefined): AutopilotStatus['guard'] {
  const guard = getPosition(SYMBOL)
  if (!guard) return null
  const mark = s?.lastPrice.get(SYMBOL) ?? candles[candles.length - 1]?.c ?? guard.entryPrice
  return {
    side: guard.side,
    entryPrice: round2(guard.entryPrice),
    qty: guard.qty,
    initialStop: round2(guard.initialStop),
    currentStop: round2(guard.currentStop),
    r: round2(rMultiple(guard, mark)),
    unrealizedRoiPct: round2(unrealizedRoi(guard, mark) * 100),
    breakevenArmed: guard.breakevenArmed,
    lockArmed: guard.lockArmed,
    openedAgoMin: Math.round((Date.now() - guard.openedAt) / 60_000),
    atrAtEntry: round2(guard.atrAtEntry),
  }
}

function regimeView(): AutopilotStatus['regime'] {
  const snapshot = getRegime(SYMBOL)
  if (!snapshot) return null
  return {
    macroTrend: snapshot.macroTrend,
    macroTrendSource: snapshot.macroTrendSource,
    atr1h: round2(snapshot.atr1h),
    adx1h: snapshot.adx1h !== undefined ? round2(snapshot.adx1h) : null,
    stale: snapshot.stale,
  }
}

/**
 * 开仓决策的动力学快照 + 可观测性分档。
 *
 * 为什么要打进事件里而不是「反正 regime 每次都能重新拉」：
 * 事后复盘要回答的是「**当时**为什么这么判」，而 regime 是 5 分钟 TTL 的滚动缓存。
 * 不落盘的话，复盘时读到的是当下的市场，不是决策时的市场——归因就无从谈起。
 *
 * 同时打上 `snapshotObservability` 标签，让样本质量可度量（见 decisionObservability.ts）。
 * 缺字段时如实标为 PARTIAL/PRICE_ONLY，绝不伪造数值凑成「完全可观测」。
 */
function decisionSnapshot(
  regime: RegimeSnapshot | undefined,
  price: number,
  stopAtr: number,
  extra: Record<string, unknown> = {},
): { snapshot: Record<string, unknown> | null; snapshotObservability: Observability } {
  const raw: Record<string, unknown> = {
    price: round2(price),
    atr1h: round2(stopAtr),
    atr4h: regime ? round2(regime.atr4h) : undefined,
    adx1h: regime?.adx1h !== undefined ? round2(regime.adx1h) : undefined,
    macroTrend: regime?.macroTrend,
    h1SwingHigh: regime ? round2(regime.h1SwingHigh) : undefined,
    h1SwingLow: regime ? round2(regime.h1SwingLow) : undefined,
    h1Close: regime ? round2(regime.h1Close) : undefined,
    h4Close: regime ? round2(regime.h4Close) : undefined,
    ...extra,
  }
  return {
    snapshot: pruneSnapshot(raw),
    snapshotObservability: classifySnapshotObservability(raw),
  }
}
