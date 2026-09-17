/**
 * 桌宠 · 头像媒体（静态图 / 动图 / 视频）
 *
 * ── 为什么动图与视频不能沿用照片那套 ────────────────────────────────
 * 静态照片在 `petPhoto.ts` 里被裁成 512×512 JPEG，稳定 60~120KB，
 * 塞进 localStorage 没问题。
 * 但动图与视频**不能裁** —— canvas 会把动画拍成一张静图，
 * 而它们又注定更大：一段 3 秒的 360×360 WebM 大约 1~3MB，
 * 转 data URL 还要再涨 33%。localStorage 同源下通常只有 5MB，
 * 存进去的结果是 `QuotaExceededError`，且部分实现**不回滚**已写入的部分，
 * 表现成"有时能换、有时刷新就没了"。
 *
 * 所以分工是：
 *   · 静态图 → localStorage（data URL，沿用原有键）
 *   · 动图 / 视频 → **IndexedDB 存 Blob**（配额按磁盘算，几百 MB 起）
 *
 * ── 哪一份才是真相 ──────────────────────────────────────────────────
 * 两种存储并存时最怕"谁说了算"没有定论。这里定死：
 * **IndexedDB 里有没有 `current` 记录，是"当前头像是不是动图/视频"的唯一真相。**
 * localStorage 的 kind 只是"IDB 还没打开时先渲染骨架"用的提示，
 * 它说了不算 —— 所以它坏掉也不会让界面显示一个不存在的头像。
 *
 * ── 这些纯函数为什么要单独存在 ──────────────────────────────────────
 * 类型判定（`detectMediaKind`）必须是纯的：它靠**文件头字节**而不是 MIME
 * 来决定"这是不是动画"，因为 MIME 由浏览器按扩展名给，改名就能骗过去
 * （把 .mp4 改成 .png 上传，MIME 说 image/png，实际是视频）。
 * 纯函数也才能在烟测里逐条断言，不用真起一个 IndexedDB。
 */

import { PET_PHOTO_SOFT_LIMIT, preparePetPhoto } from './petPhoto.ts'

export type PetAvatarKind = 'image' | 'animated' | 'video'

export interface PetAvatarSource {
  kind: PetAvatarKind
  /** `image` 是 data URL；`animated` / `video` 是 blob: URL，用完要 revoke。 */
  url: string
  /** 素材字节数。面板如实显示 —— 用户有权知道占了本机多少空间。 */
  bytes: number
}

/** localStorage 里的类型提示键。**它不是真相**，见文件头。 */
export const PET_AVATAR_KIND_KEY = 'evolve.pet.avatar.kind.v1'

/**
 * 各类素材的体积上限。
 *
 * 数字不是拍脑袋的：
 *   · 静态图沿用 `petPhoto.ts` 的 1.6MB（处理完就是 JPEG，稳定在几十 KB）
 *   · 动图 8MB —— 一张 480×480 的 GIF 循环通常 0.5~4MB，8MB 留足余量；
 *     再大就不该往一个桌宠头像上放了
 *   · 视频 24MB —— IndexedDB 吃得下，但读取要进内存，
 *     桌面外壳本身是个常驻窗口，头像太大等于白占一份常驻内存
 */
export const AVATAR_MEDIA_LIMIT: Record<PetAvatarKind, number> = {
  image: PET_PHOTO_SOFT_LIMIT,
  animated: 8_000_000,
  video: 24_000_000,
}

const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'])
const STATIC_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/avif',
])

/** 在字节里找一段 ASCII 标记。用于识别 WebP 的 ANIM chunk 与 PNG 的 acTL chunk。 */
function hasAscii(bytes: Uint8Array, token: string): boolean {
  if (bytes.length < token.length) return false
  const codes: number[] = []
  for (let i = 0; i < token.length; i += 1) codes.push(token.charCodeAt(i))
  outer: for (let i = 0; i + codes.length <= bytes.length; i += 1) {
    for (let j = 0; j < codes.length; j += 1) {
      if (bytes[i + j] !== codes[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * 判定一份素材该怎么渲染。返回 `null` 表示不支持的类型。
 *
 * ★ 只看 MIME 是不够的：MIME 来自扩展名，把 `clip.mp4` 改名成 `clip.png`
 * 就会拿到 `image/png`。所以 WebP / PNG 这两类**必须再看文件头** ——
 * 它们各自有静态与动画两种形态，且**静态的那一版应该走裁剪压缩**，
 * 直接按"是 webp 就存原文件"会让本该 80KB 的头像变成 2MB。
 *
 * @param mime 浏览器给的 MIME（不可信）
 * @param head 文件头若干字节（`slice(0, 4096)` 足够，chunk 标记都在前部）
 */
export function detectMediaKind(mime: string, head: Uint8Array): PetAvatarKind | null {
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  if (VIDEO_MIME.has(m)) return 'video'
  if (m === 'image/gif') return 'animated'
  if (m === 'image/apng') return 'animated'
  // PNG：动画版会带 acTL chunk（animation control）
  if (m === 'image/png') return hasAscii(head, 'acTL') ? 'animated' : 'image'
  // WebP：动画版带 ANIM chunk
  if (m === 'image/webp') return hasAscii(head, 'ANIM') ? 'animated' : 'image'
  if (STATIC_IMAGE_MIME.has(m)) return 'image'
  return null
}

/** 面板上如实说这类素材的特殊之处 —— 尤其"动图和视频不叠口型"这件事。 */
export function kindNote(kind: PetAvatarKind): string {
  if (kind === 'image') return '静态照片：嘴与眼睑由系统叠加，说话时会动'
  if (kind === 'animated') return '动图：素材自带动作，嘴与眼睑叠加已关闭'
  return '视频：素材自带动作，嘴与眼睑叠加已关闭'
}

// ───────────────────────── IndexedDB ─────────────────────────

const DB_NAME = 'evolve-pet'
const DB_VERSION = 1
const STORE = 'avatar'
const RECORD_KEY = 'current'

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('本机数据库打不开（可能是隐私模式）'))
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(new Error('本机数据库写入失败'))
        t.oncomplete = () => db.close()
      }),
  )
}

/**
 * IndexedDB 里的一条头像记录。
 *
 * ★ `kind` 存在**记录里**，而不是只放 localStorage 的提示键。
 * 否则"当前头像是动图还是视频"会有两个说法，而其中一个可能被清掉
 * （隐私模式、用户清缓存、上次版本写坏）。记录自带 kind，
 * IndexedDB 就是唯一真相 —— 提示键坏掉也不会显示成一个不存在的东西。
 */
export interface AvatarRecord {
  kind: PetAvatarKind
  blob: Blob
}

export async function saveAvatarBlob(kind: PetAvatarKind, blob: Blob): Promise<void> {
  if (!idbAvailable()) throw new Error('本机数据库不可用，动图与视频头像无法保存')
  const record: AvatarRecord = { kind, blob }
  await tx('readwrite', (s) => s.put(record, RECORD_KEY))
}

export async function loadAvatarRecord(): Promise<AvatarRecord | null> {
  if (!idbAvailable()) return null
  try {
    const v = await tx<AvatarRecord | undefined>('readonly', (s) => s.get(RECORD_KEY))
    if (!v || !(v.blob instanceof Blob)) return null
    // 只认这两类：`image` 归 localStorage 那条路径，混进来会让"谁是真的"重新变成两个答案
    if (v.kind !== 'animated' && v.kind !== 'video') return null
    return v
  } catch {
    return null
  }
}

export async function clearAvatarBlob(): Promise<void> {
  if (!idbAvailable()) return
  try {
    await tx('readwrite', (s) => s.delete(RECORD_KEY))
  } catch {
    /* 删不掉不该阻止用户继续用 */
  }
}

// ───────────────────────── 分流 ─────────────────────────

export interface PreparedAvatar {
  kind: PetAvatarKind
  /** `image` 走这里：已裁成 512×512 JPEG 的 data URL。 */
  dataUrl?: string
  /** `animated` / `video` 走这里：原样保存的 Blob（不能裁，裁了就成静图）。 */
  blob?: Blob
  /** 占用的本机空间，面板如实显示。 */
  bytes: number
}

/**
 * 把用户选的文件分流成"能直接被头像渲染"的东西。
 *
 * 三条分支的差异是**有理由的**，不是历史包袱：
 *   · 静态图 → 裁方 + 转 JPEG。省空间，且器官层需要一个已知的正方形。
 *   · 动图/视频 → **原样存**。canvas 会把动画拍成一张静图，
 *     所以宁可占地方也不能"处理"它。
 *
 * 超出体积上限时**抛错并说明差多少** —— 静默降级成第一帧，
 * 用户会以为是"播放坏了"，而不是"太大了"。
 */
export async function prepareAvatarMedia(file: File): Promise<PreparedAvatar> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const kind = detectMediaKind(file.type, head)
  if (!kind) {
    throw new Error('不支持这种文件。可选：jpg / png / webp / gif / mp4 / webm')
  }

  if (kind === 'image') {
    const dataUrl = await preparePetPhoto(file)
    return { kind, dataUrl, bytes: dataUrl.length }
  }

  const limit = AVATAR_MEDIA_LIMIT[kind]
  if (file.size > limit) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    const cap = (limit / 1024 / 1024).toFixed(0)
    throw new Error(`这个文件 ${mb}MB，超过 ${cap}MB 上限。桌宠头像是常驻的，太大等于白占一份内存`)
  }
  return { kind, blob: file, bytes: file.size }
}

/** 类型提示。仅供"IDB 还没打开时先渲染骨架"，**不是真相**。 */
export function setKindHint(kind: PetAvatarKind | null): void {
  try {
    if (kind === null) localStorage.removeItem(PET_AVATAR_KIND_KEY)
    else localStorage.setItem(PET_AVATAR_KIND_KEY, kind)
  } catch {
    /* 存不下无所谓：它本来只是提示 */
  }
}
