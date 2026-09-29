import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { W1ReportsConfig } from './config.js';
import type { StimulusIntake } from './stimulus-delivery.js';
import { REPORT_CHANNEL, scheduledReport } from './turn-orders.js';
import type { TimeZoneSetting } from './timezone.js';

interface ReportScheduleState {
  lastFullKey: string | null;
  lastReminderKey: string | null;
  /** The latest day whose daily page was written; absent in files written before daily pages. */
  lastDailyKey?: string | null;
}

export interface ReportSchedulerOptions {
  config: W1ReportsConfig;
  timeZone: TimeZoneSetting;
  statePath: string;
  intake: Pick<StimulusIntake, 'acceptScheduled'>;
  /**
   * Write a daily wiki page at reports.daily_hour; only with the wiki enabled. `written` says
   * whether daily/<day>.md was written at or after `since`: the day counts as done only then.
   */
  dailyPages?: { written(day: string, since: number): boolean };
  /** Includes queued/retrying inputs across restarts, excludes uncertain failed turns. */
  hasPendingReport: () => boolean;
  sendToOwner: (text: string, idempotencyKey: string) => Promise<void>;
  onError: (error: unknown) => void;
}

function loadState(path: string): ReportScheduleState {
  if (!existsSync(path)) return { lastFullKey: null, lastReminderKey: null };
  const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !state ||
    typeof state !== 'object' ||
    !['lastFullKey', 'lastReminderKey'].every((key) => {
      const value = (state as Record<string, unknown>)[key];
      return (
        value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}:\d{2}$/.test(value))
      );
    }) ||
    !(
      (state as Record<string, unknown>).lastDailyKey === undefined ||
      (state as Record<string, unknown>).lastDailyKey === null ||
      (typeof (state as Record<string, unknown>).lastDailyKey === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test((state as Record<string, unknown>).lastDailyKey as string))
    )
  )
    throw new Error('Invalid report schedule state');
  return state as ReportScheduleState;
}

/** Produce scheduled owner turns; the mailbox holds the one-at-a-time boundary. */
export function createReportScheduler(options: ReportSchedulerOptions) {
  let state = loadState(options.statePath);
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (now = new Date()): void => {
    if (options.hasPendingReport()) return;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: options.timeZone.get(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)!.value;
    const hour = Number(part('hour'));
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    const hourKey = `${day}:${part('hour')}`;
    const full = options.config.full_report_hours.includes(hour);
    const reportDue = full
      ? state.lastFullKey !== hourKey
      : hour >= options.config.reminder_start_hour &&
        hour <= options.config.reminder_end_hour &&
        state.lastReminderKey !== hourKey &&
        // A full report already sent this hour covers it, even if the hour is no longer a
        // full-report hour after a config change.
        state.lastFullKey !== hourKey;
    // The day's page is due from its hour on; a day missed while the daemon was down or a report
    // was pending is written at the next tick after midnight. A first start waits for the hour.
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const yesterday = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
    const dailyDay =
      hour >= options.config.daily_hour ? day : state.lastDailyKey ? yesterday : null;
    // A report due in the same hour goes first.
    const dailyDue =
      !reportDue &&
      options.dailyPages !== undefined &&
      dailyDay !== null &&
      (state.lastDailyKey ?? '') < dailyDay;
    if (!reportDue && !dailyDue) return;
    const payload: Record<string, JsonValue> = dailyDue
      ? { report: 'daily', hourKey, day: dailyDay! }
      : {
          report: full ? 'full' : 'reminder',
          hourKey,
          ...(full ? { previousFullReportAt: state.lastFullKey } : {}),
        };
    options.intake.acceptScheduled({
      id: `report:${hourKey}:${randomUUID()}`,
      channelKey: REPORT_CHANNEL,
      occurredAt: now.getTime(),
      payload,
    });
  };
  return {
    tick,
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          options.onError(error);
        }
      }, 60_000);
      timer.unref();
    },
    // The daemon stops producers first, then drains the owner before Telegram.
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
    onResult: async (
      row: Pick<MailboxRow, 'stimulusId' | 'payload' | 'occurredAt'>,
      result: Pick<NativeTurnResult, 'response'>
    ): Promise<void> => {
      const { report, hourKey, day } = scheduledReport(row.payload);
      const text = result.response.trim();
      if (!text) throw new Error('Scheduled report returned empty output');
      // An [ack] without the page would leave the day unwritten for good; failing the turn retries it.
      if (report === 'daily' && options.dailyPages?.written(day!, row.occurredAt) !== true)
        throw new Error(`The daily order ended without writing daily/${day}.md`);
      // A reminder with nothing that needs the owner ends with [ack] and is not sent; the last
      // marker decides, as for delta replies. A daily page goes to the wiki, never to the owner.
      const lastMarker = text.slice(
        Math.max(text.lastIndexOf('[notify]'), text.lastIndexOf('[ack]'))
      );
      if (report === 'full' || (report === 'reminder' && !lastMarker.startsWith('[ack]')))
        await options.sendToOwner(text, `report:${hourKey}:${report}`);
      // A daily page rewritten for an earlier day leaves the latest day in place.
      const next =
        report === 'daily'
          ? { ...state, lastDailyKey: [state.lastDailyKey ?? '', day!].sort().at(-1)! }
          : { ...state, [report === 'full' ? 'lastFullKey' : 'lastReminderKey']: hourKey };
      mkdirSync(dirname(options.statePath), { recursive: true });
      const temporary = `${options.statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
      renameSync(temporary, options.statePath);
      state = next;
    },
  };
}

export type ReportScheduler = ReturnType<typeof createReportScheduler>;
