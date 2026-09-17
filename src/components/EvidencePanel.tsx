import React from 'react'

export interface EvidenceItem {
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

/**
 * 证据链面板 — 审计链 + SLO + 监控 + 对账 四维证据。
 */
export default function EvidencePanel({ items }: { items: EvidenceItem[] }) {
  const statusColor = { pass: 'var(--down)', warn: 'var(--warning)', fail: 'var(--up)' }
  const statusIcon = { pass: '✓', warn: '!', fail: '✕' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 2, fontFamily: 'var(--font-ui)' }}>
        证据链
      </div>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            background: 'var(--bg-elevated)', borderRadius: 6,
            borderLeft: `3px solid ${statusColor[item.status]}`,
          }}
        >
          <span style={{ color: statusColor[item.status], fontSize: 12, fontFamily: 'var(--font-mono)' }}>
            {statusIcon[item.status]}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)', width: 70, flexShrink: 0 }}>
            {item.label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-sub)', fontFamily: 'var(--font-ui)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.detail}
          </span>
        </div>
      ))}
    </div>
  )
}