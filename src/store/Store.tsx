import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import type { Candle, TickerUpdate } from '../data/market'

export type PageId = 'overview' | 'voice' | 'mission' | 'brain' | 'terminal' | 'agents' | 'evo' | 'protocol' | 'risk' | 'seam' | 'monitor' | 'settings'

export type TradeMode = 'sim' | 'paper' | 'live'

export const MODE_META: Record<TradeMode, { label: string; desc: string; color: string }> = {
  sim: { label: '模拟', desc: '演示模拟 · 虚拟资金 · 行情可能为合成降级', color: '#97A0B5' },
  paper: { label: '纸交易', desc: '纸交易 · 虚拟资金 · 真实行情撮合', color: '#FFB020' },
  live: { label: '实盘', desc: '链上实盘 · 真实钱包签名 · 真实资金风险', color: '#FF4D6D' },
}

export interface RiskSettings {
  maxAllocPct: number
  maxDrawdownPct: number
  leverage: number
}

const DEFAULT_RISK: RiskSettings = { maxAllocPct: 30, maxDrawdownPct: 12, leverage: 3 }

const PREFS_KEY = 'evolve.prefs.v1'

interface Prefs {
  mode?: TradeMode
  risk?: RiskSettings
  orchUrl?: string
  orchToken?: string
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? (JSON.parse(raw) as Prefs) : {}
  } catch {
    return {}
  }
}

const prefs = loadPrefs()

export interface Order {
  id: string
  pair: string
  side: 'buy' | 'sell'
  type: 'limit' | 'market'
  tag?: 'tp' | 'sl'
  price: number
  qty: number
  filledQty: number
  status: 'open' | 'filled' | 'partial' | 'cancelled'
  timestamp: number
}

export interface Position {
  pair: string
  side: 'long' | 'short'
  qty: number
  avgPrice: number
  pnl: number
}

export interface Agent {
  id: string
  name: string
  strategy: string
  status: 'running' | 'paused' | 'standby'
  todayPnl: number
  sharpe: number
  tradesToday: number
  winRate: number
  llmCalls: number
  allocation: number
}

export interface Trade {
  id: string
  pair: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  timestamp: number
}

export interface Pair {
  id: string
  symbol: string
  price: number
  change24h: number
  volume24h: number
  high24h: number
  low24h: number
}

export interface EvoLogEntry {
  gen: number
  fitness: number
  mutation: number
  timestamp: number
}

interface State {
  page: PageId
  balanceUSDC: number
  balanceETH: number
  balanceBTC: number
  orders: Order[]
  positions: Position[]
  trades: Trade[]
  agents: Agent[]
  pairs: Pair[]
  selectedPair: string
  selectedAgent: string
  gen: number
  population: number
  winRate: number
  bestFitness: number
  evolveLog: EvoLogEntry[]
  protocolTab: 'x402' | 'erc8004' | 'mcp'
  proposalYes: number
  proposalNo: number
  proposalVoted: boolean
  uptimeSec: number
  toast: string | null
  live: boolean
  mode: TradeMode
  risk: RiskSettings
  orchUrl: string
  orchToken: string
  klines: Record<string, Candle[]>
}

type Action =
  | { type: 'SET_PAGE'; page: PageId }
  | { type: 'TICK' }
  | { type: 'MARKET_SNAPSHOT'; updates: TickerUpdate[] }
  | { type: 'MARKET_TICK'; update: TickerUpdate }
  | { type: 'SET_LIVE'; live: boolean }
  | { type: 'SET_KLINES'; symbol: string; interval: string; candles: Candle[] }
  | { type: 'PLACE_ORDER'; order: Order }
  | { type: 'CANCEL_ORDER'; id: string }
  | { type: 'FILL_ORDER'; id: string; filledQty: number; fillPrice?: number; fee?: number }
  | { type: 'SET_PAIR'; pair: string }
  | { type: 'TOGGLE_AGENT'; id: string }
  | { type: 'SELECT_AGENT'; id: string }
  | { type: 'EVOLVE_COMPUTED'; entry: EvoLogEntry; winRatePct: number; candidates: number }
  | { type: 'SET_PROTOCOL_TAB'; tab: 'x402' | 'erc8004' | 'mcp' }
  | { type: 'VOTE'; vote: 'yes' | 'no' }
  | { type: 'SET_TOAST'; msg: string | null }
  | { type: 'SET_MODE'; mode: TradeMode }
  | { type: 'SET_RISK'; risk: RiskSettings }
  | { type: 'SET_ORCH_CONFIG'; orchUrl: string; orchToken: string }
  | { type: 'RESET_SIM' }

const initialAgents: Agent[] = [
  { id: 'a1', name: '0x8dxd·Alpha', strategy: 'ETH-USDC 做市', status: 'running', todayPnl: 18420, sharpe: 3.2, tradesToday: 3124, winRate: 74.2, llmCalls: 18420, allocation: 22 },
  { id: 'a2', name: 'HVOL-ARB-07', strategy: '波动率套利', status: 'running', todayPnl: 9760, sharpe: 2.8, tradesToday: 2408, winRate: 71.8, llmCalls: 12640, allocation: 18 },
  { id: 'a3', name: 'GRID-BTC-03', strategy: '网格交易', status: 'standby', todayPnl: 0, sharpe: 1.9, tradesToday: 0, winRate: 68.4, llmCalls: 320, allocation: 10 },
  { id: 'a4', name: 'MOM-SOL-11', strategy: '动量策略', status: 'running', todayPnl: 6300, sharpe: 2.4, tradesToday: 1582, winRate: 69.9, llmCalls: 8640, allocation: 15 },
  { id: 'a5', name: 'STAT-ARB-05', strategy: '统计套利', status: 'paused', todayPnl: 2100, sharpe: 2.1, tradesToday: 486, winRate: 66.1, llmCalls: 2120, allocation: 12 },
  { id: 'a6', name: 'LIQ-ETH-02', strategy: '流动性挖矿', status: 'running', todayPnl: 5400, sharpe: 2.6, tradesToday: 1896, winRate: 72.6, llmCalls: 9180, allocation: 14 },
]

const initialPairs: Pair[] = [
  { id: 'p1', symbol: 'ETH-USDC', price: 3724.5, change24h: 2.4, volume24h: 182.4, high24h: 3788.2, low24h: 3612.9 },
  { id: 'p2', symbol: 'BTC-USDC', price: 114320, change24h: 1.1, volume24h: 96.8, high24h: 115890, low24h: 112140 },
  { id: 'p3', symbol: 'SOL-USDC', price: 186.24, change24h: 4.6, volume24h: 54.2, high24h: 191.5, low24h: 177.3 },
  { id: 'p4', symbol: 'ARB-USDC', price: 1.2432, change24h: -1.8, volume24h: 22.6, high24h: 1.28, low24h: 1.21 },
  { id: 'p5', symbol: 'OP-USDC', price: 2.8614, change24h: -0.6, volume24h: 12.4, high24h: 2.92, low24h: 2.78 },
]

const initialState: State = {
  page: 'overview',
  balanceUSDC: 12847392,
  balanceETH: 245.8,
  balanceBTC: 12.4,
  orders: [],
  positions: [],
  trades: [],
  agents: initialAgents,
  pairs: initialPairs,
  selectedPair: 'ETH-USDC',
  selectedAgent: 'a1',
  gen: 42,
  population: 36,
  winRate: 71,
  bestFitness: 88.4,
  evolveLog: [
    { gen: 42, fitness: 88.4, mutation: 1.6, timestamp: Date.now() - 60000 },
    { gen: 41, fitness: 87.9, mutation: 1.8, timestamp: Date.now() - 360000 },
    { gen: 40, fitness: 86.7, mutation: 2.1, timestamp: Date.now() - 720000 },
  ],
  protocolTab: 'x402',
  proposalYes: 68,
  proposalNo: 22,
  proposalVoted: false,
  uptimeSec: 0,
  toast: null,
  live: false,
  // live 模式不允许跨会话静默恢复，每次启动需重新二次确认
  mode: prefs.mode === 'live' ? 'paper' : prefs.mode ?? 'sim',
  risk: prefs.risk ?? DEFAULT_RISK,
  // 兼容旧版默认端口 8787（devStack 实际跑在 8790），避免已持久化的错误地址导致 Failed to fetch
  orchUrl: prefs.orchUrl && prefs.orchUrl !== 'http://localhost:8787' ? prefs.orchUrl : 'http://localhost:8790',
  orchToken: prefs.orchToken ?? 'dev-insecure-token',
  klines: {},
}

function roundTo(n: number, d: number) {
  const m = Math.pow(10, d)
  return Math.round(n * m) / m
}

function applyFill(positions: Position[], order: Order, qty: number, price: number): Position[] {
  const idx = positions.findIndex((p) => p.pair === order.pair)
  const cost = qty * price
  if (order.side === 'buy') {
    if (idx < 0) return [...positions, { pair: order.pair, side: 'long', qty, avgPrice: price, pnl: 0 }]
    const p = positions[idx]
    if (p.side === 'long') {
      const newQty = p.qty + qty
      const avg = (p.avgPrice * p.qty + cost) / newQty
      return positions.map((x, i) => (i === idx ? { ...x, qty: newQty, avgPrice: avg } : x))
    }
    const newQty = p.qty - qty
    if (newQty <= 0) return positions.filter((_, i) => i !== idx)
    return positions.map((x, i) => (i === idx ? { ...x, qty: newQty } : x))
  }
  if (idx < 0) return [...positions, { pair: order.pair, side: 'short', qty, avgPrice: price, pnl: 0 }]
  const p = positions[idx]
  if (p.side === 'short') {
    const newQty = p.qty + qty
    const avg = (p.avgPrice * p.qty + cost) / newQty
    return positions.map((x, i) => (i === idx ? { ...x, qty: newQty, avgPrice: avg } : x))
  }
  const newQty = p.qty - qty
  if (newQty <= 0) return positions.filter((_, i) => i !== idx)
  return positions.map((x, i) => (i === idx ? { ...x, qty: newQty } : x))
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, page: action.page }

    case 'TICK': {
      // 真实行情在线时，模拟心跳仅维持运行时长，不覆盖真实价格
      if (state.live) return { ...state, uptimeSec: state.uptimeSec + 1 }
      const pairs = state.pairs.map((p) => {
        const drift = (Math.random() - 0.48) * p.price * 0.002
        const price = Math.max(p.price * 0.94, p.price + drift)
        const decimals = p.symbol === 'ARB-USDC' || p.symbol === 'OP-USDC' ? 4 : p.symbol === 'SOL-USDC' ? 2 : p.symbol === 'ETH-USDC' ? 1 : 0
        return { ...p, price: roundTo(price, decimals) }
      })
      return { ...state, pairs, uptimeSec: state.uptimeSec + 1 }
    }

    case 'MARKET_SNAPSHOT': {
      const pairs = state.pairs.map((p) => {
        const u = action.updates.find((x) => x.symbol === p.symbol)
        return u ? { ...p, price: u.price, change24h: u.change24h, high24h: u.high24h, low24h: u.low24h, volume24h: u.volume24h } : p
      })
      return { ...state, pairs }
    }

    case 'MARKET_TICK': {
      const u = action.update
      const pairs = state.pairs.map((p) =>
        p.symbol === u.symbol
          ? { ...p, price: u.price, change24h: u.change24h, high24h: u.high24h, low24h: u.low24h, volume24h: u.volume24h }
          : p
      )
      return { ...state, pairs }
    }

    case 'SET_LIVE':
      return { ...state, live: action.live }

    case 'SET_KLINES':
      return { ...state, klines: { ...state.klines, [`${action.symbol}:${action.interval}`]: action.candles } }

    case 'PLACE_ORDER': {
      const o = action.order
      if (o.type === 'market') {
        let balanceUSDC = state.balanceUSDC
        if (o.side === 'buy') balanceUSDC -= o.qty * o.price * 1.0003
        else balanceUSDC += o.qty * o.price * 0.9997
        const trade: Trade = {
          id: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          pair: o.pair,
          side: o.side,
          price: o.price,
          qty: o.qty,
          timestamp: Date.now(),
        }
        const positions = applyFill(state.positions, o, o.qty, o.price)
        const filled: Order = { ...o, filledQty: o.qty, status: 'filled' }
        return { ...state, orders: [filled, ...state.orders], balanceUSDC, positions, trades: [trade, ...state.trades].slice(0, 50) }
      }
      // limit: lock funds for buys
      let balanceUSDC = state.balanceUSDC
      if (o.side === 'buy') balanceUSDC -= o.qty * o.price
      return { ...state, orders: [o, ...state.orders], balanceUSDC }
    }

    case 'CANCEL_ORDER': {
      const order = state.orders.find((x) => x.id === action.id)
      if (!order || order.status === 'cancelled' || order.status === 'filled') return state
      let balanceUSDC = state.balanceUSDC
      if (order.side === 'buy') balanceUSDC += (order.qty - order.filledQty) * order.price // refund locked
      return {
        ...state,
        orders: state.orders.map((x) => (x.id === action.id ? { ...x, status: 'cancelled' as const } : x)),
        balanceUSDC,
      }
    }

    case 'FILL_ORDER': {
      const order = state.orders.find((x) => x.id === action.id)
      if (!order || order.status === 'filled' || order.status === 'cancelled') return state
      const fillQty = Math.min(action.filledQty, order.qty - order.filledQty)
      if (fillQty <= 0) return state
      const fillPrice = action.fillPrice ?? order.price
      const fee = action.fee ?? 0
      let balanceUSDC = state.balanceUSDC
      if (order.side === 'buy') {
        // 释放该部分挂单时锁定的资金，按真实成交价+手续费结算
        balanceUSDC += fillQty * order.price - (fillQty * fillPrice + fee)
      } else {
        balanceUSDC += fillQty * fillPrice - fee
      }
      const positions = applyFill(state.positions, order, fillQty, fillPrice)
      const newFilled = order.filledQty + fillQty
      const status: Order['status'] = newFilled >= order.qty ? 'filled' : 'partial'
      const trade: Trade = {
        id: 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        pair: order.pair,
        side: order.side,
        price: fillPrice,
        qty: fillQty,
        timestamp: Date.now(),
      }
      return {
        ...state,
        orders: state.orders.map((x) => (x.id === action.id ? { ...x, filledQty: newFilled, status } : x)),
        balanceUSDC,
        positions,
        trades: [trade, ...state.trades].slice(0, 50),
      }
    }

    case 'SET_PAIR':
      return { ...state, selectedPair: action.pair }

    case 'TOGGLE_AGENT': {
      const updated = state.agents.map((a) =>
        a.id === action.id ? { ...a, status: a.status === 'running' ? ('paused' as const) : ('running' as const) } : a
      )
      return { ...state, agents: updated }
    }

    case 'SELECT_AGENT':
      return { ...state, selectedAgent: action.id }

    case 'EVOLVE_COMPUTED': {
      const entry = action.entry
      return {
        ...state,
        gen: entry.gen,
        population: state.population + Math.max(0, action.candidates),
        winRate: Math.max(0, Math.min(100, Math.round(action.winRatePct))),
        bestFitness: Math.max(state.bestFitness, entry.fitness),
        evolveLog: [entry, ...state.evolveLog].slice(0, 10),
      }
    }

    case 'SET_PROTOCOL_TAB':
      return { ...state, protocolTab: action.tab }

    case 'VOTE': {
      if (state.proposalVoted) return state
      if (action.vote === 'yes') return { ...state, proposalYes: state.proposalYes + 1, proposalVoted: true }
      return { ...state, proposalNo: state.proposalNo + 1, proposalVoted: true }
    }

    case 'SET_TOAST':
      return { ...state, toast: action.msg }

    case 'SET_MODE': {
      if (action.mode === state.mode) return state
      return { ...state, mode: action.mode, toast: `模式已切换 → ${MODE_META[action.mode].label} · ${MODE_META[action.mode].desc}` }
    }

    case 'SET_RISK':
      return { ...state, risk: action.risk }

    case 'SET_ORCH_CONFIG':
      return { ...state, orchUrl: action.orchUrl.replace(/\/+$/, ''), orchToken: action.orchToken, toast: '🔌 Orchestration 连接配置已保存' }

    case 'RESET_SIM':
      return {
        ...state,
        balanceUSDC: initialState.balanceUSDC,
        balanceETH: initialState.balanceETH,
        balanceBTC: initialState.balanceBTC,
        orders: [],
        positions: [],
        trades: [],
        gen: initialState.gen,
        population: initialState.population,
        winRate: initialState.winRate,
        bestFitness: initialState.bestFitness,
        evolveLog: [],
        toast: '🔄 模拟账户与进化记录已重置',
      }

    default:
      return state
  }
}

const StoreContext = createContext<{ state: State; dispatch: React.Dispatch<Action> } | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  useEffect(() => {
    try {
      const next: Prefs = { mode: state.mode === 'live' ? 'paper' : state.mode, risk: state.risk, orchUrl: state.orchUrl, orchToken: state.orchToken }
      localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    } catch {
      /* 存储不可用时静默降级 */
    }
  }, [state.mode, state.risk, state.orchUrl, state.orchToken])
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be inside StoreProvider')
  return ctx
}

export function usePage() {
  const { state, dispatch } = useStore()
  const setPage = useCallback((page: PageId) => dispatch({ type: 'SET_PAGE', page }), [dispatch])
  return { page: state.page, setPage }
}

export function pushToast(dispatch: React.Dispatch<Action>, msg: string) {
  dispatch({ type: 'SET_TOAST', msg })
}
