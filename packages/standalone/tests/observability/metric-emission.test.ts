/**
 * Tests for metric emission callback integration (STORY-020)
 */

import { describe, it, expect } from 'vitest';
import type { AgentLoopOptions } from '../../src/agent/types.js';

describe('Metric emission', () => {
  describe('AgentLoopOptions.onMetric', () => {
    it('should accept onMetric callback in options', () => {
      const metrics: { name: string; value: number; labels?: Record<string, string> }[] = [];
      const opts: Partial<AgentLoopOptions> = {
        onMetric: (name, value, labels) => {
          metrics.push({ name, value, labels });
        },
      };

      // Simulate calling the callback
      opts.onMetric!('prompt_latency_ms', 150, { backend: 'claude', turn: '1' });
      opts.onMetric!('tool_duration_ms', 50, { tool: 'Read', error: 'false' });
      opts.onMetric!('prompt_error', 1, { backend: 'codex-mcp', error_type: 'CLI_ERROR' });

      expect(metrics).toHaveLength(3);
      expect(metrics[0]).toEqual({
        name: 'prompt_latency_ms',
        value: 150,
        labels: { backend: 'claude', turn: '1' },
      });
      expect(metrics[1].name).toBe('tool_duration_ms');
      expect(metrics[2].labels?.error_type).toBe('CLI_ERROR');
    });

    it('should be optional', () => {
      const opts: Partial<AgentLoopOptions> = {};
      expect(opts.onMetric).toBeUndefined();
    });
  });

  describe('MetricsStore integration with onMetric', () => {
    it('should bridge callback to MetricsStore', async () => {
      const { MetricsStore } = await import('../../src/observability/metrics-store.js');
      const { join } = await import('path');
      const { mkdirSync, rmSync } = await import('fs');

      const tmpDir = join(__dirname, '..', '.tmp-metric-emit');
      mkdirSync(tmpDir, { recursive: true });
      const dbPath = join(tmpDir, `emit-${Date.now()}.db`);

      try {
        MetricsStore.resetInstances();
        const store = MetricsStore.getInstance(dbPath);

        // This is how start.ts would wire onMetric → MetricsStore
        const onMetric = (name: string, value: number, labels?: Record<string, string>) => {
          store.record({ name, value, labels });
        };

        // Simulate agent emitting metrics
        onMetric('prompt_latency_ms', 200, { backend: 'claude' });
        onMetric('prompt_latency_ms', 350, { backend: 'claude' });
        onMetric('tool_duration_ms', 50, { tool: 'Read' });

        // Verify stored
        expect(store.count('prompt_latency_ms')).toBe(2);
        expect(store.count('tool_duration_ms')).toBe(1);

        const agg = store.aggregate('prompt_latency_ms');
        expect(agg!.avg).toBe(275);
      } finally {
        MetricsStore.resetInstances();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
