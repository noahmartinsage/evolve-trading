/**
 * 启动口令 —— 「让任务真的跑起来」的专用确认凭证
 *
 * ── 为什么必须有它，而不是复用既有的「复述金额」确认 ────────────────────
 * 既有确认流程（`voice/service.ts` 的 `createPending`）要用户**复述金额**。
 * 那套东西对下单是对的：金额就是那笔单的全部内容，复述它等于复述了这笔单。
 * 但任务没有金额 —— 它的口径是**目标百分比**（0 < t ≤ 50）。
 * 拿"复述金额"来顶"启动许可"，面板上会把 +50% 显示成 50 美元，
 * 用户按字面理解成"投入 50 美元"，于是**一次确认的意义在两侧完全不同**。
 * 这种"两处对同一个动作理解不同"的确认，比没有确认更危险：
 * 它让人以为自己批准过这件事，而批准的其实是另一件事。
 *
 * ── 口令为什么是**两半** ──────────────────────────────────────────────
 *   ① 固定口令词 `确认启动` —— 管"我知道我要做什么"。
 *      它是**必须说出来的动作**。只说口令码不行：那样一次误识别就可能启动循环，
 *      而循环会自己反复下单。
 *   ② 一次性口令码 `XXXX` —— 管"我批准的是**这一份**裁定书"。
 *      它由服务端在裁定为 `feasible` 时签发，与 `planId` 绑定，
 *      于是"批准"这个动作指向的对象**不可被替换**：条件变了 `planId` 就变，
 *      旧口令码随之作废（`startMissionByPlan` 的二次裁定会先把它挡下来）。
 *
 * 两半缺一不可：只有①会因为"顺口说了句确认启动"就开跑；
 * 只有②会丢掉"人在做决定"这个事实。
 *
 * ── 口令码为什么是 4 位数字（而不是字母、不是更长）────────────────────
 * 因为它要被**念出来**、被**听回来**。决定它形态的是通道，不是密码学：
 *   · **不要字母**：中文场景下 ASR 对单个字母的识别率远低于数字
 *     （B/P/D、M/N 这类在中文里根本没有可靠对应）。字母会带来
 *     "明明念对了却一直说不通过"的假拒绝，而假拒绝会训练用户忽略结果。
 *   · **不要前导零**：`0042` 念出来容易被听成 `42` 或丢掉一位。
 *     取值域取 `[1000, 9999]`，四位恒成立，整个失效形态直接不存在。
 *   · **位数按"防谁"来定，不按密码学强度来定**：
 *     9000 个取值 × 最多 3 次尝试 = 撞中概率 3.3e-4。
 *     而这里要防的是**误触发与误听**，不是攻击者 ——
 *     能调到这个端点的人手里已经有编排令牌，那本来就能做任何事。
 *     ★ 这一点必须写明：把口令讲成"安全边界"是错觉，
 *       它真正的价值是"让启动成为一个**刻意**的动作"。
 *
 * ── 服务端构造，且只在下发那一刻存在明文 ──────────────────────────────
 * 明文码只出现在 `IssueStartConsentResult` 返回值里（面板显示 / 嘴念），
 * 服务端只留 sha256 哈希。**账本里连哈希都不写** ——
 * 9000 的取值空间对哈希是离线可穷举的，写进去等于写了明文。
 * 账本记的是可观测量：给哪份裁定书签发过、什么时候到期、用没用掉。
 * （本项目的既有口径：凭据只装可观测量，不装结论字段。）
 *
 * ── 一次只允许一份待用口令 ────────────────────────────────────────────
 * 签发新的即作废旧口令（并留痕）。理由不是省内存，是**消除歧义**：
 * 若同时存在多份待用口令，"确认启动 4821"这句话到底批准了哪一份，
 * 就只能靠猜 —— 而猜错的方向是启动一个用户没在看的目标。
 * 现实里人同一时刻也只在一个目标上动手。
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { appendEvent } from '../ledger.ts'

/** 必须说出来的那半句。 */
export const START_PHRASE = '确认启动'
/**
 * 可接受的变体。刻意只收"这四个字连在一起、且顺序固定"的写法 ——
 * 放宽到"确认"+"启动"任意出现，会把「确认启动」和「确认撤单后启动」这类
 * 句子混为一谈，而后者不是启动许可。
 */
export const START_PHRASE_VARIANTS = ['确认启动', '启动确认'] as const

export const START_CODE_DIGITS = 4
/** 取值下界：刻意不从 0 开始 —— 见文件头「不要前导零」。 */
export const START_CODE_MIN = 1000
export const START_CODE_MAX = 9999
/** 有效期。到点即失效，不做"再给一分钟"。 */
export const START_CODE_TTL_MS = 10 * 60_000
/** 连错几次作废。超了要重新裁定（口令与裁定书绑定，重裁定会重新签发）。 */
export const START_MAX_ATTEMPTS = 3

export interface ConsentView {
  planId: string
  issuedAt: number
  expiresAt: number
  attempts: number
  remainingAttempts: number
  expired: boolean
}

export interface IssueStartConsentResult extends ConsentView {
  /** 给人看的形态（面板显示、用户照着敲）。 */
  code: string
  /**
   * 给嘴念的形态：各位之间留一个空格。
   *
   * ★ 这一条是实测教训，不是洁癖：合成语音会把 `4821` 读成
   *   「四千八百二十一」，而用户听到的又是这个数 —— 于是他会**照着念回去**，
   *   或者去面板上找那个根本不存在的四位数。
   *   分隔开之后，它才真的是一串"数字"，而不是一个"数"。
   */
  spoken: string
}

interface PendingConsent {
  planId: string
  codeHash: string
  issuedAt: number
  expiresAt: number
  attempts: number
}

/** 模块级单槽位：一次只允许一份待用口令（理由见文件头）。 */
let pending: PendingConsent | null = null

/** 测试与 `resetVoice` 用。生产路径不会调它。 */
export function resetStartConsent(): void {
  pending = null
}

const CN_DIGIT: Record<string, string> = {
  零: '0',
  〇: '0',
  一: '1',
  二: '2',
  两: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
}
/**
 * 数量级词：TTS 把数字当"数"念时会带上它们，还原时**丢弃**即可
 * （"四千八百二十一" → "4821"）。
 *
 * ★ 用字符集而不是正则：带 `g` 的正则用 `.test()` 会记住 `lastIndex`，
 *   同一个正则第二次调用会从上次的位置开始找 —— 症状是"同一句话第一次判对、
 *   第二次判错"，而它看起来完全不像状态问题。
 */
const CN_MAGNITUDE_CHARS = '千百十拾佰仟'

/** 去掉空白与标点，用于"这半句话在不在"的判断。 */
export function normalizeSpoken(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、,.!?；;：:''""（）()【】<>《》\-—_+*/\\|~·]/g, '')
    .toLowerCase()
}

/** 用户这一句里，有没有说出固定口令词。 */
export function heardStartPhrase(text: string): boolean {
  const n = normalizeSpoken(text)
  return START_PHRASE_VARIANTS.some((v) => n.includes(v))
}

export interface HeardCode {
  code: string | null
  reason: 'OK' | 'NOT_FOUND' | 'AMBIGUOUS'
}

/**
 * 从一句话里听出口令码。
 *
 * 规则（确定性，无概率）：
 *   ① **紧跟在口令词之后**的那个数字串。它是 4 位 → 就是它。
 *      这一条覆盖正常说法：「确认启动 4821」「确认启动 4 8 2 1」。
 *      注意"紧邻"是按去空白标点后的字符位置算的，所以「确认启动，4821」
 *      也算紧邻；而「确认启动，口令是 4821」不算 —— 中间夹了字。
 *   ② 否则在整句里找**唯一的** 4 位数字串。
 *      这一条覆盖"顺带说了别的话"：「确认启动，用 10U 的那个，4821」。
 *   ③ 还不行 → 判为不可识别 / 歧义，**不放行**，让用户重说一遍。
 *      这里刻意不做"猜一个最像的"：猜错的方向是启动一个他没在看的目标。
 *
 * ★ 这段代码上一版有个真缺陷（被 S-M14 抓到）：它声明了中文数字映射表
 *   却**从没用过**，于是「四八二一」被整句吃掉，只有阿拉伯数字能过。
 *   更隐蔽的是它同时让规则①成了**永远走不到的分支** ——
 *   因为"非数字→分隔符"那一步会把口令词的中文字也变成空格，
 *   `indexOf('确认启动')` 恒为 -1，所有输入都靠规则②侥幸通过。
 *   两个缺陷互相掩盖，从外部看只是"能工作"。
 */
export function heardStartCode(text: string): HeardCode {
  const norm = normalizeSpoken(text)

  // 字符级扫描：一边映射一边记录位置。
  // 位置必须留着 —— 规则①要判"在不在口令词紧接着的后面"。
  const runs: Array<{ digits: string; start: number }> = []
  let cur = ''
  let curStart = -1
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i]
    // 数量级词丢弃而不是当分隔符（见 CN_MAGNITUDE_CHARS 的说明）
    if (CN_MAGNITUDE_CHARS.includes(ch)) continue
    const d = CN_DIGIT[ch] ?? (/[0-9]/.test(ch) ? ch : '')
    if (d !== '') {
      if (cur === '') curStart = i
      cur += d
      continue
    }
    if (cur !== '') {
      runs.push({ digits: cur, start: curStart })
      cur = ''
    }
  }
  if (cur !== '') runs.push({ digits: cur, start: curStart })

  if (runs.length === 0) return { code: null, reason: 'NOT_FOUND' }

  // ① 紧跟在口令词之后的数字串
  for (const v of START_PHRASE_VARIANTS) {
    const at = norm.indexOf(v)
    if (at < 0) continue
    const adjacent = runs.find((r) => r.start === at + v.length)
    if (adjacent && adjacent.digits.length === START_CODE_DIGITS) return { code: adjacent.digits, reason: 'OK' }
  }

  // ② 整句里唯一的 4 位串
  const fours = runs.filter((r) => r.digits.length === START_CODE_DIGITS)
  if (fours.length === 1) return { code: fours[0].digits, reason: 'OK' }
  if (fours.length > 1) return { code: null, reason: 'AMBIGUOUS' }
  return { code: null, reason: 'NOT_FOUND' }
}

function hashCode(code: string): string {
  return createHash('sha256').update('evolve-mission-start:' + code).digest('hex')
}

/**
 * 定长比较。
 *
 * 这里其实不需要常时比较（哈希是定长的，比较不泄漏长度），
 * 但仍然用它：理由是**这个函数以后可能被人改成比较原始码**，
 * 那时常时比较就是必需的。把安全属性放在实现里，比放在注释里可靠。
 */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 当前待用口令的元数据。**不含口令码**（明文不驻留、不重发）。 */
export function pendingStartConsent(now = Date.now()): ConsentView | null {
  if (!pending) return null
  return {
    planId: pending.planId,
    issuedAt: pending.issuedAt,
    expiresAt: pending.expiresAt,
    attempts: pending.attempts,
    remainingAttempts: Math.max(0, START_MAX_ATTEMPTS - pending.attempts),
    expired: now >= pending.expiresAt,
  }
}

/**
 * 签发一份新口令。
 *
 * ★ 会作废之前那份（`replacedPlanId` 留痕）。作废这件事必须**可观测**：
 *   否则用户拿着旧口令反复念，收到的却是"口令不对"，
 *   而真正的原因（"你在念上一份裁定书的口令"）永远看不到。
 */
export function issueStartConsent(planId: string, now = Date.now()): IssueStartConsentResult {
  const code = String(randomInt(START_CODE_MIN, START_CODE_MAX + 1))
  const replacedPlanId = pending?.planId ?? null
  const issuedAt = now
  const expiresAt = now + START_CODE_TTL_MS

  pending = { planId, codeHash: hashCode(code), issuedAt, expiresAt, attempts: 0 }

  appendEvent('MISSION_START_CONSENT_ISSUED', {
    planId,
    issuedAt,
    expiresAt,
    maxAttempts: START_MAX_ATTEMPTS,
    digits: START_CODE_DIGITS,
    // 刻意不写码、也不写哈希：9000 的取值空间对哈希是离线可穷举的
    replacedPlanId,
  })

  return {
    planId,
    code,
    spoken: code.split('').join(' '),
    issuedAt,
    expiresAt,
    attempts: 0,
    remainingAttempts: START_MAX_ATTEMPTS,
    expired: false,
  }
}

export type ConsentCheck =
  | { ok: true; planId: string }
  | { ok: false; code: string; message: string; remainingAttempts: number }

function refuse(code: string, message: string): ConsentCheck {
  return { ok: false, code, message, remainingAttempts: pending ? Math.max(0, START_MAX_ATTEMPTS - pending.attempts) : 0 }
}

/**
 * 校验口令。**不消费** —— 消费要等到真的要把执行线占下来那一刻
 * （见 `consumeStartConsent`）。理由：把"校验"与"用掉"绑在一起的话，
 * 一次因条件过期而失败的启动会白白吃掉用户的口令，
 * 他得重新裁定 → 拿到新口令 → 再念一遍，而每一步都可能再撞上一次别的拒绝。
 *
 * `planId` 可选：语音通道没有 planId（用户不会念哈希），
 * 此时以**待用口令自己绑定的那一份**为准；面板通道会带上，
 * 带上就必须一致 —— 不一致说明用户在看 A 却批准了 B。
 */
export function checkStartConsent(
  input: { phrase: string; code: string; planId?: string },
  now = Date.now(),
): ConsentCheck {
  if (!pending) {
    return {
      ok: false,
      code: 'CONSENT_REQUIRED',
      message: '现在没有等着启动的任务。要先说一个目标，我裁定完会给你口令。',
      remainingAttempts: 0,
    }
  }
  if (now >= pending.expiresAt) {
    pending = null
    return {
      ok: false,
      code: 'CONSENT_EXPIRED',
      message: '这份口令已经过期了（口令只管 10 分钟）。目标本身没变的话，重新说一次目标，我给你新口令。',
      remainingAttempts: 0,
    }
  }
  // 口令词不对**不计入尝试次数**：它不是"猜码失败"，是"根本没在确认启动"。
  if (!heardStartPhrase(input.phrase)) {
    return refuse('CONSENT_PHRASE_MISMATCH', '要启动得把口令词说全：' + START_PHRASE + '。只说数字我不认。')
  }
  if (input.planId && input.planId !== pending.planId) {
    return refuse(
      'CONSENT_PLAN_MISMATCH',
      '这份口令对应的不是当前这一份裁定书。请在同一个目标上重新说一遍，让口令和裁定书对上。',
    )
  }

  const heard = heardStartCode(input.code)
  if (heard.code === null) {
    return refuse(
      heard.reason === 'AMBIGUOUS' ? 'CONSENT_CODE_AMBIGUOUS' : 'CONSENT_CODE_UNREADABLE',
      heard.reason === 'AMBIGUOUS'
        ? '这句里有不止一组四位数字，我不确定哪个是口令。请只念口令：' + START_PHRASE + '，四位数字。'
        : '没听出口令码。口令是四位数字，比如：' + START_PHRASE + '，四八二一。',
    )
  }

  if (!hashEquals(hashCode(heard.code), pending.codeHash)) {
    pending.attempts += 1
    if (pending.attempts >= START_MAX_ATTEMPTS) {
      pending = null
      return {
        ok: false,
        code: 'CONSENT_ATTEMPTS_EXHAUSTED',
        message: '口令连错 ' + START_MAX_ATTEMPTS + ' 次，这一份已经作废了。重新说一次目标，我给你新口令。',
        remainingAttempts: 0,
      }
    }
    return refuse(
      'CONSENT_CODE_MISMATCH',
      '口令不对。还有 ' + (START_MAX_ATTEMPTS - pending.attempts) + ' 次机会，第 ' + START_MAX_ATTEMPTS + ' 次错就作废。',
    )
  }

  return { ok: true, planId: pending.planId }
}

/**
 * 消费口令。**必须紧挨着 `MISSION_STARTED` 落账之前调用**。
 *
 * 放在那里的理由与 `autopilot` 的"预留先行"同源：让"口令已用掉"与
 * "任务已启动"这两件事之间没有可插入成功路径的窗口。
 * 中间崩溃的后果是**口令丢掉**（内存态，重启归零），
 * 用户重说一遍目标即可 —— 丢一次口令是安全方向；
 * 反过来（先落 MISSION_STARTED 再消费）会留下一次没被消费的启动许可，
 * 那才是真正的后门。
 */
export function consumeStartConsent(planId: string): boolean {
  if (!pending || pending.planId !== planId) return false
  pending = null
  appendEvent('MISSION_START_CONSENT_CONSUMED', { planId })
  return true
}

/** 把口令折成一句能念的话。数字用 `spoken` 形态（各位分开）。 */
export function speakStartConsent(issued: IssueStartConsentResult, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((issued.expiresAt - now) / 60_000))
  return (
    '要启动的话，请说：' +
    START_PHRASE +
    '，口令 ' +
    issued.spoken +
    '。口令 ' +
    minutes +
    ' 分钟内有效，错 ' +
    START_MAX_ATTEMPTS +
    ' 次作废。'
  )
}
