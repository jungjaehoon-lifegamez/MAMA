import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type {
  ConnectorEventIndexCursorRecord,
  ConnectorEventIndexRecord,
  UpsertConnectorEventIndexInput,
} from './types.js';

type ConnectorEventIndexAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

interface DeleteExpiredConnectorEventsInput {
  nowMs: number;
  retentionMs: number;
  connectorName?: string;
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
    operator_ingest_seq: Number(row.operator_ingest_seq),
    operator_observation_seq: Number(row.operator_observation_seq),
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
            expires_at = excluded.expires_at,
            operator_ingest_seq = CASE
              WHEN connector_event_index.content_hash IS NOT excluded.content_hash
                OR connector_event_index.metadata_json IS NOT excluded.metadata_json
                OR connector_event_index.source_timestamp_ms IS NOT excluded.source_timestamp_ms
                OR connector_event_index.source_type IS NOT excluded.source_type
                OR connector_event_index.channel IS NOT excluded.channel
              THEN NULL
              ELSE connector_event_index.operator_ingest_seq
            END,
            operator_observation_seq = CASE
              WHEN connector_event_index.content_hash IS NOT excluded.content_hash
                OR connector_event_index.metadata_json IS NOT excluded.metadata_json
                OR connector_event_index.source_timestamp_ms IS NOT excluded.source_timestamp_ms
                OR connector_event_index.source_type IS NOT excluded.source_type
                OR connector_event_index.channel IS NOT excluded.channel
              THEN NULL
              ELSE connector_event_index.operator_observation_seq
            END
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

export type {
  ConnectorEventIndexCursorRecord,
  ConnectorEventIndexRecord,
  ConnectorEventSearchHit,
  ConnectorEventStalenessStatus,
  UpsertConnectorEventIndexCursorInput,
  UpsertConnectorEventIndexInput,
} from './types.js';
