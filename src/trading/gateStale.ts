/**
 * 「这条裁决过期了没有」这件事的**唯一出处**。
 *
 * ══ 为什么要把这几行从页面里搬出来 ══════════════════════════════════════
 * 原先它住在 `TerminalPage.tsx` 里，是连着写的三个表达式：
 *
 *     const paramsStale = gate !== null && checkedKey !== orderKey
 *     const quoteStale  = gate !== null && !paramsStale && pinned !== null && ...
 *     const staleReason = paramsStale ? 'params' : quoteStale ? 'quote' : null
 *
 * 这段逻辑**没法被断言**：页面组件要渲染才能跑，而烟测里断言它的办法只剩
 * "在源码里找那几个词出现过"。实测踩到（判据 36）：
 * 变异把**产生** `'quote'` 的那一行改掉之后，消费端 `staleReason === 'quote'`
 * 这两个词还在源码里 ⇒ 断言照样绿，而界面从此永远只会说"参数已改动"。
 *
 * ⇒ 搬成纯函数，真值表就能逐条断言；"两种原因"这件事第一次有了牙。
 *   （同族范式：`src/voice/speechPath.ts` —— 前端纯逻辑单独成模块才好断言。）
 *
 * ══ 这条规矩守的是什么 ══════════════════════════════════════════════════
 * 用户改了参数、和没人碰过屏幕而行情自己跑了，是**两件不同的事**，
 * 对应**两个不同的动作**（去改参数 / 直接重新检查）。合并成一句"参数已改动"
 * 会让用户对着自己没动过的屏幕找不到改了什么（判据 17：这个输出把用户引向哪个动作）。
 *
 * ★ 本文件是**纯函数**，不 import 任何东西（浏览器与服务端都能用）。
 */

/** 过期的两种事因。`null` = 没过期。 */
export type GateStaleReason = 'params' | 'quote' | null

/**
 * 报价漂移的容忍度（bps）。
 * ★ 低于它的波动不算"行情跑了" —— 否则行情每一跳都会让裁决失效，
 *   用户永远等不到一个能提交的时刻（判据 2 的同族：对正确的输入报错）。
 */
export const QUOTE_DRIFT_TOLERANCE_BPS = 20

/**
 * 相对漂移（bps），以 `base` 为分母。
 * ★ 分母非正时返回 **0**，不是 `Infinity`：裁决里那个价要是 0，
 *   返 `Infinity` 会让**每一条**裁决都被判成"过期"，而屏幕上只写着
 *   "行情已变动"，看不出是分母坏了。
 */
export const driftBps = (now: number, base: number): number => (base <= 0 ? 0 : Math.abs((now - base) / base) * 1e4)

export interface GateStaleInput {
  /** 有没有裁决。没有裁决的时候谈不上"过期"，只谈"还没检查"。 */
  hasVerdict: boolean
  /** 用户改过参数（下单指纹变了）。 */
  paramsChanged: boolean
  /** 裁决当时，**引擎**报的那个价。 */
  pinnedPrice: number | null
  /** 现在的实时价（来自注册表 + 行情流）。 */
  livePrice: number | null
}

export interface GateStaleResult {
  paramsStale: boolean
  quoteStale: boolean
  /** 两者之一 —— 界面上"能不能提交"看它。 */
  gateStale: boolean
  reason: GateStaleReason
  /** 现价相对裁决价漂移了多少 bps；算不出来给 `null`，**不给 0**（判据 24）。 */
  driftBps: number | null
}

/**
 * 由四个事实推出过期状态。
 * ★ 顺序有意义：**参数优先**。用户改过参数时不再说行情的事 ——
 *   两条一起说会把用户同时引向两个动作，而他只需要做一件。
 */
export function deriveGateStale(i: GateStaleInput): GateStaleResult {
  const drift = i.pinnedPrice !== null && i.livePrice !== null ? driftBps(i.livePrice, i.pinnedPrice) : null
  const paramsStale = i.hasVerdict && i.paramsChanged
  const quoteStale = i.hasVerdict && !paramsStale && drift !== null && drift > QUOTE_DRIFT_TOLERANCE_BPS
  return {
    paramsStale,
    quoteStale,
    gateStale: paramsStale || quoteStale,
    reason: paramsStale ? 'params' : quoteStale ? 'quote' : null,
    driftBps: drift,
  }
}

/**
 * 过期时**说给用户听的那句话**。没过期返回 `null`（不是空串 —— 判据 24）。
 *
 * ══ 为什么连文案也要搬进来 ══════════════════════════════════════════════
 * 它原来在界面里，是 JSX 里的两个分支；而"该说哪一句"这个判断在**另一处**
 * （提交被拦时的报错）**又写了一遍**。于是同一件事有了两个主人（判据 29），
 * 实测的后果是：烟测断言 `/staleReason === 'quote'/` **出现过**，
 * 而删掉界面那一句之后，另一处那个词还在 ⇒ 断言照样绿（判据 36）。
 * ⇒ 现在"哪种原因 → 说哪句话"只有这一个出处，且两种原因的话**必须不同**
 *   （相同 = 用户按错误的那句去做）。
 *
 * ★ 文案里**不许有 markdown 星号**：本项目没有任何 markdown 渲染器，
 *   星号会原样显示给用户（本项目踩过一次）。
 */
export function gateStaleMessage(reason: GateStaleReason, drift: number | null): string | null {
  if (reason === 'params') {
    return '下单参数已改动 —— 上面那条裁决说的是上一组参数，已过期。等它重新检查完再提交。'
  }
  if (reason === 'quote') {
    const bps = drift === null ? '—' : drift.toFixed(0)
    return `你什么都没改，是行情动了（${bps} bps）—— 那条裁决衡量的是上一次的价，按现在这个价成交会不一样。请重新检查。`
  }
  return null
}
