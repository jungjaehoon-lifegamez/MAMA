/**
 * MAMA (Memory-Augmented MCP Architecture) - Simple Public API
 *
 * Clean wrapper around MAMA's internal functions
 * Follows Claude-First Design: Simple, Transparent, Non-Intrusive
 *
 * Core Principle: MAMA = Librarian, Claude = Researcher
 * - MAMA stores (organize books), retrieves (find books), indexes (catalog)
 * - Claude decides what to save and how to use recalled decisions
 *
 * v1.3 Update: Collaborative Reasoning Graph
 * - Auto-search on save: Find similar decisions before saving
 * - Collaborative invitation: Suggest build-on/debate/synthesize
 * - AX-first: Soft warnings, not hard blocks
 *
 * @module mama-api
 * @version 1.3
 * @date 2025-11-26
 */

// Internal modules
import {
  DecisionRecord,
  SemanticEdgeItem,
  ensureMemoryScopeInAdapter,
  initDB,
  getAdapter,
} from './db-manager.js';
import { fts5Search, vectorSearch } from './knowledge/search.js';
import { queryDecisionGraph, querySemanticEdges } from './knowledge/graph-query.js';
import { appendOutcomeAmendment } from './memory/write-adapters.js';
import { formatRecall, formatList, formatContext, SemanticEdges } from './decision-formatter.js';
import { logProgress, logComplete, logSearching } from './progress-indicator.js';
import { generateEmbedding } from './embeddings.js';
import { generate } from './ollama-client.js';
import { warn as logWarn, error as logError } from './debug-logger.js';
import {
  saveMemory,
  saveMemoryWithTrustedProvenance,
  saveLegacyMemory,
  recallMemory,
  buildProfile,
  ingestMemory,
  ingestWithTrustedProvenance,
  ingestConversation,
  ingestConversationWithTrustedProvenance,
  evolveMemory,
  buildMemoryBootstrap,
  createAuditAck,
  recordMemoryAudit,
  upsertChannelSummary,
  getChannelSummary,
} from './memory/api.js';
import {
  createAuditFinding as createAuditFindingInAdapter,
  listOpenAuditFindings,
} from './memory/finding-store.js';
import { listMemoryEventsForMemory, listRecentMemoryEvents } from './memory/event-store.js';
import type { TrustedMemoryWriteOptions } from './memory/provenance.js';
import {
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
} from './memory/provenance-query.js';
import {
  beginModelRun,
  beginModelRunInAdapter,
  commitModelRun,
  commitModelRunInAdapter,
  failModelRun,
  failModelRunInAdapter,
  getModelRun,
  getModelRunInAdapter,
} from './model-runs/store.js';
import {
  appendToolTrace,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
} from './model-runs/tool-trace-store.js';
import {
  rollUpSearchHits,
  type SearchRollupLeafHit,
  type SearchRollupResult,
} from './cases/search-rollup.js';
import { isSearchRankerEnabled, rescoreSearchResults } from './search/ranker-rescore.js';
import { SEARCH_RANKER_FEATURE_SET_VERSION } from './search/ranker-features.js';
import {
  normalizeSearchQualityOptions,
  type SearchHitDiagnostics,
  type SearchQualityOptions,
} from './search/search-quality.js';

// ════════════════════════════════════════════════════════════════════════════
// Type Definitions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parameters for mama.save()
 */
interface SaveParams {
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
  type?: 'user_decision' | 'assistant_insight';
  outcome?: 'pending' | 'success' | 'failure' | 'partial' | 'superseded';
  failure_reason?: string | null;
  limitation?: string | null;
  trust_context?: Record<string, unknown> | null;
  is_static?: number; // 1 = long-term preference, 0 = project-specific (default)
  scopes?: Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>;
  item?: string | null;
  actors?: Array<{ person: string; role: string }>;
  /** ISO 8601 date string for when the event actually occurred (e.g. "2023-01-15") */
  event_date?: string | null;
}

/**
 * Similar decision result from search
 */
interface SimilarDecision {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string;
  similarity?: number;
  retrieval_score?: number | null;
  created_at?: number | string;
  event_date?: string | null;
  event_datetime?: number | null;
  retrieval_diagnostics?: SearchHitDiagnostics;
}

/**
 * Search result from mama.search()
 */
interface SearchResult {
  query: string;
  results: SimilarDecision[];
  meta: {
    count: number;
    search_method: string;
    threshold: number;
    recency_boost: {
      weight: number;
      scale: number;
      decay: number;
    } | null;
    graph_expansion: {
      total_results: number;
      primary_count: number;
      expanded_count: number;
      sources: Record<string, number>;
    } | null;
    ranker: Record<string, unknown> | null;
  };
}

/**
 * Suggest options for mama.suggest()
 */
export interface SuggestOptions {
  limit?: number;
  threshold?: number;
  format?: 'full' | 'teaser' | 'brief' | 'markdown';
  rerankWithLearned?: boolean;
  recency_boost?:
    | boolean
    | {
        weight?: number;
        scale?: number;
        decay?: number;
      };
  graph_expansion?: boolean;
}

/**
 * Reasoning graph info
 */
interface ReasoningGraphInfo {
  topic: string;
  depth: number;
  latest: string;
}

/**
 * Save result from mama.save()
 */
interface SaveResult {
  success: boolean;
  id: string;
  saved_decision_id?: string;
  similar_decisions?: SimilarDecision[];
  warning?: string;
  collaboration_hint?: string;
  reasoning_graph?: ReasoningGraphInfo;
  error?: string;
}

/**
 * Suggest result from mama.suggest()
 */
export interface SuggestResult {
  query: string;
  formatted_context: string;
  raw_decisions?: SimilarDecision[];
  meta?: SearchResult['meta'];
  error?: string;
}

/**
 * Recall result from mama.recall()
 */
export interface RecallResult {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string;
  outcome?: string | null;
  failure_reason?: string | null;
  confidence: number;
  supersedes?: string | null;
  superseded_by?: string | null;
  created_at: number | string;
  updated_at?: number | string;
  trust_context?: Record<string, unknown> | null;
  history?: DecisionRecord[];
  semantic_edges?: SemanticEdges;
  error?: string;
}

/**
 * Update result from mama.update()
 */
export interface UpdateResult {
  success: boolean;
  id: string;
  updated_fields: string[];
  error?: string;
}

/**
 * Checkpoint params
 */
export interface CheckpointParams {
  summary: string;
  next_steps?: string;
  open_files?: string[];
}

/**
 * Checkpoint result
 */
export interface CheckpointResult {
  success: boolean;
  id: string;
  timestamp: string;
  error?: string;
}

/**
 * Load checkpoint result
 */
export interface LoadCheckpointResult {
  found: boolean;
  summary?: string;
  next_steps?: string;
  open_files?: string[];
  created_at?: string;
  error?: string;
}

/**
 * Outcome badge map type
 */
export type OutcomeBadgeMap = Record<string, string | null>;

/**
 * Raw semantic edge from database
 */
/**
 * Recall options
 */
interface RecallOptions {
  format?: 'json' | 'markdown';
}

/**
 * DB stats result for decision_edges
 */
export interface DBStatsResult {
  total_links: number;
  llm_created: number;
  approved: number;
}

/**
 * DB link stats result
 */
export interface DBLinkStatsResult {
  total_links: number;
  llm_created: number;
  approved: number;
  unique_decisions: number;
  relationship_breakdown: string;
}

// Session-level warning cooldown cache (Story 1.1, 1.2)
// Prevents spam by tracking warned topics per session
const warnedTopicsCache = new Map<string, number>();
const WARNING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Save a decision or insight to MAMA's memory
 *
 * Simple API for Claude to save insights without complex configuration
 * AC #1: Simple API - no complex configuration required
 *
 * @param {Object} params - Decision parameters
 * @param {string} params.topic - Decision topic (e.g., 'auth_strategy', 'date_format')
 * @param {string} params.decision - The decision made (e.g., 'JWT', 'ISO 8601 + Unix')
 * @param {string} params.reasoning - Why this decision was made
 * @param {number} [params.confidence=0.5] - Confidence score 0.0-1.0 (optional)
 * @param {string} [params.type='user_decision'] - 'user_decision' or 'assistant_insight' (optional)
 * @param {string} [params.outcome='pending'] - 'pending', 'success', 'failure', 'partial', 'superseded' (optional)
 * @param {string} [params.failure_reason] - Why this decision failed (optional, used with outcome='failure')
 * @param {string} [params.limitation] - Known limitations of this decision (optional)
 * @returns {Promise<{success: boolean, id: string, similar_decisions?: Array, warning?: string, collaboration_hint?: string, reasoning_graph?: Object}>} Save result with decision ID and metadata
 *
 * @example
 * const decisionId = await mama.save({
 *   topic: 'date_calculation_format',
 *   decision: 'Support both ISO 8601 and Unix timestamp formats',
 *   reasoning: 'Bootstrap data stored as ISO 8601 causing NaN errors',
 *   confidence: 0.95,
 *   type: 'assistant_insight',
 *   outcome: 'success'
 * });
 */
async function saveInternal(
  {
    topic,
    decision,
    reasoning,
    confidence = 0.5,
    type = 'user_decision',
    outcome = 'pending',
    failure_reason = null,
    limitation = null,
    trust_context: _trust_context = null,
    is_static,
    scopes: inputScopes,
    item,
    actors,
    event_date,
  }: SaveParams,
  options?: TrustedMemoryWriteOptions
): Promise<SaveResult> {
  // Validate required fields
  if (!topic || typeof topic !== 'string') {
    throw new Error('mama.save() requires topic (string)');
  }
  if (!decision || typeof decision !== 'string') {
    throw new Error('mama.save() requires decision (string)');
  }
  if (!reasoning || typeof reasoning !== 'string') {
    throw new Error('mama.save() requires reasoning (string)');
  }

  // Validate confidence range
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('mama.save() confidence must be a number between 0.0 and 1.0');
  }

  // Validate type
  if (type !== 'user_decision' && type !== 'assistant_insight') {
    throw new Error('mama.save() type must be "user_decision" or "assistant_insight"');
  }

  // Validate outcome
  const validOutcomes = ['pending', 'success', 'failure', 'partial', 'superseded'];
  if (outcome && !validOutcomes.includes(outcome)) {
    throw new Error(
      `mama.save() outcome must be one of: ${validOutcomes.join(', ')} (got: ${outcome})`
    );
  }

  // Validate scopes shape
  if (inputScopes !== undefined && inputScopes !== null) {
    if (!Array.isArray(inputScopes)) {
      throw new Error('mama.save() scopes must be an array');
    }
    const validKinds = ['global', 'user', 'channel', 'project'];
    for (const scope of inputScopes) {
      if (
        !scope ||
        typeof scope !== 'object' ||
        typeof scope.kind !== 'string' ||
        typeof scope.id !== 'string'
      ) {
        throw new Error('mama.save() each scope must have kind (string) and id (string)');
      }
      if (typeof scope.id === 'string' && scope.id.trim().length === 0) {
        throw new Error('mama.save() each scope.id must be a non-empty string');
      }
      if (!validKinds.includes(scope.kind)) {
        throw new Error(
          `mama.save() scope kind must be one of: ${validKinds.join(', ')} (got: ${scope.kind})`
        );
      }
    }
  }

  // Map type to user_involvement field
  // Note: Current schema uses user_involvement ('requested', 'approved', 'rejected')
  // Future: Will use decision_type column for proper distinction
  const _userInvolvement = type === 'user_decision' ? 'approved' : null;
  const outcomeMap = {
    pending: null,
    success: 'SUCCESS',
    failure: 'FAILED',
    partial: 'PARTIAL',
    superseded: null,
  } as const;
  const dbOutcome =
    outcome in outcomeMap ? outcomeMap[outcome as keyof typeof outcomeMap] : outcome;

  // Reasoning text is evidence, not authority: relationships are only written
  // when the caller names explicit targets (saveLegacyMemory's legacy field or
  // twin-edge links). Parsing IDs out of prose fabricated edges, so it is gone.
  logProgress(`Saving decision: ${topic.substring(0, 30)}...`);
  const { id: decisionId } = await saveLegacyMemory(
    {
      topic,
      kind: is_static === 1 ? 'preference' : 'decision',
      summary: decision,
      details: reasoning,
      confidence,
      scopes: Array.isArray(inputScopes) && inputScopes.length > 0 ? inputScopes : [],
      source: {
        package: 'mama-core',
        source_type: 'legacy_save',
      },
      eventDate: event_date ?? undefined,
      itemId: item ?? undefined,
      actors: actors?.map((actor) => ({ personId: actor.person, role: actor.role })),
    },
    {
      userInvolvement: _userInvolvement,
      outcome: dbOutcome,
      failureReason: failure_reason ?? null,
      limitation: limitation ?? null,
      isStatic: is_static,
    },
    options
  );
  logComplete(`Decision saved: ${decisionId.substring(0, 20)}...`);

  // ════════════════════════════════════════════════════════════════════════════
  // Story 1.1: Auto-Search on Save
  // Story 1.2: Response Enhancement
  // ════════════════════════════════════════════════════════════════════════════
  let similar_decisions: SimilarDecision[] = [];
  let warning: string | null = null;
  let collaboration_hint: string | null = null;
  let reasoning_graph: ReasoningGraphInfo | null = null;

  // Only run auto-search for decisions (not checkpoints) with a topic
  if (topic) {
    // Skip global similarity search and reasoning graph for scoped saves
    if (!inputScopes || !Array.isArray(inputScopes) || inputScopes.length === 0) {
      try {
        // Story 1.1: Auto-search using suggest()
        // NOTE: suggest() searches globally and does not yet support scoped similarity search.
        // Cross-scope suggestions are possible here. Track as a follow-up.
        logSearching('Searching for related decisions...');
        const searchResults = await suggest(topic, {
          limit: 3,
          threshold: 0.7,
          disableRecency: true, // Pure semantic similarity for comparison
        });

        // Handle suggest() result which can be string | null | object
        if (searchResults && typeof searchResults === 'object' && 'results' in searchResults) {
          // Filter out the decision we just saved
          similar_decisions = (searchResults.results as SimilarDecision[])
            .filter((d: SimilarDecision & { source_type?: string }) => d.source_type === 'decision')
            .filter((d: SimilarDecision) => d.id !== decisionId)
            .map((d: SimilarDecision) => ({
              id: d.id,
              topic: d.topic,
              decision: d.decision,
              similarity: d.similarity,
              retrieval_score: d.retrieval_score ?? null,
              created_at: d.created_at,
              event_date: d.event_date ?? null,
              event_datetime: d.event_datetime ?? null,
            }));

          if (similar_decisions.length > 0) {
            logComplete(`Found ${similar_decisions.length} related decision(s)`);
          }

          // Story 1.2: Warning logic (similarity >= 0.85)
          const highSimilarity = similar_decisions.find(
            (d: SimilarDecision) => (d.similarity ?? 0) >= 0.85
          );
          if (highSimilarity && !_isTopicInCooldown(topic)) {
            warning = `High similarity (${((highSimilarity.similarity ?? 0) * 100).toFixed(0)}%) with existing decision "${highSimilarity.decision.substring(0, 50)}..."`;
            _markTopicWarned(topic);
          }

          // Story 1.2: Collaboration hint
          if (similar_decisions.length > 0) {
            collaboration_hint = _generateCollaborationHint(similar_decisions);
          }
        }
      } catch (error: unknown) {
        // Story 1.1 AC3: Best-effort - save succeeds even if auto-search fails
        const errMsg = error instanceof Error ? error.message : String(error);
        logError('Auto-search failed:', errMsg);
      }

      // Story 1.2: Reasoning graph info
      try {
        reasoning_graph = await _getReasoningGraphInfo(topic, decisionId);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logError('Reasoning graph query failed:', errMsg);
      }
    }
  }

  // Story 1.2: Enhanced response (backward compatible)
  return {
    success: true,
    id: decisionId,
    saved_decision_id: decisionId,
    ...(similar_decisions.length > 0 && { similar_decisions }),
    ...(warning && { warning }),
    ...(collaboration_hint && { collaboration_hint }),
    ...(reasoning_graph && { reasoning_graph }),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Story 1.2: Helper functions for Response Enhancement
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a topic is in warning cooldown
 * @param {string} topic - Topic to check
 * @returns {boolean} True if topic was warned recently
 */
function _isTopicInCooldown(topic: string): boolean {
  const lastWarned = warnedTopicsCache.get(topic);
  if (!lastWarned) {
    return false;
  }
  return Date.now() - lastWarned < WARNING_COOLDOWN_MS;
}

/**
 * Mark a topic as warned (start cooldown)
 * @param {string} topic - Topic to mark
 */
function _markTopicWarned(topic: string): void {
  warnedTopicsCache.set(topic, Date.now());
}

/**
 * Generate collaboration hint message
 * @param {Array} similarDecisions - Similar decisions found
 * @returns {string} Collaboration hint message
 */
function _generateCollaborationHint(similarDecisions: SimilarDecision[]): string | null {
  const count = similarDecisions.length;
  if (count === 0) {
    return null;
  }

  return `Found ${count} related decision(s). Consider:
- SUPERSEDE: Add "supersedes: <id>" in reasoning to replace a specific prior decision
- BUILD-ON: Add "builds_on: <id>" in reasoning to extend
- DEBATE: Add "debates: <id>" in reasoning for alternative view
- SYNTHESIZE: Add "synthesizes: [id1, id2]" in reasoning to unify`;
}

/**
 * Get reasoning graph info for a topic
 * @param {string} topic - Topic to query
 * @param {string} currentId - Current decision ID
 * @returns {Object} Reasoning graph info
 */
async function _getReasoningGraphInfo(
  topic: string,
  currentId: string
): Promise<ReasoningGraphInfo> {
  try {
    const chain = await queryDecisionGraph(getAdapter(), topic);

    if (!chain || chain.length === 0) {
      return {
        topic,
        depth: 1,
        latest: currentId,
      };
    }

    return {
      topic,
      depth: chain.length,
      latest: chain[0]?.id || currentId,
    };
  } catch {
    return {
      topic,
      depth: 1,
      latest: currentId,
    };
  }
}

/**
 * Recall decisions by topic
 *
 * DEFAULT: Returns JSON object with decisions and edges (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * @param {string} topic - Decision topic to recall
 * @param {Object} [options] - Options
 * @param {string} [options.format='json'] - Output format: 'json' (default) or 'markdown'
 * @returns {Promise<Object|string>} Decision history as JSON or Markdown
 *
 * @example
 * // LLM usage (default)
 * const data = await mama.recall('auth_strategy');
 * // → { topic, decisions: [...], edges: [...], meta: {...} }
 *
 * // Human display
 * const markdown = await mama.recall('auth_strategy', { format: 'markdown' });
 * // → "📋 Decision History: auth_strategy\n━━━━━━━━..."
 */
interface RecallEdgeRef {
  to_topic?: string;
  to_decision?: string;
  to_id?: string;
  from_topic?: string;
  from_decision?: string;
  from_id?: string;
  reason?: string | null;
  confidence?: number;
  created_at?: string | number;
}

interface RecallGraphResult {
  topic: string;
  supersedes_chain: Array<{
    id: string;
    decision: string;
    reasoning?: string | null;
    confidence?: number;
    outcome?: string | null;
    failure_reason?: string | null;
    created_at: number;
    updated_at?: number;
    superseded_by?: string | null;
    supersedes?: string | null;
  }>;
  semantic_edges: {
    refines: RecallEdgeRef[];
    refined_by: RecallEdgeRef[];
    contradicts: RecallEdgeRef[];
    contradicted_by: RecallEdgeRef[];
  };
  meta: {
    count: number;
    latest_id?: string;
    has_supersedes_chain: boolean;
    has_semantic_edges: boolean;
    semantic_edges_count: {
      refines: number;
      refined_by: number;
      contradicts: number;
      contradicted_by: number;
    };
  };
}

async function recall(
  topic: string,
  options: RecallOptions = {}
): Promise<string | RecallGraphResult> {
  if (!topic || typeof topic !== 'string') {
    throw new Error('mama.recall() requires topic (string)');
  }

  const { format = 'json' } = options;

  try {
    const decisions = await queryDecisionGraph(getAdapter(), topic);

    if (!decisions || decisions.length === 0) {
      if (format === 'markdown') {
        return `❌ No decisions found for topic: ${topic}`;
      }
      return {
        topic,
        supersedes_chain: [],
        semantic_edges: { refines: [], refined_by: [], contradicts: [], contradicted_by: [] },
        meta: {
          count: 0,
          has_supersedes_chain: false,
          has_semantic_edges: false,
          semantic_edges_count: { refines: 0, refined_by: 0, contradicts: 0, contradicted_by: 0 },
        },
      };
    }

    // Query semantic edges for all decisions
    const decisionIds = decisions.map((d: DecisionRecord) => d.id);
    const rawEdges = await querySemanticEdges(getAdapter(), decisionIds);
    const semanticEdges = {
      refines: rawEdges.refines || [],
      refined_by: rawEdges.refined_by || [],
      contradicts: rawEdges.contradicts || [],
      contradicted_by: rawEdges.contradicted_by || [],
    };

    // Markdown format (for human display)
    if (format === 'markdown') {
      // Pass semantic edges to formatter - transform to expected format
      const formatterEdges: SemanticEdges = {
        refines: semanticEdges.refines.map((e) => ({
          topic: e.topic || '',
          decision: e.decision || '',
        })),
        refined_by: semanticEdges.refined_by.map((e) => ({
          topic: e.topic || '',
          decision: e.decision || '',
        })),
        contradicts: semanticEdges.contradicts.map((e) => ({
          topic: e.topic || '',
          decision: e.decision || '',
        })),
        contradicted_by: semanticEdges.contradicted_by.map((e) => ({
          topic: e.topic || '',
          decision: e.decision || '',
        })),
      };
      return formatRecall(decisions, formatterEdges);
    }

    // JSON format (default - LLM-first)
    // Separate supersedes chain from semantic edges
    return {
      topic,
      supersedes_chain: decisions.map((d: DecisionRecord) => ({
        id: d.id,
        decision: d.decision,
        reasoning: d.reasoning,
        confidence: d.confidence,
        outcome: d.outcome,
        failure_reason: d.failure_reason,
        created_at: d.created_at,
        updated_at: d.updated_at,
        superseded_by: d.superseded_by,
        supersedes: d.supersedes,
      })),
      semantic_edges: {
        refines: semanticEdges.refines.map((e) => ({
          to_topic: e.topic,
          to_decision: e.decision,
          to_id: e.to_id,
          reason: e.reason,
          confidence: e.confidence,
          created_at: e.created_at,
        })),
        refined_by: semanticEdges.refined_by.map((e) => ({
          from_topic: e.topic,
          from_decision: e.decision,
          from_id: e.from_id,
          reason: e.reason,
          confidence: e.confidence,
          created_at: e.created_at,
        })),
        contradicts: semanticEdges.contradicts.map((e) => ({
          to_topic: e.topic,
          to_decision: e.decision,
          to_id: e.to_id,
          reason: e.reason,
          created_at: e.created_at,
        })),
        contradicted_by: semanticEdges.contradicted_by.map((e) => ({
          from_topic: e.topic,
          from_decision: e.decision,
          from_id: e.from_id,
          reason: e.reason,
          created_at: e.created_at,
        })),
      },
      meta: {
        count: decisions.length,
        latest_id: decisions[0]?.id,
        has_supersedes_chain: decisions.some((d) => d.supersedes),
        has_semantic_edges:
          semanticEdges.refines.length > 0 ||
          semanticEdges.refined_by.length > 0 ||
          semanticEdges.contradicts.length > 0 ||
          semanticEdges.contradicted_by.length > 0,
        semantic_edges_count: {
          refines: semanticEdges.refines.length,
          refined_by: semanticEdges.refined_by.length,
          contradicts: semanticEdges.contradicts.length,
          contradicted_by: semanticEdges.contradicted_by.length,
        },
      },
    };
  } catch (error: unknown) {
    throw new Error(
      `mama.recall() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update outcome of a decision
 *
 * Track whether a decision succeeded, failed, or partially worked
 * AC: Evolutionary Decision Memory - Learn from outcomes
 *
 * @param {string} decisionId - Decision ID to update
 * @param {Object} outcome - Outcome details
 * @param {string} outcome.outcome - 'SUCCESS', 'FAILED', or 'PARTIAL'
 * @param {string} [outcome.failure_reason] - Reason for failure (if FAILED)
 * @param {string} [outcome.limitation] - Limitation description (if PARTIAL)
 * @returns {Promise<void>}
 *
 * @example
 * await mama.updateOutcome('decision_auth_strategy_123456_abc', {
 *   outcome: 'FAILED',
 *   failure_reason: 'Missing token expiration handling'
 * });
 */
interface UpdateOutcomeParams {
  outcome: string;
  failure_reason?: string | null;
  limitation?: string | null;
}

async function updateOutcome(
  decisionId: string,
  { outcome, failure_reason, limitation }: UpdateOutcomeParams
): Promise<void> {
  if (!decisionId || typeof decisionId !== 'string') {
    throw new Error('mama.updateOutcome() requires decisionId (string)');
  }

  // AX Improvement: Be forgiving with case sensitivity
  const normalizedOutcome = outcome ? outcome.toUpperCase() : null;

  if (!normalizedOutcome || !['SUCCESS', 'FAILED', 'PARTIAL'].includes(normalizedOutcome)) {
    throw new Error('mama.updateOutcome() outcome must be "SUCCESS", "FAILED", or "PARTIAL"');
  }

  try {
    // Append-only: one judgment record carries the outcome change; the
    // maintained decisions projection columns move in the same transaction.
    await appendOutcomeAmendment(decisionId, {
      outcome: normalizedOutcome,
      failureReason: failure_reason || null,
      limitation: limitation || null,
      eventReason: `mama.updateOutcome(${decisionId})`,
    });

    return;
  } catch (error: unknown) {
    throw new Error(
      `mama.updateOutcome() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Expand search results with graph context (Phase 1 - Graph-Enhanced Retrieval)
 *
 * For each candidate decision:
 * 1. Add supersedes chain (evolution history)
 * 2. Add semantic edges (refines, contradicts)
 * 3. Deduplicate by ID
 * 4. Re-rank by relevance (primary candidates ranked higher)
 *
 * @param {Array} candidates - Initial search results from vector/keyword search
 * @returns {Promise<Array>} Graph-enhanced results with evolution context
 */
interface SearchCandidate {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string | null;
  confidence?: number;
  similarity?: number;
  created_at?: number | string;
  graph_source?: string;
  graph_rank?: number;
  related_to?: string | null;
  edge_reason?: string | null;
  recency_score?: number;
  recency_age_days?: number;
  final_score?: number;
  outcome?: string | null;
  failure_reason?: string | null;
  is_static?: number;
}

async function expandWithGraph(candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
  const graphEnhanced = new Map<string, SearchCandidate>(); // Use Map for deduplication by ID
  const primaryIds = new Set(candidates.map((c: SearchCandidate) => c.id)); // Track primary candidates

  // Process each candidate
  for (const candidate of candidates) {
    // Add primary candidate with higher rank
    if (!graphEnhanced.has(candidate.id)) {
      graphEnhanced.set(candidate.id, {
        ...candidate,
        graph_source: 'primary', // Mark as primary result
        graph_rank: 1.0, // Highest rank
      });
    }

    // 1. Add supersedes chain (evolution history)
    try {
      const chain = await queryDecisionGraph(getAdapter(), candidate.topic, candidate.id);
      for (const decision of chain) {
        if (!graphEnhanced.has(decision.id)) {
          graphEnhanced.set(decision.id, {
            ...decision,
            graph_source: 'supersedes_chain',
            graph_rank: 0.8, // Lower rank than primary
            similarity: (candidate.similarity ?? 0) * 0.9, // Inherit similarity, slightly reduced
            related_to: candidate.id, // Track relationship
          });
        }
      }
    } catch (error: unknown) {
      logWarn(
        `Failed to get supersedes chain for ${candidate.topic}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // 2. Add semantic edges (refines, contradicts, builds_on, debates, synthesizes)
    try {
      const rawEdges = (await querySemanticEdges(getAdapter(), [candidate.id])) || {};
      const edges = {
        refines: rawEdges.refines || [],
        refined_by: rawEdges.refined_by || [],
        contradicts: rawEdges.contradicts || [],
        contradicted_by: rawEdges.contradicted_by || [],
        builds_on: rawEdges.builds_on || [],
        built_on_by: rawEdges.built_on_by || [],
        debates: rawEdges.debates || [],
        debated_by: rawEdges.debated_by || [],
        synthesizes: rawEdges.synthesizes || [],
        synthesized_by: rawEdges.synthesized_by || [],
      };

      // Helper to add edge to graph
      const addEdge = (
        edge: SemanticEdgeItem,
        idField: 'to_id' | 'from_id',
        source: string,
        rank: number,
        simFactor: number
      ): void => {
        const id = edge[idField];
        if (!graphEnhanced.has(id)) {
          graphEnhanced.set(id, {
            id: id,
            topic: edge.topic,
            decision: edge.decision,
            confidence: edge.confidence,
            created_at: edge.created_at,
            graph_source: source,
            graph_rank: rank,
            similarity: (candidate.similarity ?? 0) * simFactor,
            related_to: candidate.id,
            edge_reason: edge.reason,
          });
        }
      };

      // Add refines edges
      for (const edge of edges.refines) {
        addEdge(edge, 'to_id', 'refines', 0.7, 0.85);
      }

      // Add refined_by edges
      for (const edge of edges.refined_by) {
        addEdge(edge, 'from_id', 'refined_by', 0.7, 0.85);
      }

      // Add contradicts edges (lower rank, but still relevant)
      for (const edge of edges.contradicts) {
        addEdge(edge, 'to_id', 'contradicts', 0.6, 0.8);
      }

      // Story 2.1: Add builds_on edges (high relevance - extending prior work)
      for (const edge of edges.builds_on) {
        addEdge(edge, 'to_id', 'builds_on', 0.75, 0.9);
      }

      // Add built_on_by edges (someone built on this decision)
      for (const edge of edges.built_on_by) {
        addEdge(edge, 'from_id', 'built_on_by', 0.75, 0.9);
      }

      // Add debates edges (alternative view)
      for (const edge of edges.debates) {
        addEdge(edge, 'to_id', 'debates', 0.65, 0.85);
      }

      // Add debated_by edges
      for (const edge of edges.debated_by) {
        addEdge(edge, 'from_id', 'debated_by', 0.65, 0.85);
      }

      // Add synthesizes edges (unified approach)
      for (const edge of edges.synthesizes) {
        addEdge(edge, 'to_id', 'synthesizes', 0.7, 0.88);
      }

      // Add synthesized_by edges
      for (const edge of edges.synthesized_by) {
        addEdge(edge, 'from_id', 'synthesized_by', 0.7, 0.88);
      }
    } catch (error: unknown) {
      logWarn(
        `Failed to get semantic edges for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 3. Convert Map to Array
  const allResults = Array.from(graphEnhanced.values());

  // 4. Sort: Interleave expanded results after their related primary
  // This ensures edge-connected decisions appear near their source
  const primaryResults = allResults
    .filter((r) => primaryIds.has(r.id))
    .sort((a, b) => {
      const scoreA = a.final_score || a.similarity || 0;
      const scoreB = b.final_score || b.similarity || 0;
      return scoreB - scoreA;
    });

  const expandedResults = allResults.filter((r) => !primaryIds.has(r.id));

  // Build final results: each primary followed by its related expanded results
  const results = [];
  for (const primary of primaryResults) {
    results.push(primary);

    // Find expanded results related to this primary
    const relatedExpanded = expandedResults.filter((e) => e.related_to === primary.id);

    // Sort related by graph_rank (higher first)
    relatedExpanded.sort((a, b) => (b.graph_rank || 0) - (a.graph_rank || 0));

    // Add related expanded results right after their primary
    results.push(...relatedExpanded);
  }

  // Add any orphaned expanded results (shouldn't happen, but safety net)
  const includedIds = new Set(results.map((r) => r.id));
  const orphaned = expandedResults.filter((e) => !includedIds.has(e.id));
  results.push(...orphaned);

  return results;
}

/**
 * Apply Gaussian Decay recency boosting (Elasticsearch-style)
 * Allows Claude to dynamically adjust search strategy based on results
 *
 * @param {Array} results - Search results with similarity scores
 * @param {Object} options - Recency boosting options
 * @returns {Array} Results with recency-boosted final scores
 */
interface RecencyBoostOptions {
  recencyWeight?: number;
  recencyScale?: number;
  recencyDecay?: number;
  disableRecency?: boolean;
}

function applyRecencyBoost(
  results: SearchCandidate[],
  options: RecencyBoostOptions = {}
): SearchCandidate[] {
  const {
    recencyWeight = 0.3,
    recencyScale = 7,
    recencyDecay = 0.5,
    disableRecency = false,
  } = options;

  if (disableRecency || recencyWeight === 0) {
    return results;
  }

  const now = Date.now(); // Current timestamp in milliseconds

  return results
    .map((r: SearchCandidate) => {
      // created_at is stored in milliseconds in the database
      const createdAt =
        typeof r.created_at === 'number' ? r.created_at : Date.parse(r.created_at || '0');
      const ageInDays = (now - createdAt) / (86400 * 1000);

      // Gaussian Decay: exp(-((age / scale)^2) / (2 * ln(1 / decay)))
      // At scale days: score = decay (e.g., 7 days = 50%)
      const gaussianDecay = Math.exp(
        -Math.pow(ageInDays / recencyScale, 2) / (2 * Math.log(1 / recencyDecay))
      );

      // Combine semantic similarity with recency
      const similarity = r.similarity ?? 0;
      const finalScore = similarity * (1 - recencyWeight) + gaussianDecay * recencyWeight;

      return {
        ...r,
        recency_score: gaussianDecay,
        recency_age_days: Math.round(ageInDays * 10) / 10,
        final_score: finalScore,
      };
    })
    .sort((a: SearchCandidate, b: SearchCandidate) => (b.final_score ?? 0) - (a.final_score ?? 0));
}

/**
 * Suggest relevant decisions based on user question
 *
 * DEFAULT: Returns JSON object with search results (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * Simplified: Direct vector search without LLM intent analysis
 * Works with short queries, long questions, Korean/English
 *
 * @param {string} userQuestion - User's question or intent
 * @param {Object} options - Search options
 * @param {string} [options.format='json'] - Output format: 'json' (default) or 'markdown'
 * @param {number} [options.limit=5] - Max results to return
 * @param {number} [options.threshold=0.6] - Minimum similarity (adaptive by query length)
 * @param {boolean} [options.useReranking=false] - Use LLM re-ranking (optional, slower)
 * @returns {Promise<Object|string|null>} Search results as JSON or Markdown, null if no results
 *
 * @example
 * // LLM usage (default)
 * const data = await mama.suggest('Why did we choose JWT?');
 * // → { query, results: [...], meta: {...} }
 *
 * // Human display
 * const markdown = await mama.suggest('mesh optimization', { format: 'markdown' });
 * // → "💡 MAMA found 3 related topics:\n1. ..."
 */
interface SuggestFunctionOptions extends SearchQualityOptions {
  format?: 'json' | 'markdown';
  limit?: number;
  useReranking?: boolean;
  /** Phase 3 Task 33: apply learned offline ranker rescoring. */
  rerankWithLearned?: boolean;
  recencyWeight?: number;
  recencyScale?: number;
  recencyDecay?: number;
  scopes?: Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>;
}

/** Phase 3 Task 33: learned-ranker meta attached to mama.suggest response. */
function buildRankerMeta(
  applied: boolean,
  modelId: string | null,
  skippedReason?: string
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    model_id: modelId,
    feature_set_version: SEARCH_RANKER_FEATURE_SET_VERSION,
    applied,
    mode: 'offline',
  };
  if (skippedReason) {
    meta.skipped_reason = skippedReason;
  }
  return meta;
}

function resultRecord(result: SearchRollupResult): Record<string, unknown> {
  if (
    typeof result.record === 'object' &&
    result.record !== null &&
    !Array.isArray(result.record)
  ) {
    return result.record as Record<string, unknown>;
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function confidenceValue(record: Record<string, unknown>, fallback: number): number {
  const numeric = numberOrNull(record.confidence);
  if (numeric !== null) {
    return numeric;
  }

  switch (record.confidence) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.3;
    default:
      return fallback;
  }
}

function mapRolledUpResult(result: SearchRollupResult) {
  const record = resultRecord(result);
  const retrievalDiagnostics = result.retrieval_diagnostics;
  const topic = stringOrNull(record.topic ?? record.title) ?? result.source_id;
  // For wiki_page leaves, prefer the markdown body (`content`) in `decision` so
  // downstream consumers see the meaningful body rather than the short title.
  // Decision/checkpoint records use their own fields (summary/decision).
  const isWikiPageLeaf = result.source_type === 'wiki_page';
  const decision = isWikiPageLeaf
    ? (stringOrNull(record.content ?? record.summary ?? record.decision ?? record.title) ??
      result.source_id)
    : (stringOrNull(record.summary ?? record.decision ?? record.title ?? record.content) ??
      result.source_id);
  const reasoning =
    stringOrNull(record.details ?? record.reasoning ?? record.status_reason ?? record.content) ??
    '';

  return {
    id: result.source_id,
    topic,
    decision,
    reasoning,
    confidence: confidenceValue(record, result.score),
    // Back-compat with pre-rollup consumers (swarm-mama-adapter tests,
    // older callers): similarity mirrors the retrieval score when we don't
    // have a separate similarity measure. retrieval_score remains the
    // authoritative field for Phase 3 code paths.
    similarity: result.score,
    retrieval_score: result.score,
    created_at: record.created_at ?? null,
    event_date: record.event_date ?? null,
    event_datetime: record.event_datetime ?? null,
    graph_source: retrievalDiagnostics?.graph_source ?? 'primary',
    graph_rank: 1,
    related_to: null,
    edge_reason: null,
    case_id: result.case_id,
    source_type: result.source_type,
    contributing_leaves: result.contributing_leaves ?? null,
    ...(result.contributing_leaf_diagnostics
      ? { contributing_leaf_diagnostics: result.contributing_leaf_diagnostics }
      : {}),
    ...(retrievalDiagnostics ? { retrieval_diagnostics: retrievalDiagnostics } : {}),
  };
}

async function save(params: SaveParams): Promise<SaveResult> {
  return saveInternal(params);
}

async function saveWithTrustedProvenance(
  params: SaveParams,
  options: TrustedMemoryWriteOptions
): Promise<SaveResult> {
  return saveInternal(params, options);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function suggest(userQuestion: string, options: SuggestFunctionOptions = {}): Promise<any> {
  if (!userQuestion || typeof userQuestion !== 'string') {
    throw new Error('mama.suggest() requires userQuestion (string)');
  }

  const {
    format = 'json',
    limit = 5,
    threshold,
    useReranking = false,
    rerankWithLearned = false,
    // Recency boosting parameters (Gaussian Decay - Elasticsearch style)
    recencyWeight = 0.3, // 0-1: How much to weight recency (0.3 = 70% semantic, 30% recency)
    recencyScale = 7, // Days until recency score drops to 50%
    recencyDecay = 0.5, // Score at scale point (0.5 = 50%)
    disableRecency = false, // Set true to disable recency boosting entirely
    strict,
    strictness,
    includeRelated,
    minLexicalSupport,
    diagnostics: includeDiagnostics,
  } = options;
  const normalizedSearchOptions = normalizeSearchQualityOptions({
    threshold,
    strict,
    strictness,
    disableRecency,
    includeRelated,
    topicPrefix: options.topicPrefix,
    minLexicalSupport,
    diagnostics: includeDiagnostics,
  });
  const memoryV2QualityContractRequested =
    threshold !== undefined ||
    strict !== undefined ||
    strictness !== undefined ||
    includeRelated !== undefined ||
    minLexicalSupport !== undefined ||
    includeDiagnostics === true ||
    options.topicPrefix !== undefined ||
    options.scopes !== undefined;
  const rerankPoolLimit = rerankWithLearned ? Math.max(limit * 4, limit + 5) : limit;

  try {
    const bundle = await recallMemory(userQuestion, {
      includeProfile: false,
      topicPrefix: options.topicPrefix,
      limit: rerankPoolLimit,
      threshold,
      strict,
      strictness,
      disableRecency,
      includeRelated,
      minLexicalSupport,
      diagnostics: includeDiagnostics,
      ...(options.scopes && { scopes: options.scopes }),
    });
    const diagnosticsByMemoryId = new Map(
      bundle.memories
        .filter((memory) => memory.retrieval_diagnostics)
        .map((memory) => [memory.id, memory.retrieval_diagnostics as SearchHitDiagnostics])
    );
    const rawFusedHits = (bundle as { fused_hits?: SearchRollupLeafHit[] }).fused_hits ?? [];
    const fusedHits = rawFusedHits.map((hit) => {
      if (hit.source_type !== 'decision') {
        return hit;
      }

      const recordDiagnostics =
        typeof hit.record === 'object' && hit.record !== null && !Array.isArray(hit.record)
          ? (hit.record as { retrieval_diagnostics?: SearchHitDiagnostics }).retrieval_diagnostics
          : undefined;
      const retrievalDiagnostics = diagnosticsByMemoryId.get(hit.source_id) ?? recordDiagnostics;
      if (!retrievalDiagnostics) {
        return hit;
      }

      const record =
        typeof hit.record === 'object' && hit.record !== null && !Array.isArray(hit.record)
          ? { ...hit.record, retrieval_diagnostics: retrievalDiagnostics }
          : hit.record;
      return {
        ...hit,
        record,
        retrieval_diagnostics: retrievalDiagnostics,
      };
    });
    const rolledUp =
      fusedHits.length > 0 ? rollUpSearchHits({ fusedHits, adapter: getAdapter() }) : [];
    const diagnosticsResponse =
      includeDiagnostics === true ? { diagnostics: bundle.search_meta.diagnostics ?? null } : {};

    // Phase 3 Task 33: compute base ranker meta once so every return path
    // (rolledUp, memories fallback, vector-search fallback) can attach it.
    // rerankWithLearned-driven rescoring still only applies to result arrays
    // that match the ranker's expected shape (id + source_type + case_id).
    const baseRankerMeta = useReranking
      ? buildRankerMeta(false, null, 'llm_reranking_requested')
      : rerankWithLearned
        ? null // marker: rescoring requested, actual meta set per-path after rescore
        : buildRankerMeta(false, null, 'feature_disabled');

    const applyLearnedRanker = <
      T extends {
        id: string;
        source_type?: string;
        case_id?: string | null;
        retrieval_score?: number | null;
        final_score?: number | null;
      },
    >(
      results: T[]
    ): { results: T[]; meta: Record<string, unknown> } => {
      if (baseRankerMeta !== null) {
        return { results, meta: baseRankerMeta };
      }
      // Phase 3 Task 33: the caller opted in via rerankWithLearned, but the
      // runtime `search_ranker_enabled` gate still has final say. This lets
      // operators disable the learned ranker globally during rollback without
      // touching any caller code.
      let runtimeEnabled = true;
      try {
        runtimeEnabled = isSearchRankerEnabled(getAdapter() as never);
      } catch (err) {
        logWarn(`[mama.suggest] isSearchRankerEnabled check failed: ${String(err)}`);
      }
      if (!runtimeEnabled) {
        return { results, meta: buildRankerMeta(false, null, 'feature_disabled') };
      }
      try {
        const rescored = rescoreSearchResults(getAdapter() as never, {
          query: userQuestion,
          results,
        });
        return {
          results: rescored.results as T[],
          meta: buildRankerMeta(
            rescored.skipped_reason === undefined,
            rescored.model_id,
            rescored.skipped_reason
          ),
        };
      } catch (err) {
        logWarn(`[mama.suggest] learned-ranker rescore failed: ${String(err)}`);
        return { results, meta: buildRankerMeta(false, null, 'rescore_error') };
      }
    };

    const summarizeGraphExpansion = <
      T extends {
        graph_source?: string | null;
      },
    >(
      rows: T[]
    ) => {
      const sources = {
        primary: 0,
        supersedes_chain: 0,
        refines: 0,
        refined_by: 0,
        contradicts: 0,
      };

      let expandedCount = 0;
      for (const row of rows) {
        const graphSource = row.graph_source ?? 'primary';
        if (graphSource === 'primary') {
          sources.primary += 1;
          continue;
        }

        expandedCount += 1;
        if (graphSource in sources) {
          const key = graphSource as keyof typeof sources;
          sources[key] += 1;
        }
      }

      return {
        total_results: rows.length,
        primary_count: sources.primary,
        expanded_count: expandedCount,
        sources,
      };
    };

    if (rolledUp.length > 0) {
      const filteredResults = rolledUp.slice(0, rerankPoolLimit);
      const { results: mappedResults, meta: rankerMeta } = applyLearnedRanker(
        filteredResults.map(mapRolledUpResult)
      );
      const limitedResults = mappedResults.slice(0, limit);

      if (format === 'markdown') {
        const context = limitedResults
          .map(
            (result, index) =>
              `${index + 1}. [${result.topic}] ${result.decision}\n   ${result.reasoning}`
          )
          .join('\n');
        return `🔍 Search method: memory_v2\n${context}`;
      }

      return {
        query: userQuestion,
        results: limitedResults,
        ...diagnosticsResponse,
        meta: {
          count: limitedResults.length,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(limitedResults),
          ranker: rankerMeta,
        },
      };
    }

    if (bundle.memories.length > 0) {
      // recallMemory uses RRF fusion — confidence is overwritten with the normalized
      // retrieval score (0-1 range, where 1.0 = best match in this result set).
      // The original stored confidence is lost after RRF normalization.
      // We capture the retrieval score separately so `similarity` reflects search
      // relevance while `confidence` is passed through as-is from the bundle.
      const filteredMemories = bundle.memories.slice(0, rerankPoolLimit);
      const baseRows = filteredMemories.map((memory) => ({
        id: memory.id,
        topic: memory.topic,
        decision: memory.summary,
        reasoning: memory.details,
        confidence: memory.confidence,
        // recallMemory currently normalizes fused retrieval rank into `confidence`.
        // Keep that value visible as retrieval_score, but do not pretend it is
        // semantic similarity; save-time warning logic keys off `similarity`.
        similarity: null,
        retrieval_score: memory.confidence ?? null,
        final_score: memory.confidence ?? null,
        created_at: memory.created_at,
        event_date: memory.event_date ?? null,
        event_datetime: memory.event_datetime ?? null,
        graph_source: memory.retrieval_diagnostics?.graph_source ?? 'primary',
        graph_rank: 1,
        related_to: null,
        edge_reason: null,
        case_id: null as string | null,
        source_type:
          memory.kind ??
          memory.source?.source_type ??
          (memory as { source_type?: string; type?: string }).source_type ??
          (memory as { type?: string }).type ??
          'decision',
        ...(memory.retrieval_diagnostics
          ? { retrieval_diagnostics: memory.retrieval_diagnostics }
          : {}),
      }));
      const { results: rankedRows, meta: rankerMeta } = applyLearnedRanker(baseRows);
      const limitedRows = rankedRows.slice(0, limit);

      if (format === 'markdown') {
        const context = limitedRows
          .map((row, index) => `${index + 1}. [${row.topic}] ${row.decision}\n   ${row.reasoning}`)
          .join('\n');
        return `🔍 Search method: memory_v2\n${context}`;
      }

      return {
        query: userQuestion,
        results: limitedRows,
        ...diagnosticsResponse,
        meta: {
          count: limitedRows.length,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(limitedRows),
          ranker: rankerMeta,
        },
      };
    }

    if (memoryV2QualityContractRequested) {
      const emptyRows: Array<{ id: string; source_type?: string; graph_source?: string | null }> =
        [];
      const { meta: rankerMeta } = applyLearnedRanker(emptyRows);

      if (format === 'markdown') {
        return '🔍 Search method: memory_v2\n';
      }

      return {
        query: userQuestion,
        results: emptyRows,
        ...diagnosticsResponse,
        meta: {
          count: 0,
          search_method: 'memory_v2',
          threshold: normalizedSearchOptions.threshold,
          recency_boost: disableRecency
            ? null
            : {
                weight: recencyWeight,
                scale: recencyScale,
                decay: recencyDecay,
              },
          graph_expansion: summarizeGraphExpansion(emptyRows),
          ranker: rankerMeta,
        },
      };
    }

    // 1. Try vector search first (if sqlite-vss is available)
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-explicit-any
    let results: any[] = [];
    let searchMethod = 'vector';

    try {
      // Generate query embedding
      const queryEmbedding = await generateEmbedding(userQuestion, 'query');

      // Adaptive threshold (shorter queries need higher confidence)
      const wordCount = userQuestion.split(/\s+/).length;
      const adaptiveThreshold = threshold !== undefined ? threshold : wordCount < 3 ? 0.7 : 0.6;

      // Vector search
      results = await vectorSearch(getAdapter(), queryEmbedding, rerankPoolLimit * 2, 0.5); // Get more candidates

      // Filter by adaptive threshold
      results = results.filter((r) => r.similarity >= adaptiveThreshold);

      // Stage 1.4: Temporal boost — detect time-related queries and boost matching results
      {
        const temporalPatterns = [
          // English
          /\b(yesterday|today|last\s+(?:week|month|year)|(\d+)\s+(?:days?|weeks?|months?)\s+ago)\b/i,
          /\b(before|after|since|until|during)\s+\w+/i,
          /\b(how\s+long|when\s+did|what\s+date|what\s+day)\b/i,
          // Korean
          /(?:어제|오늘|그제|지난\s*(?:주|달|해)|(\d+)\s*(?:일|주|달|개월)\s*(?:전|후|뒤))/,
          /(?:언제|얼마나|며칠|몇\s*(?:일|주|달|개월))/,
        ];
        const isTemporalQuery = temporalPatterns.some((p) => p.test(userQuestion));

        if (isTemporalQuery && results.length > 0) {
          // Boost results that contain date/time references in their content
          const datePatterns = [
            /\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
            /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i,
            /\d+\s*(?:일|월|년|주|시간|분)/,
            /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
            /(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)/,
          ];

          for (const result of results) {
            const content = `${result.decision || ''} ${result.reasoning || ''}`;
            const hasDateRef = datePatterns.some((p) => p.test(content));
            if (hasDateRef) {
              result.similarity = Math.min(1.0, (result.similarity || 0) + 0.1);
            }
          }
          results.sort(
            (a: { similarity?: number }, b: { similarity?: number }) =>
              (b.similarity || 0) - (a.similarity || 0)
          );
        }
      }

      // Stage 1.5: Apply recency boosting (Gaussian Decay)
      // Allows Claude to adjust search strategy (recent vs historical)
      if (results.length > 0 && !disableRecency) {
        results = applyRecencyBoost(results, {
          recencyWeight,
          recencyScale,
          recencyDecay,
          disableRecency,
        });
        searchMethod = 'vector+recency';
      }

      // Stage 1.7: FTS5 hybrid merge (Haiku Memory Layer)
      {
        try {
          const ftsResults = await fts5Search(getAdapter(), userQuestion, rerankPoolLimit * 2);
          if (ftsResults.length > 0) {
            // Normalize FTS5 ranks (BM25 returns negative values, closer to 0 = better)
            const maxRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)));
            const ftsMap = new Map(
              ftsResults.map((r) => [r.id, maxRank > 0 ? 1 - Math.abs(r.rank) / maxRank : 0.5])
            );

            // Tunable hybrid weights (env: MAMA_VECTOR_WEIGHT, MAMA_FTS5_WEIGHT)
            const vectorWeight = parseFloat(process.env.MAMA_VECTOR_WEIGHT || '0.6');
            const fts5Weight = parseFloat(process.env.MAMA_FTS5_WEIGHT || '0.4');

            // Merge: boost existing results that also matched FTS5
            for (const result of results) {
              const ftsScore = ftsMap.get(result.id);
              if (ftsScore !== undefined) {
                result.similarity = vectorWeight * result.similarity + fts5Weight * ftsScore;
                ftsMap.delete(result.id);
              }
            }

            // Add FTS5-only results (not in embedding results)
            for (const [id, ftsScore] of ftsMap) {
              const ftsResult = ftsResults.find((r) => r.id === id);
              if (ftsResult) {
                // Need to get full decision record
                const adapter = getAdapter();
                const stmt = adapter.prepare(
                  'SELECT * FROM decisions WHERE id = ? AND superseded_by IS NULL'
                );
                const decision = stmt.get(id) as DecisionRecord | undefined;
                if (decision) {
                  results.push({
                    ...decision,
                    similarity: fts5Weight * ftsScore, // Only FTS5 score component
                    graph_source: 'fts5',
                  });
                }
              }
            }

            // Re-sort by similarity
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            results.sort(
              (a: { similarity?: number }, b: { similarity?: number }) =>
                (b.similarity || 0) - (a.similarity || 0)
            );
            searchMethod = disableRecency ? 'vector+fts5' : 'vector+recency+fts5';
          }
        } catch {
          // FTS5 not available, continue with embedding-only results
        }
      }

      // Stage 2: Graph expansion (NEW - Phase 1)
      // Expand candidates with supersedes chain and semantic edges
      if (results.length > 0) {
        const graphEnhanced = await expandWithGraph(results);
        results = graphEnhanced;
        searchMethod = disableRecency ? 'vector+graph' : 'vector+recency+graph';
      }

      // Stage 2.5: is_static boost (after graph expansion to preserve sort order)
      for (const result of results) {
        if (result.is_static === 1) {
          result.final_score = Math.min(1.0, (result.final_score ?? result.similarity ?? 0) + 0.2);
        }
      }
      // Re-sort by final_score after is_static boost
      results.sort(
        (a, b) => (b.final_score ?? b.similarity ?? 0) - (a.final_score ?? a.similarity ?? 0)
      );
    } catch (vectorError: unknown) {
      // Fallback to keyword search if vector search unavailable
      logWarn(
        `Vector search failed: ${vectorError instanceof Error ? vectorError.message : String(vectorError)}, falling back to keyword search`
      );
      searchMethod = 'keyword';

      // Keyword search fallback
      const adapter = getAdapter();
      const keywords = userQuestion
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2); // Filter short words

      if (keywords.length === 0) {
        if (format === 'markdown') {
          return `💡 Hint: Please be more specific.\nExample: "Railway Volume settings" or "mesh parameter optimization"`;
        }
        return null; // JSON mode returns null for empty/invalid queries
      }

      // Build LIKE query for each keyword
      const likeConditions = keywords.map(() => '(topic LIKE ? OR decision LIKE ?)').join(' OR ');
      const likeParams = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);

      const stmt = adapter.prepare(`
        SELECT * FROM decisions
        WHERE ${likeConditions}
        AND superseded_by IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `);

      const rows = (await stmt.all(...likeParams, rerankPoolLimit)) as DecisionRecord[];
      results = rows.map((row: DecisionRecord) => ({
        ...row,
        similarity: 0.75, // Assign moderate similarity for keyword matches
      }));

      // Stage 2: Graph expansion for keyword results (Phase 1)
      if (results.length > 0) {
        const graphEnhanced = await expandWithGraph(results);
        results = graphEnhanced;
        searchMethod = 'keyword+graph';
      }
    }

    if (results.length === 0) {
      if (format === 'markdown') {
        const wordCount = userQuestion.split(/\s+/).length;
        if (wordCount < 3) {
          return `💡 Hint: Please be more specific.\nExample: "Why did we choose COMPLEX mesh structure?" or "What parameters are used for large layers?"`;
        }
      }
      return null;
    }

    // 5. Optional: LLM re-ranking (only if requested)
    if (useReranking) {
      results = await rerankWithLLM(userQuestion, results);
    }

    const rerankCandidateResults = results.slice(0, rerankPoolLimit);

    const vectorRows = rerankCandidateResults.map((r) => ({
      id: r.id,
      topic: r.topic,
      decision: r.decision,
      reasoning: r.reasoning,
      confidence: r.confidence,
      similarity: r.similarity,
      created_at: r.created_at,
      event_date: r.event_date ?? null,
      event_datetime: r.event_datetime ?? null,
      // Recency metadata (NEW - Gaussian Decay)
      recency_score: r.recency_score,
      recency_age_days: r.recency_age_days,
      final_score: r.final_score || r.similarity, // Falls back to similarity if no recency
      retrieval_score: r.similarity ?? null,
      // Graph metadata (NEW - Phase 1)
      graph_source: r.graph_source || 'primary',
      graph_rank: r.graph_rank || 1.0,
      related_to: r.related_to || null,
      edge_reason: r.edge_reason || null,
      case_id: null as string | null,
      source_type: 'decision',
    }));
    const { results: rankedVectorRows, meta: rankerMeta } = applyLearnedRanker(vectorRows);
    const finalResults = rankedVectorRows.slice(0, limit);

    // Markdown format (for human display)
    if (format === 'markdown') {
      const context = formatContext(finalResults, { maxTokens: 500 });

      // Add graph expansion summary if applicable
      let graphSummary = '';
      if (searchMethod.includes('graph')) {
        const primaryCount = finalResults.filter((r) => r.graph_source === 'primary').length;
        const expandedCount = finalResults.filter((r) => r.graph_source !== 'primary').length;

        graphSummary = `\n📊 Graph expansion: ${primaryCount} primary + ${expandedCount} related (supersedes/refines/contradicts)\n`;
      }

      return `🔍 Search method: ${searchMethod}${graphSummary}\n${context}`;
    }

    // Calculate graph expansion stats
    const graphStats = {
      total_results: finalResults.length,
      primary_count: finalResults.filter((r) => r.graph_source === 'primary').length,
      expanded_count: finalResults.filter((r) => r.graph_source !== 'primary').length,
      sources: {
        primary: finalResults.filter((r) => r.graph_source === 'primary').length,
        supersedes_chain: finalResults.filter((r) => r.graph_source === 'supersedes_chain').length,
        refines: finalResults.filter((r) => r.graph_source === 'refines').length,
        refined_by: finalResults.filter((r) => r.graph_source === 'refined_by').length,
        contradicts: finalResults.filter((r) => r.graph_source === 'contradicts').length,
      },
    };

    return {
      query: userQuestion,
      results: finalResults,
      meta: {
        count: finalResults.length,
        search_method: searchMethod,
        threshold: threshold || 'adaptive',
        // Recency boosting config (NEW - Gaussian Decay)
        recency_boost: disableRecency
          ? null
          : {
              weight: recencyWeight,
              scale: recencyScale,
              decay: recencyDecay,
            },
        // Graph expansion stats (NEW - Phase 1)
        graph_expansion: searchMethod.includes('graph') ? graphStats : null,
        ranker: rankerMeta,
      },
    };
  } catch (error: unknown) {
    // Graceful degradation
    logWarn(`mama.suggest() failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Re-rank search results using local LLM (optional enhancement)
 *
 * @param {string} userQuestion - User's question
 * @param {Array} results - Vector search results
 * @returns {Promise<Array>} Re-ranked results
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rerankWithLLM(userQuestion: string, results: any[]): Promise<any[]> {
  try {
    const prompt = `User asked: "${userQuestion}"

Found decisions (ranked by vector similarity):
${results.map((r: SearchCandidate, i: number) => `${i + 1}. [${(r.similarity ?? 0).toFixed(3)}] ${r.topic}: ${r.decision.substring(0, 60)}...`).join('\n')}

Re-rank these by actual relevance to the user's intent (not just keyword similarity).
Return JSON: { "ranking": [index1, index2, ...] } (0-based indices)

Example: { "ranking": [2, 0, 4, 1, 3] } means 3rd is most relevant, then 1st, then 5th...`;

    const response = await generate(prompt, {
      format: 'json',
      temperature: 0.3,
      max_tokens: 100,
      timeout: 3000,
    });

    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    // Reorder results based on LLM ranking
    return parsed.ranking.map((idx: number) => results[idx]).filter(Boolean);
  } catch (error: unknown) {
    logWarn(
      `Re-ranking failed: ${error instanceof Error ? error.message : String(error)}, using vector ranking`
    );
    return results; // Fallback to vector ranking
  }
}

/**
 * List recent decisions (all topics, chronological)
 *
 * DEFAULT: Returns JSON array with recent decisions (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * @param {Object} [options] - Options
 * @param {number} [options.limit=10] - Max results
 * @param {string} [options.format='json'] - Output format
 * @returns {Promise<Array|string>} Recent decisions
 */
interface ListDecisionsOptions {
  limit?: number;
  format?: 'json' | 'markdown';
  scopes?: Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>;
  /**
   * Exact ledger read: every decision whose topic starts with this string, superseded rows
   * included (they are the earlier rounds of the same item). `%` and `_` are literal.
   * This is a lookup, not a search - `suggest({topicPrefix})` treats the prefix as a soft
   * signal and was measured returning 5 of 12 rows plus one from another item.
   */
  topicPrefix?: string;
}

/** `LIKE ? ESCAPE '\\'` pattern that matches topics starting with `prefix`, metacharacters literal. */
function topicPrefixLikePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

async function listDecisions(
  options: ListDecisionsOptions = {}
): Promise<DecisionRecord[] | string> {
  const { limit = 10, format = 'json' } = options;

  try {
    const adapter = getAdapter();
    let decisions;
    const topicPrefix = typeof options.topicPrefix === 'string' ? options.topicPrefix.trim() : '';
    // A prefix read keeps superseded rows: they are the item's earlier rounds.
    const currency = topicPrefix ? '' : 'AND d.superseded_by IS NULL';
    const prefixClause = topicPrefix ? "AND d.topic LIKE ? ESCAPE '\\'" : '';
    const prefixParams = topicPrefix ? [topicPrefixLikePattern(topicPrefix)] : [];

    if (options.scopes && options.scopes.length > 0) {
      // Scope-filtered query: JOIN memory_scope_bindings + memory_scopes
      const scopeIds = await Promise.all(
        options.scopes.map((s) => ensureMemoryScopeInAdapter(adapter, s.kind, s.id))
      );
      const placeholders = scopeIds.map(() => '?').join(', ');
      const stmt = adapter.prepare(`
        SELECT DISTINCT d.* FROM decisions d
        JOIN memory_scope_bindings msb ON msb.memory_id = d.id
        WHERE msb.scope_id IN (${placeholders})
          ${currency}
          ${prefixClause}
        ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        LIMIT ?
      `);
      decisions = await stmt.all(...scopeIds, ...prefixParams, limit);
    } else {
      const stmt = adapter.prepare(`
        SELECT d.* FROM decisions d
        WHERE 1 = 1
          ${currency}
          ${prefixClause}
        ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        LIMIT ?
      `);
      decisions = await stmt.all(...prefixParams, limit);
    }

    if (format === 'markdown') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return formatList(decisions as any[]);
    }

    return decisions as DecisionRecord[];
  } catch (error: unknown) {
    throw new Error(
      `mama.listDecisions() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Save current session checkpoint (New Feature: Session Continuity)
 *
 * @param {string} summary - Summary of current session state
 * @param {Array<string>} openFiles - List of currently open files
 * @param {string} nextSteps - Next steps to be taken
 * @returns {Promise<number>} Checkpoint ID
 */
async function saveCheckpoint(
  summary: string,
  openFiles: string[] = [],
  nextSteps: string = '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recentConversation: any[] = []
): Promise<number | bigint> {
  if (!summary) {
    throw new Error('Summary is required for checkpoint');
  }

  try {
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      INSERT INTO checkpoints (timestamp, summary, open_files, next_steps, recent_conversation, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(
      Date.now(),
      summary,
      JSON.stringify(openFiles),
      nextSteps,
      JSON.stringify(recentConversation || [])
    );

    return result.lastInsertRowid;
  } catch (error: unknown) {
    throw new Error(
      `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Load latest active checkpoint (New Feature: Session Continuity)
 *
 * @returns {Promise<Object|null>} Latest checkpoint or null
 */
interface ConversationMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

interface CheckpointRow {
  id?: number;
  timestamp?: number;
  summary?: string;
  open_files?: string | string[];
  next_steps?: string;
  recent_conversation?: string | ConversationMessage[];
  status?: string;
}

async function loadCheckpoint(): Promise<CheckpointRow | null> {
  try {
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT * FROM checkpoints
      WHERE status = 'active'
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const checkpoint = stmt.get() as CheckpointRow | undefined;

    if (checkpoint) {
      try {
        checkpoint.open_files =
          typeof checkpoint.open_files === 'string'
            ? JSON.parse(checkpoint.open_files)
            : checkpoint.open_files || [];
      } catch {
        checkpoint.open_files = [];
      }

      try {
        checkpoint.recent_conversation =
          typeof checkpoint.recent_conversation === 'string'
            ? JSON.parse(checkpoint.recent_conversation || '[]')
            : checkpoint.recent_conversation || [];
      } catch {
        checkpoint.recent_conversation = [];
      }
    }

    return checkpoint || null;
  } catch (error: unknown) {
    throw new Error(
      `Failed to load checkpoint: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * List recent checkpoints (New Feature: Session Continuity)
 *
 * @param {number} limit - Max number of checkpoints to return
 * @returns {Promise<Array>} Recent checkpoints
 */
async function listCheckpoints(limit: number = 10): Promise<CheckpointRow[]> {
  try {
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT * FROM checkpoints
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const checkpoints = stmt.all(limit) as CheckpointRow[];

    return checkpoints.map((c: CheckpointRow) => {
      try {
        c.open_files =
          typeof c.open_files === 'string' ? JSON.parse(c.open_files) : c.open_files || [];
      } catch {
        c.open_files = [];
      }
      try {
        c.recent_conversation =
          typeof c.recent_conversation === 'string'
            ? JSON.parse(c.recent_conversation)
            : c.recent_conversation || [];
      } catch {
        c.recent_conversation = [];
      }
      return c;
    });
  } catch (error: unknown) {
    throw new Error(
      `Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Public write boundary for audit findings. The store writer takes the adapter
 * from its caller; this edge resolves the ambient adapter so the
 * MAMAApiInterface signature stays (input) => Promise<string>.
 */
async function createAuditFinding(
  input: Parameters<typeof createAuditFindingInAdapter>[1]
): Promise<string> {
  await initDB();
  return createAuditFindingInAdapter(getAdapter(), input);
}

/**
 * MAMA Public API
 *
 * Simple, clean interface for Claude to interact with MAMA
 * Hides complex implementation details (embeddings, vector search, graph queries)
 *
 * Key Principles:
 * 1. Simple API First - No complex configuration
 * 2. Transparent Process - Each step is visible
 * 3. Claude-First Design - Claude decides what to save
 * 4. Non-Intrusive - Silent failures for helpers (suggest)
 */
// ════════════════════════════════════════════════════════════════════════════
// MAMA API - Simplified to 4 MCP tools (2025-11-25)
//
// Design: LLM can infer decision evolution from time-ordered search results
// More tools = more constraints = less LLM flexibility
//
// Retained internal functions for future use, but MCP exposes only:
//   save, search, update, load_checkpoint
// ════════════════════════════════════════════════════════════════════════════
const mama = {
  // Core functions (used by 4 MCP tools)
  save,
  saveWithTrustedProvenance,
  suggest,
  saveMemory,
  saveMemoryWithTrustedProvenance,
  recallMemory,
  list: listDecisions,
  listCheckpoints,
  updateOutcome,
  buildProfile,
  ingestMemory,
  ingestWithTrustedProvenance,
  ingestConversation,
  ingestConversationWithTrustedProvenance,
  evolveMemory,
  buildMemoryBootstrap,
  createAuditAck,
  recordMemoryAudit,
  upsertChannelSummary,
  getChannelSummary,
  listAuditFindings: listOpenAuditFindings,
  listOpenAuditFindings,
  createAuditFinding,
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
  listMemoryEventsForMemory,
  listRecentMemoryEvents,
  beginModelRun,
  beginModelRunInAdapter,
  commitModelRun,
  commitModelRunInAdapter,
  failModelRun,
  failModelRunInAdapter,
  getModelRun,
  getModelRunInAdapter,
  appendToolTrace,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
  saveCheckpoint,
  loadCheckpoint,
  // Legacy functions (retained for internal use, not exposed via MCP)
  recall,
  expandWithGraph,
};

// Named exports for ESM consumers
export {
  save,
  saveWithTrustedProvenance,
  suggest,
  saveMemory,
  saveMemoryWithTrustedProvenance,
  recallMemory,
  listDecisions as list,
  listCheckpoints,
  updateOutcome,
  buildProfile,
  ingestMemory,
  ingestWithTrustedProvenance,
  ingestConversation,
  ingestConversationWithTrustedProvenance,
  evolveMemory,
  buildMemoryBootstrap,
  createAuditAck,
  recordMemoryAudit,
  upsertChannelSummary,
  getChannelSummary,
  listOpenAuditFindings,
  createAuditFinding,
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
  listMemoryEventsForMemory,
  listRecentMemoryEvents,
  beginModelRun,
  beginModelRunInAdapter,
  commitModelRun,
  commitModelRunInAdapter,
  failModelRun,
  failModelRunInAdapter,
  getModelRun,
  getModelRunInAdapter,
  appendToolTrace,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
  saveCheckpoint,
  loadCheckpoint,
  recall,
  expandWithGraph,
};

// Default export for backward compatibility
export default mama;

// CommonJS compatibility - allows require('@jungjaehoon/mama-core/mama-api').save()
if (typeof module !== 'undefined' && module.exports) {
  module.exports = mama;
  module.exports.default = mama;
}
