/**
 * Agent 舰队的实况、调度与凭据
 *
 * ── 三件事，一件也不能少 ────────────────────────────────────────────
 * ① `fleetSnapshot()` —— 面板与语音读的**唯一**实况来源。每个成员的状态
 *    （跑过没有 / 跑成没有 / 多久 / 最近一句产出）全部**从账本现算**，
 *    没有任何一个是写在代码里的常量。这是替换掉原来那批演示数字的关键：
 *    写死的数字看起来也很像真的，所以"真数字"必须能被追溯到一条账本事件。
 *
 * ② `runAgent()` —— 单成员真实执行。它做三件确定的事：
 *    · `act` 类**必须**带 `confirmed`，否则当场拒绝（与语音层同一套两段式确认）；
 *    · 无论成败都落一条 `FLEET_AGENT_RUN` 事件 —— **失败也要留痕**，
 *      否则"这个成员从来没成功过"与"这个成员从来没被跑过"长得一模一样；
 *    · 把产出**发布到总线**，让下游真的收到（这是"协同"的物理形态）。
 *
 * ③ `runTask()` —— 一句话 → 一串真实动作。这一层最要紧的一条是
 *    **链路可断**：声明了上游依赖的成员若没收到输入，必须**失败**而不是
 *    空着参数跑完然后报成功。判据很直白 —— 一个"输入缺失却照样成功"的
 *    执行器会把整条链的结论变成噪声，而且它报绿。
 */
import { appendEvent, getEvents } from '../ledger.ts'
import { auditFleetRegistry, installSubscriptions, type FleetProblem } from './registry.ts'
import { FLEET_AGENTS, fleetAgent } from './agents.ts'
import { inboxOf, publish, busStats, recentMessages, resetBus, topicSubscribers } from './bus.ts'
import { FLEET_TOPICS, fleetConsumer, type FleetAgent, type FleetMessage, type FleetRunArg } from './types.ts'
import { bindAutonomyRunner } from './autonomy.ts'

// ─────────────────────────── 实况 ───────────────────────────

export interface FleetAgentView {
  id: string
  label: string
  duty: string
  kind: 'read' | 'act'
  cost: string
  /** ★ 复用哪条既有路径 —— 面板上要看得见，用户才知道它不是在旁边另长一套。 */
  reuses: string
  output: string
  /** ★ 谁读它的输出。空数组在过去意味着孤岛；现在注册表不允许它存在。 */
  consumers: { id: string; label: string; kind: string }[]
  emits: string[]
  consumes: string[]
  /** 'never' 不是"健康"，是"还没跑过"。两者在面板上必须长得不一样。 */
  state: 'never' | 'ok' | 'failed'
  runCount: number
  okCount: number
  failCount: number
  lastRun: { at: number; ok: boolean; summary: string; durationMs: number; dryRun: boolean } | null
  inbox: { topic: string; msgId: string; from: string; note: string; ts: number }[]
}

export interface FleetSnapshot {
  generatedAt: number
  registry: { agents: number; problems: FleetProblem[] }
  bus: { topics: number; subscriptions: number; messages: number; subscribers: Record<string, string[]> }
  agents: FleetAgentView[]
  recentMessages: { id: string; topic: string; from: string; ts: number; taskId: string | null }[]
  lastTask: FleetTaskReceipt | null
  /** ★ 这一页的数字**来自哪里**。过去这里放的是"演示数据"横幅，现在必须放出处。 */
  provenance: string
}

interface AgentRunPayload {
  agentId: string
  taskId: string | null
  ok: boolean
  dryRun: boolean
  durationMs: number
  summary: string
  reason?: string
  inputFrom: string[]
  emitted: string[]
}

function readRunEvents(): (AgentRunPayload & { at: number })[] {
  return getEvents(0)
    .filter((e) => e.kind === 'FLEET_AGENT_RUN')
    .map((e) => ({ ...(e.payload as unknown as AgentRunPayload), at: e.ts }))
}

/** 让注册表与总线在进程内就绪。幂等：重复调用只是重复装同一批订阅。 */
let installed = false
export function ensureFleetInstalled(): void {
  if (installed) return
  installSubscriptions(FLEET_AGENTS)
  installed = true
}

/** 仅供测试：清空总线并允许重新安装。生产代码不应调用（会丢掉在途协同）。 */
export function __resetFleetForTest(): void {
  resetBus()
  installed = false
}

export function fleetSnapshot(): FleetSnapshot {
  ensureFleetInstalled()
  const runs = readRunEvents()
  const problems = auditFleetRegistry()
  const subscribers: Record<string, string[]> = {}
  for (const t of FLEET_TOPICS) subscribers[t.id] = topicSubscribers(t.id)

  const agents: FleetAgentView[] = FLEET_AGENTS.map((a) => {
    const mine = runs.filter((r) => r.agentId === a.id)
    const last = mine.length > 0 ? mine[mine.length - 1] : null
    return {
      id: a.id,
      label: a.label,
      duty: a.duty,
      kind: a.kind,
      cost: a.cost,
      reuses: a.reuses,
      output: a.output,
      consumers: a.consumers.map((cid) => {
        const c = fleetConsumer(cid)
        return { id: cid, label: c?.label ?? cid, kind: c?.kind ?? 'unknown' }
      }),
      emits: [...a.emits],
      consumes: [...(a.consumes ?? [])],
      state: last ? (last.ok ? 'ok' : 'failed') : 'never',
      runCount: mine.length,
      okCount: mine.filter((r) => r.ok).length,
      failCount: mine.filter((r) => !r.ok).length,
      lastRun: last
        ? { at: last.at, ok: last.ok, summary: last.summary, durationMs: last.durationMs, dryRun: last.dryRun }
        : null,
      inbox: inboxOf(a.id).slice(0, 8),
    }
  })

  const okRuns = runs.filter((r) => r.ok).length
  const provenance =
    runs.length === 0
      ? '这张表上还没有任何一次真实运行的记录 —— 所有成员现在都是「没跑过」，不是「在跑」。点「跑一次」或让舰队做个任务，这里才会有数字。'
      : `本页所有状态来自账本里 ${runs.length} 条 FLEET_AGENT_RUN 事件（成功 ${okRuns} 条），` +
        `消息来自总线 ${busStats().messages} 条投递记录。没有任何一个数字是写在代码里的常量。`

  return {
    generatedAt: Date.now(),
    registry: { agents: FLEET_AGENTS.length, problems },
    bus: { ...busStats(), subscribers },
    agents,
    recentMessages: recentMessages(12).map((m) => ({ id: m.id, topic: m.topic, from: m.from, ts: m.ts, taskId: m.taskId })),
    lastTask: lastTaskReceipt,
    provenance,
  }
}

// ─────────────────────────── 单成员执行 ───────────────────────────

export interface FleetEmitted {
  topic: string
  msgId: string
  deliveredTo: string[]
  /** 真实发出的载荷。下游吃到的就是它，所以必须原样带回来（否则凭据里的"发了什么"是编的）。 */
  payload: Record<string, unknown>
}

export interface FleetRunReceipt {
  agentId: string
  label: string
  ok: boolean
  summary: string
  steps: string[]
  reason?: string
  durationMs: number
  dryRun: boolean
  /** 这一次发出去的消息。空的说明没有下游能收到 —— 那是一条要修的问题。 */
  emitted: FleetEmitted[]
  /** 吃进来的上游消息 id。 */
  inputFrom: string[]
  detail?: unknown
}

/**
 * 跑一个成员。**不抛异常** —— 任何异常都变成 `{ ok:false, reason }`。
 * 理由：调用它的路径包括语音与 HTTP，一条抛出的异常在那两处都只会变成
 * 一句"出错了"，而"出错了"既不能念给用户听，也定位不了。
 */
export async function runAgent(
  id: string,
  arg: FleetRunArg & { taskId?: string } = {},
  agents: readonly FleetAgent[] = FLEET_AGENTS,
): Promise<FleetRunReceipt> {
  ensureFleetInstalled()
  const a = agents.find((x) => x.id === id) ?? fleetAgent(id)
  if (!a) {
    return {
      agentId: id,
      label: id,
      ok: false,
      summary: `舰队里没有「${id}」这个成员。`,
      steps: [],
      reason: `UNKNOWN_AGENT：合法成员是 ${agents.map((x) => x.id).join('、')}`,
      durationMs: 0,
      dryRun: arg.dryRun ?? false,
      emitted: [],
      inputFrom: [],
    }
  }

  // ★ 两段式确认。act 类会改变系统状态（写因子台账 / 写策略台账 / 写候选），
  //   与语音层的下单走同一套语义：没有显式确认就不执行。
  if (a.kind === 'act' && arg.confirmed !== true) {
    const receipt: FleetRunReceipt = {
      agentId: a.id,
      label: a.label,
      ok: false,
      summary: `「${a.label}」是要改系统状态的动作，我没有替你确认，所以没有执行。`,
      steps: [],
      reason: `NEEDS_CONFIRMATION：${a.label} 属于 act 类（intent=${a.intent}），需要显式确认后才执行`,
      durationMs: 0,
      dryRun: arg.dryRun ?? false,
      emitted: [],
      inputFrom: arg.inputFrom ?? [],
    }
    appendEvent('FLEET_AGENT_RUN', {
      agentId: a.id,
      taskId: arg.taskId ?? null,
      ok: false,
      dryRun: receipt.dryRun,
      durationMs: 0,
      summary: receipt.summary,
      reason: receipt.reason,
      inputFrom: receipt.inputFrom,
      emitted: [],
    } satisfies AgentRunPayload)
    return receipt
  }

  const startedAt = Date.now()
  let raw
  try {
    raw = await a.run({ ...arg, confirmed: arg.confirmed === true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const durationMs = Date.now() - startedAt
    const receipt: FleetRunReceipt = {
      agentId: a.id,
      label: a.label,
      ok: false,
      summary: `「${a.label}」跑到一半报错了，我没有重试 —— 重试之前得先知道为什么错。`,
      steps: [`调用 ${a.reuses.split('（')[0]}`],
      reason: `RUN_THREW：${msg.slice(0, 200)}`,
      durationMs,
      dryRun: arg.dryRun ?? false,
      emitted: [],
      inputFrom: arg.inputFrom ?? [],
    }
    appendEvent('FLEET_AGENT_RUN', {
      agentId: a.id,
      taskId: arg.taskId ?? null,
      ok: false,
      dryRun: receipt.dryRun,
      durationMs,
      summary: receipt.summary,
      reason: receipt.reason,
      inputFrom: receipt.inputFrom,
      emitted: [],
    } satisfies AgentRunPayload)
    return receipt
  }

  // 产出发布到总线。只允许发到本成员 `emits` 里登记过的主题 ——
  // 发到没登记的频道上，等于把产出丢进一个谁也不知道的桶。
  const emitted: FleetEmitted[] = []
  for (const topic of Object.keys(raw.outputs)) {
    if (!a.emits.includes(topic)) continue
    const r = publish({ topic, from: a.id, payload: raw.outputs[topic], taskId: arg.taskId ?? null })
    emitted.push({ topic, msgId: r.message.id, deliveredTo: r.deliveries.map((d) => d.owner), payload: r.message.payload })
  }

  const durationMs = Date.now() - startedAt
  appendEvent('FLEET_AGENT_RUN', {
    agentId: a.id,
    taskId: arg.taskId ?? null,
    ok: raw.ok,
    dryRun: arg.dryRun ?? false,
    durationMs,
    summary: raw.summary,
    reason: raw.reason,
    inputFrom: arg.inputFrom ?? [],
    emitted: emitted.map((e) => e.topic),
  } satisfies AgentRunPayload)

  return {
    agentId: a.id,
    label: a.label,
    ok: raw.ok,
    summary: raw.summary,
    steps: raw.steps,
    reason: raw.reason,
    durationMs,
    dryRun: arg.dryRun ?? false,
    emitted,
    inputFrom: arg.inputFrom ?? [],
    detail: raw.detail,
  }
}

// ─────────────────────────── 任务调度 ───────────────────────────

export interface FleetTaskStepView {
  agentId: string
  label: string
  ok: boolean
  summary: string
  reason?: string
  durationMs: number
  /** 吃进来的上游消息 id。 */
  inputFrom: string[]
  /** 是否是"独立核对"（本步与上游没有任何主题交集，因此不要求输入）。 */
  independent: boolean
  emitted: FleetEmitted[]
  dryRun: boolean
}

export interface FleetTaskReceipt {
  taskId: string
  goal: string
  /** 调度理由：为什么这几个成员、这个顺序。**必须给人看得懂**。 */
  why: string
  steps: FleetTaskStepView[]
  ok: boolean
  failedAt: string | null
  /** 未执行的原因（例如缺确认、没听懂）。有值时 `steps` 一定是空的。 */
  refusal: string | null
  startedAt: number
  finishedAt: number
  durationMs: number
  ledgerEvents: number
  messageCount: number
}

// ─────────────────────────── 任务规划 ───────────────────────────
//
// ★ 计划表与 planTask **已搬到 ./plans.ts**。搬家的理由不是整洁：
//   语音层要判"这句话是不是派活"，而它若 import 本模块就会连带拉进
//   autopilot / factorService / pipelineService —— 于是它当初干脆绕开这里、
//   自己写了一份白名单，造出两条口径（实测后果：「检查文件是否有用」
//   舰队能接、语音说听不懂）。抽到 plans.ts 之后，语音层与 HTTP 层调的是同一个函数。
export { FLEET_TASK_PLANS, planTask, planLabelList, planNeedsConfirm, undoPlanOf, looksInterrogative, type TaskPlan, type PlanResult } from './plans.ts'
import { planTask } from './plans.ts'


let lastTaskReceipt: FleetTaskReceipt | null = null

/**
 * 把自治循环的执行器接上。**单向依赖**：本模块 → `autonomy.ts`。
 *
 * ★ 为什么用注入而不是让 `autonomy.ts` 直接 import 本模块的 `runTask`：
 *   `agents.ts` 要提供"启动/停止自治循环"这两个成员，于是它 import `autonomy.ts`；
 *   而 `agents.ts` 又被本模块 import —— 直接 import 会成环。
 *   注入把这条边拆掉，同时也让 `autonomy.ts` 能离线测试（换时钟、换执行器）。
 *
 * ★ 放在模块顶层而不是"启动序列"里：不经过 `server/index.ts` 的进程
 *   （烟测、探针、桌宠独立进程）也 import 本模块，放在启动序列里它们就拿不到执行器，
 *   表现是自治循环每轮安静地失败 —— 与"环境自举必须挂在读取侧"是同一条教训。
 */
bindAutonomyRunner(async (goal, opts) => {
  const r = await runTask(goal, opts)
  // ★ 转成"一句可念的话"再交给循环：循环把这句话写进账本与面板，
  //   而 `FleetTaskReceipt` 是一份结构（steps / refusal / 计数），
  //   直接塞进去会变成面板上的一坨 JSON。`renderTaskBrief` 是既有的
  //   唯一渲染口 —— 复用它，别再写一份"把凭据说成人话"的逻辑。
  return { ok: r.ok, summary: renderTaskBrief(r) }
})

export function fleetLastTask(): FleetTaskReceipt | null {
  return lastTaskReceipt
}

/**
 * 跑一个任务。
 *
 * ★ 断链即失败（本函数最要紧的一条）：某一步声明了 `consumes`，而它消费的
 * 主题**恰好落在前面某一步的 `emits` 里**（说明这条链本来就打算喂它），
 * 那么它必须真的收到消息；收不到就当场失败 `NO_UPSTREAM_INPUT`。
 * 反过来，如果它的 `consumes` 与上游 `emits` 没有交集（比如巡检里的决策观察员），
 * 那就是**独立核对**，允许没有输入 —— 但这一步会被标成 `independent: true`
 * 写进凭据，不静默。
 */
export async function runTask(
  goal: string,
  opts: { confirmed?: boolean; dryRun?: boolean; agents?: readonly FleetAgent[] } = {},
): Promise<FleetTaskReceipt> {
  const agents = opts.agents ?? FLEET_AGENTS
  ensureFleetInstalled()
  const startedAt = Date.now()
  const eventsBefore = getEvents(0).length
  const msgsBefore = busStats().messages
  const taskId = `T${startedAt.toString(36)}`

  const { plan, why } = planTask(goal)
  const refuse = (refusal: string, whyText: string): FleetTaskReceipt => {
    const receipt: FleetTaskReceipt = {
      taskId,
      goal,
      why: whyText,
      steps: [],
      ok: false,
      failedAt: null,
      refusal,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      ledgerEvents: 0,
      messageCount: 0,
    }
    lastTaskReceipt = receipt
    appendEvent('FLEET_TASK', { taskId, goal, ok: false, reason: refusal })
    return receipt
  }

  if (!plan) return refuse('NO_PLAN', why)

  // act 类成员必须先拿到确认。**在跑之前一次性检查**，而不是跑到那一步才拒绝 ——
  // 否则前半段已经改了系统状态，后半段才说不许跑，用户面对的是一个改了一半的系统。
  const actAgents = plan.chain
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is FleetAgent => a !== undefined && a.kind === 'act')
  if (actAgents.length > 0 && opts.confirmed !== true) {
    return refuse(
      'NEEDS_CONFIRMATION',
      `${plan.why}\n这一次没有执行：链上有需要确认的动作成员（${actAgents.map((a) => a.label).join('、')}）。`,
    )
  }

  const steps: FleetTaskStepView[] = []
  // 本任务内已发布的消息，按主题归档 —— 这是"下游吃上游"的唯一来源。
  const inbox = new Map<string, FleetMessage[]>()

  for (let i = 0; i < plan.chain.length; i++) {
    const a = agents.find((x) => x.id === plan.chain[i])
    if (!a) {
      steps.push({
        agentId: plan.chain[i],
        label: plan.chain[i],
        ok: false,
        summary: `计划里的成员「${plan.chain[i]}」不在注册表里。`,
        reason: 'PLAN_AGENT_MISSING',
        durationMs: 0,
        inputFrom: [],
        independent: false,
        emitted: [],
        dryRun: opts.dryRun ?? false,
      })
      break
    }

    // ★ 上下游关系按**上游声明的 `emits`** 算，不能按"实际发出去的主题"算。
    //   按实际发的算有一个致命盲区（烟测 F5 当场抓到）：上游声明了要发、
    //   却因为一个 bug 静默没发时，下游会被自动归入"本来就不需要输入"，
    //   于是**一个"上游坏了"的故障在观测上变得与"这里没有上下游"一模一样**，
    //   整条链路照样报成功。链路可断的前提是"本该喂我的东西没到"能被认出来，
    //   而"本该"只能来自声明。
    const upstreamIds = plan.chain.slice(0, i)
    const plannedTopics = new Set(upstreamIds.flatMap((id) => agents.find((x) => x.id === id)?.emits ?? []))
    const consumes = a.consumes ?? []
    const overlap = i > 0 ? consumes.filter((t) => plannedTopics.has(t)) : []
    const received = overlap.flatMap((t) => inbox.get(t) ?? [])
    const independent = i > 0 && overlap.length === 0

    if (overlap.length > 0 && received.length === 0) {
      // ★ 断链。上游本该喂它，但一条消息都没到 —— 必须失败，不许空着参数跑。
      steps.push({
        agentId: a.id,
        label: a.label,
        ok: false,
        summary: `「${a.label}」没有拿到上游产出，所以我停在这里了 —— 空着输入跑完只会给出一个看着成功的假结果。`,
        reason: `NO_UPSTREAM_INPUT：本任务里没有 ${overlap.join('、')} 主题的消息（上游 ${upstreamIds.join('、')} 声明了要发它）`,
        durationMs: 0,
        inputFrom: [],
        independent: false,
        emitted: [],
        dryRun: opts.dryRun ?? false,
      })
      appendEvent('FLEET_TASK_STEP_BLOCKED', { taskId, agentId: a.id, missingTopics: overlap, upstreamIds })
      break
    }

    const inputs: Record<string, Record<string, unknown>> = {}
    for (const m of received.slice(-8)) inputs[`${m.topic}#${m.id}`] = m.payload

    const r = await runAgent(
      a.id,
      {
        confirmed: opts.confirmed === true,
        dryRun: opts.dryRun ?? false,
        inputs,
        inputFrom: received.map((m) => m.id),
        taskId,
      },
      agents,
    )

    for (const e of r.emitted) {
      const list = inbox.get(e.topic) ?? []
      // ★ 带上**真实载荷**：下游吃到的必须与上游发出的是同一份东西，
      //   否则"协同"只传了个消息 id，下游拿到的是一张空信封。
      list.push({ id: e.msgId, topic: e.topic, from: a.id, taskId, ts: Date.now(), payload: e.payload })
      inbox.set(e.topic, list)
    }

    steps.push({
      agentId: a.id,
      label: a.label,
      ok: r.ok,
      summary: r.summary,
      reason: r.reason,
      durationMs: r.durationMs,
      inputFrom: r.inputFrom,
      independent,
      emitted: r.emitted,
      dryRun: r.dryRun,
    })
    if (!r.ok) break
  }

  const finishedAt = Date.now()
  const failed = steps.find((s) => !s.ok)
  const receipt: FleetTaskReceipt = {
    taskId,
    goal,
    why: plan.why,
    steps,
    // ★ 一个任务只有"链上每一步都真跑成了"才算成功。
    //   `steps.length < chain.length` 说明中途断了，那也是不成功。
    ok: failed === undefined && steps.length === plan.chain.length,
    failedAt: failed ? failed.agentId : null,
    refusal: null,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    ledgerEvents: getEvents(0).length - eventsBefore,
    messageCount: busStats().messages - msgsBefore,
  }
  lastTaskReceipt = receipt
  appendEvent('FLEET_TASK', {
    taskId,
    goal,
    plan: plan.id,
    ok: receipt.ok,
    failedAt: receipt.failedAt,
    steps: steps.map((s) => ({ agentId: s.agentId, ok: s.ok, independent: s.independent, ms: s.durationMs })),
    durationMs: receipt.durationMs,
  })
  return receipt
}

/** 任务凭据 → 一句能念给人听的话。硬数字全部来自凭据本身。 */
export function renderTaskBrief(r: FleetTaskReceipt): string {
  if (r.refusal) {
    return `${r.why.replace(/\n/g, ' ')}`.trim()
  }
  if (r.steps.length === 0) return `这个任务我没接：${r.why}`
  const parts: string[] = []
  parts.push(`「${r.goal}」这个任务我调了 ${r.steps.length} 个成员，花了 ${(r.durationMs / 1000).toFixed(1)} 秒`)
  for (const s of r.steps) {
    parts.push(`${s.label}${s.independent ? '（独立核对）' : ''}${s.ok ? '成了' : '没成'}：${s.summary}`)
  }
  if (!r.ok && r.failedAt) parts.push(`卡在「${r.failedAt}」这一步，后面的成员我没有继续跑`)
  parts.push(`这一轮一共落了 ${r.ledgerEvents} 条账本事件、${r.messageCount} 条总线消息`)
  return parts.join('。') + '。'
}
