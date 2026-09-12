import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type {
  ConnectorEventIndexCursorRecord,
  ConnectorEventIndexRecord,
  UpsertConnectorEventIndexInput,
} from './types.js';
import { appendObservationVersion } from './observation-versions.js';

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
  if (!Object.prototype.hasOwnProperty.call(row, 'current_observation_id')) {
    throw new Error('connector_event_index.current_observation_id schema is required');
  }
  if (
    row.current_observation_id !== null &&
    (typeof row.current_observation_id !== 'string' || row.current_observation_id.trim() === '')
  ) {
    throw new Error('connector_event_index.current_observation_id must be nonblank text or null');
  }
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
    current_observation_id: row.current_observation_id,
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
  let capturedAt = input.observation?.observed_at ?? Date.now();
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
    let producerVersionId = input.observation?.producer_version_id ?? null;
    if (producerVersionId === null) {
      const current = adapter
        .prepare(
          `SELECT o.producer_version_id, o.content_hash, o.author, o.source_at, o.observed_at,
                  o.metadata_json, o.scope_json
             FROM connector_event_index e
             JOIN observation_versions o ON o.observation_id = e.current_observation_id
            WHERE e.source_connector = ? AND e.source_id = ? LIMIT 1`
        )
        .get(input.source_connector, input.source_id) as
        | {
            producer_version_id: string | null;
            content_hash: string;
            author: string | null;
            source_at: number | null;
            metadata_json: string;
            scope_json: string;
            observed_at: number;
          }
        | undefined;
      const incomingScope = canonicalizeJSON({
        channel: input.channel ?? null,
        tenantId: input.tenant_id ?? null,
        projectId: input.project_id ?? null,
        memoryScopeKind: input.memory_scope_kind ?? null,
        memoryScopeId: input.memory_scope_id ?? null,
      });
      const incomingSourceAt =
        input.observation && input.observation.source_at !== undefined
          ? input.observation.source_at
          : eventDatetime;
      const sameCurrent =
        current?.content_hash === contentHash.toString('hex') &&
        current.author === (input.author ?? null) &&
        current.source_at === incomingSourceAt &&
        current.metadata_json ===
          canonicalizeJSON(input.metadata ?? (metadataJson ? JSON.parse(metadataJson) : {})) &&
        current.scope_json === incomingScope;
      if (sameCurrent && current.producer_version_id) {
        producerVersionId = current.producer_version_id;
        if (input.observation === undefined) {
          capturedAt = current.observed_at;
        }
      } else {
        const count = adapter
          .prepare(
            'SELECT COUNT(*) AS count FROM observation_versions WHERE source_connector = ? AND source_id = ?'
          )
          .get(input.source_connector, input.source_id) as { count: number };
        producerVersionId = `capture:${eventIndexId}:${count.count + 1}`;
      }
    }
    const observation = appendObservationVersion(adapter, {
      sourceConnector: input.source_connector,
      sourceId: input.source_id,
      producerVersionId,
      ...(input.observation?.body_location
        ? { bodyLocation: input.observation.body_location }
        : { body: input.content }),
      author: input.author ?? null,
      sourceAt:
        input.observation && input.observation.source_at !== undefined
          ? input.observation.source_at
          : eventDatetime,
      observedAt: capturedAt,
      contentHash: contentHash.toString('hex'),
      metadata: input.metadata ?? (metadataJson ? JSON.parse(metadataJson) : {}),
      scope: {
        channel: input.channel ?? null,
        tenantId: input.tenant_id ?? null,
        projectId: input.project_id ?? null,
        memoryScopeKind: input.memory_scope_kind ?? null,
        memoryScopeId: input.memory_scope_id ?? null,
      },
    });
    adapter
      .prepare(
        `
          INSERT INTO connector_event_index (
            event_index_id, source_connector, source_type, source_id, source_entity_id,
            source_locator, channel, author, title, content, event_datetime, event_date,
            source_timestamp_ms, source_cursor, tenant_id, project_id, memory_scope_kind,
            memory_scope_id, metadata_json, artifact_locator, artifact_title, content_hash,
            indexed_at, updated_at, expires_at, current_observation_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_connector, source_id) DO UPDATE SET
            source_type = excluded.source_type,
            source_entity_id = excluded.source_entity_id,
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
            current_observation_id = excluded.current_observation_id,
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
        input.source_entity_id ?? input.source_id,
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
        input.expires_at ?? null,
        observation.observationId
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

  if (!row) {
    return null;
  }
  const record = mapConnectorEventIndexRow(row);
  if (
    record.current_observation_id !== null &&
    !adapter
      .prepare('SELECT 1 FROM observation_versions WHERE observation_id = ?')
      .get(record.current_observation_id)
  ) {
    throw new Error('connector_event_index contains an inconsistent current observation ref');
  }
  return record;
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
