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
  const retired: string[] = [];
  const logs: string[] = [];
  const held: Array<[string, string]> = [];
  const statePath = join(root, 'runtime', 'report-schedule-state.json');
  const alivePath = join(root, 'runtime', 'report-schedule-alive.json');
  const keys: string[] = [];
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
    alivePath,
    intake: {
      acceptScheduled: (input: ScheduledInput) => {
        queued.push(input);
        pending = true;
        return { state: 'accepted' as const, inputId: input.id };
      },
    },
    hasPendingReport: (report: string, hourKey: string) => {
      held.push([report, hourKey]);
      return pending;
    },
    sendToOwner: (text: string, key: string) => {
      keys.push(key);
      return send(text);
    },
    retireUndelivered: (key: string) => retired.push(key),
    log: (line: string) => logs.push(line),
    onError: (error: unknown) => {
      throw error;
    },
  };
  return {
    options,
    scheduler: createReportScheduler(options),
    queued,
    sent,
    retired,
    logs,
    held,
    keys,
    statePath,
    alivePath,
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

  it('sends the next full report after the zone moves back, so a later hour with a smaller key is not superseded', async () => {
    const ctx = setup();
    ctx.scheduler.tick(new Date('2026-01-01T04:00:00Z')); // 13:00 in Seoul
    await ctx.scheduler.onResult(ctx.result(), { response: 'Seoul report' });
    ctx.setPending(false);
    ctx.options.timeZone.set('America/Los_Angeles');
    const later = new Date('2026-01-01T16:00:00Z'); // 08:00 the same day in Los Angeles
    ctx.scheduler.tick(later);
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'full', hourKey: '2026-01-01:08' });
    await ctx.scheduler.onResult(ctx.result(), { response: 'Los Angeles report' });
    expect(ctx.sent).toEqual(['Seoul report', 'Los Angeles report']);
    expect(ctx.retired).toEqual([]);
    ctx.setPending(false);
    ctx.scheduler.tick(new Date(later.getTime() + 60_000));
    expect(ctx.queued).toHaveLength(2);
  });

  it('fails each due tick while the clock is behind the latest report sent, and queues once it passes', async () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    // A report sent while the clock ran years ahead.
    writeFileSync(
      ctx.statePath,
      JSON.stringify({
        lastFullKey: '2030-01-01:13',
        lastFullAt: Date.parse('2030-01-01T04:00:00Z'),
        lastReminderKey: null,
      })
    );
    const errors: unknown[] = [];
    const scheduler = createReportScheduler({
      ...ctx.options,
      onError: (error) => errors.push(error),
    });
    for (const iso of ['2025-12-31T23:00:00Z', '2026-01-01T04:00:00Z', '2026-01-01T09:00:00Z'])
      expect(() => scheduler.tick(new Date(iso))).toThrow(
        'The clock is before the latest report sent, queued at 2030-01-01T04:00:00.000Z'
      );
    // A reminder hour is covered by the full report too.
    expect(() => scheduler.tick(new Date('2026-01-01T01:00:00Z'))).toThrow('2030-01-01T04:00:00');
    // Outside the report hours nothing is due, so nothing fails.
    scheduler.tick(new Date('2026-01-01T14:00:00Z'));
    expect(ctx.queued).toEqual([]);
    // The timer reports it through onError.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T03:59:30Z'));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stop();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('2030-01-01T04:00:00.000Z');
    scheduler.tick(new Date('2030-01-01T09:00:00Z'));
    expect(ctx.queued.at(-1)!.payload).toMatchObject({ report: 'full', hourKey: '2030-01-01:18' });
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
      lastFullAt: now.getTime(),
      lastReminderKey: null,
    });
    ctx.setPending(false);
    createReportScheduler(ctx.options).tick(now);
    expect(ctx.queued).toHaveLength(1);
  });

  it('leaves a failed send unwritten, holds its hour, and saves the hour once the stored result is sent', async () => {
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
    // The parked turn holds a saved result for this report and hour, so the daemon says pending.
    ctx.scheduler.tick(new Date(now.getTime() + 60_000));
    expect(ctx.held.at(-1)).toEqual(['full', '2026-01-01:13']);
    expect(ctx.queued).toHaveLength(1);
    // Reconciliation sends the same stored result.
    ctx.setSend(async (text) => {
      ctx.sent.push(text);
    });
    await ctx.scheduler.onResult(ctx.result(), { response: 'report' });
    expect(ctx.sent).toEqual(['report']);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
  });

  it.each([
    [
      'full',
      'a later full report',
      {
        lastFullKey: '2026-01-01:18',
        lastFullAt: Date.parse('2026-01-01T09:00:00Z'),
        lastReminderKey: null,
      },
      '2026-01-01T09:00:00.000Z',
    ],
    [
      'reminder',
      'a later reminder',
      {
        lastFullKey: null,
        lastReminderKey: '2026-01-01:14',
        lastReminderAt: Date.parse('2026-01-01T05:00:00Z'),
      },
      '2026-01-01T05:00:00.000Z',
    ],
    // A reminder parked across the next full report, after the reminder hours were narrowed.
    [
      'reminder',
      'a later full report',
      {
        lastFullKey: '2026-01-01:18',
        lastFullAt: Date.parse('2026-01-01T09:00:00Z'),
        lastReminderKey: '2026-01-01:10',
        lastReminderAt: Date.parse('2026-01-01T01:00:00Z'),
      },
      '2026-01-01T09:00:00.000Z',
    ],
  ] as const)(
    'skips a %s queued before %s and retires its receipt',
    async (report, _by, saved, coveredAt) => {
      const ctx = setup();
      mkdirSync(join(root, 'runtime'), { recursive: true });
      const stored = JSON.stringify(saved);
      writeFileSync(ctx.statePath, stored);
      const scheduler = createReportScheduler(ctx.options);
      await scheduler.onResult(
        {
          stimulusId: 'report:2026-01-01:13:fixture',
          payload: { report, hourKey: '2026-01-01:13', previousFullReportAt: '2026-01-01:08' },
          occurredAt: Date.parse('2026-01-01T04:00:00Z'),
        },
        { response: 'an old report' }
      );
      expect(ctx.sent).toEqual([]);
      expect(ctx.retired).toEqual([`report:2026-01-01:13:${report}`]);
      expect(ctx.logs).toEqual([
        `scheduled report superseded stimulus_id=report:2026-01-01:13:fixture report=${report} hour=2026-01-01:13 covered_by_report_queued_at=${coveredAt}`,
      ]);
      expect(readFileSync(ctx.statePath, 'utf8')).toBe(stored);
    }
  );

  it('closes a report parked under a state written before queue times once the next full report is saved', async () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(
      ctx.statePath,
      JSON.stringify({ lastFullKey: '2026-01-01:08', lastReminderKey: null })
    );
    const scheduler = createReportScheduler(ctx.options);
    const parked = {
      stimulusId: 'report:2025-12-31:18:fixture',
      payload: { report: 'full', hourKey: '2025-12-31:18', previousFullReportAt: '2025-12-31:13' },
      occurredAt: Date.parse('2025-12-31T09:00:00Z'),
    };
    // Without a queue time nothing is superseded; the stored send is still uncertain.
    ctx.setSend(async () => {
      throw new Error('Telegram outbound delivery is uncertain');
    });
    await expect(scheduler.onResult(parked, { response: 'old report' })).rejects.toThrow(
      'uncertain'
    );
    expect(ctx.retired).toEqual([]);
    ctx.setSend(async (text) => {
      ctx.sent.push(text);
    });
    scheduler.tick(new Date('2026-01-01T04:00:00Z'));
    await scheduler.onResult(ctx.result(), { response: 'next report' });
    const state = readFileSync(ctx.statePath, 'utf8');
    await scheduler.onResult(parked, { response: 'old report' });
    expect(ctx.sent).toEqual(['next report']);
    expect(ctx.retired).toEqual(['report:2025-12-31:18:full']);
    expect(readFileSync(ctx.statePath, 'utf8')).toBe(state);
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
      'The daily order ended without writing 2026-09-29.md under daily/'
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
    expect(order).toContain(
      "daily page daily/2026-09/2026-09-29.md by its procedure, help({topic: 'daily'})"
    );
    expect(order).toContain('Reply exactly [ack].');
    expect(() =>
      scheduledReportOrder({ report: 'daily', hourKey: '2026-09-29:23' }, new Date(), options)
    ).toThrow(/day/);
  });

  it('records when it last ran and tells the owner, after a restart, which report hours passed with nothing sent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T07:21:00Z')); // 16:21 KST
    const before = setup();
    before.scheduler.start();
    expect(JSON.parse(readFileSync(before.alivePath, 'utf8'))).toEqual({
      aliveAt: Date.parse('2026-11-12T07:21:00Z'),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const lastAlive = Date.parse('2026-11-12T07:22:00Z');
    expect(JSON.parse(readFileSync(before.alivePath, 'utf8'))).toEqual({ aliveAt: lastAlive });
    before.scheduler.stop();
    expect(before.sent).toEqual([]);

    vi.setSystemTime(new Date('2026-11-13T12:50:00Z')); // 21:50 KST, the next day
    const after = setup();
    after.scheduler.start();
    await vi.waitFor(() => expect(after.sent).toHaveLength(1));
    expect(after.sent[0]).toBe(
      [
        'MAMA was not running from 2026-11-12 16:22 to 2026-11-13 21:50 (Asia/Seoul).',
        'Not sent in that time: 4 full reports (2026-11-12 18:00, 2026-11-13 08:00, 2026-11-13 13:00, 2026-11-13 18:00) and 14 reminder hours.',
        'The next full report covers everything since the last one sent.',
      ].join('\n')
    );
    expect(after.keys).toEqual([`downtime:${lastAlive}`]);
    expect(after.logs).toContain(
      `daemon was not running from=2026-11-12T07:22:00.000Z to=2026-11-13T12:50:00.000Z missed_full=4 missed_reminder=14`
    );
    // Delivered, so the record no longer owes it.
    expect(Object.keys(JSON.parse(readFileSync(after.alivePath, 'utf8')))).toEqual(['aliveAt']);
    after.scheduler.stop();
  });

  it('keeps an undelivered notice, sends it again each minute and after a restart, and only once delivered stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T07:21:00Z')); // 16:21 KST
    const before = setup();
    before.scheduler.start();
    before.scheduler.stop();
    vi.setSystemTime(new Date('2026-11-12T10:10:00Z')); // 19:10 KST: 17:00 and 18:00 passed
    const failing = setup();
    failing.setSend(async () => {
      throw new Error('network down');
    });
    const errors: unknown[] = [];
    const scheduler = createReportScheduler({
      ...failing.options,
      onError: (error: unknown) => errors.push(error),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.keys).toEqual(['downtime:1794468060000']);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.keys).toEqual(['downtime:1794468060000', 'downtime:1794468060000']);
    scheduler.stop();
    expect(JSON.parse(readFileSync(failing.alivePath, 'utf8')).unsent).toEqual([
      { from: 1794468060000, to: Date.parse('2026-11-12T10:10:00Z') },
    ]);

    // Restarted in the same hour: the owed notice goes out, and no new one is added.
    vi.setSystemTime(new Date('2026-11-12T10:20:00Z'));
    const restarted = setup();
    restarted.scheduler.start();
    await vi.waitFor(() => expect(restarted.sent).toHaveLength(1));
    expect(restarted.sent[0]).toMatch(
      /^MAMA was not running from 2026-11-12 16:21 to 2026-11-12 19:10 \(Asia\/Seoul\)\.\nNot sent in that time: 1 full report \(2026-11-12 18:00\) and 1 reminder hour\./
    );
    expect(restarted.keys).toEqual(['downtime:1794468060000']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarted.sent).toHaveLength(1);
    restarted.scheduler.stop();
  });

  it('counts the hour it starts in when its first tick falls in the next hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T07:21:00Z')); // 16:21 KST
    setup().scheduler.start();
    vi.setSystemTime(new Date('2026-11-12T09:59:30Z')); // 18:59:30 KST
    const restarted = setup();
    restarted.scheduler.start();
    await vi.waitFor(() => expect(restarted.sent).toHaveLength(1));
    expect(restarted.sent[0]).toContain('1 full report (2026-11-12 18:00) and 1 reminder hour.');
    restarted.scheduler.stop();
  });

  it('still runs the reports when the record of when it last ran cannot be written', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T04:00:00Z')); // 13:00 KST
    const ctx = setup();
    const errors: unknown[] = [];
    const scheduler = createReportScheduler({
      ...ctx.options,
      onError: (error: unknown) => errors.push(error),
    });
    scheduler.start();
    mkdirSync(`${ctx.alivePath}.tmp`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect(ctx.queued).toHaveLength(1);
    scheduler.stop();
  });

  it('says nothing on a first start or a restart that passed no report hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T13:30:00Z')); // 22:30 KST
    const first = setup();
    first.scheduler.start();
    first.scheduler.stop();
    // A restart within the hour, and one across 23:00 and midnight, which are not report hours.
    for (const now of ['2026-11-12T13:31:00Z', '2026-11-12T15:10:00Z']) {
      vi.setSystemTime(new Date(now));
      const restarted = setup();
      restarted.scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      restarted.scheduler.stop();
      expect(restarted.sent).toEqual([]);
      expect(restarted.logs.filter((line) => line.startsWith('daemon was not running'))).toEqual(
        []
      );
    }
    expect(first.sent).toEqual([]);
  });

  it('surfaces a corrupt record of when it last ran', () => {
    const ctx = setup();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(ctx.alivePath, '{"aliveAt":"yesterday"}');
    expect(() => createReportScheduler(ctx.options)).toThrow(/alive/);
  });

  it('surfaces corrupt schedule state instead of silently forgetting delivered hours', () => {
    const ctx = setup();
    writeFileSync(join(root, 'broken.json'), '{');
    expect(() =>
      createReportScheduler({ ...ctx.options, statePath: join(root, 'broken.json') })
    ).toThrow();
  });
});
