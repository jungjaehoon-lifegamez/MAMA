/**
 * MAMA Core - Main exports
 *
 * Shared modules for Memory-Augmented MCP Assistant.
 * Used by mcp-server, claude-code-plugin, and standalone packages.
 *
 * @module mama-core
 * @version 1.0.0
 */

// Embeddings
export {
  generateEmbedding,
  generateEnhancedEmbedding,
  generateBatchEmbeddings,
  cosineSimilarity,
  embeddingCache,
  EMBEDDING_DIM,
  MODEL_NAME,
} from './embeddings.js';

// Embedding cache
export { EmbeddingCache } from './embedding-cache.js';

// Embedding client
export {
  getEmbeddingFromServer,
  getServerStatus,
  isServerRunning,
  getServerPort,
  DEFAULT_PORT,
  HOST,
  TIMEOUT_MS,
  type ServerStatus,
} from './embedding-client.js';

// Database manager
export {
  initDB,
  getDB,
  getAdapter,
  closeDB,
  insertEmbedding,
  vectorSearch,
  queryVectorSearch,
  insertDecisionWithEmbedding,
  queryDecisionGraph,
  querySemanticEdges,
  updateDecisionOutcome,
  getPreparedStmt,
  getDbPath,
  type DatabaseAdapter as DBManagerAdapter,
  type PreparedStatement,
  type DecisionRecord,
  type OutcomeData,
  type VectorSearchParams,
  type SemanticEdges,
  type DecisionInput,
} from './db-manager.js';

// Database adapter
export {
  createAdapter,
  DatabaseAdapter,
  SQLiteAdapter,
  type AdapterConfig,
  type Statement,
  type VectorSearchResult,
  type RunResult,
} from './db-adapter/index.js';

// Memory store
export {
  getSessionDecisions,
  incrementUsageSuccess,
  incrementUsageFailure,
  getDecisionById,
  traverseDecisionChain,
  DB_PATH,
  DB_DIR,
  LEGACY_DB_PATH,
  DEFAULT_DB_PATH,
} from './memory-store.js';

// MAMA API
import mama from './mama-api.js';
export { mama };

// Config loader
export {
  loadConfig,
  getModelName,
  getEmbeddingDim,
  getCacheDir,
  updateConfig,
  getConfigPath,
  DEFAULT_CONFIG,
  type MAMAConfig,
  type ConfigUpdates,
} from './config-loader.js';

// Relevance scorer
export {
  calculateRelevance,
  selectTopDecisions,
  formatTopNContext,
  testRelevanceScoring,
  type DecisionWithEmbedding,
  type QueryContext,
  type FormattedContext,
  type TestResult,
} from './relevance-scorer.js';

// Decision tracker
export {
  learnDecision,
  generateDecisionId,
  getPreviousDecision,
  createEdge,
  createSupersedesEdge,
  markSuperseded,
  calculateCombinedConfidence,
  detectRefinement,
  parseReasoningForRelationships,
  createEdgesFromReasoning,
  getSupersededChainDepth,
  updateConfidence,
  VALID_EDGE_TYPES,
  type EdgeType,
  type DecisionDetection,
  type ToolExecution,
  type SessionContext,
  type LearnDecisionResult,
  type ParsedRelationship,
  type EvidenceItem,
} from './decision-tracker.js';

// Tier validator
export {
  validateTier,
  checkNodeVersion,
  checkSQLite,
  checkEmbeddings,
  checkDatabase,
  getTierDescription,
  getTierBanner,
  type TierValidation,
  type CheckResult,
  type NamedCheckResult,
} from './tier-validator.js';

// Progress indicator
export {
  logProgress,
  logComplete,
  logFailed,
  logError,
  logInfo,
  logLoading,
  logSearching,
} from './progress-indicator.js';

// Debug logger
export { debug, info, warn, error, DebugLogger } from './debug-logger.js';

// Time formatter
export { formatTimeAgo } from './time-formatter.js';

// Errors
export {
  MAMAError,
  NotFoundError,
  ValidationError,
  DatabaseError,
  EmbeddingError,
  ConfigurationError,
  LinkError,
  RateLimitError,
  TimeoutError,
  ErrorCodes,
  wrapError,
  isMAMAError,
  type ErrorDetails,
  type ErrorResponse,
  type ErrorJSON,
  type ErrorCode,
} from './errors.js';

// Decision formatter
export {
  formatContext,
  formatLegacyContext,
  formatRecall,
  formatList,
  formatTeaser,
  formatInstantAnswer,
  formatTrustContext,
  ensureTokenBudget,
  estimateTokens,
  extractQuickAnswer,
  extractCodeExample,
  type DecisionForFormat,
  type TrustContext,
  type SemanticEdges as FormatterSemanticEdges,
  type FormatOptions,
} from './decision-formatter.js';

// Outcome tracker
export {
  analyzeOutcome,
  matchesFailureIndicators,
  matchesSuccessIndicators,
  matchesPartialIndicators,
  extractFailureReason,
  getRecentDecision,
  calculateDurationDays,
  getEvidenceImpact,
  markOutcome,
  onUserPromptSubmit,
  FAILURE_INDICATORS,
  SUCCESS_INDICATORS,
  PARTIAL_INDICATORS,
  RECENT_WINDOW_MS,
  type HookContext,
  type OutcomeType,
} from './outcome-tracker.js';

// Memory inject
export { injectDecisionContext } from './memory-inject.js';

// Query intent
export {
  analyzeIntent,
  extractTopicKeywords,
  type IntentResult,
  type AnalyzeOptions,
} from './query-intent.js';

// Ollama client
export {
  generate,
  analyzeDecision,
  analyzeQueryIntent,
  isAvailable,
  listModels,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  type GenerateOptions,
  type DecisionAnalysisResult,
  type QueryIntentResult,
} from './ollama-client.js';

// Notification manager
export { notifyInsight } from './notification-manager.js';
