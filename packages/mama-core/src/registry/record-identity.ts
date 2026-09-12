/**
 * Binding a record to what it is about and who was involved.
 *
 * The subject of a record used to be the text in `topic`, leaving alternate spellings
 * unjoinable. Here the subject is a
 * registry node id, and the people are rows with their roles.
 *
 * Everything this module refuses, it refuses loudly. An unknown node, a person id in the item
 * slot, a record that does not exist: all raise. A dangling reference stored quietly would
 * surface later as a timeline that is missing history, which is the failure mode this whole
 * design exists to remove.
 */

import { getAdapter } from '../db-manager.js';
import { resolveNodeById } from './store.js';
import type { RecordActor, RecordIdentity, RegistryScopeRef } from './types.js';

export type { RecordActor, RecordIdentity };

export class RecordIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RecordIdentityError';
  }
}

function adapter(): {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): T;
} {
  return getAdapter() as never;
}

/** The live node for an id, following merges. Raises when it is absent or the wrong kind. */
function requireNode(
  id: string,
  kind: 'item' | 'person',
  slot: string,
  scopes?: readonly RegistryScopeRef[]
): string {
  const node = resolveNodeById(id);
  if (!node) {
    throw new RecordIdentityError(
      'unknown_node',
      `${slot} references ${id}, which is not a registry node. Register it before binding.`
    );
  }
  if (node.kind !== kind) {
    throw new RecordIdentityError(
      'wrong_kind',
      `${slot} expects a ${kind} node; ${id} is a ${node.kind}.`
    );
  }
  const bindings = adapter()
    .prepare('SELECT scope_kind, scope_id FROM registry_scope_bindings WHERE node_id = ?')
    .all(node.id) as Array<{ scope_kind: RegistryScopeRef['kind']; scope_id: string }>;
  const visible =
    bindings.length === 0
      ? true
      : scopes !== undefined &&
        scopes.some((scope) =>
          bindings.some(
            (binding) => binding.scope_kind === scope.kind && binding.scope_id === scope.id
          )
        );
  if (!visible) {
    throw new RecordIdentityError('hidden_node', `${slot} references a node outside save scope`);
  }
  return node.id;
}

/** Resolve every supplied identity reference before a record write begins. */
export function validateRecordIdentityReferences(input: {
  itemId?: string | null;
  actors?: readonly RecordActor[];
  scopes?: readonly RegistryScopeRef[];
}): void {
  if (input.itemId !== undefined && input.itemId !== null) {
    requireNode(input.itemId, 'item', 'item_id', input.scopes);
  }
  for (const actor of input.actors ?? []) {
    if (!actor.role.trim()) {
      throw new RecordIdentityError('empty_role', 'An actor needs a role.');
    }
    requireNode(actor.personId, 'person', 'actor', input.scopes);
  }
}

interface RecordIdentityAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function writeRecordIdentityInAdapter(
  db: RecordIdentityAdapter,
  input: {
    recordId: string;
    itemId?: string | null;
    actors?: readonly RecordActor[];
    scopes?: readonly RegistryScopeRef[];
  }
): void {
  const itemId =
    input.itemId === undefined || input.itemId === null
      ? null
      : requireNode(input.itemId, 'item', 'item_id', input.scopes);
  const actors = (input.actors ?? []).map((actor, position) => ({
    personId: requireNode(actor.personId, 'person', 'actor', input.scopes),
    role: actor.role.trim(),
    position,
  }));
  for (const actor of actors) {
    if (!actor.role) {
      throw new RecordIdentityError('empty_role', 'An actor needs a role.');
    }
  }
  db.prepare('UPDATE decisions SET item_id = ? WHERE id = ?').run(itemId, input.recordId);
  db.prepare('DELETE FROM record_actors WHERE record_id = ?').run(input.recordId);
  const now = Date.now();
  for (const actor of actors) {
    db.prepare(
      `INSERT INTO record_actors (record_id, person_id, role, position, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.recordId, actor.personId, actor.role, actor.position, now);
  }
}

export function setRecordIdentity(input: {
  recordId: string;
  itemId?: string | null;
  actors?: readonly RecordActor[];
  scopes?: readonly RegistryScopeRef[];
}): void {
  const db = adapter();
  const exists = db.prepare('SELECT id FROM decisions WHERE id = ?').get(input.recordId) as
    | { id: string }
    | undefined;
  if (!exists) {
    throw new RecordIdentityError(
      'unknown_record',
      `No record ${input.recordId} to bind identity to.`
    );
  }

  // Resolve everything before writing anything: a half-applied identity is worse than a
  // refused one, because the record would then claim an item without its people.
  const itemId =
    input.itemId === undefined || input.itemId === null
      ? null
      : requireNode(input.itemId, 'item', 'item_id', input.scopes);
  const actors = (input.actors ?? []).map((actor, index) => {
    const role = actor.role.trim();
    if (!role) {
      throw new RecordIdentityError('empty_role', 'An actor needs a role.');
    }
    return {
      personId: requireNode(actor.personId, 'person', 'actor', input.scopes),
      role,
      position: index,
    };
  });

  const apply = (): void => {
    writeRecordIdentityInAdapter(db, {
      recordId: input.recordId,
      itemId,
      actors: actors.map((actor) => ({ personId: actor.personId, role: actor.role })),
      scopes: input.scopes,
    });
  };

  // better-sqlite3 hands back a callable; other adapters run it immediately. The core does
  // the same two-step check wherever it wraps a write (memory/api.ts:349).
  db.transaction(apply);
}

export function readRecordIdentity(recordId: string): RecordIdentity | null {
  const row = adapter().prepare('SELECT item_id FROM decisions WHERE id = ?').get(recordId) as
    | { item_id: string | null }
    | undefined;
  if (!row) {
    return null;
  }
  // Canonicalise on read: a merge moves aliases but rewrites no consumer, so an id stored
  // before the merge still has to answer with the surviving node.
  const itemId = row.item_id ? (resolveNodeById(row.item_id)?.id ?? null) : null;
  return { itemId };
}

export function listActors(recordId: string): RecordActor[] {
  const rows = adapter()
    .prepare(
      'SELECT person_id, role FROM record_actors WHERE record_id = ? ORDER BY position, rowid'
    )
    .all(recordId) as Array<{ person_id: string; role: string }>;
  return rows.map((row) => ({
    personId: resolveNodeById(row.person_id)?.id ?? row.person_id,
    role: row.role,
  }));
}

/** Records bound to one item, newest first. The read `item_timeline` is built on. */
export function listRecordIdsForItem(
  itemId: string,
  options?: { limit?: number; before?: { timestamp: number; id: string } }
): Array<{ id: string; timestamp: number }> {
  const node = resolveNodeById(itemId);
  if (!node) {
    throw new RecordIdentityError('unknown_node', `No registry node ${itemId}.`);
  }
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const before = options?.before;
  const rows = adapter()
    .prepare(
      `WITH RECURSIVE item_ids(id) AS (
         SELECT ?
         UNION
         SELECT registry_nodes.id FROM registry_nodes
         JOIN item_ids ON registry_nodes.merged_into = item_ids.id
       )
       SELECT id, COALESCE(event_datetime, created_at) AS ts FROM decisions
        WHERE item_id IN (SELECT id FROM item_ids)
          ${before ? 'AND (COALESCE(event_datetime, created_at) < ? OR (COALESCE(event_datetime, created_at) = ? AND id < ?))' : ''}
        ORDER BY ts DESC, id DESC
        LIMIT ?`
    )
    .all(
      ...(before
        ? [node.id, before.timestamp, before.timestamp, before.id, limit]
        : [node.id, limit])
    ) as Array<{ id: string; ts: number }>;
  return rows.map((row) => ({ id: row.id, timestamp: row.ts }));
}
