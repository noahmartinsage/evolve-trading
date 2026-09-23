/**
 * Agent 舰队 —— 从「写死的演示卡片」改成**真实执行面**。
 *
 * ══ 这一页之前是什么样 ══════════════════════════════════════════════════
 * 六张卡片，收益/胜率/成交笔数全是常量，启停与孵化按钮只弹一个 toast。
 * 顶部还挂着一条 "DEMO 数据" 横幅 —— 那横幅是诚实的，但一个诚实的演示页
 * 仍然是演示页：它回答不了"舰队现在到底在干什么"。
 *
 * ══ 现在这一页要回答的三个问题（顺序即重要性）═══════════════════════════
 *   ① **每个成员上一次真跑是什么时候、跑成没有？** —— 实况来自账本里的
 *      `FLEET_AGENT_RUN` 事件。`没跑过` 与 `跑失败` 与 `正常` 必须是三种样子：
 *      把"没跑过"画成绿色，等于告诉用户一个成员在正常工作，而它只是没被用过。
 *   ② **它的产出有没有人读？** —— 每张卡片列出消费面。这是本仓库 B 项检验
 *      唯一的判据（"谁读它的输出"）。一个没有消费面的成员就是孤岛，
 *      而孤岛在页面上看起来和正常成员一模一样 —— 所以消费面必须显式列出。
 *   ③ **它复用哪条既有路径？** —— `reuses` 原样显示。舰队存在的意义是把已有
 *      能力组织起来，不是再长一套；说不出复用对象的成员，用户无从判断
 *      它到底是不是第二条实现路径。
 *
 * ══ 为什么"真跑"要点两次 ═══════════════════════════════════════════════
 * `act` 类成员会改系统状态（写因子台账 / 写策略台账 / 写候选）。服务端对这类
 * 成员的判据是 `confirmed !== true ⇒ 拒绝`，所以界面上必须存在一个**显式的
 * 确认动作**。一次点击就改台账的按钮，等于把服务端那条红线在 UI 层抹掉。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { pushToast, useStore } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import {
  planFleetTask,
  runFleetAgent,
  runFleetTask,
  useFleet,
  type FleetAgentView,
  type FleetRunReceiptView,
  type FleetTaskReceiptView,
} from '../orch/client.ts'

const COST_LABEL: Record<string, string> = { instant: '瞬时', fast: '秒级', slow: '分钟级' }

/**
 * 三态。**`never` 用灰而不是绿** —— 这是这一页最要紧的一条视觉契约：
 * "还没跑过"在旧版页面上被画成了"运行中"的绿色脉冲点。
 */
function StateChip({ state }: { state: FleetAgentView['state'] }) {
  if (state === 'ok') return <span className="chip chip-green">正常</span>
  if (state === 'failed') return <span className="chip chip-red">上次失败</span>
  return <span className="chip chip-gray">没跑过</span>
}

function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分`
}

export default function AgentsPage() {
  const { state, dispatch } = useStore()
  const fleet = useFleet(state.orchUrl, state.orchToken)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmArmed, setConfirmArmed] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [goal, setGoal] = useState('系统巡检')
  const [planHint, setPlanHint] = useState<string | null>(null)
  const [taskResult, setTaskResult] = useState<FleetTaskReceiptView | null>(null)
  const [agentResult, setAgentResult] = useState<FleetRunReceiptView | null>(null)

  const snap = fleet.data?.snapshot ?? null
  // 包一层 useMemo：`snap?.agents ?? []` 每次都新建数组，直接放进下面的
  // useMemo 依赖里会让它每帧都重算（lint 会告警，而"每帧重算"的真正代价是
  // 每次渲染都换引用，下游的 memo 全部失效）。
  const agents = useMemo(() => snap?.agents ?? [], [snap])
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null

  const stats = useMemo(() => {
    const ran = agents.filter((a) => a.state !== 'never')
    return {
      total: agents.length,
      ran: ran.length,
      ok: agents.filter((a) => a.state === 'ok').length,
      failed: agents.filter((a) => a.state === 'failed').length,
      never: agents.length - ran.length,
      islands: agents.filter((a) => a.consumers.length === 0).length,
      problems: snap?.registry.problems.length ?? 0,
    }
  }, [agents, snap])

  const doRun = useCallback(
    async (a: FleetAgentView, confirmed: boolean) => {
      setBusy(a.id)
      setConfirmArmed(null)
      try {
        const r = await runFleetAgent(state.orchUrl, state.orchToken, {
          agentId: a.id,
          confirmed,
          dryRun,
        })
        setAgentResult(r)
        fleet.refresh()
        pushToast(dispatch, `${r.ok ? '✅' : '⛔'} ${r.label}：${r.reason ?? r.summary}`.slice(0, 120))
      } catch (e) {
        pushToast(dispatch, `⛔ ${a.label} 调用失败：${e instanceof Error ? e.message.slice(0, 90) : String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [state.orchUrl, state.orchToken, dryRun, dispatch, fleet],
  )

  /** act 类要两段式：第一次点击只"上膛"，不执行。 */
  const onRunClick = (a: FleetAgentView) => {
    if (a.kind === 'act' && !confirmArmed) {
      setConfirmArmed(a.id)
      pushToast(dispatch, `⚠️ ${a.label} 会改系统状态（${dryRun ? '试跑模式下不会落盘' : '真跑会写台账'}）—— 再点一次确认`)
      return
    }
    void doRun(a, true)
  }

  const onPlanCheck = async () => {
    try {
      const r = await planFleetTask(state.orchUrl, state.orchToken, goal)
      setPlanHint(r.why)
    } catch (e) {
      setPlanHint(`计划核对失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onRunTask = async () => {
    setBusy('__task__')
    try {
      const r = await runFleetTask(state.orchUrl, state.orchToken, { goal, confirmed: true, dryRun })
      setTaskResult(r)
      fleet.refresh()
      pushToast(dispatch, r.ok ? '✅ 任务链跑完了' : `⛔ 任务链停在「${r.failedAt ?? r.refusal ?? '未知'}」`)
    } catch (e) {
      // 服务端对失败的任务链回 422 并把凭据放在 body 里，orchFetch 会把它当异常抛。
      // 那一刻"任务跑没跑"是用户最想知道的事，所以这里必须把它读出来显示，不能只弹一句"失败"。
      const msg = e instanceof Error ? e.message : String(e)
      setTaskResult(null)
      setPlanHint(`任务链中断：${msg.slice(0, 300)}`)
      fleet.refresh()
      pushToast(dispatch, '⛔ 任务链没有跑完，失败点在下方凭据里')
    } finally {
      setBusy(null)
    }
  }

  const kpis: KpiItem[] = [
    {
      label: '成员',
      value: String(stats.total),
      valueColor: 'var(--text-main)',
      meta: `跑过 ${stats.ran} · 没跑过 ${stats.never}`,
      metaColor: stats.never > 0 ? 'var(--warning)' : 'var(--text-sub)',
    },
    {
      label: '上次成功',
      value: String(stats.ok),
      valueColor: stats.ok > 0 ? 'var(--down)' : 'var(--text-weak)',
      meta: stats.failed > 0 ? `另有 ${stats.failed} 个上次失败` : '没有失败记录',
      metaColor: stats.failed > 0 ? 'var(--up)' : 'var(--text-sub)',
    },
    {
      label: '孤岛成员',
      value: String(stats.islands),
      valueColor: stats.islands > 0 ? 'var(--up)' : 'var(--down)',
      meta: '消费面为空的成员 · 必须为 0',
      metaColor: 'var(--text-sub)',
    },
    {
      label: '注册表问题',
      value: String(stats.problems),
      valueColor: stats.problems > 0 ? 'var(--up)' : 'var(--down)',
      meta: '无订阅者主题 / 非法动作意图等',
      metaColor: 'var(--text-sub)',
    },
    {
      label: '总线',
      value: snap ? String(snap.bus.messages) : '—',
      valueColor: 'var(--text-main)',
      meta: snap ? `${snap.bus.topics} 个主题 · ${snap.bus.subscriptions} 个订阅` : '未连接编排器',
      metaColor: 'var(--text-sub)',
    },
  ]

  return (
    <div className="content-area">
      {/* ★ 这里**不再有 DEMO 横幅**。上面每一个数字都来自账本事件或总线投递记录，
          出处由服务端在 `provenance` 里给出，原样显示在下面。
          把真实数据和演示数据用同一个横幅标着，会让两者都失去可信度。 */}
      <div className="fleet-prov">
        <span className={`db-tag ${snap && stats.problems === 0 ? 'ok' : 'warn'}`}>
          {snap ? (stats.problems === 0 ? '真实数据' : '有问题') : '未连接'}
        </span>
        <span className="fleet-prov-text">
          {fleet.error
            ? `读不到舰队实况：${fleet.error.slice(0, 120)}（下面显示的是上一份快照）`
            : (snap?.provenance ?? '正在读舰队实况…')}
        </span>
        <button className="btn btn-sm" data-ui="agents.refresh" onClick={fleet.refresh}>
          刷新
        </button>
      </div>

      <KpiRow items={kpis} height={96} />

      {/* ── 任务面板：一句话 → 一串真实动作 ─────────────────────────── */}
      <div className="fleet-taskbox">
        <input
          className="fleet-goal"
          value={goal}
          placeholder="说一件想做的事，例如：扩候选基因空间 / 跑一轮提案 / 文件体检"
          onChange={(e) => setGoal(e.target.value)}
        />
        <label className="fleet-dry">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          试跑（只算不落盘）
        </label>
        <button className="btn btn-sm" data-ui="agents.plan.check" onClick={onPlanCheck} disabled={busy !== null}>
          这计划能接吗
        </button>
        <button className="btn btn-sm btn-primary" data-ui="agents.run.task" onClick={onRunTask} disabled={busy !== null}>
          {busy === '__task__' ? '跑着…' : '跑这个任务'}
        </button>
      </div>
      {planHint && <div className="fleet-hint">{planHint}</div>}

      {fleet.data && fleet.data.plans.length > 0 && (
        <div className="fleet-hint fleet-plans">
          <b>能听懂的说法：</b>
          {fleet.data.plans.map((p) => (
            <button
              key={p.id}
              className="fleet-plan-chip"
              onClick={() => setGoal(p.label.split(' / ')[0])}
              title={`${p.chain.join(' → ')}\n${p.why}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="main-area">
        <div className="agents-grid">
          {agents.map((a) => {
            const isSel = selected?.id === a.id
            return (
              <div
                key={a.id}
                className={`agent-card ${isSel ? 'on' : ''}`}
                onClick={() => {
                  setSelectedId(a.id)
                  setConfirmArmed(null)
                }}
              >
                <div className="ac-head">
                  <div className="ac-id">
                    <span className={`pulse-dot2 ${a.state === 'ok' ? 'live' : ''}`} />
                    <span className="ac-name">{a.label}</span>
                    <span className="ac-sub">{a.id}</span>
                  </div>
                  <StateChip state={a.state} />
                </div>
                <div className="ac-duty">{a.duty}</div>
                <div className="ac-metrics">
                  <div className="ac-m">
                    <span className="ac-m-label">类别</span>
                    <span className="ac-m-val">{a.kind === 'act' ? '动作' : '只读'}</span>
                  </div>
                  <div className="ac-m">
                    <span className="ac-m-label">耗时档</span>
                    <span className="ac-m-val">{COST_LABEL[a.cost] ?? a.cost}</span>
                  </div>
                  <div className="ac-m">
                    <span className="ac-m-label">跑过</span>
                    <span className="ac-m-val">
                      {a.runCount} 次（成 {a.okCount} / 败 {a.failCount}）
                    </span>
                  </div>
                  <div className="ac-m">
                    <span className="ac-m-label">消费面</span>
                    <span className={`ac-m-val ${a.consumers.length === 0 ? 'bad' : ''}`}>
                      {a.consumers.length === 0 ? '0（孤岛）' : `${a.consumers.length} 处`}
                    </span>
                  </div>
                </div>
                <div className="ac-lastrun">
                  {a.lastRun
                    ? `${fmtTime(a.lastRun.at)} · ${fmtMs(a.lastRun.durationMs)}${a.lastRun.dryRun ? ' · 试跑' : ''}`
                    : '还没有运行记录 —— 不是"正常"，是"还没跑过"'}
                </div>
                <div className="ac-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`btn btn-sm ${confirmArmed === a.id ? 'btn-armed' : a.kind === 'act' ? '' : 'btn-primary'}`}
                    onClick={() => onRunClick(a)}
                    disabled={busy !== null}
                  >
                    {busy === a.id ? '跑着…' : confirmArmed === a.id ? '再点确认执行' : dryRun ? '试跑一次' : '真跑'}
                  </button>
                </div>
              </div>
            )
          })}
          {agents.length === 0 && (
            <div style={{ color: 'var(--text-weak)', padding: 40 }}>
              {fleet.error ? '编排器没连上，读不到舰队成员' : '正在读舰队成员…'}
            </div>
          )}
          <style>{`
            .fleet-prov {
              display: flex; align-items: center; gap: 10px; flex-shrink: 0;
              background: rgba(34,211,238,0.05); border: 1px solid var(--border);
              border-radius: 8px; padding: 7px 12px;
            }
            .fleet-prov .db-tag { font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 1px;
              border-radius: 4px; padding: 2px 6px; white-space: nowrap; border: 1px solid var(--border-strong); color: var(--text-sub); }
            .fleet-prov .db-tag.ok { color: var(--down); border-color: rgba(34,197,94,0.45); background: rgba(34,197,94,0.06); }
            .fleet-prov .db-tag.warn { color: var(--warning); border-color: rgba(255,176,32,0.45); background: rgba(255,176,32,0.06); }
            .fleet-prov-text { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.5; }
            .fleet-taskbox { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
            .fleet-goal { flex: 1; min-width: 0; background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 8px; padding: 7px 10px; color: var(--text-main); font-family: var(--font-ui); font-size: 12px; }
            .fleet-dry { display: flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); white-space: nowrap; }
            .fleet-hint { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.6;
              background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; flex-shrink: 0; }
            .fleet-plans { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
            .fleet-plan-chip { font-family: var(--font-ui); font-size: 11px; color: var(--text-main);
              background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; cursor: pointer; }
            .fleet-plan-chip:hover { border-color: var(--primary-40); color: var(--primary); }
            .agents-grid {
              flex: 1; min-width: 0;
              display: grid; grid-template-columns: repeat(2, 1fr);
              grid-auto-rows: minmax(0, 1fr);
              gap: 12px; overflow-y: auto; padding-right: 2px;
            }
            .agent-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column; gap: 7px;
              cursor: pointer; transition: all 0.15s;
              overflow: hidden;
            }
            .agent-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
            .agent-card.on { border-color: var(--primary-40); box-shadow: 0 0 0 1px var(--primary-40), 0 8px 24px rgba(34,211,238,0.06); }
            .ac-head { display: flex; align-items: center; justify-content: space-between; }
            .ac-id { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
            .ac-name { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-main); white-space: nowrap; }
            .ac-sub { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
            .ac-duty { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); line-height: 1.5;
              display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
            .ac-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 2px; }
            .ac-m { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
            .ac-m-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); flex-shrink: 0; }
            .ac-m-val { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--text-main); text-align: right; }
            .ac-m-val.bad { color: var(--up); }
            .ac-lastrun { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); line-height: 1.5; }
            .ac-actions { display: flex; gap: 8px; }
            /* "已上膛"必须与普通按钮**明显不同** —— 它是这一页唯一会改台账的入口，
               用全局的 btn-buy（红色，含义是"买入"）会让用户读成行情动作。
               所以这里用 warning 色，含义是"待确认"，不是方向。 */
            .btn-armed {
              background: rgba(255,176,32,0.18);
              border-color: rgba(255,176,32,0.55);
              color: var(--warning);
              animation: armedPulse 1.1s ease-in-out infinite;
            }
            @keyframes armedPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.62 } }
          `}</style>
        </div>

        {/* ── 详情：复用路径 / 产出 / 消费面 / 收件箱 ────────────────── */}
        <div className="right-col agent-detail">
          {selected ? (
            <div className="detail-card">
              <div className="dc-head">
                <span className="panel-title">{selected.label}</span>
                <StateChip state={selected.state} />
              </div>
              <div className="dc-row">
                <span className="dc-label">复用路径</span>
                <span className="dc-val fleet-wrap">{selected.reuses}</span>
              </div>
              <div className="dc-row">
                <span className="dc-label">产出</span>
                <span className="dc-val fleet-wrap">{selected.output}</span>
              </div>
              <div className="dc-row">
                <span className="dc-label">消费面</span>
                <span className="dc-val fleet-wrap">
                  {selected.consumers.length === 0
                    ? '空的 —— 这就是孤岛，产出没有下游'
                    : selected.consumers.map((c) => c.label).join('、')}
                </span>
              </div>
              <div className="dc-row">
                <span className="dc-label">发出主题</span>
                <span className="dc-val fleet-wrap">{selected.emits.join('、') || '（不发）'}</span>
              </div>
              <div className="dc-row">
                <span className="dc-label">吃进主题</span>
                <span className="dc-val fleet-wrap">{selected.consumes.join('、') || '（独立核对，不依赖上游）'}</span>
              </div>
              <div className="dc-row">
                <span className="dc-label">累计</span>
                <span className="dc-val mono">
                  {selected.runCount} 次 · 成 {selected.okCount} / 败 {selected.failCount}
                </span>
              </div>
              {selected.lastRun && (
                <div className="dc-row">
                  <span className="dc-label">上次产出</span>
                  <span className="dc-val fleet-wrap">{selected.lastRun.summary}</span>
                </div>
              )}

              <div className="dc-note-title mt">收件箱（上游真喂进来的消息）</div>
              {selected.inbox.length === 0 ? (
                <div className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                  · 暂时没有上游消息。声明了 `consumes` 的成员在任务链里收不到输入时会**失败**，不会空着参数跑完。
                </div>
              ) : (
                selected.inbox.slice(0, 4).map((m) => (
                  <div key={m.msgId} className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                    · [{m.topic}] 来自 {m.from}：{m.note}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="detail-card" style={{ color: 'var(--text-weak)' }}>
              还没读到成员信息
            </div>
          )}

          {agentResult && (
            <div className="dc-note">
              <span className="dc-note-title">
                上次单跑凭据 · {agentResult.label} · {agentResult.ok ? '成功' : '失败'} · {fmtMs(agentResult.durationMs)}
              </span>
              {agentResult.steps.map((s, i) => (
                <div key={i} className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                  · {s}
                </div>
              ))}
              {agentResult.emitted.length > 0 && (
                <div className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                  · 发出：{agentResult.emitted.map((e) => `${e.topic} → ${e.deliveredTo.join('/') || '无人订阅'}`).join('；')}
                </div>
              )}
              {agentResult.reason && (
                <div className="dc-note-line" style={{ color: 'var(--up)' }}>
                  · 未通过：{agentResult.reason}
                </div>
              )}
            </div>
          )}

          {taskResult && (
            <div className="dc-note">
              <span className="dc-note-title">
                上次任务凭据 · {taskResult.goal} · {taskResult.ok ? '全链跑通' : `停在 ${taskResult.failedAt ?? taskResult.refusal}`}
              </span>
              <div className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                · 调度理由：{taskResult.why}
              </div>
              {taskResult.steps.map((s) => (
                <div key={s.agentId} className="dc-note-line" style={{ color: 'var(--text-sub)' }}>
                  · {s.label}
                  {s.independent ? '（独立核对）' : ''}：{s.ok ? '成了' : '没成'} — {s.summary.slice(0, 90)}
                </div>
              ))}
              <div className="dc-note-line" style={{ color: 'var(--text-weak)' }}>
                · 落 {taskResult.ledgerEvents} 条账本事件、{taskResult.messageCount} 条总线消息
              </div>
            </div>
          )}

          <style>{`
            .agent-detail { width: 356px; }
            .fleet-wrap { max-width: 220px; text-align: right; font-family: var(--font-ui); font-weight: 500;
              font-size: 10.5px; line-height: 1.5; color: var(--text-sub); }
            .detail-card {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 14px;
              display: flex; flex-direction: column; gap: 8px;
              overflow-y: auto; max-height: 52%;
            }
            .dc-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 2px; }
            .dc-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
            .dc-label { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); flex-shrink: 0; }
            .dc-val { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
            .dc-val.mono { font-family: var(--font-mono); font-size: 11px; }
            .dc-note {
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px 14px;
              display: flex; flex-direction: column; gap: 6px;
              flex: 1; min-height: 0; overflow-y: auto;
            }
            .dc-note-title { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
            .dc-note-title.mt { margin-top: 6px; }
            .dc-note-line { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; }
          `}</style>
        </div>
      </div>
    </div>
  )
}
