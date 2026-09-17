/**
 * 密钥权限自检 · 烟测（**纯函数，不联网**）
 *
 * 联网那一半由 `npm run keys:audit` 负责（`scripts/key-scope-audit.ts`），
 * 两者不能互相替代：这里断言的是**判定口径**，那边证明的是**真能问到交易所**。
 *
 * ── 这一组里最重要的一条 ────────────────────────────────────────────
 * 「接口没返回 canWithdraw 字段」必须判成 `unverifiable`，**不是** `ok`。
 * 写反了的话，一把权限未知的钥匙会被标成"安全"，而它照样返回 0、看着一切正常 ——
 * 这正是本项目反复出现的那类缺陷（一个不可能失败的检查）。
 *
 * 用法：npm run test:keyscope
 */

import { classifyKeyScope, summarizeAudit } from '../server/keyScope.ts'
import type { KeyScopeVerdict } from '../server/keyScope.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${name} · ${detail}`)
  } else {
    failed += 1
    failures.push(`${name} :: ${detail}`)
    console.log(`  ❌ ${name} · ${detail}`)
  }
}

function section(title: string): void {
  console.log('')
  console.log(`── ${title} ──`)
}

// ═════════════════════════ 夹具（交易所原样返回的形态）═════════════════════

const BINANCE_SAFE = { canTrade: true, canWithdraw: false, canDeposit: true, permissions: ['SPOT'] }
const BINANCE_DANGER = { canTrade: true, canWithdraw: true, canDeposit: false, permissions: ['SPOT'] }
/** 只缺 canWithdraw —— 这一份是全文件存在的理由。 */
const BINANCE_NO_WITHDRAW_FIELD = { canTrade: true, canDeposit: true, permissions: ['SPOT'] }
/** 类型不对：字符串 'false' 不是布尔 false。不做宽容。 */
const BINANCE_STRING_WITHDRAW = { canTrade: true, canWithdraw: 'false' }

const OKX_READONLY = { perm: 'read_only' }
const OKX_TRADE = { perm: 'read_only,trade' }
const OKX_WITHDRAW = { perm: 'read_only,trade,withdraw' }
const OKX_ONLY_WITHDRAW = { perm: 'withdraw' }

// ═══════════════════════════════════════════════════════════
section('P1 Binance：三态判定')

{
  const safe = classifyKeyScope('binance-testnet', BINANCE_SAFE)
  check(
    'P1 ① canWithdraw=false → ok / 无报警级别',
    safe.status === 'ok' && safe.severity === 'none' && safe.withdraw === false,
    `${safe.status} · severity=${safe.severity} · trade=${safe.trade}`,
  )

  const danger = classifyKeyScope('binance-testnet', BINANCE_DANGER)
  check(
    'P1 ② canWithdraw=true → danger / P0',
    danger.status === 'danger' && danger.severity === 'P0' && danger.withdraw === true,
    `${danger.status} · severity=${danger.severity}（P0 不参与任何压制，必须能被播报出去）`,
  )

  // ★★ 全文件最重要的一条 ★★
  const unknown = classifyKeyScope('binance-testnet', BINANCE_NO_WITHDRAW_FIELD)
  check(
    'P1 ③ 缺 canWithdraw 字段 → unverifiable（**不是 ok**）',
    unknown.status === 'unverifiable' && unknown.severity === 'P1',
    unknown.status === 'ok'
      ? '判成了 ok —— 「没看到」被当成了「没有」，这正是这一类缺陷唯一会出现的形态'
      : `${unknown.status} · severity=${unknown.severity} · ${unknown.reasons[0]}`,
  )

  const strFalse = classifyKeyScope('binance-testnet', BINANCE_STRING_WITHDRAW)
  check(
    'P1 ④ canWithdraw="false"（字符串）→ unverifiable，不做类型宽容',
    strFalse.status === 'unverifiable',
    `${strFalse.status} —— 只有真布尔值才算"看到"，宽容解析会让一个畸形返回装成"已确认"`,
  )

  check(
    'P1 ⑤ 能读到账号即证明有读权限',
    safe.read === true && unknown.read === true,
    'read 不是从响应里"推断"出来的，是"刚才确实读到了"这件事本身',
  )
}

// ═══════════════════════════════════════════════════════════
section('P2 OKX：单字段 perm 的四种形态')

{
  const ro = classifyKeyScope('okx-testnet', OKX_READONLY)
  check(
    'P2 ① perm="read_only" → ok 但 trade=false',
    ro.status === 'ok' && ro.trade === false && ro.withdraw === false,
    '只读钥匙可用（查仓不受影响），但要如实标出不能交易',
  )

  const tr = classifyKeyScope('okx-testnet', OKX_TRADE)
  check(
    'P2 ② perm="read_only,trade" → ok / trade=true',
    tr.status === 'ok' && tr.trade === true && tr.withdraw === false,
    '这是期望形态：读 ✓ 交易 ✓ 提币 ✗',
  )

  const wd = classifyKeyScope('okx-testnet', OKX_WITHDRAW)
  check(
    'P2 ③ perm 含 withdraw → danger / P0',
    wd.status === 'danger' && wd.severity === 'P0',
    `${wd.summary}`,
  )

  const only = classifyKeyScope('okx-testnet', OKX_ONLY_WITHDRAW)
  check(
    'P2 ④ perm="withdraw"（单独一项）也能识别',
    only.status === 'danger' && only.withdraw === true,
    '按逗号切分后逐项比对，不做子串匹配 —— 子串匹配会把 "read_only_withdraw_disabled" 这类值误判成危险或安全',
  )

  const empty = classifyKeyScope('okx-testnet', { perm: '' })
  check(
    'P2 ⑤ perm 为空字符串 → unverifiable',
    empty.status === 'unverifiable',
    '空字符串是"没有内容"，不是"没有权限"',
  )
}

// ═══════════════════════════════════════════════════════════
section('P3 缺证据一律不放行（fail-closed）')

{
  const cases: [string, string, unknown][] = [
    ['未知交易所', 'some-exchange', { canWithdraw: false, canTrade: true }],
    ['空响应', 'binance-testnet', null],
    ['数组响应', 'binance-testnet', []],
    ['字符串响应', 'binance-testnet', 'ok'],
    ['OKX 缺 perm', 'okx-testnet', { acctLv: '1' }],
    ['OKX perm 非字符串', 'okx-testnet', { perm: 3 }],
  ]
  let allUnverifiable = true
  const seen: string[] = []
  for (const [label, venue, raw] of cases) {
    const v = classifyKeyScope(venue, raw)
    seen.push(`${label}=${v.status}`)
    if (v.status !== 'unverifiable' || v.severity !== 'P1') allUnverifiable = false
  }
  check(
    'P3 ① 六种"问不到 / 认不出"的输入全部落到 unverifiable',
    allUnverifiable,
    seen.join(' · '),
  )

  // 「不认识这个交易所」尤其要注意：认不得的返回格式里可能正好藏着 Withdraw ✓
  const unknownVenue = classifyKeyScope('some-exchange', { canWithdraw: false })
  check(
    'P3 ② 未知交易所不得因为"字段看着像没问题"而放行',
    unknownVenue.status === 'unverifiable' && unknownVenue.reasons[0].includes('不认识'),
    unknownVenue.reasons[0],
  )

  /**
   * 「非 ok 的结论必须带得出级别」。
   *
   * 夹具里**不能放 ok 的样本** —— ok 的 severity 本该是 none，
   * 混进来会让这条断言永远红（第一版就是这么写的）。
   * 这里要问的是另一件事：unverifiable 与 danger 会不会被静默降级成 none。
   */
  const nonOkCases: [string, unknown][] = [
    ['binance-testnet', BINANCE_NO_WITHDRAW_FIELD],
    ['okx-testnet', { perm: '' }],
    ['okx-testnet', OKX_WITHDRAW],
    ['binance-testnet', null],
  ]
  const bad = nonOkCases
    .map(([venue, raw]) => classifyKeyScope(venue, raw))
    .filter((v) => v.status === 'ok' || v.severity === 'none')
  // 说明串一律字符串拼接：本机 Node 类型擦除解析器吃不下嵌套模板串（ERR_INVALID_TYPESCRIPT_SYNTAX）
  const badDesc = bad.map((v) => v.venue + '=' + v.status + '/' + v.severity).join('、')
  check(
    'P3 ③ unverifiable / danger 都不退化成 severity=none',
    bad.length === 0,
    bad.length === 0
      ? String(nonOkCases.length) + ' 个非 ok 样本各自带 P0/P1 —— 查到了就一定说'
      : '有 ' + String(bad.length) + ' 个样本退化：' + badDesc,
  )
}

// ═══════════════════════════════════════════════════════════
section('P4 调用方无从自报结论')

{
  // 塞一个 status:'ok' 结论字段进去，判定必须**完全不变** ——
  // 这说明函数只认可观测量（raw），不读任何自报结论。
  const withClaim = classifyKeyScope('binance-testnet', {
    ...BINANCE_DANGER,
    status: 'ok',
    safe: true,
    withdrawAllowed: false,
  })
  const withoutClaim = classifyKeyScope('binance-testnet', BINANCE_DANGER)
  check(
    'P4 ① 入参里塞 status:"ok" 之类的结论字段不影响判定',
    withClaim.status === withoutClaim.status && withClaim.status === 'danger',
    `带结论字段=${withClaim.status} · 不带=${withoutClaim.status} —— 伪造结论无法把「不过」变成「通过」`,
  )

  const v = classifyKeyScope('okx-testnet', OKX_WITHDRAW)
  check(
    'P4 ② summary 里不得出现 [object Object]',
    !v.summary.includes('[object Object]'),
    '这句话会被 narrator 念出来 —— 未格式化的对象在语音里就是一段噪音',
  )

  const mentions = ['binance-testnet', 'okx-testnet'].every((venue) => {
    const s = classifyKeyScope(venue, venue.includes('okx') ? OKX_TRADE : BINANCE_SAFE).summary
    return s.includes(venue) && s.includes('读') && s.includes('交易') && s.includes('提币')
  })
  check(
    'P4 ③ summary 含交易所名与三项权限，可供直接播报',
    mentions,
    classifyKeyScope('okx-testnet', OKX_TRADE).summary,
  )
}

// ═══════════════════════════════════════════════════════════
section('P5 聚合器：最坏一条决定整体')

{
  const mk = (venue: string, raw: unknown): KeyScopeVerdict => classifyKeyScope(venue, raw)

  const empty = summarizeAudit([])
  check(
    'P5 ① 空集合 → unverifiable / exit 1（**不是 ok**）',
    empty.status === 'unverifiable' && empty.exitCode === 1,
    '一把都没审过，不能得出"安全" —— 这是本模块唯一容易写反的地方，写反了它照样返回 0',
  )

  const allOk = summarizeAudit([mk('binance-testnet', BINANCE_SAFE), mk('okx-testnet', OKX_TRADE)])
  check(
    'P5 ② 全 ok → exit 0',
    allOk.status === 'ok' && allOk.exitCode === 0,
    allOk.summary,
  )

  const hasDanger = summarizeAudit([mk('binance-testnet', BINANCE_SAFE), mk('okx-testnet', OKX_WITHDRAW)])
  check(
    'P5 ③ 有一把 danger → 整体 danger / exit 2',
    hasDanger.status === 'danger' && hasDanger.exitCode === 2,
    hasDanger.summary,
  )

  const hasUnknown = summarizeAudit([mk('binance-testnet', BINANCE_SAFE), mk('okx-testnet', { acctLv: '1' })])
  check(
    'P5 ④ 有一把未确认 → 整体 unverifiable / exit 1',
    hasUnknown.status === 'unverifiable' && hasUnknown.exitCode === 1,
    hasUnknown.summary,
  )

  const mixed = summarizeAudit([
    mk('okx-testnet', OKX_WITHDRAW),
    mk('binance-testnet', BINANCE_NO_WITHDRAW_FIELD),
  ])
  check(
    'P5 ⑤ danger 优先于 unverifiable',
    mixed.status === 'danger' && mixed.exitCode === 2,
    '越界比未确认更紧急：未确认可以慢慢查，提币权限是现在就能动的钱',
  )
}

// ═══════════════════════════════════════════════════════════
console.log('')
console.log('────────────────────────────────────────')
console.log(`KEY SCOPE ${failed === 0 ? 'PASSED' : 'FAILED'} · ${passed} passed / ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('────────────────────────────────────────')

process.exit(failed === 0 ? 0 : 1)
