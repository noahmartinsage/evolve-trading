import React, { useState } from 'react'
import { useStore, pushToast, MODE_META, TradeMode } from '../store/Store'

const ORDER: TradeMode[] = ['sim', 'paper', 'live']

export default function ModeBadge() {
  const { state, dispatch } = useStore()
  const [pending, setPending] = useState<TradeMode | null>(null)
  const [ack, setAck] = useState(false)

  const request = (m: TradeMode) => {
    if (m === state.mode) return
    if (m === 'live') {
      setAck(false)
      setPending('live')
      return
    }
    dispatch({ type: 'SET_MODE', mode: m })
  }

  const confirmLive = () => {
    if (!ack) return
    dispatch({ type: 'SET_MODE', mode: 'live' })
    pushToast(dispatch, '⚠️ 已进入实盘模式 · 链上签名已解锁，请核实交易对与合约地址')
    setPending(null)
  }

  const meta = MODE_META[state.mode]

  return (
    <>
      <div className="mode-badge" data-mode={state.mode}>
        <span className="mb-dot" />
        <span className="mb-label">{meta.label}</span>
        <div className="mb-seg">
          {ORDER.map((m) => (
            <button key={m} className={state.mode === m ? 'on' : ''} onClick={() => request(m)} title={MODE_META[m].desc}>
              {MODE_META[m].label}
            </button>
          ))}
        </div>
      </div>

      {pending === 'live' && (
        <div className="modal-mask" onClick={() => setPending(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="mh-icon">⚠️</span>
              <span className="mh-title">切换到实盘 · 链上交易模式</span>
            </div>
            <ul className="modal-list">
              <li>此模式下，DEX 面板将对<b>真实钱包</b>发起<b>主网签名交易</b>，消耗真实 GAS 并承担真实资金风险</li>
              <li>模拟 / 纸交易 的虚拟资金、虚拟持仓与 实盘 完全无关</li>
              <li>本系统当前无下单前风控、无 Kill Switch（阶段 C 接入），链上操作不可撤销</li>
              <li>请在执行前自行核实：网络、USDC/Router 合约地址、滑点与价格影响</li>
            </ul>
            <label className="modal-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>我理解上述风险，确认使用自有资金进行真实链上交易</span>
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPending(null)}>取消</button>
              <button className="btn btn-lg btn-live" disabled={!ack} onClick={confirmLive}>确认进入实盘模式</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .mode-badge {
          display: flex; align-items: center; gap: 8px;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 8px; padding: 4px 8px;
        }
        .mode-badge[data-mode='live'] { border-color: rgba(255,77,109,0.5); }
        .mb-dot { width: 7px; height: 7px; border-radius: 50%; background: ${meta.color}; box-shadow: 0 0 6px ${meta.color}; animation: mbPulse 1.6s ease-in-out infinite; }
        @keyframes mbPulse { 50% { opacity: 0.35; } }
        .mb-label { font-family: var(--font-ui); font-size: 12px; font-weight: 800; color: ${meta.color}; letter-spacing: 0.5px; }
        .mb-seg { display: flex; gap: 2px; background: var(--bg-surface); border-radius: 6px; padding: 2px; }
        .mb-seg button {
          font-family: var(--font-ui); font-size: 11px; font-weight: 700; letter-spacing: 0;
          color: var(--text-weak); background: transparent; border: none;
          border-radius: 4px; padding: 3px 8px; cursor: pointer; transition: all 0.15s;
        }
        .mb-seg button:hover { color: var(--text-main); }
        .mb-seg button.on { background: var(--bg-elevated); color: var(--primary); box-shadow: inset 0 0 0 1px var(--border-strong); }
        .modal-mask {
          position: fixed; inset: 0; z-index: 200;
          background: rgba(0,0,0,0.65); backdrop-filter: blur(3px);
          display: flex; align-items: center; justify-content: center;
        }
        .modal-card {
          width: 480px; max-width: calc(100vw - 40px);
          background: var(--bg-elevated); border: 1px solid rgba(255,77,109,0.45);
          border-radius: 14px; padding: 20px 22px;
          display: flex; flex-direction: column; gap: 14px;
          box-shadow: 0 24px 64px rgba(0,0,0,0.55);
        }
        .modal-head { display: flex; align-items: center; gap: 10px; }
        .mh-icon { font-size: 20px; }
        .mh-title { font-family: var(--font-ui); font-size: 16px; font-weight: 800; color: var(--up); }
        .modal-list {
          margin: 0; padding-left: 18px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .modal-list li { font-family: var(--font-ui); font-size: 12px; line-height: 1.65; color: var(--text-sub); }
        .modal-list b { color: var(--up); }
        .modal-ack {
          display: flex; align-items: center; gap: 9px; cursor: pointer;
          padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 8px;
        }
        .modal-ack input { accent-color: var(--up); width: 15px; height: 15px; cursor: pointer; }
        .modal-ack span { font-family: var(--font-ui); font-size: 12px; color: var(--text-main); }
        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
        .btn-live {
          background: linear-gradient(135deg, rgba(255,77,109,0.35), rgba(255,77,109,0.15));
          color: var(--up); font-weight: 800;
        }
        .btn-live:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-live:hover:not(:disabled) { background: linear-gradient(135deg, rgba(255,77,109,0.5), rgba(255,77,109,0.25)); }
      `}</style>
    </>
  )
}
