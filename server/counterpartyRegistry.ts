/**
 * 对手方信任注册表 —— 身份 / 声誉 / 验证 三层。
 *
 * ══ 它解决什么问题 ═══════════════════════════════════════════════════
 * 双通道决策最难的不是「能不能下单」，而是「该不该跟这个对手方结算」。
 * 2026-09 的情报把这件事讲得很直白：
 *   - ERC-8004（身份+声誉+验证三注册表）已上主网，说明**信任需要被结构化**；
 *   - TRM Labs 的链上实测指出，agent 支付的缺口不是「能付」，
 *     而是「**准确的注册、agent 可自行核查的对手方声誉、为量而非额设计的监控**」。
 * EVOLVE 此前对「对手方」的全部认知，就是硬编码在代码里的几个 venue 名字。
 * 本模块把它们变成**可查询、可累积、可裁决**的记录。
 *
 * ══ 一条不能违反的语义 ═══════════════════════════════════════════════
 * **「没有数据」不等于「中等偏好」。**
 * 本类系统最典型的错误是把未知填成一个看起来中性的数（例如声誉 0.5），
 * 于是「我们从未与这个对手方结算过」被静默地读成「它和我们结算过一半成功」。
 * 这里的处置是：`samples === 0` 时 `score` 为 **null**（不是 0、也不是 0.5），
 * 裁决走独立的 `UNPROVEN` 分支 —— 允许敞口但**减半**。
 * 减半而不是清零，是因为清零会让新人永远无法积累信用；
 * 减半而不是全额，是因为无据可依时不该按满额度下注。
 *
 * ══ 声誉从哪来 ═══════════════════════════════════════════════════════
 * **只从本项目自己的结算史派生**，不采信任何自报数据、不联网拉评分。
 * 三个观测量：
 *   ① `settlementRate`      结算成功率（失败与回执缺失都算失败）
 *   ② `costRealizationRatio` 实现成本 ÷ 预估成本（>1 = 我们系统性低估了这个通道的成本）
 *   ③ `incidents`           事故次数（对账不一致 / 回执缺失 / 被拒）
 * 第二条尤其重要：它把 `costModel` 的**假设**接上了**现实**。
 * 成本模型给出预估，结算史回头检验它 —— 一个闭环，而不是两套口径。
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './atomicWrite.ts'
import { COUNTERPARTY_MIN_REPUTATION, UNPROVEN_SIZE_MULTIPLIER } from './riskConstants.ts'
import { contractsByChain } from '../src/dex/uniswap.ts'

export type Channel = 'cex' | 'dex'

/** 验证状态。三档，不是布尔 —— 「没核验过」与「核验后判定有问题」是两件事。 */
export type ValidationStatus = 'verified' | 'unverified' | 'quarantined'

export interface CounterpartyIdentity {
  id: string
  channel: Channel
  venue: string
  chainId?: number
  chainName?: string
  /** DEX 路由合约地址；CEX 为 undefined。 */
  contractAddress?: string
  /**
   * 身份声明的来源：
   *   `seed`          = 本项目内置登记（地址取自执行层同一常量，见 seedRecords）
   *   `verified`      = 经人工核验后写入
   *   `self-declared` = 对手方自称（**最低可信**，不得作为结算依据）
   */
  identitySource: 'seed' | 'verified' | 'self-declared'
}

export interface CounterpartyReputation {
  samples: number
  settlementRate: number
  costRealizationRatio: number
  avgSlippageBps: number
  incidents: number
  /** 0~1。**samples 为 0 时是 null** —— 见文件头语义说明。 */
  score: number | null
  updatedAt: string | null
}

export interface CounterpartyRecord {
  identity: CounterpartyIdentity
  reputation: CounterpartyReputation
  validation: ValidationStatus
  validationNote: string
  validatedAt: string | null
}

export interface SettlementOutcome {
  ok: boolean
  expectedCostUsdt: number
  realizedCostUsdt: number
  slippageBps: number
  /** 事故标签（对账不一致 / 回执缺失 等）。给了就计入 incidents。 */
  incident?: string
}

export type TrustVerdict = 'TRUSTED' | 'UNPROVEN' | 'LOW_REPUTATION' | 'UNVERIFIED' | 'QUARANTINED' | 'UNKNOWN_COUNTERPARTY'

export interface CounterpartyTrust {
  id: string
  allowed: boolean
  verdict: TrustVerdict
  /** 敞口倍数：1 = 满额，0.5 = 半仓试探，0 = 禁止。 */
  sizeMultiplier: number
  reason: string
  record: CounterpartyRecord | null
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
}

/**
 * 构造一条记录。
 *
 * ★ 必须用工厂函数而不是 `{ ...base }` 展开：
 *   展开是**浅拷贝**，`reputation` 会指向同一个对象，
 *   于是 8 个对手方共享一份声誉 —— 给 binance 记一笔结算，
 *   所有 DEX 通道的样本数一起涨。表现是「看起来各自独立、其实是一份数据」，
 *   正是本项目最忌讳的那类缺陷。工厂函数保证每条记录持有自己的可变状态。
 */
function mkRecord(identity: CounterpartyIdentity, validationNote: string): CounterpartyRecord {
  return {
    identity,
    reputation: emptyReputation(),
    // 内置登记 = 我们已核对过集成方式，但**还没有任何结算样本**。
    // 因此是 verified（身份可信）而不是 TRUSTED（声誉达标）—— 两者是不同维度。
    validation: 'verified',
    validationNote,
    validatedAt: null,
  }
}

/**
 * 内置登记表。
 *
 * ★ DEX 的合约地址**直接从执行层的 `contractsByChain` 取**，不在这里抄一份。
 *   抄一份就多一个漂移源：执行层换了路由、注册表还在核验旧地址，
 *   而两边看起来都「有值」，对账时才会发现核对的是两个东西。
 */
function seedRecords(): CounterpartyRecord[] {
  const cex: CounterpartyRecord[] = [
    mkRecord(
      { id: 'binance-futures', channel: 'cex', venue: 'binance', identitySource: 'seed' },
      'CEX 通道：Binance USDT-M 永续（行情走 public API，下单走私钥签名）',
    ),
    mkRecord(
      { id: 'okx-swap', channel: 'cex', venue: 'okx', identitySource: 'seed' },
      'CEX 通道：OKX 永续',
    ),
    mkRecord(
      { id: 'sandbox-venue', channel: 'cex', venue: 'sandbox', identitySource: 'seed' },
      '本地沙箱场所：仅 paper / 演练使用，不出真实资金',
    ),
  ]

  const dex: CounterpartyRecord[] = Object.entries(contractsByChain).map(([chainIdStr, c]) => {
    const chainId = Number(chainIdStr)
    return mkRecord(
      {
        id: `uniswap-v3@${chainId}`,
        channel: 'dex',
        venue: 'uniswap-v3',
        chainId,
        chainName: CHAIN_NAMES[chainId] ?? `chain-${chainId}`,
        // 地址来源与执行层同源（见上方 ★）
        contractAddress: c.router,
        identitySource: 'seed',
      },
      `DEX 通道：Uniswap V3 SwapRouter（${CHAIN_NAMES[chainId] ?? chainId}），地址取自执行层 contractsByChain`,
    )
  })

  return [...cex, ...dex]
}

function emptyReputation(): CounterpartyReputation {
  return {
    samples: 0,
    settlementRate: 0,
    costRealizationRatio: 1,
    avgSlippageBps: 0,
    incidents: 0,
    score: null,
    updatedAt: null,
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function round(v: number, d = 4): number {
  if (!Number.isFinite(v)) return v
  const m = Math.pow(10, d)
  return Math.round(v * m) / m
}

/**
 * 声誉分派生（确定性、可复核）。
 *
 * 权重刻意向「结算是否成功」倾斜（0.5），因为对结算对手方来说
 * 「能不能按约定把钱和货交出来」压倒其他一切；
 * 成本准确度（0.3）次之，它衡量的是「这个通道的成本我们是否看得懂」；
 * 事故（0.2）用 1/(1+n) 衰减而不是线性扣分 —— 第一次事故的边际信息量最大，
 * 之后每次的边际信息量递减（已知它会出事，再多一次不改变判断）。
 *
 * ★ samples === 0 时返回 **null**，不是 0 也不是 0.5。见文件头语义说明。
 */
export function deriveScore(r: CounterpartyReputation): number | null {
  if (r.samples <= 0) return null
  const settlement = clamp01(r.settlementRate)
  // 实现成本 ≤ 预估成本 → 满分；超出越多，得分越低
  const costAccuracy = clamp01(1 / Math.max(1, r.costRealizationRatio))
  const incidentFree = 1 / (1 + Math.max(0, r.incidents))
  return round(clamp01(0.5 * settlement + 0.3 * costAccuracy + 0.2 * incidentFree), 4)
}

export class CounterpartyRegistry {
  private readonly path: string
  private records = new Map<string, CounterpartyRecord>()

  constructor(path: string) {
    this.path = path
    this.load()
  }

  private load(): void {
    this.records = new Map(seedRecords().map((r) => [r.identity.id, r]))
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { records?: CounterpartyRecord[] }
      for (const rec of raw.records ?? []) {
        if (!rec?.identity?.id) continue
        // 已落盘的记录覆盖种子（保留 seed 的地址，但采用落盘的验证状态与声誉）
        const seeded = this.records.get(rec.identity.id)
        this.records.set(rec.identity.id, {
          ...rec,
          identity: seeded ? { ...seeded.identity, ...rec.identity, contractAddress: seeded.identity.contractAddress } : rec.identity,
        })
      }
    } catch {
      // 注册表损坏时**保留种子**而不是清空：空注册表会让所有通道被拒，
      // 表现为「系统突然不能交易了」，排查成本远高于从种子重建。
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, { format: 'evolve.counterparty-registry', version: 1, records: [...this.records.values()] })
  }

  list(): CounterpartyRecord[] {
    return [...this.records.values()].sort((a, b) => a.identity.id.localeCompare(b.identity.id))
  }

  get(id: string): CounterpartyRecord | null {
    return this.records.get(id) ?? null
  }

  /**
   * 登记一笔结算结果。这是声誉的**唯一**来源。
   *
   * 增量更新（滚动平均）而不是全量重算：全量需要持久化每一笔明细，
   * 而明细已经在审计链与账本里了 —— 再存一份就是两套口径。
   */
  recordSettlement(id: string, outcome: SettlementOutcome): { ok: boolean; record: CounterpartyRecord | null; reason: string } {
    const rec = this.records.get(id)
    if (!rec) return { ok: false, record: null, reason: `未登记的对手方 ${id}：不允许凭空累积声誉` }

    const n = rec.reputation.samples
    const okNum = outcome.ok ? 1 : 0
    const ratio = outcome.expectedCostUsdt > 0 ? outcome.realizedCostUsdt / outcome.expectedCostUsdt : 1

    rec.reputation.samples = n + 1
    rec.reputation.settlementRate = round((rec.reputation.settlementRate * n + okNum) / (n + 1))
    rec.reputation.costRealizationRatio = round((rec.reputation.costRealizationRatio * n + ratio) / (n + 1))
    rec.reputation.avgSlippageBps = round((rec.reputation.avgSlippageBps * n + Math.max(outcome.slippageBps, 0)) / (n + 1), 3)
    if (outcome.incident) rec.reputation.incidents += 1
    rec.reputation.score = deriveScore(rec.reputation)
    rec.reputation.updatedAt = new Date().toISOString()
    this.persist()

    return {
      ok: true,
      record: rec,
      reason: `已记录：样本 ${rec.reputation.samples} 笔，结算成功率 ${(rec.reputation.settlementRate * 100).toFixed(1)}%，成本实现比 ${rec.reputation.costRealizationRatio.toFixed(3)}`,
    }
  }

  /**
   * 设定验证状态。
   *
   * 拒绝把自己声明为 verified —— 验证的意义就在于「不是对手方自己说的」。
   * 这一条与 approvalGate 拒绝 `auto:*` 自我批准是同一个原则：
   * **可信度只能由外部注入，不能自封。**
   */
  setValidation(
    id: string,
    status: ValidationStatus,
    note: string,
    by: string,
  ): { ok: boolean; record: CounterpartyRecord | null; reason: string } {
    const rec = this.records.get(id)
    if (!rec) return { ok: false, record: null, reason: `未登记的对手方 ${id}。请先登记身份，再核验。` }
    if (status === 'verified' && (!by || by.startsWith('auto:'))) {
      return {
        ok: false,
        record: rec,
        reason: '「已核验」必须由人工或带明确署名的流程写入，不接受 auto:* 自我核验——自封的可信度不构成可信度。',
      }
    }
    rec.validation = status
    rec.validationNote = note || rec.validationNote
    rec.validatedAt = new Date().toISOString()
    if (status === 'verified') rec.identity.identitySource = 'verified'
    this.persist()
    return { ok: true, record: rec, reason: `对手方 ${id} 验证状态 → ${status}` }
  }

  /**
   * 信任裁决 —— 决策/结算链路上的闸门。
   *
   * 判定顺序（从强制到经济）：隔离 > 未登记 > 未核验 > 声誉过低 > 无样本 > 通过。
   * 顺序不能变：把「声誉过低」排在「未核验」之前，
   * 会出现「一个未核验但恰好声誉分高的对手方被放行」——声誉分本身也来自我们自己，
   * 无法替代对身份本身的核验。
   */
  assess(id: string): CounterpartyTrust {
    const rec = this.records.get(id)
    if (!rec) {
      return {
        id,
        allowed: false,
        verdict: 'UNKNOWN_COUNTERPARTY',
        sizeMultiplier: 0,
        reason: `对手方 ${id} 未登记。默认不允许与其建立敞口——「不知道它是谁」不是可以放行的理由。`,
        record: null,
      }
    }

    if (rec.validation === 'quarantined') {
      return { id, allowed: false, verdict: 'QUARANTINED', sizeMultiplier: 0, reason: `对手方已被隔离：${rec.validationNote}`, record: rec }
    }

    if (rec.validation === 'unverified') {
      return {
        id,
        allowed: false,
        verdict: 'UNVERIFIED',
        sizeMultiplier: 0,
        reason: '身份未经核验，不允许建立新敞口。声誉分不能替代对身份的核验——两者是不同维度。',
        record: rec,
      }
    }

    const score = rec.reputation.score
    if (score !== null && score < COUNTERPARTY_MIN_REPUTATION) {
      return {
        id,
        allowed: false,
        verdict: 'LOW_REPUTATION',
        sizeMultiplier: 0,
        reason:
          `声誉分 ${score.toFixed(3)} 低于下限 ${COUNTERPARTY_MIN_REPUTATION}（样本 ${rec.reputation.samples} 笔，` +
          `事故 ${rec.reputation.incidents} 次，成本实现比 ${rec.reputation.costRealizationRatio.toFixed(2)}）。`,
        record: rec,
      }
    }

    if (score === null) {
      return {
        id,
        allowed: true,
        verdict: 'UNPROVEN',
        sizeMultiplier: UNPROVEN_SIZE_MULTIPLIER,
        reason:
          `身份已核验但**尚无结算样本**，按 ${UNPROVEN_SIZE_MULTIPLIER}× 敞口试探。` +
          '无样本既不是低分也不是合格——把它当成任意一个数都是把未知当已知。',
        record: rec,
      }
    }

    return {
      id,
      allowed: true,
      verdict: 'TRUSTED',
      sizeMultiplier: 1,
      reason: `声誉分 ${score.toFixed(3)} ≥ ${COUNTERPARTY_MIN_REPUTATION}，样本 ${rec.reputation.samples} 笔。`,
      record: rec,
    }
  }

  /** 汇总视图。给面板用：哪些通道还没积累出信誉，一眼可见。 */
  summary(): { total: number; byVerdict: Record<TrustVerdict, number>; unproven: string[]; rejected: { id: string; reason: string }[] } {
    const byVerdict: Record<TrustVerdict, number> = {
      TRUSTED: 0,
      UNPROVEN: 0,
      LOW_REPUTATION: 0,
      UNVERIFIED: 0,
      QUARANTINED: 0,
      UNKNOWN_COUNTERPARTY: 0,
    }
    const unproven: string[] = []
    const rejected: { id: string; reason: string }[] = []
    for (const r of this.list()) {
      const t = this.assess(r.identity.id)
      byVerdict[t.verdict] += 1
      if (t.verdict === 'UNPROVEN') unproven.push(r.identity.id)
      if (!t.allowed) rejected.push({ id: r.identity.id, reason: t.reason })
    }
    return { total: this.records.size, byVerdict, unproven, rejected }
  }
}

// ─────────────────────────────────────────────────────────────
// 进程级单例
// ─────────────────────────────────────────────────────────────

let singleton: CounterpartyRegistry | null = null

export function getCounterpartyRegistry(): CounterpartyRegistry {
  if (!singleton) {
    singleton = new CounterpartyRegistry(process.env.EV_COUNTERPARTY_REGISTRY ?? 'data/counterparty_registry.json')
  }
  return singleton
}

export function setCounterpartyRegistry(r: CounterpartyRegistry | null): void {
  singleton = r
}

export { CHAIN_NAMES }
