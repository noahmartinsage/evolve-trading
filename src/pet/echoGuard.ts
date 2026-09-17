/**
 * 桌宠 · 自听判别（回声闸门）
 *
 * ── 它防的是哪一类事故 ────────────────────────────────────────────────
 * 桌宠没有耳机。它念的每一句话都会从音箱出去、再从麦克风回来。
 * 而"随时打断"是靠 ASR 的**中间结果**触发的（等最终结果出来，用户已经白说半句）。
 * 两者一叠加就是：桌宠一念长句 → 麦克风收到自己的声音 → 中间结果非空 →
 * 触发打断 → 掐掉合成 → 用户听到"说了半句突然哑掉"，然后再来一遍。
 *
 * 这个事故最难受的地方在于**它看起来像网络抖动**：日志里每次打断都有理由
 * （"检测到用户插话"），只是那个"用户"是它自己。
 *
 * ── 为什么不能用"说话时关掉麦克风" ────────────────────────────────────
 * 这是上游 airi 的做法（`shouldSuppressVoiceInput`：合成中 + 结束后 800ms 一律不采）。
 * 它是对的 —— 但它与"**随时**打断"直接冲突：关掉麦克风那一刻起，
 * 用户说什么都进不来，只能点屏幕上的停止按钮。
 *
 * 我们的取舍是：**麦克风永不关，改用文本层面判别**。
 * 关键观察是：**桌宠自己说的话很长，用户插话很短**。
 * 「停」「等一下」「别说了」都是 1~3 个字，而桌宠念的是整句播报。
 * 所以只要把"长中间结果"这一类才拿去做回声比对，短命令天然全部放行。
 *
 * ── 可断言的性质（见 scripts/pet-smoke.ts）─────────────────────────────
 *   ① 与正在朗读文本高度重合的长中间结果，**不得**触发打断；
 *   ② 短命令（「停」）在被念长句时**必须**触发打断；
 *   ③ 麦克风未收音时任何输入都不得产生打断判定；
 *   ④ 合成结束后冷却窗内不得触发打断（尾部残响）；
 *   ⑤ 合成静止时任何输入都**不得**触发打断（否则会误清待确认凭证）。
 */

/** 少于这个字数的中间结果不做回声比对 —— 短命令直接放行。 */
export const ECHO_MIN_CHARS = 4

/** 重合度阈值。用 containment（交集 / 较小集合）而不是 Jaccard：
 *  桌宠念 30 字、用户插 5 字，若用 Jaccard 分母被长句拖到 0.14，永远判不出来。 */
export const ECHO_OVERLAP_THRESHOLD = 0.6

/** 合成结束后的静音窗。上游用 800ms；我们保持一致，因为它压的是音箱尾响而非人声。 */
export const DEFAULT_SPEECH_TAIL_COOLDOWN_MS = 800

/**
 * 归一化：只留中日韩文字与字母数字。
 *
 * 必须做这一步，否则 ASR 会在中间结果里加标点、吞空格，
 * 同一句话归一化前后重合度能差 30 个点（实测：「订单已拒绝，原因：超限。」
 * 与「订单已拒绝原因超限」的裸比对只有 0.5，归一化后是 1.0）。
 */
export function normalizeForEchoCompare(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 二元组集合。单字串退化为它本身，避免返回空集导致分母为 0。 */
function bigrams(s: string): Set<string> {
  if (s.length === 0) return new Set()
  if (s.length === 1) return new Set([s])
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

/**
 * 包含度重合：`|A ∩ B| / min(|A|, |B|)`。
 *
 * 语义是「较短的那句话，有多少比例被较长的句子覆盖了」——
 * 正是"这段中间结果是不是从正在朗读的那句里漏出来的"要问的问题。
 */
export function textOverlapRatio(a: string, b: string): number {
  const na = normalizeForEchoCompare(a)
  const nb = normalizeForEchoCompare(b)
  if (!na || !nb) return 0
  const sa = bigrams(na)
  const sb = bigrams(nb)
  let hit = 0
  for (const g of sa) if (sb.has(g)) hit += 1
  return hit / Math.min(sa.size, sb.size)
}

export type BargeInReason =
  /** 中间结果为空 —— 不算一次输入 */
  | 'no-speech'
  /** 麦克风压根没开（打断只在收音时才有意义） */
  | 'mic-off'
  /** 与正在朗读的文本高度重合 ⇒ 是桌宠自己的声音回来了 */
  | 'self-echo'
  /** 合成刚结束的冷却窗内 ⇒ 音箱尾响，且此时已无话可打断 */
  | 'speaker-tail'
  /**
   * 合成器**静止**，没有任何话正在念 ⇒ 没有可打断的对象。
   *
   * ★ 这一档不是"顺手加的优化"，它挡住的是一个会吃掉待确认凭证的事故：
   * 服务端 `interrupt()` 除作废在途答复外**还会清掉 pending 凭证**。
   * 而用户回应「请复述金额」时说的第一段中间结果恰恰是「确认」——
   * 若此时无差别打断，凭证就在用户正要确认它的那一刻被自己打掉了，
   * 随后真正说出的「确认 200」只会得到"没有待确认的动作"。
   * 症状是"它老是忘记自己刚问过什么"，而日志里每一次打断都写着理由。
   */
  | 'idle'
  /** 判定为真实插话 */
  | 'interrupt'

export interface BargeInVerdict {
  bargeIn: boolean
  reason: BargeInReason
  /** 与正在朗读文本的重合度。为 0 时可能是没做比对（短命令），看 reason 区分。 */
  overlap: number
  /** 给面板/日志看的判定说明。「为什么没反应」必须可查，否则这条闸门等于不存在。 */
  detail: string
}

export interface BargeInInput {
  /** ASR 中间结果（调用方已 trim 并保证非空才会调进来） */
  interim: string
  /** 合成器此刻正在念的整句；空闲时为 null */
  speakingText: string | null
  /** 麦克风是否在收音。关着的时候不该产生打断 —— 那是上一轮的迟到回调。 */
  listening: boolean
  /** 合成结束后的静音窗截止时刻（毫秒时间戳）。0 表示无冷却。 */
  cooldownUntil: number
  now?: number
}

/**
 * 判定一次中间结果算不算"用户在插话"。
 *
 * 判定顺序是有讲究的，不能随便换：
 *   ① 空 / 未收音 → 直接否，先排除掉不是输入的东西；
 *   ② **合成静止** → 直接否。没有正在念的话，就没有可打断的对象，
 *      而打一次服务端 interrupt 会连带清掉待确认凭证（见 `'idle'` 的注释）。
 *   这一步必须在所有文本比对**之前**：静止时压根不该做"这句话像不像它说的"这种判断。
 *   ③ **短命令放行**：不足 4 字的不做回声比对，直接算插话。
 *      这一步必须在回声比对**之前**，否则「停」会被拿去和长句比对 ——
 *      只要长句里恰好含这个字（"暂**停**自动驾驶"），用户的止损命令就被自己吞掉。
 *   ④ 长文本才做回声比对；
 *   ⑤ 冷却窗（只在静止分支里才有意义，见下）；
 *   ⑥ 其余算插话。
 */
export function judgeBargeIn(input: BargeInInput): BargeInVerdict {
  const now = input.now ?? Date.now()
  const raw = input.interim.trim()
  const norm = normalizeForEchoCompare(raw)

  if (!norm) {
    return { bargeIn: false, reason: 'no-speech', overlap: 0, detail: '中间结果为空，不是一次输入' }
  }
  if (!input.listening) {
    return { bargeIn: false, reason: 'mic-off', overlap: 0, detail: '麦克风未收音，忽略迟到的中间结果' }
  }

  // ② 合成静止：没有可打断的对象。这一档连同它的理由都在类型注释里。
  if (!input.speakingText) {
    // 静止分支里"尾响"比"空闲"更具体，所以先判冷却窗，好让面板给出准确原因
    if (now < input.cooldownUntil) {
      return {
        bargeIn: false,
        reason: 'speaker-tail',
        overlap: 0,
        detail: `处于合成结束后的 ${input.cooldownUntil - now}ms 冷却窗内，判为音箱尾响`,
      }
    }
    return {
      bargeIn: false,
      reason: 'idle',
      overlap: 0,
      detail: '它此刻没有说话 —— 没有可打断的对象，也不打扰服务端会话（避免误清待确认凭证）',
    }
  }

  // ③ 短命令：桌宠念长句，用户插短句。「停」这种命令不许被回声比对吃掉。
  if (norm.length < ECHO_MIN_CHARS) {
    return {
      bargeIn: true,
      reason: 'interrupt',
      overlap: 0,
      detail: `短命令「${raw}」（${norm.length} 字 < ${ECHO_MIN_CHARS}），不做回声比对直接放行`,
    }
  }

  // ④ 长文本：与正在朗读的整句比重合
  const overlap = textOverlapRatio(raw, input.speakingText)
  if (overlap >= ECHO_OVERLAP_THRESHOLD) {
    return {
      bargeIn: false,
      reason: 'self-echo',
      overlap,
      detail: `与正在朗读的文本重合 ${(overlap * 100).toFixed(0)}% ≥ ${ECHO_OVERLAP_THRESHOLD * 100}%，判为自听回声`,
    }
  }

  // ⑤ 走到这里说明正在出声，冷却窗按定义已经过期（它是"上一句说完"开的），
  // 所以不再判它 —— 判了会把"念到第二句时喊停"这种真插话吞掉。
  return { bargeIn: true, reason: 'interrupt', overlap, detail: '判定为真实插话' }
}

/** 合成结束时刻 → 冷却截止时刻。 */
export function speechTailCooldownDeadline(
  endedAt: number,
  cooldownMs = DEFAULT_SPEECH_TAIL_COOLDOWN_MS,
): number {
  return endedAt + cooldownMs
}

/**
 * 是否整体跳过收音（上游 airi 的 `shouldSuppressVoiceInput` 语义）。
 *
 * 保留它但**默认不用**：桌宠走的是"永不关麦 + 文本判别"。
 * 它存在的意义是给"用户戴耳机"这一档用 —— 戴了耳机就没有回声，
 * 此时唯一需要压的是尾响窗，而它正好是这个函数。
 */
export function shouldSuppressVoiceInput(
  options: { assistantSpeaking: boolean; suppressedUntil: number },
  now = Date.now(),
): boolean {
  return options.assistantSpeaking || now < options.suppressedUntil
}
