import {
  assertTwinRefsVisibleToScopes,
  listVisibleTwinEdgesForRefs,
} from '../edges/ref-validation.js';
import { normalizeEntityLabel } from '../entities/normalization.js';
import { EntityMergeError, getEntityNode, resolveCanonicalEntityId } from '../entities/store.js';
import type { EntityNode } from '../entities/types.js';
import type { TwinRef, TwinScopeRef } from '../edges/types.js';
import type {
  AgentGraphAdapter,
  ResolveEntityInput,
  ResolveEntityResult,
  ResolvedEntityCandidate,
} from './types.js';
import { AgentGraphValidationError } from './errors.js';

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

function canonicalEntity(adapter: AgentGraphAdapter, entityId: string): EntityNode | null {
  try {
    const canonicalId = resolveCanonicalEntityId(adapter, entityId);
    const entity = getEntityNode(canonicalId, adapter);
    return entity && entity.status === 'active' ? entity : null;
  } catch (error) {
    if (error instanceof EntityMergeError) {
      return null;
    }
    throw error;
  }
}

function contextBoost(
  adapter: AgentGraphAdapter,
  entityId: string,
  contextRefs: readonly TwinRef[] | undefined,
  scopes: readonly TwinScopeRef[] | undefined,
  asOfMs: number | null | undefined
): number {
  if (!contextRefs || contextRefs.length === 0) {
    return 0;
  }
  const edges = listVisibleTwinEdgesForRefs(adapter, contextRefs, {
    scopes: scopes ? [...scopes] : undefined,
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
  if (input.context_refs && input.context_refs.length > 0) {
    try {
      assertTwinRefsVisibleToScopes(adapter, input.context_refs, input.scopes);
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
    if (!entity || !entityVisible(entity, input.scopes)) {
      return;
    }
    const score =
      baseScore +
      contextBoost(adapter, entity.id, input.context_refs, input.scopes, input.as_of_ms);
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
        SELECT entity_id, label, normalized_label
        FROM entity_aliases
        WHERE status = 'active'
      `
    )
    .all() as Array<{ entity_id: string; label: string; normalized_label: string }>;
  for (const row of aliasRows) {
    if (row.normalized_label === normalized || normalizeLabel(row.label) === normalized) {
      recordCandidate(row.entity_id, row.label, 'alias', 0.95);
    }
  }

  const observationRows = adapter
    .prepare(
      `
        SELECT l.canonical_entity_id, o.surface_form, o.normalized_form
        FROM entity_lineage_links l
        JOIN entity_observations o ON o.id = l.entity_observation_id
        WHERE l.status = 'active'
      `
    )
    .all() as Array<{
    canonical_entity_id: string;
    surface_form: string;
    normalized_form: string;
  }>;
  for (const row of observationRows) {
    if (row.normalized_form === normalized || normalizeLabel(row.surface_form) === normalized) {
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
