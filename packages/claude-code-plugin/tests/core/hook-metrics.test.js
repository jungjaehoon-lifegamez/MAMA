/**
 * Tests for Hook Metrics Module
 *
 * Story M2.5: Hook Performance Monitoring & Logging
 * Tests AC #1-5: Per-hook timings, metrics surfacing, degraded tier alerts, privacy, regression tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

describe('Story M2.5: Hook Metrics & Logging', () => {
  let metrics;
  let LOG_DIR;
  let METRICS_FILE;
  let metricsModulePath;

  beforeEach(() => {
    // Use a unique temp dir per test to avoid cross-worker conflicts
    LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-log-tests-'));
    process.env.MAMA_LOG_DIR = LOG_DIR;
    METRICS_FILE = path.join(LOG_DIR, 'hook-metrics.jsonl');

    // Force reload CommonJS module to pick up new environment variable
    // Clear ALL modules in src/core to ensure clean state
    const coreDir = path.resolve(__dirname, '../../src/core');
    Object.keys(require.cache).forEach((key) => {
      if (key.startsWith(coreDir)) {
        delete require.cache[key];
      }
    });

    // Import module (using createRequire since this is a CommonJS module)
    metricsModulePath = path.resolve(__dirname, '../../src/core/hook-metrics.js');
    metrics = require(metricsModulePath);
  });

  afterEach(() => {
    // Clean up metrics after each test
    metrics.clearMetrics();
    try {
      fs.rmSync(LOG_DIR, { recursive: true, force: true });
    } catch (e) {
      // best-effort cleanup
    }
  });

  describe('Module Structure', () => {
    it('should export required functions', () => {
      expect(metrics).toHaveProperty('logHookMetrics');
      expect(metrics).toHaveProperty('logAutoSaveOutcome');
      expect(metrics).toHaveProperty('getMetricsSummary');
      expect(metrics).toHaveProperty('formatMetricsDisplay');
      expect(metrics).toHaveProperty('clearMetrics');
      expect(metrics).toHaveProperty('hashSensitiveData');
      expect(metrics).toHaveProperty('redactSensitiveData');
      expect(metrics).toHaveProperty('getDegradedFeatures');
      expect(metrics).toHaveProperty('PERFORMANCE_TARGETS');
      expect(metrics).toHaveProperty('METRICS_FILE');

      expect(typeof metrics.logHookMetrics).toBe('function');
      expect(typeof metrics.getMetricsSummary).toBe('function');
    });

    it('should define performance targets', () => {
      expect(metrics.PERFORMANCE_TARGETS).toHaveProperty('maxLatencyMs');
      expect(metrics.PERFORMANCE_TARGETS).toHaveProperty('warningLatencyMs');

      expect(metrics.PERFORMANCE_TARGETS.maxLatencyMs).toBe(500);
      expect(metrics.PERFORMANCE_TARGETS.warningLatencyMs).toBe(400);
    });

    it('should use JSONL log file in configured log dir', () => {
      expect(metrics.METRICS_FILE).toContain(LOG_DIR);
      expect(metrics.METRICS_FILE).toContain('hook-metrics.jsonl');
    });
  });

  describe('AC #1: Per-Hook Timings and Metrics Capture', () => {
    it('should log hook metrics with all required fields', () => {
      metrics.logHookMetrics({
        hookName: 'UserPromptSubmit',
        latencyMs: 150,
        decisionCount: 5,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
      });

      expect(fs.existsSync(METRICS_FILE)).toBe(true);

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('hook_name');
      expect(entry).toHaveProperty('latency_ms');
      expect(entry).toHaveProperty('decision_count');
      expect(entry).toHaveProperty('tier');
      expect(entry).toHaveProperty('tier_reason');
      expect(entry).toHaveProperty('outcome');
      expect(entry).toHaveProperty('performance_target_met');

      expect(entry.hook_name).toBe('UserPromptSubmit');
      expect(entry.latency_ms).toBe(150);
      expect(entry.decision_count).toBe(5);
      expect(entry.tier).toBe(1);
      expect(entry.outcome).toBe('success');
    });

    it('should track performance target compliance', () => {
      // Fast operation
      metrics.logHookMetrics({
        hookName: 'PreToolUse',
        latencyMs: 200,
        decisionCount: 3,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
      });

      // Slow operation
      metrics.logHookMetrics({
        hookName: 'PostToolUse',
        latencyMs: 600,
        decisionCount: 2,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'timeout',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const lines = content.trim().split('\n');

      const fast = JSON.parse(lines[0]);
      const slow = JSON.parse(lines[1]);

      expect(fast.performance_target_met).toBe(true);
      expect(slow.performance_target_met).toBe(false);
    });

    it('should log JSONL format for multiple entries', () => {
      metrics.logHookMetrics({
        hookName: 'Hook1',
        latencyMs: 100,
        decisionCount: 1,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Hook2',
        latencyMs: 200,
        decisionCount: 2,
        tier: 2,
        tierReason: 'Degraded',
        outcome: 'success',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(2);

      lines.forEach((line) => {
        expect(() => JSON.parse(line)).not.toThrow();
      });
    });

    it('should capture different outcomes', () => {
      const outcomes = ['success', 'timeout', 'error', 'rate_limited'];

      outcomes.forEach((outcome) => {
        metrics.logHookMetrics({
          hookName: 'TestHook',
          latencyMs: 100,
          decisionCount: 0,
          tier: 1,
          tierReason: 'Test',
          outcome,
        });
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(4);

      lines.forEach((line, index) => {
        const entry = JSON.parse(line);
        expect(entry.outcome).toBe(outcomes[index]);
      });
    });
  });

  describe('AC #2: Metrics Surfacing', () => {
    it('should retrieve metrics summary', () => {
      // Log some metrics
      metrics.logHookMetrics({
        hookName: 'UserPromptSubmit',
        latencyMs: 150,
        decisionCount: 5,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'PreToolUse',
        latencyMs: 200,
        decisionCount: 3,
        tier: 2,
        tierReason: 'Degraded',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();

      expect(summary).toHaveProperty('total_entries');
      expect(summary).toHaveProperty('entries');
      expect(summary).toHaveProperty('statistics');

      expect(summary.total_entries).toBe(2);
      expect(summary.entries.length).toBe(2);
    });

    it('should calculate statistics correctly', () => {
      // Log metrics with known values
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        decisionCount: 1,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 200,
        decisionCount: 2,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 300,
        decisionCount: 3,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();
      const stats = summary.statistics;

      expect(stats.total_hook_calls).toBe(3);
      expect(stats.avg_latency_ms).toBe(200); // (100+200+300)/3
      expect(stats.p95_latency_ms).toBeGreaterThanOrEqual(200);
      expect(stats.performance_target_met_rate).toBe(100); // All under 500ms
    });

    it('should filter metrics by hook name', () => {
      metrics.logHookMetrics({
        hookName: 'UserPromptSubmit',
        latencyMs: 100,
        decisionCount: 1,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'PreToolUse',
        latencyMs: 200,
        decisionCount: 2,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      const filtered = metrics.getMetricsSummary({ hookName: 'UserPromptSubmit' });

      expect(filtered.total_entries).toBe(1);
      expect(filtered.entries[0].hook_name).toBe('UserPromptSubmit');
    });

    it('should filter metrics by tier', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        decisionCount: 1,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 200,
        decisionCount: 2,
        tier: 2,
        tierReason: 'Degraded',
        outcome: 'success',
      });

      const filtered = metrics.getMetricsSummary({ tier: 2 });

      expect(filtered.total_entries).toBe(1);
      expect(filtered.entries[0].tier).toBe(2);
    });

    it('should limit returned entries', () => {
      // Log 10 entries
      for (let i = 0; i < 10; i++) {
        metrics.logHookMetrics({
          hookName: 'Test',
          latencyMs: 100 + i * 10,
          decisionCount: i,
          tier: 1,
          tierReason: 'OK',
          outcome: 'success',
        });
      }

      const limited = metrics.getMetricsSummary({ limit: 5 });

      expect(limited.entries.length).toBe(5);
    });

    it('should format metrics for display', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 150,
        decisionCount: 5,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();
      const display = metrics.formatMetricsDisplay(summary);

      expect(display).toContain('MAMA Hook Metrics');
      expect(display).toContain('Total Hook Calls');
      expect(display).toContain('Average Latency');
      expect(display).toContain('P95 Latency');
      expect(display).toContain('Tier Distribution');
      expect(display).toContain('Outcome Distribution');
    });
  });

  describe('AC #3: Degraded Tier Alerts', () => {
    it('should flag degraded mode for Tier 2', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 150,
        decisionCount: 3,
        tier: 2,
        tierReason: 'Embeddings unavailable',
        outcome: 'success',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.degraded_mode).toBe(true);
      expect(entry.degraded_features).toBeDefined();
      expect(entry.degraded_features).toContain('vector_search_disabled');
    });

    it('should flag degraded mode for Tier 3', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 150,
        decisionCount: 0,
        tier: 3,
        tierReason: 'MAMA disabled',
        outcome: 'success',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.degraded_mode).toBe(true);
      expect(entry.degraded_features).toContain('mama_fully_disabled');
    });

    it('should not flag degraded mode for Tier 1', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 150,
        decisionCount: 5,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.degraded_mode).toBeUndefined();
      expect(entry.degraded_features).toBeUndefined();
    });

    it('should list degraded features correctly', () => {
      const tier2Features = metrics.getDegradedFeatures(2);
      expect(tier2Features).toContain('vector_search_disabled');
      expect(tier2Features).toContain('semantic_similarity_unavailable');

      const tier3Features = metrics.getDegradedFeatures(3);
      expect(tier3Features).toContain('vector_search_disabled');
      expect(tier3Features).toContain('graph_traversal_disabled');
      expect(tier3Features).toContain('keyword_search_disabled');
      expect(tier3Features).toContain('mama_fully_disabled');
    });

    it('should track degraded mode rate in statistics', () => {
      // 2 Tier 1, 1 Tier 2
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 2,
        tierReason: 'Degraded',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();

      // 1 out of 3 = 33%
      expect(summary.statistics.degraded_mode_rate).toBe(33);
    });
  });

  describe('AC #4: Privacy and Data Redaction', () => {
    it('should hash sensitive data', () => {
      const text = 'sensitive information';
      const hash = metrics.hashSensitiveData(text);

      expect(hash).toBeTruthy();
      expect(hash.length).toBe(16); // Truncated SHA-256
      expect(hash).not.toContain('sensitive');
    });

    it('should return null for empty input', () => {
      expect(metrics.hashSensitiveData('')).toBeNull();
      expect(metrics.hashSensitiveData(null)).toBeNull();
    });

    it('should redact sensitive fields from metadata', () => {
      const data = {
        decision: 'Some decision text',
        reasoning: 'Some reasoning',
        topic: 'Some topic',
        query: 'Some query',
        safe_field: 'OK to keep',
      };

      const redacted = metrics.redactSensitiveData(data);

      // Sensitive fields should be replaced with hashes
      expect(redacted.decision).toBeUndefined();
      expect(redacted.decision_hash).toBeTruthy();

      expect(redacted.reasoning).toBeUndefined();
      expect(redacted.reasoning_hash).toBeTruthy();

      expect(redacted.topic).toBeUndefined();
      expect(redacted.topic_hash).toBeTruthy();

      expect(redacted.query).toBeUndefined();
      expect(redacted.query_hash).toBeTruthy();

      // Safe fields should remain
      expect(redacted.safe_field).toBe('OK to keep');
    });

    it('should redact metadata in logged metrics', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 150,
        decisionCount: 3,
        tier: 1,
        tierReason: 'Full features',
        outcome: 'success',
        metadata: {
          decision: 'Sensitive decision',
          reasoning: 'Sensitive reasoning',
          topic: 'Sensitive topic',
        },
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.metadata).toBeDefined();
      expect(entry.metadata.decision).toBeUndefined();
      expect(entry.metadata.decision_hash).toBeTruthy();
      expect(content).not.toContain('Sensitive decision');
    });
  });

  describe('AC #5: Auto-Save Outcome Logging', () => {
    it('should log auto-save outcomes', () => {
      metrics.logAutoSaveOutcome('accept', {
        topic: 'Test topic',
        decision: 'Test decision',
      });

      expect(fs.existsSync(METRICS_FILE)).toBe(true);

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.event_type).toBe('auto_save_outcome');
      expect(entry.action).toBe('accept');
      expect(entry.metadata).toBeDefined();
    });

    it('should log different auto-save actions', () => {
      const actions = ['accept', 'modify', 'dismiss'];

      actions.forEach((action) => {
        metrics.logAutoSaveOutcome(action, {});
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(3);

      lines.forEach((line, index) => {
        const entry = JSON.parse(line);
        expect(entry.action).toBe(actions[index]);
      });
    });

    it('should redact auto-save outcome metadata', () => {
      metrics.logAutoSaveOutcome('accept', {
        topic: 'Sensitive topic',
        decision: 'Sensitive decision',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.metadata.topic).toBeUndefined();
      expect(entry.metadata.topic_hash).toBeTruthy();
      expect(content).not.toContain('Sensitive topic');
    });
  });

  describe('Integration and Regression', () => {
    it('should handle empty metrics file gracefully', () => {
      const summary = metrics.getMetricsSummary();

      expect(summary.total_entries).toBe(0);
      expect(summary.entries).toEqual([]);
      expect(summary.statistics).toBeDefined();
    });

    it('should handle missing log directory', () => {
      // Remove log directory
      if (fs.existsSync(METRICS_FILE)) {
        fs.unlinkSync(METRICS_FILE);
      }
      if (fs.existsSync(LOG_DIR)) {
        fs.rmdirSync(LOG_DIR, { recursive: true });
      }

      // Should create directory on first log
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        decisionCount: 1,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      expect(fs.existsSync(LOG_DIR)).toBe(true);
      expect(fs.existsSync(METRICS_FILE)).toBe(true);
    });

    it('should calculate tier distribution correctly', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 2,
        tierReason: 'Degraded',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();
      const dist = summary.statistics.tier_distribution;

      expect(dist.tier1).toBe(2);
      expect(dist.tier2).toBe(1);
      expect(dist.tier3).toBe(0);
    });

    it('should calculate outcome distribution correctly', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 600,
        tier: 1,
        tierReason: 'OK',
        outcome: 'timeout',
      });

      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      const summary = metrics.getMetricsSummary();
      const dist = summary.statistics.outcome_distribution;

      expect(dist.success).toBe(2);
      expect(dist.timeout).toBe(1);
    });

    it('should handle mixed hook and auto-save entries', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      metrics.logAutoSaveOutcome('accept', {});

      const summary = metrics.getMetricsSummary();

      expect(summary.total_entries).toBe(2);
      expect(summary.statistics.total_hook_calls).toBe(1); // Only counts hook entries
    });

    it('should clear metrics successfully', () => {
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 100,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      expect(fs.existsSync(METRICS_FILE)).toBe(true);

      metrics.clearMetrics();

      expect(fs.existsSync(METRICS_FILE)).toBe(false);
    });
  });

  describe('Performance Target Validation', () => {
    it('should flag performance warnings', () => {
      // Warning threshold: 400ms
      metrics.logHookMetrics({
        hookName: 'Test',
        latencyMs: 450,
        tier: 1,
        tierReason: 'OK',
        outcome: 'success',
      });

      const content = fs.readFileSync(METRICS_FILE, 'utf8');
      const entry = JSON.parse(content.trim());

      expect(entry.performance_warning).toBe(true);
      expect(entry.performance_target_met).toBe(true); // Still under 500ms
    });

    it('should calculate p95 and p99 latency', () => {
      // Log 100 entries with varying latencies
      for (let i = 1; i <= 100; i++) {
        metrics.logHookMetrics({
          hookName: 'Test',
          latencyMs: i * 5, // 5ms to 500ms
          tier: 1,
          tierReason: 'OK',
          outcome: 'success',
        });
      }

      const summary = metrics.getMetricsSummary();
      const stats = summary.statistics;

      expect(stats.p95_latency_ms).toBeGreaterThan(0);
      expect(stats.p99_latency_ms).toBeGreaterThan(stats.p95_latency_ms);
      expect(stats.p99_latency_ms).toBeLessThanOrEqual(500);
    });
  });
});
