/**
 * 标的注册表 —— 「系统里有哪些交易对」这件事的**唯一事实源**。
 *
 * ══ 为什么要有这个文件 ═══════════════════════════════════════════════════
 * 在它之前，「有哪些标的」这件事有**五个主人**，各写各的：
 *   · `src/data/market.ts`  的 `SYMBOL_MAP`     —— 前端的 5 个 USDC 交易对
 *   · `src/store/Store.tsx` 的 `initialPairs`   —— 同一批标的**又抄了一遍**，
 *      外加一份**硬编码价格**（BTC 写 114320，而市价 84001）
 *   · `src/store/Store.tsx` 与 `src/pages/TerminalPage.tsx` 各有一份
 *      「这个标的小数位是几」的三元表达式
 *   · `server/index.ts` 的 `ORCH_SYMBOLS` 默认值 —— 服务端行情只订阅 `ETHUSDT,BTCUSDT`
 *   · `server/autopilot.ts` 的 `AUTOPILOT_SYMBOL` 默认值 —— 策略腿只认 `BTCUSDT`
 *
 * 于是同一个「比特币」在两个地方是两个东西（终端页 `BTC-USDC`、引擎 `BTCUSDT`），
 * 而两份名单谁也不会因为对方改了而报错 —— 它们只是**各自维护**（判据 8）。
 * 这份注册表把它们收成一份：**改这里，所有地方一起变**。
 *
 * ══ 一条设计红线 ═══════════════════════════════════════════════════════
 * 这里**只放能在交易所核实到的事实**（符号存在性、tick、step、最小名义额），
 * 全部由 `GET /api/v3/exchangeInfo` 读过一遍再写下来。
 * **不放价格** —— 任何写进来的价格都会变成"看着像真的"的占位数字，
 * 而它迟早会出现在某个界面上被当成行情（判据 24：缺数据要说出来，不许退化成假值）。
 *
 * ★ 本文件是**纯数据 + 纯函数**，不读环境变量、不发请求，
 *   因此浏览器与服务端都可以直接 import（服务端已经这样引用 `src/engine/*`）。
 */

/** 报价币。系统里同时存在 USDT 与 USDC 两条腿，这是**有意**的，不是遗留。 */
export type QuoteAsset = 'USDT' | 'USDC'

export interface MarketSymbol {
  /** 内部符号（界面与态势里用的），形如 `BTC-USDT` */
  symbol: string
  /** 交易所符号（下单/行情/证据文件用的），形如 `BTCUSDT` */
  exchange: string
  /** 基础资产，形如 `BTC` */
  base: string
  quote: QuoteAsset
  /**
   * 价格小数位 = 交易所 `PRICE_FILTER.tickSize` 的位数。
   * ★ 只有**一个**含义：能不能写得出这个价。不用它做"显示美化"，
   *   否则同一个名字会有两种口径（判据 21）。
   */
  priceDecimals: number
  /** 数量小数位 = 交易所 `LOT_SIZE.stepSize` 的位数。 */
  qtyDecimals: number
  /** 交易所 `NOTIONAL.minNotional`：低于它的单**根本挂不上去**，不是"不划算"而是"不存在"。 */
  minNotional: number
  /** 是否进入 CEX 行情订阅（服务端 tick 流 + 前端快照）。 */
  cex: boolean
  /** 是否可经 Uniswap V3 链上路由此标的（仅同资产的 USDC 腿有意义）。 */
  dex: boolean
}

/**
 * 交易对清单。**5 个基础资产 × 2 个报价币 = 10 个**。
 *
 * ★ 存在性、tick、step、minNotional 全部由 `exchangeInfo` 核实过（2026-09-21），
 *   不是照抄别处。加新标的时**必须先跑一次核实**，核实不过就不要写进来 ——
 *   写进来而交易所没有，表现是"这个交易对没有报价"，而它看起来跟"网络抖动"一模一样。
 * ★ `dex` 只在 USDC 腿为真：链上池子计价的是 USDC，USDT 腿没有对应的链上路由。
 */
export const MARKET: readonly MarketSymbol[] = [
  { symbol: 'BTC-USDT', exchange: 'BTCUSDT', base: 'BTC', quote: 'USDT', priceDecimals: 2, qtyDecimals: 5, minNotional: 5, cex: true, dex: false },
  { symbol: 'BTC-USDC', exchange: 'BTCUSDC', base: 'BTC', quote: 'USDC', priceDecimals: 2, qtyDecimals: 5, minNotional: 5, cex: true, dex: true },
  { symbol: 'ETH-USDT', exchange: 'ETHUSDT', base: 'ETH', quote: 'USDT', priceDecimals: 2, qtyDecimals: 4, minNotional: 5, cex: true, dex: false },
  { symbol: 'ETH-USDC', exchange: 'ETHUSDC', base: 'ETH', quote: 'USDC', priceDecimals: 2, qtyDecimals: 4, minNotional: 5, cex: true, dex: true },
  { symbol: 'SOL-USDT', exchange: 'SOLUSDT', base: 'SOL', quote: 'USDT', priceDecimals: 2, qtyDecimals: 3, minNotional: 5, cex: true, dex: false },
  { symbol: 'SOL-USDC', exchange: 'SOLUSDC', base: 'SOL', quote: 'USDC', priceDecimals: 2, qtyDecimals: 3, minNotional: 5, cex: true, dex: true },
  { symbol: 'ARB-USDT', exchange: 'ARBUSDT', base: 'ARB', quote: 'USDT', priceDecimals: 4, qtyDecimals: 1, minNotional: 5, cex: true, dex: false },
  { symbol: 'ARB-USDC', exchange: 'ARBUSDC', base: 'ARB', quote: 'USDC', priceDecimals: 4, qtyDecimals: 1, minNotional: 5, cex: true, dex: true },
  { symbol: 'OP-USDT', exchange: 'OPUSDT', base: 'OP', quote: 'USDT', priceDecimals: 4, qtyDecimals: 2, minNotional: 5, cex: true, dex: false },
  { symbol: 'OP-USDC', exchange: 'OPUSDC', base: 'OP', quote: 'USDC', priceDecimals: 4, qtyDecimals: 2, minNotional: 5, cex: true, dex: true },
]

/**
 * 默认标的。
 * ★ 用户明说「我习惯使用 BTCUSDT 交易对」⇒ 默认就是它，不是 ETH。
 * ★ 它必须**真的在注册表里**：不在的话，那个"默认"会指向一个没有行情的标的，
 *   而界面会安静地显示空值（`defaultSymbol()` 会抛，宁可直接崩也不静默）。
 */
export const DEFAULT_SYMBOL_INTERNAL = 'BTC-USDT'
export const DEFAULT_SYMBOL_EXCHANGE = 'BTCUSDT'

const BY_INTERNAL = new Map(MARKET.map((m) => [m.symbol, m]))
const BY_EXCHANGE = new Map(MARKET.map((m) => [m.exchange, m]))

/** 内部符号 → 注册项。查不到返回 `undefined`（调用方必须自己决定怎么说"没有"）。 */
export const byInternal = (symbol: string): MarketSymbol | undefined => BY_INTERNAL.get(symbol)
/** 交易所符号 → 注册项。 */
export const byExchange = (exchange: string): MarketSymbol | undefined =>
  BY_EXCHANGE.get(exchange.toUpperCase())

/**
 * 内部符号 → 交易所符号。
 * ★ 查不到返回**空串**而不是把输入原样返回：原样返回会让 `BTC-USDC` 一路带着连字符
 *   走进交易所请求（`/api/v3/klines?symbol=BTC-USDC` → 400），
 *   而 400 在界面上跟"行情还没到"长得一样。空串会被上层显式拦下来说清原因。
 */
export const toExchange = (symbol: string): string => BY_INTERNAL.get(symbol)?.exchange ?? ''

/** 交易所符号 → 内部符号。 */
export const toInternal = (exchange: string): string => BY_EXCHANGE.get(exchange.toUpperCase())?.symbol ?? ''

/** 注册表里的全部交易所符号（服务端行情订阅、K线白名单用它）。 */
export const exchangeSymbols = (): string[] => MARKET.map((m) => m.exchange)

/** 内部符号列表（前端标的栏用它，顺序即显示顺序）。 */
export const internalSymbols = (): string[] => MARKET.map((m) => m.symbol)

/** 该标的能否走 CEX。 */
export const isCexTradable = (symbol: string): boolean => BY_INTERNAL.get(symbol)?.cex === true

/** 该标的能否走链上（DEX）。 */
export const isDexRoutable = (symbol: string): boolean => BY_INTERNAL.get(symbol)?.dex === true

/** 全部报价币（语音层切后缀、服务端分账户用它，避免各处再抄一份常量表）。 */
export const QUOTE_ASSETS: readonly QuoteAsset[] = ['USDT', 'USDC']

/**
 * 把一个可能是内部符号、也可能是交易所符号的串归一成交易所符号。
 * 用于**收外部输入**的地方（端点 query、语音解析），那里不知道调用方会写哪种。
 */
export const normalizeExchange = (raw: string): string => {
  const s = raw.trim().toUpperCase()
  if (BY_EXCHANGE.has(s)) return s
  const internal = s.replace('-', '')
  return BY_EXCHANGE.get(internal)?.exchange ?? ''
}
