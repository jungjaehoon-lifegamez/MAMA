import type { DatabaseAdapter } from '../db-manager.js';
import {
  isObservationVersionVisible,
  isObservationVisibilityRowVisible,
} from '../connectors/observation-visibility.js';
import { getTwinEdge, listTwinEdgesForRefs, mapTwinEdgeRow } from './store.js';
import { isChannelGranted } from '../context-compile/channel-grant.js';
import type {
  ListVisibleTwinEdgesOptions,
  TwinEdgeRecord,
  TwinEdgeType,
  TwinProjectRef,
  TwinRef,
  TwinScopeRef,
  TwinVisibility,
} from './types.js';

type TwinRefVisibilityAdapter = Pick<DatabaseAdapter, 'prepare'>;

const TABLE_COLUMN_PRAGMAS: Record<string, string> = {
  decisions: 'PRAGMA table_info(decisions)',
  case_truth: 'PRAGMA table_info(case_truth)',
};
const tableColumnCache = new WeakMap<TwinRefVisibilityAdapter, Map<string, Set<string>>>();
// Keep memory-truth quarantine semantics excluded for legacy/backcompat rows even though the
// current decisions.status CHECK only admits superseded/contradicted/stale terminal states.
const EXCLUDED_MEMORY_STATUSES = new Set(['superseded', 'quarantined', 'contradicted', 'stale']);

export class TwinRefNotVisibleError extends Error {
  constructor(ref: TwinRef) {
    super(`Twin ref is not visible to requested visibility: ${ref.kind}:${ref.id}`);
    this.name = 'TwinRefNotVisibleError';
  }
}

function scopeKey(scope: TwinScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

function hasScopes(scopes: readonly TwinScopeRef[] | undefined): scopes is TwinScopeRef[] {
  return Array.isArray(scopes) && scopes.length > 0;
}

function hasProjectRefs(
  projectRefs: readonly TwinProjectRef[] | undefined
): projectRefs is TwinProjectRef[] {
  return Array.isArray(projectRefs) && projectRefs.length > 0;
}

function asOfMs(visibility: TwinVisibility): number | null {
  return typeof visibility.asOfMs === 'number' ? visibility.asOfMs : null;
}

function startMs(visibility: TwinVisibility): number | null {
  return typeof visibility.startMs === 'number' ? visibility.startMs : null;
}

function isWithinVisibilityTime(
  value: number | null | undefined,
  visibility: TwinVisibility
): boolean {
  const start = startMs(visibility);
  const asOf = asOfMs(visibility);
  if (start === null && asOf === null) {
    return true;
  }
  return (
    typeof value === 'number' &&
    (start === null || value >= start) &&
    (asOf === null || value <= asOf)
  );
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function tableColumns(adapter: TwinRefVisibilityAdapter, table: string): Set<string> {
  const pragma = TABLE_COLUMN_PRAGMAS[table];
  if (!pragma) {
    throw new Error(`Unsupported table for column introspection: ${table}`);
  }

  let adapterCache = tableColumnCache.get(adapter);
  if (!adapterCache) {
    adapterCache = new Map();
    tableColumnCache.set(adapter, adapterCache);
  }

  const cached = adapterCache.get(table);
  if (cached) {
    return cached;
  }

  const rows = adapter.prepare(pragma).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  adapterCache.set(table, columns);
  return columns;
}

function isMemoryVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const columns = tableColumns(adapter, 'decisions');
  const statusSelect = columns.has('status') ? 'status' : 'NULL AS status';
  const supersededBySelect = columns.has('superseded_by')
    ? 'superseded_by'
    : 'NULL AS superseded_by';
  const row = adapter
    .prepare(
      `
        SELECT created_at, event_datetime, ${statusSelect}, ${supersededBySelect}
        FROM decisions
        WHERE id = ?
        LIMIT 1
      `
    )
    .get(id) as
    | {
        created_at: number;
        event_datetime: number | null;
        status: string | null;
        superseded_by: string | null;
      }
    | undefined;
  if (!row) {
    return false;
  }
  const status = typeof row.status === 'string' ? row.status : 'active';
  if (
    EXCLUDED_MEMORY_STATUSES.has(status) ||
    (typeof row.superseded_by === 'string' && row.superseded_by.length > 0)
  ) {
    return false;
  }
  if (!isWithinVisibilityTime(row.event_datetime ?? row.created_at, visibility)) {
    return false;
  }
  const scopes = visibility.scopes;
  if (!hasScopes(scopes)) {
    return true;
  }

  const scopeClauses = scopes.map(() => '(ms.kind = ? AND ms.external_id = ?)').join(' OR ');
  const params = scopes.flatMap((scope) => [scope.kind, scope.id]);
  const bindingRow = adapter
    .prepare(
      `
        SELECT 1 AS ok
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id = ?
          AND (${scopeClauses})
        LIMIT 1
      `
    )
    .get(id, ...params) as { ok: number } | undefined;
  if (bindingRow?.ok) {
    return true;
  }

  if (columns.has('memory_scope_kind') && columns.has('memory_scope_id')) {
    const row = adapter
      .prepare(
        `
          SELECT 1 AS ok
          FROM decisions
          WHERE id = ?
            AND (${scopes.map(() => '(memory_scope_kind = ? AND memory_scope_id = ?)').join(' OR ')})
          LIMIT 1
        `
      )
      .get(id, ...params) as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  return false;
}

function parseCaseScopeRefs(scopeRefs: unknown): TwinScopeRef[] {
  if (typeof scopeRefs !== 'string' || scopeRefs.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(scopeRefs) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is TwinScopeRef =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).kind === 'string' &&
        typeof (item as Record<string, unknown>).id === 'string'
    );
  } catch {
    return [];
  }
}

function isCaseVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const row = adapter.prepare('SELECT * FROM case_truth WHERE case_id = ? LIMIT 1').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return false;
  }
  const timestamp = parseTimestamp(row.last_activity_at) ?? parseTimestamp(row.updated_at);
  if (!isWithinVisibilityTime(timestamp, visibility)) {
    return false;
  }
  const scopes = visibility.scopes;
  if (!hasScopes(scopes)) {
    return true;
  }

  const requested = new Set(scopes.map(scopeKey));
  const scopeRefs = parseCaseScopeRefs(row.scope_refs);
  if (scopeRefs.some((scope) => requested.has(scopeKey(scope)))) {
    return true;
  }

  const columns = tableColumns(adapter, 'case_truth');
  if (columns.has('memory_scope_kind') && columns.has('memory_scope_id')) {
    return scopes.some(
      (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
    );
  }

  return false;
}

/** Current rows use immutable observation capture time; valid legacy rows use source time. */
function isRawWithinTime(row: Record<string, unknown>, visibility: TwinVisibility): boolean {
  const rawTs = row.observation_observed_at ?? row.event_datetime ?? row.source_timestamp_ms;
  if (rawTs === null || rawTs === undefined || (typeof rawTs === 'string' && rawTs.trim() === '')) {
    return false;
  }
  const eventTsMs = parseTimestamp(rawTs);
  return eventTsMs !== null && eventTsMs >= 0 && isWithinVisibilityTime(eventTsMs, visibility);
}

function isRawVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const row = adapter
    .prepare(
      `SELECT event.*, observation.observation_id AS joined_observation_id,
              observation.observed_at AS observation_observed_at
         FROM connector_event_index event
         LEFT JOIN observation_versions observation
           ON observation.observation_id = event.current_observation_id
        WHERE event.event_index_id = ?
        LIMIT 1`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  if (row.current_observation_id !== null && row.joined_observation_id === null) {
    throw new Error('connector_event_index contains a dangling current observation ref');
  }

  return isRawRowVisible(row, visibility);
}

function isRawRowVisible(row: Record<string, unknown>, visibility: TwinVisibility): boolean {
  if (
    Array.isArray(visibility.connectors) &&
    !visibility.connectors.includes(String(row.source_connector))
  ) {
    return false;
  }

  // The grant decides, and it decides the same way here as in the reader - one rule, taken
  // from one place. The scope/project/tenant clauses below are the pre-grant rule and are
  // skipped when a grant is present, exactly as the reader skips them, because applying
  // both would make a cited ref satisfy a stricter test than a read one.
  if (visibility.channels) {
    return (
      isChannelGranted(
        String(row.source_connector),
        typeof row.channel === 'string' ? row.channel : null,
        visibility.channels
      ) && isRawWithinTime(row, visibility)
    );
  }

  if (
    hasProjectRefs(visibility.projectRefs) &&
    !visibility.projectRefs.some((project) => project.id === row.project_id)
  ) {
    return false;
  }

  if (
    typeof visibility.tenantId === 'string' &&
    visibility.tenantId.length > 0 &&
    row.tenant_id !== visibility.tenantId
  ) {
    return false;
  }

  if (!isRawWithinTime(row, visibility)) {
    return false;
  }

  if (!hasScopes(visibility.scopes)) {
    return true;
  }
  return visibility.scopes.some(
    (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
  );
}

function isEntityVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const row = adapter
    .prepare(
      'SELECT scope_kind, scope_id, created_at FROM entity_nodes WHERE id = ? AND status = ? LIMIT 1'
    )
    .get(id, 'active') as
    | {
        scope_kind: string | null;
        scope_id: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) {
    return false;
  }
  if (!isWithinVisibilityTime(row.created_at, visibility)) {
    return false;
  }
  const scopes = visibility.scopes;
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some((scope) => row.scope_kind === scope.kind && row.scope_id === scope.id);
}

function refVisibilityKey(ref: TwinRef): string {
  return `${ref.kind}\0${ref.id}`;
}

function placeholders(count: number): string {
  if (count < 1) {
    throw new Error('Visibility batch requires at least one identifier');
  }
  return Array.from({ length: count }, () => '?').join(', ');
}

export function visibleTwinRefKeys(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility
): Set<string> {
  const unique = [...new Map(refs.map((ref) => [refVisibilityKey(ref), ref])).values()];
  const visible = new Set<string>();
  const ids = (kind: TwinRef['kind']) =>
    unique.filter((ref) => ref.kind === kind).map((ref) => ref.id);

  const rawIds = ids('raw');
  if (rawIds.length > 0) {
    const rows = adapter
      .prepare(
        `SELECT event.*, observation.observation_id AS joined_observation_id,
                observation.observed_at AS observation_observed_at
           FROM connector_event_index event
           LEFT JOIN observation_versions observation
             ON observation.observation_id = event.current_observation_id
          WHERE event.event_index_id IN (${placeholders(rawIds.length)})`
      )
      .all(...rawIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (row.current_observation_id !== null && row.joined_observation_id === null) {
        throw new Error('connector_event_index contains a dangling current observation ref');
      }
      if (isRawRowVisible(row, visibility)) {
        visible.add(refVisibilityKey({ kind: 'raw', id: String(row.event_index_id) }));
      }
    }
  }

  const observationIds = ids('observation');
  if (observationIds.length > 0) {
    const rows = adapter
      .prepare(
        `SELECT observation_id, source_connector, scope_json, observed_at
           FROM observation_versions
          WHERE observation_id IN (${placeholders(observationIds.length)})`
      )
      .all(...observationIds) as Array<{
      observation_id: string;
      source_connector: unknown;
      scope_json: unknown;
      observed_at: number;
    }>;
    for (const row of rows) {
      if (
        isWithinVisibilityTime(row.observed_at, visibility) &&
        isObservationVisibilityRowVisible(row, {
          principalId: visibility.principalId,
          agentId: visibility.agentId,
          scopes: visibility.scopes,
          connectors: visibility.connectors,
          channels: visibility.channels,
        })
      ) {
        visible.add(refVisibilityKey({ kind: 'observation', id: row.observation_id }));
      }
    }
  }

  const entityIds = ids('entity');
  if (entityIds.length > 0) {
    const rows = adapter
      .prepare(
        `SELECT id, scope_kind, scope_id, created_at FROM entity_nodes
          WHERE status = 'active' AND id IN (${placeholders(entityIds.length)})`
      )
      .all(...entityIds) as Array<{
      id: string;
      scope_kind: string | null;
      scope_id: string | null;
      created_at: number;
    }>;
    for (const row of rows) {
      if (
        isWithinVisibilityTime(row.created_at, visibility) &&
        (!hasScopes(visibility.scopes) ||
          visibility.scopes.some(
            (scope) => row.scope_kind === scope.kind && row.scope_id === scope.id
          ))
      ) {
        visible.add(refVisibilityKey({ kind: 'entity', id: row.id }));
      }
    }
  }

  const caseIds = ids('case');
  if (caseIds.length > 0) {
    const rows = adapter
      .prepare(`SELECT * FROM case_truth WHERE case_id IN (${placeholders(caseIds.length)})`)
      .all(...caseIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const timestamp = parseTimestamp(row.last_activity_at) ?? parseTimestamp(row.updated_at);
      const scopeVisible =
        !hasScopes(visibility.scopes) ||
        parseCaseScopeRefs(row.scope_refs).some((scope) =>
          new Set(visibility.scopes?.map(scopeKey) ?? []).has(scopeKey(scope))
        ) ||
        visibility.scopes.some(
          (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
        );
      if (
        typeof row.case_id === 'string' &&
        isWithinVisibilityTime(timestamp, visibility) &&
        scopeVisible
      ) {
        visible.add(refVisibilityKey({ kind: 'case', id: row.case_id }));
      }
    }
  }

  const memoryIds = ids('memory');
  if (memoryIds.length > 0) {
    const columns = tableColumns(adapter, 'decisions');
    const rows = adapter
      .prepare(`SELECT * FROM decisions WHERE id IN (${placeholders(memoryIds.length)})`)
      .all(...memoryIds) as Array<Record<string, unknown>>;
    const admittedBindings = new Set<string>();
    if (hasScopes(visibility.scopes)) {
      const scopeClauses = visibility.scopes
        .map(() => '(ms.kind = ? AND ms.external_id = ?)')
        .join(' OR ');
      const bindings = adapter
        .prepare(
          `SELECT msb.memory_id FROM memory_scope_bindings msb
             JOIN memory_scopes ms ON ms.id = msb.scope_id
            WHERE msb.memory_id IN (${placeholders(memoryIds.length)})
              AND (${scopeClauses})`
        )
        .all(
          ...memoryIds,
          ...visibility.scopes.flatMap((scope) => [scope.kind, scope.id])
        ) as Array<{ memory_id: string }>;
      bindings.forEach((row) => admittedBindings.add(row.memory_id));
    }
    for (const row of rows) {
      const id = String(row.id);
      const status = typeof row.status === 'string' ? row.status : 'active';
      const retired =
        EXCLUDED_MEMORY_STATUSES.has(status) ||
        (typeof row.superseded_by === 'string' && row.superseded_by.length > 0);
      const scopeVisible =
        !hasScopes(visibility.scopes) ||
        admittedBindings.has(id) ||
        (columns.has('memory_scope_kind') &&
          columns.has('memory_scope_id') &&
          visibility.scopes.some(
            (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
          ));
      if (
        !retired &&
        isWithinVisibilityTime(
          parseTimestamp(row.event_datetime) ?? parseTimestamp(row.created_at),
          visibility
        ) &&
        scopeVisible
      ) {
        visible.add(refVisibilityKey({ kind: 'memory', id }));
      }
    }
  }

  const registryIds = ids('registry');
  if (registryIds.length > 0) {
    const rows = adapter
      .prepare(`SELECT id FROM registry_nodes WHERE id IN (${placeholders(registryIds.length)})`)
      .all(...registryIds) as Array<{ id: string }>;
    const admitted = new Set<string>();
    if (hasScopes(visibility.scopes)) {
      const scopeClauses = visibility.scopes
        .map(() => '(scope_kind = ? AND scope_id = ?)')
        .join(' OR ');
      const bindings = adapter
        .prepare(
          `SELECT DISTINCT node_id FROM registry_scope_bindings
            WHERE node_id IN (${placeholders(registryIds.length)}) AND (${scopeClauses})`
        )
        .all(
          ...registryIds,
          ...visibility.scopes.flatMap((scope) => [scope.kind, scope.id])
        ) as Array<{ node_id: string }>;
      bindings.forEach((row) => admitted.add(row.node_id));
    }
    for (const row of rows) {
      if (!hasScopes(visibility.scopes) || admitted.has(row.id)) {
        visible.add(refVisibilityKey({ kind: 'registry', id: row.id }));
      }
    }
  }

  for (const ref of unique) {
    if (ref.kind === 'report' && !hasScopes(visibility.scopes)) {
      visible.add(refVisibilityKey(ref));
    }
  }
  return visible;
}

function preloadRecursiveEdgeVisibility(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility
): {
  edgeCache: Map<string, TwinEdgeRecord | null>;
  precomputed: Set<string>;
} {
  const edgeCache = new Map<string, TwinEdgeRecord | null>();
  const rootEdgeIds = [...new Set(refs.filter((ref) => ref.kind === 'edge').map((ref) => ref.id))];
  const nestedRefs: TwinRef[] = refs.filter((ref) => ref.kind !== 'edge');
  if (rootEdgeIds.length > 0) {
    const rows = adapter
      .prepare(
        `WITH RECURSIVE edge_tree(edge_id, path, depth) AS (
           SELECT CAST(value AS TEXT), char(0) || CAST(value AS TEXT) || char(0), 0
             FROM json_each(?)
           UNION ALL
           SELECT CAST(child.value AS TEXT),
                  tree.path || CAST(child.value AS TEXT) || char(0),
                  tree.depth + 1
             FROM edge_tree tree
             JOIN twin_edges parent ON parent.edge_id = tree.edge_id
             JOIN json_each(json_array(
               CASE WHEN parent.subject_kind = 'edge' THEN parent.subject_id END,
               CASE WHEN parent.object_kind = 'edge' THEN parent.object_id END
             )) child
            WHERE child.value IS NOT NULL
              AND tree.depth < 255
              AND instr(
                tree.path,
                char(0) || CAST(child.value AS TEXT) || char(0)
              ) = 0
         )
         SELECT DISTINCT edge.*
           FROM edge_tree
           JOIN twin_edges edge ON edge.edge_id = edge_tree.edge_id`
      )
      .all(JSON.stringify(rootEdgeIds)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const edge = mapTwinEdgeRow(row);
      edgeCache.set(edge.edge_id, edge);
      if (edge.subject_ref.kind !== 'edge') {
        nestedRefs.push(edge.subject_ref);
      }
      if (edge.object_ref.kind !== 'edge') {
        nestedRefs.push(edge.object_ref);
      }
    }
    for (const edgeId of rootEdgeIds) {
      if (!edgeCache.has(edgeId)) {
        edgeCache.set(edgeId, null);
      }
    }
  }
  return {
    edgeCache,
    precomputed: visibleTwinRefKeys(adapter, nestedRefs, visibility),
  };
}

export function visibleTwinRefKeysRecursive(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility
): Set<string> {
  const { edgeCache, precomputed } = preloadRecursiveEdgeVisibility(adapter, refs, visibility);
  const visible = new Set<string>();
  for (const ref of refs) {
    if (isTwinRefVisible(adapter, ref, visibility, new Set(), edgeCache, precomputed)) {
      visible.add(refVisibilityKey(ref));
    }
  }
  return visible;
}

function isTwinRefVisible(
  adapter: TwinRefVisibilityAdapter,
  ref: TwinRef,
  visibility: TwinVisibility,
  visitedEdges: Set<string>,
  edgeCache: Map<string, TwinEdgeRecord | null>,
  precomputed?: Set<string>
): boolean {
  if (precomputed && ref.kind !== 'edge') {
    return precomputed.has(refVisibilityKey(ref));
  }
  if (ref.kind === 'entity') {
    return isEntityVisible(adapter, ref.id, visibility);
  }
  if (ref.kind === 'report') {
    return !hasScopes(visibility.scopes);
  }
  if (ref.kind === 'memory') {
    return isMemoryVisible(adapter, ref.id, visibility);
  }
  if (ref.kind === 'case') {
    return isCaseVisible(adapter, ref.id, visibility);
  }
  if (ref.kind === 'raw') {
    return isRawVisible(adapter, ref.id, visibility);
  }
  if (ref.kind === 'registry') {
    const node = adapter.prepare('SELECT id FROM registry_nodes WHERE id = ?').get(ref.id);
    if (!node) {
      return false;
    }
    if (!hasScopes(visibility.scopes)) {
      return true;
    }
    return visibility.scopes.some((scope) =>
      Boolean(
        adapter
          .prepare(
            'SELECT 1 FROM registry_scope_bindings WHERE node_id = ? AND scope_kind = ? AND scope_id = ?'
          )
          .get(ref.id, scope.kind, scope.id)
      )
    );
  }
  if (ref.kind === 'observation') {
    const row = adapter
      .prepare('SELECT scope_json, observed_at FROM observation_versions WHERE observation_id = ?')
      .get(ref.id) as { scope_json: string; observed_at: number } | undefined;
    if (!row || !isWithinVisibilityTime(row.observed_at, visibility)) {
      return false;
    }
    return isObservationVersionVisible(adapter, ref.id, {
      principalId: visibility.principalId,
      agentId: visibility.agentId,
      scopes: visibility.scopes,
      connectors: visibility.connectors,
      channels: visibility.channels,
    });
  }
  if (ref.kind !== 'edge') {
    throw new Error(`UNSUPPORTED_REFERENCE_KIND: ${(ref as { kind: string }).kind}`);
  }

  if (visitedEdges.has(ref.id)) {
    return false;
  }
  let edge = edgeCache.get(ref.id);
  if (edge === undefined) {
    edge = getTwinEdge(adapter, ref.id);
    edgeCache.set(ref.id, edge);
  }
  if (!edge) {
    return false;
  }
  if (!isWithinVisibilityTime(edge.created_at, visibility)) {
    return false;
  }
  const pathWithCurrent = new Set(visitedEdges);
  pathWithCurrent.add(ref.id);
  return (
    isTwinRefVisible(
      adapter,
      edge.subject_ref,
      visibility,
      new Set(pathWithCurrent),
      edgeCache,
      precomputed
    ) &&
    isTwinRefVisible(
      adapter,
      edge.object_ref,
      visibility,
      new Set(pathWithCurrent),
      edgeCache,
      precomputed
    )
  );
}

export function assertTwinRefsVisible(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility = {}
): void {
  const supportedKinds = new Set([
    'memory',
    'case',
    'entity',
    'report',
    'edge',
    'raw',
    'registry',
    'observation',
  ]);
  for (const ref of refs) {
    if (!supportedKinds.has(ref.kind)) {
      throw new Error(`UNSUPPORTED_REFERENCE_KIND: ${(ref as { kind: string }).kind}`);
    }
  }
  const { edgeCache, precomputed } = preloadRecursiveEdgeVisibility(adapter, refs, visibility);
  for (const ref of refs) {
    if (!isTwinRefVisible(adapter, ref, visibility, new Set(), edgeCache, precomputed)) {
      throw new TwinRefNotVisibleError(ref);
    }
  }
}

export function listVisibleTwinEdgesForRefs(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  options: ListVisibleTwinEdgesOptions = {}
): TwinEdgeRecord[] {
  const edgeTypes = normalizeEdgeTypes(options.edgeTypes);
  const candidateEdges = listTwinEdgesForRefs(adapter, refs);
  const { edgeCache, precomputed } = preloadRecursiveEdgeVisibility(
    adapter,
    candidateEdges.flatMap((edge) => [edge.subject_ref, edge.object_ref]),
    options
  );
  const edges = candidateEdges.filter(
    (edge) =>
      (edgeTypes.size === 0 || edgeTypes.has(edge.edge_type)) &&
      (typeof options.startMs !== 'number' || edge.created_at >= options.startMs) &&
      (typeof options.asOfMs !== 'number' || edge.created_at <= options.asOfMs) &&
      isTwinRefVisible(adapter, edge.subject_ref, options, new Set(), edgeCache, precomputed) &&
      isTwinRefVisible(adapter, edge.object_ref, options, new Set(), edgeCache, precomputed)
  );
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : null;
  const sortedEdges = [...edges].sort((left, right) => {
    const createdDiff = right.created_at - left.created_at;
    return createdDiff !== 0 ? createdDiff : left.edge_id.localeCompare(right.edge_id);
  });
  if (limit === null) {
    return sortedEdges;
  }
  return sortedEdges.slice(0, limit);
}

function normalizeEdgeTypes(edgeTypes: readonly TwinEdgeType[] | undefined): Set<TwinEdgeType> {
  if (!Array.isArray(edgeTypes) || edgeTypes.length === 0) {
    return new Set();
  }
  return new Set(edgeTypes);
}
