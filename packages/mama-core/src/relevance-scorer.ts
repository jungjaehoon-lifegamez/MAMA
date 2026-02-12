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

import { cosineSimilarity } from './embeddings.js';

/**
 * Decision object for relevance scoring
 */
export interface DecisionWithEmbedding {
  id?: string;
  topic?: string;
  decision: string;
  reasoning?: string | null;
  outcome?: string | null;
  failure_reason?: string | null;
  user_involvement?: string;
  confidence?: number;
  created_at: number;
  updated_at?: number;
  embedding?: Float32Array;
  relevanceScore?: number;
}

/**
 * Query context for relevance calculation
 */
export interface QueryContext {
  embedding?: Float32Array;
}

/**
 * Formatted context result
 */
export interface FormattedContext {
  full: Array<{
    decision_id?: string;
    topic?: string;
    decision: string;
    reasoning?: string | null;
    outcome?: string | null;
    failure_reason?: string | null;
    user_involvement?: string;
    confidence?: number;
    relevanceScore?: number;
    created_at: number;
  }>;
  summary: {
    count: number;
    duration_days: number;
    failures: Array<{ decision: string; reason: string | null | undefined }>;
  } | null;
}

/**
 * Outcome weights for importance scoring
 */
const OUTCOME_WEIGHTS: Record<string, number> = {
  FAILED: 1.0, // Highest - failures are most valuable (AC #4)
  PARTIAL: 0.7,
  SUCCESS: 0.5,
  pending: 0.3, // Ongoing/pending, lowest
};

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
 * @param decision - Decision object
 * @param queryContext - Query context
 * @returns Relevance score (0.0-1.0)
 */
export function calculateRelevance(
  decision: DecisionWithEmbedding,
  queryContext: QueryContext
): number {
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
  // Use explicit null check to avoid confusion with object key access
  const outcomeKey = decision.outcome ?? 'pending';
  const importanceScore = OUTCOME_WEIGHTS[outcomeKey] ?? OUTCOME_WEIGHTS.pending;

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
 * @param decisions - Array of decision objects
 * @param queryContext - Query context with embedding
 * @param n - Number of top decisions to return (default: 3)
 * @returns Top N decisions with relevance scores
 */
export function selectTopDecisions(
  decisions: DecisionWithEmbedding[],
  queryContext: QueryContext,
  n = 3
): DecisionWithEmbedding[] {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return [];
  }

  // Task 2.3: Score all results by relevance
  const decisionsWithScores = decisions.map((decision) => ({
    ...decision,
    relevanceScore: calculateRelevance(decision, queryContext),
  }));

  // Task 2.4: Sort descending (highest relevance first)
  decisionsWithScores.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

  // Task 2.6: Filter out < 0.5 relevance (AC #1)
  const filtered = decisionsWithScores.filter((d) => (d.relevanceScore ?? 0) >= 0.5);

  // Task 2.5: Return top 3 (or top N)
  const topN = filtered.slice(0, n);

  return topN;
}

/**
 * Format decisions with top-N selection and summary
 *
 * Task 8.2-8.3: Format top 3 in full detail, rest as summary
 * AC #5: Top-N selection with summary
 *
 * @param decisions - All decisions (sorted by relevance)
 * @param topN - Number of decisions to show in full detail (default: 3)
 * @returns Formatted context {full: Array, summary: Object}
 */
export function formatTopNContext(decisions: DecisionWithEmbedding[], topN = 3): FormattedContext {
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
  let summary: FormattedContext['summary'] = null;

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
 * Test result for relevance scoring
 */
export interface TestResult {
  name: string;
  expected: string;
  calculated: string;
  pass: boolean;
}

/**
 * Test relevance scoring with sample decisions
 *
 * Task 1.4: Test relevance scoring with sample decisions
 * AC #1, #4: Verify scoring formula and failure priority
 *
 * @returns Test results
 */
export function testRelevanceScoring(): TestResult[] {
  const now = Date.now();

  // Mock embeddings (dummy for testing)
  const queryEmbedding = new Float32Array(384).fill(0.5);
  const decisionEmbedding1 = new Float32Array(384).fill(0.5); // Identical (similarity = 1.0)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _decisionEmbedding2 = new Float32Array(384).fill(0.3); // Different (similarity < 1.0)

  const scenarios = [
    // Scenario 1: Recent FAILED decision (should have highest relevance)
    {
      name: 'Recent FAILED decision',
      decision: {
        created_at: now - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        outcome: 'FAILED',
        embedding: decisionEmbedding1,
        decision: 'test decision',
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
        decision: 'test decision',
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
        decision: 'test decision',
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
