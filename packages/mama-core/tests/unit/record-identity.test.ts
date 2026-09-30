import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { queryDecisionGraph } from '../../src/knowledge/graph-query.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import { createNode, mergeNodes } from '../../src/registry/store.js';
import {
  RecordIdentityError,
  listActors,
  listRecordIdsForItem,
  readRecordIdentity,
} from '../../src/registry/record-identity.js';
import { saveLegacyMemory, saveMemory } from '../../src/memory/api.js';

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
    adapter.prepare('DELETE FROM commitment_assignments').run();
    adapter.prepare('DELETE FROM commitments').run();
    adapter.prepare('DELETE FROM judgment_commands').run();
    adapter.prepare('DELETE FROM source_commands').run();
    adapter.prepare('DELETE FROM command_bindings').run();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM decisions').run();
    // embeddings rows key on decisions.rowid with no cascade; clear the orphans.
    adapter.prepare('DELETE FROM embeddings').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
    item = createNode(getAdapter(), { kind: 'item', name: 'alpha item', aliases: ['a_0001'] });
    worker = createNode(getAdapter(), { kind: 'person', name: 'person one' });
    contact = createNode(getAdapter(), { kind: 'person', name: 'person two' });
    adapter
      .prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at,
           kind, status, summary) VALUES (?, 'alpha item', 'a fact', '', 0.8, 1000, 1000, 'decision', 'active', 'a fact')`
      )
      .run('rec_1');
  });

  /**
   * Identity is bound in the transaction that appends the record, so every case below goes
   * through the save that production uses. There is no entry point that rebinds a record that
   * is already stored: doing that is a correction, and corrections carry their own command.
   */
  const save = (fields: {
    itemId?: string | null;
    actors?: Array<{ personId: string; role: string }>;
  }) =>
    saveMemory(getAdapter(), {
      topic: 'alpha item',
      kind: 'decision',
      summary: 'a fact',
      details: 'the record states what it is about by pointing at a node',
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
      ...fields,
    });

  it('binds a record to an item node and to several people with their roles', async () => {
    const saved = await save({
      itemId: item,
      actors: [
        { personId: worker, role: 'worker' },
        { personId: contact, role: 'client contact' },
      ],
    });

    expect(readRecordIdentity(getAdapter(), saved.id)?.itemId).toBe(item);
    expect(listActors(getAdapter(), saved.id)).toEqual([
      { personId: worker, role: 'worker' },
      { personId: contact, role: 'client contact' },
    ]);
  });

  it('keeps one person in two roles on the same record', async () => {
    const saved = await save({
      itemId: item,
      actors: [
        { personId: worker, role: 'worker' },
        { personId: worker, role: 'relay' },
      ],
    });

    expect(listActors(getAdapter(), saved.id)).toHaveLength(2);
  });

  it('refuses an item id that is not a registered item, instead of storing a dangling string', async () => {
    await expect(save({ itemId: 'reg_nonexistent' })).rejects.toThrow(RecordIdentityError);
    expect(getAdapter().prepare('SELECT COUNT(*) c FROM record_actors').get()).toEqual({ c: 0 });
  });

  it('refuses a person node in the item slot, and an item node in an actor slot', async () => {
    await expect(save({ itemId: worker })).rejects.toThrow(RecordIdentityError);
    await expect(
      save({ itemId: item, actors: [{ personId: item, role: 'worker' }] })
    ).rejects.toThrow(RecordIdentityError);
  });

  it('resolves a merged node to its survivor, so old references keep answering', async () => {
    const survivor = createNode(getAdapter(), { kind: 'item', name: 'alpha item canonical' });
    mergeNodes(getAdapter(), { loser: item, survivor, reason: 'owner confirmed same item' });

    const saved = await save({ itemId: item });

    expect(readRecordIdentity(getAdapter(), saved.id)?.itemId).toBe(survivor);
  });

  it('saves the decision, embedding, scope, item and actors in one adapter transaction', async () => {
    getAdapter().prepare('DELETE FROM decisions').run();
    const scopedItem = createNode(getAdapter(), {
      kind: 'item',
      name: 'scoped atomic item',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
    });
    const scopedWorker = createNode(getAdapter(), {
      kind: 'person',
      name: 'scoped atomic worker',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
    });

    const saved = await saveMemory(getAdapter(), {
      topic: 'atomic record identity',
      kind: 'decision',
      summary: 'Persist the explicit work identity',
      details: 'The record and identity share one transaction.',
      scopes: [{ kind: 'project', id: 'synthetic-project' }],
      source: { package: 'mama-core', source_type: 'test' },
      itemId: scopedItem,
      actors: [{ personId: scopedWorker, role: 'worker' }],
    });

    expect(readRecordIdentity(getAdapter(), saved.id)).toEqual({ itemId: scopedItem });
    expect(listActors(getAdapter(), saved.id)).toEqual([
      { personId: scopedWorker, role: 'worker' },
    ]);
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
    const scopedItem = createNode(getAdapter(), {
      kind: 'item',
      name: 'rollback scoped item',
      scopes: [rollbackScope],
    });
    const scopedWorker = createNode(getAdapter(), {
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
      saveMemory(getAdapter(), {
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
    const hidden = createNode(getAdapter(), {
      kind: 'item',
      name: 'scope a item',
      scopes: [{ kind: 'project', id: 'scope-a' }],
    });

    await expect(
      saveMemory(getAdapter(), {
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

    const graph = await queryDecisionGraph(getAdapter(), 'exact-topic');
    expect(graph.map((row) => row.id)).toEqual(['current-topic', 'old-cross-topic']);
    expect(graph.find((row) => row.id === 'old-cross-topic')?.refined_from).toEqual(['source-a']);
  });

  it('writes only the links the caller names, and refuses a replacement outside its scopes atomically', async () => {
    const db = getAdapter();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM decisions').run();
    const target = await saveMemory(getAdapter(), {
      topic: 'target',
      kind: 'decision',
      summary: 'target',
      details: 'target details',
      scopes: [{ kind: 'project', id: 'b' }],
      source: { package: 'mama-core', source_type: 'test' },
    });
    const writer = {
      principalId: 'main_agent',
      agentId: 'main_agent',
      scopes: [{ kind: 'project' as const, id: 'b' }],
      actions: [],
    };
    const link = {
      relation: 'builds_on' as const,
      target: { kind: 'memory' as const, id: target.id },
      attrs: { reason: 'extends the target' },
    };
    await expect(
      saveLegacyMemory(
        getAdapter(),
        {
          topic: 'repeated',
          kind: 'decision',
          summary: 'repeated',
          details: 'the same link twice',
          scopes: [{ kind: 'project', id: 'b' }],
          source: { package: 'mama-core', source_type: 'test' },
          links: [link, link],
        },
        {},
        writer
      )
    ).rejects.toThrow(/same relation target/);
    await saveLegacyMemory(
      getAdapter(),
      {
        topic: 'linked',
        kind: 'decision',
        summary: 'linked',
        details: 'one named link',
        scopes: [{ kind: 'project', id: 'b' }],
        source: { package: 'mama-core', source_type: 'test' },
        links: [link],
      },
      {},
      writer
    );
    expect(
      db
        .prepare(
          "SELECT edge_type, object_id, reason_text FROM twin_edges WHERE edge_type = 'builds_on'"
        )
        .all()
    ).toEqual([
      { edge_type: 'builds_on', object_id: target.id, reason_text: 'extends the target' },
    ]);

    const before = db.prepare('SELECT COUNT(*) AS count FROM decisions').get();
    for (const id of [target.id, 'decision_unknown']) {
      await expect(
        saveLegacyMemory(
          getAdapter(),
          {
            topic: 'denied',
            kind: 'decision',
            summary: 'denied',
            details: 'cross scope',
            scopes: [{ kind: 'project', id: 'a' }],
            source: { package: 'mama-core', source_type: 'test' },
            replaces: [{ id, reason: 'replaced' }],
          },
          {},
          { ...writer, scopes: [{ kind: 'project', id: 'a' }] }
        )
      ).rejects.toThrow(/unavailable/);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM decisions').get()).toEqual(before);

    const targetRow = db.prepare('SELECT rowid FROM decisions WHERE id = ?').get(target.id) as {
      rowid: number;
    };
    db.insertEmbedding(targetRow.rowid, [1, 0]);
    await saveLegacyMemory(
      getAdapter(),
      {
        topic: 'authorized',
        kind: 'decision',
        summary: 'authorized',
        details: 'same scope',
        scopes: [{ kind: 'project', id: 'b' }],
        source: { package: 'mama-core', source_type: 'test' },
        replaces: [{ id: target.id, reason: 'the owner changed it' }],
      },
      {},
      writer
    );
    expect(db.prepare('SELECT status FROM decisions WHERE id = ?').get(target.id)).toEqual({
      status: 'superseded',
    });
    expect(db.vectorSearch([1, 0], 5, undefined, ['superseded'])).toEqual([]);
  });

  it('includes records bound to transitive merged losers in the survivor timeline', () => {
    const db = getAdapter();
    db.prepare('DELETE FROM decisions').run();
    const first = createNode(getAdapter(), { kind: 'item', name: 'first loser' });
    const second = createNode(getAdapter(), { kind: 'item', name: 'second loser' });
    const survivor = createNode(getAdapter(), { kind: 'item', name: 'timeline survivor' });
    db.prepare(
      `INSERT INTO decisions
       (id, topic, decision, confidence, item_id, created_at, updated_at)
       VALUES ('timeline-old', 'old', 'old', 1, ?, 1, 1)`
    ).run(first);
    mergeNodes(getAdapter(), { loser: first, survivor: second, reason: 'explicit' });
    mergeNodes(getAdapter(), { loser: second, survivor, reason: 'explicit' });
    expect(listRecordIdsForItem(getAdapter(), survivor).map((row) => row.id)).toContain(
      'timeline-old'
    );
  });
});
