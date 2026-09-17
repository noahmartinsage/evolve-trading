export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'
export type OrderStatus = 'new' | 'ack' | 'partial' | 'filled' | 'cancelled' | 'rejected'

export interface Order {
  id: string
  symbol: string
  side: OrderSide
  type: OrderType
  price: number
  qty: number
  filledQty: number
  status: OrderStatus
  createdAtBar: number
  eligibleFromBar: number
}

export interface Fill {
  orderId: string
  side: OrderSide
  price: number
  qty: number
  fee: number
  bar: number
  ts: number
}

export interface ExecConfig {
  makerFeeBps: number
  takerFeeBps: number
  slippageBps: number
  maxParticipation: number
  latencyBars: number
}

export const DEFAULT_EXEC: ExecConfig = {
  makerFeeBps: 2,
  takerFeeBps: 5,
  slippageBps: 3,
  maxParticipation: 0.1,
  latencyBars: 1,
}
