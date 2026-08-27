/**
 * Tests for PersistentCLIAdapter IModelRunner implementation (STORY-012)
 *
 * Tests the IModelRunner contract methods: backendType, isHealthy, getMetrics, stop.
 * Does NOT test prompt() (covered by existing integration tests).
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import {
  PersistentClaudeProcess,
  PersistentProcessPool,
} from '../../src/agent/persistent-cli-process.js';
import type { IModelRunner, RunnerMetrics } from '../../src/agent/model-runner.js';

describe('PersistentCLIAdapter as IModelRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('reports a mismatch and stops the exact Claude route before replacement', async () => {
    vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
    const adapter = new PersistentCLIAdapter({ sessionId: 'legacy-route' });
    const pool = (
      adapter as unknown as {
        processPool: PersistentProcessPool;
      }
    ).processPool;
    const staleProcess = await pool.getProcess('member-route', {
      policyFingerprint: 'granted-policy',
    });
    await pool.getProcess('owner-route', { policyFingerprint: 'owner-policy' });
    const staleStop = vi.spyOn(staleProcess, 'stop').mockImplementation(() => {});

    expect(
      adapter.getSessionPolicyStatus({
        sessionId: 'member-route',
        sessionPolicyFingerprint: 'revoked-policy',
      })
    ).toBe('mismatch');
    adapter.resetSession('member-route');

    expect(staleStop).toHaveBeenCalledOnce();
    expect(adapter.getActiveProcessCount()).toBe(1);
    expect(
      adapter.getSessionPolicyStatus({
        sessionId: 'owner-route',
        sessionPolicyFingerprint: 'owner-policy',
      })
    ).toBe('compatible');
    adapter.stop();
  });
});
