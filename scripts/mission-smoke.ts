/**
 * 任务层烟测
 *
 * ── 这份测试要证明的六件事（缺一条这一层就不算接上）─────────────────
 * ① **三态裁定真的有三条支路。** 可行 / 不可行 / 证据不足 必须都能被
 *    构造出来并各自命中一次。只测"可行"等于没测 ——
 *    裁定器最大的失效不是判错，而是**永远判可行**。
 * ② **不可行的结论必须带数。** 每条 block 理由都得有 `numbers`：
 *    "做不到"是判断（可被无视），"需要 119 笔盈利、只剩 5 笔额度"是事实
 *    （可被核对）。这条写成断言，是为了防止后来者把理由改成一句漂亮话。
 * ③ **缺槽位不许补默认值。** 只说"做到 100U"时 `startNotional` 必须是 null
 *    且进 `missing`，而不是变成某个"贴心"的默认值。
 * ④ **脱敏不能误报。** 本项目的资产里到处是 40 位十六进制内容地址
 *    （含本模块自己的 id）—— 任何基于熵值的判据都会把它们全标成密钥，
 *    在**完全正确的输入**上疯狂报红。所以既要有"真密钥被抹掉"的正例，
 *    也要有"内容地址不被误伤"的反例。
 * ⑤ **引用不可静默替换。** 一份裁定书只能绑定一条执行线；
 *    同一份内容必须得到同一个 id，而**换个说法**不能换 id。
 * ⑥ **过拟合门的结论只能从账本读，且 pin 绕过不算通过。**
 *    后者是这一层最容易被读反的一处：账本上明明写着 `bypassed-by-pin`，
 *    读成 `pass:true` 就等于给 pin 开了一条绕过整条自进化线的后门。
 * ⑦ **启动口令要成对问：它会不会对正确的输入报错？**
 *    口令类的判据天然容易写成"永远拒绝"（那样看起来最安全），
 *    而它的代价是用户拿着**完全正确的口令**被拒 —— 这类假拒绝会把
 *    整个口令机制训练成一个摆设。所以每一条拒绝都要配一条放行。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrchState, resetOrch, seedPrice } from '../server/core.ts'
import { appendEvent, getEvents, resetLedger } from '../server/ledger.ts'
import { resetSurveillance } from '../server/surveillance.ts'
import { resetVoice } from '../server/voice/service.ts'
import { handleUtterance } from '../server/voice/service.ts'
import { parseIntent, INTENT_LABEL, isDangerous } from '../server/voice/intents.ts'
import {
  AUTOPILOT_TARGET_MAX_PCT,
  autopilotStatus,
  configureAutopilot,
  stopAutopilot,
} from '../server/autopilot.ts'
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
} from '../server/riskConstants.ts'
import { maxSafeLeverageDetail } from '../server/positionGuard.ts'
import { parseGoal, looksLikeMission, hasExecutionSignal, MISSION_SLOT_LABEL } from '../server/mission/goal.ts'
import { assessMission, requiredTradesOf, planSizing, speakPlan } from '../server/mission/feasibility.ts'
import {
  appendOnlyVerdict,
  bindMissionLine,
  buildSecretRegistry,
  canonicalJson,
  missionContentId,
  redactSecrets,
} from '../server/mission/asset.ts'
import {
  START_CODE_TTL_MS,
  START_MAX_ATTEMPTS,
  START_PHRASE,
  checkStartConsent,
  consumeStartConsent,
  heardStartCode,
  heardStartPhrase,
  issueStartConsent,
  pendingStartConsent,
  resetStartConsent,
} from '../server/mission/consent.ts'
import { missionStepsConsistent, overfitState, planMission } from '../server/mission/service.ts'
import type { MissionEnv } from '../server/mission/types.ts'

/**
 * ★ 自动化测试**绝不允许**起实盘。
 *
 * 本机 `.env` 里 `AUTOPILOT_LIVE=true`（那是给本地预览留的），而它会被读进进程；
 * 上一版跑 S-M15 时日志打出的是 `[autopilot] START live …` —— 也就是说
 * 一条**测试**路径把我们带到了实盘通路上。当时没有任何断言会因此报红。
 *
 * 这里显式按死（`isAutopilotLive()` 是调用时求值，所以写在模块体里就生效），
 * 并在 S-M15 里断言 `AUTOPILOT_STARTED.payload.scope === 'paper'` ——
 * 光设环境变量是"我觉得它没事"，断言才是"它出事我会知道"。
 *
 * `AUTOPILOT_PRESEED=false` 同理：默认预热会去拉真实历史 K 线，
 * 让测试的输入依赖当天行情（既有 smoke 也这么做，口径保持一致）。
 */
process.env.AUTOPILOT_LIVE = 'false'
process.env.AUTOPILOT_PRESEED = 'false'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error('[FAIL] MISSION SMOKE FAIL - ' + name + ' - ' + msg)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log('[OK] ' + name + ' - ' + detail)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'mission-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function assertEq<T>(name: string, actual: T, expected: T, extra = ''): void {
  if (actual !== expected) {
    fail(name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + (extra ? ' · ' + extra : ''))
  }
}

function assertTrue(name: string, cond: boolean, msg: string): void {
  if (!cond) fail(name, msg)
}

const MARK = 100_000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT']
/** 用与语音层同一份解析器，避免"标的解析有两套口径"。 */
function goalCtx(nowMs = 1_700_000_000_000): ReturnType<typeof makeCtx> {
  return makeCtx(nowMs)
}
function makeCtx(nowMs: number) {
  return {
    symbols: SYMBOLS,
    resolveSymbol: (t: string, syms: string[]) => {
      const low = t.toLowerCase()
      for (const s of syms) if (low.includes(s.toLowerCase())) return s
      if (low.includes('比特币') || low.includes('btc')) return 'BTCUSDT'
      if (low.includes('以太') || low.includes('eth')) return 'ETHUSDT'
      return null
    },
    nowMs,
  }
}

/** 用户本轮的原话 —— 整份测试的第一等公民。 */
const GOAL_TEXT = '帮我使用该系统策略做okx测试网实测，10U做到100U,1天内，可以使用高倍合约杠杆'

function baseEnv(over: Partial<MissionEnv> = {}): MissionEnv {
  const stopPct = STOP_SAFETY_PCT_MIN
  const lev = maxSafeLeverageDetail(stopPct)
  return {
    wiredVenue: 'okx-testnet',
    accountingVenue: 'okx-testnet',
    autopilotLive: false,
    instType: 'SWAP',
    equity: 50_000,
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
    overfit: { outcome: 'PASS', pbo: 0.1, maxPbo: 0.25, passed: true },
    ...over,
  }
}

async function main(): Promise<void> {
  resetLedger()
  resetSurveillance()
  resetOrch(100_000)
  seedPrice('BTCUSDT', MARK)
  seedPrice('ETHUSDT', 3_000)

  // ══════════════ S-M1 目标解析：按用户原句逐字段断言 ══════════════
  {
    const spec = parseGoal(GOAL_TEXT, goalCtx())
    assertEq('S-M1 场所', spec.venue, 'okx-testnet')
    assertEq('S-M1 执行形态', spec.execution, 'testnet')
    assertEq('S-M1 起始本金', spec.startNotional, 10)
    assertEq('S-M1 目标金额', spec.targetNotional, 100)
    assertEq('S-M1 目标倍数', spec.targetMultiple, 10)
    assertEq('S-M1 截止时长', spec.deadlineMs, 86_400_000)
    assertEq('S-M1 允许高杠杆', spec.allowHighLeverage, true)
    assertEq('S-M1 未指定倍数时为 null', spec.explicitLeverage, null)
    assertEq('S-M1 槽位齐（标的可不指定）', spec.missing.length, 0)
    assertTrue('S-M1 应判为任务', looksLikeMission(spec), '用户原句没有被识别成任务')
    pass('S-M1 目标解析', 'okx-testnet / 10 → 100 / 10 倍 / 24h / 允许高杠杆，槽位齐')
  }

  // ══════════════ S-M2 缺槽位绝不补默认值 ══════════════
  {
    const a = parseGoal('做到100U', goalCtx())
    assertEq('S-M2 只说目标 → 本金为 null', a.startNotional, null)
    assertTrue('S-M2 本金进 missing', a.missing.includes('startNotional'), '缺本金却没进 missing')
    assertEq('S-M2 只说目标 → 不算任务', looksLikeMission(a), false)
    // ★ 反向的一半：**说过的槽位不许说成没说**。
    // 「做到100U」里 100 是目标；把它记成本金，系统就会回一句
    // "你没说目标金额" —— 而这句话是假的。缺证据的结论必须**只针对真的缺**，
    // 否则用户会去补一个他已经给过的信息（而且他的补法通常是再说一遍原话）。
    assertEq('S-M2 说过的不许说成没说', a.targetNotional, 100)
    assertTrue('S-M2 目标不进 missing', !a.missing.includes('targetNotional'), '用户说了目标，却被报成没目标')
    // 成对断言：同样"只有一个金额"，没有目标词时结论必须相反 ——
    // 这一对才证明它在**读连接词**，而不是恒把单一金额当成某一种。
    const p = parseGoal('用10U', goalCtx())
    assertEq('S-M2 单一金额无目标词 → 本金', p.startNotional, 10)
    assertEq('S-M2 单一金额无目标词 → 目标为 null', p.targetNotional, null)
    assertTrue('S-M2 本金不进 missing', !p.missing.includes('startNotional'), '用户说了本金，却被报成没本金')

    const b = parseGoal('用10U在okx测试网做到100U', goalCtx())
    assertEq('S-M2 不提时间 → 截止为 null', b.deadlineMs, null)
    assertTrue('S-M2 截止进 missing', b.missing.includes('deadline'), '缺截止时间却没进 missing')
    assertTrue('S-M2 缺槽位有中文标签', typeof MISSION_SLOT_LABEL.deadline === 'string', '缺槽位没有可念的标签')

    const c = parseGoal('今天用10U做到20U', goalCtx())
    assertEq('S-M2 今天 → 相对当天 24 点', c.deadlineMs !== null && c.deadlineMs > 0, true)

    const d = parseGoal('今天天气怎么样', goalCtx())
    assertEq('S-M2 闲聊不算任务', looksLikeMission(d), false)
    pass(
      'S-M2 缺槽位不补默认值',
      '缺本金/缺时间都显式进 missing；说过的槽位不被误报成缺失；闲聊不会被当成任务',
    )
  }

  // ══════════════ S-M3 三态裁定：三条支路都要走一次 ══════════════
  {
    // ① 证据不足：缺槽位，且**没有**硬矛盾
    //
    // ★ 用例本身要用对。用「10U 做到 100U 但不说时间」是测不到这一态的 ——
    //   那句里还躺着"目标越界"这条硬矛盾，结论必然是 `infeasible`。
    //   于是 `unverifiable` 这条支路**从未被走到**，而它藏在一个
    //   「三态都测了」的说法底下 —— 这正是本项目已复现 7 次的 P0 类型：
    //   不是检查不会失败，是**状态不可能被命中**。
    const missSpec = parseGoal('用50000U在okx测试网做到55000U', goalCtx())
    assertEq('S-M3 用例只缺时间', missSpec.missing.join(','), 'deadline')
    const v1 = assessMission(missSpec, baseEnv())
    assertEq('S-M3 缺槽位 → 证据不足', v1.verdict, 'unverifiable')
    // 硬要求：缺证据的理由**不得**记成硬矛盾，否则三态退化成两态
    assertEq('S-M3 缺证据不带硬矛盾', v1.reasons.filter((r) => r.severity === 'block').length, 0)
    assertEq('S-M3 缺槽位理由为 hold', v1.reasons.find((r) => r.code === 'MISSING_SLOTS')?.severity, 'hold')
    // 反向：同一句话把时间补上就必须立刻变可行 ——
    // 这一对（缺 → unverifiable / 补 → feasible）才证明"证据"二字真的在起作用，
    // 而不是"凡是不认识的就是证据不足"这种恒返回。
    const filled = assessMission(parseGoal('用50000U在okx测试网做到55000U，1天内', goalCtx()), baseEnv())
    assertEq('S-M3 补上时间即变可行', filled.verdict, 'feasible')

    // ② 不可行：用户原句（目标 10 倍）
    const spec = parseGoal(GOAL_TEXT, goalCtx())
    const v2 = assessMission(spec, baseEnv())
    assertEq('S-M3 10 倍 → 不可行', v2.verdict, 'infeasible')
    assertTrue('S-M3 不可行必有硬矛盾', v2.reasons.some((r) => r.severity === 'block'), '判了不可行却没有 block 理由')

    // ③ 可行：把目标降到 +10%，本金给足，场所对齐，门已通过
    const okSpec = parseGoal('用50000U在okx测试网做到60000U，1天内', goalCtx())
    const v3 = assessMission(okSpec, baseEnv())
    assertEq('S-M3 合理目标 → 可行', v3.verdict, 'feasible')
    assertEq('S-M3 可行时不给替代方案', v3.alternative, null)

    // 三条支路的结论必须两两不同 —— 否则"三态"只是三个名字
    assertEq('S-M3 三态互不相同', new Set([v1.verdict, v2.verdict, v3.verdict]).size, 3)
    pass('S-M3 三态裁定', '证据不足 / 不可行 / 可行 三条支路各命中一次；证据不足的理由必须是 hold 而非 block')
  }

  // ══════════════ S-M4 场所名与适配器逐字一致 ══════════════
  {
    const dir = join(process.cwd(), 'server', 'venue')
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'types.ts')
      .map((f) => {
        const src = readFileSync(join(dir, f), 'utf8')
        const m = /readonly\s+name\s*=\s*'([^']+)'/.exec(src)
        return m ? m[1] : ''
      })
      .filter((n) => n.length > 0)

    const pairs: Array<{ word: string; venue: string }> = [
      { word: 'okx测试网', venue: 'okx-testnet' },
      { word: '币安测试网', venue: 'cex-testnet' },
      { word: '沙盒', venue: 'sandbox' },
    ]
    for (const p of pairs) {
      assertTrue(
        'S-M4 适配器存在 ' + p.venue,
        names.includes(p.venue),
        '适配器列表里没有 ' + p.venue + '（实际：' + names.join(',') + '）',
      )
      assertEq('S-M4 词→场所 ' + p.word, parseGoal(p.word, goalCtx()).venue, p.venue)
    }
    pass('S-M4 场所名即契约', pairs.length + ' 组中文词映射到适配器 ' + names.join('/') + '，逐字一致')
  }

  // ══════════════ S-M5 每条 block 理由都必须带数 ══════════════
  {
    const spec = parseGoal(GOAL_TEXT, goalCtx())
    const plan = assessMission(spec, baseEnv({ equity: 10 }))
    const blocks = plan.reasons.filter((r) => r.severity === 'block')
    assertTrue('S-M5 至少一条 block', blocks.length > 0, '用户的 10U→100U 居然没有被拦')
    for (const b of blocks) {
      assertTrue('S-M5 block 带 numbers：' + b.code, b.numbers !== undefined && Object.keys(b.numbers).length > 0, b.code + ' 没有带任何数字，"做不到"变成了不可反驳的判断')
    }

    // 硬界①：目标越界，且上限来自 AUTOPILOT_TARGET_MAX_PCT 而不是字面量
    const range = blocks.find((b) => b.code === 'TARGET_ABOVE_AUTOPILOT_RANGE')
    assertTrue('S-M5 目标越界被拦', range !== undefined, '没有 TARGET_ABOVE_AUTOPILOT_RANGE')
    assertEq('S-M5 上限同源', range?.numbers?.autoTargetMaxPct, AUTOPILOT_TARGET_MAX_PCT)
    assertEq('S-M5 目标百分比', range?.numbers?.targetPct, 900)

    // 硬界②：$10 本金开不出第一笔（比"赚不到"更早崩）
    const floor = blocks.find((b) => b.code === 'FIRST_TRADE_BELOW_COST_FLOOR')
    assertTrue('S-M5 首笔过不了成本地板', floor !== undefined, '没有 FIRST_TRADE_BELOW_COST_FLOOR')
    assertTrue(
      'S-M5 拟做名义额低于地板',
      Number(floor?.numbers?.plannedNotional) < Number(floor?.numbers?.minViableNotional),
      '名义额 ' + String(floor?.numbers?.plannedNotional) + ' 没有低于地板 ' + String(floor?.numbers?.minViableNotional),
    )
    assertTrue(
      'S-M5 给出所需最小本金',
      typeof floor?.numbers?.minViableEquity === 'number' && Number(floor.numbers.minViableEquity) > 10,
      '没算出所需最小本金',
    )
    pass('S-M5 不可行必带数', blocks.length + ' 条 block 全部带 numbers；越界上限与 AUTOPILOT_TARGET_MAX_PCT 同源；$10 本金首笔即被成本地板拦')
  }

  // ══════════════ S-M6 数学要求：胜率下界与亏损额度 ══════════════
  {
    const req = requiredTradesOf({
      winPct: MIN_RISK_REWARD_RATIO * RISK_PER_TRADE_RATIO,
      lossPct: RISK_PER_TRADE_RATIO,
      multiple: 10,
      maxLosses: Math.floor(DAILY_LOSS_EQUITY_RATIO / RISK_PER_TRADE_RATIO),
      deadlineMs: 86_400_000,
    })
    assertEq('S-M6 亏损额度', req.maxLosses, 5)
    // 1.02^W × 0.99^5 ≥ 10 → W = 119（这个数会被念给用户听，所以要钉住）
    assertEq('S-M6 所需盈利笔数', req.requiredWins, 119)
    assertTrue('S-M6 隐含胜率 > 95%', req.impliedWinRate > 0.95, '隐含胜率 ' + req.impliedWinRate)
    assertTrue('S-M6 每小时盈利笔数 > 4', req.winsPerHour > 4, '每小时 ' + req.winsPerHour)

    // 反例：倍数降到 1.1 时所需笔数必须显著下降（证明它真的在算，不是恒返回 119）
    const small = requiredTradesOf({
      winPct: MIN_RISK_REWARD_RATIO * RISK_PER_TRADE_RATIO,
      lossPct: RISK_PER_TRADE_RATIO,
      multiple: 1.1,
      maxLosses: 5,
      deadlineMs: 86_400_000,
    })
    assertTrue('S-M6 小目标所需笔数确实更少', small.requiredWins < req.requiredWins, '改为 1.1 倍后所需笔数没有下降')
    pass('S-M6 达标数学', '10 倍需 119 笔盈利 / 最多 5 笔亏损 / 隐含胜率 ' + (req.impliedWinRate * 100).toFixed(1) + '%；1.1 倍时降到 ' + small.requiredWins + ' 笔')
  }

  // ══════════════ S-M7 杠杆不放大仓位（最容易被误解的一条） ══════════════
  {
    const envLow = baseEnv({ equity: 1_000, maxLeverage: 3, maxSafeLeverage: 3 })
    const envHigh = baseEnv({ equity: 1_000, maxLeverage: 125, maxSafeLeverage: 125 })
    const a = planSizing(envLow)
    const b = planSizing(envHigh)
    assertEq('S-M7 低杠杆绑风险预算', a?.binding, 'risk_budget')
    assertEq(
      'S-M7 杠杆不改变仓位大小',
      a?.notionalByRisk,
      b?.notionalByRisk,
      '风险预算反推的名义额不该随杠杆变化',
    )
    assertTrue(
      'S-M7 杠杆只影响保证金上限',
      Number(b?.notionalByMargin) > Number(a?.notionalByMargin),
      '杠杆没有抬高保证金上限',
    )

    // 用户原句里那句"可以用高倍杠杆"必须得到一条 info —— 不能让用户以为阻力在杠杆
    const plan = assessMission(parseGoal(GOAL_TEXT, goalCtx()), baseEnv({ equity: 10 }))
    const lev = plan.reasons.find((r) => r.code === 'LEVERAGE_DOES_NOT_SCALE_POSITION')
    assertTrue('S-M7 给出杠杆真相', lev !== undefined, '允许高杠杆时没有给出杠杆与仓位关系的说明')
    assertEq('S-M7 杠杆真相是 info', lev?.severity, 'info')
    pass('S-M7 杠杆语义', '杠杆只抬高保证金上限、不改变仓位；允许高杠杆时必给一条 info 说明')
  }

  // ══════════════ S-M8 内容寻址：同内容同 id，换说法不换 id ══════════════
  {
    assertEq('S-M8 键序无关', missionContentId({ a: 1, b: 2 }), missionContentId({ b: 2, a: 1 }))
    assertTrue('S-M8 值变则 id 变', missionContentId({ a: 1 }) !== missionContentId({ a: 2 }), '改值没换 id')
    assertTrue('S-M8 undefined 不影响', missionContentId({ a: 1, b: undefined }) === missionContentId({ a: 1 }), 'undefined 参与了哈希')
    assertEq('S-M8 规范 JSON 排序', canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')

    // 同一件事换个说法 → 同一个 planId（把 raw 排除在哈希之外的意义就在这）
    //
    // ★ 「换个说法」必须是**逐条同义**的换说法。少说一个从句
    //   （例如这一版没提"可以用高倍杠杆"）就是**另一件事**，id 理应不同 ——
    //   那不是引用失效，那是内容寻址在正常工作。
    //   用例写错会让这条断言变成"凡换词必换 id"的**反向**证据，
    //   而它表面上看起来只是在测同一件事（本轮第一次跑就是栽在这里）。
    const env = baseEnv()
    const p1 = assessMission(parseGoal(GOAL_TEXT, goalCtx()), env)
    const p2 = assessMission(
      parseGoal('帮我在okx测试网用10U一天内做到100U，可以用高倍合约杠杆', goalCtx()),
      env,
    )
    assertEq('S-M8 同内容同 id', p2.planId, p1.planId)
    // 成对的反例：少一个从句就换 id —— 边界必须存在，
    // 否则"引用不可被静默替换"这句话没有可判定的含义。
    const p2b = assessMission(parseGoal('帮我在okx测试网用10U一天内做到100U', goalCtx()), env)
    assertTrue('S-M8 少一个从句即换 id', p2b.planId !== p1.planId, '少了"允许高杠杆"这一句，id 却相同')
    // 但换个环境（权益变了）也必须换 id —— 否则"条件过期"无法被发现
    const p3 = assessMission(parseGoal(GOAL_TEXT, goalCtx()), baseEnv({ equity: 10 }))
    assertTrue('S-M8 环境变则 id 变', p3.planId !== p1.planId, '权益变了 planId 却没变，条件过期将无法识别')
    pass(
      'S-M8 内容寻址',
      'id 与键序无关；逐条同义的换说法不换 id；少一个从句即换 id（边界存在）；环境变则换 id',
    )
  }

  // ══════════════ S-M9 一任务一执行线（引用不可静默替换） ══════════════
  {
    const b1 = bindMissionLine('m-aaa', 'run-1', null, 1)
    assertEq('S-M9 首次绑定成功', b1.ok, true)
    const b2 = bindMissionLine('m-aaa', 'run-1', { planId: 'm-aaa', runId: 'run-1', boundAt: 1 }, 2)
    assertEq('S-M9 同 run 幂等', b2.ok, true)
    const b3 = bindMissionLine('m-aaa', 'run-2', { planId: 'm-aaa', runId: 'run-1', boundAt: 1 }, 3)
    assertEq('S-M9 换 run 被拒', b3.ok, false)
    if (b3.ok) fail('S-M9 换 run 被拒', '换了执行线却没有被拒')
    assertTrue('S-M9 拒绝理由可念', b3.reason.includes('MISSION_LINE_ALREADY_BOUND'), '拒绝理由没有稳定标识：' + b3.reason)
    const b4 = bindMissionLine('m-bbb', 'run-9', { planId: 'm-aaa', runId: 'run-1', boundAt: 1 }, 4)
    assertEq('S-M9 换裁定书允许', b4.ok, true)
    pass('S-M9 一任务一执行线', '同 run 幂等 / 换 run 拒绝（带稳定标识）/ 换裁定书允许')
  }

  // ══════════════ S-M10 仅追加前缀校验 ══════════════
  {
    assertEq('S-M10 前缀一致', appendOnlyVerdict(['a', 'b'], ['a', 'b', 'c']), 'prefix')
    assertEq('S-M10 完全相同', appendOnlyVerdict(['a'], ['a']), 'prefix')
    assertEq('S-M10 中间改写', appendOnlyVerdict(['a', 'x'], ['a', 'b']), 'diverged')
    assertEq('S-M10 超出实时序列', appendOnlyVerdict(['a', 'b', 'c'], ['a']), 'ahead')
    assertEq('S-M10 空已提交总是前缀', appendOnlyVerdict([], ['a']), 'prefix')
    assertEq('S-M10 门面函数一致', missionStepsConsistent(['a'], ['a', 'b']), true)
    pass('S-M10 仅追加校验', 'prefix / diverged / ahead 三种情形各自命中')
  }

  // ══════════════ S-M11 脱敏：真密钥被抹掉，内容地址不被误伤 ══════════════
  {
    const reg = buildSecretRegistry({
      OKX_TESTNET_API_SECRET: 'super-secret-value-123456',
      LEDGER_TOKEN: 'tok-abcdefghijklmnop',
      EV_SHORT_TOKEN: 'ab',
      NOT_A_SECRET_AT_ALL: 'plain-value',
      EV_MAX_LEVERAGE: '3',
    })
    assertEq('S-M11 登记到密钥', reg.entries.length, 2)
    assertEq('S-M11 过短值被拒登记', reg.refused.length, 1)
    assertEq('S-M11 拒绝理由稳定', reg.refused[0].reason, 'SHORTER_THAN_4_BYTES')
    assertTrue('S-M11 非密钥变量不入表', !reg.entries.some((e) => e.keyName === 'NOT_A_SECRET_AT_ALL'), '普通变量被当成密钥')
    assertTrue('S-M11 纯数字不入表', !reg.entries.some((e) => e.keyName === 'EV_MAX_LEVERAGE'), 'EV_MAX_LEVERAGE 被当成密钥')

    const r = redactSecrets('把 super-secret-value-123456 和 tok-abcdefghijklmnop 填进去', reg)
    assertTrue('S-M11 命中计数', r.hits === 2, '命中 ' + r.hits + ' 次')
    assertTrue('S-M11 原文已消失', !r.text.includes('super-secret-value-123456'), '脱敏后仍含原值')
    assertTrue('S-M11 第二处也已消失', !r.text.includes('tok-abcdefghijklmnop'), '脱敏后仍含第二个原值')
    assertTrue('S-M11 只回变量名', r.hitNames.every((n) => !n.includes('super-secret')), 'hitNames 里出现了值')
    assertTrue('S-M11 过短变量被披露', r.refusedNames.includes('EV_SHORT_TOKEN'), '被拒登记的变量没有出现在报告里')

    // ★ 反例（这一条最关键）：内容地址绝不能被当成密钥
    const id = missionContentId({ hello: 'world' })
    const fp = redactSecrets('引用这份裁定：' + id + ' 与哈希 0123456789abcdef0123456789abcdef01234567', reg)
    assertEq('S-M11 内容地址不误报', fp.hits, 0)
    assertTrue('S-M11 内容地址原样保留', fp.text.includes(id), '内容地址被误抹了')

    // 已知格式规则也要能命中（避免只有登记表这一条路）
    const fp2 = redactSecrets('token: sk-abcdefghijklmnopqrstuvwx', buildSecretRegistry({}))
    assertTrue('S-M11 已知格式命中', fp2.hits === 1, 'OpenAI 形态的密钥没被识别，命中 ' + fp2.hits)
    pass('S-M11 边缘脱敏', '2 个登记值被抹掉 + 1 个过短值被拒并披露 + 内容地址与裸哈希零误报 + 已知格式仍可命中')
  }

  // ══════════════ S-M12 过拟合门结论从账本读，且 pin 绕过不算通过 ══════════════
  {
    resetLedger()
    assertEq('S-M12 无结论时读出 null', overfitState(), null)

    appendEvent('AUTOPILOT_STRATEGY_SELECTED', { strategyId: 'x', pinned: true, overfitGate: 'bypassed-by-pin' })
    const pin = overfitState()
    assertEq('S-M12 pin 绕过不算通过', pin?.passed, false)
    assertEq('S-M12 pin 绕过有专属 outcome', pin?.outcome, 'BYPASSED_BY_PIN')

    appendEvent('AUTOPILOT_OVERFIT_GATE', { outcome: 'PASS', pass: true, pbo: 0.11 })
    const ok = overfitState()
    assertEq('S-M12 后写的事件优先', ok?.passed, true)
    assertEq('S-M12 PBO 读回', ok?.pbo, 0.11)

    appendEvent('AUTOPILOT_OPTIMIZE_REFUSED', { outcome: 'OVERFIT', pbo: 0.62 })
    const refused = overfitState()
    assertEq('S-M12 拒绝结论读回', refused?.passed, false)
    assertEq('S-M12 拒绝 PBO 读回', refused?.pbo, 0.62)

    resetLedger()
    appendEvent('AUTOPILOT_OPTIMIZE_REFUSED', { outcome: 'UNVERIFIABLE', pbo: null })
    const gate = overfitState()
    assertEq('S-M12 门结论为证据不足', gate?.outcome, 'UNVERIFIABLE')
    assertEq('S-M12 证据不足不放行', gate?.passed, false)

    // ★ 必须把账本结论**注入** env —— 裁定器读的是 `env.overfit`，不是账本本身。
    //   忘记注入会得到一份"过拟合门已通过"的裁定：此时断言"理由里应该有过拟合"
    //   会失败，而**失败的是夹具、不是代码**。夹具写错比代码写错更贵：
    //   它会让人去改一段本来正确的逻辑。
    const unv = assessMission(parseGoal(GOAL_TEXT, goalCtx()), baseEnv({ equity: 10, overfit: gate }))
    const ovReason = unv.reasons.find((r) => r.code.startsWith('OVERFIT_'))
    assertTrue(
      'S-M12 证据不足与拒绝分开',
      ovReason?.code === 'OVERFIT_EVIDENCE_INSUFFICIENT',
      '过拟合门结论没有进裁定理由，实际读到：' + String(ovReason?.code),
    )
    // ★ 档位是 `warn`，不是 block/hold —— **门不挡启动**。
    //
    // 这一条是本轮修掉的一个真缺陷：门在系统里的位置是"进交易阶段"的闸
    // （`autopilot` 累积够 K 线后去优化，那一步才问门，不过就留在原地继续累积）。
    // 任务层把它当启动闸，会造成死锁：启动被挡 ⇒ 累积起不来 ⇒ 证据攒不出 ⇒
    // 门永远不过。而它伪装成"谨慎"，还在真实数据下让 `feasible` 永不可达。
    assertEq('S-M12 门结论不挡启动', ovReason?.severity, 'warn')
    assertTrue(
      'S-M12 门结论讲清后果',
      (ovReason?.text ?? '').includes('交易阶段'),
      '没有讲清"启动后到不了交易阶段"这个后果，用户会以为启动就等于在做交易',
    )

    appendEvent('AUTOPILOT_OPTIMIZE_REFUSED', { outcome: 'OVERFIT', pbo: 0.62 })
    const refusedPlan = assessMission(
      parseGoal(GOAL_TEXT, goalCtx()),
      baseEnv({ equity: 10, overfit: overfitState() }),
    )
    const refReason = refusedPlan.reasons.find((r) => r.code === 'OVERFIT_REFUSED')
    assertEq('S-M12 PBO 超限不挡启动', refReason?.severity, 'warn')
    assertEq('S-M12 PBO 数值进理由', refReason?.numbers?.pbo, 62)
    // 两种成因的**下一步动作不同**（攒样本 vs 延长历史/改策略），
    // 所以 code 必须分开 —— 档位不再承担这个区分，code 承担。
    assertTrue(
      'S-M12 两种成因各自可辨',
      refReason !== undefined && refReason.code !== ovReason?.code,
      '证据不足与超限被合成了同一个 code，用户无从知道该补样本还是该改策略',
    )

    // ★ 这一条是整组的**落点断言**：只有门没过、其余都成立的方案必须是 `feasible`。
    //   它同时钉住了两个后果：① 门不挡启动；② 执行腿与启动口令不是死代码。
    const onlyGate = assessMission(
      parseGoal('用50000U在okx测试网做到55000U，1天内', goalCtx()),
      baseEnv({ overfit: overfitState() }),
    )
    assertEq('S-M12 门没过也判可行', onlyGate.verdict, 'feasible')
    assertTrue(
      'S-M12 可行时也会念出门的后果',
      speakPlan(onlyGate).includes('交易阶段'),
      '判了可行却没念出"到不了交易阶段"——warn 被别的提醒挤掉了（见 WARN_SPEAK_PRIORITY）',
    )
    pass(
      'S-M12 门结论从账本读',
      '无结论 / pin 绕过 / 通过 / 拒绝 四种账本状态各自正确还原；pin 绕过明确不是通过；' +
        '门结论不挡启动（warn）但必念出后果；两种成因靠 code 而非档位区分',
    )
  }

  // ══════════════ S-M13 端到端：那句话进语音层，拿到的是裁定而不是"听不懂" ══════════════
  {
    resetLedger()
    resetVoice()
    const parsed = parseIntent(GOAL_TEXT, { symbols: SYMBOLS, markPrice: () => MARK })
    assertEq('S-M13 意图命中', parsed.intent, 'start_mission')
    assertTrue('S-M13 意图有中文名', INTENT_LABEL.start_mission.length > 0, '新意图没有中文名')
    assertTrue('S-M13 意图是危险动作', isDangerous('start_mission'), '接目标没有被列为危险动作')

    const r = await handleUtterance(GOAL_TEXT)
    assertEq('S-M13 轮次意图', r.intent, 'start_mission')
    assertTrue('S-M13 不是"没听懂"', !r.reply.includes('这句我没听懂'), '任务句被回成了听不懂：' + r.reply)
    assertTrue('S-M13 回话非空', r.reply.length > 20, '回话太短：' + r.reply)
    assertTrue(
      'S-M13 回话说明了硬矛盾',
      r.reply.includes('做不成') || r.reply.includes('硬矛盾') || r.reply.includes('过不了'),
      '回话没有讲清为什么做不成：' + r.reply,
    )
    assertEq('S-M13 已落账', getEvents(0).filter((e) => e.kind === 'MISSION_PLANNED').length, 1)

    // 落账的那句话必须是脱敏后的（这里没有密钥，所以应与原文一致）
    const ev = getEvents(0).find((e) => e.kind === 'MISSION_PLANNED')
    assertTrue('S-M13 账本带裁定结论', typeof ev?.payload.verdict === 'string', 'MISSION_PLANNED 没有 verdict')
    assertEq('S-M13 裁定结论正确', ev?.payload.verdict, 'infeasible')

    // 非任务句不得落账（否则账本会被闲聊灌满）
    await handleUtterance('今天天气怎么样')
    assertEq('S-M13 闲聊不落账', getEvents(0).filter((e) => e.kind === 'MISSION_PLANNED').length, 1)

    // 裁定结论必须能被念出来
    const plan = planMission(GOAL_TEXT, goalCtx()).plan
    assertTrue('S-M13 结论可朗读', plan !== null && speakPlan(plan).length > 10, 'speakPlan 产出为空')
    pass('S-M13 端到端', '那句话从语音层进 → 意图 start_mission（危险）→ 回话讲清硬矛盾 → 账本落 MISSION_PLANNED(infeasible)；闲聊不落账')
  }

  // ══════════════ S-M14 启动口令的两半、四种拒绝、四种放行 ══════════════
  //
  // 口令类判据最容易写成的形态是**永远拒绝** —— 那样看起来最安全，
  // 而代价是用户拿着完全正确的口令被拒，于是整个机制被训练成摆设。
  // 所以这一组每写一条拒绝，都配一条"同一个输入换个正常值必须放行"。
  {
    resetLedger()
    resetVoice()
    const T0 = 1_800_000_000_000

    // ── ① 口令词：认「确认启动」，不认半个，也不认相邻的查询句 ──
    assertEq('S-M14 认得口令词', heardStartPhrase('确认启动 4821'), true)
    assertEq('S-M14 认带标点空格的', heardStartPhrase('确认 启动，4821'), true)
    assertEq('S-M14 半个词不认', heardStartPhrase('启动吧'), false)
    assertEq('S-M14 查询句不认', heardStartPhrase('确认一下我的持仓'), false)
    assertEq('S-M14 普通确认不认', heardStartPhrase('确认 800'), false)

    // ── ② 口令码：正常形态 + 三种"被念错后仍要还原"的形态 ──
    assertEq('S-M14 直接念', heardStartCode('确认启动 4821').code, '4821')
    assertEq('S-M14 逐位念', heardStartCode('确认启动 4 8 2 1').code, '4821')
    assertEq('S-M14 中文数字', heardStartCode('确认启动 四八二一').code, '4821')
    // TTS 若把 4821 当"数"念出来（四千八百二十一），用户会**照着念回**那个说法。
    // 数量级词必须丢掉而不是当分隔符 —— 当分隔符会把它切成 4 段各 1 位，永远拼不回来。
    assertEq('S-M14 数量级念法', heardStartCode('确认启动 四千八百二十一').code, '4821')
    assertEq('S-M14 句里夹着别的数', heardStartCode('确认启动，用10U的那个，4821').code, '4821')
    assertEq('S-M14 没有码', heardStartCode('确认启动').code, null)
    assertEq('S-M14 位数不对拒收', heardStartCode('确认启动 12345').code, null)
    // 两组四位数字 → 判歧义，**不放行也不猜**（猜错的方向是启动一个没在看的目标）
    assertEq('S-M14 两组四位数字判歧义', heardStartCode('确认启动，用10U，4821 或者 1234').reason, 'AMBIGUOUS')

    // ── ③ 签发与放行（先证明它对正确的输入放行，再谈它拒什么）──
    const issued = issueStartConsent('m-test0001', T0)
    assertEq('S-M14 码是四位', issued.code.length, 4)
    assertTrue('S-M14 码无前导零', issued.code[0] !== '0', '口令码出现了前导零，念出来会被听丢一位')
    assertEq('S-M14 念法逐位分开', issued.spoken.split(' ').length, 4)
    const say = (c: string) => ({ phrase: '确认启动 ' + c, code: '确认启动 ' + c })
    const okc = checkStartConsent(say(issued.code), T0 + 1000)
    assertEq('S-M14 正确口令放行', okc.ok, true)
    assertEq('S-M14 放行的正是绑定的那份', okc.ok ? okc.planId : null, 'm-test0001')
    assertEq('S-M14 待用态可查', pendingStartConsent(T0 + 1000)?.planId, 'm-test0001')
    assertEq('S-M14 待用态不含明文', JSON.stringify(pendingStartConsent(T0)), JSON.stringify({
      planId: 'm-test0001',
      issuedAt: T0,
      expiresAt: T0 + START_CODE_TTL_MS,
      attempts: 0,
      remainingAttempts: START_MAX_ATTEMPTS,
      expired: false,
    }))

    // ── ④ 四种拒绝，各自可辨，且各有对应的放行 ──
    // 4a 口令词不对：**不计入尝试次数** —— 它不是"猜码失败"，是"根本没在确认启动"
    const noPhrase = checkStartConsent({ phrase: '就启动吧', code: '4821' }, T0 + 1000)
    assertEq('S-M14 缺口令词被拒', noPhrase.ok ? '' : noPhrase.code, 'CONSENT_PHRASE_MISMATCH')
    assertEq('S-M14 缺口令词不扣次数', pendingStartConsent(T0 + 1000)?.attempts, 0)

    // 4b 张冠李戴：面板带了另一份裁定书的 id
    const wrongPlan = checkStartConsent({ planId: 'm-other', ...say(issued.code) }, T0 + 1000)
    assertEq('S-M14 张冠李戴被拒', wrongPlan.ok ? '' : wrongPlan.code, 'CONSENT_PLAN_MISMATCH')
    assertEq('S-M14 带对的 id 仍放行', checkStartConsent({ planId: 'm-test0001', ...say(issued.code) }, T0 + 1000).ok, true)

    // 4c 错码：扣次数、如实说出还剩几次、**扣完之后正确的码仍要放行**
    const wrong = issued.code === '1234' ? '5678' : '1234'
    const bad = checkStartConsent(say(wrong), T0 + 1000)
    assertEq('S-M14 错码被拒', bad.ok ? '' : bad.code, 'CONSENT_CODE_MISMATCH')
    assertEq('S-M14 剩两次', bad.ok ? -1 : bad.remainingAttempts, START_MAX_ATTEMPTS - 1)
    assertEq('S-M14 错一次后正确的码仍放行', checkStartConsent(say(issued.code), T0 + 1000).ok, true)

    // 4d TTL：到点即失效，不做"再给一分钟"
    assertEq(
      'S-M14 TTL 边界内放行',
      checkStartConsent(say(issued.code), T0 + START_CODE_TTL_MS - 1).ok,
      true,
    )
    const expired = checkStartConsent(say(issued.code), T0 + START_CODE_TTL_MS + 1)
    assertEq('S-M14 过期被拒', expired.ok ? '' : expired.code, 'CONSENT_EXPIRED')

    // 4e 连错到上限即作废，且作废之后**连正确的码也不放行**（否则"作废"只是句气话）
    const lim = issueStartConsent('m-test0002', T0)
    const bogus = lim.code === '1234' ? '5678' : '1234'
    checkStartConsent(say(bogus), T0)
    checkStartConsent(say(bogus), T0)
    const last = checkStartConsent(say(bogus), T0)
    assertEq('S-M14 第 N 次错即作废', last.ok ? '' : last.code, 'CONSENT_ATTEMPTS_EXHAUSTED')
    assertEq('S-M14 作废后无待用口令', pendingStartConsent(T0), null)
    assertEq('S-M14 作废后正确的码也不放行', checkStartConsent(say(lim.code), T0).ok, false)

    // ── ⑤ 一次只允许一份待用：新签发作废旧口令（不做静默替换）──
    const oldOne = issueStartConsent('m-old', T0)
    const newOne = issueStartConsent('m-new', T0)
    assertEq('S-M14 新签发作废旧口令', checkStartConsent(say(oldOne.code), T0).ok, false)
    assertEq('S-M14 新口令可用', checkStartConsent(say(newOne.code), T0).ok, true)

    // ── ⑥ 单次消费 ──
    assertEq('S-M14 无待用时被拒', (() => {
      resetStartConsent()
      const r = checkStartConsent(say(newOne.code), T0)
      return r.ok ? '' : r.code
    })(), 'CONSENT_REQUIRED')

    // ── ⑦ 真密钥级要求：明文不落账，连哈希也不落账 ──
    // 9000 的取值空间对 sha256 是离线可穷举的，写哈希等于写明文。
    const issued2 = issueStartConsent('m-test0003', T0)
    const dump = JSON.stringify(getEvents(0))
    assertTrue('S-M14 明文不落账', !dump.includes(issued2.code), '口令明文进了账本')
    assertTrue('S-M14 哈希也不落账', !dump.includes('codeHash'), '口令哈希进了账本（9000 空间可穷举 ⇒ 等于明文）')
    assertTrue(
      'S-M14 签发有留痕',
      getEvents(0).some((e) => e.kind === 'MISSION_START_CONSENT_ISSUED' && e.payload.planId === 'm-test0003'),
      '签发口令没有落账，事后无法回答"它有没有签发过"',
    )
    assertEq('S-M14 成功放行不改状态', checkStartConsent(say(issued2.code), T0).ok, true)
    assertEq('S-M14 成功后仍待用（未消费）', pendingStartConsent(T0)?.planId, 'm-test0003')
    assertEq('S-M14 消费成功', consumeStartConsent('m-test0003'), true)
    assertEq('S-M14 消费后无待用', pendingStartConsent(T0), null)
    assertEq('S-M14 二次消费失败', consumeStartConsent('m-test0003'), false)
    assertEq('S-M14 消费后正确的码不再放行', checkStartConsent(say(issued2.code), T0).ok, false)
    assertTrue(
      'S-M14 消费有留痕',
      getEvents(0).some((e) => e.kind === 'MISSION_START_CONSENT_CONSUMED' && e.payload.planId === 'm-test0003'),
      '消费口令没有落账',
    )
    pass(
      'S-M14 启动口令',
      '口令词 + 四位码（无前导零、逐位可念、三种误读可还原）；四种拒绝各配一条放行；' +
        'TTL 边界、连错作废、新签发覆盖旧口令、单次消费；明文与哈希都不落账',
    )
  }

  // ══════════════ S-M15 端到端：签发 → 错码被拒 → 正码真的启动 ══════════════
  {
    resetLedger()
    resetVoice()

    // ① 不可行**不签发** —— 口令放行的是"现在动手"，不是"目标成立"。
    //    给一个有硬矛盾的目标配口令，等于配了一把能开一扇不存在的门的钥匙。
    const bad = planMission(GOAL_TEXT, goalCtx())
    assertEq('S-M15 不可行不签发口令', bad.consent, null)
    assertTrue('S-M15 不可行不提口令', !bad.spoken.includes('口令'), '不可行的回话里出现了口令，用户会以为可以强行启动')

    // ② 可行才签发。场所夹具用 env 显式钉死，避免"本机恰好设了 VENUE"导致结果漂移。
    const prevVenue = process.env.VENUE
    process.env.VENUE = 'sandbox'
    try {
      const good = planMission('用50000U在沙盒做到55000U，1天内', goalCtx())
      assertEq('S-M15 该判可行', good.plan?.verdict, 'feasible')
      assertTrue('S-M15 可行即签发口令', good.consent !== null, '判了可行却没给口令，用户无从启动')
      assertTrue('S-M15 回话念出口令词', good.spoken.includes(START_PHRASE), '回话里没有口令词：' + good.spoken)
      const code = good.consent?.code ?? ''
      assertTrue(
        'S-M15 口令逐位念',
        good.spoken.includes('口令 ' + (good.consent?.spoken ?? 'x')),
        '口令没有逐位分开念，合成语音会把它读成"四千八百二十一"：' + good.spoken,
      )
      // 签发之后账本里仍然只有明文与哈希之外的观测量
      const dump = JSON.stringify(getEvents(0))
      assertTrue('S-M15 明文不落账（端到端）', !dump.includes(code), '口令明文随裁定路径进了账本')

      stopAutopilot('mission-smoke 前置清理')
      // 自治循环要一个"状态从哪来"的入口，否则 `startAutopilot` 会以
      // `AUTOPILOT_NOT_CONFIGURED` 拒绝 —— 那是"没接线"，不是"不许启动"。
      // 这里**不喂 K 线**：本组只验到"口令通过 → 循环真的起来了"为止，
      // 后面从累积到交易那一整段是 `test:autopilot` 的职责，重复测等于两套夹具。
      configureAutopilot({ getState: getOrchState })
      const wrong = code === '1234' ? '5678' : '1234'

      // ③ 错码：拒绝，且**什么都没启动**
      const r1 = await handleUtterance(START_PHRASE + ' ' + wrong)
      assertEq('S-M15 错码意图', r1.intent, 'confirm_mission_start')
      assertTrue('S-M15 错码说清原因', r1.reply.includes('口令不对'), '回话没讲清是口令的问题：' + r1.reply)
      assertEq('S-M15 错码不启动', getEvents(0).filter((e) => e.kind === 'MISSION_STARTED').length, 0)
      assertTrue(
        'S-M15 错码有留痕',
        getEvents(0).some((e) => e.kind === 'MISSION_START_REFUSED' && e.payload.code === 'CONSENT_CODE_MISMATCH'),
        '拒绝没有落账，事后无法回答"它拒绝过什么"',
      )
      assertTrue('S-M15 错码不占执行线', autopilotStatus().running === false, '错码居然把循环起起来了')

      // ④ 正码：真的启动 —— 整条链上唯一有副作用的一步
      const r2 = await handleUtterance(START_PHRASE + ' ' + code)
      assertEq('S-M15 正码意图', r2.intent, 'confirm_mission_start')
      assertTrue('S-M15 正码已启动', r2.reply.includes('已启动'), '完全正确的口令被拒了：' + r2.reply)
      assertEq('S-M15 落 MISSION_STARTED', getEvents(0).filter((e) => e.kind === 'MISSION_STARTED').length, 1)
      assertEq('S-M15 口令已消费', pendingStartConsent(), null)
      assertEq('S-M15 启动落到既有循环', autopilotStatus().running, true)
      const started = getEvents(0).find((e) => e.kind === 'MISSION_STARTED')
      assertEq('S-M15 目标百分比进账本', started?.payload.targetPct, 10)
      assertTrue('S-M15 执行线有编号', typeof started?.payload.runId === 'string' && String(started.payload.runId).length > 4, '启动没留执行线编号')
      // ★ 测试路径不得通向实盘。这条断言存在的理由是本轮实测踩到过：
      //   `.env` 的 AUTOPILOT_LIVE=true 被读进进程，日志打出 `START live`，
      //   而当时**没有任何东西会因此报红**。
      const apEv = getEvents(0).find((e) => e.kind === 'AUTOPILOT_STARTED')
      assertEq('S-M15 冒烟绝不启动实盘', apEv?.payload.scope, 'paper')

      // ⑤ 同一句话再说一遍：口令已被消费，必须拒绝（一次性是硬要求）
      const r3 = await handleUtterance(START_PHRASE + ' ' + code)
      assertTrue('S-M15 口令不能重放', r3.reply.includes('没有等着启动的任务'), '同一份口令被用了第二次：' + r3.reply)
      assertEq('S-M15 重放不产生第二次启动', getEvents(0).filter((e) => e.kind === 'MISSION_STARTED').length, 1)

      stopAutopilot('mission-smoke 收尾')
    } finally {
      if (prevVenue === undefined) delete process.env.VENUE
      else process.env.VENUE = prevVenue
    }

    // ⑥ 两个确认通道不会串台：「确认启动」不能被通用确认接走，
    //    否则用户会收到"现在没有待确认的操作"，而他明明在授权启动。
    const intent = parseIntent('确认启动 4821', { symbols: SYMBOLS, markPrice: () => MARK })
    assertEq('S-M15 不与下单确认串台', intent.intent, 'confirm_mission_start')
    assertTrue('S-M15 启动口令是危险动作', isDangerous('confirm_mission_start'), '真启动的那个意图没有被列为危险动作')
    assertEq('S-M15 它有中文名', INTENT_LABEL.confirm_mission_start.length > 0, true)
    pass(
      'S-M15 端到端启动',
      '不可行不签发 / 可行才签发且回话念出口令 / 错码被拒且不动状态 / 正码真的启动并落 MISSION_STARTED / ' +
        '口令不能重放 / 不与下单确认串台',
    )
  }

  // ══════════════ S-M16 播报与理由文案：它们是"给人听的字符串" ══════════════
  // 起因是实测：`spoken` 里出现了 `**延长样本**`、`。；`、`。。`。
  // 这些字符串同时承担三件事 —— 上屏、被 TTS 念出来、进账本被事后翻查，
  // 而它们**不是 markdown**：屏幕上就是两个星号，念出来则是一段多余的停顿。
  // 没有任何一道门会因此报红，所以补一道。
  {
    /** 返回"这段话不对劲"的原因；空数组 = 干净。 */
    const textSmells = (s: string): string[] => {
      const bad: string[] = []
      if (s.includes('**')) bad.push('含 markdown 星号')
      if (s.includes('[object Object]')) bad.push('对象被直接拼进文案')
      if (/。。|。；|；。|，，|、、/.test(s)) bad.push('叠标点')
      if (/\bundefined\b/.test(s)) bad.push('含 undefined')
      if (/\bNaN\b/.test(s)) bad.push('含 NaN')
      if (/\s{3,}/.test(s)) bad.push('连续空白')
      return bad
    }

    // ★ 先证明这个检查器**会报红**。不做这一步的话，下面所有断言都可能是
    //   "在任何输入上都返回空数组"的假绿 —— 本项目已复现多次的那类 P0。
    const selfCheck = textSmells('**粗体**。。undefined')
    assertTrue(
      'S-M16 文案检查器自身会报红',
      selfCheck.length >= 3,
      '检查器对明显有问题的串只报了 ' + selfCheck.length + ' 项：' + JSON.stringify(selfCheck),
    )
    assertEq('S-M16 文案检查器不误报干净串', textSmells('这个目标没有硬矛盾，可以启动。').length, 0)

    // ★ 探针要挑**真的会进入判定**的句子。
    //   第一版这里写的是「在沙盒做BTCUSDT」，它只有场所与标的、没有任何金额，
    //   于是 `looksLikeMission` 判 false、`spoken` 为空 —— 那是**正确的回落**
    //   （这句话由普通意图处理），不是"判完了什么都没说"。
    //   把回落当成缺陷来断言，就会逼着代码给一句本不该它说的话。
    const probes: Array<{ name: string; text: string; isMission: boolean }> = [
      { name: '有硬矛盾（含替代方案）', text: '用10U在沙盒做到1000U，1天内', isMission: true },
      { name: '缺槽位（只差时限）', text: '用10U在沙盒做到100U', isMission: true },
      { name: '读完仍可行的', text: '用50000U在沙盒做到55000U，1天内', isMission: true },
      { name: '压根不是任务（必须回落）', text: '你好，现在几点了', isMission: false },
    ]
    for (const p of probes) {
      const r = planMission(p.text, goalCtx())
      assertEq('S-M16 是否判成任务 · ' + p.name, r.isMission, p.isMission)
      const spokenBad = textSmells(r.spoken)
      assertTrue(
        'S-M16 播报干净 · ' + p.name,
        spokenBad.length === 0,
        '播报串里有 ' + JSON.stringify(spokenBad) + '：' + JSON.stringify(r.spoken),
      )
      const reasonBad: string[] = []
      for (const rs of r.plan?.reasons ?? []) {
        for (const b of textSmells(rs.text)) reasonBad.push(rs.code + ':' + b)
        for (const b of textSmells(rs.code)) reasonBad.push(rs.code + ':code 有 ' + b)
      }
      assertTrue(
        'S-M16 理由干净 · ' + p.name,
        reasonBad.length === 0,
        '理由文案有问题：' + JSON.stringify(reasonBad),
      )
      // 进了判定的必须说点什么；回落的不该抢话（否则上层会先答应再改口）。
      if (p.isMission) {
        assertTrue('S-M16 判完了必须有话说 · ' + p.name, r.spoken.trim().length > 0, '判完了却什么都没得说')
      } else {
        assertEq('S-M16 不是任务时不抢话 · ' + p.name, r.spoken, '')
      }
    }
    pass(
      'S-M16 文案卫生',
      '检查器自身可报红 / 不误报干净串 / 四类输入（硬矛盾·缺槽位·可行·回落）的播报与理由均无 markdown 星号、叠标点、undefined、NaN，且回落时不自作主张',
    )
  }

  // ══════════ S-M17 裸倍数与执行诉求：不许把任务静默换成一句报价 ══════════
  //
  // 这一整段对着一个**真实事故**（用户报的）：
  //   「在 OKX 测试网做 BTC 永续，3 天内翻倍」收到的回答是 **BTC 的报价**。
  // 链路是： "翻倍"不带数字 → 旧 `MULTIPLE_RE` 认不出来 → `targetMultiple` 为 null
  //   → `looksLikeMission` 判 false → 语音层兜底"认出标的就当问行情" → 报价。
  //
  // 那个报价是**真的**，所以用户看不出自己的任务被丢掉了 —— 这是最坏的一类
  // 缺陷：不报错、不崩、答案还都对，只有用户的意图没了。
  // 下面每条断言各钉这条链上的一环，且**正反成对**。
  {
    const spec = parseGoal('在OKX测试网做BTC永续，3天内翻倍', goalCtx())
    assertEq('S-M17 裸倍数「翻倍」判为 2 倍', spec.targetMultiple, 2)
    assertEq('S-M17 场所认得出来', spec.venue, 'okx-testnet')
    assertEq('S-M17 标的认得出来', spec.symbol, 'BTCUSDT')
    assertEq('S-M17 期限认得出来', spec.deadlineMs, 3 * 86_400_000)
    assertTrue(
      'S-M17 这是一句执行诉求',
      hasExecutionSignal(spec),
      '一句明显在提任务的话没被判成执行诉求 —— 它会被降级成报价',
    )
    assertTrue(
      'S-M17 缺本金要如实说',
      spec.missing.includes('startNotional'),
      '用户没提本金，missing 里却没有它（那就没法问清楚，只能猜）',
    )

    // 成对：其它不带数字的倍数说法也必须认。
    // 只修「翻倍」这一种就是只修了个案 —— 用户换个说法照样中招。
    const bareCases: [string, number][] = [
      ['10U 翻倍', 2],
      ['10U 翻一番', 2],
      ['10U 翻番', 2],
      ['10U 两倍', 2],
      ['10U 三倍', 3],
      ['10U 十倍', 10],
    ]
    const bareWrong = bareCases.filter(([t, want]) => parseGoal(t, goalCtx()).targetMultiple !== want)
    assertEq(
      'S-M17 各种裸倍数说法都认',
      bareWrong.map(([t, want]) => `${t}→${String(parseGoal(t, goalCtx()).targetMultiple)}（应 ${want}）`).join(' | '),
      '',
    )

    // 反向成对①：不许把**仓位倍率**当成收益目标。
    // "10 倍杠杆"和"翻 10 倍"差一个词，含义差一个数量级。
    const lev = parseGoal('用10U在okx测试网开10倍杠杆', goalCtx())
    assertEq('S-M17 「10倍杠杆」不算收益目标', lev.targetMultiple, null)
    assertEq('S-M17 「10倍杠杆」记成杠杆', lev.explicitLeverage, 10)

    // 反向成对②：1 倍不是目标（说了等于没赚）。认不出来比认错好。
    assertEq('S-M17 「一倍」不构成目标', parseGoal('10U 一倍', goalCtx()).targetMultiple, null)

    // ── 执行诉求判据：正例该接住，反例不许接住 ──
    // 反例这一半尤其要紧：判据放宽的代价是把闲聊拖进裁定，
    // 那**同样**是答非所问 —— 用户问个价，系统反过来问他有多少本金。
    const positives = ['在OKX测试网做BTC永续，3天内翻倍', '在OKX测试网做BTC永续', '用10U做到100U']
    const negatives = ['BTC', '看看币安', '今天天气怎么样', '比特币现在多少钱']
    const missed = positives.filter((t) => !hasExecutionSignal(parseGoal(t, goalCtx())))
    const wrong = negatives.filter((t) => hasExecutionSignal(parseGoal(t, goalCtx())))
    assertEq('S-M17 该接住的执行诉求全接住', missed.join(' | '), '')
    assertEq('S-M17 闲聊与单纯问价不许被拖进裁定', wrong.join(' | '), '')

    // ★ 端到端那一环：**同一句话经过语音意图层必须仍然是任务**。
    //   只断言 `parseGoal` 是不够的 —— 用户的抱怨发生在意图层（他收到的是报价）。
    const intent = parseIntent('在OKX测试网做BTC永续，3天内翻倍', { symbols: SYMBOLS, markPrice: () => MARK })
    assertEq('S-M17 语音层判成任务而不是查行情', intent.intent, 'start_mission')
    assertTrue('S-M17 任务句带着解析出来的 spec', intent.mission !== undefined, '判成任务却没带 spec，裁定层拿不到槽位')

    pass(
      'S-M17 裸倍数与执行诉求',
      '「翻倍」判为 2 倍 · 6 种裸倍说法全认 · 「10倍杠杆」不误当收益目标 · 1 倍不算目标 · ' +
        '3 条执行诉求全接住 / 4 条闲聊与问价不被拖进裁定 · 语音层同一句话判成任务而非报价',
    )
  }

  archive()
  const okCount = scenarios.filter((s) => s.pass).length
  console.log('[OK] MISSION SMOKE PASS - ' + okCount + ' 组断言全绿')
}

main().catch((e) => {
  fail('MISSION SMOKE', e instanceof Error ? e.message : String(e))
})
