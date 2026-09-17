import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindLlmProvidersDb, addProvider, listProviders, probeAndPersist, setActiveModel, getActiveLlm } from '../server/llmProviders.ts'
import { generateProposals } from '../server/proposalEngine.ts'
import { getOrchState, resetOrch } from '../server/core.ts'
import { DatabaseSync } from 'node:sqlite'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] LLM-PROVIDER SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'llm-provider-latest.json'), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2))
}

async function main() {
  // 内存 mock 厂商：OpenAI 兼容 /models + /chat/completions
  const MODELS = ['mock-quant-7b', 'mock-quant-13b', 'mock-quant-70b']
  const mock = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    if (u.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }))
      return
    }
    if (u.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: '[{"proposalId":"llm-mock-0001","kind":"new-strategy","params":{"fast":3,"slow":15},"rationale":"mock llm proposal"}]' } }],
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => { mock.listen(0, () => r()); mock.unref() })
  const addr = mock.address() as import('node:net').AddressInfo
  const baseUrl = `http://localhost:${addr.port}/v1`

  // 注册表绑定内存 DB（隔离）
  const db = new DatabaseSync(':memory:')
  bindLlmProvidersDb(db as unknown as Parameters<typeof bindLlmProvidersDb>[0])

  resetOrch(100_000)

  // S1 添加厂商 + 自动识别可用模型
  const added = addProvider({ name: 'Mock Vendor', baseUrl, apiKey: 'sk-mock-123456789', flavor: 'openai' })
  if (!added.ok || !added.id) fail('S1 auto-detect models', JSON.stringify(added))
  const probe = await probeAndPersist(added.id as string)
  if (!probe.ok) fail('S1 auto-detect models', `probe failed: ${probe.reason}`)
  const detected = probe.models
  if (JSON.stringify(detected) !== JSON.stringify(MODELS)) fail('S1 auto-detect models', `detected=${JSON.stringify(detected)}`)
  pass('S1 自动识别可用模型', `${detected.length} 个模型: ${detected.join(', ')}`)

  // S2 密钥脱敏
  const listed = listProviders()[0]
  const leaked = (listed as unknown as Record<string, unknown>).apiKey
  if (leaked !== undefined || !listed.keyHint.includes('***')) fail('S2 key masking', `apiKey leaked: ${JSON.stringify(listed).slice(0, 160)}`)
  pass('S2 密钥脱敏', `list 输出仅含 hint=${listed.keyHint}`)

  // S3 选择模型 → 提案引擎走 llm 来源生成
  const sel = setActiveModel(added.id as string, 'mock-quant-7b')
  if (!sel.ok) fail('S3 select model', JSON.stringify(sel))
  const gen = await generateProposals(getOrchState(), { source: 'llm' })
  if (!gen.llmUsed || gen.source !== 'llm') fail('S3 llm-sourced generation', `source=${gen.source} llmUsed=${gen.llmUsed}`)
  if (gen.verdicts.length === 0 || gen.verdicts.some((v) => !v.ok)) fail('S3 llm-sourced generation', `verdicts=${JSON.stringify(gen.verdicts.map((v) => v.reason))}`)
  pass('S3 llm 提案闭环', `LLM 输出经校验入口接收 · ${gen.verdicts.length} 条有效`)

  // S4 探测失败 fail-closed
  const bad = addProvider({ name: 'Bad Vendor', baseUrl: 'http://localhost:9/nothing/v1', apiKey: 'sk-bad-xxxxxxxx', flavor: 'openai' })
  if (!bad.ok || !bad.id) fail('S4 unreachable provider', JSON.stringify(bad))
  const badProbe = await probeAndPersist(bad.id as string)
  if (badProbe.ok) fail('S4 unreachable provider', '不可达厂商探测意外成功')
  const activeAfterBad = getActiveLlm()
  if (!activeAfterBad || activeAfterBad.name !== 'Mock Vendor') fail('S4 fail-closed', '激活厂商被错误切换')
  pass('S4 探测失败 fail-closed', `不可达厂商标记失败 · 激活厂商不受影响 (${activeAfterBad?.name})`)

  // S5 已知厂商 /models 受限时回退内置清单（deepseek harness 场景）
  const ds = addProvider({ name: 'DeepSeek', baseUrl: 'http://deepseek.mock.local/v1', apiKey: 'sk-ds-xxxx', flavor: 'openai' })
  if (!ds.ok || !ds.id) fail('S5 catalog fallback', JSON.stringify(ds))
  const dsProbe = await probeAndPersist(ds.id as string)
  if (!dsProbe.ok || dsProbe.models.length === 0) fail('S5 catalog fallback', `models empty: ${dsProbe.reason}`)
  if (dsProbe.reason !== 'CATALOG_FALLBACK') fail('S5 catalog fallback', `expected CATALOG_FALLBACK, got ${dsProbe.reason}`)
  if (!dsProbe.models.includes('deepseek-chat')) fail('S5 catalog fallback', `missing deepseek-chat: ${JSON.stringify(dsProbe.models)}`)
  pass('S5 内置清单回退', `deepseek 探测受限仍识别 ${dsProbe.models.length} 个模型: ${dsProbe.models.join(', ')}`)

  archive()
  mock.close()
  console.log('')
  console.log('[ARCHIVED] artifacts/llm-provider-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('LLM-PROVIDER SMOKE PASSED')
}

main().catch((e) => {
  console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
