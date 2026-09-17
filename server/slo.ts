import type { MetricsSnapshot } from './metrics.ts'
import { appendEvent } from './ledger.ts'

export interface SloTarget {
  key: string
  label: string
  compare: 'lte' | 'gte'
  limit: number
  unit: string
}

export const SLO_TARGETS: SloTarget[] = [
  { key: 'ackP99Ms', label: '订单 ACK P99', compare: 'lte', limit: 300, unit: 'ms' },
  { key: 'feedStalenessSec', label: '行情新鲜度（最旧 bar）', compare: 'lte', limit: 120, unit: 's' },
  { key: 'rejectRatioPct', label: '订单拒绝率', compare: 'lte', limit: 50, unit: '%' },
]

export interface SloBreach {
  key: string
  label: string
  value: number
  limit: number
  unit: string
}

export interface SloEvaluation {
  ts: number
  breaches: SloBreach[]
  values: Record<string, number>
}

const alertCooldownMs = 10 * 60 * 1000
const lastAlertAt = new Map<string, number>()

function extractValues(snap: MetricsSnapshot): Record<string, number> {
  const feedWorst = snap.feed.reduce<number>((worst, f) => (f.lastBarAgeSec !== null ? Math.max(worst, f.lastBarAgeSec) : worst), 0)
  const totalOrders = snap.orders.acked + snap.orders.rejected
  return {
    ackP99Ms: snap.orders.ackLatencyMs.p99,
    feedStalenessSec: feedWorst,
    rejectRatioPct: totalOrders > 0 ? Math.round((snap.orders.rejected / totalOrders) * 1000) / 10 : 0,
  }
}

export function evaluateSlo(snap: MetricsSnapshot): SloEvaluation {
  const values = extractValues(snap)
  const breaches: SloBreach[] = []
  for (const t of SLO_TARGETS) {
    const v = values[t.key]
    if (!Number.isFinite(v)) continue
    if (t.compare === 'lte' && v > t.limit) breaches.push({ key: t.key, label: t.label, value: v, limit: t.limit, unit: t.unit })
    if (t.compare === 'gte' && v < t.limit) breaches.push({ key: t.key, label: t.label, value: v, limit: t.limit, unit: t.unit })
  }
  return { ts: Date.now(), breaches, values }
}

async function sendWebhook(breaches: SloBreach[]): Promise<void> {
  const hook = process.env.ALERT_WEBHOOK_URL
  if (!hook) return
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'slo_breach', ts: Date.now(), breaches }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    /* 告警通道失败不阻断 */
  }
}

export async function checkAndAlert(snap: MetricsSnapshot): Promise<SloEvaluation> {
  const evaluation = evaluateSlo(snap)
  if (evaluation.breaches.length === 0) return evaluation

  const now = Date.now()
  const fresh = evaluation.breaches.filter((b) => now - (lastAlertAt.get(b.key) ?? 0) > alertCooldownMs)
  if (fresh.length === 0) return evaluation

  for (const b of fresh) lastAlertAt.set(b.key, now)
  appendEvent('SLO_BREACH', { breaches: fresh, values: evaluation.values })
  console.error(`[ALERT] SLO 违约: ${fresh.map((b) => `${b.label}=${b.value}${b.unit} (limit ${b.limit})`).join('; ')}`)
  void sendWebhook(fresh)
  return evaluation
}
