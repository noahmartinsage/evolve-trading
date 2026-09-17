/**
 * 桌宠 · 头像尺寸档位
 *
 * ── 为什么要给它一个上限，而不是让头像撑满 ──────────────────────────
 * 原来的实现是 `flex: 1 1 auto` 加上内联的 `height: 100%` ——
 * 头像直径等于**容器剩余高度**。在控制台形态里那意味着 400px 以上，
 * 在 360×540 的悬浮窗里也接近 280px。
 *
 * 结果不是"头像很大"这么简单，而是**把真正要读的东西挤掉了**：
 * 悬浮窗的字幕区被压到只剩两三行，而字幕才是这个窗口的主体
 * （用户要的是"它说了什么"，不是"它长什么样"）。
 * 头像占位过大还会让"想找回它"的人误以为窗口没内容。
 *
 * 所以尺寸必须是**有界的档位**，且默认偏小：
 * 头像够认出是谁就行，剩下的高度留给字幕和待确认。
 *
 * ── 为什么解析要单独成一个纯函数 ─────────────────────────────────────
 * 这个值来自 localStorage，是本机可被手改、可被上次版本写坏的地方。
 * 坏值的表现是"头像消失"或"头像撑满" —— 都属于不报错但用户可见的缺陷。
 * 纯函数才能在烟测里逐条喂坏值断言。
 */

export type PetAvatarSize = 'sm' | 'md' | 'lg' | 'xl'

export const DEFAULT_AVATAR_SIZE: PetAvatarSize = 'md'

export const PET_AVATAR_SIZE_KEY = 'evolve.pet.avatarSize.v1'

/**
 * 直径（CSS px）。
 *
 * 上界 280 与 `PET_PHOTO_SIZE = 640` 是配套的：640 在 2× DPR 下
 * 可撑到 320 CSS px 仍清晰，280 留了余量。
 * 改这里要回头看那个 640 —— 它决定了"头像被放大到什么程度才会糊"。
 *
 * ── 为什么在"尺寸必须有界"之后还要加一个特大档 ──────────────────────
 * 档位存在的理由是**别让头像把字幕挤掉**，所以默认档偏小、默认值也不动。
 * 但"就想让那张脸铺满窗口"是个正当诉求 —— 早期版本头像直径等于容器剩余高度
 * （360×540 的悬浮窗里接近 280px），那个观感是有人喜欢的。
 * 这一档就是把它请回来，只是**不再作为默认**：想大的人自己选，
 * 代价写在 `note` 里并显示在面板上，不由系统替他决定。
 *
 * `note` 只用于界面提示，不参与任何计算 —— 改它不改变行为。
 */
export const PET_AVATAR_SIZES: Record<PetAvatarSize, { px: number; label: string; note: string }> = {
  sm: { px: 112, label: '小', note: '字幕区最宽裕' },
  md: { px: 152, label: '中', note: '默认档，够认出是谁' },
  lg: { px: 208, label: '大', note: '头像为主，字幕仍够用' },
  xl: { px: 280, label: '特大', note: '铺满观感；悬浮窗里字幕会变少' },
}

const ALL: PetAvatarSize[] = ['sm', 'md', 'lg', 'xl']

/**
 * 解析存下来的档位。**任何非法输入都回落到默认档，绝不抛**。
 *
 * 不能返回 `null` 让调用方自己兜底：那样每个消费点都要写一遍 `?? 默认`，
 * 而漏写的那一处就是"头像撑满整窗"这个缺陷的重现入口。
 */
export function parseAvatarSize(raw: string | null | undefined): PetAvatarSize {
  if (typeof raw === 'string' && (ALL as string[]).includes(raw)) return raw as PetAvatarSize
  return DEFAULT_AVATAR_SIZE
}

export function isAvatarSize(v: unknown): v is PetAvatarSize {
  return typeof v === 'string' && (ALL as string[]).includes(v)
}
