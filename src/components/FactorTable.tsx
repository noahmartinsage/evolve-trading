import React, { useState } from 'react'

export interface FactorRow {
  id: string
  fitness: number
  sharpe: number
  maxDrawdown: number
  winRate: number
  tradesPerDay: number
  isBest?: boolean
}

/**
 * 因子表现对比表 — 按 fitness 降序排列，最佳因子高亮。
 * 点击行展开详细分解。
 */
export default function FactorTable({ rows }: { rows: FactorRow[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const sorted = [...rows].sort((a, b) => b.fitness - a.fitness)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 4, fontFamily: 'var(--font-ui)' }}>
        因子表现
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--text-weak)', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)' }}>策略</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)', textAlign: 'right' }}>Fitness</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)', textAlign: 'right' }}>Sharpe</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)', textAlign: 'right' }}>回撤</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)', textAlign: 'right' }}>胜率</th>
              <th style={{ padding: '4px 6px', fontWeight: 500, fontFamily: 'var(--font-ui)', textAlign: 'right' }}>日均</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <React.Fragment key={r.id}>
                <tr
                  style={{
                    cursor: 'pointer',
                    background: r.isBest ? 'rgba(34,211,238,0.08)' : 'transparent',
                    borderLeft: r.isBest ? '3px solid var(--primary)' : '3px solid transparent',
                  }}
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                >
                  <td style={{ padding: '6px', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    {r.isBest ? '★ ' : ''}{r.id}
                  </td>
                  <td style={{ padding: '6px', textAlign: 'right', color: r.fitness > 0 ? 'var(--down)' : 'var(--up)', fontFamily: 'var(--font-mono)' }}>
                    {r.fitness.toFixed(2)}
                  </td>
                  <td style={{ padding: '6px', textAlign: 'right', color: r.sharpe > 0 ? 'var(--down)' : 'var(--up)', fontFamily: 'var(--font-mono)' }}>
                    {r.sharpe.toFixed(2)}
                  </td>
                  <td style={{ padding: '6px', textAlign: 'right', color: 'var(--up)', fontFamily: 'var(--font-mono)' }}>
                    {r.maxDrawdown.toFixed(1)}%
                  </td>
                  <td style={{ padding: '6px', textAlign: 'right', color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
                    {r.winRate.toFixed(0)}%
                  </td>
                  <td style={{ padding: '6px', textAlign: 'right', color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
                    {r.tradesPerDay.toFixed(1)}
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td colSpan={6} style={{ padding: '8px 12px', background: 'var(--bg-elevated)' }}>
                      <div style={{ fontSize: 10, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)' }}>
                        详细分解 · 点击再次收起
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 4 }}>
                        <div><span style={{ color: 'var(--text-weak)', fontSize: 9 }}>Fitness</span><br /><span style={{ color: 'var(--primary)', fontFamily: 'var(--font-mono)' }}>{r.fitness.toFixed(4)}</span></div>
                        <div><span style={{ color: 'var(--text-weak)', fontSize: 9 }}>Sharpe</span><br /><span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{r.sharpe.toFixed(4)}</span></div>
                        <div><span style={{ color: 'var(--text-weak)', fontSize: 9 }}>Max DD</span><br /><span style={{ color: 'var(--up)', fontFamily: 'var(--font-mono)' }}>{r.maxDrawdown.toFixed(2)}%</span></div>
                        <div><span style={{ color: 'var(--text-weak)', fontSize: 9 }}>Win Rate</span><br /><span style={{ color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>{r.winRate.toFixed(1)}%</span></div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}