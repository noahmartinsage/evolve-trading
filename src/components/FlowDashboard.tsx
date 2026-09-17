import React from 'react'
import CapitalFlow from './CapitalFlow'
import RiskMeter from './RiskMeter'
import LiquidityHeatmap, { HeatCell } from './LiquidityHeatmap'

export interface FlowDashboardProps {
  capitalRows: { label: string; value: number; color: string }[]
  riskUsed: number
  riskCap: number
  heatCells: HeatCell[]
}

/**
 * 流动模块容器 — 资金流向 + 风险利用率 + 流动性热力图。
 */
export default function FlowDashboard({ capitalRows, riskUsed, riskCap, heatCells }: FlowDashboardProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, height: '100%' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <CapitalFlow rows={capitalRows} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', justifyContent: 'center' }}>
          <RiskMeter used={riskUsed} cap={riskCap} />
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <LiquidityHeatmap cells={heatCells} />
        </div>
      </div>
    </div>
  )
}