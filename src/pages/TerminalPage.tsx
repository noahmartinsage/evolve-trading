import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, pushToast, Order, MODE_META } from '../store/Store'
import { recordPrice, takeClosedBars, paperBroker, submitPaperLimit, cancelPaperOrder, collectPaperFillEvents } from '../trading/paperEngine'
import { fetchKlines, Candle } from '../data/market'
import { ageWords, type Sourced } from '../market/quoteSource'
import { byInternal, isDexRoutable, toExchange, toInternal } from '../market/registry.ts'
// ★ 桌宠排过来的那一次带**参数**（哪个标的、未来多久）—— 见 `src/ui/uiRequest.ts`。
import { takeUiRequest } from '../ui/uiRequest'
// ★ 「裁决过期了没有」的判据住在纯函数里（`src/trading/gateStale.ts`），本文件只负责呈现。
//   原因：这几行留在组件里时**没法被断言**，烟测只能去源码里找"那几个词出现过"，
//   而把产生它的那一行改掉、消费端两个字面量还在 ⇒ 断言照样绿（判据 36）。见 `_mutate_ui.mjs` M16。
import { deriveGateStale, gateStaleMessage } from '../trading/gateStale'
import { precheckOrder, getForecast, ForecastView, PrecheckResultView, PrecheckVerdictView } from '../orch/client'
import KpiRow, { KpiItem } from '../components/KpiRow'
import DexSwapPanel from '../components/DexSwapPanel'
import ForecastChart from '../components/ForecastChart'
import QuoteFlash from '../components/QuoteFlash'

/*
 * ★★ 这里原来有一个 `genCandles(price)` —— 真实 K 线拿不到时**合成 46 根随机 K 线**，
 *   而图上的来源标注写的仍然是「· Binance」。也就是说：网络抖一下、或者某个
 *   交易对拉不到，屏幕上就会出现一张**标注着 Binance 的假图**，且它看着完全正常。
 *
 *   这是本项目里最贵的一类缺陷（判据 17：这个输出把用户引向哪个动作 —— 它把用户
 *   引向"我看过行情了、可以下单了"）。已删除，改为**画不出来就说画不出来**。
 */

/** 价格是否可用。`null` 表示**没有真实报价**（不是 0，也不是占位）。 */
const hasQuote = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** 显示小数位 —— 只有注册表一个来源。查不到时用 2 位（宁可多显示，不可显示错）。 */
const decimalsFor = (symbol: string): number => byInternal(symbol)?.priceDecimals ?? 2


const VIEW_W = 560
const VIEW_H = 330
const PAD = { top: 12, bottom: 24, left: 52, right: 10 }
const PLOT_W = VIEW_W - PAD.left - PAD.right
const PLOT_H = VIEW_H - PAD.top - PAD.bottom - 40

function fmtP(p: number) {
  return p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 10 ? p.toFixed(2) : p.toFixed(4)
}

/**
 * 四态的中文标签与配色。
 *
 * ★ 四态不合并。`blocked`（改报价）与 `unverifiable`（修数据源）
 *   指向**相反的动作**，合成一个红色"失败"会把人引去做没用的事。
 */
const VERDICT_LABEL: Record<PrecheckVerdictView, string> = {
  pass: '✅ 放行',
  blocked: '⛔ 被闸门拒绝',
  approval_required: '🧑 需人工审批',
  unverifiable: '❓ 查不了（不放行）',
}
const VERDICT_CHIP: Record<PrecheckVerdictView, string> = {
  pass: 'chip-green',
  blocked: 'chip-red',
  approval_required: 'chip-amber',
  unverifiable: 'chip-gray',
}
/**
 * 预测层三态的中文名。
 *
 * ★ 三档**互不顶替**：`no-edge` 不是"看跌"，也不是"没数据" ——
 *   它说的是"这个预测器与一条平凡规则分不开"。三句话指向的动作完全不同
 *   （换方法 / 改方向 / 攒数据），所以界面上不许合并成一个"预测不可用"。
 */
const FORECAST_VERDICT_LABEL: Record<'actionable' | 'no-edge' | 'unverifiable', string> = {
  actionable: '有统计优势',
  'no-edge': '没有统计优势',
  unverifiable: '判不了（证据不够）',
}
/**
 * 预测三态的配色。
 *
 * ★ `no-edge` **不是**失败色：它说的是"算成功了，但这个预测器与一条平凡规则
 *   分不开" —— 是研究的结论，指向的动作是"别拿它下单"，不是"系统坏了"。
 *   涂成红色会让人去修一个没坏的东西。
 * ★ `unverifiable` 与闸门那边的 `unverifiable` **取同一个灰**：
 *   同一个词在同一个界面上不许有两种颜色（判据 21）。
 */
const FORECAST_VERDICT_CHIP: Record<'actionable' | 'no-edge' | 'unverifiable', string> = {
  actionable: 'chip-green',
  'no-edge': 'chip-amber',
  unverifiable: 'chip-gray',
}
/**
 * 走势预测可选的时间尺度（分钟）。
 *
 * ★ 只有三档，且**都是 15 的整数倍** —— 证据底座只有 15m 一档真实历史，
 *   报 5 分钟也会被服务端并到 15 分钟并标记 `rounded`。
 *   界面上直接不给这个选项，比给了之后悄悄改数更诚实。
 */
const FC_HORIZONS = [15, 60, 240] as const
/**
 * 档位加上**当前选中的那个值**（若它不在常驻三档里）。
 *
 * ★ 为什么必须这样：桌宠按服务端归一后的尺度排过来（比如「未来 30 分钟」），
 *   而常驻档位里没有 30 ⇒ 三个按钮全都不高亮，屏幕上唯一的读数只剩标题里那句
 *   "未来走势"。用户听到的是"未来 30 分钟"，屏幕上找不到任何一个 30 ——
 *   **两个口径的数放在一起看是没有意义的**（判据 31）。
 *   把当前值补进档位，比"悄悄改成 15 或 60"诚实：改数会让图和话对不上，
 *   而这里图上画的、嘴里念的、按钮上亮的仍然是同一个数。
 * ★ 排序是刻意的：临时档按大小插进去，读数从左到右仍然单调。
 */
function withCurrentHorizon(current: number): number[] {
  const s = new Set<number>(FC_HORIZONS)
  if (Number.isFinite(current) && current > 0) s.add(current)
  return [...s].sort((a, b) => a - b)
}
/**
 * 一次预检的**输入指纹**。
 *
 * ★ 为什么单独抽出来：它原先被抄了两遍 —— 一遍算 `orderKey`（判断裁决有没有过期）、
 *   一遍算 `setCheckedKey`（把这次预检记在哪个指纹下）。两处必须逐字同源，
 *   而"分成两份写"的结局是某次改动只改了其中一处：那时"过期判定"会变成
 *   永远为假（或永远为真），而界面上一切看着正常（判据 8）。
 *
 * ★ 只把**真的发给了服务端**的东西算进来：
 *   没勾「以走势预测为依据」时，服务端根本不算预测腿，
 *   于是改 `minutes` 不该让这条裁决过期 —— 那是对正确输入的误报（判据 2）。
 */
function precheckFingerprint(a: {
  symbol: string
  side: string
  orderType: string
  /**
   * 入场价。**`null` = 还没有价**；`'MARKET'` = 市价单（价格不由用户指定）。
   *
   * ★ 必须与 `0` 是不同的指纹。若把"没有价"退化成 0，两次不同原因的状态会算出
   *   同一个指纹 —— 一个"查不了"的裁决会被认成仍然有效（判据 24）。
   * ★ `'MARKET'` 也必须是常量：市价单的价是行情给的，把它写进指纹会让指纹
   *   **每 2 秒变一次**，裁决刚回来就被判"过期"（见 `pinned` 的注释）。
   */
  entryPrice: number | null | 'MARKET'
  tp: string
  sl: string
  notional: number
  claimsForecast: boolean
  horizonMinutes: number
}): string {
  return [
    a.symbol,
    a.side,
    a.orderType,
    a.entryPrice === null ? 'NO_PRICE' : a.entryPrice,
    a.tp,
    a.sl,
    a.notional,
    a.claimsForecast ? `F${a.horizonMinutes}` : '-',
  ].join('|')
}

/*
 * 漂移容差与漂移算法**不在这里**了 —— 搬进 `src/trading/gateStale.ts`。
 * 这里只留一句提醒：**别在本文件里再算一遍**（同一个事实两份口径 = 判据 8）。
 */

/** 面板边框配色：把"过期"也当一等状态，而不是靠文字提醒。 */
function gateTone(hasGate: boolean, verdict: PrecheckVerdictView | null, stale: boolean): string {
  if (!hasGate || verdict === null) return 'idle'
  if (stale) return 'stale'
  if (verdict === 'pass') return 'ok'
  if (verdict === 'unverifiable') return 'unknown'
  return 'bad'
}

function CandleChart({ candles, symbol, interval, change, price, sourceLabel }: { candles: Candle[]; symbol: string; interval: string; change: number | null; price: number; sourceLabel: string }) {
  const maxP = Math.max(...candles.map((c) => c.h)) * 1.002
  const minP = Math.min(...candles.map((c) => c.l)) * 0.998
  const range = maxP - minP || 1
  const y = (p: number) => PAD.top + (1 - (p - minP) / range) * PLOT_H
  const x = (i: number) => PAD.left + (i / candles.length) * PLOT_W + PLOT_W / candles.length / 2
  const cw = (PLOT_W / candles.length) * 0.62
  const maxVol = Math.max(...candles.map((c) => c.v), 0.001)
  const ma20 = useMemo(() => {
    const pts: { x: number; y: number }[] = []
    for (let i = 19; i < candles.length; i++) {
      const avg = candles.slice(i - 19, i + 1).reduce((s, c) => s + c.c, 0) / 20
      pts.push({ x: x(i), y: y(avg) })
    }
    return pts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles])

  const gridY = [0.25, 0.5, 0.75].map((r) => PAD.top + r * PLOT_H)
  const up = (change ?? 0) >= 0

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="chart-svg">
      {gridY.map((gy, i) => {
        const p = maxP - (range * (i + 1)) / 4
        return (
          <g key={i}>
            <line x1={PAD.left} y1={gy} x2={VIEW_W - PAD.right} y2={gy} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 6} y={gy + 3} textAnchor="end" fontSize="9" fontFamily="var(--font-mono)" fill="var(--text-weak)">{fmtP(p)}</text>
          </g>
        )
      })}
      {candles.map((c, i) => {
        const isUp = c.c >= c.o
        const color = isUp ? 'var(--up)' : 'var(--down)'
        const vy = y(c.h)
        const vh = y(c.l) - y(c.h)
        const cy = y(Math.max(c.o, c.c))
        const ch = Math.max(1.5, Math.abs(y(c.o) - y(c.c)))
        return (
          <g key={i}>
            <line x1={x(i)} y1={vy} x2={x(i)} y2={vy + vh} stroke={color} strokeWidth="1" />
            <rect x={x(i) - cw / 2} y={cy} width={cw} height={ch} fill={color} rx="1" />
            <rect x={x(i) - cw / 2} y={VIEW_H - PAD.bottom - 22 + (1 - c.v / maxVol) * 20} width={cw} height={(c.v / maxVol) * 20} fill={color} opacity="0.35" rx="1" />
          </g>
        )
      })}
      <polyline
        points={ma20.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--warning)"
        strokeWidth="1.4"
        strokeDasharray="3 3"
        opacity="0.9"
      />
      <text x={VIEW_W - PAD.right} y={PAD.top + 4} textAnchor="end" fontSize="10" fontFamily="var(--font-mono)" fill="var(--warning)">MA20</text>
      <line x1={PAD.left} y1={VIEW_H - PAD.bottom - 22} x2={VIEW_W - PAD.right} y2={VIEW_H - PAD.bottom - 22} stroke="var(--border)" strokeWidth="1" />
      <text x={PAD.left + 2} y={VIEW_H - 8} fontSize="9" fontFamily="var(--font-mono)" fill="var(--text-weak)">成交量</text>
      {/* 当前价标签 */}
      <g>
        <line x1={PAD.left} y1={y(price)} x2={VIEW_W - PAD.right} y2={y(price)} stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
        <rect x={VIEW_W - PAD.right - 74} y={y(price) - 9} width="72" height="16" rx="4" fill={up ? 'rgba(255,77,109,0.16)' : 'rgba(0,214,143,0.16)'} stroke={up ? 'rgba(255,77,109,0.4)' : 'rgba(0,214,143,0.4)'} />
        <text x={VIEW_W - PAD.right - 38} y={y(price) + 3} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fontWeight="700" fill={up ? 'var(--up)' : 'var(--down)'}>{fmtP(price)}</text>
      </g>
      {/*
        * ★ 来源标注**必须是调用方传进来的事实**，不能在这里写死 "Binance"。
        *   原来写死过，于是合成 K 线也被标注成 Binance（见文件头注释）。
        */}
      <text x={PAD.left + 2} y={PAD.top + 4} fontSize="10" fontFamily="var(--font-mono)" fill="var(--text-weak)">{symbol} · {interval} K线 · {sourceLabel}</text>
    </svg>
  )
}

type Tab = 'orders' | 'positions' | 'trades'

export default function TerminalPage() {
  const { state, dispatch } = useStore()
  const [tab, setTab] = useState<Tab>('orders')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [orderType, setOrderType] = useState<'limit' | 'market' | 'tpsl' | 'dex'>('limit')
  const [price, setPrice] = useState('')
  /**
   * 用户**是否亲手改过**价格框。
   *
   * ★ 有它才能安全地让价格框跟随实时价：没碰过就跟着走，碰过就再也不动它。
   *   原实现是"只在切换标的时赋值一次"，于是源码里那个占位价（ETH-USDC 3724.5，
   *   市价 2701）被**冻结**在屏幕上，而它看起来就是当前价（判据 17）。
   */
  const [priceTouched, setPriceTouched] = useState(false)
  const [qty, setQty] = useState('')
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  const [err, setErr] = useState('')

  /**
   * K 线数据的**来源状态**。有它才能诚实地标注图上的来源。
   * ★ 三态而非两态：`loading` / `ok` / `err`。两态（有/无）会把
   *   "还没回来"和"取不到"混成一件事，而它们该说的话不一样（判据 13）。
   */
  const [klineState, setKlineState] = useState<'loading' | 'ok' | 'err'>('loading')
  /**
   * 这批 K 线的**来源凭据**（谁给的 + 什么时候给的）。
   *
   * ★ 它是图上那行来源字的**唯一出处** —— 视图不许自己拼一个品牌名。
   *   原先 `sourceLabel` 是调用点写死的 `'Binance'`，
   *   于是"回退到第二个源"之后屏幕上照样写 Binance：凭据与被证明的事不是同一件。
   */
  const [klineSrc, setKlineSrc] = useState<Sourced<Candle[]> | null>(null)
  /** 全部来源都失败时的**逐条**原因（"都挂了"要能说清是哪些、各自为什么）。 */
  const [klineErr, setKlineErr] = useState('')

  // 执行前置检查（交易闸门）状态
  const [gate, setGate] = useState<PrecheckResultView | null>(null)
  const [gateErr, setGateErr] = useState('')
  const [gateBusy, setGateBusy] = useState(false)
  /** 上一次预检**用的那组参数**的指纹 —— 与当前参数不一致 ⇒ 裁决已过期。 */
  const [checkedKey, setCheckedKey] = useState('')
  /**
   * 上一次预检时**钉住的报价**。
   *
   * ★★ 为什么必须有它：市价模式下 `entryPrice = pair.price`，而报价每 2 秒
   *   跳一次 ⇒ 指纹每 2 秒变一次 ⇒ 裁决**刚回来就过期**，提交按钮一直是灰的。
   *   那条"已过期"的提示写着"下单参数已改动"，可用户一个参数都没动过 ——
   *   它把用户引向一个不存在的动作（判据 17）。
   *
   * ★ 钉住之后，"参数改了"与"行情跑了"变成**两件能分开说的事**：
   *   前者是用户干的，后者是市场干的，而它们该触发的是同一个拦截、不同的解释。
   */
  const [pinned, setPinned] = useState<{ price: number; at: number } | null>(null)

  /**
   * 这笔单是否**声称以走势预测为依据**。
   *
   * ★ 默认 `false`（不声称）：绝大多数单不来自预测层。
   *   勾上它的意思是"我这一单是**因为**预测这么说才下的"，
   *   于是闸门会去核这句话 —— 没有统计优势就当场拒。
   *
   * ★ 它只把这个布尔发给服务端，**不把预测结论发过去**：结论由服务端现算。
   *   允许前端上传结论，等于把"依据"交给被审的那一方自己开。
   */
  const [useForecast, setUseForecast] = useState(false)

  /**
   * ── 走势预测（`GET /forecast`）──────────────────────────────────────
   *
   * ★ 这里有一条**只有这个控件**的纪律：`fcMinutes` 是"未来多久"的**唯一出处**。
   *   它同时喂给上面那张图与下面的预检（`forecastHorizonMinutes`）。
   *   若两边各用各的默认值，屏幕上会同时出现两个"未来多久"的数，而
   *   两个口径不同的数放在一起看是没有意义的（判据 31）。
   */
  const [fc, setFc] = useState<ForecastView | null>(null)
  const [fcErr, setFcErr] = useState('')
  const [fcBusy, setFcBusy] = useState(false)
  const [fcMinutes, setFcMinutes] = useState(60)

  const pair = state.pairs.find((p) => p.symbol === state.selectedPair)!
  /**
   * 小数位**来自注册表**，不再在这里写三元表达式。
   * ★ 原来这里有一份、`Store.tsx` 的 TICK 分支里还有一份，两份各自维护：
   *   同一个事实两个主人，改一处不会让另一处报错（判据 8）。
   * ★ 口径也统一了：`priceDecimals` = 交易所 tick 的位数。原来 BTC 取 0 位，
   *   于是限价单**根本写不出 83942.62 这个价**——不是不够精致，是写不出合法报价。
   */
  const decimals = byInternal(pair.symbol)?.priceDecimals ?? 2
  const qtyDecimals = byInternal(pair.symbol)?.qtyDecimals ?? 4
  /** 本标的的链上可路由性也来自注册表（`dex` 腿只在 USDC 一侧为真）。 */
  const dexRoutable = isDexRoutable(pair.symbol)
  const [tf, setTf] = useState('1m')
  const livePrice = pair.price !== null && pair.price > 0 ? pair.price : null

  useEffect(() => {
    // ★ 切换标的：清掉一切"上一个标的留下的东西"。
    //   价格框清空而不是填一个占位价 —— 填了它就等于在屏幕上造一个假报价。
    setPrice('')
    setPriceTouched(false)
    setPinned(null)
    setKlineState('loading')
    // ★ 止盈/止损默认值**不在这里编** —— 它们来自引擎的止损几何
    //   （`/orders/precheck` 返回的 `suggested`，由 `computeStopGeometry` 产出）。
    //   原实现写的是 `price * 1.03` / `price * 0.97`，而引擎按 ATR 算出来的可能是 1.9%：
    //   **同一个事实的两份口径**，且两边都在"正常工作"，于是没人会发现它们不一致。
    //   先清空，等第一次预检回来由 `applySuggested` 填。
    setTp('')
    setSl('')
    setGate(null)
    setCheckedKey('')
    // ★ 走势图也要跟着清掉：它是**上一个标的**的图。
    //   留着它比留着旧裁决更危险 —— 旧裁决至少还带着"已过期"的标记，
    //   而一张图没有任何内在标记证明它画的是哪个标的（判据 11 的静默陈旧）。
    setFc(null)
    setFcErr('')
    // ★ 依赖只写 `pair.symbol` 是**有意的**：这一段的每一句都是"清掉上一个标的的残留"，
    //   要的语义就是"标的变了才跑"。把 setter 之外的依赖补全（如 `pair.price`）
    //   反而会让它每次行情跳动都清一遍，把用户的填单清空。
    //   （原来这里挂着一句 eslint-disable，而规则其实已经不报它了 —— 已删。）
  }, [pair.symbol])

  /**
   * 价格框**跟随实时价**，直到用户亲手改过它。
   *
   * ★ 只在 `!priceTouched` 时写：手填过的价格永不被覆盖（那是用户的意图，不是缓存）。
   * ★ 拿不到报价时**清空**而不是留着上一个数：留着上一个数就是"看着正常的旧报价"，
   *   而它离"当前价"可能已经差了几十个百分点。
   */
  /* 价格框跟随实时价，直到用户亲手改过它（见上面的注释）。 */
  useEffect(() => {
    if (priceTouched) return
    setPrice(livePrice === null ? '' : livePrice.toFixed(decimals))
  }, [livePrice, decimals, priceTouched])

  // ── 执行前置检查（交易闸门）───────────────────────────────────────────
  //
  // ★ 大厅原先**一道闸门都不过**：自治循环过 9 道，人手点的单直接进纸面撮合。
  //   同一个业务动作两条路径，而人那条从来没有任何测试覆盖 —— 判据 8 的典型形态。
  //   现在下单前先问一次引擎，它跑的是**同一条** `runPipeline`。
  const binanceSymbol = toExchange(pair.symbol)
  /** 限价单的价格 —— 用户填的那个；市价单没有"用户指定的价"。 */
  const limitPrice = Number.isFinite(parseFloat(price)) && parseFloat(price) > 0 ? parseFloat(price) : null
  /**
   * 报给引擎的入场价。市价单用**当前行情价**（用户没有别的选择）。
   *
   * ★★ 它**不读** `pinned` —— 这是刻意的。原先写成 `pinned?.price ?? livePrice`，
   *   于是它既是 `runPrecheck` 的依赖、又被 `runPrecheck` 反过来写（`setPinned`），
   *   形成一个**环**：回调依赖一个自己会改的值。React 编译器直接判定
   *   「This dependency may be modified later」并放弃优化整个组件（lint 报 10 条错）。
   *   环本身也是真问题，不只是 lint：它意味着"这次检查用的价"与"下次渲染看到的价"
   *   是同一个变量，两者永远对不上。⇒ 拆成两件事：**报给引擎的价**（本变量）与
   *   **引擎实际用的价**（`pinned`，只由回调写、只被漂移判定读，单向）。
   */
  const entryForOrder = orderType === 'market' ? livePrice : limitPrice
  const notionalUsdt = (entryForOrder ?? 0) * parseFloat(qty || '0')

  /**
   * 本次下单参数的指纹。
   *
   * ★ 必须有它：预检通过之后用户改一个数字，那条绿色裁决就变成了
   *   **关于另一笔单的结论**。继续拿它放行，等于用一个过期结论给一笔
   *   从没检查过的单背书 —— 而界面上看起来它检查过了。
   */
  const orderKey = precheckFingerprint({
    symbol: binanceSymbol,
    side,
    orderType,
    // ★ 市价单写常量 'MARKET'：它的价不是用户的输入，行情一跳就"被改动"是假红。
    entryPrice: orderType === 'market' ? 'MARKET' : entryForOrder,
    tp,
    sl,
    notional: notionalUsdt,
    claimsForecast: useForecast,
    horizonMinutes: fcMinutes,
  })
  /**
   * 裁决是不是**过期**了 —— 而且是**哪一种**过期。
   *
   * ★★ 必须把两种原因分开说，它们是两个人干的：
   *   · `params`：用户改了输入（改数量/改价/换边）⇒ 裁决说的是另一笔单，得重算。
   *   · `quote` ：用户什么都没动，**市场跑了** ⇒ 裁决对那笔单仍然成立，
   *     但"按当前市价成交会怎样"已经变了。这两种都该拦，可用户要做的事不同。
   *   只报一种（原来的实现只报 `params`），于是报价一跳，界面上会写
   *   「下单参数已改动」——用户看着自己没动过的屏幕不知道改了什么（判据 17）。
   */
  /*
   * ★ 过期判据来自纯函数（一处定义、可以逐条断言），本文件不再自己拼这几个布尔。
   *   `pinned` 是**引擎**报的价，`livePrice` 是**注册表 + 行情流**给的价 ——
   *   两者同源，所以减出来的漂移才有意义（判据 21：两个数同口径才能相减）。
   */
  const {
    // ★ 不吃 `paramsStale` / `quoteStale` 两个中间布尔：本文件只用"过没过期"与"是哪一种"
    //   （多留一个没人读的字段，下一个人会以为它被用在了某处）。
    gateStale,
    reason: staleReason,
    driftBps: quoteDriftBps,
  } = deriveGateStale({
    hasVerdict: gate !== null,
    paramsChanged: checkedKey !== orderKey,
    pinnedPrice: pinned?.price ?? null,
    livePrice,
  })
  /*
   * ★ 过期提示的那句话**只算一次**：面板里那一行、提交被拦时的报错，都用这一个变量。
   *   为什么强调"只算一次"：只要 `gateStaleMessage(...)` 有**两个调用点**，烟测里
   *   "源码里有没有调用它"就会被另一个调用点顶替 —— 删掉界面那一处，断言照样绿
   *   （`_mutate_ui.mjs` 的 M16e 实测抓到了这一点）。
   *   文本断言分不清"两个调用点里究竟哪一个坏了"，所以正解是**让它只有一个**。
   */
  const staleMsg = gateStaleMessage(staleReason, quoteDriftBps)
  /**
   * 能不能提交。
   * ★ 三个条件缺一不可：有裁决、裁决说 pass、裁决**没有过期**。
   *   漏掉第三个就等于"改完参数照样能拿旧绿放行"。
   */
  const gateReady = gate !== null && gate.submitAllowed && !gateStale
  const canSubmit = orderType === 'dex' ? true : gateReady

  const runPrecheck = useCallback(async () => {
    /*
     * ★ 这里**必须说出来**，不能 `return` 了事。
     *
     * 原先是一句 `if (!binanceSymbol) return` —— 按下去什么都不发生：
     * 不进"检查中"、不出裁决、不报错。用户看到的是"按钮没反应"，
     * 于是会再按一次、再按一次。
     *
     * 而它**摸不到**只是因为眼下 `pairs` 的 5 个交易对恰好都在 `SYMBOL_MAP` 里。
     * 这两份名单是**各自维护**的（一份在 Store、一份在 data/market），
     * 将来加一个交易对就会让这颗按钮静默哑掉 —— 判据 18：
     * 「完全没读懂时输出长什么样」，哑的失败必须另造观测点，不能靠"碰不到"来免责。
     */
    if (!binanceSymbol) {
      setGate(null)
      setCheckedKey('')
      setGateErr(`这个交易对没有对应的行情标的（注册表里没有 ${pair.symbol}），没法问引擎`)
      return
    }
    if (entryForOrder === null) {
      setGate(null)
      setCheckedKey('')
      setPinned(null)
      setGateErr(
        orderType === 'market'
          ? '这个交易对还没有真实报价 —— 市价单没法在不知道价的情况下提交'
          : '请先填写一个价格（可以点「市场价」跟着行情走）',
      )
      return
    }
    setGateBusy(true)
    setGateErr('')
    try {
      const r = await precheckOrder(state.orchUrl, {
        symbol: binanceSymbol,
        side,
        notionalUsdt,
        entry: entryForOrder,
        takeProfit: parseFloat(tp || '0'),
        stopLoss: parseFloat(sl || '0'),
        channel: 'cex',
        /*
         * ★★ 这里**不再上传本机看到的标记价**。
         *
         *   原先传的是 `markPrice: pair.price` —— 于是**浏览器决定引擎用什么价**。
         *   而引擎的成本模型、ATR、止损几何全部来自它自己的行情源：
         *   一旦浏览器那个数错了（本轮刚修掉的那几处编造价就是错的），
         *   闸门会拿一个错的价去除一个对的成本，"成本占比"这个结论就跟着错，
         *   而它看起来完全正常（判据 21 的同族：两个数来自不同的源不可相减）。
         *   ⇒ 报价由引擎自己取，取到什么会在 `assumptions` 里写明；
         *     界面把引擎用的那个价**显示出来**，于是两边的口径对得上。
         */
        // ★ 只发"是否以预测为依据"这一个布尔，结论由服务端现算。
        forecastClaims: useForecast,
        // ★ 与上面那张走势图**读同一个控件**（`fcMinutes`）：
        //   两个"未来多久"的口径放在同一屏上是没法看的（判据 31）。
        forecastHorizonMinutes: fcMinutes,
      })
      setGate(r)
      /*
       * ★ 钉住的是**引擎实际用的那个价**，不是本机看到的价。
       *   漂移判定要回答的是"引擎那套数还成不成立"，所以基准必须是引擎的报价；
       *   拿本机的价当基准，等于用另一杆秤去校准这一杆（判据 21）。
       */
      setPinned(hasQuote(r.market?.price) ? { price: r.market.price, at: Date.now() } : null)
      setCheckedKey(
        precheckFingerprint({
          symbol: binanceSymbol,
          side,
          orderType,
          entryPrice: orderType === 'market' ? 'MARKET' : entryForOrder,
          tp,
          sl,
          notional: notionalUsdt,
          claimsForecast: useForecast,
          horizonMinutes: fcMinutes,
        }),
      )
      // 引擎给的建议价：只在**用户还没填**的时候补上，绝不覆盖手填的值。
      if (r.suggested) {
        if (!tp.trim()) setTp(r.suggested.takeProfit.toFixed(decimals))
        if (!sl.trim()) setSl(r.suggested.stopLoss.toFixed(decimals))
      }
    } catch (e) {
      // 问不到引擎 ≠ 这笔单有问题。分开说，否则「引擎挂了」会被读成「我的单被拒了」。
      setGate(null)
      setCheckedKey('')
      setPinned(null)
      setGateErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGateBusy(false)
    }
  }, [state.orchUrl, binanceSymbol, pair.symbol, side, orderType, notionalUsdt, entryForOrder, tp, sl, decimals, useForecast, fcMinutes])

  // ── 走势预测（只读）───────────────────────────────────────────────────
  //
  // ★ 它**不是**第二条下单路径：这里只画图，不下单、不写台账。
  //   真正决定一笔单能不能出去的是 `runPrecheck` 那条同一条管线（判据 8）。
  //   这张图与那条腿读**同一个** `fcMinutes`，所以屏幕上不会有两个"未来多久"。
  /**
   * 算一次预测。
   *
   * ★ `override` 只有**桌宠那一次**会传：它嘴里念的是 BTC / 60 分钟，
   *   所以图上必须画 BTC / 60 分钟。没有它的话，界面会用自己的当前选择去算 ——
   *   于是屏幕上同时出现两个口径不同的数（嘴里那个与图上那个），
   *   而两个各自都算得对（判据 31）。
   * ★ 参数由**服务端**校验并归一过（`server/uiActions.ts` 的 `normalizePayload`），
   *   这里只做最后一层防御：注册表里查不到的标的一律拒绝，不带着它去请求。
   */
  const runForecast = useCallback(
    async (override?: { symbol: string; minutes: number }) => {
      const symbol = override?.symbol ?? binanceSymbol
      const minutes = override?.minutes ?? fcMinutes
      if (!symbol) {
        // ★ 哑失败必须显形（判据 18）：原先这类分支若直接 return，
        //   用户看到的是"按钮没反应"，然后会一直按。
        setFc(null)
        setFcErr(`这个交易对没有对应的行情标的（注册表里没有 ${pair.symbol}），没法算走势`)
        return
      }
      if (override && !byInternal(toInternal(symbol))) {
        setFc(null)
        setFcErr(`桌宠要算的是 ${symbol}，但行情注册表里没有它 —— 我不按一个查不到的标的出图`)
        return
      }
      setFcBusy(true)
      setFcErr('')
      try {
        const res = await getForecast(state.orchUrl, state.orchToken, { symbol, minutes })
        setFc(res.result)
      } catch (e) {
        // 算不出来 ≠ 没有优势。分开说，否则「服务没连上」会被读成「预测说别下单」。
        setFc(null)
        setFcErr(e instanceof Error ? e.message : String(e))
      } finally {
        setFcBusy(false)
      }
    },
    [state.orchUrl, state.orchToken, binanceSymbol, pair.symbol, fcMinutes],
  )

  /**
   * 按下「算一次」。
   *
   * ★ 人点与桌宠点**走同一个函数**（判据 8）—— 差别只有一个：
   *   桌宠那一下在队列里带了参数，参数经 `takeUiRequest` 取走（**取走即清空**，
   *   所以它只对这**一次**点击生效，绝不会留到下一次人手点击）。
   * ★ 参数带过来时必须**先把屏幕也切过去**（标的 + 尺度），否则图上是 A、
   *   按钮上亮的是 B，用户无法判断自己在看哪一个。
   */
  const pressForecast = useCallback(() => {
    const req = takeUiRequest('terminal.forecast.run')
    if (!req) {
      void runForecast()
      return
    }
    const symbol = String(req.symbol ?? '')
    const minutes = Number(req.minutes)
    const internal = toInternal(symbol)
    if (internal && byInternal(internal)) dispatch({ type: 'SET_PAIR', pair: internal })
    if (Number.isFinite(minutes) && minutes > 0) setFcMinutes(minutes)
    void runForecast({ symbol, minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : fcMinutes })
  }, [runForecast, fcMinutes, dispatch])

  // 防抖自动预检：参数一停就重问一次，让裁决始终对应当前参数。
  // 用 ref 持有最新实现，避免把 `runPrecheck` 放进依赖导致自己触发自己。
  const precheckRef = React.useRef(runPrecheck)
  useEffect(() => {
    precheckRef.current = runPrecheck
  }, [runPrecheck])
  useEffect(() => {
    if (orderType === 'dex') return
    if (!binanceSymbol || !(notionalUsdt > 0)) return
    const t = window.setTimeout(() => void precheckRef.current(), 700)
    return () => window.clearTimeout(t)
  }, [orderKey, orderType, binanceSymbol, notionalUsdt])


  // 真实 K 线：按交易对+周期拉取，每 30s 刷新一次
  useEffect(() => {
    let mounted = true
    const load = () =>
      fetchKlines(pair.symbol, tf, 60)
        .then((s) => {
          if (!mounted) return
          dispatch({ type: 'SET_KLINES', symbol: pair.symbol, interval: tf, candles: s.value })
          // ★ 来源凭据跟着数据一起存 —— 它**是**这批数据的属性，不是渲染时拼的字符串。
          setKlineSrc(s)
          setKlineErr('')
          setKlineState('ok')
        })
        .catch((e) => {
          /*
           * ★ 拉不到就**记下来**，不再吞掉。
           *   原实现是 `.catch(() => {})`，而渲染那边会用合成 K 线补上 ——
           *   于是"拉不到"这件事在屏幕上完全不可见，看到的是假图 + "· Binance"。
           *
           * ★ 失败时**故意不清空 `klineSrc`**：屏幕上那批图仍然来自某个真实来源，
           *   只是"这次没刷新成功"。清空它会让图上那行来源变成 `—`，
           *   而图还在画 —— 那比不画更糟（看的人会以为来源不明，其实是旧的）。
           */
          if (mounted) {
            setKlineErr(e instanceof Error ? e.message : String(e))
            setKlineState('err')
          }
        })
    load()
    const t = setInterval(load, 30000)
    return () => {
      mounted = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.symbol, tf])

  /**
   * 真实 K 线 + 当前价并入最后一根。
   *
   * ★ 合成 K 线（`genCandles`）已删除：真实数据拿不到时返回**空数组**，
   *   由渲染那边画一句"取不到"。宁可不画，也不画一张假的。
   */
  const candles = useMemo(() => {
    const key = `${pair.symbol}:${tf}`
    const real = state.klines[key]
    if (!real || real.length === 0) return []
    if (livePrice === null) return real
    const last = real[real.length - 1]
    const merged = { ...last, c: livePrice, h: Math.max(last.h, livePrice), l: Math.min(last.l, livePrice) }
    return [...real.slice(0, -1), merged]
  }, [state.klines, pair.symbol, tf, livePrice])

  // 纸面撮合：行情累积成 1 分钟合成 K 线 → PaperBroker（engine 撮合语义）→ 回填 reducer
  useEffect(() => {
    const t = setInterval(() => {
      // ★ 只喂**真实报价**：把 null 当 0 喂进去，撮合器会认为市价归零。
      state.pairs.forEach((p) => { if (hasQuote(p.price)) recordPrice(p.symbol, p.price) })
      for (const { symbol, candle } of takeClosedBars()) {
        paperBroker.onBar(symbol, candle)
      }
      for (const ev of collectPaperFillEvents()) {
        dispatch({ type: 'FILL_ORDER', id: ev.clientOrderId, filledQty: ev.fillQty, fillPrice: ev.fillPrice, fee: ev.fee })
        pushToast(dispatch, `⚡ 委托 ${ev.clientOrderId.slice(-4)} 成交 ${ev.fillQty} @ ${ev.fillPrice.toFixed(2)} · 费 ${ev.fee.toFixed(4)}`)
      }
    }, 2500)
    return () => clearInterval(t)
  }, [state.pairs, dispatch])

  /** 满仓数量。没有报价时是 `null` —— 不是 0（0 会被读成"买不了"，那是另一件事）。 */
  const maxBuyQty = livePrice === null ? null : state.balanceUSDC / livePrice
  const maxSellQty = state.positions.filter((p) => p.pair === pair.symbol && p.side === 'long').reduce((s, p) => s + p.qty, 0) || 10

  const setPct = (pct: number) => {
    const maxQ = side === 'buy' ? maxBuyQty : maxSellQty
    if (maxQ === null) return
    setQty((maxQ * pct).toFixed(qtyDecimals))
  }

  const mkId = (prefix: string) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  const submit = () => {
    const priceNum = parseFloat(price)
    const qtyNum = parseFloat(qty)
    // ★ 价格只在**限价**单里是必须的：市价单的价格由成交时决定。
    //   原来无条件要求价格，于是市价模式下价格框一旦是空的（没有报价时）就无法提交，
    //   而提示是"请输入有效价格"—— 那把它说成了一处填写错误（判据 17）。
    if (orderType === 'limit' && (!priceNum || priceNum <= 0)) { setErr('请输入有效价格'); return }
    if (!qtyNum || qtyNum <= 0) { setErr('请输入有效数量'); return }
    if (orderType !== 'limit' && livePrice === null) { setErr('没有真实报价，无法按市价下单 —— 等行情接入或改用限价单'); return }
    setErr('')
    // ★ 闸门：预检没过、或裁决已过期，就不许提交。
    //   这一句是"闸门真的生效"与"闸门是个装饰"的分界线。
    //   只在客户端拦是**有意为之**：纸面撮合本身就跑在浏览器内存里（`paperEngine`），
    //   所以这道门装在动作真正发生的那一层；实盘那条路由服务端的
    //   `pipelineService.authorizeLive` 拦，两边各拦自己的执行点。
    if (!canSubmit) {
      // ★ "哪种原因说哪句话"只有 `gateStaleMessage` 一个出处；面板上那行用的是**同一个变量**。
      //   这里原先自己又写了一遍两段三元，于是"该说哪句"有了两个主人（判据 29），
      //   而烟测去源码里找那几个词时被**这一处**顶替掉了（判据 36，见 `_mutate_ui.mjs` M16d）。
      setErr(
        staleMsg ?? (gate === null ? '大厅不接未经闸门的单：正在等引擎预检，或点击「重新检查」' : gate.summary),
      )
      return
    }
    if (orderType === 'market') {
      if (livePrice === null) return
      const ord: Order = { id: mkId('M'), pair: pair.symbol, side, type: 'market', price: livePrice, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
      dispatch({ type: 'PLACE_ORDER', order: ord })
      pushToast(dispatch, `✅ 市价${side === 'buy' ? '买入' : '卖出'}成交 ${qtyNum} ${pair.symbol} @ ${livePrice}`)
      return
    }
    if (orderType === 'limit') {
      const ord: Order = { id: mkId('L'), pair: pair.symbol, side, type: 'limit', price: priceNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
      submitPaperLimit(ord)
      dispatch({ type: 'PLACE_ORDER', order: ord })
      pushToast(dispatch, `📌 限价${side === 'buy' ? '买入' : '卖出'}已挂单并进入纸面撮合 · ${qtyNum} @ ${priceNum}`)
      return
    }
    const tpNum = parseFloat(tp)
    const slNum = parseFloat(sl)
    if (!tpNum || !slNum) { setErr('请输入止盈/止损价'); return }
    if (livePrice === null) { setErr('没有真实报价，开仓价无法确定'); return }
    const exitSide = side === 'buy' ? 'sell' : 'buy'
    const entry: Order = { id: mkId('E'), pair: pair.symbol, side, type: 'market', price: livePrice, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    const tpOrder: Order = { id: mkId('T'), pair: pair.symbol, side: exitSide, type: 'limit', tag: 'tp', price: tpNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    const slOrder: Order = { id: mkId('S'), pair: pair.symbol, side: exitSide, type: 'limit', tag: 'sl', price: slNum, qty: qtyNum, filledQty: 0, status: 'open', timestamp: Date.now() }
    submitPaperLimit(tpOrder)
    submitPaperLimit(slOrder)
    dispatch({ type: 'PLACE_ORDER', order: entry })
    dispatch({ type: 'PLACE_ORDER', order: tpOrder })
    dispatch({ type: 'PLACE_ORDER', order: slOrder })
    pushToast(dispatch, `🎯 已开仓并挂止盈 ${tpNum} / 止损 ${slNum}（进入纸面撮合）`)
  }

  const closePosition = (sym: string, q: number, posSide: 'long' | 'short') => {
    const posPair = state.pairs.find((x) => x.symbol === sym)
    // ★ 没有报价就**不平仓**，并说出来。原实现 `fillPrice ? ... : return` 静默返回，
    //   按下去什么都不发生 —— 而"平不掉"和"按钮坏了"在屏幕上是一样的（判据 18）。
    //   拿 0 去平仓更糟：那会把持仓以白送的价格结掉。
    const fillPrice = hasQuote(posPair?.price) ? posPair.price : null
    if (fillPrice === null) {
      pushToast(dispatch, `⛔ ${sym} 当前没有真实报价，无法确定平仓成交价 —— 先等行情接入`)
      return
    }
    dispatch({
      type: 'PLACE_ORDER',
      order: { id: mkId('C'), pair: sym, side: posSide === 'long' ? 'sell' : 'buy', type: 'market', price: fillPrice, qty: q, filledQty: 0, status: 'open', timestamp: Date.now() },
    })
    pushToast(dispatch, `🔒 已市价平仓 ${q} ${sym} @ ${fillPrice}`)
  }

  const activeOrders = state.orders.filter((o) => o.status === 'open' || o.status === 'partial')
  const allOrders = state.orders.slice(0, 20)
  const filledCount = state.orders.filter((o) => o.status === 'filled').length
  const modeLabel = state.mode === 'sim' ? '模拟演示' : state.mode === 'paper' ? '纸交易' : '链上实盘'

  const kpis: KpiItem[] = [
    { label: '当前模式', value: modeLabel, valueColor: state.mode === 'live' ? 'var(--up)' : 'var(--text-main)', meta: MODE_META[state.mode].desc, metaColor: 'var(--warning)' },
    { label: '行情源', value: state.marketSource ?? '—', valueColor: state.marketSource === null ? 'var(--warning)' : 'var(--primary)', meta: state.marketSource === null ? '行情未接入 · 不编造价格' : '公开 REST + WS', metaColor: 'var(--text-sub)' },
    { label: '当前挂单', value: String(activeOrders.length), valueColor: 'var(--accent)', meta: '模拟账户内有效', metaColor: 'var(--text-sub)' },
    { label: '会话成交', value: String(filledCount), valueColor: 'var(--text-main)', meta: `委托累计 ${state.orders.length} 笔`, metaColor: 'var(--text-sub)' },
    { label: '持仓数', value: String(state.positions.length), valueColor: 'var(--text-main)', meta: '虚拟资金 · 刷新即清空', metaColor: 'var(--warning)' },
  ]

  return (
    <div className="content-area">
      <KpiRow items={kpis} height={96} />

      <div className="main-area terminal-main">
        {/* 交易对列表 */}
        <div className="pair-list">
          <div className="panel-head">
            <span className="panel-title">市场</span>
            <span className={`chip ${state.live ? 'chip-green' : 'chip-amber'}`}>
              <span className={`pulse-dot2 ${state.live ? 'live' : ''}`} style={{ color: state.live ? 'var(--down)' : 'var(--warning)', background: state.live ? 'var(--down)' : 'var(--warning)', width: 5, height: 5 }} />
              {/*
                * ★ 断线时说的是「行情未接入」而不是「模拟行情」。
                *   原实现断线后仍叫"模拟行情"，可它并不模拟 —— 它只是**停住不动**，
                *   而停住的报价看起来就是当前价（判据 11 的静默陈旧）。
                * ★ 现在这句话里的来源名也**读自数据**（`state.marketSource`）：
                *   回退到第二个源之后，写死的名字会指着一个不再供数的源。
                */}
              {state.marketSource ?? '行情未接入'}
            </span>
          </div>
          {state.pairs.map((p) => {
            // ★ 用局部常量而不是 `hasQuote(p.price)`：类型收窄只能跟着变量走，
            //   跟着函数调用走的话 TS 无法把 `p.price` 变窄（会报 possibly null）。
            const px = p.price
            const hasPx = px !== null && px > 0
            const up = (p.change24h ?? 0) >= 0
            return (
              <div key={p.id} className={`pair-row ${p.symbol === state.selectedPair ? 'on' : ''}`} onClick={() => { dispatch({ type: 'SET_PAIR', pair: p.symbol }); pushToast(dispatch, `已切换交易对 ${p.symbol}`) }}>
                <div className="pr-top">
                  <span className="pr-sym">{p.symbol}</span>
                  {/*
                    * ★★ 没有报价就显示「—」。
                    *   这是本轮修的第一处缺陷：这里原来是 `p.price.toFixed(...)`，
                    *   而 `p.price` 的初值是源码里写死的占位价（BTC-USDC 114320，
                    *   当时市价 84001）。快照会刷新列表，所以列表**看起来是对的**，
                    *   但在快照回来之前它显示的是一个编造的行情（判据 17）。
                    */}
                  <QuoteFlash
                    className="pr-price"
                    value={hasPx ? px : null}
                    text={hasPx ? px.toFixed(decimalsFor(p.symbol)) : '—'}
                    style={{ color: hasPx ? (up ? 'var(--up)' : 'var(--down)') : 'var(--text-weak)' }}
                  />
                </div>
                <div className="pr-bot">
                  <span className={`chip ${!hasPx ? '' : up ? 'chip-red' : 'chip-green'}`}>
                    {p.change24h === null ? '—' : `${up ? '+' : ''}${p.change24h.toFixed(2)}%`}
                  </span>
                  <span className="pr-vol">{p.volume24h === null ? '24h —' : `24h $${p.volume24h >= 1000 ? (p.volume24h / 1000).toFixed(1) + 'B' : p.volume24h.toFixed(1) + 'M'}`}</span>
                </div>
              </div>
            )
          })}
          <style>{`
            .pair-list {
              width: 200px; flex-shrink: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 10px;
              display: flex; flex-direction: column; gap: 6px;
              overflow-y: auto;
            }
            .panel-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 4px; }
            .panel-title { font-family: var(--font-ui); font-size: 14px; font-weight: 600; color: var(--text-main); }
            .pair-row {
              padding: 8px 10px; border-radius: 8px;
              border: 1px solid transparent;
              cursor: pointer; transition: all 0.15s;
              display: flex; flex-direction: column; gap: 5px;
            }
            .pair-row:hover { background: rgba(255,255,255,0.03); }
            .pair-row.on { background: var(--primary-10); border-color: var(--primary-40); }
            .pr-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
            .pr-sym { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-main); }
            .pr-price { font-family: var(--font-mono); font-size: 12px; font-weight: 700; }
            .pr-bot { display: flex; align-items: center; justify-content: space-between; }
            .pr-vol { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); }
          `}</style>
        </div>

        {/* 中列：K 线 + 走势预测。
            外面必须套一层 .mid-col —— 否则这两张卡会被 .main-area 的 flex row
            排成左右两块，图表各自只剩一半宽。 */}
        <div className="mid-col">
          {/* K 线 */}
          <div className="chart-card">
            <div className="chart-card-head">
              <span className="panel-title">{pair.symbol} 行情</span>
              <span className="seg">
                {(['1m', '5m', '15m', '1h'] as const).map((iv) => (
                  <button key={iv} className={tf === iv ? 'on' : ''} onClick={() => setTf(iv)}>{iv}</button>
                ))}
              </span>
            </div>
            {/*
              * ★★ 画不出来就说画不出来。
              *   原来是 `candles` 一定非空（拉不到就用 `genCandles` 合成），
              *   于是屏幕上永远有一张图、且永远标着「· Binance」——
              *   真与假在界面上**没有任何区别**（判据 17 最贵的一种形态）。
              */}
            {candles.length > 0 && livePrice !== null ? (
              <>
                <CandleChart
                  candles={candles}
                  symbol={pair.symbol}
                  interval={tf}
                  change={pair.change24h}
                  price={livePrice}
                  // ★ 来源与年龄都**从数据里读**：`klineSrc` 是 `fetchKlines` 带回来的凭据。
                  //   这里不许出现任何品牌名字面量 —— 回退到第二个源时，
                  //   写死的名字会让屏幕撒谎，而撒的正是"这份数据是谁给的"。
                  sourceLabel={klineSrc === null ? '来源未知' : klineSrc.source + ' · ' + ageWords(klineSrc.atMs)}
                />
                {klineErr !== '' && klineSrc !== null && (
                  <div className="chart-warn">
                    ⚠ 这次没刷新成功（{klineErr}）—— 图上这批是 {ageWords(klineSrc.atMs)} 从「{klineSrc.source}」拿到的，
                    不是当前这一刻的。要按它下单请先确认价格。
                  </div>
                )}
              </>
            ) : (
              <div className="chart-empty">
                {klineState === 'loading'
                  ? '正在拉取真实 K 线…'
                  : klineState === 'err'
                    ? `${pair.symbol} 的 K 线取不到 —— ${klineErr || '所有来源都没答话'}。这里不会用合成数据顶替，所以暂时没有图`
                    : `${pair.symbol} 还没有真实报价，无法画图`}
              </div>
            )}
            <style>{`
              .chart-card {
                flex: 1; min-width: 0;
                background: var(--bg-card); border: 1px solid var(--border);
                border-radius: 10px; padding: 10px 12px;
                display: flex; flex-direction: column;
              }
              .chart-card-head { display: flex; align-items: center; justify-content: space-between; height: 30px; flex-shrink: 0; }
              .chart-card .chart-svg { flex: 1; width: 100%; min-height: 0; }
              /* 取不到 K 线时的占位：把"没有图"本身画成可见的东西，而不是留一片空白 */
              .chart-empty {
                flex: 1; display: flex; align-items: center; justify-content: center;
                text-align: center; padding: 0 24px;
                color: var(--text-weak); font-size: 12px; line-height: 1.7;
              }
              /* 图还在、但这一轮没刷新成功：**必须画出来**。
                 只把图上那行来源从"刚刚"改成"3 分钟前"是不够的 ——
                 看的人不会去读时间戳，而他会拿这个价去下单。 */
              .chart-warn {
                flex-shrink: 0; margin-top: 6px; padding: 5px 8px;
                border: 1px solid rgba(255,183,77,0.4); border-radius: 6px;
                background: rgba(255,183,77,0.10);
                color: var(--warning); font-size: 11px; line-height: 1.6;
              }
            `}</style>
          </div>

          {/* ── 走势预测：未来 N 分钟的价位分位带 ────────────────────────
              ★ 这张卡是**只读**的：它不参与下单，也不改任何状态。
                真正决定一笔单能不能出去的，是右边那张「执行前置检查」。
                两者读**同一个** `fcMinutes`，所以屏幕上不会出现两个"未来多久"。 */}
          <div className="fc-card">
            <div className="fc-head">
              <span className="panel-title">{pair.symbol} 未来走势</span>
              <span className="seg">
                {withCurrentHorizon(fcMinutes).map((m) => (
                  <button key={m} className={fcMinutes === m ? 'on' : ''} onClick={() => setFcMinutes(m)}>
                    {m < 60 ? `${m}分` : `${m / 60}小时`}
                  </button>
                ))}
              </span>
              <button
                className="gate-btn"
                data-ui="terminal.forecast.run"
                disabled={fcBusy}
                onClick={pressForecast}
              >
                {fcBusy ? '算中…' : fc === null ? '算一次' : '重新算'}
              </button>
            </div>

            {/* ★ 「算不出来」与「算出来但没有优势」是两件事：
                前者走 fcErr（没问到），后者走三态判决（问到了，答案是"没有"）。
                混成一句话，用户就不知道该去修服务还是该放弃这个信号（判据 25）。 */}
            {fcErr && (
              <div className="gate-err">⚠️ 算不出来：{fcErr} —— 这是"没问到"，不是"没有优势"</div>
            )}

            {fc === null && !fcErr && (
              <div className="gate-dim">
                按「算一次」：拿当前状态在历史上找相似时刻，看它们之后
                {fcMinutes < 60 ? `${fcMinutes} 分钟` : `${fcMinutes / 60} 小时`}的收益分布，
                再拿**样本外**的数据核对这个预测器准不准。只读 —— 不会下单、不改任何状态。
              </div>
            )}

            {fc !== null && (
              <>
                <div className="fc-body">
                  <ForecastChart
                    path={fc.path}
                    spot={fc.spot}
                    interval={fc.interval}
                    direction={fc.direction}
                    target={fc.target}
                    barMinutes={fc.barMinutes}
                    horizonBars={fc.horizonBars}
                    emptyNote={
                      `没给分位带：能用上的历史相似时刻只有 ${fc.sample.matched} 个（凑不出分布）。` +
                      '这不是"走势是平的"，是"这次算不出来"。'
                    }
                  />
                </div>

                <div className="fc-foot">
                  <div className="fc-verdict">
                    <span className={`chip ${FORECAST_VERDICT_CHIP[fc.outcome]}`}>
                      {FORECAST_VERDICT_LABEL[fc.outcome]}
                    </span>
                    <span className="fc-verdict-text">
                      {fc.outcome === 'unverifiable' ? (
                        <>证据不够，这次不给方向（不是"看平"）</>
                      ) : (
                        <>
                          {fc.direction === 'up' ? '方向偏上' : fc.direction === 'down' ? '方向偏下' : '方向不明'}
                          {fc.target !== null ? ` · 中位目标 ${fc.target.toFixed(2)}` : ''}
                          {fc.medianBps !== null ? ` · 中位幅度 ${fc.medianBps.toFixed(2)} bps` : ''}
                        </>
                      )}
                    </span>
                  </div>

                  {fc.calibration !== null && (
                    <div className="fc-meta">
                      样本外校验 锚点 <b>{fc.calibration.anchors}</b> · 命中{' '}
                      <b>
                        {fc.calibration.hits}/{fc.calibration.anchors - fc.calibration.flatAnchors}
                      </b>{' '}
                      = {(fc.calibration.hitRate * 100).toFixed(1)}% · 平凡规则{' '}
                      {(fc.calibration.baseRate * 100).toFixed(1)}%（{fc.calibration.baseRule}）· z=
                      {fc.calibration.edgeZ.toFixed(2)} · p={fc.calibration.pValue.toFixed(3)}
                    </div>
                  )}

                  {/*
                    ★ 毛边际与成本必须**并排**显示，且不许只显示净。
                      只给"净 0.3 bps"会让人以为信号很弱；给成
                      "毛 0.5 bps vs 往返成本 6.5 bps"才看得出真正的结论是
                      **信号是真的、被成本吃掉了**（判据 20）。
                  */}
                  <div className="fc-meta">
                    毛幅度 |{fc.medianBps === null ? 'n/a' : fc.medianBps.toFixed(2)}| bps vs 往返成本{' '}
                    <b>{fc.roundTripCostBps.toFixed(2)}</b> bps ⇒ 净{' '}
                    <b>{fc.netEdgeBps === null ? 'n/a' : fc.netEdgeBps.toFixed(2)}</b> bps
                  </div>

                  <div className="fc-meta">
                    数据 {fc.origin === 'history' ? '真实历史' : fc.origin} · {fc.barMinutes}m ×{' '}
                    {fc.horizonBars} 根 · 匹配 {fc.sample.matched}/{fc.sample.candidates} · 训练{' '}
                    {fc.sample.trainBars} 根
                    {/* ★ 缓存必须**可见**：读路径的缓存最容易变成静默陈旧（判据 11） */}
                    {fc.cache.hit
                      ? ` · 复用了 ${Math.max(0, Math.round((Date.now() - fc.cache.computedAt) / 60000))} 分钟前算好的同一份数据`
                      : ' · 刚算的'}
                    · {fc.elapsedMs}ms
                  </div>

                  {fc.reasons.length > 0 && (
                    <ul className="fc-reasons">
                      {fc.reasons.map((r, i) => (
                        <li key={`${r.from}-${i}`}>
                          <b>{r.from}</b>：{r.text}
                        </li>
                      ))}
                    </ul>
                  )}

                  {fc.disclosures.length > 0 && (
                    <div className="gate-note">这次预测覆盖不到：{fc.disclosures.join('；')}</div>
                  )}
                </div>
              </>
            )}

            <style>{`
              .mid-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
              .fc-card {
                flex-shrink: 0; height: 275px;
                background: var(--bg-card); border: 1px solid var(--border);
                border-radius: 10px; padding: 10px 12px;
                display: flex; flex-direction: column; gap: 8px;
              }
              .fc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 26px; flex-shrink: 0; }
              /*
               * ★★ 图必须有一个**不许被压缩**的高度。
               *   原来写的是「flex: 1; min-height: 0」，而卡里那几段长文案（样本外校验 /
               *   成本对比 / edgeZ / state / interval）把卡塞满，于是 flex 把图**压到了 5px**
               *   —— 实测 getBoundingClientRect().height === 5。
               *   屏幕上看着"有东西"，其实是周围那圈 HTML 文字刻度撑出来的观感
               *   （判据 17：它把用户引向"图出来了"这个错误结论）。
               *   ⇒ 高度写死 + flex-shrink: 0；长文案改为**卡内滚动**，
               *     而不是让它去挤图。
               *   ★ 这段注释里**不许出现反引号** —— 它住在内联 style 的模板串里，
               *     一个反引号就会把模板串提前闭合（本项目记过三次的坑，
               *     我这次当场又踩了一次：TSC 报 TS1005 才想起来）。
               */
              .fc-body { flex: 0 0 125px; height: 125px; min-height: 125px; }
              /*
               * ★ 长文案滚动，且**结论行留在可见区**：判决 / 中位目标 / 成本对比 / 数据来源
               *   恰好排在最前面（约 74px），依据清单在下面滚 —— 顺序就是"先给答案、再给依据"。
               */
              .fc-foot { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
              .fc-verdict { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
              .fc-verdict-text { font-family: var(--font-ui); font-size: 10px; color: var(--text-sub); }
              .fc-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); line-height: 1.5; }
              .fc-meta b { color: var(--text-sub); }
              .fc-reasons {
                list-style: none; margin: 0; padding: 0;
                display: flex; flex-direction: column; gap: 3px;
                max-height: 54px; overflow-y: auto;
              }
              .fc-reasons li { font-family: var(--font-ui); font-size: 9.5px; line-height: 1.5; color: var(--text-sub); }
              .fc-reasons li b { color: var(--primary); font-weight: 600; }
            `}</style>
          </div>
        </div>

        {/* 下单面板 */}
        <div className="order-panel">
          <div className="seg wide">
            <button className={`${side === 'buy' ? 'on-buy' : ''}`} data-ui="terminal.side.buy" onClick={() => { setSide('buy'); setErr('') }}>买入</button>
            <button className={`${side === 'sell' ? 'on-sell' : ''}`} data-ui="terminal.side.sell" onClick={() => { setSide('sell'); setErr('') }}>卖出</button>
          </div>

          <div className="seg wide">
            {(['limit', 'market', 'tpsl', 'dex'] as const).map((t) => (
              <button key={t} className={orderType === t ? 'on' : ''} onClick={() => setOrderType(t)}>
                {t === 'limit' ? '限价' : t === 'market' ? '市价' : t === 'tpsl' ? '止盈止损' : state.mode === 'live' ? 'DEX 链上' : 'DEX 链上🔒'}
              </button>
            ))}
          </div>

          {orderType === 'dex' ? (
            // ★ DEX 只有 USDC 腿可路由（注册表的 `dex` 位）。USDT 腿没有链上池子，
            //   点进去会得到一个"参考价"却没有可执行的路由 —— 那种半成品最难发现。
            dexRoutable && livePrice !== null ? (
              <DexSwapPanel symbol={pair.symbol} side={side} qty={qty} refPrice={livePrice} />
            ) : (
              <div className="op-err">
                {dexRoutable
                  ? `${pair.symbol} 还没有真实报价，链上兑换拿不到参考价`
                  : `${pair.symbol} 没有链上路由此交易对（链上池子计价的是 USDC）—— 请切到 USDC 那一侧或改用 CEX`}
              </div>
            )
          ) : (
            <>
              <div className="op-field">
                {/* ★ 计价币从注册表读，不再写死 "USDC" —— USDT 腿的价是 USDT 计的 */}
                <span className="op-label">价格 ({byInternal(pair.symbol)?.quote ?? '—'})</span>
                <div className="op-input-wrap">
                  <input
                    className="input"
                    value={price}
                    placeholder={livePrice === null ? '暂无报价' : undefined}
                    onChange={(e) => { setPrice(e.target.value); setPriceTouched(true) }}
                  />
                  {/*
                    * ★ 「市场价」把框**重新交还给实时价**（`priceTouched = false`），
                    *   而不是只写一次快照。原先写一次就再也不跟了 ——
                    *   于是它记下的是**点那一瞬间**的价，之后行情走了它还是那个数，
                    *   而界面上没有任何东西说明它已经过期（判据 11）。
                    */}
                  <span
                    className="op-suffix"
                    style={{ cursor: livePrice === null ? 'not-allowed' : 'pointer', opacity: livePrice === null ? 0.5 : 1 }}
                    onClick={() => { if (livePrice === null) return; setPriceTouched(false); setPrice(livePrice.toFixed(decimals)) }}
                  >市场价</span>
                </div>
              </div>

              {orderType === 'tpsl' && (
                <>
                  <div className="op-field">
                    <span className="op-label">止盈价</span>
                    <div className="op-input-wrap"><input className="input" value={tp} onChange={(e) => setTp(e.target.value)} /></div>
                  </div>
                  <div className="op-field">
                    <span className="op-label">止损价</span>
                    <div className="op-input-wrap"><input className="input" value={sl} onChange={(e) => setSl(e.target.value)} /></div>
                  </div>
                </>
              )}

              <div className="op-field">
                <span className="op-label">数量 ({pair.symbol.split('-')[0]})</span>
                <div className="op-input-wrap">
                  <input className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
                  <span className="op-suffix">可用 {side === 'buy' ? (state.balanceUSDC / 1e6).toFixed(2) + 'M' : maxSellQty.toFixed(2)}</span>
                </div>
              </div>

              <div className="op-pcts">
                {[0.25, 0.5, 0.75, 1].map((pct) => (
                  <button key={pct} className="pct-btn" onClick={() => setPct(pct)}>{pct * 100}%</button>
                ))}
              </div>

              {err && <div className="op-err">{err}</div>}

              <div className="op-est">
                <span>预估名义额</span>
                <span className="op-est-val">
                  {entryForOrder === null
                    ? '— （没有真实报价）'
                    : `$${(parseFloat(qty || '0') * entryForOrder).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                </span>
              </div>

              {/* ── 执行前置检查：这笔交易凭什么可以出去 ──────────────────
                  闸门不是装饰：下面的提交按钮由这里的裁决驱动。 */}
              {/* ★ 这一层**刻意不带 `data-ui`**：`data-ui` 在本项目里的语义是
                  "桌宠碰得到的那颗按钮"，注册表（`UI_ACTIONS`）只登记可点动作。
                  把展示容器也挂一个 id，等于在源码里谎报一颗不存在的按钮 ——
                  门禁 U05 会照着这个谎报去要求注册，而注册表里没有"面板"这种东西。
                  所以：容器不挂 id，里面的「立即检查」按钮才是动作。 */}
              <div className={`gate-card tone-${gateTone(gate !== null, gate?.verdict ?? null, gateStale)}`}>
                <div className="gate-head">
                  <span className="gate-title">执行前置检查</span>
                  <button
                    className="gate-btn"
                    data-ui="terminal.gate.precheck"
                    disabled={gateBusy}
                    onClick={() => void runPrecheck()}
                  >
                    {gateBusy ? '检查中…' : gate === null ? '立即检查' : '重新检查'}
                  </button>
                </div>

                {/*
                  ★ 这颗勾选框的作用是**让闸门有据可核**，不是装饰。
                    勾上 = "我这一单是因为走势预测这么说才下的"，于是闸门会去核：
                    预测有没有统计优势、方向是否一致、标的对不对。
                    不勾 = 预测不参与这笔决策 —— 闸门**不会**因此变绿，
                    它只是明说"预测没参与"（绿勾容易被误读成"预测也同意"）。
                */}
                <label className="gate-claim">
                  <input
                    type="checkbox"
                    data-ui="terminal.gate.forecast-claim"
                    checked={useForecast}
                    onChange={(e) => setUseForecast(e.target.checked)}
                  />
                  这笔单以走势预测为依据（勾上后闸门会核这句话是否成立）
                </label>

                {gateErr && <div className="gate-err">⚠️ 问不到引擎：{gateErr} —— 这不等于这笔单有问题</div>}

                {!gate && !gateErr && (
                  <div className="gate-dim">
                    下单前会先问引擎一次：九道拦截闸门 + 成本 + 组合敞口 + 审批。
                    填好数量就会自动检查。
                  </div>
                )}

                {gate && (
                  <>
                    <div className="gate-verdict">
                      <span className={`chip ${VERDICT_CHIP[gate.verdict]}`}>{VERDICT_LABEL[gate.verdict]}</span>
                    </div>
                    <div className="gate-sum">{gate.summary}</div>

                    {/*
                      * ★ 一句话，来自上面那个 `staleMsg` —— 与提交被拦时的提示**同一个值**。
                      *   原来这里分两个 JSX 分支、提交那边又各写一遍，同一件事的两个主人。
                      * ★ 文案里不许有 markdown 星号（本项目没有 markdown 渲染器，
                      *   星号会原样显示；这句话原来就是错的）。
                      */}
                    {staleMsg === null ? null : <div className="gate-stale">⚠️ {staleMsg}</div>}

                    <div className="gate-meta">
                      {/*
                        * ★ 把**引擎用的那个报价**显示出来。
                        *   界面上的价格是本机从 Binance 拉的，引擎有它自己的行情源；
                        *   两边的数若不写明，用户无法判断"这条裁决到底按哪个价算的"。
                        *   ⇒ 写明它，且标明来自引擎（判据 21：两个口径的数不能混着看）。
                        */}
                      引擎按 <b>{gate.market.price.toLocaleString('en-US', { maximumFractionDigits: 8 })}</b> 评估
                      {gate.market.stale ? '（该快照已陈旧）' : ''}
                      <br />
                      闸门 <b>{gate.pipeline.checked}/{gate.pipeline.total}</b>
                      {gate.geometry !== null && gate.pipeline.reachedGeometry
                        ? ` · R:R ${gate.geometry.rr.toFixed(2)}:1`
                        : ' · R:R 未走到'}
                      {gate.cost !== null
                        ? ` · 毛/成本 ${Number.isFinite(gate.cost.edgeMultiple) ? `${gate.cost.edgeMultiple.toFixed(1)}×` : '—'}`
                        : ' · 成本未评估'}
                      {gate.exposure.limitUsdt === null
                        ? ' · 敞口上限未设置'
                        : ` · 敞口 ${gate.exposure.grossAfterUsdt.toFixed(0)}/${gate.exposure.limitUsdt.toFixed(0)}`}
                      {gate.market.stale ? ' · 行情快照已陈旧' : ''}
                    </div>

                    {gate.blockers.length > 0 ? (
                      <ul className="gate-list">
                        {gate.blockers.map((b) => (
                          <li key={b.id} className="gate-item bad">
                            <b>{b.name}</b>：{b.detail}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="gate-dim">
                        {gate.pipeline.checked}/{gate.pipeline.total} 道闸门、成本、敞口、审批全部通过。
                      </div>
                    )}

                    {gate.assumptions.length > 0 && (
                      <div className="gate-note">口径说明（这些数是我替你补的）：{gate.assumptions.join('；')}</div>
                    )}
                    {/*
                      ★ 预测腿**必须单独显示**，不能只混在 blockers 列表里。
                        三种状态的界面含义完全不同（见 client.ts 的注释）：
                          claims=false  → 预测没参与（绿勾会被误读成"预测也同意"）
                          outcome=null  → 声称了但没评（取数失败）
                          有 outcome    → 预测真的参与了，这里显示它的判决与提案
                    */}
                    <div className="gate-note">
                      走势预测在这一笔里的角色：
                      {!gate.forecast.claims ? (
                        <span className="gate-dim"> 没有参与这笔决策（未勾选"以走势预测为依据"）</span>
                      ) : gate.forecast.outcome === null ? (
                        <span> 声称参与了，但没有评出结论 —— 按"查不了"处理</span>
                      ) : (
                        <span>
                          {' '}
                          判决 <b>{FORECAST_VERDICT_LABEL[gate.forecast.outcome]}</b>
                          {gate.forecast.gate ? `（卡在：${gate.forecast.gate}）` : ''}
                          {gate.forecast.direction
                            ? ` · 方向${gate.forecast.direction === 'up' ? '偏上' : '偏下'}`
                            : ''}
                          {gate.forecast.target !== null ? ` · 中位目标 ${gate.forecast.target.toFixed(2)}` : ''}
                          {gate.forecast.proposal && !gate.forecast.proposal.ok ? (
                            <div className="gate-dim">{gate.forecast.proposal.reason}</div>
                          ) : null}
                        </span>
                      )}
                    </div>
                    {gate.disclosures.length > 0 && (
                      <div className="gate-note">本次检查覆盖不到：{gate.disclosures.join('；')}</div>
                    )}
                  </>
                )}
              </div>

              <button
                className={`btn btn-lg ${side === 'buy' ? 'btn-buy' : 'btn-sell'} full`}
                data-ui="terminal.submit"
                disabled={!gateReady}
                onClick={submit}
              >
                {side === 'buy' ? '买入' : '卖出'} {pair.symbol.split('-')[0]}
                {orderType === 'limit' ? ' · 挂单' : orderType === 'tpsl' ? ' · 带止损开仓' : ' · 市价'}
                {!gateReady ? '（待闸门放行）' : ''}
              </button>

              <div className="op-bal">
                <span>可用余额（模拟账户）</span>
                <span>${state.balanceUSDC.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
              </div>
            </>
          )}

          <style>{`
            .order-panel {
              width: 330px; flex-shrink: 0;
              background: var(--bg-card); border: 1px solid var(--border);
              border-radius: 10px; padding: 12px;
              display: flex; flex-direction: column; gap: 9px;
              overflow-y: auto;
            }
            .seg.wide { width: 100%; }
            .seg.wide button { flex: 1; }
            .op-field { display: flex; flex-direction: column; gap: 4px; }
            .op-label { font-family: var(--font-ui); font-size: 10px; color: var(--text-weak); }
            .op-input-wrap { position: relative; }
            .op-input-wrap .input { padding-right: 62px; }
            .op-suffix {
              position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
              font-family: var(--font-mono); font-size: 9px; color: var(--primary);
            }
            .op-pcts { display: flex; gap: 6px; }
            .pct-btn {
              flex: 1; height: 24px;
              background: var(--bg-surface); border: 1px solid var(--border);
              border-radius: 6px; color: var(--text-sub);
              font-family: var(--font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s;
            }
            .pct-btn:hover { border-color: var(--primary-40); color: var(--primary); }
            .op-err { font-size: 11px; color: var(--up); }
            .op-est {
              display: flex; align-items: center; justify-content: space-between;
              font-family: var(--font-ui); font-size: 11px; color: var(--text-sub);
              padding: 6px 0; border-top: 1px dashed var(--border);
            }
            .op-est-val { font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
            /* 执行前置检查 —— 边框配色本身就是状态：过期与"查不了"各有一色，
               不能只靠一行小字提醒（那行字在滚动时最容易看不见）。 */
            .gate-card {
              display: flex; flex-direction: column; gap: 6px;
              border: 1px solid var(--border); border-radius: 8px;
              padding: 8px 9px; background: var(--bg-surface);
            }
            .gate-card.tone-ok      { border-color: rgba(0,214,143,0.45); }
            .gate-card.tone-bad     { border-color: rgba(255,77,109,0.45); }
            .gate-card.tone-amber,
            .gate-card.tone-stale   { border-color: rgba(255,183,77,0.5); }
            .gate-card.tone-unknown { border-color: rgba(150,150,150,0.5); }
            .gate-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .gate-title { font-family: var(--font-ui); font-size: 11px; font-weight: 700; color: var(--text-main); }
            .gate-btn {
              height: 20px; padding: 0 8px;
              background: var(--bg-elevated); border: 1px solid var(--border);
              border-radius: 5px; color: var(--text-sub);
              font-family: var(--font-ui); font-size: 10px; cursor: pointer; transition: all 0.15s;
            }
            .gate-btn:hover:not(:disabled) { border-color: var(--primary-40); color: var(--primary); }
            .gate-btn:disabled { opacity: 0.55; cursor: default; }
            .gate-verdict { display: flex; align-items: center; gap: 6px; }
            .gate-sum { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; color: var(--text-sub); }
            .gate-meta { font-family: var(--font-mono); font-size: 9px; color: var(--text-weak); line-height: 1.5; }
            .gate-meta b { color: var(--text-sub); }
            .gate-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
            .gate-item { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; }
            .gate-item.bad { color: var(--up); }
            .gate-item.bad b { color: var(--up); }
            .gate-dim { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; color: var(--text-weak); }
            .gate-note { font-family: var(--font-ui); font-size: 9px; line-height: 1.5; color: var(--text-weak); border-top: 1px dashed var(--border); padding-top: 5px; }
            .gate-err { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; color: var(--warning); }
            .gate-stale { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; color: var(--warning); }
            .btn.full { width: 100%; }
            .op-bal {
              display: flex; align-items: center; justify-content: space-between;
              font-family: var(--font-ui); font-size: 11px; color: var(--text-weak);
            }
            .op-bal span:last-child { font-family: var(--font-mono); color: var(--text-sub); }
          `}</style>
        </div>
      </div>

      {/* 底部：委托 / 持仓 / 成交 */}
      <div className="orders-card">
        <div className="tabs">
          <div className={`tab-item ${tab === 'orders' ? 'on' : ''}`} onClick={() => setTab('orders')}>当前委托 <span className="t-count">{activeOrders.length}</span></div>
          <div className={`tab-item ${tab === 'positions' ? 'on' : ''}`} onClick={() => setTab('positions')}>持仓 <span className="t-count">{state.positions.length}</span></div>
          <div className={`tab-item ${tab === 'trades' ? 'on' : ''}`} onClick={() => setTab('trades')}>成交记录</div>
        </div>

        <div className="orders-body">
          {tab === 'orders' && (
            <table className="tbl">
              <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>类型</th><th className="num">价格</th><th className="num">数量</th><th className="num">已成交</th><th>状态</th><th></th></tr></thead>
              <tbody>
                {allOrders.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无委托 · 在下单面板发起第一笔交易</td></tr>}
                {allOrders.map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                    <td className="strong">{o.pair}</td>
                    <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side === 'buy' ? '买入' : '卖出'}{o.tag === 'tp' ? ' ·TP' : o.tag === 'sl' ? ' ·SL' : ''}</td>
                    <td>{o.type === 'market' ? '市价' : '限价'}</td>
                    <td className="num">{o.price}</td>
                    <td className="num">{o.qty}</td>
                    <td className="num">{o.filledQty}</td>
                    <td>
                      {o.status === 'filled' ? <span className="chip chip-green">已成交</span>
                        : o.status === 'cancelled' ? <span className="chip chip-gray">已撤单</span>
                        : o.status === 'partial' ? <span className="chip chip-amber">部分成交</span>
                        : <span className="chip chip-cyan">挂单中</span>}
                    </td>
                    <td>
                      {(o.status === 'open' || o.status === 'partial') && (
                        <button className="btn btn-sm" onClick={() => { cancelPaperOrder(o.id); dispatch({ type: 'CANCEL_ORDER', id: o.id }); pushToast(dispatch, `🗑 已撤单 ${o.id.slice(-4)}`) }}>撤单</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'positions' && (
            <table className="tbl">
              <thead><tr><th>交易对</th><th>方向</th><th className="num">数量</th><th className="num">均价</th><th className="num">浮盈</th><th></th></tr></thead>
              <tbody>
                {state.positions.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无持仓</td></tr>}
                {state.positions.map((p, i) => (
                  <tr key={i}>
                    <td className="strong">{p.pair}</td>
                    <td className={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? '多仓' : '空仓'}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num">${p.avgPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                    <td className={`num ${p.pnl >= 0 ? 'up' : 'down'}`}>{p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString('en-US')}</td>
                    <td><button className={`btn btn-sm ${p.side === 'long' ? 'btn-sell' : 'btn-buy'}`} onClick={() => closePosition(p.pair, p.qty, p.side)}>平仓</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'trades' && (
            <table className="tbl">
              <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th className="num">价格</th><th className="num">数量</th><th className="num">金额</th></tr></thead>
              <tbody>
                {state.trades.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-weak)', height: 64 }}>暂无成交</td></tr>}
                {state.trades.slice(0, 12).map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                    <td className="strong">{t.pair}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? '买入' : '卖出'}</td>
                    <td className="num">${t.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="num">{t.qty}</td>
                    <td className="num">${(t.price * t.qty).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <style>{`
          .orders-card {
            height: 210px; flex-shrink: 0;
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; padding: 0 12px;
            display: flex; flex-direction: column;
          }
          .t-count {
            font-family: var(--font-mono); font-size: 10px;
            background: var(--bg-elevated); border-radius: 8px; padding: 1px 6px;
            color: var(--text-sub);
          }
          .orders-body { flex: 1; overflow-y: auto; min-height: 0; }
        `}</style>
      </div>
    </div>
  )
}
