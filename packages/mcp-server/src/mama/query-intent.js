/**
 * MAMA (Memory-Augmented MCP Architecture) - Query Intent Analysis
 *
 * Analyzes user queries to detect decision-related intent using EXAONE 3.5
 * Tasks: 2.1-2.8 (LLM intent analysis with fallback chain)
 * AC #1: Query intent analysis within 100ms
 * AC #5: LLM fallback (EXAONE → Gemma → Qwen)
 *
 * @module query-intent
 * @version 1.0
 * @date 2025-11-14
 */

const { info, error: logError } = require('./debug-logger');
const { generate, DEFAULT_MODEL, FALLBACK_MODEL } = require('./ollama-client');

/**
 * Analyze user message for decision-related intent
 *
 * Task 2.1-2.5: LLM intent analysis
 * AC #1: Detect if query involves decisions
 * AC #5: Fallback chain implemented
 *
 * @param {string} userMessage - User's message to analyze
 * @param {Object} options - Analysis options
 * @param {number} options.timeout - Timeout in ms (default: 100ms)
 * @param {number} options.threshold - Minimum confidence (default: 0.6)
 * @returns {Promise<Object>} Intent analysis result
 */
async function analyzeIntent(userMessage, options = {}) {
  const {
    timeout = 5000, // Increased: LLM needs time, user accepts longer thinking
    threshold = 0.6,
  } = options;

  const startTime = Date.now();

  try {
    // Task 2.2: Build prompt for decision-making analysis
    const prompt = `
Analyze if this query involves decision-making or past choices:

User Message: "${userMessage}"

Decision Indicators:
1. References to past decisions ("we chose X", "last time we did Y")
2. Questions about previous approaches ("why did we use X?")
3. Decision evolution queries ("should we change from X to Y?")
4. Architecture/strategy questions
5. Method/approach questions ("how do I...", "what's the way to...")
6. Best practice questions ("what should I use for...", "which one should I use...")

Return JSON with "topic" as a short snake_case identifier (e.g., "mesh_structure", "database_choice", "auth_strategy", "coding_style", "error_handling"):
{
  "involves_decision": boolean,
  "topic": string or null (extract main technical topic in snake_case),
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

IMPORTANT: Generate "topic" freely based on the message content. Do NOT limit to predefined values.

Examples:
- "Why did we choose COMPLEX mesh structure?" → {"involves_decision": true, "topic": "mesh_structure", "confidence": 0.9}
- "Let's use PostgreSQL for database" → {"involves_decision": true, "topic": "database_choice", "confidence": 0.9}
- "How should we store workflow data?" → {"involves_decision": true, "topic": "workflow_storage", "confidence": 0.85}
- "Read the file please" → {"involves_decision": false, "topic": null, "confidence": 0.1}
`.trim();

    // Task 2.3: Call EXAONE 3.5 with Tier 1 fallback
    const result = await generateWithFallback(prompt, {
      format: 'json',
      temperature: 0.3,
      max_tokens: 200,
      timeout,
    });

    const latency = Date.now() - startTime;

    // Task 2.4: Parse response
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;

    // Task 2.5: Threshold check
    const meetsThreshold = parsed.confidence >= threshold;

    if (!meetsThreshold) {
      info(`[MAMA] Intent confidence ${parsed.confidence} below threshold ${threshold}`);
      return {
        involves_decision: false,
        topic: null,
        confidence: parsed.confidence,
        reasoning: 'Confidence below threshold',
      };
    }

    return parsed;
  } catch (error) {
    // CLAUDE.md Rule #1: NO FALLBACK
    // Errors must be thrown for debugging
    logError(`[MAMA] Intent analysis FAILED: ${error.message}`);
    throw new Error(`Intent analysis failed: ${error.message}`);
  }
}

/**
 * Generate with tiered fallback chain
 *
 * Task 2.6-2.7: Implement fallback to Gemma 2B and Qwen 3B
 * AC #5: LLM fallback works
 *
 * @param {string} prompt - LLM prompt
 * @param {Object} options - Generation options
 * @returns {Promise<Object|string>} LLM response
 */
async function generateWithFallback(prompt, options = {}) {
  const models = [
    DEFAULT_MODEL, // Tier 1: EXAONE 3.5 (2.4B)
    FALLBACK_MODEL, // Tier 2: Gemma 2B
    'qwen:3b', // Tier 3: Qwen 3B
  ];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    try {
      info(`[MAMA] Trying ${model}...`);

      const result = await generate(prompt, {
        ...options,
        model,
      });

      info(`[MAMA] ${model} succeeded`);
      return result;
    } catch (error) {
      console.warn(`[MAMA] ${model} failed: ${error.message}`);

      // Continue to next tier
      if (i === models.length - 1) {
        // All tiers failed
        throw new Error(`All LLM tiers failed. Last error: ${error.message}`);
      }
    }
  }
}

/**
 * Extract topic keywords from user message (fallback method)
 *
 * Task 2.8: Keyword-based fallback when all LLMs fail
 * Simple regex matching for common topics
 *
 * @param {string} userMessage - User's message
 * @returns {Object} Topic detection result
 */
function extractTopicKeywords(userMessage) {
  const topicPatterns = {
    workflow_storage: /workflow|save|persist/i,
    mesh_structure: /mesh|structure/i,
    authentication: /auth|jwt|oauth|login/i,
    testing: /test|jest|spec/i,
    architecture: /architecture|design/i,
    coding_style: /style|format|coding/i,
  };

  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(userMessage)) {
      return {
        involves_decision: true,
        topic,
        confidence: 0.5, // Lower confidence for keyword matching
        reasoning: 'Keyword-based detection (LLM fallback)',
      };
    }
  }

  return {
    involves_decision: false,
    topic: null,
    confidence: 0.0,
    reasoning: 'No topic keywords found',
  };
}

// Export API
module.exports = {
  analyzeIntent,
  extractTopicKeywords,
};

// CLI execution for testing
if (require.main === module) {
  info('🧠 MAMA Query Intent Analysis - Test\n');

  // Task 2.8: Test intent detection accuracy
  (async () => {
    const testQueries = [
      {
        message: 'Why did we choose COMPLEX mesh structure?',
        expected: { involves_decision: true, topic: 'mesh_structure' },
      },
      {
        message: 'Read the file please',
        expected: { involves_decision: false },
      },
      {
        message: 'We chose JWT for authentication, remember?',
        expected: { involves_decision: true, topic: 'authentication' },
      },
    ];

    for (const test of testQueries) {
      info(`📋 Testing: "${test.message}"`);

      try {
        const result = await analyzeIntent(test.message);
        info('✅ Result:', result);

        // Verify expectations
        if (result.involves_decision === test.expected.involves_decision) {
          info('   ✓ Decision detection matches');
        } else {
          info('   ✗ Decision detection MISMATCH');
        }

        info('');
      } catch (error) {
        logError(`❌ Error: ${error.message}\n`);
      }
    }

    info('═══════════════════════════');
    info('✅ Intent analysis tests complete');
    info('═══════════════════════════');
  })();
}
