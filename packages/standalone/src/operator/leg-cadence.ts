/**
 * Leg cadence: every scheduled leg declares how often it runs and BEATS when
 * it does; an independent watchdog pages the owner when a leg goes silent.
 *
 * Placement (review D2): the watchdog lives on its OWN timer, outside the
 * trigger loop - a watchdog inside the thing it watches dies with it (the
 * trigger author was dead for two days before v0.29.2 named why). The
 * trigger loop itself registers as a watched leg; whole-daemon death is
 * launchd KeepAlive's job.
 *
 * State (review #11): most legs are bare setIntervals with no durable
 * last-run, so each leg's tick calls `beat()` - one line, watchdog-owned
 * table, no log-projection reads (state questions get live reads).
 *
 * Paging (review #12): 2x declared cadence, quiet hours honored (the
 * heartbeat's 23:00-08:00 window - without it a 30-minute leg pages the
 * owner at midnight, nightly, forever), duplicate-suppressed across
 * restarts, one recovery notice. An alarm, never enforcement.
 */
import type { SQLiteDatabase } from '../sqlite.js';

export interface LegDeclaration {
  name: string;
  declaredCadenceMs: number;
}

export interface LegPageEvent {
  name: string;
  declaredCadenceMs: number;
  silentForMs: number;
}

export interface LegCadenceOptions {
  now?: () => number;
  /** Local hour provider - injectable for tests. */
  hourOfDay?: () => number;
  quietStartHour?: number;
  quietEndHour?: number;
}

export class LegCadence {
  private readonly legs = new Map<string, number>();
  private readonly now: () => number;
  private readonly hourOfDay: () => number;
  private readonly quietStart: number;
  private readonly quietEnd: number;
  private readonly stmtBeat;
  private readonly stmtRow;
  private readonly stmtSetPaged;

  constructor(
    private readonly db: SQLiteDatabase,
    options: LegCadenceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.hourOfDay = options.hourOfDay ?? (() => new Date().getHours());
    this.quietStart = options.quietStartHour ?? 23;
    this.quietEnd = options.quietEndHour ?? 8;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leg_beats (
        name TEXT PRIMARY KEY,
        last_beat_at INTEGER NOT NULL,
        paged_at INTEGER
      )
    `);
    this.stmtBeat = this.db.prepare(
      `INSERT INTO leg_beats (name, last_beat_at, paged_at) VALUES (?, ?, NULL)
       ON CONFLICT(name) DO UPDATE SET last_beat_at = excluded.last_beat_at`
    );
    this.stmtRow = this.db.prepare(`SELECT last_beat_at, paged_at FROM leg_beats WHERE name = ?`);
    this.stmtSetPaged = this.db.prepare(`UPDATE leg_beats SET paged_at = ? WHERE name = ?`);
  }

  /** Declare a leg. First declaration seeds last_beat_at = now (boot counts). */
  declare(name: string, declaredCadenceMs: number): void {
    this.legs.set(name, declaredCadenceMs);
    const row = this.stmtRow.get(name) as { last_beat_at: number } | undefined;
    if (!row) {
      this.stmtBeat.run(name, this.now());
    }
  }

  /** One line per leg tick. Undeclared beats are recorded, not errors. */
  beat(name: string): void {
    this.stmtBeat.run(name, this.now());
  }

  private isQuietHour(): boolean {
    const hour = this.hourOfDay();
    return this.quietStart > this.quietEnd
      ? hour >= this.quietStart || hour < this.quietEnd
      : hour >= this.quietStart && hour < this.quietEnd;
  }

  /**
   * One watchdog pass. Returns what to SAY - the caller owns delivery.
   * Overdue = silent past 2x declared cadence. A page is recorded so it
   * fires once per silence (persisted - restarts do not re-page); recovery
   * clears the record and reports once.
   */
  check(): { pages: LegPageEvent[]; recoveries: string[] } {
    const pages: LegPageEvent[] = [];
    const recoveries: string[] = [];
    const now = this.now();
    for (const [name, cadence] of this.legs) {
      const row = this.stmtRow.get(name) as
        | { last_beat_at: number; paged_at: number | null }
        | undefined;
      if (!row) {
        continue;
      }
      const silentFor = now - row.last_beat_at;
      const overdue = silentFor > cadence * 2;
      if (overdue && row.paged_at === null) {
        if (this.isQuietHour()) {
          // Deferred, not dropped: still unpaged next check after sunrise.
          continue;
        }
        pages.push({ name, declaredCadenceMs: cadence, silentForMs: silentFor });
        this.stmtSetPaged.run(now, name);
      } else if (!overdue && row.paged_at !== null) {
        recoveries.push(name);
        this.stmtSetPaged.run(null, name);
      }
    }
    return { pages, recoveries };
  }
}

let singleton: LegCadence | null = null;
let pageNotifier: ((message: string) => Promise<void>) | null = null;

/** Gateway wiring registers the actual send; the watchdog only composes text. */
export function setLegPageNotifier(notifier: ((message: string) => Promise<void>) | null): void {
  pageNotifier = notifier;
}

export function getLegPageNotifier(): ((message: string) => Promise<void>) | null {
  return pageNotifier;
}

/** Boot-owned singleton so any leg can beat with one line, no plumbing. */
export function initLegCadence(db: SQLiteDatabase, options?: LegCadenceOptions): LegCadence {
  singleton = new LegCadence(db, options);
  return singleton;
}

export function getLegCadence(): LegCadence | null {
  return singleton;
}
