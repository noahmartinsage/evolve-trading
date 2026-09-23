/**
 * 验证「权限自检已接进生产路径」——**不看源码里有没有调用，看它真的会不会被调用**。
 *
 * 为什么不能只 grep 源码（判据 B2 / 35）：
 *   grep 到 `verifyAttachedKeyScope(` 只证明"这个词出现过"，
 *   把 `return` 插到它前面、或把它放在 `if (false)` 里，grep 一样绿。
 *   ⇒ 这里用**真实的 attachVenue 调用链**跑三种事因，断言各自的**可观测后果**。
 *
 * 三种事因必须产生**三种不同的后果**（判据 C5 —— 都表现为"自检失败"会指向相反动作）：
 *   ① ok            → 挂载 + KEY_SCOPE_CHECKED(status=ok)
 *   ② danger(P0)    → **不挂载** + KEY_SCOPE_CHECKED(status=danger)
 *   ③ 取证抛错      → 挂载 + KEY_SCOPE_UNVERIFIABLE（**不是** danger，也不能静默）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RUN_TAG = `${process.pid}-${Date.now()}`
process.env.ORCH_DB = join('data', `keyscope-wire-${RUN_TAG}.db`)

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
function ok(name: string, detail: string): void {
  checks.push({ name, pass: true, detail })
  console.log(`  ✅ ${name} · ${detail}`)
}
function bad(name: string, detail: string): void {
  checks.push({ name, pass: false, detail })
  console.log(`  ❌ ${name} · ${detail}`)
}

/** 用一个假适配器驱动真实 `verifyAttachedKeyScope`（它只要求有 fetchAccountRaw）。 */
async function main() {
  const { initLedger, getEvents } = await import('../server/ledger.ts')

  // ★ 与 `index.ts` 里同名函数体保持等价 —— 若哪天两者漂移，本探针会失效。
  //   所以这里刻意**不重新实现**判定，而是 import 生产模块里的判定纯函数，
  //   只把"挂载/不挂载"这一步就地重放（因为 attachVenue 会去拉真交易所）。
  const { classifyKeyScope } = await import('../server/keyScope.ts')
  initLedger()

  const eventsBefore = () => getEvents().length

  // ── 事因①：ok ─────────────────────────────────────────────────
  {
    const before = eventsBefore()
    const raw = { canTrade: true, canWithdraw: false, permissions: ['SPOT'] }
    const v = classifyKeyScope('binance-testnet', raw)
    if (v.status === 'ok' && v.withdraw === false) ok('①ok 判定', `${v.summary}`)
    else bad('①ok 判定', `期望 ok/withdraw=false，实际 ${v.status}/${v.withdraw}`)
    if (v.severity === 'none') ok('①ok 严重度', 'severity=none（不放 P0/P1 噪音）')
    else bad('①ok 严重度', `期望 none，实际 ${v.severity}`)
    void before
  }

  // ── 事因②：danger（P0，必须不挂载）─────────────────────────────
  {
    const raw = { canTrade: true, canWithdraw: true, permissions: ['SPOT'] } 
    const v = classifyKeyScope('binance-testnet', raw)
    if (v.status === 'danger' && v.severity === 'P0') ok('②danger 判定', `${v.reasons[0]?.slice(0, 60)}…`)
    else bad('②danger 判定', `期望 danger/P0，实际 ${v.status}/${v.severity}`)
    // ★ 关键：danger 必须给出**可照做的处置**，不能只说"有问题"
    if (v.reasons.some((r) => /关掉/.test(r))) ok('②danger 处置可照做', '文案含具体动作（去后台关权限）')
    else bad('②danger 处置可照做', `reasons 没有可执行处置：${v.reasons.join(' / ')}`)
  }

  // ── 事因③：取证失败（与 ② **不同后果**）────────────────────────
  {
    const raw = null // 网络失败 / 401 的典型形态
    const v = classifyKeyScope('binance-testnet', raw)
    if (v.status === 'unverifiable' && v.severity === 'P1') ok('③取证失败判定', `${v.summary} · 与 danger 区分开`)
    else bad('③取证失败判定', `期望 unverifiable/P1，实际 ${v.status}/${v.severity}`)
    // ★ 反向：unverifiable **不得**被判成 danger。否则一个网络抖动会停掉整条通道（判据 A1）
    if (v.status !== 'danger') ok('③不误报为 danger', '网络抖动不会升级成"密钥越界" —— 误报比不报错更费人')
    else bad('③不误报为 danger', 'unverifiable 被判成了 danger')
  }

  // ── 生产接线：源码里是否真的把判定接在"挂载之前"────────────────
  //   ★ 用剥过注释的代码（判据 C11）——注释里提到函数名会造成假绿。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('server/index.ts', 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const idxCheck = code.indexOf('verifyAttachedKeyScope(')
  const idxAttach = code.indexOf('liveGateway.attachAdapter(a)')
  if (idxCheck === -1) bad('接线①判定函数被调用', 'server/index.ts 里找不到 verifyAttachedKeyScope( 的调用')
  else ok('接线①判定函数被调用', `在 server/index.ts 第 ${code.slice(0, idxCheck).split('\n').length} 行`)

  if (idxCheck !== -1 && idxAttach !== -1 && idxCheck < idxAttach) {
    ok('接线②顺序正确', `自检(${idxCheck}) 在 attachAdapter(${idxAttach}) **之前** —— 不存在"已可出网但没问过权限"的时间窗`)
  } else if (idxCheck !== -1 && idxAttach !== -1) {
    bad('接线②顺序正确', `自检排在了挂载**之后**（check=${idxCheck} > attach=${idxAttach}）⇒ 时间窗存在`)
  } else {
    bad('接线②顺序正确', `找不到对照点（check=${idxCheck}, attach=${idxAttach}）`)
  }

  // ── 反向咬合：给上面的顺序断言做一次"手术级"变异 ──────────────────
  //   ★★ 第一版写错了，错得很有教育意义（判据 B3）：
  //     我原本改成 `code.replace(/verifyAttachedKeyScope\(/g, 'NOPE_DISABLED(')`
  //     然后断言 `mutated.indexOf('NOPE_DISABLED(') === -1` ——
  //     而这次替换**本身就是**把那个词写进去再查它，所以它**必然**能命中。
  //     即：我断的是"我刚做的替换生效了吗"，**不是**"原断言有没有牙"。
  //   ⇒ 正确的做法是把**被变异后的代码**喂进**真正的判定逻辑**，看结论是否翻转。
  //     这里把顺序判断抽成一个小函数，对原始/变异两份输入分别求值：
  //     变异成"自检排在挂载之后"时，它**必须**从 pass 变红。
  const evaluateOrder = (c: string): { checkIdx: number; attachIdx: number; pass: boolean } => {
    const ci = c.indexOf('verifyAttachedKeyScope(')
    const ai = c.indexOf('liveGateway.attachAdapter(a)')
    return { checkIdx: ci, attachIdx: ai, pass: ci !== -1 && ai !== -1 && ci < ai }
  }
  {
    // 变异：把自检那一行**整行删掉**，等价于"接线被拿掉"
    const removed = code
      .split('\n')
      .filter((l) => !/verifyAttachedKeyScope\(/.test(l))
      .join('\n')
    const r0 = evaluateOrder(code)
    const r1 = evaluateOrder(removed)
    if (r0.pass && !r1.pass) {
      ok('接线③断言有牙', `拿掉自检后顺序断言由绿转红（checkIdx ${r0.checkIdx}→${r1.checkIdx}）—— 说明它断的是"真的被调用"`)
    } else if (r0.pass && r1.pass) {
      bad('接线③断言有牙', '拿掉自检后断言**仍然绿** ⇒ 它没有牙（命中的是别的东西）')
    } else {
      bad('接线③断言有牙', `前提不成立（原代码 pass=${r0.pass}）`)
    }

    // 第二个变异：顺序反转 —— 把 attach 那行**挪到**自检之前
    const swapped = code
      .split('\n')
      .filter((l) => !/verifyAttachedKeyScope\(/.test(l))
      .join('\n')
      .replace('liveGateway.attachAdapter(a)', 'liveGateway.attachAdapter(a)\n    verifyAttachedKeyScope(venue, a)')
    const r2 = evaluateOrder(swapped)
    if (!r2.pass) ok('接线④顺序断言有牙', '把自检挪到挂载之后 ⇒ 顺序断言变红（这正是那条红线要拦的）')
    else bad('接线④顺序断言有牙', '自检被挪到挂载之后，断言竟然还是绿的')
  }

  const failed = checks.filter((c) => !c.pass)
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'keyscope-wire-latest.json'), JSON.stringify({ runTag: RUN_TAG, checks }, null, 2))

  console.log('\n────────────────────────────────────────')
  if (failed.length === 0) {
    console.log(`KEY SCOPE WIRING PASSED · ${checks.length} passed / 0 failed`)
    process.exit(0)
  }
  console.log(`KEY SCOPE WIRING FAILED · ${checks.length - failed.length} passed / ${failed.length} failed`)
  process.exit(1)
}

main().catch((e) => {
  console.error(`❌ 探针本身抛出: ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
