import { useCallback, useEffect, useState } from 'react'
import { getDecisionsObservability, type ObservabilityView } from '../orch/client.ts'

/**
 * 决策证据完整度（Decision Observability）
 *
 * 这个面板回答的问题是：**「我们手上这批复盘样本，够格用来提炼心法吗？」**
 *
 * 自进化最隐蔽的失败模式不是「学错了」，而是「从空壳样本里学」——
 * 一条决策如果只记录了「价格 X 时买入」，事后既无法判断当时 ATR 多高、
 * 趋势多强，也无法归因成败。这样的样本量堆到一千条，也提炼不出任何真实规律，
 * 只会把噪声固化成规则。
 *
 * 因此每条开仓决策在落盘时都会被打上一个完整度标签，本页把它汇总成可度量的量。
 */

/** 四档的设计语气：达标=冷色、部分=中性、仅价格/无=警示。同样避开红绿，那是涨跌专用。 */
const TIER_TONE: Record<string, { color: string; desc: string }> = {
  DYNAMICS_OBSERVED: { color: 'var(--primary)', desc: '动力学字段齐备，可做数理归因' },
  PARTIAL: { color: 'var(--warning)', desc: '有部分动力学字段，归因可信度打折' },
  PRICE_ONLY: { color: 'var(--up)', desc: '只有价格，无法回答「为什么」' },
  NONE: { color: 'var(--text-weak)', desc: '无有效快照，样本不可用' },
}

const TIER_ORDER = ['DYNAMICS_OBSERVED', 'PARTIAL', 'PRICE_ONLY', 'NONE'] as const

const CSS = `
  .ob-root {
    display: flex; flex-direction: column; gap: 8px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  }
  .ob-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .ob-title { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); }
  .ob-verdict { font-family: var(--font-ui); font-size: 10px; font-weight: 700; border: 1px solid; border-radius: 999px; padding: 1px 8px; }
  .ob-verdict.ok { color: var(--down); border-color: rgba(0,214,143,0.42); background: rgba(0,214,143,0.07); }
  .ob-verdict.warn { color: var(--warning); border-color: rgba(255,176,32,0.42); background: rgba(255,176,32,0.07); }
  .ob-hint { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
  .ob-toggle {
    margin-left: auto; font-family: var(--font-ui); font-size: 10px; font-weight: 600;
    color: var(--text-weak); background: none; border: 1px solid var(--border-strong);
    border-radius: 6px; padding: 2px 8px; cursor: pointer;
  }
  .ob-toggle:hover { color: var(--primary); border-color: var(--primary-40); }

  .ob-err { font-family: var(--font-ui); font-size: 11px; color: var(--up); }
  .ob-empty { font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--text-weak); }

  .ob-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--bg-surface); }
  .ob-bar-seg { transition: width .3s; }

  .ob-legend { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
  .ob-legend-item { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: 10.5px; color: var(--text-sub); }
  .ob-legend-item.wide { margin-left: auto; color: var(--text-weak); }
  .ob-dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
  .ob-num { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--text-main); }

  .ob-reason {
    font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--warning);
    background: rgba(255,176,32,0.07); border-left: 3px solid var(--warning);
    border-radius: 0 7px 7px 0; padding: 6px 10px;
  }

  .ob-semantics { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
  .ob-sem { display: flex; flex-direction: column; gap: 2px; }
  .ob-sem b { font-family: var(--font-ui); font-size: 11px; color: var(--text-main); }
  .ob-sem span { font-family: var(--font-ui); font-size: 10.5px; line-height: 1.7; color: var(--text-sub); }
  .ob-brief {
    margin: 4px 0 0; font-family: var(--font-mono); font-size: 10.5px; line-height: 1.8;
    color: var(--text-sub); white-space: pre-wrap; word-break: break-word;
    background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 9px;
  }
`

export function ObservabilityPanel({ base, online }: { base: string; online: boolean }) {
  const [data, setData] = useState<ObservabilityView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!online) return
    try {
      setData(await getDecisionsObservability(base))
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [base, online])

  useEffect(() => {
    void refresh()
    if (!online) return
    const t = setInterval(() => void refresh(), 15000)
    return () => clearInterval(t)
  }, [refresh, online])

  if (!online) return null

  const audit = data?.audit
  const total = audit?.total ?? 0

  return (
    <div className="ob-root">
      <div className="ob-head">
        <span className="ob-title">复盘样本质量</span>
        {audit && (
          <span className={`ob-verdict ${data?.quality.ok ? 'ok' : 'warn'}`}>
            {data?.quality.ok ? '✓ 可支撑心法提炼' : '⚠ 不足以提炼心法'}
          </span>
        )}
        <span className="ob-hint">共 {total} 笔已结束决策</span>
        <button className="ob-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? '收起口径说明' : '口径说明'}
        </button>
      </div>

      {err && <div className="ob-err">读取失败：{err}</div>}

      {total === 0 ? (
        <div className="ob-empty">
          还没有已结束的决策样本。
          <span className="ob-hint"> 样本只有在平仓之后才计入——持仓中的决策无法评判成败。</span>
        </div>
      ) : (
        <>
          <div className="ob-bar">
            {TIER_ORDER.map((tier) => {
              const n = audit?.[tier] ?? 0
              const pct = total > 0 ? (n / total) * 100 : 0
              return (
                <div
                  key={tier}
                  className="ob-bar-seg"
                  style={{ width: `${pct}%`, background: TIER_TONE[tier].color }}
                  title={`${data?.labels[tier] ?? tier}：${n} 笔（${pct.toFixed(1)}%）`}
                />
              )
            })}
          </div>

          <div className="ob-legend">
            {TIER_ORDER.map((tier) => (
              <span key={tier} className="ob-legend-item">
                <span className="ob-dot" style={{ background: TIER_TONE[tier].color }} />
                {data?.labels[tier] ?? tier}
                <span className="ob-num">{audit?.[tier] ?? 0}</span>
              </span>
            ))}
            <span className="ob-legend-item wide">
              可归因占比
              <span className="ob-num" style={{ color: (audit?.mathObservableRatio ?? 0) >= 0.5 ? 'var(--primary)' : 'var(--warning)' }}>
                {((audit?.mathObservableRatio ?? 0) * 100).toFixed(1)}%
              </span>
            </span>
          </div>

          {!data?.quality.ok && data?.quality.reason && <div className="ob-reason">{data.quality.reason}</div>}

          {open && (
            <div className="ob-semantics">
              <div className="ob-sem">
                <b>为什么「有价格」不算有证据？</b>
                <span>
                  {data?.hints.PRICE_ONLY ??
                    '价格只告诉你结果，不告诉你动因。一条只有价格的样本无法与另一条对比，因此无法归因。'}
                </span>
              </div>
              <div className="ob-sem">
                <b>为什么 0 和 false 算「有值」？</b>
                <span>
                  快照的判定是「字段是否被采集到」，不是「值是否为真」。ATR=0 是一个真实观测（极端盘整），不是缺失。
                </span>
              </div>
              <div className="ob-sem">
                <b>门槛是怎么定的？</b>
                <span>
                  样本量 ≥ 6 笔，且可归因占比 ≥ 50%（后端默认阈值）。数量与质量必须**同时**达标——只有数量会产出噪声心法，只有质量会样本不足。
                </span>
              </div>
              {data?.brief && <pre className="ob-brief">{data.brief}</pre>}
            </div>
          )}
        </>
      )}

      <style>{CSS}</style>
    </div>
  )
}
