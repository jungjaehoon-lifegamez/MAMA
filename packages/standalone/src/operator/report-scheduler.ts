/**
 * ReportScheduler - the scheduled full-report cadence (M2-T0).
 *
 * Ports the schedule-firing MECHANISM from Kagemusha AgentAwareness.tickScheduledReports
 * (~/project/mama-suite/apps/kagemusha/src/runtime/agent-awareness.ts:1371 + buildHourKey:1483):
 * fire once when the current hour is one of the configured hours and this hour has not been fired
 * yet. Kagemusha keys on Asia/Seoul; MAMA uses LOCAL hours (Date.getHours) per the M2 brief - the
 * owner timezone stays a runtime property, never a source constant.
 *
 * Pure decision (shouldFire) + a persisted last-fired hour key (survives restart -> no
 * double-send). NO personal data: the hours are injected from env/config, never hardcoded here.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Injectable schedule seam - the loop depends on this, not the concrete class (DI + testability). */
export interface ReportSchedule {
  shouldFire(now: Date): { fire: boolean; hourKey: string };
  markFired(hourKey: string): void;
}

/** Persist/restore the last-fired hour key (so a restart within the same hour does not re-send). */
export interface ReportScheduleStore {
  load(): string | null;
  save(hourKey: string): void;
}

/** Local-time "YYYY-MM-DD:HH" bucket. Two ticks in the same local hour share a key. */
export function hourKeyLocal(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}:${pad(now.getHours())}`;
}

/**
 * Parse an env string like "8,13,18" into sorted, deduped LOCAL hours in [0,23].
 * Empty/garbage -> [] (feature off). Ports Kagemusha normalizeFullReportHours
 * (~/project/mama-suite/apps/kagemusha/src/config/ai-config.ts:203) but generic + ASCII, no
 * personal defaults.
 */
export function parseReportHours(raw: string): number[] {
  const hours = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '') // drop empty tokens BEFORE Number(): Number('') === 0 would sneak in hour 0
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

export class ReportScheduler implements ReportSchedule {
  private hours: number[];
  private store: ReportScheduleStore;
  private lastFiredHourKey: string | null;

  constructor(hours: number[], store: ReportScheduleStore) {
    this.hours = hours;
    this.store = store;
    this.lastFiredHourKey = store.load(); // restore across restart
  }

  /** Pure: does a full report fire at now? Robust to ticks not landing on the hour boundary. */
  shouldFire(now: Date): { fire: boolean; hourKey: string } {
    const hourKey = hourKeyLocal(now);
    const fire = this.hours.includes(now.getHours()) && this.lastFiredHourKey !== hourKey;
    return { fire, hourKey };
  }

  /** Mark this hour delivered (persist) so we fire once per configured hour, restart-safe. */
  markFired(hourKey: string): void {
    this.lastFiredHourKey = hourKey;
    this.store.save(hourKey);
  }
}

/** File-backed store under ~/.mama - mirrors ConnectorDeltaRepo's atomic cursor file. */
export class FileReportScheduleStore implements ReportScheduleStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): string | null {
    if (!existsSync(this.path)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8')); // throws on corrupt (no-fallback)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`corrupt report-schedule state (not an object): ${this.path}`);
    }
    const key = (parsed as { lastFiredHourKey?: unknown }).lastFiredHourKey;
    return typeof key === 'string' ? key : null;
  }

  save(hourKey: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.report-schedule.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ lastFiredHourKey: hourKey }), 'utf8');
    renameSync(tmp, this.path); // atomic replace
  }
}
