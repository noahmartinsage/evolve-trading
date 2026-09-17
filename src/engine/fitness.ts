export const FITNESS_VERSION = 'fitness-v2'

/**
 * 适应度定义域 —— **唯一出处**。
 *
 * 这里必须是常量而不是散落的字面量：`backtest:golden` 的越界守卫一度自己
 * 写死了上界 120，而函数里的 clamp 上界是 200。两处各写一份的结果是
 * 守卫长期红灯，而红灯指向的是「策略有问题」——真因却只是两个数字不一致。
 *
 * 这正是本项目反复栽跟头的那类缺陷：**同一事实存了两份，然后悄悄漂移**。
 * 所以定义域从这里导出，clamp 与所有守卫（golden / 烟测）共用一份。
 */
export const FITNESS_DOMAIN = { min: -100, max: 200 } as const

export interface FitnessInput {
  annReturnPct: number
  maxDrawdownPct: number
  tradesPerDay: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * 适应度函数本体。
 *
 * 命名与 `FITNESS_VERSION`（fitness-v2）对齐。此前函数名还叫 `fitnessV1`，
 * 而返回的 version 是 v2 —— 下一个读代码的人会以为跑的还是 v1。
 */
export function fitnessV2(input: FitnessInput): number {
  if (!Number.isFinite(input.annReturnPct)) return FITNESS_DOMAIN.min
  const ddAbs = Math.max(Math.abs(Number.isFinite(input.maxDrawdownPct) ? input.maxDrawdownPct : 100), 5)
  const calmarAdj = input.annReturnPct / ddAbs
  // 降低换手惩罚，让更高换手（更多复利机会）的策略也能胜出
  const churnPenalty = 0.05 * Math.sqrt(Math.max(0, input.tradesPerDay))
  if (calmarAdj <= 0) return clamp(calmarAdj - churnPenalty, FITNESS_DOMAIN.min, 0)
  const compressed = 25 * Math.log1p(calmarAdj)
  return clamp(compressed - churnPenalty, FITNESS_DOMAIN.min, FITNESS_DOMAIN.max)
}

export function computeFitness(input: FitnessInput): { version: string; value: number } {
  return { version: FITNESS_VERSION, value: fitnessV2(input) }
}
