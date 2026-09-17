import { randomUUID } from 'node:crypto'

export type ProviderFlavor = 'openai' | 'anthropic'

export interface LlmProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  flavor: ProviderFlavor
  models: string[]
  activeModel: string | null
  enabled: boolean
  lastProbeAt: number | null
  lastStatus: string
  createdTs: number
}

export interface LlmProviderView extends Omit<LlmProvider, 'apiKey'> {
  keyHint: string
}

interface DbLike {
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  exec(sql: string): void
}

let db: DbLike | null = null

export function bindLlmProvidersDb(d: DbLike | null): void {
  db = d
  if (!db) return
  db.exec(`CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    flavor TEXT NOT NULL DEFAULT 'openai',
    models_json TEXT NOT NULL DEFAULT '[]',
    active_model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_probe_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'unprobed',
    created_ts INTEGER NOT NULL
  )`)
  // 启动恢复内存注册表
  const rows = db.prepare('SELECT * FROM llm_providers').all() as unknown as Record<string, unknown>[]
  for (const r of rows) {
    registry.set(String(r.id), rowToProvider(r))
  }
  if (rows.length > 0) console.log(`[OK] LLM 厂商注册表恢复 ${rows.length} 条`)
}

const registry = new Map<string, LlmProvider>()

function rowToProvider(r: Record<string, unknown>): LlmProvider {
  return {
    id: String(r.id),
    name: String(r.name),
    baseUrl: String(r.base_url),
    apiKey: String(r.api_key),
    flavor: (r.flavor === 'anthropic' ? 'anthropic' : 'openai') as ProviderFlavor,
    models: JSON.parse(String(r.models_json ?? '[]')) as string[],
    activeModel: r.active_model ? String(r.active_model) : null,
    enabled: Number(r.enabled) === 1,
    lastProbeAt: r.last_probe_at ? Number(r.last_probe_at) : null,
    lastStatus: String(r.last_status ?? 'unprobed'),
    createdTs: Number(r.created_ts),
  }
}

function persist(p: LlmProvider): void {
  if (!db) return
  db.prepare(
    `INSERT INTO llm_providers (id, name, base_url, api_key, flavor, models_json, active_model, enabled, last_probe_at, last_status, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, api_key=excluded.api_key, flavor=excluded.flavor,
       models_json=excluded.models_json, active_model=excluded.active_model, enabled=excluded.enabled,
       last_probe_at=excluded.last_probe_at, last_status=excluded.last_status`,
  ).run(p.id, p.name, p.baseUrl, p.apiKey, p.flavor, JSON.stringify(p.models), p.activeModel, p.enabled ? 1 : 0, p.lastProbeAt, p.lastStatus, p.createdTs)
}

export function maskKey(k: string): string {
  if (k.length <= 8) return '*'.repeat(k.length)
  return k.slice(0, 3) + '***' + k.slice(-4)
}

function view(p: LlmProvider): LlmProviderView {
  const { apiKey, ...rest } = p
  return { ...rest, keyHint: maskKey(apiKey) }
}

export function listProviders(): LlmProviderView[] {
  return [...registry.values()].sort((a, b) => a.createdTs - b.createdTs).map(view)
}

export interface AddProviderInput {
  name?: string
  baseUrl: string
  apiKey: string
  flavor?: ProviderFlavor
}

export function addProvider(input: AddProviderInput): { ok: boolean; reason?: string; id?: string } {
  const base = input.baseUrl?.replace(/\/+$/, '')
  if (!base || !/^https?:\/\//.test(base)) return { ok: false, reason: 'INVALID_BASE_URL' }
  if (!input.apiKey || input.apiKey.length < 4) return { ok: false, reason: 'INVALID_API_KEY' }
  const flavor: ProviderFlavor = input.flavor === 'anthropic' ? 'anthropic' : 'openai'
  const id = randomUUID().slice(0, 12)
  const p: LlmProvider = {
    id,
    name: (input.name ?? new URL(base).host).slice(0, 80),
    baseUrl: base,
    apiKey: input.apiKey,
    flavor,
    models: [],
    activeModel: null,
    enabled: true,
    lastProbeAt: null,
    lastStatus: 'added',
    createdTs: Date.now(),
  }
  registry.set(id, p)
  persist(p)
  return { ok: true, id }
}

export function removeProvider(id: string): boolean {
  const gone = registry.delete(id)
  db?.prepare('DELETE FROM llm_providers WHERE id = ?').run(id)
  return gone
}

export function setEnabled(id: string, enabled: boolean): boolean {
  const p = registry.get(id)
  if (!p) return false
  p.enabled = enabled
  persist(p)
  return true
}

export function setActiveModel(id: string, model: string): { ok: boolean; reason?: string } {
  const p = registry.get(id)
  if (!p) return { ok: false, reason: 'PROVIDER_UNKNOWN' }
  if (!p.models.includes(model)) return { ok: false, reason: 'MODEL_NOT_IN_DETECTED_LIST' }
  p.activeModel = model
  persist(p)
  return { ok: true }
}

export interface ActiveLlm {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  flavor: ProviderFlavor
  model: string
}

/** 提案引擎使用的当前激活厂商；未启用任何厂商时返回 null（引擎降级确定性模式） */
export function getActiveLlm(): ActiveLlm | null {
  for (const p of registry.values()) {
    if (p.enabled && p.activeModel) {
      return { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, flavor: p.flavor, model: p.activeModel }
    }
  }
  return null
}

// ---------- 探测与调用（OpenAI 兼容 / Anthropic 自适应） ----------

function normalizeBase(base: string, flavor: ProviderFlavor): string {
  let b = base.replace(/\/+$/, '')
  if (flavor === 'anthropic') {
    if (!/\/v\d+$/.test(b)) b += '/v1'
    return b
  }
  // openai 兼容：约定 baseUrl 已含版本前缀（如 https://api.openai.com/v1）；不含则自动补 /v1
  if (!/\/v\d+|\/api$|\/openai$/.test(b)) b += '/v1'
  return b
}

function authHeaders(flavor: ProviderFlavor, apiKey: string): Record<string, string> {
  if (flavor === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { authorization: `Bearer ${apiKey}` }
}

/** 已知厂商内置模型清单：当 /models 探测被鉴权拦截或为空时回退，确保「自动识别可用模型」可用（标注为内置清单，不假称实时探测） */
const KNOWN_CATALOG: Record<string, string[]> = {
  'api.deepseek.com': ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  'api.openai.com': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  'api.anthropic.com': ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
}

function matchCatalog(baseUrl: string): string[] {
  try {
    const host = new URL(baseUrl).host.toLowerCase()
    for (const key of Object.keys(KNOWN_CATALOG)) {
      if (host.includes(key)) return KNOWN_CATALOG[key]
    }
  } catch {
    /* ignore */
  }
  return []
}

/** 自动识别可用模型：GET /models，兼容两家响应结构 */
export async function probeModels(p: LlmProvider): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  const base = normalizeBase(p.baseUrl, p.flavor)
  try {
    const res = await fetch(`${base}/models`, {
      headers: { ...authHeaders(p.flavor, p.apiKey), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const t = (await res.text()).slice(0, 120)
      p.lastProbeAt = Date.now()
      // 鉴权受限 / 空响应：先尝试内置清单回退
      const fb = tryCatalogFallback(p)
      if (fb.models.length > 0) return fb
      p.lastStatus = `HTTP ${res.status}: ${t}`
      persist(p)
      return { ok: false, models: [], reason: p.lastStatus }
    }
    const data = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] }
    const models = (data.data ?? data.models ?? []).map((m) => String(m.id ?? '')).filter((s) => s.length > 0)
    p.models = models
    // 未选择模型时自动选第一个可用项
    if (models.length > 0 && !p.activeModel) p.activeModel = models[0]
    p.lastProbeAt = Date.now()
    p.lastStatus = `OK · ${models.length} 个模型`
    persist(p)
    return { ok: models.length > 0, models, reason: models.length === 0 ? 'PROVIDER_RETURNED_NO_MODELS' : undefined }
  } catch (e) {
    p.lastProbeAt = Date.now()
    // 网络不可达等错误：仍尝试内置清单回退（deepseek harness 场景）
    const fb = tryCatalogFallback(p)
    if (fb.models.length > 0) return fb
    p.lastStatus = `ERROR: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`
    persist(p)
    return { ok: false, models: [], reason: p.lastStatus }
  }
}

/** 已知厂商内置清单回退；命中则返回填充后的结果，未命中返回空 */
function tryCatalogFallback(p: LlmProvider): { ok: boolean; models: string[]; reason?: string } {
  const catalog = matchCatalog(p.baseUrl)
  if (catalog.length === 0) return { ok: false, models: [] }
  p.models = catalog
  if (!p.activeModel) p.activeModel = catalog[0]
  p.lastProbeAt = Date.now()
  p.lastStatus = `OK(catalog) · ${catalog.length} 个模型(内置清单)`
  persist(p)
  return { ok: true, models: catalog, reason: 'CATALOG_FALLBACK' }
}

export async function probeAndPersist(id: string): Promise<{ ok: boolean; models: string[]; reason?: string }> {
  const p = registry.get(id)
  if (!p) return { ok: false, models: [], reason: 'PROVIDER_UNKNOWN' }
  const r = await probeModels(p)
  return r
}

/** chat 补全（提案生成用）；返回纯文本 */
export async function chatComplete(active: ActiveLlm, systemPrompt: string, userPrompt: string, temperature = 0.7): Promise<string | null> {
  const base = normalizeBase(active.baseUrl, active.flavor)
  const ac = new AbortController()
  // 免费档模型响应明显慢于付费档（实测 deepseek-v4-flash-free 常需 30s+），
  // 原 15s 超时会大面积触发并静默降级为确定性引擎，表现为"LLM 配好了却不参与"。
  const timer = setTimeout(() => ac.abort(), 90_000)
  try {
    if (active.flavor === 'anthropic') {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { ...authHeaders(active.flavor, active.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({ model: active.model, max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }], temperature }),
        signal: ac.signal,
      })
      if (!res.ok) return null
      const data = (await res.json()) as { content?: { text?: string }[] }
      return data.content?.[0]?.text ?? null
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders(active.flavor, active.apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: active.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
      }),
      signal: ac.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 静默吞掉失败会让"LLM 不参与"极难排查，必须留痕
      console.warn(`[llm] chatComplete HTTP ${res.status} ${active.name}/${active.model}: ${body.slice(0, 200)}`)
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch (e) {
    console.warn(`[llm] chatComplete 失败 ${active.name}/${active.model}:`, e instanceof Error ? e.message.slice(0, 160) : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}
