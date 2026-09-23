/**
 * Agent 舰队 —— 对外唯一入口
 *
 * 调用方（HTTP 路由、语音层、前端、烟测）一律只从 `server/fleet/index.ts` 取。
 * 分成多个文件是为了让"注册表 / 总线 / 成员 / 调度"各自可单独读；
 * 但对外的面**只有一个**，否则同一个能力又会长出第二条调用路径。
 */
export { FLEET_AGENTS, fleetAgent, fleetRoster } from './agents.ts'
export { auditFleetRegistry, deriveSubscriptions, installSubscriptions, renderRegistryBrief, reusesPath } from './registry.ts'
export type { FleetProblem } from './registry.ts'
export {
  __resetFleetForTest,
  ensureFleetInstalled,
  fleetLastTask,
  fleetSnapshot,
  planNeedsConfirm,
  planTask,
  renderTaskBrief,
  runAgent,
  runTask,
  undoPlanOf,
  FLEET_TASK_PLANS,
} from './service.ts'
export type { FleetAgentView, FleetEmitted, FleetRunReceipt, FleetSnapshot, FleetTaskReceipt, FleetTaskStepView } from './service.ts'
export {
  busStats,
  inboxOf,
  publish,
  recentMessages,
  resetBus,
  subscribe,
  subscribedTopics,
  topicSubscribers,
} from './bus.ts'
export type { FleetDelivery, PublishResult } from './bus.ts'
export {
  formatBytes,
  renderHygieneBrief,
  scanHygiene,
} from './hygiene.ts'
export type { HygieneEntry, HygieneGroup, HygieneReport, HygieneVerdict } from './hygiene.ts'
// ── 第十七轮新增：可逆清理 / 迭代挖掘 / 自我学习 / 自治循环 ──────────────
export { CLEAN_MAX_ITEMS, judgePath, listTrash, planClean, renderCleanBrief, runClean } from './cleaner.ts'
export type { CleanPlan, CleanResult, CleanSkip, CleanCandidate, TrashView } from './cleaner.ts'
export { BARREN_LIMIT, mineFactors, WINDOW_SETS } from './factorMine.ts'
export type { MineResult, MineRound, MineStopReason } from './factorMine.ts'
export { appendLearnNote, collectObservations, parseProposals, recentLearnNotes, renderLearnBrief, runSelfLearn, LEARN_SYSTEM_PROMPT } from './learner.ts'
export type { LearnNote, LearnProposal, LearnRisk } from './learner.ts'
// ── 第十八轮新增：新闻雷达（定时读 → 判相关 → 写内化提案）─────────────────
export {
  KEEP_THRESHOLD,
  NEWS_INTERNALIZE_PROMPT,
  NEWS_SOURCES,
  RELEVANCE_TERMS,
  TICKERS,
  appendNewsVerdict,
  countTicker,
  githubSearchUrl,
  internalizeTop,
  latestDigest,
  newsDigestPath,
  newsDir,
  newsLastRunPath,
  newsSeenPath,
  newsTrendingPath,
  newsVerdictPath,
  pendingProposalCount,
  pendingSpeech,
  proposalKey,
  proposalRows,
  readLastRun,
  readLearnNotes,
  readNewsVerdicts,
  readTrending,
  renderNewsBrief,
  runNewsWatch,
  scoreText,
  seenIds,
  suggestedUniverse,
  tickerHeat,
  writeLastRun,
  writeTrending,
} from './news.ts'
export type {
  InternalizeResult,
  NewsDeps,
  NewsItem,
  NewsLastRun,
  NewsSource,
  NewsVerdict,
  NewsWatchResult,
  ProposalDecision,
  ProposalRow,
  RelevanceTerm,
  SourceReport,
  TickerHit,
  TickerTerm,
} from './news.ts'
export {
  AUTONOMY_JOBS,
  autonomyStatus,
  autonomyTicks,
  autostartAutonomy,
  autonomyAutoStartWanted,
  bindAutonomyRunner,
  startAutonomy,
  stopAutonomy,
  __resetAutonomyForTest,
  __setAutonomyDepsForTest,
  __resetAutonomyDepsForTest,
} from './autonomy.ts'
export type { AutonomyJob, AutonomyJobState, AutonomyStatus, AutonomyTick, StartAutonomyResult } from './autonomy.ts'
export { FLEET_CONSUMERS, FLEET_TOPICS, fleetConsumer, fleetTopic } from './types.ts'
export type { FleetAgent, FleetConsumer, FleetMessage, FleetRawResult, FleetRunArg, FleetTopic } from './types.ts'
