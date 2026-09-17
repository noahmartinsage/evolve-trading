import React, { useEffect, useRef, useState } from 'react'
import { useStore, usePage, pushToast, EvoLogEntry } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { DemoBanner } from '../components/DemoBadge'
import { evaluateCandidateGrid, genSynthCandles, FITNESS_VERSION } from '../engine/index.ts'
import { evaluateSandbox } from '../orch/client.ts'
import type { SandboxEvalResult } from '../orch/client.ts'

const SANDBOX_TEMPLATE = `function makeStrategy(E){
  return {
    id: 'my-mutation',
    params: { lookback: 1 },
    decide(ctx){
      if (ctx.i < 1) return null
      const c = ctx.candles[ctx.i].c
      const p = ctx.candles[ctx.i - 1].c
      if (c < p && ctx.posQty <= 0) return { side:'buy', type:'market', frac:0.9 }
      if (c > p && ctx.posQty > 0) return { side:'sell', type:'market', frac:1 }
      return null
    }
  }
}`

function SandboxPanel() {
  const { state, dispatch } = useStore()
  const [code, setCode] = useState(SANDBOX_TEMPLATE)
  const [result, setResult] = useState<SandboxEvalResult | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await evaluateSandbox(state.orchUrl, state.orchToken, code)
      setResult(r)
      pushToast(dispatch, r.ok ? `🧪 沙箱评估完成 · fitness=${r.fitness}` : `❌ ${r.reason ?? '评估失败'}`)
    } catch (e) {
      pushToast(dispatch, `❌ 沙箱不可达: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const rp = result?.report
  return (
    <div className="panel-card sandbox-card">
      <div className="pc-head">
        <span className="panel-title">变异沙箱评估（E3 · 隔离子进程）</span>
        <span className="chip chip-cyan">断网 · 受限FS · 超时击杀</span>
      </div>
      <div className="sb-row">
        <textarea className="sb-code" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} rows={9} />
      </div>
      <div className="sb-row" style={{ justifyContent: 'space-between' }}>
        <span className="risk-note" style={{ marginTop: 0 }}>契约：定义 makeStrategy(E)，decide(ctx) 返回决策或 null；结果仅入 candidate 观察流程</span>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={run}>{busy ? '沙箱运行中…' : '▶ 在隔离进程中回测'}</button>
      </div>
      {result && (
        result.ok ? (
          <div className="sb-result">
            <span className="mono">fitness=<b>{result.fitness}</b> ({result.fitnessVersion})</span>
            <span className="mono">ann={rp?.annReturnPct}% dd={rp?.maxDrawdownPct}% sharpe={rp?.sharpe} trades/day={rp?.tradesPerDay} fills={result.fills}</span>
          </div>
        ) : (
          <div className="sb-error mono">{result.reason}{result.stderrTail ? ` · ${result.stderrTail}` : ''}</div>
        )
      )}
      <style>{`
        .sandbox-card { display: flex; flex-direction: column; gap: 8px; }
        .sb-row { display: flex; align-items: center; gap: 10px; }
        .sb-code {
          width: 100%; font-family: var(--font-mono); font-size: 11px; line-height: 1.55;
          background: var(--bg-surface); color: var(--text-main);
          border: 1px solid var(--border); border-radius: 8px; padding: 10px;
          resize: vertical; min-height: 160px;
        }
        .sb-result { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-sub); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
        .sb-result b { color: var(--primary); }
        .sb-error { font-size: 10px; color: var(--up); background: rgba(255,77,109,0.06); border: 1px solid rgba(255,77,109,0.3); border-radius: 8px; padding: 8px 10px; word-break: break-all; }
        .risk-note { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
      `}</style>
    </div>
  )
}

const elites = [
  { name: 'HVOL-ARB-07·v9', family: '波动率套利', fitness: 88.4, win: 74.2, sharpe: 3.2, pnl: '+$18.4K', gen: 42, best: true },
  { name: '0x8dxd·Alpha·v14', family: 'ETH 做市', fitness: 87.9, win: 71.8, sharpe: 2.9, pnl: '+$14.1K', gen: 41, best: false },
  { name: 'MOM-SOL-11·v6', family: '动量策略', fitness: 86.7, win: 69.9, sharpe: 2.6, pnl: '+$11.6K', gen: 40, best: false },
  { name: 'STAT-ARB-05·v3', family: '统计套利', fitness: 85.2, win: 66.1, sharpe: 2.4, pnl: '+$9.2K', gen: 38, best: false },
]

const reasoningPool = [
  '分析订单簿深度 500ms 窗口 · 检测到 ETH-USDC 买卖失衡 -1.8σ',
  '生成候选策略变异：调整做市价差 0.12% → 0.09%',
  '模拟回测 24h 历史数据 · 期望收益 +2.1% / 最大回撤 -0.4%',
  '评估风险预算：当前组合夏普 3.2，新增变异将提升至 3.4',
  '通过遗传筛选 · 变异体已注入下一代种群',
]

export default function EvoPage() {
  const { state, dispatch } = useStore()
  const { setPage } = usePage()
  const [inferring, setInferring] = useState(false)
  const [reasonLog, setReasonLog] = useState<string[]>([
    '🟢 系统就绪 · 等待推理指令',
    '—— 上一轮结论：收缩 GRID-BTC-03 网格宽度 2.4% → 2.1% ——',
  ])
  const [progress, setProgress] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const evolve = () => {
    const prev = state.gen
    const key = Object.keys(state.klines).find((k) => (state.klines[k]?.length ?? 0) >= 120)
    const candles = key ? state.klines[key] : genSynthCandles({ seed: 42 + prev, bars: 960, startPrice: 3500, volDaily: 0.04, driftDaily: 0.0003, barMinutes: 15 })
    const dataSource = key ? `真实K线 ${key} (${candles.length}根)` : '合成数据 seed=' + (42 + prev)
    const grid = evaluateCandidateGrid(candles)
    const best = grid[0]
    const entry: EvoLogEntry = {
      gen: prev + 1,
      fitness: best.fitness,
      mutation: grid.length,
      timestamp: Date.now(),
    }
    dispatch({ type: 'EVOLVE_COMPUTED', entry, winRatePct: Math.round(best.report.winRatePct), candidates: grid.length })
    pushToast(
      dispatch,
      `🧬 Gen-${prev}→${entry.gen} · ${best.fitnessVersion} 最优=${best.label} fitness ${best.fitness.toFixed(1)} · ann ${best.report.annReturnPct.toFixed(0)}% dd ${best.report.maxDrawdownPct.toFixed(1)}% · 数据:${dataSource}`,
    )
  }

  const infer = () => {
    if (inferring) return
    setInferring(true)
    setProgress(0)
    setReasonLog(['⚙️ LLM 推理引擎启动 · 加载策略上下文…'])
    let step = 0
    timerRef.current = setInterval(() => {
      step += 1
      setProgress(Math.min(100, step * 20))
      if (step <= reasoningPool.length) {
        setReasonLog((prev) => [reasoningPool[step - 1], ...prev].slice(0, 6))
      }
      if (step >= 6) {
        if (timerRef.current) clearInterval(timerRef.current)
        setInferring(false)
        setReasonLog((prev) => ['✅ 推理完成 · 建议已写入进化队列', ...prev].slice(0, 6))
        pushToast(dispatch, '✅ LLM 推理完成 · 3 条变异建议已入队')
      }
    }, 500)
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  const kpis: KpiItem[] = [
    { label: '当前世代', value: `Gen-${state.gen}`, valueColor: 'var(--accent)', meta: `上一代 Gen-${state.gen - 1}`, metaColor: 'var(--text-sub)' },
    { label: '候选种群', value: String(state.population), valueColor: 'var(--text-main)', meta: '累计评估的参数候选数', metaColor: 'var(--text-sub)' },
    { label: '冠军胜率', value: `${state.winRate}%`, valueColor: 'var(--down)', meta: '上轮冠军策略回测胜率', metaColor: 'var(--text-sub)' },
    { label: '最优适应度', value: state.bestFitness.toFixed(1), valueColor: 'var(--warning)', meta: `${FITNESS_VERSION} · 回测引擎计算`, metaColor: 'var(--primary)' },
    { label: 'LLM 推理', value: '未接入', valueColor: 'var(--text-weak)', meta: '阶段 C 以只提案方式接入', metaColor: 'var(--text-sub)' },
  ]

  return (
    <div className="content-area">
      <DemoBanner text={`适应度已接入回测引擎（${FITNESS_VERSION}，真实 K 线驱动）；谱系树与 LLM 推理仍为演示文案`} />
      <KpiRow items={kpis} height={96} />

      <SandboxPanel />

      <div className="main-area">
        {/* 谱系树 */}
        <div className="lineage-card">
          <div className="lc-head">
            <span className="panel-title">策略谱系树 · 自进化轨迹</span>
            <button className="btn btn-primary btn-sm" onClick={evolve}>
              🧬 启动下一代进化
            </button>
          </div>

          <svg viewBox="0 0 640 300" className="lc-svg">
            {/* 连线 */}
            <path d="M320 34 L110 128" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            <path d="M320 34 L530 128" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            <path d="M110 128 L60 222" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            <path d="M110 128 L170 222" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            <path d="M530 128 L470 222" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            <path d="M530 128 L590 222" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
            {/* 节点 */}
            {[
              { x: 320, y: 34, label: `Gen-${state.gen}`, sub: `适应度 ${state.bestFitness}`, hot: true },
              { x: 110, y: 128, label: 'Gen-40', sub: '适应度 87.2' },
              { x: 530, y: 128, label: 'Gen-39', sub: '适应度 86.8' },
              { x: 60, y: 222, label: 'Gen-38', sub: 'LLM 变异' },
              { x: 170, y: 222, label: 'Gen-37', sub: '淘汰' },
              { x: 470, y: 222, label: 'Gen-36', sub: 'LLM 变异' },
              { x: 590, y: 222, label: 'Gen-35', sub: '淘汰' },
            ].map((n, i) => (
              <g key={i}>
                <circle cx={n.x} cy={n.y} r={n.hot ? 14 : 11} fill={n.hot ? 'rgba(232,121,249,0.16)' : 'var(--bg-card)'} stroke={n.hot ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth={n.hot ? 1.6 : 1.2} />
                {n.hot && <circle cx={n.x} cy={n.y} r={4} fill="var(--accent)" />}
                <text x={n.x} y={n.y + (n.hot ? 30 : 26)} textAnchor="middle" fontSize={n.hot ? 11 : 9.5} fontFamily="var(--font-mono)" fontWeight={n.hot ? 700 : 500} fill={n.hot ? 'var(--accent)' : 'var(--text-sub)'}>{n.label}</text>
                <text x={n.x} y={n.y + (n.hot ? 42 : 38)} textAnchor="middle" fontSize="8.5" fontFamily="var(--font-ui)" fill="var(--text-weak)">{n.sub}</text>
              </g>
            ))}
            {/* 底部进化日志条 */}
          </svg>

          <div className="lc-log">
            <span className="lc-log-title">进化日志</span>
            {state.evolveLog.slice(0, 4).map((e, i) => (
              <div key={i} className="lc-log-row">
                <span className="lc-log-gen" style={{ color: i === 0 ? 'var(--accent)' : 'var(--text-weak)' }}>Gen-{e.gen}</span>
                <span className="lc-log-bar"><span style={{ width: `${e.fitness}%`, background: i === 0 ? 'var(--accent)' : 'var(--border-strong)' }} /></span>
                <span className="lc-log-fit">fitness {e.fitness}</span>
                <span className="lc-log-mut">mut +{e.mutation}%</span>
              </div>
            ))}
          </div>

          <style>{`
            .lineage-card {
              flex: 1; min-width: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column;
            }
            .lc-head { display: flex; align-items: center; justify-content: space-between; height: 32px; flex-shrink: 0; }
            .lc-svg { flex: 1; width: 100%; min-height: 0; }
            .lc-log { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; padding-top: 6px; border-top: 1px solid var(--border); }
            .lc-log-title { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); margin-bottom: 2px; }
            .lc-log-row { display: flex; align-items: center; gap: 8px; }
            .lc-log-gen { width: 52px; font-family: var(--font-mono); font-size: 9.5px; font-weight: 600; flex-shrink: 0; }
            .lc-log-bar { flex: 1; height: 4px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; }
            .lc-log-bar span { display: block; height: 100%; border-radius: 2px; }
            .lc-log-fit { width: 74px; font-family: var(--font-mono); font-size: 9.5px; color: var(--text-sub); flex-shrink: 0; }
            .lc-log-mut { width: 54px; font-family: var(--font-mono); font-size: 9.5px; color: var(--text-weak); flex-shrink: 0; }
          `}</style>
        </div>

        {/* LLM 推理面板 */}
        <div className="right-col llm-panel">
          <div className="llm-card">
            <div className="llm-head">
              <span className="panel-title">LLM 策略推理</span>
              <span className="chip chip-cyan">{inferring ? '推理中…' : '待命'}</span>
            </div>
            <div className="llm-log">
              {reasonLog.map((line, i) => (
                <div key={i} className="llm-line" style={{ opacity: 1 - i * 0.12 }}>{line}</div>
              ))}
              {inferring && <div className="llm-cursor" />}
            </div>
            {inferring && (
              <div className="llm-progress">
                <div className="llm-progress-track"><div className="llm-progress-fill" style={{ width: `${progress}%` }} /></div>
                <span className="llm-progress-pct">{progress}%</span>
              </div>
            )}
            <button className="btn btn-primary btn-lg full" onClick={infer} disabled={inferring}>
              {inferring ? '推理进行中…' : '⚡ 立即推理'}
            </button>
            <button className="btn full mt" onClick={() => pushToast(dispatch, '📋 已导出完整推理轨迹 (JSON)')}>📋 导出推理轨迹</button>
          </div>

          <div className="llm-stats">
            <div className="llm-stat"><span className="llm-stat-label">模型</span><span className="llm-stat-val">EVOLVE-LLM-7B</span></div>
            <div className="llm-stat"><span className="llm-stat-label">温度</span><span className="llm-stat-val">0.4</span></div>
            <div className="llm-stat"><span className="llm-stat-label">上下文</span><span className="llm-stat-val">32K</span></div>
            <div className="llm-stat"><span className="llm-stat-label">缓存命中</span><span className="llm-stat-val">78%</span></div>
          </div>

          <style>{`
            .llm-panel { width: 356px; }
            .llm-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 14px;
              display: flex; flex-direction: column; gap: 10px;
            }
            .llm-head { display: flex; align-items: center; justify-content: space-between; }
            .llm-log {
              flex: 1; min-height: 180px; max-height: 300px;
              background: var(--bg-surface); border: 1px solid var(--border);
              border-radius: 8px; padding: 10px;
              display: flex; flex-direction: column; gap: 8px;
              overflow-y: auto; font-family: var(--font-mono); font-size: 10.5px;
              line-height: 1.6; color: var(--text-sub);
            }
            .llm-line { word-break: break-all; }
            .llm-cursor {
              width: 8px; height: 14px; background: var(--primary);
              animation: blink 0.7s infinite;
            }
            @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
            .llm-progress { display: flex; align-items: center; gap: 8px; }
            .llm-progress-track { flex: 1; height: 4px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; }
            .llm-progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); border-radius: 2px; transition: width 0.4s; }
            .llm-progress-pct { font-family: var(--font-mono); font-size: 10px; color: var(--primary); width: 34px; text-align: right; }
            .btn.full { width: 100%; }
            .btn.mt { margin-top: 0; }
            .llm-stats {
              display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
            }
            .llm-stat {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 8px; padding: 8px 10px;
              display: flex; flex-direction: column; gap: 2px;
            }
            .llm-stat-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
            .llm-stat-val { font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text-main); }
          `}</style>
        </div>
      </div>

      {/* 精英策略表 */}
      <div className="elite-card">
        <div className="elite-head">
          <span className="panel-title">精英策略对比 · Top 4</span>
          <button className="btn btn-sm" onClick={() => setPage('agents')}>部署到 Agent 舰队 →</button>
        </div>
        <table className="tbl">
          <thead><tr><th>策略</th><th>家族</th><th>来源世代</th><th className="num">适应度</th><th className="num">胜率</th><th className="num">Sharpe</th><th className="num">今日 PnL</th><th></th></tr></thead>
          <tbody>
            {elites.map((e, i) => (
              <tr key={i}>
                <td className="strong">{e.name}{e.best && <span className="chip chip-amber" style={{ marginLeft: 6 }}>最优</span>}</td>
                <td>{e.family}</td>
                <td>Gen-{e.gen}</td>
                <td className="num">{e.fitness}</td>
                <td className="num">{e.win}%</td>
                <td className="num">{e.sharpe}</td>
                <td className={`num up`}>{e.pnl}</td>
                <td><button className="btn btn-sm btn-primary" onClick={() => pushToast(dispatch, `✅ 已将 ${e.name} 部署为生产策略`) }>应用策略</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <style>{`
          .elite-card {
            height: 218px; flex-shrink: 0;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; padding: 0 12px;
            display: flex; flex-direction: column;
          }
          .elite-head { display: flex; align-items: center; justify-content: space-between; height: 44px; flex-shrink: 0; }
          .elite-card .tbl { flex: 1; }
          .elite-card tbody { display: block; overflow-y: auto; flex: 1; }
          .elite-card thead, .elite-card tbody tr { display: table; width: 100%; table-layout: fixed; }
        `}</style>
      </div>
    </div>
  )
}
