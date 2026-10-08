import type { DatabaseAdapter } from '../db-manager.js';
import type { MemoryScopeRef } from '../memory/types.js';

/** Only identity and access boundaries survive a personal record erasure. */
export interface ErasedRecord {
  id: string;
  scopes: MemoryScopeRef[];
  state: 'erased';
}

export function isErasedRecord(value: object): value is ErasedRecord {
  return 'state' in value && value.state === 'erased';
}

export function recordScopes(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  id: string
): MemoryScopeRef[] {
  return adapter
    .prepare(
      `SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
    JOIN memory_scopes s ON s.id=b.scope_id WHERE b.memory_id=? ORDER BY s.kind, s.external_id`
    )
    .all(id) as MemoryScopeRef[];
}

/** Read explicit observation bindings, including the pre-column scope representation. */
export function observationScopes(row: Record<string, unknown>): MemoryScopeRef[] {
  const scope = JSON.parse(String(row.scope_json)) as {
    scopes?: Array<{ kind?: string; id?: string; externalId?: string }>;
  };
  const scopes: MemoryScopeRef[] = (scope.scopes ?? []).map((s) => ({
    kind: String(s.kind),
    id: String(s.externalId ?? s.id ?? ''),
  }));
  if (typeof row.memory_scope_kind === 'string' && typeof row.memory_scope_id === 'string') {
    scopes.push({ kind: row.memory_scope_kind, id: row.memory_scope_id });
  }
  return [...new Map(scopes.map((s) => [`${s.kind}\0${s.id}`, s])).values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  );
}

export function erasedReference(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  ref: { kind: string; id: string }
): ErasedRecord | null {
  if (ref.kind === 'memory') {
    const row = adapter.prepare('SELECT erased_at FROM decisions WHERE id=?').get(ref.id) as
      | { erased_at: number | null }
      | undefined;
    return typeof row?.erased_at === 'number'
      ? { id: ref.id, scopes: recordScopes(adapter, ref.id), state: 'erased' }
      : null;
  }
  if (ref.kind === 'observation' || ref.kind === 'raw') {
    const row = adapter
      .prepare('SELECT * FROM observation_versions WHERE observation_id=?')
      .get(ref.id) as Record<string, unknown> | undefined;
    return typeof row?.erased_at === 'number'
      ? { id: ref.id, scopes: observationScopes(row), state: 'erased' }
      : null;
  }
  return null;
}
