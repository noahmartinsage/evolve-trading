import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, pushToast } from '../store/Store'
import { ReservationLedger } from '../components/ReservationLedger.tsx'
import { PolicySnapshotPanel } from '../components/PolicySnapshotPanel.tsx'
import {
  useOrch,
  getRiskSchema,
  getRiskSuites,
  applyRiskValues,
  listInterceptors,
  toggleInterceptor,
  reorderInterceptors,
  resetInterceptors,
  runInterceptorSandbox,
  getLessons,
  proposeLesson,
  decayLessons,
  toggleLesson,
  resetLessons,
  type RiskSchemaView,
  type RiskSuiteView,
  type InterceptorView,
  type SandboxResultView,
  type LessonView,
  type LessonStatsView,
} from '../orch/client.ts'

/**
 * 风控管理中心（Risk Control Center）
 *
 * 这个页面的存在理由，是回答一个此前无法回答的问题：
 *   **「系统凭什么在某个时刻拦下了一笔交易，以及我调的那些数字到底有没有生效？」**
 *
 * 四个分区对应四层不同性质的风控能力：
 *   ① 预设套件   —— 换「风险哲学」而不是拧单个旋钮（稳健 / 均衡 / 进取）
 *   ② 参数分组   —— 单一事实源，面板所见即引擎所用（写盘 + 进程内热重载）
 *   ③ 拦截闸门   —— Fail-Closed 管线：拦截器顺序、启停、以及可执行的沙箱自检
 *   ④ 进化心法   —— 自进化的宪法红线：能学什么、学不动什么、什么时候忘掉
 *
 * ⚠️ 诚实约定：页面只呈现编排器真实返回的 schema 与校验结果。
 *    任一参数非法、套件不合法、强制闸门缺失，都会如实标红，不做静默钳制。
 */

/** 三档风险哲学的中性视觉语气：稳健=冷、均衡=主色、进取=暖。刻意不用红绿，避免与涨跌色冲突。 */
const SUITE_TONE: Record<string, { border: string; text: string; bg: string }> = {
  conservative: { border: 'rgba(34,211,238,0.45)', text: 'var(--primary)', bg: 'rgba(34,211,238,0.06)' },
  balanced: { border: 'rgba(232,121,249,0.5)', text: 'var(--accent)', bg: 'rgba(232,121,249,0.06)' },
  aggressive: { border: 'rgba(255,176,32,0.5)', text: 'var(--warning)', bg: 'rgba(255,176,32,0.06)' },
}

/** 心法类别中文名。键必须与服务端 LessonCategory 枚举逐字对应——写错会退化成英文原文显示。 */
const LESSON_CATEGORY_LABEL: Record<string, string> = {
  TREND_FOLLOWING: '顺势跟随',
  RISK_CONTROL: '风险控制',
  WIN_RATE_LOCK: '胜率锁利',
  PORTFOLIO_DIVERSIFICATION: '组合分散',
  EXECUTION_QUALITY: '执行质量',
  REGIME_ADAPTATION: '状态自适应',
}

type TabId = 'params' | 'interceptors' | 'lessons' | 'budget' | 'policy'

export default function RiskCenterPage() {
  const { state, dispatch } = useStore()
  const orch = useOrch(state.orchUrl, state.orchToken, 5000)
  const online = orch.status === 'online'

  const [tab, setTab] = useState<TabId>('params')
  const [schema, setSchema] = useState<RiskSchemaView | null>(null)
  const [suites, setSuites] = useState<RiskSuiteView[]>([])
  const [interceptors, setInterceptors] = useState<InterceptorView[]>([])
  const [lessons, setLessons] = useState<LessonView[]>([])
  const [lessonStat, setLessonStat] = useState<LessonStatsView | null>(null)

  /** 未保存的改动。与 schema.values 做 diff 后才是「真实待保存集」。 */
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<string>('')

  const [sandbox, setSandbox] = useState<{ total: number; passed: number; results: SandboxResultView[] } | null>(null)
  const [expandedScenario, setExpandedScenario] = useState<string | null>(null)

  const [newRule, setNewRule] = useState('')
  const [newCategory, setNewCategory] = useState('TREND_FOLLOWING')
  const [newEvidence, setNewEvidence] = useState('')
  const [proposeVerdict, setProposeVerdict] = useState<{ accepted: boolean; reason: string } | null>(null)

  /**
   * 拉取一次全部风控视图数据。
   *
   * 用 useCallback 而不是「ref 里存函数」的写法：后者需要在 render 期间写 ref，
   * 会让 React 的并发渲染读到不一致的状态，也被 lint 规则明确禁止。
   */
  const load = useCallback(async () => {
    if (!online) return
    try {
      const [sc, su, it] = await Promise.all([
        getRiskSchema(state.orchUrl),
        getRiskSuites(state.orchUrl),
        listInterceptors(state.orchUrl),
      ])
      setSchema(sc)
      setSuites(su.suites)
      setInterceptors(it.interceptors)
      // 只在没有未保存改动时用服务端值刷新草稿，避免覆盖用户正在编辑的内容
      setDraft((prev) => (Object.keys(prev).length > 0 ? prev : { ...sc.values }))
      setActiveGroup((prev) => prev || sc.groups[0]?.id || '')
    } catch {
      /* 编排器离线时静默，顶部状态灯已表达 */
    }
    try {
      const ls = await getLessons(state.orchUrl)
      setLessons(ls.lessons)
      setLessonStat(ls.stats)
    } catch {
      /* 心法库可选 */
    }
  }, [online, state.orchUrl])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 6000)
    return () => clearInterval(t)
  }, [load])

  // ── 参数 diff：只有真正改过的项才会提交，避免「点保存把全部参数重写一遍」留下噪声审计 ──
  const dirtyKeys = useMemo(() => {
    if (!schema) return []
    return Object.keys(draft).filter((k) => {
      const a = draft[k]
      const b = schema.values[k]
      return typeof a === 'number' && Number.isFinite(a) && a !== b
    })
  }, [draft, schema])

  const groupParams = useMemo(() => {
    if (!schema) return []
    return schema.params.filter((p) => p.group === activeGroup)
  }, [schema, activeGroup])

  const dirtyInGroup = useMemo(() => {
    const set = new Set(dirtyKeys)
    return groupParams.filter((p) => set.has(p.key)).length
  }, [dirtyKeys, groupParams])

  async function onApplySuite(suite: RiskSuiteView) {
    if (!online || busy) return
    setBusy(`suite:${suite.id}`)
    try {
      const r = await applyRiskValues(state.orchUrl, state.orchToken, { suiteId: suite.id })
      if (r.ok) {
        pushToast(dispatch, `已应用「${suite.name}」· ${r.changed?.length ?? 0} 项参数即时生效${sampleTransition(r.transitions)}`)
        setDraft({})
        await load()
      } else {
        pushToast(dispatch, `套件应用失败：${r.error ?? '未知原因'}`)
      }
    } catch (e) {
      pushToast(dispatch, `套件应用失败：${e instanceof Error ? e.message : '网络错误'}`)
    } finally {
      setBusy(null)
    }
  }

  async function onSaveParams() {
    if (!online || busy || dirtyKeys.length === 0) return
    setBusy('save')
    try {
      const values: Record<string, number> = {}
      for (const k of dirtyKeys) values[k] = draft[k]
      const r = await applyRiskValues(state.orchUrl, state.orchToken, { values })
      if (r.ok) {
        pushToast(dispatch, `${r.changed?.length ?? 0} 项风控参数已写盘并即时生效`)
        setDraft({})
        await load()
      } else {
        pushToast(dispatch, `保存被拒：${r.error ?? '校验失败'}`)
      }
    } catch (e) {
      pushToast(dispatch, `保存失败：${e instanceof Error ? e.message : '网络错误'}`)
    } finally {
      setBusy(null)
    }
  }

  async function onToggleInterceptor(i: InterceptorView) {
    if (!online || busy) return
    if (i.mandatory) {
      pushToast(dispatch, `「${i.name}」是强制安全地板，不可停用`)
      return
    }
    setBusy(`it:${i.id}`)
    try {
      const r = await toggleInterceptor(state.orchUrl, state.orchToken, i.id, !i.enabled)
      if (r.ok) await load()
      else pushToast(dispatch, r.error ?? '操作失败')
    } catch (e) {
      pushToast(dispatch, e instanceof Error ? e.message : '网络错误')
    } finally {
      setBusy(null)
    }
  }

  async function onMove(i: InterceptorView, dir: -1 | 1) {
    if (!online || busy) return
    const ids = interceptors.map((x) => x.id)
    const idx = ids.indexOf(i.id)
    const next = idx + dir
    if (next < 0 || next >= ids.length) return
    ;[ids[idx], ids[next]] = [ids[next], ids[idx]]
    setBusy('reorder')
    try {
      const r = await reorderInterceptors(state.orchUrl, state.orchToken, ids)
      if (r.ok) await load()
      else pushToast(dispatch, r.error ?? '调序失败')
    } catch (e) {
      pushToast(dispatch, e instanceof Error ? e.message : '网络错误')
    } finally {
      setBusy(null)
    }
  }

  async function onRunSandbox() {
    if (!online || busy) return
    setBusy('sandbox')
    try {
      const r = await runInterceptorSandbox(state.orchUrl, state.orchToken)
      setSandbox(r)
      const bad = r.total - r.passed
      pushToast(
        dispatch,
        bad === 0
          ? `沙箱自检全部通过 · ${r.passed}/${r.total} 场景符合预期`
          : `沙箱自检发现 ${bad} 个场景与预期不符，请检查闸门配置`,
      )
    } catch (e) {
      pushToast(dispatch, e instanceof Error ? e.message : '沙箱执行失败')
    } finally {
      setBusy(null)
    }
  }

  async function onSubmitLesson() {
    if (!online || busy) return
    const ruleText = newRule.trim()
    if (ruleText.length < 6) {
      pushToast(dispatch, '心法正文太短，请写清「什么条件下该怎么做」')
      return
    }
    setBusy('lesson')
    try {
      const r = await proposeLesson(state.orchUrl, state.orchToken, {
        ruleText,
        category: newCategory,
        evidence: newEvidence.trim() || undefined,
      })
      setProposeVerdict({ accepted: r.accepted, reason: r.reason })
      if (r.accepted) {
        pushToast(dispatch, '心法已通过宪法红线校验并入册')
        setNewRule('')
        setNewEvidence('')
        await load()
      }
    } catch (e) {
      setProposeVerdict({ accepted: false, reason: e instanceof Error ? e.message : '提交失败' })
    } finally {
      setBusy(null)
    }
  }

  const mandatoryMissing = interceptors.filter((i) => i.mandatory && !i.enabled)
  const errors = schema?.errors ?? []

  return (
    <div className="rc-page">
      {/* ── 页头：状态 + 全局动作 ── */}
      <div className="rc-top">
        <div className="rc-top-left">
          <span className="rc-title">风控管理中心</span>
          <span className="rc-sub">单一事实源 · Fail-Closed 拦截管线 · 自进化宪法红线</span>
        </div>
        <div className="rc-top-right">
          <span className={`rc-sync ${online ? 'on' : ''}`}>
            <i className="rc-dot" />
            {online ? '已接入编排器' : '编排器离线'}
          </span>
          <button className="rc-btn primary" data-ui="risk.sandbox.run" disabled={!online || busy === 'sandbox'} onClick={onRunSandbox}>
            {busy === 'sandbox' ? '自检中…' : '⚡ 一键沙箱自检'}
          </button>
        </div>
      </div>

      {/* ── 阻断级告警：配置自相矛盾 / 强制闸门缺失 ── */}
      {(errors.length > 0 || mandatoryMissing.length > 0) && (
        <div className="rc-alert">
          <b>⛔ 风控配置存在阻断问题</b>
          {errors.map((e, i) => (
            <span key={`e${i}`}>· {e}</span>
          ))}
          {mandatoryMissing.map((i) => (
            <span key={i.id}>· 强制拦截器「{i.name}」处于停用状态 —— Fail-Closed 地板被破坏，管线将拒绝一切开仓</span>
          ))}
        </div>
      )}

      {/* ── ① 风险哲学：预设套件 ── */}
      <div className="rc-section-label">
        风险哲学 · 预设套件
        <span className="rc-hint">一键切换整套参数组合。手工改过任意参数后，「当前」标记会消失——这是刻意的，防止误以为仍在套件保护下。</span>
      </div>
      <div className="rc-suites">
        {suites.map((su) => {
          const tone = SUITE_TONE[su.id] ?? SUITE_TONE.balanced
          return (
            <div
              key={su.id}
              className={`rc-suite ${su.active ? 'active' : ''}`}
              style={{ borderColor: su.active ? tone.border : undefined, background: su.active ? tone.bg : undefined }}
            >
              <div className="rc-suite-head">
                <span className="rc-suite-name" style={{ color: tone.text }}>{su.name}</span>
                {su.active && <span className="rc-suite-active">当前生效</span>}
              </div>
              <div className="rc-suite-tag">{su.tagline}</div>
              <div className="rc-suite-desc">{su.desc}</div>
              <button
                className="rc-btn"
                disabled={!online || !!busy || su.active}
                onClick={() => onApplySuite(su)}
                style={su.active ? undefined : { borderColor: tone.border, color: tone.text }}
              >
                {su.active ? '使用中' : busy === `suite:${su.id}` ? '应用中…' : '应用这套'}
              </button>
            </div>
          )
        })}
      </div>

      {/* ── 分区切换 ── */}
      <div className="rc-tabs">
        {(
          [
            ['params', '参数分组', dirtyKeys.length],
            ['interceptors', '拦截闸门', mandatoryMissing.length],
            ['lessons', '进化心法', 0],
            ['budget', '预算台账', 0],
            ['policy', '策略快照', 0],
          ] as [TabId, string, number][]
        ).map(([id, label, badge]) => (
          <button key={id} className={`rc-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
            {badge > 0 && <span className="rc-tab-badge">{badge}</span>}
          </button>
        ))}
      </div>

      {/* ── ② 参数分组 ── */}
      {tab === 'params' && (
        <div className="rc-params">
          <div className="rc-groups">
            {(schema?.groups ?? []).map((g) => {
              const set = new Set(dirtyKeys)
              const n = (schema?.params ?? []).filter((p) => p.group === g.id && set.has(p.key)).length
              return (
                <button
                  key={g.id}
                  className={`rc-group ${activeGroup === g.id ? 'active' : ''}`}
                  onClick={() => setActiveGroup(g.id)}
                >
                  <span className="rc-group-name">{g.label}</span>
                  {n > 0 && <span className="rc-group-badge">{n}</span>}
                </button>
              )
            })}
          </div>

          <div className="rc-group-body">
            {(schema?.groups ?? [])
              .filter((g) => g.id === activeGroup)
              .map((g) => (
                <div key={g.id} className="rc-group-head">
                  <span className="rc-group-title">{g.label}</span>
                  <span className="rc-group-desc">{g.desc}</span>
                </div>
              ))}

            <div className="rc-param-list">
              {groupParams.map((p) => {
                const val = draft[p.key] ?? p.default
                const changed = dirtyKeys.includes(p.key)
                const shown = Math.round((val * p.displayScale + Number.EPSILON) * 1000) / 1000
                return (
                  <div key={p.key} className={`rc-param ${changed ? 'changed' : ''}`}>
                    <div className="rc-param-head">
                      <span className="rc-param-label">
                        {p.label}
                        {changed && <i className="rc-param-dot" />}
                      </span>
                      <div className="rc-param-input">
                        <input
                          type="number"
                          value={shown}
                          min={p.min * p.displayScale}
                          max={p.max * p.displayScale}
                          step={p.step}
                          onChange={(ev) => {
                            const raw = Number(ev.target.value)
                            if (!Number.isFinite(raw)) return
                            const native = p.type === 'int' ? Math.trunc(raw / p.displayScale) : raw / p.displayScale
                            setDraft((d) => ({ ...d, [p.key]: native }))
                          }}
                        />
                        <span className="rc-param-unit">{p.unit}</span>
                      </div>
                    </div>
                    <input
                      className="rc-range"
                      type="range"
                      value={shown}
                      min={p.min * p.displayScale}
                      max={p.max * p.displayScale}
                      step={p.step}
                      onChange={(ev) => {
                        const raw = Number(ev.target.value)
                        const native = p.type === 'int' ? Math.trunc(raw / p.displayScale) : raw / p.displayScale
                        setDraft((d) => ({ ...d, [p.key]: native }))
                      }}
                    />
                    <div className="rc-param-meta">
                      <span className="rc-param-desc">{p.desc}</span>
                      <span className="rc-param-range">
                        区间 {p.min * p.displayScale} ~ {p.max * p.displayScale} {p.unit} · 默认 {p.default * p.displayScale}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={`rc-savebar ${dirtyKeys.length > 0 ? 'on' : ''}`}>
              <span className="rc-savebar-text">
                {dirtyKeys.length > 0
                  ? `本组 ${dirtyInGroup} 项、总计 ${dirtyKeys.length} 项改动未保存`
                  : '当前面板与引擎生效值完全一致'}
              </span>
              <button className="rc-btn" disabled={dirtyKeys.length === 0} onClick={() => setDraft({})}>
                放弃改动
              </button>
              <button className="rc-btn primary" data-ui="risk.params.save" disabled={dirtyKeys.length === 0 || !!busy} onClick={onSaveParams}>
                {busy === 'save' ? '写入中…' : `保存并生效（${dirtyKeys.length}）`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ③ 拦截闸门 ── */}
      {tab === 'interceptors' && (
        <div className="rc-body">
          <div className="rc-panel">
            <div className="rc-panel-head">
              <span className="rc-panel-title">拦截闸门管线</span>
              <div className="rc-panel-actions">
                <button
                  className="rc-btn"
                  disabled={!online || !!busy}
                  onClick={async () => {
                    setBusy('reset-it')
                    try {
                      await resetInterceptors(state.orchUrl, state.orchToken)
                      pushToast(dispatch, '拦截闸门已恢复官方默认顺序与启停状态')
                      await load()
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  恢复官方默认
                </button>
              </div>
            </div>
            <div className="rc-note">
              自上而下依次执行，**任一道拦住即降级为 WAIT**。标注「地板」的闸门不可停用——停掉它等于拆掉物理兜底。
            </div>
            <div className="rc-it-list">
              {interceptors.map((i, idx) => (
                <div key={i.id} className={`rc-it ${i.enabled ? '' : 'off'} ${i.mandatory ? 'mand' : ''}`}>
                  <div className="rc-it-order">{String(idx + 1).padStart(2, '0')}</div>
                  <div className="rc-it-main">
                    <div className="rc-it-head">
                      <span className="rc-it-name">{i.name}</span>
                      {i.mandatory && <span className="rc-it-tag mand">地板</span>}
                      {i.builtin && !i.mandatory && <span className="rc-it-tag">内置</span>}
                      {!i.enabled && <span className="rc-it-tag off">已停用</span>}
                      <span className="rc-it-id">{i.id}</span>
                    </div>
                    <div className="rc-it-desc">{i.desc}</div>
                  </div>
                  <div className="rc-it-ops">
                    <button className="rc-icon-btn" disabled={idx === 0 || !!busy} onClick={() => onMove(i, -1)} title="上移（更早执行）">
                      ▲
                    </button>
                    <button
                      className="rc-icon-btn"
                      disabled={idx === interceptors.length - 1 || !!busy}
                      onClick={() => onMove(i, 1)}
                      title="下移（更晚执行）"
                    >
                      ▼
                    </button>
                    <button
                      className={`rc-switch ${i.enabled ? 'on' : ''}`}
                      disabled={i.mandatory || !!busy}
                      onClick={() => onToggleInterceptor(i)}
                      title={i.mandatory ? '强制地板，不可停用' : i.enabled ? '点击停用' : '点击启用'}
                    >
                      <i />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rc-panel">
            <div className="rc-panel-head">
              <span className="rc-panel-title">沙箱自检结果</span>
              {sandbox && (
                <span className={`rc-sandbox-score ${sandbox.passed === sandbox.total ? 'ok' : 'bad'}`}>
                  {sandbox.passed}/{sandbox.total} 符合预期
                </span>
              )}
            </div>
            <div className="rc-note">
              用 8 个构造场景验证「该拦的拦住了、不该拦的放行了」。风控最危险的失效不是规则写错，而是**以为配了、其实没生效**。
            </div>
            {!sandbox && <div className="rc-empty">尚未运行自检。点击右上角「一键沙箱自检」开始。</div>}
            {sandbox && (
              <div className="rc-sb-list">
                {sandbox.results.map((r) => (
                  <div key={r.name} className={`rc-sb ${r.verdict === 'pass' ? 'ok' : 'bad'}`}>
                    <button
                      className="rc-sb-row"
                      onClick={() => setExpandedScenario(expandedScenario === r.name ? null : r.name)}
                    >
                      <span className="rc-sb-icon">{r.verdict === 'pass' ? '✓' : '✕'}</span>
                      <span className="rc-sb-name">{r.name}</span>
                      <span className="rc-sb-verdict">{r.verdict === 'pass' ? '通过' : verdictLabel(r.verdict)}</span>
                    </button>
                    {expandedScenario === r.name && (
                      <div className="rc-sb-detail">
                        <div className="rc-sb-line">
                          <b>预期</b> {r.expected} · <b>实际</b> {r.actual}
                        </div>
                        <div className="rc-sb-line">{r.reason}</div>
                        <div className="rc-sb-trail">
                          {r.trail.map((t) => (
                            <span key={t.id} className={`rc-sb-step ${t.passed ? 'ok' : 'bad'}`} title={t.reason ?? ''}>
                              {t.passed ? '✓' : '✕'} {t.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ④ 进化心法 ── */}
      {tab === 'lessons' && (
        <div className="rc-body">
          <div className="rc-panel">
            <div className="rc-panel-head">
              <span className="rc-panel-title">已入册心法</span>
              <div className="rc-panel-actions">
                <button
                  className="rc-btn"
                  disabled={!online || !!busy}
                  onClick={async () => {
                    setBusy('decay')
                    try {
                      const r = await decayLessons(state.orchUrl, state.orchToken)
                      pushToast(dispatch, `衰减巡检完成 · ${r.decayed} 条健康分下降、${r.archived} 条失效出册`)
                      await load()
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  衰减巡检
                </button>
                <button
                  className="rc-btn"
                  disabled={!online || !!busy}
                  onClick={async () => {
                    setBusy('reset-ls')
                    try {
                      await resetLessons(state.orchUrl, state.orchToken)
                      pushToast(dispatch, '心法库已恢复官方基线')
                      await load()
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  恢复基线
                </button>
              </div>
            </div>
            {lessonStat && (
              <div className="rc-stat-row">
                <Stat label="心法总数" value={String(lessonStat.total)} />
                <Stat label="生效中" value={String(lessonStat.active)} tone="ok" />
                <Stat label="被红线拦下" value={String(lessonStat.blocked)} tone={lessonStat.blocked > 0 ? 'warn' : undefined} />
                <Stat label="健康分衰减出册" value={String(lessonStat.decayed)} tone={lessonStat.decayed > 0 ? 'bad' : undefined} />
                <Stat label="平均健康分" value={String(lessonStat.avgHealth)} />
              </div>
            )}
            <div className="rc-note">
              心法有 TTL：长期未被复盘的条目健康分会衰减，跌破阈值自动出册。**遗忘是特性，不是缺陷**——一条永远有效的心法，在换市场之后就是一条错误的经验。
            </div>
            <div className="rc-ls-list">
              {lessons.length === 0 && <div className="rc-empty">心法库为空。</div>}
              {lessons.map((l) => (
                <div key={l.id} className={`rc-ls ${l.enabled ? '' : 'off'}`}>
                  <div className="rc-ls-main">
                    <div className="rc-ls-head">
                      <span className="rc-ls-cat">{LESSON_CATEGORY_LABEL[l.category] ?? l.category}</span>
                      {l.isBaseline && <span className="rc-it-tag">基线</span>}
                      {l.shieldStatus !== 'PASSED' && <span className="rc-it-tag off">{l.shieldStatus}</span>}
                      <span className="rc-ls-meta">
                        样本 {l.sampleSize} · TTL {l.ttlDays}天 · {new Date(l.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <div className="rc-ls-text">{l.ruleText}</div>
                    <div className="rc-health">
                      <div className="rc-health-bar">
                        <i style={{ width: `${Math.max(0, Math.min(100, l.healthScore))}%` }} />
                      </div>
                      <span className="rc-health-num">{l.healthScore.toFixed(1)}</span>
                    </div>
                  </div>
                  <button
                    className={`rc-switch ${l.enabled ? 'on' : ''}`}
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(`ls:${l.id}`)
                      try {
                        await toggleLesson(state.orchUrl, state.orchToken, l.id, !l.enabled)
                        await load()
                      } catch (e) {
                        pushToast(dispatch, e instanceof Error ? e.message : '操作失败')
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    <i />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rc-panel">
            <div className="rc-panel-head">
              <span className="rc-panel-title">提交新心法</span>
            </div>
            <div className="rc-note">
              新心法必须先过宪法红线 lint 才能入册：包含绝对化措辞、缺少样本量支撑的条目会被直接拒绝。**被拒的理由会原样返回**——它本身就是研究信号。
            </div>
            <div className="rc-form">
              <label className="rc-form-label">适用类别</label>
              <select className="rc-select" value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                {Object.entries(LESSON_CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>

              {/* ★ 样本量不再由这里填：它由服务端从审计账本现算（ORDER_FILL 计数）。
                  原先这个输入框直接把数字送进门禁，等于让提交者自己决定"这条经验有多少证据"——
                  写 9999 就能把单笔偶发登记成 9999 笔证据（见 DEV_PROGRESS §3.11 F-44）。 */}
              <label className="rc-form-label">样本量</label>
              <div className="rc-note">
                由服务端从审计账本现算（已成交 <code>ORDER_FILL</code> 计数）——<b>不接受手工填写</b>。
                成交观测不足 2 笔时，宪法红线会拒绝入册。
              </div>

              <label className="rc-form-label">证据备注（可选 · 只是给人看的文字，不是证据）</label>
              <input
                className="rc-input"
                type="text"
                placeholder="例：2026-09 连续三次插针后回踩的结构复盘"
                value={newEvidence}
                onChange={(e) => setNewEvidence(e.target.value)}
              />

              <label className="rc-form-label">心法正文</label>
              <textarea
                className="rc-textarea"
                rows={4}
                placeholder="例：当日线 ATR 高于 30 日均值 2 倍时，止损乘数取上限 2.2x 并禁止加仓。"
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
              />

              <button className="rc-btn primary" data-ui="risk.lesson.submit" disabled={!online || !!busy} onClick={onSubmitLesson}>
                {busy === 'lesson' ? '提交中…' : '提交并校验'}
              </button>

              {proposeVerdict && (
                <div className={`rc-verdict ${proposeVerdict.accepted ? 'ok' : 'bad'}`}>
                  <b>{proposeVerdict.accepted ? '✅ 已入册' : '⛔ 被宪法红线拒绝'}</b>
                  <span>{proposeVerdict.reason}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── ⑤ 预算台账：这个账户此刻已经承诺出去多少钱 ──
           在预留层之前，这个问题的答案只存在于「已成交 + 未成交挂单」里，
           而两者都不完整：一笔已发出但结果未知的订单既不占持仓也不在挂单中，
           却实实在在地消耗着组合层的风险容量。 */}
      {tab === 'budget' && <ReservationLedger base={state.orchUrl} token={state.orchToken} online={online} />}

      {/* ── ⑥ 策略快照：三天前那套跑得好的参数，到底长什么样 ── */}
      {tab === 'policy' && <PolicySnapshotPanel base={state.orchUrl} token={state.orchToken} online={online} />}

      <style>{css}</style>
    </div>
  )
}

/**
 * 把变更前后值拼成一句可读的摘要，例如「（如 单笔风险额占比 1 → 0.5）」。
 *
 * 只报「改了 N 项」是不够的：风控调参最需要确认的恰恰是**改成了什么**。
 * 但 toast 空间有限，所以只带前两项做抽样，完整明细在审计日志里。
 */
function sampleTransition(tr?: { key: string; from: number; to: number }[]): string {
  if (!tr || tr.length === 0) return ''
  const head = tr
    .slice(0, 2)
    .map((t) => `${t.key.replace(/^EV_/, '')} ${t.from}→${t.to}`)
    .join('、')
  return `（如 ${head}${tr.length > 2 ? ` 等 ${tr.length} 项` : ''}）`
}

function verdictLabel(v: SandboxResultView['verdict']): string {
  switch (v) {
    case 'unexpected_pass':
      return '该拦未拦'
    case 'unexpected_block':
      return '该放未放'
    case 'wrong_interceptor':
      return '拦错了闸'
    default:
      return v
  }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rc-stat">
      <label>{label}</label>
      <b className={tone ? `t-${tone}` : ''}>{value}</b>
    </div>
  )
}

const css = `
  .rc-page { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; overflow-y: auto; padding-right: 2px; }
  .rc-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
  .rc-top-left { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .rc-title { font-family: var(--font-ui); font-size: 18px; font-weight: 800; color: var(--text-main); }
  .rc-sub { font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); letter-spacing: 0.4px; }
  .rc-top-right { display: flex; align-items: center; gap: 10px; }
  .rc-sync { display: flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--text-weak); }
  .rc-sync .rc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-weak); }
  .rc-sync.on { color: var(--down); }
  .rc-sync.on .rc-dot { background: var(--down); box-shadow: 0 0 6px rgba(0,214,143,0.55); }

  .rc-btn {
    font-family: var(--font-ui); font-size: 11px; font-weight: 600;
    color: var(--text-sub); background: var(--bg-surface);
    border: 1px solid var(--border-strong); border-radius: 7px;
    padding: 5px 11px; cursor: pointer; white-space: nowrap; transition: all .14s;
  }
  .rc-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--text-weak); }
  .rc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .rc-btn.primary { color: var(--bg-base); background: var(--primary); border-color: var(--primary); }
  .rc-btn.primary:hover:not(:disabled) { filter: brightness(1.12); color: var(--bg-base); }

  .rc-alert {
    display: flex; flex-direction: column; gap: 3px; flex-shrink: 0;
    background: rgba(255,77,109,0.08); border-left: 3px solid var(--up);
    border-radius: 0 8px 8px 0; padding: 8px 11px;
  }
  .rc-alert b { font-family: var(--font-ui); font-size: 12px; color: var(--up); }
  .rc-alert span { font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--text-sub); }

  .rc-section-label {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; flex-shrink: 0;
    font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main);
  }
  .rc-hint { font-family: var(--font-ui); font-size: 10px; font-weight: 400; color: var(--text-weak); }

  .rc-suites { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; flex-shrink: 0; }
  .rc-suite {
    display: flex; flex-direction: column; gap: 5px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; transition: border-color .15s;
  }
  .rc-suite.active { box-shadow: 0 0 0 1px rgba(232,121,249,0.18); }
  .rc-suite-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .rc-suite-name { font-family: var(--font-ui); font-size: 13px; font-weight: 800; }
  .rc-suite-active {
    font-family: var(--font-mono); font-size: 9px; color: var(--down);
    border: 1px solid rgba(0,214,143,0.4); border-radius: 999px; padding: 0 6px;
  }
  .rc-suite-tag { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
  .rc-suite-desc { font-family: var(--font-ui); font-size: 10.5px; line-height: 1.7; color: var(--text-sub); flex: 1; }
  .rc-suite .rc-btn { align-self: flex-start; margin-top: 2px; }

  .rc-tabs { display: flex; gap: 6px; flex-shrink: 0; border-bottom: 1px solid var(--border); padding-bottom: 0; }
  .rc-tab {
    display: flex; align-items: center; gap: 5px;
    font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-weak);
    background: none; border: none; border-bottom: 2px solid transparent;
    padding: 6px 12px 7px; cursor: pointer; transition: color .14s;
  }
  .rc-tab:hover { color: var(--text-sub); }
  .rc-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
  .rc-tab-badge {
    font-family: var(--font-mono); font-size: 9px; font-weight: 700;
    color: var(--warning); background: rgba(255,176,32,0.14);
    border: 1px solid rgba(255,176,32,0.35); border-radius: 999px; padding: 0 5px;
  }

  .rc-params { display: grid; grid-template-columns: 190px 1fr; gap: 12px; flex: 1; min-height: 0; }
  .rc-groups { display: flex; flex-direction: column; gap: 4px; align-self: start; }
  .rc-group {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    font-family: var(--font-ui); font-size: 11.5px; font-weight: 600; text-align: left;
    color: var(--text-sub); background: var(--bg-surface);
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer;
    transition: all .14s;
  }
  .rc-group:hover { color: var(--text-main); border-color: var(--border-strong); }
  .rc-group.active { color: var(--text-main); border-color: var(--primary); background: var(--primary-10); }
  .rc-group-badge {
    font-family: var(--font-mono); font-size: 9px; font-weight: 700;
    color: var(--warning); background: rgba(255,176,32,0.14); border-radius: 999px; padding: 0 5px;
  }
  .rc-group-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .rc-group-head { display: flex; flex-direction: column; gap: 3px; }
  .rc-group-title { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
  .rc-group-desc { font-family: var(--font-ui); font-size: 10.5px; line-height: 1.6; color: var(--text-weak); }
  .rc-param-list { display: flex; flex-direction: column; gap: 8px; }
  .rc-param {
    display: flex; flex-direction: column; gap: 5px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 9px;
    padding: 9px 12px; transition: border-color .15s;
  }
  .rc-param.changed { border-color: rgba(255,176,32,0.45); background: rgba(255,176,32,0.035); }
  .rc-param-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .rc-param-label { display: flex; align-items: center; gap: 6px; font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
  .rc-param-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); flex-shrink: 0; }
  .rc-param-input { display: flex; align-items: center; gap: 5px; }
  .rc-param-input input {
    width: 88px; text-align: right; font-family: var(--font-mono); font-size: 12px; font-weight: 700;
    color: var(--text-main); background: var(--bg-base);
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 3px 7px;
  }
  .rc-param-input input:focus { outline: none; border-color: var(--primary); }
  .rc-param-unit { font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); min-width: 34px; }
  .rc-range { width: 100%; accent-color: var(--primary); cursor: pointer; height: 3px; }
  .rc-param-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .rc-param-desc { font-family: var(--font-ui); font-size: 10px; line-height: 1.6; color: var(--text-weak); flex: 1; }
  .rc-param-range { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); white-space: nowrap; opacity: 0.75; }

  .rc-savebar {
    position: sticky; bottom: 0; display: flex; align-items: center; gap: 9px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: 9px; padding: 8px 12px; margin-top: 2px;
  }
  .rc-savebar.on { border-color: rgba(255,176,32,0.45); }
  .rc-savebar-text { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }
  .rc-savebar.on .rc-savebar-text { color: var(--warning); }

  .rc-body { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
  .rc-panel {
    display: flex; flex-direction: column; gap: 8px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px;
  }
  .rc-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
  .rc-panel-title { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
  .rc-panel-actions { display: flex; gap: 6px; }
  .rc-note { font-family: var(--font-ui); font-size: 10px; line-height: 1.7; color: var(--text-weak); }
  .rc-empty { text-align: center; font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); padding: 16px 0; }

  .rc-it-list { display: flex; flex-direction: column; gap: 5px; }
  .rc-it {
    display: flex; align-items: center; gap: 9px;
    background: var(--bg-surface); border: 1px solid var(--border);
    border-left-width: 2px; border-radius: 0 8px 8px 0; padding: 7px 10px;
  }
  .rc-it.mand { border-left-color: var(--warning); }
  .rc-it:not(.mand) { border-left-color: var(--primary-40); }
  .rc-it.off { opacity: 0.5; }
  .rc-it-order { font-family: var(--font-mono); font-size: 12px; font-weight: 800; color: var(--text-weak); flex-shrink: 0; }
  .rc-it-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .rc-it-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .rc-it-name { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); }
  .rc-it-tag {
    font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.3px;
    color: var(--text-weak); border: 1px solid var(--border-strong); border-radius: 4px; padding: 0 5px;
  }
  .rc-it-tag.mand { color: var(--warning); border-color: rgba(255,176,32,0.45); }
  .rc-it-tag.off { color: var(--up); border-color: rgba(255,77,109,0.4); }
  .rc-it-id { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); opacity: 0.65; margin-left: auto; }
  .rc-it-desc { font-family: var(--font-ui); font-size: 10px; line-height: 1.6; color: var(--text-weak); }
  .rc-it-ops { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .rc-icon-btn {
    width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
    font-size: 8px; color: var(--text-weak); background: var(--bg-card);
    border: 1px solid var(--border); border-radius: 5px; cursor: pointer;
  }
  .rc-icon-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--border-strong); }
  .rc-icon-btn:disabled { opacity: 0.28; cursor: not-allowed; }

  .rc-switch {
    width: 32px; height: 17px; border-radius: 999px; flex-shrink: 0;
    background: var(--bg-base); border: 1px solid var(--border-strong);
    position: relative; cursor: pointer; padding: 0; transition: all .16s;
  }
  .rc-switch i {
    position: absolute; top: 1.5px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--text-weak); transition: all .16s;
  }
  .rc-switch.on { background: rgba(0,214,143,0.2); border-color: var(--down); }
  .rc-switch.on i { left: 16px; background: var(--down); }
  .rc-switch:disabled { opacity: 0.45; cursor: not-allowed; }

  .rc-sandbox-score { font-family: var(--font-mono); font-size: 11px; font-weight: 700; }
  .rc-sandbox-score.ok { color: var(--down); }
  .rc-sandbox-score.bad { color: var(--up); }
  .rc-sb-list { display: flex; flex-direction: column; gap: 4px; }
  .rc-sb { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-surface); }
  .rc-sb.ok { border-left: 2px solid var(--down); }
  .rc-sb.bad { border-left: 2px solid var(--up); }
  .rc-sb-row {
    width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
    background: none; border: none; padding: 7px 10px; cursor: pointer;
  }
  .rc-sb-icon { font-size: 10px; flex-shrink: 0; }
  .rc-sb.ok .rc-sb-icon { color: var(--down); }
  .rc-sb.bad .rc-sb-icon { color: var(--up); }
  .rc-sb-name { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-main); }
  .rc-sb-verdict { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); flex-shrink: 0; }
  .rc-sb.bad .rc-sb-verdict { color: var(--up); }
  .rc-sb-detail { padding: 0 10px 9px 28px; display: flex; flex-direction: column; gap: 5px; }
  .rc-sb-line { font-family: var(--font-ui); font-size: 10px; line-height: 1.6; color: var(--text-sub); }
  .rc-sb-line b { color: var(--text-main); font-weight: 700; }
  .rc-sb-trail { display: flex; flex-wrap: wrap; gap: 4px; }
  .rc-sb-step {
    font-family: var(--font-ui); font-size: 9px; border-radius: 4px; padding: 1px 6px;
    border: 1px solid var(--border-strong); color: var(--text-weak);
  }
  .rc-sb-step.ok { border-color: rgba(0,214,143,0.35); color: var(--down); }
  .rc-sb-step.bad { border-color: rgba(255,77,109,0.4); color: var(--up); }

  .rc-stat-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .rc-stat {
    display: flex; flex-direction: column; gap: 2px; min-width: 78px;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px;
  }
  .rc-stat label { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
  .rc-stat b { font-family: var(--font-mono); font-size: 15px; font-weight: 800; color: var(--text-main); }
  .rc-stat b.t-ok { color: var(--down); }
  .rc-stat b.t-warn { color: var(--warning); }
  .rc-stat b.t-bad { color: var(--up); }

  .rc-ls-list { display: flex; flex-direction: column; gap: 5px; max-height: 340px; overflow-y: auto; }
  .rc-ls {
    display: flex; align-items: center; gap: 10px;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px;
    border-left-width: 2px; border-left-color: var(--primary-40); padding: 8px 10px;
  }
  .rc-ls.off { opacity: 0.5; border-left-color: var(--text-weak); }
  .rc-ls-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .rc-ls-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .rc-ls-cat {
    font-family: var(--font-ui); font-size: 9px; font-weight: 700; color: var(--primary);
    border: 1px solid var(--primary-40); border-radius: 4px; padding: 0 5px;
  }
  .rc-ls-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
  .rc-ls-text { font-family: var(--font-ui); font-size: 11.5px; line-height: 1.65; color: var(--text-main); }
  .rc-health { display: flex; align-items: center; gap: 7px; }
  .rc-health-bar { flex: 1; height: 3px; background: var(--bg-base); border-radius: 999px; overflow: hidden; max-width: 160px; }
  .rc-health-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--up), var(--warning), var(--down)); border-radius: 999px; }
  .rc-health-num { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }

  .rc-form { display: flex; flex-direction: column; gap: 6px; }
  .rc-form-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
  .rc-select, .rc-input, .rc-textarea {
    font-family: var(--font-ui); font-size: 11.5px; color: var(--text-main);
    background: var(--bg-base); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 6px 9px; width: 100%;
  }
  .rc-textarea { resize: vertical; font-family: var(--font-cn); line-height: 1.65; }
  .rc-select:focus, .rc-input:focus, .rc-textarea:focus { outline: none; border-color: var(--primary); }
  .rc-form .rc-btn { align-self: flex-start; margin-top: 3px; }
  .rc-verdict {
    display: flex; flex-direction: column; gap: 3px;
    border-radius: 0 8px 8px 0; padding: 7px 10px; margin-top: 3px;
  }
  .rc-verdict.ok { background: rgba(0,214,143,0.08); border-left: 2px solid var(--down); }
  .rc-verdict.bad { background: rgba(255,77,109,0.08); border-left: 2px solid var(--up); }
  .rc-verdict b { font-family: var(--font-ui); font-size: 11px; }
  .rc-verdict.ok b { color: var(--down); }
  .rc-verdict.bad b { color: var(--up); }
  .rc-verdict span { font-family: var(--font-ui); font-size: 10.5px; line-height: 1.65; color: var(--text-sub); }
`
