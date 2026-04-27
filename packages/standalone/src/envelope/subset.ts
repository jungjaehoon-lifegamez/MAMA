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
        | 'budget_exceeds_parent'
        | 'token_budget_undefined_but_parent_bounded'
        | 'token_budget_exceeds_parent'
        | 'cost_cap_undefined_but_parent_bounded'
        | 'cost_cap_exceeds_parent';
    };

export function isEnvelopeSubset(child: Envelope, parent: Envelope): EnvelopeSubsetResult {
  const childScope = child.scope;
  const parentScope = parent.scope;

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
      childScope.allowed_destinations.map((destination) => `${destination.kind}:${destination.id}`),
      new Set(
        parentScope.allowed_destinations.map(
          (destination) => `${destination.kind}:${destination.id}`
        )
      )
    )
  ) {
    return { ok: false, reason: 'destinations_not_subset' };
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
