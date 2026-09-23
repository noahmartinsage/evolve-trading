import React, { useEffect, useMemo } from 'react'
import { StoreProvider, useStore, usePage, pushToast } from './store/Store'
import { fetchSnapshot, connectTicker } from './data/market'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import OverviewPage from './pages/OverviewPage'
import VoiceHubPage from './pages/VoiceHubPage'
import MissionPage from './pages/MissionPage'
import DecisionBrainPage from './pages/DecisionBrainPage'
import TerminalPage from './pages/TerminalPage'
import AgentsPage from './pages/AgentsPage'
import EvoPage from './pages/EvoPage'
import FactorsPage from './pages/FactorsPage'
import NewsPage from './pages/NewsPage'
import ProtocolPage from './pages/ProtocolPage'
import RiskCenterPage from './pages/RiskCenterPage'
import SeamPage from './pages/SeamPage'
import MonitorPage from './pages/MonitorPage'
import SettingsPage from './pages/SettingsPage'
import Toast from './components/Toast'
import CommandPalette from './components/CommandPalette.tsx'
import { useUiActionRunner } from './ui/useUiActionRunner.ts'

function Router() {
  const { page } = usePage()
  switch (page) {
    case 'overview': return <OverviewPage />
    case 'voice': return <VoiceHubPage />
    case 'mission': return <MissionPage />
    case 'brain': return <DecisionBrainPage />
    case 'terminal': return <TerminalPage />
    case 'agents': return <AgentsPage />
    case 'evo': return <EvoPage />
    case 'factors': return <FactorsPage />
    case 'news': return <NewsPage />
    case 'protocol': return <ProtocolPage />
    case 'risk': return <RiskCenterPage />
    case 'seam': return <SeamPage />
    case 'monitor': return <MonitorPage />
    case 'settings': return <SettingsPage />
    default: return <OverviewPage />
  }
}

function AppInner() {
  const { dispatch } = useStore()
  /**
   * 桌宠窗（Electron 的 `?pet=1`）只渲染语音管家页的**悬浮形态**，不挂侧边栏与顶栏。
   *
   * 它不是另一个页面 —— 合并之后悬浮窗与常规页面是同一个组件的两种布局，
   * 数据与动作来自同一个会话内核。这里只是决定"用哪种摆放"。
   *
   * 用查询参数而不是路由：这个决定必须在**渲染之前**就定下来，
   * 而且它在一个会话内不变（桌宠窗不会自己导航去别的页）。
   */
  const standalonePet = useMemo(
    () => new URLSearchParams(window.location.search).get('pet') === '1',
    [],
  )

  /**
   * 界面动作执行器（桌宠/语音排过来的按钮，由界面自己按）。
   *
   * ★ 只在**主窗口**挂，悬浮桌宠窗不挂。理由很具体：桌宠窗只渲染语音管家那一页，
   *   别的页面的按钮在它的 DOM 里根本不存在 —— 挂了它只会把每条动作都报成
   *   `NO_SUCH_ELEMENT`，而那些动作已经被它标记成"处理过了"，
   *   于是**主窗口再也不会去执行它们**。一个窗口报错、另一个窗口因为被抢跑而不干活，
   *   这是最坏的一种分工。
   * ★ 多开标签页的情况由服务端的"取活即认领"处理（见 server/uiActions.ts）。
   */
  useUiActionRunner(!standalonePet)

  // 全局行情心跳：每 2s 推送一次价格 TICK（真实行情在线时仅维持运行时长）
  useEffect(() => {
    if (standalonePet) return
    const t = setInterval(() => dispatch({ type: 'TICK' }), 2000)
    return () => clearInterval(t)
  }, [dispatch, standalonePet])

  // 真实行情：先 REST 快照对齐，再 WebSocket 持续推送；断线自动降级回模拟
  useEffect(() => {
    // 桌宠不需要行情：它自己不显示行情，播报里的盘面数字来自编排服务。
    // 不拦的话，桌宠窗会额外拉起一条 WS —— 每个桌宠实例都多一条，白烧连接。
    if (standalonePet) return
    let mounted = true
    fetchSnapshot()
      .then(({ value, source }) => {
        const { updates, missing } = value
        if (!mounted || updates.length === 0) {
          // ★ 一个都没拿到 ≠ 行情在线。原来这里直接 return，界面停在"没有报价"，
          //   而那跟"还没推过来"没法区分（判据 24：缺数据要说出来）。
          if (mounted) pushToast(dispatch, '⚠️ 行情快照为空 · 交易对暂无报价')
          return
        }
        dispatch({ type: 'MARKET_SNAPSHOT', updates })
        dispatch({ type: 'SET_LIVE', live: true })
        // ★ 来源随数据一起进 Store：界面上那几处"行情源"从此**读**它，不再各自写死。
        dispatch({ type: 'SET_MARKET_SOURCE', source })
        // ★ 部分缺失要**点名**：少了哪个交易对是能在界面上看出来的（显示"—"），
        //   但"为什么是 —"必须在这里说出来，否则用户只会以为是网络慢。
        // ★ 来源也**从数据里读**（`source`），不写死品牌名 —— 回退链生效时，
        //   写死的那个名字会让这句提示撒谎，而它撒的正是"这些数是谁给的"。
        pushToast(
          dispatch,
          missing.length === 0
            ? `📡 已接入 ${source} 实时行情 · ${updates.length} 个交易对`
            : `📡 已接入 ${source} 实时行情 · ${updates.length} 个交易对 · ⚠️ 无报价：${missing.join('、')}`,
        )
      })
      .catch((e: unknown) => {
        if (mounted) {
          const why = e instanceof Error ? e.message : String(e)
          // ★ 读不到就说读不到，并把来源清成 `null` —— 留着上一次的名字会让
          //   「行情源」那一格显示一个**已经不再给数的来源**（判据 11：静默陈旧）。
          dispatch({ type: 'SET_MARKET_SOURCE', source: null })
          pushToast(dispatch, `⚠️ 实时行情连接失败（${why}）· 交易对暂不显示报价（不会再编造价格）`)
        }
      })
    const stop = connectTicker(
      (update) => dispatch({ type: 'MARKET_TICK', update }),
      (live) => dispatch({ type: 'SET_LIVE', live }),
    )
    return () => {
      mounted = false
      stop()
    }
  }, [dispatch, standalonePet])

  // 桌宠窗：只有它自己，没有侧边栏/顶栏。透明底由 main.tsx 打上的
  // `html.pet-standalone` 负责 —— 那是透明窗不变成黑方块的唯一条件。
  if (standalonePet) {
    return (
      <>
        <VoiceHubPage standalone />
        <Toast />
      </>
    )
  }

  // 流式布局：canvas 填满浏览器窗口，随窗口尺寸自适应（移除固定 1440×900 缩放）
  return (
    <div className="canvas">
      <Sidebar />
      <div className="main-panel">
        <TopBar />
        <Router />
      </div>
      <Toast />
      {/*
        * ★ 命令面板只挂在**完整控制台**里，不挂在桌宠窗口上。
        *   桌宠窗口是一个 380×560 的悬浮壳，它 DOM 里根本没有别的页面；
        *   在它上面弹一个"跳到某某页"的面板，点了也只是把壳自己切走 ——
        *   那个面板会指向一堆不存在的东西（判据 17：输出把用户引向哪个动作）。
        *   与执行器（`useUiActionRunner(!standalonePet)`）是同一条理由。
        */}
      {!standalonePet && <CommandPalette />}
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <AppInner />
    </StoreProvider>
  )
}
