/**
 * 目标裁定：用系统自己的尺子量一遍「这个目标做不做得到」
 *
 * ── 为什么"裁定"必须排在"执行"前面 ──────────────────────────────────
 * 如果直接开跑，用户看到的是一台看起来很忙、实际一步也走不动的机器：
 * 循环在 accumulating，门禁在拒绝，日志写着"正常"。他会以为系统在努力，
 * 而真相是这个目标在**第一笔**就被物理否掉了。
 *
 * 所以本模块的职责是：在启动任何循环之前，把目标拆到能被既有约束逐条检验，
 * 然后**如实说**哪一条先崩。结论必须是可被反驳的 ——
 * 「做不到」是判断，「需要 119 笔盈利、只剩 5 笔亏损额度」才是事实。
 *
 * ── 判据全部来自既有模块，本层不新立阈值 ─────────────────────────────
 *   · 1R 风险预算 `EV_RISK_PER_TRADE_RATIO`
 *   · 当日亏损熔断 `EV_DAILY_LOSS_EQUITY_RATIO`
 *   · 止损垫下限 `EV_STOP_SAFETY_PCT_MIN`
 *   · 安全杠杆 `positionGuard.maxSafeLeverage`（**现算后注入**，不重写公式）
 *   · 成本地板 `EV_MIN_VIABLE_NOTIONAL_CEX_USDT` / `EV_MIN_MARGIN_USDT`
 *   · 自动驾驶目标硬界（`startAutopilot` 的 0 < t ≤ 50）
 *   · 过拟合门结论
 * 新立一套"目标合理性阈值"等于造了第二份口径，两份迟早分岔。
 *
 * ── 三态，不是两态（fail-closed）──────────────────────────────────────
 *   `feasible`     有硬矛盾吗？没有 → 才可能到这里。
 *   `infeasible`   存在**确定的**硬矛盾（数已算清）。
 *   `unverifiable` 证据不足。**当前唯一来源是"缺槽位"**（用户少说了本金/目标/截止）。
 * **缺证据不等于可行** —— 缺失一律不放行，这与本项目 `claimValidator` /
 * `overfit` 的处置一致。
 *
 * ⚠️ 过拟合门**不在这三态里当闸门**。它守的是"进交易阶段"，不是"启动" ——
 * 详见下面 `collectReasons` 里那一段的推导。把它当启动闸的后果是死锁：
 * 启动被挡 ⇒ 累积起不来 ⇒ 证据攒不出 ⇒ 门永远不过。
 *
 * ★ 三态的**可实现性**由 `severity` 的档位保证：`hold` ≠ `block`（见 types.ts）。
 *   如果"缺槽位""门还没结论"这类理由被记成 `block`，判定就永远落在 `infeasible`，
 *   `unverifiable` 变成一条**走不到的分支** —— 而它在类型、文档、接口上看起来
 *   一切正常。这是本项目最高频的一类 P0：**一个不可能被命中的状态**。
 *   所以下面的 `verdict` 推导只数 `block`，`hold` 单独成档；烟测 S-M3 钉住这一点。
 *
 * ── 关于「高倍杠杆」这条最容易被误解的诉求 ────────────────────────────
 * 杠杆**不放大仓位**。仓位由 1R 风险预算与止损距离决定
 * （见 `positionGuard.sizePositionFromRisk` 的说明），杠杆只决定
 * 「同样大的仓位要压多少保证金」。所以"可以用高倍杠杆"这件事
 * 对"10U 赚到 100U"这个目标**在数学上没有贡献**，它只降低开仓所需的自有资金。
 * 这条必须以 `info` 级别如实讲出来，否则用户会以为阻力在"杠杆没给够"，
 * 于是反复去抬 `EV_MAX_LEVERAGE` —— 而那只会让止损先于强平失效。
 */
import type {
  MissionAlternative,
  MissionEnv,
  MissionPlan,
  MissionReason,
  MissionSizing,
  MissionSpec,
  MissionVerdict,
  RequiredTrades,
} from './types.ts'
import { missionContentId } from './asset.ts'

const HOUR_MS = 3_600_000

function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * 达标所需的交易量级。
 *
 * 推导（每一步都可复算）：
 *   ① 单笔盈利 = `minRiskReward` × 1R = 盈亏比 × 权益 × riskPerTradeRatio
 *   ② 单笔亏损 = 1R = 权益 × riskPerTradeRatio
 *   ③ 当日亏损熔断只给 `dailyLossEquityRatio` 的亏损预算
 *      ⇒ **一整天最多亏 maxLosses 笔**，第 maxLosses+1 笔连开都开不出来
 *   ④ 于是 `(1+winPct)^W × (1-lossPct)^maxLosses ≥ multiple`，解出 W 的下界
 *   ⑤ 隐含胜率下界 = W / (W + maxLosses)
 *
 * ★ 第 ③ 步是这个模型里最关键、也最容易被忽略的一条：
 * 亏损**是有额度的**，盈利没有。所以"多试几次总能成"在这里不成立 ——
 * 试错预算一天只有 maxLosses 次。
 */
export function requiredTradesOf(input: {
  winPct: number
  lossPct: number
  multiple: number
  maxLosses: number
  deadlineMs: number
}): RequiredTrades {
  const { winPct, lossPct, multiple, maxLosses, deadlineMs } = input
  const residual = multiple / Math.pow(1 - lossPct, maxLosses)
  const wins = residual <= 1 ? 0 : Math.log(residual) / Math.log(1 + winPct)
  // 减一个极小量再取上界：避免 `Math.ceil(119.00000000000001)` 这类浮点噪声
  // 把答案抬到 120 —— 这个数字会被念给用户听，多 1 笔就是一次误报。
  const requiredWins = Math.max(0, Math.ceil(wins - 1e-9))
  const total = requiredWins + maxLosses
  const impliedWinRate = total > 0 ? requiredWins / total : 1
  const hours = deadlineMs / HOUR_MS
  return {
    winPct,
    lossPct,
    maxLosses,
    requiredWins,
    impliedWinRate,
    winsPerHour: hours > 0 ? requiredWins / hours : Number.POSITIVE_INFINITY,
  }
}

/**
 * 第一笔仓位能不能开出来。
 *
 * 这一步比"赚不赚得到"更早、也更硬：如果第一笔就过不了成本地板，
 * 那么后面所有关于胜率与倍数的讨论都是空的 ——
 * 系统根本不会产生任何一笔成交，看起来却像在"努力等待机会"。
 */
export function planSizing(env: MissionEnv): MissionSizing | null {
  if (!(env.equity > 0) || !(env.stopPct > 0) || !(env.riskPerTradeRatio > 0)) return null
  const lev = Math.max(1, env.maxSafeLeverage)
  const riskBudget = env.equity * env.riskPerTradeRatio
  const notionalByRisk = riskBudget / env.stopPct
  const notionalByMargin = env.equity * env.maxMarginEquityRatio * lev

  let plannedNotional = notionalByRisk
  let binding = 'risk_budget'
  if (notionalByMargin < plannedNotional) {
    plannedNotional = notionalByMargin
    binding = 'margin_cap'
  }

  // 所需最小权益：两条路的约束取**严**的那个（即最大的那个下界）。
  // 用最紧的止损垫算，得到的是最乐观的数 —— 连它都不够就真的不够。
  const perNotionalByRisk = env.riskPerTradeRatio / env.stopPct
  const perNotionalByMargin = env.maxMarginEquityRatio * lev
  const minViableEquity =
    perNotionalByRisk > 0 && perNotionalByMargin > 0
      ? Math.max(env.minViableNotionalCex / perNotionalByRisk, env.minViableNotionalCex / perNotionalByMargin)
      : null

  return {
    riskBudget: round(riskBudget),
    notionalByRisk: round(notionalByRisk),
    notionalByMargin: round(notionalByMargin),
    plannedNotional: round(plannedNotional),
    binding,
    minViableNotional: env.minViableNotionalCex,
    minViableEquity: minViableEquity !== null ? round(minViableEquity) : null,
    maxSafeLeverage: round(env.maxSafeLeverage),
    configuredLeverage: round(env.maxLeverage),
  }
}

/** 组装理由列表。顺序刻意按"致命程度 × 出现早晚"排 —— 先说最先崩的那条。 */
function collectReasons(spec: MissionSpec, env: MissionEnv, sizing: MissionSizing | null): MissionReason[] {
  const reasons: MissionReason[] = []

  if (spec.missing.length > 0) {
    reasons.push({
      code: 'MISSING_SLOTS',
      // ★ `hold` 而不是 `block`：缺槽位**不是**硬矛盾，补齐就能重来。
      // 记成 block 的后果不是多报一次警，而是让 `unverifiable` 永远不可达 ——
      // 用户会收到"这个目标做不成"，而事实是"你少说了一个数"。
      severity: 'hold',
      text: '还有没说清的地方：' + spec.missing.join('、') + '。缺的地方我不会替你猜，请补一句。',
      numbers: { missing: spec.missing.length, slots: spec.missing.join(',') },
    })
  }

  if (spec.venue !== null && spec.venue !== env.wiredVenue) {
    reasons.push({
      code: 'VENUE_NOT_WIRED',
      severity: 'block',
      text:
        '这个任务要在 ' + spec.venue + ' 上跑，但编排层当前挂的场所是 ' + env.wiredVenue + '。' +
        '系统一次只挂一个场所（由 AUTOPILOT_VENUE 选定），我不会把任务悄悄挪到别的场所去跑 —— ' +
        '那会让你以为在做 A 场实测，实际记录属于 B 场。',
      numbers: { requested: spec.venue, wired: env.wiredVenue },
    })
  }

  /**
   * 成本口径与实际执行场所不一致 —— **如实告警，不阻断**。
   *
   * 为什么是 warn 而不是 block：它不影响这一笔去哪儿成交，
   * 只影响"成本算得对不对"。但它的症状极其隐蔽：
   * 成本闸门会一直给出看起来很合理的裁决，只是那些裁决建立在
   * 另一个市场的费率与滑点上。金额小时看不出来，金额大时差额是真的。
   */
  if (env.accountingVenue !== env.wiredVenue) {
    reasons.push({
      code: 'VENUE_ACCOUNTING_MISMATCH',
      severity: 'warn',
      text:
        '成本口径用的是 ' + env.accountingVenue + '，而订单实际挂在 ' + env.wiredVenue + '。' +
        '两者不一致时，成本闸门是在为另一个市场算成本（费率、滑点假设都不同）——' +
        '裁决看起来仍然合理，只是前提是错的。要一致请对齐 VENUE 与 AUTOPILOT_VENUE。',
      numbers: { accountingVenue: env.accountingVenue, wiredVenue: env.wiredVenue },
    })
  }

  if (spec.execution === 'live') {
    reasons.push({
      code: 'LIVE_REQUESTED',
      severity: env.autopilotLive ? 'info' : 'block',
      text: env.autopilotLive
        ? '这是实盘诉求，编排层当前已开实盘通路。'
        : '这是实盘诉求，但编排层当前不是实盘（AUTOPILOT_LIVE 未开）。真钱不会被自动打开 —— 本层不做这个决定。',
      numbers: { autopilotLive: String(env.autopilotLive) },
    })
  }

  const multiple = spec.targetMultiple
  if (multiple !== null && multiple <= 1) {
    reasons.push({
      code: 'TARGET_NOT_GROWTH',
      severity: 'block',
      text: '目标不高于起点（' + round(multiple, 3) + ' 倍），这不是一个增长任务。',
      numbers: { targetMultiple: round(multiple, 3) },
    })
  }

  // ── 硬界①：自动驾驶目标范围 ──
  if (multiple !== null && multiple > 1) {
    const targetPct = (multiple - 1) * 100
    if (targetPct > env.autoTargetMaxPct) {
      reasons.push({
        code: 'TARGET_ABOVE_AUTOPILOT_RANGE',
        severity: 'block',
        text:
          '目标 +' + round(targetPct, 1) + '% 超出自动驾驶接受的范围（0 ~ +' + env.autoTargetMaxPct + '%）。' +
          '这个上限不是保守，是"目标被用来判是否收工"——定得越高，循环越容易在还没收工时就被回撤保护打掉。',
        numbers: { targetPct: round(targetPct, 1), autoTargetMaxPct: env.autoTargetMaxPct },
      })
    }
  }

  // ── 硬界②：第一笔能不能开出来（比 ① 更早崩，但排在后面是因为它取决于本金） ──
  if (sizing) {
    const margin = sizing.plannedNotional / Math.max(sizing.maxSafeLeverage, 1)
    if (sizing.plannedNotional < sizing.minViableNotional) {
      reasons.push({
        code: 'FIRST_TRADE_BELOW_COST_FLOOR',
        severity: 'block',
        text:
          '第一笔就已经过不了成本门：按 1R=' + round(env.riskPerTradeRatio * 100, 2) + '% 与 ' +
          round(env.stopPct * 100, 2) + '% 的止损垫，' + round(env.equity, 2) + ' 的本金只能开出 ' +
          sizing.plannedNotional + ' 的名义本金，低于 CEX 最小可行规模 ' + sizing.minViableNotional + '。' +
          '也就是说：「一笔都开不出来」，与赚不赚得到无关。' +
          (sizing.minViableEquity !== null
            ? '要让第一笔刚好能开出来，本金至少要 ' + sizing.minViableEquity + '。'
            : ''),
        numbers: {
          equity: round(env.equity),
          riskBudget: sizing.riskBudget,
          stopPct: round(env.stopPct * 100, 2),
          plannedNotional: sizing.plannedNotional,
          minViableNotional: sizing.minViableNotional,
          binding: sizing.binding,
          minViableEquity: sizing.minViableEquity,
        },
      })
    } else if (margin < env.minMarginUsdt) {
      reasons.push({
        code: 'MARGIN_BELOW_MIN',
        severity: 'block',
        text:
          '这笔要占的保证金 ' + round(margin, 2) + ' 低于最小保证金 ' + env.minMarginUsdt + '，' +
          '保证金档位在这个本金下没有意义。',
        numbers: { margin: round(margin, 2), minMarginUsdt: env.minMarginUsdt },
      })
    }
  }

  // ── 门禁③：过拟合门 —— **它守的是「交易阶段」，不是「启动」** ────────────
  //
  // ★ 这一档的档位是本文件里最容易放错、也最值得写清的一处。
  //
  // 系统的尺子（`autopilot.ts`）是这么量的：目标越界就地拒绝；通过之后进入
  // `accumulating` 累积 K 线，**累积够量才去优化**，优化那一步才问过拟合门，
  // 门不给过就留在原地继续累积 —— F-47 明文写着"paper 自动驾驶会长期停在
  // accumulating，是正确行为不是 bug"。也就是说：**门挡的是"进交易阶段"，
  // 启动本身不被它挡。**
  //
  // 任务层若把它记成 `block`，就是在既有尺子之外自己加了一道更严的闸，
  // 违反本层硬约束①（不许另立一套口径）。而后果比"多一道闸"严重得多：
  //   启动被挡 ⇒ 累积阶段永远起不来 ⇒ 证据永远攒不出来 ⇒ 门永远过不了。
  // **这是个死锁，而且它伪装成"谨慎"。** 更糟的是它让 `feasible` 在真实
  // 数据下永不可达 —— 于是执行腿与启动口令都变成"不可能被命中的状态"，
  // 正是本项目复现 7 次的那类 P0。
  //
  // 所以一律 `warn`，并把后果如实说出来：可以启动，但在门给出结论前
  // 到不了交易阶段，这个窗口内很可能一笔都不会成交。
  // 用户要的是"知道会发生什么"，不是"被替他把话说死"。
  // 两种未通过的成因仍分开成不同的 code —— 因为**下一步动作不同**
  // （证据不足 → 攒样本；被拒 → 改策略或延长历史）。
  if (env.overfit === null) {
    reasons.push({
      code: 'OVERFIT_NEVER_RUN',
      severity: 'warn',
      text:
        '过拟合门还没有结论（这批数据从未跑过门）。这不挡启动 —— 启动的后果是进入累积阶段。' +
        '但在门给出结论之前，循环到不了交易阶段，这个窗口里很可能一笔都不会成交。',
      numbers: { ledgerConclusions: 0 },
    })
  } else if (!env.overfit.passed) {
    const insufficient = env.overfit.outcome === 'UNVERIFIABLE'
    reasons.push({
      code: insufficient ? 'OVERFIT_EVIDENCE_INSUFFICIENT' : 'OVERFIT_REFUSED',
      severity: 'warn',
      text: insufficient
        ? '过拟合门判定为证据不足（' + env.overfit.outcome + '）—— 不是"不行"，是"还不知道"。' +
          '按既有处置留在原地继续累积证据，不静默放行也不停机。' +
          '它同样拦在「进交易阶段」之前：启动后循环会停在累积阶段，到不了交易阶段，直到证据够。'
        : '过拟合门拒绝了这次策略选择（' + env.overfit.outcome + '，PBO ' +
          (env.overfit.pbo === null ? '未知' : round(env.overfit.pbo * 100, 1) + '%') +
          ' 高于上限 ' + round(env.overfit.maxPbo * 100, 1) + '%）。' +
          '它挡的是「进交易阶段」，不是启动：启动后循环会停在累积阶段，一笔也不会成交。' +
          '要真往前走，得先让门过 —— 把历史延长到 6~12 个月（npm run data:fetch），不是放宽阈值。',
      numbers: {
        outcome: env.overfit.outcome,
        pbo: env.overfit.pbo === null ? null : round(env.overfit.pbo * 100, 1),
        maxPbo: round(env.overfit.maxPbo * 100, 1),
      },
    })
  } else {
    reasons.push({
      code: 'OVERFIT_GATE_PASSED',
      severity: 'info',
      text: '过拟合门已有通过结论，启动后循环可以走到交易阶段。',
      numbers: {
        outcome: env.overfit.outcome,
        pbo: env.overfit.pbo === null ? null : round(env.overfit.pbo * 100, 1),
      },
    })
  }

  // ── 数学要求（warn：它本身不是闸门，但读的人必须知道量级）──
  if (multiple !== null && multiple > 1) {
    const maxLosses = Math.floor(env.dailyLossEquityRatio / env.riskPerTradeRatio)
    const req = requiredTradesOf({
      winPct: env.minRiskReward * env.riskPerTradeRatio,
      lossPct: env.riskPerTradeRatio,
      multiple,
      maxLosses,
      deadlineMs: spec.deadlineMs ?? 0,
    })
    reasons.push({
      code: 'WINRATE_FLOOR_REQUIRED',
      severity: 'warn',
      text:
        '就算前面每一道门都放行，数学上还需要 ' + req.requiredWins + ' 笔盈利，' +
        '而一整天最多只允许亏 ' + maxLosses + ' 笔（当日亏损熔断 ' +
        round(env.dailyLossEquityRatio * 100, 1) + '% ÷ 单笔 ' + round(env.riskPerTradeRatio * 100, 2) + '%）。' +
        '也就是隐含胜率不低于 ' + round(req.impliedWinRate * 100, 1) + '%。' +
        (spec.deadlineMs
          ? '摊到窗口上等于每小时要打出 ' + round(req.winsPerHour, 1) + ' 笔盈利。'
          : ''),
      numbers: {
        requiredWins: req.requiredWins,
        maxLosses,
        impliedWinRatePct: round(req.impliedWinRate * 100, 1),
        winsPerHour: spec.deadlineMs ? round(req.winsPerHour, 1) : null,
      },
    })
  }

  // ── 杠杆的真相（info：这条最容易被误解成"阻力在杠杆没给够"）──
  if (spec.allowHighLeverage) {
    const geometryNotConfig = env.maxSafeLeverageRaw > env.maxLeverage
    reasons.push({
      code: 'LEVERAGE_DOES_NOT_SCALE_POSITION',
      severity: 'info',
      text:
        '关于"可以用高倍杠杆"：杠杆「不放大仓位」。仓位由 1R 风险预算与止损距离决定，' +
        '杠杆只决定同样大的仓位要压多少保证金。所以它对"赚到目标倍数"没有数学贡献 —— ' +
        '真正放大盈亏的是更紧的止损（同样的 1R，止损 0.4% 能开的仓位是 1.8% 的 4.5 倍），' +
        '而止损越紧越容易被噪声打掉。当前几何允许 ' + round(env.maxSafeLeverageRaw, 2) + ' 倍，' +
        (geometryNotConfig
          ? '而配置只给 ' + round(env.maxLeverage, 2) + ' 倍（EV_MAX_LEVERAGE）——' + '抬高它不会让目标更近，只会让止损先于强平失效。'
          : '配置给的 ' + round(env.maxLeverage, 2) + ' 倍已经是当前几何下的实际上限。'),
      numbers: {
        maxSafeLeverageRaw: round(env.maxSafeLeverageRaw, 2),
        configuredLeverage: round(env.maxLeverage, 2),
        leverageHardCeiling: env.leverageHardCeiling,
        stopPct: round(env.stopPct * 100, 2),
      },
    })
    if (spec.explicitLeverage !== null && spec.explicitLeverage > env.maxLeverage) {
      reasons.push({
        code: 'EXPLICIT_LEVERAGE_CLAMPED',
        severity: 'warn',
        text:
          '你说的 ' + spec.explicitLeverage + ' 倍会被钳到 ' + round(env.maxLeverage, 2) + ' 倍' +
          '（配置上限；代码内硬天花板 ' + env.leverageHardCeiling + ' 倍不可被配置抬高）。',
        numbers: { requested: spec.explicitLeverage, applied: round(env.maxLeverage, 2) },
      })
    }
  }

  return reasons
}

function buildAlternative(spec: MissionSpec, env: MissionEnv, sizing: MissionSizing | null): MissionAlternative | null {
  const notes: string[] = []
  let any = false

  if (spec.targetMultiple !== null && (spec.targetMultiple - 1) * 100 > env.autoTargetMaxPct) {
    any = true
    notes.push('把目标降到 +' + env.autoTargetMaxPct + '% 以内（自动驾驶的硬界），或者先不设目标跑通再说。')
  }
  if (sizing && sizing.plannedNotional < sizing.minViableNotional) {
    any = true
    if (sizing.minViableEquity !== null) {
      notes.push(
        '把本金抬到 ' + sizing.minViableEquity + ' 以上 —— 低于这个数，' +
          '1R 风险预算算出来的名义本金永远过不了 CEX 成本地板，一笔都开不出来。',
      )
    }
  }
  if (spec.venue !== null && spec.venue !== env.wiredVenue) {
    any = true
    notes.push('把场所改成 ' + env.wiredVenue + '，或者先把 AUTOPILOT_VENUE 改成 ' + spec.venue + ' 再重启编排层。')
  }
  if (env.overfit === null || !env.overfit.passed) {
    any = true
    notes.push(
      '先把过拟合门跑出结论：延长历史到 6~12 个月（npm run data:fetch）。' +
        '注意是「延长样本」而不是放宽阈值 —— 放宽阈值等于把门拆掉。',
    )
  }
  if (spec.allowHighLeverage) {
    any = true
    notes.push('别再抬 EV_MAX_LEVERAGE：它对达成目标没有贡献，只会让止损先于强平失效。')
  }

  if (!any) return null
  return {
    targetPct: env.autoTargetMaxPct,
    minEquity: sizing?.minViableEquity ?? null,
    notes,
  }
}

/**
 * 裁定一份任务。
 *
 * 纯函数：给定同样的 `spec` 与 `env`，结论逐字相同。
 * 这是它可被离线断言、可被复算的前提（本项目对门禁的硬要求）。
 */
export function assessMission(spec: MissionSpec, env: MissionEnv, now = Date.now()): MissionPlan {
  const reasons = collectReasons(spec, env, planSizing(env))
  const sizing = planSizing(env)
  const multiple = spec.targetMultiple
  const targetPct = multiple !== null && multiple > 0 ? (multiple - 1) * 100 : null

  let required: RequiredTrades | null = null
  if (multiple !== null && multiple > 1) {
    required = requiredTradesOf({
      winPct: env.minRiskReward * env.riskPerTradeRatio,
      lossPct: env.riskPerTradeRatio,
      multiple,
      maxLosses: Math.floor(env.dailyLossEquityRatio / env.riskPerTradeRatio),
      deadlineMs: spec.deadlineMs ?? 0,
    })
  }

  // 判定顺序：**硬矛盾优先于证据不足**。
  // 理由：缺槽位时用户补一句话就能继续，而硬矛盾是补槽位也解不掉的。
  // 把两者混成"证据不足"，用户会反复补槽位却永远等不到结论。
  //
  // ★ 这里**只数 `block`**。`hold` 单独成档，专门把"我不知道"与"它不行"分开；
  // 一旦把 hold 也算进来，`unverifiable` 就成了死代码（见 types.ts 的说明）。
  // 末尾保留 `spec.missing.length` 这个独立条件：判定不该依赖理由列表被填满 ——
  // 将来若有人重构掉 MISSING_SLOTS 这条理由，"缺了就说不清"仍必须是 `unverifiable`。
  const hasBlock = reasons.some((r) => r.severity === 'block')
  const hasHold = reasons.some((r) => r.severity === 'hold')
  const verdict: MissionVerdict = hasBlock
    ? 'infeasible'
    : hasHold || spec.missing.length > 0
      ? 'unverifiable'
      : 'feasible'

  const planId = missionContentId({
    kind: 'mission-plan',
    // ⚠️ 只哈希**影响结论**的字段。把 `raw` 原文放进来会让
    // "同一件事换个说法"得到两个 id，引用就对不上了。
    venue: spec.venue,
    execution: spec.execution,
    symbol: spec.symbol,
    startNotional: spec.startNotional,
    targetNotional: spec.targetNotional,
    targetMultiple: spec.targetMultiple,
    deadlineMs: spec.deadlineMs ?? null,
    allowHighLeverage: spec.allowHighLeverage,
    explicitLeverage: spec.explicitLeverage,
    env: {
      venue: env.wiredVenue,
      equity: env.equity,
      stopPct: env.stopPct,
      riskPerTradeRatio: env.riskPerTradeRatio,
      minRiskReward: env.minRiskReward,
      dailyLossEquityRatio: env.dailyLossEquityRatio,
      autoTargetMaxPct: env.autoTargetMaxPct,
      maxSafeLeverage: env.maxSafeLeverage,
      maxLeverage: env.maxLeverage,
      minViableNotionalCex: env.minViableNotionalCex,
      overfit: env.overfit,
    },
  })

  return {
    planId,
    assessedAt: now,
    spec,
    verdict,
    targetMultiple: multiple,
    targetPct: targetPct !== null ? round(targetPct, 2) : null,
    required,
    sizing,
    reasons,
    alternative: verdict === 'feasible' ? null : buildAlternative(spec, env, sizing),
  }
}

/**
 * 播报时 warn 的优先次序。
 *
 * 播报只念一条 warn（念多了没人记得住），所以"念哪一条"是一个**呈现决策**，
 * 必须显式写出来，不能靠理由列表的偶然顺序 —— 否则某次无关的插入
 * 就会把最重要那条挤掉，而症状是"口播里少了一句关键提醒"，没人会发现。
 *
 * 这里优先过拟合门：它不是"注意成本口径"之类的提醒，
 * 而是"启动之后这个窗口内一笔都不会成交"。用户据此要改的动作完全不同。
 */
const WARN_SPEAK_PRIORITY = [
  'OVERFIT_REFUSED',
  'OVERFIT_EVIDENCE_INSUFFICIENT',
  'OVERFIT_NEVER_RUN',
]

function pickWarn(warns: readonly MissionReason[]): MissionReason | null {
  if (warns.length === 0) return null
  for (const code of WARN_SPEAK_PRIORITY) {
    const hit = warns.find((w) => w.code === code)
    if (hit) return hit
  }
  return warns[0]
}

/** 把裁定书折成**能念出来**的中文（供语音层直接用）。 */
export function speakPlan(plan: MissionPlan): string {
  const head =
    plan.verdict === 'feasible'
      ? '这个目标没有硬矛盾，可以启动。'
      : plan.verdict === 'unverifiable'
        ? '这个目标我还判不了 —— 缺证据，我不会凭感觉放行。'
        : '这个目标做不成，而且不是"难"，是有硬矛盾。'
  const blocks = plan.reasons.filter((r) => r.severity === 'block')
  const holds = plan.reasons.filter((r) => r.severity === 'hold')
  const warns = plan.reasons.filter((r) => r.severity === 'warn')
  const parts: string[] = [head]
  // 只念最多两条：播报是给人听的，超过两条他记不住，
  // 而完整理由在**裁定记录**里（`/mission/plan` 的响应与账本 `MISSION_PLANNED.reasons`）
  // 能逐条看。
  // ★ 这里原来写的是"面板里列全了" —— 而当时**没有任何 mission 面板**。
  //   那句话说给用户听，他会去找一个不存在的东西。播报文案里不能出现
  //   还没做出来的界面（这类"描述不在之物"的字句，比不说更消耗信任）。
  // 「拦路的」与「缺证据的」分开念 —— 前者要改目标或放弃，后者只需补一句话，
  // 把两者念成同一句会让用户以为自己被判了死刑。
  const leading = blocks.length > 0 ? blocks : holds
  for (const r of leading.slice(0, 2)) parts.push(r.text)
  if (leading.length > 2) parts.push('另外还有 ' + (leading.length - 2) + ' 条，不一条条念了，完整的记在裁定记录里。')
  const warn = pickWarn(warns)
  if (warn) parts.push(warn.text)
  if (plan.alternative && plan.alternative.notes.length > 0) {
    // 每条 note 自己带句号，直接 `join('；')` 会得到「。；」，末尾再补句号会得到「。。」。
    // 这类叠标点在屏幕上一眼就是错的，念出来则是一段毫无必要的停顿。
    // 所以先削掉每条尾部的标点，再由这一处统一补 —— 标点只在一个地方产生。
    const notes = plan.alternative.notes.slice(0, 2).map((n) => n.replace(/[。；;.]+$/, ''))
    parts.push('要接着做的话，可以：' + notes.join('；') + '。')
  }
  return speakJoin(parts)
}

/**
 * 把一段段播报拼成一句。
 *
 * ★ `parts.join('')` 是能跑的 —— 只要**每一条**文案都恰好以句号结尾。
 *   那是个巧合，不是约束：某天有人加一条不带句号的理由，
 *   屏幕上就是两句黏在一起，而没有任何东西会报红。
 *   所以这里改成"缺标点的补上"，把巧合变成规则。
 */
function speakJoin(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (/[。！？；]$/.test(p) ? p : p + '。'))
    .join('')
    .replace(/。；/g, '；')
    .replace(/。。/g, '。')
}
