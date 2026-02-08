import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnforcementMetrics } from '../../src/enforcement/metrics.js';
import type { AgentMetrics, MetricsSummary } from '../../src/enforcement/metrics.js';

describe('Story M3.6: EnforcementMetrics', () => {
  let metrics: EnforcementMetrics;

  beforeEach(() => {
    metrics = new EnforcementMetrics();
  });

  describe('AC #1: Disabled metrics are no-ops', () => {
    it('EM-001: should not record any data when disabled', () => {
      const disabled = new EnforcementMetrics({ enabled: false });

      disabled.recordPass('developer');
      disabled.recordRejection('developer', 'validator');
      disabled.recordRetry('developer');

      expect(disabled.getAgentMetrics('developer')).toBeUndefined();
    });

    it('EM-001b: getSummary returns empty global when disabled', () => {
      const disabled = new EnforcementMetrics({ enabled: false });

      disabled.recordPass('developer');

      const summary: MetricsSummary = disabled.getSummary();

      expect(summary.agents).toEqual({});
      expect(summary.global.totalResponses).toBe(0);
      expect(summary.global.passed).toBe(0);
    });
  });

  describe('AC #2: Records pass events correctly', () => {
    it('EM-002: should increment totalResponses and passed on recordPass', () => {
      metrics.recordPass('developer');
      metrics.recordPass('developer');
      metrics.recordPass('developer');

      const agent: AgentMetrics | undefined = metrics.getAgentMetrics('developer');

      expect(agent).toBeDefined();
      expect(agent!.totalResponses).toBe(3);
      expect(agent!.passed).toBe(3);
      expect(agent!.rejectedByValidator).toBe(0);
      expect(agent!.retries).toBe(0);
    });
  });

  describe('AC #3: Records validator rejections', () => {
    it('EM-003: should increment rejectedByValidator on validator rejection', () => {
      metrics.recordRejection('developer', 'validator');

      const agent = metrics.getAgentMetrics('developer');

      expect(agent).toBeDefined();
      expect(agent!.totalResponses).toBe(1);
      expect(agent!.passed).toBe(0);
      expect(agent!.rejectedByValidator).toBe(1);
    });
  });

  describe('AC #4: Records ReviewGate rejections', () => {
    it('EM-004: should increment rejectedByReviewGate on reviewGate rejection', () => {
      metrics.recordRejection('reviewer', 'reviewGate');
      metrics.recordRejection('reviewer', 'reviewGate');

      const agent = metrics.getAgentMetrics('reviewer');

      expect(agent).toBeDefined();
      expect(agent!.totalResponses).toBe(2);
      expect(agent!.rejectedByReviewGate).toBe(2);
    });
  });

  describe('AC #5: Records ScopeGuard rejections', () => {
    it('EM-005: should increment rejectedByScopeGuard on scopeGuard rejection', () => {
      metrics.recordRejection('developer', 'scopeGuard');

      const agent = metrics.getAgentMetrics('developer');

      expect(agent).toBeDefined();
      expect(agent!.rejectedByScopeGuard).toBe(1);
    });
  });

  describe('AC #6: Records TodoTracker flags', () => {
    it('EM-006: should increment flaggedByTodoTracker on todoTracker rejection', () => {
      metrics.recordRejection('developer', 'todoTracker');
      metrics.recordRejection('developer', 'todoTracker');
      metrics.recordRejection('developer', 'todoTracker');

      const agent = metrics.getAgentMetrics('developer');

      expect(agent).toBeDefined();
      expect(agent!.flaggedByTodoTracker).toBe(3);
      expect(agent!.totalResponses).toBe(3);
    });
  });

  describe('AC #7: Records retries', () => {
    it('EM-007: should increment retries without affecting totalResponses', () => {
      metrics.recordPass('developer');
      metrics.recordRetry('developer');
      metrics.recordRetry('developer');

      const agent = metrics.getAgentMetrics('developer');

      expect(agent).toBeDefined();
      expect(agent!.retries).toBe(2);
      expect(agent!.totalResponses).toBe(1);
    });
  });

  describe('AC #8: Tracks per-agent metrics independently', () => {
    it('EM-008: should keep separate counters per agent', () => {
      metrics.recordPass('developer');
      metrics.recordPass('developer');
      metrics.recordRejection('reviewer', 'validator');
      metrics.recordRetry('reviewer');

      const dev = metrics.getAgentMetrics('developer');
      const rev = metrics.getAgentMetrics('reviewer');

      expect(dev!.totalResponses).toBe(2);
      expect(dev!.passed).toBe(2);
      expect(dev!.rejectedByValidator).toBe(0);

      expect(rev!.totalResponses).toBe(1);
      expect(rev!.passed).toBe(0);
      expect(rev!.rejectedByValidator).toBe(1);
      expect(rev!.retries).toBe(1);
    });
  });

  describe('AC #9: getSummary aggregates global totals correctly', () => {
    it('EM-009: should aggregate all agent metrics into global totals', () => {
      metrics.recordPass('developer');
      metrics.recordPass('developer');
      metrics.recordRejection('developer', 'validator');
      metrics.recordRejection('reviewer', 'reviewGate');
      metrics.recordRejection('sisyphus', 'scopeGuard');
      metrics.recordRejection('sisyphus', 'todoTracker');
      metrics.recordRetry('developer');
      metrics.recordRetry('reviewer');

      const summary = metrics.getSummary();

      expect(summary.global.totalResponses).toBe(6);
      expect(summary.global.passed).toBe(2);
      expect(summary.global.rejectedByValidator).toBe(1);
      expect(summary.global.rejectedByReviewGate).toBe(1);
      expect(summary.global.rejectedByScopeGuard).toBe(1);
      expect(summary.global.flaggedByTodoTracker).toBe(1);
      expect(summary.global.retries).toBe(2);

      expect(Object.keys(summary.agents)).toHaveLength(3);
      expect(summary.agents['developer']).toBeDefined();
      expect(summary.agents['reviewer']).toBeDefined();
      expect(summary.agents['sisyphus']).toBeDefined();
    });
  });

  describe('AC #10: getPassRate calculates correctly', () => {
    it('EM-010a: should return correct pass rate for an agent', () => {
      metrics.recordPass('developer');
      metrics.recordPass('developer');
      metrics.recordRejection('developer', 'validator');
      metrics.recordRejection('developer', 'reviewGate');

      expect(metrics.getPassRate('developer')).toBe(0.5);
    });

    it('EM-010b: should return 0 for agent with zero totalResponses', () => {
      expect(metrics.getPassRate('unknown')).toBe(0);
    });

    it('EM-010c: should return global pass rate when no agentId provided', () => {
      metrics.recordPass('developer');
      metrics.recordPass('reviewer');
      metrics.recordRejection('developer', 'validator');

      expect(metrics.getPassRate()).toBeCloseTo(2 / 3);
    });

    it('EM-010d: should return 0 for global pass rate with no data', () => {
      expect(metrics.getPassRate()).toBe(0);
    });

    it('EM-010e: should return 1.0 when all responses pass', () => {
      metrics.recordPass('developer');
      metrics.recordPass('developer');

      expect(metrics.getPassRate('developer')).toBe(1.0);
    });
  });

  describe('AC #11: reset clears all data', () => {
    it('EM-011: should clear all agent metrics on reset', () => {
      metrics.recordPass('developer');
      metrics.recordRejection('reviewer', 'validator');
      metrics.recordRetry('sisyphus');

      metrics.reset();

      expect(metrics.getAgentMetrics('developer')).toBeUndefined();
      expect(metrics.getAgentMetrics('reviewer')).toBeUndefined();
      expect(metrics.getAgentMetrics('sisyphus')).toBeUndefined();

      const summary = metrics.getSummary();

      expect(summary.global.totalResponses).toBe(0);
      expect(Object.keys(summary.agents)).toHaveLength(0);
    });
  });

  describe('AC #12: firstSeen/lastSeen timestamps are accurate', () => {
    it('EM-012a: firstSeen should be set on first event', () => {
      const before = Date.now();
      metrics.recordPass('developer');
      const after = Date.now();

      const agent = metrics.getAgentMetrics('developer');

      expect(agent!.firstSeen).toBeGreaterThanOrEqual(before);
      expect(agent!.firstSeen).toBeLessThanOrEqual(after);
    });

    it('EM-012b: lastSeen should update on each event', () => {
      metrics.recordPass('developer');
      const firstAgent = metrics.getAgentMetrics('developer');
      const firstLastSeen = firstAgent!.lastSeen;

      metrics.recordPass('developer');
      const secondAgent = metrics.getAgentMetrics('developer');

      expect(secondAgent!.lastSeen).toBeGreaterThanOrEqual(firstLastSeen);
    });

    it('EM-012c: firstSeen should not change after initial set', () => {
      metrics.recordPass('developer');
      const firstSeen = metrics.getAgentMetrics('developer')!.firstSeen;

      metrics.recordPass('developer');
      metrics.recordRejection('developer', 'validator');
      metrics.recordRetry('developer');

      expect(metrics.getAgentMetrics('developer')!.firstSeen).toBe(firstSeen);
    });

    it('EM-012d: global firstSeen is the earliest across all agents', () => {
      vi.useFakeTimers();
      const baseTime = 1700000000000;

      vi.setSystemTime(baseTime);
      metrics.recordPass('reviewer');

      vi.setSystemTime(baseTime + 1000);
      metrics.recordPass('developer');

      const summary = metrics.getSummary();

      expect(summary.global.firstSeen).toBe(baseTime);
      expect(summary.global.lastSeen).toBe(baseTime + 1000);

      vi.useRealTimers();
    });
  });

  describe('AC #13: Multiple agents tracked simultaneously', () => {
    it('EM-013: should track 5+ agents simultaneously without interference', () => {
      const agents = ['sisyphus', 'developer', 'reviewer', 'explorer', 'pm'];

      agents.forEach((agentId, index) => {
        for (let i = 0; i <= index; i++) {
          metrics.recordPass(agentId);
        }
      });

      expect(metrics.getAgentMetrics('sisyphus')!.passed).toBe(1);
      expect(metrics.getAgentMetrics('developer')!.passed).toBe(2);
      expect(metrics.getAgentMetrics('reviewer')!.passed).toBe(3);
      expect(metrics.getAgentMetrics('explorer')!.passed).toBe(4);
      expect(metrics.getAgentMetrics('pm')!.passed).toBe(5);

      const summary = metrics.getSummary();

      expect(Object.keys(summary.agents)).toHaveLength(5);
      expect(summary.global.totalResponses).toBe(15);
      expect(summary.global.passed).toBe(15);
    });
  });

  describe('AC #14: Edge case: getAgentMetrics for unknown agent returns undefined', () => {
    it('EM-014: should return undefined for agent with no recorded events', () => {
      metrics.recordPass('developer');

      expect(metrics.getAgentMetrics('unknown-agent')).toBeUndefined();
      expect(metrics.getAgentMetrics('')).toBeUndefined();
    });
  });
});
