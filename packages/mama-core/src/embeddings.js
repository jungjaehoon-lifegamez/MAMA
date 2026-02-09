/**
 * MAMA (Memory-Augmented MCP Architecture) - Embedding Generation
 *
 * Story M1.4: Configurable embedding model selection
 * Generates embeddings using configurable model (default: multilingual-e5-small)
 * Supports: Korean-English cross-lingual similarity, enhanced metadata
 *
 * @module embeddings
 * @version 1.1
 * @date 2025-11-20
 */

// eslint-disable-next-line no-unused-vars
const { info, error: logError } = require('./debug-logger');
const { logProgress: _logProgress, logComplete, logLoading } = require('./progress-indicator');
const os = require('os');
const path = require('path');
// Lazy-load @huggingface/transformers to avoid loading sharp at module load time (Story 014.12.7)
// const { pipeline } = require('@huggingface/transformers');
const { embeddingCache } = require('./embedding-cache');
const { loadConfig, getModelName, getEmbeddingDim } = require('./config-loader');

// Shared cache directory (not in node_modules)
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'huggingface', 'transformers');

// Singleton pattern for model loading
let embeddingPipeline = null;
let currentModelName = null;
let modelLoadFailed = false; // Cache load failures to avoid repeated slow retries

/**
 * Load embedding model (configurable)
 *
 * Story M1.4 AC #2: Transformers.js singleton initialization
 * Story M1.4 AC #3: Changing model via config triggers informative log + resets caches
 *
 * @returns {Promise<Function>} Embedding pipeline
 */
async function loadModel() {
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

  // Fail fast if a previous load attempt already failed (avoid repeated slow retries)
  if (modelLoadFailed) {
    throw new Error('Embedding model previously failed to load — skipping retry');
  }

  // Load model if not already loaded
  if (!embeddingPipeline) {
    logLoading(`Loading embedding model: ${modelName}...`);
    const startTime = Date.now();

    try {
      // Dynamic import for ES Module compatibility (Railway deployment)
      const transformers = await import('@huggingface/transformers');
      const { pipeline, env } = transformers;

      // Set shared cache directory (not in node_modules)
      // This prevents re-downloading models on every npm install
      const cacheDir = process.env.HF_HOME || process.env.TRANSFORMERS_CACHE || DEFAULT_CACHE_DIR;
      env.cacheDir = cacheDir;
      info(`[MAMA] Model cache directory: ${cacheDir}`);

      embeddingPipeline = await pipeline('feature-extraction', modelName);
      currentModelName = modelName;

      const loadTime = Date.now() - startTime;
      const config = loadConfig();
      logComplete(`Embedding model ready (${loadTime}ms, ${config.embeddingDim}-dim)`);
    } catch (loadErr) {
      modelLoadFailed = true;
      throw loadErr;
    }
  }

  return embeddingPipeline;
}

/**
 * Generate embedding vector from text
 *
 * Story M1.4 AC #1: Uses configurable embeddingDim from config
 * Target: < 30ms latency
 *
 * @param {string} text - Input text to embed
 * @returns {Promise<Float32Array>} Embedding vector (dimension from config)
 * @throws {Error} If text is empty or embedding fails
 */
async function generateEmbedding(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Text cannot be empty');
  }

  // Task 2: Check cache first (AC #3)
  const cached = embeddingCache.get(text);
  if (cached) {
    return cached;
  }

  const startTime = Date.now();

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

    // eslint-disable-next-line no-unused-vars
    const latency = Date.now() - startTime;

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
