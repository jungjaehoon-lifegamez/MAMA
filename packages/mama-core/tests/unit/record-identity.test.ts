import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter, queryDecisionGraph } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { createNode, mergeNodes } from '../../src/registry/store.js';
import {
  RecordIdentityError,
  listActors,
  listRecordIdsForItem,
  readRecordIdentity,
  setRecordIdentity,
} from '../../src/registry/record-identity.js';
import { saveLegacyMemory, saveMemory } from '../../src/memory/api.js';
import { createTrustedProvenanceCapability } from '../../src/memory/provenance.js';

/**
 * A record says what it is about by pointing at a node, not by spelling it in `topic`.
 *
 * Alternate spellings of one item cannot join through topic text alone. The actors table exists because one record routinely involves
 * several people in different roles - the single `assignee` slot was losing that.
 */
describe('record identity', () => {
  let dbPath: string;
  let item: string;
  let worker: string;
  let contact: string;

  beforeAll(async () => {
    dbPath = await initTestDB('record-identity');
  });
  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });
  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM record_actors').run();
    adapter.prepare('DELETE FROM memory_events').run();
    adapter.prepare('DELETE FROM decision_edges').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
    item = createNode({ kind: 'item', name: 'alpha item', aliases: ['a_0001'] });
    worker = createNode({ kind: 'person', name: 'person one' });
    contact = createNode({ kind: 'person', name: 'person two' });
    adapter
      .prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at,
           kind, status, summary) VALUES (?, 'alpha item', 'a fact', '', 0.8, 1000, 1000, 'decision', 'active', 'a fact')`
      )
      .run('rec_1');
  });

  it('binds a record to an item node and to several people with their roles', () => {
    setRecordIdentity({
      recordId: 'rec_1',
      itemId: item,
      actors: [
        { personId: worker, role: 'worker' },
        { personId: contact, role: 'client contact' },
      ],
    });

    expect(readRecordIdentity('rec_1')?.itemId).toBe(item);
    expect(listActors('rec_1')).toEqual([
      { personId: worker, role: 'worker' },
      { personId: contact, role: 'client contact' },
    ]);
  });

  it('keeps one person in two roles on the same record', () => {
    setRecordIdentity({
      recordId: 'rec_1',
      itemId: item,
      actors: [
        { personId: worker, role: 'worker' },
        { personId: worker, role: 'relay' },
      ],
    });

    expect(listActors('rec_1')).toHaveLength(2);
  });

  it('refuses an item id that is not a registered item, instead of storing a dangling string', () => {
    expect(() =>
      setRecordIdentity({ recordId: 'rec_1', itemId: 'reg_nonexistent', actors: [] })
    ).toThrow(RecordIdentityError);
    expect(readRecordIdentity('rec_1')?.itemId).toBeNull();
  });

  it('refuses a person node in the item slot, and an item node in an actor slot', () => {
    expect(() => setRecordIdentity({ recordId: 'rec_1', itemId: worker, actors: [] })).toThrow(
      RecordIdentityError
    );
    expect(() =>
      setRecordIdentity({
        recordId: 'rec_1',
        itemId: item,
        actors: [{ personId: item, role: 'worker' }],
      })
    ).toThrow(RecordIdentityError);
  });

  it('refuses an unknown record rather than writing an orphan actor row', () => {
    expect(() => setRecordIdentity({ recordId: 'rec_missing', itemId: item, actors: [] })).toThrow(
      RecordIdentityError
    );
    expect(getAdapter().prepare('SELECT COUNT(*) c FROM record_actors').get()).toEqual({ c: 0 });
  });

  it('resolves a merged node to its survivor, so old references keep answering', async () => {
    const { mergeNodes } = await import('../../src/registry/store.js');
    const survivor = createNode({ kind: 'item', name: 'alpha item canonical' });
    mergeNodes({ loser: item, survivor, reason: 'owner confirmed same item' });

    setRecordIdentity({ recordId: 'rec_1', itemId: item, actors: [] });

    expect(readRecordIdentity('rec_1')?.itemId).toBe(survivor);
  });

  it('replaces the actor set on a second write rather than accumulating stale roles', () => {
    setRecordIdentity({
      recordId: 'rec_1',
      itemId: item,
      actors: [{ personId: worker, role: 'worker' }],
    });
    setRecordIdentity({
      recordId: 'rec_1',
      itemId: item,
      actors: [{ personId: contact, role: 'worker' }],
    });

    expect(listActors('rec_1')).toEqual([{ personId: contact, role: 'worker' }]);
  });

  it('saves the decision, embedding, scope, item and actors in one adapter transaction', async () => {
    getAdapter().prepare('DELETE FROM decisions').run();
    const scopedItem = createNode({
      kind: 'item',
      name: 'scoped atomic item',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
    });
    const scopedWorker = createNode({
      kind: 'person',
      name: 'scoped atomic worker',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
    });

    const saved = await saveMemory({
      topic: 'atomic record identity',
      kind: 'decision',
      summary: 'Persist the explicit work identity',
      details: 'The record and identity share one transaction.',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
      source: { package: 'mama-core', source_type: 'test' },
      itemId: scopedItem,
      actors: [{ personId: scopedWorker, role: 'worker' }],
    });

    expect(readRecordIdentity(saved.id)).toEqual({ itemId: scopedItem });
    expect(listActors(saved.id)).toEqual([{ personId: scopedWorker, role: 'worker' }]);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM memory_scope_bindings WHERE memory_id = ?')
        .get(saved.id)
    ).toEqual({ count: 1 });
  });

  it('rolls back every save row when actor insertion fails inside the transaction', async () => {
    const db = getAdapter();
    db.prepare('DELETE FROM decisions').run();
    const rollbackScope = { kind: 'project' as const, id: 'previously-absent-scope' };
    const scopedItem = createNode({
      kind: 'item',
      name: 'rollback scoped item',
      scopes: [rollbackScope],
    });
    const scopedWorker = createNode({
      kind: 'person',
      name: 'rollback scoped worker',
      scopes: [rollbackScope],
    });
    db.exec(`
      CREATE TRIGGER fail_record_actor_insert
      BEFORE INSERT ON record_actors
      BEGIN
        SELECT RAISE(ABORT, 'synthetic actor insertion failure');
      END
    `);

    await expect(
      saveMemory({
        topic: 'rollback record identity',
        kind: 'decision',
        summary: 'This must leave no partial record',
        details: 'A real SQLite trigger fails the actor insertion.',
        scopes: [rollbackScope],
        source: { package: 'mama-core', source_type: 'test' },
        itemId: scopedItem,
        actors: [{ personId: scopedWorker, role: 'worker' }],
      })
    ).rejects.toThrow('synthetic actor insertion failure');

    db.exec('DROP TRIGGER fail_record_actor_insert');
    expect(db.prepare('SELECT COUNT(*) AS count FROM decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM embeddings').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_scope_bindings').get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM memory_scopes WHERE external_id = ?')
        .get(rollbackScope.id)
    ).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM record_actors').get()).toEqual({ count: 0 });
  });

  it('rejects a known node outside the effective save scopes without leaving save rows', async () => {
    const db = getAdapter();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM decisions').run();
    const hidden = createNode({
      kind: 'item',
      name: 'scope a item',
      scopes: [{ kind: 'project', id: 'scope-a' }],
    });

    await expect(
      saveMemory({
        topic: 'hidden identity',
        kind: 'decision',
        summary: 'Must fail closed',
        details: 'Known ids do not grant visibility.',
        scopes: [{ kind: 'project', id: 'scope-b' }],
        source: { package: 'mama-core', source_type: 'test' },
        itemId: hidden,
      })
    ).rejects.toMatchObject({ code: 'hidden_node' });

    for (const table of [
      'decisions',
      'embeddings',
      'memory_scope_bindings',
      'memory_events',
      'record_actors',
      'decision_edges',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM memory_scopes WHERE external_id = 'scope-b'").get()
    ).toEqual({ count: 0 });
  });

  it('seeds only current exact-topic rows and traverses their explicit cross-topic history', async () => {
    const db = getAdapter();
    db.prepare('DELETE FROM decisions').run();
    const insert = db.prepare(
      `INSERT INTO decisions
        (id, topic, decision, reasoning, confidence, supersedes, superseded_by, created_at, updated_at)
       VALUES (?, ?, ?, '', 1, ?, ?, ?, ?)`
    );
    insert.run('old-cross-topic', 'previous-topic', 'old', null, 'current-topic', 1, 1);
    db.prepare('UPDATE decisions SET refined_from = ? WHERE id = ?').run(
      JSON.stringify(['source-a']),
      'old-cross-topic'
    );
    insert.run('current-topic', 'exact-topic', 'current', 'old-cross-topic', null, 2, 2);
    insert.run('prefix-only', 'exact-topic-extra', 'prefix', null, null, 3, 3);

    const graph = await queryDecisionGraph('exact-topic');
    expect(graph.map((row) => row.id)).toEqual(['current-topic', 'old-cross-topic']);
    expect(graph.find((row) => row.id === 'old-cross-topic')?.refined_from).toEqual(['source-a']);
  });

  it('deduplicates repeated explicit edges and denies trusted cross-scope supersedes atomically', async () => {
    const db = getAdapter();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM decisions').run();
    const target = await saveMemory({
      topic: 'target',
      kind: 'decision',
      summary: 'target',
      details: 'target details',
      scopes: [{ kind: 'project', id: 'b' }],
      source: { package: 'mama-core', source_type: 'test' },
    });
    await saveLegacyMemory(
      {
        topic: 'dedupe',
        kind: 'decision',
        summary: 'dedupe',
        details: 'explicit links',
        scopes: [{ kind: 'project', id: 'a' }],
        source: { package: 'mama-core', source_type: 'test' },
      },
      { relationships: [{ type: 'builds_on', targetIds: [target.id, target.id] }] }
    );
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM decision_edges WHERE relationship='builds_on'")
        .get()
    ).toEqual({ count: 1 });

    const before = db.prepare('SELECT COUNT(*) AS count FROM decisions').get();
    await expect(
      saveLegacyMemory(
        {
          topic: 'denied',
          kind: 'decision',
          summary: 'denied',
          details: 'cross scope',
          scopes: [{ kind: 'project', id: 'a' }],
          source: { package: 'mama-core', source_type: 'test' },
        },
        { relationships: [{ type: 'supersedes', targetIds: [target.id] }] },
        {
          capability: createTrustedProvenanceCapability(),
          provenance: { actor: 'main_agent' },
          authoritativeScopes: [
            { kind: 'project', id: 'a' },
            { kind: 'project', id: 'b' },
          ],
        }
      )
    ).rejects.toMatchObject({
      code: 'relationship_target_unavailable',
      message: 'Relationship target is unavailable',
    });
    await expect(
      saveLegacyMemory(
        {
          topic: 'unknown-denied',
          kind: 'decision',
          summary: 'unknown',
          details: 'same response',
          scopes: [{ kind: 'project', id: 'a' }],
          source: { package: 'mama-core', source_type: 'test' },
        },
        { relationships: [{ type: 'supersedes', targetIds: ['decision_unknown'] }] },
        {
          capability: createTrustedProvenanceCapability(),
          provenance: { actor: 'main_agent' },
          authoritativeScopes: [{ kind: 'project', id: 'a' }],
        }
      )
    ).rejects.toMatchObject({
      code: 'relationship_target_unavailable',
      message: 'Relationship target is unavailable',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM decisions').get()).toEqual(before);

    const targetRow = db.prepare('SELECT rowid FROM decisions WHERE id = ?').get(target.id) as {
      rowid: number;
    };
    db.insertEmbedding(targetRow.rowid, [1, 0]);
    await saveLegacyMemory(
      {
        topic: 'authorized',
        kind: 'decision',
        summary: 'authorized',
        details: 'same scope',
        scopes: [{ kind: 'project', id: 'b' }],
        source: { package: 'mama-core', source_type: 'test' },
      },
      { relationships: [{ type: 'supersedes', targetIds: [target.id] }] },
      {
        capability: createTrustedProvenanceCapability(),
        provenance: { actor: 'main_agent' },
        authoritativeScopes: [{ kind: 'project', id: 'b' }],
      }
    );
    expect(db.prepare('SELECT status FROM decisions WHERE id = ?').get(target.id)).toEqual({
      status: 'superseded',
    });
    expect(db.vectorSearch([1, 0], 5, undefined, ['superseded'])).toEqual([]);
  });

  it('includes records bound to transitive merged losers in the survivor timeline', () => {
    const db = getAdapter();
    db.prepare('DELETE FROM decisions').run();
    const first = createNode({ kind: 'item', name: 'first loser' });
    const second = createNode({ kind: 'item', name: 'second loser' });
    const survivor = createNode({ kind: 'item', name: 'timeline survivor' });
    db.prepare(
      `INSERT INTO decisions
       (id, topic, decision, confidence, item_id, created_at, updated_at)
       VALUES ('timeline-old', 'old', 'old', 1, ?, 1, 1)`
    ).run(first);
    mergeNodes({ loser: first, survivor: second, reason: 'explicit' });
    mergeNodes({ loser: second, survivor, reason: 'explicit' });
    expect(listRecordIdsForItem(survivor).map((row) => row.id)).toContain('timeline-old');
  });
});
