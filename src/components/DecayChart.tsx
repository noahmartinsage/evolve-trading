import React, { useMemo } from 'react'

export interface DecayPoint {
  label: string
  is: number
  oos: number
}

/**
 * IS→OOS 衰减曲线 — 展示各窗口的 in-sample 与 out-of-sample 表现对比。
 */
export default function DecayChart({ points }: { points: DecayPoint[] }) {
  const max = useMemo(() => Math.max(...points.map((p) => Math.max(p.is, p.oos)), 1), [points])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 2, fontFamily: 'var(--font-ui)' }}>
        IS → OOS 衰减
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {points.map((p, i) => {
          const isPct = (p.is / max) * 100
          const oosPct = (p.oos / max) * 100
          const decay = p.is > 0 ? ((p.is - p.oos) / p.is) * 100 : 0
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 50, fontSize: 9, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)' }}>{p.label}</span>
              <div style={{ flex: 1, height: 12, background: 'var(--bg-elevated)', borderRadius: 6, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${isPct}%`, background: 'var(--primary)', opacity: 0.5 }} />
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${oosPct}%`, background: 'var(--accent)', opacity: 0.7 }} />
              </div>
              <span style={{ width: 40, fontSize: 9, color: decay > 10 ? 'var(--warning)' : 'var(--text-sub)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                {decay.toFixed(0)}%
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 2, fontSize: 9, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--primary)', opacity: 0.5, borderRadius: 2, marginRight: 4 }} />IS</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--accent)', opacity: 0.7, borderRadius: 2, marginRight: 4 }} />OOS</span>
      </div>
    </div>
  )
}