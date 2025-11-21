/**
 * MAMA (Memory-Augmented MCP Architecture) - Memory Injection Hook
 *
 * UserPromptSubmit hook that injects decision history into Claude's context
 * Tasks: 1.1-1.9 (Hook setup, timeout handling, context injection)
 * AC #1: Query intent → Graph query → Format → Inject (< 200ms)
 * AC #2: No history → null (graceful fallback)
 * AC #3: Timeout → graceful fallback
 *
 * @module memory-inject
 * @version 1.0
 * @date 2025-11-14
 */

// Use LLM-based intent detection (EXAONE 3.5)
// NO FALLBACK: Errors must be thrown for debugging (CLAUDE.md Rule #1)
const { info, error: logError } = require('./debug-logger');
const { analyzeIntent } = require('./query-intent');
const { queryDecisionGraph, vectorSearch } = require('./memory-store');
// Lazy-load embeddings to avoid loading sharp at startup (Story 014.12.7 - Windows Node.js compatibility)
// const { generateEmbedding } = require('./embeddings');
const { formatContext } = require('./decision-formatter');

// Configuration
const TIMEOUT_MS = 5000; // LLM-based intent detection, user accepts longer thinking
const TOKEN_BUDGET = 500; // AC #1: Max 500 tokens per injection
const ENABLE_VECTOR_SEARCH = true; // Enable vector search for semantic matching

/**
 * UserPromptSubmit Hook Handler
 *
 * Task 1.1-1.9: Main entry point for memory injection
 * AC #1, #2, #3: Intent analysis → Query → Format → Inject
 *
 * @param {string} userMessage - User's message from prompt
 * @returns {Promise<string|null>} Injected context or null
 */
async function injectDecisionContext(userMessage) {
  const startTime = Date.now();

  try {
    // Task 1.3: Implement timeout wrapper (Promise.race with 200ms timeout)
    const context = await Promise.race([
      performMemoryInjection(userMessage, startTime),
      createTimeout(TIMEOUT_MS),
    ]);

    const totalLatency = Date.now() - startTime;

    if (totalLatency > TIMEOUT_MS) {
      console.warn(`[MAMA] Memory injection exceeded ${TIMEOUT_MS}ms: ${totalLatency}ms`);
    }

    return context;
  } catch (error) {
    // CLAUDE.md Rule #1: NO FALLBACK
    // Errors must be thrown for debugging (including timeout)
    logError(`[MAMA] Memory injection FAILED: ${error.message}`);
    throw error;
  }
}

/**
 * Perform memory injection with all steps
 *
 * Simplified: Direct vector search without LLM intent analysis
 * Faster, more reliable, works with all query types
 *
 * @param {string} userMessage - User's message
 * @param {number} startTime - Start timestamp for latency tracking
 * @returns {Promise<string|null>} Formatted context or null
 */
async function performMemoryInjection(userMessage, startTime) {
  // 0. Initialize database (if not already initialized)
  const { initDB } = require('./memory-store');
  try {
    await initDB();
  } catch (error) {
    logError(`[MAMA] Failed to initialize database: ${error.message}`);
    return null;
  }

  // 1. Generate query embedding
  const { generateEmbedding } = require('./embeddings');
  const queryEmbedding = await generateEmbedding(userMessage);

  const embeddingLatency = Date.now() - startTime;
  info(`[MAMA] Embedding generation: ${embeddingLatency}ms`);

  // 2. Adaptive threshold (shorter queries need higher confidence)
  const wordCount = userMessage.split(/\s+/).length;
  const adaptiveThreshold = wordCount < 3 ? 0.7 : 0.6;

  // 3. Vector search
  let results = await vectorSearch(queryEmbedding, 10, 0.5); // Get more candidates

  // 4. Filter by adaptive threshold
  results = results.filter((r) => r.similarity >= adaptiveThreshold);

  const searchLatency = Date.now() - startTime;
  info(
    `[MAMA] Vector search: ${searchLatency - embeddingLatency}ms (${results.length} results, threshold: ${adaptiveThreshold})`
  );

  // 5. Check if we have any decisions
  if (results.length === 0) {
    info(`[MAMA] No relevant decisions found (query: "${userMessage.substring(0, 50)}...")`);
    return null;
  }

  // 6. Format context summary
  const formattedContext = formatContext(results, {
    maxTokens: TOKEN_BUDGET,
  });

  const formatLatency = Date.now() - startTime;
  info(`[MAMA] Format context: ${formatLatency - searchLatency}ms (total: ${formatLatency}ms)`);

  // 7. Return formatted context (Claude Code will inject it)
  return formattedContext;
}

/**
 * Perform vector search for semantic matching
 *
 * Task 4.1-4.5: Vector search with similarity threshold
 * AC #1: Semantic matching for relevant decisions
 *
 * @param {string} userMessage - User's message
 * @param {string} topic - Detected topic
 * @returns {Promise<Array<Object>>} Semantically similar decisions
 */
async function performVectorSearch(userMessage, topic) {
  try {
    // Task 4.1: Generate query embedding from user message
    // Lazy-load embeddings at runtime (Story 014.12.7)
    const { generateEmbedding } = require('./embeddings');
    const queryEmbedding = await generateEmbedding(userMessage);

    // Task 4.2: Search vss_memories with top k=5, threshold=0.6
    // NOTE: Threshold lowered from 0.7 to 0.6 to handle embedding format mismatch
    // (user queries are natural language, stored embeddings are enriched structured text)
    const vectorResults = vectorSearch(queryEmbedding, 5, 0.6);

    // Task 4.3: Retrieve corresponding decisions via rowid
    // (Already done by vectorSearch function)

    return vectorResults;
  } catch (error) {
    logError(`[MAMA] Vector search failed: ${error.message}`);
    return [];
  }
}

/**
 * Merge decision from graph and vector search (deduplicate)
 *
 * Task 4.4: Merge results and deduplicate
 *
 * @param {Array<Object>} graphDecisions - Decisions from graph query
 * @param {Array<Object>} vectorDecisions - Decisions from vector search
 * @returns {Array<Object>} Merged and deduplicated decisions
 */
function mergeDecisions(graphDecisions, vectorDecisions) {
  const seen = new Set();
  const merged = [];

  // Prioritize graph decisions (they're from explicit supersedes chain)
  for (const decision of graphDecisions) {
    if (!seen.has(decision.id)) {
      seen.add(decision.id);
      merged.push(decision);
    }
  }

  // Add vector decisions if not already included
  for (const decision of vectorDecisions) {
    if (!seen.has(decision.id)) {
      seen.add(decision.id);
      merged.push(decision);
    }
  }

  // Sort by recency (most recent first)
  merged.sort((a, b) => b.created_at - a.created_at);

  return merged;
}

/**
 * Create timeout promise
 *
 * Task 1.3: Timeout wrapper for Promise.race
 * AC #3: Graceful timeout handling
 *
 * @param {number} ms - Timeout in milliseconds
 * @returns {Promise<never>} Rejects after timeout
 */
function createTimeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Memory injection timeout (${ms}ms)`));
    }, ms);
  });
}

// Export API
module.exports = {
  injectDecisionContext,
};

// CLI execution for testing
if (require.main === module) {
  info('🧠 MAMA Memory Injection - Test\n');

  // Test memory injection flow
  (async () => {
    const testMessages = [
      '왜 메시 구조를 COMPLEX로 했지?',
      '파일 읽어줘',
      'We chose JWT authentication, why?',
    ];

    for (const message of testMessages) {
      info(`═══════════════════════════`);
      info(`📋 Testing: "${message}"\n`);

      try {
        const startTime = Date.now();
        const context = await injectDecisionContext(message);
        const latency = Date.now() - startTime;

        if (context) {
          info('\n✅ Context injected:');
          info(context);
          info(`\n⏱️  Latency: ${latency}ms (target: <${TIMEOUT_MS}ms)`);
        } else {
          info('\n⚠️  No context injected (null returned)');
          info(`⏱️  Latency: ${latency}ms`);
        }
      } catch (error) {
        logError(`\n❌ Error: ${error.message}`);
      }

      info('');
    }

    info('═══════════════════════════');
    info('✅ Memory injection tests complete');
    info('═══════════════════════════');
  })();
}
