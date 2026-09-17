/**
 * 决策证据可观测性分档（内化 R20 `classify_snapshot_observability` 范式）
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────
 * 「我们有决策日志」和「我们的决策日志能用来复盘」是两件不同的事。
 * 一条决策记录里带上 20 个字段、其中 18 个是 `null`，在仪表盘上看着很充实，
 * 但事后根本无法回答「当时为什么这么判」。这种记录会静默污染自进化样本：
 * LLM 复盘时把空壳当作证据，从噪声里总结出「心法」。
 *
 * R20 的做法是不让模型自己去数证据，而是**在写入时就打好分档标签**：
 * 逐条按「动力学字段的真实非空计数」分成四档，并在复盘简报里显式声明
 * 「完全可观测 N 笔 / 部分 M 笔 / 仅价格 P 笔 / 无快照 Q 笔」。
 * 样本质量因此变成可度量、可设门槛的量，而不是感觉。
 *
 * ── 本项目的字段选择 ────────────────────────────────────────────────
 * `DYNAMICS_FIELDS` 只收「解释价格为什么这样动」的字段（ATR / ADX / 结构位 /
 * 动能），**不收** price / symbol 这类普通观测。理由是 R20 的同一条判断：
 * 价格本身不算动力学链——只知道价格、不知道波动与趋势强度，无法归因。
 */

/** 动力学字段：解释「价格为何这样动」的那一组。 */
export const DYNAMICS_FIELDS = [
  'atr1h',
  'atr4h',
  'adx1h',
  'macroTrend',
  'h1SwingHigh',
  'h1SwingLow',
  'velocity',
  'accel',
  'curvature',
  'fundingRate',
  'openInterest',
  'volumeZ',
] as const

export type DynamicsField = (typeof DYNAMICS_FIELDS)[number]

/** 达到「完全可观测」所需的最少非空动力学字段数。 */
export const DYNAMICS_OBSERVED_MIN = 4

/** 四档可观测性标签。 */
export type Observability = 'DYNAMICS_OBSERVED' | 'PARTIAL' | 'PRICE_ONLY' | 'NONE'

export const OBSERVABILITY_ORDER: Observability[] = ['DYNAMICS_OBSERVED', 'PARTIAL', 'PRICE_ONLY', 'NONE']

/** 中文标签，供 UI 与管理页展示。 */
export const OBSERVABILITY_LABEL: Record<Observability, string> = {
  DYNAMICS_OBSERVED: '完全可观测',
  PARTIAL: '部分可观测',
  PRICE_ONLY: '仅价格',
  NONE: '无快照',
}

export const OBSERVABILITY_HINT: Record<Observability, string> = {
  DYNAMICS_OBSERVED: '动力学链完整，可用于归因与心法提炼',
  PARTIAL: '有部分动力学字段，归因结论需谨慎',
  PRICE_ONLY: '只有价格等普通观测，无法回答「为什么」',
  NONE: '无任何快照，不可归因',
}

/**
 * 逐条分类快照可观测性。
 *
 * 只按 `DYNAMICS_FIELDS` 的**真实非空**计数判定。全 null 的空壳不是「有快照」——
 * 这正是要杜绝的「表面可观测、实际不可归因」。
 */
export function classifySnapshotObservability(snap: unknown): Observability {
  if (!snap || typeof snap !== 'object') return 'NONE'
  const obj = snap as Record<string, unknown>
  if (Object.keys(obj).length === 0) return 'NONE'
  let n = 0
  for (const k of DYNAMICS_FIELDS) {
    const v = obj[k]
    // null / undefined / NaN / 空串 都算缺失；0 和 false 算有效值
    if (v === null || v === undefined) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    if (typeof v === 'string' && v.trim() === '') continue
    n++
  }
  if (n === 0) return 'PRICE_ONLY'
  if (n >= DYNAMICS_OBSERVED_MIN) return 'DYNAMICS_OBSERVED'
  return 'PARTIAL'
}

/**
 * 剔除值为 null / undefined 的字段。
 *
 * 可观测性由 `snapshotObservability` 标签承载，不再让模型在 22 个 null 里
 * 自行数证据——既省 token，也避免模型把「字段存在」误读成「证据存在」。
 * 返回 null 表示剔除后已无任何内容（调用方应据此写 null，而不是写空对象）。
 */
export function pruneSnapshot<T extends Record<string, unknown>>(snap: T | null | undefined): Partial<T> | null {
  if (!snap || typeof snap !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snap)) {
    if (v === null || v === undefined) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? (out as Partial<T>) : null
}

export interface ObservabilityAudit {
  total: number
  DYNAMICS_OBSERVED: number
  PARTIAL: number
  PRICE_ONLY: number
  NONE: number
  /** 可用于数理归因的样本数（完全 + 部分）。 */
  mathObservable: number
  /** 可用于数理归因的样本占比。 */
  mathObservableRatio: number
}

/**
 * 汇总一批已结束决策的可观测性。
 *
 * `mathObservableRatio` 是给自进化用的**样本质量闸门**：当它过低时，
 * 进化引擎应当拒绝从这批样本提炼心法（见 evolutionShield 的样本量门槛），
 * 否则就是把噪声固化成规则。
 */
export function auditSnapshotObservability(records: Array<Record<string, unknown>>): ObservabilityAudit {
  const counts: ObservabilityAudit = {
    total: records.length,
    DYNAMICS_OBSERVED: 0,
    PARTIAL: 0,
    PRICE_ONLY: 0,
    NONE: 0,
    mathObservable: 0,
    mathObservableRatio: 0,
  }
  for (const r of records) {
    // 优先读已打好的标签；缺失或非法时现场重算，保证历史数据也能被审计
    const raw = r.snapshotObservability
    const tag: Observability =
      typeof raw === 'string' && (OBSERVABILITY_ORDER as string[]).includes(raw)
        ? (raw as Observability)
        : classifySnapshotObservability(r.snapshot)
    counts[tag] += 1
  }
  counts.mathObservable = counts.DYNAMICS_OBSERVED + counts.PARTIAL
  counts.mathObservableRatio = counts.total > 0 ? Number((counts.mathObservable / counts.total).toFixed(4)) : 0
  return counts
}

/** 中文简报，直接进复盘提示词或仪表盘。 */
export function renderObservabilityBrief(audit: ObservabilityAudit): string {
  return (
    `已结束 ${audit.total} 笔｜开仓时刻数理快照：` +
    `完全可观测 ${audit.DYNAMICS_OBSERVED} / 部分可观测 ${audit.PARTIAL} / ` +
    `仅价格与普通观测 ${audit.PRICE_ONLY} / 无快照 ${audit.NONE}` +
    `（可用于数理归因 ${audit.mathObservable} 笔，占比 ${(audit.mathObservableRatio * 100).toFixed(1)}%）`
  )
}

/**
 * 样本质量是否足以支撑心法提炼。
 *
 * 两条同时满足才放行：样本总量足够，且可归因占比达到门槛。
 * 只有数量没有质量（大量 PRICE_ONLY 空壳）同样会产出噪声心法。
 */
export function isSampleQualitySufficient(
  audit: ObservabilityAudit,
  opts: { minSamples?: number; minMathObservableRatio?: number } = {},
): { ok: boolean; reason: string } {
  const minSamples = opts.minSamples ?? 20
  const minRatio = opts.minMathObservableRatio ?? 0.5
  if (audit.total < minSamples) {
    return { ok: false, reason: `样本量不足：${audit.total} < ${minSamples} 笔` }
  }
  if (audit.mathObservableRatio < minRatio) {
    return {
      ok: false,
      reason:
        `可归因样本占比不足：${(audit.mathObservableRatio * 100).toFixed(1)}% < ${(minRatio * 100).toFixed(0)}%` +
        `（仅价格/无快照共 ${audit.PRICE_ONLY + audit.NONE} 笔，归因结论会建立在噪声上）`,
    }
  }
  return { ok: true, reason: '样本质量达标' }
}
