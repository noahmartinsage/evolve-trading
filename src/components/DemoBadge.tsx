import React from 'react'

export function DemoBanner({ text }: { text?: string }) {
  return (
    <div className="demo-banner">
      <span className="db-tag">DEMO 数据</span>
      <span className="db-text">
        本页内容为界面演示{text ? ` · ${text}` : ''} · 不代表真实业绩 · 不构成任何投资建议
      </span>
      <style>{`
        .demo-banner {
          display: flex; align-items: center; gap: 10px; flex-shrink: 0;
          background: rgba(255,176,32,0.06); border: 1px solid rgba(255,176,32,0.3);
          border-radius: 8px; padding: 7px 12px;
        }
        .db-tag {
          font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 1px;
          color: var(--warning); border: 1px solid rgba(255,176,32,0.45);
          border-radius: 4px; padding: 2px 6px; white-space: nowrap;
        }
        .db-text { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.5; }
      `}</style>
    </div>
  )
}

export function DemoChip({ label = 'DEMO' }: { label?: string }) {
  return <span className="demo-chip-inline">{label}</span>
}
