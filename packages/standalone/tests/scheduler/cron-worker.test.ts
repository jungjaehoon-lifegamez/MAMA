import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/agent/persistent-cli-process.js', () => {
  return {
    PersistentClaudeProcess: vi.fn().mockImplementation(() => ({
      sendMessage: vi.fn().mockResolvedValue({
        response: 'mock result',
        usage: { input_tokens: 10, output_tokens: 20 },
        session_id: 'test-session',
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

import { CronWorker } from '../../src/scheduler/cron-worker.js';
import type { CronCompletedEvent, CronFailedEvent } from '../../src/scheduler/cron-worker.js';
import { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

describe('CronWorker', () => {
  let emitter: EventEmitter;
  let worker: CronWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    emitter = new EventEmitter();
    worker = new CronWorker({ emitter });
  });

  afterEach(async () => {
    await worker.stop();
  });

  describe('execute()', () => {
    it('should return result from PersistentClaudeProcess', async () => {
      const result = await worker.execute('test prompt');
      expect(result).toBe('mock result');
    });

    it('should pass prompt to sendMessage', async () => {
      await worker.execute('do something');

      const mockInstance = vi.mocked(PersistentClaudeProcess).mock.results[0].value;
      expect(mockInstance.sendMessage).toHaveBeenCalledWith('do something');
    });

    it('should create PersistentClaudeProcess with cron-specific config', async () => {
      await worker.execute('test');

      expect(PersistentClaudeProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringMatching(/^cron-worker-\d+$/),
          model: 'claude-haiku-4-5-20251001',
          dangerouslySkipPermissions: true,
          allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
        })
      );
    });

    it('should reuse CLI instance across executions', async () => {
      await worker.execute('first');
      await worker.execute('second');

      expect(PersistentClaudeProcess).toHaveBeenCalledTimes(1);
    });

    it('should use custom model when provided', async () => {
      const customWorker = new CronWorker({ emitter, model: 'claude-sonnet-4-20250514' });
      await customWorker.execute('test');

      expect(PersistentClaudeProcess).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-20250514' })
      );
      await customWorker.stop();
    });
  });

  describe('cron:completed event', () => {
    it('should emit cron:completed on success', async () => {
      const events: CronCompletedEvent[] = [];
      emitter.on('cron:completed', (e: CronCompletedEvent) => events.push(e));

      await worker.execute('test prompt', { jobId: 'j1', jobName: 'Job 1' });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        jobId: 'j1',
        jobName: 'Job 1',
        result: 'mock result',
      });
      expect(events[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should include channel in completed event', async () => {
      const events: CronCompletedEvent[] = [];
      emitter.on('cron:completed', (e: CronCompletedEvent) => events.push(e));

      await worker.execute('test', { jobId: 'j1', jobName: 'J1', channel: 'discord:123' });

      expect(events[0].channel).toBe('discord:123');
    });

    it('should default jobId and jobName to "unknown"', async () => {
      const events: CronCompletedEvent[] = [];
      emitter.on('cron:completed', (e: CronCompletedEvent) => events.push(e));

      await worker.execute('test');

      expect(events[0].jobId).toBe('unknown');
      expect(events[0].jobName).toBe('unknown');
    });
  });

  describe('cron:failed event', () => {
    it('should emit cron:failed on error', async () => {
      // First call to create the CLI
      await worker.execute('setup');

      // Now make sendMessage reject
      const cli = vi.mocked(PersistentClaudeProcess).mock.results[0].value;
      cli.sendMessage.mockRejectedValueOnce(new Error('CLI crashed'));

      const events: CronFailedEvent[] = [];
      emitter.on('cron:failed', (e: CronFailedEvent) => events.push(e));

      await expect(
        worker.execute('fail prompt', { jobId: 'j2', jobName: 'Job 2' })
      ).rejects.toThrow('CLI crashed');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        jobId: 'j2',
        jobName: 'Job 2',
        error: 'CLI crashed',
      });
      expect(events[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should include channel in failed event', async () => {
      await worker.execute('setup');

      const cli = vi.mocked(PersistentClaudeProcess).mock.results[0].value;
      cli.sendMessage.mockRejectedValueOnce(new Error('fail'));

      const events: CronFailedEvent[] = [];
      emitter.on('cron:failed', (e: CronFailedEvent) => events.push(e));

      await expect(
        worker.execute('test', { jobId: 'j1', jobName: 'J1', channel: 'slack:456' })
      ).rejects.toThrow();

      expect(events[0].channel).toBe('slack:456');
    });
  });

  describe('stop()', () => {
    it('should call cli.stop() and nullify reference', async () => {
      await worker.execute('test');

      const cli = vi.mocked(PersistentClaudeProcess).mock.results[0].value;

      await worker.stop();

      expect(cli.stop).toHaveBeenCalled();

      // After stop, next execute should create a new CLI
      await worker.execute('after stop');
      expect(PersistentClaudeProcess).toHaveBeenCalledTimes(2);
    });

    it('should be safe to call stop() when no CLI exists', async () => {
      await expect(worker.stop()).resolves.toBeUndefined();
    });

    it('should be safe to call stop() multiple times', async () => {
      await worker.execute('test');
      await worker.stop();
      await expect(worker.stop()).resolves.toBeUndefined();
    });
  });
});
