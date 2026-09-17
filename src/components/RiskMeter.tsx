import React, { useMemo } from 'react'

export interface RiskMeterProps {
  used: number
  cap: number
  label?: string
  size?: number
}

/**
 * 环形风险利用率仪表盘 — 显示 used/cap 比例。
 * 90% 以下绿色、90-95% 黄色、95%+ 红色。
 */
export default function RiskMeter({ used, cap, label = '风险利用率', size = 120 }: RiskMeterProps) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const color = useMemo(() => {
    if (pct >= 95) return 'var(--up)'
    if (pct >= 90) return 'var(--warning)'
    return 'var(--down)'
  }, [pct])

  const r = size / 2 - 8
  const circumference = 2 * Math.PI * r
  const dash = (pct / 100) * circumference
  const gap = circumference - dash

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke="var(--bg-elevated)" strokeWidth={6}
          />
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={color} strokeWidth={6}
            strokeDasharray={`${dash} ${gap}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.4s, stroke 0.3s' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: size * 0.28, fontWeight: 800, color: 'var(--text-main)', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
            {pct.toFixed(0)}%
          </span>
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)', textAlign: 'center' }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-sub)', fontFamily: 'var(--font-mono)' }}>
        ${used.toFixed(2)} / ${cap.toFixed(2)}
      </div>
    </div>
  )
}