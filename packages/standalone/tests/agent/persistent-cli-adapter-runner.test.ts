/**
 * Tests for PersistentCLIAdapter IModelRunner implementation (STORY-012)
 *
 * Tests the IModelRunner contract methods: backendType, isHealthy, getMetrics, stop.
 * Does NOT test prompt() (covered by existing integration tests).
 */

import { describe, it, expect } from 'vitest';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import type { IModelRunner, RunnerMetrics } from '../../src/agent/model-runner.js';

describe('PersistentCLIAdapter as IModelRunner', () => {
  it('should implement IModelRunner interface', () => {
    const adapter = new PersistentCLIAdapter();
    // Structural check: IModelRunner requires these members
    const runner: IModelRunner = adapter;
    expect(runner.backendType).toBe('claude');
    expect(typeof runner.prompt).toBe('function');
    expect(typeof runner.setSessionId).toBe('function');
    expect(typeof runner.setSystemPrompt).toBe('function');
    expect(typeof runner.isHealthy).toBe('function');
    expect(typeof runner.getMetrics).toBe('function');
    expect(typeof runner.stop).toBe('function');
    // sendToolResult is optional on IModelRunner but present on PersistentCLIAdapter
    expect(typeof runner.sendToolResult).toBe('function');
    adapter.stop();
  });

  describe('backendType', () => {
    it('should be "claude"', () => {
      const adapter = new PersistentCLIAdapter();
      expect(adapter.backendType).toBe('claude');
      adapter.stop();
    });
  });

  describe('isHealthy()', () => {
    it('should return true when no process exists yet', () => {
      const adapter = new PersistentCLIAdapter();
      expect(adapter.isHealthy()).toBe(true);
      adapter.stop();
    });
  });

  describe('getMetrics()', () => {
    it('should return zero metrics initially', () => {
      const adapter = new PersistentCLIAdapter();
      const metrics: RunnerMetrics = adapter.getMetrics();
      expect(metrics.requestCount).toBe(0);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.avgLatencyMs).toBe(0);
      expect(metrics.lastRequestAt).toBeNull();
      adapter.stop();
    });
  });

  describe('stop()', () => {
    it('should clean up without error', () => {
      const adapter = new PersistentCLIAdapter({ sessionId: 'test-channel' });
      // stop should not throw even with no active processes
      expect(() => adapter.stop()).not.toThrow();
    });

    it('should be equivalent to stopAll()', () => {
      const adapter = new PersistentCLIAdapter();
      // After stop, getProcessState should indicate no process
      adapter.stop();
      expect(adapter.getProcessState()).toBe('no_process');
      expect(adapter.getActiveProcessCount()).toBe(0);
    });
  });
});
