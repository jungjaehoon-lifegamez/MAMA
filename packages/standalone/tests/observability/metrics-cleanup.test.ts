/**
 * Tests for MetricsCleanup (STORY-022)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { MetricsStore } from '../../src/observability/metrics-store.js';
import { MetricsCleanup } from '../../src/observability/metrics-cleanup.js';

const TEST_DIR = join(__dirname, '..', '.tmp-cleanup-test');
let store: MetricsStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = join(TEST_DIR, `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  MetricsStore.resetInstances();
  store = MetricsStore.getInstance(dbPath);
});

afterEach(() => {
  MetricsStore.resetInstances();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('MetricsCleanup', () => {
  describe('runCleanup()', () => {
    it('should delete metrics older than retention period', () => {
      const now = Date.now();
      store.recordBatch([
        { name: 'old', value: 1, timestamp: now - 10000 },
        { name: 'old', value: 2, timestamp: now - 8000 },
        { name: 'new', value: 3, timestamp: now },
      ]);

      const cleanup = new MetricsCleanup(store, { retentionMs: 5000 });
      const deleted = cleanup.runCleanup();
      expect(deleted).toBe(2);
      expect(store.count()).toBe(1);
    });

    it('should return 0 when nothing to clean', () => {
      store.record({ name: 'fresh', value: 1, timestamp: Date.now() });
      const cleanup = new MetricsCleanup(store, { retentionMs: 60000 });
      expect(cleanup.runCleanup()).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('should start and stop the timer', () => {
      const cleanup = new MetricsCleanup(store, { intervalMs: 100000 });
      expect(cleanup.isRunning()).toBe(false);
      cleanup.start();
      expect(cleanup.isRunning()).toBe(true);
      cleanup.stop();
      expect(cleanup.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      const cleanup = new MetricsCleanup(store, { intervalMs: 100000 });
      cleanup.start();
      cleanup.start(); // idempotent
      expect(cleanup.isRunning()).toBe(true);
      cleanup.stop();
    });

    it('should run cleanup on start', () => {
      const now = Date.now();
      store.record({ name: 'old', value: 1, timestamp: now - 10000 });
      store.record({ name: 'new', value: 2, timestamp: now });

      const cleanup = new MetricsCleanup(store, { retentionMs: 5000, intervalMs: 100000 });
      cleanup.start();
      // Initial cleanup should have run
      expect(store.count()).toBe(1);
      cleanup.stop();
    });
  });

  describe('defaults', () => {
    it('should use 7-day retention by default', () => {
      const cleanup = new MetricsCleanup(store);
      const now = Date.now();
      // Record something 6 days ago (should survive)
      store.record({ name: 'recent', value: 1, timestamp: now - 6 * 24 * 60 * 60 * 1000 });
      // Record something 8 days ago (should be cleaned)
      store.record({ name: 'old', value: 2, timestamp: now - 8 * 24 * 60 * 60 * 1000 });

      cleanup.runCleanup();
      expect(store.count()).toBe(1);
    });
  });
});
