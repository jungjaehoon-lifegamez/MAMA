/**
 * The read side of the effect ledger: what this system changed, and on what evidence.
 *
 * Lives here rather than inside the gateway executor's switch so it can be tested against
 * a real ledger without standing up an agent. The first cut was written inline and its
 * tests drove everything EXCEPT the tool path, which is how a projection that could state
 * a falsehood passed seven green tests.
 *
 * The falsehood it could state: rows are capped, coverage is not. With 40 attributed and
 * 80 unattributed changes in a window, a default call returned 50 rows - all unattributed,
 * because the newest changes skew that way while `task_update` has no cause field - beside
 * a coverage count saying 40 were explainable, and nothing anywhere saying 120 matched. A
 * model reading its own output could truthfully report "nothing I did is explainable".
 *
 * So: the counts and the rows must describe the same population, the cap must be visible,
 * and a filter the caller misspells must fail loudly rather than return zero rows - "no
 * rows" and "nothing changed" are the same sentence to a reader, and only one of them is
 * ever true.
 */
import type { EffectQuery, EffectRecord, EffectTarget, CauseState } from '../evidence/effects.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Below this a window is not a window; it is a corrupted number reaching toISOString. */
const MIN_SINCE_MS = 0;

const TARGET_TYPES: readonly EffectTarget[] = ['task', 'report_slot', 'memory', 'wiki_page'];
const CAUSE_STATES: readonly CauseState[] = ['attributed', 'unattributed'];

export interface ChangesLedger {
  listChanges(query: EffectQuery): EffectRecord[];
  changeCoverage(
    sinceMs?: number,
    targetType?: EffectTarget
  ): { attributed: number; unattributed: number };
}

export interface ChangesReadInput {
  since?: unknown;
  target_type?: unknown;
  cause_state?: unknown;
  limit?: unknown;
}

export interface ChangesReadFailure {
  success: false;
  code: 'invalid_argument';
  error: string;
}

export interface ChangesReadResult {
  success: true;
  coverage: { attributed: number; unattributed: number };
  since: string;
  /** Changes matching the filter in the window - not the number returned. */
  total: number;
  returned: number;
  changes: Array<{
    kind: string;
    target_type: string;
    target_id: string;
    cause_state: string;
    /** What KIND of cause moved this - the rubric's cause-citation item reads it. */
    cause_kind: string;
    source_event_ids: string[];
    channel: string | null;
    run_id: string | null;
    at: string;
  }>;
}

/**
 * The window a read covers.
 *
 * Unparseable input falls back to the default and the resolved window is returned to the
 * caller, so whatever was asked for, what was actually read is stated. Non-string input is
 * not a window at all - a model emitting epoch milliseconds used to crash the tool on
 * `.trim()`.
 */
export function parseChangesSince(since: unknown, nowMs: number): number {
  const raw = typeof since === 'string' ? since.trim() : '';
  if (raw === '') return nowMs - DEFAULT_WINDOW_MS;

  // Minutes are here because a caller writing "30m" is entirely ordinary, and without
  // the unit it fell through to the 24-hour default - a window 48x wider than asked for.
  const relative = /^(\d+)\s*([dhm])$/i.exec(raw);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const unitMs = unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000;
    // Clamped: a window of 99999999999 days is not a request, and an unclamped one
    // produces a timestamp that throws on the way back out.
    return clampSince(nowMs - Number(relative[1]) * unitMs, nowMs);
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return nowMs - DEFAULT_WINDOW_MS;
  return clampSince(parsed, nowMs);
}

/** A future window returns nothing, and nothing reads as "nothing changed". */
function clampSince(sinceMs: number, nowMs: number): number {
  return Math.min(Math.max(sinceMs, MIN_SINCE_MS), nowMs);
}

function parseLimit(limit: unknown): number | ChangesReadFailure {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = typeof limit === 'string' ? Number(limit.trim()) : limit;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalid(`limit must be a positive whole number, got: ${String(limit)}`);
  }
  return Math.min(value, MAX_LIMIT);
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T | undefined | ChangesReadFailure {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  // Silently returning zero rows for a misspelt filter is the worst answer available:
  // it is indistinguishable from "nothing changed".
  return invalid(`${field} must be one of ${allowed.join(', ')}, got: ${String(value)}`);
}

function invalid(error: string): ChangesReadFailure {
  return { success: false, code: 'invalid_argument', error };
}

function isFailure(value: unknown): value is ChangesReadFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { success?: unknown }).success === false
  );
}

export function readChanges(
  ledger: ChangesLedger,
  input: ChangesReadInput,
  nowMs: number
): ChangesReadResult | ChangesReadFailure {
  const limit = parseLimit(input.limit);
  if (isFailure(limit)) return limit;
  const targetType = parseEnum(input.target_type, TARGET_TYPES, 'target_type');
  if (isFailure(targetType)) return targetType;
  const causeState = parseEnum(input.cause_state, CAUSE_STATES, 'cause_state');
  if (isFailure(causeState)) return causeState;

  const sinceMs = parseChangesSince(input.since, nowMs);
  // Coverage is the cause_state breakdown, so it answers within the SAME target scope the
  // rows were drawn from. It deliberately ignores cause_state: filtering the breakdown by
  // one of its own terms would report a zero that only means "I asked for the other one".
  const coverage = ledger.changeCoverage(sinceMs, targetType);
  const matching = coverage.attributed + coverage.unattributed;
  const total =
    causeState === undefined
      ? matching
      : causeState === 'attributed'
        ? coverage.attributed
        : coverage.unattributed;

  const changes = ledger.listChanges({ sinceMs, targetType, causeState, limit });

  return {
    success: true,
    coverage,
    since: new Date(sinceMs).toISOString(),
    total,
    returned: changes.length,
    changes: changes.map((change) => ({
      kind: change.kind,
      target_type: change.targetType,
      target_id: change.targetId,
      cause_state: change.causeState,
      cause_kind: change.causeKind,
      source_event_ids: change.sourceEventIds,
      channel: change.channelId,
      run_id: change.runId,
      at: new Date(change.atMs).toISOString(),
    })),
  };
}
