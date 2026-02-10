/**
 * Unit tests for ContentDeduplicator
 *
 * Story: Content deduplication for system prompt injection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentDeduplicator } from '../../src/agent/content-dedup.js';

describe('ContentDeduplicator', () => {
  let dedup: ContentDeduplicator;

  beforeEach(() => {
    dedup = new ContentDeduplicator();
  });

  // ─────────────────────────────────────────────────────
  // add()
  // ─────────────────────────────────────────────────────
  describe('add()', () => {
    it('should return true for new content', () => {
      const result = dedup.add('/path/to/file.ts', 'const x = 1;', 0.3);
      expect(result).toBe(true);
    });

    it('should return false for duplicate content (same hash)', () => {
      dedup.add('/path/a.ts', 'const x = 1;', 0.3);
      const result = dedup.add('/path/b.ts', 'const x = 1;', 0.5);
      expect(result).toBe(false);
    });

    it('should replace existing entry when hash collision has closer distance', () => {
      dedup.add('/path/a.ts', 'const x = 1;', 0.5);
      dedup.add('/path/b.ts', 'const x = 1;', 0.2); // closer distance

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].distance).toBe(0.2);
      expect(entries[0].path).toBe('/path/b.ts');
    });

    it('should keep existing entry when hash collision has farther distance', () => {
      dedup.add('/path/a.ts', 'const x = 1;', 0.2);
      dedup.add('/path/b.ts', 'const x = 1;', 0.8); // farther distance

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].distance).toBe(0.2);
      expect(entries[0].path).toBe('/path/a.ts');
    });

    it('should handle same realpath with different content (file changed) — keeps closer', () => {
      // Two calls with the same path but different content
      // Second call: same realpath found, different hash
      // Since safeRealpath falls back to original for nonexistent paths,
      // use the same path string to simulate same realpath
      dedup.add('/path/a.ts', 'version 1', 0.5);
      const result = dedup.add('/path/a.ts', 'version 2', 0.3);

      // Returns false because same realpath was found
      expect(result).toBe(false);

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(1);
      // Closer distance wins
      expect(entries[0].distance).toBe(0.3);
      expect(entries[0].content).toBe('version 2');
    });

    it('should handle same realpath with different content — keeps existing when farther', () => {
      dedup.add('/path/a.ts', 'version 1', 0.2);
      const result = dedup.add('/path/a.ts', 'version 2', 0.8);

      expect(result).toBe(false);

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].distance).toBe(0.2);
      expect(entries[0].content).toBe('version 1');
    });

    it('should add multiple unique entries', () => {
      dedup.add('/path/a.ts', 'content A', 0.3);
      dedup.add('/path/b.ts', 'content B', 0.5);
      dedup.add('/path/c.ts', 'content C', 0.1);

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────────────
  // getEntries()
  // ─────────────────────────────────────────────────────
  describe('getEntries()', () => {
    it('should return entries sorted by distance (ascending)', () => {
      dedup.add('/path/a.ts', 'content A', 0.5);
      dedup.add('/path/b.ts', 'content B', 0.1);
      dedup.add('/path/c.ts', 'content C', 0.3);

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].distance).toBe(0.1);
      expect(entries[1].distance).toBe(0.3);
      expect(entries[2].distance).toBe(0.5);
    });

    it('should return empty array for empty deduplicator', () => {
      const entries = dedup.getEntries();
      expect(entries).toEqual([]);
    });

    it('should include all ContentEntry fields', () => {
      dedup.add('/path/to/file.ts', 'const x = 1;', 0.4);

      const entries = dedup.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toHaveProperty('path');
      expect(entries[0]).toHaveProperty('realPath');
      expect(entries[0]).toHaveProperty('content');
      expect(entries[0]).toHaveProperty('distance');
      expect(entries[0]).toHaveProperty('hash');
      expect(entries[0].content).toBe('const x = 1;');
      expect(entries[0].hash).toHaveLength(16);
    });
  });

  // ─────────────────────────────────────────────────────
  // reset()
  // ─────────────────────────────────────────────────────
  describe('reset()', () => {
    it('should clear all entries', () => {
      dedup.add('/path/a.ts', 'content A', 0.1);
      dedup.add('/path/b.ts', 'content B', 0.2);
      expect(dedup.getEntries()).toHaveLength(2);

      dedup.reset();
      expect(dedup.getEntries()).toHaveLength(0);
    });

    it('should allow adding new entries after reset', () => {
      dedup.add('/path/a.ts', 'content A', 0.1);
      dedup.reset();

      const result = dedup.add('/path/a.ts', 'content A', 0.1);
      expect(result).toBe(true);
      expect(dedup.getEntries()).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────
  // Symlink handling
  // ─────────────────────────────────────────────────────
  describe('Symlink handling', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mama-dedup-symlink-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should deduplicate two paths pointing to same realpath via symlink', () => {
      const realFile = join(tmpDir, 'real-file.ts');
      const symlinkFile = join(tmpDir, 'link-file.ts');
      writeFileSync(realFile, 'const x = 1;');
      symlinkSync(realFile, symlinkFile);

      const added1 = dedup.add(realFile, 'const x = 1;', 0.3);
      const added2 = dedup.add(symlinkFile, 'const x = 1;', 0.5);

      expect(added1).toBe(true);
      // Second add returns false — same content hash
      expect(added2).toBe(false);
      expect(dedup.getEntries()).toHaveLength(1);
    });

    it('should fall back to original path when realpath resolution fails', () => {
      // Nonexistent path — safeRealpath returns the original path
      const result = dedup.add('/nonexistent/path/file.ts', 'content', 0.1);
      expect(result).toBe(true);

      const entries = dedup.getEntries();
      expect(entries[0].realPath).toBe('/nonexistent/path/file.ts');
    });
  });
});
