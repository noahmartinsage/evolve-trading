/**
 * EVOLVE 桌宠 · 预加载脚本
 *
 * ⚠ 本文件是**纯 JS**，不能写 TS 类型注解。Node 的类型擦除只作用于 `.ts`，
 *   `.mjs` 里的 `: string` 会原样变成语法错误。TS 侧的类型声明在
 *   `src/pet/petBridge.ts`，两边通过通道名字符串对齐 —— 通道名改动必须同时改两处，
 *   所以下面每个字符串都加了 `pet:` 前缀以便全文检索。
 *
 * ── 为什么必须是白名单，而不是把 ipcRenderer 整个递过去 ────────────────
 * 桌宠页与普通网页共享同一个渲染进程模型。若把 `ipcRenderer` 直接暴露，
 * 页面上任何一处注入（第三方依赖被投毒、贴进对话的一段 HTML）
 * 都能顺手调 `pet:quit`、改窗口、乃至在未来某个新增通道上做别的事。
 *
 * 这里只暴露 8 个动作，且全部是"桌面外壳"语义，没有一个能触达业务：
 * 隐藏 / 退出 / 重置位置 / 鼠标穿透 / 读状态 / 听状态 / 开始拖动 / 拖动位移。
 * （拖动那两条是必需的：无边框窗的 CSS `-webkit-app-region: drag` 有已知 bug，
 *   桌宠又是唯一的窗口，拖不动等于废了。理由见 src/pet/petWindow.ts。）
 * **业务能力（下单、查仓）一律走 HTTP 到编排服务** —— 那条路上有风控与审计，
 * 而进程间通道上没有。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petBridge', {
  available: true,
  hide: () => ipcRenderer.send('pet:hide'),
  quit: () => ipcRenderer.send('pet:quit'),
  resetPosition: () => ipcRenderer.send('pet:reset-position'),
  setClickThrough: (on) => ipcRenderer.send('pet:set-click-through', Boolean(on)),
  getState: () => ipcRenderer.send('pet:get-state'),
  dragBegin: () => ipcRenderer.send('pet:drag-begin'),
  // 只传两个数字。刻意不传"目标位置"：渲染进程不该知道窗口的绝对坐标，
  // 那等于把窗口控制权递给了页面 —— 页面上任何一处注入都能把桌宠挪走。
  dragBy: (d) => {
    const dx = Number(d?.dx)
    const dy = Number(d?.dy)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    ipcRenderer.send('pet:drag-by', { dx, dy })
  },
  // 返回取消订阅函数 —— 不返回的话 React 卸载后监听器会累积，
  // 重新挂载时收到重复状态，表现为"切一次页面按钮状态就跳一下"。
  onState: (cb) => {
    const handler = (_e, s) => cb(s)
    ipcRenderer.on('pet:state', handler)
    return () => ipcRenderer.removeListener('pet:state', handler)
  },
})
