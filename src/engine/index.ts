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
export {
  walkForward,
  combinationPurity,
  computeOverfitReceipt,
  wfWidthFor,
  OVERFIT_CALIBRATION_FOLDS,
  WF_MIN_TRAIN_BARS,
  WF_MIN_TEST_BARS,
} from './walkforward.ts'
export type { WFConfig, WFFold, WFAggregate, WFResult, WFOptions, PurityResult, WfWidth } from './walkforward.ts'
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
  FACTOR_BASES,
  FACTOR_TRANSFORMS,
  DEFAULT_FACTOR_GATE,
  DEFAULT_HORIZONS,
  DEFAULT_WINDOWS,
  FACTOR_MIN_WINDOW,
  minWindowFor,
  SPEARMAN_MIN_PAIRS,
  rankCorr,
  factorSeries,
  factorLooksAhead,
  looksAhead,
  spearman,
  computeFactorMetrics,
  judgeFactor,
  generateFactorBatch,
  evaluateFactorBatch,
  slugFor,
} from './factorEval.ts'
export type {
  FactorOrigin,
  FactorSpec,
  FactorMetrics,
  FactorVerdict,
  FactorVerdictState,
  FactorGateThresholds,
  FactorGateInput,
  LookaheadVerdict,
  EvalOptions,
  BatchEntry,
  BatchResult,
  FactorBaseDef,
} from './factorEval.ts'
export {
  FACTOR_STRATEGY_VERSION,
  DEFAULT_FACTOR_STRATEGY_WF,
  DEFAULT_FACTOR_STRATEGY_GATE,
  normalizeSignal,
  signalKey,
  factorTimingStrategy,
  deriveSignFromTrain,
  evaluateFactorStrategy,
  summarizeStrategyFolds,
  COST_DRAG_LABEL,
  COST_DRAG_NOTE,
  COST_PER_FILL_LABEL,
  EDGE_PER_FILL_LABEL,
  PER_FILL_NOTE,
  judgeFactorStrategy,
  screenFactorStrategy,
} from './factorStrategy.ts'
export type {
  FactorTimingOptions,
  SignDerivation,
  FactorStrategyFold,
  FactorStrategyReceipt,
  FactorStrategyConfig,
  FactorStrategyThresholds,
  FactorStrategyOutcome,
  FactorStrategyVerdict,
  FactorStrategyScreenResult,
} from './factorStrategy.ts'
export {
  DEFAULT_CROSS_SECTION_GATE,
  alignPanel,
  projectFactor,
  pooledIc,
  crossSectionBacktest,
  judgeCrossSection,
} from './crossSection.ts'
export type {
  PanelInput,
  Panel,
  IcPoint,
  IcOptions,
  PooledIcResult,
  CrossSectionConfig,
  CrossSectionLogRow,
  CrossSectionResult,
  CrossSectionThresholds,
  CrossSectionOutcome,
  CrossSectionVerdict,
} from './crossSection.ts'
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
