/**
 * 模型分层路由 —— 贵 / 免费分层 + 智能降级（内化自 2026-09-14 日报第 ⑤ 条 OmniRoute）。
 *
 * 日报的原话是「统一接入多厂商、智能降级、贵免费分层」。落到 EVOLVE 上，
 * 要解决的是一件具体的事：**决策大脑里不同环节愿意为智能付的钱差很多**。
 *   · 规划类（策略提案、复盘心法提炼）—— 值得用贵模型
 *   · 机械类（结构化抽取、格式化、摘要）—— 免费模型足够，用贵的纯属浪费
 *   · 探测类（连通性、模型列表）—— 必须永远免费，它是"还能不能用"的探针
 *
 * ── 本模块最看重的一条设计：**未识别的模型按付费处理** ──────────────
 * "免费"的判定天然是启发式的：模型名五花八门（`:free` 后缀、`-free` 后缀、
 * 厂商自定的额度套餐……），任何白名单都会漏。而漏判的两个方向代价完全不对称：
 *   · 把付费误判成免费 → 静默烧钱，等到账单出来才发现
 *   · 把免费误判成付费 → 少用了一个便宜档位，只是不够省
 * 所以默认取**保守侧**：认不出就当付费。付费需要显式开关（`EV_LLM_ALLOW_PAID`），
 * 默认关闭 —— 与项目「风控默认拒绝」的哲学一致。
 *
 * ── 降级链为什么要落审计 ────────────────────────────────────────────
 * "这次用了哪个模型"直接决定产出的可信度。若降级是静默的，
 * 事后看到一份质量下降的策略提案，无法区分是"策略本身不成熟"
 * 还是"其实跑在降级后的免费模型上"。所以每次路由都留痕。
 */

import { appendEvent } from './ledger.ts'
import { getActiveLlm } from './llmProviders.ts'
import type { ActiveLlm } from './llmProviders.ts'

export type ModelTier = 'plan' | 'execute' | 'probe'

export const MODEL_TIERS: { id: ModelTier; label: string; desc: string }[] = [
  { id: 'plan', label: '规划', desc: '策略提案、复盘心法提炼等需要强推理的环节。' },
  { id: 'execute', label: '执行', desc: '结构化抽取、格式化、摘要等机械环节，免费模型足够。' },
  { id: 'probe', label: '探测', desc: '连通性与能力探测。永远不占用付费额度。' },
]

/**
 * 「免费」判定：保守启发式。认不出即为付费。
 *
 * 为什么不做白名单：模型名由各厂商自由命名，白名单漏一个就等于把它当付费
 * （安全但白费一个档位）；而**反向**错误（把付费当免费）会静默烧钱。
 * 一个只认显式免费标记的规则，两个方向的错误都落在"安全"那一侧。
 */
export function isFreeModel(modelName: string): boolean {
  const m = modelName.toLowerCase()
  return m.includes('free') || m.includes('local') || m.endsWith(':0')
}

/** 路由结果的一次尝试。 */
export interface RouteAttempt {
  model: string
  free: boolean
  ok: boolean
  reason?: string
  latencyMs: number
}

export interface RouteResult {
  ok: boolean
  tier: ModelTier
  model: string | null
  text: string | null
  attempts: RouteAttempt[]
  /** 是否发生了降级（首个候选未成功）。 */
  degraded: boolean
  reason: string
}

/** 每小时允许的付费调用次数上限。0 = 完全禁止付费（默认）。 */
function paidHourlyCap(): number {
  const v = Number(process.env.EV_LLM_PAID_HOURLY_CAP ?? 0)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

function allowPaid(): boolean {
  return (process.env.EV_LLM_ALLOW_PAID ?? '0') === '1'
}

/** 环境变量里配置的候选模型链（逗号分隔）。未配置时返回空数组。 */
function configuredModels(tier: ModelTier): string[] {
  const key = `EV_LLM_TIER_${tier.toUpperCase()}_MODELS`
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ── 付费额度计时窗口（滚动 1 小时）────────────────────────────────
let paidWindow: number[] = []

/** 记录一次付费调用。 */
function notePaidCall(now: number): void {
  paidWindow = paidWindow.filter((t) => now - t < 3_600_000)
  paidWindow.push(now)
}

function paidUsedInWindow(now: number): number {
  paidWindow = paidWindow.filter((t) => now - t < 3_600_000)
  return paidWindow.length
}

/** 仅供测试/运维读取的额度快照。 */
export function paidQuotaSnapshot(now = Date.now()): { used: number; cap: number; allowed: boolean } {
  return { used: paidUsedInWindow(now), cap: paidHourlyCap(), allowed: allowPaid() }
}

/** 测试用：重置额度窗口（生产代码不应调用）。 */
export function __resetPaidWindowForTest(): void {
  paidWindow = []
}

export interface RouterDeps {
  provider: ActiveLlm | null
  /** 注入的调用实现。生产为 llmProviders.chatComplete；测试注入桩。 */
  call: (active: ActiveLlm, systemPrompt: string, userPrompt: string, temperature: number) => Promise<string | null>
  now: () => number
}

function defaultDeps(): RouterDeps {
  return {
    provider: getActiveLlm(),
    call: async (active, systemPrompt, userPrompt, temperature) => {
      const mod = await import('./llmProviders.ts')
      return mod.chatComplete(active, systemPrompt, userPrompt, temperature)
    },
    now: () => Date.now(),
  }
}

/**
 * 按层级路由一次对话调用。
 *
 * 候选顺序 = 「该层配置的模型链」→「厂商当前激活模型（兜底）」。
 * 逐个尝试，第一个成功即返回；全部失败返回 ok:false 并把每次尝试都带回去 ——
 * **失败也要返回完整尝试链**，否则"为什么没成功"只能靠猜。
 */
export async function routeChat(
  tier: ModelTier,
  systemPrompt: string,
  userPrompt: string,
  temperature = 0.7,
  deps: Partial<RouterDeps> = {},
): Promise<RouteResult> {
  const d: RouterDeps = { ...defaultDeps(), ...deps }
  const attempts: RouteAttempt[] = []

  const finish = (ok: boolean, model: string | null, text: string | null, reason: string): RouteResult => {
    const result: RouteResult = {
      ok,
      tier,
      model,
      text,
      attempts,
      degraded: ok && attempts.length > 1,
      reason,
    }
    appendEvent('LLM_ROUTE_DECISION', {
      tier,
      ok,
      model,
      reason,
      degraded: result.degraded,
      attempts: attempts.map((a) => ({ model: a.model, free: a.free, ok: a.ok, reason: a.reason })),
    })
    return result
  }

  if (!d.provider) {
    return finish(false, null, null, 'NO_PROVIDER：未启用任何厂商，按确定性模式处理（不虚构模型调用）')
  }

  // 候选链：显式配置优先，厂商激活模型永远作为最后一根兜底。
  // 兜底必须存在 —— 否则配置写错一个模型名就会让整条链路无法工作。
  const configured = configuredModels(tier)
  const chain = [...new Set([...configured, d.provider.model])]

  for (const model of chain) {
    const free = isFreeModel(model)
    if (!free) {
      if (tier === 'probe') {
        attempts.push({ model, free, ok: false, reason: 'PROBE_NEVER_PAID：探测层不占用付费额度', latencyMs: 0 })
        continue
      }
      if (!allowPaid()) {
        attempts.push({ model, free, ok: false, reason: 'PAID_NOT_ALLOWED：未开启 EV_LLM_ALLOW_PAID', latencyMs: 0 })
        continue
      }
      const cap = paidHourlyCap()
      if (paidUsedInWindow(d.now()) >= cap) {
        attempts.push({ model, free, ok: false, reason: `PAID_BUDGET_EXHAUSTED：本小时已用 ${cap} 次`, latencyMs: 0 })
        continue
      }
    }

    const startedAt = d.now()
    let text: string | null = null
    let reason: string | undefined
    try {
      text = await d.call({ ...d.provider, model }, systemPrompt, userPrompt, temperature)
      if (text === null) reason = 'EMPTY_RESPONSE'
    } catch (e) {
      reason = `CALL_FAILED: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`
    }
    const latencyMs = Math.max(0, d.now() - startedAt)

    if (text !== null) {
      if (!free) notePaidCall(d.now())
      attempts.push({ model, free, ok: true, latencyMs })
      return finish(true, model, text, free ? '使用免费模型' : `使用付费模型（本小时第 ${paidUsedInWindow(d.now())}/${paidHourlyCap()} 次）`)
    }
    attempts.push({ model, free, ok: false, reason, latencyMs })
  }

  return finish(false, null, null, `全部候选失败（${attempts.length} 个）：${attempts.map((a) => `${a.model}[${a.reason ?? '-'}]`).join(' ')}`)
}

/** 供监控/管理页读取的路由配置视图。 */
export function routerConfigView(): {
  tiers: { id: ModelTier; label: string; desc: string; models: string[] }[]
  allowPaid: boolean
  paidHourlyCap: number
  paidUsedThisHour: number
} {
  return {
    tiers: MODEL_TIERS.map((t) => ({ ...t, models: [...configuredModels(t.id), getActiveLlm()?.model ?? '（未配置厂商）'].filter((m, i, a) => a.indexOf(m) === i) })),
    allowPaid: allowPaid(),
    paidHourlyCap: paidHourlyCap(),
    paidUsedThisHour: paidUsedInWindow(Date.now()),
  }
}
