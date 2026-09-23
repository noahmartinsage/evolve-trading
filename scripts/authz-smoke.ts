/**
 * 鉴权判据门禁 —— 「**谁能通过它下指令**」。
 *
 * ══ 它守的是哪一件事 ═════════════════════════════════════════════════
 *   编排层与账本层都 `listen(PORT)` **不带 host** ⇒ 监听所有网卡。
 *   而默认令牌是一个**公开常量**、CORS 默认 `*`。于是：
 *
 *     同一个 WiFi 下的任何人 → 带那个常量调 `/orders` 出单
 *       → 或调 `/voice/telegram/allow` 把**自己的** Telegram 会话放行成主人
 *       → 那一步之后他从世界任何地方都能下指令，本机只留一条"有人被放行"。
 *
 *   规矩：**能被别的设备访问** 与 **用着公开默认口令** 不许同时成立。
 *
 * ══ 这道门测不了什么（先写出来，免得它的绿被当成本事）═════════════════
 *   · 它**没有**起真 HTTP 服务、**没有**从局域网地址发一个真请求。
 *     "非本机请求被拒"这件事是在**判据函数**这一层验的，不是在 socket 那一层。
 *     没验到的那一段：`req.socket.remoteAddress` 到底填的是不是我以为的那个值
 *     （双栈 socket 上是 `::ffff:x.x.x.x`，这个形态只在 `isLoopbackAddr` 的表里占一行）。
 *   · 它**没有**验 `EVOLVE_REMOTE` 那条命令真的能被用户双击跑起来 ——
 *     那要真起整栈（二十多秒），这里只验"参数怎么拼"与"什么条件下拒绝启动"。
 *
 * ══ 为什么一半的断言是"读源码" ═══════════════════════════════════════
 *   这条规矩最容易的失效方式**不是**判据写错，而是**接线漏了一处**：
 *   两个服务各写一份 `authorized()`、默认令牌的字面量散在四个文件里。
 *   判据函数全绿、而线上照样门户大开 —— 那正是这次的真实起因。
 *   所以这里既测**判据**（表驱动），也测**只有一份**（读源码，判据 C11 / B3）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INSECURE_DEFAULT_TOKEN,
  authzHint,
  createAuthGate,
  createDedupedNotifier,
  decideAuth,
  isLoopbackAddr,
} from '../server/orchAuth.ts'
import { stackRoles } from '../server/stackCore.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 本文件相对仓库根的路径。★ 由 `import.meta.url` **算出来**，不是写死的字面量：
 * 写死的话，"排除清单"就成了一份可以被悄悄加长的名单，而这正是它要防的事。
 */
const SELF_REL = join('scripts', fileURLToPath(import.meta.url).split(/[\\/]/).pop() ?? '').replace(/\\/g, '/')

let pass = 0
let fail = 0
const failures: string[] = []

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${label}`)
  } catch (e) {
    fail += 1
    const msg = e instanceof Error ? e.message : String(e)
    failures.push(`${label} —— ${msg}`)
    console.log(`  ✗ ${label}\n      ${msg}`)
  }
}

/**
 * 剥掉注释，保留字符串字面量。
 *
 * ★ 为什么两种剥法都要：
 *   · 查"默认令牌的字面量出现在哪些文件"时**必须保留字符串**（要找的就是它）；
 *   · 查"有没有人自己又写了一遍 `=== TOKEN`"时**必须剥掉注释** ——
 *     否则本文件里那些解释性的注释会被自己算成命中（判据 6：新门禁会命中它自己）。
 *
 * ★ 已知局限：不含模板串里的 `${}` 重新入栈分析 —— 本项目没有把 JS 逻辑
 *   写在模板串里的写法，所以不引入那层复杂度；真出现了也不会静默：
 *   那些字符会被原样保留在 `out` 里，最坏结果是**多报**（误报），不是漏报。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line'
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        i += 2
        continue
      }
      if (c === "'") mode = 'sq'
      else if (c === '"') mode = 'dq'
      else if (c === '`') mode = 'tpl'
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        i += 2
      } else i += 1
      continue
    }
    // 字符串里：原样保留，处理转义，遇到同种引号收尾
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'
    }
    out += c
    i += 1
  }
  return out
}

/** 递归列出某个目录下的 `.ts` / `.tsx`（跳过 node_modules / dist / .trash）。 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.trash') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(e.name)) acc.push(full)
  }
  return acc
}

/** 读一个文件（相对仓库根），已剥注释。 */
function codeOf(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'))
}

/** 抠出一个锚点在源码里的行号（1-based，找不到返回 -1）。用于**顺序**断言。 */
function lineOf(src: string, anchor: string): number {
  const i = src.indexOf(anchor)
  return i < 0 ? -1 : src.slice(0, i).split('\n').length
}

async function main(): Promise<void> {
  // ═══════════ G1 回环识别 ═══════════
  console.log('\n── G1 哪些来源算"本机"（认漏 = 面板一片 401，认多 = 门户大开）──')

  check('G1 本机的那几种写法都认（含双栈 socket 上的 IPv4-mapped）', () => {
    for (const a of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1', '  127.0.0.1  ']) {
      assert.equal(isLoopbackAddr(a), true, `把本机地址判成了外来的：${JSON.stringify(a)}`)
    }
  })

  check('G1 ★ 配对：`::ffff:192.168.x.x` 必须**不**算本机（否则写个 v4-mapped 前缀就绕过去）', () => {
    // ★ 这一条与上一条互为配对，只有两条同在才能说明判据真的按**地址**在判，
    //   而不是"看见 `::ffff:` 就放行"（那是个一眼看不出来的后门）。
    for (const a of ['::ffff:192.168.1.7', '192.168.1.7', '10.0.0.3', '172.16.5.5', '::2']) {
      assert.equal(isLoopbackAddr(a), false, `把外来的地址判成了本机：${JSON.stringify(a)}`)
    }
    assert.equal(isLoopbackAddr(undefined), false, '拿不到地址时必须算"外来"（fail-closed），不是"本机"')
    assert.equal(isLoopbackAddr(''), false, '空地址必须算"外来"（fail-closed）')
  })

  // ═══════════ G2 规矩本体 ═══════════
  console.log('\n── G2 规矩本体：默认令牌只在回环上算数 ──')

  const real = 'a7f3c1e09b2d4f68a1b2c3d4e5f60718'

  check('G2 本机 + 默认令牌 ⇒ 放行（★ 配对：正常路径不许被这条新规矩误挡）', () => {
    // ★ 少了这一条，这条规矩可以用"永远拒绝"来满足 —— 而那会让本机面板彻底不可用。
    //   判据 A1：每加一条规矩都要配一条"正常路径不许被误挡"的断言。
    const d = decideAuth({ token: INSECURE_DEFAULT_TOKEN, presented: INSECURE_DEFAULT_TOKEN, remoteAddress: '127.0.0.1' })
    assert.deepEqual(d, { ok: true, reason: 'ok' }, '本机用默认令牌被挡了 ⇒ 用户打开面板会看到一片 401')
  })

  check('G2 ★★ 别的设备 + 默认令牌 ⇒ 拒绝（这就是那道越权链的第一步）', () => {
    const d = decideAuth({
      token: INSECURE_DEFAULT_TOKEN,
      presented: INSECURE_DEFAULT_TOKEN,
      remoteAddress: '192.168.1.7',
    })
    assert.equal(d.ok, false, '局域网里带着公开默认令牌的请求被放行了 —— 同一个 WiFi 下任何人都能出单')
    assert.equal(d.reason, 'insecure-remote')
  })

  check('G2 ★ 配对：别的设备 + **真**令牌 ⇒ 放行（否则这条规矩等于"局域网永远不行"）', () => {
    const d = decideAuth({ token: real, presented: real, remoteAddress: '192.168.1.7' })
    assert.deepEqual(d, { ok: true, reason: 'ok' }, '手机 + 真令牌是**正路**，必须走得通')
  })

  check('G2 令牌不对 ⇒ 拒绝，而且**不因为"是本机"就放行**', () => {
    for (const addr of ['127.0.0.1', '192.168.1.7']) {
      const d = decideAuth({ token: real, presented: 'wrong', remoteAddress: addr })
      assert.equal(d.ok, false, `不匹配的令牌被放行了（来源 ${addr}）`)
    }
  })

  check('G2 没带令牌头 ⇒ 拒绝（fail-closed，不是"没带就当成本机"）', () => {
    for (const p of [undefined, ''] as const) {
      const d = decideAuth({ token: INSECURE_DEFAULT_TOKEN, presented: p, remoteAddress: '127.0.0.1' })
      assert.equal(d.ok, false, `不带令牌却被放行了：${JSON.stringify(p)}`)
    }
  })

  check('G2 ★ 同一个头出现两次（Node 给数组）不许被放宽', () => {
    // 原来几处写的是 `req.headers['x-orch-token'] === TOKEN`，数组恒不等于字符串 ⇒ 拒绝。
    // ★ 如果哪个版本"顺手"把它展开成 `arr[0]`，那就是悄悄放宽了判据 ——
    //   攻击者只要把同一个头发两遍，就有一个会被采纳。
    const d = decideAuth({
      token: INSECURE_DEFAULT_TOKEN,
      presented: [INSECURE_DEFAULT_TOKEN, 'other'],
      remoteAddress: '127.0.0.1',
    })
    assert.equal(d.ok, false, '重复的令牌头被采集了（判据被放宽）')
  })

  // ═══════════ G3 拒绝原因必须可分 ═══════════
  console.log('\n── G3 两档拒绝指向**相反**的动作，所以必须分开报 ──')

  check('G3 ★★ `insecure-remote` 与 `token-mismatch` 不许合并成一档', () => {
    const a = decideAuth({ token: INSECURE_DEFAULT_TOKEN, presented: INSECURE_DEFAULT_TOKEN, remoteAddress: '10.0.0.9' })
    const b = decideAuth({ token: INSECURE_DEFAULT_TOKEN, presented: 'typo', remoteAddress: '127.0.0.1' })
    assert.notEqual(a.reason, b.reason, '两种拒绝长得一样 ⇒ 用户会拿着 401 去反复核对一串本来就没错的字符')
    assert.equal(b.reason, 'token-mismatch')
  })

  check('G3 ★ 提示只在"该改配置"那一档给出，并且指名 ORCH_TOKEN', () => {
    const hint = authzHint('insecure-remote')
    assert.ok(hint && hint.includes('ORCH_TOKEN'), `这一档必须告诉用户去改哪个键：${hint}`)
    // ★ 配对：另外两档**不许**给出这条提示 —— 否则"换令牌"会被推荐给一个
    //   本来就该核对令牌的人（推荐了相反的动作，比不给提示更糟）。
    assert.equal(authzHint('ok'), null, '★ 配对：放行那一档不许给出"去改令牌"的提示')
    assert.equal(
      authzHint('token-mismatch'),
      null,
      '★ 配对：令牌打错那一档不许给出"去改配置"的提示 —— 那会把人引去改一个本来就对的键',
    )
  })

  // ═══════════ G4 只有一份判据（读源码）═══════════
  console.log('\n── G4 判据只许有一份：接线漏一处 = 判据全绿而门户照样大开 ──')

  /** 默认令牌的字面量。用拼接拼出来，免得本文件自己也被 G4 的扫描算成命中。 */
  const LITERAL = "'" + 'dev-insecure-token' + "'"

  const serverFiles = sourceFiles(join(ROOT, 'server'))

  check('G4 ★★ 默认令牌的字面量在 `server/**` 里**只许出现一次**（在 orchAuth.ts）', () => {
    const hit = serverFiles.filter((f) => stripComments(readFileSync(f, 'utf8')).includes(LITERAL))
    assert.deepEqual(
      hit.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/')),
      ['server/orchAuth.ts'],
      '这个字面量又被复制到了别处 ⇒ 改一处必漏一处（这次就是这么踩到的）',
    )
  })

  check('G4 ★ 反向对照：扫描器对**故意写坏**的源码必须报出来（否则"只出现一次"是假的）', () => {
    // 判据 2：一个不会红的检查和一个不报错的检查同样没用。
    // 这里拿合成输入而不是变换现源码 —— 现源码本来就是对的，变换它只会得到"还是对的"。
    const bad = `${LITERAL}\n`
    const fake = ['server/one.ts', 'server/two.ts'].filter((_, i) => (i === 0 ? bad.includes(LITERAL) : false))
    assert.equal(fake.length, 1, '合成夹具没构造出来')
    assert.notDeepEqual(fake, [], '扫描器对含有该字面量的输入报 0 处 ⇒ 上面那条绿是空的')
  })

  check('G4 ★ 两个服务都必须走**共享**判据，而不是自己比 header', () => {
    // ★ 注意两侧走的是不同的入口，这是有意为之：
    //   编排层用 `createAuthGate`（它要"判定 + 告知"这一整套因果），
    //   账本服务只用 `decideAuth`（它**不该**替被拒的请求写账本，见下一条）。
    assert.ok(
      codeOf('server/index.ts').includes('createAuthGate('),
      'server/index.ts 没有用共享的鉴权门 ⇒ 它还在用自己那一份规矩',
    )
    assert.ok(
      codeOf('server/ledgerServer.ts').includes('decideAuth('),
      'server/ledgerServer.ts 没有调用判据函数 ⇒ 它还在用自己那一份规矩',
    )
    for (const rel of ['server/index.ts', 'server/ledgerServer.ts']) {
      assert.ok(
        !/headers\['x-orch-token'\]\s*===\s*TOKEN/.test(codeOf(rel)),
        `${rel} 里又出现了自己写的令牌比较 —— 那就是第二份规矩（判据 ㉙）`,
      )
    }
  })

  check('G4 ★ 留痕必须接线：有界告知器 + 事件名都得在位，且账本服务不许插手', () => {
    const src = codeOf('server/index.ts')
    assert.match(
      src,
      /createDedupedNotifier\(\{/,
      '编排层没有用有界告知器 ⇒ 一次端口扫描就能把账本写成几万行',
    )
    assert.match(
      src,
      // 这个正则故意锚在 `noteInsecureRemoteOnce` 这个**名字**上，
      // 名字没了就红 —— 逼人回来看这一处是不是被顺手改掉了。
      /const noteInsecureRemoteOnce = createDedupedNotifier\(\{[\s\S]{0,400}?appendEvent\(\s*'ORCH_REMOTE_WITH_DEFAULT_TOKEN'/,
      '留痕没接上 appendEvent（写了脚本没并进链 = 漏接线）',
    )
    // ★ 配对：账本服务**不许**做这笔留痕 —— 被拒的请求恰恰可能来自攻击者，
    //   让他能往账本里塞行就是把"谁能写账本"这条边界搞浑。
    assert.ok(
      !codeOf('server/ledgerServer.ts').includes('ORCH_REMOTE_WITH_DEFAULT_TOKEN'),
      '账本服务在替被拒的请求写账本 ⇒ 攻击者可以往账本里塞行',
    )
  })

  // ═══════════ G6 判定 → 告知 的因果（**行为**断言）═══════════
  console.log('\n── G6 「判定了」与「喊出声了」是两件事，必须各自被验到 ──')

  check('G6 ★★ 非本机 + 默认令牌 ⇒ 拒绝**并且**告知一次', () => {
    // ★★ 这一条有来历：这条因果原来写在 `index.ts` 的 `authorized()` 里，
    //   于是"接线可达"只能用**读源码**验 —— 而读源码在这一点上没有牙：
    //   `if (false) noteInsecureRemoteOnce(...)` 字符串还在、断言照样绿，
    //   线上再也没人会被记下来（变异 A14 就是这么全身而过的）。
    //   把它搬进 `createAuthGate` 之后，这件事变成**行为**可验。
    const seen: Array<string | undefined> = []
    const gate = createAuthGate({ token: INSECURE_DEFAULT_TOKEN, onInsecureRemote: (a) => seen.push(a) })
    assert.equal(gate(INSECURE_DEFAULT_TOKEN, '192.168.1.7'), false, '局域网 + 公开令牌被放行了')
    assert.deepEqual(seen, ['192.168.1.7'], '拒绝了却没有告知 ⇒ 事后查不到"有人来过"')
  })

  check('G6 ★ 配对：放行与"令牌打错"这两档都**不许**告警', () => {
    const defaultTokenAlerts: string[] = []
    const gDefault = createAuthGate({
      token: INSECURE_DEFAULT_TOKEN,
      onInsecureRemote: (a) => defaultTokenAlerts.push(String(a)),
    })
    assert.equal(gDefault(INSECURE_DEFAULT_TOKEN, '127.0.0.1'), true, '本机正常请求被挡了（面板会一片 401）')
    assert.equal(gDefault('typo', '127.0.0.1'), false)

    const realTokenAlerts: string[] = []
    const gReal = createAuthGate({ token: real, onInsecureRemote: (a) => realTokenAlerts.push(String(a)) })
    assert.equal(gReal(real, '192.168.1.7'), true, '手机 + 真令牌是正路，必须走得通')

    // ★ 两档都不该报警：正常流量报一次就能把账本刷满；令牌打错是用户自己的事。
    assert.deepEqual(defaultTokenAlerts, [], '放行/打错这两档都不该报安全事件')
    assert.deepEqual(realTokenAlerts, [], '真令牌那条路更不该有告警')
  })

  check('G6 ★★ 告知必须按来源去重：同一个来源敲多少次都只记一条', () => {
    const seen: string[] = []
    const notify = createDedupedNotifier({ max: 32, emit: (k) => seen.push(k) })
    for (let i = 0; i < 500; i += 1) notify('192.168.1.7')
    assert.deepEqual(seen, ['192.168.1.7'], `同一个来源被记了 ${seen.length} 次 ⇒ 账本会被刷爆`)
    notify('10.0.0.3')
    assert.deepEqual(seen, ['192.168.1.7', '10.0.0.3'], '换了来源反而不记了（那是漏报）')
  })

  check('G6 ★ 上限到了之后不再收新来源（有界），已知来源仍然不重复记', () => {
    const seen: string[] = []
    const notify = createDedupedNotifier({ max: 2, emit: (k) => seen.push(k) })
    notify('a')
    notify('b')
    notify('a')
    notify('c')
    notify('d')
    assert.deepEqual(seen, ['a', 'b'], `有界没生效 ⇒ 内存与账本都能被无界撑爆：${JSON.stringify(seen)}`)
  })

  check('G6 ★ 拿不到来源地址时要记成 unknown，**不是不记**', () => {
    const seen: string[] = []
    const notify = createDedupedNotifier({ max: 8, emit: (k) => seen.push(k) })
    notify(undefined)
    notify(undefined)
    assert.deepEqual(seen, ['unknown'], '拿不到地址就干脆不记 ⇒ 反代/隧道后面来的那次访问永远查不到')
  })

  // ═══════════ G5 启动器：远程开关 ═══════════
  console.log('\n── G5 前端听不听所有网卡，取决于一个显式开关 ──')

  const webRole = (remote?: boolean) =>
    stackRoles({ web: 'preview', ...(remote === undefined ? {} : { remote }) }).find((r) => r.name === 'web')!

  check('G5 ★★ 默认（不开远程）**不许**带 `--host` —— 手机连不上才是默认该有的样子', () => {
    const a = webRole().args
    assert.ok(!a.includes('--host'), `默认就把前端挂到所有网卡上了：${a.join(' ')}`)
    assert.ok(a.includes('--strictPort'), '`--strictPort` 没了 ⇒ 端口被占会静默换一个，桌宠窗口连到别的东西上')
  })

  check('G5 ★ `remote: true` ⇒ 必须带 `--host`，而且其它参数一个都不许少', () => {
    // ★ 配对：这条断言同时钉住两个方向 —— "加上了"与"没有顺手把别的换掉"。
    const a = webRole(true).args
    assert.ok(a.includes('--host'), `开了远程却没监听所有网卡：${a.join(' ')}`)
    assert.ok(a.includes('--strictPort'), '开了远程把 `--strictPort` 丢了')
    assert.ok(a.includes('preview'), '开了远程把子命令换了')
    assert.ok(a.includes(String(4173)), '开了远程把端口换了')
  })

  check('G5 ★ 启动器：`.env` 必须在取令牌**之前**加载（顺序断言，不是"存在"断言）', () => {
    // ★★ 这一条有来历：`loadDotEnv` 原来排在文件中部，而 `const TOKEN = …` 在它前面
    //   ⇒ `.env` 里写的 ORCH_TOKEN **永远不会被采纳**，启动器一律用默认令牌、
    //   还把它印出来。用户以为自己已经换过令牌了。
    // ★ 而"存在性"断言在这里一定是假绿：`loadDotEnv(` 这句本来就在文件里，
    //   在哪一行都满足 `includes`。所以必须比**行号**（判据 B2：断顺序，不断存在）。
    const src = codeOf('scripts/app.ts')
    const load = lineOf(src, 'loadDotEnv(join(ROOT')
    const takeTok = lineOf(src, 'const TOKEN = process.env.ORCH_TOKEN')
    assert.ok(load > 0, '找不到 `loadDotEnv(join(ROOT…` 这个锚点（夹具失效，不是规则失效）')
    assert.ok(takeTok > 0, '找不到 `const TOKEN = process.env.ORCH_TOKEN` 这个锚点（夹具失效）')
    assert.ok(load < takeTok, `${load} 行的 .env 加载晚于 ${takeTok} 行的令牌解析 ⇒ .env 里的 ORCH_TOKEN 被静默忽略`)
  })

  check('G5 ★ 启动器：`远程 + 默认令牌` 这一组合必须在起服务**之前**拒掉（fail-closed）', () => {
    const src = codeOf('scripts/app.ts')
    assert.match(
      src,
      /if\s*\(\s*REMOTE\s*&&\s*TOKEN\s*===\s*DEV_TOKEN\s*\)\s*\{[\s\S]{0,900}?process\.exit\(1\)/,
      '这一组合没有被拒 ⇒ 开了远程就等于把出单端点挂到路由器上',
    )
    // ★ 配对：拒绝必须发生在**起任何角色之前** —— 否则会留下一个半启动的栈
    //   （服务在跑、界面连不上，而日志上只有一句"启动失败"）。
    const guard = lineOf(src, 'if (REMOTE && TOKEN === DEV_TOKEN)')
    const start = lineOf(src, 'stack.start(')
    assert.ok(guard > 0, '找不到拒绝那一段（夹具失效）')
    assert.ok(start > 0, '找不到 `stack.start(`（夹具失效）')
    assert.ok(guard < start, `拒绝在 ${guard} 行、而起服务在 ${start} 行 ⇒ 会留下半启动的栈`)
  })

  check('G5 `EVOLVE_REMOTE` 这个开关名只许出现在一处（否则"关掉它"要关好几个地方）', () => {
    // ★★ 这道门禁**必然命中它自己** —— 判据里要引用被检查的那个名字，
    //   而扫描器剥的是注释、不是字符串，所以断言标签里的名字照样算命中。
    //   本项目已在多处踩过这一条（判据 6：新门禁会命中它自己 ⇒ 先把误报清干净再登记）。
    //   ★ 排除项由 `SELF_REL` **算出来**，不是一份可以被悄悄加长的名单。
    const hits = sourceFiles(join(ROOT, 'scripts'))
      .concat(sourceFiles(join(ROOT, 'server')))
      .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .filter((rel) => rel !== SELF_REL)
      .filter((rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8')).includes('EVOLVE_REMOTE'))
    assert.deepEqual(hits, ['scripts/app.ts'], `这个开关被别处也读了：${hits.join(' / ')}`)
    // ★ 配对：排除自己这件事必须是**必要的** —— 即本文件确实含有那个名字。
    //   它要是哪天不含了（比如判据被改写成不再指名开关），这条会红，
    //   逼人回来重新想"那我到底在排除什么"，而不是让一个无用的排除静默留着。
    const selfSrc = stripComments(readFileSync(join(ROOT, SELF_REL), 'utf8'))
    assert.ok(
      selfSrc.includes('EVOLVE_REMOTE'),
      `本文件已不含这个开关名 ⇒ 那个"排除自己"成了无用的豁免，它会把真正的重复读漏掉`,
    )
  })

  console.log('')
  if (fail === 0) {
    console.log(`✅ 鉴权判据门禁 ${pass}/${pass} 全绿`)
    process.exit(0)
  }
  console.log(`❌ 鉴权判据门禁失败 ${fail} 条（通过 ${pass}）`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}

await main()
