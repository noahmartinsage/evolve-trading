/**
 * Agent 舰队烟测 —— **真跑**，不是对声明做静态检查
 *
 * ── 用户的原话与它要求的证明方式 ──────────────────────────────────────
 * 「Agent 舰队需要真实干活跑实测的」。这句话把这一层的要求从
 * "有一份看起来合理的实现"抬到了"能证明它真的在跑"。所以这份测试
 * 里几乎没有一条是读代码字符串就完事的（少数几条是为了钉住"接线被撤掉"）：
 *   · 真调 `runAgent()`，真落账本，再从 `fleetSnapshot()` 把数字读回来；
 *   · 真跑 `runTask()` 的**真实成员链**（巡检链四个成员全跑一遍）；
 *   · 真在总线上 publish，再验下游的收件箱里有没有那条笔记；
 *   · 真扫工作区（不是夹具），体积与分组数字现算。
 *
 * ── 八件事，每一件对应一次真实的失误 ──────────────────────────────────
 * ① **注册表 0 问题**（真实注册表）。它守的是"不许孤岛"这条红线。
 * ② ★ **每一条注册表检查都能变红。** 这是整份测试里最要紧的一条：
 *    一个只会报绿的检查等于没有检查。所以每一条判据都喂一个**只坏这一处**
 *    的注册表进去，证明它当场报红。将来谁把某条检查删掉，这里立刻红。
 * ③ **接线证据真的在源文件里**：ui/voice 消费面的 marker、以及 HTTP 端点
 *    的字面路由。撤掉接线 → marker 消失 → 报红。
 * ④ **单成员真跑**：`lesson` 跑完必须有 `FLEET_AGENT_RUN` 事件，
 *    且快照里**只有它**从「没跑过」变成「跑成了」——
 *    这一条同时排除"一跑全绿"（那是写死数字时代的特征）。
 * ⑤ **上下游真的交东西**：注入一对夹具跑真链，断言下游 `inputFrom` 非空。
 *    配一条**断链**反例：上游声明了主题却不发 ⇒ 下游必须当场失败，
 *    而不是空着参数跑完然后报成功。
 * ⑥ **act 类无确认必拒，且不许真跑**（`durationMs === 0`）。
 * ⑦ **文件体检只报告不删除**：源码里不许出现删除调用，产出里 `deleted` 恒为 0，
 *    分组逻辑用夹具目录逐组验证（真实工作区干不干净是波动的，
 *    拿它当断言会对**正确的输入**报错 —— 判据 2）。
 * ⑧ **跨层口径**：计划表一句都不许认领语音层自己认领的说法。
 *    它读的是语音烟测里那张意图表（刻意不另抄一份），把非派活的行逐条喂给 `planTask()`。
 *    这条来自一次真实的回归：`status` 计划里多了 `/系统状态/` 与一个含「系统」的疑问句
 *    模式 ⇒ 「系统现在什么情况」从"读系统实况"变成"跑四成员巡检"（`test:voice` S14 变红）。
 *    这类抢占的特点是**单看两个正则各自都挺合理**，只在收口成一句人话时才显形。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEvents, resetLedger, initLedger } from '../server/ledger.ts'
import { isPersistent, getDb } from '../server/persistence.ts'
import {
  LOCK_STALE_MS,
  __resetEvolutionLockForTest,
  acquireEvolutionLock,
  evolutionLockSnapshot,
  heartbeatEvolutionLock,
  releaseEvolutionLock,
} from '../server/evolutionLock.ts'
import { defaultIndexPath, readFactorIndex } from '../server/factorService.ts'
import { screenAcceptedFactors } from '../server/factorStrategyService.ts'
import {
  __resetFleetForTest,
  auditFleetRegistry,
  AUTONOMY_JOBS,
  BARREN_LIMIT,
  CLEAN_MAX_ITEMS,
  FLEET_AGENTS,
  FLEET_CONSUMERS,
  FLEET_TASK_PLANS,
  autonomyTicks,
  autonomyStatus,
  fleetAgent,
  fleetConsumer,
  fleetRoster,
  fleetTopic,
  fleetSnapshot,
  inboxOf,
  judgePath,
  listTrash,
  mineFactors,
  parseProposals,
  planClean,
  planTask,
  planNeedsConfirm,
  undoPlanOf,
  publish,
  runAgent,
  runClean,
  runTask,
  scanHygiene,
  WINDOW_SETS,
  startAutonomy,
  stopAutonomy,
  topicSubscribers,
  __resetAutonomyDepsForTest,
  __resetAutonomyForTest,
  __setAutonomyDepsForTest,
} from '../server/fleet/index.ts'
import type { FleetAgent, FleetRawResult } from '../server/fleet/index.ts'

// ★★ 隔离必须在**模块加载期**定好（判据 C10：隔离是"第一件事"）。
//   `initLedger()` 走 `initPersistence()`，而它在 `db === null` 时**立即**按
//   `process.env.ORCH_DB` 打开库并锁死 ⇒ 晚设（例如放进 main）会沿用
//   默认的 `data/orch.db`（= 用户应用的真库）。
//   本文件从"进化单飞锁"起**需要真持久层**（锁住在 SQLite 里）。
const RUN_TAG = `${process.pid}-${Date.now()}`
process.env.ORCH_DB = join('data', `fleet-smoke-${RUN_TAG}.db`)
const SMOKE_DB = process.env.ORCH_DB

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error('[FAIL] FLEET SMOKE FAIL - ' + name + ' - ' + msg)
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
    join(dir, 'fleet-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function assertTrue(name: string, cond: boolean, msg: string): void {
  if (!cond) fail(name, msg)
}

function assertEq<T>(name: string, actual: T, expected: T, extra = ''): void {
  if (actual !== expected) {
    fail(name, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + (extra ? ' · ' + extra : ''))
  }
}

/** 读一份项目内源码。读不到直接红 —— 那说明路径写错了，不是"没接线"。 */
function readSource(name: string, rel: string): string {
  try {
    return readFileSync(join(process.cwd(), rel), 'utf8')
  } catch (e) {
    return fail(name, `读不到 ${rel}：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 读源码，**剥掉注释行** —— 用来断言"某一处到底有没有真的被调用"。
 *
 * ★★ 为什么需要它（这是本文件里第二次被检查器自己的假红教出来的）：
 *   `F19 回话不再念 why` 用 `source.includes()` 扫全文，结果**代码里已经删干净**、
 *   只剩下注释在解释"上一轮这里是个 `speakable()`"，门就红了 ——
 *   检查器对一个**正确的**输入报错。
 *
 *   ★ 反过来更危险：`source.includes('planNeedsConfirm(')` 这类
 *     "有没有真的调用"的断言，会被**注释里提到这个函数名**骗成假绿。
 *     一句话写个 `// 这里用 planNeedsConfirm() 裁决` 就能让门永远绿 ——
 *     而门绿着、功能没接。这是同一枚硬币的两面，一起治：
 *     **凡断言"源码里有没有调用"，必须剥注释。**
 *
 * ★ 剥法是保守的逐行过滤（丢 `//`、`*`、`/*` 开头的行），不做词法分析：
 *   它只求"宁可不剥，也别把代码剥掉"——漏剥最多让一条注释造成假红，
 *   而把真代码剥掉会造成**假绿**，后者更贵。
 */
function readCode(name: string, rel: string): string {
  return readSource(name, rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

/** 拷贝一份真实注册表，只按 `mut` 改一处 —— 这样报出来的红必然来自那一处。 */
function mutate(mut: (list: FleetAgent[]) => void): FleetAgent[] {
  const list = FLEET_AGENTS.map(
    (a): FleetAgent => ({ ...a, consumers: [...a.consumers], emits: [...a.emits], consumes: a.consumes ? [...a.consumes] : undefined }),
  )
  mut(list)
  return list
}

/** 断言"只坏这一处"的注册表会让 `code` 出现。 */
function expectRed(name: string, code: string, mut: (list: FleetAgent[]) => void): void {
  const problems = auditFleetRegistry(mutate(mut))
  const hit = problems.find((p) => p.code === code)
  if (!hit) {
    fail(name, `坏掉「${code}」对应的那一处之后，审计没有报出这个 code。报出来的是：${problems.map((p) => p.code).join('、') || '（一条都没有）'}`)
  }
}

/** 夹具 agent：字段合法（免得引入无关的注册表问题），只有行为由用例决定。 */
function mkAgent(over: Partial<FleetAgent> & { id: string }): FleetAgent {
  return {
    label: `夹具-${over.id}`,
    duty: '烟测夹具：替代一个真实成员，用来构造上下游关系',
    kind: 'read',
    cost: 'instant',
    reuses: 'server/fleet/service.ts 的 runTask()（夹具指向真实存在的文件，避免引入 REUSES_MISSING）',
    output: '夹具产出',
    consumers: ['ui:fleet'],
    emits: [],
    run: (): FleetRawResult => ({ ok: true, summary: '夹具', steps: ['夹具步骤'], outputs: {} }),
    onMessage: (m) => `夹具收到 ${m.topic}`,
    ...over,
  }
}

async function main(): Promise<void> {
  process.env.AUTOPILOT_LIVE = 'false'
  process.env.AUTOPILOT_PRESEED = 'false'

  // ══════════════ ① 注册表 0 问题（真实注册表）══════════════
  // ★★ `initLedger()` 是**必须先做的一步**，不是可选项：
  //   进化单飞锁住在 SQLite 里，而 `initPersistence()` 只在 `initLedger()` 里被调。
  //   漏掉它 ⇒ `getDb() === null` ⇒ `acquireEvolutionLock()` 全部返回
  //   `unverifiable` ⇒ 下面 F20 每一条断言都走"另一条路"却**仍然全绿**。
  //   这正是判据 C1（只有测试可达 ≠ 可达）的反面用法：**没有真库时，
  //   "锁生效了"与"锁根本没被调用"看起来一模一样** —— 所以先钉一道 F0。
  //   注：本文件的 `ORCH_DB` 已在**模块加载期**设好（见文件头），此处调用是安全的；
  //   反过来若把 ORCH_DB 挪到这里设，就会静默连上用户应用的真库。
  initLedger()
  resetLedger()
  __resetFleetForTest()

  // ★ 前置断言：本文件从"进化单飞锁"起需要**真持久层**。
  //   它分辨的是三种**看着一样、动作相反**的事因（判据 C5）：
  //     ① 库没打开（= 本文件自己少调了一步）→ 修这里
  //     ② 锁逻辑坏了                      → 修 evolutionLock.ts
  //     ③ 别人持锁（busy）                → 等 / 抢，都不是缺陷
  //   没有 F0 的话，②③ 都会以"F20 全绿"的形式出现。
  assertTrue('F0 台账可用（单飞锁需要真持久层）', isPersistent(), `ORCH_DB=${SMOKE_DB} 没有打开`)
  __resetEvolutionLockForTest()

  const problems = auditFleetRegistry()
  assertEq('F1 真实注册表无问题', problems.length, 0, problems.map((p) => `${p.agentId}/${p.code}`).join(' '))
  pass('F1 真实注册表无问题', `${FLEET_AGENTS.length} 个成员，0 处问题`)

  const roster = fleetRoster()
  assertEq('F1b 名录与注册表一致', roster.length, FLEET_AGENTS.length)
  const islands = FLEET_AGENTS.filter((a) => a.consumers.length === 0).map((a) => a.id)
  assertEq('F1c 没有成员是孤岛', islands.length, 0, islands.join('、'))
  pass('F1c 没有成员是孤岛', `每个成员都声明了「谁读它的输出」`)

  // ══════════════ ② 每一条注册表检查都能变红 ══════════════
  // 这一组是这份测试的核心：它证明 F1 的绿不是因为检查器是空的。
  expectRed('F2 DUP_ID', 'DUP_ID', (l) => {
    l[1] = { ...l[1], id: l[0].id }
  })
  expectRed('F2 NO_REUSES', 'NO_REUSES', (l) => {
    l[0] = { ...l[0], reuses: '  ' }
  })
  expectRed('F2 REUSES_NO_PATH', 'REUSES_NO_PATH', (l) => {
    l[0] = { ...l[0], reuses: '某个既有入口（没写路径）' }
  })
  expectRed('F2 REUSES_MISSING', 'REUSES_MISSING', (l) => {
    l[0] = { ...l[0], reuses: 'server/nonexistent/path.ts 的 run()' }
  })
  expectRed('F2 NO_OUTPUT', 'NO_OUTPUT', (l) => {
    l[0] = { ...l[0], output: '' }
  })
  expectRed('F2 ISLAND', 'ISLAND', (l) => {
    l[0] = { ...l[0], consumers: [] }
  })
  expectRed('F2 CONSUMER_UNKNOWN', 'CONSUMER_UNKNOWN', (l) => {
    l[0] = { ...l[0], consumers: ['ui:nowhere'] }
  })
  // ★ 这条要**同时**注入注册表与消费面表才构造得出来：先要 `agent:ghost` 在册
  //   （否则报的是 CONSUMER_UNKNOWN 并继续下一条），才轮得到"表里登记了它、
  //   但注册表里没有这个 agent"这一步。第一版只改注册表，于是这条永远走不到 ——
  //   一个走不到的分支等于没有检查，所以这里把它真正撑开。
  const ghost = auditFleetRegistry(
    mutate((l) => {
      l[0] = { ...l[0], consumers: ['agent:ghost'] }
    }),
    { consumers: [...FLEET_CONSUMERS, { id: 'agent:ghost', label: '已从注册表删掉的下游', kind: 'agent' }] },
  )
  assertTrue(
    'F2 CONSUMER_AGENT_MISSING',
    ghost.some((p) => p.code === 'CONSUMER_AGENT_MISSING'),
    `消费面表里登记了一个不存在的 agent，却没有报 CONSUMER_AGENT_MISSING（实际：${ghost.map((p) => p.code).join('、') || '空'}）`,
  )
  expectRed('F2 CONSUMER_AGENT_NOT_SUBSCRIBED', 'CONSUMER_AGENT_NOT_SUBSCRIBED', (l) => {
    // proposal 声称 `agent:gate` 读它，而 gate 的 consumes 里没有 proposal.generated
    const i = l.findIndex((a) => a.id === 'gate')
    l[i] = { ...l[i], consumes: ['strategy.screened'], onMessage: () => 'x' }
  })
  pass('F2 注册表判据逐条可红（结构类 9 条）', '每条都只坏一处，逐条当场报红')

  // F2b 证据类判据：注入 readText / exists，构造"证据文件读不到"与"接线被撤掉"。
  const evidenceProblems = auditFleetRegistry(FLEET_AGENTS, {
    readText: () => null,
    exists: () => true,
  })
  assertTrue(
    'F2b 证据文件读不到会红',
    evidenceProblems.some((p) => p.code === 'CONSUMER_EVIDENCE_MISSING_FILE'),
    `期望 CONSUMER_EVIDENCE_MISSING_FILE，实际 ${evidenceProblems.map((p) => p.code).join('、') || '（空）'}`,
  )
  const unwired = auditFleetRegistry(FLEET_AGENTS, {
    readText: () => '这个文件里没有任何舰队调用',
    exists: () => true,
  })
  assertTrue(
    'F2b 接线被撤掉会红',
    unwired.some((p) => p.code === 'CONSUMER_EVIDENCE_UNWIRED'),
    `期望 CONSUMER_EVIDENCE_UNWIRED，实际 ${unwired.map((p) => p.code).join('、') || '（空）'}`,
  )
  pass('F2b 证据类判据可红', '证据文件读不到 / 标记消失，两种都当场报红')

  expectRed('F2 TOPIC_UNREGISTERED', 'TOPIC_UNREGISTERED', (l) => {
    l[0] = { ...l[0], emits: ['nowhere.topic'] }
  })
  expectRed('F2 TOPIC_NO_SUBSCRIBER', 'TOPIC_NO_SUBSCRIBER', (l) => {
    // 让 gate 不再订阅 proposal.generated ⇒ 该主题变成死信箱。
    const i = l.findIndex((a) => a.id === 'gate')
    l[i] = { ...l[i], consumes: ['strategy.screened'], onMessage: () => 'x' }
  })
  expectRed('F2 CONSUMES_NO_HANDLER', 'CONSUMES_NO_HANDLER', (l) => {
    // l[2] = factor_screen（唯一一个既声明 consumes 又有 onMessage 的成员）
    l[2] = { ...l[2], onMessage: undefined }
  })
  expectRed('F2 HANDLER_NO_CONSUMES', 'HANDLER_NO_CONSUMES', (l) => {
    l[6] = { ...l[6], consumes: [], onMessage: () => 'x' }
  })
  expectRed('F2 CONSUME_UNREGISTERED', 'CONSUME_UNREGISTERED', (l) => {
    l[1] = { ...l[1], consumes: ['nowhere.topic'] }
  })
  expectRed('F2 ACT_NO_INTENT', 'ACT_NO_INTENT', (l) => {
    l[0] = { ...l[0], intent: undefined }
  })
  expectRed('F2 ACT_INTENT_NOT_DANGEROUS', 'ACT_INTENT_NOT_DANGEROUS', (l) => {
    l[0] = { ...l[0], intent: 'ask_system' as unknown as FleetAgent['intent'] }
  })
  expectRed('F2 READ_HAS_INTENT', 'READ_HAS_INTENT', (l) => {
    l[3] = { ...l[3], intent: 'self_upgrade' }
  })
  expectRed('F2 TOPIC_NO_PRODUCER', 'TOPIC_NO_PRODUCER', (l) => {
    for (let i = 0; i < l.length; i++) l[i] = { ...l[i], emits: l[i].emits.filter((t) => t !== 'factor.produced') }
  })
  // ★ 表结构判据必须能红。它读的是**注入进来的表** —— 只读常量表的检查
  //   永远绿且没有任何输入能让它红，那种检查等于不存在。
  const malformed = auditFleetRegistry(FLEET_AGENTS, {
    consumers: [{ id: 'gate', label: '少了 agent: 前缀的消费面', kind: 'agent' }],
  })
  assertTrue(
    'F2c 消费面表结构会被核对',
    malformed.some((p) => p.code === 'CONSUMER_TABLE_MALFORMED'),
    `喂进一张少了前缀的表，却没有报 CONSUMER_TABLE_MALFORMED（实际：${malformed.map((p) => p.code).join('、') || '空'}）`,
  )
  pass('F2c 注册表判据逐条可红（通道 / 动作类 10 条）', '主题未登记、无订阅者、无生产者、无处理器、危险名单、表结构，逐条报红')

  // ══════════════ ③ 接线证据与生产入口 ══════════════
  for (const c of FLEET_CONSUMERS) {
    if (c.kind === 'agent') continue
    if (!c.evidence) fail('F3 消费面证据', `消费面 ${c.id} 没有证据声明`)
    const text = readSource('F3 消费面证据', c.evidence.file)
    assertTrue(
      'F3 消费面证据',
      text.includes(c.evidence.marker),
      `${c.evidence.file} 里找不到标记「${c.evidence.marker}」—— 这条接线被撤掉了`,
    )
  }
  const orch = readSource('F3 HTTP 端点', 'server/index.ts')
  const ROUTES = ["'/fleet'", "'/fleet/plan'", "'/fleet/run'", "'/fleet/task'", "'/fleet/autonomy'"]
  for (const route of ROUTES) {
    assertTrue('F3 HTTP 端点', orch.includes(route), `server/index.ts 里没有路由 ${route} —— 舰队又变回不可达的实现`)
  }
  // ★ 「启停不许单开端点」也要是断言，不能只写在注释里：
  //   一旦有人在 `/fleet/autonomy` 上补一个 POST start，同一件事就有了两条实现路径。
  //   这条断言钉的是"那个只读端点不许长出写动作"。
  const autonomyRouteBlock = orch.slice(orch.indexOf("'/fleet/autonomy'"), orch.indexOf("'/fleet/autonomy'") + 900)
  assertTrue(
    'F3 自治循环的启停不许旁开第二条路径',
    autonomyRouteBlock.includes("req.method === 'GET'"),
    '「/fleet/autonomy」这个端点只该是只读的 —— 启停必须走 /fleet/task（同一条确认路径）',
  )
  // 面板：判据取**调用形态**而不是"够不够好看"。两个调用一撤，页面就回到了
  // 写死数字 —— 所以它们消失时这条必须红。（不去匹配 "DEMO 数据" 这类字样：
  // 那些字样在注释里也有，会变成一条对正确输入报错的断言。）
  const page = readSource('F3 面板', 'src/pages/AgentsPage.tsx')
  assertTrue('F3 面板读真实快照', page.includes('useFleet('), 'AgentsPage.tsx 没有调用 useFleet —— 页面又回到写死数字了')
  assertTrue('F3 面板有真实执行入口', page.includes('runFleetTask('), 'AgentsPage.tsx 没有调用 runFleetTask —— 按钮只能弹 toast')
  pass('F3 生产入口齐全', `3 个 ui/voice 消费面 + ${String(ROUTES.length)} 条 HTTP 路由 + 面板已换成真实取数`)

  // ══════════════ ④ 单成员真跑：真落账本、真发消息、真读数 ══════════════
  resetLedger()
  __resetFleetForTest()

  const before = fleetSnapshot()
  assertTrue(
    'F4 未跑过时不许显示成健康',
    before.agents.every((a) => a.state === 'never' && a.runCount === 0),
    `期望全部 never，实际 ${before.agents.map((a) => `${a.id}=${a.state}`).join(' ')}`,
  )
  assertTrue(
    'F4 出处必须说清"还没跑过"',
    before.provenance.includes('还没有任何一次真实运行'),
    `出处文案没有点明空状态：${before.provenance.slice(0, 80)}`,
  )
  pass('F4 空快照诚实', `${before.agents.length} 个成员全部为「没跑过」，出处文案点明这一点`)

  const lessonRun = await runAgent('lesson')
  assertTrue('F4 lesson 真跑成', lessonRun.ok, `跑失败：${lessonRun.summary} / ${lessonRun.reason ?? ''}`)
  assertTrue('F4 lesson 产出真实数字', lessonRun.steps.length >= 2, `只有 ${lessonRun.steps.length} 步留痕`)
  assertEq('F4 lesson 发出一条产出', lessonRun.emitted.length, 1)
  assertEq('F4 lesson 产出主题正确', lessonRun.emitted[0]?.topic, 'lesson.audited')

  const runEvents = getEvents(0).filter((e) => e.kind === 'FLEET_AGENT_RUN')
  assertEq('F4 落了一条 FLEET_AGENT_RUN', runEvents.length, 1)
  pass('F4 单成员真跑', `lesson 跑成，落账本 1 条，发出 1 条总线消息（${lessonRun.durationMs}ms）`)

  const after = fleetSnapshot()
  const lessonView = after.agents.find((a) => a.id === 'lesson')
  assertTrue('F4 快照读到真实结果', lessonView?.state === 'ok' && lessonView.runCount === 1, `实际 ${JSON.stringify({ state: lessonView?.state, runCount: lessonView?.runCount })}`)
  const others = after.agents.filter((a) => a.id !== 'lesson' && a.state !== 'never').map((a) => a.id)
  assertEq('F4 不许一跑全绿', others.length, 0, `这些成员在没跑过的情况下显示成了已跑：${others.join('、')}`)
  assertTrue('F4 出处指向账本', after.provenance.includes('1 条'), `出处没有引用条数：${after.provenance.slice(0, 80)}`)
  pass('F4 快照的数字来自账本', '只有 lesson 变成 ok，其余仍是 never —— 不是写死的数字')

  // ══════════════ ⑤ 上下游真的交东西（夹具配对断言）══════════════
  const fakeProducer = mkAgent({
    id: 'proposal',
    label: '夹具-提案专员',
    emits: ['proposal.generated'],
    run: (): FleetRawResult => ({
      ok: true,
      summary: '夹具发了提案产出',
      steps: ['夹具'],
      outputs: { 'proposal.generated': { verdicts: 3, promoted: 1, marker: 'from-fixture' } },
    }),
  })
  const okChain = await runTask('跑一轮提案', {
    confirmed: true,
    dryRun: true,
    agents: [fakeProducer, FLEET_AGENTS[3]],
  })
  assertTrue('F5 夹具链整体跑成', okChain.ok, `未跑成：${JSON.stringify(okChain.steps.map((s) => [s.agentId, s.ok, s.reason ?? '']))}`)
  const gateStep = okChain.steps.find((s) => s.agentId === 'gate')
  assertTrue('F5 gate 真的吃到了上游消息', (gateStep?.inputFrom.length ?? 0) > 0, `inputFrom 为空：${JSON.stringify(gateStep)}`)
  assertTrue('F5 有输入就不算独立核对', gateStep?.independent === false, '吃到了上游产出却仍被标成独立核对')
  // 载荷必须原样到达：只传消息 id 的"协同"是空信封。
  const gateInbox = inboxOf('gate')
  assertTrue(
    'F5 下游收到的是真实载荷',
    gateInbox.some((n) => n.note.includes('收到上游产出')),
    `gate 收件箱里没有投递笔记：${JSON.stringify(gateInbox)}`,
  )
  pass('F5 上下游交接真实', `gate 吃到 1 条上游产出，收件箱留有投递笔记`)

  const silentProducer = mkAgent({
    id: 'proposal',
    label: '夹具-沉默的提案专员',
    emits: ['proposal.generated'],
    // ★ 声明了主题，但 outputs 里没有它 ⇒ 实际什么都没发出去。
    run: (): FleetRawResult => ({ ok: true, summary: '夹具什么都没发', steps: ['夹具'], outputs: {} }),
  })
  const brokenChain = await runTask('跑一轮提案', {
    confirmed: true,
    dryRun: true,
    agents: [silentProducer, FLEET_AGENTS[3]],
  })
  assertTrue('F5 断链必须整体失败', !brokenChain.ok, '上游没发东西，任务却报成功了')
  assertEq('F5 断链停在 gate', brokenChain.failedAt, 'gate')
  const blocked = brokenChain.steps.find((s) => s.agentId === 'gate')
  assertTrue(
    'F5 断链的理由说清缺什么',
    (blocked?.reason ?? '').includes('NO_UPSTREAM_INPUT'),
    `理由不对：${blocked?.reason ?? '（无）'}`,
  )
  assertEq('F5 断链后不再往下跑', brokenChain.steps.length, 2)
  pass('F5 断链即失败', '上游声明了主题却不发 ⇒ 下游当场失败（NO_UPSTREAM_INPUT），不空着参数跑')

  // ══════════════ ⑥ 真实成员链（巡检）真跑 ══════════════
  resetLedger()
  __resetFleetForTest()

  // ★ 夹具这句话从 `'舰队现在什么样'` 改成了 `'系统巡检'`。
  //   改的不是"让测试变绿"，而是**夹具本身之前依赖了一个缺陷**：
  //   旧的 status 计划里有裸 `/舰队/`，于是"舰队现在什么样"能触发巡检 ——
  //   而那个裸词正是把「让舰队去挖因子」抢成一次只读巡检的元凶。
  //   去掉它之后，问舰队状态归语音层的 `ask_agents`（下面 F8b 有断言）。
  const scan = await runTask('系统巡检', { dryRun: true })
  assertTrue('F6 巡检链跑成', scan.ok, `未跑成：${JSON.stringify(scan.steps.map((s) => [s.agentId, s.ok, s.reason ?? '']))}`)
  assertEq('F6 巡检链成员数', scan.steps.length, 4)
  assertTrue('F6 每个成员都留了话', scan.steps.every((s) => s.summary.length > 0), '有成员没有产出可念的一句话')
  assertTrue('F6 有真实耗时', scan.durationMs > 0, '耗时是 0 —— 说明根本没跑')
  assertTrue('F6 落了账本事件', scan.ledgerEvents > 0, `ledgerEvents=${scan.ledgerEvents}`)
  assertTrue('F6 发了总线消息', scan.messageCount >= 4, `messageCount=${scan.messageCount}`)
  pass('F6 真实成员链', `巡检链 4 个成员全跑成，${scan.durationMs}ms，账本 +${scan.ledgerEvents}，总线 +${scan.messageCount}`)

  const snap2 = fleetSnapshot()
  assertTrue('F6 快照能读到这次任务', snap2.lastTask?.taskId === scan.taskId, `lastTask=${snap2.lastTask?.taskId ?? 'null'}`)
  const ranIds = snap2.agents.filter((a) => a.runCount > 0).map((a) => a.id).sort()
  assertEq('F6 快照里的运行记录与本次一致', ranIds.join(','), 'brain,gate,hygiene,lesson')
  pass('F6 快照/凭据一致', '任务凭据与快照指向同一次运行，四个成员各留一条运行记录')

  // ══════════════ ⑦ act 类无确认必拒，且不许真跑 ══════════════
  resetLedger()
  __resetFleetForTest()

  const refused = await runAgent('factor_produce', { dryRun: true })
  assertTrue('F7 act 无确认被拒', !refused.ok, '没确认就执行了 act 类成员')
  assertTrue(
    'F7 拒绝理由可念且点明要确认',
    (refused.reason ?? '').includes('NEEDS_CONFIRMATION'),
    `理由不对：${refused.reason ?? '（无）'}`,
  )
  assertEq('F7 拒绝时不许真跑', refused.durationMs, 0)
  assertEq('F7 拒绝也要留痕', getEvents(0).filter((e) => e.kind === 'FLEET_AGENT_RUN').length, 1)
  pass('F7 act 两段式确认', '未确认 ⇒ 拒（NEEDS_CONFIRMATION），耗时 0，且失败也落账本')

  const refusedTask = await runTask('扩候选基因空间', { dryRun: true })
  assertEq('F7 任务级拒绝', refusedTask.refusal, 'NEEDS_CONFIRMATION')
  assertEq('F7 任务级拒绝不跑任何一步', refusedTask.steps.length, 0)
  assertEq('F7 任务级拒绝不产生成员运行', getEvents(0).filter((e) => e.kind === 'FLEET_AGENT_RUN').length, 1)
  pass('F7 任务级预检', '链上有 act 类且未确认 ⇒ 整体拒绝，一步都不跑（不留半个改过的系统）')

  // ══════════════ ⑧ 听懂与听不懂 ══════════════
  const understood: [string, string][] = [
    ['扩候选基因空间', 'expand-factors'],
    ['换因子族', 'expand-factors'],
    ['清一下垃圾', 'hygiene'],
    ['系统巡检', 'status'],
    // 第十七轮新增的四类说法（用户本条消息里的原话）。
    ['检查文件是否有用', 'hygiene'],
    ['没有用的垃圾及时清洗', 'hygiene'],
    ['一键启动自治循环', 'autonomy-start'],
    ['停止自治循环', 'autonomy-stop'],
    ['给自己学习一轮', 'self-learn'],
    ['挖掘出很多个能稳定盈利的因子', 'expand-factors'],
  ]
  for (const [goal, expectId] of understood) {
    const p = planTask(goal)
    assertEq(`F8 听懂「${goal}」`, p.plan?.id ?? null, expectId)
  }
  const unknown = planTask('帮我订一张明天去上海的机票')
  assertEq('F8 听不懂就不猜', unknown.plan, null)
  assertTrue(
    'F8 听不懂时要报出能听懂的说法',
    unknown.why.includes('我能接的说法有'),
    `兜底文案没有列出可接说法：${unknown.why}`,
  )
  assertTrue('F8 计划表非空', FLEET_TASK_PLANS.length >= 5, `只有 ${FLEET_TASK_PLANS.length} 条计划`)
  pass('F8 一句话 → 成员链', `听懂 ${understood.length} 句（含用户点名的「扩候选基因空间」「换因子族」「一键启动自治循环」），听不懂的说清能接什么`)

  // ══════════ ⑧b 「问」与「做」必须分开（判据：用户问了一句，系统写了一笔）══════════
  //
  // ★ 这两条断言钉的是一次**实测抓出来的抢占**：
  //   旧的 status 计划里有裸 `/舰队/`，于是「让舰队去挖因子」这句**派活**指令
  //   被接成一次只读巡检，而且报成功 —— 用户的诉求被换成了一个汇报。
  //   修法是把这个裸词去掉；下面两条分别是"去掉之后不该被抢"与"疑问句不许被当成派活"。
  const dispatchNotStolen = planTask('让舰队去挖因子')
  assertEq('F8b 派活不被巡检抢走', dispatchNotStolen.plan?.id ?? null, 'expand-factors')
  // 疑问句：会写东西的计划不许被承接（用户问了一句，系统不该写一笔）。
  const interrogative = planTask('提案跑得怎么样')
  assertTrue(
    'F8b 疑问句不许被当成派活（会写东西的计划）',
    interrogative.plan === null,
    `「提案跑得怎么样」被判成了要执行：${interrogative.plan?.id ?? 'null'}`,
  )
  assertTrue(
    'F8b 疑问句被挡下时要说清为什么',
    interrogative.why.includes('听起来是在') && interrogative.why.includes('问'),
    `挡下的理由没说清"这是在问"：${interrogative.why}`,
  )
  // 只读计划在疑问句下**照接**（"问我现在的状态"与"去查一遍"本来就是同一件事）。
  // ★ 这句刻意选「整体情况怎么样」而**不是**「系统现在什么情况」——
  //   「系统 + 问状态」另有主人（语音层的只读实况，见下面那条断言）。
  //   第一版就是拿「系统现在什么情况」当夹具的，于是同一条句子被两层同时认领，
  //   计划表排在前面 ⇒ 用户问一句系统怎么样，收到四个成员的巡检汇报。
  //   这也是一条"对正确的输入报错"的断言（判据 2）：夹具本身选错了。
  const readOnlyOk = planTask('整体情况怎么样')
  assertEq('F8b 只读计划在疑问句下照接', readOnlyOk.plan?.id ?? null, 'status')

  // ★★ 跨层口径：语音层自己认领的说法，计划表**一句都不许抢**。
  //   这一条治的是本轮 CI 实跑抓出来的真回归：`status` 计划里原本有 `/系统状态/`
  //   和 `/(系统|整体|全局).{0,6}(什么情况|怎么样|如何)/`，而语音层的意图解析
  //   排在计划表**之后** ⇒ 用户问"系统现在什么情况"，收到的是四个成员的巡检汇报，
  //   `test:voice` S14 当场变红。归属：**「整体/全局/巡检/全盘」归计划表**，
  //   **「系统」归语音层只读实况**（语音管家本来就是独立智能体，有自己的实况出口）。
  for (const said of ['系统现在什么情况', '系统状态', '系统怎么样']) {
    assertEq(`F8b 语音层的「${said}」不被计划表抢走`, planTask(said).plan, null)
  }
  // ★ 问能力的话**不许触发会写东西的计划**（否则用户问一句、系统写一笔）。
  //   这条只有"疑问句"判据里补上 `能干什么` 那一族才会绿 —— 变异可验：
  //   原来那条裸 `/进化/` 会让「进化实验室能干什么」被接成一次"跑一轮提案"。
  assertEq('F8b 「能干什么」不许触发会写东西的计划', planTask('提案能干什么').plan, null)
  assertEq('F8b 对照：同一句去掉提问就是派活', planTask('跑一轮提案').plan?.id ?? null, 'propose')
  // ★ 这条是**变异验证抓出来的真弱点**：原来的"派活不被巡检抢走"在
  //   `FLEET_TASK_PLANS` 的顺序下不会变红 —— 因为 expand-factors 排在 status 前面，
  //   就算 status 重新裸认「舰队」，`hits[0]` 仍然是 expand。
  //   （判据 3：这条负向断言有没有一个**只有它**会命中的输入？）
  //   真正只有它才会命中的输入是这一句：它含「舰队」但不含任何动作词 ——
  //   只要 status 裸认「舰队」，它就会被接成一次只读巡检（而它是**在问**，不是在做）。
  assertEq('F8b 裸「舰队」不再意味着一件事', planTask('舰队现在什么样').plan, null)
  pass('F8b 问 vs 做', '派活不被巡检抢；会写东西的计划遇疑问句不当成派活（含"能干什么"）；只读计划照接；裸「舰队」不再被抢占；语音层认领的「系统…」一句也不被抢')

  // ══════════════ ⑨ 文件体检：只报告不删除 ══════════════
  const hygieneSrc = readSource('F9 体检只读', 'server/fleet/hygiene.ts')
  for (const call of ['unlinkSync(', 'rmSync(', 'rmdirSync(', 'unlink(', 'rmdir(']) {
    assertTrue('F9 体检只读', !hygieneSrc.includes(call), `hygiene.ts 里出现了删除调用 ${call} —— 它必须只报告不删除`)
  }
  const real = scanHygiene(process.cwd(), { maxEntries: 15 })
  assertTrue('F9 真扫到文件', real.totalFiles > 0, `扫到 ${real.totalFiles} 个文件 —— 路径可能不对`)
  assertTrue('F9 跳过目录要明写', real.skippedDirs.some((d) => d.includes('node_modules')), `skippedDirs=${real.skippedDirs.join(',')}`)
  assertTrue('F9 结论里写着不删除', real.note.includes('只报告不删除'), `note=${real.note.slice(0, 80)}`)
  pass('F9 真扫工作区', `扫到 ${real.totalFiles} 个文件 / ${real.groups.length} 组，源码里没有任何删除调用`)

  // 分组逻辑用夹具目录验证：真实工作区干不干净会波动，拿它当断言会对正确输入报错。
  const root = mkdtempSync(join(tmpdir(), 'fleet-hygiene-'))
  mkdirSync(join(root, 'artifacts'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, '_probe1.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'index.json.bak-2026'), '{}\n')
  writeFileSync(join(root, 'artifacts', 'old-smoke.json'), '{"a":1}\n')
  writeFileSync(join(root, 'src', 'keep.ts'), 'export const y = 2\n')
  // 陈旧判定注入 now：把"现在"推到 40 天之后，而不是去改文件 mtime。
  const fixture = scanHygiene(root, { maxEntries: 50, now: Date.now() + 40 * 86_400_000 })
  const gids = fixture.groups.map((g) => g.id)
  assertTrue('F9 探针组被识别', gids.includes('agent-probe'), `分组：${gids.join('、')}`)
  assertTrue('F9 备份组被识别', gids.includes('backup'), `分组：${gids.join('、')}`)
  assertTrue('F9 陈旧结论组被识别', gids.includes('stale-artifact'), `分组：${gids.join('、')}`)
  assertTrue(
    'F9 正常文件不被误判',
    !fixture.entries.some((e) => e.path === 'src/keep.ts'),
    '普通源码文件被列进了可回收清单 —— 这个检查器会对正确的输入报错',
  )
  assertTrue('F9 可回收体积是正数', fixture.reclaimableBytes > 0, `reclaimableBytes=${fixture.reclaimableBytes}`)
  pass('F9 分组判据', `夹具目录里探针 / 备份 / 陈旧结论三组各自命中，普通源码不被误伤`)

  const hygieneRun = await runAgent('hygiene', { dryRun: true })
  const hygieneOut = hygieneRun.emitted[0]?.payload as Record<string, unknown> | undefined
  assertEq('F9 产出里 deleted 恒为 0', hygieneOut?.deleted, 0)
  pass('F9 体检成员产出', `真扫工作区并报出可回收体积，产出里 deleted=0`)

  // ══════════════ ⑩ 总线：真投递 + 订阅从注册表派生 ══════════════
  resetLedger()
  __resetFleetForTest()
  fleetSnapshot() // 触发 ensureFleetInstalled，让订阅从注册表装上去

  const subs = topicSubscribers('factor.produced')
  assertEq('F10 订阅来自注册表', subs.join(','), 'factor_screen')
  const pub = publish({ topic: 'factor.produced', from: 'factor_produce', payload: { specs: 7, accepted: 2 } })
  assertEq('F10 真投递到 1 个下游', pub.deliveries.length, 1)
  const notes = inboxOf('factor_screen')
  assertEq('F10 下游收件箱有条目', notes.length, 1)
  assertTrue(
    'F10 投递笔记引用真实数字',
    notes[0].note.includes('7'),
    `笔记没带上游载荷：${notes[0].note}`,
  )
  assertTrue('F10 总线落了账本', getEvents(0).some((e) => e.kind === 'FLEET_MESSAGE'), '总线消息没有落账本 —— 事后无法分辨"没发"与"没收到"')
  pass('F10 总线真投递', `factor.produced → factor_screen，下游收件箱收到并留痕`)

  // ══════════════ ⑪ 慢成员被标出来（调度不再把它们塞进一次语音回合）══════════════
  assertEq('F11 慢成员标注', fleetAgent('factor_produce')?.cost, 'slow')
  assertEq('F11 慢成员标注', fleetAgent('factor_screen')?.cost, 'slow')
  const costs = FLEET_AGENTS.map((a) => a.cost)
  assertTrue('F11 成本档是有限枚举', costs.every((c) => ['instant', 'fast', 'slow'].includes(c)), `出现了未知档位：${costs.join('、')}`)
  pass('F11 成本档', `${costs.filter((c) => c === 'slow').length} 个慢成员被标出，调度不会把它们塞进一次即时回话`)

  // ══════════════ ⑫ 语音消费面：桌宠真能问舰队 ══════════════
  const awarenessSrc = readSource('F12 语音消费面', 'server/voice/awareness.ts')
  assertTrue('F12 语音真读舰队', awarenessSrc.includes('speakAgentFleet'), '语音层没有读舰队的出口')
  assertTrue(
    'F12 语音有独立的成员实况念法',
    awarenessSrc.includes('speakAgentFleet()'),
    '只声明了函数名却没有实现体',
  )
  const toolsSrc = readSource('F12 能力注册表', 'server/voice/tools.ts')
  assertTrue('F12 舰队能力已注册', toolsSrc.includes("id: 'agent_fleet'"), '语音工具注册表里没有 agent_fleet')
  pass('F12 语音消费面', '桌宠有一条读舰队实况的出口，并已注册进能力表')

  // ══════════════ ⑬ 自治循环：启停 / 到期真跑 / 不可逆拦截 ══════════════
  //
  // ★ 时钟与执行器都是注入的。理由：周期默认小时级，不注入就只能断言
  //   "启动成功"这种废话（判据 5：这个分支真可能发生吗、能构造出来吗）。
  {
    __resetAutonomyForTest()
    let fakeNow = 1_700_000_000_000
    const timers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = []
    let tid = 0
    const fired: string[] = []
    __setAutonomyDepsForTest({
      now: () => fakeNow,
      setTimer: (fn, ms) => {
        tid += 1
        timers.push({ fn, ms, id: tid, cancelled: false })
        return tid
      },
      clearTimer: (h) => {
        const t = timers.find((x) => x.id === h)
        if (t) t.cancelled = true
      },
      run: async (goal, opts) => {
        fired.push(`${goal}|confirmed=${String(opts.confirmed)}`)
        return { ok: true, summary: `stub:${goal}` }
      },
    })

    const a1 = startAutonomy()
    assertTrue('F13 能启动', a1.ok, `启动失败：${a1.reason ?? ''}`)
    assertEq('F13 排上的任务数与任务表一致', a1.status.jobs.length, AUTONOMY_JOBS.length)
    assertTrue('F13 每项都记了下次触发时刻', a1.status.jobs.every((j) => j.nextAt !== null), '有任务没有排程时刻')
    assertTrue('F13 循环里只有可逆任务', a1.status.jobs.every((j) => j.reversible), '有不可逆任务混进了自动循环')
    // 幂等：重复启动不许排两份（同一个任务两条定时链会让一轮跑两次）。
    const a2 = startAutonomy()
    assertEq('F13 重复启动是幂等的', a2.reason ?? '', 'ALREADY_RUNNING')
    assertEq('F13 幂等时不重复计数', a2.status.startCount, 1)
    assertEq('F13 幂等时不重复排程', timers.filter((t) => !t.cancelled).length, AUTONOMY_JOBS.length)

    // 到期真跑。
    // ★★ 逐个到期，**不是**把 5 条定时器一次性全 flush（2026-09-22 修）。
    //   一次性全 flush 等于凭空造了一次**同刻并发**：4 个写者同时伸手要进化单飞锁，
    //   其中 3 个**就应该**被判 busy 而顺延 —— 那是 ⑬b 的 F20 ⑦ 要守的事，不是这里。
    //   原来那句 `for (const t of timers...) t.fn()` 是在"没有单飞锁的世界"里成立的，
    //   加上锁之后它测的已经是另一个系统了（判据 D5：同一现象、不同事因）。
    //   生产的 initialDelay 被**刻意错开**（见 AUTONOMY_JOBS 注释「启动瞬间不该把所有
    //   任务一起打出去」），所以真实的"到期"本来就是错开的 ⇒ 夹具照生产形状造。
    const firstRound = timers.slice(0, AUTONOMY_JOBS.length)
    assertEq('F13 首轮定时器与任务表一一对应', firstRound.length, AUTONOMY_JOBS.length)
    const plan = AUTONOMY_JOBS.map((job, i) => ({ job, timer: firstRound[i] })).sort(
      (x, y) => x.job.initialDelayMs - y.job.initialDelayMs,
    )
    for (const step of plan) {
      fakeNow += step.job.initialDelayMs + 1
      step.timer.cancelled = true
      step.timer.fn()
      await new Promise((r) => setTimeout(r, 30))
    }
    assertEq('F13 到期真的触发了每一项', fired.length, AUTONOMY_JOBS.length)
    // ★ 配对断言（判据 A1：误报比漏报贵）：**正常错开的排程一个都不许被单飞锁挡住**。
    //   少了这条，一个"所有任务永远判忙"的锁也能让上面那句绿不了 —— 但反过来，
    //   一个"错开时也误判忙"的实现会在这里露出来，而它在生产里等于自进化停摆。
    {
      const st13 = autonomyStatus()
      const blocked = st13.jobs.filter((j) => j.deferredCount !== 0)
      assertEq(
        'F13 错开到期时没有被单飞锁误挡的项',
        blocked.length,
        0,
        blocked.map((j) => `${j.id}×${j.deferredCount}`).join('、'),
      )
    }
    assertTrue(
      'F13 触发时带 confirmed（循环内的动作是已授权的）',
      fired.every((f) => f.endsWith('|confirmed=true')),
      `有触发的调用没带 confirmed：${fired.join(' / ')}`,
    )
    assertTrue(
      'F13 循环的每个目标都是 planTask 接得住的',
      AUTONOMY_JOBS.every((j) => planTask(j.goal).plan !== null),
      `任务表里有 planTask 听不懂的目标：${AUTONOMY_JOBS.filter((j) => !planTask(j.goal).plan).map((j) => j.goal).join('、')}`,
    )
    assertEq('F13 每跑一轮都留账本事件', autonomyTicks(50).filter((t) => t.ok).length, AUTONOMY_JOBS.length)

    const a3 = stopAutonomy('smoke')
    assertTrue('F13 能停', !a3.running, '停机后 running 仍为 true')
    assertTrue('F13 停机后每条排程都清掉', a3.jobs.every((j) => j.nextAt === null), '停机后还有 nextAt —— 面板会显示"下次触发：过去某个时刻"')
    assertTrue('F13 停机后不再触发', timers.filter((t) => !t.cancelled).length === 0, '还有没取消的定时器')

    // 不可逆任务必须在**启动处**就被拦（而不是跑到才发现）。
    const bad = startAutonomy({ jobs: [{ ...AUTONOMY_JOBS[0], reversible: false }] })
    assertTrue('F13 不可逆任务不许进自动循环', !bad.ok, '不可逆任务被放进了自动循环')
    assertTrue('F13 拦截原因码可核对', (bad.reason ?? '').startsWith('IRREVERSIBLE_JOB:'), `原因不对：${bad.reason ?? '（无）'}`)

    __resetAutonomyDepsForTest()
    __resetAutonomyForTest()
    pass('F13 自治循环', `${AUTONOMY_JOBS.length} 项按周期排上、到期真跑并留账本、重复启动幂等、不可逆任务被拦`)
  }

  // ══════════════ ⑬b 进化单飞锁（日报内化 #3）══════════════
  //
  // 守的是：`setTimeout` 链只保证"同一项不和自己重叠"，**不保证不同项之间**不重叠。
  // 4 项会写共享产物（因子台账 / 策略台账 / 同一份 notes.jsonl / 项目根文件），
  // 而 `factor_mine` 是分钟级 —— 它没跑完时 `self_learn` 到期就会一起改台账。
  {
    __resetEvolutionLockForTest()

    // ── ① ★★ 最要紧的一条：**同一个进程**里的另一个任务也必须判忙 ──
    //   这一条专治一个极容易犯的错：照抄 `instance_fence` 的
    //   `row.pid === process.pid ⇒ 就是我自己，刷新` 那句。
    //   那句在**单例**语义下是对的，在**互斥**语义下会让锁静默失效
    //   （factor_mine 持锁时 self_learn 一进来就"认领"了同一把锁）。
    //   打坏它：把 acquire 里的判据改成 `row.pid !== process.pid` ⇒ 这条红。
    const a = acquireEvolutionLock('factor_mine', 1_000_000)
    assertEq('F20 ① 第一项拿到锁', a.kind, 'acquired')
    const b = acquireEvolutionLock('self_learn', 1_000_100)
    assertEq('F20 ① 同进程的另一个任务必须判忙（不许照抄 instance_fence 的同 pid 刷新）', b.kind, 'busy')
    if (b.kind === 'busy') {
      assertEq('F20 ① 忙时要能指名到"谁"', b.task, 'factor_mine')
    }

    // ── ② 只有写者占锁：纯只读的巡检不许占 ──
    //   （占锁会让一次慢的挖因子把巡检一起挡住 —— 把"只读观察"降级成"看情况能不能观察"）
    const writers = AUTONOMY_JOBS.filter((j) => j.evolution)
    const readers = AUTONOMY_JOBS.filter((j) => !j.evolution)
    assertTrue('F20 ② 有写共享产物的项占锁', writers.length >= 3, `只标了 ${writers.length} 项`)
    assertTrue(
      'F20 ② 纯只读项不许占锁',
      readers.every((j) => j.id === 'status'),
      `不该占锁的项：${readers.filter((j) => j.id !== 'status').map((j) => j.id).join('、')}`,
    )
    assertTrue(
      'F20 ② 写者里必须包含会写同一份 notes.jsonl 的两项',
      ['self_learn', 'news_watch'].every((id) => writers.some((j) => j.id === id)),
      'self_learn 与 news_watch 写同一份 data/learn/notes.jsonl，必须都在锁内',
    )

    // ── ③ 心跳只续自己的那一行（不许无条件覆盖成自己的）──
    assertTrue('F20 ③ 自己的锁能续心跳', heartbeatEvolutionLock('factor_mine', 1_000_200), '自己续不动自己的锁')
    assertTrue('F20 ③ 别人的任务名续不动我的锁', !heartbeatEvolutionLock('news_watch', 1_000_200), '别人用任务名就把我的锁续了')

    // ── ④ 释放带 task 条件：锁被抢走后，原持有者回来不许删掉新持有者的锁 ──
    assertTrue('F20 ④ 别的任务名释放不掉我的锁', !releaseEvolutionLock('news_watch'), '被别人释放了')
    assertTrue('F20 ④ 自己释放得掉', releaseEvolutionLock('factor_mine'), '自己释放不掉')
    assertEq('F20 ④ 释放后锁空闲', evolutionLockSnapshot(1_000_300).task, null)
    assertEq('F20 ④ 释放后下一项拿得到', acquireEvolutionLock('self_learn', 1_000_400).kind, 'acquired')

    // ── ⑤ 陈旧接管：持有者 pid 已不存在 ⇒ 必须能接管，且**留痕** ──
    //   构造"已死的持有者"：直接往台账里写一个不存在的 pid。
    //   （判据 B6：这个分支真会发生吗 —— 会，进程被 taskkill 就是这一支。）
    __resetEvolutionLockForTest()
    const db = getDb()!
    db.prepare('INSERT INTO evolution_flight (id, task, pid, started_at, heartbeat) VALUES (1, ?, ?, ?, ?)').run(
      'factor_mine',
      999_999_999, // 一个不可能存在的 pid
      1_000_000,
      1_000_000,
    )
    const stolen = acquireEvolutionLock('status_probe', 1_000_500)
    assertEq('F20 ⑤ 持有者进程已消失 ⇒ 可以接管', stolen.kind, 'acquired')
    assertTrue(
      'F20 ⑤ 接管必须留痕（否则"上一轮为什么没跑完"永远查不出来）',
      getEvents(0).some((e) => e.kind === 'EVOLUTION_LOCK_STOLEN'),
      '台账里没有 EVOLUTION_LOCK_STOLEN',
    )

    // ── ⑥ 心跳过期也能接管，且陈旧线与"正常耗时"不同量级 ──
    __resetEvolutionLockForTest()
    const h = acquireEvolutionLock('news_watch', 2_000_000)
    assertEq('F20 ⑥ 占位', h.kind, 'acquired')
    assertEq(
      'F20 ⑥ 心跳没到陈旧线时判忙（不许把正常的长任务判成死了）',
      acquireEvolutionLock('self_learn', 2_000_000 + LOCK_STALE_MS - 1).kind,
      'busy',
    )
    assertEq(
      'F20 ⑥ 心跳过了陈旧线可以接管',
      acquireEvolutionLock('self_learn', 2_000_000 + LOCK_STALE_MS + 1).kind,
      'acquired',
    )
    assertTrue(
      'F20 ⑥ 陈旧线必须显著大于实测最慢任务（判据 D8：同量级就是随机地雷）',
      LOCK_STALE_MS >= 5 * 164_000,
      `LOCK_STALE_MS=${LOCK_STALE_MS} 与实测最慢 164s 同量级`,
    )

    // ── ⑦ 自治集成：另一项持锁时，到期项被**推迟**而不是**失败** ──
    //   两者在界面上都长成"这一项没跑"，但指向的动作相反：
    //   推迟 = 等下一轮（什么都不用做）；失败 = 这一项坏了（要去查）。
    __resetEvolutionLockForTest()
    __resetAutonomyForTest()
    const held = acquireEvolutionLock('factor_mine', 3_000_000)
    assertEq('F20 ⑦ 先占住锁', held.kind, 'acquired')
    let ranCount = 0
    const f20Timers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = []
    let f20Tid = 0
    __setAutonomyDepsForTest({
      now: () => 3_000_000,
      setTimer: (fn, ms) => {
        f20Tid += 1
        f20Timers.push({ fn, ms, id: f20Tid, cancelled: false })
        return f20Tid
      },
      clearTimer: (h2) => {
        const t = f20Timers.find((x) => x.id === h2)
        if (t) t.cancelled = true
      },
      run: async () => {
        ranCount += 1
        return { ok: true, summary: 'stub' }
      },
    })
    startAutonomy({ jobs: AUTONOMY_JOBS.filter((j) => j.id === 'self_learn') })
    const maxD = Math.max(...AUTONOMY_JOBS.filter((j) => j.id === 'self_learn').map((j) => j.initialDelayMs))
    for (const t of f20Timers.filter((x) => !x.cancelled && x.ms <= maxD)) {
      t.cancelled = true
      t.fn()
    }
    await new Promise((r) => setTimeout(r, 30))
    assertEq('F20 ⑦ 被锁挡住时不许真去跑', ranCount, 0)
    const st = autonomyStatus().jobs.find((j) => j.id === 'self_learn')!
    assertEq('F20 ⑦ 记进"推迟"这一列', st.deferredCount, 1)
    assertEq('F20 ⑦ 不许记成失败', st.failCount, 0)
    assertEq('F20 ⑦ 也不许记成额度跳过（两者指向相反的动作）', st.skippedCount, 0)
    assertTrue(
      'F20 ⑦ 推迟要留独立账本事件并可指名',
      autonomyTicks(50).some((t) => t.job === 'self_learn' && (t.deferredOnly ?? '').includes('factor_mine')),
      '没有带持有者名字的 AUTONOMY_TICK_DEFERRED',
    )
    stopAutonomy('F20')
    __resetAutonomyDepsForTest()
    __resetAutonomyForTest()

    // ── ⑧ 任务抛异常时锁必须被释放（否则一个异常会让自进化停摆一刻钟）──
    __resetEvolutionLockForTest()
    let threw = false
    const f20bTimers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = []
    let f20bTid = 0
    __setAutonomyDepsForTest({
      now: () => 4_000_000,
      setTimer: (fn, ms) => {
        f20bTid += 1
        f20bTimers.push({ fn, ms, id: f20bTid, cancelled: false })
        return f20bTid
      },
      clearTimer: (h2) => {
        const t = f20bTimers.find((x) => x.id === h2)
        if (t) t.cancelled = true
      },
      run: async () => {
        threw = true
        throw new Error('夹具：这一轮任务故意抛异常')
      },
    })
    startAutonomy({ jobs: AUTONOMY_JOBS.filter((j) => j.id === 'news_watch') })
    const maxD2 = Math.max(...AUTONOMY_JOBS.filter((j) => j.id === 'news_watch').map((j) => j.initialDelayMs))
    for (const t of f20bTimers.filter((x) => !x.cancelled && x.ms <= maxD2)) {
      t.cancelled = true
      t.fn()
    }
    await new Promise((r) => setTimeout(r, 30))
    assertTrue('F20 ⑧ 夹具真的抛了', threw, '夹具没跑到，这条断言没有意义')
    assertEq('F20 ⑧ 抛异常后锁必须已释放', evolutionLockSnapshot(4_000_100).task, null)
    stopAutonomy('F20b')
    __resetAutonomyDepsForTest()
    __resetAutonomyForTest()

    // ── ⑨ ★ 排程不许有两条"同刻起跑"（否则后者**每轮**都被同一个赢家挡住）──
    //   锁是在"到期"那一刻抢的，而抢的顺序是固定的（= `AUTONOMY_JOBS` 的顺序）。
    //   若 A、B 两项的 `initialDelayMs` 相同 ⇒ 它们每轮都同刻到期 ⇒ A 永远赢、
    //   B 永远 `busy` 被顺延 ⇒ **B 一次都不会跑**，而账本上只留下"推迟"，
    //   从字面看不出这是永久性的（判据 C5：永久停摆与正常顺延长得一样）。
    //   ★ 做成机制而不是靠"记得错开"：撞了就红。
    //   现状的 initialDelayMs 互不相同，正是 `AUTONOMY_JOBS` 注释里那句
    //   「启动瞬间不该把所有任务一起打出去」—— 这里只是把那句话钉住。
    {
      const delays = AUTONOMY_JOBS.map((j) => j.initialDelayMs)
      const dup = [...new Set(delays.filter((d, i) => delays.indexOf(d) !== i))]
      assertEq(
        'F20 ⑨ 没有两条排程同刻起跑（同刻 = 后者每轮都被挡，永久不跑）',
        dup.length,
        0,
        `重复的 initialDelayMs=${dup.join('、')}（涉及：${AUTONOMY_JOBS.filter((j) => dup.includes(j.initialDelayMs)).map((j) => j.id).join('、')}）`,
      )
    }

    pass(
      'F20 进化单飞锁',
      '同进程也判忙（不照抄 instance_fence 的 pid 刷新）· 只写者占锁 · 心跳/释放都带 task 条件 · 死持有者可接管且留痕 · 被挡记"推迟"不记"失败" · 异常必释放 · 排程不撞车',
    )
  }

  // ══════════════ ⑭ 可逆清理：安全边界逐条 ══════════════
  //
  // 这一组判据守的是"清理器不许变成删文件器"。每条都要有**只有它**会命中的输入。
  {
    const root = mkdtempSync(join(tmpdir(), 'fleet-clean-'))
    const mk = (name: string, ageHours: number): void => {
      const p = join(root, name)
      writeFileSync(p, 'x'.repeat(64))
      const t = (Date.now() - ageHours * 3_600_000) / 1000
      utimesSync(p, t, t)
    }
    mk('_old_a.txt', 48)
    mk('_old_b.log', 72)
    mk('_fresh.txt', 1)
    mk('_v9_mdtable.mjs', 48)
    mk('_weird.xyz', 48)
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', '_nested.txt'), 'x')

    // ① 日志类扩展名在白名单里，但"不明扩展名"必须是 unsure —— 三态，不是两态。
    assertEq('F14 未知扩展名不判 ok', judgePath(root, '_weird.xyz', join(root, '_weird.xyz')).verdict, 'unsure')
    // ② 逃逸
    assertEq('F14 项目根之外 REFUSE', judgePath(root, '../outside.txt', join(root, '..', 'outside.txt')).verdict, 'refuse')
    // ③ 保留名单（实测抓到的漏洞：判定器原来不知道 KEEP 名单，把 _v9_mdtable.mjs 判成可清）
    assertEq('F14 保留名单里的文件 REFUSE', judgePath(root, '_v9_mdtable.mjs', join(root, '_v9_mdtable.mjs')).verdict, 'refuse')
    assertTrue(
      'F14 保留名单的拒绝理由要说出理由',
      judgePath(root, '_v9_mdtable.mjs', join(root, '_v9_mdtable.mjs')).why.includes('保留名单'),
      '拒绝理由没说清是保留名单',
    )
    // ④ 子目录里的（哪怕名字一样）不动 —— 且理由要指出"不在项目根"。
    const nested = judgePath(root, 'sub/_nested.txt', join(root, 'sub', '_nested.txt'))
    assertEq('F14 子目录里的不动', nested.verdict, 'refuse')

    const plan = planClean(root)
    assertEq('F14 只挑出该清的', plan.candidates.map((c) => c.path).sort().join(','), '_old_a.txt,_old_b.log')
    assertTrue(
      'F14 新文件被"正在被用着"挡下',
      plan.skipped.some((s) => s.path === '_fresh.txt' && s.why.includes('正在被用着')),
      `_fresh.txt 没有被 24 小时规则挡下：${JSON.stringify(plan.skipped)}`,
    )
    assertTrue(
      'F14 档下的理由要能说出小时数',
      plan.skipped.some((s) => /才 [\d.]+ 小时没动过/.test(s.why)),
      '理由里没有具体小时数',
    )

    // ⑤ 试跑**不许动任何文件**（"只算不落盘"必须名副其实）。
    const dry = runClean(root, { dryRun: true })
    assertEq('F14 试跑不移动任何文件', dry.moved.length, 0)
    assertEq('F14 试跑也不建 .trash 批次', dry.batchDir, null)
    assertTrue('F14 试跑后文件还在', existsSync(join(root, '_old_a.txt')), '试跑把文件动了')

    // ⑥ 真跑：移动而不是删除 —— 移走之后**能在 .trash 里按原相对路径找到**。
    const real = runClean(root, { dryRun: false })
    assertEq('F14 真跑移动了该移动的', real.moved.length, 2)
    assertTrue('F14 原位置已不在', !existsSync(join(root, '_old_a.txt')), '真跑之后文件还在原位 —— 那它到底动了什么？')
    assertTrue(
      'F14 文件在 .trash 里能找回来（可逆）',
      real.batchDir !== null && existsSync(join(real.batchDir, '_old_a.txt')) && existsSync(join(real.batchDir, '_old_b.log')),
      `.trash 里找不到被移走的文件：${real.batchDir ?? '（没有批次目录）'}`,
    )
    assertTrue('F14 保留名单的文件仍在原位', existsSync(join(root, '_v9_mdtable.mjs')), '保留名单里的工具被清掉了')
    assertTrue('F14 新文件仍在原位', existsSync(join(root, '_fresh.txt')), '刚写出来的文件被清掉了 —— 那它很可能正在被用着')
    assertEq('F14 真跑留了账本事件', getEvents(0).filter((e) => e.kind === 'FILE_TRASHED').length, 1)

    // ⑦ .trash 视图：**它的说明必须点明"本模块不会自动清 .trash"**（那步不可逆）。
    const tv = listTrash(root)
    assertEq('F14 .trash 视图能看到批次', tv.batches.length, 1)
    assertEq('F14 .trash 视图统计文件数', tv.totalFiles, 2)
    assertTrue('F14 .trash 不自动清理要在文案里说', tv.note.includes('不会自动清理 .trash'), `说明没写清：${tv.note.slice(0, 60)}`)

    // ⑧ 上限必须真的生效（构造 30 个候选，默认上限 20）。
    const root2 = mkdtempSync(join(tmpdir(), 'fleet-clean-cap-'))
    for (let i = 0; i < 30; i += 1) {
      const p = join(root2, `_many_${String(i).padStart(2, '0')}.txt`)
      writeFileSync(p, 'x')
      const t = (Date.now() - 48 * 3_600_000) / 1000
      utimesSync(p, t, t)
    }
    const cap = planClean(root2)
    assertEq('F14 单次上限生效', cap.candidates.length, CLEAN_MAX_ITEMS)
    assertTrue('F14 上限到了要说出来', cap.limitReached, '还有候选但 limitReached=false —— 用户会以为只有这么多')
    pass('F14 可逆清理边界', '保留名单 / 逃逸 / 子目录 / 未到期 / 未知扩展名五类都被挡下；试跑不动文件；真跑可恢复；上限生效')
  }

  // ══════════════ ⑮ 迭代挖掘：三种退出 + 「台账没推进」不许算一轮 ══════════════
  {
    const mkDeps = (
      left: Record<string, number>,
      acceptAll: boolean,
    ): { seen: string[][]; deps: Parameters<typeof mineFactors>[0] } => {
      const seen: string[][] = []
      return {
        seen,
        deps: {
          now: () => Date.now(),
          produce: (o) => {
            const id = WINDOW_SETS.find((s) => s.windows === o.windows)?.id ?? 'baseline'
            const remain = left[id] ?? 0
            const take = Math.min(o.count, remain)
            left[id] = remain - take
            return {
              specs: take,
              accepted: take,
              rejected: 0,
              unverifiable: 0,
              spaceRemaining: left[id],
              spaceTotal: 40,
              // ★ 每轮的 slug 必须**不同**，否则会命中"台账没推进"那条判据。
              slugs: Array.from({ length: take }, (_, i) => `${id}_w${String(remain - i)}_x`),
              dryRun: true,
            }
          },
          screen: (o) => {
            seen.push([...o.slugs])
            return {
              screened: o.slugs.length,
              accepted: acceptAll ? o.slugs.length : 0,
              rejected: acceptAll ? 0 : o.slugs.length,
              unverifiable: 0,
              acceptedSlugs: acceptAll ? [...o.slugs] : [],
              rejectedReasons: acceptAll ? [] : o.slugs.map((s) => ({ slug: s, reason: '每笔毛边际 0.4 bps < 每笔成本 5.2 bps' })),
              stale: 0,
              dryRun: true,
            }
          },
        },
      }
    }

    // ① 达标即停（不许硬跑满轮次）。
    const A = mkDeps({ baseline: 40, intraday: 40, swing: 40, position: 40 }, true)
    const ra = mineFactors(A.deps, { maxRounds: 5, targetProfitable: 3, countPerRound: 5, dryRun: true })
    assertEq('F15 达标即停', ra.stopReason, 'target-reached')
    assertTrue('F15 达标不用跑满轮次', ra.rounds.length < 5, `跑了 ${ra.rounds.length} 轮才停`)

    // ② 连续零过门要**真的换组**（旧实现只打了日志没换，6 轮只试了 1 组）。
    const B = mkDeps({ baseline: 12, swing: 12, intraday: 0, position: 0 }, false)
    const rb = mineFactors(B.deps, { maxRounds: 8, targetProfitable: 99, countPerRound: 4, dryRun: true })
    const setsTried = new Set(rb.rounds.map((r) => r.windowSetId)).size
    // ★★ 变异验证抓出的一条**假绿**（判据 6：这条断言的绿，别的修复顺带也能造成吗？）：
    //   第一版这里只断言 `setsTried >= 2`，而"试到第二组"这件事**靠"空间挖干净"那条路
    //   也能满足** —— 把"连续零过门就换组"整段删掉，它照样是绿的。
    //   夹具里基线组共 12 格、每轮取 4 ⇒ 不靠零过门判定的话，它要**用满 4 轮**才因空间耗尽让位。
    //   所以真正只有这条判据能救活的输入是"基线组被用了几轮"：
    //   连续 BARREN_LIMIT 轮零过门 ⇒ 第 BARREN_LIMIT+1 轮就该换掉它（= 2 轮），
    //   而空间耗尽那条路会得到 4 轮。两个数不相等，判据才钉得住。
    assertEq(
      `F15 连续 ${BARREN_LIMIT} 轮零过门就该换组（不是等空间挖完）`,
      rb.rounds.filter((r) => r.windowSetId === 'baseline').length,
      BARREN_LIMIT,
    )
    assertTrue('F15 试过不止一组窗口', setsTried >= 2, `只试了 ${setsTried} 组 —— "必要时换因子族"没有落地`)
    assertTrue(
      'F15 换组要写出理由',
      rb.rounds.some((r) => r.note.includes('连续') && r.note.includes('换下一组')),
      '换组的那一轮没有说明为什么换',
    )

    // ③ 所有组挖尽 ⇒ 与"轮次用尽"必须分开（下一步动作相反）。
    const D = mkDeps({ baseline: 0, intraday: 0, swing: 0, position: 0 }, false)
    const rd = mineFactors(D.deps, { maxRounds: 6, targetProfitable: 99, countPerRound: 4, dryRun: true })
    assertEq('F15 全挖尽与轮次用尽分开', rd.stopReason, 'all-sets-exhausted')
    assertTrue('F15 全挖尽时要说"不是还没挖够，是这组数据用尽了"', rd.verdict.includes('因子族已经用尽'), `文案没区分开：${rd.verdict.slice(0, 60)}`)

    // ④ 筛选吃的是**本轮**扩出来的那些，而不是"排序最前的那几条"。
    //    这是实测抓到的假进展：不改这里，第 2、3 轮筛的是同一批，输出逐字相同。
    //    ★ 夹具里**每一组都要留出空间** —— 第一版把 intraday 设成 0，
    //      于是第 3 轮直接进了"空间耗尽"分支、根本不筛，
    //      断言就红在"轮数不够"而不是"批次相同"。那种红会把人引向错误的修法。
    const E = mkDeps({ baseline: 40, intraday: 8, swing: 40, position: 8 }, false)
    mineFactors(E.deps, { maxRounds: 3, targetProfitable: 99, countPerRound: 4, dryRun: true })
    const allScreened = E.seen.flat()
    assertEq('F15 每轮只筛本轮扩出来的', new Set(allScreened).size, allScreened.length)
    assertEq('F15 三轮都真的筛了', E.seen.length, 3)
    assertTrue('F15 筛选真的换过批次', E.seen[0]!.join() !== E.seen[1]!.join(), '两轮筛的是同一批 —— 迭代是假的')

    // ⑤ 台账没推进 ⇒ 当场停，**不把"什么都没发生"报告成"又挖了一轮"**。
    const frozen = mkDeps({ baseline: 40, swing: 40, intraday: 0, position: 0 }, false)
    const frozenDeps = { ...frozen.deps, produce: (o: { count: number; windows: readonly number[]; dryRun: boolean }) => ({ specs: 3, accepted: 3, rejected: 0, unverifiable: 0, spaceRemaining: 30, spaceTotal: 40, slugs: ['same_1', 'same_2', 'same_3'], dryRun: o.dryRun }) }
    const rf = mineFactors(frozenDeps, { maxRounds: 5, targetProfitable: 99, countPerRound: 3, dryRun: true })
    assertEq('F15 台账没推进就停', rf.stopReason, 'index-not-advancing')
    assertTrue('F15 停的原因要能念出来', rf.verdict.includes('台账没有推进'), `文案没说清：${rf.verdict.slice(0, 60)}`)

    // ⑥ 被拒理由归并**必须保留负号**：`最差 -3%` 与 `最差 3%` 是"方向不成立"与"被成本吃掉"的分界。
    const G = mkDeps({ baseline: 40, intraday: 0, swing: 0, position: 0 }, false)
    const gDeps = { ...G.deps, screen: (o: { slugs: readonly string[]; limit: number; dryRun: boolean }) => ({ screened: o.slugs.length, accepted: 0, rejected: o.slugs.length, unverifiable: 0, acceptedSlugs: [], rejectedReasons: [{ slug: 'a', reason: '毛收益：最差折 -3.10% / 平均折 5%' }, { slug: 'b', reason: '毛收益：最差折 2.20% / 平均折 5%' }], stale: 0, dryRun: true }) }
    const rg = mineFactors(gDeps, { maxRounds: 1, targetProfitable: 99, countPerRound: 2, dryRun: true })
    assertEq('F15 负号保留：两种事因不合并', rg.rejectTop.length, 2)
    assertTrue(
      'F15 负数在归并后仍看得出是负的',
      rg.rejectTop.some((t) => t.reason.includes('-#%')) && rg.rejectTop.some((t) => /[^-#]#%/.test(t.reason)),
      `归并后分不出正负：${JSON.stringify(rg.rejectTop)}`,
    )
    pass('F15 迭代挖掘', '达标/挖尽/轮次用尽三态分开；零过门真换组；只筛本轮批次；台账没推进就停；负号保留')

    // ★ 变异验证抓出的**第二个真弱点**：上面整段用的是注入的 `screen` 桩，
    //   所以"只筛本轮扩出来的"这件事只证明了**编排在传 slugs**，
    //   而 `factorStrategyService` 里**真的按 slugs 过滤**这件事根本没被测到 ——
    //   把那个过滤删掉，上面所有断言照旧全绿（M10 就是这样跑的）。
    //   所以这里直连真实筛选器（只读，`dryRun: true` 不写策略台账）。
    {
      const { index } = readFactorIndex(defaultIndexPath())
      const acc = index.rows.filter((r) => r.state === 'accepted')
      if (acc.length === 0) {
        // 空台账时跳过并**说出原因**。对着空数据断言会变成"对正确输入报错"。
        pass('F15 直连真实筛选器', '当前因子台账没有已接受的因子，跳过（这不是失败，是没有素材）')
      } else {
        // 传一个不存在的 slug ⇒ 应该一条都不筛（`picked` 为空，连回测都不会跑，很快）。
        const none = screenAcceptedFactors({ slugs: ['__no_such_slug__'], dryRun: true })
        assertEq('F15 直连真实筛选器时 slugs 真的在过滤', none.rows.length, 0)
        // ★ 对照半边：不传 slugs 时必须能取到。少了它，上面那条对
        //   "筛选器根本读不到台账"同样会绿 —— 那是一种假绿（判据 6）。
        const one = screenAcceptedFactors({ limit: 1, dryRun: true })
        assertEq('F15 对照：不传 slugs 时按排序取前 N 条', one.rows.length, 1)
        pass('F15 直连真实筛选器', `台账有 ${acc.length} 条已接受因子；slugs 过滤与"取前 N 条"两种行为都真的成立`)
      }
    }
  }

  // ══════════════ ⑯ 「不改源码」必须是机制，不是承诺 ══════════════
  {
    const learnerSrc = readSource('F16 学习不改码', 'server/fleet/learner.ts')
    for (const bad of ['writeFileSync', 'unlinkSync', 'renameSync', 'rmdirSync']) {
      assertTrue(
        'F16 学习模块不许有写/删文件的调用',
        !learnerSrc.includes(bad),
        `learner.ts 里出现了 ${bad} —— "只产提案不改码"这条红线被破了`,
      )
    }
    assertTrue(
      'F16 学习只允许 append（提案单）',
      learnerSrc.includes('appendFileSync'),
      '连提案落盘都没有的话，"学习"就没有产物了',
    )
    // 清理模块只许 rename，不许 unlink —— 可逆性是它进自动循环的唯一理由。
    const cleanerSrc = readSource('F16 清理可逆', 'server/fleet/cleaner.ts')
    for (const bad of ['unlinkSync', 'rmSync', 'rmdirSync']) {
      assertTrue('F16 清理模块不许真删', !cleanerSrc.includes(bad), `cleaner.ts 里出现了 ${bad} —— 自动清理变成了不可逆动作`)
    }
    assertTrue('F16 清理只许移动', cleanerSrc.includes('renameSync'), '清理没有用 rename —— 那它到底怎么清的？')

    // 提案解析的三态：提了 / 明确说无需改进 / 没读懂，各自可区分。
    const p1 = parseProposals('提案：改文案\n依据：账本 7 条\n动作：把 X 改成 Y [低]')
    assertEq('F16 能解析出提案', p1.proposals.length, 1)
    assertEq('F16 提案带风险档', p1.proposals[0]?.risk, 'low')
    assertTrue('F16 明确说"无需改进"不算没读懂', !parseProposals('这些数字里没有发现需要改的地方。').parseFailed, '把模型照要求答的实话当成了没读懂')
    assertTrue('F16 答非所算没读懂', parseProposals('嗯，我看了一下，感觉还行吧。').parseFailed, '既没提案也没说无需改进，却被当成了正常结果')
    assertTrue('F16 空文本既不算没读懂也不算有提案', !parseProposals('').parseFailed && parseProposals('').proposals.length === 0, '空文本被当成了"没读懂"或有提案')
    pass('F16 红线机制化', '学习模块零写文件调用、清理模块只 rename 不 unlink、提案解析三态可分')
  }

  // ══════════════ ⑰ 跨层口径：计划表不许抢语音层自己认领的说法 ══════════════
  //
  // ★ 这一条是"两条口径"的**机制化检查**（判据 8：同一个业务动作有几条实现路径？）。
  //   它刻意**不另抄一份句子清单** —— 它直接读 `scripts/voice-smoke.ts` 里那张意图表
  //   （表就是事实），把"期望意图不是 dispatch_task"的句子逐条喂给 `planTask()`：
  //   计划表**一句都不许认领**。理由是顺序：语音层的意图解析排在计划表**之后**，
  //   被认领 = 那句话的归属被静默换掉。
  //
  //   为什么必须机制化：本轮 Ci 就是这么红的 —— `status` 计划里多了 `/系统状态/`
  //   与一个含「系统」的疑问句模式，于是"系统现在什么情况"从"读系统实况"
  //   变成"跑四个成员的巡检"（`test:voice` S14 变红）。这类抢占的特点是
  //   **单看两个正则各自都挺合理**，只在收口成一句人话时才显形；
  //   一条一条去猜"还有没有别的"是猜不完的，所以从两个表出发做全量比对。
  //   探针 `_probe_r17_collide.ts` 用的就是这个办法，这把它固化成门。
  {
    const voiceSmoke = readSource('F17 语音意图表', 'scripts/voice-smoke.ts')
    const rows = [...voiceSmoke.matchAll(/\{\s*text:\s*'([^']+)'\s*,\s*intent:\s*'([^']+)'/g)].map((m) => ({
      text: m[1]!,
      intent: m[2]!,
    }))
    assertTrue('F17 意图表读到了', rows.length >= 20, `只读到 ${rows.length} 条 —— 正则或表结构变了，这一条就成了永远为真的判据`)
    const stolen = rows
      .filter((r) => r.intent !== 'dispatch_task')
      .filter((r) => planTask(r.text).plan !== null)
    assertTrue(
      'F17 计划表不认领语音层的说法',
      stolen.length === 0,
      `这 ${stolen.length} 句被计划表抢走了（语音层排在后面，归属会被静默换掉）：${stolen
        .map((r) => `「${r.text}」原本是 ${r.intent}、被认成 ${planTask(r.text).plan?.id}`)
        .join('；')}`,
    )
    pass('F17 跨层口径', `语音意图表 ${rows.length} 条逐条比对，计划表没有抢走任何一条非派活说法`)
  }

  // ══════════════ F18 · 「自治循环」这个名字只能有一个主人 ══════════════
  //
  // ★★ 治的是用户实测原话：
  //   「让它一键启动自治循环的时候，总览控制台内的『一键启动自治循环』按钮应该被按下」。
  //
  //   实测现象：语音说启动，它确实动了 —— 但动的是**舰队周期排程**；
  //   而总览页那颗按钮控制的是**交易自动驾驶**（`/autopilot/start`）。
  //   两件不同的东西共用一个名字，用户看到的必然是"嘴上说成功了、界面上没动"。
  //
  //   这一组断言的是**修法的形状**，不是修法本身有没有跑起来：
  //   ① 名字「自治循环」映射到的链条里，必须同时有排程与自动驾驶两个成员；
  //   ② 那两个成员指向的函数，必须是总览页/HTTP 端点用的**同一个**；
  //   ③ 状态变化必须落到一个**有具名读者**的主题上。
  //   缺任意一条，两件事就会各自漂移回自己的版本 —— 而那正是这次的现象。
  {
    const startPlan = planTask('一键启动自治循环').plan
    assertTrue('F18 启动循环的计划存在', startPlan !== null, '「一键启动自治循环」必须能被计划表接住')
    assertEq('F18 启动链条含舰队排程', startPlan!.chain.includes('autonomy_start'), true)
    assertEq('F18 启动链条含交易自动驾驶', startPlan!.chain.includes('autopilot_start'), true, '少了它 ⇒ 嘴上说启动了、总览按钮不动')

    const stopPlan = planTask('停止自治循环').plan
    assertEq('F18 停止链条含舰队停机', stopPlan!.chain.includes('autonomy_stop'), true)
    assertEq('F18 停止链条含自动驾驶停机', stopPlan!.chain.includes('autopilot_stop'), true, '停一半 ⇒ 界面显示已停、舰队还在按周期干活')

    // ② 同一个函数，同一个状态源 —— 「按下状态」不许有第二个真相来源。
    const apStart = fleetAgent('autopilot_start')
    const apStop = fleetAgent('autopilot_stop')
    assertTrue('F18 启停成员已注册', apStart !== null && apStop !== null, '')
    const overview = readSource('F18 总览面板', 'src/pages/OverviewPage.tsx')
    assertTrue('F18 总览按钮读同一个状态', overview.includes('getAutopilotStatus'), '按钮的按下状态必须来自自动驾驶状态轮询')
    assertTrue('F18 总览按钮调同一个启动', overview.includes('autopilotStart'), '')
    const http = readSource('F18 编排端点', 'server/index.ts')
    assertTrue('F18 HTTP 端点调同一个启动', http.includes('startAutopilot('), '面板与 HTTP 必须调同一个函数，否则就是两条实现路径')
    assertTrue(
      'F18 启停成员声明复用的是那条路径',
      apStart!.reuses.includes('startAutopilot') && apStop!.reuses.includes('stopAutopilot'),
      'reuses 里必须点名真实函数，否则"舰队专用实现"会从这里长出来',
    )

    // ③ 状态变化要有具名读者（判据 10：有端点 ≠ 有人读）。
    const topic = fleetTopic('autopilot.changed')
    assertTrue('F18 主题已登记', topic !== null, '没登记的主题发出去也没人知道它存在')
    assertEq('F18 主题是消费面类', topic!.kind, 'surface', '登记成 agent 类会触发死信箱判据')
    const consumer = fleetConsumer('ui:overview')
    assertTrue('F18 消费面具名', consumer !== null, '')
    assertTrue(
      'F18 消费面证据可核对',
      readSource('F18 消费面证据', consumer!.evidence!.file).includes(consumer!.evidence!.marker),
      `证据 ${consumer!.evidence!.file} 里找不到 ${consumer!.evidence!.marker} —— 接线被撤了而门是绿的`,
    )
    pass('F18 自治循环只有一个主人', '启动/停止各含两个成员，指向同一个函数与同一个状态源，且状态有具名读者')
  }

  // ══════════════ F19 · 「用户点名 + 能原样退回去」才配免掉那一次确认 ══════════════
  //
  // ★★ 治的是用户**第二次**实测的原话：
  //   「我实测说『启动自治循环』，总览那颗按钮还是没有变成『停止自治循环』」。
  //
  //   F18 那一组**全绿** —— 链的形状、函数、状态源、订阅者，一条不缺。
  //   可链**从来没有被执行过**：每一次都得用户再说一句「确认」，
  //   而他不知道还得说第二遍，于是"他说了"与"按钮变了"之间断了一整段。
  //
  //   ⇒ 这是判据 2 的镜像：**断言必须对着用户的验收点**。
  //     F18 断言的是"机制正确"，这一组断言的是"机制真的会被走到"，
  //     以及"走到的凭据是可核对的、不是自报的"。
  //
  //   ★ 判据 3 在这里的具体用法：`undoPlan` 写成布尔 `reversible: true` 也能让
  //     "可逆"看起来成立，但那是由**我自己**填的一个字 —— 没有任何输入能让它变红。
  //     写成指针之后，"它指向的计划真的存在吗""它们真的互为逆吗"才有
  //     **只有它**会命中的输入。
  {
    const startPlan = FLEET_TASK_PLANS.find((p) => p.id === 'autonomy-start')!
    const stopPlan = FLEET_TASK_PLANS.find((p) => p.id === 'autonomy-stop')!
    assertTrue('F19 两个自治计划都在表里', startPlan !== undefined && stopPlan !== undefined, '')

    // ① 撤销路径是**指针**，且指得回来（单向声明 = 自报可逆）
    assertEq('F19 启动指名撤销计划', startPlan.undoPlan, 'autonomy-stop')
    assertEq('F19 停止指名撤销计划', stopPlan.undoPlan, 'autonomy-start', '停止也要能再启动回来，否则"撤回"本身成了单向门')
    assertTrue('F19 撤销计划真的存在', undoPlanOf(startPlan) !== null, '指向一个不存在的计划 —— 那就是把"可逆"写成了自报，没有任何东西核对得了它')
    assertEq('F19 撤销关系互为逆', undoPlanOf(undoPlanOf(startPlan)!)?.id, startPlan.id, '')
    const oneWay = FLEET_TASK_PLANS.filter((p) => p.undoPlan !== undefined && undoPlanOf(p)?.undoPlan !== p.id)
    assertTrue(
      'F19 表里没有单向的撤销声明',
      oneWay.length === 0,
      `${oneWay.map((p) => p.id).join('、')} 声称可逆，但被它指名的计划不认为能退回来 —— 这种"可逆"只存在于声明者的嘴上`,
    )

    // ② 四个方向都要能构造出来（判据 5：可注入，才验得了"不过"）
    const readOnly = FLEET_TASK_PLANS.find((p) => !p.writes)!
    const noUndo = FLEET_TASK_PLANS.find((p) => p.writes && p.undoPlan === undefined)!
    assertTrue('F19 表里有只读计划与无撤销路径的写计划', readOnly !== undefined && noUndo !== undefined, '少了夹具，下面三条就退化成"恒真"')
    assertEq('F19 只读计划不问人', planNeedsConfirm(readOnly, false), false)
    assertEq('F19 无撤销路径必须问人', planNeedsConfirm(noUndo, true), true, `夹具用的是 ${noUndo.id}`)
    assertEq('F19 可逆 + 纸面 ⇒ 免确认', planNeedsConfirm(startPlan, true), false, '这条就是用户实测卡住的那一步')
    assertEq(
      'F19 可逆但实盘 ⇒ 仍要问人',
      planNeedsConfirm(startPlan, false),
      true,
      '撤销计划退得回系统状态，退不回已经打到交易所的单',
    )

    // ③ 免确认的名单**必须短到能一眼看完** —— 多一个都要在这里显式改写
    //
    // ★ 只统计 `writes: true` 的：只读计划（status / brain / lesson）**从来
    //   就不需要授权**，把它们算进"免确认名单"会把两个不同的东西混在一起 ——
    //   一个的免确认是"它改不了任何东西"，另一个是"它改了也能退回去"。
    //   这条断言第一次跑就是被这一点判红的，红得对（判据 2：检查器不许
    //   对正确的输入报错 —— 那次要修的是检查器，不是被测代码）。
    const beneficiaries = FLEET_TASK_PLANS.filter((p) => p.writes && !planNeedsConfirm(p, true)).map((p) => p.id)
    assertEq(
      'F19 免确认名单没有外溢',
      beneficiaries.join(','),
      'autonomy-start,autonomy-stop',
      '将来给别的计划加撤销路径时，这条会红 —— 那正是要让"放宽到哪一步"被人重新过一遍，而不是悄悄多出来一个',
    )

    // ④ 判据 10：有裁决函数 ≠ 有人调它（否则这一段就是"写好了没人用"）
    //   ★ 用 `readCode`（剥注释）而不是 `readSource`：这几条断言的是
    //     "源码里有没有真的调用"，而注释里提到函数名会让它**假绿** ——
    //     判据 5 的同一条：一条断言必须有**只有它**会命中的输入。
    const voice = readCode('F19 语音层', 'server/voice/service.ts')
    assertTrue('F19 语音层用的是同一份裁决', voice.includes('planNeedsConfirm('), '语音层自己判一次可逆性 = 第二份口径，两份迟早给出不同答案')
    assertTrue('F19 语音层从状态现读模式', voice.includes('autopilotStatus().mode'), '模式必须现读；由调用方自报"我是纸面"就是把闸门交给被检查的人')
    assertTrue(
      'F19 免确认也留痕',
      voice.includes('VOICE_PLAN_AUTORUN'),
      '少问一句是一次真实决定，必须能事后核对（判据 17：可逆动作才允许自动跑）',
    )

    // ⑤ 回话里**不许念计划表的 `why`** —— 那是写给开发者与面板看的
    assertTrue(
      'F19 回话不再念 why',
      !/speakable\(|planArgs?\.plan\.why/.test(voice),
      '`why` 里写着内部归因（"根因是…""用户实测反馈是…"）。用户实测听到的就是自己上次的反馈被原样念回来 —— 判据 19：说明文的读者不是耳朵',
    )
    pass('F19 免确认的凭据是可核对的', '撤销路径是指针且互为逆 · 四态可注入 · 名单不外溢 · 语音层接的是同一份裁决')
  }

  // ══════════════ 收尾 ══════════════
  archive()
  console.log(`[OK] FLEET SMOKE PASSED - ${scenarios.length} scenarios`)
}

main().catch((e) => {
  fail('F0 未捕获异常', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e))
})
