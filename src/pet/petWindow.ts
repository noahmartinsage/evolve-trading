/**
 * 桌宠 · 窗口契约（纯函数）
 *
 * ── 为什么窗口参数要抽成纯函数 ────────────────────────────────────────
 * 悬浮桌宠这类窗口最容易出的问题，全都是**参数组合**问题，而不是逻辑问题：
 *   · 少写 `transparent` → 桌宠变成一块黑底方块；
 *   · 少写 `skipTaskbar` → 任务栏里多一个关不掉的条目；
 *   · `alwaysOnTop` 层级给 'normal' → 全屏应用一开，桌宠就被压在下面，用户以为崩了；
 *   · `resizable` 留真值 → 用户拖一下边框，头像被拉成扁的。
 * 这些都不是"跑起来会报错"的东西，而是"跑起来看着不对"。
 *
 * 抽成纯函数之后，每个标志位都能在**不启动 Electron**的前提下被断言
 * （做法学自上游 airi 的 `windows/desktop-overlay/window-contract.ts`：
 * 用 `Pick<BrowserWindow, '...'>` 的结构化类型 + mock 对象，把窗口方法调用也变成可断言的）。
 *
 * ── 比上游多出来的一处 ────────────────────────────────────────────────
 * 上游恢复窗口位置时直接把存下来的 x/y 写回 `BrowserWindow`。
 * 我们的桌宠 `skipTaskbar: true`、无边框、无标题栏 —— 一旦存下的坐标落在
 * **已经不存在的显示器**上（拔掉外接屏、改分辨率、远程桌面拓扑变了），
 * 它就跑到屏幕外去了，而且**用户没有任何手段把它找回来**：
 * 任务栏没有条目、Alt+Tab 看不到、右键菜单在屏幕外点不到。
 * 所以这里加了 `clampToNearestWorkArea`：把存下的位置钳回当前真实的工作区。
 */

export interface PetSize {
  width: number
  height: number
}

export interface PetRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PetWindowPlan {
  title: string
  width: number
  height: number
  x?: number
  y?: number
  show: boolean
  frame: boolean
  transparent: boolean
  hasShadow: boolean
  alwaysOnTop: boolean
  skipTaskbar: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: boolean
  fullscreenable: boolean
  backgroundColor: string
  webPreferences: {
    preload: string
    sandbox: boolean
    backgroundThrottling: boolean
    contextIsolation: boolean
    nodeIntegration: boolean
  }
}

/** 桌宠默认尺寸。宽度按头像 + 两行字幕定；高度留出头像呼吸空间。 */
export const DEFAULT_PET_SIZE: PetSize = { width: 360, height: 540 }

/** 至少要露出多少像素，用户才可能用鼠标把它拖回来。 */
export const PET_MIN_VISIBLE_PX = 72

export function createPetWindowPlan(params: {
  size?: PetSize
  position?: { x: number; y: number } | null
  preloadPath: string
  title?: string
  /**
   * 任务栏是否留条目。**不要硬编码**，一律由 `resolveRecoveryPlan()` 决定：
   * 它同时管着"关窗收托盘"这条，两处必须同向，否则会造出
   * "任务栏没有条目、窗口又关不掉"的死局。
   */
  skipTaskbar?: boolean
}): PetWindowPlan {
  const size = params.size ?? DEFAULT_PET_SIZE
  const plan: PetWindowPlan = {
    title: params.title ?? 'EVOLVE 桌宠',
    width: size.width,
    height: size.height,
    show: false,
    // 无边框 + 透明 = 只有头像浮在桌面上，没有窗体感。
    // `hasShadow: false` 必须显式写：Electron 默认会给无边框窗加系统投影，
    // 在透明窗口上会描出一圈方形灰边，看起来像没抠干净。
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    // skipTaskbar 是双刃：不留任务栏条目，也不占 Alt+Tab。
    // 代价是"窗口跑到屏幕外"变成不可恢复 —— 见 clampToNearestWorkArea 与 resolveRecoveryPlan。
    skipTaskbar: params.skipTaskbar ?? true,
    // 尺寸固定：桌宠被拖成扁的会立刻露出头像变形，而且没有边框提示可拖回。
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 透明窗必须给全透明底色。Electron 在部分显卡驱动上会忽略 transparent，
    // 此时这个值决定它退化成什么颜色 —— 用全透明而不是黑，退化了也不难看。
    backgroundColor: '#00000000',
    webPreferences: {
      preload: params.preloadPath,
      // 桌宠页要访问麦克风与 speechSynthesis，某些沙箱组合下会静默拿不到设备，
      // 这里显式关掉 sandbox；安全性由 contextIsolation + 只暴露白名单 API 兜。
      sandbox: false,
      // 桌宠常年被压在别的窗口后面。开了节流，它会被浏览器降频到 ~1fps：
      // 头像不再呼吸、口型卡住 —— 而用户只是"切走了视线"，不是要它停。
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  if (params.position) {
    plan.x = Math.round(params.position.x)
    plan.y = Math.round(params.position.y)
  }
  return plan
}

/** `setAlwaysOnTop` 的三个实参。返回对象而不是直接调用，是为了可断言。 */
export interface AlwaysOnTopArgs {
  flag: boolean
  level?: 'screen-saver'
  relativeLevel?: number
}

/**
 * 按平台决定置顶层级。
 *
 * 上游 airi 的做法（`setWindowAlwaysOnTop`）值得照搬语义：
 * macOS / Windows 支持 'screen-saver' 级与相对层级，Linux（X11/Wayland）
 * 只可靠地支持普通置顶，传层级在部分合成器上会**静默无效**。
 *
 * 为什么非得是 'screen-saver' 而不是默认的 'normal'：
 * 全屏应用（视频、演示、游戏）会抢占普通置顶位，桌宠被盖住之后
 * 用户以为它崩了，实际它在下面好好活着。
 */
export function alwaysOnTopArgs(platform: string): AlwaysOnTopArgs {
  if (platform === 'darwin' || platform === 'win32') {
    return { flag: true, level: 'screen-saver', relativeLevel: 1 }
  }
  return { flag: true }
}

function intersectionArea(a: PetRect, b: PetRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return w * h
}

/**
 * 把存下来的桌宠位置钳回当前真实的工作区。
 *
 * 选"交叠面积最大"的工作区而不是"第一个"，是因为多屏用户在副屏上放桌宠是常态；
 * 若外接屏还在，就该留在那块屏上，只是坐标要修正。
 * 全都不交叠（屏幕布局变了）时退到第一个 —— 交点面积都是 0，
 * 初始值 -1 保证第一个会被选上，等价于回到主屏。
 */
export function clampToNearestWorkArea(
  saved: PetRect,
  workAreas: PetRect[],
  minVisible = PET_MIN_VISIBLE_PX,
): PetRect {
  if (workAreas.length === 0) return { ...saved }

  let best = workAreas[0]!
  let bestArea = -1
  for (const wa of workAreas) {
    const area = intersectionArea(saved, wa)
    if (area > bestArea) {
      bestArea = area
      best = wa
    }
  }

  const w = saved.width
  const h = saved.height
  // 别让"必须可见"的像素数超过窗口本身，否则 min > max 恒成立
  const vis = Math.max(16, Math.min(minVisible, w, h))

  let minX = best.x - w + vis
  let maxX = best.x + best.width - vis
  if (maxX < minX) {
    // 工作区比"两次可见量"还窄：放弃横向钳制，贴左缘
    minX = best.x
    maxX = best.x
  }

  let minY = best.y
  let maxY = best.y + best.height - vis
  if (maxY < minY) {
    minY = best.y
    maxY = best.y
  }

  return {
    x: Math.round(Math.min(Math.max(saved.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(saved.y, minY), maxY)),
    width: w,
    height: h,
  }
}

/**
 * 拖动时的新位置：起点 + 位移。
 *
 * ── 为什么不用 CSS `-webkit-app-region: drag` ─────────────────────────
 * 那是最省事的写法，但在无边框窗上有已知 bug（上游 airi 因此改用原生插件）：
 * 拖到一半会丢帧、松手后窗口继续跟着鼠标走、以及和 `transparent` 组合时
 * 拖动区域判定偏移。桌宠是**唯一的窗口**，拖不动就等于废了。
 *
 * ── 为什么不直接用 `screen.getCursorScreenPoint()` ───────────────────
 * 那个写法让窗口跟鼠标绝对位置对齐，鼠标一动窗口就瞬移到指针下，
 * 用户按下时抓的是头像的哪一点就丢了 —— 手感变成"窗口黏在鼠标上"。
 * 正确做法是记住按下那一刻的窗口位置，之后只叠加**位移量**。
 *
 * 抽成纯函数是为了可断言：位移计算错了（比如把屏幕坐标当窗口坐标）
 * 的表现是"拖一下窗口跳到屏幕外"，那是猜不出来的，只能靠断言。
 */
export function nextDragPosition(
  origin: { x: number; y: number },
  delta: { dx: number; dy: number },
): { x: number; y: number } {
  const dx = Number.isFinite(delta.dx) ? delta.dx : 0
  const dy = Number.isFinite(delta.dy) ? delta.dy : 0
  return { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }
}

export interface RecoveryPlan {
  /** 任务栏是否留条目 */
  skipTaskbar: boolean
  /** 关窗时是否收进托盘而不真退出 */
  hideOnClose: boolean
  /** 启动日志要打这一行 —— 否则"为什么任务栏里多了一个条目"没人能解释。 */
  reason: string
}

/**
 * 桌宠的「可找回性」不变量。
 *
 * ── 它在防什么 ────────────────────────────────────────────────────────
 * 桌宠窗口同时具备三个属性：无边框、无标题栏、`skipTaskbar`。
 * 三者叠加的后果是：**一旦它跑到屏幕外或被隐藏，用户没有任何入口把它找回来**
 * —— 任务栏没有、Alt+Tab 没有、右键菜单在屏幕外点不到。
 * 现实里这不是假想：拔掉外接显示器、改分辨率、远程桌面拓扑变化都会让它越界。
 *
 * 所以这里把"必须有且只有一个找回入口"写成**不变量**，而不是靠两处独立设置凑巧对齐：
 *   · 托盘建成了 → 托盘就是入口，可以 skipTaskbar（桌面才干净），关窗收进托盘；
 *   · 托盘没建成（图标异常、系统权限、Linux 无 tray host）→ **必须**放弃 skipTaskbar，
 *     让任务栏当入口，而且**绝不允许**拦下关闭动作。
 *
 * 第二分支是重点：`hideOnClose` 必须同时为 false。
 * 只把 skipTaskbar 放开、却仍然拦下关闭，等于"入口有、但窗口永远关不掉"，
 * 比原来更难收拾。
 */
export function resolveRecoveryPlan(params: { trayCreated: boolean }): RecoveryPlan {
  if (params.trayCreated) {
    return {
      skipTaskbar: true,
      hideOnClose: true,
      reason: '托盘已就绪：任务栏留白，关闭改为收进托盘，托盘菜单是找回入口',
    }
  }
  return {
    skipTaskbar: false,
    hideOnClose: false,
    reason: '托盘不可用：退回任务栏条目作为唯一找回入口，且关闭即退出（不得拦截）',
  }
}
