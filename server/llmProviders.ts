import { randomUUID } from 'node:crypto'
import { CATALOG_VERIFIED_AT, VERIFIED_TEXT_MODELS, VERIFIED_VISION_MODELS } from './llmCatalog.ts'

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
  // 面板也要能看到"从环境变量接上的那条通道" —— 否则用户会以为系统没接模型，
  // 而实际情况是他已经在环境里配好了。两处读取走同一个自举闸门。
  bootstrapEnvOnce()
  return [...registry.values()].sort((a, b) => a.createdTs - b.createdTs).map(view)
}

/**
 * 带凭据的账号清单 —— **给路由层与账号池用，不经 `view()` 脱敏**。
 *
 * ★ 为什么不复用 `listProviders()`：那个函数的返回值里**没有 apiKey**（它是给面板的）。
 *   路由层要拿 key 去发请求，所以必须有一条能吃原始凭据的路。
 *   两条路分开而不是加个开关，是为了让"谁读到了明文 key"这件事在调用点上就看得见：
 *   全仓只有 `llmPool` / `modelRouter` / `llmProviders` 自己读它。
 */
export function listAccounts(): LlmProvider[] {
  bootstrapEnvOnce()
  return [...registry.values()].sort((a, b) => a.createdTs - b.createdTs)
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

/**
 * 环境自举的幂等闸门。
 *
 * ★ 为什么自举必须挂在**读取侧**，而不是只在服务启动时跑一次：
 *   它原先只在 `server/index.ts` 的启动序列里被调用。后果是——凡是**不经过
 *   那次启动**的入口（烟测、探针脚本、CLI、桌宠的独立进程）都拿不到厂商，
 *   `getActiveLlm()` 恒为 null，于是看图、读文档、联网总结、开放提问
 *   全部回同一句"没有任何可用厂商"。
 *   实测（2026-09-19）就是这么发现的：环境里明明有 OPENROUTER_API_KEY，
 *   探针也真调通过，桌宠却在说"通道没配"。
 *   把自举放到读取侧之后，"有没有模型"这个判断在任何进程里答案都一样。
 */
let envBootstrapped = false
let envBootstrapping = false

function bootstrapEnvOnce(): void {
  if (envBootstrapped || envBootstrapping) return
  envBootstrapping = true
  try {
    ensureEnvProvider()
    envBootstrapped = true
  } catch {
    // 自举失败不许影响读取 —— 但它会被下一次读取再试一次，
    // 所以不把 envBootstrapped 置真。
  } finally {
    envBootstrapping = false
  }
}

/** 提案引擎使用的当前激活厂商；未启用任何厂商时返回 null（引擎降级确定性模式） */
export function getActiveLlm(): ActiveLlm | null {
  bootstrapEnvOnce()
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
  return chatCompleteParts(active, systemPrompt, [{ type: 'text', text: userPrompt }], temperature)
}

/** 多模态消息片段。图片一律走 `image_url`（OpenAI 兼容）或 `image`（Anthropic）。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 带附件的补全。
 *
 * ★ 为什么 `chatComplete` 改成调用它，而不是各写一份：
 *   两份实现里必然有一份漏掉新加的东西 —— 而漏掉的那份不会报错，
 *   它会**继续工作，只是永远看不到图**。这正是本仓库刚吃过的那种失败
 *   （`llm-probe` 发现 `/models` 列着但上游已下线：链路上全绿，用户端是哑的）。
 *
 * ★ 图片走 base64 data URL 而不是外链：外链会被厂商的抓取器访问，
 *   等于把用户贴在桌宠上的截图变成一个公网可取的地址。本地编码没有这个问题，
 *   代价只是请求体大一些。
 */
export async function chatCompleteParts(
  active: ActiveLlm,
  systemPrompt: string,
  parts: ContentPart[],
  temperature = 0.7,
  maxTokens = 1024,
): Promise<string | null> {
  const base = normalizeBase(active.baseUrl, active.flavor)
  const ac = new AbortController()
  // 免费档模型响应明显慢于付费档（实测 deepseek-v4-flash-free 常需 30s+，
  // 而 OpenRouter 上的免费视觉档实测 14s），原 15s 超时会大面积触发并静默
  // 降级为确定性引擎，表现为"LLM 配好了却不参与"。
  const timer = setTimeout(() => ac.abort(), 90_000)
  try {
    if (active.flavor === 'anthropic') {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { ...authHeaders(active.flavor, active.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: active.model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: parts.map((p) =>
                p.type === 'text'
                  ? { type: 'text', text: p.text }
                  : { type: 'image', source: { type: 'base64', media_type: dataUrlMediaType(p.image_url.url), data: dataUrlBase64(p.image_url.url) } },
              ),
            },
          ],
          temperature,
        }),
        signal: ac.signal,
      })
      if (!res.ok) {
        await noteFailure(active, res.status, await res.text().catch(() => ''))
        return null
      }
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
          { role: 'user', content: parts },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: ac.signal,
    })
    if (!res.ok) {
      await noteFailure(active, res.status, await res.text().catch(() => ''))
      return null
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch (e) {
    console.warn(`[llm] chatCompleteParts 失败 ${active.name}/${active.model}:`, e instanceof Error ? e.message.slice(0, 160) : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function dataUrlMediaType(url: string): string {
  const m = /^data:([^;]+);/.exec(url)
  return m?.[1] ?? 'image/png'
}

function dataUrlBase64(url: string): string {
  const i = url.indexOf(',')
  return i >= 0 ? url.slice(i + 1) : url
}

/**
 * 把一次失败写回厂商记录。
 *
 * ── 为什么失败也必须落盘 ──────────────────────────────────────────────
 * 实测过的那次故障里，账本上找不到任何一条"模型不可用"的记录：
 * `last_status` 还停在几天前探测时的 `OK · 63 个模型`。
 * 于是"桌宠答不上来"这件事，事后只能靠翻进程日志里的一行 console.warn ——
 * 而那一行在没有重定向的时候根本不存在。
 *
 * ⇒ 每一次失败都覆盖 `last_status`，让**厂商记录自己**成为失败的第一现场。
 */
/**
 * 最近一次 HTTP 失败（非 200）的**原始信息**。
 *
 * ── 为什么这一层必须把它送出去 ────────────────────────────────────────
 * `chatCompleteParts` 失败时对上层只有一个 `null`。上层于是只能把它记成
 * `EMPTY_RESPONSE` —— 而"空响应"这个说法把三种完全不同的原因抹平了：
 * 额度用完（429）· 模型在你这个地区不可用（403）· 名字写错（404）。
 *
 * 实测后果（2026-09-19）：三个免费视觉候选全败，回话写的是
 * "重跑探针能看出是哪一个名字烂掉了"，而探针的原文是
 * `HTTP 429 free-models-per-day`（额度打满）。**照着那句话去做，用户会去换模型名单；
 * 而正确的动作是等额度或加额度。**
 *
 * ⇒ 只装可观测量：状态码 / 原厂报错片段 / 哪个模型 / 什么时候。
 *   **不装"这说明什么"的结论** —— 性质由消费方按状态码自己判。
 */
export interface LlmHttpFailure {
  model: string
  status: number
  snippet: string
  at: number
}

let lastHttpFailure: LlmHttpFailure | null = null

/** 取最近一次 HTTP 失败；从没失败过则 null。 */
export function lastLlmHttpFailure(): LlmHttpFailure | null {
  return lastHttpFailure
}

async function noteFailure(active: ActiveLlm, status: number, body: string): Promise<void> {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 160)
  const p = registry.get(active.id)
  if (p) {
    p.lastProbeAt = Date.now()
    p.lastStatus = `FAIL HTTP ${status} · ${active.model} · ${snippet}`
    persist(p)
  }
  lastHttpFailure = { model: active.model, status, snippet, at: Date.now() }
  console.warn(`[llm] chatComplete HTTP ${status} ${active.name}/${active.model}: ${snippet}`)
}

// ─────────────────── 从环境变量注册厂商（自动可用）────────────────────

/** 环境变量里的通用覆盖：`EV_LLM_BASE_URL` + `EV_LLM_API_KEY` 优先于厂商专属变量。 */
/**
 * 从环境变量能自举出哪些厂商。
 *
 * ★ 老版本这里只登记**一个**账号，判重键是 `baseUrl`。
 *   那正是"额度打满只能等明天"的根因：同一家配了第二个 key 也注册不进来，
 *   因为 baseUrl 撞了。现在判重键改成 **(baseUrl, apiKey)** ——
 *   一个 key 就是一个账号，账号池才有东西可换。
 */
const ENV_PROVIDER_CANDIDATES: { name: string; baseUrl: string; keyEnv: string }[] = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
]

/**
 * 同族多账号的键后缀。
 *
 * 用户的原话是「我多给配一些账号」。落成最小摩擦的形式：
 * 在 `.env` 里照着第一行加 `OPENROUTER_API_KEY_2=...`、`_3=...` 就多一个账号。
 * ★ 序号从 2 起：`OPENROUTER_API_KEY` 自己就是第 1 个，
 *   再来一个 `_1` 会让人以为有两套编号规则。
 */
const ACCOUNT_SUFFIXES = ['_2', '_3', '_4', '_5', '_6', '_7', '_8', '_9'] as const

/** 一条环境账号规格。 */
export interface EnvAccountSpec {
  /** 显示名（面板与播报都用它，所以要能区分第几个账号）。 */
  name: string
  baseUrl: string
  apiKey: string
  /** 显式条目可以指定首选模型；未指定则用已验证名单的第一个。 */
  model?: string
  /** 这条是从哪儿读出来的（报错时要能指到具体那一行配置）。 */
  from: string
}

/**
 * 显式账号条目：`EV_LLM_ACCOUNTS`。
 *
 * 格式（分号或换行分隔，每条 `名字|baseUrl|apiKey[|模型]`）：
 *   `备用1|https://openrouter.ai/api/v1|sk-or-xxx|nex-agi/nex-n2.5-pro:free;备用2|...`
 *
 * ★ 解析失败**不静默**：返回的 `bad` 会被拼进 note。
 *   一条写错的配置如果被安静吃掉，用户会以为"我明明配了"。
 */
export function parseAccountSpecs(raw: string): { specs: EnvAccountSpec[]; bad: string[] } {
  const specs: EnvAccountSpec[] = []
  const bad: string[] = []
  for (const chunk of raw.split(/[;\n]/)) {
    const line = chunk.trim()
    if (line.length === 0) continue
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 3) {
      bad.push(`「${line.slice(0, 40)}」字段不足（要 名字|baseUrl|apiKey）`)
      continue
    }
    const [name, baseUrl, apiKey, model] = parts
    if (!/^https?:\/\//.test(baseUrl)) {
      bad.push(`「${name}」的 baseUrl 不是 http(s)：${baseUrl.slice(0, 40)}`)
      continue
    }
    if (apiKey.length < 8) {
      bad.push(`「${name}」的 apiKey 太短（像占位符）`)
      continue
    }
    specs.push({ name: name.slice(0, 40), baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model: model || undefined, from: 'EV_LLM_ACCOUNTS' })
  }
  return { specs, bad }
}

/** 把环境变量扫成账号规格清单。**纯读环境，不注册**（便于单测）。 */
export function envAccountSpecs(env: NodeJS.ProcessEnv = process.env): { specs: EnvAccountSpec[]; bad: string[] } {
  const specs: EnvAccountSpec[] = []
  const bad: string[] = []

  // ① EV_LLM_ACCOUNTS（用户手写的一串账号）
  if (env.EV_LLM_ACCOUNTS) {
    const r = parseAccountSpecs(env.EV_LLM_ACCOUNTS)
    specs.push(...r.specs)
    bad.push(...r.bad)
  }

  // ② 已知厂商：主键 + 带序号后缀的同族键
  for (const cand of ENV_PROVIDER_CANDIDATES) {
    const keys: { key: string; idx: number; from: string }[] = []
    const main = env[cand.keyEnv]
    if (main && main.length >= 8) keys.push({ key: main, idx: 1, from: cand.keyEnv })
    for (const suf of ACCOUNT_SUFFIXES) {
      const v = env[cand.keyEnv + suf]
      if (v && v.length >= 8) keys.push({ key: v, idx: Number(suf.slice(1)), from: cand.keyEnv + suf })
    }
    for (const k of keys) {
      specs.push({
        name: k.idx === 1 ? cand.name : `${cand.name} #${k.idx}`,
        baseUrl: cand.baseUrl,
        apiKey: k.key,
        from: k.from,
      })
    }
  }

  // ③ 通用键（自建/兼容端点）：EV_LLM_BASE_URL + EV_LLM_API_KEY（+ 序号）
  const gbase = env.EV_LLM_BASE_URL
  if (gbase) {
    const base = gbase.replace(/\/+$/, '')
    const main = env.EV_LLM_API_KEY
    if (main && main.length >= 8) specs.push({ name: 'EV_LLM #1', baseUrl: base, apiKey: main, from: 'EV_LLM_API_KEY' })
    for (const suf of ACCOUNT_SUFFIXES) {
      const v = env['EV_LLM_API_KEY' + suf]
      if (v && v.length >= 8) specs.push({ name: `EV_LLM #${suf.slice(1)}`, baseUrl: base, apiKey: v, from: 'EV_LLM_API_KEY' + suf })
    }
  }

  // 同 (baseUrl, apiKey) 去重：同一个 key 写两处不该占两个账号位
  const seen = new Set<string>()
  const uniq = specs.filter((s) => {
    const k = s.baseUrl + '\u0000' + s.apiKey
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { specs: uniq, bad }
}

export interface EnsureEnvProviderResult {
  registered: boolean
  providerId: string | null
  name: string | null
  models: number
  activeModel: string | null
  note: string
  /** 环境里一共认出几个账号（去重后）。0 = 一个都没配。 */
  accounts: number
  /** 每个账号一行明细：`名字（keyHint）新增/在册`。 */
  details: string[]
}

/**
 * 把"环境里已经有凭据的厂商/账号"注册进来，并把**已验证可用**的模型挂上去。
 *
 * ── 这一步为什么是必需的，而不是"方便" ────────────────────────────────
 * 实测：唯一启用的厂商（opencode）免费档对外部调用一律 403、付费档 402 ——
 * 也就是说在修好这一点之前，**这个系统里没有任何一条路能真的调到模型**。
 * 桌宠因此对任何问题都只能回"我不会"，而那在用户那里与"它坏了"没有区别。
 *
 * ── 它不做的事（重要）──────────────────────────────────────────────
 * · **不去禁用用户已有的厂商** —— 那可能是一个正在付费使用的通道，
 *   探针在某一天不可达不代表它永久不可用。这里只**新增**可用的路。
 * · **不去改已有厂商的 activeModel** —— 那是人的决定。
 * · **不联网** —— 名单里的模型是离线验证过的（见 `llmCatalog.ts`），
 *   启动路径上不做网络调用（实测一次探针要 10~40 秒，放在启动里等于把
 *   启动时间交给外部服务，那是本仓库记过的另一类坑）。
 *
 * ── 多账号下的两个新规矩 ───────────────────────────────────────────────
 * · 判重键是 **(baseUrl, apiKey)**：一个 key 一个账号。用 baseUrl 判重会
 *   让"同一家的第二个账号"永远注册不进来 —— 而那正是账号池存在的意义。
 * · **幂等**：重复调用不重复注册（`bootstrapEnvOnce` 每次进程只跑一次，
 *   但测试与 CLI 会显式再调），也不改已注册账号的任何字段。
 */
export function ensureEnvProvider(): EnsureEnvProviderResult {
  const { specs, bad } = envAccountSpecs()
  const verified = [...VERIFIED_TEXT_MODELS, ...VERIFIED_VISION_MODELS].map((m) => m.id)
  const details: string[] = []
  let first: { id: string; name: string; models: number; activeModel: string | null } | null = null

  for (const spec of specs) {
    const existing = [...registry.values()].find(
      (p) => p.baseUrl.replace(/\/+$/, '') === spec.baseUrl && p.apiKey === spec.apiKey,
    )
    if (existing) {
      // 已注册过：只把**缺的**已验证模型补进 models 列表，不动 activeModel、不动 enabled。
      const merged = [...new Set([...existing.models, ...verified])]
      if (merged.length !== existing.models.length) {
        existing.models = merged
        persist(existing)
      }
      details.push(`${existing.name}（${maskKey(existing.apiKey)}）在册`)
      first ??= { id: existing.id, name: existing.name, models: merged.length, activeModel: existing.activeModel }
      continue
    }
    const r = addProvider({ name: spec.name, baseUrl: spec.baseUrl, apiKey: spec.apiKey })
    if (!r.ok || !r.id) {
      details.push(`${spec.name}（来自 ${spec.from}）注册失败：${r.reason ?? 'ADD_FAILED'}`)
      continue
    }
    const p = registry.get(r.id)!
    p.models = verified
    // 首选：显式指定的模型 → 否则已验证里最快的那一个（名单按延迟升序），
    // **不选**未验证的名字 —— "列在 /models 里"曾经把我们引到过一个 400 Model is unavailable 的名字上。
    p.activeModel = spec.model ?? VERIFIED_TEXT_MODELS[0]?.id ?? null
    p.lastStatus = `OK(catalog) · ${verified.length} 个已验证模型 · ${CATALOG_VERIFIED_AT}`
    persist(p)
    details.push(`${p.name}（${maskKey(p.apiKey)}）新增 · 来自 ${spec.from}`)
    first ??= { id: p.id, name: p.name, models: verified.length, activeModel: p.activeModel }
  }

  const badNote = bad.length > 0 ? `；有 ${bad.length} 条配置没读懂：${bad.join(' / ')}` : ''
  if (!first) {
    const looked = [
      ...ENV_PROVIDER_CANDIDATES.map((c) => c.keyEnv + '（以及 _2.._9）'),
      'EV_LLM_API_KEY',
      'EV_LLM_ACCOUNTS',
    ].join(' / ')
    return {
      registered: false,
      providerId: null,
      name: null,
      models: 0,
      activeModel: null,
      note: `环境里没有可用的厂商凭据（找过 ${looked}）${badNote}`,
      accounts: 0,
      details,
    }
  }
  return {
    registered: true,
    providerId: first.id,
    name: first.name,
    models: first.models,
    activeModel: first.activeModel,
    note: `认出 ${specs.length} 个账号${badNote}`,
    accounts: specs.length,
    details,
  }
}

// ★ 这里曾有一份**只认一个账号**的 `ensureEnvProvider`（判重键是 baseUrl），
//   已在第十七轮删掉 —— 保留两份定义会让 typecheck 报重复声明，
//   而"删掉旧的"这件事本身就是本轮的核心改动：判重键从 baseUrl 换成 (baseUrl, apiKey)。

