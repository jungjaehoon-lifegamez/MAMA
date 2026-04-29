import type { DatabaseAdapter } from '../db-manager.js';
import { getTwinEdge, listTwinEdgesForRefs } from './store.js';
import type {
  ListVisibleTwinEdgesOptions,
  TwinEdgeRecord,
  TwinEdgeType,
  TwinRef,
  TwinScopeRef,
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

function memoryExists(adapter: TwinRefVisibilityAdapter, id: string): boolean {
  const row = adapter.prepare('SELECT 1 AS ok FROM decisions WHERE id = ? LIMIT 1').get(id) as
    | { ok: number }
    | undefined;
  return Boolean(row?.ok);
}

function isMemoryVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  scopes: readonly TwinScopeRef[] | undefined
): boolean {
  if (!memoryExists(adapter, id)) {
    return false;
  }
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
  scopes: readonly TwinScopeRef[] | undefined
): boolean {
  const row = adapter.prepare('SELECT * FROM case_truth WHERE case_id = ? LIMIT 1').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return false;
  }
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
  scopes: readonly TwinScopeRef[] | undefined
): boolean {
  const row = adapter
    .prepare('SELECT * FROM connector_event_index WHERE event_index_id = ? LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some(
    (scope) => row.memory_scope_kind === scope.kind && row.memory_scope_id === scope.id
  );
}

function isEntityVisible(
  adapter: TwinRefVisibilityAdapter,
  id: string,
  scopes: readonly TwinScopeRef[] | undefined
): boolean {
  const row = adapter
    .prepare('SELECT scope_kind, scope_id FROM entity_nodes WHERE id = ? AND status = ? LIMIT 1')
    .get(id, 'active') as
    | {
        scope_kind: string | null;
        scope_id: string | null;
      }
    | undefined;
  if (!row) {
    return false;
  }
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some((scope) => row.scope_kind === scope.kind && row.scope_id === scope.id);
}

function isTwinRefVisible(
  adapter: TwinRefVisibilityAdapter,
  ref: TwinRef,
  scopes: readonly TwinScopeRef[] | undefined,
  visitedEdges: Set<string>,
  edgeCache: Map<string, TwinEdgeRecord | null>
): boolean {
  if (ref.kind === 'entity') {
    return isEntityVisible(adapter, ref.id, scopes);
  }
  if (ref.kind === 'report') {
    return !hasScopes(scopes);
  }
  if (ref.kind === 'memory') {
    return isMemoryVisible(adapter, ref.id, scopes);
  }
  if (ref.kind === 'case') {
    return isCaseVisible(adapter, ref.id, scopes);
  }
  if (ref.kind === 'raw') {
    return isRawVisible(adapter, ref.id, scopes);
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
  const pathWithCurrent = new Set(visitedEdges);
  pathWithCurrent.add(ref.id);
  return (
    isTwinRefVisible(adapter, edge.subject_ref, scopes, new Set(pathWithCurrent), edgeCache) &&
    isTwinRefVisible(adapter, edge.object_ref, scopes, new Set(pathWithCurrent), edgeCache)
  );
}

export function assertTwinRefsVisibleToScopes(
  adapter: TwinRefVisibilityAdapter,
  refs: readonly TwinRef[],
  scopes?: TwinScopeRef[]
): void {
  const edgeCache = new Map<string, TwinEdgeRecord | null>();
  for (const ref of refs) {
    if (!isTwinRefVisible(adapter, ref, scopes, new Set(), edgeCache)) {
      throw new Error(`Twin ref is not visible to requested scopes: ${ref.kind}:${ref.id}`);
    }
  }
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
      isTwinRefVisible(adapter, edge.subject_ref, options.scopes, new Set(), edgeCache) &&
      isTwinRefVisible(adapter, edge.object_ref, options.scopes, new Set(), edgeCache)
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
