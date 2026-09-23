/**
 * Agent 舰队的消息总线
 *
 * ── 为什么舰队需要一条总线，而不是"调度器把两个 agent 串起来" ─────────
 * 「agent 之间相互协同」如果只体现为调度器里写死的 `A(); B()`，
 * 那它们是**一个函数的两个语句**，不是两个 agent —— 拆掉其中一个，
 * 另一个照样跑，没有任何东西会报错。总线的意义是让"下游靠上游的产出"
 * 变成一条**可断的链**：上游不发布，下游就真的有输入缺失（见 service.runTask
 * 里 `requireInputs` 这一段），而不是静默地空着参数跑完然后报"成功"。
 *
 * ── 订阅从注册表派生，而不是各处手写 ─────────────────────────────────
 * `installSubscriptions()` 会把注册表里每个 agent 的 `consumes` 变成本总线上的
 * 真实订阅。这样"声明了 consume 却没接线"在结构上不可能发生 ——
 * 与"两个唯一来源会漂移"那类缺陷同源的处理方式：只留一份。
 *
 * ── 每条消息都落账本 ─────────────────────────────────────────────────
 * 「谁在跟谁说话」是排查协同问题的第一现场。不落账本的话，
 * 事后只能看到"下游报了个输入缺失"，看不到"上游其实没发"。
 */
import { appendEvent } from '../ledger.ts'
import type { FleetMessage } from './types.ts'

const MAX_RECENT = 200
const MAX_INBOX = 50

let msgSeq = 0
let recent: FleetMessage[] = []
const subs = new Map<string, { owner: string; handler: (msg: FleetMessage) => string }[]>()
const inboxes = new Map<string, { topic: string; msgId: string; from: string; note: string; ts: number }[]>()

export interface FleetDelivery {
  owner: string
  note: string
}

export interface PublishResult {
  message: FleetMessage
  deliveries: FleetDelivery[]
}

/** 注册一个订阅。`owner` 必须是注册表里的 agent id（由 installSubscriptions 保证）。 */
export function subscribe(topic: string, owner: string, handler: (msg: FleetMessage) => string): void {
  const list = subs.get(topic) ?? []
  if (list.some((s) => s.owner === owner)) return
  list.push({ owner, handler })
  subs.set(topic, list)
}

export function topicSubscribers(topic: string): string[] {
  return (subs.get(topic) ?? []).map((s) => s.owner).sort()
}

export function subscribedTopics(): string[] {
  return [...subs.keys()].sort()
}

/**
 * 发布一条消息。**同步投递** —— 异步投递会让"下游到底收到没有"变成
 * 一个需要等待的问题，而舰队里所有协同都是同一次任务内的顺序关系，
 * 同步投递给出的因果顺序是确定的（也就可断言）。
 */
export function publish(input: {
  topic: string
  from: string
  payload: Record<string, unknown>
  taskId?: string | null
}): PublishResult {
  msgSeq += 1
  const message: FleetMessage = {
    id: `M${msgSeq}`,
    topic: input.topic,
    from: input.from,
    taskId: input.taskId ?? null,
    ts: Date.now(),
    payload: input.payload,
  }
  const deliveries: FleetDelivery[] = []
  for (const s of subs.get(input.topic) ?? []) {
    let note: string
    try {
      note = s.handler(message)
    } catch (e) {
      // 订阅方自己出错不能吃掉上游的产出 —— 但必须**说出来**，
      // 否则"下游没收到"会被记成"上游没发"，排查方向整个反过来。
      note = `订阅方处理失败：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
    }
    deliveries.push({ owner: s.owner, note })
    const box = inboxes.get(s.owner) ?? []
    box.push({ topic: message.topic, msgId: message.id, from: message.from, note, ts: message.ts })
    if (box.length > MAX_INBOX) box.splice(0, box.length - MAX_INBOX)
    inboxes.set(s.owner, box)
  }

  recent.push(message)
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT)

  appendEvent('FLEET_MESSAGE', {
    msgId: message.id,
    topic: message.topic,
    from: message.from,
    taskId: message.taskId,
    deliveredTo: deliveries.map((d) => d.owner),
    // ★ 投递数单独落一条：`deliveredTo` 为空数组时，只看它无法区分
    //   "没有订阅者"与"有订阅者但序列化时丢了"。这一个数字排除了第二种。
    deliveryCount: deliveries.length,
  })

  return { message, deliveries }
}

export function recentMessages(limit = 20): FleetMessage[] {
  return recent.slice(-limit).reverse()
}

export function inboxOf(agentId: string): { topic: string; msgId: string; from: string; note: string; ts: number }[] {
  return [...(inboxes.get(agentId) ?? [])].reverse()
}

export function busStats(): { topics: number; subscriptions: number; messages: number } {
  let subscriptionCount = 0
  for (const list of subs.values()) subscriptionCount += list.length
  return { topics: subs.size, subscriptions: subscriptionCount, messages: msgSeq }
}

/** 仅供测试：清空总线状态（生产代码不应调用 —— 会丢掉在途协同）。 */
export function resetBus(): void {
  msgSeq = 0
  recent = []
  subs.clear()
  inboxes.clear()
}
