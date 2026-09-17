/**
 * EVOLVE 桌宠 · 桌面外壳 Hook
 *
 * 只承载**外壳语义**：窗口拖动、鼠标穿透、位置重置、收托盘/退出、
 * 本机头像与口型摆放。业务能力一律走 `useVoiceSession` → HTTP → 编排服务。
 *
 * ── 为什么单独抽出来 ──────────────────────────────────────────────────
 * 合并之后的 `VoiceHubPage` 有两种形态，而**外壳只在其中一种存在**
 * （浏览器里 `petBridge()` 返回 `null`）。把外壳逻辑集中在这里，
 * 页面里就不会散落 `petBridge()?.xxx` 这种"有时有有时没有"的调用 ——
 * 那种散落正是"点了没反应"这类缺陷的温床。
 *
 * ── 头像：两份存储，只能有一份是真的 ──────────────────────────────────
 * 静态图存 localStorage（data URL），动图/视频存 IndexedDB（Blob）。
 * 两类存储并存时最危险的不是读写，而是**换头像时没有把另一份清掉**：
 * 用户上传了动图 → 再换成静态照片 → 刷新后又变回动图。
 * 这种"换了又回来"的现象，用户只会归结为"这个功能是坏的"。
 * 所以 `pickAvatar` 里两条分支各自负责**清掉对方的存储**，
 * 这件事不交给任何"顺手清理"的时机。
 *
 * ★ `desktop` 为 `false` 时**不是降级**，是受支持的第二种运行形态：
 *   桌面专属按钮隐藏而不是禁用。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { inDesktopPet, petBridge } from './petBridge.ts'
import type { PetHostState } from './petBridge.ts'
import { clearStoredPhoto, loadStoredPhoto, saveStoredPhoto } from './petPhoto.ts'
import {
  clearAvatarBlob,
  loadAvatarRecord,
  prepareAvatarMedia,
  saveAvatarBlob,
  type PetAvatarSource,
} from './petMedia.ts'
import { DEFAULT_AVATAR_SIZE, PET_AVATAR_SIZE_KEY, parseAvatarSize } from './avatarSize.ts'
import type { PetAvatarSize } from './avatarSize.ts'
import { DEFAULT_ALIGN } from './PetAvatar.tsx'
import type { MouthAlign } from './PetAvatar.tsx'

const ALIGN_KEY = 'evolve.pet.align.v1'

export interface PetShell {
  /** 是否运行在桌面外壳内（Electron 悬浮窗）。 */
  desktop: boolean
  hostState: PetHostState | null
  avatar: PetAvatarSource | null
  avatarNote: string | null
  avatarSize: PetAvatarSize
  align: MouthAlign
  /** 原生拖动 —— 起点只在按下时记一次，详见下方注释。 */
  dragHandlers: {
    onPointerDown: (e: ReactPointerEvent) => void
    onPointerMove: (e: ReactPointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
  }
  /** 选头像：照片 / 动图 / 视频，按类型自动分流。 */
  pickAvatar: (file: File | undefined) => Promise<void>
  clearAvatar: () => void
  setAvatarSize: (size: PetAvatarSize) => void
  saveAlign: (next: MouthAlign) => void
  setClickThrough: (on: boolean) => void
  resetPosition: () => void
  hide: () => void
  quit: () => void
}

/** localStorage 的读取一律包起来：隐私模式下 `getItem` 本身就会抛。 */
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

export function usePetShell(): PetShell {
  const desktop = inDesktopPet()

  const [hostState, setHostState] = useState<PetHostState | null>(null)
  const [avatar, setAvatar] = useState<PetAvatarSource | null>(null)
  const [avatarNote, setAvatarNote] = useState<string | null>(null)
  const [avatarSize, setSizeState] = useState<PetAvatarSize>(DEFAULT_AVATAR_SIZE)
  const [align, setAlign] = useState<MouthAlign>(DEFAULT_ALIGN)

  /**
   * 当前 blob: URL。换头像与卸载都要 revoke ——
   * 一个 20MB 的视频不 revoke，会一直占着内存直到页面关掉，
   * 而悬浮窗是常驻的、几乎不会被关。
   */
  const blobUrlRef = useRef<string | null>(null)
  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }, [])

  // ── 头像加载 ──
  // 顺序是**刻意的**：先问 IndexedDB，再回落 localStorage 的照片。
  // 反过来的话，用户上次传的动图会被一张更早的静态照片盖掉。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rec = await loadAvatarRecord()
      if (cancelled) return
      if (rec) {
        const url = URL.createObjectURL(rec.blob)
        blobUrlRef.current = url
        setAvatar({ kind: rec.kind, url, bytes: rec.blob.size })
        return
      }
      const dataUrl = loadStoredPhoto()
      if (dataUrl) setAvatar({ kind: 'image', url: dataUrl, bytes: dataUrl.length })
    })()
    return () => {
      cancelled = true
      revokeBlobUrl()
    }
  }, [revokeBlobUrl])

  // ── 尺寸档位（坏值回落默认，见 avatarSize.ts）──
  useEffect(() => {
    setSizeState(parseAvatarSize(readPref(PET_AVATAR_SIZE_KEY)))
  }, [])

  const setAvatarSize = useCallback((size: PetAvatarSize) => {
    setSizeState(size)
    writePref(PET_AVATAR_SIZE_KEY, size)
  }, [])

  // ── 口型对齐微调同样只存本机：任意照片的器官位置不可能靠猜 ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ALIGN_KEY)
      if (!raw) return
      const p = JSON.parse(raw) as Partial<MouthAlign>
      if (typeof p.mouthX === 'number' && typeof p.mouthY === 'number' && typeof p.eyeY === 'number') {
        setAlign({ mouthX: p.mouthX, mouthY: p.mouthY, eyeY: p.eyeY })
      }
    } catch {
      /* 坏掉的偏好不该阻止桌宠起来 */
    }
  }, [])

  const saveAlign = useCallback((next: MouthAlign) => {
    setAlign(next)
    writePref(ALIGN_KEY, JSON.stringify(next))
  }, [])

  // ── 外壳状态订阅 ──
  useEffect(() => {
    const b = petBridge()
    if (!b) return
    b.getState()
    return b.onState(setHostState)
  }, [])

  // ── 原生拖动 ──
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const dragRafRef = useRef(0)
  const dragDeltaRef = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const b = petBridge()
    // 浏览器里不拦截：那会挡住头像上其它交互（双击换头像）
    if (!b || e.button !== 0) return
    dragRef.current = { x: e.screenX, y: e.screenY }
    // ★ 起点交给主进程记一次，之后每次从**固定起点**算位移。
    //   若改成"当前位置 + 本次位移"，IPC 延迟会让误差逐步累积，窗口越拖越偏。
    b.dragBegin()
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const b = petBridge()
    const start = dragRef.current
    if (!b || !start) return
    dragDeltaRef.current = { dx: e.screenX - start.x, dy: e.screenY - start.y }
    // 合并到帧：指针事件在部分设备上高于 60Hz，逐条发等于白烧 IPC
    if (dragRafRef.current) return
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0
      const d = dragDeltaRef.current
      if (d) b.dragBy(d)
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragRef.current = null
    dragDeltaRef.current = null
  }, [])

  // 组件卸载时取消挂起的帧，避免往一个已经没有窗口的桥上发消息
  useEffect(
    () => () => {
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current)
    },
    [],
  )

  // ── 头像 ──
  const pickAvatar = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      try {
        const prepared = await prepareAvatarMedia(file)

        if (prepared.kind === 'image') {
          const dataUrl = prepared.dataUrl ?? ''
          const saved = saveStoredPhoto(dataUrl)
          if (!saved.ok) {
            // 失败要给出**具体原因**（配额/格式/尺寸），"保存失败"这种话没法修
            setAvatarNote(saved.reason)
            return
          }
          // 互斥：换成静态图就必须把 IDB 那条删掉，否则刷新后动图又回来了
          await clearAvatarBlob()
          revokeBlobUrl()
          setAvatar({ kind: 'image', url: dataUrl, bytes: saved.bytes })
          setAvatarNote(`已保存（${Math.round(saved.bytes / 1024)}KB，只存本机）`)
        } else {
          const blob = prepared.blob
          if (!blob) throw new Error('文件读取失败')
          await saveAvatarBlob(prepared.kind, blob)
          // 互斥的另一半：动图/视频生效时清掉静态照片那份
          clearStoredPhoto()
          revokeBlobUrl()
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setAvatar({ kind: prepared.kind, url, bytes: blob.size })
          const mb = (blob.size / 1024 / 1024).toFixed(1)
          setAvatarNote(
            `已保存${prepared.kind === 'video' ? '视频' : '动图'}（${mb}MB，只存本机）· 素材自带动作，口型叠加已关闭`,
          )
        }
      } catch (e) {
        setAvatarNote(e instanceof Error ? e.message : '头像处理失败')
      }
      window.setTimeout(() => setAvatarNote(null), 4200)
    },
    [revokeBlobUrl],
  )

  const clearAvatar = useCallback(() => {
    clearStoredPhoto()
    void clearAvatarBlob()
    revokeBlobUrl()
    setAvatar(null)
    setAvatarNote('已删除本机头像')
    window.setTimeout(() => setAvatarNote(null), 3000)
  }, [revokeBlobUrl])

  // ── 外壳动作（浏览器里全是安全的空操作）──
  const setClickThrough = useCallback((on: boolean) => {
    const b = petBridge()
    b?.setClickThrough(on)
    b?.getState()
  }, [])

  const resetPosition = useCallback(() => {
    const b = petBridge()
    b?.resetPosition()
    b?.getState()
  }, [])

  const hide = useCallback(() => petBridge()?.hide(), [])
  const quit = useCallback(() => petBridge()?.quit(), [])

  return {
    desktop, hostState, avatar, avatarNote, avatarSize, align,
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
    pickAvatar, clearAvatar, setAvatarSize, saveAlign,
    setClickThrough, resetPosition, hide, quit,
  } satisfies PetShell
}
