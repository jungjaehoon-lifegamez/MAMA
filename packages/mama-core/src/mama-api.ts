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
  expandWithGraphInAdapter,
  listCheckpointsInAdapter,
  listDecisionsInAdapter,
  suggestInAdapter,
  loadCheckpointInAdapter,
  saveCheckpointInAdapter,
  updateOutcomeInAdapter,
  type CheckpointRow,
  type ListDecisionsOptions,
  type SearchCandidate,
  type SuggestFunctionOptions,
  type UpdateOutcomeParams,
} from './memory/api.js';
import {
  DecisionRecord,
  initDB,
  getAdapter,
  type DatabaseAdapter,
  type DatabaseInstance,
} from './db-manager.js';
import { queryDecisionGraph, querySemanticEdges } from './knowledge/graph-query.js';
import { formatRecall, SemanticEdges } from './decision-formatter.js';
import { logProgress, logComplete, logSearching } from './progress-indicator.js';
import { error as logError } from './debug-logger.js';
import {
  saveMemory as saveMemoryInAdapter,
  saveLegacyMemory as saveLegacyMemoryInAdapter,
  recallMemory as recallMemoryInAdapter,
  buildProfile as buildProfileInAdapter,
  ingestMemory as ingestMemoryInAdapter,
  ingestConversation as ingestConversationInAdapter,
} from './memory/api.js';
import {
  createAuditFinding as createAuditFindingInAdapter,
  listOpenAuditFindings as listOpenAuditFindingsInAdapter,
} from './memory/finding-store.js';
import {
  listMemoryEventsForMemory as listMemoryEventsForMemoryInAdapter,
  listRecentMemoryEvents as listRecentMemoryEventsInAdapter,
} from './memory/event-store.js';
import {
  getMemoryProvenance as getMemoryProvenanceInAdapter,
  listMemoriesByEnvelopeHash as listMemoriesByEnvelopeHashInAdapter,
  listMemoriesByGatewayCallId as listMemoriesByGatewayCallIdInAdapter,
  listMemoriesByModelRunId as listMemoriesByModelRunIdInAdapter,
} from './memory/provenance-query.js';
import {
  beginModelRun as beginModelRunInAdapter,
  commitModelRun as commitModelRunInAdapter,
  failModelRun as failModelRunInAdapter,
  getModelRun as getModelRunInAdapter,
  listModelRunNativeInputs as listModelRunNativeInputsInAdapter,
} from './runtime/model-run-store.js';
import {
  appendToolTrace as appendToolTraceInAdapter,
  listToolTracesForRun as listToolTracesForRunInAdapter,
  listToolTraces as listToolTracesInAdapter,
  readToolTrace as readToolTraceInAdapter,
} from './runtime/tool-trace-store.js';
import { type SearchHitDiagnostics } from './knowledge/search-quality.js';
import type { RecordLink } from './memory/judgment-types.js';
import {
  appendDecisionLink,
  readDecisionWithEdges,
  type DecisionLinkInput,
  type DecisionWithEdges,
} from './memory/decision-links.js';
import type { LinkReceipt } from './knowledge/links.js';

// ════════════════════════════════════════════════════════════════════════════
// Type Definitions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parameters for mama.save()
 */
/** Relations a save names; replacing is `replaces`, which also moves the replaced record's state. */
const SAVE_LINK_RELATIONS: readonly RecordLink['relation'][] = [
  'builds_on',
  'refines',
  'contradicts',
  'debates',
  'synthesizes',
  'mentions',
];

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
  scopes?: Array<{ kind: string; id: string }>;
  item?: string | null;
  actors?: Array<{ person: string; role: string }>;
  /** ISO 8601 date string for when the event actually occurred (e.g. "2023-01-15") */
  event_date?: string | null;
  /** Decisions this one relates to, each with the relation and the reason the caller judged. */
  links?: Array<{ id: string; relation: RecordLink['relation']; reason: string }>;
  /** Decisions this one replaces, each with the reason. */
  replaces?: Array<{ id: string; reason: string }>;
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
  };
}

/**
 * Suggest options for mama.suggest()
 */
export interface SuggestOptions {
  limit?: number;
  threshold?: number;
  format?: 'full' | 'teaser' | 'brief' | 'markdown';
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

// Prevents spam by tracking warned topics per session

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
  adapter: DatabaseInstance,
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
    links,
    replaces,
  }: SaveParams
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

  // Reasoning text is evidence, not authority: a relation is written only when the caller names
  // its target and reason (`links`, `replaces`). Parsing ids out of prose fabricated edges.
  logProgress(`Saving decision: ${topic.substring(0, 30)}...`);
  const { id: decisionId } = await saveLegacyMemoryInAdapter(
    adapter,
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
      ...(links?.length
        ? {
            links: links.map((link) => {
              if (typeof link.reason !== 'string' || link.reason.trim() === '') {
                throw new Error('mama.save() each link needs a reason');
              }
              if (!SAVE_LINK_RELATIONS.includes(link.relation)) {
                throw new Error(
                  `mama.save() link relation must be one of ${SAVE_LINK_RELATIONS.join(', ')}; a replaced decision goes in replaces`
                );
              }
              return {
                relation: link.relation,
                target: { kind: 'memory' as const, id: link.id },
                attrs: { reason: link.reason.trim() },
              };
            }),
          }
        : {}),
      ...(replaces?.length
        ? {
            replaces: replaces.map((replacement) => {
              if (typeof replacement.reason !== 'string' || replacement.reason.trim() === '') {
                throw new Error('mama.save() each replaced decision needs a reason');
              }
              return { id: replacement.id, reason: replacement.reason.trim() };
            }),
          }
        : {}),
    },
    {
      userInvolvement: _userInvolvement,
      outcome: dbOutcome,
      failureReason: failure_reason ?? null,
      limitation: limitation ?? null,
      isStatic: is_static,
    }
  );
  logComplete(`Decision saved: ${decisionId.substring(0, 20)}...`);

  // ════════════════════════════════════════════════════════════════════════════
  // Story 1.1: Auto-Search on Save
  // Story 1.2: Response Enhancement
  // ════════════════════════════════════════════════════════════════════════════
  let similar_decisions: SimilarDecision[] = [];
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
        const searchResults = await suggestInAdapter(adapter, topic, {
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

          // There was a "High similarity (N%)" warning here, keyed on a number
          // that measured rank rather than likeness -- it fired on every save
          // that had a second result at all, whatever that result said. Nothing
          // in either retrieval path now produces a similarity for this query
          // shape, so the warning has no measure to stand on and is gone. The
          // hint below states what IS true: how many related rows came back.

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
        reasoning_graph = await _getReasoningGraphInfo(adapter, topic, decisionId);
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
    ...(collaboration_hint && { collaboration_hint }),
    ...(reasoning_graph && { reasoning_graph }),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Story 1.2: Helper functions for Response Enhancement
// ════════════════════════════════════════════════════════════════════════════

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

  return `Found ${count} related decision(s). If the new decision replaces, extends, debates or combines one of them, link it with the reason you judged: replaces [{id, reason}] or links [{id, relation, reason}] when saving, or a link afterwards. Nothing is linked for you.`;
}

/**
 * Get reasoning graph info for a topic
 * @param {string} topic - Topic to query
 * @param {string} currentId - Current decision ID
 * @returns {Object} Reasoning graph info
 */
async function _getReasoningGraphInfo(
  adapter: DatabaseAdapter,
  topic: string,
  currentId: string
): Promise<ReasoningGraphInfo> {
  try {
    const chain = await queryDecisionGraph(adapter, topic);

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

async function recallInAdapter(
  adapter: DatabaseAdapter,
  topic: string,
  options: RecallOptions = {}
): Promise<string | RecallGraphResult> {
  if (!topic || typeof topic !== 'string') {
    throw new Error('mama.recall() requires topic (string)');
  }

  const { format = 'json' } = options;

  try {
    const decisions = await queryDecisionGraph(adapter, topic);

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
    const rawEdges = await querySemanticEdges(adapter, decisionIds);
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

async function save(params: SaveParams): Promise<SaveResult> {
  await initDB();
  return saveInternal(getAdapter(), params);
}

// Facade boundary: the ambient handle is resolved only here so the public
// (input)-only signatures stay intact. Instance-owning callers use
// createMamaApi(adapter) instead.
async function suggest(
  userQuestion: string,
  options: SuggestFunctionOptions = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  await initDB();
  return suggestInAdapter(getAdapter(), userQuestion, options);
}

async function recall(
  topic: string,
  options: RecallOptions = {}
): Promise<string | RecallGraphResult> {
  await initDB();
  return recallInAdapter(getAdapter(), topic, options);
}

async function expandWithGraph(candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
  await initDB();
  return expandWithGraphInAdapter(getAdapter(), candidates);
}

async function updateOutcome(decisionId: string, outcome: UpdateOutcomeParams): Promise<void> {
  await initDB();
  return updateOutcomeInAdapter(getAdapter(), decisionId, outcome);
}

/** Link one decision to another, or correct a link, with the reason the caller judged. */
async function link(input: DecisionLinkInput): Promise<LinkReceipt> {
  await initDB();
  return appendDecisionLink(getAdapter(), input);
}

/** One decision with every edge in and out, each with its reason and who wrote it. */
async function getDecision(id: string): Promise<DecisionWithEdges | null> {
  await initDB();
  return readDecisionWithEdges(getAdapter(), id);
}

async function listDecisions(
  options: ListDecisionsOptions = {}
): Promise<DecisionRecord[] | string> {
  await initDB();
  return listDecisionsInAdapter(getAdapter(), options);
}

async function saveCheckpoint(
  summary: string,
  openFiles: string[] = [],
  nextSteps: string = '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recentConversation: any[] = []
): Promise<number | bigint> {
  await initDB();
  return saveCheckpointInAdapter(getAdapter(), summary, openFiles, nextSteps, recentConversation);
}

async function loadCheckpoint(): Promise<CheckpointRow | null> {
  await initDB();
  return loadCheckpointInAdapter(getAdapter());
}

async function listCheckpoints(limit: number = 10): Promise<CheckpointRow[]> {
  await initDB();
  return listCheckpointsInAdapter(getAdapter(), limit);
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

// Facade wrappers: the stores below take an explicit adapter as their first
// argument; the `mama` surface keeps its published (input) signatures and
// resolves the ambient adapter at this boundary instead.
async function listOpenAuditFindings(): Promise<
  Awaited<ReturnType<typeof listOpenAuditFindingsInAdapter>>
> {
  await initDB();
  return listOpenAuditFindingsInAdapter(getAdapter());
}

async function listMemoryEventsForMemory(
  memoryId: string
): Promise<Awaited<ReturnType<typeof listMemoryEventsForMemoryInAdapter>>> {
  await initDB();
  return listMemoryEventsForMemoryInAdapter(getAdapter(), memoryId);
}

async function listRecentMemoryEvents(
  limit?: number
): Promise<Awaited<ReturnType<typeof listRecentMemoryEventsInAdapter>>> {
  await initDB();
  return listRecentMemoryEventsInAdapter(getAdapter(), limit);
}

async function getMemoryProvenance(
  memoryId: string,
  options?: Parameters<typeof getMemoryProvenanceInAdapter>[2]
): Promise<Awaited<ReturnType<typeof getMemoryProvenanceInAdapter>>> {
  await initDB();
  return getMemoryProvenanceInAdapter(getAdapter(), memoryId, options);
}

async function listMemoriesByEnvelopeHash(
  envelopeHash: string,
  options?: Parameters<typeof listMemoriesByEnvelopeHashInAdapter>[2]
): Promise<Awaited<ReturnType<typeof listMemoriesByEnvelopeHashInAdapter>>> {
  await initDB();
  return listMemoriesByEnvelopeHashInAdapter(getAdapter(), envelopeHash, options);
}

async function listMemoriesByGatewayCallId(
  gatewayCallId: string,
  options?: Parameters<typeof listMemoriesByGatewayCallIdInAdapter>[2]
): Promise<Awaited<ReturnType<typeof listMemoriesByGatewayCallIdInAdapter>>> {
  await initDB();
  return listMemoriesByGatewayCallIdInAdapter(getAdapter(), gatewayCallId, options);
}

async function listMemoriesByModelRunId(
  modelRunId: string,
  options?: Parameters<typeof listMemoriesByModelRunIdInAdapter>[2]
): Promise<Awaited<ReturnType<typeof listMemoriesByModelRunIdInAdapter>>> {
  await initDB();
  return listMemoriesByModelRunIdInAdapter(getAdapter(), modelRunId, options);
}

// memory/api.ts is adapter-first; the `mama` surface keeps its published
// (input) signatures and resolves the ambient adapter at this boundary.
async function saveMemory(
  input: Parameters<typeof saveMemoryInAdapter>[1]
): Promise<Awaited<ReturnType<typeof saveMemoryInAdapter>>> {
  await initDB();
  return saveMemoryInAdapter(getAdapter(), input);
}

async function recallMemory(
  query: string,
  options?: Parameters<typeof recallMemoryInAdapter>[2]
): Promise<Awaited<ReturnType<typeof recallMemoryInAdapter>>> {
  await initDB();
  return recallMemoryInAdapter(getAdapter(), query, options);
}

async function buildProfile(
  scopes: Parameters<typeof buildProfileInAdapter>[1]
): Promise<Awaited<ReturnType<typeof buildProfileInAdapter>>> {
  await initDB();
  return buildProfileInAdapter(getAdapter(), scopes);
}

async function ingestMemory(
  input: Parameters<typeof ingestMemoryInAdapter>[1]
): Promise<Awaited<ReturnType<typeof ingestMemoryInAdapter>>> {
  await initDB();
  return ingestMemoryInAdapter(getAdapter(), input);
}

async function ingestConversation(
  input: Parameters<typeof ingestConversationInAdapter>[1]
): Promise<Awaited<ReturnType<typeof ingestConversationInAdapter>>> {
  await initDB();
  return ingestConversationInAdapter(getAdapter(), input);
}

async function beginModelRun(
  input: Parameters<typeof beginModelRunInAdapter>[1]
): Promise<Awaited<ReturnType<typeof beginModelRunInAdapter>>> {
  await initDB();
  return beginModelRunInAdapter(getAdapter(), input);
}

async function commitModelRun(
  modelRunId: string,
  summary?: string,
  tokenCount?: number
): Promise<Awaited<ReturnType<typeof commitModelRunInAdapter>>> {
  await initDB();
  return commitModelRunInAdapter(getAdapter(), modelRunId, summary, tokenCount);
}

async function failModelRun(
  modelRunId: string,
  errorSummary: string,
  tokenCount?: number
): Promise<Awaited<ReturnType<typeof failModelRunInAdapter>>> {
  await initDB();
  return failModelRunInAdapter(getAdapter(), modelRunId, errorSummary, tokenCount);
}

async function getModelRun(
  modelRunId: string
): Promise<Awaited<ReturnType<typeof getModelRunInAdapter>>> {
  await initDB();
  return getModelRunInAdapter(getAdapter(), modelRunId);
}

async function appendToolTrace(
  input: Parameters<typeof appendToolTraceInAdapter>[1]
): Promise<Awaited<ReturnType<typeof appendToolTraceInAdapter>>> {
  await initDB();
  return appendToolTraceInAdapter(getAdapter(), input);
}

async function listToolTracesForRun(
  modelRunId: string
): Promise<Awaited<ReturnType<typeof listToolTracesForRunInAdapter>>> {
  await initDB();
  return listToolTracesForRunInAdapter(getAdapter(), modelRunId);
}

async function listToolTraces(
  input: Parameters<typeof listToolTracesInAdapter>[1]
): Promise<Awaited<ReturnType<typeof listToolTracesInAdapter>>> {
  await initDB();
  return listToolTracesInAdapter(getAdapter(), input);
}

async function readToolTrace(
  traceId: string,
  scope: Parameters<typeof readToolTraceInAdapter>[2]
): Promise<Awaited<ReturnType<typeof readToolTraceInAdapter>>> {
  await initDB();
  return readToolTraceInAdapter(getAdapter(), traceId, scope);
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
/**
 * Instance-bound MAMA API factory.
 *
 * Same member surface as the ambient `mama` object, but every call reads and
 * writes through the adapter the owner hands in — no module-global handle is
 * consulted. Products that own their database lifetime (openDatabase) bind
 * once at boot and pass this object down; the ambient `mama` export remains
 * the compatibility boundary for callers without an instance.
 */
export function createMamaApi(adapter: DatabaseInstance) {
  return {
    save: (params: SaveParams) => saveInternal(adapter, params),
    suggest: (userQuestion: string, options?: SuggestFunctionOptions) =>
      suggestInAdapter(adapter, userQuestion, options),
    saveMemory: (input: Parameters<typeof saveMemoryInAdapter>[1]) =>
      saveMemoryInAdapter(adapter, input),
    recallMemory: (
      query: Parameters<typeof recallMemoryInAdapter>[1],
      options?: Parameters<typeof recallMemoryInAdapter>[2]
    ) => recallMemoryInAdapter(adapter, query, options),
    list: (options?: ListDecisionsOptions) => listDecisionsInAdapter(adapter, options),
    listDecisions: (options?: ListDecisionsOptions) => listDecisionsInAdapter(adapter, options),
    listCheckpoints: (limit?: number) => listCheckpointsInAdapter(adapter, limit),
    updateOutcome: (decisionId: string, outcome: UpdateOutcomeParams) =>
      updateOutcomeInAdapter(adapter, decisionId, outcome),
    buildProfile: (scopes: Parameters<typeof buildProfileInAdapter>[1]) =>
      buildProfileInAdapter(adapter, scopes),
    ingestMemory: (input: Parameters<typeof ingestMemoryInAdapter>[1]) =>
      ingestMemoryInAdapter(adapter, input),
    ingestConversation: (input: Parameters<typeof ingestConversationInAdapter>[1]) =>
      ingestConversationInAdapter(adapter, input),
    listAuditFindings: () => listOpenAuditFindingsInAdapter(adapter),
    listOpenAuditFindings: () => listOpenAuditFindingsInAdapter(adapter),
    createAuditFinding: (input: Parameters<typeof createAuditFindingInAdapter>[1]) =>
      createAuditFindingInAdapter(adapter, input),
    getMemoryProvenance: (
      memoryId: Parameters<typeof getMemoryProvenanceInAdapter>[1],
      options?: Parameters<typeof getMemoryProvenanceInAdapter>[2]
    ) => getMemoryProvenanceInAdapter(adapter, memoryId, options),
    listMemoriesByEnvelopeHash: (
      envelopeHash: Parameters<typeof listMemoriesByEnvelopeHashInAdapter>[1],
      options?: Parameters<typeof listMemoriesByEnvelopeHashInAdapter>[2]
    ) => listMemoriesByEnvelopeHashInAdapter(adapter, envelopeHash, options),
    listMemoriesByGatewayCallId: (
      gatewayCallId: Parameters<typeof listMemoriesByGatewayCallIdInAdapter>[1],
      options?: Parameters<typeof listMemoriesByGatewayCallIdInAdapter>[2]
    ) => listMemoriesByGatewayCallIdInAdapter(adapter, gatewayCallId, options),
    listMemoriesByModelRunId: (
      modelRunId: Parameters<typeof listMemoriesByModelRunIdInAdapter>[1],
      options?: Parameters<typeof listMemoriesByModelRunIdInAdapter>[2]
    ) => listMemoriesByModelRunIdInAdapter(adapter, modelRunId, options),
    listMemoryEventsForMemory: (
      memoryId: Parameters<typeof listMemoryEventsForMemoryInAdapter>[1]
    ) => listMemoryEventsForMemoryInAdapter(adapter, memoryId),
    listRecentMemoryEvents: (limit?: Parameters<typeof listRecentMemoryEventsInAdapter>[1]) =>
      listRecentMemoryEventsInAdapter(adapter, limit),
    beginModelRun: (input: Parameters<typeof beginModelRunInAdapter>[1]) =>
      beginModelRunInAdapter(adapter, input),
    commitModelRun: (
      modelRunId: Parameters<typeof commitModelRunInAdapter>[1],
      summary?: Parameters<typeof commitModelRunInAdapter>[2],
      tokenCount?: Parameters<typeof commitModelRunInAdapter>[3]
    ) => commitModelRunInAdapter(adapter, modelRunId, summary, tokenCount),
    failModelRun: (
      modelRunId: Parameters<typeof failModelRunInAdapter>[1],
      errorSummary: Parameters<typeof failModelRunInAdapter>[2],
      tokenCount?: Parameters<typeof failModelRunInAdapter>[3]
    ) => failModelRunInAdapter(adapter, modelRunId, errorSummary, tokenCount),
    getModelRun: (modelRunId: Parameters<typeof getModelRunInAdapter>[1]) =>
      getModelRunInAdapter(adapter, modelRunId),
    listModelRunNativeInputs: async (
      modelRunId: Parameters<typeof listModelRunNativeInputsInAdapter>[1],
      principalId: Parameters<typeof listModelRunNativeInputsInAdapter>[2],
      options?: Parameters<typeof listModelRunNativeInputsInAdapter>[3]
    ) => listModelRunNativeInputsInAdapter(adapter, modelRunId, principalId, options),
    appendToolTrace: (input: Parameters<typeof appendToolTraceInAdapter>[1]) =>
      appendToolTraceInAdapter(adapter, input),
    listToolTracesForRun: (modelRunId: Parameters<typeof listToolTracesForRunInAdapter>[1]) =>
      listToolTracesForRunInAdapter(adapter, modelRunId),
    listToolTraces: (input: Parameters<typeof listToolTracesInAdapter>[1]) =>
      listToolTracesInAdapter(adapter, input),
    readToolTrace: (
      traceId: Parameters<typeof readToolTraceInAdapter>[1],
      scope: Parameters<typeof readToolTraceInAdapter>[2]
    ) => readToolTraceInAdapter(adapter, traceId, scope),
    saveCheckpoint: (
      summary: string,
      openFiles?: string[],
      nextSteps?: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recentConversation?: any[]
    ) => saveCheckpointInAdapter(adapter, summary, openFiles, nextSteps, recentConversation),
    loadCheckpoint: () => loadCheckpointInAdapter(adapter),
    recall: (topic: string, options?: RecallOptions) => recallInAdapter(adapter, topic, options),
    expandWithGraph: (candidates: SearchCandidate[]) =>
      expandWithGraphInAdapter(adapter, candidates),
  };
}

export type MamaApi = ReturnType<typeof createMamaApi>;

const mama = {
  // Core functions (used by the MCP tools)
  save,
  link,
  getDecision,
  suggest,
  saveMemory,
  recallMemory,
  list: listDecisions,
  listCheckpoints,
  updateOutcome,
  buildProfile,
  ingestMemory,
  ingestConversation,
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
  commitModelRun,
  failModelRun,
  getModelRun,
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
  link,
  getDecision,
  suggest,
  saveMemory,
  recallMemory,
  listDecisions as list,
  listCheckpoints,
  updateOutcome,
  buildProfile,
  ingestMemory,
  ingestConversation,
  listOpenAuditFindings,
  createAuditFinding,
  getMemoryProvenance,
  listMemoriesByEnvelopeHash,
  listMemoriesByGatewayCallId,
  listMemoriesByModelRunId,
  listMemoryEventsForMemory,
  listRecentMemoryEvents,
  beginModelRun,
  commitModelRun,
  failModelRun,
  getModelRun,
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

// CommonJS compatibility - require('@jungjaehoon/mama-core/mama-api') exposes the
// ambient `mama` facade methods at top level. Merge instead of replacing
// module.exports, so the compiled named exports stay beside them.
if (typeof module !== 'undefined' && module.exports) {
  const target = module.exports as Record<string, unknown>;
  for (const [key, value] of Object.entries(mama)) {
    target[key] = value;
  }
  target.default = mama;
  target.mama = mama;
  target.createMamaApi = createMamaApi;
}
