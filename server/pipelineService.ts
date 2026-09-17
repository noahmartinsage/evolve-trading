import { PromotionPipeline, DEFAULT_PIPELINE_CONFIG, PROMOTION_PIPELINE_VERSION } from '../src/engine/promotion.ts'
import type { StrategyRecord, PipelineConfig, BacktestGateInput } from '../src/engine/promotion.ts'
import type { OverfitReceipt } from '../src/engine/overfit.ts'
import type { OrderIntentInput } from './risk.ts'
import { appendEvent } from './ledger.ts'
import { isPersistent, loadPromotions, upsertPromotion } from './persistence.ts'
import { LEVERAGE_HARD_CEILING } from './riskConstants.ts'

/**
 * backtest 门的输入。
 *
 * ⚠️ 这里从前有三个字段，其中 `wfRobust: boolean` 是**由请求体直接透传**的
 * （`Boolean(body.wfRobust)`），而前端把它硬编码成 `true` ——
 * 于是唯一的过拟合门在产品路径上永不触发。这是 F-34 的真因。
 *
 * 现在改为必须携带**机器凭据**：调用方要么真的把 walk-forward 跑完
 * （`computeOverfitReceipt`），要么就过不了门。凭据里没有结论字段，
 * 阈值由流水线 config 施加，所以"构造一份看起来能过的凭据"这条路
 * 也走不通 —— 它只能填可观测量。
 */
export interface GateInputDto {
  fitnessValue: number
  fitnessVersion?: string
  overfit: OverfitReceipt
  purityHomogeneous: boolean
}

/** live 订单意图：必须携带晋升流水线签发的策略身份 */
export interface LiveIntentInput extends OrderIntentInput {
  strategyId: string
  mode?: 'paper' | 'live'
  leverage?: number
}

export type LiveAuth =
  | { ok: true; capUsd: number; liveMarginSoFar: number }
  | { ok: false; reason: string }

/** v3 存储格式：记录 + live 累计名义本金 + live 累计自有资金。v2 无 liveMargin（当时杠杆恒为 1）。 */
interface StoredV2 {
  v: 2
  record: StrategyRecord
  liveNotional: number
}
interface StoredV3 {
  v: 3
  record: StrategyRecord
  liveNotional: number
  liveMargin: number
}

function isStoredRecord(x: unknown): x is StoredV2 | StoredV3 {
  if (typeof x !== 'object' || x === null) return false
  const o = x as { v?: unknown; record?: unknown }
  return (o.v === 2 || o.v === 3) && typeof o.record === 'object'
}

class PersistentPipeline {
  private pipe = new PromotionPipeline(DEFAULT_PIPELINE_CONFIG)
  private initialized = false
  private liveNotional = new Map<string, number>()
  /**
   * 累计**自有资金**（保证金）占用。资金帽量的是这一个，不是名义本金。
   *
   * 为什么必须与名义本金分开记：以小博大的定义就是「自有资金 1 份 → 名义本金 N 份」。
   * 只记名义本金时，$100 的帽在 10x 下只允许放下 $10 的保证金 ——
   * 帽会以「额度用尽」的名义，把一个完全合规的小资金策略结构性锁死。
   */
  private liveMargin = new Map<string, number>()

  init(): void {
    if (this.initialized) return
    for (const row of loadPromotions()) {
      try {
        const parsed = JSON.parse(row.data) as unknown
        if (isStoredRecord(parsed)) {
          this.pipe.restore(parsed.record)
          this.liveNotional.set(parsed.record.id, parsed.liveNotional)
          // v2 记录写于「杠杆恒为 1」时期，那时名义本金与自有资金是同一个数；
          // 用 v2 字段回填 liveMargin 是**唯一正确的迁移方式**（不是猜，是当时的定义）。
          this.liveMargin.set(parsed.record.id, parsed.v === 3 ? parsed.liveMargin : parsed.liveNotional)
        } else {
          this.pipe.restore(parsed as StrategyRecord)
        }
      } catch (e) {
        console.warn(`⚠️ 晋升记录 ${row.id} 恢复失败: ${e instanceof Error ? e.message : e}`)
      }
    }
    this.initialized = true
    console.log(`✅ 晋升流水线已恢复 · ${loadPromotions().length} 条策略记录 · v${PROMOTION_PIPELINE_VERSION}`)
  }

  private persist(rec: StrategyRecord): void {
    const payload: StoredV3 = {
      v: 3,
      record: rec,
      liveNotional: this.liveNotional.get(rec.id) ?? 0,
      liveMargin: this.liveMargin.get(rec.id) ?? 0,
    }
    if (isPersistent()) upsertPromotion(rec.id, Date.now(), JSON.stringify(payload))
    const last = rec.history[rec.history.length - 1]
    if (last) appendEvent('PROMOTION_STAGE', { id: rec.id, from: last.from, to: last.to, reason: last.reason })
  }

  config(): PipelineConfig {
    return this.pipe.getConfig()
  }

  list(): (StrategyRecord & { liveNotional: number; liveMargin: number })[] {
    return this.pipe.list().map((r) => ({
      ...r,
      liveNotional: this.liveNotional.get(r.id) ?? 0,
      liveMargin: this.liveMargin.get(r.id) ?? 0,
    }))
  }

  get(id: string): StrategyRecord {
    return this.pipe.get(id)
  }

  submit(id: string): StrategyRecord {
    if (!this.liveNotional.has(id)) this.liveNotional.set(id, 0)
    if (!this.liveMargin.has(id)) this.liveMargin.set(id, 0)
    const rec = this.pipe.submit(id, Date.now())
    this.persist(rec)
    appendEvent('STRATEGY_SUBMITTED', { strategyId: id })
    return rec
  }

  evaluateGate(id: string, dto: GateInputDto): StrategyRecord {
    const input: BacktestGateInput = {
      fitness: { version: dto.fitnessVersion ?? DEFAULT_PIPELINE_CONFIG.fitnessVersion, value: dto.fitnessValue },
      overfit: dto.overfit,
      purityHomogeneous: dto.purityHomogeneous,
    }
    this.pipe.evaluateBacktestGate(id, input, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    // 把裁定单独落一条审计事件：拒绝留下的 reason 里虽有摘要，
    // 但它与"阶段变更"混在同一条记录里，事后按"过拟合"检索会漏。
    if (rec.overfit) {
      appendEvent('OVERFIT_VERDICT', {
        strategyId: id,
        outcome: rec.overfit.outcome,
        pbo: rec.overfit.pbo,
        avgWinnerW: rec.overfit.avgWinnerW,
        folds: rec.overfit.folds,
        candidates: rec.overfit.candidates,
        dataHash: rec.overfit.dataHash,
        stage: rec.stage,
      })
    }
    return rec
  }

  /** 由撮合回填自动调用：非观察期阶段静默忽略，不抛错 */
  recordPaperTradeAuto(id: string | undefined): void {
    if (!id) return
    try {
      this.pipe.recordPaperTrade(id, Date.now())
      this.persist(this.pipe.get(id))
    } catch {
      /* 非 paper_observing 阶段的成交不计入观察期 */
    }
  }

  recordPaperTrade(id: string): StrategyRecord {
    this.pipe.recordPaperTrade(id, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  closePaper(id: string, drawdownPct: number): StrategyRecord {
    this.pipe.recordPaperDrawdown(id, drawdownPct)
    this.pipe.closePaperObservation(id, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  // ── 测试网实测（真钱之前必须走完的实证阶段）──────────────────────

  /**
   * 进入实测。`ts` 可选，默认取当前时刻。
   *
   * 为什么把时钟开放为参数：实测闸门里有「观测时长 ≥ N 小时」这一道，
   * 而它是**由成交时间戳推导**的。若服务层把 ts 焊死成 Date.now()，
   * 就无法为这条规则写任何确定性断言 —— 要么等真实数小时（测试不可跑），
   * 要么放弃断言（规则无人守护）。注入时钟是唯一两全的做法。
   */
  beginTestnet(id: string, venue: string, ts: number = Date.now()): StrategyRecord {
    this.pipe.beginTestnetVerification(id, ts, venue)
    const rec = this.pipe.get(id)
    this.persist(rec)
    appendEvent('TESTNET_VERIFICATION_STARTED', { strategyId: id, venue, ts })
    return rec
  }

  /**
   * 由真实成交回填自动调用。非实测阶段静默忽略——
   * 与 `recordPaperTradeAuto` 同理：成交回填是**场所驱动的**，
   * 不该因为"这条策略不在实测阶段"而抛错打断成交流。
   */
  recordTestnetFillAuto(id: string | undefined, venue?: string): void {
    if (!id) return
    try {
      this.pipe.recordTestnetFill(id, Date.now())
      this.persist(this.pipe.get(id))
    } catch {
      /* 非 testnet_verifying 阶段的成交不计入实测样本 */
    }
    if (venue) appendEvent('TESTNET_FILL_OBSERVED', { strategyId: id, venue })
  }

  recordTestnetFill(id: string, ts: number = Date.now()): StrategyRecord {
    this.pipe.recordTestnetFill(id, ts)
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  /**
   * 记录一笔实测平仓收益（%）。缺它则实测**无法通过准入**（尾部风险样本不足）。
   *
   * 这个"缺了就拒绝"的选择是有意的：若缺样本时按"无尾部风险"放行，
   * 不回传收益的策略会比老实回传的更安全 —— 反向激励比缺一道门更危险。
   */
  recordTestnetReturn(id: string, returnPct: number): StrategyRecord {
    this.pipe.recordTestnetReturn(id, returnPct)
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  recordTestnetViolation(id: string, reason: string): StrategyRecord {
    this.pipe.recordTestnetViolation(id, reason)
    const rec = this.pipe.get(id)
    this.persist(rec)
    appendEvent('TESTNET_VIOLATION', { strategyId: id, reason })
    return rec
  }

  closeTestnet(id: string, drawdownPct: number, ts: number = Date.now()): StrategyRecord {
    this.pipe.recordTestnetDrawdown(id, drawdownPct)
    this.pipe.closeTestnetVerification(id, ts)
    const rec = this.pipe.get(id)
    this.persist(rec)
    appendEvent('TESTNET_VERIFICATION_CLOSED', {
      strategyId: id,
      stage: rec.stage,
      stats: rec.testnetStats,
    })
    return rec
  }

  /**
   * 某策略当前是否具备进入实盘的资格。
   *
   * 为什么单独暴露这个判定而不是让调用方自己比对 stage 字符串：
   * 「哪些阶段允许 live」这条知识一旦散落到多个调用点，加一个新阶段时
   * 必然有某个点忘了改——而那会表现为「某条未经验证的策略被放行」，
   * 是这套流水线里代价最高的一类漏改。所以它只能有一个出处。
   */
  isLiveEligible(id: string): boolean {
    const rec = this.pipe.get(id)
    return rec.stage === 'small_cap_live' || rec.stage === 'full_live'
  }

  approve(id: string, approver: string): StrategyRecord {
    this.pipe.approveSmallCap(id, approver, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  promoteFull(id: string): StrategyRecord {
    this.pipe.promoteFull(id, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  rollback(id: string, reason: string): StrategyRecord {
    this.pipe.rollback(id, Date.now(), reason || '人工回滚')
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  restoreFromRollback(id: string): StrategyRecord {
    this.pipe.restoreFromRollback(id, Date.now())
    const rec = this.pipe.get(id)
    this.persist(rec)
    return rec
  }

  /**
   * live 出站前最后一道晋升闸门（同步、默认拒绝）：
   * 仅 small_cap_live 阶段放行；单笔与累计名义本金均受 capUsd 硬上限约束。
   * full_live 的自动放量未开放——需人工走 promote-full 审批。
   */
  authorizeLive(strategyId: string | undefined, notional: number, margin?: number): LiveAuth {
    if (!strategyId) return { ok: false, reason: 'LIVE_REQUIRES_STRATEGY_ID' }
    let rec: StrategyRecord
    try {
      rec = this.pipe.get(strategyId)
    } catch {
      return { ok: false, reason: `STRATEGY_UNKNOWN:${strategyId}` }
    }
    // 出站资格判定只走 isLiveEligible —— 新增阶段时只需改这一处，
    // 不会出现「某个调用点忘了放行新阶段」或「忘了拦住旧阶段」的漏改
    if (!this.isLiveEligible(strategyId)) {
      return { ok: false, reason: `STRATEGY_NOT_AUTHORIZED_FOR_LIVE:${rec.stage}` }
    }

    // 自有资金：未传时按「无杠杆」处理 ⇒ 与改造前行为完全等价（不是宽松化）。
    const own = Number.isFinite(margin) && (margin as number) > 0 ? (margin as number) : notional

    // 不变量：名义本金 ≤ 自有资金 × 硬天花板。
    // 违反只有一种解释 —— 连接两个量的「杠杆」在传递途中丢了或被改写，
    // 此时帽的量纲本身是错的。宁可拒绝，也不能用一个量纲错误的数去放行真钱。
    if (notional > own * LEVERAGE_HARD_CEILING + 1e-6) {
      return {
        ok: false,
        reason: `CAP_MARGIN_NOTIONAL_MISMATCH (notional ${notional.toFixed(2)} > margin ${own.toFixed(2)} × ${LEVERAGE_HARD_CEILING})`,
      }
    }

    const cap = Number(process.env.AUTOPILOT_LIVE_CAP_USD ?? rec.capUsd ?? DEFAULT_PIPELINE_CONFIG.smallCapUsd)
    const soFar = this.liveMargin.get(strategyId) ?? 0
    if (own > cap) return { ok: false, reason: `STRATEGY_CAP_ORDER_EXCEEDS (${own.toFixed(0)} > ${cap})` }
    if (soFar + own > cap) {
      return { ok: false, reason: `STRATEGY_CAP_EXCEEDED (${(soFar + own).toFixed(0)}+${own.toFixed(0)} > ${cap})` }
    }
    return { ok: true, capUsd: cap, liveMarginSoFar: soFar }
  }

  /** 仅在 gateway 接受意图后调用：累计 live 自有资金与名义本金并落盘 */
  recordLiveSubmitted(strategyId: string, notional: number, margin?: number): void {
    const own = Number.isFinite(margin) && (margin as number) > 0 ? (margin as number) : notional
    this.liveNotional.set(strategyId, (this.liveNotional.get(strategyId) ?? 0) + notional)
    this.liveMargin.set(strategyId, (this.liveMargin.get(strategyId) ?? 0) + own)
    this.persist(this.pipe.get(strategyId))
  }
}

export const pipelineService = new PersistentPipeline()
