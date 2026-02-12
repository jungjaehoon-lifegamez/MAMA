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
 */

import crypto from 'crypto';

// Cache configuration
export const MAX_CACHE_SIZE = 1000; // Max 1000 entries (story req 2.2)
const CLEANUP_THRESHOLD = 1100; // Trigger cleanup at 110%

interface CacheEntry {
  embedding: Float32Array;
  timestamp: number;
  lastAccessed: number;
  hits: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  totalSize: number;
}

export interface CacheStatsReport extends CacheStats {
  hitRatio: number;
  size: number;
  maxSize: number;
}

/**
 * LRU Cache for embeddings
 *
 * Key: SHA-256 hash of decision text
 * Value: {embedding: Float32Array, timestamp: number, hits: number}
 *
 * Eviction: Least Recently Used when size > MAX_CACHE_SIZE
 */
export class EmbeddingCache {
  private cache: Map<string, CacheEntry>;
  private stats: CacheStats;

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
   */
  generateKey(text: string): string {
    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string');
    }

    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Get embedding from cache
   *
   * Task 2.2: Cache hit updates LRU position
   */
  get(text: string): Float32Array | null {
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
   */
  set(text: string, embedding: Float32Array): void {
    const key = this.generateKey(text);

    // Check if already exists (update case)
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.embedding = embedding;
      entry.lastAccessed = Date.now();

      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      return;
    }

    // New entry
    const entry: CacheEntry = {
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
  evictLRU(): void {
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
      this.stats.totalSize--;
    }
  }

  /**
   * Get cache hit ratio
   *
   * Task 2.4: Cache hit ratio target: > 80%
   */
  getHitRatio(): number {
    const total = this.stats.hits + this.stats.misses;

    if (total === 0) {
      return 0;
    }

    return this.stats.hits / total;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStatsReport {
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
  clear(): void {
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
export const embeddingCache = new EmbeddingCache();
