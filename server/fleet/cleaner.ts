/**
 * 可逆清理 —— 把"没用的临时产物"移进 `.trash/`，而不是删掉
 *
 * ── 为什么是"移动"而不是"删除" ──────────────────────────────────────
 * 需求原话是「没有用的垃圾及时清洗」。但"这个文件有没有用"是**视角相关**的：
 * `_diag7.txt` 对当下是废纸，对"上一轮结论的证据链"可能是唯一凭证。
 * 一个会误删的清理器比不清理贵得多 —— 删掉的是别人复现结论的唯一依据。
 *
 * 所以这里的动作是**移动到一个项目内的 `.trash/<时间戳>/`**：
 *   · 可逆 —— 随时能原样拿回去，误删的代价从"不可逆"变成"多一步"；
 *   · 不依赖 OS API —— 本机 COM 调用被安全策略拦，跨平台回收站 API 各不相同，
 *     而 `renameSync` 在同一个卷内是原子的；
 *   · 可审计 —— 目录名带时间戳，账本里记下每一次移动。
 *
 * ── 三条硬边界（`test:fleet` 逐条断言）────────────────────────────────
 *   ① **只动 `_*` 临时产物**（`scanHygiene` 判为 `unused` 的那一组），
 *      且**排除 KEEP 名单**（`_v9_mdtable.mjs` / `_mdtable_bad.md` 这类
 *      "看着像垃圾、其实是工具"的文件）；
 *   ② **只动文件，永不删/移目录** —— 一次误移一个目录 = 一次事故；
 *   ③ **只动"至少 N 小时没被碰过"的**（默认 24h）。这条治的是最尴尬的一种：
 *      清理器把**当前这一轮正在用的取证文件**删了 —— 它刚刚才被写出来，
 *      mtime 是新的，所以"陈旧"这个条件是它唯一的保护。
 *
 * ── 为什么清理目录用时间戳命名，而不是固定 `.trash` ─────────────────
 * 把不同批次的清理混在同一个目录里，就再也没法回答"这一批是谁、什么时候、
 * 按什么规则移进来的"。时间戳让每一批**自带出处**，而"保留期一到该清哪一批"
 * 也就有了确定的答案。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, type Stats } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { appendEvent } from '../ledger.ts'
import { formatBytes, keepReason, scanHygiene, type HygieneEntry } from './hygiene.ts'

/** 一次清理最多动几个。理由：便于逐条核验，而不是护栏阈值。 */
export const CLEAN_MAX_ITEMS = 20
export const CLEAN_HARD_LIMIT = 50
/** 默认只清"至少这么久没被碰过"的。 */
export const DEFAULT_MIN_AGE_MS = 24 * 3_600_000
/** `.trash/` 里的批次超过这么久就值得人来看一眼（**本模块不自动删它**）。 */
export const TRASH_RETENTION_MS = 7 * 86_400_000

export interface CleanCandidate {
  /** 相对项目根的路径，统一 `/`。 */
  path: string
  bytes: number
  mtime: string
  group: string
  reason: string
}

export interface CleanSkip {
  path: string
  why: string
}

export interface CleanPlan {
  root: string
  /** 本次会动的东西。 */
  candidates: CleanCandidate[]
  /** 被规则挡下的，**带理由** —— 挡下了什么不比动了什么次要。 */
  skipped: CleanSkip[]
  bytes: number
  /** 请求的上限（可能被 `CLEAN_HARD_LIMIT` 压过）。 */
  limit: number
  minAgeMs: number
  trashDir: string
  now: number
  /** 扫描时一共看到多少 `unused` 组文件（候选之外的说明"还有更多，但本轮上限到了"）。 */
  unusedSeen: number
  limitReached: boolean
  note: string
}

export interface CleanResult extends CleanPlan {
  moved: { path: string; to: string; bytes: number }[]
  failed: { path: string; error: string }[]
  movedBytes: number
  /** ★ 真跑与试跑必须长得不一样。写进产出，下游就不能把试跑当成已清理。 */
  dryRun: boolean
  /** 移动后 `.trash` 批次的绝对路径（试跑时为 null）。 */
  batchDir: string | null
}

export interface CleanOptions {
  limit?: number
  minAgeMs?: number
  dryRun?: boolean
  /**
   * 只清这一组。默认 `agent-probe` —— **有意只开放这一组**：
   * `backup` / `stale-artifact` 的 verdict 是 `review`，那两类要人看一眼才算数
   * （备份按定义要留够时间；陈旧结论可能被文档引用着）。
   */
  group?: string
  now?: number
  /** 注入给测试：只清路径匹配它的（用于构造"这一批"）。 */
  pathFilter?: (rel: string) => boolean
  scanEntries?: HygieneEntry[]
}

function relOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

/** 三态：这个路径能不能被本模块动。"不确定"必须是单独的答案，不能混进"能"。 */
export type CleanVerdict = 'ok' | 'refuse' | 'unsure'

/**
 * 逐条判定。**单独导出**是为了让门禁能对一个具体路径断言
 * （判据 3：「这条负向断言有没有一个"只有它"会命中的输入」）。
 */
export function judgePath(root: string, rel: string, abs: string): { verdict: CleanVerdict; why: string } {
  // ① 必须在扫描根之内。防 `../` 逃逸。
  const nRoot = resolve(root)
  const nAbs = resolve(abs)
  if (nAbs !== nRoot && !nAbs.startsWith(nRoot + sep)) {
    return { verdict: 'refuse', why: '路径在项目根之外' }
  }
  // ② 只动项目根下划线开头的临时产物。
  if (rel.includes('/')) return { verdict: 'refuse', why: '不在项目根（只在根目录的临时产物里清理）' }
  // ★ 保留名单检查必须在"像临时产物"之前 —— `_v9_mdtable.mjs` 与 `_mdtable_bad.md`
  //   长得就是标准的临时产物（下划线 + .mjs/.md），但它们是**工具与它的夹具**。
  //   实测抓到的漏洞：`judgePath()` 单独调用时把它判成了 `ok`（可清理）——
  //   当前调用链上 `scanHygiene` 会先把它归到 keep 组所以还没出事，
  //   但判定器本身不该依赖"调用方替我筛过"。判据只写一份（`keepReason`）。
  const kept = keepReason(rel)
  if (kept) return { verdict: 'refuse', why: `在保留名单里：${kept}` }
  if (!/^_/.test(rel)) return { verdict: 'refuse', why: '不以 _ 开头，不属于临时取证产物' }
  if (!/\.(ts|mjs|js|json|md|txt|log|png)$/.test(rel)) {
    return { verdict: 'unsure', why: '扩展名不在已知的临时产物白名单里' }
  }
  // ③ 必须是**文件**。目录一律不动。
  let st: Stats
  try {
    st = statSync(abs)
  } catch {
    return { verdict: 'unsure', why: '读不到它的状态' }
  }
  if (!st.isFile()) return { verdict: 'refuse', why: '不是文件（目录一律不动）' }
  return { verdict: 'ok', why: '项目根的临时取证产物' }
}

/**
 * 出一份清理计划。**这个函数不动任何东西** —— 真动在 `runClean()` 里。
 *
 * 拆成两步的理由与两段式确认同源：用户/调用方在看到"将要发生什么"之后
 * 才决定要不要发生。试跑与真跑共用同一份计划逻辑，所以试跑说的和真跑做的
 * 是同一件事（不会出现"试跑说 5 个、真跑动了 7 个"）。
 */
export function planClean(root: string, opts: CleanOptions = {}): CleanPlan {
  const now = opts.now ?? Date.now()
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS
  const limit = Math.min(Math.max(1, opts.limit ?? CLEAN_MAX_ITEMS), CLEAN_HARD_LIMIT)
  const group = opts.group ?? 'agent-probe'
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const trashDir = join('.trash', stamp)

  const entries = opts.scanEntries ?? scanHygiene(root, { maxEntries: 500, now }).entries
  const inGroup = entries.filter((e) => e.group === group)
  const skipped: CleanSkip[] = []
  const candidates: CleanCandidate[] = []

  for (const e of inGroup) {
    const abs = resolve(join(root, e.path))
    if (opts.pathFilter && !opts.pathFilter(e.path)) {
      skipped.push({ path: e.path, why: '不在本次指定的范围内' })
      continue
    }
    const j = judgePath(root, e.path, abs)
    if (j.verdict !== 'ok') {
      skipped.push({ path: e.path, why: j.why })
      continue
    }
    const age = now - new Date(e.mtime).getTime()
    if (age < minAgeMs) {
      // ★ 这一条挡的正是"把当前这一轮正在用的取证文件清掉"。
      const hours = (age / 3_600_000).toFixed(1)
      skipped.push({ path: e.path, why: `才 ${hours} 小时没动过（不足 ${(minAgeMs / 3_600_000).toFixed(0)} 小时）—— 很可能正在被用着` })
      continue
    }
    candidates.push({
      path: e.path,
      bytes: e.bytes,
      mtime: e.mtime,
      group: e.group,
      reason: e.reason,
    })
  }

  candidates.sort((a, b) => b.bytes - a.bytes)
  const limitReached = candidates.length > limit
  const picked = candidates.slice(0, limit)
  for (const c of candidates.slice(limit)) {
    skipped.push({ path: c.path, why: `本次上限 ${limit} 个，轮到下一轮` })
  }

  return {
    root,
    candidates: picked,
    skipped,
    bytes: picked.reduce((s, c) => s + c.bytes, 0),
    limit,
    minAgeMs,
    trashDir,
    now,
    unusedSeen: inGroup.length,
    limitReached,
    note:
      `只动「${group}」这一组，且只动**至少 ${(minAgeMs / 3_600_000).toFixed(0)} 小时没被碰过**的。` +
      '动作是把文件移进项目内的 .trash/（可随时取回），不是删除 —— ' +
      '.trash 里超过保留期的部分本模块**只报告不清理**，因为真删是不可逆动作。',
  }
}

/**
 * 真跑：按计划把文件移进 `.trash/<时间戳>/`。
 *
 * ★ 保留相对路径结构（`_a/b.txt` → `.trash/<ts>/_a/b.txt`）：不保留的话
 *   同名文件会互相覆盖，而"清理"变成"替换"是这里最坏的一种失败。
 */
export function runClean(root: string, opts: CleanOptions = {}): CleanResult {
  const dryRun = opts.dryRun ?? true
  const plan = planClean(root, opts)
  const moved: CleanResult['moved'] = []
  const failed: CleanResult['failed'] = []
  let batchDir: string | null = null

  if (!dryRun) {
    for (const c of plan.candidates) {
      const from = resolve(join(root, c.path))
      const to = resolve(join(root, plan.trashDir, c.path))
      try {
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        moved.push({ path: c.path, to: relOf(root, to), bytes: c.bytes })
        batchDir = resolve(join(root, plan.trashDir))
      } catch (e) {
        // ★ 逐个 catch，不让一个失败中断整批：部分成功也必须被如实报告
        //   （"实际动了 3 个、4 个失败"远比"失败了"有用）。
        failed.push({ path: c.path, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (moved.length > 0) {
      appendEvent('FILE_TRASHED', {
        batch: plan.trashDir,
        count: moved.length,
        bytes: plan.bytes,
        group: opts.group ?? 'agent-probe',
        paths: moved.map((m) => m.path).slice(0, CLEAN_MAX_ITEMS),
      })
    }
  }

  return {
    ...plan,
    moved,
    failed,
    movedBytes: moved.reduce((s, m) => s + m.bytes, 0),
    dryRun,
    batchDir,
  }
}

// ─────────────────── `.trash` 的只读视图（不可逆部分只报告） ───────────────────

export interface TrashBatch {
  batch: string
  files: number
  bytes: number
  at: string
  ageDays: number
  /** 是否已过保留期。过了只是"值得人来看一眼"，**不代表自动删**。 */
  expired: boolean
}

export interface TrashView {
  trashPath: string
  exists: boolean
  batches: TrashBatch[]
  totalFiles: number
  totalBytes: number
  expiredBatches: number
  note: string
}

export function listTrash(root: string, now = Date.now()): TrashView {
  const trashRoot = join(root, '.trash')
  const out: TrashView = {
    trashPath: trashRoot,
    exists: existsSync(trashRoot),
    batches: [],
    totalFiles: 0,
    totalBytes: 0,
    expiredBatches: 0,
    note:
      '这里列的是可以被恢复的文件（.trash 里的内容原样保留着相对路径）。' +
      '**本模块不会自动清理 .trash** —— 那是不可逆动作，要人来点。',
  }
  if (!out.exists) {
    // ★ 「.trash 不存在」不等于"没有垃圾"，而是"还没有清理过一批"。
    //   这个区别必须写出来，否则空视图会被读成"环境很干净"。
    out.note = '还没有 .trash 目录 —— 意思是**一批都还没清理过**，不是"没有垃圾"。' + out.note
    return out
  }
  let names: string[]
  try {
    names = readdirSync(trashRoot)
  } catch {
    return out
  }
  for (const name of names) {
    const abs = join(trashRoot, name)
    let st: Stats
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    let files = 0
    let bytes = 0
    const walk = (d: string, depth: number): void => {
      if (depth > 6) return
      let ns: string[]
      try {
        ns = readdirSync(d)
      } catch {
        return
      }
      for (const n of ns.slice(0, 2000)) {
        const a = join(d, n)
        let s: Stats
        try {
          s = statSync(a)
        } catch {
          continue
        }
        if (s.isDirectory()) walk(a, depth + 1)
        else if (s.isFile()) {
          files += 1
          bytes += s.size
        }
      }
    }
    walk(abs, 0)
    // ★ 批次名是 `planClean` 生成的 `2026-09-19T14-30-00-000Z`（ISO 里的
    //   `:` 与 `.` 被换成了 `-`）。解析**必须显式**：上一版用一串下标记
    //   拼字符串，只要格式稍有变化就会静默回退成目录 mtime，
    //   于是"这批是什么时候清的"从一个可核对的事实变成猜的。
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name)
    const at = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : st.mtime
    const ageDays = Math.max(0, (now - at.getTime()) / 86_400_000)
    const expired = now - at.getTime() > TRASH_RETENTION_MS
    if (expired) out.expiredBatches += 1
    out.batches.push({ batch: name, files, bytes, at: at.toISOString(), ageDays, expired })
    out.totalFiles += files
    out.totalBytes += bytes
  }
  out.batches.sort((a, b) => b.ageDays - a.ageDays)
  return out
}

/** 给人念的一句话。 */
export function renderCleanBrief(r: CleanResult): string {
  if (r.candidates.length === 0) {
    return (
      `没有可清理的临时产物：扫描根 ${r.root} 里，属于「agent-probe」且超过 ` +
      `${(r.minAgeMs / 3_600_000).toFixed(0)} 小时没动过的一共 0 个` +
      (r.skipped.length > 0 ? `（另有 ${r.skipped.length} 个被规则挡下，理由是"正在被用着"或"不在白名单"）` : '') +
      '。这不是"清理失败"，是"确实没得清"。'
    )
  }
  if (r.dryRun) {
    return (
      `试跑：本来会把 ${r.candidates.length} 个临时产物移进 ${r.trashDir}，共 ${formatBytes(r.bytes)}。` +
      `**这一步没有真的动任何文件**（dryRun）。要真清理，把 dryRun 关掉。`
    )
  }
  if (r.moved.length === 0) {
    return (
      `真跑但一个也没移动：${r.failed.length} 个全部失败` +
      (r.failed[0] ? `（第一个是 ${r.failed[0].path}：${r.failed[0].error}）` : '') +
      '。失败原因在上面，不是"没得清"。'
    )
  }
  return (
    `清理完成：把 ${r.moved.length} 个临时产物（${formatBytes(r.movedBytes)}）移进了 ${r.trashDir}` +
    (r.failed.length > 0 ? `，另有 ${r.failed.length} 个移动失败（见失败清单）` : '') +
    '。这些文件**都还能拿回来** —— 它们在 .trash 里保持着原来的相对路径。'
  )
}
