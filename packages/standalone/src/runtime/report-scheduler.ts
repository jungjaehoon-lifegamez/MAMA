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
  /**
   * When the report that set each key was queued (epoch ms); absent in files written before.
   * Local hour keys do not order across a time zone change, so superseding compares these.
   */
  lastFullAt?: number;
  lastReminderAt?: number;
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
   * whether a <day>.md under daily/ was written at or after `since`: the day counts as done only
   * then.
   */
  dailyPages?: { written(day: string, since: number): boolean };
  /**
   * Includes queued/retrying inputs across restarts. An uncertain turn holds only its own report
   * and hour, and only with a saved result: reconciliation resends that result, so a new turn
   * would only write a second text under the same delivery key.
   */
  hasPendingReport: (report: 'full' | 'reminder' | 'daily', hourKey: string) => boolean;
  sendToOwner: (text: string, idempotencyKey: string) => Promise<void>;
  /** Drop the owner-message receipt a superseded report left undelivered under this key. */
  retireUndelivered: (idempotencyKey: string) => void;
  log: (line: string) => void;
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
    ) ||
    !['lastFullAt', 'lastReminderAt'].every((key) => {
      const value = (state as Record<string, unknown>)[key];
      return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
    })
  )
    throw new Error('Invalid report schedule state');
  return state as ReportScheduleState;
}

/**
 * When the latest report sent that covers this kind was queued: a reminder is covered by a later
 * reminder or full report, as tick treats a full report sent in its hour. 0 when nothing covers it.
 */
function coveredUntil(state: ReportScheduleState, report: 'full' | 'reminder' | 'daily'): number {
  if (report === 'full') return state.lastFullAt ?? 0;
  if (report === 'reminder') return Math.max(state.lastReminderAt ?? 0, state.lastFullAt ?? 0);
  return 0;
}

/** Produce scheduled owner turns; the mailbox holds the one-at-a-time boundary. */
export function createReportScheduler(options: ReportSchedulerOptions) {
  let state = loadState(options.statePath);
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (now = new Date()): void => {
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
    // onResult supersedes a report queued before the latest one that covers it, so a clock behind
    // that report would queue one turn a minute for nothing; it fails until the clock catches up.
    const covered = coveredUntil(state, full ? 'full' : 'reminder');
    if (reportDue && now.getTime() < covered)
      throw new Error(
        `The clock is before the latest report sent, queued at ${new Date(covered).toISOString()}; no report is queued until it passes that time`
      );
    // The day's page is due from its hour on; a day missed while the daemon was down or a report
    // was pending is written at the next tick after midnight. A first start waits for the hour.
    // At hour 0 the page is for the day that just ended, not the one that began.
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const yesterday = new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
    const dailyDay =
      options.config.daily_hour === 0
        ? yesterday
        : hour >= options.config.daily_hour
          ? day
          : state.lastDailyKey
            ? yesterday
            : null;
    // A report due in the same hour goes first.
    const dailyDue =
      !reportDue &&
      options.dailyPages !== undefined &&
      dailyDay !== null &&
      (state.lastDailyKey ?? '') < dailyDay;
    if (!reportDue && !dailyDue) return;
    const report = dailyDue ? 'daily' : full ? 'full' : 'reminder';
    if (options.hasPendingReport(report, hourKey)) return;
    const payload: Record<string, JsonValue> = dailyDue
      ? { report, hourKey, day: dailyDay! }
      : { report, hourKey, ...(full ? { previousFullReportAt: state.lastFullKey } : {}) };
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
      // The state holds the latest report sent. One queued before it was covered by it, and
      // saving its hour would move the key back; the daily key keeps its latest day the same way.
      const covered = coveredUntil(state, report);
      if (row.occurredAt < covered) {
        options.retireUndelivered(`report:${hourKey}:${report}`);
        options.log(
          `scheduled report superseded stimulus_id=${row.stimulusId} report=${report} hour=${hourKey} covered_by_report_queued_at=${new Date(covered).toISOString()}`
        );
        return;
      }
      const text = result.response.trim();
      if (!text) throw new Error('Scheduled report returned empty output');
      // An [ack] without the page would leave the day unwritten for good; failing the turn retries it.
      if (report === 'daily' && options.dailyPages?.written(day!, row.occurredAt) !== true)
        throw new Error(`The daily order ended without writing ${day}.md under daily/`);
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
          : report === 'full'
            ? { ...state, lastFullKey: hourKey, lastFullAt: row.occurredAt }
            : { ...state, lastReminderKey: hourKey, lastReminderAt: row.occurredAt };
      mkdirSync(dirname(options.statePath), { recursive: true });
      const temporary = `${options.statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
      renameSync(temporary, options.statePath);
      state = next;
    },
  };
}

export type ReportScheduler = ReturnType<typeof createReportScheduler>;
