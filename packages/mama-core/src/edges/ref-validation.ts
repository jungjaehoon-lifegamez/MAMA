import type { DatabaseAdapter } from '../db-manager.js';
import { getTwinEdge, listTwinEdgesForRefs } from './store.js';
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

function scopeKey(scope: TwinScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

function hasScopes(scopes: readonly TwinScopeRef[] | undefined): scopes is TwinScopeRef[] {
  return Array.isArray(scopes) && scopes.length > 0;
}

function hasConnectors(connectors: readonly string[] | undefined): connectors is string[] {
  return Array.isArray(connectors) && connectors.length > 0;
}

function hasProjectRefs(
  projectRefs: readonly TwinProjectRef[] | undefined
): projectRefs is TwinProjectRef[] {
  return Array.isArray(projectRefs) && projectRefs.length > 0;
}

function visibilityFromScopes(scopes: readonly TwinScopeRef[] | undefined): TwinVisibility {
  return { scopes: scopes ? [...scopes] : undefined };
}

function asOfMs(visibility: TwinVisibility): number | null {
  return typeof visibility.asOfMs === 'number' ? visibility.asOfMs : null;
}

function isAtOrBeforeAsOf(value: number | null | undefined, visibility: TwinVisibility): boolean {
  const asOf = asOfMs(visibility);
  return asOf === null || (typeof value === 'number' && value <= asOf);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
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
  const row = adapter
    .prepare(
      `
        SELECT created_at, event_datetime
        FROM decisions
        WHERE id = ?
        LIMIT 1
      `
    )
    .get(id) as { created_at: number; event_datetime: number | null } | undefined;
  if (!row) {
    return false;
  }
  if (!isAtOrBeforeAsOf(row.event_datetime ?? row.created_at, visibility)) {
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

  const columns = tableColumns(adapter, 'decisions');
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
  if (!isAtOrBeforeAsOf(timestamp, visibility)) {
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

function isRawVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  visibility: TwinVisibility
): boolean {
  const row = adapter
    .prepare('SELECT * FROM connector_event_index WHERE event_index_id = ? LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }

  if (
    hasConnectors(visibility.connectors) &&
    !visibility.connectors.includes(String(row.source_connector))
  ) {
    return false;
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

  if (!isAtOrBeforeAsOf(Number(row.event_datetime ?? row.source_timestamp_ms), visibility)) {
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
  if (!isAtOrBeforeAsOf(row.created_at, visibility)) {
    return false;
  }
  const scopes = visibility.scopes;
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some((scope) => row.scope_kind === scope.kind && row.scope_id === scope.id);
}

function isTwinRefVisible(
  adapter: TwinRefVisibilityAdapter,
  ref: TwinRef,
  visibility: TwinVisibility,
  visitedEdges: Set<string>,
  edgeCache: Map<string, TwinEdgeRecord | null>
): boolean {
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
  if (!isAtOrBeforeAsOf(edge.created_at, visibility)) {
    return false;
  }
  const pathWithCurrent = new Set(visitedEdges);
  pathWithCurrent.add(ref.id);
  return (
    isTwinRefVisible(adapter, edge.subject_ref, visibility, new Set(pathWithCurrent), edgeCache) &&
    isTwinRefVisible(adapter, edge.object_ref, visibility, new Set(pathWithCurrent), edgeCache)
  );
}

export function assertTwinRefsVisible(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility = {}
): void {
  const edgeCache = new Map<string, TwinEdgeRecord | null>();
  for (const ref of refs) {
    if (!isTwinRefVisible(adapter, ref, visibility, new Set(), edgeCache)) {
      throw new Error(`Twin ref is not visible to requested visibility: ${ref.kind}:${ref.id}`);
    }
  }
}

export function assertTwinRefsVisibleToScopes(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  scopes?: TwinScopeRef[]
): void {
  assertTwinRefsVisible(adapter, refs, visibilityFromScopes(scopes));
}

export function listVisibleTwinEdgesForRefs(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  options: ListVisibleTwinEdgesOptions = {}
): TwinEdgeRecord[] {
  const edgeCache = new Map<string, TwinEdgeRecord | null>();
  const edgeTypes = normalizeEdgeTypes(options.edgeTypes);
  const edges = listTwinEdgesForRefs(adapter, refs).filter(
    (edge) =>
      (edgeTypes.size === 0 || edgeTypes.has(edge.edge_type)) &&
      (typeof options.asOfMs !== 'number' || edge.created_at <= options.asOfMs) &&
      isTwinRefVisible(adapter, edge.subject_ref, options, new Set(), edgeCache) &&
      isTwinRefVisible(adapter, edge.object_ref, options, new Set(), edgeCache)
  );
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : edges.length;
  return edges.slice(0, limit);
}

function normalizeEdgeTypes(edgeTypes: readonly TwinEdgeType[] | undefined): Set<TwinEdgeType> {
  if (!Array.isArray(edgeTypes) || edgeTypes.length === 0) {
    return new Set();
  }
  return new Set(edgeTypes);
}
