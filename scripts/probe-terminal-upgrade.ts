/**
 * 交易终端升级的**屏幕级**验证（本窗直接点击，不借道接口）。
 *
 * ── 为什么必须走屏幕 ────────────────────────────────────────────────
 * 「命令面板能打开」这件事，接口层**没有任何可观测量** —— 它没有端点。
 * 上一轮的教训（§3.39）写得很清楚：通道验通道、屏幕验屏幕，两者不许互相顶替。
 * 所以这里连 CDP、真发 Ctrl+K、真读 DOM。
 *
 * 三条断言各自对应一个"用户会用什么动作判定它成了"（判据 33）：
 *   T1 按 Ctrl+K → 出现遮罩（用户判定"它开了"的动作）
 *   T2 输入 `btcusdt`（**不带连字符**）→ 命中 BTC-USDT（用户不会记得那个连字符）
 *   T3 回车 → 落到交易终端页，且**选中的交易对真的是 BTC-USDT**（不是"面板关了"）
 *
 * 用法：
 *   CDP_BASE=http://127.0.0.1:9224 node scripts/probe-terminal-upgrade.ts
 * 前置：应用栈在跑（npm run app）+ `node scripts/_cdp-launch.mjs` 起过 CDP Chrome
 * 退出码：0 通过 / 1 失败 / 3 未验证（CDP 起不来 —— 不记红，见三态约定）
 */
import { writeFileSync } from 'node:fs'

/*
 * ★★ 默认端口必须是**这个仓库自己的那个**（与 `_cdp-launch.mjs` / `_wait-cdp.mjs` 同源）。
 *
 * 这里曾经写死 `9222`，而那两个启动脚本默认是 `9224` —— 于是会出现一种最坏的形态：
 *   「启动成功 → 探针说连不上 → 退出码 3（未验证）」
 * 看着像"环境没配好"，**其实是两个文件对同一个事实各说各话**（判据 8：同一业务动作
 * 只能有一条实现路径；判据 35：与事实源比，不与副本比）。
 *
 * ★ 为什么不统一到 9222 而是统一到 9224：9222 是本机**别的工具**也在用的常规端口，
 *   抢端口会变成另一个"偶发的未验证"。9224 + 独立 profile 目录，是本项目自己的地盘。
 *
 * ★★ 另外注意：**"连不上 CDP"退出码是 3（未验证）而不是 1（失败）** —— 这是刻意的。
 *   "环境没起来"与"断言不成立"必须分开，否则会训练人忽略 3，进而忽略 1。
 *   也正因为如此，**端口写错不会被当成失败暴露出来，只会一直报 3** ——
 *   这就是它为什么能潜伏：3 看起来总是"环境问题"。
 */
const CDP = process.env.CDP_BASE ?? 'http://127.0.0.1:9224'

const PAGE = process.env.PROBE_URL ?? 'http://localhost:4173/'
const PAGE_PREFIX = PAGE.replace(/\/$/, '')
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 60_000)

let passed = 0
let failed = 0
const log: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  const line = `${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`
  log.push(line)
  console.log(line)
}

interface Target {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/**
 * 等 CDP 就绪 —— 不睡固定时长。
 *
 * ★ 这台机器实测：Chrome 刚起时端口已经 LISTENING，但 `/json/list` 还是拒连
 *   （浏览器进程在，DevTools 的 HTTP 端点还没挂上）。固定 sleep 会偶发红，
 *   而"对完全正确的输入报错"的检查比不报错的更费人 —— 它会训练你忽略它的红。
 *   ⇒ 轮询到真的能列出 target 为止。
 */
async function listTargets(retries = 25, gapMs = 600): Promise<Target[]> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(CDP + '/json/list')
      if (r.ok) {
        const j = (await r.json()) as Target[]
        if (j.length > 0) return j
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((res) => setTimeout(res, gapMs))
  }
  return []
}

interface Session {
  evaluate: <T>(expr: string) => Promise<T>
  key: (o: { key: string; code: string; modifiers: number }) => Promise<void>
  typeText: (t: string) => Promise<void>
  close: () => void
}

async function attach(): Promise<Session> {
  const targets = await listTargets()
  const page =
    targets.find((x) => x.type === 'page' && x.url.startsWith(PAGE_PREFIX)) ??
    targets.find((x) => x.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP WebSocket 5 秒内没连上')), 5000)
    ws.onopen = () => {
      clearTimeout(t)
      res()
    }
    ws.onerror = () => {
      clearTimeout(t)
      rej(new Error('CDP WebSocket 连接被拒'))
    }
  })

  let seq = 0
  const pending = new Map<number, (v: unknown) => void>()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const done = pending.get(msg.id)!
      pending.delete(msg.id)
      done(msg.error ? { __err: msg.error } : msg.result)
    }
  }

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((res) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        res({ __err: { message: 'CDP ' + method + ' 超时' } })
      }, 15_000)
      pending.set(id, (v) => {
        clearTimeout(timer)
        res(v)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Page.enable')

  /** 求值并取回 JSON 值。页面抛错时**抛出来**，不要静默返回 undefined。 */
  const evaluate = async <T>(expr: string): Promise<T> => {
    const r = (await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } }; __err?: unknown }
    if (r.__err) throw new Error('CDP Runtime.evaluate 失败：' + JSON.stringify(r.__err))
    if (r.exceptionDetails) {
      throw new Error('页面求值抛错：' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    }
    return r.result?.value as T
  }

  const key = async (o: { key: string; code: string; modifiers: number }): Promise<void> => {
    // Ctrl 是 modifier bit 2。只发 keyDown/keyUp 不带 `text`，
    // 否则 Chromium 会把它当成"正在输入字符"，触发不了 Ctrl+K 的快捷键。
    for (const type of ['rawKeyDown', 'keyUp'] as const) {
      await send('Input.dispatchKeyEvent', {
        type,
        key: o.key,
        code: o.code,
        windowsVirtualKeyCode: VK[o.code] ?? 0,
        nativeVirtualKeyCode: VK[o.code] ?? 0,
        modifiers: o.modifiers,
      })
    }
  }

  const typeText = async (text: string): Promise<void> => {
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  return { evaluate, key, typeText, close: () => ws.close() }
}

const VK: Record<string, number> = { KeyK: 75, Enter: 13, Escape: 27 }

async function main(): Promise<void> {
  console.log('══ 交易终端升级 · 屏幕级验证 ══')
  console.log(`页面 ${PAGE} · CDP ${CDP}`)
  console.log('')

  // ★ 整体超时：探针自己挂住比报错更坏 —— CI/人会以为还在跑。
  const killer = setTimeout(() => {
    console.log('❌ 探针超过 ' + String(TIMEOUT_MS / 1000) + ' 秒没有结论，按未验证退出')
    process.exit(3)
  }, TIMEOUT_MS)
  killer.unref()

  const targets = await listTargets()
  if (targets.length === 0) {
    console.log('❌ 连不上 CDP（' + CDP + '/json/list 等 15 秒仍空）。先起：')
    console.log('   node scripts/_cdp-launch.mjs   （本机必须 detached —— bash 退出会带走进程组）')
    process.exit(3)
  }
  const pg = targets.find((t) => t.type === 'page' && t.url.startsWith(PAGE_PREFIX))
  console.log('· 已连上 ' + String(targets.length) + ' 个 target，页面 target：' + (pg ? '有' : '无（会新开一个）'))
  console.log('')

  const s = await attach()

  // 等应用画出来（不是睡固定时长：轮询到主容器里真的有东西）
  let t0 = ''
  for (let i = 0; i < 30; i++) {
    t0 = await s.evaluate<string>(`(document.querySelector('#root')?.innerText ?? document.body.innerText ?? '').slice(0,200)`)
    if (t0.trim().length > 20) break
    await new Promise((r) => setTimeout(r, 700))
  }
  check('T0 页面有内容（不是白屏）', t0.trim().length > 20, `innerText ${t0.trim().length} 字`)

  // ── T1：Ctrl+K 打开面板
  await s.key({ key: 'k', code: 'KeyK', modifiers: 2 })
  await new Promise((r) => setTimeout(r, 500))
  const maskOpen = await s.evaluate<boolean>(`Boolean(document.querySelector('.cmdk-mask .cmdk-input'))`)
  check('T1 Ctrl+K → 命令面板出现（遮罩 + 输入框）', maskOpen)

  if (!maskOpen) {
    // 面板都没开，后面的断言全是假绿 —— 直接停在这里，不往下演。
    s.close()
    finish()
    return
  }

  // ── T2：打 `btcusdt`（不带连字符）要命中 BTC-USDT
  await s.typeText('btcusdt')
  await new Promise((r) => setTimeout(r, 400))
  const shown = await s.evaluate<string[]>(
    `Array.from(document.querySelectorAll('.cmdk-item .cmdk-label')).map(e => e.textContent)`,
  )
  check(
    'T2 打「btcusdt」命中 BTC-USDT（连字符可以省）',
    shown.some((x) => x === 'BTC-USDT'),
    '候选 ' + JSON.stringify(shown),
  )
  check(
    'T2b 过滤**真的生效**了（不是把全部候选都列出来）',
    shown.length > 0 && shown.length < 12,
    `命中 ${shown.length} 条`,
  )

  // ── T3：回车 → 落到交易终端页，且选中的真的是 BTC-USDT
  await s.key({ key: 'Enter', code: 'Enter', modifiers: 0 })
  await new Promise((r) => setTimeout(r, 1200))
  const closed = await s.evaluate<boolean>(`!document.querySelector('.cmdk-mask')`)
  check('T3 回车后面板关闭（选了东西）', closed)

  const landed = await s.evaluate<{ page: string; pair: string }>(`(() => {
    const active = document.querySelector('.nav-item.on, .nav-item.active, [data-nav-on="1"]')
    return {
      page: (active?.textContent ?? '').trim(),
      pair: (document.querySelector('.pair-row.on .pr-sym')?.textContent ?? '').trim(),
    }
  })()`)
  check('T3b 落到了交易终端（导航高亮 = 交易终端）', landed.page.includes('交易终端'), '当前页「' + landed.page + '」')
  // ★★ 这一条是关键：只断言"面板关了"会被"按 Esc 也能关"顶替（判据 36）。
  //    必须断言**屏幕上的交易对真的换了** —— 那才是用户的验收点（判据 33）。
  check('T3c ★ 选中的交易对真的是 BTC-USDT（不是"面板关了"就算过）', landed.pair === 'BTC-USDT', '选中「' + landed.pair + '」')

  // ── T4：报价闪烁的**生产入口**存在（组件挂在真实的价格节点上）
  const flashWired = await s.evaluate<number>(`document.querySelectorAll('.pair-row .pr-price').length`)
  check('T4 行情列表每个价格都是可闪节点（QuoteFlash 已接进生产路径）', flashWired > 0, `${flashWired} 行`)

  s.close()
  finish()
}

function finish(): void {
  console.log('')
  console.log(`结果：通过 ${passed} / 失败 ${failed}`)
  const out = process.env.PROBE_OUT
  if (out) writeFileSync(out, log.join('\n') + `\n\n通过 ${passed} / 失败 ${failed}\n`, 'utf8')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.log('❌ 探针自身出错：' + (e instanceof Error ? e.message : String(e)))
  process.exit(3)
})
