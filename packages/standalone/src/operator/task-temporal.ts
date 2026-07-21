const RFC3339_EXACT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface ParsedExactDueAt {
  dueAt: number;
  deadline: string;
  offsetMinutes: number;
}

export function parseExactDueAt(value: string): ParsedExactDueAt {
  const match = RFC3339_EXACT_PATTERN.exec(value);
  if (!match) {
    throw new Error(`due_at must be RFC 3339 with an explicit offset, got: ${value}`);
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
    throw new Error(`due_at must be valid RFC 3339 with an explicit offset, got: ${value}`);
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
