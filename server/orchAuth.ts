/**
 * 编排层 / 账本层的**鉴权判据**。只有这一份。
 *
 * ══ 为什么它值得单独一个文件 ═══════════════════════════════════════════
 *   这条规矩原来在**两个**服务里各写了一遍（`server/index.ts` 与
 *   `server/ledgerServer.ts`，连 `authorized()` 的函数体都逐字相同），
 *   而默认令牌那个字符串在仓库里出现了**四次**。
 *   于是"改一处"永远等于"漏一处" —— 判据 ⑯ 说的就是这个形态。
 *
 * ══ 它挡的是什么（这条规矩的来历） ═════════════════════════════════════
 *   `httpServer.listen(PORT)` 不带 host ⇒ 监听**所有网卡**。
 *   前端与编排层默认用的令牌是一个**公开常量**（写在源码里，谁 grep 一次就有），
 *   CORS 又默认 `*`。两者叠起来的后果是：
 *
 *     同一个 WiFi 下的任何人 → 带着那个常量调 `/orders` 出单
 *       → 或者调 `/voice/telegram/allow` 把**自己的** Telegram 会话放行成主人
 *       → 那一步之后，他从世界任何地方都能下指令，而本机只留下一条"有人被放行"。
 *
 *   也就是"局域网暴露"会**升级成永久性远程控制**。所以这两件事不许同时成立：
 *   **能被别的设备访问** 与 **用着公开默认口令**。
 *
 * ══ 这条规矩管什么、不管什么 ══════════════════════════════════════════
 *   管：**监听了之后放谁进来**。
 *   不管：**要不要监听所有网卡**（那是 `scripts/app.ts` 的 `EVOLVE_REMOTE`，
 *         以及 `stackCore.ts` 里给 vite 加不加 `--host`）。
 *   两者缺一不可：少了这一条，那个开关忘了关就是门户大开；
 *   少了那个开关，用户又没法从手机看面板。
 *
 * ★ 本文件**不 import 任何东西**（连 `node:` 都不需要）——
 *   这样被监管的服务 import 它不会顺带把监管代码（`child_process` 那一套）
 *   拖进去（见 `server/serviceIdentity.ts` 顶部那段说明的同一个理由）。
 */

/**
 * 公开的默认令牌。**它不是密钥** —— 它写在本文件里、写在 `.env.example` 的注释里，
 * 任何人都能读到。存在的意义只是"让本机开发不必先配令牌"。
 */
export const INSECURE_DEFAULT_TOKEN = 'dev-insecure-token'

/**
 * 这个来源地址是不是**本机**。
 *
 * ★ `::ffff:127.0.0.1` 是 IPv4 回环在双栈 socket 上的样子，必须一起认；
 *   `127.` 整个网段与 `::1` 同理。
 * ★ 认漏了的后果是**误报**：把本机请求挡在外面，面板一片 401。
 *   误报比漏报贵（判据 A1），所以这里刻意宽一点。
 * ★ 认多了的后果也只是"本机地址被当成可信"，而那本来就是它的语义。
 */
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (typeof addr !== 'string' || addr.length === 0) return false
  const s = addr.trim().toLowerCase()
  return s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.')
}

/** 为什么放行 / 为什么拒绝。**四态互不顶替** —— 它们指向不同的下一步动作。 */
export type AuthzReason =
  /** 令牌对，来源也允许。 */
  | 'ok'
  /** 令牌不对（或根本没带）⇒ 用户要去核对自己那把令牌。 */
  | 'token-mismatch'
  /**
   * 令牌**对**，但它就是那个公开默认值，而请求来自**别的设备** ⇒ 已拒绝。
   * ★ 这一档必须能与上一档分开：它们的处置完全相反 ——
   *   一个要"去改 .env 里的 ORCH_TOKEN 并重启"，另一个要"把令牌抄对"。
   *   合成一档的后果是用户拿着 401 去反复核对一串本来就没错的字符。
   */
  | 'insecure-remote'

export interface AuthzDecision {
  ok: boolean
  reason: AuthzReason
}

/**
 * 谁能通过它下指令。**判据只有这一条**，所有端点共用它的结果。
 *
 * ★ `presented` 故意收 `string | string[] | undefined` 并**不做数组展开**：
 *   原来那几处写的是 `req.headers['x-orch-token'] === TOKEN`，
 *   而同一个头出现两次时 Node 会给一个数组 —— 恒不等于字符串。
 *   展开成 `arr[0]` 会**悄悄放宽**这条判据（攻击者只要发两次头就有一个被采纳），
 *   所以这里保持严格相等，行为和改动前逐字一致。
 */
export function decideAuth(params: {
  /** 服务自己认的那一个令牌。 */
  token: string
  /** 请求带上来的那一个（原始 header 值，不展开）。 */
  presented: string | string[] | undefined
  /** `req.socket.remoteAddress`。 */
  remoteAddress: string | undefined
}): AuthzDecision {
  const { token, presented, remoteAddress } = params
  if (presented !== token) return { ok: false, reason: 'token-mismatch' }
  if (token !== INSECURE_DEFAULT_TOKEN) return { ok: true, reason: 'ok' }
  if (isLoopbackAddr(remoteAddress)) return { ok: true, reason: 'ok' }
  return { ok: false, reason: 'insecure-remote' }
}

/** 给用户看的下一步（拒绝时用）。每一档指向**不同的动作**。 */
export function authzHint(reason: AuthzReason): string | null {
  if (reason === 'insecure-remote') {
    return (
      '这台机器正在用公开的默认令牌，而这个请求来自非本机地址 ⇒ 已拒绝。' +
      '要开局域网（手机访问），请在 .env 里把 ORCH_TOKEN 设成一个只有你知道的随机串，然后重启编排层。'
    )
  }
  return null
}

/**
 * 把判据**接到**一个"出事了要喊一声"的回调上。
 *
 * ══ 为什么这段编排也住在判据文件里（而不是留在 `index.ts` 里）══════════
 *   它原来写在 `index.ts` 的 `authorized()` 函数体里。于是"接线可达"这件事
 *   只能用**读源码**去验，而读源码在这一点上恰好没有牙：把那一行写成
 *   `if (false) noteInsecureRemoteOnce(...)` —— 字符串还在、断言照样绿，
 *   而线上再也不会有人被记下来。要让它能被**行为**验，就必须让"判定 → 告知"
 *   这条因果住在一个能 import 的单元里。
 *
 * ★ 语义：只在 `insecure-remote` 那一档喊。另外两档**不喊** ——
 *   `ok` 是正常流量（喊一次就能把账本刷满），`token-mismatch` 是用户自己打错了
 *   令牌（那是他的事，不是安全事件）。
 */
export function createAuthGate(opts: {
  token: string
  /** 有人带着公开默认令牌从别的设备来敲门时叫一次。**每个请求叫一次**，去重是它的事。 */
  onInsecureRemote: (remoteAddress: string | undefined) => void
}): (presented: string | string[] | undefined, remoteAddress: string | undefined) => boolean {
  return (presented, remoteAddress) => {
    const d = decideAuth({ token: opts.token, presented, remoteAddress })
    if (d.reason === 'insecure-remote') opts.onInsecureRemote(remoteAddress)
    return d.ok
  }
}

/**
 * 把上面的告知收成**有界**的一份：每个来源地址只记一次。
 *
 * ══ 为什么必须有界 ═════════════════════════════════════════════════════
 *   `authorized()` 是**每个请求**都会跑的。不记去重的话，一次端口扫描
 *   就能把账本写成几万行 —— 而账本是审计链的载体，把真正的事件挤出去之后，
 *   事后没人能重建"当时到底发生了什么"。攻击者甚至不必登录，
 *   只要反复敲门就能做到这件事。
 *
 * ★ `max` 到了就不再收新来源。代价说清楚：**第 max+1 个来源不会留下记录**。
 *   取值远大于"一台家用路由器底下的设备数"，真被触发本身就说明有人在扫；
 *   此时账本里已经有 max 条不同来源的记录，事件不会被漏掉。
 */
export function createDedupedNotifier(opts: {
  emit: (key: string) => void
  max: number
}): (remoteAddress: string | undefined) => void {
  const seen = new Set<string>()
  return (remoteAddress) => {
    const key = remoteAddress ?? 'unknown'
    if (seen.has(key)) return
    if (seen.size >= opts.max) return
    seen.add(key)
    opts.emit(key)
  }
}
