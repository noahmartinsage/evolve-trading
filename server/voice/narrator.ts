/**
 * 状态播报引擎（私人秘书的"嘴"）
 *
 * ── 它到底解决什么问题 ──────────────────────────────────────────────
 * 前端的图表假设用户**正盯着屏幕**：曲线在动、事件在滚、KPI 在跳。
 * 语音交互的前提正好相反 —— 用户不看屏幕，他在开车、在开会、在干别的。
 * 于是"现在的界面"对他等于不存在，他需要的是**被念出来的一句话**。
 *
 * ── 三个必须解决的矛盾 ──────────────────────────────────────────────
 * ① **要么不说、要么吵死。**
 *    状态每分钟都在变，全部念出来等于白噪音。所以有详略档位
 *    （alarm-only / normal / chatty）+ 同键冷却 + 全局限流，
 *    并且被限流压掉的内容会合并成一句"刚才有 N 条被合并"，
 *    而不是静默消失 —— 静默消失会让用户误判"系统没在动"。
 *
 * ② **报警会被普通消息挤掉。**
 *    限流天然是"先到先服务"的，一次日志风暴就能把熔断报警冲走。
 *    所以 P0 **不参与限流**，任何档位、任何静音状态都必须出声。
 *    这条是本模块最重要的不变量，烟测里有正反两向的断言。
 *
 * ③ **秘书可能"编话"。**
 *    它把结构化数据翻译成自然语言，而自然语言无法被机器核验 ——
 *    这是全系统最容易撒谎的组件。对策是**溯源**：每条播报都必须带上
 *    它是由账本第几号事件推出来的（`sourceSeq`），
 *    于是"播报必须能在审计链里找到出处"变成一条可自动断言的性质。
 *
 * ── 它绝不改状态 ────────────────────────────────────────────────────
 * 本模块**只读**。所有动作都在 `service.ts` 里走既有的风控与执行路径。
 * 播报器一旦获得"顺手做点事"的能力，就等于在风控之外多了一条
 * 无人审查的通道。
 */
import type { NarrationLine, NarrationPriority, NarrationCategory, Verbosity } from './types.ts'
import { observeTick as detectAnomalyTick, renderAnomaly, type AnomalyHit } from './anomaly.ts'

/** 工作状态快照 —— 由 service 从 autopilot 状态投影而来，本模块不自己去读。 */
export interface WorkStatusView {
  running: boolean
  /** 阶段的中文名（如「积累样本」「选优」）。 */
  stageLabel: string
  /** 下一步要做什么。用户明确要求播报的就是这一项。 */
  nextStep: string
  /** 当前在做什么的补充说明。 */
  activity?: string
  strategyId?: string | null
  targetPct?: number
  pnlPct?: number
  /** 若被门禁拒绝，这里是被拒的原因。 */
  gateRefusal?: string | null
}

export interface EquityView {
  equity: number
  starting: number
  peak: number
}

export interface NarratorDeps {
  workStatus: () => WorkStatusView
  equity: () => EquityView
}

/** 优先级排序权重。 */
const P_RANK: Record<NarrationPriority, number> = {
  P0_ALARM: 0,
  P1_IMPORTANT: 1,
  P2_STATUS: 2,
  P3_MARKET: 3,
}

export interface NarratorPolicy {
  verbosity: Verbosity
  /** 静音：只保留 P0。 */
  muted: boolean
}

export interface NarratorCounters {
  emitted: number
  emittedByPriority: Record<NarrationPriority, number>
  suppressedByMute: number
  suppressedByVerbosity: number
  suppressedByDedupe: number
  suppressedByRate: number
  /** 因限流被压掉、后被合并播报的总条数。 */
  coalesced: number
  /** 由异动检测器产出的播报条数。 */
  fromAnomaly: number
}

const DEDUPE_COOLDOWN_MS = 30_000
const RATE_WINDOW_MS = 60_000
/** 每分钟最多播报条数（不含 P0）。取值依据：正常时人一秒钟听 4~5 个字，一条播报约 15 字，一分钟最多也就 15~20 条有用信息。 */
const MAX_LINES_PER_MINUTE = 18
/** 周期性处境报告的间隔。 */
const SITUATION_INTERVAL_MS = 10 * 60_000

let deps: NarratorDeps | null = null
let policy: NarratorPolicy = { verbosity: 'normal', muted: false }

const outbox: NarrationLine[] = []
const recent: NarrationLine[] = []
const dedupeAt = new Map<string, number>()
const emittedAt: number[] = []
let lastStatusKey: string | null = null
let lastSituationAt = 0
let lineSeq = 0

const counters: NarratorCounters = {
  emitted: 0,
  emittedByPriority: { P0_ALARM: 0, P1_IMPORTANT: 0, P2_STATUS: 0, P3_MARKET: 0 },
  suppressedByMute: 0,
  suppressedByVerbosity: 0,
  suppressedByDedupe: 0,
  suppressedByRate: 0,
  coalesced: 0,
  fromAnomaly: 0,
}

export function configureNarrator(d: NarratorDeps | null): void {
  deps = d
}

export function setPolicy(patch: Partial<NarratorPolicy>): NarratorPolicy {
  policy = { ...policy, ...patch }
  return { ...policy }
}

export function getPolicy(): NarratorPolicy {
  return { ...policy }
}

/**
 * 当前档位是否允许该优先级通过（不含静音判定）。
 *
 * ★ `normal` 放行 P2_STATUS 的原因见 `Verbosity` 的类型注释：
 * 不放行它，桌宠就永远说不出"我在干什么、下一步干什么"，
 * 而那恰恰是这一层的核心能力 —— 曾经它被默认档静默丢掉了。
 *
 * P3_MARKET（盘面 mild 异动）刻意仍留在 `chatty`：它是参考信息，
 * 每次都报会把人逼到按静音，而静音是全局的、连报警一起关掉。
 */
function allowedByVerbosity(p: NarrationPriority): boolean {
  if (policy.verbosity === 'alarm-only') return p === 'P0_ALARM'
  if (policy.verbosity === 'normal') {
    return p === 'P0_ALARM' || p === 'P1_IMPORTANT' || p === 'P2_STATUS'
  }
  return true
}

/**
 * 直接播报一句话（不走账本事件分类表）。
 *
 * ── 为什么需要它，而不是给 `classify()` 再加几个 case ────────────────
 * `observeEvent` 的形状是「账本 kind → 一句固定文案」，适合**状态变化**。
 * 但工具执行过程中产生的是**过程叙述**（"开始了 → 拿到 N 条 → 过滤掉 M 条"），
 * 文案随本轮数据变化，塞进分类表就得为每种工具各写一遍。
 *
 * ★ 溯源仍然强制：`seq`/`kind` 必填，指向**已经落账**的那条事件。
 *   不填就不给播 —— 这一层最像"会撒谎的组件"，而"每条播报都能在审计链里
 *   找到出处"是本仓库唯一能自动断言它没说谎的性质（见 voice-smoke S9）。
 *   给一个"可以不填"的口子，等于给这条路开了一条静默降级。
 */
export function announce(input: {
  text: string
  category: NarrationCategory
  priority: NarrationPriority
  /** 已落账事件的 seq —— 强制溯源，不允许省略。 */
  seq: number
  kind: string
  /** 省略时用 `kind + text`，即"同一句话不重复说"。 */
  dedupeKey?: string
  ts?: number
}): NarrationLine | null {
  const ts = input.ts ?? Date.now()
  return enqueue({
    id: '',
    ts,
    priority: input.priority,
    category: input.category,
    text: input.text,
    sourceSeq: input.seq,
    sourceKind: input.kind,
    dedupeKey: input.dedupeKey ?? `${input.kind}:${input.text}`,
  })
}

/**
 * 入队。返回被真正采纳的播报（被抑制时返回 null）。
 *
 * 抑制顺序**故意是**：静音 → 档位 → 冷却 → 限流。
 * 因为前两者是"用户明确表示不想听"，后两者是"系统自己决定省着说"。
 * 顺序反了的话，一条被冷却抑制的播报也会去占用限流额度，
 * 于是 `suppressedByRate` 这个计数器就不再表示"真的因为太吵而丢"，
 * 一个失真的计数器比没有计数器更糟。
 */
function enqueue(line: NarrationLine): NarrationLine | null {
  const isAlarm = line.priority === 'P0_ALARM'

  // ① 静音：**只**放行报警
  if (policy.muted && !isAlarm) {
    counters.suppressedByMute += 1
    return null
  }
  // ② 档位
  if (!allowedByVerbosity(line.priority)) {
    counters.suppressedByVerbosity += 1
    return null
  }
  // ③ 冷却
  //
  // 必须用 `has` 区分「从未播过」与「上次播过」：把缺失值当 0 来比，
  // 等于认为每个新键"上一次播报发生在 epoch 0"，于是任何时间戳小于
  // 冷却窗的输入都会被静默吃掉。生产环境时间戳是 Date.now()（很大）
  // 所以看不出来 —— 这类"只在特定时间基准下才暴露"的错误，
  // 正是要靠能喂小时间戳的测试来抓。
  const prev = dedupeAt.get(line.dedupeKey)
  if (prev !== undefined && line.ts - prev < DEDUPE_COOLDOWN_MS && !isAlarm) {
    counters.suppressedByDedupe += 1
    return null
  }
  dedupeAt.set(line.dedupeKey, line.ts)

  // ④ 限流：**报警不参与**
  if (!isAlarm) {
    while (emittedAt.length > 0 && line.ts - emittedAt[0] > RATE_WINDOW_MS) emittedAt.shift()
    if (emittedAt.length >= MAX_LINES_PER_MINUTE) {
      counters.suppressedByRate += 1
      counters.coalesced += 1
      return null
    }
  }

  emittedAt.push(line.ts)
  lineSeq += 1
  const finalized: NarrationLine = { ...line, id: `n${lineSeq}` }
  outbox.push(finalized)
  recent.push(finalized)
  if (recent.length > 200) recent.splice(0, recent.length - 200)
  counters.emitted += 1
  counters.emittedByPriority[line.priority] += 1
  return finalized
}

/**
 * 账本事件 → 播报。
 *
 * 溯源是强制的：调用方必须把 `seq` 一起传进来，
 * 于是"每条播报都能在审计链里定位"由**签名**保证，而不是靠自觉。
 */
export function observeEvent(
  kind: string,
  payload: Record<string, unknown>,
  seq: number,
  ts = Date.now(),
): NarrationLine | null {
  const c = classify(kind, payload)
  if (!c) return null
  return enqueue({
    id: '',
    ts,
    priority: c.priority,
    category: c.category,
    text: c.text,
    detail: c.detail,
    sourceSeq: seq,
    sourceKind: kind,
    dedupeKey: c.dedupeKey,
  })
}

interface Classified {
  priority: NarrationPriority
  category: NarrationCategory
  text: string
  detail?: string
  dedupeKey: string
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN)
/**
 * 把任意值变成可朗读的字符串。
 *
 * ★ 对象**绝不允许**走 `String()` —— 那会得到 `[object Object]`，而这里的返回值
 * 是要进合成器出声的。这条不是理论风险：`SLO_BREACH` 的 `breaches` 就曾因为
 * 直接 `join` 念出过「服务指标越线 1 项：[object Object]。」（运行时实测抓到）。
 * 现在只把这一个收口函数做安全，是为了让"以后新增事件类型时忘了格式化"
 * 的后果从"念出 object Object"降级成"念出一段 JSON"，而不是让每个 case 各写一遍防御。
 * `test:voice` S12 则直接断言**已发播报文案里不得出现占位符垃圾**。
 */
const str = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return '[不可序列化]'
    }
  }
  return String(v)
}
const money = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—')

/**
 * 事件分类表。
 *
 * 全部取自**代码里真实存在的 kind**（对着 `appendEvent('...')` 挨个核过），
 * 没有一个是"我觉得应该有"。否则会出现两种坏结果：
 * 表里写了不存在的 kind（永远不触发，看着像已支持），
 * 或者漏了真实存在的 kind（报警静默丢失，且没有任何计数器会响）。
 */
function classify(kind: string, p: Record<string, unknown>): Classified | null {
  switch (kind) {
    // ─────────────────────────── P0：报警 ───────────────────────────
    case 'KILLSWITCH_ON':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `熔断已触发，已撤销 ${num(p.cancelledOrders) || 0} 笔挂单，所有新订单都会被拒绝。原因：${str(p.reason) || '风控触发'}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'KILLSWITCH_ON',
      }
    case 'RISK_CIRCUIT_BREAK':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `风险熔断：${str(p.reason)}。已停止接受新订单。`,
        detail: JSON.stringify(p),
        dedupeKey: `CIRCUIT:${str(p.clientOrderId)}`,
      }
    case 'ORDER_REJECT':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `有一笔订单被风控拒掉了：${str(p.reason)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `REJECT:${str(p.reason)}`,
      }
    case 'AUTOPILOT_ORDER_REJECTED':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `自动驾驶的${str(p.side) === 'buy' ? '买入' : '卖出'}单被拒：${str(p.reason)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `APR:${str(p.reason)}`,
      }
    case 'AUTOPILOT_OPTIMIZE_REFUSED':
      return {
        priority: 'P0_ALARM',
        category: 'gate',
        text: `自动驾驶的选优被过拟合门拦下了，${str(p.summary) || '证据不足'}。我会留在收集样本阶段，不会带着没验证过的策略上场。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_OPT_REFUSED',
      }
    case 'AUTOPILOT_DRAWDOWN_STOP':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `自动驾驶已因回撤触发而停机，当前收益 ${num(p.pnlPct).toFixed(2)}%，限额 ${num(p.limit).toFixed(2)}%。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_DD_STOP',
      }
    case 'RECONCILIATION_MISMATCH':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: '对账不一致：本地账本与柜台余额对不上，出站闸已关闭，实盘下单会被拦住。请先查对账。',
        detail: JSON.stringify(p),
        dedupeKey: 'RECON_MISMATCH',
      }
    case 'SLO_BREACH': {
      // `breaches` 是**对象数组**（`{key,label,value,limit,unit}`），不是字符串数组。
      // 直接 join 会得到「服务指标越线 1 项：[object Object]。」——而这句话是要被念出来的，
      // 用户听到的将是"object Object"。所以这里逐项格式化成人话。
      const raw = Array.isArray(p.breaches) ? p.breaches : []
      const items = raw.map((b) => {
        const o = (b ?? {}) as Record<string, unknown>
        const label = str(o.label) || str(o.key) || '未命名指标'
        const unit = str(o.unit)
        const val = typeof o.value === 'number' ? String(o.value) : str(o.value)
        const lim = typeof o.limit === 'number' ? String(o.limit) : str(o.limit)
        return `${label} ${val}${unit}（阈值 ${lim}${unit}）`
      })
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `服务指标越线 ${items.length} 项：${items.length > 0 ? items.join('；') : '未提供明细'}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'SLO_BREACH',
      }
    }
    case 'TESTNET_VIOLATION':
      return {
        priority: 'P0_ALARM',
        category: 'risk-alarm',
        text: `测试网演练发现违规：${str(p.reason)}。该策略不会进入实盘。`,
        detail: JSON.stringify(p),
        dedupeKey: 'TESTNET_VIOLATION',
      }
    case 'AUTOPILOT_OVERFIT_GATE': {
      const outcome = str(p.outcome ?? p.verdict ?? '')
      const pass = outcome === 'PASS' || p.pass === true
      if (pass) {
        return {
          priority: 'P1_IMPORTANT',
          category: 'gate',
          text: `过拟合门通过了，PBO ${num(p.pbo).toFixed(3)}，可以进入实盘候选。`,
          detail: JSON.stringify(p),
          dedupeKey: 'AP_GATE_PASS',
        }
      }
      return {
        priority: 'P0_ALARM',
        category: 'gate',
        text: `过拟合门没通过：${str(p.summary) || `PBO ${num(p.pbo).toFixed(3)}`}。这说明候选策略很可能是拟合出来的，我不会用它。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_GATE_FAIL',
      }
    }

    // ───────────────────────── P1：重要事件 ─────────────────────────
    case 'ORDER_FILL':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `成交：${str(p.side) === 'buy' ? '买入' : '卖出'} ${str(p.symbol)} 数量 ${num(p.qty)}，价格 ${num(p.price)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `FILL:${str(p.fillId ?? p.clientOrderId)}`,
      }
    case 'ORDER_CANCEL':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `已撤单 ${str(p.clientOrderId)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `CANCEL:${str(p.clientOrderId)}`,
      }
    case 'AUTOPILOT_STRATEGY_SELECTED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `选好策略了：${str(p.strategyId) || str(p.family) || '候选策略'}，接下来按它执行。`,
        detail: JSON.stringify(p),
        dedupeKey: `AP_SEL:${str(p.strategyId)}`,
      }
    case 'AUTOPILOT_STARTED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `自动驾驶已启动，目标 ${num(p.targetPct).toFixed(2)}%，基准权益 ${money(num(p.baselineEquity))}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_STARTED',
      }
    case 'AUTOPILOT_STOPPED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `自动驾驶已停止。原因：${str(p.reason)}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_STOPPED',
      }
    case 'AUTOPILOT_TARGET_REACHED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `目标达成，收益 ${num(p.pnlPct).toFixed(2)}%，共 ${num(p.cycles)} 轮。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_TARGET',
      }
    case 'AUTOPILOT_POSITION_OPENED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `开了新仓：${str(p.symbol)} ${str(p.side) === 'buy' ? '做多' : '做空'}，数量 ${num(p.qty)}，止损 ${num(p.stopPrice)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `AP_OPEN:${str(p.symbol)}`,
      }
    case 'AUTOPILOT_STRATEGY_EXIT':
    case 'AUTOPILOT_FLATTEN':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `已平仓出场：${str(p.symbol) || ''} ${str(p.reason) || str(p.trigger) || ''}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_EXIT',
      }
    case 'AUTOPILOT_STOP_MOVED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `止损已上移，锁定更多利润。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_STOP_MOVED',
      }
    case 'AUTOPILOT_SCALE_IN':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `按金字塔规则加了一次仓。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_SCALE_IN',
      }
    case 'KILLSWITCH_OFF':
      return {
        priority: 'P1_IMPORTANT',
        category: 'risk-alarm',
        text: '熔断已解除，恢复接受订单。请确认风险已经处理完。',
        detail: JSON.stringify(p),
        dedupeKey: 'KILLSWITCH_OFF',
      }
    case 'LEDGER_SYNCED_TO_VENUE':
      return {
        priority: 'P1_IMPORTANT',
        category: 'risk-alarm',
        text: `本地账本已与柜台对齐：现金 ${money(num(p.venueCash))}，持仓 ${num(p.positions) || 0} 个。`,
        detail: JSON.stringify(p),
        dedupeKey: 'LEDGER_SYNCED',
      }
    case 'VENUE_CANCEL_ALL':
      return {
        priority: 'P1_IMPORTANT',
        category: 'order',
        text: `柜台侧已撤销全部挂单，共 ${num(p.cancelledOrders) || 0} 笔。`,
        detail: JSON.stringify(p),
        dedupeKey: 'VENUE_CANCEL_ALL',
      }
    case 'PROMOTION_STAGE':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `策略 ${str(p.id)} 的晋升阶段从 ${str(p.from)} 变到 ${str(p.to)}${str(p.reason) ? `，原因：${str(p.reason)}` : ''}。`,
        detail: JSON.stringify(p),
        dedupeKey: `PROMO:${str(p.id)}:${str(p.to)}`,
      }
    case 'OVERFIT_VERDICT':
      return {
        priority: 'P1_IMPORTANT',
        category: 'gate',
        text: `过拟合判定结论：${str(p.outcome) || str(p.verdict)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `OVERFIT:${str(p.strategyId)}`,
      }
    case 'VERIFIER_VERDICT':
      return {
        priority: 'P1_IMPORTANT',
        category: 'gate',
        text: `核验器出了结论：${str(p.verdict) || str(p.outcome)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `VERIFIER:${str(p.verdict)}`,
      }
    case 'RECONCILIATION_CLEARED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'risk-alarm',
        text: '对账已恢复一致，出站闸重新打开。',
        detail: JSON.stringify(p),
        dedupeKey: 'RECON_CLEARED',
      }
    case 'RISK_PARAMS_UPDATED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'risk-alarm',
        text: `风控参数被改动过，共 ${Array.isArray(p.keys) ? p.keys.length : num(p.count) || 0} 项。改动风控要留意。`,
        detail: JSON.stringify(p),
        dedupeKey: 'RISK_PARAMS_UPDATED',
      }
    case 'TESTNET_VERIFICATION_STARTED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `开始测试网演练，策略 ${str(p.strategyId)}，场所 ${str(p.venue)}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'TESTNET_START',
      }
    case 'TESTNET_VERIFICATION_CLOSED':
      return {
        priority: 'P1_IMPORTANT',
        category: 'work-state',
        text: `测试网演练结束，策略 ${str(p.strategyId)} 的验证${str(p.passed) === 'true' || p.passed === true ? '通过' : '未通过'}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'TESTNET_CLOSED',
      }

    // ───────────────────────── P2：工作状态 ─────────────────────────
    case 'AUTOPILOT_PIN_REJECTED':
      return {
        priority: 'P2_STATUS',
        category: 'work-state',
        text: `有人要求固定策略，但参数不合法，我没有采纳：${str(p.reason)}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_PIN_REJECTED',
      }
    case 'AUTOPILOT_OPTIMIZE_FAILED':
      return {
        priority: 'P2_STATUS',
        category: 'work-state',
        text: `这一轮选优没产生可用结果：${str(p.reason)}。我会继续积累样本再试。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_OPT_FAILED',
      }
    case 'AUTOPILOT_SIGNAL_IGNORED':
      return {
        priority: 'P2_STATUS',
        category: 'work-state',
        text: `有一个信号被我忽略了：${str(p.reason) || str(p.code) || '不满足入场条件'}。`,
        detail: JSON.stringify(p),
        dedupeKey: 'AP_SIGNAL_IGNORED',
      }
    case 'AUTOPILOT_INTERCEPTED':
      return {
        priority: 'P2_STATUS',
        category: 'work-state',
        text: `拦截器挡下了一次开仓：${str(p.reason)}。`,
        detail: JSON.stringify(p),
        dedupeKey: `AP_INTERCEPTED:${str(p.code)}`,
      }
    default:
      return null
  }
}

// ───────────────────────── 盘面异动 ─────────────────────────

export function observeTick(symbol: string, price: number, ts = Date.now()): NarrationLine | null {
  const hit: AnomalyHit | null = detectAnomalyTick(symbol, price, ts)
  if (!hit) return null
  const line = enqueue({
    id: '',
    ts: hit.ts,
    priority: hit.severity === 'strong' ? 'P0_ALARM' : 'P3_MARKET',
    category: 'market-anomaly',
    text: renderAnomaly(hit),
    detail: JSON.stringify(hit),
    sourceKind: 'PRICE_TICK',
    dedupeKey: `ANOMALY:${hit.symbol}:${hit.direction}`,
  })
  if (line) counters.fromAnomaly += 1
  return line
}

// ───────────────────────── 状态与处境播报 ─────────────────────────

/**
 * 周期性状态播报 —— 「我正在干什么、下一步干什么」就是这一条。
 *
 * 用**变化驱动**而不是定时驱动：只有在阶段/下一步/门禁状态真的变了的时候才出声。
 * 定时播报会在什么都没发生时反复念同一句，用户第一次觉得贴心，
 * 第三次就会去按静音 —— 而静音是全局的，连报警一起关掉。
 * 把用户逼到静音，是这类功能最典型的自毁路径。
 */
export function tickStatus(now = Date.now()): NarrationLine | null {
  if (!deps) return null
  const w = deps.workStatus()
  if (!w.running) {
    lastStatusKey = null
    lastSituationAt = 0
    return null
  }
  const key = [w.stageLabel, w.nextStep, w.gateRefusal ?? '', w.strategyId ?? ''].join('|')

  // 每隔一段时间补一次"处境报告"，即使状态没变 —— 让长时间静默的用户知道系统还活着
  const dueSituation = now - lastSituationAt >= SITUATION_INTERVAL_MS
  if (key === lastStatusKey && !dueSituation) return null

  const eq = deps.equity()
  const pnlPct = eq.starting > 0 ? ((eq.equity - eq.starting) / eq.starting) * 100 : 0
  const parts = [
    `我现在在${w.stageLabel}${w.activity ? `：${w.activity}` : ''}。`,
    `下一步${w.nextStep}。`,
  ]
  if (w.gateRefusal) parts.push(`提醒一下，${w.gateRefusal}。`)
  parts.push(`当前权益 ${money(eq.equity)}，相对起点 ${pnlPct >= 0 ? '盈' : '亏'} ${Math.abs(pnlPct).toFixed(2)}%。`)

  const line = enqueue({
    id: '',
    ts: now,
    priority: 'P2_STATUS',
    category: 'work-state',
    text: parts.join(''),
    detail: JSON.stringify({ stageLabel: w.stageLabel, nextStep: w.nextStep, gateRefusal: w.gateRefusal, pnlPct }),
    sourceKind: 'AUTOPILOT_STATUS_PROBE',
    dedupeKey: `STATUS:${key}`,
  })
  // 只有真的播出去了才推进游标 —— 否则这条处境报告会被自己的去重键挡掉，永远补不上
  if (line) {
    lastStatusKey = key
    if (dueSituation) lastSituationAt = now
  }
  return line
}

/**
 * 把因限流被压掉的条数合并成一句。
 *
 * 这一句存在的理由是**不能静默丢弃**：用户听到的沉默必须能被区分成
 * 「系统没事」和「系统刚才很忙但被限流了」。少了它，用户会以为一切正常，
 * 而实际上有十几条状态更新没被念出来。
 */
export function tickCoalescedHint(now = Date.now()): NarrationLine | null {
  const n = counters.coalesced
  if (n <= 0) return null
  const line = enqueue({
    id: '',
    ts: now,
    priority: 'P2_STATUS',
    category: 'work-state',
    text: `刚才有 ${n} 条状态更新太密，我合并没说，避免吵到你。要看细节可以问我。`,
    detail: JSON.stringify({ coalesced: n }),
    sourceKind: 'NARRATOR_RATE_LIMIT',
    dedupeKey: `COALESCED:${Math.floor(now / RATE_WINDOW_MS)}`,
  })
  if (line) counters.coalesced = 0
  return line
}

/** 周期性调度入口：先补合并提示，再报状态。 */
export function tickNarration(now = Date.now()): number {
  let n = 0
  if (tickCoalescedHint(now)) n += 1
  if (tickStatus(now)) n += 1
  return n
}

/**
 * 直接产出一次处境报告（用户问「你在干什么」时用，绕过去重）。
 *
 * 刻意**不**接 `now` 参数：这条文案全部来自实时状态源，没有一处依赖传入时间；
 * 留一个不用的时间参数会让人以为它参与了什么判断（F-46 那类"注释描述的不是在跑的逻辑"）。
 */
export function renderStatusNow(): string {
  if (!deps) return '我还不知道自己该干什么，工作状态源没接上。'
  const w = deps.workStatus()
  const eq = deps.equity()
  const pnlPct = eq.starting > 0 ? ((eq.equity - eq.starting) / eq.starting) * 100 : 0
  if (!w.running) {
    return `自动驾驶现在是停着的。当前权益 ${money(eq.equity)}，相对起点 ${pnlPct >= 0 ? '盈' : '亏'} ${Math.abs(pnlPct).toFixed(2)}%。你说一声继续，我就接着跑。`
  }
  const gate = w.gateRefusal ? `另外，${w.gateRefusal}。` : ''
  return `我在${w.stageLabel}${w.activity ? `，${w.activity}` : ''}。下一步${w.nextStep}。${gate}当前权益 ${money(eq.equity)}，相对起点 ${pnlPct >= 0 ? '盈' : '亏'} ${Math.abs(pnlPct).toFixed(2)}%。`
}

// ───────────────────────── 取用 ─────────────────────────

/**
 * 按优先级取走待播内容。
 *
 * 排序是稳定意义上的「先按优先级、再按时间」：同一个 P0 报警不能因为
 * 晚到了 2 秒就被排在一条 P2 状态更新后面 —— 用户耳朵能忍的顺序，
 * 和日志能忍的顺序不是一回事。
 */
export function drain(limit = 10): NarrationLine[] {
  outbox.sort((a, b) => P_RANK[a.priority] - P_RANK[b.priority] || a.ts - b.ts)
  return outbox.splice(0, limit)
}

export function recentNarrations(limit = 50): NarrationLine[] {
  return recent.slice(-limit)
}

export function narratorCounters(): NarratorCounters & { queued: number; policy: NarratorPolicy } {
  return { ...counters, emittedByPriority: { ...counters.emittedByPriority }, queued: outbox.length, policy: { ...policy } }
}

export function resetNarrator(): void {
  outbox.length = 0
  recent.length = 0
  dedupeAt.clear()
  emittedAt.length = 0
  lastStatusKey = null
  lastSituationAt = 0
  lineSeq = 0
  counters.emitted = 0
  counters.emittedByPriority = { P0_ALARM: 0, P1_IMPORTANT: 0, P2_STATUS: 0, P3_MARKET: 0 }
  counters.suppressedByMute = 0
  counters.suppressedByVerbosity = 0
  counters.suppressedByDedupe = 0
  counters.suppressedByRate = 0
  counters.coalesced = 0
  counters.fromAnomaly = 0
  policy = { verbosity: 'normal', muted: false }
  deps = null
}
