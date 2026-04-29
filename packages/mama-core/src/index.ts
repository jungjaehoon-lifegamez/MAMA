/**
 * MAMA Core - Main exports
 *
 * Shared modules for Memory-Augmented MCP Assistant.
 * Used by mcp-server, claude-code-plugin, and standalone packages.
 *
 * @module mama-core
 * @version 1.0.0
 */

export {
  generateEmbedding,
  generateEnhancedEmbedding,
  generateBatchEmbeddings,
  cosineSimilarity,
  embeddingCache,
  EMBEDDING_DIM,
  MODEL_NAME,
} from './embeddings.js';

export { EmbeddingCache } from './embedding-cache.js';

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
  fts5Search,
  reindexEmbeddings,
  type DatabaseAdapter as DBManagerAdapter,
  type PreparedStatement,
  type DecisionRecord,
  type OutcomeData,
  type VectorSearchParams,
  type SemanticEdges,
  type SemanticEdgeItem,
  type DecisionInput,
} from './db-manager.js';

export {
  createAdapter,
  DatabaseAdapter,
  SQLiteAdapter,
  type AdapterConfig,
  type Statement,
  type VectorSearchResult,
  type RunResult,
} from './db-adapter/index.js';

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

import mama from './mama-api.js';
export { mama };

export {
  MEMORY_SCOPE_KINDS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_EDGE_TYPES,
  createEmptyRecallBundle,
  type MemoryScopeKind,
  type MemoryKind,
  type MemoryStatus,
  type MemoryEdgeType,
  type MemoryScopeRef,
  type MemorySourceRef,
  type MemoryRecord,
  type MemoryWriteProvenance,
  type MemoryProvenanceRecord,
  type PublicSaveMemoryInput,
  type PublicIngestMemoryInput,
  type PublicIngestConversationInput,
  type MemorySearchResultHit,
  type MemoryEdge,
  type ProfileSnapshot,
  type RecallBundle,
  type ConversationMessage,
  type IngestConversationInput,
  type ExtractedMemoryUnit,
  type IngestConversationResult,
} from './memory/types.js';
export {
  saveMemory,
  saveMemoryWithTrustedProvenance,
  recallMemory,
  buildProfile,
  ingestMemory,
  ingestWithTrustedProvenance,
  evolveMemory,
  buildMemoryBootstrap,
  createAuditAck,
  recordMemoryAudit,
  ingestConversation,
  ingestConversationWithTrustedProvenance,
  setExtractionFn,
  upsertChannelSummary,
  getChannelSummary,
} from './memory/api.js';
export { buildExtractionPrompt, parseExtractionResponse } from './memory/extraction-prompt.js';
export {
  appendMemoryEvent,
  insertMemoryEventInTransaction,
  listMemoryEventsForMemory,
  listRecentMemoryEvents,
} from './memory/event-store.js';
export {
  createTrustedProvenanceCapability,
  assertTrustedProvenanceCapability,
  type TrustedProvenanceCapability,
  type TrustedMemoryWriteOptions,
} from './memory/provenance.js';
export {
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
} from './memory/provenance-query.js';
export {
  backfillLegacyMemoryProvenance,
  backfillConnectorEventScopeMetadata,
  type BackfillResult,
  type ConnectorEventScopeBackfillInput,
} from './memory/scope-backfill.js';
export {
  getMemoryProvenanceAudit,
  listMemoryProvenanceAudit,
  type MemoryProvenanceAuditRecord,
  type MemoryProvenanceAuditListOptions,
} from './memory/provenance-audit.js';
export {
  MODEL_RUN_STATUSES,
  type ModelRunStatus,
  type BeginModelRunInput,
  type ModelRunRecord,
  type AppendToolTraceInput,
  type ToolTraceRecord,
} from './model-runs/types.js';
export {
  beginModelRun,
  beginModelRunInAdapter,
  commitModelRun,
  commitModelRunInAdapter,
  failModelRun,
  failModelRunInAdapter,
  getModelRun,
  getModelRunInAdapter,
} from './model-runs/store.js';
export { appendToolTrace, listToolTracesForRun } from './model-runs/tool-trace-store.js';
export {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type InsertTwinEdgeInput,
  type ListVisibleTwinEdgesOptions,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
  type TwinScopeRef,
} from './edges/types.js';
export {
  getTwinEdge,
  insertTwinEdge,
  listTwinEdgesForRefs,
  mapTwinEdgeRow,
} from './edges/store.js';
export {
  assertTwinRefsVisibleToScopes,
  listVisibleTwinEdgesForRefs,
} from './edges/ref-validation.js';
export * from './entities/types.js';
export * from './entities/errors.js';
export * from './entities/store.js';
export * from './entities/normalization.js';
export * from './entities/projection.js';
export * from './entities/recall-bridge.js';
export * from './entities/read-identity.js';
export * from './entities/audit-metrics.js';
export * from './entities/provenance-query.js';
export * from './entities/lineage-store.js';
export * from './entities/lineage-backfill.js';
export * from './entities/exact-merge-backfill.js';
export * from './entities/entity-search.js';
export * from './entities/entity-list.js';
export * from './entities/entity-orphan-list.js';
export * from './entities/entity-impact.js';
export * from './entities/rollback-preview.js';
export * from './entities/source-locator.js';
export * from './entities/policy-types.js';
export * from './entities/policy-store.js';
export {
  canonicalizeJSON,
  targetRefHash,
  CanonicalizeError,
  type CanonicalizeErrorCode,
} from './canonicalize.js';

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

export {
  logProgress,
  logComplete,
  logFailed,
  logError,
  logInfo,
  logLoading,
  logSearching,
} from './progress-indicator.js';

export { debug, info, warn, error, DebugLogger } from './debug-logger.js';

export { formatTimeAgo } from './time-formatter.js';

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

export { injectDecisionContext } from './memory-inject.js';

export {
  analyzeIntent,
  extractTopicKeywords,
  type IntentResult,
  type AnalyzeOptions,
} from './query-intent.js';

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

export { notifyInsight } from './notification-manager.js';

export * from './cases/types.js';
export * from './cases/store.js';
export * from './cases/role-inference.js';
export * from './cases/target-ref.js';
export * from './cases/corrections.js';
export * from './cases/sqlite-transaction.js';
export * from './cases/live-state.js';
export * from './cases/tombstone-sweeper.js';
export * from './cases/merge-split.js';
export * from './cases/membership-matcher.js';
export * from './cases/search-rollup.js';
export * from './cases/timeline-range.js';
export * from './cases/wiki-page-index.js';
export * from './cases/case-links.js';
export * from './cases/composition-overrides.js';
export * from './cases/freshness.js';
export * from './cases/membership-explain.js';
export * from './connectors/event-index.js';
export * from './connectors/raw-query.js';
export * from './connectors/types.js';
export * from './search/question-type.js';
export * from './search/feedback-store.js';
export * from './search/ranker-features.js';
export * from './search/ranker-trainer.js';
export * from './search/ranker-rescore.js';
