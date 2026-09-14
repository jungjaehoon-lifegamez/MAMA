/**
 * MAMA (Memory-Augmented MCP Architecture) - Decision Tracker
 *
 * Learn and store decisions with graph relationships
 * Tasks: 3.1-3.9 (Learn decision, ID generation, supersedes edges, refinement, embeddings)
 * AC #1: Decision stored with outcome=NULL, confidence from LLM
 * AC #2: Supersedes relationship creation
 * AC #5: Multi-parent refinement with confidence calculation
 *
 * Updated for PostgreSQL compatibility via db-manager
 *
 * @module decision-tracker
 * @version 2.0
 * @date 2025-11-17
 */

import { info } from './debug-logger.js';
import { initDB, getAdapter } from './memory-store.js';
import type { DatabaseAdapter, DecisionInput, DecisionRecord } from './db-manager.js';
import { appendJudgment, upsertDecisionEdge } from './knowledge/index.js';
import { commandEmbedder, unsignedWriteAccess } from './memory/write-adapters.js';
import type { JudgmentCommand } from './memory/judgment-types.js';

// Re-export DecisionRecord for consumers
export type { DecisionRecord };

// ════════════════════════════════════════════════════════════════════════════
// Story 2.1: Extended Edge Types
// ════════════════════════════════════════════════════════════════════════════
// Valid relationship types for decision_edges
// Original: supersedes, refines, contradicts
// v1.3 Extension: builds_on, debates, synthesizes
export const VALID_EDGE_TYPES = [
  'supersedes', // Original: New decision replaces old one
  'refines', // Original: Decision refines another
  'contradicts', // Original: Decision contradicts another
  'builds_on', // v1.3: Extends existing decision with new insights
  'debates', // v1.3: Presents counter-argument with evidence
  'synthesizes', // v1.3: Merges multiple decisions into unified approach
] as const;

export type EdgeType = (typeof VALID_EDGE_TYPES)[number];

/**
 * Decision detection result from analysis
 */
export interface DecisionDetection {
  topic: string;
  decision: string;
  reasoning: string;
  confidence: number;
  type?: string;
  trust_context?: Record<string, unknown>;
  evidence?: string | string[];
  alternatives?: string | string[];
  risks?: string;
}

/**
 * Tool execution context
 */
export interface ToolExecution {
  timestamp?: number;
  tool_name?: string;
  tool_input?: unknown;
  exit_code?: number;
}

/**
 * Session context for decision tracking
 */
export interface SessionContext {
  session_id?: string;
  latest_user_message?: string;
  recent_exchange?: string;
}

// DecisionRecord is imported from db-manager.ts (canonical source)

/**
 * Learn decision result
 */
export interface LearnDecisionResult {
  decisionId: string;
  notification: unknown | null;
}

/**
 * Generate decision ID
 *
 * Task 3.2: Generate decision ID: `decision_${topic}_${timestamp}`
 *
 * @param topic - Decision topic
 * @returns Decision ID
 */
export function generateDecisionId(topic: string): string {
  // Sanitize topic: remove spaces, lowercase, max 50 chars
  const sanitized = topic
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 50);

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 6);

  return `decision_${sanitized}_${timestamp}_${random}`;
}

/**
 * Check for previous decision on same topic
 *
 * Task 3.3: Query decisions table WHERE topic=? AND superseded_by IS NULL
 * AC #2: Find previous decision to create supersedes relationship
 *
 * @param topic - Decision topic
 * @returns Previous decision or null
 */
export async function getPreviousDecision(topic: string): Promise<DecisionRecord | null> {
  const adapter = getAdapter() as unknown as DatabaseAdapter;

  try {
    const stmt = adapter.prepare(`
      SELECT * FROM decisions
      WHERE topic = ? AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const previous = stmt.get(topic) as DecisionRecord | undefined;
    return previous || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to query previous decision: ${message}`);
  }
}

/**
 * Create a decision edge with specified relationship type
 *
 * Story 2.1: Generic edge creation supporting all relationship types
 *
 * @param fromId - Source decision ID
 * @param toId - Target decision ID
 * @param relationship - Edge type (supersedes, builds_on, debates, synthesizes, etc.)
 * @param reason - Reason for the relationship
 * @returns Success status
 */
export async function createEdge(
  fromId: string,
  toId: string,
  relationship: string,
  reason: string
): Promise<boolean> {
  const adapter = getAdapter() as unknown as DatabaseAdapter;

  // Story 2.1: Runtime validation of edge types
  if (!VALID_EDGE_TYPES.includes(relationship as EdgeType)) {
    throw new Error(
      `Invalid edge type: "${relationship}". Valid types: ${VALID_EDGE_TYPES.join(', ')}`
    );
  }

  try {
    // Note: SQLite CHECK constraint only allows supersedes/refines/contradicts
    // New types (builds_on, debates, synthesizes) bypass CHECK via runtime validation
    // The INSERT will fail for new types due to CHECK constraint
    // WORKAROUND: Use PRAGMA ignore_check_constraints or recreate table
    // For now, we'll catch the error and handle gracefully

    // Story 2.1: LLM auto-detected edges are approved by default (approved_by_user=1)
    // This allows them to appear in search results via querySemanticEdges
    upsertDecisionEdge(adapter, {
      fromId,
      toId,
      relationship,
      reason,
      createdBy: 'llm',
      approvedByUser: 1,
      decisionId: null,
      evidence: null,
      createdAt: Date.now(),
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Handle CHECK constraint failure for new edge types
    if (message.includes('CHECK constraint failed')) {
      info(
        `[decision-tracker] Edge type "${relationship}" not yet supported in schema, skipping edge creation`
      );
      return false;
    }
    throw new Error(`Failed to create ${relationship} edge: ${message}`);
  }
}

/**
 * Create supersedes edge
 *
 * Task 3.5: Create supersedes edge (INSERT INTO decision_edges)
 * AC #2: Supersedes relationship creation
 *
 * @param fromId - New decision ID
 * @param toId - Previous decision ID
 * @param reason - Reason for superseding
 */
export async function createSupersedesEdge(
  fromId: string,
  toId: string,
  reason: string
): Promise<boolean> {
  return createEdge(fromId, toId, 'supersedes', reason);
}

/**
 * Calculate combined confidence (Bayesian update)
 *
 * Task 3.6: Calculate combined confidence for multi-parent refinement
 * AC #5: Confidence score calculated based on history
 *
 * @param prior - Prior confidence
 * @param parents - Parent decisions
 * @returns Updated confidence (0.0-1.0)
 */
export function calculateCombinedConfidence(
  prior: number,
  parents: Array<{ confidence?: number }>
): number {
  if (!parents || parents.length === 0) {
    return prior;
  }

  // Bayesian update: Average parent confidences + prior
  const parentConfidences = parents.map((p) => p.confidence ?? 0.5);
  const avgParentConfidence =
    parentConfidences.reduce((a, b) => a + b, 0) / parentConfidences.length;

  // Weighted average: 60% prior, 40% parent history
  const combined = prior * 0.6 + avgParentConfidence * 0.4;

  // Clamp to [0.0, 1.0]
  return Math.max(0, Math.min(1, combined));
}

/**
 * Detect multi-parent refinement
 *
 * Task 3.6: Detect if new decision refines multiple previous decisions
 * AC #5: Multi-parent refinement
 *
 * @param _detection - Decision detection result
 * @param _sessionContext - Session context
 * @returns Array of parent decision IDs or null
 */
export function detectRefinement(
  _detection: DecisionDetection,
  _sessionContext: SessionContext
): string[] | null {
  // Refinement detection not implemented; currently returns null for single-parent only.
  // Multi-parent refinement detection would analyze session context for references
  // to multiple decisions (e.g., "combine", "merge", user mentioning multiple topics).
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// NOTE: Auto-link functions REMOVED in v1.2.0
//
// Removed functions:
//   - createRefinesEdge
//   - detectConflicts
//   - createContradictsEdge
//   - findRelatedDecisions
//   - isConflicting
//
// Reason: LLM can infer decision evolution from time-ordered search results.
// Auto-links created 366 noise edges (100% cross-topic).
// Only supersedes (same topic) is reliable.
//
// See: CHANGELOG.md v1.2.0 - 2025-11-25
// ════════════════════════════════════════════════════════════════════════════

/**
 * Learn Decision Function (Main API)
 *
 * Task 3.1: Create Learn Decision Function
 * Task 3.2: Generate decision ID
 * Task 3.3: Check for previous decision on same topic
 * Task 3.4: Insert new decision with outcome=NULL, confidence from LLM
 * Task 3.5: If previous exists: Create supersedes edge, Update previous superseded_by
 * Task 3.6: If multi-parent refinement: Store refined_from, Calculate combined confidence
 * Task 3.7: Generate enhanced embedding
 * Task 3.8: Store embedding (link via rowid)
 *
 * AC #1: Decision stored with outcome=NULL, confidence from LLM
 * AC #2: Supersedes relationship creation
 * AC #5: Multi-parent refinement with confidence calculation
 *
 * @param detection - Decision detection result
 * @param toolExecution - Tool execution data
 * @param sessionContext - Session context
 * @returns decisionId and notification
 */
export async function learnDecision(
  detection: DecisionDetection,
  toolExecution: ToolExecution,
  sessionContext: SessionContext
): Promise<LearnDecisionResult> {
  try {
    // Ensure database is initialized
    await initDB();

    // ════════════════════════════════════════════════════════
    // Task 3.2: Generate Decision ID
    // ════════════════════════════════════════════════════════
    const decisionId = generateDecisionId(detection.topic);

    // ════════════════════════════════════════════════════════
    // Task 3.3: Check for Previous Decision on Same Topic
    // ════════════════════════════════════════════════════════
    const previous = await getPreviousDecision(detection.topic);

    // ════════════════════════════════════════════════════════
    // Task 3.6: Detect Multi-Parent Refinement
    // ════════════════════════════════════════════════════════
    const refinedFrom = detectRefinement(detection, sessionContext);
    let finalConfidence = detection.confidence;

    if (refinedFrom && refinedFrom.length > 0) {
      // AC #5: Multi-parent refinement
      // Get parent decisions
      const adapter = getAdapter() as unknown as DatabaseAdapter;
      const stmt = adapter.prepare('SELECT * FROM decisions WHERE id = ?');

      const parents = refinedFrom.map(
        (parentId) => stmt.get(parentId) as DecisionRecord | undefined
      );
      const validParents = parents.filter(
        (p): p is DecisionRecord => p !== undefined && p !== null
      );

      // Calculate combined confidence
      finalConfidence = calculateCombinedConfidence(detection.confidence, validParents);
    }

    // ════════════════════════════════════════════════════════
    // Task 3.4: Insert New Decision
    // ════════════════════════════════════════════════════════
    // ════════════════════════════════════════════════════════
    // Story 014.7.6: Set needs_validation for assistant insights
    // ════════════════════════════════════════════════════════
    const isAssistantInsight = detection.type === 'assistant_insight';
    const needsValidation = isAssistantInsight ? 1 : 0;

    // AC #1: Decision stored with outcome=NULL, confidence from LLM.
    // One JudgmentCommand carries the record, the supersedes replacement, and
    // the graph edge; appendJudgment performs them in a single transaction.
    const adapter = getAdapter() as unknown as DatabaseAdapter;
    const evidenceText = detection.evidence
      ? Array.isArray(detection.evidence)
        ? JSON.stringify(detection.evidence)
        : detection.evidence
      : null;
    const alternativesText = detection.alternatives
      ? Array.isArray(detection.alternatives)
        ? JSON.stringify(detection.alternatives)
        : detection.alternatives
      : null;
    const embeddingDecision: DecisionInput = {
      id: decisionId,
      topic: detection.topic,
      decision: detection.decision,
      reasoning: detection.reasoning,
      outcome: null,
      confidence: finalConfidence,
    };
    const supersedesReason = previous
      ? `User changed from "${previous.decision}" to "${detection.decision}"`
      : null;
    const command: JudgmentCommand = {
      commandId: `learn:${decisionId}`,
      topic: detection.topic,
      summary: detection.decision,
      reasoning: detection.reasoning,
      recordKind: 'judgment',
      confidence: finalConfidence,
      scopes: [],
      evidence: evidenceText,
      alternatives: alternativesText,
      risks: detection.risks || null,
      // Unsigned write: the learned decision supersedes its predecessor through
      // the supersedeTargets projection (legacy semantics), not through the
      // scope-checked `replaces` command field.
      projections: previous
        ? {
            supersedeTargets: [previous.id],
            decisionEdges: [
              {
                targetId: previous.id,
                relationship: 'supersedes',
                reason: supersedesReason,
                weight: 1,
                createdBy: 'llm',
                approvedByUser: 1,
              },
            ],
          }
        : undefined,
      record: {
        kind: 'fact',
        status: 'active',
        userInvolvement: 'requested', // Inferred from tool execution
        sessionId: sessionContext.session_id ?? null,
        refinedFrom: refinedFrom ?? null,
        supersedes: previous ? previous.id : null,
        needsValidation, // Story 014.7.6: AC #1 - Validation for assistant insights
        trustContext: detection.trust_context ? JSON.stringify(detection.trust_context) : null,
      },
      recordedAt: toolExecution.timestamp || Date.now(),
      event: { reason: 'learned decision' },
    };
    const receipt = await appendJudgment(command, unsignedWriteAccess([]), {
      adapter,
      embedder: commandEmbedder(adapter, embeddingDecision),
    });
    const storedDecisionId = receipt.recordId;

    // ════════════════════════════════════════════════════════
    // NOTE: Auto-link generation (refines, contradicts) REMOVED
    //
    // Reason: LLM can infer decision evolution from time-ordered
    // search results. Auto-links created 366 noise edges (100%
    // cross-topic). Only supersedes (same topic) is reliable.
    //
    // See: 2025-11-25 discussion on decision tracking algorithm
    // ════════════════════════════════════════════════════════

    // ════════════════════════════════════════════════════════
    // Story 014.7.6: Generate notification if needs validation
    // ════════════════════════════════════════════════════════
    let notification: unknown = null;
    if (needsValidation) {
      const { notifyInsight } = await import('./notification-manager.js');
      // notifyInsight is a stub that returns null
      notification = notifyInsight();
    }

    // ════════════════════════════════════════════════════════
    // Task 3.9: Return decision ID (+ notification for Story 014.7.6)
    // ════════════════════════════════════════════════════════
    return {
      decisionId: storedDecisionId,
      notification, // null if no validation needed, notification object otherwise
    };
  } catch (error) {
    // CLAUDE.md Rule #1: No silent failures
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to learn decision: ${message}`);
  }
}

/**
 * Evidence item for confidence updates
 */
export interface EvidenceItem {
  type: 'success' | 'failure' | 'partial';
  impact: number;
}

/**
 * Update confidence score
 *
 * Task 6: Confidence evolution (used in outcome tracking)
 * AC #5: Confidence score calculated based on history
 *
 * @param prior - Prior confidence
 * @param evidence - Evidence items
 * @returns Updated confidence (0.0-1.0)
 */
export function updateConfidence(prior: number, evidence: EvidenceItem[]): number {
  if (!evidence || evidence.length === 0) {
    return prior;
  }

  // Calculate total impact
  const totalImpact = evidence.reduce((acc, e) => acc + e.impact, 0);

  // Update confidence
  const updated = prior + totalImpact;

  // Clamp to [0.0, 1.0]
  return Math.max(0, Math.min(1, updated));
}
