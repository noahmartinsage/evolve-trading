import React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useStore, usePage, PageId, pushToast } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import EquityChart from '../components/EquityChart'
import ProtocolStatus from '../components/ProtocolStatus'
import EventStream, { StreamEvent } from '../components/EventStream'
import { DemoBanner } from '../components/DemoBadge'
import { getAutopilotStatus, autopilotStart, autopilotStop } from '../orch/client.ts'
import type { AutopilotStatusView } from '../orch/client.ts'

const STAGE_LABEL: Record<string, string> = {
  idle: '待命',
  accumulating: '积累行情数据',
  optimizing: '因子挖掘中',
  trading: '自主交易中',
  target_reached: '🎯 目标已达成',
  drawdown_stopped: '回撤保护停机',
}

const quickActions: { id: PageId; label: string; desc: string; color: string }[] = [
  { id: 'terminal', label: '进入交易终端', desc: '下单 · 持仓 · 成交（模拟）', color: 'var(--primary)' },
  { id: 'agents', label: 'Agent 舰队（演示）', desc: '概念稿 · 非真实策略', color: 'var(--accent)' },
  { id: 'evo', label: '进化实验室（演示）', desc: '随机数占位 · 待回测内核', color: 'var(--warning)' },
  { id: 'protocol', label: '协议栈（概念稿）', desc: 'x402 · ERC-8004 · MCP', color: 'var(--down)' },
]

export default function OverviewPage() {
  const { state, dispatch } = useStore()
  const { setPage } = usePage()

  // C-12/Autopilot 状态轮询（真实服务端数据）
  const [ap, setAp] = useState<AutopilotStatusView | null>(null)
  const [apTarget, setApTarget] = useState('2')
  useEffect(() => {
    let alive = true
    const load = () => {
      void getAutopilotStatus(state.orchUrl, state.orchToken).then((v) => { if (alive) setAp(v) }).catch(() => undefined)
    }
    load()
    const t = setInterval(load, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [state.orchUrl, state.orchToken])

  const apStart = async () => {
    try {
      const r = await autopilotStart(state.orchUrl, state.orchToken, Number(apTarget))
      pushToast(dispatch, r.ok ? `🤖 自治循环已启动 · 目标 +${apTarget}%（纸交易）` : `❌ ${r.reason}`)
    } catch (e) {
      pushToast(dispatch, `❌ ${e instanceof Error ? e.message : e}`)
    }
  }
  const apStop = async () => {
    try {
      await autopilotStop(state.orchUrl, state.orchToken)
      pushToast(dispatch, '🛑 自治循环已停止')
    } catch (e) {
      pushToast(dispatch, `❌ ${e instanceof Error ? e.message : e}`)
    }
  }

  const ethPrice = state.pairs.find((p) => p.symbol === 'ETH-USDC')?.price ?? 0
  const btcPrice = state.pairs.find((p) => p.symbol === 'BTC-USDC')?.price ?? 0
  const equity = state.balanceUSDC + state.balanceETH * ethPrice + state.balanceBTC * btcPrice
  const filledOrders = state.orders.filter((o) => o.status === 'filled').length

  const kpis: KpiItem[] = [
    { label: '模拟账户净值', value: `$${(equity / 1e6).toFixed(2)}M`, valueColor: 'var(--text-main)', meta: 'DEMO 初始资金 · 与钱包无关', metaColor: 'var(--warning)' },
    { label: '会话成交', value: String(filledOrders), valueColor: 'var(--text-main)', meta: `本会话委托 ${state.orders.length} 笔`, metaColor: 'var(--text-sub)' },
    { label: '当前持仓', value: String(state.positions.length), valueColor: 'var(--text-main)', meta: '模拟账户 · 刷新即清空', metaColor: 'var(--text-sub)' },
    { label: '行情源', value: state.live ? 'Binance 实时' : '合成降级', valueColor: state.live ? 'var(--primary)' : 'var(--warning)', meta: state.live ? '公开 REST + WebSocket' : '网络不可用时的随机游走', metaColor: 'var(--text-sub)' },
    { label: '进化演示', value: `Gen-${state.gen}`, valueColor: 'var(--accent)', meta: 'DEMO 随机数 · 无回测内核支撑', metaColor: 'var(--warning)' },
  ]

  const events = useMemo<StreamEvent[]>(() => {
    const fromTrades: StreamEvent[] = state.trades.slice(0, 5).map((t) => ({
      time: new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
      agent: t.pair,
      agentColor: t.side === 'buy' ? 'var(--up)' : 'var(--down)',
      text: `模拟${t.side === 'buy' ? '买入' : '卖出'} ${t.qty} @ ${t.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`,
    }))
    const fromEvo: StreamEvent[] = state.evolveLog.slice(0, 2).map((e) => ({
      time: new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
      agent: 'EVOLVE·DEMO',
      agentColor: 'var(--accent)',
      text: `[演示] Gen-${e.gen} · 适应度 ${e.fitness}（随机数）`,
    }))
    return [...fromTrades, ...fromEvo]
  }, [state.trades, state.evolveLog])

  return (
    <div className="content-area">
      <DemoBanner text="总览页所有资金、进化与事件数字均为演示数据" />
      <KpiRow items={kpis} />

      <div className="autopilot-card">
        <div className="ap-head">
          <span className="ap-title">🤖 自治循环 · Autopilot（纸交易）</span>
          {ap && (
            <span className="chip" style={{ color: ap.running ? 'var(--primary)' : 'var(--text-weak)', borderColor: ap.running ? 'var(--primary)' : 'var(--border-strong)' }}>
              {STAGE_LABEL[ap.stage] ?? ap.stage}
            </span>
          )}
        </div>
        <div className="ap-body">
          <div className="ap-col">
            <div className="risk-row"><span>交易标的</span><span className="mono">{ap?.symbol ?? 'BTCUSDT'}</span></div>
            <div className="risk-row"><span>盈利目标</span>
              {ap?.running ? <span className="mono">+{ap.targetPct}%</span> : (
                <input className="input ap-target" value={apTarget} onChange={(e) => setApTarget(e.target.value)} />
              )}
            </div>
            <div className="risk-row"><span>PnL（纸交易）</span><span className="mono" style={{ color: (ap?.pnlPct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>{ap?.pnlPct !== null && ap?.pnlPct !== undefined ? `${ap.pnlPct >= 0 ? '+' : ''}${ap.pnlPct}%` : '—'}</span></div>
          </div>
          <div className="ap-col">
            <div className="risk-row"><span>挖掘/执行周期</span><span className="mono">{ap?.cycles ?? 0}</span></div>
            <div className="risk-row"><span>积累 bar 数</span><span className="mono">{ap?.barsAccumulated ?? 0}</span></div>
            <div className="risk-row"><span>胜出策略</span><span className="mono" style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ap?.winner ?? '—'}</span></div>
          </div>
          <div className="ap-actions">
            {ap?.running ? (
              <button className="btn btn-sell btn-lg full" data-ui="overview.autopilot.stop" onClick={apStop}>🛑 停止自治循环</button>
            ) : (
              <button className="btn btn-buy btn-lg full" data-ui="overview.autopilot.start" onClick={apStart}>▶️ 一键启动自治循环</button>
            )}
            <button className="btn full" data-ui="overview.factors.detail" onClick={() => setPage('evo')}>🧬 查看因子挖掘详情</button>
          </div>
        </div>
        <div className="ap-note">全自动闭环：因子挖掘（真实回测网格）→ 门禁评估 → 纸交易执行 → 盈利目标追踪 → 达标自动止盈 / -10% 回撤保护。仅纸交易面；实盘需晋升门禁+人工审批。</div>
        <style>{`
          .autopilot-card {
            background: linear-gradient(135deg, rgba(34,211,238,0.06), rgba(232,121,249,0.04));
            border: 1px solid var(--primary-40);
            border-radius: 12px; padding: 12px 16px;
            display: flex; flex-direction: column; gap: 9px;
            flex-shrink: 0;
          }
          .ap-head { display: flex; align-items: center; justify-content: space-between; }
          .ap-title { font-family: var(--font-ui); font-size: 14px; font-weight: 800; color: var(--text-main); }
          .ap-body { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px 24px; align-items: end; }
          .ap-col { display: flex; flex-direction: column; gap: 4px; }
          .ap-target { width: 64px; padding: 3px 8px; }
          .ap-actions { display: flex; flex-direction: column; gap: 6px; min-width: 190px; }
          .ap-note { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); border-top: 1px dashed var(--border); padding-top: 7px; line-height: 1.5; }
          .chip { font-family: var(--font-mono); font-size: 10px; font-weight: 700; padding: 2px 10px; border-radius: 8px; border: 1px solid var(--border); }
          .risk-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }
          .mono { font-family: var(--font-mono); }
          .btn.full { width: 100%; }
        `}</style>
      </div>

      <div className="quick-bar">
        {quickActions.map((a) => (
          <button key={a.id} className="quick-btn" onClick={() => { setPage(a.id); pushToast(dispatch, `已切换到「${a.label.replace(/进入|管理|启动|协议/, '')}」`) }}>
            <span className="qb-dot" style={{ background: a.color, boxShadow: `0 0 6px ${a.color}` }} />
            <span className="qb-label">{a.label}</span>
            <span className="qb-desc">{a.desc}</span>
            <span className="qb-arrow">→</span>
          </button>
        ))}
        <style>{`
          .quick-bar { display: flex; gap: 12px; flex-shrink: 0; }
          .quick-btn {
            flex: 1; display: flex; align-items: center; gap: 8px;
            height: 42px; padding: 0 14px;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; cursor: pointer; transition: all 0.15s;
            text-align: left;
          }
          .quick-btn:hover { border-color: var(--primary-40); transform: translateY(-1px); background: var(--bg-elevated); }
          .qb-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
          .qb-label { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); white-space: nowrap; }
          .qb-desc { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .qb-arrow { margin-left: auto; font-size: 14px; color: var(--text-weak); }
        `}</style>
      </div>

      <div className="main-area">
        <div className="equity-wrap">
          <EquityChart />
          <span className="equity-demo-wm">DEMO 演示数据 · 与真实盈亏无关</span>
        </div>
        <div className="right-col">
          <ProtocolStatus onOpen={() => setPage('protocol')} />
          <EventStream events={events} />
        </div>
        <style>{`
          .equity-wrap { position: relative; display: flex; flex-direction: column; min-width: 0; }
          .equity-demo-wm {
            position: absolute; top: 10px; right: 16px; z-index: 3; pointer-events: none;
            font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
            color: var(--warning); background: rgba(255,176,32,0.1);
            border: 1px solid rgba(255,176,32,0.4); border-radius: 10px; padding: 2px 9px;
          }
        `}</style>
      </div>
    </div>
  )
}
