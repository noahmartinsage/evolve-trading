/**
 * 门：**报错里让用户去跑的命令，必须真的能跑。**
 *
 * ══ 它防的是哪一种事故 ═══════════════════════════════════════════════
 * 2026-09-22 实测：`scripts/breadth-run.ts` 在"没有历史数据"时打印
 *
 *     先跑 npm run fetch:history（多品种用 --symbols A,B,C）
 *
 * 而 `package.json` 里**没有** `fetch:history` 这个脚本 —— 真名是 `data:fetch`。
 * 同一个仓库里另外 6 处都写对了（`factor-smoke` / `factorService` /
 * `feasibility` / `mission` …），只有这一处是错的。
 *
 * 这类错误的成本不对称：它出现在**故障路径上** —— 用户正卡着，照着这句话
 * 敲下去，得到 `Missing script`，然后他要么怀疑是权限/环境问题，要么去改
 * 一个本来正确的脚本。**报错把人引向一个不存在的动作，比不报错更费人**
 * （判据 D7「我这个输出把用户引向哪个动作？那个动作有用吗？」）。
 *
 * ══ 为什么只扫源码，不扫文档 ═════════════════════════════════════════
 * 文档里的命令**允许**暂时不存在：`docs/FILTERS-TECH-DESIGN.md` 的计划表里
 * 就写着「`npm run test:filters` 并入 ci 链」——那是一条还没做的计划，
 * 把它判红就是**对正确的输入报错**（判据 A1），而误报会让人开始无视这道门。
 * 源码里的报错不一样：它此刻就会被打出来，用户此刻就会照着做。
 *
 * ★ 一律用剥掉注释的代码（判据 C11）：注释里可以自由地讨论"历史上曾经有过
 *   `npm run xxx`"，那不是给用户看的动作。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['scripts', 'server', 'src']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.trash', '_upstream', '.preview-pylibs'])

/** 剥注释：块注释 + 整行注释。留下的是"会真的被打出来"的那部分。 */
function readCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}
const declared = new Set(Object.keys(pkg.scripts ?? {}))

interface Ref {
  script: string
  file: string
}
const refs: Ref[] = []
const referenced = new Set<string>()

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const code = readCode(readFileSync(file, 'utf8'))
    // `npm run <名>` —— 名字里允许字母/数字/`:`/`-`/`_`（本项目大量脚本用 `组:动作`）。
    for (const m of code.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      const script = m[1]
      referenced.add(script)
      refs.push({ script, file: relative(ROOT, file).replace(/\\/g, '/') })
    }
  }
}

// ── 反空转（判据 B1/A3）：这条门自己先证明"它扫到了东西" ──
// 少了这一段，一次写错的目录名或改坏的正则会让它扫到 0 处、
// 然后**以 0 个问题通过** —— 那是"绿"的两种事因里最隐蔽的一种。
console.log(`扫描 ${SCAN_DIRS.join(' / ')} · 命中 npm run 引用 ${refs.length} 处 · 涉及 ${referenced.size} 个脚本名`)
if (refs.length === 0) {
  console.error('❌ 一处引用都没扫到 —— 目录名/正则坏了，这道门此刻是空转的，不能当成"通过".')
  process.exit(1)
}

const broken = refs.filter((r) => !declared.has(r.script))
const byScript = new Map<string, string[]>()
for (const b of broken) {
  const list = byScript.get(b.script) ?? []
  list.push(b.file)
  byScript.set(b.script, list)
}

if (byScript.size > 0) {
  console.error('')
  console.error('❌ 这些命令被写在源码的报错/提示里，但 package.json 里没有：')
  for (const [script, files] of [...byScript.entries()].sort()) {
    console.error(`  · npm run ${script}`)
    for (const f of [...new Set(files)]) console.error(`      ${f}`)
    // 给一条**够得着**的下一步：最接近的已声明脚本名，让改的人不用自己找。
    const near = [...declared].filter((d) => d.includes(script.split(':').pop() ?? script) || script.includes(d))
    if (near.length > 0) console.error(`      最接近的已声明脚本：${near.slice(0, 5).map((n) => `npm run ${n}`).join(' / ')}`)
  }
  console.error('')
  console.error('★ 不要为了让这道门闭嘴而删掉那句提示 —— 用户正卡着，那句话就是他的下一步动作。')
  console.error('  要么把脚本名改成真的存在的那一个，要么就在 package.json 里把它加上。')
  process.exit(1)
}

console.log(`✅ 全部命中 ${referenced.size} 个脚本名都在 package.json 里；源码里没有指向不存在命令的提示`)
