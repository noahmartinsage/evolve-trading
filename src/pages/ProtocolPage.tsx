import React, { useState } from 'react'
import { useStore, pushToast } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { DemoBanner } from '../components/DemoBadge'

const settlements = [
  { time: '10:07:21', from: '0x8dxd·Alpha', to: '主钱包', amount: '+$12,480', status: '成功' },
  { time: '10:05:03', from: 'HVOL-ARB-07', to: '主钱包', amount: '+$8,210', status: '成功' },
  { time: '10:02:47', from: 'MOM-SOL-11', to: '主钱包', amount: '+$5,340', status: '成功' },
  { time: '09:58:12', from: '主钱包', to: 'GRID-BTC-03', amount: '-$4,000', status: '成功' },
  { time: '09:51:30', from: 'LIQ-ETH-02', to: '主钱包', amount: '+$3,180', status: '成功' },
]

const mcpTools = [
  { name: 'hyperliquid.book', desc: '盘口深度 / L2 订单簿', calls: 312400 },
  { name: 'uniswap.quote', desc: 'DEX 实时报价', calls: 240800 },
  { name: 'chainlink.feed', desc: '预言机价格源', calls: 142600 },
  { name: 'evm.simulate', desc: '交易模拟执行', calls: 68400 },
  { name: 'subgraph.query', desc: '链上数据索引', calls: 56100 },
]

export default function ProtocolPage() {
  const { state, dispatch } = useStore()
  const [mcpLog, setMcpLog] = useState<string[]>([
    '[10:07:21] hyperliquid.book · 成功 · 23ms',
    '[10:07:19] uniswap.quote · 成功 · 41ms',
    '[10:07:15] chainlink.feed · 成功 · 18ms',
  ])
  const totalYes = state.proposalYes + state.proposalNo
  const yesPct = Math.round((state.proposalYes / Math.max(1, totalYes)) * 100)
  const tab = state.protocolTab

  const runMcp = (name: string) => {
    const t = new Date().toTimeString().slice(0, 8)
    setMcpLog((prev) => [`[${t}] ${name} · 成功 · ${Math.floor(Math.random() * 60 + 10)}ms`, ...prev].slice(0, 8))
    pushToast(dispatch, `🔧 MCP 调用 ${name} 成功`)
  }

  const kpis: KpiItem[] = [
    { label: '协议状态', value: '3/3 就绪', valueColor: 'var(--down)', meta: 'x402 · ERC-8004 · MCP', metaColor: 'var(--down)' },
    { label: 'x402 结算', value: '$4.2M', valueColor: 'var(--primary)', meta: '今日 1,284 笔 · 0 失败', metaColor: 'var(--primary)' },
    { label: '身份主体', value: '1,284', valueColor: 'var(--accent)', meta: 'ERC-8004 链上注册', metaColor: 'var(--accent)' },
    { label: 'MCP 调用', value: '842K', valueColor: 'var(--warning)', meta: 'P50 延迟 26ms', metaColor: 'var(--warning)' },
    { label: '治理提案', value: '5', valueColor: 'var(--text-main)', meta: `进行中 1 · 待投票 ${state.proposalVoted ? 0 : 1}`, metaColor: 'var(--text-sub)' },
  ]

  return (
    <div className="content-area">
      <DemoBanner text="结算流水/声誉/工具列表为静态文案，MCP 调用与治理投票不上链；协议栈扩展已冻结至阶段 D" />
      <KpiRow items={kpis} height={96} />

      <div className="main-area">
        {/* 协议详情 */}
        <div className="proto-detail">
          <div className="tabs">
            <div className={`tab-item ${tab === 'x402' ? 'on' : ''}`} onClick={() => dispatch({ type: 'SET_PROTOCOL_TAB', tab: 'x402' })}>x402 支付</div>
            <div className={`tab-item ${tab === 'erc8004' ? 'on' : ''}`} onClick={() => dispatch({ type: 'SET_PROTOCOL_TAB', tab: 'erc8004' })}>ERC-8004 身份</div>
            <div className={`tab-item ${tab === 'mcp' ? 'on' : ''}`} onClick={() => dispatch({ type: 'SET_PROTOCOL_TAB', tab: 'mcp' })}>MCP 工具</div>
          </div>

          {tab === 'x402' && (
            <div className="tab-body">
              <div className="tb-hero">
                <div>
                  <div className="tb-hero-title">HTTP 402 → 链上支付通道</div>
                  <div className="tb-hero-desc">当 Agent 调用需要付费的 API 时，服务端返回 402 + 付款要求，系统自动通过 x402 通道完成微支付结算。全程无需人工签名，结算密钥由 EVOLVE 保险库托管。</div>
                </div>
                <button className="btn btn-primary" onClick={() => pushToast(dispatch, '💰 x402 批量结算已发起 · 8 笔待处理')}>发起结算</button>
              </div>
              <div className="tb-stats">
                <div className="tb-stat"><span className="tb-stat-label">今日结算额</span><span className="tb-stat-val" style={{ color: 'var(--primary)' }}>$4.2M</span></div>
                <div className="tb-stat"><span className="tb-stat-label">通道成功率</span><span className="tb-stat-val" style={{ color: 'var(--down)' }}>99.98%</span></div>
                <div className="tb-stat"><span className="tb-stat-label">平均到账</span><span className="tb-stat-val">1.2s</span></div>
                <div className="tb-stat"><span className="tb-stat-label">Gas 费用</span><span className="tb-stat-val">$0.03/笔</span></div>
              </div>
              <div className="tb-log">
                <span className="tb-log-title">结算流水</span>
                {settlements.map((s, i) => (
                  <div key={i} className="tb-log-row">
                    <span className="tb-log-time">{s.time}</span>
                    <span className="tb-log-path">{s.from} → {s.to}</span>
                    <span className={`tb-log-amt ${s.amount.startsWith('+') ? 'up' : 'down'}`}>{s.amount}</span>
                    <span className="chip chip-green">{s.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'erc8004' && (
            <div className="tab-body">
              <div className="tb-hero">
                <div>
                  <div className="tb-hero-title">链上身份 + 声誉信用分</div>
                  <div className="tb-hero-desc">每个 Agent 通过 ERC-8004 注册去中心化身份，交易行为沉淀为可验证的链上声誉。高声誉 Agent 可获得更低的手续费率和优先路由权。</div>
                </div>
                <button className="btn btn-primary" onClick={() => pushToast(dispatch, '🪪 已铸造新 Agent 身份 0x9f2e…a11b')}>铸造新身份</button>
              </div>
              <div className="tb-stats">
                <div className="tb-stat"><span className="tb-stat-label">注册主体</span><span className="tb-stat-val" style={{ color: 'var(--accent)' }}>1,284</span></div>
                <div className="tb-stat"><span className="tb-stat-label">平均声誉分</span><span className="tb-stat-val">847</span></div>
                <div className="tb-stat"><span className="tb-stat-label">信用借贷</span><span className="tb-stat-val">$86.4M</span></div>
                <div className="tb-stat"><span className="tb-stat-label">本周新增</span><span className="tb-stat-val" style={{ color: 'var(--down)' }}>+42</span></div>
              </div>
              <div className="rep-table">
                <table className="tbl">
                  <thead><tr><th>主体</th><th>类型</th><th className="num">声誉分</th><th className="num">胜率加成</th><th className="num">费率折扣</th></tr></thead>
                  <tbody>
                    <tr><td className="strong">0x8dxd 主钱包</td><td>人类</td><td className="num">912</td><td className="num up">+3.1%</td><td className="num down">-12%</td></tr>
                    <tr><td className="strong">0x8dxd·Alpha</td><td>Agent</td><td className="num">887</td><td className="num up">+2.8%</td><td className="num down">-10%</td></tr>
                    <tr><td className="strong">HVOL-ARB-07</td><td>Agent</td><td className="num">854</td><td className="num up">+2.4%</td><td className="num down">-8%</td></tr>
                    <tr><td className="strong">0x3fa2…c91d</td><td>人类</td><td className="num">731</td><td className="num">—</td><td className="num down">-4%</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'mcp' && (
            <div className="tab-body">
              <div className="tb-hero">
                <div>
                  <div className="tb-hero-title">MCP 工具调用总线</div>
                  <div className="tb-hero-desc">Agent 通过标准 MCP 协议调用交易所、预言机、链上索引等工具，所有调用统一鉴权、计量、审计。今日累计 842K 次调用。</div>
                </div>
                <button className="btn btn-primary" onClick={() => runMcp('hyperliquid.book')}>测试调用</button>
              </div>
              <div className="mcp-tools">
                {mcpTools.map((t, i) => (
                  <div key={i} className="mcp-row">
                    <span className="mcp-name">{t.name}</span>
                    <span className="mcp-desc">{t.desc}</span>
                    <span className="mcp-calls">{t.calls.toLocaleString('en-US')} 次</span>
                    <button className="btn btn-sm" onClick={() => runMcp(t.name)}>调用</button>
                  </div>
                ))}
              </div>
              <div className="tb-log">
                <span className="tb-log-title">调用日志</span>
                {mcpLog.map((l, i) => (
                  <div key={i} className="tb-log-row">
                    <span className="tb-log-line">{l}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <style>{`
            .proto-detail {
              flex: 1; min-width: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 0 14px;
              display: flex; flex-direction: column;
              overflow: hidden;
            }
            .tab-body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px 0 12px; min-height: 0; }
            .tb-hero {
              display: flex; align-items: center; justify-content: space-between; gap: 16px;
              background: var(--bg-surface); border: 1px solid var(--border);
              border-radius: 10px; padding: 14px 16px;
            }
            .tb-hero-title { font-family: var(--font-ui); font-size: 14px; font-weight: 700; color: var(--text-main); margin-bottom: 5px; }
            .tb-hero-desc { font-family: var(--font-ui); font-size: 11px; line-height: 1.7; color: var(--text-sub); max-width: 560px; }
            .tb-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
            .tb-stat { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
            .tb-stat-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
            .tb-stat-val { font-family: var(--font-mono); font-size: 16px; font-weight: 800; color: var(--text-main); }
            .tb-log { display: flex; flex-direction: column; gap: 3px; }
            .tb-log-title { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); margin-bottom: 2px; }
            .tb-log-row { display: flex; align-items: center; gap: 10px; height: 26px; }
            .tb-log-time { width: 62px; font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); flex-shrink: 0; }
            .tb-log-path { flex: 1; font-family: var(--font-mono); font-size: 10px; color: var(--text-sub); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .tb-log-amt { font-family: var(--font-mono); font-size: 10px; font-weight: 700; flex-shrink: 0; }
            .tb-log-line { font-family: var(--font-mono); font-size: 10px; color: var(--text-sub); }
            .rep-table { overflow-y: auto; }
            .mcp-tools { display: flex; flex-direction: column; gap: 6px; }
            .mcp-row {
              display: flex; align-items: center; gap: 12px;
              background: var(--bg-surface); border: 1px solid var(--border);
              border-radius: 8px; padding: 8px 12px;
            }
            .mcp-name { width: 170px; font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text-main); flex-shrink: 0; }
            .mcp-desc { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); min-width: 0; }
            .mcp-calls { font-family: var(--font-mono); font-size: 10px; color: var(--text-sub); flex-shrink: 0; }
          `}</style>
        </div>

        {/* 治理面板 */}
        <div className="right-col gov-panel">
          <div className="gov-card">
            <div className="gov-head">
              <span className="panel-title">治理 · GIP-007</span>
              <span className="chip chip-amber">投票中</span>
            </div>
            <div className="gov-title">启用「进化阈值自适应」提案</div>
            <div className="gov-desc">当种群平均适应度连续 3 代无增长时，自动将变异率从 3.2% 提升至 5.0%，并触发一轮 LLM 深度搜索。</div>
            <div className="gov-meta">
              <span>提案人 · 0x8dxd</span>
              <span>截止 · 48h</span>
            </div>
            <div className="gov-bar">
              <div className="gov-bar-track">
                <div className="gov-bar-yes" style={{ width: `${yesPct}%` }} />
                <div className="gov-bar-no" style={{ width: `${100 - yesPct}%` }} />
              </div>
              <div className="gov-bar-labels">
                <span className="up">赞成 {state.proposalYes} ({yesPct}%)</span>
                <span className="down">反对 {state.proposalNo} ({100 - yesPct}%)</span>
              </div>
            </div>
            {state.proposalVoted ? (
              <div className="gov-voted">
                <span className="chip chip-green">✓ 投票已上链</span>
                <span className="gov-voted-text">你的声誉分已计入权重 · 结果将在 48h 后公布</span>
              </div>
            ) : (
              <div className="gov-actions">
                <button className="btn btn-buy btn-lg" onClick={() => { dispatch({ type: 'VOTE', vote: 'yes' }); pushToast(dispatch, '🗳 赞成票已上链 · 权重 ×1.0 (声誉 912)') }}>👍 赞成</button>
                <button className="btn btn-sell btn-lg" onClick={() => { dispatch({ type: 'VOTE', vote: 'no' }); pushToast(dispatch, '🗳 反对票已上链 · 权重 ×1.0 (声誉 912)') }}>👎 反对</button>
              </div>
            )}
            <button className="btn full mt" onClick={() => pushToast(dispatch, '📄 已打开 GIP-007 完整提案文档')}>查看完整提案</button>
          </div>

          <div className="gov-list">
            <span className="gov-list-title">其他提案</span>
            {[
              { id: 'GIP-006', name: '提高 x402 单笔限额至 $50K', status: '已通过' },
              { id: 'GIP-005', name: '新增 SOL 生态 MCP 工具集', status: '已通过' },
              { id: 'GIP-004', name: '降低滑点容忍度至 0.02%', status: '已否决' },
              { id: 'GIP-003', name: '部署第二套推理引擎节点', status: '已通过' },
            ].map((g, i) => (
              <div key={i} className="gov-list-row" onClick={() => pushToast(dispatch, `📄 已打开 ${g.id}`)}>
                <span className="gov-list-id">{g.id}</span>
                <span className="gov-list-name">{g.name}</span>
                <span className={`chip ${g.status === '已通过' ? 'chip-green' : 'chip-gray'}`}>{g.status}</span>
              </div>
            ))}
          </div>

          <style>{`
            .gov-panel { width: 356px; }
            .gov-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 14px;
              display: flex; flex-direction: column; gap: 9px;
            }
            .gov-head { display: flex; align-items: center; justify-content: space-between; }
            .gov-title { font-family: var(--font-ui); font-size: 14px; font-weight: 700; color: var(--text-main); line-height: 1.4; }
            .gov-desc { font-family: var(--font-ui); font-size: 11px; line-height: 1.7; color: var(--text-sub); }
            .gov-meta { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); }
            .gov-bar { display: flex; flex-direction: column; gap: 6px; }
            .gov-bar-track { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-surface); }
            .gov-bar-yes { background: var(--up); }
            .gov-bar-no { background: var(--down); }
            .gov-bar-labels { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10px; font-weight: 600; }
            .gov-actions { display: flex; gap: 10px; }
            .gov-actions .btn { flex: 1; }
            .gov-voted { display: flex; align-items: center; gap: 10px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
            .gov-voted-text { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); }
            .btn.full { width: 100%; }
            .btn.mt { margin-top: 2px; }
            .gov-list {
              flex: 1; min-height: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column; gap: 4px;
              overflow-y: auto;
            }
            .gov-list-title { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); margin-bottom: 4px; }
            .gov-list-row {
              display: flex; align-items: center; gap: 8px;
              height: 30px; padding: 0 6px; border-radius: 6px;
              cursor: pointer; transition: background 0.15s;
            }
            .gov-list-row:hover { background: rgba(255,255,255,0.03); }
            .gov-list-id { font-family: var(--font-mono); font-size: 10px; color: var(--primary); flex-shrink: 0; width: 48px; }
            .gov-list-name { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          `}</style>
        </div>
      </div>
    </div>
  )
}
