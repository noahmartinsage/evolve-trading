/**
 * 合约下单契约烟测
 *
 * ── 这份测试要证明的那一件事 ──────────────────────────────────────────
 * 用户实测原话：
 *
 *   「下单 BTC 10 美金 125 倍合约做多，止盈 10 成，止损 1 成」
 *
 * 得到的是**现货 10 U 买入**。这句话里四个信息（合约 / 125 倍 / 止盈 / 止损）
 * 在旧实现里**一个槽位都没有**，于是它被静默降级成一笔完全合法的现货单。
 * 没有任何一道门会响 —— 因为那笔单本身没有问题。
 *
 * 所以这份测试的核心不是"能不能下单"，而是：
 * **这句话里的每一个信息，都要能在槽位里被逐字找回来。**
 *
 * ── 三条被反复踩的坑，各配一个"只有它"的输入 ─────────────────────────
 * ① `10U` 的大写 U。单位表是小写 ASCII，正则不带 `i` 就匹配不上，
 *    于是金额落到裸数字兜底上去 —— 而那句话里裸数字里最靠前的是**杠杆**。
 *    专属输入：`开 3 倍合约做多 BTC 10U`（修好前拿到 3，修好后是 10）。
 * ② 一句话里有好几个数。杠杆 / 止盈 / 止损 / 金额都得先问"这个数归谁"。
 *    专属输入：`开 125 倍合约做多 BTC`（没有任何金额 ⇒ 必须是 null，
 *    若是 125 就说明杠杆那个数被当成了金额）。
 * ③ 「成」与「%」差十倍。`10成` = 100%，`10%` = 10%。
 *    专属输入：两句只差一个单位，结果必须正好差 10 倍。
 *
 * ── 拒绝这一侧要证明的三件事互不顶替（判据 3 / 25）──────────────────
 * 「做不到」有三种成因，对应**三个互不通用**的下一步动作：
 *   · 几何不够  → 只有收窄止损有用，抬配置**一点用没有**；
 *   · 配置不够  → 抬 EV_MAX_LEVERAGE 有用，收止损可能也有用；
 *   · 没给止损  → 缺的是一条止损，不是别的。
 * 三份说明必须各含**只有它**才有的那句下一步，且互不出现在对方的文案里。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIntent } from '../server/voice/intents.ts'
import { extractAmount } from '../server/voice/numerals.ts'
import {
  CHENG,
  maskContractFigures,
  parseInstType,
  parseLeverage,
  parseProtection,
} from '../server/voice/contract.ts'
import { judgeLeverage } from '../server/voice/leverageGuard.ts'
import { describeContractOrder } from '../server/voice/service.ts'
import { createPending, confirmPending, clearPending, resetSession } from '../server/voice/session.ts'
import { LEVERAGE_HARD_CEILING, MAX_LEVERAGE, SPOT_MAX_LEVERAGE, STOP_SAFETY_PCT_MIN } from '../server/riskConstants.ts'
import { leverageForLiquidationDistance, stopPctBoundForLeverage } from '../server/positionGuard.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] CONTRACT ORDER SMOKE FAIL - ${name} - ${msg}`)
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
    join(dir, 'contract-order-latest.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), scenarios }, null, 2),
  )
}

function eq<T>(name: string, actual: T, expected: T, extra = ''): void {
  if (actual !== expected) {
    fail(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${extra ? ` · ${extra}` : ''}`)
  }
}

function near(name: string, actual: number | undefined, expected: number, eps: number, extra = ''): void {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
    fail(name, `期望 ≈${expected}（±${eps}），实际 ${JSON.stringify(actual)}${extra ? ` · ${extra}` : ''}`)
  }
}

function truthy(name: string, cond: boolean, msg: string): void {
  if (!cond) fail(name, msg)
}

function includes(name: string, hay: string, needle: string): void {
  if (!hay.includes(needle)) fail(name, `文案里必须出现「${needle}」，实际是：${hay}`)
}

/** 负向断言：这个词**只能出现在别的分支**。选词一律挑"那个分支独有的动作词"。 */
function excludes(name: string, hay: string, needle: string): void {
  if (hay.includes(needle)) fail(name, `文案里不该出现「${needle}」（它属于另一个分支的动作），实际是：${hay}`)
}

const MARK = 78_000
const CTX = { symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], markPrice: (s: string) => (s === 'ETHUSDT' ? 3_000 : MARK) }

function slotsOf(text: string) {
  const p = parseIntent(text, CTX)
  if (!p.slots) fail('解析前置', `「${text}」没有产出槽位（intent=${p.intent}）`)
  return { parsed: p, slots: p.slots! }
}

function main(): void {
  // ═══════════════ A · 用户原话：四个槽位一个都不许丢 ═══════════════
  const ORIGINAL = '下单BTC10美金125倍合约做多止盈10成止损1成'
  {
    const { parsed, slots } = slotsOf(ORIGINAL)
    eq('A1 意图是下单', parsed.intent, 'place_order')
    eq('A1 方向做多', slots.side, 'buy')
    eq('A1 标的是 BTCUSDT', slots.symbol, 'BTCUSDT')
    // ★ 下面四条就是这次偏离的全部内容。任何一条丢了，用户拿到的都不是他要的东西。
    eq('A1 合约形态装上', slots.instType, 'SWAP', '少了它 ⇒ 变成现货单')
    eq('A1 杠杆装上', slots.leverage, 125, '少了它 ⇒ 变成 1 倍')
    near('A1 止盈装上（10 成 = 100%）', slots.takeProfitPct, 1.0, 1e-9, '少了它 ⇒ 没有止盈')
    near('A1 止损装上（1 成 = 10%）', slots.stopLossPct, 0.1, 1e-9, '少了它 ⇒ 没有止损')
    eq('A1 金额语义是保证金', slots.amountBasis, 'margin', '合约 + 说了倍数 ⇒ 那个钱是我出的保证金')
    near('A1 名义额 = 10 × 125', slots.notional, 1250, 1e-6, '不是 10（差 125 倍），也不是 15625（杠杆被当成金额）')
    pass('A1 用户原话四个槽位齐全', `SWAP · ${slots.leverage}x · 止盈 ${(slots.takeProfitPct! * 100).toFixed(0)}% · 止损 ${(slots.stopLossPct! * 100).toFixed(0)}% · 名义 ${slots.notional}`)
  }

  {
    // ★ 专属输入：括号里那句原话加了空格与逗号，是**同一个诉求的另一种写法**。
    //   两条都必须解析成一样的东西 —— 否则用户换个标点就换一个结果。
    const { slots } = slotsOf('BTC 10美金 125倍合约做多，止盈10成，止损1成')
    eq('A2 换标点不换结果（形态）', slots.instType, 'SWAP')
    eq('A2 换标点不换结果（杠杆）', slots.leverage, 125)
    near('A2 换标点不换结果（名义）', slots.notional, 1250, 1e-6)
    pass('A2 标点/空格不影响解析', '同一诉求两种写法解析一致')
  }

  // ═══════════════ B · 「这个数归谁」═══════════════
  {
    // ★ 专属输入：大写 U。修好前 `10U` 匹配不上单位表（小写 ASCII），
    //   金额会落到裸数字兜底上，取到**杠杆那个 3** ⇒ 名义 9。
    const { slots } = slotsOf('开 3 倍合约做多 BTC 10U')
    near('B1 大写 U 要认成金额（不是杠杆那个数）', slots.notional, 30, 1e-6, '10 × 3 = 30；取到 3 的话会变成 9')
    eq('B1 杠杆仍然是 3', slots.leverage, 3)
    pass('B1 大写 U 归属正确', '金额取 10（不是杠杆 3），名义 30')
  }

  {
    // ★ 专属输入：**句子里没有任何金额**。此时金额必须是 null；
    //   若拿到 125，就说明杠杆那个数被当成了金额（判据 29：先问这句归谁）。
    const masked = maskContractFigures('开 125 倍合约做多 BTC')
    const amt = extractAmount(masked)
    eq('B2 只有杠杆没有金额 ⇒ 解析不出金额', amt, null, '拿到数字就说明杠杆那个数被当成了金额')
    pass('B2 无金额时不会误取杠杆数', '遮掉杠杆段后金额为 null')
  }

  {
    const masked = maskContractFigures('做多 BTC 10 美金，止盈 10 成，止损 1 成')
    const amt = extractAmount(masked)
    near('B3 遮掉止盈止损后金额还在', amt?.value, 10, 1e-9)
    eq('B3 金额单位仍是名义额', amt?.basis, 'notional')
    pass('B3 三类数字各归其主', '金额 10 / 止盈 10 成 / 止损 1 成 互不串位')
  }

  // ═══════════════ C · 「成」与「%」差十倍 ═══════════════
  {
    const cheng = parseProtection('止盈 10 成', 'takeProfit')
    const pct = parseProtection('止盈 10%', 'takeProfit')
    near('C1 10 成 = 100%', cheng.pct, 1.0, 1e-9)
    near('C1 10% = 10%', pct.pct, 0.1, 1e-9)
    // ★ 这条断言的价值在于：把两个单位合并实现的版本，会让两者相等。
    near('C1 成与百分号必须差 10 倍', (cheng.pct ?? 0) / (pct.pct ?? 1), 10, 1e-9)
    eq('C1 「成」的换算是十分之一', CHENG, 0.1)
    pass('C1 成数 / 百分比分开算', '10 成 → 100%，10% → 10%，比值 10')
  }

  {
    const sl = parseProtection('止损 5%', 'stopLoss')
    near('C2 阿拉伯百分号', sl.pct, 0.05, 1e-9)
    const cn = parseProtection('止损百分之五', 'stopLoss')
    near('C2 汉字百分之', cn.pct, 0.05, 1e-9)
    const dian = parseProtection('止损 5 个点', 'stopLoss')
    near('C2 口语「个点」', dian.pct, 0.05, 1e-9)
    pass('C2 三种百分比写法归一', '5% / 百分之五 / 5 个点 → 都是 0.05')
  }

  {
    const abs = parseProtection('止损 74100', 'stopLoss', MARK)
    near('C3 绝对价换算成比例', abs.pct, 0.05, 1e-6, '|74100−78000|/78000 = 5%')
    const noEntry = parseProtection('止损 74100', 'stopLoss')
    truthy('C3 没有入场价时拒绝换算而不是拿 0 顶替', typeof noEntry.error === 'string' && noEntry.pct === undefined, '拿 0 顶替会算出 Infinity/NaN，而 NaN 能过大部分数值比较')
    includes('C3 拒绝时说清缺什么', noEntry.error ?? '', 'NEEDS_ENTRY_PRICE')
    pass('C3 绝对价要入场价才成立', '有价换算成 5%，没价显式报错')
  }

  // ═══════════════ D · 现货语义没有被顺手改掉 ═══════════════
  {
    const { slots } = slotsOf('买两百块钱的比特币')
    eq('D1 现货单形态', slots.instType ?? 'SPOT', 'SPOT')
    eq('D1 现货不带杠杆', slots.leverage, undefined)
    eq('D1 现货金额是名义额', slots.amountBasis, 'notional')
    near('D1 名义 200（不是 200×某倍数）', slots.notional, 200, 1e-9)
    const rd = describeContractOrder(slots, MARK)
    truthy('D1 现货单放行', rd.ok, rd.reason ?? '')
    includes('D1 念回里说清是现货', rd.echo, '现货')
    pass('D1 合约改动不污染现货', '200 美元现货、无杠杆、无强平')
  }

  {
    const { slots } = slotsOf('买 0.01 个比特币')
    eq('D1b 数量语义没变', slots.amountBasis, 'qty')
    near('D1b 数量 0.01', slots.qty, 0.01, 1e-12)
    pass('D1b 数量单没受影响', 'qty=0.01、非保证金语义')
  }

  // ═══════════════ E · 「说了保护但没解析出比例」必须说出来 ═══════════════
  {
    // ★ 专属输入：有关键词、没有数字。此时**不能沉默** ——
    //   沉默的后果是用户以为设了保护、实际在裸跑。
    const { slots } = slotsOf('做多 BTC 10 美金，止盈')
    eq('E1 标出止盈未解析', slots.protectionUnparsed?.takeProfit, true, '这一栏必须是 true，不能靠 takeProfitPct === undefined 反推')
    eq('E1 确实没解析出比例', slots.takeProfitPct, undefined)
    const rd = describeContractOrder(slots, MARK)
    includes('E1 回话里点名这一条', rd.echo, '没解析出比例')
    pass('E1 未解析的保护会被点出来', '「你说了，但我没解析出比例」出现在回话里')
  }

  // ═══════════════ F · 拒绝三态互不顶替 ═══════════════
  //
  // ★ 三个专属输入，各触发**只有它**会走到的那条分支。
  //   判据 25：如果三个成因在文案上长得一样，用户就没法知道下一步该干什么。
  {
    // F1 几何不够：requested 5 > 配置 3，而几何给 1.32 ⇒ geometry 分支
    const geo = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 5, stopLossPct: 0.5 })
    truthy('F1 几何不够要拒绝', !geo.ok, '止损 50% 时 5 倍必须先于强平，做不到就该拒')
    includes('F1 说清是几何卡的', geo.speech, '几何上能用的是')
    includes('F1 给出收窄止损这个动作', geo.speech, '止损得收到')
    excludes('F1 不许把用户引去抬配置', geo.speech, 'EV_MAX_LEVERAGE')

    // F2 ★ 配置档：`EV_MAX_LEVERAGE` 顶到硬边界时这一档**被注销**（不可达）。
    //
    // 原断言是「止损 0.5% + 请求 50 倍 ⇒ 配置（3）不够要拒绝」。它的前提
    // （配置 < 硬边界）已被用户裁决「抬上限」取消 —— 现在 `EV_MAX_LEVERAGE=125`
    // 正好等于 `LEVERAGE_HARD_CEILING`，`applied` 的上界就是硬边界，
    // 而 `raw ≥ requested ≤ 硬边界` 必然成立 ⇒ 配置永远卡不住人。
    //
    // ★ 这不是删掉覆盖，而是把覆盖挪到**新的实际形状**上：现在还会发生的拒绝只剩几何一种，
    //   于是断言"扫遍所有倍数，拒绝原因里**只许**出现 LEVERAGE_GEOMETRY" ——
    //   它比原来那条更强：有人若在配置层重新引入一条与几何无关的拒绝，这里就会红。
    const sweptReasons = new Set<string>()
    let sweptRefusals = 0
    for (let L = 1; L <= LEVERAGE_HARD_CEILING; L += 1) {
      for (const s of [0.00001, 0.001, 0.01, 0.1]) {
        const v = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: L, stopLossPct: s })
        if (!v.ok) {
          sweptRefusals += 1
          sweptReasons.add((v.reason ?? '无原因码').split(' ')[0])
        }
      }
    }
    truthy('F2 扫描确实扫到过拒绝（反空转）', sweptRefusals > 0, '一条拒绝都没有 ⇒ 这条断言是空转的')
    eq(
      'F2 配置顶到硬边界后，拒绝只可能来自几何',
      [...sweptReasons].sort().join(','),
      'LEVERAGE_GEOMETRY',
      `实际出现过：${[...sweptReasons].join(' / ')}（MAX_LEVERAGE=${MAX_LEVERAGE}）`,
    )

    // F3 缺止损：几何容不下的倍数 + 没有任何止损
    const ns = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 125 })
    truthy('F3 高杠杆无止损要拒绝', !ns.ok, '')
    includes('F3 缺的是止损这件事要说出来', ns.speech, '而你没给止损')
    excludes('F3 不该扯到配置旋钮', ns.speech, 'EV_MAX_LEVERAGE')
    excludes('F3 不该扯到几何够不够', ns.speech, '几何上能用的是')

    // 两份说明两两不同 —— 合并成一句的实现会让这条红。
    truthy('F4 两份说明两两不同', geo.speech !== ns.speech, '两种成因必须给两种不同的下一步')
    pass(
      'F1-F4 拒绝两态互不顶替',
      `几何（收窄止损）/ 缺止损（给一条止损）各有专属下一步；第三个成因「配置」在 MAX_LEVERAGE=${MAX_LEVERAGE} 已被注销`,
    )
  }

  // ═══════════════ G · 边界 ═══════════════
  {
    const hard = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: LEVERAGE_HARD_CEILING + 50, stopLossPct: 0.001 })
    eq('G1 超硬顶的原因码', hard.reason?.startsWith('LEVERAGE_ABOVE_HARD_CEILING'), true)
    // ★ 负向断言选的是**另一个分支独有的动作词**，不是"硬顶"这种两边都会出现的词。
    includes('G1 说清这个上限调配置也没用', hard.speech, '写在代码里')

    const spot = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SPOT', requested: SPOT_MAX_LEVERAGE + 5 })
    eq('G2 现货超限的原因码', spot.reason?.startsWith('LEVERAGE_REQUIRES_SWAP'), true, '与 risk.ts 的 preTradeCheck 必须同一个原因码前缀')
    includes('G2 给出两个可选动作', spot.speech, '要么说「合约」')

    // 低杠杆：不强制止损（强制它只会把正常单变成来回追问）。
    // ★ 阈值不再是配置上限，而是**强平距离恰好装得下最窄止损**的那一档（≈40 倍）。
    //   旧断言拿「5 倍无止损必须拒绝」当反例，因为那时配置是 3；抬配置后 5 倍本来就该放行。
    //   那条反例**锚错了对象**：它声称测的是"裸奔安不安全"，却锚在"配置允许多高"上。
    const bareStopLev = Math.floor(leverageForLiquidationDistance(STOP_SAFETY_PCT_MIN))
    const lowNoStop = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 3 })
    truthy('G3 3 倍无止损可以放行', lowNoStop.ok, lowNoStop.reason ?? '')
    eq('G3 生效即所求', lowNoStop.effective, 3)
    // 反例成对：阈值两侧各断言一次，否则"永远放行"也能过。
    const atLev = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: bareStopLev })
    truthy(`G3 ${bareStopLev} 倍无止损（阈值内侧）放行`, atLev.ok, atLev.reason ?? '')
    const overLev = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: bareStopLev + 1 })
    truthy(`G3 ${bareStopLev + 1} 倍无止损（阈值外侧）必须拒绝`, !overLev.ok, '阈值两侧各断言一次')
    pass(
      'G1-G3 边界两侧各断言一次',
      `硬顶 ${LEVERAGE_HARD_CEILING} · 现货 ${SPOT_MAX_LEVERAGE} · 裸奔上限 ${bareStopLev}（由几何算出，不再取配置值）`,
    )
  }

  {
    // ★ 没听到倍数与"听到 1 倍"是两回事：前者是缺信息，后者是诉求。
    const silent = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP' })
    eq('G4 没听到倍数时 heard 为 false', silent.heard, false)
    truthy('G4 没听到倍数仍放行（按 1 倍并说明）', silent.ok, '')
    includes('G4 要把这个假设说出来', silent.speech, '没说几倍')
    const one = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 1 })
    eq('G4 说了 1 倍时 heard 为 true', one.heard, true)
    excludes('G4 说了 1 倍就不该再说"没说几倍"', one.speech, '没说几倍')
    pass('G4 「没说倍数」与「说了 1 倍」分得清', 'heard 标志把两者分开')
  }

  // ═══════════════ H · 不许静默降级 ═══════════════
  {
    // ★ 这一条是整份测试的落脚点：**只要用户报了倍数，就绝不出现
    //   "他以为按 N 倍、系统按 1 倍放行"** 这个组合。
    const cases: { text: string; lev: number }[] = [
      { text: '开 125 倍合约做多 BTC 10 美金，止损 1 成', lev: 125 },
      { text: '开 50 倍合约做空 ETH 20 美金，止损 0.5%', lev: 50 },
      { text: '开 12 倍合约做多 BTC 100 美金，止损 2%', lev: 12 },
    ]
    for (const c of cases) {
      const { slots } = slotsOf(c.text)
      eq(`H1 ${c.lev}x 被装上`, slots.leverage, c.lev)
      const rd = describeContractOrder(slots, MARK)
      const silentDowngrade = rd.ok && rd.leverage !== c.lev
      truthy(`H1 ${c.lev}x 不许静默降级`, !silentDowngrade, `放行了但生效杠杆是 ${rd.leverage} —— 这正是用户实测那次偏离的形态`)
      // 念回里必须还是用户说的那个数，否则他复核的是一句自己没说过的话。
      includes(`H1 ${c.lev}x 念回要说他说的那个数`, rd.echo, `${c.lev} 倍`)
    }
    pass('H1 报了倍数就绝不静默降级', '3 个不同倍数：与用户原话对得上，不 ok 就是明说做不到')
  }

  {
    // 每一条被拒的单都必须带**可核对的原因码**，否则账本里只剩"拒了"。
    const rd = describeContractOrder(slotsOf('开 125 倍合约做多 BTC 10 美金，止损 1 成').slots, MARK)
    truthy('H2 拒绝必须带原因码', !rd.ok && typeof rd.reason === 'string' && rd.reason.length > 0, '没有原因码 ⇒ 账本里查不出为什么被拒')
    truthy('H2 原因码不是中文句子', !/[\u4e00-\u9fa5]/.test(rd.reason ?? ''), `原因码是给机器核对的，实际是 ${rd.reason}`)
    pass('H2 拒绝留痕可核对', rd.reason!)
  }

  // ═══════════════ I · 纯函数：同输入同输出 ═══════════════
  {
    const a = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 3, stopLossPct: 0.02 })
    const b = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 3, stopLossPct: 0.02 })
    eq('I1 裁决是纯函数（确认与派单拿到的必须一样）', JSON.stringify(a), JSON.stringify(b), '两处各算一遍就成了"确认时说 3 倍、下单时下 1 倍"')
    pass('I1 裁决可复现', '同一输入两次结果逐字节相同')
  }

  {
    const t = parseInstType('永续合约') === 'SWAP' && parseInstType('买点现货') === 'SPOT'
    truthy('I2 形态识别只认成词', t, '')
    // ★ 负向断言：选的是**只有裸「期」才会误伤**的那个词。
    eq('I2 裸「期」不许被认成合约', parseInstType('预期三天内到 100U'), 'SPOT', '「预期」含「期」，认它等于把现货单变成杠杆单')
    eq('I2 杠杆要带单位', parseLeverage('买 10 个 xrp'), null, '裸 x 不是杠杆')
    pass('I2 形态/杠杆只认成词说法', '预期 ≠ 合约，xrp 的 x ≠ 杠杆')
  }

  // ═══════════════ J · 确认环节：他念自己说的那个数也要能过 ═══════════════
  //
  // ★ 判据 2 的正身：「会不会对**正确的**输入报错？」
  //   合约单里用户说的是保证金（10），系统量的是名义额（1250）。
  //   只认一个的实现会让规范操作（念 10）被拒 —— 那是检查器在误伤正确输入。
  {
    const { slots } = slotsOf('开 125 倍合约做多 BTC 10 美金，止损 1 成')
    resetSession()
    const p = createPending('place_order', '测试', slots, 1250, 1)
    eq('J1 复述值用保证金', p.expectedAmount, 10, '用户说的是 10，让他念 1250 是在让他念一句自己没说过的话')
    eq('J1 名义额作为备选值', p.expectedAmountAlt, 1250)
    eq('J1 单位标成保证金', p.amountBasis, 'margin')

    // 两个值都必须放行 —— 两侧各断言一次，只测一边会漏掉"备选值没接上"。
    const byMargin = confirmPending({ value: 10, basis: 'notional' })
    truthy('J2 念保证金放行', byMargin.ok, JSON.stringify(byMargin))
    const byNotional = confirmPending({ value: 1250, basis: 'notional' })
    truthy('J2 念名义额也放行', byNotional.ok, JSON.stringify(byNotional))
    // 反例成对：念一个无关的数必须拒。
    const wrong = confirmPending({ value: 99, basis: 'notional' })
    truthy('J2 念错必须拒', !wrong.ok, '两侧都放行时，必须确认"随便念什么都放行"不会也过')
    clearPending()

    // 现货单不受影响：只有一个复述值。
    const spot = slotsOf('买两百块钱的比特币').slots
    const ps = createPending('place_order', '测试', spot, 200, 1)
    eq('J3 现货单没有备选值', ps.expectedAmountAlt, undefined)
    eq('J3 现货复述值即名义额', ps.expectedAmount, 200)
    resetSession()
    pass('J1-J3 确认值按语义给', '合约给保证金+名义额两个，现货给一个')
  }

  // ═══════════════ K · ★★ 往返：系统自己念出来的数，照着做必须真的过得去 ═══════════════
  //
  // 这是 §3.48 新增的最强一条：**建议本身也是产出，也必须可证伪。**
  //   旧代码念的是 `1 / requested / LIQUIDATION_SAFETY_MULT`，漏掉维持保证金+费率，
  //   把「125 倍需要止损 ≤0.0667%」念成了 **0.533%**（差 8 倍）。
  //   用户照着那个数收窄止损**仍然下不去** —— 他永远不知道是建议错了，
  //   只会以为系统坏了，于是"无法完成下单任务"就一直存在。
  //   判据 A1 的另一面：一个**过不去**的建议，和一句误报一样费人。
  {
    const geo = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 125, stopLossPct: 0.01 })
    const m = /止损得收到 ([0-9.]+)% 以内/.exec(geo.speech)
    const advisedPct = m ? Number(m[1]) : Number.NaN
    truthy('K1 几何不够时必须给出一个可照做的止损上界', Number.isFinite(advisedPct), `念白里没有这个数：${geo.speech}`)
    const exactPct = stopPctBoundForLeverage(125) * 100
    truthy(
      'K1 建议值必须来自几何自己的反函数（不许手抄）',
      advisedPct <= exactPct && exactPct - advisedPct < 0.001,
      `精确上确界 ${exactPct}%，念出来的是 ${advisedPct}%`,
    )
    // ★★ 往返本身。
    // ★ 前提：这条断言只在配置允许 125 倍时才有意义（`.env` 的 EV_MAX_LEVERAGE=125）。
    //   若把它调回小值，会先红在下面这条**前提**上 —— 因为那时"收窄到 0.066%"
    //   照做仍会被配置档挡下：不是建议算错了，是更高的那一层不放行。
    //   把前提单独断言出来，是为了让那次失败**指名原因**，而不是让人去改建议公式。
    truthy(
      'K1 前提：配置要允许 125 倍（否则这条断言测的不是建议本身）',
      MAX_LEVERAGE >= 125,
      `MAX_LEVERAGE=${MAX_LEVERAGE}`,
    )
    const retry = judgeLeverage({
      entryPrice: MARK,
      side: 'long',
      instType: 'SWAP',
      requested: 125,
      stopLossPct: advisedPct / 100,
    })
    truthy('K1 ★ 照着自己念的数做必须真的过得去', retry.ok, `${advisedPct}% 喂回去仍被拒：${retry.reason}`)
    // 反空转：上取一位必须过不去 —— 否则"向下取整"那一步是白做的，
    //   而四舍五入恰恰会念出一个过不去的数（0.066667% → 0.067% ⇒ 只给 124.92 倍）。
    const roundedUp = judgeLeverage({
      entryPrice: MARK,
      side: 'long',
      instType: 'SWAP',
      requested: 125,
      stopLossPct: (advisedPct + 0.001) / 100,
    })
    truthy('K1 上取一位必须过不去（证明确实做了向下取整）', !roundedUp.ok, `${advisedPct + 0.001}% 也能过 ⇒ 取整那步没起作用`)
  }

  {
    const ns = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 125 })
    const m = /把倍数降到 ([0-9.]+) 以内/.exec(ns.speech)
    const advisedLev = m ? Number(m[1]) : Number.NaN
    truthy('K2 缺止损时必须给出一个可照做的倍数上界', Number.isFinite(advisedLev), `念白里没有这个数：${ns.speech}`)
    const exactLev = leverageForLiquidationDistance(STOP_SAFETY_PCT_MIN)
    truthy('K2 建议值必须来自几何自己的反函数', advisedLev <= exactLev, `几何上界 ${exactLev}，念出来的是 ${advisedLev}`)
    truthy(
      'K2 前提：配置要允许它建议的那个倍数',
      MAX_LEVERAGE >= advisedLev,
      `MAX_LEVERAGE=${MAX_LEVERAGE}，它建议降到 ${advisedLev}`,
    )
    truthy(
      'K2 ★ 照着自己念的倍数做必须真的过得去',
      judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: advisedLev }).ok,
      `${advisedLev} 倍无止损仍被拒`,
    )
    truthy(
      'K2 上抬一档必须过不去',
      !judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: advisedLev + 1 }).ok,
      `${advisedLev + 1} 倍也过了 ⇒ 那个上界说得太松`,
    )
    pass('K1-K2 ★ 建议本身也是产出，也必须可证伪', '系统念出的止损上界/倍数上界，照着做真的过得去')
  }

  // ═══════════════ L · 那句"止损在这之前触发"曾经是**无条件**印出来的 ═══════════════
  //
  // ★ 它在 MAX_LEVERAGE=3 时恰好成立，所以没人测到它其实**从没比对过强平距离**。
  //   止损一旦宽于强平距离，它就成了假话：3 倍 + 止损 50%，强平在 32.63%，
  //   价格走到 32.63% 就爆仓了，而念白说止损"能先跑掉"。
  {
    const wide = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 3, stopLossPct: 0.5 })
    truthy(
      'L1 止损宽于强平距离必须拒绝',
      !wide.ok,
      `3 倍 + 止损 50%：强平在 32.63%，止损永远等不到。实际念白：${wide.speech}`,
    )
    excludes('L1 不许印那句"会在它之前触发"', wide.speech, '会在它之前触发')
    // 配对：止损真的窄于强平距离时那句话必须**在**，否则靠"永远不说"也能过。
    const narrow = judgeLeverage({ entryPrice: MARK, side: 'long', instType: 'SWAP', requested: 3, stopLossPct: 0.02 })
    truthy('L1 配对：止损窄于强平距离时放行', narrow.ok, narrow.reason ?? '')
    includes('L1 配对：这时才该说出"会在它之前触发"', narrow.speech, '会在它之前触发')
    pass('L1 那句话必须先比对过强平距离才敢说', '宽止损被拒、窄止损才说；不再无条件印')
  }

  archive()
  console.log(`\nCONTRACT ORDER SMOKE PASSED · ${scenarios.length} 项全过`)
}

main()
