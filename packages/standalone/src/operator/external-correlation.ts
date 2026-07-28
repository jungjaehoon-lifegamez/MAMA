/**
 * Correlate native ledger rows with live external items - the join that has to exist
 * before any cross-store claim.
 *
 * The native ledger and the external board are separate stores with no shared key:
 * a row carries `source_channel` and `source_event_id`, never an external item id.
 * Left to itself a model joins on titles, which produces false, missed and ambiguous
 * matches and then reports them as fact. This module resolves the join the only way
 * that is deterministic - through recorded provenance - and labels everything it
 * cannot resolve so the caller can refuse to make a claim about it.
 *
 * `source_event_id` is NOT a foreign key. It is optional free-form text that a model
 * supplies on task_create, so every step validates rather than assumes: exact index
 * lookup, connector must match, external identifiers come from STRUCTURED metadata
 * (composite-id parsing only as a legacy fallback), and a disagreement between the
 * two is ambiguity, not a tie to break.
 *
 * H0b, the rule that costs the most when forgotten: an item missing from the live
 * snapshot proves NOTHING. The poller reads only open items and emits no tombstone,
 * so disappearance is archive, deletion, permission loss, a board move, or a partial
 * read - never evidence of completion. Absence resolves to `historical_only`, and no
 * outcome in this module ever means "done".
 */

export type CorrelationOutcome =
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'historical_only'
  | 'not_applicable';

export type CorrelationReason =
  /** not_applicable */
  | 'no_source'
  | 'other_connector'
  /** unmatched */
  | 'no_provenance'
  | 'provenance_not_indexed'
  | 'provenance_connector_mismatch'
  | 'external_ref_unresolvable'
  /** ambiguous */
  | 'provenance_conflict'
  | 'multiple_rows_one_item'
  /** historical_only */
  | 'absent_from_live_snapshot'
  | 'live_snapshot_incomplete'
  /** matched */
  | 'live_item';

export interface CorrelationLedgerRow {
  id: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
}

/** A connector_event_index row, reduced to what correlation needs. */
export interface ProvenanceRecord {
  sourceConnector: string;
  /** Connector-written composite identity, e.g. `<boardId>:<itemId>:<observedMs>`. */
  sourceId: string;
  metadata: Record<string, unknown> | null;
}

export interface LiveExternalItem {
  itemId: string;
  board: string;
  list: string;
}

export interface ExternalRef {
  boardId: string;
  itemId: string;
}

export interface CorrelationInput {
  /** Connector whose items are being correlated, e.g. 'trello'. */
  connector: string;
  rows: readonly CorrelationLedgerRow[];
  lookupProvenance: (eventIndexId: string) => ProvenanceRecord | null;
  liveItems: readonly LiveExternalItem[];
  /**
   * Whether the live snapshot covered everything it claims to.
   * When false, absence cannot even be called historical: a partial read is
   * indistinguishable from a vanished item, so nothing resolves to matched-by-absence.
   */
  liveSnapshotComplete: boolean;
}

export interface TaskCorrelation {
  taskId: number;
  outcome: CorrelationOutcome;
  reason: CorrelationReason;
  externalRef: ExternalRef | null;
  /** Present only for `matched`: the item's CURRENT position on the live board. */
  live: { board: string; list: string } | null;
}

export type CorrelationCoverage = Record<CorrelationOutcome, number> & { total: number };

export interface CorrelationResult {
  correlations: TaskCorrelation[];
  coverage: CorrelationCoverage;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Legacy fallback only: `<boardId>:<itemId>:<observedMs>`. Structured metadata wins. */
function parseCompositeSourceId(sourceId: string): ExternalRef | null {
  const parts = sourceId.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [boardId, itemId] = parts;
  return boardId && itemId ? { boardId, itemId } : null;
}

function resolveExternalRef(record: ProvenanceRecord): {
  ref: ExternalRef | null;
  conflict: boolean;
} {
  const composite = parseCompositeSourceId(record.sourceId);
  const boardId = readString(record.metadata, 'boardId');
  const itemId = readString(record.metadata, 'cardId') ?? readString(record.metadata, 'itemId');
  if (boardId && itemId) {
    const conflict =
      composite !== null && (composite.boardId !== boardId || composite.itemId !== itemId);
    return { ref: { boardId, itemId }, conflict };
  }
  return { ref: composite, conflict: false };
}

function classify(
  row: CorrelationLedgerRow,
  input: CorrelationInput,
  liveById: ReadonlyMap<string, LiveExternalItem>
): TaskCorrelation {
  const prefix = `${input.connector}:`;
  if (!row.sourceChannel) {
    return {
      taskId: row.id,
      outcome: 'not_applicable',
      reason: 'no_source',
      externalRef: null,
      live: null,
    };
  }
  if (!row.sourceChannel.startsWith(prefix)) {
    return {
      taskId: row.id,
      outcome: 'not_applicable',
      reason: 'other_connector',
      externalRef: null,
      live: null,
    };
  }
  if (!row.sourceEventId) {
    return {
      taskId: row.id,
      outcome: 'unmatched',
      reason: 'no_provenance',
      externalRef: null,
      live: null,
    };
  }

  const record = input.lookupProvenance(row.sourceEventId);
  if (!record) {
    return {
      taskId: row.id,
      outcome: 'unmatched',
      reason: 'provenance_not_indexed',
      externalRef: null,
      live: null,
    };
  }
  if (record.sourceConnector !== input.connector) {
    return {
      taskId: row.id,
      outcome: 'unmatched',
      reason: 'provenance_connector_mismatch',
      externalRef: null,
      live: null,
    };
  }

  const { ref, conflict } = resolveExternalRef(record);
  if (!ref) {
    return {
      taskId: row.id,
      outcome: 'unmatched',
      reason: 'external_ref_unresolvable',
      externalRef: null,
      live: null,
    };
  }
  if (conflict) {
    return {
      taskId: row.id,
      outcome: 'ambiguous',
      reason: 'provenance_conflict',
      externalRef: ref,
      live: null,
    };
  }

  const live = liveById.get(ref.itemId);
  if (live) {
    return {
      taskId: row.id,
      outcome: 'matched',
      reason: 'live_item',
      externalRef: ref,
      live: { board: live.board, list: live.list },
    };
  }
  return {
    taskId: row.id,
    outcome: 'historical_only',
    // A partial snapshot cannot even establish that the item is gone from the open set.
    reason: input.liveSnapshotComplete ? 'absent_from_live_snapshot' : 'live_snapshot_incomplete',
    externalRef: ref,
    live: null,
  };
}

/**
 * Resolve every row, then demote collisions: when several rows resolve to ONE external
 * item, no row among them can carry a factual claim about it, because which row the
 * item's state belongs to is exactly what is unknown.
 */
export function correlateTasksWithExternalItems(input: CorrelationInput): CorrelationResult {
  const liveById = new Map(input.liveItems.map((item) => [item.itemId, item]));
  const resolved = input.rows.map((row) => classify(row, input, liveById));

  const rowsByItem = new Map<string, number>();
  for (const correlation of resolved) {
    if (correlation.externalRef && correlation.outcome !== 'ambiguous') {
      const key = correlation.externalRef.itemId;
      rowsByItem.set(key, (rowsByItem.get(key) ?? 0) + 1);
    }
  }

  const correlations = resolved.map((correlation) => {
    if (
      correlation.externalRef &&
      correlation.outcome !== 'ambiguous' &&
      (rowsByItem.get(correlation.externalRef.itemId) ?? 0) > 1
    ) {
      return {
        ...correlation,
        outcome: 'ambiguous' as const,
        reason: 'multiple_rows_one_item' as const,
        live: null,
      };
    }
    return correlation;
  });

  const coverage: CorrelationCoverage = {
    total: correlations.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    historical_only: 0,
    not_applicable: 0,
  };
  for (const correlation of correlations) {
    coverage[correlation.outcome] += 1;
  }

  return { correlations, coverage };
}
