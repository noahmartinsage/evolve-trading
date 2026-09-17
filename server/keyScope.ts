/**
 * 密钥权限自检（Read ✓ / Trade ✓ / Withdraw ✗）
 *
 * ── 来源 ──────────────────────────────────────────────────────────────
 * 2026-09-16 日报第 3 条：`skylar93/trading_bot` 的 operator 安全网里有一条
 * **API key scope 探测**，期望形态明确写成 Read ✓ / Trade ✓ / Withdraw ✗。
 *
 * ── 为什么值得内化（这是本模块存在的全部理由）────────────────────────
 * 本系统已经有整套"能下多大单"的闸门：1R 定规模、资金帽、宪法红线、对手方三档。
 * 但**没有任何一处检查过"这把钥匙本来能干什么"**。
 *
 * 而"能提币"与"能下单"是两件性质不同的事：
 * 金额型闸门限制的是**这一笔**多大；提币权限决定的是**所有闸门的上限还算不算数**。
 * 一把带 Withdraw 的 key 一旦落进 `.env`，前面所有金额约束都只是"系统自己愿意遵守"。
 *
 * ── 判据只有一条 ─────────────────────────────────────────────────────
 * **权限范围必须被显式确认过。**
 * 所以「接口没返回 canWithdraw 字段」**不等于**「没有提币权限」——
 * 前者是"没看到"，后者是"看到了且为否"。这两件事在这里必须给出不同结论：
 *   看到且为否 → ok
 *   看到且为是 → danger（P0）
 *   **没看到**   → unverifiable（P1，不放行）
 * 这与 `claimValidator` 的三态、与过拟合门的 fail-closed 是同一条规矩：
 * **缺证据 ≠ 无风险**。
 *
 * ── 入参里没有结论字段 ───────────────────────────────────────────────
 * `classifyKeyScope(venue, raw)` 只吃**可观测量**（交易所原样返回的 JSON）。
 * 调用方无从自报"我的 key 很安全"—— 那种字段一旦存在，伪造它就能把
 * "不过"变成"通过"，门也就不是门了（本项目已复现 6 次的 P0 形态）。
 */

export type KeyScopeStatus = 'ok' | 'danger' | 'unverifiable'

export interface KeyScopeVerdict {
  venue: string
  status: KeyScopeStatus
  /** 能不能读账户。能拿到账号信息本身就是有读权限的证据。 */
  read: boolean
  trade: boolean
  withdraw: boolean
  /**
   * 应当按哪一级报警处理。
   * danger → P0（不参与任何压制）；unverifiable → P1。
   * 两者都不会退化成 none —— 否则"没查到"会被静默吞掉。
   */
  severity: 'none' | 'P0' | 'P1'
  /**
   * 给人听的一句话。
   *
   * ★ 必须是**显式格式化**的字符串：它会被 narrator 播报，
   *   而 `String(对象)` 会念出 `[object Object]`（语音层 S12 的全局扫描项）。
   */
  summary: string
  reasons: string[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** 只在字段**确实是布尔值**时取值；缺失/字符串/数字一律返回 null（= 没看到）。 */
function boolOf(o: Record<string, unknown>, key: string): boolean | null {
  const v = o[key]
  return typeof v === 'boolean' ? v : null
}

function venueFamily(venue: string): 'binance' | 'okx' | 'unknown' {
  const v = venue.toLowerCase()
  if (v.includes('binance')) return 'binance'
  if (v.includes('okx')) return 'okx'
  return 'unknown'
}

/** 统一成一句人话，避免每个分支各写一遍格式。 */
function sentence(
  venue: string,
  status: KeyScopeStatus,
  read: boolean,
  trade: boolean,
  withdraw: boolean,
): string {
  const mark = (b: boolean): string => (b ? '有' : '无')
  const head = status === 'danger' ? '密钥权限越界' : status === 'unverifiable' ? '密钥权限未确认' : '密钥权限正常'
  return `${head}（${venue}）：读 ${mark(read)} · 交易 ${mark(trade)} · 提币 ${mark(withdraw)}`
}

/**
 * 判定一把密钥的权限范围。
 *
 * @param venue 交易所标识（`binance-testnet` / `okx-testnet` / …），只用于选解析器
 * @param raw   交易所账号接口的**原样返回**。调用方不得预先加工成结论。
 */
export function classifyKeyScope(venue: string, raw: unknown): KeyScopeVerdict {
  const family = venueFamily(venue)
  const o = asRecord(raw)

  if (family === 'unknown') {
    return {
      venue, status: 'unverifiable', read: false, trade: false, withdraw: false,
      severity: 'P1',
      summary: sentence(venue, 'unverifiable', false, false, false),
      // 不认识就说不认识 —— 认不得的返回格式里可能正好藏着 Withdraw ✓
      reasons: [`不认识 ${venue} 的账号接口返回格式，无从判定权限范围`],
    }
  }

  if (!o) {
    return {
      venue, status: 'unverifiable', read: false, trade: false, withdraw: false,
      severity: 'P1',
      summary: sentence(venue, 'unverifiable', false, false, false),
      reasons: ['账号接口没有返回可解析的对象（网络失败 / 鉴权被拒 / 空响应）'],
    }
  }

  if (family === 'binance') {
    const trade = boolOf(o, 'canTrade')
    const withdraw = boolOf(o, 'canWithdraw')
    const perms = Array.isArray(o.permissions) ? o.permissions.map((p) => String(p)) : []

    // 能读到 account 就是有读权限 —— 这不是推断，是刚才发生的事
    const read = true

    if (withdraw === true) {
      return {
        venue, status: 'danger', read, trade: trade === true, withdraw: true,
        severity: 'P0',
        summary: sentence(venue, 'danger', read, trade === true, true),
        reasons: [
          'canWithdraw=true —— 这把钥匙能提走资金，所有金额型闸门的实际上限不再由本系统决定',
          '处置：在交易所后台把该 key 的提币权限关掉，然后重新签发',
        ],
      }
    }
    if (withdraw === null || trade === null) {
      return {
        venue, status: 'unverifiable', read, trade: trade === true, withdraw: false,
        severity: 'P1',
        summary: sentence(venue, 'unverifiable', read, trade === true, false),
        reasons: [
          `账号返回里缺少 ${withdraw === null ? 'canWithdraw' : 'canTrade'} 字段（已见字段：${Object.keys(o).join('、') || '无'}）`,
          '缺失 ≠ 为否：没看到不等于没有，按未确认处理',
        ],
      }
    }
    return {
      venue, status: 'ok', read, trade, withdraw: false,
      severity: 'none',
      summary: sentence(venue, 'ok', read, trade, false),
      reasons: [`canWithdraw=false · canTrade=${trade} · 权限列表 ${perms.join('、') || '（未提供）'}`],
    }
  }

  // ── OKX：单一 `perm` 字段，取值形如 `read_only` / `read_only,trade` / `withdraw` ──
  const permRaw = o.perm
  if (typeof permRaw !== 'string' || permRaw.trim() === '') {
    return {
      venue, status: 'unverifiable', read: false, trade: false, withdraw: false,
      severity: 'P1',
      summary: sentence(venue, 'unverifiable', false, false, false),
      reasons: [
        typeof permRaw === 'string' ? '权限字段 perm 为空字符串' : '账号返回里缺少权限字段 perm',
        '缺失 ≠ 为否：没看到不等于没有，按未确认处理',
      ],
    }
  }

  const tokens = permRaw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  const trade = tokens.includes('trade')
  const withdraw = tokens.includes('withdraw')
  // 读到 account/config 即证明有读能力；perm 里也通常显式带 read_only
  const read = true

  if (withdraw) {
    return {
      venue, status: 'danger', read, trade, withdraw: true,
      severity: 'P0',
      summary: sentence(venue, 'danger', read, trade, true),
      reasons: [
        `perm=${permRaw} 含提币权限 —— 所有金额型闸门的实际上限不再由本系统决定`,
        '处置：在交易所后台把该 key 的提币权限关掉，然后重新签发',
      ],
    }
  }
  if (tokens.length === 0) {
    return {
      venue, status: 'unverifiable', read, trade, withdraw: false,
      severity: 'P1',
      summary: sentence(venue, 'unverifiable', read, false, false),
      reasons: [`perm 字段存在但解析不出任何权限标记（原值 ${permRaw}）`],
    }
  }
  return {
    venue, status: 'ok', read, trade, withdraw: false,
    severity: 'none',
    summary: sentence(venue, 'ok', read, trade, false),
    reasons: [`perm=${permRaw}`],
  }
}

export interface KeyScopeAudit {
  /** 最坏的一条决定整体结论：danger > unverifiable > ok */
  status: KeyScopeStatus
  verdicts: KeyScopeVerdict[]
  /** 0 = 全部确认安全；1 = 存在未确认；2 = 存在越界（提币权限） */
  exitCode: number
  /** 给操作员看的一行总结 */
  summary: string
}

/**
 * 聚合多把密钥的结论。
 *
 * **空集合返回 unverifiable 而不是 ok**：一把都没审过，不能得出"安全"。
 * 这是本模块唯一容易写反的地方 —— 而写反之后它照样返回 0，看起来一切正常。
 */
export function summarizeAudit(verdicts: KeyScopeVerdict[]): KeyScopeAudit {
  if (verdicts.length === 0) {
    return {
      status: 'unverifiable',
      verdicts,
      exitCode: 1,
      summary: '没有任何已配置的交易所密钥可供自检 —— 未审过不等于安全',
    }
  }
  const danger = verdicts.filter((v) => v.status === 'danger')
  const unknown = verdicts.filter((v) => v.status === 'unverifiable')
  if (danger.length > 0) {
    return {
      status: 'danger',
      verdicts,
      exitCode: 2,
      summary: `${danger.length} 把密钥带提币权限：${danger.map((d) => d.venue).join('、')} —— 先去交易所关掉它`,
    }
  }
  if (unknown.length > 0) {
    return {
      status: 'unverifiable',
      verdicts,
      exitCode: 1,
      summary: `${unknown.length}/${verdicts.length} 把密钥权限未能确认：${unknown.map((d) => d.venue).join('、')}`,
    }
  }
  return { status: 'ok', verdicts, exitCode: 0, summary: `${verdicts.length} 把密钥全部为「读 + 交易、无提币」` }
}
