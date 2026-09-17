/**
 * 策略政策快照与版本控制（内化 R20 `policy_snapshot.py` 范式）
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────
 * 本项目的策略行为由**四份彼此独立的配置**共同决定：
 *
 *   ① 风控参数（`.env` / riskConstants 活绑定）
 *   ② 自进化心法库（evolutionShield 的 lessons）
 *   ③ 拦截闸门（interceptors 的启用状态与顺序）
 *   ④ 模型路由（LLM 供应商启用状态与激活模型）
 *
 * 只改其中一份，回溯时就已经无法回答「上周三那笔亏损，当时到底是什么配置」。
 * 更要命的是**回滚**：调参后发现变差，想退回原状却没有「原状」这个对象——
 * 只能靠人肉回忆改了哪几个键。这不是可观测性不足，是**缺少版本概念**。
 *
 * R20 的做法是对四个单元各算一个**确定性指纹**，打包成不可变快照归档，
 * 带索引、一键回滚、导出导入。指纹的价值在于：配置改没改，
 * 比字符串就够了，不需要把四份配置全量 diff。
 *
 * ── 指纹为什么必须是确定性的 ────────────────────────────────────────
 * 指纹只对**语义字段**（键、值、启用状态、顺序）取值，且：
 *   - 对象键排序后再拼装 → 不受内存里插入顺序影响；
 *   - 数值先归一化（去掉 -0、限制有效位）→ 不受浮点尾差影响；
 *   - 不含 时间戳 / id / 运行期计数 → 同样的策略配置永远得到同样的指纹。
 * 否则「配置文件没动但指纹变了」，回滚判定立刻失去意义。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJson } from './atomicWrite.ts'
import { currentValues } from './riskConfig.ts'
import { loadLessons } from './evolutionShield.ts'
import { listInterceptors } from './interceptors.ts'
import { listProviders, getActiveLlm } from './llmProviders.ts'

const ARCHIVE_DIR = process.env.EV_POLICY_ARCHIVE_DIR ?? join('data', 'policy_archives')
const INDEX_FILE = join(ARCHIVE_DIR, 'index.json')

/** 归档保留上限（超出后按创建时间删最旧）。R20 同类实现保留 10 份。 */
const MAX_ARCHIVES = Number(process.env.EV_POLICY_ARCHIVE_KEEP ?? 50)

export const POLICY_SNAPSHOT_FORMAT = 'evolve.policy-snapshot'
export const POLICY_SNAPSHOT_VERSION = 1

/** 四个配置单元的标识。 */
export type PolicyUnit = 'riskParams' | 'lessons' | 'interceptors' | 'llmRouting'

export const POLICY_UNIT_LABEL: Record<PolicyUnit, string> = {
  riskParams: '风控参数',
  lessons: '自进化心法库',
  interceptors: '拦截闸门',
  llmRouting: '模型路由',
}

export interface UnitFingerprint {
  unit: PolicyUnit
  label: string
  hash: string
  /** 该单元内有语义的条目数，用于快速判断规模是否突变 */
  count: number
  summary: string
}

export interface PolicySnapshot {
  format: typeof POLICY_SNAPSHOT_FORMAT
  version: number
  /** 组合指纹：对四单元指纹排序后再哈希 */
  fingerprint: string
  createdAt: string
  /** 快照里塞入的策略包（回滚时直接回灌） */
  package: {
    riskParams: Record<string, number>
    lessons: Array<{ id: string; enabled: boolean; ruleText: string; healthScore: number; category: string; ttlDays: number }>
    interceptors: Array<{ id: string; enabled: boolean; order: number }>
    llmRouting: { activeId: string | null; activeModel: string | null; enabledIds: string[] }
  }
  units: UnitFingerprint[]
  note?: string
}

// ─────────────────────────────────────────────────────────────
// 确定性序列化
// ─────────────────────────────────────────────────────────────

/**
 * 数值归一化：消除 -0、浮点尾差、科学计数法差异。
 * 1e-9 以下视为 0——风控参数的有效精度远低于此，保留尾差只会让指纹噪声化。
 */
function normNum(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return 'NaN'
  if (Math.abs(n) < 1e-9) return '0'
  return String(Number(n.toFixed(9)))
}

function hashOf(parts: unknown): string {
  // 递归规范化后再哈希：对象按键排序、数值归一化。
  // JSON.stringify 的 replacer 无法重排键顺序，所以先构造规范化结构。
  const canonical = (v: unknown): unknown => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return normNum(v)
    if (typeof v === 'boolean' || typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(canonical)
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(o).sort()) out[k] = canonical(o[k])
      return out
    }
    return String(v)
  }
  return createHash('sha256').update(JSON.stringify(canonical(parts))).digest('hex')
}

function short(h: string): string {
  return h.slice(0, 12)
}

// ─────────────────────────────────────────────────────────────
// 采集四单元
// ─────────────────────────────────────────────────────────────

function collectRiskParams(): { data: Record<string, number>; fp: UnitFingerprint } {
  const values = currentValues() as unknown as Record<string, number>
  const clean: Record<string, number> = {}
  for (const k of Object.keys(values).sort()) clean[k] = Number(values[k])
  const hash = hashOf(clean)
  return {
    data: clean,
    fp: {
      unit: 'riskParams',
      label: POLICY_UNIT_LABEL.riskParams,
      hash: short(hash),
      count: Object.keys(clean).length,
      summary: `${Object.keys(clean).length} 项阈值`,
    },
  }
}

function collectLessons(): { data: PolicySnapshot['package']['lessons']; fp: UnitFingerprint } {
  const lessons = loadLessons().map((l) => ({
    id: l.id,
    enabled: l.enabled,
    ruleText: l.ruleText,
    healthScore: l.healthScore,
    category: String(l.category),
    ttlDays: l.ttlDays,
  }))
  // 心法按 id 排序后再哈希：库内顺序不承载语义，否则重启后重排会导致指纹漂移
  lessons.sort((a, b) => a.id.localeCompare(b.id))
  const hash = hashOf(lessons)
  const active = lessons.filter((l) => l.enabled).length
  return {
    data: lessons,
    fp: {
      unit: 'lessons',
      label: POLICY_UNIT_LABEL.lessons,
      hash: short(hash),
      count: lessons.length,
      summary: `${lessons.length} 条（生效 ${active}）`,
    },
  }
}

function collectInterceptors(): { data: PolicySnapshot['package']['interceptors']; fp: UnitFingerprint } {
  // order 参与指纹：闸门顺序会改变拦截结果（先拦价格几何还是先拦置信度，
  // 决定用户看到的拒绝理由），所以它是语义字段，不能剥掉。
  const list = listInterceptors()
    .map((i) => ({ id: i.id, enabled: i.enabled, order: i.order }))
    .sort((a, b) => a.order - b.order)
  const hash = hashOf(list)
  return {
    data: list,
    fp: {
      unit: 'interceptors',
      label: POLICY_UNIT_LABEL.interceptors,
      hash: short(hash),
      count: list.length,
      summary: `${list.filter((i) => i.enabled).length}/${list.length} 启用`,
    },
  }
}

function collectLlmRouting(): { data: PolicySnapshot['package']['llmRouting']; fp: UnitFingerprint } {
  const providers = listProviders()
  const active = getActiveLlm()
  const enabledIds = providers
    .filter((p) => p.enabled)
    .map((p) => p.id)
    .sort()
  const data: PolicySnapshot['package']['llmRouting'] = {
    activeId: active?.id ?? null,
    activeModel: active?.model ?? null,
    enabledIds,
  }
  const hash = hashOf(data)
  return {
    data,
    fp: {
      unit: 'llmRouting',
      label: POLICY_UNIT_LABEL.llmRouting,
      hash: short(hash),
      count: providers.length,
      summary: active ? `激活 ${active.model}` : '无激活模型',
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 生成快照
// ─────────────────────────────────────────────────────────────

export function generatePolicySnapshot(note?: string): PolicySnapshot {
  const rp = collectRiskParams()
  const ls = collectLessons()
  const it = collectInterceptors()
  const ll = collectLlmRouting()

  const units = [rp.fp, ls.fp, it.fp, ll.fp]
  // 组合指纹：对 (unit, hash) 序列化后再哈希，单看四个短哈希拼串容易碰撞
  const fingerprint = short(hashOf(units.map((u) => [u.unit, u.hash])))

  return {
    format: POLICY_SNAPSHOT_FORMAT,
    version: POLICY_SNAPSHOT_VERSION,
    fingerprint,
    createdAt: new Date().toISOString(),
    package: {
      riskParams: rp.data,
      lessons: ls.data,
      interceptors: it.data,
      llmRouting: ll.data,
    },
    units,
    note,
  }
}

/** 当前快照（不落盘），供 UI 显示「现在的指纹」并与归档对比。 */
export function getCurrentPolicySnapshot(): PolicySnapshot {
  return generatePolicySnapshot()
}

export function formatPolicySnapshotSummary(s: PolicySnapshot): string {
  const parts = s.units.map((u) => `${u.label} ${u.hash}（${u.summary}）`)
  return `策略指纹 ${s.fingerprint}｜${parts.join('｜')}`
}

// ─────────────────────────────────────────────────────────────
// 归档索引
// ─────────────────────────────────────────────────────────────

export interface ArchiveEntry {
  id: string
  fingerprint: string
  createdAt: string
  note?: string
  units: UnitFingerprint[]
  /** 该归档是否与当前生效配置完全一致 */
  isCurrent?: boolean
}

interface ArchiveIndex {
  format: string
  version: number
  entries: ArchiveEntry[]
}

function ensureDir(): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true })
}

function readIndex(): ArchiveIndex {
  ensureDir()
  if (!existsSync(INDEX_FILE)) return { format: 'evolve.policy-archive-index', version: 1, entries: [] }
  try {
    const j = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as ArchiveIndex
    if (!Array.isArray(j.entries)) return { format: 'evolve.policy-archive-index', version: 1, entries: [] }
    return j
  } catch {
    // 索引损坏时**不猜测内容**，而是按归档文件重建（见 rebuildIndex）。
    // 静默返回空索引会表现为「归档全部消失」，比报错更误导。
    return rebuildIndexFromArchives()
  }
}

/**
 * 索引损坏时的重建：扫归档目录，从文件内容还原索引。
 *
 * 为什么值得写这段：索引是可再生的派生数据，而快照文件是原始事实。
 * 派生数据坏掉时应该能从事实重建——这决定了归档层能不能被信任。
 */
export function rebuildIndexFromArchives(): ArchiveIndex {
  ensureDir()
  const entries: ArchiveEntry[] = []
  let files: string[]
  try {
    files = readdirSync(ARCHIVE_DIR).filter((f) => f.startsWith('policy_') && f.endsWith('.json') && f !== 'index.json')
  } catch {
    files = []
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(ARCHIVE_DIR, f), 'utf8')) as PolicySnapshot
      if (s.format !== POLICY_SNAPSHOT_FORMAT) continue
      entries.push({
        id: f.slice(0, -5),
        fingerprint: s.fingerprint,
        createdAt: s.createdAt,
        note: s.note,
        units: s.units,
      })
    } catch {
      /* 单个归档损坏不影响其余条目 */
    }
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const idx: ArchiveIndex = { format: 'evolve.policy-archive-index', version: 1, entries }
  atomicWriteJson(INDEX_FILE, idx)
  return idx
}

function writeIndex(idx: ArchiveIndex): void {
  ensureDir()
  atomicWriteJson(INDEX_FILE, idx)
}

function archivePath(id: string): string {
  return join(ARCHIVE_DIR, `${id}.json`)
}

/**
 * 归档当前策略包。
 *
 * `skipIfUnchanged` 为真时，若当前指纹与最新归档一致则不再产生新条目——
 * 否则每次页面刷新都会留下一条一模一样的归档，索引很快被噪声淹没，
 * 真正有意义的版本反而找不到了。
 */
export function archiveCurrentPolicy(
  note?: string,
  opts: { skipIfUnchanged?: boolean } = {},
): { ok: boolean; entry?: ArchiveEntry; skipped?: boolean; reason?: string } {
  const snap = generatePolicySnapshot(note)
  const idx = readIndex()
  const latest = idx.entries[idx.entries.length - 1]

  if (opts.skipIfUnchanged !== false && latest && latest.fingerprint === snap.fingerprint) {
    return { ok: true, skipped: true, entry: latest, reason: '与最新归档指纹一致，未产生新版本' }
  }

  const stamp = snap.createdAt.replace(/[:.]/g, '-')
  const id = `policy_${stamp}_${snap.fingerprint}`
  atomicWriteJson(archivePath(id), snap)

  const entry: ArchiveEntry = {
    id,
    fingerprint: snap.fingerprint,
    createdAt: snap.createdAt,
    note,
    units: snap.units,
  }
  idx.entries.push(entry)

  // 裁剪：按时间删最旧，同时删掉对应文件，避免目录无限增长
  while (idx.entries.length > MAX_ARCHIVES) {
    const drop = idx.entries.shift()
    if (!drop) break
    try {
      if (existsSync(archivePath(drop.id))) unlinkSync(archivePath(drop.id))
    } catch {
      /* 文件删不掉不阻断索引裁剪 */
    }
  }

  writeIndex(idx)
  return { ok: true, entry }
}

/** 归档列表（附带 isCurrent 标记）。 */
export function listArchives(): ArchiveEntry[] {
  const idx = readIndex()
  const current = getCurrentPolicySnapshot().fingerprint
  return idx.entries
    .map((e) => ({ ...e, isCurrent: e.fingerprint === current }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function loadArchive(id: string): PolicySnapshot | null {
  const p = archivePath(id)
  if (!existsSync(p)) return null
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as PolicySnapshot
    return s.format === POLICY_SNAPSHOT_FORMAT ? s : null
  } catch {
    return null
  }
}

export function deleteArchive(id: string): boolean {
  const idx = readIndex()
  const before = idx.entries.length
  idx.entries = idx.entries.filter((e) => e.id !== id)
  if (idx.entries.length === before) return false
  try {
    if (existsSync(archivePath(id))) unlinkSync(archivePath(id))
  } catch {
    /* 索引已更新，文件残留无害 */
  }
  writeIndex(idx)
  return true
}

// ─────────────────────────────────────────────────────────────
// 回滚 / 导出导入
// ─────────────────────────────────────────────────────────────

export interface RestoreResult {
  ok: boolean
  id: string
  fingerprint: string
  /** 回滚后重新采集的指纹——必须等于目标指纹，否则说明回滚没真正生效 */
  appliedFingerprint?: string
  changedUnits: PolicyUnit[]
  reason?: string
}

/**
 * 一键回滚到某个归档。
 *
 * 与其他实现的关键差异：回滚后**重新采集一次指纹并比对**，
 * 而不是「写完就报成功」。这样任何「回滚了但引擎读到的还是旧值」的静默失败
 * 会立刻暴露，而不是等到下一笔交易异常时才发现。
 *
 * 注意：本函数只负责**校验与报告**，实际的回灌动作由调用方注入
 * （`apply`）——因为回灌要跨越风控参数落盘、心法库写库、拦截器开关、
 * 模型路由四条不同的通道，硬编码进这里会让本模块反向依赖整个服务端。
 */
export function restoreArchivedPolicy(
  id: string,
  apply: (snap: PolicySnapshot) => PolicyUnit[],
): RestoreResult {
  const snap = loadArchive(id)
  if (!snap) return { ok: false, id, fingerprint: '', changedUnits: [], reason: `归档不存在：${id}` }

  const before = getCurrentPolicySnapshot()
  let changedUnits: PolicyUnit[]
  try {
    changedUnits = apply(snap)
  } catch (e) {
    return {
      ok: false,
      id,
      fingerprint: snap.fingerprint,
      changedUnits: [],
      reason: `回灌失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const after = getCurrentPolicySnapshot()
  const matched = after.fingerprint === snap.fingerprint
  return {
    ok: matched,
    id,
    fingerprint: snap.fingerprint,
    appliedFingerprint: after.fingerprint,
    // 即便指纹已一致，也如实报告调用方声明的变更单元，便于审计
    changedUnits: changedUnits.length > 0 ? changedUnits : diffUnits(before.units, after.units),
    reason: matched
      ? undefined
      : `回滚后指纹 ${after.fingerprint} ≠ 目标 ${snap.fingerprint}，部分单元未能生效`,
  }
}

/** 比对两组单元指纹，返回发生变化的单元。 */
export function diffUnits(before: UnitFingerprint[], after: UnitFingerprint[]): PolicyUnit[] {
  const b = new Map(before.map((u) => [u.unit, u.hash]))
  const out: PolicyUnit[] = []
  for (const u of after) {
    if (b.get(u.unit) !== u.hash) out.push(u.unit)
  }
  return out
}

/** 自描述导出包：「一个 JSON 文件即可完整还原策略」。 */
export function exportPolicyPackage(id?: string): Record<string, unknown> {
  const snap = id ? loadArchive(id) : getCurrentPolicySnapshot()
  if (!snap) throw new Error(`归档不存在：${id}`)
  return {
    format: POLICY_SNAPSHOT_FORMAT,
    version: POLICY_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    snapshot: snap,
  }
}

/**
 * 校验导入包结构（**不执行**回灌）。
 * 导入路径必须先过校验再由调用方决定是否 apply——直接信任外部 JSON
 * 去覆盖风控参数，等于把闸门交给别人改。
 */
export function validateImportPackage(payload: unknown): { ok: boolean; snapshot?: PolicySnapshot; errors: string[] } {
  const errors: string[] = []
  const o = payload as { format?: unknown; snapshot?: unknown } | null
  if (!o || typeof o !== 'object') return { ok: false, errors: ['导入内容必须是 JSON 对象'] }
  const snap = (o.format === POLICY_SNAPSHOT_FORMAT ? o.snapshot : o) as PolicySnapshot | undefined
  if (!snap || typeof snap !== 'object') return { ok: false, errors: ['缺少 snapshot 内容'] }
  if (!snap.package || typeof snap.package !== 'object') errors.push('缺少 package')
  else {
    if (!snap.package.riskParams || typeof snap.package.riskParams !== 'object') errors.push('缺少 package.riskParams')
    if (!Array.isArray(snap.package.lessons)) errors.push('package.lessons 必须是数组')
    if (!Array.isArray(snap.package.interceptors)) errors.push('package.interceptors 必须是数组')
    if (!snap.package.llmRouting || typeof snap.package.llmRouting !== 'object') errors.push('缺少 package.llmRouting')
  }
  if (!Array.isArray(snap.units)) errors.push('缺少 units 指纹')
  return errors.length === 0 ? { ok: true, snapshot: snap, errors } : { ok: false, errors }
}

/** 供测试与诊断：归档目录路径。 */
export function archiveDir(): string {
  return ARCHIVE_DIR
}
