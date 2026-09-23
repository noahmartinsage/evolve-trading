/**
 * 文档表格结构门禁 —— 扫 docs/ 与 README，校验所有 markdown 表格的列数自洽。
 *
 * ══ 它查的两类缺陷 ═════════════════════════════════════════════════════
 *   ① MISMATCH       —— 某一行与表头的列数不一致 ⇒ 渲染错位（多插一列最容易出）
 *   ② BROKEN-ROW     —— 某个单元格里被插进了**裸换行**，那一行的后半截
 *                       落到表外变成普通段落。列数校验完全看不见它，
 *                       因为扫表循环遇到"不以 `|` 结尾的行"就退出了。
 *
 * ══ 为什么这个脚本自己带反向对照 ═══════════════════════════════════════
 * 2026-09-18 实测过一次：这个扫描器报"0 处"，而文档里当时有 **3 处**真实错位。
 * 根因就是上面那个提前退出 —— 它**没扫到该扫的地方**。
 * 「报 0」不等于「没有问题」，所以这个门禁不能只跑一遍真实文档：
 *
 *   A. 拿一个**故意写坏的夹具**跑一遍 ⇒ 必须恰好报出预期条数与种类（证明它会红）
 *   B. 拿真实文档跑一遍          ⇒ 必须 0 处（证明它对正确的输入不报错）
 *
 * 少了 A，B 的绿就没有意义（判据 2：一个不会红的检查，和一个不报错的检查，
 * 同样没用）。夹具以字面量写在本文件里，不会随目录变化而"恰好"找不到。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type ProblemKind = 'MISMATCH' | 'BROKEN-ROW'

export interface Problem {
  kind: ProblemKind
  /** 1-based 行号 */
  line: number
  detail: string
  text: string
}

/**
 * 去掉转义竖线再数分隔符。
 *
 * ★ 必须先剥 `\|`：它是正文里的**字面竖线**（本项目大量用于代码片段与
 *   「实际出声：… | 试听 | …」这类读数）。当成列分隔符会把写对的行判成错 ——
 *   第一版就是这么误报 4 处的。一个会对正确输入报错的检查比不报错的更费人。
 */
export function cols(line: string): number {
  return line.replace(/\\\|/g, '\u0000').split('|').length
}

const isHeaderRow = (l: string | undefined): boolean => l !== undefined && /^\|.*\|\s*$/.test(l)
const isSeparatorRow = (l: string | undefined): boolean => l !== undefined && /^\|[\s:|-]+\|\s*$/.test(l)

/** 纯函数：扫一段 markdown，返回全部结构问题。 */
export function scanTables(text: string): { problems: Problem[]; tables: number } {
  const lines = text.split(/\r?\n/)
  const problems: Problem[] = []
  let tables = 0
  let i = 0
  while (i < lines.length) {
    if (!isHeaderRow(lines[i]) || !isSeparatorRow(lines[i + 1])) {
      i++
      continue
    }
    const headCols = cols(lines[i])
    tables++
    const headerLine = i + 1
    let j = i
    while (j < lines.length && isHeaderRow(lines[j])) {
      const c = cols(lines[j])
      if (c !== headCols) {
        problems.push({
          kind: 'MISMATCH',
          line: j + 1,
          detail: `期望 ${headCols} 列，实际 ${c} 列（表头在第 ${headerLine} 行）`,
          text: lines[j],
        })
      }
      j++
    }
    // ★ 续行 / 未闭合检测。这一段正是原实现的盲区：旧版 `while` 一遇到
    //   "不以 | 结尾的行" 就 `i = j; continue`，那行之后再也不看。
    const nxt = lines[j]
    if (nxt !== undefined) {
      const looksLikeNewBlock =
        /^\s*$/.test(nxt) || /^(\||>|#{1,6}\s|```|[-*+]\s|\d+\.\s|\t)/.test(nxt)
      const isRowLikeButUnterminated = /^\s*\|/.test(nxt) && !/^\|.*\|\s*$/.test(nxt)
      if (isRowLikeButUnterminated) {
        problems.push({
          kind: 'BROKEN-ROW',
          line: j + 1,
          detail: `行首是 | 但行尾没有闭合（表头在第 ${headerLine} 行）`,
          text: nxt,
        })
      } else if (!looksLikeNewBlock) {
        problems.push({
          kind: 'BROKEN-ROW',
          line: j + 1,
          detail: `上一行（第 ${j} 行）的单元格里有裸换行（表头在第 ${headerLine} 行）`,
          text: nxt,
        })
      }
    }
    i = j
  }
  return { problems, tables }
}

/** 递归收集 markdown 文件，跳过 node_modules / dist / 隐藏目录。 */
function collectMarkdown(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) collectMarkdown(p, acc)
    else if (name.endsWith('.md')) acc.push(p)
  }
  return acc
}

// ─────────────────────────────────────────────────────────────────────
// A. 反向对照夹具：3 处已知缺陷，种类也要对得上
// ─────────────────────────────────────────────────────────────────────
const BAD_FIXTURE = [
  '| a | b |', // 1 表头
  '| - | - |', // 2 分隔
  '| 1 | 2 |', // 3 正常
  '| 3 | 4 | 5 |', // 4 ← MISMATCH（多一列）
  '',
  '| p | q |', // 6 表头
  '| - | - |', // 7 分隔
  '| 9 | 8 |', // 8 正常
  '| 7 | 8', // 9 ← BROKEN-ROW 未闭合（行首 | 但行尾没有 |）
  '',
  '| x | y |', // 11 表头
  '| - | - |', // 12 分隔
  '| 1 | 2 |', // 13 正常
  '| 3 | 4 |', // 14 正常
  '3 | 4 |', // 15 ← BROKEN-ROW 续行（上一行被裸换行拆开）
  '',
  '| z | w |', // 17 表头
  '| - | - |', // 18 分隔
  '| `a \\| b` | 2 |', // 19 正常：转义竖线不算分隔符
].join('\n')

const EXPECTED_BAD: { kind: ProblemKind; line: number }[] = [
  { kind: 'MISMATCH', line: 4 },
  { kind: 'BROKEN-ROW', line: 9 },
  { kind: 'BROKEN-ROW', line: 15 },
]

const CLEAN_FIXTURE = [
  '| a | b | c |',
  '| - | - | - |',
  '| `x \\| y` | 2 | 3 |',
  '',
  '段落文字，不以竖线开头。',
  '',
  '| p | q |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n')

let failed = 0
const fail = (msg: string) => {
  failed++
  console.error(`✗ ${msg}`)
}

// ── A. 坏夹具必须报出预期的问题 ──────────────────────────────────────
const bad = scanTables(BAD_FIXTURE)
for (const exp of EXPECTED_BAD) {
  const hit = bad.problems.some((p) => p.kind === exp.kind && p.line === exp.line)
  if (!hit) {
    fail(`反向对照失败：坏夹具第 ${exp.line} 行的 ${exp.kind} 没有被报出来（"不会红的检查"）`)
  }
}
if (bad.problems.length !== EXPECTED_BAD.length) {
  fail(`反向对照失败：坏夹具应报 ${EXPECTED_BAD.length} 处，实报 ${bad.problems.length} 处`)
}

// ── B. 干净夹具必须 0 处（不能对正确的输入报错） ─────────────────────
const clean = scanTables(CLEAN_FIXTURE)
if (clean.problems.length !== 0) {
  fail(`反向对照失败：干净夹具被误报 ${clean.problems.length} 处 —— 这是"对正确输入报错"，比不报错更费人`)
  for (const p of clean.problems) console.error(`    ${p.kind} @${p.line}: ${p.detail}`)
}
console.log(
  `反向对照：坏夹具 ${bad.tables} 张表 → 报出 ${bad.problems.length} 处（预期 ${EXPECTED_BAD.length}）；` +
    `干净夹具 ${clean.tables} 张表 → 报出 ${clean.problems.length} 处（预期 0）`,
)

// ── C. 真实文档必须 0 处 ─────────────────────────────────────────────
/**
 * ★ 判据 11：「这条检查扫到它要检查的东西了吗？」
 *   扫到 0 个文件 / 0 张表时，下面的 totalBad 也恰好是 0 —— 门禁会**绿**。
 *   于是"路径写错 / docs 被改名 / cwd 不对"全部伪装成"文档没问题"。
 *   所以先要求它确实扫到了东西，再相信它报的 0。
 */
let docFiles: string[] = []
try {
  docFiles = collectMarkdown('docs')
} catch (e) {
  fail(`扫不到 docs/ 目录（cwd=${process.cwd()}）—— 这个门禁的绿没有意义：${(e as Error).message}`)
}
const files = docFiles.concat(['README.md']).filter((f) => {
  try {
    return statSync(f).isFile()
  } catch {
    return false
  }
})
if (files.length === 0) {
  fail(`一个 markdown 文件都没扫到（cwd=${process.cwd()}）—— "0 处问题"只是因为没扫，不是文档干净`)
}

let totalTables = 0
let totalBad = 0
for (const f of files) {
  const r = scanTables(readFileSync(f, 'utf8'))
  totalTables += r.tables
  totalBad += r.problems.length
  for (const p of r.problems) {
    console.error(`✗ ${f}:${p.line} ${p.kind} —— ${p.detail}`)
    console.error(`    ${p.text.slice(0, 140)}`)
  }
}
console.log(`文档表格：扫 ${files.length} 个文件 / ${totalTables} 张表，结构问题 ${totalBad} 处`)

if (totalTables === 0) {
  fail(`扫到 ${files.length} 个文件却 0 张表 —— 表头/分隔行识别可能失效了，这个"0 处问题"不可信`)
}
if (totalBad > 0) fail(`文档里有 ${totalBad} 处表格结构问题`)
if (failed > 0) {
  console.error(`\n❌ 文档表格门禁未通过（${failed} 项）`)
  process.exit(1)
}
console.log('✅ 文档表格门禁通过（含反向对照）')
