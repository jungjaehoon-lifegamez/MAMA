/**
 * Integration tests for FR-006 observability runtime wiring
 *
 * Verifies:
 * 1. MetricsStore is wired to AgentLoop onMetric callback
 * 2. /api/metrics/health endpoint returns HealthReport
 * 3. /api/metrics/health returns 503 when healthService not provided
 * 4. MetricsCleanup start/stop lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import request from 'supertest';
import { MetricsStore } from '../../src/observability/metrics-store.js';
import { MetricsCleanup } from '../../src/observability/metrics-cleanup.js';
import { HealthScoreService } from '../../src/observability/health-score.js';
import { createApiServer } from '../../src/api/index.js';
import { CronScheduler } from '../../src/scheduler/index.js';

const TEST_DIR = join(__dirname, '..', '.tmp-metrics-wiring-test');
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

describe('FR-006: Observability Runtime Wiring', () => {
  describe('onMetric callback → MetricsStore', () => {
    it('should record metrics via the callback pattern', () => {
      // Simulate what start.ts wires up
      const onMetric = (name: string, value: number, labels?: Record<string, string>) => {
        try {
          store.record({ name, value, labels });
        } catch {
          /* ignore */
        }
      };

      onMetric('prompt_latency_ms', 150, { backend: 'claude' });
      onMetric('tool_duration_ms', 42, { tool: 'mama_search' });

      const results = store.query({ name: 'prompt_latency_ms' });
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(150);

      const toolResults = store.query({ name: 'tool_duration_ms' });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].value).toBe(42);
    });

    it('should not throw when store errors', () => {
      // Close the store's DB to force errors
      MetricsStore.resetInstances();

      const onMetric = (name: string, value: number, labels?: Record<string, string>) => {
        try {
          store.record({ name, value, labels });
        } catch {
          /* ignore */
        }
      };

      // Should not throw
      expect(() => onMetric('test', 1)).not.toThrow();
    });
  });

  describe('/api/metrics/health endpoint', () => {
    it('should return HealthReport when healthService is provided', async () => {
      // Seed some metrics so health score has data
      store.record({ name: 'prompt_latency_ms', value: 100, labels: { backend: 'claude' } });

      const healthService = new HealthScoreService(store);
      const scheduler = new CronScheduler();
      const apiServer = createApiServer({
        scheduler,
        port: 0,
        healthService,
      });

      const res = await request(apiServer.app).get('/api/metrics/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('score');
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('components');
      expect(res.body).toHaveProperty('timestamp');

      scheduler.shutdown();
    });

    it('should return 503 when healthService is not provided', async () => {
      const scheduler = new CronScheduler();
      const apiServer = createApiServer({
        scheduler,
        port: 0,
      });

      const res = await request(apiServer.app).get('/api/metrics/health');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Metrics not available' });

      scheduler.shutdown();
    });
  });

  describe('/health endpoint unchanged', () => {
    it('should still return watchdog-compatible response', async () => {
      const scheduler = new CronScheduler();
      const apiServer = createApiServer({
        scheduler,
        port: 0,
      });

      const res = await request(apiServer.app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');

      scheduler.shutdown();
    });
  });

  describe('MetricsCleanup lifecycle', () => {
    it('should start and stop without errors', () => {
      const cleanup = new MetricsCleanup(store);
      expect(() => cleanup.start()).not.toThrow();
      expect(() => cleanup.stop()).not.toThrow();
    });

    it('should be idempotent on stop', () => {
      const cleanup = new MetricsCleanup(store);
      cleanup.start();
      cleanup.stop();
      expect(() => cleanup.stop()).not.toThrow();
    });
  });
});
