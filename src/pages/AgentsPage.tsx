import React, { useState } from 'react'
import { useStore, usePage, pushToast, Agent } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { DemoBanner } from '../components/DemoBadge'

function statusChip(s: Agent['status']) {
  if (s === 'running') return <span className="chip chip-green">运行中</span>
  if (s === 'paused') return <span className="chip chip-amber">已暂停</span>
  return <span className="chip chip-gray">待命</span>
}

export default function AgentsPage() {
  const { state, dispatch } = useStore()
  const { setPage } = usePage()
  const [filter, setFilter] = useState<'all' | 'running' | 'paused' | 'standby'>('all')
  const [alloc, setAlloc] = useState<Record<string, number>>({})

  const selected = state.agents.find((a) => a.id === state.selectedAgent)!
  const running = state.agents.filter((a) => a.status === 'running')
  const totalPnl = state.agents.reduce((s, a) => s + a.todayPnl, 0)
  const avgWin = (state.agents.reduce((s, a) => s + a.winRate, 0) / state.agents.length).toFixed(1)

  const list = state.agents.filter((a) => filter === 'all' || a.status === filter)

  const toggle = (a: Agent) => {
    dispatch({ type: 'TOGGLE_AGENT', id: a.id })
    pushToast(dispatch, a.status === 'running' ? `⏸ ${a.name} 已暂停，仓位已冻结` : `▶️ ${a.name} 已启动，开始执行 ${a.strategy}`)
  }

  const execNow = (a: Agent) => {
    pushToast(dispatch, `🤖 ${a.name} 已收到策略执行指令 · 正在扫描 ${a.strategy} 机会`)
    setTimeout(() => pushToast(dispatch, `✅ ${a.name} 完成一轮策略执行`), 1800)
  }

  const kpis: KpiItem[] = [
    { label: 'Agent 总数', value: String(state.agents.length), valueColor: 'var(--text-main)', meta: '演示舰队 · 与下方列表一致', metaColor: 'var(--warning)' },
    { label: '运行中', value: String(running.length), valueColor: 'var(--down)', meta: '资金占用 ' + state.agents.reduce((s, a) => s + (a.status === 'running' ? a.allocation : 0), 0) + '%（虚拟）', metaColor: 'var(--warning)' },
    { label: '今日收益', value: `+$${totalPnl.toLocaleString('en-US')}`, valueColor: 'var(--up)', meta: 'DEMO 演示数字 · 非真实 PnL', metaColor: 'var(--warning)' },
    { label: '平均胜率', value: `${avgWin}%`, valueColor: 'var(--text-main)', meta: 'DEMO · 无真实成交来源', metaColor: 'var(--warning)' },
    { label: '执行引擎', value: '未接入', valueColor: 'var(--text-weak)', meta: 'Agent 执行面待阶段 B/C', metaColor: 'var(--text-sub)' },
  ]

  return (
    <div className="content-area">
      <DemoBanner text="Agent 舰队、绩效与决策均为写死的演示数据，启停/孵化/立即执行不触发任何真实交易" />
      <KpiRow items={kpis} height={96} />

      <div className="agents-filter">
        <div className="seg">
          {(['all', 'running', 'paused', 'standby'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? '全部' : f === 'running' ? '运行中' : f === 'paused' ? '已暂停' : '待命'}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => pushToast(dispatch, '🧬 正在从策略池孵化新 Agent · 预计 45s 完成')}>
          + 孵化新 Agent
        </button>
        <style>{`
          .agents-filter { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        `}</style>
      </div>

      <div className="main-area">
        {/* 卡片网格 */}
        <div className="agents-grid">
          {list.map((a) => {
            const isSel = a.id === state.selectedAgent
            const selAlloc = alloc[a.id] ?? a.allocation
            return (
              <div
                key={a.id}
                className={`agent-card ${isSel ? 'on' : ''}`}
                onClick={() => { dispatch({ type: 'SELECT_AGENT', id: a.id }); pushToast(dispatch, `已选中 ${a.name}`) }}
              >
                <div className="ac-head">
                  <div className="ac-id">
                    <span className="pulse-dot2 live" style={{ color: a.status === 'running' ? 'var(--down)' : 'var(--text-weak)', background: a.status === 'running' ? 'var(--down)' : 'var(--border-strong)', animation: a.status === 'running' ? undefined : 'none' }} />
                    <span className="ac-name">{a.name}</span>
                  </div>
                  {statusChip(a.status)}
                </div>
                <div className="ac-strategy">{a.strategy}</div>
                <div className="ac-metrics">
                  <div className="ac-m"><span className="ac-m-label">今日 PnL</span><span className="ac-m-val up">{a.todayPnl > 0 ? '+' : ''}${a.todayPnl.toLocaleString('en-US')}</span></div>
                  <div className="ac-m"><span className="ac-m-label">Sharpe</span><span className="ac-m-val">{a.sharpe.toFixed(1)}</span></div>
                  <div className="ac-m"><span className="ac-m-label">胜率</span><span className="ac-m-val">{a.winRate}%</span></div>
                  <div className="ac-m"><span className="ac-m-label">成交</span><span className="ac-m-val">{a.tradesToday.toLocaleString('en-US')}</span></div>
                </div>
                <div className="ac-bar">
                  <span className="ac-bar-label">资金 {selAlloc}%</span>
                  <div className="ac-bar-track"><div className="ac-bar-fill" style={{ width: `${selAlloc}%`, background: a.status === 'running' ? 'var(--primary)' : 'var(--border-strong)' }} /></div>
                </div>
                <div className="ac-actions" onClick={(e) => e.stopPropagation()}>
                  <button className={`btn btn-sm ${a.status === 'running' ? '' : 'btn-primary'}`} onClick={() => toggle(a)}>
                    {a.status === 'running' ? '暂停' : '启动'}
                  </button>
                  <button className="btn btn-sm" onClick={() => execNow(a)}>立即执行</button>
                </div>
              </div>
            )
          })}
          {list.length === 0 && <div style={{ color: 'var(--text-weak)', padding: 40 }}>当前筛选条件下无 Agent</div>}
          <style>{`
            .agents-grid {
              flex: 1; min-width: 0;
              display: grid; grid-template-columns: repeat(2, 1fr);
              grid-auto-rows: minmax(0, 1fr);
              gap: 12px; overflow-y: auto; padding-right: 2px;
            }
            .agent-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column; gap: 7px;
              cursor: pointer; transition: all 0.15s;
              overflow: hidden;
            }
            .agent-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
            .agent-card.on { border-color: var(--primary-40); box-shadow: 0 0 0 1px var(--primary-40), 0 8px 24px rgba(34,211,238,0.06); }
            .ac-head { display: flex; align-items: center; justify-content: space-between; }
            .ac-id { display: flex; align-items: center; gap: 7px; min-width: 0; }
            .ac-name { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-main); white-space: nowrap; }
            .ac-strategy { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }
            .ac-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 2px; }
            .ac-m { display: flex; align-items: center; justify-content: space-between; }
            .ac-m-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
            .ac-m-val { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-main); }
            .ac-m-val.up { color: var(--up); }
            .ac-bar { display: flex; align-items: center; gap: 8px; }
            .ac-bar-label { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); flex-shrink: 0; width: 46px; }
            .ac-bar-track { flex: 1; height: 4px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; }
            .ac-bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
            .ac-actions { display: flex; gap: 8px; }
          `}</style>
        </div>

        {/* 详情面板 */}
        <div className="right-col agent-detail">
          <div className="detail-card">
            <div className="dc-head">
              <span className="panel-title">{selected.name}</span>
              {statusChip(selected.status)}
            </div>
            <div className="dc-row"><span className="dc-label">策略</span><span className="dc-val">{selected.strategy}</span></div>
            <div className="dc-row"><span className="dc-label">策略 ID</span><span className="dc-val mono">AG-{selected.id.toUpperCase()}-{selected.sharpe.toFixed(1)}x</span></div>
            <div className="dc-row"><span className="dc-label">资金分配</span><span className="dc-val mono">{alloc[selected.id] ?? selected.allocation}%</span></div>
            <div className="dc-row"><span className="dc-label">今日成交</span><span className="dc-val mono">{selected.tradesToday.toLocaleString('en-US')} 笔</span></div>
            <div className="dc-row"><span className="dc-label">LLM 调用</span><span className="dc-val mono">{selected.llmCalls.toLocaleString('en-US')}</span></div>
            <div className="dc-row"><span className="dc-label">胜率</span><span className="dc-val mono">{selected.winRate}%</span></div>
            <div className="dc-row"><span className="dc-label">Sharpe</span><span className="dc-val mono">{selected.sharpe.toFixed(1)}</span></div>

            <div className="dc-slider">
              <div className="dc-slider-head">
                <span className="dc-label">分配比例</span>
                <span className="dc-val mono">{(alloc[selected.id] ?? selected.allocation)}%</span>
              </div>
              <input
                type="range" min={2} max={50}
                value={alloc[selected.id] ?? selected.allocation}
                onChange={(e) => setAlloc((m) => ({ ...m, [selected.id]: Number(e.target.value) }))}
              />
            </div>

            <div className="dc-actions">
              <button className={`btn btn-sm ${selected.status === 'running' ? '' : 'btn-primary'}`} onClick={() => toggle(selected)}>
                {selected.status === 'running' ? '⏸ 暂停' : '▶️ 启动'}
              </button>
              <button className="btn btn-sm" onClick={() => execNow(selected)}>⚡ 立即执行</button>
            </div>
            <button className="btn btn-sm full mt" onClick={() => { dispatch({ type: 'TOGGLE_AGENT', id: selected.id }); dispatch({ type: 'TOGGLE_AGENT', id: selected.id }); pushToast(dispatch, `🔄 ${selected.name} 策略已热重载`) }}>🔄 重载策略参数</button>
            <button className="btn btn-sm full mt2" onClick={() => { pushToast(dispatch, '📋 已复制 Agent 绩效报告'); }}>
              📋 导出绩效报告
            </button>
            <button className="btn btn-sm full" onClick={() => setPage('evo')}>🧬 送入进化实验室</button>
          </div>

          <div className="dc-note">
            <span className="dc-note-title">最近决策</span>
            <div className="dc-note-line" style={{ color: 'var(--text-sub)' }}>· {selected.status === 'running' ? '盘口深度更新 · 订单簿失衡 -2.1σ，已缩减挂单价差' : 'Agent 暂停中 · 等待人工指令'}</div>
            <div className="dc-note-line" style={{ color: 'var(--text-sub)' }}>· {selected.status === 'running' ? '资金费率 +0.014% · 未触发套利阈值' : '仓位已冻结 · 风控规则生效中'}</div>
          </div>

          <style>{`
            .agent-detail { width: 356px; }
            .detail-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 14px;
              display: flex; flex-direction: column; gap: 8px;
            }
            .dc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 2px; }
            .dc-row { display: flex; align-items: center; justify-content: space-between; }
            .dc-label { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }
            .dc-val { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
            .dc-val.mono { font-family: var(--font-mono); font-size: 12px; }
            .dc-slider { padding: 6px 0 2px; }
            .dc-slider-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
            .dc-slider input[type='range'] { width: 100%; accent-color: var(--primary); }
            .dc-actions { display: flex; gap: 8px; }
            .dc-actions .btn { flex: 1; }
            .btn.full { width: 100%; }
            .btn.mt { margin-top: 4px; }
            .btn.mt2 { margin-top: 4px; }
            .dc-note {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column; gap: 6px;
              flex: 1; min-height: 0; overflow: hidden;
            }
            .dc-note-title { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
            .dc-note-line { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; }
          `}</style>
        </div>
      </div>
    </div>
  )
}
