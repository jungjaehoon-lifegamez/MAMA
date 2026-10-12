import type { DatabaseAdapter } from '../db-manager.js';
import { ensureMemoryScope } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';

export interface MoveRecordsUserScopeInput {
  /** String ids name observations; numeric ids name checkpoints. */
  recordIds: readonly (string | number)[];
  fromPrincipalId: string;
  toPrincipalId: string;
  /** Replace only named observations authored by fromPrincipalId; execution history stays intact. */
  authorPrincipalId?: string;
  /** Bind only named checkpoints that have no scope bindings at all. */
  bindUnscoped?: boolean;
}

export interface MoveRecordsUserScopeReceipt {
  records: { observations: number; checkpoints: number };
  /** Changed rows, including deleted source bindings when the destination already exists. */
  stores: {
    memory_scopes: number;
    checkpoint_scope_bindings: number;
    observation_versions: number;
  };
}

type JsonObject = Record<string, unknown>;
function objectJson(value: unknown, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${label} must be valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${label} must contain an object`);
  return parsed as JsonObject;
}
function nonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonblank text`);
}

/**
 * An explicit administrative scope move. The caller selects records and author changes;
 * content, identifiers, shared bindings, execution actors and command receipts remain intact.
 * Named observation scopes and checkpoint bindings move atomically. Consumer indexes and raw stores
 * are outside this boundary and must be moved by the consumer in its own cutover.
 */
export function moveRecordsUserScope(
  adapter: DatabaseAdapter,
  input: MoveRecordsUserScopeInput
): MoveRecordsUserScopeReceipt {
  nonblank(input.fromPrincipalId, 'fromPrincipalId');
  nonblank(input.toPrincipalId, 'toPrincipalId');
  if (input.authorPrincipalId !== undefined) nonblank(input.authorPrincipalId, 'authorPrincipalId');
  return adapter.transaction(() => {
    const receipt: MoveRecordsUserScopeReceipt = {
      records: { observations: 0, checkpoints: 0 },
      stores: {
        memory_scopes: 0,
        checkpoint_scope_bindings: 0,
        observation_versions: 0,
      },
    };
    const from = input.fromPrincipalId,
      to = input.toPrincipalId;
    const sourceScope = adapter
      .prepare("SELECT id FROM memory_scopes WHERE kind='user' AND external_id=?")
      .get(from) as { id: string } | undefined;
    let targetScope: string | undefined;
    function destinationScope(): string {
      if (targetScope === undefined) {
        const existing = adapter
          .prepare("SELECT id FROM memory_scopes WHERE kind='user' AND external_id=?")
          .get(to) as { id: string } | undefined;
        if (existing) targetScope = existing.id;
        else {
          targetScope = ensureMemoryScope(adapter, 'user', to);
          receipt.stores.memory_scopes++;
        }
      }
      return targetScope;
    }

    function moveScopeArray(
      value: unknown,
      label: string
    ): { scopes: unknown[]; changed: boolean } {
      if (!Array.isArray(value)) throw new Error(`${label} must contain an array`);
      let changed = false;
      const scopes = value.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error(`${label} entries must be scope objects`);
        const scope = entry as JsonObject;
        if (scope.kind !== 'user' || (scope.externalId ?? scope.id) !== from || from === to)
          return scope;
        changed = true;
        const moved = { ...scope };
        if (scope.externalId !== undefined) moved.externalId = to;
        if (scope.id !== undefined) moved.id = to;
        if (scope.scopeId !== undefined) moved.scopeId = destinationScope();
        return moved;
      });
      return { scopes, changed };
    }

    function moveCheckpointBinding(id: number): boolean {
      const source =
        sourceScope &&
        (adapter
          .prepare(
            'SELECT is_primary,created_at FROM checkpoint_scope_bindings WHERE checkpoint_id=? AND scope_id=?'
          )
          .get(id, sourceScope.id) as
          | { is_primary: number | null; created_at: number | null }
          | undefined);
      if (!source || from === to) return false;
      const scopeId = destinationScope();
      const destination = adapter
        .prepare('SELECT 1 FROM checkpoint_scope_bindings WHERE checkpoint_id=? AND scope_id=?')
        .get(id, scopeId);
      if (destination) {
        receipt.stores.checkpoint_scope_bindings += adapter
          .prepare(
            'UPDATE checkpoint_scope_bindings SET is_primary=MAX(COALESCE(is_primary,0),?), created_at=MIN(COALESCE(created_at,?),?) WHERE checkpoint_id=? AND scope_id=?'
          )
          .run(source.is_primary ?? 0, source.created_at, source.created_at, id, scopeId).changes;
        receipt.stores.checkpoint_scope_bindings += adapter
          .prepare('DELETE FROM checkpoint_scope_bindings WHERE checkpoint_id=? AND scope_id=?')
          .run(id, sourceScope!.id).changes;
      } else {
        receipt.stores.checkpoint_scope_bindings += adapter
          .prepare(
            'UPDATE checkpoint_scope_bindings SET scope_id=? WHERE checkpoint_id=? AND scope_id=?'
          )
          .run(scopeId, id, sourceScope!.id).changes;
      }
      return true;
    }

    for (const id of new Set(input.recordIds)) {
      if (typeof id === 'number') {
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error('Checkpoint id must be a positive integer');
        if (!adapter.prepare('SELECT 1 FROM checkpoints WHERE id=?').get(id))
          throw new Error(`Checkpoint not found: ${id}`);
        let changed = moveCheckpointBinding(id);
        if (
          !changed &&
          input.bindUnscoped &&
          !adapter.prepare('SELECT 1 FROM checkpoint_scope_bindings WHERE checkpoint_id=?').get(id)
        ) {
          receipt.stores.checkpoint_scope_bindings += adapter
            .prepare(
              'INSERT INTO checkpoint_scope_bindings (checkpoint_id,scope_id,is_primary,created_at) VALUES (?, ?, 1, ?)'
            )
            .run(id, destinationScope(), Date.now()).changes;
          changed = true;
        }
        if (changed) receipt.records.checkpoints++;
        continue;
      }
      nonblank(id, 'Record id');
      const observation = adapter
        .prepare(
          'SELECT scope_json,memory_scope_kind,memory_scope_id,author FROM observation_versions WHERE observation_id=?'
        )
        .get(id) as
        | {
            scope_json: string;
            memory_scope_kind: string | null;
            memory_scope_id: string | null;
            author: string | null;
          }
        | undefined;
      if (!observation) throw new Error(`Observation not found: ${id}`);
      const scope = objectJson(observation.scope_json, 'observation_versions.scope_json');
      let changed = false;
      if (scope.scopes !== undefined) {
        const moved = moveScopeArray(scope.scopes, 'observation_versions.scope_json.scopes');
        if (moved.changed) {
          scope.scopes = moved.scopes;
          changed = true;
        }
      }
      if (scope.memoryScopeKind === 'user' && scope.memoryScopeId === from && from !== to) {
        scope.memoryScopeId = to;
        changed = true;
      }
      let memoryScopeId = observation.memory_scope_id;
      if (observation.memory_scope_kind === 'user' && memoryScopeId === from && from !== to) {
        memoryScopeId = to;
        changed = true;
      }
      const author =
        observation.author === from
          ? (input.authorPrincipalId ?? observation.author)
          : observation.author;
      if (author !== observation.author) changed = true;
      if (changed) {
        receipt.stores.observation_versions += adapter
          .prepare(
            'UPDATE observation_versions SET scope_json=?,memory_scope_id=?,author=? WHERE observation_id=?'
          )
          .run(canonicalizeJSON(scope), memoryScopeId, author, id).changes;
        receipt.records.observations++;
      }
    }
    return receipt;
  });
}
