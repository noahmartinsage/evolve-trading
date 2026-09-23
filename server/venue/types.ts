/**
 * 随开仓单一起挂到**场所侧**的保护（止盈 / 止损）。
 *
 * ★★ 为什么必须是"随开仓单一起"，而不是"成交之后另下一张条件单" ────────
 * 本项目对实盘保护的红线是「实盘带保护一律拒绝（除非是场所侧条件单）」——
 * 理由写在本字段出现之前的 `submitLiveOrder` 里：本地巡检随进程存活，
 * 进程一停保护即失效而场所不知道。而**另下条件单**只解决了"场所知道"，
 * 没解决另一件同样致命的事：从开仓成交到条件单挂上之间有一小段
 * **真实的裸窗**（网络往返 + 场所撮合）。那一小段里，仓位是活的、保护是没有的，
 * 而账面上两份记录都"看起来正常"。
 * ⇒ 所以这个字段服务的是**可以原子附挂**的场所（OKX 的 `attachAlgoOrds`、
 *   本仓库的 sandbox 夹具）。做不到原子的适配器必须把
 *   `supportsVenueProtection` 报成 `false`，由上游**拒单**而不是凑合 ——
 *   见 `VenueAdapter.supportsVenueProtection`。
 *
 * ★ 两道各自可选：只设止损是合法诉求（也是本项目最常用的那一种）。
 *   价格的**正反方向**由调用方负责（`protection.buildProtection` 已经做过方向校验），
 *   适配器只负责把它们原样交给场所，不替任何人"猜一个合理价位"。
 */
export interface VenueProtection {
  takeProfitPrice?: number
  stopLossPrice?: number
}

export interface VenueIntent {
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  price?: number
  qty: number
  /** 杠杆倍数（以小博大）：>1 时使用全仓保证金，以持仓作为抵押物借币/借合约交易 */
  leverage?: number
  /**
   * 交易品种。缺省 SPOT（兼容既有调用方）。
   * - SPOT：现货（杠杆现货最高约 10x，达不到 125x）
   * - SWAP：永续合约（125x 只在此形态下存在）
   */
  instType?: 'SPOT' | 'SWAP'
  /**
   * 合约保证金结算方式（仅 instType='SWAP' 时有意义）：
   * - linear（U 本位）：BTC-USDT-SWAP，USDT 计价结算，盈亏线性
   * - inverse（币本位）：BTC-USD-SWAP，USD 计价、币结算，盈亏非线性
   */
  settle?: 'linear' | 'inverse'
  /** 场所侧保护。**只有 `supportsVenueProtection === true` 的适配器才允许收到它。** */
  protection?: VenueProtection
}

export interface VenueFill {
  fillId: string
  venueOrderId: string
  clientOrderId: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  ts: number
}

export interface VenuePosition {
  symbol: string
  qty: number
  avgPrice: number
}

export interface BalanceSnapshot {
  cash: number
  positions: VenuePosition[]
  totalFills: number
}

export interface VenueAdapter {
  readonly name: string
  /**
   * ★★ 这个场所能不能把止盈止损**原子地**随开仓单一起挂上。
   *
   * ── 为什么它是一个**必填**能力位，而不是一个可选方法 ────────────────
   * 它的消费者只有一个判断："能不能收 `VenueIntent.protection`"。
   * 做成可选方法（"有就调、没有就算了"）会得到一个静默的坏方向：
   * 适配器忘了实现 ⇒ 保护**没人挂** ⇒ 上游以为挂了 ⇒ 一张实盘裸仓。
   * 做成必填布尔，新增适配器时**编译期**就必须回答这个问题，
   * 而回答"能"是要付代价的（得真去实现，见 `VenueProtection` 那段注释）。
   *
   * ★ 报 `true` 的含义被刻意收窄成"**原子**附挂"：
   *   · OKX：`attachAlgoOrds` 随主单一起提交 ⇒ `true`；
   *   · sandbox：夹具里同一次 `place()` 内登记 ⇒ `true`；
   *   · 只能"成交后再另下一张条件单"的场所 ⇒ **必须报 `false`**，
   *     因为开仓成交到条件单挂上之间有一段真实的裸窗。
   *     报 false 的后果是上游**拒单并说明原因**，那是可接受的；
   *     报 true 而实际有窗口，后果是一张用户以为有保护、实际没有的实盘仓。
   */
  readonly supportsVenueProtection: boolean
  place(intent: VenueIntent): Promise<{ venueOrderId: string }>
  cancel(venueOrderId: string): Promise<boolean>
  onFill(cb: (f: VenueFill) => void): void
  reconcile(): Promise<BalanceSnapshot>
  openOrderIds(): string[] | Promise<string[]>
}
