/**
 * 视觉探针 —— 免费档里哪些模型**真的能读图**。
 *
 * `/models` 的 `architecture.input_modalities` 里写着 `image`，
 * 不代表能读：实测 `ling-3.0-flash-vl:free` 标着 `["text","image","video"]`，
 * 真发一张图过去却回 400 invalid request。所以判据只能是**真发一张图**，
 * 而且要**答对颜色** —— 一个回"我看不到图片"的 HTTP 200 在链路上全绿，
 * 而用户拿到的是瞎话。
 *
 * ── 为什么候选要动态取，而不是维护一份硬编码名单 ──────────────────────
 * 第一版是硬编码 8 个模型。2026-09-19 复跑时，上一轮明明"答对过红色"的
 * `nex-n2.5-pro:free` 变成了 503 + EMPTY_RESPONSE —— **硬编码名单会和模型
 * 名单一起腐烂**，而且是静默腐烂：探针照样输出一份结果，只是全是❌。
 * 所以现在从 `/models` 现取"标着支持图片 + 免费"的全部模型来实测。
 *
 * 图片用代码现场生成（64×64 纯红 PNG），不依赖仓库里任何素材 ——
 * 探针要能在干净环境里跑出同一结论。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { chatCompleteParts, getActiveLlm, type ActiveLlm } from '../server/llmProviders.ts'
import { assistantSystemPrompt } from '../server/voice/model.ts'

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.log('没有 OPENROUTER_API_KEY，无法探测')
  process.exit(1)
}

/**
 * ★ 探测必须调用**生产用的那个函数**（`chatCompleteParts`）与**生产的系统提示**。
 *
 * 第一版探针自己手写了一段 fetch（无 system、max_tokens=40）。它给出的结论
 * 与生产不符，而且是两个方向都不符：`ling-3.0-flash-vl:free` 在探针里答对
 * 了"红色"，走生产链路却回 **400 invalid request**；`nex-n2.5-pro:free`
 * 在探针里 200，走生产链路回 **503 EMPTY_RESPONSE**。
 * ⇒ 一份"探针说能用、生产用不了"的名单，比没有名单更糟：它会让排查从
 *    "模型不可用"这个正确方向偏到"代码写错了"上去。
 * 判据很简单：**选择与检验必须走同一条路径**。
 */
const active = getActiveLlm()
if (!active) {
  console.log('自举之后仍然没有可用厂商 —— 先看环境里有没有凭据')
  process.exit(1)
}
// ★ 复制成一个带类型标注的常量：`askVision` 是另一层函数作用域，
//   TS 不会把顶层 `if (!active) process.exit(1)` 的窄化带进去
//   （`process.exit` 被当成普通函数而不是 never 终止符）。
const ACTIVE: ActiveLlm = active
console.log(`厂商 ${ACTIVE.name}（${ACTIVE.baseUrl}），探测走生产的 chatCompleteParts\n`)
const SYSTEM = assistantSystemPrompt()

const LIMIT = Number(process.env.EV_VISION_LIMIT ?? 14)
const CONCURRENCY = Number(process.env.EV_VISION_CONCURRENCY ?? 3)

/** 极简 PNG 编码：纯色 RGB，无过滤。只为得到一张**真图**。 */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter type
    for (let x = 0; x < size; x++) {
      raw[o++] = rgb[0]
      raw[o++] = rgb[1]
      raw[o++] = rgb[2]
    }
  }
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cr = Buffer.alloc(4)
    cr.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = solidPng(64, [220, 30, 30])
const dataUrl = 'data:image/png;base64,' + png.toString('base64')
writeFileSync('_vision-probe.png', png)
console.log(`生成了 64×64 纯红 PNG（${png.length} 字节）→ _vision-probe.png`)

interface ModelRow {
  id: string
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[] }
}

/** 现取候选：标着支持图片输入、且免费（`:free` 或价格 0）。 */
async function listCandidates(limit: number): Promise<string[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`/models HTTP ${res.status}`)
  const j = (await res.json()) as { data?: ModelRow[] }
  const free = (j.data ?? [])
    .filter((m) => (m.architecture?.input_modalities ?? []).includes('image'))
    .filter((m) => m.id.endsWith(':free') || m.pricing?.prompt === '0')
    .map((m) => m.id)
    .sort()
  console.log(`/models 里「免费 + 支持图片」的模型共 ${free.length} 个，本次实测前 ${Math.min(limit, free.length)} 个\n`)
  return free.slice(0, limit)
}

async function askVision(model: string): Promise<{ ok: boolean; ms: number; note: string }> {
  const t0 = Date.now()
  try {
    const text = await chatCompleteParts(
      { ...ACTIVE, model },
      SYSTEM,
      [
        { type: 'text', text: '这张图是什么颜色？只回答颜色名。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
      0.4,
      60,
    )
    const ms = Date.now() - t0
    if (text === null) return { ok: false, ms, note: '生产路径返回 null（HTTP 非 200 或网络层失败，见上一条 [llm] 告警）' }
    const c = text.replace(/\s+/g, ' ').trim()
    if (c.length === 0) return { ok: false, ms, note: 'HTTP 200 但正文为空（EMPTY_RESPONSE）' }
    // ★ 判据不是"HTTP 200"，是**答对了颜色**。
    const right = /红/.test(c)
    return { ok: right, ms, note: `正文=${c.slice(0, 50)}${right ? '' : ' ← 颜色不对，不算能读图'}` }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, note: `网络层：${e instanceof Error ? e.message.slice(0, 100) : String(e)}` }
  }
}

/** 固定并发跑任务：串行 14 个模型要十几分钟，全并发会被限流。 */
async function runPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor
      cursor += 1
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}

async function main(): Promise<void> {
  const candidates = await listCandidates(LIMIT)
  const good: { id: string; latencyMs: number; how: string }[] = []

  await runPool(candidates, CONCURRENCY, async (m) => {
    const r = await askVision(m)
    if (r.ok) good.push({ id: m, latencyMs: r.ms, how: `vision-probe：发 64×64 纯红 PNG，正文答对「红」，HTTP 200（${new Date().toISOString().slice(0, 10)} 实测）` })
    console.log(`${r.ok ? '✅' : '❌'} ${m.padEnd(58)} ${String(r.ms).padStart(6)}ms  ${r.note}`)
  })

  good.sort((a, b) => a.latencyMs - b.latencyMs)
  console.log(`\n真能读图的免费模型 ${good.length}/${candidates.length}：${good.map((g) => g.id).join('、') || '（一个都没有）'}`)
  console.log('\n可直接粘进 server/llmCatalog.ts 的 VERIFIED_VISION_MODELS：')
  console.log(JSON.stringify(good, null, 2))
  writeFileSync('_vision.json', JSON.stringify({ usable: good, at: new Date().toISOString() }, null, 2), 'utf8')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
