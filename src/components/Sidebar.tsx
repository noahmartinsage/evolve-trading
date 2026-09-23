import React, { useEffect, useState } from 'react'
import { usePage, useStore, PageId } from '../store/Store'
import { useAccount } from 'wagmi'
import { chains } from '../wallet/config'
import { listLlmProviders } from '../orch/client.ts'

/**
 * 导航项 —— **唯一一份**。
 *
 * ★ 导出它是因为命令面板（`CommandPalette.tsx`）也要列这些页面。
 *   让它自己抄一张表 = 立刻多一个主人：以后加一页、只改侧边栏，
 *   面板里就永远搜不到那一页，而且不会有任何报错。
 */
export const navItems: { id: PageId; label: string }[] = [
  { id: 'overview', label: '总览控制台' },
  // 悬浮桌宠已**合并进这一页**：`npm run pet` 起的是同一个页面的悬浮形态。
  // 导航里只留一个入口 —— 两个入口会诱导出第二套会话实现。
  { id: 'voice', label: '语音管家 · 桌宠' },
  // 紧挨着语音管家：说目标 → 拿口令 → 念给桌宠（或在这里敲）。
  // 两者离得远，用户就会以为"用嘴启动"是另一套东西。
  { id: 'mission', label: '任务' },
  { id: 'brain', label: '决策大脑' },
  { id: 'terminal', label: '交易终端' },
  { id: 'agents', label: 'Agent 舰队' },
  { id: 'evo', label: '进化实验室' },
  // 紧跟在进化实验室后面：因子是进化产线的**产出入库单** ——
  // 上一层回答"这个信号有没有预测力"，这一页回答"扣掉成本还赚不赚钱"。
  { id: 'factors', label: '因子工厂' },
  // 紧跟在因子工厂后面：因子工厂回答"现在有没有能赚钱的信号"，
  // 这一页回答"外面正在发生什么、系统从外面学到了什么"。
  // 摆在因子工厂后面而不是塞进系统类，是因为它的产出**真的会**影响 breadth 的选品。
  { id: 'news', label: '新闻雷达' },
  { id: 'protocol', label: '协议栈' },
  { id: 'risk', label: '风控中心' },
  { id: 'seam', label: '可信接缝' },
]

const sysItems: { id: PageId; label: string }[] = [
  { id: 'monitor', label: '系统监控' },
  { id: 'settings', label: '参数设置' },
]

function NavIcon({ id }: { id: string }) {
  const c = 'currentColor'
  if (id === 'overview') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke={c} strokeWidth="1.2" />
        <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke={c} strokeWidth="1.2" />
        <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke={c} strokeWidth="1.2" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'voice') {
    // 麦克风 + 右下角小窗 = **合并后的一个入口**：语音能力，两种形态。
    // 麦克风部分刻意不用"声波"图形 —— 声波看不出"可以打断"这件事，
    // 而打断是本功能最容易被忽略的能力；小窗标记是"它还能浮在桌面上"的唯一线索。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="6" y="1.8" width="4" height="7.4" rx="2" stroke={c} strokeWidth="1.2" />
        <path d="M4 7.4 C4 11 11.4 11 11.4 7.4" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M8 11.2 L8 14.2" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M5.8 14.2 L9.6 14.2" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <rect x="10.6" y="11.2" width="3.6" height="3" rx="0.9" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'terminal') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 4 L12 4 L12 13 L4 13 Z" stroke={c} strokeWidth="1.2" fill="none" />
        <rect x="5" y="6" width="2" height="4" fill="#FF4D6D" rx="0.5" />
        <rect x="8" y="5" width="2" height="5" fill="#00D68F" rx="0.5" />
        <rect x="11" y="7" width="2" height="3" fill="#FF4D6D" rx="0.5" />
      </svg>
    )
  }
  if (id === 'agents') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2.5" y="4.5" width="11" height="8.5" rx="2" stroke={c} strokeWidth="1.2" />
        <path d="M6 2.2 L10 2.2" stroke={c} strokeWidth="1.2" />
        <circle cx="6" cy="8.5" r="1" fill={c} />
        <circle cx="10" cy="8.5" r="1" fill={c} />
        <path d="M8 9.6 L8 11" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'evo') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3.33 2.5 L8 14 L12.67 2.5" stroke={c} strokeWidth="1.2" fill="none" />
        <path d="M4.6 9.8 L11.4 9.8" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'factors') {
    // 漏斗 = 逐道闸门筛选。刻意**不用**方格/表格图形：
    // 那与总览的"四个方块"在 16px 下分不出来，而这两个入口的含义差得很远
    // （一个是"看全貌"，一个是"看谁被哪道闸门拦下了"）。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2.4 2.8 L13.6 2.8 L9.3 8.3 L9.3 13.4 L6.7 12 L6.7 8.3 Z" stroke={c} strokeWidth="1.2" strokeLinejoin="round" fill="none" />
        <path d="M5.2 5.4 L10.8 5.4" stroke={c} strokeWidth="1" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'mission') {
    // 旗子插在终点 = 目标。刻意不用"同心圆靶心"：那与决策大脑的圆心+放射线
    // 在 16px 下几乎分不出来，而这两个入口的含义差得很远
    // （一个是"我要到哪"，一个是"系统怎么想"）。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3.6 1.6 L3.6 14.4" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M3.6 2.4 L12.4 5.2 L3.6 8 Z" stroke={c} strokeWidth="1.2" strokeLinejoin="round" fill="none" />
        <path d="M1.8 14.4 L5.6 14.4" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'news') {
    // 雷达天线 = "朝外看"。刻意**不用**喇叭/铃声（那是"通知"，会被读成
    // 一个消息盒子）、也不用列表线条（那与交易终端的表格在 16px 下分不出来）。
    // 含义是：它自己定时去扫，不是等人来点。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3.2 12.8 L3.2 9.4" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M11.2 12.8 C11.2 7.6 7.4 3.8 2.2 3.8" stroke={c} strokeWidth="1.2" strokeLinecap="round" fill="none" />
        <path d="M11.2 12.8 C11.2 10.2 9.4 8.4 6.8 8.4" stroke={c} strokeWidth="1.2" strokeLinecap="round" fill="none" />
        <circle cx="11.6" cy="12.8" r="1.5" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'brain') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="2.6" stroke={c} strokeWidth="1.2" />
        <path d="M8 5.4 L8 2.8 M8 10.6 L8 13.2 M5.9 6.5 L3.6 5 M10.1 9.5 L12.4 11 M10.1 6.5 L12.4 5 M5.9 9.5 L3.6 11" stroke={c} strokeWidth="1.1" />
        <circle cx="8" cy="2.2" r="1" fill={c} />
        <circle cx="8" cy="13.8" r="1" fill={c} />
        <circle cx="3" cy="4.4" r="1" fill={c} />
        <circle cx="13" cy="11.6" r="1" fill={c} />
        <circle cx="13" cy="4.4" r="1" fill={c} />
        <circle cx="3" cy="11.6" r="1" fill={c} />
      </svg>
    )
  }
  if (id === 'protocol') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 2 L14 2 L14 8 L2 8 Z" stroke={c} strokeWidth="1.2" />
        <path d="M2.6 8 L13.4 8 L13.4 11 L2.6 11 Z" stroke={c} strokeWidth="1.2" />
        <path d="M2.6 11 L13.4 11 L13.4 14 L2.6 14 Z" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  if (id === 'risk') {
    // 盾牌：风控的语义就是「兜底」。16px 网格上收在居中 10px 宽度内，与其它图标视觉重量一致。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.8 L13.2 3.6 L13.2 7.6 C13.2 10.7 11 12.9 8 14.2 C5 12.9 2.8 10.7 2.8 7.6 L2.8 3.6 Z" stroke={c} strokeWidth="1.2" fill="none" />
        <path d="M5.6 7.7 L7.2 9.3 L10.5 6" stroke={c} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (id === 'seam') {
    // 接缝：左右两条通道（CEX / DEX），中间一道带校验的缝合线。
    // 语义是「两个不同域被一条可审计的规则连起来」，而不是「它们是一回事」——
    // 所以两柱刻意不接触，中间是虚线 + 校验点。
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.8" y="3" width="3.2" height="10" rx="1" stroke={c} strokeWidth="1.2" />
        <rect x="11" y="3" width="3.2" height="10" rx="1" stroke={c} strokeWidth="1.2" />
        <path d="M5.6 8 L7 8 M9 8 L10.4 8" stroke={c} strokeWidth="1.2" strokeDasharray="1.4 1.4" />
        <circle cx="8" cy="8" r="1.5" stroke={c} strokeWidth="1.1" />
        <path d="M7.35 8 L7.85 8.5 L8.7 7.5" stroke={c} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (id === 'monitor') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2.5" width="12" height="8.5" rx="2" stroke={c} strokeWidth="1.2" />
        <path d="M5.5 11 L10.5 11 L8 14 Z" stroke={c} strokeWidth="1.2" fill="none" />
      </svg>
    )
  }
  if (id === 'settings') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="3.5" stroke={c} strokeWidth="1.2" />
        <path d="M8 1.8 L8 4.3 M8 11.7 L8 14.2 M1.8 8 L4.3 8 M11.7 8 L14.2 8 M3.52 3.52 L5.29 5.29 M10.71 10.71 L12.48 12.48 M3.52 12.48 L5.29 10.71 M10.71 5.29 L12.48 3.52" stroke={c} strokeWidth="1.2" />
      </svg>
    )
  }
  return null
}

export default function Sidebar() {
  const { page, setPage } = usePage()
  const { state, dispatch } = useStore()
  const { address, chainId, isConnected } = useAccount()
  const chain = chains.find((c) => c.id === chainId)

  const runningAgents = state.agents.filter((a) => a.status === 'running').length
  const openOrders = state.orders.filter((o) => o.status === 'open' || o.status === 'partial').length
  const heartBeat = 110 + (state.uptimeSec * 3) % 60

  // LLM 是否真的参与决策：读编排器 provider 真实启用状态（此前此处硬编码"在线"，与实际不符）
  const [llmOn, setLlmOn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const poll = () => {
      listLlmProviders(state.orchUrl)
        .then((r) => {
          if (alive) setLlmOn((r.providers ?? []).some((p) => p.enabled))
        })
        .catch(() => {
          if (alive) setLlmOn(null)
        })
    }
    poll()
    const t = setInterval(poll, 10_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [state.orchUrl])

  const go = (id: PageId) => {
    setPage(id)
    dispatch({ type: 'SET_TOAST', msg: null })
  }

  return (
    <div className="sidebar">
      <div className="top-glow" />

      <div className="logo-area">
        <div className="logo-mark">
          <svg width="30" height="30" viewBox="0 0 30 30">
            <polygon points="15,2.5 26.5,8.75 26.5,21.25 15,27.5 3.5,21.25 3.5,8.75" stroke="var(--primary)" strokeWidth="1.5" fill="none" />
            <circle cx="15" cy="15" r="4.5" fill="var(--primary)" />
            <circle cx="15" cy="15" r="2" fill="var(--bg-surface)" />
            <polygon points="15,7 21.5,10.75 21.5,18.25 15,22 8.5,18.25 8.5,10.75" stroke="var(--primary)" strokeWidth="1.2" fill="none" />
          </svg>
        </div>
        <span className="brand-name">EVOLVE</span>
        <div className="version-badge"><span>v4.0</span></div>
      </div>

      <div className="nav-section">
        <div className="section-label">导航</div>
        {navItems.map((item) => (
          <div
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => go(item.id)}
          >
            <div className="nav-icon"><NavIcon id={item.id} /></div>
            <span className="nav-label">{item.label}</span>
            {item.id === 'agents' && runningAgents > 0 && <span className="nav-badge">{runningAgents}</span>}
            {item.id === 'terminal' && openOrders > 0 && <span className="nav-badge warn">{openOrders}</span>}
          </div>
        ))}
      </div>

      <div className="nav-section">
        <div className="section-label">系统</div>
        {sysItems.map((item) => (
          <div
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => go(item.id)}
          >
            <div className="nav-icon"><NavIcon id={item.id} /></div>
            <span className="nav-label">{item.label}</span>
          </div>
        ))}
      </div>

      <div className="system-status-card">
        <div className="status-row">
          <span className="pulse-dot" style={llmOn ? undefined : { background: 'var(--text-weak)', boxShadow: 'none', animation: 'none' }} />
          <span className="status-name">LLM 推理引擎</span>
          <span className="status-online" style={llmOn ? undefined : { color: 'var(--text-weak)' }}>
            {llmOn === null ? '编排器离线' : llmOn ? '在线' : '未接入'}
          </span>
        </div>
        <div className="status-row">
          <span className="status-metric-label">自进化心跳</span>
          <span className="status-metric-value">{heartBeat} ms</span>
        </div>
        <div className="status-row">
          <span className="status-metric-label">协议结算</span>
          <span className="status-metric-value green">x402 ✓</span>
        </div>
      </div>

      <div className="user-row">
        <div className="user-avatar" style={isConnected ? { background: 'linear-gradient(135deg, #F6851B, #E2761B)' } : undefined} />
        <div className="user-info">
          {isConnected && address ? (
            <>
              <span className="user-name">{address.slice(0, 8)}…{address.slice(-6)}</span>
              <span className="user-rep" style={{ color: 'var(--down)' }}>已连接 · {chain?.name ?? `Chain ${chainId}`}</span>
            </>
          ) : (
            <>
              <span className="user-name">0x8dxd 主钱包</span>
              <span className="user-rep">未连接 · 点击顶栏连接真实钱包</span>
            </>
          )}
        </div>
      </div>

      <style>{`
        .sidebar {
          position: relative;
          flex-shrink: 0;
          width: 216px;
          height: 100%;
          background: var(--bg-surface);
          border-right: 1px solid var(--border);
          display: flex; flex-direction: column;
          padding: 12px;
          gap: 4px;
          z-index: 2;
        }
        .top-glow {
          position: fixed; left: 216px; top: 0;
          width: calc(100vw - 216px); height: 340px;
          background: radial-gradient(ellipse 100% 100% at 0% 0%, rgba(34,211,238,0.08) 0%, rgba(34,211,238,0) 70%);
          pointer-events: none; z-index: 0;
        }
        .logo-area {
          display: flex; align-items: center; gap: 10px;
          height: 44px; padding: 0 6px; margin-bottom: 8px;
        }
        .logo-mark { width: 30px; height: 30px; }
        .brand-name {
          font-family: var(--font-ui); font-size: 18px; font-weight: 800;
          color: var(--text-main); letter-spacing: 0.5px;
        }
        .version-badge {
          margin-left: auto;
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          border-radius: 4px; padding: 2px 6px;
        }
        .version-badge span {
          font-family: var(--font-mono); font-size: 10px; color: var(--text-weak);
        }
        .nav-section { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
        .section-label {
          font-family: var(--font-ui); font-size: 10px; font-weight: 500;
          color: var(--text-weak); padding: 4px 0; margin-bottom: 2px;
        }
        .nav-item {
          display: flex; align-items: center; gap: 8px;
          height: 36px; padding: 0 10px;
          border-radius: 8px; cursor: pointer;
          color: var(--text-sub); transition: background 0.2s;
          position: relative;
        }
        .nav-item:hover { background: rgba(255,255,255,0.03); color: var(--text-main); }
        .nav-item.active {
          background: var(--primary-10);
          border: 1px solid var(--primary-40);
          color: var(--primary);
        }
        .nav-icon { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; }
        .nav-label {
          font-family: var(--font-ui); font-size: 13px;
          font-weight: 400; color: inherit;
        }
        .nav-item.active .nav-label { font-weight: 600; }
        .nav-badge {
          margin-left: auto;
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          border-radius: 9px; padding: 1px 6px;
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          color: var(--accent);
        }
        .nav-badge.warn { color: var(--warning); }
        .system-status-card {
          margin-top: auto;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 10px;
          display: flex; flex-direction: column; gap: 8px;
          margin-bottom: 12px;
        }
        .status-row { display: flex; align-items: center; gap: 6px; }
        .pulse-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--down); flex-shrink: 0;
          box-shadow: 0 0 6px rgba(0,214,143,0.6);
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0% { opacity: 1; box-shadow: 0 0 4px rgba(0,214,143,0.5); }
          50% { opacity: 0.6; box-shadow: 0 0 8px rgba(0,214,143,0.8); }
          100% { opacity: 1; box-shadow: 0 0 4px rgba(0,214,143,0.5); }
        }
        .status-name {
          flex: 1; font-family: var(--font-ui); font-size: 11px; font-weight: 500;
          color: var(--text-sub);
        }
        .status-online {
          font-family: var(--font-ui); font-size: 10px; font-weight: 500;
          color: var(--down);
        }
        .status-metric-label {
          font-family: var(--font-ui); font-size: 10px; color: var(--text-weak);
        }
        .status-metric-value {
          margin-left: auto;
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          color: var(--primary);
        }
        .status-metric-value.green { color: var(--down); }
        .user-row {
          display: flex; align-items: center; gap: 8px;
          padding: 6px;
        }
        .user-avatar {
          width: 28px; height: 28px; border-radius: 14px; flex-shrink: 0;
          background: linear-gradient(135deg, var(--primary), var(--accent));
        }
        .user-info {
          display: flex; flex-direction: column; gap: 2px;
        }
        .user-name {
          font-family: var(--font-ui); font-size: 12px; font-weight: 600;
          color: var(--text-main);
        }
        .user-rep {
          font-family: var(--font-ui); font-size: 10px; color: var(--text-weak);
        }
      `}</style>
    </div>
  )
}
