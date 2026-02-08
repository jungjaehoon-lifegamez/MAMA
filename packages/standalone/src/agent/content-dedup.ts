/**
 * Content Deduplicator for MAMA OS Standalone
 *
 * Prevents duplicate content injection into system prompts by using
 * SHA-256 content hashing and realpath normalization. Handles symlinks,
 * duplicate file paths, and identical content from different sources.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

/**
 * Represents a unique content entry after deduplication.
 */
export interface ContentEntry {
  /** Original file path as provided */
  path: string;
  /** Resolved real path (symlinks resolved) */
  realPath: string;
  /** The content string */
  content: string;
  /** Semantic distance from query (lower = closer match) */
  distance: number;
  /** SHA-256 hash prefix of the content */
  hash: string;
}

/**
 * Deduplicates content entries by SHA-256 hash and realpath normalization.
 *
 * When two entries share the same content hash, the entry with the smaller
 * distance (closer semantic match) is preferred. This ensures that even if
 * the same file is referenced via different paths (e.g., symlinks), only
 * the most relevant instance is kept.
 *
 * @example
 * ```typescript
 * const dedup = new ContentDeduplicator();
 * dedup.add('/path/to/file.ts', 'const x = 1;', 0.3);
 * dedup.add('/symlink/to/file.ts', 'const x = 1;', 0.5); // duplicate, ignored (higher distance)
 * dedup.add('/other/file.ts', 'const y = 2;', 0.1);
 * const entries = dedup.getEntries(); // 2 entries, sorted by distance
 * ```
 */
export class ContentDeduplicator {
  private seenHashes = new Map<string, ContentEntry>();

  /**
   * Add content for deduplication.
   *
   * Returns true if the content is new (not a duplicate). On hash collision,
   * the entry with the closest distance is preferred.
   *
   * @param path - File path of the content source
   * @param content - Raw content string
   * @param distance - Semantic distance from query (lower = better)
   * @returns true if content was added (new), false if duplicate
   */
  add(path: string, content: string, distance: number): boolean {
    const hash = this.hashContent(content);
    const realPath = this.safeRealpath(path);

    const existing = this.seenHashes.get(hash);

    if (existing) {
      // Hash collision: prefer the entry with closest distance
      if (distance < existing.distance) {
        this.seenHashes.set(hash, { path, realPath, content, distance, hash });
      }
      return false;
    }

    // Also check if same realpath already exists with a different hash
    // (content may have changed between reads — keep the new one if closer)
    for (const [existingHash, entry] of this.seenHashes) {
      if (entry.realPath === realPath) {
        if (distance < entry.distance) {
          this.seenHashes.delete(existingHash);
          this.seenHashes.set(hash, { path, realPath, content, distance, hash });
        }
        return false;
      }
    }

    this.seenHashes.set(hash, { path, realPath, content, distance, hash });
    return true;
  }

  /**
   * Get all unique entries sorted by distance (closest first).
   *
   * @returns Array of deduplicated content entries ordered by ascending distance
   */
  getEntries(): ContentEntry[] {
    return [...this.seenHashes.values()].sort((a, b) => a.distance - b.distance);
  }

  /**
   * Reset the deduplicator for reuse.
   * Clears all tracked hashes and entries.
   */
  reset(): void {
    this.seenHashes.clear();
  }

  /**
   * Hash raw content with SHA-256, returning first 16 hex characters for efficiency.
   *
   * 16 hex chars = 64 bits of entropy, sufficient for collision avoidance
   * in typical prompt injection scenarios (< 10,000 entries).
   *
   * @param content - Raw content string to hash
   * @returns First 16 hex characters of SHA-256 digest
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Resolve the real path of a file, following symlinks.
   *
   * Falls back to the original path if realpath resolution fails
   * (e.g., file doesn't exist yet, permission denied).
   *
   * @param filePath - File path to resolve
   * @returns Resolved real path or original path on error
   */
  private safeRealpath(filePath: string): string {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }
}
