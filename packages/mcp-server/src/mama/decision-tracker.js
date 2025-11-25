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

// eslint-disable-next-line no-unused-vars
const { info, error: logError } = require('./debug-logger');
const {
  initDB,
  insertDecisionWithEmbedding,
  // eslint-disable-next-line no-unused-vars
  queryDecisionGraph,
  getAdapter,
} = require('./memory-store');

/**
 * Generate decision ID
 *
 * Task 3.2: Generate decision ID: `decision_${topic}_${timestamp}`
 *
 * @param {string} topic - Decision topic
 * @returns {string} Decision ID
 */
function generateDecisionId(topic) {
  // Sanitize topic: remove spaces, lowercase, max 50 chars
  const sanitized = topic
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 50);

  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 4);

  return `decision_${sanitized}_${timestamp}_${random}`;
}

/**
 * Check for previous decision on same topic
 *
 * Task 3.3: Query decisions table WHERE topic=? AND superseded_by IS NULL
 * AC #2: Find previous decision to create supersedes relationship
 *
 * @param {string} topic - Decision topic
 * @returns {Promise<Object|null>} Previous decision or null
 */
async function getPreviousDecision(topic) {
  const adapter = getAdapter();

  try {
    const stmt = adapter.prepare(`
      SELECT * FROM decisions
      WHERE topic = ? AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const previous = await stmt.get(topic);
    return previous || null;
  } catch (error) {
    throw new Error(`Failed to query previous decision: ${error.message}`);
  }
}

/**
 * Create supersedes edge
 *
 * Task 3.5: Create supersedes edge (INSERT INTO decision_edges)
 * AC #2: Supersedes relationship creation
 *
 * @param {string} fromId - New decision ID
 * @param {string} toId - Previous decision ID
 * @param {string} reason - Reason for superseding
 */
async function createSupersedesEdge(fromId, toId, reason) {
  const adapter = getAdapter();

  try {
    // Auto-generated links: created_by='llm', approved_by_user=0 (pending approval)
    // This ensures they appear in get_pending_links and require explicit approval
    const stmt = adapter.prepare(`
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
      VALUES (?, ?, 'supersedes', ?, ?, 'llm', 0)
    `);

    await stmt.run(fromId, toId, reason, Date.now());
  } catch (error) {
    throw new Error(`Failed to create supersedes edge: ${error.message}`);
  }
}

/**
 * Update previous decision's superseded_by field
 *
 * Task 3.5: Update previous decision's superseded_by field
 * AC #2: Previous decision's superseded_by field updated
 *
 * @param {string} previousId - Previous decision ID
 * @param {string} newId - New decision ID
 */
async function markSuperseded(previousId, newId) {
  const adapter = getAdapter();

  try {
    const stmt = adapter.prepare(`
      UPDATE decisions
      SET superseded_by = ?, updated_at = ?
      WHERE id = ?
    `);

    await stmt.run(newId, Date.now(), previousId);
  } catch (error) {
    throw new Error(`Failed to mark decision as superseded: ${error.message}`);
  }
}

/**
 * Calculate combined confidence (Bayesian update)
 *
 * Task 3.6: Calculate combined confidence for multi-parent refinement
 * AC #5: Confidence score calculated based on history
 *
 * @param {number} prior - Prior confidence
 * @param {Array<Object>} parents - Parent decisions
 * @returns {number} Updated confidence (0.0-1.0)
 */
function calculateCombinedConfidence(prior, parents) {
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
 * @param {Object} detection - Decision detection result
 * @param {Object} sessionContext - Session context
 * @returns {Array<string>|null} Array of parent decision IDs or null
 */
function detectRefinement(_detection, _sessionContext) {
  // TODO: Implement refinement detection heuristics
  // For now, return null (single-parent only)
  // Future: Analyze session context for references to multiple decisions

  // Example heuristics:
  // 1. User message mentions "combine", "merge", "refine"
  // 2. Recent exchange references multiple topics
  // 3. Decision reasoning mentions multiple approaches

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
 * Task 3.8: Store in vss_memories (link via rowid)
 *
 * AC #1: Decision stored with outcome=NULL, confidence from LLM
 * AC #2: Supersedes relationship creation
 * AC #5: Multi-parent refinement with confidence calculation
 *
 * @param {Object} detection - Decision detection result
 * @param {string} detection.topic - Decision topic
 * @param {string} detection.decision - Decision value
 * @param {string} detection.reasoning - Decision reasoning
 * @param {number} detection.confidence - Confidence score (0.0-1.0)
 * @param {Object} toolExecution - Tool execution data
 * @param {Object} sessionContext - Session context
 * @returns {Promise<Object>} { decisionId, notification }
 */
async function learnDecision(detection, toolExecution, sessionContext) {
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
      const adapter = getAdapter();
      const stmt = adapter.prepare('SELECT * FROM decisions WHERE id = ?');

      const parents = await Promise.all(
        refinedFrom.map(async (parentId) => await stmt.get(parentId))
      );
      const validParents = parents.filter(Boolean);

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
    let notification = null;
    if (needsValidation) {
      const { notifyInsight } = require('./notification-manager');
      notification = notifyInsight({
        id: decisionId,
        topic: decision.topic,
        decision: decision.decision,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        needs_validation: true,
        validation_attempts: 0,
      });
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
    throw new Error(`Failed to learn decision: ${error.message}`);
  }
}

/**
 * Update confidence score
 *
 * Task 6: Confidence evolution (used in outcome tracking)
 * AC #5: Confidence score calculated based on history
 *
 * @param {number} prior - Prior confidence
 * @param {Array<Object>} evidence - Evidence items
 * @param {string} evidence[].type - Evidence type (success, failure, partial)
 * @param {number} evidence[].impact - Impact on confidence
 * @returns {number} Updated confidence (0.0-1.0)
 */
function updateConfidence(prior, evidence) {
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

// Export API
// NOTE: Auto-link functions (createRefinesEdge, createContradictsEdge,
// findRelatedDecisions, isConflicting, detectConflicts) removed from exports.
// LLM infers relationships from search results instead.
module.exports = {
  learnDecision,
  generateDecisionId,
  getPreviousDecision,
  createSupersedesEdge,
  markSuperseded,
  calculateCombinedConfidence,
  detectRefinement,
  updateConfidence,
};
