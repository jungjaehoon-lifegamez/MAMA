/**
 * Wiki daily-continuity host planner.
 *
 * The wiki turn restores BUSINESS daily continuity - the Slack/Chatwork
 * movement that belongs in `daily/YYYY-MM-DD.md`. Production 0.48.0 treated the
 * batchId timestamp as an "input watermark" and completed the run with
 * contract_no_update without reading anything: the payload carried only
 * batchId/events/attempts, so the turn had no time boundary and no source scope.
 *
 * This module computes, in HOST code, the typed fields a wiki work order must
 * carry so the turn reads a bounded, explicit range rather than inventing one
 * from a batch id or the wall clock:
 *  - `ownerDate` (YYYY-MM-DD in the owner IANA time zone)
 *  - `range` ({ start_ms, end_ms }) over that owner day, continuing from the
 *    last DONE wiki run when it landed inside the same day
 *  - `sourceWatermark` over connector observation, native owner tasks and
 *    memory recency - NOT agent notices, so a wiki completion/no-update notice
 *    cannot wake the wiki turn forever
 *  - `connectors`, the immutable authorized raw connector scope
 *
 * The date/watermark gate skips the model only when the SAME owner date and the
 * SAME source watermark already completed. A new owner date gets one run even
 * when sources are quiet; a later quiet tick on the same date skips. A manual
 * request bypasses the skip. Every uncertain case enqueues (availability beats
 * the token saving), using the owner day's start as the safe range start.
 *
 * Time-zone arithmetic is delegated to the existing DST-correct helpers
 * (`startOfTaskDate`, `dateInIanaZone`) rather than reimplemented here.
 */

import { createHash } from 'node:crypto';

import { startOfTaskDate, dateInIanaZone } from './temporal-reconcile.js';

/** Bound on the watermark string, matching the workorder payload field bound. */
export const WIKI_WATERMARK_MAX_LENGTH = 1000;

const OWNER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WikiRange {
  start_ms: number;
  end_ms: number;
}

export interface WikiPayload {
  /** Trigger provenance (unchanged shape): `<nowMs>-<trigger>`. */
  batchId: string;
  /** Trigger provenance; events carry no content. */
  events: string[];
  /** Owner-local calendar date this run covers (YYYY-MM-DD). */
  ownerDate: string;
  /** Explicit time boundary the turn reads; never inferred from batchId. */
  range: WikiRange;
  /**
   * `range.start_ms` as a canonical RFC 3339 string (`new Date(start_ms).toISOString()`).
   * The real task_list facade rejects a numeric `updated_since` and requires an
   * RFC 3339 timestamp with an explicit offset, so the turn passes THIS literal
   * string to task_list.updated_since - it names the exact same instant as
   * range.start_ms.
   */
  taskUpdatedSince: string;
  /**
   * Composite watermark over connector observation, native owner tasks and
   * memory recency. Null only when the host signal was unusable at enqueue time.
   */
  sourceWatermark: string | null;
  /** Immutable authorized raw connector scope the turn may read. */
  connectors: string[];
  /**
   * The EXACT scope the turn passes to contract_no_update when nothing changed.
   * Deterministic for the target owner date + source snapshot, host-derived and
   * digested so it carries no raw source terms, and never derived from batchId.
   */
  noUpdateScope: string;
}

/** The newest DONE wiki run, as the gate reads it. */
export interface WikiBaseline {
  /** Owner date the run covered, or null for a legacy/broken payload. */
  ownerDate: string | null;
  /** Source watermark the run captured, or null for a legacy/broken payload. */
  sourceWatermark: string | null;
  /**
   * The prior run's `range.end_ms` - the point business coverage actually
   * reached. The next same-day run resumes HERE, never at model completion time:
   * events that arrive between the prior input snapshot and model completion
   * fall in (coveredThroughMs, completedAt] and must not be skipped. Null for a
   * legacy/broken payload.
   */
  coveredThroughMs: number | null;
  /** Terminal transition time (telemetry only; never a source boundary). */
  completedAt: number;
}

export type WikiContinuityReason =
  | 'no-baseline'
  | 'new-owner-date'
  | 'delta'
  | 'no-change'
  | 'forced'
  | 'signal-unavailable';

export interface WikiContinuityDecision {
  enqueue: boolean;
  reason: WikiContinuityReason;
  /** The typed payload to enqueue; null exactly when `enqueue` is false. */
  payload: WikiPayload | null;
  warning: string | null;
}

export interface WikiContinuityInput {
  nowMs: number;
  /** Owner/host IANA time zone. */
  timeZone: string;
  /** Immutable authorized raw connector scope. */
  connectors: readonly string[];
  /** Trigger provenance (boot/hourly/extraction:completed/memory:promoted/manual). */
  trigger: string;
  /**
   * Composite watermark over connector observation, native owner tasks and
   * memory recency. Throwing means the signal is unavailable - the caller
   * enqueues anyway with a null watermark and the safe day-start range.
   */
  readSourceWatermark: () => string;
  /** Newest DONE wiki run, or null. */
  readBaseline: () => WikiBaseline | null;
  /** Manual/forced request bypasses the same-day skip gate. */
  forced?: boolean;
  /**
   * Manual backfill: a strict YYYY-MM-DD owner date. Malformed values throw.
   * Default is the current owner date.
   */
  requestedOwnerDate?: string;
}

/** The owner-local calendar date for an instant, in the owner IANA zone. */
export function ownerDateForInstant(nowMs: number, timeZone: string): string {
  return dateInIanaZone(nowMs, timeZone);
}

/**
 * Validate a caller-supplied owner date strictly: it must be an exact
 * YYYY-MM-DD that names a real calendar day. Rejects overflow (2026-13-40) and
 * unpadded forms (2026-9-5) so a missed date can be backfilled without trusting
 * caller-supplied timestamps.
 */
export function parseStrictOwnerDate(value: string): string {
  if (!OWNER_DATE_PATTERN.test(value)) {
    throw new Error(`owner date must be an exact YYYY-MM-DD, got: ${value}`);
  }
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`owner date is not a real calendar day: ${value}`);
  }
  return value;
}

/** The next calendar date after a YYYY-MM-DD label (pure date arithmetic). */
function nextCalendarDate(ownerDate: string): string {
  const ms = Date.parse(`${ownerDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid owner date: ${ownerDate}`);
  }
  return new Date(ms + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The [start, end) epoch-ms bounds of an owner-local day. DST-correct: the day
 * is 23h/25h across a transition, delegated to startOfTaskDate's binary search.
 */
export function ownerDayRange(ownerDate: string, timeZone: string): WikiRange {
  const start_ms = startOfTaskDate(ownerDate, null, timeZone);
  const end_ms = startOfTaskDate(nextCalendarDate(ownerDate), null, timeZone);
  return { start_ms, end_ms };
}

/**
 * Fold the input terms into one comparable watermark. A change in ANY term
 * changes the result; equality is all the gate ever asks. Oversized inputs are
 * digested so the string stays inside its payload field bound.
 */
export function composeWikiSourceWatermark(terms: readonly string[]): string {
  const canonical = terms.join('|');
  const readable = `w1:${canonical}`;
  if (readable.length <= WIKI_WATERMARK_MAX_LENGTH) return readable;
  return `w1h:${createHash('sha256').update(canonical, 'utf-8').digest('hex')}`;
}

/** The owner-day [dayStart, end_ms) bounds for a run: end is `nowMs` for the
 *  current date (bounded by day end), the target day end for a past date. */
function rangeBounds(
  ownerDate: string,
  currentOwnerDate: string,
  nowMs: number,
  timeZone: string
): { dayStart: number; end_ms: number } {
  const { start_ms: dayStart, end_ms: dayEnd } = ownerDayRange(ownerDate, timeZone);
  const end_ms = ownerDate === currentOwnerDate ? Math.min(nowMs, dayEnd) : dayEnd;
  return { dayStart, end_ms };
}

/**
 * Whether a baseline's coverage boundary can be RESUMED FROM (and can authorize
 * a skip). It must be the SAME owner day and its `coveredThroughMs` must fall
 * inside [dayStart, end_ms]. A null/out-of-day/future coveredThroughMs is
 * unusable even when the watermark text matches - resuming there would start the
 * next range at an invalid point, so the run must re-cover the whole day.
 */
function baselineCoverageUsable(
  baseline: WikiBaseline | null,
  ownerDate: string,
  dayStart: number,
  end_ms: number
): boolean {
  return (
    baseline !== null &&
    baseline.ownerDate === ownerDate &&
    baseline.coveredThroughMs !== null &&
    Number.isFinite(baseline.coveredThroughMs) &&
    baseline.coveredThroughMs >= dayStart &&
    baseline.coveredThroughMs <= end_ms
  );
}

/**
 * The range the turn reads. start_ms resumes at the prior run's usable
 * `coveredThroughMs`; otherwise it starts at the owner day boundary. Model
 * completion time is NEVER the source boundary. dayStart <= start_ms <= end_ms.
 */
function computeRange(
  ownerDate: string,
  currentOwnerDate: string,
  nowMs: number,
  timeZone: string,
  baseline: WikiBaseline | null
): WikiRange {
  const { dayStart, end_ms } = rangeBounds(ownerDate, currentOwnerDate, nowMs, timeZone);
  if (baselineCoverageUsable(baseline, ownerDate, dayStart, end_ms)) {
    return { start_ms: baseline!.coveredThroughMs as number, end_ms };
  }
  return { start_ms: dayStart, end_ms };
}

/**
 * The exact contract_no_update scope for a run: deterministic for the target
 * owner date and source snapshot, digested so no raw connector/task/memory term
 * leaks, and independent of batchId. A null watermark (signal unavailable) has
 * no snapshot to key on, so it uses an `:na` marker.
 */
export function wikiNoUpdateScope(ownerDate: string, sourceWatermark: string | null): string {
  if (sourceWatermark === null) return `wiki:${ownerDate}:na`;
  const digest = createHash('sha256').update(sourceWatermark, 'utf-8').digest('hex').slice(0, 16);
  return `wiki:${ownerDate}:${digest}`;
}

function buildPayload(
  input: WikiContinuityInput,
  ownerDate: string,
  range: WikiRange,
  sourceWatermark: string | null
): WikiPayload {
  return {
    batchId: `${input.nowMs}-${input.trigger}`,
    events: [input.trigger],
    ownerDate,
    range,
    taskUpdatedSince: new Date(range.start_ms).toISOString(),
    sourceWatermark,
    connectors: [...input.connectors],
    noUpdateScope: wikiNoUpdateScope(ownerDate, sourceWatermark),
  };
}

/**
 * Decide whether to enqueue a wiki run and, if so, the typed payload it carries.
 * A malformed manual owner date throws (loud rejection); every other uncertain
 * case enqueues.
 */
export function evaluateWikiContinuity(input: WikiContinuityInput): WikiContinuityDecision {
  const currentOwnerDate = ownerDateForInstant(input.nowMs, input.timeZone);
  let ownerDate: string;
  if (input.requestedOwnerDate !== undefined) {
    ownerDate = parseStrictOwnerDate(input.requestedOwnerDate);
    // A future owner date has no evidence yet and would produce a range past
    // now; only a missed CURRENT-or-past day can be backfilled.
    if (ownerDate > currentOwnerDate) {
      throw new Error(
        `wiki owner date ${ownerDate} is in the future (current owner date ${currentOwnerDate})`
      );
    }
  } else {
    ownerDate = currentOwnerDate;
  }

  let watermark: string;
  let baseline: WikiBaseline | null;
  try {
    watermark = input.readSourceWatermark();
    baseline = input.readBaseline();
  } catch (err) {
    // Signal unusable: enqueue with a null watermark and the safe day-start..now
    // range (no baseline to resume from).
    return {
      enqueue: true,
      reason: 'signal-unavailable',
      warning: err instanceof Error ? err.message : String(err),
      payload: buildPayload(
        input,
        ownerDate,
        computeRange(ownerDate, currentOwnerDate, input.nowMs, input.timeZone, null),
        null
      ),
    };
  }

  const range = computeRange(ownerDate, currentOwnerDate, input.nowMs, input.timeZone, baseline);
  const payload = buildPayload(input, ownerDate, range, watermark);

  if (input.forced === true) {
    return { enqueue: true, reason: 'forced', warning: null, payload };
  }
  if (baseline === null || baseline.ownerDate === null || baseline.sourceWatermark === null) {
    return { enqueue: true, reason: 'no-baseline', warning: null, payload };
  }
  if (baseline.ownerDate !== ownerDate) {
    return { enqueue: true, reason: 'new-owner-date', warning: null, payload };
  }
  // A skip is only safe when the baseline's coverage boundary is usable. A
  // matching watermark on a baseline with a null/out-of-day/future
  // coveredThroughMs must NOT authorize a skip - its coverage is unusable, so
  // the run enqueues from day start (treated as no-baseline).
  const { dayStart, end_ms } = rangeBounds(
    ownerDate,
    currentOwnerDate,
    input.nowMs,
    input.timeZone
  );
  if (!baselineCoverageUsable(baseline, ownerDate, dayStart, end_ms)) {
    return { enqueue: true, reason: 'no-baseline', warning: null, payload };
  }
  if (baseline.sourceWatermark !== watermark) {
    return { enqueue: true, reason: 'delta', warning: null, payload };
  }
  return { enqueue: false, reason: 'no-change', warning: null, payload: null };
}
