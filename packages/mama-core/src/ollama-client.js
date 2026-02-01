/**
 * MAMA (Memory-Augmented MCP Architecture) - Ollama Client Wrapper
 *
 * Simple wrapper for Ollama API with EXAONE 3.5 support
 * Tasks: 9.2-9.5 (HTTP client, EXAONE wrapper, Error handling, Testing)
 * AC #1: LLM integration ready
 *
 * @module ollama-client
 * @version 1.0
 * @date 2025-11-14
 */

const { info, error: logError } = require('./debug-logger');
const http = require('http');

// Ollama configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'localhost';
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;
const DEFAULT_MODEL = 'exaone3.5:2.4b';
const FALLBACK_MODEL = 'gemma:2b';

/**
 * Call Ollama API
 *
 * Task 9.2: Implement HTTP client for Ollama API
 * AC #1: LLM API callable
 *
 * @param {string} endpoint - API endpoint (e.g., '/api/generate')
 * @param {Object} payload - Request payload
 * @param {number} timeout - Timeout in milliseconds (default: 30000)
 * @returns {Promise<Object>} API response
 * @throws {Error} If request fails
 */
function callOllamaAPI(endpoint, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);

    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            // Ollama returns NDJSON (newline-delimited JSON)
            // For non-streaming, we only get one line
            const lines = data.trim().split('\n');
            const response = JSON.parse(lines[lines.length - 1]);
            resolve(response);
          } catch (error) {
            reject(new Error(`Failed to parse Ollama response: ${error.message}`));
          }
        } else {
          reject(new Error(`Ollama API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Ollama connection failed: ${error.message}`));
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Ollama request timeout (${timeout}ms)`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Generate text with EXAONE 3.5
 *
 * Task 9.3: Implement EXAONE wrapper (with fallback to Gemma)
 * AC #1: Decision detection LLM ready
 *
 * @param {string} prompt - Input prompt
 * @param {Object} options - Generation options
 * @param {string} options.model - Model name (default: EXAONE 3.5)
 * @param {string} options.format - Response format ('json' or null)
 * @param {number} options.temperature - Temperature (default: 0.7)
 * @param {number} options.max_tokens - Max tokens (default: 500)
 * @returns {Promise<string|Object>} Generated text or JSON object
 * @throws {Error} If generation fails
 */
async function generate(prompt, options = {}) {
  const { model = DEFAULT_MODEL, format = null, temperature = 0.7, max_tokens = 500 } = options;

  const payload = {
    model,
    prompt,
    stream: false,
    options: {
      temperature,
      num_predict: max_tokens,
    },
  };

  if (format === 'json') {
    payload.format = 'json';
  }

  try {
    const response = await callOllamaAPI('/api/generate', payload);

    // Extract response text
    const responseText = response.response;

    // Parse JSON if requested
    if (format === 'json') {
      try {
        return JSON.parse(responseText);
      } catch (error) {
        throw new Error(`Failed to parse JSON response: ${responseText}`);
      }
    }

    return responseText;
  } catch (error) {
    // Task 9.4: Try fallback model if EXAONE fails
    // Match Ollama's specific "model 'xxx' not found" error pattern
    const isModelNotFound =
      /model ['"].*['"] not found/i.test(error.message) ||
      (error.message.includes('404') && error.message.toLowerCase().includes('not found'));
    if (model === DEFAULT_MODEL && isModelNotFound) {
      console.warn(`[MAMA] EXAONE not found, trying fallback (${FALLBACK_MODEL})...`);

      return generate(prompt, {
        ...options,
        model: FALLBACK_MODEL,
      });
    }

    throw error;
  }
}

/**
 * Analyze decision from tool execution
 *
 * Wrapper for decision detection (used in Story 014.7.3)
 *
 * @param {Object} toolExecution - Tool execution data
 * @param {Object} sessionContext - Session context
 * @returns {Promise<Object>} Decision analysis result
 */
async function analyzeDecision(toolExecution, sessionContext) {
  const prompt = `
Analyze if this represents a DECISION (not just an action):

Session Context:
- Latest User Message: ${sessionContext.latest_user_message || 'N/A'}
- Recent Exchange: ${sessionContext.recent_exchange || 'N/A'}

Tool Execution:
- Tool: ${toolExecution.tool_name}
- Input: ${JSON.stringify(toolExecution.tool_input)}
- Result: ${toolExecution.exit_code === 0 ? 'SUCCESS' : 'FAILED'}

Decision Indicators:
1. User explicitly chose between alternatives?
   Example: "Let's use JWT" (not "Use JWT" - that's just action)

2. User changed previous approach?
   Example: "Complex → Simple approach"

3. User expressed preference?
   Example: "Let's do it this way from now", "This approach is better"

4. Significant architectural choice?
   Example: "Mesh structure: COMPLEX", "Authentication: JWT"

Is this a DECISION? Return JSON with "topic" as a short snake_case identifier:
{
  "is_decision": boolean,
  "topic": string or null (extract main technical topic in snake_case, e.g., "mesh_structure", "database_choice", "auth_strategy"),
  "decision": string or null (the actual choice made, e.g., "COMPLEX", "PostgreSQL", "JWT"),
  "reasoning": "Why this is/isn't a decision",
  "confidence": 0.0-1.0
}

IMPORTANT: Generate "topic" freely based on context. Do NOT limit to predefined values.
`;

  try {
    const response = await generate(prompt, {
      format: 'json',
      temperature: 0.3, // Lower temperature for structured output
      max_tokens: 300,
    });

    return response;
  } catch (error) {
    // CLAUDE.md Rule #1: NO FALLBACK
    // Errors must be thrown for debugging
    logError(`[MAMA] Decision analysis FAILED: ${error.message}`);
    throw new Error(`Decision analysis failed: ${error.message}`);
  }
}

/**
 * Analyze query intent
 *
 * Wrapper for query intent detection (used in Story 014.7.2)
 *
 * @param {string} userMessage - User's message
 * @returns {Promise<Object>} Query intent analysis
 */
async function analyzeQueryIntent(userMessage) {
  const prompt = `
Analyze this user message to determine if it involves past decisions:

User Message: "${userMessage}"

Questions to answer:
1. Does this query reference past decisions or choices?
2. Is the user asking about previous approaches?
3. What topic is being discussed? (e.g., "mesh_structure", "authentication", "testing")

Return JSON:
{
  "involves_decision": boolean,
  "topic": "topic_name" | null,
  "query_type": "recall" | "evolution" | "none",
  "reasoning": "Why this involves/doesn't involve decisions"
}
`;

  try {
    const response = await generate(prompt, {
      format: 'json',
      temperature: 0.3,
      max_tokens: 200,
    });

    return response;
  } catch (error) {
    // CLAUDE.md Rule #1: NO FALLBACK
    // Errors must be thrown for debugging
    logError(`[MAMA] Query intent analysis FAILED: ${error.message}`);
    throw new Error(`Query intent analysis failed: ${error.message}`);
  }
}

/**
 * Check if Ollama is available
 *
 * Utility for health checks
 *
 * @returns {Promise<boolean>} True if Ollama is accessible
 */
async function isAvailable() {
  return new Promise((resolve) => {
    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET', // Use GET for health check
      timeout: 2000,
    };

    const req = http.request(options, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

/**
 * List available models
 *
 * Utility for setup script
 *
 * @returns {Promise<Array<string>>} Array of model names
 */
async function listModels() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET', // Use GET for listing models
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response.models?.map((m) => m.name) || []);
        } catch (error) {
          reject(new Error(`Failed to parse models response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Failed to list models: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('List models timeout'));
    });

    req.end();
  });
}

// Export API
module.exports = {
  generate,
  analyzeDecision,
  analyzeQueryIntent,
  isAvailable,
  listModels,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};

// CLI execution for testing
if (require.main === module) {
  info('🧠 MAMA Ollama Client - Test\n');

  // Task 9.5: Test Ollama connection and generation
  (async () => {
    try {
      info('📋 Test 1: Check Ollama availability...');
      const available = await isAvailable();
      if (!available) {
        throw new Error('Ollama is not available');
      }
      info('✅ Ollama is available\n');

      info('📋 Test 2: List available models...');
      const models = await listModels();
      info(`✅ Found ${models.length} models:`, models.join(', '), '\n');

      info('📋 Test 3: Generate text...');
      const text = await generate('What is 2+2?', {
        temperature: 0.1,
        max_tokens: 50,
      });
      info(`✅ Generated: ${text.trim()}\n`);

      info('📋 Test 4: Generate JSON...');
      const json = await generate('Return {"test": true, "value": 42}', {
        format: 'json',
        temperature: 0.1,
        max_tokens: 50,
      });
      info('✅ Generated JSON:', json, '\n');

      info('═══════════════════════════');
      info('✅ All tests passed!');
      info('═══════════════════════════');
    } catch (error) {
      logError(`❌ Test failed: ${error.message}`);
      process.exit(1);
    }
  })();
}
