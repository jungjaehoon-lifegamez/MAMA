import { observationScopes } from '../identity/erased-record.js';
import type { DatabaseAdapter } from '../db-manager.js';
import {
  isObservationVersionVisible,
  isObservationVisibilityRowVisible,
} from '../knowledge/observations.js';
import { getTwinEdge, listTwinEdgesForRefs, mapTwinEdgeRow, scopeIdFor } from './judgments.js';
import type {
  ListVisibleTwinEdgesOptions,
  TwinEdgeRecord,
  TwinEdgeType,
  TwinProjectRef,
  TwinRef,
  TwinScopeRef,
  TwinVisibility,
} from './twin-edge-types.js';

type TwinRefVisibilityAdapter = Pick<DatabaseAdapter, 'prepare'>;

const TABLE_COLUMN_PRAGMAS: Record<string, string> = {
  decisions: 'PRAGMA table_info(decisions)',
  case_truth: 'PRAGMA table_info(case_truth)',
};
const tableColumnCache = new WeakMap<TwinRefVisibilityAdapter, Map<string, Set<string>>>();
// Keep memory-truth quarantine semantics excluded for legacy/backcompat rows even though the
// decisions.status terminal states: 'superseded' is history a caller holding
// scope may read under includeReplaced; the rest are holds excluded always.
const RETIRED_MEMORY_STATUSES = new Set(['contradicted', 'stale']);

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

/** History consent follows a commitment's current head, never the records its revisions link to. */
export function isCommitmentRevisionReadable(
  adapter: TwinRefVisibilityAdapter,
  recordId: string,
  admittedScopeIds: readonly string[]
): boolean {
  return (
    adapter
      .prepare(
        `SELECT 1 FROM commitment_assignments assignment
     JOIN commitments commitment ON commitment.commitment_id = assignment.commitment_id
     JOIN decisions head ON head.id = commitment.head_record_id
     WHERE assignment.record_id = ? AND (
       NOT EXISTS (SELECT 1 FROM memory_scope_bindings binding WHERE binding.memory_id = head.id)
       ${
         admittedScopeIds.length === 0
           ? ''
           : `OR EXISTS (
         SELECT 1 FROM memory_scope_bindings binding WHERE binding.memory_id = head.id
           AND binding.scope_id IN (${admittedScopeIds.map(() => '?').join(', ')})
       )`
       }
     ) LIMIT 1`
      )
      .get(recordId, ...admittedScopeIds) !== undefined
  );
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
  const replaced =
    status === 'superseded' ||
    (typeof row.superseded_by === 'string' && row.superseded_by.length > 0);
  if (RETIRED_MEMORY_STATUSES.has(status) || (replaced && !visibility.includeReplaced)) {
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

  if (isCommitmentRevisionReadable(adapter, id, scopes.map(scopeIdFor))) return true;

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
  const maxSourceMs = visibility.maxSourceMs ?? null;
  if (maxSourceMs !== null) {
    if (!Number.isSafeInteger(maxSourceMs) || maxSourceMs < 0) {
      throw new Error('Raw source ceiling must be a nonnegative epoch-millisecond integer');
    }
    const sourceAt = parseTimestamp(row.source_at);
    if (sourceAt === null || sourceAt > maxSourceMs) return false;
  }
  const rawTs = row.observation_observed_at ?? row.event_datetime ?? row.source_timestamp_ms;
  if (rawTs === null || rawTs === undefined || (typeof rawTs === 'string' && rawTs.trim() === '')) {
    return false;
  }
  const eventTsMs = parseTimestamp(rawTs);
  return eventTsMs !== null && eventTsMs >= 0 && isWithinVisibilityTime(eventTsMs, visibility);
}

/**
 * A `raw` ref resolves against observations, the same as an `observation` ref.
 *
 * There is one evidence space in the core. `raw` was the spelling from when the
 * connector event index WAS the substrate -- the schema still shows it, allowing
 * `raw` as an edge object and never as a subject, while `observation` is allowed
 * on both sides. A ref that does not name an observation does not name evidence
 * this core can vouch for, and is not visible.
 */
function isRawVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const row = adapter
    .prepare(
      `SELECT source, channel, project_id, tenant_id, memory_scope_kind, memory_scope_id, source_at,
              observed_at AS observation_observed_at, erased_at, scope_json
         FROM observation_versions
        WHERE observation_id = ?
        LIMIT 1`
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? isRawRowVisible(row, visibility) : false;
}

/** One observation row, judged against the caller's window. */
function isRawRowVisible(row: Record<string, unknown>, visibility: TwinVisibility): boolean {
  if (Array.isArray(visibility.connectors) && !visibility.connectors.includes(String(row.source))) {
    return false;
  }

  if (visibility.connectorWideRead?.includes(String(row.source))) {
    return isRawWithinTime(row, visibility);
  }

  // The grant decides, and it decides the same way here as in the reader - one rule, taken
  // from one place. The scope/project/tenant clauses below are the pre-grant rule and are
  // skipped when a grant is present, exactly as the reader skips them, because applying
  // both would make a cited ref satisfy a stricter test than a read one.
  if (visibility.channels) {
    return (
      isChannelGranted(
        String(row.source),
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

  if (typeof row.erased_at === 'number') {
    return observationScopes(row).some((scope) =>
      visibility.scopes?.some(
        (admitted) => admitted.kind === scope.kind && admitted.id === scope.id
      )
    );
  }
  if (!hasScopes(visibility.scopes)) {
    return true;
  }
  return visibility.scopes.some(
    (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
  );
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
        `SELECT observation_id, source, channel, project_id, tenant_id,
                memory_scope_kind, memory_scope_id, source_at,
                observed_at AS observation_observed_at, erased_at, scope_json
           FROM observation_versions
          WHERE observation_id IN (${placeholders(rawIds.length)})`
      )
      .all(...rawIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (isRawRowVisible(row, visibility)) {
        visible.add(refVisibilityKey({ kind: 'raw', id: String(row.observation_id) }));
      }
    }
  }

  const observationIds = ids('observation');
  if (observationIds.length > 0) {
    const rows = adapter
      .prepare(
        `SELECT observation_id, source, scope_json, observed_at, source_at, erased_at
           FROM observation_versions
          WHERE observation_id IN (${placeholders(observationIds.length)})`
      )
      .all(...observationIds) as Array<{
      observation_id: string;
      source: unknown;
      scope_json: unknown;
      observed_at: number;
      source_at: number | null;
      erased_at: number | null;
    }>;
    for (const row of rows) {
      if (
        isWithinVisibilityTime(row.observed_at, visibility) &&
        isObservationVisibilityRowVisible(row, {
          principalId: visibility.principalId,
          agentId: visibility.agentId,
          scopes: visibility.scopes,
          connectors: visibility.connectors,
          connectorWideRead: visibility.connectorWideRead,
          channels: visibility.channels,
          maxSourceMs: visibility.maxSourceMs,
        })
      ) {
        visible.add(refVisibilityKey({ kind: 'observation', id: row.observation_id }));
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
    // Scope ids for the revision-history check, built once for the batch; that check runs only for
    // a row no binding or legacy column admits.
    const admittedScopeIds = hasScopes(visibility.scopes) ? visibility.scopes.map(scopeIdFor) : [];
    for (const row of rows) {
      const id = String(row.id);
      const status = typeof row.status === 'string' ? row.status : 'active';
      const replaced =
        status === 'superseded' ||
        (typeof row.superseded_by === 'string' && row.superseded_by.length > 0);
      const retired =
        RETIRED_MEMORY_STATUSES.has(status) || (replaced && !visibility.includeReplaced);
      const scopeVisible =
        !hasScopes(visibility.scopes) ||
        admittedBindings.has(id) ||
        (columns.has('memory_scope_kind') &&
          columns.has('memory_scope_id') &&
          visibility.scopes.some(
            (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
          )) ||
        isCommitmentRevisionReadable(adapter, id, admittedScopeIds);
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
    // `created_at` is read, not just `id`: a registry ref must have existed at the requested
    // `as_of`, the same rule memory, raw and observation refs obey. The entity branch this
    // replaced applied it (`isWithinVisibilityTime(row.created_at, visibility)`) and the
    // replacement dropped it, so a packet could cite a node created after the boundary.
    //
    // A merged-away node is NOT excluded. Merging redirects identity, it does not retire the
    // node, and the graph projection's contract is to keep the ORIGINAL ref citable while
    // resolving the current one beside it (design section 4.1, original/corrected references).
    // Filtering on `merged_into IS NULL` here broke exactly that - caught by
    // agent-graph.test.ts.
    const rows = adapter
      .prepare(
        `SELECT id, created_at FROM registry_nodes
          WHERE id IN (${placeholders(registryIds.length)})`
      )
      .all(...registryIds) as Array<{ id: string; created_at: number }>;
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
      if (
        isWithinVisibilityTime(row.created_at, visibility) &&
        (!hasScopes(visibility.scopes) || admitted.has(row.id))
      ) {
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
  edgeVisibility: Map<string, boolean>;
  precomputed: Set<string>;
} {
  const edgeCache = new Map<string, TwinEdgeRecord | null>();
  const rootEdgeIds = [...new Set(refs.filter((ref) => ref.kind === 'edge').map((ref) => ref.id))];
  const nestedRefs: TwinRef[] = refs.filter((ref) => ref.kind !== 'edge');
  if (rootEdgeIds.length > 0) {
    const rows = adapter
      .prepare(
        `WITH RECURSIVE edge_tree(edge_id) AS (
           SELECT CAST(value AS TEXT)
             FROM json_each(?)
           UNION
           SELECT CAST(child.value AS TEXT)
             FROM edge_tree tree
             JOIN twin_edges parent ON parent.edge_id = tree.edge_id
             JOIN json_each(json_array(
               CASE WHEN parent.subject_kind = 'edge' THEN parent.subject_id END,
               CASE WHEN parent.object_kind = 'edge' THEN parent.object_id END
             )) child
            WHERE child.value IS NOT NULL
         )
         SELECT edge.*
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
    edgeVisibility: new Map(),
    precomputed: visibleTwinRefKeys(adapter, nestedRefs, visibility),
  };
}

export function visibleTwinRefKeysRecursive(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility
): Set<string> {
  const { edgeCache, edgeVisibility, precomputed } = preloadRecursiveEdgeVisibility(
    adapter,
    refs,
    visibility
  );
  const visible = new Set<string>();
  for (const ref of refs) {
    if (
      isTwinRefVisible(adapter, ref, visibility, new Set(), edgeCache, edgeVisibility, precomputed)
    ) {
      visible.add(refVisibilityKey(ref));
    }
  }
  return visible;
}

function isTwinRefVisible(
  adapter: TwinRefVisibilityAdapter,
  ref: TwinRef,
  visibility: TwinVisibility,
  edgesInProgress: Set<string>,
  edgeCache: Map<string, TwinEdgeRecord | null>,
  edgeVisibility: Map<string, boolean>,
  precomputed?: Set<string>
): boolean {
  if (precomputed && ref.kind !== 'edge') {
    return precomputed.has(refVisibilityKey(ref));
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
    const node = adapter
      .prepare('SELECT created_at FROM registry_nodes WHERE id = ?')
      .get(ref.id) as { created_at: number } | undefined;
    if (!node || !isWithinVisibilityTime(node.created_at, visibility)) {
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
      .prepare(
        'SELECT scope_json, observed_at, source_at FROM observation_versions WHERE observation_id = ?'
      )
      .get(ref.id) as
      | { scope_json: string; observed_at: number; source_at: number | null }
      | undefined;
    if (!row || !isWithinVisibilityTime(row.observed_at, visibility)) {
      return false;
    }
    return isObservationVersionVisible(adapter, ref.id, {
      principalId: visibility.principalId,
      agentId: visibility.agentId,
      scopes: visibility.scopes,
      connectors: visibility.connectors,
      connectorWideRead: visibility.connectorWideRead,
      channels: visibility.channels,
      maxSourceMs: visibility.maxSourceMs,
    });
  }
  if (ref.kind !== 'edge') {
    throw new Error(`UNSUPPORTED_REFERENCE_KIND: ${(ref as { kind: string }).kind}`);
  }

  // An edge met again while it is being decided lies on a cycle through itself: never visible.
  // Every edge on such a cycle is invisible from any root, so a finished answer is memoized.
  if (edgesInProgress.has(ref.id)) {
    return false;
  }
  const decided = edgeVisibility.get(ref.id);
  if (decided !== undefined) {
    return decided;
  }
  let edge = edgeCache.get(ref.id);
  if (edge === undefined) {
    edge = getTwinEdge(adapter, ref.id);
    edgeCache.set(ref.id, edge);
  }
  if (!edge || !isWithinVisibilityTime(edge.created_at, visibility)) {
    edgeVisibility.set(ref.id, false);
    return false;
  }
  edgesInProgress.add(ref.id);
  const visible =
    isTwinRefVisible(
      adapter,
      edge.subject_ref,
      visibility,
      edgesInProgress,
      edgeCache,
      edgeVisibility,
      precomputed
    ) &&
    isTwinRefVisible(
      adapter,
      edge.object_ref,
      visibility,
      edgesInProgress,
      edgeCache,
      edgeVisibility,
      precomputed
    );
  edgesInProgress.delete(ref.id);
  edgeVisibility.set(ref.id, visible);
  return visible;
}

export function assertTwinRefsVisible(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility = {}
): void {
  const supportedKinds = new Set([
    'memory',
    'case',
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
  const { edgeCache, edgeVisibility, precomputed } = preloadRecursiveEdgeVisibility(
    adapter,
    refs,
    visibility
  );
  for (const ref of refs) {
    if (
      !isTwinRefVisible(adapter, ref, visibility, new Set(), edgeCache, edgeVisibility, precomputed)
    ) {
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
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : null;
  if (limit === 0) {
    return [];
  }
  if (limit !== null) {
    const pageSize = Math.min(2000, Math.max(128, limit * 2));
    const admitted: TwinEdgeRecord[] = [];
    let after: { createdAt: number; edgeId: string } | undefined;
    while (admitted.length < limit) {
      const candidates = listTwinEdgesForRefs(adapter, refs, {
        newest: true,
        limit: pageSize,
        ...(after ? { after } : {}),
        ...(edgeTypes.size > 0 ? { edgeTypes: [...edgeTypes] } : {}),
        startMs: options.startMs,
        asOfMs: options.asOfMs,
      });
      if (candidates.length === 0) {
        break;
      }
      const { edgeCache, edgeVisibility, precomputed } = preloadRecursiveEdgeVisibility(
        adapter,
        candidates.flatMap((edge) => [edge.subject_ref, edge.object_ref]),
        options
      );
      for (const edge of candidates) {
        if (
          isTwinRefVisible(
            adapter,
            edge.subject_ref,
            options,
            new Set(),
            edgeCache,
            edgeVisibility,
            precomputed
          ) &&
          isTwinRefVisible(
            adapter,
            edge.object_ref,
            options,
            new Set(),
            edgeCache,
            edgeVisibility,
            precomputed
          )
        ) {
          admitted.push(edge);
          if (admitted.length === limit) {
            return admitted;
          }
        }
      }
      if (candidates.length < pageSize) {
        break;
      }
      const last = candidates[candidates.length - 1];
      after = { createdAt: last.created_at, edgeId: last.edge_id };
    }
    return admitted;
  }
  const candidateEdges = listTwinEdgesForRefs(adapter, refs);
  const { edgeCache, edgeVisibility, precomputed } = preloadRecursiveEdgeVisibility(
    adapter,
    candidateEdges.flatMap((edge) => [edge.subject_ref, edge.object_ref]),
    options
  );
  const edges = candidateEdges.filter(
    (edge) =>
      (edgeTypes.size === 0 || edgeTypes.has(edge.edge_type)) &&
      (typeof options.startMs !== 'number' || edge.created_at >= options.startMs) &&
      (typeof options.asOfMs !== 'number' || edge.created_at <= options.asOfMs) &&
      isTwinRefVisible(
        adapter,
        edge.subject_ref,
        options,
        new Set(),
        edgeCache,
        edgeVisibility,
        precomputed
      ) &&
      isTwinRefVisible(
        adapter,
        edge.object_ref,
        options,
        new Set(),
        edgeCache,
        edgeVisibility,
        precomputed
      )
  );
  const sortedEdges = [...edges].sort((left, right) => {
    const createdDiff = right.created_at - left.created_at;
    return createdDiff !== 0 ? createdDiff : left.edge_id.localeCompare(right.edge_id);
  });
  return sortedEdges;
}

function normalizeEdgeTypes(edgeTypes: readonly TwinEdgeType[] | undefined): Set<TwinEdgeType> {
  if (!Array.isArray(edgeTypes) || edgeTypes.length === 0) {
    return new Set();
  }
  return new Set(edgeTypes);
}

// --- The raw visibility rule ---------------------------------------------------
//
// There were three copies of this decision. The reader had one, twin-ref validation had a
// second, and the product's citation path had a third carrying a comment that promised it
// reproduced the reader "clause for clause" -- which it did, until the reader changed. The
// differential test meant to catch that kept passing, because its fixtures never exercised
// the branch production takes. Copies pinned by a test are still copies; the test just
// tells you later.
//
// It has to exist in two compiled forms -- a boolean for a row you already hold, and SQL
// for rows you do not -- and those two are adjacent here with a differential over a matrix
// that includes what production sends. Two forms of one rule is the irreducible minimum.

/** Connector -> the channels of it that may be read. */
export type ChannelGrant = Record<string, readonly string[]>;

/**
 * The rule: an event is visible when its connector is granted and its channel is one of
 * the channels granted for that connector.
 *
 * A connector absent from the grant is denied. A connector present with an empty list is
 * also denied - "granted the connector but no channel of it" is not a useful state, and
 * reading it as "all channels" is how a grant becomes a wildcard.
 */
export function isChannelGranted(
  connector: string,
  channel: string | null | undefined,
  grant: ChannelGrant
): boolean {
  if (typeof channel !== 'string' || channel.length === 0) return false;
  const channels = grant[connector];
  return Array.isArray(channels) && channels.includes(channel);
}

export interface ChannelGrantClause {
  sql: string;
  params: unknown[];
}

/**
 * The same rule as a SQL predicate.
 *
 * Returns null when nothing is readable, which callers must treat as "select nothing"
 * rather than "no filter" - an empty WHERE is how a visibility rule turns into a full scan
 * at the exact moment it should have refused.
 *
 * `requestedConnectors` narrows further: a connector the caller did not ask for is not read
 * even though it is granted. The grant is a ceiling, never an instruction.
 */
export function channelGrantClause(
  grant: ChannelGrant,
  requestedConnectors: readonly string[] | undefined,
  columns: { connector: string; channel: string }
): ChannelGrantClause | null {
  const pairs: string[] = [];
  const params: unknown[] = [];
  for (const [connector, channels] of Object.entries(grant)) {
    if (Array.isArray(requestedConnectors) && !requestedConnectors.includes(connector)) continue;
    // Array.isArray, not `?? []`: the boolean form denies a malformed grant quietly, so
    // this one must not throw on it. Two forms of a rule that disagree on bad input have
    // already started to be two rules.
    if (!Array.isArray(channels)) continue;
    const unique = [
      ...new Set(channels.filter((channel) => typeof channel === 'string' && channel.length > 0)),
    ];
    if (unique.length === 0) continue;
    pairs.push(
      `(${columns.connector} = ? AND ${columns.channel} IN (${unique.map(() => '?').join(', ')}))`
    );
    params.push(connector, ...unique);
  }
  return pairs.length === 0 ? null : { sql: `(${pairs.join(' OR ')})`, params };
}
