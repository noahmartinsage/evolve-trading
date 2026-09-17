/**
 * 跨通道清算义务账本 —— CEX / DEX 双通道的「统一结算」接缝层。
 *
 * ══ 为什么这一层是必须的 ═════════════════════════════════════════════
 * 2026-09 的六份情报里，同一个判断出现了六次，措辞几乎一致：
 *   「EVOLVE 的 CEX+DEX 双通道统一结算，本质就是支付互操作性瓶颈 ——
 *     这是决策大脑生产化最难的接缝处，应优先设计跨通道清算/对账层。」
 * 原因是结构性的：CEX 侧的账面是**账户余额**，DEX 侧的账面是**链上仓位**，
 * 两者的权威来源、更新延迟、失败语义、可撤销性都不同；
 * 而决策层需要在一个平面上比较「在 CEX 做」和「在 DEX 做」哪个更划算。
 * 中间没有一层显式的清算账，这个比较就只能靠心算，而心算出来的东西无法对账。
 *
 * ══ 本模块的核心不变量：资产口径必须先归一 ═════════════════════════
 * **`USDC@8453` 与 `USDC@cex` 不是同一个东西。**
 * 一个是 Base 链上的 ERC-20，一个是交易所账户里的记账单位。
 * 两者不能相加、不能轧差、不能相互抵扣 —— 要从 Base 的 USDC 变成
 * 交易所里的 USDC，必须**过一次桥**，过桥有成本、有延迟、有失败可能。
 * 把 `symbol` 当口径（「都是 USDC 嘛」）是本层最容易犯、也最难发现的错：
 * 数字看着都对，窟窿在跨链那一步。所以口径是 `(symbol, domain)` 二元组，
 * 而 `domain` 是 `chainId`（链上）或 `cex-account`（账户内），**永不相等**。
 *
 * ══ 三条账本语义（与 riskReservation 同一哲学） ═════════════════════
 *   ① **终态不可复活**：`settled` / `disputed` / `void` 是终态，不能再回到 `open`。
 *   ② **未知不自动清理**：长期未结只标记 `STALE_OPEN` 并告警，**不自动作废** ——
 *      「长期没结」不等于「不存在」，自动作废等于把真实敞口从账上抹掉。
 *   ③ **不复制交易事实**：每一条义务都必须带 `intentId` 指向预留台账。
 *      指不到就报 `ORPHAN_OBLIGATION`。义务是「衍生事实」，权威仍在账本与审计链里。
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './atomicWrite.ts'
import { SETTLEMENT_STALE_HOURS, SETTLEMENT_TOLERANCE_BPS } from './riskConstants.ts'

export type SettlementState = 'open' | 'settling' | 'settled' | 'disputed' | 'void'

/** 结算终态：一旦进入即不可回退（见文件头语义 ①）。 */
export const TERMINAL_SETTLEMENT_STATES: ReadonlySet<SettlementState> = new Set<SettlementState>([
  'settled',
  'disputed',
  'void',
])

/** 未结状态：仍占用「待清算」敞口。 */
export const OPEN_SETTLEMENT_STATES: ReadonlySet<SettlementState> = new Set<SettlementState>(['open', 'settling'])

/**
 * 资产口径。`chainId === null` 表示**场所内部记账单位**（CEX 账户里的余额），
 * 它和任何链上的同符号代币都不是同一个资产。
 */
export interface AssetKey {
  symbol: string
  chainId: number | null
}

export interface SettlementObligation {
  id: string
  /** 指向风险预算预留台账的意图 id。指不到即判孤儿义务。 */
  intentId: string
  counterpartyId: string
  environment: 'paper' | 'live'
  asset: AssetKey
  direction: 'receive' | 'deliver'
  /** 对账口径：USDT 等值。用于与预留台账比对。 */
  amountUsdt: number
  /** 资产口径：以 `asset` 计价的数量。用于跨所轧差。 */
  amountAsset: number
  /** 预估结算成本（USDT）。结算完成后与实值比对，回填到对手方声誉。 */
  estimatedCostUsdt: number
  state: SettlementState
  note: string
  createdAt: string
  updatedAt: string
  settledAt: string | null
  settledAmountUsdt: number | null
}

/** 资产口径的规范键。这是本层的「指纹」——不同键永不合并。 */
export function assetKeyOf(a: AssetKey): string {
  return `${a.symbol}@${a.chainId === null ? 'cex' : a.chainId}`
}

/**
 * 结算域：能否相互轧差的判据。
 * 同域才可轧差；跨域必须显式过桥，且要计入桥费与延迟。
 */
export function settlementDomainOf(asset: AssetKey): string {
  return asset.chainId === null ? 'cex-account' : `chain:${asset.chainId}`
}

export function canNet(a: AssetKey, b: AssetKey): boolean {
  return a.symbol === b.symbol && a.chainId === b.chainId
}

export interface NettingLine {
  counterpartyId: string
  /** 净额：正 = 我们应收，负 = 我们应付。 */
  net: number
}

export interface NettingGroup {
  assetKey: string
  symbol: string
  domain: string
  lines: NettingLine[]
  /** 该资产口径下的总应收 / 总应付（跨对手方）。 */
  totalReceive: number
  totalDeliver: number
  /** 组内净额合计。同域内可为 0（完全内部抵消）。 */
  netTotal: number
  /** 该组是否能通过内部轧差清零（同域且净额为 0 即无需任何转移）。 */
  selfClearing: boolean
}

export interface CrossDomainNote {
  symbol: string
  /**
   * 域对的标识（无序对，同一对只出现一次）。
   *
   * ⚠️ `from`/`to` 只是**这一对域的命名**，不是「资金应该从 from 流向 to」的方向主张。
   * 两侧可能都是净交付 —— 那时根本没有一个可执行的流向，
   * 而提示项要表达的是「这两个是同名不同资产，别把它们加起来」。
   */
  from: string
  to: string
  /** 朴素净额会错误抵消掉的规模 = 两侧净额绝对值的较小者。 */
  amount: number
  reason: string
}

export interface NettingReport {
  environment: string
  groups: NettingGroup[]
  /**
   * 跨域同符号资产：看起来「同币」，实际需要过桥才能互相抵扣。
   * 这一项刻意**不并入**净额，而是单独列出来 ——
   * 悄悄合并就等于把桥费与桥风险当 0。
   */
  crossDomain: CrossDomainNote[]
  /** 仍需真实转移的总量（USDT 等值）：不为 0 就说明还有结算动作要发生。 */
  outstandingTransferUsdt: number
}

export type MismatchKind = 'ORPHAN_OBLIGATION' | 'MISSING_OBLIGATION' | 'AMOUNT_DRIFT' | 'STALE_OPEN'

export interface MismatchFinding {
  kind: MismatchKind
  severity: 'info' | 'warn' | 'error'
  obligationId?: string
  intentId?: string
  amountUsdt?: number
  /** 中文完整句，可直接呈现给操作者。 */
  reason: string
}

export interface ReconcileReport {
  environment: string
  checked: number
  consistent: boolean
  findings: MismatchFinding[]
  toleranceBps: number
  staleHours: number
}

interface Stored {
  format: string
  version: number
  obligations: SettlementObligation[]
}

export class SettlementLedger {
  private readonly path: string
  private obligations = new Map<string, SettlementObligation>()
  /** intentId → obligationId 索引：保证同一意图不产生第二条义务（幂等）。 */
  private byIntent = new Map<string, string>()

  constructor(path: string) {
    this.path = path
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored>
      for (const o of raw.obligations ?? []) {
        if (!o?.id) continue
        this.obligations.set(o.id, o)
        this.byIntent.set(o.intentId, o.id)
      }
    } catch {
      // 账本解析失败时**保持空账**并让上层看到「零义务」——
      // 这里绝不能「尽力恢复一部分」，半截账本比空账本更危险：
      // 它会让人以为对账通过了。
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, {
      format: 'evolve.settlement-ledger',
      version: 1,
      obligations: [...this.obligations.values()],
    } satisfies Stored)
  }

  list(environment?: string): SettlementObligation[] {
    return [...this.obligations.values()]
      .filter((o) => environment === undefined || o.environment === environment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): SettlementObligation | null {
    return this.obligations.get(id) ?? null
  }

  getByIntent(intentId: string): SettlementObligation | null {
    const id = this.byIntent.get(intentId)
    return id ? (this.obligations.get(id) ?? null) : null
  }

  /**
   * 开立一条结算义务。
   *
   * **按 `intentId` 幂等**：同一笔意图重复开立不会产生第二条义务。
   * 不幂等的话，一次网络重试就会把同一笔敞口记成两笔，
   * 而两笔义务在任何净额视图里看起来都是「合理的」—— 这种错无法靠肉眼发现。
   */
  openObligation(input: {
    intentId: string
    counterpartyId: string
    environment: 'paper' | 'live'
    asset: AssetKey
    direction: 'receive' | 'deliver'
    amountUsdt: number
    amountAsset?: number
    estimatedCostUsdt?: number
    note?: string
    now?: Date
  }): { ok: boolean; obligation: SettlementObligation | null; idempotent: boolean; reason: string } {
    const existing = this.getByIntent(input.intentId)
    if (existing) {
      return {
        ok: true,
        obligation: existing,
        idempotent: true,
        reason: `意图 ${input.intentId} 已有义务 ${existing.id}（状态 ${existing.state}），未重复开立。`,
      }
    }
    if (!Number.isFinite(input.amountUsdt) || input.amountUsdt <= 0) {
      return { ok: false, obligation: null, idempotent: false, reason: `义务金额非法（${input.amountUsdt}）：不接受非正数金额。` }
    }

    const now = input.now ?? new Date()
    const iso = now.toISOString()
    const ob: SettlementObligation = {
      id: `stl-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      intentId: input.intentId,
      counterpartyId: input.counterpartyId,
      environment: input.environment,
      asset: input.asset,
      direction: input.direction,
      amountUsdt: input.amountUsdt,
      amountAsset: input.amountAsset ?? input.amountUsdt,
      estimatedCostUsdt: Math.max(input.estimatedCostUsdt ?? 0, 0),
      state: 'open',
      note: input.note ?? '',
      createdAt: iso,
      updatedAt: iso,
      settledAt: null,
      settledAmountUsdt: null,
    }
    this.obligations.set(ob.id, ob)
    this.byIntent.set(ob.intentId, ob.id)
    this.persist()
    return { ok: true, obligation: ob, idempotent: false, reason: `已开立结算义务 ${ob.id}（${assetKeyOf(ob.asset)}，${ob.direction} ${ob.amountUsdt} USDT 等值）。` }
  }

  /**
   * 推进状态。
   *
   * **终态不可复活**：`settled` / `disputed` / `void` 之后任何写入都被拒绝。
   * 这一条防的是「对账发现差异后，把已结的义务改回未结来自圆其说」——
   * 那会让账本失去作为证据的资格。
   *
   * `void` 必须带 note：作废一条义务是**有后果的动作**，必须留下为什么。
   */
  advance(
    id: string,
    state: SettlementState,
    patch: { settledAmountUsdt?: number; note?: string; now?: Date } = {},
  ): { ok: boolean; obligation: SettlementObligation | null; reason: string } {
    const ob = this.obligations.get(id)
    if (!ob) return { ok: false, obligation: null, reason: `结算义务 ${id} 不存在。` }

    if (TERMINAL_SETTLEMENT_STATES.has(ob.state)) {
      return {
        ok: false,
        obligation: ob,
        reason: `义务 ${id} 已处于终态 ${ob.state}，不接受回退或改写（终态不可复活）。如需修正，请另开一条新义务并在 note 中引用本条。`,
      }
    }
    if (state === 'void' && !patch.note) {
      return { ok: false, obligation: ob, reason: '作废义务必须给出理由（note）——作废会改变敞口视图，不能静默执行。' }
    }

    const now = patch.now ?? new Date()
    ob.state = state
    ob.updatedAt = now.toISOString()
    if (patch.note) ob.note = ob.note ? `${ob.note} | ${patch.note}` : patch.note
    if (state === 'settled') {
      ob.settledAt = now.toISOString()
      ob.settledAmountUsdt = patch.settledAmountUsdt ?? ob.amountUsdt
    }
    this.persist()
    return { ok: true, obligation: ob, reason: `义务 ${id} 状态 → ${state}。` }
  }

  /**
   * 跨所净额。**按 `(symbol, domain)` 分组** —— 不同域的同符号资产不合并。
   */
  netting(environment = 'paper'): NettingReport {
    const open = this.list(environment).filter((o) => OPEN_SETTLEMENT_STATES.has(o.state))
    const groups = new Map<string, SettlementObligation[]>()
    for (const o of open) {
      const k = assetKeyOf(o.asset)
      const arr = groups.get(k)
      if (arr) arr.push(o)
      else groups.set(k, [o])
    }

    const out: NettingGroup[] = []
    for (const [assetKey, list] of groups) {
      const byCp = new Map<string, number>()
      for (const o of list) {
        const signed = o.direction === 'receive' ? o.amountAsset : -o.amountAsset
        byCp.set(o.counterpartyId, (byCp.get(o.counterpartyId) ?? 0) + signed)
      }
      const lines: NettingLine[] = [...byCp.entries()].map(([counterpartyId, net]) => ({ counterpartyId, net: round(net) }))
      const totalReceive = round(list.filter((o) => o.direction === 'receive').reduce((a, o) => a + o.amountAsset, 0))
      const totalDeliver = round(list.filter((o) => o.direction === 'deliver').reduce((a, o) => a + o.amountAsset, 0))
      const netTotal = round(totalReceive - totalDeliver)
      out.push({
        assetKey,
        symbol: list[0].asset.symbol,
        domain: settlementDomainOf(list[0].asset),
        lines,
        totalReceive,
        totalDeliver,
        netTotal,
        // 同域内净额为 0 ⇒ 无需任何真实转移，纯粹的内部抵扣。
        selfClearing: Math.abs(netTotal) < 1e-9,
      })
    }

    // 跨域提示：同 symbol 但不同 domain。刻意不并入净额。
    const crossDomain: CrossDomainNote[] = []
    const bySymbol = new Map<string, NettingGroup[]>()
    for (const g of out) {
      const arr = bySymbol.get(g.symbol)
      if (arr) arr.push(g)
      else bySymbol.set(g.symbol, [g])
    }
    for (const [symbol, gs] of bySymbol) {
      if (gs.length < 2) continue
      // 只枚举**无序对**（i<j）。此前写成全交叉双层循环，会把同一对域报两次
      // （a→b 与 b→a），提示项翻倍。数量虚高的告警最终会没人看——
      // 「告警太多」和「没有告警」在效果上是同一件事。
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const a = gs[i]
          const b = gs[j]
          if (a.domain === b.domain) continue
          // 金额 = 两侧净额绝对值的**较小者**：这才是「朴素净额会错误抵消掉多少」。
          // 用较大者会把「本来就没打算抵消的那部分」也算成风险敞口，让金额系统性偏大。
          //
          // 不能用「取正数那一侧」：当两侧都是净交付（netTotal 同为负）时，
          // 那样写会让整条提示被 `amount <= 0` 静默过滤掉 ——
          // 而「两个域同时欠着同一种资产」恰恰是最需要被看见的情形。
          const amount = round(Math.min(Math.abs(a.netTotal), Math.abs(b.netTotal)))
          if (amount <= 1e-9) continue
          crossDomain.push({
            symbol,
            from: a.domain,
            to: b.domain,
            amount,
            reason:
              `${symbol} 在 ${a.domain} 与 ${b.domain} 是**两个不同资产**，不能相互抵扣` +
              `（若朴素合并会错误抵消约 ${amount}）。` +
              '要真正轧平需过一次桥，桥费、延迟与失败风险都要计入——把它当 0 就会低估结算成本。',
          })
        }
      }
    }

    const outstandingTransferUsdt = round(out.reduce((a, g) => a + Math.abs(g.netTotal), 0))
    return { environment, groups: out, crossDomain, outstandingTransferUsdt }
  }

  /**
   * 与预留台账对账。
   *
   * 输入是**已平仓意图**的清单（来自风险预算预留台账）。
   * 四类差异各自成条，全部只报告不自动修 —— 「自动抹平差异」是对账层最危险的功能，
   * 因为它会把「两套账不一致」这个事实本身擦掉。
   */
  reconcile(
    environment: string,
    closedIntents: { intentId: string; amountUsdt: number }[],
    now: Date = new Date(),
  ): ReconcileReport {
    const findings: MismatchFinding[] = []
    const known = new Set(closedIntents.map((c) => c.intentId))
    const mine = this.list(environment)
    const tolerance = SETTLEMENT_TOLERANCE_BPS / 10_000

    for (const o of mine) {
      if (!known.has(o.intentId)) {
        findings.push({
          kind: 'ORPHAN_OBLIGATION',
          severity: 'warn',
          obligationId: o.id,
          intentId: o.intentId,
          amountUsdt: o.amountUsdt,
          reason:
            `义务 ${o.id} 指向的意图 ${o.intentId} 在预留台账中找不到对应记录。` +
            '可能是预留记录被清理、或义务被重复开立——两种成因的处置不同，所以只标记不自动处理。',
        })
        continue
      }
      const ref = closedIntents.find((c) => c.intentId === o.intentId)
      if (ref && ref.amountUsdt > 0) {
        const drift = Math.abs(o.amountUsdt - ref.amountUsdt) / ref.amountUsdt
        if (drift > tolerance) {
          findings.push({
            kind: 'AMOUNT_DRIFT',
            severity: 'error',
            obligationId: o.id,
            intentId: o.intentId,
            amountUsdt: o.amountUsdt,
            reason:
              `义务金额 ${o.amountUsdt} 与预留金额 ${ref.amountUsdt} 相差 ${(drift * 100).toFixed(3)}%，` +
              `超出容差 ${(tolerance * 100).toFixed(3)}%。两个数字都「看起来合理」，这正是最难发现的差异。`,
          })
        }
      }
      if (OPEN_SETTLEMENT_STATES.has(o.state)) {
        const ageH = (now.getTime() - new Date(o.createdAt).getTime()) / 3_600_000
        if (ageH > SETTLEMENT_STALE_HOURS) {
          findings.push({
            kind: 'STALE_OPEN',
            severity: 'warn',
            obligationId: o.id,
            intentId: o.intentId,
            amountUsdt: o.amountUsdt,
            reason:
              `义务已挂 ${ageH.toFixed(1)} 小时仍未结（阈值 ${SETTLEMENT_STALE_HOURS}h）。` +
              '只告警不作废——「长期没结」不等于「不存在」，自动作废会把真实敞口从账上抹掉。',
          })
        }
      }
    }

    // 反向：已平仓意图却没有义务 → 敞口漏记
    const obligationIntents = new Set(mine.map((o) => o.intentId))
    for (const c of closedIntents) {
      if (!obligationIntents.has(c.intentId)) {
        findings.push({
          kind: 'MISSING_OBLIGATION',
          severity: 'error',
          intentId: c.intentId,
          amountUsdt: c.amountUsdt,
          reason:
            `预留 ${c.intentId}（${c.amountUsdt} USDT）已平仓却没有对应结算义务。` +
            '这是敞口漏记：钱已经动了，账上却没有「谁欠谁多少」这一条。',
        })
      }
    }

    return {
      environment,
      checked: mine.length,
      consistent: findings.length === 0,
      findings,
      toleranceBps: SETTLEMENT_TOLERANCE_BPS,
      staleHours: SETTLEMENT_STALE_HOURS,
    }
  }

  /** 汇总视图，供面板展示。 */
  summary(environment = 'paper'): {
    environment: string
    open: number
    settled: number
    disputed: number
    voided: number
    openAmountUsdt: number
    assets: string[]
  } {
    const list = this.list(environment)
    const open = list.filter((o) => OPEN_SETTLEMENT_STATES.has(o.state))
    return {
      environment,
      open: open.length,
      settled: list.filter((o) => o.state === 'settled').length,
      disputed: list.filter((o) => o.state === 'disputed').length,
      voided: list.filter((o) => o.state === 'void').length,
      openAmountUsdt: round(open.reduce((a, o) => a + o.amountUsdt, 0)),
      assets: [...new Set(list.map((o) => assetKeyOf(o.asset)))].sort(),
    }
  }
}

function round(v: number, d = 6): number {
  const m = Math.pow(10, d)
  return Math.round(v * m) / m
}

// ─────────────────────────────────────────────────────────────
// 进程级单例
// ─────────────────────────────────────────────────────────────

let singleton: SettlementLedger | null = null

export function getSettlementLedger(): SettlementLedger {
  if (!singleton) {
    singleton = new SettlementLedger(process.env.EV_SETTLEMENT_DB ?? 'data/settlement_ledger.json')
  }
  return singleton
}

export function setSettlementLedger(l: SettlementLedger | null): void {
  singleton = l
}
