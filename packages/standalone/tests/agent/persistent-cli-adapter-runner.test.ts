/**
 * Tests for PersistentCLIAdapter IModelRunner implementation (STORY-012)
 *
 * Tests the IModelRunner contract plus TG-05 prompt-route policy replacement.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import type { IModelRunner, RunnerMetrics } from '../../src/agent/model-runner.js';
import { createFakeClaudeChild, type FakeClaudeChild } from '../helpers/fake-claude-child.js';

describe('Story TG-05 / Phase 2b Task 3 AC: PersistentCLIAdapter as IModelRunner', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createFakeClaudeChild());
  });

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
    const children: FakeClaudeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = createFakeClaudeChild();
      children.push(child);
      return child;
    });
    const adapter = new PersistentCLIAdapter({ sessionId: 'legacy-route' });
    await adapter.prompt('member request', undefined, {
      sessionId: 'member-route',
      sessionPolicyFingerprint: 'granted-policy',
    });
    await adapter.prompt('owner request', undefined, {
      sessionId: 'owner-route',
      sessionPolicyFingerprint: 'owner-policy',
    });

    expect(
      adapter.getSessionPolicyStatus({
        sessionId: 'member-route',
        sessionPolicyFingerprint: 'revoked-policy',
      })
    ).toBe('mismatch');
    adapter.resetSession('member-route');

    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1]?.kill).not.toHaveBeenCalled();
    expect(adapter.getActiveProcessCount()).toBe(1);
    expect(
      adapter.getSessionPolicyStatus({
        sessionId: 'owner-route',
        sessionPolicyFingerprint: 'owner-policy',
      })
    ).toBe('compatible');
    adapter.stop();
  });

  it('uses a sessionKey-only route for both the prompt and its policy status', async () => {
    const adapter = new PersistentCLIAdapter({ sessionId: 'default-route' });
    const policy = {
      sessionKey: 'member-route',
      sessionPolicyFingerprint: 'member-policy',
    };

    expect(adapter.getSessionPolicyStatus(policy)).toBe('missing');
    await adapter.prompt('hello', undefined, policy);

    expect(adapter.getSessionPolicyStatus(policy)).toBe('compatible');
    adapter.stop();
  });
});
