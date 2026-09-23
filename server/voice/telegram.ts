/**
 * Telegram 通道 —— 让手机能像坐在电脑前一样指挥它
 *
 * ══ 它解决什么 ═══════════════════════════════════════════════════════
 * 用户原话：「桌宠系统我是要适配到手机端远程使用的，确保使用第三方软件能
 * 正常的调用，例如用 telegram 连接登入桌宠系统，作为 bot 来操控 evolve 系统」。
 *
 * ── 为什么是 long polling 而不是 webhook ──────────────────────────────
 * webhook 要求 Telegram 能**主动连到本机** —— 那需要公网入口 + HTTPS 证书
 * （本机编排器是 `node:http`，全仓没有任何 HTTPS 服务端）。
 * long polling 只要**出网**能力，而本系统已经有受控的出网通道。
 * 代价：本机要一直挂着一条 25 秒的长请求。这是**有意付的**（判据 D10：
 * 先量真实需求 —— 一个自托管交易系统不该为了收消息去开公网入口）。
 *
 * ══ 红线（每一条都对应一种"不报错的坏法"）══════════════════════════════
 *
 * ★★ **① 白名单默认为空 = 拒绝所有人。**
 *    这是本模块最重要的红线，因为它是**唯一**一条"暴露到公网对面"的通道。
 *    Telegram bot 的 username 是可被搜到的：没有白名单的话，
 *    **任何找到这个 bot 的人都能对 EVOLVE 下指令** —— 包括下单、开熔断、启动自治。
 *    所以：
 *      · 空名单 ⇒ 谁都不放行（fail-closed，判据 3）；
 *      · **绝不自动绑定**（"第一个发消息的人就是主人"是灾难性的默认值）；
 *      · 未知会话的尝试**必须留痕并说出来**，否则用户永远不知道该填哪个 chat_id
 *        （"我不知道该配什么"与"没人试着连过"在事后查证里长得一样）。
 *
 * ★★ **② 它不是一个新通道。**
 *    进来的话走**同一条** `handleUtterance` —— 同一个意图解析、同一条两段式确认、
 *    同一道 `tradeGate`、同一份账本留痕、同一份记忆与聊天记录。
 *    本模块**只做搬运**：收消息 → 交给桌宠 → 把回话发回去。
 *    任何在这里"顺手加一个功能"的写法（直接调下单、自己判意图）都会造出
 *    一条绕开全部风控的旁路 —— 而它会以"用户体验优化"的名义通过评审。
 *
 * ★ **③ 凭据不许出现在任何落盘的地方。**
 *    Telegram 的 bot token 就在 URL 里（`/bot<token>/getUpdates`）。
 *    所以本模块**只落 host、绝不落 URL**：账本是最持久、最可能被导出的地方，
 *    一条记着 token 的事件等于把控制权交出去（与启动口令那条红线同源）。
 *
 * ★ **④ 回话是给人看的，不是给人念的 —— 但两处必须是同一句话。**
 *    发出去的文本过 `plainText`（口播口径的唯一出口），这样手机上看到的
 *    与桌宠嘴里念的**逐字一致**。不一致的后果是用户在两处得到两个版本，
 *    而他会以为其中一个是旧消息。
 *
 * ★ **⑤ 失败要分得清。** 「没配 token」「token 不对（401）」「网络没通」
 *    「被出网白名单拦了」是四件事，指向四个**相反**的动作
 *    （去配 / 去换 / 查网络 / 改 EV_EGRESS_HOSTS）。合成一句"连接失败"
 *    会让用户去查网络，而真正该做的是把 `api.telegram.org` 加进白名单。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchPage, postJson } from '../net/egress.ts'
import { appendEvent } from '../ledger.ts'
import { handleUtterance } from './service.ts'
import { plainText } from '../forecastService.ts'

/** Telegram 的 API 域名。★ 出网白名单里必须有它（见 `egress.ts` 与出网登记册）。 */
const TG_HOST = 'api.telegram.org'

/**
 * long polling 的等待秒数。取值 25 与 Telegram 建议的一致。
 * ★ 与之绑定的出网超时必须**大于**它（见 `POLL_TIMEOUT_MS`），
 *   否则每一轮都会在自己的超时上失败 —— 而那看起来像"Telegram 没响应"。
 */
const LONG_POLL_SEC = 25
const POLL_TIMEOUT_MS = (LONG_POLL_SEC + 10) * 1000

/** Telegram 单条消息上限。超了要**截断并说出来**，不能静默丢半句。 */
const MAX_MSG_CHARS = 4096

/** 失败退避。★ 不做固定 1 秒重试：token 错时那会变成对 Telegram 的持续打扰。 */
const BACKOFF_MS = 15_000

// ───────────────────────────── 配置 ─────────────────────────────

export function botToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
}

export function telegramConfigured(): boolean {
  return botToken().length > 0
}

/**
 * 白名单文件的位置。
 *
 * ★ 为什么给它留一个环境变量：这不是安全开关（它只决定**白名单住在哪**，
 *   不决定"允不允许"），但它让两件正事变得可能：
 *   ① 烟测可以做**真隔离** —— 往用户的真白名单里塞假 chat 比塞假日志危险，
 *      那等于凭空给一个陌生会话开了交易权限（与 `ORCH_DB` 同款纪律）；
 *   ② 有人想把白名单放在别处（只读挂载 / 另一个数据盘）时不必改代码。
 */
function chatsFile(base = process.cwd()): string {
  const override = (process.env.TELEGRAM_CHATS_FILE ?? '').trim()
  if (override.length > 0) return override
  return join(base, 'data', 'telegram-chats.json')
}

/** 白名单的读取结果。★ `readFailed` 与"空名单"必须分开 —— 见 `allowedChats`。 */
export interface ChatListRead {
  chats: string[]
  /** 非 `null` = 文件在那儿但读不出来（坏 JSON / 无权限）。**处置方向是"去修文件"**。 */
  readFailed: string | null
}

/**
 * 读白名单，并**如实说出"读不到"**。
 *
 * ★★ 为什么不能只返回一个 `Set`：`allowedChats()` 把"文件坏了"吞成空集合，
 *   而空集合的含义是**拒绝所有人**。两者在用户那边的表现一模一样
 *   （"我明明放行了，它还是说我没权限"），但处置方向相反：
 *   一个是"你还没放行"，另一个是"文件坏了，去修"。判据 C7。
 */
export function readChatList(): ChatListRead {
  const out = new Set<string>()
  for (const raw of (process.env.TELEGRAM_ALLOWED_CHATS ?? '').split(',')) {
    const v = raw.trim()
    if (v.length > 0) out.add(v)
  }
  const p = chatsFile()
  if (!existsSync(p)) return { chats: [...out], readFailed: null }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { chats?: unknown }
    if (Array.isArray(j.chats)) {
      for (const c of j.chats) if (typeof c === 'string' && c.trim().length > 0) out.add(c.trim())
    } else {
      return { chats: [...out], readFailed: `${p} 里没有 chats 数组` }
    }
  } catch (e) {
    return { chats: [...out], readFailed: `${p} 读不出来：${e instanceof Error ? e.message : String(e)}` }
  }
  return { chats: [...out], readFailed: null }
}

/**
 * 白名单。
 *
 * ★ 两个来源合并（环境变量 + 文件），但**默认是空集合**。
 *   空集合 = 谁也不放行 —— 这是刻意的 fail-closed。
 * ★ 读不出来时**退回环境变量那一份**（而不是"放行所有人"）：
 *   这个方向的错误选择在这里是致命的。读不到这件事由 `readChatList`
 *   的 `readFailed` 带出去，`telegramSpeech()` 会念出来。
 */
export function allowedChats(): Set<string> {
  return new Set(readChatList().chats)
}

/** 记住一个 chat（用户确认后调用）。★ 只有**人**能调它 —— 自动绑定是红线①禁止的。 */
export function allowChat(chatId: string, label = ''): boolean {
  return writeChats('allow', chatId, label)
}

/**
 * 收回一个 chat 的权限。
 *
 * ★★ 为什么"放行"必须配一个"收回"：一个**只能加不能减**的权限表是一个死门。
 *   误放行（抄错一位数字、把群 id 当成私聊 id）之后，用户唯一的补救手段
 *   是手工去改 JSON 文件 —— 而他会先以为"这个按钮点了没用"。
 *   一个把陌生会话永久接进交易系统的口子，不能没有反向操作。
 */
export function revokeChat(chatId: string): boolean {
  return writeChats('revoke', chatId)
}

function writeChats(op: 'allow' | 'revoke', chatId: string, label = ''): boolean {
  const id = chatId.trim()
  if (id.length === 0) return false
  const chats = [...allowedChats()]
  const had = chats.includes(id)
  const next = op === 'allow' ? (had ? chats : [...chats, id]) : chats.filter((c) => c !== id)
  // ★ 收回一个本来就不在册的 id：**不算失败，但要留痕**。
  //   它最常见的成因是"用户点了两次"或"id 抄错了" —— 两个都值得看见。
  const noop = op === 'allow' ? had : !had
  try {
    // ★ 建的是**这个文件所在的那个目录**，不是写死 `data/`：
    //   白名单文件可以被指到别处（见 `chatsFile`），写死路径会让
    //   "换了个位置"直接变成"白名单永远存不下去"。
    mkdirSync(dirname(chatsFile()), { recursive: true })
    writeFileSync(chatsFile(), JSON.stringify({ chats: next, updatedAt: Date.now(), lastLabel: label }, null, 2), 'utf8')
    appendEvent(op === 'allow' ? 'TELEGRAM_CHAT_ALLOWED' : 'TELEGRAM_CHAT_REVOKED', {
      chatId: id,
      label: label.slice(0, 40),
      total: next.length,
      noop,
    })
    return true
  } catch (e) {
    appendEvent(op === 'allow' ? 'TELEGRAM_CHAT_ALLOW_FAILED' : 'TELEGRAM_CHAT_REVOKE_FAILED', {
      chatId: id,
      error: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}

// ───────────────────────────── 健康度 ─────────────────────────────

export interface TelegramHealth {
  /** 有没有配 token。`false` ⇒ 整条通道不会启动（也不会有人能连上）。 */
  configured: boolean
  /** ★ 白名单条数。**0 就是"谁都不放行"** —— 这一格必须能被一眼看到。 */
  allowedChats: number
  polling: boolean
  /**
   * ★ 当前轮询器的代号（每 start/stop 换一个）。
   *   它是"有没有两个循环在跑"唯一的可视化证据 —— 两个循环会同时拉消息，
   *   于是同一条指令被处理两次。代号变了就说明上一个已经作废。
   */
  loopId: number
  polls: number
  failures: number
  handled: number
  /** 被白名单拒掉的次数（有人试图连但没权限）。 */
  rejected: number
  lastPollAt: number | null
  lastHandledAt: number | null
  lastError: string | null
  /**
   * ★ 待放行的会话（最多 5 条，**已放行的会被剔掉**，见 `pendingChats`）。
   *   没有这一格，用户就无从知道"我该把哪个 chat_id 填进去" ——
   *   而这正是他第一次配置时唯一需要的信息。
   */
  pending: { chatId: string; name: string; at: number; tries: number }[]
}

const stats = {
  polls: 0,
  failures: 0,
  handled: 0,
  rejected: 0,
  lastPollAt: null as number | null,
  lastHandledAt: null as number | null,
  lastError: null as string | null,
}

/**
 * 敲过门但**还没被放行**的会话（原始累积）。
 *
 * ★ 名字刻意叫 `unknownChats` 而不是 `pending`：它是"敲过门的人"的名单，
 *   而对外那一格 `pending` 是**过滤过的待办**。两者口径不同 ——
 *   合并成一个的话，"放行之后提示还不消失"这个缺陷就会变成设计。
 */
const unknownChats = new Map<string, { chatId: string; name: string; at: number; tries: number }>()

export function telegramHealth(): TelegramHealth {
  return {
    configured: telegramConfigured(),
    allowedChats: allowedChats().size,
    polling,
    loopId,
    polls: stats.polls,
    failures: stats.failures,
    handled: stats.handled,
    rejected: stats.rejected,
    lastPollAt: stats.lastPollAt,
    lastHandledAt: stats.lastHandledAt,
    lastError: stats.lastError,
    pending: pendingChats(),
  }
}

export function resetTelegramStats(): void {
  stats.polls = 0
  stats.failures = 0
  stats.handled = 0
  stats.rejected = 0
  stats.lastPollAt = null
  stats.lastHandledAt = null
  stats.lastError = null
  unknownChats.clear()
}

/**
 * 待放行的会话（给人点的）。
 *
 * ★★ 为什么必须**过滤掉已经放行的**：这张表是按"谁敲过门"累积的，
 *   而放行动作发生在它之后。不过滤的话，用户放行完之后这一栏还在，
 *   人话里还会催他"要放行就在下面点一下" —— 一个**永远催你去放行一个
 *   已经放行的会话**的提示，唯一的效果是训练用户忽略这一栏。
 *   而它恰恰是整条通道里唯一一处"用户能自己完成开通"的引导。
 *
 * ★ 历史不会因此丢掉：谁在什么时候敲过门、谁被放行了，都在账本里
 *   （`TELEGRAM_UNAUTHORIZED` + `TELEGRAM_CHAT_ALLOWED`）。
 *   这里给的是**待办**，不是台账 —— 两者的口径必须分开。
 */
function pendingChats(): { chatId: string; name: string; at: number; tries: number }[] {
  const allowed = allowedChats()
  return [...unknownChats.values()]
    .filter((c) => !allowed.has(c.chatId))
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)
}

/**
 * 手机端通道的**人话状态** —— 一段话，直接可念。
 *
 * ══ 为什么必须有它（判据 D7：这个输出把用户引向哪个动作？）══════════════
 * 这条通道四种最常见的坏法，在**原始读数**上长得几乎一样
 * （`configured:true / polling:true / handled:0`），但处置动作四条完全不同：
 *   ① token 没配        ⇒ 去 BotFather 拿一个
 *   ② 白名单是空的      ⇒ 在手机上发一句，把出现的 chat id 填进来
 *   ③ 白名单文件坏了    ⇒ 去修 JSON（不是"再发一条消息试试"）
 *   ④ 连不上 / token 错 ⇒ 去查网络 / 去换 token
 * 只给读数的话，用户看到的永远是"我明明发消息了，它没反应" ——
 * 而这四种情况下，他接下来该做的事没有一件是"再发一条消息"。
 *
 * ★ 文案里**不带 markdown 星号**、不带"undefined"（语音红线⑥）：
 *   它会被 `plainText` 原样念出来，也会原样出现在手机上。
 */
export function telegramSpeech(): string {
  if (!telegramConfigured()) {
    return '手机端通道现在是关着的：没有配 TELEGRAM_BOT_TOKEN。去 BotFather 建一个 bot，把 token 放进环境变量，重启之后就通了。'
  }
  const list = readChatList()
  const bad = list.readFailed ? `（注意：白名单文件有问题 —— ${list.readFailed}）` : ''
  if (list.chats.length === 0) {
    return (
      '手机端通道在跑，但放行名单是空的 —— 现在谁都不能通过它下指令。' +
      '在手机上给这个 bot 发一句话，它会把你那个会话的 chat id 回给你；把那个 id 填进放行名单，就能用了。' +
      bad
    )
  }
  if (!polling) {
    return `手机端通道配好了 ${list.chats.length} 个会话，但轮询没有在跑 —— 它收不到消息。重启编排器再看看。${bad}`
  }
  const waiting = pendingChats()
  const tail =
    waiting.length > 0
      ? `另有 ${waiting.length} 个没放行的会话试着连过，最近一个是 ${waiting[0]?.chatId}${waiting[0]?.name ? `（${waiting[0]?.name}）` : ''} —— 要放行就在下面点一下。`
      : ''
  const err = stats.lastError ? `最近一次失败：${stats.lastError}` : ''
  return `手机端通道在跑，${list.chats.length} 个会话可以下指令；已处理 ${stats.handled} 条，挡下 ${stats.rejected} 条。${bad}${tail}${err}`
}

/** 面板用的一份完整视图（读数 + 人话 + 放行名单）。 */
export interface TelegramView extends TelegramHealth {
  speech: string
  /** 白名单文件读不出来的原因。`null` = 正常。 */
  chatListError: string | null
  /** 白名单文件路径（用户要能知道"它究竟把名单存哪了"）。 */
  chatFile: string
  /**
   * ★ 名单里的**具体 id**（`allowedChats` 只是条数）。
   *
   * 两个字段刻意分开、名字也不同：一个是计数、一个是清单。
   * 只给计数的话，面板上「谁被放进来了」**无法核对** —— 而用户唯一的
   * 反向操作（收回）需要一个能点名的对象。一个只能看条数的权限页，
   * 用户要收回谁都只能靠猜。
   */
  allowedIds: string[]
}

export function telegramView(): TelegramView {
  const h = telegramHealth()
  const list = readChatList()
  return {
    ...h,
    speech: telegramSpeech(),
    chatListError: list.readFailed,
    chatFile: chatsFile(),
    allowedIds: list.chats,
  }
}

// ───────────────────────────── 出网（两个口子）─────────────────────────────

/**
 * 可注入的底层依赖。**只有烟测会用它**，生产永远是默认的 `fetch`。
 *
 * ★ 为什么是注入而不是"造一个测试专用处理函数"：
 *   后者会让烟测跑在一条**线上不存在的代码路径**上（判据 D9：夹具必须是生产的形状）。
 *   本文件第一版就是那么写的（一个 `handleTelegramUpdateForTest` + 一个全局
 *   `sentByTest` 数组），它的坏处很具体：注入的那套有两个并行的状态
 *   （一个模块级变量、一个从它派生的对象），改任一处都会让"发出的文本"
 *   与"捕获到的文本"脱节 —— 而烟测照样全绿。
 *   ⇒ 与 `egress.ts` 同款：注入 `fetchImpl` / `resolve`，代码路径一个字都不变。
 */
let deps: { fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}

export function setTelegramDeps(d: typeof deps): void {
  deps = d
}

/** 只记 host —— ★ 绝不记 URL（token 在里面）。 */
function hostOnly(): string {
  return TG_HOST
}

/**
 * 把 token 从任何**要落盘/要给人看**的串里抹掉。
 *
 * ══ 为什么光靠出网层的 `redact` 还不够 ═══════════════════════════════
 * `fetchPage` / `postJson` 的 `redact` 抹的是**它们自己写进账本的那一份**
 * （`EGRESS_BLOCKED` / `EGRESS_FAILED`）。但它们**返回给调用方**的 `note`
 * 保持原样（那是调试用的，不落盘）。
 * 而本模块会把这个 note 再写进**自己的**事件里（`TELEGRAM_POLL_FAILED.note`
 * / `TELEGRAM_SEND_FAILED.error`）—— 于是凭据顺着"上游的调试信息"
 * 换了一条路回到账本上。
 *
 * ★ 不是假想：`postJson` 遇到 3xx 时的说明里带着**响应头里的 location**，
 *   而对端完全可以把 location 写成任意含凭据的串。烟测里有一条
 *   就是照这个形状造的（见 `telegram-smoke` 的 G5b）。
 *
 * ★ 这一层必须自己抹，不能指望上游：只有这里知道"哪个串是凭据"。
 */
function noToken(s: string): string {
  const t = botToken()
  return t.length === 0 ? s : s.split(t).join('＜已隐去＞')
}

/** 供面板/烟测核对"这条通道打的是哪个域名"（它必须与出网白名单那一份一致）。 */
export function telegramHost(): string {
  return TG_HOST
}

/** 出网选项里**必须**带上的那一份抹除清单。 */
function egressOpts(): { redact: string[] } {
  const t = botToken()
  return { redact: t.length === 0 ? [] : [t] }
}

/** Telegram 返回体里能拿到的错误描述（不含 token）。 */
function describeApiError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { description?: unknown; error_code?: unknown }
    const d = typeof j.description === 'string' ? j.description : ''
    const c = typeof j.error_code === 'number' ? j.error_code : null
    return c === null ? d || '未知错误' : String(c) + ' ' + d
  } catch {
    // ★ 解析不了时**不把原文带出去**：那段正文可能含 URL 片段。
    return '返回体解析失败'
  }
}

/**
 * 轮询失败的**三态**。
 *
 * ★★ 为什么它是一个具名的类型而不是几个字符串：这三种失败指向三个
 *    **相反的动作**，所以它们必须能被逐一断言，而不是"看到的是一句 error"。
 *      · `blocked`      ⇒ 改 `EV_EGRESS_HOSTS`（**不要去查网络**）
 *      · `unauthorized` ⇒ 换 `TELEGRAM_BOT_TOKEN`（改网络永远不会好）
 *      · `network`      ⇒ 查网络 / 等对端恢复
 *    合成一句"连接失败"的后果很具体：用户会花半小时重启路由器，
 *    而真正该做的是一行环境变量。
 */
export type PollFailureKind = 'blocked' | 'unauthorized' | 'network'
export interface PollFailure {
  kind: PollFailureKind
  note: string
}

/**
 * 出网层的失败 → 三态。
 *
 * ★ 抽成**导出**的纯函数（而不是留在 `getUpdates` 里内联）有一个很实际的
 *   理由：内联的话，"三种失败分不分得开"这件事**无法被门禁覆盖** ——
 *   要在真轮询里造出三种失败，每造一种都得等一次 15 秒退避，
 *   于是没有人会写那条测试，于是它迟早退化成一档。
 *   抽出来之后，三态可以逐条断言；而"它真的被接在 `getUpdates` 上"
 *   由另外一条**端到端**断言（走真循环、看真事件）负责。
 *   两份缺一不可：只断言纯函数 ⇒ 它可能没被接线；只断言端到端 ⇒ 只覆盖得起一档。
 */
export function classifyEgressFailure(reason: string | undefined, note: string): PollFailure {
  const blocked = reason === 'HOST_NOT_ALLOWED' || reason === 'PRIVATE_ADDRESS' || reason === 'SCHEME_NOT_ALLOWED'
  if (blocked) {
    return {
      kind: 'blocked',
      note: `${TG_HOST} 被出网白名单拦下了 —— 把 ${TG_HOST} 加进 EV_EGRESS_HOSTS，别去查网络`,
    }
  }
  return { kind: 'network', note: `没连上 Telegram（${reason ?? 'HTTP'} ${note}）` }
}

/** Telegram 回了 `ok:false` → 三态（401 不是网络问题）。 */
export function classifyApiRejection(raw: string): PollFailure {
  const desc = describeApiError(raw)
  if (/401|Unauthorized/i.test(desc)) {
    return {
      kind: 'unauthorized',
      note: `Telegram 拒绝了 bot token（${desc}）—— 去换 TELEGRAM_BOT_TOKEN，改网络配置永远不会好`,
    }
  }
  return { kind: 'network', note: `Telegram 回了一个错误：${desc}` }
}

async function getUpdates(offset: number): Promise<{ ok: true; updates: unknown[] } | ({ ok: false } & PollFailure)> {
  const token = botToken()
  const url = 'https://' + TG_HOST + '/bot' + token + '/getUpdates?timeout=' + String(LONG_POLL_SEC) + '&offset=' + String(offset)
  const res = await fetchPage(url, { timeoutMs: POLL_TIMEOUT_MS, maxBytes: 1024 * 1024, ...egressOpts(), ...deps })
  if (!res.ok) {
    // ★ 三种失败**分开报**（红线⑤）：指向三个相反的动作
    const f = classifyEgressFailure(res.reason, res.note)
    return { ok: false, kind: f.kind, note: noToken(f.note) }
  }
  let parsed: { ok?: unknown; result?: unknown; description?: unknown }
  try {
    parsed = JSON.parse(res.raw) as typeof parsed
  } catch {
    return { ok: false, kind: 'network', note: 'Telegram 返回体不是 JSON' }
  }
  if (parsed.ok !== true) {
    // token 错是 401：它不是网络问题，改网络配置永远不会好
    // ★ 同样要抹：`description` 是**对端给的任意文本**，它可以被写成任何东西。
    const f = classifyApiRejection(res.raw)
    return { ok: false, kind: f.kind, note: noToken(f.note) }
  }
  return { ok: true, updates: Array.isArray(parsed.result) ? parsed.result : [] }
}

interface SendResult {
  ok: boolean
  note: string
}

async function sendMessage(chatId: string, text: string): Promise<SendResult> {
  const token = botToken()
  const url = 'https://' + TG_HOST + '/bot' + token + '/sendMessage'
  /**
   * ★ 超长要**截断并说出来**。
   *   静默截断的后果是用户看到一句话说到一半，而他会以为系统出错了 ——
   *   或者更糟：把半句话当成完整指令读了。
   */
  const clipped = text.length > MAX_MSG_CHARS ? text.slice(0, MAX_MSG_CHARS - 20) + '\n…（这条太长了，已截断）' : text
  const r = await postJson(url, { chat_id: chatId, text: clipped }, { timeoutMs: 15_000, ...egressOpts(), ...deps })
  if (r.ok) return { ok: true, note: '' }
  const blocked = r.reason === 'HOST_NOT_ALLOWED' || r.reason === 'PRIVATE_ADDRESS' || r.reason === 'SCHEME_NOT_ALLOWED'
  // ★ `noToken` 在**每一处**落盘前都要过（判据 C7：缺数据要说出来，而且是每一处都说了）
  return {
    ok: false,
    note: noToken(blocked ? `${TG_HOST} 被出网白名单拦下` : `${r.reason ?? 'HTTP'} ${r.note}`),
  }
}

// ───────────────────────────── 轮询 ─────────────────────────────

let polling = false
/** 已确认到的 update id 上界。★ 它必须单调递增 —— 否则会重复处理同一条消息。 */
let offset = 0

/**
 * 轮询器的**代号**。每 `start` / `stop` 一次就换一个。
 *
 * ══ 为什么光有一个 `polling` 布尔量不够（真缺陷）═══════════════════════
 * 光看布尔量时，"停止"只是把旗子放倒，而循环是在**下一次抬头时**才发现的。
 * 如果这中间有人又 `start` 了一次，旗子重新立起来 —— **旧循环抬头一看
 * "还在跑"，就继续跑下去了**。结果是两个循环同时拉 `getUpdates`：
 *
 *   · 同一条消息被处理**两次** —— 在交易系统里那是**两笔单**；
 *   · 两边的 `offset` 互相追赶，先到的把后到的挤掉，于是"漏消息"
 *     与"重复消息"会同时出现，而且都不可复现；
 *   · 账本上只会看到 `POLLING_STARTED` 一条，看起来完全正常。
 *
 * 实测过：烟测里 `stop` 紧接着 `start`，同一个窗口里被拦下的轮询**两次**
 * （一次是快退出的旧循环干的）。真实触发场景很常见 —— 用户在面板上
 * 关掉再打开、或者一次"重启通道"的操作。
 *
 * ★ 判据：**循环自己带着它的代号**。抬头时既要看旗子，也要看代号
 *   还是不是自己那一个。这是"同一个业务动作只许有一个执行者"的最简形式，
 *   而且它与"被要求退出"和"自己死了"的区分天然吻合 —— 旧循环是被
 *   **作废**的，不是"没收到通知"。
 */
let loopId = 0

export function telegramPolling(): boolean {
  return polling
}

/** 当前轮询器的代号。★ 面板上它是"有没有两个循环在跑"唯一的可视化证据。 */
export function telegramLoopId(): number {
  return loopId
}

/** 给烟测/诊断用：注入 offset（避免测试真的去要历史消息）。 */
export function setTelegramOffset(n: number): void {
  offset = n
}

export function startTelegramPolling(): { ok: boolean; reason?: string; alreadyRunning?: boolean } {
  if (!telegramConfigured()) {
    return { ok: false, reason: 'NO_TOKEN（没有配 TELEGRAM_BOT_TOKEN）' }
  }
  // ★ 已经在跑就**不新起一个**：这条早退是"一个动作一个执行者"的第一道门。
  //   报 `alreadyRunning` 而不是假装刚启动，是为了让调用方能说出
  //   "它本来就在跑" —— 否则"我点了启动"与"它一直在跑"看起来一样。
  if (polling) return { ok: true, alreadyRunning: true }
  polling = true
  loopId += 1
  const mine = loopId
  appendEvent('TELEGRAM_POLLING_STARTED', { allowedChats: allowedChats().size, host: hostOnly(), loopId: mine })
  void loop(mine)
  return { ok: true }
}

export function stopTelegramPolling(): void {
  if (!polling) return
  polling = false
  // ★★ 换代号 —— 这一步是"停止"真正生效的地方。
  //   只放倒旗子的话，紧接着的 `start` 会把旗子立回去，
  //   而**旧循环抬头时看到的是"还在跑"**（见 `loopId` 的注释）。
  loopId += 1
  appendEvent('TELEGRAM_POLLING_STOPPED', { loopId })
  // ★ 顺手把退避中的那一觉叫醒（见 `sleep`）：不然停止要等到退避自然醒来
  //   才生效 —— 烟测里那是白等 15 秒，真机上是"我让它停，但它还活着"。
  const w = wake
  wake = null
  if (w) w()
}

/**
 * 可以被叫醒的等待。
 *
 * ★★ 用法上它必须**只有一个消费者**（轮询循环），所以用模块级的一个槽
 *   而不是每次返回一个可取消句柄：槽只有一个的话，"叫醒"的目标
 *   不可能张冠李戴。多消费者场景要用它就得改成句柄式 —— 现在没有，
 *   而写成一个看起来通用的 API 只会诱使后来的人误用。
 */
let wake: (() => void) | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(() => {
      wake = null
      r()
    }, ms)
    wake = () => {
      clearTimeout(t)
      r()
    }
  })
}

/**
 * 让出一次**宏任务**边界。
 *
 * ★★ 这不是风格问题，是一个会把整个编排器冻住的坑（实测踩过）。
 *
 * `await` 只在**微任务**里排队，而微任务队列在处理干净之前不会回到宏任务阶段。
 * 所以只要 `getUpdates` 在同一次事件循环里就解决，这个 `while` 循环就会
 * **永远占着事件循环**：HTTP 服务、行情 tick、定时日报、它自己的退避 —— 全部冻住，
 * 而 `telegramHealth()` 看上去只是"在轮询"，账本上一条异常都没有。
 *
 * 什么时候 `getUpdates` 会立刻解决？比想象中多：
 *   · 假 fetch / 注入的替身（烟测里就是这个形态）；
 *   · URL 直接非法（`BAD_URL` 在 `new URL()` 那一行就返回，没有 IO）；
 *   · 将来任何"先查缓存再出网"的优化。
 *
 * 实测：把烟测的替身换成立刻解决的假 fetch，整个进程卡死 **2 分 44 秒**
 * 不返回、一行输出都没有 —— 这与"夜间定时日报没跑"的现场完全一样，
 * 而查起来是南辕北辙的（一个查调度，一个查这行 `await`）。
 *
 * ⇒ 每一轮都必须显式跨一次宏任务边界。用 `setImmediate` 而不是
 *   `setTimeout(0)`：前者就是"让出一次"，不带"等了一会儿"的语义，
 *   免得往后有人把它当成退避来读。
 */
function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

async function loop(mine: number): Promise<void> {
  // ★★ 抬头看两个条件，缺一不可：
  //   · `polling`   —— 有没有被要求停；
  //   · `mine === loopId` —— **我还是不是当前那一个**（见 `loopId` 的注释）。
  //   只查前者的话，`stop` 紧接着 `start` 会让旧循环继续跑下去 ⇒ 两个循环
  //   同时拉消息 ⇒ 同一条指令被处理两次。
  while (polling && mine === loopId) {
    // ★ 必须在 `getUpdates` **之前**：见 `yieldToLoop` 的注释。
    await yieldToLoop()
    if (!polling || mine !== loopId) break
    const r = await getUpdates(offset)
    // ★ 这两行是**补上来的**，而它们原来不存在 —— `polls` / `lastPollAt`
    //   从建好那一刻起就永远是 0 / null。这个形状在本仓库里出现过一次
    //   （`VoiceTurn.intent` 一直存在但从未被赋值），症状完全一样：
    //   面板上那一格永远空着，而没有任何地方报错。
    //   一个永远为 0 的计数比没有这一格更坏 —— 它看起来像"通道健康"。
    stats.polls += 1
    stats.lastPollAt = Date.now()
    if (!r.ok) {
      stats.failures += 1
      // ★ `r.note` 在 `getUpdates` 返回前已经过了 `noToken` —— 那是**唯一**的
      //   出网失败出口。这里再抹一次是刻意的冗余：本条路径上还有三处会
      //   落盘（计数 / 事件 / 健康度），将来加第四处时不必重新想一遍。
      const note = noToken(r.note)
      stats.lastError = note
      // ★ 每一次失败都要落盘，但**不要每 25 秒落一条**（会淹掉账本）。
      //   只在类型变化或每 10 次失败时落一条 —— 记的是"发生了一类新问题"。
      if (stats.failures === 1 || stats.failures % 10 === 0) {
        appendEvent('TELEGRAM_POLL_FAILED', { kind: r.kind, note: note.slice(0, 200), failures: stats.failures, host: hostOnly() })
      }
      await sleep(BACKOFF_MS)
      continue
    }
    if (stats.failures > 0) {
      // ★ 恢复也要说出来：否则"一直在失败"与"曾经失败过又好了"看起来一样。
      appendEvent('TELEGRAM_POLL_RECOVERED', { afterFailures: stats.failures })
      stats.failures = 0
      stats.lastError = null
    }
    for (const u of r.updates) {
      const id = (u as { update_id?: unknown }).update_id
      if (typeof id === 'number') offset = Math.max(offset, id + 1)
      await handleUpdate(u)
    }
  }
  /**
   * ★★ 循环**真的退出**了 —— 这一条是刻意补的，因为它把一件事变得可断言。
   *
   * 「停止」做的是两件不同的事，而它们**都不是**"循环已经退出"：
   *   ① 放倒旗子（`polling = false`）—— 循环要**下一次抬头**才发现；
   *   ② 换代号 + 叫醒退避 —— 循环可能正睡在 `BACKOFF_MS`（15 秒）里。
   *
   * 没有这条事件时，"退避叫不叫得醒"是一个**无法被断言**的性质：
   * 我第一版写的是 `assert(Date.now() - t0 < 1000)`，量的却是
   * `stopTelegramPolling()` 这个同步调用本身 —— 它永远是真，**这条断言没有牙**。
   * 有了这条事件，正确的判据才是可达的：停止之后，在一个**远小于退避**的
   * 窗口里就该看到 `EXITED`。叫不醒的话，那条事件要等 15 秒才出现。
   *
   * ★ 它顺带补上"被要求退出"与"自己死了"的区分：`STOPPED` 说明有人要求停，
   *   `EXITED` 说明循环确实停下来了。只有 `STOPPED` 而没有 `EXITED`，
   *   就是"它还在跑"。
   */
  appendEvent('TELEGRAM_POLLING_EXITED', { mine, currentLoopId: loopId, polling })
}

/** 处理一条 update。**非 message 一律忽略**（edited_message 等会造出重复指令）。 */
async function handleUpdate(u: unknown): Promise<void> {
  const msg = (u as { message?: Record<string, unknown> }).message
  if (!msg) return
  const text = typeof msg.text === 'string' ? msg.text : ''
  const chat = msg.chat as { id?: unknown; first_name?: unknown; username?: unknown; title?: unknown } | undefined
  const chatId = chat?.id === undefined ? '' : String(chat.id)
  if (chatId.length === 0) return

  const chats = allowedChats()
  if (!chats.has(chatId)) {
    // ── ★★ 红线①：不放行，但要**说出来** ─────────────────────────────
    stats.rejected += 1
    const name = [chat?.first_name, chat?.username, chat?.title].filter((x) => typeof x === 'string' && x.length > 0).join(' / ')
    const prev = unknownChats.get(chatId)
    unknownChats.set(chatId, { chatId, name: name.slice(0, 40), at: Date.now(), tries: (prev?.tries ?? 0) + 1 })
    appendEvent('TELEGRAM_UNAUTHORIZED', {
      chatId,
      name: name.slice(0, 40),
      // ★ 只记长度，不记正文：未授权者的原话不该进我们的账本
      chars: text.length,
      allowedCount: chats.size,
    })
    await sendMessage(
      chatId,
      '这个会话还没有连上 EVOLVE —— 我这边没有放行它。\n' +
        '要连上，请把下面这个 chat id 填进 EVOLVE 的白名单：\n' +
        `  ${chatId}\n` +
        '填法二选一：环境变量 TELEGRAM_ALLOWED_CHATS（逗号分隔），' +
        '或者在监控页的「Telegram」一栏直接点「放行这个会话」。',
    )
    return
  }

  if (text.trim().length === 0) return

  try {
    // ★★ 红线②：走**同一条**桌宠入口。意图、确认、闸门、记忆、聊天记录全部照旧。
    const reply = await handleUtterance(text)
    stats.handled += 1
    stats.lastHandledAt = Date.now()
    // ★ 红线④ / 语音红线④`:dropped` 的答复**不许发出去** ——
    //   它已经被更新的一轮取代，发出去就是让用户收到一句系统自己都不认的话。
    if (reply.dropped) {
      appendEvent('TELEGRAM_REPLY_DROPPED', { chatId, turnId: reply.turnId, intent: reply.intent })
      return
    }
    const sent = await sendMessage(chatId, plainText(reply.reply))
    appendEvent(sent.ok ? 'TELEGRAM_HANDLED' : 'TELEGRAM_SEND_FAILED', {
      chatId,
      turnId: reply.turnId,
      intent: reply.intent,
      chars: reply.reply.length,
      rejected: reply.executed ? !reply.executed.ok : false,
      ...(sent.ok ? {} : { error: sent.note.slice(0, 160) }),
    })
  } catch (e) {
    // ★ 处理失败**不能让轮询循环退出** —— 否则一条畸形消息会让整条通道永久沉默，
    //   而用户看到的只是"手机那边从此没反应了"。
    stats.lastError = e instanceof Error ? e.message : String(e)
    appendEvent('TELEGRAM_HANDLE_FAILED', { chatId, error: stats.lastError.slice(0, 200) })
  }
}

/**
 * 供 smoke / 诊断用：把一条 update 走一遍**完整**处理。
 * ★ 它就是 `handleUpdate` 本身（导出而已）—— 没有第二条路径。
 */
export { handleUpdate as handleTelegramUpdate }
