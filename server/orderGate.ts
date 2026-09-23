/**
 * 下单闸门的**唯一服务端入口**（判据 8「一个业务动作一条实现路径」的直接落地）。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────────
 * 在它出现之前，真正**出单**的有三条路：自治循环、`POST /orders`、语音的
 * `submitOrder()`；而那把真正的闸门 `precheckLiveTrade()` 只有
 * `POST /orders/precheck` 一个调用面。于是"闸门"只挡得住**愿意先问一声**的人：
 * 交易大厅问完再下单，而语音与 `/orders` 一次都不问就出单。
 * 同一个业务动作两份规矩，其中一份从不执行 —— 这就是它要治的形态。
 *
 * ── 分工边界（不许混）────────────────────────────────────────────────
 * · 判断**一行都不在这里** —— 全在 `precheckTrade()`（纯函数，可被烟测造边界）。
 * · 取数**一眼都不在这里** —— 全在 `precheckLiveTrade()`。
 * · 这里只做一件事：把「谁在问」（`source`）与「凭哪份账户/行情数据」（deps）
 *   接起来，让所有调用方拿到的是**同一次调用的同一份结果**。
 *   ★ 若三个调用方各自 inline 一遍 `precheckLiveTrade(...)`，它们今天看起来
 *     一致、明天改一处就分岔，而且**没有任何断言会红**（判据 B2）。
 *     所以烟测里有一条**结构断言**：除本文件外，`precheckLiveTrade` 不许有
 *     别的生产调用方。
 *
 * ── 与既有 `ORDER_PRECHECK` 事件的关系（红线 ⑯：一句话一个主人）──────
 * `source === 'precheck'`（交易大厅主动问一次）仍记 `ORDER_PRECHECK`，
 * 保持既有语义与文档引用；另外两个来源记 `ORDER_GATE`。
 * 两者都在**同一个函数**里发，所以"留痕"这件事只有一个主人。
 */

import { precheckLiveTrade, type LivePrecheckDeps, type PrecheckResult } from './tradeGate.ts'
import { getRegime, refreshRegime } from './marketRegime.ts'
import { autopilotStatus } from './autopilot.ts'
import { currentEquity } from './risk.ts'
import { getReservationManager } from './riskReservation.ts'
import { getOrchState } from './core.ts'
import { appendEvent } from './ledger.ts'

/** 这道闸门是**谁**在问。它决定留痕用哪个事件名，也决定事后怎么追。 */
export type GateSource = 'precheck' | 'orders' | 'voice'

export interface GateOrderRequest {
  /**
   * **交易所符号**（`BTCUSDT`）。
   *
   * ★ 服务端口径就是它：`ORCH_SYMBOLS` 与 `state.lastPrice` 的键同源，
   *   所以这里**不需要**任何内部符号（`BTC-USDT`）的映射 ——
   *   那张映射表住在前端 `src/market/registry.ts`，服务端从来没见过它。
   *   若在这里臆造一份映射，就会造出"闸门拿着一个取不到行情的符号去问"
   *   ⇒ 一律 `unverifiable` ⇒ 把每一笔正常单都误拒（判据 A1）。
   */
  symbol: string
  side: 'buy' | 'sell'
  notionalUsdt: number
  entry: number
  takeProfit: number
  stopLoss: number
  environment: 'paper' | 'live'
  confidence?: number
  channel?: 'cex' | 'dex'
  venue?: string
  expectedEdgeBps?: number
  holdingHours?: number
  markPrice?: number
  refresh?: boolean
  forecastClaims?: boolean
  forecastHorizonMinutes?: number
  /**
   * 用户**显式放弃**保护价（裸单）。缺省 `false`。
   * ★ 只有用户的明确表态才能把它设成 `true` —— 见 `tradeGate.PrecheckInput.protectionWaived`：
   *   把"没给保护价"自动读成"用户不要保护"，会让任何一次上游漏填静默降级成裸单放行。
   */
  protectionWaived?: boolean
  /** 生效杠杆（已被 `judgeLeverage` 裁决过）。裸单的合约单必填，否则闸门算不出强平距离。 */
  leverage?: number
  /** 品种形态。裸单几何只在 `SWAP` 上有意义。 */
  instType?: 'SPOT' | 'SWAP'
}

export interface GateOrderOptions {
  source: GateSource
}

/**
 * 闸门要用的账户/行情数据，**唯一组装处**。
 *
 * ★ 每一个数都写上它从哪来 —— 「这个数从哪来」在每一处都要能被回答一次。
 *   尤其 `dailyLoss` 用的是**引擎账本口径**（自治循环的已实现亏损），
 *   它**不含**交易大厅的纸面成交；这一点由 `precheckLiveTrade()` 的
 *   `disclosures` 如实说出来，不要在这里再写一遍（红线 ⑯）。
 */
export function livePrecheckDeps(env: 'paper' | 'live'): LivePrecheckDeps {
  return {
    refreshRegime,
    getRegime,
    account: () => {
      const s = getOrchState()
      const ap = autopilotStatus()
      return {
        equity: currentEquity(s),
        killswitch: s.killswitch,
        dailyLoss: ap.dailyLoss,
        dailyLossLimit: ap.dailyLossLimit,
      }
    },
    exposure: () => {
      const rm = getReservationManager()
      return {
        grossUsdt: rm.grossExposure(env),
        limitUsdt: rm.totalLimitUsdt,
        unreleasedCount: rm.listUnreleased(env).length,
      }
    },
  }
}

/**
 * 跑一次下单闸门。**所有出单路径都必须经过这里**。
 *
 * 返回值是裁决本身（四态互不顶替：`pass` / `blocked` / `approval_required` /
 * `unverifiable`）。**它不替你决定"拒还是放"** —— 调用方必须自己读
 * `submitAllowed`，并在为假时用 `result.summary` + `result.blockers` 说明是哪道门。
 * （刻意不在这里抛异常：抛异常会把"查不了"和"被拒"压成同一个失败。）
 */
export async function gateOrderForExecution(
  req: GateOrderRequest,
  opts: GateOrderOptions,
): Promise<PrecheckResult> {
  const deps = livePrecheckDeps(req.environment)
  const base = {
    symbol: req.symbol,
    side: req.side,
    notionalUsdt: req.notionalUsdt,
    entry: req.entry,
    takeProfit: req.takeProfit,
    stopLoss: req.stopLoss,
    ...(req.confidence === undefined ? {} : { confidence: req.confidence }),
    environment: req.environment,
    channel: req.channel ?? ('cex' as const),
    ...(req.venue === undefined ? {} : { venue: req.venue }),
    ...(req.expectedEdgeBps === undefined ? {} : { expectedEdgeBps: req.expectedEdgeBps }),
    ...(req.holdingHours === undefined ? {} : { holdingHours: req.holdingHours }),
    ...(req.markPrice === undefined ? {} : { markPrice: req.markPrice }),
    refresh: req.refresh === true,
    forecastClaims: req.forecastClaims === true,
    ...(req.forecastHorizonMinutes === undefined ? {} : { forecastHorizonMinutes: req.forecastHorizonMinutes }),
    protectionWaived: req.protectionWaived === true,
    ...(req.leverage === undefined ? {} : { leverage: req.leverage }),
    ...(req.instType === undefined ? {} : { instType: req.instType }),
  }

  const result = await precheckLiveTrade(base, deps)

  // ── 关于「调用方没给止盈止损」：**如实裁决，不许替它补** ──────────────
  //
  // ★ 曾经在这里写过一版"没给保护就用 `result.suggested`（引擎几何的建议价）
  //   补上再判一次"，好让"只填了方向与数量的单"也拿得到绿色裁决。**这条路是错的**，
  //   而且错得隐蔽：那一次的裁决评的是"建议保护版"的那笔单，而**真正出网的是裸单**。
  //   裁决与执行成了两个东西 —— 正是本仓库付过代价的那类缺陷
  //   （判据 B2：断的是"起作用了"还是"出现过"；红线 ⑯：一句话一个主人）。
  // ⇒ 现在：缺保护 ⇒ `precheckTrade()` 如实 `unverifiable`，
  //   `suggested` 照常回给调用方，由**人**决定要不要照它挂；
  //   `submitAllowed` 为假时 `describeGateRefusal()` 会把可照做的数字一并说出来。

  // ── 留痕：**只读**不等于**不留痕** ─────────────────────────────────
  //
  // ★ 落 `pipeline`（扫到哪就停了）与 `suggested` 的有无：
  //   没有它们，事后只能回答"当时拒了"，回答不了"它扫到第几道"与
  //   "有没有给过可照做的数字"—— 而这两件事才是复盘要用的（判据 C4）。
  const evt = opts.source === 'precheck' ? 'ORDER_PRECHECK' : 'ORDER_GATE'
  appendEvent(evt, {
    source: opts.source,
    symbol: result.symbol,
    side: result.side,
    notionalUsdt: result.notionalUsdt,
    verdict: result.verdict,
    submitAllowed: result.submitAllowed,
    blockers: result.blockers.map((b) => b.id),
    pipeline: result.pipeline,
    confidenceUsed: result.confidenceUsed,
    environment: req.environment,
    channel: base.channel,
    hasSuggestion: result.suggested !== null,
    // ★★ 落「这笔是不是裸单」与「有哪几道门没查」。
    //   判据：**"豁免生效了"必须有一个自己的观测点**——否则事后只能看到
    //   `verdict: pass`，看不出这次放行跳过了哪道门（保护单那次的教训：
    //   "解析对了 / 记下了" ≠ "挂上了"，必须有观测点问"它有没有真的进到单子里"）。
    protectionWaived: req.protectionWaived === true,
    notChecked: result.legs.filter((l) => l.notChecked === true).map((l) => l.id),
    leverage: req.leverage ?? null,
    instType: req.instType ?? 'SPOT',
    // ★ 把预测腿的实况一起落账：不落的话，事后无法回答"那次拒绝到底是因为
    //   行情/赔率/敞口，还是因为预测层说没有优势"—— 而这四种事因指向的
    //   动作完全不同（判据 C5）。
    forecast: {
      claims: result.forecast.claims,
      outcome: result.forecast.outcome,
      gate: result.forecast.gate,
    },
  })

  return result
}

/**
 * 把一条**订单意图**推成闸门输入。
 *
 * ★ 它是 `/orders` 与语音共用的那一份推导：`qty` 与 `price` 在某些分支里
 *   是"拿不到的"（市价单没有价、没填数量），**拿不到就必须拒绝并说明**，
 *   不许按 0 推 —— 按 0 推出来的名义额会让每一道按规模判断的门静默失效
 *   （红线 ㉟ 的同族：`null` 不许退化成 0）。
 */
export function gateInputFromOrderIntent(
  intent: {
    symbol?: string
    side?: 'buy' | 'sell'
    type?: 'market' | 'limit'
    price?: number
    qty?: number
    takeProfit?: number
    stopLoss?: number
  },
  opts: { environment: 'paper' | 'live'; mark: number | null; channel?: 'cex' | 'dex' },
): { ok: true; req: GateOrderRequest } | { ok: false; reason: string } {
  const symbol = intent.symbol
  if (!symbol) return { ok: false, reason: 'GATE_INPUT_MISSING_SYMBOL（不知道该评哪个标的）' }
  if (intent.side !== 'buy' && intent.side !== 'sell') {
    return { ok: false, reason: 'GATE_INPUT_MISSING_SIDE（不知道该评哪个方向）' }
  }
  const qty = intent.qty
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `GATE_INPUT_BAD_QTY（${String(qty)}）` }
  }
  // 市价单用当前标记价（用户没有别的选择）；限价单用用户填的价。
  const entry = intent.type === 'limit' && intent.price !== undefined && intent.price > 0 ? intent.price : opts.mark
  if (entry === null || entry === undefined || !Number.isFinite(entry) || entry <= 0) {
    return {
      ok: false,
      reason: `GATE_INPUT_NO_PRICE（${symbol} 既没有限价也没有可用的标记价，闸门无法评估）`,
    }
  }
  return {
    ok: true,
    req: {
      symbol,
      side: intent.side,
      notionalUsdt: entry * qty,
      entry,
      // ★ 缺保护传 0（而不是省略）：这个 0 会被闸门读成"没有保护价"，
      //   再决定要不要用引擎建议补 —— 而不是被当成"保护价就是 0"。
      takeProfit: intent.takeProfit ?? 0,
      stopLoss: intent.stopLoss ?? 0,
      environment: opts.environment,
      ...(opts.channel === undefined ? {} : { channel: opts.channel }),
      ...(opts.mark === null ? {} : { markPrice: opts.mark }),
    },
  }
}

/**
 * 拒绝时**给人看**的那句话：既要说清是哪一道门，也要带上可照做的数字。
 *
 * ★ 判据 D7：这个输出把用户引向哪个动作？那个动作有用吗？
 *   只回一句"被风控拒绝"会把人引向"那我再点一次"—— 那没有用。
 *   所以这里必须把 `blockers` 的 `detail`（含具体数值）与引擎的建议价带上。
 */
export function describeGateRefusal(result: PrecheckResult): string {
  const head = result.summary
  const blocked = result.blockers
    .filter((b) => !b.passed)
    .map((b) => b.detail)
    .filter((d) => typeof d === 'string' && d.length > 0)
  const tail = blocked.length > 0 ? `拦下它的门：${blocked.join('；')}` : ''
  const suggest = result.suggested
    ? `可照做的数字：止损 ${result.suggested.stopLoss}（${result.suggested.stopBasis}）、止盈 ${result.suggested.takeProfit}（${result.suggested.targetBasis}）。`
    : ''
  return [head, tail, suggest].filter((x) => x.length > 0).join(' ')
}

/** 闸门输入里"没有真实报价"这类硬缺口，统一在这里被识别（供调用方判断该不该退回原始错误）。 */
export const GATE_REFUSAL_PREFIXES = ['GATE_INPUT_'] as const
