import type { OrderSide, OrderStatus, OrderType } from '../src/engine/index.ts'
import type { PositionProtection } from './protection.ts'
import {
  MAX_DRAWDOWN_PCT,
  MAX_NOTIONAL_PER_ORDER,
  MAX_ORDERS_PER_MINUTE,
  PRICE_DEVIATION_BPS,
} from './riskConstants.ts'

export interface OrchOrder {
  id: string
  clientOrderId: string
  symbol: string
  side: OrderSide
  type: OrderType
  price?: number
  qty: number
  filledQty: number
  status: OrderStatus
  createdAt: number
}

export type LedgerKind =
  | 'ORDER_SUBMIT'
  | 'ORDER_ACK'
  | 'ORDER_REJECT'
  | 'ORDER_FILL'
  | 'ORDER_CANCEL'
  | 'KILLSWITCH_ON'
  | 'KILLSWITCH_OFF'
  | 'EQUITY_SNAPSHOT'
  | 'RISK_CIRCUIT_BREAK'

export interface LedgerEvent {
  seq: number
  ts: number
  kind: LedgerKind
  payload: Record<string, unknown>
}

export interface RiskConfig {
  maxNotionalPerOrder: number
  maxOrdersPerMinute: number
  maxDrawdownPct: number
  priceDeviationBps: number
}

/**
 * 运行时风控配置（进程内可变，通过 /risk/config 热调）。
 *
 * ⚠️ 这里的默认值**取自 `riskConstants.ts`（单一事实源）**，不再各自硬编码。
 * 历史上这几项在 types.ts 与 index.ts 各写了一遍，导致「管理页显示 5 万、
 * 环境变量配的却是另一个值」这类口径漂移——而风控参数的漂移不会报错，
 * 只会让人对着失真的面板做资金决策。
 */
export const DEFAULT_RISK: RiskConfig = {
  maxNotionalPerOrder: MAX_NOTIONAL_PER_ORDER,
  maxOrdersPerMinute: MAX_ORDERS_PER_MINUTE,
  maxDrawdownPct: MAX_DRAWDOWN_PCT,
  priceDeviationBps: PRICE_DEVIATION_BPS,
}

export interface OrchPosition {
  symbol: string
  qty: number
  avgPrice: number
}

export interface EquityPoint {
  t: number
  equity: number
}

export interface OrchState {
  mode: 'paper' | 'live'
  killswitch: boolean
  balanceUSDC: number
  startingBalance: number
  peakEquity: number
  positions: Map<string, OrchPosition>
  orders: OrchOrder[]
  lastPrice: Map<string, number>
  equityCurve: EquityPoint[]
  risk: RiskConfig
  submitTimestamps: number[]
  /**
   * 保护单台账：symbol → 这道仓位的止盈/止损（绝对价）。
   *
   * ★ 与 `positions` **分开存**，不是冗余：两者生命周期不同。
   *   市价单在纸面引擎里要等下一根 bar 才成交（`matching.ts` 的
   *   `eligibleFromBar`），所以"保护已经挂上"与"持仓已经存在"之间
   *   有一段真实的时间差。挂在 `positions` 上就必须等持仓出现才记 ——
   *   而那段窗口里用户以为有保护、实际什么都没有。
   */
  protection: Map<string, PositionProtection>
}
