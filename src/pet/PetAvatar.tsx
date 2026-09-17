/**
 * 桌宠 · 头像
 *
 * ── 三种素材，两套渲染 ──────────────────────────────────────────────
 *   · 静态照片 → `<img>` + 嘴/眼睑叠加层（说话时嘴会动）
 *   · 动图 / 视频 → `<video>` 或 `<img>` 原样播放，**不叠任何器官层**
 *
 * 最后一条是刻意的，也是这里最容易做错的地方：
 * 素材里那张脸本来就在说话，再往上盖一张计算出来的嘴，
 * 得到的是两张嘴同时动的画面 —— 比不做更糟。
 * 所以叠加层由 `source.kind === 'image'` 单点决定，面板上也要如实说明
 * （见 `petMedia.kindNote`），否则用户会以为"动图模式口型坏了"。
 *
 * ── 为什么是"素材 + 叠加层"而不是生成式数字人 ─────────────────────────
 * 能让人脸真正开口说话的方案（SadTalker / LivePortrait / MuseTalk 一类）
 * 都要带 PyTorch 与 GPU，是一个独立的重型后端。
 * 而本项目有一条硬约束：**投真钱尚未解锁**，现在最不需要的就是
 * 为了桌宠引入一个新的、不参与任何风控的重型依赖。
 *
 * 轻量路线只保证三件事：
 *   ① 说话时嘴在动，且动的时间轴与词边界对齐（仅静态图）；
 *   ② 不说话时会眨眼、会呼吸，不进入恐怖谷；
 *   ③ 嘴与眼的位置**可微调** —— 任意照片的器官位置不可能靠猜。
 *
 * ── 尺寸必须有界 ────────────────────────────────────────────────────
 * 直径来自 `avatarSize.ts` 的档位，**不再**由容器剩余高度决定。
 * 理由见那个文件：头像撑满会把字幕区挤掉，而字幕才是这个窗口的主体。
 *
 * ── 一帧只写一次样式 ────────────────────────────────────────────────
 * rAF 循环把 aperture / lid / breath / bob 写成根元素上的 CSS 变量，
 * 由 CSS 自行推算各子元素的表现。这样每帧只有一次 `style.setProperty`。
 * React 状态全程不参与 —— 理由见 avatarMotion.ts。
 *
 * ── 关于肖像来源 ────────────────────────────────────────────────────
 * 头像由使用者从本机选择，只存在本机（照片在 localStorage，动图/视频在
 * IndexedDB），不上传任何地方。
 * **请用你自己的照片，或已获得授权的素材**；不要用他人的肖像
 * （尤其是公众人物）来生成会说话的形象。
 */

import React, { useEffect, useRef } from 'react'

import type { AvatarMotion } from './avatarMotion.ts'
import { computeAvatarFrame } from './avatarMotion.ts'
import type { PetAvatarSize } from './avatarSize.ts'
import type { PetAvatarSource } from './petMedia.ts'

export interface MouthAlign {
  /** 嘴部横向位置（% 照片宽度） */
  mouthX: number
  /** 嘴部纵向位置（% 照片高度） */
  mouthY: number
  /** 眼睑纵向位置（% 照片高度） */
  eyeY: number
}

export const DEFAULT_ALIGN: MouthAlign = { mouthX: 50, mouthY: 66, eyeY: 40 }

export type PetMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'alarm'

const MOOD_META: Record<PetMood, { label: string; color: string }> = {
  idle: { label: '待机', color: 'var(--text-sub)' },
  listening: { label: '在听', color: 'var(--primary)' },
  thinking: { label: '在想', color: 'var(--accent)' },
  speaking: { label: '在说', color: 'var(--primary)' },
  working: { label: '工作中', color: 'var(--down)' },
  alarm: { label: '报警', color: 'var(--up)' },
}

export interface PetAvatarProps {
  motion: AvatarMotion
  /** 头像素材。`null` 时显示"点击上传"的空态。 */
  source: PetAvatarSource | null
  size: PetAvatarSize
  mood: PetMood
  align?: MouthAlign
  /** 面板要显示"口型是真词边界还是兜底" —— 这是引擎不触发 onboundary 的唯一线索 */
  onFrameInfo?: (info: { usingFallback: boolean; boundaryCount: number }) => void
}

export default function PetAvatar({
  motion,
  source,
  size,
  mood,
  align = DEFAULT_ALIGN,
  onFrameInfo,
}: PetAvatarProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  // 视频元素要有独立 ref：叠加层关掉之后，"在说"的可视反馈只能靠它周围的辉光，
  // 而辉光挂在容器上，容器得有明确的尺寸来源
  const videoRef = useRef<HTMLVideoElement>(null)
  const infoRef = useRef(onFrameInfo)
  const lastInfo = useRef('')

  /**
   * 只有静态图才叠器官层。
   *
   * 动图/视频里那张脸本来就在动，盖上计算出来的嘴会变成两张嘴同时动 ——
   * 那不是"更拟真"，是穿帮。这一个布尔值就是这条规则的唯一落点。
   */
  const overlay = source?.kind === 'image'

  // 回调只在 effect 里同步，不在渲染期写 ref（项目既有约定，见 F-19）
  useEffect(() => {
    infoRef.current = onFrameInfo
  })

  // 视频在某些环境下不会自动开始（例如刚被 revoke 过的 blob URL），补一次显式播放。
  // 失败不抛：静音自动播放被策略挡住时，第一帧仍然会渲染出来，不影响使用。
  useEffect(() => {
    if (source?.kind !== 'video') return
    videoRef.current?.play().catch(() => undefined)
  }, [source?.kind, source?.url])

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = rootRef.current
      if (el) {
        const frame = computeAvatarFrame(motion, performance.now())
        el.style.setProperty('--ap', frame.aperture.toFixed(3))
        el.style.setProperty('--lid', frame.lid.toFixed(3))
        el.style.setProperty('--breath', frame.breath.toFixed(3))
        el.style.setProperty('--bob', `${frame.bob}px`)
        // 只在"是否兜底/词边界计数"真的变化时才回调，
        // 否则每秒 60 次 setState 会把整页拖垮
        const sig = `${frame.usingFallback}|${frame.boundaryCount}`
        if (sig !== lastInfo.current) {
          lastInfo.current = sig
          infoRef.current?.({ usingFallback: frame.usingFallback, boundaryCount: frame.boundaryCount })
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [motion])

  const m = MOOD_META[mood]

  return (
    <div className="pet-avatar-root" ref={rootRef} data-mood={mood} data-size={size}>
      <div className="pet-halo" aria-hidden />
      <div className="pet-breathe">
        <div className={`pet-photo-wrap ${overlay ? '' : 'pet-photo-media'}`}>
          {source === null ? (
            <div className="pet-photo pet-photo-empty">
              <span>点击上传头像</span>
              <small>照片 / 动图 / 视频 · 仅存本机</small>
            </div>
          ) : source.kind === 'video' ? (
            <video
              ref={videoRef}
              className="pet-photo"
              src={source.url}
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
            />
          ) : (
            <img className="pet-photo" src={source.url} alt="桌宠头像" draggable={false} />
          )}

          {/* 下面两层只在静态照片上出现 —— 见 `overlay` 的说明 */}
          {overlay && (
            <>
              <div className="pet-eyes" style={{ top: `${align.eyeY}%` }} aria-hidden>
                <i /><i />
              </div>
              <div
                className="pet-mouth"
                style={{ left: `${align.mouthX}%`, top: `${align.mouthY}%` }}
                aria-hidden
              />
            </>
          )}

          {/* speaking 时的边缘辉光，让"正在说话"在不看字幕时也可辨。
              动图/视频模式下这是唯一的"在说"反馈，所以两种模式都要有 */}
          <div className="pet-speaking-glow" aria-hidden />
        </div>
      </div>
      <div className="pet-mood" style={{ color: m.color, borderColor: m.color }}>
        <i style={{ background: m.color }} />
        {m.label}
      </div>
    </div>
  )
}
