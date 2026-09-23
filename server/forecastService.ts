/**
 * 走势预测（forecast）—— **确定性预测层**。
 *
 * ══ 它是什么、不是什么 ══════════════════════════════════════════════════
 * 「完美预测」不存在。这个模块**不假装**能预测涨跌，它做的是三件可证伪的事：
 *
 *   ① 用**当前状态**在历史上找相似时刻（analog / 条件分布法），
 *      给出未来 h 根收益的**经验分布** —— 方向取中位数的符号、价位取中位数、
 *      走势图取 10/50/90 分位带。**永远不给单点预测**：单点无法被证伪，
 *      也就无法校准。
 *   ② 用 **walk-forward 样本外**校准它自己：方向命中率 vs 「永远猜基准方向」
 *      的命中率（基准率）、以及区间覆盖率 vs 名义覆盖率。
 *      ★ 这一条是全部价值所在：没有它，输出的每一个数字都是不可反驳的。
 *   ③ 三态判决。**没有统计优势时如实说没有优势** —— 这不是失败，
 *      这是这个模块唯一有意义的输出之一（`no-edge`）。
 *
 * ══ 三条不许破坏的纪律 ═════════════════════════════════════════════════
 * 1. **不许用同一批数据既选状态向量又评命中率。** 选状态向量只看训练段，
 *    校准只看训练段之后的数据（对齐策略层的 `determineSign`：训练定方向、
 *    样本外判决）。否则「命中率」会是一个恒等式，不是证据。
 * 2. **样本之间必须不重叠。** 相隔不到 h 根的两次抽样，它们的未来收益是
 *    同一段行情 —— 当成两个独立样本会把有效样本量虚高。做法：按距离贪心取，
 *    已选中的点在 ±h 根之内的全部跳过。
 * 3. **缺数据要说出来，`null` 不许退化成 0。** 区间/目标价位算不出来就是 `null`，
 *    「算出来是 0」是另一件事。合成数据（`origin==='injected'`）必须在
 *    disclosures 里点名，且**默认拒绝**用它下任何结论。
 *
 * ══ 与既有层的关系（判据 8：同一业务动作不许有两条路径）════════════════
 * · 数据源：`loadEvidence`（与因子层同一份，含 origin/dataHash/gaps）；
 * · 特征：因子台账里 `accepted` 的因子 + 引擎的 `factorSeries`（不自己造特征）；
 * · 成本口径：`DEFAULT_EXEC`（与回测/策略/breadth 同一份，不新增字面量）；
 * · 下单：**不在这里**。预测只产出证据与裁决，进不进池由既有 `tradeGate` 决定。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { DEFAULT_EXEC } from '../src/engine/types.ts'
import type { Candle } from '../src/engine/types.ts'
import { factorSeries } from '../src/engine/factorEval.ts'
import type { FactorSpec } from '../src/engine/factorEval.ts'
import { defaultIndexPath, readFactorIndex, specFromRow } from './factorService.ts'
import { loadEvidence } from './evidence.ts'
import type { EvidenceSet } from './evidence.ts'

// ─────────────────────────── 配置 ───────────────────────────

export interface ForecastConfig {
  /** 预测未来多少根 bar（15m bar ⇒ 4 根 = 1 小时）。 */
  horizonBars: number
  barMinutes: number
  /** 状态向量的维数（取训练段 |IC| 最高的前 K 个因子）。 */
  stateDims: number
  /** 取多少个历史近邻来构成条件分布。 */
  neighbors: number
  /** 走势图给到哪一步（分位带）。缺省 = horizonBars。 */
  pathSteps: number
  /** 训练段占比：只用来**选状态向量**。 */
  trainShare: number
  /** 校准用的锚点个数（从训练段之后的每一段里均匀取）。 */
  calibAnchors: number
}

export const FORECAST_DEFAULTS: Omit<ForecastConfig, 'horizonBars'> = {
  barMinutes: 15,
  stateDims: 3,
  neighbors: 200,
  pathSteps: 4,
  trainShare: 0.6,
  calibAnchors: 120,
}

export function defaultForecastConfig(patch: Partial<ForecastConfig> = {}): ForecastConfig {
  return { ...FORECAST_DEFAULTS, horizonBars: 4, ...patch }
}

/**
 * 证据底座的 bar 分辨率。**本项目只有 15m 一档真实历史**
 * （`data/history/*_15m.json`，10 个品种）。
 *
 * ★ 为什么把它做成常量并挡住调用方自报：实测过一次「未来 1 小时」被
 *   翻译成 `1m × 60 根`，而 `BTCUSDT_1m.json` 根本不存在 ⇒ `loadEvidence`
 *   **静默回落到合成 GBM** ⇒ 预测层按设计给出 `unverifiable/sample`。
 *   用户看到的是"攒数据，不是换策略"，而真相是"你选了一个不存在的分辨率"。
 *   两种事因长得一模一样，指向的动作却相反（判据 25）——
 *   所以分辨率不许由调用方定，只能钉在唯一有证据的那一档上。
 */
export const EVIDENCE_BAR_MINUTES = 15

export interface HorizonResolution {
  barMinutes: number
  horizonBars: number
  /** 用户问的是多少分钟。 */
  askedMinutes: number
  /** 实际能覆盖的分钟数（`horizonBars × barMinutes`）。 */
  actualMinutes: number
  /** 分辨率对不齐（只能四舍五入到最近一根）—— 回话里**必须**说出来（判据 24）。 */
  rounded: boolean
}

/**
 * 把「未来 N 分钟」翻译成 (barMinutes, horizonBars)。
 *
 * 只有一档证据（15m），所以 N 分钟一律四舍五入到最近的 15 分钟倍数：
 * 「未来 1 小时」→ 15m × 4 根（恰好 60 分钟，`rounded=false`）；
 * 「未来 30 分钟」→ 15m × 2；
 * 「未来 5 分钟」→ 15m × 1（`rounded=true`，实际是 15 分钟 —— 回话里要说明）。
 */
export function resolveHorizon(askedMinutes: number, barMinutes: number = EVIDENCE_BAR_MINUTES): HorizonResolution {
  const asked = Number.isFinite(askedMinutes) && askedMinutes > 0 ? askedMinutes : 60
  const bars = Math.max(1, Math.round(asked / barMinutes))
  const actualMinutes = bars * barMinutes
  return {
    barMinutes,
    horizonBars: bars,
    askedMinutes: asked,
    actualMinutes,
    rounded: Math.abs(actualMinutes - asked) > 1e-9,
  }
}

/** `GET /forecast` 的参数解析结果。 */
export type ForecastQuery =
  | { ok: true; symbol: string; horizon: HorizonResolution }
  | { ok: false; status: number; error: string; message: string }

/** 只需要 `get`/`has` 两个方法 —— 于是门禁不必造一个真的 HTTP 请求就能钉住它。 */
export interface QueryLike {
  get(k: string): string | null
  has(k: string): boolean
}

/**
 * 把 `GET /forecast` 的查询参数解析成"要算什么"。**纯函数**。
 *
 * ── 为什么抽出来 ──────────────────────────────────────────────────────
 * 端点本体住在 `server/index.ts`，而那个模块一 import 就会 `listen()`
 * —— 门禁没法在不启服务的情况下断言它（判据 10 的反面：**不可测的东西
 * 等于没被钉住**）。所以"读哪些参数、拒哪些参数"这件事落在这里，
 * `index.ts` 只剩一行调用。
 *
 * ── 为什么拒收 `horizon` / `barMinutes` ────────────────────────────────
 * ① `barMinutes` 决定 `loadEvidence` 去找哪个文件：传 `1` 会去找
 *    `BTCUSDT_1m.json`（本项目**只有 15m 一档真实历史**），找不到就
 *    **静默回落**成合成 GBM —— 而返回里方向、目标价、分位带一应俱全，
 *    与真实历史算出来的长得一模一样。两个的下一步动作却相反（判据 13）。
 * ② `horizon` 这个名字**不带单位**："60" 是 60 分钟还是 60 根？前者 1 小时、
 *    后者 15 小时（判据 21）。
 * ⇒ 只收 `minutes`（未来多少**分钟**），翻译交给唯一的 `resolveHorizon()`。
 *   旧参数**明确拒绝**，不静默忽略 —— 静默忽略会让调用方以为自己在问
 *   1 分钟，拿到的是 15 分钟的答案，而两边都不报错。
 */
export function parseForecastQuery(q: QueryLike): ForecastQuery {
  const legacy = ['horizon', 'barMinutes'].filter((k) => q.has(k))
  if (legacy.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'BAR_RESOLUTION_NOT_CALLER_SUPPLIED',
      message:
        `这个端点不接受 ${legacy.map((k) => `"${k}"`).join(' / ')}：分辨率由服务端按"唯一有证据的底座"决定，` +
        '调用方报的分辨率要么找不到历史文件（静默回落合成价格）、要么单位含糊。请改用 `?minutes=60`（未来多少分钟）。',
    }
  }
  const raw = Number(q.get('minutes') ?? '60')
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 60
  return {
    ok: true,
    symbol: (q.get('symbol') ?? 'BTCUSDT').toUpperCase(),
    horizon: resolveHorizon(minutes),
  }
}

/** 判决门槛。**住消费方**（服务层），接口拒收调用方自报的阈值。 */
export interface ForecastThresholds {
  /** 最少可用样本数（近邻数）。 */
  minSamples: number
  /** 校准锚点数下限。 */
  minAnchors: number
  /** 命中率 − 基准率 的 z 门槛。 */
  minEdgeZ: number
  /** 区间覆盖率与名义覆盖率的允许偏差（绝对值）。 */
  coverageTolerance: number
  /** 目标价位至少要盖过几个单边成本才值得做。 */
  minCostMultiple: number
}

export const DEFAULT_FORECAST_GATE: ForecastThresholds = {
  minSamples: 100,
  minAnchors: 60,
  minEdgeZ: 2,
  coverageTolerance: 0.12,
  minCostMultiple: 2,
}

// ─────────────────────────── 输出 ───────────────────────────

export type ForecastOutcome = 'actionable' | 'no-edge' | 'unverifiable'

/** 走势图的一步：未来第 `step` 根的**价位分位带**（不是一条线）。 */
export interface ForecastPathPoint {
  step: number
  p10: number
  p50: number
  p90: number
}

export interface ForecastCalibration {
  anchors: number
  /** 命中方向的锚点数（`hitRate` 的分子 —— 分子与分母一起给，读的人不必反算）。 */
  hits: number
  /** 预测方向与实际方向一致的比例。 */
  hitRate: number
  /** 基准预测器（永远猜训练段偏的方向）的命中率 —— 唯一诚实的基准。 */
  baseRate: number
  /** 基准预测器是什么，写成一句可核验的话（不许在消费方"猜"它是哪个方向）。 */
  baseRule: string
  /** 逐锚点配对差的均值 / 标准误 ⇒ `edgeZ`。 */
  se: number
  /** 配对差的 z。★ 与命中率、基准率**同源**（不是两个独立比例的差）。 */
  edgeZ: number
  /** 单侧 p 值（正态近似）。 */
  pValue: number
  /** 名义覆盖率（如 0.8）与实际覆盖率的对比。 */
  coverageNominal: number
  coverageActual: number
  /** 实际收益恰好为 0 的锚点数 —— 它们不进命中率分母。 */
  flatAnchors: number
}

export interface ForecastReason {
  /** 这条原因指向的观测量名（必须能在 row 里被核验，不许是"听起来合理"）。 */
  from: string
  text: string
}

export interface ForecastResult {
  symbol: string
  barMinutes: number
  horizonBars: number
  /** 预测所站的那根 bar 的时间戳与收盘价（"as of"）。 */
  asOf: number
  spot: number
  /**
   * 最新一根 K 线**收盘**至今多少分钟；`null` = 一根都没有。
   *
   * ★★ 它是这一层**唯一**能回答"我报的这个价位是多久以前的"的量。
   *   少了它，`spot` 与 `asOf` 就只是两个数字 —— 陈旧数据被当成"现在"
   *   讲出来，而整条链路上没有一处会红（判据 C1/C5：可观测量存在
   *   但**没有观测点**，等于不存在）。
   */
  dataAgeMinutes: number | null
  method: string
  outcome: ForecastOutcome
  gate: string
  /** `up` / `down` / `null`（样本不足时**不给方向**，而不是给"持平"）。 */
  direction: 'up' | 'down' | null
  /** 目标价位 = 中位数收益对应的价位。`null` = 算不出来。 */
  target: number | null
  /** 中位数收益（bps）。 */
  medianBps: number | null
  /** 名义 80% 区间对应的价位。 */
  interval: { lo: number; hi: number; coverage: number } | null
  /** 走势图：逐步的价位分位带。 */
  path: ForecastPathPoint[]
  /** 扣掉**往返成本**之后还剩多少 bps（可为负）。 */
  netEdgeBps: number | null
  /** 单边成本（bps），来自 `DEFAULT_EXEC`。 */
  oneWayCostBps: number
  roundTripCostBps: number
  /** 选了哪些因子当状态向量，以及它们各自的训练段 IC。 */
  state: { slug: string; nameCn: string; trainIc: number }[]
  sample: { candidates: number; matched: number; separated: number; trainBars: number; testBars: number }
  calibration: ForecastCalibration | null
  reasons: ForecastReason[]
  disclosures: string[]
  /** 面板/数据指纹：证据变了，旧结论自动作废。 */
  dataHash: string
  /**
   * 数据来源。★ 直接引用 `EvidenceSet['origin']` 而**不另起一个联合类型** ——
   * 先前我自己写了 `'history' | 'injected'`，而证据层用的是 `'synthetic'`，
   * 于是编译期就对不上。同一个事实两个名字，迟早会在某处静默判错（判据 21）。
   */
  origin: EvidenceSet['origin']
  elapsedMs: number
  /**
   * 结果级缓存的实况。
   *
   * ★ 为什么必须把它**暴露出来**而不是藏起来：这个预测一次要 6.4 秒
   *   （其中 `calibrate` 的 121 个锚点各跑一遍近邻搜索占 2.4 秒），
   *   端点、面板、桌宠三处都会问同一件事，缓存不是优化而是可用性前提。
   *   但读路径的缓存**最容易变成静默陈旧**（判据 11）—— 所以：
   *   ① 键里带 `dataHash`（证据变了必然重算，不会拿旧数据答新行情）；
   *   ② `computedAt` 与 `cache.hit` 都摆在结果里，`disclosures` 里还会写一句
   *      「复用了 X 分钟前算好的同一份数据」。陈旧是可被看见的，不是被隐藏的。
   */
  cache: { hit: boolean; computedAt: number }
}

/**
 * gate → 中文。**两个出口共用一份**（屏幕与口播），
 * 否则同一个拒绝在两处会各叫一个名字 —— 用户核对不上（判据 21）。
 */
export const FORECAST_GATE_LABEL: Record<string, string> = {
  pass: '各项门槛都过了',
  edge: '没有统计优势',
  cost: '幅度不够付成本',
  coverage: '区间偏窄',
  calibration: '校准不了',
  sample: '样本不足',
  origin: '证据不是真实历史',
}

export function describeForecastGate(gate: string): string {
  return FORECAST_GATE_LABEL[gate] ?? gate
}

/**
 * 「这份数据有多旧」的唯一文案主人（红线⑯：同一句话只能一个主人）。
 *
 * ══ 为什么这一句必须存在 ═══════════════════════════════════════════════
 * 2026-09-22 实测：`data/history/BTCUSDT_15m.json` 的最后一根 K 线是
 * **2026-09-18T04:45Z**，即**四天半以前**，而预测层照旧把它当"现在"，
 * 在口播里念成「现在 77429 美元」。用户报的「桌宠预测 BTC 的报价总是出错」
 * 里至少有一半是这一条：数字本身没算错，**是它被贴了个错的时间标签**。
 *
 * 根因不在算术，在**没有观测点**：`asOf` 一直被算出来、放进结果里，
 * 却从来没有任何一处拿它跟"现在"比过（与 §3.43 密钥权限自检同一形态）。
 *
 * ══ 为什么不设"过期阈值" ═══════════════════════════════════════════════
 * 「超过 N 分钟就不许用来下真钱」是一条**业务政策**，选 N 就是替用户决定
 * 他愿意承担多大的陈旧风险 —— 那是他的决定，不是这个函数的。
 * 所以这里只**陈述事实**：最新一根收于何时、按本分辨率算本该又有几根收完。
 * 读的人自己就能判断"这还能不能用"。
 *
 * ★ 派生量只由 `barMinutes` 决定，不引入任何新常数 ⇒ 换分辨率它自动跟着走。
 * ★ 输出**必须不含 markdown 记号**：口播会逐字念它（红线⑥）。
 * ★★ 末尾**不带句号**：屏幕版把它接在句首（要自己补 `。`），口播版把它当一个
 *   独立的句子去 `join('。')`。带句号会让口播出现「……（它没有在被更新）。。」。
 *   让"谁负责标点"也只有一个主人，比在两个出口各剥一次 `。` 可靠（红线⑯）。
 */
export function describeDataAge(ageMinutes: number | null, barMinutes: number): string {
  if (ageMinutes === null) {
    return '这份证据里一根 K 线都没有，我连"数据到什么时候"都答不出来'
  }
  // 负值 = 最后一根还没收盘（正在形成），"距今"没有意义，如实说成"刚到最新一根"。
  const mins = Math.max(0, ageMinutes)
  const human =
    mins < 1
      ? '不到 1 分钟'
      : mins < 60
        ? `${mins.toFixed(0)} 分钟`
        : mins < 60 * 48
          ? `${(mins / 60).toFixed(1)} 小时`
          : `${(mins / (60 * 24)).toFixed(1)} 天`
  // 本该收完的根数：纯算术，不是政策。0 表示"这就是最新的一根"。
  const missed = Math.floor(mins / barMinutes)
  if (missed <= 0) return `数据是最新的（最新一根 K 线收于${human}前）`
  return (
    `数据到${human}前为止 —— 按 ${barMinutes} 分钟一根算，` +
    `这之后本该又有 ${missed} 根收完，而这份数据里没有（它没有在被更新）`
  )
}

/**
 * 「最新一根 K 线收盘距今多少分钟」—— **唯一实现**。
 *
 * ★ 两条构造路（`computeForecast` 的正常路、`blank` 的样本不足路）都必须
 *   调它，否则同一个判决在两条路上会带着不同的年龄出街（判据 8）。
 * ★ 必须从 **`t + barMinutes`** 起算：Binance 的 `t` 是这根 K 线的**开盘**时刻，
 *   把开盘时刻当"数据截止时刻"会把年龄整整多算一根。
 */
function dataAgeMinutesOf(candles: readonly Candle[], barMinutes: number, now: number): number | null {
  const last = candles[candles.length - 1]
  if (!last || !Number.isFinite(last.t)) return null
  return (now - (last.t + barMinutes * 60_000)) / 60_000
}

/**
 * 证据类披露的**唯一构造点**。
 *
 * ══ 为什么要抽成函数，而不是就地拼一个数组 ═══════════════════════════
 * 因为其中一条（数据年龄）**不能跟着结果一起被缓存**。
 * 结果级缓存命中时，行情、指纹、因子台账都没变，但"现在"变了 ——
 * 若把年龄文本冻在缓存里，一次命中会让界面理直气壮地说
 * 「数据是最新的」而实际上数据已经又老了两小时。
 * 那是**比不报年龄更坏**的失败：不报年龄时用户至少不知道；
 * 报错年龄是让用户拿着一个假证据去做决定（判据 A1 / D5）。
 *
 * 所以：本函数在**两条路径上都调用** —— 首次计算时一次，缓存命中时再算一次。
 * 年龄只是 (candles, barMinutes, now) 的函数，与那 6.4 秒的重活无关，重算免费。
 */
function evidenceDisclosures(a: {
  origin: EvidenceSet['origin']
  symbol: string
  barMinutes: number
  n: number
  gaps: number
  triedPath: string
  oneWay: number
  roundTrip: number
  neighbors: number
  horizonBars: number
  dataAgeMinutes: number | null
}): string[] {
  const out: string[] = [
    `这是**条件分布**估计（当前状态在历史上最相似的 ${a.neighbors} 个时刻的未来 ${a.horizonBars} 根收益），不是确定性预测；` +
      `单点价位不可证伪，所以本模块只给分位带。`,
    `成本口径与回测/策略/breadth 同一份（${DEFAULT_EXEC.takerFeeBps} fee + ${DEFAULT_EXEC.slippageBps} slip = 单边 ${a.oneWay} bps）；净边际已扣往返 ${a.roundTrip} bps。`,
    // ★ 只报**文件名**，不报绝对路径。这段字会被**念出来**、也会落进对话记录，
    //   而一条 `C:\Users\<用户名>\…` 既不是给用户听的信息，又把本机目录结构
    //   广播进了日志。文件名（`BTCUSDC_15m.json`）已经足够回答"你读的是哪份证据"。
    `数据来源 ${a.origin} · ${a.symbol} ${a.barMinutes}m · ${a.n} 根 · 缺口 ${a.gaps} 根 · 证据文件 ${basename(a.triedPath)}`,
    // ★★ 数据年龄必须**每一份结果都带**，不是"过期时才加一句"：
    //   只有新鲜时才不说的那种写法，会让"我没说"同时对应
    //   「数据是新的」与「这个分支忘了检查」两种事因（判据 C5）。
    describeDataAge(a.dataAgeMinutes, a.barMinutes),
  ]
  if (a.origin !== 'history') {
    out.push(
      '⚠️ 这份证据来自**合成/注入**数据（磁盘上没有该品种的真实历史）。' +
        '本模块对它**默认拒绝下结论** —— 合成序列里没有真实市场结构，任何"命中率"都没有意义。',
    )
  }
  return out
}

// ─────────────────────────── 统计小工具 ───────────────────────────

/** 分位数（线性插值）。`qs` 必须已升序。空数组返回 null —— 不许退化成 0。 */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * 均值。空数组返回 `null`（不是 0）。
 * ★ 与 `quantile` 一样，**不许把"没有样本"伪装成"结果是 0"**。
 */
export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/** 皮尔逊相关。任一侧样本不足或方差为 0 ⇒ `null`（"算不出来"≠"相关为 0"）。 */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
  }
  const mx = sx / n
  const my = sy / n
  let cxy = 0
  let vxx = 0
  let vyy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    cxy += dx * dy
    vxx += dx * dx
    vyy += dy * dy
  }
  if (vxx <= 0 || vyy <= 0) return null
  return cxy / Math.sqrt(vxx * vyy)
}

/** z 分数序列：用**前 `lookback` 根**的均值/标准差标准化（不许用未来数据）。 */
export function rollingZ(xs: readonly (number | null)[], lookback: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null)
  if (lookback < 8) return out
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let i = 0; i < xs.length; i++) {
    // ★ 进与出必须**用同一个下标来源成对**：`xs[i]` 进、`xs[i-lookback]` 出。
    //
    //   第一版用了一个"只装非空值"的队列，出窗时 `window.shift()` 移除的是
    //   **最老的非空值**，而 `sum -= xs[i-lookback]` 扣的是**下标对应的那个值**。
    //   当离窗位置恰好是 null 时，队列不动、sum 却照扣 —— 两套表示法就此错位，
    //   累计量一路漂下去，最后 `varI = E[x²] − (E[x])²` 变成**负数**，
    //   于是整根 z 返回 null。表现是"短序列上一个近邻都找不到"，
    //   而根因在一百行之外的窗口管理（判据 25：两种事因长得一模一样）。
    const leave = i - lookback
    if (leave >= 0) {
      const d = xs[leave]
      if (d !== null && Number.isFinite(d)) {
        sum -= d
        sumSq -= d * d
        count--
      }
    }
    const v = xs[i]
    const vOk = v !== null && Number.isFinite(v)
    if (vOk) {
      sum += v
      sumSq += v * v
      count++
    }
    if (count >= 20) {
      const m = sum / count
      const varI = sumSq / count - m * m
      // varI ≤ 0 有两种事因：窗口内确实没有波动（合法的 null），
      // 或者累计量已经和窗口脱钩（就是上面那个 bug）。修好配对之后只剩前者。
      if (varI > 0) out[i] = vOk ? (v - m) / Math.sqrt(varI) : null
    }
  }
  return out
}

/**
 * 标准正态的**上尾**概率 `P(Z ≥ z)`。
 *
 * ★ 这里刻意**只有一个**统计量（配对差的 z），不并排放"命中率 vs 50% 的二项检验"：
 *   两个统计量对同一件事给出两个 p 值，读者一定会挑对自己有利的那个，
 *   而两个都"看着正常"（判据 21 / 32 的同族）。
 *
 * 用 Abramowitz & Stegun 7.1.26（绝对误差 < 7.5e-8）而不是手抄一张 24 项系数表：
 * 后者第一版就把 `6.4196979235649026e-1` 这种超过双精度位数的字面量写进了源码，
 * 被 lint 的 `no-loss-of-precision` 拦下 —— 抄来的常数是**没人会去核对**的那种错。
 */
export function normalUpper(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const density = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const tail =
    density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? tail : 1 - tail
}

// ─────────────────────────── 特征准备 ───────────────────────────

interface Prepared {
  specs: FactorSpec[]
  /** 每个因子的滚动 z 序列（与 candles 等长）。 */
  zs: (number | null)[][]
  /** 每个人被选中因子在训练段的 IC。 */
  trainIc: number[]
  /** 状态向量可用的第一根 bar（预热完毕）。 */
  firstUsable: number
}

/** 因子序列的缓存键：数据指纹 + 候选集指纹。数据/台账变了就重算。 */
const prepareCache = new Map<string, Prepared>()

function acceptedSpecs(cwd: string): FactorSpec[] {
  const { index } = readFactorIndex(defaultIndexPath(cwd))
  return index.rows.filter((r) => r.state === 'accepted').map((r) => specFromRow(r))
}

/**
 * 选状态向量：**只看训练段**。
 *
 * 为什么不能在全段上选：在全段上挑"IC 最高的 3 个因子"，再拿同一段去算命中率，
 * 命中的那部分几乎是挑出来时就注定的 —— 那不是证据（判据：训练定方向、样本外判决）。
 */
function prepare(
  cfg: ForecastConfig,
  candles: Candle[],
  dataHash: string,
  specs: FactorSpec[],
): Prepared {
  const key = `${dataHash}|${cfg.stateDims}|${cfg.trainShare}|${candles.length}|${specs.map((s) => s.slug).join(',')}`
  const hit = prepareCache.get(key)
  if (hit) return hit

  const n = candles.length
  const trainEnd = Math.floor(n * cfg.trainShare)
  const lookback = 96

  const scored: { spec: FactorSpec; z: (number | null)[]; ic: number }[] = []
  for (const spec of specs) {
    let raw: (number | null)[]
    try {
      raw = factorSeries(spec, candles)
    } catch {
      continue // 台账里可能出现本版本引擎不认识的 base/transform —— 跳过而不是崩
    }
    const z = rollingZ(raw, lookback)
    // 训练段 IC：factor[i] 与 未来 h 根收益 的相关（只用训练段内、且两端都落在那一段）
    const xs: number[] = []
    const ys: number[] = []
    for (let i = lookback; i + cfg.horizonBars < trainEnd; i++) {
      const zv = z[i]
      if (zv === null) continue
      const r = (candles[i + cfg.horizonBars].c / candles[i].c - 1) * 10_000
      xs.push(zv)
      ys.push(r)
    }
    const ic = pearson(xs, ys)
    if (ic === null) continue
    scored.push({ spec, z, ic })
  }
  scored.sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic))
  const chosen = scored.slice(0, cfg.stateDims)

  // 状态向量可用的第一根 bar：所有被选因子的 z 都非空
  let firstUsable = lookback
  for (let i = lookback; i < n; i++) {
    if (chosen.every((c) => c.z[i] !== null)) {
      firstUsable = i
      break
    }
  }

  const prepared: Prepared = {
    specs: chosen.map((c) => c.spec),
    zs: chosen.map((c) => c.z),
    trainIc: chosen.map((c) => c.ic),
    firstUsable,
  }
  prepareCache.set(key, prepared)
  return prepared
}

/**
 * 只给测试用：清缓存。
 *
 * ★ 两个缓存**必须一起清**。烟测的夹具会给不同的合成序列打同一个 `dataHash`
 *   （旧版是 `test-${length}-${origin}`，与 seed 无关）—— 只清 `prepareCache`
 *   的话，`synth(3000,3)` 的结论会被 `synth(3000,5)` 直接复用，
 *   而用例看起来全绿（这是本仓库栽过的那类**假绿**：检查与被检查的东西
 *   其实用了同一份数据）。夹具那边也已改成按内容算指纹，两道一起做。
 */
export function resetForecastCache(): void {
  prepareCache.clear()
  forecastCache.clear()
}

// ─────────────────────────── 近邻搜索 ───────────────────────────

interface Analog {
  /** 历史锚点的下标。 */
  at: number
  /** 到当前状态的距离（z 空间欧氏）。 */
  dist: number
  /** 该锚点之后 h 根的收益（bps）。 */
  bps: number
}

/**
 * 按距离贪心取近邻，且**已选中的点在 ±h 根之内全部跳过**。
 *
 * ★ 不这么做的话，一段趋势里相邻的几百根会全被选进来 —— 它们共享同一段未来行情，
 *   条件分布的"200 个样本"实际只有几个独立观测，区间会被压得过窄，
 *   而窄区间会让覆盖率检验**看起来**通过（这是最危险的一种假绿）。
 */
/**
 * 近邻搜索（导出给烟测用 —— "样本之间不重叠"这条不变量必须能被**直接断言**，
 * 而不是靠"读源码看见有个 blocked 数组"）。
 */
export function pickAnalog(
  prepared: Prepared,
  candles: Candle[],
  query: number,
  searchFrom: number,
  searchTo: number,
  cfg: ForecastConfig,
): { matched: Analog[]; separated: number } {
  const horizon = cfg.horizonBars
  const q: number[] = []
  for (const z of prepared.zs) {
    const v = z[query]
    if (v === null) return { matched: [], separated: 0 }
    q.push(v)
  }

  const cands: Analog[] = []
  for (let i = searchFrom; i + horizon < searchTo; i++) {
    let d2 = 0
    let ok = true
    for (let k = 0; k < prepared.zs.length; k++) {
      const v = prepared.zs[k][i]
      if (v === null) {
        ok = false
        break
      }
      const dv = v - q[k]
      d2 += dv * dv
    }
    if (!ok) continue
    if (i + horizon >= candles.length) continue
    cands.push({ at: i, dist: Math.sqrt(d2), bps: (candles[i + horizon].c / candles[i].c - 1) * 10_000 })
  }
  cands.sort((a, b) => a.dist - b.dist)

  const matched: Analog[] = []
  const blocked: { from: number; to: number }[] = []
  let separated = 0
  for (const c of cands) {
    if (matched.length >= cfg.neighbors) break
    const clash = blocked.some((b) => c.at >= b.from && c.at <= b.to)
    if (clash) {
      separated++
      continue
    }
    matched.push(c)
    blocked.push({ from: c.at - horizon, to: c.at + horizon })
  }
  return { matched, separated }
}

// ─────────────────────────── 主流程 ───────────────────────────

export interface ForecastOptions {
  symbol?: string
  cwd?: string
  config?: Partial<ForecastConfig>
  thresholds?: ForecastThresholds
  /**
   * 测试用：直接给定候选因子，**绕过因子台账**。
   *
   * 与 `evidence` 同一个理由：烟测必须与"这台机器上跑没跑过因子生产"无关，
   * 否则它会变成环境依赖用例（门禁最怕的一种红 —— 与代码无关的红）。
   * 生产路径永远取台账里 `accepted` 的那批。
   */
  specs?: FactorSpec[]
  /**
   * 测试用：直接给定证据，**绕过 `loadEvidence`**。
   *
   * 为什么必须有这个口子：烟测要在**合成序列**上断言语义不变量
   * （"合成数据一律不给 actionable"、"改未来数据不许影响 z 的前缀"），
   * 而那些序列不在磁盘上。生产路径永远走 `loadEvidence` —— 这个字段
   * 只被 `scripts/forecast-smoke.ts` 使用，且 CI 里有断言钉住这一点。
   */
  evidence?: {
    candles: Candle[]
    origin: EvidenceSet['origin']
    dataHash: string
    gaps?: number
    triedPath?: string
  }
  /**
   * 测试用：把"现在"钉住，**只影响 `dataAgeMinutes` 这一个观测量的读数**。
   *
   * 为什么必须可注入：烟测的合成序列时间戳从 epoch 起（`t = (i+1)*900_000`，
   * 3000 根 ⇒ 最后一根落在 1970-01-31）。若这里写死 `Date.now()`，**每一条**
   * 夹具都会报出"数据到 56 年前为止"，而关于年龄的断言就变成了夹具自己的
   * 产物、与生产行为无关（判据 D9：夹具必须照生产形状造）。
   *
   * ★ 它**不是**"调用方自报结论"那一类：年龄怎么算完全在服务端，这个入参
   *   只能移动"现在"，不能改变数据本身，也不能让一个坏预测变好。
   *   HTTP 端点不转接它（与 `specs` / `evidence` 同一条规矩）。
   */
  now?: number
}

// ─────────────────────── 结果缓存（可用性前提，不是优化）───────────────────────
//
// 实测（`_fcost_r24.txt`）：一次完整预测 6.4 秒，其中 `prepare`（因子 z 序列
// + 训练段 IC）约 4.0 秒、`calibrate`（121 个锚点各跑一遍近邻搜索）约 2.4 秒；
// `prepare` 有缓存后第二次仍是 2.4 秒。端点、面板、桌宠三处都会问同一件事，
// 没有结果级缓存的话，用户每次问都要等 6 秒 —— 那不是"慢"，那是看起来坏了。
//
// ★ 键里**必须**带 `dataHash`：证据文件一变，指纹就变，缓存自然作废。
//   只按 symbol+horizon 做键会拿旧行情答新问题，而答案长得完全正常（判据 11）。
const forecastCache = new Map<string, ForecastResult>()
const FORECAST_CACHE_MAX = 32

/**
 * 缓存键。**必须覆盖结果依赖的每一样东西**，否则就是一条静默的陈旧读路径。
 *
 * 逐项的理由（少任何一项都会长生一个"看着完全正常的错答案"）：
 *   · `dataHash`  —— 行情数据变了；证据层是按内容算的（`contentHash`）。
 *   · `origin`    —— ★ 同一个 `dataHash` 可以对应两种来源：证据层对合成回退
 *                    也是按内容算指纹，所以"同一份 K 线、一个标 history 一个标
 *                    synthetic"会撞键。而 `origin` 决定 `origin` 闸门过不过 ——
 *                    撞键的后果是**用真实历史算出的结论去回答合成数据的问题**。
 *   · `specsFp`   —— ★ 最隐蔽的一项：因子的**选中集**（台账里 accepted 的那批）
 *                    决定状态向量，而台账变化与行情数据变化**毫无关系**。
 *                    重新跑一轮因子生产之后，市场一根没变、数据指纹一样，
 *                    但结论按定义已经不同了 —— 只按 dataHash 做键会把旧结论发出去。
 *   · 其余各项    —— 配置与门槛，任一改动都会改变判决。
 */
function forecastCacheKey(
  cfg: ForecastConfig,
  th: ForecastThresholds,
  symbol: string,
  dataHash: string,
  origin: EvidenceSet['origin'],
  specsFp: string,
): string {
  return [
    symbol,
    dataHash,
    origin,
    specsFp,
    cfg.barMinutes,
    cfg.horizonBars,
    cfg.stateDims,
    cfg.neighbors,
    cfg.pathSteps,
    cfg.trainShare,
    cfg.calibAnchors,
    th.minSamples,
    th.minAnchors,
    th.minEdgeZ,
    th.coverageTolerance,
    th.minCostMultiple,
  ].join('|')
}

/** 只给测试用：清掉结果缓存（`resetForecastCache` 已含它，这里保留是为了让用例能只清一层）。 */
export function resetForecastResultCache(): void {
  forecastCache.clear()
}

/** 取数结果（注入口与生产路径合流后的**唯一**形态）。 */
interface ResolvedEvidence {
  candles: Candle[]
  origin: EvidenceSet['origin']
  dataHash: string
  gaps: number
  triedPath: string
}

/**
 * 交付前的**唯一**一道收口：把只对 markdown 渲染器有意义的记号剥掉。
 *
 * ── 为什么必须有这么一个统一出口，而不是"在每个 `reasons.push` 处小心点" ──
 * 本项目**没有任何 markdown 渲染器**：CLI 的 `console.log`、面板的 React
 * 文本节点都会把 `**` 原样显示出来，口播更会念成"星号星号"。
 * 而 `reasons` 与 `disclosures` 有**两个**构造出口
 * （`computeForecast` 的正常路、`blank` 的样本不足路）。
 * 只在其中一个剥 ⇒ 同一句话在两条路上文本不同，而"算不出来"那一屏
 * 恰好走的是没剥的那条（判据 8：同一个动作两条路径 ⇒ 迟早只改一处）。
 *
 * ★ 位置选在 `forecast()`：`computeForecast` 是模块私有的，**所有**结果
 *   （含缓存命中时追加的那条披露）都必须经过 `forecast()` 才出得去。
 *   出口只有一个，剥一次就够 —— 出口之后不许再改动这两个字段。
 */
function finalize(r: ForecastResult): ForecastResult {
  return {
    ...r,
    reasons: r.reasons.map((x) => ({ ...x, text: markupFree(x.text) })),
    disclosures: r.disclosures.map(markupFree),
  }
}

/**
 * 唯一对外入口。
 *
 * ★ 它只有两件事：**取数**（`loadEvidence` 在全文只出现这一次）与**查缓存**。
 *   真正算东西的是 `computeForecast` —— 拆开是因为缓存必须在"已经拿到
 *   `dataHash`、但还没开算"的那个位置生效，而那个位置在原来的单函数体里
 *   插不进去（三处 `return` 都要落缓存，漏一处就有了"某些结论永不被复用/
 *   有些旧结论永远赖着不走"的静默不一致）。
 */
export function forecast(opts: ForecastOptions = {}): ForecastResult {
  const cfg = defaultForecastConfig(opts.config)
  const th = opts.thresholds ?? DEFAULT_FORECAST_GATE
  const symbol = (opts.symbol ?? 'BTCUSDT').toUpperCase()
  const cwd = opts.cwd ?? process.cwd()

  // ★ 注入口与生产路径**互斥**，不许"合并"：`live` 只在没有注入时才存在，
  //   写成 `opts.evidence?.gaps ?? live!.gaps` 会在注入时去读一个 null
  //   （第一版就是这么写的，烟测 12 条一起报 "Cannot read properties of null"）。
  const injected = opts.evidence ?? null
  const live = injected === null ? loadEvidence(symbol, cfg.barMinutes) : null
  const ev: ResolvedEvidence = {
    candles: injected ? injected.candles : live!.candles,
    origin: injected ? injected.origin : live!.origin,
    dataHash: injected ? injected.dataHash : live!.dataHash,
    gaps: injected ? (injected.gaps ?? 0) : live!.gaps,
    triedPath: injected ? (injected.triedPath ?? '(injected)') : live!.triedPath,
  }

  // ★ 候选因子**只在这里读一次**，再往下传（判据 8：同一个业务动作不许有两条路径）。
  //   放到 `computeForecast` 里读的后果不只是重复：缓存键要覆盖"选中了哪批因子"，
  //   而键必须在开算**之前**就能算出来 —— 读在下面、键在上面，就只能靠猜。
  const specs = opts.specs ?? acceptedSpecs(cwd)

  const key = forecastCacheKey(cfg, th, symbol, ev.dataHash, ev.origin, specs.map((s) => s.slug).join(','))
  const cached = forecastCache.get(key)
  if (cached) {
    const ageMin = (Date.now() - cached.cache.computedAt) / 60_000
    // ★★ 数据年龄**必须在命中时重算**（见 `evidenceDisclosures` 上的说明）。
    //   它只是 (candles, barMinutes, now) 的函数，与那 6.4 秒的重活无关 ⇒ 重算免费。
    //   沿用缓存里的旧值会让界面理直气壮地说「数据是最新的」，
    //   而数据其实已经又老了两小时 —— 那是**主动撒谎**，比不报年龄更坏。
    const nowHit = opts.now ?? Date.now()
    const dataAgeMinutes = dataAgeMinutesOf(ev.candles, cfg.barMinutes, nowHit)
    const oneWay = DEFAULT_EXEC.takerFeeBps + DEFAULT_EXEC.slippageBps
    return finalize({
      ...cached,
      cache: { hit: true, computedAt: cached.cache.computedAt },
      dataAgeMinutes,
      // ★ 披露列表**整份重建**而不是"把旧的那句替换掉"：按内容查找替换
      //   在文案改一个字之后就静默不再命中，而症状是"缓存命中时年龄不动"
      //   —— 又是一个只有读代码才能发现的洞（判据 B3）。
      //   整份重建还有第二个好处：这条路径与首次计算路径**用同一段代码**，
      //   两条路不可能给出不同的披露（判据 8）。
      disclosures: [
        ...evidenceDisclosures({
          origin: ev.origin,
          symbol,
          barMinutes: cfg.barMinutes,
          n: ev.candles.length,
          gaps: ev.gaps,
          triedPath: ev.triedPath,
          oneWay,
          roundTrip: oneWay * 2,
          neighbors: cfg.neighbors,
          horizonBars: cfg.horizonBars,
          dataAgeMinutes,
        }),
        // ★ 陈旧必须**看得见**：不说这一句的话，"同样的数字"在用户那里
        //   与"刚算出来的"完全一样 —— 而它们的新鲜度可能差半小时（判据 11）。
        //   ★ 但这句话**不许**声称"每一个数字都一模一样"了：年龄是唯一例外
        //     （它按当下重算，这正是上面那条修复的目的）。说明与实现必须一致（判据 D7）。
        `本次没有重算：复用了 ${ageMin < 1 ? '不到 1' : ageMin.toFixed(1)} 分钟前对同一份证据（指纹 ${cached.dataHash.slice(0, 10)}）算出的结果。` +
          `数据、证据来源、因子台账任一变指纹就变、缓存自然作废，所以行情类数字必然与刚算出来的一模一样；` +
          `唯一每次都变的是数据年龄那一句，它按当下重算。`,
      ],
    })
  }

  const fresh = computeForecast(opts, cfg, th, symbol, ev, specs)
  if (forecastCache.size >= FORECAST_CACHE_MAX) {
    const oldest = forecastCache.keys().next().value
    if (oldest !== undefined) forecastCache.delete(oldest)
  }
  forecastCache.set(key, fresh)
  return finalize(fresh)
}

function computeForecast(
  opts: ForecastOptions,
  cfg: ForecastConfig,
  th: ForecastThresholds,
  symbol: string,
  ev: ResolvedEvidence,
  specs: FactorSpec[],
): ForecastResult {
  const t0 = Date.now()
  const oneWay = DEFAULT_EXEC.takerFeeBps + DEFAULT_EXEC.slippageBps
  const roundTrip = oneWay * 2

  const candles = ev.candles
  const origin: EvidenceSet['origin'] = ev.origin
  const dataHash = ev.dataHash
  const gaps = ev.gaps
  const triedPath = ev.triedPath
  const n = candles.length
  // ★ "现在"只在这里取一次，两条构造路（正常路 / blank）都由它推年龄 ——
  //   各取一次的话，同一份结果在两条路上的年龄会差几百毫秒，看着无伤，
  //   但那正好是"同一句话两个主人"的雏形（红线⑯）。
  const now = opts.now ?? Date.now()
  const dataAgeMinutes = dataAgeMinutesOf(candles, cfg.barMinutes, now)
  const disclosures = evidenceDisclosures({ origin, symbol, barMinutes: cfg.barMinutes, n, gaps, triedPath, oneWay, roundTrip, neighbors: cfg.neighbors, horizonBars: cfg.horizonBars, dataAgeMinutes })

  const prepared = prepare(cfg, candles, dataHash, specs)
  const state = prepared.specs.map((s, i) => ({ slug: s.slug, nameCn: s.nameCn, trainIc: prepared.trainIc[i] }))

  // ── 有效窗口 ──
  const trainEnd = Math.floor(n * cfg.trainShare)
  const minBars = 96 + 20 + cfg.neighbors + cfg.horizonBars
  if (n < minBars || prepared.specs.length < cfg.stateDims) {
    return blank({
      symbol,
      cfg,
      ev: { candles, origin, dataHash },
      now,
      oneWay,
      roundTrip,
      state,
      disclosures,
      gate: 'sample',
      outcome: 'unverifiable',
      reasons: [
        {
          from: 'sample',
          text:
            `可用数据不足：需要 ≥ ${minBars} 根，实际 ${n} 根` +
            `（状态向量 ${prepared.specs.length}/${cfg.stateDims} 维就绪）。**攒数据，不是换策略。**`,
        },
      ],
      elapsedMs: Date.now() - t0,
    })
  }

  const query = n - 1
  // ★ 实盘查询的近邻池是**全部已实现未来的历史**（`searchTo = n` ⇒ 循环条件
  //   `i + horizon < n` 恰好等价于"第 i 根的未来第 h 根已收盘"）。
  //   先前这里传的是 `trainEnd`，等于把后 40% 历史扔掉不用 ——
  //   而训练/检验切分的用途是**选状态向量 + 校准**，不是限制实盘取样的范围。
  //   校准那边传 `searchTo = a`（决策点当刻），两者是同一条规则：
  //   「池 = 一切未来已实现的、且严格早于决策点的 bar」。
  const { matched, separated } = pickAnalog(prepared, candles, query, prepared.firstUsable, n, cfg)

  // ── 校准：walk-forward，锚点全部落在**训练段之后** ──
  const calibration = calibrate(prepared, candles, cfg, th, trainEnd, n)

  // ── 条件分布 ──
  const bpsSorted = matched.map((m) => m.bps).sort((a, b) => a - b)
  const medianBps = quantile(bpsSorted, 0.5)
  const p10 = quantile(bpsSorted, 0.1)
  const p90 = quantile(bpsSorted, 0.9)
  const spot = candles[query].c

  // ── 走势图：逐步的分位带（价位）──
  const path: ForecastPathPoint[] = []
  for (let step = 1; step <= cfg.pathSteps; step++) {
    const stepBps: number[] = []
    for (const m of matched) {
      const j = m.at + step
      if (j >= n) continue
      stepBps.push((candles[j].c / candles[m.at].c - 1) * 10_000)
    }
    stepBps.sort((a, b) => a - b)
    const q10 = quantile(stepBps, 0.1)
    const q50 = quantile(stepBps, 0.5)
    const q90 = quantile(stepBps, 0.9)
    if (q10 === null || q50 === null || q90 === null) continue
    path.push({
      step,
      p10: spot * (1 + q10 / 10_000),
      p50: spot * (1 + q50 / 10_000),
      p90: spot * (1 + q90 / 10_000),
    })
  }

  const direction: 'up' | 'down' | null = medianBps === null ? null : medianBps > 0 ? 'up' : medianBps < 0 ? 'down' : null
  const target = medianBps === null ? null : spot * (1 + medianBps / 10_000)
  const interval =
    p10 === null || p90 === null ? null : { lo: spot * (1 + p10 / 10_000), hi: spot * (1 + p90 / 10_000), coverage: 0.8 }
  const netEdgeBps = medianBps === null ? null : Math.abs(medianBps) - roundTrip

  // ── 判决：四道闸门，**每一种事因一个 gate 名**（它们指向的动作完全相反）──
  let outcome: ForecastOutcome
  let gate: string
  const reasons: ForecastReason[] = []

  if (matched.length < th.minSamples) {
    outcome = 'unverifiable'
    gate = 'sample'
    reasons.push({
      from: 'matched',
      text: `历史相似时刻只找到 ${matched.length} 个（门槛 ${th.minSamples}）⇒ 条件分布的尾部不可信。攒数据，不是换方法。`,
    })
  } else if (!calibration || calibration.anchors < th.minAnchors) {
    outcome = 'unverifiable'
    gate = 'calibration'
    reasons.push({
      from: 'anchors',
      text:
        `样本外校准锚点只有 ${calibration?.anchors ?? 0} 个（门槛 ${th.minAnchors}）` +
        `⇒ **无法判断这个预测器准不准**。这与"预测器不准"是两件事，动作也不同（前者攒数据，后者换方法）。`,
    })
  } else if (origin !== 'history') {
    outcome = 'unverifiable'
    gate = 'origin'
    reasons.push({ from: 'origin', text: `证据来自 ${origin}，不是真实历史 ⇒ 命中率不可解释。` })
  } else if (calibration.edgeZ < th.minEdgeZ) {
    outcome = 'no-edge'
    gate = 'edge'
    reasons.push({
      from: 'edgeZ',
      text:
        `方向命中率 ${(calibration.hitRate * 100).toFixed(1)}%（${calibration.hits}/${calibration.anchors} 个样本外锚点）` +
        `，对照的平凡规则是「${calibration.baseRule}」的 ${(calibration.baseRate * 100).toFixed(1)}%。` +
        `逐锚点配对差 z=${calibration.edgeZ.toFixed(2)}（门槛 ${th.minEdgeZ}）、p=${calibration.pValue.toFixed(3)}。` +
        `**这个预测器与那条平凡规则分不开** —— 结论是"没有统计优势"，不是"预测下跌"。` +
        `（注意这是两件不同的事：前者该换方法或攒数据，后者才是行情判断。）`,
    })
  } else if (Math.abs(calibration.coverageActual - calibration.coverageNominal) > th.coverageTolerance) {
    outcome = 'no-edge'
    gate = 'coverage'
    reasons.push({
      from: 'coverage',
      text:
        `名义 ${(calibration.coverageNominal * 100).toFixed(0)}% 区间实际只覆盖 ${(calibration.coverageActual * 100).toFixed(1)}%` +
        ` ⇒ 区间**偏窄**（真实不确定性被低估），按它设止盈止损会偏紧。`,
    })
  } else if (netEdgeBps === null || netEdgeBps <= 0) {
    outcome = 'no-edge'
    gate = 'cost'
    reasons.push({
      from: 'netEdgeBps',
      text:
        `中位幅度 ${medianBps === null ? 'n/a' : medianBps.toFixed(2)} bps，往返成本 ${roundTrip} bps` +
        ` ⇒ 净 ${netEdgeBps === null ? 'n/a' : netEdgeBps.toFixed(2)} bps。**方向可能对，但幅度不够付成本** —— 该降换手/降费率，不是该换方法。`,
    })
  } else {
    outcome = 'actionable'
    gate = 'pass'
  }

  // ★ 判决为 `unverifiable` ⇒ **一个数字都不给**：方向/目标价位/区间/走势图全部为 null/空。
  //   理由：这些数字会被当成"预测"直接拿去做决定，而这一档的语义恰恰是"现在还判不了"。
  //   `no-edge` 不一样 —— 那里有足够证据说"这个方向没有优势"，数字留着是**带标注的信息**；
  //   `unverifiable` 是没有证据，给出数字只会被误读。
  //   两条路径（数据太短 / 样本不足）必须**行为一致**，否则同一个判决在两条路上长得不同（判据 8）。
  if (outcome === 'unverifiable') {
    return blank({
      symbol,
      cfg,
      ev: { candles, origin, dataHash },
      now,
      oneWay,
      roundTrip,
      state,
      disclosures,
      gate,
      outcome,
      reasons,
      elapsedMs: Date.now() - t0,
      sample: { candidates: n, matched: matched.length, separated, trainBars: trainEnd, testBars: n - trainEnd },
    })
  }

  // ── 原因：每条都指向一个可核验的观测量 ──
  if (state.length > 0) {
    reasons.push({
      from: 'state',
      text:
        `状态向量 = ` +
        state.map((s) => `${s.nameCn}(${s.slug}，训练段 IC ${s.trainIc.toFixed(3)})`).join('、') +
        ` —— 这三个是训练段 ｜IC｜ 最高的（选它只看训练段，命中率另在样本外算）。`,
    })
  }
  if (medianBps !== null && p10 !== null && p90 !== null) {
    reasons.push({
      from: 'interval',
      text:
        `未来 ${cfg.horizonBars} 根（约 ${((cfg.horizonBars * cfg.barMinutes) / 60).toFixed(1)} 小时）收益中位 ${medianBps.toFixed(2)} bps、` +
        `80% 区间 [${p10.toFixed(2)}, ${p90.toFixed(2)}] bps ⇒ 价位 ${interval ? `${interval.lo.toFixed(2)} ~ ${interval.hi.toFixed(2)}` : 'n/a'}。` +
        `区间宽 ${p90 - p10 === 0 ? '0' : ((p90 - p10) / 10_000 * spot).toFixed(2)} 美元 —— 这个宽度本身就是"确定性有多低"的读数。`,
    })
  }
  if (separated > 0) {
    reasons.push({
      from: 'separated',
      text:
        `近邻取样时跳过了 ${separated} 个与已选点相隔不到 ${cfg.horizonBars} 根的时刻` +
        `（它们的未来收益与已选点重叠，算进去会把有效样本量虚高、区间压窄）。`,
    })
  }

  const result: ForecastResult = {
    symbol,
    barMinutes: cfg.barMinutes,
    horizonBars: cfg.horizonBars,
    asOf: candles[query].t,
    spot,
    dataAgeMinutes,
    method: `analog-conditional-distribution(k=${prepared.zs.length}, n=${cfg.neighbors}, sep=${cfg.horizonBars})`,
    outcome,
    gate,
    direction,
    target,
    medianBps,
    interval,
    path,
    netEdgeBps,
    oneWayCostBps: oneWay,
    roundTripCostBps: roundTrip,
    state,
    sample: {
      candidates: n,
      matched: matched.length,
      separated,
      trainBars: trainEnd,
      testBars: n - trainEnd,
    },
    calibration,
    reasons,
    disclosures,
    dataHash,
    origin,
    cache: { hit: false, computedAt: Date.now() },
    elapsedMs: Date.now() - t0,
  }
  return result
}

// ─────────────────────────── 校准 ───────────────────────────

/**
 * 样本外校准：锚点在**训练段之后**均匀取，每个锚点只用它**之前**的数据找近邻。
 *
 * ★ 为什么锚点必须落在训练段之后：状态向量是在训练段上按 |IC| 挑的，
 *   在训练段内评命中率等于"用挑它时的同一批数据评它" —— 那是恒等式。
 */
function calibrate(
  prepared: Prepared,
  candles: Candle[],
  cfg: ForecastConfig,
  _th: ForecastThresholds,
  trainEnd: number,
  n: number,
): ForecastCalibration | null {
  const h = cfg.horizonBars

  // ── 基准预测器：**永远猜训练段偏的那个方向** ──
  // ★ 它必须无泄漏。先前版本用的是"整段里占多数的方向"，那个多数方向里
  //   含**锚点之后**的行情 —— 基准被未来的信息加强了。基准越强越容易得出
  //   "没优势"，看着保守，其实是**把结论建在泄漏上**（判据 25：换一种事因，
  //   结论长得一样，你分不出）。
  //   用训练段的漂移方向就没有这个问题：它在**所有**锚点之前就固定了。
  const trainRets: number[] = []
  for (let i = prepared.firstUsable; i + h < trainEnd; i++) {
    trainRets.push((candles[i + h].c / candles[i].c - 1) * 10_000)
  }
  const trainMean = mean(trainRets)
  const baseUp = (trainMean ?? 0) > 0
  const baseRule =
    `永远猜训练段偏的方向（${baseUp ? '上涨' : '下跌'}，训练段 ${h} 根均值 ` +
    `${trainMean === null ? 'n/a' : trainMean.toFixed(2)} bps）`

  const anchors: number[] = []
  const usableFrom = Math.max(prepared.firstUsable + cfg.neighbors, trainEnd)
  const lastAnchor = n - 1 - h
  if (lastAnchor <= usableFrom) return null
  const stride = Math.max(1, Math.floor((lastAnchor - usableFrom) / cfg.calibAnchors))
  for (let a = usableFrom; a <= lastAnchor; a += stride) anchors.push(a)

  let hits = 0
  let baseHits = 0
  let count = 0
  let flat = 0
  let covered = 0
  const diffs: number[] = []
  for (const a of anchors) {
    const { matched } = pickAnalog(prepared, candles, a, prepared.firstUsable, a, cfg)
    if (matched.length < 20) continue
    const sorted = matched.map((m) => m.bps).sort((x, y) => x - y)
    const med = quantile(sorted, 0.5)
    const lo = quantile(sorted, 0.1)
    const hi = quantile(sorted, 0.9)
    if (med === null || lo === null || hi === null) continue
    const realized = (candles[a + h].c / candles[a].c - 1) * 10_000
    if (realized === 0) {
      flat++
      continue
    }
    const dirHit = med > 0 ? realized > 0 : med < 0 ? realized < 0 : false
    const baseHit = baseUp ? realized > 0 : realized < 0
    if (dirHit) hits++
    if (baseHit) baseHits++
    count++
    // ★ 配对差：两个预测器用的是**同一批锚点**，要比的是**逐锚点之差**，
    //   不是两个独立比例。用独立比例的 SE 会把噪声算错，而"算小了"
    //   会平白判出优势 —— 这是这一层最贵的一种假绿。
    diffs.push((dirHit ? 1 : 0) - (baseHit ? 1 : 0))
    if (realized >= lo && realized <= hi) covered++
  }
  if (count === 0) return null

  const hitRate = hits / count
  const baseRate = baseHits / count
  const dMean = diffs.reduce((s, d) => s + d, 0) / diffs.length
  const dVar = diffs.reduce((s, d) => s + (d - dMean) ** 2, 0) / Math.max(diffs.length - 1, 1)
  const se = Math.sqrt(Math.max(dVar, 1e-12) / diffs.length)
  const edgeZ = se > 0 ? dMean / se : 0
  return {
    anchors: count,
    hits,
    hitRate,
    baseRate,
    baseRule,
    se,
    edgeZ,
    pValue: normalUpper(edgeZ),
    coverageNominal: 0.8,
    coverageActual: covered / count,
    flatAnchors: flat,
  }
}

// ─────────────────────────── 空结果 ───────────────────────────

function blank(args: {
  symbol: string
  cfg: ForecastConfig
  ev: { origin: EvidenceSet['origin']; dataHash: string; candles: Candle[] }
  /** "现在"。★ 由 `computeForecast` 单点取好后传进来 —— 别在这里再取一次 `Date.now()`。 */
  now: number
  oneWay: number
  roundTrip: number
  state: { slug: string; nameCn: string; trainIc: number }[]
  disclosures: string[]
  gate: string
  outcome: ForecastOutcome
  reasons: ForecastReason[]
  elapsedMs: number
  /** 运行期算出来的样本事实（"数据长度不足"那条路没有，所以留可选）。 */
  sample?: ForecastResult['sample']
}): ForecastResult {
  const last = args.ev.candles[args.ev.candles.length - 1]
  return {
    symbol: args.symbol,
    barMinutes: args.cfg.barMinutes,
    horizonBars: args.cfg.horizonBars,
    asOf: last?.t ?? 0,
    spot: last?.c ?? 0,
    // ★ "算不出来"那一屏**同样**要说出数据有多旧 —— 用户问"为什么不给我预测"
    //   时，"因为数据是四天前的"本身就是最该被知道的答案之一。
    dataAgeMinutes: dataAgeMinutesOf(args.ev.candles, args.cfg.barMinutes, args.now),
    method: 'analog-conditional-distribution',
    outcome: args.outcome,
    gate: args.gate,
    // ★ 样本不足时**不给方向**，也不给 0 —— "算不出来"不是"持平"
    direction: null,
    target: null,
    medianBps: null,
    interval: null,
    path: [],
    netEdgeBps: null,
    oneWayCostBps: args.oneWay,
    roundTripCostBps: args.roundTrip,
    state: args.state,
    sample: args.sample ?? { candidates: args.ev.candles.length, matched: 0, separated: 0, trainBars: 0, testBars: 0 },
    calibration: null,
    reasons: args.reasons,
    disclosures: args.disclosures,
    dataHash: args.ev.dataHash,
    origin: args.ev.origin,
    // ★ `blank` 的两条路（数据太短 / 运行期样本不足）都是**刚算出来的**，
    //   不许写成 hit —— 那会让"复用旧结论"与"这一档本来就给不出数"混在一起。
    cache: { hit: false, computedAt: Date.now() },
    elapsedMs: args.elapsedMs,
  }
}

/**
 * 对外只有这一句人话 —— 桌宠与面板都念它，避免两处各写一份（判据 8）。
 * ★ 它**必须能把"没有优势"说出来**，而不是含糊成"震荡偏弱"。
 *
 * ★ 交付前统一剥一次 markdown 记号（`markupFree`）：本项目**没有任何
 *   markdown 渲染器** —— CLI 的 `console.log` 与面板的 React 文本节点都会
 *   把 `**` 原样显示出来。写作时的记号照写，出门前剥掉。
 */
export function forecastHeadline(r: ForecastResult): string {
  return markupFree(buildHeadline(r))
}

function buildHeadline(r: ForecastResult): string {
  const money = (x: number) => `$${x.toFixed(2)}`
  const hrs = ((r.horizonBars * r.barMinutes) / 60).toFixed(1)
  // ★★ 数据年龄放在**最前面**，因为它管着后面每一个数字的读法。
  //   2026-09-22 实测：BTC 的最后一根 K 线是四天半以前的，而这句话
  //   原先说的是「未来 4 小时（BTCUSDT @ 77429.01）」—— "@" 会被读成"现在"。
  //   这不是措辞问题：同一个 `spot` 在"数据是新的"和"数据停了 4 天"两种
  //   情况下**含义完全不同**，而两者在这句话里长得一模一样（判据 D5）。
  //   ★ 文案的唯一主人是 `describeDataAge()`，屏幕版与口播版都调它（红线⑯）。
  const age = describeDataAge(r.dataAgeMinutes, r.barMinutes)
  if (r.outcome === 'unverifiable') {
    return `${age}。未来 ${hrs} 小时**无法给出可靠预测**（${describeForecastGate(r.gate)}，gate=${r.gate}）：${r.reasons[0]?.text ?? ''}`
  }
  const dir = r.direction === 'up' ? '偏上' : r.direction === 'down' ? '偏下' : '方向不明'
  const base = `${age}。未来 ${hrs} 小时（${r.symbol} @ ${money(r.spot)}）：**${dir}**，中位目标 ${r.target === null ? 'n/a' : money(r.target)}`
  if (r.outcome === 'no-edge') {
    // ★★ 这两处（屏幕版与口播版）原先各写死过一句，是两个**独立**的缺陷：
    //
    //   ① 措辞重复（红线⑯：同一句话只能一个主人）。
    //      句子里写死「没有统计优势」，括号里又插进同一个 gate 名 ⇒
    //      `gate='edge'` 时输出「没有统计优势（没有统计优势）」。
    //      2026-09-22 实测复现：`npm run forecast:run -- BTCUSDT 4 15` 与 96 根档
    //      都打出这一句，读起来像结巴。
    //
    //   ② 事因说错（判据 D5：换个事因它会不会长得一模一样）。
    //      `no-edge` 有**三个**事因（见上面的 else-if 链）：`edge` / `coverage` / `cost`。
    //      而句尾那句「命中率与"猜基准方向"分不开」**只对 `edge` 成立**；
    //      对 `cost` 事因它是**假的** —— 那条路恰恰是 edge 检验**过了**、
    //      卡在幅度付不起成本上。三种事因指向的动作完全相反：
    //      换方法 / 收窄区间 / 降成本。
    //
    //   ⇒ 唯一的主人 = `r.reasons[0].text`：它本来就是按事因分别构造的，
    //     而 `unverifiable` 那一支早就在这么做（下面第 1192 行）。
    //     这也让屏幕版与口播版对同一个拒绝说同一个理由（判据 21）。
    const why = describeForecastGate(r.gate)
    const first = plainText(r.reasons[0]?.text ?? '')
    return `${base}；但**${why}**：${first}`
  }
  return `${base}，80% 区间 ${r.interval ? `${money(r.interval.lo)} ~ ${money(r.interval.hi)}` : 'n/a'}，净边际 ${r.netEdgeBps === null ? 'n/a' : r.netEdgeBps.toFixed(2)} bps（已扣往返成本 ${r.roundTripCostBps} bps）。`
}

/**
 * **口播版**（桌宠念出来的那一句）。
 *
 * ── 为什么不能直接念 `forecastHeadline` ──────────────────────────────
 * 那个是**屏幕**文案：里面有 `**` 记号（念出来是"星号星号"）、有 `@`、有长破折号
 * 与括号夹注。这个仓库的语音层有一条从自我介绍那天起的硬约束写在注释里
 * （见 `voice/service.ts` 的 `introduceSpeech`）：**念出来的字符串不许带 Markdown**。
 *
 * ── 两个出口为什么不算"同一动作两条路径" ──────────────────────────────
 * 它们说的**事实**全部取自同一个 `ForecastResult`，且拒绝词共用
 * `describeForecastGate()`。区别只在媒介：屏幕版给全精度数字，口播版把
 * 「$77429.01」念成「77429 美元」、把 `bps` 换成"万分之几"。所以这不是两条口径，
 * 是**同一句话的两种排版** —— 烟测有一条断言钉住两者不许出现内容分歧
 * （都说出方向、都说出拒绝原因、目标价位一致）。
 */
export function forecastSpeech(r: ForecastResult): string {
  const usd = (x: number) => `${Math.round(x)} 美元`
  const hrs = ((r.horizonBars * r.barMinutes) / 60).toFixed(1)
  const why = describeForecastGate(r.gate)
  // ★★ 口播的**第一句**必须是数据年龄。用户抱怨的正是"报价总是出错" ——
  //   而在此之前，桌宠会先说「现在 77429 美元」再说别的，那个"现在"是四天前。
  //   把它放在最前面（而不是夹在中间或塞进 disclosures），是因为它改变的是
  //   **后面每一句话的读法**，不是一条补充说明。
  const age = describeDataAge(r.dataAgeMinutes, r.barMinutes)
  if (r.outcome === 'unverifiable') {
    // ★ 措辞与屏幕版**逐字相同**的那一句是「无法给出可靠预测」（`**` 只属于屏幕）。
    //   两个出口各自造一个近义说法（"给不出可靠预测" / "现在判不了"）看着无伤，
    //   但那会让"用户听到的"和"面板上写的"变成两句话，核对不上（判据 21）。
    return (
      `${age}。未来 ${hrs} 小时的 ${r.symbol}，无法给出可靠预测。` +
      `卡在「${why}」这一步：${plainText(r.reasons[0]?.text ?? '')}`
    )
  }
  const dir = r.direction === 'up' ? '偏上' : r.direction === 'down' ? '偏下' : '方向不明'
  const bits: string[] = [age, `未来 ${hrs} 小时的 ${r.symbol}，我的判断是${dir}`]
  // ★ 这里原来念的是「现在 ⋯ 美元」—— 那个数是**最后一根 K 线的收盘价**，
  //   在数据陈旧时它根本不是"现在"。改说"起点"，并把时间交给上面那句年龄。
  if (r.target !== null) bits.push(`预计到达的价位是中位数 ${usd(r.target)}，起点是 ${usd(r.spot)}`)
  if (r.interval) bits.push(`八成的可能落在 ${usd(r.interval.lo)} 到 ${usd(r.interval.hi)} 之间`)
  if (r.outcome === 'no-edge') {
    // ★ 与屏幕版同源：理由取自 `r.reasons[0].text`，不写死。
    //   原来这里写死「命中率和『永远猜基准方向』那条平凡规则分不开」，
    //   对 `cost` / `coverage` 两个事因是**假话**（那两条路上 edge 检验是过的）。
    //   详见屏幕版上面的注释。
    bits.push(`但是${why}：${plainText(r.reasons[0]?.text ?? '')}`)
  } else {
    bits.push(`净边际 ${r.netEdgeBps === null ? '未知' : r.netEdgeBps.toFixed(1)} 个基点，已经扣掉往返成本 ${r.roundTripCostBps} 个基点`)
  }
  const st = r.state.map((s) => `${s.nameCn}`).join('、')
  if (st) bits.push(`依据是当前状态在历史上最相似的两百个时刻的未来走势，状态量是${st}`)
  if (r.calibration) {
    const c = r.calibration
    bits.push(
      `样本外校准用了 ${c.anchors} 个锚点，命中率 ${(c.hitRate * 100).toFixed(0)}%，` +
        `基准线 ${(c.baseRate * 100).toFixed(0)}%`,
    )
  }
  return bits.join('。') + '。'
}

/**
 * 把屏幕文案变成能念的句子。
 *
 * ★ 判据只留一份：`**`/`⚠️`/`⇒`/`｜` 这些记号在**整个语音层**都是不许出现的，
 *   所以剥记号这件事必须是一个具名函数，而不是各处 `replace` 一下 ——
 *   各处 replace 的后果是"有的地方剥了、有的地方没剥"，
 *   而没剥的那处会在 TTS 里念出"星号"，用户以为系统坏了。
 */
/**
 * 剥掉**只有 markdown 渲染器才认**的记号，其余原样保留。
 *
 * ── 为什么这件事必须做在**源头**，而不是在各个消费方各剥一次 ──────────
 * 同一段文案（`reasons[].text` / `disclosures[]`）有两个消费者：
 * **屏幕**（React 文本节点）与**口播**（TTS）。两个都不渲染 markdown，
 * 于是 `**` 会**字面出现** —— 屏幕上是"星号星号攒数据"，喇叭里念"星号星号"。
 * 同一个缺陷会在两处冒出来，而且在两处看起来是两件不同的事。
 * 在消费方各剥一次 = 同一件事两条路径（判据 8），迟早只改一处。
 *
 * ★ 与 `plainText` 的分工：`plainText` 是给**口播**用的 —— 它连 `⇒`
 *   都要换成"，也就是"，因为喇叭不会念符号。这里只剥 markdown 记号，
 *   `⇒`、`｜` 在屏幕上是能看的，留着（去掉反而丢了信息）。
 *   写作时该用的记号照旧照写，**交付前**统一剥一次。
 */
function markupFree(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '')
}

/**
 * 把书面文案改写成**能念出来**的一句话。
 *
 * ★ 分工（2026-09-21 划清）：剥 markdown 记号的**主防线**是 `forecast()` 出口的
 *   `finalize()` —— 所有结果都必须过那道门，屏幕与口播拿到的是同一份干净字符串。
 *   这里保留 `**`/反引号的替换是**第二道**（`plainText` 是导出函数，
 *   语义是"把任意文案变成能念的话"，别处也可能拿它处理未过 `finalize` 的串）。
 *
 * ★ 代价要说清楚：第二道**打不中任何东西**了 —— 喂进来的串在出口就没记号了，
 *   所以针对它的变异会"0 条红"。那不是"检查没牙"，是**变异没打中还在起作用的东西**，
 *   两者在报文里长得一模一样。变异脚本 M18 因此改打了 `disclosures` 那半边。
 *   ⇒ 别把这一道当成唯一防线（判据 3：一条断言得有"只有它才会命中"的输入）。
 */
export function plainText(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/⚠️\s*/g, '')
    .replace(/⇒/g, '，也就是')
    .replace(/｜/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把一次预测变成一份**下单提案**（方向 + 入场 + 价位提示）。
 *
 * ── 三个刻意的边界 ────────────────────────────────────────────────────
 * ① 它**不下单、不碰账户**。产出的是一份"如果要做，该怎么做"的提案，
 *    必须再过既有的 `precheckTrade`（交易闸门 9+3 道）才可能出去。
 *    判据 8：同一个业务动作（下一笔单）只许有一条实现路径。
 * ② 它**不算止损价**。几何归既有的几何引擎（`computeStopGeometry` /
 *    `deriveStructureTarget`，见 `tradeGate.suggestPrices`）。
 *    在这里再写一遍 `spot * 0.97` 就是把"两份口径"搬进服务端 ——
 *    而搬进来之后更难被发现。所以它只交出预测层**独有**的东西：
 *    方向，以及未来价位的**分布**（80% 区间的上下沿）。
 * ③ `no-edge` / `unverifiable` 时**明确 `ok: false`**，并说出卡在哪一步。
 *    返回一份"随便做做"的提案，比返回 null 危险得多。
 *
 * ── 它现在在真实数据上返回 `ok:false` ─────────────────────────────────
 * 实测 BTCUSDT 未来 1 小时：edgeZ=0.60 < 门槛 2 ⇒ `no-edge`。**这不是没接线**，
 * 这是它唯一诚实的输出。真出现优势时它会返回提案 —— 两条路都有断言钉着
 * （`forecast-smoke` 用可注入的门槛把两支都跑过，见 F7/F8）。
 */
export interface ForecastOrderProposal {
  ok: boolean
  side: 'buy' | 'sell' | null
  entry: number | null
  /** 中位目标。 */
  target: number | null
  /** 80% 区间的上下沿 —— 交给既有几何引擎去决定止损放哪。 */
  lo: number | null
  hi: number | null
  /** 不成立的原因，**必须可念**（不能是 JSON 片段或 gate 代号）。 */
  reason: string
}

export function proposeForecastOrder(r: ForecastResult): ForecastOrderProposal {
  const none = (reason: string): ForecastOrderProposal => ({
    ok: false,
    side: null,
    entry: null,
    target: null,
    lo: null,
    hi: null,
    reason,
  })
  if (r.outcome !== 'actionable') {
    return none(
      `预测层不建议据此下单：${describeForecastGate(r.gate)}。${plainText(r.reasons[0]?.text ?? '')}`,
    )
  }
  if (r.direction === null || r.target === null || r.interval === null) {
    // ★ 判决说"有优势"，但方向/目标/区间有缺项 —— 两件事互相矛盾。
    //   这是异常，不是"数据少一点"，所以不放行（`null` 不许被当成"差不多"）。
    return none('判决为有优势，但方向、目标或区间缺项 —— 这两处结论互相矛盾，属于异常，不放行。')
  }
  return {
    ok: true,
    side: r.direction === 'up' ? 'buy' : 'sell',
    entry: r.spot,
    target: r.target,
    lo: r.interval.lo,
    hi: r.interval.hi,
    reason:
      `预测判为有统计优势：${r.direction === 'up' ? '偏上' : '偏下'}，中位目标 ${r.target.toFixed(2)}，` +
      `80% 区间 ${r.interval.lo.toFixed(2)} ~ ${r.interval.hi.toFixed(2)}，` +
      `净边际 ${r.netEdgeBps === null ? 'n/a' : r.netEdgeBps.toFixed(1)} bps（已扣往返成本 ${r.roundTripCostBps} bps）。`,
  }
}

/** 只读一次磁盘的窄接口，给端点与烟测共用（避免两处各读一份配置）。 */
export function readForecastConfigFile(path: string): Partial<ForecastConfig> | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ForecastConfig>
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}
