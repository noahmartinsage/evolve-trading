import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/Store'
import {
  getMissionStatus,
  planMission,
  startMission,
  type MissionPlanResponse,
  type MissionPlanView,
  type MissionReasonView,
  type MissionSeverity,
  type MissionStartResult,
  type MissionStatusView,
  type StartConsentView,
} from '../orch/client.ts'
import { MISSION_EXAMPLES } from './missionExamples.ts'

// ───────────────────────────── 文案表 ─────────────────────────────
// 全部集中在这里，为的是「同一件事只有一种说法」：
// 结论词、阶段词、槽位词一旦散落在 JSX 里，很快就会在三个地方长出三种讲法。

const VERDICT_WORD: Record<string, string> = {
  feasible: '可以做',
  infeasible: '做不成',
  unverifiable: '还不能判',
}

const VERDICT_DESC: Record<string, string> = {
  feasible: '目标本身没有硬矛盾，第一笔仓位也开得出来。可以拿口令启动。',
  infeasible: '这句话里有互相矛盾的条件，或者第一笔仓位根本开不出来。改目标再来。',
  unverifiable: '不是不行，是「还不知道」—— 缺前置条件或缺证据。补上之后重说一次，结论会变。',
}

/**
 * `hold` 与 `block` 的面板用词必须分开。
 *
 * 「缺」是"我还不知道"，「挡」是"不行"。合成一个词，用户就会把
 * "还没判"读成"判死"，然后去改一个本来没问题的目标。
 */
const SEV_WORD: Record<MissionSeverity, string> = {
  block: '挡',
  hold: '缺',
  warn: '注意',
  info: '说明',
}

const SEVERITY_ORDER: MissionSeverity[] = ['block', 'hold', 'warn', 'info']

const STAGE_WORD: Record<string, string> = {
  idle: '未运行',
  accumulating: '累积证据',
  optimizing: '参数寻优',
  trading: '交易中',
  target_reached: '达标',
  drawdown_stopped: '回撤熔断',
}

const SLOT_WORD: Record<string, string> = {
  venue: '在哪做',
  startNotional: '起始金额',
  targetNotional: '目标金额',
  deadline: '时限',
  symbol: '标的',
}

const EXEC_WORD: Record<string, string> = {
  paper: '本地记账',
  testnet: '场所模拟盘',
  live: '真实资金',
}

// 三个例句住在 `missionExamples.ts` —— 因为 `mission-smoke` 的 S-M3b 会真的
// 把它们喂进裁定器，断言仍然**三态互不相同**。留在本文件里就没法被门禁读到，
// 题面与判据一旦分岔（改上限 / 换场所 / 调阈值）也不会有人报红。
// 每一句各自落在哪条支路上，以及原来的三句为什么**全都**落"做不成"，都写在那个文件里。

/** 服务端用 4xx 表达"这句话我判不了"时的说法。**不是连通故障**，所以不能混为一谈。 */
const PLAN_ERROR_WORD: Record<string, string> = {
  EMPTY_TEXT: '目标不能是空的 —— 说一句"在哪、多少钱、做到多少、多久"就行。',
  TEXT_TOO_LONG: '目标超过 300 字了。裁定结论是要念出来的，太长会把澄清和目标混在一起，拆开说。',
  UNAUTHORIZED: '编排层不认这个令牌。在参数设置里核对一下编排令牌。',
}

// ───────────────────────────── 小工具 ─────────────────────────────

function money(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * 百分比格式化 —— **刻意分成两个函数，因为服务端本来就混着两种单位。**
 *
 * 实测踩过：界面上「单笔盈利」显示成 `+0.02%`，而正确值是 `+2.00%`。
 * 根因不是手滑，而是接口里 `...Pct` 这个名字同时表示两种东西：
 *   · `plan.targetPct`        = 12      —— **已经是百分数**
 *   · `required.winPct`       = 0.02    —— **分数**（0.02 = 2%）
 *   · `required.impliedWinRate` = 0.643 —— **分数**
 *   · `env.stopPct`           = 0.018   —— **分数**
 * 一个 `pct(v)` 通吃，就必然有一半调用点算错，而且错得不显眼（0.02% 看着也挺像个数）。
 * 所以把单位写进函数名：看错单位在调用点上是**看得见**的。
 */
function pctFromFraction(frac: number | null | undefined, digits = 2): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return '—'
  const v = frac * 100
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

/** 给**已经是百分数**的值（12 → `+12.00%`）。带正负号，用于"涨跌"语义。 */
function pctPlain(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

/** 比率（胜率之类）**不带正负号** —— 64.3% 不是"涨了 64.3%"。 */
function rate(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

/** `Duration` → 「1天」/「3小时」/「45分钟」。解析器给的是时长，不是时间戳。 */
function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const d = ms / 86_400_000
  if (d >= 1) return `${Number.isInteger(d) ? d : d.toFixed(1)} 天`
  const h = ms / 3_600_000
  if (h >= 1) return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`
  return `${Math.round(ms / 60_000)} 分钟`
}

function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(t / 60)
  const s = t % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function clockTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ───────────────────────────── 子组件 ─────────────────────────────

function EnvChip({ label, value, tone }: { label: string; value: string; tone?: 'cyan' | 'plain' }) {
  return (
    <div className="mp-chip">
      <span className="mp-chip-l">{label}</span>
      <span className={tone === 'cyan' ? 'mp-chip-v cyan' : 'mp-chip-v'}>{value}</span>
    </div>
  )
}

/** 识别结果。`missing` 单列出来 —— 那是「缺哪件」的答案，不该埋在备注里。 */
function SpecGrid({ plan }: { plan: MissionPlanView }) {
  const s = plan.spec
  const rows: Array<[string, string]> = [
    ['在哪做', s.venue ?? '没说'],
    ['执行形态', EXEC_WORD[s.execution] ?? s.execution],
    ['标的', s.symbol ?? '没说'],
    ['起始金额', s.startNotional === null ? '没说' : money(s.startNotional)],
    ['目标金额', s.targetNotional === null ? '没说' : money(s.targetNotional)],
    ['倍数', s.targetMultiple === null ? '—' : `${s.targetMultiple}×`],
    ['时限', duration(s.deadlineMs)],
    ['杠杆', s.explicitLeverage !== null ? `${s.explicitLeverage}×（用户明说）` : s.allowHighLeverage ? '不限，允许高倍' : '未提'],
    ['读准程度', `${Math.round(s.confidence * 100)}%`],
  ]
  return (
    <div className="mp-card">
      <div className="mp-card-head">
        <div className="mp-card-title">我从这句话里读到的</div>
        <div className="mp-hint">读不出的一律显示「没说」——不替你补默认值。补出来的数是假数。</div>
      </div>
      <div className="mp-grid">
        {rows.map(([k, v]) => (
          <div className="mp-kv" key={k}>
            <span className="mp-kv-k">{k}</span>
            <span className="mp-kv-v">{v}</span>
          </div>
        ))}
      </div>
      {s.missing.length > 0 && (
        <div className="mp-missing">
          <span className="mp-missing-l">缺这几件</span>
          {s.missing.map((m) => (
            <span className="mp-slot" key={m}>{SLOT_WORD[m] ?? m}</span>
          ))}
          <span className="mp-missing-note">补齐任意一件后重新说一次，结论会重算。</span>
        </div>
      )}
    </div>
  )
}

function ReasonRow({ r }: { r: MissionReasonView }) {
  const nums = r.numbers ? Object.entries(r.numbers).filter(([, v]) => v !== null && v !== undefined) : []
  return (
    <div className={`mp-reason ${r.severity}`}>
      <div className="mp-reason-head">
        <span className={`mp-sev ${r.severity}`}>{SEV_WORD[r.severity]}</span>
        <span className="mp-reason-text">{r.text}</span>
      </div>
      <div className="mp-reason-foot">
        <code className="mp-code">{r.code}</code>
        {nums.length > 0 && (
          <span className="mp-nums mono">
            {nums.map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v)}`).join(' · ')}
          </span>
        )}
      </div>
    </div>
  )
}

function Reasons({ reasons }: { reasons: MissionReasonView[] }) {
  // 按严重程度分组，而不是按产生顺序。用户找的是"为什么不行"，不是"代码跑到哪一行了"。
  const groups = useMemo(() => {
    return SEVERITY_ORDER
      .map((sev) => ({ sev, items: reasons.filter((r) => r.severity === sev) }))
      .filter((g) => g.items.length > 0)
  }, [reasons])

  if (reasons.length === 0) {
    return (
      <div className="mp-card">
        <div className="mp-card-head"><div className="mp-card-title">裁定理由</div></div>
        <div className="mp-empty">一条理由都没有：所有前置条件都过了，也没有需要提醒的。</div>
      </div>
    )
  }

  return (
    <div className="mp-card">
      <div className="mp-card-head">
        <div className="mp-card-title">裁定理由</div>
        <div className="mp-hint">
          按「挡 / 缺 / 注意 / 说明」四档分组。「挡」才是"做不成"，「缺」只是"还不知道"。
        </div>
      </div>
      <div className="mp-reasons">
        {groups.map((g) => (
          <div className="mp-reason-group" key={g.sev}>
            {g.items.map((r, i) => <ReasonRow key={`${r.code}-${i}`} r={r} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

function SizingCard({ plan }: { plan: MissionPlanView }) {
  const z = plan.sizing
  if (!z) return null
  const rows: Array<[string, string, string?]> = [
    ['1R 风险额', `${money(z.riskBudget)} U`, '单笔能亏多少钱。由权益 × 止损幅度算出。'],
    ['按风险反推的名义', `${money(z.plannedNotional)} U`, `真正卡住规模的是「${z.binding}」。`],
    ['场所最小可行规模', `${money(z.minViableNotional)} U`, '小于它，订单根本挂不出去。'],
    ['开第一笔所需权益', z.minViableEquity === null ? '算不出' : `${money(z.minViableEquity)} U`, '算不出 ≠ 不需要，是参数没给全。'],
    ['安全杠杆上限', `${z.maxSafeLeverage}×`, '由止损距离反推。'],
    ['当前配置杠杆', `${z.configuredLeverage}×`, ''],
  ]
  return (
    <div className="mp-card">
      <div className="mp-card-head">
        <div className="mp-card-title">第一笔仓位开得出来吗</div>
        <div className="mp-hint">这一关比「赚不赚得到」更早。开不出第一笔，后面全都是空谈。</div>
      </div>
      <div className="mp-grid three">
        {rows.map(([k, v, note]) => (
          <div className="mp-kv" key={k} title={note}>
            <span className="mp-kv-k">{k}</span>
            <span className="mp-kv-v">{v}</span>
            {note && <span className="mp-kv-n">{note}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function RequiredCard({ plan }: { plan: MissionPlanView }) {
  const r = plan.required
  if (!r) return null
  return (
    <div className="mp-card">
      <div className="mp-card-head">
        <div className="mp-card-title">要打到目标，得打出多少笔</div>
        <div className="mp-hint">用满当日亏损额度的前提下，这是盈利笔数的下界。</div>
      </div>
      <div className="mp-grid three">
        <div className="mp-kv"><span className="mp-kv-k">单笔盈利</span><span className="mp-kv-v">{pctFromFraction(r.winPct)}</span></div>
        <div className="mp-kv"><span className="mp-kv-k">单笔亏损</span><span className="mp-kv-v">{pctFromFraction(-r.lossPct)}</span></div>
        <div className="mp-kv"><span className="mp-kv-k">允许亏几笔</span><span className="mp-kv-v">{r.maxLosses} 笔</span></div>
        <div className="mp-kv"><span className="mp-kv-k">至少盈利</span><span className="mp-kv-v">{r.requiredWins} 笔</span></div>
        <div className="mp-kv"><span className="mp-kv-k">隐含胜率下界</span><span className="mp-kv-v">{rate(r.impliedWinRate)}</span></div>
        <div className="mp-kv"><span className="mp-kv-k">折合每小时</span><span className="mp-kv-v">{r.winsPerHour.toFixed(1)} 笔盈利</span></div>
      </div>
    </div>
  )
}

function AlternativeCard({ plan }: { plan: MissionPlanView }) {
  const a = plan.alternative
  if (!a) return null
  return (
    <div className="mp-card alt">
      <div className="mp-card-head">
        <div className="mp-card-title">在现有条件下，系统能接受的目标</div>
        <div className="mp-hint">下面每条都是能照着做的动作，不是安慰话。</div>
      </div>
      <div className="mp-alt-top">
        <div className="mp-kv"><span className="mp-kv-k">可接受目标</span><span className="mp-kv-v cyan">{pctPlain(a.targetPct)}</span></div>
        <div className="mp-kv">
          <span className="mp-kv-k">还需最小权益</span>
          <span className="mp-kv-v">{a.minEquity === null ? '不需要调整' : `${money(a.minEquity)} U`}</span>
        </div>
      </div>
      <ul className="mp-notes">
        {a.notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  )
}

/**
 * 启动口令。
 *
 * 这块 UI 存在的唯一理由：让「启动」这件事**必须经过人**。
 * 所以刻意做了三件看起来"多余"的事，它们都不是形式主义：
 *   ① 口令码显示出来但**不预填** —— 预填等于把这道手续删掉；
 *   ② 倒计时到 0 就**禁用按钮**并说明原因，而不是让用户点一下再收一个拒绝；
 *   ③ 明说"念给桌宠和在这里输入是同一条路" —— 否则用户会以为面板更"正式"。
 */
function ConsentPanel({
  consent,
  planId,
  onStarted,
}: {
  consent: StartConsentView
  planId: string | null
  onStarted: (r: MissionStartResult) => void
}) {
  const { state } = useStore()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [left, setLeft] = useState('')
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 直接用服务端的绝对时间戳，不做本地重锚。
  //
  // 曾经想过"按本机时钟修正一次偏差"，但那样会掩盖一件事：
  // 判定口令是否有效的是**服务端**（`checkStartConsent` 用服务端的 now），
  // 本地倒计时只是给人看的预告。如果本地重锚让它显示"还剩 2 分钟"
  // 而服务端已经判过期，用户就会拿到一个"明明还有时间却说过期了"的拒绝 ——
  // 一个只用于预告的显示，不该有权改判。
  // 偏差真实存在时，症状是倒计时和服务端判定错开，那是能看出来的；藏起来才看不出来。
  const remainingMs = consent.expiresAt - now
  const expired = remainingMs <= 0

  // 剩余尝试次数以口令自己的计数为准（每次校验失败由服务端递增）。
  const attemptsLeft = useMemo(() => {
    if (left !== '') return Number(left)
    return consent.remainingAttempts
  }, [left, consent.remainingAttempts])

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || busy || expired) return
    setBusy(true)
    setErr('')
    try {
      // 整句话原样送上：服务端自己抽口令词与口令码，与语音通道**完全同一条路**。
      const r = await startMission(state.orchUrl, state.orchToken, { planId: planId ?? undefined, utterance: text })
      if (r.ok) {
        onStarted(r)
        setDraft('')
      } else {
        // ★ 被拒 ≠ 没连上。服务端用 422 + `reason` 表达"这次不允许"，
        //   那是**业务结果**，要原样显示；只有 0（fetch 自己抛了）才是连通问题。
        //   实测踩过：把 422 当成网络故障，界面会让人去查端口，而正确动作是重念口令。
        setErr(r.reason ?? `启动被拒（${r.code ?? 'HTTP ' + r.httpStatus}）`)
        if (typeof r.remainingAttempts === 'number') setLeft(String(r.remainingAttempts))
        inputRef.current?.focus()
      }
    } catch (e) {
      setErr(
        `连不上编排服务（${e instanceof Error ? e.message : String(e)}）。` +
          '裁定与启动都走编排层，先在系统监控页确认它在线 —— 桌面图标启动的话，编排在 8790。',
      )
    } finally {
      setBusy(false)
    }
  }, [draft, busy, expired, state.orchUrl, state.orchToken, planId, onStarted])

  const dead = expired || attemptsLeft <= 0

  return (
    <div className={`mp-card consent${dead ? ' dead' : ''}`}>
      <div className="mp-card-head">
        <div className="mp-card-title">启动口令</div>
        <div className="mp-hint">
          口令只管 {Math.round((consent.expiresAt - consent.issuedAt) / 60000)} 分钟、用一次。
          它放行的是「现在动手」，不是「目标成立」—— 目标没成立时它压根不会签发。
        </div>
      </div>

      <div className="mp-consent-body">
        <div className="mp-code-box">
          <div className="mp-code-digits mono">{consent.code}</div>
          <div className="mp-code-spoken">
            念作 <b className="mono">{consent.spoken}</b>
            <span className="mp-code-why">
              （语音合成会把 {consent.code} 读成「四千八百二十一」，所以各位之间留空）
            </span>
          </div>
          <div className={`mp-code-timer${dead ? ' dead' : remainingMs < 120_000 ? ' low' : ''}`}>
            {expired
              ? `已于 ${clockTime(consent.expiresAt)} 过期`
              : `还剩 ${mmss(remainingMs)}`}
            <span className="mp-code-att">
              {'  '}机会 {attemptsLeft}/{consent.remainingAttempts + consent.attempts}
            </span>
          </div>
        </div>

        <div className="mp-consent-form">
          <label className="mp-consent-label">把口令说全，念「确认启动」加这四位数字：</label>
          <div className="mp-consent-row">
            <input
              ref={inputRef}
              className="input mp-consent-input"
              value={draft}
              placeholder="确认启动 4 8 2 1"
              spellCheck={false}
              disabled={dead || busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            />
            <button
              className="btn btn-primary btn-lg"
              disabled={dead || busy || draft.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? '启动中…' : '启动任务'}
            </button>
          </div>
          {dead && (
            <div className="mp-consent-dead">
              {expired
                ? '这份口令已经过期。目标没变的话，把上面那句话重新说一次，我给你新口令。'
                : '这份口令已经作废（错满 3 次）。重新裁定一次才有新口令 —— 这是刻意的，口令错满之后不该还能继续猜。'}
            </div>
          )}
          {!dead && (
            <div className="mp-consent-alt">
              同样的这句话，直接念给桌宠效果完全一样 —— 两条通道走的是同一个校验，
              没有"面板更正式"这回事。
            </div>
          )}
          {err && <div className="mp-consent-err">{err}</div>}
        </div>
      </div>
    </div>
  )
}

/**
 * 启动之后该说什么 —— 这块比"成功"两个字重要得多。
 *
 * 本项目实测（F-47）：paper 模式下循环会**长期停在「累积证据」**，
 * 因为过拟合门要够长的历史才放行交易。这是正确行为，不是卡住，
 * 但一个只显示"已启动 ✓"的界面会让用户第二天来问"为什么一笔没做"。
 * 所以这里把下一段会发生什么直接写在结果里。
 */
function StartResult({ r, stage, running }: { r: MissionStartResult; stage: string; running: boolean }) {
  return (
    <div className="mp-card started">
      <div className="mp-card-head">
        <div className="mp-card-title">已启动</div>
        <div className="mp-hint">口令已用掉，同一份裁定书不能再启动第二次。</div>
      </div>
      <div className="mp-grid three">
        <div className="mp-kv"><span className="mp-kv-k">循环</span><span className="mp-kv-v cyan">{running ? '运行中' : '未运行'}</span></div>
        <div className="mp-kv"><span className="mp-kv-k">当前阶段</span><span className="mp-kv-v">{STAGE_WORD[stage] ?? stage}</span></div>
        <div className="mp-kv"><span className="mp-kv-k">目标</span><span className="mp-kv-v">{r.plan ? pctPlain(r.plan.targetPct) : '—'}</span></div>
      </div>
      <div className="mp-next">
        <b>接下来会发生什么：</b>
        {stage === 'accumulating' || stage === 'optimizing' ? (
          <>循环会先停在<b>累积证据</b>这一段，攒够 K 线才进参数寻优，再进交易阶段。
            所以短时间内看不到成交是正常的 —— 这是过拟合门在起作用，不是卡住了。
            它拦的是"拿不够长的历史去调参"这件事。</>
        ) : stage === 'trading' ? (
          <>循环已经进入交易阶段，接下来按系统自己的风控逐笔决策。</>
        ) : (
          <>循环已就绪，阶段会随时间推进。到交易阶段之前不会有成交。</>
        )}
        {' '}阶段与成交都会实时出现在系统监控页。
      </div>
    </div>
  )
}

// ───────────────────────────── 主页面 ─────────────────────────────

export default function MissionPage() {
  const { state } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [resp, setResp] = useState<MissionPlanResponse | null>(null)
  const [status, setStatus] = useState<MissionStatusView | null>(null)
  const [started, setStarted] = useState<MissionStartResult | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const s = await getMissionStatus(state.orchUrl, state.orchToken)
      setStatus(s)
      return s
    } catch {
      // 状态拉不到不该刷红字：裁定与启动两条主路会各自报自己的错。
      return null
    }
  }, [state.orchUrl, state.orchToken])

  useEffect(() => { void loadStatus() }, [loadStatus])

  // 启动之后短轮询几次，把阶段变化显示出来 —— 一次性读会永远停在旧阶段。
  useEffect(() => {
    if (!started) return
    const t = setInterval(() => { void loadStatus() }, 3000)
    return () => clearInterval(t)
  }, [started, loadStatus])

  const runPlan = useCallback(async () => {
    const t = text.trim()
    if (t.length === 0 || busy) return
    setBusy(true)
    setErr('')
    setStarted(null)
    try {
      const o = await planMission(state.orchUrl, state.orchToken, t)
      if (o.data) {
        setResp(o.data)
      } else {
        // 4xx 是"这句话我没法判"，不是"服务没连上"。分开说，用户才知道下一步做什么。
        setResp(null)
        setErr(PLAN_ERROR_WORD[o.errorCode ?? ''] ?? `裁定被拒（HTTP ${o.httpStatus}）`)
      }
    } catch (e) {
      setResp(null)
      setErr(
        `连不上编排服务（${e instanceof Error ? e.message : String(e)}）。` +
          '裁定与启动都走编排层，先在系统监控页确认它在线 —— 桌面图标启动的话，编排在 8790。',
      )
    } finally {
      setBusy(false)
    }
  }, [text, busy, state.orchUrl, state.orchToken])

  const onStarted = useCallback((r: MissionStartResult) => {
    setStarted(r)
    void loadStatus()
  }, [loadStatus])

  const plan = resp?.plan ?? null
  const consent = resp?.consent ?? null
  const ap = status?.autopilot

  return (
    <div className="content-area mp-page">
      <div className="mp-top">
        <div className="mp-top-l">
          <div className="mp-title">任务</div>
          {/* 副标题刻意**不**复述顶栏那句流程（顶栏已经写了一遍）。
              这里放的是这一层最容易误解的一点：口令管的是"现在动手"，不是"目标成立"。 */}
          <div className="mp-sub">口令放行的是「现在动手」，不是「目标成立」—— 目标不成立时它压根不会签发。</div>
        </div>
        <div className="mp-env">
          {status && (
            <>
              <EnvChip label="订单去向" value={status.env.wiredVenue} />
              <EnvChip label="成本口径" value={status.env.accountingVenue} />
              <EnvChip label="权益" value={`${money(status.env.equity, 0)} U`} />
              <EnvChip label="目标上限" value={`+${status.targetMaxPct}%`} tone="cyan" />
              <EnvChip label="止损垫" value={`${(status.env.stopPct * 100).toFixed(2)}%`} />
              <div className={ap?.running ? 'mp-ap on' : 'mp-ap'}>
                <i />
                自动驾驶 {ap ? (STAGE_WORD[ap.stage] ?? ap.stage) : '读不到'}
              </div>
            </>
          )}
          {!status && <div className="mp-ap off"><i />编排层未连接（8790）</div>}
        </div>
      </div>

      <div className="mp-body">
        {/* ── 输入 ── */}
        <div className="mp-card">
          <div className="mp-card-head">
            <div className="mp-card-title">你的目标</div>
            <div className="mp-hint">
              要说清四件事：在哪做、多少钱、做到多少、多久。缺哪件我会直接说缺哪件，不会替你补。
            </div>
          </div>
          <textarea
            className="mp-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例：用10U在OKX测试网做到100U，1天内，可以用高倍合约杠杆"
            rows={2}
            maxLength={300}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void runPlan() }
            }}
          />
          <div className="mp-examples">
            <span className="mp-examples-l">试试其中一句：</span>
            {MISSION_EXAMPLES.map((ex) => (
              <button
                key={ex}
                className="mp-example"
                onClick={() => setText(ex)}
                title="填入输入框"
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="mp-actions">
            <button
              className="btn btn-primary btn-lg"
              disabled={busy || text.trim().length === 0}
              onClick={() => void runPlan()}
            >
              {busy ? '正在量…' : '裁定'}
            </button>
            <span className="mp-actions-hint">
              {text.length > 0 ? `${text.length} / 300` : '⌘/Ctrl + Enter 也可以'}
            </span>
            {err && <span className="mp-err">{err}</span>}
          </div>
        </div>

        {/* ── 不是任务 ── */}
        {resp && !plan && (
          <div className="mp-card">
            <div className="mp-empty">
              这句话我没读成一个任务（{resp.spec.confidence === 0 ? '没有认出任何目标要素' : `读准程度 ${Math.round(resp.spec.confidence * 100)}%`}）。
              换成「在哪儿、多少钱、做到多少、多久」这样的说法再试一次。
            </div>
          </div>
        )}

        {/* ── 裁定书 ── */}
        {resp && plan && (
          <>
            <div className={`mp-verdict ${plan.verdict}`}>
              <div className="mp-verdict-l">
                <div className="mp-verdict-word">{VERDICT_WORD[plan.verdict]}</div>
                <div className="mp-verdict-desc">{VERDICT_DESC[plan.verdict]}</div>
              </div>
              <div className="mp-verdict-r">
                <div className="mp-vr-row">
                  <span>目标</span>
                  <b className="mono">{pctPlain(plan.targetPct)}{plan.targetMultiple ? ` · ${plan.targetMultiple}×` : ''}</b>
                </div>
                <div className="mp-vr-row">
                  <span>裁定时刻</span>
                  <b className="mono">{clockTime(plan.assessedAt)}</b>
                </div>
                <div className="mp-vr-row">
                  <span>裁定书</span>
                  <b className="mono" title={plan.planId}>{plan.planId.slice(0, 12)}…</b>
                </div>
              </div>
            </div>

            {/* 说给用户听的那句话也展示出来 —— 语音与面板应当是同一套说法。 */}
            {resp.spoken && (
              <div className="mp-spoken">
                <span className="mp-spoken-l">系统原话</span>
                <span className="mp-spoken-t">{resp.spoken}</span>
              </div>
            )}

            <SpecGrid plan={plan} />
            <Reasons reasons={plan.reasons} />
            <SizingCard plan={plan} />
            <RequiredCard plan={plan} />
            <AlternativeCard plan={plan} />

            {resp.redaction.hits > 0 && (
              <div className="mp-card redact">
                <div className="mp-card-head"><div className="mp-card-title">脱敏提醒</div></div>
                <div className="mp-empty">
                  这句话里有 {resp.redaction.hits} 处像凭据的片段（{resp.redaction.hitNames.join('、') || '—'}），
                  写进账本前已经盖掉了。它们不会离开本机。
                </div>
              </div>
            )}
          </>
        )}

        {/* ── 口令 ── */}
        {consent && !started && (
          // 用 issuedAt 当 key：重新裁定会签发新口令，而组件实例若被复用，
          // 上一份口令的失败次数会残留到新口令上 —— 用户会看到"机会 0/3"
          // 而服务端那边其实是满的。
          <ConsentPanel
            key={consent.issuedAt}
            consent={consent}
            planId={resp?.planId ?? null}
            onStarted={onStarted}
          />
        )}

        {plan && !consent && plan.verdict !== 'feasible' && (
          <div className="mp-card no-consent">
            <div className="mp-empty">
              这次没有口令 —— 口令只在结论是「可以做」时才签发。
              现在给一把钥匙，等于给你一把能开一扇不存在的门的钥匙：
              你会拿着它反复念，收到的却是一串与目标无关的拒绝理由。
            </div>
          </div>
        )}

        {/* ── 启动结果 ── */}
        {started && (
          <StartResult
            r={started}
            stage={status?.autopilot.stage ?? 'unknown'}
            running={status?.autopilot.running ?? false}
          />
        )}
      </div>

      <style>{`
        .mp-page { overflow: hidden; }
        /* 内层滚动区刻意**不**复用 .content-area：
           复用的话滚动能不能生效取决于两份样式在文件里的先后（.content-area 是 overflow:hidden），
           也就是说某次调整样式顺序就会静默把下半页内容变成够不着的。
           自己把 flex:1 / min-height:0 写全，结论就不再取决于顺序。 */
        .mp-body { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; gap: 12px; }
        .mp-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex-shrink: 0; }
        .mp-top-l { display: flex; flex-direction: column; gap: 3px; }
        .mp-title { font-family: var(--font-ui); font-size: 18px; font-weight: 800; color: var(--text-main); }
        .mp-sub { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }
        .mp-env { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

        .mp-chip {
          display: flex; align-items: center; gap: 5px;
          height: 22px; padding: 0 8px; border-radius: 6px;
          background: var(--bg-surface); border: 1px solid var(--border);
        }
        .mp-chip-l { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .mp-chip-v { font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--text-sub); }
        .mp-chip-v.cyan { color: var(--primary); }

        .mp-ap {
          display: flex; align-items: center; gap: 6px;
          height: 22px; padding: 0 9px; border-radius: 6px;
          font-family: var(--font-ui); font-size: 10px; font-weight: 600;
          background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-weak);
        }
        .mp-ap i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-weak); flex-shrink: 0; }
        .mp-ap.on { color: var(--down); border-color: rgba(0,214,143,0.4); }
        .mp-ap.on i { background: var(--down); animation: mpPulse 1.6s infinite; }
        .mp-ap.off { color: var(--warning); border-color: rgba(255,176,32,0.4); }
        .mp-ap.off i { background: var(--warning); }
        @keyframes mpPulse { 50% { opacity: 0.35; } }

        .mp-card {
          background: var(--bg-card); border: 1px solid var(--border);
          border-radius: 10px; padding: 11px 13px;
          display: flex; flex-direction: column; gap: 9px; flex-shrink: 0;
        }
        .mp-card-head { display: flex; flex-direction: column; gap: 3px; }
        .mp-card-title { font-family: var(--font-ui); font-size: 13px; font-weight: 700; color: var(--text-main); }
        .mp-hint { font-family: var(--font-ui); font-size: 10px; line-height: 1.6; color: var(--text-weak); }
        .mp-empty { font-family: var(--font-ui); font-size: 11px; line-height: 1.7; color: var(--text-sub); }

        .mp-textarea {
          width: 100%; resize: vertical; min-height: 52px;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 9px 11px; outline: none;
          font-family: var(--font-cn); font-size: 12.5px; line-height: 1.6;
          color: var(--text-main);
        }
        .mp-textarea:focus { border-color: var(--primary-40); box-shadow: 0 0 0 2px var(--primary-10); }
        .mp-textarea::placeholder { color: var(--text-weak); }

        .mp-examples { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .mp-examples-l { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
        .mp-example {
          border: 1px dashed var(--border-strong); background: transparent;
          border-radius: 6px; padding: 3px 8px; cursor: pointer;
          font-family: var(--font-cn); font-size: 10.5px; color: var(--text-sub);
          transition: all 0.15s;
        }
        .mp-example:hover { border-style: solid; border-color: var(--primary-40); color: var(--primary); }

        .mp-actions { display: flex; align-items: center; gap: 10px; }
        .mp-actions-hint { font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); }
        .mp-err {
          font-family: var(--font-ui); font-size: 11px; line-height: 1.6; color: var(--up);
          background: rgba(255,77,109,0.08); border-left: 2px solid var(--up);
          padding: 5px 8px; border-radius: 0 6px 6px 0; flex: 1;
        }

        /* 结论横幅：三态三色。绿=可以做，红=做不成，琥珀=还不知道。 */
        .mp-verdict {
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          border-radius: 10px; padding: 12px 14px; flex-shrink: 0;
          border: 1px solid var(--border-strong); background: var(--bg-card);
        }
        .mp-verdict-l { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .mp-verdict-word { font-family: var(--font-ui); font-size: 22px; font-weight: 800; letter-spacing: 1px; }
        .mp-verdict-desc { font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--text-sub); max-width: 620px; }
        .mp-verdict-r { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; min-width: 168px; max-width: 208px; }
        .mp-vr-row { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; min-width: 0; }
        .mp-vr-row span { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); flex-shrink: 0; }
        /* 裁定书 id 是内容哈希，长度固定且不短；不截断的话它会把这一行顶出卡片外。 */
        .mp-vr-row b { font-size: 11px; font-weight: 700; color: var(--text-main); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* var(--down) 在本项目里是**绿色**（遵循红涨绿跌，绿=跌）—— 这里借它当"通过"。 */
        .mp-verdict.feasible { border-color: rgba(0,214,143,0.45); background: rgba(0,214,143,0.06); }
        .mp-verdict.feasible .mp-verdict-word { color: var(--down); }
        .mp-verdict.infeasible { border-color: rgba(255,77,109,0.45); background: rgba(255,77,109,0.06); }
        .mp-verdict.infeasible .mp-verdict-word { color: var(--up); }
        .mp-verdict.unverifiable { border-color: rgba(255,176,32,0.45); background: rgba(255,176,32,0.06); }
        .mp-verdict.unverifiable .mp-verdict-word { color: var(--warning); }

        .mp-spoken {
          display: flex; gap: 10px; align-items: flex-start;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-left: 2px solid var(--primary); border-radius: 0 8px 8px 0;
          padding: 8px 11px; flex-shrink: 0;
        }
        .mp-spoken-l { font-family: var(--font-ui); font-size: 9px; color: var(--primary); flex-shrink: 0; padding-top: 2px; }
        .mp-spoken-t { font-family: var(--font-cn); font-size: 11.5px; line-height: 1.7; color: var(--text-sub); }

        .mp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .mp-grid.three { grid-template-columns: repeat(3, 1fr); }
        .mp-kv {
          display: flex; flex-direction: column; gap: 2px;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 7px; padding: 6px 9px; min-width: 0;
        }
        .mp-kv-k { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .mp-kv-v { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mp-kv-v.cyan { color: var(--primary); }
        .mp-kv-n { font-family: var(--font-ui); font-size: 9px; line-height: 1.5; color: var(--text-weak); }

        .mp-missing { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .mp-missing-l { font-family: var(--font-ui); font-size: 10px; color: var(--warning); }
        .mp-slot {
          font-family: var(--font-cn); font-size: 10.5px;
          color: var(--warning); background: rgba(255,176,32,0.12);
          border: 1px solid rgba(255,176,32,0.35); border-radius: 5px; padding: 2px 7px;
        }
        .mp-missing-note { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }

        .mp-reasons { display: flex; flex-direction: column; gap: 10px; }
        .mp-reason-group { display: flex; flex-direction: column; gap: 6px; }
        .mp-reason {
          display: flex; flex-direction: column; gap: 5px;
          background: var(--bg-surface); border: 1px solid var(--border);
          border-left-width: 2px; border-radius: 0 7px 7px 0; padding: 7px 10px;
        }
        .mp-reason-head { display: flex; align-items: flex-start; gap: 8px; }
        .mp-reason-text { font-family: var(--font-cn); font-size: 11.5px; line-height: 1.7; color: var(--text-main); }
        .mp-reason-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .mp-code { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
        .mp-nums { font-size: 9px; color: var(--text-weak); }

        .mp-sev {
          font-family: var(--font-ui); font-size: 9px; font-weight: 700;
          border-radius: 4px; padding: 2px 6px; flex-shrink: 0; margin-top: 1px;
        }
        /* 四档四色，从"挡"到"说明"逐级减重 —— 视觉重量就是严重程度，不允许只看颜色分辨。 */
        .mp-reason.block { border-left-color: var(--up); }
        .mp-sev.block { color: var(--up); background: rgba(255,77,109,0.13); }
        .mp-reason.hold { border-left-color: var(--signal); }
        .mp-sev.hold { color: var(--signal); background: rgba(255,135,0,0.13); }
        .mp-reason.warn { border-left-color: var(--warning); }
        .mp-sev.warn { color: var(--warning); background: rgba(255,176,32,0.11); }
        .mp-reason.info { border-left-color: var(--border-strong); }
        .mp-sev.info { color: var(--text-weak); background: rgba(151,160,181,0.1); }

        .mp-card.alt { border-color: rgba(34,211,238,0.3); }
        .mp-alt-top { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .mp-notes { display: flex; flex-direction: column; gap: 5px; padding-left: 16px; }
        .mp-notes li { font-family: var(--font-cn); font-size: 11.5px; line-height: 1.7; color: var(--text-sub); }

        .mp-card.redact { border-color: rgba(232,121,249,0.3); }
        .mp-card.no-consent { border-color: var(--border-strong); }

        /* ── 口令 ── */
        .mp-card.consent { border-color: rgba(34,211,238,0.4); background: linear-gradient(180deg, rgba(34,211,238,0.05), transparent 60%), var(--bg-card); }
        .mp-card.consent.dead { border-color: var(--border-strong); background: var(--bg-card); }
        .mp-consent-body { display: grid; grid-template-columns: 262px 1fr; gap: 14px; align-items: start; }

        .mp-code-box {
          display: flex; flex-direction: column; gap: 6px;
          background: var(--bg-surface); border: 1px solid var(--border-strong);
          border-radius: 9px; padding: 11px 13px;
        }
        .mp-code-digits {
          font-size: 34px; font-weight: 800; letter-spacing: 9px;
          color: var(--primary); line-height: 1.15; text-indent: 9px;
        }
        .mp-card.consent.dead .mp-code-digits { color: var(--text-weak); }
        .mp-code-spoken { font-family: var(--font-ui); font-size: 10.5px; color: var(--text-sub); }
        .mp-code-spoken b { color: var(--text-main); letter-spacing: 1px; }
        .mp-code-why { display: block; margin-top: 3px; font-size: 9px; line-height: 1.55; color: var(--text-weak); }
        .mp-code-timer { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--text-sub); }
        .mp-code-timer.low { color: var(--warning); }
        .mp-code-timer.dead { color: var(--up); }
        .mp-code-att { font-weight: 400; color: var(--text-weak); }

        .mp-consent-form { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
        .mp-consent-label { font-family: var(--font-cn); font-size: 11.5px; color: var(--text-sub); }
        .mp-consent-row { display: flex; gap: 8px; }
        .mp-consent-input { flex: 1; height: 38px; font-size: 14px; letter-spacing: 1.5px; }
        .mp-consent-input:disabled { opacity: 0.5; }
        .mp-consent-alt { font-family: var(--font-ui); font-size: 10px; line-height: 1.65; color: var(--text-weak); }
        .mp-consent-dead {
          font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--warning);
          background: rgba(255,176,32,0.08); border-left: 2px solid var(--warning);
          padding: 6px 9px; border-radius: 0 6px 6px 0;
        }
        .mp-consent-err {
          font-family: var(--font-ui); font-size: 11px; line-height: 1.65; color: var(--up);
          background: rgba(255,77,109,0.08); border-left: 2px solid var(--up);
          padding: 6px 9px; border-radius: 0 6px 6px 0;
        }

        .mp-card.started { border-color: rgba(0,214,143,0.4); }
        .mp-card.started .mp-card-title { color: var(--down); }
        .mp-next {
          font-family: var(--font-cn); font-size: 11.5px; line-height: 1.75; color: var(--text-sub);
          background: var(--bg-surface); border: 1px solid var(--border);
          border-radius: 7px; padding: 8px 11px;
        }
        .mp-next b { color: var(--text-main); }

        .mono { font-family: var(--font-mono); }
      `}</style>
    </div>
  )
}
