/**
 * 因子挖掘的迭代循环 —— 「扩空间 → 筛选测试 → 必要时换族 → 再扩」
 *
 * ── 这一层治的是什么 ────────────────────────────────────────────────
 * 需求原话是「扩候选基因空间，再筛选测试，必要时换因子族，直到挖掘出很多个
 * 能稳定盈利的因子」。在那之前，舰队里那条 `expand-factors` 链是**跑一次就结束**的：
 * 生产 → 筛选 → 核对，报告完现状就完了。它不会因为"这一轮不够"而自己再来一轮，
 * 也不会因为"这个窗口组挖干净了"而换一组。**一次性的链不是挖掘，是抽样。**
 *
 * ── 三个决定必须写清楚，否则这一层会变成安慰剂 ──────────────────────
 *
 * ① 「稳定盈利」的判据**不在这里定义**，用的是策略门的 `accepted`。
 *    这里绝不自己发明一套"盈利"标准 —— 那会造出第二条口径，而两条口径
 *    迟早对同一个因子给出不同答案（本仓库为"两条口径"付过多次代价）。
 *    所以本模块只**数**，不**判**。
 *
 * ② 「换因子族」在本系统里有一个确定含义：**换窗口组**。
 *    基因空间是 机制(base) × 变换(transform) × 窗口(window)，前两维已固定，
 *    唯一能加的是窗口。所以"换族"= 换一组窗口，而不是换一套无关的算法 ——
 *    后者是"再长一套实现"，那是本项目明令禁止的事。
 *
 * ③ 退出条件是**三种**，不是一种。只说"没挖到"没有动作含义：
 *    · `target-reached`      —— 够了，停；
 *    · `all-sets-exhausted`  —— 所有窗口组都挖干净了（**这组数据上真的没得挖了**）；
 *    · `max-rounds`          —— 轮次用尽（还想继续就加轮次，**再说一遍**）。
 *    把 `all-sets-exhausted` 与 `max-rounds` 混成一个"没挖到"，会让人一直加轮次，
 *    而正确的动作是换数据（更多标的 / 更长历史）—— 见本仓库因子线的定案。
 *
 * ── 为什么 produce / screen 要注入 ─────────────────────────────────
 * 判据 5：「这个状态真可能发生吗？」—— "第 2 轮空间耗尽所以要换组"这个分支
 * 默认要跑几十秒真实回测才可能碰到，甚至跑不出来。注入之后测试可以精确构造
 * 「第 1 轮有产出 → 第 2 轮空间耗尽 → 换组后再有产出」，从而真的断言那个分支。
 */
import { DEFAULT_WINDOWS } from '../../src/engine/factorEval.ts'

export interface MineProduceOut {
  specs: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 候选空间余量。0 = 这组窗口在这个台账上已经挖干净了。 */
  spaceRemaining: number
  spaceTotal: number
  /** ★ 本轮**真的新扩出来**的候选 slug。下一轮筛选只筛这一批。 */
  slugs: string[]
  dryRun: boolean
}

export interface MineScreenOut {
  /** 这次筛查了几条已接受因子。 */
  screened: number
  accepted: number
  rejected: number
  unverifiable: number
  /** 过门的 slug（= 本系统口径下的"稳定盈利"候选）。 */
  acceptedSlugs: string[]
  /** 被拒的 slug → 理由（用于说清"差在哪"）。 */
  rejectedReasons: { slug: string; reason: string }[]
  stale: number
  dryRun: boolean
}

export interface MineDeps {
  produce: (opts: { count: number; windows: readonly number[]; dryRun: boolean }) => MineProduceOut
  /**
   * 筛一批候选。
   *
   * ★ `slugs` 是**必须传的**：它限定了"只筛这一轮扩出来的那些"。
   *   不传的后果在实测里被抓到过 —— 调度器每轮筛的都是"按 slug 排序最前的那 N 条"，
   *   于是第 2、3 轮输出与第 1 轮逐字相同，看起来像"换了几组结果都一样"，
   *   而真相是新扩的因子一条都没被筛到（判据 6：那种假绿）。
   */
  screen: (opts: { slugs: readonly string[]; limit: number; dryRun: boolean }) => MineScreenOut
  now: () => number
  log?: (line: string) => void
}

/**
 * 窗口组。每一组代表一个"族"。
 *
 * ★ 短的窗口组会被 `minWindowFor(base)` 过滤掉一部分机制（低于机制下限的窗口
 *   算不出值，展开它等于凭空造一个永远为空的候选）。所以"换到短窗口组"通常
 *   会让**产出变少**，这是正常的、可解释的，而不是"这一组坏了"。
 */
export const WINDOW_SETS: readonly { id: string; label: string; windows: readonly number[] }[] = [
  { id: 'baseline', label: '基线窗口组（4~192）', windows: DEFAULT_WINDOWS },
  { id: 'intraday', label: '日内组（2~12，短周期）', windows: [2, 3, 5, 6, 12] },
  { id: 'swing', label: '波段组（32~384）', windows: [32, 64, 128, 256, 384] },
  { id: 'position', label: '长线组（288~1152）', windows: [288, 576, 1152] },
]

/**
 * 同一窗口组**连续几轮零过门**就判定"这一族在这个数据上挖不出东西"，换下一组。
 *
 * ★ 这个常量**导出**是为了让门禁能钉住它：变异验证抓到过一条**假绿** ——
 *   断言"零过门会真的换组"只写了"试过的组数 ≥ 2"，而那个绿**靠"空间挖干净"那条路
 *   也能满足**（把这里整段删掉，它照样绿）。真正只有这条判据能救活的输入是
 *   "连零 `BARREN_LIMIT` 轮的那一组，在第 `BARREN_LIMIT + 1` 轮就该被放下"。
 *   所以测试要拿这个数去算，而不是在测试里再写一个魔数。
 */
export const BARREN_LIMIT = 2

export interface MineRound {
  round: number
  windowSetId: string
  windowSetLabel: string
  windows: readonly number[]
  produced: MineProduceOut
  /** 空间耗尽时这一轮不筛（没新候选可筛），为 null。 */
  screened: MineScreenOut | null
  /** 本轮新增的过门候选。 */
  newProfitable: string[]
  /** 这一步为什么这么走 —— 每一轮都要能解释自己。 */
  note: string
}

export type MineStopReason = 'target-reached' | 'all-sets-exhausted' | 'max-rounds' | 'index-not-advancing'

export interface MineResult {
  rounds: MineRound[]
  /** 累计扩了多少个候选。 */
  totalProduced: number
  /** 累计过因子门的条数。 */
  totalFactorAccepted: number
  /** ★ 过**策略门**的 slug —— 这就是"稳定盈利候选"在本系统里的定义。 */
  profitable: string[]
  stopReason: MineStopReason
  /** 给人念的一句话。必须说清是哪一种"停"。 */
  verdict: string
  /** 被拒的理由归类（差在哪），按出现次数排。 */
  rejectTop: { reason: string; count: number }[]
  durationMs: number
}

export interface MineOptions {
  /** 最多几轮。默认 4 —— 每轮都可能分钟级，不能无限跑。 */
  maxRounds?: number
  /** 目标："很多个"是多少个。默认 5。 */
  targetProfitable?: number
  /** 每轮扩几个候选。默认 12。 */
  countPerRound?: number
  /** 每轮筛几条。默认 12。 */
  screenLimit?: number
  dryRun?: boolean
  /** 只跑指定的窗口组（默认全部，按顺序）。用于"就从长线组开始挖"。 */
  onlySets?: readonly string[]
}

function summarizeRejects(rounds: MineRound[]): { reason: string; count: number }[] {
  const m = new Map<string, number>()
  for (const r of rounds) {
    for (const x of r.screened?.rejectedReasons ?? []) {
      // 理由里常带具体数字（"第 3 折 −1.2%"），归一化成"前 40 字"再归类。
      //
      // ★ 数字替换**必须保留负号**。第一版写成 `replace(/[-\d.]+/g, '#')`，
      //   于是 `最差 -3.2%` 与 `最差 +1.2%` 都被归成 `最差 #%` ——
      //   而这两种正是**"信号方向不成立"与"被成本吃掉"**的分界
      //   （判据 28：同一事实、两个统计量、结论相反）。
      //   抹掉符号等于把两个相反的动作合成一个建议。
      const key = x.reason
        .replace(/-?\d[\d.]*/g, (mm) => (mm.startsWith('-') ? '-#' : '#'))
        .slice(0, 40)
      m.set(key, (m.get(key) ?? 0) + 1)
    }
  }
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
}

/**
 * 迭代挖掘。**纯逻辑**：所有副作用都在注入的 `produce` / `screen` 里。
 */
export function mineFactors(deps: MineDeps, opts: MineOptions = {}): MineResult {
  const t0 = deps.now()
  const maxRounds = Math.max(1, opts.maxRounds ?? 4)
  const target = Math.max(1, opts.targetProfitable ?? 5)
  const count = Math.max(1, opts.countPerRound ?? 12)
  const limit = Math.max(1, opts.screenLimit ?? 12)
  const dryRun = opts.dryRun ?? true
  const sets = opts.onlySets && opts.onlySets.length > 0 ? WINDOW_SETS.filter((s) => opts.onlySets?.includes(s.id)) : WINDOW_SETS

  const rounds: MineRound[] = []
  const profitable: string[] = []
  let totalProduced = 0
  let totalFactorAccepted = 0
  let stopReason: MineStopReason = 'max-rounds'
  // 已经挖干净的窗口组。**记 id 而不是下标** —— 下标会在窗口组顺序调整时错位。
  const exhausted = new Set<string>()
  // 每个窗口组"连续几轮零过门"。到阈值就判定这一族在这个数据上挖不出东西，
  // 换下一组 —— 这才是"必要时换因子族"里那个**必要时**的落地。
  const barren = new Map<string, number>()
  /** 上一轮扩出来的 slug 集合（排序后拼串）。用于判"台账有没有推进"。 */
  let lastSlugs: string | null = null

  const log = deps.log ?? ((): void => {})

  for (let round = 1; round <= maxRounds; round += 1) {
    // 轮换窗口组：这一轮用哪个 = 第一个还没挖干净的。全挖干净了就停。
    const set = sets.find((s) => !exhausted.has(s.id))
    if (!set) {
      stopReason = 'all-sets-exhausted'
      log(`第 ${round} 轮：所有窗口组都已挖干净，停止。`)
      break
    }

    log(`第 ${round} 轮：窗口组「${set.label}」`)
    const produced = deps.produce({ count, windows: set.windows, dryRun })
    totalProduced += produced.specs
    totalFactorAccepted += produced.accepted

    // ① 空间耗尽 ⇒ 这一组没得挖了，标记它，下一步自然换到下一组。
    if (produced.specs === 0 && produced.spaceRemaining === 0) {
      exhausted.add(set.id)
      rounds.push({
        round,
        windowSetId: set.id,
        windowSetLabel: set.label,
        windows: set.windows,
        produced,
        screened: null,
        newProfitable: [],
        note:
          `窗口组「${set.label}」的候选空间已经挖干净（${produced.spaceTotal}/${produced.spaceTotal} 格都在台账里），` +
          '所以这一轮没有新候选可筛 —— 不是"筛了没有过门的"。换下一组窗口继续。',
      })
      log(`  空间耗尽（${produced.spaceTotal} 格全满），换组。`)
      continue
    }

    // ①b **台账没有推进** ⇒ 迭代是假的，当场停。
    //
    // ★ 这条是实测抓出来的，而且它抓对了：用 `dryRun: true` 跑时，因子生产不写台账，
    //   于是第二轮"扩出来的候选"与第一轮**逐字相同**（同样的 8 个 slug），
    //   筛选读台账自然一条也筛不到（"筛了 0 条"）。凭据上看起来是
    //   "换了窗口组、跑了 3 轮、结果都不理想" —— 而真相是**第 2、3 轮什么都没发生**。
    //   这正是判据 24 那一类：我要下的结论（"换族也不救"）在"根本没有换"这种事因下
    //   长得一模一样。所以判据必须是**台账有没有推进**，而不是"跑了几轮"。
    //   它同时也兜住真实的写盘失败（磁盘满 / 文件被锁）—— 那两种事因在这里同构。
    const key = [...produced.slugs].sort().join(',')
    if (key.length > 0 && key === lastSlugs) {
      stopReason = 'index-not-advancing'
      const last = rounds[rounds.length - 1]
      last.note +=
        ' ★ 本轮扩出来的候选与上一轮**完全相同** ⇒ 台账没有推进。' +
        '试跑（dryRun）时一定会这样（生产不写台账，下一轮读到的还是旧的），' +
        '写盘失败也会这样。迭代在这种情况下没有意义，所以停在这里 —— ' +
        '**不把"什么都没发生"报告成"又挖了一轮"**。要真迭代请关掉 dryRun。'
      log('  台账没有推进（候选与上一轮相同）⇒ 停，不假装又挖了一轮。')
      break
    }
    lastSlugs = key

    // ② 有候选 ⇒ **只筛本轮新扩出来的那批**过策略门。
    //
    // ★ `slugs: produced.slugs` 这一处是修一个实测抓到的假进展：
    //   原来的 `screen({limit})` 语义是"按 slug 排序取前 N 条"，于是第 2、3 轮
    //   筛的还是第 1 轮那批，输出逐字相同 —— 看起来像"换了几组结果都差不多"，
    //   真相是新扩的因子一条都没被筛到。
    const screened = deps.screen({ slugs: produced.slugs, limit, dryRun })
    const before = new Set(profitable)
    for (const s of screened.acceptedSlugs) {
      if (!before.has(s)) profitable.push(s)
    }
    const newProfitable = screened.acceptedSlugs.filter((s) => !before.has(s))
    rounds.push({
      round,
      windowSetId: set.id,
      windowSetLabel: set.label,
      windows: set.windows,
      produced,
      screened,
      newProfitable,
      note:
        `扩了 ${produced.specs} 个候选（因子门接受 ${produced.accepted}），筛了 ${screened.screened} 条，` +
        `过策略门 ${screened.accepted} 条、被拒 ${screened.rejected} 条、证据不足 ${screened.unverifiable} 条` +
        (screened.stale > 0 ? `，另有 ${screened.stale} 条行情指纹不符判过时` : '') +
        `。本轮到这一步累计过门候选 ${profitable.length} 个。`,
    })
    log(`  扩 ${produced.specs} / 筛 ${screened.screened} / 过门 ${screened.accepted}（累计 ${profitable.length}）`)

    // ③ 达标 ⇒ 停。这是唯一"好消息"的退出。
    if (profitable.length >= target) {
      stopReason = 'target-reached'
      break
    }

    // ④ 这一组**连续多轮零过门** ⇒ 判定「这一族在这个数据上挖不出东西」，换下一组。
    //
    // ★ 这一段之前**只打了一行日志、没有真的换组**：注释与日志描述的是一个
    //   没有实现的逻辑（判据 18）。实测里它的表现是"6 轮全耗在同一个窗口组上，
    //   只试了 1 组" —— 而"必要时换因子族"正是需求原话里的一句。
    if (screened.accepted === 0 && produced.specs > 0) {
      const n = (barren.get(set.id) ?? 0) + 1
      barren.set(set.id, n)
      if (n >= BARREN_LIMIT) {
        exhausted.add(set.id)
        const last = rounds[rounds.length - 1]
        last.note +=
          ` ★ 这一组已连续 ${n} 轮一个都没过门（本轮扩 ${produced.specs} 个、过门 0 个），` +
          '所以判定「这一族在当前数据上挖不出东西」，换下一组窗口继续 —— 不再在它身上耗轮次。'
        log(`  连续 ${n} 轮零过门 ⇒ 换组（剩 ${Math.max(0, sets.length - exhausted.size)} 组未试）`)
      }
    } else if (screened.accepted > 0) {
      barren.set(set.id, 0)
    }
  }

  if (stopReason === 'max-rounds' && rounds.length > 0 && profitable.length === 0) {
    // 轮次用尽且一个都没过门。这不是 `no-progress` 与 `max-rounds` 的区别问题 ——
    // 两者都"还想继续"，但下一步动作不同：前者该加轮次，后者该换数据。
    // 这里刻意**不合并**：说"轮次用尽"只说了一半，另一半是"过门 0 条"。
    stopReason = 'max-rounds'
  }

  const rejectTop = summarizeRejects(rounds)
  const durationMs = deps.now() - t0
  const setsTried = new Set(rounds.map((r) => r.windowSetId)).size
  const verdict =
    profitable.length >= target
      ? `挖到了：${profitable.length} 个过策略门的候选（目标 ${target}），跑了 ${rounds.length} 轮、试了 ${setsTried} 组窗口。`
      : stopReason === 'index-not-advancing'
        ? `迭代在 ${rounds.length} 轮处停了：**台账没有推进**（这一轮扩出来的候选与上一轮完全相同），` +
          '所以后面那些轮次不代表"又挖了一次"。最常见的原因是试跑（dryRun 不写台账）。' +
          `过门候选 ${profitable.length} 个（目标 ${target}）。`
        : stopReason === 'all-sets-exhausted'
          ? `没挖到目标数量：${setsTried} 组窗口**全部**挖干净了（候选空间一格都不剩），过门候选 ${profitable.length} 个（目标 ${target}）。` +
            '这不是"还没挖够"，是**这组数据上的因子族已经用尽** —— 继续加轮次没有意义，' +
            '要加的是数据面（更多标的 / 更长历史），而不是窗口。' +
            (rejectTop[0] ? `被拒最多的是「${rejectTop[0].reason}」（${rejectTop[0].count} 次）。` : '')
          : `没挖到目标数量：轮次用尽（${rounds.length} 轮），过门候选 ${profitable.length} 个（目标 ${target}）。` +
            '**还想继续就加轮次** —— 窗口组还没试完，这一点与"空间用尽"不同。' +
            (rejectTop[0] ? `被拒最多的是「${rejectTop[0].reason}」（${rejectTop[0].count} 次）。` : '')

  return { rounds, totalProduced, totalFactorAccepted, profitable, stopReason, verdict, rejectTop, durationMs }
}
