/**
 * 密钥权限审计（**联网**，刻意不进 CI）
 *
 * 用法：npm run keys:audit
 *
 * ── 它和 `test:keyscope` 的分工 ────────────────────────────────────────
 *   · `test:keyscope`（进 CI）：纯函数，喂夹具，断言**判定口径**对不对；
 *   · 本脚本（不进 CI）：真去问交易所，断言**这条链路真的能问到**。
 * 两者不能互相替代 —— 一个证明"判得对"，一个证明"问得着"。
 * CI 里跑不了联网，所以真探测只能是操作员手工门。
 *
 * ── 退出码是给脚本链用的 ──────────────────────────────────────────────
 *   0 = 每把密钥都确认过「读 ✓ 交易 ✓ 提币 ✗」
 *   1 = 至少一把**未能确认**（没配、网络失败、鉴权被拒、返回格式不认识）
 *   2 = 至少一把**带提币权限** —— 先去交易所关掉它，别急着查别的
 *
 * ★ 1 不是"失败了"，是"没查到"。这两件事在语义上必须分开：
 *   把它们混在一起的话，网络一抖就会被当成"密钥有问题"，久了就没人信这个门了。
 */

import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { atomicWriteFile } from '../server/atomicWrite.ts'
import { classifyKeyScope, summarizeAudit } from '../server/keyScope.ts'
import type { KeyScopeVerdict } from '../server/keyScope.ts'
import { loadDotEnv } from '../server/loadEnv.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
loadDotEnv(join(ROOT, '.env'))

const TIMEOUT_MS = 8000

/**
 * 问 Binance 账号接口要权限字段。
 *
 * `/api/v3/account` 是 SIGNED 接口，所以要按规矩签名：
 * query string 拼好 → HMAC-SHA256(secret) → hex → 追加 signature。
 * 返回里 `canWithdraw` / `canTrade` / `permissions` 正是我们要的三项。
 *
 * 没配密钥时返回 `null` —— 表示"没有可审的对象"，而不是"审出问题"。
 */
async function probeBinance(): Promise<KeyScopeVerdict | null> {
  const key = process.env.BINANCE_TESTNET_API_KEY
  const secret = process.env.BINANCE_TESTNET_API_SECRET
  if (!key || !secret) return null

  const base = (process.env.BINANCE_TESTNET_REST ?? 'https://testnet.binance.vision').replace(/\/+$/, '')
  try {
    const qs = `timestamp=${Date.now()}&recvWindow=5000`
    const sig = createHmac('sha256', secret).update(qs).digest('hex')
    const res = await fetch(`${base}/api/v3/account?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return classifyKeyScope('binance-testnet', await res.json())
  } catch (e) {
    // 网络失败也要落成 unverifiable，而不是让脚本崩掉 ——
    // "问不到"本身就是需要被记录的一种结论
    console.warn(`  ⚠️ binance-testnet 探测失败：${e instanceof Error ? e.message : String(e)}`)
    return classifyKeyScope('binance-testnet', null)
  }
}

/**
 * 问 OKX 账号配置接口要 `perm` 字段。
 *
 * OKX 的返回包了一层信封 `{ code, data: [...] }`，这里把 `data[0]` 取出来 ——
 * 这**不是**"预处理成结论"，只是从信封里取出信；权限判定仍然全部交给
 * `classifyKeyScope`，本文件里不写任何一句 `if (perm === ...)`。
 */
async function probeOkx(): Promise<KeyScopeVerdict | null> {
  const key = process.env.OKX_TESTNET_API_KEY
  const secret = process.env.OKX_TESTNET_API_SECRET
  const pass = process.env.OKX_TESTNET_PASSPHRASE
  if (!key || !secret || !pass) return null

  const path = '/api/v5/account/config'
  try {
    const ts = new Date().toISOString()
    const sign = createHmac('sha256', secret).update(ts + 'GET' + path).digest('base64')
    const res = await fetch(`https://www.okx.com${path}`, {
      headers: {
        'OK-ACCESS-KEY': key,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': pass,
        // 模拟盘标记：同一域名下靠这个头区分
        'x-simulated-trading': '1',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json()) as { data?: unknown }
    const raw = Array.isArray(body?.data) ? body.data[0] : body
    return classifyKeyScope('okx-testnet', raw)
  } catch (e) {
    console.warn(`  ⚠️ okx-testnet 探测失败：${e instanceof Error ? e.message : String(e)}`)
    return classifyKeyScope('okx-testnet', null)
  }
}

async function main(): Promise<void> {
  console.log('')
  console.log('── 密钥权限审计（期望形态：读 ✓ 交易 ✓ 提币 ✗）──')
  console.log('   VENUE =', process.env.VENUE ?? '(未设置)')
  console.log('')

  const probed = await Promise.all([probeBinance(), probeOkx()])
  const verdicts = probed.filter((v): v is KeyScopeVerdict => v !== null)
  const audit = summarizeAudit(verdicts)

  for (const v of verdicts) {
    const icon = v.status === 'ok' ? '✅' : v.status === 'danger' ? '🚨' : '⚠️'
    console.log(`  ${icon} ${v.summary}`)
    for (const r of v.reasons) console.log(`       · ${r}`)
  }
  if (verdicts.length === 0) {
    console.log('  （.env 里没有任何已配置的交易所密钥）')
  }
  console.log('')
  console.log(`  → ${audit.summary}`)
  console.log('')

  const out = {
    generatedAt: new Date().toISOString(),
    venue: process.env.VENUE ?? null,
    status: audit.status,
    exitCode: audit.exitCode,
    summary: audit.summary,
    verdicts,
  }
  const dest = join(ROOT, 'artifacts', 'key-scope.json')
  atomicWriteFile(dest, JSON.stringify(out, null, 2))
  console.log(`  已落盘：${dest.replace(ROOT, '.')}`)
  console.log('')

  // 退出码语义见文件头 —— 1 是"没查到"，不是"查出错"
  process.exit(audit.exitCode)
}

void main()
