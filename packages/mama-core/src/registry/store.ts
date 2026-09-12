/**
 * Registry store: work items, people and clients as nodes with the names they go by.
 *
 * Identity used to live in strings such as task titles and decision topics, so alternate
 * spellings could not join without an explicit durable identity.
 *
 * A node here is cheap: an id, a kind, a display name, and the aliases it answers to.
 * What it buys is that a record can point at identity instead of spelling it.
 *
 * Two decisions this module refuses to make on its own:
 * - It never merges by similarity. `mergeNodes` happens because a caller decided, and the
 *   reason is stored with it.
 * - It never reassigns a contested alias. Claiming an alias another node holds raises, so
 *   the caller resolves it (merge, or pick a different alias) rather than the store
 *   silently moving identity from under existing records.
 */

import { randomUUID } from 'node:crypto';
import { getAdapter } from '../db-manager.js';
import {
  REGISTRY_KINDS,
  type RegistryKind,
  type RegistryNode,
  type RegistryScopeRef,
} from './types.js';

export { REGISTRY_KINDS };
export type { RegistryKind, RegistryNode };
export type { RegistryScopeRef };

export class RegistryError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  parent_id: string | null;
  merged_into: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * The lookup key for an alias: case-folded, inner runs of whitespace collapsed, trimmed.
 *
 * Deliberately conservative - it folds the differences that are the same string typed
 * twice, and nothing else. Hyphens, underscores and script differences stay significant,
 * because "a-0001" and "a_0001" being the same thing is a judgement about the work, not
 * about text, and belongs in an alias row someone added.
 */
export function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
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

function toNode(row: NodeRow): RegistryNode {
  return {
    id: row.id,
    kind: row.kind as RegistryKind,
    name: row.name,
    parentId: row.parent_id,
    mergedInto: row.merged_into,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireKind(kind: string): RegistryKind {
  if (!(REGISTRY_KINDS as readonly string[]).includes(kind)) {
    throw new RegistryError('invalid_kind', `Unknown registry kind: ${kind}`);
  }
  return kind as RegistryKind;
}

function readNode(id: string): RegistryNode | null {
  const row = adapter().prepare('SELECT * FROM registry_nodes WHERE id = ?').get(id) as
    | NodeRow
    | undefined;
  return row ? toNode(row) : null;
}

function isNodeVisible(id: string, scopes?: readonly RegistryScopeRef[]): boolean {
  const bindings = adapter()
    .prepare(
      'SELECT scope_kind AS kind, scope_id AS id FROM registry_scope_bindings WHERE node_id = ?'
    )
    .all(id) as RegistryScopeRef[];
  if (bindings.length === 0) {
    return true;
  }
  if (!scopes || scopes.length === 0) {
    return false;
  }
  return scopes.some((scope) =>
    bindings.some((binding) => binding.kind === scope.kind && binding.id === scope.id)
  );
}

/**
 * Follow `merged_into` to the node that now holds this identity.
 *
 * Bounded: a cycle written by a bad merge would otherwise hang every lookup, so the walk
 * stops and reports rather than spinning.
 */
function followMerges(id: string): RegistryNode | null {
  let current = readNode(id);
  for (let hops = 0; current?.mergedInto && hops < 8; hops += 1) {
    current = readNode(current.mergedInto);
  }
  if (current?.mergedInto) {
    throw new RegistryError('merge_chain_too_long', `Merge chain from ${id} does not settle`);
  }
  return current;
}

/** Write one alias row, or raise when another node already answers to it. */
function aliasScopes(scopes?: readonly RegistryScopeRef[]): readonly RegistryScopeRef[] {
  return scopes && scopes.length > 0 ? scopes : [{ kind: 'global', id: '*' }];
}

function insertAlias(
  nodeId: string,
  kind: RegistryKind,
  alias: string,
  now: number,
  scopes?: readonly RegistryScopeRef[]
): void {
  const normalized = normalizeAlias(alias);
  if (!normalized) {
    throw new RegistryError('empty_alias', 'An alias must contain at least one character');
  }
  for (const scope of aliasScopes(scopes)) {
    const existing = adapter()
      .prepare(
        `SELECT node_id FROM registry_aliases
         WHERE kind = ? AND alias = ? AND scope_kind = ? AND scope_id = ?`
      )
      .get(kind, normalized, scope.kind, scope.id) as { node_id: string } | undefined;
    if (existing) {
      if (existing.node_id === nodeId) {
        continue;
      }
      throw new RegistryError(
        'alias_taken',
        `Alias "${alias}" is already registered in this scope.`
      );
    }
    adapter()
      .prepare(
        `INSERT INTO registry_aliases
         (node_id, kind, alias, alias_display, scope_kind, scope_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(nodeId, kind, normalized, alias.trim(), scope.kind, scope.id, now);
  }
}

export function createNode(input: {
  kind: RegistryKind | string;
  name: string;
  aliases?: readonly string[];
  parentId?: string | null;
  note?: string | null;
  scopes?: readonly RegistryScopeRef[];
}): string {
  const db = adapter();
  const write = (): string => {
    const kind = requireKind(input.kind);
    const name = input.name.trim();
    if (!name) {
      throw new RegistryError('empty_name', 'A registry node needs a name');
    }
    const id = `reg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO registry_nodes (id, kind, name, parent_id, merged_into, merge_reason, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    ).run(id, kind, name, input.parentId ?? null, input.note ?? null, now, now);
    // The name is an alias too: asking for a node by the name it displays must work.
    insertAlias(id, kind, name, now, input.scopes);
    for (const alias of input.aliases ?? []) {
      insertAlias(id, kind, alias, now, input.scopes);
    }
    for (const scope of input.scopes ?? []) {
      if (!scope.id.trim()) {
        throw new RegistryError('invalid_scope', 'Registry scope id must be nonblank');
      }
      db.prepare(
        `INSERT INTO registry_scope_bindings (node_id, scope_kind, scope_id)
           VALUES (?, ?, ?)`
      ).run(id, scope.kind, scope.id);
    }
    return id;
  };
  return db.transaction(write);
}

export function addAliases(
  nodeId: string,
  aliases: readonly string[],
  scopes?: readonly RegistryScopeRef[]
): void {
  const db = adapter();
  const write = (): void => {
    if (scopes === undefined) {
      for (const alias of aliases) {
        addAlias(nodeId, alias);
      }
      return;
    }
    const node = readNode(nodeId);
    if (!node || node.mergedInto)
      throw new RegistryError('unknown_node', 'Registry node unavailable');
    for (const alias of aliases) {
      insertAlias(nodeId, node.kind, alias, Date.now(), scopes);
    }
  };
  db.transaction(write);
}

export function upsertNode(input: {
  kind: RegistryKind | string;
  name: string;
  aliases?: readonly string[];
  note?: string | null;
  scopes?: readonly RegistryScopeRef[];
  children?: ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
}): { id: string; created: boolean; children: string[] } {
  const db = adapter();
  const write = (): { id: string; created: boolean; children: string[] } => {
    const existing = resolveAlias(input.name, input.kind, input.scopes);
    if (existing) {
      if (input.children && input.children.length > 0) {
        throw new RegistryError(
          'existing_children_unsupported',
          'Adding children to an existing node requires an explicit correction.'
        );
      }
      addAliases(existing.id, input.aliases ?? [], input.scopes);
      return { id: existing.id, created: false, children: [] };
    }
    const id = createNode(input);
    const children =
      input.children && input.children.length > 0
        ? splitNode({
            parent: id,
            children: input.children,
            reason: input.note?.trim() || 'explicit parent declaration',
          })
        : [];
    return { id, created: true, children };
  };
  return db.transaction(write);
}

export function addAlias(nodeId: string, alias: string): void {
  const node = readNode(nodeId);
  if (!node) {
    throw new RegistryError('unknown_node', `No registry node ${nodeId}`);
  }
  if (node.mergedInto) {
    throw new RegistryError(
      'node_merged',
      `Node ${nodeId} was merged into ${node.mergedInto}; add the alias there`
    );
  }
  const scopes = adapter()
    .prepare(
      'SELECT scope_kind AS kind, scope_id AS id FROM registry_scope_bindings WHERE node_id = ?'
    )
    .all(nodeId) as RegistryScopeRef[];
  insertAlias(nodeId, node.kind, alias, Date.now(), scopes);
}

/** The live node behind an id, following merges. Null when the id is unknown. */
export function resolveNodeById(id: string): RegistryNode | null {
  return followMerges(id);
}

/** The node an alias names, following merges. `kind` narrows when the same word is both. */
export function resolveAlias(
  alias: string,
  kind?: RegistryKind | string,
  scopes?: readonly RegistryScopeRef[]
): RegistryNode | null {
  const normalized = normalizeAlias(alias);
  if (!normalized) {
    return null;
  }
  const admitted = scopes && scopes.length > 0 ? scopes : [{ kind: 'global' as const, id: '*' }];
  const whereKind = kind ? 'kind = ? AND' : '';
  const rows = adapter()
    .prepare(
      `SELECT DISTINCT node_id FROM registry_aliases
       WHERE ${whereKind} alias = ?
         AND ((scope_kind = 'global' AND scope_id = '*')
           OR (scope_kind || ':' || scope_id) IN (${admitted.map(() => '?').join(', ')}))`
    )
    .all(
      ...(kind ? [requireKind(kind)] : []),
      normalized,
      ...admitted.map((scope) => `${scope.kind}:${scope.id}`)
    ) as Array<{ node_id: string }>;
  const visible = rows
    .map((row) => followMerges(row.node_id))
    .filter((node): node is RegistryNode => node !== null)
    .filter((node) => isNodeVisible(node.id, admitted));
  const unique = [...new Map(visible.map((node) => [node.id, node])).values()];
  if (unique.length > 1) {
    throw new RegistryError('alias_ambiguous', 'Alias resolves to multiple visible nodes.');
  }
  return unique[0] ?? null;
}

export function listNodes(filter?: {
  kind?: RegistryKind | string;
  parentId?: string | null;
  includeMerged?: boolean;
  scopes?: readonly RegistryScopeRef[];
}): RegistryNode[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.kind) {
    where.push('kind = ?');
    params.push(requireKind(filter.kind));
  }
  if (filter?.parentId !== undefined) {
    if (filter.parentId === null) {
      where.push('parent_id IS NULL');
    } else {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
  }
  if (filter?.includeMerged !== true) {
    where.push('merged_into IS NULL');
  }
  if (filter?.scopes && filter.scopes.length > 0) {
    where.push(
      `(NOT EXISTS (SELECT 1 FROM registry_scope_bindings rs WHERE rs.node_id = registry_nodes.id)
        OR EXISTS (
          SELECT 1 FROM registry_scope_bindings rs
           WHERE rs.node_id = registry_nodes.id
             AND (rs.scope_kind || ':' || rs.scope_id) IN (${filter.scopes.map(() => '?').join(', ')})
        ))`
    );
    params.push(...filter.scopes.map((scope) => `${scope.kind}:${scope.id}`));
  }
  // rowid, not id: a split writes its children inside one millisecond, so `created_at`
  // alone would order them by random uuid and report the parts in the wrong order.
  const sql = `SELECT * FROM registry_nodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
  return (
    adapter()
      .prepare(sql)
      .all(...params) as NodeRow[]
  ).map(toNode);
}

/**
 * Point one node's identity at another. The loser keeps its row as a tombstone so records
 * that still reference it resolve forward instead of dangling.
 */
export function mergeNodes(input: { loser: string; survivor: string; reason: string }): void {
  if (input.loser === input.survivor) {
    throw new RegistryError('merge_self', 'A node cannot merge into itself');
  }
  const loser = readNode(input.loser);
  const survivor = readNode(input.survivor);
  if (!loser) {
    throw new RegistryError('unknown_node', `No registry node ${input.loser}`);
  }
  if (!survivor) {
    throw new RegistryError('unknown_node', `No registry node ${input.survivor}`);
  }
  if (survivor.mergedInto) {
    throw new RegistryError(
      'survivor_merged',
      `Node ${input.survivor} was itself merged into ${survivor.mergedInto}`
    );
  }
  if (loser.kind !== survivor.kind) {
    throw new RegistryError('kind_mismatch', `Cannot merge ${loser.kind} into ${survivor.kind}`);
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new RegistryError('missing_reason', 'A merge must record why');
  }
  const now = Date.now();
  // Aliases move rather than duplicate: (kind, alias) is unique, and the loser's rows are
  // exactly the spellings that must now reach the survivor.
  const db = adapter();
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO registry_scope_bindings (node_id, scope_kind, scope_id)
       SELECT ?, scope_kind, scope_id FROM registry_scope_bindings WHERE node_id = ?`
    ).run(input.survivor, input.loser);
    db.prepare('UPDATE registry_aliases SET node_id = ? WHERE node_id = ?').run(
      input.survivor,
      input.loser
    );
    db.prepare(
      'UPDATE registry_nodes SET merged_into = ?, merge_reason = ?, updated_at = ? WHERE id = ?'
    ).run(input.survivor, reason, now, input.loser);
  });
}

/**
 * Split one item into the children it really covers, keeping the parent as the umbrella.
 *
 * Nothing is deleted: the parent stays resolvable by its own aliases, and existing records
 * keep pointing at it until someone decides which child they belong to.
 */
export function splitNode(input: {
  parent: string;
  children: ReadonlyArray<{ name: string; aliases?: readonly string[] }>;
  reason: string;
}): string[] {
  const db = adapter();
  const write = (): string[] => {
    const parent = readNode(input.parent);
    if (!parent) {
      throw new RegistryError('unknown_node', `No registry node ${input.parent}`);
    }
    if (parent.mergedInto) {
      throw new RegistryError('node_merged', `Node ${input.parent} was merged away`);
    }
    if (input.children.length < 2) {
      throw new RegistryError('split_too_small', 'A split needs at least two children');
    }
    if (!input.reason.trim()) {
      throw new RegistryError('missing_reason', 'A split must record why');
    }
    const parentScopes = adapter()
      .prepare(
        'SELECT scope_kind AS kind, scope_id AS id FROM registry_scope_bindings WHERE node_id = ?'
      )
      .all(parent.id) as RegistryScopeRef[];
    return input.children.map((child) =>
      createNode({
        kind: parent.kind,
        name: child.name,
        aliases: child.aliases,
        parentId: parent.id,
        note: input.reason.trim(),
        scopes: parentScopes,
      })
    );
  };
  return db.transaction(write);
}
