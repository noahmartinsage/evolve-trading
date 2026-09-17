import React, { useMemo } from 'react'

export interface Point {
  t: number
  v: number
}

/**
 * Mini sparkline — 纯 SVG 折线，不引入第三方依赖。
 * 复用 PnlSpark 的绘制思路，支持颜色编码与悬停数值。
 */
export default function KpiTrend({
  points,
  width = 120,
  height = 28,
  color = 'var(--primary)',
  format = (v: number) => String(v),
}: {
  points: Point[]
  width?: number
  height?: number
  color?: string
  format?: (v: number) => string
}) {
  const path = useMemo(() => {
    if (points.length < 2) return ''
    const min = Math.min(...points.map((p) => p.v))
    const max = Math.max(...points.map((p) => p.v))
    const range = max - min || 1
    const pad = 2
    const stepX = (width - pad * 2) / (points.length - 1)
    return points
      .map((p, i) => {
        const x = pad + i * stepX
        const y = height - pad - ((p.v - min) / range) * (height - pad * 2)
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }, [points, width, height])

  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  const up = last && prev ? last.v >= prev.v : false

  if (points.length < 2) {
    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <text x={width / 2} y={height / 2 + 3} textAnchor="middle" fill="var(--text-weak)" fontSize={9}>
          暂无数据
        </text>
      </svg>
    )
  }

  return (
    <svg width={width} height={height} style={{ display: 'block' }} viewBox={`0 0 ${width} ${height}`}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width - 2} cy={height - 2 - ((last.v - Math.min(...points.map((p) => p.v))) / (Math.max(...points.map((p) => p.v)) - Math.min(...points.map((p) => p.v)) || 1)) * (height - 4)} r={2} fill={color} />
      <title>{`${format(last.v)} · ${up ? '↑' : '↓'}`}</title>
    </svg>
  )
}