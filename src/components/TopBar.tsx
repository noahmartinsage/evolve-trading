import React, { useEffect, useState } from 'react'
import { usePage, PageId } from '../store/Store'
import { useAccount } from 'wagmi'
import { chains } from '../wallet/config'
import WalletModal from './WalletModal'
import ModeBadge from './ModeBadge'

const titles: Record<PageId, { title: string; subtitle: string }> = {
  overview: { title: '总览控制台', subtitle: 'EVOLVE 系统态势 · 演示原型（非实盘业绩）' },
  // 合并后「语音管家」与「悬浮桌宠」是**同一个页面的两种形态**
  // （`npm run pet` 起的是同一组件的悬浮布局，不是另一个页面）。
  // 副标题刻意点明"不新开通道"：语音最容易被误读成一条绕过风控的捷径。
  voice: { title: '语音管家 · 悬浮桌宠', subtitle: '说话即查仓下单 · 随时打断 · 持续播报在做什么与下一步（与界面同一条风控路径）' },
  // 副标题里"先用系统自己的尺子量一遍"是这一层与普通"确认弹窗"的分界：
  // 它先判目标本身成不成立，再谈放不放行。顺序反过来的话，口令就成了一枚
  // 只要点一下就能过的图章。
  mission: { title: '任务', subtitle: '一句话目标 → 用系统自己的尺子量一遍 → 只有「可以做」才签发口令 → 念口令才启动' },
  brain: { title: '决策大脑', subtitle: '决策链路全透明 · CEX + DEX 双通道 · 实时同步' },
  terminal: { title: '交易终端', subtitle: '模拟撮合 + Uniswap V3 链上入口（实盘门禁）' },
  agents: { title: 'Agent 舰队', subtitle: '演示数据 · 策略舰队概念稿' },
  // 回测内核已接入（真实 K 线驱动），原"随机数占位"描述已过期
  evo: { title: '进化实验室', subtitle: '适应度已接回测引擎（真实 K 线）· 谱系树与 LLM 推理仍为演示' },
  protocol: { title: '协议栈', subtitle: 'x402 / ERC-8004 / MCP · 概念演示，未接真实协议' },
  monitor: { title: '系统监控', subtitle: 'orchestration 实时状态 · 下单前风控 · Kill Switch 控制' },
  // 副标题刻意写明「改动即时生效」——这正是本页与「参数设置」页的分工差异，
  // 用户需要知道哪一个是真正会改变引擎行为的入口。
  risk: { title: '风控中心', subtitle: '参数单一事实源 · 改动即时写盘并生效 · Fail-Closed 拦截管线' },
  seam: { title: '可信接缝', subtitle: '成本闸门 · 对手方三档信任 · 跨通道结算 · 人类在环审批 · 声称核验' },
  settings: { title: '参数设置', subtitle: '风控偏好（本机保存）· 执行层接入待阶段 C' },
}

function fmtClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} UTC+8`
}

export default function TopBar() {
  const { page } = usePage()
  const { address, chainId, isConnected } = useAccount()
  const [now, setNow] = useState(new Date())
  const [walletOpen, setWalletOpen] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const t = titles[page]
  const chain = chains.find((c) => c.id === chainId)

  return (
    <div className="topbar">
      <div className="title-block">
        <h1 className="page-title">{t.title}</h1>
        <p className="page-subtitle">{fmtClock(now)} · {t.subtitle}</p>
      </div>

      <div className="topbar-right">
        <ModeBadge />

        <div className={`wallet-badge ${isConnected ? 'connected' : ''}`} onClick={() => setWalletOpen(true)}>
          {isConnected ? (
            <>
              <span className="pulse-dot2 live" style={{ color: 'var(--down)', background: 'var(--down)', width: 6, height: 6 }} />
              <span className="badge-text">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
              <span className="badge-chain">{chain?.name ?? `Chain ${chainId}`}</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="1" y="3" width="10" height="7" rx="1.5" stroke="var(--primary)" strokeWidth="1.2" />
                <path d="M1 4.5 L11 4.5" stroke="var(--primary)" strokeWidth="1.2" />
                <circle cx="8.5" cy="6.5" r="1" fill="var(--primary)" />
              </svg>
              <span className="badge-text connect">连接钱包</span>
            </>
          )}
        </div>

        {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}

        <div className="topbar-avatar" />
      </div>

      <style>{`
        .topbar {
          height: 56px;
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 20px;
          position: relative; z-index: 10;
          border-bottom: 1px solid var(--border);
          background: rgba(4,6,13,0.6);
        }
        .title-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .page-title {
          font-family: var(--font-ui); font-size: 18px; font-weight: 800;
          color: var(--text-main); line-height: 1.2;
        }
        .page-subtitle {
          font-family: var(--font-mono); font-size: 10px; font-weight: 400;
          color: var(--text-weak); line-height: 1.2;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 640px;
        }
        .topbar-right { display: flex; align-items: center; gap: 10px; }
        .protocol-badge, .wallet-badge {
          display: flex; align-items: center; gap: 6px;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 14px; padding: 5px 10px;
        }
        .protocol-badge.clickable { cursor: pointer; transition: all 0.15s; }
        .protocol-badge.clickable:hover { border-color: var(--primary-40); transform: translateY(-1px); }
        .wallet-badge { border-radius: 8px; gap: 8px; cursor: pointer; transition: all 0.15s; }
        .wallet-badge:hover, .wallet-badge.connected { border-color: var(--primary-40); background: var(--bg-elevated); }
        .badge-text.connect { color: var(--primary); font-weight: 700; }
        .badge-chain {
          font-family: var(--font-ui); font-size: 9px; font-weight: 600;
          color: var(--down); background: rgba(0,214,143,0.1);
          border-radius: 8px; padding: 1px 7px;
        }
        .dot { width: 6px; height: 6px; border-radius: 50%; }
        .dot.cyan { background: var(--primary); box-shadow: 0 0 4px rgba(34,211,238,0.5); }
        .dot.magenta { background: var(--accent); box-shadow: 0 0 4px rgba(232,121,249,0.5); }
        .dot.amber { background: var(--warning); box-shadow: 0 0 4px rgba(255,176,32,0.5); }
        .badge-text {
          font-family: var(--font-mono); font-size: 10px; font-weight: 500;
          color: var(--text-sub);
        }
        .topbar-avatar {
          width: 28px; height: 28px; border-radius: 14px;
          background: linear-gradient(135deg, var(--primary), var(--accent));
        }
      `}</style>
    </div>
  )
}
