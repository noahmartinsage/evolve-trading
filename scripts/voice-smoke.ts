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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetOrch, seedPrice, processOrderIntent, getOrchState } from '../server/core.ts'
import { appendEvent, getEvents, resetLedger } from '../server/ledger.ts'
import { resetSurveillance } from '../server/surveillance.ts'
import { isDangerous, parseHorizonMinutes, parseIntent } from '../server/voice/intents.ts'
// ★ 失败三态的判据与文案都住在这里（模块级唯一一份）—— 测试直接断言那一份，
//   而不是另写一段"长得像"的判断（判据：判据只写一份）。
import { modelFailureKind, modelFailureSpeech } from '../server/voice/model.ts'
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
import { createPending, getPending, beginTurn, commitReply, currentGeneration, sessionStatus, resetSession, interrupt, sessionId } from '../server/voice/session.ts'
// 对话记录（Task #114）：事实源与读取投影。
import {
  setTranscriptRoot,
  transcriptRoot,
  transcriptHealth,
  resetTranscriptHealth,
  readTranscript,
  recordUserTurn,
  recordAssistantTurn,
} from '../server/voice/transcript.ts'
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
// S14：系统实况（三态）与能力注册表（工具层）。
// 注意这里**直接引 awareness/tools** 而不是通过 service —— 测的是它们自己的判据，
// 不是"经由某个上层入口能不能跑通"。
import {
  fleetPnlVerdict,
  fleetStandings,
  labOverview,
  speakFleet,
  speakLab,
  speakSituation,
  standingsSourceOf,
  situation,
} from '../server/voice/awareness.ts'
import { auditToolRegistry, inferLessonCategory, VOICE_TOOLS, type VoiceTool } from '../server/voice/tools.ts'
import { loadLessons } from '../server/evolutionShield.ts'
import { PROMOTION_STAGE_LABEL, PROMOTION_STAGE_RANK } from '../src/engine/promotion.ts'

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
  /**
   * ★★ 第一件事：把对话记录根指到临时目录。
   *
   * 为什么必须放在**最前面**（而不是放到最后一组 T 里）：这个文件后面有
   * S11「端到端 5 轮真实问答」，它真的会调 `handleUtterance`。那时如果
   * 根还是默认的 `process.cwd()`，这 5 轮假对话就直接写进用户的
   * **真实聊天记录**，而且它们和真的对话在界面上长得一模一样。
   *
   * 这不是假想：初版就只在最后一组 T 里隔离，实测在 data/voice 下留下
   * 了 249 行假记录（三个测试进程各 82 行）。T22 是为此加的反回归断言。
   */
  const transcriptTmp = mkdtempSync(join(tmpdir(), 'evolve-transcript-'))
  setTranscriptRoot(transcriptTmp)
  resetTranscriptHealth()

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
      // ── 解释性提问 vs 问行情（配对断言，两条缺一不可）────────────────────
      //
      // ★ 背景：实测「资金费率是怎么影响永续合约价格的？」因为含"价格"二字
      //   被当成查行情，系统回的是「还没收到行情」—— 用户看不出那是"没数据"
      //   还是"它压根没听懂"（第三族失败：没读懂被伪装成读懂了）。
      //   修法是给 query_market 加一条疑问句保护。
      //
      // ★ 但保护本身极易写成"对正确输入报错"：第一版用裸 /(怎么|如何)/ 做判据，
      //   当场把最基础的「行情怎么样」也挡在外面（本烟测的 S1b 抓到的）。
      //   所以这里必须**成对**钉住：解释性的交给模型，直白的仍然是问行情。
      { text: '行情怎么样', intent: 'query_market' },
      { text: '比特币价格是多少', intent: 'query_market' },
      { text: '比特币现价多少', intent: 'query_market' },
      // 这句期望 unknown = 规则层判不出来，会被兜底交给大模型（返回时意图标成 ask_model）
      { text: '资金费率是怎么影响永续合约价格的', intent: 'unknown' },
      { text: '比特币价格为什么跌了', intent: 'unknown' },
    ]
    for (const c of cases) {
      const got = parseIntent(c.text, CTX).intent
      if (got !== c.intent) fail('S1 意图解析', `「${c.text}」期望 ${c.intent}，实际 ${got}`)
    }
    pass(
      'S1 意图解析',
      `${cases.length} 条中文口令逐条命中预期意图（含 3 条该交给模型的解释性提问，以及与它们配对的两条真·问行情）`,
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
    // ── ① 不带保护 ⇒ 桌宠必须**先问人**（用户裁决 2026-09-23 = 保持 fail-closed）──
    //
    // ★ 这一档必须测：闸门在「止盈/止损没有都填」时会短路成 `unverifiable` +
    //   `pipeline 0/9` —— 所以一句「买一百块钱的比特币」若走到确认，
    //   **一定**在闸门那里变成"查不了"。桌宠不允许构造这种注定失败的待确认。
    const protReqBefore = countKind('VOICE_PROTECTION_REQUIRED')
    const submitsBeforeAsk = countKind('ORDER_SUBMIT')
    const noProt = await handleUtterance('买一百块钱的比特币')
    if (noProt.pending) {
      fail('S3 同一道门', '不带保护的单竟然进了待确认 —— 它一定会在闸门那里变成"查不了"')
    }
    if (!noProt.reply.includes('止盈和止损都还没说')) {
      fail('S3 同一道门', `没问保护价，回话是：${noProt.reply}`)
    }
    assertEq('S3 同一道门', countKind('ORDER_SUBMIT'), submitsBeforeAsk, '还没确认就出了一张单')

    // 只给止损也不行（闸门要两个都有），而且必须**说清缺的是哪一个**
    const halfProt = await handleUtterance('买一百块钱的比特币，止损 1%')
    if (halfProt.pending) fail('S3 同一道门', '只给止损也进了待确认 —— 闸门要止盈和止损都有')
    if (!halfProt.reply.includes('还缺止盈')) fail('S3 同一道门', `没说清缺哪一个：${halfProt.reply}`)

    // ★ 留痕：问了两句 ⇒ 账本里必须有两条，否则事后分不清「问了」与「根本没问」（判据 C4）
    assertEq('S3 同一道门', countKind('VOICE_PROTECTION_REQUIRED'), protReqBefore + 2, '问保护价没留下痕迹')

    // ── ② 带保护的两条路必须命中**同一道**下游门 ─────────────────────────
    // 直接路径（相当于界面按钮）
    const directQty = 800 / MARK
    const direct = processOrderIntent({ clientOrderId: 'direct-gate', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: directQty })
    if (direct.ok) fail('S3 同一道门', '直接路径的 800U 单竟然通过了逐笔上限 —— 前提条件不成立')
    const directReason = direct.reason ?? ''

    // 语音路径：说 800 块钱（**带保护**）→ 确认 → 必须得到**同一个** reason
    //   ★ 「带保护」是这次的关键：不带保护会在闸门**输入**那一步就被拦，
    //     于是"两道门是不是同一条"压根没被检验到（判据 B2：断的是"起作用了"还是"出现过"）。
    const ask = await handleUtterance('买八百块钱的比特币 止盈 5% 止损 1%')
    if (!ask.pending) fail('S3 同一道门', `语音下单未进入待确认：${JSON.stringify(ask.reply)}`)
    const conf = await handleUtterance('确认 800')
    if (!conf.executed) fail('S3 同一道门', `确认后没有执行结果：${JSON.stringify(conf.reply)}`)
    if (conf.executed.ok) fail('S3 同一道门', '超限的语音单竟然成交了 —— 语音绕过了风控')
    assertEq('S3 同一道门', conf.executed.reason, directReason, '语音路径与直接路径的拒绝理由必须逐字一致')

    // 反向：额度以内必须真的能成，否则"过门"可能只是因为整条路是死的
    const okAsk = await handleUtterance('买一百块钱的比特币 止盈 5% 止损 1%')
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

  // ══════════════════ S3b 裸单通道：只有显式放弃才走 ══════════════════
  //
  // ★ 这一块守的是**用户裁决（2026-09-23）**的落地：⑦ 裸单通道要开。
  //   它与 S3 是一对：
  //     S3  —— 没提到保护 ⇒ **问人**（不许替用户编一个保护价）；
  //     S3b —— 明确说不要 ⇒ **按裸单下**，且豁免必须真的进到闸门输入里。
  //   两条都要有：只有 S3 时功能是"下不出单"，只有 S3b 时"忘了说"会被当成"不要"。
  {
    const protReqBefore = countKind('VOICE_PROTECTION_REQUIRED')
    const submitsBefore = countKind('ORDER_SUBMIT')

    // ── ① 一句「不带保护」就不该再问一遍（问了 = 让用户重说他刚说过的话）──
    const naked = await handleUtterance('买一百块钱的比特币，不带保护')
    if (!naked.pending) {
      fail('S3b 裸单通道', `明确说了不带保护却没过确认：${JSON.stringify(naked.reply)}`)
    }
    if (!naked.reply.includes('不挂') && !naked.reply.includes('裸单')) {
      fail('S3b 裸单通道', `确认回话没有念回"不挂保护"，用户没法在签字前发现理解错了：${naked.reply}`)
    }
    assertEq(
      'S3b 裸单通道',
      countKind('VOICE_PROTECTION_REQUIRED'),
      protReqBefore,
      '已经明确说了不要保护，却又问了一遍',
    )
    assertEq('S3b 裸单通道', countKind('ORDER_SUBMIT'), submitsBefore, '还没确认就出了一张单')

    // ── ② 确认之后必须真的成交（额度以内），且**豁免真的进了闸门输入** ────
    const conf = await handleUtterance('确认 100')
    if (!conf.executed?.ok) {
      fail('S3b 裸单通道', `额度内的现货裸单应成交，实际：${JSON.stringify(conf.executed)}`)
    }
    // ★★ 这一条是整个 S3b 的核心，也是本仓库付过代价的那条：
    //   「解析对了 / 念回了 / 审计记了」**≠「挂上了」** —— 保护单那次就是
    //   解析、念回、留痕全对，唯独没进 `OrderIntentInput`。
    //   所以这里必须去**闸门自己的留痕**里看那个字段，而不是看语音层的变量。
    const gateEvents = getEvents(0).filter((e) => e.kind === 'ORDER_GATE')
    const nakedGate = gateEvents.filter((e) => e.payload.protectionWaived === true)
    if (nakedGate.length === 0) {
      fail(
        'S3b 裸单通道',
        `闸门留痕里没有一条 protectionWaived=true —— 豁免没有真的进到闸门输入（这正是"保护单"那次的形态）`,
      )
    }
    const last = nakedGate[nakedGate.length - 1].payload
    if (last.verdict !== 'pass') fail('S3b 裸单通道', `裸单的裁决应为 pass，实际 ${String(last.verdict)}`)
    const notChecked = Array.isArray(last.notChecked) ? (last.notChecked as unknown[]) : []
    if (!notChecked.includes('naked.reward_risk')) {
      fail('S3b 裸单通道', `闸门必须如实报出"哪道门没查"，实际 notChecked=${JSON.stringify(notChecked)}`)
    }
    // 与 S3 的配对：豁免只在**显式**那一次出现，另一笔正常单不许被顺带标成裸单
    if (nakedGate.length !== 1) {
      fail('S3b 裸单通道', `只有一笔显式裸单，却留了 ${nakedGate.length} 条豁免痕迹 —— 豁免被别处误触发了`)
    }

    // ── ③ 问过之后再回一句「不要」，也必须是**那一笔单**的豁免 ────────────
    //
    // ★ 没有这一段，"桌宠能不能被回答"就完全没被测：用户面对那句提问时
    //   最自然的回答就是一句「不要」，而它必须被理解成对**上一个问题**的回答，
    //   不是一笔只有两个字的订单。
    const asked = await handleUtterance('买一百块钱的比特币')
    if (asked.pending) fail('S3b 裸单通道', '不带保护的单进了待确认（它一定会在闸门那里变成"查不了"）')
    if (!asked.reply.includes('不带保护')) {
      fail('S3b 裸单通道', `提问里必须给出"不带保护"这条路，否则用户无法把它说出口：${asked.reply}`)
    }
    const answer = await handleUtterance('不要')
    if (!answer.pending) {
      fail('S3b 裸单通道', `回了「不要」之后没进入待确认：${JSON.stringify(answer.reply)}`)
    }
    if (!answer.reply.includes('不挂') && !answer.reply.includes('裸单')) {
      fail('S3b 裸单通道', `回答「不要」之后的确认回话没有念回裸单语义：${answer.reply}`)
    }
    const answered = getEvents(0).filter((e) => e.kind === 'VOICE_PROTECTION_ANSWERED')
    if (answered.length !== 1) {
      fail('S3b 裸单通道', `「回答过一个问题」必须留痕且只有一条，实际 ${answered.length} 条`)
    }
    const conf2 = await handleUtterance('确认 100')
    if (!conf2.executed?.ok) {
      fail('S3b 裸单通道', `回答「不要」之后的裸单应成交，实际：${JSON.stringify(conf2.executed)}`)
    }
    const waivedEvents = getEvents(0).filter((e) => e.kind === 'VOICE_PROTECTION_WAIVED')
    // ★ 到这一步一共下了**两笔**裸单（① 显式一句、③ 回答一句），每笔一条 ⇒ 2 条。
    //   写成"恰好 2"而不是">= 1"：多出来的那条意味着豁免在**别的**单子上也生效了，
    //   而那正是"静默降级成裸单"这件事的形态。
    if (waivedEvents.length !== 2) {
      fail('S3b 裸单通道', `豁免生效必须每笔裸单留一条且一共 2 条，实际 ${waivedEvents.length} 条`)
    }

    // ── ④ 矛盾说法必须**拒**而不是挑一个（挑错的方向是把要保护的单裸下）──
    const contra = await handleUtterance('买一百块钱的比特币，止盈 5% 不要保护')
    if (contra.pending) fail('S3b 裸单通道', '同句既有止盈数字又说不要保护时，不许自己挑一个')
    if (!contra.reply.includes('矛盾') && !JSON.stringify(contra).includes('CONTRADICTS')) {
      fail('S3b 裸单通道', `矛盾输入必须说清是矛盾，实际：${contra.reply}`)
    }

    pass(
      'S3b 裸单通道',
      `显式"不带保护"与回答"不要"两条路都进了待确认并成交；闸门留痕 ${nakedGate.length} 条豁免、` +
        `如实报出未查的 ${notChecked.length} 道门；矛盾说法被拒`,
    )
  }

  // ══════════════════ S4 两段式确认三个方向 ══════════════════
  {
    const submitsBefore = countKind('ORDER_SUBMIT')

    // 4a 只提需求不确认 → 不得下单
    const ask = await handleUtterance('买三百块钱的比特币 止盈 5% 止损 1%')
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
    const small = await handleUtterance('买二十块钱的比特币 止盈 5% 止损 1%')
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
    await handleUtterance('买三十块钱的比特币 止盈 5% 止损 1%')
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

  // ══════════════════ S14 系统实况（三态）与能力注册表 ══════════════════
  //
  // 这一场景来自一次真实的使用反馈：用户问「Agent 舰队里哪个策略盈利最高」，
  // 管家回了一句「这句我没听懂」—— 它对自己所在的系统一无所知。
  //
  // 修好之后真正要防的不是"答不出来"，而是**答出一个看起来很对的数**：
  // 界面上 Agent 舰队那一页的收益数字是演示值（页面自己标着「非真实 PnL」），
  // 一旦被念出来，用户会真的据此决定投钱。
  // 所以这一场景的核心断言是第 ⑦ 条：**缺数据必须被说出来**。
  {
    const name = 'S14 系统实况与工具注册表'

    // ── ① 意图：8 条新口令逐条命中，其中 2 条是"不许被抢走"的反例 ──
    const cases: { text: string; intent: string }[] = [
      { text: '系统现在什么情况', intent: 'ask_system' },
      { text: 'Agent 舰队里哪个策略盈利最高', intent: 'ask_fleet' },
      { text: '进化实验室能干什么', intent: 'ask_lab' },
      { text: '进化一下你自己', intent: 'self_upgrade' },
      { text: '升级一下你自己', intent: 'self_upgrade' },
      { text: '记住：不要在流动性差的时段追加仓位', intent: 'record_lesson' },
      // 反例 1：「研发一个策略去达成目标」是执行诉求，不是"看看流水线"。
      //   它必须落 self_upgrade（真的去跑提案），而不是 ask_fleet（只报现状）——
      //   这是「任务不许被降级成一次查询」，与 S1b 里「任务不许被换成一个报价」同源。
      { text: '帮我研发一个策略去达成目标', intent: 'self_upgrade' },
      // 反例 2：真正的问行情不许被这批新意图吃掉。
      { text: '比特币现在多少钱', intent: 'query_market' },
    ]
    for (const c of cases) {
      const got = parseIntent(c.text, CTX).intent
      if (got !== c.intent) fail(name, `「${c.text}」期望 ${c.intent}，实际 ${got}`)
    }

    // ── ② 三态映射必须**双向**成立 ──
    // 只断言当前环境下的那一个值是不够的：一个恒返回 'unavailable' 的实现
    // 在空流水线的机器上照样全绿。喂两个输入，两个方向都钉住。
    assertEq(name, standingsSourceOf(0), 'unavailable', '空流水线时必须承认"没有数据"，而不是报一个空排行当作答案')
    assertEq(name, standingsSourceOf(3), 'live', '有记录时必须是 live —— 否则"三态"退化成一个常量')

    const f = fleetStandings()
    assertEq(name, f.source, standingsSourceOf(f.total), '返回的 source 必须与记录数一致')
    // 排行口径必须写在数据里。"第一名"是谁取决于口径，口径不写就是靠读者各自理解。
    assertEq(name, f.rankedBy, 'stage_then_fitness', '排行口径必须显式给出 —— 用户问的是"最赚钱"，我们给的是"走得最远"')
    // 每条记录都必须自报"我没有盈亏字段"。`false` 是一个可断言的事实，
    // 比"查不到"更能表达"系统确实不记这个"。
    if (f.rows.some((r) => r.hasPnl !== false)) {
      fail(name, '流水线的记录里出现了盈亏字段 —— 数据模型变了，"没有分策略盈亏"这句话要重新核')
    }

    // ── ③ 排行必须按前进方向排，且 rejected 永远垫底 ──
    for (let i = 1; i < f.rows.length; i += 1) {
      if (f.rows[i - 1].stageRank < f.rows[i].stageRank) {
        fail(name, `排行没按阶段前进方向排：${f.rows[i - 1].id}(${f.rows[i - 1].stage}) 在 ${f.rows[i].id}(${f.rows[i].stage}) 之前`)
      }
    }
    if (PROMOTION_STAGE_RANK.rejected !== 0) fail(name, 'rejected 的排序序号必须恒为 0（它不是一个可比较远近的位置）')

    // ── ④ 阶段中文名必须覆盖**全部**阶段 ──
    // 这条直接对应一个真实缺陷：改造前有两份 STAGE_LABEL，两份都缺
    // testnet_verifying / testnet_verified，配合 `?? stage` 兜底，
    // 走到测试网阶段的策略在界面上显示英文原值，且没有任何东西会报红。
    const STAGES = Object.keys(PROMOTION_STAGE_RANK) as (keyof typeof PROMOTION_STAGE_RANK)[]
    const labelMissing = STAGES.filter((s) => !PROMOTION_STAGE_LABEL[s])
    if (labelMissing.length > 0) fail(name, `阶段缺中文名，界面上会显示英文原值：${labelMissing.join(', ')}`)
    assertEq(
      name,
      Object.keys(PROMOTION_STAGE_LABEL).length,
      STAGES.length,
      '中文名表键数必须等于阶段数 —— 多一个键意味着有个名字对应不到任何状态',
    )

    // ── ⑤ 「盈利最高」的正解就是 unavailable，且理由必须写清缺什么 ──
    const verdict = fleetPnlVerdict()
    if (verdict.available !== false) fail(name, '"哪个策略盈利最高"竟然变成可回答的了 —— 请先拿出真实的分策略盈亏来源')
    // ★ 这一条要**两侧夹逼**，只查一个方向会漏。
    //   第一版只写了 `/没有/.test(reason)`，破坏验证的 M4 当场证明了它抓不住：
    //   那句话里别处本来就有一个"没有"（"测试网统计同样没有金额"），
    //   于是把"系统里没有按策略的盈亏数据"改成"系统里有按策略的盈亏数据"照样全绿。
    //   ⇒ 一侧要求它点到"缺什么"，另一侧要求它**不出现任何"其实有"的说法**。
    if (!/按策略的盈亏/.test(verdict.reason)) {
      fail(name, `拒绝理由没点出缺的是什么（分策略盈亏）：${verdict.reason}`)
    }
    // ★ 极性检查必须带**否定环视**。
    //   第一版写的是 `/有按策略的盈亏|.../`，而它会命中
    //   「系统里没[有按策略的盈亏]数据」—— 于是这条断言对**正确输入**也报错。
    //   一个对正确输入报错的检查比不报错的更费人：它会训练你忽略它的红。
    //   `(?<![没不])` 要求那个"有"不是被否定的。
    if (/(?<![没不])有按策略的盈亏|(?<![不])能按策略排|(?<![不])可以按策略排/.test(verdict.reason)) {
      fail(name, `拒绝理由里出现了"其实能按策略排名"的说法，与 unavailable 自相矛盾：${verdict.reason}`)
    }

    // ── ⑥ 文案卫生：三份回话都要能念 ──
    const speeches: Record<string, string> = { 系统实况: speakSituation(), 舰队: speakFleet(), 实验室: speakLab() }
    for (const label of Object.keys(speeches)) {
      const text = speeches[label]
      if (/\[object Object\]|undefined|NaN|\bnull\b/.test(text)) {
        fail(name, `${label}文案含占位符垃圾，念出来就是事故：${text.slice(0, 120)}`)
      }
      if (/\*\*|^#|\|.*\|/.test(text)) fail(name, `${label}文案含 Markdown 记号，会被念成"星号"：${text.slice(0, 120)}`)
      if (text.length < 20) fail(name, `${label}文案过短（${text.length} 字）—— 像是一条没接上数据的兜底句`)
    }

    // ── ⑦ 核心断言：**缺数据必须被说出来**（逐份文案对它自己欠的披露负责）──
    //
    // 整场测试里最该存在的就是这一条。前面所有断言都只保证"算得对"，
    // 只有它保证"没骗人"：一个把演示数字当真实收益念出来的实现，
    // 前面六条全都能过。
    //
    // ★ 这一条的第一版是错的，且错得看不出来：它只查了「舰队」这一份文案。
    //   于是把 speakSituation 里那句"系统里没有按策略的盈亏数据"整句删掉，
    //   测试照样全绿 —— 第十一轮变异 M7 实测逃逸。
    //   根因是"随便哪一份说了就算说了"（判据 3：负向断言被邻居顶替）。
    //   ⇒ 改成一张**逐份文案的披露欠条**：谁欠哪句，就由谁报红。
    const owed: { label: string; need: RegExp; why: string }[] = [
      { label: '系统实况', need: /没有按策略的盈亏数据/, why: '报了一堆数之后不说这句，用户会以为系统连分策略收益都有' },
      { label: '舰队', need: /没有按策略的盈亏数据/, why: '沉默会被用户读成"系统有这项"' },
      { label: '舰队', need: /非真实|演示/, why: '不说就是默许他把页面上那几个演示数字当成真实收益' },
      { label: '实验室', need: /谱系/, why: '不说就是默许他把页面画的那棵树当成系统里的数据' },
    ]
    for (const { label, need, why } of owed) {
      if (!need.test(speeches[label])) {
        fail(name, `${label}文案欠了一句必须说的话（${need}）—— ${why}：${speeches[label].slice(0, 120)}`)
      }
    }
    // 反向：三份文案**都不许**给出一个"第一名"。
    // 只做正向检查的话，一个"既说了没有数据、又顺手报个第一名"的实现能全绿。
    const canary = '盈利最高的是 AG-ALPHA，收益 +12480 美元。'
    if (!/盈利最高的是/.test(canary)) fail(name, '检查器自身失灵：给定一句假装能排名盈利的话，它竟然没识别出来')
    for (const label of Object.keys(speeches)) {
      if (/盈利最高的是/.test(speeches[label])) {
        fail(name, `${label}文案里出现了"盈利最高的是" —— 系统没有分策略盈亏数据，这句话是编的`)
      }
    }
    // 实验室回话必须说明"谱系树是演示"，否则用户会把页面画的东西当成系统有的。
    if (labOverview().lineage.source !== 'demo') fail(name, `谱系树应当标为 demo，实际 ${labOverview().lineage.source}`)
    // 实验室要真的告诉用户"能怎么用"，否则"知道有实验室"仍然等于没用。
    if (labOverview().capabilities.length < 3) fail(name, '实验室能力清单不足 3 条 —— 用户仍然不知道拿它做什么')

    // ── ⑧ 自我进化：边界必须被说出来 ──
    // "不能自己改代码上线"如果不说，用户会默认它能 —— 那是一个假承诺，
    // 而假承诺的代价是他把一件需要他批的事当成已经自动完成了。
    const intro = await handleUtterance('介绍一下你自己')
    if (!/改代码/.test(intro.reply)) fail(name, '自我介绍没说清"改代码要你批"这条边界')
    if (!/提案/.test(intro.reply)) fail(name, '自我介绍没说清自我进化的落点是提案引擎')

    // ── ⑨ 未确认不得执行（负向）──
    const runsBefore = countKind('VOICE_TOOL_RUN') + countKind('VOICE_TOOL_RUN_STARTED')
    const askUpgrade = await handleUtterance('进化一下你自己')
    assertEq(name, askUpgrade.intent, 'self_upgrade')
    if (!askUpgrade.pending) fail(name, '一个会改变系统将来行为的动作竟然没生成待确认凭据')
    assertEq(name, countKind('VOICE_TOOL_RUN') + countKind('VOICE_TOOL_RUN_STARTED'), runsBefore, '仅提出诉求就执行了工具')
    await handleUtterance('取消')

    // ── ⑩ 确认后执行路径真的被走到，且**绕不过宪法红线**（正向 + 不污染）──
    //
    // 用一条注定被拒的心法来测，一举三得：
    //   ① 证明"确认之后执行路径确实被走到了"（否则第 ⑨ 条会退化成"一个从不执行的实现也能过"）；
    //   ② 证明语音登记心法吃的是**同一道宪法 lint**，语音不是绕过红线的新通道
    //      （与 S3「语音下单必须过同一道风控门」同源）；
    //   ③ 不污染心法库 —— 这条测试跑一百次，心法库还是那么多条。
    //
    // 选「突破之后一定涨不要犹豫」的理由：它命中「确定性幻觉」红线，
    // 于是**与账本里有几笔成交无关**，结果恒为拒绝。改用"样本量不足"来构造拒绝
    // 是不行的 —— 那取决于前面几个场景成交了几笔，会随测试顺序漂移。
    const lessonsBefore = loadLessons().length
    const askLesson = await handleUtterance('记住：突破之后一定涨不要犹豫')
    assertEq(name, askLesson.intent, 'record_lesson')
    if (!askLesson.pending) fail(name, '登记心法未生成待确认凭据')
    const conf = await handleUtterance('确认')
    if (conf.executed?.ok !== false) fail(name, `命中宪法红线的心法竟然入册了：${JSON.stringify(conf.executed)}`)
    if (!/红线|样本|拒|不能/.test(conf.reply)) fail(name, `拒绝理由不是人话或没说出原因：${conf.reply}`)
    assertEq(name, countKind('VOICE_TOOL_RUN'), 1, '确认之后没有留下 VOICE_TOOL_RUN —— 执行路径没被走到（第 ⑨ 条因此是假绿）')
    assertEq(name, loadLessons().length, lessonsBefore, '被拒的心法污染了心法库')

    // ── ⑪ 类别判不出来时必须拒绝并列出合法值，不许猜 ──
    // 猜错类别的代价不是"这条心法没用"，而是它会以错误的类别被回灌进
    // 每一次提案的上下文 —— 那是长期污染面。
    if (inferLessonCategory('今天天气不错').category !== null) fail(name, '判不出类别竟然给了答案')
    const noCat = await handleUtterance('记住：今天天气不错适合散步')
    if (noCat.pending) fail(name, '类别判不出来却还是让用户去确认 —— 让用户确认一件注定失败的事')
    if (!/类别/.test(noCat.reply)) fail(name, `拒绝时没告诉用户合法类别：${noCat.reply}`)

    // ── ⑫ 工具注册表自检：0 问题，**且证明它会报红** ──
    const problems = auditToolRegistry()
    if (problems.length > 0) {
      fail(name, `注册表有 ${problems.length} 个问题：${problems.map((p) => `${p.toolId}:${p.problem}`).join(' | ')}`)
    }
    if (VOICE_TOOLS.length < 7) fail(name, `工具数只有 ${VOICE_TOOLS.length} 个，能力面被裁了`)

    // 注入式负向测试：喂六个坏工具，**每类检查各有一个"只有它会命中"的输入**。
    // 没有这一段，将来有人把 reuses 检查删掉，门禁照样全绿 ——
    // 而那正是"语音专用实现"重新长出来的那一天。
    //
    // ★ 这一段第一版只有四个坏工具，于是第五类检查（act 的意图必须在 DANGEROUS 里）
    //   **从来没有被单独喂过**：`act-no-intent` 同时缺 intent，命中的是它的**前一个分支**，
    //   所以把 DANGEROUS 那整块 if 删掉，测试照样全绿 —— 第十一轮变异 M5 实测逃逸。
    //   ⇒ 修法是两件事一起做：
    //     ① 每个坏工具只犯**一个**错（`act-no-intent` 补上 label，另开一个 `no-label`）；
    //     ② 断言把问题**归属到具体工具**（`p.toolId === only`），
    //        而不是"某条问题里出现了某个词" —— 后者正是被邻居顶替的入口。
    const bad: VoiceTool[] = [
      { id: 'dup', label: 'a', kind: 'read', cost: 'instant', reuses: 'x', run: () => ({ ok: true, speech: 'a', steps: [] }) },
      { id: 'dup', label: 'b', kind: 'read', cost: 'instant', reuses: 'x', run: () => ({ ok: true, speech: 'b', steps: [] }) },
      { id: 'no-reuses', label: 'c', kind: 'read', cost: 'instant', reuses: '', run: () => ({ ok: true, speech: 'c', steps: [] }) },
      { id: 'no-label', label: '', kind: 'read', cost: 'instant', reuses: 'x', run: () => ({ ok: true, speech: 'd', steps: [] }) },
      { id: 'act-no-intent', label: 'e', kind: 'act', cost: 'slow', reuses: 'x', run: () => ({ ok: true, speech: 'f', steps: [] }) },
      { id: 'act-nondanger', label: 'g', kind: 'act', cost: 'slow', reuses: 'x', intent: 'query_market', run: () => ({ ok: true, speech: 'h', steps: [] }) },
    ]
    // 这一句保护上面的注入用例本身：若哪天 `query_market` 被移进 DANGEROUS，
    // `act-nondanger` 就不再是"坏工具"，第五类检查又会变成**不可能失败**的检查。
    if (isDangerous('query_market')) fail(name, '注入用例自身失效：query_market 现在是危险意图，act-nondanger 不再是坏工具')
    const injected = auditToolRegistry(bad)
    const needList: { only: string; need: string }[] = [
      { only: 'dup', need: 'id 重复' },
      { only: 'no-reuses', need: 'reuses' },
      { only: 'no-label', need: '缺 label' },
      { only: 'act-no-intent', need: '未声明 intent' },
      { only: 'act-nondanger', need: 'DANGEROUS' },
    ]
    for (const { only, need } of needList) {
      if (!injected.some((p) => p.toolId === only && p.problem.includes(need))) {
        fail(name, `注入坏工具 "${only}" 后，它该命中的 "${need}" 没被报出来 —— 这条检查形同不存在`)
      }
    }
    // 反向：坏工具喂进去必须只报问题、不能报出"没问题"；同时合法注册表不许被误报。
    if (injected.length < needList.length) {
      fail(name, `六个坏工具只报出 ${injected.length} 个问题 —— 有检查在漏`)
    }

    // ── ⑬ act 工具必须落在 DANGEROUS 名单里 ──
    // 这里查的是**真实注册表**，与 ⑫ 的注入用例互为对照：
    // 只有注入用例会红 ⇒ 真实注册表可能早就坏了；只有真实注册表会红 ⇒ 注入用例没覆盖到。
    const actMissing = VOICE_TOOLS.filter((t) => t.kind === 'act' && !t.intent)
    if (actMissing.length > 0) fail(name, `有 act 工具没声明 intent：${actMissing.map((t) => t.id).join(', ')}`)
    const actNotDangerous = VOICE_TOOLS.filter((t) => t.kind === 'act' && t.intent && !isDangerous(t.intent))
    if (actNotDangerous.length > 0) {
      fail(name, `真实注册表里有 act 工具的意图不在 DANGEROUS 名单：${actNotDangerous.map((t) => `${t.id}:${t.intent}`).join(', ')}`)
    }

    // ── ⑭ 系统实况必须真的读到东西（不是一份全 null 的骨架）──
    const sit = situation()
    const liveCount = Object.values(sit).filter((x) => (x as { source: string }).source === 'live').length
    if (liveCount < 8) fail(name, `系统实况只有 ${liveCount} 项是 live —— 管家会以为自己对系统一无所知`)

    pass(
      name,
      `${cases.length} 条新口令逐条命中（含 2 条反例）· 三态双向可证 · 排行口径显式且 rejected 垫底 · ` +
        `${STAGES.length} 个阶段中文名零缺口 · 「盈利最高」正解为 unavailable 且理由写清 · ` +
        `三份文案各自欠的披露逐份对账（"没有分策略盈亏" / "演示值" / "谱系"），且都不许报出第一名 · 自我介绍交代改代码边界 · ` +
        `自我进化未确认不执行、确认后过宪法红线且不污染心法库 · ` +
        `注册表 ${VOICE_TOOLS.length} 个工具 0 问题且注入 ${needList.length} 个坏工具逐条归属报红 · 系统实况 ${liveCount} 项真实来源`,
    )
  }

  // ══════════════ S16 模型失败的三种性质必须被分开 ══════════════
  //
  // ★ 实测（2026-09-19）：三个免费视觉候选全败，回话把用户引向"模型名字烂掉了"，
  //   而探针原文是 `HTTP 429 free-models-per-day`（额度打满）。
  //   两种事因长得一样，下一步却相反：一个去换名单，一个去等额度。
  //   所以三种性质各喂**一个只有它会命中的输入**（判据 3），
  //   并各自配一句"别的分支的话不许出现在这里"（判据 4）。
  {
    const name = 'S16 模型失败三态'
    const quota = [{ model: 'a:free', reason: 'EMPTY_RESPONSE: HTTP 429 Rate limit exceeded: free-models-per-day' }]
    const paid = [
      { model: 'p-a', reason: 'PAID_NOT_ALLOWED：未开启 EV_LLM_ALLOW_PAID' },
      { model: 'p-b', reason: 'PROBE_NEVER_PAID：探测层不占用付费额度' },
    ]
    const rotted = [{ model: 'a:free', reason: 'EMPTY_RESPONSE: HTTP 404 model not found' }]

    assertEq('S16 ① 429 判成额度', modelFailureKind(quota), 'quota')
    assertEq('S16 ② 付费候选全被跳过判成付费受阻', modelFailureKind(paid), 'paid-blocked')
    assertEq('S16 ③ 404 判成名字烂了', modelFailureKind(rotted), 'no-candidate-worked')

    const qs = modelFailureSpeech('quota', quota)
    // ★ 负向断言选的是**各自的"下一步"动作词**，不是随便一个语义词。
    //   第一版写的是 `!/名字烂了/`，而额度那份文案里有一句
    //   "这不是模型名字烂了" —— **它以否定形式包含了那个词**，
    //   于是断言对正确输出报错。选词必须选"别的分支才会出现的动作词"：
    //   额度 ⇒ 免费额度 / 付费 ⇒ 开关名 / 名字烂了 ⇒ 探针命令。
    if (!/免费额度/.test(qs) || /llm:probe/.test(qs)) {
      fail(name, `额度用完的说明必须指向额度、且不许给出探针那一步（用户会去换名单）：${qs.slice(0, 80)}`)
    }
    const ps = modelFailureSpeech('paid-blocked', paid)
    if (!/EV_LLM_ALLOW_PAID/.test(ps) || /llm:probe/.test(ps) || /免费额度/.test(ps)) {
      fail(name, `付费受阻的说明必须指向付费开关，且不许说成"额度用完"或"名字烂了"：${ps.slice(0, 80)}`)
    }
    const rs = modelFailureSpeech('no-candidate-worked', rotted)
    if (!/llm:probe/.test(rs) || /免费额度/.test(rs)) {
      fail(name, `名字烂了的说明必须指向探针，且不许说成"额度用完"：${rs.slice(0, 80)}`)
    }

    pass(name, '三态各喂一个专属输入 · 三份说明各含专属下一步且互不顶替（免费额度 / 付费开关 / 探针）')
  }

  // ── S15：界面按钮通道的**两档顺序**与"唯一一份实现" ──────────────────────
  //
  // ★ 为什么这一条必须是**源码级**而不是行为级：
  //   `resolveExplicitPress` 单独测得出"它认识哪一句"（见 ui-actions-smoke 的 U24 组），
  //   但**"它排在只读问答之前"这件事只有在源码顺序里**。
  //   行为上无法证伪：不管顺序如何，`ask_agents` 都会答得上话 ——
  //   而用户要的是按按钮。所以这里读源码、比下标。
  //
  // ★ 它在什么条件下会变红：
  //   ① `resolveExplicitPress` 那一行被删掉或移到只读问答之后；
  //   ② 有人给"按一颗按钮"再写一份实现（第二个 `prepareUiClick(` 调用点）；
  //   ③ 有人把"主人是舰队计划"那段回话再抄一份。
  {
    const name = 'S15 界面按钮通道'
    const svc = readFileSync(join(process.cwd(), 'server', 'voice', 'service.ts'), 'utf8')

    const at = (needle: string): number => svc.indexOf(needle)
    const iStrict = at('resolveExplicitPress(text)')
    if (iStrict < 0) {
      fail(name, 'service.ts 里没有调用 resolveExplicitPress —— 严格档没接线，"明说按/点"会被只读问答抢走')
    }
    // 只读问答的第一条（ask_system）就是"抢单区"的起点。
    const iReadOnly = at("parsed.intent === 'ask_system'")
    if (iReadOnly < 0) {
      fail(name, "找不到只读问答起点（parsed.intent === 'ask_system'）—— 锚点失效，这条断言已经失去意义")
    }
    if (iStrict > iReadOnly) {
      fail(
        name,
        `严格档排在只读问答之后（${iStrict} > ${iReadOnly}）—— 「风控中心页跑一次沙盒演练」会再次收到状态汇报而不是被按下`,
      )
    }
    // ③ 危险意图（下单/平仓/急停）不许被按钮通道顶掉。
    //
    // ★ 这条**不能靠顺序**保：只读问答本身就排在订单处理之前，
    //   所以"既在只读前又在订单后"在结构上不可能成立（第一版断言就是这么错的）。
    //   保它的是一个**紧邻的否定护栏**：`!isDangerous(parsed.intent)`。
    //   一句「按一下买入」的解析结果就是危险意图，它必须走下单那条路（含风控与确认），
    //   而不是去按界面上的「买入」（那颗只切方向）。
    const iGuard = svc.lastIndexOf('!isDangerous(parsed.intent)', iStrict)
    if (iGuard < 0 || iStrict - iGuard > 800) {
      fail(
        name,
        `严格档前面没有紧邻的 isDangerous 否定护栏（护栏下标 ${iGuard}，严格档下标 ${iStrict}）—— 危险意图会被按钮通道顶掉`,
      )
    }

    // ④ 唯一一份实现：`prepareUiClick` 只有"定义 + 一处调用"。
    const prepCalls = svc.split('prepareUiClick(').length - 1
    if (prepCalls !== 2) {
      fail(name, `prepareUiClick 出现 ${prepCalls} 次（应为 2：定义 1 + 调用 1）—— "按一颗按钮"又多了一条实现路径`)
    }
    // ⑤ "主人是舰队计划"那段回话也只许有一份。
    const ownedSpeech = svc.split('这件事的主人是舰队计划').length - 1
    if (ownedSpeech !== 1) {
      fail(name, `"主人是舰队计划"那段回话出现 ${ownedSpeech} 次（应为 1）—— 两份文案迟早给出不同的下一步动作`)
    }

    pass(name, '严格档排在只读问答之前 · 危险意图有否定护栏 · prepareUiClick 唯一调用点 · 归属回话唯一一份')
  }

  // ══════════════════ S17 走势预测：诉求不许被换成报价 ══════════════════
  //
  // ★ 这一组治的是用户实测报上来的原话：「帮我预测比特币未来1小时的走势图」。
  //   加这条分支之前它的解析结果是 `query_market`（置信度 0.6）—— 被最后那条
  //   **裸标的兜底**接走，回一句 BTC 现价。用户问的是"未来会到哪、为什么"，
  //   收到一个当前价格。它报的数字是对的，只是不是他问的那件事 ——
  //   本仓库记过多次的第三族失败：**答非所问，却听起来像在回答**。
  //
  // ★ 断言必须**成对**（正例 + 反例），缺一不可：只钉正例的话，把
  //   `FORECAST_WORDS` 放宽到含"行情"两个字也能全绿 —— 而那会让每一句
  //   「比特币多少钱」都变成一次 6 秒的预测（判据 2：对正确的输入报错）。
  {
    const name = 'S17 走势预测'

    // ① 用户原话（逐字，不许改）。
    const user = parseIntent('帮我预测比特币未来1小时的走势图', CTX)
    assertEq(`${name} 用户原话`, user.intent, 'query_forecast')
    assertEq(`${name} 听出了标的`, user.forecastSymbol, 'BTCUSDT')
    assertEq(`${name} 听出了跨度`, user.horizonMinutes, 60)

    // ② 其它说法也要接住。含一条**原来被 `query_status` 抢走**的
    //    （"接下来"在它的词表里，实测这句拿到的是"我在忙什么"）。
    for (const t of [
      '预测一下 BTC 未来一小时走势',
      '比特币接下来一小时会涨还是会跌',
      '比特币能涨到多少',
      '未来4小时 BTC 会怎么走',
      '帮我预判一下以太坊后市',
    ]) {
      const got = parseIntent(t, CTX).intent
      if (got !== 'query_forecast') fail(name, `「${t}」期望 query_forecast，实际 ${got}`)
    }

    // ③ ★ 反例一：真问价必须仍然是问价。
    //   ★ 四条里必须有「现价」这一条：变异验证抓到过 —— 把 `现价` 加进
    //     `FORECAST_WORDS` 时，原来的四条**一条都没红**（它们分别含
    //     "现在多少钱 / 报价 / 行情 / 价格"，恰好都不含"现价"）。
    //     那就是一条没有牙的反例清单：它看着覆盖了四类说法，
    //     实际上漏掉了最口语的那一类（判据 3：有没有一个输入是"只有它"会命中的）。
    for (const t of ['比特币现在多少钱', 'BTC 的报价', '行情怎么样', '比特币价格是多少', '比特币现价多少']) {
      const got = parseIntent(t, CTX).intent
      if (got !== 'query_market') {
        fail(name, `「${t}」被预测分支抢走了（实际 ${got}）—— 查行情不该被升级成一次 6 秒的预测`)
      }
    }
    // ④ ★ 反例二：解释性提问交给模型（与 query_market 共用同一份 `looksExplanatory`）。
    for (const t of ['预测模型的原理是什么', '为什么预测比特币会涨']) {
      const got = parseIntent(t, CTX).intent
      if (got === 'query_forecast') fail(name, `「${t}」问的是机制，不该走预测 —— 用户会收到一段行情数字`)
    }
    // ⑤ ★ 反例三：没指名标的时**不许**替用户挑一个顶上。
    //   （默认 BTCUSDT 的后果是把"以太坊的预测"当"比特币的预测"讲出来，
    //    而那句话在字面上完全说得通。）
    const noSym = parseIntent('预测一下未来一小时的走势', CTX)
    assertEq(`${name} 没指名标的`, noSym.intent, 'query_forecast')
    assertEq(`${name} 且不带标的（交给服务层问一句）`, noSym.forecastSymbol ?? null, null)

    // ⑥ 跨度解析：**只认带单位的数**，裸数字不认。
    //   猜一个等于替用户填槽位，而槽位猜错的下场是给他一个别的时间跨度的结论。
    const horizons: [string, number | null][] = [
      ['未来1小时', 60],
      ['未来一小时', 60],
      ['未来两小时', 120],
      ['未来30分钟', 30],
      ['未来半小时', 30],
      ['未来4小时', 240],
      ['看未来10分钟', 10],
      ['预测一下 BTC', null],
      ['预测 4', null],
    ]
    for (const [t, want] of horizons) {
      const got = parseHorizonMinutes(t)
      if (got !== want) fail(name, `「${t}」期望跨度 ${want}，实际 ${got}`)
    }
    // ⑦ 没提时间时，意图层必须回落到预测层的默认档（15m × 4 根 = 1 小时）。
    assertEq(`${name} 没提时间用默认档`, parseIntent('预测一下比特币', CTX).horizonMinutes, 60)

    // ⑧ 工具层：预测必须是**只读**工具，且 `reuses` 指向预测层。
    //   ★ 它若是 act，就会走两段式确认 —— 用户问一句"会跌吗"要复述金额，
    //     那会训练他闭眼确认（本仓库最怕的一种训练）。
    const tool = VOICE_TOOLS.find((t) => t.id === 'forecast')
    if (!tool) fail(name, '能力注册表里没有 forecast —— 桌宠这句话会掉进大模型兜底')
    assertEq(`${name} 预测必须是只读工具`, tool!.kind, 'read')
    if (!tool!.reuses.includes('forecastService')) {
      fail(name, `reuses 没指向预测层：「${tool!.reuses}」`)
    }
    if (isDangerous('query_forecast')) {
      fail(name, '预测被判成危险意图 —— 它不下单、不改状态，不该要用户复述金额')
    }

    // ⑨ 真的跑一次出口，只钉"它有没有把不可信说出来"。
    //   ★ 刻意**不断言方向/价位**：那是数据相关的，写进 CI 会变成随机地雷
    //     （本仓库栽过：断言写死"通过 == 20"，注册表长到 21 就变红）。
    //     语义不变量由 `test:forecast` 的 27 条负责，这里只验**语音层拿到的文案**。
    const out = (await tool!.run(JSON.stringify({ symbol: 'BTCUSDT', horizonMinutes: 60 }))) as {
      ok: boolean
      reason?: string
      speech: string
      steps: string[]
      detail?: { outcome?: string; gate?: string; horizonMinutes?: number; path?: unknown[] }
    }
    if (!out.ok) fail(name, `预测出口跑失败：${out.reason ?? '未知'}`)
    if (/\*\*|⚠️|`/.test(out.speech)) {
      fail(name, `口播文案里出现了 Markdown/emoji 记号（TTS 会念成"星号星号"）：「${out.speech.slice(0, 90)}」`)
    }
    if (!/没有统计优势|无法给出可靠预测/.test(out.speech)) {
      fail(name, `口播没有把"这个结论能不能信"说出来 —— 用户会把噪声当信号：「${out.speech.slice(0, 140)}」`)
    }
    if (out.steps.length === 0) fail(name, '只读工具必须报出过程（用户要知道我查了哪几处）')
    assertEq(`${name} 跨度写回实际值`, out.detail?.horizonMinutes, 60)
    if (!['actionable', 'no-edge', 'unverifiable'].includes(out.detail?.outcome ?? '')) {
      fail(name, `出口的 outcome 不在三态里：${out.detail?.outcome}`)
    }

    // ⑩ 端到端：走真实入口一次，账本里必须留下两笔（开始算 / 算完）。
    //   ★ 只留"算完"那一笔的后果：用户投诉"它说在算，然后没下文了"时，
    //     账本上分不出是没算完还是没播出来。
    resetVoice()
    resetOrch(100_000)
    seedPrice('BTCUSDT', MARK)
    const beforeStarted = countKind('VOICE_FORECAST_STARTED')
    const beforeDone = countKind('VOICE_FORECAST')
    const q = await handleUtterance('帮我预测比特币未来1小时的走势图')
    assertEq(`${name} 端到端意图`, q.intent, 'query_forecast')
    assertEq(`${name} 账本记下"开始算"`, countKind('VOICE_FORECAST_STARTED'), beforeStarted + 1)
    assertEq(`${name} 账本记下"算完了"`, countKind('VOICE_FORECAST'), beforeDone + 1)
    if (!/没有统计优势|无法给出可靠预测/.test(q.reply)) {
      fail(name, `端到端回话没有交代可信度：「${q.reply.slice(0, 140)}」`)
    }
    // ⑪ 没指名标的时，服务层必须**问一句**，而不是默认一个标的算出来。
    const ask = await handleUtterance('预测一下未来一小时的走势')
    assertEq(`${name} 没指名标的不许算`, ask.intent, 'query_forecast')
    if (!/哪个标的/.test(ask.reply)) {
      fail(name, `没指名标的时没有反问，而是直接答了：「${ask.reply.slice(0, 120)}」`)
    }
    assertEq(
      `${name} 反问时不许留"开始算"的痕迹`,
      countKind('VOICE_FORECAST_STARTED'),
      beforeStarted + 1,
      '还没定标的就播报"开始算"，用户会以为它知道要算哪个',
    )

    pass(
      name,
      `用户原话逐字命中（BTCUSDT · 60 分钟）· 5 种说法接住 · 4 条真问价 + 2 条解释性提问不被抢 · ` +
        `9 组跨度解析 · 只读工具且非危险意图 · 出口文案无 Markdown 且交代可信度 · ` +
        `端到端留痕两笔（开始算 / 算完）· 未指名标的时反问而不臆断`,
    )
  }

  // ── T：桌宠对话记录（Task #114）──────────────────────────────────────
  //
  // 这一组守的是「聊过的话必须能被找回」。
  // 它比别的组多一个**前置动作**：把记录根指到临时目录 —— 否则跑一次烟测
  // 就往用户的真实聊天记录里灌一堆假对话，而那些假对话在界面上和真的
  // 长得一模一样。
  {
    // ★ 用一个**全新的、还不存在的**目录：
    //   ① 隔离必须早于这一组（理由见 main 开头），所以挂在 main 的临时根下面；
    //   ② 这一组开头的断言要"从零开始"，而 main 那个根已经被 S 组写过了
    //      （S11 端到端就有 5 轮真实问答）—— 直接复用的话 T01/T02 都会红，
    //      而红的原因是"测试自己前一步写了东西"，不是被测代码有问题。
    const tmp = join(transcriptTmp, 'case-fresh')
    setTranscriptRoot(tmp)
    resetTranscriptHealth()

    // ① 目录不存在时，这是「真的没聊过」，不是「读不到」。
    //    两者在界面上长得一样，却指向相反的动作：去聊一句 vs 去修路径。
    const empty = readTranscript()
    assertEq(
      'T01 没聊过 ≠ 读不到',
      `${empty.unreadable}|${empty.turns.length}|${empty.badLines}`,
      'null|0|0',
      '目录不存在时 unreadable 必须是 null（真的没聊过），而不是一句错误文案',
    )

    // ② 走**生产入口**说一句。
    //    ★ 刻意不直接调 recordUserTurn —— 那只能证明"函数存在"，证明不了
    //      它被接线（判据 10：有函数 ≠ 有人调它）。
    const r = await handleUtterance('帮助')
    const page = readTranscript()
    assertEq('T02 生产入口说一句就落盘', page.turns.length, 1, '走 handleUtterance，不是直接调 record*')
    assertEq('T03 这一轮是 answered', String(page.turns[0]?.state), 'answered', '')
    assertEq('T04 用户原话逐字落盘', String(page.turns[0]?.user?.text), '帮助', '')
    assertEq('T05 桌宠回话逐字落盘', String(page.turns[0]?.assistant?.text), r.reply, '')
    assertEq(
      'T06 意图被补记到用户行上',
      String(page.turns[0]?.user?.intent),
      'help',
      'VoiceTurn.intent 在此之前从来没有被赋值过 —— 一个永远 undefined 的字段，配上"面板要显示意图"的期望就是哑失败',
    )

    // ③ 被打断而作废的答复**也要落盘**，且要带原因。
    //    ★ 这条守的是一个很自然的"优化"：既然作废了，还记它干嘛？
    //      去掉之后，用户回看只会看到自己问了一句、下面空着 ——
    //      于是"它没答"与"它答了但被打断"再也分不开（判据 25）。
    const t2 = beginTurn('测试打断')
    const genBefore = currentGeneration()
    interrupt('SMOKE_T')
    assertEq('T07 被打断的答复提交失败', commitReply(t2.turnId, '这条不该被念出来', genBefore), false, '')
    const droppedTurn = readTranscript().turns.find((t) => t.user?.text === '测试打断')
    assertEq('T08 作废的答复也在记录里', String(droppedTurn?.assistant?.text), '这条不该被念出来', '')
    assertEq(
      'T09 且标明是打断作废',
      String(droppedTurn?.assistant?.dropReason),
      'generation',
      '打断与"轮次翻篇"指向相反的下一步动作，合成一个 dropped 就再也分不出来',
    )

    // ④ 配对键是 sid+turnId，不是 turnId。
    //    ★ 单按 turnId 配对，会把「上次开机第 1 轮」与「这次开机第 1 轮」
    //      拼成同一轮 —— 而拼出来的那轮**看着完全正常**：两边的话都像人说的。
    recordUserTurn({ sid: 'sessA', turnId: 1, text: 'A 说的', at: Date.now() })
    recordAssistantTurn({ sid: 'sessB', turnId: 1, text: 'B 答的', at: Date.now(), gen: 0, dropped: false })
    const p2 = readTranscript()
    const sessA = p2.turns.find((t) => t.sid === 'sessA')
    const sessB = p2.turns.find((t) => t.sid === 'sessB')
    assertEq(
      'T10 跨会话同号不串轮',
      `${sessA ? 'A' : '-'}${sessB ? 'B' : '-'}`,
      'AB',
      '只按 turnId 配对会让两轮不同会话的话拼成一轮（判据 29：一句话只能有一个主人）',
    )
    assertEq('T11 只有提问 = unanswered', String(sessA?.state), 'unanswered', '')
    assertEq('T12 只有答复 = orphan', String(sessB?.state), 'orphan', '')

    // ⑤ 坏行必须被数出来。
    //    静默跳过会让"记录少了几轮"永远不被发现 —— 而少的那几轮，
    //    恰好可能是出事的那几轮。
    const dayFiles = readdirSync(join(tmp, 'data', 'voice')).filter((f) => f.endsWith('.jsonl'))
    assertEq('T13 落盘文件按天命名', dayFiles.length > 0, true, '')
    writeFileSync(join(tmp, 'data', 'voice', dayFiles[0]), '{ 这不是 JSON\n', { flag: 'a' })
    const p3 = readTranscript()
    assertEq('T14 坏行被数出来', p3.badLines, 1, '静默跳过坏行 = 让"记录缺了几轮"永远不被发现')
    assertEq('T15 坏行不拖垮好行', p3.turns.length > 1, true, '')

    // ⑥「目录读不了」必须与「没聊过」分开。
    const root2 = join(tmp, 'broken')
    mkdirSync(join(root2, 'data'), { recursive: true })
    writeFileSync(join(root2, 'data', 'voice'), 'not a directory')
    setTranscriptRoot(root2)
    assertEq(
      'T16 目录读不了要说出来',
      typeof readTranscript().unreadable,
      'string',
      '"读不到"与"没聊过"的下一步动作相反：修路径 vs 去聊一句',
    )

    // ⑦ 写不进去不能沉默，也不能把语音拖垮。
    resetTranscriptHealth()
    assertEq('T17 写失败不抛异常', recordUserTurn({ sid: 'x', turnId: 1, text: 'hi', at: Date.now() }), false, '')
    assertEq(
      'T18 但写失败要留痕',
      transcriptHealth().writeFailure !== null,
      true,
      '沉默的写失败会让"没有新记录"看起来像"没聊过"',
    )

    // ⑧ append-only 与「落盘点唯一」—— 这两条只能靠读源码断言。
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const txSrc = strip(readFileSync(join(process.cwd(), 'server/voice/transcript.ts'), 'utf8'))
    for (const forbidden of ['writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'truncateSync']) {
      if (txSrc.includes(forbidden)) {
        fail('T19 记录只许追加', `transcript.ts 里出现了 ${forbidden} —— append-only 被破坏，历史记录可以被改写`)
      }
    }
    assertEq(
      'T19 只允许 appendFileSync',
      txSrc.split('appendFileSync(').length - 1,
      1,
      '没有任何 writeFileSync / rename / unlink：已提交的行永不重命名、永不替换、永不删除',
    )
    // 落盘只许发生在会话状态机（唯一必经点）。service 层有 **4 个** commitReply
    // 调用点，在那一层落盘就是"同一业务动作四条实现路径"（判据 8）。
    const svcSrc = strip(readFileSync(join(process.cwd(), 'server/voice/service.ts'), 'utf8'))
    const svcWrites = (svcSrc.match(/record(User|Assistant)Turn\(/g) ?? []).length
    assertEq('T20 service 层不落盘', svcWrites, 0, 'commitReply 有 4 个调用点 —— 在那一层落盘必然漏掉将来新增的出口')

    // ⑨ 收尾：恢复默认根，并确认默认就是工作目录 ——
    //    如果有人把默认改成"不记"，生产会静默失去记录能力，而测试全绿。
    setTranscriptRoot(null)
    resetTranscriptHealth()
    assertEq(
      'T21 生产默认落盘根是工作目录',
      transcriptRoot(),
      process.cwd(),
      '默认"不记"= 生产静默失去记录能力，而所有测试仍然是绿的',
    )

    // ⑩ 反回归：整个烟测跑下来，**真实记录目录里不许出现本进程的 sid**。
    //    ★ 这条比"我在这一组里隔离了"强得多：它检查的是**结果**，不是意图 ——
    //      将来有人在 T 组之前插一组会落盘的用例，或者把 main 开头的隔离删掉，
    //      这条会立刻红。混进去的假对话在界面上和真的一模一样，
    //      用户会以为是自己聊的（判据 29：一句话只能有一个主人）。
    let polluted = 0
    const realDir = join(process.cwd(), 'data', 'voice')
    if (existsSync(realDir)) {
      for (const f of readdirSync(realDir).filter((n) => n.startsWith('turns-'))) {
        for (const line of readFileSync(join(realDir, f), 'utf8').split('\n')) {
          if (line.includes(`"${sessionId()}"`)) polluted += 1
        }
      }
    }
    assertEq(
      'T22 烟测没有污染真实聊天记录',
      polluted,
      0,
      '假对话写进真实记录后，用户在界面上分不出哪些是自己说的 —— 初版实测漏了 249 行',
    )

    // 设回临时目录：万一将来在这一组之后还有用例，也不许落到真实目录
    setTranscriptRoot(tmp)

    pass(
      'T 对话记录',
      '生产入口落盘 · 作废答复带原因 · 跨会话不串轮 · 三态互不顶替 · 坏行/读不到/写失败各说各的 · 只追加',
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
