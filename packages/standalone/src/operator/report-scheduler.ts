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
  /** Anchor timestamp (ISO) of the last SUCCESSFUL full report, for delta-scoped gathers. */
  loadLastSuccess(): string | null;
  /** Persist the anchor after a full report is delivered (failures must never advance it). */
  markSuccess(iso: string): void;
}

/** Persist/restore the last-fired hour key (so a restart within the same hour does not re-send). */
export interface ReportScheduleStore {
  load(): string | null;
  save(hourKey: string): void;
  /** Anchor timestamp (ISO) of the last SUCCESSFUL full report; null before the first one. */
  loadLastSuccess(): string | null;
  /** Persist the success anchor (read-modify-write so it never clobbers the fired-hour key). */
  markSuccess(iso: string): void;
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

  /** Anchor of the last SUCCESSFUL full report (delegates to the store). */
  loadLastSuccess(): string | null {
    return this.store.loadLastSuccess();
  }

  /** Persist the success anchor (delegates to the store; called ONLY on a delivered report). */
  markSuccess(iso: string): void {
    this.store.markSuccess(iso);
  }
}

/** File-backed store under ~/.mama - mirrors ConnectorDeltaRepo's atomic cursor file. */
export class FileReportScheduleStore implements ReportScheduleStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Read-parse the whole state object. MISSING file -> {} (silent, as today). A corrupt/empty
   * or non-object state file is disposable bookkeeping: rather than throw and permanently break
   * the report leg, reset LOUDLY and return {}. Worst case after a reset is one duplicate report
   * plus a wide gather window - both self-heal on the next successful report.
   */
  private readState(): { lastFiredHourKey?: unknown; lastSuccessIso?: unknown } {
    if (!existsSync(this.path)) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      console.error(
        '[report-scheduler] state file corrupt or unreadable - resetting schedule state:',
        error
      );
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(
        '[report-scheduler] state file corrupt or unreadable - resetting schedule state:',
        `not a plain object: ${this.path}`
      );
      return {};
    }
    return parsed as { lastFiredHourKey?: unknown; lastSuccessIso?: unknown };
  }

  /** Atomic full-object write (tmp+rename) - callers do read-modify-write to preserve sibling fields. */
  private writeState(state: { lastFiredHourKey?: string; lastSuccessIso?: string }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = join(dirname(this.path), `.report-schedule.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, this.path); // atomic replace
  }

  load(): string | null {
    const key = this.readState().lastFiredHourKey;
    return typeof key === 'string' ? key : null;
  }

  save(hourKey: string): void {
    // Read-modify-write: markFired must NOT clobber the success anchor.
    const state = this.readState();
    this.writeState({
      lastFiredHourKey: hourKey,
      ...(typeof state.lastSuccessIso === 'string' ? { lastSuccessIso: state.lastSuccessIso } : {}),
    });
  }

  loadLastSuccess(): string | null {
    const iso = this.readState().lastSuccessIso;
    return typeof iso === 'string' ? iso : null;
  }

  markSuccess(iso: string): void {
    // Read-modify-write: advancing the anchor must NOT clobber the fired-hour key.
    const state = this.readState();
    this.writeState({
      ...(typeof state.lastFiredHourKey === 'string'
        ? { lastFiredHourKey: state.lastFiredHourKey }
        : {}),
      lastSuccessIso: iso,
    });
  }
}
