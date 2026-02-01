/**
 * MAMA (Memory-Augmented MCP Architecture) - Embedding Cache
 *
 * LRU cache for embedding vectors to avoid re-computation
 *
 * Task 2: Implement Embedding Cache
 * AC #3: Cache embeddings to avoid re-computation
 * Target: > 80% cache hit ratio
 *
 * @module embedding-cache
 * @version 1.0
 * @date 2025-11-14
 */

const crypto = require('crypto');

// Cache configuration
const MAX_CACHE_SIZE = 1000; // Max 1000 entries (story req 2.2)
const CLEANUP_THRESHOLD = 1100; // Trigger cleanup at 110%

/**
 * LRU Cache for embeddings
 *
 * Key: SHA-256 hash of decision text
 * Value: {embedding: Float32Array, timestamp: number, hits: number}
 *
 * Eviction: Least Recently Used when size > MAX_CACHE_SIZE
 */
class EmbeddingCache {
  constructor() {
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalSize: 0,
    };
  }

  /**
   * Generate cache key from text
   *
   * Task 2.3: Key = decision text hash (SHA-256)
   *
   * @param {string} text - Input text
   * @returns {string} SHA-256 hex hash
   */
  generateKey(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string');
    }

    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Get embedding from cache
   *
   * Task 2.2: Cache hit updates LRU position
   *
   * @param {string} text - Input text
   * @returns {Float32Array|null} Cached embedding or null
   */
  get(text) {
    const key = this.generateKey(text);
    const entry = this.cache.get(key);

    if (entry) {
      // Cache hit - update LRU position
      this.stats.hits++;
      entry.hits++;
      entry.lastAccessed = Date.now();

      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);

      return entry.embedding;
    }

    // Cache miss
    this.stats.misses++;
    return null;
  }

  /**
   * Store embedding in cache
   *
   * Task 2.2: Add to cache with LRU tracking
   * Task 2.5: Implement cache eviction (LRU)
   *
   * @param {string} text - Input text
   * @param {Float32Array} embedding - Embedding vector
   */
  set(text, embedding) {
    const key = this.generateKey(text);

    // Check if already exists (update case)
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      entry.embedding = embedding;
      entry.lastAccessed = Date.now();

      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      return;
    }

    // New entry
    const entry = {
      embedding,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      hits: 0,
    };

    this.cache.set(key, entry);
    this.stats.totalSize++;

    // Trigger cleanup if threshold exceeded
    if (this.cache.size > CLEANUP_THRESHOLD) {
      this.evictLRU();
    }
  }

  /**
   * Evict least recently used entries
   *
   * Task 2.5: Implement cache eviction (LRU)
   * Strategy: Remove entries until size <= MAX_CACHE_SIZE
   *
   * Eviction order:
   * 1. Oldest lastAccessed (LRU)
   * 2. If tied, lowest hits
   */
  evictLRU() {
    const targetEvictions = this.cache.size - MAX_CACHE_SIZE;

    if (targetEvictions <= 0) {
      return;
    }

    // Convert to array for sorting
    const entries = Array.from(this.cache.entries());

    // Sort by LRU (oldest first), then by hits (lowest first)
    entries.sort((a, b) => {
      const [, entryA] = a;
      const [, entryB] = b;

      // Primary: lastAccessed (ascending - oldest first)
      if (entryA.lastAccessed !== entryB.lastAccessed) {
        return entryA.lastAccessed - entryB.lastAccessed;
      }

      // Secondary: hits (ascending - lowest first)
      return entryA.hits - entryB.hits;
    });

    // Evict oldest entries
    for (let i = 0; i < targetEvictions; i++) {
      const [key] = entries[i];
      this.cache.delete(key);
      this.stats.evictions++;
    }
  }

  /**
   * Get cache hit ratio
   *
   * Task 2.4: Cache hit ratio target: > 80%
   *
   * @returns {number} Hit ratio (0.0 - 1.0)
   */
  getHitRatio() {
    const total = this.stats.hits + this.stats.misses;

    if (total === 0) {
      return 0;
    }

    return this.stats.hits / total;
  }

  /**
   * Get cache statistics
   *
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      ...this.stats,
      hitRatio: this.getHitRatio(),
      size: this.cache.size,
      maxSize: MAX_CACHE_SIZE,
    };
  }

  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalSize: 0,
    };
  }
}

// Singleton instance
const embeddingCache = new EmbeddingCache();

module.exports = {
  embeddingCache,
  EmbeddingCache,
  MAX_CACHE_SIZE,
};
