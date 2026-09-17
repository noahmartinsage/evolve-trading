// 把编排器原始事件翻译成一句人话：说明「因为什么，所以做了什么」。
//
// 设计原则：
// 1. 只使用 payload 中真实存在的字段，**不编造任何数值**。
// 2. 拒绝/拦截类事件必须说清「卡在哪、怎么解」，不能只抛错误码。
// 3. 字段缺失时降级为通用描述，而不是留空或瞎猜。

const s = (v: unknown): string => (v == null ? '' : String(v))

const SIDE_CN: Record<string, string> = { buy: '买入', sell: '卖出' }
const sideCn = (v: unknown): string => SIDE_CN[s(v)] ?? s(v)

/** 风控 / 门控拒绝码 → 人话（含可操作建议） */
function reasonToText(reason: string): string {
  const r = (reason ?? '').trim()

  const notional = r.match(/NOTIONAL_EXCEEDS_LIMIT\s*\(?\s*([\d.]+)\s*>\s*([\d.]+)\s*\)?/i)
  if (notional) {
    return `委托名义金额 ${notional[1]} 超过单笔上限 ${notional[2]}，被风控拦截（持仓过大：可提高上限或分批平仓）`
  }

  const dev = r.match(/PRICE_DEVIATION_TOO_WIDE\s*\(?\s*(\d+)\s*bps\s*\)?/i)
  if (dev) return `报价偏离基准 ${dev[1]} bps，超出允许偏差，被风控拦截`

  const rate = r.match(/MAX_ORDERS_PER_MINUTE|RATE_LIMIT/i)
  if (rate) return `下单频率超过每分钟上限，被限流（等待窗口重置后重试）`

  const dd = r.match(/MAX_DRAWDOWN|DRAWDOWN_LIMIT/i)
  if (dd) return `已触及最大回撤阈值，拒绝新增仓位`

  if (/KILLSWITCH/i.test(r)) return `紧急开关已激活，拒绝一切出向委托`

  const notionalOnly = r.match(/([\d.]+)\s*>\s*([\d.]+)/)
  if (notionalOnly && /EXCEED|LIMIT/i.test(r)) {
    return `数值 ${notionalOnly[1]} 超过上限 ${notionalOnly[2]}，被门控拦截`
  }

  return r || '被风控拒绝（未提供具体原因）'
}

/** 事件 → 一句话决策理由 */
export function explainDecision(kind: string, payload: Record<string, unknown>): string {
  const reason = s(payload.reason)

  switch (kind) {
    case 'PROPOSAL_RECEIVED': {
      const src = s(payload.createdBy) || s(payload.source) || '未知来源'
      const k = s(payload.kind)
      const isLlm = /llm|gpt|claude|deepseek|qwen|gemini|grok/i.test(src)
      return `收到新候选提案${k ? `（${k}）` : ''}，来源 ${src}${isLlm ? '（模型生成）' : '（确定性引擎）'}，待回测门评估`
    }

    case 'STRATEGY_SUBMITTED':
      return `策略 ${s(payload.strategyId) || '—'} 进入候选池，开始回测与晋升评估`

    case 'AUTOPILOT_STARTED':
      return `自主交易启动：按周期累积 K 线 → 寻优选策略 → 执行下单`

    case 'AUTOPILOT_STOPPED':
      return `自主交易已停止，不再产生新的委托`

    case 'AUTOPILOT_STRATEGY_SELECTED': {
      const id = s(payload.strategyId) || s(payload.winner)
      return id
        ? `本轮寻优结束：候选池中 ${id} 的适应度最高，选为执行策略`
        : `本轮寻优结束，已选定执行策略`
    }

    case 'PROMOTION_STAGE': {
      const from = s(payload.from)
      const to = s(payload.to)
      const why = reason ? `，原因：${reason}` : ''
      return `策略晋升 ${from || '?'} → ${to || '?'}${why}`
    }

    case 'ORDER_SUBMIT': {
      const side = sideCn(payload.side)
      const sym = s(payload.symbol)
      const qty = s(payload.qty)
      return `策略发出信号，提交${side}委托${sym ? ` ${sym}` : ''}${qty ? ` ${qty}` : ''}`
    }

    case 'AUTOPILOT_ORDER_PLACED': {
      const side = sideCn(payload.side)
      return `已向场所下达${side}委托，等待场所确认`
    }

    case 'ORDER_ACK':
      return `场所已确认接收委托（${s(payload.clientOrderId) || '—'}）`

    case 'ORDER_FILL':
      return `委托成交，已计入服务端账本`

    case 'ORDER_REJECT':
      return reasonToText(reason)

    case 'AUTOPILOT_ORDER_REJECTED': {
      const side = sideCn(payload.side)
      return `策略想${side || '下'}单，但${reasonToText(reason)}`
    }

    case 'RISK_CIRCUIT_BREAK':
      return `风控熔断触发，暂停交易：${reason || '触及风险阈值'}`

    case 'KILLSWITCH_OFF':
      return `紧急开关已解除，恢复出向交易`

    default:
      return (
        reason ||
        Object.entries(payload)
          .slice(0, 2)
          .map(([k, v]) => `${k}=${String(v).slice(0, 28)}`)
          .join(' · ')
      )
  }
}
