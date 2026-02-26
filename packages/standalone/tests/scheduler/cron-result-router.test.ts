import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { CronResultRouter, GatewaySender } from '../../src/scheduler/cron-result-router.js';

function makeMockGateway(): GatewaySender & { sendMessage: ReturnType<typeof vi.fn> } {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

describe('CronResultRouter', () => {
  let emitter: EventEmitter;
  let discord: ReturnType<typeof makeMockGateway>;
  let slack: ReturnType<typeof makeMockGateway>;

  beforeEach(() => {
    emitter = new EventEmitter();
    discord = makeMockGateway();
    slack = makeMockGateway();
  });

  it('routes cron:completed to discord gateway', async () => {
    new CronResultRouter({ emitter, gateways: { discord, slack } });

    emitter.emit('cron:completed', {
      jobId: 'j1',
      jobName: 'daily-report',
      result: 'Report generated',
      duration: 2500,
      channel: 'discord:123456',
    });

    await vi.waitFor(() => {
      expect(discord.sendMessage).toHaveBeenCalledOnce();
    });

    expect(discord.sendMessage).toHaveBeenCalledWith(
      '123456',
      expect.stringContaining('daily-report')
    );
    expect(discord.sendMessage).toHaveBeenCalledWith(
      '123456',
      expect.stringContaining('Report generated')
    );
    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('routes cron:completed to slack gateway', async () => {
    new CronResultRouter({ emitter, gateways: { discord, slack } });

    emitter.emit('cron:completed', {
      jobId: 'j2',
      jobName: 'sync-data',
      result: 'Synced 100 records',
      duration: 1000,
      channel: 'slack:C0001',
    });

    await vi.waitFor(() => {
      expect(slack.sendMessage).toHaveBeenCalledOnce();
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C0001', expect.stringContaining('sync-data'));
    expect(discord.sendMessage).not.toHaveBeenCalled();
  });

  it('does not crash when no channel is specified', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new CronResultRouter({ emitter, gateways: { discord } });

    emitter.emit('cron:completed', {
      jobId: 'j3',
      jobName: 'no-channel-job',
      result: 'done',
      duration: 500,
    });

    expect(discord.sendMessage).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no channel'));
    logSpy.mockRestore();
  });

  it('routes cron:failed events', async () => {
    new CronResultRouter({ emitter, gateways: { discord } });

    emitter.emit('cron:failed', {
      jobId: 'j4',
      jobName: 'broken-job',
      error: 'timeout exceeded',
      duration: 30000,
      channel: 'discord:err-chan',
    });

    await vi.waitFor(() => {
      expect(discord.sendMessage).toHaveBeenCalledOnce();
    });

    expect(discord.sendMessage).toHaveBeenCalledWith('err-chan', expect.stringContaining('failed'));
    expect(discord.sendMessage).toHaveBeenCalledWith(
      'err-chan',
      expect.stringContaining('timeout exceeded')
    );
  });

  it('logs error when cron:failed has no channel', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new CronResultRouter({ emitter, gateways: { discord } });

    emitter.emit('cron:failed', {
      jobId: 'j5',
      jobName: 'no-chan-fail',
      error: 'boom',
      duration: 100,
    });

    expect(discord.sendMessage).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no-chan-fail'));
    errSpy.mockRestore();
  });

  it('does not crash with unknown gateway name', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new CronResultRouter({ emitter, gateways: { discord } });

    emitter.emit('cron:completed', {
      jobId: 'j6',
      jobName: 'unknown-gw-job',
      result: 'ok',
      duration: 200,
      channel: 'telegram:12345',
    });

    expect(discord.sendMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('telegram'));
    warnSpy.mockRestore();
  });

  it('handles channel string with multiple colons correctly', async () => {
    new CronResultRouter({ emitter, gateways: { discord } });

    emitter.emit('cron:completed', {
      jobId: 'j7',
      jobName: 'colon-test',
      result: 'ok',
      duration: 100,
      channel: 'discord:some:complex:id',
    });

    await vi.waitFor(() => {
      expect(discord.sendMessage).toHaveBeenCalledOnce();
    });

    expect(discord.sendMessage).toHaveBeenCalledWith('some:complex:id', expect.any(String));
  });

  it('formats duration correctly in seconds', async () => {
    new CronResultRouter({ emitter, gateways: { slack } });

    emitter.emit('cron:completed', {
      jobId: 'j8',
      jobName: 'timing-job',
      result: 'done',
      duration: 12345,
      channel: 'slack:C999',
    });

    await vi.waitFor(() => {
      expect(slack.sendMessage).toHaveBeenCalledOnce();
    });

    const msg = slack.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('12.3s');
  });
});
