import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import { readObservationEmbeddings } from '@jungjaehoon/mama-core/knowledge';
import { MEMORY_SCOPE_KINDS, type MemoryScopeKind } from '@jungjaehoon/mama-core/memory/types';
import { mapConnectorEventIndexRecord } from './event-index.js';
import type {
  ConnectorEventIndexRecord,
  RawSearchHit,
  RawDocument,
  RawSearchInput,
  RawSearchResult,
  RawSearchScopeFilter,
} from './connector-event-types.js';

type RawQueryAdapter = Pick<DatabaseAdapter, 'prepare'>;

interface RawCursor {
  captureTimeMs: number;
  rawId: string;
  maxSourceMs: number | null;
}

interface RawListCursor {
  sourceTimeMs: number;
  rawId: string;
  observedUpperMs: number;
  maxSourceMs: number | null;
}

interface RawSearchRow extends Record<string, unknown> {
  capture_timestamp_ms: number;
  observation_observed_at: number | null;
}

interface RawWindowInput {
  connectors?: string[];
  scopes?: RawSearchScopeFilter[];
  before?: number;
  after?: number;
  maxSourceMs?: number | null;
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

function normalizeMaxSourceMs(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('maxSourceMs must be a nonnegative epoch-millisecond integer');
  }
  return value;
}

function substringPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function encodeCursor(row: {
  capture_timestamp_ms: number;
  event_index_id: string;
  maxSourceMs: number | null;
}): string {
  return Buffer.from(
    JSON.stringify({
      captureTimeMs: row.capture_timestamp_ms,
      rawId: row.event_index_id,
      maxSourceMs: row.maxSourceMs,
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
      typeof parsed.captureTimeMs !== 'number' ||
      !Number.isFinite(parsed.captureTimeMs) ||
      typeof parsed.rawId !== 'string' ||
      parsed.rawId.length === 0
    ) {
      throw new Error('invalid shape');
    }
    return {
      captureTimeMs: parsed.captureTimeMs,
      rawId: parsed.rawId,
      maxSourceMs: normalizeMaxSourceMs(parsed.maxSourceMs),
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

  const channels = [
    ...new Set((input.channels ?? []).map((channel) => channel.trim()).filter(Boolean)),
  ];
  if (input.channels !== undefined && channels.length === 0) {
    throw new Error('Raw channel filter must contain at least one channel');
  }
  if (channels.length > 0) {
    clauses.push(`${alias}.channel IN (${placeholders(channels)})`);
    params.push(...channels);
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
  const maxSourceMs = normalizeMaxSourceMs(input.maxSourceMs);
  if (maxSourceMs !== null) {
    clauses.push(`COALESCE(${alias}.event_datetime, ${alias}.source_timestamp_ms) <= ?`);
    params.push(maxSourceMs);
  }
}

function assertCursorCeiling(
  cursor: { maxSourceMs: number | null },
  input: Pick<RawSearchInput, 'maxSourceMs'>
): void {
  if (cursor.maxSourceMs !== normalizeMaxSourceMs(input.maxSourceMs)) {
    throw new Error('Raw cursor source-time ceiling changed');
  }
}

function appendCursorFilter(clauses: string[], params: unknown[], cursor: RawCursor | null): void {
  if (!cursor) {
    return;
  }
  clauses.push(`(capture_timestamp_ms < ? OR (capture_timestamp_ms = ? AND event_index_id > ?))`);
  params.push(cursor.captureTimeMs, cursor.captureTimeMs, cursor.rawId);
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

function timestampToIso(timestampMs: number | null): string | null {
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

function toRawHit(row: RawSearchRow): RawSearchHit {
  const record = mapConnectorEventIndexRecord(row) as ConnectorEventIndexRecord;
  return {
    // A raw id names the observation. That is what a citation resolves against
    // (`raw:<connector>:<id>` -> observation_versions), so handing out the index's
    // own id would let a reader cite something provenance cannot find.
    raw_id: record.current_observation_id ?? '',
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
    // Substring hits have equal weight, as unranked browse results already did.
    score: 0.5,
    source_ref: record.source_locator ?? record.artifact_locator,
    metadata: parseMetadata(record.metadata_json),
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

  const params: unknown[] = [];
  const clauses: string[] = [];
  for (const term of query.split(/\s+/)) {
    clauses.push(
      `(${['title', 'content', 'author', 'channel']
        .map((field) => `e.${field} LIKE ? ESCAPE '\\'`)
        .join(' OR ')})`
    );
    const pattern = substringPattern(term);
    params.push(pattern, pattern, pattern, pattern);
  }
  const captureTime = captureTimestampSql('e');
  // from/to name when something was said, as in listRaw; capture time only orders and pages.
  appendFilters(clauses, params, input, 'e', 'COALESCE(e.event_datetime, e.source_timestamp_ms)');
  const cursor = decodeCursor(input.cursor);
  if (cursor) assertCursorCeiling(cursor, input);

  const outerClauses: string[] = [];
  const outerParams: unknown[] = [];
  appendCursorFilter(outerClauses, outerParams, cursor);
  const cursorSql = outerClauses.length > 0 ? `WHERE ${outerClauses.join(' AND ')}` : '';
  const rows = adapter
    .prepare(
      `
        WITH matched AS (
          SELECT e.*, o.observed_at AS observation_observed_at,
                 ${captureTime} AS capture_timestamp_ms
          FROM connector_event_index e
          LEFT JOIN observation_versions o
            ON o.observation_id = e.current_observation_id
          WHERE ${clauses.join(' AND ')}
        )
        SELECT *
        FROM matched
        ${cursorSql}
        ORDER BY capture_timestamp_ms DESC, event_index_id ASC
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
          capture_timestamp_ms: Number(nextRow.capture_timestamp_ms),
          event_index_id: String(nextRow.event_index_id),
          maxSourceMs: normalizeMaxSourceMs(input.maxSourceMs),
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

export interface RawMeaningOptions {
  limit: number;
  /**
   * How far above the query's mean similarity over the filtered messages, in standard deviations,
   * a hit must stand. e5 places every text in a narrow cone, so one absolute floor cannot separate
   * a related message from the rest; each query is measured against its own scores. With n
   * embedded messages under the filters no hit can stand more than (n - 1) / sqrt(n) above the
   * mean, so a floor of 2.5 needs at least 9; a narrower filter returns text hits only.
   */
  minZ: number;
  /** Observation ids already returned by the text search. */
  exclude?: ReadonlySet<string>;
}

/**
 * The observations nearest in meaning to a query vector, under the same filters as searchRaw: one
 * connector, channels, scopes, time and the replay read ceiling. A message about the same thing
 * in another language or spelling scores close to the query though no term matches as text. Only
 * observations that already have a vector are considered; each hit's score is its similarity
 * (e5 vectors are normalized, so a dot product).
 */
export function meaningSearchRaw(
  adapter: RawQueryAdapter,
  input: Omit<RawSearchInput, 'query' | 'cursor'>,
  queryVector: Float32Array,
  options: RawMeaningOptions
): RawSearchHit[] {
  const connectors = normalizeConnectors(input.connectors);
  if (connectors.length !== 1) {
    throw new Error('meaningSearchRaw requires exactly one connector filter.');
  }
  const clauses = ['e.current_observation_id IS NOT NULL'];
  const params: unknown[] = [];
  appendFilters(
    clauses,
    params,
    { ...input, query: '', connectors },
    'e',
    'COALESCE(e.event_datetime, e.source_timestamp_ms)'
  );
  const rows = adapter
    .prepare(
      `SELECT e.*, ${timingSelectSql('e')} FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}`
    )
    .all(...params) as RawSearchRow[];
  const vectors = readObservationEmbeddings(
    adapter,
    rows.map((row) => String(row.current_observation_id))
  );
  const scored: Array<{ row: RawSearchRow; similarity: number }> = [];
  for (const row of rows) {
    const vector = vectors.get(String(row.current_observation_id));
    if (!vector) continue;
    if (vector.length !== queryVector.length) {
      throw new Error(
        `Observation vector has ${vector.length} dimensions; the query has ${queryVector.length}`
      );
    }
    let similarity = 0;
    for (let index = 0; index < vector.length; index += 1) {
      similarity += vector[index]! * queryVector[index]!;
    }
    scored.push({ row, similarity });
  }
  // The text hits stay in the background: they are part of what the query is measured against.
  const mean = scored.reduce((sum, item) => sum + item.similarity, 0) / scored.length;
  const deviation = Math.sqrt(
    scored.reduce((sum, item) => sum + (item.similarity - mean) ** 2, 0) / scored.length
  );
  const page = scored
    .filter(
      (item) =>
        !options.exclude?.has(String(item.row.current_observation_id)) &&
        (item.similarity - mean) / deviation >= options.minZ
    )
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, normalizeLimit(options.limit));
  assertObservationRefsConsistent(
    adapter,
    page.map((item) => item.row)
  );
  return page.map((item) => ({ ...toRawHit(item.row), score: item.similarity }));
}

/** Browse stored evidence by source time when the agent has no search phrase yet. */
export function listRaw(adapter: RawQueryAdapter, input: RawSearchInput): RawSearchResult {
  if (input.query.trim() !== '') {
    throw new Error('listRaw requires an empty query');
  }
  const connectors = normalizeConnectors(input.connectors);
  if (connectors.length !== 1) {
    throw new Error('listRaw requires exactly one connector filter');
  }
  let cursor: RawListCursor | null = null;
  if (input.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as RawListCursor;
    } catch {
      throw new Error('Invalid stored source cursor');
    }
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.sourceTimeMs) ||
      !Number.isSafeInteger(cursor.observedUpperMs) ||
      typeof cursor.rawId !== 'string' ||
      cursor.rawId.length === 0
    ) {
      throw new Error('Invalid stored source cursor');
    }
    cursor.maxSourceMs = normalizeMaxSourceMs(cursor.maxSourceMs);
  }
  if (cursor) assertCursorCeiling(cursor, input);
  const observedUpperMs = cursor?.observedUpperMs ?? Date.now();
  const clauses = [`${observationObservedAtSql('e')} <= ?`];
  const params: unknown[] = [observedUpperMs];
  appendFilters(clauses, params, input, 'e', 'e.source_timestamp_ms');
  if (cursor) {
    clauses.push(
      '(e.source_timestamp_ms < ? OR (e.source_timestamp_ms = ? AND e.event_index_id > ?))'
    );
    params.push(cursor.sourceTimeMs, cursor.sourceTimeMs, cursor.rawId);
  }
  const limit = normalizeLimit(input.limit);
  const rows = adapter
    .prepare(
      `SELECT e.*, ${timingSelectSql('e')}
       FROM connector_event_index e
       WHERE ${clauses.join(' AND ')}
       ORDER BY e.source_timestamp_ms DESC, e.event_index_id ASC
       LIMIT ?`
    )
    .all(...params, limit + 1) as RawSearchRow[];
  const pageRows = rows.slice(0, limit);
  assertObservationRefsConsistent(adapter, pageRows);
  const last = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;
  return {
    hits: pageRows.map(toRawHit),
    next_cursor: last
      ? Buffer.from(
          JSON.stringify({
            sourceTimeMs: Number(last.source_timestamp_ms),
            rawId: String(last.event_index_id),
            observedUpperMs,
            maxSourceMs: normalizeMaxSourceMs(input.maxSourceMs),
          })
        ).toString('base64url')
      : null,
  };
}

export function searchAllRaw(adapter: RawQueryAdapter, input: RawSearchInput): RawSearchResult {
  return runSearch(adapter, input);
}

export function getRawById(
  adapter: RawQueryAdapter,
  rawId: string,
  visibility: Pick<RawSearchInput, 'connectors' | 'scopes' | 'maxSourceMs'>
): RawDocument | null {
  const params: unknown[] = [rawId];
  const clauses = ['e.current_observation_id = ?'];
  appendFilters(clauses, params, { query: '*', ...visibility });
  const row = adapter
    .prepare(
      `
        SELECT e.*, ${timingSelectSql('e')}
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
  const targetClauses = ['e.current_observation_id = ?'];
  appendFilters(targetClauses, targetParams, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
    maxSourceMs: input.maxSourceMs,
  });
  const targetRow = adapter
    .prepare(
      `
        SELECT e.*, ${timingSelectSql('e')}
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
    maxSourceMs: input.maxSourceMs,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, ${timingSelectSql('e')}
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
    maxSourceMs: input.maxSourceMs,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, ${timingSelectSql('e')}
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
  maxSourceMs: number | null;
}

export interface RawHistoryInput {
  /** The entity whose revisions to read. Provide this OR `rawId`. */
  entityId?: string;
  /**
   * A raw event id (the observation id) to anchor on: its entity is resolved under the SAME
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
  maxSourceMs?: number | null;
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
  visibility: Pick<RawSearchInput, 'connectors' | 'scopes' | 'maxSourceMs'>
): EntityAnchor | null {
  const clauses = ['e.current_observation_id = ?'];
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
  maxSourceMs: number | null;
}): string {
  return Buffer.from(
    JSON.stringify({
      timestampMs: row.capture_timestamp_ms,
      rawId: row.event_index_id,
      maxSourceMs: row.maxSourceMs,
    }),
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
    return {
      timestampMs: parsed.timestampMs,
      rawId: parsed.rawId,
      maxSourceMs: normalizeMaxSourceMs(parsed.maxSourceMs),
    };
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
            maxSourceMs: input.maxSourceMs,
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
      maxSourceMs: input.maxSourceMs,
    },
    'e',
    captureTime
  );

  const cursor = decodeHistoryCursor(input.cursor);
  if (cursor) {
    if (cursor.maxSourceMs !== normalizeMaxSourceMs(input.maxSourceMs)) {
      throw new Error('Raw history cursor source-time ceiling changed');
    }
    clauses.push(`(${captureTime} > ? OR (${captureTime} = ? AND e.event_index_id > ?))`);
    params.push(cursor.timestampMs, cursor.timestampMs, cursor.rawId);
  }

  const rows = adapter
    .prepare(
      `
        SELECT e.*, ${timingSelectSql('e')}
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
          maxSourceMs: normalizeMaxSourceMs(input.maxSourceMs),
        })
      : null,
  };
}

export type {
  RawSearchHit,
  RawSearchInput,
  RawSearchResult,
  RawSearchScopeFilter,
} from './connector-event-types.js';
