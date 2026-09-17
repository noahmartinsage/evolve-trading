import { FITNESS_VERSION } from './fitness.ts'
import { CVAR_DEFAULT_ALPHA, maxDrawdownFromReturns, tailRiskSummary, worstSingleLossPct } from './riskMetrics.ts'
import { DEFAULT_OVERFIT_THRESHOLDS, judgeOverfit, verifyOverfitReceipt } from './overfit.ts'
import type { OverfitOutcome, OverfitReceipt, OverfitThresholds } from './overfit.ts'

export const PROMOTION_PIPELINE_VERSION = 'promotion-v4'

export type Stage =
  | 'candidate'
  | 'rejected'
  | 'paper_observing'
  | 'ready_for_small_cap'
  | 'testnet_verifying'
  | 'testnet_verified'
  | 'small_cap_live'
  | 'full_live'
  | 'rolled_back'

export interface FitnessStamp {
  version: string
  value: number
}

export interface PaperStats {
  firstTradeTs: number | null
  trades: number
  maxDrawdownPct: number
}

/**
 * 测试网实测统计。
 *
 * 为什么需要独立的 `violations` 计数，而不只看「成交笔数 + 回撤」：
 *   测试网的意义是**在真钱之前暴露系统级缺陷**，而不是"用假钱赚一遍"。
 *   一笔被风控拦下的交易、一次对账不平、一次预留被误释放 ——
 *   这些都不是"亏损"，它们不会体现在收益曲线上，但恰恰是真钱环境里最贵的失败。
 *   所以违规必须在准入判定里**一票否决**，且与盈亏完全分开计数。
 */
export interface TestnetStats {
  /** 首次成交时间戳。用于计算观测时长，而不是用"提交时刻"——提交后长时间不成交本身就是信号。 */
  firstFillTs: number | null
  lastFillTs: number | null
  fills: number
  maxDrawdownPct: number
  /** 违规次数。风控拦截异常 / 对账不平 / 预留语义破坏等，任一项 +1。 */
  violations: number
  /** 违规原因留痕（只保留最近若干条，防单条记录被撑爆）。 */
  violationReasons: string[]
  /** 实测使用的场所，例如 okx-testnet。留痕以便回答"这条准入是基于哪个场所的实测"。 */
  venue: string | null
  /**
   * 逐笔收益率序列（%，正=盈利）。**封顶保留最近 N 笔**，防单条记录被撑爆。
   *
   * 为什么要把逐笔收益留下来、而不是只留一个回撤数：
   *   回撤是路径量，看不见尾部形状。一个「回撤 5% 但亏损高度集中在 2 笔」的策略
   *   与「回撤 5% 但亏损均匀摊在 40 笔」的策略，回撤数字完全一样，
   *   而前者在黑天鹅下会以更快的速度崩塌。CVaR 需要原始序列才能算出这个差别，
   *   事后无法从任何汇总量反推 —— 所以必须在实测期就逐笔记下来。
   */
  returns: number[]
  /** 尾部平均损失幅度（%，非负）。无足够样本时为 null（≠0，见 riskMetrics 的说明）。 */
  cvarLossPct: number | null
  /** 单笔最大亏损幅度（%，非负）。 */
  worstSingleLossPct: number | null
}

export interface TransitionRecord {
  ts: number
  from: Stage
  to: Stage
  reason: string
}

/**
 * 过拟合判定的**留痕**。
 *
 * 为什么不只留一个布尔 `robust`：
 *   布尔量把「PBO 多少 / 赢家分位多少 / 几折几候选」全部丢掉，
 *   事后无法回答「它当初是靠什么数据、什么数字过的门」。
 *   而这一整套流水线的价值恰恰在于**可复核**。
 * 所以这里同时留：结论 + 摘要 + 关键标量 + **完整凭据**（可独立重算）。
 */
export interface OverfitStamp {
  outcome: OverfitOutcome
  /** 中文完整句，进审计事件与 UI 时要能独立读懂。 */
  summary: string
  pbo: number | null
  avgWinnerW: number | null
  folds: number
  candidates: number
  /** 凭据针对哪批行情算的。换数据集重跑会得到不同的指纹。 */
  dataHash: string
  /** 完整凭据。复核者可据此独立重算均值与分位，不必相信上面的标量。 */
  receipt: OverfitReceipt
}

export interface StrategyRecord {
  id: string
  stage: Stage
  submittedTs: number
  fitness: FitnessStamp | null
  /**
   * 过拟合判定留痕。老记录（≤v3 时期）没有这个字段，restore 时归一化为 null。
   *
   * 注意它**取代**了原先的 `wfRobust: boolean | null` ——
   * 那个字段是调用方自报的，UI 硬编码 true、API 直接透传，
   * 于是这道门在产品路径上永不触发（F-34 的真因）。
   */
  overfit: OverfitStamp | null
  purityHomogeneous: boolean | null
  paperStats: PaperStats | null
  /** 测试网实测统计。老记录（v1 时期）没有这个字段，restore 时归一化为 null。 */
  testnetStats: TestnetStats | null
  approvedBy: string | null
  capUsd: number | null
  rolledBackToStage: Stage | null
  history: TransitionRecord[]
}

export interface PipelineConfig {
  minFitness: number
  fitnessVersion: string
  /**
   * 是否要求过拟合判定通过。
   *
   * 这是**部署配置**，不是每次调用可传的参数 —— 两者差别是本质的：
   * 前者要改部署才能放宽，后者调用方随手就能绕过。
   * 改造前的漏洞正是后者（调用方自报 `wfRobust`）。
   */
  requireOverfit: boolean
  /** 过拟合阈值。**住在这里**，由流水线自己判；凭据里只有可观测量。 */
  overfit: OverfitThresholds
  forbidHomogeneousPurity: boolean
  paperMinTrades: number
  paperMaxDrawdownPct: number
  /** 测试网实测最少成交笔数。低于此值不足以证伪——样本太少时"跑通了"与"没跑到"无法区分。 */
  testnetMinFills: number
  /** 测试网观测最少时长（小时）。防"几分钟内刷够笔数"这种形式达标。 */
  testnetMinHours: number
  /** 测试网实测允许的最大回撤（%）。 */
  testnetMaxDrawdownPct: number
  /**
   * 测试网实测允许的最大**尾部平均损失**（CVaR，%）。
   *
   * 为什么回撤之外还要这一道（内化自 2026-09-14 日报第 ④ 条）：
   *   回撤是路径量、对曲线形状敏感；CVaR 是分布量、对尾部集中度敏感。
   *   只守回撤时，一个「平时小赚、偶尔巨亏但还没亏到回撤线」的策略会被放行，
   *   而它恰恰是实盘里最容易一次归零的那一类。默认 4% 的含义：
   *   按单笔 1R=权益 1% 的口径，尾部平均亏损超过 4R 即视为尾部过肥。
   */
  testnetMaxCvarPct: number
  /** CVaR 的分位（默认最差 5%）。 */
  testnetTailAlpha: number
  smallCapUsd: number
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  minFitness: 30,
  // 引用 fitness.ts 的常量而非硬编码，避免两侧版本号漂移导致
  // evaluateBacktestGate 抛 FITNESS_VERSION_MISMATCH（见 docs/DEV-PROMPT-KIT.md F-1）
  fitnessVersion: FITNESS_VERSION,
  requireOverfit: true,
  // 引用 overfit.ts 的默认值而非在这里写第二份 ——
  // 阈值的单一出处必须与那份零假设校准表在一起（见 overfit.ts）。
  overfit: DEFAULT_OVERFIT_THRESHOLDS,
  forbidHomogeneousPurity: true,
  paperMinTrades: 20,
  paperMaxDrawdownPct: 10,
  testnetMinFills: 10,
  testnetMinHours: 6,
  testnetMaxDrawdownPct: 10,
  testnetMaxCvarPct: 4,
  testnetTailAlpha: CVAR_DEFAULT_ALPHA,
  smallCapUsd: 500,
}

export interface BacktestGateInput {
  fitness: FitnessStamp
  /**
   * 过拟合**机器凭据**（由 `walkForward` / `computeOverfitReceipt` 产出）。
   *
   * ⚠️ 这里从前是一个调用方自报的布尔 `wfRobust`，那是 F-34 的真因：
   *   `server/index.ts` 直接 `Boolean(body.wfRobust)`，
   *   而 `MonitorPage.tsx` 把它硬编码成 `true` —— 于是 `requireWfRobust`
   *   这道唯一的过拟合门在**产品路径上永不触发**。
   *   现在改为必须携带凭据，且**凭据里不含结论**（见 overfit.ts）：
   *   阈值由本流水线的 config 施加，调用方无法把"不达标"说成"达标"。
   *   缺凭据 → fail-closed 拒绝，而不是放行。
   */
  overfit: OverfitReceipt
  purityHomogeneous: boolean
}

/**
 * 逐笔收益序列的保留上限。
 *
 * 为什么要有上限而不是全留：这段数据会随策略记录原子写盘、并随状态接口回传，
 * 一次实测可能是几千笔。留最近 512 笔足以估计 5% 尾部的均值
 * （512 × 5% ≈ 25 个尾部样本，统计上已经够用），
 * 而全留会让单条记录随时间无界增长 —— 那是"写盘越来越慢、最后莫名超时"的典型来路。
 */
const TESTNET_RETURNS_CAP = 512

/** 测试网统计的唯一构造点：三处各自写字面量正是"同一事实多份副本"的入口。 */
function emptyTestnetStats(venue: string | null): TestnetStats {
  return {
    firstFillTs: null,
    lastFillTs: null,
    fills: 0,
    maxDrawdownPct: 0,
    violations: 0,
    violationReasons: [],
    venue,
    returns: [],
    cvarLossPct: null,
    worstSingleLossPct: null,
  }
}

export class PromotionPipeline {
  private records = new Map<string, StrategyRecord>()
  private cfg: PipelineConfig

  constructor(cfg: PipelineConfig) {
    this.cfg = cfg
  }

  getConfig(): PipelineConfig {
    return this.cfg
  }

  submit(id: string, ts: number): StrategyRecord {
    if (this.records.has(id)) throw new Error(`DUPLICATE_STRATEGY_ID:${id}`)
    const rec: StrategyRecord = {
      id,
      stage: 'candidate',
      submittedTs: ts,
      fitness: null,
      overfit: null,
      purityHomogeneous: null,
      paperStats: null,
      testnetStats: null,
      approvedBy: null,
      capUsd: null,
      rolledBackToStage: null,
      history: [],
    }
    this.records.set(id, rec)
    return rec
  }

  get(id: string): StrategyRecord {
    const r = this.records.get(id)
    if (!r) throw new Error(`UNKNOWN_STRATEGY:${id}`)
    return r
  }

  restore(rec: StrategyRecord): void {
    if (this.records.has(rec.id)) throw new Error(`DUPLICATE_STRATEGY_ID:${rec.id}`)
    // 向后兼容：≤v3 时期的记录里这个字段叫 `wfRobust`（一个调用方自报的布尔量），
    // 且没有 `overfit` 凭据。这里**归一化为 null，不迁移、不伪造**：
    //   · 老记录当时根本没有算过 PBO / 赢家分位，任何"补算"都是事后编造；
    //   · 置 null 的后果是这些记录的 `rec.overfit` 为空 —— 它们已经越过了
    //     backtest 门，所以不会因此被拒；但也**不会**被当成"过了过拟合判定"。
    //   · 若要它们重新具备凭据，正确做法是重跑一次 walk-forward，而不是回填。
    if (rec.overfit === undefined) rec.overfit = null
    const legacy = rec as unknown as { wfRobust?: unknown }
    if (legacy.wfRobust !== undefined) delete legacy.wfRobust
    // v1 时期落库的记录没有 testnetStats 字段。
    // 在这里归一化，而不是让每个读取点各自 `?? null` —— 否则「有没有这个字段」
    // 会变成调用方必须知道的历史知识，漏一处就是 undefined 静默进入判定。
    if (rec.testnetStats === undefined) rec.testnetStats = null
    // v2 时期的 testnetStats 没有尾部风险字段。**只补齐结构性字段、不伪造样本**：
    // 若把 returns 回填成空数组，"当时没记"与"记了但样本不足"就被混为一谈，
    // 而后者是要被 fail-closed 拒绝的。保留空数组即等同于"样本不足"，
    // 于是老记录进入裁定时会走 ⑤ 的拒绝分支 —— 这是有意的：口径不完整的
    // 历史实测不足以支撑"准入已通过"，重跑一次实测的成本远低于一次误放行。
    if (rec.testnetStats) {
      if (!Array.isArray(rec.testnetStats.returns)) rec.testnetStats.returns = []
      if (rec.testnetStats.cvarLossPct === undefined) rec.testnetStats.cvarLossPct = null
      if (rec.testnetStats.worstSingleLossPct === undefined) rec.testnetStats.worstSingleLossPct = null
    }
    this.records.set(rec.id, rec)
  }

  list(): StrategyRecord[] {
    return [...this.records.values()]
  }

  private transition(rec: StrategyRecord, to: Stage, ts: number, reason: string): void {
    rec.history.push({ ts, from: rec.stage, to, reason })
    rec.stage = to
  }

  evaluateBacktestGate(id: string, input: BacktestGateInput, ts: number): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'candidate') throw new Error(`INVALID_TRANSITION:${rec.stage}→gate`)
    this.assertFitnessVersion(input.fitness.version)

    if (input.fitness.value < this.cfg.minFitness) {
      this.transition(rec, 'rejected', ts, `fitness ${input.fitness.value} < ${this.cfg.minFitness}`)
      return rec.stage
    }

    // ── 过拟合判定 ────────────────────────────────────────────────
    // 位置刻意在 fitness 之后、同质化之前：先证明"这条策略在样本外
    // 站得住"，再谈"候选集是否有多样性"。反过来会让一条过拟合的策略
    // 因为"候选集同质"而被拒 —— 那是把两种失败混为一谈。
    if (this.cfg.requireOverfit) {
      // ① 结构完整性：缺字段 / 版本不符 / 长度不符 ★先于★ 任何数值比较。
      //    顺序不能反：先比数值再验结构，意味着一个畸形凭据的
      //    `pbo: 0.01` 会被当真，然后才因为别的字段缺失被拒 ——
      //    中间那一步已经污染了判定叙事。
      const structural = verifyOverfitReceipt(input.overfit)
      if (structural.length > 0) {
        this.transition(
          rec,
          'rejected',
          ts,
          `过拟合凭据不可用（${structural.length} 项）：${structural.slice(0, 3).join('；')} —— ` +
            '无从判断，按不放行处理（缺证据 ≠ 无风险）',
        )
        return rec.stage
      }
      // ② 用**本流水线的阈值**判定。凭据里没有结论字段，所以
      //    调用方即使能构造凭据，也无法把"不达标"说成"达标"。
      const verdict = judgeOverfit(input.overfit, this.cfg.overfit)
      if (!verdict.pass) {
        this.transition(rec, 'rejected', ts, `过拟合判定不通过：${verdict.summary}`)
        return rec.stage
      }
      rec.overfit = {
        outcome: verdict.outcome,
        summary: verdict.summary,
        pbo: input.overfit.pbo,
        avgWinnerW: input.overfit.avgWinnerW,
        folds: input.overfit.folds,
        candidates: input.overfit.candidates,
        dataHash: input.overfit.dataHash,
        receipt: input.overfit,
      }
    }

    if (this.cfg.forbidHomogeneousPurity && input.purityHomogeneous) {
      this.transition(rec, 'rejected', ts, '候选同质化')
      return rec.stage
    }
    rec.fitness = input.fitness
    rec.purityHomogeneous = input.purityHomogeneous
    const ofit = rec.overfit
    this.transition(
      rec,
      'paper_observing',
      ts,
      `backtest 门通过 · fitness=${input.fitness.value}` +
        (ofit ? ` · PBO=${ofit.pbo === null ? 'n/a' : (ofit.pbo * 100).toFixed(1) + '%'}` : ' · 未启用过拟合判定'),
    )
    return rec.stage
  }

  recordPaperTrade(id: string, ts: number): void {
    const rec = this.get(id)
    if (rec.stage !== 'paper_observing') throw new Error(`INVALID_TRANSITION:${rec.stage}→paper_trade`)
    if (!rec.paperStats) rec.paperStats = { firstTradeTs: ts, trades: 0, maxDrawdownPct: 0 }
    if (rec.paperStats.firstTradeTs === null) rec.paperStats.firstTradeTs = ts
    rec.paperStats.trades += 1
  }

  recordPaperDrawdown(id: string, drawdownPct: number): void {
    const rec = this.get(id)
    if (rec.stage !== 'paper_observing') throw new Error(`INVALID_TRANSITION:${rec.stage}→paper_dd`)
    if (!rec.paperStats) rec.paperStats = { firstTradeTs: null, trades: 0, maxDrawdownPct: 0 }
    rec.paperStats.maxDrawdownPct = Math.max(rec.paperStats.maxDrawdownPct, drawdownPct)
  }

  closePaperObservation(id: string, ts: number): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'paper_observing') throw new Error(`INVALID_TRANSITION:${rec.stage}→close_paper`)
    const ps = rec.paperStats
    if (!ps || ps.trades < this.cfg.paperMinTrades) {
      this.transition(rec, 'rejected', ts, `纸交易笔数不足 (${ps?.trades ?? 0} < ${this.cfg.paperMinTrades})`)
      return rec.stage
    }
    if (ps.maxDrawdownPct > this.cfg.paperMaxDrawdownPct) {
      this.transition(rec, 'rejected', ts, `纸交易回撤超限 (${ps.maxDrawdownPct}% > ${this.cfg.paperMaxDrawdownPct}%)`)
      return rec.stage
    }
    this.transition(rec, 'ready_for_small_cap', ts, `观察期通过 · ${ps.trades} 笔 · 回撤 ${ps.maxDrawdownPct}%`)
    return rec.stage
  }

  approveSmallCap(id: string, approver: string, ts: number): Stage {
    const rec = this.get(id)
    // ⚠️ 前置条件从 `ready_for_small_cap` 改为 `testnet_verified`：
    // 「观察期通过」只证明它在纸面/回测里看着成立，**不证明它在真实撮合下能跑**。
    // 纸交易没有对手方拒单、没有滑点、没有资金费、没有最小下单量、没有非同步成交；
    // 这些恰恰是小资金实盘最先踩到的东西。所以人工审批只能审批**已经过测试网检验**的策略。
    if (rec.stage !== 'testnet_verified') {
      throw new Error(
        `INVALID_TRANSITION:${rec.stage}→approve（必须先通过测试网实测：ready_for_small_cap → testnet_verifying → testnet_verified）`,
      )
    }
    if (!approver) throw new Error('APPROVER_REQUIRED')
    rec.approvedBy = approver
    rec.capUsd = this.cfg.smallCapUsd
    const tn = rec.testnetStats
    const basis = tn
      ? `（测试网实测 ${tn.fills} 笔 · 观测 ${((tn.lastFillTs ?? ts) - (tn.firstFillTs ?? ts)) / 3_600_000 > 0 ? (((tn.lastFillTs ?? ts) - (tn.firstFillTs ?? ts)) / 3_600_000).toFixed(1) : '0'} 小时 · 回撤 ${tn.maxDrawdownPct}% · 场所 ${tn.venue ?? '未记录'}）`
      : ''
    this.transition(
      rec,
      'small_cap_live',
      ts,
      `人工审批 by ${approver} · 资金帽 ${this.cfg.smallCapUsd} USDC${basis}`,
    )
    return rec.stage
  }

  // ─────────────────────────────────────────────────────────────
  // 测试网实测（真钱之前的最后一道实证）
  //
  // 位置：ready_for_small_cap → testnet_verifying → testnet_verified → small_cap_live
  //
  // 为什么必须是**独立阶段**而不是"回测里加严一点"：
  //   回测与纸交易共用一个假设世界的模型，它们的"通过"只能证明**策略逻辑自洽**；
  //   测试网接的是真实撮合、真实最小下单量、真实费率与资金费、真实拒单语义，
  //   通过它才能证明**执行链路在真实场所成立**。这两件事的失效方式完全不同，
  //   用同一道门去守，必然漏掉后者。
  // ─────────────────────────────────────────────────────────────

  /** 进入测试网实测。前置：观察期已通过。 */
  beginTestnetVerification(id: string, ts: number, venue: string): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'ready_for_small_cap') {
      throw new Error(`INVALID_TRANSITION:${rec.stage}→testnet_verifying`)
    }
    if (!venue) throw new Error('TESTNET_VENUE_REQUIRED')
    rec.testnetStats = emptyTestnetStats(venue)
    this.transition(rec, 'testnet_verifying', ts, `进入测试网实测 · 场所 ${venue}`)
    return rec.stage
  }

  /** 记一笔测试网成交。只有成交才算样本——订单被拒不是样本。 */
  recordTestnetFill(id: string, ts: number): void {
    const rec = this.get(id)
    if (rec.stage !== 'testnet_verifying') throw new Error(`INVALID_TRANSITION:${rec.stage}→testnet_fill`)
    const st = rec.testnetStats ?? emptyTestnetStats(null)
    if (st.firstFillTs === null) st.firstFillTs = ts
    st.lastFillTs = ts
    st.fills += 1
    rec.testnetStats = st
  }

  /**
   * 记一笔测试网平仓收益（%）。**必须与 `recordTestnetFill` 配对调用。**
   *
   * 为什么要单独一个方法而不是塞进 `recordTestnetFill`：
   *   开仓成交与平仓收益是两个时点的事实 —— 开仓时收益还不存在。
   *   把两者绑在一起会逼调用方在开仓时编一个收益出来，
   *   那种"为了满足接口而凑的数据"会污染整个尾部统计。
   *
   * 为什么无收益样本必须导致拒绝（见 closeTestnetVerification ⑤）：
   *   如果缺样本时静默按"无尾部风险"处理，那么**不回传收益的策略
   *   会比老实回传的更安全** —— 这是一条反向激励，比缺一道门更危险。
   */
  recordTestnetReturn(id: string, returnPct: number): void {
    const rec = this.get(id)
    if (rec.stage !== 'testnet_verifying') throw new Error(`INVALID_TRANSITION:${rec.stage}→testnet_return`)
    if (!rec.testnetStats) throw new Error('TESTNET_NOT_BEGUN')
    if (!Number.isFinite(returnPct)) throw new Error(`TESTNET_RETURN_NOT_FINITE:${returnPct}`)
    const st = rec.testnetStats
    st.returns.push(returnPct)
    if (st.returns.length > TESTNET_RETURNS_CAP) st.returns.splice(0, st.returns.length - TESTNET_RETURNS_CAP)
    // 增量重算：尾部统计是**累计量**（每来一笔都可能改变最差 5% 的构成），
    // 只在新样本进来时更新，而不是让读取方各自算一遍（口径漂移的入口）。
    const summary = tailRiskSummary(st.returns, this.cfg.testnetTailAlpha)
    st.cvarLossPct = summary ? summary.cvarLossPct : null
    st.worstSingleLossPct = worstSingleLossPct(st.returns)
    // 回撤也由序列复利还原，与人工上报的 maxDrawdownPct 取更悲观者：
    // 上报值可能来自不同口径（例如按分钟权益而非按笔），两者不一致时以更坏的为准。
    const derived = maxDrawdownFromReturns(st.returns)
    if (derived !== null) st.maxDrawdownPct = Math.max(st.maxDrawdownPct, derived)
  }

  recordTestnetDrawdown(id: string, drawdownPct: number): void {
    const rec = this.get(id)
    if (rec.stage !== 'testnet_verifying') throw new Error(`INVALID_TRANSITION:${rec.stage}→testnet_dd`)
    if (!rec.testnetStats) throw new Error('TESTNET_NOT_BEGUN')
    rec.testnetStats.maxDrawdownPct = Math.max(rec.testnetStats.maxDrawdownPct, drawdownPct)
  }

  /**
   * 记一次违规。**一票否决，不参与收益折算。**
   *
   * 什么样的算违规：风控/拦截管线出现"本不该发生"的行为（例如止损被跳过、预留被误释放）、
   * 对账出现金额漂移、订单状态无法归类（unknown）、资金帽被越界占用等。
   * 判定标准是**语义**而不是金额：一次 $0.01 的对账不平，与一次 $1000 的，
   * 暴露的是同一个系统缺陷，所以在这里它们权重相同。
   */
  recordTestnetViolation(id: string, reason: string): void {
    const rec = this.get(id)
    if (rec.stage !== 'testnet_verifying') throw new Error(`INVALID_TRANSITION:${rec.stage}→testnet_violation`)
    if (!rec.testnetStats) throw new Error('TESTNET_NOT_BEGUN')
    rec.testnetStats.violations += 1
    rec.testnetStats.violationReasons.push(reason)
    // 只留最近 10 条：留痕是为了定位，不是为了完整归档（归档走审计事件）
    if (rec.testnetStats.violationReasons.length > 10) rec.testnetStats.violationReasons.shift()
  }

  /**
   * 结束测试网实测并裁定。
   *
   * 五道判定**都必须满足**，任一不满足即 rejected（不是"部分通过"）：
   *   ① 零违规 —— 违规不是"风险"，是**系统还没准备好**；
   *   ② 成交笔数 ≥ 下限 —— 样本不足时"跑通了"与"没跑到"无法区分；
   *   ③ 观测时长 ≥ 下限 —— 防"几分钟内刷够笔数"的形式达标；
   *   ④ 回撤不超限 —— 实测期就爆回撤的策略，进实盘只会更快爆；
   *   ⑤ **尾部平均损失不超限（CVaR）** —— 回撤看不见尾部形状，
   *      一个"平时小赚、亏损集中在少数几笔"的策略可以回撤很浅却极易一次归零。
   *      缺样本时**拒绝**而不是放行：否则不回传收益的策略反而更安全（反向激励）。
   */
  closeTestnetVerification(id: string, ts: number): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'testnet_verifying') throw new Error(`INVALID_TRANSITION:${rec.stage}→close_testnet`)
    const st = rec.testnetStats
    if (!st) {
      this.transition(rec, 'rejected', ts, '测试网实测未开始')
      return rec.stage
    }

    if (st.violations > 0) {
      this.transition(
        rec,
        'rejected',
        ts,
        `测试网实测出现 ${st.violations} 次违规（一票否决）：${st.violationReasons.slice(-3).join('；')}`,
      )
      return rec.stage
    }

    if (st.fills < this.cfg.testnetMinFills) {
      this.transition(rec, 'rejected', ts, `测试网实测成交笔数不足 (${st.fills} < ${this.cfg.testnetMinFills})`)
      return rec.stage
    }

    const observedHours = ((st.lastFillTs ?? ts) - (st.firstFillTs ?? ts)) / 3_600_000
    if (observedHours < this.cfg.testnetMinHours) {
      this.transition(
        rec,
        'rejected',
        ts,
        `测试网实测观测时长不足 (${observedHours.toFixed(2)}h < ${this.cfg.testnetMinHours}h)：防短时间刷笔数形式达标`,
      )
      return rec.stage
    }

    if (st.maxDrawdownPct > this.cfg.testnetMaxDrawdownPct) {
      this.transition(
        rec,
        'rejected',
        ts,
        `测试网实测回撤超限 (${st.maxDrawdownPct}% > ${this.cfg.testnetMaxDrawdownPct}%)`,
      )
      return rec.stage
    }

    // ⑤ 尾部风险。缺样本 = 拒绝（fail-closed），不是放行。
    if (st.cvarLossPct === null || st.returns.length < 2) {
      this.transition(
        rec,
        'rejected',
        ts,
        `测试网实测缺少尾部风险样本（逐笔收益 ${st.returns.length} 条）：无法评估 CVaR，按默认拒绝处理`,
      )
      return rec.stage
    }
    if (st.cvarLossPct > this.cfg.testnetMaxCvarPct) {
      this.transition(
        rec,
        'rejected',
        ts,
        `测试网实测尾部平均损失超限 (CVaR ${st.cvarLossPct.toFixed(2)}% > ${this.cfg.testnetMaxCvarPct}%，` +
          `最差 ${(this.cfg.testnetTailAlpha * 100).toFixed(0)}% 分位；单笔最大亏损 ${(st.worstSingleLossPct ?? 0).toFixed(2)}%)`,
      )
      return rec.stage
    }

    this.transition(
      rec,
      'testnet_verified',
      ts,
      `测试网实测通过 · ${st.fills} 笔 · 观测 ${observedHours.toFixed(1)}h · 回撤 ${st.maxDrawdownPct.toFixed(2)}%` +
        ` · CVaR ${st.cvarLossPct.toFixed(2)}%≤${this.cfg.testnetMaxCvarPct}% · 零违规 · 场所 ${st.venue ?? '未记录'}`,
    )
    return rec.stage
  }

  promoteFull(id: string, ts: number): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'small_cap_live') throw new Error(`INVALID_TRANSITION:${rec.stage}→full`)
    this.transition(rec, 'full_live', ts, '小资金阶段达标 · 解除资金帽')
    rec.capUsd = null
    return rec.stage
  }

  rollback(id: string, ts: number, reason: string): Stage {
    const rec = this.get(id)
    if (rec.stage === 'rolled_back' || rec.stage === 'candidate' || rec.stage === 'rejected') {
      throw new Error(`INVALID_TRANSITION:${rec.stage}→rollback`)
    }
    rec.rolledBackToStage = rec.stage
    this.transition(rec, 'rolled_back', ts, reason)
    return rec.stage
  }

  restoreFromRollback(id: string, ts: number): Stage {
    const rec = this.get(id)
    if (rec.stage !== 'rolled_back' || !rec.rolledBackToStage) throw new Error(`INVALID_TRANSITION:${rec.stage}→restore`)
    const target = rec.rolledBackToStage
    rec.rolledBackToStage = null
    this.transition(rec, target, ts, '回滚恢复')
    return rec.stage
  }

  private assertFitnessVersion(version: string): void {
    if (version !== this.cfg.fitnessVersion) {
      throw new Error(`FITNESS_VERSION_MISMATCH:${version} != ${this.cfg.fitnessVersion}`)
    }
  }
}
