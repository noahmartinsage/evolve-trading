/**
 * ⚠️ 已合并 —— 本文件不再是页面。
 *
 * 桌宠的**外壳能力**（透明窗 / 托盘找回 / 原生拖动 / 本机头像 / 口型摆放）
 * 现在分两处安放，都是有断言保护的：
 *   · 主进程与启动器 → `desktop/main.ts`、`desktop/launch.ts`
 *   · 页面侧外壳逻辑 → `src/pet/usePetShell.ts`
 *   · 两种形态的呈现     → `src/pages/VoiceHubPage.tsx`
 *
 * 保留这个文件只为**重定向**，避免旧引用拿到一份会慢慢腐烂的第二实现。
 * `scripts/pet-smoke.ts` 的 P12 组钉住：本文件只允许下面这一行 re-export。
 *
 * 注：本机安全策略拒绝删除仓库文件（safe-delete 走回收站失败后 fail-closed），
 * 所以用**重定向**而不是删除来表达"已合并"，不去绕过那条策略。
 */
export { default } from './VoiceHubPage.tsx'
