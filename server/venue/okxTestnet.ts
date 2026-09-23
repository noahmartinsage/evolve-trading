import crypto from 'node:crypto'
import type { BalanceSnapshot, VenueAdapter, VenueFill, VenueIntent } from './types.ts'
import {
  contractsFromBaseQty,
  toSwapInstId,
  type SwapInstrumentSpec,
  type SwapSettlement,
} from './okxSwapSpec.ts'

/**
 * 报价精度：OKX 现货报价按 0.1 处理即可满足模拟盘成交；
 * 合约（尤其 inverse）tickSz 通常更细，统一保留 2 位小数——
 * 报价被"四舍五入到远离盘口"是限价单不成交的常见原因。
 */
function roundQuote(px: number, settle: SwapSettlement): number {
  const digits = settle === 'inverse' ? 2 : 2
  const f = 10 ** digits
  return Math.round(px * f) / f
}

/**
 * 把 `VenueProtection` 翻成 OKX 的 `attachAlgoOrds` 元素。
 *
 * ── 为什么是 `attachAlgoOrds` 而不是"成交后再下一张条件单" ─────────────
 * 见 `VenueProtection` 的注释：后者会留一段**真实的裸窗**。
 * `attachAlgoOrds` 是**随主单同一笔请求**提交的，场所侧要么两者都受理、
 * 要么整笔驳回 —— 那正是"不会有一段没保护的仓位"这句话的技术含义。
 *
 * ★ `tpOrdPx`/`slOrdPx` 都给 `-1`（= 触发后市价成交）。刻意**不**挂限价：
 *   限价在剧烈行情里会触发而不成交（价格穿过去了、单子还挂着），
 *   于是保护"触发了"而仓位还在 —— 那比没有保护更难发现。
 *
 * ★ 只给了一道就只挂一道：只设止损是合法诉求，替用户补另一半等于替他做了主张。
 *
 * ★ 导出它是**刻意的**：这是个纯函数（给定保护给出一段 JSON），而它承担的语义
 *   决定（`-1` = 触发后市价、只挂给出的那一道、报价精度）此前在测试里
 *   **一个字都没被断过** —— 因为它在适配器内部，而适配器的 `place()` 要出网。
 *   判据：纯函数才能离线逐条断言；不导出就只能靠"发一笔真单看看"。
 */
export function attachAlgo(
  p: { takeProfitPrice?: number; stopLossPrice?: number } | undefined,
  settle: SwapSettlement,
): Record<string, string> | undefined {
  if (!p) return undefined
  const out: Record<string, string> = {}
  if (Number.isFinite(p.takeProfitPrice) && (p.takeProfitPrice as number) > 0) {
    out.tpTriggerPx = String(roundQuote(p.takeProfitPrice as number, settle))
    out.tpOrdPx = '-1'
  }
  if (Number.isFinite(p.stopLossPrice) && (p.stopLossPrice as number) > 0) {
    out.slTriggerPx = String(roundQuote(p.stopLossPrice as number, settle))
    out.slOrdPx = '-1'
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 受限网络（如 OKX 被 geo-block）下通过 HTTP/HTTPS 代理出海。仅当设置了 HTTPS_PROXY/HTTP_PROXY 时启用；不影响模拟盘本质。 */
let proxyConfigured = false
async function ensureProxy(): Promise<void> {
  if (proxyConfigured) return
  proxyConfigured = true
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (!proxy) return
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new ProxyAgent(proxy))
    console.log(`[OK] OKX adapter 使用代理出海 (${proxy.replace(/\/\/.*@/, '//***@')})`)
  } catch {
    console.warn('⚠️ 设置了代理但 undici 不可用，忽略（直连）')
  }
}

/**
 * OKX 测试网（模拟盘）适配器。
 *
 * 安全约束（硬编码，不可通过配置绕过）：
 *  - 仅连接 https://www.okx.com 且始终携带 x-simulated-trading: 1 —— 即 OKX 模拟交易环境，
 *    任何订单均为零真实资金的模拟单，不存在主网通路。
 *  - 凭证仅从环境变量读取，绝不写入日志 / 落库明文。
 *  - 凭证缺失时 fromEnv() 返回 null，编排层保持 gateway 未挂载（fail-closed）。
 */
const OKX_BASE = 'https://www.okx.com'

function toInstId(symbol: string): string {
  if (symbol.includes('-')) return symbol.toUpperCase()
  return symbol.replace(/(USDT|USDC|USD|T)$/, '-$1').toUpperCase()
}

function toSymbol(instId: string): string {
  return instId.replace('-', '').toUpperCase()
}

function sanitizeClOrdId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
  return cleaned.length > 0 ? cleaned : `E${crypto.randomBytes(6).toString('hex')}`
}

export class OkxTestnetAdapter implements VenueAdapter {
  readonly name = 'okx-testnet'
  /**
   * ★★ `true` —— OKX 用 `attachAlgoOrds` 把止盈止损**随主单一起**提交，
   *   场所侧在同一笔请求里受理两者。所以不存在"开仓成交了、保护还没挂上"
   *   的那一段真实裸窗（见 `VenueProtection` 的注释：那一段正是本仓库拒收
   *   "成交后再另下条件单"那种做法的原因）。
   *
   * ★ 这个能力位是**生产入口**，不只是给测试看的：语音实盘下单会读它，
   *   为假就拒单。所以它必须与下面 `attachAlgoOrds` 的实现事实一致 ——
   *   真去掉了附挂却忘了改这里，等于把"有保护"说成事实（红线：灰区不许装成绿）。
   */
  readonly supportsVenueProtection = true
  private apiKey: string
  private apiSecret: string
  private passphrase: string
  private fillListeners: ((f: VenueFill) => void)[] = []
  private lastTradeIdByInst = new Map<string, string>()
  private watchedInst = new Set<string>()
  private executedFills = 0
  private pollTimer: ReturnType<typeof setInterval> | null = null

  static fromEnv(): OkxTestnetAdapter | null {
    const key = process.env.OKX_TESTNET_API_KEY
    const secret = process.env.OKX_TESTNET_API_SECRET
    const pass = process.env.OKX_TESTNET_PASSPHRASE
    if (!key || !secret || !pass) return null
    return new OkxTestnetAdapter(key, secret, pass)
  }

  constructor(apiKey: string, apiSecret: string, passphrase: string) {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.passphrase = passphrase
  }

  watchSymbol(symbol: string): void {
    const inst = toInstId(symbol)
    this.watchedInst.add(inst)
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollFills()
      }, 10_000)
    }
  }

  /**
   * ★ `params` 允许是**数组**：OKX 有几个接口（撤算法单等）要的是 JSON 数组体。
   *   收窄成 `Record` 会逼调用方把它包成 `{0: …}`，而那种包法在线上不会报错 ——
   *   场所会用一个与真因无关的理由（参数缺失）驳回，排查方向就此跑偏。
   */
  private async signed<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, unknown> | unknown[] = {},
  ): Promise<T> {
    await ensureProxy()
    const ts = new Date().toISOString()
    let qs = ''
    let body = ''
    if (method === 'GET' && Object.keys(params).length > 0) {
      qs = '?' + new URLSearchParams(params as Record<string, string>).toString()
    } else if (method === 'POST') {
      body = JSON.stringify(params)
    }
    const preHash = ts + method + path + qs + body
    const sign = crypto.createHmac('sha256', this.apiSecret).update(preHash).digest('base64')
    const res = await fetch(`${OKX_BASE}${path}${qs}`, {
      method,
      headers: {
        'OK-ACCESS-KEY': this.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
        'x-simulated-trading': '1',
        'content-type': 'application/json',
      },
      ...(body ? { body } : {}),
    })
    const json = (await res.json().catch(() => ({}))) as { code?: string; msg?: string; data?: unknown[] }
    if (json.code !== '0' || !res.ok) {
      const detail = json.data && json.data.length ? JSON.stringify(json.data[0]) : ''
      throw new Error(`OKX_HTTP_${res.status}: ${json.msg ?? 'unknown'} (${json.code ?? '?'})${detail ? ' · ' + detail : ''}`)
    }
    return json as T
  }

  async place(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    if (intent.instType === 'SWAP') return this.placeSwap(intent)

    const instId = toInstId(intent.symbol)
    const leverage = Number.isFinite(intent.leverage) && (intent.leverage ?? 1) > 1 ? (intent.leverage as number) : 1
    const marginMode = leverage > 1 ? 'cross' : 'cash'
    const payload: Record<string, unknown> = {
      instType: 'SPOT',
      tdMode: marginMode,
      instId,
      side: intent.side,
      ordType: intent.type === 'market' ? 'limit' : 'limit',
      sz: String(intent.qty),
      clOrdId: sanitizeClOrdId(intent.clientOrderId),
    }
    // 以小博大：全仓保证金下 OKX 自动以现有持仓（如 BTC）为抵押物借币成交
    if (leverage > 1) {
      payload.lever = String(leverage)
      // 保证金买入借报价币（USDT），卖出借基础币（BTC），否则 OKX 报 50014
      const [baseCcy, quoteCcy] = instId.split('-')
      payload.ccy = intent.side === 'buy' ? quoteCcy : baseCcy
    }
    if (intent.type === 'limit' && intent.price !== undefined) {
      payload.px = String(intent.price)
    } else if (intent.type === 'market') {
      // OKX 模拟盘对市价单的买入支持不稳定（sCode 51020），改为以当前盘口限价单成交
      const tp = await this.lastPrice(instId)
      const px = intent.side === 'buy' ? tp * 1.001 : tp * 0.999
      payload.px = String(Math.round(px * 10) / 10)
    }
    const algo = attachAlgo(intent.protection, 'linear')
    if (algo) payload.attachAlgoOrds = [algo]
    const res = await this.signed<{ code: string; msg: string; data: { ordId: string }[] }>('POST', '/api/v5/trade/order', payload)
    this.watchSymbol(intent.symbol)
    return { venueOrderId: `OKX-${res.data[0].ordId}@${instId}` }
  }

  /**
   * 永续合约下单（U 本位 / 币本位）。
   *
   * 与现货路径的三个关键差异，每一个都会导致"下单成功但规模完全不对"：
   *   ① `sz` 的单位是**张**，不是币量 ⇒ 必须经 `contractsFromBaseQty` 换算（见 okxSwapSpec.ts）；
   *   ② `tdMode` 必须显式给 `cross`（逐仓/全仓），合约没有 `cash` 模式；
   *   ③ inventory 里必须带 `lever`，否则场所按默认杠杆（通常 3x）下单，
   *      而我们按 125x 算的保证金根本不够 —— 场所会用"保证金不足"拒单，
   *      排查方向极易被引到"余额不够"而不是"杠杆没传进去"。
   */
  private async placeSwap(intent: VenueIntent): Promise<{ venueOrderId: string }> {
    const settle = intent.settle ?? 'linear'
    const instId = toSwapInstId(intent.symbol, settle)
    const spec = await this.swapSpec(instId, settle)

    const refPrice =
      intent.price !== undefined && intent.price > 0
        ? intent.price
        : await this.lastPrice(instId)
    if (!(refPrice > 0)) throw new Error(`SWAP_PRICE_UNAVAILABLE:${instId}`)

    const contracts = contractsFromBaseQty(intent.qty, spec, refPrice)
    if (contracts <= 0) {
      // 不静默抬到最小可下量：抬起规模等于风控失效。让上游显式决定是否放大。
      throw new Error(
        `SWAP_QTY_BELOW_MIN:${instId} 计划 ${intent.qty} 基础币 → 不足最小下单量 ${spec.minSz} 张（1 张 = ${spec.ctVal} ${spec.ctValCcy}）`,
      )
    }

    const leverage = Number.isFinite(intent.leverage) && (intent.leverage ?? 1) > 0 ? (intent.leverage as number) : 1
    const payload: Record<string, unknown> = {
      instType: 'SWAP',
      tdMode: 'cross',
      instId,
      side: intent.side,
      ordType: 'limit',
      sz: String(contracts),
      lever: String(leverage),
      clOrdId: sanitizeClOrdId(intent.clientOrderId),
    }
    // 模拟盘市价单不稳定，统一以盘口限价成交（与现货路径同一处置）
    const px = intent.type === 'limit' && intent.price !== undefined ? intent.price : intent.side === 'buy' ? refPrice * 1.001 : refPrice * 0.999
    payload.px = String(roundQuote(px, settle))

    // ★ 合约的止盈止损同样走 `attachAlgoOrds`（随主单原子附挂）。
    //   合约尤其需要它：125 倍的强平距离只有百分之几，而本地巡检随进程存活 ——
    //   进程一停、仓位还在场所，那就不是"保护变慢"，是"没有保护"。
    const algo = attachAlgo(intent.protection, settle)
    if (algo) payload.attachAlgoOrds = [algo]
    const res = await this.signed<{ code: string; msg: string; data: { ordId: string }[] }>('POST', '/api/v5/trade/order', payload)
    if (res.data[0] && !res.data[0].ordId) {
      throw new Error(`SWAP_ORDER_NO_ORDID:${instId}`)
    }
    this.watchSymbol(intent.symbol)
    return { venueOrderId: `OKX-${res.data[0].ordId}@${instId}` }
  }

  /** 合约规格缓存：ctVal/lotSz 是场所侧事实，短期不变，逐单查询会浪费配额并放大延迟。 */
  private swapSpecs = new Map<string, SwapInstrumentSpec>()

  private async swapSpec(instId: string, settle: 'linear' | 'inverse'): Promise<SwapInstrumentSpec> {
    const hit = this.swapSpecs.get(instId)
    if (hit) return hit
    const r = await this.signed<{
      code: string
      data: { instId: string; ctVal: string; ctValCcy: string; lotSz: string; minSz: string }[]
    }>('GET', '/api/v5/public/instruments', { instType: 'SWAP', instId })
    const d = r.data[0]
    if (!d) throw new Error(`SWAP_SPEC_NOT_FOUND:${instId}`)
    const spec: SwapInstrumentSpec = {
      instId: d.instId,
      ctVal: parseFloat(d.ctVal),
      ctValCcy: d.ctValCcy,
      lotSz: parseFloat(d.lotSz),
      minSz: parseFloat(d.minSz),
      settle,
    }
    if (!(spec.ctVal > 0) || !(spec.lotSz > 0)) {
      throw new Error(`SWAP_SPEC_INVALID:${instId} ctVal=${d.ctVal} lotSz=${d.lotSz}`)
    }
    this.swapSpecs.set(instId, spec)
    return spec
  }

  private async lastPrice(instId: string): Promise<number> {
    const r = await this.signed<{ code: string; msg: string; data: { last: string }[] }>('GET', '/api/v5/market/ticker', { instId })
    return parseFloat(r.data[0]?.last ?? '0')
  }

  async cancel(venueOrderId: string): Promise<boolean> {
    // ★ 算法单（止盈止损）与普通挂单在 OKX 是**两套不同的撤单接口**，
    //   用错接口的表现是"撤单返回 false" —— 而调用方会把它读成"这笔不存在"，
    //   于是"保护没撤掉"这件事会被记成"本来就没有保护"。两条 id 因此必须可分。
    const algo = /^OKXALGO-(.+?)@(.+)$/.exec(venueOrderId)
    if (algo) {
      try {
        await this.signed('POST', '/api/v5/trade/cancel-algos', [{ instId: algo[2], algoId: algo[1] }])
        return true
      } catch {
        return false
      }
    }
    const m = /^OKX-(.+?)@(.+)$/.exec(venueOrderId)
    if (!m) return false
    try {
      await this.signed('POST', '/api/v5/trade/cancel-order', { instId: m[2], ordId: m[1] })
      return true
    } catch {
      return false
    }
  }

  onFill(cb: (f: VenueFill) => void): void {
    this.fillListeners.push(cb)
  }

  async openOrderIds(): Promise<string[]> {
    const out: string[] = []
    for (const instType of ['SPOT', 'SWAP'] as const) {
      try {
        const res = await this.signed<{ code: string; data: { ordId: string; instId: string }[] }>(
          'GET',
          '/api/v5/trade/orders-pending',
          { instType },
        )
        out.push(...res.data.map((o) => `OKX-${o.ordId}@${o.instId}`))
      } catch {
        /* 单一品种类型查询失败不影响另一类；返回已取到的部分而不是整体抛错 */
      }
      // ★★ 算法单**必须一起列出来**。
      //   它们挂在 `/orders-algo-pending`，不在 `/orders-pending` 里。
      //   少了这一段，对账会得出"场所没有任何挂单，本地却有保护"的结论 ——
      //   而真像是相反的：场所那侧的保护好好的，是**查询取错了接口**。
      //   那会把人引向"重新挂一道保护"（于是挂了两道），而真正该做的是别动
      //   （判据 C5：分不清"没有"与"没查对地方"是这类缺陷的固定形态）。
      try {
        const res = await this.signed<{ code: string; data: { algoId: string; instId: string }[] }>(
          'GET',
          '/api/v5/trade/orders-algo-pending',
          { instType, ordType: 'conditional' },
        )
        out.push(...res.data.map((o) => `OKXALGO-${o.algoId}@${o.instId}`))
      } catch {
        /* 同上：algos 取不到不影响普通挂单那份清单 */
      }
    }
    return out
  }

  async reconcile(): Promise<BalanceSnapshot> {
    const bal = await this.signed<{
      code: string
      data: { details: { ccy: string; availBal: string; accAvgPx: string; eqUsd: string; liab?: string }[] }[]
    }>('GET', '/api/v5/account/balance', {})
    let cash = 0
    const positions: BalanceSnapshot['positions'] = []
    for (const d of bal.data[0]?.details ?? []) {
      const ccy = d.ccy
      const avail = parseFloat(d.availBal)
      if (ccy === 'USDT' || ccy === 'USDC') {
        // 减去保证金借币负债（liab），否则杠杆会虚增权益
        const liab = parseFloat(d.liab ?? '0') || 0
        cash += avail - liab
        continue
      }
      if (Math.abs(avail) > 1e-12) {
        positions.push({ symbol: `${ccy}USDT`, qty: avail, avgPrice: d.accAvgPx ? parseFloat(d.accAvgPx) : Number.NaN })
      }
    }
    return { cash, positions, totalFills: this.executedFills }
  }

  /**
   * 权限自检的**原始材料**。
   *
   * ★★ 为什么不能用 `reconcile()` 的返回值顶替：那条路已经把响应加工成
   *   `BalanceSnapshot`，**丢掉了 `perm` 字段**。而 `classifyKeyScope` 判的正是
   *   `perm` —— 用加工过的结果去判权限，等于把"提币权限"这个字段先删掉再检查它
   *   （判据 D7：注释/接口要说真在跑的逻辑；判据 C1：有端点 ≠ 有材料）。
   *
   * ★ OKX 的权限字段在 **`/api/v5/account/config`** 的 `perm` 上（形如
   *   `read_only` / `read_only,trade`），不是 `/account/balance`。`classifyKeyScope`
   *   的 OKX 分支读的就是 `o.perm`，所以这里必须取 config 那个接口。
   *   ★ 取错接口的症状很隐蔽：`perm` 缺失 ⇒ 判 `unverifiable`（而不是 ok），
   *     于是"没查对地方"会一直伪装成"场所没告诉我们"（判据 C5：四种事因长得一样）。
   */
  async fetchAccountRaw(): Promise<unknown> {
    const res = await this.signed<{ code: string; data: Record<string, unknown>[] }>('GET', '/api/v5/account/config', {})
    // OKX 把载荷包在 data[0] 里；`classifyKeyScope` 吃的是那个对象本身
    return res.data?.[0] ?? null
  }

  async pollFills(): Promise<void> {
    for (const instId of this.watchedInst) {
      try {
        const res = await this.signed<{ code: string; data: { tradeId: string; ordId: string; side: string; fillPx: string; fillSz: string; ts: string }[] }>(
          'GET',
          '/api/v5/trade/fills',
          { instType: 'SPOT', instId, limit: '100' },
        )
        for (const t of res.data) {
          const last = this.lastTradeIdByInst.get(instId) ?? '0'
          if (t.tradeId <= last) continue
          this.lastTradeIdByInst.set(instId, t.tradeId)
          this.executedFills += 1
          const fill: VenueFill = {
            fillId: `O${t.tradeId}`,
            venueOrderId: `OKX-${t.ordId}@${instId}`,
            clientOrderId: '',
            symbol: toSymbol(instId),
            side: t.side === 'buy' ? 'buy' : 'sell',
            price: parseFloat(t.fillPx),
            qty: parseFloat(t.fillSz),
            ts: Number(t.ts),
          }
          for (const cb of this.fillListeners) cb(fill)
        }
      } catch {
        /* 轮询失败静默重试 */
      }
    }
  }
}
