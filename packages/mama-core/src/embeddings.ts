/**
 * MAMA (Memory-Augmented MCP Architecture) - Embedding Generation
 *
 * Story M1.4: Configurable embedding model selection
 * Generates embeddings using configurable model (default: multilingual-e5-large)
 * Supports: Korean-English cross-lingual similarity, enhanced metadata
 *
 * @module embeddings
 * @version 1.1
 * @date 2025-11-20
 */

import os from 'os';
import path from 'path';
import { info } from './debug-logger.js';
import { embeddingCache } from './embedding-cache.js';
import { createEmbedder, type Embedder } from './embedding/embedder.js';
import { loadConfig, getModelName, getEmbeddingDim, getQuantized } from './config-loader.js';

// Shared cache directory (not in node_modules)
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'transformers');
const TIER3_ENV_VALUES = new Set(['1', 'true', 'yes']);
export const EMBEDDING_MODEL_MAX_LENGTH = 512;
export const EMBEDDING_MAX_TOKENISH_SEGMENTS = 480;

// e5 instruction-prefix scheme. e5 models are trained with two prefixes: stored
// text is embedded as "passage: <text>", a search query as "query: <text>".
// Omitting them collapses cosine into a narrow cone. This constant is the single
// source of truth for the scheme identifier used by the runtime version guard.
export type EmbeddingRole = 'passage' | 'query';
export const EMBEDDING_PREFIX_SCHEME = 'e5-prefixed-v1';

function applyRolePrefix(preparedText: string, role: EmbeddingRole): string {
  return `${role}: ${preparedText}`;
}
const TOKENISH_SEGMENT_PATTERN =
  /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|\S+/gu;

// Type for pipeline function from @huggingface/transformers

// One process-wide embedder for callers that have not been given one of their
// own. `createEmbedder` owns the pipeline and its cache; this module only holds
// the instance and rebuilds it when the configured model changes.
let embedder: Embedder | null = null;

export function isForceTier3Enabled(): boolean {
  return TIER3_ENV_VALUES.has(String(process.env.MAMA_FORCE_TIER_3 || '').toLowerCase());
}

function assertEmbeddingsEnabled(): void {
  if (isForceTier3Enabled()) {
    throw new Error(
      'Embedding generation disabled because MAMA_FORCE_TIER_3=true. ' +
        'Tier 3 test mode must use lexical/no-vector fallback instead of loading the embedding model.'
    );
  }
}

export function prepareEmbeddingText(text: string): string {
  const trimmed = text.trim();
  let count = 0;
  let cutIndex = trimmed.length;

  for (const match of trimmed.matchAll(TOKENISH_SEGMENT_PATTERN)) {
    count++;
    if (count > EMBEDDING_MAX_TOKENISH_SEGMENTS) {
      cutIndex = match.index ?? trimmed.length;
      break;
    }
  }

  return cutIndex === trimmed.length ? trimmed : trimmed.slice(0, cutIndex).trimEnd();
}

/**
 * Decision object for enhanced embedding generation
 */
export interface DecisionForEmbedding {
  topic: string;
  decision: string;
  reasoning?: string;
  outcome?: string;
  confidence?: number;
  user_involvement?: string;
  evidence?: string | string[] | unknown;
  alternatives?: string | string[] | unknown;
  risks?: string;
}

/**
 * Load embedding model (configurable)
 *
 * Story M1.4 AC #2: Transformers.js singleton initialization
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @returns Embedding pipeline
 */
function resolveEmbedder(): Embedder {
  assertEmbeddingsEnabled();

  const modelName = getModelName();

  // Story M1.4 AC #3: a configured model change resets the pipeline and cache.
  if (embedder && embedder.modelName !== modelName) {
    info('[MAMA] Embedding model changed - resetting pipeline');
    info(`[MAMA] Old model: ${embedder.modelName}`);
    info(`[MAMA] New model: ${modelName}`);
    embeddingCache.clear();
    embedder = null;
    info('[MAMA] Model cache cleared');
  }

  if (!embedder) {
    embedder = createEmbedder({
      modelName,
      dimension: getEmbeddingDim(),
      quantized: getQuantized(),
      maxLength: EMBEDDING_MODEL_MAX_LENGTH,
      cacheDir: process.env.HF_HOME || process.env.TRANSFORMERS_CACHE || DEFAULT_CACHE_DIR,
      // The shared cache: consumers already clear it and read its stats.
      cache: embeddingCache,
    });
  }

  return embedder;
}

/**
 * Generate embedding vector from text
 *
 * Story M1.4 AC #1: Uses configurable embeddingDim from config
 * Target: < 30ms latency
 *
 * @param text - Input text to embed
 * @returns Embedding vector (dimension from config)
 * @throws Error if text is empty or embedding fails
 */
export async function generateEmbedding(
  text: string,
  role: EmbeddingRole = 'passage'
): Promise<Float32Array> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  assertEmbeddingsEnabled();

  const preparedText = prepareEmbeddingText(text);
  const modelInput = applyRolePrefix(preparedText, role); // e5 instruction prefix

  // The embedder keys its cache on the PREFIXED input, so a passage vector can
  // never be served to a query.
  try {
    return await resolveEmbedder().embed(modelInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate embedding: ${message}`);
  }
}

/**
 * Generate enhanced embedding with content + metadata
 *
 * Task 3.4: Implement enhanced embedding format
 * Inspired by A-mem: Content + Metadata for richer semantic representation
 *
 * @param decision - Decision object
 * @returns 1024-dim enhanced embedding
 */
export async function generateEnhancedEmbedding(
  decision: DecisionForEmbedding,
  role: EmbeddingRole = 'passage'
): Promise<Float32Array> {
  // Construct enriched text representation with narrative fields (Story 2.2)
  const parts = [
    `Topic: ${decision.topic}`,
    `Decision: ${decision.decision}`,
    `Reasoning: ${decision.reasoning || 'N/A'}`,
    `Outcome: ${decision.outcome || 'ONGOING'}`,
    `Confidence: ${decision.confidence !== undefined ? decision.confidence : 0.5}`,
    `User Involvement: ${decision.user_involvement || 'N/A'}`,
  ];

  // Add narrative fields if present (Story 2.2: Narrative-Based Search)
  if (decision.evidence) {
    const evidenceText = Array.isArray(decision.evidence)
      ? decision.evidence.join('; ')
      : typeof decision.evidence === 'string'
        ? decision.evidence
        : JSON.stringify(decision.evidence);
    parts.push(`Evidence: ${evidenceText}`);
  }

  if (decision.alternatives) {
    const alternativesText = Array.isArray(decision.alternatives)
      ? decision.alternatives.join('; ')
      : typeof decision.alternatives === 'string'
        ? decision.alternatives
        : JSON.stringify(decision.alternatives);
    parts.push(`Alternatives: ${alternativesText}`);
  }

  if (decision.risks) {
    parts.push(`Risks: ${decision.risks}`);
  }

  const enrichedText = parts.join('\n').trim();

  return generateEmbedding(enrichedText, role);
}

/**
 * Calculate cosine similarity between two embeddings
 *
 * Utility for testing and validation
 *
 * @param embA - First embedding
 * @param embB - Second embedding
 * @returns Cosine similarity (0-1)
 */
export function cosineSimilarity(embA: Float32Array, embB: Float32Array): number {
  if (embA.length !== embB.length) {
    throw new Error('Embeddings must have same dimension');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < embA.length; i++) {
    dotProduct += embA[i] * embB[i];
    normA += embA[i] * embA[i];
    normB += embB[i] * embB[i];
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

  return similarity;
}

// Re-export embeddingCache for convenience
export { embeddingCache };

// Static snapshots of config values at module load time (Story M1.4)
// Note: These are evaluated once at import time. Use getEmbeddingDim()/getModelName() for runtime values.
export const EMBEDDING_DIM = getEmbeddingDim();
export const MODEL_NAME = getModelName();

// Expose config functions for external use
export { loadConfig, getModelName, getEmbeddingDim, getQuantized };
