import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  RegistryError,
  addAlias,
  createNode,
  listNodes,
  mergeNodes,
  resolveAlias,
  splitNode,
} from '../../src/registry/store.js';

/**
 * The registry is the one place that says "these names are the same thing".
 *
 * Measured 2026-09-11 on the live ledger: one work item appeared under three key spellings
 * and one person under two display names, so facts filed under them never joined. A string
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
});
