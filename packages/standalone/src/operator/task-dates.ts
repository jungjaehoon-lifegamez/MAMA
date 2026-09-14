/**
 * Task deadlines: the date arithmetic and the due state read off a task row.
 *
 * A deadline is a date, not an instant: "due Tuesday" means the start of that
 * day where the owner is, and an explicit offset overrides the zone when one
 * was recorded.
 *
 * This is what the retired temporal reconciliation subsystem was built ON, not
 * part of it. Reading whether a task is overdue is an ordinary read that
 * `task_list due_bucket`, the board renderer and the wiki continuity reader all
 * perform; deciding to re-check an occurrence and file a receipt for it was the
 * machinery, and that machinery is gone. The vocabulary is renamed accordingly
 * so nothing here reads as a surviving piece of it.
 *
 * @module operator/task-dates
 */

export function dateInIanaZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new Error(`could not derive local date in time zone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

export function startOfTaskDate(
  deadlineIso: string,
  offsetMinutes: number | null,
  timeZone: string
): number {
  const utcMidnight = Date.parse(`${deadlineIso}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) {
    throw new Error(`invalid task deadline date: ${deadlineIso}`);
  }
  if (offsetMinutes !== null) {
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
      throw new Error(`invalid task deadline offset: ${offsetMinutes}`);
    }
    return utcMidnight - offsetMinutes * 60_000;
  }

  // Find the first UTC millisecond that formats as the requested local date.
  // This remains correct across DST changes where a fixed 24-hour subtraction does not.
  let low = utcMidnight - 36 * 60 * 60 * 1000;
  let high = utcMidnight + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dateInIanaZone(middle, timeZone) < deadlineIso) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (dateInIanaZone(low, timeZone) !== deadlineIso) {
    throw new Error(`task deadline date ${deadlineIso} does not exist in time zone ${timeZone}`);
  }
  return low;
}

const RFC3339_EXACT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface ParsedExactDueAt {
  dueAt: number;
  deadline: string;
  offsetMinutes: number;
}

export type DueState =
  | 'closed'
  | 'exact_upcoming'
  | 'exact_overdue'
  | 'date_upcoming'
  | 'date_due'
  | 'date_overdue'
  | 'unscheduled';

export const DUE_BUCKETS = ['missing', 'overdue', 'upcoming', 'closed'] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

export function dueBucketForState(state: DueState): DueBucket {
  if (state === 'closed') return 'closed';
  if (state === 'unscheduled') return 'missing';
  if (state === 'exact_overdue' || state === 'date_overdue') return 'overdue';
  return 'upcoming';
}

export interface DueStateInput {
  status: string;
  dueAt: number | null;
  deadlineIso: string | null;
  deadlineOffsetMinutes: number | null;
}

function dateAtFixedOffset(now: number, offsetMinutes: number): string {
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
    throw new Error(`deadline offset must be an integer from -840 to 840, got: ${offsetMinutes}`);
  }
  return new Date(now + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function deriveDueState(task: DueStateInput, now: number, daemonTimeZone: string): DueState {
  if (!Number.isFinite(now)) {
    throw new Error(`due state clock must be a finite epoch millisecond value, got: ${now}`);
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    return 'closed';
  }
  if (task.dueAt !== null) {
    return task.dueAt > now ? 'exact_upcoming' : 'exact_overdue';
  }
  if (task.deadlineIso === null) {
    return 'unscheduled';
  }
  const today =
    task.deadlineOffsetMinutes === null
      ? dateInIanaZone(now, daemonTimeZone)
      : dateAtFixedOffset(now, task.deadlineOffsetMinutes);
  if (task.deadlineIso > today) {
    return 'date_upcoming';
  }
  if (task.deadlineIso < today) {
    return 'date_overdue';
  }
  return 'date_due';
}

export function parseExactDueAt(value: string): ParsedExactDueAt {
  const match = RFC3339_EXACT_PATTERN.exec(value);
  if (!match) {
    throw new Error('due_at must be RFC 3339 with an explicit offset');
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHours = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinutePart = zone === 'Z' ? 0 : Number(offsetMinuteText);
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const validLocalFields =
    localDate.getUTCFullYear() === year &&
    localDate.getUTCMonth() === month - 1 &&
    localDate.getUTCDate() === day &&
    localDate.getUTCHours() === hour &&
    localDate.getUTCMinutes() === minute &&
    localDate.getUTCSeconds() === second;
  const validOffset =
    offsetHours <= 14 && offsetMinutePart <= 59 && (offsetHours < 14 || offsetMinutePart === 0);
  const dueAt = Date.parse(value);
  if (!validLocalFields || !validOffset || !Number.isFinite(dueAt)) {
    throw new Error('due_at must be valid RFC 3339 with an explicit offset');
  }
  const offsetMagnitude = offsetHours * 60 + offsetMinutePart;
  const offsetMinutes = zone === 'Z' ? 0 : sign === '-' ? -offsetMagnitude : offsetMagnitude;
  return {
    dueAt,
    deadline: `${yearText}-${monthText}-${dayText}`,
    offsetMinutes,
  };
}
