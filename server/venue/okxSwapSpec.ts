/**
 * OKX 永续合约（SWAP）符号与下单量换算 —— 纯函数，可离线单测。
 *
 * 为什么要单独一个模块，而不是把这几行塞进 adapter：
 *   这里藏着**整条执行链路上最容易犯的百倍级错误** ——
 *   SWAP 的下单量单位是「张（contract）」而不是「币」。
 *   1 张 BTC-USDT-SWAP 代表 0.01 BTC，所以把「0.01 BTC」当张数直接传，
 *   实际下单量会是 0.0001 BTC —— 少 100 倍；反过来把「1 张」当 1 BTC 传，
 *   则是超 100 倍。两种错都**不会报错**，只会成交一个完全不同规模的仓位。
 *   所以换算必须在一个**没有 I/O、可以直接断言**的地方完成。
 *
 * 两种保证金模式（用户所说的「币本位 / U 本位」）：
 *   - linear（U 本位）：以 USDT 计价与结算，如 BTC-USDT-SWAP。盈亏线性于价格。
 *   - inverse（币本位）：以 USD 计价、以币结算，如 BTC-USD-SWAP。盈亏**非线性**，
 *     张数 = 名义价值(USD) / ctVal(USD)。反向合约的危险在于
 *     「同样张数在不同价位对应不同名义」——规模不是常数，仓位会随价格漂移。
 */

export type SwapSettlement = 'linear' | 'inverse'

export interface SwapInstrumentSpec {
  instId: string
  /** 合约面值。linear：单位为基础币（BTC）；inverse：单位为报价币（USD）。 */
  ctVal: number
  /** ctVal 的计量币种。linear='BTC' 这类基础币；inverse='USD'。 */
  ctValCcy: string
  /** 下单量步长（张）。 */
  lotSz: number
  /** 最小下单量（张）。 */
  minSz: number
  settle: SwapSettlement
}

/** 稳定币集合：判断基础币/报价币时必须用集合而不是正则片段（USD 是 USDT 的前缀）。 */
const STABLES = ['USDT', 'USDC', 'USD']

/**
 * 币种代码的形状校验。
 *
 * 存在的理由：`split('-')` 对任意字符串都能"成功" ——
 * `'not-a-symbol'.split('-')` 得到三段，于是会生成 `NOT-A-SWAP` 这种
 * 看起来完全合法的 instId，一路送到场所才被拒。
 * 排查时看到的是「无效合约」，而真因是**上游根本没做符号校验**。
 * 所以在生成 instId 之前就把形状不对的输入挡掉：
 * 币种代码是 2~15 位大写字母或数字（覆盖 BTC / USDT / 1000PEPE 这类真实代码）。
 */
const CCY_SHAPE = /^[A-Z0-9]{2,15}$/

function isValidCcy(v: string | undefined): v is string {
  return typeof v === 'string' && CCY_SHAPE.test(v)
}

/**
 * 把内部符号（BTCUSDT / BTC-USDT / BTC）解析为基础币与报价币。
 * 返回报价币为 `USD` 形式时不得直接当 USDT 用 —— 两者在 inverse 合约里含义不同。
 */
export function parseSymbol(symbol: string): { base: string; quote: string } | null {
  const s = symbol.toUpperCase().replace(/\s/g, '')
  if (s.includes('-')) {
    const parts = s.split('-')
    if (parts.length !== 2) return null
    const [base, quote] = parts
    if (!isValidCcy(base) || !isValidCcy(quote)) return null
    return { base, quote }
  }
  // 无分隔符：从尾部匹配最长的稳定币后缀（必须最长匹配，否则 USDT 会被 USD 截断）
  const ordered = [...STABLES].sort((a, b) => b.length - a.length)
  for (const q of ordered) {
    if (s.endsWith(q) && s.length > q.length) {
      const base = s.slice(0, s.length - q.length)
      if (!isValidCcy(base)) continue
      return { base, quote: q }
    }
  }
  return null
}

/**
 * 生成 OKX 永续合约 instId。
 *
 * linear 用 USDT 结算；inverse 一律落到 **USD** 结算的币本位合约
 * （`BTC-USD-SWAP`），而不是 `BTC-USDC-SWAP` —— 后者是另一种（USDC 本位）产品，
 * 与「币本位」不是一回事。
 */
export function toSwapInstId(symbol: string, settle: SwapSettlement = 'linear'): string {
  const parsed = parseSymbol(symbol)
  if (!parsed) throw new Error(`SWAP_SYMBOL_UNPARSEABLE:${symbol}`)
  const quote = settle === 'inverse' ? 'USD' : 'USDT'
  return `${parsed.base}-${quote}-SWAP`
}

/**
 * 由「基础币数量」换算为「张数」。
 *
 * - linear（U 本位）：张数 = 基础币量 ÷ ctVal(基础币)。
 * - inverse（币本位）：张数 = 名义价值(USD) ÷ ctVal(USD)，
 *   而名义价值 = 基础币量 × 价格。**必须传 price** —— 反向下不传价格无法换算，
 *   这里选择抛错而不是猜一个价格：猜错就是量级错误。
 *
 * 结果按 lotSz 向下取整到合法步长，并在低于 minSz 时返回 0
 * （返回 0 而不是 minSz：**悄悄把规模抬到最小可下量，等于擅自放大仓位**，
 *   调用方必须显式决定「要么放弃、要么自己抬」）。
 */
export function contractsFromBaseQty(
  baseQty: number,
  spec: Pick<SwapInstrumentSpec, 'ctVal' | 'ctValCcy' | 'lotSz' | 'minSz' | 'settle'>,
  price?: number,
): number {
  if (!(baseQty > 0) || !(spec.ctVal > 0)) return 0
  let raw: number
  if (spec.settle === 'inverse') {
    if (!(price !== undefined && price > 0)) {
      throw new Error('INVERSE_SWAP_REQUIRES_PRICE：币本位合约张数必须以价格换算名义价值，缺失价格无法安全换算')
    }
    raw = (baseQty * price) / spec.ctVal
  } else {
    raw = baseQty / spec.ctVal
  }
  const step = spec.lotSz > 0 ? spec.lotSz : 1
  const floored = Math.floor(raw / step) * step
  // 浮点误差：step=1 时 floored 可能得到 2.9999999996，不能让它跌到 minSz 之下
  const normalized = Number(floored.toFixed(8))
  if (normalized < spec.minSz) return 0
  return normalized
}

/**
 * 由张数反推名义价值（USDT）。
 *
 * 为什么要能反推：成本闸门与资金帽校验都以**名义本金**为输入，
 * 而下单单位是张数。没有这一步，闸门校验的规模与实际下单规模会是两个数——
 * 那正是「闸门放行了、实际下的却是另一个仓位」这类缺陷的入口。
 */
export function notionalFromContracts(
  contracts: number,
  spec: Pick<SwapInstrumentSpec, 'ctVal' | 'ctValCcy' | 'settle'>,
  price: number,
): number {
  if (!(contracts > 0) || !(spec.ctVal > 0) || !(price > 0)) return 0
  if (spec.settle === 'inverse') {
    // 币本位：ctVal 单位是 USD，张数 × ctVal 就是美元名义价值
    return contracts * spec.ctVal
  }
  // U 本位：ctVal 单位是基础币，名义 = 张数 × ctVal × 价格
  return contracts * spec.ctVal * price
}
