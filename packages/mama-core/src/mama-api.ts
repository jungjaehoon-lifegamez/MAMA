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

// Node built-ins
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Internal modules
import { learnDecision, createEdgesFromReasoning, DecisionDetection } from './decision-tracker.js';
import { DecisionRecord, SemanticEdgeItem } from './db-manager.js';
import {
  queryDecisionGraph,
  querySemanticEdges,
  getAdapter,
  vectorSearch,
} from './memory-store.js';
import { formatRecall, formatList, formatContext, SemanticEdges } from './decision-formatter.js';
import { logProgress, logComplete, logSearching } from './progress-indicator.js';
import { generateEmbedding } from './embeddings.js';
import { generate } from './ollama-client.js';
import { warn as logWarn, error as logError } from './debug-logger.js';

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
  created_at?: number | string;
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
 * DB count result from aggregate queries
 */
interface DBCountResult {
  count: number;
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

/**
 * Deletion target for auto-generated links
 */
interface DeletionTarget {
  from_id: string;
  to_id: string;
  relationship: string;
}

/**
 * Post cleanup report structure
 */
export interface PostCleanupReport {
  orphaned_decisions: number;
  duplicate_links: number;
  invalid_references: number;
}

/**
 * Quality report options
 */
interface QualityReportOptions {
  format?: 'json' | 'markdown' | null;
  period?: '24h' | '7d' | '30d' | null;
  thresholds?: QualityThresholds | null;
}

/**
 * Quality thresholds
 */
interface QualityThresholds {
  minSuccessRate?: number;
  maxLatencyMs?: number;
}

/**
 * Deprecate auto-links result
 */
interface DeprecateAutoLinksResult {
  dryRun: boolean;
  deprecated: number;
  protected: number;
  total: number;
  autoLinkRatio: string;
  links: Array<{
    from_id: string;
    to_id: string;
    relationship: string;
    reason?: string;
    created_at?: number | string;
  }>;
}

/**
 * Scan auto-links result
 */
interface ScanAutoLinksResult {
  total_links: number;
  auto_links: number;
  protected_links: number;
  deletion_targets: number;
  deletion_target_list: DeletionTarget[];
}

/**
 * Create link backup result
 */
interface CreateLinkBackupResult {
  backup_file: string;
  manifest_file: string;
  checksum: string;
  link_count: number;
}

/**
 * Restore link backup result
 */
interface RestoreLinkBackupResult {
  total_links: number;
  restored: number;
  failed: number;
  backup_file: string;
}

/**
 * Verify backup exists result
 */
interface VerifyBackupResult {
  backup_file: string;
  age_hours: number;
  link_count: number;
}

/**
 * Delete auto-links result (dry run mode)
 */
interface DeleteAutoLinksDryRunResult {
  dry_run: true;
  would_delete: number;
  deleted: 0;
  backup_file: string;
  large_deletion_warning: boolean;
  warning_message: string | null;
  sample_links: Array<{
    from_id: string;
    to_id: string;
    relationship: string;
  }>;
  message: string;
}

/**
 * Delete auto-links error entry
 */
type DeleteAutoLinksError =
  | { link: string; error: string }
  | { batch_index: number; batch_size: number; error: string };

/**
 * Delete auto-links result (execute mode)
 */
interface DeleteAutoLinksExecuteResult {
  dry_run: false;
  deleted: number;
  failed: number;
  total_targets: number;
  batches_processed: number;
  backup_file: string;
  errors: DeleteAutoLinksError[];
  success_rate: number;
}

/**
 * Delete auto-links result (empty case)
 */
interface DeleteAutoLinksEmptyResult {
  dry_run: boolean;
  deleted: 0;
  failed: 0;
  total_targets: 0;
  backup_file: string;
  message: string;
}

/**
 * Delete auto-links union type
 */
type DeleteAutoLinksResult =
  | DeleteAutoLinksDryRunResult
  | DeleteAutoLinksExecuteResult
  | DeleteAutoLinksEmptyResult;

/**
 * Quality recommendation
 */
export interface QualityRecommendation {
  category: string;
  severity: string;
  message: string;
}

/**
 * Quality report structure
 */
export interface QualityReport {
  successRate: {
    period: string;
    total: number;
    success: number;
    failure: number;
    successRate: string;
    meetsTarget: boolean;
  };
  latency?: {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    meetsTarget: boolean;
  };
}

/**
 * Period map for time-based queries
 */
type PeriodMap = {
  [key in '24h' | '7d' | '30d']: number;
};

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
async function save({
  topic,
  decision,
  reasoning,
  confidence = 0.5,
  type = 'user_decision',
  outcome = 'pending',
  failure_reason = null,
  limitation = null,
  trust_context = null,
}: SaveParams): Promise<SaveResult> {
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

  // Map type to user_involvement field
  // Note: Current schema uses user_involvement ('requested', 'approved', 'rejected')
  // Future: Will use decision_type column for proper distinction
  const _userInvolvement = type === 'user_decision' ? 'approved' : null;

  // Create detection object for learnDecision()
  // Convert null to undefined for type compatibility
  const detection: DecisionDetection = {
    topic,
    decision,
    reasoning,
    confidence,
    trust_context: trust_context ?? undefined,
  };

  // Create tool execution context
  // Use current timestamp and generate session ID
  const sessionId = `mama_api_${Date.now()}`;
  const toolExecution = {
    tool_name: 'mama.save',
    tool_input: { topic, decision },
    exit_code: 0,
    session_id: sessionId,
    timestamp: Date.now(),
  };

  // Create session context
  const sessionContext = {
    session_id: sessionId,
    latest_user_message: `Save ${type}: ${topic}`,
    recent_exchange: `Claude: ${reasoning.substring(0, 100)}...`,
  };

  // Call internal learnDecision function
  // Note: learnDecision returns { decisionId, notification }
  logProgress(`Saving decision: ${topic.substring(0, 30)}...`);
  const { decisionId } = await learnDecision(detection, toolExecution, sessionContext);
  logComplete(`Decision saved: ${decisionId.substring(0, 20)}...`);

  // Update user_involvement, outcome, failure_reason, limitation
  // Note: learnDecision always sets 'requested', we need to override it
  const adapter = getAdapter();

  // Build UPDATE query dynamically based on what fields are provided
  const updates = [];
  const values = [];

  // user_involvement based on type
  if (type === 'assistant_insight') {
    updates.push('user_involvement = NULL');
  } else if (type === 'user_decision') {
    updates.push('user_involvement = ?');
    values.push('approved');
  }

  // outcome (always set, default is 'pending')
  // Story M4.1 fix: Map to DB format (uppercase, pending → NULL)
  if (outcome) {
    const outcomeMap = {
      pending: null,
      success: 'SUCCESS',
      failure: 'FAILED',
      partial: 'PARTIAL',
      superseded: null,
    };
    const dbOutcome = outcomeMap[outcome] !== undefined ? outcomeMap[outcome] : outcome;

    updates.push('outcome = ?');
    values.push(dbOutcome);
  }

  // failure_reason (optional)
  if (failure_reason) {
    updates.push('failure_reason = ?');
    values.push(failure_reason);
  }

  // limitation (optional)
  if (limitation) {
    updates.push('limitation = ?');
    values.push(limitation);
  }

  // Execute UPDATE if we have any fields to update
  if (updates.length > 0) {
    values.push(decisionId); // WHERE id = ?
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    await stmt.run(...values);
  }

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
    try {
      // Story 1.1: Auto-search using suggest()
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
          .filter((d: SimilarDecision) => d.id !== decisionId)
          .map((d: SimilarDecision) => ({
            id: d.id,
            topic: d.topic,
            decision: d.decision,
            similarity: d.similarity,
            created_at: d.created_at,
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

    // Story 2.2: Parse reasoning for relationship edges (builds_on, debates, synthesizes)
    if (reasoning) {
      try {
        await createEdgesFromReasoning(decisionId, reasoning);
      } catch (error: unknown) {
        // Best-effort - save succeeds even if edge creation fails
        const errMsg = error instanceof Error ? error.message : String(error);
        logError('Edge creation from reasoning failed:', errMsg);
      }
    }
  }

  // Story 1.2: Enhanced response (backward compatible)
  return {
    success: true,
    id: decisionId,
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
- SUPERSEDE: Same topic replaces prior (automatic)
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
    const chain = await queryDecisionGraph(topic);

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
    const decisions = await queryDecisionGraph(topic);

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
    const rawEdges = await querySemanticEdges(decisionIds);
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
    const adapter = getAdapter();

    // Update outcome and related fields
    const stmt = adapter.prepare(
      `
      UPDATE decisions
      SET
        outcome = ?,
        failure_reason = ?,
        limitation = ?,
        updated_at = ?
      WHERE id = ?
    `
    );
    const result = stmt.run(
      normalizedOutcome,
      failure_reason || null,
      limitation || null,
      Date.now(),
      decisionId
    );

    // Check if decision was found and updated
    if (result.changes === 0) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

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
      const chain = await queryDecisionGraph(candidate.topic);
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
      const rawEdges = (await querySemanticEdges([candidate.id])) || {};
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
interface SuggestFunctionOptions {
  format?: 'json' | 'markdown';
  limit?: number;
  threshold?: number;
  useReranking?: boolean;
  recencyWeight?: number;
  recencyScale?: number;
  recencyDecay?: number;
  disableRecency?: boolean;
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
    // Recency boosting parameters (Gaussian Decay - Elasticsearch style)
    recencyWeight = 0.3, // 0-1: How much to weight recency (0.3 = 70% semantic, 30% recency)
    recencyScale = 7, // Days until recency score drops to 50%
    recencyDecay = 0.5, // Score at scale point (0.5 = 50%)
    disableRecency = false, // Set true to disable recency boosting entirely
  } = options;

  try {
    // 1. Try vector search first (if sqlite-vss is available)
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-explicit-any
    let results: any[] = [];
    let searchMethod = 'vector';

    try {
      // Check if vector search is available (sqlite-vec loaded)
      if (!getAdapter().vectorSearchEnabled) {
        throw new Error('Vector search not available');
      }

      // Generate query embedding
      const queryEmbedding = await generateEmbedding(userQuestion);

      // Adaptive threshold (shorter queries need higher confidence)
      const wordCount = userQuestion.split(/\s+/).length;
      const adaptiveThreshold = threshold !== undefined ? threshold : wordCount < 3 ? 0.7 : 0.6;

      // Vector search
      results = await vectorSearch(queryEmbedding, limit * 2, 0.5); // Get more candidates

      // Filter by adaptive threshold
      results = results.filter((r) => r.similarity >= adaptiveThreshold);

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

      // Stage 2: Graph expansion (NEW - Phase 1)
      // Expand candidates with supersedes chain and semantic edges
      if (results.length > 0) {
        const graphEnhanced = await expandWithGraph(results);
        results = graphEnhanced;
        searchMethod = disableRecency ? 'vector+graph' : 'vector+recency+graph';
      }
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

      const rows = (await stmt.all(...likeParams, limit)) as DecisionRecord[];
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

    // Slice to limit
    const finalResults = results.slice(0, limit);

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

    // JSON format (default - LLM-first)
    return {
      query: userQuestion,
      results: finalResults.map((r) => ({
        id: r.id,
        topic: r.topic,
        decision: r.decision,
        reasoning: r.reasoning,
        confidence: r.confidence,
        similarity: r.similarity,
        created_at: r.created_at,
        // Recency metadata (NEW - Gaussian Decay)
        recency_score: r.recency_score,
        recency_age_days: r.recency_age_days,
        final_score: r.final_score || r.similarity, // Falls back to similarity if no recency
        // Graph metadata (NEW - Phase 1)
        graph_source: r.graph_source || 'primary',
        graph_rank: r.graph_rank || 1.0,
        related_to: r.related_to || null,
        edge_reason: r.edge_reason || null,
      })),
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
}

async function listDecisions(
  options: ListDecisionsOptions = {}
): Promise<DecisionRecord[] | string> {
  const { limit = 10, format = 'json' } = options;

  try {
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT * FROM decisions
      WHERE superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const decisions = await stmt.all(limit);

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
 * Propose a new link between decisions (Epic 3 - Story 3.1)
 *
 * LLM proposes a link for user approval. Link is created but marked as pending.
 *
 * @param {Object} params - Link parameters
 * @param {string} params.from_id - Source decision ID
 * @param {string} params.to_id - Target decision ID
 * @param {string} params.relationship - 'refines' or 'contradicts'
 * @param {string} params.reason - Why this link should exist
 * @param {string} [params.decision_id] - Context decision where link was proposed
 * @param {string} [params.evidence] - Supporting evidence
 * @returns {Promise<void>}
 */
interface ProposeLinkParams {
  from_id: string;
  to_id: string;
  relationship: string;
  reason: string;
  decision_id?: string;
  evidence?: string;
}

async function proposeLink({
  from_id,
  to_id,
  relationship,
  reason,
  decision_id,
  evidence,
}: ProposeLinkParams): Promise<void> {
  if (!from_id || !to_id || !relationship || !reason) {
    throw new Error('proposeLink() requires from_id, to_id, relationship, and reason');
  }

  if (!['refines', 'contradicts'].includes(relationship)) {
    throw new Error('proposeLink() relationship must be "refines" or "contradicts"');
  }

  try {
    const adapter = getAdapter();

    // Use transaction to ensure atomicity (link + audit log)
    adapter.transaction(() => {
      // Insert link with pending approval
      const stmt = adapter.prepare(`
        INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, evidence, created_at)
        VALUES (?, ?, ?, ?, 'llm', 0, ?, ?, ?)
      `);
      stmt.run(
        from_id,
        to_id,
        relationship,
        reason,
        decision_id || null,
        evidence || null,
        Date.now()
      );

      // Log to audit trail
      const auditStmt = adapter.prepare(`
        INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
        VALUES (?, ?, ?, 'proposed', 'llm', ?, ?)
      `);
      auditStmt.run(from_id, to_id, relationship, reason, Date.now());
    });

    return;
  } catch (error: unknown) {
    throw new Error(
      `proposeLink() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Approve a proposed link (Epic 3 - Story 3.1)
 *
 * User approves a pending link, making it active.
 *
 * @param {string} from_id - Source decision ID
 * @param {string} to_id - Target decision ID
 * @param {string} relationship - Link relationship type
 * @returns {Promise<void>}
 */
async function approveLink(from_id: string, to_id: string, relationship: string): Promise<void> {
  if (!from_id || !to_id || !relationship) {
    throw new Error('approveLink() requires from_id, to_id, and relationship');
  }

  try {
    const adapter = getAdapter();

    // Update link to approved with timestamp
    const stmt = adapter.prepare(`
      UPDATE decision_edges
      SET approved_by_user = 1, approved_at = ?
      WHERE from_id = ? AND to_id = ? AND relationship = ?
    `);
    stmt.run(Date.now(), from_id, to_id, relationship);

    // Log approval
    const auditStmt = adapter.prepare(`
      INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, created_at)
      VALUES (?, ?, ?, 'approved', 'user', ?)
    `);
    auditStmt.run(from_id, to_id, relationship, Date.now());

    return;
  } catch (error: unknown) {
    throw new Error(
      `approveLink() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Reject a proposed link (Epic 3 - Story 3.1)
 *
 * User rejects a pending link, removing it from the database.
 *
 * @param {string} from_id - Source decision ID
 * @param {string} to_id - Target decision ID
 * @param {string} relationship - Link relationship type
 * @param {string} [reason] - Optional reason for rejection
 * @returns {Promise<void>}
 */
async function rejectLink(
  from_id: string,
  to_id: string,
  relationship: string,
  reason?: string
): Promise<void> {
  if (!from_id || !to_id || !relationship) {
    throw new Error('rejectLink() requires from_id, to_id, and relationship');
  }

  try {
    const adapter = getAdapter();

    // Log rejection before deletion
    const auditStmt = adapter.prepare(`
      INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
      VALUES (?, ?, ?, 'rejected', 'user', ?, ?)
    `);
    auditStmt.run(from_id, to_id, relationship, reason || 'User rejected', Date.now());

    // Delete the link
    const stmt = adapter.prepare(`
      DELETE FROM decision_edges
      WHERE from_id = ? AND to_id = ? AND relationship = ?
    `);
    stmt.run(from_id, to_id, relationship);

    return;
  } catch (error: unknown) {
    throw new Error(
      `rejectLink() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get pending links awaiting approval (Epic 3 - Story 3.1)
 *
 * Returns all links that need user approval.
 *
 * @param {Object} [options] - Query options
 * @param {string} [options.from_id] - Filter by source decision
 * @param {string} [options.to_id] - Filter by target decision
 * @returns {Promise<Array>} Pending links with decision details
 */
interface GetPendingLinksOptions {
  from_id?: string;
  to_id?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPendingLinks(options: GetPendingLinksOptions = {}): Promise<any[]> {
  try {
    const adapter = getAdapter();
    const { from_id, to_id } = options;

    let query = `
      SELECT
        e.*,
        d_from.topic as from_topic,
        d_from.decision as from_decision,
        d_to.topic as to_topic,
        d_to.decision as to_decision
      FROM decision_edges e
      LEFT JOIN decisions d_from ON e.from_id = d_from.id
      LEFT JOIN decisions d_to ON e.to_id = d_to.id
      WHERE e.approved_by_user = 0
    `;

    const params = [];
    if (from_id) {
      query += ' AND e.from_id = ?';
      params.push(from_id);
    }
    if (to_id) {
      query += ' AND e.to_id = ?';
      params.push(to_id);
    }

    query += ' ORDER BY e.created_at DESC';

    const stmt = adapter.prepare(query);
    const links = await stmt.all(...params);

    return links;
  } catch (error: unknown) {
    throw new Error(
      `getPendingLinks() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Deprecate auto-generated links (Epic 3 - Story 3.3)
 *
 * Identifies and removes v0 auto-generated links that lack explicit approval context.
 * Protected links (with decision_id or created_by='llm') are preserved.
 *
 * @param {Object} [options] - Deprecation options
 * @param {boolean} [options.dryRun=true] - If true, only report without deleting
 * @returns {Promise<Object>} Report with counts and deprecated links
 */
interface DeprecateAutoLinksOptions {
  dryRun?: boolean;
}

interface EdgeLink {
  from_id: string;
  to_id: string;
  relationship: string;
  reason?: string;
  created_at?: number | string;
}

async function deprecateAutoLinks(
  options: DeprecateAutoLinksOptions = {}
): Promise<DeprecateAutoLinksResult> {
  const { dryRun = true } = options;

  try {
    const adapter = getAdapter();

    // Identify auto-generated links (v0 legacy)
    // Criteria: created_by='user' (default) AND decision_id IS NULL (no proposal context)
    // Protected: decision_id IS NOT NULL OR created_by='llm' (explicitly proposed)
    const identifyStmt = adapter.prepare(`
      SELECT * FROM decision_edges
      WHERE created_by = 'user' AND decision_id IS NULL
    `);
    const autoLinks = (await identifyStmt.all()) as EdgeLink[];

    // Identify protected links for comparison
    const protectedStmt = adapter.prepare(`
      SELECT COUNT(*) as count FROM decision_edges
      WHERE decision_id IS NOT NULL OR created_by = 'llm'
    `);
    const protectedResult = (await protectedStmt.get()) as { count: number } | undefined;
    const protectedCount = protectedResult?.count ?? 0;

    const totalLinks = autoLinks.length + protectedCount;
    const autoLinkRatio = totalLinks > 0 ? (autoLinks.length / totalLinks) * 100 : 0;

    if (!dryRun && autoLinks.length > 0) {
      // Delete auto-generated links
      const deleteStmt = adapter.prepare(`
        DELETE FROM decision_edges
        WHERE created_by = 'user' AND decision_id IS NULL
      `);
      await deleteStmt.run();

      // Log deprecation to audit trail
      const timestamp = Date.now();
      const auditStmt = adapter.prepare(`
        INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
        VALUES (?, ?, ?, 'deprecated', 'system', ?, ?)
      `);

      for (const link of autoLinks) {
        await auditStmt.run(
          link.from_id,
          link.to_id,
          link.relationship,
          'v0 auto-generated link removed during governance migration',
          timestamp
        );
      }
    }

    return {
      dryRun,
      deprecated: autoLinks.length,
      protected: protectedCount,
      total: totalLinks,
      autoLinkRatio: autoLinkRatio.toFixed(2) + '%',
      links: autoLinks.map((l: EdgeLink) => ({
        from_id: l.from_id,
        to_id: l.to_id,
        relationship: l.relationship,
        reason: l.reason,
        created_at: l.created_at,
      })),
    };
  } catch (error: unknown) {
    throw new Error(
      `deprecateAutoLinks() failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Scan and identify auto-generated links for cleanup (Epic 5 - Story 5.1)
 *
 * Identifies auto-generated links lacking proper approval metadata.
 * Separates deletion targets from protected links.
 *
 * Identification criteria:
 * - approved_by_user = 0 OR (created_by IS NULL AND decision_id IS NULL)
 *
 * Protected (excluded from deletion):
 * - approved_by_user = 1 AND (decision_id IS NOT NULL OR evidence IS NOT NULL)
 *
 * @returns {Object} Scan results with counts and link details
 */
function scanAutoLinks(): ScanAutoLinksResult {
  const adapter = getAdapter();

  // Total links
  const totalStmt = adapter.prepare(`SELECT COUNT(*) as count FROM decision_edges`);
  const totalResult = totalStmt.get() as { count: number } | undefined;
  const totalLinks = totalResult?.count ?? 0;

  // Auto-generated links (lacking proper metadata)
  const autoStmt = adapter.prepare(`
    SELECT * FROM decision_edges
    WHERE approved_by_user = 0
       OR (created_by IS NULL AND decision_id IS NULL)
  `);
  const autoLinks = autoStmt.all() as EdgeLink[];

  // Protected links (approved or has complete metadata)
  const protectedStmt = adapter.prepare(`
    SELECT COUNT(*) as count FROM decision_edges
    WHERE approved_by_user = 1
       OR (decision_id IS NOT NULL AND evidence IS NOT NULL)
  `);
  const protectedResult = protectedStmt.get() as { count: number } | undefined;
  const protectedLinks = protectedResult?.count ?? 0;

  // Filter deletion targets (exclude protected links)
  const deletionTargets = autoLinks.filter(
    (link: EdgeLink & { approved_by_user?: number; decision_id?: string; evidence?: string }) => {
      // Exclude protected links
      return !(link.approved_by_user === 1 || (link.decision_id && link.evidence));
    }
  );

  return {
    total_links: totalLinks,
    auto_links: autoLinks.length,
    protected_links: protectedLinks,
    deletion_targets: deletionTargets.length,
    deletion_target_list: deletionTargets,
  };
}

/**
 * Create backup of links before cleanup (Epic 5 - Story 5.1)
 *
 * Backs up deletion target links with full metadata to JSON file.
 * Generates SHA-256 checksum for data integrity verification.
 * Creates backup manifest with timestamp and metadata.
 *
 * @param {Array} targetLinks - Links to back up
 * @returns {Object} Backup result with file paths and checksum
 */
function createLinkBackup(targetLinks: EdgeLink[]): CreateLinkBackupResult {
  const backupDir = path.join(os.homedir(), '.claude', 'mama-backups');

  // Create backup directory if not exists
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `links-backup-${timestamp}.json`);

  // Serialize target links with full metadata
  const backupData = {
    timestamp: new Date().toISOString(),
    link_count: targetLinks.length,
    links: targetLinks,
  };

  const backupJson = JSON.stringify(backupData, null, 2);

  // Calculate SHA-256 checksum
  const checksum = crypto.createHash('sha256').update(backupJson).digest('hex');

  // Save backup file
  fs.writeFileSync(backupFile, backupJson, 'utf8');

  // Save manifest
  const manifest = {
    timestamp: backupData.timestamp,
    backup_file: backupFile,
    checksum,
    link_count: targetLinks.length,
  };

  const manifestFile = path.join(backupDir, `backup-manifest-${timestamp}.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    backup_file: backupFile,
    manifest_file: manifestFile,
    checksum,
    link_count: targetLinks.length,
  };
}

/**
 * Generate pre-cleanup report with risk assessment (Epic 5 - Story 5.1)
 *
 * Creates comprehensive report with statistics, risk level, and samples.
 * Risk assessment based on deletion ratio:
 * - HIGH: > 50% deletion
 * - MEDIUM: 30-50% deletion
 * - LOW: < 30% deletion
 *
 * @returns {Object} Report data with markdown output and file path
 */
function generatePreCleanupReport() {
  const scanResult = scanAutoLinks();

  // Calculate risk level (guard against division by zero)
  const deletionRatio =
    scanResult.total_links > 0 ? scanResult.deletion_targets / scanResult.total_links : 0;
  let riskLevel;
  if (deletionRatio > 0.5) {
    riskLevel = 'HIGH';
  } else if (deletionRatio > 0.3) {
    riskLevel = 'MEDIUM';
  } else {
    riskLevel = 'LOW';
  }

  // Sample deletion targets (max 10)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samples = scanResult.deletion_target_list.slice(0, 10).map((link: any) => ({
    from_id: link.from_id,
    to_id: link.to_id,
    relationship: link.relationship,
    reason: link.reason,
    created_by: link.created_by,
    approved_by_user: link.approved_by_user,
  }));

  const report = {
    generated_at: new Date().toISOString(),
    statistics: {
      total_links: scanResult.total_links,
      auto_links: scanResult.auto_links,
      protected_links: scanResult.protected_links,
      deletion_targets: scanResult.deletion_targets,
      deletion_ratio: `${(deletionRatio * 100).toFixed(1)}%`,
    },
    risk_assessment: {
      level: riskLevel,
      message:
        riskLevel === 'HIGH'
          ? '⚠️ HIGH RISK: Deletion targets exceed 50%. Create backup before proceeding.'
          : riskLevel === 'MEDIUM'
            ? '⚡ MEDIUM RISK: Deletion targets 30-50%. Verify backup recommended.'
            : '✅ LOW RISK: Deletion targets under 30%. Safe to proceed.',
    },
    deletion_target_samples: samples,
  };

  // Generate markdown report
  const markdown = `# Pre-Cleanup Report

**Generated:** ${report.generated_at}

## Statistics

- **Total Links:** ${report.statistics.total_links}
- **Auto Links:** ${report.statistics.auto_links}
- **Protected Links:** ${report.statistics.protected_links}
- **Deletion Targets:** ${report.statistics.deletion_targets} (${report.statistics.deletion_ratio})

## Risk Assessment

**Level:** ${report.risk_assessment.level}

${report.risk_assessment.message}

## Sample Deletion Targets (First 10)

${samples
  .map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (link: any, idx: number) => `
### ${idx + 1}. ${link.from_id} → ${link.to_id}

- **Relationship:** ${link.relationship}
- **Reason:** ${link.reason || 'N/A'}
- **Created By:** ${link.created_by || 'N/A'}
- **Approved:** ${link.approved_by_user ? 'Yes' : 'No'}
`
  )
  .join('\n')}

---

**Next Steps:**

1. Review the deletion targets above
2. Run \`create_link_backup\` to create a backup
3. Proceed with cleanup using Story 5.2 tools
4. If needed, restore from backup using \`restore_link_backup\`
`;

  const backupDir = path.join(os.homedir(), '.claude', 'mama-backups');

  // Ensure backup directory exists
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(backupDir, `pre-cleanup-report-${timestamp}.md`);

  fs.writeFileSync(reportFile, markdown, 'utf8');

  return {
    report: report,
    report_file: reportFile,
    markdown,
  };
}

/**
 * Restore links from backup file (Epic 5 - Story 5.1)
 *
 * Restores previously backed-up links to the database.
 * Verifies checksum before restoration to ensure data integrity.
 * Reports number of restored and failed links.
 *
 * @param {string} backupFile - Path to backup file
 * @returns {Object} Restoration result with counts
 */
function restoreLinkBackup(backupFile: string): RestoreLinkBackupResult {
  // Read backup file
  const backupJson = fs.readFileSync(backupFile, 'utf8');
  const backupData = JSON.parse(backupJson);

  // Read manifest for checksum verification
  const manifestFile = backupFile.replace('links-backup', 'backup-manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Verify checksum
  const calculatedChecksum = crypto.createHash('sha256').update(backupJson).digest('hex');
  if (calculatedChecksum !== manifest.checksum) {
    throw new Error('Backup file checksum mismatch. File may be corrupted.');
  }

  // Restore links to database
  const adapter = getAdapter();

  let restored = 0;
  let failed = 0;

  const insertStmt = adapter.prepare(`
    INSERT OR REPLACE INTO decision_edges
    (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const link of backupData.links) {
    try {
      insertStmt.run(
        link.from_id,
        link.to_id,
        link.relationship,
        link.reason,
        link.created_by,
        link.approved_by_user,
        link.decision_id,
        link.evidence,
        link.created_at
      );
      restored++;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`Failed to restore link ${link.from_id} -> ${link.to_id}:`, msg);
      failed++;
    }
  }

  return {
    total_links: backupData.link_count,
    restored,
    failed,
    backup_file: backupFile,
  };
}

/**
 * Verify backup file exists and is recent (Epic 5 - Story 5.2)
 *
 * Checks for backup files in backup directory and verifies they are recent enough.
 * Required as safety check before executing link deletion.
 *
 * @param {number} maxAgeHours - Maximum age of backup in hours (default: 24)
 * @returns {Object} Backup verification result with latest backup info
 */
function verifyBackupExists(maxAgeHours: number = 24): VerifyBackupResult {
  const backupDir = path.join(os.homedir(), '.claude', 'mama-backups');

  if (!fs.existsSync(backupDir)) {
    throw new Error(
      'Backup directory not found. Please create a backup first using create_link_backup.'
    );
  }

  const backupFiles = fs
    .readdirSync(backupDir)
    .filter((f: string) => f.startsWith('links-backup-'))
    .map((f: string) => ({
      name: f,
      path: path.join(backupDir, f),
      mtime: fs.statSync(path.join(backupDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (backupFiles.length === 0) {
    throw new Error('No recent backup found. Please run create_link_backup first.');
  }

  const latestBackup = backupFiles[0];
  const backupAge = Date.now() - latestBackup.mtime.getTime();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  if (backupAge > maxAgeMs) {
    throw new Error(
      `Most recent backup is too old (${(backupAge / (60 * 60 * 1000)).toFixed(1)} hours). Max age: ${maxAgeHours} hours.`
    );
  }

  // Read backup metadata
  const backupJson = fs.readFileSync(latestBackup.path, 'utf8');
  const backupData = JSON.parse(backupJson);

  return {
    backup_file: latestBackup.path,
    age_hours: backupAge / (60 * 60 * 1000),
    link_count: backupData.link_count || 0,
  };
}

/**
 * Delete auto-generated links with batch processing (Epic 5 - Story 5.2)
 *
 * Executes batch deletion of auto-generated links with transaction support.
 * Requires recent backup (within 24 hours) before execution.
 * Logs all deletions to audit trail.
 *
 * Safety features:
 * - Backup verification before deletion
 * - Batch processing with transaction support
 * - Dry-run mode for simulation
 * - Large deletion warning (> 1000 links)
 *
 * @param {number} batchSize - Number of links to delete per batch (default: 100)
 * @param {boolean} dryRun - If true, simulate deletion without actual changes (default: true)
 * @returns {Object} Deletion result with counts and backup info
 */
function deleteAutoLinks(batchSize: number = 100, dryRun: boolean = true): DeleteAutoLinksResult {
  const adapter = getAdapter();

  // Safety check: Verify recent backup exists
  const backupInfo = verifyBackupExists(24);

  // Scan for deletion targets
  const scanResult = scanAutoLinks();
  const deletionTargets = scanResult.deletion_target_list;

  if (deletionTargets.length === 0) {
    return {
      dry_run: dryRun,
      deleted: 0,
      failed: 0,
      total_targets: 0,
      backup_file: backupInfo.backup_file,
      message: 'No auto-generated links found. Nothing to delete.',
    };
  }

  // Large deletion warning
  const largeDelection = deletionTargets.length > 1000;
  if (largeDelection) {
    logWarn(
      `⚠️ LARGE DELETION: ${deletionTargets.length} links will be deleted. Consider running in dry-run mode first.`
    );
  }

  if (dryRun) {
    return {
      dry_run: true,
      would_delete: deletionTargets.length,
      deleted: 0,
      backup_file: backupInfo.backup_file,
      large_deletion_warning: largeDelection,
      warning_message: largeDelection
        ? `Warning: More than 1000 links (${deletionTargets.length}) will be deleted.`
        : null,
      sample_links: deletionTargets.slice(0, 5).map((l: DeletionTarget) => ({
        from_id: l.from_id,
        to_id: l.to_id,
        relationship: l.relationship,
      })),
      message: 'Dry-run mode: No links were actually deleted.',
    };
  }

  // Execute batch deletion with transaction support
  let deleted = 0;
  let failed = 0;
  let batchesProcessed = 0;
  const errors = [];

  const deleteStmt = adapter.prepare(`
    DELETE FROM decision_edges
    WHERE from_id = ? AND to_id = ? AND relationship = ?
  `);

  const auditStmt = adapter.prepare(`
    INSERT INTO link_audit_log (from_id, to_id, relationship, action, actor, reason, created_at)
    VALUES (?, ?, ?, 'deprecated', 'system', ?, ?)
  `);

  // Process in batches
  for (let i = 0; i < deletionTargets.length; i += batchSize) {
    const batch = deletionTargets.slice(i, i + batchSize);

    try {
      const processBatch = () => {
        for (const link of batch) {
          try {
            deleteStmt.run(link.from_id, link.to_id, link.relationship);
            auditStmt.run(
              link.from_id,
              link.to_id,
              link.relationship,
              'Auto-link cleanup - v1.1 migration',
              Date.now()
            );
            deleted++;
          } catch (error: unknown) {
            failed++;
            errors.push({
              link: `${link.from_id}->${link.to_id}`,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      // Use transaction if available, otherwise run directly
      if (adapter.transaction) {
        adapter.transaction(processBatch);
      } else {
        processBatch();
      }
      batchesProcessed++;
    } catch (error: unknown) {
      logError(`Batch deletion failed at index ${i}:`, error);
      failed += batch.length;
      errors.push({
        batch_index: i,
        batch_size: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      break; // Stop on batch failure
    }
  }

  const successRate = deletionTargets.length > 0 ? (deleted / deletionTargets.length) * 100 : 0;

  return {
    dry_run: false,
    deleted,
    failed,
    total_targets: deletionTargets.length,
    backup_file: backupInfo.backup_file,
    batches_processed: batchesProcessed,
    errors: errors.slice(0, 10), // Return first 10 errors
    success_rate: successRate,
  };
}

/**
 * Validate cleanup result and generate post-cleanup report (Epic 5 - Story 5.2)
 *
 * Re-scans for remaining auto-generated links and evaluates cleanup success.
 * Generates comprehensive report with statistics and recommendations.
 *
 * Success criteria:
 * - SUCCESS: Remaining auto links < 5%
 * - PARTIAL: Remaining auto links 5-10%
 * - FAILED: Remaining auto links > 10%
 *
 * @returns {Object} Validation result with report and file path
 */
function validateCleanupResult() {
  // Re-scan for remaining auto links
  const scanResult = scanAutoLinks();

  // Calculate remaining ratio
  const totalLinks = scanResult.total_links;
  const remainingAutoLinks = scanResult.auto_links;
  const remainingRatio = totalLinks > 0 ? remainingAutoLinks / totalLinks : 0;

  // Evaluate cleanup success
  let status;
  let message;
  let recommendation;

  if (remainingRatio < 0.05) {
    status = 'SUCCESS';
    message = '✅ SUCCESS: Remaining auto-links under 5%. Target achieved!';
    recommendation = 'Cleanup completed successfully. You can proceed with migration.';
  } else if (remainingRatio < 0.1) {
    status = 'PARTIAL';
    message = '⚡ PARTIAL: Remaining auto-links 5-10%. Additional cleanup recommended.';
    recommendation = 'Run execute_link_cleanup again to clean up more auto-links.';
  } else {
    status = 'FAILED';
    message = '⚠️ FAILED: Remaining auto-links exceed 10%. Rollback or re-run needed.';
    recommendation = 'Significantly missed target. Consider restoring from backup and retry.';
  }

  // Generate post-cleanup report
  const report = {
    validated_at: new Date().toISOString(),
    status,
    message,
    statistics: {
      total_links: totalLinks,
      remaining_auto_links: remainingAutoLinks,
      remaining_ratio: `${(remainingRatio * 100).toFixed(1)}%`,
      protected_links: scanResult.protected_links,
      deletion_targets: scanResult.deletion_targets,
    },
    recommendation,
  };

  // Generate markdown report
  const markdown = generatePostCleanupReportMarkdown(report);

  // Save report to file
  const backupDir = path.join(os.homedir(), '.claude', 'mama-backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(backupDir, `post-cleanup-report-${timestamp}.md`);

  fs.writeFileSync(reportFile, markdown, 'utf8');

  return {
    status,
    total_links_before: totalLinks,
    auto_links_remaining: remainingAutoLinks,
    remaining_ratio: remainingRatio * 100,
    protected_links: scanResult.protected_links,
    report,
    report_file: reportFile,
    markdown,
  };
}

/**
 * Generate post-cleanup report in Markdown format (Epic 5 - Story 5.2)
 *
 * @param {Object} report - Validation report data
 * @returns {string} Markdown formatted report
 */
function generatePostCleanupReportMarkdown(report: {
  validated_at: string;
  status: string;
  message: string;
  statistics: {
    total_links: number;
    remaining_auto_links: number;
    remaining_ratio: string;
    protected_links: number;
    deletion_targets: number;
  };
  recommendation: string;
}): string {
  let markdown = `# Post-Cleanup Validation Report

**Generated:** ${report.validated_at}
**Status:** ${report.status}

${report.message}

## Statistics

- **Total Links:** ${report.statistics.total_links}
- **Remaining Auto Links:** ${report.statistics.remaining_auto_links}
- **Remaining Ratio:** ${report.statistics.remaining_ratio}
- **Protected Links:** ${report.statistics.protected_links}
- **Deletion Targets (if any):** ${report.statistics.deletion_targets}

## Recommendation

${report.recommendation}
`;

  // Add rollback instructions for non-SUCCESS statuses
  if (report.status !== 'SUCCESS') {
    markdown += `

---

## Rollback Instructions

If you need to restore the deleted links:

1. Find the latest backup file in \`~/.claude/mama-backups/\`
2. Run: \`restore_link_backup <backup_file_path>\`
3. Re-run validation: \`validate_cleanup_result\`

**Next Steps:**

- For PARTIAL status: Review remaining auto links and run cleanup again if needed
- For FAILED status: Consider rollback and investigate why many links remain
`;
  }

  return markdown;
}

/**
 * Calculate coverage metrics (Epic 4 - Story 4.1)
 *
 * Measures narrative coverage (% of decisions with narrative fields)
 * and link coverage (% of decisions with at least one link).
 *
 * @returns {Object} Coverage metrics
 */
function calculateCoverage() {
  const adapter = getAdapter();

  // Total decisions
  const totalDecisions = (
    adapter.prepare(`SELECT COUNT(*) as count FROM decisions`).get() as DBCountResult
  ).count;

  if (totalDecisions === 0) {
    return {
      narrativeCoverage: '0.0%',
      linkCoverage: '0.0%',
      totalDecisions: 0,
      completeNarratives: 0,
      decisionsWithLinks: 0,
    };
  }

  // Narrative coverage: Decisions with evidence, alternatives, and risks filled
  // Note: Using existing schema fields (evidence, alternatives, risks) instead of
  // 5-layer fields (specificity, evidence, reasoning, tension, continuity) mentioned in story
  const completeNarratives = (
    adapter
      .prepare(
        `
    SELECT COUNT(*) as count FROM decisions
    WHERE evidence IS NOT NULL AND evidence != ''
      AND alternatives IS NOT NULL AND alternatives != ''
      AND risks IS NOT NULL AND risks != ''
  `
      )
      .get() as DBCountResult
  ).count;

  const narrativeCoverage = (completeNarratives / totalDecisions) * 100;

  // Link coverage: Decisions with at least one link
  const decisionsWithLinks = (
    adapter
      .prepare(
        `
    SELECT COUNT(DISTINCT d.id) as count FROM decisions d
    WHERE EXISTS (
      SELECT 1 FROM decision_edges e
      WHERE e.from_id = d.id OR e.to_id = d.id
    )
  `
      )
      .get() as DBCountResult
  ).count;

  const linkCoverage = (decisionsWithLinks / totalDecisions) * 100;

  return {
    narrativeCoverage: `${narrativeCoverage.toFixed(1)}%`,
    linkCoverage: `${linkCoverage.toFixed(1)}%`,
    totalDecisions,
    completeNarratives,
    decisionsWithLinks,
  };
}

/**
 * Log restart attempt (Epic 4 - Story 4.2)
 *
 * Records restart attempt with success/failure status, latency, and mode.
 * Replaces in-memory restart-metrics.js with SQLite-backed storage.
 *
 * @param {string} sessionId - Session identifier
 * @param {string} status - 'success' or 'failure'
 * @param {string|null} failureReason - 'NO_CHECKPOINT', 'LOAD_ERROR', 'CONTEXT_INCOMPLETE', or null
 * @param {number} latencyMs - Latency in milliseconds
 * @param {string} mode - 'full' (narrative+links) or 'summary' (summary only)
 * @returns {void}
 */
function logRestartAttempt(
  sessionId: string,
  status: string,
  failureReason: string | null,
  latencyMs: number,
  mode: string = 'full'
): void {
  const adapter = getAdapter();

  const timestamp = new Date().toISOString();

  adapter
    .prepare(
      `
    INSERT INTO restart_metrics (timestamp, session_id, status, failure_reason, latency_ms, mode)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(timestamp, sessionId, status, failureReason, latencyMs, mode);

  // Performance warning if exceeds threshold
  // Note: Using console.warn directly (not logWarn) because performance warnings
  // should always be visible regardless of MAMA_LOG_LEVEL setting
  const threshold = mode === 'summary' ? 1000 : 2500;
  if (latencyMs > threshold) {
    console.warn(
      JSON.stringify({
        performance_warning: true,
        message: `Restart latency exceeded threshold: ${latencyMs}ms > ${threshold}ms`,
        session_id: sessionId,
        mode,
        latency_ms: latencyMs,
        threshold_ms: threshold,
      })
    );
  }
}

/**
 * Calculate restart success rate (Epic 4 - Story 4.2)
 *
 * Calculates success rate over a given period (24h, 7d, 30d).
 *
 * @param {string} period - '24h', '7d', or '30d'
 * @returns {Object} Success rate metrics
 */
function calculateRestartSuccessRate(period: '24h' | '7d' | '30d' = '7d') {
  const adapter = getAdapter();

  const periodMap: PeriodMap = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
  };

  const days = periodMap[period] || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const stats = adapter
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'success' THEN 1 END) as success,
      COUNT(CASE WHEN status = 'failure' THEN 1 END) as failure
    FROM restart_metrics
    WHERE timestamp >= ?
  `
    )
    .get(since) as { total: number; success: number; failure: number };

  const successRate = stats.total > 0 ? stats.success / stats.total : 0;

  return {
    period,
    total: stats.total,
    success: stats.success,
    failure: stats.failure,
    successRate: `${(successRate * 100).toFixed(1)}%`,
    meetsTarget: successRate >= 0.95,
  };
}

/**
 * Calculate restart latency percentiles (Epic 4 - Story 4.2)
 *
 * Calculates p50, p95, p99 latencies for successful restarts.
 * Optionally filters by mode (full/summary).
 *
 * @param {string} period - '24h', '7d', or '30d'
 * @param {string|null} mode - 'full', 'summary', or null (all modes)
 * @returns {Object} Latency percentile metrics
 */
function calculateRestartLatency(period: '24h' | '7d' | '30d' = '7d', mode: string | null = null) {
  const adapter = getAdapter();

  const periodMap: PeriodMap = { '24h': 1, '7d': 7, '30d': 30 };
  const days = periodMap[period] || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `
    SELECT latency_ms
    FROM restart_metrics
    WHERE timestamp >= ? AND status = 'success'
  `;

  const params: string[] = [since];

  if (mode) {
    query += ` AND mode = ?`;
    params.push(mode);
  }

  query += ` ORDER BY latency_ms ASC`;

  const rows = adapter.prepare(query).all(...params) as { latency_ms: number }[];
  const latencies = rows.map((r: { latency_ms: number }) => r.latency_ms);

  if (latencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0, mode: mode || 'all' };
  }

  const percentile = (arr: number[], p: number): number => {
    const index = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, index)];
  };

  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    count: latencies.length,
    mode: mode || 'all',
  };
}

/**
 * Get restart metrics (Epic 4 - Story 4.2)
 *
 * Combines success rate and latency metrics for a given period.
 *
 * @param {string} period - '24h', '7d', or '30d'
 * @param {boolean} includeLatency - Whether to include latency percentiles
 * @returns {Object} Combined restart metrics
 */
function getRestartMetrics(period: '24h' | '7d' | '30d' = '7d', includeLatency = true) {
  const successRate = calculateRestartSuccessRate(period);
  const result: {
    successRate: ReturnType<typeof calculateRestartSuccessRate>;
    latency?: {
      full: ReturnType<typeof calculateRestartLatency>;
      summary: ReturnType<typeof calculateRestartLatency>;
    };
  } = { successRate };

  if (includeLatency) {
    result.latency = {
      full: calculateRestartLatency(period, 'full'),
      summary: calculateRestartLatency(period, 'summary'),
    };
  }

  return result;
}

/**
 * Calculate quality metrics (Epic 4 - Story 4.1)
 *
 * Measures narrative quality (field completeness per layer)
 * and link quality (rich reason ratio, approved link ratio).
 *
 * @returns {Object} Quality metrics
 */
function calculateQuality() {
  const adapter = getAdapter();

  // Narrative quality: Average completeness for each narrative field
  const narrativeQuality = adapter
    .prepare(
      `
    SELECT
      AVG(CASE WHEN evidence IS NOT NULL AND evidence != '' THEN 1 ELSE 0 END) as evidence,
      AVG(CASE WHEN alternatives IS NOT NULL AND alternatives != '' THEN 1 ELSE 0 END) as alternatives,
      AVG(CASE WHEN risks IS NOT NULL AND risks != '' THEN 1 ELSE 0 END) as risks
    FROM decisions
  `
    )
    .get() as { evidence: number; alternatives: number; risks: number };

  // Link quality: "Rich" reason ratio (reason > 50 chars) and approved link ratio
  const linkStats = adapter
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN reason IS NOT NULL AND LENGTH(reason) > 50 THEN 1 END) as rich,
      COUNT(CASE WHEN approved_by_user = 1 THEN 1 END) as approved
    FROM decision_edges
  `
    )
    .get() as { total: number; rich: number; approved: number };

  const linkQuality =
    linkStats.total > 0 ? ((linkStats.rich / linkStats.total) * 100).toFixed(1) : '0.0';
  const approvedRatio =
    linkStats.total > 0 ? ((linkStats.approved / linkStats.total) * 100).toFixed(1) : '0.0';

  return {
    narrativeQuality: {
      evidence: `${(narrativeQuality.evidence * 100).toFixed(1)}%`,
      alternatives: `${(narrativeQuality.alternatives * 100).toFixed(1)}%`,
      risks: `${(narrativeQuality.risks * 100).toFixed(1)}%`,
    },
    linkQuality: {
      richReasonRatio: `${linkQuality}%`,
      approvedRatio: `${approvedRatio}%`,
      totalLinks: linkStats.total,
      richLinks: linkStats.rich,
      approvedLinks: linkStats.approved,
    },
  };
}

/**
 * Generate quality report with recommendations (Epic 4 - Story 4.1 + 4.2)
 *
 * Generates a comprehensive quality report with coverage, quality metrics,
 * restart metrics, and recommendations for improvement.
 *
 * @param {Object} options - Report options
 * @param {string} [options.format='json'] - Output format: 'json' or 'markdown'
 * @param {string} [options.period='7d'] - Period for restart metrics: '24h', '7d', or '30d'
 * @param {Object} [options.thresholds] - Custom thresholds
 * @param {number} [options.thresholds.narrativeCoverage=0.8] - Narrative coverage threshold (0-1)
 * @param {number} [options.thresholds.linkCoverage=0.7] - Link coverage threshold (0-1)
 * @param {number} [options.thresholds.richReasonRatio=0.7] - Rich reason ratio threshold (0-1)
 * @param {number} [options.thresholds.restartSuccessRate=0.95] - Restart success rate threshold (0-1)
 * @param {number} [options.thresholds.restartLatencyP95Full=2500] - Full mode p95 latency threshold (ms)
 * @param {number} [options.thresholds.restartLatencyP95Summary=1000] - Summary mode p95 latency threshold (ms)
 * @returns {Object|string} Quality report as JSON or Markdown
 */
function generateQualityReport(options: QualityReportOptions = {}) {
  const { format = 'json', period = '7d', thresholds = {} } = options;

  const defaultThresholds = {
    narrativeCoverage: 0.8,
    linkCoverage: 0.7,
    richReasonRatio: 0.7,
    restartSuccessRate: 0.95,
    restartLatencyP95Full: 2500,
    restartLatencyP95Summary: 1000,
    ...thresholds,
  };

  const coverage = calculateCoverage();
  const quality = calculateQuality();

  // Story 4.2: Add restart metrics
  const validPeriod = (['24h', '7d', '30d'].includes(period || '7d') ? period : '7d') as
    | '24h'
    | '7d'
    | '30d';
  const restartMetrics = getRestartMetrics(validPeriod, true);

  const recommendations = [];

  // Check narrative coverage threshold
  const narrativeCoveragePct = parseFloat(coverage.narrativeCoverage);
  if (narrativeCoveragePct < defaultThresholds.narrativeCoverage * 100) {
    recommendations.push({
      type: 'narrative_coverage',
      message: `Narrative coverage below target (${defaultThresholds.narrativeCoverage * 100}%). Add narrative to decisions missing evidence, alternatives, or risks fields.`,
      target: `${defaultThresholds.narrativeCoverage * 100}%`,
      current: coverage.narrativeCoverage,
    });
  }

  // Check link coverage threshold
  const linkCoveragePct = parseFloat(coverage.linkCoverage);
  if (linkCoveragePct < defaultThresholds.linkCoverage * 100) {
    recommendations.push({
      type: 'link_coverage',
      message: `Link coverage below target (${defaultThresholds.linkCoverage * 100}%). Add links between related decisions.`,
      target: `${defaultThresholds.linkCoverage * 100}%`,
      current: coverage.linkCoverage,
    });
  }

  // Check link quality threshold
  const richReasonRatioPct = parseFloat(quality.linkQuality.richReasonRatio);
  if (richReasonRatioPct < defaultThresholds.richReasonRatio * 100) {
    recommendations.push({
      type: 'link_quality',
      message: `Link quality below target (${defaultThresholds.richReasonRatio * 100}%). Add specific causality and evidence to link reason fields.`,
      target: `${defaultThresholds.richReasonRatio * 100}%`,
      current: quality.linkQuality.richReasonRatio,
    });
  }

  // Story 4.2: Check restart success rate threshold (only if there's data)
  if (restartMetrics.successRate.total > 0 && !restartMetrics.successRate.meetsTarget) {
    const _successRatePct = parseFloat(restartMetrics.successRate.successRate);
    recommendations.push({
      type: 'restart_success_rate',
      message: `Restart success rate below target (95%). Analyze failure reasons and improve checkpoint quality.`,
      target: '95%',
      current: restartMetrics.successRate.successRate,
    });
  }

  // Story 4.2: Check restart latency thresholds (only if there's data)
  if (restartMetrics.latency) {
    const fullP95 = restartMetrics.latency.full.p95;
    if (
      restartMetrics.latency.full.count > 0 &&
      fullP95 > defaultThresholds.restartLatencyP95Full
    ) {
      recommendations.push({
        type: 'restart_latency_full',
        message: `Narrative+link expansion p95 latency exceeds target (2.5s). Consider limiting link expansion depth or adding caching.`,
        target: `${defaultThresholds.restartLatencyP95Full}ms`,
        current: `${fullP95}ms`,
      });
    }

    const summaryP95 = restartMetrics.latency.summary.p95;
    if (
      restartMetrics.latency.summary.count > 0 &&
      summaryP95 > defaultThresholds.restartLatencyP95Summary
    ) {
      recommendations.push({
        type: 'restart_latency_summary',
        message: `Summary mode p95 latency exceeds target (1.0s). Review query optimization or add indexes.`,
        target: `${defaultThresholds.restartLatencyP95Summary}ms`,
        current: `${summaryP95}ms`,
      });
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    period,
    coverage,
    quality,
    restart: restartMetrics,
    thresholds: defaultThresholds,
    recommendations,
    format,
  };

  if (format === 'markdown') {
    return formatQualityReportMarkdown(report);
  }

  return report;
}

/**
 * Format quality report as Markdown
 *
 * @param {Object} report - Quality report data
 * @returns {string} Markdown-formatted report
 */
function formatQualityReportMarkdown(report: {
  generated_at: string;
  period: string | null;
  coverage: {
    narrativeCoverage: string;
    linkCoverage: string;
    totalDecisions: number;
    completeNarratives: number;
    decisionsWithLinks: number;
  };
  quality: {
    narrativeQuality: { evidence: string; alternatives: string; risks: string };
    linkQuality: {
      richReasonRatio: string;
      approvedRatio: string;
      totalLinks: number;
      richLinks: number;
      approvedLinks: number;
    };
  };
  restart: ReturnType<typeof getRestartMetrics>;
  thresholds: Record<string, number>;
  recommendations: Array<{
    type: string;
    message: string;
    target?: string | number;
    current?: string | number;
  }>;
}): string {
  const { generated_at, period, coverage, quality, restart, thresholds, recommendations } = report;

  let markdown = `# 📊 MAMA Quality Report\n\n`;
  markdown += `Generated: ${generated_at}\n`;
  markdown += `Period: ${period}\n\n`;

  markdown += `## Coverage Metrics\n\n`;
  markdown += `- **Narrative Coverage**: ${coverage.narrativeCoverage} (${coverage.completeNarratives}/${coverage.totalDecisions} decisions)\n`;
  markdown += `- **Link Coverage**: ${coverage.linkCoverage} (${coverage.decisionsWithLinks}/${coverage.totalDecisions} decisions)\n\n`;

  markdown += `## Quality Metrics\n\n`;
  markdown += `### Narrative Quality\n`;
  markdown += `- Evidence: ${quality.narrativeQuality.evidence}\n`;
  markdown += `- Alternatives: ${quality.narrativeQuality.alternatives}\n`;
  markdown += `- Risks: ${quality.narrativeQuality.risks}\n\n`;

  markdown += `### Link Quality\n`;
  markdown += `- Rich Reason Ratio: ${quality.linkQuality.richReasonRatio} (${quality.linkQuality.richLinks}/${quality.linkQuality.totalLinks} links)\n`;
  markdown += `- Approved Link Ratio: ${quality.linkQuality.approvedRatio} (${quality.linkQuality.approvedLinks}/${quality.linkQuality.totalLinks} links)\n\n`;

  // Story 4.2: Add restart metrics section
  if (restart) {
    markdown += `## Restart Metrics\n\n`;
    markdown += `### Success Rate\n`;
    markdown += `- **Success Rate**: ${restart.successRate.successRate} (${restart.successRate.success}/${restart.successRate.total} attempts)\n`;
    markdown += `- **Meets Target**: ${restart.successRate.meetsTarget ? '✅ Yes' : '❌ No'}\n`;
    markdown += `- Failures: ${restart.successRate.failure}\n\n`;

    if (restart.latency) {
      markdown += `### Latency (Percentiles)\n\n`;
      markdown += `**Full Mode (Narrative + Links)**\n`;
      markdown += `- p50: ${restart.latency.full.p50}ms\n`;
      markdown += `- p95: ${restart.latency.full.p95}ms\n`;
      markdown += `- p99: ${restart.latency.full.p99}ms\n`;
      markdown += `- Count: ${restart.latency.full.count}\n\n`;

      markdown += `**Summary Mode**\n`;
      markdown += `- p50: ${restart.latency.summary.p50}ms\n`;
      markdown += `- p95: ${restart.latency.summary.p95}ms\n`;
      markdown += `- p99: ${restart.latency.summary.p99}ms\n`;
      markdown += `- Count: ${restart.latency.summary.count}\n\n`;
    }
  }

  markdown += `## Thresholds\n\n`;
  markdown += `- Narrative Coverage: ≥ ${thresholds.narrativeCoverage * 100}%\n`;
  markdown += `- Link Coverage: ≥ ${thresholds.linkCoverage * 100}%\n`;
  markdown += `- Rich Reason Ratio: ≥ ${thresholds.richReasonRatio * 100}%\n`;
  markdown += `- Restart Success Rate: ≥ ${thresholds.restartSuccessRate * 100}%\n`;
  markdown += `- Restart Latency p95 (Full): ≤ ${thresholds.restartLatencyP95Full}ms\n`;
  markdown += `- Restart Latency p95 (Summary): ≤ ${thresholds.restartLatencyP95Summary}ms\n\n`;

  if (recommendations.length > 0) {
    markdown += `## ⚠️ Recommendations\n\n`;
    recommendations.forEach((rec, idx) => {
      markdown += `${idx + 1}. **${rec.type}**: ${rec.message}\n`;
      markdown += `   - Target: ${rec.target}, Current: ${rec.current}\n\n`;
    });
  } else {
    markdown += `## ✅ All quality targets met!\n\n`;
  }

  return markdown;
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
  suggest,
  list: listDecisions,
  listCheckpoints,
  updateOutcome,
  saveCheckpoint,
  loadCheckpoint,
  // Legacy functions (retained for internal use, not exposed via MCP)
  recall,
  proposeLink,
  approveLink,
  rejectLink,
  getPendingLinks,
  deprecateAutoLinks,
  calculateCoverage,
  calculateQuality,
  generateQualityReport,
  logRestartAttempt,
  calculateRestartSuccessRate,
  calculateRestartLatency,
  getRestartMetrics,
  scanAutoLinks,
  createLinkBackup,
  generatePreCleanupReport,
  restoreLinkBackup,
  verifyBackupExists,
  deleteAutoLinks,
  validateCleanupResult,
};

// Named exports for ESM consumers
export {
  save,
  suggest,
  listDecisions as list,
  listCheckpoints,
  updateOutcome,
  saveCheckpoint,
  loadCheckpoint,
  recall,
  proposeLink,
  approveLink,
  rejectLink,
  getPendingLinks,
  deprecateAutoLinks,
  calculateCoverage,
  calculateQuality,
  generateQualityReport,
  logRestartAttempt,
  calculateRestartSuccessRate,
  calculateRestartLatency,
  getRestartMetrics,
  scanAutoLinks,
  createLinkBackup,
  generatePreCleanupReport,
  restoreLinkBackup,
  verifyBackupExists,
  deleteAutoLinks,
  validateCleanupResult,
};

// Default export for backward compatibility
export default mama;

// CommonJS compatibility - allows require('@jungjaehoon/mama-core/mama-api').save()
if (typeof module !== 'undefined' && module.exports) {
  module.exports = mama;
  module.exports.default = mama;
}
