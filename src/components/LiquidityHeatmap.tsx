import React from 'react'

export interface HeatCell {
  symbol: string
  value: number
  max: number
  label?: string
}

/**
 * 流动性热力图 — 各币种/场所的流动性状态。
 * 颜色编码：深色=低流动性，亮色=高流动性。
 */
export default function LiquidityHeatmap({ cells }: { cells: HeatCell[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 2, fontFamily: 'var(--font-ui)' }}>
        流动性分布
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(70px, 1fr))', gap: 6 }}>
        {cells.map((c, i) => {
          const pct = Math.min(100, (c.value / c.max) * 100)
          const intensity = pct / 100
          const bg = `rgba(34, 211, 238, ${0.1 + intensity * 0.7})`
          return (
            <div
              key={i}
              style={{
                background: bg,
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '6px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
              title={`${c.label || c.symbol}: ${c.value.toFixed(2)}`}
            >
              <span style={{ fontSize: 9, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.label || c.symbol}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-main)', fontFamily: 'var(--font-mono)' }}>
                {c.value.toFixed(2)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}