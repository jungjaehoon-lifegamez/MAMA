/**
 * Registry store: work items, people and clients as nodes with the names they go by.
 *
 * Identity used to live in strings - a task title, a decision topic. Measured 2026-09-11,
 * one work item was filed under three spellings and one person under two display names, so
 * the records never joined and every question re-derived the connection from raw pages.
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

export const REGISTRY_KINDS = ['item', 'person', 'client'] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export interface RegistryNode {
  id: string;
  kind: RegistryKind;
  name: string;
  parentId: string | null;
  mergedInto: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

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
function insertAlias(nodeId: string, kind: RegistryKind, alias: string, now: number): void {
  const normalized = normalizeAlias(alias);
  if (!normalized) {
    throw new RegistryError('empty_alias', 'An alias must contain at least one character');
  }
  const existing = adapter()
    .prepare('SELECT node_id FROM registry_aliases WHERE kind = ? AND alias = ?')
    .get(kind, normalized) as { node_id: string } | undefined;
  if (existing) {
    if (existing.node_id === nodeId) return;
    throw new RegistryError(
      'alias_taken',
      `Alias "${alias}" already resolves to ${kind} ${existing.node_id}. ` +
        'Merge the two nodes or choose a different alias.'
    );
  }
  adapter()
    .prepare(
      `INSERT INTO registry_aliases (node_id, kind, alias, alias_display, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(nodeId, kind, normalized, alias.trim(), now);
}

export function createNode(input: {
  kind: RegistryKind | string;
  name: string;
  aliases?: readonly string[];
  parentId?: string | null;
  note?: string | null;
}): string {
  const kind = requireKind(input.kind);
  const name = input.name.trim();
  if (!name) throw new RegistryError('empty_name', 'A registry node needs a name');
  const id = `reg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = Date.now();
  adapter()
    .prepare(
      `INSERT INTO registry_nodes (id, kind, name, parent_id, merged_into, merge_reason, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    )
    .run(id, kind, name, input.parentId ?? null, input.note ?? null, now, now);
  // The name is an alias too: asking for a node by the name it displays must work.
  insertAlias(id, kind, name, now);
  for (const alias of input.aliases ?? []) insertAlias(id, kind, alias, now);
  return id;
}

export function addAlias(nodeId: string, alias: string): void {
  const node = readNode(nodeId);
  if (!node) throw new RegistryError('unknown_node', `No registry node ${nodeId}`);
  if (node.mergedInto) {
    throw new RegistryError(
      'node_merged',
      `Node ${nodeId} was merged into ${node.mergedInto}; add the alias there`
    );
  }
  insertAlias(nodeId, node.kind, alias, Date.now());
}

/** The node an alias names, following merges. `kind` narrows when the same word is both. */
export function resolveAlias(alias: string, kind?: RegistryKind | string): RegistryNode | null {
  const normalized = normalizeAlias(alias);
  if (!normalized) return null;
  const row = kind
    ? (adapter()
        .prepare('SELECT node_id FROM registry_aliases WHERE kind = ? AND alias = ?')
        .get(requireKind(kind), normalized) as { node_id: string } | undefined)
    : (adapter()
        .prepare('SELECT node_id FROM registry_aliases WHERE alias = ? ORDER BY created_at LIMIT 1')
        .get(normalized) as { node_id: string } | undefined);
  return row ? followMerges(row.node_id) : null;
}

export function listNodes(filter?: {
  kind?: RegistryKind | string;
  parentId?: string | null;
  includeMerged?: boolean;
}): RegistryNode[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.kind) {
    where.push('kind = ?');
    params.push(requireKind(filter.kind));
  }
  if (filter?.parentId !== undefined) {
    if (filter.parentId === null) where.push('parent_id IS NULL');
    else {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
  }
  if (filter?.includeMerged !== true) where.push('merged_into IS NULL');
  // rowid, not id: a split writes its children inside one millisecond, so `created_at`
  // alone would order them by random uuid and report the parts in the wrong order.
  const sql = `SELECT * FROM registry_nodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
  return (adapter().prepare(sql).all(...params) as NodeRow[]).map(toNode);
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
  if (!loser) throw new RegistryError('unknown_node', `No registry node ${input.loser}`);
  if (!survivor) throw new RegistryError('unknown_node', `No registry node ${input.survivor}`);
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
  if (!reason) throw new RegistryError('missing_reason', 'A merge must record why');
  const now = Date.now();
  // Aliases move rather than duplicate: (kind, alias) is unique, and the loser's rows are
  // exactly the spellings that must now reach the survivor.
  adapter()
    .prepare('UPDATE registry_aliases SET node_id = ? WHERE node_id = ?')
    .run(input.survivor, input.loser);
  adapter()
    .prepare(
      'UPDATE registry_nodes SET merged_into = ?, merge_reason = ?, updated_at = ? WHERE id = ?'
    )
    .run(input.survivor, reason, now, input.loser);
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
  const parent = readNode(input.parent);
  if (!parent) throw new RegistryError('unknown_node', `No registry node ${input.parent}`);
  if (parent.mergedInto) {
    throw new RegistryError('node_merged', `Node ${input.parent} was merged away`);
  }
  if (input.children.length < 2) {
    throw new RegistryError('split_too_small', 'A split needs at least two children');
  }
  if (!input.reason.trim()) throw new RegistryError('missing_reason', 'A split must record why');
  return input.children.map((child) =>
    createNode({
      kind: parent.kind,
      name: child.name,
      aliases: child.aliases,
      parentId: parent.id,
      note: input.reason.trim(),
    })
  );
}
