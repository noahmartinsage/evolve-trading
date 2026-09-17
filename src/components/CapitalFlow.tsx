import React from 'react'
import FlowBar from './FlowBar'

export interface CapitalFlowProps {
  rows: { label: string; value: number; color: string }[]
  maxAbs?: number
}

/**
 * 双边资金流向 — CEX ↔ DEX 净流入/流出。
 * 每行一个 FlowBar，正值向右、负值向左。
 */
export default function CapitalFlow({ rows, maxAbs }: CapitalFlowProps) {
  const max = maxAbs ?? Math.max(...rows.map((r) => Math.abs(r.value)), 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 4, fontFamily: 'var(--font-ui)' }}>
        资金流向（CEX ↔ DEX）
      </div>
      {rows.map((r, i) => (
        <FlowBar key={i} label={r.label} value={r.value} max={max} color={r.color} />
      ))}
    </div>
  )
}