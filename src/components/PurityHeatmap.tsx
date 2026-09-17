import React from 'react'

export interface PurityCell {
  row: string
  col: string
  value: number
}

/**
 * 候选相关性热力图 — 颜色编码：深色=低相关，亮色=高相关（>0.8 标记为同质化风险）。
 */
export default function PurityHeatmap({ cells }: { cells: PurityCell[] }) {
  const max = Math.max(...cells.map((c) => c.value), 1)

  // 按行/列分组
  const rows = [...new Set(cells.map((c) => rowKey(c)))]
  const cols = [...new Set(cells.map((c) => colKey(c)))]

  function rowKey(c: PurityCell) { return c.row }
  function colKey(c: PurityCell) { return c.col }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 2, fontFamily: 'var(--font-ui)' }}>
        候选相关性
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 9 }}>
          <thead>
            <tr>
              <th style={{ padding: '2px 4px', color: 'var(--text-weak)' }}></th>
              {cols.map((c, i) => (
                <th key={i} style={{ padding: '2px 4px', color: 'var(--text-weak)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                <td style={{ padding: '2px 4px', color: 'var(--text-weak)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r}</td>
                {cols.map((c, ci) => {
                  const cell = cells.find((x) => rowKey(x) === r && colKey(x) === c)
                  const v = cell ? cell.value : 0
                  const pct = (v / max) * 100
                  const intensity = pct / 100
                  const isRisk = v > 0.8
                  const bg = isRisk
                    ? `rgba(246,70,93,${0.2 + intensity * 0.6})`
                    : `rgba(34,211,238,${0.1 + intensity * 0.6})`
                  return (
                    <td key={ci} style={{ padding: 2 }}>
                      <div
                        style={{
                          width: 36, height: 36, background: bg,
                          borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: isRisk ? '1px solid var(--up)' : '1px solid transparent',
                        }}
                        title={`${r} ↔ ${c}: ${v.toFixed(3)}${isRisk ? ' ⚠ 同质化风险' : ''}`}
                      >
                        <span style={{ fontSize: 8, color: 'var(--text-main)', fontFamily: 'var(--font-mono)' }}>
                          {v.toFixed(2)}
                        </span>
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}