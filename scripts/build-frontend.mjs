/**
 * 构建前端 —— 带一条**只针对"删除被拦"**的降级。
 *
 * ── 它解决的问题 ────────────────────────────────────────────────────
 * `vite build` 默认先**清空** `dist/assets`，而"清空"= 删掉里面每个文件。
 * 在 agent 工具环境里，删除要过一道**批量删除护栏**：按会话计预算
 * （阈值默认 20，状态在 `%TEMP%\codebuddy-safe-delete-bulk\<hash>\state.json`），
 * 一个会话累计删除超阈值后，**未被显式放行**的删除全部被拒。
 *
 * 实测（见 docs/DEV_PROGRESS.md §3.41）：
 *   本会话的桶 count 已经到 171 / 148 / 92，**全都超阈值**。
 *   于是 `vite build` 在 700~800ms 内失败并打印一堆 `errors: [`，
 *   而**同一份源码在别处手动构建完全正常**（那里有 escalation 放行）。
 *   表现是"双击启动器报『构建失败，修掉再双击一次』"——
 *   而代码一个字都没错。这是一颗**假红地雷**：它会把人引去查 vite 配置、
 *   磁盘空间、依赖版本，全是错方向。
 *
 * ── 降级策略（关键：只降这一种失败）────────────────────────────────
 *   ① 先按正常人那样 `vite build`（清空目录，保持行为不变）；
 *   ② 只有当失败信息**确实是"删除被拒"**（EPERM/EACCES/拒绝访问/
 *      safe-delete 之类）时，才用 `--emptyOutDir=false` 重试一次；
 *   ③ 其它任何失败（TS 报错、语法错、插件错）**原样失败**，不降级。
 *
 * 这样做的理由：降级只在"为了清目录而失败"时发生。
 * 关掉清空**不影响正确性** —— 页面用的是 `dist/index.html` 里写死的那个
 * 文件名，堆在 `dist/assets` 里的旧 bundle 没人引用。
 * 而如果无差别地总是关掉清空，就会把一个真实的构建错误也一起盖掉。
 *
 * 用法：node scripts/build-frontend.mjs     （package.json 的 build 指向它）
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/*
 * ══ ★★ 为什么直接 `node node_modules/vite/bin/vite.js` ══════════════════════
 *
 * 第一版写的是 `execFileSync('npx', ['vite','build'], { shell: true })`。
 * **在 CI 里它炸了**，而且炸得很隐蔽：
 *
 *     'vite' 不是内部或外部命令，也不是可运行的程序或批处理文件。
 *     ✗ 构建失败（不是"清目录被拦"那种，因此**不降级**）。
 *
 * 两个观察：
 *
 * ① `shell: true` 把命令交给 **cmd.exe**，而 `vite` 在 `node_modules/.bin/` 下
 *    是三个文件：`vite`(sh) / `vite.cmd` / `vite.ps1`。cmd 只认 `.cmd`，
 *    能不能解析到**取决于 PATH 里有没有 .bin** —— 而我原来那条命令把
 *    `npx` 和 `vite` 都当 cmd 内建/外部命令去解析，等于把成败押在 PATH 上。
 *    实测：同一台机、同一个目录，交互式跑 A/B 两条都 OK，CI 那条却挂 ——
 *    **这就是判据 13 说的那种"看起来同一个东西，实际不是"**。
 *
 * ② ★ 更值得记的是**它失败时的表现是对的**：脚本没有顺手降级，而是明确说
 *    "这不是清目录被拦，不降级"。也就是说——**护栏在脚本自己的 bug 面前生效了**。
 *    如果当初写成"失败就无脑 `--emptyOutDir=false` 重试"，这一次会**重试成功**
 *    （因为第二次同样走 npx，同样找不到 vite ⇒ 不，它会同样失败）……
 *    真正危险的是另一种写法：**失败就无条件换一条能跑的路** ⇒ 那就会把
 *    "npx 环境没配好"这种真实问题盖掉。⇒ **降级的条件越窄，它越不可能撒谎。**
 *
 * ⇒ 正解：**绕开 PATH，直接把入口文件交给当前这个 node 进程**。
 *    `require.resolve` 在这里也不好用（vite 的 `exports` 不含 `./bin/vite.js`，
 *    实测报 `Package subpath './bin/vite.js' is not defined`），所以读 `bin` 字段。
 */
function resolveViteBin() {
  const pkgPath = resolve(ROOT, 'node_modules', 'vite', 'package.json')
  if (!existsSync(pkgPath)) {
    console.error('✗ 找不到 node_modules/vite —— 依赖没装（先跑 npm ci / npm install）。')
    process.exit(1)
  }
  const binRel = JSON.parse(readFileSync(pkgPath, 'utf8')).bin?.vite
  if (!binRel) {
    console.error('✗ vite 的 package.json 里没有 bin.vite —— vite 换过打包方式了，请核对。')
    process.exit(1)
  }
  const bin = resolve(ROOT, 'node_modules', 'vite', binRel)
  if (!existsSync(bin)) {
    console.error('✗ vite 入口文件不存在：' + bin)
    process.exit(1)
  }
  return bin
}

const VITE_BIN = resolveViteBin()

function runVite(extraArgs) {
  try {
    execFileSync(process.execPath, [VITE_BIN, 'build', ...extraArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 300_000,
    })
    return { ok: true, out: '' }
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? '') + String(e?.stderr ?? '') + ' ' + String(e?.message ?? '') }
  }
}

/** 「删不掉」是**一种**失败，不是全部失败 —— 必须能认出来。 */
function looksLikeDeleteBlocked(out) {
  return (
    /safe-delete|SAFE_DELETE|trash-failed|bulk-guard/i.test(out) ||
    /EPERM|EACCES|EBUSY/i.test(out) ||
    /拒绝访问|无法删除|cannot remove|unlink|rmdir/i.test(out)
  )
}

// ① 正常构建（保持与原来完全一致的行为）
const first = runVite([])
if (first.ok) process.exit(0)

// ② 只在"清目录被拦"时降级
if (!looksLikeDeleteBlocked(first.out)) {
  console.error('')
  console.error('✗ 构建失败（不是"清目录被拦"那种，因此**不降级**）。')
  console.error('  上面的报错就是真实原因，请照它修。')
  process.exit(1)
}

console.error('')
console.error('⚠ 构建失败的原因是**清空 dist/assets 被拒**（批量删除护栏），不是代码问题。')
console.error('  ⇒ 改用 --emptyOutDir=false 重试。这只跳过"清目录"，编译/打包一模一样。')
console.error('  （旧 bundle 会留在 dist/assets 里，但页面只认 index.html 里写死的那一个，不影响正确性）')
console.error('')

const second = runVite(['--emptyOutDir=false'])
if (second.ok) process.exit(0)

console.error('')
console.error('✗ 降级重试仍然失败 —— 这次的报错是真实的，请照它修。')
process.exit(1)
