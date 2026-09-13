import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';

type ObservationAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ObservationBodyLocation {
  kind: 'raw';
  connectorName: string;
  revisionSourceId: string;
}

export interface ObservationVersionInput {
  sourceConnector: string;
  sourceId: string;
  producerVersionId?: string | null;
  body?: string;
  bodyLocation?: ObservationBodyLocation;
  author?: string | null;
  sourceAt?: number | null;
  observedAt: number;
  contentHash: string;
  metadata?: Record<string, unknown> | null;
  scope?: Record<string, unknown> | null;
}

export interface ObservationVersionRecord {
  observationId: string;
  sourceConnector: string;
  sourceId: string;
  producerVersionId: string | null;
  body: string | null;
  bodyLocation: ObservationBodyLocation | null;
  author: string | null;
  sourceAt: number | null;
  observedAt: number;
  contentHash: string;
  metadata: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface OwnerObservationSearchItem {
  observationRef: string;
  sourceConnector: string;
  sourceId: string;
  author: string | null;
  sourceAt: number | null;
  observedAt: number;
  contentPreview: string;
  metadataPreview: string;
}

export interface ObservationBodyReader {
  readVersion(
    input: ObservationBodyLocation & { expectedContentHash: string }
  ):
    | { status: 'available'; body: string; contentHash: string }
    | { status: 'version_unavailable'; reason: 'VERSION_NOT_FOUND' | 'HASH_MISMATCH' };
}

export type ObservationReadResult =
  | { status: 'available'; observation: ObservationVersionRecord; body: string }
  | {
      status: 'version_unavailable';
      observation: ObservationVersionRecord;
      reason: 'BODY_READER_UNAVAILABLE' | 'VERSION_NOT_FOUND' | 'HASH_MISMATCH';
    }
  | { status: 'not_found' };

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new Error(`observation_versions.${field} must be JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`observation_versions.${field} is malformed JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`observation_versions.${field} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`observation_versions.${field} must be text or null`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string, nullable = false): number | null {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `observation_versions.${field} must be a finite number${nullable ? ' or null' : ''}`
    );
  }
  return value;
}

function mapRow(row: Record<string, unknown>): ObservationVersionRecord {
  if (typeof row.observation_id !== 'string' || row.observation_id.trim() === '') {
    throw new Error('observation_versions.observation_id must be nonblank text');
  }
  if (typeof row.source_connector !== 'string' || row.source_connector.trim() === '') {
    throw new Error('observation_versions.source_connector must be nonblank text');
  }
  if (typeof row.source_id !== 'string' || row.source_id.trim() === '') {
    throw new Error('observation_versions.source_id must be nonblank text');
  }
  if (typeof row.content_hash !== 'string' || row.content_hash.trim() === '') {
    throw new Error('observation_versions.content_hash must be nonblank text');
  }
  const body = nullableString(row.body, 'body');
  const bodyLocationJson = nullableString(row.body_location_json, 'body_location_json');
  if ((body === null) === (bodyLocationJson === null)) {
    throw new Error('observation_versions row requires exactly one body source');
  }
  const bodyLocation = bodyLocationJson
    ? parseObject(bodyLocationJson, 'body_location_json')
    : null;
  if (
    bodyLocation &&
    (bodyLocation.kind !== 'raw' ||
      typeof bodyLocation.connectorName !== 'string' ||
      typeof bodyLocation.revisionSourceId !== 'string' ||
      bodyLocation.connectorName.trim() === '' ||
      bodyLocation.revisionSourceId.trim() === '')
  ) {
    throw new Error('observation_versions.body_location_json has an invalid raw locator');
  }
  return {
    observationId: row.observation_id,
    sourceConnector: row.source_connector,
    sourceId: row.source_id,
    producerVersionId: nullableString(row.producer_version_id, 'producer_version_id'),
    body,
    bodyLocation: bodyLocation as ObservationBodyLocation | null,
    author: nullableString(row.author, 'author'),
    sourceAt: finiteNumber(row.source_at, 'source_at', true),
    observedAt: finiteNumber(row.observed_at, 'observed_at') as number,
    contentHash: row.content_hash,
    metadata: parseObject(row.metadata_json, 'metadata_json'),
    scope: parseObject(row.scope_json, 'scope_json'),
  };
}

function sameObservation(
  actual: ObservationVersionRecord,
  input: ObservationVersionInput
): boolean {
  return (
    actual.sourceConnector === input.sourceConnector &&
    actual.sourceId === input.sourceId &&
    actual.producerVersionId === (input.producerVersionId ?? null) &&
    actual.body === (input.body ?? null) &&
    canonicalizeJSON(actual.bodyLocation) === canonicalizeJSON(input.bodyLocation ?? null) &&
    actual.author === (input.author ?? null) &&
    actual.sourceAt === (input.sourceAt ?? null) &&
    actual.observedAt === Math.floor(input.observedAt) &&
    actual.contentHash === input.contentHash &&
    canonicalizeJSON(actual.metadata) === canonicalizeJSON(input.metadata ?? {}) &&
    canonicalizeJSON(actual.scope) === canonicalizeJSON(input.scope ?? {})
  );
}

export function observationVersionId(input: ObservationVersionInput): string {
  const identity = canonicalizeJSON({
    sourceConnector: input.sourceConnector,
    sourceId: input.sourceId,
    producerVersionId: input.producerVersionId ?? null,
    ...(input.producerVersionId === null || input.producerVersionId === undefined
      ? { contentHash: input.contentHash }
      : {}),
  });
  return `obs_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export function appendObservationVersion(
  adapter: ObservationAdapter,
  input: ObservationVersionInput
): ObservationVersionRecord {
  if ((input.body === undefined) === (input.bodyLocation === undefined)) {
    throw new Error('Observation requires exactly one of body or bodyLocation.');
  }
  if (!Number.isFinite(input.observedAt)) {
    throw new Error('Observation observedAt must be finite.');
  }
  for (const [field, value] of [
    ['sourceConnector', input.sourceConnector],
    ['sourceId', input.sourceId],
    ['contentHash', input.contentHash],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`Observation ${field} must be nonblank.`);
    }
  }
  const id = observationVersionId(input);
  adapter
    .prepare(
      `INSERT OR IGNORE INTO observation_versions (
        observation_id, source_connector, source_id, producer_version_id, body,
        body_location_json, author, source_at, observed_at, content_hash, metadata_json, scope_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.sourceConnector,
      input.sourceId,
      input.producerVersionId ?? null,
      input.body ?? null,
      input.bodyLocation ? canonicalizeJSON(input.bodyLocation) : null,
      input.author ?? null,
      input.sourceAt ?? null,
      Math.floor(input.observedAt),
      input.contentHash,
      canonicalizeJSON(input.metadata ?? {}),
      canonicalizeJSON(input.scope ?? {})
    );
  const record = getObservationVersion(adapter, id);
  if (!record) {
    throw new Error(`Failed to persist observation ${id}`);
  }
  if (!sameObservation(record, input)) {
    throw new Error(`Observation replay conflict for ${id}`);
  }
  return record;
}

export function getObservationVersion(
  adapter: ObservationAdapter,
  observationId: string
): ObservationVersionRecord | null {
  const row = adapter
    .prepare('SELECT * FROM observation_versions WHERE observation_id = ? LIMIT 1')
    .get(observationId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function searchOwnerObservationVersions(
  adapter: ObservationAdapter,
  input: {
    query: string;
    principalId: string;
    agentId: string;
    connectors?: string[];
    connectorChannels?: Readonly<Record<string, readonly string[]>>;
    fromMs?: number;
    toMs?: number;
    cursor?: string;
    limit?: number;
  }
): { items: OwnerObservationSearchItem[]; nextCursor: string | null } {
  const query = input.query.trim();
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 25)));
  const clauses = [
    "(source_connector LIKE 'owner-message:%' OR source_connector LIKE 'owner-result:%')",
    "json_extract(scope_json, '$.visibility') = 'owner'",
    "json_extract(scope_json, '$.principalId') = ?",
    "json_extract(scope_json, '$.agentId') = ?",
  ];
  const params: unknown[] = [input.principalId, input.agentId];
  const connectors = [...new Set((input.connectors ?? []).map((value) => value.trim()))].filter(
    Boolean
  );
  if (input.connectors !== undefined && connectors.length === 0) {
    return { items: [], nextCursor: null };
  }
  if (connectors.length > 0) {
    clauses.push(`source_connector IN (${connectors.map(() => '?').join(', ')})`);
    params.push(...connectors);
  }
  if (input.connectorChannels !== undefined) {
    const pairs = Object.entries(input.connectorChannels)
      .map(
        ([connector, values]) =>
          [
            connector.trim(),
            [...new Set(values.map((value) => value.trim()).filter(Boolean))],
          ] as const
      )
      .filter(([connector, values]) => connector.length > 0 && values.length > 0);
    if (pairs.length === 0) {
      return { items: [], nextCursor: null };
    }
    clauses.push(
      `(${pairs
        .map(
          ([, values]) =>
            `(source_connector IN (?, ?) AND json_extract(scope_json, '$.channel') IN (${values
              .map(() => '?')
              .join(', ')}))`
        )
        .join(' OR ')})`
    );
    for (const [connector, values] of pairs) {
      params.push(`owner-message:${connector}`, `owner-result:${connector}`, ...values);
    }
  }
  if (input.fromMs !== undefined) {
    clauses.push('observed_at >= ?');
    params.push(input.fromMs);
  }
  if (input.toMs !== undefined) {
    clauses.push('observed_at <= ?');
    params.push(input.toMs);
  }
  if (query) {
    clauses.push('(instr(body, ?) > 0 OR instr(metadata_json, ?) > 0)');
    params.push(query, query);
  }
  if (input.cursor) {
    let cursor: { observedAt: number; observationId: string };
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as typeof cursor;
    } catch {
      throw new Error('Invalid owner observation cursor.');
    }
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      !Number.isFinite(cursor.observedAt) ||
      typeof cursor.observationId !== 'string' ||
      !cursor.observationId
    ) {
      throw new Error('Invalid owner observation cursor.');
    }
    clauses.push('(observed_at < ? OR (observed_at = ? AND observation_id > ?))');
    params.push(cursor.observedAt, cursor.observedAt, cursor.observationId);
  }
  const rows = adapter
    .prepare(
      `SELECT * FROM observation_versions
       WHERE ${clauses.join(' AND ')}
       ORDER BY observed_at DESC, observation_id ASC
       LIMIT ?`
    )
    .all(...params, limit + 1) as Record<string, unknown>[];
  const pageRows = rows.slice(0, limit);
  const last = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;
  return {
    items: pageRows.map((row) => {
      const record = mapRow(row);
      const compact = (record.body ?? '').replace(/\s+/g, ' ').trim();
      return {
        observationRef: record.observationId,
        sourceConnector: record.sourceConnector,
        sourceId: record.sourceId,
        author: record.author,
        sourceAt: record.sourceAt,
        observedAt: record.observedAt,
        contentPreview: compact.length > 500 ? `${compact.slice(0, 497)}...` : compact,
        metadataPreview: canonicalizeJSON(record.metadata).slice(0, 500),
      };
    }),
    nextCursor: last
      ? Buffer.from(
          JSON.stringify({
            observedAt: Number(last.observed_at),
            observationId: String(last.observation_id),
          })
        ).toString('base64url')
      : null,
  };
}

export function readObservationVersion(
  adapter: ObservationAdapter,
  observationId: string,
  reader?: ObservationBodyReader
): ObservationReadResult {
  const observation = getObservationVersion(adapter, observationId);
  if (!observation) {
    return { status: 'not_found' };
  }
  if (observation.body !== null) {
    return { status: 'available', observation, body: observation.body };
  }
  if (!reader || !observation.bodyLocation) {
    return { status: 'version_unavailable', observation, reason: 'BODY_READER_UNAVAILABLE' };
  }
  const result = reader.readVersion({
    ...observation.bodyLocation,
    expectedContentHash: observation.contentHash,
  });
  if (result.status === 'available') {
    return result.contentHash === observation.contentHash
      ? { status: 'available', observation, body: result.body }
      : { status: 'version_unavailable', observation, reason: 'HASH_MISMATCH' };
  }
  return { status: 'version_unavailable', observation, reason: result.reason };
}
