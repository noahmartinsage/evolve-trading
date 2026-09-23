/**
 * 「负向断言会对正确输出报错」的机械检查（判据 30 的机制化）。
 *
 * ── 它防的是什么 ──────────────────────────────────────────────────────
 * 写界面的门禁时，人很自然地写：
 *
 *   assertTrue('空榜要说空榜', empty.includes('空榜') && !empty.includes('读不到'), empty)
 *
 * 而被测代码里那句正确输出是「空榜 —— 这一轮没有任何品种被提到（**不是读不到**）」。
 * 断言当场报红 —— 报的不是缺陷，是**它自己选错了词**（判据 2：对正确的输入报错，
 * 比不报错的检查更费人：它会训练你忽略它的红）。
 *
 * ★ 这不是理论。本仓库在**同一天**复现了三次，写法一模一样：
 *   ① `provider-health-smoke` D4/D5：「不用停用它」被 `!/停用/` 判死；
 *   ② `news-smoke` N10：「不是"没有待办"」被 `!/没有待办/` 判死；
 *   ③ `stack-smoke` S-A7：「（不是读不到）」被 `!line.includes('读不到')` 判死。
 * 三次都要人来发现、人来改。所以它必须变成一道门。
 *
 * ── 三代判据的演进（每一代都是被上一代的假红/漏报逼出来的）────────────
 * 第一代：**硬编码否决词表**（停用 / 没有待办 / 不会 / 不用 …）。
 *   第 ③ 次复现时什么都没报 —— 因为"读不到"不在表里。
 *   靠人往表里加词 = 把纪律换了个地方继续靠纪律。弃。
 *
 * 第二代：**动态判据** —— 负向断言里的中文词只要在生产代码（`server/` 与 `src/`）
 *   里出现过就算可疑。三次复现全部命中，且随代码演进自动更新。但它**太宽**：
 *   常用词（"没有"、"读到"）到处都有 ⇒ 12 处假红，其中好几处是上一代里
 *   我自己按建议改出来的正确写法。一道满天飞假红的门等于没有门。弃。
 *
 * 第三代（本版）：**收紧到"紧邻否定词"** —— 生产代码里那个词必须是被
 *   `不 / 没 / 无 / 非 / 别 / 未` 直直地贴着写的（前 4 个字符内含），才算危险。
 *   为什么这样切：这类事故的**充要形态**就是"生产文案把同一个词以否定形式写进同一句"，
 *   而"否定形式"在中文里必然在一个否定词之后。
 *     · 「不**用停用**它」      → 停用 被 不用 贴着 ⇒ 抓
 *     · 「不是"**没有待办**"」  → 没有待办 被 不是" 贴着 ⇒ 抓
 *     · 「（不是**读不到**）」  → 读不到 被 不是 贴着 ⇒ 抓
 *     · 「我**没读到**内容」    → 没读到 前面只有"，" ⇒ 放（它本来就是那一支的正当说法）
 *     · 「这**不等于**已验证」  → 不等于 前面是"但" ⇒ 放
 *   三次复现全抓、上一代的假红全放。
 *
 * ── 合格的写法是什么 ──────────────────────────────────────────────────
 * 选**只有别的分支才会出现**的词，而且那个词在生产代码里**不是被否定着写的**：
 *   · 读不到那一支：`这不等于`（只有 `miss()` 会印）
 *   · 空榜那一支：`空榜`
 *   · 有数据那一支：品种代号
 * 这样"某支不许说另一支的话"就成了一个真有信息量的判断。
 *
 * 合法的例外：在本行加 `negation-ok: <理由>`，检查器会跳过并打印理由
 * （豁免要看得见，不能是沉默的）。★ 若某条豁免**已经用不上**（这一行不再命中
 * 判据 30），它会被单独列出来 —— 过期的豁免是负债，不是资产。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一条被扫到的负向断言。 */
export interface Suspicious {
  file: string
  line: number
  /** 触发它的那个中文词。 */
  token: string
  /** 这个词在生产代码的哪一行（指得到具体位置）。 */
  productionAt: string
  /** 那一行的原文片段 —— 让人一眼看见"否定词就贴在旁边"。 */
  productionLine: string
  text: string
  exemption: string | null
}

/**
 * 从一行里抓出所有**负向断言**，返回它们的"判据文本"。
 *
 * ★★ 这里最容易搞错的一点（第一代就错了）：`if (!/X/.test(y)) fail(...)`
 *    **不是**负向断言。它是本仓库的 `fail-on-missing` 惯用法，含义是
 *    "断言 X 在 y 里" —— `!` 只是 `if` 的取反，不是对文案的否定。
 *    把它算进来会一次报出 41 处假红（实测），而一道满天飞假红的门
 *    等于没有门。所以判据收窄成：**`assert*` 的条件被取反**。
 */
export function negativeAssertionsOf(line: string): { kind: 'regex' | 'includes'; token: string }[] {
  if (!/\bassert/i.test(line)) return []
  const out: { kind: 'regex' | 'includes'; token: string }[] = []
  // `!/…/` 形态
  const r = /!\s*\/((?:[^/\\\n]|\\.)+)\//.exec(line)
  if (r) out.push({ kind: 'regex', token: r[1] })
  // `!x.includes('…')` 形态 —— S-A7 那次用的就是这种，第一代完全没扫到。
  const inc = /!\s*[\w.$?[\]]*\.includes\(\s*'([^']*)'\s*\)/.exec(line)
  if (inc) out.push({ kind: 'includes', token: inc[1] })
  return out
}

/** 抽出文本里的中文词（≥2 个连续汉字）。 */
export function cjkRuns(s: string, min = 2): string[] {
  return s.match(new RegExp(`[\\u4e00-\\u9fa5]{${min},}`, 'g')) ?? []
}

/** 中文里的否定语素。一个词被"否定着写"必然长在这些字之后。 */
const NEGATOR_RE = /[不没无非别未]/

/**
 * 「前几个字符」的窗口大小。4 是个实测值：
 *   「不**用停用**它」   → 停用   前 2 字 = 不用   ✓
 *   「不是"**没有待办**"」→ 没有待办 前 3 字 = 不是"  ✓
 *   「（不是**读不到**）」 → 读不到  前 2 字 = 不是   ✓
 * 窗口取太大会把"上一句的否定词"也算进来（假红），太小会漏掉「不是"…"」这种带引号的形态。
 */
export const NEGATOR_BEFORE = 4

/** 这个词在生产代码这一行里，是不是被否定词贴着写的（任一处命中即算）。 */
export function negatedIn(line: string, word: string, before: number = NEGATOR_BEFORE): boolean {
  if (word.length === 0) return false
  let i = line.indexOf(word)
  while (i >= 0) {
    if (NEGATOR_RE.test(line.slice(Math.max(0, i - before), i))) return true
    i = line.indexOf(word, i + 1)
  }
  return false
}

/** 生产代码语料：`server/` 与 `src/` 里的全部源码文本。 */
export interface Corpus {
  /** 这个词出现在生产代码的哪些行（最多 limit 条）。 */
  occurrences(word: string, limit?: number): { at: string; line: string }[]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      // 只扫真正的生产代码目录。测试夹具（fixtures/artifacts/dist）里的文本
      // 不是"我们的文案"，把它们算进语料会凭空造出很多命中。
      if (name === 'fixtures' || name === 'artifacts' || name === 'dist') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

export function buildCorpus(root: string): Corpus {
  const files: { path: string; lines: string[] }[] = []
  for (const base of ['server', 'src']) {
    let paths: string[]
    try {
      paths = walk(join(root, base))
    } catch {
      continue
    }
    for (const p of paths) {
      // 相对路径（跨平台）：直接展示绝对路径会让人没法在编辑器里定位。
      const rel = p.replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '')
      files.push({ path: rel, lines: readFileSync(p, 'utf8').split(/\r?\n/) })
    }
  }
  return {
    occurrences(word: string, limit = 40): { at: string; line: string }[] {
      const out: { at: string; line: string }[] = []
      for (const f of files) {
        for (let i = 0; i < f.lines.length; i++) {
          if (!f.lines[i].includes(word)) continue
          out.push({ at: `${f.path}:${i + 1}`, line: f.lines[i] })
          if (out.length >= limit) return out
        }
      }
      return out
    },
  }
}

/**
 * 扫一份源码文本，返回所有可疑行。
 *
 * 判据（第三代）：负向断言里的中文词，**在生产代码里被否定词贴着写过** ⇒ 可疑。
 * 理由：那个词已经被用来表达"另一种状态"了，断言再有否定地用它，
 * 就是对一份**完全正确**的输出报错（判据 2）。
 */
export function scanSource(file: string, src: string, corpus: Corpus): Suspicious[] {
  const out: Suspicious[] = []
  const lines = src.split(/\r?\n/)
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    // 注释行不算：解释"为什么不能这么写"的注释本身就是正确内容。
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const a of negativeAssertionsOf(line)) {
      for (const word of cjkRuns(a.token)) {
        const hit = corpus.occurrences(word, 60).find((o) => negatedIn(o.line, word))
        if (!hit) continue
        const ex = /(?:^|\s)negation-ok:\s*([^"'\\\n]+)/.exec(line)
        out.push({
          file,
          line: i + 1,
          token: word,
          productionAt: hit.at,
          productionLine: hit.line.trim().slice(0, 120),
          text: trimmed.slice(0, 160),
          exemption: ex ? ex[1].trim() : null,
        })
      }
    }
  })
  return out
}

/** 声明了 `negation-ok` 的行 —— 用来发现**已经用不上**的过期豁免。 */
export function exemptionMarks(src: string): { line: number; reason: string }[] {
  const out: { line: number; reason: string }[] = []
  src.split(/\r?\n/).forEach((line, i) => {
    const ex = /(?:^|\s)negation-ok:\s*([^"'\\\n]+)/.exec(line)
    if (ex) out.push({ line: i + 1, reason: ex[1].trim() })
  })
  return out
}

/**
 * 自检。**必须先跑它**：一道"扫了 0 个文件然后报通过"的门，
 * 比没有这道门更坏 —— 它把"我没在工作"显示成"一切正常"（判据 13）。
 */
function selfTest(corpus: Corpus, scanned: number, root: string): string[] {
  const errs: string[] = []
  if (scanned < 10) errs.push(`只扫到 ${scanned} 个脚本 —— 这不像是在扫本仓库的 scripts/ 目录`)
  if (corpus.occurrences('读不到', 1).length === 0) {
    errs.push('语料里找不到"读不到" —— server/ 与 src/ 没被读到，后面的"未命中"不可信')
  }
  // ★ 语料必须真的指得着文件（不是空壳）。上面那条只证明"读到了字符串"。
  if (corpus.occurrences('读不到', 1)[0]?.at === undefined) errs.push('语料给不出文件位置')

  const re = negativeAssertionsOf("assert.ok(!/停用/.test(x))")
  if (re.length !== 1 || re[0].token !== '停用') errs.push('没认出 !/…/ 这种写法')
  const inc = negativeAssertionsOf("assertTrue('x', !line.includes('读不到'), line)")
  if (inc.length !== 1 || inc[0].token !== '读不到') errs.push('没认出 !x.includes(…) 这种写法')
  if (negativeAssertionsOf('assert.equal(a, b)').length !== 0) errs.push('把非负向断言当成了负向断言')
  if (negativeAssertionsOf('x.includes("abc")').length !== 0) errs.push('把正向断言当成了负向断言')

  // ── 判据本身的标定：假语料上场，正反两向都要对 ──────────────────
  // 不加这一步的话，"这道门报 0 处"既可能是"没有坏写法"，也可能是
  // "negatedIn 永远返回 false" —— 两种情况的输出一模一样（判据 13）。
  const fake = (line: string): Corpus => ({ occurrences: () => [{ at: 'synthetic.ts:1', line }] })
  const probe = (word: string, prodLine: string): number =>
    scanSource('s.ts', `assertTrue('t', !line.includes('${word}'), line)\n`, fake(prodLine)).length
  // ★ 两向都要标定，否则"报 0 处"既可能是没有坏写法，也可能是 negatedIn 永远返回 false。
  if (probe('读不到', '（不是读不到）') === 0) errs.push('「（不是读不到）」这种命中形态没被抓到 —— 这道门是哑的')
  if (probe('停用', '这一支不用停用它') === 0) errs.push('「不用停用它」这种命中形态没被抓到')
  if (probe('没有待办', '不是"没有待办"') === 0) errs.push('「不是"没有待办"」这种命中形态没被抓到')
  // 反向：正当说法（同一个词，但前面没有否定词）**不许**被当成危险。
  if (probe('没读到', '我没读到内容，换个附件') !== 0) errs.push('把"我没读到内容"当成危险了 —— 这道门会假红')
  if (probe('读不到', '文件读不到时走兜底') !== 0) errs.push('把不带否定的"文件读不到"当成危险了 —— 会假红')
  if (!negatedIn('这一支不用停用它', '停用')) errs.push('negatedIn 认不出「不用停用」')
  if (negatedIn('今天停用它了', '停用')) errs.push('negatedIn 把没有否定词的句子当成危险')
  if (negatedIn('（不是读不到）', '读不到') !== true) errs.push('negatedIn 认不出全角括号里的「不是读不到」')

  // 真语料上的关键自检：构造一条**真会命中**的坏行。
  const caught = scanSource('synthetic.ts', "assertTrue('t', !line.includes('读不到'), line)\n", corpus)
  if (caught.length === 0) errs.push('构造的坏行（!…includes("读不到")）在真语料上没被抓到')

  // 注释不算
  if (scanSource('synthetic.ts', "// 别写 !line.includes('读不到')\n", corpus).length !== 0) {
    errs.push('把注释里的例子当成真断言了')
  }

  // 豁免生效
  const exempt = scanSource(
    'synthetic.ts',
    "assertTrue('t', !line.includes('读不到'), line) // negation-ok: 这一支不会有否定说法\n",
    corpus,
  )
  if (exempt.length !== 1 || exempt[0].exemption === null) errs.push('negation-ok 豁免没生效')

  // 中文抽取
  if (cjkRuns('空榜 —— 不是读不到').join(',') !== '空榜,不是读不到') {
    errs.push(`中文词抽取不对：${cjkRuns('空榜 —— 不是读不到').join(',')}`)
  }
  // 豁免行抽取
  if (exemptionMarks("x // negation-ok: 理由甲\n").length !== 1) errs.push('豁免行抽取不对')

  // 目录必须真的存在（防止在错误的 cwd 下"扫了个寂寞还报通过"）
  try {
    statSync(join(root, 'server'))
  } catch {
    errs.push(`cwd 下没有 server/ 目录：${root}`)
  }
  return errs
}

function main(): void {
  const root = process.cwd()
  const corpus = buildCorpus(root)
  const dir = join(root, 'scripts')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))

  const hits: Suspicious[] = []
  const used = new Set<string>()
  const declared: { file: string; line: number; reason: string }[] = []
  for (const f of files) {
    // ★ 本文件自己跳过：它必须**构造**坏样例来证明自己抓得到（"报 0 ≠ 没有错"）。
    //   那些坏样例是字符串字面量，不是对本仓库文案的断言，算进去这道门会永远红。
    //   代价（本文件内部的断言不再被覆盖）由上面的 selfTest() 承担。
    if (f === 'negation-assert-check.ts') continue
    const src = readFileSync(join(dir, f), 'utf8')
    const found = scanSource(f, src, corpus)
    hits.push(...found)
    for (const h of found) if (h.exemption) used.add(`${f}:${h.line}`)
    for (const m of exemptionMarks(src)) declared.push({ file: f, line: m.line, reason: m.reason })
  }

  const errs = selfTest(corpus, files.length, root)
  if (errs.length > 0) {
    console.error('[FAIL] 这道检查器自己没有通过自检 —— 它的"通过"不可信：')
    for (const e of errs) console.error(`  - ${e}`)
    process.exit(1)
  }

  const exempt = hits.filter((h) => h.exemption !== null)
  const bad = hits.filter((h) => h.exemption === null)

  console.log(
    `扫了 ${files.length} 个脚本 · 负向断言里的中文词在生产代码里被"否定着写" ${hits.length} 处（豁免 ${exempt.length} 处）`,
  )
  for (const h of exempt) {
    console.log(`  · 豁免 scripts/${h.file}:${h.line} 「${h.token}」 —— ${h.exemption}`)
    console.log(`      生产代码这么写：${h.productionAt}  ${h.productionLine}`)
  }

  // ★ 过期的豁免：这一行已经不命中判据 30 了，理由还挂着。
  //   不是失败（豁免不比不写坏），但要说出来 —— 它会让下一个人以为
  //   "这一行曾经危险过、判断过了"，而实际上它现在什么都不挡。
  const stale = declared.filter((d) => !used.has(`${d.file}:${d.line}`))
  if (stale.length > 0) {
    console.log(`  · 有 ${stale.length} 处 negation-ok 已经用不上了（这一行不再命中判据 30，可以删掉它）：`)
    for (const s of stale) console.log(`      scripts/${s.file}:${s.line} —— ${s.reason}`)
  }

  if (bad.length > 0) {
    console.error('')
    console.error(`[FAIL] 负向断言选了生产文案里"被否定着写"的词 ${bad.length} 处（判据 30）：`)
    for (const h of bad) {
      console.error(`  scripts/${h.file}:${h.line}  「${h.token}」在生产代码里被否定着写：`)
      console.error(`      ${h.productionAt}  ${h.productionLine}`)
      console.error(`      这一行：${h.text}`)
      console.error('      怎么改：换成**只有别的分支才会出现**的词（例如 miss() 独有的「这不等于」、空榜独有的「空榜」）')
      console.error('      确实安全的话：在本行加 `negation-ok: <理由>`，理由会被打印出来')
    }
    process.exit(1)
  }

  console.log('NEGATION ASSERT CHECK PASSED · 自检全项通过 · 没有负向断言在生产代码"被否定着写"的词上撞车')
  if (exempt.length > 0) console.log(`（另有 ${exempt.length} 处显式豁免，理由已打印在上面 —— 豁免是看得见的）`)
}

// 只有直接跑它时才执行；被 import 时不执行（好让别处复用纯函数）。
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/negation-assert-check.ts')) {
  main()
}

export const __selfTest = { negativeAssertionsOf, cjkRuns, scanSource, buildCorpus, negatedIn, exemptionMarks }
