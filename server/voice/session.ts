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

export function beginTurn(utterance: string): VoiceTurn {
  turnSeq += 1
  currentTurn = {
    turnId: turnSeq,
    state: 'thinking',
    utterance,
    reply: '',
    ts: Date.now(),
  }
  return currentTurn
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
  if (gen !== generation) {
    droppedReplies += 1
    return false
  }
  if (!currentTurn || currentTurn.turnId !== turnId) {
    droppedReplies += 1
    return false
  }
  currentTurn = { ...currentTurn, state: 'done', reply }
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
): PendingConfirmation {
  const amount = slots.qty !== undefined && slots.notional === undefined ? slots.qty : (slots.notional ?? slots.qty ?? 0)
  pending = {
    token: randomUUID().slice(0, 8),
    ts: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
    intent,
    action,
    expectedAmount: amount,
    amountBasis: slots.amountBasis ?? (slots.qty !== undefined ? 'qty' : 'notional'),
    /**
     * 服务端按实时标记价折算出的名义额 —— 风险分档量的是**钱**，
     * 不是"用户说的那个数"。用户说「一个比特币」时 qty=1 看着很小，
     * 实际名义额十万量级，必须按名义额分档才拦得住。
     */
    expectedNotional: Number.isFinite(resolvedNotional) ? resolvedNotional : 0,
    slots,
    originTurnId,
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

  const rel = Math.abs(parsedAmount.value - p.expectedAmount) / Math.max(p.expectedAmount, 1e-9)
  if (rel > 0.005) {
    return {
      ok: false,
      reason: `VOICE_CONFIRM_AMOUNT_MISMATCH（我准备执行的是 ${p.expectedAmount}，你念的是 ${parsedAmount.value} —— 可能是我听错了，请重新念一次金额）`,
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
