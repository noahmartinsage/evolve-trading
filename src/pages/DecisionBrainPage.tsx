import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/Store'
import {
  useOrch,
  useOrchEvents,
  getAutopilotStatus,
  listLlmProviders,
  type OrchEvent,
  type LlmProviderView,
  type AutopilotStatusView,
} from '../orch/client.ts'
import { explainDecision } from '../orch/explain.ts'
import { ObservabilityPanel } from '../components/ObservabilityPanel.tsx'

/**
 * 决策大脑（Decision Brain）
 *
 * 参照 nof1.ai / Alpha Arena 的透明化范式：把「系统给了什么输入 → 模型怎么想 → 最终下了什么单」
 * 这条链路完整、实时地摊开给用户看，而不是只给一个盈亏数字。
 *
 * 三栏布局：模型议会（谁在决策）｜ 决策链路流（怎么决策）｜ 持仓与成交（决策结果）
 *
 * ⚠️ 诚实约定：本页只展示编排器真实产生的事件。若 LLM provider 全部 enabled=false，
 * 则决策源为确定性引擎，页面会显式标注，不会伪造思维链文本。
 */

function useInterval(cb: () => void, ms: number) {
  const ref = useRef<(() => void) | null>(null)
  useEffect(() => {
    ref.current = cb
  }, [cb])
  useEffect(() => {
    const t = setInterval(() => ref.current?.(), ms)
    return () => clearInterval(t)
  }, [ms])
}

/** 决策链路的三段（对应 nof1 的 USER_PROMPT / CHAIN_OF_THOUGHT / TRADING_DECISIONS） */
/**
 * 决策链路四段。
 * ⚠️ blocked 段不能省：被风控拦下的委托恰恰是最需要解释的"为什么没成交"，
 *    早期版本只留 action，导致事件几乎全是拒绝时页面显示"暂无决策事件"。
 */
type ThoughtStage = 'prompt' | 'thought' | 'action' | 'blocked'

const STAGE_META: Record<ThoughtStage, { label: string; color: string; icon: string }> = {
  prompt: { label: '输入', color: 'var(--text-weak)', icon: '▸' },
  thought: { label: '推理', color: 'var(--accent)', icon: '◇' },
  action: { label: '决策', color: 'var(--primary)', icon: '◆' },
  blocked: { label: '被拦截', color: 'var(--up)', icon: '✕' },
}

/** 事件 kind → 决策链路阶段（只映射"决策"相关事件，运维告警不进决策流） */
const KIND_STAGE: Record<string, ThoughtStage> = {
  PROPOSAL_RECEIVED: 'prompt',
  STRATEGY_SUBMITTED: 'prompt',
  AUTOPILOT_STARTED: 'prompt',
  AUTOPILOT_STOPPED: 'prompt',
  AUTOPILOT_STRATEGY_SELECTED: 'thought',
  PROMOTION_STAGE: 'thought',
  AUTOPILOT_ORDER_PLACED: 'action',
  ORDER_SUBMIT: 'action',
  ORDER_ACK: 'action',
  ORDER_FILL: 'action',
  KILLSWITCH_OFF: 'action',
  // 拦截类：想做但没做成，必须展示理由
  ORDER_REJECT: 'blocked',
  AUTOPILOT_ORDER_REJECTED: 'blocked',
  RISK_CIRCUIT_BREAK: 'blocked',
}

const KIND_LABEL: Record<string, string> = {
  PROPOSAL_RECEIVED: '收到候选提案',
  STRATEGY_SUBMITTED: '策略入场候选池',
  AUTOPILOT_STARTED: '启动自主交易',
  AUTOPILOT_STOPPED: '停止自主交易',
  AUTOPILOT_STRATEGY_SELECTED: '选定策略',
  PROMOTION_STAGE: '晋升流转',
  AUTOPILOT_ORDER_PLACED: '下达订单',
  AUTOPILOT_ORDER_REJECTED: '订单被风控拒绝',
  ORDER_SUBMIT: '提交订单',
  ORDER_ACK: '场所确认',
  ORDER_FILL: '成交',
  ORDER_REJECT: '订单拒绝',
  KILLSWITCH_OFF: '解除紧急停止',
  RISK_CIRCUIT_BREAK: '风控熔断',
}

const DECISION_KINDS = Object.keys(KIND_STAGE)

/** 执行场所：CEX 与 DEX 双通道 */
type VenueKind = 'cex' | 'dex'

const VENUE_META: Record<VenueKind, { label: string; desc: string }> = {
  cex: { label: '中心化交易所', desc: 'CEX · 订单簿撮合 · 托管资金' },
  dex: { label: '去中心化交易所', desc: 'DEX · 链上 AMM · 自托管' },
}

export default function DecisionBrainPage() {
  const { state } = useStore()
  const orch = useOrch(state.orchUrl, state.orchToken)
  const events = useOrchEvents(state.orchUrl, state.orchToken, orch.status === 'online')
  const online = orch.status === 'online'
  const s = orch.full

  const [ap, setAp] = useState<AutopilotStatusView | null>(null)
  const [providers, setProviders] = useState<LlmProviderView[]>([])
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const streamRef = useRef<HTMLDivElement>(null)

  useInterval(() => {
    if (!online) return
    getAutopilotStatus(state.orchUrl, state.orchToken)
      .then((v) => {
        setAp(v)
        setLastSync(Date.now())
      })
      .catch(() => {})
    listLlmProviders(state.orchUrl)
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => {})
  }, 2000)

  /** 决策链路流：只保留决策类事件，最新在下（聊天式阅读顺序） */
  const stream = useMemo(() => {
    const rows = events
      .filter((e: OrchEvent) => DECISION_KINDS.includes(e.kind))
      .slice(0, 80)
      .reverse()
      .map((e: OrchEvent) => ({
        key: e.seq,
        time: new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }),
        stage: (KIND_STAGE[e.kind] ?? 'action') as ThoughtStage,
        label: KIND_LABEL[e.kind] ?? e.kind,
        // 一句话决策理由（人话），原始 payload 降级为次要信息
        why: explainDecision(e.kind, e.payload),
        detail: Object.entries(e.payload)
          .slice(0, 4)
          .map(([k, v]) => `${k}=${String(v).slice(0, 32)}`)
          .join('  ·  '),
      }))

    // 相邻且「阶段+理由」相同的事件聚合计数。
    // 风控持续拒绝时会产生大量雷同事件（实测 99 条同因），不聚合会把决策流刷爆。
    type Row = (typeof rows)[number] & { count: number; lastTime: string }
    const agg: Row[] = []
    for (const r of rows) {
      const prev = agg[agg.length - 1]
      if (prev && prev.stage === r.stage && prev.why === r.why) {
        prev.count += 1
        prev.lastTime = r.time
      } else {
        agg.push({ ...r, count: 1, lastTime: r.time })
      }
    }
    return agg
  }, [events])

  // 新决策到达时自动滚到底部
  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [stream.length, autoScroll])

  // LLM 是否真的在参与决策（provider 启用且有活跃模型）
  const activeLlm = useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  )
  const llmEnabled = activeLlm.length > 0

  const ago = lastSync == null ? null : Math.round((Date.now() - lastSync) / 1000)
  const pnl = ap?.pnlPct
  const pnlColor = pnl == null ? 'var(--text-weak)' : pnl >= 0 ? 'var(--down)' : 'var(--up)'

  return (
    <div className="content-area">
      <div className="brain-page">
        {/* ── 顶栏：同步状态 + 双通道场所 ───────────────────────── */}
        <div className="bp-top">
          <div className="bp-top-left">
            <span className="bp-title">决策大脑</span>
            <span className="bp-sub">DECISION BRAIN · 决策链路全透明</span>
          </div>
          <span className={`bp-sync ${online ? 'on' : 'off'}`}>
            <i className="bp-dot" />
            {online ? `${ago == null ? '连接中' : ago <= 2 ? '刚刚同步' : `${ago}s 前`}` : '编排器离线'}
          </span>
        </div>

        <div className="bp-venues">
          <VenueCard
            kind="cex"
            name={s ? 'OKX 测试网' : '—'}
            status={online ? (s?.mode ? `已接入 · ${s.mode === 'paper' ? '纸交易资金' : s.mode === 'live' ? '真实资金' : '模拟资金'}` : '已连接') : '离线'}
            online={online}
            note="当前场所经编排器统一风控出向"
          />
          <VenueCard
            kind="dex"
            name="Uniswap V3"
            status="链上询价可用"
            online
            note="交易终端内签名执行 · 支持 5 条链"
          />
          <div className="bp-pnl-card">
            <label>当前盈亏</label>
            <b style={{ color: pnlColor }}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`}</b>
            <span className="bp-pnl-meta">周期 {ap?.cycles ?? '—'} · 目标 +{ap?.targetPct ?? '—'}%</span>
          </div>
        </div>

        {/* ── 三栏主体 ─────────────────────────────────────── */}
        <div className="bp-body">
          {/* 左：谁在决策 */}
          <div className="panel-card bp-col-left">
            <div className="pc-head">
              <span className="panel-title">模型议会</span>
              <span className={`bp-tag ${llmEnabled ? 'on' : 'off'}`}>
                {llmEnabled ? `${activeLlm.length} 个已启用` : '未启用'}
              </span>
            </div>

            {!llmEnabled && (
              <div className="bp-warn">
                当前 <b>无任何 LLM 参与决策</b>。
                决策源为<b>确定性引擎</b>（参数网格搜索），右侧链路展示的是引擎的真实事件，
                <b>不含模型思维链</b>。启用 provider 后此处将自动切换为模型视角。
              </div>
            )}

            <div className="bp-models">
              {providers.length === 0 && <div className="empty-row">未配置 LLM provider</div>}
              {providers.map((p) => (
                <div key={p.id} className={`bp-model ${p.enabled ? 'on' : ''}`}>
                  <span className="bp-model-dot" />
                  <div className="bp-model-info">
                    <span className="bp-model-name">{p.name}</span>
                    <span className="bp-model-meta">
                      {p.activeModel ?? '未选模型'} · {p.models.length} 个可用
                    </span>
                  </div>
                  <span className={`bp-model-state ${p.enabled ? 'on' : ''}`}>
                    {p.enabled ? '参与决策' : '未启用'}
                  </span>
                </div>
              ))}
            </div>

            {ap?.winner && (
              <div className="bp-winner">
                <label>当前执行策略</label>
                <code>{ap.winner}</code>
              </div>
            )}

            {/* 复盘样本质量：自进化最隐蔽的失败不是「学错了」，而是「从空壳样本里学」 */}
            <ObservabilityPanel base={state.orchUrl} online={online} />
          </div>

          {/* 中：怎么决策（核心） */}
          <div className="panel-card bp-col-mid">
            <div className="pc-head">
              <span className="panel-title">决策链路流</span>
              <label className="bp-autoscroll">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                <span>自动滚动</span>
              </label>
            </div>

            <div className="bp-legend">
              {(['prompt', 'thought', 'action', 'blocked'] as ThoughtStage[]).map((st) => (
                <span key={st} className="bp-legend-item">
                  <i style={{ color: STAGE_META[st].color }}>{STAGE_META[st].icon}</i>
                  {STAGE_META[st].label}
                </span>
              ))}
            </div>

            <div className="bp-stream" ref={streamRef}>
              {stream.length === 0 && <div className="empty-row">暂无决策事件</div>}
              {stream.map((d) => {
                const meta = STAGE_META[d.stage]
                return (
                  <div key={d.key} className="bp-step">
                    <div className="bp-step-head">
                      <span className="bp-step-icon" style={{ color: meta.color }}>{meta.icon}</span>
                      <span className="bp-step-label" style={{ color: meta.color }}>{meta.label}</span>
                      <span className="bp-step-name">{d.label}</span>
                      {d.count > 1 && <span className="bp-step-count">×{d.count}</span>}
                      <span className="bp-step-time mono">{d.count > 1 ? `${d.time} → ${d.lastTime}` : d.time}</span>
                    </div>
                    <div className="bp-step-why">{d.why}</div>
                    {d.detail && <div className="bp-step-detail mono">{d.detail}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 右：决策结果 */}
          <div className="panel-card bp-col-right">
            <div className="pc-head"><span className="panel-title">持仓（服务端账本）</span></div>
            <div className="bp-positions">
              {(s?.positions ?? []).length === 0 && <div className="empty-row">暂无持仓</div>}
              {(s?.positions ?? []).map((p) => {
                const last = s?.lastPrice?.[p.symbol]
                const pnlAbs = last != null && p.avgPrice != null ? (last - p.avgPrice) * p.qty : null
                const pnlPct = last != null && p.avgPrice ? ((last - p.avgPrice) / p.avgPrice) * 100 : null
                return (
                  <div key={p.symbol} className="bp-pos">
                    <div className="bp-pos-top">
                      <b>{p.symbol}</b>
                      <span className="bp-pos-qty mono">{p.qty.toFixed(4)}</span>
                    </div>
                    <div className="bp-pos-meta mono">
                      成本 {p.avgPrice != null ? p.avgPrice.toFixed(2) : '—'}
                      {' · '}
                      现价 {last != null ? last.toFixed(2) : '—'}
                    </div>
                    {pnlAbs != null && (
                      <div className="bp-pos-pnl mono" style={{ color: pnlAbs >= 0 ? 'var(--down)' : 'var(--up)' }}>
                        {pnlAbs >= 0 ? '+' : ''}{pnlAbs.toFixed(2)} USDC
                        {pnlPct != null && ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="pc-head" style={{ marginTop: 6 }}>
              <span className="panel-title">账户</span>
            </div>
            <div className="bp-acct">
              <div><label>可用</label><b>{s?.balanceUSDC?.toFixed(2) ?? '—'} USDC</b></div>
              <div><label>权益</label><b>{s?.equity?.toFixed(2) ?? '—'}</b></div>
              <div><label>峰值</label><b>{s?.peakEquity?.toFixed(2) ?? '—'}</b></div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .brain-page { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }
        .bp-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
        .bp-top-left { display: flex; align-items: baseline; gap: 10px; }
        .bp-title { font-family: var(--font-ui); font-size: 18px; font-weight: 800; color: var(--text-main); }
        .bp-sub { font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); letter-spacing: 0.5px; }
        .bp-sync { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--text-weak); }
        .bp-sync .bp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-weak); }
        .bp-sync.on { color: var(--down); }
        .bp-sync.on .bp-dot { background: var(--down); animation: bpPulse 1.4s ease-in-out infinite; }
        @keyframes bpPulse { 50% { opacity: 0.3; } }

        .bp-venues { display: grid; grid-template-columns: 1fr 1fr 200px; gap: 10px; flex-shrink: 0; }
        .bp-venue {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 9px 11px;
          display: flex; flex-direction: column; gap: 3px; min-width: 0;
        }
        .bp-venue.off { opacity: 0.55; }
        .bpv-head { display: flex; align-items: center; gap: 7px; }
        .bpv-kind {
          font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 0.5px;
          border-radius: 4px; padding: 1px 5px; flex-shrink: 0;
        }
        .bpv-kind.cex { color: var(--warning); border: 1px solid rgba(255,176,32,0.45); }
        .bpv-kind.dex { color: var(--primary); border: 1px solid rgba(34,211,238,0.45); }
        .bpv-name { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
        .bpv-status { font-family: var(--font-ui); font-size: 10px; color: var(--down); }
        .bpv-status.off { color: var(--text-weak); }
        .bpv-note { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .bp-pnl-card {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 9px 11px; display: flex; flex-direction: column; gap: 2px;
        }
        .bp-pnl-card label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .bp-pnl-card b { font-family: var(--font-mono); font-size: 20px; font-weight: 800; }
        .bp-pnl-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }

        .bp-body { display: grid; grid-template-columns: 268px 1fr 236px; gap: 10px; flex: 1; min-height: 0; }
        .panel-card {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 10px 12px;
          display: flex; flex-direction: column; gap: 8px; min-height: 0;
        }
        .pc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 4px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .panel-title { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
        .empty-row { text-align: center; color: var(--text-weak); font-family: var(--font-ui); font-size: 11px; padding: 14px 0; }
        .mono { font-family: var(--font-mono); }

        .bp-tag { font-family: var(--font-mono); font-size: 9px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-weak); }
        .bp-tag.on { color: var(--down); border-color: var(--down); }
        .bp-warn {
          font-family: var(--font-ui); font-size: 10px; line-height: 1.65; color: var(--text-sub);
          background: rgba(255,176,32,0.07); border-left: 2px solid var(--warning);
          padding: 6px 8px; border-radius: 0 6px 6px 0; flex-shrink: 0;
        }
        .bp-warn b { color: var(--warning); }
        .bp-models { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; min-height: 0; }
        .bp-model {
          display: flex; align-items: center; gap: 7px;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 6px 8px;
        }
        .bp-model.on { border-color: rgba(0,214,143,0.4); }
        .bp-model-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-weak); flex-shrink: 0; }
        .bp-model.on .bp-model-dot { background: var(--down); box-shadow: 0 0 6px rgba(0,214,143,0.6); }
        .bp-model-info { display: flex; flex-direction: column; min-width: 0; flex: 1; }
        .bp-model-name { font-family: var(--font-ui); font-size: 11px; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bp-model-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bp-model-state { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); flex-shrink: 0; }
        .bp-model-state.on { color: var(--down); }
        .bp-winner { display: flex; flex-direction: column; gap: 2px; border-top: 1px dashed var(--border); padding-top: 6px; flex-shrink: 0; }
        .bp-winner label { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .bp-winner code { font-family: var(--font-mono); font-size: 10px; color: var(--primary); word-break: break-all; }

        .bp-autoscroll { display: flex; align-items: center; gap: 4px; font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); cursor: pointer; }
        .bp-autoscroll input { accent-color: var(--primary); width: 12px; height: 12px; cursor: pointer; }
        .bp-legend { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .bp-legend-item { display: flex; align-items: center; gap: 4px; font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .bp-legend-item i { font-style: normal; font-size: 10px; }
        .bp-stream { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; padding-right: 2px; }
        .bp-step {
          background: var(--bg-surface); border: 1px solid var(--border);
          border-left-width: 2px; border-radius: 0 7px 7px 0; padding: 5px 8px;
          display: flex; flex-direction: column; gap: 2px;
        }
        .bp-step-head { display: flex; align-items: baseline; gap: 6px; }
        .bp-step-icon { font-size: 9px; flex-shrink: 0; }
        .bp-step-label { font-family: var(--font-ui); font-size: 9px; font-weight: 700; flex-shrink: 0; }
        .bp-step-name { font-family: var(--font-ui); font-size: 11px; font-weight: 600; color: var(--text-main); }
        .bp-step-time { margin-left: auto; font-size: 9px; color: var(--text-weak); flex-shrink: 0; }
        .bp-step-count {
          font-family: var(--font-mono); font-size: 9px; font-weight: 700;
          color: var(--warning); background: rgba(255,176,32,0.12);
          border: 1px solid rgba(255,176,32,0.35); border-radius: 999px; padding: 0 5px; flex-shrink: 0;
        }
        .bp-step-why { font-family: var(--font-ui); font-size: 11px; line-height: 1.6; color: var(--text-main); }
        .bp-step-detail { font-size: 9px; color: var(--text-weak); opacity: 0.7; word-break: break-all; line-height: 1.5; }

        .bp-positions { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; }
        .bp-pos { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
        .bp-pos-top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
        .bp-pos-top b { font-family: var(--font-ui); font-size: 11px; color: var(--text-main); }
        .bp-pos-qty { font-size: 10px; color: var(--accent); }
        .bp-pos-meta { font-size: 9px; color: var(--text-weak); }
        .bp-pos-pnl { font-size: 10px; font-weight: 700; }
        .bp-acct { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
        .bp-acct > div { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
        .bp-acct label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .bp-acct b { font-family: var(--font-mono); font-size: 11px; color: var(--text-main); }
      `}</style>
    </div>
  )
}

function VenueCard({ kind, name, status, online, note }: {
  kind: VenueKind
  name: string
  status: string
  online: boolean
  note: string
}) {
  const meta = VENUE_META[kind]
  return (
    <div className={`bp-venue ${online ? '' : 'off'}`}>
      <div className="bpv-head">
        <span className={`bpv-kind ${kind}`}>{kind.toUpperCase()}</span>
        <span className="bpv-name">{name}</span>
      </div>
      <span className={`bpv-status ${online ? '' : 'off'}`}>{status}</span>
      <span className="bpv-note">{meta.desc} · {note}</span>
    </div>
  )
}
