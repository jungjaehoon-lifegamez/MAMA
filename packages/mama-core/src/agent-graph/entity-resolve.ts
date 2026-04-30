import { assertTwinRefsVisible, listVisibleTwinEdgesForRefs } from '../edges/ref-validation.js';
import { normalizeEntityLabel } from '../entities/normalization.js';
import { EntityMergeError, getEntityNode, resolveCanonicalEntityId } from '../entities/store.js';
import type { EntityNode } from '../entities/types.js';
import {
  TWIN_REF_KINDS,
  type TwinRef,
  type TwinScopeRef,
  type TwinVisibility,
} from '../edges/types.js';
import type {
  AgentGraphAdapter,
  ResolveEntityInput,
  ResolveEntityResult,
  ResolvedEntityCandidate,
} from './types.js';
import { AgentGraphValidationError } from './errors.js';

const TWIN_REF_KIND_SET = new Set<string>(TWIN_REF_KINDS);

function hasScopes(scopes: readonly TwinScopeRef[] | undefined): scopes is TwinScopeRef[] {
  return Array.isArray(scopes) && scopes.length > 0;
}

function normalizeLabel(value: string): string {
  try {
    return normalizeEntityLabel(value).normalized;
  } catch (error) {
    throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
  }
}

function entityVisible(entity: EntityNode, scopes: readonly TwinScopeRef[] | undefined): boolean {
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some((scope) => entity.scope_kind === scope.kind && entity.scope_id === scope.id);
}

function isAtOrBeforeAsOf(value: number, asOfMs: number | null | undefined): boolean {
  return typeof asOfMs !== 'number' || value <= asOfMs;
}

function scopeVisible(
  scopeKind: string | null,
  scopeId: string | null,
  scopes: readonly TwinScopeRef[] | undefined
): boolean {
  if (!hasScopes(scopes)) {
    return true;
  }
  return scopes.some((scope) => scope.kind === scopeKind && scope.id === scopeId);
}

function connectorVisible(connector: string, connectors: readonly string[] | undefined): boolean {
  return !connectors || connectors.length === 0 || connectors.includes(connector);
}

function hasProjectOrTenantFilter(visibility: TwinVisibility): boolean {
  return (
    (Array.isArray(visibility.projectRefs) && visibility.projectRefs.length > 0) ||
    (typeof visibility.tenantId === 'string' && visibility.tenantId.length > 0)
  );
}

function refsVisible(
  adapter: AgentGraphAdapter,
  refs: readonly TwinRef[],
  visibility: TwinVisibility
): boolean {
  if (refs.length === 0) {
    return true;
  }
  try {
    assertTwinRefsVisible(adapter, refs, visibility);
    return true;
  } catch {
    return false;
  }
}

function parseSourceRefs(value: unknown, context: string): TwinRef[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}.source_refs must be an array.`);
  }
  const refs: TwinRef[] = [];
  for (const item of value) {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).kind !== 'string' ||
      typeof (item as Record<string, unknown>).id !== 'string'
    ) {
      throw new Error(`${context}.source_refs entries must be TwinRef objects.`);
    }
    const kind = (item as { kind: string }).kind;
    const id = (item as { id: string }).id.trim();
    if (!TWIN_REF_KIND_SET.has(kind) || id.length === 0) {
      throw new Error(`${context}.source_refs contains an invalid TwinRef.`);
    }
    refs.push({ kind, id } as TwinRef);
  }
  return refs;
}

function aliasSourceRefs(adapter: AgentGraphAdapter, aliasId: string, entityId: string): TwinRef[] {
  const rows = adapter
    .prepare(
      `
        SELECT relation_attrs_json
        FROM twin_edges
        WHERE edge_type = 'alias_of'
          AND subject_kind = 'entity'
          AND subject_id = ?
          AND object_kind = 'entity'
          AND object_id = ?
          AND relation_attrs_json IS NOT NULL
        ORDER BY created_at DESC, edge_id ASC
      `
    )
    .all(entityId, entityId) as Array<{ relation_attrs_json: string | null }>;

  const refs: TwinRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.relation_attrs_json) {
      continue;
    }
    const parsed = JSON.parse(row.relation_attrs_json) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as Record<string, unknown>).alias_id !== aliasId
    ) {
      continue;
    }
    for (const ref of parseSourceRefs(
      (parsed as Record<string, unknown>).source_refs,
      `alias ${aliasId}`
    )) {
      const key = `${ref.kind}:${ref.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
    }
  }
  return refs;
}

function aliasVisible(
  adapter: AgentGraphAdapter,
  row: { id: string; entity_id: string; source_type: string; created_at: number },
  visibility: TwinVisibility,
  asOfMs: number | null | undefined
): boolean {
  if (!isAtOrBeforeAsOf(row.created_at, asOfMs)) {
    return false;
  }
  const sourceRefs = aliasSourceRefs(adapter, row.id, row.entity_id);
  if (row.source_type === 'agent' && sourceRefs.length === 0) {
    return false;
  }
  return refsVisible(adapter, sourceRefs, visibility);
}

function rawRefForObservation(
  adapter: AgentGraphAdapter,
  row: { source_connector: string; source_raw_record_id: string }
): TwinRef | null {
  const raw = adapter
    .prepare(
      `
        SELECT event_index_id
        FROM connector_event_index
        WHERE event_index_id = ?
           OR (source_connector = ? AND source_id = ?)
        ORDER BY CASE WHEN event_index_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `
    )
    .get(
      row.source_raw_record_id,
      row.source_connector,
      row.source_raw_record_id,
      row.source_raw_record_id
    ) as { event_index_id: string } | undefined;
  return raw ? { kind: 'raw', id: raw.event_index_id } : null;
}

function observationVisible(
  adapter: AgentGraphAdapter,
  row: {
    scope_kind: string | null;
    scope_id: string | null;
    source_connector: string;
    source_raw_record_id: string;
    timestamp_observed: number | null;
    created_at: number;
  },
  visibility: TwinVisibility,
  asOfMs: number | null | undefined
): boolean {
  if (!isAtOrBeforeAsOf(row.timestamp_observed ?? row.created_at, asOfMs)) {
    return false;
  }
  if (!scopeVisible(row.scope_kind, row.scope_id, visibility.scopes)) {
    return false;
  }
  if (!connectorVisible(row.source_connector, visibility.connectors)) {
    return false;
  }
  const rawRef = rawRefForObservation(adapter, row);
  if (!rawRef) {
    return !hasProjectOrTenantFilter(visibility);
  }
  return refsVisible(adapter, [rawRef], visibility);
}

function canonicalEntity(adapter: AgentGraphAdapter, entityId: string): EntityNode | null {
  try {
    const canonicalId = resolveCanonicalEntityId(adapter, entityId);
    const entity = getEntityNode(canonicalId, adapter);
    return entity && entity.status === 'active' ? entity : null;
  } catch (error) {
    if (error instanceof EntityMergeError) {
      throw new AgentGraphValidationError(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

function contextBoost(
  adapter: AgentGraphAdapter,
  entityId: string,
  contextRefs: readonly TwinRef[] | undefined,
  visibility: TwinVisibility,
  asOfMs: number | null | undefined
): number {
  if (!contextRefs || contextRefs.length === 0) {
    return 0;
  }
  const edges = listVisibleTwinEdgesForRefs(adapter, contextRefs, {
    scopes: visibility.scopes,
    connectors: visibility.connectors,
    projectRefs: visibility.projectRefs,
    tenantId: visibility.tenantId,
    asOfMs,
  });
  return edges.some(
    (edge) =>
      (edge.subject_ref.kind === 'entity' && edge.subject_ref.id === entityId) ||
      (edge.object_ref.kind === 'entity' && edge.object_ref.id === entityId)
  )
    ? 0.2
    : 0;
}

export function resolveEntity(
  adapter: AgentGraphAdapter,
  input: ResolveEntityInput
): ResolveEntityResult {
  const normalized = normalizeLabel(input.label);
  const limit = Math.max(1, Math.floor(input.limit ?? 5));
  const visibility: TwinVisibility = {
    scopes: input.scopes,
    connectors: input.connectors,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
    asOfMs: input.as_of_ms,
  };
  if (input.context_refs && input.context_refs.length > 0) {
    try {
      assertTwinRefsVisible(adapter, input.context_refs, visibility);
    } catch (error) {
      throw new AgentGraphValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  const candidates = new Map<string, ResolvedEntityCandidate>();
  const recordCandidate = (
    entityId: string,
    matchedLabel: string,
    matchSource: ResolvedEntityCandidate['match_source'],
    baseScore: number
  ): void => {
    const entity = canonicalEntity(adapter, entityId);
    if (
      !entity ||
      !entityVisible(entity, input.scopes) ||
      !isAtOrBeforeAsOf(entity.created_at, input.as_of_ms)
    ) {
      return;
    }
    const score =
      baseScore + contextBoost(adapter, entity.id, input.context_refs, visibility, input.as_of_ms);
    const existing = candidates.get(entity.id);
    if (!existing || score > existing.score) {
      candidates.set(entity.id, {
        entity,
        matched_label: matchedLabel,
        match_source: matchSource,
        score,
      });
    }
  };

  const nodeRows = adapter
    .prepare(
      `
        SELECT id, preferred_label
        FROM entity_nodes
        WHERE status = 'active'
      `
    )
    .all() as Array<{ id: string; preferred_label: string }>;
  for (const row of nodeRows) {
    if (normalizeLabel(row.preferred_label) === normalized) {
      recordCandidate(row.id, row.preferred_label, 'preferred_label', 1);
    }
  }

  const aliasRows = adapter
    .prepare(
      `
        SELECT id, entity_id, label, normalized_label, source_type, created_at
        FROM entity_aliases
        WHERE status = 'active'
      `
    )
    .all() as Array<{
    id: string;
    entity_id: string;
    label: string;
    normalized_label: string;
    source_type: string;
    created_at: number;
  }>;
  for (const row of aliasRows) {
    if (
      aliasVisible(adapter, row, visibility, input.as_of_ms) &&
      (row.normalized_label === normalized || normalizeLabel(row.label) === normalized)
    ) {
      recordCandidate(row.entity_id, row.label, 'alias', 0.95);
    }
  }

  const observationRows = adapter
    .prepare(
      `
        SELECT
          l.canonical_entity_id, o.surface_form, o.normalized_form,
          o.scope_kind, o.scope_id, o.source_connector, o.source_raw_record_id,
          o.timestamp_observed, o.created_at
        FROM entity_lineage_links l
        JOIN entity_observations o ON o.id = l.entity_observation_id
        WHERE l.status = 'active'
      `
    )
    .all() as Array<{
    canonical_entity_id: string;
    surface_form: string;
    normalized_form: string;
    scope_kind: string | null;
    scope_id: string | null;
    source_connector: string;
    source_raw_record_id: string;
    timestamp_observed: number | null;
    created_at: number;
  }>;
  for (const row of observationRows) {
    if (
      observationVisible(adapter, row, visibility, input.as_of_ms) &&
      (row.normalized_form === normalized || normalizeLabel(row.surface_form) === normalized)
    ) {
      recordCandidate(row.canonical_entity_id, row.surface_form, 'observation', 0.85);
    }
  }

  const sorted = Array.from(candidates.values())
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entity.id.localeCompare(right.entity.id);
    })
    .slice(0, limit);

  return {
    entity: sorted[0]?.entity ?? null,
    candidates: sorted,
  };
}
