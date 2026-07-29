/**
 * MAMA (Memory-Augmented MCP Architecture) - Ollama Client Wrapper
 *
 * Simple wrapper for Ollama API with EXAONE 3.5 support
 *
 * @module ollama-client
 */

import http from 'http';
import { error as logError } from './debug-logger.js';

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
  const {
    model = DEFAULT_MODEL,
    format = null,
    temperature = 0.7,
    max_tokens = 500,
    timeout = 30000,
  } = options;

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
    const response = await callOllamaAPI('/api/generate', payload, timeout);

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

export interface QueryIntentResult {
  involves_decision: boolean;
  topic: string | null;
  query_type: 'recall' | 'evolution' | 'none';
  reasoning: string;
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
