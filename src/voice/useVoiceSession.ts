/**
 * EVOLVE · 语音会话内核（**全系统唯一一份**）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * 这套会话逻辑原本在 `VoicePage`（923 行）与 `PetPage`（712 行）里**各写了一遍**：
 * 配置加载、播报去重、说话、打断、回声判定、合成器接线、尾响窗、流订阅……
 * 两套实现里任何一处改动都只会落到一个页面 —— 而"两个形态行为不一致"
 * 这种缺陷不报错、不崩，只让用户在某个形态下遇到另一个形态没有的问题。
 *
 * 现在只留一份，合并后的 `VoiceHubPage` 用两种**布局**消费它：
 *   ① `?pet=1` → 悬浮窗（头像 + 字幕 + 控制条）
 *   ② 常规页面 → 控制台（左对话 + 右状态/音色/档位/日志）
 * 两者差别只有布局；数据与动作全部来自下面这一个 Hook。
 *
 * ★ 它不发任何自有请求。所有 HTTP 都在 `src/voice/client.ts` 里，
 *   而那个文件对语音这条线是**唯一的业务通道** —— 这条由 `test:pet` 的
 *   P12 组用源码扫描钉住（`postUtterance(` / `postInterrupt(` 只允许出现在这里）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { pushToast, useStore } from '../store/Store.tsx'
import { judgeBargeIn, speechTailCooldownDeadline } from '../pet/echoGuard.ts'
import type { BargeInVerdict } from '../pet/echoGuard.ts'
import {
  asrSupported,
  getTtsEngine,
  getVoiceConfig,
  getVoiceDaily,
  getVoiceTranscript,
  matchBrowserVoice,
  postInterrupt,
  postUtterance,
  setVoiceConfig,
  synthesizeSpeech,
  ttsSupported,
  useBrowserVoices,
  useSpeechInput,
  useVoiceState,
  useVoiceStream,
  VoiceSpeaker,
  zhVoiceInventory,
} from './client.ts'
import type {
  BrowserVoiceMatch,
  DailyBriefView,
  NarrationLine,
  SpeechInput,
  SpeechSynth,
  SpeakerStats,
  TtsEngineView,
  VoiceConfigView,
  VoiceEngineKind,
  VoiceProfileView,
  VoiceReplyView,
  VoiceStatusView,
  VoiceTranscriptView,
} from './client.ts'

import { withCatalog } from './configShape.ts'

export interface VoiceSessionOptions {
  /**
   * 播报日志保留条数。悬浮窗要短（360px 高），控制台要长。
   * ★ 这是**唯一的形态差异参数**：两边的数据口径必须是同一个。
   */
  logLimit?: number
  /**
   * 合成器每报出一个词边界回调一次（`speechSynthesis.onboundary`）。
   * 桌宠形态用它驱动口型；控制台形态不传。
   */
  onWordBoundary?: (index: number) => void
  /**
   * "此刻在不在念"变化时回调。桌宠用它驱动心情与口型开关。
   *
   * 注意区别于 `speaking` 返回值：那个是给界面读的 state，
   * 这个回调是给 rAF 循环这类**绕过 React**的消费者用的 —— 早一帧生效。
   */
  onSpeakingChange?: (speaking: boolean) => void
}

export interface VoiceSession {
  // ── 数据 ──
  config: VoiceConfigView | null
  profile: VoiceProfileView | null
  match: BrowserVoiceMatch
  inventory: { zh: number; total: number; names: string[] }
  log: NarrationLine[]
  workLine: NarrationLine | undefined
  /** 30 秒内的最新 P0 报警。桌宠用它切"报警"表情。 */
  recentAlarm: NarrationLine | null
  alarmCount: number
  status: VoiceStatusView | null
  stream: { connected: boolean; lastError: string | null }
  speech: SpeechInput
  caps: { asr: boolean; tts: boolean }
  /**
   * 云端神经链路的目录与健康度。
   *
   * 它存在的唯一目的是让"声音不好听"这件事**可归因**：
   * 是云端降级了（照着 note 去修），还是只是这一档不合口味（换一个就是了）。
   * 没有它，用户只能靠反复点音色按钮去试 —— 而问题常常不在音色上。
   */
  engine: TtsEngineView | null
  engineError: string | null
  /** 合成器的可观测计数：两条引擎各念了多少、降级多少次、有没有句子被丢掉。 */
  speaker: SpeakerStats
  /** 试听当前音色。**不经过服务端会话**（这不是一次对话，只是一次发声）。 */
  preview: (text?: string) => void
  /** 手动重测云端链路。降级之后想立刻再试一次，不必等冷却期。 */
  refreshEngine: () => void

  // ── 会话态 ──
  interim: string
  busy: boolean
  verdict: BargeInVerdict | null
  lastReply: VoiceReplyView | null
  lastUtterance: string
  speaking: boolean
  /** 本地合成器**实际念完**的条数（不是入队数）。 */
  spokenLocal: number
  saveNote: string | null
  daily: DailyBriefView | null
  /** 历史对话（落盘）。`null` = 还没读过 —— 与"读到了 0 条"是两件事。 */
  transcript: VoiceTranscriptView | null
  /** 读记录失败的原因。**必须与 `turns.length === 0` 分开显示**（判据 24）。 */
  transcriptError: string | null

  // ── 动作 ──
  say: (text: string) => Promise<void>
  /** 打断：先掐本地合成（听感立刻停），再让服务端作废在途答复。 */
  bargeIn: (reason?: string) => void
  patchConfig: (patch: Partial<Omit<VoiceConfigView, 'catalog'>>) => Promise<void>
  readDaily: () => Promise<void>
  /** 读一页历史对话。`more: true` 取更早的一页并接在已有记录后面。 */
  loadTranscript: (opts?: { more?: boolean }) => Promise<void>
}

export function useVoiceSession(opts: VoiceSessionOptions = {}): VoiceSession {
  const { logLimit = 200 } = opts
  const { state, dispatch } = useStore()
  const base = state.orchUrl
  const token = state.orchToken

  /**
   * 合成器。
   *
   * 用 `useRef` 惰性建实例（渲染期只**写**不读，这是允许的）。
   * 不能用 `useState`：`speaker.onWord` / `onSpeechChange` 是命令式回调槽位，
   * 赋值它就是修改 state 持有物 —— `react-hooks/immutability` 会正确地拦下它。
   * 而它本来也不该是 state：React 从不读它的内容，改它不需要重渲染。
   */
  const speakerRef = useRef<VoiceSpeaker | null>(null)
  if (speakerRef.current === null) speakerRef.current = new VoiceSpeaker()

  const [config, setConfig] = useState<VoiceConfigView | null>(null)
  const [log, setLog] = useState<NarrationLine[]>([])
  const [interim, setInterim] = useState('')
  const [lastReply, setLastReply] = useState<VoiceReplyView | null>(null)
  const [lastUtterance, setLastUtterance] = useState('')
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<BargeInVerdict | null>(null)
  const [spokenLocal, setSpokenLocal] = useState(0)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [daily, setDaily] = useState<DailyBriefView | null>(null)
  const [transcript, setTranscript] = useState<VoiceTranscriptView | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  /**
   * 最近一次读到的记录。
   *
   * ★ **不放返回值**：`react-hooks/refs` 会把"返回值里带 ref"判成渲染期读 ref
   *   （本项目实测过 32 条报错）。它只是给"更早一页"算游标用的内部状态，
   *   没有 React 之外的东西需要读它。
   */
  const transcriptRef = useRef<VoiceTranscriptView | null>(null)
  const [speaking, setSpeakingState] = useState(false)
  const [engine, setEngine] = useState<TtsEngineView | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [speakerStats, setSpeakerStats] = useState<SpeakerStats>({
    spoken: 0,
    neuralSpoken: 0,
    browserSpoken: 0,
    neuralFails: 0,
    noEngine: 0,
    engine: null,
    engineNote: null,
  })

  const seenRef = useRef<Set<string>>(new Set())
  /**
   * 合成结束后的静音窗截止时刻（**`Date.now()` 口径**）。
   *
   * 口径必须与判别方一致：`judgeBargeIn` 内部用 `Date.now()` 比较，
   * 这里若写 `performance.now()`（进程启动起算），两个时间轴差着 1.7e12 毫秒，
   * `now < cooldownUntil` 会**恒真** —— 表现是"打断彻底失效且没有任何报错"。
   *
   * 它压的是**音箱尾响**：合成已结束、但最后一个字的余音还被麦克风收着，
   * 此时来的中间结果几乎必然是自己的声音。窗的时长由
   * `speechTailCooldownDeadline` 给，不在这里写死。
   */
  const tailCooldownRef = useRef(0)

  /**
   * 形态回调。
   *
   * 走 ref 而不是写进 effect 依赖：这两个回调是**消费者**（桌宠的 rAF 循环）
   * 传进来的，每次渲染都可能是新函数。写进依赖会让合成器接线
   * 每帧重接一次 —— 而重接的那一刻正在念的句子会丢边界。
   */
  const cbRef = useRef<{ word?: (i: number) => void; speak?: (on: boolean) => void }>({})
  useEffect(() => {
    cbRef.current = { word: opts.onWordBoundary, speak: opts.onSpeakingChange }
  })

  const voices = useBrowserVoices()
  const status = useVoiceState(base, true)

  const inventory = useMemo(() => zhVoiceInventory(voices), [voices])
  /**
   * 当前音色的档案。
   *
   * `?? []` 不是防御性装饰：服务端写入路径曾经返回过一个**不带 catalog** 的配置
   * （见 `VoiceConfigView` 的说明），而这里原本是 `config?.catalog.find(...)` ——
   * 可选链只保护了 `config`，`catalog` 为 undefined 时抛 TypeError，
   * 整页被 ErrorBoundary 接走。服务端现已统一形状，这一层仍然保留：
   * **渲染期不该存在任何"能被数据打崩"的表达式。**
   */
  const profile = useMemo(() => {
    const c = config
    if (!c) return null
    return (c.catalog ?? []).find((v) => v.id === c.voiceId) ?? null
  }, [config])
  const match = useMemo(() => matchBrowserVoice(profile, voices), [profile, voices])

  /**
   * 合成所需的"当前上下文"。
   *
   * 为什么走 ref 而不是让 `synth` 闭包捕获 `config`/`profile`：
   * `synth` 会被交给一个**命令式对象**（`VoiceSpeaker`）长期持有，
   * 它不参与 React 渲染，因此永远拿不到新的闭包。闭包捕获的值从交给它的那一刻
   * 就冻结了 —— 用户换音色之后再播报，云端仍会按旧音色合成，
   * 而界面上明明已经选中了新音色。这正是"选了没变化"那类缺陷的复现方式。
   */
  const ctxRef = useRef<{
    base: string
    token: string
    voiceId: string | null
    rate: number
    engine: VoiceEngineKind | null
  }>({ base: '', token: '', voiceId: null, rate: 1, engine: null })
  useEffect(() => {
    ctxRef.current = {
      base,
      token,
      voiceId: config?.voiceId ?? null,
      rate: config?.rate ?? 1,
      engine: profile?.engine ?? null,
    }
  })

  /**
   * 云端合成的唯一入口。**身份稳定**（`useCallback([])` + 全走 ref），
   * 这样 `configure({synth})` 不会在每次配置变动时重接一次 ——
   * 重接的那一刻若正好有一次合成在途，那一句就会被交给一个已经被换掉的函数。
   */
  const synth = useCallback<SpeechSynth>(async (text) => {
    const c = ctxRef.current
    return synthesizeSpeech(c.base, c.token, text, { voiceId: c.voiceId ?? undefined, rate: c.rate })
  }, [])

  // ── 配置加载 ──
  const reloadConfig = useCallback(() => {
    getVoiceConfig(base)
      .then((c) => setConfig((prev) => withCatalog(c, prev)))
      .catch(() => undefined)
  }, [base])
  useEffect(() => {
    reloadConfig()
  }, [reloadConfig])

  // ── 合成器接线：音色 / 引擎 / 语速 / 音高 / 静默 ──
  useEffect(() => {
    speakerRef.current?.configure({
      voice: match.voice,
      voiceId: config?.voiceId ?? null,
      /**
       * ★ 只有神经音色才挂云端合成器。
       *
       * 判据必须是**档案里的 `engine`**（用户的选择），而不是"云端能不能连"
       * （运行时的状态）。用后者的话，云端一抖，选了本机音色的用户也会被
       * 拖去发一次注定失败的请求 —— 而那次失败会被计进链路健康度，
       * 让面板上多出一条与用户无关的"云端失败"。
       */
      synth: profile?.engine === 'neural' ? synth : null,
      // 档案的 rate/pitch 是这一档音色的"本音"，配置里的倍率叠在它上面 ——
      // 两者相乘才能让「换成男声」这种切换与用户的微调同时生效
      rate: (profile?.rate ?? 1) * (config?.rate ?? 1),
      pitch: (profile?.pitch ?? 1) * (config?.pitch ?? 1),
      // 静默音色 = 只出字幕不发声。这一档是给"会议室里盯盘"用的，不是故障。
      enabled: config ? config.voiceId !== 'silent' : true,
    })
  }, [config, profile, match.voice, synth])

  /**
   * 发声开关 + 尾响窗的接线。
   *
   * 两个回调都必须在**真的开始/结束发声**那一刻被触发，而不是入队时：
   *   · 入队时点亮"在说" → 队列里还排着上一句，头像会提前张嘴；
   *   · 入队时开尾响窗 → 等于把用户下一句话也一起吃掉。
   */
  useEffect(() => {
    const sp = speakerRef.current
    if (!sp) return
    sp.onWord = (n) => cbRef.current.word?.(n)
    sp.onSpeechChange = (on) => {
      setSpeakingState(on)
      cbRef.current.speak?.(on)
      if (!on) tailCooldownRef.current = speechTailCooldownDeadline(Date.now())
    }
    // 引擎切换时立刻把计数推给界面。等 1 秒的轮询也行，但"刚降级了"这件事
    // 恰恰是用户此刻在盯着看的东西 —— 让他等一秒，他就会去点音色按钮。
    sp.onEngine = () => setSpeakerStats(sp.stats())
    return () => {
      sp.onWord = null
      sp.onSpeechChange = null
      sp.onEngine = null
    }
  }, [])

  // ── 播报入库（按 id 去重：SSE 重连与状态快照会重叠送同一批）──
  const pushLines = useCallback(
    (lines: NarrationLine[], speak: boolean) => {
      const fresh: NarrationLine[] = []
      for (const l of lines) {
        if (seenRef.current.has(l.id)) continue
        seenRef.current.add(l.id)
        fresh.push(l)
      }
      if (fresh.length === 0) return
      if (seenRef.current.size > 800) {
        // 只保留最近 300 个 id，避免长会话把内存吃干净
        seenRef.current = new Set([...seenRef.current].slice(-300))
      }
      setLog((prev) => {
        const merged = [...fresh, ...prev]
        merged.sort((a, b) => b.ts - a.ts)
        return merged.slice(0, logLimit)
      })
      // 详略策略住在服务端 narrator 里 —— **客户端不再判一次**。
      // 两处各判一套必然漂移，而漂移出来的那套没有人测。
      if (!speak) return
      const sp = speakerRef.current
      if (!sp) return
      for (const l of fresh) sp.enqueue(l.text, l.priority)
    },
    [logLimit],
  )

  const onStreamLines = useCallback((lines: NarrationLine[]) => pushLines(lines, true), [pushLines])
  // 播报流与状态轮询都**不回写配置**：它们每几秒来一次，会把用户正在拖的滑杆拽回去。
  const onStreamStatus = useCallback(
    (s: VoiceStatusView) => pushLines(s.recentNarrations, false),
    [pushLines],
  )
  const stream = useVoiceStream(base, true, onStreamLines, onStreamStatus)

  // 首帧用状态快照把历史播报补齐（不发声：那是上一段会话已经念过的）
  useEffect(() => {
    if (!status) return
    pushLines(status.recentNarrations, false)
  }, [status, pushLines])

  // 合成器计数是命令式字段，靠一次轻量轮询把它映到界面上
  useEffect(() => {
    const t = window.setInterval(() => {
      const sp = speakerRef.current
      if (!sp) return
      const n = sp.spoken
      setSpokenLocal((prev) => (prev === n ? prev : n))
      const st = sp.stats()
      setSpeakerStats((prev) =>
        prev.spoken === st.spoken &&
        prev.neuralSpoken === st.neuralSpoken &&
        prev.browserSpoken === st.browserSpoken &&
        prev.neuralFails === st.neuralFails &&
        prev.noEngine === st.noEngine &&
        prev.engine === st.engine &&
        prev.engineNote === st.engineNote
          ? prev
          : st,
      )
    }, 1000)
    return () => window.clearInterval(t)
  }, [])

  // ── 云端链路状态 ──
  /**
   * 拉一次引擎状态。
   *
   * 它同时是"重测"动作：降级之后 `VoiceSpeaker` 会进冷却期，但用户想立刻再试一次
   * （比如他刚确认网络恢复了）。一次成功的合成才是把云端请回来的唯一方式，
   * 所以这里的动作是**重新拉状态 + 让用户从面板上发起一次试听**。
   */
  const refreshEngine = useCallback(() => {
    getTtsEngine(base)
      .then((e) => {
        setEngine(e)
        setEngineError(null)
      })
      .catch((e) => setEngineError(e instanceof Error ? e.message : String(e)))
  }, [base])
  useEffect(() => {
    refreshEngine()
    // 健康度会随着每次播报变化，慢周期对齐一次即可（它不参与任何风控判定）
    const t = window.setInterval(refreshEngine, 10_000)
    return () => window.clearInterval(t)
  }, [refreshEngine])

  // ── 说话 ──
  /**
   * 读一页历史对话（Task #114）。
   *
   * ★ 定义在 `say` **之前**，因为 `say` 成功后会调它刷新 —— 反过来写
   *   会撞上 `const` 的暂时性死区（`Block-scoped variable used before
   *   its declaration`）。这不是风格问题，是真实的编译错误。
   *
   * ★ 失败**不吞**：`transcriptError` 会被面板显示出来。这与 `readDaily` 里
   *   那几处 `.catch(() => undefined)` 是**有意不同**的 —— 那里失败最多是
   *   "数字没刷新"，而这里失败会让界面显示"你没聊过"，那是一句假话。
   *   （判据 24：缺数据要说出来；沉默的失败会伪装成"没问题"。）
   *
   * ★ 翻页游标用**时间戳**：`turnId` 是进程内自增，重启后会重复，
   *   拿它翻页会跳过或重复整段记录。
   */
  const loadTranscript = useCallback(
    async (opts?: { more?: boolean }) => {
      const more = opts?.more === true
      const prev = transcriptRef.current
      // 还没读过第一页就谈不上"更早"
      if (more && !prev) return
      const beforeAt = more && prev && prev.turns.length > 0 ? prev.turns[prev.turns.length - 1].at : undefined
      try {
        // ★ 必须带 token：这是语音线上**唯一带 token 的只读端点** ——
        //   它给的是逐字正文（持仓、金额、下单原话），不是聚合数字。
        //   不带的话服务端 401，面板会显示"读不到对话记录"，
        //   而用户会以为自己从没聊过（判据 24：缺数据要说出来，
        //   但"说不出来"与"真的没有"必须能分辨）。
        const page = await getVoiceTranscript(base, token, beforeAt !== undefined ? { beforeAt } : {})
        const next: VoiceTranscriptView = more && prev ? { ...page, turns: [...prev.turns, ...page.turns] } : page
        transcriptRef.current = next
        setTranscript(next)
        setTranscriptError(null)
      } catch (e) {
        setTranscriptError(e instanceof Error ? e.message : String(e))
      }
    },
    [base, token],
  )

  const say = useCallback(
    async (text: string) => {
      const t = text.trim()
      if (!t || busy) return
      setBusy(true)
      try {
        const r = await postUtterance(base, token, t)
        setLastReply(r)
        setLastUtterance(t)
        if (r.narration.length > 0) pushLines(r.narration, true)
        // ★ dropped 必须被尊重：这句已被更晚的打断作废，
        //   念出来用户就会听到"答非所问"
        if (!r.dropped && r.reply.trim()) speakerRef.current?.enqueue(r.reply, 'P1_IMPORTANT')
        reloadConfig()
        // 面板开着的时候，说完一句就把记录刷一遍 —— 否则用户要手动点刷新才
        // 看得到自己刚说的那句，而"我刚明明说了"配上一个没变的列表，
        // 会被读成"系统没记下来"。只刷**首页**，不打断正在翻的历史页。
        if (transcriptRef.current) void loadTranscript()
      } catch (e) {
        pushToast(dispatch, `❌ 语音请求失败：${e instanceof Error ? e.message : e}`)
      } finally {
        setBusy(false)
        setInterim('')
      }
    },
    [base, token, busy, pushLines, reloadConfig, dispatch, loadTranscript],
  )

  const bargeIn = useCallback(
    (reason = 'USER_BARGE_IN') => {
      speakerRef.current?.stop()
      void postInterrupt(base, token, reason)
        .then(() => reloadConfig())
        .catch(() => undefined)
    },
    [base, token, reloadConfig],
  )

  /**
   * 判定一次中间结果算不算"用户真在插话"。
   *
   * 判别逻辑**不在这里** —— 它住在 `src/pet/echoGuard.ts` 的 `judgeBargeIn`：
   * 那是个纯函数，能被烟测直接喂样例断言，而写在这个回调里的版本不能。
   *
   * `listening` 直接传 `true`：这个回调只可能从识别器的 `onresult` 里被调出来，
   * 而识别器不在跑就不会有结果。这里不是"假设它在收音"，是它必然在收音。
   */
  const onBargeIn = useCallback(
    (text: string) => {
      const v = judgeBargeIn({
        interim: text,
        speakingText: speakerRef.current?.currentText ?? null,
        listening: true,
        cooldownUntil: tailCooldownRef.current,
      })
      setVerdict(v)
      if (!v.bargeIn) return false
      bargeIn('USER_BARGE_IN')
      return true
    },
    [bargeIn],
  )

  const speech = useSpeechInput(
    {
      onInterim: (t) => setInterim(t),
      onBargeIn,
      onFinal: (t) => {
        setInterim('')
        void say(t)
      },
      onError: (msg) => pushToast(dispatch, `⚠️ ${msg}`),
    },
    'zh-CN',
  )

  // ── 设置写入 ──
  const patchConfig = useCallback(
    async (patch: Partial<Omit<VoiceConfigView, 'catalog'>>) => {
      try {
        const r = await setVoiceConfig(base, token, patch)
        // 写入路径的返回值也过一遍收口 —— 绝不把"少字段的配置"塞进 state
        setConfig((prev) => withCatalog(r.config, prev))
        setSaveNote(r.ok ? '已生效' : `未生效：${r.reason ?? '未知原因'}`)
        window.setTimeout(() => setSaveNote(null), 2600)
        if (!r.ok) pushToast(dispatch, `⚠️ ${r.reason ?? '设置未生效'}`)
      } catch (e) {
        pushToast(dispatch, `❌ 设置失败：${e instanceof Error ? e.message : e}`)
      }
    },
    [base, token, dispatch],
  )

  const readDaily = useCallback(async () => {
    // 一次点两下：POST 走的是"让它开口念"的正式路径（会在账本留 VOICE_DAILY_REPORT），
    // GET 是给面板取结构化数字。两者口径同源（同一个 dailyBrief()）。
    void getVoiceDaily(base)
      .then((d) => setDaily(d))
      .catch(() => undefined)
    await say('读一下今天的日报')
  }, [base, say])

  /**
   * 试听当前音色。
   *
   * ★ 它**不经过 `/voice/utterance`**：这不是一次对话 —— 没有意图、没有待确认、
   *   也不会在账本上留下任何东西。走那条路反而会污染会话状态
   *   （比如把用户刚问出口的那一句作废掉），而用户只是想听听声音。
   * ★ 优先级用 P1：试听可以排队等当前这一句念完，但**不许抢报警的位置**。
   */
  const preview = useCallback(
    (text?: string) => {
      const sp = speakerRef.current
      if (!sp) return
      const who = profile?.label ?? '当前音色'
      sp.enqueue(
        text?.trim() || '试听：现在这一档是' + who + '。觉得干巴巴的话，换一个云端音色再听。',
        'P1_IMPORTANT',
      )
    },
    [profile],
  )

  // ── 派生 ──
  const workLine = useMemo(
    () => log.find((l) => l.priority === 'P2_STATUS' || l.category === 'work-state'),
    [log],
  )
  const recentAlarm = useMemo(
    () => log.find((l) => l.priority === 'P0_ALARM' && Date.now() - l.ts < 30_000) ?? null,
    [log],
  )
  const alarmCount = status?.narrator.emittedByPriority.P0_ALARM ?? 0
  const caps = useMemo(() => ({ asr: asrSupported(), tts: ttsSupported() }), [])

  return {
    config, profile, match, inventory,
    log, workLine, recentAlarm, alarmCount,
    status, stream, speech, caps,
    engine, engineError, speaker: speakerStats, preview, refreshEngine,
    interim, busy, verdict, lastReply, lastUtterance, speaking, spokenLocal, saveNote, daily,
    transcript, transcriptError,
    say, bargeIn, patchConfig, readDaily, loadTranscript,
  }
}
