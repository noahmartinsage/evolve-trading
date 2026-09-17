/**
 * 声明校验 —— 把「模型说的话」与「实测指标」对账。
 *
 * ══ 它解决什么问题 ═══════════════════════════════════════════════════
 * 决策日志里最危险的一类记录长这样：
 *
 *   「ADX 28 显示强趋势向上，盈亏比 3.2，建议做多」
 *
 * 读起来完全合理，而且它会被完整地留档、被复盘当成依据、被自进化当成样本。
 * 但如果当时实测 ADX 是 14、高周期结构是 BEAR —— 这句理由就是**编出来的**。
 * 更糟的是：没有任何机制会发现这件事。模型不自查，日志不核对，
 * 复盘的人看到的是一份**格式完美的虚假证据**，
 * 而它污染的是**用来训练下一版策略的样本集**。
 *
 * 情报里 qrak/LLM_trader 的做法叫 `claim validation`：
 * 把 LLM 输出与计算指标交叉验证，再决定是否执行。
 * 一句话概括就是 —— **「模型说买」不等于「指标支持买」，中间要有一次对账。**
 *
 * ══ 一条不能违反的语义 ═══════════════════════════════════════════════
 * **实测值缺失时判 `UNVERIFIABLE`，绝不判 `SUPPORTED`。**
 * 这是本模块存在意义的全部：如果「我们没测到 ADX」能算作「ADX 支持这个判断」，
 * 那校验就成了给幻觉盖章的机器。判不了就说判不了。
 *
 * 同理，`allowNoClaims` 默认为 false：**一个不含任何可证伪声明的理由，
 * 不应被视为已验证**。「无法验证」与「验证通过」是两件事。
 */

import type { MacroTrend } from './interceptors.ts'

export type ClaimKind = 'trend' | 'adx' | 'atr' | 'rr' | 'structure'

export interface Claim {
  kind: ClaimKind
  /** 命中该声明的原文片段，用于让人看见「我们到底在核哪句话」。 */
  text: string
  /** 声明中的量（若该声明带数值）。 */
  value?: number
  /** 声明的方向词。 */
  direction?: 'up' | 'down' | 'flat' | 'breakout' | 'breakdown'
  /**
   * 量的单位。ATR 可以写成百分比（`ATR 1.5%`）或绝对值（`ATR 320`），
   * 两者含义完全不同，必须显式区分 —— 靠 `direction` 兼职记录单位
   * 是那种「能跑但说不清」的写法，会在下一次改动时变成静默错误。
   */
  unit?: 'pct' | 'abs'
  /**
   * 声明**显式提到的周期**（如「ADX 1H」「ATR 4H」）。标准化为 '15M'|'1H'|'4H'|'1D'。
   *
   * 为什么必须记这个：数值型指标的取值高度依赖周期，
   * 15m 的 ADX 与 1H 的 ADX 是两个不同的量，**不可直接比对**。
   * 不记录周期就会造出「数字看着都能算，其实回答的是不同问题」的比对结果 ——
   * 这就是本项目反复出现的「两套口径」在指标层的翻版。
   */
  timeframe?: string
}

/** 决策时刻的实测事实。拿不到就不要填 —— 缺字段会被判 UNVERIFIABLE，而不是被当成 0。 */
export interface MeasuredFacts {
  macroTrend?: MacroTrend
  adx?: number
  atr?: number
  price?: number
  /**
   * `adx` / `atr` 的**周期口径**。标准化为 '15M'|'1H'|'4H'|'1D'。
   *
   * 声明里写了周期而这里没写 → 判 `UNVERIFIABLE`（「实测未标注口径」），
   * 而不是假设它们恰好一致。**口径未知的比对不算比对。**
   */
  timeframe?: string
  /** 已算出的盈亏比（由 orderRisk / 止损几何给出）。 */
  rr?: number
  h1SwingHigh?: number
  h1SwingLow?: number
}

export type ClaimVerdictKind = 'SUPPORTED' | 'CONTRADICTED' | 'UNVERIFIABLE'

export interface ClaimVerdict {
  claim: Claim
  verdict: ClaimVerdictKind
  measured: number | string | null
  /** 中文完整句。它会进决策日志，所以要能独立读懂。 */
  reason: string
}

/**
 * 三态裁定。
 *
 * 为什么必须是三态而不是「通过/不通过」两态：
 *   「发现声明与实测冲突」和「没有足够实测去核对声明」是两件性质完全不同的事。
 *   前者说明这个理由不可信，后者说明我们**不知道**它可不可信。
 *   把它们压成一个布尔，就必然有一类要被当成另一类处理 ——
 *   而把 UNVERIFIED 折进「通过」，就是又造了一台给幻觉盖章的机器。
 */
export type ValidationOutcome = 'VERIFIED' | 'REJECTED' | 'UNVERIFIED'

export interface ValidationReport {
  outcome: ValidationOutcome
  /** 仅当 outcome === 'VERIFIED' 时为 true。 */
  ok: boolean
  /** 存在与实测直接冲突的声明 —— 这类冲突足以否决整个提案。 */
  fatal: boolean
  claims: ClaimVerdict[]
  supported: number
  contradicted: number
  unverifiable: number
  /** 是否有足够的实测输入支撑校验。 */
  mathObservable: boolean
  reason: string
}

/** 数值类声明的容差。刻意偏松：我们要抓的是「编造」，不是吹毛求疵的舍入差异。 */
const ADX_TOLERANCE = 5
const RR_TOLERANCE = 0.15
const ATR_REL_TOLERANCE = 0.2

const TREND_PATTERNS: { re: RegExp; direction: Claim['direction'] }[] = [
  { re: /趋势(向上|上行)|上升趋势|多头排列|看涨|bull(ish)?/i, direction: 'up' },
  { re: /趋势(向下|下行)|下降趋势|空头排列|看跌|bear(ish)?/i, direction: 'down' },
  { re: /震荡|横盘|盘整|区间整理|range[- ]?bound/i, direction: 'flat' },
]

const STRUCTURE_PATTERNS: { re: RegExp; direction: Claim['direction'] }[] = [
  { re: /突破(前高|高点|上沿)|创(新|阶段)高|站上/, direction: 'breakout' },
  { re: /跌破(前低|低点|下沿)|创(新|阶段)低|失守/, direction: 'breakdown' },
]

function num(m: RegExpMatchArray | null, group = 1): number | undefined {
  if (!m) return undefined
  const v = Number(m[group])
  return Number.isFinite(v) ? v : undefined
}

/**
 * 从自由文本里抽取可证伪的声明。
 *
 * 刻意用确定性正则而不是再调一次模型来抽取：
 * 用模型校验模型会把问题绕回原点 —— 校验器的可信度必须高于被校验者，
 * 而一个正则表达式的行为是完全可预测、可复核、可进 CI 的。
 * 代价是它只认有限的句式，这个代价是划算的：**认不出的声明会被算作「未声明」，
 * 而不是被算作「已通过」。**
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = []
  if (!text) return claims

  for (const p of TREND_PATTERNS) {
    const m = text.match(p.re)
    if (m) claims.push({ kind: 'trend', text: m[0], direction: p.direction })
  }

  for (const p of STRUCTURE_PATTERNS) {
    const m = text.match(p.re)
    if (m) claims.push({ kind: 'structure', text: m[0], direction: p.direction })
  }

  const adx = text.match(/ADX\s*(15M|1H|4H|1D)?\s*[:=为]?\s*(\d+(?:\.\d+)?)/i)
  if (adx) claims.push({ kind: 'adx', text: adx[0], value: num(adx, 2), timeframe: adx[1]?.toUpperCase() })

  // ATR 允许写成 "ATR 1.5%" 或 "ATR 320"，也允许 "ATR 1H 320"
  const atr = text.match(/ATR\s*(15M|1H|4H|1D)?\s*[:=为]?\s*(\d+(?:\.\d+)?)\s*(%?)/i)
  if (atr) {
    claims.push({
      kind: 'atr',
      text: atr[0],
      value: num(atr, 2),
      unit: atr[3] === '%' ? 'pct' : 'abs',
      timeframe: atr[1]?.toUpperCase(),
    })
  }

  const rr = text.match(/(?:盈亏比|风险回报比|风报比|R\s*[:：]\s*R)\s*[:=为]?\s*(\d+(?:\.\d+)?)/i)
  if (rr) claims.push({ kind: 'rr', text: rr[0], value: num(rr) })

  return claims
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

function verifyOne(claim: Claim, facts: MeasuredFacts): ClaimVerdict {
  // 跨周期可比性守卫：数值型指标必须先确认「说的是同一个量」，再谈数值对不对。
  // 少了这一步，一次 15m 的 ADX 测量就能"核对"一条 1H 的声明 —
  // 两个数字都能算出来，却回答的是不同问题。
  if ((claim.kind === 'adx' || claim.kind === 'atr') && claim.timeframe) {
    if (!facts.timeframe) {
      return {
        claim,
        verdict: 'UNVERIFIABLE',
        measured: null,
        reason: `声称针对 ${claim.timeframe} 周期，但本次实测**未标注周期口径**，无从确认两者是否可比。口径未知的比对不算比对。`,
      }
    }
    if (claim.timeframe !== facts.timeframe) {
      return {
        claim,
        verdict: 'UNVERIFIABLE',
        measured: facts.timeframe,
        reason:
          `声称针对 ${claim.timeframe} 周期，而本次实测口径是 ${facts.timeframe} —— 跨周期数值不可直接比对。` +
          '两个数字都「能算出来」，但它们回答的是不同问题。',
      }
    }
  }

  switch (claim.kind) {
    case 'trend': {
      if (facts.macroTrend === undefined) {
        return {
          claim,
          verdict: 'UNVERIFIABLE',
          measured: null,
          reason: `声称「${claim.text}」，但本次决策未取到高周期结构（macroTrend 缺失），无从核对——判不了就是判不了。`,
        }
      }
      const map: Record<MacroTrend, Claim['direction']> = { BULL: 'up', BEAR: 'down', RANGE: 'flat' }
      const actual = map[facts.macroTrend]
      const ok = actual === claim.direction
      return {
        claim,
        verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
        measured: facts.macroTrend,
        reason: ok
          ? `声称「${claim.text}」，实测高周期结构确为 ${facts.macroTrend}，一致。`
          : `声称「${claim.text}」，但实测高周期结构是 **${facts.macroTrend}** —— 声明与实测方向相反。`,
      }
    }

    case 'structure': {
      if (facts.price === undefined || (facts.h1SwingHigh === undefined && facts.h1SwingLow === undefined)) {
        return {
          claim,
          verdict: 'UNVERIFIABLE',
          measured: null,
          reason: `声称「${claim.text}」，但缺少价格或 1H 摆动结构位，无从核对。`,
        }
      }
      if (claim.direction === 'breakout') {
        if (facts.h1SwingHigh === undefined) {
          return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: `声称「${claim.text}」，但未取到 1H 摆动高点。` }
        }
        const ok = facts.price > facts.h1SwingHigh
        return {
          claim,
          verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
          measured: facts.h1SwingHigh,
          reason: ok
            ? `声称「${claim.text}」，实测现价 ${facts.price} 确实高于 1H 摆动高点 ${facts.h1SwingHigh}。`
            : `声称「${claim.text}」，但实测现价 ${facts.price} 仍在 1H 摆动高点 ${facts.h1SwingHigh} 之下——并未突破。`,
        }
      }
      if (facts.h1SwingLow === undefined) {
        return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: `声称「${claim.text}」，但未取到 1H 摆动低点。` }
      }
      const ok = facts.price < facts.h1SwingLow
      return {
        claim,
        verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
        measured: facts.h1SwingLow,
        reason: ok
          ? `声称「${claim.text}」，实测现价 ${facts.price} 确实低于 1H 摆动低点 ${facts.h1SwingLow}。`
          : `声称「${claim.text}」，但实测现价 ${facts.price} 仍在 1H 摆动低点 ${facts.h1SwingLow} 之上——并未跌破。`,
      }
    }

    case 'adx': {
      if (claim.value === undefined) {
        return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: `「${claim.text}」未解析出数值，无法核对。` }
      }
      if (facts.adx === undefined) {
        return {
          claim,
          verdict: 'UNVERIFIABLE',
          measured: null,
          reason: `声称「${claim.text}」，但本次未取到 ADX 实测值${facts.timeframe ? `（实测口径 ${facts.timeframe}）` : ''}，无从核对。`,
        }
      }
      const diff = Math.abs(claim.value - facts.adx)
      const ok = diff <= ADX_TOLERANCE
      // 声明未标周期时，比对成立，但必须把「我们按哪个口径比的」写进理由。
      // 不写的话，这条裁决事后无法被复核 —— 读者无从判断当时比的是 15m 还是 1H，
      // 也就无法发现「同一句话被拿去做了一次跨周期比对」。
      const adxLabel = facts.timeframe
        ? claim.timeframe
          ? `（${facts.timeframe}）`
          : `（按实测口径 ${facts.timeframe} 比对；声明未标注周期）`
        : ''
      return {
        claim,
        verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
        measured: facts.adx,
        reason: ok
          ? `声称 ADX ${claim.value}，实测${adxLabel} ${facts.adx.toFixed(1)}（容差 ±${ADX_TOLERANCE}），一致。`
          : `声称 ADX ${claim.value}，实测${adxLabel}仅 ${facts.adx.toFixed(1)}，相差 ${diff.toFixed(1)} 超出容差 ±${ADX_TOLERANCE}。`,
      }
    }

    case 'atr': {
      if (claim.value === undefined) {
        return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: `「${claim.text}」未解析出数值，无法核对。` }
      }
      if (facts.atr === undefined || facts.price === undefined || facts.price <= 0) {
        return {
          claim,
          verdict: 'UNVERIFIABLE',
          measured: null,
          reason: `声称「${claim.text}」，但缺少 ATR 实测值${facts.timeframe ? `（实测口径 ${facts.timeframe}）` : ''}或现价，无从换算核对。`,
        }
      }
      // 声明可写成百分比（ATR 1.5%）或绝对值（ATR 320），统一换算成百分比再比
      const claimedPct = claim.unit === 'pct' ? claim.value / 100 : claim.value / facts.price
      const actualPct = facts.atr / facts.price
      const rel = Math.abs(claimedPct - actualPct) / Math.max(actualPct, 1e-9)
      const ok = rel <= ATR_REL_TOLERANCE
      const atrLabel = facts.timeframe
        ? claim.timeframe
          ? `（${facts.timeframe}）`
          : `（按实测口径 ${facts.timeframe} 比对；声明未标注周期）`
        : ''
      return {
        claim,
        verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
        measured: actualPct,
        reason: ok
          ? `声称 ${claim.text}，实测 ATR${atrLabel} 占现价 ${pct(actualPct)}（相对偏差 ${pct(rel)}），一致。`
          : `声称 ${claim.text}（≈${pct(claimedPct)}），实测${atrLabel}占现价 ${pct(actualPct)}，相对偏差 ${pct(rel)} 超出容差 ${pct(ATR_REL_TOLERANCE)}。`,
      }
    }

    case 'rr': {
      if (claim.value === undefined) {
        return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: `「${claim.text}」未解析出数值，无法核对。` }
      }
      if (facts.rr === undefined) {
        return {
          claim,
          verdict: 'UNVERIFIABLE',
          measured: null,
          reason: `声称「${claim.text}」，但本次未算出盈亏比，无从核对。`,
        }
      }
      const diff = Math.abs(claim.value - facts.rr)
      const ok = diff <= RR_TOLERANCE
      return {
        claim,
        verdict: ok ? 'SUPPORTED' : 'CONTRADICTED',
        measured: facts.rr,
        reason: ok
          ? `声称盈亏比 ${claim.value}，实测 ${facts.rr.toFixed(2)}（容差 ±${RR_TOLERANCE}），一致。`
          : `声称盈亏比 ${claim.value}，实测仅 ${facts.rr.toFixed(2)}，相差 ${diff.toFixed(2)} 超出容差 ±${RR_TOLERANCE}。`,
      }
    }

    default:
      return { claim, verdict: 'UNVERIFIABLE', measured: null, reason: '未知声明类型。' }
  }
}

/**
 * 校验一段理由文本。
 *
 * @param requireVerified 默认 **true**：只有 `VERIFIED` 才算通过。
 *        置为 false 时 `UNVERIFIED` 也放行（用于「实测输入本就稀缺」的场景），
 *        但 `REJECTED`（发现冲突）**任何情况下都不放行** ——
 *        「发现矛盾」从来不是可以配置放宽的条件。
 */
export function validateClaims(
  text: string,
  facts: MeasuredFacts,
  opts: { requireVerified?: boolean } = {},
): ValidationReport {
  const requireVerified = opts.requireVerified ?? true
  const claims = extractClaims(text)
  const verdicts = claims.map((c) => verifyOne(c, facts))
  const supported = verdicts.filter((v) => v.verdict === 'SUPPORTED').length
  const contradicted = verdicts.filter((v) => v.verdict === 'CONTRADICTED').length
  const unverifiable = verdicts.filter((v) => v.verdict === 'UNVERIFIABLE').length
  const mathObservable =
    facts.macroTrend !== undefined || facts.adx !== undefined || facts.rr !== undefined || facts.atr !== undefined

  const base = { claims: verdicts, supported, contradicted, unverifiable, mathObservable }

  // ① 发现冲突 —— 最高优先级，任何配置都不放宽
  if (contradicted > 0) {
    const first = verdicts.find((v) => v.verdict === 'CONTRADICTED')
    return {
      ...base,
      outcome: 'REJECTED',
      ok: false,
      fatal: true,
      reason:
        `理由中有 ${contradicted} 条声明与实测冲突（共 ${verdicts.length} 条）。` +
        `首条：${first?.reason ?? ''} ` +
        '声明与实测直接矛盾时，正确的判断是「这个理由不可信」，而不是「也许指标算错了」。',
    }
  }

  // ② 没有可核对的内容 —— 也算 UNVERIFIED，不算通过
  if (claims.length === 0) {
    return {
      ...base,
      outcome: requireVerified ? 'UNVERIFIED' : 'VERIFIED',
      ok: !requireVerified,
      fatal: false,
      reason:
        '理由中未发现任何可证伪的声明（未提及趋势方向、ADX、ATR 或盈亏比等可核对项）。' +
        '「无法验证」不等于「验证通过」——请让提案显式声明它相信什么，好让它能被核对。',
    }
  }

  // ③ 有部分核对不上 —— 未发现冲突，但也没构成「已验证」
  if (unverifiable > 0) {
    return {
      ...base,
      outcome: requireVerified ? 'UNVERIFIED' : 'VERIFIED',
      ok: !requireVerified,
      fatal: false,
      reason:
        `${supported} 条声明与实测一致，${unverifiable} 条因实测缺失无法核对。` +
        '未发现冲突，但这不等于已验证 —— 无法核对的部分不计入「已验证」。',
    }
  }

  // ④ 全部可核对且全部一致 —— 这才是 VERIFIED
  return {
    ...base,
    outcome: 'VERIFIED',
    ok: true,
    fatal: false,
    reason: `全部 ${supported} 条声明均与实测一致，无冲突、无缺口。`,
  }
}

/** 供面板/日志使用的一句话摘要。 */
export function summarizeReport(r: ValidationReport): string {
  const parts = [`可证伪声明 ${r.claims.length} 条`, `一致 ${r.supported}`, `冲突 ${r.contradicted}`, `无法核对 ${r.unverifiable}`]
  const badge = r.outcome === 'VERIFIED' ? '已验证' : r.outcome === 'REJECTED' ? '已否决' : '未验证'
  return `${badge}（${parts.join(' / ')}）${r.mathObservable ? '' : ' · 实测输入不足'}`
}
