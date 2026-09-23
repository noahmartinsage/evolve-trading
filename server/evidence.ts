/**
 * 证据基座 —— 过拟合判定到底拿哪批行情去算。
 *
 * ══ 为什么这是一件必须显式回答的事 ═══════════════════════════════════
 * 2026-09-14 在真实数据上实测后发现：**证据基座决定了门禁有没有意义**。
 *
 *   | 数据集                        | PBO    | 赢家分位 | 选择净收益 | 裁定   |
 *   |-------------------------------|--------|----------|------------|--------|
 *   | BTC 真实 30 天（binance-rest）| 40.1%  | 0.670    | +24.6      | 边缘   |
 *   | ETH 真实 30 天（binance-rest）| 59.1%  | 0.566    | +8.4       | 拒绝   |
 *   | 合成 GBM（原流水线默认）      | 9.1%   | 0.417    | −33.0      | 拒绝   |
 *
 * 两个结论：
 *   ① **合成 GBM 在原理上无法支撑"有优势"的结论** —— 随机行走里不存在
 *      可被策略捕捉的结构。所以"在合成数据上过了回测"从来不能作为
 *      进实盘的依据，与过拟合门禁是否严格无关。这也是为什么本模块
 *      **优先加载真实历史数据集**，只在没有时才回落到合成数据，
 *      并且把来源写进 `origin` 让下游能分辨。
 *   ② 连真实的 30 天数据也只是"边缘"：`maxPbo` 默认 0.25 之下 BTC
 *      同样过不了门。这不是门禁过严，是**证据不足**的诚实结论 ——
 *      20 个候选里挑一个，30 天数据本来就撑不住。
 *      要让门禁真能放行，需要的是更长的历史（月→年级别），不是放宽阈值。
 *
 * ══ 为什么必须缓存 ═══════════════════════════════════════════════════
 * 一次 20 候选 × 8 折的完整 walk-forward 约 20 秒（2,880 根时代）。
 * 2026-09-18 实测 35,040 根 / 142 折只用 **5.45 秒** —— 修掉回测里的 O(n²) 之后，
 * 耗时几乎与 bar 数无关（每折只吃折内切片），大头是 returnMatrix 那 20 次全长回测。
 * 门禁是同步接口，不缓存就意味着每次点"跑 backtest 门"都要等 20 秒。
 * 缓存键里带上数据指纹与配置，所以「换了行情」或「换了折宽」
 * 会自然失效并重算 —— 不会出现"拿旧数据的结论给新数据背书"。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_GRID_EXEC,
  buildCandidateSet,
  combinationPurity,
  contentHash,
  genSynthCandles,
  walkForward,
  wfWidthFor,
} from '../src/engine/index.ts'
import type { Candle, HistoryFile, OverfitReceipt, OverfitVerdict, PurityResult, WFResult } from '../src/engine/index.ts'
import { DEFAULT_OVERFIT_THRESHOLDS, judgeOverfit } from '../src/engine/overfit.ts'

export interface EvidenceSet {
  /** 数据来源。下游据此判断"这份结论是在真行情还是合成行情上得出的"。 */
  origin: 'history' | 'synthetic'
  symbol: string
  candles: Candle[]
  dataHash: string
  bars: number
  gaps: number
  /**
   * 本次实际尝试读取的绝对路径。
   *
   * 为什么必须放进可观测量：`loadEvidence` 用 `process.cwd()` 拼路径，
   * 所以**从哪个目录启动**会决定它读到真行情还是回落到合成数据。
   * 2026-09-18 实测过一次：一个取证脚本的 cwd 被设成了 `evolve-app/scripts`，
   * 于是 BTC 与 ETH 两个标的都回落到**同一批 GBM**，PBO 还是给出了
   * 一个看着完全正常的 26.2%。当时是靠"合成数据一律 exit 1"的断言才拦下。
   * 只报 origin 不够 —— 还得能回答"它找的是哪儿"，否则排查只能靠猜。
   */
  triedPath: string
}

/**
 * walk-forward 的时间切分。
 *
 * ★ 默认值由 `wfWidthFor(bars)` 按数据长度反推 —— **不写死 bar 数**。
 *   理由见 `wfWidthFor` 的说明：`minAvgWinnerW` 这条判据是在 8 折上标定的，
 *   折宽必须跟着数据长度走，否则判据的适用条件会被悄悄破坏。
 */
export interface EvidenceWfConfig {
  trainBars: number
  testBars: number
  barMinutes: number
}

/**
 * 载入证据数据。
 *
 * 优先真实历史数据集（`data/history/<SYMBOL>_15m.json`），
 * 没有时才回落合成 GBM —— 且**把 origin 标出来**。
 * 静默回落是最坏的做法：下游会把"合成数据上的结论"当成"真实证据"。
 */
export function loadEvidence(symbol = 'BTCUSDT', barMinutes = 15): EvidenceSet {
  const file = join(process.cwd(), 'data', 'history', `${symbol}_${barMinutes}m.json`)
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as HistoryFile
    if (Array.isArray(raw.candles) && raw.candles.length > 0) {
      return {
        origin: 'history',
        symbol,
        candles: raw.candles,
        dataHash: raw.meta?.contentHash ?? contentHash(raw.candles),
        bars: raw.candles.length,
        gaps: (raw.meta?.gaps ?? []).reduce((s, g) => s + g.missingBars, 0),
        triedPath: file,
      }
    }
  }
  // 降级不静默（红线）：回落到合成数据必须**主动说出来**，并带上它找过的路径。
  // 少了这句，一个 cwd 写错的脚本会得到一份"看着完全正常"的合成数据结论，
  // 而唯一的线索是调用方自己去读 origin 字段 —— 它经常不读。
  warnFallbackOnce(file)
  const candles = genSynthCandles({ seed: 20260823, bars: 2400, startPrice: 3500, volDaily: 0.04, driftDaily: 0.0003, barMinutes })
  return {
    origin: 'synthetic',
    symbol: `${symbol}-SYNTH`,
    candles,
    dataHash: contentHash(candles),
    bars: candles.length,
    gaps: 0,
    triedPath: file,
  }
}

/** 同一个路径只吵一次，避免在高频路径上刷屏（刷屏的告警等于没有告警）。 */
const warned = new Set<string>()
function warnFallbackOnce(path: string): void {
  if (warned.has(path)) return
  warned.add(path)
  console.warn(
    `⚠️ 未找到真实历史 ${path} —— 已回落到**合成 GBM**。` +
      `在这批数据上得出的任何"优势/通过"结论都不能作为依据；` +
      `若数据确实存在，多半是进程 cwd 不对（loadEvidence 用 process.cwd() 拼路径）。`,
  )
}

export interface EvidenceResult {
  receipt: OverfitReceipt
  verdict: OverfitVerdict
  result: WFResult
  /**
   * 候选同质化。**也由服务端算**，理由与凭据相同：
   * 它原先同样是请求体透传的（`Boolean(body.purityHomogeneous)`），
   * 前端把三个自报字段一起硬编码成"能过"的值，等于三道门一起失效。
   */
  purity: PurityResult
  evidence: { origin: string; symbol: string; bars: number; gaps: number }
  /** 计算耗时（毫秒）。缓存命中时为 0 —— 用于分辨"这次是真算的还是取回来的"。 */
  elapsedMs: number
}

const cache = new Map<string, EvidenceResult>()

function cacheKey(ev: EvidenceSet, wf: EvidenceWfConfig, slices: number): string {
  // 指纹 + 折宽 + 切片数 + 候选集规模：任何一项变了都必须重算。
  // 少了折宽会导致"换了时间切分却复用旧结论"——那正是把结论与其
  // 适用条件脱钩，是比慢 20 秒严重得多的问题。
  return [ev.dataHash, ev.bars, wf.trainBars, wf.testBars, wf.barMinutes, slices, buildCandidateSet().length].join('|')
}

/**
 * 计算过拟合凭据。带缓存。
 *
 * @param refresh 强制重算（用于"我想亲眼看着它跑一遍"的场景）。
 */
export function computeEvidenceReceipt(
  symbol = 'BTCUSDT',
  barMinutes = 15,
  wf: EvidenceWfConfig | null = null,
  slices = 10,
  refresh = false,
): EvidenceResult {
  const ev = loadEvidence(symbol, barMinutes)
  // 折宽按数据长度反推；调用方显式传 wf 时以调用方为准（烟测要固定折宽）。
  const effWf: EvidenceWfConfig = wf ?? { ...wfWidthFor(ev.candles.length), barMinutes }
  const key = cacheKey(ev, effWf, slices)
  if (!refresh) {
    const hit = cache.get(key)
    if (hit) return { ...hit, elapsedMs: 0 }
  }

  const t0 = Date.now()
  const wfFull = { trainBars: effWf.trainBars, testBars: effWf.testBars, barMinutes: effWf.barMinutes, exec: DEFAULT_GRID_EXEC }
  const result = walkForward(ev.candles, buildCandidateSet(), wfFull, { dataHash: ev.dataHash, slices })
  const verdict = judgeOverfit(result.receipt, DEFAULT_OVERFIT_THRESHOLDS)
  const purity = combinationPurity(ev.candles, buildCandidateSet(), effWf.trainBars, wfFull)
  const out: EvidenceResult = {
    receipt: result.receipt,
    verdict,
    result,
    purity,
    evidence: { origin: ev.origin, symbol: ev.symbol, bars: ev.bars, gaps: ev.gaps },
    elapsedMs: Date.now() - t0,
  }
  cache.set(key, out)
  return out
}

/** 缓存状态，供面板与排查使用。 */
export function evidenceCacheInfo(): { entries: number; keys: string[] } {
  return { entries: cache.size, keys: [...cache.keys()] }
}

/**
 * 预热。启动时后台跑一次，避免第一次点"跑 backtest 门"等 20 秒。
 *
 * 故意**不 await** 且吞掉异常：预热失败不影响服务可用性
 * （真正的请求会自己算一遍并暴露错误），而让启动因为
 * "一个可选的优化"失败是得不偿失的。
 */
export function warmEvidence(symbol = 'BTCUSDT'): void {
  setTimeout(() => {
    try {
      const r = computeEvidenceReceipt(symbol)
      console.log(
        `✅ 过拟合证据已预热 · ${r.evidence.origin}/${r.evidence.symbol} · ${r.evidence.bars} 根 · ` +
          `${r.result.aggregate.folds} 折 · PBO=${r.receipt.pbo === null ? 'n/a' : (r.receipt.pbo * 100).toFixed(1) + '%'} · ` +
          `${r.verdict.outcome} · ${r.elapsedMs}ms`,
      )
    } catch (e) {
      console.warn(`⚠️ 过拟合证据预热失败（不影响启动）: ${e instanceof Error ? e.message : e}`)
    }
  }, 0)
}
