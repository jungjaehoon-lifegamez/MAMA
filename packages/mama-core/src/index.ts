/**
 * MAMA Core - Main exports
 *
 * Shared modules for Memory-Augmented MCP Assistant.
 *
 * @module mama-core
 * @version 1.0.0
 */

export {
  generateEmbedding,
  generateEnhancedEmbedding,
  cosineSimilarity,
  embeddingCache,
  EMBEDDING_DIM,
  MODEL_NAME,
  EMBEDDING_PREFIX_SCHEME,
  type EmbeddingRole,
} from './embedding/embedder.js';

export { EmbeddingCache } from './embedding-cache.js';

export {
  initDB,
  getDB,
  getAdapter,
  closeDB,
  updateDecisionOutcome,
  getDbPath,
  type DatabaseAdapter,
  type DatabaseInstance,
  type PreparedStatement,
  type DecisionRecord,
  type OutcomeData,
  type SemanticEdges,
  type SemanticEdgeItem,
  type DecisionInput,
} from './db-manager.js';

export {
  createAdapter,
  SQLiteAdapter,
  type AdapterConfig,
  type Statement,
  type VectorSearchResult,
  type RunResult,
} from './db-adapter/index.js';

import mama from './mama-api.js';
export { mama };
export { createMamaApi, type MamaApi } from './mama-api.js';

export {
  MEMORY_SCOPE_KINDS,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_EDGE_TYPES,
  createEmptyRecallBundle,
  type MemoryScopeKind,
  type MemoryKind,
  type MemoryKindFilter,
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
  type AuditFindingRecord,
  canonicalizeContextScopes,
} from './memory/types.js';
export {
  saveMemory,
  saveJudgmentRecord,
  saveLegacyMemory,
  readMemoryRecordById,
  readMemoryRecordsInScopes,
  retireMemoryRecord,
  recallMemory,
  RECALL_EXCLUDED_STATUSES,
  buildProfile,
  ingestMemory,
  buildMemoryBootstrap,
  createAuditAck,
  recordMemoryAudit,
  ingestConversation,
  upsertChannelSummary,
  getChannelSummary,
  type MemoryRetirementStatus,
  type ReadMemoryRecordsOptions,
} from './memory/api.js';
export {
  createKnowledge,
  appendJudgment,
  ingestSource,
  JudgmentError,
  type Knowledge,
  type KnowledgeOptions,
  type JudgmentAccess,
  type SourceIngestCommand,
  type SourceIngestReceipt,
  type WorkGraphPage,
  type WorkGraphQuery,
  type WorkReference,
} from './knowledge/index.js';
export { queryRelevantTruth } from './memory/truth-store.js';
export { createAuditFinding, listOpenAuditFindings } from './memory/finding-store.js';
export {
  appendMemoryEvent,
  insertMemoryEventInTransaction,
  listMemoryEventsForMemory,
  listRecentMemoryEvents,
} from './memory/event-store.js';
export {
  normalizeMemoryWriteProvenance,
  type NormalizedMemoryProvenance,
} from './memory/provenance.js';
export {
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
} from './memory/provenance-query.js';
export {
  getMemoryProvenanceAudit,
  listMemoryProvenanceAudit,
  type MemoryProvenanceAuditRecord,
  type MemoryProvenanceAuditListOptions,
} from './memory/provenance-audit.js';
export {
  OBSERVATION_COLUMNS,
  isEventVisibleNow,
  isMessageRefVisible,
  parseSourceRef,
  resolveMemoryProvenanceLive,
  toIndexedEvent,
  type EventRow,
  type LiveProvenanceOptions,
} from './memory/provenance-live.js';
export {
  resolveMemoryProvenance,
  type IndexedEvent,
  type ParsedSourceRef,
  type ProvenanceResolution,
  type ProvenanceResolverDeps,
  type ProvenanceSubjectRecord,
  type RecordedSupport,
  type ResolutionFailure,
  type ResolvedEvent,
  type UnresolvedSupport,
} from './memory/provenance-resolver.js';
export {
  sanitizeRecallBundle,
  sanitizeRecallText,
  type SafeRecallBundle,
  type SafeRecallMemory,
} from './memory/recall-sanitize.js';
export {
  scanForSecrets,
  scanMemoryWriteInput,
  type SecretScanResult,
} from './memory/secret-filter.js';
export {
  MODEL_RUN_STATUSES,
  type ModelRunStatus,
  type BeginModelRunInput,
  type ModelRunRecord,
  type AppendToolTraceInput,
  type AppendOperationToolTraceInput,
  type ToolTraceRecord,
  type ToolTraceScope,
  type ListToolTracesInput,
  type ToolTracePage,
} from './runtime/model-run-types.js';
export {
  beginModelRun,
  commitModelRun,
  failModelRun,
  getModelRun,
} from './runtime/model-run-store.js';
export {
  appendToolTrace,
  appendOperationToolTrace,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
} from './runtime/tool-trace-store.js';
export {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type InsertTwinEdgeInput,
  type ListVisibleTwinEdgesOptions,
  type TwinEdgeInsert,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
  type TwinScopeRef,
} from './knowledge/twin-edge-types.js';
export { getTwinEdge, listTwinEdgesForRefs, mapTwinEdgeRow } from './knowledge/judgments.js';
export { listVisibleTwinEdgesForRefs } from './knowledge/access.js';
export type {
  ActionCall,
  ActionContract,
  ActionExample,
  ActionFailure,
  ActionFailureKind,
  ActionResult,
  ActionSchemaObject,
  ActionSessionFacts,
} from './action-contracts.js';
export {
  createCatalog,
  coreActionRegistrations,
  UnknownActionError,
  type ActionCatalog,
  type ActionContext,
  type ActionExec,
  type ActionRegistration,
  type MemoryReadAllowance,
} from './api/catalog.js';
export {
  createDispatcher,
  validateInput,
  withCallReceipt,
  type ActionDispatcher,
  type DispatcherOptions,
} from './api/dispatch.js';
export { createClient, type Client, type ClientCall, type ClientOptions } from './client/client.js';
export {
  startRuntime,
  type RuntimeHandle,
  type RuntimePaths,
  type StartRuntimeOptions,
} from './runtime/runtime.js';
export {
  createActionIpcServer,
  encodeFrame,
  IpcTransportError,
  newRequestId,
  sendIpcRequest,
  IPC_MAX_FRAME_BYTES,
  type ActionIpcServer,
  type ActionIpcServerOptions,
  type IpcRequest,
  type IpcResponse,
} from './client/ipc.js';
export * from './provenance/source-ref.js';
export * from './knowledge/case-errors.js';
export * from './knowledge/graph-query.js';
export {
  canonicalizeJSON,
  targetRefHash,
  CanonicalizeError,
  type CanonicalizeErrorCode,
} from './canonicalize.js';

export {
  calculateRelevance,
  selectTopDecisions,
  formatTopNContext,
  type DecisionWithEmbedding,
  type QueryContext,
  type FormattedContext,
  type TestResult,
} from './relevance-scorer.js';

export {
  logProgress,
  logComplete,
  logFailed,
  logError,
  logLoading,
  logSearching,
} from './progress-indicator.js';

export { debug, info, warn, error, DebugLogger } from './debug-logger.js';

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
  generate,
  isAvailable,
  listModels,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  type GenerateOptions,
  type DecisionAnalysisResult,
  type QueryIntentResult,
} from './ollama-client.js';

// The shape a host states its one model in. `ollama-client` above is one such
// model a host may wire; nothing in this library opens it by itself (§2.1).
export type { TextCompletion, TextCompletionOptions } from './runtime/text-completion.js';

export * from './knowledge/case-types.js';
export * from './knowledge/case-store.js';
export * from './knowledge/case-search-rollup.js';
export * from './knowledge/case-timeline-range.js';
export * from './knowledge/observations.js';
export * from './identity/principal-repository.js';
export * from './knowledge/question-type.js';
export * from './knowledge/feedback-store.js';
export * from './knowledge/ranker-features.js';
export * from './knowledge/ranker-trainer.js';
export * from './knowledge/ranker-rescore.js';
export * from './knowledge/search-quality.js';
export * from './registry/store.js';
export * from './registry/record-identity.js';
export * from './registry/corrections.js';
export * from './registry/types.js';
export * from './operations/owner-action-effects.js';
