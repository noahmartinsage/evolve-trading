/**
 * 文件体检 —— 只读扫描，产出"哪些文件可回收"的清单
 *
 * ── 这个模块**没有删除能力**，这是刻意的 ─────────────────────────────
 * 需求原话是「单独检查校验文件是否有用，没有用的及时清理垃圾」。但"自动删"这件事
 * 在本项目有三条硬约束，任何一条都足以否掉它：
 *   ① 本机删除护栏的预算**按会话计**（阈值 50）—— 一次自动批量删会用光整个会话的
 *      预算，之后 `vite build`（构建前必清 `dist/assets`）**必然假红**。表现是
 *      "一个毫不相关的门禁突然崩了，而它上次跑是绿的"，最容易被误判成代码缺陷。
 *   ② 判据 2：**先修检查器，再相信它的红**。会误删的检查器比不删的更贵。
 *   ③ "这个文件有没有用"是**视角相关**的：`_diag7.txt` 对我是废纸，对"上一轮
 *      结论的证据链"是唯一凭证。自动删掉它，等于把结论的第二来源抹了。
 * 所以这里只做**取证**：扫出候选、给出理由、算出可回收体积，由人来删。
 * `test:fleet` 有一条**源码扫描**断言钉住这一点：本模块不许出现 unlink / rm / rmdir。
 *
 * ── 为什么要分组而不是给一个大数字 ──────────────────────────────────
 * "可回收 21MB"这句话没有动作含义 —— 21MB 里哪些删了没事（探针脚本）、
 * 哪些删了要重跑（构建产物）、哪些**根本不该删**（备份按定义要留够时间），
 * 三类的下一步动作完全不同，所以必须分组并各自给 verdict。
 */
import { existsSync, readdirSync, statSync, type Stats } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type HygieneVerdict = 'unused' | 'review' | 'keep'

export interface HygieneEntry {
  /** 相对项目根的路径，统一用 `/`。 */
  path: string
  bytes: number
  mtime: string
  group: string
  /** 为什么它可疑 / 为什么它要留。人读的一句话。 */
  reason: string
  verdict: HygieneVerdict
}

export interface HygieneGroup {
  id: string
  label: string
  files: number
  bytes: number
  /** 这一组的默认处置建议。 */
  verdict: HygieneVerdict
  /** 处置这一组需要注意什么。 */
  caution: string
}

export interface HygieneReport {
  root: string
  scannedAt: string
  totalFiles: number
  totalBytes: number
  /** 刻意没进去的目录。**明写出来** —— 否则"总数看着不大"会被误读成"磁盘很干净"。 */
  skippedDirs: string[]
  groups: HygieneGroup[]
  entries: HygieneEntry[]
  entriesTruncated: boolean
  reclaimableBytes: number
  keepBytes: number
  note: string
}

export interface HygieneOptions {
  /** 逐条列出的上限，默认 200。超出的只进分组统计。 */
  maxEntries?: number
  /** 单文件超过这个体积单独列一组。默认 20MB。 */
  oversizeBytes?: number
  /** `artifacts/*.json` 超过这个天数算陈旧。默认 30 天。 */
  staleArtifactDays?: number
  /** 只统计不进明细的重目录。默认 `dist`（几千个构建产物，逐条列没有动作价值）。 */
  aggregateDirs?: string[]
  now?: number
}

/** 不进目录树。`node_modules` 的体积不是"垃圾"，它是依赖本身。 */
const SKIP_DIRS = ['node_modules', '.git', '.preview', '.preview-pylibs']

/**
 * 明确要保留的。**带理由** —— 一份只有文件名的保留清单，
 * 下一轮没人知道为什么它在上面，就会被当成漏网之鱼删掉。
 *
 * ★ 导出给 `cleaner.ts` 用：清理的路径判据必须**共用这一份**。
 *   实测抓到的漏洞：`judgePath()` 单独调用时把 `_v9_mdtable.mjs`（在 KEEP 名单里）
 *   判成了"可清理" —— 因为判定器不知道保留名单。当前调用链上
 *   `scanHygiene` 会先把 KEEP 文件归到 `keep` 组、不进候选，所以还没出事；
 *   但 `judgePath` 是导出的，任何一个新调用方都会踩这个坑。
 */
export const KEEP_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^_v9_mdtable\.mjs$/, reason: '旧版 markdown 表格校验器：现役校验器 scripts/docs-table-check.ts 的对照实现' },
  { pattern: /^_mdtable_bad\.md$/, reason: '上面那个校验器的夹具，删了它就复现不了"校验器会报红"' },
  { pattern: /^\.env(\.|$)/, reason: '环境变量与密钥配置' },
  { pattern: /^docs\//, reason: '技术文档' },
  { pattern: /^data\/factors\/index\.json/, reason: '因子台账（能力产物，不是缓存）' },
  { pattern: /^data\/factors\/strategies\.json/, reason: '策略台账（能力产物，不是缓存）' },
]

/** 这个相对路径是不是在保留名单里。返回理由或 null。 */
export function keepReason(rel: string): string | null {
  return KEEP_PATTERNS.find((k) => k.pattern.test(rel))?.reason ?? null
}

const GROUP_META: Record<string, { label: string; verdict: HygieneVerdict; caution: string }> = {
  'agent-probe': {
    label: '临时探针 / 取证产物',
    verdict: 'unused',
    caution: '删前确认它不是某条结论的唯一证据 —— 上一轮的取证输出删掉就复现不出来了',
  },
  backup: { label: '备份文件', verdict: 'review', caution: '备份按定义要留够时间；只删已确认无用的那一批' },
  'stale-artifact': { label: '陈旧烟测结论', verdict: 'review', caution: '过期结论留着会误导，但删前确认没有文档引用它' },
  oversize: { label: '超大文件', verdict: 'review', caution: '逐个看；大文件往往是被谁真的用着的模型 / 数据集' },
  keep: { label: '明确保留', verdict: 'keep', caution: '这些不参与回收' },
}

function relOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 扫一遍工作区。**只读**：只调用 stat / readdir。
 *
 * 上限保护：目录深度 8 层、单目录最多 4000 项。防止某次误把大目录套进来就卡住
 * 整个服务 —— 体检本身不该成为一次事故。
 */
export function scanHygiene(root: string, opts: HygieneOptions = {}): HygieneReport {
  const now = opts.now ?? Date.now()
  const maxEntries = opts.maxEntries ?? 200
  const oversizeBytes = opts.oversizeBytes ?? 20 * 1024 * 1024
  const staleMs = (opts.staleArtifactDays ?? 30) * 86_400_000
  const aggregateDirs = opts.aggregateDirs ?? ['dist']

  const entries: HygieneEntry[] = []
  const groupAgg = new Map<string, { files: number; bytes: number }>()
  let totalFiles = 0
  let totalBytes = 0

  const bump = (id: string, bytes: number): void => {
    const a = groupAgg.get(id) ?? { files: 0, bytes: 0 }
    a.files += 1
    a.bytes += bytes
    groupAgg.set(id, a)
  }

  const list = (dir: string, depth: number): { files: number; bytes: number } => {
    if (depth > 8) return { files: 0, bytes: 0 }
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return { files: 0, bytes: 0 }
    }
    let files = 0
    let bytes = 0
    for (const name of names.slice(0, 4000)) {
      const abs = join(dir, name)
      let st: Stats
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.includes(name)) continue
        if (aggregateDirs.includes(name)) continue
        const sub = list(abs, depth + 1)
        files += sub.files
        bytes += sub.bytes
      } else if (st.isFile()) {
        files += 1
        bytes += st.size
      }
    }
    return { files, bytes }
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.slice(0, 4000)) {
      if (depth === 0 && aggregateDirs.includes(name)) continue
      const abs = join(dir, name)
      const rel = relOf(root, abs)
      let st: Stats
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.includes(name)) continue
        walk(abs, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      totalFiles += 1
      totalBytes += st.size

      // ① 明确保留的：只统计，不进明细 —— 保留项逐条列出来会把 maxEntries 用光，
      //    真正要人看的可回收明细反而被截掉。
      const kept = KEEP_PATTERNS.find((k) => k.pattern.test(rel))
      if (kept) {
        bump('keep', st.size)
        continue
      }
      // ② 探针 / 取证脚本：项目根下划线开头的临时文件。
      if (!rel.includes('/') && /^_/.test(name) && /\.(ts|mjs|js|json|md|txt|log|png)$/.test(name)) {
        bump('agent-probe', st.size)
        if (entries.length < maxEntries) {
          entries.push({
            path: rel,
            bytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            group: 'agent-probe',
            reason: '项目根的临时探针 / 取证产物：跑完即弃，进不了 CI',
            verdict: 'unused',
          })
        }
        continue
      }
      // ③ 陈旧烟测结论。
      if (rel.startsWith('artifacts/') && name.endsWith('.json') && st.mtimeMs < now - staleMs) {
        bump('stale-artifact', st.size)
        const age = Math.floor((now - st.mtimeMs) / 86_400_000)
        if (entries.length < maxEntries) {
          entries.push({
            path: rel,
            bytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            group: 'stale-artifact',
            reason: `烟测产物已 ${age} 天未更新：结论本身可能早已失效，留着反而误导`,
            verdict: 'review',
          })
        }
        continue
      }
      // ④ 备份文件。
      if (/\.bak(-|\.|$)|\.backup$|\.orig$|~$/.test(name)) {
        bump('backup', st.size)
        if (entries.length < maxEntries) {
          entries.push({
            path: rel,
            bytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            group: 'backup',
            reason: '备份文件：按定义只应保留有限时间',
            verdict: 'review',
          })
        }
        continue
      }
      // ⑤ 超大文件。
      if (st.size > oversizeBytes) {
        bump('oversize', st.size)
        if (entries.length < maxEntries) {
          entries.push({
            path: rel,
            bytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            group: 'oversize',
            reason: `单文件超过 ${formatBytes(oversizeBytes)}，值得单独看一眼`,
            verdict: 'review',
          })
        }
      }
    }
  }

  walk(root, 0)

  // 聚合目录（构建产物）：体积要算进来，但不逐条列举。
  for (const d of aggregateDirs) {
    const abs = join(root, d)
    if (!existsSync(abs)) continue
    const agg = list(abs, 0)
    totalFiles += agg.files
    totalBytes += agg.bytes
    groupAgg.set(`build-output:${d}`, { files: agg.files, bytes: agg.bytes })
  }

  const groups: HygieneGroup[] = [...groupAgg.entries()]
    .map(([id, a]) => {
      const meta = GROUP_META[id] ?? { label: id, verdict: 'review' as HygieneVerdict, caution: '未分类，逐个看' }
      return { id, label: meta.label, files: a.files, bytes: a.bytes, verdict: meta.verdict, caution: meta.caution }
    })
    .sort((a, b) => b.bytes - a.bytes)

  return {
    root,
    scannedAt: new Date(now).toISOString(),
    totalFiles,
    totalBytes,
    skippedDirs: [...SKIP_DIRS, ...aggregateDirs.map((d) => `${d}/（只算体积不逐条列）`)],
    groups,
    entries,
    entriesTruncated: entries.length >= maxEntries,
    reclaimableBytes: groups.filter((g) => g.verdict === 'unused').reduce((s, g) => s + g.bytes, 0),
    keepBytes: groups.filter((g) => g.verdict === 'keep').reduce((s, g) => s + g.bytes, 0),
    note:
      '本模块**只报告不删除**（源码里没有任何 unlink / rm 调用，由 test:fleet 断言）。' +
      '要真删，请把清单交给人确认后执行 —— 本机的删除护栏按会话计预算，' +
      '一次自动批量删会让随后的 build 假红。',
  }
}

/** 给面板 / 语音用的一句话。硬数字现算，不缓存。 */
export function renderHygieneBrief(r: HygieneReport): string {
  if (r.totalFiles === 0) {
    return `工作区里一个文件都没扫到（扫描根 ${r.root}），这更像是路径不对，而不是磁盘很干净。`
  }
  const unused = r.groups.filter((g) => g.verdict === 'unused')
  return (
    `扫了 ${r.totalFiles} 个文件，合计 ${formatBytes(r.totalBytes)}。` +
    `可以直接回收的 ${formatBytes(r.reclaimableBytes)}，明确保留的 ${formatBytes(r.keepBytes)}。` +
    (unused.length > 0
      ? `可回收的那部分主要是${unused.map((g) => `${g.label}（${g.files} 个，${formatBytes(g.bytes)}）`).join('、')}。`
      : '没有任何一组被判为可直接回收 —— 这不奇怪：可疑的那些都要人看一眼才算数。') +
    `另外没算进体积的有 ${r.skippedDirs.join('、')}。`
  )
}
