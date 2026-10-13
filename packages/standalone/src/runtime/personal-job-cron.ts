import { validateTimeZone } from './timezone.js';
import { invalidInput } from '../utils/invalid-input.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
interface Field {
  values: number[];
  wildcard: boolean;
}
function field(text: string, min: number, max: number, sunday = false): Field {
  const values = new Set<number>();
  for (const entry of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(entry);
    if (!match) throw invalidInput(`Invalid cron field: ${text}`);
    const step = Number(match[2] ?? 1);
    const base = match[1]!;
    const [start, end] =
      base === '*'
        ? [min, max]
        : base.includes('-')
          ? base.split('-').map(Number)
          : [Number(base), match[2] ? max : Number(base)];
    if (!Number.isSafeInteger(step) || step < 1 || start! < min || end! > max || start! > end!)
      throw invalidInput(`Invalid cron range or step: ${text}`);
    for (let n = start!; n <= end!; n += step) values.add(sunday && n === 7 ? 0 : n);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: text === '*' };
}
function parse(cron: string) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5)
    throw invalidInput('Cron requires five fields: minute hour day month weekday');
  return {
    minute: field(fields[0]!, 0, 59),
    hour: field(fields[1]!, 0, 23),
    day: field(fields[2]!, 1, 31),
    month: field(fields[3]!, 1, 12),
    weekday: field(fields[4]!, 0, 7, true),
  };
}
function clock(timeZone: string) {
  validateTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (epoch: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(epoch).map(({ type, value }) => [type, value])
    );
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
  };
}
function dayMatches(date: Date, cron: ReturnType<typeof parse>) {
  if (!cron.month.values.includes(date.getUTCMonth() + 1)) return false;
  const dom = cron.day.values.includes(date.getUTCDate());
  const dow = cron.weekday.values.includes(date.getUTCDay());
  return cron.day.wildcard ? dow : cron.weekday.wildcard ? dom : dom || dow;
}
/** Convert a wall minute to every matching UTC minute. Gaps yield none; folds yield two. */
function dayOccurrences(
  day: number,
  cron: ReturnType<typeof parse>,
  wallAt: ReturnType<typeof clock>
) {
  // Offset samples surround the entire local day, including either side of a zone transition.
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 12) {
    const sample = day + h * 3_600_000;
    offsets.add(wallAt(sample) - sample);
  }
  const result = new Set<number>();
  for (const hour of cron.hour.values)
    for (const minute of cron.minute.values) {
      const wall = day + hour * 3_600_000 + minute * MINUTE;
      for (const offset of offsets) {
        const epoch = wall - offset;
        if (wallAt(epoch) === wall) result.add(epoch);
      }
    }
  return [...result].sort((a, b) => a - b);
}
/** Strictly after `after`; calendar scanning is bounded by one 400-year Gregorian cycle. */
export function cronOccurrences(
  expression: string,
  timeZone: string,
  after: number,
  count: number
): number[] {
  const cron = parse(expression);
  const wallAt = clock(timeZone);
  const first = Math.floor(wallAt(after) / DAY) * DAY;
  const result: number[] = [];
  for (let day = first; day <= first + 146_097 * DAY; day += DAY) {
    if (!dayMatches(new Date(day), cron)) continue;
    result.push(...dayOccurrences(day, cron, wallAt).filter((epoch) => epoch > after));
    if (result.length >= count) return result.slice(0, count);
  }
  throw invalidInput('Cron has no sufficient occurrences in the Gregorian calendar');
}
/** Latest occurrence at or before `now`, strictly after the schedule/completion anchor. */
export function latestCronOccurrence(
  expression: string,
  timeZone: string,
  now: number,
  after: number
): number | null {
  const cron = parse(expression);
  const wallAt = clock(timeZone);
  const first = Math.floor(wallAt(now) / DAY) * DAY;
  const floor = Math.max(Math.floor(wallAt(after) / DAY) * DAY, first - 146_097 * DAY);
  for (let day = first; day >= floor; day -= DAY) {
    if (!dayMatches(new Date(day), cron)) continue;
    const due = dayOccurrences(day, cron, wallAt).filter((epoch) => epoch <= now && epoch > after);
    if (due.length) return due.at(-1)!;
  }
  return null;
}
export function validateJobCron(cron: string, timeZone: string, now: number): void {
  const occurrences = cronOccurrences(cron, timeZone, now, 48);
  for (let n = 1; n < occurrences.length; n++)
    if (occurrences[n]! - occurrences[n - 1]! < 60 * MINUTE)
      throw invalidInput('Cron occurrences must be at least 60 minutes apart');
}
