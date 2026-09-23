/**
 * 端到端验证：桌宠排的动作**真的落到了界面上**
 *
 * ★ 一次性探针，**刻意不进 CI**：它需要一个活着的应用（8790/4173）与一个无头浏览器（CDP 9222）。
 *   与 `factors:run` / `pet:smoke` 同族 —— 有副作用或依赖外部活体的脚本不进链。
 *
 * ★ 为什么这条验证不可省：
 *   通道的每一层（注册表 / 端点 / 队列 / 执行器）单独看都绿，
 *   但"桌宠排了 → 界面真的按了"是**跨进程的一件事**。
 *   判据 10 说的"有端点 ≠ 有人读"正是这个形状：不跑一次，就分不清
 *   "通道通了"与"通道写好了但没人用"。
 *
 * ★ 它读的是**DOM 的真实状态**（侧边栏哪个 nav-item 带 active），
 *   不是我自己的日志 —— 日志会说"我点了"，DOM 才能说"界面真的动了"。
 *   同一条纪律：截图会骗人，真实 DOM 不会。
 *
 * ── 三态：通过 / 失败 / **未验证**（这是本脚本最要紧的一处设计）──────────
 *
 * 应用同时可以开多个窗口（启动器会在默认浏览器打开面板，桌宠窗是另一个）。
 * 而队列是**取活即认领**的：哪一窗先轮询到，就哪一窗按。
 * 于是"我排了 → 队列说已按下 → 可我这个窗口的界面没动"有两种事因：
 *   ① 通道坏了（要修代码）；
 *   ② 活被另一个窗口领走了，那边**确实**按了（什么都不用做）。
 * 这两件事在队列里长得**一模一样**（都是 `done`），而下一步动作相反。
 *
 * 所以本脚本：
 *   · 读到自己这一窗的 id（执行器挂在 `document.documentElement.dataset.uiClient`）；
 *   · 比对执行记录里的 `requestedBy`：
 *       是自己 → 才断言 DOM（这是唯一的强证据）；
 *       是别人 → 记 **未验证**并说明原因（**不是**红 —— 红会训练人忽略它）。
 * 判据 24 的落地形态：不把「两件事因」压成一个 boolean。
 */
import { UI_ACTIONS } from '../server/uiActions.ts'

const ORCH = 'http://127.0.0.1:8790'
const TOKEN = process.env.ORCH_TOKEN ?? 'dev-insecure-token'
const CDP = 'http://127.0.0.1:9222'

let pass = 0
let fail = 0
let skipped = 0
const bad: string[] = []
const skips: string[] = []
function ok(id: string, cond: boolean, note: string): void {
  if (cond) {
    pass++
    console.log(`  ✅ ${id} ${note}`)
  } else {
    fail++
    bad.push(`${id} ${note}`)
    console.log(`  ❌ ${id} ${note}`)
  }
}
/** **未验证**：不是通过，也不是失败。理由必须写出来，否则它会变成一块遮羞布。 */
function skip(id: string, note: string): void {
  skipped++
  skips.push(`${id} ${note}`)
  console.log(`  ⏭️ ${id} 未验证：${note}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(ORCH + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-orch-token': TOKEN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  try {
    return { __status: res.status, ...(JSON.parse(text) as Record<string, unknown>) }
  } catch {
    return { __status: res.status, raw: text.slice(0, 300) }
  }
}

interface TaskView {
  id: string
  actionId: string
  status: 'pending' | 'claimed' | 'done' | 'failed'
  stale: boolean
  detail?: string
  /** 认领/回报这一条动作的窗口 id。用来分辨"谁真的按了"。 */
  requestedBy?: string
}
async function tasks(): Promise<TaskView[]> {
  return ((await api('/ui/actions')).tasks as TaskView[]) ?? []
}
async function findTask(id: string): Promise<TaskView | undefined> {
  return (await tasks()).find((t) => t.id === id)
}
/** 等一条任务到终态。超时而不是死等 —— 卡住的通道要**报出来**，不能挂在这里。 */
async function waitStatus(id: string, want: TaskView['status'], ms = 25_000): Promise<TaskView | undefined> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const t = await findTask(id)
    if (t && t.status === want) return t
    await sleep(400)
  }
  return await findTask(id)
}

// ───────────────────────── CDP ─────────────────────────

// Node 22 自带全局 WebSocket，不用装包。
let ws: WebSocket
let msgId = 0
const waiters = new Map<number, (v: unknown) => void>()

async function cdpConnect(): Promise<string> {
  const list = (await (await fetch(CDP + '/json/list')).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const page = list.find((t) => t.type === 'page' && t.url.includes('4173'))
  if (!page) throw new Error('没找到 4173 的页面目标（浏览器没起或页面没加载）')
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

async function evalJs<T>(expr: string): Promise<T> {
  const r = (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T }
    exceptionDetails?: { text?: string }
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'CDP 求值异常')
  return r.result?.value as T
}

/** 当前侧边栏选中的是哪一页 —— 这是**界面真的动了**的证据。 */
async function activePage(): Promise<string | null> {
  return await evalJs<string | null>(
    `(() => { const el = document.querySelector('.nav-item.active'); if (!el) return null;
      const t = el.querySelector('.nav-label'); return t ? t.textContent : null; })()`,
  )
}

/**
 * 等界面切到某一页 —— **轮询到变化或超时**，而不是读一次就下结论。
 *
 * ★ 为什么必须改成轮询（这条是实测抓出来的）：
 *   第一版是 `await sleep(500); after = await activePage()` —— 它在两次运行里
 *   给出了相反的结果（同一份代码，一次绿一次红）。界面切页要经过
 *   HTTP 轮询（最多 2s）+ React 提交两跳，固定 sleep 就是在赌这两跳的耗时。
 *   **一条会随机变红的门禁比没有门禁更贵**：它会训练你忽略它的红。
 */
async function waitPage(want: string, ms = 20_000): Promise<string | null> {
  const t0 = Date.now()
  let cur = await activePage()
  while (Date.now() - t0 < ms) {
    if (cur === want) return cur
    await sleep(300)
    cur = await activePage()
  }
  return cur
}

/** 把本窗口切到总览页。**直接点侧边栏**，不经过按钮通道 —— E7 验的是
 *  "后端状态翻了，屏幕跟不跟"，通道在这里是干扰项（谁抢到执行权会让结果随机）。 */
async function gotoOverview(): Promise<boolean> {
  const clicked = await evalJs<boolean>(
    `(() => { const items = [...document.querySelectorAll('.nav-item')];
       const t = items.find((e) => (e.textContent || '').includes('总览'));
       if (!t) return false; t.click(); return true; })()`,
  )
  if (clicked) await waitPage('总览', 15_000)
  return clicked
}

/** 总览那颗启停按钮**现在**写着什么字。按 `data-ui` 前缀取，不靠 DOM 位置。 */
async function apButtonText(): Promise<string> {
  return await evalJs<string>(
    `(() => { const b = document.querySelector('[data-ui^="overview.autopilot."]');
       return b ? (b.textContent || '').trim() : '(找不到按钮)'; })()`,
  )
}

/**
 * 等按钮文案满足条件 —— **轮询到变化或超时**，不许读一次就下结论。
 *
 * ★ 前端读的是 4 秒一轮的状态轮询，所以"后端已经翻了、屏幕上还没翻"是一个
 *   **正常的中间态**，时长有几百毫秒到 4 秒不等。固定 sleep 就是在赌它 ——
 *   而会随机变红的门禁比没有门禁更贵（它会训练人忽略它的红）。
 */
async function waitApButton(pred: (t: string) => boolean, ms = 15_000): Promise<string> {
  const t0 = Date.now()
  let cur = await apButtonText()
  while (Date.now() - t0 < ms) {
    if (pred(cur)) return cur
    await sleep(400)
    cur = await apButtonText()
  }
  return cur
}

/** 队列尾部几条，只为失败时留证。 */
async function dumpTail(n = 6): Promise<string> {
  const all = await tasks()
  return all
    .slice(-n)
    .map((t) => `${t.actionId}[${t.status}/${t.requestedBy ?? '?'}]${t.detail ? ':' + t.detail.slice(0, 30) : ''}`)
    .join(' | ')
}

interface RunAttempt {
  /** 至少有一次入队成功。 */
  enqueued: boolean
  /** 至少有一次被执行到终态。 */
  ran: boolean
  /** 有没有**某一次是本窗口**执行的 —— 只有这种情况才能断言 DOM。 */
  wonByMe: boolean
  /** 本窗执行那一次结束时的页面（没抢到时为 null）。 */
  page: string | null
  /** 最后一次的执行者，失败时要写出来。 */
  lastWho: string
  lastDetail: string
}

/**
 * 排一条动作并等它被执行；**抢到执行权才验界面**，抢不到就重试。
 *
 * ★ 为什么要重试而不是直接判红：应用可以同时开多个窗口，
 *   而执行权是"谁先轮询到归谁"。本脚本能在无头页里读 DOM，
 *   所以只有"本窗执行"的那一次才构成证据。抢不到是**环境**问题（判据 24），
 *   重试几次就能把随机性压掉；仍抢不到就记"未验证"，不记红。
 */
async function tryRun(actionId: string, wantPage: string, myClient: string, tries = 4): Promise<RunAttempt> {
  const out: RunAttempt = { enqueued: false, ran: false, wonByMe: false, page: null, lastWho: '?', lastDetail: '' }
  for (let i = 1; i <= tries; i++) {
    const r = await api('/ui/actions', { actionId, by: 'e2e' })
    if (r.ok !== true) continue
    out.enqueued = true
    const id = String((r.task as TaskView | undefined)?.id ?? '')
    const t = await waitStatus(id, 'done', 12_000)
    if (t?.status === 'done') out.ran = true
    out.lastWho = String(t?.requestedBy ?? '?')
    out.lastDetail = String(t?.detail ?? '')
    if (t?.requestedBy === myClient) {
      out.wonByMe = true
      out.page = await waitPage(wantPage, 12_000)
      return out
    }
    console.log(`     ↳ 第 ${i} 次被另一窗领走（${out.lastWho}），重试`)
  }
  return out
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  console.log('\n端到端：桌宠排的动作有没有真的落到界面上\n')

  // ── E00 环境自检：三样都得活着，否则后面的红都是假红 ──
  //
  // ★ 这里原先写的是 `health.actions.length === 20`。
  //   本轮注册表加了第 21 颗按钮（`terminal.gate.precheck`），它**立刻变成一个假红** ——
  //   而它的红与"通道坏了"长得一模一样。这正是判据 2 说的那种检查：
  //   **对正确的输入报错**，比不报错更费人，因为它会训练你忽略它的红。
  //   ⇒ 改成与**注册表本身**比（不是与一个抄在脚本里的数字比）：
  //     两个数来自同一个事实源，就不会再随注册表长大而失配；
  //     而"端点少返回了一条"这类真实故障照样会被抓到。
  const health = await api('/ui/actions')
  ok(
    'E00a',
    health.__status === 200 && Array.isArray(health.actions) && health.actions.length === UI_ACTIONS.length,
    `编排端点活着且登记 ${UI_ACTIONS.length} 颗按钮（status=${String(health.__status)}）`,
  )
  const url = await cdpConnect()
  ok('E00b', url.includes('4173'), `无头浏览器已连上并停在 ${url}`)
  await cdp('Runtime.enable')
  // ★ 先硬刷新一次：应用刚重启过，页面上那份 JS 是**上一轮构建的**。
  //   不刷新的话，"按钮没动"既可能是通道坏了，也可能只是页面还是旧代码 ——
  //   两种事因长得一模一样、动作相反（判据 24），所以宁可多花几秒。
  await cdp('Page.enable')
  await cdp('Page.reload', { ignoreCache: true })
  await sleep(3500)
  // 刷新后 WebSocket 目标不变，但页面上下文换了 —— 重连一次最稳。
  ws.close()
  await cdpConnect()
  await cdp('Runtime.enable')
  // ★ 等**应用真正就位**再动手：第一版没等，E1c 红了一次、重跑又绿了。
  //   真因是应用首屏渲染之后还有一段异步初始化，它会把自己重置回默认页 ——
  //   于是"我刚点过去的页面"被初始化覆盖回来，看起来像"按钮没生效"。
  //   这是**测试的**问题（在应用没就位时动手），不是通道的问题。
  for (let i = 0; i < 40; i++) {
    const n = await evalJs<number>(`document.querySelectorAll('.nav-item').length`).catch(() => 0)
    if (n >= 14) break
    await sleep(300)
  }
  const p1 = await activePage()
  await sleep(1500)
  const p2 = await activePage()
  ok('E00c', p1 !== null && p1 === p2, `应用已就位且当前页稳定（${String(p1)}）`)

  // ★ 这一窗的 id：没有它就无法区分"我没动"与"别人动了"（见文件头三态说明）。
  const myClient = await evalJs<string>(`document.documentElement.dataset.uiClient || ''`)
  ok('E00d', /^ui-[0-9a-f]{8}$/.test(myClient), `读到本窗口的执行器 id（${myClient || '空'}）—— 没有它就无法分辨"谁按的"`)

  const base = (await tasks()).length
  console.log(`     ↳ 起点：队列里已有 ${base} 条`)

  // ── E1：把一颗「点击 → 切页」的按钮排进去，看界面真的切过去 ──
  //
  // 为什么挑这颗：`overview.factors.detail` 的 onClick 就是 `setPage('evo')`，
  // 所以"界面真的动了"有一个**外部可读**的痕迹（侧边栏 active 变了），
  // 不用靠我自己的日志自证。
  const before1 = await activePage()
  const a1 = await tryRun('overview.factors.detail', '进化实验室', myClient)
  ok('E1a', a1.enqueued, '只读按钮入队成功')
  ok('E1b', a1.ran, `它被执行到了终态（最后一次：${a1.lastWho} · ${a1.lastDetail.slice(0, 50)}）`)
  if (a1.wonByMe) {
    ok(
      'E1c',
      before1 !== a1.page && a1.page === '进化实验室',
      `界面**真的切页了**：${String(before1)} → ${String(a1.page)} ★ 这是本轮唯一算数的证据` +
        (a1.page === '进化实验室' ? '' : `\n       队列尾部：${await dumpTail()}`),
    )
  } else {
    skip(
      'E1c',
      `试了 4 次，执行权都被另一个窗口领走（最后一个是 ${a1.lastWho}）—— 本窗读不到它的 DOM。` +
        '这不是通道故障（那条活确实被按了）。要拿到确定性结果：关掉其它面板窗口后重跑本脚本。',
    )
  }

  // ── E2：导航动作走同一条路（不是桌宠自己调 setPage 的另一条实现）──
  const a2 = await tryRun('nav.monitor', '系统监控', myClient)
  ok('E2a', a2.enqueued, '导航动作入队成功')
  ok('E2b', a2.ran, `导航动作被执行（最后一次：${a2.lastWho}）`)
  if (a2.wonByMe) {
    ok('E2c', a2.page === '系统监控', `导航也真的落到了界面：现在是「${String(a2.page)}」${a2.page === '系统监控' ? '' : `\n       队列尾部：${await dumpTail()}`}`)
    ok(
      'E2d',
      await evalJs<boolean>(`!!document.querySelector('[data-ui="monitor.autopilot.start"]')`),
      '系统监控页上确实有 data-ui="monitor.autopilot.start" 的元素',
    )
  } else {
    skip('E2c', `导航的执行权被另一个窗口领走（最后一个是 ${a2.lastWho}）—— 本窗的 DOM 不会动`)
  }

  // ── E3：语音说一句「只读按钮」→ 应当直接入队（不用确认）──
  const e3 = await api('/voice/utterance', { text: 'Agent 舰队页按一下这计划能接吗' })
  console.log(`     ↳ 回了：${String(e3.reply).slice(0, 130)}`)
  const e3hit = (await tasks()).find((t) => t.actionId === 'agents.plan.check' && t.id !== '')
  ok('E3a', e3hit !== undefined, '语音把「这计划能接吗」认成了 agents.plan.check 并入队（只读无需确认）★ 严格档抢在 ask_agents 之前')
  const t3 = await waitStatus(e3hit?.id ?? '', 'done')
  ok('E3b', t3?.status === 'done', `它也真的被某个窗口按了（status=${String(t3?.status ?? '未取到')} · ${String(t3?.requestedBy ?? '?')}）`)

  // ── E4：语音说一句「会改状态的按钮」→ 必须**先问人**，队列不许变 ──
  //
  // ★★ 判据方式在 2026-09-20 改过**两次**，两次都是同一个毛病：操作数口径不同。
  //
  //   第一版：三处都在比 `(await tasks()).length`。
  //     `/ui/actions` 返回的 `tasks` 是 `listTasks(cwd, { limit: 40 })` ——
  //     队列**累计**超过 40 条后这个长度恒等于 40。于是
  //     E4c 的 `n2 === n0 + 1` 对**正确的输入**永远报错（判据 2），
  //     E5/E6a 的 `===` 永远成立，不管真排没排（判据 6 的假绿）。
  //
  //   第二版改成"按 actionId 计数"。它**仍然会红** —— 本轮当场复现：
  //     `❌ E4c 确认之后才入队（7 → 7）`，而语音那边白纸黑字回的是
  //     "已经排进界面队列了"。
  //   真因：**窗口满了会从头部挤掉一条**。窗口恒 40 条时，新排的一条从尾部进、
  //     最老的一条从头部出；若被挤掉的恰好也是一条 `risk.sandbox.run`，
  //     计数纹丝不动 —— 而这条动作**确实排进去了**。
  //   这与判据 31 是同一条：**两个数来自不同窗口就不能相减**。
  //
  //   ⇒ 现在改成比**任务 id 的集合差**：新排的那条必然是"我没见过的 id"，
  //     它一定在最近 40 条窗口里（它是最新的），而谁被挤掉都不影响这个差集。
  //     ★ 差集为空**只可能**是"真的没排" —— 这才是一个有分辨力的断言。
  const idsOfAny = (ts: TaskView[], ids: readonly string[]) =>
    new Set(ts.filter((t) => ids.includes(t.actionId)).map((t) => t.id))
  const addedIds = (before: Set<string>, after: Set<string>) => [...after].filter((x) => !before.has(x))

  const sandbox = 'risk.sandbox.run'
  const s0 = idsOfAny(await tasks(), [sandbox])
  const e4 = await api('/voice/utterance', { text: '风控中心页跑一次沙盒演练' })
  console.log(`     ↳ 回了：${String(e4.reply).slice(0, 160)}`)
  const s1 = idsOfAny(await tasks(), [sandbox])
  ok('E4a', e4.pending !== null && e4.pending !== undefined, '写动作返回了待确认（没直接排）')
  ok(
    'E4b',
    addedIds(s0, s1).length === 0,
    `确认之前没有多出这条动作（新增 ${addedIds(s0, s1).length} 条）—— 排进去就等于没人批准也执行`,
  )
  const e4c = await api('/voice/utterance', { text: '确认' })
  const s2 = idsOfAny(await tasks(), [sandbox])
  const added4 = addedIds(s1, s2)
  console.log(`     ↳ 确认后回了：${String(e4c.reply).slice(0, 130)}`)
  ok(
    'E4c',
    added4.length === 1,
    `确认之后**恰好**多出一条（新增 ${added4.length} 条${added4.length ? `：${added4.join(',')}` : ''}）`,
  )
  ok('E4d', (await tasks()).some((t) => t.actionId === sandbox), '入队的正是 risk.sandbox.run')

  // ── E5：那句话的主人是舰队，不是按钮 —— 不许执行两次 ──
  //
  // ★ 划清这条**不**证明什么（这是本轮补课的直接原因）：
  //   它只证明"没有第二条路径"。**按钮到底变没变，它一个字都没说** ——
  //   而上一轮是拿它当"用户验收点已覆盖"的证据用的，结果用户实测看到的
  //   依然是"按钮没变"（真因：链每次都被"确认"挡在门口，从没执行过）。
  //   ⇒ 按钮翻面由 E7 断言。**别再把 E5 当成验收点的覆盖。**
  const apIds = ['overview.autopilot.start', 'overview.autopilot.stop'] as const
  const a3 = idsOfAny(await tasks(), apIds)
  const e5 = await api('/voice/utterance', { text: '启动自治循环' })
  const a4 = idsOfAny(await tasks(), apIds)
  console.log(`     ↳ 回了：${String(e5.reply).slice(0, 160)}`)
  ok(
    'E5',
    addedIds(a3, a4).length === 0,
    `「启动自治循环」没有往按钮队列里多排东西（新增 ${addedIds(a3, a4).length} 条）—— 一句话只有一个主人`,
  )

  // ── E6：`operatorOnly` 那颗按钮 —— 听出来了但**不代按**（第五态 human）──
  //
  // ★ 为什么要端到端验：`human` 这一档在纯函数里绿（ui-actions-smoke 的 U26），
  //   但它能不能**走到**取决于 `parseIntent` 把这句话判成什么 ——
  //   若判成危险意图，护栏会先挡住，`human` 分支就永远不可达（＝写了没人用）。
  //   所以这里验的是**接线可达性**，不是解析正确性（判据 10：有端点 ≠ 有人读）。
  const t5 = idsOfAny(await tasks(), ['terminal.submit'])
  const e6 = await api('/voice/utterance', { text: '交易终端页按一下提交下单' })
  const t6 = idsOfAny(await tasks(), ['terminal.submit'])
  console.log(`     ↳ 回了：${String(e6.reply).slice(0, 170)}`)
  ok(
    'E6a',
    addedIds(t5, t6).length === 0,
    `「按一下提交下单」没有排进按钮队列（新增 ${addedIds(t5, t6).length} 条）—— 不代按就一步都不许走`,
  )
  ok(
    'E6b',
    /看不见|不代按|说全|面板/.test(String(e6.reply)),
    '回话说明了"为什么按不了"并给出下一步（不是"没听懂"）',
  )

  // ── E7：用户实测的那个现象 —— 说一句「启动自治循环」，总览那颗按钮**真的**翻面 ──
  //
  // ★★ 为什么非要有这一条（本轮最重要的一处补课）：
  //   F18 断言了"链的形状对"（成员、函数、状态源、订阅者），
  //   F19 断言了"免确认的凭据可核对"（撤销指针互为逆、名单不外溢）——
  //   **两条全绿，而用户实测的现象依然是"按钮没变"。**
  //   因为链**从来没有被执行**：每一次都得他再说一句「确认」；
  //   而 E5 当时只断言了"队列没多排东西" —— 它证明的是"没有第二条路径"，
  //   对"按钮到底变没变"一个字都没说。
  //
  //   ⇒ 判据 2 的镜像：**断言必须对着用户的验收点**。
  //     用户的验收点不是"机制正确"，是**屏幕上那两个字变了**。
  //     所以这条读的是 DOM 里的按钮文案 —— 不是我的日志，也不是后端标志。
  //
  // ★ 它只读 DOM 的**文字**、不走按钮通道，于是"哪个窗口抢到执行权"这个
  //   随机因素在这里不存在：这条断言是确定性的。
  //
  // ⚠️ 副作用：本段会把交易自动驾驶**停掉 → 启动 → 再停掉**。
  //    e2e 脚本本来就有副作用（它刻意不进 CI，见文件头）。
  {
    // 固定起点：先停掉（幂等）。不这么做的话，"按钮本来就写着停止"会让 E7a 白红。
    await api('/autopilot/stop', { reason: 'E7 固定起点' })
    await sleep(600)
    await gotoOverview()
    const btn0 = await waitApButton((t) => t.includes('启动') || t.includes('停止'))
    ok('E7a', btn0.includes('启动'), `起点：总览那颗按钮写着「${btn0}」`)

    // ★ 用**用户实测的姿势**说这句话：只说这一句，不补「确认」。
    const e7 = await api('/voice/utterance', { text: '启动自治循环' })
    const reply7 = String(e7.reply ?? '')
    console.log(`     ↳ 回了：${reply7.slice(0, 220)}`)
    ok(
      'E7b',
      !/确认吗/.test(reply7) && !/先问你一句/.test(reply7),
      '它**没有**反过来问「确认吗」—— 用户点名的可逆动作直接执行（这一步就是他实测卡住的地方）',
    )
    ok(
      'E7c',
      !/根因|用户实测反馈|判据/.test(reply7),
      '回话里没有内部设计笔记 —— 计划表的 `why` 不再被念出来（判据 19：说明文的读者不是耳朵）',
    )

    // 后端：这是按钮读的那**同一份**状态（"同源"由 F18 断言，这里验它真的翻了）
    let running = false
    for (let i = 0; i < 80; i++) {
      const st = await api('/autopilot')
      if (st.running === true) {
        running = true
        break
      }
      await sleep(500)
    }
    ok('E7d', running, '语音这一句真的把自动驾驶起起来了（后端运行标志为真）')

    // 前端：等到**屏幕上那两个字**真的变了
    const btn1 = await waitApButton((t) => t.includes('停止'), 20_000)
    ok(
      'E7e',
      btn1.includes('停止'),
      `总览那颗按钮真的翻面了：「${btn0}」→「${btn1}」★ 这是用户唯一的验收点，也是本轮补的那一条`,
    )

    // ── 撤销方向：`undoPlan` 声称"能原样退回去"，那就当场退一次 ──
    //   ★ 判据 3 的精神：一个声明只有在**只有它**会命中的输入下才算被验过。
    //     "可逆"的输入就是"退回原状" —— 不退这一次，等于没验。
    const e7s = await api('/voice/utterance', { text: '停止自治循环' })
    console.log(`     ↳ 回了：${String(e7s.reply).slice(0, 200)}`)
    let stopped = false
    for (let i = 0; i < 40; i++) {
      const st = await api('/autopilot')
      if (st.running === false) {
        stopped = true
        break
      }
      await sleep(500)
    }
    const btn2 = await waitApButton((t) => t.includes('启动'), 20_000)
    ok(
      'E7f',
      stopped && btn2.includes('启动'),
      `撤销路径真的通：「停止自治循环」把它退回去了，按钮回到「${btn2}」—— 「可逆」不是一句话，是一次实测`,
    )
  }

  // ── E8：对话记录面板真的看得到（Task #114）─────────────────────────
  //
  // 前面几组验的是**通道**（后端排了、前端按了）；这一组验的是**屏幕**：
  // 聊过的话不仅要落盘、要能被端点读到，还要在界面上看得见 ——
  // 否则用户仍然只能"相信后端记了"，而本项目的红线正是
  // 「凡是没有落地的对话，事后都只能靠回忆」。
  //
  // ★ 副作用说明：这一组会通过生产入口**真的说一句话**，所以那句话会
  //   留在对话记录里（记录只追加、不提供删除接口）。选的是用户真会说的话，
  //   回话是一条权益播报 —— 它看起来就是"系统自己验了一次"，
  //   而不是一行没人认领的噪音。
  {
    const clicked = await evalJs<boolean>(
      `(() => { const items = [...document.querySelectorAll('.nav-item')];
         const t = items.find((e) => (e.textContent || '').includes('语音管家'));
         if (!t) return false; t.click(); return true; })()`,
    )
    if (!clicked) {
      skip('E8', '侧边栏里没有语音管家页 —— 对话记录面板没被验证')
    } else {
      await waitPage('语音管家 · 桌宠', 15_000)

      // ★ 选一句**不在任何快捷口令按钮上**的话。
      //   若用「帮助」之类，面板里出现它可能只是读到了旁边的快捷按钮，
      //   这条断言就永远绿 —— 判据：这条断言有没有一个「只有它」会命中的输入。
      const PROBE = '账户里还有多少钱'
      const sent = await api('/voice/utterance', { text: PROBE })
      ok('E8a', sent.__status === 200, `说一句「${PROBE}」被受理（status=${String(sent.__status)}）`)

      // ★ 只读**记录卡**的文本，不读整页：整页 textContent 会命中别处的
      //   同名文案，断言就失去分辨力了。
      const readCard = () =>
        evalJs<string | null>(
          `(() => { const cs = [...document.querySelectorAll('.card')];
             const c = cs.find((e) => (e.textContent || '').includes('对话记录'));
             return c ? (c.textContent || '') : null; })()`,
        )

      // 面板要等 4 秒一轮的状态轮询 + React 提交，读一次就下结论是在赌耗时
      let card: string | null = null
      for (let i = 0; i < 25; i++) {
        card = await readCard()
        if (card !== null && card.includes(PROBE)) break
        await sleep(400)
      }

      if (card === null) {
        ok('E8b', false, '语音管家页里找不到「对话记录」卡片')
        skip('E8c', '卡片没渲染出来，后面的断言没有意义')
        skip('E8d', '同上')
        skip('E8e', '同上')
      } else {
        ok('E8b', true, '语音管家页里有「对话记录」卡片')
        ok('E8c', card.includes(PROBE), `记录面板里看得到刚说的「${PROBE}」—— 落盘 → 端点 → 屏幕整条链的证据`)
        // 用户得能分出"这次开机聊的"与"上次重启之前的"
        ok('E8d', card.includes('本次开机'), '当前会话的轮次带「本次开机」标记')
        // ★ 对正确输入报错的检查比不报错的更费人 —— 正常运行时不许出现读不到的警告
        ok(
          'E8e',
          !card.includes('读不到对话记录') && !card.includes('记录目录读不了'),
          '正常运行时不出现"读不到记录"的误报',
        )
      }
    }
  }

  // ── E9：交易大厅的「执行前置检查」—— 闸门不是装饰 ─────────────────────
  //
  // ★ 本轮补的是什么：交易大厅（人手点的单）原先**一道闸门都不过** ——
  //   自治循环过 9 道，人那条路直接进纸面撮合。同一个业务动作两条路径（判据 8），
  //   而且人那条从来没有任何测试覆盖。
  //   修法不是给大厅再写一份检查，而是让它调**同一条** `runPipeline`
  //   （端点 `POST /orders/precheck`；"同源"由 `test:trade-gate` 的 A 组钉住）。
  //
  // ★ 这一组验的是**接线可达**，不是**检查正确**：
  //   四态互不顶替、null 不退化、敞口口径都归烟测；这里只问三件事 ——
  //   桌宠按得下去吗？屏幕真的会变吗？提交按钮真的跟着裁决走吗？
  //   （U05 只保证"注册表里有这个名字"，它一个字都没说这按钮在页面上存不存在。）
  {
    const clicked = await evalJs<boolean>(
      `(() => { const items = [...document.querySelectorAll('.nav-item')];
         const t = items.find((e) => (e.textContent || '').includes('交易终端'));
         if (!t) return false; t.click(); return true; })()`,
    )
    if (!clicked) {
      skip('E9', '侧边栏里没有交易终端页 —— 执行前置检查面板没被验证')
    } else {
      await waitPage('交易终端', 15_000)

      const hasBtn = await evalJs<boolean>(
        `!!document.querySelector('[data-ui="terminal.gate.precheck"]')`,
      )
      ok(
        'E9a',
        hasBtn,
        '交易终端页上真的存在 data-ui="terminal.gate.precheck"（注册表里的名字在页面上摸得到）',
      )

      /** 读整个面板的可见文字。★ 只读**面板**，不读整页 —— 整页会命中别处同名文案，断言就没有分辨力了。 */
      const gateText = () =>
        evalJs<string | null>(
          `(() => { const c = document.querySelector('.gate-card'); return c ? (c.textContent || '') : null; })()`,
        )
      const submitState = () =>
        evalJs<{ disabled: boolean; text: string } | null>(
          `(() => { const b = document.querySelector('[data-ui="terminal.submit"]');
             if (!b) return null; return { disabled: !!b.disabled, text: (b.textContent || '').trim() }; })()`,
        )

      // ★ 起点必须是"还没检查过"：面板状态在**切页**时会随组件卸载一起重置，
      //   所以这一条是确定性的，不依赖上一组留下什么。
      const pre = await submitState()
      ok(
        'E9b',
        pre !== null && pre.disabled && /待闸门放行/.test(pre.text),
        `空表单时提交按钮**是灰的**且写着「待闸门放行」（按钮原文：${pre?.text ?? '找不到按钮'}）` +
          ' ★ 改造前这颗按钮恒可点 —— 这条断言只有"闸门接上了"才会命中',
      )

      // ① 通道可达（**不要求是本窗**）：排一次，看有没有窗口真的把它按下去。
      //
      // ★ 这一条的价值恰恰在于"是别的窗口按的"也算：
      //   它证明的是"注册表里的名字，在某个**真实浏览器窗**里摸得到、点得着"。
      //   本轮实测就是这样：本窗连续 4 次都没抢到执行权，
      //   而队列账本里明明白白留着一条 `在「terminal」上按了「执行前置检查」`。
      const a9 = await tryRun('terminal.gate.precheck', '交易终端', myClient)
      ok('E9c', a9.enqueued, '只读预检动作入队成功')
      ok(
        'E9d',
        a9.ran,
        `至少有一次真的被某个窗口按了下去（最后一次：${a9.lastWho} · ${a9.lastDetail.slice(0, 50)}）`,
      )
      // ★ 抢不到执行权**不是**失败，但也不能装作没发生 —— 要说出来是谁、以及后面为什么改用直接点击。
      if (!a9.wonByMe) {
        console.log(
          `     ↳ 说明：本窗 4 次都没抢到执行权（最后一个是 ${a9.lastWho}）。` +
            '屏幕级证据因此改用"本窗直接点击"来取（见下），通道这一层由 E9c/E9d 单独负责。',
        )
      }

      // ② 屏幕证据（**必须由本窗产生**）：
      //
      // ★★ 为什么这里不用通道，而是本窗直接点（与 E7 同一个理由）：
      //    执行权是"谁先轮询到归谁" —— 应用同时可能开着多个窗（用户浏览器里的面板、
      //    桌宠窗、无头窗…）。本轮实测里本窗**连续 4 次都被别的窗领走**，
      //    若把屏幕断言挂在 wonByMe 上，这一组就几乎永远落在"未验证"里 ——
      //    而"未验证"攒多了就成了一块遮羞布（判据 24 的反面）。
      //    ⇒ 通道验通道（E9c/E9d），屏幕验屏幕（下面这四条）。两者各说各的。
      const clickedHere = await evalJs<boolean>(
        `(() => { const b = document.querySelector('[data-ui="terminal.gate.precheck"]');
           if (!b) return false; if (b.disabled) return false; b.click(); return true; })()`,
      )
      if (!clickedHere) {
        ok('E9e', false, '本窗点不动那颗按钮（不存在，或它是灰的）—— 屏幕级证据取不到')
        skip('E9f', '同上')
        skip('E9g', '同上')
        skip('E9h', '同上')
      } else {
        // 等面板从"还没检查"变成"有四态之一"：跨一次 HTTP + React 提交两跳，读一次是在赌耗时。
        const LABELS = ['✅ 放行', '⛔ 被闸门拒绝', '🧑 需人工审批', '❓ 查不了（不放行）']
        let text: string | null = null
        for (let i = 0; i < 30; i++) {
          text = await gateText()
          if (text !== null && LABELS.some((l) => text!.includes(l))) break
          await sleep(400)
        }
        const hit = LABELS.find((l) => (text ?? '').includes(l)) ?? null
        ok(
          'E9e',
          hit !== null,
          `本窗按下去之后面板**真的给出了裁决**：${hit ?? `没等到四态（面板文字：${(text ?? '').slice(0, 80)}）`}` +
            ' ★ 四态各是一个独立的说法，不是笼统的"失败"',
        )

        // ★ 这条钉的是本轮修的**口径**：查不了时要报 0/9（"9 道没走到"），
        //   不许报 0/0 —— 后者读起来像"没有闸门"，而真相是"一道都没查成"。
        ok(
          'E9f',
          /闸门 \d+\/9/.test(text ?? ''),
          `面板报出了闸门进度「${(text ?? '').match(/闸门 \d+\/9/)?.[0] ?? '没找到'}」—— 查不了时报 0/9，不是 0/0`,
        )

        // ★★ 空表单（数量没填 ⇒ 名义金额为 0、入场价为 0）时，裁决必须是
        //    「查不了」而**不是**「被闸门拒绝」：前者要你去补参数，后者要你去改报价。
        //    两句话指向**相反的动作**（判据 25）。
        //    这一条是确定性的：E9b 已经钉住了起点是空表单。
        ok(
          'E9g',
          (text ?? '').includes('❓ 查不了'),
          `空表单 ⇒ 裁决是「查不了」而不是「被拒绝」（面板写道：${(text ?? '').slice(0, 60)}…）` +
            ' ★ 查不了 ≠ 不合格，两者指向相反的动作',
        )

        // ★ 这一条是"闸门不是装饰"的全部含义：**按钮的可点性必须与裁决一致**。
        //   两个方向都断：`pass` ⇒ 必须可点；`非 pass` ⇒ 必须是灰的（fail-closed）。
        //   ★ 不写死"应当是 pass/blocked" —— 那取决于当时的行情，
        //     写死就成了"对正确输入报错的检查"（判据 2）。
        const post = await submitState()
        const sawPass = (text ?? '').includes('✅ 放行')
        ok(
          'E9h',
          post !== null && post.disabled === !sawPass,
          `提交按钮与裁决一致：裁决为${sawPass ? '放行' : '非放行'} ⇒ 按钮${post?.disabled ? '灰' : '可点'}` +
            `（按钮原文：${post?.text ?? '找不到按钮'}）`,
        )
      }
    }
  }

  console.log(
    `\n${fail === 0 ? '✅' : '❌'} 端到端：${pass} 通过 / ${fail} 失败${skipped > 0 ? ` / ${skipped} 未验证` : ''}`,
  )
  for (const b of bad) console.log(`  · ${b}`)
  for (const s of skips) console.log(`  ⏭️ ${s}`)
  try {
    ws.close()
  } catch {
    /* 收尾失败不影响结论 */
  }
  // ★ 退出码也分三态：全绿 0；有红 1；**没有红但有"未验证"** 3 ——
  //   3 不是"通过"，脚本调用方必须能分辨"验过了"与"没验成"。
  process.exit(fail > 0 ? 1 : skipped > 0 ? 3 : 0)
}

void main().catch((e: unknown) => {
  console.error('端到端脚本自身出错：', e instanceof Error ? e.message : String(e))
  process.exit(2)
})
