import React, { useEffect, useMemo, useState } from 'react'
import { useStore, pushToast } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { VenueStatusPanel } from '../components/VenueStatusPanel'
import { useOrch, useOrchEvents, setKillswitch, submitOrderIntent, cancelOrchOrder, listPromotions, promotionAction, getMetrics, getSlo, getMirrorStatus, getSurveillance, getAutopilotStatus, autopilotStart, autopilotStop } from '../orch/client.ts'
import type { OrchEvent, PromotionRecordView, MetricsView, SloView, MirrorStatusView, SurveillanceView, AutopilotStatusView } from '../orch/client.ts'
import { explainDecision } from '../orch/explain.ts'

/**
 * 定时器 hook。
 *
 * 旧实现把 `ref.current = cb` 写在 render 期，这是 React 明确禁止的写法：
 * 并发渲染下 render 可能被丢弃重放，读到的回调与提交的那一帧不一致，
 * 表现为「轮询间隔偶发跳拍」。改成在 effect 中同步最新回调。
 */
function useInterval(cb: () => void, ms: number) {
  const ref = React.useRef(cb)
  React.useEffect(() => {
    ref.current = cb
  }, [cb])
  React.useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

const KIND_COLOR: Record<string, string> = {
  ORDER_SUBMIT: 'var(--primary)',
  ORDER_ACK: 'var(--primary)',
  ORDER_FILL: 'var(--down)',
  ORDER_REJECT: 'var(--up)',
  ORDER_CANCEL: 'var(--text-weak)',
  KILLSWITCH_ON: 'var(--up)',
  KILLSWITCH_OFF: 'var(--text-weak)',
  RISK_CIRCUIT_BREAK: 'var(--warning)',
  AUTOPILOT_STRATEGY_SELECTED: 'var(--accent)',
  AUTOPILOT_ORDER_PLACED: 'var(--primary)',
  AUTOPILOT_ORDER_REJECTED: 'var(--up)',
  PROMOTION_STAGE: 'var(--text-sub)',
}

/** 资金性质（与 Store 的 TradeMode 对齐，统一中文显示） */
const MODE_LABEL: Record<string, string> = { sim: '模拟', paper: '纸交易', live: '实盘' }

/**
 * 决策视角事件：从编排器全量审计流中筛出"策略做了什么决定、结果如何"。
 * 全量流里还有 SLO_BREACH / RECONCILIATION_MISMATCH 等运维事件，不属于决策范畴，故排除。
 */
const DECISION_KINDS: string[] = [
  'AUTOPILOT_STRATEGY_SELECTED',
  'AUTOPILOT_ORDER_PLACED',
  'AUTOPILOT_ORDER_REJECTED',
  'ORDER_SUBMIT',
  'ORDER_ACK',
  'ORDER_FILL',
  'ORDER_REJECT',
  'PROMOTION_STAGE',
]

const DECISION_LABEL: Record<string, string> = {
  AUTOPILOT_STRATEGY_SELECTED: '策略选定',
  AUTOPILOT_ORDER_PLACED: '下单执行',
  AUTOPILOT_ORDER_REJECTED: '下单被拒',
  ORDER_SUBMIT: '提交订单',
  ORDER_ACK: '场所确认',
  ORDER_FILL: '成交',
  ORDER_REJECT: '订单拒绝',
  PROMOTION_STAGE: '晋升流转',
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const STAGE_COLOR: Record<string, string> = {
  candidate: 'var(--text-sub)',
  rejected: 'var(--up)',
  paper_observing: 'var(--primary)',
  ready_for_small_cap: 'var(--warning)',
  small_cap_live: 'var(--accent)',
  full_live: 'var(--down)',
  rolled_back: 'var(--text-weak)',
}

const STAGE_LABEL: Record<string, string> = {
  candidate: '候选',
  rejected: '已拒绝',
  paper_observing: '纸交易观察中',
  ready_for_small_cap: '待审批',
  small_cap_live: '小资金实盘',
  full_live: '全量',
  rolled_back: '已回滚',
}

function PromotionsPanel({ base, token, online, dispatch }: { base: string; token: string; online: boolean; dispatch: ReturnType<typeof useStore>['dispatch'] }) {  const [records, setRecords] = useState<PromotionRecordView[]>([])
  const [newId, setNewId] = useState('')
  const [gateFit, setGateFit] = useState('60')
  const [approver, setApprover] = useState('human')
  const [ddInput, setDdInput] = useState('3')

  useEffect(() => {
    if (!online) {
      setRecords([])
      return
    }
    let alive = true
    const load = () => {
      void listPromotions(base, token).then((r) => {
        if (alive) setRecords(r.records)
      }).catch(() => undefined)
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [base, token, online])

  const act = async (id: string, action: string, body?: Record<string, unknown>) => {
    try {
      const r = await promotionAction(base, token, id, action, body)
      pushToast(dispatch, r.ok ? `✅ ${id.slice(-8)} → ${STAGE_LABEL[r.stage ?? ''] ?? r.stage}` : `❌ ${r.error}`)
    } catch (e) {
      pushToast(dispatch, `❌ ${e instanceof Error ? e.message : e}`)
    }
    void listPromotions(base, token).then((r) => setRecords(r.records)).catch(() => undefined)
  }

  return (
    <div className="panel-card">
      <div className="pc-head"><span className="panel-title">策略晋升流水线（promotion-v1）</span></div>
      <div className="promo-new">
        <input className="input promo-id" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="策略 ID" disabled={!online} />
        <button className="btn btn-sm btn-primary" disabled={!online || !newId.trim()} onClick={() => { void act(newId.trim(), 'submit'); setNewId('') }}>提交候选</button>
      </div>

      {records.length === 0 && <div className="empty-row">暂无策略记录</div>}
      {records.map((r) => (
        <div key={r.id} className="promo-item">
          <div className="pi-head">
            <span className="mono pi-id">{r.id}</span>
            <span className="chip chip-cyan" style={{ color: STAGE_COLOR[r.stage], borderColor: STAGE_COLOR[r.stage] }}>{STAGE_LABEL[r.stage] ?? r.stage}</span>
          </div>
          <div className="pi-meta">
            {r.fitness ? `fitness=${r.fitness.value}` : '未评估'} · 纸交易 {r.paperStats?.trades ?? 0} 笔 · 回撤 {r.paperStats?.maxDrawdownPct ?? 0}%{r.approvedBy ? ` · 审批:${r.approvedBy}` : ''}{r.capUsd ? ` · 帽 $${r.capUsd}` : ''}
          </div>
          {/* 过拟合判定单独一行显示，不再挤在 meta 里。
              它原先根本不可见 —— 因为那时它只是一个调用方自报的布尔量，
              没有任何东西可展示。现在它是算出来的，就必须看得见。 */}
          {r.overfit && (
            <div className="pi-meta" title={r.overfit.summary}>
              过拟合 {r.overfit.outcome === 'PASS' ? '✅ 通过' : r.overfit.outcome === 'REJECT' ? '❌ 拒绝' : '⚠️ 无从判断'}
              {' · PBO '}
              {r.overfit.pbo === null ? 'n/a' : `${(r.overfit.pbo * 100).toFixed(1)}%`}
              {' · 赢家分位 '}
              {r.overfit.avgWinnerW === null ? 'n/a' : r.overfit.avgWinnerW.toFixed(3)}
              {` · ${r.overfit.folds} 折 / ${r.overfit.candidates} 候选 · 数据 ${r.overfit.dataHash.slice(0, 8)}`}
            </div>
          )}
          <div className="pi-actions">
            {r.stage === 'candidate' && (
              <>
                <input className="input tk-num" value={gateFit} onChange={(e) => setGateFit(e.target.value)} title="fitness 值" />
                {/* ⚠️ 这里从前传 `{ fitnessValue, wfRobust: true, purityHomogeneous: false }`
                    —— 把两项判定硬编码成"能过"。那是 F-34 的真因：唯一的过拟合门
                    在产品路径上永不触发。现在只提交 fitness，过拟合凭据与同质化判定
                    都由服务端从证据数据现算。（首次点击约 20 秒，之后走缓存。） */}
                <button className="btn btn-sm" disabled={!online} onClick={() => act(r.id, 'gate', { fitnessValue: parseFloat(gateFit) })}>跑 backtest 门</button>
              </>
            )}
            {r.stage === 'paper_observing' && (
              <>
                <button className="btn btn-sm" disabled={!online} onClick={() => act(r.id, 'paper-trade')}>+1 笔纸交易</button>
                <input className="input tk-num" value={ddInput} onChange={(e) => setDdInput(e.target.value)} title="观察期最大回撤%" />
                <button className="btn btn-sm" disabled={!online} onClick={() => act(r.id, 'close-paper', { drawdownPct: parseFloat(ddInput) })}>关闭观察期</button>
              </>
            )}
            {r.stage === 'ready_for_small_cap' && (
              <>
                <input className="input tk-num" value={approver} onChange={(e) => setApprover(e.target.value)} title="审批人" />
                <button className="btn btn-sm btn-primary" disabled={!online} onClick={() => act(r.id, 'approve', { approver })}>批准小资金</button>
              </>
            )}
            {r.stage === 'small_cap_live' && (
              <>
                <button className="btn btn-sm" disabled={!online} onClick={() => act(r.id, 'promote-full')}>晋升全量</button>
                <button className="btn btn-sm btn-sell" disabled={!online} onClick={() => act(r.id, 'rollback', { reason: 'UI 人工回滚' })}>回滚</button>
              </>
            )}
            {r.stage === 'full_live' && (
              <button className="btn btn-sm btn-sell" disabled={!online} onClick={() => act(r.id, 'rollback', { reason: 'UI 人工回滚' })}>回滚</button>
            )}
            {r.stage === 'rolled_back' && (
              <button className="btn btn-sm" disabled={!online} onClick={() => act(r.id, 'restore')}>恢复</button>
            )}
          </div>
        </div>
      ))}

      <style>{`
        .promo-new { display: flex; gap: 8px; align-items: center; }
        .promo-id { flex: 1; min-width: 0; }
        .promo-item { display: flex; flex-direction: column; gap: 5px; border-top: 1px dashed var(--border); padding-top: 7px; }
        .pi-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .pi-id { font-size: 11px; font-weight: 700; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chip { font-family: var(--font-mono); font-size: 9px; padding: 1px 7px; border-radius: 8px; border: 1px solid var(--border); background: rgba(151,160,181,0.08); white-space: nowrap; }
        .pi-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); line-height: 1.5; }
        .pi-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .tk-num { width: 90px; }
        .btn-sell { color: var(--up); }
      `}</style>
    </div>
  )
}

function AutopilotLivePanel({ ap, target, setTarget, busy, setBusy, base, token, dispatch }: {
  ap: AutopilotStatusView | null
  target: string
  setTarget: (v: string) => void
  busy: boolean
  setBusy: (v: boolean) => void
  base: string
  token: string
  dispatch: ReturnType<typeof useStore>['dispatch']
}) {
  const pnl = ap?.pnlPct
  const pnlColor = pnl == null ? 'var(--text-weak)' : pnl >= 0 ? 'var(--down)' : 'var(--up)'
  const stageColor: Record<string, string> = {
    idle: 'var(--text-weak)',
    accumulating: 'var(--primary)',
    optimizing: 'var(--warning)',
    trading: 'var(--accent)',
    target_reached: 'var(--down)',
    drawdown_stopped: 'var(--up)',
  }
  const onStart = async () => {
    setBusy(true)
    try {
      const r = await autopilotStart(base, token, parseFloat(target) || 2)
      if (!r.ok) pushToast(dispatch, `❌ 启动失败：${r.reason ?? ''}`)
      else pushToast(dispatch, `✅ Autopilot 测试网实测已启动（目标 +${target}%）`)
    } finally {
      setBusy(false)
    }
  }
  const onStop = async () => {
    setBusy(true)
    try {
      await autopilotStop(base, token)
      pushToast(dispatch, '⏹ Autopilot 已停止')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel-card">
      <div className="pc-title">
        <span>🤖 Autopilot 测试网实测（OKX Testnet）</span>
        <span className={`badge ${ap?.running ? 'on' : 'off'}`}>
          {ap?.running ? `运行中 · ${MODE_LABEL[ap.mode] ?? ap.mode}资金` : '空闲'}
        </span>
      </div>
      <div className="ap-metrics">
        <div><label>阶段</label><b style={{ color: stageColor[ap?.stage ?? 'idle'] }}>{ap?.stage ?? '—'}</b></div>
        <div><label>权益</label><b>${ap?.equity != null ? ap.equity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</b></div>
        <div><label>PnL</label><b style={{ color: pnlColor }}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}</b></div>
        <div><label>周期</label><b>{ap?.cycles ?? '—'}</b></div>
        <div><label>K线</label><b>{ap?.barsAccumulated ?? '—'}</b></div>
        <div><label>目标</label><b>+{ap?.targetPct ?? '—'}%</b></div>
      </div>
      {ap?.winner && <div className="ap-winner">当前策略：<code>{ap.winner}</code></div>}
      {/* F-47：样本内选择被过拟合门否决时必须显式说明「为什么还没开始交易」。
          此时的 stage 与「正在正常累积」完全相同，不写出来就会被读成「系统卡住了」。 */}
      {ap?.gateRefusal && (
        <div className="ap-note" style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>
          ⛔ 样本内选择未过过拟合门（{ap.gateRefusal.outcome}）：{ap.gateRefusal.summary}
          <br />
          判据依据：{ap.gateRefusal.bars} 根 K 线 · 折数 {ap.gateRefusal.folds}
          {ap.gateRefusal.pbo !== null ? ` · PBO ${(ap.gateRefusal.pbo * 100).toFixed(1)}%` : ''} · 证据仍不足，
          继续累积至 {ap.gateRefusal.retryAtBars} 根后重判
        </div>
      )}
      {/* 明确区分"网络环境"与"资金性质"：测试网 ≠ 实盘，虚拟资金 ≠ 真实盈亏 */}
      <div className="ap-note">
        网络环境 <b>OKX 测试网</b> · 资金性质 <b>{MODE_LABEL[ap?.mode ?? 'paper'] ?? (ap?.mode ?? '纸交易')}</b>
        （虚拟资金，此处盈亏不代表真实收益）
      </div>
      <div className="ap-controls">
        <input className="input" style={{ width: 70 }} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="目标%" />
        <button className="btn btn-sm" disabled={busy || ap?.running} onClick={onStart}>▶ 启动</button>
        <button className="btn btn-sm" disabled={busy || !ap?.running} onClick={onStop}>⏹ 停止</button>
      </div>
    </div>
  )
}

/** Autopilot 阶段 → 中文决策动作 */
const DECISION_STAGE: Record<string, string> = {
  idle: '空闲等待',
  accumulating: '积累 K 线',
  optimizing: '策略寻优',
  trading: '执行交易',
  target_reached: '已达标',
  drawdown_stopped: '回撤停止',
}

/** 盈亏走势微型图：把轮询采样点连成折线，直观看到决策的累积效果 */
function PnlSpark({ data, target }: { data: { ts: number; pnl: number }[]; target: number }) {
  if (data.length < 2) {
    return <div className="sp-empty">走势采集中…（每 2 秒一个采样点）</div>
  }
  const W = 300
  const H = 56
  const vals = data.map((d) => d.pnl)
  const min = Math.min(...vals, 0)
  const max = Math.max(...vals, target)
  const span = max - min || 1
  const px = (i: number) => (i / (data.length - 1)) * W
  const py = (v: number) => H - ((v - min) / span) * H
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(d.pnl).toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  const last = data[data.length - 1]
  const rising = last.pnl >= data[0].pnl
  const stroke = last.pnl >= 0 ? 'var(--down)' : 'var(--up)'
  return (
    <svg className="sp-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H}>
      <line x1="0" y1={py(target)} x2={W} y2={py(target)} stroke="var(--warning)" strokeWidth="1" strokeDasharray="3 3" />
      <line x1="0" y1={py(0)} x2={W} y2={py(0)} stroke="var(--border)" strokeWidth="1" />
      <path d={area} fill={rising ? 'rgba(0,214,143,0.14)' : 'rgba(255,77,109,0.14)'} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={W} cy={py(last.pnl)} r="2.6" fill={stroke} />
    </svg>
  )
}

/**
 * 决策实时动态面板
 * 把编排器的策略行为以「当前决策 + 盈亏走势 + 决策流」三视图实时同步展示。
 * 与下方「审计事件流」的区别：那里是全量运维事件，这里只保留"策略做了什么决定、结果如何"。
 */
function DecisionRealtimePanel({
  ap, events, online, lastSync, history,
}: {
  ap: AutopilotStatusView | null
  events: OrchEvent[]
  online: boolean
  lastSync: number | null
  history: { ts: number; pnl: number }[]
}) {
  const decisions = useMemo(
    () =>
      events
        .filter((e) => DECISION_KINDS.includes(e.kind))
        .slice(0, 12)
        .map((e) => ({
          key: e.seq,
          time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }),
          action: DECISION_LABEL[e.kind] ?? e.kind,
          color: KIND_COLOR[e.kind] ?? 'var(--text-sub)',
          // 复用统一的人话解释，避免与决策大脑两处文案不一致
          detail: explainDecision(e.kind, e.payload),
        })),
    [events],
  )

  const stats = useMemo(() => {
    const c = { placed: 0, filled: 0, rejected: 0 }
    for (const e of events) {
      if (e.kind === 'ORDER_FILL') c.filled += 1
      else if (e.kind === 'AUTOPILOT_ORDER_REJECTED' || e.kind === 'ORDER_REJECT') c.rejected += 1
      else if (e.kind === 'ORDER_SUBMIT' || e.kind === 'AUTOPILOT_ORDER_PLACED') c.placed += 1
    }
    return c
  }, [events])

  const pnl = ap?.pnlPct
  const pnlColor = pnl == null ? 'var(--text-weak)' : pnl >= 0 ? 'var(--down)' : 'var(--up)'
  const progress = ap?.targetPct ? Math.round(((pnl ?? 0) / ap.targetPct) * 100) : null
  const ago = lastSync == null ? null : Math.round((Date.now() - lastSync) / 1000)

  return (
    <div className="panel-card dr-card">
      <div className="pc-head">
        <span className="panel-title">决策实时动态 · 测试网实测</span>
        <span className={`dr-sync ${online ? 'on' : 'off'}`}>
          <i className="dr-dot" />
          {online ? `实时同步 · ${ago == null ? '连接中' : ago <= 2 ? '刚刚' : `${ago}s 前`}` : '未连接'}
        </span>
      </div>

      <div className="dr-snap">
        <div className="dr-snap-main">
          <label>当前决策</label>
          <b style={{ color: 'var(--accent)' }}>{ap?.running ? (DECISION_STAGE[ap.stage] ?? ap.stage) : '空闲'}</b>
        </div>
        <div>
          <label>盈亏</label>
          <b style={{ color: pnlColor }}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}</b>
        </div>
        <div>
          <label>决策周期</label>
          <b>{ap?.cycles ?? '—'}</b>
        </div>
        <div>
          <label>目标进度</label>
          <b>{progress == null ? '—' : `${progress}%`}</b>
        </div>
      </div>

      <div className="dr-spark-wrap">
        <div className="dr-spark-head">
          <span>盈亏走势</span>
          <span className="dr-spark-meta">采样 {history.length} 点 · 目标 +{ap?.targetPct ?? '—'}%</span>
        </div>
        <PnlSpark data={history} target={ap?.targetPct ?? 2} />
      </div>

      <div className="dr-stats">
        <span>提交 <b>{stats.placed}</b></span>
        <span>成交 <b style={{ color: 'var(--down)' }}>{stats.filled}</b></span>
        <span>拒绝 <b style={{ color: 'var(--up)' }}>{stats.rejected}</b></span>
        {ap?.winner && <span className="dr-winner">策略 <code>{ap.winner}</code></span>}
      </div>

      <div className="dr-title">决策流（最新在上）</div>
      <div className="dr-list">
        {decisions.length === 0 && <div className="empty-row">暂无决策事件</div>}
        {decisions.map((d) => (
          <div key={d.key} className="dr-line">
            <span className="dr-time mono">{d.time}</span>
            <span className="dr-act" style={{ color: d.color }}>{d.action}</span>
            <span className="dr-detail">{d.detail || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MonitorPage() {
  const { state, dispatch } = useStore()
  const orch = useOrch(state.orchUrl, state.orchToken)
  const events = useOrchEvents(state.orchUrl, state.orchToken, orch.status === 'online')
  const s = orch.full

  const [urlDraft, setUrlDraft] = useState(state.orchUrl)
  const [tokenDraft, setTokenDraft] = useState(state.orchToken)
  const [busy, setBusy] = useState(false)

  const [ap, setAp] = useState<AutopilotStatusView | null>(null)
  const [apTarget, setApTarget] = useState('2')
  const [apBusy, setApBusy] = useState(false)
  // 盈亏采样序列（仅本次页面会话，刷新即重采）+ 末次同步时刻，供决策面板画走势与心跳
  const [pnlHist, setPnlHist] = useState<{ ts: number; pnl: number }[]>([])
  const [lastSync, setLastSync] = useState<number | null>(null)
  useInterval(() => {
    if (orch.status === 'online') {
      getAutopilotStatus(state.orchUrl, state.orchToken)
        .then((v) => {
          setAp(v)
          setLastSync(Date.now())
          if (v?.pnlPct != null) {
            setPnlHist((prev) => [...prev, { ts: Date.now(), pnl: v.pnlPct as number }].slice(-80))
          }
        })
        .catch(() => {})
    }
  }, 2000)

  const symbols = useMemo(() => Object.keys(s?.lastPrice ?? {}).sort(), [s])
  const [tSymbol, setTSymbol] = useState('')
  const [tSide, setTSide] = useState<'buy' | 'sell'>('buy')
  const [tType, setTType] = useState<'limit' | 'market'>('limit')
  const [tPrice, setTPrice] = useState('')
  const [tQty, setTQty] = useState('')

  useEffect(() => {
    if (!tSymbol && symbols.length > 0) setTSymbol(symbols[0])
  }, [symbols, tSymbol])

  const lastPx = s?.lastPrice[tSymbol] ?? 0
  useEffect(() => {
    if (lastPx > 0 && tType === 'limit') setTPrice((lastPx * 1.0005).toFixed(2))
  }, [tSymbol, tType, lastPx])

  const estNotional = (parseFloat(tPrice) || lastPx) * (parseFloat(tQty) || 0)
  const notionalCap = s?.risk.maxNotionalPerOrder ?? Number.POSITIVE_INFINITY

  const submitTicket = async () => {
    const qtyNum = parseFloat(tQty)
    if (!tSymbol || !qtyNum || qtyNum <= 0) {
      pushToast(dispatch, '❌ 请填写有效数量')
      return
    }
    if (tType === 'limit' && !(parseFloat(tPrice) > 0)) {
      pushToast(dispatch, '❌ 限价单需要有效价格')
      return
    }
    setBusy(true)
    try {
      const r = await submitOrderIntent(state.orchUrl, state.orchToken, {
        clientOrderId: `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        symbol: tSymbol,
        side: tSide,
        type: tType,
        ...(tType === 'limit' ? { price: parseFloat(tPrice) } : {}),
        qty: qtyNum,
      })
      pushToast(dispatch, r.ok ? `✅ 服务端 ACK · ${r.orderId} · ${r.status}` : `❌ 风控拒绝: ${r.reason}`)
      orch.refresh()
    } catch (e) {
      pushToast(dispatch, `❌ 提交失败: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const cancelRow = async (clientOrderId: string) => {
    try {
      const r = await cancelOrchOrder(state.orchUrl, state.orchToken, clientOrderId)
      pushToast(dispatch, r.ok ? `🗑 已撤销 ${clientOrderId.slice(-8)}` : `撤单失败（可能已成交）`)
      orch.refresh()
    } catch (e) {
      pushToast(dispatch, `❌ 撤单失败: ${e instanceof Error ? e.message : e}`)
    }
  }

  const drawdownPct = s && s.peakEquity > 0 ? ((s.peakEquity - s.equity) / s.peakEquity) * 100 : 0
  const openOrders = s ? s.orders.filter((o) => o.status === 'new' || o.status === 'ack' || o.status === 'partial').length : 0

  const applyConfig = () => {
    if (!urlDraft.trim()) return
    dispatch({ type: 'SET_ORCH_CONFIG', orchUrl: urlDraft.trim(), orchToken: tokenDraft })
  }

  const toggleKillswitch = async (active: boolean) => {
    const msg = active
      ? '激活 Kill Switch？\n将立即撤销 orchestration 全部挂单，并拒绝一切新订单。'
      : '解除 Kill Switch？\norchestration 将恢复接单能力。'
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      const r = await setKillswitch(state.orchUrl, state.orchToken, active)
      pushToast(dispatch, active ? `🛑 Kill Switch 已激活 · 撤销 ${r.cancelledOrders ?? 0} 笔挂单` : '▶️ Kill Switch 已解除 · 恢复接单')
      orch.refresh()
    } catch (e) {
      pushToast(dispatch, `❌ 操作失败: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  // C-7/C-12 可观测性轮询：/metrics /slo /mirror/status（真实测量，非演示）
  const [mview, setMview] = useState<MetricsView | null>(null)
  const [slo, setSlo] = useState<SloView | null>(null)
  const [mirror, setMirror] = useState<MirrorStatusView | null>(null)
  const [surf, setSurf] = useState<SurveillanceView | null>(null)
  useEffect(() => {
    if (orch.status !== 'online') {
      setMview(null)
      setSlo(null)
      setMirror(null)
      setSurf(null)
      return
    }
    let alive = true
    const load = () => {
      void getMetrics(state.orchUrl, state.orchToken).then((v) => { if (alive) setMview(v) }).catch(() => undefined)
      void getSlo(state.orchUrl, state.orchToken).then((v) => { if (alive) setSlo(v) }).catch(() => undefined)
      void getMirrorStatus(state.orchUrl, state.orchToken).then((v) => { if (alive) setMirror(v) }).catch(() => undefined)
      void getSurveillance(state.orchUrl, state.orchToken).then((v) => { if (alive) setSurf(v) }).catch(() => undefined)
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [state.orchUrl, state.orchToken, orch.status])

  const kpis: KpiItem[] = s
    ? [
        { label: '账户权益', value: fmtMoney(s.equity), valueColor: 'var(--text-main)', meta: '服务端实时标记', metaColor: 'var(--text-sub)' },
        { label: '可用余额', value: fmtMoney(s.balanceUSDC), valueColor: 'var(--text-sub)', meta: 'orchestration 账本', metaColor: 'var(--text-sub)' },
        { label: '当前回撤', value: `${drawdownPct.toFixed(2)}%`, valueColor: drawdownPct > s.risk.maxDrawdownPct * 0.6 ? 'var(--warning)' : 'var(--text-main)', meta: `熔断线 ${s.risk.maxDrawdownPct}%`, metaColor: 'var(--warning)' },
        { label: '有效挂单', value: String(openOrders), valueColor: 'var(--accent)', meta: `服务端真实订单`, metaColor: 'var(--text-sub)' },
        { label: 'Kill Switch', value: s.killswitch ? '已触发' : '待命', valueColor: s.killswitch ? 'var(--up)' : 'var(--primary)', meta: s.killswitch ? '拒绝新单 · 已撤全单' : '风控正常放行中', metaColor: s.killswitch ? 'var(--up)' : 'var(--text-sub)' },
      ]
    : [
        { label: '连接状态', value: '离线', valueColor: 'var(--warning)', meta: orch.lastError ?? '等待 orchestration 服务', metaColor: 'var(--warning)' },
      ]

  const eventRows = useMemo(
    () =>
      events.map((e: OrchEvent) => ({
        key: e.seq,
        time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }),
        kind: e.kind,
        color: KIND_COLOR[e.kind] ?? 'var(--text-sub)',
        detail: Object.entries(e.payload)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`)
          .join(' · '),
      })),
    [events],
  )

  return (
    <div className="content-area">
      <div className="demo-banner">
        <span className="db-tag">REAL 数据</span>
        <span className="db-text">
          本页直连 <b>orchestration 服务</b>（下单前风控 · killswitch · 追加写账本）。未启动服务时显示离线指引；交易终端的模拟账本与本页相互独立。
        </span>
        <style>{`
          .db-tag { font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 1px; color: var(--primary); border: 1px solid rgba(34,211,238,0.45); border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
          .db-text { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.5; }
          .db-text b { color: var(--primary); }
        `}</style>
      </div>

      <KpiRow items={kpis} height={96} />

      <div className="conn-bar">
        <span className={`chip ${orch.status === 'online' ? 'chip-green' : orch.status === 'connecting' ? 'chip-cyan' : 'chip-amber'}`}>
          {orch.status === 'online' ? '● 已连接' : orch.status === 'connecting' ? '○ 连接中' : '● 离线'}
        </span>
        <input className="input conn-input" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="http://localhost:8790" spellCheck={false} />
        <input className="input conn-input token" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="ORCH_TOKEN" type="password" spellCheck={false} />
        <button className="btn btn-sm" onClick={applyConfig}>应用连接</button>
      </div>

      <VenueStatusPanel base={state.orchUrl} token={state.orchToken} />

      {!s ? (
        <div className="offline-panel">
          <div className="op-big">📡 Orchestration 服务未连接</div>
          <div className="op-desc">在仓库根目录另开一个终端启动（二选一）：</div>
          <pre className="op-cmd">npm run stack   # 推荐：ledger + orch + web 三进程，orch 监听 :8790</pre>
          <pre className="op-cmd">npm run orch    # 仅编排进程，默认监听 :8787</pre>
          <div className="op-desc">
            注意：两者端口不同——<code>npm run stack</code> 监听 <code>http://localhost:8790</code>（本页默认连这个），
            <code>npm run orch</code> 监听 <code>http://localhost:8787</code>（需在上方输入框改地址，否则会 Failed to fetch）。
            令牌默认 <code>dev-insecure-token</code>（可用环境变量 ORCH_TOKEN/ORCH_SYMBOLS/PORT 覆盖）。
            上方输入框可指向任意实例。
          </div>
          {orch.lastError && <div className="op-err">最近错误：{orch.lastError}</div>}
        </div>
      ) : (
        <div className="main-area monitor-real">
          <div className="mon-left">
            <AutopilotLivePanel
              ap={ap}
              target={apTarget}
              setTarget={setApTarget}
              busy={apBusy}
              setBusy={setApBusy}
              base={state.orchUrl}
              token={state.orchToken}
              dispatch={dispatch}
            />

            <DecisionRealtimePanel
              ap={ap}
              events={events}
              online={orch.status === 'online'}
              lastSync={lastSync}
              history={pnlHist}
            />

            <PromotionsPanel base={state.orchUrl} token={state.orchToken} online={orch.status === 'online'} dispatch={dispatch} />

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">持仓（服务端账本）</span></div>
              <table className="tbl">
                <thead><tr><th>交易对</th><th className="num">数量</th><th className="num">均价</th><th className="num">现价</th><th className="num">市值</th></tr></thead>
                <tbody>
                  {s.positions.length === 0 && <tr><td colSpan={5} className="empty-row">暂无持仓</td></tr>}
                  {s.positions.map((p) => {
                    const px = s.lastPrice[p.symbol] ?? p.avgPrice
                    return (
                      <tr key={p.symbol}>
                        <td className="strong">{p.symbol}</td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{p.avgPrice != null ? p.avgPrice.toFixed(2) : '—'}</td>
                        <td className="num">{(px ?? 0).toFixed(2)}</td>
                        <td className="num">{fmtMoney(p.qty * px)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">最近订单</span></div>
              <table className="tbl">
                <thead><tr><th>ID</th><th>交易对</th><th>方向</th><th>类型</th><th className="num">价格</th><th className="num">已成交/总量</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  {s.orders.length === 0 && <tr><td colSpan={8} className="empty-row">暂无订单</td></tr>}
                  {s.orders.slice(0, 8).map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.clientOrderId.slice(-8)}</td>
                      <td className="strong">{o.symbol}</td>
                      <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side === 'buy' ? '买入' : '卖出'}</td>
                      <td>{o.type === 'market' ? '市价' : '限价'}</td>
                      <td className="num">{o.price?.toFixed(2) ?? '—'}</td>
                      <td className="num">{o.filledQty}/{o.qty}</td>
                      <td><span className="chip chip-gray">{o.status}</span></td>
                      <td>
                        {(o.status === 'new' || o.status === 'ack' || o.status === 'partial') && (
                          <button className="btn btn-sm" onClick={() => cancelRow(o.clientOrderId)}>撤单</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="right-col mon-right">
            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">远程纸面下单（走服务端风控）</span></div>
              <div className="ticket-row">
                <select className="input tk-sym" value={tSymbol} onChange={(e) => setTSymbol(e.target.value)}>
                  {symbols.map((sym) => (
                    <option key={sym} value={sym}>{sym}</option>
                  ))}
                </select>
                <div className="seg tk-seg">
                  <button className={tSide === 'buy' ? 'on-buy' : ''} onClick={() => setTSide('buy')}>买入</button>
                  <button className={tSide === 'sell' ? 'on-sell' : ''} onClick={() => setTSide('sell')}>卖出</button>
                </div>
              </div>
              <div className="ticket-row">
                <div className="seg tk-seg wide2">
                  <button className={tType === 'limit' ? 'on' : ''} onClick={() => setTType('limit')}>限价</button>
                  <button className={tType === 'market' ? 'on' : ''} onClick={() => setTType('market')}>市价</button>
                </div>
                {tType === 'limit' && (
                  <input className="input tk-num" value={tPrice} onChange={(e) => setTPrice(e.target.value)} placeholder="价格" />
                )}
              </div>
              <div className="ticket-row">
                <input className="input tk-num" value={tQty} onChange={(e) => setTQty(e.target.value)} placeholder="数量" />
                <span className="tk-hint mono">≈{estNotional > 0 ? fmtMoney(estNotional) : '—'} / 上限 {fmtMoney(notionalCap)}</span>
              </div>
              <button
                className={`btn btn-lg full ${tSide === 'buy' ? 'btn-buy' : 'btn-sell'}`}
                disabled={busy || orch.status !== 'online'}
                onClick={submitTicket}
              >
                {orch.status !== 'online' ? '服务离线' : busy ? '提交中…' : `${tSide === 'buy' ? '买入' : '卖出'} ${tSymbol || ''} · 提交风控`}
              </button>
            </div>

            <div className={`ks-card ${s.killswitch ? 'on' : ''}`}>
              <div className="ks-title">{s.killswitch ? '🛑 Kill Switch 已触发' : '⚡ Kill Switch 待命'}</div>
              <div className="ks-desc">{s.killswitch ? '全部挂单已撤销 · 新订单一律拒绝' : '一键撤销全部挂单并冻结下单通道（可逆）'}</div>
              <button
                className={`btn btn-lg full ${s.killswitch ? '' : 'btn-sell'}`}
                disabled={busy}
                onClick={() => toggleKillswitch(!s.killswitch)}
              >
                {busy ? '执行中…' : s.killswitch ? '▶️ 解除 Kill Switch（恢复接单）' : '🛑 激活 Kill Switch（撤全单+断单）'}
              </button>
            </div>

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">风控参数（服务端强制）</span></div>
              <div className="risk-row"><span>单笔名义本金上限</span><span className="mono">{fmtMoney(s.risk.maxNotionalPerOrder)}</span></div>
              <div className="risk-row"><span>下单频率上限</span><span className="mono">{s.risk.maxOrdersPerMinute}/分钟</span></div>
              <div className="risk-row"><span>回撤熔断线</span><span className="mono">{s.risk.maxDrawdownPct}%</span></div>
              <div className="risk-row"><span>价格偏离保护</span><span className="mono">{s.risk.priceDeviationBps}bps</span></div>
              <div className="risk-note">全部为同步前置检查 · 失败即拒绝（fail-closed）</div>
            </div>

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">SLO 目标（真实测量）</span></div>
              {slo?.targets.map((t) => {
                const v = slo.values[t.key]
                const breach = slo.breaches.some((b) => b.key === t.key)
                return (
                  <div key={t.key} className="risk-row">
                    <span>{t.label}</span>
                    <span className="mono" style={{ color: breach ? 'var(--up)' : 'var(--down)' }}>
                      {Number.isFinite(v) ? v : '—'} / {t.compare === 'lte' ? '≤' : '≥'}{t.limit}{t.unit}
                      {breach ? ' ⚠' : ''}
                    </span>
                  </div>
                )
              })}
              <div className="risk-note">违约自动写入审计事件并触发告警通道（冷却去重）</div>
            </div>

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">执行性能与行情心跳</span></div>
              <div className="risk-row"><span>ACK 延迟 P50/P95/P99</span><span className="mono">{mview ? `${mview.orders.ackLatencyMs.p50}/${mview.orders.ackLatencyMs.p95}/${mview.orders.ackLatencyMs.p99} ms` : '—'}</span></div>
              <div className="risk-row"><span>订单 ACK/拒绝</span><span className="mono">{mview ? `${mview.orders.acked} / ${mview.orders.rejected}` : '—'}</span></div>
              <div className="risk-row"><span>成交（纸交易/实盘）</span><span className="mono">{mview ? `${mview.fills.paper} / ${mview.fills.live}` : '—'}</span></div>
              <div className="risk-row"><span>撤单 / KS 激活次数</span><span className="mono">{mview ? `${mview.cancels} / ${mview.killswitchActivations}` : '—'}</span></div>
              {mview && mview.orders.rejectTopReasons.length > 0 && (
                <div className="risk-row"><span>拒绝 Top 原因</span><span className="mono" style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mview.orders.rejectTopReasons[0].reason} ×{mview.orders.rejectTopReasons[0].count}</span></div>
              )}
              <div className="risk-row"><span>行情心跳（最旧 bar）</span><span className="mono">{mview ? Math.max(...mview.feed.map((f) => f.lastBarAgeSec ?? 0), 0) + 's' : '—'}</span></div>
              {mview && mview.feed.map((f) => (
                <div key={f.symbol} className="risk-row" style={{ paddingLeft: 10 }}>
                  <span style={{ color: 'var(--text-weak)' }}>{f.symbol}</span>
                  <span className="mono" style={{ color: (f.lastBarAgeSec ?? 0) > 60 ? 'var(--warning)' : 'var(--text-sub)' }}>{f.lastBarAgeSec !== null ? f.lastBarAgeSec + 's 前' : '无数据'}</span>
                </div>
              ))}
            </div>

            <div className={`panel-card ${mirror && !mirror.enabled ? '' : ''}`}>
              <div className="pc-head"><span className="panel-title">镜像互查（C-12）</span></div>
              {!mirror || !mirror.enabled ? (
                <div className="risk-note">未启用 · 设置 ORCH_LEDGER_URL 后，事件将携带来源 seq+hash 镜像至独立账本进程，并每 60s 双向校验自愈</div>
              ) : (
                <>
                  <div className="risk-row"><span>远端</span><span className="mono" style={{ fontSize: 9 }}>{mirror.url}</span></div>
                  <div className="risk-row"><span>本地 seq / 远端已收</span><span className="mono">{mirror.lastLocalSeq} / {mirror.remoteMaxSrcSeq ?? mirror.missing === 0 ? '同步' : '补投中'}</span></div>
                  <div className="risk-row"><span>累计补投 / 哈希失配</span><span className="mono" style={{ color: mirror.originMismatches > 0 ? 'var(--up)' : 'var(--text-sub)' }}>{mirror.repairedTotal} / {mirror.originMismatches}</span></div>
                  {mirror.lastError && <div className="risk-row"><span style={{ color: 'var(--up)' }}>最近错误</span><span className="mono" style={{ fontSize: 9, wordBreak: 'break-all' }}>{mirror.lastError}</span></div>}
                  <div className="risk-note">来源哈希与本地持久链逐一比对，任何篡改在此暴露</div>
                </>
              )}
            </div>

            <div className="panel-card">
              <div className="pc-head"><span className="panel-title">市场操纵监控（C-8）</span></div>
              {!surf ? (
                <div className="risk-note">等待服务数据…</div>
              ) : (
                <>
                  <div className="risk-row"><span>SELF_TRADE 标记</span><span className="mono" style={{ color: surf.counters.flaggedSelfTrades > 0 ? 'var(--up)' : 'var(--text-sub)' }}>{surf.counters.flaggedSelfTrades}</span></div>
                  <div className="risk-row"><span>ORDER_CHURN 标记</span><span className="mono" style={{ color: surf.counters.flaggedChurn > 0 ? 'var(--warning)' : 'var(--text-sub)' }}>{surf.counters.flaggedChurn}</span></div>
                  <div className="risk-row"><span>小额定频标记</span><span className="mono" style={{ color: surf.counters.flaggedSmallNotionalBursts > 0 ? 'var(--warning)' : 'var(--text-sub)' }}>{surf.counters.flaggedSmallNotionalBursts}</span></div>
                  <div className="risk-row"><span>追踪中的成交窗口</span><span className="mono">{surf.counters.trackedFills}</span></div>
                  <div className="risk-row"><span>小额窗口 笔数 / 合计</span><span className="mono">{surf.counters.trackedOrders} / ${surf.counters.trackedNotionalUsdt}</span></div>
                  <div className="risk-note">规则：对向成交 ≤{surf.config.selfTradePriceBps}bps/{surf.config.selfTradeWindowSec}s · 撤单率 ≥{Math.round(surf.config.churnCancelRatio * 100)}%/{Math.round(surf.config.churnWindowSec / 60)}min（≥{surf.config.churnMinSubmits} 笔）</div>
                  {/* 金额型门禁的盲区：笔数够多、金额够小 ⇒ 每一笔都合法，合计还不如一笔正常单 */}
                  <div className="risk-note">
                    小额定频（笔数/金额解耦）：≥{surf.config.burstMinOrders} 笔且单笔 ≤${surf.config.burstMaxNotionalUsdt}、合计 ≤$
                    {surf.config.burstMaxTotalUsdt} / {Math.round(surf.config.burstWindowSec / 60)}min
                  </div>
                  {surf.recentFlags.length > 0 && (
                    <div className="ev-list" style={{ maxHeight: 110 }}>
                      {surf.recentFlags.slice(-6).reverse().map((f, i) => (
                        <div key={i} className="ev-line">
                          <span className="ev-time mono">{new Date(f.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                          <span className="ev-kind" style={{ color: f.type === 'SELF_TRADE' ? 'var(--up)' : 'var(--warning)' }}>{f.type}</span>
                          <span className="ev-detail">{f.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="panel-card ev-card">
              <div className="pc-head"><span className="panel-title">审计事件流（追加写）</span></div>
              <div className="ev-list">
                {eventRows.length === 0 && <div className="empty-row">暂无事件</div>}
                {eventRows.map((e) => (
                  <div key={e.key} className="ev-line">
                    <span className="ev-time mono">{e.time}</span>
                    <span className="ev-kind" style={{ color: e.color }}>{e.kind}</span>
                    <span className="ev-detail">{e.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .conn-bar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .conn-input { max-width: 260px; }
        .conn-input.token { max-width: 180px; }
        .monitor-real { align-items: stretch; }
        .mon-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
        .panel-card {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 10px 12px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .pc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
        .empty-row { text-align: center; color: var(--text-weak); height: 40px; }
        .mono { font-family: var(--font-mono); }
        .ap-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 14px; }
        .ap-metrics > div { display: flex; flex-direction: column; }
        .ap-metrics label { font-size: 10px; color: var(--text-weak); }
        .ap-metrics b { font-size: 14px; }
        .ap-winner { font-size: 10px; color: var(--text-weak); word-break: break-all; }
        .ap-winner code { color: var(--text-sub); }
        .ap-note {
          font-family: var(--font-ui); font-size: 10px; line-height: 1.6;
          color: var(--text-weak); background: var(--bg-surface);
          border-left: 2px solid var(--warning); padding: 5px 8px; border-radius: 0 6px 6px 0;
        }
        .ap-note b { color: var(--warning); }
        /* 决策实时动态面板 */
        .dr-card { gap: 8px; }
        .dr-sync { display: flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); }
        .dr-sync .dr-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-weak); }
        .dr-sync.on { color: var(--down); }
        .dr-sync.on .dr-dot { background: var(--down); animation: drPulse 1.4s ease-in-out infinite; }
        @keyframes drPulse { 50% { opacity: 0.3; } }
        .dr-snap { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 12px; }
        .dr-snap > div { display: flex; flex-direction: column; min-width: 0; }
        .dr-snap label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .dr-snap b { font-family: var(--font-mono); font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dr-snap-main b { font-family: var(--font-ui); font-size: 13px; }
        .dr-spark-wrap { display: flex; flex-direction: column; gap: 3px; }
        .dr-spark-head { display: flex; align-items: baseline; justify-content: space-between; font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .dr-spark-meta { font-family: var(--font-mono); }
        .sp-svg { display: block; width: 100%; }
        .sp-empty { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); height: 56px; display: flex; align-items: center; }
        .dr-stats { display: flex; align-items: center; gap: 14px; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); border-top: 1px dashed var(--border); padding-top: 6px; flex-wrap: wrap; }
        .dr-stats b { font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
        .dr-winner { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dr-winner code { font-family: var(--font-mono); color: var(--primary); font-size: 10px; }
        .dr-title { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .dr-list { display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto; }
        .dr-line { display: flex; align-items: baseline; gap: 8px; font-size: 10px; }
        .dr-time { color: var(--text-weak); flex-shrink: 0; }
        .dr-act { font-family: var(--font-ui); font-weight: 700; flex-shrink: 0; width: 66px; }
        .dr-detail { font-family: var(--font-ui); color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ap-controls { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
        .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
        .badge.on { color: var(--accent); border-color: var(--accent); }
        .badge.off { color: var(--text-weak); }
        .mon-right { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
        .ticket-row { display: flex; align-items: center; gap: 8px; }
        .tk-sym { flex: 1; min-width: 0; }
        .tk-seg button { padding: 4px 10px; font-size: 11px; }
        .seg.wide2 { display: flex; }
        .seg.wide2 button { flex: 1; white-space: nowrap; }
        .tk-num { width: 110px; }
        .tk-hint { font-size: 9px; color: var(--text-weak); }
        .ks-card {
          background: var(--bg-card); border: 1px solid rgba(255,77,109,0.35);
          border-radius: 10px; padding: 14px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .ks-card.on { background: rgba(255,77,109,0.08); box-shadow: 0 0 24px rgba(255,77,109,0.15); }
        .ks-title { font-family: var(--font-ui); font-size: 14px; font-weight: 800; color: var(--up); }
        .ks-desc { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.5; min-height: 30px; }
        .btn.full { width: 100%; }
        .risk-row { display: flex; align-items: center; justify-content: space-between; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }
        .risk-note { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); border-top: 1px dashed var(--border); padding-top: 6px; }
        .ev-card { flex: 1; min-height: 0; }
        .ev-list { overflow-y: auto; display: flex; flex-direction: column; gap: 5px; min-height: 0; }
        .ev-line { display: flex; align-items: baseline; gap: 8px; font-size: 10px; }
        .ev-time { color: var(--text-weak); flex-shrink: 0; }
        .ev-kind { font-family: var(--font-mono); font-weight: 700; flex-shrink: 0; width: 128px; }
        .ev-detail { font-family: var(--font-ui); color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .offline-panel {
          flex: 1; min-height: 0;
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 12px; padding: 40px;
          display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center; text-align: center;
        }
        .op-big { font-family: var(--font-ui); font-size: 18px; font-weight: 800; color: var(--text-main); }
        .op-desc { font-family: var(--font-ui); font-size: 12px; color: var(--text-sub); max-width: 520px; line-height: 1.7; }
        .op-desc code { font-family: var(--font-mono); color: var(--primary); background: var(--bg-surface); padding: 1px 6px; border-radius: 4px; }
        .op-cmd {
          font-family: var(--font-mono); font-size: 13px; color: var(--primary);
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 10px 22px; margin: 0;
        }
        .op-err { font-family: var(--font-mono); font-size: 10px; color: var(--up); word-break: break-all; max-width: 560px; }
      `}</style>
    </div>
  )
}
