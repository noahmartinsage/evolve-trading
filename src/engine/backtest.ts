import type { Candle, ExecConfig, Fill } from './types.ts'
import { MatchingEngine } from './matching.ts'
import type { Strategy, StrategyDecision } from './strategies.ts'

export interface EquityPoint {
  t: number
  equity: number
}

export interface BacktestMeta {
  engineVersion: string
  symbol: string
  bars: number
  barMinutes: number
  startingCash: number
  exec: ExecConfig
  strategyId: string
  params: Record<string, number>
  /** 是否允许做空（快照）。报告与门禁据此判断这条曲线来自哪种语义。 */
  allowShort: boolean
  /**
   * 中途是否爆过仓（权益 ≤ 0）。
   *
   * ★ 为什么必须有这个观测点：做空允许亏到超过本金，权益会变负，
   *   而负权益在报告里表现为"回撤 120%"这种看起来像算错了的数字。
   *   没有这个标记时，"爆仓"与"回撤很大"在系统里长得一样（判据 17 那族）。
   */
  liquidated: boolean
}

export interface BacktestResult {
  equityCurve: EquityPoint[]
  fills: Fill[]
  realizedPnls: number[]
  meta: BacktestMeta
}

export interface BacktestOptions {
  /**
   * 允许做空。**默认 false ⇒ 现货语义，现有调用方行为逐字节不变。**
   *
   * ★ 为什么需要它：原实现是纯多头（`posQty` 只在 > 0 时被卖出），
   *   于是"因子择时"在下跌行情里**数学上不可能毛收益为正** ——
   *   实测 BTC 12 个月买入持有 −34.01%、5 折里 3 折下跌，
   *   70 个通过因子层的因子在策略层全灭，而真因不是"因子方向不成立"，
   *   是"策略无法表达看空"。把"不能做空"与"信号没用"混成一个结论，
   *   会让下一步投错方向（去加更多因子，而不是给策略加表达力）。
   *
   * ★ 做成**可注入的选项而不是改默认值**：默认值一改，
   *   全系统所有既有回测的口径同时漂移，而漂移是静默的 ——
   *   `backtest:golden` 会红，但没人能从红的数字看出"为什么变了"。
   */
  allowShort?: boolean
}

export const ENGINE_VERSION = 'engine-v0.2.0'

export function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  exec: ExecConfig,
  startingCash = 100_000,
  barMinutes = 1,
  opts: BacktestOptions = {},
): BacktestResult {
  const allowShort = opts.allowShort ?? false
  const engine = new MatchingEngine(exec)
  let cash = startingCash
  /** 有符号持仓：正 = 多，负 = 空。 */
  let posQty = 0
  /** 有符号持仓成本：多头存买入成本（正），空头存卖出所得（**负**）。 */
  let posCost = 0
  let avgPrice = 0
  let liquidated = false
  const equityCurve: EquityPoint[] = []
  const realizedPnls: number[] = []

  const markEquity = (price: number) => cash + posQty * price

  // ★ 成交游标。`engine.fills` 是按 bar 单调追加的，所以"本根新成交"
  //   只需从上次位置往后取。旧写法每根 bar 重扫整个数组
  //   （`engine.fills.filter((f) => f.bar === i)`），是 O(bar × 成交数)；
  //   实测 35,040 根单次回测 97 秒，主因就在这一类重扫上（见 seriesCache.ts）。
  let fillCursor = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    engine.onBar(i, c)

    // 游标版本有一个必须显式处理的失效模式：若某笔成交带着**更早**的 bar
    // 晚一步被追加，游标会静默跳过它 —— 资金变动凭空消失，而净值曲线
    // 看起来完全正常（判据 11 那一族）。所以这里 fail-closed：
    // 一旦发现游标处的成交 bar 早于当前 i，立刻抛出，绝不继续跑。
    while (fillCursor < engine.fills.length) {
      const f = engine.fills[fillCursor]
      if (f.bar !== i) {
        if (f.bar < i) {
          throw new Error(
            `成交追加顺序违约：处理第 ${i} 根时发现 bar=${f.bar} 的成交仍未消费。` +
              `engine.fills 必须按 bar 单调追加，否则成交游标会静默漏账。`,
          )
        }
        break
      }
      fillCursor += 1
      const notional = f.price * f.qty
      if (f.side === 'buy') {
        if (posQty >= -1e-12) {
          // 开多 / 加多
          cash -= notional + f.fee
          posQty += f.qty
          posCost += notional + f.fee
        } else {
          // 平空：买回。当初的卖出所得记在 posCost 的**负值**里。
          // 单位卖出所得 = posCost / posQty（负 ÷ 负 = 正），
          // 平仓盈亏 = 当初卖出所得 − 现在买回成本。
          const closedQty = Math.min(f.qty, -posQty)
          const unitProceeds = posCost / posQty
          const costBasis = unitProceeds * closedQty
          cash -= notional + f.fee
          realizedPnls.push(costBasis - (notional + f.fee))
          posQty += closedQty
          posCost += costBasis
        }
      } else if (posQty > 1e-12) {
        const closedQty = Math.min(f.qty, posQty)
        const unitCost = posCost / posQty
        const costBasis = unitCost * closedQty
        cash += notional - f.fee
        realizedPnls.push(notional - f.fee - costBasis)
        posQty -= closedQty
        posCost -= costBasis
      } else if (allowShort) {
        // 开空：posQty 变负，posCost 记为负的卖出所得（扣费后的净所得）。
        cash += notional - f.fee
        posQty -= f.qty
        posCost -= notional - f.fee
      }
      // 用 |posQty| 判空 —— 空头持仓时 posQty 是负数，写成 `posQty > 1e-12`
      // 会把"持空"误判成"空仓"，于是 avgPrice 被清零、下一笔平仓算不出成本。
      if (Math.abs(posQty) > 1e-12) avgPrice = posCost / posQty
      else {
        posQty = 0
        posCost = 0
        avgPrice = 0
      }
    }

    const equityNow = markEquity(c.c)
    // 爆仓：权益归零/为负。做空独有（现货最多亏到 0）。
    // 处理方式是**停止开新仓**而不是抛错 —— 抛错会让整条曲线拿不到，
    // 而"这个候选会爆仓"本身就是要被门看到的信息。
    if (allowShort && equityNow <= 0) liquidated = true

    if (!liquidated) {
      const decision: StrategyDecision | null = strategy.decide({
        i,
        candles,
        posQty,
        avgPrice,
        equity: equityNow,
      })

      if (decision) {
        if (decision.side === 'buy') {
          if (posQty >= -1e-12) {
            // 开多：名义 = 账户权益 × frac
            const budget = equityNow * decision.frac
            const refPrice = decision.type === 'limit' ? decision.price ?? c.c : c.c
            const qty = budget / (refPrice * (1 + exec.slippageBps / 10_000))
            engine.submit('buy', decision.type, decision.price ?? refPrice, qty, i)
          } else {
            // 平空：按 |posQty| × frac 买回
            const qty = decision.frac >= 1 ? -posQty : -posQty * decision.frac
            engine.submit('buy', decision.type, decision.price ?? c.c, qty, i)
          }
        } else if (posQty > 1e-12) {
          const qty = decision.frac >= 1 ? posQty : posQty * decision.frac
          engine.submit('sell', decision.type, decision.price ?? c.c, qty, i)
        } else if (allowShort) {
          // 开空：名义 = 账户权益 × frac。卖价要**低于**标记价一个滑点
          // （与 matching.ts 里 sell 的 `1 - slippage` 同向，不在这里各写一份）。
          const budget = equityNow * decision.frac
          const refPrice = decision.type === 'limit' ? decision.price ?? c.c : c.c
          const qty = budget / (refPrice * (1 - exec.slippageBps / 10_000))
          engine.submit('sell', decision.type, decision.price ?? refPrice, qty, i)
        }
      }
    }

    equityCurve.push({ t: c.t, equity: markEquity(c.c) })
  }

  return {
    equityCurve,
    fills: engine.fills,
    realizedPnls,
    meta: {
      engineVersion: ENGINE_VERSION,
      symbol: 'SYNTH',
      bars: candles.length,
      barMinutes,
      startingCash,
      exec,
      strategyId: strategy.id,
      params: strategy.params,
      allowShort,
      liquidated,
    },
  }
}
