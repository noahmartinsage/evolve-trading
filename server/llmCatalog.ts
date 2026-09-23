/**
 * 已验证可用的免费模型名单
 *
 * ── 为什么需要一份"名单"，而不是让路由去猜 ────────────────────────────
 * 2026-09-19 实测的一次故障说明了原因。当时唯一启用的厂商是
 * `opencode.ai/zen`，`/models` 返回 200 并列出了 63 个模型，路由据此
 * 选中了 `deepseek-v4-flash-free` —— 然后真正要一句话时收到：
 *
 *   403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
 *   402 Insufficient account funds            （付费档）
 *   400 Model is unavailable                  （多个名字）
 *
 * 也就是说：**列在 `/models` 里 ≠ 能回话**。链路上的每一处都报"正常"，
 * 只有用户端是一片沉默 —— 这正是本仓库反复记过的那一族缺陷：哑的失败。
 *
 * ⇒ 判据只能是**真的调一次**。这份名单里的每一条都是被
 *   `scripts/llm-probe.ts` / `scripts/vision-probe.ts` 真调过的，
 *   并且记下了验证日期 —— 因为名单会腐烂（opencode 那一批就是烂掉的例子）。
 *
 * ── 名单腐烂了怎么办 ─────────────────────────────────────────────────
 * `verifiedAt` 是用来判断"这份证据有多新"的，不是装饰。
 * 路由在连续失败时会要求重新跑一次探针，而不是无限重试同一批名字。
 * **不要因为名单变短了就怀疑代码** —— 先去 `data/orch.db` 的
 * `llm_providers.last_status` 看探针最近一次的结论。
 */

export interface VerifiedModel {
  id: string
  /** 真调出来的延迟（毫秒），用于排序：同一档里优先用快的。 */
  latencyMs: number
  /** 是否真能读图（判据是**答对颜色**，不是 HTTP 200）。 */
  vision: boolean
  /** 一句话说明它是怎么被验证的。 */
  how: string
}

/** 验证日期。改名单必须同时改它 —— 否则"这份证据有多新"就无从判断。 */
export const CATALOG_VERIFIED_AT = '2026-09-19'

/**
 * 文本档。按延迟升序 —— 路由按顺序试，第一个成功的即返回，
 * 所以放在前面的是"最可能快答上来"的。
 *
 * ★ 名单会腐烂，而且**是静默腐烂**：2026-09-19 复跑时，上一轮记录里
 *   "答对过红色"的 `nex-n2.5-pro:free` 一度回 503 + EMPTY_RESPONSE。
 *   所以每条都带验证日期与判据，`CATALOG_VERIFIED_AT` 是整份名单的日期。
 */
export const VERIFIED_TEXT_MODELS: readonly VerifiedModel[] = [
  {
    id: 'inclusionai/ling-3.0-flash-vl:free',
    latencyMs: 1386,
    vision: true,
    how: 'vision-probe（走生产的 chatCompleteParts）：发 64×64 纯红 PNG，正文答「红色」；llm-probe 文本补全亦有正文',
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731:free',
    latencyMs: 3987,
    vision: false,
    how: 'llm-probe：补全 200，正文「1+1=2。」；vision-probe 明确回 404 No endpoints found that support image input',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    latencyMs: 5619,
    vision: false,
    how: 'llm-probe：补全 200 并有正文',
  },
]

/**
 * 视觉档。
 *
 * ★ 判据刻意不是"HTTP 200"，也不是"探针手写 fetch 能通"：
 *   · `ling-3.0-flash-vl:free` 标着 `["text","image","video"]`，但在**旧探针**
 *     里答错、在生产链路上回 400 —— 只有走 `chatCompleteParts` 才算数；
 *   · `dots-3-note-preview:free` 是 200 但正文为空（EMPTY_RESPONSE）。
 *   一个会说"我没看到图"的 200 在链路上全绿，而用户拿到的是瞎话。
 *   所以只有**走生产路径且答对颜色**的才进这份名单。
 */
export const VERIFIED_VISION_MODELS: readonly VerifiedModel[] = [
  {
    id: 'inclusionai/ling-3.0-flash-vl:free',
    latencyMs: 1386,
    vision: true,
    how: 'vision-probe（走生产的 chatCompleteParts + 生产系统提示）：64×64 纯红 PNG → 正文「红色」',
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    latencyMs: 1530,
    vision: true,
    how: '同一探针：纯红 PNG → 正文「红色」',
  },
  {
    id: 'nex-agi/nex-n2.5-pro:free',
    latencyMs: 2391,
    vision: true,
    how: '同一探针：纯红 PNG → 正文「红色」；注意它偶发 503，所以排在最后作兜底',
  },
]

/** 选模型：要读图就用视觉档，否则文本档。两层都可注入，测试才能断言降级链。 */
export function preferredModelChain(needVision: boolean): string[] {
  const list = needVision ? VERIFIED_VISION_MODELS : VERIFIED_TEXT_MODELS
  return list.map((m) => m.id)
}

/** 这份名单有没有"过期到必须重验"的迹象（默认 14 天）。 */
export function catalogAgeDays(nowMs: number = Date.now()): number {
  const at = Date.parse(`${CATALOG_VERIFIED_AT}T00:00:00Z`)
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return Math.max(0, (nowMs - at) / 86_400_000)
}
