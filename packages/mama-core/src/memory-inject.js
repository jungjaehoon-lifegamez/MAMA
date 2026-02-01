/**
 * MAMA (Memory-Augmented MCP Architecture) - Memory Injection Hook
 *
 * UserPromptSubmit hook that injects decision history into Claude's context
 * Tasks: 1.1-1.9 (Hook setup, timeout handling, context injection)
 * AC #1: Query intent → Graph query → Format → Inject (5s timeout for LLM latency)
 * AC #2: No history → null (graceful fallback)
 * AC #3: Timeout → graceful fallback
 *
 * @module memory-inject
 * @version 1.0
 * @date 2025-11-14
 */

// Error handling policy:
// - Timeout errors: thrown (caller handles retry/fallback)
// - Vector search unavailable: returns empty array (recoverable, not critical)
const { info, error: logError } = require('./debug-logger');
const { vectorSearch } = require('./memory-store');
const { formatContext } = require('./decision-formatter');

// Configuration
const TIMEOUT_MS = 5000; // LLM-based intent detection, user accepts longer thinking
const TOKEN_BUDGET = 500; // AC #1: Max 500 tokens per injection

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
  let timeoutId = null;

  try {
    // Task 1.3: Implement timeout wrapper (Promise.race with timeout)
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Memory injection timeout (${TIMEOUT_MS}ms)`));
      }, TIMEOUT_MS);
    });

    const context = await Promise.race([
      performMemoryInjection(userMessage, startTime),
      timeoutPromise,
    ]);

    // Clear timeout on success to prevent timer leak
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return context;
  } catch (error) {
    // Clear timeout on error to prevent timer leak
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
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
  // 1. Generate query embedding
  const { generateEmbedding } = require('./embeddings');
  const queryEmbedding = await generateEmbedding(userMessage);

  const embeddingLatency = Date.now() - startTime;
  info(`[MAMA] Embedding generation: ${embeddingLatency}ms`);

  // 2. Adaptive threshold (shorter queries need higher confidence)
  const wordCount = userMessage.split(/\s+/).length;
  const adaptiveThreshold = wordCount < 3 ? 0.7 : 0.6;

  // 3. Vector search (returns [] on error for graceful degradation)
  let results;
  try {
    results = await vectorSearch(queryEmbedding, 10, 0.5); // Get more candidates
  } catch (error) {
    // Vector search unavailability should not block the main conversation flow
    logError(`[MAMA] Vector search failed: ${error.message}`);
    return null;
  }

  // 4. Filter by adaptive threshold
  results = results.filter((r) => r.similarity >= adaptiveThreshold);

  const searchLatency = Date.now() - startTime;
  info(
    `[MAMA] Vector search: ${searchLatency - embeddingLatency}ms (${results.length} results, threshold: ${adaptiveThreshold})`
  );

  // 5. Check if we have any decisions
  if (results.length === 0) {
    // Redact user content for privacy - only log length, not content
    info(`[MAMA] No relevant decisions found (query length: ${userMessage.length} chars)`);
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
      'Why did we choose COMPLEX mesh structure?',
      'Read the file please',
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
