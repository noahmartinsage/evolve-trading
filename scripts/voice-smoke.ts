/**
 * 实时语音交互层烟测
 *
 * ── 这份测试要证明的四件事（缺一条这个模块就不算接上）────────────
 * ① **语音没有自己的下单实现。** 一条被逐笔上限拒绝的语音单，
 *    其拒绝理由必须与直接调用 `processOrderIntent` 得到的一字不差。
 *    只断言"被拒了"是不够的 —— 语音层完全可以自己写一条"金额太大"的
 *    本地判断然后拒掉，看着一样，实际上风控根本没被执行到。
 * ② **确认不是走过场。** 未确认不得下单；复述金额不符必须拒；
 *    只有数值对上才放行。三个方向都要断言，只测"能下单"等于没测。
 * ③ **打断真的作废在途答复。** 只把音箱关掉不算打断。
 * ④ **报警不会被任何东西挤掉。** 静音、只报警档位、限流压满 ——
 *    三种情况下 P0 都必须出得来，而 P1/P2/P3 在静音下必须出不来。
 *
 * 反例（不该发生的）与正例成对出现，是这个仓库里被反复验证过的做法：
 * 一个只会变绿的检查，等价于没有检查。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetOrch, seedPrice, processOrderIntent, getOrchState } from '../server/core.ts'
import { appendEvent, getEvents, resetLedger } from '../server/ledger.ts'
import { resetSurveillance } from '../server/surveillance.ts'
import { parseIntent } from '../server/voice/intents.ts'
import { parseChineseNumber, extractAmount, resolveAmount } from '../server/voice/numerals.ts'
import { VOICE_CATALOG, DEFAULT_VOICE_ID, resolveVoiceRequest, getVoice, voicesByEngine } from '../server/voice/voices.ts'
import { NEURAL_VOICES, getNeuralVoice } from '../server/voice/tts.ts'
import { NEURAL_RETRY_MS, neuralAllowed, neuralWordTicks, mp3DurationEstimate, speechPathPlan } from '../src/voice/speechPath.ts'
import { groupByEngine, normalizeProfile, withCatalog } from '../src/voice/configShape.ts'
import type { VoiceConfigView, VoiceProfileView } from '../src/voice/clientTypes.ts'
import {
  configureNarrator,
  observeEvent,
  narratorCounters,
  setPolicy,
  resetNarrator,
  recentNarrations,
  drain,
  tickNarration,
  // 与 anomaly 的 `observeTick` 同名但不同层：这个会走档位/去重/限流，
  // 是"盘面异动最终能不能被听见"的唯一入口。
  observeTick as observeNarratorTick,
} from '../server/voice/narrator.ts'
import { observeTick, configureAnomaly, resetAnomaly, anomalyCounters } from '../server/voice/anomaly.ts'
import { createPending, getPending, beginTurn, commitReply, currentGeneration, sessionStatus, resetSession } from '../server/voice/session.ts'
import {
  handleUtterance,
  interruptVoice,
  voiceStatus,
  setVoiceConfig,
  voiceConfig,
  resetVoice,
  dailyBrief,
  intentContext,
  ttsEngineView,
  synthesizeForVoice,
  resetTtsStats,
  neuralFailureReason,
} from '../server/voice/service.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] VOICE SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'voice-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function assertEq<T>(name: string, actual: T, expected: T, extra = ''): void {
  if (actual !== expected) {
    fail(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${extra ? ` · ${extra}` : ''}`)
  }
}

/** 账本里某类事件出现了几次。 */
function countKind(kind: string): number {
  return getEvents(0).filter((e) => e.kind === kind).length
}

const MARK = 100_000 // BTCUSDT 测试标记价
const SYMBOLS = ['BTCUSDT', 'ETHUSDT']
const CTX = { symbols: SYMBOLS, markPrice: () => MARK }

async function main(): Promise<void> {
  resetLedger()
  resetSurveillance()
  resetSession()
  resetNarrator()
  resetAnomaly()
  resetOrch(100_000)
  getOrchState().risk.maxOrdersPerMinute = 1_000_000
  getOrchState().risk.maxNotionalPerOrder = 500
  seedPrice('BTCUSDT', MARK)
  seedPrice('ETHUSDT', 3_000)

  // ══════════════════ S1 意图解析：逐条断言，不写"某个意图" ══════════════════
  {
    const cases: { text: string; intent: string }[] = [
      { text: '我现在的持仓是什么', intent: 'query_position' },
      { text: '账户里还有多少钱', intent: 'query_equity' },
      { text: '还有哪些未成交的挂单', intent: 'query_orders' },
      { text: '我还能下多少', intent: 'query_risk' },
      { text: '比特币现在多少钱', intent: 'query_market' },
      { text: '你在干什么，下一步打算做什么', intent: 'query_status' },
      { text: '读一下今天的日报', intent: 'query_daily_report' },
      { text: '买两百块钱的比特币', intent: 'place_order' },
      { text: '全部平仓', intent: 'close_position' },
      { text: '暂停交易', intent: 'pause' },
      { text: '继续', intent: 'resume' },
      { text: '紧急停止', intent: 'killswitch_on' },
      { text: '撤掉所有单', intent: 'cancel_all' },
      { text: '确认', intent: 'confirm' },
      { text: '算了', intent: 'reject' },
      { text: '换成静默', intent: 'switch_voice' },
      { text: '只说报警', intent: 'set_verbosity' },
      { text: '再说一遍', intent: 'repeat' },
      { text: '别说了', intent: 'stop_talking' },
      { text: '介绍一下你自己', intent: 'introduce' },
      { text: '你是谁', intent: 'introduce' },
      { text: '帮助', intent: 'help' },
      { text: '今天天气怎么样', intent: 'unknown' },
    ]
    for (const c of cases) {
      const got = parseIntent(c.text, CTX).intent
      if (got !== c.intent) fail('S1 意图解析', `「${c.text}」期望 ${c.intent}，实际 ${got}`)
    }
    pass(
      'S1 意图解析',
      `${cases.length} 条中文口令逐条命中预期意图（含 1 条应判为 unknown 的反例）`,
    )
  }

  // ══════════════════ S1b 介绍自己 · 以及"任务不许被换成报价" ══════════════════
  //
  // 两件用户直接报上来的事，各钉一组成对断言：
  //
  // ① 「介绍一下你自己」原来一路走到兜底 → 回"这句我没听懂"。
  //    一个连自己是谁都说不出来的助手，用户不会把交易交给它。
  //    但这条也不能太宽：「介绍一下比特币」问的是标的，不该被这一条接走。
  //
  // ② 「在 OKX 测试网做 BTC 永续，3 天内翻倍」原来回的是 **BTC 的报价** ——
  //    用户的**任务被静默换成了一个数字**，而且那个数字是真的，
  //    他没有任何线索知道自己的话被丢了。根因与修法见 `mission/goal.ts`
  //    的 `BARE_MULTIPLE_RE` 与 `hasExecutionSignal`。
  {
    // ① 正例：三种问法都该是"介绍自己"
    const introCases = ['介绍一下你自己', '介绍一下自己', '你是谁', '你是什么东西', '自我介绍']
    const introWrong = introCases.filter((t) => parseIntent(t, CTX).intent !== 'introduce')
    assertEq('S1b 问"你是谁"一律判成介绍自己', introWrong.join(' | '), '')

    // ①反例：「介绍」后面跟别的东西是在问那个东西，不是问它自己。
    //    没有这一条时，把正则放宽成裸「介绍」也能全绿 —— 而那会让
    //    「介绍一下比特币」再也不是一个行情问题。
    const notIntro = ['介绍一下比特币', '介绍一下今天的行情']
    const overMatched = notIntro.filter((t) => parseIntent(t, CTX).intent === 'introduce')
    assertEq('S1b 「介绍某样东西」不许被当自我介绍', overMatched.join(' | '), '')

    // ② 用户原话：必须是任务，而**不是**行情。
    const reported = '在OKX测试网做BTC永续，3天内翻倍'
    const r = parseIntent(reported, CTX)
    assertEq('S1b 用户报的那句话是任务不是行情', r.intent, 'start_mission')
    assertEq('S1b 且解析出了 2 倍目标', r.mission?.targetMultiple, 2)
    assertEq('S1b 且场所是 okx 测试网', r.mission?.venue, 'okx-testnet')
    assertEq(
      'S1b 缺本金如实进 missing（要走澄清，不能猜）',
      (r.mission?.missing ?? []).includes('startNotional'),
      true,
      '没提本金却没进 missing',
    )

    // ②b 一条**只有执行诉求判据才接得住**的句子。
    //
    // ★ 这条断言存在的唯一理由是变异测试抓出了上面那条的假绿：
    //   「…3 天内翻倍」在裸倍数修好之后**本来就满足 `looksLikeMission`**，
    //   拿它去验证"意图层接上了 hasExecutionSignal"等于没验 ——
    //   实测把那一行撤掉，整个 S1b 照样全绿。
    //   所以必须补一条槽位缺到 `looksLikeMission` 判 false（没金额、没倍数）、
    //   但明显在提一件事的句子（只有场所 + 产品词 + 动作词）。
    const partial = '在OKX测试网做BTC永续'
    assertEq('S1b 槽位不全但明显是任务的句子也接住', parseIntent(partial, CTX).intent, 'start_mission')
    assertEq('S1b 且它确实不满足"金额+目标"那套判据', parseIntent(partial, CTX).mission?.targetMultiple, null)

    // ②反例：真正的问行情不许被这条改动吃掉。
    //    放宽判据最容易造的错就是把「BTC 多少钱」也拖进裁定 ——
    //    那是同一个缺陷的镜像（用户问价，系统反问他本金）。
    const stillMarket = ['比特币现在多少钱', 'BTC 的报价', '行情怎么样']
    const eaten = stillMarket.filter((t) => parseIntent(t, CTX).intent !== 'query_market')
    assertEq('S1b 真问行情仍然是问行情', eaten.join(' | '), '')

    pass(
      'S1b 介绍自己与答非所问',
      '5 种"你是谁"问法全判介绍自己 / 2 种"介绍某物"不被误接 / ' +
        '用户原话判成任务（2 倍 · okx 测试网 · 缺本金进 missing）/ ' +
        '槽位不全但明显是任务的句子也接住 / 3 种问价仍是问行情',
    )
  }

  // ══════════════════ S2 槽位与中文数字 ══════════════════
  {
    const buy = parseIntent('买两百块钱的比特币', CTX)
    assertEq('S2 槽位', buy.slots?.side, 'buy')
    assertEq('S2 槽位', buy.slots?.symbol, 'BTCUSDT')
    assertEq('S2 槽位', buy.slots?.notional, 200)
    assertEq('S2 槽位', buy.slots?.amountBasis, 'notional')
    if (buy.confidence < 0.6) fail('S2 槽位', `完整口令置信度应 ≥0.6，实际 ${buy.confidence}`)

    const sell = parseIntent('卖出0.5个以太坊', CTX)
    assertEq('S2 槽位', sell.slots?.side, 'sell')
    assertEq('S2 槽位', sell.slots?.symbol, 'ETHUSDT')
    assertEq('S2 槽位', sell.slots?.qty, 0.5)
    assertEq('S2 槽位', sell.slots?.amountBasis, 'qty')

    const live = parseIntent('实盘买两百块钱的比特币', CTX)
    assertEq('S2 槽位', live.slots?.live, true)
    const paper = parseIntent('买两百块钱的比特币', CTX)
    assertEq('S2 槽位', paper.slots?.live, false, '没提实盘就必须默认为仿真')

    // 缺槽位不得靠猜补齐：置信度必须掉下来，让上层转入澄清
    const noSymbol = parseIntent('买两百块钱', CTX)
    if ((noSymbol.slots?.symbol ?? '') !== '') fail('S2 槽位', `没提标的时不该臆造 symbol，实际 ${noSymbol.slots?.symbol}`)
    if (noSymbol.confidence >= 0.6) fail('S2 槽位', `缺标的应降低置信度，实际 ${noSymbol.confidence}`)

    // 数字归一：这几组正是"听错一个零就下一笔合法大单"的高危形态
    const nums: [string, number][] = [
      ['两百', 200],
      ['二百五', 250],
      ['一千五', 1500],
      ['一千零五', 1005],
      ['两万三', 23000],
      ['十五', 15],
      ['二十', 20],
      ['一百二十三', 123],
      ['三千', 3000],
      ['十万', 100000],
      ['一亿二千万', 120000000],
      ['1.5万', 15000],
    ]
    for (const [s, v] of nums) {
      const got = parseChineseNumber(s)
      if (got !== v) fail('S2 中文数字', `「${s}」期望 ${v}，实际 ${got}`)
    }
    // 重点对照：「一千五」=1500 与「一千零五」=1005 在声学上几乎一样，
    // 差一个「零」就差 495 —— 而两个数都在逐笔闸门之内，风控不会响。
    if (parseChineseNumber('一千五') === parseChineseNumber('一千零五')) {
      fail('S2 中文数字', '「一千五」与「一千零五」被判成同值 —— 漏掉了「零」的进位语义')
    }

    // 金额语义：默认按名义额，且必须给出说明
    const unknown = extractAmount('买两百比特币')
    if (!unknown) fail('S2 中文数字', '裸数字未解析出来')
    const resolved = resolveAmount(unknown, MARK)
    if ('error' in resolved) fail('S2 中文数字', `裸数字应可解析，实际报错 ${resolved.error}`)
    else if (resolved.basis !== 'notional') fail('S2 中文数字', `缺单位时应默认名义额，实际 ${resolved.basis}`)

    pass('S2 槽位与中文数字', `槽位抽取 + ${nums.length} 组数字归一 + 「一千五/一千零五」关键对照 + 缺单位默认名义额`)
  }

  // ══════════════════ S3 语音下单必须过同一道风控门 ══════════════════
  {
    // 直接路径（相当于界面按钮）
    const directQty = 800 / MARK
    const direct = processOrderIntent({ clientOrderId: 'direct-gate', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: directQty })
    if (direct.ok) fail('S3 同一道门', '直接路径的 800U 单竟然通过了逐笔上限 —— 前提条件不成立')
    const directReason = direct.reason ?? ''

    // 语音路径：说 800 块钱 → 确认 → 必须得到**同一个** reason
    const ask = await handleUtterance('买八百块钱的比特币')
    if (!ask.pending) fail('S3 同一道门', `语音下单未进入待确认：${JSON.stringify(ask.reply)}`)
    const conf = await handleUtterance('确认 800')
    if (!conf.executed) fail('S3 同一道门', `确认后没有执行结果：${JSON.stringify(conf.reply)}`)
    if (conf.executed.ok) fail('S3 同一道门', '超限的语音单竟然成交了 —— 语音绕过了风控')
    assertEq('S3 同一道门', conf.executed.reason, directReason, '语音路径与直接路径的拒绝理由必须逐字一致')

    // 反向：额度以内必须真的能成，否则"过门"可能只是因为整条路是死的
    const okAsk = await handleUtterance('买一百块钱的比特币')
    if (!okAsk.pending) fail('S3 同一道门', '额度内订单未进入待确认')
    const okConf = await handleUtterance('确认 100')
    if (!okConf.executed?.ok) fail('S3 同一道门', `额度内语音单应成交，实际：${JSON.stringify(okConf.executed)}`)

    // 来源可追溯：clientOrderId 必须带 V- 前缀，且四条事件齐全
    const voiceCmds = getEvents(0).filter((e) => e.kind === 'VOICE_COMMAND')
    if (voiceCmds.length === 0) fail('S3 同一道门', '账本里没有 VOICE_COMMAND —— 语音来源没留痕')
    for (const e of voiceCmds) {
      const id = String(e.payload.clientOrderId ?? '')
      if (!id.startsWith('V-')) fail('S3 同一道门', `语音单号 ${id} 缺少 V- 前缀，无法与人工单区分`)
    }
    const dispatched = getEvents(0).filter((e) => e.kind === 'VOICE_ORDER_DISPATCHED')
    if (dispatched.length < 2) fail('S3 同一道门', `VOICE_ORDER_DISPATCHED 只有 ${dispatched.length} 条，不足 2 条（一成一败）`)

    pass(
      'S3 同一道门',
      `800U 语音单与直接调用得到逐字相同的拒绝理由「${directReason.slice(0, 48)}」；100U 语音单正常成交；` +
        `${voiceCmds.length} 条 VOICE_COMMAND 全部带 V- 前缀可溯源`,
    )
  }

  // ══════════════════ S4 两段式确认三个方向 ══════════════════
  {
    const submitsBefore = countKind('ORDER_SUBMIT')

    // 4a 只提需求不确认 → 不得下单
    const ask = await handleUtterance('买三百块钱的比特币')
    if (!ask.pending) fail('S4 两段式确认', `未生成待确认凭据：${JSON.stringify(ask.reply)}`)
    assertEq('S4 两段式确认', countKind('ORDER_SUBMIT'), submitsBefore, '仅提出需求就产生了 ORDER_SUBMIT')

    // 4b 只说「确认」不带金额 → 必须拒（300 > 50，属于需要复述的档）
    const noAmount = await handleUtterance('确认')
    if (noAmount.executed) fail('S4 两段式确认', '只说「确认」竟然执行了需要复述金额的单')
    if (!noAmount.reply.includes('VOICE_CONFIRM_NEEDS_AMOUNT_ECHO')) {
      fail('S4 两段式确认', `未复述金额的拒绝理由不对：${noAmount.reply}`)
    }
    assertEq('S4 两段式确认', countKind('ORDER_SUBMIT'), submitsBefore, '未复述金额却产生了 ORDER_SUBMIT')

    // 4c 复述了，但念的是错数 → 必须拒，并留下 ASR 听错数字的证据
    const mismatchesBefore = countKind('VOICE_CONFIRM_MISMATCH')
    const wrong = await handleUtterance('确认两千')
    if (wrong.executed) fail('S4 两段式确认', '复述成 2000 仍然执行了 300 的单 —— 金额核对没生效')
    if (!wrong.reply.includes('VOICE_CONFIRM_AMOUNT_MISMATCH')) {
      fail('S4 两段式确认', `金额不符的拒绝理由不对：${wrong.reply}`)
    }
    assertEq('S4 两段式确认', countKind('VOICE_CONFIRM_MISMATCH'), mismatchesBefore + 1, '金额不符没留下 VOICE_CONFIRM_MISMATCH 证据')
    assertEq('S4 两段式确认', countKind('ORDER_SUBMIT'), submitsBefore, '金额不符却产生了 ORDER_SUBMIT')

    // 4d 念对（中文数字形式）→ 放行
    const right = await handleUtterance('确认三百')
    if (!right.executed?.ok) fail('S4 两段式确认', `复述 300 应放行，实际：${JSON.stringify(right.executed)}`)
    assertEq('S4 两段式确认', countKind('ORDER_SUBMIT'), submitsBefore + 1, '放行后应恰好新增 1 条 ORDER_SUBMIT')

    // 4e 负向对照：小额（≤50U）不需要复述，光说「确认」就该放行。
    //     没有这一条，4b 的"必须拒"就无法排除"所有确认都被拒"这种假实现。
    const small = await handleUtterance('买二十块钱的比特币')
    if (!small.pending) fail('S4 两段式确认', '小额单未生成待确认凭据')
    if (small.pending.expectedNotional > 50) fail('S4 两段式确认', `20U 的待确认名义额算成了 ${small.pending.expectedNotional}`)
    const smallConf = await handleUtterance('确认')
    if (!smallConf.executed?.ok) fail('S4 两段式确认', `小额单光说「确认」应放行，实际：${JSON.stringify(smallConf.executed)}`)

    // 4f 实盘单不论金额都必须复述
    const liveAsk = await handleUtterance('实盘买十块钱的比特币')
    if (!liveAsk.pending) fail('S4 两段式确认', '实盘小额单未生成待确认凭据')
    const liveNoEcho = await handleUtterance('确认')
    if (liveNoEcho.executed) fail('S4 两段式确认', '实盘单只说「确认」就执行了 —— 实盘必须复述金额')

    pass(
      'S4 两段式确认',
      '未确认不下单 · 未复述金额拒 · 复述错数拒并留证 · 复述正确放行 · 小额免复述（负向对照）· 实盘一律复述',
    )
  }

  // ══════════════════ S5 打断 ══════════════════
  {
    // 5a 未确认的动作会被打断清掉
    createPending(
      'place_order',
      '仿真买入 BTCUSDT 300 美元',
      { side: 'buy', symbol: 'BTCUSDT', notional: 300, amountBasis: 'notional' },
      300,
      1,
    )
    if (!getPending()) fail('S5 打断', '凭据未建立，用例前提不成立')
    const genBefore = currentGeneration()
    const ir = interruptVoice('SMOKE_TEST')
    assertEq('S5 打断', ir.generation, genBefore + 1, '打断必须让世代号前进')
    if (ir.droppedPending !== true) fail('S5 打断', '打断应报告清掉了待确认凭据')
    if (getPending()) fail('S5 打断', '打断后待确认凭据仍然存在')
    const afterInterrupt = await handleUtterance('确认')
    if (afterInterrupt.executed) fail('S5 打断', '被清掉的凭据在打断后仍被执行了')

    // 5b 在途答复必须被丢弃：用旧世代号提交 → 必须返回 false
    const droppedBefore = sessionStatus().droppedReplies
    const staleTurn = beginTurn('构造一个在途轮次')
    const staleGen = currentGeneration() - 1 // 模拟"打断发生在算答复的过程中"
    const committed = commitReply(staleTurn.turnId, '这条不该被念出来', staleGen)
    assertEq('S5 打断', committed, false, '旧世代号的答复竟然提交成功了')
    if (sessionStatus().droppedReplies <= droppedBefore) {
      fail('S5 打断', `droppedReplies 没有增加（${droppedBefore} → ${sessionStatus().droppedReplies}）`)
    }
    const freshTurn = beginTurn('构造一个新轮次')
    assertEq('S5 打断', commitReply(freshTurn.turnId, '这条应该被念出来', currentGeneration()), true, '当前世代号的答复应能提交')

    // 5c 端到端：确认执行过程中被插话 → 答复作废；但**已确认的动作不会被撤回**。
    //     这是一条刻意保留的不对称，必须被显式断言，否则将来有人"顺手"改成
    //     "打断即撤单"时，没有任何测试会拦。
    await handleUtterance('买三十块钱的比特币')
    const inFlight = handleUtterance('确认')
    interruptVoice('USER_BARGE_IN')
    const result = await inFlight
    assertEq('S5 打断', result.dropped, true, '被插入打断的轮次，其答复必须标记为丢弃')
    if (result.executed?.ok) {
      // 动作已生效 —— 这正是要固定下来的语义：确认是不可撤销的授权
      const cid = result.executed.clientOrderId ?? ''
      if (!getEvents(0).some((e) => e.kind === 'VOICE_ORDER_DISPATCHED' && String(e.payload.clientOrderId) === cid)) {
        fail('S5 打断', `答复标记为丢弃，但账本里找不到对应的 VOICE_ORDER_DISPATCHED（${cid}）`)
      }
    }

    pass(
      'S5 打断',
      '打断清空待确认 · 旧世代答复提交失败且计数 · 端到端插话作废答复；并确认「已确认的动作不因打断回滚」这一刻意不对称',
    )
  }

  // ══════════════════ S6 播报去重与限流（P0 不可被挤掉）══════════════════
  {
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '收集样本', nextStep: '攒够样本就跑门禁', activity: '收了 120 根 K 线' }),
      equity: () => ({ equity: 101_000, starting: 100_000, peak: 101_000 }),
    })
    setPolicy({ verbosity: 'chatty', muted: false })

    // 6a 同键去重
    for (let i = 0; i < 5; i++) observeEvent('ORDER_FILL', { clientOrderId: 'dup', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 1, fillId: 'f-dup' }, 1, 1_000 + i)
    assertEq('S6 播报限流', narratorCounters().emittedByPriority.P1_IMPORTANT, 1, '同键事件应只播 1 次')
    if (narratorCounters().suppressedByDedupe !== 4) {
      fail('S6 播报限流', `去重次数应为 4，实际 ${narratorCounters().suppressedByDedupe}`)
    }

    // 6b 限流：灌 60 条互不相同的 P3，必须被压掉一部分，且被压掉的会被合并播报
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '收集样本', nextStep: '攒够样本就跑门禁' }),
      equity: () => ({ equity: 101_000, starting: 100_000, peak: 101_000 }),
    })
    setPolicy({ verbosity: 'chatty', muted: false })
    for (let i = 0; i < 60; i++) {
      observeEvent('ORDER_CANCEL', { clientOrderId: `c-${i}` }, i + 1, 10_000 + i)
    }
    const c = narratorCounters()
    if (c.suppressedByRate === 0) fail('S6 播报限流', '灌 60 条同分钟事件却没有任何限流 —— 限流是死的')
    if (c.coalesced === 0) fail('S6 播报限流', '限流发生了但没有累计到待合并条数')
    if (c.suppressedByMute !== 0) fail('S6 播报限流', `未静音却出现 suppressedByMute=${c.suppressedByMute}`)

    // 6c 限流压满之后，P0 必须仍然出得来
    const p0Before = narratorCounters().emittedByPriority.P0_ALARM
    observeEvent('KILLSWITCH_ON', { reason: 'SMOKE', cancelledOrders: 3 }, 9_999, 10_100)
    assertEq('S6 播报限流', narratorCounters().emittedByPriority.P0_ALARM, p0Before + 1, '限流窗口内 P0 报警被挤掉了')

    const lines = drain(100)
    const p0Lines = lines.filter((l) => l.priority === 'P0_ALARM')
    if (p0Lines.length === 0 || lines[0].priority !== 'P0_ALARM') {
      fail('S6 播报限流', `出队顺序未把 P0 排在最前：${lines.map((l) => l.priority).join(',')}`)
    }

    pass('S6 播报限流', `同键去重 4 次 · 60 条/分钟被压掉 ${c.suppressedByRate} 条并计入合并 · 限流窗口内 P0 照常输出且排在队首`)
  }

  // ══════════════════ S7 静音与档位：只能压住非报警 ══════════════════
  {
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '收集样本', nextStep: '攒够样本就跑门禁' }),
      equity: () => ({ equity: 100_000, starting: 100_000, peak: 100_000 }),
    })
    setPolicy({ verbosity: 'normal', muted: true })

    observeEvent('ORDER_FILL', { clientOrderId: 'm1', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 1, fillId: 'm1' }, 1, 20_000)
    observeEvent('KILLSWITCH_ON', { reason: 'SMOKE_MUTE' }, 2, 20_001)
    const muted = narratorCounters()
    if (muted.suppressedByMute === 0) fail('S7 静音', '静音状态下 P1 没有被压掉 —— 静音是无效的')
    if (muted.emittedByPriority.P1_IMPORTANT !== 0) fail('S7 静音', '静音状态下 P1 仍然播出了')
    assertEq('S7 静音', muted.emittedByPriority.P0_ALARM, 1, '静音状态下报警必须照说')

    // 档位：alarm-only 压住 P1，但同样不得压住 P0
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '收集样本', nextStep: '攒够样本就跑门禁' }),
      equity: () => ({ equity: 100_000, starting: 100_000, peak: 100_000 }),
    })
    setPolicy({ verbosity: 'alarm-only', muted: false })
    observeEvent('ORDER_FILL', { clientOrderId: 'm2', symbol: 'BTCUSDT', side: 'buy', qty: 1, price: 1, fillId: 'm2' }, 3, 21_000)
    observeEvent('KILLSWITCH_ON', { reason: 'SMOKE_ALARM_ONLY' }, 4, 21_001)
    const alarmOnly = narratorCounters()
    if (alarmOnly.suppressedByVerbosity === 0) fail('S7 静音', 'alarm-only 档位没有压掉 P1')
    assertEq('S7 静音', alarmOnly.emittedByPriority.P0_ALARM, 1, 'alarm-only 档位下报警必须照说')

    // 工作状态播报：变化才说，不变则重复不播
    resetNarrator()
    let stage = '收集样本'
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: stage, nextStep: '攒够样本就跑门禁' }),
      equity: () => ({ equity: 100_000, starting: 100_000, peak: 100_000 }),
    })
    setPolicy({ verbosity: 'chatty', muted: false })
    const t1 = tickNarration(30_000)
    const t2 = tickNarration(31_000)
    if (t1 === 0) fail('S7 静音', '首次状态播报未产出')
    if (t2 !== 0) fail('S7 静音', `状态未变却重复播报（${t2} 条）—— 会很快把用户逼去静音`)
    stage = '选优'
    const t3 = tickNarration(32_000)
    if (t3 === 0) fail('S7 静音', '阶段变化后未产出状态播报')

    // ── 默认档必须能说出"我在干什么"（2026-09-17 补的正负对照）────────────
    //
    // 这条曾经**失效过**：`normal` 只放行 P0/P1，而工作状态是 P2_STATUS ——
    // 后端每 3 秒都在生成"我在干什么/下一步干什么"，默认档位每一条都丢掉。
    // 用户的体感是"它一点都不智能、从不报告自己在做什么"。
    // 一份永远不被消费的输出，与没写这段代码没有区别。
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '自动驾驶', nextStep: '等下一根 K 线' }),
      equity: () => ({ equity: 101_000, starting: 100_000, peak: 101_000 }),
    })
    setPolicy({ verbosity: 'normal', muted: false })
    const statusOut = tickNarration(50_000)
    if (statusOut === 0) fail('S7 静音', '默认档没有产出工作状态播报 —— 桌宠将永远说不出"我在干什么"')
    assertEq('S7 静音', narratorCounters().emittedByPriority.P2_STATUS, 1, 'normal 档必须放行 P2_STATUS')

    // 反向：默认档仍**不得**放行 P3 盘面异动。
    // 它是参考信息，每次都报会把人逼去按静音 —— 而静音是全局的，连报警一起关掉。
    //
    // ★ 这里必须分两步，不能一步断言"normal 下拿到 null"：
    // `narrator.observeTick` 返回 null 有**两种**原因 —— "异动根本没触发"和
    // "触发了但被档位压掉"，而只有后者是这里要证明的。
    // 一步写法在"异动检测坏掉"时同样会绿 —— 又是一道不可能失败的检查。
    resetNarrator()
    resetAnomaly()
    configureAnomaly({ windowSec: 300, minSamples: 3, mildMovePct: 0.05, strongMovePct: 9, rangePct: 9, cooldownSec: 0, atrMultiple: 99 })
    setPolicy({ verbosity: 'chatty', muted: false })
    let mild = null
    for (let i = 0; i < 6; i += 1) {
      mild = observeNarratorTick('MILDTEST', 100_000 + i * 60, 60_000 + i * 1_000)
      if (mild) break
    }
    if (!mild) fail('S7 静音', '构造不出 mild 盘面异动 —— 反向对照失效，等于没测')
    assertEq('S7 静音', mild?.priority, 'P3_MARKET', 'mild 异动的档位应为 P3_MARKET')
    assertEq('S7 静音', narratorCounters().emittedByPriority.P3_MARKET, 1, 'chatty 档必须放行 P3_MARKET')

    // 换到默认档，喂**同一段行情**：这条异动必须出不来了，且必须留下被压的痕迹
    resetNarrator()
    resetAnomaly()
    // ★ `resetAnomaly()` 会把判定参数一并还原成默认值（mildMovePct 0.6 / minSamples 8）。
    // 不重新配置的话这一轮压根触发不了异动 —— 于是"被档位压掉"和"根本没发生"
    // 在断言里长得一模一样。这正是这类反向对照最容易自欺的地方。
    configureAnomaly({ windowSec: 300, minSamples: 3, mildMovePct: 0.05, strongMovePct: 9, rangePct: 9, cooldownSec: 0, atrMultiple: 99 })
    const beforeSuppressed = narratorCounters().suppressedByVerbosity
    setPolicy({ verbosity: 'normal', muted: false })
    let blocked = null
    for (let i = 0; i < 6; i += 1) {
      blocked = observeNarratorTick('MILDTEST', 100_000 + i * 60, 60_000 + i * 1_000)
      if (blocked) break
    }
    assertEq('S7 静音', blocked, null, 'normal 档不得放行 P3_MARKET')
    assertEq('S7 静音', narratorCounters().emittedByPriority.P3_MARKET, 0, 'normal 档下 P3 必须一条都不出')
    if (narratorCounters().suppressedByVerbosity <= beforeSuppressed) {
      fail('S7 静音', 'P3 被压掉却没有计入 suppressedByVerbosity —— 压制过程不可观测，等于静默丢弃')
    }

    pass('S7 静音与档位', '静音压 P1 不压 P0 · alarm-only 压 P1 不压 P0 · 状态不变不重复播报、变则播报 · 默认档放 P2 状态但压 P3 异动（chatty 才放）')
  }

  // ══════════════════ S8 盘面异动：正负对照 ══════════════════
  {
    resetAnomaly()
    // atrMultiple 设成 99 以关掉 ATR 分支，让本例只检验幅度判据（ATR 分支另有单测）
    configureAnomaly({ windowSec: 300, minSamples: 5, mildMovePct: 0.6, strongMovePct: 1.5, rangePct: 1.5, cooldownSec: 0, atrMultiple: 99 })

    // 8a 负向对照：横盘不得报
    let flatHit = null
    for (let i = 0; i < 30; i++) flatHit = observeTick('FLAT', 100, 100_000 + i * 1_000)
    if (flatHit !== null) fail('S8 盘面异动', `横盘 30 个 tick 竟然报出异动：${JSON.stringify(flatHit)}`)
    if (anomalyCounters().detected !== 0) fail('S8 盘面异动', `横盘误报计数 ${anomalyCounters().detected}`)

    // 8b 负向对照：样本不足不得报
    let fewHit = null
    for (let i = 0; i < 3; i++) fewHit = observeTick('FEW', 100 * (1 + 0.1 * i), 200_000 + i * 1_000)
    if (fewHit !== null) fail('S8 盘面异动', '样本不足时仍然报出异动')

    // 8c 正向：持续拉升 —— 必须**先**出 mild、越过强阈值后出 strong
    const upHits: { severity: string; direction: string }[] = []
    for (let i = 0; i < 40; i++) {
      const h = observeTick('UP', 100 * (1 + 0.001 * i), 300_000 + i * 1_000)
      if (h) upHits.push({ severity: h.severity, direction: h.direction })
    }
    if (upHits.length === 0) fail('S8 盘面异动', '持续拉升 4% 未报出任何异动')
    if (upHits[0].severity !== 'mild') {
      fail('S8 盘面异动', `刚越过 mild 阈值（0.6%）就报成了 ${upHits[0].severity} —— 分档没有梯度`)
    }
    if (!upHits.some((h) => h.severity === 'strong')) {
      fail('S8 盘面异动', `拉升到 4% 仍未出现 strong 级（实际最高只有 ${upHits.map((h) => h.severity).join('/')}）`)
    }
    if (upHits.some((h) => h.direction !== 'up')) fail('S8 盘面异动', '拉升方向的判定出现反号')

    // 8d 极差分支：把一个几乎必然落在净变化判据之外的大幅回撤做成用例。
    //     做法是把 mild/strong 的**净变化**阈值抬到 10%/20%，只留 rangePct=1.5%，
    //     于是这条用例只能由极差分支命中 —— 否则它证明不了极差分支是活的。
    resetAnomaly()
    configureAnomaly({ windowSec: 300, minSamples: 5, mildMovePct: 10, strongMovePct: 20, rangePct: 1.5, cooldownSec: 0, atrMultiple: 99 })
    let rangeHit = null
    const spikePath = [100, 100, 100, 100, 100, 100, 102.5, 100.1, 100, 100]
    for (let i = 0; i < spikePath.length; i++) {
      const h = observeTick('SPIKE', spikePath[i], 400_000 + i * 1_000)
      if (h) {
        rangeHit = h
        break
      }
    }
    if (!rangeHit) fail('S8 盘面异动', '净变化阈值抬高后，2.5% 的插针未被极差分支捕获')
    assertEq('S8 盘面异动', rangeHit.trigger, 'range', '这条应当由极差分支命中')
    if (rangeHit.rangePct < 2) fail('S8 盘面异动', `极差只算到 ${rangeHit.rangePct}%`)

    // 8e 冷却：同标的同方向在冷却期内只报一次
    resetAnomaly()
    configureAnomaly({ windowSec: 300, minSamples: 5, mildMovePct: 0.6, strongMovePct: 1.5, rangePct: 1.5, cooldownSec: 600, atrMultiple: 99 })
    let hits = 0
    let price = 100
    for (let i = 0; i < 60; i++) {
      price = price * 1.001
      if (observeTick('COOL', price, 500_000 + i * 1_000)) hits += 1
    }
    assertEq('S8 盘面异动', hits, 1, '冷却期内应只报 1 次')

    pass('S8 盘面异动', '横盘不报 · 样本不足不报 · 拉升先 mild 后 strong · 极差分支单独命中插针 · 冷却期只报 1 次')
  }

  // ══════════════════ S9 播报溯源 ══════════════════
  {
    resetNarrator()
    configureNarrator({
      workStatus: () => ({ running: true, stageLabel: '收集样本', nextStep: '攒够样本就跑门禁' }),
      equity: () => ({ equity: 100_000, starting: 100_000, peak: 100_000 }),
    })
    setPolicy({ verbosity: 'chatty', muted: false })

    const real = appendEvent('ORDER_REJECT', { clientOrderId: 'prov-1', reason: 'PROV_TEST_REJECT' })
    const line = observeEvent(real.kind, real.payload, real.seq, real.ts)
    if (!line) fail('S9 播报溯源', '真实事件没有产出播报')
    assertEq('S9 播报溯源', line.sourceSeq, real.seq, '播报的 sourceSeq 与账本事件序号不一致')

    observeEvent('KILLSWITCH_ON', { reason: 'PROV' }, appendEvent('KILLSWITCH_ON', { reason: 'PROV', cancelledOrders: 0 }).seq, 60_000)
    tickNarration(61_000)
    tickNarration(62_000)

    const ledgerSeq = new Set(getEvents(0).map((e) => e.seq))
    const nonEventSources = new Set(['AUTOPILOT_STATUS_PROBE', 'NARRATOR_RATE_LIMIT', 'PRICE_TICK'])
    const suspicious = recentNarrations(200).filter(
      (l) => !nonEventSources.has(l.sourceKind ?? '') && (l.sourceSeq === undefined || !ledgerSeq.has(l.sourceSeq)),
    )
    if (suspicious.length > 0) {
      fail(
        'S9 播报溯源',
        `${suspicious.length} 条播报声称来自事件却在账本里找不到出处：` +
          suspicious.map((l) => `${l.sourceKind}:${l.sourceSeq}`).join(', '),
      )
    }

    // 非事件来源必须自己声明清楚，不能留空 —— 留空会让溯源检查形同虚设
    const undeclared = recentNarrations(200).filter((l) => (l.sourceKind ?? '') === '' && l.sourceSeq === undefined)
    if (undeclared.length > 0) fail('S9 播报溯源', `${undeclared.length} 条播报既无 sourceSeq 也无 sourceKind`)

    pass('S9 播报溯源', `事件类播报的 sourceSeq 全部能在账本里命中（当前链长 ${ledgerSeq.size}）；无出处者必须显式声明来源类型`)
  }

  // ══════════════════ S10 语音配置：只允许往严的方向调 ══════════════════
  {
    // 默认音色必须是甜美中文女声
    assertEq('S10 语音配置', voiceConfig().voiceId, DEFAULT_VOICE_ID)
    const dv = getVoice(DEFAULT_VOICE_ID)
    if (!dv) fail('S10 语音配置', '默认音色不在目录里')
    assertEq('S10 语音配置', dv?.locale, 'zh-CN')
    assertEq('S10 语音配置', dv?.gender, 'female')
    // ★ 这条是"音色太生硬、一点都不拟人化"的直接处方：本机那条路在 Windows 上
    //   注定是 SAPI5 拼接式合成。把它当默认，等于用户第一次听到的永远是机器音，
    //   然后他得自己猜"是不是还有更好的、在哪儿选"。
    assertEq('S10 语音配置', dv?.engine, 'neural', '默认音色必须走云端神经合成，不能是系统语音包')
    if (VOICE_CATALOG.length < 5) fail('S10 语音配置', `可选音色只有 ${VOICE_CATALOG.length} 个，用户要求"几个声音可选"`)
    if (!VOICE_CATALOG.some((v) => v.id === 'silent')) fail('S10 语音配置', '缺少静默音色（无语音包时的兜底）')

    // 换音色的自然语言别名
    assertEq('S10 语音配置', resolveVoiceRequest('换个男声'), 'zh-CN-YunjianNeural')
    assertEq('S10 语音配置', resolveVoiceRequest('换成温柔一点的'), 'zh-CN-XiaoxiaoNeural')
    // 降级指令必须存在：云端坏掉时用户得有一句话能主动切回本机，
    // 而不是等面板上的说明告诉他去点哪个按钮
    assertEq('S10 语音配置', resolveVoiceRequest('用本机音色'), 'sweet-female-zh')

    // 不存在的音色必须被拒
    const bad = setVoiceConfig({ voiceId: 'no-such-voice' })
    if (bad.ok) fail('S10 语音配置', '不存在的音色竟然设置成功了')

    // 关键：不提供"关闭确认"的取值
    const off = setVoiceConfig({ confirmPolicy: 'off' as never })
    if (off.ok) fail('S10 语音配置', 'confirmPolicy 竟然能设成 off —— 确认开关必须是不可关闭的')

    // 关键：实盘必须带策略身份，且系统不得替用户挑一个
    const cur = voiceConfig()
    if (cur.defaultLiveStrategyId === 'undefined') fail('S10 语音配置', 'defaultLiveStrategyId 出现了字符串 undefined')
    assertEq('S10 语音配置', cur.confirmPolicy, 'graded')

    // ★ 写入路径必须返回与读取路径**同一种形状**的配置。
    //
    // 这里曾经有两种形状：GET 返回带 catalog 的，`setVoiceConfig` 返回不带 catalog 的裸 cfg。
    // 前端 `config?.catalog.find(...)` 的可选链只保护了 config、没保护 catalog，
    // 于是每次点「换音色」都抛 TypeError 崩进 ErrorBoundary（界面显示"发生未捕获错误"），
    // 音色列表同时整块消失（用户看到的是"选不了其他音色"）。两个症状同源。
    const write = setVoiceConfig({ voiceId: 'warm-female-zh' })
    if (!write.ok) fail('S10 语音配置', '合法音色竟然设置失败')
    if (!Array.isArray(write.config.catalog) || write.config.catalog.length === 0) {
      fail('S10 语音配置', '写入路径返回的 config 缺少 catalog —— 前端会因此崩页并清空音色列表')
    }
    assertEq(
      'S10 语音配置',
      write.config.catalog.length,
      voiceConfig().catalog.length,
      '读写两条路径返回的 catalog 长度必须一致（两种形状就是两个真相）',
    )
    setVoiceConfig({ voiceId: DEFAULT_VOICE_ID })

    // 日报必须产出可朗读文本，且对账状态不能把"没跑过"说成"一致"
    const brief = dailyBrief()
    if (brief.narration.length < 40) fail('S10 语音配置', '日报文本过短，可能没组装起来')
    if (!['consistent', 'inconsistent', 'unknown'].includes(brief.reconciliation)) {
      fail('S10 语音配置', `对账状态取值异常：${brief.reconciliation}`)
    }

    // 上下文必须取自有真实行情的标的，不能凭空造
    const ctx = intentContext()
    if (!ctx.symbols.includes('BTCUSDT')) fail('S10 语音配置', `意图上下文标的池缺少 BTCUSDT：${JSON.stringify(ctx.symbols)}`)

    pass(
      'S10 语音配置',
      `默认音色 ${DEFAULT_VOICE_ID}（zh-CN 女声）· 目录 ${VOICE_CATALOG.length} 个可选 · 别名换音色生效 · ` +
        `不存在音色被拒 · confirmPolicy 无 off 取值 · 日报可朗读且对账三态分明`,
    )
  }

  // ══════════════════ S11 端到端：一轮真实语音问答 ══════════════════
  {
    resetVoice()
    resetOrch(100_000)
    seedPrice('BTCUSDT', MARK)
    getOrchState().risk.maxOrdersPerMinute = 1_000_000

    const q1 = await handleUtterance('我现在的持仓是什么')
    assertEq('S11 端到端', q1.intent, 'query_position')
    if (!q1.reply.includes('持仓')) fail('S11 端到端', `查持仓的回话不像回话：${q1.reply}`)

    const q2 = await handleUtterance('账户里还有多少钱')
    assertEq('S11 端到端', q2.intent, 'query_equity')
    if (!q2.reply.includes('权益')) fail('S11 端到端', `查权益的回话不对：${q2.reply}`)

    const q3 = await handleUtterance('读一下今天的日报')
    assertEq('S11 端到端', q3.intent, 'query_daily_report')
    if (q3.reply.length < 40) fail('S11 端到端', '日报回话过短')

    const q4 = await handleUtterance('你在干什么')
    assertEq('S11 端到端', q4.intent, 'query_status')

    const q5 = await handleUtterance('别说了')
    assertEq('S11 端到端', q5.intent, 'stop_talking')
    if (!voiceConfig().muted) fail('S11 端到端', '「别说了」之后没有进入静音')
    // 静音后报警仍须播出
    const beforeAlarm = narratorCounters().emittedByPriority.P0_ALARM
    observeEvent('KILLSWITCH_ON', { reason: 'E2E' }, appendEvent('KILLSWITCH_ON', { reason: 'E2E', cancelledOrders: 0 }).seq, 70_000)
    assertEq('S11 端到端', narratorCounters().emittedByPriority.P0_ALARM, beforeAlarm + 1, '对用户说过"别说了"之后，报警被一起静音了')

    // 收尾做一次真实打断，确认「打断会让世代号前进」在端到端路径上也成立。
    // （本段开头 resetVoice 把世代号清零了，所以要相对比较，不能断言绝对值。）
    const genBefore = voiceStatus().generation
    const ir = interruptVoice('E2E_BARGE_IN')
    assertEq('S11 端到端', ir.generation, genBefore + 1, '端到端路径上打断未让世代号前进')

    const st = voiceStatus()
    if (st.interruptedCount < 1) fail('S11 端到端', '打断计数没有增加')
    if (st.recentNarrations.length === 0) fail('S11 端到端', '播报历史为空')

    pass('S11 端到端', `5 轮真实问答（查仓/查权益/日报/状态/静音）逐一命中；静音后报警仍播出；打断后世代号 ${genBefore} → ${st.generation}`)
  }

  // ══════════════════ S12 播报文案不得出现占位符垃圾 ══════════════════
  // 这一场景来自一次**运行时实测**：`SLO_BREACH` 的 `breaches` 是对象数组
  // （`{key,label,value,limit,unit}`），旧实现直接 `join('、')`，
  // 于是念出来的是「服务指标越线 1 项：[object Object]。」——
  // 这句话是要进合成器出声的，用户听到的将是"object Object"。
  // 教训：**播报文案是"给人听的字符串"，不是"给日志看的 object"**，
  // 任何拼进文案的字段都必须显式格式化。
  {
    observeEvent(
      'SLO_BREACH',
      {
        breaches: [{ key: 'rejectRatioPct', label: '订单拒绝率', value: 66.7, limit: 50, unit: '%' }],
        values: { rejectRatioPct: 66.7 },
      },
      appendEvent('SLO_BREACH', { note: 'smoke' }).seq,
      90_000,
    )
    const slo = recentNarrations(1)[0]
    if (!slo || slo.sourceKind !== 'SLO_BREACH') fail('S12 文案卫生', 'SLO_BREACH 未产出播报（此时应处于静音态，P0 仍必须放行）')
    if (!slo.text.includes('订单拒绝率') || !slo.text.includes('66.7')) {
      fail('S12 文案卫生', `SLO_BREACH 明细没被念成人话：${slo.text}`)
    }

    // `str()` 的对象分支必须被**真的测到**，否则它就是一条"永远不执行"的防御
    // ——那正是本项目最忌讳的形态（F-41）。
    observeEvent(
      'ORDER_REJECT',
      { clientOrderId: 'obj-shape', reason: { nested: true } },
      appendEvent('ORDER_REJECT', { reason: 'obj-shape' }).seq,
      91_000,
    )
    const objLine = recentNarrations(1)[0]
    if (!objLine || objLine.sourceKind !== 'ORDER_REJECT') fail('S12 文案卫生', '对象形态的 reason 未产出播报')
    if (/\[object Object\]/.test(objLine.text)) {
      fail('S12 文案卫生', `对象字段被 String() 了：${objLine.text}`)
    }

    // 全局卫生扫描：任何一条已发播报的文案里都不允许出现这些占位符。
    // 判据直白得不需要解释 —— 这些东西念出来就是事故。
    const bad = /\[object Object\]|undefined|NaN|\bnull\b/
    const lines = recentNarrations(200)
    if (lines.length === 0) fail('S12 文案卫生', '播报历史为空，这个场景没在测任何东西')
    for (const l of lines) {
      if (bad.test(l.text)) fail('S12 文案卫生', `播报文案含占位符垃圾：「${l.text}」`)
    }
    pass(
      'S12 文案卫生',
      `SLO_BREACH 明细格式化为可朗读文本（静音态下仍放行）· 对象字段不再退化为 [object Object] · 扫描 ${lines.length} 条已发播报，无 [object Object]/undefined/NaN/null`,
    )
  }

  // ══════════════════ S13 神经音色与出声链路 ══════════════════
  //
  // 这一组全部**不联网**：它断言的要么是目录/映射这类纯数据关系，
  // 要么是"任何网络请求之前就返回"的前置闸，要么是纯函数。
  //
  // 刻意不测真实合成 —— 那需要外网、需要那个随时会过期的握手版本号，
  // 一次抖动就会把 CI 变红，然后所有人学会忽略它。真实合成由人工联网的
  // `npm run voice:tts` 覆盖。
  {
    const name = 'S13 出声链路'

    // ── ① 目录里的神经档必须**派生自** NEURAL_VOICES，不是另抄一份列表 ──
    const neuralIds = NEURAL_VOICES.map((v) => v.id).slice().sort()
    const catalogNeuralIds = voicesByEngine('neural').map((v) => v.id).slice().sort()
    assertEq(
      name,
      catalogNeuralIds.join(','),
      neuralIds.join(','),
      '目录里的神经档必须与 NEURAL_VOICES 逐条一致 —— 两份列表迟早分岔，而分岔时两边都是合法值',
    )

    for (const v of VOICE_CATALOG) {
      if (v.engine !== 'neural' && v.engine !== 'local') fail(name, `音色 ${v.id} 的 engine 取值非法：${String(v.engine)}`)
      if (!Array.isArray(v.matchNames)) fail(name, `音色 ${v.id} 的 matchNames 不是数组，渲染期会抛`)
      if (!Array.isArray(v.tags)) fail(name, `音色 ${v.id} 的 tags 不是数组，渲染期会抛`)
      if (v.engine === 'neural') {
        // pitch 在这个端点上实测不生效 —— 留一个能拖但没反应的滑块就是"假选项"
        assertEq(name, v.pitch, 1, `神经音色 ${v.id} 的 pitch 必须是 1（该参数不生效）`)
        if (!v.neuralId) fail(name, `神经音色 ${v.id} 缺 neuralId，合成时无法寻址`)
        if (v.matchNames.length > 0) fail(name, `神经音色 ${v.id} 不该有本机匹配候选 —— 它不经系统语音包`)
      }
    }
    if (!getNeuralVoice(DEFAULT_VOICE_ID)) {
      fail(name, '默认音色在神经目录里找不到实现 —— 合成时会被静默换成别的嗓子')
    }

    // ── ② 引擎映射只有一份：视图里的 engineOf 必须与目录逐条相同 ──
    const ev = ttsEngineView()
    for (const v of VOICE_CATALOG) {
      assertEq(name, ev.engineOf[v.id], v.engine, `engineOf 缺 ${v.id} 或与目录不一致`)
    }
    assertEq(name, Object.keys(ev.engineOf).length, VOICE_CATALOG.length, 'engineOf 条数必须等于目录条数')
    assertEq(name, ev.neural.voices.length, NEURAL_VOICES.length)

    // ── ③ 两道前置闸：正常状态不许被记成"云端失败" ──
    resetTtsStats()
    const localCall = await synthesizeForVoice('测试一句话', { voiceId: 'sweet-female-zh' })
    if (localCall.ok) fail(name, '对本机音色发起云端合成竟然成功了')
    assertEq(name, localCall.kind, 'local-engine')
    assertEq(
      name,
      ttsEngineView().neural.stats.attempts,
      0,
      '选本机音色不该计入云端尝试次数 —— 否则面板会长期挂着一个来自正常选择的失败数，然后用户学会忽略它',
    )
    assertEq(name, ttsEngineView().neural.stats.failed, 0)

    const unknown = await synthesizeForVoice('测试一句话', { voiceId: 'no-such-voice' })
    if (unknown.ok) fail(name, '不存在的音色竟然合成成功了')
    assertEq(name, unknown.kind, 'unknown-voice')
    assertEq(name, ttsEngineView().neural.stats.attempts, 0, '未知音色也不该计入云端尝试次数')

    // ── ④ 失败原因映射必须完备，且每条都说清"退回了本机" ──
    //
    // 断言分两半，是对着代码的真实行为写的：
    //   · 三类**已命名**的失败必须各有独立文案（版本过期要能修、网络问题只能等、
    //     超时是服务端慢 —— 处置完全不同，糊成一句就等于没告诉你怎么办）；
    //   · 其余一切（含没见过的 kind）必须落在那句通用文案上，**不许是空**。
    //     fail-closed：宁可说一句笼统的，也不能让界面显示空白。
    const named = new Set(['forbidden', 'timeout', 'network'].map((k) => neuralFailureReason(k)))
    assertEq(name, named.size, 3, '三类已命名的失败必须各有独立文案 —— 版本过期与网络抖动要分开说')
    for (const k of ['forbidden', 'timeout', 'network', 'protocol', '一个没见过的类型']) {
      const t = neuralFailureReason(k)
      if (typeof t !== 'string' || t.length === 0) fail(name, `失败类型 ${k} 没有对应文案 —— 界面上会显示空白`)
      if (!t.includes('本机')) fail(name, `失败类型 ${k} 的文案没说"退回本机"：「${t}」`)
    }

    // ── ⑤ 路径决策：P0 不许去赌一条刚失败过的路 ──
    const P = { voiceId: 'zh-CN-XiaoxiaoNeural', neuralWired: true, browserUsable: true, now: 1_000_000 }
    assertEq(
      name,
      speechPathPlan({ ...P, priority: 'P1_IMPORTANT', lastOutcome: null, lastAttemptAt: 0 }),
      'neural',
      '本会话没试过时应当走云端 —— 否则用户永远听不到第一句拟人音',
    )
    assertEq(
      name,
      speechPathPlan({ ...P, priority: 'P0_ALARM', lastOutcome: null, lastAttemptAt: 0 }),
      'neural',
      '报警也允许赌第一次（否则云端永远没机会被证明能用）',
    )
    const failed = { lastOutcome: 'fail' as const, lastAttemptAt: 999_000 }
    assertEq(
      name,
      speechPathPlan({ ...P, priority: 'P0_ALARM', ...failed }),
      'local',
      '云端刚失败过时报警必须直接走本机 —— 拿报警的延迟去重试是不能接受的',
    )
    assertEq(name, speechPathPlan({ ...P, priority: 'P1_IMPORTANT', ...failed }), 'local', '非报警在冷却期内同样退回本机')
    const cooled = { lastOutcome: 'fail' as const, lastAttemptAt: 1_000_000 - NEURAL_RETRY_MS }
    assertEq(name, speechPathPlan({ ...P, priority: 'P1_IMPORTANT', ...cooled }), 'neural', '冷却期过后非报警应重试云端')
    assertEq(
      name,
      speechPathPlan({ ...P, priority: 'P0_ALARM', ...cooled }),
      'local',
      '报警的重启条件是"一次成功"，不是时间 —— 冷却期过了也不行',
    )
    assertEq(
      name,
      speechPathPlan({ ...P, priority: 'P0_ALARM', lastOutcome: 'ok', lastAttemptAt: 0 }),
      'neural',
      '一次成功就把云端请回报警这条路',
    )
    assertEq(
      name,
      speechPathPlan({ ...P, voiceId: 'silent', priority: 'P0_ALARM', lastOutcome: null, lastAttemptAt: 0 }),
      'silent',
      '选了静默就不出声，哪怕云端就绪',
    )
    assertEq(
      name,
      speechPathPlan({ ...P, neuralWired: false, browserUsable: false, priority: 'P1_IMPORTANT', lastOutcome: null, lastAttemptAt: 0 }),
      'silent',
      '两条路都没有时只能是静默 —— 不是抛，也不是假装念过了',
    )
    assertEq(
      name,
      speechPathPlan({ ...P, neuralWired: false, priority: 'P1_IMPORTANT', lastOutcome: null, lastAttemptAt: 0 }),
      'local',
      '云端没接上但本机可用 → 走本机',
    )
    // 反向：`neuralAllowed` 与 `speechPathPlan` 不能各判一套
    if (neuralAllowed({ priority: 'P0_ALARM', lastOutcome: 'fail', lastAttemptAt: 1_000_000 - 10 * NEURAL_RETRY_MS, now: 1_000_000 })) {
      fail(name, 'neuralAllowed 认为报警可以重试云端 —— 与路径决策的结论矛盾（判两套必然漂移）')
    }

    // ── ⑥ 口型时间轴：云端音频没有任何边界事件，全靠这条算出来的 ──
    const ticks = neuralWordTicks('今天成交两笔', 3000)
    if (ticks.length === 0) fail(name, '口型时间轴为空 —— 云端音频播放时头像不会动嘴')
    let sum = 0
    for (let i = 0; i < ticks.length; i += 1) {
      sum += ticks[i].chars
      if (i > 0 && ticks[i].atMs < ticks[i - 1].atMs) fail(name, '口型时间轴不是单调的，嘴会倒着动')
      if (ticks[i].atMs >= 3000) fail(name, '口型时间轴越过了音频时长 —— 会出现念完了还在动嘴')
    }
    assertEq(name, sum, 6, '口型覆盖的字数必须等于文本里的非空白字数')
    /**
     * ★ 只断言"字数总和"是**不够的** —— 破坏验证实测：把口型粒度从 2 字改成 3 字，
     *   总和仍然是 6，这条断言照样绿。而"一个 tick 覆盖半句话"意味着嘴只张一次，
     *   正是要避免的那个效果。所以粒度必须单独钉住：
     *   6 个字 → 3 个 tick，每个 2 字。
     */
    assertEq(name, ticks.length, 3, '口型粒度是 2 字一档 —— 改粒度必须同时改这条断言')
    for (let i = 0; i < ticks.length - 1; i += 1) {
      assertEq(name, ticks[i].chars, 2, `第 ${i + 1} 个口型步长必须恰好 2 字`)
    }
    if (ticks[ticks.length - 1].atMs < 1500) {
      fail(name, '口型全挤在音频前半段 —— 后半句嘴不动，看起来像卡住了')
    }
    assertEq(name, neuralWordTicks('', 3000).length, 0)
    assertEq(name, neuralWordTicks('你好', Number.NaN).length, 0, '时长非法时必须返回空时间轴，而不是排出负延迟的定时器')
    // 时长估算由格式声明推出：24kHz / 48kbps / 单声道 = 6000 字节/秒 = 6 字节/毫秒
    assertEq(name, mp3DurationEstimate(48_000), 8000)
    assertEq(name, mp3DurationEstimate(0), 0)
    assertEq(name, mp3DurationEstimate(-5), 0)

    // ── ⑦ 配置收口：缺字段不许把页面崩掉 ──
    const broken = { id: 'x', engine: undefined, matchNames: undefined, tags: undefined } as unknown as VoiceProfileView
    const fixedUp = normalizeProfile(broken)
    assertEq(name, fixedUp.engine, 'local', '缺 engine 时默认成 local —— 不确定时默认值要选后果更轻的那个')
    if (!Array.isArray(fixedUp.matchNames) || !Array.isArray(fixedUp.tags)) {
      fail(name, '收口后数组字段仍不是数组，渲染期会抛 —— 那正是「换音色必崩」的成因')
    }
    const noCatalog = withCatalog({ voiceId: 'a' } as unknown as VoiceConfigView, null)
    if (!Array.isArray(noCatalog.catalog) || noCatalog.catalog.length !== 0) {
      fail(name, '缺 catalog 且没有上一份时必须退空数组，而不是 undefined')
    }
    const kept = withCatalog({ voiceId: 'a' } as unknown as VoiceConfigView, voiceConfig())
    assertEq(name, kept.catalog.length, VOICE_CATALOG.length, '缺 catalog 时应沿用上一份，而不是把列表清空')
    const dirty = withCatalog({ voiceId: 'a', catalog: [{ id: 'z', label: 'z' }] } as unknown as VoiceConfigView, null)
    assertEq(name, dirty.catalog.length, 1)
    if (!Array.isArray(dirty.catalog[0].matchNames)) {
      fail(name, '收口后的 catalog 里仍有非数组 matchNames —— 这是那次整页崩进 ErrorBoundary 的防线')
    }

    // ── ⑧ 分组不漏不重 ──
    const groups = groupByEngine(VOICE_CATALOG.map(normalizeProfile))
    assertEq(name, groups.length, 2)
    assertEq(name, groups[0].engine, 'neural', '分组顺序必须固定：云端在前（它是默认路径）')
    assertEq(name, groups[1].engine, 'local')
    const grouped = groups.reduce((n, g) => n + g.voices.length, 0)
    assertEq(name, grouped, VOICE_CATALOG.length, '分组必须不漏不重 —— 掉一档，用户看到的就是"选不了那个音色"')
    for (const g of groups) {
      if (!g.label || !g.note) fail(name, `分组 ${g.engine} 缺标题或说明，界面会显示空白`)
    }

    pass(
      name,
      `目录 ${VOICE_CATALOG.length} 档（云端 ${voicesByEngine('neural').length} / 本机 ${voicesByEngine('local').length}）· ` +
        `默认 ${DEFAULT_VOICE_ID} 走云端 · engineOf 与目录逐条一致 · 本机音色不计入云端失败 · ` +
        `5 类失败原因各有独立文案且都说明退回本机 · 报警只走"上次成功过"的路 · ` +
        `口型时间轴单调且覆盖全部字数 · 缺字段的配置收口后不抛`,
    )
  }

  archive()
  console.log('')
  console.log('[ARCHIVED] artifacts/voice-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('VOICE SMOKE PASSED')
}

main().catch((e) => {
  fail('main', e instanceof Error ? `${e.message}\n${e.stack?.slice(0, 800)}` : String(e))
})
