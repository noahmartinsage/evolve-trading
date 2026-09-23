/**
 * 会话与打断（barge-in）
 *
 * ── 打断为什么不能只是"把音箱关掉" ──────────────────────────────────
 * 用户插话时，系统里同时有**三件在途的事**：
 *   ① 合成器正在念上一句；
 *   ② 服务端正在为上一句算答复（可能要跑回测/查账）；
 *   ③ 上一句的答复即将被送回来念出。
 * 只做 ① 的话，用户插完话会先听到**新问题**的答复，中间又被**旧问题**的
 * 答复打断一次 —— 表现为"这个助手抢话、答非所问"，而日志里一切正常。
 *
 * 这里用**世代号（generation）**治 ②③：
 * 每次打断 `generation += 1`；每个轮次在开始时记下当时的世代号；
 * 答复回来时如果 `generation` 已经变了，**直接丢弃**。
 * 于是"旧答复永不上屏"从一句设计意图变成了一条可断言的性质
 * （voice-smoke 的打断用例就是拿这个判据写的：丢弃必须真的发生，
 * 不能只是"我们打算这么做"）。
 *
 * ── 两段式确认 ──────────────────────────────────────────────────────
 * 语音有三重风险：张嘴即动作、识别会错、用户看不见自己说了什么。
 * 所以改变资金的动作必须先拿到 `PendingConfirmation`。确认凭证的强度
 * **按风险分档**，而不是一刀切：
 *
 *   仿真 + 金额 ≤ echo 门槛 → 说「确认」即可
 *   仿真 + 金额 >  门槛     → 必须复述金额（「确认两百」）
 *   实盘（不论金额）        → 必须复述金额
 *
 * 分档的理由：复述金额的真正作用是**校验 ASR 有没有听错数字**，
 * 而听错数字在实盘上才是不可逆的。对一笔 20 U 的仿真单强制复述，
 * 只会让用户放弃用语音，反而把风险逼回"手动点按钮"那条更不设防的路径。
 */
import { randomUUID } from 'node:crypto'
import type { PendingConfirmation, VoiceTurn, OrderSlots, TurnState, VoiceStatus, VoiceIntentName } from './types.ts'
import { recordUserTurn, recordAssistantTurn, recordTurnIntent } from './transcript.ts'

/**
 * 需要"复述金额"的名义额门槛。
 *
 * 取值 50 = 默认 `maxNotionalPerOrder`(500) 的 1/10。
 * 刻意与 surveillance 的 `burstMaxNotionalUsdt` 同值同理由（"远低于任何逐笔闸门"）——
 * 「多少算小额」在本系统里应该只有一个数量级直觉，不该每个模块各拍一个。
 */
const CONFIRM_ECHO_NOTIONAL = 50

/** 确认凭证有效期。太长等于没设，太短用户来不及念。 */
const PENDING_TTL_MS = 60_000

let generation = 0
let turnSeq = 0
let currentTurn: VoiceTurn | null = null
let pending: PendingConfirmation | null = null
let interruptedCount = 0
/** 被打断而**丢弃**的答复数。与 interruptedCount 分开记：前者是用户动作，后者是真实止损。 */
let droppedReplies = 0

/**
 * 本次进程的会话 id。
 *
 * ★ 为什么必须有它：`turnId` 只是**进程内**的自增序号，进程一重启就从 1 重来。
 *   聊天记录是跨进程累积的文件，如果只按 `turnId` 配对，"昨天第 3 轮"和
 *   "今天第 3 轮"就会被拼成同一轮 —— 而拼出来的那轮**看着完全正常**，
 *   两边的话都像人说的（判据 29：一句话只能有一个主人）。
 *   所以配对键是 `sid + turnId`，`sid` 每次进程启动换一次。
 */
const sid = `s${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`

export function sessionId(): string {
  return sid
}

export function beginTurn(
  utterance: string,
  /**
   * 附件元信息（不含内容）。只记"当时贴了什么"，不落原始字节 ——
   * 聊天记录是给人查对话的，不是第二份附件库。
   */
  attachments: readonly { name: string; mimeType: string; bytes: number }[] = [],
): VoiceTurn {
  turnSeq += 1
  currentTurn = {
    turnId: turnSeq,
    state: 'thinking',
    utterance,
    reply: '',
    ts: Date.now(),
  }
  // ★ 落盘放在这里（会话状态机）而不是 service 层：
  //   `commitReply` 在 service 里有 **4 个调用点**（3 处在 handleConfirm、
  //   1 处在 finish 闭包），在那一层落盘就等于"同一个业务动作有四条实现
  //   路径"，将来加第 5 个出口必漏（判据 8）。而任何一轮对话都**必须**
  //   经过 beginTurn 才能存在 —— 这里是唯一必经点。
  recordUserTurn({
    sid,
    turnId: currentTurn.turnId,
    text: utterance,
    at: currentTurn.ts,
    attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, bytes: a.bytes })),
  })
  return currentTurn
}

/**
 * 补记本轮的意图 / 失败原因。
 *
 * ★ 为什么是"补记"：意图解析发生在 `beginTurn` **之后**（要先有 turnId 才能记），
 *   而我们落盘是追加式的、绝不改写已提交的行 —— 所以意图只能另起一行，
 *   读取时按 `(sid, turnId)` 合并。
 *
 * ★ 它顺带修掉一处静默的哑失败：`VoiceTurn.intent` 这个字段**一直都存在，
 *   但在此之前从来没有被赋值过**（`setTurnState` 的调用点是空的）。
 *   一个永远 `undefined` 的字段配上"面板要显示意图"的期望，
 *   表现就是"意图那一栏永远是空的"，而没有任何地方会报错。
 */
export function setTurnMeta(turnId: number, patch: { intent?: VoiceIntentName; reason?: string }): boolean {
  if (!currentTurn || currentTurn.turnId !== turnId) return false
  currentTurn = { ...currentTurn, ...patch }
  if (patch.intent) recordTurnIntent(sid, turnId, patch.intent, Date.now())
  return true
}

export function setTurnState(turnId: number, state: TurnState, patch?: Partial<VoiceTurn>): boolean {
  if (!currentTurn || currentTurn.turnId !== turnId) return false
  currentTurn = { ...currentTurn, ...patch, state }
  return true
}

/**
 * 提交答复。**只有当世代号未变、且仍是当前轮次时才生效**。
 *
 * 返回 false 表示这条答复已被打断作废 —— 调用方（HTTP 处理函数）据此
 * 在响应里标记 `dropped: true`，前端就不会去念它。
 * 把这个判断做成返回值而不是"顺手 return"，是为了让它可被断言。
 */
export function commitReply(turnId: number, reply: string, gen: number): boolean {
  // 意图可能已由 `setTurnMeta` 补记，也可能还没有。拿不到就**不写** ——
  // 不猜一个"大概是这个"填进去（派生值不当独立证据）。
  const intent = currentTurn && currentTurn.turnId === turnId ? currentTurn.intent : undefined
  const drop = (reason: 'generation' | 'turn'): false => {
    droppedReplies += 1
    recordAssistantTurn({ sid, turnId, text: reply, at: Date.now(), gen, dropped: true, dropReason: reason, intent })
    return false
  }
  if (gen !== generation) return drop('generation')
  if (!currentTurn || currentTurn.turnId !== turnId) return drop('turn')
  currentTurn = { ...currentTurn, state: 'done', reply }
  // ★ 作废的答复也要落盘，但不是为了"留案底"：是为了让"我以为它在答、
  //   其实一个字都没念"这件事可查。不记的话，用户回看记录只会看到
  //   自己问了一句、下面空着 —— 而"它没答"与"它答了但被打断"是两件事。
  recordAssistantTurn({ sid, turnId, text: reply, at: Date.now(), gen, dropped: false, intent })
  return true
}

export function currentGeneration(): number {
  return generation
}

/** 打断：作废在途答复 + 清掉待确认（插话本身就意味着"刚才那个先不算"）。 */
export function interrupt(reason = 'USER_BARGE_IN'): { generation: number; droppedPending: boolean } {
  generation += 1
  interruptedCount += 1
  if (currentTurn && (currentTurn.state === 'speaking' || currentTurn.state === 'thinking')) {
    currentTurn = { ...currentTurn, state: 'interrupted', reason }
  }
  const droppedPending = pending !== null
  pending = null
  return { generation, droppedPending }
}

/**
 * 是否需要复述金额才放行。
 *
 * 刻意**不接受调用方传布尔量**：本项目已复现过 6 次「自报布尔量 / 自报口径」
 * 造成的失效（F-33/F-40/F-41/F-44/F-42/F-45），其中 F-41 就是这个形状 ——
 * 判定所需的输入由被判定方自己填，于是它永远填得过。
 *
 * 这里把判据钉在**服务端自己构造的凭据**上：
 *   `slots.live`（用户原话里有没有"实盘"）与 `expectedNotional`（服务端用实时标记价算出的名义额）。
 * 调用方只能提供"用户念了什么数字"，无法提供"要不要校验"。
 */
export function echoRequiredFor(p: { slots: OrderSlots; expectedNotional: number }): boolean {
  if (p.slots.live === true) return true
  return p.expectedNotional > CONFIRM_ECHO_NOTIONAL
}

export function createPending(
  intent: VoiceIntentName,
  action: string,
  slots: OrderSlots,
  resolvedNotional: number,
  originTurnId: number,
  /** 非订单类动作的文字参数（心法正文）。语义不同的东西不共用 `slots`，理由见 types.ts。 */
  intentArg?: string,
): PendingConfirmation {
  const lev = Number.isFinite(slots.leverage) && (slots.leverage ?? 0) > 1 ? (slots.leverage as number) : 1
  // 合约单里用户说的那个钱是**保证金**，所以复述值也用它 —— 他念自己刚说的数才自然。
  // 名义额作为备选值一起收（见 types.ts 的 `expectedAmountAlt`）。
  const isMargin = slots.amountBasis === 'margin' && slots.notional !== undefined && lev > 1
  const amount = isMargin
    ? (slots.notional as number) / lev
    : slots.qty !== undefined && slots.notional === undefined
      ? slots.qty
      : (slots.notional ?? slots.qty ?? 0)
  pending = {
    token: randomUUID().slice(0, 8),
    ts: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
    intent,
    action,
    expectedAmount: amount,
    ...(isMargin ? { expectedAmountAlt: slots.notional as number } : {}),
    amountBasis: slots.amountBasis ?? (slots.qty !== undefined ? 'qty' : 'notional'),
    /**
     * 服务端按实时标记价折算出的名义额 —— 风险分档量的是**钱**，
     * 不是"用户说的那个数"。用户说「一个比特币」时 qty=1 看着很小，
     * 实际名义额十万量级，必须按名义额分档才拦得住。
     */
    expectedNotional: Number.isFinite(resolvedNotional) ? resolvedNotional : 0,
    slots,
    originTurnId,
    ...(intentArg !== undefined ? { intentArg } : {}),
  }
  return pending
}

/**
 * 为**界面按钮**建一条待确认。
 *
 * ★ 为什么不让它走 `createPending`：那个函数要收 `slots` 与 `resolvedNotional`，
 *   然后算出 `expectedAmount`、`expectedNotional`、风险分档。
 *   "按一下保存参数"没有金额、没有方向、没有名义额 —— 硬填一组零进去，
 *   确认回话就会变成"请复述金额 0"。所以两种东西各走各的构造器，
 *   它俩共用的只有 `pending` 这个**单槽**（一次只能等一个确认）。
 */
export function createPendingUiAction(
  actionId: string,
  actionLabel: string,
  originTurnId: number,
): PendingConfirmation {
  pending = {
    token: randomUUID().slice(0, 8),
    ts: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
    // 路由只认 `intent`，所以这里给一个明确的机器标识，
    // **不**复用任何订单意图 —— 复用会让"按按钮"在日志里长得像"下单"。
    intent: 'ui_action',
    action: actionLabel,
    expectedAmount: 0,
    amountBasis: 'notional',
    expectedNotional: 0,
    slots: { side: 'buy', symbol: '' },
    originTurnId,
    uiActionId: actionId,
    uiActionLabel: actionLabel,
  }
  return pending
}

export function getPending(): PendingConfirmation | null {
  if (!pending) return null
  if (Date.now() > pending.expiresAt) {
    pending = null
    return null
  }
  return pending
}

export function clearPending(): void {
  pending = null
}

export type ConfirmResult =
  | { ok: true; pending: PendingConfirmation }
  | { ok: false; reason: string; expected?: number }

/**
 * 校验一次口头确认。
 *
 * 注意「复述金额不符」与「没复述金额」被刻意分成两条不同的 reason：
 *   前者是**识别听错了**（用户念了 200、系统听成 2000），
 *   后者是**用户没照格式念**。
 * 两者的处置完全不同 —— 前者要提醒用户"我可能听错了，请再念一次"，
 * 后者只是格式问题。压成同一个 reason 会让排查方向跑偏。
 *
 * 是否需要复述由 `echoRequiredFor(pending)` 自己判定，
 * 因此调用方**无法**通过多传一个参数把校验关掉。
 */
export function confirmPending(
  parsedAmount: { value: number; basis: 'notional' | 'qty' | 'unknown' } | null,
): ConfirmResult {
  const p = getPending()
  if (!p) return { ok: false, reason: 'NO_PENDING_OR_EXPIRED' }

  if (!echoRequiredFor(p)) return { ok: true, pending: p }

  if (!parsedAmount) {
    return {
      ok: false,
      reason:
        `VOICE_CONFIRM_NEEDS_AMOUNT_ECHO（这笔需要复述金额：请说「确认 ${p.expectedAmount}」。` +
        `${p.slots.live ? '实盘单不复述不放行' : `金额超过 ${CONFIRM_ECHO_NOTIONAL} U 需要复核`}）`,
      expected: p.expectedAmount,
    }
  }

  const near = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1e-9) <= 0.005
  // ★ 合约单收两个值：保证金（用户说的那个）与名义额（系统量的那个）。
  //   只收一个的后果是规范操作会被判成"念错了" —— 判据 2。
  if (!near(parsedAmount.value, p.expectedAmount) && !(p.expectedAmountAlt !== undefined && near(parsedAmount.value, p.expectedAmountAlt))) {
    const alts = p.expectedAmountAlt !== undefined ? `${p.expectedAmount}（或名义额 ${p.expectedAmountAlt}）` : `${p.expectedAmount}`
    return {
      ok: false,
      reason: `VOICE_CONFIRM_AMOUNT_MISMATCH（我准备执行的是 ${alts}，你念的是 ${parsedAmount.value} —— 可能是我听错了，请重新念一次金额）`,
      expected: p.expectedAmount,
    }
  }
  return { ok: true, pending: p }
}

/** 消费凭证（一次性）。 */
export function consumePending(): PendingConfirmation | null {
  const p = getPending()
  pending = null
  return p
}

export function sessionStatus(): Pick<VoiceStatus, 'generation' | 'interruptedCount' | 'pending'> & {
  turn: VoiceTurn | null
  droppedReplies: number
  echoThresholdNotional: number
} {
  return {
    generation,
    interruptedCount,
    pending: getPending(),
    turn: currentTurn,
    droppedReplies,
    echoThresholdNotional: CONFIRM_ECHO_NOTIONAL,
  }
}

export function resetSession(): void {
  generation = 0
  turnSeq = 0
  currentTurn = null
  pending = null
  interruptedCount = 0
  droppedReplies = 0
}
