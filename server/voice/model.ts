/**
 * 桌宠的"问模型"出口 —— 解决"不能再说不会了"
 *
 * ── 这一层存在的唯一理由 ──────────────────────────────────────────────
 * 实测反馈的原话是「连一键启动自治循环都启动不了，扩候选基因空间和换因子族等
 * 都听不懂」。听懂指令是一半；另一半是**开放问题**：
 * 用户问「资金费率是怎么影响永续合约的」，系统里没有任何一条规则能匹配 ——
 * 而旧实现的兜底是一句「这句我没听懂」。
 *
 * 一个装了模型的助手说"我不会"，在用户那里与"它坏了"没有区别。
 * 所以这条路径的判据不是"尽量答对"，而是**永远不说"我不会"**：
 *   · 规则层能答的，规则层答（更准、可复现）；
 *   · 规则层答不了的，问模型；
 *   · 模型也答不了（没配厂商 / 全部候选失败），要**说清是哪一种答不了**，
 *     并给出下一步（去配厂商 / 去重跑探针）—— 而不是笼统的"我不会"。
 *
 * ── 为什么上下文里要塞系统实况 ────────────────────────────────────────
 * 一个不知道自己在哪儿的模型，会把"你们的策略"理解成泛指。
 * 所以系统提示里带上：这是 EVOLVE、当前品种、自动驾驶状态、
 * 以及**当前有没有任何可用厂商**。最后一条尤其要紧 ——
 * 模型自己不知道它是不是降级运行，而它给出的确定性口吻必须与之匹配。
 *
 * ── 明确禁止的一件事 ──────────────────────────────────────────────────
 * 不许模型**编造本系统的数字**。系统里真实的成交量、权益、因子通过率
 * 都从账本现算，模型只能引用我们提供给它的数，不许自己造一个。
 * 这条写进了系统提示，也在返回里带上 `grounded: false` 标记 ——
 * 下游（语音播报）据此决定措辞：不落地的回答不说成"系统数据显示"。
 */
import { routeChat, routeMultimodal, type LlmContentPart } from '../modelRouter.ts'
import { getActiveLlm } from '../llmProviders.ts'
import { catalogAgeDays, CATALOG_VERIFIED_AT } from '../llmCatalog.ts'
import { autopilotStatus } from '../autopilot.ts'
import type { AttachmentDigest } from './attachments.ts'

/**
 * 失败**分三种**，而且三种给出的下一步完全不同。
 *
 * ── 为什么必须分开 ────────────────────────────────────────────────────
 * 这正是本项目复现过多次的那一类错：**两种事因长得一模一样，却把人引向不同的动作**。
 * 实测（2026-09-19）：三个免费视觉候选全部失败，回话写的是
 * "重跑探针能看出是哪一个名字烂掉了"；而探针给出的原文是
 * `HTTP 429 free-models-per-day` —— **额度用完了，不是名字烂了**。
 * 照着那句错话去做，会去换模型名单；正确的动作是等额度或加额度（判据 24）。
 *
 * 所以这里的判据不是"尽量答对"，而是**失败也要让人知道该去动哪一处**。
 */
export type ModelFailureKind = 'paid-blocked' | 'quota' | 'no-candidate-worked'

/**
 * 429 / 配额类原文的公共形状 —— **判据本身住在 `llmPool` 里，这里只是转出来**。
 *
 * ★ 为什么不留一份自己的：`modelRouter` 用同一条判据决定"要不要换账号"。
 *   两份判据的后果很具体：路由认为该换账号、而回话认为该换名单，
 *   于是用户被告知"重跑探针看哪个名字烂了"，而真正该做的是加账号。
 *   单一出处是这条教训唯一可靠的落地方式。
 */
export { QUOTA_RE } from '../llmPool.ts'
import { QUOTA_RE, poolSnapshot } from '../llmPool.ts'

/** 从候选尝试里判出失败性质。**判据只写一份**，回话与断言共用它。 */
export function modelFailureKind(attempts: readonly { reason?: string }[]): ModelFailureKind {
  if (attempts.length > 0 && attempts.every((a) => /PAID_NOT_ALLOWED|PROBE_NEVER_PAID/.test(a.reason ?? ''))) {
    return 'paid-blocked'
  }
  if (attempts.some((a) => QUOTA_RE.test(a.reason ?? ''))) return 'quota'
  return 'no-candidate-worked'
}

/**
 * 三种失败各自的可念说明。
 *
 * ★ 导出它的理由：`test:voice` 要能对**每一种**分支各喂一个"只有它才会命中"的输入
 *   （判据 3）—— 留在函数体里就只能靠真去把额度打满才能测。
 */
export function modelFailureSpeech(
  kind: ModelFailureKind,
  attempts: readonly { model: string; reason?: string; account?: string }[],
  emptyQuestion = false,
  /**
   * 账号池现状的人话（生产由 `askModel` 传 `poolSnapshot().speech`）。
   *
   * ★ 为什么要当参数传、而不是在里面直接读池子：这是个**纯函数**，
   *   烟测要能对三种失败各喂一个"只有它才命中"的输入（判据 3）。
   *   在里面读全局状态，测试就会读到**真实环境**的账号池 ——
   *   于是"额度用完"这句话在测试里永远复现不出来。
   */
  poolNote?: string,
): string {
  const n = attempts.length
  if (emptyQuestion) return '你没说什么，也没给附件，我不知道要回什么。'
  if (kind === 'paid-blocked') {
    return (
      '我手上有厂商，但它只提供付费模型，而付费通道是关着的（EV_LLM_ALLOW_PAID 未开）。' +
      '要我用付费模型，请先明确开启并给一个每小时的额度。'
    )
  }
  if (kind === 'quota') {
    const hit = attempts.find((a) => QUOTA_RE.test(a.reason ?? ''))
    const accts = [...new Set(attempts.map((a) => a.account).filter((x): x is string => !!x))]
    const acctNote = accts.length > 1 ? `（换了 ${accts.length} 个账号）` : ''
    return (
      `我把 ${n} 个候选都试了${acctNote}，全被同一个原因挡回来：免费额度用完了（${(hit?.reason ?? '').slice(0, 90)}）。` +
      '这不是模型名字烂了 —— 名字烂了是另一个现象，探针里会写 HTTP 404 或者"模型不可用"。' +
      (poolNote ?? '额度按天算，明天会自己恢复；想现在就用得给那个账号加点额度。') +
      '想马上继续最省事的做法是再加一个账号：在 .env 里加一行 OPENROUTER_API_KEY_2=你的新 key，' +
      '我重启后会自动把它接进池子，然后先挑没爆的那个用。' +
      '在那之前我能做的是查系统数据、跑舰队任务、读文本附件；问模型这条路要等额度回来。'
    )
  }
  return (
    `我把能试的模型都试过了，${n} 个全部失败（第一个是 ${attempts[0]?.model ?? '未知'}：${(attempts[0]?.reason ?? '无原因').slice(0, 90)}）。` +
    '这不是这个问题我不会，是模型通道现在不通 —— 重跑一次模型探针（npm run llm:probe）能看出是哪一个名字烂掉了。'
  )
}

export interface ModelAnswer {
  ok: boolean
  /** 能直接念出来的话。失败时是**可念的失败说明**，不是"我不会"。 */
  speech: string
  /** 逐步留痕，进 VoiceToolResult.steps。 */
  steps: string[]
  /** 用的是哪个模型。null = 没调成。 */
  model: string | null
  /** 是否发生了降级（第一个候选没成功）。 */
  degraded: boolean
  /** 回答有没有系统事实作依据。false = 纯模型知识，播报时不得说成"系统数据显示"。 */
  grounded: boolean
  reason?: string
  attempts?: { model: string; ok: boolean; reason?: string }[]
}

/**
 * 系统提示。
 *
 * ★ 把它放在这里、只此一份：措辞分叉的代价是同一个系统在不同入口
 *   表现出不同的自我认知，而用户会拿两处说法对照。
 */
export function assistantSystemPrompt(): string {
  const ap = autopilotStatus()
  const llm = getActiveLlm()
  const ageDays = Math.round(catalogAgeDays() * 10) / 10
  return [
    '你是 EVOLVE 自进化量化交易系统的语音管家，替用户盯着这套系统。',
    '回答用简体中文，口语化，**简短** —— 你的答案会被念出来，超过三句话用户就会走神。',
    '',
    '硬规矩：',
    '1. 你不知道本系统的任何具体数字（权益、成交、因子通过率、候选数）。这些只能由系统现算给你。',
    '   所以你**不许编造**本系统的数字；被问到而你手上没有时，直说"这个数我手上没有，我可以去查"。',
    '2. 你可以自由使用通用的量化/交易/编程知识。这类问题正常回答，不要推给系统。',
    '3. 不确定就说不确定，不要用一个听起来确定的句子把不确定盖过去。',
    '4. 不要输出 markdown 标题、表格、代码块 —— 念出来会变成一堆符号。',
    '',
    '当前系统事实（只有这些是你确知的）：',
    `- 自动驾驶：${ap.running ? '运行中' : '未运行'}，阶段 ${ap.stage}${ap.winner ? `，在跑策略 ${ap.winner}` : ''}`,
    `- 模型通道：${llm ? `${llm.name} / ${llm.model}` : '当前没有任何可用厂商'}`,
    `- 已验证模型名单的验证日期：${CATALOG_VERIFIED_AT}（距今 ${ageDays} 天；名单会腐烂，超过两周应重跑探针）`,
  ].join('\n')
}

/** 把附件摘要拼成一段能给模型看的文字（图片不进这里，走多模态）。 */
export function attachmentsAsText(list: readonly AttachmentDigest[]): string {
  const texts = list.filter((d) => d.kind === 'text')
  if (texts.length === 0) return ''
  return texts
    .map((d) => {
      const head = `【附件 ${d.name}】${d.truncated ? `（超长，只带了前 ${d.text.length} 字）` : ''}`
      return `${head}\n${d.text}`
    })
    .join('\n\n')
}

/**
 * 问一次模型。
 *
 * `tier` 默认 `execute`（机械层）：这一层的问题是"回答用户"，不是"设计策略"，
 * 用规划档既慢又占额度。需要更强推理的调用方可以显式传 `plan`。
 */
export async function askModel(
  question: string,
  opts: { attachments?: readonly AttachmentDigest[]; tier?: 'plan' | 'execute'; extraContext?: string } = {},
): Promise<ModelAnswer> {
  const q = question.trim()
  if (q.length === 0 && (opts.attachments ?? []).length === 0) {
    return { ok: false, speech: modelFailureSpeech('no-candidate-worked', [], true), steps: [], model: null, degraded: false, grounded: false, reason: 'EMPTY_QUESTION' }
  }

  const provider = getActiveLlm()
  if (!provider) {
    return {
      ok: false,
      speech:
        '我现在答不了开放问题，因为**没有任何可用的大模型厂商**。' +
        '这不是"我不会"，是通道没配：去「连接器/厂商」那一页加一个厂商并选中模型，' +
        '或者在环境里放 OPENROUTER_API_KEY，我重启后会自动接上一条被真调过的通道。' +
        '在那之前我能做的是查系统数据、跑舰队任务、联网搜 —— 这些不依赖模型。',
      steps: ['检查厂商注册表', '结论：没有启用中的厂商'],
      model: null,
      degraded: false,
      grounded: false,
      reason: 'NO_PROVIDER',
    }
  }

  const system = assistantSystemPrompt() + (opts.extraContext ? `\n\n【这次任务的额外上下文】\n${opts.extraContext}` : '')
  const attachments = opts.attachments ?? []
  const images = attachments.filter((d) => d.kind === 'image')
  const docText = attachmentsAsText(attachments)

  const parts: LlmContentPart[] = []
  const promptText = [q || '（用户没有打字，只给了附件）', docText].filter((s) => s.length > 0).join('\n\n')
  parts.push({ type: 'text', text: promptText })
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })

  const steps: string[] = [
    `厂商 ${provider.name}，候选链从已验证名单开始`,
    images.length > 0 ? `带 ${images.length} 张图（走视觉档）` : '纯文本',
    docText.length > 0 ? `另带 ${attachments.filter((d) => d.kind === 'text').length} 份文本正文（${docText.length} 字）` : '无文本附件',
  ]

  const r =
    images.length > 0
      ? await routeMultimodal(opts.tier ?? 'execute', system, parts, 0.4)
      : await routeChat(opts.tier ?? 'execute', system, promptText, 0.4)

  if (!r.ok || !r.text) {
    const tries = r.attempts.map((a) => ({ model: a.model, ok: a.ok, account: a.account, reason: a.reason }))
    steps.push(...r.attempts.map((a) => `${a.ok ? '成' : '败'} ${a.account ? a.account + '/' : ''}${a.model}${a.reason ? '：' + a.reason : ''}`))
    // ★ 失败也**不返回"我不会"**：说清是哪一种失败，并给下一步。
    //   判据与文案都在模块级那一份里（`modelFailureKind` / `modelFailureSpeech`）——
    //   这里只负责接上。判据写两份就会分叉，而分叉的失败说明会把用户引向错的动作。
    const kind = modelFailureKind(r.attempts)
    steps.push(`失败性质：${kind}（按候选的失败原文判，不按"看着像什么"判）`)
    // ★ 池子现状只在**失败**这条路上现读一次：成功路径不需要它，
    //   而"还有几个账号能用 / 什么时候恢复"正是失败时用户要的下一步动作。
    const pool = poolSnapshot()
    steps.push(`账号池：${pool.speech}`)
    return {
      ok: false,
      speech: modelFailureSpeech(kind, r.attempts, false, kind === 'quota' ? pool.speech : undefined),
      steps,
      model: null,
      degraded: false,
      grounded: false,
      reason: r.reason,
      attempts: tries,
    }
  }

  steps.push(`用 ${r.model} 答的${r.degraded ? '（发生了降级）' : ''}`)
  return {
    ok: true,
    speech: r.text.trim(),
    steps,
    model: r.model,
    degraded: r.degraded,
    // 答的是通用知识 ⇒ 不落地。播报时不能说成"系统数据显示"。
    grounded: false,
    reason: r.reason,
    attempts: r.attempts.map((a) => ({ model: a.model, ok: a.ok, reason: a.reason })),
  }
}
