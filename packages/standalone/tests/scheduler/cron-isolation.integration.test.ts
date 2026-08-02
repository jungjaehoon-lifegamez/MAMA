import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { CronWorker } from '../../src/scheduler/cron-worker.js';
import { CronResultRouter } from '../../src/scheduler/cron-result-router.js';
import type { IModelRunner } from '../../src/agent/model-runner.js';

function createRunner(response = 'cron result data'): IModelRunner {
  return {
    backendType: 'cline',
    prompt: vi.fn().mockResolvedValue({ response, usage: {}, session_id: 'cron-test' }),
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

describe('Cron Isolation Integration', () => {
  let emitter: EventEmitter;
  let worker: CronWorker;
  let discordSend: ReturnType<typeof vi.fn>;
  let slackSend: ReturnType<typeof vi.fn>;
  let viewerSend: ReturnType<typeof vi.fn>;
  let runner: IModelRunner;

  beforeEach(() => {
    emitter = new EventEmitter();
    runner = createRunner();
    worker = new CronWorker({ emitter, runnerFactory: () => runner });
    discordSend = vi.fn().mockResolvedValue(undefined);
    slackSend = vi.fn().mockResolvedValue(undefined);
    viewerSend = vi.fn().mockResolvedValue(undefined);

    // Retained for side effects: subscribes to emitter events
    const cronResultRouter = new CronResultRouter({
      emitter,
      gateways: {
        discord: { sendMessage: discordSend },
        slack: { sendMessage: slackSend },
        viewer: { sendMessage: viewerSend },
      },
    });
    expect(cronResultRouter).toBeDefined();
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('should execute cron job and deliver result to discord', async () => {
    const result = await worker.execute('generate report', {
      jobId: 'daily',
      jobName: 'Daily Report',
      channel: 'discord:123456',
    });

    expect(result).toBe('cron result data');
    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('Daily Report'));
    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('cron result data'));
    expect(slackSend).not.toHaveBeenCalled();
  });

  it('should route to slack when channel is slack', async () => {
    await worker.execute('check status', {
      jobId: 'hourly',
      jobName: 'Status Check',
      channel: 'slack:C99999',
    });

    expect(slackSend).toHaveBeenCalledWith('C99999', expect.stringContaining('Status Check'));
    expect(discordSend).not.toHaveBeenCalled();
  });

  it('should store result without sending when no channel', async () => {
    const result = await worker.execute('silent job', {
      jobId: 'bg',
      jobName: 'Background',
    });

    expect(result).toBe('cron result data');
    expect(discordSend).not.toHaveBeenCalled();
    expect(slackSend).not.toHaveBeenCalled();
  });

  it('should deliver error to gateway on failure', async () => {
    const failRunner = createRunner();
    vi.mocked(failRunner.prompt).mockRejectedValue(new Error('network timeout'));
    const failWorker = new CronWorker({ emitter, runnerFactory: () => failRunner });

    await expect(
      failWorker.execute('failing job', {
        jobId: 'broken',
        jobName: 'Broken Job',
        channel: 'discord:err_chan',
      })
    ).rejects.toThrow('network timeout');

    expect(discordSend).toHaveBeenCalledWith('err_chan', expect.stringContaining('Broken Job'));
    expect(discordSend).toHaveBeenCalledWith(
      'err_chan',
      expect.stringContaining('network timeout')
    );

    await failWorker.stop();
  });

  it('should route to viewer when channel is viewer', async () => {
    await worker.execute('check dashboard', {
      jobId: 'viewer-job',
      jobName: 'Dashboard Update',
      channel: 'viewer:session-abc',
    });

    expect(viewerSend).toHaveBeenCalledWith(
      'session-abc',
      expect.stringContaining('Dashboard Update')
    );
    expect(discordSend).not.toHaveBeenCalled();
    expect(slackSend).not.toHaveBeenCalled();
  });

  it('should handle multiple sequential cron jobs', async () => {
    await worker.execute('job1', {
      jobId: 'j1',
      jobName: 'First',
      channel: 'discord:ch1',
    });
    await worker.execute('job2', {
      jobId: 'j2',
      jobName: 'Second',
      channel: 'slack:ch2',
    });

    expect(discordSend).toHaveBeenCalledTimes(1);
    expect(slackSend).toHaveBeenCalledTimes(1);
    expect(discordSend).toHaveBeenCalledWith('ch1', expect.stringContaining('First'));
    expect(slackSend).toHaveBeenCalledWith('ch2', expect.stringContaining('Second'));
  });
});
