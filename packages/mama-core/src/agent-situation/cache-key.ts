import { createHash } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type {
  AgentSituationCacheKeyInput,
  AgentSituationCacheKeyResult,
  AgentSituationEffectiveFilters,
  SituationFocus,
} from './types.js';

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalizeJSON(value), 'utf8').digest('hex');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeScopes(scopes: AgentSituationCacheKeyInput['scopes']) {
  return [...scopes]
    .map((scope) => ({ kind: scope.kind, id: scope.id.trim() }))
    .filter((scope) => scope.id.length > 0)
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

function normalizeProjectRefs(projectRefs: AgentSituationCacheKeyInput['project_refs']) {
  return [...projectRefs]
    .map((project) => ({ kind: 'project' as const, id: project.id.trim() }))
    .filter((project) => project.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeFocus(focus: readonly SituationFocus[]): SituationFocus[] {
  return [...new Set(focus)].sort();
}

export function normalizeAgentSituationEffectiveFilters(
  input: AgentSituationEffectiveFilters
): AgentSituationEffectiveFilters {
  return {
    scopes: normalizeScopes(input.scopes),
    connectors: uniqueSorted(input.connectors),
    project_refs: normalizeProjectRefs(input.project_refs),
    tenant_id: input.tenant_id.trim() || 'default',
    as_of: input.as_of ?? null,
  };
}

export function buildAgentSituationCacheKey(
  input: AgentSituationCacheKeyInput
): AgentSituationCacheKeyResult {
  const effective = normalizeAgentSituationEffectiveFilters(input);
  const canonicalInput: AgentSituationCacheKeyInput = {
    ...effective,
    range_start_ms: Math.floor(input.range_start_ms),
    range_end_ms: Math.floor(input.range_end_ms),
    focus: normalizeFocus(input.focus),
    limit: Math.floor(input.limit),
    ranking_policy_version: input.ranking_policy_version,
  };
  const canonicalJson = canonicalizeJSON(canonicalInput);

  return {
    cacheKey: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    canonicalInput,
    canonicalJson,
    filtersHash: sha256Hex(effective),
    scopeHash: sha256Hex(effective.scopes),
  };
}
