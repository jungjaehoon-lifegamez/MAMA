/**
 * MAMA (Memory-Augmented MCP Architecture) - Relevance Scorer
 *
 * Relevance scoring formula for decision ranking and top-N selection
 * Tasks: 1.1-1.4, 2.1-2.7 (Relevance scoring and top-N selection)
 * AC #1, #4, #5: Decision relevance, failure priority boost, top-N selection
 *
 * @module relevance-scorer
 * @version 1.0
 * @date 2025-11-14
 */

const { cosineSimilarity } = require('./embeddings');

/**
 * Calculate relevance score for a single decision
 *
 * Task 1.2: Implement calculateRelevance(decision, queryContext) function
 * AC #1, #4: Relevance scoring with failure priority boost
 *
 * Formula:
 *   Relevance = (Recency × 0.2) + (Importance × 0.5) + (Semantic × 0.3)
 *
 * Where:
 *   - Recency: exp(-days_since / 30)  [30-day half-life]
 *   - Importance: OUTCOME_WEIGHTS[outcome]
 *     - FAILED: 1.0 (highest - failures are most valuable)
 *     - PARTIAL: 0.7
 *     - SUCCESS: 0.5
 *     - null: 0.3 (ongoing, lowest)
 *   - Semantic: cosineSimilarity(decision.embedding, query.embedding)
 *
 * @param {Object} decision - Decision object
 * @param {number} decision.created_at - Created timestamp
 * @param {string} decision.outcome - Outcome type
 * @param {Float32Array} decision.embedding - Decision embedding (384-dim)
 * @param {Object} queryContext - Query context
 * @param {Float32Array} queryContext.embedding - Query embedding (384-dim)
 * @returns {number} Relevance score (0.0-1.0)
 */
function calculateRelevance(decision, queryContext) {
  // ═══════════════════════════════════════════════════════════
  // Recency Score (20%)
  // ═══════════════════════════════════════════════════════════
  // Exponential decay with 30-day half-life
  const daysSince = (Date.now() - decision.created_at) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.exp(-daysSince / 30);

  // Decay curve:
  // 0 days = 1.0
  // 30 days = 0.5
  // 60 days = 0.25
  // 90 days = 0.125

  // ═══════════════════════════════════════════════════════════
  // Importance Score (50%) - AC #4: Failure Priority Boost
  // ═══════════════════════════════════════════════════════════
  const OUTCOME_WEIGHTS = {
    FAILED: 1.0, // Highest - failures are most valuable (AC #4)
    PARTIAL: 0.7,
    SUCCESS: 0.5,
    null: 0.3, // Ongoing, lowest
  };

  const importanceScore = OUTCOME_WEIGHTS[decision.outcome] || OUTCOME_WEIGHTS['null'];

  // ═══════════════════════════════════════════════════════════
  // Semantic Score (30%)
  // ═══════════════════════════════════════════════════════════
  let semanticScore = 0;

  if (decision.embedding && queryContext.embedding) {
    // Task 1.3: Use cosine similarity function
    semanticScore = cosineSimilarity(decision.embedding, queryContext.embedding);
  } else {
    // Fallback: no semantic match if embeddings missing
    semanticScore = 0;
  }

  // ═══════════════════════════════════════════════════════════
  // Weighted Sum (Total: 100%)
  // ═══════════════════════════════════════════════════════════
  const relevance = recencyScore * 0.2 + importanceScore * 0.5 + semanticScore * 0.3;

  return relevance;
}

/**
 * Select top N most relevant decisions
 *
 * Task 2.1: Add selectTopDecisions(decisions, queryContext, n=3) function
 * AC #1, #5: Top-N selection with threshold filtering
 *
 * @param {Array<Object>} decisions - Array of decision objects
 * @param {Object} queryContext - Query context with embedding
 * @param {number} n - Number of top decisions to return (default: 3)
 * @returns {Array<Object>} Top N decisions with relevance scores
 */
function selectTopDecisions(decisions, queryContext, n = 3) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return [];
  }

  // Task 2.3: Score all results by relevance
  const decisionsWithScores = decisions.map((decision) => ({
    ...decision,
    relevanceScore: calculateRelevance(decision, queryContext),
  }));

  // Task 2.4: Sort descending (highest relevance first)
  decisionsWithScores.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Task 2.6: Filter out < 0.5 relevance (AC #1)
  const filtered = decisionsWithScores.filter((d) => d.relevanceScore >= 0.5);

  // Task 2.5: Return top 3 (or top N)
  const topN = filtered.slice(0, n);

  return topN;
}

/**
 * Cosine similarity helper (re-exported from embeddings.js)
 *
 * Task 1.3: Implement cosine similarity function
 * AC #1: Semantic similarity calculation
 *
 * Note: This is re-exported from embeddings.js for convenience
 *
 * @param {Float32Array} vec1 - First embedding vector
 * @param {Float32Array} vec2 - Second embedding vector
 * @returns {number} Cosine similarity (0.0-1.0)
 */
// Already available from embeddings.js - no need to reimplement

/**
 * Format decisions with top-N selection and summary
 *
 * Task 8.2-8.3: Format top 3 in full detail, rest as summary
 * AC #5: Top-N selection with summary
 *
 * @param {Array<Object>} decisions - All decisions (sorted by relevance)
 * @param {number} topN - Number of decisions to show in full detail (default: 3)
 * @returns {Object} Formatted context {full: Array, summary: Object}
 */
function formatTopNContext(decisions, topN = 3) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { full: [], summary: null };
  }

  // Split into top N and rest
  const fullDetailDecisions = decisions.slice(0, topN);
  const summaryDecisions = decisions.slice(topN);

  // Full detail for top N
  const full = fullDetailDecisions.map((d) => ({
    decision_id: d.id,
    topic: d.topic,
    decision: d.decision,
    reasoning: d.reasoning,
    outcome: d.outcome,
    failure_reason: d.failure_reason,
    user_involvement: d.user_involvement,
    confidence: d.confidence,
    relevanceScore: d.relevanceScore,
    created_at: d.created_at,
  }));

  // Summary for rest (count, duration, key failures only)
  let summary = null;

  if (summaryDecisions.length > 0) {
    // Calculate duration (oldest to newest)
    const oldestTimestamp = Math.min(...summaryDecisions.map((d) => d.created_at));
    const newestTimestamp = Math.max(...summaryDecisions.map((d) => d.created_at));
    const durationDays = Math.floor((newestTimestamp - oldestTimestamp) / (1000 * 60 * 60 * 24));

    // Extract key failures
    const failures = summaryDecisions
      .filter((d) => d.outcome === 'FAILED')
      .map((d) => ({ decision: d.decision, reason: d.failure_reason }));

    summary = {
      count: summaryDecisions.length,
      duration_days: durationDays,
      failures: failures.slice(0, 3), // Show max 3 failures
    };
  }

  return { full, summary };
}

/**
 * Test relevance scoring with sample decisions
 *
 * Task 1.4: Test relevance scoring with sample decisions
 * AC #1, #4: Verify scoring formula and failure priority
 *
 * @returns {Object} Test results
 */
function testRelevanceScoring() {
  const now = Date.now();

  // Mock embeddings (dummy for testing)
  const queryEmbedding = new Float32Array(384).fill(0.5);
  const decisionEmbedding1 = new Float32Array(384).fill(0.5); // Identical (similarity = 1.0)
  // eslint-disable-next-line no-unused-vars
  const decisionEmbedding2 = new Float32Array(384).fill(0.3); // Different (similarity < 1.0)

  const scenarios = [
    // Scenario 1: Recent FAILED decision (should have highest relevance)
    {
      name: 'Recent FAILED decision',
      decision: {
        created_at: now - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        outcome: 'FAILED',
        embedding: decisionEmbedding1,
      },
      queryContext: { embedding: queryEmbedding },
      expected: {
        recency: 0.85, // exp(-5/30) ≈ 0.85
        importance: 1.0, // FAILED = 1.0 (AC #4)
        semantic: 1.0, // Identical embeddings
        relevance: 0.87, // (0.85×0.2) + (1.0×0.5) + (1.0×0.3)
      },
    },

    // Scenario 2: Recent SUCCESS decision (lower importance)
    {
      name: 'Recent SUCCESS decision',
      decision: {
        created_at: now - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        outcome: 'SUCCESS',
        embedding: decisionEmbedding1,
      },
      queryContext: { embedding: queryEmbedding },
      expected: {
        recency: 0.85,
        importance: 0.5, // SUCCESS = 0.5
        semantic: 1.0,
        relevance: 0.62, // (0.85×0.2) + (0.5×0.5) + (1.0×0.3)
      },
    },

    // Scenario 3: Old FAILED decision (recency decay)
    {
      name: 'Old FAILED decision',
      decision: {
        created_at: now - 60 * 24 * 60 * 60 * 1000, // 60 days ago
        outcome: 'FAILED',
        embedding: decisionEmbedding1,
      },
      queryContext: { embedding: queryEmbedding },
      expected: {
        recency: 0.25, // exp(-60/30) ≈ 0.25
        importance: 1.0,
        semantic: 1.0,
        relevance: 0.85, // (0.25×0.2) + (1.0×0.5) + (1.0×0.3)
      },
    },
  ];

  const results = scenarios.map((scenario) => {
    const calculated = calculateRelevance(scenario.decision, scenario.queryContext);
    const pass = Math.abs(calculated - scenario.expected.relevance) < 0.05;

    return {
      name: scenario.name,
      expected: scenario.expected.relevance.toFixed(2),
      calculated: calculated.toFixed(2),
      pass,
    };
  });

  return results;
}

// Export API
module.exports = {
  calculateRelevance,
  selectTopDecisions,
  formatTopNContext,
  testRelevanceScoring,
};
