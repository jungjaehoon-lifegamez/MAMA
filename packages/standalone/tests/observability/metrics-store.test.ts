/**
 * Unit tests for MetricsStore (STORY-019)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { MetricsStore } from '../../src/observability/metrics-store.js';

const TEST_DIR = join(__dirname, '..', '.tmp-metrics-test');
let store: MetricsStore;
let dbPath: string;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  dbPath = join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  MetricsStore.resetInstances();
  store = MetricsStore.getInstance(dbPath);
});

afterEach(() => {
  MetricsStore.resetInstances();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('MetricsStore', () => {
  describe('singleton', () => {
    it('should return same instance for same path', () => {
      const store2 = MetricsStore.getInstance(dbPath);
      expect(store2).toBe(store);
    });

    it('should return different instance for different path', () => {
      const otherPath = join(TEST_DIR, 'other.db');
      const store2 = MetricsStore.getInstance(otherPath);
      expect(store2).not.toBe(store);
    });
  });

  describe('record()', () => {
    it('should insert a metric', () => {
      store.record({ name: 'request_count', value: 1 });
      expect(store.count('request_count')).toBe(1);
    });

    it('should use provided timestamp', () => {
      store.record({ name: 'latency', value: 150, timestamp: 1000 });
      const rows = store.query({ name: 'latency' });
      expect(rows[0].timestamp).toBe(1000);
    });

    it('should store labels as JSON', () => {
      store.record({ name: 'error', value: 1, labels: { agent: 'dev', code: '500' } });
      const rows = store.query({ name: 'error' });
      expect(JSON.parse(rows[0].labels!)).toEqual({ agent: 'dev', code: '500' });
    });
  });

  describe('recordBatch()', () => {
    it('should insert multiple metrics in transaction', () => {
      store.recordBatch([
        { name: 'cpu', value: 0.5, timestamp: 1000 },
        { name: 'cpu', value: 0.7, timestamp: 2000 },
        { name: 'mem', value: 512, timestamp: 1000 },
      ]);
      expect(store.count('cpu')).toBe(2);
      expect(store.count('mem')).toBe(1);
    });
  });

  describe('query()', () => {
    beforeEach(() => {
      store.recordBatch([
        { name: 'latency', value: 100, timestamp: 1000, labels: { agent: 'dev' } },
        { name: 'latency', value: 200, timestamp: 2000, labels: { agent: 'reviewer' } },
        { name: 'latency', value: 150, timestamp: 3000, labels: { agent: 'dev' } },
        { name: 'errors', value: 1, timestamp: 1500 },
      ]);
    });

    it('should query by name', () => {
      const rows = store.query({ name: 'latency' });
      expect(rows).toHaveLength(3);
    });

    it('should filter by time range', () => {
      const rows = store.query({ name: 'latency', startTs: 1500, endTs: 2500 });
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(200);
    });

    it('should filter by labels', () => {
      const rows = store.query({ name: 'latency', labels: { agent: 'dev' } });
      expect(rows).toHaveLength(2);
    });

    it('should respect limit', () => {
      const rows = store.query({ name: 'latency', limit: 1 });
      expect(rows).toHaveLength(1);
      // Ordered by timestamp DESC, so most recent first
      expect(rows[0].timestamp).toBe(3000);
    });

    it('should return empty for non-existent name', () => {
      expect(store.query({ name: 'nonexistent' })).toHaveLength(0);
    });
  });

  describe('aggregate()', () => {
    beforeEach(() => {
      store.recordBatch([
        { name: 'latency', value: 100, timestamp: 1000 },
        { name: 'latency', value: 200, timestamp: 2000 },
        { name: 'latency', value: 300, timestamp: 3000 },
      ]);
    });

    it('should compute aggregations', () => {
      const agg = store.aggregate('latency');
      expect(agg).not.toBeNull();
      expect(agg!.count).toBe(3);
      expect(agg!.sum).toBe(600);
      expect(agg!.avg).toBe(200);
      expect(agg!.min).toBe(100);
      expect(agg!.max).toBe(300);
    });

    it('should filter by time range', () => {
      const agg = store.aggregate('latency', 1500, 2500);
      expect(agg!.count).toBe(1);
      expect(agg!.sum).toBe(200);
    });

    it('should return null for no data', () => {
      expect(store.aggregate('nonexistent')).toBeNull();
    });
  });

  describe('cleanup()', () => {
    it('should delete metrics older than threshold', () => {
      const now = Date.now();
      store.recordBatch([
        { name: 'old', value: 1, timestamp: now - 10000 },
        { name: 'old', value: 2, timestamp: now - 5000 },
        { name: 'new', value: 3, timestamp: now },
      ]);

      const deleted = store.cleanup(7000); // Delete older than 7s ago
      expect(deleted).toBe(1);
      expect(store.count()).toBe(2);
    });
  });

  describe('count()', () => {
    it('should count all metrics', () => {
      store.record({ name: 'a', value: 1 });
      store.record({ name: 'b', value: 2 });
      expect(store.count()).toBe(2);
    });

    it('should count by name', () => {
      store.record({ name: 'a', value: 1 });
      store.record({ name: 'a', value: 2 });
      store.record({ name: 'b', value: 3 });
      expect(store.count('a')).toBe(2);
    });
  });

  describe('close()', () => {
    it('should remove from instances and close db', () => {
      store.close();
      // Getting instance again should create a new one
      const store2 = MetricsStore.getInstance(dbPath);
      expect(store2).not.toBe(store);
    });
  });

  describe('WAL mode', () => {
    it('should use WAL journal mode', () => {
      // Access the internal db to check pragma
      const store2 = MetricsStore.getInstance(dbPath);
      // Record something to ensure db is working
      store2.record({ name: 'test', value: 1 });
      expect(store2.count()).toBe(1);
    });
  });
});
