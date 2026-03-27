import type { MemoryScopeKind, MemoryScopeRef } from './types.js';

export const PRIORITY_SCOPE_ORDER: MemoryScopeKind[] = ['project', 'channel', 'user', 'global'];

export function sortScopesByPriority(scopes: MemoryScopeRef[]): MemoryScopeRef[] {
  return [...scopes].sort(
    (left, right) =>
      PRIORITY_SCOPE_ORDER.indexOf(left.kind) - PRIORITY_SCOPE_ORDER.indexOf(right.kind)
  );
}

export function getPrimaryScope(scopes: MemoryScopeRef[]): MemoryScopeRef | null {
  return sortScopesByPriority(scopes)[0] ?? null;
}
