import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type {
  ConnectorEventIndexCursorRecord,
  ConnectorEventIndexRecord,
  ConnectorEventSearchHit,
  ConnectorEventStalenessStatus,
  UpsertConnectorEventIndexCursorInput,
  UpsertConnectorEventIndexInput,
} from './types.js';

type ConnectorEventIndexAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

interface ListConnectorEventsByDatetimeRangeInput {
  fromMs: number;
  toMs: number;
  limit?: number;
  connectors?: string[];
  order?: 'asc' | 'desc';
}

interface SearchConnectorEventsOptions {
  limit?: number;
  connectors?: string[];
}

interface DeleteExpiredConnectorEventsInput {
  nowMs: number;
  retentionMs: number;
  connectorName?: string;
}

interface StalenessOptions {
  nowMs: number;
  staleAfterMs?: number;
  stalenessWarnAfterMs?: number;
  unhealthyAfterMs?: number;
}

const DEFAULT_RANGE_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_RANGE_LIMIT = 500;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const SIXTY_MINUTES_MS = 60 * 60 * 1000;

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL placeholders for an empty list.');
  }
  return values.map(() => '?').join(', ');
}

function positiveLimit(value: number | undefined, fallback: number, max = MAX_RANGE_LIMIT): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventDateFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeTimestampMs(input: UpsertConnectorEventIndexInput): number {
  const timestamp = input.source_timestamp_ms ?? input.event_datetime;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new Error('connector_event_index.source_timestamp_ms must be a finite number.');
  }
  return Math.floor(timestamp);
}

function normalizeEventDatetime(input: UpsertConnectorEventIndexInput): number | null {
  if (input.event_datetime === null || input.event_datetime === undefined) {
    return normalizeTimestampMs(input);
  }
  if (!Number.isFinite(input.event_datetime)) {
    throw new Error('connector_event_index.event_datetime must be a finite number when provided.');
  }
  return Math.floor(input.event_datetime);
}

function normalizeMetadataJson(input: UpsertConnectorEventIndexInput): string | null {
  if (input.metadata_json !== undefined) {
    return input.metadata_json;
  }
  if (input.metadata === undefined || input.metadata === null) {
    return null;
  }
  return canonicalizeJSON(input.metadata);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('connector_event_index.content_hash must be a 32-byte Buffer.');
}

function mapConnectorEventIndexRow(row: Record<string, unknown>): ConnectorEventIndexRecord {
  return {
    event_index_id: String(row.event_index_id),
    source_connector: String(row.source_connector),
    source_type: String(row.source_type),
    source_id: String(row.source_id),
    source_locator: row.source_locator === null ? null : String(row.source_locator),
    channel: row.channel === null ? null : String(row.channel),
    author: row.author === null ? null : String(row.author),
    title: row.title === null ? null : String(row.title),
    content: String(row.content),
    event_datetime:
      typeof row.event_datetime === 'number' && Number.isFinite(row.event_datetime)
        ? row.event_datetime
        : null,
    event_date: row.event_date === null ? null : String(row.event_date),
    source_timestamp_ms: Number(row.source_timestamp_ms),
    source_cursor: row.source_cursor === null ? null : String(row.source_cursor),
    tenant_id: row.tenant_id === null ? null : String(row.tenant_id),
    project_id: row.project_id === null ? null : String(row.project_id),
    memory_scope_kind: row.memory_scope_kind === null ? null : String(row.memory_scope_kind),
    memory_scope_id: row.memory_scope_id === null ? null : String(row.memory_scope_id),
    metadata_json: row.metadata_json === null ? null : String(row.metadata_json),
    artifact_locator: row.artifact_locator === null ? null : String(row.artifact_locator),
    artifact_title: row.artifact_title === null ? null : String(row.artifact_title),
    content_hash: toBuffer(row.content_hash),
    indexed_at: String(row.indexed_at),
    updated_at: String(row.updated_at),
    expires_at: row.expires_at === null ? null : String(row.expires_at),
  };
}

export function mapConnectorEventIndexRecord(
  row: Record<string, unknown>
): ConnectorEventIndexRecord {
  return mapConnectorEventIndexRow(row);
}

function mapConnectorCursorRow(row: Record<string, unknown>): ConnectorEventIndexCursorRecord {
  return {
    connector_name: String(row.connector_name),
    last_seen_timestamp_ms: Number(row.last_seen_timestamp_ms),
    last_seen_source_id: String(row.last_seen_source_id),
    last_sweep_at: row.last_sweep_at === null ? null : String(row.last_sweep_at),
    last_success_at: row.last_success_at === null ? null : String(row.last_success_at),
    last_error: row.last_error === null ? null : String(row.last_error),
    last_error_at: row.last_error_at === null ? null : String(row.last_error_at),
    indexed_count: Number(row.indexed_count),
  };
}

function connectorFilterSql(connectors: readonly string[] | undefined, alias = ''): string {
  if (!connectors || connectors.length === 0) {
    return '';
  }
  const prefix = alias.length > 0 ? `${alias}.` : '';
  return ` AND ${prefix}source_connector IN (${placeholders(connectors)})`;
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function connectorEventIndexId(sourceConnector: string, sourceId: string): string {
  const digest = createHash('sha1').update(`${sourceConnector}\0${sourceId}`, 'utf8').digest('hex');
  return `evt_${digest.slice(0, 16)}`;
}

export function connectorEventContentHash(input: {
  source_connector: string;
  source_id: string;
  content: string;
  event_datetime?: number | null;
}): Buffer {
  return createHash('sha256')
    .update(
      canonicalizeJSON({
        source_connector: input.source_connector,
        source_id: input.source_id,
        content: input.content,
        event_datetime: input.event_datetime ?? null,
      }),
      'utf8'
    )
    .digest();
}

export function upsertConnectorEventIndex(
  adapter: ConnectorEventIndexAdapter,
  input: UpsertConnectorEventIndexInput
): ConnectorEventIndexRecord {
  const sourceTimestampMs = normalizeTimestampMs(input);
  const eventDatetime = normalizeEventDatetime(input);
  const eventDate = input.event_date ?? eventDateFromMs(eventDatetime);
  const timestamp = input.updated_at ?? nowIso();
  const eventIndexId = connectorEventIndexId(input.source_connector, input.source_id);
  const contentHash = input.content_hash
    ? Buffer.from(input.content_hash)
    : connectorEventContentHash({
        source_connector: input.source_connector,
        source_id: input.source_id,
        content: input.content,
        event_datetime: eventDatetime,
      });

  if (contentHash.byteLength !== 32) {
    throw new Error('connector_event_index.content_hash must be exactly 32 bytes.');
  }

  const metadataJson = normalizeMetadataJson(input);

  return adapter.transaction(() => {
    adapter
      .prepare(
        `
          INSERT INTO connector_event_index (
            event_index_id, source_connector, source_type, source_id, source_locator,
            channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
            source_cursor, tenant_id, project_id, memory_scope_kind, memory_scope_id,
            metadata_json, artifact_locator, artifact_title, content_hash, indexed_at, updated_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_connector, source_id) DO UPDATE SET
            source_type = excluded.source_type,
            source_locator = excluded.source_locator,
            channel = excluded.channel,
            author = excluded.author,
            title = excluded.title,
            content = excluded.content,
            event_datetime = excluded.event_datetime,
            event_date = excluded.event_date,
            source_timestamp_ms = excluded.source_timestamp_ms,
            source_cursor = excluded.source_cursor,
            tenant_id = excluded.tenant_id,
            project_id = excluded.project_id,
            memory_scope_kind = excluded.memory_scope_kind,
            memory_scope_id = excluded.memory_scope_id,
            metadata_json = excluded.metadata_json,
            artifact_locator = excluded.artifact_locator,
            artifact_title = excluded.artifact_title,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `
      )
      .run(
        eventIndexId,
        input.source_connector,
        input.source_type,
        input.source_id,
        input.source_locator ?? null,
        input.channel ?? null,
        input.author ?? null,
        input.title ?? null,
        input.content,
        eventDatetime,
        eventDate,
        sourceTimestampMs,
        input.source_cursor ?? null,
        input.tenant_id ?? null,
        input.project_id ?? null,
        input.memory_scope_kind ?? null,
        input.memory_scope_id ?? null,
        metadataJson,
        input.artifact_locator ?? null,
        input.artifact_title ?? null,
        contentHash,
        input.indexed_at ?? timestamp,
        timestamp,
        input.expires_at ?? null
      );

    const saved = getConnectorEventIndexRecord(adapter, input.source_connector, input.source_id);
    if (!saved) {
      throw new Error(
        `Failed to read connector_event_index row after upsert: ${input.source_connector}/${input.source_id}`
      );
    }
    return saved;
  });
}

export function getConnectorEventIndexRecord(
  adapter: ConnectorEventIndexAdapter,
  sourceConnector: string,
  sourceId: string
): ConnectorEventIndexRecord | null {
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM connector_event_index
        WHERE source_connector = ?
          AND source_id = ?
        LIMIT 1
      `
    )
    .get(sourceConnector, sourceId) as Record<string, unknown> | undefined;

  return row ? mapConnectorEventIndexRow(row) : null;
}

export function listConnectorEventsByDatetimeRange(
  adapter: ConnectorEventIndexAdapter,
  input: ListConnectorEventsByDatetimeRangeInput
): ConnectorEventIndexRecord[] {
  const limit = positiveLimit(input.limit, DEFAULT_RANGE_LIMIT);
  if (limit === 0) {
    return [];
  }

  const order = input.order === 'desc' ? 'DESC' : 'ASC';
  const connectors = input.connectors?.filter(Boolean) ?? [];
  const params: unknown[] = [input.fromMs, input.toMs, ...connectors, limit];

  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM connector_event_index
        WHERE event_datetime >= ?
          AND event_datetime <= ?
          ${connectorFilterSql(connectors)}
        ORDER BY event_datetime ${order}, event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapConnectorEventIndexRow);
}

export function searchConnectorEventsByFTS(
  adapter: ConnectorEventIndexAdapter,
  query: string,
  options: SearchConnectorEventsOptions = {}
): ConnectorEventSearchHit[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const limit = positiveLimit(options.limit, DEFAULT_SEARCH_LIMIT, 100);
  if (limit === 0) {
    return [];
  }

  const connectors = options.connectors?.filter(Boolean) ?? [];
  const params: unknown[] = [normalizedQuery, ...connectors, limit];

  const rows = adapter
    .prepare(
      `
        SELECT e.*, bm25(connector_event_index_fts) AS rank
        FROM connector_event_index_fts
        JOIN connector_event_index e
          ON e.event_index_id = connector_event_index_fts.event_index_id
        WHERE connector_event_index_fts MATCH ?
          ${connectorFilterSql(connectors, 'e')}
        ORDER BY rank ASC, e.event_datetime DESC, e.event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params) as Array<Record<string, unknown> & { rank: number }>;

  return rows.map((row) => {
    const rank = Number(row.rank);
    return {
      ...mapConnectorEventIndexRow(row),
      rank,
      score: Number.isFinite(rank) ? 1 / (1 + Math.exp(rank)) : 0,
    };
  });
}

export function readConnectorCursor(
  adapter: ConnectorEventIndexAdapter,
  connectorName: string
): ConnectorEventIndexCursorRecord | null {
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM connector_event_index_cursors
        WHERE connector_name = ?
        LIMIT 1
      `
    )
    .get(connectorName) as Record<string, unknown> | undefined;

  return row ? mapConnectorCursorRow(row) : null;
}

export function upsertConnectorCursor(
  adapter: ConnectorEventIndexAdapter,
  input: UpsertConnectorEventIndexCursorInput
): ConnectorEventIndexCursorRecord {
  const current = readConnectorCursor(adapter, input.connector_name);
  const merged: ConnectorEventIndexCursorRecord = {
    connector_name: input.connector_name,
    last_seen_timestamp_ms: input.last_seen_timestamp_ms ?? current?.last_seen_timestamp_ms ?? 0,
    last_seen_source_id: input.last_seen_source_id ?? current?.last_seen_source_id ?? '',
    last_sweep_at: hasOwn(input, 'last_sweep_at')
      ? (input.last_sweep_at ?? null)
      : (current?.last_sweep_at ?? null),
    last_success_at: hasOwn(input, 'last_success_at')
      ? (input.last_success_at ?? null)
      : (current?.last_success_at ?? null),
    last_error: hasOwn(input, 'last_error')
      ? (input.last_error ?? null)
      : (current?.last_error ?? null),
    last_error_at: hasOwn(input, 'last_error_at')
      ? (input.last_error_at ?? null)
      : (current?.last_error_at ?? null),
    indexed_count: input.indexed_count ?? current?.indexed_count ?? 0,
  };

  adapter
    .prepare(
      `
        INSERT INTO connector_event_index_cursors (
          connector_name, last_seen_timestamp_ms, last_seen_source_id, last_sweep_at,
          last_success_at, last_error, last_error_at, indexed_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector_name) DO UPDATE SET
          last_seen_timestamp_ms = excluded.last_seen_timestamp_ms,
          last_seen_source_id = excluded.last_seen_source_id,
          last_sweep_at = excluded.last_sweep_at,
          last_success_at = excluded.last_success_at,
          last_error = excluded.last_error,
          last_error_at = excluded.last_error_at,
          indexed_count = excluded.indexed_count
      `
    )
    .run(
      merged.connector_name,
      merged.last_seen_timestamp_ms,
      merged.last_seen_source_id,
      merged.last_sweep_at,
      merged.last_success_at,
      merged.last_error,
      merged.last_error_at,
      merged.indexed_count
    );

  const saved = readConnectorCursor(adapter, input.connector_name);
  if (!saved) {
    throw new Error(`Failed to read connector cursor after upsert: ${input.connector_name}`);
  }
  return saved;
}

export function deleteExpiredConnectorEvents(
  adapter: ConnectorEventIndexAdapter,
  input: DeleteExpiredConnectorEventsInput
): { rows_deleted: number } {
  if (!Number.isFinite(input.nowMs)) {
    throw new Error('deleteExpiredConnectorEvents.nowMs must be a finite number.');
  }
  if (!Number.isFinite(input.retentionMs) || input.retentionMs < 0) {
    throw new Error(
      'deleteExpiredConnectorEvents.retentionMs must be a non-negative finite number.'
    );
  }

  const cutoffMs = input.nowMs - input.retentionMs;
  const result = input.connectorName
    ? adapter
        .prepare(
          `
            DELETE FROM connector_event_index
            WHERE source_connector = ?
              AND event_datetime IS NOT NULL
              AND event_datetime < ?
              AND artifact_locator IS NULL
          `
        )
        .run(input.connectorName, cutoffMs)
    : adapter
        .prepare(
          `
            DELETE FROM connector_event_index
            WHERE event_datetime IS NOT NULL
              AND event_datetime < ?
              AND artifact_locator IS NULL
          `
        )
        .run(cutoffMs);

  return { rows_deleted: result.changes };
}

export function computeStalenessStatus(
  cursor: ConnectorEventIndexCursorRecord | null,
  options: StalenessOptions
): ConnectorEventStalenessStatus {
  if (!cursor) {
    return 'never_swept';
  }

  if (cursor.last_error !== null) {
    return 'unhealthy';
  }

  if (cursor.last_success_at === null) {
    return 'never_swept';
  }

  const lastSuccessMs = Date.parse(cursor.last_success_at);
  if (!Number.isFinite(lastSuccessMs)) {
    return 'unhealthy';
  }

  const elapsedMs = options.nowMs - lastSuccessMs;
  const staleAfterMs = options.staleAfterMs ?? FIVE_MINUTES_MS;
  const warnAfterMs = options.stalenessWarnAfterMs ?? FIFTEEN_MINUTES_MS;
  const unhealthyAfterMs = options.unhealthyAfterMs ?? SIXTY_MINUTES_MS;

  if (elapsedMs > unhealthyAfterMs) {
    return 'unhealthy';
  }
  if (elapsedMs > warnAfterMs) {
    return 'warn';
  }
  if (elapsedMs > staleAfterMs) {
    return 'stale-but-warming';
  }
  return 'healthy';
}

export type {
  ConnectorEventIndexCursorRecord,
  ConnectorEventIndexRecord,
  ConnectorEventSearchHit,
  ConnectorEventStalenessStatus,
  UpsertConnectorEventIndexCursorInput,
  UpsertConnectorEventIndexInput,
} from './types.js';
