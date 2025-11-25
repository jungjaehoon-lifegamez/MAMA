/**
 * MAMA Search Engine - Semantic Vector Search
 *
 * Story 2.2: Narrative Search/Expansion
 * Implements semantic search using sqlite-vec and enhanced embeddings
 *
 * @module search-engine
 * @version 1.0
 * @date 2025-11-25
 */

const { info, error: logError } = require('./debug-logger');
const { generateEmbedding } = require('./embeddings');
const { vectorSearch } = require('./memory-store');

/**
 * Search Engine for narrative/decision search
 *
 * Provides semantic search capabilities using vector embeddings
 * and sqlite-vec cosine similarity
 */
class SearchEngine {
  constructor() {
    this.defaultLimit = 5;
    this.defaultThreshold = 0.7;
  }

  /**
   * Search decisions by query string
   *
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {number} options.limit - Maximum results to return (default: 5)
   * @param {number} options.threshold - Minimum similarity threshold (default: 0.7)
   * @returns {Promise<Array<Object>>} Array of decisions with similarity scores
   */
  async search(query, options = {}) {
    const { limit = this.defaultLimit, threshold = this.defaultThreshold } = options;

    try {
      // Validate input
      if (!query || typeof query !== 'string' || query.trim() === '') {
        throw new Error('Query must be a non-empty string');
      }

      info(`[SearchEngine] Searching for: "${query}" (limit: ${limit}, threshold: ${threshold})`);

      // 1. Generate embedding for query
      const queryEmbedding = await generateEmbedding(query);

      if (!queryEmbedding || queryEmbedding.length === 0) {
        logError('[SearchEngine] Failed to generate query embedding');
        return [];
      }

      info(`[SearchEngine] Query embedding generated: ${queryEmbedding.length} dimensions`);

      // 2. Perform vector search
      const results = await vectorSearch(queryEmbedding, limit, threshold);

      info(`[SearchEngine] Found ${results.length} results above threshold ${threshold}`);

      // 3. Return results with similarity scores
      return results.map((decision) => ({
        ...decision,
        // Parse JSON fields if they exist
        evidence: decision.evidence ? JSON.parse(decision.evidence) : null,
        alternatives: decision.alternatives ? JSON.parse(decision.alternatives) : null,
        refined_from: decision.refined_from ? JSON.parse(decision.refined_from) : null,
        // Keep similarity and distance
        similarity: decision.similarity,
        distance: decision.distance,
      }));
    } catch (error) {
      logError(`[SearchEngine] Search failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Search with custom embedding (advanced use case)
   *
   * @param {Float32Array|Array<number>} embedding - Pre-computed embedding
   * @param {Object} options - Search options
   * @returns {Promise<Array<Object>>} Array of decisions with similarity scores
   */
  async searchByEmbedding(embedding, options = {}) {
    const { limit = this.defaultLimit, threshold = this.defaultThreshold } = options;

    try {
      if (!embedding || embedding.length === 0) {
        throw new Error('Embedding must be a non-empty array');
      }

      info(`[SearchEngine] Searching by embedding (limit: ${limit}, threshold: ${threshold})`);

      // Perform vector search
      const results = await vectorSearch(embedding, limit, threshold);

      info(`[SearchEngine] Found ${results.length} results`);

      return results.map((decision) => ({
        ...decision,
        evidence: decision.evidence ? JSON.parse(decision.evidence) : null,
        alternatives: decision.alternatives ? JSON.parse(decision.alternatives) : null,
        refined_from: decision.refined_from ? JSON.parse(decision.refined_from) : null,
        similarity: decision.similarity,
        distance: decision.distance,
      }));
    } catch (error) {
      logError(`[SearchEngine] Search by embedding failed: ${error.message}`);
      throw error;
    }
  }
}

// Singleton instance
const searchEngine = new SearchEngine();

module.exports = {
  SearchEngine,
  searchEngine,
  // Convenience functions
  search: (query, options) => searchEngine.search(query, options),
  searchByEmbedding: (embedding, options) => searchEngine.searchByEmbedding(embedding, options),
};
