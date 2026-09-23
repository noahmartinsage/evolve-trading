/**
 * 新闻雷达 —— 推送面，也是这条链的**闭环收口**。
 *
 * ══ 这一页之前缺的是什么 ═══════════════════════════════════════════════
 * 上一轮雷达已经是"定时读 → 确定性打分 → 模型写内化提案"，
 * 但产出**没有任何读者**：提案躺在 `data/learn/notes.jsonl` 里，
 * 没人看见、没人拍板、没人知道有多少条在等。这种状态在文档里被如实标成
 * 「半闭环」—— 诚实的标注救不了它：一条没有读者的产出等于没产出
 * （B 项检验唯一判据：**谁在读它的输出**）。
 *
 * 现在这一页负责三件事，少了任何一件这条链就还是半截的：
 *   ① **看得见**：这一轮读到了什么、为什么算相关（每条都带命中词与权重）；
 *   ② **能拍板**：提案可确认/驳回，裁决落进**独立于提案单**的追加记录，
 *      带时间与理由 —— 机器建议与人的裁决分成两份，谁也改不了谁；
 *   ③ **接回系统**：品种热度是雷达唯一**直接改系统行为**的出口，
 *      它成为 breadth（多品种）的候选清单。这一页把它显式画出来，
 *      否则这条线是隐形的，坏了也没人知道。
 *
 * ══ 内化自哪里（都是外部专业做法的共性，不是照抄配色）═════════════════
 *   · sentix / chainpulse：顶部指标带 + 可筛条目流；
 *   · nlp3：**Source Intelligence** —— 按源统计战绩，这是"哪个源该换词"的唯一依据；
 *   · crypto-sentiment-monitor：Real-Time News Ticker + Topic Radar；
 *   · `swarm-trading-console.html`：滚动情报流、KPI 卡左侧色条、人类决策队列（治理留痕）。
 * ★ 刻意**没有**抄它们的 NLP 情感打分（Bullish/Bearish）。本系统的相关性判据
 *   必须是确定性规则，否则"你为什么觉得这条相关"答不上来 ——
 *   而答不上来的判据迟早会被当成噪音清掉。
 *
 * ══ 这一页最要紧的一条视觉契约 ═══════════════════════════════════════
 * **"读不到"与"没有"必须长得不一样。** 榜单读不到、提案单不存在、
 * 源全部失败 —— 这些都不是"今天没事"。它们的底色、文案、以及给出的
 * 下一步动作都不同，因为把它们画成一样，用户就会在系统瞎了的时候以为一切正常。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { pushToast, useStore } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { postNewsVerdict, runFleetTask, useNews, type NewsItemView, type NewsProposalRowView } from '../orch/client.ts'

const RISK_LABEL: Record<string, string> = { low: '低', middle: '中', high: '高' }

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 分数徽标。
 *
 * ★ 三档颜色不是装饰：`分数` 是这一页唯一能回答"它凭什么在列表里"的量。
 *   ≥24 = 命中了一条已登记的能力或红线（不是"同题材"）；
 *   ≥ 门线 = 过门；< 门线 = 被拦下的，留在列表里是为了让人看见判据在干活。
 */
function ScoreBadge({ score, threshold }: { score: number; threshold: number }) {
  const cls = score >= 24 ? 'hi' : score >= threshold ? 'ok' : 'lo'
  return <span className={`nr-score ${cls}`}>{score}</span>
}

export default function NewsPage() {
  const { state, dispatch } = useStore()
  const news = useNews(state.orchUrl, state.orchToken)

  const [onlyKept, setOnlyKept] = useState(true)
  const [armed, setArmed] = useState<string | null>(null)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  /** 「立即跑一轮」也走两段式：第一次只是上膛。 */
  const [runArmed, setRunArmed] = useState(false)
  const [running, setRunning] = useState(false)

  const d = news.data
  const threshold = d?.threshold ?? 8

  /**
   * 立刻跑一轮（= 自治循环里 `news_watch` 那一项干的事，不是另写一套）。
   *
   * ★ 为什么这一页必须有这个按钮，而不只是等 6 小时：
   *   定时跑是"系统自己动"，但它给不了人一个**当下就能核对**的动作 ——
   *   用户看到"读不到品种热度"时，唯一能做的是猜什么时候会好（判据 11：
   *   只有测试与排程可达的能力，等于没有生产入口）。
   * ★ 为什么走 `runFleetTask` 而不是新开端点：同一件事不给第二条实现路径（判据 8）。
   * ★ 为什么两段式：这是一次会出网、会花额度的 `act` 类动作，
   *   一次点击就发车的按钮迟早会被人误点。
   */
  const onRunNow = useCallback(async () => {
    const goal = d?.runGoal ?? ''
    if (goal.length === 0) {
      // ★ 不猜目标。猜出来的那种"看着也对"的目标会让按钮跑的东西
      //   与定时跑的东西悄悄分叉，而两边都显示成功。
      pushToast(dispatch, '⛔ 服务端没给出「跑一轮」的目标（/fleet/news 里 runGoal 为空）—— 按钮不替它猜')
      return
    }
    if (!runArmed) {
      setRunArmed(true)
      pushToast(dispatch, '⚠️ 这一轮会真的出网抓新闻，并可能调模型写内化提案（会花额度）—— 再点一次就开跑')
      return
    }
    setRunArmed(false)
    setRunning(true)
    try {
      const r = await runFleetTask(state.orchUrl, state.orchToken, { goal, confirmed: true })
      pushToast(dispatch, `✅ 读完一轮：${(r.brief ?? '').slice(0, 110)}`)
      news.refresh()
    } catch (e) {
      pushToast(dispatch, `⛔ 这一轮没跑成：${e instanceof Error ? e.message.slice(0, 110) : String(e)}`)
    } finally {
      setRunning(false)
    }
  }, [d?.runGoal, runArmed, dispatch, news, state.orchUrl, state.orchToken])

  const items = useMemo(() => {
    const all = d?.latest ?? []
    const list = onlyKept ? all.filter((i) => i.score >= threshold) : all
    return [...list].sort((a, b) => b.score - a.score)
  }, [d, onlyKept, threshold])

  const stats = useMemo(() => {
    const all = d?.latest ?? []
    const kept = all.filter((i) => i.score >= threshold).length
    const bySource = new Map<string, number>()
    for (const i of all) bySource.set(i.source, (bySource.get(i.source) ?? 0) + 1)
    return {
      fetched: all.length,
      kept,
      blocked: all.length - kept,
      sourcesHit: bySource.size,
      proposals: d?.proposals.length ?? 0,
      pending: d?.pending ?? 0,
      approved: (d?.proposals ?? []).filter((p) => p.decision === 'approve').length,
    }
  }, [d, threshold])

  const tickerItems = useMemo(() => {
    const all = (d?.latest ?? []).filter((i) => i.score >= threshold)
    return [...all].sort((a, b) => b.score - a.score).slice(0, 12)
  }, [d, threshold])

  /** 两段式：第一次点击只"上膛"。 */
  const onVerdict = useCallback(
    async (row: NewsProposalRowView, decision: 'approve' | 'reject') => {
      const key = `${row.noteId}#${row.index}`
      if (armed !== key) {
        setArmed(key)
        pushToast(dispatch, `⚠️ 裁决会写进 data/news/verdicts.jsonl 与账本（${row.title.slice(0, 24)}…）—— 再点一次确认`)
        return
      }
      setBusy(key)
      setArmed(null)
      try {
        const r = await postNewsVerdict(state.orchUrl, state.orchToken, {
          noteId: row.noteId,
          index: row.index,
          decision,
          why: why.trim() || undefined,
          confirmed: true,
        })
        pushToast(dispatch, `✅ ${decision === 'approve' ? '已确认' : '已驳回'}「${row.title.slice(0, 24)}」 · ${r.speech ?? ''}`.slice(0, 130))
        setWhy('')
        news.refresh()
      } catch (e) {
        pushToast(dispatch, `⛔ 裁决没落盘：${e instanceof Error ? e.message.slice(0, 100) : String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [armed, why, dispatch, news, state.orchUrl, state.orchToken],
  )

  const kpis: KpiItem[] = [
    {
      label: '本轮读到',
      value: d ? String(stats.fetched) : '—',
      valueColor: 'var(--text-main)',
      meta: d ? `${stats.sourcesHit}/${d.sources.length} 个源有产出` : '未连接编排器',
      metaColor: 'var(--text-sub)',
    },
    {
      label: '够相关',
      value: d ? String(stats.kept) : '—',
      valueColor: stats.kept > 0 ? 'var(--primary)' : 'var(--text-weak)',
      meta: `门线 ${threshold} 分 · 拦下 ${stats.blocked} 条`,
      metaColor: 'var(--text-sub)',
    },
    {
      label: '待你点',
      value: d ? String(stats.pending) : '—',
      valueColor: stats.pending > 0 ? 'var(--warning)' : 'var(--down)',
      meta: d ? `共 ${stats.proposals} 条提案 · 已确认 ${stats.approved}` : '读不到提案单',
      metaColor: 'var(--text-sub)',
    },
    {
      label: '品种热度',
      // ★ `trending === null` 是"读不到"，`ticks.length === 0` 是"空榜" —— 两种都用 '—' 画
      //   会让人以为榜单在工作只是没数据。所以这里分开写。
      value: d?.trending ? String(d.trending.ticks.length) : '读不到',
      valueColor: d?.trending ? (d.trending.ticks.length > 0 ? 'var(--primary)' : 'var(--text-weak)') : 'var(--warning)',
      meta: d?.trending ? `取自 ${fmtTime(d.trending.at)} 那一轮` : 'trending.json 不存在或读不懂',
      metaColor: 'var(--text-sub)',
    },
    {
      label: 'breadth 候选',
      value: d?.universe.symbols.length ? String(d.universe.symbols.length) : '0',
      valueColor: d?.universe.symbols.length ? 'var(--up)' : 'var(--text-weak)',
      meta: '雷达唯一直接改系统行为的出口',
      metaColor: 'var(--text-sub)',
    },
  ]

  return (
    <div className="content-area">
      {/* ── 出处带：这一页每个数字从哪来 ─────────────────────────────── */}
      <div className="nr-prov">
        <span className={`db-tag ${d && news.error === null ? 'ok' : 'warn'}`}>
          {d ? (news.error ? '上一份快照' : '实时读出') : '未连接'}
        </span>
        <span className="nr-prov-text">
          {news.error
            ? `读不到雷达实况：${news.error.slice(0, 130)}（下面显示的是上一份快照，不是"今天没事"）`
            : d
              ? `打分是确定性规则（${d.terms.length} 个词条），模型只负责把选中的条目写成内化方案 · ${
                  // ★ 三个数字回答三个不同的问题：读了几条 = 网通不通；
                  //   过门几条 = 判据在不在工作；新几条 = 是不是重复劳动。
                  //   只报一个"相关 3 条"的话，网全挂与判据全放行长得一样（判据 24）。
                  d.lastRun
                    ? `最近一轮 ${fmtTime(d.lastRun.at)}：读 ${d.lastRun.fetched} 条 · 过门 ${d.lastRun.kept} · 新的 ${d.lastRun.fresh}`
                    : '这个工作目录还没跑过一轮 —— 右上角「立即跑一轮」'
                }`
              : '正在读新闻雷达…'}
        </span>
        {/* 立刻跑一轮：定时跑之外的**当下可核对**的动作。
            按钮上的字会随上膛状态变，让人不必靠记忆判断"刚才那次是确认还是上膛"。 */}
        <button
          data-ui="news.run"
          className={`btn btn-sm ${runArmed ? 'btn-armed' : 'btn-primary'}`}
          disabled={running || !d?.runGoal}
          title={d?.runGoal ? `跑的就是定时任务那一句：${d.runGoal}` : '服务端没给出目标，按钮不猜'}
          onClick={() => void onRunNow()}
        >
          {running ? '抓取中…' : runArmed ? '再点开跑' : '立即跑一轮'}
        </button>
        <button className="btn btn-sm" data-ui="news.refresh" disabled={running} onClick={news.refresh}>
          刷新
        </button>
      </div>

      {/* ── 滚动情报条（内化自 crypto-sentiment-monitor 的 news ticker）────
          鼠标悬停暂停 —— 滚动的东西若不能停下来读，等于没写。 */}
      <div className="nr-ticker" title="鼠标移上去会暂停">
        {tickerItems.length === 0 ? (
          <div className="nr-ticker-empty">
            {d ? '这一轮没有条目过门 —— 判据在拦，不是没有新闻' : '还没读到条目'}
          </div>
        ) : (
          <div className="nr-track">
            {[...tickerItems, ...tickerItems].map((it, i) => (
              <span className="nr-tk" key={`${it.id}-${i}`}>
                <span className={`nr-tk-score ${it.score >= 24 ? 'hi' : 'ok'}`}>{it.score}</span>
                <span>{it.title}</span>
                <span className="nr-tk-src">{it.source}</span>
                <span className="nr-tk-cf">{it.matched.slice(0, 3).join(' · ')}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <KpiRow items={kpis} height={96} />

      <div className="main-area">
        {/* ── 左：情报清单 ───────────────────────────────────────────── */}
        <div className="nr-feed-col">
          <div className="nr-feed-head">
            <span className="panel-title">情报清单</span>
            <div className="nr-tabs">
              <button className={`nr-tab ${onlyKept ? 'on' : ''}`} data-ui="news.filter.kept" onClick={() => setOnlyKept(true)}>
                只看过门的 {stats.kept}
              </button>
              <button className={`nr-tab ${!onlyKept ? 'on' : ''}`} data-ui="news.filter.all" onClick={() => setOnlyKept(false)}>
                连拦下的一起看 {stats.fetched}
              </button>
            </div>
          </div>
          <div className="nr-feed">
            {items.map((it) => (
              <FeedRow key={it.id} it={it} threshold={threshold} />
            ))}
            {items.length === 0 && (
              <div className="nr-empty">
                {d ? '这一轮没有条目过门 —— 判据在拦，不是没有新闻' : '正在读新闻雷达…'}
              </div>
            )}
            {/* ★ 被拦下的那些**必须能被找到**，而且个数要说出来。
                只看过门的几条时，人很容易以为"雷达没读到东西" ——
                而真相往往是"读到了 20 条，18 条被判据拦下"。
                这两种情况给出的下一步完全不同（换源 vs 调判据）。 */}
            {onlyKept && stats.blocked > 0 && (
              <div className="nr-more">
                另有 {stats.blocked} 条没过门（门线 {threshold} 分）——
                <button className="nr-link" onClick={() => setOnlyKept(false)}>
                  连它们一起看
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── 右：提案 / 来源情报 / 品种热度 ─────────────────────────── */}
        <div className="right-col nr-right">
          {/* ① 内化提案：闭环的拍板处 */}
          <div className="nr-card nr-props">
            <div className="nr-card-head">
              <span className="panel-title">内化提案</span>
              <span className={`chip ${stats.pending > 0 ? 'chip-amber' : 'chip-green'}`}>
                {stats.pending > 0 ? `${stats.pending} 条待你点` : '没有待办'}
              </span>
            </div>
            {/* ★ 这句来自服务端，且三种"没待办"说法不同 —— 界面直接把服务端的话显示出来，
                不在本地另写一套判断（同一个结论两条实现路径，早晚给出不同答案）。 */}
            <div className="nr-note">{d?.pendingSpeech ?? '还没读到提案单的状态'}</div>
            <input
              className="nr-why"
              value={why}
              placeholder="裁决理由（可选，会记进留痕）"
              onChange={(e) => setWhy(e.target.value)}
            />
            <div className="nr-prop-list">
              {(d?.proposals ?? []).map((r) => {
                const key = `${r.noteId}#${r.index}`
                return (
                  <div className={`nr-prop ${r.decision ?? 'pending'}`} key={key}>
                    <div className="nr-prop-head">
                      <span className={`chip chip-risk-${r.risk}`}>风险 {RISK_LABEL[r.risk]}</span>
                      <span className="nr-prop-id">
                        {r.noteId}#{r.index}
                      </span>
                      {/* 规则层产物必须显眼：它不是模型说的，含金量完全不同 */}
                      {r.source === 'rules' && <span className="chip chip-gray">只有规则层</span>}
                      {r.decision && (
                        <span className={`chip ${r.decision === 'approve' ? 'chip-green' : 'chip-red'}`}>
                          {r.decision === 'approve' ? '已确认' : '已驳回'}
                        </span>
                      )}
                    </div>
                    <div className="nr-prop-title">{r.title}</div>
                    <div className="nr-prop-line">
                      <b>依据</b>
                      {r.evidence}
                    </div>
                    <div className="nr-prop-line">
                      <b>动作</b>
                      {r.action}
                    </div>
                    {r.decision ? (
                      <div className="nr-prop-decided">
                        {r.decidedBy} · {fmtTime(r.decidedAt)}
                        {r.decisionWhy ? ` · ${r.decisionWhy}` : ''}
                      </div>
                    ) : (
                      <div className="nr-prop-actions">
                        <button
                          className={`btn btn-sm ${armed === key ? 'btn-armed' : 'btn-primary'}`}
                          disabled={busy !== null}
                          onClick={() => void onVerdict(r, 'approve')}
                        >
                          {busy === key ? '落盘中…' : armed === key ? '再点确认' : '确认可做'}
                        </button>
                        <button
                          className={`btn btn-sm ${armed === key ? 'btn-armed' : ''}`}
                          disabled={busy !== null}
                          onClick={() => void onVerdict(r, 'reject')}
                        >
                          驳回
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
              {(d?.proposals.length ?? 0) === 0 && <div className="nr-note">还没有任何提案。</div>}
            </div>
          </div>

          {/* ② 来源情报（内化自 nlp3 的 Source Intelligence） */}
          <div className="nr-card">
            <div className="nr-card-head">
              <span className="panel-title">来源情报</span>
              <span className="nr-hint">哪条源该留、该换词，看这里</span>
            </div>
            <div className="nr-src-list">
              {(d?.sourceStats ?? []).map((s) => {
                // ★ 分母只用**有数**的那些源。把 null 当 0 算进 Math.max 不会出错，
                //   但会让"还没跑过"的那些源的条长看起来像"跑了但一条没有"。
                const max = Math.max(1, ...(d?.sourceStats ?? []).map((x) => x.got ?? 0))
                // `null` = 这一轮的报告里没有它（还没跑过）。它不是 false，更不是 0。
                const unknown = s.got === null
                return (
                  <div className="nr-src" key={s.id}>
                    <span className={`nr-dot ${unknown ? 'unknown' : s.ok ? 'ok' : 'bad'}`} />
                    <span className="nr-src-label" title={s.id}>
                      {s.label}
                    </span>
                    {/* 读不到时**不画空条**：空条在视觉上就是"0 条"，
                        而这一栏的用途正是让人判断"哪个源该留"。 */}
                    {unknown ? (
                      <span className="nr-src-bar unknown" title="还没跑过一轮，所以我这里没有它的战绩" />
                    ) : (
                      <span className="nr-src-bar">
                        <i style={{ width: `${((s.got ?? 0) / max) * 100}%` }} />
                      </span>
                    )}
                    <span className="nr-src-num">
                      {unknown ? '还没跑过' : s.ok ? `${s.got} 条 / 过门 ${s.kept}` : '这轮没通'}
                    </span>
                  </div>
                )
              })}
              {!d && <div className="nr-note">正在读源统计…</div>}
            </div>
          </div>

          {/* ③ 品种热度 → breadth 候选（雷达接回系统的那根线） */}
          <div className="nr-card">
            <div className="nr-card-head">
              <span className="panel-title">品种热度 → breadth 候选</span>
            </div>
            {d?.trending ? (
              <>
                <div className="nr-heat">
                  {d.trending.ticks.slice(0, 8).map((h) => {
                    const max = Math.max(1, ...d.trending!.ticks.map((x) => x.weighted))
                    return (
                      <div className="nr-heat-row" key={h.ticker} title={h.samples.join(' / ')}>
                        <span className="nr-heat-tk">{h.ticker}</span>
                        <span className="nr-heat-bar">
                          <i style={{ width: `${(h.weighted / max) * 100}%` }} />
                        </span>
                        <span className="nr-heat-num">
                          {h.weighted} 分 · {h.mentions} 条
                        </span>
                      </div>
                    )
                  })}
                  {d.trending.ticks.length === 0 && <div className="nr-note">空榜：这一轮没有任何品种被提到（不是读不到）。</div>}
                </div>
                <div className="nr-uni">
                  <b>候选清单</b>
                  {d.universe.symbols.length > 0 ? d.universe.symbols.join(' · ') : '（空）'}
                  <div className="nr-note">{d.universe.note}</div>
                </div>
              </>
            ) : (
              // ★ 读不到榜单时**不画空条**：空条会被读成"热度全是 0"。
              <div className="nr-note warn">
                读不到品种热度（trending.json 不存在或读不懂）—— 这与"最近没有品种被提到"是两件事。
                breadth 这一步拿不到候选清单，所以它不会开始。
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .nr-prov { display: flex; align-items: center; gap: 10px; flex-shrink: 0;
          background: rgba(34,211,238,0.05); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; }
        .nr-prov .db-tag { font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 1px;
          border-radius: 4px; padding: 2px 6px; white-space: nowrap; border: 1px solid var(--border-strong); color: var(--text-sub); }
        .nr-prov .db-tag.ok { color: var(--down); border-color: rgba(34,197,94,0.45); background: rgba(34,197,94,0.06); }
        .nr-prov .db-tag.warn { color: var(--warning); border-color: rgba(255,176,32,0.45); background: rgba(255,176,32,0.06); }
        .nr-prov-text { flex: 1; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.5; }

        /* ── 滚动情报条 ── */
        .nr-ticker { flex-shrink: 0; height: 36px; border: 1px solid var(--border); border-radius: 9px;
          background: var(--bg-card); overflow: hidden; position: relative; }
        .nr-track { display: flex; align-items: center; height: 100%; white-space: nowrap;
          animation: nrScroll 72s linear infinite; will-change: transform; }
        .nr-ticker:hover .nr-track { animation-play-state: paused; }
        @keyframes nrScroll { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        .nr-tk { display: inline-flex; align-items: center; gap: 8px; padding: 0 22px;
          font-family: var(--font-ui); font-size: 11.5px; color: var(--text-main); }
        .nr-tk-score { font-family: var(--font-mono); font-size: 10px; font-weight: 800; border-radius: 4px; padding: 1px 5px; }
        .nr-tk-score.hi { background: rgba(255,176,32,0.16); color: var(--warning); }
        .nr-tk-score.ok { background: rgba(34,211,238,0.14); color: var(--primary); }
        .nr-tk-src { color: var(--text-weak); font-size: 10px; }
        .nr-tk-cf { color: var(--text-weak); font-family: var(--font-mono); font-size: 9.5px; }
        .nr-ticker-empty { display: flex; align-items: center; height: 100%; padding: 0 14px;
          font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }

        .nr-feed-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
        .nr-feed-head { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .nr-tabs { display: flex; gap: 6px; }
        .nr-tab { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-sub);
          background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; cursor: pointer; }
        .nr-tab.on { color: var(--primary); border-color: var(--primary-40); background: rgba(34,211,238,0.07); }
        .nr-feed { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; padding-right: 2px; }
        .nr-row { display: flex; gap: 9px; background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 9px; padding: 9px 11px; }
        .nr-row.blocked { opacity: 0.62; }
        .nr-score { flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; font-weight: 800;
          border-radius: 5px; padding: 2px 6px; height: fit-content; }
        .nr-score.hi { background: rgba(255,176,32,0.16); color: var(--warning); }
        .nr-score.ok { background: rgba(34,211,238,0.14); color: var(--primary); }
        .nr-score.lo { background: var(--bg-surface); color: var(--text-weak); }
        .nr-row-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
        .nr-title { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main);
          line-height: 1.45; text-decoration: none; }
        .nr-title:hover { color: var(--primary); }
        .nr-sum { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-weak); line-height: 1.5;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .nr-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .nr-term { font-family: var(--font-mono); font-size: 9px; color: var(--text-sub);
          border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }
        .nr-meta-src { font-family: var(--font-ui); font-size: 9.5px; color: var(--text-weak); }
        .nr-empty { padding: 30px; text-align: center; font-family: var(--font-ui); font-size: 11.5px; color: var(--text-weak); }
        .nr-more { margin-top: 4px; padding: 8px 11px; border: 1px dashed var(--border); border-radius: 9px;
          font-family: var(--font-ui); font-size: 10.5px; color: var(--text-weak); }
        .nr-link { background: none; border: none; padding: 0 3px; color: var(--primary);
          font-family: var(--font-ui); font-size: 10.5px; cursor: pointer; text-decoration: underline; }

        .nr-right { width: 390px; }
        .nr-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
          padding: 12px 13px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
        .nr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .nr-hint { font-family: var(--font-ui); font-size: 9.5px; color: var(--text-weak); }
        .nr-note { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); line-height: 1.55; }
        .nr-note.warn { color: var(--warning); }
        .nr-props { flex: 1; min-height: 0; }
        .nr-why { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px;
          padding: 5px 9px; color: var(--text-main); font-family: var(--font-ui); font-size: 11px; }
        .nr-prop-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
        .nr-prop { border: 1px solid var(--border); border-left: 2px solid var(--text-weak);
          border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; }
        .nr-prop.approve { border-left-color: var(--down); }
        .nr-prop.reject { border-left-color: var(--up); opacity: 0.7; }
        .nr-prop.pending { border-left-color: var(--warning); }
        .nr-prop-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .nr-prop-id { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
        .nr-prop-title { font-family: var(--font-ui); font-size: 11.5px; font-weight: 600; color: var(--text-main); line-height: 1.45; }
        .nr-prop-line { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); line-height: 1.55; }
        .nr-prop-line b { color: var(--text-main); font-weight: 600; margin-right: 5px; }
        .nr-prop-actions { display: flex; gap: 6px; margin-top: 2px; }
        .nr-prop-decided { font-family: var(--font-ui); font-size: 9.5px; color: var(--text-weak); }
        .btn-armed { background: rgba(255,176,32,0.18); border-color: rgba(255,176,32,0.55);
          color: var(--warning); animation: nrArmed 1.1s ease-in-out infinite; }
        @keyframes nrArmed { 0%,100% { opacity: 1 } 50% { opacity: 0.62 } }

        .nr-src-list { display: flex; flex-direction: column; gap: 6px; }
        .nr-src { display: flex; align-items: center; gap: 7px; }
        .nr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .nr-dot.ok { background: var(--down); box-shadow: 0 0 6px var(--down); }
        .nr-dot.bad { background: var(--up); box-shadow: 0 0 6px var(--up); }
        /* 读不到：**灰色的点 + 斜纹条**，既不是绿也不是红。
           用红色会把"我还没跑过"说成"这条源坏了"，用户就会去改一个好的源。 */
        .nr-dot.unknown { background: var(--text-weak); }
        .nr-src-bar.unknown { background: repeating-linear-gradient(45deg,
          var(--bg-surface), var(--bg-surface) 3px, var(--border) 3px, var(--border) 6px); opacity: 0.55; }
        .nr-src-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); width: 108px;
          flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .nr-src-bar { flex: 1; height: 5px; background: var(--bg-surface); border-radius: 3px; overflow: hidden; }
        .nr-src-bar i { display: block; height: 100%; background: var(--primary); opacity: 0.7; }
        .nr-src-num { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-weak); width: 74px; text-align: right; flex-shrink: 0; }

        .nr-heat { display: flex; flex-direction: column; gap: 5px; }
        .nr-heat-row { display: flex; align-items: center; gap: 7px; }
        .nr-heat-tk { font-family: var(--font-mono); font-size: 10.5px; font-weight: 700; color: var(--text-main); width: 42px; }
        .nr-heat-bar { flex: 1; height: 6px; background: var(--bg-surface); border-radius: 3px; overflow: hidden; }
        .nr-heat-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--primary), var(--warning)); }
        .nr-heat-num { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-weak); white-space: nowrap; }
        .nr-uni { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-main); line-height: 1.6;
          border-top: 1px solid var(--border); padding-top: 7px; }
        .nr-uni b { margin-right: 6px; color: var(--text-sub); font-weight: 600; }

        .chip-risk-low { color: var(--down); border-color: rgba(34,197,94,0.4); }
        .chip-risk-middle { color: var(--warning); border-color: rgba(255,176,32,0.4); }
        .chip-risk-high { color: var(--up); border-color: rgba(246,70,93,0.4); }
        /* panel-title 在本项目是逐页定义的（没有全局版本），所以这里也要写一份。
           不写的话标题会退化成浏览器默认字号，与相邻卡片明显不齐。
           ★ 注意：这段注释在 JS 模板字符串里 —— 别在注释里写反引号，
             那一对反引号会把模板字符串提前闭合（tsc 报的正是这个）。 */
        .panel-title { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
      `}</style>
    </div>
  )
}

/** 一条情报。`score < threshold` 的那些也画出来 —— 判据在拦，这件事要看得见。 */
function FeedRow({ it, threshold }: { it: NewsItemView; threshold: number }) {
  const blocked = it.score < threshold
  return (
    <div className={`nr-row ${blocked ? 'blocked' : ''}`}>
      <ScoreBadge score={it.score} threshold={threshold} />
      <div className="nr-row-body">
        <a className="nr-title" href={it.url} target="_blank" rel="noreferrer">
          {it.title}
        </a>
        {it.summary && <div className="nr-sum">{it.summary}</div>}
        <div className="nr-meta">
          <span className="nr-meta-src">{it.source}</span>
          <span className="nr-meta-src">{fmtTime(it.publishedAt)}</span>
          {it.matched.slice(0, 5).map((m) => (
            <span className="nr-term" key={m} title={it.reasons.find((r) => r.startsWith(m)) ?? ''}>
              {m}
            </span>
          ))}
          {blocked && <span className="nr-meta-src">没过门（门线 {threshold}）</span>}
        </div>
      </div>
    </div>
  )
}
