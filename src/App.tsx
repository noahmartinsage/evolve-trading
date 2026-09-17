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
import ProtocolPage from './pages/ProtocolPage'
import RiskCenterPage from './pages/RiskCenterPage'
import SeamPage from './pages/SeamPage'
import MonitorPage from './pages/MonitorPage'
import SettingsPage from './pages/SettingsPage'
import Toast from './components/Toast'

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
      .then((updates) => {
        if (!mounted || updates.length === 0) return
        dispatch({ type: 'MARKET_SNAPSHOT', updates })
        dispatch({ type: 'SET_LIVE', live: true })
        pushToast(dispatch, `📡 已接入 Binance 实时行情 · ${updates.length} 个交易对`)
      })
      .catch(() => {
        if (mounted) pushToast(dispatch, '⚠️ 实时行情连接失败 · 已降级为模拟引擎')
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
