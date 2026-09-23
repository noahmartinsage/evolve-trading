/**
 * 因子工厂 —— 把**因子生产线**的两层台账摆到台面上。
 *
 * ══ 为什么必须有这一页 ═══════════════════════════════════════════════════
 * 在它之前，"因子批量生产"这件事在生产上是**不可见的**：
 * 台账安静地躺在 `data/factors/*.json` 里长，`accepted` 那一行不会做任何事，
 * 而屏幕上唯一提到"因子"的表（`FactorTable.tsx`）是**策略表现表**，
 * 喂它的是演示数据。于是用户看到的是一个和真实产线毫无关系的数字。
 *
 * ══ 这一页要回答的三个问题（顺序即重要性）═══════════════════════════════
 *   ① **现在有没有因子能拿去交易？** —— 顶部那行大字。不是"有几个 accepted"，
 *      因为 accepted 只说明"信号有预测力"，跟"扣掉成本还赚钱"是两件事。
 *   ② **没通过的话，是信号没用还是被成本吃掉？** —— 这两者的下一步动作**相反**：
 *      前者回去换因子，后者回去降换手。所以毛收益与净收益必须并排显示；
 *      只显示一个数字时，两种局面长得一模一样。
 *   ③ **这些结论是什么时候、在哪份行情上做出的？** —— 每行都带指纹与时效。
 *      行情换版（拉长历史、换币种）会让**所有**旧判决同时作废，
 *      而它们在台账上看起来毫无异常（判据 11：读路径静默陈旧）。
 *
 * ══ 一条刻意的设计：拒绝理由原样显示 ═════════════════════════════════
 * 服务端给的 `reason` 是给人读的完整句子，前端**不加工、不缩写**。
 * 翻译过的拒绝理由会离事实越来越远，而拒绝理由是这套系统里
 * 唯一会被人读到的输出 —— 它决定下一步去改哪一头。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { pushToast, useStore } from '../store/Store'
import { getBreadthIndex, getFactorIndex, getFactorStrategies } from '../orch/client.ts'
// ★ 成本拖累那一列的**名字与读法**由引擎提供，不在面板里手写：
//   它是"各折均值"，而左边两列是"各自的最小值"（可能来自不同的折）⇒ 三列不可相减。
//   名字写在 JSX 里就会被人顺手缩写成"成本拖累"，而 `test:factors` 的 F15 钉不住它。
import {
  COST_DRAG_LABEL,
  COST_DRAG_NOTE,
  COST_PER_FILL_LABEL,
  EDGE_PER_FILL_LABEL,
  PER_FILL_NOTE,
} from '../engine/factorStrategy.ts'
import type {
  BreadthResponse,
  BreadthRowView,
  FactorIndexResponse,
  FactorIndexRowView,
  FactorStrategyResponse,
  FactorStrategyRowView,
} from '../orch/client.ts'

/** 比例（0..1）→ 百分数。`winRate` 是这一档，别拿它当百分数用。 */
const pct01 = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? 'n/a' : (v * 100).toFixed(d) + '%')
/** 原值已经是百分数（字段名里带 Pct 的那些）。 */
const pctRaw = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? 'n/a' : v.toFixed(d) + '%')
const dec = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? 'n/a' : v.toFixed(d))
const shortHash = (h: string) => (h ? h.slice(0, 12) + '…' : 'n/a')

const STATE_LABEL: Record<string, string> = { accepted: '通过', rejected: '拒绝', unverifiable: '证据不足' }
const STATE_CLASS: Record<string, string> = { accepted: 'chip chip-green', rejected: 'chip chip-red', unverifiable: 'chip chip-amber' }

function StateChip({ state }: { state: string }) {
  return <span className={STATE_CLASS[state] ?? 'chip chip-gray'}>{STATE_LABEL[state] ?? state}</span>
}

/** 正负用颜色的地方一律按涨红跌绿（A 股口径）。收益为正是"赚"，用绿。 */
const signClass = (v: number | null | undefined) => (v === null || v === undefined ? '' : v > 0 ? 'down' : v < 0 ? 'up' : '')

export default function FactorsPage() {
  const { state, dispatch } = useStore()
  const [factor, setFactor] = useState<FactorIndexResponse | null>(null)
  const [strat, setStrat] = useState<FactorStrategyResponse | null>(null)
  const [breadth, setBreadth] = useState<BreadthResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | 'accepted' | 'rejected' | 'unverifiable'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)

  const load = useCallback(
    async (loud: boolean) => {
      if (loud) setBusy(true)
      try {
        const [f, s, b] = await Promise.all([
          getFactorIndex(state.orchUrl, state.orchToken),
          getFactorStrategies(state.orchUrl, state.orchToken),
          getBreadthIndex(state.orchUrl, state.orchToken),
        ])
        setFactor(f)
        setStrat(s)
        setBreadth(b)
        setErr(null)
        if (loud) pushToast(dispatch, `🧪 台账已刷新 · 因子 ${f.summary.total} 条 · 可交易策略 ${s.summary.usableNow} 条`)
      } catch (e) {
        // 连不上时**保留上一份数据**并如实说出错误 —— 清空表格会让人以为台账是空的。
        setErr(e instanceof Error ? e.message : String(e))
        if (loud) pushToast(dispatch, `❌ 台账读取失败：${e instanceof Error ? e.message : e}`)
      } finally {
        if (loud) setBusy(false)
      }
    },
    [state.orchUrl, state.orchToken, dispatch],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => void load(false), 12_000)
    return () => clearInterval(t)
  }, [auto, load])

  // 台账行本身是稳定引用（只在 setState 时换），所以按 `factor`/`strat` 记忆；
  // 不记忆的话下游几个 useMemo 的依赖每次渲染都变，等于没记忆。
  const rows = useMemo(() => factor?.index.rows ?? [], [factor])
  const sRows = useMemo(() => strat?.index.rows ?? [], [strat])
  const flagged = useMemo(() => new Set(factor?.inconsistentSlugs ?? []), [factor])
  const curHash = factor?.currentDataHash ?? ''

  // ── 横截面层：按**持有期**分组 ────────────────────────────────────
  // ★ 分组的理由不是排版：这个数量级差**随持有期强烈变化**
  //   （实测 1 小时差 40 倍、24 小时反超、48 小时差 0.5 倍）。
  //   混在一张表里看，会把"周期选错了"读成"因子不行" —— 两者下一步动作相反（判据 25）。
  const breadthByHorizon = useMemo(() => {
    const m = new Map<number, BreadthRowView[]>()
    for (const r of breadth?.index.rows ?? []) {
      const arr = m.get(r.horizon) ?? []
      arr.push(r)
      m.set(r.horizon, arr)
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [breadth])

  // ── 归因统计：被"盈利门"拒绝的那些，到底是方向不成立，还是每笔不够付手续费 ──
  // ★ 15 轮改过一次判据，这里必须跟着改，否则面板会与拒绝理由**说两套话**。
  //   旧版按 `worstFoldGrossReturnPct > 0` 分流；实测同批数据下它判 1/14 条"成本问题"，
  //   而按**每笔口径**判是 11/14。原因：单折毛收益 σ=13.33%、均值仅 +4.41%
  //   ⇒ 最差折的毛收益天然为负，拿它比 0 会把真有边际的策略全判成"方向不成立"。
  const attribution = useMemo(() => {
    const byReturnGate = sRows.filter((r) => r.gate === 'return')
    // 只有"每笔口径建得起来"的行才谈得上归因；建不起来的单列一档说出来。
    const judgeable = byReturnGate.filter(
      (r) => r.meanGrossBpsPerFill !== null && r.meanCostBpsPerFill !== null,
    )
    const notJudgeable = byReturnGate.filter(
      (r) => r.meanGrossBpsPerFill === null || r.meanCostBpsPerFill === null,
    )
    const costDriven = judgeable.filter(
      (r) => (r.meanGrossBpsPerFill as number) > 0 && (r.meanGrossBpsPerFill as number) < (r.meanCostBpsPerFill as number),
    )
    const signalDriven = judgeable.filter((r) => (r.meanGrossBpsPerFill as number) <= 0)
    const ratios = costDriven
      .map((r) => (r.meanCostBpsPerFill as number) / (r.meanGrossBpsPerFill as number))
      .sort((a, b) => a - b)
    return {
      total: byReturnGate.length,
      costDriven,
      signalDriven,
      notJudgeable,
      medianRatio: ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : null,
    }
  }, [sRows])

  const byGate = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      if (r.state === 'accepted') continue
      m.set(r.gate, (m.get(r.gate) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const shown = filter === 'all' ? rows : rows.filter((r) => r.state === filter)

  const disconnect = err !== null && factor === null

  return (
    <div className="content-area fps">
      <div className="fp-head">
        <div className="fp-title-wrap">
          <span className="panel-title">因子工厂 · 生产台账</span>
          <span className="fp-sub">
            三层台账：<b>因子层</b>问「这个信号有没有预测力」，<b>策略层</b>问「扣掉成本还赚不赚钱」，
            <b>横截面层</b>问「换到一批标的上排序，每腿毛边际盖不盖得住一次单边成本」。
            三层分开是刻意的 —— 合成一个数字就再也分不清「信号没用」「被成本吃掉」和「根本没换过标的」。
          </span>
        </div>
        <div className="fp-head-actions">
          <button className="btn btn-sm" data-ui="factors.auto.toggle" onClick={() => setAuto((v) => !v)}>
            {auto ? '⏸ 停止自动刷新' : '▶ 每 12s 自动刷新'}
          </button>
          <button className="btn btn-sm btn-primary" data-ui="factors.refresh" disabled={busy} onClick={() => void load(true)}>
            {busy ? '读取中…' : '↻ 刷新台账'}
          </button>
        </div>
      </div>

      {err && (
        <div className="fp-alert fp-alert-red">
          读取失败：{err}
          {disconnect && <span> —— 编排服务可能没起（当前 {state.orchUrl}）。修好之后点「刷新台账」。</span>}
          {!disconnect && <span> —— 下面显示的是<b>上一次成功读到</b>的数据，不是空台账。</span>}
        </div>
      )}

      {/* ⓪ 第三层：横截面。前两层量出来的「每腿毛 vs 每腿成本」差 12~40 倍，
          而横截面是唯一还没被真正跑过的那条路（多空对冲消掉市场方向、每个时刻 N 个样本）。 */}
      <div className="fp-breadth">
        <div className="fp-breadth-head">
          <span className="panel-title">横截面（breadth）· 第三层</span>
          <span className="fp-sub">{breadth?.summary.reason ?? '正在读取…'}</span>
        </div>

        {breadth?.damaged && <div className="fp-alert fp-alert-red">横截面台账损坏：{breadth.damaged}</div>}

        {breadth?.index.panel && (
          <div className="fp-breadth-panel">
            面板 <b>{breadth.index.panel.symbols.length}</b> 个品种 × <b>{breadth.index.panel.bars}</b> 根共同 bar
            {breadth.index.panel.symbols.length > 0 && (
              <span className="fp-breadth-dim"> （{breadth.index.panel.symbols.join('、')}）</span>
            )}
            {breadth.index.panel.missing.length > 0 && (
              <span className="fp-breadth-warn"> · 被请求但没找到：{breadth.index.panel.missing.join('、')}</span>
            )}
          </div>
        )}

        {breadthByHorizon.length === 0 ? (
          <div className="fp-verdict">
            <div className="fp-verdict-main">还没有横截面结论</div>
            <div className="fp-verdict-note">
              前两层已经量出来的差距是「每腿毛边际只有零点几 bps vs 每腿成本好几 bps」。
              这个数量级差补不上，不是因为阈值太严 —— 而是因为**在单标的上做择时，
              每个时刻只有 1 个样本**。
            </div>
            <div className="fp-verdict-cmd">
              跑一次：<code>npm run breadth:run</code>
              <span className="fp-cmd-why">
                （读 data/history 下的多品种真实历史 → 对齐成面板 → 横截面多空回测 → 落盘。
                它**刻意不进 CI**：它会写生产台账，门禁里跑它等于每跑一次 CI 就改一次台账。）
              </span>
            </div>
          </div>
        ) : (
          <table className="fp-breadth-table">
            <thead>
              <tr>
                <th>持有期</th>
                <th>通过</th>
                <th>证据不足</th>
                <th>最好的毛/腿</th>
                <th>最低的成本/腿</th>
                <th>毛 ≥ 成本</th>
              </tr>
            </thead>
            <tbody>
              {breadthByHorizon.map(([h, rows]) => {
                const acc = rows.filter((r) => r.outcome === 'accepted').length
                const un = rows.filter((r) => r.outcome === 'unverifiable').length
                const withGross = rows.filter((r) => r.grossBpsPerLeg !== null)
                // ★ null 不参与 Math.max，也不退化成 0：没跑出轮次是"没测"，不是"测出来是 0"。
                const bestGross = withGross.length > 0 ? Math.max(...withGross.map((r) => r.grossBpsPerLeg as number)) : null
                const minCost = rows.length > 0 ? Math.min(...rows.map((r) => r.costBpsPerLeg)) : null
                const cover = rows.filter((r) => r.grossBpsPerLeg !== null && (r.grossBpsPerLeg as number) >= r.costBpsPerLeg).length
                const label = h * 15 >= 1440 ? `${(h * 15) / 1440} 天` : `${(h * 15) / 60} 小时`
                return (
                  <tr key={h} className={cover > 0 ? 'fp-breadth-cover' : ''}>
                    <td>{label}</td>
                    <td>{acc}</td>
                    <td>{un}</td>
                    <td>{bestGross === null ? 'n/a' : bestGross.toFixed(2)}</td>
                    <td>{minCost === null ? 'n/a' : minCost.toFixed(2)}</td>
                    <td>{cover}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ① 最重要的一行：现在到底有没有能拿去交易的东西 */}
      <div className={`fp-verdict ${strat?.summary.usableNow ? 'ok' : 'blocked'}`}>
        {!strat?.summary.available ? (
          <>
            <div className="fp-verdict-main">策略层还没有结论</div>
            <div className="fp-verdict-note">{strat?.summary.reason ?? '正在读取…'}</div>
            <div className="fp-verdict-cmd">
              跑一次：<code>npm run factors:screen</code>
              <span className="fp-cmd-why">
                （这一步才会把「因子台账里 accepted 的行」送进策略门。没跑过它，`data/factors/strategies.json` 就不存在，
                消费侧每轮读到一个空台账 —— 静默产出 0 个策略。）
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="fp-verdict-main">
              {factor?.summary.accepted ?? 0} 个已接受因子 → <b>{strat.summary.usableNow}</b> 条可用于交易
            </div>
            <div className="fp-verdict-note">
              {strat.summary.reason}
              {strat.summary.stale > 0 && (
                <span className="fp-stale-inline">
                  ；另有 {strat.summary.stale} 条筛查结论的行情指纹已变（过时），重跑 <code>npm run factors:screen</code> 才能更新
                </span>
              )}
            </div>
            {attribution.total > 0 && (
              <div className="fp-verdict-note">
                被盈利门拒的 {attribution.total} 条里（按 <b>每笔口径</b>归因，不是按"最差折"）：
                <b className="fp-attr-signal">{attribution.signalDriven.length} 条每笔毛边际 ≤ 0</b>
                （连不扣费都守不住 ⇒ 方向本身不成立）；
                <b className="fp-attr-cost">{attribution.costDriven.length} 条每笔毛边际为正但小于每笔成本</b>
                （方向是有的，只是每笔赚的不够付一次手续费 ⇒ 该降成本，不是换因子族）
                {attribution.medianRatio !== null && <>，后者成本/边际中位数 {attribution.medianRatio.toFixed(1)} 倍</>}
                {attribution.notJudgeable.length > 0 && <>；另有 {attribution.notJudgeable.length} 条连每笔口径都建不起来（无成交），单列不归因</>}
              </div>
            )}
          </>
        )}
      </div>

      {/* ② 陈旧判决必须说出来 —— 它长得和正常判决一模一样 */}
      {factor && factor.summary.inconsistent > 0 && (
        <div className="fp-alert fp-alert-red">
          <b>⚠️ 台账里有 {factor.summary.inconsistent} 条陈旧判决</b>
          （判决与它自己记下的指标自相矛盾，是判定器升级前写入的）：
          {factor.summary.inconsistentReason}
          <div className="fp-alert-fix">
            修法：<code>npm run factors:run</code>（默认会重判这些行）。在这之前，面板与语音读到的都是旧结论。
          </div>
        </div>
      )}
      {factor?.summary.available && factor.summary.historyShare < 1 && (
        <div className="fp-alert fp-alert-amber">
          <b>台账里只有 {(factor.summary.historyShare * 100).toFixed(0)}% 的行是在真实历史上判决的。</b>
          非真实数据上的结论一律不得判「通过」（fail-closed 不变量）—— 换句话说，合成数据上跑出来的
          「accepted」是不存在的，这一栏低不等于产线坏了，只等于历史数据集还没铺满。
        </div>
      )}

      {/* ③ 事实摘要 */}
      <div className="fp-stats">
        {[
          { label: '台账条数', value: String(factor?.summary.total ?? '—'), meta: '因子层累计立案' },
          { label: '因子层通过', value: String(factor?.summary.accepted ?? '—'), meta: '只说明有预测力' },
          { label: '策略层可用', value: String(strat?.summary.usableNow ?? '—'), meta: '扣费后仍为正' },
          { label: '证据不足', value: String(factor?.summary.unverifiable ?? '—'), meta: '缺失即不放行' },
          { label: '陈旧判决', value: String(factor?.summary.inconsistent ?? '—'), meta: '需重判' },
          { label: '真实史占比', value: factor ? `${(factor.summary.historyShare * 100).toFixed(0)}%` : '—', meta: '判决的数据来源' },
        ].map((s, i) => (
          <div className="fp-stat" key={i}>
            <span className="fp-stat-label">{s.label}</span>
            <span className="fp-stat-value">{s.value}</span>
            <span className="fp-stat-meta">{s.meta}</span>
          </div>
        ))}
      </div>

      {/* ── 策略层：能不能拿去交易 ─────────────────────────────────────── */}
      <div className="fp-card">
        <div className="fp-card-head">
          <span className="panel-title">策略层 · 逐折样本外（扣手续费与滑点）</span>
          <span className="fp-hint">
            {EDGE_PER_FILL_LABEL} / {COST_PER_FILL_LABEL} 两列是唯一的归因判据：前者 ≤ 0 才是方向不成立，
            前者为正但小于后者 ⇒ 每笔赚的不够付一次手续费（该降成本）。{PER_FILL_NOTE}
            <br />
            毛最差折 / 毛平均折 必须并列看 —— 单折毛收益 σ≈13% 而均值只有几个百分点，
            所以"最差折"天然为负，拿它当判据会把真有边际的策略全判成方向不成立。
            毛最差折 / 净最差折 / {COST_DRAG_LABEL} 三列一起读：{COST_DRAG_NOTE}
          </span>
        </div>
        {sRows.length === 0 ? (
          <div className="fp-empty">
            策略台账是空的。<code>npm run factors:screen</code> 会对因子台账里所有 accepted 因子跑一遍
            5 折样本外回测，把结论写进 <code>data/factors/strategies.json</code>。
          </div>
        ) : (
          <div className="fp-scroll">
            <table className="tbl fp-tbl">
              <thead>
                <tr>
                  <th>因子</th>
                  <th>方向</th>
                  <th className="num">训练 IC</th>
                  <th className="num">毛最差折</th>
                  <th className="num">毛平均折</th>
                  <th className="num">净最差折</th>
                  <th className="num">{COST_DRAG_LABEL}</th>
                  <th className="num">{EDGE_PER_FILL_LABEL}</th>
                  <th className="num">{COST_PER_FILL_LABEL}</th>
                  <th className="num">胜率</th>
                  <th className="num">平仓笔数</th>
                  <th>时效</th>
                  <th>归因</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                {sRows.map((r: FactorStrategyRowView) => {
                  const id = 's:' + r.slug
                  const gross = r.worstFoldGrossReturnPct
                  const gpf = r.meanGrossBpsPerFill
                  const cpf = r.meanCostBpsPerFill
                  // 归因只用每笔口径。无成交（gpf/cpf 为 null）时不给归因 —— 那是"没有证据"。
                  const attr =
                    r.gate !== 'return' || gpf === null || cpf === null
                      ? null
                      : gpf <= 0
                        ? 'signal'
                        : gpf < cpf
                          ? 'cost'
                          : 'inconsistent'
                  return (
                    <React.Fragment key={id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === id ? null : id)}>
                        <td className="strong">{r.slug}</td>
                        <td>{r.sign === 1 ? '正向' : r.sign === -1 ? '反向' : 'n/a'}</td>
                        <td className="num">{dec(r.trainIc)}</td>
                        <td className={`num ${signClass(gross)}`}>{pctRaw(gross)}</td>
                        <td className="num">{pctRaw(r.meanFoldGrossReturnPct)}</td>
                        <td className={`num ${signClass(r.worstFoldReturnPct)}`}>{pctRaw(r.worstFoldReturnPct)}</td>
                        <td className="num">{pctRaw(r.costDragPct, 1)}</td>
                        <td className={`num ${signClass(gpf)}`}>{dec(gpf, 2)}</td>
                        <td className="num">{dec(cpf, 2)}</td>
                        <td className="num">{pct01(r.winRate)}</td>
                        <td className="num">{r.closedTrades}</td>
                        <td>
                          {r.dataHashMatch ? (
                            <span className="chip chip-gray">有效</span>
                          ) : (
                            <span className="chip chip-red" title={`筛查时的行情 ${shortHash(r.screenDataHash)}，因子的行情 ${shortHash(r.factorDataHash)}`}>
                              过时
                            </span>
                          )}
                        </td>
                        <td>
                          {attr === null ? (
                            <span className="fp-dim">—</span>
                          ) : attr === 'signal' ? (
                            <span className="chip chip-red">方向不成立</span>
                          ) : attr === 'cost' ? (
                            <span className="chip chip-amber" title={`每笔毛边际 ${gpf} bps 只覆盖成本 ${cpf} bps 的一部分`}>
                              不够付手续费
                            </span>
                          ) : (
                            <span className="chip chip-gray" title="每笔边际覆盖了成本，净收益却为负 ⇒ 口径自相矛盾，该查算法">
                              口径矛盾
                            </span>
                          )}
                        </td>
                        <td>
                          <StateChip state={r.state} />
                        </td>
                      </tr>
                      {open === id && (
                        <tr>
                          <td colSpan={14} className="fp-detail">
                            <div className="fp-detail-row">
                              <span className="fp-detail-k">判定理由（原样来自服务端）</span>
                              <span className="fp-detail-v">{r.reason}</span>
                            </div>
                            <div className="fp-detail-grid">
                              <span>闸门 <b>{r.gate}</b></span>
                              <span>折数 <b>{r.folds}</b></span>
                              <span>每折成交笔数(均值) <b>{dec(r.meanFillsPerFold, 0)}</b></span>
                              <span>每笔毛边际 <b>{dec(r.meanGrossBpsPerFill, 2)} bps</b></span>
                              <span>每笔成本 <b>{dec(r.meanCostBpsPerFill, 2)} bps</b></span>
                              <span>方向一致率 <b>{pct01(r.signAgreement, 0)}</b></span>
                              <span>反向门质量已查 <b>{r.reverseChecked ? '是' : '否'}</b></span>
                              <span>两个方向都过 <b>{r.bothDirectionsPass ? '是（门失效）' : '否'}</b></span>
                              <span>判决时间 <b>{r.lastEvaluatedAt}</b></span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 因子层：台账本体 ──────────────────────────────────────────── */}
      <div className="fp-card">
        <div className="fp-card-head">
          <span className="panel-title">因子层 · 台账（判决 + 闸门归因）</span>
          <div className="fp-filters">
            {(['all', 'accepted', 'rejected', 'unverifiable'] as const).map((k) => (
              <button key={k} className={`fp-chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
                {k === 'all' ? `全部 ${rows.length}` : `${STATE_LABEL[k]} ${rows.filter((r) => r.state === k).length}`}
              </button>
            ))}
          </div>
        </div>
        <div className="fp-gates">
          <span className="fp-dim">被拦下的按闸门分布：</span>
          {byGate.length === 0 ? (
            <span className="fp-dim">无</span>
          ) : (
            byGate.map(([g, n]) => (
              <span className="fp-gate" key={g}>
                {g} <b>{n}</b>
              </span>
            ))
          )}
        </div>
        {rows.length === 0 ? (
          <div className="fp-empty">
            因子台账是空的。<code>npm run factors:run</code> 会产一批候选并落盘 —— 生产线还没跑过。
          </div>
        ) : (
          <div className="fp-scroll">
            <table className="tbl fp-tbl">
              <thead>
                <tr>
                  <th>因子</th>
                  <th>机制 / 变换 / 窗口</th>
                  <th className="num">IC</th>
                  <th className="num">ICIR</th>
                  <th className="num">覆盖率</th>
                  <th className="num">换手</th>
                  <th>数据来源</th>
                  <th>指纹</th>
                  <th>结论</th>
                  <th>闸门</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r: FactorIndexRowView) => {
                  const id = 'f:' + r.slug
                  // 两种"过时"是不同的事，必须分开说：
                  //   · 指纹不符 —— 判决是在**另一份行情**上做出的；
                  //   · 自相矛盾 —— 指纹是对的，但结论由旧版判定器写入（指标解释不了它）。
                  const stale = curHash !== '' && r.dataHash !== curHash
                  const inconsistent = flagged.has(r.slug)
                  return (
                    <React.Fragment key={id}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === id ? null : id)}>
                        <td className="strong">
                          {r.slug}
                          {inconsistent && <span className="chip chip-red fp-badge">陈旧判决</span>}
                          {!inconsistent && stale && <span className="chip chip-amber fp-badge">过时</span>}
                        </td>
                        <td className="fp-dim">
                          {r.base} / {r.transform} / {r.window}
                        </td>
                        <td className="num">{dec(r.icMean5)}</td>
                        <td className="num">{r.icir === null ? 'n/a' : r.icir.toFixed(2)}</td>
                        <td className="num">{(r.coverage * 100).toFixed(0)}%</td>
                        <td className="num">{r.turnover === null ? 'n/a' : (r.turnover * 100).toFixed(0) + '%'}</td>
                        <td>
                          {r.origin === 'history' ? (
                            <span className="chip chip-cyan">真实历史</span>
                          ) : (
                            <span className="chip chip-amber">{r.origin}</span>
                          )}
                        </td>
                        <td className="fp-dim" title={r.dataHash}>
                          {shortHash(r.dataHash)}
                        </td>
                        <td>
                          <StateChip state={r.state} />
                        </td>
                        <td className="fp-dim">{r.gate}</td>
                      </tr>
                      {open === id && (
                        <tr>
                          <td colSpan={10} className="fp-detail">
                            <div className="fp-detail-row">
                              <span className="fp-detail-k">判定理由（原样来自服务端）</span>
                              <span className="fp-detail-v">{r.reason}</span>
                            </div>
                            {stale && (
                              <div className="fp-detail-row">
                                <span className="fp-detail-k">时效</span>
                                <span className="fp-detail-v">
                                  这一行的判决依据的行情指纹是 {shortHash(r.dataHash)}，当前行情是 {shortHash(curHash)} ——
                                  两者不同，<b>旧结论不再适用</b>。重跑 <code>npm run factors:run</code> 会重判它。
                                </span>
                              </div>
                            )}
                            <div className="fp-detail-grid">
                              <span>样本 <b>{r.bars} 根</b></span>
                              <span>首发 <b>{r.firstSeenAt}</b></span>
                              <span>末次判决 <b>{r.lastEvaluatedAt}</b></span>
                              <span>分位价差 <b>{r.quantileSpreadBps === null ? 'n/a' : r.quantileSpreadBps.toFixed(1) + ' bps'}</b></span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="fp-foot">
        三态：<b>通过</b>＝证据达标且方向稳定 · <b>拒绝</b>＝有证据说它不行 · <b>证据不足</b>＝缺证据，
        一律不放行（fail-closed）。<span className="fp-dim">「稳定负 IC 的因子可以取反使用」是真的，但取反不是免费后门：
        方向由样本内 IC 决定，样本外逐折还要过盈利、胜率、回撤三道门 —— 过不了就拒。</span>
      </div>

      <style>{`
        .fps { display: flex; flex-direction: column; gap: 10px; }
        .fp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
        .fp-title-wrap { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .fp-sub { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); line-height: 1.6; max-width: 880px; }
        .fp-sub b { color: var(--text-sub); font-weight: 600; }
        .fp-head-actions { display: flex; gap: 8px; flex-shrink: 0; }

        .fp-verdict {
          border-radius: 10px; padding: 12px 14px;
          display: flex; flex-direction: column; gap: 6px;
          border: 1px solid var(--border-strong); background: var(--bg-card);
        }
        .fp-verdict.ok { border-color: rgba(0,214,143,0.4); background: linear-gradient(135deg, rgba(0,214,143,0.08), transparent 60%); }
        .fp-verdict.blocked { border-color: rgba(255,176,32,0.4); background: linear-gradient(135deg, rgba(255,176,32,0.08), transparent 60%); }
        .fp-verdict-main { font-family: var(--font-ui); font-size: 17px; font-weight: 700; color: var(--text-main); }
        .fp-verdict-main b { color: var(--primary); font-family: var(--font-mono); font-size: 20px; }
        .fp-verdict-note { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-sub); line-height: 1.7; }

        .fp-breadth {
          border-radius: 10px; padding: 12px 14px;
          display: flex; flex-direction: column; gap: 8px;
          border: 1px solid var(--border-strong); background: var(--bg-card);
        }
        .fp-breadth-head { display: flex; flex-direction: column; gap: 4px; }
        .fp-breadth-panel { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-sub); line-height: 1.6; }
        .fp-breadth-panel b { color: var(--primary); font-family: var(--font-mono); }
        .fp-breadth-dim { color: var(--text-weak); }
        .fp-breadth-warn { color: rgb(255,176,32); }
        .fp-breadth-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px; }
        .fp-breadth-table th {
          text-align: left; padding: 6px 8px; font-family: var(--font-ui); font-size: 10.5px;
          font-weight: 600; color: var(--text-weak); border-bottom: 1px solid var(--border-strong);
          white-space: nowrap;
        }
        .fp-breadth-table td { padding: 6px 8px; color: var(--text-sub); border-bottom: 1px solid var(--border); }
        .fp-breadth-cover td { color: rgb(0,214,143); }
        .fp-breadth-cover td:last-child { font-weight: 700; }
        .fp-verdict-cmd { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-sub); }
        .fp-cmd-why { color: var(--text-weak); }
        .fp-stale-inline { color: var(--warning); }
        .fp-attr-signal { color: var(--up); }
        .fp-attr-cost { color: var(--warning); }

        .fp-alert { border-radius: 8px; padding: 9px 12px; font-family: var(--font-ui); font-size: 11.5px; line-height: 1.7; }
        .fp-alert-red { background: rgba(255,77,109,0.08); border: 1px solid rgba(255,77,109,0.32); color: var(--text-sub); }
        .fp-alert-red b { color: var(--up); }
        .fp-alert-amber { background: rgba(255,176,32,0.07); border: 1px solid rgba(255,176,32,0.3); color: var(--text-sub); }
        .fp-alert-amber b { color: var(--warning); }
        .fp-alert-fix { margin-top: 4px; color: var(--text-weak); }

        .fp-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
        .fp-stat {
          background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
          padding: 9px 11px; display: flex; flex-direction: column; gap: 2px;
        }
        .fp-stat-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .fp-stat-value { font-family: var(--font-mono); font-size: 18px; font-weight: 600; color: var(--text-main); }
        .fp-stat-meta { font-family: var(--font-ui); font-size: 9.5px; color: var(--text-weak); }

        .fp-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
        .fp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .fp-hint { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .fp-scroll { max-height: 420px; overflow: auto; }
        .fp-tbl { font-size: 11px; }
        .fp-tbl thead th { position: sticky; top: 0; background: var(--bg-card); z-index: 1; }
        .fp-tbl td { white-space: nowrap; }
        .fp-tbl .fp-dim, .fp-dim { color: var(--text-weak); }
        .fp-badge { margin-left: 6px; font-size: 9px; height: 16px; line-height: 16px; padding: 0 5px; }
        .fp-detail { background: var(--bg-elevated) !important; white-space: normal !important; }
        .fp-detail-row { display: flex; gap: 10px; padding: 3px 0; font-size: 10.5px; line-height: 1.65; }
        .fp-detail-k { flex-shrink: 0; width: 150px; color: var(--text-weak); font-family: var(--font-ui); }
        .fp-detail-v { color: var(--text-sub); font-family: var(--font-ui); }
        .fp-detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 12px; margin-top: 6px; font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .fp-detail-grid b { color: var(--text-sub); font-family: var(--font-mono); }
        .fp-empty { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-weak); line-height: 1.7; padding: 10px 0; }
        .fp-gates { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--font-ui); font-size: 10.5px; }
        .fp-gate { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; color: var(--text-sub); font-family: var(--font-mono); font-size: 10px; }
        .fp-gate b { color: var(--warning); }
        .fp-filters { display: flex; gap: 6px; }
        .fp-chip {
          height: 22px; padding: 0 9px; border-radius: 6px; cursor: pointer;
          background: var(--bg-surface); border: 1px solid var(--border);
          color: var(--text-sub); font-family: var(--font-ui); font-size: 10.5px;
        }
        .fp-chip.on { border-color: var(--primary-40); color: var(--primary); background: var(--primary-10); }
        .fp-foot { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-sub); line-height: 1.8; }
        .fp-foot b { color: var(--text-main); }
        code { font-family: var(--font-mono); font-size: 10.5px; color: var(--primary); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
      `}</style>
    </div>
  )
}
