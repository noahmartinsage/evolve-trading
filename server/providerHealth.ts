/**
 * 厂商体检 —— 把「该换模型名 / 该停用 / 该保留重试」这三件事**分开**。
 *
 * ── 为什么必须有这一层 ────────────────────────────────────────────────
 * 实测（2026-09-19）一次真实的僵局：`Opencode-zen-ray` 在册、`enabled=1`、
 * `last_status` 是 `OK · 63 个模型`，但真调一次一句话就 400
 * `Model is unavailable`。把它试穿之后看到的是两类完全不同的失败：
 *
 *   `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`
 *   `400 Model is unavailable`
 *
 * 前者是**厂商政策**（换哪个免费模型名都一样死），后者是**名单腐烂**
 * （换一个名字就能活）。两者在"一句话也回不来"这个观察面上**逐字节相同**，
 * 却指向相反的动作：一个是"这个厂商别再指望了"，另一个是"去重跑 /models"。
 * 混在一起的结果就是 `_llmp.json` 里那句"可用 0/7"，读完不知道该干什么。
 *
 * ── 本模块的边界（很重要）──────────────────────────────────────────────
 * 它**只做判决**，不联网、不写库。观测（真调一次）由脚本负责，
 * 落盘/改 `enabled` 由脚本负责。这样判决逻辑可以在纯噪声场里被断言，
 * 而不是"要联网才能测"。
 *
 * ★ 判据 2（会不会对正确的输入报错）：本模块最危险的一条是**把网络故障
 *   当成厂商故障**。如果本机代理坏了，所有条目都会失败 —— 而"全部失败"
 *   正是 `disable` 的输入。那样我们会把一个完全健康的厂商关掉，
 *   且表面上一切正常。所以 `network` 类**单独成类**，并且
 *   「一次 HTTP 响应都没拿到」时判决恒为 `keep`。
 */
import { QUOTA_RE } from './llmPool.ts'

/** 一条观测失败的类别。类别是**从原文里认出来的**，不是猜出来的。 */
export type ProbeClass =
  /** 真答上来了。 */
  | 'ok'
  /** 厂商政策不让外部调用（换名字没用）。 */
  | 'policy'
  /** 余额不足 / 要充值（换名字没用，要钱）。 */
  | 'no-funds'
  /** 当天额度用完（等复位，别停用）。 */
  | 'quota'
  /** 这个名字上游下线了（换名字就行）。 */
  | 'model-gone'
  /** 连 HTTP 响应都没拿到（本机网络/代理问题，**绝不能据此停用**）。 */
  | 'network'
  /** 拿到了响应但认不出来 —— 如实记下，不当成任何一种已知原因。 */
  | 'unknown'

/** 一次观测。字段全是**可观测量**，不含结论。 */
export interface ProbeSample {
  model: string
  /** 拿到响应了吗。 */
  responded: boolean
  /** 拿到了才有。 */
  status?: number
  /** 响应正文片段（用来认类别）。 */
  body?: string
  /** 没拿到响应时的一句话（网络层原文）。 */
  netError?: string
  /** 真答上来的耗时（毫秒）；失败时是失败耗时。 */
  ms: number
  /**
   * HTTP 成功**且**从返回体里取到了正文。
   *
   * ★ 为什么不用 `status === 200` 顶替它：实测出现过"HTTP 200 但没有正文
   *   （返回体结构不认识）"。那一条如果被算成可用，就会把"哑的失败"
   *   当成"这条路是好的"，而本仓库记过一族缺陷正是这个。
   */
  hasContent?: boolean
}

/**
 * 认类别。**只看可观测的字符串**，按"越不可能被邻居顶替"的顺序判。
 *
 * ★ 顺序不是随意的：`402` 的正文里常带 `quota` 字样，
 *   `403` 的正文里也可能带 `free` —— 先按状态码定大方向，再按正文细分，
 *   比反过来稳（判据 3：一条负向断言要有一个"只有它"会命中的输入）。
 */
export function classifyProbe(s: ProbeSample): ProbeClass {
  // ① 连响应都没拿到 —— 这一条必须最先判，否则本机网络故障会被读成厂商故障
  if (!s.responded) return 'network'
  // ② 真答上来了（2xx 且解析出了正文）
  if (s.hasContent) return 'ok'
  const body = (s.body ?? '').toLowerCase()
  const status = s.status ?? 0

  // ③ 要钱：402 是标准语义，和"额度用完"是两件事（别让正文里的 quota 字样顶替它）
  if (status === 402) return 'no-funds'
  // ④ 额度用完：`QUOTA_RE` 与路由/回话共用同一份判据（只写一份）。
  //    必须在 403 之前判 —— 限流也常回 403，先按 403 走会把它错记成"厂商政策"。
  if (QUOTA_RE.test(s.body ?? '')) return 'quota'
  // ⑤ 厂商政策：403 **且**原文说的是"只在自家客户端里能用 / 你没被授权"。
  //    只凭状态码 403 就判政策是不够的（403 的含义太宽），所以要求正文佐证；
  //    佐证不出来就如实记 `unknown`，不硬塞一个原因进去。
  if (status === 403 && /freetier|free tier|within opencode|not authorized|forbidden|subscription|upgrade/i.test(body)) {
    return 'policy'
  }
  // ⑥ 名单腐烂：名字上游下线
  if (/model is unavailable|not a valid model|no endpoints found|does not exist/i.test(body)) {
    return 'model-gone'
  }
  if (status === 404) return 'model-gone'
  return 'unknown'
}

/** 判决的三种动作。 */
export type VerdictKind =
  /** 换 `active_model`（厂商是活的，只是名字死了）。 */
  | 'switch-model'
  /** 停用它（换名字救不了）。 */
  | 'disable'
  /** 保留原样（等额度 / 等网络 / 证据不足 / 换名字再试）。 */
  | 'keep'

export interface ProviderVerdict {
  kind: VerdictKind
  /** `switch-model` 时建议切到的名字。 */
  model?: string
  /** 给人听的一句话（**不含 markdown 星号** —— 同一句会被语音念出来）。 */
  speech: string
  /** 支撑结论的证据行，供人核对。 */
  evidence: string[]
  /** 每一类各几条。判决要能被它自己的计数解释（红线 12）。 */
  tally: Record<ProbeClass, number>
}

const CLASS_LABEL: Record<ProbeClass, string> = {
  ok: '可用',
  policy: '厂商政策拒绝',
  'no-funds': '余额不足',
  quota: '额度用完',
  'model-gone': '名字已下线',
  network: '网络没通',
  unknown: '认不出来',
}

function emptyTally(): Record<ProbeClass, number> {
  return { ok: 0, policy: 0, 'no-funds': 0, quota: 0, 'model-gone': 0, network: 0, unknown: 0 }
}

/**
 * 从观测得出结论。**纯函数**，不联网、不写盘。
 *
 * 判决顺序（顺序即优先级，每一条都有它专属的输入）：
 *   ① 有能用的 ⇒ 换名字。停用是错的 —— 会把唯一还活着的路关掉。
 *   ② 一个 HTTP 响应都没拿到 ⇒ 保留。这是本机网络问题，不是厂商的问题。
 *   ③ 认不出来的失败占多数 ⇒ 保留并说出来。不拿"我不知道"当"它坏了"。
 *   ④ 全是额度类 ⇒ 保留等复位（等它自己好，别停用）。
 *   ⑤ 全是名字下线 ⇒ 保留 + 去重跑 /models（换名字是下一步，不是停用）。
 *   ⑥ 出现政策拒绝或余额不足 ⇒ 停用，并且**说清是哪一个** ——
 *      这两者都指向停用，但一个让人"别再试了"，另一个让人"去充值"。
 */
export function decideProvider(name: string, samples: ProbeSample[]): ProviderVerdict {
  const tally = emptyTally()
  const classes = samples.map((s) => classifyProbe(s))
  for (const c of classes) tally[c] += 1
  const evidence = samples.map((s, i) => {
    const c = classes[i]
    const why = s.responded ? `HTTP ${s.status ?? '?'} ${(s.body ?? '').slice(0, 120)}` : `没拿到响应 ${s.netError ?? ''}`
    return `${CLASS_LABEL[c]} · ${s.model} · ${why}`
  })

  const ok = samples.filter((_, i) => classes[i] === 'ok')
  // ① 有能用的
  if (ok.length > 0) {
    const best = [...ok].sort((a, b) => a.ms - b.ms)[0]
    return {
      kind: 'switch-model',
      model: best.model,
      speech: `${name} 有 ${ok.length} 个模型能真回话，把在用模型换成 ${best.model} 就行（不用停用它）`,
      evidence,
      tally,
    }
  }

  // ② 一个响应都没拿到 —— 最危险的一种。绝不据此停用。
  if (samples.length > 0 && tally.network === samples.length) {
    return {
      kind: 'keep',
      speech: `${name} 一个请求都没通到厂商（全是本机网络层失败）。这不是厂商的问题，我没动它 —— 下一步是查网络或代理，不是停用`,
      evidence,
      tally,
    }
  }

  // ③ 没有观测 ⇒ 不下判决。缺证据不等于它坏了，也不等于它好。
  if (samples.length === 0) {
    return {
      kind: 'keep',
      speech: `${name} 这次一个模型都没试到，所以我没动它 —— 没有证据就不该关掉可能还活着的通道`,
      evidence,
      tally,
    }
  }

  // ④ 认不出来占多数 ⇒ 保留并如实说
  if (tally.unknown >= samples.length) {
    return {
      kind: 'keep',
      speech: `${name} 的失败我认不出是什么原因（既不是额度、也不是政策、也不是名字下线），所以没动它 —— 原文在证据里，请人工看一眼`,
      evidence,
      tally,
    }
  }

  // ⑤ 全是额度 ⇒ 等复位
  if (tally.quota + tally.unknown === samples.length && tally.quota > 0) {
    return {
      kind: 'keep',
      speech: `${name} 是当天额度用完了，明天零点会自动恢复，不用停用它`,
      evidence,
      tally,
    }
  }

  // ⑥ 全是名字下线 ⇒ 换名字，不是停用
  if (tally['model-gone'] + tally.unknown === samples.length && tally['model-gone'] > 0) {
    return {
      kind: 'keep',
      speech: `${name} 试到的名字都被上游下线了（这是名单腐烂，不是厂商死了）—— 下一步是重新拉一次模型名单挑能用的名字`,
      evidence,
      tally,
    }
  }

  // ⑦ 政策拒绝 / 余额不足 ⇒ 停用，但要分成两句话说
  const policy = tally.policy
  const funds = tally['no-funds']
  if (policy + funds > 0) {
    const parts: string[] = []
    if (policy > 0) parts.push(`${policy} 个是被厂商政策挡住的（免费档只能在它自家客户端里用，换哪个免费模型名都一样）`)
    if (funds > 0) parts.push(`${funds} 个是余额不足`)
    const rest = tally['model-gone'] + tally.unknown
    if (rest > 0) parts.push(`另有 ${rest} 个是名字下线或认不出的原因`)
    return {
      kind: 'disable',
      speech: `${name} 试到的 ${samples.length} 个模型一个都没能回话：${parts.join('；')}。换名字救不了，我先把它停用（记录留着，随时可以再打开）`,
      evidence,
      tally,
    }
  }

  // 兜底：走到了这里说明分类逻辑有洞 —— 如实说，不动它
  return {
    kind: 'keep',
    speech: `${name} 的结论落不进任何一种已知情形，我没动它。证据已列全，请人工判`,
    evidence,
    tally,
  }
}

/** 判决的排版（控制台 / 面板 / 语音共用一份）。 */
export function renderVerdict(name: string, v: ProviderVerdict): string[] {
  const lines: string[] = []
  lines.push(`厂商 ${name} · 判决 ${v.kind}`)
  lines.push(`  ${v.speech}`)
  const parts = (Object.entries(v.tally) as [ProbeClass, number][])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${CLASS_LABEL[c]} ${n}`)
  lines.push(`  观测 ${parts.join(' · ')}`)
  for (const e of v.evidence) lines.push(`  - ${e}`)
  return lines
}

/** 停用时要写进 `last_status` 的一句话（带日期，可核对、可复核）。 */
export function disableStatus(v: ProviderVerdict, day: string): string {
  return `DISABLED(${day}) · ${v.speech}`
}

/** 修剪的结果。 */
export interface PruneResult {
  /** 修剪之后的名单。 */
  kept: string[]
  /** 被摘掉的名字（一定都是**原来就在名单里**的）。 */
  removed: string[]
  /**
   * 名单会被摘空 ⇒ 这次**一份都不摘**。
   *
   * ★ 这一档必须单独存在：摘空之后这个账号"连一个候选名字都没有"，
   *   而正确动作是**重新拉一次 `/models`**（`decideProvider` 的第 ⑥ 支路
   *   已经这么说了）。宁可留着死名（代价：每天多一次失败尝试），
   *   也不能让账号失去全部候选 —— 后者要人去手工补名单才能恢复。
   */
  emptied: boolean
}

/**
 * 名字级修剪：把**确认已下线**的名字从名单里摘掉。
 *
 * ── 为什么必须有这一步 ────────────────────────────────────────────────
 * `decideProvider` 已经能认出「名字已下线」，但它的结论只是
 * 「去重跑 `/models`」—— 而 `/models` 是**厂商自报**的清单：实测
 * （2026-09-23，`data/orch.db` 的 `llm_providers`）OpenRouter 那家的名单里
 * 一直躺着 `deepseek/deepseek-v4-flash-0731:free`，它的原文是
 * `This model is unavailable for free`（该 slug 已不再免费）。
 * 于是它**每天被白试一次**：一次真实往返、一条 journal 噪音，
 * 并且会把 `last_status` 覆盖成一条 `FAIL HTTP 404` ——
 * 下次有人翻面板时看到的是"这家坏了"，而它当时正用另一个名字正常干活。
 *
 * ── 判据必须窄（判据 2：误报比漏报贵）────────────────────────────────
 * **只摘 `model-gone`。** 下面这几类一律不摘，因为它们都会自己恢复：
 *   · `quota`      —— 额度打满，明天零点就好了
 *   · `network`    —— 本机网络抖动，与名字无关
 *   · `no-funds`   —— 充值之后**同一个名字**是好的
 *   · `policy`     —— 换档/换客户端之后同一个名字也可能是好的
 * 两种错误的代价不对称：摘错一个名字 = 一条本来能用的路被**永久静默删掉**；
 * 留着它 = 每天多一次失败尝试。所以判据往窄里收。
 *
 * ★ 与 `/models` 的关系：这一步**不替代**重新拉名单。`/models` 会带回新名字，
 *   这一步只负责把**已证伪**的旧名字请出去 —— 一个加、一个减，不能互相顶替。
 */
export function pruneDeadModels(all: readonly string[], samples: readonly ProbeSample[]): PruneResult {
  const dead = new Set(samples.filter((s) => classifyProbe(s) === 'model-gone').map((s) => s.model))
  // 只认"名单里真的有的"名字：`samples` 里还带着探测用的付费档名字，
  // 它们本来就不在名单里 —— 不过滤的话 `removed` 会报出一个从未存在过的名字，
  // 而那种假事实会被原样写进 `last_status` 让人照着核对。
  const removed = all.filter((m) => dead.has(m))
  const kept = all.filter((m) => !dead.has(m))
  if (kept.length === 0) return { kept: [...all], removed: [], emptied: true }
  return { kept, removed, emptied: false }
}
