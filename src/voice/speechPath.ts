/**
 * 语音路径决策与口型时间轴（**纯逻辑**）
 *
 * ── 为什么把它单独放一个文件 ──────────────────────────────────────────
 * 这两件事都住在"会出声"的那一刻上，而那一刻在真实环境里极难复现：
 * 要一台能联网的机器、一个能播放音频的浏览器、外加一次云端抖动。
 * 把它们写成不碰 React / 不碰 `window` 的纯函数，就能被烟测逐条喂样例断言 ——
 * 包括那些**必须走错就报红**的分支（云端失败后 P0 怎么走、两条路都没有时怎么办）。
 *
 * ── 一个产品级的取舍：报警允许赌一次，但只赌一次 ──────────────────────
 * 云端神经音色的延迟约 1.5 秒，比本机合成慢，但听感是"人"在说话。
 * 报警（P0）如果每次都先走云端，云端一旦抖动，用户就要多等一次超时才听到报警。
 *
 * 所以规则是：
 *   · 本会话还没试过 → 允许走云端（否则永远没有第一次，音色永远是机器音）；
 *   · 上一次**成功** → 允许（它已经被证明能用）；
 *   · 上一次**失败** → P0 一律退回本机；非 P0 等一个冷却期再试。
 *
 * 也就是说：**一次失败就把云端从报警这条路上永久请出去，直到一次成功把它请回来**。
 * 反过来写（失败后还拿报警去重试）看似更"自愈"，代价却是拿报警的延迟去赌。
 *
 * ── 另一条不许违反的规则 ──────────────────────────────────────────────
 * 两条路都不可用时，结果只能是 `silent`，而且**必须被计数**（`speaker.noEngine`）。
 * 静默丢一条播报是可以接受的物理现实（没音箱、没网络），
 * 静默地**不告诉用户**是不可以的 —— 那会变成"它今天怎么不说话了"。
 */

import type { NarrationPriority } from './clientTypes.ts'

/** 合成引擎：云端神经 / 本机系统语音包。 */
export type SpeechEngine = 'neural' | 'local'

/** 一句播报实际走的路。`silent` = 这句话没有出声（不是"被静音了"）。 */
export type SpeechPath = 'silent' | SpeechEngine

/**
 * 云端链路失败后的冷却期。
 *
 * 选 60 秒的理由：它要短于"用户发现问题并去看面板"的时间（否则面板上写着可用、
 * 实际已经坏了），又要长于一段播报连发的间隔（否则每句话都白等一次失败）。
 */
export const NEURAL_RETRY_MS = 60_000

/**
 * Edge 朗读接口返回的音频是 `audio-24khz-48kbitrate-mono-mp3`，
 * 即 48000 bit/s = 6000 byte/s = **6 字节/毫秒**。
 * 这是格式声明推出的换算，不是测出来的经验值；只在拿不到 `duration` 时当兜底。
 */
export const MP3_BYTES_PER_MS = 6

export interface PathInput {
  /** 当前选中的音色 id。`silent` 是目录里真实存在的一档。 */
  voiceId: string | null
  priority: NarrationPriority
  /** 上一次云端合成的结果；`null` = 本会话还没试过。 */
  lastOutcome: 'ok' | 'fail' | null
  /** 上一次尝试的时刻（`Date.now()` 口径，必须与 `now` 同源）。 */
  lastAttemptAt: number
  now: number
  /** 云端这条路**当前具备条件**：选了神经音色，且合成器已经接上。 */
  neuralWired: boolean
  /** 本机合成是否可用（`speechSynthesis` 存在）。 */
  browserUsable: boolean
}

/**
 * 云端这条路此刻允不允许走。
 *
 * 单独抽出来是因为它有**两个消费者**：路径决策（`speechPathPlan`）与
 * 界面上的"为什么这次没走云端"。两处各写一遍必然漂移，而漂移出来的那套没人测。
 */
export function neuralAllowed(i: Pick<PathInput, 'priority' | 'lastOutcome' | 'lastAttemptAt' | 'now'>): boolean {
  if (i.lastOutcome === null) return true
  if (i.lastOutcome === 'ok') return true
  // 上一次失败
  if (i.priority === 'P0_ALARM') return false
  return i.now - i.lastAttemptAt >= NEURAL_RETRY_MS
}

/**
 * 这一句该走哪条路。**全系统唯一的路径决策点。**
 *
 * 优先级刻意写死成"云端 → 本机 → 静默"：一旦反过来（先本机、云端可用时才升级），
 * 用户听到的第一句永远是机器音，而"换了音色没效果"的抱怨会原样回来。
 */
export function speechPathPlan(i: PathInput): SpeechPath {
  if (i.voiceId === 'silent') return 'silent'
  if (i.neuralWired && neuralAllowed(i)) return 'neural'
  if (i.browserUsable) return 'local'
  return 'silent'
}

export interface WordTick {
  /** 相对开始播放的毫秒偏移。 */
  atMs: number
  /** 这一口要张的字数（长词嘴张大，短词轻动一下 —— 与 `speechSynthesis.onboundary` 同语义）。 */
  chars: number
}

/** 每个口型步长覆盖的字数。中文按 2 字一步，接近一次自然开口。 */
const TICK_CHUNK = 2

/**
 * 神经音频的**口型时间轴**。
 *
 * `speechSynthesis` 那条路能拿到 `onboundary`（带 `charIndex`），
 * 云端音频这条路拿不到任何边界事件 —— 它只是一段 MP3。
 * 所以这里按"字数均摊到时长"造一条时间轴：不精确，但足以让嘴动起来，
 * 而且**音画是同步结束的**（最后一个 tick 落在 duration 上）。
 *
 * `durationMs` 无效（NaN/≤0）时返回空数组：调用方据此退到"整段张嘴"，
 * 而不是拿到一条时长为负的时间轴然后 setTimeout 出负延迟。
 */
export function neuralWordTicks(text: string, durationMs: number): WordTick[] {
  const chars = [...text].filter((c) => c.trim().length > 0)
  if (chars.length === 0) return []
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const groups: number[] = []
  for (let i = 0; i < chars.length; i += TICK_CHUNK) {
    groups.push(Math.min(TICK_CHUNK, chars.length - i))
  }
  return groups.map((chars, idx) => ({ atMs: Math.round((idx * durationMs) / groups.length), chars }))
}

/**
 * 从 MP3 字节数估算时长（拿不到 `audio.duration` 时的兜底）。
 *
 * 注意它是**估算**，面板不该拿它当权威 —— 真的 `duration` 一到就该覆盖掉它。
 */
export function mp3DurationEstimate(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round(bytes / MP3_BYTES_PER_MS)
}
