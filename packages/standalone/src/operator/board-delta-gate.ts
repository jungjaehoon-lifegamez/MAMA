/**
 * Delta gate for the SCHEDULED full-board producer (Fix E).
 *
 * The 30-minute producer enqueued a fresh-session board workorder on every
 * tick, so a quiet day still bought 48 full runs. This gate answers one
 * host-side question before the enqueue: has anything the board actually READS
 * moved since the last completed full run that demonstrably published a board?
 *
 * WHAT THE WATERMARK COVERS, and why each term is the column it is:
 *  - connectors: per-connector high-water mark of
 *    `connector_event_index.operator_observation_seq`. It is the only column
 *    that moves exactly when connector inputs move. `updated_at` is bumped by
 *    every re-poll upsert even for identical content; `indexed_at` is
 *    insert-only and misses edits to an already-indexed row.
 *    `operator_observation_seq` is nulled-and-reassigned precisely on
 *    content/metadata/timestamp/type/channel change (mama-core
 *    connectors/event-index.ts upsert + migration 062 triggers). It is
 *    per-source_connector, hence one entry per connector.
 *  - tasks: the NATIVE ledger's owner rows - the pipeline slot's projection
 *    source (`task_list`, board-slot-instructions.ts). Supplied by
 *    TaskLedger.ownerTaskTerm(); nothing about a native task touches
 *    connector_event_index.
 *  - memory: `MAX(rowid)` over `decisions` - the brief's recency check
 *    (`mama_search` with no query, compare created_at). A save always inserts.
 *
 * REMOVED (owner decision 2026-09-09): the agent-notice term. That ring is
 * in-memory on the event bus, so it reset on every restart, read as a delta and
 * bought one full run per boot - the same boot-forcing the repair gate's
 * bootDirty did, and the reason the owner's first message after a restart waited
 * on a maintenance turn. A term that cannot survive a process boundary cannot be
 * a delta signal. The cost is stated rather than hidden: an agent notice alone
 * no longer wakes the board.
 *
 * NOT COVERED, stated rather than hidden: anything the board reads that moves
 * none of the three terms - agent notices, report slots edited out of band,
 * connector rows deleted by retention, config/persona changes, and any future
 * board input.
 * Two independent escapes bound that blind spot: a run is never skipped while
 * the last completed full run has no PUBLISHED board behind it, and never
 * skipped once that run is older than DEFAULT_BOARD_FULL_MAX_STALENESS_MS.
 *
 * Availability beats the token saving: any broken or missing signal enqueues
 * as before and logs a warning.
 *
 * The gate also decides HOW the enqueued run works (owner decision 2026-09-09). When there is a
 * PUBLISHED board behind the baseline, the run is a `delta`: it edits that board from the
 * accumulated state, anchored to the board's publish time. Only the cases with no trustworthy
 * published board to edit - no baseline, unpublished, unreadable signal, owner-forced rebuild -
 * still rebuild from the sources.
 */

import { createHash } from 'node:crypto';

/** Bound on a watermark string, matching the workorder payload field bound. */
export const BOARD_DELTA_WATERMARK_MAX_LENGTH = 1000;

/**
 * Hard ceiling on how long the gate may keep skipping. Any signal blind spot
 * can starve the board for at most this long.
 */
export const DEFAULT_BOARD_FULL_MAX_STALENESS_MS = 2 * 60 * 60 * 1000;

/** Minimal structural DB interface - satisfied by the standalone sqlite wrapper
 *  and by the mama-core adapter returned from getAdapter(). */
export interface BoardDeltaDbLike {
  prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
}

interface ConnectorTermRow {
  connector: string;
  seq: number | null;
}

/**
 * Connector observation term. Throws when the index is unavailable - the
 * caller turns that into a warning plus an enqueue.
 */
export function connectorObservationTerm(db: BoardDeltaDbLike): string {
  const rows = db
    .prepare(
      `SELECT source_connector AS connector, MAX(operator_observation_seq) AS seq
         FROM connector_event_index
        WHERE operator_observation_seq IS NOT NULL
        GROUP BY source_connector
        ORDER BY source_connector ASC`
    )
    .all() as ConnectorTermRow[];
  return `c:${rows.map((row) => `${row.connector}=${String(row.seq)}`).join(',')}`;
}

/** Memory recency term: a save or an evolution always inserts a decision row. */
export function memoryRecencyTerm(db: BoardDeltaDbLike): string {
  const rows = db
    .prepare(`SELECT MAX(rowid) AS max_rowid, COUNT(*) AS n FROM decisions`)
    .all() as Array<{ max_rowid: number | null; n: number }>;
  const row = rows[0];
  return `m:${String(row?.max_rowid ?? 0)}/${String(row?.n ?? 0)}`;
}

/**
 * Fold the input terms into one comparable watermark. A change in ANY term
 * changes the result; nothing else about the string is meaningful to the gate.
 */
export function composeBoardInputWatermark(terms: readonly string[]): string {
  const canonical = terms.join('|');
  const readable = `v2:${canonical}`;
  if (readable.length <= BOARD_DELTA_WATERMARK_MAX_LENGTH) return readable;
  // Keep the field inside its payload bound. Equality is all the gate ever
  // asks of a watermark, so a digest answers the same question.
  return `v2h:${createHash('sha256').update(canonical, 'utf-8').digest('hex')}`;
}

/** The newest completed full board run, as the gate needs to read it. */
export interface BoardFullBaseline {
  /** Watermark the run captured before it was enqueued (null when it captured none). */
  watermark: string | null;
  /** Enqueue time - anything the run published landed at or after this. */
  createdAt: number;
  /** Terminal transition time - what the staleness bound measures from. */
  completedAt: number;
}

export type BoardFullDeltaReason =
  | 'no-baseline'
  | 'unpublished'
  | 'stale'
  | 'delta'
  | 'no-delta'
  | 'signal-unavailable';

/**
 * How the enqueued run must work.
 *
 * `full` rebuilds the board from the sources. `delta` UPDATES the published board from the
 * accumulated state (owner decision 2026-09-09): a run that has a published baseline behind it
 * already has the judgment of every event since - the owner-event turns wrote it into the task
 * ledger - so re-reading raw connector data is re-judging what was already judged. Only the
 * cases where there is no trustworthy published board to edit stay `full`.
 */
export type BoardRunMode = 'full' | 'delta';

export interface BoardFullDeltaDecision {
  enqueue: boolean;
  /** Watermark to carry on the workorder; null when the signal was unusable. */
  watermark: string | null;
  reason: BoardFullDeltaReason;
  /** `delta` only when a PUBLISHED baseline exists to edit; `full` otherwise. */
  mode: BoardRunMode;
  /**
   * The published board's write time (epoch ms) the delta run is anchored to; null whenever
   * the mode is `full` (there is nothing published to anchor on, or we could not read it).
   */
  anchorPublishedAt: number | null;
  warning: string | null;
}

export interface BoardFullDeltaInput {
  /** Current composite watermark over everything the board reads. */
  readWatermark: () => string;
  /** The newest completed full board run, or null. */
  readBaseline: () => BoardFullBaseline | null;
  /**
   * When the board slots were last written (0 = never). Evidence that a run
   * actually rebuilt the board, as opposed to merely reaching 'done': an
   * unverified full run reaches 'done' too, and its watermark must not license
   * a skip.
   */
  readBoardPublishedAt: () => number;
  now?: () => number;
  maxStalenessMs?: number;
}

/**
 * Decide whether the scheduled full-board producer has anything to enqueue.
 * Every uncertain case resolves to `enqueue: true`.
 */
export function evaluateBoardFullDelta(input: BoardFullDeltaInput): BoardFullDeltaDecision {
  const now = input.now ?? Date.now;
  const maxStalenessMs = input.maxStalenessMs ?? DEFAULT_BOARD_FULL_MAX_STALENESS_MS;
  let watermark: string;
  let baseline: BoardFullBaseline | null;
  let publishedAt: number;
  try {
    watermark = input.readWatermark();
    baseline = input.readBaseline();
    publishedAt = input.readBoardPublishedAt();
  } catch (err) {
    return {
      enqueue: true,
      watermark: null,
      reason: 'signal-unavailable',
      // A run whose input signal we could not read cannot be anchored either: it rebuilds.
      mode: 'full',
      anchorPublishedAt: null,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
  /**
   * Whether there is a published board to EDIT, as opposed to one to rebuild. The same
   * evidence 'unpublished' rests on: a run that reached 'done' without writing the slots left
   * nothing a delta turn could anchor on.
   */
  const published = baseline !== null && publishedAt >= baseline.createdAt;
  const anchored = <R extends BoardFullDeltaReason>(reason: R): BoardFullDeltaDecision => ({
    enqueue: true,
    watermark,
    reason,
    mode: published ? 'delta' : 'full',
    anchorPublishedAt: published ? publishedAt : null,
    warning: null,
  });
  if (baseline === null || baseline.watermark === null) {
    return {
      enqueue: true,
      watermark,
      reason: 'no-baseline',
      mode: 'full',
      anchorPublishedAt: null,
      warning: null,
    };
  }
  // The INPUT delta is asked first, before the evidence-about-the-board reasons.
  // 'unpublished' used to win here, and the caller requires in-memory dirt to agree with
  // that one reason - so a real input delta arriving after an honestly-empty (and therefore
  // permanently unpublished) full run was suppressed until the 2h staleness bound. A moved
  // watermark is the strongest signal the gate has; it must not be reported as a weaker one.
  if (baseline.watermark !== watermark) {
    return anchored('delta');
  }
  if (!published) {
    return {
      enqueue: true,
      watermark,
      reason: 'unpublished',
      mode: 'full',
      anchorPublishedAt: null,
      warning: null,
    };
  }
  if (now() - baseline.completedAt >= maxStalenessMs) {
    return anchored('stale');
  }
  return {
    enqueue: false,
    watermark,
    reason: 'no-delta',
    mode: 'full',
    anchorPublishedAt: null,
    warning: null,
  };
}
