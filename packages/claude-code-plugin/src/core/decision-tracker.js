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

const { info, error: logError } = require('./debug-logger');
const {
  initDB,
  insertDecisionWithEmbedding,
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
    const stmt = adapter.prepare(`
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at)
      VALUES (?, ?, 'supersedes', ?, ?)
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
function detectRefinement(detection, sessionContext) {
  // TODO: Implement refinement detection heuristics
  // For now, return null (single-parent only)
  // Future: Analyze session context for references to multiple decisions

  // Example heuristics:
  // 1. User message mentions "combine", "merge", "refine"
  // 2. Recent exchange references multiple topics
  // 3. Decision reasoning mentions multiple approaches

  return null;
}

/**
 * Create refines edge (multi-parent relationship)
 *
 * Task 5.3: Implement refines edge creation
 * AC #5: Multi-parent refinement
 *
 * @param {string} fromId - New decision ID
 * @param {string} toId - Parent decision ID
 * @param {string} reason - Reason for refinement
 */
async function createRefinesEdge(fromId, toId, reason) {
  const adapter = getAdapter();

  try {
    const stmt = adapter.prepare(`
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at)
      VALUES (?, ?, 'refines', ?, ?)
    `);

    await stmt.run(fromId, toId, reason, Date.now());
  } catch (error) {
    throw new Error(`Failed to create refines edge: ${error.message}`);
  }
}

/**
 * Detect conflicting decisions (same topic, different decision)
 *
 * Task 5.4: Detect conflicting decisions
 * AC #2, #5: Relationship types
 *
 * @param {string} topic - Decision topic
 * @param {string} newDecision - New decision value
 * @param {string} newId - New decision ID (to exclude from search)
 * @returns {Promise<Array<Object>>} Conflicting decisions
 */
async function detectConflicts(topic, newDecision, newId) {
  const adapter = getAdapter();

  try {
    // Find active decisions on same topic with different decision value
    const stmt = adapter.prepare(`
      SELECT * FROM decisions
      WHERE topic = ?
        AND decision != ?
        AND id != ?
        AND superseded_by IS NULL
        AND outcome IS NULL
      ORDER BY created_at DESC
    `);

    const conflicts = await stmt.all(topic, newDecision, newId);
    return conflicts || [];
  } catch (error) {
    throw new Error(`Failed to detect conflicts: ${error.message}`);
  }
}

/**
 * Create contradicts edge (conflicting relationship)
 *
 * Task 5.5: Create contradicts edges for conflicts
 * AC #2, #5: Relationship types
 *
 * @param {string} fromId - New decision ID
 * @param {string} toId - Conflicting decision ID
 * @param {string} reason - Reason for contradiction
 */
async function createContradictsEdge(fromId, toId, reason) {
  const adapter = getAdapter();

  try {
    const stmt = adapter.prepare(`
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at)
      VALUES (?, ?, 'contradicts', ?, ?)
    `);

    await stmt.run(fromId, toId, reason, Date.now());
  } catch (error) {
    throw new Error(`Failed to create contradicts edge: ${error.message}`);
  }
}

/**
 * Find semantically related decisions using vector search
 *
 * Story 014.14: AC #1 - Vector Search for Related Decisions
 *
 * @param {string} decisionId - New decision ID (exclude from search)
 * @param {string} topic - Decision topic
 * @param {string} decision - Decision text
 * @param {string} reasoning - Decision reasoning
 * @returns {Promise<Array<Object>>} Related decisions with similarity scores
 */
async function findRelatedDecisions(decisionId, topic, decision, reasoning) {
  const { queryVectorSearch } = require('./memory-store');

  try {
    // Combine decision + reasoning for semantic search
    const searchText = `${decision}. ${reasoning}`;

    // Vector search params
    const params = {
      query: searchText,
      limit: 10, // Get more candidates for filtering
      threshold: 0.75, // Minimum similarity (Story 014.14: AC #1)
      timeWindow: 90 * 24 * 60 * 60 * 1000, // Last 90 days (Story 014.14: AC #1)
    };

    // Query vector database
    const results = await queryVectorSearch(params);

    // Filter out self and return top 5
    return results.filter((r) => r.id !== decisionId).slice(0, 5);
  } catch (error) {
    info(`[decision-tracker] Vector search failed, returning empty: ${error.message}`);
    return []; // Graceful degradation
  }
}

/**
 * Detect if reasoning contains conflict keywords
 *
 * Story 014.14: AC #3 - Contradicts Edge Detection
 *
 * @param {string} newReasoning - New decision reasoning
 * @param {string} oldReasoning - Previous decision reasoning
 * @returns {boolean} True if conflicting
 */
function isConflicting(newReasoning, oldReasoning) {
  const conflictKeywords = [
    'instead of',
    'replace',
    'not',
    'contrary to',
    'different from',
    'opposite',
    'revert',
    'undo',
    'abandon',
    'deprecate',
    'remove',
  ];

  const combined = `${newReasoning} ${oldReasoning}`.toLowerCase();

  return conflictKeywords.some((keyword) => combined.includes(keyword));
}

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
    // Story 014.14: Semantic Similarity Edge Detection
    // ════════════════════════════════════════════════════════
    const relatedDecisions = await findRelatedDecisions(
      decisionId,
      detection.topic,
      detection.decision,
      detection.reasoning
    );

    for (const related of relatedDecisions) {
      const similarity = related.similarity;

      // Skip if already has supersedes relationship
      if (related.superseded_by || related.id === previous?.id) {
        continue;
      }

      // High similarity → refines edge (Story 014.14: AC #2)
      if (similarity > 0.85) {
        const reason = `Refines previous approach (similarity: ${similarity.toFixed(2)})`;
        await createRefinesEdge(decisionId, related.id, reason);
      }

      // Medium similarity + conflict keywords → contradicts edge (Story 014.14: AC #3)
      else if (similarity > 0.75 && isConflicting(detection.reasoning, related.reasoning)) {
        const reason = `Contradicts previous approach (similarity: ${similarity.toFixed(2)})`;
        await createContradictsEdge(decisionId, related.id, reason);
      }
    }

    // ════════════════════════════════════════════════════════
    // Task 5.3: Create Refines Edges (if multi-parent refinement)
    // ════════════════════════════════════════════════════════
    if (refinedFrom && refinedFrom.length > 0) {
      // AC #5: Multi-parent refinement
      await Promise.all(
        refinedFrom.map(async (parentId) => {
          const reason = `Refined decision from multiple parents`;
          await createRefinesEdge(decisionId, parentId, reason);
        })
      );
    }

    // ════════════════════════════════════════════════════════
    // Task 5.4, 5.5: Detect and Create Contradicts Edges
    // ════════════════════════════════════════════════════════
    const conflicts = await detectConflicts(detection.topic, detection.decision, decisionId);
    if (conflicts.length > 0) {
      // AC #2, #5: Conflicting decisions
      await Promise.all(
        conflicts.map(async (conflict) => {
          const reason = `Conflicting decision: "${conflict.decision}" vs "${detection.decision}"`;
          await createContradictsEdge(decisionId, conflict.id, reason);
        })
      );
    }

    // ════════════════════════════════════════════════════════
    // Story 014.7.6: Generate notification if needs validation
    // ════════════════════════════════════════════════════════
    // TODO: Implement notification system for insights requiring validation
    let notification = null;
    if (needsValidation) {
      // Notification system not yet implemented
      // Future: notify user that assistant insight needs validation
      console.debug(`[MAMA] Assistant insight saved, validation recommended: ${decision.topic}`);
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
module.exports = {
  learnDecision,
  generateDecisionId,
  getPreviousDecision,
  createSupersedesEdge,
  markSuperseded,
  calculateCombinedConfidence,
  detectRefinement,
  updateConfidence,
  createRefinesEdge,
  detectConflicts,
  createContradictsEdge,
  findRelatedDecisions, // Story 014.14: AC #1
  isConflicting, // Story 014.14: AC #3
};
