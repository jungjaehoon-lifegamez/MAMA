import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IModelRunner } from '../../src/agent/model-runner.js';
import { CronWorker } from '../../src/scheduler/cron-worker.js';
import type { CronCompletedEvent, CronFailedEvent } from '../../src/scheduler/cron-worker.js';

function createRunner(response = 'mock result'): IModelRunner {
  return {
    backendType: 'cline',
    prompt: vi.fn().mockResolvedValue({
      response,
      usage: { input_tokens: 10, output_tokens: 20 },
      session_id: 'test-session',
    }),
    setSessionId: vi.fn(),
    setSystemPrompt: vi.fn(),
    isHealthy: vi.fn(() => true),
    getMetrics: vi.fn(() => ({
      requestCount: 0,
      failureCount: 0,
      avgLatencyMs: 0,
      lastRequestAt: null,
    })),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('TG-06: CronWorker backend isolation', () => {
  let emitter: EventEmitter;
  let runner: IModelRunner;
  let runnerFactory: ReturnType<typeof vi.fn>;
  let worker: CronWorker;

  beforeEach(() => {
    emitter = new EventEmitter();
    runner = createRunner();
    runnerFactory = vi.fn(() => runner);
    worker = new CronWorker({ emitter, runnerFactory });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('executes through the injected configured-backend runner', async () => {
    await expect(worker.execute('do something')).resolves.toBe('mock result');
    expect(runner.prompt).toHaveBeenCalledWith(
      'do something',
      undefined,
      expect.objectContaining({
        sessionKey: 'system:cron',
      })
    );
  });

  it('passes a backend-correct Cline tool catalog in the per-turn system prompt', async () => {
    worker = new CronWorker({
      emitter,
      runnerFactory,
      systemPrompt:
        'Available tools: run_commands, read_files, apply_patch/editor, search_codebase.',
    });
    await worker.execute('inspect');
    expect(runner.prompt).toHaveBeenCalledWith(
      'inspect',
      undefined,
      expect.objectContaining({ systemPrompt: expect.stringContaining('run_commands') })
    );
  });

  it('reuses one runner across executions', async () => {
    await worker.execute('first');
    await worker.execute('second');
    expect(runnerFactory).toHaveBeenCalledTimes(1);
  });

  it('emits cron:completed with routing context', async () => {
    const events: CronCompletedEvent[] = [];
    emitter.on('cron:completed', (event: CronCompletedEvent) => events.push(event));
    await worker.execute('test', { jobId: 'j1', jobName: 'Job 1', channel: 'discord:123' });
    expect(events[0]).toMatchObject({
      jobId: 'j1',
      jobName: 'Job 1',
      result: 'mock result',
      channel: 'discord:123',
    });
  });

  it('emits cron:failed when the configured backend rejects', async () => {
    vi.mocked(runner.prompt).mockRejectedValueOnce(new Error('backend crashed'));
    const events: CronFailedEvent[] = [];
    emitter.on('cron:failed', (event: CronFailedEvent) => events.push(event));
    await expect(worker.execute('fail', { jobId: 'j2', jobName: 'Job 2' })).rejects.toThrow(
      'backend crashed'
    );
    expect(events[0]).toMatchObject({ jobId: 'j2', jobName: 'Job 2', error: 'backend crashed' });
  });

  it('stops the runner and rejects later execution', async () => {
    await worker.execute('first');
    await worker.stop();
    expect(runner.stop).toHaveBeenCalledTimes(1);
    await expect(worker.execute('second')).rejects.toThrow('stopping');
    expect(runnerFactory).toHaveBeenCalledTimes(1);
  });

  it('is safe to stop before execution', async () => {
    const idle = new CronWorker({ emitter, runnerFactory });
    await expect(idle.stop()).resolves.toBeUndefined();
  });

  it('does not start a new runner for work queued when shutdown begins', async () => {
    let releaseFirst!: () => void;
    vi.mocked(runner.prompt).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ response: 'first done', usage: {}, session_id: 'first-session' });
        })
    );
    const first = worker.execute('first');
    await vi.waitFor(() => expect(runner.prompt).toHaveBeenCalledOnce());
    const second = worker.execute('second');
    const stopping = worker.stop();
    releaseFirst();

    await expect(first).resolves.toBe('first done');
    await expect(second).rejects.toThrow('stopping');
    await stopping;
    expect(runnerFactory).toHaveBeenCalledOnce();
  });
});
