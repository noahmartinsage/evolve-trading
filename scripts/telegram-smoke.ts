/**
 * 手机端远程指挥通道（Telegram）的门禁（第四十七轮）
 *
 * ══ 这道门为什么必须存在 ═══════════════════════════════════════════════
 * 用户原话：「桌宠系统我是要适配到手机端远程使用的，确保使用第三方软件能
 * 正常的调用，例如用 telegram 连接登入桌宠系统，作为 bot 来操控 evolve 系统」。
 *
 * 于是本模块是全仓**唯一一个把外部输入带进交易系统**的出网面。它的失效方式
 * 全都**不报错**，而且每一种都很贵：
 *
 *   · 白名单默认为空 ⇒ 用户"手机发了没反应"，而他不知道该填哪个 chat id
 *   · 白名单退化成满 ⇒ **任何找到这个 bot 的人都能下单**（最贵的一种）
 *   · 自己另开一条路 ⇒ 绕开两段式确认与交易闸门，而且"能用"这件事看起来毫无异常
 *   · 凭据落盘       ⇒ 一条事件把控制权交出去（账本最可能被导出）
 *   · 失败合成一句   ⇒ 用户去查网络，而该做的是改一行环境变量
 *   · 被拒不留痕     ⇒ "没人试着连过"与"有人连过但被拒"在事后查证里长得一样
 *
 * ══ 只测语义不变量，不测数值 ═══════════════════════════════════════════
 * 不断言"轮询了几次"、不断言文案逐字 —— 那些会随措辞调整而变。测的是：
 *   默认拒 · 放行/收回双向 · **走同一条桌宠入口** · 凭据不落盘 ·
 *   失败三态互不顶替 · 读不到要说出来 · dropped 绝不发出去 · 文案卫生。
 *
 * ══ 隔离（比 `memory-smoke` 更严格）═══════════════════════════════════
 * ★ 三处根全部指向 `artifacts/telegram-smoke-<pid>/`：
 *   · 聊天记录 / 记忆 —— 往用户真记忆里灌假偏好比灌假日志危险得多；
 *   · **白名单文件** —— 往真白名单里塞假 chat 等于凭空给一个陌生会话
 *     开了交易权限。这是本文件里最要紧的一处隔离。
 * ★ 全程**一次真请求都不发**（假 fetch 注入）。真连 Telegram 的话，
 *   "本机没网"与"通道坏了"会得到同一个结论 —— 而那两件事处置方向相反。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getEvents, resetLedger } from '../server/ledger.ts'
import { resetOrch, seedPrice } from '../server/core.ts'
import { resetVoice, interruptVoice } from '../server/voice/service.ts'
import { setTranscriptRoot, readTranscript } from '../server/voice/transcript.ts'
import { setMemoryRoot, factByKey, lastMentionedSymbol, resetWorking, bindWorkingSid } from '../server/voice/memory.ts'
import { hostAllowed } from '../server/net/egress.ts'
import { plainText } from '../server/forecastService.ts'
import {
  allowChat,
  allowedChats,
  classifyApiRejection,
  classifyEgressFailure,
  handleTelegramUpdate,
  readChatList,
  resetTelegramStats,
  revokeChat,
  setTelegramDeps,
  setTelegramOffset,
  startTelegramPolling,
  stopTelegramPolling,
  telegramConfigured,
  telegramHealth,
  telegramHost,
  telegramPolling,
  telegramSpeech,
  telegramView,
} from '../server/voice/telegram.ts'

// ── 隔离：必须在任何模块**真正打开持久层之前**设好 ────────────────────────
// 与 `fleet-smoke` / `gateway-drill` 同款：ESM 的 import 会被提升，所以这两行
// 跑在所有 import 之后；但持久层是**懒打开**的（`initLedger()` 才开），
// 只要在这之前设好就安全。本文件索性**不调** `initLedger()` —— 它测的是
// 通道，不是账本；事件留在内存里足够，也省掉一次建库。
const RUN = `${process.pid}-${Date.now()}`
const ROOT = join(process.cwd(), 'artifacts', `telegram-smoke-${RUN}`)
const CHATS = join(ROOT, 'telegram-chats.json')
process.env.ORCH_DB = join(ROOT, 'orch.db')
process.env.TELEGRAM_CHATS_FILE = CHATS

/** 假 token。用一段**可 grep 的独特串**，这样"它有没有泄漏"是能断言的。 */
const TOKEN = '123456789:AATGSMOKE-DONOTLEAK-zzz9'
/** 假 DNS 解析（一个公网地址 ⇒ 只被"地址判据"挡的那一条之外都放行）。 */
const PUBLIC_IP = ['149.154.167.220']

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name} —— ${msg}`)
    console.log(`  ✗ ${name}\n      ${msg}`)
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${name} —— ${msg}`)
    console.log(`  ✗ ${name}\n      ${msg}`)
  }
}

// ───────────────────────────── 夹具 ─────────────────────────────

interface SentMsg {
  url: string
  chatId: string
  text: string
}

let sent: SentMsg[] = []

/**
 * 假 fetch —— ★ 一次真请求都不发。
 *
 * 收敛成**一处**：出网登记册按 `typeof fetch` 计数，而那一条计数是刻意的
 * （`egress.ts` 真正发请求的那一行就是裸引用）。集中一次，登记册上
 * 只需要回答一次（见 `scripts/egress-registry-check.ts`）。
 */
const injectedFetch = (fn: (url: string, init: { method?: string; body?: unknown }) => Promise<Response>) =>
  fn as unknown as typeof fetch

/** 造一条 Telegram update（**生产的形状**，字段与 `loop()` 收到的那一份一致）。 */
function update(chatId: number | string, text: string, opts: { name?: string; username?: string } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: opts.name ?? '主人', ...(opts.username ? { username: opts.username } : {}) },
      text,
    },
  }
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 默认替身：GET 返回成功（可带 updates）；POST 记下"发了什么"。 */
function stubOk(updates: unknown[] = []) {
  return injectedFetch(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { chat_id?: unknown; text?: unknown }
      sent.push({ url, chatId: String(body.chat_id ?? ''), text: String(body.text ?? '') })
      return jsonRes({ ok: true, result: { message_id: 2 } })
    }
    return jsonRes({ ok: true, result: updates })
  })
}

function injectStub(fetchImpl: ReturnType<typeof injectedFetch>, ips: string[] = PUBLIC_IP): void {
  setTelegramDeps({ fetchImpl, resolve: async () => ips })
}

/** 把白名单文件写成给定的内容（绕过环境变量，直接造夹具）。 */
function writeChatList(chats: string[]): void {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(CHATS, JSON.stringify({ chats, updatedAt: Date.now() }, null, 2), 'utf8')
}

function evSeq(): number {
  const e = getEvents(0)
  return e.length === 0 ? 0 : (e[e.length - 1]?.seq ?? 0)
}
function since(seq: number): { kind: string; payload: Record<string, unknown> }[] {
  return getEvents(seq).map((e) => ({ kind: e.kind, payload: e.payload }))
}
function kindsSince(seq: number): string[] {
  return since(seq).map((e) => e.kind)
}
function payloadsOf(seq: number, kind: string): Record<string, unknown>[] {
  return since(seq)
    .filter((e) => e.kind === kind)
    .map((e) => e.payload)
}
/** 整个账本序列化后的一整块文本 —— 用来断言"某个串绝没有出现在任何事件里"。 */
function ledgerDump(): string {
  return JSON.stringify(getEvents(0))
}

async function waitFor(pred: () => boolean, ms = 5000, label = '条件'): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到「${label}」（等了 ${ms} 毫秒）`)
}

/**
 * 等假 fetch 被叫到第 n 次 —— ★★ 用**微任务**叫醒，不用定时器。
 *
 * ══ 为什么不能用 `waitFor`（定时器）等轮询循环 ═══════════════════════════
 * 轮询循环如果饿死了事件循环（见 `telegram.ts` 的 `yieldToLoop`），
 * 那么**定时器永远不会触发** —— 于是"断言失败"会退化成"整个进程挂住"。
 * 挂住的门禁比变红的门禁坏得多：CI 只会超时，而日志上什么都看不到。
 * 用微任务叫醒则没有这个依赖：循环无论有没有让出宏任务，这个 await 都会返回，
 * 于是"事件循环有没有被饿死"变成一个**能干净地报红的断言**，
 * 而不是一个卡死。
 */
function wakeOnCall(nth: number): { promise: Promise<void>; onCall: () => void } {
  let n = 0
  let wake: (() => void) | null = null
  const promise = new Promise<void>((r) => {
    wake = r
  })
  return {
    promise,
    onCall: () => {
      n += 1
      if (n >= nth && wake) {
        const w = wake
        wake = null
        w()
      }
    },
  }
}

/** 文案卫生：给人念 / 给人看的字里不许出现这些（语音红线⑥）。 */
function assertCleanText(where: string, s: string): void {
  assert.ok(!/\*\*|__/.test(s), `${where} 里出现了 markdown 强调符（会被念出来）：${s.slice(0, 120)}`)
  assert.ok(!/undefined|NaN|\[object /.test(s), `${where} 里出现了 undefined / NaN / [object：${s.slice(0, 120)}`)
  assert.ok(!/。。|！！|\?\?|，，/.test(s), `${where} 里出现了叠标点：${s.slice(0, 120)}`)
  assert.ok(s.trim().length > 0, `${where} 是空串 —— 空回话与"没回"在手机上没有区别`)
}

// ═══════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })

  resetLedger()
  resetVoice()
  resetOrch(100_000)
  seedPrice('BTCUSDT', 60_000)
  seedPrice('ETHUSDT', 3_000)
  setTranscriptRoot(ROOT)
  setMemoryRoot(ROOT)
  bindWorkingSid('telegram-smoke')
  resetWorking()
  resetTelegramStats()
  setTelegramOffset(0)
  process.env.TELEGRAM_ALLOWED_CHATS = ''
  delete process.env.TELEGRAM_BOT_TOKEN

  // ═══════════ G0 前提：出网白名单必须真的放行这个域名 ═══════════
  console.log('\n── G0 前提：这条通道的域名必须在出网白名单里（否则第一步就被自己拦下） ──')

  check('G0 默认白名单放行 api.telegram.org（这是"为什么它进默认名单"唯一可断言的后果）', () => {
    assert.equal(telegramHost(), 'api.telegram.org', '通道打的域名变了 —— 白名单那一份也要跟着改')
    assert.equal(hostAllowed(telegramHost()), true, `出网白名单没有放行 ${telegramHost()} ⇒ 手机端第一次用就会报"被拦下"`)
  })

  check('G0 ★ 配对：后缀匹配必须按域名边界，看着像的域名不许被放行', () => {
    // 没有这一条，"放行"可以靠 `endsWith` 一把过 —— 于是
    // `api.telegram.org.evil.com` 也出得去，而上面那条断言照样绿。
    assert.equal(hostAllowed('api.telegram.org.evil.com'), false, '★ 后缀匹配漏了域名边界 ⇒ 白名单可被拼后缀绕过')
    assert.equal(hostAllowed('evil-api.telegram.org'), false, '★ 子域必须带点：`evil-api.telegram.org` 不是名单里那个域')
  })

  // ═══════════ G1 没配 token：不启动，且说清是哪一种 ═══════════
  console.log('\n── G1 没配 token：不启动，而且说的是"没配 token"而不是别的 ──')

  check('G1 没配 token ⇒ 不启动，理由是 NO_TOKEN（不是"白名单为空"）', () => {
    const r = startTelegramPolling()
    assert.equal(r.ok, false, '没配 token 却启动了轮询')
    assert.match(String(r.reason), /NO_TOKEN/, `理由必须是"没配 token"（指向"去 BotFather 建一个"）：${r.reason}`)
    assert.equal(telegramConfigured(), false)
    assert.equal(telegramPolling(), false, '★ 没配 token 时不许有任何循环在跑')
  })

  check('G1 ★ 三态互不顶替：这一档的人话里不许出现"放行名单是空的"', () => {
    // 两句都对，但它们指向**相反的动作**：一句是"去建 bot"，一句是"去填 id"。
    // 顶替的后果：用户拿着 token 去填名单，怎么填都不通。
    const s = telegramSpeech()
    assert.match(s, /TELEGRAM_BOT_TOKEN/, `第一档必须说清缺的是 token：${s}`)
    assert.ok(!/放行名单是空的|白名单是空的/.test(s), `★ 三态顶替了 —— 没配 token 却去说"名单是空的"：${s}`)
    assertCleanText('G1 人话', s)
  })

  // ═══════════ G2 配了 token、白名单为空 ⇒ 拒绝所有人 ═══════════
  console.log('\n── G2 白名单默认为空 = 拒绝所有人；但必须**说出来**，否则用户无从配置 ──')

  process.env.TELEGRAM_BOT_TOKEN = TOKEN
  writeChatList([])
  injectStub(stubOk())

  check('G2 配了 token、名单为空 ⇒ 名单条数为 0（fail-closed），且人话说的是这一档', () => {
    assert.equal(telegramConfigured(), true)
    assert.equal(allowedChats().size, 0, '★ 默认名单必须是空的')
    const s = telegramSpeech()
    assert.match(s, /放行名单是空的|谁都不能/, `这一档必须说"名单是空的"：${s}`)
    assert.ok(!/TELEGRAM_BOT_TOKEN/.test(s), '★ 反过来也不许顶替：配了 token 就别再说"没配 token"')
    assertCleanText('G2 人话', s)
  })

  await checkAsync('G2 陌生人发来的消息：**不执行**、被计数、且留痕', async () => {
    resetTelegramStats()
    sent = []
    const mark = evSeq()
    await handleTelegramUpdate(update(9001, '帮我买 100 U 的 BTC', { name: '路人', username: 'stranger' }))
    const h = telegramHealth()
    assert.equal(h.handled, 0, '★★ 未放行的会话被当成指令处理了 —— 这是本模块最贵的一种错')
    assert.equal(h.rejected, 1, '被拒次数没有计数 ⇒ 面板上看不出"有人在敲门"')
    assert.equal(h.pending.length, 1, '待放行清单是空的 ⇒ 用户不知道自己的 chat id 是哪来的')
    assert.equal(h.pending[0]?.chatId, '9001', `待放行清单里的 id 不对：${JSON.stringify(h.pending)}`)
    const ev = payloadsOf(mark, 'TELEGRAM_UNAUTHORIZED')
    assert.equal(ev.length, 1, '★ 未授权尝试必须留痕 —— "没人连过"与"有人连过但被拒"在事后查证里长得一样')
    assert.equal(ev[0]?.allowedCount, 0)
  })

  check('G2 ★ 未授权者的**原话**不许进账本（只记长度）', () => {
    // 账本是最持久、最可能被导出的地方。把陌生人的原文记进去，
    // 等于让任何能给 bot 发消息的人往我们的审计链里写字。
    assert.ok(!ledgerDump().includes('帮我买 100 U 的 BTC'), '★ 未授权者的原话进了账本')
    const ev = payloadsOf(0, 'TELEGRAM_UNAUTHORIZED')
    assert.equal(typeof ev[0]?.chars, 'number', '未授权事件里应当只有长度，没有正文')
  })

  check('G2 ★ 被拒的话不许进桌宠聊天记录（它连"问过"都不算）', () => {
    const page = readTranscript({ limit: 50 })
    assert.equal(page.unreadable, null, `读不到记录：${page.unreadable}`)
    assert.equal(
      page.turns.filter((t) => t.user?.text === '帮我买 100 U 的 BTC').length,
      0,
      '★ 未授权的话被写进了聊天记录',
    )
  })

  await checkAsync('G2 ★★ 回话必须把 chat id 告诉他 —— 这是他第一次配置时唯一需要的信息', async () => {
    assert.equal(sent.length, 1, `应当回一条"你还没连上"：${JSON.stringify(sent)}`)
    const s = sent[0]?.text ?? ''
    assert.ok(s.includes('9001'), `★ 回话里没有 chat id ⇒ 用户永远配不上：${s}`)
    assert.match(s, /TELEGRAM_ALLOWED_CHATS|放行|白名单/, `回话没说"怎么才能连上"：${s}`)
    assertCleanText('G2 回话', s)
  })

  await checkAsync('G2 ★★ 配对：同一个夹具下，**放行的**会话会走完整处理（证明"拒"不是"通道整个坏了"）', async () => {
    assert.equal(allowChat('9001', '本人'), true)
    assert.equal(allowedChats().has('9001'), true)
    // ★★ 放行之后它必须从"待放行"里消失。不消失的话，人话会**永远**催用户
    //    去放行一个已经放行的会话 —— 而那正是唯一一处"用户能自己开通"的引导。
    const h = telegramHealth()
    assert.equal(h.pending.length, 0, `★ 已放行的会话还挂在"待放行"里 ⇒ 提示会一直催一个已完成的动作：${JSON.stringify(h.pending)}`)
    resetTelegramStats()
    sent = []
    await handleTelegramUpdate(update(9001, 'BTCUSDT 现价多少', { name: '主人' }))
    const h2 = telegramHealth()
    assert.equal(h2.handled, 1, '★ 放行之后也该被处理 —— 否则上面的"拒绝"可能只是通道根本接不上')
    assert.equal(h2.rejected, 0, '放行的会话不该被计成"被拒"')
    assert.equal(sent.length, 1, '放行之后必须真的回话')
  })

  // ═══════════ G3 走的是同一条桌宠入口 ═══════════
  console.log('\n── G3 它不是一条新通道：走同一条 handleUtterance，落在同一份记录与记忆里 ──')

  await checkAsync('G3 一轮手机对话 → 出现在桌宠聊天记录里（只有那条路会写它）', async () => {
    resetTelegramStats()
    sent = []
    const text = 'BTCUSDT 现价多少'
    const mark = evSeq()
    await handleTelegramUpdate(update(9001, text))
    const page = readTranscript({ limit: 50 })
    const turn = page.turns.find((t) => t.user?.text === text)
    assert.ok(turn, '★ 手机说的话没有进聊天记录 ⇒ 它没有走 handleUtterance（而是自己另起了一条路）')
    assert.equal(turn.state, 'answered', `这一轮应当已答复：${turn.state}`)
    assert.ok(kindsSince(mark).includes('TELEGRAM_HANDLED'), '处理完必须落 TELEGRAM_HANDLED')
  })

  await checkAsync('G3 ★★ 三处措辞必须逐字一致：手机上看到的 === 记录里存的 === 念出来的', async () => {
    // 判据 D2：同一个事实只许有一个主人。这里加进第三个消费方（手机），
    // 分岔的后果很具体：用户在两处看到两个版本，会以为其中一个是旧消息。
    const page = readTranscript({ limit: 50 })
    const turn = page.turns.find((t) => t.user?.text === 'BTCUSDT 现价多少')
    assert.ok(turn?.assistant, '前提：这一轮有答复')
    const stored = turn.assistant.text
    const got = sent[0]?.text ?? ''
    assert.equal(got, plainText(stored), `★ 手机收到的与记录里的不是同一句：\n  手机=${got}\n  记录=${stored}`)
    assertCleanText('G3 发出去的正文', got)
  })

  check('G3 ★ 工作记忆同步更新（指代消解靠它，只有那个写入点会动它）', () => {
    assert.equal(lastMentionedSymbol(), 'BTCUSDT', '★ 手机说过的标的没有进工作记忆 ⇒ 下一句"平掉它"会解析不出来')
  })

  // ═══════════ G4 长期事实走同一条管道 ═══════════
  console.log('\n── G4 长期记忆同一条管道：手机说过的长期约定，桌宠必须记住 ──')

  await checkAsync('G4 手机里的一句长期约定真的进了持久记忆', async () => {
    resetTelegramStats()
    sent = []
    // 这句话刻意选得**既能被确定性解析、又带一条长期事实**：
    //   · 意图 = ask_system（不落到模型兜底 ⇒ 烟测不依赖网络、不依赖厂商配置）
    //   · 事实 = preference.leverage=3（走 extractFacts 的既有判据）
    await handleTelegramUpdate(update(9001, '我习惯用 3 倍杠杆，系统现在什么情况'))
    const f = factByKey('leverage')
    assert.ok(f, '★ 手机说的长期约定没有进记忆 ⇒ 两条入口的差距就在"记不记得住"上')
    assert.equal(f.value, 3, `记下来的值不对：${JSON.stringify(f)}`)
    assert.equal(typeof f.source.turnId, 'number', '出处必须能回到某一轮 —— 没有出处的"记忆"与"猜"长得一样')
    assertCleanText('G4 记忆正文', f.text)
  })

  // ═══════════ G5 凭据绝不落盘 ═══════════
  console.log('\n── G5 bot token 只许活在环境变量里，绝不许被写进任何落盘的东西 ──')

  await checkAsync('G5 ★★ 配对之一：请求 URL 里**确实**带了 token（否则"没泄漏"可能只是"压根没发请求"）', async () => {
    // 这条配对是本组的地基。少了它，"账本里没有 token"这个结论可以在
    // **一次请求都没发**的情况下成立 —— 而那正是最容易出现的假绿。
    resetTelegramStats()
    sent = []
    const seen: string[] = []
    const w = wakeOnCall(2)
    injectStub(
      injectedFetch(async (url, init) => {
        w.onCall()
        seen.push(url)
        if (init?.method === 'POST') sent.push({ url, chatId: '', text: '' })
        return jsonRes({ ok: true, result: [] })
      }),
    )
    // ★★ 这一个宏任务就是"事件循环有没有被冻住"的探针：它比轮询循环先排队，
    //   所以只要轮询肯让出宏任务边界，它就一定先跑。
    let macrotaskRan = false
    setImmediate(() => {
      macrotaskRan = true
    })
    const mark = evSeq()
    assert.equal(startTelegramPolling().ok, true)
    await w.promise
    // ★ 先停，再断言：断言抛了也不会把一条转着的循环留在进程里。
    stopTelegramPolling()
    assert.ok(seen.length >= 1, '一次请求都没发出去 ⇒ "没泄漏"这个结论不成立')
    assert.ok(
      seen.some((u) => u.includes('/bot' + TOKEN + '/')),
      `请求 URL 里没有带 token ⇒ 夹具没在测真的那条路：${seen[0]?.slice(0, 40)}`,
    )
    assert.ok(kindsSince(mark).includes('TELEGRAM_POLLING_STARTED'), '启动要留痕')
    assert.ok(kindsSince(mark).includes('TELEGRAM_POLLING_STOPPED'), '停止也要留痕（否则"被要求退出"与"自己死了"长得一样）')
    // ★★ 轮询**不许**把事件循环饿死。冻住的后果是整个编排器一起停：
    //    HTTP 服务、行情 tick、定时日报全部无声无息 —— 而账本上一条异常都没有。
    assert.equal(
      macrotaskRan,
      true,
      '★★ 轮询循环把事件循环饿死了（宏任务跑不到）⇒ 整个编排器会被这条通道冻住',
    )
    assert.ok(telegramHealth().polls >= 1, '轮询计数没有真的在涨')
    injectStub(stubOk())
  })

  await checkAsync('G5 ★★ 配对之二：被拦下的轮询会在账本里留下 URL，但那一条 URL 里**没有 token**', async () => {
    // ★ 这条断言是有来历的：`fetchPage` 的失败记账会把**整条 URL** 写进
    //   `EGRESS_BLOCKED`，而 Telegram 的 token 就住在 URL 的路径里 ——
    //   于是"一次被白名单拦下的轮询"会把控制权写进账本，而账本恰恰是
    //   本机最持久、最可能被导出的一份文件。
    //   修法是出网层的 `redact`；而这条断言同时钉住两个方向。
    resetTelegramStats()
    injectStub(stubOk(), ['127.0.0.1']) // 解析到内网 ⇒ 第三层判据拦下
    const mark = evSeq()
    startTelegramPolling()
    await waitFor(() => telegramHealth().failures >= 1, 5000, '第一轮失败')
    stopTelegramPolling()
    const blocked = payloadsOf(mark, 'EGRESS_BLOCKED')
    // ★ `>= 1` 而不是 `=== 1`：上一个用例关掉通道时，它的循环可能正在
    //   一次请求里面，会多跑完一轮再退出。这里要钉的是"被拦必须留痕"，
    //   而不是"恰好拦了几次"（后者会变成一个随时序抖动的门）。
    //   循环的唯一性由下面那条**专门的**断言负责，不混在这一条里。
    assert.ok(blocked.length >= 1, `出网被拦必须留痕（否则"被拦"这件事只有 Telegram 自己知道）：${JSON.stringify(kindsSince(mark))}`)
    // ★★ 配对方向一：URL **必须有**，而且要指向 Telegram 那个主机。
    //    少了这一条，把 `url` 字段整个删掉（出网审计变瞎）也能让下面那条绿。
    const urls = blocked.map((b) => String(b.url ?? ''))
    assert.ok(
      urls.some((u) => u.includes('api.telegram.org')),
      `被拦的 URL 没记下来 ⇒ 出网审计瞎了：${JSON.stringify(blocked)}`,
    )
    // ★★ 配对方向二：它里面**不许**有 token。
    assert.ok(!urls.some((u) => u.includes(TOKEN)), `★★ 被拦的 URL 里带着 bot token 落盘了：${JSON.stringify(blocked)}`)
    assert.ok(
      !blocked.some((b) => String(b.note ?? '').includes(TOKEN)),
      `★★ 被拦的说明里带着 bot token 落盘了：${JSON.stringify(blocked)}`,
    )
    injectStub(stubOk())
  })

  await checkAsync('G5 ★★ 发消息失败时也同理（对端可以回一个含凭据的跳转目标）', async () => {
    // ★ 这一条钉的是**另一条泄漏路径**：出网层返回给调用方的 `note` 保持原样
    //   （那是调试用的），而本模块会把这个 note 再写进**自己的**事件里 ——
    //   于是凭据顺着"上游的调试信息"换了一条路回到账本上。
    //   对端完全可以把 302 的 location 写成任意串，所以这个形状是可达的。
    resetTelegramStats()
    sent = []
    injectStub(
      injectedFetch(async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response('', {
            status: 302,
            headers: { location: 'https://example.com/leak/' + TOKEN + '/x' },
          })
        }
        return jsonRes({ ok: true, result: [] })
      }),
    )
    const mark = evSeq()
    await handleTelegramUpdate(update(9001, 'BTCUSDT 现价多少'))
    const failed = payloadsOf(mark, 'TELEGRAM_SEND_FAILED')
    assert.equal(failed.length, 1, `发失败了必须留痕：${JSON.stringify(kindsSince(mark))}`)
    // ★ 配对方向一：诊断信息**必须还在**（把 error 清空也能让下面那条绿，但那是坏法）。
    assert.ok(String(failed[0]?.error ?? '').length > 0, '发失败的原因被清空了 ⇒ 出事时无从查起')
    assert.match(String(failed[0]?.error ?? ''), /302/, `失败原因要能看出是跳转：${failed[0]?.error}`)
    // ★ 配对方向二：它里面不许有凭据。
    assert.ok(!String(failed[0]?.error ?? '').includes(TOKEN), `★★ 发失败的说明里带着 bot token 落盘了：${JSON.stringify(failed[0])}`)
    injectStub(stubOk())
  })

  check('G5 ★★ token 不在账本里的任何一条事件里（查的是**整份序列化**，不是某几个字段）', () => {
    // 只查几个字段的话，将来任何一个新事件把 URL 顺手记进去都会静默通过。
    // ★ 报错时把**是哪几条事件**列出来：只说"泄漏了"等于让人从头 grep 一遍。
    const leaky = getEvents(0)
      .filter((e) => JSON.stringify(e.payload).includes(TOKEN))
      .map((e) => e.kind)
    assert.deepEqual(leaky, [], `★★ 这几类事件把 bot token 写进账本了：${JSON.stringify(leaky)}（账本是本机最可能被导出的一份文件）`)
    assert.ok(!ledgerDump().includes('DONOTLEAK'), 'token 的片段进了账本')
  })

  check('G5 ★★ token 不在面板 / 人话的任何一格读数里', () => {
    const v = JSON.stringify(telegramView())
    assert.ok(!v.includes(TOKEN), `telegramView() 泄漏了 token：${v.slice(0, 200)}`)
    assert.ok(!telegramSpeech().includes(TOKEN), '人话里泄漏了 token')
    // ★ 配对：面板必须**真的**给出名单里的 id（否则"放行了谁"无法核对、
    //   也无法收回）。少了这一条，"不泄漏"可以靠什么都不给来满足。
    //
    // ★★ 为什么先断形状、再断内容（这一条有来历）：原来直接写
    //   `telegramView().allowedIds.includes('9001')`，而字段被拿掉时（变异 V15）
    //   它抛的是 `Cannot read properties of undefined` —— 门禁红了，但报的是一句
    //   JS 错，看不出"面板缺了哪一栏、用户会因此做不成什么事"。
    //   先断 `Array.isArray` 让这条门禁**说人话**（判据 D7）。
    const ids = telegramView().allowedIds as unknown
    assert.ok(
      Array.isArray(ids),
      `★★ 面板必须给出**具体**的 id 清单，拿到的是 ${JSON.stringify(ids)} —— ` +
        '没有它，"放行了谁"无法核对，要收回谁都只能靠猜',
    )
    assert.equal((ids as string[]).includes('9001'), true, '★ 面板的 id 清单里少了刚放行的那个会话')
  })

  // ═══════════ G6 失败三态互不顶替 ═══════════
  console.log('\n── G6 失败要说清是哪一种：三种指向三个**相反**的动作 ──')

  check('G6 被白名单拦下 ⇒ blocked，且文案指向"改 EV_EGRESS_HOSTS"', () => {
    const r = classifyEgressFailure('HOST_NOT_ALLOWED', 'api.telegram.org 不在出网白名单里')
    assert.equal(r.kind, 'blocked')
    assert.match(r.note, /EV_EGRESS_HOSTS/, `★ 必须给出正确的下一步，否则用户会去查网络：${r.note}`)
    assert.match(r.note, /别去查网络/, '要说清"不是网络问题"')
  })

  check('G6 解析到内网被拒 ⇒ 也是 blocked（它不是"网络没通"）', () => {
    // 这两档合并的后果：一次 SSRF 式的配置错误会被当成日常抖动放过。
    const r = classifyEgressFailure('PRIVATE_ADDRESS', 'api.telegram.org 解析到 127.0.0.1')
    assert.equal(r.kind, 'blocked', '★ 地址判据拦下的必须记成"被拦"，不是"没通"')
  })

  check('G6 token 不对（401）⇒ unauthorized，文案指向"换 token"', () => {
    const r = classifyApiRejection(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
    assert.equal(r.kind, 'unauthorized')
    assert.match(r.note, /TELEGRAM_BOT_TOKEN/, `★ 401 不是网络问题，文案必须说去换 token：${r.note}`)
    assert.match(r.note, /改网络配置永远不会好/, '要说清"改网络没用"')
  })

  check('G6 超时 / 非 401 的错 ⇒ network（与前两档互不顶替）', () => {
    const a = classifyEgressFailure('TIMEOUT', 'api.telegram.org 在 35000 毫秒内没有回应')
    const b = classifyApiRejection('这不是 JSON')
    assert.equal(a.kind, 'network')
    assert.equal(b.kind, 'network')
    assert.ok(!/EV_EGRESS_HOSTS/.test(a.note), '网络问题不该把人引去改白名单')
    assert.ok(!/TELEGRAM_BOT_TOKEN/.test(b.note), '非 401 的错误不该把人引去换 token')
  })

  check('G6 ★★ 三档两两不同（"分得清"这件事本身要被断言）', () => {
    const kinds = new Set([
      classifyEgressFailure('HOST_NOT_ALLOWED', 'x').kind,
      classifyApiRejection(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })).kind,
      classifyEgressFailure('TIMEOUT', 'x').kind,
    ])
    assert.equal(kinds.size, 3, `★ 三档退化成了 ${kinds.size} 档 —— 它们指向的动作完全不同：${[...kinds].join('/')}`)
  })

  await checkAsync('G6 ★★ 端到端：真轮询循环真的把"被拦"这一档落进了账本，而且停止真的停下来了', async () => {
    // 纯函数断言证明不了"它被接在 getUpdates 上"。这条走真循环、看真事件。
    // ★ 只跑一轮：每种失败在真循环里都要等一次 15 秒退避，跑三种就是 45 秒，
    //   而"分类只有一份实现"—— 一轮足以证明接线。（三档本身由上面几条覆盖。）
    resetTelegramStats()
    sent = []
    injectStub(stubOk(), ['127.0.0.1'])
    const mark = evSeq()
    assert.equal(startTelegramPolling().ok, true)
    await waitFor(() => telegramHealth().failures >= 1, 5000, '第一轮失败')
    stopTelegramPolling()
    const ev = payloadsOf(mark, 'TELEGRAM_POLL_FAILED')
    assert.equal(ev.length, 1, `轮询失败必须落盘（第一次失败就落）：${JSON.stringify(kindsSince(mark))}`)
    assert.equal(ev[0]?.kind, 'blocked', `★ 分类没接上 getUpdates：${JSON.stringify(ev[0])}`)
    assert.match(String(telegramHealth().lastError), /EV_EGRESS_HOSTS/, '健康度里的说明也要指向正确的动作')
    assert.equal(telegramHealth().polls, 1, '★ polls 必须有真的在涨（一个永远为 0 的计数比没有这一格更坏）')
    assert.equal(typeof telegramHealth().lastPollAt, 'number', 'lastPollAt 必须真的被写过')

    // ★★ 「停止」必须真的让循环停下来，而不是"等退避自然醒来"。
    //    判据是**退避窗口远小于背退时长**：循环此刻正睡在 15 秒的退避里，
    //    叫不醒的话这几百次宏任务里根本看不到 EXITED（而进程要陪着挂 15 秒）。
    //    ★ 刻意不用墙钟量 `stopTelegramPolling()` 自己 —— 那是个同步调用，
    //      它永远是"立刻返回"，那种断言没有牙（我第一版就是那样写的）。
    for (let i = 0; i < 300; i += 1) await new Promise((r) => setImmediate(r))
    assert.ok(
      kindsSince(mark).includes('TELEGRAM_POLLING_EXITED'),
      '★★ 停止之后循环没有真的退出（退避没被叫醒）—— 真机上表现为"我让它停，但它还活着"，进程还要陪着挂 15 秒',
    )
    injectStub(stubOk())
  })

  // ═══════════ G7 白名单读不到要说出来，且不许退化成"放行所有人" ═══════════
  console.log('\n── G7 白名单文件坏掉：退回环境变量那一份 + 说清"读不到" ──')

  check('G7 坏 JSON ⇒ 说得出"读不到"，且**只**信环境变量那一份', () => {
    writeFileSync(CHATS, '{ 这不是 JSON', 'utf8')
    process.env.TELEGRAM_ALLOWED_CHATS = '777'
    const r = readChatList()
    assert.ok(r.readFailed, '★ 读不到却报了"正常" —— 用户会以为"我明明放行了却不好使"')
    assert.equal(r.chats.length, 1, '★ 必须退回环境变量那一份（而不是 0，更不是放行所有人）')
    assert.equal(r.chats[0], '777')
    assert.ok(!allowedChats().has('9001'), '★ 文件坏掉时不许退化成"放行所有人"')
  })

  check('G7 人话必须把"文件有问题"说出来（四种坏法里唯一一种要去修文件的）', () => {
    const v = telegramView()
    assert.ok(v.chatListError, '视图里没有 "白名单文件读不出来" 这一格')
    assert.match(telegramSpeech(), /白名单文件有问题/, `人话没说文件坏了：${telegramSpeech()}`)
    assert.equal(v.chatFile, CHATS, '视图要说清"它把名单存哪了"')
  })

  check('G7 ★ 配对：文件修好之后那一句必须消失（否则它是常量，不是状态）', () => {
    writeChatList(['9001'])
    process.env.TELEGRAM_ALLOWED_CHATS = ''
    const r = readChatList()
    assert.equal(r.readFailed, null, `修好了还报错：${r.readFailed}`)
    assert.equal(r.chats.length, 1)
    assert.equal(r.chats[0], '9001')
    assert.ok(!/白名单文件有问题/.test(telegramSpeech()), '修好之后还在说文件坏了 ⇒ 那一句没有真的读文件')
  })

  // ═══════════ G8 放行 / 收回是双向的，而且都是**人**的动作 ═══════════
  console.log('\n── G8 权限表必须能加也能减（只能加的表是一个死门） ──')

  check('G8 放行真的落盘，且留痕', () => {
    const mark = evSeq()
    assert.equal(allowChat('555', '测试会话'), true)
    assert.ok(allowedChats().has('555'), '放行之后读不回来 ⇒ 下次重启就失效')
    assert.ok(readFileSync(CHATS, 'utf8').includes('555'), '放行没有写进文件')
    assert.equal(payloadsOf(mark, 'TELEGRAM_CHAT_ALLOWED').length, 1, '放行动作必须留痕（谁在什么时候被放进来）')
  })

  check('G8 收回真的生效，且留痕', () => {
    const mark = evSeq()
    assert.equal(revokeChat('555'), true)
    assert.equal(allowedChats().has('555'), false, '★ 收不回来 ⇒ 误放行之后唯一的补救手段是手工改 JSON')
    assert.ok(!readFileSync(CHATS, 'utf8').includes('555'), '文件里还留着已收回的 id')
    assert.equal(payloadsOf(mark, 'TELEGRAM_CHAT_REVOKED').length, 1)
  })

  check('G8 ★ "收回一个不在册的 id"与"真的收回了"必须能分开', () => {
    const mark = evSeq()
    assert.equal(revokeChat('从未放行过'), true, '它不该被当成失败 —— 结果是对的（他现在不在册）')
    const ev = payloadsOf(mark, 'TELEGRAM_CHAT_REVOKED')
    assert.equal(ev.length, 1, '仍然要留痕：最常见的成因是"点了两次"或"id 抄错了"，两个都值得看见')
    assert.equal(ev[0]?.noop, true, '★ 没有区分"空转"与"真删掉了" ⇒ 事后查不出"我明明点过为什么还在"')
  })

  check('G8 空 id 一律拒绝（不许把"空"当成一个会话）', () => {
    assert.equal(allowChat('   '), false)
    assert.equal(revokeChat(''), false)
  })

  // ═══════════ G9 dropped 的答复绝不发出去 ═══════════
  console.log('\n── G9 被打断作废的答复，一个字都不许发到手机上 ──')

  const INTERRUPT_TEXT = '我习惯用 3 倍杠杆，系统现在什么情况'

  await checkAsync('G9 ★★ 配对：先证明**不打断**时它一定会发（否则"没发"这个结论毫无意义）', async () => {
    resetTelegramStats()
    sent = []
    const mark = evSeq()
    await handleTelegramUpdate(update(9001, INTERRUPT_TEXT))
    assert.equal(sent.length, 1, `不打断时必须发出 1 条：${JSON.stringify(sent)}`)
    assert.ok(kindsSince(mark).includes('TELEGRAM_HANDLED'), '不打断时必须落 TELEGRAM_HANDLED')
  })

  await checkAsync('G9 ★★ 打断之后：一个字都不许发出去，也不许记成"已处理"', async () => {
    resetTelegramStats()
    sent = []
    const mark = evSeq()
    // ★ 确定性来自"这句话的意图走异步工具"（ask_system → await readTool）：
    //   `handleTelegramUpdate` 会在第一个 await 处让出，所以下面这行
    //   **同步**执行的打断一定发生在答复提交之前。
    //
    // ★★ 为什么"抢到窗口"与"守规矩"必须是**两条**断言（这一条有来历）：
    //   原来只有一条，断的是 `kinds.includes('TELEGRAM_REPLY_DROPPED')` ——
    //   而那个事件本身就住在 `telegram.ts` 的 `if (reply.dropped)` 分支**里面**。
    //   于是把整块分支删掉（变异 V9）之后，这条断言照样红，但它报出来的话是
    //   "没抢到打断窗口"，把**产品缺陷**说成了**夹具失效**。
    //   两者的处置方向完全相反：一个是去修 `telegram.ts`，一个是去换一句话。
    //
    //   ★ 证词必须来自**另一个模块**：语音服务在作废路径上会把这一轮答复记成
    //     `dropped: true`（见 `session.ts` 的 `drop()`，判据是 generation 对不上）。
    //     那是"打断确实抢在答复提交之前"的证据，且它不经 telegram 那个分支 ——
    //     所以删掉分支也带不走它。判据 13：两个方向的证据要能分开读。
    const droppedBefore = readTranscript({ limit: 50 }).turns.filter(
      (t) => t.user?.text === INTERRUPT_TEXT && t.assistant?.dropped === true,
    ).length
    const p = handleTelegramUpdate(update(9001, INTERRUPT_TEXT))
    interruptVoice('SMOKE_BARGE_IN')
    await p
    const kinds = kindsSince(mark)
    const droppedNow = readTranscript({ limit: 50 }).turns.filter(
      (t) => t.user?.text === INTERRUPT_TEXT && t.assistant?.dropped === true,
    ).length
    assert.ok(
      droppedNow > droppedBefore,
      '★ 夹具没抢到打断窗口 —— 记录里这一轮答复**没有**被标成 dropped。' +
        `它说的是夹具，不是产品：请换一句走异步工具的指令（当前 "${INTERRUPT_TEXT}"）。` +
        '★ 不要去改 telegram.ts：那个分支删掉也不会让这一条变绿（见上面的注释）。',
    )
    // ★ 先断**用户能感知到**的那一件事（手机上有没有收到），再断留痕 ——
    //   `check()` 只报**第一条**失败，顺序决定了出事时先看到哪句话。
    assert.equal(sent.length, 0, `★★ 被作废的答复发出去了 —— 手机上会收到一句系统自己都不认的话：${JSON.stringify(sent)}`)
    assert.ok(
      kinds.includes('TELEGRAM_REPLY_DROPPED'),
      `★★ 作废发生了却没有留痕 ⇒ 事后分不清"没回"与"回了又被撤"：${JSON.stringify(kinds)}`,
    )
    assert.ok(!kinds.includes('TELEGRAM_HANDLED'), '作废的轮次不许记成"已处理"')
  })

  // ═══════════ G10 通道状态的四档人话 ═══════════
  console.log('\n── G10 四种坏法的人话必须互不顶替（它们指向四个不同的动作） ──')

  check('G10 有名单但没轮询 ⇒ 说的是"轮询没有在跑"（不是"名单是空的"）', () => {
    writeChatList(['9001'])
    assert.equal(telegramPolling(), false)
    const s = telegramSpeech()
    assert.match(s, /轮询没有在跑/, `这一档必须说"轮询没跑"（否则用户会以为是自己手机的问题）：${s}`)
    assert.ok(!/放行名单是空的/.test(s), '★ 名单非空却去说"名单是空的"')
    assertCleanText('G10 人话', s)
  })

  check('G10 ★ 四档人话两两不同（退化成一档 = 用户不知道该做哪件事）', () => {
    const notPolling = telegramSpeech()
    writeChatList([])
    const emptyList = telegramSpeech()
    delete process.env.TELEGRAM_BOT_TOKEN
    const noToken = telegramSpeech()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    writeChatList(['9001'])
    const seen = new Set([notPolling, emptyList, noToken])
    assert.equal(seen.size, 3, `★ 三档人话退化成了 ${seen.size} 句：${[...seen].map((x) => x.slice(0, 24)).join(' | ')}`)
    assert.match(emptyList, /放行名单是空的|谁都不能/)
    for (const s of [notPolling, emptyList, noToken]) assertCleanText('G10 人话', s)
  })

  await checkAsync('G10 ★ 待放行的会话要出现在人话里（用户唯一的开户线索）', async () => {
    // ★ 这一格只在"通道在跑"那一档里出现（`telegramSpeech` 的最后一段），
    //   所以这里必须**在轮询还开着的时候**取人话 —— 也顺带证明那一档真的可达。
    resetTelegramStats()
    sent = []
    writeChatList(['9001'])
    const w = wakeOnCall(2)
    injectStub(
      injectedFetch(async (url, init) => {
        w.onCall()
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body ?? '{}')) as { chat_id?: unknown; text?: unknown }
          sent.push({ url, chatId: String(body.chat_id ?? ''), text: String(body.text ?? '') })
          return jsonRes({ ok: true, result: {} })
        }
        return jsonRes({ ok: true, result: [] })
      }),
    )
    assert.equal(startTelegramPolling().ok, true)
    await w.promise
    try {
      await handleTelegramUpdate(update(4242, '在吗', { name: '另一个设备' }))
      const v = telegramView()
      assert.equal(v.pending.length, 1, `待放行清单没收到这条敲门：${JSON.stringify(v.pending)}`)
      const s = telegramSpeech()
      assert.ok(s.includes('4242'), `★ 有人在敲门，但人话里没有他的 id ⇒ 用户无从放行：${s}`)
      assertCleanText('G10 人话', s)
    } finally {
      // ★ 放在 finally 里：这一组断言抛了也**不许**把一条转着的轮询留在进程里
      //   （那会让下一次红灯看起来像"卡住"）。
      stopTelegramPolling()
    }
  })

  await checkAsync('G10 ★★ stop 之后紧接着 start，不许留下**两个**循环（那会让同一条指令被处理两次）', async () => {
    // ══ 这条断言钉的是本模块最贵的一个时序缺陷 ══════════════════════════
    // "停止"只是放倒旗子，而循环是在**下一次抬头**时才发现。如果这中间有人
    // 又 start 了一次，旗子重新立起来 —— 旧循环抬头看到"还在跑"就继续跑下去。
    // 于是两个循环同时拉 getUpdates：同一条消息处理**两次**（在交易系统里
    // 那是两笔单），两边的 offset 互相追赶（漏消息与重复消息同时出现），
    // 而账本上只有一条 POLLING_STARTED，看起来完全正常。
    //
    // 判据选**调用次数**而不是内部变量：代号是内部实现，而"一个宏任务窗口里
    // 发几次请求"是外部可观测的后果，也正是用户会遭遇到的那件事。
    //
    // ★ 全程只用宏任务推进（`setImmediate`），不依赖定时器 —— 所以它**不会**
    //   因为别的问题挂住，只会干净地报红。
    const N = 12
    const advance = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r))
    }
    let calls = 0
    injectStub(
      injectedFetch(async (url, init) => {
        if (init?.method !== 'POST') calls += 1
        return jsonRes({ ok: true, result: [] })
      }),
    )
    resetTelegramStats()

    // ── 窗口一：正常的一个循环 ────────────────────────────────────────
    assert.equal(startTelegramPolling().ok, true)
    const id1 = telegramHealth().loopId
    await advance(N)
    const first = calls

    // ── 窗口二：stop 立刻 start（真实场景：面板上关掉再打开）───────────
    stopTelegramPolling()
    assert.equal(startTelegramPolling().ok, true)
    const id2 = telegramHealth().loopId
    await advance(N)
    const second = calls - first

    stopTelegramPolling()
    assert.notEqual(id2, id1, '★ 代号没换 ⇒ "停止"没有真正作废上一个循环')
    assert.ok(first >= 1, `窗口一里一次请求都没发（前提不成立）：${first}`)
    assert.ok(
      second <= Math.ceil(first * 1.5),
      `★★ 窗口二里的请求数翻倍了（${first} → ${second}）⇒ 有两个循环在同时拉消息：` +
        `同一条指令会被处理两次，而账本上看不出来`,
    )
  })

  // ── 收尾 ──────────────────────────────────────────────────────────────
  stopTelegramPolling()
  setTelegramDeps({})
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_ALLOWED_CHATS
}

await main()

console.log('')
if (failures.length > 0) {
  console.error(`❌ Telegram 通道门禁失败 ${failures.length} 条（通过 ${passed}）`)
  for (const f of failures) console.error(`  · ${f}`)
  console.error('')
  console.error('★ 这道门测的是「谁能通过它下指令」，不是"功能能不能用"。')
  console.error('  任何一条红都请先回答：这条规矩失效之后，用户会在什么时候、以什么方式发现？')
  process.exit(1)
}
console.log(`✅ Telegram 通道门禁 ${passed}/${passed} 全绿`)
console.log(`   隔离根：${ROOT}`)
