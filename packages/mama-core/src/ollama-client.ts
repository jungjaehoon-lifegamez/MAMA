/**
 * MAMA (Memory-Augmented MCP Architecture) - Ollama Client Wrapper
 *
 * Simple wrapper for Ollama API with EXAONE 3.5 support
 *
 * @module ollama-client
 */

import http from 'http';
import { error as logError } from './debug-logger.js';
import type { ToolExecution, SessionContext } from './decision-tracker.js';

// Ollama configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'localhost';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT || '11434', 10);
export const DEFAULT_MODEL = 'exaone3.5:2.4b';
export const FALLBACK_MODEL = 'gemma:2b';

export interface GenerateOptions {
  model?: string;
  format?: string | null;
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
}

interface OllamaResponse {
  response: string;
  model?: string;
  created_at?: string;
  done?: boolean;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

/**
 * Call Ollama API
 */
function callOllamaAPI(
  endpoint: string,
  payload: unknown,
  timeout = 30000
): Promise<OllamaResponse> {
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
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            // Ollama returns NDJSON (newline-delimited JSON)
            const lines = data.trim().split('\n');
            const response = JSON.parse(lines[lines.length - 1]) as OllamaResponse;
            resolve(response);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reject(new Error(`Failed to parse Ollama response: ${message}`));
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
 */
export async function generate(prompt: string, options: GenerateOptions = {}): Promise<unknown> {
  const { model = DEFAULT_MODEL, format = null, temperature = 0.7, max_tokens = 500 } = options;

  const payload: Record<string, unknown> = {
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
      } catch {
        throw new Error(`Failed to parse JSON response: ${responseText}`);
      }
    }

    return responseText;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Try fallback model if EXAONE fails
    const isModelNotFound =
      /model ['"].*['"] not found/i.test(message) ||
      (message.includes('404') && message.toLowerCase().includes('not found'));
    if (model === DEFAULT_MODEL && isModelNotFound) {
      logError(`[MAMA] EXAONE not found, trying fallback (${FALLBACK_MODEL})...`);

      return generate(prompt, {
        ...options,
        model: FALLBACK_MODEL,
      });
    }

    throw error;
  }
}

export interface DecisionAnalysisResult {
  is_decision: boolean;
  topic: string | null;
  decision: string | null;
  reasoning: string;
  confidence: number;
}

/**
 * Validate DecisionAnalysisResult shape at runtime
 */
function isDecisionAnalysisResult(obj: unknown): obj is DecisionAnalysisResult {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const o = obj as Record<string, unknown>;
  return (
    typeof o.is_decision === 'boolean' &&
    (typeof o.topic === 'string' || o.topic === null) &&
    (typeof o.decision === 'string' || o.decision === null) &&
    typeof o.reasoning === 'string' &&
    typeof o.confidence === 'number'
  );
}

/**
 * Validate QueryIntentResult shape at runtime
 */
function isQueryIntentResult(obj: unknown): obj is QueryIntentResult {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const o = obj as Record<string, unknown>;
  return (
    typeof o.involves_decision === 'boolean' &&
    (typeof o.topic === 'string' || o.topic === null) &&
    (o.query_type === 'recall' || o.query_type === 'evolution' || o.query_type === 'none') &&
    typeof o.reasoning === 'string'
  );
}

/**
 * Analyze decision from tool execution
 */
export async function analyzeDecision(
  toolExecution: ToolExecution,
  sessionContext: SessionContext
): Promise<DecisionAnalysisResult> {
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
      temperature: 0.3,
      max_tokens: 300,
    });

    if (!isDecisionAnalysisResult(response)) {
      throw new Error('Invalid LLM response shape for DecisionAnalysisResult');
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[MAMA] Decision analysis FAILED: ${message}`);
    throw new Error(`Decision analysis failed: ${message}`);
  }
}

export interface QueryIntentResult {
  involves_decision: boolean;
  topic: string | null;
  query_type: 'recall' | 'evolution' | 'none';
  reasoning: string;
}

/**
 * Analyze query intent
 */
export async function analyzeQueryIntent(userMessage: string): Promise<QueryIntentResult> {
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

    if (!isQueryIntentResult(response)) {
      throw new Error('Invalid LLM response shape for QueryIntentResult');
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`[MAMA] Query intent analysis FAILED: ${message}`);
    throw new Error(`Query intent analysis failed: ${message}`);
  }
}

/**
 * Check if Ollama is available
 */
export async function isAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET',
      timeout: 2000,
    };

    const req = http.request(options, (res) => {
      res.resume(); // Drain response body to release socket back to pool
      resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
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
 */
export async function listModels(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET',
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data) as OllamaTagsResponse;
          resolve(response.models?.map((m) => m.name) || []);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse models response: ${message}`));
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
