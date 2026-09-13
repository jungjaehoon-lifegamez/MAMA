import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story R1/TG-03/TG-04/TG-05/TG-06: atomic agent judgment writes', () => {
  let dbPath = '';
  const access = {
    principalId: 'principal-test',
    agentId: 'agent-test',
    scopes: [{ kind: 'project' as const, id: 'scope-test' }],
  };

  beforeAll(async () => {
    dbPath = await initTestDB('judgment-atomic-write');
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM commitment_assignments').run();
    db.prepare('DELETE FROM commitments').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('AC #1 rejects an invisible reference without writing a judgment', async () => {
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-missing',
          topic: 'synthetic-launch',
          summary: 'Ship after evidence review',
          recordKind: 'judgment',
          links: [{ relation: 'mentions', target: { kind: 'registry', id: 'missing' } }],
        },
        access
      )
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
  });

  it('AC #1 rejects an unsupported reference kind instead of accepting it', async () => {
    const unsupported = { kind: 'case', id: 'case-not-implemented' } as unknown as {
      kind: 'memory';
      id: string;
    };
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-unsupported-ref',
          topic: 'synthetic-topic',
          summary: 'unsupported reference',
          recordKind: 'judgment',
          links: [{ relation: 'mentions', target: unsupported }],
        },
        access
      )
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
  });

  it('AC #2 commits explicit links and returns the original receipt on replay', async () => {
    const db = getAdapter();
    db.prepare(
      `INSERT INTO decisions (id, topic, decision, status, created_at, updated_at)
       VALUES ('memory-old', 'synthetic-launch', 'old view', 'active', 1000, 1000)`
    ).run();
    db.prepare(
      `INSERT INTO memory_scopes (id, kind, external_id)
       VALUES ('scope_project_c2NvcGUtdGVzdA', 'project', 'scope-test')`
    ).run();
    db.prepare(
      `INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary)
       VALUES ('memory-old', 'scope_project_c2NvcGUtdGVzdA', 1)`
    ).run();
    const command = {
      commandId: 'cmd-revise',
      topic: 'synthetic-launch',
      summary: 'new view',
      reasoning: 'new observation',
      recordKind: 'judgment' as const,
      links: [
        { relation: 'builds_on' as const, target: { kind: 'memory' as const, id: 'memory-old' } },
      ],
      replaces: [{ id: 'memory-old', reason: 'new evidence' }],
      scopes: access.scopes,
    };
    const receipt = await appendJudgment(command, access);
    expect(await appendJudgment(command, access)).toEqual(receipt);
    expect(
      getAdapter()
        .prepare(
          'SELECT edge_type, object_id FROM twin_edges WHERE subject_id = ? ORDER BY edge_type'
        )
        .all(receipt.recordId)
    ).toEqual([
      { edge_type: 'builds_on', object_id: 'memory-old' },
      { edge_type: 'supersedes', object_id: 'memory-old' },
    ]);
    expect(
      db.prepare("SELECT superseded_by, decision FROM decisions WHERE id = 'memory-old'").get()
    ).toEqual({
      superseded_by: receipt.recordId,
      decision: 'old view',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 2 });
  });

  it('AC #3 rejects a different payload for the same command without a second row', async () => {
    const command = {
      commandId: 'cmd-idempotent',
      topic: 'synthetic-topic',
      summary: 'first payload',
      recordKind: 'judgment' as const,
      scopes: access.scopes,
    };
    await appendJudgment(command, access);
    await expect(
      appendJudgment({ ...command, summary: 'different payload' }, access)
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 1 });
  });

  it('AC #3 binds an implicit access scope into the command replay identity', async () => {
    const command = {
      commandId: 'cmd-scope-bound',
      topic: 'synthetic-topic',
      summary: 'scope-bound payload',
      recordKind: 'judgment' as const,
    };
    await appendJudgment(command, access);
    await expect(
      appendJudgment(command, {
        ...access,
        scopes: [{ kind: 'project', id: 'other-scope' }],
      })
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 1 });
  });

  it('AC #3 refuses an embedder failure before opening the judgment transaction', async () => {
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-embedder-failure',
          topic: 'synthetic-topic',
          summary: 'must not persist',
          recordKind: 'judgment',
          scopes: access.scopes,
        },
        access,
        {
          embedder: {
            embed: async () => {
              throw new Error('synthetic embedder failure');
            },
          },
        }
      )
    ).rejects.toThrow('synthetic embedder failure');
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM command_bindings').get()).toEqual({
      n: 0,
    });
  });

  it('AC #3 returns one receipt for concurrent retries of the same command', async () => {
    const command = {
      commandId: 'cmd-concurrent-retry',
      topic: 'synthetic-topic',
      summary: 'concurrent payload',
      recordKind: 'judgment' as const,
      scopes: access.scopes,
    };
    const embedder = {
      embed: async () => new Float32Array(384),
    };
    const [first, second] = await Promise.all([
      appendJudgment(command, access, { embedder }),
      appendJudgment(command, access, { embedder }),
    ]);
    expect(second).toEqual(first);
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 1 });
  });

  it('AC #4 advances a commitment revision and rejects stale CAS', async () => {
    const create = await appendJudgment(
      {
        commandId: 'cmd-create',
        topic: 'synthetic-task',
        summary: 'own launch',
        recordKind: 'commitment',
        work: {
          operation: 'create',
          set: { title: 'Launch', roles: [] },
          clear: ['status'],
        },
        scopes: access.scopes,
      },
      access
    );
    const commitmentId = create.work!.commitmentId;
    const revised = await appendJudgment(
      {
        commandId: 'cmd-r1',
        topic: 'synthetic-task',
        summary: 'revise',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { status: 'active' },
        },
        scopes: access.scopes,
      },
      access
    );
    expect(revised.work?.revision).toBe(2);
    expect(
      getAdapter()
        .prepare(
          'SELECT clear_json FROM commitment_assignments WHERE commitment_id = ? AND revision = 1'
        )
        .get(commitmentId)
    ).toEqual({ clear_json: '["status"]' });
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-stale',
          topic: 'synthetic-task',
          summary: 'stale',
          recordKind: 'commitment',
          work: {
            operation: 'revise',
            commitmentId,
            expectedRevision: 1,
            set: { status: 'done' },
          },
          scopes: access.scopes,
        },
        access
      )
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 2 });
  });

  it('AC #4 rejects revising a withdrawn commitment', async () => {
    const create = await appendJudgment(
      {
        commandId: 'cmd-withdraw-create',
        topic: 'synthetic-task',
        summary: 'create then withdraw',
        recordKind: 'commitment',
        work: { operation: 'create', set: { title: 'Withdraw me' } },
        scopes: access.scopes,
      },
      access
    );
    const commitmentId = create.work!.commitmentId;
    await appendJudgment(
      {
        commandId: 'cmd-withdraw',
        topic: 'synthetic-task',
        summary: 'withdraw',
        recordKind: 'commitment',
        work: { operation: 'withdraw', commitmentId, expectedRevision: 1 },
        scopes: access.scopes,
      },
      access
    );
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-after-withdraw',
          topic: 'synthetic-task',
          summary: 'revise after withdraw',
          recordKind: 'commitment',
          work: { operation: 'revise', commitmentId, expectedRevision: 2 },
          scopes: access.scopes,
        },
        access
      )
    ).rejects.toMatchObject({ code: 'COMMITMENT_WITHDRAWN' });
  });
});
