/**
 * 界面动作通道烟测 —— 桌宠能不能真的按下那颗按钮
 *
 * ── 它守的是哪一类失效 ────────────────────────────────────────────────
 * 用户的实测反馈是「它只完成了现货 10 元买入，严重偏离用户指令」，
 * 以及「一键启动自治循环的时候总览那颗按钮应该被按下」。两句话指向同一类问题：
 * **桌宠说的话没有落到真实的界面动作上**。所以这条通道的证明方式不是
 * "注册表看起来合理"，而是：
 *   · 注册表里每一个 id 都能在源码里找到那颗按钮（登记了没人执行＝孤岛）；
 *   · 源码里每一颗 `data-ui` 都在注册表里（有按钮没登记＝桌宠碰不到）；
 *   · 一句人话能确定性地命中它，并且**只命中一处**。
 *
 * ── 本轮加进来的三件事，每一件都对应一个真实缺陷 ──────────────────────
 * ① **一句话只能有一个主人**（U22）。「一键启动自治循环」在 `fleet/plans.ts`
 *    里已经是一条计划，`intents.ts` 里白纸黑字写着"给它单开一个意图就会多出
 *    一条通路（判据 8）"。如果按钮通道也来认领，这句话就会**执行两次**
 *    （计划链一次、点按钮一次），而两次都成功、两次都留痕 —— 看日志也发现不了。
 *    所以带 `voicePlan` 的按钮必须返回 `owned`，把话递回舰队。
 * ② **两段式按钮不许点**（U15）。`news.run` 是"上膛 / 再点开跑"两段式，
 *    桌宠只能点一下 ⇒ 结果是"上膛了但没跑"却回报成功 ——
 *    正是"看着成功的半成品"这一类失效。宁可拒绝并说清替代说法。
 * ③ **文案必须对得上**（U04）。`news.run` 在源码里的文案是三态的
 *    （抓取中… / 再点开跑 / 立即跑一轮），注册表里原先写的那句
 *    **在源码中根本不存在**。名字对不上时，用户说"按一下立即跑一轮"
 *    我们却按了另一个东西，而两边的名字都看着合理。
 *
 * ── 也顺手钉住播报文案的红线（U06）────────────────────────────────────
 * `speaks` 是**念给用户听**的话，不许含 markdown 星号 ——
 * 念出来会变成"星号星号这是真的下单星号星号"。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UI_ACTIONS,
  UI_PAGES,
  UI_CLAIM_TTL_MS,
  UI_TASK_TTL_MS,
  claimPendingTasks,
  completeUiAction,
  enqueueUiAction,
  listTasks,
  renderQueueSpeech,
  resolveExplicitPress,
  resolveUiAction,
  setUiWorkspaceRoot,
  uiAction,
  uiQueuePath,
  uiWorkspaceRoot,
  waitForUiAck,
} from '../server/uiActions.ts'
import {
  DEFAULT_SYMBOL_EXCHANGE,
  DEFAULT_SYMBOL_INTERNAL,
  MARKET,
  byExchange,
  byInternal,
  exchangeSymbols,
  internalSymbols,
  normalizeExchange,
  toExchange,
} from '../src/market/registry.ts'
// ★ 一次性参数通道也是纯逻辑 ⇒ **import 进来断言它的真值表**，
//   不去源码里找"那几个词出现过"（判据 36：注释里提一下就假绿）。
import {
  UI_REQUEST_TTL_MS,
  deliverUiRequest,
  peekUiRequest,
  resetUiRequestForTest,
  takeUiRequest,
  withdrawUiRequest,
} from '../src/ui/uiRequest.ts'
import { resolveHorizon } from '../server/forecastService.ts'
// ★ 过期判据是纯函数，**import 进来断言真值表**，不去源码里找那几个词出现过
//   （"出现"会被邻居顶替：产生它的那行改掉、消费端字面量还在 ⇒ 假绿，判据 36）。
import { deriveGateStale, driftBps, gateStaleMessage } from '../src/trading/gateStale.ts'
import { FLEET_TASK_PLANS } from '../server/fleet/index.ts'

const ROOT = process.cwd()
let pass = 0
let fail = 0
const failures: string[] = []

function ok(id: string, cond: boolean, note: string): void {
  if (cond) {
    pass++
    console.log(`  ✅ ${id} ${note}`)
  } else {
    fail++
    failures.push(`${id} ${note}`)
    console.log(`  ❌ ${id} ${note}`)
  }
}

function eq<T>(id: string, got: T, want: T, note: string): void {
  ok(id, JSON.stringify(got) === JSON.stringify(want), `${note}（期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}）`)
}

/** 读源码：把 src 下所有 tsx/ts 拼成一份，用于"名字在不在源码里"的核对。 */
function readSrcSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(tsx?|ts)$/.test(e.name)) out.push({ path: p, text: readFileSync(p, 'utf8') })
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

const SRC = readSrcSources()
const ALL_SRC = SRC.map((s) => s.text).join('\n')

function srcHas(needle: string): boolean {
  return ALL_SRC.includes(needle)
}

// ───────────────────────── 冒烟开始 ─────────────────────────

console.log('\n界面动作通道烟测\n')

console.log('【U01-U02】登记表自身的完整性')
// ── U01：UI_PAGES 与 Store.tsx 的 PageId 逐字一致 ──
const storeText = SRC.find((s) => s.path.endsWith(join('store', 'Store.tsx')))?.text ?? ''
const m = storeText.match(/export type PageId = ([^\n]+)/)
const storePages = m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : []
eq('U01', UI_PAGES.map((p) => p.id), storePages, 'UI_PAGES 与 Store 的 PageId 逐字同序一致')

// ── U02：id 唯一 ──
const ids = UI_ACTIONS.map((a) => a.id)
const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
eq('U02', dup, [], '动作 id 全局唯一（重复的会静默覆盖，后写的赢）')

console.log('\n【U03-U06】注册表 ↔ 源码 双向对账（判据 10：有端点 ≠ 有人读）')
// ── U03：登记了 → 源码里真有这颗按钮 ──
const orphan = UI_ACTIONS.filter((a) => !srcHas(`data-ui="${a.id}"`)).map((a) => a.id)
eq('U03', orphan, [], '每个登记的动作在源码里都有对应的 data-ui（登记了没人执行＝孤岛）')

// ── U04：屏幕上那段字真的存在 ──
//
// ★ 这一条最初写成"label 必须出现在源码里"，结果对**正确的**输入报错：
//   随状态变化的按钮（"立即跑一轮" / "保存并生效（3）"）根本没有一个固定文案，
//   而 `terminal.submit` 整段都是动态的。所以判据改成：
//   **要么** `screenText` 在源码里真实存在，**要么** 写明为什么没有它。
//   （判据 2：会不会对正确的输入报错；判据 24：`null` 不许退化成随便填一个。）
const screenBad = UI_ACTIONS.filter((a) => a.screenText !== null && !srcHas(a.screenText)).map(
  (a) => `${a.id}("${a.screenText}")`,
)
eq('U04', screenBad, [], '每个动作的 screenText 都真实存在于源码里（用户是照着屏幕念的）')
const nullNoNote = UI_ACTIONS.filter((a) => a.screenText === null && !(a.screenTextNote ?? '').trim()).map((a) => a.id)
eq('U04b', nullNoNote, [], 'screenText 为 null 的动作必须写明理由（不许沉默地留空）')

// ── U05：源码里的 data-ui → 都登记了 ──
//
// ★ 只收**字面量**：`src/ui/useUiActionRunner.ts` 里那句
//   `[data-ui="${t.actionId}"]` 是执行器**按 id 查元素**的代码，
//   不是一颗按钮。第一版没排除它，于是它自己把自己报成了"未登记的按钮"——
//   典型的"检查对正确的输入报错"。
const declared = new Set(ids)
const inSrc = new Set<string>()
for (const s of SRC) {
  for (const mm of s.text.matchAll(/data-ui="([^"]+)"/g)) {
    const v = mm[1]!
    if (v.includes('${') || v.includes('{')) continue
    inSrc.add(v)
  }
}
const unregistered = [...inSrc].filter((x) => !declared.has(x))
eq('U05', unregistered, [], '源码里的每颗 data-ui 都在注册表里（有按钮没登记＝桌宠碰不到）')

// ── U06：播报文案不许含 markdown ──
const mdInSpeech = UI_ACTIONS.filter((a) => /[*`#]|\*\*/.test(a.speaks)).map((a) => a.id)
eq('U06', mdInSpeech, [], 'speaks 不含 markdown 标记（它是念给用户听的）')

console.log('\n【U07-U08】与舰队计划表对账（判据 29：一句话有几个主人）')
// ── U07：voicePlan 必须指向真实存在的计划 ──
const planIds = new Set(FLEET_TASK_PLANS.map((p) => p.id))
const dangling = UI_ACTIONS.filter((a) => a.voicePlan && !planIds.has(a.voicePlan)).map((a) => a.id)
eq('U07', dangling, [], '每个 voicePlan 都指向真实存在的舰队计划（断链即失败）')

// ── U08：同一个主人下 writes 必须一致 ──
const byPlan = new Map<string, typeof UI_ACTIONS>()
for (const a of UI_ACTIONS) {
  if (!a.voicePlan) continue
  byPlan.set(a.voicePlan, [...(byPlan.get(a.voicePlan) ?? []), a])
}
const inconsistent = [...byPlan.entries()]
  .filter(([, arr]) => new Set(arr.map((a) => a.writes)).size > 1)
  .map(([p]) => p)
eq('U08', inconsistent, [], '同一个 voicePlan 下的动作 writes 一致（否则同一件事一半要确认、一半不要）')

console.log('\n【U09-U13】一句话 → 一颗按钮（确定性解析）')
// ── U09：带 voicePlan 的按钮必须返回 owned，不许被抢 ──
//
// ★ 短语里**必须带页面名**：`monitor.autopilot.start` 的 label 只有两个字（「启动」），
//   不带页面名时分数 0.58 过不了 0.60 门线 —— 那是**刻意的**，见 U09b。
const ownedCases = UI_ACTIONS.filter((a) => a.voicePlan)
const ownedBad: string[] = []
for (const a of ownedCases) {
  const page = UI_PAGES.find((p) => p.id === a.page)!
  const r = resolveUiAction(`${page.label}页帮我按一下${a.label}`)
  if (!r || r.kind !== 'owned' || r.plan !== a.voicePlan) ownedBad.push(`${a.id}(${r?.kind ?? 'null'})`)
}
eq('U09', ownedBad, [], '带 voicePlan 的按钮一律返回 owned 且 plan 与声明一致')

// ── U09b：短名字不带页面名 → weak（列候选问一句），不是 null、更不是 action ──
const rShort = resolveUiAction('帮我按一下启动')
ok(
  'U09b',
  rShort?.kind === 'weak' && rShort.candidates.some((c) => c.id === 'monitor.autopilot.start'),
  `「帮我按一下启动」返回 weak 并列出候选（实得 ${rShort?.kind ?? 'null'}）—— 屏幕上明明写着「启动」，不该回"没听懂"`,
)
ok(
  'U09c',
  rShort?.kind === 'weak' && rShort.candidates.length === 1,
  '只有 1 个候选时仍然走 weak —— 因为"没点名页面"这件事本身就是不确定的来源',
)

// ── U10：不带 voicePlan、非两段式、非"只许人点"的动作必须点得着 ──
const clickable = UI_ACTIONS.filter((a) => !a.voicePlan && !a.twoStage && !a.operatorOnly)
const unreachable: string[] = []
for (const a of clickable) {
  const page = UI_PAGES.find((p) => p.id === a.page)!
  // ★ 用 `labelAlt` 里**用户真会说的那句**去试，而不是用 `label`（那是我们内部的名字）。
  //   这一条同时证明了"用户照着自己的说法喊，也能命中"。
  const saying = (a.labelAlt ?? [a.label])[0]!
  const r = resolveUiAction(`${page.label}页按一下${saying}`)
  if (!r || r.kind !== 'action' || r.spec.id !== a.id) unreachable.push(`${a.id}(${r?.kind ?? 'null'})`)
}
eq('U10', unreachable, [], '每颗可点按钮都能被「<页面>页按一下<用户说法>」唯一命中')

// ── U11：只"提到"按钮不算要按（问一句 ≠ 写一笔）──
eq('U11', resolveUiAction('我看到总览页有个一键启动自治循环'), null, '没有动作词的"提到"不认领')

// ── U11b：疑问句里既有动作词又有按钮名 → 仍然不认领 ──
//
// ★ 这一条是**接进语音层之后才暴露**的：动作词表里有「帮我」，
//   而「帮我解释一下什么是启动」同时含「帮我」与「启动」（系统监控页那颗按钮），
//   于是它被判成"要按按钮" —— 用户问一句、系统按一下。
//   这正是本项目最贵的一类错误，所以它必须在门禁里有一条只属于它的断言。
const interrogatives = [
  '帮我解释一下什么是启动',
  '系统监控页的启动是干什么用的',
  '按一下保存并生效会怎么样',
  '总览控制台能干什么',
]
const interroBad = interrogatives.filter((q) => resolveUiAction(q) !== null)
eq('U11b', interroBad, [], '疑问句一律不认领（问一句 ≠ 按一下）')

// ── U12：完全无关的话不认领 ──
eq('U12', resolveUiAction('今天天气怎么样'), null, '无关的话不认领（<0.6 一律去澄清，不猜）')

// ── U13：14 个页面逐个可导航 ──
const navBad = UI_PAGES.filter((p) => {
  const r = resolveUiAction(`打开${p.label}`)
  return !r || r.kind !== 'action' || r.spec.id !== `nav.${p.id}`
}).map((p) => p.id)
eq('U13', navBad, [], '14 个页面逐个可被「打开<页面名>」命中')

console.log('\n【U24】严格档：明说"按/点"时，按钮通道有权抢在只读问答之前')
//
// ★ 为什么必须有这一档（端到端实测抓出来的）：
//   只读问答（`ask_agents` / `query_risk`）看到"提到页面 / 领域"就认领。
//   用户说「风控中心页跑一次沙盒演练」，收到的是一份**风控状态汇报**，
//   而他要做的是**把那个按钮按下去**。这两件事在日志里都"成功"。
//   `resolveUiAction` 单独测不出来 —— 它俩的关系只有在**顺序**上才暴露，
//   所以这一组的断言必须钉住"严格档认识哪一句"，而不是宽档认不认识。

// ── U24a：用户明说"跑一次"→ 严格档认领那颗写按钮 ──
const s24 = resolveExplicitPress('风控中心页跑一次沙盒演练')
ok(
  'U24a',
  s24?.kind === 'action' && s24.spec.id === 'risk.sandbox.run',
  `「风控中心页跑一次沙盒演练」被严格档认领为 risk.sandbox.run（实得 ${s24?.kind ?? 'null'}${s24?.kind === 'action' ? ':' + s24.spec.id : ''}）`,
)

// ── U24b：严格档**不做导航**（导航留在宽档那一份里）──
//    否则「打开 Agent 舰队页」会在只读问答之前被抢，而"打开某页"不是发布命令。
eq('U24b', resolveExplicitPress('打开交易终端'), null, '严格档不抢页面导航（导航是宽档的事）')

// ── U24c：按钮文案**本身就是疑问句**时照样能命中 ──
//    系统监控页那颗写着「这计划能接吗」，用户是照着屏幕念的，那不是在提问。
const s24c = resolveExplicitPress('Agent 舰队页按一下这计划能接吗')
ok(
  'U24c',
  s24c?.kind === 'action' && s24c.spec.id === 'agents.plan.check',
  `「…按一下这计划能接吗」命中 agents.plan.check（实得 ${s24c?.kind ?? 'null'}${s24c?.kind === 'action' ? ':' + s24c.spec.id : ''}）`,
)

// ── U24d：真提问仍被挡（把命中的按钮文案挖掉后，剩下的还有疑问标记）──
//    这条是 U24c 的**反向**，缺了它上面那条就可以靠"干脆不判疑问句"蒙混过关。
const q24d = '跑一次沙盒演练是干什么用的'
eq('U24d', resolveExplicitPress(q24d), null, '挖掉按钮文案后仍是疑问句 ⇒ 不认领（问一句 ≠ 按一下）')

// ── U24e：没有严格动作词时不认领，哪怕宽档会认 ──
//    「帮我看看」在宽口径里是动作词，在严格口径里不是 —— 这正是两档的分界。
eq('U24e', resolveExplicitPress('帮我看看总览控制台'), null, '宽口径的动作词（帮我看看）不足以让严格档抢在前面')

// ── U24f：严格档没把握时**放弃**，不列候选 ──
//    它站在只读问答之前，用"你是不是想说"顶掉一条答得上来的只读回答不划算。
eq('U24f', resolveExplicitPress('按一下启动'), null, '严格档没把握时放弃（窄档才列候选问一句）')
ok(
  'U24g',
  resolveUiAction('按一下启动')?.kind === 'weak',
  '同一个输入在宽档里是 weak（列候选）—— 两档的分工可核对',
)

console.log('\n【U25】反向：按钮通道不许吞掉"要真下单"的说法')
//
// ★ 这一组是 U24a 的**代价**：严格档抢在只读问答之前，位置上是**在订单处理之前**
//   （只读问答本身就排在订单前面，所以"排在订单后"做不到 —— 第一版源码断言
//   就是这么写错的，被 S15 抓出来）。既然位置保不住，就得**逐句验**：
//   凡是听起来像真下单的话，严格档必须全部让路。
//   服务端还有一道 `!isDangerous(parsed.intent)` 护栏（见 voice-smoke S15），
//   两处是**纵深**关系而不是重复：这一组验解析器，那一处验接线。
const orderPhrases = [
  '按一下帮我买 BTC',
  '点一下买入 BTC 100U',
  '按一下提交下单',
  '点一下卖出 ETH',
  '帮我按计划买入 BTC',
  '按一下平仓',
  '按下急停',
]
// ★ 判据是"**不许变成可点的动作**"，不是"必须返回 null"：
//   合格的拒绝有两种 —— `null`（当没听懂，交给后面的规则）与
//   `human`（听懂了但只许人点，附一条下一步动作）。
//   写成"必须 null"会把正确的 `human` 判红，而那是**检查本身出错**（判据 2）。
const swallowed = orderPhrases.filter((p) => resolveExplicitPress(p)?.kind === 'action')
eq('U25', swallowed, [], '听起来像真下单的说法，严格档一律不许当成可点按钮（按面板上那颗「买入」只切方向，不是下单）')

// ── U25b：上述说法里确实**有**按钮名（否则 U25 是靠"啥都没匹配上"蒙过去的假绿）──
//    没有这一条，U25 只要把按钮表清空就永远绿 —— 那是"对正确输入不报错、对错误输入也不报错"。
const namedButYielding = ['按一下买入 BTC 100U', '点一下卖出 ETH'].filter((p) => {
  const scored = UI_ACTIONS.filter((a) => p.includes(a.label) || (a.labelAlt ?? []).some((v) => p.includes(v)))
  return scored.length > 0
})
eq(
  'U25b',
  namedButYielding.length,
  2,
  '这两句**确实**含面板按钮名（「买入」「卖出」）—— 所以 U25 不是靠"没匹配上"蒙过去的',
)

// ── U26：`operatorOnly` 那一档 —— 听出来了，但**不代按** ──
//
// ★ 这一档是 U25 抓出来的：`terminal.submit`（屏幕上那颗「提交下单」）的名字
//   确实会被用户念到，所以它**必须能被解析出来**（否则用户得到"没听懂"）；
//   但按下去的后果取决于"面板里现在填着什么"，而桌宠看不见 ——
//   盲按一次不是"什么都没发生"，是**拿残留内容真提交一笔**，然后回报"已按下"。
//   所以它既不能被当成无关的话，也不能被当成可点的按钮。
const specSubmit = UI_ACTIONS.find((a) => a.id === 'terminal.submit')
ok('U26a', specSubmit?.operatorOnly === true, 'terminal.submit 被标成"只许人点"')
const r26 = resolveExplicitPress('按一下提交下单')
ok('U26b', r26?.kind === 'human' && r26.spec.id === 'terminal.submit', `它是第五态 human，不是 action（实得 ${r26?.kind ?? 'null'}）`)
ok(
  'U26c',
  resolveUiAction('交易终端页按一下提交下单')?.kind === 'human',
  '宽档同样是 human —— 两档在这一档上不许有分歧',
)
// ── U26d：反向 —— 它不许变成 `owned` ──
//    两者的**下一步动作相反**（去找舰队 vs 让人把指令说全），
//    压成一档会给出错误指引（判据 25）。
ok('U26d', r26?.kind !== 'owned', '不许压成 owned —— 那一档的下一步动作是"去找舰队"，与这里相反')

console.log('\n【U14-U16】拒绝的三态互不顶替（判据 25）')
const ws = mkdtempSync(join(tmpdir(), 'evolve-ui-'))
mkdirSync(join(ws, 'data', 'ui'), { recursive: true })

// ── U14：writes 缺确认 → 拒 ──
const w1 = enqueueUiAction(ws, 'risk.params.save', { requestedBy: 'test' })
ok('U14', !w1.ok && w1.reason === 'UI_ACTION_NEEDS_CONFIRM', `writes:true 缺 confirmed 被拒（${w1.ok ? '竟然放行' : w1.reason}）`)

// ── U15：两段式 → 拒，且**真的没落盘** ──
const before = listTasks(ws, { limit: 200 }).length
const w2 = enqueueUiAction(ws, 'news.run', { requestedBy: 'test', confirmed: true })
const after = listTasks(ws, { limit: 200 }).length
ok('U15', !w2.ok && w2.reason === 'UI_ACTION_TWO_STAGE', `两段式按钮被拒（${w2.ok ? '竟然放行' : w2.reason}）`)
ok('U15b', after === before, `两段式被拒时队列没变（${before} → ${after}）—— 拒绝不等于"排了但没跑"`)

// ── U16：不存在的 id → 拒，且给近邻建议 ──
const w3 = enqueueUiAction(ws, 'overview.autopilot', { requestedBy: 'test', confirmed: true })
ok('U16', !w3.ok && w3.reason === 'NO_SUCH_UI_ACTION', `未知 id 被拒（${w3.ok ? '竟然放行' : w3.reason}）`)
ok('U16b', !w3.ok && (w3.speech.includes('一键启动自治循环') || w3.speech.includes('接近')), '未知 id 时给出近邻建议（不是干巴巴一句"没有"）')

console.log('\n【U17-U19】队列流转：排 → 认领 → 回报')
// ── U17：端到端 ──
const e1 = enqueueUiAction(ws, 'agents.refresh', { requestedBy: 'voice' })
ok('U17a', e1.ok === true, '只读动作无需确认即可入队')
const taskId = e1.ok ? e1.task.id : ''
const p1 = listTasks(ws, { limit: 200 }).filter((t) => t.status === 'pending')
ok('U17b', p1.length === 1, `队列里有且仅有 1 条待执行（实得 ${p1.length}）`)
const c1 = claimPendingTasks(ws, 'win-A')
ok('U17c', c1.length === 1 && c1[0]!.id === taskId, '第一个窗口取到了活')
const afterClaim = listTasks(ws, { limit: 200 }).find((t) => t.id === taskId)
ok('U17d', afterClaim?.status === 'claimed' && afterClaim.stale === false, '取活后状态是 claimed 且没过期')

// ── U18：第二个窗口拿不到同一条 ──
const c2 = claimPendingTasks(ws, 'win-B')
ok('U18', c2.length === 0, `第二个窗口拿不到已被认领的活（实得 ${c2.length}）—— 防重复执行`)

const done = completeUiAction(ws, taskId, { ok: true, detail: '点过了', requestedBy: 'win-A' })
ok('U18b', done.ok === true && listTasks(ws, { limit: 200 }).find((t) => t.id === taskId)?.status === 'done', '回报后状态流转到 done')

// ── U19：TTL 三态 —— 过期不是"没排过" ──
const ws2 = mkdtempSync(join(tmpdir(), 'evolve-ui-stale-'))
mkdirSync(join(ws2, 'data', 'ui'), { recursive: true })
const oldAt = Date.now() - UI_TASK_TTL_MS - 5_000
writeFileSync(
  uiQueuePath(ws2),
  JSON.stringify({
    type: 'enqueue',
    id: 'stale0000001',
    at: oldAt,
    actionId: 'agents.refresh',
    page: 'agents',
    requestedBy: 'test',
  }) + '\n',
  'utf8',
)
const st = listTasks(ws2, { limit: 50 })[0]
ok('U19a', st?.stale === true && st.status === 'pending', '过了 TTL 的待执行被标成 stale 且仍是 pending')
const speech = renderQueueSpeech(ws2)
ok('U19b', speech.includes('不等于没排过'), '过期的说法是"排了没来取"，不是"没排过"')
ok('U19c', speech.includes('查前端'), '过期时给出下一步动作（去查前端），而不是重复点')

console.log('\n【U20-U22】收口断言')
// ── U20：三条拒绝 reason 两两不同 ──
const reasons = [w1.ok ? '' : w1.reason, w2.ok ? '' : w2.reason, w3.ok ? '' : w3.reason]
eq('U20', new Set(reasons).size, 3, '三种拒绝的 reason 两两不同（合成一个＝排查方向跑偏）')

// ── U21：工作区根可注入 ──
setUiWorkspaceRoot(ws)
eq('U21a', uiWorkspaceRoot(), ws, 'uiWorkspaceRoot 可注入（服务端与语音必须落在同一份队列上）')
const e2 = enqueueUiAction(uiWorkspaceRoot(), 'agents.plan.check', { requestedBy: 'test' })
ok('U21b', e2.ok === true && existsSync(uiQueuePath(ws)), '注入后入队落在注入的目录里')
setUiWorkspaceRoot(ROOT)

// ── U22：用户那句话的唯一主人 ──
const userPhrase = '帮我按一下一键启动自治循环'
const r22 = resolveUiAction(userPhrase)
ok('U22a', r22?.kind === 'owned', `「${userPhrase}」的唯一主人是舰队计划，不是按钮通道（实得 ${r22?.kind ?? 'null'}）`)
ok(
  'U22b',
  r22?.kind === 'owned' && r22.plan === 'autonomy-start',
  '它被递回给 autonomy-start 计划 —— 那颗按钮的状态会跟着变，因为两条路调的是同一个 startAutopilot()',
)
// 反向：这颗按钮仍然不许**直接**入队（否则一句话执行两次）
const w22 = enqueueUiAction(ws, 'overview.autopilot.start', { requestedBy: 'test', confirmed: true })
ok('U22c', w22.ok === true, '按钮通道本身仍然可用（人工/其它路径直接指定 id 时不挡）—— 挡的只是"由那句话自动认领"')
// ── U22d：`operatorOnly` 同理 —— 挡的只是"由那句话自动认领"，不是这条通道 ──
const w26 = enqueueUiAction(ws, 'terminal.submit', { requestedBy: 'test', confirmed: true })
ok('U22d', w26.ok === true, 'terminal.submit 也能被显式 id 入队（人/界面直投不挡）—— 挡的只是桌宠自己念到它')

console.log('\n【U23】反向：这只按钮的文案例外要说得出来')
const specNews = uiAction('news.run')
ok('U23', specNews?.twoStage === true, 'news.run 被标成两段式（源码里确实是 runArmed 两段）')
const specOv = uiAction('overview.autopilot.start')
ok('U23b', specOv?.voicePlan === 'autonomy-start', 'overview.autopilot.start 被标了专属主人')

console.log('\n【U27】"谁按的"必须可查（多窗口下认领记录要能指名到窗）')
//
// ★ 这一组是**端到端实测抓出来的**：应用会同时开多个窗口（启动器在默认浏览器
//   打开面板、桌宠窗是另一个），而队列是"取活即认领"——哪一窗先轮询到就哪一窗按。
//   于是一窗看到的现象是「我排了、队列说已按下、可我这窗的界面没动」，
//   与「通道坏了」**长得一模一样**（判据 24），而下一步动作相反：
//   一个要去修代码，一个什么都不用做。
//   把窗标识写进认领与回报记录，这个误判当场就能排除。
// ★ 它在什么条件下会变红：执行器不再报自己的窗 id（改回笼统的 'ui'），
//   或者认领记录不再带上认领者 —— 两种都会让上面那个误判重新变得无法分辨。
const CLIENT_A = 'ui-aaaa1111'
const CLIENT_B = 'ui-bbbb2222'
const w27 = enqueueUiAction(ws, 'news.refresh', { requestedBy: 'test' })
ok('U27a', w27.ok === true, '排一条只读动作供认领')
const id27 = w27.ok ? w27.task.id : ''
const claimed27 = claimPendingTasks(ws, CLIENT_A)
ok('U27b', claimed27.some((t) => t.id === id27), '认领者 A 拿到了这条活')
// 另一个窗口也来取：**拿不到**（同一条活只属于第一个认领者）
const claimed27b = claimPendingTasks(ws, CLIENT_B)
ok('U27c', !claimed27b.some((t) => t.id === id27), '同一时刻第二个窗口取不到已被认领的活（取活即认领）')
// A 回报结果 → 记录里必须写着**是 A 按的**
completeUiAction(ws, id27, { ok: true, detail: '在「news」上按了「刷新雷达数据」', requestedBy: CLIENT_A })
const done27 = listTasks(ws, { limit: 400 }).find((t) => t.id === id27)
eq('U27d', done27?.requestedBy, CLIENT_A, '完成记录写着**是哪个窗按的**（不是笼统的 "ui"）')

// ── U27e/U27f：服务端**支持**窗 id ≠ 调用方**在用**它（判据 10：有端点 ≠ 有人读）──
//    上面 U27a~d 验的是服务端那三个函数；这两条验的是"执行器真的把它报上去了"。
//    少了它们，把 `client` 参数从执行器里删掉，U27 依然全绿 —— 而多窗口下
//    的归因能力会静默消失（那正是本轮要治的那个误判）。
const runnerSrc = readFileSync(join('src', 'ui', 'useUiActionRunner.ts'), 'utf8')
ok(
  'U27e',
  /getPendingUiActions\([^)]*client\s*\)/.test(runnerSrc),
  '执行器取活时带上了本窗 id（否则服务端只能记笼统的 "ui"，归因不了）',
)
ok(
  'U27f',
  /dataset\.uiClient/.test(runnerSrc),
  '本窗 id 挂在 documentElement 上 —— 出问题时打开控制台就能核对"我是哪一窗"',
)

// ══════════════════ U28-U32：报价与操作的口径 ══════════════════
//
// U28-U31：标的只有一个来源、价格不许编造、报价与操作读同一个数、构建管线的前提。
// U32    ：★ 桌宠说的那一次，必须就是图上画的那一次（按钮要能带参数）。
//          没有它，桌宠念 BTC / 60 分钟、图上画的是**屏幕当前选着的**那个标的
//          与尺度 —— 屏幕上同时出现两个口径不同的数（判据 31）。
//
// 这一组守用户实测反馈的三类失效：
//   ① 「有一个报价不正确」—— 屏幕上出现了**编造的**行情数字（源码里的占位价、
//      合成 K 线、随机游走），而它们看起来和真行情一模一样；
//   ② 「报价和操作不能乱」—— 下单/预检用的价与显示给用户的价不是一个来源；
//   ③ 「数据源要正确且统一」—— "有哪些交易对"这件事曾经有**五个主人**。
//
// ★ 写法纪律：**能 import 的就不扫源码**。注册表是纯数据模块，import 进来就是事实，
//   比在源码里找字面量稳得多。只有"某段代码里有没有出现 X"这类才扫源码，
//   且一律用剥注释的 `readCodeText` —— 注释里提到函数名会让断言**假绿**
//   （判据 32：门绿着、功能没接）。

/** 读文件并**剥掉注释行**：断言"源码里有没有这句"时必须用它。 */
function readCodeText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'))
    })
    .join('\n')
}

console.log('\n【U28】标的注册表是「有哪些交易对」的唯一事实源')
const regA = MARKET.filter((m) => m.symbol !== `${m.base}-${m.quote}` || m.exchange !== m.base + m.quote).map((m) => m.symbol)
eq('U28a', regA, [], '每条标的自洽：symbol 形如 BASE-QUOTE、exchange 恰好是 BASE+QUOTE')
const dupSym = internalSymbols().filter((s, i, a) => a.indexOf(s) !== i)
const dupEx = exchangeSymbols().filter((s, i, a) => a.indexOf(s) !== i)
eq('U28b', { dupSym, dupEx }, { dupSym: [], dupEx: [] }, '内部符号与交易所符号都不重复')
ok(
  'U28c',
  byInternal(DEFAULT_SYMBOL_INTERNAL)?.exchange === DEFAULT_SYMBOL_EXCHANGE,
  '默认标的（用户习惯的 BTCUSDT）真的在注册表里，且两种写法互相对应',
)
eq('U28d', toExchange('BTC-USDT'), 'BTCUSDT', '用户习惯的那个交易对能翻译成交易所符号')
eq('U28e', toExchange('BTC-XXX'), '', '未知标的返回**空串**而不是原样返回（原样返回会带着连字符走进交易所请求）')
eq('U28f', normalizeExchange('btc-usdt'), 'BTCUSDT', '收外部输入时能把内部符号归一成交易所符号')
eq('U28f2', normalizeExchange('BTCUSDC'), 'BTCUSDC', '外部直接给交易所符号也认')
const bases = [...new Set(MARKET.map((m) => m.base))]
const missingLeg = bases.filter(
  (b) => !MARKET.some((m) => m.base === b && m.quote === 'USDT') || !MARKET.some((m) => m.base === b && m.quote === 'USDC'),
)
eq('U28g', missingLeg, [], '每个基础币**两边都有**（USDT 与 USDC 各一条腿）')
const badDex = MARKET.filter((m) => m.dex && m.quote !== 'USDC').map((m) => m.symbol)
eq('U28h', badDex, [], '链上可路由只在 USDC 腿（USDT 腿没有对应的链上池子）')
const decimalsMismatch = bases
  .map((b) => new Set(MARKET.filter((m) => m.base === b).map((m) => m.priceDecimals)).size)
  .filter((n) => n > 1)
eq('U28i', decimalsMismatch.length, 0, '同一基础币的两个腿小数位一致（否则同一个币在两个腿上的单精度不同）')

console.log('\n【U29】没有编造的报价：不知道就显示「—」，不许造一个看着正常的数')
const storeSrc = readCodeText(join('src', 'store', 'Store.tsx'))
const ipBlock = storeSrc.match(/const initialPairs[\s\S]*?\n\}\)\)/)?.[0] ?? ''
ok('U29a', /\bprice:\s*null\b/.test(ipBlock) && ipBlock.length > 0, '交易对初值里价格是 null（不是任何占位数）')
const numericPrice = ipBlock.match(/\b(price|change24h|volume24h|high24h|low24h):\s*-?\d/g) ?? []
eq('U29a2', numericPrice, [], '交易对初值里**没有任何**硬编码的行情数字（写死一个价 = 屏幕上出现一条假行情）')
// ★ U29a2 单独看是**会空过**的：抽取失败时 ipBlock 为空 ⇒ 一个数字也找不到 ⇒ 假绿。
//   所以 U29a 必须同时断言"抽到了东西"，两条缺一不可（实测：第一版就因为正则
//   没匹配上而让 U29a 红、U29a2 绿 —— 那条绿毫无意义）。
ok('U29a3', ipBlock.length > 0, 'U29a2 是对着**真的抽出来的那块代码**比的，不是对着空串')
const tickBlock = storeSrc.match(/case 'TICK':[\s\S]*?case '/)?.[0] ?? ''
ok('U29b', !/Math\.random\(/.test(tickBlock), '行情心跳不再用随机数造价格（原来行情断线时会画一条随机游走、看着完全正常）')
const allCode = SRC.map((s) => s.text)
  .join('\n')
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'))
  })
  .join('\n')
ok('U29c', !/genCandles\s*\(/.test(allCode), '前端没有合成 K 线（原来取不到真数据会画一张假图，并在图上标注 "Binance"）')
const terminalSrc = readCodeText(join('src', 'pages', 'TerminalPage.tsx'))
ok('U29d', !/K线 · Binance/.test(terminalSrc), '图上不再写死来源 "Binance"（来源必须由调用方按实际数据传进来）')
ok('U29e', /sourceLabel=/.test(terminalSrc), 'K 线的来源标注确实由 props 传入')
ok(
  'U29f',
  /hasPx \? px\.toFixed/.test(terminalSrc) && /: '—'/.test(terminalSrc),
  '交易对列表在没有报价时显示「—」（不是 0、不是占位价）',
)

console.log('\n【U30】报价与操作不许各用各的')
const pcCall = terminalSrc.match(/precheckOrder\(state\.orchUrl,\s*\{[\s\S]*?\n\s*\}\)/)?.[0] ?? ''
ok('U30a', pcCall.length > 0, '能在源码里找到预检请求体（找不到就说明这条断言已经被改格式顶替了）')
ok(
  'U30b',
  pcCall.length > 0 && !/markPrice/.test(pcCall),
  '预检**不再上传本机看到的标记价**（上传它 = 浏览器决定引擎用什么价，两边口径不同却相减）',
)
// ── U30c 组：两种过期原因 ────────────────────────────────────────────────
// ★★ 这一组第一版是**假绿**的（判据 36），从变异验证里抓出来的。
//   它原先只断言 `/staleReason === 'quote'/` 出现在源码里；而 `_mutate_ui.mjs` 的 M16
//   把**产生** `'quote'` 的那一行（`quoteStale ? 'quote' : null`）改掉之后，
//   消费端那两个比较还在 ⇒ 断言照样绿，界面从此永远只会说"参数已改动"。
//   ⇒ 现在断的是纯函数 `deriveGateStale` 的**真值表**（"会不会变成那个值"），
//     源码扫描只用来保**另一个**失效面（原因产生得出来，但界面上没对应的话）。
const G = deriveGateStale
const staleBase = { hasVerdict: true, paramsChanged: false, pinnedPrice: 100, livePrice: 100 }
eq(
  'U30c',
  [
    G({ ...staleBase, paramsChanged: true }).reason, // 用户改了参数
    G({ ...staleBase, livePrice: 101 }).reason, // 行情跑了 ~100bps
    G(staleBase).reason, // 什么都没变
    G({ ...staleBase, livePrice: 101, hasVerdict: false }).reason, // 还没有裁决 —— 谈不上过期
  ],
  ['params', 'quote', null, null],
  '过期原因真值表：改参数 → params；没改但行情跑了 → quote；都没变 / 没有裁决 → null',
)
eq(
  'U30c1',
  G({ ...staleBase, paramsChanged: true, livePrice: 101 }).reason,
  'params',
  '两种原因同时成立时**参数优先**（两条一起说会把用户引向两个动作）',
)
// ★ 方向：抓"把 `>` 写成 `<`" —— 那样最轻微的抖动都会判过期（对正确的输入报错，判据 2）。
eq(
  'U30c1b',
  [G(staleBase).quoteStale, G({ ...staleBase, livePrice: 101 }).quoteStale],
  [false, true],
  '漂移为 0 ⇒ 不过期；漂移超过容忍度 ⇒ 过期（方向不许反）',
)
eq(
  'U30c1c',
  [driftBps(101, 0), driftBps(101, -5)],
  [0, 0],
  '裁决价非正时漂移算作 0，不产生 Infinity（否则每条裁决都被判过期，而屏幕只写"行情已变动"）',
)
// ★ 下面这几条保**另一个**失效面：原因产生得出来，但界面上没有对应的话 ⇒ 屏幕安静而裁决已作废。
//   能产生哪些原因是从**函数**现读的，不是在断言里抄一份（判据 35：与事实源比，不与副本比）。
const staleProducers = [
  ...new Set([G({ ...staleBase, paramsChanged: true }).reason, G({ ...staleBase, livePrice: 101 }).reason]),
].filter((r): r is 'params' | 'quote' => r !== null)
eq('U30c2', [...staleProducers].sort(), ['params', 'quote'], '纯函数能产生的过期原因恰好这两种')
// ★★ 文案本身也搬进纯函数了，"该说哪一句"于是**可以被断言**（不用再去源码里找词出现过）。
//   第一次写这几条时是 `terminalSrc.includes("staleReason === 'quote'")` —— 那是假绿：
//   这个词在**另一处**（提交被拦的报错）也出现过，于是删掉界面那一句，断言照样绿。
//   ⇒ 现在断的是文案的内容与**互不顶替**。
const msgParams = gateStaleMessage('params', 123)
const msgQuote = gateStaleMessage('quote', 123)
eq('U30c3', gateStaleMessage(null, 123), null, '没过期就没有"过期提示"这句话（`null`，不是空串 —— 判据 24）')
eq(
  'U30c4',
  [msgParams !== null && msgParams.includes('参数'), msgQuote !== null && msgQuote.includes('行情'), msgParams !== msgQuote],
  [true, true, true],
  '两种原因各有各的话，且**互不顶替**（相同或写反 = 用户按错误的那句去做）',
)
eq(
  'U30c5',
  [msgParams, msgQuote].filter((m) => (m ?? '').includes('*')),
  [],
  '过期提示里没有 markdown 星号（本项目没有 markdown 渲染器，星号会原样显示给用户）',
)
// ★★ `gateStaleMessage(...)` 必须**只有一个调用点**（算一次、两处渲染）。
//   M16e 的第一次实测就卡在这里：面板一处、提交报错一处 ⇒ 删掉面板那处，
//   `/gateStaleMessage\(/` 仍然命中另一处 ⇒ 断言假绿。文本断言分不清
//   "两个调用点里哪一个坏了"，所以正解是让它只有一个，并且**核对那一处传的是什么**。
const msgCalls = terminalSrc.match(/gateStaleMessage\([^)]*\)/g) ?? []
eq('U30c6', msgCalls.length, 1, '过期提示的调用点恰好一处（两处 ⇒ 删掉任一处都看不出来）')
eq(
  'U30c7',
  msgCalls[0],
  'gateStaleMessage(staleReason, quoteDriftBps)',
  '那一处传的是**推导出来的**原因与漂移，不是写死的某一种',
)
// ★★ U30d 第一版是 `!/\{gateStale && \(/` —— 它只认**旧代码的排版**：
//   变异里写成 `{gateStale && <div …>}`（等价、只是没换行加括号）就完全逃掉了。
//   ⇒ 改成断**结果**：界面上"过期提示"这个元素**只有一处**，且显示与否只看 `staleMsg`。
//     这样无论用什么形状再加一句提示，都会红（多一句 = 屏幕上可能同时出现两句互相矛盾的话）。
const hintLines = terminalSrc.split('\n').filter((l) => l.includes('className="gate-stale"'))
eq('U30d', hintLines.length, 1, '过期提示在界面上只有一处（原来的两个 JSX 分支算两处）')
eq(
  'U30d2',
  hintLines.length === 1 && hintLines[0]!.includes('staleMsg') && !hintLines[0]!.includes('gateStale'),
  true,
  '那唯一一处的显示与否只看 staleMsg（不看别的布尔，否则会渲染出一句与原因无关的提示）',
)
ok('U30e', /setPriceTouched\(false\)/.test(terminalSrc), '「市场价」把价格框**交还**给实时价（不是只写一次快照就再也不跟）')

console.log('\n【U31】构建管线没有 React Compiler（eslint 里那条 off 的前提）')
const viteSrc = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
const hasCompiler = /reactCompiler|react-compiler/.test(viteSrc) || Object.keys(deps).some((d) => /react-compiler/.test(d))
ok(
  'U31a',
  !hasCompiler,
  '构建管线里**没有** React Compiler —— 若它进来了，eslint 里对 preserve-manual-memoization 的关闭就不再成立，必须重新评估',
)
const eslintSrc = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8')
const offScopes = [...eslintSrc.matchAll(/files:\s*\[([^\]]+)\][\s\S]{0,400}?preserve-manual-memoization/g)].map((m) => m[1])
ok(
  'U31b',
  offScopes.length === 1 && /TerminalPage/.test(String(offScopes[0])),
  '那条 off **只作用于 TerminalPage 一个文件**（不许扩散到别的组件）',
)
ok(
  'U31c',
  existsSync(join(ROOT, 'src', 'market', 'registry.ts')),
  '注册表文件真的在（"唯一事实源"不能只是文档里的一句话）',
)

console.log('\n【U32】桌宠说的那一次，就是图上画的那一次（按钮要能带参数）')
const fcSpec = uiAction('terminal.forecast.run')
/*
 * U32a：这颗按钮必须**声明**它能带哪几个键。
 *
 * ★ 为什么这条不可省：用户实测原话是「桌宠说到可以做到，顺手把走势图调出来」。
 *   没有参数时，桌宠嘴里念 BTC / 60 分钟、界面按下后画的是**屏幕当前选着的**
 *   那个标的与尺度 —— 屏幕上因此同时出现两个口径不同的数（判据 31）。
 *   两个数各自都对，放在一起看没有意义。
 */
eq('U32a', [...(fcSpec?.payloadKeys ?? [])], ['symbol', 'minutes'], '预测按钮声明它接受「标的 + 未来多少分钟」')

// ── U32b 组：服务端**拒收**坏参数（拒收而不是"尽力而为"）─────────────────
//
// ★ 为什么是拒收：这个标的最终会决定预测层去读哪个历史文件。注册表里没有的
//   标的找不到历史时，预测层会**静默回落**成合成序列 —— 方向、目标价、分位带
//   一应俱全，与真历史算出来的长得一模一样，而两者的下一步动作相反（判据 13）。
const noPayload = enqueueUiAction(ws, 'agents.refresh', { requestedBy: 'test', payload: { symbol: 'BTCUSDT' } })
eq(
  'U32b',
  noPayload.ok ? 'ok' : noPayload.reason,
  'UI_ACTION_NO_PAYLOAD',
  '不接受参数的按钮带了参数 ⇒ 拒收（带着没人读的东西去按，看着像"参数生效了"，其实没有）',
)
const badKey = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'BTCUSDT', minutes: 60, oops: 1 } })
eq('U32c', badKey.ok ? 'ok' : badKey.reason, 'UI_ACTION_BAD_PAYLOAD', '白名单之外的键 ⇒ 拒收（不许静默丢掉）')
const badSym = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'DOGEUSDT', minutes: 60 } })
eq('U32d', badSym.ok ? 'ok' : badSym.reason, 'UI_ACTION_BAD_PAYLOAD', '注册表里没有的标的 ⇒ 拒收')
ok(
  'U32d2',
  badSym.ok ? false : /合成序列/.test(badSym.speech),
  '拒收时**要说清后果**（"会静默回落成合成序列"）—— 只说"参数不对"，用户不知道这为什么严重',
)
const tooLong = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'BTCUSDT', minutes: 100000 } })
eq('U32e', tooLong.ok ? 'ok' : tooLong.reason, 'UI_ACTION_BAD_PAYLOAD', '超出证据能支撑的时长 ⇒ 拒收（不要画一条靠外推撑起来的带）')
ok(
  'U32e2',
  byExchange('btcusdt') !== null,
  '★ 参数校验用的是**注册表**（大小写不敏感），不是自己 `startsWith` 一份名单 —— 两份名单迟早不一致',
)

// ── U32f 组：归一 —— 存下的必须是**真正会去算的那个数** ──────────────────
const asked5 = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'BTCUSDT', minutes: 5 } })
const asked5Min = asked5.ok ? asked5.task.payload?.minutes : null
eq(
  'U32f',
  asked5Min,
  resolveHorizon(5).actualMinutes,
  '存下来的是**归一后**的时长（要 5 分钟、证据只有 15 分钟一根 ⇒ 记 15），不是调用方给的那个数',
)
ok(
  'U32f2',
  asked5.ok ? asked5Min !== 5 : false,
  '★ 这一条要能发现"原样存下 5"：若两者恰好相等，上面那条会在一个假命题上变绿',
)
const asked60 = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'BTCUSDT', minutes: 60 } })
eq(
  'U32g',
  asked60.ok ? Object.keys(asked60.task.payload ?? {}) : [],
  ['symbol', 'minutes'],
  '参数键序按声明走（键序一变，队列文件里同一件事的两行长得不一样，"diff 两行"当场失效）',
)

// ── U32h：认领之后参数**不许消失** ──────────────────────────────────────
//
// ★★ 这是本轮真踩到的坑：任务视图由 `listTasks` 取**最后一条**记录拼出，
//    所以只把 payload 写在 `enqueue` 上、认领时没带上，认领那一刻它就没了。
//    表现是"界面上按了、图的尺度却是屏幕上原本那个"—— 看不出任何异常。
const claimId = asked60.ok ? asked60.task.id : ''
claimPendingTasks(ws, 'ui-test')
const afterClaimPayload = listTasks(ws, { limit: 200 }).find((t) => t.id === claimId)
eq(
  'U32h',
  afterClaimPayload?.payload ?? null,
  { symbol: 'BTCUSDT', minutes: 60 },
  '认领之后参数还在（视图取最后一条记录 ⇒ claim 那条也必须把它带上）',
)

// ── U32i 组：前端一次性通道的真值表（纯函数，直接断言）────────────────────
resetUiRequestForTest()
deliverUiRequest('terminal.forecast.run', { symbol: 'BTCUSDT', minutes: 60 })
eq('U32i', takeUiRequest('terminal.forecast.run'), { symbol: 'BTCUSDT', minutes: 60 }, '写入后取得回来')
eq('U32i2', takeUiRequest('terminal.forecast.run'), null, '★ 取走即清空 —— 一次参数只让**一次**点击生效')
resetUiRequestForTest()
deliverUiRequest('terminal.forecast.run', { symbol: 'BTCUSDT' })
eq('U32i3', takeUiRequest('other.action'), null, '不是这一颗按钮的参数 ⇒ 取不到')
eq('U32i4', peekUiRequest()?.payload ?? null, { symbol: 'BTCUSDT' }, '★ 而且**不许被旁路的 take 清掉**（清掉就是静默丢失：那条参数永远到不了它该去的地方）')
resetUiRequestForTest()
deliverUiRequest('terminal.forecast.run', { symbol: 'BTCUSDT' }, 1_000)
eq('U32j', takeUiRequest('terminal.forecast.run', 1_000 + UI_REQUEST_TTL_MS + 1), null, '过期后取不到（否则上一轮的参数会留到下一次人手点击）')
resetUiRequestForTest()
deliverUiRequest('terminal.forecast.run', { symbol: 'BTCUSDT' })
withdrawUiRequest()
eq('U32j2', takeUiRequest('terminal.forecast.run'), null, '执行器点击没发生时撤回（TTL 之外的第二道保护）')
resetUiRequestForTest()

// ── U32k 组：执行器与页面之间的接线（这部分是源码核对）────────────────────
const runnerPayloadSrc = readCodeText('src/ui/useUiActionRunner.ts')
const tpSrc = readCodeText('src/pages/TerminalPage.tsx')
const deliverAt = runnerPayloadSrc.indexOf('deliverUiRequest(t.actionId, params)')
const clickAt = runnerPayloadSrc.indexOf('el.click()')
ok(
  'U32k',
  deliverAt > 0 && clickAt > 0 && deliverAt < clickAt,
  '参数在**点击之前**写入（React 的 setState 是异步的，先 dispatch 再点会读到旧值）',
)
eq(
  'U32k2',
  [...runnerPayloadSrc.matchAll(/withdrawUiRequest\(\)/g)].length,
  2,
  '两条失败路径（找不到元素 / 按钮是灰的）**都**撤回参数',
)
/*
 * U32k3：页面按下时去取的，必须是**它自己挂的那个 data-ui**。
 *
 * ★ 这里刻意做的是「两个字面量互相比」，而不是"源码里出现过 takeUiRequest"：
 *   这两个字面量是同一件事的两份副本（一个是属性、一个是参数），
 *   任何一次只改一处的重命名都会让参数永远配不上，而界面上看不出来 ——
 *   表现就退回到"桌宠念 BTC、图上画 ETH"。互相核对才能发现它（判据 33）。
 */
const takeId = /takeUiRequest\('([^']+)'\)/.exec(tpSrc)?.[1] ?? ''
const dataUiId = /data-ui="(terminal\.forecast\.run)"/.exec(tpSrc)?.[1] ?? ''
eq('U32k3', takeId, dataUiId, '页面取的参数 id 与它挂的 data-ui 是同一个（改一处就配不上了）')
ok('U32k3b', takeId !== '', '★ 这一条防"上面那条在空串上变绿"：抽不到 id 时必须红')
ok(
  'U32k4',
  /withCurrentHorizon\(fcMinutes\)/.test(tpSrc),
  '★ 档位里含**当前那个值**：桌宠按 30 分钟排过来时常驻三档没有 30 ⇒ 三个按钮全不亮，' +
    '屏幕上找不到任何一个 30，而它嘴里念的是 30（判据 31）',
)
ok(
  'U32k5',
  /const runForecast = useCallback\(\s*async \(override\?:/.test(tpSrc) && /onClick=\{pressForecast\}/.test(tpSrc),
  '人点和桌宠点走**同一个** runForecast（判据 8：同一个业务动作只许一条路径）',
)

// ── U32l 组：桌宠排参数时取的是**工具回给的那一份** ────────────────────────
const svcSrc = readCodeText('server/voice/service.ts')
ok(
  'U32l',
  /d\.horizonMinutes/.test(svcSrc) && /payload: \{ symbol: uiSymbol, minutes: uiMinutes \}/.test(svcSrc),
  '排给界面的时长取自**工具归一后**的那个数（用户说「未来 5 分钟」会被并成 15）',
)
ok(
  'U32l2',
  !/payload: \{ symbol: sym, minutes: mins \}/.test(svcSrc),
  '★ 反断言：不许把**用户原话**里的分钟数排给界面（那会让图上画的是另一个时长，而两个数各自都对）',
)

// ── U32m：回话必须说**真的发生了什么** ────────────────────────────────────
ok(
  'U32m',
  /waitForUiAck\(/.test(svcSrc),
  '桌宠等的是"某个窗口真的领走并回报"（判据 10：排上了 ≠ 有人读）',
)
eq(
  'U32m2',
  [...svcSrc.matchAll(/ack\.state === '(done|failed|unknown)'/g)].map((m) => m[1]).sort(),
  ['done', 'failed', 'unknown'],
  '三种回报各有各的话（还剩"没人领"那一档走兜底）—— 它们指向的动作完全不同：看屏幕 / 修功能 / 去开界面',
)
ok(
  'U32m2b',
  /没有窗口来领/.test(svcSrc),
  '兜底那一档要说"没有窗口来领"（说成"调出来了"的后果是屏幕一片安静而账本里真有条记录，看着完全正常）',
)
eq(
  'U32m3',
  [...svcSrc.matchAll(/enqueueUiAction\([\s\S]{0,120}?'terminal\.forecast\.run'/g)].length,
  1,
  '「把图调出来」只有一处实现（两处迟早对同一件事给出不同文案，判据 8）',
)

// ── U32n：HTTP 与客户端两侧都把参数带上了吗 ──────────────────────────────
const idxSrc = readCodeText('server/index.ts')
ok(
  'U32n',
  /Array\.isArray\(body\.payload\)/.test(idxSrc),
  'HTTP 层拒收非对象参数（收字符串会被 `Object.keys` 拆成「多了 0、1、2 这几个键」）',
)
ok(
  'U32n2',
  /payload\?: Record<string, unknown>/.test(readCodeText('src/orch/client.ts')),
  '客户端的任务视图带着参数（不带 ⇒ 执行器读不到，界面只能按自己的当前值算）',
)

// ── U32o：等待答复的三态真的分得开（跑一遍，不只看源码）──────────────────
const ackId = (() => {
  const e = enqueueUiAction(ws, 'terminal.forecast.run', { requestedBy: 'test', payload: { symbol: 'BTCUSDT', minutes: 60 } })
  return e.ok ? e.task.id : ''
})()
eq('U32o', waitForUiAck(ws, ackId, 200).state, 'pending', '没人领 ⇒ 说"pending"（不是"done"，也不是静默）')
completeUiAction(ws, ackId, { ok: true, detail: '在「终端」上按了「算一次」', requestedBy: 'ui-abc' })
eq('U32o2', waitForUiAck(ws, ackId, 200).state, 'done', '有人回报成功 ⇒ "done"')
eq('U32o3', waitForUiAck(ws, 'nope-nope', 200).state, 'unknown', '队列里根本没这条 ⇒ "unknown"（读队列的问题，不是"没人按"）')

console.log(`\n${fail === 0 ? '✅' : '❌'} 界面动作通道：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('\n失败的断言：')
  for (const f of failures) console.log(`  · ${f}`)
}
void UI_CLAIM_TTL_MS
process.exit(fail === 0 ? 0 : 1)
