import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  RegistryError,
  addAlias,
  addAliases,
  createNode,
  listNodes,
  mergeNodes,
  resolveAlias,
  splitNode,
  upsertNode,
} from '../../src/registry/store.js';

/**
 * The registry is the one place that says "these names are the same thing".
 *
 * Alternate spellings cannot join reliably when identity is stored only as a string. A string
 * in a title cannot carry that identity; a node with aliases can.
 *
 * Merging is never automatic here: the caller decides. The store only refuses the shapes
 * that would corrupt the graph (an alias claimed by two nodes, a merge into a dead node).
 */
describe('registry: item and person nodes with aliases', () => {
  let dbPath: string;

  beforeAll(async () => {
    dbPath = await initTestDB('registry-store');
  });
  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });
  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM registry_scope_bindings').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
  });

  it('resolves any alias, and its own name, to the same node', () => {
    const id = createNode({ kind: 'item', name: 'alpha item', aliases: ['a_0001', 'b_0001'] });

    expect(resolveAlias('a_0001')?.id).toBe(id);
    expect(resolveAlias('b_0001')?.id).toBe(id);
    expect(resolveAlias('alpha item')?.id).toBe(id);
    expect(resolveAlias('  A_0001 ')?.id).toBe(id);
    expect(resolveAlias('unknown thing')).toBeNull();
  });

  it('refuses an alias already claimed by another node instead of guessing', () => {
    createNode({ kind: 'item', name: 'alpha item', aliases: ['a_0001'] });
    const other = createNode({ kind: 'item', name: 'beta item' });

    expect(() => addAlias(other, 'a_0001')).toThrow(RegistryError);
    expect(resolveAlias('a_0001')?.name).toBe('alpha item');
  });

  it('keeps item and person namespaces apart', () => {
    const item = createNode({ kind: 'item', name: 'shared name' });
    const person = createNode({ kind: 'person', name: 'shared name' });

    expect(resolveAlias('shared name', 'item')?.id).toBe(item);
    expect(resolveAlias('shared name', 'person')?.id).toBe(person);
  });

  it('merges one node into another, carrying its aliases and leaving a tombstone', () => {
    const survivor = createNode({ kind: 'person', name: 'person one', aliases: ['P-One'] });
    const loser = createNode({ kind: 'person', name: 'person 1', aliases: ['p1'] });

    mergeNodes({ loser, survivor, reason: 'owner confirmed same person' });

    expect(resolveAlias('p1')?.id).toBe(survivor);
    expect(resolveAlias('person 1')?.id).toBe(survivor);
    expect(resolveAlias('P-One')?.id).toBe(survivor);
    expect(listNodes({ kind: 'person' }).map((n) => n.id)).toEqual([survivor]);
  });

  it('splits an item into children that keep the parent reachable', () => {
    const parent = createNode({ kind: 'item', name: 'alpha item', aliases: ['a_0001'] });
    const [first, second] = splitNode({
      parent,
      children: [
        { name: 'alpha item / part one', aliases: ['a_0001_p1'] },
        { name: 'alpha item / part two', aliases: ['a_0001_p2'] },
      ],
      reason: 'owner: separate files',
    });

    expect(resolveAlias('a_0001_p1')?.id).toBe(first);
    expect(resolveAlias('a_0001')?.id).toBe(parent);
    expect(listNodes({ kind: 'item', parentId: parent }).map((n) => n.id)).toEqual([first, second]);
  });

  it('never merges by similarity on its own', () => {
    createNode({ kind: 'person', name: 'person one' });
    const near = createNode({ kind: 'person', name: 'person 0ne' });

    expect(resolveAlias('person 0ne')?.id).toBe(near);
    expect(listNodes({ kind: 'person' })).toHaveLength(2);
  });

  it('rolls back node, aliases and scopes when a later alias conflicts', () => {
    createNode({
      kind: 'item',
      name: 'existing item',
      aliases: ['taken'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });
    const before = getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get();
    expect(() =>
      createNode({
        kind: 'item',
        name: 'new item',
        aliases: ['free-first', 'taken'],
        scopes: [{ kind: 'project', id: 'project-a' }],
      })
    ).toThrow(/already registered/);
    expect(getAdapter().prepare('SELECT COUNT(*) AS count FROM registry_nodes').get()).toEqual(
      before
    );
    expect(resolveAlias('free-first')).toBeNull();
  });

  it('rolls back an existing-node alias batch when a later alias conflicts', () => {
    const target = createNode({ kind: 'item', name: 'target item' });
    createNode({ kind: 'item', name: 'other item', aliases: ['taken'] });
    expect(() => addAliases(target, ['free-first', 'taken'])).toThrow(/already registered/);
    expect(resolveAlias('free-first')).toBeNull();
  });

  it('rolls back parent and earlier children when a later child conflicts', () => {
    createNode({
      kind: 'item',
      name: 'existing child',
      aliases: ['taken-child'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });
    expect(() =>
      upsertNode({
        kind: 'item',
        name: 'new parent',
        scopes: [{ kind: 'project', id: 'project-a' }],
        children: [
          { name: 'first child', aliases: ['first-child'] },
          { name: 'second child', aliases: ['taken-child'] },
        ],
      })
    ).toThrow(/already registered/);
    expect(resolveAlias('new parent')).toBeNull();
    expect(resolveAlias('first-child')).toBeNull();
  });

  it('hides a scoped alias and label outside its recorded scope', () => {
    const id = createNode({
      kind: 'item',
      name: 'private synthetic item',
      aliases: ['private-synthetic'],
      scopes: [{ kind: 'project', id: 'project-a' }],
    });

    expect(
      resolveAlias('private-synthetic', 'item', [{ kind: 'project', id: 'project-a' }])?.id
    ).toBe(id);
    expect(
      resolveAlias('private-synthetic', 'item', [{ kind: 'project', id: 'project-b' }])
    ).toBeNull();
    expect(listNodes({ scopes: [{ kind: 'project', id: 'project-b' }] })).toEqual([]);
  });

  it('allows the same alias in separate scopes without leaking the hidden node', () => {
    const a = createNode({
      kind: 'item',
      name: 'scope a item',
      aliases: ['shared-code'],
      scopes: [{ kind: 'project', id: 'a' }],
    });
    const b = createNode({
      kind: 'item',
      name: 'scope b item',
      aliases: ['shared-code'],
      scopes: [{ kind: 'project', id: 'b' }],
    });
    expect(resolveAlias('shared-code', 'item', [{ kind: 'project', id: 'a' }])?.id).toBe(a);
    expect(resolveAlias('shared-code', 'item', [{ kind: 'project', id: 'b' }])?.id).toBe(b);
    expect(() =>
      resolveAlias('shared-code', 'item', [
        { kind: 'project', id: 'a' },
        { kind: 'project', id: 'b' },
      ])
    ).toThrowError(expect.objectContaining({ code: 'alias_ambiguous' }));
  });

  it('adds an upsert alias only to the admitted scope of a multi-scope node', () => {
    createNode({
      kind: 'item',
      name: 'multi scope item',
      scopes: [
        { kind: 'project', id: 'a' },
        { kind: 'project', id: 'b' },
      ],
    });
    upsertNode({
      kind: 'item',
      name: 'multi scope item',
      aliases: ['a-only-alias'],
      scopes: [{ kind: 'project', id: 'a' }],
    });
    expect(resolveAlias('a-only-alias', 'item', [{ kind: 'project', id: 'a' }])).not.toBeNull();
    expect(resolveAlias('a-only-alias', 'item', [{ kind: 'project', id: 'b' }])).toBeNull();
  });

  it('propagates loser scopes on merge so a visible alias never reveals a hidden survivor', () => {
    const loser = createNode({
      kind: 'item',
      name: 'visible loser',
      scopes: [{ kind: 'project', id: 'a' }],
    });
    const survivor = createNode({
      kind: 'item',
      name: 'private survivor',
      scopes: [{ kind: 'project', id: 'b' }],
    });
    mergeNodes({ loser, survivor, reason: 'explicit merge' });
    expect(resolveAlias('visible loser', 'item', [{ kind: 'project', id: 'a' }])?.id).toBe(
      survivor
    );
  });
});
