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
import { initDB, insertDecisionWithEmbedding, getAdapter } from './memory-store.js';
import type { DatabaseAdapter } from './db-manager.js';

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

/**
 * Decision record from database
 */
export interface DecisionRecord {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string;
  outcome?: string | null;
  failure_reason?: string | null;
  confidence: number;
  supersedes?: string | null;
  superseded_by?: string | null;
  created_at: number;
  updated_at?: number;
}

/**
 * Learn decision result
 */
export interface LearnDecisionResult {
  decisionId: string;
  notification: unknown | null;
}

/**
 * Parsed relationship from reasoning
 */
export interface ParsedRelationship {
  type: string;
  targetIds: string[];
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
    const stmt = adapter.prepare(`
      INSERT OR REPLACE INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
      VALUES (?, ?, ?, ?, ?, 'llm', 1)
    `);

    stmt.run(fromId, toId, relationship, reason, Date.now());
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
 * Update previous decision's superseded_by field
 *
 * Task 3.5: Update previous decision's superseded_by field
 * AC #2: Previous decision's superseded_by field updated
 *
 * @param previousId - Previous decision ID
 * @param newId - New decision ID
 */
export async function markSuperseded(previousId: string, newId: string): Promise<void> {
  const adapter = getAdapter() as unknown as DatabaseAdapter;

  try {
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET superseded_by = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(newId, Date.now(), previousId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to mark decision as superseded: ${message}`);
  }
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
  const parentConfidences = parents.map((p) => p.confidence || 0.5);
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
// Story 2.2: Reasoning Field Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse reasoning field for relationship references
 *
 * Story 2.2: Detect patterns like:
 * - builds_on: <decision_id>
 * - debates: <decision_id>
 * - synthesizes: [id1, id2]
 *
 * @param reasoning - Decision reasoning text
 * @returns Detected relationships
 */
export function parseReasoningForRelationships(reasoning: string): ParsedRelationship[] {
  if (!reasoning || typeof reasoning !== 'string') {
    return [];
  }

  const relationships: ParsedRelationship[] = [];

  // Pattern 1: builds_on: <id> (allows optional markdown **bold**)
  const buildsOnMatch = reasoning.match(
    /\*{0,2}builds_on\*{0,2}:\*{0,2}\s*(decision_[a-z0-9_]+)/gi
  );
  if (buildsOnMatch) {
    buildsOnMatch.forEach((match) => {
      const id = match.replace(/\*{0,2}builds_on\*{0,2}:\*{0,2}\s*/i, '').trim();
      if (id) {
        relationships.push({ type: 'builds_on', targetIds: [id] });
      }
    });
  }

  // Pattern 2: debates: <id> (allows optional markdown **bold**)
  const debatesMatch = reasoning.match(/\*{0,2}debates\*{0,2}:\*{0,2}\s*(decision_[a-z0-9_]+)/gi);
  if (debatesMatch) {
    debatesMatch.forEach((match) => {
      const id = match.replace(/\*{0,2}debates\*{0,2}:\*{0,2}\s*/i, '').trim();
      if (id) {
        relationships.push({ type: 'debates', targetIds: [id] });
      }
    });
  }

  // Pattern 3: synthesizes: [id1, id2] (allows optional markdown **bold**)
  const synthesizesMatch = reasoning.match(
    /\*{0,2}synthesizes\*{0,2}:\*{0,2}\s*\[?\s*(decision_[a-z0-9_]+(?:\s*,\s*decision_[a-z0-9_]+)*)\s*\]?/gi
  );
  if (synthesizesMatch) {
    synthesizesMatch.forEach((match) => {
      const idsStr = match
        .replace(/\*{0,2}synthesizes\*{0,2}:\*{0,2}\s*\[?\s*/i, '')
        .replace(/\s*\]?\s*$/, '');
      const ids = idsStr.split(/\s*,\s*/).filter((id) => id.startsWith('decision_'));
      if (ids.length > 0) {
        relationships.push({ type: 'synthesizes', targetIds: ids });
      }
    });
  }

  return relationships;
}

/**
 * Create edges from parsed reasoning relationships
 *
 * Story 2.2: Auto-create edges when reasoning references other decisions
 *
 * @param fromId - Source decision ID
 * @param reasoning - Decision reasoning text
 * @returns Edge creation stats
 */
export async function createEdgesFromReasoning(
  fromId: string,
  reasoning: string
): Promise<{ created: number; failed: number }> {
  const relationships = parseReasoningForRelationships(reasoning);
  let created = 0;
  let failed = 0;

  for (const rel of relationships) {
    for (const targetId of rel.targetIds) {
      try {
        // Verify target decision exists
        const adapter = getAdapter() as unknown as DatabaseAdapter;
        const stmt = adapter.prepare('SELECT id FROM decisions WHERE id = ?');
        const target = stmt.get(targetId);

        if (!target) {
          info(`[decision-tracker] Referenced decision not found: ${targetId}, skipping edge`);
          failed++;
          continue;
        }

        // Create the edge
        const reason = `Auto-detected from reasoning: ${rel.type} reference`;
        const success = await createEdge(fromId, targetId, rel.type, reason);

        if (success) {
          created++;
          info(`[decision-tracker] Created ${rel.type} edge: ${fromId} -> ${targetId}`);
        } else {
          failed++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        info(`[decision-tracker] Failed to create edge to ${targetId}: ${message}`);
        failed++;
      }
    }
  }

  return { created, failed };
}

/**
 * Get supersedes chain depth for a topic
 *
 * Story 2.2: Calculate how many times a topic has been superseded
 *
 * @param topic - Decision topic
 * @returns Chain depth and decision IDs
 */
export async function getSupersededChainDepth(
  topic: string
): Promise<{ depth: number; chain: string[] }> {
  const adapter = getAdapter() as unknown as DatabaseAdapter;
  const chain: string[] = [];

  try {
    // Start from the latest decision (superseded_by IS NULL)
    let stmt = adapter.prepare(`
      SELECT id, supersedes FROM decisions
      WHERE topic = ? AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    let current = stmt.get(topic) as { id: string; supersedes?: string } | undefined;

    if (!current) {
      return { depth: 0, chain: [] };
    }

    chain.push(current.id);

    // Walk back through supersedes chain
    while (current && current.supersedes) {
      stmt = adapter.prepare('SELECT id, supersedes FROM decisions WHERE id = ?');
      current = stmt.get(current.supersedes) as { id: string; supersedes?: string } | undefined;

      if (current) {
        chain.push(current.id);
      }
    }

    return {
      depth: chain.length - 1, // depth = number of supersedes edges
      chain: chain.reverse(), // oldest to newest
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get supersedes chain: ${message}`);
  }
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
 * Task 3.8: Store in vss_memories (link via rowid)
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

    // AC #1: Decision stored with outcome=NULL, confidence from LLM
    const decision = {
      id: decisionId,
      topic: detection.topic,
      decision: detection.decision,
      reasoning: detection.reasoning,
      outcome: null, // AC #1: outcome=NULL (not yet tracked)
      failure_reason: null,
      limitation: null,
      user_involvement: 'requested', // Inferred from tool execution
      session_id: sessionContext.session_id,
      supersedes: previous ? previous.id : null,
      superseded_by: null,
      refined_from: refinedFrom, // AC #5: Multi-parent refinement
      confidence: finalConfidence, // AC #1, AC #5: Confidence from LLM
      needs_validation: needsValidation, // Story 014.7.6: AC #1 - Validation for assistant insights
      validation_attempts: 0, // Story 014.7.6: Track skip count
      usage_count: 0, // Story 014.7.6: Track usage for periodic review
      created_at: toolExecution.timestamp || Date.now(),
      updated_at: Date.now(),
      // Story 014.7.10: Add trust_context for Claude-Friendly Context Formatting
      trust_context: detection.trust_context ? JSON.stringify(detection.trust_context) : null,
      // Story 2.1: 5-layer narrative fields
      evidence: detection.evidence
        ? Array.isArray(detection.evidence)
          ? JSON.stringify(detection.evidence)
          : detection.evidence
        : null,
      alternatives: detection.alternatives
        ? Array.isArray(detection.alternatives)
          ? JSON.stringify(detection.alternatives)
          : detection.alternatives
        : null,
      risks: detection.risks || null,
    };

    // Task 3.7, 3.8: Generate enhanced embedding and store in vss_memories
    // (Handled by insertDecisionWithEmbedding function)
    await insertDecisionWithEmbedding(decision);

    // ════════════════════════════════════════════════════════
    // Task 3.5: Create Supersedes Relationship (if previous exists)
    // ════════════════════════════════════════════════════════
    if (previous) {
      // AC #2: Supersedes relationship creation
      const reason = `User changed from "${previous.decision}" to "${detection.decision}"`;

      // Create edge: new decision → previous decision
      await createSupersedesEdge(decisionId, previous.id, reason);

      // Update previous decision's superseded_by field
      await markSuperseded(previous.id, decisionId);
    }

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
      decisionId,
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
