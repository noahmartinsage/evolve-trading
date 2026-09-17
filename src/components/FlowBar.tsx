import React from 'react'

export interface FlowBarProps {
  label: string
  value: number
  max: number
  color: string
  unit?: string
  format?: (v: number) => string
}

/**
 * 单向资金流动条 — 用于 CEX ↔ DEX 双向资金流展示。
 * 正值向右延伸，负值向左延伸。
 */
export default function FlowBar({
  label,
  value,
  max,
  color,
  unit = '',
  format = (v: number) => v.toFixed(2),
}: FlowBarProps) {
  const pct = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0
  const isPos = value >= 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ width: 70, fontSize: 10, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)', flexShrink: 0, textAlign: 'right' }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 14, background: 'var(--bg-elevated)', borderRadius: 7, position: 'relative', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute', top: 0, bottom: 0,
            [isPos ? 'left' : 'right']: '50%',
            width: `${pct}%`,
            background: color,
            opacity: 0.85,
            transition: 'width 0.3s',
          }}
        />
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border-strong)' }} />
      </div>
      <span style={{ width: 70, fontSize: 10, color: isPos ? 'var(--down)' : 'var(--up)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
        {isPos ? '+' : ''}{format(value)}{unit}
      </span>
    </div>
  )
}