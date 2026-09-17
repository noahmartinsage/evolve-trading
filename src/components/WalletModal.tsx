import React from 'react'
import { useAccount, useConnect, useConnectors, useDisconnect, useBalance, useSwitchChain, useReadContract, injected } from 'wagmi'
import { formatUnits, erc20Abi } from 'viem'
import { chains, usdcByChain, chainColor } from '../wallet/config'
import { useStore, pushToast } from '../store/Store'

export default function WalletModal({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore()
  const { address, chainId, isConnected } = useAccount()
  const { connectAsync, isPending } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const connectors = useConnectors()

  const chain = chains.find((c) => c.id === chainId)
  const usdc = chainId ? usdcByChain[chainId] : undefined
  const native = useBalance({ address })
  const usdcBal = useReadContract({
    abi: erc20Abi,
    address: usdc,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!usdc && !!address },
  })

  const nativeFmt = native.data ? Number(formatUnits(native.data.value, native.data.decimals)).toFixed(6) : '—'
  const usdcFmt = usdcBal.data !== undefined ? Number(formatUnits(usdcBal.data as bigint, 6)).toFixed(2) : '—'

  const doConnect = async (connectorOrFactory: Parameters<typeof connectAsync>[0]['connector'], label: string) => {
    try {
      await connectAsync({ connector: connectorOrFactory })
      pushToast(dispatch, `🔌 已连接 ${label}`)
    } catch {
      pushToast(dispatch, '⚠️ 钱包连接失败或被拒绝')
    }
  }

  const copy = () => {
    if (address) navigator.clipboard?.writeText(address)
    pushToast(dispatch, '✅ 地址已复制到剪贴板')
  }

  const explorer = chain?.blockExplorers?.default ? `${chain.blockExplorers.default.url}/address/${address}` : null

  return (
    <div className="wm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wm-panel">
        <div className="wm-head">
          <span className="wm-title">{isConnected ? '钱包管理' : '连接多链钱包'}</span>
          <button className="wm-close" onClick={onClose}>✕</button>
        </div>

        {!isConnected ? (
          <div className="wm-body">
            <div className="wm-hint">通过浏览器钱包扩展授权连接 · 私钥永不离开你的设备</div>

            {connectors.map((c) => (
              <button key={c.uid} className="wm-wallet-row" disabled={isPending} onClick={() => doConnect(c, c.name)}>
                {c.icon ? <img src={c.icon} alt="" className="wm-icon" /> : <span className="wm-icon-dot" />}
                <span className="wm-wallet-name">{c.name}</span>
                <span className="wm-wallet-tag">检测到</span>
              </button>
            ))}

            <button className="wm-wallet-row" disabled={isPending} onClick={() => doConnect(injected(), '浏览器钱包')}>
              <span className="wm-icon-dot cyan" />
              <span className="wm-wallet-name">浏览器钱包 (Injected)</span>
              <span className="wm-wallet-tag gray">EIP-1193</span>
            </button>

            {connectors.length === 0 && (
              <div className="wm-install">
                未检测到钱包扩展 · 推荐
                <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">安装 MetaMask</a>
                或
                <a href="https://www.okx.com/web3" target="_blank" rel="noreferrer">OKX Wallet</a>
              </div>
            )}
          </div>
        ) : (
          <div className="wm-body">
            <div className="wm-addr-row">
              <div className="wm-addr">{address?.slice(0, 10)}…{address?.slice(-8)}</div>
              <span className="chip chip-green">
                <span className="pulse-dot2 live" style={{ color: 'var(--down)', background: 'var(--down)', width: 5, height: 5 }} />
                已连接 · {chain?.name ?? '未知链'}
              </span>
            </div>

            <div className="wm-sec-title">切换网络</div>
            <div className="wm-chains">
              {chains.map((c) => (
                <button key={c.id} className={`wm-chain ${c.id === chainId ? 'on' : ''}`} onClick={() => switchChain({ chainId: c.id })}>
                  <span className="wm-chain-dot" style={{ background: chainColor[c.id] }} />
                  {c.name}
                </button>
              ))}
            </div>

            <div className="wm-sec-title">链上余额（实时 RPC）</div>
            <div className="wm-bal-row">
              <span className="wm-bal-label">{native.data?.symbol ?? chain?.nativeCurrency.symbol}</span>
              <span className="wm-bal-val">{native.isPending ? '查询中…' : nativeFmt}</span>
            </div>
            {usdc && (
              <div className="wm-bal-row">
                <span className="wm-bal-label">USDC</span>
                <span className="wm-bal-val">{usdcBal.isPending ? '查询中…' : usdcFmt}</span>
              </div>
            )}

            <div className="wm-actions">
              <button className="btn btn-sm" onClick={copy}>复制地址</button>
              {explorer && <a className="btn btn-sm" href={explorer} target="_blank" rel="noreferrer">区块浏览器</a>}
              <button className="btn btn-sm btn-sell" onClick={async () => { await disconnectAsync(); pushToast(dispatch, '🔓 钱包已断开连接') }}>断开</button>
            </div>
          </div>
        )}

        <style>{`
          .wm-overlay {
            position: fixed; inset: 0; z-index: 9998;
            background: rgba(2,4,10,0.72); backdrop-filter: blur(4px);
            display: flex; align-items: center; justify-content: center;
          }
          .wm-panel {
            width: 420px; max-height: 640px;
            background: var(--bg-elevated); border: 1px solid var(--border-strong);
            border-radius: 14px; padding: 18px;
            box-shadow: 0 24px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(34,211,238,0.08);
            display: flex; flex-direction: column; gap: 14px;
          }
          .wm-head { display: flex; align-items: center; justify-content: space-between; }
          .wm-title { font-family: var(--font-ui); font-size: 16px; font-weight: 800; color: var(--text-main); }
          .wm-close {
            width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--border);
            background: transparent; color: var(--text-sub); cursor: pointer; font-size: 12px;
          }
          .wm-close:hover { border-color: var(--primary-40); color: var(--primary); }
          .wm-body { display: flex; flex-direction: column; gap: 9px; }
          .wm-hint { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); line-height: 1.6; }
          .wm-wallet-row {
            display: flex; align-items: center; gap: 12px;
            height: 52px; padding: 0 14px;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; cursor: pointer; transition: all 0.15s;
          }
          .wm-wallet-row:hover { border-color: var(--primary-40); transform: translateY(-1px); }
          .wm-wallet-row:disabled { opacity: 0.5; cursor: wait; }
          .wm-icon { width: 26px; height: 26px; border-radius: 50%; }
          .wm-icon-dot {
            width: 22px; height: 22px; border-radius: 50%;
            background: linear-gradient(135deg, #F6851B, #E2761B); flex-shrink: 0;
          }
          .wm-icon-dot.cyan { background: linear-gradient(135deg, var(--primary), var(--accent)); }
          .wm-wallet-name { flex: 1; text-align: left; font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--text-main); }
          .wm-wallet-tag { font-family: var(--font-mono); font-size: 9px; color: var(--down); }
          .wm-wallet-tag.gray { color: var(--text-weak); }
          .wm-install { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.8; }
          .wm-install a { color: var(--primary); margin: 0 4px; }
          .wm-addr-row {
            display: flex; align-items: center; justify-content: space-between; gap: 10px;
            background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
            padding: 12px 14px;
          }
          .wm-addr { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-main); }
          .wm-sec-title { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); margin-top: 4px; }
          .wm-chains { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
          .wm-chain {
            display: flex; align-items: center; gap: 7px; justify-content: center;
            height: 32px; border-radius: 8px;
            background: var(--bg-card); border: 1px solid var(--border);
            color: var(--text-sub); font-family: var(--font-ui); font-size: 11px; font-weight: 600;
            cursor: pointer; transition: all 0.15s;
          }
          .wm-chain:hover { border-color: var(--border-strong); color: var(--text-main); }
          .wm-chain.on { border-color: var(--primary-40); color: var(--primary); background: var(--primary-10); }
          .wm-chain-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
          .wm-bal-row {
            display: flex; align-items: center; justify-content: space-between;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 8px; padding: 9px 14px;
          }
          .wm-bal-label { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }
          .wm-bal-val { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-main); }
          .wm-actions { display: flex; gap: 8px; margin-top: 4px; }
          .wm-actions .btn, .wm-actions a.btn { flex: 1; }
        `}</style>
      </div>
    </div>
  )
}
