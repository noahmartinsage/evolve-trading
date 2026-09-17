import React, { useState } from 'react'
import KpiTrend, { Point } from './KpiTrend'
import KpiDrilldown from './KpiDrilldown'

export interface KpiItem {
  label: string
  value: string
  valueColor?: string
  meta: string
  metaColor?: string
  /** 走势数据（可选，用于 sparkline） */
  trend?: Point[]
  /** 下钻目标（可选，点击卡片展开详情） */
  drilldown?: {
    formula?: string
    source?: string
    format?: (v: number) => string
  }
  /** 点击卡片回调（可选） */
  onClick?: () => void
}

export default function KpiRow({ items, height = 104 }: { items: KpiItem[]; height?: number }) {
  const [drillOpen, setDrillOpen] = useState<number | null>(null)

  const openDrill = (i: number) => {
    if (items[i].drilldown || items[i].onClick) setDrillOpen(i)
  }
  const closeDrill = () => setDrillOpen(null)

  const drillItem = drillOpen !== null ? items[drillOpen] : null

  return (
    <div style={{ position: 'relative' }}>
      <div className="kpi-row" style={{ height }}>
        {items.map((kpi, i) => {
          const clickable = !!(kpi.drilldown || kpi.onClick)
          return (
            <div
              key={i}
              className={`kpi-card${clickable ? ' clickable' : ''}`}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => openDrill(i)}
            >
              <span className="kpi-label">{kpi.label}</span>
              <span className="kpi-value" style={{ color: kpi.valueColor || 'var(--text-main)' }}>{kpi.value}</span>
              {kpi.trend && kpi.trend.length >= 2 && (
                <KpiTrend
                  points={kpi.trend}
                  width={100}
                  height={22}
                  color={kpi.valueColor || 'var(--primary)'}
                />
              )}
              <span className="kpi-meta" style={{ color: kpi.metaColor || 'var(--text-sub)' }}>{kpi.meta}</span>
            </div>
          )
        })}
      </div>

      {drillItem && (
        <KpiDrilldown
          open={drillOpen !== null}
          onClose={closeDrill}
          title={drillItem.label}
          value={drillItem.value}
          formula={drillItem.drilldown?.formula}
          source={drillItem.drilldown?.source}
          points={drillItem.trend || []}
          format={drillItem.drilldown?.format}
        />
      )}

      <style>{`
        .kpi-row { display: flex; gap: 12px; flex-shrink: 0; }
        .kpi-card {
          flex: 1; min-width: 0;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 12px 14px;
          display: flex; flex-direction: column; gap: 4px;
          overflow: hidden; position: relative;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .kpi-card.clickable:hover {
          border-color: var(--border-strong);
          box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        }
        .kpi-label {
          font-family: var(--font-ui); font-size: 11px; font-weight: 400;
          color: var(--text-weak); white-space: nowrap;
        }
        .kpi-value {
          font-family: var(--font-mono); font-size: 21px; font-weight: 800;
          line-height: 1.15; white-space: nowrap;
        }
        .kpi-meta {
          font-family: var(--font-mono); font-size: 11px; font-weight: 500;
          margin-top: 2px; white-space: nowrap;
        }
      `}</style>
    </div>
  )
}