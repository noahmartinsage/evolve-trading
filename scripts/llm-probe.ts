/**
 * 模型可用性探针 —— 逐个试，找出**真能回话**的模型。
 *
 * ── 为什么必须有这个脚本 ──────────────────────────────────────────────
 * 实测日志里出现过这一行：
 *
 *   `[llm] chatComplete HTTP 400 Opencode-zen-ray/deepseek-v4-flash-free:
 *    {"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}`
 *
 * 也就是说：厂商探测拿到了 63 个模型名，`/models` 返回 200，
 * **但被选中的那一个上游已经下线**。链路上的每一处都在报"正常"：
 * 厂商 enabled、last_status 是 `OK · 63 个模型`、路由把请求发出去了 ——
 * 只有真正要一句话的时候什么也回不来。
 *
 * 这是本仓库记过的那一族：**哑的失败**。系统没读懂、没答上，却什么都没说。
 * 用户看到的是桌宠"不会"，而账本上找不到一条"模型不可用"的记录。
 *
 * 所以这个脚本做两件事：
 *   ① 把候选模型**逐个真的调一次**，把能回话的挑出来（这是唯一的判据，
 *      `/models` 里列着不等于能用）；
 *   ② 把结果落盘成 `_llmp.json`，供人看、供路由参考。
 *
 * ── 出网那一段只留一份 ────────────────────────────────────────────────
 * 真正发请求的实现住在 `server/providerProbe.ts`，本脚本与
 * `scripts/provider-reset.ts` 共用它。★ 早先这里自己写了一份 fetch，
 * 而 `provider-reset` 又写了一份 —— 同一个动作两条实现路径的后果是
 * 两处判据会分叉：一处认 `HTTP 400 Model is unavailable` 是"名字下线"、
 * 另一处不认，于是同一个厂商被一个脚本判"换名字"、另一个判"停用"（判据 8）。
 *
 * ★ 与 `provider-reset.ts` 的分工：本脚本**只报观测**（哪些能用、延迟多少），
 *   不碰数据库里的任何字段；`provider-reset.ts` 才做判决并写库。
 *   "改 active_model / 改 enabled"是人的决定，探针只给证据。
 *
 * 用法：
 *   node scripts/llm-probe.ts              # 试当前在册的第一个可用厂商
 *   node scripts/llm-probe.ts --list       # 只列 /models，不调补全
 *   node scripts/llm-probe.ts --write      # 把探针结论写进 last_status（不动 active_model）
 *
 * ★ 刻意不进 CI：它联网、且会消耗真实额度。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { classifyProbe, type ProbeSample } from '../server/providerHealth.ts'
import { orderCandidates, probeModels, looksFree, type ProbeTarget } from '../server/providerProbe.ts'

interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_key: string
  flavor: string
  models_json: string
  active_model: string | null
  enabled: number
}

function loadProvider(): ProviderRow | null {
  const dbPath = process.env.EV_DB ?? 'data/orch.db'
  if (!existsSync(dbPath)) return null
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT * FROM llm_providers ORDER BY created_ts').all() as unknown as ProviderRow[]
  return rows.find((r) => Number(r.enabled) === 1 && !!r.active_model) ?? rows[0] ?? null
}

/** 一行给人看的观测。 */
function renderLine(s: ProbeSample): string {
  const c = classifyProbe(s)
  const mark = c === 'ok' ? '✅' : '❌'
  const tail = s.responded ? (c === 'ok' ? s.body : `HTTP ${s.status} ${(s.body ?? '').slice(0, 110)}`) : `网络层失败：${s.netError ?? ''}`
  return `${mark} ${s.model.padEnd(42)} ${String(s.ms).padStart(6)}ms  ${tail}`
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const p = loadProvider()
  if (!p) {
    console.log(JSON.stringify({ ok: false, reason: 'NO_PROVIDER：库里没有任何厂商记录' }, null, 2))
    process.exit(1)
  }
  const allModels = JSON.parse(p.models_json || '[]') as string[]
  const free = allModels.filter(looksFree)

  console.log(`厂商 ${p.name} · ${p.base_url} · 共 ${allModels.length} 个模型 · 免费档 ${free.length} 个`)
  console.log(`当前激活：${p.active_model ?? '（无）'}`)
  console.log('')

  if (args.has('--list')) {
    console.log('免费档模型：')
    for (const m of free) console.log('  ' + m)
    process.exit(0)
  }

  const target: ProbeTarget = {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    flavor: p.flavor,
    model: p.active_model ?? '',
  }
  const limit = Number(process.env.EV_PROBE_LIMIT ?? '12')
  const candidates = orderCandidates(allModels, p.active_model).slice(0, limit)
  const samples = await probeModels(target, candidates)
  for (const s of samples) console.log(renderLine(s))

  const usable = samples.filter((s) => classifyProbe(s) === 'ok').map((s) => s.model)
  const activeOk = samples.find((s) => s.model === p.active_model)
    ? classifyProbe(samples.find((s) => s.model === p.active_model) as ProbeSample) === 'ok'
    : null

  const out = {
    provider: p.name,
    baseUrl: p.base_url,
    activeModel: p.active_model,
    activeModelUsable: activeOk,
    tested: samples.length,
    usable,
    failed: samples
      .filter((s) => classifyProbe(s) !== 'ok')
      .map((s) => ({ model: s.model, kind: classifyProbe(s), reason: s.responded ? `HTTP ${s.status}: ${s.body}` : `网络层失败：${s.netError}` })),
    at: new Date().toISOString(),
  }
  writeFileSync('_llmp.json', JSON.stringify(out, null, 2), 'utf8')
  console.log('')
  console.log(`可用 ${usable.length}/${samples.length}：${usable.join('、') || '（一个都没有）'}`)
  if (activeOk === false) {
    console.log(`★ 当前激活的 ${p.active_model} 不可用 —— 这就是"模型配了却不参与"的直接原因。`)
    if (usable.length > 0) console.log(`   建议切到：${usable[0]}`)
    else console.log('   一个可用的都没有。要判断"该换名字还是该停用"，跑：npm run provider:reset -- --provider ' + p.name)
  }
  console.log('已落盘 _llmp.json')

  if (args.has('--write')) {
    // 只写 last_status 这一个字段：把探针结论留痕。
    // ★ 不去改 `active_model` —— 那是人的决定，探针只给证据。
    const db = new DatabaseSync(process.env.EV_DB ?? 'data/orch.db')
    db.prepare('UPDATE llm_providers SET last_status = ? WHERE id = ?').run(
      `PROBED · 可用 ${usable.length}/${samples.length} · ${usable.slice(0, 3).join(',') || '无'}`,
      p.id,
    )
    console.log('已把探针结论写进厂商的 last_status（未动 active_model）')
  }
}

void main().catch((e) => {
  console.log(JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) }, null, 2))
  process.exit(1)
})
