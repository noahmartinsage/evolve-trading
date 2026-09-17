/**
 * 桌宠 · 头像照片
 *
 * ── 为什么必须过一道缩放，而不是直接把 file 读成 data URL ──────────────
 * 手机/相机直出的照片动辄 4~8MB，`FileReader.readAsDataURL` 之后 base64 还要
 * 再涨 33%。而 localStorage 的配额一般只有 **5MB**（按 UTF-16 计还更少）。
 * 直接存的结果是：`setItem` 抛 `QuotaExceededError`，而它在很多实现里
 * **不会**让已经写进去的部分回滚 —— 表现是"有时能换照片、有时换完刷新就没了"，
 * 是最难查的一类。
 *
 * 所以这里固定走：**等比裁成正方形 → 画到 512×512 画布 → 导出 JPEG**。
 * 512 是刻意的：桌宠头像在窗口里直径最多 ~320 CSS px，
 * 512 在 2× DPR 下仍然清晰，而体积稳定在 60~120KB。
 *
 * ── 裁剪几何为什么单独抽出来 ──────────────────────────────────────────
 * "按短边对齐居中裁剪"这句话有三种常见写法，其中两种是错的
 * （拉伸、或按长边裁导致越界）。而它的错误表现是**照片被拉变形**，
 * 这种东西只能靠断定点出来，人眼在桌宠尺寸下看不出来。
 */

/**
 * 导出尺寸。改它必须同步改 `PET_PHOTO_SOFT_LIMIT` 的估算。
 *
 * 640 与 `PET_AVATAR_SIZES.xl = 280` 是配套的：2× DPR 下需要 560 物理像素，
 * 640 留了余量。原先 512 配的是最大档 208px —— 加"特大"档时必须一起提上来，
 * 否则那一档会把照片放大到发糊，而"看得更清楚"正是它唯一的卖点。
 */
export const PET_PHOTO_SIZE = 640

/** JPEG 质量。0.86 是"看不出来压缩痕迹"的下限附近，再低脸上会出现块状。 */
export const PET_PHOTO_QUALITY = 0.86

export const PET_PHOTO_STORAGE_KEY = 'evolve.pet.photo.v1'

/**
 * data URL 的软上限。
 *
 * 取 2.4MB：640×640 JPEG(0.86) 一般 100~200KB，即使碰上极高频细节的图
 * （噪点、毛发）也很少超过 650KB。2.4MB 给足余量，同时仍低于 localStorage
 * 常见的 5MB 配额 —— 因为同一个 origin 下还放着别的前端偏好项。
 */
export const PET_PHOTO_SOFT_LIMIT = 2_400_000

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * 居中正方裁剪的源矩形（cover 语义：填满目标，多余部分裁掉）。
 *
 * 短边决定边长 —— 这样裁剪框永远落在图内。若按长边算，
 * 短边方向会超出原图，画出来就是黑边或拉伸。
 */
export function coverCropRect(srcW: number, srcH: number): CropRect {
  const w = Number.isFinite(srcW) && srcW > 0 ? srcW : 1
  const h = Number.isFinite(srcH) && srcH > 0 ? srcH : 1
  const side = Math.min(w, h)
  return {
    sx: Math.round((w - side) / 2),
    sy: Math.round((h - side) / 2),
    sw: Math.round(side),
    sh: Math.round(side),
  }
}

/**
 * 把任意图片文件处理成可存进 localStorage 的头像 data URL。
 *
 * 任何一步失败都抛 —— 由调用方决定怎么提示。**不做静默降级**：
 * "点了换照片但没反应"比"明确告诉你这张图不行"糟糕得多。
 */
export async function preparePetPhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件（jpg / png / webp）')
  }
  const bitmap = await loadImage(await readAsDataURL(file))
  const rect = coverCropRect(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = PET_PHOTO_SIZE
  canvas.height = PET_PHOTO_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持 Canvas，无法处理照片')
  // 透明 PNG 导出成 JPEG 会变黑底，先铺一层接近肤色的底，退化也不难看
  ctx.fillStyle = '#1a1d29'
  ctx.fillRect(0, 0, PET_PHOTO_SIZE, PET_PHOTO_SIZE)
  ctx.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, PET_PHOTO_SIZE, PET_PHOTO_SIZE)
  const out = canvas.toDataURL('image/jpeg', PET_PHOTO_QUALITY)
  if (out.length > PET_PHOTO_SOFT_LIMIT) {
    throw new Error(`照片处理后仍有 ${Math.round(out.length / 1024)}KB，超出本机存储上限，请换一张小一点的`)
  }
  return out
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这张图片无法解码（可能已损坏）'))
    img.src = src
  })
}

/** 读已存头像。读不到或超限一律返回 null，绝不抛。 */
export function loadStoredPhoto(): string | null {
  try {
    const v = localStorage.getItem(PET_PHOTO_STORAGE_KEY)
    if (!v || !v.startsWith('data:image/')) return null
    return v
  } catch {
    return null
  }
}

export type SavePhotoResult = { ok: true; bytes: number } | { ok: false; reason: string }

/**
 * 写头像。**必须把失败原因带回来** —— 配额是这台机器的真实约束，
 * 页面上要如实说明"是存不下"而不是让用户以为按钮坏了。
 */
export function saveStoredPhoto(dataUrl: string): SavePhotoResult {
  try {
    localStorage.setItem(PET_PHOTO_STORAGE_KEY, dataUrl)
    return { ok: true, bytes: dataUrl.length }
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)
    return { ok: false, reason: quota ? '本机存储配额不足，照片没保存成功' : '存储不可用（可能是隐私模式）' }
  }
}

export function clearStoredPhoto(): void {
  try {
    localStorage.removeItem(PET_PHOTO_STORAGE_KEY)
  } catch {
    /* 存储不可用时无事可做 */
  }
}
