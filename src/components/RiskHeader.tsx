import React from 'react'

export type RiskLevel = 'safe' | 'watch' | 'warning' | 'critical'

const RISK_META: Record<RiskLevel, { label: string; color: string; icon: string }> = {
  safe: { label: '安全', color: 'var(--down)', icon: '✓' },
  watch: { label: '关注', color: 'var(--primary)', icon: '!' },
  warning: { label: '警告', color: 'var(--warning)', icon: '!!' },
  critical: { label: '危险', color: 'var(--up)', icon: '✕' },
}

export interface RiskHeaderProps {
  level: RiskLevel
  score: number
  confidence: number
  summary: string
}

/**
 * 综合风险等级头部 — 基于审计链 + SLO + 监控 + 对账的综合评分。
 */
export default function RiskHeader({ level, score, confidence, summary }: RiskHeaderProps) {
  const meta = RISK_META[level]

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: 12,
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, borderLeft: `4px solid ${meta.color}`,
      }}
    >
      <div
        style={{
          width: 40, height: 40, borderRadius: '50%',
          background: `${meta.color}20`, border: `2px solid ${meta.color}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, color: meta.color, flexShrink: 0,
        }}
      >
        {meta.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)' }}>综合风险等级</div>
        <div style={{ fontSize: 16, color: meta.color, fontFamily: 'var(--font-ui)', fontWeight: 700 }}>
          {meta.label}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 18, color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>
          {score}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-weak)', fontFamily: 'var(--font-ui)' }}>
          置信度 {(confidence * 100).toFixed(0)}%
        </div>
      </div>
      {summary && (
        <div style={{ flex: 1, minWidth: 0, fontSize: 10, color: 'var(--text-sub)', fontFamily: 'var(--font-ui)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </div>
      )}
    </div>
  )
}