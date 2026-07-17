/**
 * Story OPS-0: workerRun primitive (plan v6 S0-T1)
 *
 * Worker = briefed FRESH-session lane run. No delegate machinery, no native
 * subagents; host-code callers only (nesting ban is a documented convention,
 * enforced by the caller contract in worker-run.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkerSessionKey,
  workerRun,
  type WorkerRunner,
} from '../../src/operator/worker-run.js';

function makeRunner(response = 'worker output'): WorkerRunner & {
  calls: Array<{ content: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ content: string; options: Record<string, unknown> }> = [];
  return {
    calls,
    runWithContent: vi.fn(async (content, options) => {
      calls.push({
        content: content.map((block) => ('text' in block ? block.text : '')).join('\n'),
        options: options as unknown as Record<string, unknown>,
      });
      return { response };
    }),
  };
}

describe('Story OPS-0: workerRun primitive', () => {
  describe('AC #1: briefed run with explicit lane identity', () => {
    it('composes brief + work order and pins sessionKey/source/channelId/freshSession', async () => {
      const runner = makeRunner('board updated');
      const result = await workerRun(runner, {
        kind: 'board',
        brief: 'You update the owner board slots.',
        input: 'Refresh the pipeline slot.',
      });

      expect(result).toBe('board updated');
      expect(runner.calls).toHaveLength(1);
      const { content, options } = runner.calls[0];
      expect(content).toContain('You update the owner board slots.');
      expect(content).toContain('Work order:\nRefresh the pipeline slot.');
      expect(options.sessionKey).toBe('operator:worker:board');
      expect(options.source).toBe('operator');
      expect(options.channelId).toBe('worker:board');
      expect(options.freshSession).toBe(true);
    });

    it('maps kinds onto the operator global-lane prefix', () => {
      expect(buildWorkerSessionKey('wiki')).toBe('operator:worker:wiki');
      expect(buildWorkerSessionKey('memory-curation')).toBe('operator:worker:memory-curation');
    });
  });

  describe('AC #3: failures propagate loudly, never silently', () => {
    it('rejects invalid kind, empty brief, and empty input', async () => {
      const runner = makeRunner();
      await expect(workerRun(runner, { kind: 'Board!', brief: 'b', input: 'i' })).rejects.toThrow(
        /invalid worker kind/
      );
      await expect(workerRun(runner, { kind: 'board', brief: '  ', input: 'i' })).rejects.toThrow(
        /empty brief/
      );
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: ' ' })).rejects.toThrow(
        /empty input/
      );
      expect(runner.calls).toHaveLength(0);
    });

    it('propagates runner failure to the caller', async () => {
      const runner: WorkerRunner = {
        runWithContent: vi.fn().mockRejectedValue(new Error('lane exploded')),
      };
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: 'i' })).rejects.toThrow(
        'lane exploded'
      );
    });

    it('treats an empty response as a loud failure', async () => {
      const runner = makeRunner('   ');
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: 'i' })).rejects.toThrow(
        /empty response/
      );
    });
  });
});
