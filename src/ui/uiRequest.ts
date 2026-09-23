/**
 * 界面动作的**一次性参数**通道 —— 「桌宠那一次想按的，到底算哪个标的、未来多久」
 *
 * ── 为什么需要它（本轮用户实测的那句话）────────────────────────────────
 * 用户：「桌宠说到可以做到，顺手把走势图调出来，方便同步查看」。
 *
 * 它问的是「比特币未来一小时」，嘴里念的也是 BTC / 60 分钟。而队列里那条动作
 * 只有一个 `actionId` —— 于是界面按下之后，画的是**屏幕当前选着的那个标的**。
 * 屏幕上就同时出现两个口径不同的数：嘴里说的 60 分钟、图上画的 15 分钟。
 * 两个数各自都算得对，放在一起看却没有意义（判据 31）。
 *
 * ⇒ 所以「按哪颗按钮」必须能带上「按它的时候用什么参数」。
 *
 * ── 为什么是模块级单例，而不是塞进 Store ─────────────────────────────
 * 按下按钮的是执行器（`useUiActionRunner`），按钮的 `onClick` 闭包里装着
 * 页面**上一次渲染**的 state。若把参数先 `dispatch` 进 Store 再点击，
 * 那一下点击读到的仍是旧值 —— React 的 setState 是异步的，而点击是同步的。
 * 于是参数必须走一条**同步**的通道：执行器写入 → 同一次事件里被页面取走。
 *
 * 单例的代价是"跨窗口/跨动作串味"，两个风险各自有对策：
 *   · 跨窗口 —— 执行器本来就每个窗口一份（`handled` 集合同此），窗口之间不共享；
 *   · 串味  —— `take` 带 `actionId` 校验、**取走即清空**、外加一个很短的 TTL。
 *
 * ── 为什么要有 TTL 和「撤回」两个保护 ───────────────────────────────────
 * 最坏的形态不是"参数丢了"，而是**参数留到了下一次人手点击**：
 * 那时用户明明选着 ETH，图上却画出 BTC，而屏幕上看不出任何异常。
 * 所以执行器在**点击失败**（找不到元素 / 按钮是灰的）时会显式
 * `withdrawUiRequest()`；万一它自己中途死掉，还有 `UI_REQUEST_TTL_MS` 兜底。
 * 两道保护是刻意的：它们防的是两个不同的失效面（正常失败路径 / 执行器挂掉）。
 */

export interface UiRequest {
  actionId: string
  payload: Record<string, unknown>
  at: number
}

/**
 * 参数的存活时间。
 *
 * ★ 取值依据：它只需要活到"执行器写入 → 点击 → 页面取走"这一小段
 *   （同步的，毫秒级）。给 5 秒是留出一次切页等待的最坏情况
 *   （`useUiActionRunner` 切页后最多等 12 × 60ms ≈ 720ms）。
 *   **刻意给短** —— 它的作用是兜底，不是常态持有；
 *   给长了就变成"上一轮的参数还活着"，那正是要防的那件事。
 */
export const UI_REQUEST_TTL_MS = 5_000

/** 模块级单例：同一时刻**至多一条**。第二条会覆盖第一条（而不是排队）。 */
let current: UiRequest | null = null

function fresh(now: number): UiRequest | null {
  if (current === null) return null
  if (now - current.at > UI_REQUEST_TTL_MS) {
    // 过期即作废。**不返回它**，也顺手清掉 —— 留着它只会等着污染下一次点击。
    current = null
    return null
  }
  return current
}

/**
 * 执行器在点击**之前**写入。
 *
 * ★ 覆盖而不是排队：一次点击只对应一条参数。允许排队的话，
 *   "排了两条、只点了两次里的第一次"会取到第二条的参数 —— 顺序一错就串味。
 */
export function deliverUiRequest(actionId: string, payload: Record<string, unknown>, now = Date.now()): void {
  current = { actionId, payload, at: now }
}

/**
 * 页面在 `onClick` 里取走。**取走即清空** —— 一次参数只能让一次点击生效。
 *
 * 返回 `null` 的四种情况必须能被分开看待（但它们对调用方的动作是同一个：
 * 用自己屏幕上的当前值），所以这里刻意**不**把原因也返回出去：
 * 调用方若想区分，用 `peekUiRequest()`。
 */
export function takeUiRequest(actionId: string, now = Date.now()): Record<string, unknown> | null {
  const req = fresh(now)
  if (req === null) return null
  if (req.actionId !== actionId) {
    // ★ 不是这一颗按钮的参数 ⇒ **不许取走**。
    //   取走的话，那条参数就永远收不到它该去的地方，而"取走"这件事本身
    //   在界面上完全看不出来（判据 11 的静默丢失）。
    return null
  }
  current = null
  return req.payload
}

/** 只读窥视，给断言与排查用。**不消费**。 */
export function peekUiRequest(now = Date.now()): UiRequest | null {
  return fresh(now)
}

/** 执行器在**点击没发生**时撤回。见文件头：这是 TTL 之外的第二道保护。 */
export function withdrawUiRequest(): void {
  current = null
}

/** 仅供门禁在每个用例之间复位（生产代码不调它）。 */
export function resetUiRequestForTest(): void {
  current = null
}
