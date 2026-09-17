import React, { useEffect, useState } from 'react'
import { useStore, pushToast, MODE_META } from '../store/Store'
import KpiRow, { KpiItem } from '../components/KpiRow'
import { listLlmProviders, addLlmProvider, llmProviderAction, removeLlmProvider } from '../orch/client.ts'
import type { LlmProviderView } from '../orch/client.ts'

function LlmProvidersCard() {
  const { state, dispatch } = useStore()
  const [providers, setProviders] = useState<LlmProviderView[]>([])
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', flavor: 'openai' as 'openai' | 'anthropic' })
  const [busy, setBusy] = useState(false)

  const load = () => {
    void listLlmProviders(state.orchUrl).then((r) => setProviders(r.providers)).catch(() => undefined)
  }
  // 依赖必须带上 orchUrl：否则用户在「参数设置」里改了编排器地址后，
  // 本页仍会用旧地址拉模型列表，表现为列表永远空着。
  useEffect(load, [state.orchUrl])

  const add = async () => {
    if (!form.baseUrl || !form.apiKey) {
      pushToast(dispatch, '❌ Base URL 与 API Key 必填')
      return
    }
    setBusy(true)
    try {
      const r = await addLlmProvider(state.orchUrl, state.orchToken, form)
      if (r.ok) {
        pushToast(dispatch, `✅ 厂商已添加 · 自动识别 ${r.models?.length ?? 0} 个可用模型${r.models?.length ? '（首个已自动选中）' : ''}`)
        setForm({ name: '', baseUrl: '', apiKey: '', flavor: 'openai' })
      } else {
        pushToast(dispatch, `❌ ${r.reason}`)
      }
    } catch (e) {
      pushToast(dispatch, `❌ ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
      load()
    }
  }

  const act = async (id: string, action: 'probe' | 'select-model' | 'enable', body?: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await llmProviderAction(state.orchUrl, state.orchToken, id, action, body)
      pushToast(dispatch, r.ok
        ? action === 'probe' ? `✅ 探测完成 · 可用模型 ${r.models?.length ?? 0} 个` : '✅ 已更新'
        : `❌ ${r.reason}`)
    } catch (e) {
      pushToast(dispatch, `❌ ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
      load()
    }
  }

  const del = async (id: string) => {
    await removeLlmProvider(state.orchUrl, state.orchToken, id)
    pushToast(dispatch, '🗑 厂商已删除')
    load()
  }

  return (
    <div className="set-card llm-card">
      <span className="set-title">LLM 厂商管理（自定义 + 自动识别模型）</span>

      <div className="llm-form">
        <input className="input" style={{ flex: 1 }} placeholder="名称(可选)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="input" style={{ flex: 2 }} placeholder="Base URL · 如 https://api.deepseek.com/v1" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} spellCheck={false} />
        <input className="input" type="password" style={{ flex: 1 }} placeholder="API Key" value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
        <select className="input" style={{ width: 110 }} value={form.flavor} onChange={(e) => setForm((f) => ({ ...f, flavor: e.target.value as 'openai' | 'anthropic' }))}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={add}>添加并探测</button>
      </div>
      <div className="risk-note">添加后自动请求 /models 识别可用模型；提案引擎使用「启用中 + 已选模型」的厂商，未配置时降级为确定性提案。</div>

      {providers.length === 0 && <div className="risk-note">尚未添加厂商</div>}
      {providers.map((p) => (
        <div key={p.id} className="llm-item">
          <div className="li-row">
            <span className="li-name">{p.name}</span>
            <span className="chip chip-cyan">{p.flavor}</span>
            <span className={`chip ${p.enabled ? 'chip-green' : 'chip-gray'}`}>{p.enabled ? '启用' : '停用'}</span>
          </div>
          <div className="li-row li-sub mono">{p.baseUrl} · {p.keyHint} · {p.lastStatus}</div>
          <div className="li-row li-actions">
            <select
              className="input"
              style={{ flex: 1 }}
              value={p.activeModel ?? ''}
              disabled={p.models.length === 0}
              onChange={(e) => act(p.id, 'select-model', { model: e.target.value })}
            >
              {p.models.length === 0 && <option value="">未识别到模型</option>}
              {p.models.map((m) => (
                <option key={m} value={m}>{m}{m === p.activeModel ? ' ✓ 当前' : ''}</option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={busy} onClick={() => act(p.id, 'probe')}>重新探测</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => act(p.id, 'enable', { enabled: !p.enabled })}>{p.enabled ? '停用' : '启用'}</button>
            <button className="btn btn-sm btn-sell" disabled={busy} onClick={() => del(p.id)}>删除</button>
          </div>
        </div>
      ))}

      <style>{`
        .llm-form { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .llm-item { border-top: 1px dashed var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 5px; }
        .li-row { display: flex; align-items: center; gap: 8px; }
        .li-name { font-family: var(--font-ui); font-size: 12px; font-weight: 700; color: var(--text-main); }
        .li-sub { font-size: 9px; color: var(--text-weak); word-break: break-all; }
        .li-actions { flex-wrap: wrap; }
        .chip-cyan, .chip-green, .chip-gray { font-family: var(--font-mono); font-size: 9px; padding: 1px 7px; border-radius: 8px; border: 1px solid var(--border-strong); }
      `}</style>
    </div>
  )
}

export default function SettingsPage() {
  const { state, dispatch } = useStore()
  const [riskLimit, setRiskLimit] = useState(state.risk.maxAllocPct)
  const [maxDrawdown, setMaxDrawdown] = useState(state.risk.maxDrawdownPct)
  const [leverage, setLeverage] = useState(state.risk.leverage)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    'ETH-USDC': true, 'BTC-USDC': true, 'SOL-USDC': true, 'ARB-USDC': false, 'OP-USDC': false,
  })
  const [autoEvolve, setAutoEvolve] = useState(true)
  const [x402Auto, setX402Auto] = useState(true)
  const [llmGate, setLlmGate] = useState(false)

  const save = () => {
    dispatch({ type: 'SET_RISK', risk: { maxAllocPct: riskLimit, maxDrawdownPct: maxDrawdown, leverage } })
    pushToast(dispatch, `💾 偏好已保存至本机 · 限额 ${riskLimit}% · 回撤 ${maxDrawdown}% · 杠杆 ${leverage}x（未接入执行层）`)
  }

  const reset = () => {
    dispatch({ type: 'RESET_SIM' })
    setRiskLimit(state.risk.maxAllocPct)
    setMaxDrawdown(state.risk.maxDrawdownPct)
    setLeverage(state.risk.leverage)
  }

  const kpis: KpiItem[] = [
    { label: '风险限额', value: `${riskLimit}%`, valueColor: 'var(--warning)', meta: '单策略最大资金占比', metaColor: 'var(--text-sub)' },
    { label: '最大回撤', value: `${maxDrawdown}%`, valueColor: 'var(--up)', meta: '执行层风控待阶段 C 接入', metaColor: 'var(--warning)' },
    { label: '杠杆上限', value: `${leverage}x`, valueColor: 'var(--primary)', meta: '偏好值 · 当前无合约引擎', metaColor: 'var(--text-sub)' },
    { label: '启用交易对', value: `${Object.values(enabled).filter(Boolean).length}/5`, valueColor: 'var(--down)', meta: '本机偏好，不拦截下单', metaColor: 'var(--warning)' },
    { label: '当前模式', value: MODE_META[state.mode].label, valueColor: state.mode === 'live' ? 'var(--up)' : 'var(--accent)', meta: MODE_META[state.mode].desc, metaColor: 'var(--warning)' },
  ]

  return (
    <div className="content-area">
      <KpiRow items={kpis} height={96} />

      <div className="settings-grid">
        {/* 风控 */}
        <div className="set-card">
          <span className="set-title">风控参数</span>
          <div className="set-row">
            <span className="set-label">单策略风险限额</span>
            <div className="set-slider">
              <input type="range" min={5} max={60} value={riskLimit} onChange={(e) => setRiskLimit(Number(e.target.value))} />
              <span className="set-val">{riskLimit}%</span>
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">最大回撤容忍</span>
            <div className="set-slider">
              <input type="range" min={3} max={30} value={maxDrawdown} onChange={(e) => setMaxDrawdown(Number(e.target.value))} />
              <span className="set-val">{maxDrawdown}%</span>
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">杠杆倍数</span>
            <div className="seg">
              {[1, 2, 3, 5].map((l) => (
                <button key={l} className={leverage === l ? 'on' : ''} onClick={() => setLeverage(l)}>{l}x</button>
              ))}
            </div>
          </div>
          <div className="set-hint">⚠️ 以上为偏好设置，仅保存在本机浏览器；下单前硬风控（限额/回撤/白名单拦截）将在阶段 C 的独立风控服务中实现。</div>
        </div>

        {/* 交易对 */}
        <div className="set-card">
          <span className="set-title">交易市场</span>
          {Object.entries(enabled).map(([sym, on]) => (
            <div key={sym} className="set-row">
              <span className="set-label mono">{sym}</span>
              <div className={`switch ${on ? 'on' : ''}`} onClick={() => setEnabled((m) => ({ ...m, [sym]: !m[sym] }))} />
            </div>
          ))}
        </div>

        {/* 自动化 */}
        <div className="set-card">
          <span className="set-title">自动化</span>
          <div className="set-row">
            <span className="set-label">自进化引擎</span>
            <div className={`switch ${autoEvolve ? 'on' : ''}`} onClick={() => { setAutoEvolve((v) => !v); pushToast(dispatch, autoEvolve ? '⏸ 自进化已关闭' : '▶️ 自进化已开启') }} />
          </div>
          <div className="set-row">
            <span className="set-label">x402 自动结算</span>
            <div className={`switch ${x402Auto ? 'on' : ''}`} onClick={() => setX402Auto((v) => !v)} />
          </div>
          <div className="set-row">
            <span className="set-label">LLM 决策门槛</span>
            <div className={`switch ${llmGate ? 'on' : ''}`} onClick={() => setLlmGate((v) => !v)} />
          </div>
          <div className="set-hint">LLM 经「LLM 厂商管理」接入后，仅以只提案方式产出 candidate（结构化提案经严格校验，无任何下单通路）。</div>
        </div>

        <LlmProvidersCard />

        {/* 保存区 */}
        <div className="set-card action-card">
          <span className="set-title">应用与维护</span>
          <button className="btn btn-primary btn-lg full" onClick={save}>💾 保存全部设置</button>
          <button className="btn full" onClick={reset}>🔄 重置模拟数据</button>
          <button className="btn full" onClick={() => pushToast(dispatch, '📋 已导出系统配置 JSON')}>📋 导出配置</button>
          <div className="set-hint">
            当前世代 Gen-{state.gen} · 种群 {state.population} · 运行 {Math.floor(state.uptimeSec / 60)}m
          </div>
        </div>

        <style>{`
          .settings-grid {
            flex: 1; min-height: 0;
            display: grid; grid-template-columns: repeat(2, 1fr);
            grid-template-rows: repeat(2, minmax(0, 1fr));
            gap: 12px; overflow-y: auto;
          }
          .set-card {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; padding: 14px 16px;
            display: flex; flex-direction: column; gap: 12px;
            min-height: 0; justify-content: flex-start;
          }
          .set-title { font-family: var(--font-ui); font-size: 14px; font-weight: 700; color: var(--text-main); padding-bottom: 6px; border-bottom: 1px solid var(--border); }
          .set-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
          .set-label { font-family: var(--font-ui); font-size: 12px; color: var(--text-sub); }
          .set-label.mono { font-family: var(--font-mono); font-weight: 600; color: var(--text-main); }
          .set-slider { display: flex; align-items: center; gap: 10px; flex: 1; max-width: 220px; }
          .set-slider input[type='range'] { flex: 1; accent-color: var(--primary); }
          .set-val { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--primary); width: 44px; text-align: right; }
          .set-hint { font-family: var(--font-ui); font-size: 10px; line-height: 1.6; color: var(--text-weak); margin-top: auto; }
          .btn.full { width: 100%; }
        `}</style>
      </div>
    </div>
  )
}
