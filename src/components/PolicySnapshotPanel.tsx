import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  archivePolicy,
  deletePolicyArchive,
  exportPolicy,
  getPolicyArchives,
  getPolicySnapshot,
  importPolicy,
  restorePolicy,
  type ArchiveEntryView,
  type PolicySnapshotView,
  type RestoreResultView,
} from '../orch/client.ts'

/**
 * 策略政策快照与一键回滚（Policy Snapshot）
 *
 * 这个页面回答的问题是：**「三天前那套跑得好的参数，到底长什么样？」**
 *
 * 在快照机制之前，「上个月的风控参数」只存在于 `.env` 的当前值和人的记忆里——
 * 调坏了想退回，只能凭印象重填。而风控参数、心法启用状态、拦截器开关与顺序、
 * 模型路由这四样东西共同决定「系统会怎么决策」，单独备份任何一样都不足以还原。
 *
 * 因此快照把四者作为一个**整体**采集，并为整体生成一个确定性指纹：
 * 指纹一致 ⇔ 策略一致，指纹不同 ⇔ 一定有什么变了（哪怕值只差浮点尾数）。
 */

const UNIT_TONE: Record<string, string> = {
  riskParams: 'var(--warning)',
  lessons: 'var(--accent)',
  interceptors: 'var(--primary)',
  llmRouting: 'var(--signal)',
}

const CSS = `
  .ps-root { display: flex; flex-direction: column; gap: 10px; }
  .ps-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .ps-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
  .ps-fp {
    font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--primary);
    background: var(--primary-10); border: 1px solid var(--primary-40); border-radius: 6px; padding: 1px 8px;
  }
  .ps-hint { font-family: var(--font-ui); font-size: 10px; font-weight: 400; color: var(--text-weak); }
  .ps-head-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .ps-btn {
    font-family: var(--font-ui); font-size: 11px; font-weight: 600;
    color: var(--text-sub); background: var(--bg-surface);
    border: 1px solid var(--border-strong); border-radius: 7px;
    padding: 5px 11px; cursor: pointer; white-space: nowrap; transition: all .14s;
  }
  .ps-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--text-weak); }
  .ps-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ps-btn.tiny { padding: 3px 8px; font-size: 10px; border-radius: 6px; }
  .ps-btn.danger { color: var(--bg-base); background: var(--up); border-color: var(--up); font-weight: 700; }

  .ps-input {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-main);
    background: var(--bg-base); border: 1px solid var(--border-strong);
    border-radius: 6px; padding: 5px 8px; width: 190px;
  }

  .ps-summary {
    font-family: var(--font-mono); font-size: 10.5px; line-height: 1.7; color: var(--text-sub);
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px;
  }
  .ps-msg { font-family: var(--font-ui); font-size: 11px; line-height: 1.65; border-radius: 7px; padding: 6px 10px; }
  .ps-msg.ok { color: var(--down); background: rgba(0,214,143,0.07); border-left: 3px solid var(--down); }
  .ps-msg.bad { color: var(--up); background: rgba(255,77,109,0.07); border-left: 3px solid var(--up); }

  .ps-units { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; }
  .ps-unit {
    display: flex; flex-direction: column; gap: 4px;
    background: var(--bg-card); border: 1px solid var(--border); border-left-width: 3px;
    border-radius: 9px; padding: 9px 11px;
  }
  .ps-unit-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .ps-unit-label { font-family: var(--font-ui); font-size: 11.5px; font-weight: 700; }
  .ps-unit-count { font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); }
  .ps-unit-hash { font-size: 11px; font-weight: 700; color: var(--text-main); }
  .ps-unit-summary { font-family: var(--font-ui); font-size: 10px; line-height: 1.55; color: var(--text-weak); }

  .ps-restore { display: flex; flex-direction: column; gap: 6px; border-radius: 8px; padding: 9px 12px; }
  .ps-restore.ok { background: rgba(0,214,143,0.06); border-left: 3px solid var(--down); }
  .ps-restore.bad { background: rgba(255,77,109,0.07); border-left: 3px solid var(--up); }
  .ps-restore-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); }
  .ps-restore-body { display: flex; gap: 16px; flex-wrap: wrap; font-size: 10.5px; color: var(--text-sub); }
  .ps-restore-reason { font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }

  .ps-section-label {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    font-family: var(--font-ui); font-size: 11.5px; font-weight: 700; color: var(--text-main);
    border-top: 1px solid var(--border); padding-top: 9px; margin-top: 2px;
  }

  .ps-empty { font-family: var(--font-ui); font-size: 11.5px; line-height: 1.7; color: var(--text-weak); background: var(--bg-surface); border: 1px dashed var(--border-strong); border-radius: 9px; padding: 12px; }

  .ps-timeline { display: flex; flex-direction: column; gap: 7px; }
  .ps-entry {
    display: flex; align-items: flex-start; gap: 10px;
    background: var(--bg-card); border: 1px solid var(--border); border-radius: 9px;
    padding: 9px 11px; transition: border-color .15s;
  }
  .ps-entry.current { border-color: rgba(34,211,238,0.35); background: rgba(34,211,238,0.035); }
  .ps-entry-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-weak); margin-top: 5px; flex-shrink: 0; }
  .ps-entry.current .ps-entry-dot { background: var(--primary); box-shadow: 0 0 6px var(--primary-40); }
  .ps-entry-main { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
  .ps-entry-top { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
  .ps-entry-fp { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-main); }
  .ps-entry-current { font-family: var(--font-ui); font-size: 9.5px; color: var(--down); border: 1px solid rgba(0,214,143,0.4); border-radius: 999px; padding: 0 6px; }
  .ps-entry-time { font-size: 10px; color: var(--text-weak); }
  .ps-entry-note { font-family: var(--font-ui); font-size: 11px; line-height: 1.6; color: var(--text-sub); }
  .ps-entry-units { display: flex; gap: 10px; flex-wrap: wrap; }
  .ps-entry-unit { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
  .ps-entry-unit .mono { font-family: var(--font-mono); color: var(--text-sub); }
  .ps-entry-cnt { font-family: var(--font-mono); }
  .ps-entry-ops { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }

  .ps-semantics { display: flex; flex-direction: column; gap: 7px; }
  .ps-sem { display: flex; flex-direction: column; gap: 3px; background: var(--bg-card); border-left: 3px solid var(--primary); border-radius: 0 8px 8px 0; padding: 8px 11px; }
  .ps-sem b { font-family: var(--font-ui); font-size: 11.5px; color: var(--text-main); }
  .ps-sem span { font-family: var(--font-ui); font-size: 11px; line-height: 1.7; color: var(--text-sub); }
`

function shortHash(h: string): string {
  return h.slice(0, 12)
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function PolicySnapshotPanel({ base, token, online }: { base: string; token: string; online: boolean }) {
  const [snap, setSnap] = useState<PolicySnapshotView | null>(null)
  const [summary, setSummary] = useState('')
  const [archives, setArchives] = useState<ArchiveEntryView[]>([])
  const [archiveDir, setArchiveDir] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [note, setNote] = useState('')
  // 回滚是双阶段交互：第一次点击只是「举手」，第二次才是「确认」。
  // 单次点击就执行回滚会让误触的代价等于「策略被换掉且不易察觉」。
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  const [lastRestore, setLastRestore] = useState<RestoreResultView | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    if (!online) return
    try {
      const [s, a] = await Promise.all([getPolicySnapshot(base), getPolicyArchives(base)])
      setSnap(s.snapshot)
      setSummary(s.summary)
      setArchives(a.archives ?? [])
      setArchiveDir(a.archiveDir)
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

  const run = useCallback(
    async (key: string, label: string, fn: () => Promise<string>) => {
      setBusy(key)
      setMsg(null)
      try {
        setMsg(`✓ ${label}：${await fn()}`)
        await refresh()
      } catch (e) {
        setMsg(`✕ ${label}失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  const sorted = useMemo(() => [...archives].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [archives])

  const doExport = useCallback(
    async (id?: string) => {
      try {
        const pkg = await exportPolicy(base, id)
        const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `evolve-policy-${(pkg.fingerprint as string | undefined)?.slice(0, 12) ?? 'current'}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // 立即回收：blob URL 不释放会在长时间开着的看板上累积
        URL.revokeObjectURL(url)
        setMsg('✓ 导出：策略包已下载（含四单元完整内容）')
      } catch (e) {
        setMsg(`✕ 导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [base],
  )

  const doImport = useCallback(
    async (file: File) => {
      setBusy('import')
      setMsg(null)
      try {
        const text = await file.text()
        const parsed = JSON.parse(text) as Record<string, unknown>
        const out = await importPolicy(base, token, parsed)
        if (!out.ok) {
          setMsg(`✕ 导入被拒：${(out.errors ?? ['未知原因']).join('；')}`)
        } else {
          setMsg(
            `✓ 导入：包已通过校验并归档（staged ${shortHash(String(out.staged ?? ''))}）。` +
              `★ 此时**尚未生效**——需要在上方时间线里显式回滚到它才会回灌。外部 JSON 不应有权直接改风控闸门。`,
          )
        }
        await refresh()
      } catch (e) {
        setMsg(`✕ 导入失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [base, token, refresh],
  )

  if (!online) {
    return (
      <>
        <style>{CSS}</style>
        <div className="ps-empty">
          编排服务未连接，无法读取政策快照。
          <span className="ps-hint"> 快照采集需要读取风控活绑定、心法库、拦截器与模型路由，因此只能在服务端完成。</span>
        </div>
      </>
    )
  }

  return (
    <div className="ps-root">
      {/* ── 当前生效指纹 ── */}
      <div className="ps-head">
        <div className="ps-title">
          当前生效策略指纹
          <span className="ps-fp">{snap ? shortHash(snap.fingerprint) : '—'}</span>
          <span className="ps-hint">
            同一指纹 ⇔ 同一策略。指纹变化说明四单元里有东西变了，哪怕数值只差浮点尾数。
          </span>
        </div>
        <div className="ps-head-ops">
          <input
            className="ps-input"
            placeholder="归档备注（如：调宽止损前）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            spellCheck={false}
          />
          <button
            className="ps-btn"
            disabled={busy !== null}
            onClick={() =>
              void run('archive', '归档', async () => {
                const out = await archivePolicy(base, token, { note: note.trim() || undefined, force: false })
                if (out.skipped) return `未产生新版本——${out.reason ?? '与最新归档一致'}`
                setNote('')
                return `已归档 ${shortHash(out.entry?.fingerprint ?? '')}`
              })
            }
          >
            {busy === 'archive' ? '归档中…' : '归档当前版本'}
          </button>
          <button className="ps-btn" disabled={busy !== null} onClick={() => void doExport()}>
            导出
          </button>
          <button className="ps-btn" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            {busy === 'import' ? '导入中…' : '导入'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              // 清空 value，否则连续选择同一个文件不会触发 change
              e.target.value = ''
              if (f) void doImport(f)
            }}
          />
        </div>
      </div>

      {summary && <div className="ps-summary">{summary}</div>}
      {msg && <div className={`ps-msg ${msg.startsWith('✓') ? 'ok' : 'bad'}`}>{msg}</div>}
      {err && <div className="ps-msg bad">读取失败：{err}</div>}

      {/* ── 四单元指纹 ── */}
      <div className="ps-units">
        {(snap?.units ?? []).map((u) => (
          <div key={u.unit} className="ps-unit" style={{ borderLeftColor: UNIT_TONE[u.unit] ?? 'var(--border)' }}>
            <div className="ps-unit-head">
              <span className="ps-unit-label" style={{ color: UNIT_TONE[u.unit] ?? 'var(--text-main)' }}>
                {u.label}
              </span>
              <span className="ps-unit-count">{u.count} 项</span>
            </div>
            <div className="ps-unit-hash mono">{shortHash(u.hash)}</div>
            <div className="ps-unit-summary">{u.summary}</div>
          </div>
        ))}
      </div>

      {/* ── 回滚结果（指纹比对）── */}
      {lastRestore && (
        <div className={`ps-restore ${lastRestore.ok ? 'ok' : 'bad'}`}>
          <div className="ps-restore-head">
            {lastRestore.ok ? '✓ 回滚成功' : '✕ 回滚未生效'}
            <span className="ps-hint">
              回滚后会重新采集指纹并比对——这样「写了但引擎读到的还是旧值」这类静默失败会立刻暴露，而不是等到下一笔交易异常才发现。
            </span>
          </div>
          <div className="ps-restore-body mono">
            <span>目标指纹：{shortHash(lastRestore.fingerprint)}</span>
            <span>回灌后指纹：{lastRestore.appliedFingerprint ? shortHash(lastRestore.appliedFingerprint) : '（未采集）'}</span>
            <span>已恢复通道：{(lastRestore.changedUnits ?? []).join(' · ') || '无'}</span>
          </div>
          {lastRestore.reason && <div className="ps-restore-reason">{lastRestore.reason}</div>}
        </div>
      )}

      {/* ── 版本时间线 ── */}
      <div className="ps-section-label">
        版本时间线
        <span className="ps-hint">
          {archives.length === 0
            ? '尚无归档。归档是回滚的前提——不归档就没有可回退的锚点。'
            : `共 ${archives.length} 个归档${archiveDir ? `，存放于 ${archiveDir}` : ''}`}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="ps-empty">点「归档当前版本」建立第一个可回退锚点。</div>
      ) : (
        <div className="ps-timeline">
          {sorted.map((a) => {
            const confirming = pendingRestore === a.id
            return (
              <div key={a.id} className={`ps-entry ${a.isCurrent ? 'current' : ''}`}>
                <div className="ps-entry-dot" />
                <div className="ps-entry-main">
                  <div className="ps-entry-top">
                    <span className="ps-entry-fp mono">{shortHash(a.fingerprint)}</span>
                    {a.isCurrent && <span className="ps-entry-current">与当前生效一致</span>}
                    <span className="ps-entry-time mono">{fmtTime(a.createdAt)}</span>
                  </div>
                  {a.note && <div className="ps-entry-note">{a.note}</div>}
                  <div className="ps-entry-units">
                    {a.units.map((u) => (
                      <span key={u.unit} className="ps-entry-unit">
                        {u.label} <span className="mono">{shortHash(u.hash)}</span>
                        <span className="ps-entry-cnt">({u.count})</span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ps-entry-ops">
                  {confirming ? (
                    <>
                      <button
                        className="ps-btn danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void run('restore', '回滚', async () => {
                            const out = await restorePolicy(base, token, a.id)
                            setLastRestore(out)
                            setPendingRestore(null)
                            if (!out.ok) throw new Error(out.reason ?? '回滚后指纹与目标不一致')
                            return `已恢复到 ${shortHash(out.fingerprint)}`
                          }).catch(() => setPendingRestore(null))
                        }
                      >
                        {busy === 'restore' ? '回滚中…' : '确认回滚'}
                      </button>
                      <button className="ps-btn tiny" onClick={() => setPendingRestore(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="ps-btn tiny"
                        disabled={busy !== null || !!a.isCurrent}
                        onClick={() => setPendingRestore(a.id)}
                        title={a.isCurrent ? '与当前生效一致，无需回滚' : '回滚到此版本'}
                      >
                        回滚
                      </button>
                      <button
                        className="ps-btn tiny"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`exp:${a.id}`, '导出该版本', async () => {
                            await doExport(a.id)
                            return shortHash(a.fingerprint)
                          })
                        }
                      >
                        导出
                      </button>
                      <button
                        className="ps-btn tiny"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`del:${a.id}`, '删除归档', async () => {
                            const out = await deletePolicyArchive(base, token, a.id)
                            if (!out.ok) throw new Error('归档不存在')
                            return shortHash(a.fingerprint)
                          })
                        }
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── 语义说明 ── */}
      <div className="ps-section-label">回滚会动什么、不会动什么</div>
      <div className="ps-semantics">
        <div className="ps-sem">
          <b>会恢复</b>
          <span>风控参数（落盘 + 热重载）· 心法的启用状态 · 拦截器的开关与顺序 · 激活的模型与启用集合。</span>
        </div>
        <div className="ps-sem">
          <b>不会动</b>
          <span>
            心法规则文本（只恢复「是否启用」）· API Key（只恢复选了哪个模型，绝不覆盖凭证）。规则文本是宪法红线的审查产物，回滚配置不应绕开那层审查。
          </span>
        </div>
      </div>

      <style>{CSS}</style>
    </div>
  )
}
