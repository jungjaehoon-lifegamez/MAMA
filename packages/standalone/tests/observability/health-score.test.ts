/**
 * Tests for HealthScoreService (STORY-021)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { MetricsStore } from '../../src/observability/metrics-store.js';
import { HealthScoreService } from '../../src/observability/health-score.js';

const TEST_DIR = join(__dirname, '..', '.tmp-health-test');
let store: MetricsStore;
let service: HealthScoreService;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = join(TEST_DIR, `health-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  MetricsStore.resetInstances();
  store = MetricsStore.getInstance(dbPath);
  service = new HealthScoreService(store);
});

afterEach(() => {
  MetricsStore.resetInstances();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('HealthScoreService', () => {
  describe('compute() with no data', () => {
    it('should return healthy with score 100', () => {
      const report = service.compute();
      expect(report.score).toBe(100);
      expect(report.status).toBe('healthy');
      expect(report.components.prompt_latency.score).toBe(100);
      expect(report.components.error_rate.score).toBe(100);
      expect(report.components.tool_performance.score).toBe(100);
    });
  });

  describe('compute() with good metrics', () => {
    it('should return healthy for fast latency and no errors', () => {
      const now = Date.now();
      store.recordBatch([
        { name: 'prompt_latency_ms', value: 1500, timestamp: now - 1000 },
        { name: 'prompt_latency_ms', value: 1800, timestamp: now - 500 },
        { name: 'tool_duration_ms', value: 200, timestamp: now - 800 },
        { name: 'tool_duration_ms', value: 300, timestamp: now - 600 },
      ]);

      const report = service.compute();
      expect(report.score).toBeGreaterThanOrEqual(80);
      expect(report.status).toBe('healthy');
    });
  });

  describe('compute() with degraded metrics', () => {
    it('should return degraded for moderate latency and tools', () => {
      const now = Date.now();
      // Moderate latency ~20s avg, moderate tool latency ~5s → weighted < 80 but ≥ 50
      store.recordBatch([
        { name: 'prompt_latency_ms', value: 20000, timestamp: now - 1000 },
        { name: 'prompt_latency_ms', value: 20000, timestamp: now - 500 },
        { name: 'tool_duration_ms', value: 5000, timestamp: now - 300 },
        { name: 'tool_duration_ms', value: 5000, timestamp: now - 200 },
      ]);

      const report = service.compute();
      // latency score = 100 - ((20000-2000)/28000)*100 = 100-64.3 = 36
      // tool score = 100 - ((5000-500)/9500)*100 = 100-47.4 = 53
      // total = 36*0.4 + 100*0.4 + 53*0.2 = 14.4 + 40 + 10.6 = 65
      expect(report.score).toBeLessThan(80);
      expect(report.score).toBeGreaterThanOrEqual(50);
      expect(report.status).toBe('degraded');
    });
  });

  describe('compute() with unhealthy metrics', () => {
    it('should return unhealthy for extreme error rate + high latency', () => {
      const now = Date.now();
      // Many errors + high latency + slow tools → overall < 50
      for (let i = 0; i < 10; i++) {
        store.record({ name: 'prompt_error', value: 1, timestamp: now - i * 100 });
      }
      store.record({ name: 'prompt_latency_ms', value: 25000, timestamp: now - 50 });
      store.record({ name: 'tool_duration_ms', value: 8000, timestamp: now - 50 });

      const report = service.compute();
      expect(report.score).toBeLessThan(50);
      expect(report.status).toBe('unhealthy');
    });
  });

  describe('component scores', () => {
    it('prompt_latency: 100 for ≤2s avg', () => {
      store.record({ name: 'prompt_latency_ms', value: 1000, timestamp: Date.now() });
      const report = service.compute();
      expect(report.components.prompt_latency.score).toBe(100);
    });

    it('error_rate: 100 for 0 errors', () => {
      store.record({ name: 'prompt_latency_ms', value: 1000, timestamp: Date.now() });
      const report = service.compute();
      expect(report.components.error_rate.score).toBe(100);
    });

    it('tool_performance: 100 for ≤500ms avg', () => {
      store.record({ name: 'tool_duration_ms', value: 300, timestamp: Date.now() });
      const report = service.compute();
      expect(report.components.tool_performance.score).toBe(100);
    });
  });

  describe('time window', () => {
    it('should exclude metrics outside the window', () => {
      const now = Date.now();
      // Old error (outside 5min window)
      store.record({ name: 'prompt_error', value: 1, timestamp: now - 10 * 60 * 1000 });
      // Recent success
      store.record({ name: 'prompt_latency_ms', value: 1000, timestamp: now - 1000 });

      const report = service.compute(5 * 60 * 1000);
      expect(report.components.error_rate.score).toBe(100); // Old error excluded
    });
  });

  describe('report structure', () => {
    it('should have timestamp', () => {
      const before = Date.now();
      const report = service.compute();
      expect(report.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('should have all component details', () => {
      store.record({ name: 'prompt_latency_ms', value: 1000, timestamp: Date.now() });
      const report = service.compute();
      expect(report.components.prompt_latency.details).toHaveProperty('avg_ms');
      expect(report.components.prompt_latency.details).toHaveProperty('count');
    });
  });
});
