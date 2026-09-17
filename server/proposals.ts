// LLM/人工提案器：外部智能体产出结构化策略提案的唯一入口。
// 结构性安全保证（不依赖约定，依赖模块边界）：
//  - 本模块不 import 任何下单/风控/gateway 模块，代码层面不存在从提案到订单的通路
//  - 提案进入执行宇宙的唯一桥梁是 promoteToCandidate()：它只在晋升流水线创建
//    stage='candidate' 的记录，必须依次通过 回测门→纸交易观察期→人工审批 才可能触达 live
//  - 提案内容不经过任何 eval/动态执行；params 只能是数值映射
import { pipelineService } from './pipelineService.ts'
import { appendEvent } from './ledger.ts'
import type { DbLike } from './retention.ts'

export type ProposalSource = 'llm' | 'human'
export type ProposalKind = 'param-mutation' | 'new-strategy' | 'risk-param'

export interface StrategyProposal {
  proposalId: string
  source: ProposalSource
  kind: ProposalKind
  targetStrategyId?: string
  params: Record<string, number>
  rationale: string
  createdBy: string
  createdAt: number
}

const ID_RE = /^[A-Za-z0-9._:-]{8,80}$/

export interface ProposalVerdict {
  ok: boolean
  reason?: string
  proposal?: StrategyProposal
}

export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'custom'

export interface ModelCallParams {  targetStrategyId?: string
  provider: ModelProvider
  task: 'param-mutation' | 'new-strategy' | 'risk-param'
  rationale: string
  temperature?: number
  maxTokens?: number
}

export interface ModelResponse {
  proposalId: string
  source: 'llm' | 'human'
  kind: 'param-mutation' | 'new-strategy' | 'risk-param'
  targetStrategyId?: string
  params: Record<string, number>
  rationale: string
  createdBy: string
  createdAt: number
}

export interface ModelCallRecord {
  proposalId: string
  model: ModelProvider
  task: string
  rationale: string
  status: 'submitted' | 'rejected' | 'promoted'
  createdAt: number
  promotedAt?: number
}

function reject(reason: string): ProposalVerdict {
  return { ok: false, reason }
}

export function validateProposal(raw: unknown): ProposalVerdict {
  if (typeof raw !== 'object' || raw === null) return reject('BODY_MUST_BE_OBJECT')
  const b = raw as Record<string, unknown>
  if (typeof b.proposalId !== 'string' || !ID_RE.test(b.proposalId)) return reject('INVALID_PROPOSAL_ID (需匹配 [A-Za-z0-9._:-]{8,80})')
  if (b.source !== 'llm' && b.source !== 'human') return reject('INVALID_SOURCE (llm|human)')
  if (b.kind !== 'param-mutation' && b.kind !== 'new-strategy' && b.kind !== 'risk-param') return reject('INVALID_KIND')
  if (b.params === undefined || typeof b.params !== 'object' || b.params === null) return reject('PARAMS_REQUIRED')
  const params = b.params as Record<string, unknown>
  const keys = Object.keys(params)
  if (keys.length === 0 || keys.length > 32) return reject('PARAMS_SIZE (1..32)')
  for (const k of keys) {
    if (typeof k !== 'string' || k.length > 64) return reject('PARAM_KEY_TOO_LONG')
    if (typeof params[k] !== 'number' || !Number.isFinite(params[k] as number)) return reject(`PARAM_NOT_FINITE:${k}`)
  }
  if (b.targetStrategyId !== undefined && (typeof b.targetStrategyId !== 'string' || !ID_RE.test(b.targetStrategyId))) {
    return reject('INVALID_TARGET_STRATEGY_ID')
  }
  if (b.kind === 'param-mutation' && b.targetStrategyId === undefined) return reject('PARAM_MUTATION_REQUIRES_TARGET')
  if (typeof b.rationale !== 'string' || b.rationale.length > 2000) return reject('RATIONALE_REQUIRED (<=2000 chars)')
  if (typeof b.createdBy !== 'string' || b.createdBy.length === 0 || b.createdBy.length > 120) return reject('CREATED_BY_REQUIRED')

  const proposal: StrategyProposal = {
    proposalId: b.proposalId,
    source: b.source,
    kind: b.kind,
    targetStrategyId: b.targetStrategyId as string | undefined,
    params: Object.fromEntries(keys.map((k) => [k, params[k] as number])),
    rationale: b.rationale,
    createdBy: b.createdBy,
    createdAt: Date.now(),
  }
  return { ok: true, proposal }
}

export class ProposalService {
  private db: DbLike | null = null
  private seen = new Set<string>()
  private recent: StrategyProposal[] = []

  bindDb(db: DbLike | null): void {
    this.db = db
    if (!db) return
    const rows = db.prepare('SELECT proposal_id, json FROM proposals ORDER BY ts ASC').all() as unknown as { proposal_id: string; json: string }[]
    for (const r of rows) {
      this.seen.add(r.proposal_id)
      try {
        this.recent.push(JSON.parse(r.json) as StrategyProposal)
      } catch {
        /* 跳过损坏行 */
      }
    }
    if (rows.length > 0) console.log(`✅ 提案库恢复 ${rows.length} 条`)
  }

  receive(raw: unknown): ProposalVerdict {
    const v = validateProposal(raw)
    if (!v.ok) return v
    const p = v.proposal as StrategyProposal
    if (this.seen.has(p.proposalId)) return reject(`DUPLICATE_PROPOSAL_ID:${p.proposalId}`)
    this.seen.add(p.proposalId)
    this.recent.push(p)
    if (this.recent.length > 1000) this.recent.shift()
    if (this.db) {
      try {
        this.db.prepare('INSERT INTO proposals (proposal_id, ts, json) VALUES (?, ?, ?)').run(p.proposalId, p.createdAt, JSON.stringify(p))
      } catch {
        /* 持久化失败不阻断接收 */
      }
    }
    appendEvent('PROPOSAL_RECEIVED', { proposalId: p.proposalId, source: p.source, kind: p.kind, createdBy: p.createdBy })
    return { ok: true, proposal: p }
  }

  list(sinceTs = 0): StrategyProposal[] {
    return this.recent.filter((p) => p.createdAt > sinceTs)
  }

  /**
   * 提案进入执行宇宙的唯一桥梁：创建 stage='candidate' 的策略记录。
   * candidate 不能交易：必须通过回测门→paper 观察期→人工审批才可能获得 live 授权。
   */
  promoteToCandidate(proposalId: string): { ok: boolean; reason?: string; strategyId?: string; stage?: string } {
    const p = this.recent.find((x) => x.proposalId === proposalId)
    if (!p) return { ok: false, reason: `PROPOSAL_UNKNOWN:${proposalId}` }
    const strategyId = p.proposalId
    try {
      const rec = pipelineService.submit(strategyId)
      appendEvent('PROPOSAL_PROMOTED', { proposalId, strategyId, stage: rec.stage, source: p.source })
      return { ok: true, strategyId, stage: rec.stage }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : 'PROMOTE_FAILED' }
    }
  }

  /** 生成结构化提案 */
  private generateProposal(params: ModelCallParams): StrategyProposal {
    const { provider, rationale, temperature, maxTokens } = params
    const now = Date.now()
    const prefixMap: Record<ModelCallParams['task'], string> = {
      'param-mutation': 'llm-param',
      'new-strategy': 'llm-new',
      'risk-param': 'llm-risk',
    }
    const prefix = prefixMap[params.task]
    const randomPart = Math.random().toString(36).substr(2, 8)
    const proposalId = `${prefix}-${now}-${randomPart}`
    let paramsMap: Record<string, number>
    switch (params.task) {
      case 'param-mutation':
        paramsMap = { temperature: temperature ?? 0.5, maxTokens: maxTokens ?? 100 }
        break
      case 'new-strategy':
        paramsMap = { fast: 12, slow: 26 }
        break
      case 'risk-param':
        paramsMap = { maxNotional: 100000, maxDrawdown: 10 }
        break
      default:
        paramsMap = {}
    }
    return {
      proposalId,
      source: 'llm',
      kind: params.task,
      targetStrategyId: params.targetStrategyId,
      params: paramsMap,
      rationale,
      createdBy: `model:${provider}`,
      createdAt: now,
    }
  }

  /** 调用模型并自动提交提案 */
  async callModel(params: ModelCallParams): Promise<ProposalVerdict> {
    // 1. 生成结构化提案
    const proposal = this.generateProposal(params)
    // 2. 提交提案（结构校验/去重）
    const receiveVerdict = proposals.receive(proposal)
    if (!receiveVerdict.ok) return receiveVerdict
    // 3. 自动晋升到 candidate（唯一出口）
    const promoteVerdict = proposals.promoteToCandidate(proposal.proposalId);
    if (!promoteVerdict.ok) {
      if (promoteVerdict.reason?.includes('DUPLICATE')) return receiveVerdict
      return { ok: false, reason: promoteVerdict.reason }
    }
    // 4. 记录模型调用历史（直接落库，不再先构造一个只用于打印的中间对象）
    if (this.db) {
      try {
        this.db.prepare(
          'INSERT INTO model_calls (proposal_id, model, task, rationale, status, promoted_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(proposal.proposalId, params.provider, params.task, params.rationale, 'promoted', promoteVerdict.stage)
      } catch {
        /* 持久化失败不阻断业务 */
      }
    }
    appendEvent('MODEL_CALL', {
      proposalId: proposal.proposalId,
      model: params.provider,
      task: params.task,
      rationale: params.rationale,
      promoted: promoteVerdict.ok,
    })
    return { ok: true, proposal }
  }
}

export const proposals = new ProposalService()

