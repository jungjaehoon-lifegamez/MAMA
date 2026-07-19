/**
 * Story M0-2: workorder worker-run request timeout
 *
 * Live evidence (first shadow day): 8 of 31 operator workorder runs failed with
 * "CLI error: Request timeout" - long board/wiki gather runs overran the 300s
 * chat request bound. This story raises the per-request CLI timeout for OPERATOR
 * WORKER lane runs only (600s default, env-tunable), leaving chat untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORKER_TIMEOUT_SECONDS,
  WORKER_TIMEOUT_ENV,
  resolveWorkerRequestTimeoutMs,
  workerRun,
  type WorkerRunner,
} from '../../src/operator/worker-run.js';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import {
  PersistentClaudeProcess,
  PersistentProcessPool,
} from '../../src/agent/persistent-cli-process.js';

describe('Story M0-2: workorder worker-run request timeout', () => {
  describe('AC #1: env parsing fails loud, never silently falls back', () => {
    it('defaults to 600s when the override is unset', () => {
      expect(resolveWorkerRequestTimeoutMs({})).toBe(DEFAULT_WORKER_TIMEOUT_SECONDS * 1000);
      expect(DEFAULT_WORKER_TIMEOUT_SECONDS).toBe(600);
    });

    it('defaults to 600s for an empty or whitespace value', () => {
      expect(resolveWorkerRequestTimeoutMs({ [WORKER_TIMEOUT_ENV]: '' })).toBe(600_000);
      expect(resolveWorkerRequestTimeoutMs({ [WORKER_TIMEOUT_ENV]: '   ' })).toBe(600_000);
    });

    it('parses a positive integer number of seconds into ms', () => {
      expect(resolveWorkerRequestTimeoutMs({ [WORKER_TIMEOUT_ENV]: '900' })).toBe(900_000);
      expect(resolveWorkerRequestTimeoutMs({ [WORKER_TIMEOUT_ENV]: ' 120 ' })).toBe(120_000);
    });

    it('throws on malformed values (non-numeric, zero, negative, non-integer)', () => {
      for (const bad of ['abc', '0', '-5', '1.5', '10s', 'NaN', 'Infinity']) {
        expect(() => resolveWorkerRequestTimeoutMs({ [WORKER_TIMEOUT_ENV]: bad })).toThrow(
          new RegExp(WORKER_TIMEOUT_ENV)
        );
      }
    });
  });

  describe('AC #2: workerRun threads the raised timeout, identity still wins', () => {
    const ORIGINAL = process.env[WORKER_TIMEOUT_ENV];
    beforeEach(() => {
      // Isolate from any ambient developer override so the default is deterministic.
      delete process.env[WORKER_TIMEOUT_ENV];
    });
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env[WORKER_TIMEOUT_ENV];
      else process.env[WORKER_TIMEOUT_ENV] = ORIGINAL;
    });

    function capturingRunner(): WorkerRunner & { options: Record<string, unknown> } {
      const holder = { options: {} as Record<string, unknown> };
      return {
        options: holder.options,
        runWithContent: vi.fn(async (_content, options) => {
          Object.assign(holder.options, options as Record<string, unknown>);
          return { response: 'ok' };
        }),
      } as WorkerRunner & { options: Record<string, unknown> };
    }

    it('applies the 600s default to the run options', async () => {
      const runner = capturingRunner();
      await workerRun(runner, { kind: 'board', brief: 'b', input: 'i' });
      expect(runner.options.requestTimeoutMs).toBe(600_000);
    });

    it('lets an explicit runOptions.requestTimeoutMs override win over the default', async () => {
      const runner = capturingRunner();
      await workerRun(runner, {
        kind: 'wiki',
        brief: 'b',
        input: 'i',
        runOptions: { requestTimeoutMs: 123_000 },
      });
      expect(runner.options.requestTimeoutMs).toBe(123_000);
    });

    it('never lets runOptions override identity even while setting a timeout', async () => {
      const runner = capturingRunner();
      await workerRun(runner, {
        kind: 'board',
        brief: 'b',
        input: 'i',
        runOptions: {
          requestTimeoutMs: 700_000,
          sessionKey: 'chat:main:hijack',
          source: 'telegram',
        },
      });
      expect(runner.options.requestTimeoutMs).toBe(700_000);
      expect(runner.options.sessionKey).toBe('operator:worker:board');
      expect(runner.options.source).toBe('operator');
    });
  });

  describe('AC #3: the raised timeout reaches the CLI layer; chat is untouched', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('adapter forwards a per-call requestTimeout to the pool, else the construction default', async () => {
      const adapter = new PersistentCLIAdapter({ sessionId: 'ctor', requestTimeout: 300_000 });
      const calls: Array<{ key: string; options: Record<string, unknown> }> = [];
      const getProcess = vi.fn(async (key: string, options: Record<string, unknown>) => {
        calls.push({ key, options });
        return {
          isAlive: () => true,
          sendMessage: vi.fn().mockResolvedValue({
            response: 'ok',
            toolUseBlocks: [],
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        };
      });
      (adapter as unknown as { processPool: { getProcess: unknown } }).processPool = { getProcess };

      // Worker run: per-call override reaches the pool.
      await adapter.prompt('work', undefined, {
        sessionId: 'worker:board',
        requestTimeout: 600_000,
      });
      // Chat run: no override -> the pool keeps the construction-time default.
      await adapter.prompt('chat', undefined, { sessionId: 'chat:main' });

      expect(calls[0].options.requestTimeout).toBe(600_000);
      expect(calls[1].options.requestTimeout).toBe(300_000);
    });

    it('pool merges the per-call requestTimeout into the spawned process effective timeout', async () => {
      vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockResolvedValue(undefined);
      vi.spyOn(PersistentClaudeProcess.prototype, 'stop').mockImplementation(() => {});
      const pool = new PersistentProcessPool({
        requestTimeout: 300_000,
        idleTimeoutMs: 0,
        cleanupIntervalMs: 0,
        pendingToolUseTimeoutMs: 0,
      });

      const workerProc = await pool.getProcess('worker:board', { requestTimeout: 600_000 });
      const chatProc = await pool.getProcess('chat:main');

      const effective = (p: PersistentClaudeProcess): number =>
        (p as unknown as { _getRequestTimeoutMs(): number })._getRequestTimeoutMs();
      expect(effective(workerProc)).toBe(600_000);
      expect(effective(chatProc)).toBe(300_000);

      pool.stopAll();
    });
  });
});
