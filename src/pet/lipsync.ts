/**
 * 桌宠 · 口型与待机动作（纯函数）
 *
 * ── 一个绕不过去的技术约束（决定了整个方案）────────────────────────────
 * 「让真人头像开口说话」的常见做法是：取 TTS 的音频波形 → 用能量驱动嘴部开合。
 * 这条路在本项目**走不通**：`speechSynthesis` 是黑盒，
 * 它不暴露 `MediaStream`，拿不到 `AnalyserNode` 要的波形数据。
 * （能拿到波形的只有自己解码音频再播放的那种 TTS，那是另一套语音后端。）
 *
 * 于是只剩两样可用的时间轴信号：
 *   ① `SpeechSynthesisUtterance.onboundary` —— 每个词/字边界触发一次，带 `charIndex`；
 *   ② `onstart` / `onend` —— 整体起止。
 *
 * ── 为什么这不只是"凑合" ──────────────────────────────────────────────
 * 词边界恰好是**嘴最该张开**的时刻，而且它比波形更稳：
 * 波形能量的包络会随音量设置、系统音量、句间停顿剧烈变化，
 * 同一句话在小音量下嘴几乎不动。词边界与音量无关，只看文本。
 *
 * ── 兜底（必须写）─────────────────────────────────────────────────────
 * `onboundary` 在 Chrome 上**不是所有引擎、所有语种都会触发**（中文尤其不稳）。
 * 没有兜底的话，一旦不触发，桌宠就会"张嘴说话但嘴一动不动"——
 * 比完全没有口型更吓人。所以这里给了一条**确定性**的兜底包络：
 * 由经过时间与播报 seed 推出，不用 `Math.random()`。
 * 确定性有两个好处：同一句重放动画一致；可以被烟测断言。
 */

export const DEFAULT_MOUTH_DECAY_MS = 160
/** 嘴完全闭合时的开口度。留一点缝比全闭自然，真人也不会完全闭死。 */
export const MOUTH_CLOSED_APERTURE = 0.08

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/**
 * 一个词多宽就张多开。
 *
 * 按字数而不是按音量：长词（"订单已拒绝"）口型大且持续，
 * 短词（"已"）只是轻轻动一下。这是读唇的可辨特征，也是"像在说话"和
 * "在抽搐"的区别。
 */
export function mouthPeakForWord(charCount: number): number {
  const n = Number.isFinite(charCount) ? Math.max(0, charCount) : 0
  return Math.min(1, Math.max(0.45, 0.45 + n * 0.09))
}

/**
 * 由"距上一个词边界过了多久"推开口度。
 *
 * `sinceBoundaryMs` 在词边界那一刻为 0（此刻最开），随后线性衰减到闭合。
 * 传入负值时按"刚触发"处理 —— 时钟回拨或事件乱序时不该把嘴锁死。
 */
export function mouthAperture(params: {
  sinceBoundaryMs: number
  charCount: number
  speaking: boolean
  decayMs?: number
}): number {
  if (!params.speaking) return 0
  const decay = params.decayMs ?? DEFAULT_MOUTH_DECAY_MS
  if (!(decay > 0)) return MOUTH_CLOSED_APERTURE
  const since = Number.isFinite(params.sinceBoundaryMs) ? Math.max(0, params.sinceBoundaryMs) : decay
  const peak = mouthPeakForWord(params.charCount)
  const ratio = clamp01(1 - since / decay)
  return MOUTH_CLOSED_APERTURE + (peak - MOUTH_CLOSED_APERTURE) * ratio
}

/**
 * 词边界不触发时的兜底包络。
 *
 * 刻意用两个不同频率的正弦叠加而不是 `Math.random()`：
 * 随机数在每次重渲染时都会变，帧间不连续，看起来像抖动不像说话；
 * 而正弦叠加天然连续，且**同一 (elapsedMs, seed) 必得同一值** —— 可断言。
 */
export function fallbackMouthAperture(elapsedMs: number, seed: number): number {
  const t = (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) / 90
  const s = Number.isFinite(seed) ? seed : 0
  const a = Math.sin(t + s) * 0.5 + 0.5
  const b = Math.sin(t * 2.7 + s * 1.7) * 0.5 + 0.5
  return clamp01(0.15 + 0.85 * (a * 0.6 + b * 0.4))
}

/** 待机呼吸：0（收）~ 1（张）的平滑周期函数，用于头像轻微缩放。 */
export function idleBreath(nowMs: number, periodMs = 3600): number {
  const p = periodMs > 0 ? periodMs : 3600
  const t = (Number.isFinite(nowMs) ? nowMs : 0) / p
  return Math.sin(t * Math.PI * 2) * 0.5 + 0.5
}

/**
 * 眨眼闭合度：0（睁）~ 1（闭）。
 *
 * 为什么要一个"闭眼"的纯函数：不眨眼的头像会进入恐怖谷。
 * 周期末段闭眼，其余时间睁开。确定性，可断言。
 */
export function blinkClosure(nowMs: number, intervalMs = 4200, blinkMs = 130): number {
  const interval = intervalMs > 0 ? intervalMs : 4200
  const dur = Math.min(blinkMs > 0 ? blinkMs : 130, interval)
  const phase = ((Number.isFinite(nowMs) ? nowMs : 0) % interval + interval) % interval
  const start = interval - dur
  if (phase < start) return 0
  const p = (phase - start) / dur
  // 0→1→0 的三角波，闭眼是一个来回而不是"啪一下"
  return p <= 0.5 ? p * 2 : (1 - p) * 2
}
