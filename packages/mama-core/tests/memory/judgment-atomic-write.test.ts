import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { createWork, reviseWork } from '../../src/knowledge/commitments.js';
import { createNode } from '../../src/registry/store.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

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
    db.prepare('DELETE FROM record_actors').run();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_nodes').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it.each([
    { reasoning: '', expected: '' },
    { reasoning: null, expected: null },
    { reasoning: undefined, expected: null },
  ])(
    'preserves explicit empty reasoning without changing absent reasoning ($reasoning)',
    async ({ reasoning, expected }) => {
      const adapter = getAdapter();
      const saved = await appendJudgment(
        {
          commandId: 'exact-reasoning',
          topic: 'record-text',
          summary: 'Keep the complete text',
          recordKind: 'judgment',
          ...(reasoning === undefined ? {} : { reasoning }),
        },
        access,
        { adapter }
      );
      expect(
        adapter.prepare('SELECT reasoning FROM decisions WHERE id = ?').get(saved.recordId)
      ).toEqual({ reasoning: expected });
    }
  );

  it('keeps one run and agent on its record, linked edge, and commitment stores', async () => {
    const adapter = getAdapter();
    const modelRunId = 'run-judgment-and-work';
    const agentAccess = { ...access, agentId: 'mama-owner' };
    const basis = await appendJudgment(
      {
        commandId: 'run-basis',
        topic: 'source-review',
        summary: 'Reviewed the source evidence',
        recordKind: 'judgment',
        modelRunId,
      },
      agentAccess,
      { adapter }
    );
    const work = await createWork(
      {
        commandId: 'run-work',
        topic: 'source-review',
        summary: 'Follow up on the source evidence',
        reasoning: 'The review found unfinished work',
        set: { title: 'Follow up', completionCriteria: 'Evidence reviewed' },
        links: [{ relation: 'derived_from', target: { kind: 'memory', id: basis.recordId } }],
        modelRunId,
      },
      agentAccess,
      { adapter }
    );
    for (const id of [basis.recordId, work.recordRef.id]) {
      expect(
        adapter.prepare('SELECT agent_id, model_run_id FROM decisions WHERE id = ?').get(id)
      ).toEqual({ agent_id: 'mama-owner', model_run_id: modelRunId });
    }
    expect(
      adapter
        .prepare('SELECT agent_id, model_run_id, reason_text FROM twin_edges WHERE subject_id = ?')
        .get(work.recordRef.id)
    ).toEqual({
      agent_id: 'mama-owner',
      model_run_id: modelRunId,
      reason_text: 'The review found unfinished work',
    });
    expect(
      adapter
        .prepare('SELECT agent_id, model_run_id FROM commitments WHERE commitment_id = ?')
        .get(work.commitmentId)
    ).toEqual({ agent_id: 'mama-owner', model_run_id: modelRunId });
    expect(
      adapter
        .prepare(
          'SELECT agent_id, model_run_id FROM commitment_assignments WHERE commitment_id = ?'
        )
        .get(work.commitmentId)
    ).toEqual({ agent_id: 'mama-owner', model_run_id: modelRunId });

    const nextRunId = 'run-work-revision';
    const revised = await reviseWork(
      {
        commandId: 'run-work-revision',
        commitmentId: work.commitmentId,
        expectedRevision: 1,
        summary: 'Follow-up evidence reviewed',
        set: { status: 'done' },
        modelRunId: nextRunId,
      },
      agentAccess,
      { adapter }
    );
    expect(
      adapter
        .prepare('SELECT agent_id, model_run_id FROM decisions WHERE id = ?')
        .get(revised.recordRef.id)
    ).toEqual({ agent_id: 'mama-owner', model_run_id: nextRunId });
    expect(
      adapter
        .prepare('SELECT agent_id, model_run_id FROM commitments WHERE commitment_id = ?')
        .get(work.commitmentId)
    ).toEqual({ agent_id: 'mama-owner', model_run_id: nextRunId });
    expect(
      adapter
        .prepare(
          'SELECT revision, model_run_id FROM commitment_assignments WHERE commitment_id = ? ORDER BY revision'
        )
        .all(work.commitmentId)
    ).toEqual([
      { revision: 1, model_run_id: modelRunId },
      { revision: 2, model_run_id: nextRunId },
    ]);
  });

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
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toMatchObject({
      code: 'REFERENCE_NOT_FOUND',
      message: expect.stringContaining('registry missing'),
    });
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
        access,
        { adapter: getAdapter() }
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
    const receipt = await appendJudgment(command, access, { adapter: getAdapter() });
    expect(await appendJudgment(command, access, { adapter: getAdapter() })).toEqual(receipt);
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
    await appendJudgment(command, access, { adapter: getAdapter() });
    await expect(
      appendJudgment({ ...command, summary: 'different payload' }, access, {
        adapter: getAdapter(),
      })
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
    await appendJudgment(command, access, { adapter: getAdapter() });
    await expect(
      appendJudgment(
        command,
        {
          ...access,
          scopes: [{ kind: 'project', id: 'other-scope' }],
        },
        { adapter: getAdapter() }
      )
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
          adapter: getAdapter(),
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
      appendJudgment(command, access, { adapter: getAdapter(), embedder }),
      appendJudgment(command, access, { adapter: getAdapter(), embedder }),
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
      access,
      { adapter: getAdapter() }
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
      access,
      { adapter: getAdapter() }
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
        access,
        { adapter: getAdapter() }
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
      access,
      { adapter: getAdapter() }
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
      access,
      { adapter: getAdapter() }
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
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toMatchObject({ code: 'COMMITMENT_WITHDRAWN' });
  });

  /**
   * `saveMemory` screens identity references before it builds the command, but the command
   * itself is the public contract and a caller may reach it without that screen. These two
   * cases hold the boundary's own refusal: remove the check inside the identity writer and
   * they are the tests that fail.
   */
  it('AC #5 refuses an identity projection naming a node that is not registered', async () => {
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-identity-unknown',
          topic: 'synthetic-item',
          summary: 'bind to a node that does not exist',
          recordKind: 'judgment',
          scopes: access.scopes,
          projections: { recordIdentity: { itemId: 'reg_nonexistent', actors: [] } },
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toMatchObject({ code: 'unknown_node' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
  });

  it('AC #5 refuses an identity projection putting an item node in an actor slot', async () => {
    const item = createNode(getAdapter(), { kind: 'item', name: 'synthetic bound item' });
    await expect(
      appendJudgment(
        {
          commandId: 'cmd-identity-wrong-kind',
          topic: 'synthetic-item',
          summary: 'bind an item where a person belongs',
          recordKind: 'judgment',
          scopes: access.scopes,
          projections: {
            recordIdentity: { itemId: item, actors: [{ personId: item, role: 'worker' }] },
          },
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toMatchObject({ code: 'wrong_kind' });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM record_actors').get()).toEqual({ n: 0 });
  });
});
