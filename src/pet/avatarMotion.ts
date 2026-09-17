/**
 * 桌宠 · 头像动作帧（纯函数）
 *
 * ── 为什么要有这一层，而不是在组件里直接算 ────────────────────────────
 * 头像动作是 60fps 的。如果把这套计算写在 React 组件里并用 state 承载，
 * 每帧都会触发一次整页重渲染 —— 桌宠页还挂着 SSE 播报流与状态轮询，
 * 结果是"头像一说话，字幕和按钮就开始抖"。
 *
 * 所以拆成两半：
 *   · 这一层是**纯函数**：给定 motion 与 now，算出这一帧该长什么样；
 *   · 组件层用 requestAnimationFrame 直接在 DOM 上写 transform，
 *     全程不碰 React 状态。
 *
 * 好处不只是性能：**纯函数可以被断言**。
 * "口型在词边界后 160ms 内必须张开"、"停止说话后必须立刻闭合"
 * 这类性质在上一版是没法测的（只能人眼看），现在可以进 CI。
 */

import {
  blinkClosure,
  fallbackMouthAperture,
  idleBreath,
  mouthAperture,
  MOUTH_CLOSED_APERTURE,
} from './lipsync.ts'

/**
 * 多久没收到词边界就认定"这个引擎不触发 onboundary"，改走兜底包络。
 *
 * 取值依据：中文最快也能到每秒 5~7 字，词边界间隔通常 < 200ms。
 * 600ms 还没来一次，基本就是没在触发，而不是语速慢。
 * 定得太小会在句间停顿处闪回兜底（嘴乱动），定得太大则整句都不动。
 */
export const BOUNDARY_STALE_MS = 600

/**
 * 可变动作状态。
 *
 * 刻意是个**普通可变对象**而不是 React state：它每秒被写几十次，
 * 每次写入都不需要触发任何界面更新 —— 界面更新由 rAF 循环按需做。
 */
export interface AvatarMotion {
  speaking: boolean
  listening: boolean
  thinking: boolean
  /** 最近一次词边界的时间戳（performance.now() 口径） */
  lastBoundaryAt: number
  /** 最近一个词的字数 —— 决定嘴张多大 */
  lastWordChars: number
  /** 本次合成开始时刻，用作兜底包络的相位种子 */
  speechStartedAt: number
  /** 本次合成一共收到多少次词边界。面板用它区分"真口型"与"兜底口型"。 */
  boundaryCount: number
}

export function createAvatarMotion(): AvatarMotion {
  return {
    speaking: false,
    listening: false,
    thinking: false,
    lastBoundaryAt: 0,
    lastWordChars: 2,
    speechStartedAt: 0,
    boundaryCount: 0,
  }
}

/** 记一次词边界。由 `VoiceSpeaker.onWord` 直接调用。 */
export function markWordBoundary(motion: AvatarMotion, charCount: number, nowMs: number): void {
  motion.lastBoundaryAt = nowMs
  motion.lastWordChars = Number.isFinite(charCount) && charCount > 0 ? charCount : 2
  motion.boundaryCount += 1
}

/** 记一次合成长度变化。由 `VoiceSpeaker.onSpeechChange` 直接调用。 */
export function setSpeaking(motion: AvatarMotion, speaking: boolean, nowMs: number): void {
  if (speaking === motion.speaking) return
  motion.speaking = speaking
  if (speaking) {
    motion.speechStartedAt = nowMs
    motion.lastBoundaryAt = 0
    motion.boundaryCount = 0
  }
}

export interface AvatarFrame {
  /** 嘴部开口度 0~1 */
  aperture: number
  /** 眼睑闭合 0~1 */
  lid: number
  /** 呼吸相位 0~1（用于极轻微缩放） */
  breath: number
  /** 说话时的头部起伏偏移（像素） */
  bob: number
  speaking: boolean
  /**
   * 这一帧的口型是不是兜底包络。
   *
   * 必须暴露出来：它是"引擎没触发 onboundary"的唯一可见证据。
   * 不暴露的话，用户只会看到"嘴在动但和声音对不上"，
   * 而没有任何线索指向真正的原因（语种不支持 / 引擎差异）。
   */
  usingFallback: boolean
  /** 本次合成收到过多少次词边界。0 且正在说话 ⇒ 这个引擎就是不触发。 */
  boundaryCount: number
}

const BOB_PX = 3

/**
 * 算这一帧。
 *
 * 调用方传 `nowMs` 而不是让它自己取时间，是为了**可重放**：
 * 烟测可以喂固定的时间序列，断言同一输入必得同一输出。
 */
export function computeAvatarFrame(motion: AvatarMotion, nowMs: number): AvatarFrame {
  const lid = blinkClosure(nowMs)
  const breath = idleBreath(nowMs)

  if (!motion.speaking) {
    return {
      // 不说话时嘴留一条缝（MOUTH_CLOSED_APERTURE），不是 0 —— 全闭的头像看起来像照片
      aperture: MOUTH_CLOSED_APERTURE,
      lid,
      breath,
      bob: 0,
      speaking: false,
      usingFallback: false,
      boundaryCount: motion.boundaryCount,
    }
  }

  const sinceBoundary = nowMs - motion.lastBoundaryAt
  // lastBoundaryAt 为 0 或已经超时 ⇒ 这个引擎不触发词边界，走兜底包络
  const stale = motion.lastBoundaryAt <= 0 || sinceBoundary > BOUNDARY_STALE_MS
  const elapsed = Math.max(0, nowMs - motion.speechStartedAt)
  const seed = (motion.speechStartedAt % 1000) / 137

  const aperture = stale
    ? fallbackMouthAperture(elapsed, seed)
    : mouthAperture({
        sinceBoundaryMs: sinceBoundary,
        charCount: motion.lastWordChars,
        speaking: true,
      })

  return {
    aperture,
    lid,
    breath,
    // 头部起伏跟着开口度走：嘴张开最大时头略微下沉，比独立振荡更像在说话
    bob: Math.round(aperture * BOB_PX),
    speaking: true,
    usingFallback: stale,
    boundaryCount: motion.boundaryCount,
  }
}
