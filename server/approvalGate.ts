/**
 * 人类在环审批闸门 —— 「可信执行」的最后一道。
 *
 * ══ 它解决什么问题 ═══════════════════════════════════════════════════
 * 2026-09 的情报给出了一个非常具体的结论（DELCOS 实测，2,089 次 agent 购物会话
 * 只有 2.2% 完成了实际支付），并把它命名为 agentic commerce 的**真实失败模式**：
 *
 *   「不是欺诈购买，而是**用户在没注意时、由 agent 做出的看似合理的误购**。」
 *
 * 请注意这个失败模式的性质：它不触发任何传统风控。金额合法、方向合理、
 * 风控阈值全过——错的只是「没人在场同意」。传统风控是按人类尺度校准的
 * （小额、低频、需要人签字），而自主 agent 是高频、小额、无人签字。
 * 两个尺度对不上，于是中间那一块**没有任何一道闸门在看**。
 *
 * 本模块就是补上那一块：**自主决策可以继续，但实盘资金动作要有人点头。**
 *
 * ══ 四条语义（每一条都对应一个具体的事故形态） ═══════════════════════
 *
 * ① **代码不能自己批自己。**
 *    `decide()` 拒绝 `auto:*` 作为**实盘**动作的审批人。
 *    这条防的是「闸门被自己绕过」——一个能自我批准的闸门等于没有闸门。
 *    （paper 环境不在此列：那里没有资金可失，自动放行记录的是「事实」而非「授权」。）
 *
 * ② **批准是一次性的。**
 *    放行后立即 `consumedAt`，同一张批准不能放行第二次动作。
 *    且 `dedupeKey` 绑定具体意图 —— 防的是「批了一次，从此这个阈值以下全放行」。
 *
 * ③ **过期即失效，且不可补批。**
 *    陈旧审批比没有审批更危险：它放行的是一个早已不成立的市场前提。
 *    所以 `gate()` 每次都先扫过期，绝不「因为曾经批过」就放过。
 *
 * ④ **未知类型默认需要审批。**
 *    未登记的 kind 不是「不需要审批」，而是**必须审批**。
 *    白名单漏项的方向必须是「更严」，不能是「更松」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './atomicWrite.ts'
import { APPROVAL_THRESHOLD_USDT, APPROVAL_TTL_MINUTES } from './riskConstants.ts'

export type ApprovalEnvironment = 'paper' | 'live'

export type ApprovalKind =
  | 'live_order'
  | 'live_close'
  | 'bridge_transfer'
  | 'venue_outbound_enable'
  | 'policy_restore'
  | 'counterparty_quarantine'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * 结构性动作：**不看金额一律需要审批**。
 *
 * 判据是「这个动作会不会改变系统的能力边界」，而不是「它涉及多少钱」：
 * 一次开通出站、一次策略回滚、一次跨链桥接，金额可能很小，
 * 但它们改变的是**后续所有动作的可行集**——这种动作不该由金额阈值来把关。
 */
export const ALWAYS_APPROVAL_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  'bridge_transfer',
  'venue_outbound_enable',
  'policy_restore',
  'counterparty_quarantine',
])

/**
 * 已登记的审批类型全集。
 *
 * 它存在的唯一目的是让 `requiresApproval` 能识别「**不在**这个集合里的 kind」——
 * 那说明调用方传了一个拼错或新增的类型，此时必须落到「更严」的一侧（需要审批），
 * 而不是因为白名单里没有就认为「不需要」。
 */
const APPROVAL_KINDS: ReadonlyArray<ApprovalKind> = [
  'live_order',
  'live_close',
  'bridge_transfer',
  'venue_outbound_enable',
  'policy_restore',
  'counterparty_quarantine',
]

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  environment: ApprovalEnvironment
  amountUsdt: number
  /** 绑定到具体意图的幂等键。同一 key 的重复请求会复用同一条待批记录。 */
  dedupeKey: string
  /** 中文一句话摘要，直接展示在待批列表里。 */
  summary: string
  detail: Record<string, unknown>
  status: ApprovalStatus
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: string | null
  decisionNote: string | null
  /** 一次性消费时间。非 null 表示这张批准已经用掉了。 */
  consumedAt: string | null
  consumedBy: string | null
}

export interface GateResult {
  /** 本次动作能否放行。 */
  allowed: boolean
  /** 需要审批时返回待批记录的 id（供 UI 跳转）。 */
  approvalId: string | null
  /** 是否需要人工审批（false 表示该动作免审批）。 */
  approvalRequired: boolean
  reason: string
}

/** 审批是否必需。故意做成显式函数，好让调用方在**发起动作之前**就能问清楚。 */
export function requiresApproval(
  kind: ApprovalKind,
  environment: ApprovalEnvironment,
  amountUsdt: number,
): { required: boolean; reason: string } {
  if (environment === 'paper') {
    return { required: false, reason: 'paper 环境不出真实资金，免审批（仍会留痕）。' }
  }
  if (ALWAYS_APPROVAL_KINDS.has(kind)) {
    return { required: true, reason: `「${kind}」会改变后续动作的可行集，不看金额一律需要人工审批。` }
  }
  if (!APPROVAL_KINDS.includes(kind)) {
    // 未知类型默认更严（见文件头语义 ④）
    return { required: true, reason: `未登记的审批类型「${String(kind)}」，按保守默认处理：需要人工审批。` }
  }
  if (amountUsdt >= APPROVAL_THRESHOLD_USDT) {
    return { required: true, reason: `实盘金额 ${amountUsdt} USDT 达到审批门槛 ${APPROVAL_THRESHOLD_USDT} USDT。` }
  }
  return { required: false, reason: `实盘金额 ${amountUsdt} USDT 低于审批门槛 ${APPROVAL_THRESHOLD_USDT} USDT。` }
}

export class ApprovalGate {
  private readonly path: string
  private requests = new Map<string, ApprovalRequest>()

  constructor(path: string) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { requests?: ApprovalRequest[] }
      for (const r of raw.requests ?? []) {
        if (!r?.id) continue
        this.requests.set(r.id, r)
      }
    } catch {
      // 解析失败保持空队列：空队列的后果是「所有实盘动作都要重新报批」，
      // 偏严的一侧 —— 这正是我们希望的失败方向。
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, { format: 'evolve.approval-gate', version: 1, requests: [...this.requests.values()] })
  }

  list(filter: { status?: ApprovalStatus; environment?: ApprovalEnvironment } = {}): ApprovalRequest[] {
    return [...this.requests.values()]
      .filter((r) => (filter.status === undefined || r.status === filter.status) &&
        (filter.environment === undefined || r.environment === filter.environment))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
  }

  get(id: string): ApprovalRequest | null {
    return this.requests.get(id) ?? null
  }

  /**
   * 扫描并标记过期。**幂等**：重复调用不产生额外副作用。
   * 每次都先扫过期，是为保证「过期审批绝不放行任何动作」这个不变量，
   * 而不依赖有人记得手动清理。
   */
  expireStale(now: Date = new Date()): { expired: string[] } {
    const expired: string[] = []
    for (const r of this.requests.values()) {
      if (r.status !== 'pending') continue
      if (new Date(r.expiresAt).getTime() <= now.getTime()) {
        r.status = 'expired'
        r.decidedAt = now.toISOString()
        r.decidedBy = 'system:ttl'
        r.decisionNote = '超过有效期仍未被处理，自动失效（不可补批）。'
        expired.push(r.id)
      }
    }
    if (expired.length > 0) this.persist()
    return { expired }
  }

  /**
   * 提交一个待批请求。同一 `dedupeKey` 的重复提交**复用**已有待批记录 ——
   * 不幂等的话，一个卡在循环里的自主流程会把队列刷满，
   * 而人面对 200 条同样的请求时只会批量点「通过」—— 闸门就此失效。
   */
  submit(input: {
    kind: ApprovalKind
    environment: ApprovalEnvironment
    amountUsdt: number
    dedupeKey: string
    summary: string
    detail?: Record<string, unknown>
    now?: Date
  }): { ok: boolean; request: ApprovalRequest | null; reused: boolean; reason: string } {
    const now = input.now ?? new Date()
    this.expireStale(now)

    const existing = [...this.requests.values()].find(
      (r) => r.dedupeKey === input.dedupeKey && r.environment === input.environment && r.status === 'pending',
    )
    if (existing) {
      return { ok: true, request: existing, reused: true, reason: `已有同键待批记录 ${existing.id}，复用而不重复排队。` }
    }

    const ttlMs = APPROVAL_TTL_MINUTES * 60_000
    const req: ApprovalRequest = {
      id: `apr-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind: input.kind,
      environment: input.environment,
      amountUsdt: input.amountUsdt,
      dedupeKey: input.dedupeKey,
      summary: input.summary,
      detail: input.detail ?? {},
      status: 'pending',
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      consumedAt: null,
      consumedBy: null,
    }
    this.requests.set(req.id, req)
    this.persist()
    return { ok: true, request: req, reused: false, reason: `已提交待批 ${req.id}，在 ${new Date(req.expiresAt).toISOString()} 前有效。` }
  }

  /**
   * 人工裁决。
   *
   * **实盘动作拒绝 `auto:*` 审批人**（见文件头语义 ①）——
   * 「人类在环」这四个字如果允许由代码来满足，那它就不是人类在环。
   */
  decide(
    id: string,
    decision: 'approved' | 'denied',
    by: string,
    note = '',
    now: Date = new Date(),
  ): { ok: boolean; request: ApprovalRequest | null; reason: string } {
    const req = this.requests.get(id)
    if (!req) return { ok: false, request: null, reason: `审批请求 ${id} 不存在。` }

    if (req.status !== 'pending') {
      return { ok: false, request: req, reason: `请求 ${id} 已处于 ${req.status}，不可再次裁决（终态不可复活）。` }
    }
    if (new Date(req.expiresAt).getTime() <= now.getTime()) {
      this.expireStale(now)
      return { ok: false, request: this.requests.get(id) ?? req, reason: `请求 ${id} 已过期，不接受补批。` }
    }
    if (!by || !by.trim()) {
      return { ok: false, request: req, reason: '裁决必须署名（by）——无人署名的批准无法在被追责时定位到人。' }
    }
    if (req.environment === 'live' && by.startsWith('auto:')) {
      return {
        ok: false,
        request: req,
        reason:
          `实盘动作不接受 auto:* 署名（收到「${by}」）。代码不能自己批自己 —— ` +
          '一个可自我批准的闸门等价于没有闸门。请由具体的人或带署名的流程裁决。',
      }
    }

    req.status = decision
    req.decidedAt = now.toISOString()
    req.decidedBy = by
    req.decisionNote = note
    this.persist()
    return { ok: true, request: req, reason: `请求 ${id} → ${decision}（by ${by}）。` }
  }

  /**
   * 闸门。**这是执行链路唯一该调用的入口** —— 不要直接读 `requests` 判断。
   *
   * 行为：
   *   1. 先扫过期；
   *   2. 若免审批 → 直接放行（paper 场景）；
   *   3. 若需审批 → 找同 `dedupeKey` 的「已批准且未消费」记录；
   *      找到 → 消费它并放行；找不到 → 建一条待批记录并拒绝。
   */
  gate(input: {
    kind: ApprovalKind
    environment: ApprovalEnvironment
    amountUsdt: number
    dedupeKey: string
    summary: string
    detail?: Record<string, unknown>
    actor?: string
    now?: Date
  }): GateResult {
    const now = input.now ?? new Date()
    this.expireStale(now)

    const need = requiresApproval(input.kind, input.environment, input.amountUsdt)
    if (!need.required) {
      return { allowed: true, approvalId: null, approvalRequired: false, reason: need.reason }
    }

    const approved = [...this.requests.values()].find(
      (r) =>
        r.dedupeKey === input.dedupeKey &&
        r.environment === input.environment &&
        r.status === 'approved' &&
        r.consumedAt === null,
    )
    if (approved) {
      // 一次性消费：放行即作废这张批准
      approved.consumedAt = now.toISOString()
      approved.consumedBy = input.actor ?? 'autopilot'
      this.persist()
      return {
        allowed: true,
        approvalId: approved.id,
        approvalRequired: true,
        reason: `已消费人工批准 ${approved.id}（by ${approved.decidedBy}），本次动作放行；该批准已用尽，不可再次使用。`,
      }
    }

    const submitted = this.submit({ ...input, now })
    const pendingHint = submitted.reused
      ? `已有待批记录 ${submitted.request?.id} 等待人工裁决`
      : `已提交待批记录 ${submitted.request?.id}，等待人工裁决`
    return {
      allowed: false,
      approvalId: submitted.request?.id ?? null,
      approvalRequired: true,
      reason: `${need.reason}${pendingHint}。审批通过后本动作可放行一次。`,
    }
  }

  summary(): { pending: number; approvedUnconsumed: number; expired: number; denied: number } {
    const list = [...this.requests.values()]
    return {
      pending: list.filter((r) => r.status === 'pending').length,
      approvedUnconsumed: list.filter((r) => r.status === 'approved' && r.consumedAt === null).length,
      expired: list.filter((r) => r.status === 'expired').length,
      denied: list.filter((r) => r.status === 'denied').length,
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 进程级单例
// ─────────────────────────────────────────────────────────────

let singleton: ApprovalGate | null = null

export function getApprovalGate(): ApprovalGate {
  if (!singleton) {
    singleton = new ApprovalGate(process.env.EV_APPROVAL_DB ?? 'data/approval_gate.json')
  }
  return singleton
}

export function setApprovalGate(g: ApprovalGate | null): void {
  singleton = g
}
