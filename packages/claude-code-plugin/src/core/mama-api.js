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
 * @module mama-api
 * @version 1.0
 * @date 2025-11-14
 */

const { learnDecision } = require('./decision-tracker');
const { injectDecisionContext } = require('./memory-inject');
const { queryDecisionGraph, querySemanticEdges, getDB, getAdapter } = require('./memory-store');
const { formatRecall, formatList } = require('./decision-formatter');

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
 * @returns {Promise<string>} Decision ID
 *
 * @example
 * const decisionId = await mama.save({
 *   topic: 'date_calculation_format',
 *   decision: 'Support both ISO 8601 and Unix timestamp',
 *   reasoning: 'Bootstrap data stored as ISO 8601 causing NaN',
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
}) {
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
  const userInvolvement = type === 'user_decision' ? 'approved' : null;

  // Create detection object for learnDecision()
  const detection = {
    topic,
    decision,
    reasoning,
    confidence,
    type, // Include type for validation logic (user_decision vs assistant_insight)
    outcome,
    failure_reason,
    limitation,
    trust_context,
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
  const { decisionId } = await learnDecision(detection, toolExecution, sessionContext);

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

  return decisionId;
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
async function recall(topic, options = {}) {
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
        meta: { count: 0 },
      };
    }

    // Query semantic edges for all decisions
    const decisionIds = decisions.map((d) => d.id);
    const semanticEdges = await querySemanticEdges(decisionIds);

    // Markdown format (for human display)
    if (format === 'markdown') {
      // Pass semantic edges to formatter
      return formatRecall(decisions, semanticEdges);
    }

    // JSON format (default - LLM-first)
    // Separate supersedes chain from semantic edges
    return {
      topic,
      supersedes_chain: decisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        reasoning: d.reasoning,
        confidence: d.confidence,
        outcome: d.outcome,
        failure_reason: d.failure_reason,
        limitation: d.limitation,
        created_at: d.created_at,
        updated_at: d.updated_at,
        superseded_by: d.superseded_by,
        supersedes: d.supersedes,
        trust_context: d.trust_context,
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
  } catch (error) {
    throw new Error(`mama.recall() failed: ${error.message}`);
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
async function updateOutcome(decisionId, { outcome, failure_reason, limitation }) {
  if (!decisionId || typeof decisionId !== 'string') {
    throw new Error('mama.updateOutcome() requires decisionId (string)');
  }

  if (!outcome || !['SUCCESS', 'FAILED', 'PARTIAL'].includes(outcome)) {
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
    await stmt.run(outcome, failure_reason || null, limitation || null, Date.now(), decisionId);

    return;
  } catch (error) {
    throw new Error(`mama.updateOutcome() failed: ${error.message}`);
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
async function expandWithGraph(candidates) {
  const graphEnhanced = new Map(); // Use Map for deduplication by ID
  const primaryIds = new Set(candidates.map((c) => c.id)); // Track primary candidates

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
            similarity: candidate.similarity * 0.9, // Inherit similarity, slightly reduced
            related_to: candidate.id, // Track relationship
          });
        }
      }
    } catch (error) {
      console.warn(`Failed to get supersedes chain for ${candidate.topic}: ${error.message}`);
    }

    // 2. Add semantic edges (refines, contradicts)
    try {
      const edges = await querySemanticEdges([candidate.id]);

      // Add refines edges
      for (const edge of edges.refines) {
        if (!graphEnhanced.has(edge.to_id)) {
          graphEnhanced.set(edge.to_id, {
            id: edge.to_id,
            topic: edge.topic,
            decision: edge.decision,
            confidence: edge.confidence,
            created_at: edge.created_at,
            graph_source: 'refines',
            graph_rank: 0.7,
            similarity: candidate.similarity * 0.85,
            related_to: candidate.id,
            edge_reason: edge.reason,
          });
        }
      }

      // Add refined_by edges
      for (const edge of edges.refined_by) {
        if (!graphEnhanced.has(edge.from_id)) {
          graphEnhanced.set(edge.from_id, {
            id: edge.from_id,
            topic: edge.topic,
            decision: edge.decision,
            confidence: edge.confidence,
            created_at: edge.created_at,
            graph_source: 'refined_by',
            graph_rank: 0.7,
            similarity: candidate.similarity * 0.85,
            related_to: candidate.id,
            edge_reason: edge.reason,
          });
        }
      }

      // Add contradicts edges (lower rank, but still relevant)
      for (const edge of edges.contradicts) {
        if (!graphEnhanced.has(edge.to_id)) {
          graphEnhanced.set(edge.to_id, {
            id: edge.to_id,
            topic: edge.topic,
            decision: edge.decision,
            confidence: edge.confidence,
            created_at: edge.created_at,
            graph_source: 'contradicts',
            graph_rank: 0.6,
            similarity: candidate.similarity * 0.8,
            related_to: candidate.id,
            edge_reason: edge.reason,
          });
        }
      }
    } catch (error) {
      console.warn(`Failed to get semantic edges for ${candidate.id}: ${error.message}`);
    }
  }

  // 3. Convert Map to Array and sort by graph_rank + similarity
  const results = Array.from(graphEnhanced.values());

  // 4. Sort: Primary first, then by graph_rank, then by final_score (or similarity)
  results.sort((a, b) => {
    // Primary candidates always first
    if (primaryIds.has(a.id) && !primaryIds.has(b.id)) return -1;
    if (!primaryIds.has(a.id) && primaryIds.has(b.id)) return 1;

    // Then by graph_rank
    if (a.graph_rank !== b.graph_rank) {
      return b.graph_rank - a.graph_rank;
    }

    // Finally by final_score (recency-boosted) or similarity (fallback)
    const scoreA = a.final_score || a.similarity || 0;
    const scoreB = b.final_score || b.similarity || 0;
    return scoreB - scoreA;
  });

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
function applyRecencyBoost(results, options = {}) {
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
    .map((r) => {
      // created_at is stored in milliseconds in the database
      const ageInDays = (now - r.created_at) / (86400 * 1000);

      // Gaussian Decay: exp(-((age / scale)^2) / (2 * ln(1 / decay)))
      // At scale days: score = decay (e.g., 7 days = 50%)
      const gaussianDecay = Math.exp(
        -Math.pow(ageInDays / recencyScale, 2) / (2 * Math.log(1 / recencyDecay))
      );

      // Combine semantic similarity with recency
      const finalScore = r.similarity * (1 - recencyWeight) + gaussianDecay * recencyWeight;

      return {
        ...r,
        recency_score: gaussianDecay,
        recency_age_days: Math.round(ageInDays * 10) / 10,
        final_score: finalScore,
      };
    })
    .sort((a, b) => b.final_score - a.final_score);
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
 * const markdown = await mama.suggest('mesh', { format: 'markdown' });
 * // → "💡 MAMA found 3 related topics:\n1. ..."
 */
async function suggest(userQuestion, options = {}) {
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
    const { getPreparedStmt, getDB } = require('./memory-store');
    let results = [];
    let searchMethod = 'vector';

    try {
      // Check if vectorSearch prepared statement exists
      getPreparedStmt('vectorSearch');

      // Generate query embedding
      const { generateEmbedding } = require('./embeddings');
      const queryEmbedding = await generateEmbedding(userQuestion);

      // Adaptive threshold (shorter queries need higher confidence)
      const wordCount = userQuestion.split(/\s+/).length;
      const adaptiveThreshold = threshold !== undefined ? threshold : wordCount < 3 ? 0.7 : 0.6;

      // Vector search
      const { vectorSearch } = require('./memory-store');
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
    } catch (vectorError) {
      // Fallback to keyword search if vector search unavailable
      console.warn(`Vector search failed: ${vectorError.message}, falling back to keyword search`);
      searchMethod = 'keyword';

      // Keyword search fallback
      const adapter = getAdapter();
      const keywords = userQuestion
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2); // Filter short words

      if (keywords.length === 0) {
        return `💡 Hint: Please be more specific.\nExample: "Railway Volume setup" or "mesh parameter optimization"`;
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

      const rows = await stmt.all(...likeParams, limit);
      results = rows.map((row) => ({
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
          return `💡 Hint: Please be more specific.\nExample: "Why did we choose COMPLEX mesh structure?" or "What parameters should I use for large layers?"`;
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
      const { formatContext } = require('./decision-formatter');
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
  } catch (error) {
    // Graceful degradation
    console.warn(`mama.suggest() failed: ${error.message}`);
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
async function rerankWithLLM(userQuestion, results) {
  try {
    const { generate } = require('./ollama-client');

    const prompt = `User asked: "${userQuestion}"

Found decisions (ranked by vector similarity):
${results.map((r, i) => `${i + 1}. [${r.similarity.toFixed(3)}] ${r.topic}: ${r.decision.substring(0, 60)}...`).join('\n')}

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
    return parsed.ranking.map((idx) => results[idx]).filter(Boolean);
  } catch (error) {
    console.warn(`Re-ranking failed: ${error.message}, using vector ranking`);
    return results; // Fallback to vector ranking
  }
}

/**
 * List recent decisions (all topics, chronological)
 *
 * DEFAULT: Returns JSON array with recent decisions (LLM-first design)
 * OPTIONAL: Returns Markdown string if format='markdown' (for human display)
 *
 * @param {Object} options - List options
 * @param {string} [options.format='json'] - Output format: 'json' (default) or 'markdown'
 * @param {number} [options.limit=20] - Max decisions to show
 * @returns {Promise<Object|string>} Decision list as JSON or Markdown
 *
 * @example
 * // LLM usage (default)
 * const data = await mama.list({ limit: 10 });
 * // → { decisions: [...], meta: {...} }
 *
 * // Human display
 * const markdown = await mama.list({ limit: 10, format: 'markdown' });
 * // → "📋 Recent Decisions (10)\n━━━━━━━━..."
 */
async function list(options = {}) {
  const { format = 'json', limit = 20 } = options;

  try {
    const adapter = getAdapter();

    // Get recent decisions ordered by created_at DESC
    // Note: created_at is bigint (Unix timestamp), so simple ORDER BY works
    const stmt = adapter.prepare(
      `
      SELECT
        id, topic, decision, confidence,
        user_involvement, outcome,
        created_at, updated_at
      FROM decisions
      ORDER BY created_at DESC
      LIMIT ?
    `
    );
    const decisions = await stmt.all(limit);

    if (!decisions || decisions.length === 0) {
      if (format === 'markdown') {
        return '❌ No decisions found';
      }
      return { decisions: [], meta: { count: 0 } };
    }

    // Markdown format (for human display)
    if (format === 'markdown') {
      return formatList(decisions, { limit });
    }

    // JSON format (default - LLM-first)
    return {
      decisions: decisions.map((d) => ({
        id: d.id,
        topic: d.topic,
        decision: d.decision,
        confidence: d.confidence,
        outcome: d.outcome,
        user_involvement: d.user_involvement,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })),
      meta: {
        count: decisions.length,
        limit,
      },
    };
  } catch (error) {
    throw new Error(`mama.list() failed: ${error.message}`);
  }
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
const mama = {
  save,
  recall,
  updateOutcome,
  suggest,
  list,
};

module.exports = mama;
