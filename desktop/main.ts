/**
 * EVOLVE 桌宠 · Electron 主进程
 *
 * ── 它只做"桌面"这一层，不碰业务 ──────────────────────────────────────
 * 窗口、托盘、置顶、位置记忆、可找回性 —— 全在这里。
 * 业务（语音、下单、播报）一行都不在这里，桌宠页连的还是既有的编排服务。
 * 这条边界必须守住：一旦在这里写"顺手查一下持仓"，就等于给系统开了
 * 第二个数据源，而它不会有任何测试覆盖。
 *
 * ── 窗口参数从哪来 ────────────────────────────────────────────────────
 * 全部来自 `../src/pet/petWindow.ts` —— 那里是**唯一**一份窗口契约，
 * 并且是纯函数，能被 `scripts/pet-smoke.ts` 在不启动 Electron 的情况下断言。
 * 这里刻意不重复写任何标志位。
 *
 * 之所以能直接 import `.ts`：Electron 44 内含 Node 24，默认开启类型擦除
 * （实测 `TS_IMPORT_OK=function`）。这样才不必为契约维护第二份 JS 副本 ——
 * 两份窗口参数必然漂移，而漂移出来的那一份不会有人测。
 *
 * ★ 本文件**必须是 `.ts`**，不能改成 `.mjs`：类型擦除只作用于 `.ts`/`.mts`，
 *   而下面有类型注解。改成 `.mjs` 会在第一行 `let petWindow: BrowserWindow | null`
 *   直接 SyntaxError —— 报错是 `Unexpected token ':'`，看起来完全不像后缀问题。
 *   （`preload.mjs` 反之必须是纯 JS：预加载脚本不过类型擦除，写了注解就崩。）
 *
 * 用法：
 *   npm run pet         启动桌宠（需先起 web 预览：vite preview --port 4173）
 *   npm run pet:smoke   冒烟：真起窗 → 截图落盘 → 打印窗口诊断 → 退出
 */

import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  alwaysOnTopArgs,
  clampToNearestWorkArea,
  createPetWindowPlan,
  DEFAULT_PET_SIZE,
  nextDragPosition,
  resolveRecoveryPlan,
} from '../src/pet/petWindow.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 桌宠页地址。默认连本地预览；`?pet=1` 让 SPA 只渲染桌宠、不挂侧边栏。 */
const PET_URL = process.env.PET_URL ?? 'http://localhost:4173/?pet=1'
const SMOKE = process.env.PET_SMOKE === '1'
/**
 * 冒烟截图落盘位置。
 *
 * ★ 兜底也放系统临时目录，**不放项目里**：这张图是内部验证产物
 *   （唯一用途是证明"窗真的画出来了"），不是交付物。
 *   正常路径由启动器通过 `PET_SMOKE_OUT` 指定同一个位置；
 *   这里的默认值只服务"直接跑 `electron desktop/main.ts`"这种绕过启动器的调试。
 */
const SMOKE_OUT = process.env.PET_SMOKE_OUT ?? join(tmpdir(), 'evolve-pet-smoke.png')

/**
 * 托盘图标：16×16 六边形（与品牌图形同构）。
 * 内联成 base64 而不是读文件，是因为打包后 resources 路径会变，
 * 而托盘图标丢了 = 桌宠失去找回入口 —— 这个代价不值得为省几行代码去赌。
 */
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAgklEQVR42mNgoCWIXX75f8qi8/8p0pwz58z/4ukn/1OkuWri0f9NPYcIGxK29tp/XJo72/b9n9i4+/+M6h3/KdI8v2zL/+UFG/9TpHld9tr/W1NX/adI896E5f+PRC3+z0CJ5tMhCyCuoEgzDFCkGQYo0owMcAYYKYAizTBAkWZiAQAYjGWwmdSMRQAAAABJRU5ErkJggg=='

/** 位置记忆文件。用途单一：让桌宠下次出现在上次那个角落。 */
const CONFIG_PATH = join(app.getPath('userData'), 'pet-window.json')

let petWindow: BrowserWindow | null = null
let tray: Tray | null = null
let clickThrough = false
let saveTimer: NodeJS.Timeout | null = null

/**
 * 是否已获准真正关闭。
 *
 * 桌宠在托盘可用时把"关闭"重定向成"收进托盘"（无边框无标题栏，
 * 用户按 Alt+F4 的本意通常是暂时收起来）。所以窗口的 `close` 处理器
 * 会用 `preventDefault()` 拦下关闭 —— **而这条拦截也会拦下程序自己发起的退出**：
 * `app.exit()` / `app.quit()` 都要先去关窗，被拦下，于是退出流程走不完。
 *
 * 托盘菜单点"退出"没事，因为它顺手置了 `allowClose = true`；而别的退出路径
 * 若忘了置，就会被拦下。**两条退出路径的一致性没人管，就会漂移** ——
 * 所以退出收敛成 `quitApp()` 一个入口，由它统一置位。
 *
 * ⚠️ 归因更正（别再把后来的那个超时算在它头上）：
 *   早先这里写着"实测症状：冒烟里窗渲染正常、截图也落盘了，但进程挂到 60s 超时"，
 *   把那次超时归因给了本变量。**那个归因是错的，已撤回** —— 真因查出在别处：
 *   父进程根本收不到 Electron 子进程的退出通知（见 `desktop/launch.ts` 顶部），
 *   与 `allowClose` 无关。
 *   但这个变量本身仍然必要：它的机制（`preventDefault()` 拦下自发关闭）
 *   是真实的，只是**至今没被单独复现过**。所以留着它，也留着钉它的断言，
 *   但不要再拿它解释别的现象。
 */
let allowClose = false

/**
 * 唯一允许的退出入口。**任何退出都必须走它。**
 *
 * 存在的理由就是上面那个漂移：只要还有第二处直接写 `app.exit()`/`app.quit()`，
 * 就迟早会漏掉 `allowClose`，而症状是"程序关不掉"这种最难归因的形态。
 * `scripts/pet-smoke.ts` 有两条断言钉住它：这个函数体之外不得出现
 * `app.exit(` 或 `app.quit()`；带码分支必须是 `process.exit()`。
 *
 * ── 为什么分带码 / 不带码两条路 ───────────────────────────────────────
 * 两条路对应两种需求，不是两种写法：
 *
 *   · 不带码 —— 用户在托盘点"退出"。要的是**走完整退出流程**：
 *     触发 `will-quit` 把 `globalShortcut` 注销掉、清掉未落盘的位置写入。
 *     `app.quit()` 正是干这个的，`_probe_win.ts` 实测这条路径进程能正常终止。
 *
 *   · 带码 —— 自动化路径（冒烟、失败早退）。要的是"终止"和"退出码"**绑死**。
 *     这里不用 `app.quit()` + `process.exitCode`，因为 `process.exitCode` 是
 *     一条**旁路**：它只有在进程自然退出时才生效，一旦进程卡着不退，
 *     写进去的退出码就永远用不上 —— 而"进程卡着不退"在这台机器上不是假设
 *     （见 `desktop/launch.ts` 顶部：父进程收不到 Electron 的退出通知）。
 *     `process.exit(code)` 一条语句同时办完两件事，不依赖任何后续事件。
 *
 * ⚠️ 别把这里的取值反过来：**它管的只是"退出码怎么交出去"，不是"能不能退出"。**
 *    `app.quit()` / `app.exit(0)` / `process.exit(0)` 三种都实测过，**都能让进程终止**；
 *    早先记下的"`app.exit()` 在本环境返回而不终止"是把父进程收不到通知
 *    误读成了进程没退出（详见 launch.ts 顶部那段）。按那个误读改这里，改的是错的地方。
 */
function quitApp(code?: number): void {
  allowClose = true
  if (typeof code === 'number') process.exit(code)
  app.quit()
}

interface StoredConfig {
  position?: { x: number; y: number }
}

/**
 * 读位置配置。**任何异常都回落默认，绝不抛**。
 *
 * 桌宠不是主功能，一个坏掉的 JSON 不该导致它起不来；
 * 而"起不来"的表现是"桌宠不见了"，用户完全无法判断是配置坏了还是没启动。
 * （上游 airi 用 `autoHeal: true` 表达同一件事。）
 */
function readConfig(): StoredConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as StoredConfig
    const p = raw?.position
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return {}
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return {}
    return { position: { x: p.x, y: p.y } }
  } catch {
    return {}
  }
}

function writeConfig(cfg: StoredConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {
    /* 写不进去只是丢失位置记忆，不影响桌宠本身 */
  }
}

/** 所有显示器的工作区（不含任务栏区域）。 */
function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea)
}

/**
 * 把窗口钳回屏幕内。
 *
 * 三个触发点都要调它，缺一个就会留下"桌宠跑到屏幕外"的窗口期：
 *   ① 启动时 ← 存下的坐标可能来自已拔掉的外接屏；
 *   ② 显示器拓扑变化时 ← 用户正在改分辨率/拔屏，此刻不钳就永远越界；
 *   ③ 用户手动"重置位置"时 ← 兜底入口。
 */
function reclampToWorkAreas(win: BrowserWindow): void {
  const b = win.getBounds()
  const next = clampToNearestWorkArea(b, workAreas())
  if (next.x !== b.x || next.y !== b.y) {
    win.setBounds({ x: next.x, y: next.y, width: b.width, height: b.height })
  }
}

/** 把桌宠放回主屏右下角 —— 用户唯一需要的"我找不到它了"入口。 */
function resetToPrimaryCorner(win: BrowserWindow): void {
  const wa = screen.getPrimaryDisplay().workArea
  const pad = 24
  win.setBounds({
    x: Math.round(wa.x + wa.width - DEFAULT_PET_SIZE.width - pad),
    y: Math.round(wa.y + wa.height - DEFAULT_PET_SIZE.height - pad),
    width: DEFAULT_PET_SIZE.width,
    height: DEFAULT_PET_SIZE.height,
  })
}

function sendState(win: BrowserWindow, recovery: ReturnType<typeof resolveRecoveryPlan>): void {
  if (win.isDestroyed()) return
  win.webContents.send('pet:state', {
    clickThrough,
    alwaysOnTop: win.isAlwaysOnTop(),
    visible: win.isVisible(),
    bounds: win.getBounds(),
    recovery,
  })
}

/**
 * 建托盘。
 *
 * 菜单回调里引用的是**模块级**的 `petWindow`，而不是参数传进来的窗口 ——
 * 这是为了解开一个循环依赖：托盘菜单需要能操作窗口，
 * 而"托盘能不能建成"又必须在构造窗口**之前**知道（它决定 skipTaskbar）。
 * 回调只在用户点菜单时执行，那时 `petWindow` 早已赋值。
 */
function createTray(): boolean {
  try {
    const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
    tray = new Tray(img)
    tray.setToolTip('EVOLVE 桌宠')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 / 隐藏', click: () => toggleVisible() },
        { label: '重置位置（找不到它时点这里）', click: () => resetAndShow() },
        { type: 'separator' },
        {
          label: '鼠标穿透（点桌面时不再挡住）',
          type: 'checkbox',
          checked: false,
          click: (item) => setClickThrough(item.checked),
        },
        { label: '重新载入', click: () => petWindow?.webContents.reload() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => quitApp(),
        },
      ]),
    )
    tray.on('click', () => toggleVisible())
    return true
  } catch {
    // 托盘在某些 Linux 桌面 / 权限受限环境会失败。失败不是错误，
    // 但**必须**让恢复方案跟着降级 —— 见 resolveRecoveryPlan。
    tray = null
    return false
  }
}

function toggleVisible(): void {
  if (!petWindow) return
  if (petWindow.isVisible()) petWindow.hide()
  else petWindow.show()
}

function resetAndShow(): void {
  if (!petWindow) return
  resetToPrimaryCorner(petWindow)
  petWindow.show()
}

function setClickThrough(on: boolean): void {
  clickThrough = Boolean(on)
  if (!petWindow) return
  // `forward: true` 很关键：不加它，穿透之后连 mousemove 都收不到，
  // 桌宠的头像就无法再做跟随鼠标的视线/倾斜。
  petWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
}

function createPetWindow(trayOk: boolean): BrowserWindow {
  const recovery = resolveRecoveryPlan({ trayCreated: trayOk })
  const stored = readConfig()
  // 先钳再进窗口构造：构造完再钳会让窗口"先闪现在屏幕外、再跳回来"
  const positioned = stored.position
    ? clampToNearestWorkArea(
        { ...stored.position, width: DEFAULT_PET_SIZE.width, height: DEFAULT_PET_SIZE.height },
        workAreas(),
      )
    : null

  const plan = createPetWindowPlan({
    size: DEFAULT_PET_SIZE,
    position: positioned,
    preloadPath: join(HERE, 'preload.mjs'),
    skipTaskbar: recovery.skipTaskbar,
  })

  const win = new BrowserWindow(plan)
  win.setMenuBarVisibility(false)
  const args = alwaysOnTopArgs(process.platform)
  win.setAlwaysOnTop(args.flag, args.level, args.relativeLevel)
  // 全屏应用（视频/演示）会占满屏幕，这个开关让桌宠仍然可见。
  win.setVisibleOnAllWorkspaces(true)

  // ── 导航护栏（语义学自 airi 的 protectPrivilegedWindowNavigation）────────
  // 桌宠页持有编排令牌。若它能被导航到任意站点，令牌就等于交给了那个站点。
  // 规则：同 URL 重载放行（Vite 热更要用），其余一律拦住并交给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const savePosition = () => {
    if (saveTimer) clearTimeout(saveTimer)
    // 拖动时 move 事件每帧都发，防抖 400ms，否则每秒写盘几十次
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      writeConfig({ position: { x: b.x, y: b.y } })
    }, 400)
  }
  win.on('move', savePosition)
  win.on('resize', savePosition)

  win.on('close', (event) => {
    // allowClose 由托盘"退出"置位。没有它，托盘退出会被这里拦下，进程关不掉。
    if (allowClose || !recovery.hideOnClose) return
    event.preventDefault()
    win.hide()
  })

  // 透明窗在部分显卡驱动上不触发 ready-to-show，必须补一个兜底定时器，
  // 否则表现是"进程在跑、桌宠永远不出现"。
  let shown = false
  const showOnce = () => {
    if (shown || win.isDestroyed()) return
    shown = true
    // showInactive：不抢焦点。桌宠升起来时不该把用户正在打字的窗口顶掉。
    win.showInactive()
  }
  win.on('ready-to-show', showOnce)
  setTimeout(showOnce, 3000)
  win.webContents.on('did-finish-load', () => setTimeout(showOnce, 200))

  win.webContents.on('did-finish-load', () => sendState(win, recovery))

  // IPC：桌宠页只能做这五件事。刻意不暴露"任意窗口操作"，
  // 因为进程级能力一旦敞开，页面上任何一个 XSS 都升级成本地任意操作。
  ipcMain.on('pet:hide', () => win.hide())
  ipcMain.on('pet:quit', () => quitApp())
  ipcMain.on('pet:reset-position', () => {
    resetToPrimaryCorner(win)
    win.show()
  })
  ipcMain.on('pet:set-click-through', (_e, on: boolean) => {
    setClickThrough(on)
    sendState(win, recovery)
  })
  ipcMain.on('pet:get-state', () => sendState(win, recovery))

  // ── 原生拖动 ─────────────────────────────────────────────────────────
  // 不用 CSS `-webkit-app-region: drag`：无边框窗上它有已知 bug（拖到一半丢帧、
  // 松手后窗口继续跟鼠标走）。桌宠是唯一窗口，拖不动等于废了。
  //
  // 起点只在 drag-begin 记一次，之后每次都从**固定起点**叠加位移。
  // 若改成"当前位置 + 本次位移"，IPC 延迟会让误差逐步累积，越拖越偏。
  let dragOrigin = null
  ipcMain.on('pet:drag-begin', () => {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    dragOrigin = { x: b.x, y: b.y }
  })
  ipcMain.on('pet:drag-by', (_e, delta) => {
    if (win.isDestroyed() || !dragOrigin) return
    const next = nextDragPosition(dragOrigin, delta ?? { dx: 0, dy: 0 })
    win.setBounds({ x: next.x, y: next.y, width: DEFAULT_PET_SIZE.width, height: DEFAULT_PET_SIZE.height })
  })

  void win.loadURL(PET_URL)
  return win
}

/**
 * 冒烟：等页面渲染完 → 截一张图落盘 → 打印诊断 → 退出。
 *
 * ★ 退出走 `quitApp(0)`（不是直接 `app.quit()`）：这样 `allowClose` 一定被置位，
 *   而带码分支用 `process.exit(0)`，把"终止"和"退出码"绑在一条语句上。
 *   理由见上面 `quitApp()` 的注释。
 *
 * ★ 结论是**打在 stdout 上的那一行** `PET_SMOKE_OK <json>`，
 *   而不是"进程什么时候退出" —— 启动器靠读这一行定论。
 *   这一行因此是**协议**，不只是日志：改前缀要同步改
 *   `desktop/launch.ts` 与 `scripts/pet-smoke.ts` 里的同名常量。
 */
async function runSmoke(): Promise<void> {
  const win = petWindow
  if (!win) {
    console.error('PET_SMOKE_FAIL 窗口未创建')
    quitApp(2)
    return
  }
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  }
  // 留出拉状态、字体加载、头像绘制的时间
  await new Promise((r) => setTimeout(r, 3000))
  try {
    const img = await win.webContents.capturePage()
    writeFileSync(SMOKE_OUT, img.toPNG())
    console.log(
      'PET_SMOKE_OK ' +
        JSON.stringify({
          url: win.webContents.getURL(),
          bounds: win.getBounds(),
          alwaysOnTop: win.isAlwaysOnTop(),
          visible: win.isVisible(),
          platform: process.platform,
          electron: process.versions.electron,
          node: process.versions.node,
          shot: SMOKE_OUT,
        }),
    )
    quitApp(0)
  } catch (err) {
    console.error('PET_SMOKE_FAIL ' + String(err))
    quitApp(3)
  }
}

if (!app.requestSingleInstanceLock()) {
  quitApp()
} else {
  app.on('second-instance', () => {
    if (!petWindow) return
    petWindow.show()
    petWindow.focus()
  })

  app.whenReady().then(() => {
    // 顺序是硬要求：托盘先探测（它决定 skipTaskbar 与"关窗是否拦截"），
    // 拿到结果再构造窗口。反过来的话，两个决策会各判一次，必然出现
    // "任务栏没有条目、窗口又关不掉"的死局。
    const trayOk = createTray()
    petWindow = createPetWindow(trayOk)

    const onDisplayChange = () => {
      if (petWindow && !petWindow.isDestroyed()) reclampToWorkAreas(petWindow)
    }
    screen.on('display-removed', onDisplayChange)
    screen.on('display-metrics-changed', onDisplayChange)

    globalShortcut.register('Alt+Shift+P', () => toggleVisible())
    // 找回入口的键盘版：鼠标够不到时用
    globalShortcut.register('Alt+Shift+R', () => resetAndShow())

    if (SMOKE) void runSmoke()
  })

  app.on('window-all-closed', () => {
    // 无托盘时窗口关掉就该退出；有托盘时关窗已被拦下，走不到这里
    if (!tray) quitApp()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (saveTimer) clearTimeout(saveTimer)
  })
}
