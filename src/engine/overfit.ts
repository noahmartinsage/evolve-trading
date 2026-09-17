/**
 * 过拟合度量 —— 回答「这个冠军是真本事，还是从 20 个候选里挑出来的运气」。
 *
 * ══ 为什么原有的 walk-forward 判据不成立 ═══════════════════════════════
 * 原判据是 `positiveOosShare >= 0.5`，即「过半的折里赢家 OOS 为正」。
 * 它有一个致命的缺口：**没有零假设对照**。
 *
 *   - 普涨行情里**所有**候选的 OOS 都是正的。此时「赢家 OOS 为正」
 *     是场行情的事实，不是选择能力的证据 —— 判据恒真。
 *   - 更根本的是**多重性**：从 N 个候选里取样本内最大值，这个最大值
 *     本身就被选择效应抬高了。哪怕 N 个候选全是纯噪声，
 *     「最大值」也会显著大于零。而原实现只把赢家一个人拿到样本外去评，
 *     从不问「它在样本外排在候选场的什么位置」。
 *
 * 一句话：**原判据测的是「市场涨没涨」，不是「选择对不对」。**
 *
 * ══ 本模块给出的三个量 ═══════════════════════════════════════════════
 *   ① PBO（回测过拟合概率）—— CSCV 组合对称交叉验证。
 *      把时间切成 S 块，枚举所有「取一半做样本内」的组合，
 *      每次在样本内选出**风险调整后**最优者、看它在样本外落到候选中位数的哪一边。
 *      落下去的频率就是 PBO。**它是专门为「N 个候选里挑一个」这件事设计的。**
 *   ② 赢家分位 w —— 样本内最优者，在样本外候选场里的归一化名次。
 *      w > 0.5 才说明「选择在样本外仍然成立」。
 *   ③ 选择净收益 —— 赢家 OOS 减去候选场 OOS 均值。
 *      这是把多重性**直接扣掉**之后的收益：全场平均是零假设下
 *      「随便挑一个」的期望，两者之差才是选择贡献。
 *
 * ══ 两个统计量为什么口径不同（这不是不一致，是两个问题）═══════════════
 *   · PBO 用**风险调整后**的切分统计量 —— 它必须在任意时间块子集上可算，
 *     且不能被"仓位暴露大"这种与预测能力无关的因素污染（见 splitStat）。
 *   · 赢家分位用**引擎自己的适应度** —— 它要回答的是
 *     「引擎真正在优化的那个目标，在样本外兑现了吗」。
 *   适应度含回撤与换手惩罚，是路径量，**无法在任意时间块子集上分解**，
 *   所以两者不可能用同一个统计量。此处刻意保留差异，并把差异写在这里。
 *
 * ══ 一条不能违反的语义（与 claimValidator 同源）═══════════════════════
 * **凭据不完整时判 `UNVERIFIABLE`，绝不判 `PASS`。**
 * 缺折数、缺候选数、版本不符、数值非有限 —— 这些都不是「没问题」，
 * 而是「无从判断」。把它们折进通过，就等于「不回传证据的策略比
 * 老实回传的更安全」，这是一条反向激励，比缺一道门更危险。
 *
 * ══ 凭据里为什么不放 `pass` 布尔 ═════════════════════════════════════
 * 因为那还是自报，只是换了个信封。
 * 凭据只装**原始可观测量**（PBO、分位、折数、候选数、数据指纹），
 * **阈值住在消费方的配置里，由消费方自己判**。这样即使凭据被构造，
 * 也无法把「不达标」说成「达标」—— 一个更大的 PBO 就是更大的 PBO。
 */

export const OVERFIT_VERSION = 'overfit-v1'

/** CSCV 切片数的上限。2^14 = 16384 个组合，再往上枚举成本会超过收益。 */
const MAX_SLICES = 14

export interface PboResult {
  /** 实际使用的切片数（偶数）。 */
  slices: number
  /** 枚举的组合数 = C(slices, slices/2)。 */
  combinations: number
  /** 回测过拟合概率 ∈ [0,1]。**越大越过拟合**。 */
  pbo: number
  /** 各组合 logit 的中位数。负数表示「典型情况下优势未兑现」。 */
  medianLogit: number
  /** 每个切片实际纳入的行数。 */
  blockRows: number
}

/** 升序名次结果。名次口径在此定义一次，全模块共用，避免两套口径漂移。 */
export interface RankResult {
  /** 参与比较的样本数。 */
  n: number
  /** 升序名次，1 = 最差，n = 最好。 */
  ascRank: number
  /** 归一化分位 w = ascRank/(n+1) ∈ (0,1)。w > 0.5 表示优于中位数。 */
  w: number
}

function finiteRows(perf: readonly (readonly number[])[]): number[][] | null {
  if (!Array.isArray(perf) || perf.length < 4) return null
  const n = perf[0]?.length ?? 0
  if (n < 2) return null
  const out: number[][] = []
  for (const row of perf) {
    if (!Array.isArray(row) || row.length !== n) return null
    const copy: number[] = []
    for (const v of row) {
      if (!Number.isFinite(v)) return null
      copy.push(v)
    }
    out.push(copy)
  }
  return out
}

/**
 * 升序名次（并列取平均）。`idx` 指向被排名的那一个。
 *
 * 为什么并列要取平均而不是 `<=` 计数：候选之间出现完全相同的表现是常态
 * （例如两个阈值下都没触发过交易，收益曲线完全相同）。用 `<=` 计数会让
 * 并列者全部拿到「最好名次」，于是**跑得一样好的一批候选会互相抬高对方**，
 * 在最需要保守的地方系统性地偏乐观。
 */
function ascRankOf(values: readonly number[], idx: number): number {
  const x = values[idx]
  let below = 0
  let equal = 0
  for (const v of values) {
    if (v < x) below += 1
    else if (v === x) equal += 1
  }
  return below + (equal + 1) / 2
}

/** 单个值在整场里的归一化分位。样本不足 2 个时返回 null。 */
export function rankOf(field: readonly number[], idx: number): RankResult | null {
  if (!Array.isArray(field) || field.length < 2) return null
  if (idx < 0 || idx >= field.length) return null
  if (!field.every((v) => Number.isFinite(v))) return null
  const n = field.length
  const ascRank = ascRankOf(field, idx)
  return { n, ascRank, w: ascRank / (n + 1) }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 切分内的表现统计量：**风险调整后**的均值（Sharpe 形态）。
 *
 * ══ 为什么不能用「平均收益」直接选优 ═════════════════════════════════
 * 这是本模块第一版真栽过的坑，记在这里以免被"简化"回去：
 *
 * 用平均收益做 CSCV 时，样本内最优者几乎总是**仓位暴露最大**的那个候选
 * —— 它每根 K 线都拿着更大的头寸，所以平均收益天然更高。
 * 而"暴露大"这件事在样本内外是**强持续**的：它不需要任何预测能力，
 * 只要仓位一直重就够了。于是纯 GBM 随机行走上也能算出 PBO≈9%，
 * 看着像"这个候选集很稳健"。
 *
 * 实测对照（同一份合成 GBM，20 个候选）：
 *   用平均收益选优 → PBO 9.1%，看着"没问题"；
 *   换成风险调整后统计量 → PBO 回到中位数附近，才是噪声该有的样子。
 *
 * 所以必须先把每个切分的收益按自身的波动归一化，
 * 让"重仓"与"准"不再被混为一谈。这也是 Bailey 等人的原始定义。
 */
function splitStat(sum: number, sumSq: number, n: number): number {
  if (n < 2) return Number.NaN
  const mean = sum / n
  const variance = (sumSq - (sum * sum) / n) / (n - 1)
  if (!(variance > 0)) return 0 // 零波动：无风险差异可言，一律记 0，不制造无穷大
  return mean / Math.sqrt(variance)
}

/**
 * PBO —— 回测过拟合概率（CSCV 实现）。
 *
 * 算法（Bailey / Borwein / López de Prado / Zhu）：
 *   1. 把 T 行表现按时间等分为 S 个连续块（S 取偶数）。
 *   2. 枚举所有「从 S 块中取 S/2 块」的组合，作为样本内；其余为样本外。
 *   3. 每个组合：样本内逐列算**风险调整后**统计量 → 取最大者 n* 为「赢家」；
 *      样本外同样逐列算 → 看 n* 落在什么分位 w = rank/(N+1)。
 *   4. 若 w ≤ 0.5（未超过中位数），记一次「优势未兑现」。
 *   5. PBO = 未兑现次数 / 组合数。
 *
 * ⚠️ 第 3 步用的是风险调整后统计量而不是平均收益 —— 这不是细节，
 * 而是本模块唯一的正确性前提，理由见 `splitStat` 的注释。
 *
 * 为什么用 CSCV 而不是「多跑几次 walk-forward」：
 *   walk-forward 的折数通常只有个位数，而每折的样本内外切分是**固定**的，
 *   换来的「过拟合概率」只有 5~6 个观测，噪声比信号大。
 *   CSCV 用同一批数据枚举出 C(S, S/2) 个切分（S=10 时 252 个），
 *   把「切分方式的不确定性」也纳入了统计，这才是 PBO 能被当作阈值用的原因。
 *
 * @param perf 行=时间、列=候选的表现矩阵（此处传逐根 K 线收益率）。
 * @returns 数据不足以切分时返回 null —— **不返回一个假装中性的 0**。
 */
export function pboCscv(perf: readonly (readonly number[])[], slices = 10): PboResult | null {
  const rows = finiteRows(perf)
  if (!rows) return null

  const T = rows.length
  const N = rows[0].length

  // S 必须是偶数、≥4，且每块至少 2 行（1 行的「块」没有统计意义）。
  let S = Math.min(slices % 2 === 0 ? slices : slices - 1, MAX_SLICES)
  if (S % 2 !== 0) S -= 1
  while (S >= 4 && Math.floor(T / S) < 2) S -= 2
  if (S < 4) return null

  const blockRows = Math.floor(T / S)

  // 逐块逐列求和与平方和。组合求和时只需把这些块相加，
  // 避免在 C(S,S/2) 次循环里重复扫描原始行（那是 O(2^S · T · N)）。
  // 平方和是必需的：风险调整后的统计量要先还原方差，
  // 只有均值是不够的（见 splitStat 的说明）。
  const blockSum: number[][] = []
  const blockSq: number[][] = []
  for (let b = 0; b < S; b++) {
    const sums = new Array<number>(N).fill(0)
    const sqs = new Array<number>(N).fill(0)
    const from = b * blockRows
    const to = from + blockRows
    for (let r = from; r < to; r++) {
      const row = rows[r]
      for (let c = 0; c < N; c++) {
        const v = row[c]
        sums[c] += v
        sqs[c] += v * v
      }
    }
    blockSum.push(sums)
    blockSq.push(sqs)
  }

  const total = new Array<number>(N).fill(0)
  const totalSq = new Array<number>(N).fill(0)
  for (let c = 0; c < N; c++) {
    let s = 0
    let q = 0
    for (let b = 0; b < S; b++) {
      s += blockSum[b][c]
      q += blockSq[b][c]
    }
    total[c] = s
    totalSq[c] = q
  }

  const half = S / 2
  const isRows = half * blockRows
  const oosRows = isRows
  const logits: number[] = []
  let degraded = 0
  let combinations = 0

  const isSum = new Array<number>(N).fill(0)
  const isSq = new Array<number>(N).fill(0)
  for (let mask = 0; mask < 1 << S; mask++) {
    let bits = 0
    for (let b = 0; b < S; b++) if (mask & (1 << b)) bits += 1
    if (bits !== half) continue
    combinations += 1

    for (let c = 0; c < N; c++) {
      isSum[c] = 0
      isSq[c] = 0
    }
    for (let b = 0; b < S; b++) {
      if (!(mask & (1 << b))) continue
      const bs = blockSum[b]
      const bq = blockSq[b]
      for (let c = 0; c < N; c++) {
        isSum[c] += bs[c]
        isSq[c] += bq[c]
      }
    }

    // 样本内按风险调整后统计量选优，而不是按平均收益（见 splitStat）。
    let star = 0
    let bestIs = Number.NEGATIVE_INFINITY
    for (let c = 0; c < N; c++) {
      const stat = splitStat(isSum[c], isSq[c], isRows)
      if (stat > bestIs) {
        bestIs = stat
        star = c
      }
    }

    const oosStat = new Array<number>(N)
    for (let c = 0; c < N; c++) {
      oosStat[c] = splitStat(total[c] - isSum[c], totalSq[c] - isSq[c], oosRows)
    }

    const w = ascRankOf(oosStat, star) / (N + 1)
    const logit = Math.log(w / (1 - w))
    logits.push(logit)
    // 分位不超过中位数即算「优势未兑现」。取 `<=` 而不是 `<`：
    // 并列到中位数的一批候选，本来就分不出谁更有本事，
    // 在风控闸门上应当按更保守的一侧计数。
    if (logit <= 0) degraded += 1
  }

  if (combinations === 0) return null

  return {
    slices: S,
    combinations,
    pbo: Math.round((degraded / combinations) * 1e6) / 1e6,
    medianLogit: Math.round(median(logits) * 1e6) / 1e6,
    blockRows,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 汇总与裁定
// ─────────────────────────────────────────────────────────────────────

export interface OverfitSummary {
  folds: number
  candidates: number
  /** 逐折赢家在候选场中的分位 w，w>0.5 为优于中位数。 */
  perFoldWinnerW: number[]
  /** 上述分位的均值。样本不足时 null。 */
  avgWinnerW: number | null
  /** 逐折「赢家 OOS − 候选场 OOS 均值」。 */
  perFoldSelectionEdge: number[]
  /** 上述净收益的均值。这是扣掉多重性之后的选择贡献。 */
  avgSelectionEdge: number | null
  pbo: number | null
  pboSlices: number
  pboCombinations: number
}

/**
 * 阈值。**住在消费方配置里**，不写进凭据。
 *
 * ══ 默认值从零假设分布**量出来**，不是拍出来的 ═══════════════════════
 * `scripts/overfit-smoke.ts` 会实测 PBO 在「纯噪声候选场」上的分布，
 * 本文件的默认值必须与那次实测一致。实测结果（40 个独立种子）：
 *
 *   | 切片 | 组合数 | 均值 | 标准差 | P(PBO < 0.5) |
 *   |------|--------|------|--------|--------------|
 *   |  6   |   20   | 0.492| 0.231  |    43%       |
 *   | 10   |  252   | 0.487| 0.215  |    53%       |
 *   | 12   |  924   | 0.494| 0.197  |    50%       |
 *   | 14   | 3432   | 0.488| 0.202  |    53%       |
 *
 * 两条必须记住的结论：
 *   ① 统计量本身**无偏**（均值≈0.5）—— 这说明实现是对的。
 *   ② **增加组合数并不降低离散度**：252 → 3432 组合，标准差几乎不动
 *      （0.215 → 0.202）。原因是 CSCV 的各组合高度相关（共享时间块），
 *      有效样本量由**块数**决定，不由 C(S,S/2) 决定。
 *
 * （上表用 seeds 1..40 测得。换一组种子均值会在 0.49~0.58 间摆动 ——
 *   40 个种子的标准误约 0.03，属正常抽样波动，不是实现不稳定。）
 *
 * ⚠️ 由此得到的一条硬结论：**`maxPbo = 0.5` 在纯噪声上就是一次抛硬币**
 * （53% 会通过）。所以 0.5 不能当默认阈值用 —— 它比"没有门"好不了多少。
 * 默认值取到零假设均值下方约 1.2σ 处，把单条判据的误放行压到 ~10%：
 *   0.25 = 0.49 − 1.2×0.20
 * 赢家分位同理：均匀名次下 8 折均值 ≈0.5、σ≈0.10，
 *   0.60 = 0.50 + 1.0×0.10  → 单条误放行 ~16%
 * 两条**合取**后，纯噪声的误放行率约 2~5%（两者正相关，故不是简单相乘）。
 *
 * ══ 边界语义：本组阈值**取等即拒**（与其他闸门的约定刻意不同）══════════
 * 项目里 `minFitness` / `testnetMaxDrawdownPct` 等沿用「严格越界才拒」，
 * 因为那些阈值是**任意调参值**（30 分、10% 回撤），恰好在 30.00 上
 * 偏乐观还是偏保守没有道理可讲，不如与其他闸门保持一致。
 *
 * 本组不同：这里的临界点是**校准出来的判据线**，
 * 在「与噪声无法区分」这一点上，没有任何理由偏向乐观一侧。
 * 所以取闭合边界：`pbo >= maxPbo` 即拒、`w <= minAvgWinnerW` 即拒。
 *
 * ⚠️ 下一处改动的读者注意：这不是笔误，也不是需要"统一"的不一致。
 */
export interface OverfitThresholds {
  /** PBO 上限。**达到即视为过拟合**（闭合边界，见上）。 */
  maxPbo: number
  /** 赢家分位均值下限。**不高于此值即视为选择未兑现**（闭合边界，见上）。 */
  minAvgWinnerW: number
  /** 最少折数。低于此值不裁定（样本不足）。 */
  minFolds: number
  /** 最少候选数。候选太少时 PBO 无意义（没有「挑」这件事）。 */
  minCandidates: number
  /**
   * PBO 至少要有多少个 CSCV 组合才算数。
   *
   * 为什么这条必须显式存在：组合数决定了 PBO 的**分辨率**。
   * 6 个组合时 PBO 只能取 0、1/6、…、1 这 7 个值 —— 它不是统计量，
   * 是抛硬币，而且**完全可能碰巧落在低档从而通过**。
   * 默认 70 = C(8,4)，即至少 8 个切片。
   * 这与本项目反复栽过的那类缺陷同源：**样本不足被静默当成证据**。
   *
   * 注意它管的是「够不够格当证据」，**不管精度** ——
   * 精度由块数决定，而块数再多也压不下标准差（见上表）。
   */
  minPboCombinations: number
}

export const DEFAULT_OVERFIT_THRESHOLDS: OverfitThresholds = {
  // 0.25 而非 0.5：0.5 在纯噪声上 53% 会通过，等于没有门。见上方实测表。
  maxPbo: 0.25,
  minAvgWinnerW: 0.6,
  // 4 折起才裁定。原先的 3 折门槛偏松：rolling 窗口下相邻折的训练集
  // 重叠度很高，折与折之间**不独立**，3 折实际只有一个半独立观测。
  minFolds: 4,
  minCandidates: 8,
  minPboCombinations: 70,
}

/**
 * 过拟合凭据 —— **只装原始可观测量**。
 *
 * 刻意不包含 `pass: boolean`：判定属于消费方。
 * 凭据一旦自带结论，闸门就退化成「采信信封上的字」，与改造前的
 * 自报布尔量没有本质区别。
 */
export interface OverfitReceipt {
  version: string
  /** 数据指纹。把「这份凭据是针对哪批行情算的」钉死，防止凭据被挪用到别的数据集上。 */
  dataHash: string
  /** 参与计算的 K 线根数，供复核者确认量级一致。 */
  bars: number
  candidates: number
  folds: number
  pbo: number | null
  pboSlices: number
  pboCombinations: number
  avgWinnerW: number | null
  avgSelectionEdge: number | null
  /** 逐折分位。留着是为了让复核者能独立重算均值，而不是相信一个标量。 */
  perFoldWinnerW: number[]
  /** 逐折样本内适应度。 */
  isFitness: number[]
  /** 逐折样本外适应度。 */
  oosFitness: number[]
}

export type OverfitOutcome = 'PASS' | 'REJECT' | 'UNVERIFIABLE'

export interface OverfitVerdict {
  outcome: OverfitOutcome
  /** 仅当 outcome === 'PASS' 时为 true。 */
  pass: boolean
  /** 凭据完整但明确不达标 —— 这类拒绝不可通过放宽配置绕过（配置本身由部署决定，不由数据决定）。 */
  fatal: boolean
  reasons: string[]
  /** 一句话摘要，供审计事件与日志使用。 */
  summary: string
}

function structuralErrors(r: unknown): string[] {
  const errs: string[] = []
  if (typeof r !== 'object' || r === null) return ['凭据缺失或不是对象']
  const o = r as Partial<OverfitReceipt>
  if (o.version !== OVERFIT_VERSION) errs.push(`凭据版本不符（${String(o.version)} ≠ ${OVERFIT_VERSION}）`)
  if (typeof o.dataHash !== 'string' || o.dataHash.length === 0) errs.push('缺少数据指纹 dataHash')
  const ints: (keyof OverfitReceipt)[] = ['bars', 'candidates', 'folds', 'pboSlices', 'pboCombinations']
  for (const k of ints) {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errs.push(`${k} 非有限非负数（${String(v)}）`)
  }
  const arrays: (keyof OverfitReceipt)[] = ['perFoldWinnerW', 'isFitness', 'oosFitness']
  for (const k of arrays) {
    const v = o[k]
    if (!Array.isArray(v)) errs.push(`${k} 不是数组`)
    else if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) errs.push(`${k} 含非有限元素`)
  }
  // 「逐折」类数组必须与 folds 等长。不等长说明凭据是拼出来的 ——
  // 一旦允许长短不一，均值就会在「分母是哪个」上产生口径漂移。
  if (typeof o.folds === 'number' && Array.isArray(o.perFoldWinnerW) && o.perFoldWinnerW.length !== o.folds) {
    errs.push(`perFoldWinnerW 长度 ${o.perFoldWinnerW.length} ≠ folds ${o.folds}`)
  }
  if (typeof o.folds === 'number' && Array.isArray(o.isFitness) && o.isFitness.length !== o.folds) {
    errs.push(`isFitness 长度 ${o.isFitness.length} ≠ folds ${o.folds}`)
  }
  if (typeof o.folds === 'number' && Array.isArray(o.oosFitness) && o.oosFitness.length !== o.folds) {
    errs.push(`oosFitness 长度 ${o.oosFitness.length} ≠ folds ${o.folds}`)
  }
  for (const k of ['pbo', 'avgWinnerW', 'avgSelectionEdge'] as const) {
    const v = o[k]
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) errs.push(`${k} 应为有限数或 null（${String(v)}）`)
  }
  if (typeof o.avgWinnerW === 'number' && (o.avgWinnerW <= 0 || o.avgWinnerW >= 1)) {
    errs.push(`avgWinnerW 越界（${o.avgWinnerW} 应∈(0,1)）`)
  }
  if (typeof o.pbo === 'number' && (o.pbo < 0 || o.pbo > 1)) {
    errs.push(`pbo 越界（${o.pbo} 应∈[0,1]）`)
  }
  return errs
}

/** 结构完整性检查。返回空数组表示凭据**看起来**完整（不代表达标）。 */
export function verifyOverfitReceipt(r: unknown): string[] {
  return structuralErrors(r)
}

/** 由已算好的量组装凭据。纯函数，无引擎依赖，便于在烟测里构造边界用例。 */
export function buildOverfitReceipt(input: {
  dataHash: string
  bars: number
  candidates: number
  perFoldWinnerW: number[]
  isFitness: number[]
  oosFitness: number[]
  perFoldSelectionEdge: number[]
  pbo: PboResult | null
}): OverfitReceipt {
  const folds = input.perFoldWinnerW.length
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)
  return {
    version: OVERFIT_VERSION,
    dataHash: input.dataHash,
    bars: input.bars,
    candidates: input.candidates,
    folds,
    pbo: input.pbo ? input.pbo.pbo : null,
    pboSlices: input.pbo ? input.pbo.slices : 0,
    pboCombinations: input.pbo ? input.pbo.combinations : 0,
    avgWinnerW: mean(input.perFoldWinnerW),
    avgSelectionEdge: mean(input.perFoldSelectionEdge),
    perFoldWinnerW: [...input.perFoldWinnerW],
    isFitness: [...input.isFitness],
    oosFitness: [...input.oosFitness],
  }
}

/**
 * 三态裁定。
 *
 * 优先级刻意如此：
 *   ① 结构不完整 → `UNVERIFIABLE`。**无从判断，不是判断为通过。**
 *   ② 样本量不足（折数 / 候选数）→ `UNVERIFIABLE`。同上。
 *   ③ 指标明确越界 → `REJECT`。
 * ①② 与 ③ 的差别只影响排查口径，不影响结果 —— 两者都不放行。
 * 这正是 claimValidator 那条语义：**「无法验证」与「验证通过」是两件事。**
 */
export function judgeOverfit(receipt: unknown, th: OverfitThresholds = DEFAULT_OVERFIT_THRESHOLDS): OverfitVerdict {
  const errs = structuralErrors(receipt)
  if (errs.length > 0) {
    return {
      outcome: 'UNVERIFIABLE',
      pass: false,
      fatal: false,
      reasons: errs,
      summary: `凭据不可用（${errs.length} 项结构缺陷）：无从判断是否过拟合 —— 判不了就是判不了，按不放行处理`,
    }
  }

  const r = receipt as OverfitReceipt
  const insufficient: string[] = []
  if (r.folds < th.minFolds) insufficient.push(`折数不足（${r.folds} < ${th.minFolds}）`)
  if (r.candidates < th.minCandidates) {
    insufficient.push(`候选数不足（${r.candidates} < ${th.minCandidates}）：候选太少时「挑一个」这件事本身不成立，PBO 无意义`)
  }
  if (r.pbo === null) insufficient.push('PBO 缺失（数据不足以做 CSCV 切分）')
  else if (r.pboCombinations < th.minPboCombinations) {
    insufficient.push(
      `PBO 组合数不足（${r.pboCombinations} < ${th.minPboCombinations}）：` +
        `${r.pboSlices} 切片只枚举出 ${r.pboCombinations} 个组合，PBO 的分辨率停留在 ` +
        `1/${r.pboCombinations} 量级 —— 这个数可能碰巧落在低档，不足以当作「没有过拟合」的证据`,
    )
  }
  if (r.avgWinnerW === null) insufficient.push('赢家分位缺失（没有可比较的候选场）')
  if (insufficient.length > 0) {
    return {
      outcome: 'UNVERIFIABLE',
      pass: false,
      fatal: false,
      reasons: insufficient,
      summary: `过拟合样本不足：${insufficient.join('；')} —— 按不放行处理`,
    }
  }

  const pbo = r.pbo as number
  const avgWinnerW = r.avgWinnerW as number
  const reasons: string[] = []
  // 闭合边界（见 OverfitThresholds 的说明）：达到上限即拒、不高于下限即拒。
  if (pbo >= th.maxPbo) {
    reasons.push(
      `PBO ${(pbo * 100).toFixed(1)}% ≥ ${(th.maxPbo * 100).toFixed(0)}%：` +
        `样本内最优者有 ${(pbo * 100).toFixed(1)}% 的切分组合在样本外落到中位数以下 —— 冠军更可能是挑出来的，不是跑出来的`,
    )
  }
  if (avgWinnerW <= th.minAvgWinnerW) {
    reasons.push(
      `赢家样本外分位均值 ${avgWinnerW.toFixed(3)} ≤ ${th.minAvgWinnerW}：` +
        '样本内冠军在样本外并未优于候选场中位数，选择没有兑现成优势',
    )
  }
  if (reasons.length > 0) {
    return {
      outcome: 'REJECT',
      pass: false,
      fatal: true,
      reasons,
      summary: `过拟合判定不通过：${reasons.join('；')}`,
    }
  }

  return {
    outcome: 'PASS',
    pass: true,
    fatal: false,
    reasons: [],
    summary:
      `过拟合判定通过：PBO ${(pbo * 100).toFixed(1)}% < ${(th.maxPbo * 100).toFixed(0)}% · ` +
      `赢家样本外分位均值 ${avgWinnerW.toFixed(3)} > ${th.minAvgWinnerW} · ` +
      `${r.folds} 折 · ${r.candidates} 候选 · ${r.pboCombinations} 组合 · ` +
      `选择净收益 ${(r.avgSelectionEdge ?? 0).toFixed(3)}`,
  }
}
