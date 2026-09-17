// SLO 指标采集：全部为真实测量值，无任何模拟/演示数字。
// 度量点对齐 docs/PHASE_C_ARCHITECTURE.md §6 SLO 草案。

const LAT_WINDOW = 500

export interface MetricsSnapshot {
  uptimeSec: number
  ts: number
  orders: {
    acked: number
    rejected: number
    rejectTopReasons: { reason: string; count: number }[]
    ackLatencyMs: { p50: number; p95: number; p99: number; max: number; samples: number }
  }
  fills: { paper: number; live: number }
  cancels: number
  killswitchActivations: number
  feed: { symbol: string; lastBarAgeSec: number | null }[]
  wsClients: number
  events: { memoryCount: number }
  gateway: {
    adapterAttached: boolean
    adapterName: string
    handshakeComplete: boolean
    killswitch: boolean
    queued: number
    processedFills: number
    drainedDuplicates: number
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, idx)]
}

class Metrics {
  private startedAt = Date.now()
  private acked = 0
  private rejected = 0
  private rejectReasons = new Map<string, number>()
  private latencies: number[] = []
  private paperFills = 0
  private liveFills = 0
  private cancels = 0
  private killswitchActivations = 0
  private lastBarTs = new Map<string, number>()

  recordAck(latencyMs: number): void {
    this.acked += 1
    this.latencies.push(Math.max(0, latencyMs))
    if (this.latencies.length > LAT_WINDOW) this.latencies.shift()
  }

  recordRejected(reason: string): void {
    this.rejected += 1
    // 归因到主因（去掉括号里的动态数值），便于聚合
    const key = reason.split(' (')[0].slice(0, 60)
    this.rejectReasons.set(key, (this.rejectReasons.get(key) ?? 0) + 1)
  }

  recordFill(scope: 'paper' | 'live'): void {
    if (scope === 'paper') this.paperFills += 1
    else this.liveFills += 1
  }

  recordCancel(): void {
    this.cancels += 1
  }

  recordKillswitch(): void {
    this.killswitchActivations += 1
  }

  recordBar(symbol: string, barTs: number): void {
    this.lastBarTs.set(symbol, barTs)
  }

  setWsClients(n: number): void {
    this.wsClientCount = n
  }

  private wsClientCount = 0

  snapshot(extra: {
    gateway: MetricsSnapshot['gateway']
    eventMemoryCount: number
  }): MetricsSnapshot {
    const now = Date.now()
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const top = [...this.rejectReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }))
    return {
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      ts: now,
      orders: {
        acked: this.acked,
        rejected: this.rejected,
        rejectTopReasons: top,
        ackLatencyMs: {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.length > 0 ? sorted[sorted.length - 1] : Number.NaN,
          samples: sorted.length,
        },
      },
      fills: { paper: this.paperFills, live: this.liveFills },
      cancels: this.cancels,
      killswitchActivations: this.killswitchActivations,
      feed: [...this.lastBarTs.entries()]
        .map(([symbol, t]) => ({ symbol, lastBarAgeSec: t > 0 ? Math.floor((now - t) / 1000) : null }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      wsClients: this.wsClientCount,
      events: { memoryCount: extra.eventMemoryCount },
      gateway: extra.gateway,
    }
  }

  resetForTest(): void {
    this.startedAt = Date.now()
    this.acked = 0
    this.rejected = 0
    this.rejectReasons.clear()
    this.latencies = []
    this.paperFills = 0
    this.liveFills = 0
    this.cancels = 0
    this.killswitchActivations = 0
    this.lastBarTs.clear()
    this.wsClientCount = 0
  }
}

export const metrics = new Metrics()
