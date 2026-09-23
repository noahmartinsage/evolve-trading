/**
 * 永久记忆层的门禁（第四十六轮）
 *
 * ══ 这道门为什么必须存在 ═══════════════════════════════════════════════
 * 记忆层是本系统里**唯一一处**"系统的行为由用户没说过的话决定"的地方：
 * 用户说「买 100 U 的 BTC」，而杠杆/保护/场所可能来自**上一轮甚至上周**。
 * 所以它的失效方式全都**不报错**：
 *
 *   · 记忆没落盘 ⇒ 重启后它变成陌生人（答得上话，只是不记得任何前情）
 *   · 墓碑没生效 ⇒ 用户说"忘掉"，系统却照旧按那条偏好办事
 *   · 抽取太宽   ⇒ 用户每次下单都在改写长期偏好，下一笔被静默套上上次的杠杆
 *   · 召回没门槛 ⇒ 每一轮都注入一堆无关记忆，把真正相关的挤掉
 *   · 静默淘汰   ⇒ 用户说过一句要紧的话，三天后系统"记得"的是另一句
 *
 * ══ 只测语义不变量，不测数值 ═══════════════════════════════════════════
 * 不测"多少 token"、不测"分数等于几" —— 那些会随配置调整而变，
 * 测它们会把这道门变成维护负担。测的是：
 *   持久 · 去重 · 墓碑的双向 · 三态互不顶替 · 超限不静默 ·
 *   字面优先于指代 · 记忆不许改变意图 · 文案卫生。
 *
 * ══ 隔离 ═══════════════════════════════════════════════════════════════
 * ★ 全程指向 `artifacts/memory-smoke-<pid>/`，**绝不碰** `data/voice/facts.jsonl`。
 *   往用户的真实记忆里灌假事实比灌假日志危险得多：它会被当成"用户说过的话"召回。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  setMemoryRoot,
  memoryDir,
  readFacts,
  currentFacts,
  remember,
  forget,
  recall,
  speakRecall,
  recallAsContext,
  factByKey,
  factIdOf,
  noteTurn,
  recentTurns,
  lastMentionedSymbol,
  resetWorking,
  bindWorkingSid,
  hydrateWorkingFromTranscript,
  FACT_BUDGET_TOKENS,
  WORKING_TURNS,
  type MemoryFact,
} from '../server/voice/memory.ts'
import { extractFacts, detectCorrection } from '../server/voice/memoryExtract.ts'
import { parseIntent, resolveSymbol, mentionsReferent } from '../server/voice/intents.ts'

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

const ROOT = join(process.cwd(), 'artifacts', `memory-smoke-${process.pid}`)
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
setMemoryRoot(ROOT)
bindWorkingSid('smoke')

const FACTS = join(memoryDir(), 'facts.jsonl')
/** 固定时刻，避免断言依赖真实时钟（`recall` 接受 `now`）。 */
const NOW = 1_770_000_000_000

/** 造一条事实的输入。`sid`/`turnId` 只影响出处，用常量即可。 */
function input(kind: MemoryFact['kind'], key: string, text: string, value?: string | number | boolean) {
  return {
    kind,
    key,
    text,
    ...(value !== undefined ? { value } : {}),
    source: { sid: 'smoke', turnId: 1, at: NOW, confidence: 'explicit' as const },
  }
}

// ═══════════════════ M1 持久化：这就是"永久"两个字 ═══════════════════
console.log('\n── M1 落盘与读回：重启之后它还得认识你 ──')

check('M1 写入后文件真的在盘上（不是只在内存里）', () => {
  const r = remember(input('preference', 'leverage', '习惯用 3 倍杠杆', 3))
  assert.equal(r.ok, true, '前提：这一条应当写得进去')
  assert.ok(existsSync(FACTS), `记忆文件不存在：${FACTS}`)
})

check('M1 读回拿到同一份事实（含结构化取值）', () => {
  const facts = currentFacts()
  const lev = facts.find((f) => f.key === 'leverage')
  assert.ok(lev, '读不回 leverage —— 记忆没有真正落盘')
  assert.equal(lev.value, 3)
  // ★ 出处必须能回到某一轮：没有出处的"记忆"与"猜"在事后查证里长得一样
  assert.equal(lev.source.sid, 'smoke')
  assert.equal(typeof lev.source.turnId, 'number')
})

check('M1 另起一次读取（等价于重启进程）仍拿得到', () => {
  // `readFacts()` 每次都从盘上读，没有内存缓存 ⇒ 它就是"新进程"看到的东西
  const fresh = readFacts()
  assert.equal(fresh.unreadable, null, `读不到：${fresh.unreadable}`)
  assert.ok(fresh.facts.length >= 1, '新进程读到 0 条 —— 记忆不是持久的')
  assert.ok(factByKey('leverage', NOW), '按 key 精确取不到')
})

// ═══════════════════ M2 去重：一句话只能有一个主人 ═══════════════════
console.log('\n── M2 同一个 key 只许有一条（用户改主意 = 覆盖，不是新增） ──')

check('M2 同 key 写两次 ⇒ 只剩一条，且取后写的', () => {
  const r = remember({ ...input('preference', 'leverage', '习惯用 5 倍杠杆', 5), source: { sid: 'smoke', turnId: 2, at: NOW + 1000, confidence: 'explicit' } })
  assert.equal(r.ok, true)
  assert.equal(r.supersededId, factIdOf('preference', 'leverage'), '覆盖要留下被覆盖的是哪一条')
  const all = currentFacts().filter((f) => f.key === 'leverage')
  assert.equal(all.length, 1, `同一个 key 出现了 ${all.length} 条 —— 召回时念哪条取决于排序`)
  assert.equal(all[0].value, 5, '取到的不是后写的那条（用户改主意没生效）')
})

check('M2 配对：**不同** key 当然是两条（别把去重做过头）', () => {
  const r = remember(input('convention', 'protection', '要求下单都带止盈止损', true))
  assert.equal(r.ok, true)
  const keys = new Set(currentFacts().map((f) => f.key))
  assert.ok(keys.has('leverage') && keys.has('protection'), '两个不同的语义键必须共存')
})

// ═══════════════════ M3 墓碑：忘掉必须是双向的 ═══════════════════
console.log('\n── M3 墓碑：说忘掉要真忘掉，但重新说一遍要能记回来 ──')

check('M3 forget 之后那条事实不再出现', () => {
  const id = factIdOf('convention', 'protection')
  assert.ok(currentFacts().some((f) => f.id === id), '前提：它此刻在库里')
  assert.equal(forget(id, { sid: 'smoke', turnId: 3, at: NOW + 2000 }), true)
  assert.equal(currentFacts().some((f) => f.id === id), false, '★ 墓碑没生效 —— 用户以为忘掉了，系统照旧按它办事')
  assert.equal(factByKey('protection', NOW + 3000), null)
})

check('M3 配对：墓碑只对**写在它之前**的事实生效（重新说一遍要复活）', () => {
  const r = remember({ ...input('convention', 'protection', '要求下单都带止盈止损', true), source: { sid: 'smoke', turnId: 4, at: NOW + 4000, confidence: 'explicit' } })
  assert.equal(r.ok, true)
  assert.ok(factByKey('protection', NOW + 5000), '★ 复活失败 —— 墓碑把"重新记起"也一并杀掉了，那是相反方向的错')
})

check('M3 日志仍然是 append-only（墓碑是追加的一行，不是改写文件）', () => {
  const raw = readFacts()
  assert.equal(raw.badLines, 0, `有 ${raw.badLines} 行解析不了：${raw.badReasons.join(' | ')}`)
  // 覆盖 + 墓碑 + 复活 ⇒ 日志行数必然多于"当前有效条数"
  assert.ok(raw.facts.length > currentFacts().length, '日志没有保留历史行 —— 说明写路径不是追加式的')
})

// ═══════════════════ M4 三态：读不到 ≠ 没有 ═══════════════════
console.log('\n── M4 三态互不顶替：空 /= 读不到 ──')

check('M4 有库但无相关 ⇒ empty（且这不是错误）', () => {
  // ★ 必须换一个**从没写过事实**的根来测这一条。
  //   拿当前库测不了：库里已有 `convention`，而 convention/promise 按设计
  //   **总是**被召回（周期重述对抗 instruction fade-out，见 memory.ts 文件头 ④）。
  //   第一版就是这么写错的 —— 夹具错了，断言成了反向证据（skill 坑 2d）。
  const EMPTY = ROOT + '/empty-root'
  mkdirSync(EMPTY, { recursive: true })
  setMemoryRoot(EMPTY)
  try {
    const r = recall('今天天气如何', { now: NOW })
    assert.equal(r.state, 'empty', `不该是 ${r.state}：一个从没记过事的库里不该有命中`)
    assert.equal(r.hits.length, 0)
    assert.equal(r.note, null, '真的读到了且没有过期条目时，不该有 note')
  } finally {
    setMemoryRoot(ROOT)
  }
})

check('M4 命中 ⇒ remembered，且带可解释的分数构成', () => {
  const r = recall('杠杆 多少', { now: NOW })
  assert.equal(r.state, 'remembered')
  assert.ok(r.hits.length >= 1)
  const h = r.hits[0]
  assert.equal(typeof h.parts.relevance, 'number')
  assert.equal(typeof h.parts.recency, 'number')
  assert.equal(typeof h.parts.kind, 'number')
})

check('M4 ★ 读不到 ⇒ unreadable，**绝不**退化成 empty', () => {
  // 把 `facts.jsonl` 造成一个**目录**：`existsSync` 为真、`readFileSync` 抛 EISDIR。
  // ★ 这是本机唯一能稳定造出"读不到"的办法（Windows 上难以造权限问题）。
  const backup = ROOT + '/backup-facts.jsonl'
  renameSync(FACTS, backup)
  mkdirSync(FACTS, { recursive: true })
  try {
    const r = recall('杠杆', { now: NOW })
    assert.equal(r.state, 'unreadable', `★ 读不到被显示成了 ${r.state} —— 用户会以为"它失忆了"，而实际要去修文件`)
    assert.ok(r.note && r.note.length > 0, '读不到时必须有一句说明')
    const read = readFacts()
    assert.notEqual(read.unreadable, null, '`readFacts` 也必须报 unreadable（不能只说 0 条）')
  } finally {
    rmSync(FACTS, { recursive: true, force: true })
    renameSync(backup, FACTS)
  }
})

// ═══════════════════ M5 超限：不许静默淘汰 ═══════════════════
console.log('\n── M5 记不下了要说出来，不许悄悄挤掉一条 ──')

check('M5 写满之后新增 key 失败，并**交还**当前全部条目', () => {
  // 用长文本把预算填满（每条 ~150 token）
  const filler = '这是一条用来占满记忆预算的长期偏好说明'.repeat(8)
  let i = 0
  let full: ReturnType<typeof remember> | null = null
  while (i < 40) {
    const r = remember(input('preference', 'filler' + i, filler, i))
    if (!r.ok) {
      full = r
      break
    }
    i += 1
  }
  assert.ok(full, '塞了 40 条长事实都没满？预算是 ' + FACT_BUDGET_TOKENS + ' token，说明计数口径错了')
  assert.equal(full.ok, false)
  assert.equal(full.reason, 'budget-exceeded')
  assert.ok('current' in full && full.current.length > 0, '★ 超限时必须把现状交还给调用方 —— 否则它没法决定淘汰谁')
  assert.ok(full.neededTokens > full.budgetTokens, '报出来的口径要自洽')
})

check('M5 配对：**改主意**（同 key 覆盖）在满库时也必须成功', () => {
  // 用户说"以后用 5 倍"，而库里已经有一条同样 token 量级的 leverage。
  // ★ 这条修的是"用户想改，系统说记不下了" —— 它看起来像预算问题，
  //   实际是把"替换"错算成了"新增"。
  const r = remember({ ...input('preference', 'leverage', '习惯用 7 倍杠杆', 7), source: { sid: 'smoke', turnId: 9, at: NOW + 9000, confidence: 'explicit' } })
  assert.equal(r.ok, true, `满库时改主意被拒了：${r.ok === false ? r.reason : ''}`)
  assert.equal(factByKey('leverage', NOW)?.value, 7)
})

// ═══════════════════ M6 压缩：裁了要说出来 ═══════════════════
console.log('\n── M6 预算裁剪必须报告丢了什么 ──')

check('M6 命中多于预算时，droppedIds/truncatedIds 非空', () => {
  const r = recall('杠杆 止损 记忆预算 长期偏好 filler', { now: NOW, limit: 12 })
  assert.equal(r.state, 'remembered')
  const dropped = r.droppedIds.length + r.truncatedIds.length
  assert.ok(dropped > 0, `一条都没裁（命中 ${r.hits.length} 条、${r.tokens}/${r.budgetTokens} token）—— 那预算就没起约束作用`)
  assert.ok(r.failureReason === null || typeof r.failureReason === 'string')
})

check('M6 配对：只有一条短事实时**不许**无故裁剪', () => {
  const r = recall('习惯用 7 倍杠杆', { now: NOW, limit: 1 })
  assert.equal(r.droppedIds.length, 0, '明明装得下却报了丢弃 —— 那是误报，会训练人忽略这个字段')
  assert.equal(r.truncatedIds.length, 0)
})

// ═══════════════════ M7 抽取：最危险的一处 ═══════════════════
console.log('\n── M7 抽取不许被下单指令污染（否则每笔单都在改偏好） ──')

check('M7 ★ 含下单动作的句子**一条都不抽**', () => {
  const cases = [
    '用3倍杠杆买100U的BTC',
    '以后每次都用3倍杠杆开多BTC',
    '以后加仓都按 100U 来',
  ]
  for (const c of cases) {
    assert.deepEqual(extractFacts(c), [], `「${c}」被抽出了事实 —— 下单参数正在污染长期偏好`)
  }
})

check('M7 ★ 配对：「记住 X」是显式例外，即使 X 里有动作词也要记', () => {
  // ★ 这一条我在第一版里放进了坏值列表 —— **夹具写错了**。
  //   用户说「记住以后买BTC都带止损」时，"记住"已经明确宣告了它是一条**约定**，
  //   而它描述的是"以后每一笔"而不是一笔具体的单。拒抽的后果是：
  //   用户明确要求记住的事，系统静默地没记 —— 他会以为记下了。
  const f = extractFacts('记住以后买BTC都带止损')
  assert.equal(f.length, 1, '显式记忆要求被动作词误挡了')
  assert.equal(f[0].kind, 'convention')
  assert.ok(f[0].text.includes('止损'))
})

check('M7 配对：明确的长期偏好必须抽得到', () => {
  const lev = extractFacts('以后都用3倍杠杆')
  assert.equal(lev.length, 1, `抽到 ${lev.length} 条`)
  assert.equal(lev[0].key, 'leverage')
  assert.equal(lev[0].value, 3)
  // ★「以后下单都要带止损」含「下单」但**不含方向词、不含金额** ⇒ 它是一条约定，不是一笔单。
  //   第一版把「下单」也收进了动作词表，于是这一句被拒抽 —— 那是个真缺陷（已修）。
  const prot = extractFacts('以后下单都要带止损')
  assert.equal(prot.length, 1, `「以后下单都要带止损」应当抽到约定，实际 ${prot.length} 条`)
  assert.equal(prot[0].key, 'protection')
})

check('M7 配对：「现在/这次」不算长期性标记', () => {
  for (const c of ['现在用3倍杠杆', '这次用3倍杠杆', '今天用3倍杠杆']) {
    assert.deepEqual(extractFacts(c), [], `「${c}」被当成了长期偏好 —— "当下"与"长期"混了`)
  }
})

check('M7 显式要求记忆一律抽（用户已经明说了要记）', () => {
  const f = extractFacts('记住我不做早饭前的单')
  assert.equal(f.length, 1)
  assert.equal(f[0].confidence, 'explicit')
})

check('M7 配对：系统的措辞风格不该被抽成用户事实', () => {
  // 抽取的输入只有一个来源（用户原话）。若从系统回话抽，下面这些句子
  // 就会把**系统的表达**记成"用户说过的话" —— 而用户从未说过。
  for (const c of ['我按仿真模式执行', '当前用的是仿真模式', '已经帮你切到测试网']) {
    assert.deepEqual(extractFacts(c), [], `「${c}」—— 系统口吻的句子被抽成了用户事实`)
  }
})

// ═══════════════════ M8 指代消解：字面优先 ═══════════════════
console.log('\n── M8 指代消解：只在字面全落空时才用上文 ──')

check('M8 「它」+ 上文 ⇒ 消解到上文的标的', () => {
  assert.equal(resolveSymbol('它的资金费率呢', ['BTCUSDT', 'ETHUSDT'], 'BTCUSDT'), 'BTCUSDT')
})

check('M8 ★ 配对：句子同时有**指代**与**字面标的** ⇒ 字面赢', () => {
  /**
   * ★★ 这一条的夹具写作方式本身是个教训（判据 B1：断言必须有一个
   *    **只有它能命中**的输入）。
   *
   *    第一版用的是「ETHUSDT 的资金费率呢」——它**不含任何指代词**，
   *    所以 `mentionsReferent` 为 false，第 ④ 条根本不会触发。
   *    实测：把第 ④ 条提到最前面去重跑，这道门**照样全绿**。
   *    也就是说那条断言当时是在被字面判据"顶替"，它测的是别的东西。
   *
   *    换成同时含「它」与字面标的的句子，才真正把"顺序"这件事钉住：
   *    顺序错了（指代优先）会把一个**明说了标的**的提问
   *    答成另一个币的价 —— 而那个价是真的，用户不会怀疑。
   */
  const symbols = ['BTCUSDT', 'ETHUSDT']
  assert.equal(resolveSymbol('它和 ETHUSDT 差多少', symbols, 'BTCUSDT'), 'ETHUSDT', '★ 指代抢走了用户明说的标的')
  assert.equal(resolveSymbol('BTCUSDT 的那个呢', symbols, 'ETHUSDT'), 'BTCUSDT', '★ 同上（另一方向）')
})

check('M8 配对：句子只有指代、没有字面标的 ⇒ 才轮到第 ④ 条', () => {
  assert.equal(resolveSymbol('它和那个差多少', ['BTCUSDT', 'ETHUSDT'], 'BTCUSDT'), 'BTCUSDT')
})

check('M8 配对：ETHUSDT 这种"字面说得清"的句子即使带上文也不该变', () => {
  assert.equal(resolveSymbol('ETHUSDT 的资金费率呢', ['BTCUSDT', 'ETHUSDT'], 'BTCUSDT'), 'ETHUSDT')
})

check('M8 配对：没有上文时**不许**猜', () => {
  assert.equal(resolveSymbol('它的资金费率呢', ['BTCUSDT', 'ETHUSDT'], null), null)
  assert.equal(resolveSymbol('它的资金费率呢', ['BTCUSDT', 'ETHUSDT']), null)
})

check('M8 配对：上文标的已不在池子里 ⇒ 不消解', () => {
  assert.equal(resolveSymbol('它多少钱', ['ETHUSDT'], 'BTCUSDT'), null)
})

check('M8 配对：宽泛的「这个」不在窄表里（误命中会给错标的的答案）', () => {
  assert.equal(mentionsReferent('这个怎么算'), false)
  assert.equal(mentionsReferent('其他的呢'), false, '「其他」不是指代')
  assert.equal(resolveSymbol('这个怎么算', ['BTCUSDT'], 'BTCUSDT'), null)
})

// ═══════════════════ M9 记忆不是新通道（最关键的一条） ═══════════════════
console.log('\n── M9 ★★ 记忆不许改变意图判定 ──')

check('M9 同一句话，带/不带 referTo，解析结果**逐字段一致**', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT']
  const mk = (referTo: string | null) => ({ symbols, markPrice: () => 76000, referTo })
  const sentences = [
    '买100块钱的比特币',
    'ETHUSDT 现在多少钱',
    '平仓',
    '止损5% 止盈10%',
    '帮我看看',
  ]
  for (const s of sentences) {
    const a = parseIntent(s, mk(null))
    const b = parseIntent(s, mk('BTCUSDT'))
    // ★ 这些句子里**没有一句**依赖指代，所以两边的结果必须一模一样。
    //   有差异就说明记忆改了意图 —— 那是红线①（记忆不是行动通道）。
    assert.deepEqual(
      { ...b, resolvedByReference: undefined },
      { ...a, resolvedByReference: undefined },
      `「${s}」在带 referTo 时解析结果变了 —— 记忆正在改变意图判定`,
    )
  }
})

check('M9 真的用了指代时：只许把"认不出来"变成"认出来"，且必须打标', () => {
  const mk = (referTo: string | null) => ({ symbols: ['BTCUSDT', 'ETHUSDT'], markPrice: () => 76000, referTo })
  const noRef = parseIntent('它多少钱', mk(null))
  const withRef = parseIntent('它多少钱', mk('ETHUSDT'))
  assert.equal(noRef.slots?.symbol ?? null, null, '前提：没有上文时认不出标的')
  assert.equal(withRef.slots?.symbol, 'ETHUSDT', '有上文时应当消解')
  // ★ 打标是硬要求：不打标就等于"猜"，用户没有任何线索能发现自己被猜了
  assert.equal(withRef.resolvedByReference, true, '消解了却没打标 —— 系统会不说一声就用推断出的标的')
  /**
   * ★ 这一条我在第一版里写成了"意图必须完全相同"，**那是错的**。
   *   消解的**价值**恰恰是把 `unknown` 变成答得上来的那个意图
   *   （「它多少钱」没有上文时系统根本不知道在问什么）。
   *   真正要防的是**另一个方向**：把一个已经认出来的意图**换掉**
   *   （例如「平掉它」本被判成 `close_position`，却被消解成了 `query_market`）。
   */
  assert.equal(withRef.intent, 'query_market', '消解的价值就是让它能答上来')
  assert.notEqual(noRef.intent, withRef.intent, '前提：这一例里消解确实改变了意图（否则上面那条是空断言）')
})

check('M9 ★★ 已认出的意图不许被消解换掉（这是"记忆不是行动通道"的边界）', () => {
  const mk = (referTo: string | null) => ({ symbols: ['BTCUSDT', 'ETHUSDT'], markPrice: () => 76000, referTo })
  // ★ 只放"本身字面就认得出来"的句子 —— 这些句子在**没有上文**时也有确定意图，
  //   所以消解只该补标的，一个字都不该改意图。
  //   不放「它多少钱」那类：它们无上文时是 `unknown`，而消解的价值正是
  //   把 `unknown` 变成本例里那个能答上来的意图（第一版把两者混在一个列表里，
  //   断言就成了反向证据）。
  const cases = [
    '平掉它', // ★ 本轮的收获：这句以前判 `query_market`（答现价、不平仓），已修 CLOSE_WORDS
    '把BTCUSDT平掉',
    '清掉它',
    'BTCUSDT 的持仓',
    'ETHUSDT 现在多少钱',
  ]
  for (const s of cases) {
    const a = parseIntent(s, mk(null))
    const b = parseIntent(s, mk('BTCUSDT'))
    assert.notEqual(a.intent, 'unknown', `夹具前提不成立：「${s}」在没有上文时就该认得出来`)
    assert.equal(b.intent, a.intent, `「${s}」的意图被消解改掉了：${a.intent} → ${b.intent}`)
  }
})

// ═══════════════════ M10 工作记忆（记得上一句的实体） ═══════════════════
console.log('\n── M10 工作记忆：指代消解读的就是它 ──')

check('M10 noteTurn 之后能取到最近提到的标的', () => {
  resetWorking()
  noteTurn({ turnId: 1, at: NOW, user: 'BTC 多少钱', assistant: '76000', symbols: ['BTCUSDT'], intent: 'query_market' })
  assert.equal(lastMentionedSymbol(), 'BTCUSDT')
  noteTurn({ turnId: 2, at: NOW + 1000, user: '它呢', assistant: '…', symbols: [], intent: 'query_market' })
  // ★ 这一轮没提标的（靠指代），所以"最近提到的"仍是上一轮的 —— 这正是要的性质
  assert.equal(lastMentionedSymbol(), 'BTCUSDT', '空标的的轮次不该把上文抹掉')
})

check('M10 回归：hydrate 的历史轮次用负数 id，与本会话的正数 id 不相交', () => {
  resetWorking()
  const page = {
    turns: [3, 2, 1].map((n) => ({
      sid: 'old',
      turnId: n, // ★ 就是会与本次会话撞号的那种 id
      at: NOW - n * 1000,
      state: 'answered',
      user: { text: `历史第 ${n} 轮 BTC`, intent: 'query_market' },
      assistant: { text: 'ok' },
    })),
  }
  const n = hydrateWorkingFromTranscript(page, () => ['BTCUSDT'])
  assert.equal(n, 3)
  const turns = recentTurns()
  assert.ok(turns.every((t) => t.turnId < 0), '历史轮次必须用负数 id')
  // ★ 关键：本会话新说的第 1 轮不许顶掉历史
  noteTurn({ turnId: 1, at: NOW, user: '新的一句 ETH', assistant: 'ok', symbols: ['ETHUSDT'], intent: 'query_market' })
  const after = recentTurns()
  assert.equal(after.length, 4, `历史被顶掉了：现在只有 ${after.length} 轮`)
  assert.equal(after[0].user.includes('历史'), true, '最早的那一轮历史不见了')
  assert.equal(lastMentionedSymbol(), 'ETHUSDT')
})

check('M10 hydrate 是**替换**而不是追加（重连不许把历史灌两遍）', () => {
  resetWorking()
  const page = {
    turns: [{ sid: 'old', turnId: 1, at: NOW, state: 'answered', user: { text: 'BTC' }, assistant: { text: 'ok' } }],
  }
  hydrateWorkingFromTranscript(page, () => ['BTCUSDT'])
  hydrateWorkingFromTranscript(page, () => ['BTCUSDT'])
  assert.equal(recentTurns().length, 1, `灌了两遍 ⇒ ${recentTurns().length} 轮，窗口被重复内容填满`)
})

check('M10 滑动窗口封顶', () => {
  resetWorking()
  for (let i = 0; i < WORKING_TURNS + 5; i += 1) {
    noteTurn({ turnId: i + 1, at: NOW + i, user: 'x' + i, assistant: 'y', symbols: [], intent: null })
  }
  assert.equal(recentTurns().length, WORKING_TURNS)
})

// ═══════════════════ M11 文案卫生 ═══════════════════
console.log('\n── M11 播报文案是念给人听的 ──')

check('M11 复述里不许出现 undefined / NaN / markdown 星号 / 叠句号', () => {
  resetWorking()
  const facts = currentFacts()
  const s = speakRecall(facts, 0)
  assert.ok(s !== null, '库里有事实施，复述不该是 null')
  assert.equal(/undefined|NaN|\[object|\*\*/.test(s), false, `文案里有脏字符：${s}`)
  assert.equal(s.includes('。。'), false, `叠句号（听觉上像卡了一下）：${s}`)
  assert.equal(s.includes('；。'), false, `句读叠了：${s}`)
})

check('M11 配对：没有任何事实时返回 null（不硬凑一句话）', () => {
  assert.equal(speakRecall([], 0), null)
  assert.equal(speakRecall([], 3), '我有 3 条记忆过期了，这一轮用不上。')
})

check('M11 给模型的上下文必须带出处（模型会把它当事实引用）', () => {
  const r = recall('杠杆', { now: NOW })
  const ctx = recallAsContext(r)
  assert.ok(ctx.includes('第') && ctx.includes('轮'), `模型上下文缺出处：${ctx.slice(0, 120)}`)
  assert.ok(ctx.includes('用户明确说过') || ctx.includes('系统推断'), '必须说清这条是用户说的还是系统推的')
})

// ═══════════════════ M12 纠正：推不出就不许动库 ═══════════════════
console.log('\n── M12 纠正："你记错了"不许猜着删 ──')

check('M12 推不出 key ⇒ key 为 null（调用方据此**不动库**）', () => {
  const c = detectCorrection('你记错了')
  assert.ok(c, '「你记错了」应当被认成纠正')
  assert.equal(c.key, null, '推不出针对哪一条时必须给 null，不许猜')
})

check('M12 配对：「不是 3 倍，是 5 倍」能推出 key', () => {
  const c = detectCorrection('不是 3 倍，是 5 倍')
  assert.ok(c)
  assert.equal(c.key, 'leverage')
  assert.equal(c.rejected, '3 倍')
  assert.equal(c.corrected, '5 倍')
})

check('M12 配对：裸「不对」**不算**纠正（否则每句普通否定都在删记忆）', () => {
  for (const s of ['这个数不对吧', '不是这样算的', '现在不对']) {
    assert.equal(detectCorrection(s), null, `「${s}」被当成了记忆纠正 —— 它会把一条偏好静默抹掉`)
  }
})

// ═══════════════════ 收尾 ═══════════════════
try {
  rmSync(ROOT, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log('')
if (failures.length > 0) {
  console.error(`[FAIL] MEMORY SMOKE FAIL - ${failures.length} 项未通过`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `MEMORY SMOKE PASSED (${passed}/${passed}) · 事实预算 ${FACT_BUDGET_TOKENS} token · 工作窗口 ${WORKING_TURNS} 轮`,
)
console.log('  只摘语义不变量：持久 / 去重 / 墓碑双向 / 三态互不顶替 / 超限不静默 / 字面优先于指代 / 记忆不改意图')
