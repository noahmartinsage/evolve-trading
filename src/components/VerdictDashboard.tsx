import React from 'react'
import RiskHeader, { RiskLevel } from './RiskHeader'
import EvidencePanel, { EvidenceItem } from './EvidencePanel'

export interface VerdictDashboardProps {
  level: RiskLevel
  score: number
  confidence: number
  summary: string
  evidence: EvidenceItem[]
}

/**
 * 研判模块容器 — 风险等级 + 证据链。
 */
export default function VerdictDashboard({ level, score, confidence, summary, evidence }: VerdictDashboardProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <RiskHeader level={level} score={score} confidence={confidence} summary={summary} />
      <EvidencePanel items={evidence} />
    </div>
  )
}