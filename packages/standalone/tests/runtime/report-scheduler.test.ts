import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReportScheduler } from '../../src/runtime/report-scheduler.js';
import { scheduledReportOrder } from '../../src/runtime/turn-orders.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import type { ScheduledInput } from '../../src/runtime/stimulus-delivery.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reports-'));
  vi.stubEnv('HOME', root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const queued: ScheduledInput[] = [];
  const sent: string[] = [];
  const statePath = join(root, 'runtime', 'report-schedule-state.json');
  let pending = false;
  let send = async (text: string) => {
    sent.push(text);
  };
  const options = {
    config: {
      full_report_hours: [8, 13, 18],
      reminder_start_hour: 9,
      reminder_end_hour: 21,
      daily_hour: 23,
    },
    timeZone: createTimeZoneSetting('Asia/Seoul'),
    statePath,
    intake: {
      acceptScheduled: (input: ScheduledInput) => {
        queued.push(input);
        pending = true;
        return { state: 'accepted' as const, inputId: input.id };
      },
    },
    hasPendingReport: () => pending,
    sendToOwner: (text: string, _key: string) => send(text),
    onError: (error: unknown) => {
      throw error;
    },
  };
  return {
    options,
    scheduler: createReportScheduler(options),
    queued,
    sent,
    statePath,
    setPending: (value: boolean) => {
      pending = value;
    },
    setSend: (value: typeof send) => {
      send = value;
    },
    result: () => ({
      stimulusId: queued.at(-1)!.id,
      payload: queued.at(-1)!.payload,
      occurredAt: queued.at(-1)!.occurredAt,
    }),
  };
}

// The daily page counts as written only when the wiki file changed after the order was queued.
const written = { written: () => true };

describe('KST report scheduler', () => {
  it('uses the configured local hour and observes a timezone change without restart', () => {
    const ctx = setup();
    ctx.options.config.full_report_hours = [9, 18];
    ctx.options.timeZone.set('America/Los_Angeles');
    const now = new Date('2026-09-27T16:00:00Z');
    ctx.scheduler.tick(now);
    expect(ctx.queued).toHaveLength(1);
    ctx.setPending(false);
    ctx.options.timeZone.set('Europe/Paris');
    ctx.scheduler.tick(now);
    expect(ctx.queued).toHaveLength(2);
  });

  it('gives the full report order its data and leaves the steps to the standing prompt', () => {
    const order = scheduledReportOrder(
      { report: 'full', hourKey: '2026-01-01:08' },
      new Date('2026-01-01T00:00:00Z'),
      { backend: 'codex', messenger: 'telegram', timeZone: 'UTC' }
    );
    expect(order).not.toContain('Slot HTML must use ONLY this class vocabulary');
    expect(order).not.toContain('manage.wiki.update');
    expect(order).not.toContain('daily/YYYY-MM-DD.md');
    expect(order).toContain("help({topic: 'full-report'})");
  });

  it('uses one delivery identity across model attempts after the schedule write fails', async () => {
    const ctx = setup();
    const keys: string[] = [];
    const scheduler = createReportScheduler({
      ...ctx.options,
      sendToOwner: async (_text, key) => {
        keys.push(key);
      },
    });
    const now = new Date('2026-01-01T04:00:00Z');
    scheduler.tick(now);
    mkdirSync(join(root, 'runtime'), { recursive: true });
    mkdirSync(`${ctx.statePath}.tmp`);
    await expect(scheduler.onResult(ctx.result(), { response: 'first' })).rejects.toThrow();
    rmSync(`${ctx.statePath}.tmp`, { recursive: true });
    ctx.setPending(false);
    scheduler.tick(now);
    await scheduler.onResult(ctx.result(), { response: 'second' });
    expect(ctx.queued[0]!.id).not.toBe(ctx.queued[1]!.id);
    expect(keys).toEqual(['report:2026-01-01:13:full', 'report:2026-01-01:13:full']);
    await scheduler.onResult(
      { stimulusId: 'reminder-attempt', payload: { report: 'reminder', hourKey: '2026-01-01:13' } },
      { response: 'reminder' }
    );
    expect(keys.at(-1)).toBe('report:2026-01-01:13:reminder');
  });

  it('carries the last successful full-report time into the next full report', () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(
      ctx.statePath,
      JSON.stringify({ lastFullKey: '2026-01-01:08', lastReminderKey: null })
    );
    const scheduler = createReportScheduler(ctx.options);
    scheduler.tick(new Date('2026-01-01T04:00:00Z'));
    expect(ctx.queued[0]?.payload).toMatchObject({ previousFullReportAt: '2026-01-01:08' });
    expect(
      scheduledReportOrder(ctx.queued[0]?.payload, new Date('2026-01-01T04:00:00Z'), {
        backend: 'codex',
        messenger: 'telegram',
        timeZone: 'Asia/Seoul',
      })
    ).toContain('Changes since: ');
    expect(
      scheduledReportOrder(ctx.queued[0]?.payload, new Date('2026-01-01T04:00:00Z'), {
        backend: 'codex',
        messenger: 'telegram',
        timeZone: 'Asia/Seoul',
      })
    ).toContain('Changes since: 2025-12-31T23:00:00.000Z (the previous full report)');
  });

  it('does not send a reminder that ends with [ack], and still marks its hour', async () => {
    const ctx = setup();
    const now = new Date('2026-01-01T01:00:00Z');
    ctx.scheduler.tick(now);
    expect(ctx.queued[0]?.payload).toMatchObject({ report: 'reminder' });
    expect(ctx.queued[0]?.payload).not.toHaveProperty('acknowledgedDeltas');
    await ctx.scheduler.onResult(ctx.result(), { response: 'nothing urgent\n[ack]' });
    expect(ctx.sent).toEqual([]);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8'))).toMatchObject({
      lastReminderKey: '2026-01-01:10',
    });
  });

  it('labels report time and recent boundary in the configured zone', () => {
    const prompt = scheduledReportOrder(
      { report: 'full', hourKey: '2026-01-01:08', previousFullReportAt: '2026-01-01:08' },
      new Date('2026-01-01T16:00:00Z'),
      { backend: 'codex', messenger: 'telegram', timeZone: 'America/Los_Angeles' }
    );
    expect(prompt).toContain('(America/Los_Angeles)');
    expect(prompt).toContain('Changes since: 2026-01-01T16:00:00.000Z (the previous full report)');
  });

  it('sends no reminder in an hour whose full report already went out after the hour stops being a full-report hour', () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(
      ctx.statePath,
      JSON.stringify({ lastFullKey: '2026-01-02:20', lastReminderKey: '2026-01-02:19' })
    );
    createReportScheduler(ctx.options).tick(new Date('2026-01-02T11:58:00Z')); // 20:58 KST
    expect(ctx.queued).toHaveLength(0);
  });

  it('writes the full hour only after sending finishes and suppresses it after restart', async () => {
    const ctx = setup();
    const now = new Date('2026-01-01T23:05:00Z'); // next date, 08 KST
    ctx.scheduler.tick(now);
    expect(ctx.queued[0]!.payload).toEqual({
      report: 'full',
      hourKey: '2026-01-02:08',
      previousFullReportAt: null,
    });
    expect(existsSync(ctx.statePath)).toBe(false);
    let release!: () => void;
    ctx.setSend(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const result = ctx.scheduler.onResult(ctx.result(), { response: ' Full report ' });
    expect(existsSync(ctx.statePath)).toBe(false);
    ctx.scheduler.tick(now);
    expect(ctx.queued).toHaveLength(1);
    release();
    await result;
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8'))).toEqual({
      lastFullKey: '2026-01-02:08',
      lastReminderKey: null,
    });
    ctx.setPending(false);
    createReportScheduler(ctx.options).tick(now);
    expect(ctx.queued).toHaveLength(1);
  });

  it('leaves a failed send unwritten and asks the model again on the next tick', async () => {
    const ctx = setup();
    const now = new Date('2026-01-01T04:00:00Z');
    ctx.scheduler.tick(now);
    ctx.setSend(async () => {
      throw new Error('send failed');
    });
    await expect(ctx.scheduler.onResult(ctx.result(), { response: 'report' })).rejects.toThrow(
      'send failed'
    );
    expect(existsSync(ctx.statePath)).toBe(false);
    // The runtime parks the accepted failure uncertain, so it is no longer pending.
    ctx.setPending(false);
    ctx.scheduler.tick(new Date(now.getTime() + 60_000));
    expect(ctx.queued).toHaveLength(2);
    expect(ctx.queued[0]!.id).not.toBe(ctx.queued[1]!.id);
    ctx.setSend(async (text) => {
      ctx.sent.push(text);
    });
    await ctx.scheduler.onResult(ctx.result(), { response: 'new report' });
    expect(ctx.sent).toEqual(['new report']);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
  });

  it.each([
    ['2026-01-01T00:00:00Z', 'reminder', '2026-01-01:09'],
    ['2026-01-01T04:00:00Z', 'full', '2026-01-01:13'],
    ['2026-01-01T09:00:00Z', 'full', '2026-01-01:18'],
    ['2026-01-01T12:00:00Z', 'reminder', '2026-01-01:21'],
  ])('uses KST and excludes reminder at full hours: %s', async (iso, report, hourKey) => {
    const ctx = setup();
    ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued[0]!.payload).toEqual({
      report,
      hourKey,
      ...(report === 'full' ? { previousFullReportAt: null } : {}),
    });
    await ctx.scheduler.onResult(ctx.result(), { response: 'report' });
    ctx.setPending(false);
    ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued).toHaveLength(1);
  });

  it('does not schedule outside the hours or overlap a queued report across hours/restart', () => {
    const ctx = setup();
    for (const iso of ['2026-01-01T13:00:00Z', '2026-01-01T22:00:00Z'])
      ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued).toHaveLength(0);
    ctx.scheduler.tick(new Date('2026-01-01T23:00:00Z'));
    const restarted = createReportScheduler(ctx.options);
    restarted.tick(new Date('2026-01-02T00:00:00Z'));
    expect(ctx.queued).toHaveLength(1);
  });

  it('ticks every 60 seconds and stops producing on shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T04:00:00Z'));
    const ctx = setup();
    ctx.scheduler.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ctx.queued).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.queued).toHaveLength(1);
    ctx.scheduler.stop();
    ctx.setPending(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.queued).toHaveLength(1);
  });

  it('does not send or mark empty model output', async () => {
    const ctx = setup();
    ctx.scheduler.tick(new Date('2026-01-01T04:00:00Z'));
    await expect(ctx.scheduler.onResult(ctx.result(), { response: '  ' })).rejects.toThrow(
      /empty/i
    );
    expect(ctx.sent).toEqual([]);
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('writes the daily page at its hour, never sends it, and keeps the latest day', async () => {
    const ctx = setup();
    const scheduler = createReportScheduler({ ...ctx.options, dailyPages: written });
    scheduler.tick(new Date('2026-09-29T14:00:00Z'));
    expect(ctx.queued.at(-1)!.payload).toEqual({
      report: 'daily',
      hourKey: '2026-09-29:23',
      day: '2026-09-29',
    });
    await scheduler.onResult(ctx.result(), { response: '[ack]' });
    expect(ctx.sent).toEqual([]);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastDailyKey).toBe('2026-09-29');
    ctx.setPending(false);
    scheduler.tick(new Date('2026-09-29T14:30:00Z'));
    expect(ctx.queued).toHaveLength(1);
    // A page rewritten for an earlier day leaves the latest day in place.
    await scheduler.onResult(
      {
        stimulusId: 'report:rewrite',
        payload: { report: 'daily', hourKey: '2026-09-29:23', day: '2026-09-01' },
        occurredAt: 0,
      },
      { response: '[ack]' }
    );
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastDailyKey).toBe('2026-09-29');
  });

  it('writes no daily page without the wiki, and lets a report due in the same hour go first', async () => {
    const off = setup();
    off.scheduler.tick(new Date('2026-09-29T14:00:00Z'));
    expect(off.queued).toEqual([]);
    const ctx = setup();
    const scheduler = createReportScheduler({
      ...ctx.options,
      config: { ...ctx.options.config, daily_hour: 21 },
      dailyPages: written,
    });
    scheduler.tick(new Date('2026-09-29T12:00:00Z'));
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'reminder' });
    await scheduler.onResult(ctx.result(), { response: '[ack]' });
    ctx.setPending(false);
    scheduler.tick(new Date('2026-09-29T12:01:00Z'));
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'daily', day: '2026-09-29' });
  });

  it('fails a daily order that ended without its page, leaving the day to write again', async () => {
    const ctx = setup();
    const checked: Array<[string, number]> = [];
    const scheduler = createReportScheduler({
      ...ctx.options,
      dailyPages: {
        written: (day, since) => {
          checked.push([day, since]);
          return false;
        },
      },
    });
    const now = new Date('2026-09-29T14:00:00Z');
    scheduler.tick(now);
    await expect(scheduler.onResult(ctx.result(), { response: '[ack]' })).rejects.toThrow(
      'The daily order ended without writing daily/2026-09-29.md'
    );
    expect(checked).toEqual([['2026-09-29', now.getTime()]]);
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('writes a day missed while the daemon was down after midnight, but nothing before a first page', async () => {
    const first = setup();
    const fresh = createReportScheduler({ ...first.options, dailyPages: written });
    fresh.tick(new Date('2026-09-28T22:00:00Z'));
    expect(first.queued).toEqual([]);
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(
      ctx.statePath,
      JSON.stringify({ lastFullKey: null, lastReminderKey: null, lastDailyKey: '2026-09-27' })
    );
    const scheduler = createReportScheduler({ ...ctx.options, dailyPages: written });
    // 02:00 on the 30th in Seoul: the 29th was missed.
    scheduler.tick(new Date('2026-09-29T17:00:00Z'));
    expect(ctx.queued.at(-1)!.payload).toEqual({
      report: 'daily',
      hourKey: '2026-09-30:02',
      day: '2026-09-29',
    });
    await scheduler.onResult(ctx.result(), { response: '[ack]' });
    ctx.setPending(false);
    scheduler.tick(new Date('2026-09-29T17:30:00Z'));
    expect(ctx.queued).toHaveLength(1);
  });

  it('writes the day that just ended when the daily hour is midnight', () => {
    const ctx = setup();
    const scheduler = createReportScheduler({
      ...ctx.options,
      config: { ...ctx.options.config, daily_hour: 0 },
      dailyPages: written,
    });
    scheduler.tick(new Date('2026-09-29T15:30:00Z'));
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'daily', day: '2026-09-29' });
  });

  it('reads a schedule state written before daily pages', () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(
      ctx.statePath,
      JSON.stringify({ lastFullKey: '2026-09-29:18', lastReminderKey: '2026-09-29:21' })
    );
    const scheduler = createReportScheduler({ ...ctx.options, dailyPages: written });
    scheduler.tick(new Date('2026-09-29T14:00:00Z'));
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'daily' });
  });

  it('gives the daily order its day as epoch bounds and the procedure topic', () => {
    const options = { backend: 'codex' as const, messenger: 'telegram', timeZone: 'Asia/Seoul' };
    const order = scheduledReportOrder(
      { report: 'daily', hourKey: '2026-09-29:23', day: '2026-09-29' },
      new Date('2026-09-29T14:00:00Z'),
      options
    );
    expect(order).toContain('[scheduled_daily] 2026-09-29');
    expect(order).toContain(
      `eventSince ${Date.parse('2026-09-29T00:00:00+09:00')}, eventBefore ${Date.parse('2026-09-30T00:00:00+09:00')}`
    );
    expect(order).toContain("daily/2026-09-29.md by its procedure, help({topic: 'daily'})");
    expect(order).toContain('Reply exactly [ack].');
    expect(() =>
      scheduledReportOrder({ report: 'daily', hourKey: '2026-09-29:23' }, new Date(), options)
    ).toThrow(/day/);
  });

  it('surfaces corrupt schedule state instead of silently forgetting delivered hours', () => {
    const ctx = setup();
    writeFileSync(join(root, 'broken.json'), '{');
    expect(() =>
      createReportScheduler({ ...ctx.options, statePath: join(root, 'broken.json') })
    ).toThrow();
  });
});
