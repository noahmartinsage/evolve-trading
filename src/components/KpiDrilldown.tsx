import React, { useEffect, useRef } from 'react'
import KpiTrend, { Point } from './KpiTrend'

export interface KpiDrilldownProps {
  open: boolean
  onClose: () => void
  title: string
  value: string
  formula?: string
  source?: string
  points: Point[]
  format?: (v: number) => string
  children?: React.ReactNode
}

/**
 * 下钻模态框 — 点击 KPI 卡片后展开，展示历史走势、计算公式、关联事件。
 */
export default function KpiDrilldown({
  open,
  onClose,
  title,
  value,
  formula,
  source,
  points,
  format = (v: number) => v.toFixed(2),
  children,
}: KpiDrilldownProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
    }
  }, [open, onClose])

  if (!open) return null

  const min = Math.min(...points.map((p) => p.v))
  const max = Math.max(...points.map((p) => p.v))
  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  const delta = last && prev ? last.v - prev.v : 0

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(4,5,10,0.75)',
        backdropFilter: 'blur(4px)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={ref}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
          borderRadius: 14, padding: 24, width: '100%', maxWidth: 560,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-weak)', marginBottom: 4, fontFamily: 'var(--font-ui)' }}>
              {source || 'EVOLVE 编排器'}
            </div>
            <h3 style={{ margin: 0, fontSize: 18, color: 'var(--text-main)', fontFamily: 'var(--font-ui)' }}>
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-weak)', cursor: 'pointer', fontSize: 18, padding: 4 }}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
          <span style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-main)', fontFamily: 'var(--font-mono)' }}>
            {value}
          </span>
          {delta !== 0 && (
            <span style={{ fontSize: 13, color: delta >= 0 ? 'var(--down)' : 'var(--up)', marginBottom: 4 }}>
              {delta >= 0 ? '↑' : '↓'} {format(Math.abs(delta))}
            </span>
          )}
        </div>

        <KpiTrend points={points} width={500} height={60} color="var(--primary)" format={format} />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ padding: '3px 10px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 11, color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
            最低 {format(min)}
          </span>
          <span style={{ padding: '3px 10px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 11, color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
            最高 {format(max)}
          </span>
          <span style={{ padding: '3px 10px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 11, color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
            样本 {points.length}
          </span>
        </div>

        {formula && (
          <div style={{ padding: 10, background: 'var(--bg-elevated)', borderRadius: 8, borderLeft: '3px solid var(--primary)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-weak)', marginBottom: 4, fontFamily: 'var(--font-ui)' }}>计算公式</div>
            <code style={{ fontSize: 12, color: 'var(--primary)', fontFamily: 'var(--font-mono)' }}>{formula}</code>
          </div>
        )}

        {children}
      </div>
    </div>
  )
}