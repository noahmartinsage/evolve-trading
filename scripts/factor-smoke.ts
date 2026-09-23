/**
 * 因子生产线烟测。
 *
 * ── 只测语义不变量，不测数值 ─────────────────────────────────────────
 * 数值会随数据与阈值变化，把它们写进断言等于给未来的自己埋维护债。
 * 这里断言的都是"不论数据如何都必须成立"的性质：
 *   · 因果性（截断重算必须逐位一致）
 *   · 三态分离（核不了 ≠ 不通过 ≠ 通过）
 *   · 阈值真的被读（把它推到极端，结论必须翻转）
 *   · 失败有理由（没有理由的拒绝等于没拒绝）
 *   · 台账唯一（同一个 slug 不能有两条互相矛盾的结论）
 *
 * ── 每条断言都必须能被"它自己"打红 ─────────────────────────────────
 * 本仓库已经栽过 8 次"不可能失败的检查"。所以这里对每个闸门都构造
 * **只有它会命中**的输入：改坏哪一个闸门，打红的就是它那一条，
 * 不会靠邻居兜住。`_mutate12.mjs` 逐条验证这一点。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_FACTOR_GATE,
  DEFAULT_FACTOR_STRATEGY_GATE,
  DEFAULT_WINDOWS,
  FACTOR_BASES,
  FACTOR_MIN_WINDOW,
  computeFactorMetrics,
  evaluateFactorBatch,
  COST_DRAG_LABEL,
  COST_DRAG_NOTE,
  COST_PER_FILL_LABEL,
  EDGE_PER_FILL_LABEL,
  PER_FILL_NOTE,
  evaluateFactorStrategy,
  summarizeStrategyFolds,
  factorLooksAhead,
  factorSeries,
  generateFactorBatch,
  judgeFactor,
  judgeFactorStrategy,
  looksAhead,
  minWindowFor,
  runBacktest,
  DEFAULT_FACTOR_STRATEGY_WF,
  spearman,
} from '../src/engine/index.ts'
import type {
  Candle,
  FactorGateThresholds,
  FactorMetrics,
  FactorSpec,
  FactorStrategyConfig,
  FactorStrategyFold,
  FactorStrategyReceipt,
} from '../src/engine/index.ts'
import {
  assertIndexUnique,
  auditIndexRows,
  checkGateReachable,
  factorIndexSummary,
  produceFactors,
  readFactorIndex,
} from '../server/factorService.ts'
import type { FactorIndex } from '../server/factorService.ts'
import { buildAcceptedFactorStrategies, defaultStrategyConfig, factorStrategySummary } from '../server/factorStrategyService.ts'
import { loadEvidence } from '../server/evidence.ts'
import { generateProposals } from '../server/proposalEngine.ts'
import type { OrchState } from '../server/types.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] FACTOR SMOKE FAIL - ${name} - ${msg}`)
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
    join(dir, 'factor-latest.json'),
    JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

const TMP = join(tmpdir(), `evolve-factor-smoke-${process.pid}`)
mkdirSync(TMP, { recursive: true })
const tmpIndex = (name: string) => join(TMP, `${name}.json`)
/**
 * 端到端用例写出的台账路径。F9 复用它。
 *
 * 刻意**不**用生产路径 `data/factors/index.json`：CI 每跑一次就改一次台账的话，
 * 台账就不再是证据而是测试产物；而且"读生产台账"会让 F9 变成
 * "取决于这台机器上有没有人跑过生产线"的环境依赖用例。
 */
const E2E_INDEX = tmpIndex('e2e')

/** 造一段带趋势与波动的确定性 K 线，供"不看数据只验语义"的用例使用。 */
function synth(n: number): Candle[] {
  const out: Candle[] = []
  let px = 100
  for (let i = 0; i < n; i++) {
    px *= 1 + Math.sin(i / 11) * 0.004 + Math.cos(i / 37) * 0.002
    const o = px * (1 - 0.0005)
    const c = px
    out.push({ t: i * 900_000, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 + (i % 17) * 13 })
  }
  return out
}

/**
 * 逐条把闸门推到极端，确认结论真的翻转 —— 证明这个阈值被读过。
 *
 * ⚠️ `maxDuplicateCorr` 保留默认值（0.9）而**不是**"放开"。
 * 原因是我自己先踩过：最初这里写 1.5（意味着重复闸门永不触发），
 * 于是 F6 用同一份配置去验"反号因子会被拦下"时，它当然不会被拦下 ——
 * 而失败信息还指向"去冗余没生效"，看起来像产品缺陷。
 * "放开所有闸门"与"只放开除某一项之外的闸门"是两件事，不能共用一份常量。
 */
const GATE_OPEN: FactorGateThresholds = {
  minAbsIc: 0,
  minIcir: 0,
  maxTurnover: 1,
  minCoverage: 0,
  minBars: 1,
  maxDuplicateCorr: DEFAULT_FACTOR_GATE.maxDuplicateCorr,
}

/** 连重复闸门也放开的版本，只用于 F6 的反向对照。 */
const GATE_OPEN_ALL: FactorGateThresholds = { ...GATE_OPEN, maxDuplicateCorr: 1.5 }

function spec(base: string, transform: string, window: number): FactorSpec {
  return { slug: `${base}_${transform}_${window}`, nameCn: `${base}/${transform}/${window}`, category: '测试', base, transform, window }
}

/**
 * 造一份"完全合格"的指标 —— 只有在**注入**的前提下才可能：
 * 真实数据上的指标随行情变，拿它写断言会让这条测试变成行情的函数。
 */
function goodMetrics(s: FactorSpec): FactorMetrics {
  return {
    spec: s,
    bars: 2880,
    coverage: 0.9,
    icByHorizon: { '1': 0.05, '4': 0.05, '12': 0.05, '48': 0.05, '96': 0.05 },
    icMean5: 0.05,
    icir: 0.4,
    quantileSpreadBps: 12,
    turnover: 0.2,
    maxAbsCorrWithPool: null,
    nearestSlug: null,
  }
}

async function main() {
  const candles = synth(2400)

  // ── F1 因果性：未来函数检测必须真的会红 ──────────────────────────────
  {
    const name = 'F1 未来函数检测会红'
    // ① 裸价格是因果的 —— 这条先证"检测器不会无差别报红"（否则它就是个红灯常亮的假警报）
    if (looksAhead((cs) => cs.map((c) => c.c), candles, 4) !== false) {
      fail(name, '裸收盘价被判成偷看未来 —— 检测器对正确的输入报错，它已经没用了')
    }
    // ② 居中窗口（用了 t+5）：必须报红
    const centered = looksAhead((cs) => cs.map((_, i) => cs[Math.min(i + 5, cs.length - 1)].c), candles, 4)
    if (centered !== true) fail(name, `居中窗口（偷看未来 5 根）没有被检出，实际 ${String(centered)} —— 这条检测形同不存在`)
    // ③ 全样本均值标准化：也必须报红（最隐蔽的一类）
    const globals = looksAhead(
      (cs) => {
        const m = cs.reduce((a, c) => a + c.c, 0) / cs.length
        return cs.map((c) => c.c - m)
      },
      candles,
      4,
    )
    if (globals !== true) fail(name, '全样本均值标准化没有被检出 —— 它会把未来信息的量级混进信号')
    // ④ 无法判定必须是 null，不能被当成"通过"
    const unmatchable = looksAhead((cs) => cs.map(() => null), candles, 4)
    if (unmatchable !== null) fail(name, `全空序列应当判为"无法判定(null)"，实际 ${String(unmatchable)}`)
    if (judgeFactor({ metrics: goodMetrics(spec('ret', 'raw', 8)), origin: 'history', lookahead: null }).state !== 'unverifiable') {
      fail(name, '"检不了未来函数" 被放行了 —— null 被当成了 false（本仓库最典型的静默失效）')
    }
    pass(name, '因果样例不报红 · 居中窗口/全样本标准化逐条报红 · 无可用采样点判 null 且不放行')
  }

  // ── F2 常数 / 无值信号：是"确实没信号"，不是"核不了" ─────────────────
  {
    const name = 'F2 无值信号判 rejected 而非 unverifiable'
    const flat: number[] = new Array(200).fill(7)
    if (spearman(flat, candles.slice(0, 200).map((c) => c.c)) !== null) {
      fail(name, '常数序列的秩相关应当**不可定义**（null），返回一个数会让它被读成"无关"而不是"没定义"')
    }
    const noValue = spec('ret', 'raw', 4000) // 窗口比样本还长 ⇒ 全为 null
    const m = computeFactorMetrics(noValue, candles)
    if (m.coverage !== 0) fail(name, `窗口超长的因子覆盖率应为 0，实际 ${m.coverage}`)
    const v = judgeFactor({ metrics: m, origin: 'history', lookahead: false })
    if (v.state !== 'rejected') fail(name, `覆盖率 0 的因子应判 rejected（它确实没信号），实际 ${v.state}`)
    if (v.gate !== 'coverage') fail(name, `应命中 coverage 闸门，实际 ${v.gate}`)
    if (!/覆盖率/.test(v.reason)) fail(name, '拒绝理由没有说出是覆盖率 —— 用户拿到的是一个没有信息量的"不通过"')
    // ★ 上面那条用的是**手填**的 `lookahead: false`。手填的值让这条用例在缺陷
    //   存在时照样绿，而生产路径上同一个因子拿到的是 `null`（空序列上没有
    //   采样点可比），于是被判 unverifiable —— 也就是"证据不足、再攒点数据"，
    //   而那个处置**永远是错的**：样本量早就达标了。
    //   实测复现（35,040 根真实历史）：手填 false ⇒ rejected/coverage，
    //   真实路径 ⇒ unverifiable/lookahead-unknown，同一个因子两个结论。
    const la = factorLooksAhead(noValue, candles)
    const realPath = judgeFactor({ metrics: m, origin: 'history', lookahead: la })
    if (realPath.state !== 'rejected' || realPath.gate !== 'coverage') {
      fail(
        name,
        `真实路径（lookahead 现场算 = ${String(la)}）判成 ${realPath.state}/${realPath.gate} —— ` +
          '零产出被"未来函数检不了"掩盖成了"证据不足"',
      )
    }
    if (/未来函数/.test(realPath.reason)) {
      fail(name, `真实路径的拒绝理由在说未来函数（${realPath.reason}）—— 理由指向了一个不存在的问题`)
    }
    pass(name, '常数序列秩相关不可定义 · 覆盖率 0 判 rejected 且理由点名覆盖率（真实路径与手填路径结论一致）')
  }

  // ── F3 数据来源三态：合成数据上再漂亮的因子也不得通过 ────────────────
  {
    const name = 'F3 非真实数据一律 unverifiable'
    const s = spec('ret', 'raw', 8)
    const m = goodMetrics(s)
    const onHist = judgeFactor({ metrics: m, origin: 'history', lookahead: false })
    const onSynth = judgeFactor({ metrics: m, origin: 'synthetic', lookahead: false })
    // 双边：同一份"合格指标"，只有 origin 不同，结论必须相反。
    // 单边断言（只查合成不放行）会被"任何情况都不放行"这种坏实现蒙过去。
    if (onHist.state !== 'accepted') fail(name, `真实数据上的合格因子竟然没通过，实际 ${onHist.state}（闸门自锁，整条产线永远产不出东西）`)
    if (onSynth.state !== 'unverifiable') fail(name, `合成数据上的因子被判 ${onSynth.state} —— 合成行情里不存在可捕捉结构，"通过"是伪结论`)
    if (onSynth.gate !== 'origin') fail(name, `应命中 origin 闸门，实际 ${onSynth.gate}`)
    if (!/不构成因子有效性证据/.test(onSynth.reason)) fail(name, 'unverifiable 的理由没说清它为什么不算数')
    // 反向极性：真实历史那一档的理由里不得出现"不构成证据"
    if (/不构成因子有效性证据/.test(onHist.reason)) fail(name, '真实历史的通过理由里出现了"不构成证据" —— 文案串档了')
    pass(name, '同一份指标 · 真实历史 → accepted · 合成 → unverifiable(origin)')
  }

  // ── F4 闸门顺序：代码缺陷不得被"数据是合成的"洗白 ────────────────────
  {
    const name = 'F4 未来函数优先于数据来源'
    const v = judgeFactor({ metrics: goodMetrics(spec('ret', 'raw', 8)), origin: 'synthetic', lookahead: true })
    if (v.state !== 'rejected' || v.gate !== 'lookahead') {
      fail(name, `偷看未来的因子在合成数据上被判 ${v.state}/${v.gate} —— 顺序反了：它是代码缺陷，与数据来源无关`)
    }
    pass(name, '偷看未来 + 合成数据 → rejected(lookahead)，不被降级为 unverifiable')
  }

  // ── F5 每个阈值都被真的读过（逐条灵敏度）─────────────────────────────
  {
    const name = 'F5 阈值逐条灵敏度'
    const s = spec('ret', 'raw', 8)
    const base = goodMetrics(s)
    const cases: Array<{ gate: string; th: FactorGateThresholds; patch?: Partial<FactorMetrics>; why: string }> = [
      { gate: 'ic', th: { ...GATE_OPEN, minAbsIc: 0.99 }, why: 'minAbsIc' },
      { gate: 'icir', th: { ...GATE_OPEN, minIcir: 9 }, why: 'minIcir' },
      { gate: 'turnover', th: { ...GATE_OPEN, maxTurnover: 0.01 }, why: 'maxTurnover' },
      { gate: 'coverage', th: { ...GATE_OPEN, minCoverage: 0.99 }, why: 'minCoverage' },
      { gate: 'bars', th: { ...GATE_OPEN, minBars: 999_999 }, why: 'minBars' },
      { gate: 'duplicate', th: { ...GATE_OPEN, maxDuplicateCorr: 0.5 }, patch: { maxAbsCorrWithPool: 0.99, nearestSlug: 'x_y_8' }, why: 'maxDuplicateCorr' },
    ]
    for (const c of cases) {
      const m = { ...base, ...(c.patch ?? {}) }
      const v = judgeFactor({ metrics: m, origin: 'history', lookahead: false }, c.th)
      // bars 那一档门槛调高属于"证据不足"，其余属于"确定不通过"。
      // 这不是随手定的：样本不够时我们不知道因子行不行，只知道"没资格下结论"。
      const want = c.gate === 'bars' ? 'unverifiable' : 'rejected'
      if (v.state !== want || v.gate !== c.gate) {
        fail(name, `${c.why} 推到极端后结论是 ${v.state}/${v.gate}，期望 ${want}/${c.gate} —— 这个阈值没被读过`)
      }
      if (v.reason.trim().length === 0) fail(name, `${c.why} 的拒绝没有给出理由`)
    }
    // 全部放开时同一份指标必须通过：否则上面 6 条可能只是"门永远拒"这一种坏实现的 6 种表现
    const open = judgeFactor({ metrics: base, origin: 'history', lookahead: false }, GATE_OPEN)
    if (open.state !== 'accepted') fail(name, `全部阈值放开后仍未通过（${open.state}/${open.gate}）—— 说明上面 6 条不是"阈值被读到"，只是"门坏了"`)
    pass(name, '6 个阈值逐条推到极端均按预期翻转 · 全部放开时通过')
  }

  // ── F6 去冗余：同族反号因子必须被拦（池里只装已通过的）──────────────
  {
    const name = 'F6 反号重复因子被去冗余拦下'
    const pair = [spec('ret', 'raw', 16), spec('reversal', 'raw', 16)]
    // 分块宽度调小：ICIR 需要 ≥3 个分块才算得出来，块太少会退化成
    // "ICIR 无法计算"，于是用例会因为一个与去冗余无关的原因而失败。
    const blockOpts = { blockBars: 120 }
    const dup = evaluateFactorBatch(pair, candles, 'history', 'test-hash', GATE_OPEN, blockOpts)
    if (dup.entries[0].verdict.state !== 'accepted') fail(name, `基准因子竟然没过（${dup.entries[0].verdict.gate}）—— 去冗余用例的前置没成立`)
    if (dup.entries[1].verdict.gate !== 'duplicate') {
      fail(name, `收益反转与收益动量的秩相关是 -1（互为反号），却被判 ${dup.entries[1].verdict.gate} —— 去冗余没生效`)
    }
    if (!/秩相关/.test(dup.entries[1].verdict.reason)) fail(name, '去冗余的拒绝理由没给出相关系数')
    if (dup.accepted !== 1) fail(name, `重复对被接受了 ${dup.accepted} 个，期望 1`)
    // 双边：把重复阈值放开到不可能命中，同一对必须双双通过 —— 证明拦住它的确实是这道闸门
    const both = evaluateFactorBatch(pair, candles, 'history', 'test-hash', GATE_OPEN_ALL, blockOpts)
    if (both.accepted !== 2) fail(name, `放开重复阈值后应通过 2 个，实际 ${both.accepted} —— 拦住它的不是去冗余，是别的东西`)
    pass(name, '反号因子判 duplicate(理由带相关系数) · 放开阈值后双双通过')
  }

  // ── F7 批量生产：确定性 + 索引去重 + 台账唯一性 ──────────────────────
  {
    const name = 'F7 批量生产确定性与索引去重'
    const a = generateFactorBatch([], 8).map((s) => s.slug)
    const b = generateFactorBatch([], 8).map((s) => s.slug)
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(name, '同一输入两次展开得到不同候选集 —— 台账里的事后无法复现')
    if (new Set(a).size !== a.length) fail(name, '同一批候选内部出现重复 slug')
    if (a.length !== 8) fail(name, `请求 8 个候选只得到 ${a.length} 个`)
    const next = generateFactorBatch(a, 5).map((s) => s.slug)
    if (next.length !== 5) fail(name, `续批只得到 ${next.length} 个`)
    for (const s of next) if (a.includes(s)) fail(name, `续批产出了索引里已有的 slug：${s}`)
    // 台账唯一性：塞一个重复 slug 进索引，必须抛（不是静默接受）
    const idx = {
      version: 'factor-index-v1',
      horizons: [5],
      thresholds: DEFAULT_FACTOR_GATE,
      rows: [
        { slug: 'dup', state: 'accepted', origin: 'history' },
        { slug: 'dup', state: 'rejected', origin: 'synthetic' },
      ],
      updatedAt: new Date().toISOString(),
    } as unknown as FactorIndex
    let threw = false
    try {
      assertIndexUnique(idx)
    } catch {
      threw = true
    }
    if (!threw) fail(name, '索引里存在重复 slug 却被接受了 —— 同一个 slug 将有两条互相矛盾的结论')
    // 损坏的索引必须被"说出来"，而不是让读路径崩掉
    const corrupt = tmpIndex('corrupt')
    writeFileSync(corrupt, '{ 这不是 json')
    const rd = readFactorIndex(corrupt)
    if (rd.damaged === null) fail(name, '损坏的索引没有被标记，读出来会表现为"台账是空的"')
    if (rd.index.rows.length !== 0) fail(name, '损坏的索引应当回落到空索引')
    pass(name, '候选展开确定 · 续批不重复 · 重复 slug 抛错 · 损坏索引被标记')
  }

  // ── F8 端到端：真跑一批（真实历史），断言不依赖行情数值 ──────────────
  {
    const name = 'F8 端到端生产线（真实历史）'
    const histFile = join(process.cwd(), 'data', 'history', 'BTCUSDT_15m.json')
    // 这条是**前置断言**，不是形式主义：真实历史一旦缺失，整条因子产线
    // 会静默退化成"永远只能给出 unverifiable"，而它不报错、台账照长。
    // 让 CI 在这里红，比让人三个月后问"为什么一个因子都没通过"便宜得多。
    if (!existsSync(histFile)) fail(name, `缺少真实历史数据集 ${histFile} —— 因子产线会静默退化为永不产出，先跑 npm run data:fetch`)
    const reach = checkGateReachable('BTCUSDT')
    if (!reach.reachable) fail(name, `因子门不可达：${reach.reason}`)

    const idxPath = E2E_INDEX
    if (existsSync(idxPath)) rmSync(idxPath, { force: true })
    const r1 = produceFactors({ count: 6, indexPath: idxPath, dryRun: true })
    if (r1.origin !== 'history') fail(name, `端到端取数来源是 ${r1.origin}，期望 history`)
    if (r1.specs !== 6) fail(name, `请求 6 个候选，实际产出 ${r1.specs}`)
    if (r1.rows.length !== r1.specs) fail(name, `台账行数 ${r1.rows.length} ≠ 候选数 ${r1.specs}`)
    if (r1.accepted + r1.rejected + r1.unverifiable !== r1.specs) {
      fail(name, `三态计数之和不等于候选数：${r1.accepted}+${r1.rejected}+${r1.unverifiable} ≠ ${r1.specs}`)
    }
    for (const row of r1.rows) {
      if (!row.reason || row.reason.trim().length === 0) fail(name, `因子 ${row.slug} 的判决没有理由`)
      // ★ fail-closed 不变量：这条与行情无关，是纯粹的语义约束。
      if (row.state === 'accepted' && row.origin !== 'history') {
        fail(name, `因子 ${row.slug} 在 ${row.origin} 上被判通过 —— 非真实数据绝不能产出"通过"`)
      }
      if (!row.dataHash) fail(name, `因子 ${row.slug} 的行里没有行情指纹，换了数据也看不出来`)
    }
    const gateSum = Object.values(r1.byGate).reduce((a, b) => a + b, 0)
    if (gateSum !== r1.rejected + r1.unverifiable) fail(name, `按闸门汇总 ${gateSum} ≠ 未通过数 ${r1.rejected + r1.unverifiable}`)
    // dryRun 不许落盘：CI 每跑一次就改台账的话，台账就不是证据了
    if (existsSync(idxPath)) fail(name, 'dryRun 竟然写出了索引文件')
    // 确定性：同一批候选跑两次，指标必须逐字节相同
    const r2 = produceFactors({ count: 6, indexPath: idxPath, dryRun: true })
    const m1 = JSON.stringify(r1.rows.map((r) => [r.slug, r.icMean5, r.icir, r.turnover, r.bars, r.state]))
    const m2 = JSON.stringify(r2.rows.map((r) => [r.slug, r.icMean5, r.icir, r.turnover, r.bars, r.state]))
    if (m1 !== m2) fail(name, '同一批因子两次评价结果不同 —— 指标不可复现')
    // 落盘一次，检查台账本身
    const r3 = produceFactors({ count: 6, indexPath: idxPath })
    if (!r3.written) fail(name, '非 dryRun 却没有落盘')
    const { index, damaged } = readFactorIndex(idxPath)
    if (damaged !== null) fail(name, `落盘后的索引读不回来：${damaged}`)
    assertIndexUnique(index)
    if (index.rows.length !== 6) fail(name, `索引应有 6 行，实际 ${index.rows.length}`)
    const histHash = loadEvidence('BTCUSDT', 15).dataHash
    for (const row of index.rows) {
      if (row.origin !== 'history' || row.dataHash !== histHash) {
        fail(name, `索引行 ${row.slug} 的来源/指纹与门禁基座不一致：${row.origin}/${row.dataHash} vs history/${histHash}`)
      }
    }
    const icVals = r1.rows.filter((r) => r.icMean5 !== null).map((r) => Math.abs(r.icMean5 as number))
    console.log(
      `     实测：候选 ${r1.specs} · 通过 ${r1.accepted} · 拒 ${r1.rejected} · 证据不足 ${r1.unverifiable} · ` +
        `闸门分布 ${JSON.stringify(r1.byGate)} · |IC| 中位 ${icVals.length > 0 ? (icVals.sort((a, b) => a - b)[Math.floor(icVals.length / 2)]).toFixed(4) : 'n/a'} · ${r1.bars} 根`,
    )
    pass(name, `${r1.bars} 根真实历史 · 6 候选三态计数自洽 · 指纹与门禁同源 · dryRun 不落盘 · 两次评价一致`)
  }

  // ── F9 台账的三态披露：缺什么必须说得出 ─────────────────────────────
  {
    const name = 'F9 台账披露不沉默'
    const missing = factorIndexSummary(tmpIndex('not-exist'))
    if (missing.available) fail(name, '不存在的台账被报成可用')
    if (missing.reason.trim().length === 0) fail(name, '台账不可用时没有给出原因 —— 用户会以为"系统里没有因子"')
    const real = factorIndexSummary(E2E_INDEX)
    if (!real.available) fail(name, `端到端写出的台账应可用：${real.reason}`)
    if (real.total <= 0) fail(name, '端到端台账总数为 0')
    if (!/真实历史/.test(real.reason)) fail(name, '台账概况没有说明判决是在哪种数据上做出的')
    if (real.historyShare < 0 || real.historyShare > 1) fail(name, `historyShare 越界：${real.historyShare}`)
    if (!/台账|解析|结构/.test(missing.reason)) fail(name, `不可用理由不具体：${missing.reason}`)
    // 损坏的台账也必须被"说出来"（F7 已验 readFactorIndex，这里验概况层不会把它粉饰成"空"）
    const broken = factorIndexSummary(tmpIndex('corrupt'))
    if (broken.available) fail(name, '损坏的台账在概况层被报成可用')
    if (broken.reason.trim().length === 0) fail(name, '损坏的台账在概况层没有给出原因')
    // ★ 披露文案是**给人看、也给人听的字符串**，不许带 Markdown 记号。
    //   本轮实测踩到：`... **当前** 行情上仍然有效` 上了面板之后
    //   原样显示成两个星号（截图里看得见），而语音那条线有自己的
    //   文案卫生检查（voice S14）**不覆盖**这两个 reason。
    //   判据：一处失败**同时**是"UI 显示坏了"和"语音会念星号"两种事因 ——
    //   所以判据要写在这里，而不是只写在语音那一条上。
    //   ⚠️ 位置：必须放在 `broken` 声明**之后**。第一版写在它前面，
    //   于是这条断言先于被测对象求值，直接 `Cannot access 'broken' before
    //   initialization` 把整个烟测炸掉 —— 而报错看着像产品崩了。
    //   （判据：一条新加的检查**自己**也会出错，它要先能被跑过一遍。）
    const md = /\*\*|__/.test(real.reason) || /\*\*|__/.test(missing.reason) || /\*\*|__/.test(broken.reason)
    if (md) {
      fail(name, `概况文案里含 Markdown 记号（面板会原样显示、语音会念成星号）：${real.reason}`)
    }
    pass(name, `可用 ${real.total} 条 / 真实史占比 ${(real.historyShare * 100).toFixed(0)}% · 缺失与损坏都给出具体理由`)
  }

  // ── F10 两条产线吃同一份数据（这是"两套口径"的那条断言）────────────
  {
    const name = 'F10 因子线与门禁同源'
    const ev = loadEvidence('BTCUSDT', 15)
    const prod = produceFactors({ count: 3, indexPath: tmpIndex('src'), dryRun: true })
    if (prod.dataHash !== ev.dataHash) {
      fail(name, `因子线指纹 ${prod.dataHash} ≠ 门禁基座指纹 ${ev.dataHash} —— 两条线吃了两套数据，结论永远无法互相解释`)
    }
    const gen = await generateProposals({} as OrchState, { source: 'human', maxProposals: 1 })
    if (!gen.dataOrigin.startsWith('history:') && !gen.dataOrigin.startsWith('synthetic:') && !gen.dataOrigin.startsWith('injected')) {
      fail(name, `提案引擎的数据来源标注不可辨认：${gen.dataOrigin}`)
    }
    if (ev.origin === 'history' && gen.dataOrigin.startsWith('synthetic:')) {
      fail(name, `真实历史存在，提案引擎却仍在合成行情上挑选候选（${gen.dataOrigin}）—— 挑选与判决又分家了`)
    }
    const injected = synth(300)
    const gen2 = await generateProposals({} as OrchState, { source: 'human', maxProposals: 1, candles: injected })
    if (gen2.dataOrigin !== 'injected') fail(name, `注入 K 线时来源应标为 injected，实际 ${gen2.dataOrigin}`)
    pass(name, `因子线与门禁同指纹 ${ev.dataHash} · 提案引擎来源可辨（${gen.dataOrigin}）`)
  }

  // ── F11 基因空间与 compute 一致：声明的最小窗口必须真的产得出值 ────────
  {
    const name = 'F11 基因空间与 compute 一致'
    const cs = synth(1200)
    // 主断言：每个机制在**它自己的最小合法窗口**上必须产得出值。
    // 缺陷形态是"机制需要 5 个配对、而窗口组从 4 起" ⇒ 整条因子恒为空，
    // 而且它不报错、只在覆盖率上表现为 0（长得像"证据不足"）。
    for (const base of FACTOR_BASES) {
      const floor = minWindowFor(base)
      const w = [...DEFAULT_WINDOWS].filter((x) => x >= floor).sort((a, b) => a - b)[0]
      if (w === undefined) fail(name, `机制 ${base.id} 在默认窗口组里没有任何合法窗口（下限 ${floor}）`)
      const series = factorSeries(spec(base.id, 'raw', w), cs)
      const finite = series.reduce<number>((a, v) => a + (v === null ? 0 : 1), 0)
      if (finite === 0) {
        fail(
          name,
          `机制 ${base.id} 在最小合法窗口 w=${w} 上**一个值都产不出** —— ` +
            '它的计算前置条件与声明的最小窗口不一致，展开它就是造一个永远为空的候选',
        )
      }
    }
    // 对照半边：低于下限的窗口**必须**产不出值。少了它，主断言可能只是
    // "任何窗口都产得出"这种恒真条件，那它救不活任何东西。
    const declared = FACTOR_BASES.filter((b) => minWindowFor(b) > FACTOR_MIN_WINDOW)
    if (declared.length === 0) {
      fail(name, `没有任何机制声明了高于默认值（${FACTOR_MIN_WINDOW}）的最小窗口 —— 这条用例的对照半边没有对象`)
    }
    for (const b of declared) {
      const series = factorSeries(spec(b.id, 'raw', minWindowFor(b) - 1), cs)
      const finite = series.reduce<number>((a, v) => a + (v === null ? 0 : 1), 0)
      if (finite > 0) {
        fail(name, `机制 ${b.id} 在低于下限的窗口（${minWindowFor(b) - 1}）上竟然产出了值 —— 那 minWindow 就是多余的约束`)
      }
    }
    // 第三条（与前两条不可互替）：展开出的候选**不得**越过各自机制的下限。
    // 前两条查的是"机制算不算得出来"，这一条查"展开器有没有读那个声明"。
    // 只留前两条时，一个"声明了下限但展开时不看它"的实现在这里照样全绿，
    // 而候选集里会继续塞满永远为空的因子 —— 那正是本轮修的那个坑。
    const space = generateFactorBatch([], 9999)
    const byId = new Map(FACTOR_BASES.map((b) => [b.id, b]))
    const stray = space.filter((s) => {
      const b = byId.get(s.base)
      return b === undefined || s.window < minWindowFor(b)
    })
    if (stray.length > 0) {
      fail(
        name,
        `展开出的候选越过了机制下限：${stray
          .slice(0, 3)
          .map((s) => s.slug)
          .join(', ')}${stray.length > 3 ? ` 等 ${stray.length} 个` : ''} —— ` +
          '这些候选**算不出值**，进了台账只会长得像"证据不足"',
      )
    }
    const covered = new Set(space.map((s) => s.base))
    if (covered.size !== FACTOR_BASES.length) {
      fail(name, `展开器漏掉了 ${FACTOR_BASES.length - covered.size} 个机制 —— 基因空间与声明不一致`)
    }
    pass(
      name,
      `${FACTOR_BASES.length} 个机制在其最小合法窗口上均产出值 · ${declared.length} 个机制的下限被反向验证 · ` +
        `展开 ${space.length} 个候选无一越过下限`,
    )
  }

  // ── F12 台账自洽审计：判决必须能被它自己记下的指标解释 ────────────────
  {
    const name = 'F12 陈旧判决被标出且干净台账不报警'
    const row = (over: Record<string, unknown>) => ({
      slug: 'x',
      nameCn: 'x',
      category: 'c',
      base: 'ret',
      transform: 'raw',
      window: 8,
      state: 'rejected',
      gate: 'ic',
      reason: 'r',
      origin: 'history',
      dataHash: 'h',
      bars: 35040,
      coverage: 0.9,
      icMean5: 0,
      icir: 0,
      turnover: 0,
      quantileSpreadBps: 0,
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastEvaluatedAt: '2026-09-18T00:00:00.000Z',
      ...over,
    })
    const mk = (rows: unknown[]) =>
      ({
        version: 'factor-index-v1',
        horizons: [5],
        thresholds: DEFAULT_FACTOR_GATE,
        rows,
        updatedAt: '2026-09-18T00:00:00.000Z',
      }) as unknown as FactorIndex
    // 夹具的两条正例都是**实测出现过**的形态：
    //   ① 覆盖率 0 却记着"未来函数检不了"（判定器更正前的 5 条遗留）
    //   ② 合成数据却记着"通过"（违反 fail-closed 不变量）
    const stale = mk([
      row({ slug: 'old_zero_cov', state: 'unverifiable', gate: 'lookahead-unknown', coverage: 0 }),
      row({ slug: 'synth_pass', state: 'accepted', gate: 'pass', origin: 'synthetic' }),
    ])
    const slugs = auditIndexRows(stale)
      .map((x) => x.slug)
      .sort()
    if (slugs.join(',') !== 'old_zero_cov,synth_pass') {
      fail(name, `审计标出 ${JSON.stringify(slugs)} —— 期望恰好是 ['old_zero_cov','synth_pass']（多报是假警报，少报是漏报）`)
    }
    // 对照半边：**干净**台账必须一条都不报。少了它，这个检查器可能就是
    // "对任何输入都报"那种形态 —— 而假警报会训练人忽略它的红。
    const clean = mk([
      row({ slug: 'ok_rejected', state: 'rejected', gate: 'coverage', coverage: 0 }),
      row({ slug: 'ok_pass', state: 'accepted', gate: 'pass', origin: 'history', coverage: 0.99 }),
      row({ slug: 'ok_short', state: 'unverifiable', gate: 'bars', coverage: 0, bars: 100 }),
    ])
    const falseAlarms = auditIndexRows(clean)
    if (falseAlarms.length !== 0) {
      fail(name, `干净台账被报了 ${JSON.stringify(falseAlarms.map((x) => x.slug))} —— 检查器对正确的输入报错`)
    }
    pass(name, '零覆盖记 unverifiable / 合成数据记通过 各标一条 · 合法行（含样本不足）零误报')
  }

  // ── F13 策略层归因：毛收益 / 净收益 / 成本拖累必须是三个**独立**观测量 ──
  //
  // 这条场景补的是一块**从未被任何门禁覆盖**的地方：`src/engine/factorStrategy.ts`
  // 是"已接受因子能不能拿去交易"的唯一裁定者，而它在 CI 里一条断言都没有。
  // 本轮往它里面加了毛收益归因（为了分清"信号没用"与"信号被成本吃掉"），
  // 顺手把这块空白补上 —— 改了没人守的逻辑，比改了没人看的注释危险得多。
  {
    const name = 'F13 策略门归因：毛/净/成本拖累三个量各自可观测'

    const foldOf = (over: Partial<FactorStrategyFold>): FactorStrategyFold => ({
      fold: 1,
      sign: -1,
      trainBars: 9600,
      testBars: 4800,
      trainIc: -0.04,
      oosIc: -0.03,
      signAgree: true,
      netReturnPct: -10,
      grossReturnPct: -5,
      costDragPct: 5,
      winRate: 0.4,
      closedTrades: 100,
      maxDrawdownPct: 10,
      fills: 200,
      // 每笔口径：夹具显式给。归因在 15 轮之后**只看这一对**，
      // 所以这里的默认值直接决定 ①② 两个方向的结论 —— 不给就是 undefined，
      // 而 undefined 会让夹具悄悄走到"每笔口径建不起来"那一支。
      grossBpsPerFill: 1,
      costBpsPerFill: 8,
      liquidated: false,
      ...over,
    })

    const cfg: FactorStrategyConfig = {
      trainBars: 9600,
      testBars: 4800,
      barMinutes: 15,
      entry: 0.5,
      exit: -0.25,
      normWindow: 96,
      allowShort: false,
      exec: { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 },
    }

    /**
     * ★ 折数必须够 `minFolds`（4）。第一次写这个夹具时只给了 1 折，
     * 于是闸门停在 `folds` 上 —— 而失败信息看着像"归因分支写错了"。
     * 该改的是夹具，不是断言：**断言要测的那道门必须真的被走到**。
     */
    const foldsOf = (n: number, over: Partial<FactorStrategyFold> = {}): FactorStrategyFold[] =>
      Array.from({ length: n }, (_, i) => foldOf({ fold: i + 1, ...over }))

    const receiptOf = (over: Partial<FactorStrategyReceipt>): FactorStrategyReceipt => ({
      version: 'test',
      slug: 't',
      origin: 'history',
      dataHash: 'h',
      bars: 35040,
      folds: foldsOf(4),
      closedTrades: 100,
      wins: 40,
      winRate: 0.4,
      worstFoldReturnPct: -10,
      worstFoldGrossReturnPct: -5,
      meanFoldGrossReturnPct: -5,
      costDragPct: 5,
      // 每笔口径默认"边际 +1bps < 成本 8bps" —— 与 foldOf 的默认值一致，
      // 否则夹具里两处默认值各说各话，而 ②① 的结论由这一对决定。
      meanGrossBpsPerFill: 1,
      meanCostBpsPerFill: 8,
      meanFillsPerFold: 200,
      worstFoldDrawdownPct: 10,
      signAgreement: 0.8,
      liquidatedFolds: 0,
      config: cfg,
      bothDirectionsPass: false,
      ...over,
    })

    // ① 每笔毛边际为正但小于每笔成本 ⇒ 拒绝理由必须指向**成本**
    //    （该降成本，不是继续找信号）
    // ★ 15 轮之后判这个方向的量是**每笔口径**，不再是"最差折毛收益"。
    //   所以这里必须同时把 worstFoldGrossReturnPct 设成**负**的 ——
    //   那正是旧判据会判错的地方（它会把这条判成"方向本身不成立"），
    //   让它留在夹具里，这条断言就同时钉住了"判据换了统计量"这件事。
    const costCase = judgeFactorStrategy(
      receiptOf({ worstFoldReturnPct: -10, worstFoldGrossReturnPct: -5, meanGrossBpsPerFill: 1, meanCostBpsPerFill: 8 }),
    )
    if (costCase.outcome !== 'rejected' || costCase.gate !== 'return') {
      fail(name, `每笔边际 < 每笔成本被判成 ${costCase.outcome}/${costCase.gate}，期望 rejected/return`)
    }
    if (!costCase.reason.includes('每笔赚的不够付一次手续费')) {
      fail(name, `每笔边际 < 每笔成本的拒绝理由没指出这一条：${costCase.reason}`)
    }
    // ② 每笔毛边际 ≤ 0 ⇒ 必须指向**方向**，且**不许**提成本
    //    （提了成本会把下一步引到"降换手/降成本"上去，而这一批的真因不是成本 ——
    //      判据 16：这个输出会把下游引向哪个动作？）
    const signalCase = judgeFactorStrategy(
      receiptOf({ worstFoldReturnPct: -10, meanGrossBpsPerFill: -2, meanCostBpsPerFill: 8 }),
    )
    if (signalCase.gate !== 'return' || !signalCase.reason.includes('方向本身不成立')) {
      fail(name, `每笔边际 ≤ 0 的拒绝理由没有指向方向：${signalCase.gate} · ${signalCase.reason}`)
    }
    if (signalCase.reason.includes('成本')) {
      fail(name, `每笔边际 ≤ 0 的理由里提了成本，会把下游引去降成本：${signalCase.reason}`)
    }
    // ③ 反向对照：毛净皆正 ⇒ 不得被 return 门拒（证明这道门不是"永远拒绝"）
    const okCase = judgeFactorStrategy(
      receiptOf({ worstFoldReturnPct: 8, worstFoldGrossReturnPct: 20, costDragPct: 6, folds: foldsOf(4, { netReturnPct: 8, grossReturnPct: 20 }) }),
    )
    if (okCase.gate === 'return') {
      fail(name, `毛净皆正仍被 return 门拒：${okCase.reason} —— 这道门对正确的输入报错`)
    }

    // ④ 折级观测量：真跑一遍（合成数据，确定性），验"毛 − 净 = 成本拖累"这条恒等式
    const sSpec: FactorSpec = spec('ret', 'raw', 4)
    const wfCfg = (costs: boolean): FactorStrategyConfig => ({
      trainBars: 400,
      testBars: 400,
      barMinutes: 15,
      entry: 0.5,
      exit: -0.25,
      normWindow: 32,
      allowShort: false,
      exec: costs
        ? { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 }
        : { makerFeeBps: 0, takerFeeBps: 0, slippageBps: 0, maxParticipation: 0.1, latencyBars: 1 },
    })
    const withCost = evaluateFactorStrategy(sSpec, synth(2400), 'history', -1, wfCfg(true))
    const noCost = evaluateFactorStrategy(sSpec, synth(2400), 'history', -1, wfCfg(false))
    if (withCost.folds.length < 2) {
      fail(name, `夹具只跑出 ${withCost.folds.length} 折，不足以验证逐折恒等式（改夹具，不是断言）`)
    }
    let traded = 0
    for (const f of withCost.folds) {
      if (Math.abs(f.grossReturnPct - f.netReturnPct - f.costDragPct) > 0.02) {
        fail(name, `第 ${f.fold} 折毛−净≠成本拖累：${f.grossReturnPct} − ${f.netReturnPct} ≠ ${f.costDragPct}`)
      }
      // ★ 每笔口径的**单位换算**必须逐折钉住。这是最容易出"看起来完全正常的错数"的地方：
      //   百分数 × 100 ÷ 成交笔数 = bps。把 ÷ fills 忘了写成 ×fills、或者把 % 与 bps
      //   混用，得到的数仍然是一个合理的正数，**没有任何比较会失败**（判据 22）。
      if (f.fills > 0) {
        traded += 1
        const gWant = (f.grossReturnPct * 100) / f.fills
        const cWant = (f.costDragPct * 100) / f.fills
        if (f.grossBpsPerFill === null || Math.abs(f.grossBpsPerFill - gWant) > 0.02) {
          fail(
            name,
            `第 ${f.fold} 折每笔毛边际应为 毛收益${f.grossReturnPct}%×100÷${f.fills}笔 = ${gWant.toFixed(2)} bps，实得 ${String(f.grossBpsPerFill)}`,
          )
        }
        if (f.costBpsPerFill === null || Math.abs(f.costBpsPerFill - cWant) > 0.02) {
          fail(name, `第 ${f.fold} 折每笔成本应为 ${cWant.toFixed(2)} bps，实得 ${String(f.costBpsPerFill)}`)
        }
      } else if (f.grossBpsPerFill !== null || f.costBpsPerFill !== null) {
        // 零成交时每笔口径必须是 null（"没有证据"），不能是 0（"测出来是 0"）。
        fail(name, `第 ${f.fold} 折零成交，每笔口径应为 null，实得 ${String(f.grossBpsPerFill)}/${String(f.costBpsPerFill)}`)
      }
    }
    // 汇总的每笔口径必须与逐折值同源（均值），否则面板与拒绝理由会说两套话。
    if (withCost.meanCostBpsPerFill !== null) {
      const withFills = withCost.folds.filter((f) => f.costBpsPerFill !== null)
      const want = withFills.reduce((s, f) => s + (f.costBpsPerFill as number), 0) / withFills.length
      if (Math.abs(withCost.meanCostBpsPerFill - want) > 0.02) {
        fail(name, `汇总每笔成本 ${withCost.meanCostBpsPerFill} 与逐折均值 ${want.toFixed(2)} 不一致`)
      }
    }
    // ★ 这条是"只有真实现才过得去"的那一条：把 gross 写成 net 的副本，
    //   恒等式照样成立、零成本对照照样成立，只有这里会红。
    if (traded === 0) {
      fail(name, '夹具里这笔策略一次都没成交 —— 成本对照是"不可能发生的状态"，什么也没测到（改夹具）')
    }
    if (!withCost.folds.some((f) => f.costDragPct > 0)) {
      fail(name, '有成交但成本拖累全是 0 —— 毛收益那一遍八成没真的把费用置零（或反过来：毛净是同一个数）')
    }
    // ⑤ 零成本反向对照：费用归零后，毛必须**逐折等于**净，且成本拖累恒为 0
    for (const f of noCost.folds) {
      if (f.costDragPct !== 0 || f.grossReturnPct !== f.netReturnPct) {
        fail(name, `零成本配置下第 ${f.fold} 折仍有成本拖累 ${f.costDragPct}（毛 ${f.grossReturnPct} 净 ${f.netReturnPct}）`)
      }
    }
    pass(
      name,
      `归因分支三态各走一次（成本/方向/放行）· 带成本 ${withCost.folds.length} 折恒等式成立且成本拖累>0 · ` +
        `零成本 ${noCost.folds.length} 折毛≡净、拖累≡0`,
    )
  }

  // ── F14 策略台账的时效性：指纹变了就拒进池，且**说清为什么** ────────────
  //
  // `buildAcceptedFactorStrategies` 是"因子台账 → 提案引擎候选池"的唯一一道门，
  // 也是用户那句"已接受因子要接进策略生产"的落点。它此前同样零覆盖。
  // 三种形态各验一次，缺任何一种都会留下盲区：
  //   指纹不符 ⇒ 过时，拒进池；指纹相符但因子定义缺失 ⇒ 拒进池并指出缺什么；
  //   两者都对 ⇒ **必须真的产出一条策略**（少了这条，"全部拒掉"也能过测试）。
  {
    const name = 'F14 策略层消费的时效性：指纹不符拒进池且说清原因'
    const realCwd = join(TMP, 'consume-cwd')
    mkdirSync(join(realCwd, 'data', 'factors'), { recursive: true })
    const nowHash = loadEvidence('BTCUSDT', 15).dataHash
    const factorRow = {
      slug: 'ret_raw_4',
      nameCn: 'ret/raw/4',
      category: 'c',
      base: 'ret',
      transform: 'raw',
      window: 4,
      state: 'accepted',
      gate: 'pass',
      reason: 'fixture',
      origin: 'history',
      dataHash: 'factorhash',
      bars: 35040,
      coverage: 0.9,
      icMean5: -0.03,
      icir: -0.2,
      turnover: 0.2,
      quantileSpreadBps: 5,
      firstSeenAt: '2026-09-18T00:00:00.000Z',
      lastEvaluatedAt: '2026-09-18T00:00:00.000Z',
    }
    writeFileSync(
      join(realCwd, 'data', 'factors', 'index.json'),
      JSON.stringify({ version: 'factor-index-v1', horizons: [5], thresholds: DEFAULT_FACTOR_GATE, rows: [factorRow], updatedAt: '2026-09-18T00:00:00.000Z' }),
    )
    const sRow = (over: Record<string, unknown>) => ({
      slug: 'ret_raw_4',
      sign: -1 as const,
      state: 'accepted',
      gate: 'ok',
      reason: 'fixture',
      trainIc: -0.03,
      origin: 'history',
      factorDataHash: 'factorhash',
      screenDataHash: nowHash,
      dataHashMatch: true,
      folds: 5,
      worstFoldReturnPct: 3,
      worstFoldGrossReturnPct: 9,
      costDragPct: 6,
      winRate: 0.55,
      closedTrades: 200,
      signAgreement: 0.8,
      reverseChecked: true,
      bothDirectionsPass: false,
      lastEvaluatedAt: '2026-09-18T00:00:00.000Z',
      ...over,
    })
    writeFileSync(
      join(realCwd, 'data', 'factors', 'strategies.json'),
      JSON.stringify({
        version: 'factor-strategy-index-v1',
        thresholds: DEFAULT_FACTOR_STRATEGY_GATE,
        config: {
          trainBars: 9600,
          testBars: 4800,
          barMinutes: 15,
          entry: 0.5,
          exit: -0.25,
          normWindow: 96,
          exec: { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 },
        },
        rows: [
          sRow({ slug: 'stale_row', screenDataHash: 'ffffffffffffffff' }),
          sRow({ slug: 'ghost_row' }),
          sRow({ slug: 'ret_raw_4' }),
        ],
        updatedAt: '2026-09-18T00:00:00.000Z',
      }),
    )
    const built = buildAcceptedFactorStrategies({ cwd: realCwd })
    if (built.strategies.length !== 1) {
      fail(name, `应当且只应当产出 1 条可用策略，实际 ${built.strategies.length}（跳过 ${JSON.stringify(built.skipped)}）`)
    }
    if (!built.strategies[0]?.id.includes('ret_raw_4')) {
      fail(name, `产出的策略不是台账里那个因子：${String(built.strategies[0]?.id)}`)
    }
    const staleSkip = built.skipped.find((s) => s.slug === 'stale_row')
    if (!staleSkip || !staleSkip.reason.includes('指纹')) {
      fail(name, `指纹不符的行没被拒或没说明原因：${JSON.stringify(staleSkip)}`)
    }
    const ghostSkip = built.skipped.find((s) => s.slug === 'ghost_row')
    if (!ghostSkip || !ghostSkip.reason.includes('slug')) {
      fail(name, `因子定义缺失的行没被拒或没说明原因：${JSON.stringify(ghostSkip)}`)
    }
    // 与 F9 同一条判据，但对象是策略层的披露文案：这一条实测**真的**带过 `**当前**`，
    // 面板上原样显示成两个星号。所以它值得在两层各断言一次 ——
    // 只在一层断言，另一层下次改文案时不会有任何人拦。
    const sumReason = factorStrategySummary(join(realCwd, 'data', 'factors', 'strategies.json')).reason
    if (/\*\*|__/.test(sumReason)) {
      fail(name, `策略层概况文案里含 Markdown 记号（面板会原样显示、语音会念成星号）：${sumReason}`)
    }
    pass(name, '1 条进池 / 2 条被拒（指纹过时 + 定义缺失），每条都带原因')
  }

  // ── F15 汇总口径：三个量各有各的聚合方式，**不可互相推导** ──────────────
  //
  // 这一条守的是一个**用户看不见却一定会算出来**的缺陷：面板把
  // 「毛最差折 / 净最差折 / 成本拖累」三列并排，而前两列是**各自的最小值**
  // （两个最小值**可以来自不同的折**）、第三列是**各折均值**。
  // 实测某行：毛最差折 −1.69、净最差折 −55.92 ⇒ 相减得 54.23，而引擎报的成本拖累是 58.2。
  // 用户照着相减就会得出第二个数，然后开始不信这张表 —— 这不是逻辑错误，
  // 是"同一个事实存了两份"（本仓库最贵的那一类）。所以：
  //   ① 汇总口径必须只有一处实现（`summarizeStrategyFolds`）；
  //   ② 列名的"均值"由引擎提供常量，F15 把它钉住，防止有人在 JSX 里缩写回去。
  {
    const name = 'F15 汇总口径：毛/净取各折最小值、成本拖累取各折均值（三列不可相减）'

    const fold = (over: Partial<FactorStrategyFold>): FactorStrategyFold => ({
      fold: 1,
      sign: -1,
      trainBars: 400,
      testBars: 400,
      trainIc: -0.03,
      oosIc: -0.03,
      signAgree: true,
      netReturnPct: 0,
      grossReturnPct: 0,
      costDragPct: 0,
      winRate: 0.5,
      closedTrades: 10,
      maxDrawdownPct: 5,
      fills: 10,
      // 每笔口径：夹具必须显式给，否则汇总里那两个 bps 会是 null，
      // 而 null 会被读成"没有证据"—— 用默认值悄悄糊过去等于这条夹具没覆盖到它。
      grossBpsPerFill: 1,
      costBpsPerFill: 8,
      liquidated: false,
      ...over,
    })

    // ★ 关键夹具：**毛的最小值与净的最小值必须落在不同的折上**。
    //   第 1 折毛最差（−8），第 2 折净最差（−20）—— 只有这样才能让
    //   "相减 ≠ 均值"这件事真的发生；两个最小值同折时这条检查是空转的。
    const fs = [
      fold({ fold: 1, grossReturnPct: -8, netReturnPct: -4, costDragPct: 4 }),
      fold({ fold: 2, grossReturnPct: 6, netReturnPct: -20, costDragPct: 26 }),
    ]
    const agg = summarizeStrategyFolds(fs)
    if (agg.worstFoldGrossReturnPct !== -8) {
      fail(name, `毛最差折应为 −8（各折 gross 的最小值），实得 ${agg.worstFoldGrossReturnPct}`)
    }
    if (agg.worstFoldReturnPct !== -20) {
      fail(name, `净最差折应为 −20（各折 net 的最小值），实得 ${agg.worstFoldReturnPct}`)
    }
    if (agg.costDragPct !== 15) {
      fail(name, `成本拖累应为各折均值 (4+26)/2 = 15，实得 ${agg.costDragPct}（写成"最差折的拖累"就会是 4 或 26）`)
    }
    const naive = agg.worstFoldGrossReturnPct - agg.worstFoldReturnPct
    if (naive === agg.costDragPct) {
      fail(name, `夹具没能让"两个最差折落在不同折上"发生（相减得 ${naive} = 均值），这条检查不会红 —— 改夹具，不是改断言`)
    }

    // 空折数组：三个量必须是有限数（NaN 会原样显示在面板上，且所有比较都返回 false）
    const empty = summarizeStrategyFolds([])
    for (const [k, v] of Object.entries({
      worstFoldReturnPct: empty.worstFoldReturnPct,
      worstFoldGrossReturnPct: empty.worstFoldGrossReturnPct,
      costDragPct: empty.costDragPct,
    })) {
      if (!Number.isFinite(v)) fail(name, `空折数组下 ${k} 不是有限数：${String(v)}`)
    }
    if (empty.winRate !== null) {
      fail(name, `空折数组下胜率必须是 null（0 会被下游读成"胜率 0%"），实得 ${String(empty.winRate)}`)
    }

    // 列名常量：必须写明"均值"，且读法说明必须点出"不可相减"
    if (!COST_DRAG_LABEL.includes('均')) {
      fail(name, `成本拖累的列名 "${COST_DRAG_LABEL}" 没写"均值" —— 它就是各折均值，用户会照着三列相减`)
    }
    if (!COST_DRAG_NOTE.includes('不可相减')) {
      fail(name, `读法说明没点出"不可相减"：${COST_DRAG_NOTE}`)
    }

    pass(
      name,
      `毛最差折 ${agg.worstFoldGrossReturnPct} / 净最差折 ${agg.worstFoldReturnPct} 来自不同折 · ` +
        `成本拖累是均值 ${agg.costDragPct} · 相减得 ${naive}（不等，所以三列不可相减）· ` +
        `空折数组全为有限数且胜率 null · 列名「${COST_DRAG_LABEL}」带"均值"`,
    )
  }

  // ── F16 对称多空：策略必须能表达看空，且默认关闭 ──────────────────────
  //
  // 这一条守的是一个把「市场在跌」误判成「因子没用」的缺陷，而它**已经真的发生过**：
  // 实测 BTC 12 个月买入持有 −34.01%、逐折 3/5 下跌，而 `factorTimingStrategy`
  // 原实现是纯多头 ⇒ 在下跌折里毛收益**不可能为正**。
  // 系统当时给出的结论是"41 条方向不成立"。那不是算错 ——
  // 是那个观测量（毛收益为负）在「信号没用」与「策略不能做空」两种事因下**长得一样**
  // （判据 14：我准备记下来的观测量能不能唯一确定原因）。
  {
    const name = 'F16 对称多空：允许做空才表达得了看空，且默认行为不变'

    /** 单调价格路径。o=h=l=c，杜绝"用影线成交"这种夹具噪声。 */
    const path = (from: number, to: number, n = 60): Candle[] =>
      Array.from({ length: n }, (_, i) => {
        const p = from + ((to - from) * i) / (n - 1)
        return { t: i * 900_000, o: p, h: p, l: p, c: p, v: 1e6 }
      })

    // 一直看空的策略。**只在空仓/持多时发**，与 factorTimingStrategy 同一约定：
    // 引擎不检查重复开仓（那条约束由上层的 flat 判断保证）。
    // 夹具若不照抄这个约定，测的就是"引擎会不会重复加仓"，而不是"allowShort 接没接上"。
    type StrategyArg = Parameters<typeof runBacktest>[1]
    const alwaysShort: StrategyArg = {
      id: 'test:always-short',
      params: {},
      decide: (ctx) => (ctx.posQty >= -1e-12 ? { side: 'sell', type: 'market', frac: 0.95 } : null),
    }
    const exec = { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 }
    const lastEquity = (r: { equityCurve: Array<{ equity: number }> }): number =>
      r.equityCurve[r.equityCurve.length - 1].equity
    const retPct = (r: { equityCurve: Array<{ equity: number }> }): number => ((lastEquity(r) - 100_000) / 100_000) * 100

    const falling = path(100, 80) // 跌 20%
    const off = runBacktest(falling, alwaysShort, exec, 100_000, 15)
    const on = runBacktest(falling, alwaysShort, exec, 100_000, 15, { allowShort: true })

    // ① 默认必须**逐字节不变**：现货语义下，"看空"信号什么也不做。
    if (off.meta.allowShort !== false) fail(name, `默认 allowShort 应为 false，实得 ${String(off.meta.allowShort)}`)
    if (off.fills.length !== 0) {
      fail(name, `默认模式下产生了 ${off.fills.length} 笔成交 —— 现货语义下无持仓卖出应当被忽略`)
    }
    if (Math.abs(retPct(off)) > 1e-9) {
      fail(name, `默认模式下收益 ${retPct(off).toFixed(4)}%，期望恰好 0（零成交不该动权益）`)
    }
    // ② 打开后必须赚钱：跌 20% × 0.95 名义 ≈ +19%
    if (on.meta.allowShort !== true) fail(name, 'allowShort=true 没进 meta —— 报告无法据此判断这条曲线来自哪种语义')
    if (retPct(on) < 10) {
      fail(name, `允许做空后，下跌 20% 的行情里只拿到 ${retPct(on).toFixed(2)}%，期望 ≈ +19% —— allowShort 没真的接上`)
    }
    if (on.fills.length === 0) fail(name, '允许做空后一笔成交都没有')
    // ★ ①② 必须**配对读**：只留 ②，"任何改动"都可能让它变绿；
    //   只留 ①，测不出做空到底生效没有。两条结论相反才是这条检查的力。
    // ③ 爆仓必须可观测 —— 否则负权益只会以"回撤很大"的形式混进报告（判据 17）。
    const blown = runBacktest(path(100, 400), alwaysShort, exec, 100_000, 15, { allowShort: true })
    if (!blown.meta.liquidated) {
      fail(name, '价格上涨 4 倍、做空 0.95 名义，竟然没判爆仓 —— 爆仓与"亏得多"会分不开')
    }
    if (!on.meta.liquidated && on.meta.liquidated !== false) fail(name, 'meta.liquidated 缺失')
    // ④ config 键集完整性：新增字段漏抄进 defaultStrategyConfig 时这里要红。
    //    漏掉 allowShort 的后果**不报错**：门会静默退回纯多头，
    //    于是所有因子在跌市里又一次"方向不成立"。
    const cfgKeys = new Set(Object.keys(defaultStrategyConfig()))
    const wfKeys = Object.keys(DEFAULT_FACTOR_STRATEGY_WF)
    const missing = wfKeys.filter((k) => !cfgKeys.has(k))
    if (missing.length > 0) {
      fail(name, `defaultStrategyConfig() 漏了 ${missing.join(', ')} —— 新增字段不会自动跟着走，漏 allowShort 会静默退回纯多头`)
    }
    for (const k of ['exec', 'barMinutes']) {
      if (!cfgKeys.has(k)) fail(name, `defaultStrategyConfig() 缺 ${k}`)
    }
    pass(
      name,
      `默认（现货）零成交且权益不动 · 允许做空后跌 20% 得 +${retPct(on).toFixed(1)}%（${on.fills.length} 笔）· ` +
        `涨 4 倍判爆仓 · config 键集覆盖全部 ${wfKeys.length} 个 wf 字段 + exec/barMinutes`,
    )
  }

  // ── F17 归因判据：用「每笔边际 vs 每笔成本」，不是用「最差折毛收益」 ────────
  //
  // 这一条钉住的是**判定器自己**的一处真实缺陷（15 轮实测发现），
  // 而它造成的后果是一次错误的技术决策，不是一条难看的红：
  //   旧判据 `worstFoldGrossReturnPct > 0` 拿**最差那一折**的毛收益去和 0 比。
  //   实测单折毛收益 σ=13.33%、均值仅 +4.41% ⇒ 5 抽样的最小值**天然为负**
  //   ⇒ 一个真有正边际的策略也会被判成"方向本身不成立"。
  //   同一批数据：用 min ⇒ 1/14 条判"成本问题"；用 mean ⇒ **11/14** 条。
  //   于是 14 轮据此写下"瓶颈=单因子太弱"并去换因子族 —— 那一步是错的。
  //
  // 夹具的关键是让 worstFoldGrossReturnPct 为负（旧判据在这里必判"方向不成立"），
  // 而 meanGrossBpsPerFill 为正但小于 meanCostBpsPerFill ⇒ 新判据必须判"不够付手续费"。
  // 两条结论**相反**才是这条检查的力：只有新判据才救得活它（判据 6）。
  {
    const name = 'F17 归因判据：每笔边际 vs 每笔成本（不是最差折毛收益）'

    const fold = (over: Partial<FactorStrategyFold>): FactorStrategyFold => ({
      fold: 1,
      sign: 1,
      trainBars: 400,
      testBars: 400,
      trainIc: 0.03,
      oosIc: 0.03,
      signAgree: true,
      netReturnPct: -30,
      grossReturnPct: -5,
      costDragPct: 30,
      winRate: 0.5,
      closedTrades: 10,
      maxDrawdownPct: 5,
      fills: 100,
      grossBpsPerFill: 1,
      costBpsPerFill: 8,
      liquidated: false,
      ...over,
    })

    const mk = (folds: FactorStrategyFold[], over: Partial<FactorStrategyReceipt> = {}): FactorStrategyReceipt => ({
      version: 'factor-strategy-v1',
      slug: 'fixture',
      origin: 'history',
      dataHash: 'deadbeefdeadbeef',
      bars: 40000,
      folds,
      // 汇总口径只有一处实现：夹具必须走它，否则测的是"我手写的数"而不是引擎的数。
      ...summarizeStrategyFolds(folds),
      config: {
        trainBars: 9600,
        testBars: 4800,
        barMinutes: 15,
        entry: 0.5,
        exit: -0.25,
        normWindow: 96,
        exec: { makerFeeBps: 2, takerFeeBps: 5, slippageBps: 3, maxParticipation: 0.1, latencyBars: 1 },
        allowShort: true,
      },
      bothDirectionsPass: false,
      ...over,
    })

    // 5 折、closedTrades 合计 50（过 minClosedTrades=30）、方向一致率 1（过 0.6）。
    // 毛收益一折为负、其余为正 ⇒ **最差折为负而均值为正**，正是出问题的那种形状。
    const shape = [
      fold({ fold: 1, grossReturnPct: -5, netReturnPct: -35 }),
      fold({ fold: 2, grossReturnPct: 4, netReturnPct: -26 }),
      fold({ fold: 3, grossReturnPct: 6, netReturnPct: -24 }),
      fold({ fold: 4, grossReturnPct: 3, netReturnPct: -27 }),
      fold({ fold: 5, grossReturnPct: 7, netReturnPct: -23 }),
    ]

    const base = mk(shape)
    if (base.worstFoldReturnPct > 0) fail(name, `夹具没进盈利门：worstFoldReturnPct=${base.worstFoldReturnPct}`)
    // ★ 先证明这个夹具**确实**让新旧判据分岔：最差折毛为负、平均折毛为正。
    if (!(base.worstFoldGrossReturnPct <= 0)) {
      fail(
        name,
        `夹具要"最差折毛为负"，实得 ${base.worstFoldGrossReturnPct} —— 否则旧判据也会给出同样结论，这条检查救不活任何东西`,
      )
    }
    if (!(base.meanFoldGrossReturnPct > 0)) {
      fail(name, `夹具要"平均折毛为正"，实得 ${base.meanFoldGrossReturnPct} —— 两个统计量不分岔，就测不出"取哪个数"`)
    }

    // ① 成本驱动：每笔毛边际为正，但小于每笔成本。
    const a = judgeFactorStrategy(base)
    if (a.gate !== 'return') fail(name, `A 应走 return 门，实得 ${a.gate}`)
    if (!a.reason.includes('每笔赚的不够付一次手续费')) {
      fail(name, `A 的归因没指出"每笔不够付手续费"：${a.reason}`)
    }
    if (a.reason.includes('方向本身不成立')) {
      fail(
        name,
        `A 被判成了"方向本身不成立" —— 这正是旧判据(最差折毛收益)的错：` +
          `最差折毛收益 ${base.worstFoldGrossReturnPct}% 但每笔毛边际 +${base.meanGrossBpsPerFill} bps`,
      )
    }
    if (!a.reason.includes('8.0 倍')) fail(name, `A 没报出成本/边际的倍数：${a.reason}`)

    // ② 方向驱动。★ 与 ① **只差 meanGrossBpsPerFill 的符号**，结论必须相反。
    const b = judgeFactorStrategy(mk(shape, { meanGrossBpsPerFill: -1 }))
    if (b.gate !== 'return') fail(name, `B 应走 return 门，实得 ${b.gate}`)
    if (!b.reason.includes('方向本身不成立')) fail(name, `B 应判"方向本身不成立"：${b.reason}`)
    if (b.reason.includes('不够付一次手续费')) fail(name, `B 被判成了成本问题：${b.reason}`)
    if (a.reason === b.reason) {
      fail(name, '①② 只差一个数（每笔毛边际的符号）却给出逐字相同的理由 ⇒ 判据没真的吃这个量')
    }

    // ③ 口径矛盾必须 fail-closed：每笔边际覆盖了成本，净收益却为负 ⇒ 该查算法，不该硬套结论。
    const c = judgeFactorStrategy(mk(shape, { meanGrossBpsPerFill: 20, meanCostBpsPerFill: 8 }))
    if (c.outcome !== 'unverifiable' || c.gate !== 'attribution-inconsistent') {
      fail(name, `每笔边际 ≥ 每笔成本却净亏，应判 unverifiable/attribution-inconsistent，实得 ${c.outcome}/${c.gate}`)
    }

    // ④ ★ "每笔口径建不起来"那一支**在当前阈值下不可达**，而这条断言要证明它不可达 ——
    //    判据 5：构造不出来的状态不是功能。不可达的来源是**闸门顺序**：
    //    closed-trades 门排在盈利门之前，而 fills=0 ⇒ closedTrades=0 ⇒ 先被它拦下。
    //    （把 minClosedTrades 降到 0 才会露出那一支。）
    const noFills = [1, 2, 3, 4, 5].map((i) =>
      fold({ fold: i, fills: 0, closedTrades: 0, grossBpsPerFill: null, costBpsPerFill: null }),
    )
    const d = judgeFactorStrategy(mk(noFills))
    if (d.gate !== 'closed-trades') {
      fail(
        name,
        `零成交应被 closed-trades 门拦下（它必须排在盈利门之前），实得 ${d.gate} —— ` +
          `顺序一变，"每笔口径建不起来"那一支就变成可达的了`,
      )
    }

    // ⑤ 列名常量：这两个 bps 必须写明"每笔"与单位，否则会被当成"每折"读。
    if (!EDGE_PER_FILL_LABEL.includes('每笔') || !EDGE_PER_FILL_LABEL.includes('bps')) {
      fail(name, `每笔毛边际的列名 "${EDGE_PER_FILL_LABEL}" 没同时写明"每笔"与单位 bps`)
    }
    if (!COST_PER_FILL_LABEL.includes('每笔') || !COST_PER_FILL_LABEL.includes('bps')) {
      fail(name, `每笔成本的列名 "${COST_PER_FILL_LABEL}" 没同时写明"每笔"与单位 bps`)
    }
    if (!PER_FILL_NOTE.includes('成交笔数')) {
      fail(name, `每笔口径的读法说明没点出分母是"成交笔数"：${PER_FILL_NOTE}`)
    }

    pass(
      name,
      `夹具最差折毛 ${base.worstFoldGrossReturnPct}% 而平均折毛 +${base.meanFoldGrossReturnPct}%（两统计量分岔）· ` +
        `①每笔 +${base.meanGrossBpsPerFill}bps vs 成本 ${base.meanCostBpsPerFill}bps ⇒ 判"不够付手续费" · ` +
        `②同夹具把每笔边际改负 ⇒ 翻成"方向不成立" · ③边际覆盖成本却净亏 ⇒ fail-closed · ` +
        `④零成交被 closed-trades 门先拦（每笔口径那一支不可达）`,
    )
  }

  archive()
  console.log(`[OK] FACTOR SMOKE PASSED - ${scenarios.length} scenarios`)
}

main().catch((e) => {
  console.error(`[FAIL] FACTOR SMOKE FAIL - 未捕获异常 - ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(1)
})
