import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../../src/sqlite.js';
import {
  ProcedureStore,
  procedureScopeKey,
  type ProcedureSaveInput,
} from '../../src/operator/procedure-store.js';

const access = { ownerScope: 'owner:a', projectId: 'project:a', channelId: 'telegram:a' };
function input(patch: Partial<ProcedureSaveInput> = {}): ProcedureSaveInput {
  return {
    id: 'report',
    correctionId: 'correction:1',
    title: 'Private report',
    description: 'Report layout',
    whenToUse: 'Reports only',
    whenNotToUse: 'Ordinary chat',
    body: 'Use five headings for reports',
    expectedResults: ['Readable report'],
    originalInstruction: '보고서에만 제목을 사용해',
    sourceRefs: ['message:1'],
    scope: {
      ownerScope: access.ownerScope,
      projectId: access.projectId,
      channelIds: [access.channelId],
    },
    supersededMemoryIds: ['memory:old'],
    ...patch,
  };
}
describe('TG-03/TG-05/TG-06 canonical procedure revisions', () => {
  let db: Database;
  let store: ProcedureStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new ProcedureStore(db);
  });
  afterEach(() => db.close());
  it('keeps original instruction and immutable history while updating a single head', () => {
    store.save(input(), access);
    store.save(
      input({ expectedRevision: 1, correctionId: 'correction:2', body: 'Narrower report rule' }),
      access
    );
    expect(store.list(access)).toHaveLength(1);
    expect(store.read('report', access)?.revision).toBe(2);
    expect(store.read('report', access, 1)?.body).toBe('Use five headings for reports');
    expect(store.history('report', access).map((r) => r.originalInstruction)).toEqual([
      '보고서에만 제목을 사용해',
      '보고서에만 제목을 사용해',
    ]);
    expect(store.supersededMemoryIds(access)).toEqual(['memory:old']);
    expect(() =>
      db.prepare('UPDATE operator_procedure_revisions SET record_json = ?').run('{}')
    ).toThrow(/immutable/);
  });
  it('deduplicates an exact correction retry but rejects changed intent or target', () => {
    const first = store.save(input(), access);
    expect(store.save(input(), access)).toEqual(first);
    expect(() => store.save(input({ body: 'Different intent' }), access)).toThrow(
      /correction.*conflict/
    );
    expect(() => store.save(input({ id: 'different' }), access)).toThrow(/correction.*conflict/);
    expect(store.history('report', access)).toHaveLength(1);
  });
  it('filters private metadata and rejects scope expansion before exposing content', () => {
    store.save(input(), access);
    for (const other of [
      { ...access, ownerScope: 'owner:b' },
      { ...access, projectId: 'project:b' },
      { ...access, channelId: 'telegram:b' },
      { ownerScope: access.ownerScope, projectId: access.projectId },
    ]) {
      expect(store.list(other)).toEqual([]);
      expect(store.read('report', other)).toBeNull();
      expect(store.history('report', other)).toEqual([]);
      expect(store.supersededMemoryIds(other)).toEqual([]);
    }
    expect(() =>
      store.save(
        input({ scope: { ...input().scope, channelIds: ['telegram:a', 'telegram:b'] } }),
        access
      )
    ).toThrow(/scope/);
  });
  it('retirement hides all executable revisions but preserves authorized audit history and suppressed old memories', () => {
    store.save(input(), access);
    store.retire('report', 1, 'retire:1', 'Too broad', access);
    expect(store.list(access)).toEqual([]);
    expect(store.read('report', access, 1)).toBeNull();
    expect(store.history('report', access).map((r) => r.status)).toEqual(['active', 'retired']);
    expect(store.supersededMemoryIds(access)).toEqual(['memory:old']);
    expect(store.retire('report', 1, 'retire:1', 'Too broad', access).revision).toBe(2);
    expect(() => store.retire('report', 1, 'retire:1', 'Different', access)).toThrow(/conflict/);
  });
  it('joins an outer transaction and rolls back the revision and head together', () => {
    store.save(input(), access);
    expect(() =>
      db.transaction(() => {
        store.save(
          input({ expectedRevision: 1, correctionId: 'correction:2', body: 'new' }),
          access
        );
        throw new Error('outer failure');
      })()
    ).toThrow('outer failure');
    expect(store.read('report', access)?.revision).toBe(1);
    expect(store.history('report', access)).toHaveLength(1);
    db.exec(
      "CREATE TRIGGER reject_revision BEFORE INSERT ON operator_procedure_revisions WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'revision failure'); END"
    );
    expect(() =>
      store.save(input({ expectedRevision: 1, correctionId: 'correction:2' }), access)
    ).toThrow('revision failure');
    expect(store.read('report', access)?.revision).toBe(1);
  });
  it('allows only one of two writers to commit the same expected revision and persists restart state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'procedure-store-'));
    const a = new Database(join(dir, 'triggers.db'));
    const b = new Database(join(dir, 'triggers.db'));
    try {
      const writerA = new ProcedureStore(a);
      const writerB = new ProcedureStore(b);
      writerA.save(input(), access);
      writerA.save(input({ expectedRevision: 1, correctionId: 'writer:a' }), access);
      expect(() =>
        writerB.save(input({ expectedRevision: 1, correctionId: 'writer:b' }), access)
      ).toThrow(/revision.*conflict/);
      expect(new ProcedureStore(b).read('report', access)?.revision).toBe(2);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('deduplicates receipts without turning selection or unknown results into success', () => {
    store.save(input(), access);
    const observation = {
      procedureId: 'report',
      revision: 1,
      receiptId: 'receipt:1',
      status: 'unknown' as const,
      evidenceRefs: ['run:1'],
    };
    store.recordOutcome(observation, access);
    store.recordOutcome(observation, access);
    expect(store.getOutcomes('report', access)).toHaveLength(1);
    expect(store.getOutcomes('report', access)[0].status).toBe('unknown');
    expect(() => store.recordOutcome({ ...observation, status: 'satisfied' }, access)).toThrow(
      /receipt.*conflict/
    );
  });
  it('retains committed projection intent after restart and marks only the exact head hash', () => {
    const projection = {
      path: '/workspace/brief.md',
      expectedFileHash: null,
      desiredText: 'corrected brief',
    };
    store.save(input({ projection }), access);
    const restarted = new ProcedureStore(db);
    expect(restarted.pendingProjections(access)).toHaveLength(1);
    expect(() => restarted.markProjected('report', 1, 'wrong', access)).toThrow(/hash/);
    const desiredHash = createHash('sha256').update(projection.desiredText).digest('hex');
    restarted.markProjected('report', 1, desiredHash, access);
    restarted.markProjected('report', 1, desiredHash, access);
    expect(restarted.pendingProjections(access)).toEqual([]);
    store.save(
      input({
        expectedRevision: 1,
        correctionId: 'projection:2',
        projection: { ...projection, expectedFileHash: desiredHash, desiredText: 'next' },
      }),
      access
    );
    expect(() => restarted.markProjected('report', 1, desiredHash, access)).toThrow(/revision/);
    expect(restarted.pendingProjections({ ...access, ownerScope: 'other' })).toEqual([]);
    expect(store.history('report', access)[0].projection?.desiredText).toBe('corrected brief');
  });
  it('updates unrestricted host-scoped procedures', () => {
    const scope = { ownerScope: access.ownerScope, projectId: access.projectId };
    store.save(input({ scope }), access);
    expect(
      store.save(input({ scope, expectedRevision: 1, correctionId: 'unrestricted:2' }), access)
        .revision
    ).toBe(2);
  });
  it('updates only active linked trigger references atomically without changing snapshots or stats', () => {
    db.exec(
      'CREATE TABLE operator_triggers (id TEXT, status TEXT, revision INTEGER, procedure_ref_json TEXT, fired INTEGER, procedure_json TEXT)'
    );
    store.save(input(), access);
    const ref = JSON.stringify({ id: 'report', revision: 1, scopeKey: procedureScopeKey(access) });
    db.prepare('INSERT INTO operator_triggers VALUES (?, ?, ?, ?, ?, ?)').run(
      'active',
      'active',
      4,
      ref,
      8,
      'original snapshot'
    );
    db.prepare('INSERT INTO operator_triggers VALUES (?, ?, ?, ?, ?, ?)').run(
      'disabled',
      'disabled',
      7,
      ref,
      12,
      'disabled snapshot'
    );
    store.save(input({ expectedRevision: 1, correctionId: 'linked:2' }), access);
    const rows = db.prepare('SELECT * FROM operator_triggers ORDER BY id').all() as Array<{
      revision: number;
      procedure_ref_json: string;
      fired: number;
      procedure_json: string;
    }>;
    expect(rows[0]).toMatchObject({ revision: 5, fired: 8, procedure_json: 'original snapshot' });
    expect(JSON.parse(rows[0].procedure_ref_json)).toEqual({
      id: 'report',
      revision: 2,
      scopeKey: procedureScopeKey(access),
    });
    expect(rows[1]).toMatchObject({ revision: 7, fired: 12 });
    db.exec(
      "CREATE TRIGGER reject_trigger_update BEFORE UPDATE ON operator_triggers BEGIN SELECT RAISE(ABORT, 'trigger failure'); END"
    );
    expect(() =>
      store.save(input({ expectedRevision: 2, correctionId: 'linked:3' }), access)
    ).toThrow('trigger failure');
    expect(store.read('report', access)?.revision).toBe(2);
    expect(store.history('report', access)).toHaveLength(2);
  });
  it('isolates identical logical IDs, correction IDs, receipts and projection acknowledgements by principal/project', () => {
    const other = { ...access, projectId: 'project:b' };
    const member = { ...access, ownerScope: 'member:b' };
    for (const [index, scoped] of [access, other, member].entries()) {
      store.save(
        input({
          body: `private:${index}`,
          scope: { ownerScope: scoped.ownerScope, projectId: scoped.projectId },
          projection: {
            path: `/tmp/private-${index}`,
            expectedFileHash: null,
            desiredText: `private:${index}`,
          },
        }),
        scoped
      );
      store.recordOutcome(
        {
          procedureId: 'report',
          revision: 1,
          receiptId: 'same-receipt',
          status: 'unknown',
          evidenceRefs: [`private:${index}`],
        },
        scoped
      );
    }
    expect(store.list(access).map((record) => record.body)).toEqual(['private:0']);
    expect(store.history('report', other).map((record) => record.body)).toEqual(['private:1']);
    expect(store.getOutcomes('report', member)[0].evidenceRefs).toEqual(['private:2']);
    store.markProjected(
      'report',
      1,
      createHash('sha256').update('private:0').digest('hex'),
      access
    );
    expect(store.pendingProjections(access)).toHaveLength(0);
    expect(store.pendingProjections(other)).toHaveLength(1);
    store.retire('report', 1, 'retire:same', 'Owner removed', access);
    expect(store.read('report', access)).toBeNull();
    expect(store.read('report', other)?.body).toBe('private:1');
    expect(store.read('report', member)?.body).toBe('private:2');
  });
  it('atomically binds a legacy snapshot per channel and refuses disabled trigger admission', () => {
    db.exec(
      'CREATE TABLE operator_triggers (id TEXT PRIMARY KEY, status TEXT, revision INTEGER, procedure_ref_json TEXT)'
    );
    db.prepare('INSERT INTO operator_triggers VALUES (?, ?, ?, ?)').run(
      'legacy',
      'active',
      1,
      null
    );
    const imported = store.importLegacyTrigger(input({ id: 'legacy:a' }), access, {
      triggerId: 'legacy',
      snapshotHash: 'original-hash',
    });
    expect(imported.revision).toBe(1);
    expect(store.getLegacyTriggerBinding('legacy', access)).toMatchObject({
      id: 'legacy:a',
      revision: 1,
      snapshotHash: 'original-hash',
    });
    expect(db.prepare('SELECT revision FROM operator_triggers WHERE id = ?').get('legacy')).toEqual(
      { revision: 2 }
    );
    expect(
      store.importLegacyTrigger(
        input({ id: 'different-id', correctionId: 'different-intent' }),
        access,
        { triggerId: 'legacy', snapshotHash: 'new-hash' }
      ).id
    ).toBe('legacy:a');
    const other = { ...access, channelId: 'telegram:b' };
    expect(store.getLegacyTriggerBinding('legacy', other)).toBeNull();
    store.importLegacyTrigger(
      input({
        id: 'legacy:b',
        correctionId: 'legacy:b',
        scope: {
          ownerScope: other.ownerScope,
          projectId: other.projectId,
          channelIds: [other.channelId],
        },
      }),
      other,
      { triggerId: 'legacy', snapshotHash: 'other-hash' }
    );
    expect(store.getLegacyTriggerBinding('legacy', other)?.id).toBe('legacy:b');
    const beforeCorrection = db
      .prepare('SELECT revision FROM operator_triggers WHERE id = ?')
      .get('legacy') as { revision: number };
    store.save(
      input({
        id: 'legacy:a',
        expectedRevision: 1,
        correctionId: 'legacy:a:correction',
        body: 'Corrected canonical body',
      }),
      access
    );
    expect(db.prepare('SELECT revision FROM operator_triggers WHERE id = ?').get('legacy')).toEqual(
      { revision: beforeCorrection.revision + 1 }
    );
    expect(store.getLegacyTriggerBinding('legacy', access)?.revision).toBe(1);

    db.prepare("UPDATE operator_triggers SET status = 'disabled' WHERE id = ?").run('legacy');
    expect(() => store.getLegacyTriggerBinding('legacy', access)).toThrow(/active/);
    expect(() =>
      store.importLegacyTrigger(input(), access, { triggerId: 'legacy', snapshotHash: 'snapshot' })
    ).toThrow(/disabled|active/);
  });
  it('rolls back legacy import when the trigger semantic revision cannot advance', () => {
    db.exec(
      'CREATE TABLE operator_triggers (id TEXT PRIMARY KEY, status TEXT, revision INTEGER, procedure_ref_json TEXT)'
    );
    db.prepare('INSERT INTO operator_triggers VALUES (?, ?, ?, ?)').run(
      'legacy',
      'active',
      1,
      null
    );
    db.exec(
      "CREATE TRIGGER reject_legacy_revision BEFORE UPDATE ON operator_triggers BEGIN SELECT RAISE(ABORT, 'legacy update failed'); END"
    );
    expect(() =>
      store.importLegacyTrigger(input(), access, { triggerId: 'legacy', snapshotHash: 'snapshot' })
    ).toThrow('legacy update failed');
    expect(store.list(access)).toEqual([]);
    expect(store.getLegacyTriggerBinding('legacy', access)).toBeNull();
  });
});
