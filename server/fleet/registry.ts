/**
 * Agent 舰队的注册表自检
 *
 * ── 这一道门守的是什么 ──────────────────────────────────────────────
 * 本仓库 B 项检验里，Agent 舰队是唯一的「孤岛」档：**有页面、有按钮、
 * 有好看的收益数字，但没有一条真实的执行路径，也没有任何下游读它的输出。**
 * 孤岛的可怕之处在于它**看起来是活的** —— 页面渲染正常、按钮有反馈、
 * 数字还会随时间变化（因为它们是写死的）。所以"不许孤岛"必须是机制，
 * 不能是纪律：一条写进注释的纪律，下一个人重构时看不见。
 *
 * 每个检查都有它对应的**一次真实失误**，不是形式主义：
 *   ① `id` 重复            —— 后注册的静默覆盖前一个，调用方拿到的东西不是它以为的那个；
 *   ② 缺 `reuses`          —— 那就是"为舰队另写一套实现"，与语音层同一条红线；
 *   ③ `reuses` 指向不存在的文件 —— 声明是注释时，它可以在重构后指着一片空白仍然全绿；
 *   ④ 缺 `output`          —— 说不出可观测量，就不是能力，是一段代码；
 *   ⑤ `consumers` 空       —— **就是孤岛**；
 *   ⑥ consumer 不在册      —— 消费面必须是具名的、可核对的，不能是一句自由文本；
 *   ⑦ agent 类 consumer 不成立 —— 声称"下游 agent 读我"，但那个 agent 并不消费我的主题；
 *   ⑧ ui/voice 消费面证据缺失 —— 声称"面板读我"，但那个文件里根本没有这个调用；
 *   ⑨ `emits` 空 / 主题未登记 —— 产出没人能订阅；
 *   ⑩ agent 类主题没有订阅者 —— 死信箱，不是通道；
 *   ⑪/⑫ 声明了 `consumes` 却没 `onMessage`（或反之）—— 声明与实现分家，必有一边是假的；
 *   ⑬ 登记的 agent 主题没有生产者 —— 有人在等一个永远不会来的消息；
 *   ⑭ `act` 没进 DANGEROUS —— 改变系统将来行为的动作绕过了两段式确认；
 *   ⑮ `read` 却声明了 intent —— 语义混乱，读操作不该要求确认。
 *
 * ── 为什么参数可注入 ────────────────────────────────────────────────
 * 门禁范式：一道"只能报绿"的检查等于没有检查。测试要能喂**坏注册表**进来，
 * 逐个证明上面每一条真的会报红 —— 否则将来有人把检查删掉，门禁照样全绿。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDangerous } from '../voice/intents.ts'
import { FLEET_CONSUMERS, FLEET_TOPICS, fleetTopic, type FleetAgent, type FleetConsumer } from './types.ts'
import { subscribe } from './bus.ts'
import { FLEET_AGENTS } from './agents.ts'

export interface FleetProblem {
  /** 机器可判的代号。测试按代号断言，不按文案 —— 文案会变，代号不该变。 */
  code: string
  agentId: string
  problem: string
}

export interface FleetAuditDeps {
  /** 读一份相对项目根的源码。返回 null = 文件读不到。 */
  readText?: (relPath: string) => string | null
  exists?: (relPath: string) => boolean
  /** 项目根。默认 `process.cwd()`。 */
  cwd?: string
  /**
   * 消费面表。默认 `FLEET_CONSUMERS`。
   *
   * ★ 之所以让它可注入：表结构类判据（`CONSUMER_TABLE_MALFORMED`）检查的是
   *   **常量表本身**，而只读常量表的检查有一个通病 —— 它永远绿，
   *   而且没有任何输入能让它红。测试喂不进坏表，就证明不了它会红，
   *   也就等于这条检查不存在（本仓库"不可能失败的检查"那一类）。
   *   注入之后，烟测可以喂一张 `agent` 类 id 少了前缀的表进来，当场看到它红。
   */
  consumers?: readonly FleetConsumer[]
}

function defaultDeps(deps: FleetAuditDeps): Required<FleetAuditDeps> {
  const cwd = deps.cwd ?? process.cwd()
  return {
    cwd,
    consumers: deps.consumers ?? FLEET_CONSUMERS,
    readText: deps.readText ?? ((p) => {
      try {
        return readFileSync(join(cwd, p), 'utf8')
      } catch {
        return null
      }
    }),
    exists: deps.exists ?? ((p) => existsSync(join(cwd, p))),
  }
}

/** `reuses` 里必须能解析出一个源码文件路径 —— 否则它只是一句话。 */
export function reusesPath(reuses: string): string | null {
  const m = reuses.match(/((?:server|src|scripts|desktop)\/[\w./-]+\.tsx?)/)
  return m ? m[1] : null
}

/**
 * 从注册表派生出总线订阅（声明 → 接线只留一份，杜绝两处漂移）。
 * 纯函数，便于断言"总线上的订阅集合 == 注册表派生的集合"。
 */
export function deriveSubscriptions(agents: readonly FleetAgent[]): { topic: string; agentId: string }[] {
  const out: { topic: string; agentId: string }[] = []
  for (const a of agents) {
    for (const t of a.consumes ?? []) out.push({ topic: t, agentId: a.id })
  }
  return out.sort((x, y) => x.topic.localeCompare(y.topic) || x.agentId.localeCompare(y.agentId))
}

/**
 * 把订阅装到真实总线上。**幂等**：同一个 owner 重复订阅会被总线忽略。
 * 生产只在进程启动时调一次；测试可反复调。
 */
export function installSubscriptions(agents: readonly FleetAgent[]): void {
  for (const a of agents) {
    for (const t of a.consumes ?? []) {
      subscribe(t, a.id, (msg) => a.onMessage?.(msg) ?? '（该 agent 没有 onMessage，消息被丢弃）')
    }
  }
}

/**
 * 注册表自检。返回空数组才算健康 —— 由 `test:fleet` 断言 0 问题。
 *
 * 默认对真实注册表（`FLEET_AGENTS`）跑；测试传坏注册表进来证明每一条会红。
 */
export function auditFleetRegistry(
  agents: readonly FleetAgent[] = FLEET_AGENTS,
  depsIn: FleetAuditDeps = {},
): FleetProblem[] {
  const deps = defaultDeps(depsIn)
  const problems: FleetProblem[] = []
  const add = (code: string, agentId: string, problem: string): void => {
    problems.push({ code, agentId, problem })
  }

  const seen = new Set<string>()
  const producedTopics = new Set<string>()

  for (const a of agents) {
    if (seen.has(a.id)) add('DUP_ID', a.id, `id 重复：后注册的会静默覆盖前一个`)
    seen.add(a.id)
    if (!a.label.trim()) add('NO_LABEL', a.id, '缺 label：面板与语音会渲染成空白')
    if (!a.duty.trim()) add('NO_DUTY', a.id, '缺 duty：说不出职责的 agent 无法被调度')

    // ② ③ 复用既有路径
    if (!a.reuses.trim()) {
      add('NO_REUSES', a.id, '未声明 reuses —— 这就是"为舰队另写一套实现"，违反红线')
    } else {
      const p = reusesPath(a.reuses)
      if (!p) add('REUSES_NO_PATH', a.id, `reuses 里没有可核对的源码路径：${a.reuses.slice(0, 60)}`)
      else if (!deps.exists(p)) add('REUSES_MISSING', a.id, `reuses 指向的文件不存在：${p}`)
    }

    // ④ 产出
    if (!a.output.trim()) add('NO_OUTPUT', a.id, '未声明 output：说不出产出什么可观测量')

    // ⑤⑥⑦⑧ 消费面
    if (a.consumers.length === 0) {
      add('ISLAND', a.id, 'consumers 为空 —— 没有人读它的输出，这就是孤岛')
    }
    for (const cid of a.consumers) {
      const c = deps.consumers.find((x) => x.id === cid)
      if (!c) {
        add('CONSUMER_UNKNOWN', a.id, `consumer「${cid}」不在消费面表里：声明必须是可核对的具名消费面`)
        continue
      }
      if (c.kind === 'agent') {
        const target = agents.find((x) => x.id === cid.replace(/^agent:/, ''))
        if (!target) {
          add('CONSUMER_AGENT_MISSING', a.id, `声称下游 agent「${cid}」读我，但注册表里没有这个 agent`)
        } else {
          const shares = (target.consumes ?? []).some((t) => a.emits.includes(t))
          if (!shares) {
            add(
              'CONSUMER_AGENT_NOT_SUBSCRIBED',
              a.id,
              `声称「${target.id}」读我，但它 consumes=[${(target.consumes ?? []).join(',')}]，与我的 emits=[${a.emits.join(',')}] 没有交集`,
            )
          }
        }
      } else if (c.evidence) {
        const text = deps.readText(c.evidence.file)
        if (text === null) add('CONSUMER_EVIDENCE_MISSING_FILE', a.id, `消费面证据文件读不到：${c.evidence.file}`)
        else if (!text.includes(c.evidence.marker)) {
          add('CONSUMER_EVIDENCE_UNWIRED', a.id, `${c.evidence.file} 里找不到「${c.evidence.marker}」—— 这条接线被撤掉了`)
        }
      }
    }

    // ⑨⑩ 产出通道
    if (a.emits.length === 0) add('NO_EMITS', a.id, '未声明 emits：产出发不出去，下游只能靠轮询')
    for (const t of a.emits) {
      producedTopics.add(t)
      const topic = fleetTopic(t)
      if (!topic) {
        add('TOPIC_UNREGISTERED', a.id, `主题「${t}」未登记 —— 发到没人听的频道上不会被任何人发现`)
        continue
      }
      if (topic.kind === 'agent') {
        const subs = agents.filter((x) => (x.consumes ?? []).includes(t) && x.id !== a.id).map((x) => x.id)
        if (subs.length === 0) {
          add('TOPIC_NO_SUBSCRIBER', a.id, `agent 类主题「${t}」没有任何 agent 订阅 —— 死信箱不是通道`)
        }
      }
    }

    // ⑪⑫ consumes / onMessage 必须成对
    const consumes = a.consumes ?? []
    if (consumes.length > 0 && !a.onMessage) {
      add('CONSUMES_NO_HANDLER', a.id, `声明了 consumes=[${consumes.join(',')}] 却没有 onMessage —— 声明了不消费`)
    }
    if (consumes.length === 0 && a.onMessage) {
      add('HANDLER_NO_CONSUMES', a.id, '有 onMessage 却没声明 consumes —— 偷偷消费，依赖关系不可见')
    }
    for (const t of consumes) {
      if (!fleetTopic(t)) add('CONSUME_UNREGISTERED', a.id, `消费的主题「${t}」未登记`)
    }

    // ⑭⑮ 动作必须进危险名单
    if (a.kind === 'act') {
      if (!a.intent) add('ACT_NO_INTENT', a.id, 'act 类未声明 intent，无法验证它是否走两段式确认')
      else if (!isDangerous(a.intent)) add('ACT_INTENT_NOT_DANGEROUS', a.id, `act 的意图 ${a.intent} 不在 DANGEROUS 名单里 —— 动作会绕过确认`)
    } else if (a.intent) {
      add('READ_HAS_INTENT', a.id, `read 类却声明了 intent=${a.intent}：语义混乱，读操作不该要求确认`)
    }
  }

  // ⑬ 登记的 agent 主题必须有人投递
  for (const t of FLEET_TOPICS) {
    if (t.kind !== 'agent') continue
    if (!producedTopics.has(t.id)) {
      add('TOPIC_NO_PRODUCER', '*', `agent 类主题「${t.id}」登记在册但没有任何 agent 投递它 —— 有人在等一个永远不来的消息`)
    }
  }

  // ★ 表结构类判据读的是**注入进来的那张表**（默认即真实表）。
  //   读常量表的话，它只能因"有人改坏了源码"而红，测试无法证明它会红。
  if (!deps.consumers.every((c) => c.kind !== 'agent' || c.id.startsWith('agent:'))) {
    add('CONSUMER_TABLE_MALFORMED', '*', '消费面表里 agent 类的 id 没有 `agent:` 前缀，结构核对会解析错')
  }
  if (!deps.consumers.every((c) => c.kind === 'agent' || (c.evidence?.file && c.evidence?.marker))) {
    add('CONSUMER_TABLE_MALFORMED', '*', '消费面表里 ui/voice 类的条目缺 evidence，无从核对')
  }

  return problems
}

/** 面板 / 语音用的一句话体检结论。 */
export function renderRegistryBrief(agents: readonly FleetAgent[] = FLEET_AGENTS): string {
  const problems = auditFleetRegistry(agents)
  if (problems.length === 0) {
    return `舰队注册表健康：${agents.length} 个 agent，声明齐全，没有孤岛。`
  }
  return `舰队注册表有 ${problems.length} 处问题，第一处是：${problems[0].agentId} — ${problems[0].problem}`
}

// 顶层 re-export，避免调用方到处 import 两个路径
export { FLEET_AGENTS }
export type { FleetAgent }
