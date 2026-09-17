import React from 'react'
import FactorTable, { FactorRow } from './FactorTable'
import DecayChart, { DecayPoint } from './DecayChart'
import PurityHeatmap, { PurityCell } from './PurityHeatmap'

export interface StyleDashboardProps {
  factors: FactorRow[]
  decayPoints: DecayPoint[]
  purityCells: PurityCell[]
}

/**
 * 风格模块容器 — 因子表现 + 衰减曲线 + 相关性热力图。
 */
export default function StyleDashboard({ factors, decayPoints, purityCells }: StyleDashboardProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, flex: 1, overflow: 'auto' }}>
        <FactorTable rows={factors} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <DecayChart points={decayPoints} />
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <PurityHeatmap cells={purityCells} />
        </div>
      </div>
    </div>
  )
}