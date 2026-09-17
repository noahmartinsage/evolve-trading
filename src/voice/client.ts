/**
 * 语音交互层 —— 前端接入
 *
 * ── 三层职责，刻意分开 ────────────────────────────────────────────────
 *   ① HTTP 契约层：与服务端 `/voice/*` 通信（`fetchVoiceState` 等）
 *   ② 浏览器语音层：ASR（SpeechRecognition）/ TTS（speechSynthesis）
 *   ③ 会话时序层：打断信号（本文件只负责**发**信号，判定权在服务端的 generation）
 *
 * 之所以要在文件头把这三层写清楚：这类功能最典型的实现事故就是
 * 「前端自己判断这句话是个下单指令，于是直接去调下单接口」——
 * 那等于把两段式确认架空了，因为确认凭证住在服务端会话里。
 *
 * ── 一条不可越过的线 ──────────────────────────────────────────────────
 * 前端**不决定要不要执行**。它只做两件事：把用户说的话送上去、
 * 把服务端明确回给它的答复念出来。所有执行判定都在服务端。
 *
 * ── `dropped` 为什么必须被尊重 ────────────────────────────────────────
 * 服务端答复里带 `dropped: true` 表示「这句话已经被更晚的打断作废」。
 * 前端拿到后**必须不念**。若图省事照念，用户会先听到新问题的答复、
 * 再被旧问题的答复打断一次 —— 表现为"这个助手抢话、答非所问"，
 * 而所有日志都是正常的。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// ───────────────────────────── 服务端契约 ─────────────────────────────
//
// 契约类型**本体**住在 `clientTypes.ts`。搬出去的理由很实际：那里没有 React，
// 于是一个纯逻辑模块（`speechPath.ts`）与烟测都能直接导入同一份类型去断言，
// 而不必先把整个 React 拖进来。
//
// 这里只做再导出 —— 既有调用点写的是 `from './client.ts'`，一行都不用改。
// ★ 绝不允许在这里再抄一份：类型有两份，改一处就一定有一处不同步。

export type {
  NarrationPriority,
  NarrationCategory,
  NarrationLine,
  Verbosity,
  ConfirmPolicy,
  VoiceEngineKind,
  VoiceProfileView,
  VoiceConfigView,
  OrderSlotsView,
  PendingConfirmationView,
  TurnState,
  VoiceTurnView,
  VoiceCountersView,
  VoiceStatusView,
  VoiceExecutedView,
  VoiceReplyView,
  DailyBriefView,
  NeuralVoiceView,
  TtsStatsView,
  TtsEngineView,
} from './clientTypes.ts'

import type {
  NarrationPriority,
  NarrationCategory,
  NarrationLine,
  Verbosity,
  ConfirmPolicy,
  VoiceProfileView,
  VoiceConfigView,
  VoiceStatusView,
  VoiceReplyView,
  DailyBriefView,
  TtsEngineView,
} from './clientTypes.ts'
import { mp3DurationEstimate, neuralWordTicks, speechPathPlan } from './speechPath.ts'
import type { SpeechEngine } from './speechPath.ts'

// ───────────────────────────── 展示口径 ─────────────────────────────

/**
 * 优先级 → 中文标签与颜色。
 *
 * 颜色沿用系统既有语义：红=危险、橙=注意、青=常态、灰=参考。
 * 与涨跌色刻意不共用一组，避免用户把「报警红」读成「上涨红」。
 */
export const PRIORITY_META: Record<NarrationPriority, { label: string; color: string; rank: number }> = {
  P0_ALARM: { label: '紧急报警', color: 'var(--up)', rank: 0 },
  P1_IMPORTANT: { label: '重要', color: 'var(--warning)', rank: 1 },
  P2_STATUS: { label: '工作状态', color: 'var(--primary)', rank: 2 },
  P3_MARKET: { label: '盘面', color: 'var(--text-sub)', rank: 3 },
}

export const CATEGORY_LABEL: Record<NarrationCategory, string> = {
  'work-state': '在做什么',
  'next-step': '下一步',
  'risk-alarm': '风控报警',
  surveillance: '监控',
  'market-anomaly': '盘面异动',
  order: '订单',
  gate: '门禁',
  'daily-report': '日报',
  chat: '对话',
}

export const VERBOSITY_META: Record<Verbosity, { label: string; desc: string }> = {
  'alarm-only': { label: '只说报警', desc: '连成交都不播。盯盘时不想被打扰' },
  normal: {
    label: '报警 + 重要 + 状态',
    desc: '默认档。含成交、门禁结论、日报，以及「我正在干什么、下一步干什么」',
  },
  chatty: { label: '全都说', desc: '在默认档之上再加盘面异动明细与闲聊' },
}

export const CONFIRM_POLICY_META: Record<ConfirmPolicy, { label: string; desc: string }> = {
  graded: { label: '按金额分档', desc: '仿真且 ≤50 美元说「确认」即可；大额与实盘必须复述金额' },
  always: { label: '一律复述金额', desc: '任何下单都要把金额念一遍才执行' },
}

// ───────────────────────────── HTTP 契约层 ─────────────────────────────

async function voiceFetch<T>(base: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base.replace(/\/+$/, '') + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-orch-token': token, ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 200) }
  }
  if (!res.ok && res.status !== 422) {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`)
  }
  return body as T
}

export function getVoiceConfig(base: string): Promise<VoiceConfigView> {
  return voiceFetch<VoiceConfigView>(base, '', '/voice/config')
}

export function setVoiceConfig(
  base: string,
  token: string,
  patch: Partial<Omit<VoiceConfigView, 'catalog'>>,
): Promise<{ ok: boolean; reason?: string; config: VoiceConfigView }> {
  return voiceFetch(base, token, '/voice/config', { method: 'POST', body: JSON.stringify(patch) })
}

export function getVoiceState(base: string): Promise<VoiceStatusView> {
  return voiceFetch<VoiceStatusView>(base, '', '/voice/state')
}

export function getVoiceDaily(base: string): Promise<DailyBriefView> {
  return voiceFetch<DailyBriefView>(base, '', '/voice/daily')
}

/**
 * 送一句话上去。
 *
 * 注意：**不做任何本地意图判断**。哪怕这句话看上去明显是"查持仓"，
 * 也照样送上去让服务端解析 —— 本地"顺手优化"一下就等于多了一套
 * 会与服务端漂移的解析逻辑，而漂移出来的那条恰好不会有人测。
 */
export function postUtterance(base: string, token: string, text: string): Promise<VoiceReplyView> {
  return voiceFetch<VoiceReplyView>(base, token, '/voice/utterance', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function postInterrupt(
  base: string,
  token: string,
  reason = 'USER_BARGE_IN',
): Promise<{ generation: number; droppedPending: boolean }> {
  return voiceFetch(base, token, '/voice/interrupt', { method: 'POST', body: JSON.stringify({ reason }) })
}

// ───────────────────────────── 神经合成层 ─────────────────────────────

/** 云端合成引擎的健康度与目录。面板用它解释"为什么这次听起来不一样"。 */
export function getTtsEngine(base: string): Promise<TtsEngineView> {
  return voiceFetch<TtsEngineView>(base, '', '/voice/engine')
}

/** 一次云端合成的结果。失败**不抛**，而是把原因结构化交回调用方。 */
export type SynthOutcome =
  | { ok: true; url: string; bytes: number; mime: string }
  | { ok: false; kind: string; message: string }

/**
 * 合成一段音频（云端神经音色），返回可直接喂给 `Audio` 的对象 URL。
 *
 * ★ 为什么不能复用 `voiceFetch`：那条路假定响应是 JSON（`res.text()` + `JSON.parse`），
 *   而这个接口成功时回的是**二进制 MP3**。走 `voiceFetch` 会把音频当文本读，
 *   拿到一段乱码然后 `JSON.parse` 失败 —— 表现成"每次合成都说失败"，
 *   而服务端账本里全是成功的记录。两个接口的形状不同，读取方式就必须不同。
 *
 * ★ 失败一律转成 `{ok:false}` 而不是抛：调用方据此退回本机合成，
 *   并在面板上写明"这次退回的"。抛异常会让降级路径变成 catch 里的隐形分支，
 *   而隐形分支不会有人测。
 *
 * ★ 对象 URL 的所有权在调用方：它必须在用完后 `URL.revokeObjectURL`。
 *   这里刻意不缓存、不复用 —— 一段播报念完就没用了，缓存只会占内存。
 */
export async function synthesizeSpeech(
  base: string,
  token: string,
  text: string,
  opts: { voiceId?: string; rate?: number } = {},
): Promise<SynthOutcome> {
  const url = base.replace(/\/+$/, '') + '/voice/tts'
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orch-token': token },
      body: JSON.stringify({ text, voiceId: opts.voiceId, rate: opts.rate }),
    })
  } catch {
    return { ok: false, kind: 'network', message: '连不上语音服务，已退回本机合成' }
  }
  if (!res.ok) {
    // 502 携带结构化原因（kind + 人话 message）。读不出就照实说读不出，
    // 不要编一个"合成失败"糊过去 —— 那会让 403 版本过期与网络抖动看起来一样。
    let kind = `http-${res.status}`
    let message = `语音服务返回 ${res.status}，已退回本机合成`
    try {
      const body = (await res.json()) as { kind?: string; message?: string }
      if (typeof body.kind === 'string') kind = body.kind
      if (typeof body.message === 'string' && body.message.trim()) message = body.message
    } catch {
      /* 保留默认文案 */
    }
    return { ok: false, kind, message }
  }
  const mime = res.headers.get('content-type') ?? ''
  if (!mime.startsWith('audio/')) {
    // 200 但不是音频 = 契约被改坏了。这比 502 更该被看见。
    return { ok: false, kind: 'bad-content-type', message: `语音服务回了 ${mime || '空类型'} 而不是音频，已退回本机合成` }
  }
  const blob = await res.blob()
  if (blob.size === 0) return { ok: false, kind: 'empty-audio', message: '语音服务回了一段空音频，已退回本机合成' }
  return { ok: true, url: URL.createObjectURL(blob), bytes: blob.size, mime }
}

// ───────────────────────────── 浏览器语音层 ─────────────────────────────

/** 浏览器语音合成是否可用（Electron 里可能缺失，面板要如实说）。 */
export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'
}

// Web Speech 的识别接口至今不在 lib.dom 里，只能自己描述最小形状。
// 刻意不写 `any`：一旦写成 any，后面所有调用点的字段名写错都不会报错。
interface AsrAlternative {
  transcript: string
  confidence: number
}
interface AsrResult {
  readonly length: number
  isFinal: boolean
  item(i: number): AsrAlternative
  [i: number]: AsrAlternative
}
interface AsrResultList {
  readonly length: number
  item(i: number): AsrResult
  [i: number]: AsrResult
}
interface AsrEvent {
  resultIndex: number
  results: AsrResultList
}
interface AsrErrorEvent {
  error: string
  message?: string
}
interface Asr {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: (() => void) | null
  onresult: ((e: AsrEvent) => void) | null
  onerror: ((e: AsrErrorEvent) => void) | null
  onend: (() => void) | null
}
type AsrCtor = new () => Asr

export function asrSupported(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { SpeechRecognition?: AsrCtor; webkitSpeechRecognition?: AsrCtor }
  return typeof (w.SpeechRecognition ?? w.webkitSpeechRecognition) === 'function'
}

function asrCtor(): AsrCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: AsrCtor; webkitSpeechRecognition?: AsrCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** ASR 错误码 → 中文提示。`not-allowed` 与 `network` 的处理方式完全不同，不能糊成一句"识别失败"。 */
export function asrErrorText(code: string): string {
  const map: Record<string, string> = {
    'not-allowed': '浏览器拒绝了麦克风权限。请在地址栏左侧放开麦克风，或改用下方文字输入。',
    'service-not-allowed': '浏览器禁用了语音识别服务。可用下方文字输入。',
    'audio-capture': '没找到可用麦克风设备。',
    network: '语音识别服务不可达（该 API 依赖浏览器厂商的在线服务，离线环境会失败）。',
    'no-speech': '这一轮没听到人声。',
    aborted: '识别被中断。',
  }
  return map[code] ?? `识别出错（${code}）。`
}

export interface BrowserVoiceMatch {
  voice: SpeechSynthesisVoice | null
  /**
   * 是怎么选出来的 —— 面板照实显示，用户才知道音色切换是不是真生效了。
   *
   * `'neural'` 是后加的一档：神经音色**根本不经操作系统语音包**，
   * 拿它去比 `getVoices()` 只会得到一个"匹配失败"的假警告，
   * 而那个警告会把用户引向错误的方向（去装语音包）。
   */
  how: 'exact' | 'locale-fallback' | 'silent' | 'none' | 'neural'
}

/**
 * 把目录里的音色档案映射到操作系统真的装了的那个音色。
 *
 * 关键点：`matchNames` 只是候选。目录里写了 7 个，机器上可能只装了 1 个中文音色。
 * 这里如实回报 `how`，面板据此显示「候选都没命中，退到同语种音色」，
 * 而不是假装切换成功了。
 *
 * 神经音色直接短路返回 `'neural'`：它的出声路径与系统语音包无关，
 * 去映射一遍毫无意义，只会产出误导性的"没找到"。
 */
export function matchBrowserVoice(profile: VoiceProfileView | null, voices: SpeechSynthesisVoice[]): BrowserVoiceMatch {
  if (!profile) return { voice: null, how: 'none' }
  if (profile.id === 'silent') return { voice: null, how: 'silent' }
  if (profile.engine === 'neural') return { voice: null, how: 'neural' }
  for (const cand of profile.matchNames) {
    const c = cand.toLowerCase()
    const hit = voices.find((v) => v.name.toLowerCase().includes(c))
    if (hit) return { voice: hit, how: 'exact' }
  }
  const prefix = profile.locale.slice(0, 2).toLowerCase()
  const same = voices.find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(prefix))
  return same ? { voice: same, how: 'locale-fallback' } : { voice: null, how: 'none' }
}

/** 统计机器上实际装了多少中文音色 —— 面板用它代替"目录里有 7 个"这种无法反驳的声明。 */
export function zhVoiceInventory(voices: SpeechSynthesisVoice[]): { zh: number; total: number; names: string[] } {
  const zh = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('zh'))
  return { zh: zh.length, total: voices.length, names: zh.map((v) => v.name) }
}

/** `getVoices()` 在 Chrome 首次调用常返回空数组，必须等 `voiceschanged`。 */
export function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    if (!ttsSupported()) return
    let alive = true
    const read = () => {
      if (!alive) return
      setVoices(window.speechSynthesis.getVoices().slice())
    }
    read()
    window.speechSynthesis.addEventListener('voiceschanged', read)
    // 部分浏览器不发 voiceschanged，补一次延时兜底
    const t = window.setTimeout(read, 800)
    return () => {
      alive = false
      window.speechSynthesis.removeEventListener('voiceschanged', read)
      window.clearTimeout(t)
    }
  }, [])
  return voices
}

/**
 * 云端合成的注入点。
 *
 * 做成注入而不是写死在合成器里，有两个理由：
 *   ① 合成需要 base/token，那是会话层的东西，合成器不该知道；
 *   ② 烟测可以塞一个假的进来 —— 包括一个"总是失败"的假实现，
 *      用来断言降级路径真的会走到（失败分支不测，等于没写）。
 */
export type SpeechSynth = (text: string, opts: { voiceId: string | null }) => Promise<SynthOutcome>

/** 合成器的可观测计数。界面读它来解释"声音到底是从哪来的"。 */
export interface SpeakerStats {
  /** 真念完的条数（两条引擎合计）。面板显示它，用来证明"合成真的发生过"。 */
  spoken: number
  neuralSpoken: number
  browserSpoken: number
  neuralFails: number
  /** 两条路都没有、被丢掉的条数。它不为 0 时面板必须说出来。 */
  noEngine: number
  /** 最近一条实际用的引擎。 */
  engine: SpeechEngine | null
  /** 最近一次降级的**人话原因**（没降级时为 null）。 */
  engineNote: string | null
}

/**
 * 播报合成器。
 *
 * 做成 class 而不是 hook，是因为它持有的是**命令式的音频队列**，
 * 用 React 状态表达反而会引入"重新渲染→重排队列"这种不必要的不确定性。
 *
 * 三条硬规则：
 *   ① P0 抢占：紧急报警到达时清空队列立即出声（静音也只是面板静音，
 *      这条仍要说 —— 与服务端 narrator 的放行规则保持一致）。
 *   ② `stop()` 后旧 utterance / 旧 Audio 的回调不得复活队列：靠 `epoch` 把
 *      已被作废的回调认出来丢掉，否则打断之后会听到半句旧话。
 *   ③ 出声只有两条路：云端神经音频、本机语音包。**走哪条由
 *      `speechPathPlan` 一处决定**，这里不再自己判一遍 —— 判两遍必然漂移。
 */
export class VoiceSpeaker {
  private queue: { text: string; priority: NarrationPriority }[] = []
  private speaking = false
  /**
   * 是否已经对外广播过"我在说话"。
   *
   * 与 `speaking` 刻意分开：云端合成有约 1.5 秒的等待期，那段时间
   * `speaking` 已经为 true（必须为真 —— 用户此时插话要能掐掉它在途的音频），
   * 但**声音还没出来**。若此时就把"正在说话"广播出去，桌宠的嘴会先张 1.5 秒。
   * 所以对外广播只挂在"音频真的开始播"这一刻上（`announced` 保证成对）。
   */
  private announced = false
  private epoch = 0
  private voice: SpeechSynthesisVoice | null = null
  /** 当前选中的音色 id。`silent` 会让整条路变成"只出字幕"。 */
  private voiceId: string | null = null
  private synth: SpeechSynth | null = null
  private rate = 1
  private pitch = 1
  private enabled = true
  /** 上一次云端合成的结果。`speechPathPlan` 靠它决定报警还能不能走云端。 */
  private lastOutcome: 'ok' | 'fail' | null = null
  private lastAttemptAt = 0
  private audio: HTMLAudioElement | null = null
  private audioUrl: string | null = null
  private lipTimers: number[] = []
  /** 推队列的重入锁，见 `pump()` 的说明。 */
  private draining = false

  spoken = 0
  neuralSpoken = 0
  browserSpoken = 0
  neuralFails = 0
  noEngine = 0
  lastEngine: SpeechEngine | null = null
  engineNote: string | null = null

  /**
   * 正在念的这一句。
   *
   * 存在的唯一理由：麦克风会把系统自己的声音收进去。没有这个字段的话，
   * 助手一念长句就会"听到自己"并触发自打断，表现为「说了半句突然哑掉」。
   * 调用方拿它做回声判别（见 src/pet/echoGuard.ts 的 judgeBargeIn）。
   */
  currentText: string | null = null
  /**
   * 词边界回调。桌宠拿它驱动头像口型。
   *
   * 本机那条路用 `speechSynthesis.onboundary`（它带 `charIndex`）。
   * 云端那条路拿不到任何边界事件 —— 它只是一段 MP3，所以由
   * `neuralWordTicks` 按字数均摊出一条时间轴。两条路的**语义相同**：
   * 参数是这一段的字数，长词嘴张得大，短词轻动一下。
   */
  onWord: ((charCount: number) => void) | null = null
  /**
   * 合成起止回调。
   *
   * 注意它与 `enqueue` 不是一回事：`enqueue` 只是入队，队列里还有前一句时
   * 这一句并没有开始发声。口型必须挂在**真的开始念**这一个时刻上，
   * 否则桌宠会在还没出声时就开始张嘴。
   */
  onSpeechChange: ((speaking: boolean) => void) | null = null
  /**
   * 实际用了哪条引擎。**这条链路的可观测性全靠它** ——
   * 没有它，"云端降级了"与"音色不合口味"在界面上长得一模一样，
   * 用户会反复点音色按钮，而问题根本不在那里。
   */
  onEngine: ((engine: SpeechEngine, note: string | null) => void) | null = null

  configure(patch: {
    voice?: SpeechSynthesisVoice | null
    voiceId?: string | null
    synth?: SpeechSynth | null
    rate?: number
    pitch?: number
    enabled?: boolean
  }): void {
    if (patch.voice !== undefined) this.voice = patch.voice
    if (patch.voiceId !== undefined) this.voiceId = patch.voiceId
    if (patch.synth !== undefined) this.synth = patch.synth
    if (patch.rate !== undefined) this.rate = patch.rate
    if (patch.pitch !== undefined) this.pitch = patch.pitch
    if (patch.enabled !== undefined) this.enabled = patch.enabled
  }

  /** 快照当前计数。命令式字段不能直接进 React state，调用方靠它做一次映射。 */
  stats(): SpeakerStats {
    return {
      spoken: this.spoken,
      neuralSpoken: this.neuralSpoken,
      browserSpoken: this.browserSpoken,
      neuralFails: this.neuralFails,
      noEngine: this.noEngine,
      engine: this.lastEngine,
      engineNote: this.engineNote,
    }
  }

  enqueue(text: string, priority: NarrationPriority = 'P1_IMPORTANT'): void {
    const t = text.trim()
    if (!t || !this.enabled) return
    // 两条路都不存在时才丢。只判 `ttsSupported()` 会把"云端能用但本机没有语音包"
    // 的环境直接判死 —— 而那正好是这套云端音色要救的那类机器。
    if (!this.synth && !ttsSupported()) {
      this.noEngine += 1
      return
    }
    if (priority === 'P0_ALARM') {
      // 报警不许排队等前面念完 —— 排队就等于延迟报警
      this.stop()
    }
    this.queue.push({ text: t, priority })
    this.pump()
  }

  /** 立即停止并作废队列（用户插话时调用）。 */
  stop(): void {
    this.epoch += 1
    this.queue = []
    const wasAnnounced = this.announced
    this.speaking = false
    this.announced = false
    this.currentText = null
    this.clearAudio()
    if (ttsSupported()) window.speechSynthesis.cancel()
    // 只在原本真的在出声时通知 —— 否则桌宠会在没说话时也收到一次"停止"，
    // 口型状态机被无谓地重置，表现为打断后头像僵一下。
    if (wasAnnounced) this.onSpeechChange?.(false)
  }

  /** 放掉音频资源与口型定时器。幂等。 */
  private clearAudio(): void {
    for (const t of this.lipTimers) window.clearTimeout(t)
    this.lipTimers = []
    const a = this.audio
    if (a) {
      a.onended = null
      a.onerror = null
      a.onloadedmetadata = null
      try {
        a.pause()
      } catch {
        /* 未开始播放 */
      }
    }
    this.audio = null
    if (this.audioUrl) {
      // 对象 URL 不回收会一直占着那份 MP3 —— 长会话下是真的会涨内存
      URL.revokeObjectURL(this.audioUrl)
      this.audioUrl = null
    }
  }

  private setEngine(engine: SpeechEngine, note: string | null): void {
    this.lastEngine = engine
    this.engineNote = note
    this.onEngine?.(engine, note)
  }

  private announce(on: boolean): void {
    if (on) {
      if (this.announced) return
      this.announced = true
      this.onSpeechChange?.(true)
      return
    }
    if (!this.announced) return
    this.announced = false
    this.onSpeechChange?.(false)
  }

  /**
   * 把队列推到"有一句正在出声"或"队列空了"为止。
   *
   * 用循环 + `draining` 重入锁，而不是"每念完一句递归调一次"：
   * 有些环境里 `speechSynthesis.speak()` 会**同步**触发 `onerror`，
   * 于是 `finish → pump → speakBrowser → onerror → finish` 会一路递归下去，
   * 队列越长栈越深 —— 表现为"播报多了就整页卡死"，且没有任何异常。
   */
  private pump(): void {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.speaking) {
        const next = this.queue.shift()
        if (!next) break
        this.dispatch(next)
      }
    } finally {
      this.draining = false
    }
    // 重入被挡掉的那些项还要有机会被处理（典型场景：speak 同步报错）
    if (!this.speaking && this.queue.length > 0) this.pump()
  }

  private dispatch(next: { text: string; priority: NarrationPriority }): void {
    const path = speechPathPlan({
      voiceId: this.voiceId,
      priority: next.priority,
      lastOutcome: this.lastOutcome,
      lastAttemptAt: this.lastAttemptAt,
      now: Date.now(),
      neuralWired: this.synth !== null,
      browserUsable: ttsSupported(),
    })
    if (path === 'silent') {
      // 两条路都没有。丢是可以接受的物理现实，**不说**不可以 —— 计数留给面板。
      this.noEngine += 1
      return
    }
    if (path === 'neural') {
      void this.speakNeural(next)
      return
    }
    this.speakBrowser(next, this.epoch)
  }

  // ── 云端神经这条路 ──

  private async speakNeural(next: { text: string; priority: NarrationPriority }): Promise<void> {
    const synth = this.synth
    if (!synth) {
      this.speakBrowser(next, this.epoch)
      return
    }
    const myEpoch = this.epoch
    this.speaking = true
    this.currentText = next.text
    this.lastAttemptAt = Date.now()
    let out: SynthOutcome
    try {
      out = await synth(next.text, { voiceId: this.voiceId })
    } catch (e) {
      // 注入的实现理论上不抛，但真抛了也必须落到"退回本机"，不是整句消失
      out = { ok: false, kind: 'threw', message: `云端合成抛错：${e instanceof Error ? e.message : String(e)}` }
    }
    if (myEpoch !== this.epoch) {
      // 已被打断：这段音频连播都不该播。白拿回来的就立刻回收掉。
      if (out.ok) URL.revokeObjectURL(out.url)
      return
    }
    if (!out.ok) {
      this.lastOutcome = 'fail'
      // `local-engine` 不是故障：它表示服务端认为这个 id 本来就该由本机合成
      // （典型成因是用户在合成途中换了音色）。把它计进健康度会让面板长期
      // 挂着一个假的"云端失败 N 次"，然后用户学会忽略这个指标。
      if (out.kind !== 'local-engine') this.neuralFails += 1
      this.setEngine('local', out.kind === 'local-engine' ? null : `${out.message}（${out.kind}）`)
      this.speaking = false
      this.speakBrowser(next, myEpoch)
      return
    }
    this.lastOutcome = 'ok'
    this.playNeural(next, out, myEpoch)
  }

  private playNeural(next: { text: string; priority: NarrationPriority }, out: { url: string; bytes: number }, myEpoch: number): void {
    const text = next.text
    let a: HTMLAudioElement
    try {
      a = new Audio(out.url)
    } catch {
      URL.revokeObjectURL(out.url)
      this.neuralFails += 1
      this.lastOutcome = 'fail'
      this.setEngine('local', '本环境无法播放音频，已退回本机合成')
      this.speaking = false
      this.speakBrowser(next, myEpoch)
      return
    }
    this.audio = a
    this.audioUrl = out.url
    let lipsScheduled = false
    const scheduleLips = (ms: number) => {
      if (lipsScheduled) return
      lipsScheduled = true
      for (const t of neuralWordTicks(text, ms)) {
        this.lipTimers.push(
          window.setTimeout(() => {
            if (myEpoch !== this.epoch) return
            this.onWord?.(t.chars)
          }, t.atMs),
        )
      }
    }
    a.onloadedmetadata = () => {
      if (myEpoch !== this.epoch) return
      const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : mp3DurationEstimate(out.bytes)
      scheduleLips(d)
    }
    a.onended = () => this.finish(myEpoch, 'neural')
    a.onerror = () => this.neuralAudioFailed(next, myEpoch, '音频解码失败')
    void a
      .play()
      .then(() => {
        if (myEpoch !== this.epoch) {
          try {
            a.pause()
          } catch {
            /* 未开始 */
          }
          return
        }
        // 与 `speakBrowser` 同一个道理：若在 play() 之前就已经失败降级过
        // （speaking 已被置回 false），这里绝不能再点亮一次"正在说话"。
        if (myEpoch === this.epoch && this.speaking) this.announce(true)
        // 某些环境不派发 loadedmetadata，补一次兜底 —— 口型不动比算错时长更明显
        window.setTimeout(() => {
          if (myEpoch !== this.epoch) return
          scheduleLips(mp3DurationEstimate(out.bytes))
        }, 400)
      })
      .catch(() => {
        // 自动播放被拒（用户还没交互过）会走到这里。
        // 它**看起来像静音**，实际上这句话一个字都没念出来 —— 必须降级，不能吞。
        this.neuralAudioFailed(next, myEpoch, '浏览器拒绝播放（需要一次用户交互）')
      })  }

  private neuralAudioFailed(next: { text: string; priority: NarrationPriority }, myEpoch: number, why: string): void {
    if (myEpoch !== this.epoch) return
    this.lastOutcome = 'fail'
    this.neuralFails += 1
    this.setEngine('local', `${why}，已退回本机合成`)
    this.clearAudio()
    this.speaking = false
    this.announce(false)
    // ★ 优先级原样带过去：一句 P0 报警降级之后仍然紧急，
    //   把它改成 P1 只是让日志好看，代价是这句报警从此可以被排队。
    this.speakBrowser(next, myEpoch)
  }

  // ── 本机语音包这条路 ──

  private speakBrowser(next: { text: string; priority: NarrationPriority }, myEpoch: number): void {
    if (!ttsSupported()) {
      this.noEngine += 1
      return
    }    this.speaking = true
    this.currentText = next.text
    const u = new SpeechSynthesisUtterance(next.text)
    if (this.voice) u.voice = this.voice
    u.lang = this.voice?.lang ?? 'zh-CN'
    u.rate = this.rate
    u.pitch = this.pitch
    // 词边界：口型的时间轴。旧世代（已被打断）的边界事件必须丢弃，
    // 否则打断之后头像还在按上一句的节奏动嘴。
    u.onboundary = (ev) => {
      if (myEpoch !== this.epoch) return
      const len = typeof ev.charLength === 'number' && ev.charLength > 0 ? ev.charLength : 2
      this.onWord?.(len)
    }
    u.onend = () => this.finish(myEpoch, 'local')
    u.onerror = () => this.finish(myEpoch, 'local')
    try {
      window.speechSynthesis.speak(u)
      /**
       * 通知放在 speak 之后：speak 会抛的环境（无音频设备）不该先亮起"正在说话"。
       *
       * `this.speaking` 这一层判断是必需的，不是多余的：某些环境里
       * `speak()` 会**同步**触发 `onerror` → `finish()` 里已经把 speaking 置回 false
       * （甚至已经念下了下一条）。此时再 announce(true)，就会留下一个**永远不会被清掉**
       * 的"正在说话"，表现为桌宠的嘴一直张着、且尾响窗再也不开。
       */
      if (myEpoch === this.epoch && this.speaking) this.announce(true)
    } catch {
      // 某些环境（无音频输出设备）speak 会抛，不能让播报把整页拖死
      this.speaking = false
      this.currentText = null
      this.noEngine += 1
      this.announce(false)
    }
  }

  private finish(myEpoch: number, engine: SpeechEngine): void {
    if (myEpoch !== this.epoch) return
    this.clearAudio()
    this.speaking = false
    this.currentText = null
    this.spoken += 1
    if (engine === 'neural') this.neuralSpoken += 1
    else this.browserSpoken += 1
    // 走云端成功 = 链路被证明能用，把上一次的降级原因清掉。
    // 走本机成功时**保留**原因：那是"为什么现在声音变差了"的唯一解释，
    // 清掉它用户就只剩一个"音色是不是坏了"的疑问。
    this.setEngine(engine, engine === 'neural' ? null : this.engineNote)
    this.announce(false)
    this.pump()
  }
}

export interface SpeechInputHandlers {
  /** 每次中间结果都回调，用于实时字幕。 */
  onInterim: (text: string) => void
  /**
   * 判定"这次中间结果算不算用户真在插话"。
   *
   * 返回 `true` 才被视为一次打断（此后到本句话说定稿为止不再重复触发）。
   * 之所以把判定权交回调用方，是因为**回声判别只能用调用方手里的信息做**：
   * 只有它知道合成器此刻正在念哪一句（`VoiceSpeaker.currentText`）。
   * 在这里硬编码一个"看到中间结果就打断"，助手念长句时会把自己念断。
   */
  onBargeIn: (text: string) => boolean
  onFinal: (text: string) => void
  onError?: (message: string, code: string) => void
}

export interface SpeechInput {
  supported: boolean
  listening: boolean
  start: () => void
  stop: () => void
  error: string | null
}

/**
 * 麦克风输入 + 打断检测。
 *
 * 打断为什么挂在**中间结果**上：等最终结果出来再打断，用户已经白说了半句。
 * 中间结果一来就说明"有人在说话"，此时立刻掐掉合成器并通知服务端作废在途答复，
 * 才是真的"随时打断"。
 *
 * 一次插话只发一次打断信号（`bargeFired`），否则连续的中间结果会打出
 * 十几次 `/voice/interrupt` —— 每打一次 generation 就 +1，
 * 会把用户在插话之后真正想问的那一轮也一起作废掉。
 */
export function useSpeechInput(handlers: SpeechInputHandlers, lang = 'zh-CN'): SpeechInput {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Asr | null>(null)
  const wantRef = useRef(false)
  const bargeFiredRef = useRef(false)
  const handlersRef = useRef(handlers)
  // 在 effect 里同步最新回调，而不是在渲染期赋 ref ——
  // 渲染期写 ref 在并发渲染下会被丢弃/重放，且 lint 明确禁止（react-hooks/refs）
  useEffect(() => {
    handlersRef.current = handlers
  })

  const supported = asrSupported()

  useEffect(() => {
    if (!supported) return () => undefined
    const Ctor = asrCtor()
    if (!Ctor) return () => undefined
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onstart = () => {
      setListening(true)
      setError(null)
    }
    rec.onresult = (e: AsrEvent) => {
      let interim = ''
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i]
        const alt = r[0]
        if (!alt) continue
        if (r.isFinal) finalText += alt.transcript
        else interim += alt.transcript
      }
      const interimTrim = interim.trim()
      if (interimTrim) handlersRef.current.onInterim(interimTrim)
      if (interimTrim.length >= 2 && !bargeFiredRef.current) {
        if (handlersRef.current.onBargeIn(interimTrim)) bargeFiredRef.current = true
      }
      const finalTrim = finalText.trim()
      if (finalTrim) {
        bargeFiredRef.current = false
        handlersRef.current.onFinal(finalTrim)
      }
    }
    rec.onerror = (e: AsrErrorEvent) => {
      // no-speech / aborted 是常态，不当作错误弹给用户
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        const msg = asrErrorText(e.error)
        setError(msg)
        handlersRef.current.onError?.(msg, e.error)
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') wantRef.current = false
    }
    rec.onend = () => {
      setListening(false)
      // Chrome 会在静默一段后自己收工；只要用户没喊停就续上
      if (wantRef.current) {
        try {
          rec.start()
        } catch {
          /* 已在运行，忽略 */
        }
      }
    }
    recRef.current = rec
    return () => {
      wantRef.current = false
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      rec.onstart = null
      try {
        rec.abort()
      } catch {
        /* 未启动 */
      }
      recRef.current = null
    }
  }, [supported, lang])

  const start = useCallback(() => {
    setError(null)
    wantRef.current = true
    bargeFiredRef.current = false
    const rec = recRef.current
    if (!rec) return
    try {
      rec.start()
    } catch {
      /* 已在运行 */
    }
  }, [])

  const stop = useCallback(() => {
    wantRef.current = false
    bargeFiredRef.current = false
    const rec = recRef.current
    if (!rec) return
    try {
      rec.stop()
    } catch {
      /* 未启动 */
    }
    setListening(false)
  }, [])

  return { supported, listening, start, stop, error }
}

// ───────────────────────────── 播报 SSE 通道 ─────────────────────────────

/**
 * 订阅服务端播报流。
 *
 * 用 SSE 而不是 WebSocket，原因在服务端（`/ws` 已被 2 秒状态广播占用，
 * 同端口挂两个带 path 的 WebSocketServer 会互抢 upgrade）。
 * 这里只消费，不做任何本地语义解释。
 */
export function useVoiceStream(
  base: string,
  enabled: boolean,
  onLines: (lines: NarrationLine[]) => void,
  onStatus?: (s: VoiceStatusView) => void,
): { connected: boolean; lastError: string | null } {
  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const linesRef = useRef(onLines)
  const statusRef = useRef(onStatus)
  // 同上：回调只在 effect 里同步，不在渲染期写 ref
  useEffect(() => {
    linesRef.current = onLines
    statusRef.current = onStatus
  })

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.EventSource !== 'function') return () => undefined
    const url = base.replace(/\/+$/, '') + '/voice/stream'
    const es = new window.EventSource(url)
    const onOpen = () => {
      setConnected(true)
      setLastError(null)
    }
    const onNarration = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as NarrationLine[]
        if (Array.isArray(parsed) && parsed.length > 0) linesRef.current(parsed)
      } catch {
        /* 跳过坏帧，不打断整条流 */
      }
    }
    const onStatusEv = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as VoiceStatusView
        statusRef.current?.(parsed)
      } catch {
        /* ignore */
      }
    }
    const onErr = () => {
      setConnected(false)
      setLastError('播报流断开，正在自动重连')
    }
    es.addEventListener('open', onOpen)
    es.addEventListener('narration', onNarration as EventListener)
    es.addEventListener('status', onStatusEv as EventListener)
    es.addEventListener('error', onErr)
    return () => {
      es.removeEventListener('open', onOpen)
      es.removeEventListener('narration', onNarration as EventListener)
      es.removeEventListener('status', onStatusEv as EventListener)
      es.removeEventListener('error', onErr)
      es.close()
      setConnected(false)
    }
  }, [base, enabled])

  return { connected, lastError }
}

/** 轮询状态快照（计数与待确认凭证）。SSE 只推播报，状态仍需一次拉取对齐。 */
export function useVoiceState(base: string, enabled: boolean, pollMs = 4000): VoiceStatusView | null {
  const [state, setState] = useState<VoiceStatusView | null>(null)
  useEffect(() => {
    if (!enabled) return () => undefined
    let alive = true
    const load = () => {
      getVoiceState(base)
        .then((s) => {
          if (alive) setState(s)
        })
        .catch(() => undefined)
    }
    load()
    const t = window.setInterval(load, pollMs)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [base, enabled, pollMs])
  return state
}

// ───────────────────────────── 时间格式 ─────────────────────────────

export function hhmmss(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
