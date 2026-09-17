import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getReservationSummary,
  getReservations,
  getRiskBrief,
  reserveRisk,
  releaseRisk,
  recoverReservations,
  type ReservationSummaryView,
  type ReservationView,
  type RiskBriefView,
} from '../orch/client.ts'

/**
 * 组合风险预算台账（Reservation Ledger）
 *
 * 这个页面回答的问题是：**「在当前这一笔之前，系统已经承诺出去多少钱？」**
 *
 * 在引入预留层之前，这个问题的答案只存在于「已成交订单 + 未成交挂单」里——
 * 而两者都不是完整答案：一笔已经发出去但结果未知的订单，既不占持仓也不在挂单里，
 * 却实实在在地消耗着组合层的风险容量。多个交易所同时下单时，各所只看自己的账，
 * 合起来就越界了。
 *
 * 因此本页刻意把「账本语义」写在界面上（见底部折叠区），而不是只给一张表——
 * 表上的数字只有在读者理解它的口径时才是可信的。
 */

/** 六态词表的中文名。键必须与服务端 riskReservation.ts 的 STATE_* 常量逐字对应。 */
const STATE_LABEL: Record<string, string> = {
  pending: '待确认',
  partial: '部分成交',
  unknown: '结果未知',
  confirmed: '已确认',
  rejected: '已拒绝',
  closed: '已关闭',
  pending_cleanup: '孤儿·待对账',
}

/**
 * 状态配色。刻意让「占用态」用冷色/警示色、「终态」用弱灰色，
 * 而不是用红绿——红绿在本项目里专属于涨跌，混用会让读者误判盈亏方向。
 */
const STATE_TONE: Record<string, { color: string; border: string; bg: string }> = {
  pending: { color: 'var(--warning)', border: 'rgba(255,176,32,0.4)', bg: 'rgba(255,176,32,0.08)' },
  partial: { color: 'var(--primary)', border: 'rgba(34,211,238,0.4)', bg: 'rgba(34,211,238,0.07)' },
  unknown: { color: 'var(--up)', border: 'rgba(255,77,109,0.45)', bg: 'rgba(255,77,109,0.08)' },
  confirmed: { color: 'var(--primary)', border: 'rgba(34,211,238,0.28)', bg: 'rgba(34,211,238,0.04)' },
  pending_cleanup: { color: 'var(--accent)', border: 'rgba(232,121,249,0.45)', bg: 'rgba(232,121,249,0.08)' },
  rejected: { color: 'var(--text-weak)', border: 'var(--border)', bg: 'transparent' },
  closed: { color: 'var(--text-weak)', border: 'var(--border)', bg: 'transparent' },
}

/** 可手工构造的状态（演练用）。孤儿是系统自动标记的，不在此列。 */
const MANUAL_STATES = ['pending', 'unknown', 'confirmed'] as const

const CSS = `
  .rl-root { display: flex; flex-direction: column; gap: 10px; }
  .rl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .rl-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
  .rl-hint { font-family: var(--font-ui); font-size: 10px; font-weight: 400; color: var(--text-weak); }
  .rl-head-ops { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .rl-btn {
    font-family: var(--font-ui); font-size: 11px; font-weight: 600;
    color: var(--text-sub); background: var(--bg-surface);
    border: 1px solid var(--border-strong); border-radius: 7px;
    padding: 5px 11px; cursor: pointer; white-space: nowrap; transition: all .14s;
  }
  .rl-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--text-weak); }
  .rl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .rl-btn.tiny { padding: 3px 8px; font-size: 10px; border-radius: 6px; }
  .rl-btn.danger { color: var(--up); border-color: rgba(255,77,109,0.45); }

  .rl-select, .rl-input {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-main);
    background: var(--bg-base); border: 1px solid var(--border-strong);
    border-radius: 6px; padding: 5px 8px;
  }
  .rl-input { width: 180px; }
  .rl-input.narrow { width: 90px; text-align: right; }

  .rl-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .rl-card {
    display: flex; flex-direction: column; gap: 4px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  }
  .rl-card-label { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-weak); }
  .rl-card-value { font-family: var(--font-mono); font-size: 20px; font-weight: 700; color: var(--text-main); display: flex; align-items: baseline; gap: 4px; }
  .rl-card-unit { font-size: 10px; font-weight: 500; color: var(--text-weak); }
  .rl-card-note { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; color: var(--text-weak); }

  .rl-usage { display: flex; align-items: center; gap: 8px; }
  .rl-usage-bar { flex: 1; height: 5px; border-radius: 999px; background: var(--bg-surface); overflow: hidden; }
  .rl-usage-fill { height: 100%; border-radius: 999px; transition: width .3s; }
  .rl-usage-pct { font-family: var(--font-mono); font-size: 10px; color: var(--text-sub); width: 44px; text-align: right; }

  .rl-venues { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rl-venues-label { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-weak); }
  .rl-venue {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: 999px; padding: 2px 9px;
  }
  .rl-venue-name { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-sub); }
  .rl-venue-amt { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--warning); }

  .rl-msg { font-family: var(--font-ui); font-size: 11px; line-height: 1.6; border-radius: 7px; padding: 6px 10px; }
  .rl-msg.ok { color: var(--down); background: rgba(0,214,143,0.07); border-left: 3px solid var(--down); }
  .rl-msg.bad { color: var(--up); background: rgba(255,77,109,0.07); border-left: 3px solid var(--up); }

  .rl-section-label {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    font-family: var(--font-ui); font-size: 11.5px; font-weight: 700; color: var(--text-main);
    border-top: 1px solid var(--border); padding-top: 9px; margin-top: 2px;
  }
  .rl-section-label.clickable { cursor: pointer; user-select: none; }
  .rl-section-label.clickable:hover { color: var(--primary); }
  .rl-caret { font-size: 10px; color: var(--text-weak); }

  .rl-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 9px; }
  .rl-table { width: 100%; border-collapse: collapse; font-family: var(--font-ui); font-size: 11px; }
  .rl-table th {
    text-align: left; font-weight: 600; color: var(--text-weak); font-size: 10px;
    background: var(--bg-surface); padding: 6px 10px; white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  .rl-table td { padding: 6px 10px; color: var(--text-sub); border-bottom: 1px solid var(--border); }
  .rl-table tr:last-child td { border-bottom: none; }
  .rl-table tr.released td { opacity: 0.5; }
  .rl-table .num { text-align: right; }
  .rl-table .mono { font-family: var(--font-mono); }
  .rl-table .weak { color: var(--text-weak); font-size: 10px; }
  .rl-table .ops { text-align: right; }
  .rl-state {
    display: inline-block; font-family: var(--font-mono); font-size: 10px; font-weight: 700;
    border: 1px solid; border-radius: 999px; padding: 1px 7px; white-space: nowrap;
  }

  .rl-empty { font-family: var(--font-ui); font-size: 11.5px; line-height: 1.7; color: var(--text-weak); background: var(--bg-surface); border: 1px dashed var(--border-strong); border-radius: 9px; padding: 12px; }

  .rl-ops { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .rl-form { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }

  .rl-brief { display: flex; flex-direction: column; gap: 7px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; }
  .rl-brief-meta { display: flex; gap: 14px; flex-wrap: wrap; font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); }
  .rl-brief-text {
    margin: 0; font-family: var(--font-mono); font-size: 11px; line-height: 1.85;
    color: var(--text-main); white-space: pre-wrap; word-break: break-word;
    background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 10px;
  }

  .rl-semantics { display: flex; flex-direction: column; gap: 8px; }
  .rl-sem { display: flex; flex-direction: column; gap: 3px; background: var(--bg-card); border-left: 3px solid var(--primary); border-radius: 0 8px 8px 0; padding: 8px 11px; }
  .rl-sem b { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-main); }
  .rl-sem span { font-family: var(--font-ui); font-size: 11px; line-height: 1.7; color: var(--text-sub); }
`

function fmtUsdt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function ReservationLedger({ base, token, online }: { base: string; token: string; online: boolean }) {
  const [env, setEnv] = useState('paper')
  const [summary, setSummary] = useState<ReservationSummaryView | null>(null)
  const [all, setAll] = useState<ReservationView[]>([])
  const [brief, setBrief] = useState<RiskBriefView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [showBrief, setShowBrief] = useState(true)
  const [showSemantics, setShowSemantics] = useState(false)

  // 手工预留表单（演练/对账用，不作为常规开仓路径）
  const [form, setForm] = useState({ intentId: '', amount: '1000', state: 'pending' as (typeof MANUAL_STATES)[number] })

  const refresh = useCallback(async () => {
    if (!online) return
    try {
      const [s, l, b] = await Promise.all([
        getReservationSummary(base, env),
        getReservations(base),
        getRiskBrief(base),
      ])
      setSummary(s)
      setAll(l.reservations ?? [])
      setBrief(b)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [base, env, online])

  useEffect(() => {
    void refresh()
    if (!online) return
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh, online])

  const act = useCallback(
    async (key: string, label: string, fn: () => Promise<string>) => {
      setBusy(key)
      setMsg(null)
      try {
        const m = await fn()
        setMsg(`✓ ${label}：${m}`)
        await refresh()
      } catch (e) {
        setMsg(`✕ ${label}失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  const occupying = useMemo(() => all.filter((r) => r.occupying), [all])
  const orphans = useMemo(() => all.filter((r) => r.isOrphan), [all])
  const byVenueRows = useMemo(() => Object.entries(summary?.byVenue ?? {}), [summary])

  const limit = summary?.totalLimitUsdt ?? null
  const used = summary?.grossExposure ?? 0
  const usedPct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : null

  if (!online) {
    return (
      <>
        <style>{CSS}</style>
        <div className="rl-empty">
          编排服务未连接，无法读取预留台账。
          <span className="rl-hint"> 台账由编排器持有——这是刻意的：账本必须与下单动作在同一个进程里，否则「读总额→判断→写入」中间会出现竞态窗口。</span>
        </div>
      </>
    )
  }

  return (
    <div className="rl-root">
      {/* ── 预算占用概览 ── */}
      <div className="rl-head">
        <div className="rl-title">
          组合风险预算占用
          <span className="rl-hint">
            这里的「已占用」包含**已成交但尚未平仓**的仓位——成交不等于释放，平仓才释放。
          </span>
        </div>
        <div className="rl-head-ops">
          <select className="rl-select" value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="paper">纸交易</option>
            <option value="live">实盘</option>
          </select>
          <button className="rl-btn" onClick={() => void refresh()} disabled={busy !== null}>
            刷新
          </button>
        </div>
      </div>

      <div className="rl-cards">
        <div className="rl-card">
          <div className="rl-card-label">已占用预算</div>
          <div className="rl-card-value" style={{ color: used > 0 ? 'var(--warning)' : 'var(--text-main)' }}>
            {fmtUsdt(used)}
            <span className="rl-card-unit">USDT</span>
          </div>
          <div className="rl-card-note">占用中的预留合计（跨所合看）</div>
        </div>
        <div className="rl-card">
          <div className="rl-card-label">组合预算上限</div>
          <div className="rl-card-value">
            {limit === null ? '不限' : fmtUsdt(limit)}
            {limit !== null && <span className="rl-card-unit">USDT</span>}
          </div>
          <div className="rl-card-note">
            {limit === null ? '未设上限，交由单笔/单标的闸门约束' : '超出此额的预留会被原子拒绝并整体回滚'}
          </div>
        </div>
        <div className="rl-card">
          <div className="rl-card-label">占用中的意图</div>
          <div className="rl-card-value">
            {occupying.length}
            <span className="rl-card-unit">笔</span>
          </div>
          <div className="rl-card-note">
            {orphans.length > 0 ? `其中 ${orphans.length} 笔为孤儿，等待对账裁决` : '无孤儿预留'}
          </div>
        </div>
      </div>

      {/* 使用率条：只在设了上限时才有意义，不设上限就显示形态而非假装有刻度 */}
      {usedPct !== null && (
        <div className="rl-usage">
          <div className="rl-usage-bar">
            <div
              className="rl-usage-fill"
              style={{
                width: `${usedPct}%`,
                background: usedPct > 80 ? 'var(--up)' : usedPct > 50 ? 'var(--warning)' : 'var(--primary)',
              }}
            />
          </div>
          <span className="rl-usage-pct">{usedPct.toFixed(1)}%</span>
        </div>
      )}

      {/* ── 跨所分布（本能力的存在理由：任何单所视图都看不到这张表）── */}
      <div className="rl-venues">
        <span className="rl-venues-label">跨所分布</span>
        {byVenueRows.length === 0 && <span className="rl-hint">当前无占用</span>}
        {byVenueRows.map(([venue, amt]) => (
          <span key={venue} className="rl-venue">
            <span className="rl-venue-name">{venue || '（未标注）'}</span>
            <span className="rl-venue-amt">{fmtUsdt(amt)}</span>
          </span>
        ))}
      </div>

      {msg && <div className={`rl-msg ${msg.startsWith('✓') ? 'ok' : 'bad'}`}>{msg}</div>}
      {err && <div className="rl-msg bad">读取失败：{err}</div>}

      {/* ── 预留明细 ── */}
      <div className="rl-section-label">
        预留明细
        <span className="rl-hint">
          幂等键是「账户 × 意图 ID」，重复提交同一意图不会重复占用。
        </span>
      </div>

      {all.length === 0 ? (
        <div className="rl-empty">暂无预留记录。</div>
      ) : (
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>意图 ID</th>
                <th>场所</th>
                <th>状态</th>
                <th className="num">金额 (USDT)</th>
                <th className="num">占用</th>
                <th>更新时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {all.map((r) => {
                const tone = STATE_TONE[r.isOrphan ? 'pending_cleanup' : r.state] ?? STATE_TONE.closed
                return (
                  <tr key={`${r.accountKey}:${r.intentId}`} className={r.occupying ? '' : 'released'}>
                    <td className="mono">{r.intentId}</td>
                    <td>{r.venue || '—'}</td>
                    <td>
                      <span className="rl-state" style={{ color: tone.color, borderColor: tone.border, background: tone.bg }}>
                        {r.isOrphan ? STATE_LABEL.pending_cleanup : (STATE_LABEL[r.state] ?? r.state)}
                      </span>
                    </td>
                    <td className="num mono">{fmtUsdt(r.amountUsdt)}</td>
                    <td className="num">
                      {r.occupying ? <span style={{ color: 'var(--warning)' }}>是</span> : <span className="rl-hint">已释放</span>}
                    </td>
                    <td className="mono weak">{fmtTime(r.updatedAt)}</td>
                    <td className="ops">
                      {r.occupying && (
                        <button
                          className="rl-btn tiny"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(`rel:${r.intentId}`, `释放 ${r.intentId}`, async () => {
                              const out = await releaseRisk(base, token, { accountKey: r.accountKey, intentId: r.intentId })
                              if (out.error) throw new Error(out.error)
                              return `状态 → ${out.snapshot?.state ?? 'closed'}`
                            })
                          }
                        >
                          {busy === `rel:${r.intentId}` ? '释放中…' : '释放'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 对账与演练操作 ── */}
      <div className="rl-section-label">
        对账与演练
        <span className="rl-hint">
          孤儿恢复只做**标记**，不自动释放——释放与否是人的判断，不是程序可以推断的。
        </span>
      </div>

      <div className="rl-ops">
        <button
          className="rl-btn"
          disabled={busy !== null}
          onClick={() =>
            void act('recover', '孤儿恢复', async () => {
              const rep = await recoverReservations(base, token, { environment: env, openIntentIds: [] })
              return `标记 ${rep.orphans.length} 笔孤儿，仍在占用 ${rep.activeCount} 笔 / ${fmtUsdt(rep.activeTotal)} USDT`
            })
          }
        >
          {busy === 'recover' ? '扫描中…' : '扫描孤儿预留'}
        </button>

        <div className="rl-form">
          <input
            className="rl-input"
            placeholder="意图 ID（如 drill-1）"
            value={form.intentId}
            onChange={(e) => setForm({ ...form, intentId: e.target.value })}
            spellCheck={false}
          />
          <input
            className="rl-input narrow"
            placeholder="金额"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            spellCheck={false}
          />
          <select
            className="rl-select"
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value as (typeof MANUAL_STATES)[number] })}
          >
            {MANUAL_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            className="rl-btn"
            disabled={busy !== null || !form.intentId.trim() || !Number.isFinite(Number(form.amount))}
            onClick={() =>
              void act('reserve', `预留 ${form.intentId}`, async () => {
                const out = await reserveRisk(base, token, {
                  accountKey: { venue: 'manual', environment: env },
                  intentId: form.intentId.trim(),
                  amountUsdt: Number(form.amount),
                  state: form.state,
                })
                if (out.error) throw new Error(out.error)
                setForm((f) => ({ ...f, intentId: '' }))
                return `占用 ${fmtUsdt(out.snapshot?.amountUsdt ?? 0)} USDT${out.changed === false ? '（幂等命中，未重复占用）' : ''}`
              })
            }
          >
            {busy === 'reserve' ? '提交中…' : '手工预留'}
          </button>
        </div>
      </div>

      {/* ── 模型实际读到的风险预算原文 ── */}
      <div className="rl-section-label clickable" onClick={() => setShowBrief((v) => !v)}>
        <span className="rl-caret">{showBrief ? '▾' : '▸'}</span>
        本周期风险预算 · 模型实际读到的原文
        <span className="rl-hint">
          与插值进提示词的文本同源。面板上的数字只要与它不同步，就会出现「页面说 2.5、模型按 2.0 提案」这类看不见的分裂。
        </span>
      </div>

      {showBrief && brief && (
        <div className="rl-brief">
          <div className="rl-brief-meta">
            <span>标题：{brief.heading}</span>
            <span>标的池容量：{brief.values.effectiveMaxPositions} 笔</span>
            <span>
              单笔风险：{(brief.values.riskPerTradeRatio * 100).toFixed(2)}% · 盈亏比下限：
              {brief.values.minRiskRewardRatio.toFixed(2)}
            </span>
          </div>
          <pre className="rl-brief-text">{brief.text}</pre>
        </div>
      )}

      {/* ── 账本语义（把「为什么」写在界面上）── */}
      <div className="rl-section-label clickable" onClick={() => setShowSemantics((v) => !v)}>
        <span className="rl-caret">{showSemantics ? '▾' : '▸'}</span>
        为什么「结果未知」也要占用全额预算？
      </div>

      {showSemantics && (
        <div className="rl-semantics">
          <div className="rl-sem">
            <b>① 已成交 ≠ 已释放。</b>
            <span>
              `confirmed` 仍占用预算。释放的触发条件是**平仓**，不是**成交**。把成交当成释放，会让系统在持仓期间继续按满额容量开新仓。
            </span>
          </div>
          <div className="rl-sem">
            <b>② 未知按全额占用，绝不释放。</b>
            <span>
              一笔订单发出去后网络断了、回执没回来——这时最危险的假设是「大概没成交吧」。账本宁可高估敞口（保守方向），也不接受乐观假设（可能是真实亏损）。
            </span>
          </div>
          <div className="rl-sem">
            <b>③ 终态幂等，不可复活。</b>
            <span>
              `rejected` / `closed` 是终态。重复提交同一意图不会把它改回占用态——否则一次重试就能悄悄突破预算。
            </span>
          </div>
          <div className="rl-sem">
            <b>④ 孤儿只标记，不自动释放。</b>
            <span>
              「本地没有对应的开放意图」不等于「这笔交易在场所里不存在」。本地丢了 ≠ 场所没有。程序不做这个推断，只把它标出来交给对账。
            </span>
          </div>
        </div>
      )}

      <style>{CSS}</style>
    </div>
  )
}
