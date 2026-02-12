/**
 * MAMA (Memory-Augmented MCP Architecture) - Query Intent Analysis
 *
 * Analyzes user queries to detect decision-related intent using EXAONE 3.5
 * Tasks: 2.1-2.8 (LLM intent analysis with fallback chain)
 *
 * @module query-intent
 */

import { info, warn, error as logError } from './debug-logger.js';
import { generate, DEFAULT_MODEL, FALLBACK_MODEL } from './ollama-client.js';

export interface IntentResult {
  involves_decision: boolean;
  topic: string | null;
  confidence: number;
  reasoning: string;
}

export interface AnalyzeOptions {
  timeout?: number;
  threshold?: number;
}

// GenerateOptions imported from ollama-client would be ideal, but keeping local
// to avoid circular dependency (ollama-client imports from query-intent in some flows)
interface GenerateOptions {
  format?: string;
  temperature?: number;
  max_tokens?: number;
  timeout?: number;
  model?: string;
}

/**
 * Analyze user message for decision-related intent
 */
export async function analyzeIntent(
  userMessage: string,
  options: AnalyzeOptions = {}
): Promise<IntentResult> {
  const {
    timeout = 5000, // Increased: LLM needs time, user accepts longer thinking
    threshold = 0.6,
  } = options;

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

    // Task 2.4: Parse response
    const parsed = (typeof result === 'string' ? JSON.parse(result) : result) as IntentResult;

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
    const message = error instanceof Error ? error.message : String(error);
    logError(`[MAMA] Intent analysis FAILED: ${message}`);
    throw new Error(`Intent analysis failed: ${message}`);
  }
}

/**
 * Generate with tiered fallback chain
 */
async function generateWithFallback(
  prompt: string,
  options: GenerateOptions = {}
): Promise<unknown> {
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
      const message = error instanceof Error ? error.message : String(error);
      warn(`[MAMA] ${model} failed: ${message}`);

      // Continue to next tier
      if (i === models.length - 1) {
        // All tiers failed
        throw new Error(`All LLM tiers failed. Last error: ${message}`);
      }
    }
  }

  // Unreachable: loop always returns or throws
  throw new Error('Unexpected: all LLM tiers exhausted without result');
}

/**
 * Extract topic keywords from user message (fallback method)
 */
export function extractTopicKeywords(userMessage: string): IntentResult {
  const topicPatterns: Record<string, RegExp> = {
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
