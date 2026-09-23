/**
 * 行情来源的**回退链 + 来源凭据** —— 全仓库唯一一份。
 *
 * ── 它解决的两个真问题 ────────────────────────────────────────────────
 *
 * ① **「来源」原先是一个写死的字符串。**
 *    图上写着 `K线 · Binance`，而那行字有两个主人：`CandleChart` 里一份、
 *    调用点 `sourceLabel={klineState === 'ok' ? 'Binance' : 'Binance（上次成功）'}` 一份。
 *    于是引进了真正的回退链之后（第二个源也能答话），
 *    不管是谁答的，屏幕上都印 "Binance" —— **凭据与被证明的事不是同一件**（判据 31 同族）。
 *    更贵的是：门禁 `U29d` 只检查"旧的那个字面量还在不在"，所以它**一直是绿的**。
 *    ⇒ 来源名必须**由数据层返回**，视图只负责显示（判据 8：一个事实一个主人）。
 *
 * ② **「一个数据源挂了」原先没有观测点。**
 *    上游项目（OpenTerminal）的做法值得学：每个端点一条**回退链** +
 *    每源的**健康账**（成败次数、延迟）。学它的**语义**，不抄它的实现。
 *
 * ── 明确**不学**上游的一处（这会害人）────────────────────────────────
 *    上游 `cached()` 在全部源失败时会返回**任意旧的 stale 值**，且
 *    那个 stale 存储**没有 TTL、也不把年龄告诉调用方**。
 *    对一个**交易**终端，这比"取不到"危险得多：屏幕上一个三小时前的价格
 *    与一个三秒前的价格长得**一模一样**。
 *    ⇒ 本模块的 stale **必须有上界**，且超界时**拒收**（fail-closed）；
 *      并且每个值都强制带上 `atMs`，让消费方能算出年龄、必须显式说"这是旧的"。
 */

/** 一个候选来源。`name` 会**出现在屏幕上**，所以它必须是用户能看懂的东西。 */
export interface SourceAttempt<T> {
  name: string
  run: () => Promise<T>
}

/** 单次尝试的下场。**失败时要能逐条说出来**（否则"全挂了"没有下一步）。 */
export interface SourceTry {
  name: string
  ms: number
  ok: boolean
  error: string | null
}

/** 一个来源的累积健康账。 */
export interface SourceHealth {
  name: string
  ok: number
  failed: number
  lastLatencyMs: number | null
  avgLatencyMs: number | null
  lastError: string | null
}

/**
 * 带来源凭据的值。
 *
 * ★ `atMs` **不是**可选的：没有它，消费方就没法算出年龄，
 *   于是"这个价是刚拿的还是半小时前的"在数据里**无法表达**。
 */
export interface Sourced<T> {
  value: T
  /** 谁给的。**屏幕上要显示的就是它**，不是任何写死的名字。 */
  source: string
  /** 拿到它的时刻（本地时钟，`Date.now()`）。 */
  atMs: number
  /** 试过哪些源、各自什么下场（成功的那条也留着，便于事后核对顺序）。 */
  tried: SourceTry[]
}

/** 全部源都失败。★ 异常里**必须**带 `tried` —— 否则上层只能印一句"取不到"。 */
export class AllSourcesFailedError extends Error {
  readonly tried: SourceTry[]
  constructor(what: string, tried: SourceTry[]) {
    super(
      what +
        '：' +
        String(tried.length) +
        ' 个来源全都没答话（' +
        tried.map((t) => t.name + ' → ' + (t.error ?? '失败')).join('；') +
        '）',
    )
    this.name = 'AllSourcesFailedError'
    this.tried = tried
  }
}

/** 值太旧。★ 这是**拒收**，不是降级 —— 交易终端上"旧价格"与"当前价"长得一样。 */
export class StaleSourceError extends Error {
  readonly source: string
  readonly ageMs: number
  readonly maxAgeMs: number
  constructor(source: string, ageMs: number, maxAgeMs: number) {
    super(
      '来源「' +
        source +
        '」的数据已经 ' +
        String(Math.round(ageMs / 1000)) +
        ' 秒没更新了（上限 ' +
        String(Math.round(maxAgeMs / 1000)) +
        ' 秒）—— 不拿它当当前价用',
    )
    this.name = 'StaleSourceError'
    this.source = source
    this.ageMs = ageMs
    this.maxAgeMs = maxAgeMs
  }
}

// ── 健康账 ────────────────────────────────────────────────────────────
//
// ★ 进程内累积、**只增不删**。它是给"现在到底哪个源还能用"这个问题用的，
//   不是历史统计。因此 key 只能是有限的来源名集合（不是调用方输入），
//   不存在被遥控撑爆的风险（上游为此加了 LRU 上限，我们的 key 是常量集，不需要）。

const health = new Map<string, SourceHealth>()

function rec(name: string): SourceHealth {
  let h = health.get(name)
  if (!h) {
    h = { name, ok: 0, failed: 0, lastLatencyMs: null, avgLatencyMs: null, lastError: null }
    health.set(name, h)
  }
  return h
}

/** 记一次尝试。返回耗时，交给调用方放进 `tried`。 */
function record(name: string, ms: number, error: string | null): void {
  const h = rec(name)
  h.lastLatencyMs = ms
  h.avgLatencyMs = h.avgLatencyMs === null ? ms : Math.round(h.avgLatencyMs * 0.8 + ms * 0.2)
  if (error === null) {
    h.ok++
  } else {
    h.failed++
    h.lastError = error
  }
}

export function sourceHealth(): SourceHealth[] {
  return [...health.values()].map((h) => ({ ...h }))
}

/** 只给测试用：清空健康账，好让断言不依赖跑过几次。 */
export function resetSourceHealth(): void {
  health.clear()
}

// ── 回退链 ────────────────────────────────────────────────────────────

/**
 * 按顺序试，**取第一个成功的**；每个源都记健康账。
 *
 * ★ 失败的源**一个都不许吞**：它们的错误全部进 `tried`。
 *   "三个源全败"与"能力没有"与"名字烂了"看着都是"取不到"，
 *   但要做的事完全不相反 —— 逐条错误是唯一能分开它们的东西（判据 13）。
 */
export async function withSourceFallback<T>(
  what: string,
  attempts: SourceAttempt<T>[],
): Promise<Sourced<T>> {
  const tried: SourceTry[] = []
  for (const a of attempts) {
    const t0 = Date.now()
    try {
      const value = await a.run()
      const ms = Date.now() - t0
      record(a.name, ms, null)
      tried.push({ name: a.name, ms, ok: true, error: null })
      return { value, source: a.name, atMs: Date.now(), tried }
    } catch (e) {
      const ms = Date.now() - t0
      const msg = e instanceof Error ? e.message : String(e)
      record(a.name, ms, msg)
      tried.push({ name: a.name, ms, ok: false, error: msg })
    }
  }
  throw new AllSourcesFailedError(what, tried)
}

/**
 * 年龄上界检查。**超界抛异常**，不给"降级返回"的口子。
 *
 * ★ 为什么不做成"返回一个 stale 标记让调用方自己决定"：
 *   那样每一个消费点都要记得检查，忘一处就静默了（判据 24：不是随便哪一处说）。
 *   做成抛异常，唯一能绕过它的办法是显式 try/catch —— 那是一次**看得见**的让步。
 */
export function assertFresh<T>(s: Sourced<T>, maxAgeMs: number, now = Date.now()): void {
  const age = now - s.atMs
  if (age > maxAgeMs) throw new StaleSourceError(s.source, age, maxAgeMs)
}

/** 把年龄说成人话。屏幕上要用的就是它（"3 秒前"比时间戳有用）。 */
export function ageWords(atMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - atMs) / 1000))
  if (s < 2) return '刚刚'
  if (s < 60) return String(s) + ' 秒前'
  const m = Math.round(s / 60)
  if (m < 60) return String(m) + ' 分钟前'
  return String(Math.round(m / 60)) + ' 小时前'
}
