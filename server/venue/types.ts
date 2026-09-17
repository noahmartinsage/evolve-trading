export interface VenueIntent {
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  qty: number
  /** 杠杆倍数（以小博大）：>1 时使用全仓保证金，以持仓作为抵押物借币/借合约交易 */
  leverage?: number
  /**
   * 交易品种。缺省 SPOT（兼容既有调用方）。
   * - SPOT：现货（杠杆现货最高约 10x，达不到 125x）
   * - SWAP：永续合约（125x 只在此形态下存在）
   */
  instType?: 'SPOT' | 'SWAP'
  /**
   * 合约保证金结算方式（仅 instType='SWAP' 时有意义）：
   * - linear（U 本位）：BTC-USDT-SWAP，USDT 计价结算，盈亏线性
   * - inverse（币本位）：BTC-USD-SWAP，USD 计价、币结算，盈亏非线性
   */
  settle?: 'linear' | 'inverse'
}

export interface VenueFill {
  fillId: string
  venueOrderId: string
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  ts: number
}

export interface VenuePosition {
  symbol: string
  qty: number
  avgPrice: number
}

export interface BalanceSnapshot {
  cash: number
  positions: VenuePosition[]
  totalFills: number
}

export interface VenueAdapter {
  readonly name: string
  place(intent: VenueIntent): Promise<{ venueOrderId: string }>
  cancel(venueOrderId: string): Promise<boolean>
  onFill(cb: (f: VenueFill) => void): void
  reconcile(): Promise<BalanceSnapshot>
  openOrderIds(): string[] | Promise<string[]>
}
