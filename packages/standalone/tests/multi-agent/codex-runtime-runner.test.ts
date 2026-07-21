/**
 * Tests for CodexRuntimeProcess IModelRunner implementation (STORY-013)
 *
 * Tests the IModelRunner contract methods: backendType, isHealthy, getMetrics, stop.
 * Does NOT test actual Codex app-server communication (requires live process).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerProcess } from '../../src/agent/codex-app-server-process.js';
import { CodexRuntimeProcess } from '../../src/multi-agent/runtime-process.js';
import type { IModelRunner, RunnerMetrics } from '../../src/agent/model-runner.js';

const successfulPromptResult = {
  response: 'done',
  usage: { input_tokens: 1, output_tokens: 2 },
  session_id: 'thread-1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CodexRuntimeProcess as IModelRunner', () => {
  it('should implement IModelRunner interface', () => {
    const process = new CodexRuntimeProcess({ model: 'gpt-5.3-codex' });
    const runner: IModelRunner = process;
    expect(runner.backendType).toBe('codex');
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
    it('should be "codex"', () => {
      const process = new CodexRuntimeProcess({});
      expect(process.backendType).toBe('codex');
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

  describe('prompt callbacks', () => {
    it.each(['prompt', 'sendMessage'] as const)(
      'reports a stopped-process %s rejection exactly once without recording a request',
      async (method) => {
        const process = new CodexRuntimeProcess({});
        await process.stop();
        const onError = vi.fn();
        const idle = vi.fn();
        process.on('idle', idle);

        let rejected: unknown;
        try {
          if (method === 'prompt') {
            await process.prompt('run', { onError });
          } else {
            await process.sendMessage('run', { onError });
          }
        } catch (error: unknown) {
          rejected = error;
        }

        expect(onError).toHaveBeenCalledTimes(1);
        expect(rejected).toBe(onError.mock.calls[0]?.[0]);
        expect(rejected).toMatchObject({ message: 'Process is dead' });
        expect(process.getMetrics()).toMatchObject({ requestCount: 0, failureCount: 0 });
        expect(idle).not.toHaveBeenCalled();
      }
    );

    it('reports a model Error exactly once before rejecting with the same Error', async () => {
      const modelError = new Error('native bridge aborted');
      vi.spyOn(CodexAppServerProcess.prototype, 'prompt').mockRejectedValue(modelError);
      const process = new CodexRuntimeProcess({});
      const onError = vi.fn();
      const idle = vi.fn();
      process.on('idle', idle);

      let rejected: unknown;
      try {
        await process.prompt('run', { onError });
      } catch (error: unknown) {
        rejected = error;
      }

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(modelError);
      expect(rejected).toBe(modelError);
      expect(process.getMetrics()).toMatchObject({ requestCount: 1, failureCount: 1 });
      expect(idle).toHaveBeenCalledTimes(1);
      await process.stop();
    });

    it('normalizes a non-Error rejection once for both onError and the caller', async () => {
      vi.spyOn(CodexAppServerProcess.prototype, 'prompt').mockRejectedValue('protocol failure');
      const process = new CodexRuntimeProcess({});
      const reported: Error[] = [];

      let rejected: unknown;
      try {
        await process.prompt('run', {
          onError: (error) => reported.push(error),
        });
      } catch (error: unknown) {
        rejected = error;
      }

      expect(reported).toHaveLength(1);
      expect(reported[0]).toBeInstanceOf(Error);
      expect(reported[0].message).toBe('protocol failure');
      expect(rejected).toBe(reported[0]);
      await process.stop();
    });

    it('does not let a throwing onError callback mask the original model Error', async () => {
      const modelError = new Error('model failed');
      vi.spyOn(CodexAppServerProcess.prototype, 'prompt').mockRejectedValue(modelError);
      const process = new CodexRuntimeProcess({});
      const callbackError = new Error('callback failed');
      const onError = vi.fn(() => {
        throw callbackError;
      });

      let rejected: unknown;
      try {
        await process.prompt('run', { onError });
      } catch (error: unknown) {
        rejected = error;
      }

      expect(onError).toHaveBeenCalledTimes(1);
      expect(rejected).toBe(modelError);
      expect(rejected).not.toBe(callbackError);
      expect(process.getMetrics().failureCount).toBe(1);
      await process.stop();
    });

    it('calls onFinal once and never calls onError for a successful prompt', async () => {
      vi.spyOn(CodexAppServerProcess.prototype, 'prompt').mockResolvedValue(successfulPromptResult);
      const process = new CodexRuntimeProcess({});
      const onError = vi.fn();
      const onFinal = vi.fn();
      const idle = vi.fn();
      process.on('idle', idle);

      await expect(process.prompt('run', { onError, onFinal })).resolves.toBe(
        successfulPromptResult
      );

      expect(onError).not.toHaveBeenCalled();
      expect(onFinal).toHaveBeenCalledTimes(1);
      expect(onFinal).toHaveBeenCalledWith({ content: 'done', toolUseBlocks: [] });
      expect(process.getMetrics()).toMatchObject({ requestCount: 1, failureCount: 0 });
      expect(idle).toHaveBeenCalledTimes(1);
      await process.stop();
    });
  });

  describe('stop()', () => {
    it('should emit close event after shutdown completes', async () => {
      const process = new CodexRuntimeProcess({});
      let closeFired = false;
      process.on('close', () => {
        closeFired = true;
      });
      await process.stop();
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
      // setSessionId selects the app-server session key; thread IDs stay internal.
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
