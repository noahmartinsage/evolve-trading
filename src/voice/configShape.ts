/**
 * 服务端配置的**运行时收口**（纯逻辑，无 React）
 *
 * ── 为什么必须有这一层，而且必须能被测 ────────────────────────────────
 * 类型是编译期的事，真正进来的是网络响应：旧进程、版本错配、中间缓存
 * 都能让它在字段上少一块。而这个项目**真的因此崩过一次** ——
 * `setVoiceConfig` 曾返回不带 `catalog` 的配置，前端的
 * `config?.catalog.find(...)` 里可选链只保护了 `config`、没保护 `catalog`，
 * 于是每次点「换音色」都抛 TypeError，整页进 ErrorBoundary
 * （界面提示"发生未捕获错误"），同时音色列表整块消失。
 *
 * 教训是：**渲染期不该存在任何"能被数据打崩"的表达式。**
 *
 * 而这条收口本身也必须可被观测：写成一个不碰 React 的纯函数，
 * 烟测就能喂它一份"缺字段的配置"并断言它不抛、且补齐了什么。
 * 写在 hook 里的话，这段逻辑在测试里根本够不着。
 */

import type { VoiceConfigView, VoiceEngineKind, VoiceProfileView } from './clientTypes.ts'

export interface EngineGroup {
  engine: VoiceEngineKind
  label: string
  note: string
  voices: VoiceProfileView[]
}

/** 两组的展示口径。**只有一份** —— 面板不许自己再拼一遍标题与说明。 */
export const ENGINE_GROUP_META: Record<VoiceEngineKind, { label: string; note: string }> = {
  neural: {
    label: '云端神经音色 · 拟人',
    note: '由云端大模型合成，语气与停顿接近真人。需要联网，首次出声约 1.5 秒。',
  },
  local: {
    label: '本机音色 · 兜底',
    note: '操作系统自带语音包，无需联网。Windows 上多为拼接式合成，听感明显生硬 —— 云端连不上时才会用它。',
  },
}

/**
 * 单条音色档案的收口。缺什么补什么，绝不抛。
 *
 * `engine` 缺省成 `local` 是刻意的取舍：旧服务端不返回它，
 * 此时把不明来路的一档当成"云端"会去发云端合成请求然后全失败；
 * 当成"本机"最坏也只是听感一般。**不确定时，默认值选后果更轻的那个。**
 */
export function normalizeProfile(p: VoiceProfileView): VoiceProfileView {
  return {
    ...p,
    engine: p.engine === 'neural' ? 'neural' : 'local',
    matchNames: Array.isArray(p.matchNames) ? p.matchNames : [],
    tags: Array.isArray(p.tags) ? p.tags : [],
  }
}

/**
 * 把一份配置收口成可安全渲染的版本。
 *
 * `catalog` 缺失时沿用上一份；上一份也没有就退空数组 ——
 * 列表空着，但页面活着。**"少显示一点"永远好过"页面没了"。**
 */
export function withCatalog(next: VoiceConfigView, prev: VoiceConfigView | null): VoiceConfigView {
  const raw = Array.isArray(next.catalog) ? next.catalog : (prev?.catalog ?? [])
  return { ...next, catalog: raw.map(normalizeProfile) }
}

/**
 * 按引擎分组。
 *
 * 顺序固定为 neural → local，**不按目录原序**：目录顺序由服务端决定，
 * 而分组顺序是展示口径。把两者绑在一起，会让服务端插一个音色就悄悄改了界面结构。
 */
export function groupByEngine(catalog: VoiceProfileView[]): EngineGroup[] {
  const kinds: VoiceEngineKind[] = ['neural', 'local']
  return kinds.map((engine) => ({
    engine,
    ...ENGINE_GROUP_META[engine],
    voices: catalog.filter((v) => v.engine === engine),
  }))
}
