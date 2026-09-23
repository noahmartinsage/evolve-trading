/**
 * 一次性探针：**同一个页面实例**上验证「桌宠说的那一次 = 界面上画的那一次」。
 *
 * ── 为什么要单独写它（而不是复用 ui-shot）──────────────────────────────
 * `ui-shot.ts` 每次运行都**新开一个页面实例**、读完就关。于是：
 *   ① 排一条带参数的动作进去，它可能被**上一轮那个还活着的实例**领走（真发生过）；
 *   ② 等我去看屏幕时，看到的是一个**刚加载、什么都没收到**的新实例 ⇒ 结论恒为"没变"。
 * 这不是应用的问题，是**探针的观测点选错了**：要在"收到参数的那个实例"上看结果，
 * 就必须让**同一个实例**从头活到尾。
 *
 * ⇒ 这里 attach 到已在跑的浏览器（CDP 9222）里那个**持久的 4173 页面**，
 *   全程不导航、不重载、不新建。
 *
 * 用法：node scripts/probe-ui-payload.ts
 *   （需要：应用栈在跑 + 一个带 `--remote-debugging-port=9222` 的浏览器）
 */
import { DEFAULT_PORTS } from '../server/stackCore.ts'

const CDP = 'http://127.0.0.1:9222'
const ORCH = 'http://localhost:' + DEFAULT_PORTS.orch
const TOKEN = process.env.ORCH_TOKEN ?? 'dev-insecure-token'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let ws: WebSocket
let msgId = 0
const waiters = new Map<number, (v: unknown) => void>()

interface CdpResult {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string }
}

async function connect(): Promise<string> {
  const list = (await (await fetch(CDP + '/json/list')).json()) as {
    type: string
    id: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const pages = list.filter((t) => t.type === 'page' && t.url.includes(String(DEFAULT_PORTS.web)))
  if (pages.length === 0) throw new Error('没找到 4173 的页面目标（浏览器没起或页面没加载）')
  if (pages.length > 1) {
    console.log('⚠ 有 ' + String(pages.length) + ' 个 4173 页面实例 —— 参数可能被**另一个**领走，观测会失败：')
    for (const p of pages) console.log('    ' + p.url + ' · ' + p.id)
  }
  const page = pages[0]
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })
  ws.onmessage = (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown }
    if (m.id !== undefined && waiters.has(m.id)) {
      waiters.get(m.id)!(m.result)
      waiters.delete(m.id)
    }
  }
  return page.url
}

function cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++msgId
  return new Promise((res) => {
    waiters.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function ev<T>(expr: string): Promise<T> {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })) as CdpResult
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'CDP 求值异常')
  return r.result?.value as T
}

/** 界面上那几个能唯一确定"画的是哪一次"的读数。 */
const READ = `JSON.stringify({
  page: (() => { const e = document.querySelector('.nav-item.active .nav-label'); return e ? e.textContent : null })(),
  onPair: (() => { const e = document.querySelector('.pair-row.on .pr-sym'); return e ? e.textContent : null })(),
  segs: [...document.querySelectorAll('.fc-head .seg button')].map(b => b.textContent + (b.className.includes('on') ? '<ON' : '')),
  fcTitle: (() => { const e = document.querySelector('.fc-card .panel-title'); return e ? e.textContent : null })(),
  fcSvg: document.querySelectorAll('.fc-body svg').length,
  fcErr: (() => { const e = document.querySelector('.fc-err'); return e ? e.textContent : null })(),
  client: document.documentElement.dataset.uiClient || null
})`

async function main(): Promise<void> {
  const url = await connect()
  console.log('已 attach：' + url)
  await cdp('Runtime.enable')

  // 把页面切到交易终端（本项目没有 URL 路由，页面切换靠 Store 字段）
  const clicked = await ev<boolean>(`(() => {
    const items = [...document.querySelectorAll('.nav-item')]
    const t = items.find((el) => (el.textContent || '').includes('交易终端'))
    if (!t) return false
    t.click(); return true
  })()`)
  if (!clicked) throw new Error('侧边栏里没找到「交易终端」')
  for (let i = 0; i < 40; i++) {
    if (await ev<number>(`document.querySelectorAll('.pair-row').length`) > 0) break
    await sleep(300)
  }

  const before = await ev<string>(READ)
  console.log('\n【按下之前】' + before)

  // 排一条**参数与当前屏幕明显不同**的动作：屏幕默认 BTC-USDT / 1小时
  const body = { actionId: 'terminal.forecast.run', payload: { symbol: 'ETHUSDT', minutes: 240 }, by: 'probe-ui-payload' }
  const r = (await (
    await fetch(ORCH + '/ui/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orch-token': TOKEN },
      body: JSON.stringify(body),
    })
  ).json()) as { ok?: boolean; task?: { id?: string; payload?: unknown } }
  if (!r.ok || !r.task?.id) throw new Error('入队失败：' + JSON.stringify(r))
  const taskId = r.task.id
  console.log('已入队 ' + taskId + ' · payload=' + JSON.stringify(r.task.payload))

  // ── 在**同一个实例**上等它变 ──────────────────────────────────────
  const t0 = Date.now()
  let after = before
  let hit = false
  while (Date.now() - t0 < 40_000) {
    after = await ev<string>(READ)
    const j = JSON.parse(after) as { onPair: string | null; segs: string[] }
    if (j.onPair === 'ETH-USDT' && j.segs.some((s) => s.includes('4小时') && s.includes('<ON'))) {
      hit = true
      break
    }
    await sleep(500)
  }
  console.log('【按下之后】' + after + '   （等了 ' + String(Math.round((Date.now() - t0) / 1000)) + ' 秒）')

  // ── 队列那边的回报（"有人真的按了"是另一层证据）────────────────────
  const q = (await (
    await fetch(ORCH + '/ui/actions', { headers: { 'x-orch-token': TOKEN } })
  ).json()) as { tasks?: { id: string; status: string; requestedBy: string; detail?: string }[] }
  const t = (q.tasks ?? []).find((x) => x.id === taskId)
  console.log('队列回报：' + JSON.stringify(t ?? null))

  console.log('\n' + (hit ? '✅ 参数真的驱动了屏幕' : '❌ 屏幕上没看到参数的效果'))
  ws.close()
  process.exit(hit ? 0 : 1)
}

main().catch((e) => {
  console.error('探针失败：' + (e instanceof Error ? e.message : String(e)))
  process.exit(2)
})
