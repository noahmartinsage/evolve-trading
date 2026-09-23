/**
 * 语音合约单的**杠杆裁决**
 *
 * ── 为什么手动单与自治单的规则不一样 ──────────────────────────────────
 * 自治路径（`autopilot.ts`）拿到高杠杆请求时是**钳制**：
 * `assertStopBeforeLiquidation` 把它降到能活下来的倍数，理由写在返回值里。
 * 那个选择是对的 —— 那边的杠杆是**系统自己算出来的**，
 * 降一档不改变策略意图，只是让它活下来。
 *
 * 手动语音单恰好相反：杠杆是**用户自己报的数**，是那条指令的全部内容。
 * 在这种情况下把 125 悄悄换成 3，与把它悄悄换成 1（现货）是同一类错误 ——
 * 用户说了一件事、系统做了另一件事，而且**两边都不报错**。
 * 用户实测的那次偏离（「10 美金 125 倍合约」→「现货 10 元买入」）就是这一族。
 *
 * 所以本模块的规则是：
 *   ① 能按用户说的做 ⇒ 就按他说的做，并把它念回去；
 *   ② 做不到 ⇒ **明确拒绝**，说清卡在哪一层、以及抬哪两个旋钮能放开。
 * 唯一的例外是「没听到倍数」——那不是诉求，是缺信息，按 1 倍并说明。
 *
 * ── 「卡在哪一层」为什么必须分开说 ────────────────────────────────────
 * `maxSafeLeverageDetail` 已经把三种成因分开了，这里必须把它转成人话，
 * 因为三种成因对应**三个不同且互不通用**的动作：
 *   · `geometry`    —— 你这一笔的止损太宽。抬配置**完全无效**，只有收止损有用。
 *   · `config`      —— 几何还能给更高，是 `EV_MAX_LEVERAGE` 只给到这么多。可调。
 *   · `hard-ceiling`—— 顶到代码里的硬边界了，调配置也无效。
 * 混成一句"杠杆不够"，用户会去反复抬 `EV_MAX_LEVERAGE`，
 * 而其中两种情况那个动作**一点用都没有**。
 */

import {
  LEVERAGE_HARD_CEILING,
  MAX_LEVERAGE,
  SPOT_MAX_LEVERAGE,
  STOP_SAFETY_PCT_MIN,
} from '../riskConstants.ts'
import {
  liquidationGeometry,
  liquidationDistancePctUnclamped,
  leverageForLiquidationDistance,
  maxSafeLeverageDetail,
  stopPctBoundForLeverage,
  type PositionSide,
} from '../positionGuard.ts'

export interface LeverageRequest {
  /** 入场参考价（标记价）。拿不到时只做配置层判断，不做几何判断。 */
  entryPrice: number
  side: PositionSide
  instType: 'SPOT' | 'SWAP'
  /** 用户报的倍数。`undefined` = 没听到（不是 1）。 */
  requested?: number
  /** 用户给的止损幅度（相对入场价）。0 或缺省 = 没给。 */
  stopLossPct?: number
}

export interface LeverageVerdict {
  ok: boolean
  /** 生效倍数。仅 `ok === true` 时有意义。 */
  effective: number
  /** 用户报的倍数；没报时为 1（生效值），但 `heard` 为 false。 */
  requested: number
  /** 用户到底有没有报倍数。区分它很重要：没报是缺信息，报了做不到是诉求不成立。 */
  heard: boolean
  /** 可念的解释。**ok 时也要念** —— 用户得知道系统按几个倍算的。 */
  speech: string
  /** 不可行时的原因码（落账用，可核对）。 */
  reason?: string
}

const n = (x: number, d = 2) => x.toFixed(d)

/**
 * 裁决。**纯函数**，不联网、不读配置之外的任何状态，因此可以离线逐条断言。
 * 配置值（`MAX_LEVERAGE` 等）在模块加载时已从 `riskConstants` 读入，
 * 调用方不需要也不允许传阈值 —— 阈值住消费方配置，这是本仓库的既定分工。
 */
export function judgeLeverage(req: LeverageRequest): LeverageVerdict {
  const heard = Number.isFinite(req.requested) && (req.requested ?? 0) > 0
  const requestedRaw = heard ? (req.requested as number) : 1
  // 四舍五入到两位，避免 1.0000000001 这类浮点噪声被判成"和用户说的不一样"
  const requested = Math.round(requestedRaw * 100) / 100

  // ── 没听到倍数 ──────────────────────────────────────────────────
  if (!heard) {
    if (req.instType === 'SWAP') {
      return {
        ok: true,
        effective: 1,
        requested: 1,
        heard: false,
        speech:
          '你说了合约但没说几倍，我按 1 倍下 —— 1 倍的合约敞口和现货一样，' +
          '要真加杠杆就说「125 倍」这样。',
      }
    }
    return { ok: true, effective: 1, requested: 1, heard: false, speech: '现货单，不带杠杆。' }
  }

  // ── 现货：倍数上限与合约不同 ─────────────────────────────────────
  // ★ 措辞与 `risk.ts` 的 `LEVERAGE_REQUIRES_SWAP` 保持同一件事的同一说法：
  //   同一句拒绝理由不许有两个版本，否则用户拿到的下一步动作不一样。
  if (req.instType !== 'SWAP' && requested > SPOT_MAX_LEVERAGE) {
    return {
      ok: false,
      effective: 1,
      requested,
      heard: true,
      reason: `LEVERAGE_REQUIRES_SWAP (${requested}x > 现货杠杆上限 ${SPOT_MAX_LEVERAGE}x)`,
      speech:
        `${requested} 倍是合约的倍数，现货最多 ${SPOT_MAX_LEVERAGE} 倍。` +
        '你要么说「合约」让我按合约下，要么把倍数降到 ' +
        `${SPOT_MAX_LEVERAGE} 以内。我不替你改这两个数里的任何一个 —— ` +
        '改了哪一个都不是你要的东西。',
    }
  }

  // ── 硬天花板 ────────────────────────────────────────────────────
  if (requested > LEVERAGE_HARD_CEILING) {
    return {
      ok: false,
      effective: 1,
      requested,
      heard: true,
      reason: `LEVERAGE_ABOVE_HARD_CEILING (${requested}x > ${LEVERAGE_HARD_CEILING}x)`,
      speech: `${requested} 倍超过了硬上限 ${LEVERAGE_HARD_CEILING} 倍，这个上限写在代码里，调配置也没用。`,
    }
  }

  // ── 分档：先问「有没有止损」，再验几何 ─────────────────────────────
  //
  // ★★ 2026-09-22 重写。原来的分档是 `requested <= MAX_LEVERAGE ⇒ 直接放行`，
  //   也就是**把配置上限当成了"危险倍数"的替身**。在 MAX_LEVERAGE=3 时那个替身
  //   恰好成立；按用户要求把 `EV_MAX_LEVERAGE` 抬到 125 之后，两件事一起坏掉（实测）：
  //     ① 几何检查对 125 倍**整条短路**：125 倍 + 止损 1% 被判 ok，
  //        而 125 倍强平距离只有 0.10% —— **止损远比强平晚**。念白还照样说得出
  //        「强平价在 77430.02（距现价 0.10%）。你给的止损 1.00% 在这之前触发，能先跑掉。」
  //        前半句 0.10%、后半句 1.00%，**一句话里两个数互斥**。
  //        这正是 F-36「止损晚于强平、账面叙事与真实因果脱钩」那个 P0 的形态原样复活；
  //        执行层还会把它静默钳到 45.45 倍，而用户以为按 125 倍下的单。
  //     ② 「不用止损也安全」的豁免跟着放大到 125 倍 —— 125 倍下价格走 0.10% 就爆仓。
  //   ⇒ 判据换成**这两件事本身**，不再借配置值当替身：
  //        有止损 ⇒ 无论倍数高低都验几何（有止损时"止损先于强平"是个真命题）；
  //        没止损 ⇒ 只在这一档**强平距离本身够远**时放行。
  const stopPct = Number.isFinite(req.stopLossPct) && (req.stopLossPct ?? 0) > 0 ? (req.stopLossPct as number) : 0

  // ── ① 给了止损：几何必须验，倍数越高越要验 ───────────────────────
  if (stopPct > 0) {
    const safe = maxSafeLeverageDetail(stopPct)

    // 几何层就不够（与配置无关）
    if (safe.raw < requested) {
      // ★★ 这里必须用**几何自己的反函数**，不许手抄一份逆运算。
      //   旧写法是 `1 / requested / LIQUIDATION_SAFETY_MULT`，**漏掉了维持保证金+费率**，
      //   把「125 倍需要止损 ≤0.0667%」念成了 **0.533%**（差 8 倍）——
      //   用户照着念出来的数去收窄止损，**仍然下不出去**（实测复现）。
      const boundPct = stopPctBoundForLeverage(requested) * 100
      // ★ 再向下取整到**它即将被念出的精度**，绝不上取：
      //   上确界 0.066667% 四舍五入到 3 位 = 0.067% ⇒ 几何只给 124.92 倍，用户照做**仍被拒**。
      //   与上面同一类错误：念出来的数必须真的过得去，否则用户会陷入"照做、再被拒"的循环。
      const boundSpoken = Math.floor(boundPct * 1000) / 1000
      const action =
        boundSpoken > 0
          ? `止损得收到 ${n(boundSpoken, 3)}% 以内 —— 那比多数合约的买卖价差还窄。`
          : `${requested} 倍高到**不存在**可用的止损宽度（价格还没走出维持保证金+费率就已经爆仓），` +
            `这一档只能降倍数。`
      return {
        ok: false,
        effective: 1,
        requested,
        heard: true,
        reason: `LEVERAGE_GEOMETRY (requested=${requested} maxSafe=${safe.raw} stopPct=${stopPct})`,
        speech:
          `你要 ${requested} 倍，但止损 ${n(stopPct * 100, 2)}% —— ${requested} 倍下强平距离只有 ` +
          `${n((1 / requested) * 100, 2)}%（还要再扣维持保证金和费率），止损根本等不到就被强平了。` +
          `按你这个止损宽度，几何上能用的是 ${safe.raw} 倍；想真用 ${requested} 倍，` +
          action +
          '两个方向你挑一个说，我不替你改。',
      }
    }

    // 几何够，但配置上限卡住。
    // ★ 本档在 `MAX_LEVERAGE` 顶到 `LEVERAGE_HARD_CEILING` 时**不可达**：
    //   那种配置下 `applied` 的上界就是硬边界，而 `raw ≥ requested ≤ 硬边界` 必然成立。
    //   这不是死代码，是"这一档被配置注销了" —— 该事实由 `contract-order-smoke` 的
    //   扫描断言单独钉住（扫遍 1..125，拒绝原因里**不许出现** `LEVERAGE_ABOVE_CONFIG`）。
    if (safe.applied < requested) {
      return {
        ok: false,
        effective: 1,
        requested,
        heard: true,
        reason: `LEVERAGE_ABOVE_CONFIG (requested=${requested} applied=${safe.applied} ceiling=${safe.ceiling})`,
        speech:
          `你要 ${requested} 倍。按你的止损 ${n(stopPct * 100, 2)}%，几何上最多能给 ` +
          `${safe.raw} 倍（这一笔扛得住），但系统当前上限是 ${MAX_LEVERAGE} 倍（EV_MAX_LEVERAGE）。` +
          `把那个值抬到 ${Math.min(safe.raw, LEVERAGE_HARD_CEILING)} 以内，我就能按你要的做；` +
          `在那之前我不动这一笔 —— 悄悄替你降到 ${safe.applied} 倍，和上次替你降到 1 倍是同一件事。`,
      }
    }

    const liq = liquidationGeometry(req.entryPrice, req.side, requested)
    return {
      ok: true,
      effective: requested,
      requested,
      heard: true,
      speech:
        `按你要的 ${requested} 倍。强平价在 ${n(liq.price, 2)}（距现价 ${n(liq.distancePct * 100, 2)}%），` +
        `你的止损 ${n(stopPct * 100, 2)}% 会在它之前触发。`,
    }
  }

  // ── ② 没给止损：只看**强平距离本身**够不够远 ──────────────────────
  //
  // 「够远」的判据复用既有的 `STOP_SAFETY_PCT_MIN`（系统允许的**最窄**止损垫）：
  // 若强平距离连"最窄的止损"都装不下，那这笔单不存在有效的保护 —— 而它现在没有。
  //
  // ★ 为什么不拿 `MAX_LEVERAGE` 当判据：那会把"配置允许我报多高"与
  //   "这个倍数下裸奔安不安全"绑成一件事，抬配置就顺带放宽了安全性。
  const bareLiqRaw = liquidationDistancePctUnclamped(requested)
  if (requested <= 1 || bareLiqRaw >= STOP_SAFETY_PCT_MIN) {
    const liq = req.entryPrice > 0 ? liquidationGeometry(req.entryPrice, req.side, requested) : null
    const liqNote =
      liq && liq.distancePct > 0 ? `强平价在 ${n(liq.price, 2)}（距现价 ${n(liq.distancePct * 100, 2)}%），` : ''
    return {
      ok: true,
      effective: requested,
      requested,
      heard: true,
      speech:
        `按你要的 ${requested} 倍。${liqNote}你没给止损，这一档不强制 —— ` +
        `强平距离比系统允许的最窄止损（${n(STOP_SAFETY_PCT_MIN * 100, 2)}%）还远，` +
        `止损被打掉之前不会先被强平；给了我我会更早离场。`,
    }
  }

  // ── ③ 没止损，而强平距离比最窄止损还近 ⇒ 必须有止损 ───────────────
  //
  // ★ 这里要回答"要么给止损、要么降倍数"里的**降到几**。那个数必须从几何算出来
  //   （`leverageForLiquidationDistance`），不许另写一份字面量 —— 另写一份必然会分岔，
  //   旧代码就是那样把止损建议写错了 8 倍。
  // ★ 浮点会在边界上差最后一个 ulp，而"念出来的数必须真的能过"这条要求不允许差那一点，
  //   所以往下退到真的满足为止（与止损上确界向下取整是同一类处置，只是这里退的是整数）。
  let bareSafeLev = Math.floor(leverageForLiquidationDistance(STOP_SAFETY_PCT_MIN))
  while (bareSafeLev > 1 && liquidationDistancePctUnclamped(bareSafeLev) < STOP_SAFETY_PCT_MIN) {
    bareSafeLev -= 1
  }
  return {
    ok: false,
    effective: 1,
    requested,
    heard: true,
    reason:
      `HIGH_LEVERAGE_NEEDS_STOP (${requested}x liqDist=${n(bareLiqRaw * 100, 2)}% < ` +
      `minStop=${n(STOP_SAFETY_PCT_MIN * 100, 2)}%, and no stop given)`,
    speech:
      `${requested} 倍下强平距离只有 ${n(bareLiqRaw * 100, 2)}%` +
      `（毛口径 ${n((1 / requested) * 100, 2)}%，已扣维持保证金与费率缓冲），` +
      `比系统允许的最窄止损 ${n(STOP_SAFETY_PCT_MIN * 100, 2)}% 还近 —— ` +
      `没有止损时价格先碰到的是强平，不是止损。` +
      `给我一句止损再说一次（比如「止损 1%」），或者把倍数降到 ${bareSafeLev} 以内。` +
      `这一档我要先验「止损一定早于强平」才敢放行，而你没给止损。`,
  }
}
