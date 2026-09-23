/**
 * 厂商体检并重设 —— 「先保留、重新设置；真不能用就停用它」这句话的可执行版本。
 *
 * ── 它解决的是什么 ────────────────────────────────────────────────────
 * 一个厂商在册、`enabled=1`、`last_status` 还挺好看，但一句话也回不来。
 * 这时候该做的是**换名字**还是**停用它**？两者的观察面是一样的
 * （"没有任何输出"），动作却相反。所以这个脚本做三件事：
 *
 *   ① 真调一次（每一个候选名字都调，`/models` 里列着不算数）；
 *   ② 把观测交给 `providerHealth.decideProvider()` 判 —— 换名字 / 停用 / 保留；
 *   ③ `--apply` 时**只改该改的那一个字段**，并把结论写进 `last_status`
 *      带上日期，任何人（包括明天的自己）都能核对"当时为什么关的"。
 *
 * ── `--paid` 是干什么的 ──────────────────────────────────────────────
 * 实测 `Opencode-zen-ray` 的 7 个免费档全是
 * `403 FreeTierError: free tier can only be used from within OpenCode`。
 * 只看免费档，你分不清这两种事：
 *
 *   (甲) 免费档被**政策**堵死，付费档其实是好的 ⇒ 该提示"去充值"
 *   (乙) 整家对你都不可用 ⇒ 该停用
 *
 * 两者在"免费档全灭"这个观察面上逐字节相同（判据 24）。所以体检默认
 * **额外试几个付费名字**（`--paid`，默认 2 个），把甲和乙分开。
 * 试付费名字只会拿到 `402 余额不足` 之类的拒绝，不会真的产生费用 ——
 * 这一点是判据的前提，所以写在代码里而不是脑子里。
 *
 * 用法：
 *   node scripts/provider-reset.ts                          # 体检当前在册的第一个可用厂商，只看不改
 *   node scripts/provider-reset.ts --provider Opencode-zen-ray
 *   node scripts/provider-reset.ts --provider Opencode-zen-ray --apply
 *   node scripts/provider-reset.ts --provider AMD-noah --paid 0
 *   node scripts/provider-reset.ts --provider OpenRouter --apply --no-switch
 *       # 只摘掉"名字已下线"的名单项，不动 active_model（换模型是另一件事）
 *
 * ★ 刻意不进 CI：它联网、且会消耗真实额度（与 llm:probe / factors:run 同类）。
 *   判决逻辑本身有门禁（`test:provider`），不需要靠这个脚本被覆盖。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { decideProvider, renderVerdict, disableStatus, classifyProbe, pruneDeadModels, type ProbeSample } from '../server/providerHealth.ts'
import { orderCandidates, probeModels, looksFree, type ProbeTarget } from '../server/providerProbe.ts'

interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_key: string
  flavor: string
  models_json: string
  active_model: string | null
  enabled: number
  last_status: string | null
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  return null
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function loadRows(): { db: DatabaseSync; rows: ProviderRow[] } {
  const dbPath = process.env.EV_DB ?? 'data/orch.db'
  if (!existsSync(dbPath)) {
    console.log(`找不到库 ${dbPath} —— 编排服务还没起过？`)
    process.exit(1)
  }
  const db = new DatabaseSync(dbPath, { readOnly: !hasFlag('--apply') })
  const rows = db.prepare('SELECT * FROM llm_providers ORDER BY created_ts').all() as unknown as ProviderRow[]
  return { db, rows }
}

function pick(rows: ProviderRow[], wanted: string | null): ProviderRow | null {
  if (wanted) {
    return rows.find((r) => r.id === wanted || r.name === wanted) ?? null
  }
  return rows.find((r) => Number(r.enabled) === 1 && !!r.active_model) ?? rows[0] ?? null
}

async function main(): Promise<void> {
  const { db, rows } = loadRows()
  const wanted = argValue('--provider')
  const p = pick(rows, wanted)
  if (!p) {
    console.log(
      wanted
        ? `库里没有叫 ${wanted} 的厂商。现有的：${rows.map((r) => r.name).join(' · ')}`
        : '库里一个厂商都没有。',
    )
    process.exit(1)
  }

  const all = JSON.parse(p.models_json || '[]') as string[]
  const limit = Number(argValue('--limit') ?? process.env.EV_PROBE_LIMIT ?? '10')
  const paidCount = Number(argValue('--paid') ?? '2')
  // 付费名字取"名字最靠前的几个非免费项"：它们通常是厂商主推的档位，
  // 比随机挑一个更能代表"这家你到底付不付得起"。
  const paid = all.filter((m) => !looksFree(m)).slice(0, Math.max(0, paidCount))
  const candidates = orderCandidates(all, p.active_model, paid).slice(0, limit + paid.length)

  const target: ProbeTarget = {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    apiKey: p.api_key,
    flavor: p.flavor,
    model: p.active_model ?? '',
  }

  console.log(`厂商 ${p.name}（id ${p.id}）`)
  console.log(`  ${p.base_url} · 名单 ${all.length} 个 · 在用 ${p.active_model ?? '（无）'} · enabled=${p.enabled}`)
  console.log(`  上次结论 ${(p.last_status ?? '（无）').slice(0, 130)}`)
  console.log(`  本次要试 ${candidates.length} 个${paid.length > 0 ? `（含 ${paid.length} 个付费档，只用来分辨原因，不产生费用）` : ''}`)
  console.log('')

  const samples: ProbeSample[] = await probeModels(target, candidates)
  for (const s of samples) {
    const c = classifyProbe(s)
    const mark = c === 'ok' ? '✅' : '❌'
    const tail = s.responded ? `HTTP ${s.status} ${(s.body ?? '').slice(0, 90)}` : `没通 ${s.netError ?? ''}`
    console.log(`  ${mark} ${s.model.padEnd(38)} ${String(s.ms).padStart(6)}ms  [${c}] ${tail}`)
  }
  console.log('')

  const verdict = decideProvider(p.name, samples)
  for (const line of renderVerdict(p.name, verdict)) console.log(line)
  console.log('')

  const day = new Date().toISOString().slice(0, 10)

  // ── 名字级修剪（判据在 `pruneDeadModels`，这里只负责说清要做什么/做了什么）──
  // ★ 它必须**独立于判决**执行：`decideProvider` 的结论是"这个账号该怎么办"，
  //   而修剪回答的是"名单里哪几个名字已被证伪"。两者可以同时成立 ——
  //   实测里就有"换成另一个名字（判决）"与"把死名摘掉（修剪）"同时发生的情形。
  const pruned = pruneDeadModels(all, samples)
  const pruneSpeech = pruned.emptied
    ? '名单里试到的名字全是已下线的。我没有把名单摘空 —— 摘空等于让这个账号失去全部候选，该做的是重新拉一次 /models'
    : pruned.removed.length > 0
      ? `摘掉 ${pruned.removed.length} 个已下线的名字：${pruned.removed.slice(0, 5).join('、')}${pruned.removed.length > 5 ? ' 等' : ''}`
      : ''
  if (pruneSpeech) {
    console.log('名字级修剪')
    console.log(`  ${pruneSpeech}`)
    console.log('')
  }

  if (!hasFlag('--apply')) {
    console.log('（只看不改。要落地请加 --apply）')
    if (verdict.kind === 'switch-model') {
      console.log(
        hasFlag('--no-switch')
          ? `   会做：不动在用模型（--no-switch；判决本来建议换成 ${verdict.model}）`
          : `   会做：把在用模型改成 ${verdict.model}，enabled 保持 1`,
      )
    }
    if (verdict.kind === 'disable') console.log('   会做：enabled 改成 0，并在 last_status 写下日期与原因（记录保留，随时能再打开）')
    if (verdict.kind === 'keep') console.log('   会做：不动 enabled、不动 active_model，只把本次结论写进 last_status')
    if (pruned.removed.length > 0) console.log(`   会做：把名单从 ${all.length} 个收成 ${pruned.kept.length} 个`)
    return
  }

  /**
   * 落盘修剪。
   *
   * ★ **一次都不摘也要说** —— 静默不动与"摘了但没变化"在输出上一样，
   *   而人核对时要知道"这一步跑过了、结论是不用摘"。
   */
  const applyPrune = (): void => {
    if (pruned.emptied) {
      console.log('名单：没动（全下线时摘空会让账号失去全部候选）')
      return
    }
    if (pruned.removed.length === 0) {
      console.log('名单：没动（没有已下线的名字）')
      return
    }
    db.prepare('UPDATE llm_providers SET models_json = ? WHERE id = ?').run(JSON.stringify(pruned.kept), p.id)
    console.log(`名单：${all.length} → ${pruned.kept.length} 个（摘掉 ${pruned.removed.length} 个已下线的名字）`)
  }

  // 判决写的那句话与修剪写的那句话合成一条 `last_status`：
  // 分成两次 UPDATE 的话，后写的那次会把前一次覆盖掉，而两件事都要留痕。
  const tail = pruneSpeech ? ` · ${pruneSpeech}` : ''

  /**
   * `--no-switch`：只落地修剪，**不动 `active_model`**。
   *
   * ── 为什么需要它 ──────────────────────────────────────────────────────
   * 「把名单里已下线的名字摘掉」与「改用另一个模型」是**两件不同的事**，
   * 当前者已经确定、后者还需要人拍板时，混在一起执行会逼出一个坏选择：
   * 要么接受一次不想要的模型切换，要么连修剪也一并放弃。
   * 实测（2026-09-23）：OpenRouter 的在用模型是 `inclusionai/ling-3.0-flash-vl:free`
   * （一个**视觉**档），而判决会把它换成纯文本档 —— 对"识别截图"这类用途
   * 那是另一件事，不该由"摘一个死名字"顺手决定。
   *
   * ★ 它**不是**第二条路径：判据仍然只有 `pruneDeadModels` 一份，
   *   这个开关只决定"要不要写 `active_model` 这个字段"。
   */
  const noSwitch = hasFlag('--no-switch')

  if (verdict.kind === 'switch-model' && verdict.model) {
    if (noSwitch) {
      const stmt = db.prepare('UPDATE llm_providers SET last_status = ? WHERE id = ?')
      stmt.run(`KEEP(${day}) · --no-switch：没有改用在用模型（判决本来建议换成 ${verdict.model}） · ${verdict.speech}${tail}`, p.id)
      console.log(`已写入：只更新了 last_status（--no-switch：active_model 仍是 ${p.active_model ?? '（无）'}）`)
    } else {
      const stmt = db.prepare('UPDATE llm_providers SET active_model = ?, enabled = 1, last_status = ? WHERE id = ?')
      stmt.run(verdict.model, `RESET(${day}) · 换到 ${verdict.model} · ${verdict.speech}${tail}`, p.id)
      console.log(`已写入：active_model = ${verdict.model}，enabled = 1`)
    }
  } else if (verdict.kind === 'disable') {
    const stmt = db.prepare('UPDATE llm_providers SET enabled = 0, last_status = ? WHERE id = ?')
    stmt.run(`${disableStatus(verdict, day)}${tail}`, p.id)
    console.log('已写入：enabled = 0（记录与原因保留，随时可以把 enabled 改回 1）')
  } else {
    const stmt = db.prepare('UPDATE llm_providers SET last_status = ? WHERE id = ?')
    stmt.run(`KEEP(${day}) · ${verdict.speech}${tail}`, p.id)
    console.log('已写入：只更新了 last_status，enabled 与 active_model 都没动')
  }
  applyPrune()
  console.log('')
  console.log('★ 改了厂商注册表要重启编排服务才会生效：npm run app:stop 然后 双击 START-EVOLVE.cmd')
}

void main().catch((e) => {
  console.log(JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) }, null, 2))
  process.exit(1)
})
