/**
 * 尾部风险度量 —— CVaR（条件在险价值）与峰值回撤。
 *
 * 内化自 2026-09-14 日报第 ④ 条（加密量化 RL 的共识结论）：
 * MacroHFT 与 FinRL-DeepSeek 不约而同地在 PPO/CPPO 上叠加 **CVaR 约束**
 * 来防黑天鹅爆仓，而不是只看 Sharpe / 胜率。理由很直白：
 * 均值与方差**完全看不见尾部形状** —— 一个策略可以胜率 90%、
 * 平均收益为正，同时把 10% 的坏日子集中在一次 30% 的崩塌里。
 * 只看均值会把它评成优秀策略，直到那一次崩塌真的发生。
 *
 * ── 为什么不复用已有的 maxDrawdownPct ──────────────────────────────
 * 回撤是**路径量**：它只告诉你「历史上最深挖到多深」，不告诉你
 * 「最坏的 5% 平均有多坏」。两者问的是不同问题：
 *   - 回撤回答：这条曲线最难看的地方有多难看（对曲线形状敏感）
 *   - CVaR 回答：坏日子的典型深度是多少（对尾部集中度敏感）
 * 一个回撤很浅但亏损高度集中在少数几笔的策略，回撤看不出来，CVaR 能。
 *
 * ── 符号约定（本文件最容易被读错的地方，故显式定义）─────────────────
 *   - 输入 `returns` 是**逐笔收益率百分比**，正数=盈利、负数=亏损。
 *   - `worstTailMean` 返回**带符号**的尾部均值（正常情况为负）。
 *   - `cvarLossPct` 返回**非负的损失幅度**，可直接与阈值比较。
 * 两个函数同时存在而不是只留一个，是因为符号翻转是这类计算里
 * 最隐蔽的错误：算出来是 -3.2 却当成 +3.2 去比阈值，
 * 结果是**越危险的策略越容易通过**，而且不报错。
 */

/** 默认尾部分位：最差 5% 的样本。 */
export const CVAR_DEFAULT_ALPHA = 0.05

function normAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0) return CVAR_DEFAULT_ALPHA
  return Math.min(alpha, 1)
}

/**
 * 尾部样本量的取整规则：`max(1, ceil(alpha × n))`。
 *
 * 为什么必须 `max(1, …)` 而不是 `round`：
 * n=10、alpha=0.05 时 `ceil(0.5)=1`，若用 `round` 得到 0 —— 尾部为空，
 * 于是**样本越少越容易通过**。这正是"数据不足反而显得安全"这类
 * 反向激励的经典形态，必须从取整规则上就堵掉。
 */
function tailSize(n: number, alpha: number): number {
  return Math.max(1, Math.ceil(normAlpha(alpha) * n))
}

/**
 * 最坏 `alpha` 分位收益的**带符号**均值。样本不足 2 个时返回 null。
 *
 * 返回 null 而不是 0：0 表示"尾部无损失"，与"没有数据"是完全不同的结论。
 * 把它混成 0 会让缺数据的策略看起来比有数据的更安全 —— 这是闸门类代码
 * 最常见也最致命的一类退化。
 */
export function worstTailMean(returns: readonly number[], alpha = CVAR_DEFAULT_ALPHA): number | null {
  const clean = returns.filter((r) => Number.isFinite(r))
  if (clean.length < 2) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const k = tailSize(sorted.length, alpha)
  const tail = sorted.slice(0, k)
  return tail.reduce((a, b) => a + b, 0) / tail.length
}

/**
 * 尾部平均损失幅度（**非负**）。无足够样本时返回 null。
 *
 * 语义：最坏的 alpha 分位平均亏多少个百分点。
 * 全为正收益的样本返回 0（尾部没有损失，而不是"返回空"）。
 */
export function cvarLossPct(returns: readonly number[], alpha = CVAR_DEFAULT_ALPHA): number | null {
  const m = worstTailMean(returns, alpha)
  if (m === null) return null
  return Math.max(0, -m)
}

/** 单笔最大亏损幅度（非负）。比 CVaR 更极端但对样本量不敏感，两者互补。 */
export function worstSingleLossPct(returns: readonly number[]): number | null {
  const clean = returns.filter((r) => Number.isFinite(r))
  if (clean.length === 0) return null
  return Math.max(0, -Math.min(...clean))
}

/**
 * 由逐笔收益序列还原峰值回撤（百分比，非负）。
 *
 * 按**复利**累乘而不是简单求和：逐笔收益率的口径就是复利的，
 * 用求和会系统性低估回撤（亏损后本金变少，同样的收益率对应更小的绝对损失，
 * 反之亦然），在长序列上偏差会累积到不可忽略。
 */
export function maxDrawdownFromReturns(returns: readonly number[]): number | null {
  const clean = returns.filter((r) => Number.isFinite(r))
  if (clean.length === 0) return null
  let equity = 1
  let peak = 1
  let maxDd = 0
  for (const r of clean) {
    equity *= 1 + r / 100
    if (equity > peak) peak = equity
    const dd = ((peak - equity) / peak) * 100
    if (dd > maxDd) maxDd = dd
  }
  return maxDd
}

export interface TailRiskSummary {
  /** 有效样本数。 */
  samples: number
  /** 尾部（最差 alpha 分位）带符号均值。 */
  worstTailMean: number
  /** 尾部平均损失幅度（非负，用于与阈值比较）。 */
  cvarLossPct: number
  /** 单笔最大亏损幅度（非负）。 */
  worstSingleLossPct: number
  /** 复利口径峰值回撤（非负）。 */
  maxDrawdownPct: number
  alpha: number
}

/** 一次性汇总，供闸门与审计事件使用（避免调用方分别算再拼，那是口径漂移的入口）。 */
export function tailRiskSummary(returns: readonly number[], alpha = CVAR_DEFAULT_ALPHA): TailRiskSummary | null {
  const m = worstTailMean(returns, alpha)
  const w = worstSingleLossPct(returns)
  const dd = maxDrawdownFromReturns(returns)
  if (m === null || w === null || dd === null) return null
  return {
    samples: returns.filter((r) => Number.isFinite(r)).length,
    worstTailMean: m,
    cvarLossPct: Math.max(0, -m),
    worstSingleLossPct: w,
    maxDrawdownPct: dd,
    alpha: normAlpha(alpha),
  }
}
