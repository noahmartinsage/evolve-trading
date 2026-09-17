/**
 * EVOLVE · 语音管家（合并后唯一入口）
 *
 * ── 这个页面合并了什么 ────────────────────────────────────────────────
 * 合并前是两个页面：「语音管家」（控制台）与「悬浮桌宠」（头像窗）。
 * 它们调**同一批后端接口**、共享**同一个会话状态**，却各写了一遍会话逻辑：
 * 配置加载、播报去重、说话、打断、回声判定、合成器接线、流订阅……
 * 两套里任何一处改动都只会落到一个页面，于是"两个形态行为不一致"
 * 这种不报错、不崩、只让用户在某个形态下踩到另一个形态没有的问题。
 *
 * 现在只有这一页，用两种**布局**：
 *   ① `?pet=1`（Electron 悬浮窗 / `npm run pet`）→ 头像 + 字幕 + 控制条；
 *   ② 常规页面 → 控制台（左对话 + 右状态/音色/档位/日志）+ 内嵌头像。
 * 差别只有布局。数据与动作全部来自 `useVoiceSession`（唯一一份），
 * 外壳动作来自 `usePetShell`。
 *
 * ── 两条红线 ────────────────────────────────────────────────────────
 *   1. **不新增任何业务通道**。所有 HTTP 都在 `src/voice/client.ts` 里，
 *      语音单与界面直连走的是同一条风控路径 —— 由 `test:pet` 的 P12 组
 *      用源码扫描钉住（"业务通道单一发起处"）。
 *   2. **`?pet=1` 是本页的第二种形态，不是另一个页面**。删掉那个分支
 *      等于把悬浮窗删了。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'

import { MODE_META, useStore } from '../store/Store'
import {
  CATEGORY_LABEL,
  CONFIRM_POLICY_META,
  PRIORITY_META,
  VERBOSITY_META,
  hhmmss,
} from '../voice/client.ts'
import { groupByEngine } from '../voice/configShape.ts'
import { useVoiceSession } from '../voice/useVoiceSession.ts'
import PetAvatar, { DEFAULT_ALIGN } from '../pet/PetAvatar.tsx'
import type { PetMood } from '../pet/PetAvatar.tsx'
import { createAvatarMotion, markWordBoundary, setSpeaking } from '../pet/avatarMotion.ts'
import type { AvatarMotion } from '../pet/avatarMotion.ts'
import { usePetShell } from '../pet/usePetShell.ts'
import { PET_AVATAR_SIZES } from '../pet/avatarSize.ts'
import type { PetAvatarSize } from '../pet/avatarSize.ts'
import { kindNote } from '../pet/petMedia.ts'

/** 常驻口令。走的是与说话完全相同的服务端路径 —— 它只是"替你把话说出来"。 */
const QUICK_SAY: { text: string; label: string }[] = [
  { text: '我现在的持仓是什么', label: '查持仓' },
  { text: '账户权益多少', label: '查权益' },
  { text: '现在有哪些挂单', label: '查挂单' },
  { text: '风控额度还剩多少', label: '查风控' },
  { text: '你现在在干什么，下一步干什么', label: '查状态' },
  { text: '读一下今天的日报', label: '读日报' },
  { text: '比特币现在什么价', label: '查行情' },
  { text: '帮助', label: '能做什么' },
]

/** 悬浮窗只放得下 4 个 —— 与上面的列表**同源**，不是另一套口令。 */
const QUICK_SAY_COMPACT = QUICK_SAY.filter((q) =>
  ['查持仓', '查状态', '读日报', '查风控'].includes(q.label),
)

function money(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

export default function VoiceHubPage({ standalone = false }: { standalone?: boolean }) {
  const { state } = useStore()
  const modeMeta = MODE_META[state.mode]

  /**
   * 头像动作状态。
   *
   * `useState` 惰性初始化而不是 `useRef`：它**要在渲染期作为 prop 传下去**
   * （`<PetAvatar motion={...} />`），而渲染期读 ref 是项目明令禁止的（F-19）。
   * 它是个恒不变的可变对象：React 从不读它的内容，rAF 循环在组件外跑，
   * 每次改动都不需要触发渲染 —— 这正是要的。
   */
  const [motion] = useState<AvatarMotion>(createAvatarMotion)

  const voice = useVoiceSession({
    // ★ 两种形态唯一的参数差异就是日志保留条数：悬浮窗只有 360px 高。
    //   数据口径必须完全一致，所以这里不放开别的开关。
    logLimit: standalone ? 120 : 200,
    // 口型走 performance.now() 轴（与 avatarMotion 内部一致），
    // 尾响窗走 Date.now() 轴（与 echoGuard 内部一致）—— 两套时钟不能混用。
    onWordBoundary: (n) => markWordBoundary(motion, n, performance.now()),
    onSpeakingChange: (on) => setSpeaking(motion, on, performance.now()),
  })
  const shell = usePetShell()

  /**
   * 头像文件输入框。**只有一个实例**，两个入口（双击头像 / 上传按钮）共用它。
   *
   * 两个 `<input type=file>` 会各自持有一份 `files` —— 从其中一个取走后，
   * 另一个拿到空数组，症状是"点了没反应"。所以 ref 也放在页面这一层，
   * 不交给 Hook：Hook 返回值里含 ref 会让 `react-hooks/refs` 把整个返回对象
   * 当成"渲染期读 ref"（实测 32 条报错），而它本来也确实该由持有 DOM 的一方管。
   */
  const fileRef = useRef<HTMLInputElement>(null)

  const [typed, setTyped] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [frameInfo, setFrameInfo] = useState({ usingFallback: false, boundaryCount: 0 })

  /**
   * 时钟。
   *
   * 独立每秒 tick 而不是"跟着播报变" —— 桌宠常年静止（没有新播报），
   * 跟着它走会让时间停在一个小时前，而它看着像系统卡住了。
   * 每秒一次重渲染不影响头像：口型由 rAF 直接写 DOM，不经过 React。
   */
  const [clock, setClock] = useState(() => hhmmss(Date.now()))
  React.useEffect(() => {
    const t = window.setInterval(() => setClock(hhmmss(Date.now())), 1000)
    return () => window.clearInterval(t)
  }, [])

  // ── 心情：优先级从"最需要立刻让人看见"往下排 ──
  const mood: PetMood = useMemo(() => {
    if (voice.recentAlarm) return 'alarm'
    if (voice.speaking) return 'speaking'
    if (voice.busy) return 'thinking'
    if (voice.speech.listening) return 'listening'
    if (voice.status?.turn && voice.status.turn.state !== 'idle') return 'working'
    return 'idle'
  }, [voice.recentAlarm, voice.speaking, voice.busy, voice.speech.listening, voice.status])

  const submit = useCallback(
    (text: string, clear: () => void) => {
      void voice.say(text)
      clear()
    },
    [voice],
  )

  const silent = voice.config?.voiceId === 'silent'
  /**
   * 当前这一档走不走云端神经合成。
   *
   * 判据用**档案里的 `engine`**（用户的选择），不用"云端此刻能不能连"：
   * 后者会让音高滑杆随着网络抖动自己开关，而用户会以为是自己碰了什么。
   */
  const neuralNow = voice.profile?.engine === 'neural'
  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      void shell.pickAvatar(e.target.files?.[0])
      e.target.value = ''
    },
    [shell],
  )

  // ══════════════════════════════════════════════════════════════════
  // 复用块：两种形态共用同一份 JSX，不留第二套实现
  // ══════════════════════════════════════════════════════════════════

  // ★ 这里原来还有一个内联的 `height: '100%'` —— 它让头像直径等于容器剩余高度
  // （控制台里 400px 以上，360×540 的悬浮窗里接近 280px），把真正要读的对话与
  // 状态挤到一边。这就是"头像太大"的来源。
  // 尺寸现在由 `PetAvatar` 的 `data-size` 档位决定，档位定义见 `src/pet/avatarSize.ts`。
  const avatarEl = (
    <div
      className="pet-avatar-root"
      style={standalone ? undefined : { flex: '0 0 auto' }}
      {...shell.dragHandlers}
      onDoubleClick={() => fileRef.current?.click()}
      title={shell.desktop ? '按住拖动我 · 双击换头像' : '双击换头像（照片 / 动图 / 视频）'}
    >
      <PetAvatar
        motion={motion}
        source={shell.avatar}
        size={shell.avatarSize}
        mood={mood}
        align={shell.align}
        onFrameInfo={setFrameInfo}
      />
      {/* 静默档下不发声但口型照动 —— 必须说明，否则像坏了 */}
      {silent && (
        <div className="pet-verdict" style={{ position: 'absolute', top: 0 }}>
          静默档：只出字幕不发声
        </div>
      )}
      {!shell.avatar && (
        <button
          className="pet-icon-btn"
          style={{ position: 'absolute', top: 0, right: 0 }}
          title="上传头像：照片 / 动图 / 视频（只存本机，不上传）"
          onClick={(e) => {
            e.stopPropagation()
            fileRef.current?.click()
          }}
        >
          🖼
        </button>
      )}
    </div>
  )

  const fileInputEl = (
    <input
      ref={fileRef}
      type="file"
      /* 动图与视频都要能选。分流在 `prepareAvatarMedia` 里按文件头判定 ——
         只看扩展名会被"改名的文件"骗过去 */
      accept="image/*,video/mp4,video/webm,video/ogg"
      style={{ display: 'none' }}
      onChange={onPick}
    />
  )

  /** 回声闸门的判定必须可见：它的失败形态是「我说了但它没反应」。 */
  const verdictEl = voice.verdict && (
    <div
      className={`pet-verdict ${voice.verdict.bargeIn ? 'pass' : 'block'}`}
      title={voice.verdict.detail}
    >
      {voice.verdict.bargeIn ? '已打断' : '未打断'}·
      {voice.verdict.reason === 'self-echo'
        ? `判为自听回声（重合 ${(voice.verdict.overlap * 100).toFixed(0)}%）`
        : null}
      {voice.verdict.reason === 'speaker-tail' ? '尾响冷却窗内' : null}
      {voice.verdict.reason === 'mic-off' ? '麦克风未收音' : null}
      {voice.verdict.reason === 'no-speech' ? '没听到人声' : null}
      {voice.verdict.reason === 'idle' ? '它此刻没在说话，不打断' : null}
      {voice.verdict.reason === 'interrupt' ? voice.verdict.detail : null}
    </div>
  )

  /**
   * 待确认块。**两种形态共用**，且都只做同一件事：把用户的话再说一遍。
   *
   * 确认凭证住在服务端、60 秒过期；这个块里没有任何"本地放行"的捷径。
   */
  const confirmEl = voice.status?.pending && (
    <div className="pet-confirm">
      {voice.status.pending.action}
      <div>
        请复述数值：<span className="pet-confirm-amt">{voice.status.pending.expectedAmount}</span>
        {voice.status.pending.amountBasis === 'qty' ? ' 个' : ' 美元'}
      </div>
      <div className="pet-foot" style={{ textAlign: 'left', marginTop: 4 }}>
        {voice.status.pending.slots.live
          ? '实盘单：必须复述金额，不复述不会执行。'
          : voice.status.pending.expectedNotional > 50
            ? '金额超过 50 美元：需要复述金额，用来校验识别有没有听错数字。'
            : '仿真小额单：说「确认」即可。'}
      </div>
    </div>
  )

  // ══════════════════════════════════════════════════════════════════
  // 形态 ①：悬浮窗（`?pet=1`）
  // ══════════════════════════════════════════════════════════════════
  if (standalone) {
    return (
      <div className="pet-stage">
        {avatarEl}

        {!voice.stream.connected && (
          <div className="pet-verdict block">
            播报流未连接（{voice.stream.lastError ?? '正在重连'}）· 它暂时说不出话
          </div>
        )}

        {/* 字幕：它刚说的 + 之前几条 + 你说的（或正在说） */}
        <div className="pet-captions">
          {voice.log.length === 0 && !voice.lastUtterance && (
            <div className="pet-cap ai" style={{ opacity: 0.7 }}>
              我是 EVOLVE 的语音管家。说话就能查仓、下单；任何时候打断我都行。
            </div>
          )}
          {voice.lastUtterance && (
            <div className="pet-cap user">
              <div className="pet-cap-meta"><span>你说</span></div>
              {voice.lastUtterance}
            </div>
          )}
          {[...voice.log].slice(0, 5).map((l) => (
            <div key={l.id} className={`pet-cap ai ${l.priority === 'P0_ALARM' ? 'pet-cap-p0' : ''}`}>
              <div className="pet-cap-meta">
                <span>
                  {PRIORITY_META[l.priority].label} · {CATEGORY_LABEL[l.category]}
                </span>
                <span className="pet-flex1" />
                <span>{hhmmss(l.ts)}</span>
              </div>
              {l.text}
            </div>
          ))}
          {voice.interim && <div className="pet-cap interim">{voice.interim}</div>}
        </div>

        {confirmEl}

        {/* ══════════ 控制条 ══════════ */}
        <div className="pet-controls">
          <div className="pet-row">
            <button
              className={`pet-mic ${voice.speech.listening ? 'on' : ''}`}
              disabled={!voice.caps.asr}
              onClick={() => (voice.speech.listening ? voice.speech.stop() : voice.speech.start())}
              title={voice.caps.asr ? '开始/停止持续聆听' : '本浏览器不支持语音识别，请用下面的输入框'}
            >
              <span className="pet-mic-dot" />
              {voice.speech.listening ? '在听' : '说话'}
            </button>
            <button className="pet-icon-btn" onClick={() => voice.bargeIn()} title="立刻掐断并作废在途答复">
              ✋
            </button>
            {shell.desktop && (
              <>
                <button
                  className="pet-icon-btn"
                  title={shell.hostState?.clickThrough ? '取消鼠标穿透（现在点不到我）' : '鼠标穿透：点桌面时不再挡住'}
                  onClick={() => shell.setClickThrough(!shell.hostState?.clickThrough)}
                >
                  {shell.hostState?.clickThrough ? '🖱' : '🫥'}
                </button>
                <button className="pet-icon-btn" title="重置位置（找不到我时点这里）" onClick={shell.resetPosition}>
                  ⌖
                </button>
              </>
            )}
            <div className="pet-flex1" />
            <span className="pet-foot" style={{ color: modeMeta.color }}>{modeMeta.label}</span>
            <span className="pet-foot">{clock}</span>
            {shell.desktop && (
              <>
                <button className="pet-icon-btn" title="收进托盘" onClick={shell.hide}>—</button>
                <button className="pet-icon-btn" title="退出桌宠" onClick={shell.quit}>✕</button>
              </>
            )}
          </div>

          <div className="pet-say">
            <input
              value={typed}
              placeholder="打字也行，例如：买两百块钱的比特币"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit(typed, () => setTyped(''))
              }}
            />
            <button
              disabled={voice.busy || typed.trim().length === 0}
              onClick={() => submit(typed, () => setTyped(''))}
            >
              {voice.busy ? '…' : '说'}
            </button>
          </div>

          <div className="pet-row" style={{ flexWrap: 'wrap' }}>
            {QUICK_SAY_COMPACT.map((q) => (
              <button
                key={q.text}
                className="pet-icon-btn"
                style={{ width: 'auto', padding: '0 10px' }}
                disabled={voice.busy}
                onClick={() => void voice.say(q.text)}
              >
                {q.label}
              </button>
            ))}
            {voice.status?.pending && (
              <>
                <button
                  className="pet-icon-btn"
                  style={{ width: 'auto', padding: '0 10px', color: 'var(--warning)', borderColor: 'rgba(255,176,32,.6)' }}
                  disabled={voice.busy}
                  onClick={() => void voice.say('确认')}
                >
                  确认
                </button>
                <button
                  className="pet-icon-btn"
                  style={{ width: 'auto', padding: '0 10px' }}
                  disabled={voice.busy}
                  onClick={() => void voice.say('取消')}
                >
                  取消
                </button>
              </>
            )}
          </div>

          {verdictEl}

          {/* 口型来源必须可见：不触发 onboundary 的引擎只能靠"兜底"发现 */}
          {voice.speaking && (
            <div className="pet-verdict">
              {frameInfo.usingFallback
                ? '口型：兜底包络（本机语音引擎未触发词边界）'
                : `口型：跟随词边界（已 ${frameInfo.boundaryCount} 次）`}
            </div>
          )}

          {shell.avatarNote && <div className="pet-verdict pass">{shell.avatarNote}</div>}
          {voice.speech.error && <div className="pet-verdict block">{voice.speech.error}</div>}
          {!voice.caps.asr && <div className="pet-verdict block">本环境不支持语音识别，用输入框即可（同一条服务端路径）</div>}
          {!voice.caps.tts && <div className="pet-verdict block">本环境不支持语音合成，只有字幕</div>}
        </div>

        {fileInputEl}
      </div>
    )
  }

  // ══════════════════════════════════════════════════════════════════
  // 形态 ②：控制台（侧边栏里的常规页面）
  // ══════════════════════════════════════════════════════════════════
  return (
    <div className="content-area">
      <div className="v-head">
        <div>
          <div className="v-title">🎙️ 语音管家 · 悬浮桌宠</div>
          <div className="v-sub">
            说话就能查仓、下单 · 随时打断 · 持续播报在做什么与下一步 ·
            同一套能力，两种形态（`npm run pet` 起悬浮窗）
          </div>
        </div>
        <div className="v-chips">
          <span className="chip" style={{ color: modeMeta.color, borderColor: modeMeta.color }}>
            {modeMeta.label}模式
          </span>
          <span
            className="chip"
            style={{
              color: voice.stream.connected ? 'var(--down)' : 'var(--text-weak)',
              borderColor: voice.stream.connected ? 'var(--down)' : 'var(--border-strong)',
            }}
          >
            {voice.stream.connected ? '播报流已连接' : '播报流未连接'}
          </span>
          {voice.alarmCount > 0 && (
            <span className="chip" style={{ color: 'var(--up)', borderColor: 'var(--up)' }}>
              紧急报警 {voice.alarmCount}
            </span>
          )}
          {voice.speech.listening && (
            <span className="chip" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
              正在听
            </span>
          )}
          {shell.desktop && (
            <span className="chip" style={{ color: 'var(--primary)', borderColor: 'var(--primary)' }}>
              桌面外壳已挂载
            </span>
          )}
        </div>
      </div>

      {(!voice.caps.asr || !voice.caps.tts) && (
        <div className="v-warn">
          {!voice.caps.asr && (
            <div>
              本浏览器不支持语音识别（SpeechRecognition）。麦克风输入不可用，请用下方文字输入 ——
              它走的是完全相同的服务端路径。
            </div>
          )}
          {!voice.caps.tts && (
            <div>
              {neuralNow
                ? '本环境没有本机语音合成（speechSynthesis），所以云端不可用时没有兜底 —— 选一档云端音色仍然能出声。'
                : '本环境不支持本机语音合成（speechSynthesis），当前这一档是本机音色，播报只会出现在下方日志里。换成云端神经音色即可出声。'}
            </div>
          )}
        </div>
      )}

      <div className="v-grid">
        {/* ══════════════ 左：它 + 对话 ══════════════ */}
        <div className="v-col">
          {/* 头像卡：桌宠形态的那套能力在这里全部可用（照片 / 口型 / 摆放 / 外壳动作） */}
          <div className="card">
            <div className="v-card-title">
              它
              <span className="v-note">{shell.desktop ? '桌面悬浮窗已挂载' : '浏览器形态（不悬浮）'}</span>
            </div>
            <div className="v-pet-inline">{avatarEl}</div>
            <div className="v-row-wrap">
              <span className="v-note">音色</span>
              {/* ★ 只列**与当前同一引擎**的那几档。
                  14 档全铺出来会把这一行撑成三排，而这一行的用途是"快速换一个"；
                  换引擎类别是决策，它住在右边的音色卡里（那里有完整说明与健康度）。 */}
              {voice.config?.catalog
                .filter((v) => v.engine === (voice.profile?.engine ?? 'neural'))
                .map((v) => (
                <button
                  key={v.id}
                  className="v-chip-btn"
                  style={{
                    color: voice.config?.voiceId === v.id ? 'var(--primary)' : undefined,
                    borderColor: voice.config?.voiceId === v.id ? 'var(--primary)' : undefined,
                  }}
                  title={v.note}
                  onClick={() => void voice.patchConfig({ voiceId: v.id })}
                >
                  {v.label}
                </button>
              ))}
              <div className="v-flex1" />
              <button className="v-btn" onClick={() => fileRef.current?.click()}>
                {shell.avatar ? '换头像' : '上传头像'}
              </button>
              {shell.avatar && (
                <button className="v-btn" onClick={shell.clearAvatar}>
                  删头像
                </button>
              )}
            </div>

            {/* 头像大小。默认偏小是刻意的：头像够认出是谁就行，
                剩下的高度留给字幕与待确认 —— 那才是用户真正要读的。
                "特大"档是给"就想让头像铺满窗口"的人准备的，
                代价写在档位的 note 里（悬停可见），不替用户决定。
                像素值与 CSS 里的档位由一条断言对读，见 src/pet/avatarSize.ts */}
            <div className="v-row-wrap">
              <span className="v-note">头像大小</span>
              {(Object.keys(PET_AVATAR_SIZES) as PetAvatarSize[]).map((k) => (
                <button
                  key={k}
                  className="v-chip-btn"
                  title={PET_AVATAR_SIZES[k].note}
                  aria-label={'头像' + PET_AVATAR_SIZES[k].label + '：' + PET_AVATAR_SIZES[k].note}
                  style={{
                    color: shell.avatarSize === k ? 'var(--primary)' : undefined,
                    borderColor: shell.avatarSize === k ? 'var(--primary)' : undefined,
                  }}
                  onClick={() => shell.setAvatarSize(k)}
                >
                  {PET_AVATAR_SIZES[k].label} · {PET_AVATAR_SIZES[k].px}px
                </button>
              ))}
              {shell.avatar && (
                <span className="v-dim">
                  {shell.avatar.kind === 'image'
                    ? kindNote(shell.avatar.kind)
                    : `${kindNote(shell.avatar.kind)} · ${(shell.avatar.bytes / 1024 / 1024).toFixed(1)}MB`}
                </span>
              )}
            </div>
            <div className="v-row-wrap">
              <span className="v-note">口型摆放</span>
              {(['mouthY', 'eyeY'] as const).map((k) => (
                <React.Fragment key={k}>
                  <button
                    className="v-chip-btn"
                    onClick={() => shell.saveAlign({ ...shell.align, [k]: Math.max(0, shell.align[k] - 2) })}
                  >
                    {k === 'mouthY' ? '嘴上' : '眼上'}
                  </button>
                  <button
                    className="v-chip-btn"
                    onClick={() => shell.saveAlign({ ...shell.align, [k]: Math.min(100, shell.align[k] + 2) })}
                  >
                    {k === 'mouthY' ? '嘴下' : '眼下'}
                  </button>
                </React.Fragment>
              ))}
              <button className="v-chip-btn" onClick={() => shell.saveAlign(DEFAULT_ALIGN)}>复位</button>
              {shell.desktop && (
                <>
                  <div className="v-flex1" />
                  <button
                    className="v-chip-btn"
                    onClick={() => shell.setClickThrough(!shell.hostState?.clickThrough)}
                  >
                    {shell.hostState?.clickThrough ? '取消穿透' : '鼠标穿透'}
                  </button>
                  <button className="v-chip-btn" onClick={shell.resetPosition}>重置位置</button>
                  <button className="v-chip-btn" onClick={shell.hide}>收进托盘</button>
                </>
              )}
            </div>
            <div className="v-foot">
              头像与摆放只存本机，不上传。口型由词边界驱动，本机语音引擎不报边界时自动退到确定性包络 ——
              {voice.speaking
                ? frameInfo.usingFallback
                  ? '当前正在用兜底包络。'
                  : `当前跟随词边界（已 ${frameInfo.boundaryCount} 次）。`
                : '说话时这里会显示它当前用的是哪一种。'}
            </div>
            {shell.avatarNote && <div className="v-foot" style={{ color: 'var(--primary)' }}>{shell.avatarNote}</div>}
          </div>

          <div className="card v-mic-card">
            <div className="v-mic-row">
              <button
                className={`v-mic ${voice.speech.listening ? 'on' : ''}`}
                disabled={!voice.caps.asr}
                onClick={() => (voice.speech.listening ? voice.speech.stop() : voice.speech.start())}
                title={voice.caps.asr ? '点击开始/停止持续聆听' : '本浏览器不支持语音识别'}
              >
                <span className="v-mic-dot" />
                {voice.speech.listening ? '停止聆听' : '开始聆听'}
              </button>
              <button className="v-btn" onClick={() => voice.bargeIn()} title="立刻掐断播报并作废在途答复">
                ✋ 打断
              </button>
              <div className="v-flex1" />
              <span className="v-note">
                {voice.speech.listening
                  ? '持续聆听中 · 一开口就会掐断系统说话'
                  : voice.caps.asr
                    ? '未聆听 · 点左侧开始'
                    : '文字输入模式'}
              </span>
            </div>

            <div className="v-interim">
              {voice.interim || (
                <span className="v-dim">{voice.speech.listening ? '（在听……）' : '（待机）'}</span>
              )}
            </div>

            {voice.speech.error && <div className="v-err">{voice.speech.error}</div>}

            {/* 回声闸门的判定必须可见：没有这一行就只能猜是网络、是识别、还是判成了自听回声 */}
            {voice.verdict && (
              <div
                className="v-note"
                style={{ color: voice.verdict.bargeIn ? 'var(--primary)' : 'var(--text-weak)' }}
              >
                插话判定：{voice.verdict.bargeIn ? '已打断' : '未打断'} · {voice.verdict.detail}
              </div>
            )}

            <div className="v-say-row">
              <input
                className="input v-input"
                value={typed}
                placeholder="也可以直接打字，例如：买两百块钱的比特币"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit(typed, () => setTyped(''))
                }}
              />
              <button
                className="v-btn primary"
                disabled={voice.busy || typed.trim().length === 0}
                onClick={() => submit(typed, () => setTyped(''))}
              >
                {voice.busy ? '处理中…' : '说'}
              </button>
            </div>

            <div className="v-quick">
              {QUICK_SAY.map((q) => (
                <button
                  key={q.text}
                  className="v-chip-btn"
                  disabled={voice.busy}
                  onClick={() => void voice.say(q.text)}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <div className="v-foot">
              常用口令不是另一条通道 —— 它们只是替你把话说出来，服务端解析路径与真说话完全一致。
            </div>
          </div>

          {voice.lastReply && (
            <div className="card">
              <div className="v-card-title">
                最近一轮
                <span className="v-note">第 {voice.lastReply.turnId} 轮</span>
              </div>
              <div className="v-exchange">
                <div className="v-bubble user">{voice.lastUtterance || '（未记录原话）'}</div>
              </div>
              <div className="v-kv">
                <span>意图</span>
                <span className="mono">
                  {voice.lastReply.intentLabel}（{voice.lastReply.intent}）
                </span>
              </div>
              <div className="v-kv">
                <span>解析置信度</span>
                <span
                  className="mono"
                  style={{ color: voice.lastReply.confidence >= 0.6 ? 'var(--down)' : 'var(--warning)' }}
                >
                  {(voice.lastReply.confidence * 100).toFixed(0)}%
                </span>
              </div>
              {voice.lastReply.dropped && (
                <div className="v-dropped">
                  这一轮被后续插话作废，没有念出来 —— 这正是「随时打断」生效的证据。
                </div>
              )}
              <div className="v-reply">{voice.lastReply.reply || '（无回话）'}</div>
              {voice.lastReply.detail && <div className="v-detail">原始返回：{voice.lastReply.detail}</div>}
              {voice.lastReply.executed && (
                <div
                  className="v-exec"
                  style={{ color: voice.lastReply.executed.ok ? 'var(--down)' : 'var(--up)' }}
                >
                  {voice.lastReply.executed.ok
                    ? `已执行 · 单号 ${voice.lastReply.executed.orderId ?? voice.lastReply.executed.clientOrderId ?? '—'} · 状态 ${voice.lastReply.executed.status ?? '—'}`
                    : `被拒：${voice.lastReply.executed.reason ?? '未知原因'}`}
                </div>
              )}
            </div>
          )}

          <div className="card">
            <div className="v-card-title">
              待确认动作
              {voice.status?.pending && <span className="v-badge warn">等你复述</span>}
            </div>
            {voice.status?.pending ? (
              <>
                <div className="v-pending-action">{voice.status.pending.action}</div>
                <div className="v-kv">
                  <span>需要复述的数值</span>
                  <span className="mono" style={{ color: 'var(--warning)' }}>
                    {voice.status.pending.expectedAmount}{' '}
                    {voice.status.pending.amountBasis === 'qty' ? '个' : '美元'}
                  </span>
                </div>
                {voice.status.pending.amountBasis === 'qty' && (
                  <div className="v-kv">
                    <span>折算名义额</span>
                    <span className="mono">${money(voice.status.pending.expectedNotional)}</span>
                  </div>
                )}
                <div className="v-note" style={{ marginTop: 6 }}>
                  {voice.status.pending.slots.live
                    ? '实盘单：必须复述金额，不复述不会执行。'
                    : voice.status.pending.expectedNotional > 50
                      ? '金额超过 50 美元：需要复述金额，用来校验识别有没有听错数字。'
                      : '仿真小额单：说「确认」即可。'}
                </div>
                <div className="v-say-row" style={{ marginTop: 8 }}>
                  <input
                    className="input v-input"
                    value={confirmText}
                    placeholder={`复述金额后确认，例如：确认 ${voice.status.pending.expectedAmount}`}
                    onChange={(e) => setConfirmText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit(confirmText, () => setConfirmText(''))
                    }}
                  />
                  <button
                    className="v-btn primary"
                    disabled={voice.busy || confirmText.trim().length === 0}
                    onClick={() => submit(confirmText, () => setConfirmText(''))}
                  >
                    确认
                  </button>
                  <button className="v-btn" disabled={voice.busy} onClick={() => void voice.say('取消')}>
                    取消
                  </button>
                </div>
                <div className="v-foot">
                  确认凭证住在服务端，60 秒过期。金额不符会被拒绝并单独留痕（VOICE_CONFIRM_MISMATCH）——
                  这是「语音下单听错数字」这一风险类别唯一的可观测信号。
                </div>
              </>
            ) : (
              <div className="v-dim">当前没有等你确认的动作。任何会动钱的操作都会先落到这里。</div>
            )}
          </div>

          <div className="card">
            <div className="v-card-title">
              今日日报
              <button className="v-btn" disabled={voice.busy} onClick={() => void voice.readDaily()}>
                🔊 念给我听
              </button>
            </div>
            {voice.daily ? (
              <>
                {voice.daily.partialDay && (
                  <div className="v-warn inline">
                    账本最早事件晚于今天零点 —— 这是<strong>从进程启动算起</strong>的统计，不是完整一天。
                  </div>
                )}
                <div className="v-kv"><span>权益</span><span className="mono">{money(voice.daily.equity)}</span></div>
                <div className="v-kv">
                  <span>相对起点</span>
                  <span className="mono" style={{ color: voice.daily.pnlPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {voice.daily.pnlPct >= 0 ? '+' : ''}{voice.daily.pnlPct}%
                  </span>
                </div>
                <div className="v-kv">
                  <span>成交 / 提交 / 被拒</span>
                  <span className="mono">{voice.daily.fills} / {voice.daily.submits} / {voice.daily.rejects}</span>
                </div>
                <div className="v-kv"><span>持仓</span><span className="mono">{voice.daily.positions}</span></div>
                <div className="v-kv">
                  <span>对账</span>
                  <span
                    className="mono"
                    style={{
                      color:
                        voice.daily.reconciliation === 'consistent'
                          ? 'var(--down)'
                          : voice.daily.reconciliation === 'unknown'
                            ? 'var(--text-weak)'
                            : 'var(--up)',
                    }}
                  >
                    {voice.daily.reconciliation === 'consistent'
                      ? '一致'
                      : voice.daily.reconciliation === 'unknown'
                        ? '还没跑过（不等于一致）'
                        : '不一致'}
                  </span>
                </div>
                <div className="v-kv"><span>监控标记</span><span className="mono">{voice.daily.surveillanceFlags}</span></div>
                <div className="v-kv">
                  <span>回撤已用</span>
                  <span className="mono">
                    {voice.daily.riskUsage.currentDrawdownPct}% / {voice.daily.riskUsage.drawdownCapPct}%
                  </span>
                </div>
                <div className="v-kv"><span>自动驾驶</span><span className="mono">{voice.daily.autopilotStage}</span></div>
                {voice.daily.gateRefusalSummary && (
                  <div className="v-detail">过拟合门上次没放行：{voice.daily.gateRefusalSummary}</div>
                )}
                {voice.daily.topRejectReasons.length > 0 && (
                  <div className="v-detail">
                    被拒最多：{voice.daily.topRejectReasons.map((r) => `${r.reason} ×${r.count}`).join('、')}
                  </div>
                )}
              </>
            ) : (
              <div className="v-dim">还没取过日报。点右上角它会念给你听，同时把数字填到这里。</div>
            )}
          </div>
        </div>

        {/* ══════════════ 右：状态与音色 ══════════════ */}
        <div className="v-col">
          <div className="card">
            <div className="v-card-title">它在做什么</div>
            {voice.workLine ? (
              <>
                <div className="v-work">{voice.workLine.text}</div>
                <div className="v-kv"><span>类别</span><span className="mono">{CATEGORY_LABEL[voice.workLine.category]}</span></div>
                <div className="v-kv"><span>时间</span><span className="mono">{hhmmss(voice.workLine.ts)}</span></div>
                {voice.workLine.sourceSeq !== undefined && (
                  <div className="v-kv">
                    <span>账本溯源</span>
                    <span className="mono">#{voice.workLine.sourceSeq} {voice.workLine.sourceKind ?? ''}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="v-dim">
                还没有工作状态播报。把播报档位调到「全都说」，或直接问它「你现在在干什么」。
              </div>
            )}
            <div className="v-divider" />
            <div className="v-kv"><span>已播报</span><span className="mono">{voice.status?.narrator.emitted ?? 0} 条</span></div>
            <div className="v-kv"><span>被压制</span><span className="mono">{voice.status?.suppressedCount ?? 0} 条</span></div>
            <div className="v-kv"><span>实际发声</span><span className="mono">{voice.spokenLocal} 条</span></div>
            <div className="v-kv"><span>打断次数</span><span className="mono">{voice.status?.session.interruptedCount ?? 0}</span></div>
            <div className="v-kv">
              <span>作废答复</span>
              <span
                className="mono"
                style={{ color: (voice.status?.session.droppedReplies ?? 0) > 0 ? 'var(--accent)' : undefined }}
              >
                {voice.status?.session.droppedReplies ?? 0} 条
              </span>
            </div>
            <div className="v-kv"><span>盘面异动命中</span><span className="mono">{voice.status?.anomaly.hits ?? 0} 次</span></div>
            <div className="v-foot">
              「被压制」包含静音、档位过滤、重复去重、限流四类。紧急报警不参与其中任何一类 —— 静音了也照说。
            </div>
          </div>

          <div className="card">
            <div className="v-card-title">
              音色
              {voice.saveNote && <span className="v-badge">{voice.saveNote}</span>}
            </div>

            <div className="v-inv">
              系统实际装了 <b>{voice.inventory.zh}</b> 个中文音色（共 {voice.inventory.total} 个）。
              {voice.inventory.zh === 0 && (
                <span style={{ color: 'var(--warning)' }}> 一个都没有 —— 打开「静默」只出字幕更实际。</span>
              )}
              {voice.inventory.names.length > 0 && (
                <span className="v-dim">
                  {' '}
                  {voice.inventory.names.slice(0, 4).join('、')}
                  {voice.inventory.names.length > 4 ? ' …' : ''}
                </span>
              )}
            </div>

            {voice.match.how === 'locale-fallback' && (
              <div className="v-warn inline">
                这个音色的匹配候选一个都没命中，已退到同语种音色
                {voice.match.voice ? `「${voice.match.voice.name}」` : ''}，再用音高与语速拉开区分度 ——
                是同一副嗓子的变形，不是换了个人。
              </div>
            )}
            {voice.match.how === 'neural' && (
              <div className="v-note">
                这一档由云端合成，与本机装没装语音包无关 —— 所以上面那行"系统装了 N 个中文音色"对它不适用。
              </div>
            )}
            {voice.match.how === 'none' && voice.profile && voice.profile.id !== 'silent' && (
              <div className="v-warn inline">这个音色在系统里没有可用实现，播报会退回系统默认声音。</div>
            )}

            {/* ══════════ 出声链路的健康度 ══════════
                「声音不好听」有两个完全不同的成因：云端降级了，或者只是这一档不合口味。
                界面必须能区分这两者 —— 否则用户会反复点音色按钮，
                而问题根本不在那里。这是这次要修的抱怨里最容易被做错的一条。 */}
            <div className="v-engine">
              <div className="v-engine-top">
                <span className={`v-engine-dot ${voice.speaker.engine ?? 'idle'}`} />
                <span>
                  实际出声：<b>{voice.speaker.engine === 'neural' ? '云端神经音色' : voice.speaker.engine === 'local' ? '本机语音包' : '还没说过话'}</b>
                </span>
                <div className="v-flex1" />
                <button className="v-btn" onClick={() => voice.preview()}>试听</button>
                <button className="v-btn" onClick={voice.refreshEngine}>重测云端</button>
              </div>
              {voice.speaker.engineNote && <div className="v-warn inline">{voice.speaker.engineNote}</div>}
              <div className="v-dim">
                念完 {voice.speaker.spoken} 条：云端 {voice.speaker.neuralSpoken} · 本机 {voice.speaker.browserSpoken} · 云端失败 {voice.speaker.neuralFails}
                {voice.speaker.noEngine > 0 && (
                  <span style={{ color: 'var(--warning)' }}> · 两条路都没有、被丢掉 {voice.speaker.noEngine} 条</span>
                )}
              </div>
              <div className="v-dim">
                {voice.engineError
                  ? `云端状态读不到：${voice.engineError}`
                  : voice.engine
                    ? voice.engine.neural.note
                    : '正在读取云端状态…'}
              </div>
              {voice.engine && voice.speaker.neuralFails > 0 && (
                <div className="v-foot">
                  失败后前端会退回本机合成并「冷却 60 秒」再试云端；但紧急报警不会去试一条刚失败过的路 ——
                  那是拿报警的延迟赌。一次成功的合成就把云端请回来了。
                </div>
              )}
            </div>

            <div className="v-voice-groups">
              {groupByEngine(voice.config?.catalog ?? []).map((g) => (
                <div key={g.engine} className="v-voice-group">
                  <div className="v-voice-group-head">
                    <span>{g.label}</span>
                    <span className="v-dim">{g.voices.length} 档</span>
                  </div>
                  <div className="v-note">{g.note}</div>
                  <div className="v-voices">
                    {g.voices.map((v) => (
                      <button
                        key={v.id}
                        className={`v-voice ${voice.config?.voiceId === v.id ? 'active' : ''}`}
                        onClick={() => void voice.patchConfig({ voiceId: v.id })}
                      >
                        <div className="v-voice-top">
                          <span className="v-voice-label">{v.label}</span>
                          {voice.config?.voiceId === v.id && <span className="v-badge">当前</span>}
                        </div>
                        <div className="v-voice-note">{v.note}</div>
                        <div className="v-voice-tags">
                          {v.tags.map((t) => <span key={t} className="v-tag">{t}</span>)}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="v-divider" />

            <div className="v-slider">
              <span>语速 ×{voice.config?.rate ?? 1}</span>
              <input
                type="range" min={0.5} max={2} step={0.05}
                value={voice.config?.rate ?? 1}
                onChange={(e) => void voice.patchConfig({ rate: Number(e.target.value) })}
              />
            </div>
            {/**
              * 音高滑杆在神经音色下必须**禁用**，而不是悄悄留着。
              *
              * 云端引擎实测 `prosody pitch` 完全不生效（改了与默认逐字节相同，
              * 见 server/voice/tts.ts 的实测表）。留一个能拖但没有任何反应的滑块，
              * 正是用户说的"僵硬"的来源之一 —— 他会以为是自己没拖对。
              */}
            <div className={`v-slider ${neuralNow ? 'disabled' : ''}`}>
              <span>音高 ×{voice.config?.pitch ?? 1}</span>
              <input
                type="range" min={0.5} max={2} step={0.05}
                value={voice.config?.pitch ?? 1}
                disabled={neuralNow}
                onChange={(e) => void voice.patchConfig({ pitch: Number(e.target.value) })}
              />
            </div>
            {neuralNow ? (
              <div className="v-note">
                云端神经音色不支持调音高（该参数在这个端点上实测不生效），所以这一档只留语速。
                要换嗓音请直接换上面某一档音色。
              </div>
            ) : (
              <div className="v-note">
                本机语音包只能靠音高与语速拉开区分度，那是同一副嗓子的变形，不是换了个人。
              </div>
            )}
          </div>

          <div className="card">
            <div className="v-card-title">播报档位</div>
            <div className="v-seg">
              {(Object.keys(VERBOSITY_META) as (keyof typeof VERBOSITY_META)[]).map((k) => (
                <button
                  key={k}
                  className={`v-seg-btn ${voice.config?.verbosity === k ? 'active' : ''}`}
                  onClick={() => void voice.patchConfig({ verbosity: k })}
                >
                  {VERBOSITY_META[k].label}
                </button>
              ))}
            </div>
            <div className="v-note">{voice.config ? VERBOSITY_META[voice.config.verbosity].desc : ''}</div>

            <div className="v-toggle-row">
              <span>持续自动播报</span>
              <button
                className={`v-switch ${voice.config?.autoNarrate ? 'on' : ''}`}
                onClick={() => void voice.patchConfig({ autoNarrate: !voice.config?.autoNarrate })}
              >
                {voice.config?.autoNarrate ? '开' : '关'}
              </button>
            </div>
            <div className="v-note">关掉后它不再主动开口，但用嘴问仍然会答。</div>

            <div className="v-toggle-row">
              <span>静音</span>
              <button
                className={`v-switch ${voice.config?.muted ? 'on' : ''}`}
                onClick={() => void voice.patchConfig({ muted: !voice.config?.muted })}
              >
                {voice.config?.muted ? '开' : '关'}
              </button>
            </div>
            <div className="v-note">静音只压 P1~P3。紧急报警压不掉 —— 那是它的职责。</div>

            <div className="v-divider" />

            <div className="v-card-title small">下单确认强度</div>
            <div className="v-seg">
              {(Object.keys(CONFIRM_POLICY_META) as (keyof typeof CONFIRM_POLICY_META)[]).map((k) => (
                <button
                  key={k}
                  className={`v-seg-btn ${voice.config?.confirmPolicy === k ? 'active' : ''}`}
                  onClick={() => void voice.patchConfig({ confirmPolicy: k })}
                >
                  {CONFIRM_POLICY_META[k].label}
                </button>
              ))}
            </div>
            <div className="v-note">{voice.config ? CONFIRM_POLICY_META[voice.config.confirmPolicy].desc : ''}</div>
            <div className="v-foot">
              只有「按金额分档」与「一律复述」两档，没有关闭项 —— 一个能关掉确认的开关，
              在觉得烦的那天一定会被关掉，而那天恰好就是出事的那天。
            </div>
          </div>

          <div className="card">
            <div className="v-card-title">
              播报日志
              <span className="v-note">最近 {voice.log.length} 条</span>
            </div>
            <div className="v-log">
              {voice.log.length === 0 && <div className="v-dim">还没有播报。</div>}
              {voice.log.map((l) => {
                const meta = PRIORITY_META[l.priority]
                return (
                  <div key={l.id} className={`v-log-item ${l.priority === 'P0_ALARM' ? 'p0' : ''}`}>
                    <div className="v-log-top">
                      <span className="v-pri" style={{ color: meta.color, borderColor: meta.color }}>
                        {meta.label}
                      </span>
                      <span className="v-cat">{CATEGORY_LABEL[l.category]}</span>
                      <span className="v-flex1" />
                      <span className="v-time mono">{hhmmss(l.ts)}</span>
                    </div>
                    <div className="v-log-text">{l.text}</div>
                    {l.detail && <div className="v-detail">{l.detail}</div>}
                    {l.sourceSeq !== undefined && (
                      <div className="v-src mono">账本 #{l.sourceSeq} {l.sourceKind ?? ''}</div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="v-foot">
              每条播报都带账本序号 —— 「秘书不会自己编状态」这件事因此可核，而不是只能相信。
            </div>
          </div>
        </div>
      </div>

      {/* 写日志用的 Toast 由 App 提供；这里只给一个不可用的提示兜底 */}
      {!voice.caps.asr && (
        <div className="v-foot">
          提示：本环境没有语音识别时，所有能力仍可打字使用 —— 打字与说话在服务端是同一条路径。
        </div>
      )}
      {fileInputEl}

      <style>{`
        .v-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
        .v-title { font-family: var(--font-ui); font-size: 17px; font-weight: 700; color: var(--text-main); }
        .v-sub { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); margin-top: 3px; }
        .v-chips { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
        .v-flex1 { flex: 1; }
        .v-grid { display: grid; grid-template-columns: minmax(0, 1fr) 348px; gap: 12px; align-items: start; }
        @media (max-width: 1180px) { .v-grid { grid-template-columns: minmax(0, 1fr); } }
        .v-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

        /* 内嵌头像：固定高度，不抢布局；窗内形态才是 flex:1 */
        .v-pet-inline {
          height: 190px; display: flex; align-items: center; justify-content: center;
          margin-bottom: 10px; border-radius: 12px;
          background: radial-gradient(circle at 50% 40%, rgba(34,211,238,0.06), transparent 70%);
        }
        .v-row-wrap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }

        .v-mic-card { padding-bottom: 12px; }
        .v-mic-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .v-mic {
          display: inline-flex; align-items: center; gap: 8px;
          height: 38px; padding: 0 16px; border-radius: 19px; cursor: pointer;
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          color: var(--text-main); font-family: var(--font-ui); font-size: 13px; font-weight: 600;
          transition: all 0.2s;
        }
        .v-mic:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
        .v-mic.on {
          background: rgba(232,121,249,0.12); border-color: var(--accent); color: var(--accent);
          box-shadow: 0 0 0 3px rgba(232,121,249,0.10);
        }
        .v-mic:disabled { opacity: 0.45; cursor: not-allowed; }
        .v-mic-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
        .v-mic.on .v-mic-dot { animation: vpulse 1.4s infinite; }
        @keyframes vpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

        .v-btn {
          height: 30px; padding: 0 12px; border-radius: 7px; cursor: pointer;
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          color: var(--text-sub); font-family: var(--font-ui); font-size: 12px;
          transition: all 0.15s;
        }
        .v-btn:hover:not(:disabled) { color: var(--text-main); border-color: var(--primary); }
        .v-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .v-btn.primary { background: var(--primary-10); border-color: var(--primary-40); color: var(--primary); font-weight: 600; }

        .v-interim {
          margin-top: 10px; min-height: 42px; padding: 10px 12px;
          background: var(--bg-base); border: 1px dashed var(--border-strong); border-radius: 8px;
          font-family: var(--font-ui); font-size: 13px; color: var(--text-main); line-height: 1.5;
        }
        .v-err { margin-top: 8px; font-size: 11px; color: var(--up); line-height: 1.5; }

        .v-say-row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
        .v-input { flex: 1; min-width: 0; }

        .v-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .v-chip-btn {
          height: 26px; padding: 0 10px; border-radius: 13px; cursor: pointer;
          background: transparent; border: 1px solid var(--border-strong);
          color: var(--text-sub); font-family: var(--font-ui); font-size: 11px;
        }
        .v-chip-btn:hover:not(:disabled) { color: var(--primary); border-color: var(--primary); }
        .v-chip-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .v-foot { margin-top: 10px; font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); line-height: 1.6; }
        .v-note { font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); line-height: 1.5; }
        .v-dim { font-family: var(--font-ui); font-size: 12px; color: var(--text-weak); line-height: 1.6; }
        .v-detail { margin-top: 6px; font-family: var(--font-mono); font-size: 10px; color: var(--text-weak); line-height: 1.6; word-break: break-all; }
        .v-src { margin-top: 4px; font-size: 10px; color: var(--accent); opacity: 0.85; }
        .v-divider { height: 1px; background: var(--border); margin: 10px 0; }

        .v-warn {
          margin-bottom: 10px; padding: 9px 12px; border-radius: 8px;
          background: rgba(255,176,32,0.08); border: 1px solid rgba(255,176,32,0.35);
          font-family: var(--font-ui); font-size: 11px; color: var(--warning); line-height: 1.6;
        }
        .v-warn.inline { margin: 8px 0 0; }

        .v-card-title {
          display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
          font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main);
        }
        .v-card-title.small { font-size: 11px; color: var(--text-sub); margin-bottom: 8px; }
        .v-card-title > .v-btn { margin-left: auto; }
        .v-card-title > .v-note { margin-left: auto; }

        .v-exchange { margin-bottom: 8px; }
        .v-bubble.user {
          display: inline-block; padding: 7px 11px; border-radius: 10px;
          background: var(--primary-10); border: 1px solid var(--primary-40);
          font-family: var(--font-ui); font-size: 12px; color: var(--text-main);
        }
        .v-reply {
          padding: 10px 12px; border-radius: 10px; background: var(--bg-base);
          border: 1px solid var(--border);
          font-family: var(--font-ui); font-size: 13px; color: var(--text-main); line-height: 1.65;
        }
        .v-dropped {
          margin: 6px 0; padding: 7px 10px; border-radius: 7px;
          background: rgba(232,121,249,0.08); border: 1px solid rgba(232,121,249,0.35);
          font-family: var(--font-ui); font-size: 11px; color: var(--accent); line-height: 1.6;
        }
        .v-exec { margin-top: 8px; font-family: var(--font-mono); font-size: 11px; line-height: 1.6; }

        .v-kv { display: flex; gap: 10px; padding: 3px 0; font-family: var(--font-ui); font-size: 11px; }
        .v-kv > span:first-child { color: var(--text-weak); flex-shrink: 0; }
        .v-kv > span:last-child { margin-left: auto; color: var(--text-sub); text-align: right; }

        .v-badge {
          padding: 1px 6px; border-radius: 8px; font-family: var(--font-mono); font-size: 9px;
          background: var(--bg-elevated); border: 1px solid var(--border-strong); color: var(--accent);
        }
        .v-badge.warn { color: var(--warning); border-color: rgba(255,176,32,0.5); }

        .v-pending-action {
          padding: 9px 12px; border-radius: 8px; margin-bottom: 8px;
          background: rgba(255,176,32,0.08); border: 1px solid rgba(255,176,32,0.35);
          font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--warning);
        }

        .v-work {
          padding: 10px 12px; border-radius: 8px; background: var(--bg-base); border: 1px solid var(--border);
          font-family: var(--font-ui); font-size: 12px; color: var(--text-main); line-height: 1.65; margin-bottom: 8px;
        }

        .v-inv {
          padding: 8px 10px; border-radius: 8px; background: var(--bg-base); border: 1px solid var(--border);
          font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); line-height: 1.6;
        }
        .v-inv b { color: var(--primary); }

        .v-voice-groups { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
        .v-voice-group { display: flex; flex-direction: column; }
        .v-voice-group-head {
          display: flex; align-items: baseline; gap: 8px;
          font-family: var(--font-ui); font-size: 11px; font-weight: 600;
          color: var(--text-main); border-bottom: 1px solid var(--border); padding-bottom: 5px;
        }
        .v-voice-group-head .v-dim { margin-left: auto; }
        .v-voice-group > .v-note { margin: 5px 0 0; }
        .v-voice-group > .v-voices { margin-top: 8px; }

        /* 出声链路的健康度。刻意做成"一行状态 + 一行计数 + 一行人话"，
           而不是一个色块 —— 它要在"一切正常"时安静，"降级了"时才被看见。 */
        .v-engine {
          margin-top: 10px; padding: 9px 10px; border-radius: 8px;
          background: var(--bg-base); border: 1px solid var(--border);
        }
        .v-engine-top { display: flex; align-items: center; gap: 7px; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }
        .v-engine-top b { color: var(--text-main); }
        .v-engine-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-weak); }
        .v-engine-dot.neural { background: var(--primary); }
        .v-engine-dot.local { background: var(--warning); }
        .v-engine .v-dim { margin-top: 5px; }

        .v-voices { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
        .v-voice {
          text-align: left; padding: 8px 10px; border-radius: 8px; cursor: pointer;
          background: var(--bg-base); border: 1px solid var(--border);
          transition: all 0.15s;
        }
        .v-voice:hover { border-color: var(--border-strong); }
        .v-voice.active { background: var(--primary-10); border-color: var(--primary-40); }
        .v-voice-top { display: flex; align-items: center; gap: 6px; }
        .v-voice-label { font-family: var(--font-ui); font-size: 12px; font-weight: 600; color: var(--text-main); }
        .v-voice-note { margin-top: 3px; font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); line-height: 1.5; }
        .v-voice-tags { display: flex; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
        .v-tag {
          padding: 0 5px; border-radius: 4px; font-family: var(--font-ui); font-size: 9px;
          color: var(--text-weak); border: 1px solid var(--border-strong);
        }

        .v-slider { display: flex; align-items: center; gap: 10px; padding: 5px 0; font-family: var(--font-ui); font-size: 11px; color: var(--text-weak); }
        .v-slider > span { width: 74px; flex-shrink: 0; }
        .v-slider input { flex: 1; accent-color: var(--primary); }
        /* 参数不生效时必须**看起来就是不能调**。留一个能拖但毫无反应的滑块，
           用户会以为是自己没拖对 —— 那正是"僵硬"的一部分。 */
        .v-slider.disabled { opacity: 0.45; }
        .v-slider.disabled input { cursor: not-allowed; }

        .v-seg { display: flex; gap: 4px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 3px; }
        .v-seg-btn {
          flex: 1; height: 26px; border-radius: 6px; cursor: pointer; border: none; background: transparent;
          color: var(--text-weak); font-family: var(--font-ui); font-size: 11px;
        }
        .v-seg-btn:hover { color: var(--text-main); }
        .v-seg-btn.active { background: var(--primary-10); color: var(--primary); font-weight: 600; }
        .v-seg + .v-note { margin-top: 6px; }

        .v-toggle-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-family: var(--font-ui); font-size: 11px; color: var(--text-sub); }
        .v-switch {
          margin-left: auto; height: 22px; min-width: 42px; padding: 0 8px; border-radius: 11px; cursor: pointer;
          background: var(--bg-elevated); border: 1px solid var(--border-strong);
          color: var(--text-weak); font-family: var(--font-ui); font-size: 10px; font-weight: 600;
        }
        .v-switch.on { background: rgba(0,214,143,0.12); border-color: var(--down); color: var(--down); }

        .v-log { display: flex; flex-direction: column; gap: 7px; max-height: 460px; overflow-y: auto; }
        .v-log-item {
          padding: 8px 10px; border-radius: 8px; background: var(--bg-base);
          border: 1px solid var(--border); border-left-width: 2px;
        }
        .v-log-item.p0 { background: rgba(255,77,109,0.07); border-color: rgba(255,77,109,0.45); }
        .v-log-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
        .v-pri {
          padding: 0 5px; border-radius: 4px; border: 1px solid; font-family: var(--font-ui); font-size: 9px;
        }
        .v-cat { font-family: var(--font-ui); font-size: 9px; color: var(--text-weak); }
        .v-time { font-size: 9px; color: var(--text-weak); }
        .v-log-text { font-family: var(--font-ui); font-size: 12px; color: var(--text-main); line-height: 1.6; }
      `}</style>
    </div>
  )
}
