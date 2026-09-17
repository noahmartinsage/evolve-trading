/**
 * 桌宠 · 桌面外壳桥接（TS 侧类型声明）
 *
 * 实现在 `desktop/preload.mjs`（纯 JS，不能写类型）。两边唯一的耦合是
 * **通道名字符串**，所以这里把它们集中成常量，改一处时全文检索 `pet:` 能对上。
 *
 * ── 关键的一条边界 ────────────────────────────────────────────────────
 * 这座桥**只承载桌面外壳语义**：显示隐藏、退出、重置位置、鼠标穿透。
 * 业务能力（查仓、下单、播报）一律走 HTTP 到编排服务。
 * 理由是那条路上有风控闸门、两段式确认与只追加账本；进程间通道上什么都没有。
 * 一旦有人图省事在这里加一个 `placeOrder`，语音下单就绕过了全部审查。
 */

export interface PetHostState {
  clickThrough: boolean
  alwaysOnTop: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  recovery: { skipTaskbar: boolean; hideOnClose: boolean; reason: string }
}

/**
 * 拖动会话。
 *
 * 两条通道而不是一条，是因为**主进程必须知道"起点"**：
 * 只发位移量的话它只能拿"当前窗口位置 + 位移"来累加，
 * 而 IPC 有延迟 —— 连续快速拖动时会累积误差，窗口越拖越偏。
 * `dragBegin` 让主进程在按下那一刻把窗口位置记下来，
 * 之后每次都从那个固定起点算，误差不会累积。
 *
 * 结束不需要通道：主进程只在 `dragBegin` 时记一次起点，
 * 之后不再调用 `dragBy` 就等于结束。少一条通道少一处能写错的地方。
 */
export interface PetBridge {
  available: true
  hide: () => void
  quit: () => void
  resetPosition: () => void
  setClickThrough: (on: boolean) => void
  getState: () => void
  onState: (cb: (s: PetHostState) => void) => () => void
  /** 开始拖动：主进程在此刻记录窗口起点。 */
  dragBegin: () => void
  /** 拖动中：相对 `dragBegin` 那一刻的位移量（屏幕坐标差）。 */
  dragBy: (delta: { dx: number; dy: number }) => void
}

declare global {
  interface Window {
    petBridge?: PetBridge
  }
}

/**
 * 取桌面外壳。浏览器里直接打开桌宠页时返回 `null`。
 *
 * 返回 null 不是错误路径，而是**受支持的第二种运行形态**：
 * 桌宠页在普通浏览器里也能用（只是不悬浮），
 * 页面据此隐藏"退出/重置位置"这类只对外壳有意义的按钮。
 */
export function petBridge(): PetBridge | null {
  if (typeof window === 'undefined') return null
  const b = window.petBridge
  return b && b.available === true ? b : null
}

/** 是否运行在桌面外壳内。 */
export function inDesktopPet(): boolean {
  return petBridge() !== null
}
