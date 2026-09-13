import type { DatabaseAdapter } from '../db-manager.js';
import { MEMORY_SCOPE_KINDS, type MemoryScopeKind } from '../memory/types.js';
import { mapConnectorEventIndexRecord } from './event-index.js';
import type {
  ConnectorEventIndexRecord,
  RawSearchHit,
  RawDocument,
  RawSearchInput,
  RawSearchResult,
  RawSearchScopeFilter,
} from './types.js';

type RawQueryAdapter = Pick<DatabaseAdapter, 'prepare'>;

interface RawCursor {
  rank: number;
  timestampMs: number;
  rawId: string;
}

interface RawSearchRow extends Record<string, unknown> {
  rank: number;
  capture_timestamp_ms: number;
  observation_observed_at: number | null;
}

interface RawWindowInput {
  connectors?: string[];
  scopes?: RawSearchScopeFilter[];
  before?: number;
  after?: number;
}

const DEFAULT_RAW_LIMIT = 25;
const MAX_RAW_LIMIT = 100;
const DEFAULT_WINDOW_SIZE = 5;
const MAX_WINDOW_SIZE = 50;
const VALID_SCOPE_KINDS = new Set<string>(MEMORY_SCOPE_KINDS);

function observationObservedAtSql(alias: string): string {
  return `(SELECT observation.observed_at FROM observation_versions observation
    WHERE observation.observation_id = ${alias}.current_observation_id)`;
}

function captureTimestampSql(alias: string): string {
  return `COALESCE(${observationObservedAtSql(alias)}, ${alias}.event_datetime, ${alias}.source_timestamp_ms)`;
}

function timingSelectSql(alias: string): string {
  return `${observationObservedAtSql(alias)} AS observation_observed_at,
    ${captureTimestampSql(alias)} AS capture_timestamp_ms`;
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL placeholders for an empty list.');
  }
  return values.map(() => '?').join(', ');
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_RAW_LIMIT;
  }
  return Math.min(MAX_RAW_LIMIT, Math.max(0, Math.floor(value)));
}

function normalizeWindowSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WINDOW_SIZE;
  }
  return Math.min(MAX_WINDOW_SIZE, Math.max(0, Math.floor(value)));
}

function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

function encodeCursor(row: {
  rank: number;
  capture_timestamp_ms: number;
  event_index_id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      rank: row.rank,
      timestampMs: row.capture_timestamp_ms,
      rawId: row.event_index_id,
    }),
    'utf8'
  ).toString('base64url');
}

function decodeCursor(cursor: string | undefined): RawCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as Partial<RawCursor>;
    if (
      typeof parsed.rank !== 'number' ||
      !Number.isFinite(parsed.rank) ||
      typeof parsed.timestampMs !== 'number' ||
      !Number.isFinite(parsed.timestampMs) ||
      typeof parsed.rawId !== 'string' ||
      parsed.rawId.length === 0
    ) {
      throw new Error('invalid shape');
    }
    return {
      rank: parsed.rank,
      timestampMs: parsed.timestampMs,
      rawId: parsed.rawId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid raw search cursor: ${message}`);
  }
}

function normalizeConnectors(connectors: string[] | undefined): string[] {
  return [...new Set((connectors ?? []).map((connector) => connector.trim()).filter(Boolean))];
}

function normalizeScopes(scopes: RawSearchScopeFilter[] | undefined): RawSearchScopeFilter[] {
  return (scopes ?? [])
    .map((scope) => {
      const kind = scope.kind.trim();
      if (!VALID_SCOPE_KINDS.has(kind)) {
        throw new Error(`Invalid raw search scope kind: ${kind}`);
      }
      return { kind: kind as MemoryScopeKind, id: scope.id.trim() };
    })
    .filter((scope) => scope.id.length > 0);
}

function appendFilters(
  clauses: string[],
  params: unknown[],
  input: RawSearchInput,
  alias = 'e',
  timestampSql = `${alias}.source_timestamp_ms`
): void {
  const connectors = normalizeConnectors(input.connectors);
  if (connectors.length > 0) {
    clauses.push(`${alias}.source_connector IN (${placeholders(connectors)})`);
    params.push(...connectors);
  }

  const scopes = normalizeScopes(input.scopes);
  if (scopes.length > 0) {
    clauses.push(
      `(${scopes.map(() => `(${alias}.memory_scope_kind = ? AND ${alias}.memory_scope_id = ?)`).join(' OR ')})`
    );
    for (const scope of scopes) {
      params.push(scope.kind, scope.id);
    }
  }

  if (input.fromMs !== undefined) {
    clauses.push(`${timestampSql} >= ?`);
    params.push(input.fromMs);
  }
  if (input.toMs !== undefined) {
    clauses.push(`${timestampSql} <= ?`);
    params.push(input.toMs);
  }
}

function appendCursorFilter(clauses: string[], params: unknown[], cursor: RawCursor | null): void {
  if (!cursor) {
    return;
  }
  clauses.push(
    `(rank > ? OR (rank = ? AND capture_timestamp_ms < ?) OR ` +
      `(rank = ? AND capture_timestamp_ms = ? AND event_index_id > ?))`
  );
  params.push(
    cursor.rank,
    cursor.rank,
    cursor.timestampMs,
    cursor.rank,
    cursor.timestampMs,
    cursor.rawId
  );
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`connector_event_index.metadata_json is malformed: ${message}`);
  }
}

function contentPreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function scoreFromRank(rank: number): number {
  return Number.isFinite(rank) ? 1 / (1 + Math.exp(rank)) : 0;
}

function timestampToIso(timestampMs: number | null): string | null {
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

function toRawHit(row: RawSearchRow): RawSearchHit {
  const record = mapConnectorEventIndexRecord(row) as ConnectorEventIndexRecord;
  return {
    raw_id: record.event_index_id,
    connector: record.source_connector,
    source_id: record.source_id,
    channel_id: record.channel,
    author_label: record.author,
    created_at: timestampToIso(
      typeof row.capture_timestamp_ms === 'number'
        ? row.capture_timestamp_ms
        : (record.event_datetime ?? record.source_timestamp_ms)
    ),
    source_at: timestampToIso(record.event_datetime ?? record.source_timestamp_ms),
    observed_at: timestampToIso(
      typeof row.observation_observed_at === 'number' ? row.observation_observed_at : null
    ),
    content_preview: contentPreview(record.content),
    score: scoreFromRank(Number(row.rank)),
    source_ref: record.source_locator ?? record.artifact_locator,
    metadata: parseMetadata(record.metadata_json),
    observation_ref: record.current_observation_id,
  };
}

function assertObservationRefsConsistent(
  adapter: RawQueryAdapter,
  rows: readonly RawSearchRow[]
): void {
  const refs = [
    ...new Set(
      rows
        .map((row) => row.current_observation_id)
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    ),
  ];
  if (refs.length === 0) {
    return;
  }
  const found = adapter
    .prepare(
      `SELECT observation_id FROM observation_versions
       WHERE observation_id IN (${placeholders(refs)})`
    )
    .all(...refs) as Array<{ observation_id: string }>;
  if (found.length !== refs.length) {
    throw new Error('connector_event_index contains an inconsistent current observation ref');
  }
}

function runSearch(adapter: RawQueryAdapter, input: RawSearchInput): RawSearchResult {
  const query = input.query.trim();
  if (query.length === 0) {
    return { hits: [], next_cursor: null };
  }

  const limit = normalizeLimit(input.limit);
  if (limit === 0) {
    return { hits: [], next_cursor: null };
  }

  const params: unknown[] = [escapeFtsQuery(query)];
  const clauses: string[] = [];
  const captureTime = captureTimestampSql('e');
  appendFilters(clauses, params, input, 'e', captureTime);
  const cursor = decodeCursor(input.cursor);

  const outerClauses: string[] = [];
  const outerParams: unknown[] = [];
  appendCursorFilter(outerClauses, outerParams, cursor);
  const whereSql = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
  const cursorSql = outerClauses.length > 0 ? `WHERE ${outerClauses.join(' AND ')}` : '';
  const rows = adapter
    .prepare(
      `
        WITH ranked AS (
          SELECT e.*, o.observed_at AS observation_observed_at,
                 ${captureTime} AS capture_timestamp_ms,
                 bm25(connector_event_index_fts) AS rank
          FROM connector_event_index_fts
          JOIN connector_event_index e
            ON e.event_index_id = connector_event_index_fts.event_index_id
          LEFT JOIN observation_versions o
            ON o.observation_id = e.current_observation_id
          WHERE connector_event_index_fts MATCH ?
            ${whereSql}
        )
        SELECT *
        FROM ranked
        ${cursorSql}
        ORDER BY rank ASC, capture_timestamp_ms DESC, event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params, ...outerParams, limit + 1) as RawSearchRow[];

  const pageRows = rows.slice(0, limit);
  assertObservationRefsConsistent(adapter, pageRows);
  const nextRow = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;

  return {
    hits: pageRows.map(toRawHit),
    next_cursor: nextRow
      ? encodeCursor({
          rank: Number(nextRow.rank),
          capture_timestamp_ms: Number(nextRow.capture_timestamp_ms),
          event_index_id: String(nextRow.event_index_id),
        })
      : null,
  };
}

export function searchRaw(adapter: RawQueryAdapter, input: RawSearchInput): RawSearchResult {
  const connectors = normalizeConnectors(input.connectors);
  if (connectors.length !== 1) {
    throw new Error('searchRaw requires exactly one connector filter.');
  }
  return runSearch(adapter, { ...input, connectors });
}

export function searchAllRaw(adapter: RawQueryAdapter, input: RawSearchInput): RawSearchResult {
  return runSearch(adapter, input);
}

export function getRawById(
  adapter: RawQueryAdapter,
  rawId: string,
  visibility: Pick<RawSearchInput, 'connectors' | 'scopes'>
): RawDocument | null {
  const params: unknown[] = [rawId];
  const clauses = ['e.event_index_id = ?'];
  appendFilters(clauses, params, { query: '*', ...visibility });
  const row = adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank, ${timingSelectSql('e')}
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        LIMIT 1
      `
    )
    .get(...params) as RawSearchRow | undefined;

  if (!row) {
    return null;
  }
  assertObservationRefsConsistent(adapter, [row]);
  return { ...toRawHit(row), content: String(row.content) };
}

export function getRawWindow(
  adapter: RawQueryAdapter,
  rawId: string,
  input: RawWindowInput
): { target: RawSearchHit; items: RawSearchHit[] } | null {
  const targetParams: unknown[] = [rawId];
  const targetClauses = ['e.event_index_id = ?'];
  appendFilters(targetClauses, targetParams, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
  });
  const targetRow = adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank, ${timingSelectSql('e')}
        FROM connector_event_index e
        WHERE ${targetClauses.join(' AND ')}
        LIMIT 1
      `
    )
    .get(...targetParams) as RawSearchRow | undefined;

  if (!targetRow) {
    return null;
  }

  const before = normalizeWindowSize(input.before);
  const after = normalizeWindowSize(input.after);
  const beforeRows = beforeWindowRows(adapter, targetRow, input, before);
  const afterRows = afterWindowRows(adapter, targetRow, input, after);
  assertObservationRefsConsistent(adapter, [targetRow, ...beforeRows, ...afterRows]);
  const targetHit = toRawHit(targetRow);

  return {
    target: targetHit,
    items: [...beforeRows.reverse().map(toRawHit), targetHit, ...afterRows.map(toRawHit)],
  };
}

function beforeWindowRows(
  adapter: RawQueryAdapter,
  target: RawSearchRow,
  input: RawWindowInput,
  limit: number
): RawSearchRow[] {
  if (limit === 0) {
    return [];
  }
  const targetRecord = mapConnectorEventIndexRecord(target);
  const captureTime = captureTimestampSql('e');
  const targetCaptureTime = Number(target.capture_timestamp_ms);
  const params: unknown[] = [
    targetRecord.source_connector,
    targetRecord.channel,
    targetCaptureTime,
    targetCaptureTime,
    targetRecord.event_index_id,
  ];
  const clauses = [
    'e.source_connector = ?',
    targetRecord.channel === null ? 'e.channel IS ?' : 'e.channel = ?',
    `(${captureTime} < ? OR (${captureTime} = ? AND e.event_index_id < ?))`,
  ];
  appendFilters(clauses, params, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank, ${timingSelectSql('e')}
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        ORDER BY capture_timestamp_ms DESC, e.event_index_id DESC
        LIMIT ?
      `
    )
    .all(...params, limit) as RawSearchRow[];
}

function afterWindowRows(
  adapter: RawQueryAdapter,
  target: RawSearchRow,
  input: RawWindowInput,
  limit: number
): RawSearchRow[] {
  if (limit === 0) {
    return [];
  }
  const targetRecord = mapConnectorEventIndexRecord(target);
  const captureTime = captureTimestampSql('e');
  const targetCaptureTime = Number(target.capture_timestamp_ms);
  const params: unknown[] = [
    targetRecord.source_connector,
    targetRecord.channel,
    targetCaptureTime,
    targetCaptureTime,
    targetRecord.event_index_id,
  ];
  const clauses = [
    'e.source_connector = ?',
    targetRecord.channel === null ? 'e.channel IS ?' : 'e.channel = ?',
    `(${captureTime} > ? OR (${captureTime} = ? AND e.event_index_id > ?))`,
  ];
  appendFilters(clauses, params, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank, ${timingSelectSql('e')}
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        ORDER BY capture_timestamp_ms ASC, e.event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params, limit) as RawSearchRow[];
}

interface RawHistoryCursor {
  timestampMs: number;
  rawId: string;
}

export interface RawHistoryInput {
  /** The entity whose revisions to read. Provide this OR `rawId`. */
  entityId?: string;
  /**
   * A raw event id (event_index_id) to anchor on: its entity is resolved under the SAME
   * visibility, then that entity's revisions are returned. An anchor the caller may not see
   * resolves to nothing, so a rawId cannot widen what the caller can read.
   */
  rawId?: string;
  connectors?: string[];
  scopes?: RawSearchScopeFilter[];
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string;
}

interface EntityAnchor {
  entityId: string;
  connector: string;
}

// The entity a raw event belongs to, plus its connector. source_entity_id is unique only WITHIN a
// connector, so history must carry the connector too or two connectors sharing an id would merge.
function resolveEntityAnchor(
  adapter: RawQueryAdapter,
  rawId: string,
  visibility: Pick<RawSearchInput, 'connectors' | 'scopes'>
): EntityAnchor | null {
  const clauses = ['e.event_index_id = ?'];
  const params: unknown[] = [rawId];
  appendFilters(clauses, params, { query: '*', ...visibility });
  const row = adapter
    .prepare(
      `SELECT source_entity_id, source_connector FROM connector_event_index e WHERE ${clauses.join(
        ' AND '
      )} LIMIT 1`
    )
    .get(...params) as { source_entity_id: string | null; source_connector: string } | undefined;
  return row &&
    typeof row.source_entity_id === 'string' &&
    row.source_entity_id.length > 0 &&
    typeof row.source_connector === 'string' &&
    row.source_connector.length > 0
    ? { entityId: row.source_entity_id, connector: row.source_connector }
    : null;
}

function singleConnector(connectors: string[] | undefined): string | null {
  const normalized = normalizeConnectors(connectors);
  return normalized.length === 1 ? normalized[0]! : null;
}

function encodeHistoryCursor(row: {
  capture_timestamp_ms: number;
  event_index_id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ timestampMs: row.capture_timestamp_ms, rawId: row.event_index_id }),
    'utf8'
  ).toString('base64url');
}

function decodeHistoryCursor(cursor: string | undefined): RawHistoryCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as Partial<RawHistoryCursor>;
    if (
      typeof parsed.timestampMs !== 'number' ||
      !Number.isFinite(parsed.timestampMs) ||
      typeof parsed.rawId !== 'string' ||
      parsed.rawId.length === 0
    ) {
      throw new Error('invalid shape');
    }
    return { timestampMs: parsed.timestampMs, rawId: parsed.rawId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid raw history cursor: ${message}`);
  }
}

/**
 * Chronological change history of one upstream entity (rows sharing source_entity_id), bounded by
 * the SAME connector/scope visibility as search - a citation must not out-read reading. Oldest first,
 * cursor-paged. Rows with a NULL source_entity_id (no revision grouping) never match an entity query.
 */
export function getRawHistory(adapter: RawQueryAdapter, input: RawHistoryInput): RawSearchResult {
  // Revision identity is connector-scoped. The rawId path takes the anchor's own connector; the
  // entityId path requires the caller to name exactly one connector, since an entity id alone is
  // ambiguous across connectors.
  const trimmedEntityId = input.entityId?.trim() ?? '';
  const anchor: EntityAnchor | null =
    trimmedEntityId.length > 0
      ? (() => {
          const connector = singleConnector(input.connectors);
          return connector ? { entityId: trimmedEntityId, connector } : null;
        })()
      : input.rawId && input.rawId.trim().length > 0
        ? resolveEntityAnchor(adapter, input.rawId.trim(), {
            connectors: input.connectors,
            scopes: input.scopes,
          })
        : null;
  if (!anchor) {
    return { hits: [], next_cursor: null };
  }
  const limit = normalizeLimit(input.limit);
  if (limit === 0) {
    return { hits: [], next_cursor: null };
  }

  const clauses = ['e.source_entity_id = ?'];
  const params: unknown[] = [anchor.entityId];
  const captureTime = captureTimestampSql('e');
  appendFilters(
    clauses,
    params,
    {
      query: '*',
      connectors: [anchor.connector],
      scopes: input.scopes,
      fromMs: input.fromMs,
      toMs: input.toMs,
    },
    'e',
    captureTime
  );

  const cursor = decodeHistoryCursor(input.cursor);
  if (cursor) {
    clauses.push(`(${captureTime} > ? OR (${captureTime} = ? AND e.event_index_id > ?))`);
    params.push(cursor.timestampMs, cursor.timestampMs, cursor.rawId);
  }

  const rows = adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank, ${timingSelectSql('e')}
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        ORDER BY capture_timestamp_ms ASC, e.event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params, limit + 1) as RawSearchRow[];

  const pageRows = rows.slice(0, limit);
  assertObservationRefsConsistent(adapter, pageRows);
  const nextRow = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;

  return {
    hits: pageRows.map(toRawHit),
    next_cursor: nextRow
      ? encodeHistoryCursor({
          capture_timestamp_ms: Number(nextRow.capture_timestamp_ms),
          event_index_id: String(nextRow.event_index_id),
        })
      : null,
  };
}

export type {
  RawSearchHit,
  RawSearchInput,
  RawSearchResult,
  RawSearchScopeFilter,
} from './types.js';
