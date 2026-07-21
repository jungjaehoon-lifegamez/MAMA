const RFC3339_EXACT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface ParsedExactDueAt {
  dueAt: number;
  deadline: string;
  offsetMinutes: number;
}

export type TemporalState =
  | 'closed'
  | 'exact_upcoming'
  | 'exact_overdue'
  | 'date_upcoming'
  | 'date_due'
  | 'date_overdue'
  | 'unscheduled';

export interface TemporalStateInput {
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

function dateInTimeZone(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new Error(`could not derive a calendar date in time zone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

export function deriveTemporalState(
  task: TemporalStateInput,
  now: number,
  daemonTimeZone: string
): TemporalState {
  if (!Number.isFinite(now)) {
    throw new Error(`temporal state clock must be a finite epoch millisecond value, got: ${now}`);
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
      ? dateInTimeZone(now, daemonTimeZone)
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

export function occurrenceKeyForTask(task: {
  temporalEpoch: number;
  dueAt: number | null;
  deadlineIso: string | null;
}): string | null {
  if (task.dueAt !== null) {
    return `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
  }
  if (task.deadlineIso !== null) {
    return `epoch:${task.temporalEpoch}:date:${task.deadlineIso}`;
  }
  return null;
}

export function temporalGenerationKey(
  taskId: number,
  occurrenceKey: string,
  checkAt: number
): string {
  if (!Number.isSafeInteger(taskId) || taskId < 1) {
    throw new Error(`temporal generation task id must be a positive integer, got: ${taskId}`);
  }
  if (occurrenceKey.length === 0) {
    throw new Error('temporal generation occurrence key must be non-empty');
  }
  if (!Number.isSafeInteger(checkAt)) {
    throw new Error(`temporal generation check must be an integer, got: ${checkAt}`);
  }
  return `task:${taskId}:${occurrenceKey}:check:${checkAt}`;
}
