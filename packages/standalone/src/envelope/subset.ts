import type { Envelope } from './types.js';

export type EnvelopeSubsetResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'raw_connectors_not_subset'
        | 'project_refs_not_subset'
        | 'memory_scopes_not_subset'
        | 'destinations_not_subset'
        | 'destination_id_empty'
        | 'tier_widened'
        | 'expiry_extended'
        | 'eval_privileged_escalation'
        | 'as_of_exceeds_parent'
        | 'budget_exceeds_parent'
        | 'token_budget_undefined_but_parent_bounded'
        | 'token_budget_exceeds_parent'
        | 'cost_cap_undefined_but_parent_bounded'
        | 'cost_cap_exceeds_parent';
    };

export function isEnvelopeSubset(child: Envelope, parent: Envelope): EnvelopeSubsetResult {
  const childScope = child.scope;
  const parentScope = parent.scope;

  if (childScope.allowed_destinations.some((destination) => destination.id.trim() === '')) {
    return { ok: false, reason: 'destination_id_empty' };
  }
  if (!allIn(childScope.raw_connectors, new Set(parentScope.raw_connectors))) {
    return { ok: false, reason: 'raw_connectors_not_subset' };
  }
  if (
    !allIn(
      childScope.project_refs.map((ref) => ref.id),
      new Set(parentScope.project_refs.map((ref) => ref.id))
    )
  ) {
    return { ok: false, reason: 'project_refs_not_subset' };
  }
  if (
    !allIn(
      childScope.memory_scopes.map((scope) => `${scope.kind}:${scope.id}`),
      new Set(parentScope.memory_scopes.map((scope) => `${scope.kind}:${scope.id}`))
    )
  ) {
    return { ok: false, reason: 'memory_scopes_not_subset' };
  }
  if (
    !allIn(
      childScope.allowed_destinations.map(destinationKey),
      new Set(parentScope.allowed_destinations.map(destinationKey))
    )
  ) {
    return { ok: false, reason: 'destinations_not_subset' };
  }
  if (child.tier < parent.tier) {
    return { ok: false, reason: 'tier_widened' };
  }
  if (!isNoLaterThan(child.expires_at, parent.expires_at)) {
    return { ok: false, reason: 'expiry_extended' };
  }
  if (childScope.eval_privileged === true && parentScope.eval_privileged !== true) {
    return { ok: false, reason: 'eval_privileged_escalation' };
  }
  if (
    parentScope.as_of !== undefined &&
    (childScope.as_of === undefined || !isNoLaterThan(childScope.as_of, parentScope.as_of))
  ) {
    return { ok: false, reason: 'as_of_exceeds_parent' };
  }
  if (child.budget.wall_seconds > parent.budget.wall_seconds) {
    return { ok: false, reason: 'budget_exceeds_parent' };
  }

  if (parent.budget.token_limit !== undefined) {
    if (child.budget.token_limit === undefined) {
      return { ok: false, reason: 'token_budget_undefined_but_parent_bounded' };
    }
    if (child.budget.token_limit > parent.budget.token_limit) {
      return { ok: false, reason: 'token_budget_exceeds_parent' };
    }
  }

  if (parent.budget.cost_cap !== undefined) {
    if (child.budget.cost_cap === undefined) {
      return { ok: false, reason: 'cost_cap_undefined_but_parent_bounded' };
    }
    if (child.budget.cost_cap > parent.budget.cost_cap) {
      return { ok: false, reason: 'cost_cap_exceeds_parent' };
    }
  }

  return { ok: true };
}

function allIn(childValues: string[], parentValues: Set<string>): boolean {
  return childValues.every((value) => parentValues.has(value));
}

function destinationKey(destination: Envelope['scope']['allowed_destinations'][number]): string {
  return `${destination.kind}:${destination.id}`;
}

function isNoLaterThan(childIso: string, parentIso: string): boolean {
  const childTime = Date.parse(childIso);
  const parentTime = Date.parse(parentIso);
  return Number.isFinite(childTime) && Number.isFinite(parentTime) && childTime <= parentTime;
}
