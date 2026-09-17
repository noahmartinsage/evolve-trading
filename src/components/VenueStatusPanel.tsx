import { useEffect, useState } from 'react'
import { getVenueStatuses, syncVenueLedger, type VenueStatusView } from '../orch/client.ts'

const EXCHANGE_LABEL: Record<string, string> = { binance: '币安', okx: 'OKX' }
const MODE_LABEL: Record<string, string> = { testnet: '测试网', live: '实盘' }

const STATUS_META: Record<string, { cls: string; text: string }> = {
  online: { cls: 'chip-green', text: '● 在线' },
  configured_offline: { cls: 'chip-amber', text: '○ 已配置·未激活' },
  not_configured: { cls: 'chip-sub', text: '— 未配置' },
  unsupported: { cls: 'chip-sub', text: '🔒 仅模拟盘' },
  error: { cls: 'chip-red', text: '✕ 连接异常' },
}

export function VenueStatusPanel({ base, token }: { base: string; token: string }) {
  const [venues, setVenues] = useState<VenueStatusView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => {
    getVenueStatuses(base)
      .then((v) => { setVenues(v.venues); setErr(null) })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)) })
  }

  useEffect(() => {
    let alive = true
    const run = () => { if (alive) load() }
    run()
    const t = setInterval(run, 5000)
    return () => { alive = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base])

  const hasMismatch = !!venues?.some((v) => v.attached && (v.venueOutboundDisabledReason || v.status !== 'online'))

  const sync = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await syncVenueLedger(base, token)
      if (r.ok) setMsg(`✅ 账本已同步至交易所余额 ${Number.isFinite(r.venueCash) ? r.venueCash.toFixed(2) + ' USDT' : '—'} · 出站闸已解除`)
      else setMsg(`⚠️ 同步后仍有偏差：${r.reason ?? '未知'}（venueCash=${r.venueCash}）`)
      load()
    } catch (e) {
      setMsg(`❌ 同步失败：${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const note = (v: VenueStatusView): string => {
    if (v.attached && v.venueOutboundDisabledReason) return `🚫 ${v.venueOutboundDisabledReason}`
    if (v.error) return v.error.slice(0, 48)
    if (!v.configured) return '缺环境变量'
    if (!v.supported) return '系统仅支持模拟盘（零真实资金）'
    if (v.attached) return v.killswitch ? '🛑 killswitch 激活' : '正常·已风控握手'
    return '凭据已配置·未挂载'
  }

  return (
    <div className="panel-card">
      <div className="pc-head">
        <span className="panel-title">交易所链接状态</span>
        <span className="pc-sub">测试网 / 实盘 · 只读</span>
      </div>
      <table className="tbl venue-tbl">
        <thead>
          <tr>
            <th>交易所</th>
            <th>模式</th>
            <th>状态</th>
            <th className="num">余额(USDT)</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {!venues && <tr><td colSpan={5} className="empty-row">加载中…</td></tr>}
          {venues?.map((v) => {
            const meta = STATUS_META[v.status]
            return (
              <tr key={`${v.exchange}-${v.mode}`}>
                <td className="strong">{EXCHANGE_LABEL[v.exchange]}{v.attached ? ' ·当前' : ''}</td>
                <td>{MODE_LABEL[v.mode]}</td>
                <td><span className={`chip ${meta.cls}`}>{meta.text}</span></td>
                <td className="num">{v.balanceUsdt != null ? v.balanceUsdt.toFixed(2) : '—'}</td>
                <td className="venue-note">{note(v)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="venue-actions">
        <button className="btn btn-sm" disabled={busy || !hasMismatch} onClick={sync} title="将模拟盘账本现金/持仓对齐为交易所实时余额，并解除对账失配出站闸">
          重新对账并同步账本
        </button>
        {msg && <span className="venue-msg">{msg}</span>}
      </div>
      {err && <div className="op-err">状态获取失败：{err}</div>}
      <style>{`
        .venue-note { font-size: 11px; color: var(--text-sub); font-family: var(--font-mono); line-height: 1.4; }
        .venue-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
        .venue-msg { font-size: 11px; color: var(--text-sub); font-family: var(--font-mono); }
        .chip-sub { color: var(--text-sub); border-color: rgba(148,163,184,.35); }
        .chip-red { color: #f87171; border-color: rgba(248,113,113,.4); }
      `}</style>
    </div>
  )
}
