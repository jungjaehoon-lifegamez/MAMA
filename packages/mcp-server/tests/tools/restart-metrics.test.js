/**
 * Integration Tests: Restart Success Rate & Latency Monitoring (Epic 4 - Story 4.2)
 *
 * Tests restart metrics functions:
 * - logRestartAttempt()
 * - calculateRestartSuccessRate()
 * - calculateRestartLatency()
 * - getRestartMetrics()
 * - get_restart_metrics MCP tool
 *
 * @date 2025-11-25
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getRestartMetricsTool } from '../../src/tools/quality-metrics-tools.js';
import { initDB, getAdapter, closeDB } from '../../src/mama/memory-store.js';
import mama from '../../src/mama/mama-api.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(os.tmpdir(), `mama-test-restart-metrics-${Date.now()}.db`);

// Mock tool context
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

describe('Story 4.2: Restart Success Rate & Latency Monitoring', () => {
  beforeAll(async () => {
    // Clean up any existing database files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Set test database path
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    // Initialize test database
    await initDB();

    // Ensure restart_metrics table exists (migration 007)
    const adapter = getAdapter();
    adapter.db.exec(`
      CREATE TABLE IF NOT EXISTS restart_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        failure_reason TEXT CHECK (failure_reason IN ('NO_CHECKPOINT', 'LOAD_ERROR', 'CONTEXT_INCOMPLETE', NULL)),
        latency_ms INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('full', 'summary')),
        narrative_count INTEGER DEFAULT 0,
        link_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_restart_metrics_timestamp ON restart_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_status ON restart_metrics(status);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_session ON restart_metrics(session_id);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_mode ON restart_metrics(mode);
    `);
  });

  afterAll(async () => {
    // Clean up test database
    await closeDB();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Clean up WAL files
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Clean up environment
    delete process.env.MAMA_DB_PATH;
  });

  beforeEach(async () => {
    // Always re-initialize DB to ensure clean state
    // This matches the pattern in link-tools.test.js
    await initDB();

    // Ensure restart_metrics table exists
    const adapter = getAdapter();
    adapter.db.exec(`
      CREATE TABLE IF NOT EXISTS restart_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        failure_reason TEXT CHECK (failure_reason IN ('NO_CHECKPOINT', 'LOAD_ERROR', 'CONTEXT_INCOMPLETE', NULL)),
        latency_ms INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('full', 'summary')),
        narrative_count INTEGER DEFAULT 0,
        link_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_timestamp ON restart_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_status ON restart_metrics(status);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_session ON restart_metrics(session_id);
      CREATE INDEX IF NOT EXISTS idx_restart_metrics_mode ON restart_metrics(mode);
    `);

    // Clear restart_metrics table
    adapter.db.prepare('DELETE FROM restart_metrics').run();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.2.1: Restart Logging Infrastructure
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.2.1: logRestartAttempt() - Restart Logging', () => {
    it('should log successful restart attempt', async () => {
      mama.logRestartAttempt('session_123', 'success', null, 1500, 'full');

      // Verify insertion
      const adapter = getAdapter();
      const row = adapter.db
        .prepare('SELECT * FROM restart_metrics WHERE session_id = ?')
        .get('session_123');

      expect(row).toBeDefined();
      expect(row.status).toBe('success');
      expect(row.failure_reason).toBeNull();
      expect(row.latency_ms).toBe(1500);
      expect(row.mode).toBe('full');
    });

    it('should log failed restart attempt with failure reason', async () => {
      await initDB();

      mama.logRestartAttempt('session_456', 'failure', 'NO_CHECKPOINT', 500, 'summary');

      const adapter = getAdapter();
      const row = adapter.db
        .prepare('SELECT * FROM restart_metrics WHERE session_id = ?')
        .get('session_456');

      expect(row).toBeDefined();
      expect(row.status).toBe('failure');
      expect(row.failure_reason).toBe('NO_CHECKPOINT');
      expect(row.latency_ms).toBe(500);
      expect(row.mode).toBe('summary');
    });

    it('should log all valid failure reasons', async () => {
      await initDB();

      const failureReasons = ['NO_CHECKPOINT', 'LOAD_ERROR', 'CONTEXT_INCOMPLETE'];

      failureReasons.forEach((reason, index) => {
        mama.logRestartAttempt(`session_fail_${index}`, 'failure', reason, 100, 'full');
      });

      const adapter = getAdapter();
      const rows = adapter.db
        .prepare('SELECT * FROM restart_metrics WHERE status = ?')
        .all('failure');

      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.failure_reason)).toEqual(failureReasons);
    });

    it('should warn when latency exceeds threshold', async () => {
      await initDB();

      // Capture console.warn
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (msg) => warnings.push(msg);

      // Full mode threshold: 2500ms (3000ms exceeds)
      mama.logRestartAttempt('session_slow_full', 'success', null, 3000, 'full');

      // Summary mode threshold: 1000ms (1500ms exceeds)
      mama.logRestartAttempt('session_slow_summary', 'success', null, 1500, 'summary');

      console.warn = originalWarn;

      expect(warnings.length).toBe(2);
      expect(warnings[0]).toContain('performance_warning');
      expect(warnings[0]).toContain('3000ms > 2500ms');
      expect(warnings[1]).toContain('1500ms > 1000ms');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.2.2: Success Rate Calculation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.2.2: calculateRestartSuccessRate() - Success Rate Aggregation', () => {
    it('should return 0% for empty database', async () => {
      await initDB();

      const rate = mama.calculateRestartSuccessRate('7d');

      expect(rate.successRate).toBe('0.0%');
      expect(rate.total).toBe(0);
      expect(rate.success).toBe(0);
      expect(rate.failure).toBe(0);
      expect(rate.meetsTarget).toBe(false);
    });

    it('should calculate 100% success rate', async () => {
      await initDB();

      // Log 10 successful restarts
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_${i}`, 'success', null, 1000 + i * 100, 'full');
      }

      const rate = mama.calculateRestartSuccessRate('7d');

      expect(rate.successRate).toBe('100.0%');
      expect(rate.total).toBe(10);
      expect(rate.success).toBe(10);
      expect(rate.failure).toBe(0);
      expect(rate.meetsTarget).toBe(true);
    });

    it('should calculate partial success rate', async () => {
      await initDB();

      // Log 7 successes, 3 failures (70% success rate)
      for (let i = 0; i < 7; i++) {
        mama.logRestartAttempt(`session_success_${i}`, 'success', null, 1000, 'full');
      }
      for (let i = 0; i < 3; i++) {
        mama.logRestartAttempt(`session_fail_${i}`, 'failure', 'LOAD_ERROR', 500, 'full');
      }

      const rate = mama.calculateRestartSuccessRate('7d');

      expect(rate.successRate).toBe('70.0%');
      expect(rate.total).toBe(10);
      expect(rate.success).toBe(7);
      expect(rate.failure).toBe(3);
      expect(rate.meetsTarget).toBe(false); // Below 95% threshold
    });

    it('should meet target at 95% success rate', async () => {
      await initDB();

      // Log 19 successes, 1 failure (95% success rate - meets target)
      for (let i = 0; i < 19; i++) {
        mama.logRestartAttempt(`session_success_${i}`, 'success', null, 1000, 'full');
      }
      mama.logRestartAttempt('session_fail', 'failure', 'NO_CHECKPOINT', 500, 'full');

      const rate = mama.calculateRestartSuccessRate('7d');

      expect(rate.successRate).toBe('95.0%');
      expect(rate.total).toBe(20);
      expect(rate.meetsTarget).toBe(true);
    });

    it('should filter by period (24h, 7d, 30d)', async () => {
      await initDB();
      const adapter = getAdapter();
      const db = adapter.db;

      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

      // Insert metrics at different times
      // Recent (within 24h): 5 success
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO restart_metrics (timestamp, session_id, status, latency_ms, mode)
           VALUES (?, ?, 'success', 1000, 'full')`
        ).run(now.toISOString(), `session_recent_${i}`);
      }

      // 2 days ago (within 7d): 3 success
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO restart_metrics (timestamp, session_id, status, latency_ms, mode)
           VALUES (?, ?, 'success', 1000, 'full')`
        ).run(twoDaysAgo.toISOString(), `session_2days_${i}`);
      }

      // 8 days ago (only in 30d): 2 success
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO restart_metrics (timestamp, session_id, status, latency_ms, mode)
           VALUES (?, ?, 'success', 1000, 'full')`
        ).run(eightDaysAgo.toISOString(), `session_8days_${i}`);
      }

      const rate24h = mama.calculateRestartSuccessRate('24h');
      const rate7d = mama.calculateRestartSuccessRate('7d');
      const rate30d = mama.calculateRestartSuccessRate('30d');

      expect(rate24h.total).toBe(5);
      expect(rate7d.total).toBe(8);
      expect(rate30d.total).toBe(10);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.2.3: Latency Percentile Calculation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.2.3: calculateRestartLatency() - Latency Percentiles', () => {
    it('should return zeros for empty database', async () => {
      await initDB();

      const latency = mama.calculateRestartLatency('7d', 'full');

      expect(latency.p50).toBe(0);
      expect(latency.p95).toBe(0);
      expect(latency.p99).toBe(0);
      expect(latency.count).toBe(0);
    });

    it('should calculate p50, p95, p99 percentiles', async () => {
      await initDB();

      // Log 100 successful restarts with varying latencies (100ms to 9900ms, step 100ms)
      for (let i = 0; i < 100; i++) {
        mama.logRestartAttempt(`session_latency_${i}`, 'success', null, (i + 1) * 100, 'full');
      }

      const latency = mama.calculateRestartLatency('7d', 'full');

      expect(latency.count).toBe(100);
      // p50 = 50th item = 5000ms
      expect(latency.p50).toBe(5000);
      // p95 = 95th item = 9500ms
      expect(latency.p95).toBe(9500);
      // p99 = 99th item = 9900ms
      expect(latency.p99).toBe(9900);
    });

    it('should separate latencies by mode (full vs summary)', async () => {
      await initDB();

      // Full mode: slower (2000-3000ms)
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_full_${i}`, 'success', null, 2000 + i * 100, 'full');
      }

      // Summary mode: faster (500-1000ms)
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_summary_${i}`, 'success', null, 500 + i * 50, 'summary');
      }

      const latencyFull = mama.calculateRestartLatency('7d', 'full');
      const latencySummary = mama.calculateRestartLatency('7d', 'summary');

      expect(latencyFull.count).toBe(10);
      expect(latencyFull.p95).toBeGreaterThan(2800);
      expect(latencyFull.mode).toBe('full');

      expect(latencySummary.count).toBe(10);
      expect(latencySummary.p95).toBeLessThan(1000);
      expect(latencySummary.mode).toBe('summary');
    });

    it('should calculate latency for all modes when mode is null', async () => {
      await initDB();

      // Mixed modes
      for (let i = 0; i < 5; i++) {
        mama.logRestartAttempt(`session_full_${i}`, 'success', null, 2000, 'full');
        mama.logRestartAttempt(`session_summary_${i}`, 'success', null, 800, 'summary');
      }

      const latencyAll = mama.calculateRestartLatency('7d', null);

      expect(latencyAll.count).toBe(10);
      expect(latencyAll.mode).toBe('all');
    });

    it('should only include successful restarts in latency calculation', async () => {
      await initDB();

      // 8 successes with latencies
      for (let i = 0; i < 8; i++) {
        mama.logRestartAttempt(`session_success_${i}`, 'success', null, 1000 + i * 100, 'full');
      }

      // 2 failures (should be excluded)
      mama.logRestartAttempt('session_fail_1', 'failure', 'LOAD_ERROR', 5000, 'full');
      mama.logRestartAttempt('session_fail_2', 'failure', 'NO_CHECKPOINT', 6000, 'full');

      const latency = mama.calculateRestartLatency('7d', 'full');

      expect(latency.count).toBe(8); // Only successes
      expect(latency.p95).toBeLessThan(2000); // Should not include 5000/6000ms failures
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Integration Tests: getRestartMetrics() and Quality Report
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Integration: getRestartMetrics() and Quality Report', () => {
    it('should combine success rate and latency metrics', async () => {
      await initDB();

      // Log diverse restart attempts
      for (let i = 0; i < 18; i++) {
        mama.logRestartAttempt(`session_success_${i}`, 'success', null, 1500 + i * 50, 'full');
      }
      for (let i = 0; i < 2; i++) {
        mama.logRestartAttempt(`session_fail_${i}`, 'failure', 'LOAD_ERROR', 800, 'full');
      }

      const metrics = mama.getRestartMetrics('7d', true);

      expect(metrics.successRate).toBeDefined();
      expect(metrics.successRate.successRate).toBe('90.0%'); // 18/20
      expect(metrics.successRate.meetsTarget).toBe(false); // Below 95%

      expect(metrics.latency).toBeDefined();
      expect(metrics.latency.full).toBeDefined();
      expect(metrics.latency.summary).toBeDefined();
    });

    it('should exclude latency when includeLatency is false', async () => {
      await initDB();

      mama.logRestartAttempt('session_1', 'success', null, 1000, 'full');

      const metrics = mama.getRestartMetrics('7d', false);

      expect(metrics.successRate).toBeDefined();
      expect(metrics.latency).toBeUndefined();
    });

    it('should be included in generateQualityReport()', async () => {
      await initDB();

      // Create restart metrics
      for (let i = 0; i < 20; i++) {
        mama.logRestartAttempt(`session_${i}`, 'success', null, 1200, 'full');
      }

      const report = mama.generateQualityReport({ period: '7d' });

      expect(report.restart).toBeDefined();
      expect(report.restart.successRate).toBeDefined();
      expect(report.restart.latency).toBeDefined();
      expect(report.restart.successRate.successRate).toBe('100.0%');
      expect(report.period).toBe('7d');
    });

    it('should generate recommendations when restart metrics below threshold', async () => {
      await initDB();

      // Low success rate (80% < 95%)
      for (let i = 0; i < 16; i++) {
        mama.logRestartAttempt(`session_success_${i}`, 'success', null, 1500, 'full');
      }
      for (let i = 0; i < 4; i++) {
        mama.logRestartAttempt(`session_fail_${i}`, 'failure', 'NO_CHECKPOINT', 500, 'full');
      }

      const report = mama.generateQualityReport();

      const restartRec = report.recommendations.find((r) => r.type === 'restart_success_rate');
      expect(restartRec).toBeDefined();
      expect(restartRec.target).toBe('95%');
      expect(restartRec.current).toBe('80.0%');
    });

    it('should generate latency recommendations when exceeding threshold', async () => {
      await initDB();

      // High latencies exceeding thresholds
      // Full mode: 3000ms > 2500ms
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_full_${i}`, 'success', null, 3000, 'full');
      }

      // Summary mode: 1200ms > 1000ms
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_summary_${i}`, 'success', null, 1200, 'summary');
      }

      const report = mama.generateQualityReport();

      const fullLatencyRec = report.recommendations.find((r) => r.type === 'restart_latency_full');
      const summaryLatencyRec = report.recommendations.find(
        (r) => r.type === 'restart_latency_summary'
      );

      expect(fullLatencyRec).toBeDefined();
      expect(fullLatencyRec.target).toBe('2500ms');
      expect(fullLatencyRec.current).toBe('3000ms');

      expect(summaryLatencyRec).toBeDefined();
      expect(summaryLatencyRec.target).toBe('1000ms');
      expect(summaryLatencyRec.current).toBe('1200ms');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MCP Tool Integration Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('MCP Tool: get_restart_metrics', () => {
    it('should return restart metrics with default parameters', async () => {
      await initDB();

      // Log test data
      for (let i = 0; i < 10; i++) {
        mama.logRestartAttempt(`session_${i}`, 'success', null, 1500, 'full');
      }

      const result = await getRestartMetricsTool.handler({}, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');

      const metricsText = result.content[0].text;
      const metrics = JSON.parse(metricsText);

      expect(metrics.successRate).toBeDefined();
      expect(metrics.latency).toBeDefined();
    });

    it('should support period parameter', async () => {
      await initDB();

      mama.logRestartAttempt('session_1', 'success', null, 1000, 'full');

      const result = await getRestartMetricsTool.handler({ period: '24h' }, mockContext);

      const metricsText = result.content[0].text;
      const metrics = JSON.parse(metricsText);

      expect(metrics.successRate.period).toBe('24h');
    });

    it('should support include_latency parameter', async () => {
      await initDB();

      mama.logRestartAttempt('session_1', 'success', null, 1000, 'full');

      const resultWithLatency = await getRestartMetricsTool.handler(
        { include_latency: true },
        mockContext
      );
      const metricsWithLatency = JSON.parse(resultWithLatency.content[0].text);

      const resultWithoutLatency = await getRestartMetricsTool.handler(
        { include_latency: false },
        mockContext
      );
      const metricsWithoutLatency = JSON.parse(resultWithoutLatency.content[0].text);

      expect(metricsWithLatency.latency).toBeDefined();
      expect(metricsWithoutLatency.latency).toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      // Close database to simulate error
      await closeDB();

      const result = await getRestartMetricsTool.handler({}, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toMatch(/Failed to get restart metrics/);

      // Reinitialize for cleanup
      await initDB();
    });
  });
});
