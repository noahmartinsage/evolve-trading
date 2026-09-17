export type { Candle, OrderSide, OrderType, OrderStatus, Order, Fill, ExecConfig } from './types.ts'
export { DEFAULT_EXEC } from './types.ts'
export { mulberry32, makeRng } from './rng.ts'
export type { Rng } from './rng.ts'
export { genSynthCandles, GOLDEN_DATA_SPEC, SYNTH_DATA_VERSION } from './data.ts'
export { sma, rsi } from './indicators.ts'
export { MatchingEngine } from './matching.ts'
export { runBacktest, ENGINE_VERSION } from './backtest.ts'
export type { BacktestResult, BacktestMeta, EquityPoint } from './backtest.ts'
export { computeReport } from './report.ts'
export type { Report } from './report.ts'
export { computeFitness, fitnessV2, FITNESS_VERSION, FITNESS_DOMAIN } from './fitness.ts'
export {
  maCrossStrategy,
  rsiReversionStrategy,
  breakoutStrategy,
  bollingerReversionStrategy,
  macdTrendStrategy,
  emaRsiComboStrategy,
  evaluateCandidateGrid,
  evaluateStrategy,
  buildCandidateSet,
  DEFAULT_GRID_EXEC,
} from './strategies.ts'
export type { Strategy, StrategyContext, StrategyDecision, CandidateResult } from './strategies.ts'
export {
  HISTORY_FORMAT_VERSION,
  intervalToMinutes,
  detectGaps,
  contentHash,
  buildHistory,
  validateHistory,
} from './history.ts'
export type { HistoryMeta, HistoryFile, HistoryGap } from './history.ts'
export { walkForward, combinationPurity, computeOverfitReceipt } from './walkforward.ts'
export type { WFConfig, WFFold, WFAggregate, WFResult, WFOptions, PurityResult } from './walkforward.ts'
export {
  OVERFIT_VERSION,
  DEFAULT_OVERFIT_THRESHOLDS,
  pboCscv,
  rankOf,
  buildOverfitReceipt,
  verifyOverfitReceipt,
  judgeOverfit,
} from './overfit.ts'
export type {
  PboResult,
  RankResult,
  OverfitSummary,
  OverfitThresholds,
  OverfitReceipt,
  OverfitOutcome,
  OverfitVerdict,
} from './overfit.ts'
export {
  CVAR_DEFAULT_ALPHA,
  worstTailMean,
  cvarLossPct,
  worstSingleLossPct,
  maxDrawdownFromReturns,
  tailRiskSummary,
} from './riskMetrics.ts'
export type { TailRiskSummary } from './riskMetrics.ts'
export { PaperBroker } from './broker.ts'
export type { BrokerClient, OrderRequest, SubmitResult } from './broker.ts'
export {
  PromotionPipeline,
  DEFAULT_PIPELINE_CONFIG,
  PROMOTION_PIPELINE_VERSION,
} from './promotion.ts'
export type {
  Stage,
  FitnessStamp,
  PaperStats,
  TransitionRecord,
  StrategyRecord,
  PipelineConfig,
  BacktestGateInput,
  OverfitStamp,
} from './promotion.ts'
