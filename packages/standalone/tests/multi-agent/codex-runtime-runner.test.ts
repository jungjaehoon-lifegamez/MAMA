/**
 * Tests for CodexRuntimeProcess IModelRunner implementation (STORY-013)
 *
 * Tests the IModelRunner contract methods: backendType, isHealthy, getMetrics, stop.
 * Does NOT test actual Codex MCP communication (requires live process).
 */

import { describe, it, expect } from 'vitest';
import { CodexRuntimeProcess } from '../../src/multi-agent/runtime-process.js';
import type { IModelRunner, RunnerMetrics } from '../../src/agent/model-runner.js';

describe('CodexRuntimeProcess as IModelRunner', () => {
  it('should implement IModelRunner interface', () => {
    const process = new CodexRuntimeProcess({ model: 'gpt-5.3-codex' });
    const runner: IModelRunner = process;
    expect(runner.backendType).toBe('codex-mcp');
    expect(typeof runner.prompt).toBe('function');
    expect(typeof runner.setSessionId).toBe('function');
    expect(typeof runner.setSystemPrompt).toBe('function');
    expect(typeof runner.isHealthy).toBe('function');
    expect(typeof runner.getMetrics).toBe('function');
    expect(typeof runner.stop).toBe('function');
    // sendToolResult is optional — Codex doesn't implement it
    expect(runner.sendToolResult).toBeUndefined();
    process.stop();
  });

  describe('backendType', () => {
    it('should be "codex-mcp"', () => {
      const process = new CodexRuntimeProcess({});
      expect(process.backendType).toBe('codex-mcp');
      process.stop();
    });
  });

  describe('isHealthy()', () => {
    it('should return true when idle', () => {
      const process = new CodexRuntimeProcess({});
      expect(process.isHealthy()).toBe(true);
      expect(process.isReady()).toBe(true);
      process.stop();
    });

    it('should return false after stop', () => {
      const process = new CodexRuntimeProcess({});
      process.stop();
      expect(process.isHealthy()).toBe(false);
      expect(process.isReady()).toBe(false);
    });
  });

  describe('getMetrics()', () => {
    it('should return zero metrics initially', () => {
      const process = new CodexRuntimeProcess({});
      const metrics: RunnerMetrics = process.getMetrics();
      expect(metrics.requestCount).toBe(0);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.avgLatencyMs).toBe(0);
      expect(metrics.lastRequestAt).toBeNull();
      process.stop();
    });
  });

  describe('stop()', () => {
    it('should emit close event', () => {
      const process = new CodexRuntimeProcess({});
      let closeFired = false;
      process.on('close', () => {
        closeFired = true;
      });
      process.stop();
      expect(closeFired).toBe(true);
    });

    it('should set state to dead', () => {
      const process = new CodexRuntimeProcess({});
      process.stop();
      expect(process.isHealthy()).toBe(false);
    });
  });

  describe('session management', () => {
    it('should delegate setSessionId to wrapper', () => {
      const process = new CodexRuntimeProcess({});
      // setSessionId on Codex is a no-op (MCP manages threadId internally)
      expect(() => process.setSessionId('test-id')).not.toThrow();
      process.stop();
    });

    it('should delegate setSystemPrompt to wrapper', () => {
      const process = new CodexRuntimeProcess({});
      expect(() => process.setSystemPrompt('new prompt')).not.toThrow();
      process.stop();
    });

    it('should return empty session id initially', () => {
      const process = new CodexRuntimeProcess({});
      expect(process.getSessionId()).toBe('');
      process.stop();
    });
  });
});
