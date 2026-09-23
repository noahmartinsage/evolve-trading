import type { MetricsSnapshot } from './metrics.ts'
import { appendEvent } from './ledger.ts'
import { postJson } from './net/egress.ts'

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

/**
 * 上一次告警外发的结果。
 *
 * ★ 为什么必须让它**可读**，而不是只写一行 `console.error`：
 *   告警通道坏掉之后，外表与"系统一直很健康"完全一样 —— 两种情形都是
 *   "没有任何告警弹出来"。这个读数就是用来把这两者分开的（判据 10：谁在读它）。
 */
export type WebhookOutcome = 'not-configured' | 'sent' | 'blocked' | 'failed'

export interface SloEvaluation {
  ts: number
  breaches: SloBreach[]
  values: Record<string, number>
  /**
   * 告警外发的最近一次结果。**只在 `checkAndAlert` 里有值** ——
   * `evaluateSlo` 只算不告警，它没有"发出去没有"这件事可说。
   */
  alertWebhook?: AlertWebhookState
}

export interface AlertWebhookState {
  at: number
  outcome: WebhookOutcome
  host: string
  /** 可念的一句话（失败原因在里面）。 */
  note: string
}

let lastWebhook: AlertWebhookState | null = null

/** 读最近一次告警外发的结果（仪表盘与门禁都用它，不靠日志）。 */
export function lastAlertWebhook(): AlertWebhookState | null {
  return lastWebhook
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

/**
 * 把一次告警送到 webhook。
 *
 * ── 它现在走**受控出网通道**（`postJson`），不再直连 `fetch` ──────────
 * 理由见 `server/net/egress.ts` 的 `postJson`：目标域由 `ALERT_WEBHOOK_URL`
 * 决定，也就是**一个没登记过、也没校验过的任意主机**，而它送出去的是
 * **系统内部事件**（SLO 违约细节、权益、订单拒绝率）。这是本仓库里唯一一类
 * 把内部数据送出去的通道，所以它和"联网查资料"共用同一套三层判据。
 *
 * ── 两个刻意的行为 ────────────────────────────────────────────────────
 *   ① **仍然不阻断**：告警发不出去不该让 SLO 评估失败（评估本身是有效的观测）。
 *   ② **但必须说出来**：原来这里是一个空 `catch`，于是"被白名单拦下"
 *      与"网络不通"这两种**指向相反动作**的情形都没有任何记录。
 *      现在：结果进账本、上一次的结果可读、且被拦时**大声**说一句。
 */
async function sendWebhook(breaches: SloBreach[]): Promise<void> {
  const hook = process.env.ALERT_WEBHOOK_URL
  let state: AlertWebhookState
  if (!hook) {
    state = { at: Date.now(), outcome: 'not-configured', host: '', note: '没有配置 ALERT_WEBHOOK_URL，告警只写到账本与控制台。' }
  } else {
    const r = await postJson(hook, { type: 'slo_breach', ts: Date.now(), breaches }, { timeoutMs: 5_000 })
    if (r.ok) {
      state = { at: Date.now(), outcome: 'sent', host: r.host, note: r.note }
    } else {
      // ★ 「被白名单拦下」与「发不出去」**分开说**：前者要人改配置，后者要人查网络。
      //   合成一句"发送失败"，用户会去查网络，而真正该做的是把域名加进 EV_EGRESS_HOSTS。
      const blocked = r.reason === 'HOST_NOT_ALLOWED' || r.reason === 'PRIVATE_ADDRESS' || r.reason === 'SCHEME_NOT_ALLOWED'
      state = {
        at: Date.now(),
        outcome: blocked ? 'blocked' : 'failed',
        host: r.host,
        note: blocked
          ? `告警 webhook 被出网白名单拦下了（${r.note}）。要放行请把 ${r.host} 加进 EV_EGRESS_HOSTS`
          : `告警 webhook 没发出去：${r.note}`,
      }
      console.error(`[ALERT] ${state.note}`)
    }
  }
  lastWebhook = state
  // ★ 三种结局**每一种**都要落盘，包括"没配"。
  //   起初 `not-configured` 是直接 return 的（不落盘），于是它成了唯一不留痕的一种 ——
  //   而它恰恰是最要紧的一种：没配 webhook 意味着**所有告警都只在控制台里**，
  //   进程一停就什么都不剩，事后翻账本会看到"什么都没有"，与"系统一直很健康"
  //   完全一样。频次由 `SLO_BREACH` 的冷却（每条 key 10 分钟）天然兜住。
  appendEvent('SLO_ALERT_WEBHOOK', { outcome: state.outcome, host: state.host, note: state.note.slice(0, 200) })
}

export async function checkAndAlert(snap: MetricsSnapshot): Promise<SloEvaluation> {
  const evaluation = evaluateSlo(snap)
  if (evaluation.breaches.length === 0) return evaluation

  const now = Date.now()
  const fresh = evaluation.breaches.filter((b) => now - (lastAlertAt.get(b.key) ?? 0) > alertCooldownMs)
  if (fresh.length === 0) return { ...evaluation, ...(lastWebhook ? { alertWebhook: lastWebhook } : {}) }

  for (const b of fresh) lastAlertAt.set(b.key, now)
  appendEvent('SLO_BREACH', { breaches: fresh, values: evaluation.values })
  console.error(`[ALERT] SLO 违约: ${fresh.map((b) => `${b.label}=${b.value}${b.unit} (limit ${b.limit})`).join('; ')}`)
  // ★ 这里是 `await`，不是最初的 `void` —— 那是个真缺陷，不是风格问题：
  //   `void` 之后紧接着读 `lastWebhook`，读到的是**上一次**外发的结果。
  //   于是返回体里的 `alertWebhook` 永远慢一拍，而**第一次**告警时它干脆是
  //   `undefined` —— 读的人会得出"这条通道没被用过"的结论，恰恰在最需要它的那一刻。
  //   上界由 `postJson` 的 AbortController（5 秒）兜住，不会无限期挂住调用方。
  await sendWebhook(fresh)
  return { ...evaluation, ...(lastWebhook ? { alertWebhook: lastWebhook } : {}) }
}
