/**
 * 界面取证：起一个无头 Chrome，切到指定页面，截图 + 把屏幕上的文字抓回来。
 *
 * ══ 为什么要留成正式脚本，而不是每轮写一个一次性的 ═══════════════════════
 * 「看一眼界面」这件事本仓库做过很多轮，每次都是一次性的 `_shot*.mjs`，
 * 用完删掉，下一轮从零再写一遍 —— 于是每次都重新踩同一串坑：
 *   · `chrome --headless --screenshot=…` 在本机**必然** `Abnormal renderer termination`，
 *     只有 CDP 那条路能用（本机实测，`--headless` 与 `--headless=new` 一样）；
 *   · 本系统**没有 URL 路由**，切页面靠 Store 字段 ⇒ 只能点了侧边栏才算真的到了那一页；
 *   · 截完必须 `taskkill /T /F`，否则残留子进程占住 9222，下一次连不上。
 * 这三条都在下面按顺序实现了。
 *
 * ══ 用法 ═════════════════════════════════════════════════════════════════
 *   node scripts/ui-shot.ts --page 新闻雷达 --out _shot_news.png
 *   node scripts/ui-shot.ts --page 因子生产线 --width 1600 --height 1000
 *   node scripts/ui-shot.ts --url http://localhost:4173 --page 舰队 --keep
 *   node scripts/ui-shot.ts --page 交易大厅 --click 算一次 --wait-sel '.fc-card svg' --text-sel .fc-card --scale 2 --out _shot_fc.png
 *
 * ★ `--click` / `--wait-sel` 是"切到那一页"与"那一页上的一件事真的发生了"的分界。
 *   很多卡在**没操作过之前是一张空壳**（走势预测卡就是这样）：只切页截出来的是
 *   "还没算"，而那张图看起来完全正常 —— 于是它会被当成"功能已经验证过了"。
 *   ★ 等选择器出现而不是固定 sleep：实测预测一次要 5~7 秒，
 *   固定 sleep 要么白等、要么截到"算中…"（判据 16 的同族：预算不该与耗时同量级）。
 *
 * ★ **刻意不进 CI**：它会拉起一个浏览器进程（外部依赖 + 会抢 9222 端口），
 *   而门禁必须在任何一台机器上都能安静地跑。
 *
 * ★ 它不只截图：还会把 `.content-area` 的可见文字抓回来打印。
 *   理由是**截图会骗人**（同一张图在不同 DPI/缩放下看着都"挺正常"），
 *   而"这句话到底在不在屏幕上"用文字断言更可靠 —— 两者一起看才叫取证。
 */
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
/** 同一个开关写多次时**全都收下**（按出现顺序）。`--click` 需要它：先选标的、再按算一次。 */
function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    const v = process.argv[i + 1]
    if (a === `--${name}` && v && !v.startsWith('--')) out.push(v)
  })
  return out
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const url = arg('url', 'http://localhost:4173')
const page = arg('page', '')
const out = arg('out', '')
const width = Number(arg('width', '1600'))
const height = Number(arg('height', '1000'))
const port = Number(arg('port', '9222'))
const settleMs = Number(arg('settle', '2200'))
/** 页内要按下的那些元素的**可见文字**（按出现顺序依次按；完全相等优先，退化为包含）。 */
const clicks = args('click')
/** 按完等它出现的选择器；不出现就**报错**，不截一张"还没算"的图当成功。
 *  ★ 支持 CSS 选择器列表（`,`），于是可以写"出现成功态**或**错误态任一个都算" ——
 *    这在排查"点了之后静默没反应"时是必要的：只等成功态会超时，
 *    而超时**只说没成功，不说为什么**。 */
const waitSel = arg('wait-sel', '')
/** 按下之后先干等多久（毫秒）。用于"没有明确的出现物、但需要给它一点时间"的场合。 */
const afterMs = Number(arg('after', '0'))
/** 抓正文的范围。默认整页；看某张卡时给它，省得正文被别处的字挤掉。 */
const textSel = arg('text-sel', '.content-area')
/**
 * 额外求值一句 JS 并把结果打出来（可写多次）。
 * ★ 这是本脚本里**唯一**能回答"它到底多高/什么颜色"的口子 ——
 *   截图会骗人（同一张图在不同缩放下看着都"挺正常"），`getBoundingClientRect()`
 *   与 `getComputedStyle()` 不会。例：
 *   `--eval "JSON.stringify([...document.querySelectorAll('.fc-card .fc-body')].map(n=>n.clientHeight))"`
 */
const evals = args('eval')
/** 放大倍数。图里的 9px 小字在 1 倍下看不清，看图表时给 2。 */
const scale = Number(arg('scale', '1'))

/** CDP 的最小客户端。只做这一步要做的事，不做通用封装。 */
class Cdp {
  private ws: WebSocket
  private id = 0
  private waiters = new Map<number, (v: unknown) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string } }
      if (typeof msg.id !== 'number') return
      const w = this.waiters.get(msg.id)
      if (!w) return
      this.waiters.delete(msg.id)
      w(msg.error ? { __err: msg.error.message } : msg.result)
    })
  }

  static connect(wsUrl: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      ws.addEventListener('open', () => resolve(new Cdp(ws)))
      ws.addEventListener('error', () => reject(new Error('连不上 CDP socket')))
    })
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(id, (v) => {
        const r = v as { __err?: string }
        if (r && r.__err) reject(new Error(`${method} 失败：${r.__err}`))
        else resolve(v as T)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(`页面里这句报错：${r.exceptionDetails.text ?? ''}`)
    return r.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForHttp(urlStr: string, timeoutMs: number): Promise<unknown> {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(urlStr, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return await r.json()
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${urlStr} 在 ${timeoutMs}ms 内没起来`)
    await sleep(250)
  }
}

async function main(): Promise<void> {
  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
  if (!chrome) {
    console.error('找不到 Chrome，试过这些路径：\n  ' + CHROME_CANDIDATES.join('\n  '))
    process.exit(1)
  }
  if (out === '' && !has('keep')) {
    console.error('要给出 --out <png 路径>（否则截完无处可放）')
    process.exit(1)
  }

  const profile = mkdtempSync(join(tmpdir(), 'evolve-ui-shot-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  let cdp: Cdp | null = null
  try {
    const list = (await waitForHttp(`http://127.0.0.1:${port}/json/list`, 20_000)) as {
      type: string
      webSocketDebuggerUrl?: string
    }[]
    const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!target?.webSocketDebuggerUrl) throw new Error('Chrome 起来了但没有可用的 page target')

    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    await cdp.send('Page.navigate', { url })

    // 等应用真的渲染出来（不是等 load 事件 —— 那是空壳，React 还没挂上）。
    const t0 = Date.now()
    for (;;) {
      const ready = await cdp.eval<number>('document.querySelectorAll(".nav-item, .sidebar, .content-area").length')
      if (typeof ready === 'number' && ready > 0) break
      if (Date.now() - t0 > 25_000) throw new Error('页面 25 秒内没渲染出应用骨架（是不是 4173 没在服务 dist/？）')
      await sleep(300)
    }

    // ★ 本系统没有 URL 路由：切页面只能点侧边栏。点不到就说点不到，
    //   不要"截当前页然后当作已切过去" —— 那张图看起来完全正常。
    if (page !== '') {
      const clicked = await cdp.eval<string>(`(() => {
        const want = ${JSON.stringify(page)}
        const nodes = [...document.querySelectorAll('.nav-item, button, a')]
        const hit = nodes.find((n) => (n.textContent || '').trim().includes(want))
        if (!hit) return 'NOT_FOUND'
        hit.click()
        return 'CLICKED:' + (hit.textContent || '').trim()
      })()`)
      if (clicked === 'NOT_FOUND') {
        const navs = await cdp.eval<string>(`[...document.querySelectorAll('.nav-item')].map(n=>(n.textContent||'').trim()).join(' | ')`)
        throw new Error(`侧边栏里找不到「${page}」。现有项：${navs}`)
      }
      console.log(`已切到：${clicked.replace('CLICKED:', '')}`)
    }

    await sleep(settleMs)

    // ★ 页内依次按几个元素。与"切页面"是两件事：切过去只保证**那张卡在屏幕上**，
    //   不保证卡里**有东西**。空壳与算完的卡长得一样整齐。
    for (const click of clicks) {
      const hit = await cdp.eval<string>(`(() => {
        const want = ${JSON.stringify(click)}
        const txt = (n) => (n.textContent || '').trim()
        // ★ 不限于 <button>：本项目里不少可点元素是 div（如交易对行 .pair-row）。
        //   取**最深**的命中者 —— 点它的文字子节点，事件照样冒泡到父级的 onClick，
        //   而点父容器可能落到容器自己的 padding 上、或点到同容器里另一个可点区域。
        const all = [...document.querySelectorAll('.content-area *, button, [role=button]')]
        const exact = all.filter((n) => txt(n) === want)
        const pool = exact.length > 0 ? exact : all.filter((n) => txt(n).includes(want))
        if (pool.length === 0) return 'NOT_FOUND'
        const el = pool.find((n) => !pool.some((m) => m !== n && n.contains(m))) ?? pool[0]
        el.click()
        return 'CLICKED:' + txt(el).slice(0, 40)
      })()`)
      if (hit === 'NOT_FOUND') {
        const labels = await cdp.eval<string>(
          `[...document.querySelectorAll('button, [role=button], .pair-row, .nav-item')].map(n=>(n.textContent||'').trim().slice(0,24)).filter(Boolean).join(' | ')`,
        )
        throw new Error(`页面里找不到可点元素「${click}」。屏幕上现有：${labels}`)
      }
      console.log(`已按下：${hit.replace('CLICKED:', '')}`)
      await sleep(500) // 让这一次点击引发的状态更新先落定，再按下一个
    }

    if (afterMs > 0) await sleep(afterMs)

    // ★ 等某样东西**真的出现在 DOM 里**再截。等不到就报错 ——
    //   报错会让人去看，而一张"还没算"的图会让人以为已经验证过了。
    if (waitSel !== '') {
      const t1 = Date.now()
      for (;;) {
        const n = await cdp.eval<number>(`document.querySelectorAll(${JSON.stringify(waitSel)}).length`)
        if (typeof n === 'number' && n > 0) {
          console.log(`等到 ${waitSel}（${n} 个）`)
          break
        }
        if (Date.now() - t1 > 60_000) throw new Error(`等 ${waitSel} 超时 60 秒 —— 它始终没出现`)
        await sleep(400)
      }
      await sleep(600) // 收尾：布局/过渡动画
    }

    // 屏幕上到底有什么字 —— 截图之外的第二个证据。
    const text = await cdp.eval<string>(
      `(document.querySelector(${JSON.stringify(textSel)})?.innerText ?? document.body.innerText ?? '').replace(/\\n{2,}/g,'\\n')`,
    )
    console.log(`──── 页面上可见的文字（${textSel}，前 2200 字）────`)
    console.log(text.slice(0, 2200))
    console.log('──── 完 ────')

    for (const expr of evals) {
      const v = await cdp.eval<unknown>(expr)
      console.log(`──── eval：${expr.slice(0, 90)}${expr.length > 90 ? '…' : ''}`)
      console.log(typeof v === 'string' ? v : JSON.stringify(v))
      console.log('──── 完 ────')
    }

    if (out !== '') {
      const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      writeFileSync(out, Buffer.from(shot.data, 'base64'))
      console.log(`截图已落盘：${out}（${width}x${height}）`)
    }
  } finally {
    cdp?.close()
    // ★ 必须连子进程一起收掉：只 kill 父进程会残留渲染进程占住调试端口，
    //   下一次跑就会连到上一个浏览器上（而它显示的是上一次的页面）。
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
      else child.kill('SIGKILL')
    } catch {
      /* 已经退出了 */
    }
  }
}

main().catch((e) => {
  console.error('[FAIL] ' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
