/**
 * 横截面（breadth）CLI —— 把 10 个品种的真实面板跑成一份可核对的结论。
 *
 * ══ 它回答的是哪一个问题 ═══════════════════════════════════════════════
 * 十七轮以来「策略层过门 0」的结论一直挂在"唯一钥匙是 breadth"上，
 * 但 breadth 从来没有被真的跑过一次。这个脚本就是把它跑起来：
 *
 *     横截面多空对冲之后，每腿毛边际能不能盖过一次单边成本？
 *
 * 与 `factorStrategy` 的「每笔毛边际(bps) vs 每笔成本(bps)」是**同一对量**，
 * 所以两个数可以直接放在一起看 —— 这正是判定"该换因子还是该降成本"的那一对。
 *
 * ══ 为什么不进 CI ═════════════════════════════════════════════════════
 * 与 `factors:run` / `factors:screen` 同理：它会写 `data/breadth/index.json`
 * （生产台账）。门禁里跑它 = 每跑一次 CI 就改一次台账，台账就不再是证据。
 * 烟测用 `--dry-run` 或临时路径。
 *
 * 用法：
 *   npm run breadth:run                      # 默认 horizon=12（3 小时）跑 accepted 因子
 *   npm run breadth:run -- --horizon 48      # 换持有期
 *   npm run breadth:run -- --horizons 4,12,48,96   # 扫一组，看结论随周期稳不稳
 *   npm run breadth:run -- --topk 4          # 每边持 4 个
 *   npm run breadth:run -- --train 0.7       # 训练段占比（定方向用，判决不看它）
 *   npm run breadth:run -- --limit 5         # 只跑前 5 个候选（先量耗时）
 *   npm run breadth:run -- --dry-run         # 只算不落盘
 *   npm run breadth:run -- --symbols BTCUSDT,ETHUSDT   # 只用这几个品种
 */
import {
  breadthSummary,
  defaultBreadthConfig,
  evaluateBreadth,
  listHistorySymbols,
  defaultHistoryDir,
  type BreadthRow,
} from '../server/breadthService.ts'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const dryRun = process.argv.includes('--dry-run')
const all = process.argv.includes('--all')
const topK = Number(arg('topk', '3'))
const rawLimit = arg('limit')
const limit = rawLimit === undefined ? undefined : Number(rawLimit)
if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error('--limit 必须为正整数')
const symbolsArg = arg('symbols')
const symbols = symbolsArg ? symbolsArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined
const horizonRaw = arg('horizons') ?? arg('horizon') ?? '12'
const horizonList = horizonRaw
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const trainShare = Number(arg('train') ?? '0.6')
if (!Number.isFinite(trainShare) || trainShare <= 0 || trainShare >= 1) {
  throw new Error('--train 必须落在 (0,1) 开区间 —— 0 或 1 会让"定方向"和"评表现"落在同一批数据上')
}

if (!Number.isFinite(topK) || topK < 1) throw new Error('--topk 必须为正整数')
if (horizonList.length === 0) throw new Error('--horizon/--horizons 必须为正整数')

const fmt = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d))

console.log('═══ 横截面（breadth）═══')
console.log(`面板目录 ${defaultHistoryDir()}`)
const available = listHistorySymbols(defaultHistoryDir())
console.log(`可用品种 ${available.length} 个：${available.join('、') || '（一个都没有）'}`)
if (available.length === 0) {
  console.error('❌ data/history 里没有任何历史文件 —— 先跑 npm run data:fetch（多品种用 -- --symbols A,B,C）。')
  process.exit(1)
}

let anyWritten = false
for (const horizon of horizonList) {
  const cfg = defaultBreadthConfig({ topK, horizon, trainShare })
  const t0 = Date.now()
  const r = evaluateBreadth({
    symbols,
    // ★ 默认只跑台账里 accepted 的因子：候选的唯一事实源是因子台账，
    //   这个脚本不该自己发明候选。--all 是给排查用的（看被拒的因子在横截面上
    //   会不会反而成立 —— 那本身是一条值得知道的事实）。
    specs: undefined,
    config: cfg,
    limit,
    dryRun,
    // ★★ 进度与内存观测点。2026-09-22 实测：46 品种 × 187 候选在**默认堆（4 GB）**
    //   跑到 418 秒时 `Ineffective mark-compacts near heap limit` 直接 OOM，
    //   而输出里没有一行说它跑到第几个因子 —— 失败与"算完了但没结论"长得一模一样。
    //   根因：`factorSeries`/`projectFactor` 返回 `(number|null)[]`，含 null 的数组
    //   在 V8 里是**装箱数组**（每个元素一个 HeapNumber），一个候选在 46 个品种上
    //   各建两条面板长的序列 ⇒ 每候选几十 MB 的瞬时分配，GC 追不动。
    //   ⇒ `npm run breadth:run` 已把堆上限抬到 8 GB（见 package.json）。
    //     彻底修（Float64Array + 有效性掩码）是独立一轮的事。
    onProgress: (p) => {
      if (p.done === 1) {
        console.log(
          `堆上限 ${(p.heapLimitMb / 1024).toFixed(1)} GB · 候选 ${p.total} 个 · 面板 ${p.symbols} 品种 × ${p.bars} 根`,
        )
      }
      if (p.done === 1 || p.done % 25 === 0 || p.done === p.total) {
        const pct = (p.heapUsedMb / p.heapLimitMb) * 100
        console.log(`  [${p.done}/${p.total}] ${p.slug} · 堆 ${p.heapUsedMb} MB / ${p.heapLimitMb} MB（${pct.toFixed(0)}%）`)
      }
    },
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  console.log('')
  console.log(`── horizon=${horizon} 根（${(horizon * 15) / 60} 小时）· topK=${topK} · 每边成本 ${cfg.feeBps + cfg.slipBps} bps ──`)
  console.log(`面板 ${r.symbols} 个品种 × ${r.panelBars} 根共同 bar · 指纹 ${r.panelHash.slice(0, 24)}…`)
  console.log(
    `前 ${(cfg.trainShare * 100).toFixed(0)}% 训练段**只用来定方向** · 后 ${((1 - cfg.trainShare) * 100).toFixed(0)}% 检验段**判决只看它**`,
  )
  if (r.origin !== 'history') console.log(`⚠️ 面板来源是 ${r.origin} —— 不是真实历史，结论不能作为依据`)
  if (r.panel?.missing.length) {
    console.log(`⚠️ 被请求但没找到的品种：${r.panel.missing.join('、')} —— 它们**没有**进面板`)
  }
  // ★★ 静默失效的守门人：往 data/history 里多放一个**短序列**品种，
  //   整个面板的交集会从 36,000 根塌成 2,880 根，而面板同时报出**更多**品种。
  //   "品种从 10 涨到 44" 看起来像进步，实际证据少了 12 倍 —— 输出里没有一处会红。
  if (r.panel && r.panel.binding.length > 0 && r.panel.barsMin > 0 && r.panel.barsMax > r.panel.barsMin * 1.5) {
    console.log('')
    console.log(
      `⛔ 面板被短序列绑住了：柱子最多 ${r.panel.barsMax} 根、最少 ${r.panel.barsMin} 根` +
        `（差 ${(r.panel.barsMax / r.panel.barsMin).toFixed(1)} 倍）⇒ 共同窗口只剩 ${r.panelBars} 根。`,
    )
    console.log(`   约束者：${r.panel.binding.join('、')}`)
    console.log(
      `   把它们排除掉（--symbols 里少写这几个），共同窗口会涨到 ~${r.panel.barsMax} 根。`,
    )
    console.log('   ★ 这不是"品种更多了"，是**证据少了**。品种数上涨与证据量下跌可以同时发生，而两者都在同一行里看着正常。')
    console.log('')
  }
  if (!r.panelUsable) {
    console.log(`⛔ 面板不可用：${r.panelProblem}`)
    console.log('   所有因子都会落 unverifiable/panel 闸门 —— 这不是"因子不行"，是"标的凑不齐"。')
  }
  if (r.candidates === 0) {
    console.log('没有候选因子 —— 因子台账里没有 accepted 的行。先跑 npm run factors:run。')
    continue
  }

  console.log(
    `候选 ${r.candidates} · 通过 ${r.accepted} · 拒绝 ${r.rejected} · 证据不足 ${r.unverifiable} · 耗时 ${secs}s`,
  )
  console.log(`按闸门分布 ${JSON.stringify(r.byGate)}`)
  console.log('')
  console.log(
    'slug'.padEnd(28) +
      '结论'.padEnd(14) +
      'gate'.padEnd(11) +
      '训练IC'.padStart(9) +
      '方向'.padStart(5) +
      '检验IC'.padStart(9) +
      't'.padStart(7) +
      '毛/腿'.padStart(8) +
      '成本/腿'.padStart(8) +
      '净/腿'.padStart(8) +
      '胜率'.padStart(7) +
      '换手'.padStart(6),
  )
  for (const row of r.rows) {
    console.log(
      row.slug.padEnd(28) +
        row.outcome.padEnd(14) +
        row.gate.padEnd(11) +
        fmt(row.trainMeanIc, 4).padStart(9) +
        (row.sign === null ? 'n/a' : row.sign === 1 ? '+' : '−').padStart(5) +
        fmt(row.meanIc, 4).padStart(9) +
        fmt(row.tStat, 2).padStart(7) +
        fmt(row.grossBpsPerLeg).padStart(8) +
        fmt(row.costBpsPerLeg).padStart(8) +
        fmt(row.netBpsPerLeg).padStart(8) +
        (row.winRate === null ? 'n/a' : (row.winRate * 100).toFixed(1) + '%').padStart(7) +
        (row.turnoverPerRebalance === null ? 'n/a' : (row.turnoverPerRebalance * 100).toFixed(0) + '%').padStart(6),
    )
  }
  // ★ 方向一致性是这张表里最该被读到的一列：
  //   训练段 IC 的符号决定方向，检验段 IC 的符号是它的**独立验证**。
  //   两者反号 ⇒ 这个因子的方向在不同时段不稳定（过拟合的典型形态），
  //   而它在"净为负"这个数字上和"因子没用"长得一模一样（判据 25）。
  const flipped = r.rows.filter(
    (x) => x.trainMeanIc !== null && x.meanIc !== null && Math.sign(x.trainMeanIc) !== Math.sign(x.meanIc),
  )
  if (flipped.length > 0) {
    console.log('')
    console.log(`⚠️ ${flipped.length}/${r.rows.length} 条的 IC 符号在两段之间**翻转**了（训练段定方向、检验段反号）——`)
    console.log('   这些因子的方向不稳定，它们的"不通过"和"因子没用"不是一回事，别混着读。')
  }
  const both = r.rows.filter((x) => x.bothDirectionsPass)
  if (both.length > 0) {
    console.log(`⚠️ ${both.length} 条**反向在检验段上也通过** ⇒ 这道门对方向没有区分力（不是好消息）。`)
  }

  // ── 归因小结：三种"不通过"必须**分开数**，否则读到的是同一句话 ──
  const byGate = (g: string) => r.rows.filter((x) => x.gate === g)
  const noDir = byGate('ic-t')
  const negGross = byGate('gross')
  const costEaten = byGate('cost')
  const notEnough = r.rows.filter((x) => x.outcome === 'unverifiable')
  console.log('')
  console.log('归因（三者指向的动作**完全不同**）：')
  console.log(`  · 排序没方向（该换因子族）        ${noDir.length} 条`)
  console.log(`  · 毛本身就是负的（信号没用）      ${negGross.length} 条`)
  console.log(`  · 毛够大但被成本吃掉（该降换手）  ${costEaten.length} 条`)
  console.log(`  · 证据不足（该攒数据，不是该换）  ${notEnough.length} 条`)

  // 最接近通过的那一条 —— 它给出"还差多少"的具体数字。
  const closest = closestToPass(r.rows)
  if (closest) {
    console.log('')
    console.log(
      `最接近通过：${closest.slug} · ${closest.outcome}/${closest.gate} · ` +
        `毛 ${fmt(closest.grossBpsPerLeg)} vs 成本 ${fmt(closest.costBpsPerLeg)} bps ⇒ ` +
        `净 ${fmt(closest.netBpsPerLeg)}（还要再补 ${fmt(marginGap(closest))} bps/腿）`,
    )
  }

  if (r.written) anyWritten = true
  else console.log('\n（dry-run：未落盘）')
}

// --all 目前只是"跑台账全部行"的占位说明：evaluateBreadth 的 specs 为空时
// 取的是 accepted。这里如实说清楚，而不是假装 --all 有效。
if (all) {
  console.log('')
  console.log('⚠️ --all 尚未接线：本轮默认只跑因子台账里 accepted 的因子。')
}

const s = breadthSummary()
console.log('')
console.log(`横截面台账：${s.reason}`)
if (s.rows > 0) console.log(`  面板事实：${s.panelSymbols} 个品种 × ${s.panelBars} 根 · 更新于 ${s.updatedAt}`)
if (anyWritten) console.log('  已落盘 data/breadth/index.json')

/** 离"通过"最近的一条：净/腿最大（含负数），用来回答"还差多少 bps"。 */
function closestToPass(rows: readonly BreadthRow[]): BreadthRow | null {
  const scored = rows.filter((x) => x.netBpsPerLeg !== null)
  if (scored.length === 0) return null
  return scored.reduce((a, b) => ((b.netBpsPerLeg as number) > (a.netBpsPerLeg as number) ? b : a))
}

/** 还差多少才够本：成本 − 毛（毛为负时，缺口还要加上那一部分）。 */
function marginGap(row: BreadthRow): number {
  const gross = row.grossBpsPerLeg ?? 0
  return row.costBpsPerLeg - gross
}
