/**
 * 任务服务：把真实系统状态喂给裁定器，并把结论写进账本
 *
 * ── 这一层的唯一职责 ────────────────────────────────────────────────
 * `goal.ts` 只认字，`feasibility.ts` 只认数。真实状态从哪来、结论往哪去，
 * 全部收在本文件里。这样裁定核心可以离线复算，而"系统现在到底什么状态"
 * 只有一处解释权。
 *
 * ── 过拟合门的结论从**账本**读，不从自报字段读 ────────────────────────
 * 这是本项目反复复现的一类 P0（F-41 自报布尔量 / F-44 自报样本量）：
 * 一个模块自己说"我过了门"，比"门说它过了"弱得多。
 * 所以这里不读任何内存标志，而是**倒着扫账本**，从
 * `AUTOPILOT_OVERFIT_GATE` / `AUTOPILOT_OPTIMIZE_REFUSED` /
 * `AUTOPILOT_STRATEGY_SELECTED` 的 payload 里还原最近一次结论。
 *
 * 其中有一条特别重要：**pin 绕过门不算通过。**
 * `AUTOPILOT_STRATEGY_SELECTED` 带 `overfitGate: 'bypassed-by-pin'` 时，
 * 账本写的是"这个冠军是人指定的"，不是"它过了门"。
 * 把两者读成同一个"pass:true"，会让 `AUTOPILOT_PINNED_STRATEGY` 变成
 * 一条绕过整条自进化线的后门 —— 而它在账本里留下的痕迹明明写着"绕过了"。
 */
import { getOrchState } from '../core.ts'
import { currentEquity } from '../risk.ts'
import { autopilotStatus, AUTOPILOT_TARGET_MAX_PCT, startAutopilot } from '../autopilot.ts'
import { maxSafeLeverageDetail } from '../positionGuard.ts'
import { appendEvent, getEvents } from '../ledger.ts'
import { DEFAULT_OVERFIT_THRESHOLDS } from '../../src/engine/overfit.ts'
import {
  DAILY_LOSS_EQUITY_RATIO,
  LEVERAGE_HARD_CEILING,
  MAX_LEVERAGE,
  MAX_MARGIN_EQUITY_RATIO,
  MIN_MARGIN_USDT,
  MIN_RISK_REWARD_RATIO,
  MIN_VIABLE_NOTIONAL_CEX_USDT,
  RISK_PER_TRADE_RATIO,
  STOP_SAFETY_PCT_MIN,
} from '../riskConstants.ts'
import { looksLikeMission, parseGoal, type GoalContext } from './goal.ts'
import { assessMission, speakPlan } from './feasibility.ts'
import {
  checkStartConsent,
  consumeStartConsent,
  issueStartConsent,
  pendingStartConsent,
  speakStartConsent,
  type ConsentView,
  type IssueStartConsentResult,
} from './consent.ts'
import { appendOnlyVerdict, bindMissionLine, redactSecrets, type MissionLine, type RedactReport } from './asset.ts'
import type { MissionEnv, MissionPlan, MissionSpec } from './types.ts'

export interface OverfitState {
  outcome: string
  pbo: number | null
  maxPbo: number
  passed: boolean
  at: number
  /** 结论是从哪条事件读出来的。留痕是为了让"结论怎么来的"可被核对。 */
  sourceEvent: string
}

/**
 * 从账本还原最近一次过拟合门结论。
 *
 * 返回 `null` = **从没跑过门**。它和"跑了但证据不足"是两件事：
 * 前者说明这批数据从未被检验，后者说明检验了但样本不够。
 * 两者都不放行，但给用户的下一步动作不同（前者先跑一次，后者攒样本）。
 */
export function overfitState(): OverfitState | null {
  const evs = getEvents(0)
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const e = evs[i]
    if (e.kind === 'AUTOPILOT_OVERFIT_GATE') {
      return {
        outcome: String(e.payload.outcome ?? 'UNKNOWN'),
        pbo: typeof e.payload.pbo === 'number' ? e.payload.pbo : null,
        maxPbo: DEFAULT_OVERFIT_THRESHOLDS.maxPbo,
        passed: e.payload.pass === true,
        at: e.ts,
        sourceEvent: e.kind,
      }
    }
    if (e.kind === 'AUTOPILOT_OPTIMIZE_REFUSED') {
      return {
        outcome: String(e.payload.outcome ?? 'UNKNOWN'),
        pbo: typeof e.payload.pbo === 'number' ? e.payload.pbo : null,
        maxPbo: DEFAULT_OVERFIT_THRESHOLDS.maxPbo,
        passed: false,
        at: e.ts,
        sourceEvent: e.kind,
      }
    }
    if (e.kind === 'AUTOPILOT_STRATEGY_SELECTED') {
      // pin 绕过：账本明确记着"绕过了"，所以**不是**通过。
      if (e.payload.overfitGate === 'bypassed-by-pin') {
        return {
          outcome: 'BYPASSED_BY_PIN',
          pbo: null,
          maxPbo: DEFAULT_OVERFIT_THRESHOLDS.maxPbo,
          passed: false,
          at: e.ts,
          sourceEvent: e.kind,
        }
      }
      const ov = e.payload.overfit as { outcome?: string; pbo?: number | null } | undefined
      if (ov) {
        return {
          outcome: String(ov.outcome ?? 'UNKNOWN'),
          pbo: typeof ov.pbo === 'number' ? ov.pbo : null,
          maxPbo: DEFAULT_OVERFIT_THRESHOLDS.maxPbo,
          passed: true,
          at: e.ts,
          sourceEvent: e.kind,
        }
      }
    }
  }
  return null
}

/**
 * 当前系统状态的裁定输入。
 *
 * `stopPct` 刻意取**最紧的止损垫**（`EV_STOP_SAFETY_PCT_MIN`）而不是实时 ATR：
 * 这样算出来的"所需最小本金"是**最乐观**的那个数。
 * 连最乐观的都过不了，就不必再讨论波动大时会更差 ——
 * 反过来取实时的 ATR 会得到一个"随行情变化"的结论，
 * 而任务裁定需要的是"这个本金结构上行不行"，不是"此刻行不行"。
 */
export function missionEnvNow(): MissionEnv {
  const s = getOrchState()
  const equity = currentEquity(s)
  const stopPct = STOP_SAFETY_PCT_MIN
  const lev = maxSafeLeverageDetail(stopPct)
  return {
    // 订单真的去哪儿 —— 由 attachVenue 的 VENUE 决定，不是 AUTOPILOT_VENUE
    wiredVenue: (process.env.VENUE ?? 'sandbox').toLowerCase(),
    accountingVenue: process.env.AUTOPILOT_VENUE ?? 'binance',
    autopilotLive: (process.env.AUTOPILOT_LIVE ?? 'false').toLowerCase() === 'true',
    instType: (process.env.AUTOPILOT_INST_TYPE ?? 'SPOT').toUpperCase() === 'SWAP' ? 'SWAP' : 'SPOT',
    equity,
    stopPct,
    riskPerTradeRatio: RISK_PER_TRADE_RATIO,
    minRiskReward: MIN_RISK_REWARD_RATIO,
    dailyLossEquityRatio: DAILY_LOSS_EQUITY_RATIO,
    autoTargetMaxPct: AUTOPILOT_TARGET_MAX_PCT,
    maxMarginEquityRatio: MAX_MARGIN_EQUITY_RATIO,
    minViableNotionalCex: MIN_VIABLE_NOTIONAL_CEX_USDT,
    minMarginUsdt: MIN_MARGIN_USDT,
    maxSafeLeverage: lev.applied,
    maxSafeLeverageRaw: lev.raw,
    maxLeverage: MAX_LEVERAGE,
    leverageHardCeiling: LEVERAGE_HARD_CEILING,
    overfit: overfitState(),
  }
}

export interface MissionPlanResult {
  /** 这句话是不是一个任务。不是的话 `plan` 为 null，由上层回落到普通意图。 */
  isMission: boolean
  spec: MissionSpec
  plan: MissionPlan | null
  /** 可直接朗读的中文结论。已**脱敏**。`feasible` 时会连启动口令一起念。 */
  spoken: string
  /** 脱敏报告。只有计数与**变量名**，永远没有值。 */
  redaction: RedactReport
  /**
   * 启动口令。**只有 `feasible` 才签发。**
   *
   * ★ 这条边界是这道口令的全部意义所在：它放行的是「现在动手」，
   *   不是「目标成立」。目标本身有硬矛盾时给它一份口令，
   *   等于配了一把能开一扇不存在的门的钥匙 ——
   *   用户拿着它反复念，只会收到一串与目标无关的拒绝理由。
   *
   * `code` 明文**只在这一刻存在**：服务端只留哈希，账本连哈希都不写。
   * 为 null 时前端不该渲染启动入口。
   */
  consent: IssueStartConsentResult | null
}

/**
 * 裁定一句话。
 *
 * `specIn` 是给意图层已经解析好的 spec 留的口子：解析只做一次，
 * 否则两处可能给出不同的 spec（意图层判"是任务"、处理层判"缺槽位"），
 * 用户会先收到答应、再收到反问。
 *
 * 落账时写的是**脱敏后**的原话：用户的诉求本身可能夹着刚粘贴的密钥或 webhook，
 * 而账本是全系统最持久、最可能被导出的地方。
 * 把脱敏放在写盘**之前**（而不是导出时）是刻意的 ——
 * 导出出口会不断增加，而进账口只有这一个。
 */
export function planMission(text: string, ctx: GoalContext, specIn?: MissionSpec): MissionPlanResult {
  const spec = specIn ?? parseGoal(text, ctx)
  const redaction = redactSecrets(text)

  if (!looksLikeMission(spec)) {
    return {
      isMission: false,
      spec,
      plan: null,
      spoken: '',
      redaction,
      consent: null,
    }
  }

  const env = missionEnvNow()
  const plan = assessMission(spec, env)
  // 签发口令放在这里，用户**同一刻**就拿到两样东西：结论 + 启动它的钥匙。
  // 分两步（先裁定、再另请求签发）会多出一个"钥匙还没到手"的中间态，
  // 而那个中间态里用户能做的只有等 —— 他没有别的动作可做。
  const consent = plan.verdict === 'feasible' ? issueStartConsent(plan.planId) : null
  const spoken = redactSecrets(
    speakPlan(plan) + (consent ? ' ' + speakStartConsent(consent) : ''),
  ).text

  appendEvent('MISSION_PLANNED', {
    planId: plan.planId,
    verdict: plan.verdict,
    goal: redaction.text,
    recognized: {
      venue: spec.venue,
      execution: spec.execution,
      symbol: spec.symbol,
      startNotional: spec.startNotional,
      targetNotional: spec.targetNotional,
      targetMultiple: spec.targetMultiple,
      deadlineMs: spec.deadlineMs,
      allowHighLeverage: spec.allowHighLeverage,
      explicitLeverage: spec.explicitLeverage,
      missing: spec.missing,
      confidence: spec.confidence,
    },
    reasons: plan.reasons.map((r) => ({ code: r.code, severity: r.severity, numbers: r.numbers ?? null })),
    sizing: plan.sizing,
    required: plan.required,
    env: {
      wiredVenue: env.wiredVenue,
      accountingVenue: env.accountingVenue,
      equity: env.equity,
      stopPct: env.stopPct,
      maxSafeLeverage: env.maxSafeLeverage,
      maxLeverage: env.maxLeverage,
      overfit: env.overfit,
    },
    // 脱敏计数进账本：让"这次任务资产里含过密钥"成为**可观测**的事实，
    // 而不是一条只在内存里存在、重启即消失的提醒。
    redactionHits: redaction.hits,
  })

  return { isMission: true, spec, plan, spoken, redaction, consent }
}

/** 供端点与面板使用的概览。 */
export function missionStatusView(): {
  env: MissionEnv
  autopilot: { running: boolean; stage: string; targetPct: number }
  overfitFromLedger: OverfitState | null
  targetMaxPct: number
  counts: { plans: number }
  /** 待用口令的元数据。**有意不含口令码**（明文不驻留、不重发）。 */
  consent: ConsentView | null
} {
  const ap = autopilotStatus()
  const rows = getEvents(0).filter((e) => e.kind === 'MISSION_PLANNED')
  return {
    env: missionEnvNow(),
    autopilot: { running: ap.running, stage: ap.stage, targetPct: ap.targetPct },
    overfitFromLedger: overfitState(),
    targetMaxPct: AUTOPILOT_TARGET_MAX_PCT,
    counts: { plans: rows.length },
    consent: pendingStartConsent(),
  }
}

// ───────────────────────── 执行腿：把裁定书变成一次启动 ─────────────────────────

/**
 * 当前被占用的执行线。
 *
 * 从**账本**读而不是只放内存里：进程重启后内存归零，而"这份裁定书已经
 * 启动过一次"是**持久事实**。只放内存会让"重启一下就能再启动一次"变成一个
 * 绕过"一次裁定一次许可"的后门 —— 而这类后门永远不会被日志发现。
 */
function boundLine(planId: string): MissionLine | null {
  const evs = getEvents(0)
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const e = evs[i]
    if (e.kind !== 'MISSION_STARTED') continue
    if (String(e.payload.planId ?? '') !== planId) continue
    return { planId, runId: String(e.payload.runId ?? ''), boundAt: e.ts }
  }
  return null
}

export interface MissionStartInput {
  /**
   * 面板通道会带上（它手里有裁定书 id）。
   * 语音通道**不带** —— 人不会去念一串内容哈希。留空则以口令自己绑定的那份为准。
   */
  planId?: string
  /** 固定口令词所在的整句（如「确认启动 4821」）。 */
  phrase: string
  /** 待识别的那句话。口令码可能混在别的话里，见 `heardStartCode`。 */
  code: string
}

export interface MissionStartOutcome {
  ok: boolean
  /** 稳定机器标识。文案改它不变。 */
  code?: string
  reason?: string
  plan?: MissionPlan
  /** 二次判定的结论。与传入的 planId 不一致时说明**条件已经变了**。 */
  reassessedPlanId?: string
  started?: boolean
  /** 口令还剩几次机会（0 = 已作废）。原样交给前端，不做二次加工。 */
  remainingAttempts?: number
}

/**
 * 启动一份已裁定的任务。
 *
 * ── 顺序是有讲究的：先许可，再事实，最后动手 ──────────────────────────
 *   ① **口令**（许可）。排在第一位不是形式：下面每一步都会产生副作用
 *      （写账本、占执行线、最后真的把循环起起来）。没有许可就不该有副作用。
 *   ② **二次裁定**（事实）。`planId` 是内容地址（由「影响结论的字段」算出）。
 *      所以重新裁定后 id 与传进来的**不一致** ⇔ 环境（权益 / 场所 / 止损垫 /
 *      过拟合结论）已经变了 ⇔ 当初那份"可行"的结论**已经过期**。
 *      此时若照旧启动，用户拿到的是一次"引用的是 A 时点的评估、实际跑在 B 时点"
 *      的执行 —— 引用与被引用物脱钩，而引用者无法察觉。
 *      这正是 AgentGit「已发布历史不可变」那条红线在任务层的同形。
 *   ③ **占用执行线**，然后才启动。与 `autopilot.ts` 的"预留先行"同一条理由：
 *      先落账再动手，崩溃时会留下一个**可见的**占用，而不是一次无记录的执行。
 *
 * ── 口令为什么在最后一步才消费 ────────────────────────────────────────
 * ② 里的任何一条拒绝（条件过期 / 不可行 / 线已被占）都**不该吃掉用户的许可** ——
 * 否则他得重新裁定拿新口令再念一遍，而每一步都可能撞上另一个拒绝。
 * 许可只在"只剩启动这一件不可逆的事"时消费（见 `consumeStartConsent`）。
 *
 * ── 失败分类 ─────────────────────────────────────────────────────────
 * 与 `autopilot.classifyOrderFailure` 同口径：只有"明确没启动"
 * （已在跑 / 熔断 / 参数越界）才释放执行线；其余失败**继续占用**
 * （我们不知道启动到底有没有发生），要重来请重新裁定。
 * 宁可让用户多走一步，也不要留下一次无法对账的启动。
 */
export async function startMissionByPlan(input: MissionStartInput, ctx: GoalContext): Promise<MissionStartOutcome> {
  // ① 许可。任何一条口令拒绝都在这里落地，且**不留任何别的痕迹**。
  const consent = checkStartConsent({ phrase: input.phrase, code: input.code, planId: input.planId })
  if (!consent.ok) {
    appendEvent('MISSION_START_REFUSED', { planId: input.planId ?? null, code: consent.code })
    return {
      ok: false,
      code: consent.code,
      reason: consent.message,
      remainingAttempts: consent.remainingAttempts,
    }
  }
  // 语音通道没传 planId，权威来源是"口令绑定的那一份" —— 不是调用方说的那一份。
  const planId = consent.planId

  const evs = getEvents(0)
  let record: { goal: string; at: number } | null = null
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const e = evs[i]
    if (e.kind !== 'MISSION_PLANNED') continue
    if (String(e.payload.planId ?? '') !== planId) continue
    record = { goal: String(e.payload.goal ?? ''), at: e.ts }
    break
  }
  if (!record) {
    return { ok: false, code: 'PLAN_NOT_FOUND', reason: '账本里没有这个裁定书：' + planId }
  }

  const spec = parseGoal(record.goal, ctx)
  const fresh = assessMission(spec, missionEnvNow())

  if (fresh.planId !== planId) {
    appendEvent('MISSION_START_REFUSED', { planId, code: 'PLAN_STALE', freshPlanId: fresh.planId })
    return {
      ok: false,
      code: 'PLAN_STALE',
      reassessedPlanId: fresh.planId,
      plan: fresh,
      reason:
        '裁定条件已经变了（权益 / 场所 / 止损垫 / 过拟合门其中之一），' +
        '这份裁定书不再代表当前能否做成。请重新裁定再启动 —— 直接启动会让' +
        '"引用的是当时那份评估、实际跑在现在的条件上"这件事无法被察觉。',
    }
  }

  if (fresh.verdict !== 'feasible') {
    appendEvent('MISSION_START_REFUSED', { planId, code: 'PLAN_NOT_FEASIBLE', verdict: fresh.verdict })
    return {
      ok: false,
      code: 'PLAN_NOT_FEASIBLE',
      reassessedPlanId: fresh.planId,
      plan: fresh,
      reason: readBlocks(fresh),
    }
  }

  const now = Date.now()
  const runId = 'run-' + planId.slice(2, 10) + '-' + now.toString(36)
  const bind = bindMissionLine(planId, runId, boundLine(planId), now)
  if (!bind.ok) {
    appendEvent('MISSION_START_REFUSED', { planId, code: 'MISSION_LINE_ALREADY_BOUND', existingRun: bind.existing.runId })
    return { ok: false, code: 'MISSION_LINE_ALREADY_BOUND', reason: bind.reason, plan: fresh }
  }

  const targetPct = fresh.targetPct !== null && fresh.targetPct > 0 ? fresh.targetPct : fresh.alternative?.targetPct ?? 0
  if (!(targetPct > 0) || targetPct > AUTOPILOT_TARGET_MAX_PCT) {
    appendEvent('MISSION_START_REFUSED', { planId, code: 'NO_USABLE_TARGET', targetPct })
    return { ok: false, code: 'NO_USABLE_TARGET', reason: '没有可用的目标百分比（' + targetPct + '）', plan: fresh }
  }

  // ★ 口令在**这里**消费：上面所有可能失败的分支都已走完，
  //   下面只剩"启动"这一件不可逆的事。放在更早的位置会让一次
  //   与口令无关的拒绝（条件过期、线被占）白白吃掉用户的许可。
  consumeStartConsent(planId)

  appendEvent('MISSION_STARTED', {
    planId,
    runId,
    targetPct,
    venue: fresh.spec.venue,
    execution: fresh.spec.execution,
    startNotional: fresh.spec.startNotional,
    deadlineMs: fresh.spec.deadlineMs,
  })

  const started = await startAutopilot(targetPct)
  if (!started.ok) {
    // 与 `autopilot.classifyOrderFailure` 同口径：只有"明确没启动"才释放占用。
    const known = ['ALREADY_RUNNING', 'KILLSWITCH_ACTIVE', 'AUTOPILOT_NOT_CONFIGURED'].some((k) =>
      String(started.reason ?? '').includes(k),
    )
    appendEvent('MISSION_START_FAILED', {
      planId,
      runId,
      reason: started.reason ?? null,
      lineReleased: known,
      note: known ? '明确未启动，执行线已释放' : '启动结果未知，执行线继续占用（要重来请重新裁定）',
    })
    return {
      ok: false,
      code: known ? 'START_REFUSED_KNOWN' : 'START_OUTCOME_UNKNOWN',
      reason: started.reason,
      plan: fresh,
      started: false,
    }
  }

  return { ok: true, plan: fresh, started: true }
}

/**
 * 把裁定书里的"为什么不放行"拼成一句能念的话（供拒绝回话）。
 *
 * ★ 必须把 `hold`（证据不足）也算进来。
 * 只念 `block` 的话，`unverifiable` 的拒绝会回成一句"裁定结论不是可行" ——
 * 用户收到一个**没有理由**的拒绝，而真正的原因（"你少说了截止时间"）
 * 就摆在 `reasons` 里没被念出来。拒绝给不出理由，等于要求用户去猜。
 */
function readBlocks(plan: MissionPlan): string {
  const hard = plan.reasons.filter((r) => r.severity === 'block')
  const held = plan.reasons.filter((r) => r.severity === 'hold')
  const pick = hard.length > 0 ? hard : held
  return pick.length > 0
    ? pick.map((r) => r.text).join('')
    : '裁定结论不是可行（' + plan.verdict + '），但没有找到可念的理由 —— 这是异常，请查账本里的 MISSION_PLANNED。'
}

/**
 * 任务步骤流的仅追加校验（内化自 AgentGit 的前缀检查）。
 *
 * 账本事件已经是仅追加的，但**从账本派生出的一条"步骤序列"**不是：
 * 它由代码在读取时拼出来，于是"拼接逻辑变了"会让同一条执行线在不同时刻
 * 看到不同的步骤序列，而这不报错。校验方式是拿已提交的哈希序列
 * 与实时序列比对：前者必须是后者的前缀。
 */
export function missionStepsConsistent(committed: readonly string[], live: readonly string[]): boolean {
  return appendOnlyVerdict(committed, live) === 'prefix'
}
