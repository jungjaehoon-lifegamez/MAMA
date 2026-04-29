import type { DatabaseAdapter } from '../db-manager.js';
import { MEMORY_SCOPE_KINDS, type MemoryScopeKind } from '../memory/types.js';
import { mapConnectorEventIndexRecord } from './event-index.js';
import type {
  ConnectorEventIndexRecord,
  RawSearchHit,
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
  source_timestamp_ms: number;
  event_index_id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      rank: row.rank,
      timestampMs: row.source_timestamp_ms,
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
  alias = 'e'
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
    clauses.push(`${alias}.source_timestamp_ms >= ?`);
    params.push(input.fromMs);
  }
  if (input.toMs !== undefined) {
    clauses.push(`${alias}.source_timestamp_ms <= ?`);
    params.push(input.toMs);
  }
}

function appendCursorFilter(clauses: string[], params: unknown[], cursor: RawCursor | null): void {
  if (!cursor) {
    return;
  }
  clauses.push(
    `(rank > ? OR (rank = ? AND source_timestamp_ms < ?) OR ` +
      `(rank = ? AND source_timestamp_ms = ? AND event_index_id > ?))`
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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
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
    created_at: timestampToIso(record.event_datetime ?? record.source_timestamp_ms),
    content_preview: contentPreview(record.content),
    score: scoreFromRank(Number(row.rank)),
    source_ref: record.source_locator ?? record.artifact_locator,
    metadata: parseMetadata(record.metadata_json),
  };
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
  appendFilters(clauses, params, input);
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
          SELECT e.*, bm25(connector_event_index_fts) AS rank
          FROM connector_event_index_fts
          JOIN connector_event_index e
            ON e.event_index_id = connector_event_index_fts.event_index_id
          WHERE connector_event_index_fts MATCH ?
            ${whereSql}
        )
        SELECT *
        FROM ranked
        ${cursorSql}
        ORDER BY rank ASC, source_timestamp_ms DESC, event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params, ...outerParams, limit + 1) as RawSearchRow[];

  const pageRows = rows.slice(0, limit);
  const nextRow = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;

  return {
    hits: pageRows.map(toRawHit),
    next_cursor: nextRow
      ? encodeCursor({
          rank: Number(nextRow.rank),
          source_timestamp_ms: Number(nextRow.source_timestamp_ms),
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
): RawSearchHit | null {
  const params: unknown[] = [rawId];
  const clauses = ['e.event_index_id = ?'];
  appendFilters(clauses, params, { query: '*', ...visibility });
  const row = adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        LIMIT 1
      `
    )
    .get(...params) as RawSearchRow | undefined;

  return row ? toRawHit(row) : null;
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
        SELECT e.*, 0 AS rank
        FROM connector_event_index e
        WHERE ${targetClauses.join(' AND ')}
        LIMIT 1
      `
    )
    .get(...targetParams) as RawSearchRow | undefined;

  if (!targetRow) {
    return null;
  }

  const target = mapConnectorEventIndexRecord(targetRow);
  const before = normalizeWindowSize(input.before);
  const after = normalizeWindowSize(input.after);
  const beforeRows = beforeWindowRows(adapter, target, input, before);
  const afterRows = afterWindowRows(adapter, target, input, after);
  const targetHit = toRawHit(targetRow);

  return {
    target: targetHit,
    items: [...beforeRows.reverse().map(toRawHit), targetHit, ...afterRows.map(toRawHit)],
  };
}

function beforeWindowRows(
  adapter: RawQueryAdapter,
  target: ConnectorEventIndexRecord,
  input: RawWindowInput,
  limit: number
): RawSearchRow[] {
  if (limit === 0) {
    return [];
  }
  const params: unknown[] = [target.source_connector, target.channel, target.source_timestamp_ms];
  const clauses = [
    'e.source_connector = ?',
    target.channel === null ? 'e.channel IS ?' : 'e.channel = ?',
    'e.source_timestamp_ms < ?',
  ];
  appendFilters(clauses, params, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.source_timestamp_ms DESC, e.event_index_id DESC
        LIMIT ?
      `
    )
    .all(...params, limit) as RawSearchRow[];
}

function afterWindowRows(
  adapter: RawQueryAdapter,
  target: ConnectorEventIndexRecord,
  input: RawWindowInput,
  limit: number
): RawSearchRow[] {
  if (limit === 0) {
    return [];
  }
  const params: unknown[] = [target.source_connector, target.channel, target.source_timestamp_ms];
  const clauses = [
    'e.source_connector = ?',
    target.channel === null ? 'e.channel IS ?' : 'e.channel = ?',
    'e.source_timestamp_ms > ?',
  ];
  appendFilters(clauses, params, {
    query: '*',
    connectors: input.connectors,
    scopes: input.scopes,
  });
  return adapter
    .prepare(
      `
        SELECT e.*, 0 AS rank
        FROM connector_event_index e
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.source_timestamp_ms ASC, e.event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params, limit) as RawSearchRow[];
}

export type {
  RawSearchHit,
  RawSearchInput,
  RawSearchResult,
  RawSearchScopeFilter,
} from './types.js';
