import React, { useEffect, useMemo, useState } from 'react'
import { useStore, pushToast, Order, MODE_META } from '../store/Store'
import { recordPrice, takeClosedBars, paperBroker, submitPaperLimit, cancelPaperOrder, collectPaperFillEvents } from '../trading/paperEngine'
import { fetchKlines, Candle } from '../data/market'
import KpiRow, { KpiItem } from '../components/KpiRow'
import DexSwapPanel from '../components/DexSwapPanel'

// 模拟降级：真实 K 线不可用时的合成数据
function genCandles(price: number, count = 46): Candle[] {
  const base: Candle[] = []
  let prev = price * 0.96
  for (let i = 0; i < count; i++) {
    const seed = (i * 9301 + 49297) % 233280
    const noise = (seed / 233280 - 0.5) * price * 0.005
    const wave = Math.sin(i / 4.2) * price * 0.0022
    const c = Math.max(price * 0.9, prev + noise + wave)
    const o = prev
    const h = Math.max(o, c) + ((seed % 100) / 100) * price * 0.0012
    const l = Math.min(o, c) - (((seed * 7) % 100) / 100) * price * 0.0012
    base.push({ t: Date.now() - (count - i) * 60000, o, h, l, c, v: (seed % 100) / 10 + 2 })
    prev = c
  }
  const k = price / base[base.length - 1].c
  return base.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }))
}

const VIEW_W = 560
const VIEW_H = 330
const PAD = { top: 12, bottom: 24, left: 52, right: 10 }
const PLOT_W = VIEW_W - PAD.left - PAD.right
const PLOT_H = VIEW_H - PAD.top - PAD.bottom - 40

function fmtP(p: number) {
  return p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 10 ? p.toFixed(2) : p.toFixed(4)
}

function CandleChart({ candles, symbol, interval, change, price }: { candles: Candle[]; symbol: string; interval: string; change: number; price: number }) {
  const maxP = Math.max(...candles.map((c) => c.h)) * 1.002
  const minP = Math.min(...candles.map((c) => c.l)) * 0.998
  const range = maxP - minP || 1
  const y = (p: number) => PAD.top + (1 - (p - minP) / range) * PLOT_H
  const x = (i: number) => PAD.left + (i / candles.length) * PLOT_W + PLOT_W / candles.length / 2
  const cw = (PLOT_W / candles.length) * 0.62
  const maxVol = Math.max(...candles.map((c) => c.v), 0.001)
  const ma20 = useMemo(() => {
    const pts: { x: number; y: number }[] = []
    for (let i = 19; i < candles.length; i++) {
      const avg = candles.slice(i - 19, i + 1).reduce((s, c) => s + c.c, 0) / 20
      pts.push({ x: x(i), y: y(avg) })
    }
    return pts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles])

  const gridY = [0.25, 0.5, 0.75].map((r) => PAD.top + r * PLOT_H)
  const up = change >= 0

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="chart-svg">
      {gridY.map((gy, i) => {
        const p = maxP - (range * (i + 1)) / 4
        return (
          <g key={i}>
            <line x1={PAD.left} y1={gy} x2={VIEW_W - PAD.right} y2={gy} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 6} y={gy + 3} textAnchor="end" fontSize="9" fontFamily="var(--font-mono)" fill="var(--text-weak)">{fmtP(p)}</text>
          </g>
        )
      })}
      {candles.map((c, i) => {
        const isUp = c.c >= c.o
        const color = isUp ? 'var(--up)' : 'var(--down)'
        const vy = y(c.h)
        const vh = y(c.l) - y(c.h)
        const cy = y(Math.max(c.o, c.c))
        const ch = Math.max(1.5, Math.abs(y(c.o) - y(c.c)))
        return (
          <g key={i}>
            <line x1={x(i)} y1={vy} x2={x(i)} y2={vy + vh} stroke={color} strokeWidth="1" />
            <rect x={x(i) - cw / 2} y={cy} width={cw} height={ch} fill={color} rx="1" />
            <rect x={x(i) - cw / 2} y={VIEW_H - PAD.bottom - 22 + (1 - c.v / maxVol) * 20} width={cw} height={(c.v / maxVol) * 20} fill={color} opacity="0.35" rx="1" />
          </g>
        )
      })}
      <polyline
        points={ma20.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--warning)"
        strokeWidth="1.4"
        strokeDasharray="3 3"
        opacity="0.9"
      />
      <text x={VIEW_W - PAD.right} y={PAD.top + 4} textAnchor="end" fontSize="10" fontFamily="var(--font-mono)" fill="var(--warning)">MA20</text>
      <line x1={PAD.left} y1={VIEW_H - PAD.bottom - 22} x2={VIEW_W - PAD.right} y2={VIEW_H - PAD.bottom - 22} stroke="var(--border)" strokeWidth="1" />
      <text x={PAD.left + 2} y={VIEW_H - 8} fontSize="9" fontFamily="var(--font-mono)" fill="var(--text-weak)">成交量</text>
      {/* 当前价标签 */}
      <g>
        <line x1={PAD.left} y1={y(price)} x2={VIEW_W - PAD.right} y2={y(price)} stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <rect x={VIEW_W - PAD.right - 74} y={y(price) - 9} width="72" height="16" rx="4" fill={up ? 'rgba(255,77,109,0.16)' : 'rgba(0,214,143,0.16)'} stroke={up ? 'rgba(255,77,109,0.4)' : 'rgba(0,214,143,0.4)'} />
        <text x={VIEW_W - PAD.right - 38} y={y(price) + 3} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fontWeight="700" fill={up ? 'var(--up)' : 'var(--down)'}>{fmtP(price)}</text>
      </g>
      <text x={PAD.left + 2} y={PAD.top + 4} fontSize="10" fontFamily="var(--font-mono)" fill="var(--text-weak)">{symbol} · {interval} K线 · Binance</text>
    </svg>
  )
}

type Tab = 'orders' | 'positions' | 'trades'

export default function TerminalPage() {
  const { state, dispatch } = useStore()
  const [tab, setTab] = useState<Tab>('orders')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'limit' | 'market' | 'tpsl' | 'dex'>('limit')
  const [price, setPrice] = useState('')
  const [qty, setQty] = useState('')
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  const [err, setErr] = useState('')

  const pair = state.pairs.find((p) => p.symbol === state.selectedPair)!
  const decimals = pair.symbol === 'ARB-USDC' || pair.symbol === 'OP-USDC' ? 4 : pair.symbol === 'SOL-USDC' ? 2 : pair.symbol === 'ETH-USDC' ? 1 : 0
  const [tf, setTf] = useState('1m')

  useEffect(() => {
    setPrice(pair.price.toFixed(decimals))
    setTp((pair.price * 1.03).toFixed(decimals))
    setSl((pair.price * 0.97).toFixed(decimals))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.symbol])

  // 真实 K 线：按交易对+周期拉取，每 30s 刷新一次
  useEffect(() => {
    let mounted = true
    const load = () =>
      fetchKlines(pair.symbol, tf, 60)
        .then((candles) => {
          if (mounted) dispatch({ type: 'SET_KLINES', symbol: pair.symbol, interval: tf, candles })
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => {
      mounted = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.symbol, tf])

  // 实时价并入最后一根 K 线
  const candles = useMemo(() => {
    const key = `${pair.symbol}:${tf}`
    const real = state.klines[key]
    const base = real && real.length > 0 ? real : genCandles(pair.price)
    if (base.length === 0) return base
    const last = base[base.length - 1]
    const merged = { ...last, c: pair.price, h: Math.max(last.h, pair.price), l: Math.min(last.l, pair.price) }
    return [...base.slice(0, -1), merged]
  }, [state.klines, pair.symbol, pair.price, tf])

  // 纸面撮合：行情累积成 1 分钟合成 K 线 → PaperBroker（engine 撮合语义）→ 回填 reducer
  useEffect(() => {
    const t = setInterval(() => {
      state.pairs.forEach((p) => recordPrice(p.symbol, p.price))
      for (const { symbol, candle } of takeClosedBars()) {
        paperBroker.onBar(symbol, candle)
      }
      for (const ev of collectPaperFillEvents()) {
        dispatch({ type: 'FILL_ORDER', id: ev.clientOrderId, filledQty: ev.fillQty, fillPrice: ev.fillPrice, fee: ev.fee })
        pushToast(dispatch, `⚡ 委托 ${ev.clientOrderId.slice(-4)} 成交 ${ev.fillQty} @ ${ev.fillPrice.toFixed(2)} · 费 ${ev.fee.toFixed(4)}`)
      }
    }, 2500)
    return () => clearInterval(t)
  }, [state.pairs, dispatch])

  const maxBuyQty = state.balanceUSDC / pair.price
  const maxSellQty = state.positions.filter((p) => p.pair === pair.symbol && p.side === 'long').reduce((s, p) => s + p.qty, 0) || 10

  const setPct = (pct: number) => {
    const maxQ = side === 'buy' ? maxBuyQty : maxSellQty
    setQty((maxQ * pct).toFixed(4))
  }

  const mkId = (prefix: string) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  const submit = () => {
    const priceNum = parseFloat(price)
    const qtyNum = parseFloat(qty)
    if (!priceNum || priceNum <= 0) { setErr('请输入有效价格'); return }
    if (!qtyNum || qtyNum <= 0) { setErr('请输入有效数量'); return }
    setErr('')
    if (orderType === 'market') {
      const ord: Order = { id: mkId('M'), pair: pair.symbol, side, type: 'market', price: pair.price, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
      dispatch({ type: 'PLACE_ORDER', order: ord })
      pushToast(dispatch, `✅ 市价${side === 'buy' ? '买入' : '卖出'}成交 ${qtyNum} ${pair.symbol} @ ${pair.price}`)
      return
    }
    if (orderType === 'limit') {
      const ord: Order = { id: mkId('L'), pair: pair.symbol, side, type: 'limit', price: priceNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
      submitPaperLimit(ord)
      dispatch({ type: 'PLACE_ORDER', order: ord })
      pushToast(dispatch, `📌 限价${side === 'buy' ? '买入' : '卖出'}已挂单并进入纸面撮合 · ${qtyNum} @ ${priceNum}`)
      return
    }
    const tpNum = parseFloat(tp)
    const slNum = parseFloat(sl)
    if (!tpNum || !slNum) { setErr('请输入止盈/止损价'); return }
    const exitSide = side === 'buy' ? 'sell' : 'buy'
    const entry: Order = { id: mkId('E'), pair: pair.symbol, side, type: 'market', price: pair.price, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    const tpOrder: Order = { id: mkId('T'), pair: pair.symbol, side: exitSide, type: 'limit', tag: 'tp', price: tpNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    const slOrder: Order = { id: mkId('S'), pair: pair.symbol, side: exitSide, type: 'limit', tag: 'sl', price: slNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    submitPaperLimit(tpOrder)
    submitPaperLimit(slOrder)
    dispatch({ type: 'PLACE_ORDER', order: entry })
    dispatch({ type: 'PLACE_ORDER', order: tpOrder })
    dispatch({ type: 'PLACE_ORDER', order: slOrder })
    pushToast(dispatch, `🎯 已开仓并挂止盈 ${tpNum} / 止损 ${slNum}（进入纸面撮合）`)
  }

  const closePosition = (sym: string, q: number, posSide: 'long' | 'short') => {
    const posPair = state.pairs.find((x) => x.symbol === sym)
    const fillPrice = posPair ? posPair.price : 0
    if (!fillPrice) return
    dispatch({
      type: 'PLACE_ORDER',
      order: { id: mkId('C'), pair: sym, side: posSide === 'long' ? 'sell' : 'buy', type: 'market', price: fillPrice, qty: q, filledQty: 0, status: 'open', timestamp: Date.now() },
    })
    pushToast(dispatch, `🔒 已市价平仓 ${q} ${sym} @ ${fillPrice}`)
  }

  const activeOrders = state.orders.filter((o) => o.status === 'open' || o.status === 'partial')
  const allOrders = state.orders.slice(0, 20)
  const filledCount = state.orders.filter((o) => o.status === 'filled').length
  const modeLabel = state.mode === 'sim' ? '模拟演示' : state.mode === 'paper' ? '纸交易' : '链上实盘'

  const kpis: KpiItem[] = [
    { label: '当前模式', value: modeLabel, valueColor: state.mode === 'live' ? 'var(--up)' : 'var(--text-main)', meta: MODE_META[state.mode].desc, metaColor: 'var(--warning)' },
    { label: '行情源', value: state.live ? 'Binance 实时' : '合成降级', valueColor: state.live ? 'var(--primary)' : 'var(--warning)', meta: state.live ? '公开 REST + WS' : '随机游走 · 非真实价格', metaColor: 'var(--text-sub)' },
    { label: '当前挂单', value: String(activeOrders.length), valueColor: 'var(--accent)', meta: '模拟账户内有效', metaColor: 'var(--text-sub)' },
    { label: '会话成交', value: String(filledCount), valueColor: 'var(--text-main)', meta: `委托累计 ${state.orders.length} 笔`, metaColor: 'var(--text-sub)' },
    { label: '持仓数', value: String(state.positions.length), valueColor: 'var(--text-main)', meta: '虚拟资金 · 刷新即清空', metaColor: 'var(--warning)' },
  ]

  return (
    <div className="content-area">
      <KpiRow items={kpis} height={96} />

      <div className="main-area terminal-main">
        {/* 交易对列表 */}
        <div className="pair-list">
          <div className="panel-head">
            <span className="panel-title">市场</span>
            <span className={`chip ${state.live ? 'chip-green' : 'chip-amber'}`}>
              <span className={`pulse-dot2 ${state.live ? 'live' : ''}`} style={{ color: state.live ? 'var(--down)' : 'var(--warning)', background: state.live ? 'var(--down)' : 'var(--warning)', width: 5, height: 5 }} />
              {state.live ? 'Binance 实时' : '模拟行情'}
            </span>
          </div>
          {state.pairs.map((p) => {
            const up = p.change24h >= 0
            return (
              <div key={p.id} className={`pair-row ${p.symbol === state.selectedPair ? 'on' : ''}`} onClick={() => { dispatch({ type: 'SET_PAIR', pair: p.symbol }); pushToast(dispatch, `已切换交易对 ${p.symbol}`) }}>
                <div className="pr-top">
                  <span className="pr-sym">{p.symbol}</span>
                  <span className="pr-price" style={{ color: up ? 'var(--up)' : 'var(--down)' }}>{p.price >= 1000 ? p.price.toFixed(0) : p.price >= 10 ? p.price.toFixed(2) : p.price.toFixed(4)}</span>
                </div>
                <div className="pr-bot">
                  <span className={`chip ${up ? 'chip-red' : 'chip-green'}`}>{up ? '+' : ''}{p.change24h.toFixed(2)}%</span>
                  <span className="pr-vol">24h ${p.volume24h >= 1000 ? (p.volume24h / 1000).toFixed(1) + 'B' : p.volume24h.toFixed(1) + 'M'}</span>
                </div>
              </div>
            )
          })}
          <style>{`
            .pair-list {
              width: 200px; flex-shrink: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 10px;
              display: flex; flex-direction: column; gap: 6px;
              overflow-y: auto;
            }
            .panel-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 4px; }
            .panel-title { font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--text-main); }
            .pair-row {
              padding: 8px 10px; border-radius: 8px;
              border: 1px solid transparent;
              cursor: pointer; transition: all 0.15s;
              display: flex; flex-direction: column; gap: 5px;
            }
            .pair-row:hover { background: rgba(255,255,255,0.03); }
            .pair-row.on { background: var(--primary-10); border-color: var(--primary-40); }
            .pr-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
            .pr-sym { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-main); }
            .pr-price { font-family: var(--font-mono); font-size: 12px; font-weight: 700; }
            .pr-bot { display: flex; align-items: center; justify-content: space-between; }
            .pr-vol { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
          `}</style>
        </div>

        {/* K 线 */}
        <div className="chart-card">
          <div className="chart-card-head">
            <span className="panel-title">{pair.symbol} 行情</span>
            <span className="seg">
              {(['1m', '5m', '15m', '1h'] as const).map((iv) => (
                <button key={iv} className={tf === iv ? 'on' : ''} onClick={() => setTf(iv)}>{iv}</button>
              ))}
            </span>
          </div>
          <CandleChart candles={candles} symbol={pair.symbol} interval={tf} change={pair.change24h} price={pair.price} />
          <style>{`
            .chart-card {
              flex: 1; min-width: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 10px 12px;
              display: flex; flex-direction: column;
            }
            .chart-card-head { display: flex; align-items: center; justify-content: space-between; height: 30px; flex-shrink: 0; }
            .chart-card .chart-svg { flex: 1; width: 100%; min-height: 0; }
          `}</style>
        </div>

        {/* 下单面板 */}
        <div className="order-panel">
          <div className="seg wide">
            <button className={`${side === 'buy' ? 'on-buy' : ''}`} onClick={() => { setSide('buy'); setErr('') }}>买入</button>
            <button className={`${side === 'sell' ? 'on-sell' : ''}`} onClick={() => { setSide('sell'); setErr('') }}>卖出</button>
          </div>

          <div className="seg wide">
            {(['limit', 'market', 'tpsl', 'dex'] as const).map((t) => (
              <button key={t} className={orderType === t ? 'on' : ''} onClick={() => setOrderType(t)}>
                {t === 'limit' ? '限价' : t === 'market' ? '市价' : t === 'tpsl' ? '止盈止损' : state.mode === 'live' ? 'DEX 链上' : 'DEX 链上🔒'}
              </button>
            ))}
          </div>

          {orderType === 'dex' ? (
            <DexSwapPanel symbol={pair.symbol} side={side} qty={qty} refPrice={pair.price} />
          ) : (
            <>
              <div className="op-field">
                <span className="op-label">价格 (USDC)</span>
                <div className="op-input-wrap">
                  <input className="input" value={price} onChange={(e) => setPrice(e.target.value)} />
                  <span className="op-suffix" style={{ cursor: 'pointer' }} onClick={() => setPrice(pair.price.toFixed(decimals))}>市场价</span>
                </div>
              </div>

              {orderType === 'tpsl' && (
                <>
                  <div className="op-field">
                    <span className="op-label">止盈价</span>
                    <div className="op-input-wrap"><input className="input" value={tp} onChange={(e) => setTp(e.target.value)} /></div>
                  </div>
                  <div className="op-field">
                    <span className="op-label">止损价</span>
                    <div className="op-input-wrap"><input className="input" value={sl} onChange={(e) => setSl(e.target.value)} /></div>
                  </div>
                </>
              )}

              <div className="op-field">
                <span className="op-label">数量 ({pair.symbol.split('-')[0]})</span>
                <div className="op-input-wrap">
                  <input className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
                  <span className="op-suffix">可用 {side === 'buy' ? (state.balanceUSDC / 1e6).toFixed(2) + 'M' : maxSellQty.toFixed(2)}</span>
                </div>
              </div>

              <div className="op-pcts">
                {[0.25, 0.5, 0.75, 1].map((pct) => (
                  <button key={pct} className="pct-btn" onClick={() => setPct(pct)}>{pct * 100}%</button>
                ))}
              </div>

              {err && <div className="op-err">{err}</div>}

              <div className="op-est">
                <span>预估保证金</span>
                <span className="op-est-val">${(parseFloat(qty || '0') * (orderType === 'market' ? pair.price : parseFloat(price || '0'))).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>
              </div>

              <button className={`btn btn-lg ${side === 'buy' ? 'btn-buy' : 'btn-sell'} full`} onClick={submit}>
                {side === 'buy' ? '买入' : '卖出'} {pair.symbol.split('-')[0]}
                {orderType === 'limit' ? ' · 挂单' : orderType === 'tpsl' ? ' · 带止损开仓' : ' · 市价'}
              </button>

              <div className="op-bal">
                <span>可用余额（模拟账户）</span>
                <span>${state.balanceUSDC.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
              </div>
            </>
          )}

          <style>{`
            .order-panel {
              width: 330px; flex-shrink: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px;
              display: flex; flex-direction: column; gap: 9px;
              overflow-y: auto;
            }
            .seg.wide { width: 100%; }
            .seg.wide button { flex: 1; }
            .op-field { display: flex; flex-direction: column; gap: 4px; }
            .op-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
            .op-input-wrap { position: relative; }
            .op-input-wrap .input { padding-right: 62px; }
            .op-suffix {
              position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
              font-family: var(--font-mono); font-size: 9px; color: var(--primary);
            }
            .op-pcts { display: flex; gap: 6px; }
            .pct-btn {
              flex: 1; height: 24px;
              background: var(--bg-surface); border: 1px solid var(--border);
              border-radius: 6px; color: var(--text-sub);
              font-family: var(--font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s;
            }
            .pct-btn:hover { border-color: var(--primary-40); color: var(--primary); }
            .op-err { font-size: 11px; color: var(--up); }
            .op-est {
              display: flex; align-items: center; justify-content: space-between;
              font-family: var(--font-ui); font-size: 11px; color: var(--text-sub);
              padding: 6px 0; border-top: 1px dashed var(--border);
            }
            .op-est-val { font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
            .btn.full { width: 100%; }
            .op-bal {
              display: flex; align-items: center; justify-content: space-between;
              font-family: var(--font-ui); font-size: 11px; color: var(--text-weak);
            }
            .op-bal span:last-child { font-family: var(--font-mono); color: var(--text-sub); }
          `}</style>
        </div>
      </div>

      {/* 底部：委托 / 持仓 / 成交 */}
      <div className="orders-card">
        <div className="tabs">
          <div className={`tab-item ${tab === 'orders' ? 'on' : ''}`} onClick={() => setTab('orders')}>当前委托 <span className="t-count">{activeOrders.length}</span></div>
          <div className={`tab-item ${tab === 'positions' ? 'on' : ''}`} onClick={() => setTab('positions')}>持仓 <span className="t-count">{state.positions.length}</span></div>
          <div className={`tab-item ${tab === 'trades' ? 'on' : ''}`} onClick={() => setTab('trades')}>成交记录</div>
        </div>

        <div className="orders-body">
          {tab === 'orders' && (
            <table className="tbl">
              <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>类型</th><th className="num">价格</th><th className="num">数量</th><th className="num">已成交</th><th>状态</th><th></th></tr></thead>
              <tbody>
                {allOrders.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无委托 · 在下单面板发起第一笔交易</td></tr>}
                {allOrders.map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                    <td className="strong">{o.pair}</td>
                    <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side === 'buy' ? '买入' : '卖出'}{o.tag === 'tp' ? ' ·TP' : o.tag === 'sl' ? ' ·SL' : ''}</td>
                    <td>{o.type === 'market' ? '市价' : '限价'}</td>
                    <td className="num">{o.price}</td>
                    <td className="num">{o.qty}</td>
                    <td className="num">{o.filledQty}</td>
                    <td>
                      {o.status === 'filled' ? <span className="chip chip-green">已成交</span>
                        : o.status === 'cancelled' ? <span className="chip chip-gray">已撤单</span>
                        : o.status === 'partial' ? <span className="chip chip-amber">部分成交</span>
                        : <span className="chip chip-cyan">挂单中</span>}
                    </td>
                    <td>
                      {(o.status === 'open' || o.status === 'partial') && (
                        <button className="btn btn-sm" onClick={() => { cancelPaperOrder(o.id); dispatch({ type: 'CANCEL_ORDER', id: o.id }); pushToast(dispatch, `🗑 已撤单 ${o.id.slice(-4)}`) }}>撤单</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'positions' && (
            <table className="tbl">
              <thead><tr><th>交易对</th><th>方向</th><th className="num">数量</th><th className="num">均价</th><th className="num">浮盈</th><th></th></tr></thead>
              <tbody>
                {state.positions.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无持仓</td></tr>}
                {state.positions.map((p, i) => (
                  <tr key={i}>
                    <td className="strong">{p.pair}</td>
                    <td className={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? '多仓' : '空仓'}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num">${p.avgPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                    <td className={`num ${p.pnl >= 0 ? 'up' : 'down'}`}>{p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString('en-US')}</td>
                    <td><button className={`btn btn-sm ${p.side === 'long' ? 'btn-sell' : 'btn-buy'}`} onClick={() => closePosition(p.pair, p.qty, p.side)}>平仓</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'trades' && (
            <table className="tbl">
              <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th className="num">价格</th><th className="num">数量</th><th className="num">金额</th></tr></thead>
              <tbody>
                {state.trades.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无成交</td></tr>}
                {state.trades.slice(0, 12).map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                    <td className="strong">{t.pair}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? '买入' : '卖出'}</td>
                    <td className="num">${t.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="num">{t.qty}</td>
                    <td className="num">${(t.price * t.qty).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <style>{`
          .orders-card {
            height: 210px; flex-shrink: 0;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; padding: 0 12px;
            display: flex; flex-direction: column;
          }
          .t-count {
            font-family: var(--font-mono); font-size: 10px;
            background: var(--bg-elevated); border-radius: 8px; padding: 1px 6px;
            color: var(--text-sub);
          }
          .orders-body { flex: 1; overflow-y: auto; min-height: 0; }
        `}</style>
      </div>
    </div>
  )
}
