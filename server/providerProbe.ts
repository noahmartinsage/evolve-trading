/**
 * 厂商探针的**唯一实现** —— 真的把一个模型调一次，如实记下观测。
 *
 * ── 为什么不各脚本各写一份 ────────────────────────────────────────────
 * `scripts/llm-probe.ts` 与 `scripts/provider-reset.ts` 都要"真调一次"。
 * 两份 fetch 会导致两份判据：一处认 `HTTP 400 Model is unavailable` 是
 * "名字下线"，另一处不认 —— 于是同一个厂商，一个脚本说"换名字"、
 * 另一个说"停用"（判据 8：同一个业务动作有两条实现路径就是隐患）。
 * 所以出网这一段只留一份，脚本只负责**怎么用观测**。
 *
 * ── 这一层只吐可观测量 ────────────────────────────────────────────────
 * 返回值里没有"可用/不可用"这种结论字段，只有
 * `responded / status / body / netError / ms`。
 * 结论由 `providerHealth.decideProvider()` 从这些量里推 —— 凭据只装观测，
 * 不装结论（门禁范式 2），这样判决逻辑才能在纯噪声场里被断言。
 */
import type { ProbeSample } from './providerHealth.ts'

/** 探针要调的东西。 */
export interface ProbeTarget {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  flavor: string
  model: string
}

export interface ProbeOptions {
  /** 单次超时。默认 45 秒 —— 与"正常耗时"不同量级才算保护。 */
  timeoutMs?: number
  maxTokens?: number
  prompt?: string
}

const DEFAULT_PROMPT = '用一句中文回答：1+1 等于几？'
const DEFAULT_TIMEOUT_MS = 45_000

/**
 * 认"明确带免费标记"的名字。
 *
 * 认不出免费标记的一律不当免费试：本项目默认立场是"认不出就当付费"，
 * 探针自己拿一个付费模型去试等于绕过那道开关。
 */
export function looksFree(model: string): boolean {
  const s = model.toLowerCase()
  return s.includes('-free') || s.includes(':free') || s.includes('free')
}

/** baseUrl 归一化：`/v1`、`/api`、`/openai` 都已带版本段的就不再补。 */
export function normalizeBase(base: string, flavor: string): string {
  let b = base.replace(/\/+$/, '')
  if (flavor === 'anthropic') {
    if (!/\/v\d+$/.test(b)) b += '/v1'
    return b
  }
  if (!/\/v\d+|\/api$|\/openai$/.test(b)) b += '/v1'
  return b
}

function headers(t: ProbeTarget): Record<string, string> {
  if (t.flavor === 'anthropic') {
    return { 'x-api-key': t.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  }
  return { authorization: `Bearer ${t.apiKey}`, 'content-type': 'application/json' }
}

/** 真调一次。**永不抛** —— 失败也是一种观测，必须能落到返回值里。 */
export async function probeModel(t: ProbeTarget, model: string, opts: ProbeOptions = {}): Promise<ProbeSample> {
  const base = normalizeBase(t.baseUrl, t.flavor)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const body =
      t.flavor === 'anthropic'
        ? { model, max_tokens: opts.maxTokens ?? 32, messages: [{ role: 'user', content: opts.prompt ?? DEFAULT_PROMPT }] }
        : {
            model,
            messages: [{ role: 'user', content: opts.prompt ?? DEFAULT_PROMPT }],
            temperature: 0.2,
            max_tokens: opts.maxTokens ?? 32,
          }
    const res = await fetch(`${base}${t.flavor === 'anthropic' ? '/messages' : '/chat/completions'}`, {
      method: 'POST',
      headers: headers(t),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      return { model, responded: true, status: res.status, body: text, ms }
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      content?: { text?: string }[]
    }
    const text = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? null
    // HTTP 200 但没有正文**不算可用**：这正是本项目记过的那一族"哑的失败"。
    // 所以 `hasContent` 单独成一个可观测量，而不是靠 `status === 200` 顶替。
    if (!text) {
      return { model, responded: true, status: 200, body: 'HTTP 200 但没有正文（返回体结构不认识）', ms, hasContent: false }
    }
    return { model, responded: true, status: 200, body: text.replace(/\s+/g, ' ').slice(0, 60), ms, hasContent: true }
  } catch (e) {
    const ms = Date.now() - t0
    const msg = e instanceof Error ? e.message : String(e)
    // 连响应都没拿到 ⇒ responded:false。这条**必须**与"拿到 403"分开，
    // 否则本机网络故障会被读成厂商故障（判据 2）。
    return { model, responded: false, netError: msg.slice(0, 160), ms }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 逐个真调。顺序由调用方给：**当前在用的模型排第一** ——
 * "它是不是好的"是每次体检最要紧的那个问题。
 */
export async function probeModels(
  t: ProbeTarget,
  models: string[],
  opts: ProbeOptions = {},
): Promise<ProbeSample[]> {
  const out: ProbeSample[] = []
  for (const model of models) {
    out.push(await probeModel(t, model, opts))
  }
  return out
}

/**
 * 探哪些名字、按什么顺序。
 *
 * ① 当前在用的排第一（它好不好是本次最重要的问题）；
 * ② 明确免费的名字按"短名字优先"排 —— 同一家族里短的通常是基础版，命中率高；
 * ③ `extra` 是调用方显式追加的（例如体检时额外试几个付费档，
 *    用来把"免费档被政策堵死"与"整家不可用"分开）。
 */
export function orderCandidates(models: string[], active: string | null, extra: string[] = []): string[] {
  const free = models.filter(looksFree).sort((a, b) => a.length - b.length)
  return [...new Set([...(active ? [active] : []), ...free, ...extra])]
}
