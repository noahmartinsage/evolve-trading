/**
 * 决定性的变异验证 —— 全部在**一条命令**里跑完，且**保证还原**。
 *
 * ── 三个踩出来的坑，每一个都会让人得出反向结论 ──────────────────────
 * ① **子进程随命令结束消失**：`chrome &` / `cmd /c start` / `detached+unref`
 *    都留不住。跨命令必然崩在"连不上 CDP"，而那会被读成"断言没抓到"。
 *    ⇒ 变异、构建、探针全放在**一条命令**里。
 * ② **不重建就验 = 验旧字节**：页面从 `dist/` 提供，改源码不重建，
 *    探针读的是上一次的产物。基线照样全绿、变异全"没抓到"。
 *    ⇒ 每轮都重建，并**自证**变异真的进了产物（读 bundle 里的字面量）。
 * ③ ★★ **`process.exit()` 会跳过 `finally`**（实测：finally 里的
 *    console.log 根本没打印）。于是"还原"从未执行，源码带着变异留在磁盘上，
 *    下一轮把它当"原始态"继续用 —— 变异变成累积的。
 *    ⇒ 不用 process.exit 早退；统一走一个 `done()` 收口，还原后再退出。
 *
 * 用法：node scripts/mutation-check.mjs
 * 退出码：0 抓住了 / 1 没抓住 / 3 未验证（环境或前置条件不满足）
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = process.cwd()
const TARGET = 'src/components/CommandPalette.tsx'
const CDP_PORT = process.env.CDP_PORT ?? '9224'
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const PROFILE_TAG = `_cdpprof_${CDP_PORT}`

const FROM = `dispatch({ type: 'SET_PAIR', pair: it.key })`
const TO = `dispatch({ type: 'SET_PAIR', pair: 'ETH-USDT' })`

const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')
const say = (s) => console.log(s)

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 300_000, ...opts })

/** 构建：`--emptyOutDir=false` 绕开被批量护栏拦掉的删除（详见 DEV_PROGRESS §3.41）。 */
function build() {
  sh('npx', ['tsc'])
  sh('npx', ['vite', 'build', '--emptyOutDir=false'])
}

function launchChrome() {
  const c = spawn('node', ['scripts/_cdp-launch.mjs'], {
    cwd: ROOT,
    env: { ...process.env, CDP_PORT },
    stdio: 'ignore',
    detached: true,
  })
  c.unref()
}

function killChrome() {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_TAG}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore', timeout: 25_000 },
    )
  } catch {
    /* 已退干净 */
  }
}

function probe() {
  try {
    return { code: 0, out: sh('node', ['scripts/probe-terminal-upgrade.ts'], { env: { ...process.env, CDP_BASE } }) }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const bundleProbe = (...a) => sh('node', ['scripts/_bundle-probe.mjs', ...a]).trim()
const red = (out, name) => new RegExp('^❌ ' + name + ' .*$', 'm').test(out)
const green = (out, name) => new RegExp('^✅ ' + name + ' .*$', 'm').test(out)
const score = (out) => {
  const m = out.match(/通过 (\d+) \/ 失败 (\d+)/)
  return m ? `${m[1]} 通过 / ${m[2]} 失败` : '（读不到计分）'
}

/** 所有早退都走这里 —— 先还原、再退出，绝不裸调 process.exit。 */
let src0 = ''
let hash0 = ''
let result = 3
const notes = []

function restore() {
  try {
    writeFileSync(TARGET, src0, 'utf8')
  } catch (e) {
    notes.push('写回源码失败：' + String(e))
  }
  const ok = md5(TARGET) === hash0
  try {
    build()
  } catch {
    notes.push('还原后构建失败（源码已还原，产物可能是旧的）')
  }
  return ok
}

async function main() {
  src0 = readFileSync(TARGET, 'utf8')
  hash0 = md5(TARGET)

  say('══ 决定性变异：把命令面板选中的交易对写死成别的（M2）══')
  say('')

  if (!src0.includes(FROM)) {
    say('❌ 源码不是原始态（上一轮的变异可能还留着）：找不到 ' + FROM)
    say('   当前第 101 行附近：' + (src0.split('\n')[100] ?? '').trim())
    result = 3
    return
  }

  launchChrome()
  say('· ' + sh('node', ['scripts/_wait-cdp.mjs'], { env: { ...process.env, CDP_BASE } }).trim())

  // ── 基线：必须全绿，否则后面的红分不清是谁造成的
  const b = probe()
  say('· 基线 ' + score(b.out))
  if (b.code !== 0) {
    say(b.out.split('\n').slice(-14).join('\n'))
    say('❌ 基线就不绿 ⇒ 未验证（不是"没抓到"）')
    result = 3
    return
  }

  // ── 注入 + 重建
  writeFileSync(TARGET, src0.replace(FROM, TO), 'utf8')
  say('· 已注入 M2（pair: it.key → pair: "ETH-USDT"）')
  build()
  const distJs = bundleProbe('dist')
  say('· 已重建，dist → ' + distJs)

  const hasOld = bundleProbe('has', 'pair:e.key')
  const hasNew = bundleProbe('has', 'pair:`ETH-USDT`')
  say('· 产物自证：pair:e.key=' + hasOld + '  pair:`ETH-USDT`=' + hasNew)
  if (hasNew !== 'YES' || hasOld === 'YES') {
    say('❌ 变异没进产物 ⇒ 未验证（不是"没抓到"）')
    result = 3
    return
  }
  say('· ✓ 变异已进产物')

  const servedJs = bundleProbe('served')
  say('· 服务端在端 ' + servedJs + ' / dist 里 ' + distJs)
  if (servedJs !== distJs) {
    say('⚠️ 服务端端的不是变异后的产物 ⇒ 未验证（不是"没抓到"）')
    result = 3
    return
  }

  // ── 变异态
  const m = probe()
  say('· 变异态 ' + score(m.out))
  for (const l of m.out.split('\n').filter((x) => /^[✅❌] T3/.test(x) || /^[✅❌] T2/.test(x))) say('    ' + l)

  const c3c = red(m.out, 'T3c')
  const g3b = green(m.out, 'T3b')
  const g3 = green(m.out, 'T3')
  say('')
  if (c3c && g3b && g3) {
    say('✅ 抓住了：T3c 变红，而 T3 / T3b 仍绿。')
    say('   ⇒ T3c **只**由"屏幕上选中的交易对是不是用户点的那个"驱动，')
    say('     不会被"面板关了""页面跳过去了"顶替（判据 33/36）。')
    result = 0
  } else if (!c3c) {
    say('❌ 没抓住：变异后 T3c 仍是绿的 ⇒ 它守的不是那个验收点。')
    result = 1
  } else {
    say('⚠️ T3c 红了，但 T3/T3b 也红了 ⇒ 分不清是哪条断言在起作用。')
    result = 1
  }
}

main()
  .catch((e) => {
    say('❌ 脚本自身出错：' + (e instanceof Error ? e.message : String(e)))
    result = 3
  })
  .then(() => {
    // ★ 收口：还原 → 核对 → 才退出。不用 process.exit 早退（它会跳过 finally）。
    const ok = restore()
    say('')
    say(ok ? '✅ 源码已按 md5 核对还原' : '❌ 源码**没能**还原到原始字节 —— 请手动检查 ' + TARGET)
    for (const n of notes) say('   · ' + n)
    killChrome()
    process.exit(ok ? result : 1)
  })
