/**
 * MAMA (Memory-Augmented MCP Architecture) - Embedding Generation
 *
 * Story M1.4: Configurable embedding model selection
 * Generates embeddings using configurable model (default: multilingual-e5-small)
 * Supports: Korean-English cross-lingual similarity, enhanced metadata
 *
 * Updated: Now uses HTTP client to connect to MCP server's embedding service
 * for fast embedding generation (avoids cold start in hooks).
 * Falls back to local model loading if server is unavailable.
 *
 * @module embeddings
 * @version 1.2
 * @date 2025-11-25
 */

const { info, warn } = require('./debug-logger');
// Lazy-load @huggingface/transformers to avoid loading sharp at module load time (Story 014.12.7)
// const { pipeline } = require('@huggingface/transformers');
const { embeddingCache } = require('./embedding-cache');
const { loadConfig, getModelName, getEmbeddingDim } = require('./config-loader');
const { isServerRunning, getEmbeddingFromServer } = require('./embedding-client');

// Singleton pattern for model loading (fallback only)
let embeddingPipeline = null;
let currentModelName = null;
let serverAvailable = null; // null = unknown, true/false = checked

/**
 * Load embedding model (configurable)
 *
 * Story M1.4 AC #2: Transformers.js singleton initialization
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @returns {Promise<Function>} Embedding pipeline
 */
async function loadModel() {
  // TIER 3: Skip model loading entirely for tests
  if (process.env.MAMA_FORCE_TIER_3 === 'true') {
    info('[MAMA] Tier 3 mode: Skipping embedding model load');
    return null;
  }

  const modelName = getModelName();

  // Check if model has changed (Story M1.4 AC #3)
  if (embeddingPipeline && currentModelName && currentModelName !== modelName) {
    info('[MAMA] ⚠️  Embedding model changed - resetting pipeline');
    info(`[MAMA] Old model: ${currentModelName}`);
    info(`[MAMA] New model: ${modelName}`);

    // Reset pipeline and cache
    embeddingPipeline = null;
    currentModelName = null;
    embeddingCache.clear();

    info('[MAMA] ⚡ Model cache cleared');
  }

  // Load model if not already loaded
  if (!embeddingPipeline) {
    info(`[MAMA] Loading embedding model: ${modelName}...`);
    const startTime = Date.now();

    // Dynamic import for ES Module compatibility (Railway deployment)
    const transformers = await import('@huggingface/transformers');
    const { pipeline } = transformers;
    embeddingPipeline = await pipeline('feature-extraction', modelName);
    currentModelName = modelName;

    const loadTime = Date.now() - startTime;
    const config = loadConfig();
    info(`[MAMA] Model loaded in ${loadTime}ms (${config.embeddingDim}-dim)`);
  }

  return embeddingPipeline;
}

/**
 * Generate embedding vector from text
 *
 * Story M1.4 AC #1: Uses configurable embeddingDim from config
 * Target: < 30ms latency (via HTTP server)
 *
 * Strategy:
 * 1. Check cache first
 * 2. Try HTTP server (MCP server's embedding service) - fast path
 * 3. Fall back to local model loading if server unavailable - slow path
 *
 * @param {string} text - Input text to embed
 * @returns {Promise<Float32Array|null>} Embedding vector (dimension from config) or null if Tier 3
 * @throws {Error} If text is empty or embedding fails
 */
async function generateEmbedding(text) {
  // TIER 3: Skip embedding generation entirely
  if (process.env.MAMA_FORCE_TIER_3 === 'true') {
    info('[MAMA] Tier 3 mode: Skipping embedding generation');
    return null;
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  // Task 2: Check cache first (AC #3)
  const cached = embeddingCache.get(text);
  if (cached) {
    return cached;
  }

  // Try HTTP server first (fast path)
  // Only check server availability once per process
  if (serverAvailable === null) {
    serverAvailable = await isServerRunning();
    if (serverAvailable) {
      info('[MAMA] Embedding server detected, using HTTP client');
    } else {
      warn('[MAMA] Embedding server not available, using local fallback');
    }
  }

  if (serverAvailable) {
    const embedding = await getEmbeddingFromServer(text);
    if (embedding) {
      // Store in cache
      embeddingCache.set(text, embedding);
      return embedding;
    }
    // Server failed, fall through to local model
    warn('[MAMA] Server request failed, falling back to local model');
    serverAvailable = false; // Don't try server again this process
  }

  // Fallback: Local model loading (slow path)
  try {
    const model = await loadModel();
    const expectedDim = getEmbeddingDim();

    // Generate embedding
    const output = await model(text, {
      pooling: 'mean', // Mean pooling over tokens
      normalize: true, // L2 normalization
    });

    // Extract Float32Array
    const embedding = output.data;

    // Verify dimensions match config
    if (embedding.length !== expectedDim) {
      throw new Error(`Expected ${expectedDim}-dim, got ${embedding.length}-dim`);
    }

    // Task 2: Store in cache (AC #3)
    embeddingCache.set(text, embedding);

    return embedding;
  } catch (error) {
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Generate enhanced embedding with content + metadata
 *
 * Task 3.4: Implement enhanced embedding format
 * Inspired by A-mem: Content + Metadata for richer semantic representation
 *
 * @param {Object} decision - Decision object
 * @param {string} decision.topic - Decision topic
 * @param {string} decision.decision - Decision value
 * @param {string} decision.reasoning - Decision reasoning
 * @param {string} decision.outcome - Decision outcome (optional)
 * @param {number} decision.confidence - Confidence score (optional)
 * @param {string} decision.user_involvement - User involvement (optional)
 * @returns {Promise<Float32Array>} 384-dim enhanced embedding
 */
async function generateEnhancedEmbedding(decision) {
  // Construct enriched text representation
  // Note: Use raw text to preserve semantic signal for embeddings.
  const enrichedText = `
Topic: ${decision.topic}
Decision: ${decision.decision}
Reasoning: ${decision.reasoning || 'N/A'}
Outcome: ${decision.outcome || 'ONGOING'}
Confidence: ${decision.confidence !== undefined ? decision.confidence : 0.5}
User Involvement: ${decision.user_involvement || 'N/A'}
`.trim();

  return generateEmbedding(enrichedText);
}

/**
 * Batch generate embeddings (optimized)
 *
 * Task 1: Implement Batch Embedding Generation
 * AC #3: Target - 30ms for 10 embeddings (vs 300ms sequential)
 *
 * Strategy: Use native transformer batch processing for parallel inference
 *
 * @param {string[]} texts - Array of texts to embed (max 10 per batch)
 * @returns {Promise<Float32Array[]>} Array of embeddings
 */
async function generateBatchEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('Texts must be a non-empty array');
  }

  // Validate all texts
  for (const text of texts) {
    if (!text || text.trim().length === 0) {
      throw new Error('All texts must be non-empty');
    }
  }

  const startTime = Date.now();

  try {
    const model = await loadModel();
    const expectedDim = getEmbeddingDim();

    // Native batch processing - single model forward pass
    // This is significantly faster than sequential calls
    const outputs = await model(texts, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract embeddings from batch output
    const embeddings = [];
    const batchSize = texts.length;

    for (let i = 0; i < batchSize; i++) {
      // Each embedding is expectedDim consecutive elements
      const start = i * expectedDim;
      const end = start + expectedDim;
      const embedding = outputs.data.slice(start, end);

      // Verify dimensions
      if (embedding.length !== expectedDim) {
        throw new Error(`Expected ${expectedDim}-dim, got ${embedding.length}-dim at index ${i}`);
      }

      embeddings.push(embedding);
    }

    const latency = Date.now() - startTime;
    const avgLatency = latency / batchSize;

    // Log for performance tracking
    if (process.env.MAMA_DEBUG) {
      info(
        `[MAMA] Batch(${batchSize}) embeddings: ${latency}ms total (${avgLatency.toFixed(1)}ms avg)`
      );
    }

    return embeddings;
  } catch (error) {
    throw new Error(`Failed to generate batch embeddings: ${error.message}`);
  }
}

/**
 * Calculate cosine similarity between two embeddings
 *
 * Utility for testing and validation
 *
 * @param {Float32Array} embA - First embedding
 * @param {Float32Array} embB - Second embedding
 * @returns {number} Cosine similarity (0-1)
 */
function cosineSimilarity(embA, embB) {
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

// Export API
module.exports = {
  generateEmbedding,
  generateEnhancedEmbedding,
  generateBatchEmbeddings,
  cosineSimilarity,
  embeddingCache,
  // Dynamic getters for config values (Story M1.4)
  get EMBEDDING_DIM() {
    return getEmbeddingDim();
  },
  get MODEL_NAME() {
    return getModelName();
  },
  // Expose config functions for external use
  loadConfig,
  getModelName,
  getEmbeddingDim,
};
