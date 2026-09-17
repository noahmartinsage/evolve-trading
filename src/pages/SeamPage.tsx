import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, pushToast } from '../store/Store'
import {
  getTrustOverview,
  getCostBrief,
  assessCost,
  listCounterparties,
  assessCounterparty,
  setCounterpartyValidation,
  getSettlement,
  openSettlementObligation,
  advanceSettlement,
  reconcileSettlement,
  getApprovals,
  decideApproval,
  validateClaimText,
  approvalRequires,
  type TrustOverviewView,
  type CostBriefView,
  type CostAssessmentView,
  type CounterpartyRecordView,
  type CounterpartySummaryView,
  type SettlementView,
  type ApprovalView,
  type ClaimReportView,
} from '../orch/client.ts'

/**
 * 双通道可信接缝（Trusted Seam）
 *
 * 这一页回答的问题是：**「这笔交易凭什么可以自动做出去？」**
 *
 * 在补齐这条接缝之前，系统对这个问题只有一个答案：「因为信号说买」。
 * 而真实世界里，一笔自动交易要同时过五道关：
 *   ① 成本盖得住吗（成本闸门）——扣掉往返成本后还赚不赚
 *   ② 对手方是谁（身份/声誉/验证三档信任）
 *   ③ 跨通道借据清得掉吗（同名不同域资产不能合并净额）
 *   ④ 该不该由人来点这个头（人类在环审批）
 *   ⑤ 它说的和实测对得上吗（声称核验）
 *
 * 五道关缺任何一道，系统的可信度就退化成「信号源的信任度」——
 * 而信号源可能只是一个模型的一句自述。
 */

const VERDICT_TONE: Record<string, string> = {
  PASS: 'var(--down)',
  TRUSTED: 'var(--down)',
  SUPPORTED: 'var(--down)',
  VERIFIED: 'var(--down)',
  UNPROVEN: 'var(--warning)',
  UNVERIFIED: 'var(--warning)',
  UNKNOWN_COUNTERPARTY: 'var(--text-weak)',
  NOTIONAL_TOO_SMALL: 'var(--warning)',
  COST_DOMINATED: 'var(--warning)',
  MISSING_COST_ASSUMPTION: 'var(--up)',
  NEGATIVE_NET: 'var(--up)',
  COST_SHARE_TOO_HIGH: 'var(--up)',
  IMPACT_TOO_HIGH: 'var(--up)',
  CONTRADICTED: 'var(--up)',
  REJECTED: 'var(--up)',
  LOW_REPUTATION: 'var(--up)',
  QUARANTINED: 'var(--accent)',
}

const VERDICT_LABEL: Record<string, string> = {
  PASS: '放行',
  MISSING_COST_ASSUMPTION: '假设缺失',
  NOTIONAL_TOO_SMALL: '规模不足',
  IMPACT_TOO_HIGH: '冲击过大',
  NEGATIVE_NET: '净额为负',
  COST_DOMINATED: '成本主导',
  COST_SHARE_TOO_HIGH: '占比过高',
  TRUSTED: '可信',
  UNPROVEN: '未证实',
  LOW_REPUTATION: '声誉不足',
  UNVERIFIED: '未核验',
  QUARANTINED: '已隔离',
  UNKNOWN_COUNTERPARTY: '未登记',
  VERIFIED: '已验证',
  REJECTED: '已否决',
  SUPPORTED: '一致',
  CONTRADICTED: '冲突',
  UNVERIFIABLE: '无法核对',
}

const OBLIGATION_LABEL: Record<string, string> = {
  open: '未结',
  settling: '结算中',
  settled: '已结',
  disputed: '有争议',
  void: '已作废',
}

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: '待批',
  approved: '已批准',
  denied: '已驳回',
  expired: '已过期',
}

const CSS = `
  .ts-root { display: flex; flex-direction: column; gap: 12px; padding-bottom: 16px; }
  .ts-hd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .ts-hd h2 { font-family: var(--font-ui); font-size: 15px; font-weight: 700; color: var(--text-main); margin: 0; }
  .ts-hd p { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); margin: 0; }

  /* 固定两列而不是 auto-fit：auto-fit 在宽屏下会把四张卡片压成四条窄柱，
     同时把剩下的列留成空白 —— 「卡片越宽越好」在这里不成立，
     因为每张卡都含表格，窄到一定程度表格就会横向溢出。
     两列 + 宽卡横跨，是这张页面上信息密度与可读性的平衡点。 */
  .ts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
  @media (max-width: 1080px) { .ts-grid { grid-template-columns: 1fr; } }
  .ts-card {
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 13px; display: flex; flex-direction: column; gap: 9px;
  }
  .ts-card.wide { grid-column: 1 / -1; }
  .ts-card-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .ts-card-t { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); }
  .ts-card-q { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); line-height: 1.5; margin: 0; }

  .ts-kpi { display: flex; gap: 16px; flex-wrap: wrap; }
  .ts-kpi-i { display: flex; flex-direction: column; gap: 2px; }
  .ts-kpi-v { font-family: var(--font-mono); font-size: 17px; font-weight: 700; color: var(--text-main); }
  .ts-kpi-l { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }

  .ts-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ts-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); min-width: 62px; }
  .ts-in, .ts-sel {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-main);
    background: var(--bg-surface); border: 1px solid var(--border-strong);
    border-radius: 6px; padding: 4px 7px; outline: none; min-width: 0;
  }
  .ts-in { width: 92px; }
  .ts-in.wide { width: 100%; font-family: var(--font-ui); }
  .ts-btn {
    font-family: var(--font-ui); font-size: 11px; font-weight: 600;
    color: var(--text-sub); background: var(--bg-surface);
    border: 1px solid var(--border-strong); border-radius: 7px;
    padding: 4px 10px; cursor: pointer; white-space: nowrap; transition: all .14s;
  }
  .ts-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--text-weak); }
  .ts-btn:disabled { opacity: .4; cursor: not-allowed; }
  .ts-btn.primary { color: var(--primary); border-color: rgba(34,211,238,.45); }
  .ts-btn.danger { color: var(--up); border-color: rgba(255,77,109,.4); }

  .ts-tbl { width: 100%; border-collapse: collapse; }
  .ts-tbl th {
    font-family: var(--font-ui); font-size: 9.5px; font-weight: 600; color: var(--text-weak);
    text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border);
  }
  .ts-tbl td {
    font-family: var(--font-mono); font-size: 10.5px; color: var(--text-sub);
    padding: 5px 6px; border-bottom: 1px solid rgba(28,34,51,.6); vertical-align: middle;
  }
  .ts-tbl tr:last-child td { border-bottom: none; }
  .ts-name { font-family: var(--font-ui); font-size: 11px; color: var(--text-main); }

  .ts-chip {
    display: inline-block; font-family: var(--font-ui); font-size: 9.5px; font-weight: 700;
    padding: 1.5px 6px; border-radius: 4px; border: 1px solid currentColor; opacity: .95;
  }
  .ts-note {
    font-family: var(--font-ui); font-size: 10.5px; line-height: 1.6; color: var(--text-sub);
    background: var(--bg-surface); border-left: 2px solid var(--border-strong);
    border-radius: 0 6px 6px 0; padding: 7px 9px; margin: 0; white-space: pre-wrap;
  }
  .ts-note.bad { border-left-color: var(--up); color: #F2A9B6; }
  .ts-note.good { border-left-color: var(--down); color: #A5E6C8; }
  .ts-empty { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-weak); padding: 6px 0; }

  .ts-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-surface); }
  .ts-bar-seg { height: 100%; }
  .ts-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .ts-legend-i { display: flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); }
  .ts-dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }

  .ts-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .ts-2col { grid-template-columns: 1fr; } }
`

/** 按值域给成本构成上色。刻意不用红绿：红绿在本项目里专属于涨跌。 */
const COST_TONES = ['#22D3EE', '#E879F9', '#FFB020', '#97A0B5', '#5C6478', '#FF8700']

function Chip({ text, kind }: { text: string; kind?: string }) {
  const color = (kind && VERDICT_TONE[kind]) || 'var(--text-sub)'
  const label = (kind && VERDICT_LABEL[kind]) || text
  return (
    <span className="ts-chip" style={{ color }}>
      {label}
    </span>
  )
}

export default function SeamPage() {
  const { state, dispatch } = useStore()
  const base = state.orchUrl
  const token = state.orchToken

  const [overview, setOverview] = useState<TrustOverviewView | null>(null)
  const [cost, setCost] = useState<CostBriefView | null>(null)
  const [cps, setCps] = useState<{ records: CounterpartyRecordView[]; summary: CounterpartySummaryView } | null>(null)
  const [settlement, setSettlement] = useState<SettlementView | null>(null)
  const [approvals, setApprovals] = useState<ApprovalView | null>(null)
  const [trustView, setTrustView] = useState<{ id: string; allowed: boolean; verdict: string; sizeMultiplier: number; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // 成本闸门试算表单
  const [channel, setChannel] = useState<'cex' | 'dex'>('cex')
  const [notional, setNotional] = useState('50000')
  const [edgeBps, setEdgeBps] = useState('100')
  const [depth, setDepth] = useState('50000000')
  const [result, setResult] = useState<CostAssessmentView | null>(null)

  // 声称核验试算
  const [claimText, setClaimText] = useState('ADX 28 显示强趋势，盈亏比 3.2')
  const [claimAdx, setClaimAdx] = useState('12')
  const [claimRr, setClaimRr] = useState('1.4')
  const [claimReport, setClaimReport] = useState<ClaimReportView | null>(null)

  // 审批试算
  const [approvalProbe, setApprovalProbe] = useState<{ required: boolean; reason: string } | null>(null)

  const reload = useCallback(async () => {
    const [ov, cb, cp, st, ap] = await Promise.allSettled([
      getTrustOverview(base, 'paper'),
      getCostBrief(base),
      listCounterparties(base),
      getSettlement(base, 'paper'),
      getApprovals(base),
    ])
    if (ov.status === 'fulfilled') setOverview(ov.value)
    if (cb.status === 'fulfilled') setCost(cb.value)
    if (cp.status === 'fulfilled') setCps(cp.value)
    if (st.status === 'fulfilled') setSettlement(st.value)
    if (ap.status === 'fulfilled') setApprovals(ap.value)
  }, [base])

  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), 12_000)
    return () => clearInterval(t)
  }, [reload])

  const runAssess = useCallback(async () => {
    setBusy(true)
    try {
      const input: Record<string, unknown> = {
        channel,
        notionalUsdt: Number(notional),
        expectedEdgeBps: Number(edgeBps),
      }
      // DEX 必须给池深，CEX 不给（CEX 的订单簿冲击无法由单一深度值推算，服务端会拒绝瞎猜）
      if (channel === 'dex') input.poolDepthUsdt = Number(depth)
      const r = await assessCost(base, input)
      setResult(r.assessment)
    } catch (e) {
      pushToast(dispatch, '⚠️ 成本试算失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [base, channel, notional, edgeBps, depth, dispatch])

  const runClaim = useCallback(async () => {
    setBusy(true)
    try {
      const r = await validateClaimText(base, {
        text: claimText,
        facts: { adx: Number(claimAdx), rr: Number(claimRr), timeframe: '15M' },
        // 与提案引擎的口径一致：发现矛盾一律否决，核不了则放行但标注
        requireVerified: false,
      })
      setClaimReport(r.report)
    } catch (e) {
      pushToast(dispatch, '⚠️ 声称核验失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [base, claimText, claimAdx, claimRr, dispatch])

  /**
   * 取「信任裁决」而不是只看记录本身。
   *
   * 记录是**事实**（样本数、成功率、验证状态），裁决是**后果**（允不允许开敞口、敞口打几折）。
   * 面板只展示事实的话，读者仍要自己去脑补那套判定顺序，
   * 而顺序恰恰是这个模块最容易被改错的地方（隔离 > 未登记 > 未核验 > 声誉过低 > 无样本）。
   */
  const inspectTrust = useCallback(
    async (id: string) => {
      try {
        const r = await assessCounterparty(base, id)
        setTrustView({ id, allowed: r.trust.allowed, verdict: r.trust.verdict, sizeMultiplier: r.trust.sizeMultiplier, reason: r.trust.reason })
      } catch (e) {
        pushToast(dispatch, '⚠️ 查询裁决失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [base, dispatch],
  )

  const quarantine = useCallback(
    async (id: string, status: 'verified' | 'quarantined' | 'unverified') => {
      try {
        const r = await setCounterpartyValidation(base, token, {
          id,
          status,
          by: 'operator:panel',
          note: status === 'quarantined' ? '面板人工隔离' : '面板人工核验',
        })
        pushToast(dispatch, (r.ok ? '✅ ' : '⚠️ ') + r.reason)
        await reload()
      } catch (e) {
        pushToast(dispatch, '⚠️ 操作失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [base, token, dispatch, reload],
  )

  const openObligation = useCallback(async () => {
    try {
      const r = await openSettlementObligation(base, token, {
        intentId: `panel-${Date.now().toString(36)}`,
        counterpartyId: 'binance-futures',
        environment: 'paper',
        asset: { symbol: 'USDC', chainId: null },
        direction: 'deliver',
        amountUsdt: 1000,
      })
      pushToast(dispatch, (r.ok ? '✅ ' : '⚠️ ') + r.reason)
      await reload()
    } catch (e) {
      pushToast(dispatch, '⚠️ 开立失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [base, token, dispatch, reload])

  const advance = useCallback(
    async (id: string, next: string) => {
      try {
        const r = await advanceSettlement(base, token, {
          id,
          state: next,
          note: next === 'void' ? '面板人工作废' : undefined,
        })
        pushToast(dispatch, (r.ok ? '✅ ' : '⚠️ ') + r.reason)
        await reload()
      } catch (e) {
        pushToast(dispatch, '⚠️ 推进失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [base, token, dispatch, reload],
  )

  const runReconcile = useCallback(async () => {
    try {
      const r = await reconcileSettlement(base, token, { environment: 'paper', closedIntents: [] })
      pushToast(dispatch, r.consistent ? '✅ 结算对账一致' : `⚠️ 检出 ${r.findings.length} 项差异（只报不自动抹平）`)
      await reload()
    } catch (e) {
      pushToast(dispatch, '⚠️ 对账失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [base, token, dispatch, reload])

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'denied') => {
      try {
        const r = await decideApproval(base, token, {
          id,
          decision,
          by: 'operator:panel',
          note: '面板人工裁决',
        })
        pushToast(dispatch, (r.ok ? '✅ ' : '⚠️ ') + r.reason)
        await reload()
      } catch (e) {
        pushToast(dispatch, '⚠️ 裁决失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [base, token, dispatch, reload],
  )

  const probeRequires = useCallback(async () => {
    try {
      const r = await approvalRequires(base, { kind: 'venue_outbound_enable', environment: 'live', amountUsdt: 0 })
      setApprovalProbe(r)
    } catch (e) {
      pushToast(dispatch, '⚠️ 查询失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [base, dispatch])

  const costTotal = useMemo(
    () => (result ? result.breakdown.items.reduce((a, i) => a + i.usdt, 0) || 1 : 1),
    [result],
  )

  const pending = useMemo(() => (approvals?.requests ?? []).filter((r) => r.status === 'pending'), [approvals])

  return (
    <div className="ts-root">
      <style>{CSS}</style>

      <div className="ts-hd">
        <h2>双通道可信接缝</h2>
        <p>「这笔交易凭什么可以自动做出去」—— 成本 / 对手方 / 结算 / 审批 / 声称核验，五道关同一页</p>
      </div>

      {/* ── 接缝总览 ── */}
      <div className="ts-card wide">
        <div className="ts-card-hd">
          <span className="ts-card-t">接缝健康度</span>
          <span className="ts-card-q">口径与执行层同源 · 每 12s 刷新</span>
        </div>
        <div className="ts-kpi">
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{overview ? overview.cost.cexRoundTripBps : '—'}</span>
            <span className="ts-kpi-l">CEX 往返成本 bps（费率+滑点）</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{overview ? overview.cost.dexRoundTripBps : '—'}</span>
            <span className="ts-kpi-l">DEX 往返成本 bps（仅 LP 费地板）</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{overview ? overview.cost.maxCostShareBps : '—'}</span>
            <span className="ts-kpi-l">成本占名义上限 bps</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{overview ? overview.cost.minEdgeCostMultiple + '×' : '—'}</span>
            <span className="ts-kpi-l">毛收益须盖过成本的倍数</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{cps ? `${cps.summary.total - cps.summary.unproven.length}/${cps.summary.total}` : '—'}</span>
            <span className="ts-kpi-l">已积累结算史的对手方</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v">{settlement ? settlement.summary.open : '—'}</span>
            <span className="ts-kpi-l">未结义务</span>
          </div>
          <div className="ts-kpi-i">
            <span className="ts-kpi-v" style={{ color: pending.length > 0 ? 'var(--warning)' : 'var(--text-main)' }}>
              {pending.length}
            </span>
            <span className="ts-kpi-l">待人工审批</span>
          </div>
        </div>
        {overview && (
          <p className="ts-note">
            两个通道的成本地板相差 {overview.cost.dexRoundTripBps - overview.cost.cexRoundTripBps} bps。同样的价格波动幅度，在 DEX 上必须大到能覆盖这块地板才谈得上净赚 ——
            「同一个信号在两条通道上收益相同」是一个不应存在的结论。
          </p>
        )}
      </div>

      <div className="ts-grid">
        {/* ── ① 成本闸门试算 ── */}
        <div className="ts-card">
          <div className="ts-card-hd">
            <span className="ts-card-t">① 成本闸门（试算）</span>
            <span className="ts-card-q">成本是闸门，不是报表</span>
          </div>
          <p className="ts-card-q">
            只报一个「成本多少」没有判断力；这里回答的是**这笔到底值不值得做**。CEX 分支刻意拒绝由池深推算滑点 —— 订单簿冲击无法由单一深度值还原，
            瞎猜会把所有正常交易都判成不划算。
          </p>
          <div className="ts-row">
            <span className="ts-label">通道</span>
            <select className="ts-sel" value={channel} onChange={(e) => setChannel(e.target.value as 'cex' | 'dex')}>
              <option value="cex">CEX（订单簿）</option>
              <option value="dex">DEX（恒定乘积池）</option>
            </select>
            <span className="ts-label">名义 USDT</span>
            <input className="ts-in" value={notional} onChange={(e) => setNotional(e.target.value)} />
          </div>
          <div className="ts-row">
            <span className="ts-label">毛收益 bps</span>
            <input className="ts-in" value={edgeBps} onChange={(e) => setEdgeBps(e.target.value)} />
            {channel === 'dex' && (
              <>
                <span className="ts-label">池深 USDT</span>
                <input className="ts-in" value={depth} onChange={(e) => setDepth(e.target.value)} />
              </>
            )}
          </div>
          <div className="ts-row">
            <button className="ts-btn primary" onClick={() => void runAssess()} disabled={busy}>
              试算
            </button>
            {channel === 'cex' && cost && (
              <span className="ts-card-q">
                滑点假设 {cost.values.cexExpectedSlippageBps}bps（与回测执行假设同源）
              </span>
            )}
          </div>

          {result && (
            <>
              <div className="ts-row">
                <Chip text={result.verdict} kind={result.verdict} />
                <span className="ts-card-q">
                  毛 {result.grossEdgeUsdt.toFixed(2)} − 成本 {result.totalCostUsdt.toFixed(2)} = 净{' '}
                  <b style={{ color: result.netEdgeUsdt >= 0 ? 'var(--down)' : 'var(--up)' }}>{result.netEdgeUsdt.toFixed(2)}</b> USDT · edge/成本{' '}
                  {result.edgeMultiple === null ? '∞' : result.edgeMultiple.toFixed(2)}× （门槛 {result.requiredMultiple}×）
                </span>
              </div>
              <div className="ts-bar">
                {result.breakdown.items.map((i, idx) => (
                  <div
                    key={i.label}
                    className="ts-bar-seg"
                    style={{ width: `${(i.usdt / costTotal) * 100}%`, background: COST_TONES[idx % COST_TONES.length] }}
                    title={`${i.label} ${i.usdt.toFixed(2)} USDT / ${i.bps.toFixed(1)}bps`}
                  />
                ))}
              </div>
              <div className="ts-legend">
                {result.breakdown.items.map((i, idx) => (
                  <span className="ts-legend-i" key={i.label}>
                    <span className="ts-dot" style={{ background: COST_TONES[idx % COST_TONES.length] }} />
                    {i.label} · {i.bps.toFixed(1)}bps
                  </span>
                ))}
              </div>
              <p className={'ts-note ' + (result.ok ? 'good' : 'bad')}>{result.reason}</p>
            </>
          )}
        </div>

        {/* ── ② 对手方三档信任 ── */}
        <div className="ts-card">
          <div className="ts-card-hd">
            <span className="ts-card-t">② 对手方信任（身份 / 声誉 / 验证）</span>
            <span className="ts-card-q">声誉由本项目自己的结算史派生</span>
          </div>
          <p className="ts-card-q">
            「无样本」不等于「低分」，所以它拿到的是半仓而不是零仓；但「隔离」优先于任何声誉 ——
            一个身份被否定的对手方，分数再高也不能用。
          </p>
          <div style={{ maxHeight: 200, overflow: 'auto' }}>
            <table className="ts-tbl">
              <thead>
                <tr>
                  <th>对手方</th>
                  <th>通道</th>
                  <th>样本</th>
                  <th>声誉</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(cps?.records ?? []).map((r) => (
                  <tr key={r.identity.id} onClick={() => void inspectTrust(r.identity.id)} style={{ cursor: 'pointer' }}>
                    <td className="ts-name">{r.identity.id}</td>
                    <td>{r.identity.channel === 'cex' ? 'CEX' : 'DEX ' + (r.identity.chainName ?? '')}</td>
                    <td>{r.reputation.samples}</td>
                    <td>
                      {r.reputation.score === null ? (
                        <span style={{ color: 'var(--text-weak)' }}>无样本</span>
                      ) : (
                        r.reputation.score.toFixed(3)
                      )}
                    </td>
                    <td>
                      <Chip text={r.validation} kind={r.validation === 'quarantined' ? 'QUARANTINED' : undefined} />
                    </td>
                    <td>
                      {r.validation === 'quarantined' ? (
                        <button className="ts-btn" onClick={() => void quarantine(r.identity.id, 'unverified')}>
                          解除
                        </button>
                      ) : (
                        <button className="ts-btn danger" onClick={() => void quarantine(r.identity.id, 'quarantined')}>
                          隔离
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!cps && <tr><td colSpan={6} className="ts-empty">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          {trustView ? (
            <div className="ts-row">
              <Chip text={trustView.verdict} kind={trustView.verdict} />
              <span className="ts-card-q">
                {trustView.id} ·
                {trustView.allowed ? ` 允许开敞口，规模系数 ${trustView.sizeMultiplier}×` : ' 禁止开敞口'}
              </span>
            </div>
          ) : (
            <p className="ts-card-q">点任意一行查看「信任裁决」（记录是事实，裁决才是后果）</p>
          )}
          {trustView && <p className={'ts-note ' + (trustView.allowed ? 'good' : 'bad')}>{trustView.reason}</p>}
        </div>

        {/* ── ③ 跨通道结算 ── */}
        <div className="ts-card wide">
          <div className="ts-card-hd">
            <span className="ts-card-t">③ 跨通道结算义务台账</span>
            <span className="ts-card-q">同名不同域资产不合并净额</span>
          </div>
          <p className="ts-card-q">
            USDC 在 Base 上是合约地址，在 CEX 上是账户内记账 —— **同名但是两个资产**。把它们加起来做净额，会让「看起来已经轧平」和「实际还欠着」同时成立。
            终态义务不可回退：对账发现问题后把已结改回未结，账本就不再是证据。
          </p>
          <div className="ts-row">
            <button className="ts-btn primary" onClick={() => void openObligation()}>
              开立一条 1000 USDC@cex 义务
            </button>
            <button className="ts-btn" onClick={() => void runReconcile()}>
              跑一次对账
            </button>
            {settlement && (
              <span className="ts-card-q">
                未结 {settlement.summary.open} · 已结 {settlement.summary.settled} · 有争议 {settlement.summary.disputed} · 待转移合计{' '}
                {settlement.netting.outstandingTransferUsdt.toFixed(2)} USDT
              </span>
            )}
          </div>

          <div className="ts-2col">
            <div>
              <div className="ts-card-q" style={{ marginBottom: 4 }}>净额分组（按「符号@域」）</div>
              <table className="ts-tbl">
                <thead>
                  <tr><th>资产键</th><th>收</th><th>付</th><th>净额</th><th>自轧平</th></tr>
                </thead>
                <tbody>
                  {(settlement?.netting.groups ?? []).map((g) => (
                    <tr key={g.assetKey}>
                      <td className="ts-name">{g.assetKey}</td>
                      <td>{g.totalReceive.toFixed(2)}</td>
                      <td>{g.totalDeliver.toFixed(2)}</td>
                      <td style={{ color: g.netTotal >= 0 ? 'var(--down)' : 'var(--up)' }}>{g.netTotal.toFixed(2)}</td>
                      <td>{g.selfClearing ? '是' : '否'}</td>
                    </tr>
                  ))}
                  {(settlement?.netting.groups ?? []).length === 0 && (
                    <tr><td colSpan={5} className="ts-empty">尚无未结义务</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div>
              <div className="ts-card-q" style={{ marginBottom: 4 }}>未结义务</div>
              <div style={{ maxHeight: 150, overflow: 'auto' }}>
                <table className="ts-tbl">
                  <thead>
                    <tr><th>资产</th><th>方向</th><th>金额</th><th>状态</th><th /></tr>
                  </thead>
                  <tbody>
                    {(settlement?.obligations ?? []).slice(-8).reverse().map((o) => (
                      <tr key={o.id}>
                        <td className="ts-name">{o.asset.symbol}@{o.asset.chainId ?? 'cex'}</td>
                        <td>{o.direction === 'deliver' ? '付出' : '收取'}</td>
                        <td>{o.amountUsdt.toFixed(2)}</td>
                        <td>{OBLIGATION_LABEL[o.state] ?? o.state}</td>
                        <td>
                          {o.state === 'open' && (
                            <button className="ts-btn" onClick={() => void advance(o.id, 'settled')}>
                              标记已结
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {(settlement?.obligations ?? []).length === 0 && (
                      <tr><td colSpan={5} className="ts-empty">尚无义务记录</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {(settlement?.netting.crossDomain ?? []).map((c, i) => (
            <p className="ts-note" key={i}>{c.reason}</p>
          ))}
        </div>

        {/* ── ④ 人类在环审批 ── */}
        <div className="ts-card">
          <div className="ts-card-hd">
            <span className="ts-card-t">④ 人类在环审批</span>
            <span className="ts-card-q">代码不能自己批自己</span>
          </div>
          <p className="ts-card-q">
            结构性动作（跨链桥、开通出站、策略回滚、对手方隔离）**不看金额**一律需要审批 ——
            它们改变的是后续所有动作的可行集，不该由金额阈值把关。一次批准只能消费一次。
          </p>
          <div className="ts-row">
            <button className="ts-btn" onClick={() => void probeRequires()}>
              查「开通出站」是否需审批
            </button>
            {approvalProbe && <Chip text={approvalProbe.required ? '需审批' : '免审批'} kind={approvalProbe.required ? 'LOW_REPUTATION' : 'PASS'} />}
          </div>
          {approvalProbe && <p className="ts-note">{approvalProbe.reason}</p>}

          <div style={{ maxHeight: 190, overflow: 'auto' }}>
            <table className="ts-tbl">
              <thead>
                <tr><th>动作</th><th>金额</th><th>环境</th><th>状态</th><th /></tr>
              </thead>
              <tbody>
                {(approvals?.requests ?? []).slice().reverse().slice(0, 10).map((r) => (
                  <tr key={r.id}>
                    <td className="ts-name" title={r.summary}>{r.kind}</td>
                    <td>{r.amountUsdt.toFixed(0)}</td>
                    <td>{r.environment === 'live' ? '实盘' : '纸交易'}</td>
                    <td>{APPROVAL_STATUS_LABEL[r.status] ?? r.status}</td>
                    <td>
                      {r.status === 'pending' && (
                        <div className="ts-row">
                          <button className="ts-btn primary" onClick={() => void decide(r.id, 'approved')}>
                            批准
                          </button>
                          <button className="ts-btn danger" onClick={() => void decide(r.id, 'denied')}>
                            驳回
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {(approvals?.requests ?? []).length === 0 && (
                  <tr><td colSpan={5} className="ts-empty">队列为空 —— 没有实盘动作在等人工点头</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── ⑤ 声称核验 ── */}
        <div className="ts-card">
          <div className="ts-card-hd">
            <span className="ts-card-t">⑤ 声称核验（三态裁定）</span>
            <span className="ts-card-q">「无法验证」不等于「验证通过」</span>
          </div>
          <p className="ts-card-q">
            把模型自述的理由里的可证伪声明抽出来，与实测对账。结果是三态而不是两态：
            「发现矛盾」与「核不了」是两件性质完全不同的事，压成一个布尔就必然有一类被当成另一类 ——
            而把「核不了」折进「通过」，就是又造了一台给幻觉盖章的机器。
          </p>
          <textarea
            className="ts-in wide"
            style={{ minHeight: 52, resize: 'vertical', fontFamily: 'var(--font-ui)', padding: '6px 8px' }}
            value={claimText}
            onChange={(e) => setClaimText(e.target.value)}
          />
          <div className="ts-row">
            <span className="ts-label">实测 ADX</span>
            <input className="ts-in" value={claimAdx} onChange={(e) => setClaimAdx(e.target.value)} />
            <span className="ts-label">实测 R:R</span>
            <input className="ts-in" value={claimRr} onChange={(e) => setClaimRr(e.target.value)} />
            <button className="ts-btn primary" onClick={() => void runClaim()} disabled={busy}>
              核验
            </button>
          </div>
          {claimReport && (
            <>
              <div className="ts-row">
                <Chip text={claimReport.outcome} kind={claimReport.outcome} />
                <span className="ts-card-q">
                  一致 {claimReport.supported} · 冲突 {claimReport.contradicted} · 无法核对 {claimReport.unverifiable}
                </span>
              </div>
              <table className="ts-tbl">
                <tbody>
                  {claimReport.claims.map((c, i) => (
                    <tr key={i}>
                      <td className="ts-name" style={{ whiteSpace: 'nowrap' }}>{c.claim.text}</td>
                      <td><Chip text={c.verdict} kind={c.verdict} /></td>
                      <td>{c.reason}</td>
                    </tr>
                  ))}
                  {claimReport.claims.length === 0 && (
                    <tr><td className="ts-empty">未发现任何可证伪的声明 —— 这不构成「通过」</td></tr>
                  )}
                </tbody>
              </table>
              <p className={'ts-note ' + (claimReport.ok ? 'good' : claimReport.fatal ? 'bad' : '')}>{claimReport.reason}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
