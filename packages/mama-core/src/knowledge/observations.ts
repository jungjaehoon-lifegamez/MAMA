import { isErasedRecord, observationScopes, type ErasedRecord } from '../identity/erased-record.js';
/**
 * Knowledge observations: immutable observation versions and the visibility
 * rule that decides which of them a caller may read. A cited observation must
 * satisfy the same rule as a row the reader would have returned.
 *
 * @module knowledge/observations
 */

import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import type { MemoryScopeRef } from '../memory/types.js';

type ObservationAdapter = Pick<DatabaseAdapter, 'prepare'>;
type ObservationVisibilityAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ObservationBodyLocation {
  kind: 'raw';
  connectorName: string;
  revisionSourceId: string;
}

export interface ObservationVersionInput {
  /**
   * Where this came from -- a namespace, paired with `sourceId` inside it. It was
   * `sourceConnector`; a deployment with no connectors still observes things.
   */
  source: string;
  sourceId: string;
  producerVersionId?: string | null;
  body?: string;
  bodyLocation?: ObservationBodyLocation;
  author?: string | null;
  sourceAt?: number | null;
  observedAt: number;
  contentHash: string;
  metadata?: Record<string, unknown> | null;
  /**
   * What was observed, beyond its body. These lived only on the connector index,
   * which is why a core read had to go there to answer what a memory rests on.
   */
  sourceType?: string | null;
  sourceLocator?: string | null;
  title?: string | null;
  artifactLocator?: string | null;
  artifactTitle?: string | null;
  eventDate?: string | null;
  sourceEntityId?: string | null;
  /**
   * Who may see it. Columns rather than a JSON blob because raw visibility is a
   * WHERE clause as well as a predicate, and the two are pinned against each other.
   */
  channel?: string | null;
  projectId?: string | null;
  tenantId?: string | null;
  memoryScopeKind?: string | null;
  memoryScopeId?: string | null;
  scope?: Record<string, unknown> | null;
}

export interface ObservationVersionRecord {
  observationId: string;
  source: string;
  sourceId: string;
  producerVersionId: string | null;
  body: string | null;
  bodyLocation: ObservationBodyLocation | null;
  author: string | null;
  sourceAt: number | null;
  observedAt: number;
  contentHash: string;
  metadata: Record<string, unknown>;
  sourceType: string | null;
  sourceLocator: string | null;
  title: string | null;
  artifactLocator: string | null;
  artifactTitle: string | null;
  eventDate: string | null;
  sourceEntityId: string | null;
  channel: string | null;
  projectId: string | null;
  tenantId: string | null;
  memoryScopeKind: string | null;
  memoryScopeId: string | null;
  scope: Record<string, unknown>;
}

export interface OwnerObservationSearchItem {
  observationRef: string;
  source: string;
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
  | ErasedRecord
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
  if (typeof row.source !== 'string' || row.source.trim() === '') {
    throw new Error('observation_versions.source must be nonblank text');
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
    source: row.source,
    sourceId: row.source_id,
    producerVersionId: nullableString(row.producer_version_id, 'producer_version_id'),
    body,
    bodyLocation: bodyLocation as ObservationBodyLocation | null,
    author: nullableString(row.author, 'author'),
    sourceAt: finiteNumber(row.source_at, 'source_at', true),
    observedAt: finiteNumber(row.observed_at, 'observed_at') as number,
    contentHash: row.content_hash,
    metadata: parseObject(row.metadata_json, 'metadata_json'),
    sourceType: nullableString(row.source_type, 'source_type'),
    sourceLocator: nullableString(row.source_locator, 'source_locator'),
    title: nullableString(row.title, 'title'),
    artifactLocator: nullableString(row.artifact_locator, 'artifact_locator'),
    artifactTitle: nullableString(row.artifact_title, 'artifact_title'),
    eventDate: nullableString(row.event_date, 'event_date'),
    sourceEntityId: nullableString(row.source_entity_id, 'source_entity_id'),
    channel: nullableString(row.channel, 'channel'),
    projectId: nullableString(row.project_id, 'project_id'),
    tenantId: nullableString(row.tenant_id, 'tenant_id'),
    memoryScopeKind: nullableString(row.memory_scope_kind, 'memory_scope_kind'),
    memoryScopeId: nullableString(row.memory_scope_id, 'memory_scope_id'),
    scope: parseObject(row.scope_json, 'scope_json'),
  };
}

function sameObservation(
  actual: ObservationVersionRecord,
  input: ObservationVersionInput,
  scope: Record<string, unknown>
): boolean {
  return (
    actual.source === input.source &&
    actual.sourceId === input.sourceId &&
    actual.producerVersionId === (input.producerVersionId ?? null) &&
    actual.body === (input.body ?? null) &&
    canonicalizeJSON(actual.bodyLocation) === canonicalizeJSON(input.bodyLocation ?? null) &&
    actual.author === (input.author ?? null) &&
    actual.sourceAt === (input.sourceAt ?? null) &&
    actual.observedAt === Math.floor(input.observedAt) &&
    actual.contentHash === input.contentHash &&
    canonicalizeJSON(actual.metadata) === canonicalizeJSON(input.metadata ?? {}) &&
    canonicalizeJSON(actual.scope) === canonicalizeJSON(scope)
  );
}

export function observationVersionId(input: ObservationVersionInput): string {
  const identity = canonicalizeJSON({
    source: input.source,
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
    ['source', input.source],
    ['sourceId', input.sourceId],
    ['contentHash', input.contentHash],
  ] as const) {
    if (!value.trim()) {
      throw new Error(`Observation ${field} must be nonblank.`);
    }
  }
  // The scope bag and the scope columns are one fact in two shapes: the bag is what
  // was stated, the columns are what a WHERE clause can reach. Deriving the columns
  // here, once, is what keeps them from disagreeing -- a caller that fills only one
  // of the two is how they drift apart.
  const scope = input.scope ?? {};
  const fromScope = (key: string, explicit: string | null | undefined): string | null => {
    if (explicit !== undefined) {
      return explicit;
    }
    const value = (scope as Record<string, unknown>)[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const channel = fromScope('channel', input.channel);
  const projectId = fromScope('projectId', input.projectId);
  const tenantId = fromScope('tenantId', input.tenantId);
  const memoryScopeKind = fromScope('memoryScopeKind', input.memoryScopeKind);
  const memoryScopeId = fromScope('memoryScopeId', input.memoryScopeId);
  // And the other direction. A caller that named the scope as columns has said the
  // same thing as one that named it in the bag, and the two readers -- a WHERE
  // clause over the columns, a predicate over the bag -- must not disagree about it.
  const scopeBag: Record<string, unknown> = { ...scope };
  for (const [key, value] of [
    ['channel', channel],
    ['projectId', projectId],
    ['tenantId', tenantId],
    ['memoryScopeKind', memoryScopeKind],
    ['memoryScopeId', memoryScopeId],
  ] as const) {
    if (value !== null && scopeBag[key] === undefined) {
      scopeBag[key] = value;
    }
  }

  const id = observationVersionId(input);
  adapter
    .prepare(
      `INSERT OR IGNORE INTO observation_versions (
        observation_id, source, source_id, producer_version_id, body,
        body_location_json, author, source_at, observed_at, content_hash, metadata_json, scope_json,
        source_type, source_locator, title, artifact_locator, artifact_title, event_date,
        source_entity_id, channel, project_id, tenant_id, memory_scope_kind, memory_scope_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.source,
      input.sourceId,
      input.producerVersionId ?? null,
      input.body ?? null,
      input.bodyLocation ? canonicalizeJSON(input.bodyLocation) : null,
      input.author ?? null,
      input.sourceAt ?? null,
      Math.floor(input.observedAt),
      input.contentHash,
      canonicalizeJSON(input.metadata ?? {}),
      canonicalizeJSON(scopeBag),
      input.sourceType ?? null,
      input.sourceLocator ?? null,
      input.title ?? null,
      input.artifactLocator ?? null,
      input.artifactTitle ?? null,
      input.eventDate ?? null,
      input.sourceEntityId ?? null,
      channel,
      projectId,
      tenantId,
      memoryScopeKind,
      memoryScopeId
    );
  const record = getObservationVersion(adapter, id);
  if (record && isErasedRecord(record)) throw new Error('Observation has been erased');
  if (!record) {
    throw new Error(`Failed to persist observation ${id}`);
  }
  if (!sameObservation(record, input, scopeBag)) {
    throw new Error(`Observation replay conflict for ${id}`);
  }
  return record;
}

/**
 * The observation's source, without reading the rest of it.
 *
 * A caller deciding whether a row is an owner observation needs one column. It
 * asks for one: mapping the whole record would parse a body and a metadata
 * blob it does not use, and a row whose metadata is malformed would then fail
 * loudly where the answer is simply "not yours" — the disclosure the visibility
 * check exists to avoid.
 */
export function getObservationVersionSource(
  adapter: ObservationAdapter,
  observationId: string
): string | null {
  const row = adapter
    .prepare('SELECT source FROM observation_versions WHERE observation_id = ? LIMIT 1')
    .get(observationId) as { source?: unknown } | undefined;
  if (!row) {
    return null;
  }
  if (typeof row.source !== 'string' || row.source.trim() === '') {
    throw new Error('observation_versions.source must be nonblank text');
  }
  return row.source;
}

export function getObservationVersion(
  adapter: ObservationAdapter,
  observationId: string
): ObservationVersionRecord | ErasedRecord | null {
  const row = adapter
    .prepare('SELECT * FROM observation_versions WHERE observation_id = ? LIMIT 1')
    .get(observationId) as Record<string, unknown> | undefined;
  if (typeof row?.erased_at === 'number')
    return { id: observationId, scopes: observationScopes(row), state: 'erased' };
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
    'erased_at IS NULL',
    "(source LIKE 'owner-message:%' OR source LIKE 'owner-result:%')",
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
    clauses.push(`source IN (${connectors.map(() => '?').join(', ')})`);
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
          ([, values]) => `(source IN (?, ?) AND channel IN (${values.map(() => '?').join(', ')}))`
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
        source: record.source,
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
  reader?: ObservationBodyReader,
  options?: { maxSourceMs?: number | null }
): ObservationReadResult {
  const observation = getObservationVersion(adapter, observationId);
  if (!observation) {
    return { status: 'not_found' };
  }
  if (isErasedRecord(observation)) return observation;
  const maxSourceMs = options?.maxSourceMs ?? null;
  if (maxSourceMs !== null) {
    if (!Number.isSafeInteger(maxSourceMs) || maxSourceMs < 0) {
      throw new Error('Observation source ceiling must be a nonnegative epoch millisecond integer');
    }
    if (observation.sourceAt === null || observation.sourceAt > maxSourceMs) {
      return { status: 'not_found' };
    }
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

export interface ObservationVisibilityAuthority {
  principalId?: string;
  agentId?: string;
  scopes?: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  connectorWideRead?: readonly string[];
  channels?: Readonly<Record<string, readonly string[]>>;
  maxSourceMs?: number | null;
}

export interface ObservationVisibilityRow {
  erased_at?: unknown;
  source: unknown;
  scope_json: unknown;
  source_at?: unknown;
}

function parseScopeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new Error('observation_versions.scope_json must be JSON text');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`observation_versions.scope_json is malformed JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observation_versions.scope_json must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function matchesScope(scope: Record<string, unknown>, visible: MemoryScopeRef): boolean {
  if (visible.kind === 'project') {
    return (
      scope.projectId === visible.id ||
      (scope.memoryScopeKind === 'project' && scope.memoryScopeId === visible.id)
    );
  }
  if (visible.kind === 'channel') {
    return (
      scope.channel === visible.id ||
      (scope.memoryScopeKind === 'channel' && scope.memoryScopeId === visible.id)
    );
  }
  return scope.memoryScopeKind === visible.kind && scope.memoryScopeId === visible.id;
}

export function isObservationVersionVisible(
  adapter: ObservationVisibilityAdapter,
  observationId: string,
  authority: ObservationVisibilityAuthority
): boolean {
  const row = adapter
    .prepare(
      `SELECT scope_json, source, source_at, erased_at
       FROM observation_versions WHERE observation_id = ?`
    )
    .get(observationId) as ObservationVisibilityRow | undefined;
  if (!row) {
    return false;
  }
  return isObservationVisibilityRowVisible(row, authority);
}

export function isObservationVisibilityRowVisible(
  row: ObservationVisibilityRow,
  authority: ObservationVisibilityAuthority
): boolean {
  const principalId = authority.principalId?.trim();
  const agentId = authority.agentId?.trim();
  if (!principalId || !agentId) {
    return false;
  }
  if (typeof row.erased_at === 'number') {
    const scopes = parseScopeJson(row.scope_json).scopes;
    return (
      Array.isArray(scopes) &&
      scopes.some((scope) => {
        if (!scope || typeof scope !== 'object') return false;
        const bound = scope as { kind?: unknown; id?: unknown; externalId?: unknown };
        return (
          authority.scopes?.some(
            (admitted) =>
              admitted.kind === bound.kind && admitted.id === (bound.id ?? bound.externalId)
          ) === true
        );
      })
    );
  }
  const maxSourceMs = authority.maxSourceMs ?? null;
  if (maxSourceMs !== null) {
    if (!Number.isSafeInteger(maxSourceMs) || maxSourceMs < 0) {
      throw new Error('Observation source ceiling must be a nonnegative epoch millisecond integer');
    }
    const sourceAt = typeof row.source_at === 'number' ? row.source_at : null;
    if (sourceAt === null || sourceAt > maxSourceMs) return false;
  }
  if (typeof row.source !== 'string' || !row.source.trim()) {
    throw new Error('observation_versions.source must be nonblank text');
  }
  const ownerConnector = /^owner-(?:message|result):(.+)$/.exec(row.source)?.[1];
  const connector = ownerConnector ?? row.source;
  if (!authority.connectors?.includes(connector)) {
    return false;
  }
  const scope = parseScopeJson(row.scope_json);
  const connectorWideRead = authority.connectorWideRead?.includes(connector) === true;
  if (authority.channels && !connectorWideRead) {
    const visibleChannels = authority.channels[connector];
    const channel = typeof scope.channel === 'string' ? scope.channel : null;
    const normalizedChannel = channel?.startsWith(`${connector}:`)
      ? channel.slice(connector.length + 1)
      : channel;
    if (
      !visibleChannels ||
      channel === null ||
      (!visibleChannels.includes(channel) &&
        (normalizedChannel === null || !visibleChannels.includes(normalizedChannel)))
    ) {
      return false;
    }
  }
  if (ownerConnector !== undefined || scope.visibility === 'owner') {
    if (ownerConnector === undefined || scope.visibility !== 'owner') {
      throw new Error('owner observation connector and scope visibility are inconsistent');
    }
    return scope.principalId === principalId && scope.agentId === agentId;
  }
  // A current connector/channel grant is the same read authority source.read
  // applies. Imported originals can have no project or memory-scope tag; that
  // absence does not revoke an explicitly granted source read in the graph.
  if (connectorWideRead || authority.channels) {
    return true;
  }
  if (!authority.scopes || authority.scopes.length === 0) {
    return false;
  }
  return authority.scopes.some((visible) => matchesScope(scope, visible));
}
