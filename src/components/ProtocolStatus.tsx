import React from 'react'

const protocols = [
  {
    name: 'x402 支付通道',
    value: '今日结算 $4.2M',
    color: 'var(--primary)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M7 8 L10 5 L13 8" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M7 12 L10 15 L13 12" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    name: 'ERC-8004 身份声誉',
    value: '链上主体 1,284',
    color: 'var(--accent)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M10 2.5 L14 5 L14 9 L10 11.5 L6 9 L6 5 Z" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="10" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.2" />
        <path d="M10 10 L10 13" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
  {
    name: 'MCP 工具调用',
    value: '今日 842K 次',
    color: 'var(--warning)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 8 L10 11 L14 8" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
]

export default function ProtocolStatus({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className="protocol-card">
      <div className="protocol-header">
        <span className="protocol-title">Web4.0 协议层</span>
        <div className="ready-badge" onClick={onOpen} style={onOpen ? { cursor: 'pointer' } : undefined}>
          <span className="ready-dot" />
          <span className="ready-text">3/3 就绪</span>
        </div>
      </div>
      {protocols.map((p, i) => (
        <div key={i} className="protocol-row" onClick={onOpen}>
          <div className="protocol-icon" style={{ color: p.color }}>{p.icon}</div>
          <span className="protocol-name">{p.name}</span>
          <span className="protocol-value" style={{ color: p.color }}>{p.value}</span>
        </div>
      ))}
      <style>{`
        .protocol-card {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 14px;
          display: flex; flex-direction: column; gap: 10px;
          flex-shrink: 0;
        }
        .protocol-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 2px;
        }
        .protocol-title {
          font-family: var(--font-ui); font-size: 14px; font-weight: 600;
          color: var(--text-main);
        }
        .ready-badge {
          display: flex; align-items: center; gap: 5px;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 3px 8px;
        }
        .ready-dot {
          width: 5.2px; height: 5.2px; border-radius: 50%;
          background: var(--down);
        }
        .ready-text {
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          color: var(--down);
        }
        .protocol-row {
          display: flex; align-items: center; gap: 10px;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 0 12px; height: 44px;
          cursor: pointer; transition: all 0.15s;
        }
        .protocol-row:hover { border-color: var(--primary-40); transform: translateX(2px); }
        .protocol-icon { width: 20px; height: 20px; flex-shrink: 0; }
        .protocol-name {
          flex: 1; font-family: var(--font-ui); font-size: 12px; font-weight: 500;
          color: var(--text-sub);
        }
        .protocol-value {
          font-family: var(--font-mono); font-size: 11px; font-weight: 500;
        }
      `}</style>
    </div>
  )
}
