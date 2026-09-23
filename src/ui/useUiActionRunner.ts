/**
 * 界面动作执行器 —— 桌宠/语音排过来的按钮，由**界面自己**去按
 *
 * ── 这一层为什么必须住在前端 ────────────────────────────────────────
 * 服务端能排一条"按一下总览那颗启动按钮"，但它**按不到** ——
 * 那颗按钮存在于浏览器 DOM 里，它的 onClick 闭包里装着这个页面的 state。
 *
 * 所以分工是：服务端**排队并留痕**，界面**轮询并执行**，然后回报结果。
 * 关键的一条是：桌宠按下的那一下，与人手点下去的那一下，
 * 落到的是**同一个 DOM 元素、同一个 onClick** ——
 * 没有"桌宠专用的下单实现"这种东西，也就没有绕开界面上任何一道确认的旁路。
 *
 * ── 三个容易踩的点 ──────────────────────────────────────────────────
 * ① **切页之后要等渲染**。React 的 setState 是异步的，`setPage` 之后立刻
 *    `querySelector` 一定查不到 —— 那不是"没有这个按钮"，是"还没画出来"。
 *    所以这里用一个有上限的重试，并且把"重试完还是没有"与"第一次就没有"
 *    都报成同一个明确的原因（`NO_SUCH_ELEMENT`），而不是静默放弃。
 * ② **同一 id 不许按两次**。服务端的状态由最后一条记录决定，
 *    报告之前它会一直出现在 pending 里；不做本地去重就会连点。
 * ③ **按不动要说出来**。`disabled` 的按钮 `.click()` 什么都不会发生 ——
 *    如果这时报"已按下"，用户会以为系统坏了。所以要显式判 disabled。
 */
import { useEffect, useRef, useState } from 'react'
// ★ 前端用**无扩展名**导入（`src/store/Store.tsx`）：`server/**` 那套显式 `.ts`
//   是 Node 原生 TS 的写法，Vite 这边写 `.ts` 会解析不到 `.tsx` ——
//   而 `tsc --noEmit` **不报错**，错误只在 `vite build` 那一刻出现。
import { usePage, useStore } from '../store/Store'
import { getPendingUiActions, postUiActionResult, type UiTaskView } from '../orch/client'
import { deliverUiRequest, withdrawUiRequest } from './uiRequest'

/** 轮询间隔。必须**远小于**服务端的 `UI_TASK_TTL_MS`（60s），否则正常一次排程会被判过期。 */
const POLL_MS = 2_000

/** 切页之后等渲染：最多这么多次，每次这么久。 */
const RENDER_WAIT_TRIES = 12
const RENDER_WAIT_MS = 60

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * **这个窗口**的标识。每次页面加载生成一个，之后整页生命周期不变。
 *
 * ★ 为什么不能省（实测抓出来的）：应用会同时开两个窗口 ——
 *   启动器会在默认浏览器里打开面板，桌宠窗是另一个，开发时还可能开着预览页。
 *   而**取活即认领**的设计意味着"哪一窗先轮询到就哪一窗按"。
 *   于是在另一个窗口里看，就会看到"我排了、队列说已按下、可我的界面没动" ——
 *   这与"通道坏了"**一模一样**（判据 24：两件事因长得一样，动作相反：
 *   一个要修代码，一个什么都不用做）。
 *   把窗标识写进认领记录，这种误判当场就能排除。
 *
 * ★ 也挂在 `document.documentElement` 上：出问题时打开控制台就能看到
 *   "我是哪一窗"，再去账本里对 `requestedBy` 就知道活被谁领走了。
 */
function makeClientId(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10)
  return `ui-${rnd}`
}

export interface UiActionRunnerState {
  /** 最近一条执行结果的一句话，给界面角落显示。 */
  last: string | null
  /** 本会话已执行的条数。 */
  ranCount: number
  /** 最近一次读队列失败的原因。有它就说明"读不到"，不是"没有"。 */
  readError: string | null
}

/**
 * 挂一次就够了（在 App 顶层）。挂两次会导致同一条动作被两个执行器抢着按 ——
 * 本地去重是**每个 hook 实例一份**的，两个实例互相看不见。
 *
 * ★ `enabled` 而不是"条件调用这个 hook"：hooks 的调用顺序必须恒定，
 *   把开关做成参数、在 effect 里早退，才不会因为某次渲染少调一个 hook 而错位。
 *   悬浮桌宠窗传 `false`（它只渲染语音管家那一页，别的页面的按钮在它的 DOM 里
 *   根本不存在 —— 挂了它只会把每条动作都报成"找不到元素"，并把它们标记成
 *   已处理，于是主窗口再也不会去执行）。
 */
export function useUiActionRunner(enabled: boolean): UiActionRunnerState {
  const { state } = useStore()
  const { page, setPage } = usePage()
  const [last, setLast] = useState<string | null>(null)
  const [ranCount, setRanCount] = useState(0)
  const [readError, setReadError] = useState<string | null>(null)

  // ★ 用 ref 把最新的 url/token/page 带进轮询闭包。
  //   直接在 effect 依赖里放这些值会让每次切换页面都重建定时器，
  //   而重建的空档正好会漏掉那一瞬间排进来的动作。
  const urlRef = useRef(state.orchUrl)
  const tokenRef = useRef(state.orchToken)
  const pageRef = useRef(page)
  const setPageRef = useRef(setPage)

  // ★ 同步放进 effect，**不在渲染期写 ref**（`react-hooks/refs` 会报错，
  //   而且它报得有道理：渲染可能被丢弃或重放，写进去的值会和最终提交的那一帧不一致）。
  //   ★ 这个 effect 必须排在下面的轮询 effect **之前** —— effect 按声明顺序执行，
  //     这样定时器第一次跑的时候 ref 里已经是最新值了。
  //   没有依赖数组是刻意的：每次提交后都同步一次，比"猜哪些值会变"可靠。
  useEffect(() => {
    urlRef.current = state.orchUrl
    tokenRef.current = state.orchToken
    pageRef.current = page
    setPageRef.current = setPage
  })

  /** 已经处理过的 id。见文件头③：报告之前服务端会一直把它放在 pending 里。 */
  const handled = useRef<Set<string>>(new Set())

  // ★ 窗 id 在**惰性 ref** 里建一次：用 `useState` 建的实例不能在渲染期改属性，
  //   而这里要把它挂到 DOM 上 —— 那属于"渲染之外的一次性副作用"。
  const clientRef = useRef<string | null>(null)
  if (clientRef.current === null) {
    clientRef.current = makeClientId()
  }

  useEffect(() => {
    // 挂到 DOM 上仅供核对（见 `makeClientId` 的说明），不参与任何判定。
    document.documentElement.dataset.uiClient = clientRef.current ?? ''
  }, [])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let busy = false
    const client = clientRef.current ?? 'ui'

    const runOne = async (t: UiTaskView): Promise<void> => {
      // ① 切页类：没有对应的 DOM 元素，是"导航"这个动作本身。
      if (t.actionId.startsWith('nav.')) {
        setPageRef.current(t.page as Parameters<typeof setPageRef.current>[0])
        await postUiActionResult(urlRef.current, tokenRef.current, t.id, {
          ok: true,
          detail: `切到「${t.spec.label}」`,
          client,
        }).catch(() => undefined)
        if (alive) setLast(`切到「${t.spec.label}」`)
        return
      }

      // ② 按钮类：先确保在这一页上，再等它画出来。
      const pageLabel = t.spec.page
      if (pageRef.current !== t.spec.page) {
        setPageRef.current(t.spec.page as Parameters<typeof setPageRef.current>[0])
        await sleep(RENDER_WAIT_MS * 2)
      }

      let el: HTMLElement | null = null
      for (let i = 0; i < RENDER_WAIT_TRIES; i++) {
        el = document.querySelector<HTMLElement>(`[data-ui="${t.actionId}"]`)
        if (el) break
        await sleep(RENDER_WAIT_MS)
      }

      if (!el) {
        // ★ 「没找到」必须是一个**有名字的失败**，并且带上"在哪一页找的"。
        //   只说"失败"的话，排查的人分不清是页面没切过去、还是按钮没接线。
        //
        // ★ 参数要在**每一条失败路径上撤回**：留着的后果不是"参数丢了"，
        //   而是它留到**下一次人手点击**时被取走 —— 用户明明选着 ETH，
        //   图上却画出 BTC，而屏幕上看不出任何异常（见 `uiRequest.ts` 的文件头）。
        withdrawUiRequest()
        await postUiActionResult(urlRef.current, tokenRef.current, t.id, {
          ok: false,
          detail: `NO_SUCH_ELEMENT：在「${pageLabel}」上没找到 data-ui="${t.actionId}" 的元素`,
          client,
        }).catch(() => undefined)
        if (alive) setLast(`没找到「${t.spec.label}」（在 ${pageLabel} 页）`)
        return
      }

      if ((el as HTMLButtonElement).disabled) {
        withdrawUiRequest()
        await postUiActionResult(urlRef.current, tokenRef.current, t.id, {
          ok: false,
          detail: `ELEMENT_DISABLED：「${t.spec.label}」现在是灰的（两种可能：连不上服务端，或者它被交易闸门的前置检查拦着）`,
          client,
        }).catch(() => undefined)
        if (alive) setLast(`「${t.spec.label}」是灰的，没按`)
        return
      }

      // ── 参数通道：写入 → 立刻点击 ─────────────────────────────────────
      //
      // ★ 为什么写在**点击之前**、而且是同步的：按钮的 `onClick` 闭包里装着
      //   页面**上一次渲染**的 state，而 React 的 setState 是异步的。
      //   若把参数先塞进 state 再点，那一下点击读到的仍是旧值 ——
      //   "参数明明传了、界面却按旧的算"，且两边都不报错。
      //   所以参数走 `uiRequest` 这条模块级同步通道（见它的文件头）。
      //
      // ★ 只在**确实带了参数**时写：无条件 `deliver` 一个空对象会把
      //   "无参点击"也变成"有参点击"，页面就会走参数分支去解析空参数。
      const params = t.payload
      if (params && Object.keys(params).length > 0) {
        deliverUiRequest(t.actionId, params)
      }

      el.click()
      await postUiActionResult(urlRef.current, tokenRef.current, t.id, {
        ok: true,
        detail:
          `在「${pageLabel}」上按了「${t.spec.label}」` +
          // ★ 参数要写进回报里：事后核对"桌宠说的"与"界面按的"是不是同一个数，
          //   靠的就是这一行。不写的话两边都只能说"我按了"，无从对齐。
          (params && Object.keys(params).length > 0 ? `（参数 ${JSON.stringify(params)}）` : ''),
        client,
      }).catch(() => undefined)
      if (alive) {
        setLast(`按了「${t.spec.label}」`)
        setRanCount((n) => n + 1)
      }
    }

    const poll = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const res = await getPendingUiActions(urlRef.current, tokenRef.current, client)
        if (!alive) return
        // ★ 读不到要与"没有"分开：服务端给了 error 就显示它，
        //   而不是当作"队列是空的"。
        setReadError(res.error ?? null)
        for (const t of res.tasks ?? []) {
          if (handled.current.has(t.id)) continue
          handled.current.add(t.id)
          await runOne(t)
        }
      } catch (e) {
        if (alive) setReadError(e instanceof Error ? e.message : String(e))
      } finally {
        busy = false
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [enabled])

  return { last, ranCount, readError }
}
