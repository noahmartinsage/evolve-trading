import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'
import { protectionTrigger, type ProtectionTrigger } from '../protection.ts'

export type SandboxFault = 'REJECT_ONCE' | 'DROP_NEXT_FILL' | 'DUPLICATE_NEXT_FILL'

interface SandboxOrder {
  venueOrderId: string
  intent: VenueIntent
  filledQty: number
  cancelled: boolean
}

/**
 * 场所侧条件单（止盈 / 止损）。
 *
 * ★ 它复刻的是**真实场所**的语义，不是"本地巡检"：一旦登记，它就活在场所那一侧，
 *   与本地进程存不存在无关。夹具要能测出这条差别，否则"实盘的保护必须挂到场所"
 *   这条红线在测试里没有任何观测点。
 *
 * ★★ 触发判据**复用** `protectionTrigger`（`server/protection.ts`）——
 *   那是本仓库"这道保护碰到了没有"的唯一主人。这里再写一份比较，
 *   就会出现"夹具说触发了、生产说没触发"这种只在测试里出现的分歧。
 */
export interface SandboxConditional {
  id: string
  symbol: string
  /** 触发后要执行的平仓方向（与开仓相反）。 */
  closeSide: 'buy' | 'sell'
  /** 开仓方向。止盈/止损谁在上谁在下由它决定，判据不许在别处再来一遍。 */
  posSide: 'long' | 'short'
  takeProfit?: number
  stopLoss?: number
  attachedAt: number
  triggered: boolean
  /**
   * 触发它的**是**哪一道（`stop-loss` / `take-profit`）。未触发时 `undefined`。
   *
   * ★ 为什么必须记下来：`protectionTrigger` 刻意让**止损优先于止盈**（见它的注释：
   *   跳空同时穿过两道时，真实成交只会落在不利那一侧）。所以"触发了"这三个字
   *   在"先判止盈"这种改法下**依然是绿的** —— 而那等于把一次止损离场
   *   记成一次落袋为安，指向相反的动作。记下是哪一道，这条顺序才可断言。
   */
  triggerKind?: ProtectionTrigger
  /** 被撤单（与"已触发"是两件事：`openOrderIds` 两者都要排除，但含义不同）。 */
  cancelled: boolean
  /** 触发时最多平掉多少（币量）。 */
  qty: number
}

export class SandboxAdapter implements VenueAdapter {
  readonly name = 'sandbox'
  /**
   * ★ sandbox 报 `true` 是**名副其实**的：同一次 `place()` 里就把条件单登记进
   *   `conditionals`，与真实场所的"原子附挂"形状一致 —— 不存在
   *   "成交了但保护还没挂上"的那一段窗口。
   */
  readonly supportsVenueProtection = true
  private seq = 0
  private orders = new Map<string, SandboxOrder>()
  private conditionals = new Map<string, SandboxConditional>()
  private fillListeners: ((f: VenueFill) => void)[] = []
  private faults: SandboxFault[] = []
  private cash = 100_000
  private positions = new Map<string, { qty: number; avgPrice: number }>()
  private totalFills = 0
  private triggeredConditionals = 0

  injectFault(f: SandboxFault): void {
    this.faults.push(f)
  }

  async place(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    if (this.faults[0] === 'REJECT_ONCE') {
      this.faults.shift()
      throw new Error('SANDBOX_INJECTED_REJECT')
    }
    if (intent.protection !== undefined && !this.supportsVenueProtection) {
      // 能力位与实际行为必须一致 —— 不一致时宁可当场崩，也不要静默把保护丢掉。
      throw new Error('SANDBOX_PROTECTION_UNSUPPORTED')
    }
    this.seq += 1
    const venueOrderId = `V${this.seq.toString(36).padStart(5, '0')}`
    this.orders.set(venueOrderId, { venueOrderId, intent, filledQty: 0, cancelled: false })
    if (intent.type === 'market') {
      const px = (intent.price ?? 100) * (intent.side === 'buy' ? 1.0005 : 0.9995)
      this.emitFill(this.orders.get(venueOrderId) as SandboxOrder, px)
      const o = this.orders.get(venueOrderId) as SandboxOrder
      o.cancelled = true
    }
    // ★ 条件单在**同一次调用里**登记（原子附挂的夹具形态）。
    const p = intent.protection
    if (p && (Number.isFinite(p.takeProfitPrice) || Number.isFinite(p.stopLossPrice))) {
      this.conditionals.set(`${venueOrderId}-P`, {
        id: `${venueOrderId}-P`,
        symbol: intent.symbol,
        closeSide: intent.side === 'buy' ? 'sell' : 'buy',
        posSide: intent.side === 'buy' ? 'long' : 'short',
        ...(p.takeProfitPrice === undefined ? {} : { takeProfit: p.takeProfitPrice }),
        ...(p.stopLossPrice === undefined ? {} : { stopLoss: p.stopLossPrice }),
        attachedAt: Date.now(),
        triggered: false,
        cancelled: false,
        qty: intent.qty,
      })
    }
    return { venueOrderId }
  }

  /** 未触发、未撤掉的条件单数量 —— 它是"这仓位到底有没有场所侧保护"的观测点。 */
  openConditionalCount(): number {
    let n = 0
    for (const c of this.conditionals.values()) if (!c.triggered && !c.cancelled) n += 1
    return n
  }

  /**
   * 条件单的**只读快照** —— 供门禁断言"保护价真的按原值到了场所"。
   *
   * ★ 为什么光看 `openConditionalCount() === 1` 不够（判据 B2）：
   *   止盈与止损**被对调**时，数量仍然是 1、触发仍然是"触发了"，
   *   而后果完全相反 —— 该止损离场的仓位会在止盈价上被平掉。
   *   要断"起作用了"而不是"出现过"，就得看得见它拿的是**哪个价**。
   *
   * ★ 它**只读**：返回的是副本。夹具给出写入接口的后果是，
   *   断言会在"夹具被改坏了"这种情形下反而变绿。
   */
  conditionalSnapshot(): SandboxConditional[] {
    return [...this.conditionals.values()].map((c) => ({ ...c }))
  }

  triggeredConditionalCount(): number {
    return this.triggeredConditionals
  }

  async cancel(venueOrderId: string): Promise<boolean> {
    // ★ 条件单的 id 形如 `<主单id>-P`，与普通挂单分开处理：
    //   撤条件单是"保护被取消"，撤主单是"这笔交易取消" —— 两种撤单的后果不同，
    //   合成一条分支会让"保护还在不在"在账面上看不出来。
    const c = this.conditionals.get(venueOrderId)
    if (c) {
      if (c.triggered || c.cancelled) return false
      c.cancelled = true
      return true
    }
    const o = this.orders.get(venueOrderId)
    if (!o || o.cancelled) return false
    o.cancelled = true
    return true
  }

  onFill(cb: (f: VenueFill) => void): void {
    this.fillListeners.push(cb)
  }

  openOrderCount(): number {
    return this.openOrderIds().length
  }

  openOrderIds(): string[] {
    const out: string[] = []
    for (const o of this.orders.values()) {
      if (!o.cancelled && o.filledQty < o.intent.qty) out.push(o.venueOrderId)
    }
    // ★ 未触发的条件单**也是场所侧的挂单** —— 对账时看不到它们，
    //   会得出"场所没有挂单、本地却有保护"的错误结论（判据 C2：两个数的口径必须一致）。
    for (const c of this.conditionals.values()) if (!c.triggered && !c.cancelled) out.push(c.id)
    return out
  }

  async reconcile(): Promise<BalanceSnapshot> {
    return {
      cash: Math.round(this.cash * 100) / 100,
      positions: [...this.positions.entries()].map(([symbol, p]) => ({
        symbol,
        qty: Math.round(p.qty * 1e8) / 1e8,
        avgPrice: Math.round(p.avgPrice * 1e6) / 1e6,
      })),
      totalFills: this.totalFills,
    }
  }

  ingestTick(symbol: string, price: number): void {
    for (const o of this.orders.values()) {
      if (o.cancelled || o.intent.symbol !== symbol || o.intent.type !== 'limit') continue
      const limitPx = o.intent.price ?? 0
      const crossed = o.intent.side === 'buy' ? price <= limitPx : price >= limitPx
      if (!crossed || o.filledQty >= o.intent.qty) continue
      this.emitFill(o, limitPx)
      if (o.filledQty >= o.intent.qty) o.cancelled = true
    }
    // ── 场所侧条件单 ─────────────────────────────────────────────────
    // ★ 判据交给 `protectionTrigger`（唯一主人），这里只负责"触发之后怎么成交"。
    for (const c of this.conditionals.values()) {
      if (c.triggered || c.cancelled || c.symbol !== symbol) continue
      const hit = protectionTrigger(
        {
          ...(c.takeProfit === undefined ? {} : { takeProfit: c.takeProfit }),
          ...(c.stopLoss === undefined ? {} : { stopLoss: c.stopLoss }),
          side: c.posSide,
          attachedAt: c.attachedAt,
          origin: 'sandbox',
        },
        price,
      )
      if (hit !== null) this.fireConditional(c, price, hit)
    }
  }

  /**
   * 条件单被穿过 ⇒ 以触发价成交平仓。
   *
   * ★ 刻意**不走 `emitFill`**（那里带故障注入）：`DROP_NEXT_FILL` 建模的是
   *   "开仓成交回执丢了"，把它套在保护成交上会让夹具造出"价格穿过了止损
   *   而仓位还在"的形态 —— 那个形态在真实场所不成立（触发即成交），
   *   在夹具里成立只会让测试断言依赖一个不真实的假设（判据 D9）。
   */
  private fireConditional(c: SandboxConditional, price: number, kind: ProtectionTrigger): void {
    c.triggered = true
    c.triggerKind = kind
    this.triggeredConditionals += 1
    const pos = this.positions.get(c.symbol)
    // ★ 取**绝对值**：空头持仓是负数，`Math.min(c.qty, -2)` 恒为负 ⇒ 走到下面
    //   `!(qty > 0)` 直接 return —— 表现是"做空的保护触发了但仓位没被平掉"，
    //   而 `triggeredConditionalCount()` 照样加一，账面看起来完全正常。
    const qty = Math.min(c.qty, Math.abs(pos?.qty ?? 0))
    if (!(qty > 0)) return
    const px = Math.round(price * 1e4) / 1e4
    this.totalFills += 1
    this.applyAccounting(c.closeSide, c.symbol, px, qty)
    const fill: VenueFill = {
      fillId: `${c.id}-F${this.totalFills}`,
      venueOrderId: c.id,
      clientOrderId: '',
      symbol: c.symbol,
      side: c.closeSide,
      price: px,
      qty,
      ts: Date.now(),
    }
    for (const cb of this.fillListeners) cb(fill)
  }

  private emitFill(o: SandboxOrder, price: number): void {
    const remaining = o.intent.qty - o.filledQty
    if (remaining <= 1e-12) return
    const px = Math.round(price * 1e4) / 1e4

    this.totalFills += 1
    o.filledQty += remaining
    this.applyAccounting(o.intent.side, o.intent.symbol, px, remaining)

    const base: VenueFill = {
      fillId: `${o.venueOrderId}-F${this.totalFills}`,
      venueOrderId: o.venueOrderId,
      clientOrderId: o.intent.clientOrderId,
      symbol: o.intent.symbol,
      side: o.intent.side,
      price: px,
      qty: remaining,
      ts: Date.now(),
    }

    if (this.faults[0] === 'DROP_NEXT_FILL') {
      this.faults.shift()
      return
    }

    for (const cb of this.fillListeners) cb(base)

    if (this.faults[0] === 'DUPLICATE_NEXT_FILL') {
      this.faults.shift()
      for (const cb of this.fillListeners) cb({ ...base, fillId: `${base.fillId}-dup` })
    }
  }

  /**
   * 记账（现金 + 持仓）。**持仓允许为负**（= 空头）。
   *
   * ★★ 为什么这一句必须成立 ────────────────────────────────────────────
   * 改造前 `sell` 分支只会"缩已有持仓"，没有持仓时**什么都不做** ⇒
   * 夹具里**根本造不出空头仓位**。后果不是"少测一个场景"，而是
   * 「做空的场所侧保护」这一整条路径**没有任何观测点** —— 而它的
   * `closeSide` 恰恰与做多相反（`place()` 里 `side === 'buy' ? 'sell' : 'buy'`）。
   * 那一行写反了不会有任何断言变红，只会在真实场所里
   * **把平仓单下成开仓单**（仓位翻倍，而且看起来"保护执行了"）。
   * 判据 D9：夹具要造生产的形状，不是我以为的形状。
   */
  private applyAccounting(side: 'buy' | 'sell', symbol: string, price: number, qty: number): void {
    const notional = price * qty
    if (side === 'buy') this.cash -= notional
    else this.cash += notional

    const signed = side === 'buy' ? qty : -qty
    const pos = this.positions.get(symbol)
    const cur = pos?.qty ?? 0
    const next = cur + signed
    if (Math.abs(next) <= 1e-9) {
      // 正好平完：删掉条目，别留一个 0 持仓让 `reconcile()` 报出幽灵品种。
      this.positions.delete(symbol)
      return
    }
    if (Math.abs(cur) <= 1e-9) {
      // 从零建仓（含开空）。
      this.positions.set(symbol, { qty: next, avgPrice: price })
      return
    }
    if (Math.sign(cur) === Math.sign(next)) {
      if (Math.abs(next) > Math.abs(cur)) {
        // 同向加仓：加权均价。
        const base = (pos?.avgPrice ?? price) * Math.abs(cur)
        this.positions.set(symbol, { qty: next, avgPrice: (base + price * Math.abs(signed)) / Math.abs(next) })
      } else if (pos) {
        // 同向减仓：**均价不变**（改它会顺手改掉一笔它没参与过的成本基准）。
        pos.qty = next
      }
      return
    }
    // 反手（穿过 0）：新仓的均价就是本次成交价。
    this.positions.set(symbol, { qty: next, avgPrice: price })
  }
}
