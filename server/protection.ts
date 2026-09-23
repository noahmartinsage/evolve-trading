/**
 * 保护单（止盈 / 止损）—— **唯一一处**决定"这道保护碰到了没有"。
 *
 * ══ 它治的是什么 ══════════════════════════════════════════════════════
 * 2026-09-22 实测：用户说「止盈 10 成 止损 0.1 成」，系统**解析对了**（100% / 1%）、
 * **念回了**、**落进审计事件了** —— 然后下一张**没有任何保护的裸单**：
 *
 *   | 层                         | 止盈止损 |
 *   |---|---|
 *   | `parseProtection`          | ✅ 支持「成 / 百分之X / X% / 个点 / 绝对价」 |
 *   | `describeContractOrder`    | ✅ 念出来 |
 *   | `VOICE_COMMAND` 审计事件    | ✅ 记下来 |
 *   | **`OrderIntentInput`**     | ❌ **根本没有这两个字段** |
 *   | **`submitToBroker`**       | ❌ 只传 5 个字段 |
 *
 * 于是"用户以为设了保护、实际在裸跑"—— 而这正是 `contract.ts` 自己在
 * 「关键词与数字之间允许出现的连接字」那段注释里警告过的事（"漏掉的表现是
 * **那一栏是空的**，不是报错 —— 用户以为设了保护"）。那句警告当初只被用在
 * **解析**上，没有被用在**派单**上。
 *
 * ══ 为什么单独一个模块 ════════════════════════════════════════════════
 * 因为它是**纯函数**：给定保护与价格，回答"碰到了没有、碰到的是哪一道"。
 * 纯函数才能离线逐条断言；把它塞进 `core.ts` 的 tick 回调里就再也测不了。
 *
 * ══ 它刻意不做的事 ════════════════════════════════════════════════════
 * **它不下单、不碰账本**。触发之后由调用方走**既有那一条**下单路径。
 * 自己在这里改持仓与余额会造出第二条记账路径（判据 8），
 * 而第二条路径与第一条一定会漂移 —— 那时候"哪份余额是真的"就没人说得清。
 */

/** 挂在某个标的上的保护。止盈/止损各自可选 —— 只设一个是合法诉求。 */
export interface PositionProtection {
  /**
   * 止盈**绝对价**。`undefined` = 用户没设这一道。
   *
   * ★ 存价格而不是存比例：比例会随标记价漂移。
   *   用户在 86000 说"止损 1%"，意思是 85140 这个价位；
   *   若存成 1% 而标记价后来变成 90000，复算出来是 89100 —— 保护自己跑了。
   */
  takeProfit?: number
  /** 止损**绝对价**。 */
  stopLoss?: number
  /** 挂上这道保护时的持仓方向。判定"碰到"必须知道方向。 */
  side: 'long' | 'short'
  /** 挂上时刻（ms）。落账与排查用。 */
  attachedAt: number
  /** 谁挂的（`voice` / `terminal` / …）。审计里要能把"嘴说的"和"手点的"分开。 */
  origin: string
}

export type ProtectionTrigger = 'take-profit' | 'stop-loss'

/**
 * 这一 tick 该不该触发保护；触发的是哪一道。
 *
 * ★★ 止损**优先于**止盈判定，顺序不能换。
 *    同一个 tick 同时穿过两道（跳空、插针）时：
 *      · 先判止盈 ⇒ 记成一次"落袋为安"
 *      · 先判止损 ⇒ 记成一次"止损离场"
 *    两者指向**相反的动作**（继续持有 vs 立刻退出），而价格已经穿过去了。
 *    跳空时真实的成交只会落在**不利**那一侧，所以判定也必须落在那一侧。
 *    判据 25：两种事因在"触发了保护"这个输出上长得一模一样。
 */
export function protectionTrigger(p: PositionProtection, price: number): ProtectionTrigger | null {
  if (!Number.isFinite(price) || price <= 0) return null
  const sl = p.stopLoss
  if (Number.isFinite(sl) && (sl as number) > 0) {
    if (p.side === 'long' ? price <= (sl as number) : price >= (sl as number)) return 'stop-loss'
  }
  const tp = p.takeProfit
  if (Number.isFinite(tp) && (tp as number) > 0) {
    if (p.side === 'long' ? price >= (tp as number) : price <= (tp as number)) return 'take-profit'
  }
  return null
}

export interface BuildProtectionInput {
  /** 入场参考价（标记价）。必须是**真实报价**，拿不到时不许编。 */
  mark: number
  side: 'long' | 'short'
  /** 止盈幅度（相对入场价，0.1 = 10%）。undefined = 没这一道。 */
  takeProfitPct?: number
  /** 止损幅度（相对入场价）。 */
  stopLossPct?: number
  origin: string
  now?: number
}

export type BuildProtectionResult =
  | { ok: true; protection: PositionProtection }
  | { ok: false; reason: string }

/**
 * 比例 → 绝对价，并**拒绝自相矛盾的组合**。
 *
 * ★ 这里要答的是"这道保护到底对着哪个价"：
 *   做多时止盈价必须**高于**入场价、止损价必须**低于**入场价；做空反之。
 *   若用户说的是反的（例如做多却给了止损 105% 的位置），那不是"保护更宽"，
 *   而是**方向理解错了** —— 放行它会挂出一道永远不会触发、却看起来设置了保护的单。
 *   这正是本项目最忌讳的形态：有保护的样子，没有保护的作用。
 */
export function buildProtection(input: BuildProtectionInput): BuildProtectionResult {
  const { mark, side, origin } = input
  if (!Number.isFinite(mark) || mark <= 0) {
    return { ok: false, reason: `NO_MARK_PRICE（入场参考价 ${mark} 不是真实报价，不许拿它定价）` }
  }
  const tpPct = input.takeProfitPct
  const slPct = input.stopLossPct
  const hasTp = Number.isFinite(tpPct) && (tpPct as number) > 0
  const hasSl = Number.isFinite(slPct) && (slPct as number) > 0
  if (!hasTp && !hasSl) return { ok: false, reason: 'NO_PROTECTION（没给止盈也没给止损）' }

  const protection: PositionProtection = { side, attachedAt: input.now ?? Date.now(), origin }

  if (hasTp) {
    const tp = side === 'long' ? mark * (1 + (tpPct as number)) : mark * (1 - (tpPct as number))
    if (!(tp > 0) || !Number.isFinite(tp)) return { ok: false, reason: `TP_PRICE_UNREADABLE（算出 ${tp}）` }
    protection.takeProfit = tp
  }
  if (hasSl) {
    const sl = side === 'long' ? mark * (1 - (slPct as number)) : mark * (1 + (slPct as number))
    if (!(sl > 0) || !Number.isFinite(sl)) {
      // 做多时止损幅度 ≥ 100% ⇒ 止损价算成 0 或负数。这不是"止损很宽"，
      // 是**这个方向下不存在的价位**，必须说出来而不是落一个 0 上去。
      return { ok: false, reason: `SL_PRICE_INVALID（入场 ${mark} × (1 − ${slPct}) = ${sl}）` }
    }
    protection.stopLoss = sl
  }
  return { ok: true, protection }
}

/**
 * 一句话把保护说明白，**含它是不是真的挂上了**。
 *
 * ★ 「没挂上」必须能被念出来。沉默的后果不是少一个数，
 *   是用户以为设了保护、实际在裸跑 —— 而界面上看不出任何缺口。
 */
export function describeProtection(p: PositionProtection | undefined): string {
  if (!p) return '这道仓位没有任何保护单'
  const bits: string[] = []
  if (Number.isFinite(p.stopLoss) && (p.stopLoss as number) > 0) bits.push(`止损 ${(p.stopLoss as number).toFixed(2)}`)
  if (Number.isFinite(p.takeProfit) && (p.takeProfit as number) > 0) bits.push(`止盈 ${(p.takeProfit as number).toFixed(2)}`)
  if (bits.length === 0) return '保护单条目存在但两道都是空的（等于没有保护）'
  return bits.join(' · ')
}
