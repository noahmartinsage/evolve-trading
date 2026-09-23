import type { BalanceSnapshot, VenueAdapter, VenueFill } from '../venue/types.ts'
import type { OrderIntentInput } from '../risk.ts'
import { beginIntent, makeIntentKey, settleIntent } from '../intentLedger.ts'

export interface GatewayStatus {
  adapterAttached: boolean
  adapterName: string
  handshakeComplete: boolean
  killswitch: boolean
  venueOutboundDisabledReason: string | null
  queued: number
  processedFills: number
  drainedDuplicates: number
}

/**
 * 当前挂着的场所**能做什么**。
 *
 * ★ 为什么要在 `status()` 之外单独一个方法：`status()` 是给人看的运行态面板，
 *   而这个是**给判断用的**（`submitLiveOrder` 读它决定"能不能带保护下实盘单"）。
 *   混进 `status()` 会让"改一个显示字段"与"改一条下单规则"变成同一处改动 ——
 *   而它们应该由不同的人在不知道对方的情况下分别改。
 * ★ 没挂适配器时 `venueProtection` 为 `false`：那是 fail-closed 的正确取值，
 *   不是"未知"。未知在别处已经由 `adapterAttached` 表达了。
 */
export interface VenueCapabilities {
  adapterName: string
  /** 能不能把止盈止损**原子地**随开仓单挂到场所侧。见 `VenueAdapter.supportsVenueProtection`。 */
  venueProtection: boolean
}

export interface GatewaySubmitResult {
  ok: boolean
  venueOrderId?: string
  reason?: string
}

type FillSink = (f: VenueFill) => void

const LIVE_MODE_REQUIRED = 'GATEWAY_ACCEPTS_LIVE_INTENTS_ONLY'

export class ExecutionGateway {
  private adapter: VenueAdapter | null = null
  private handshake = false
  private killswitchActive = false
  private venueStopReason: string | null = null
  /**
   * ★ 「本进程内见过的 clientOrderId」——**仅供观测，不再参与出网判定**。
   *
   * 出网幂等已改由 `server/intentLedger.ts` 的**持久化语义键**负责。
   * 这个 Set 保留下来是因为 `status()` 曾经对外暴露它、且它仍是个有用的
   * 单进程观测量（"本次启动以来发过多少不同 id"）。
   *
   * ★★ 读代码的人最容易在这里走神，所以把结论写死：
   *   **不要**再用它做去重判据。它有三个致命属性 ——
   *   ① 进程重启即空 ② 键是每次新生成的随机串 ③ 同毫秒会撞
   *   （实测碰撞率 0.040%）⇒ 漏挡真重复 + 误挡真订单，**两个方向都错**。
   *   详见 `intentLedger.ts` 顶部。
   */
  private seenClientIds = new Set<string>()
  private seenEconomicFills = new Set<string>()
  private processedFills = 0
  private drainedDuplicates = 0
  private fillSink: FillSink | null = null
  private queueDepth = 0

  attachAdapter(a: VenueAdapter): void {
    this.adapter = a
    a.onFill((f) => this.handleVenueFill(f))
  }

  completeRiskHandshake(): void {
    this.handshake = true
  }

  setKillswitch(active: boolean): void {
    this.killswitchActive = active
  }

  /** venue 级出站禁用（区别于全局 killswitch）：对账失配等场景自动触发，需人工清除 */
  setVenueOutboundDisabled(reason: string | null): void {
    this.venueStopReason = reason
  }

  setFillSink(sink: FillSink): void {
    this.fillSink = sink
  }

  status(): GatewayStatus {
    return {
      adapterAttached: this.adapter !== null,
      adapterName: this.adapter?.name ?? 'none',
      handshakeComplete: this.handshake,
      killswitch: this.killswitchActive,
      venueOutboundDisabledReason: this.venueStopReason,
      queued: this.queueDepth,
      processedFills: this.processedFills,
      drainedDuplicates: this.drainedDuplicates,
    }
  }

  venueCapabilities(): VenueCapabilities {
    return {
      adapterName: this.adapter?.name ?? 'none',
      venueProtection: this.adapter?.supportsVenueProtection === true,
    }
  }

  async submit(
    intent: OrderIntentInput & { mode?: string; bucket?: string },
  ): Promise<GatewaySubmitResult> {
    if (intent.mode !== 'live') return { ok: false, reason: LIVE_MODE_REQUIRED }
    if (!this.handshake) return { ok: false, reason: 'HANDSHAKE_INCOMPLETE' }
    if (!this.adapter) return { ok: false, reason: 'NO_ADAPTER_ATTACHED' }
    if (this.killswitchActive) return { ok: false, reason: 'KILLSWITCH_ACTIVE' }
    if (this.venueStopReason !== null) return { ok: false, reason: `VENUE_OUTBOUND_DISABLED:${this.venueStopReason}` }

    // ── ★★ 幂等：判据是**持久化的语义键**，不是内存里的随机 id ─────────────
    //
    // 改造前这里是 `this.seenClientIds.has(intent.clientOrderId)`。它挡不住真重复，
    // 因为 `clientOrderId` 由 `Date.now()+Math.random()` 每次新生成（`autopilot.ts:995`），
    // **同一个逻辑意图重走一遍必然得到新 id** ⇒ 查不到 ⇒ 放行。
    // 现在改判语义键（见 `server/intentLedger.ts` 顶部注释）。
    //
    // ★ `bucket` 缺省用 clientOrderId：这是**刻意保守**的降级 ——
    //   调用方没给业务桶时，退回"每次调用算一个新键"（等价于旧行为，不会误挡），
    //   同时让 `makeIntentKey` 的输入仍有确定形状。**但这样就失去了防重能力**，
    //   所以 live 主路径（`autopilot.ts`）必须显式传 bucket。
    const bucket = intent.bucket ?? intent.clientOrderId
    const intentKey = makeIntentKey({
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      qty: intent.qty,
      leverage: intent.leverage,
      instType: intent.instType,
      settle: intent.settle,
      bucket,
    })

    // 出网**之前**落账（write-ahead）。落账失败一律不出网（fail-closed）。
    const begin = beginIntent({
      intentKey,
      bucket,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
    })
    if (!begin.ok) {
      // ★ 三态分开报，因为**调用方该做的动作不同**（判据 13）：
      //   settled   → 这笔已经成了/已定局，别再发（应去读 venueOrderId）
      //   in_flight → 成没成不知道，**去对账**，不是"重发"
      //   两者都**不是** `DUPLICATE_CLIENT_ID`（那是"id 撞了"，两回事）
      if (begin.lookup.kind === 'settled') {
        return { ok: false, reason: `INTENT_ALREADY_SETTLED:${intentKey}` }
      }
      return { ok: false, reason: `INTENT_IN_FLIGHT_RECONCILE_REQUIRED:${intentKey}` }
    }

    this.queueDepth += 1
    try {
      const res = await this.adapter.place({
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        price: intent.price,
        qty: intent.qty,
        leverage: intent.leverage,
        // 品种形态必须一路透传：适配器靠它决定 instId 与下单量单位
        // （SPOT 的 sz 是币量、SWAP 的 sz 是张）。这里漏传不会报错，
        // 只会让一笔 125x 合约单以现货形态发出去 —— 场所会用一个
        // 与真因无关的理由拒掉（例如保证金不足），排查方向就此跑偏。
        instType: intent.instType,
        settle: intent.settle,
        // ★★ 场所侧保护（止盈/止损），**绝对价**。
        //   它一路从 `OrderIntentInput` 传到这里 —— 上一轮之前，这两个字段
        //   在 `OrderIntentInput` 里就存在，但**没有任何一层把它交给适配器**
        //   （`submitToBroker` 只传 5 个字段）。"解析对了、念回了、审计记了"
        //   而实际下一张裸单，正是本仓库付过代价的那一次。
        //   在这里**原样透传**，不判断"该不该有" —— 该不该由闸门答，
        //   能不能由 `supportsVenueProtection` 答，两者都不在这条线上。
        ...(intent.takeProfit === undefined && intent.stopLoss === undefined
          ? {}
          : {
              protection: {
                ...(intent.takeProfit === undefined ? {} : { takeProfitPrice: intent.takeProfit }),
                ...(intent.stopLoss === undefined ? {} : { stopLossPrice: intent.stopLoss }),
              },
            }),
      })
      // 出网**成功** ⇒ 定局。venueOrderId 落进台账，重启后仍可追溯。
      settleIntent({ intentKey, venueOrderId: res.venueOrderId, outcome: 'placed' })
      return { ok: true, venueOrderId: res.venueOrderId }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : String(e)
      // ★★ 出网**抛错**是**未知结果**，不是"没发出去"。
      //   网络超时/连接重置的常见形态是"场所其实已受理，只是回执没回来"。
      //   此时**故意不 settle**，让键留在 `in_flight`（= 未知），
      //   由 `recoverOrphans()` 报出来交给人/对账器去场所侧确认。
      //   ★ 反过来说：如果这里写了 `settleIntent({outcome:'failed'})`，
      //     崩溃/超时后的下一次同信号就会**再发一遍** —— 那才是真重复下单。
      //   ⇒ 只有场所**明确拒绝**（拿到确定性错误码）才允许定局为 failed。
      return { ok: false, reason: `VENUE_ERROR: ${msg}` }
    } finally {
      this.queueDepth -= 1
    }
  }

  async cancelAllAtVenue(): Promise<number> {
    if (!this.adapter) return 0
    let n = 0
    for (let round = 0; round < 20; round++) {
      const ids = await this.adapter.openOrderIds()
      if (ids.length === 0) break
      for (const id of ids) {
        if (await this.adapter.cancel(id)) n += 1
      }
    }
    const remaining = await this.adapter.openOrderIds()
    return remaining.length === 0 ? n : -1
  }

  /**
   * 复位网关的**运行时**状态。
   *
   * ★★ 这里**故意不再清去重台账**。改造前有 `this.seenClientIds.clear()`，
   *   但那个 Set 现在是**内存运行态**、且已不参与出网判定（判定走 `intentLedger`
   *   的持久化语义键）。台账是不可以被 reset 掉的：
   *   它记录的是"哪些意图已经出过网"这个**历史事实**，
   *   而 `reset()` 的语义是"把网关恢复到刚启动的样子"。
   *   若在这里清台账，就等于**给了调用方一条绕过幂等的后门** ——
   *   任何一次 reset 之后，崩溃前发过的单都会变成"从没发过"。
   *   ⇒ 需要清台账的场景（烟测）走 `intentLedger.__resetIntentLedgerForTest()`，
   *     并且那个函数**刻意不挂在任何端点上**，只供测试直接 import。
   */
  reset(): void {
    this.seenClientIds.clear()
    this.seenEconomicFills.clear()
    this.processedFills = 0
    this.drainedDuplicates = 0
    this.handshake = false
    this.killswitchActive = false
    this.venueStopReason = null
    this.queueDepth = 0
  }

  venueSnapshot(): Promise<BalanceSnapshot | null> {
    return this.adapter ? this.adapter.reconcile() : Promise.resolve(null)
  }

  handleVenueFill(f: VenueFill): void {
    const economicKey = `${f.venueOrderId}|${f.side}|${f.price}|${f.qty}`
    if (this.seenEconomicFills.has(economicKey)) {
      this.drainedDuplicates += 1
      return
    }
    this.seenEconomicFills.add(economicKey)
    this.processedFills += 1
    this.fillSink?.(f)
  }

  async reconcileAgainstVenue(): Promise<{ consistent: boolean; localFills: number; venueFills: number; missing: number }> {
    if (!this.adapter) return { consistent: true, localFills: 0, venueFills: 0, missing: 0 }
    const snap: BalanceSnapshot = await this.adapter.reconcile()
    const missing = snap.totalFills - this.processedFills - this.drainedDuplicates * 0
    return {
      consistent: missing === 0,
      localFills: this.processedFills,
      venueFills: snap.totalFills,
      missing,
    }
  }

  venueCash(): Promise<number> {
    return this.adapter ? this.adapter.reconcile().then((s) => s.cash) : Promise.resolve(Number.NaN)
  }
}

export const liveGateway = new ExecutionGateway()

