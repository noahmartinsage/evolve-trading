/**
 * 音色目录（**全系统唯一一份**）
 *
 * ── 这份目录里为什么同时住着两种引擎 ────────────────────────────────
 * 出声只有两条路：
 *   · `neural` —— 云端神经合成（本机不需要任何语音包，听感接近真人）；
 *   · `local`  —— 浏览器/操作系统自带的语音包（Windows 上多是 SAPI5 时代的
 *                 拼接式合成，字与字硬接，听感就是"机器在念字"）。
 *
 * 它们被放进**同一份目录**、由同一个 `voiceId` 寻址，理由是本项目吃过一次
 * 现成的亏：同一个业务动作有两条实现路径就一定会漂移，而漂移出来的那条没人测。
 * 音色也一样 —— 两份目录意味着两套 id、两套默认值、两套校验，
 * 而"用户选了 A 引擎的 id 却被 B 引擎执行"这种缺陷不会报错，只会让声音不对。
 *
 * 所以：**一个声道（`voiceId`），一份目录，一个 `engine` 字段标出它走哪条路。**
 *
 * ── 一个必须说清楚的现实约束（只对本机音色成立）─────────────────────
 * 本机合成发生在**浏览器**（`speechSynthesis`），可用音色取决于操作系统装了
 * 哪些语音包。所以本机条目的 `matchNames` 只是**匹配候选**，不是保证。
 * 真正可用的音色要在运行时用 `getVoices()` 交叉一次，面板上如实显示
 * 「系统装了 N 个中文音色」，而不是假装目录里 7 个都在。
 * 这条与项目里反复出现的判据一致：**不要写下一个无法被观测所反驳的声明。**
 *
 * ── pitch / rate 的定位 ─────────────────────────────────────────────
 * `pitch` 只对**本机**音色有意义。神经引擎实测 `prosody pitch` **完全不生效**
 * （改了与默认逐字节相同，见 `tts.ts` 文件头的实测表），所以神经条目的
 * `pitch` 恒为 1 —— 面板据此禁用音高滑杆。留一个"看起来能调、实际不动"的滑块，
 * 正是用户说的"僵硬"的来源之一。
 */

import { NEURAL_VOICES } from './tts.ts'

export type VoiceEngine = 'neural' | 'local'

export interface VoiceProfile {
  id: string
  /** 面板与回话里用的中文名。 */
  label: string
  gender: 'female' | 'male' | 'neutral'
  locale: string
  /** 1 为标准音高；越小越沉。**神经条目恒为 1**（该引擎上此参数不生效）。 */
  pitch: number
  /** 1 为标准语速。播报报警时会被临时压到更慢（见 synthesize 调用方）。 */
  rate: number
  /** 特征标签，用于面板筛选与说明。 */
  tags: string[]
  /**
   * 浏览器音色名匹配候选，按优先级排列。**神经条目恒为空数组**。
   * 匹配用**子串**（浏览器给的名字常带 "Microsoft XXX Online (Natural) - Chinese (Mainland)" 这类长后缀）。
   */
  matchNames: string[]
  /** 面板展示的一句话说明。 */
  note: string
  /** 这一档由哪条引擎出声。合成器与面板**都读它**，不允许各自再推导。 */
  engine: VoiceEngine
  /** 神经条目专属：Edge 音色标识。本机条目为 undefined。 */
  neuralId?: string
}

/**
 * 神经音色条目 —— **从 `NEURAL_VOICES` 派生，不另抄一份列表**。
 *
 * 抄一份的后果很具体：`tts.ts` 里改了个音色 id 或语速，这里不改，
 * 于是"选中的音色"与"实际合成的音色"悄悄分岔 —— 而两边都是合法值，
 * 类型系统一句都不会说。
 */
const NEURAL_PROFILES: VoiceProfile[] = NEURAL_VOICES.map((v) => ({
  id: v.id,
  label: v.label,
  gender: v.gender,
  locale: 'zh-CN',
  pitch: 1,
  rate: v.rate,
  tags: ['拟人', ...v.tags],
  matchNames: [],
  note: v.note,
  engine: 'neural',
  neuralId: v.id,
}))

/**
 * 本机音色条目 —— 云端不可用时的兜底。
 *
 * 它们的 `note` 现在必须**照实说自己生硬**。以前这几条是主角，
 * 文案写的是"甜美""温柔"；现在它们是退路，继续那么写就成了虚假宣传 ——
 * 用户会以为自己听错了，而不是知道"云端此刻不可用"。
 */
const LOCAL_PROFILES: VoiceProfile[] = [
  {
    id: 'sweet-female-zh',
    label: '本机女声 A',
    gender: 'female',
    locale: 'zh-CN',
    pitch: 1.35,
    rate: 1.02,
    tags: ['兜底', '本机'],
    matchNames: ['Xiaoxiao', '晓晓', 'Huihui', '慧慧', 'Yaoyao', '瑶瑶', 'Xiaoyi', '晓伊'],
    note: '系统语音包。语速略快、音高偏高。听感是拼接式合成，明显不如云端自然 —— 只在云端不可用时用。',
    engine: 'local',
  },
  {
    id: 'warm-female-zh',
    label: '本机女声 B',
    gender: 'female',
    locale: 'zh-CN',
    pitch: 1.12,
    rate: 0.95,
    tags: ['兜底', '本机'],
    matchNames: ['Xiaoyi', '晓伊', 'Huihui', '慧慧', 'Yaoyao', '瑶瑶'],
    note: '系统语音包，音高更接近说话音。同一副嗓子的另一种变形，不是换了个人。',
    engine: 'local',
  },
  {
    id: 'crisp-female-zh',
    label: '本机女声 C',
    gender: 'female',
    locale: 'zh-CN',
    pitch: 1.0,
    rate: 1.12,
    tags: ['兜底', '本机'],
    matchNames: ['Huihui', '慧慧', 'Xiaoxiao', '晓晓'],
    note: '系统语音包，语速最快、音高平直。信息密度高但更机械。',
    engine: 'local',
  },
  {
    id: 'calm-male-zh',
    label: '本机男声 A',
    gender: 'male',
    locale: 'zh-CN',
    pitch: 0.72,
    rate: 0.96,
    tags: ['兜底', '本机'],
    matchNames: ['Yunxi', '云希', 'Kangkang', '康康', 'Yunyang', '云扬'],
    note: '系统语音包，低频、慢速。把报警念出来时压迫感最强。',
    engine: 'local',
  },
  {
    id: 'steady-male-zh',
    label: '本机男声 B',
    gender: 'male',
    locale: 'zh-CN',
    pitch: 0.88,
    rate: 1.05,
    tags: ['兜底', '本机'],
    matchNames: ['Kangkang', '康康', 'Yunxi', '云希'],
    note: '系统语音包，接近广播播报腔。',
    engine: 'local',
  },
  {
    id: 'sweet-female-en',
    label: '本机英文女声',
    gender: 'female',
    locale: 'en-US',
    pitch: 1.2,
    rate: 1.0,
    tags: ['兜底', '英文'],
    matchNames: ['Zira', 'Aria', 'Jenny', 'Samantha'],
    note: '系统语音包。中文文本会被逐字念出，仅建议用于英文环境。',
    engine: 'local',
  },
  {
    id: 'silent',
    label: '静默 · 只出字幕不发声',
    gender: 'neutral',
    locale: 'zh-CN',
    pitch: 1,
    rate: 1,
    tags: ['无声'],
    matchNames: [],
    note: '完全不出声，只把播报写进面板。适合会议中盯盘，或两条引擎都不可用时。',
    engine: 'local',
  },
]

/**
 * 默认音色。**神经音色，不是本机音色。**
 *
 * 这个默认值是这次"音色太生硬"的直接处方：本机那条路在 Windows 上注定是
 * 拼接式合成，把它当默认，等于用户第一次听到的永远是机器音，
 * 然后他要去猜"是不是还有更好的、在哪儿选"。云端不可用时前端会自动降级，
 * 降级是**显式可见**的（面板会写出原因），所以把默认给云端不会让人"静默变差"。
 */
export const DEFAULT_VOICE_ID = 'zh-CN-XiaoxiaoNeural'

/** 全量目录。神经在前（默认路径），本机在后（兜底）。顺序即面板分组顺序。 */
export const VOICE_CATALOG: VoiceProfile[] = [...NEURAL_PROFILES, ...LOCAL_PROFILES]

export function getVoice(id: string): VoiceProfile | undefined {
  return VOICE_CATALOG.find((v) => v.id === id)
}

export function defaultVoice(): VoiceProfile {
  return getVoice(DEFAULT_VOICE_ID) ?? VOICE_CATALOG[0]
}

/** 按引擎取子集。面板分组直接用它，避免在渲染里再 filter 出一套口径。 */
export function voicesByEngine(engine: VoiceEngine): VoiceProfile[] {
  return VOICE_CATALOG.filter((v) => v.engine === engine)
}

/**
 * 用嘴换音色失败时念出来的候选清单。
 *
 * ★ 刻意只念**云端那 7 个**：念完 14 个要十几秒，而其中一半是
 * "本机兜底"——那不是用户想主动选的东西，是系统在云端坏掉时自动退的地方。
 */
export function spokenVoiceList(): string {
  const names = voicesByEngine('neural').map((v) => v.label.split(' · ')[0])
  return `${names.join('、')}，另外还有静默（只出字幕）。`
}

/** 音色别名：让用户能用嘴换音色（「换个男声」「换成温柔一点的」）。 */
const VOICE_ALIASES: { pattern: RegExp; voiceId: string }[] = [
  { pattern: /(男声|男人的声音|男的|大叔|低沉)/, voiceId: 'zh-CN-YunjianNeural' },
  { pattern: /(标准男|播报男|新闻腔|播音)/, voiceId: 'zh-CN-YunyangNeural' },
  { pattern: /(阳光|年轻男|青年男)/, voiceId: 'zh-CN-YunxiNeural' },
  { pattern: /(温柔|知性|慢一点说|暖暖)/, voiceId: 'zh-CN-XiaoxiaoNeural' },
  { pattern: /(干练|快一点说|干脆|轻快)/, voiceId: 'zh-CN-XiaoyiNeural' },
  { pattern: /(甜甜|甜美|可爱|默认女声|萌)/, voiceId: 'zh-CN-XiaoxiaoNeural' },
  { pattern: /(东北话|东北腔|辽宁)/, voiceId: 'zh-CN-liaoning-XiaobeiNeural' },
  { pattern: /(陕西话|陕西腔)/, voiceId: 'zh-CN-shaanxi-XiaoniNeural' },
  // 降级指令必须存在：云端坏掉时用户得有一句话能主动切回去，
  // 而不是等面板上的说明告诉他去点哪个按钮
  { pattern: /(本机音色|离线音色|本地音色|兜底音色|别联网)/, voiceId: 'sweet-female-zh' },
  { pattern: /(英文|english|英语)/i, voiceId: 'sweet-female-en' },
  { pattern: /(静默|安静模式|别出声|只打字|字幕)/, voiceId: 'silent' },
]

/**
 * 从一句话里解析音色诉求。
 *
 * 先按别名命中，再按音色 id 直接命中 —— 顺序不能反：
 * 「换成静默」既命中别名也含 id，但别名表里的措辞更贴近自然语言，
 * 优先级更高才不会把「别出声」误判成普通查询。
 */
export function resolveVoiceRequest(text: string): string | null {
  for (const a of VOICE_ALIASES) {
    if (a.pattern.test(text)) return a.voiceId
  }
  for (const v of VOICE_CATALOG) {
    if (text.includes(v.id)) return v.id
  }
  return null
}
