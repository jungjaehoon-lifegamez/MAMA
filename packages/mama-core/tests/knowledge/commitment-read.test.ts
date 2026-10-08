/**
 * The read side of the commitment log.
 *
 * Every commitment here is written through the real `appendJudgment` path, never
 * seeded: a fold asserted against rows this test inserted itself would prove the
 * test's own SQL, not the writer's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureMemoryScope, getAdapter } from '../../src/db-manager.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { readWork, reviseWork } from '../../src/knowledge/commitments.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const access = {
  principalId: 'principal-read',
  agentId: 'agent-read',
  scopes: [{ kind: 'project' as const, id: 'scope-read' }],
};

const otherAccess = {
  principalId: 'principal-other',
  agentId: 'agent-other',
  scopes: [{ kind: 'project' as const, id: 'scope-other' }],
};

async function createCommitment(
  commandId: string,
  set: Record<string, unknown>,
  scopes = access.scopes,
  auth = access
): Promise<string> {
  const receipt = await appendJudgment(
    {
      commandId,
      topic: `topic-${commandId}`,
      summary: `summary-${commandId}`,
      recordKind: 'commitment',
      work: { operation: 'create', set },
      scopes,
    },
    auth,
    { adapter: getAdapter(), embedder: null }
  );
  return receipt.work!.commitmentId;
}

function assignmentCreatedAt(commitmentId: string, revision: number): number {
  return (
    getAdapter()
      .prepare(
        'SELECT created_at AS at FROM commitment_assignments WHERE commitment_id = ? AND revision = ?'
      )
      .get(commitmentId, revision) as { at: number }
  ).at;
}

describe('knowledge/commitments: reading owner work back', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('commitment-read');
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

  it('folds every revision into the values a reader sees', async () => {
    const commitmentId = await createCommitment('cmd-fold', {
      title: 'Ship the connector',
      status: 'pending',
      priority: 'normal',
    });
    await appendJudgment(
      {
        commandId: 'cmd-fold-2',
        topic: 'topic-cmd-fold',
        summary: 'raise priority and start',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { status: 'in_progress', priority: 'high' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const page = readWork(getAdapter(), { commitmentId }, access);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      commitmentId,
      revision: 2,
      withdrawn: false,
      values: { title: 'Ship the connector', status: 'in_progress', priority: 'high' },
    });
    // The record that wrote each surviving revision, oldest first.
    expect(page.items[0].basis).toHaveLength(2);
    expect(page.items[0].latestJudgmentRef).toEqual(page.items[0].basis[1]);
  });

  it('applies clear after set, so a cleared field is absent rather than null', async () => {
    const commitmentId = await createCommitment('cmd-clear', {
      title: 'Draft the plan',
      assigneeText: 'owner',
    });
    await appendJudgment(
      {
        commandId: 'cmd-clear-2',
        topic: 'topic-cmd-clear',
        summary: 'unassign',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          clear: ['assigneeText'],
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const values = readWork(getAdapter(), { commitmentId }, access).items[0].values;

    expect(values).toEqual({ title: 'Draft the plan' });
    expect('assigneeText' in values).toBe(false);
  });

  it('marks a withdrawn commitment without erasing what it held', async () => {
    const commitmentId = await createCommitment('cmd-withdraw', { title: 'Cancelled work' });
    await appendJudgment(
      {
        commandId: 'cmd-withdraw-2',
        topic: 'topic-cmd-withdraw',
        summary: 'withdraw',
        recordKind: 'commitment',
        work: { operation: 'withdraw', commitmentId, expectedRevision: 1 },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const view = readWork(getAdapter(), { commitmentId }, access).items[0];

    expect(view.withdrawn).toBe(true);
    expect(view.values).toEqual({ title: 'Cancelled work' });
  });

  it("returns each revision under history:'all' and omits it otherwise", async () => {
    const commitmentId = await createCommitment('cmd-history', { title: 'First title' });
    await appendJudgment(
      {
        commandId: 'cmd-history-2',
        topic: 'topic-cmd-history',
        summary: 'rename',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { title: 'Corrected title' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const current = readWork(getAdapter(), { commitmentId }, access).items[0];
    expect(current.history).toBeUndefined();
    expect(current.values.title).toBe('Corrected title');

    const full = readWork(getAdapter(), { commitmentId, history: 'all' }, access).items[0];
    // The correction does not erase what it corrected.
    expect(full.history?.map((revision) => revision.set.title)).toEqual([
      'First title',
      'Corrected title',
    ]);
    expect(full.history?.map((revision) => revision.operation)).toEqual(['create', 'revise']);
  });

  it('returns a compact chain with lifecycle state folded through seven revisions', async () => {
    const commitmentId = await createCommitment('cmd-chain-create', {
      title: 'Follow the rollout',
      status: 'pending',
      stage: 'intake',
    });
    await appendJudgment(
      {
        commandId: 'cmd-chain-start',
        topic: 'topic-chain',
        summary: 'start the rollout',
        recordKind: 'commitment',
        eventDatetime: 2_000,
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { status: 'in_progress' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-draft',
        topic: 'topic-chain',
        summary: 'move to draft',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 2,
          set: { stage: 'draft' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-clear-stage',
        topic: 'topic-chain',
        summary: 'clear the draft stage',
        recordKind: 'commitment',
        eventDatetime: 4_000,
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 3,
          clear: ['stage'],
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-review',
        topic: 'topic-chain',
        summary: 'send for review',
        recordKind: 'commitment',
        eventDatetime: 5_000,
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 4,
          set: { status: 'review', stage: 'review' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-clear-status',
        topic: 'topic-chain',
        summary: 'clear the review status',
        recordKind: 'commitment',
        eventDatetime: 6_000,
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 5,
          clear: ['status'],
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-withdraw',
        topic: 'topic-chain',
        summary: 'withdraw the rollout',
        recordKind: 'commitment',
        eventDatetime: 7_000,
        work: { operation: 'withdraw', commitmentId, expectedRevision: 6 },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const chain = readWork(getAdapter(), { commitmentId, history: 'chain' }, access).items[0];

    expect(chain.history).toBeUndefined();
    expect(chain.chain).toEqual([
      {
        revision: 1,
        operation: 'create',
        eventDatetime: null,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'pending',
        stage: 'intake',
        summary: 'summary-cmd-chain-create',
      },
      {
        revision: 2,
        operation: 'revise',
        eventDatetime: 2_000,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'in_progress',
        stage: 'intake',
        summary: 'start the rollout',
      },
      {
        revision: 3,
        operation: 'revise',
        eventDatetime: null,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'in_progress',
        stage: 'draft',
        summary: 'move to draft',
      },
      {
        revision: 4,
        operation: 'revise',
        eventDatetime: 4_000,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'in_progress',
        stage: null,
        summary: 'clear the draft stage',
      },
      {
        revision: 5,
        operation: 'revise',
        eventDatetime: 5_000,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'review',
        stage: 'review',
        summary: 'send for review',
      },
      {
        revision: 6,
        operation: 'revise',
        eventDatetime: 6_000,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: null,
        stage: 'review',
        summary: 'clear the review status',
      },
      {
        revision: 7,
        operation: 'withdraw',
        eventDatetime: 7_000,
        appliesUntil: null,
        createdAt: expect.any(Number),
        status: 'cancelled',
        stage: 'review',
        summary: 'withdraw the rollout',
      },
    ]);
  });

  it('returns every chain summary when the caller can read the current commitment head', async () => {
    const commitmentId = await createCommitment('cmd-chain-access-create', {
      title: 'Readable work',
    });
    await appendJudgment(
      {
        commandId: 'cmd-chain-access-hidden',
        topic: 'topic-chain-access',
        summary: 'hidden middle revision',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { title: 'Hidden revision' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-chain-access-head',
        topic: 'topic-chain-access',
        summary: 'readable head revision',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 2,
          set: { title: 'Readable revision' },
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const hiddenRecord = getAdapter()
      .prepare(
        'SELECT record_id FROM commitment_assignments WHERE commitment_id = ? AND revision = 2'
      )
      .get(commitmentId) as { record_id: string };
    const otherScopeId = ensureMemoryScope(getAdapter(), 'project', 'scope-other');
    getAdapter()
      .prepare('DELETE FROM memory_scope_bindings WHERE memory_id = ?')
      .run(hiddenRecord.record_id);
    getAdapter()
      .prepare('INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)')
      .run(hiddenRecord.record_id, otherScopeId);

    const chain = readWork(getAdapter(), { commitmentId, history: 'chain' }, access).items[0];

    expect(chain.chain?.map((revision) => revision.summary)).toEqual([
      'summary-cmd-chain-access-create',
      'hidden middle revision',
      'readable head revision',
    ]);
  });

  it('asOf answers with the values that were current then, not with today', async () => {
    const commitmentId = await createCommitment('cmd-asof', {
      title: 'Original',
      status: 'pending',
    });
    const createdAt = assignmentCreatedAt(commitmentId, 1);
    await appendJudgment(
      {
        commandId: 'cmd-asof-2',
        topic: 'topic-cmd-asof',
        summary: 'later change',
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
      { adapter: getAdapter(), embedder: null }
    );
    getAdapter()
      .prepare(
        'UPDATE commitment_assignments SET created_at = ? WHERE commitment_id = ? AND revision = 2'
      )
      .run(createdAt + 10_000, commitmentId);

    const now = readWork(getAdapter(), { commitmentId }, access).items[0];
    expect(now.values.status).toBe('done');
    expect(now.revision).toBe(2);

    const past = readWork(getAdapter(), { commitmentId, asOf: createdAt + 1 }, access);
    expect(past.items[0].values.status).toBe('pending');
    expect(past.items[0].revision).toBe(1);
    // A read bounded in time is the whole answer for that instant, not a truncated page.
    expect(past.coverage).toMatchObject({ complete: true, reasons: [] });
  });

  it('a revision bounded by appliesUntil stops applying then and stays in the history', async () => {
    const laterAt = 1_788_220_000_000;
    const earlierAt = laterAt - 6 * 86_400_000;
    const created = await appendJudgment(
      {
        commandId: 'cmd-bounded-create',
        topic: 'topic-bounded',
        summary: 'work recorded live',
        recordKind: 'commitment',
        work: { operation: 'create', set: { title: 'Live title', status: 'in_progress' } },
        eventDatetime: laterAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    const commitmentId = created.work!.commitmentId;
    // A backfill appends the earlier period after the live revisions were written.
    await reviseWork(
      {
        commandId: 'cmd-bounded-earlier',
        summary: 'earlier period, written later',
        commitmentId,
        expectedRevision: 1,
        set: { title: 'Earlier title', status: 'pending' },
        eventDatetime: earlierAt,
        appliesUntil: laterAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const current = readWork(getAdapter(), { commitmentId, history: 'all' }, access).items[0];
    expect(current.values).toMatchObject({ title: 'Live title', status: 'in_progress' });
    // The revision a writer must name next is still the last one written.
    expect(current.revision).toBe(2);
    expect(current.history!.map((revision) => revision.appliesUntil)).toEqual([null, laterAt]);

    const during = readWork(getAdapter(), { commitmentId, asOf: earlierAt + 1 }, access);
    expect(during.items[0].values).toMatchObject({ title: 'Earlier title', status: 'pending' });
    const after = readWork(getAdapter(), { commitmentId, asOf: laterAt + 1 }, access);
    expect(after.items[0].values).toMatchObject({ title: 'Live title', status: 'in_progress' });
  });

  it('refuses an appliesUntil that does not follow the revision event time', async () => {
    const at = 1_788_220_000_000;
    const commitmentId = await createCommitment('cmd-bound-check', { title: 'Bound check' });
    const revise = (appliesUntil: number, eventDatetime?: number) =>
      reviseWork(
        {
          commandId: `cmd-bound-check-${appliesUntil}-${eventDatetime ?? 'none'}`,
          summary: 'bounded',
          commitmentId,
          set: { status: 'pending' },
          ...(eventDatetime === undefined ? {} : { eventDatetime }),
          appliesUntil,
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter(), embedder: null }
      );
    await expect(revise(at, at)).rejects.toThrow(/appliesUntil/);
    await expect(revise(at)).rejects.toThrow(/appliesUntil/);
  });

  it('folds a backfilled commitment by source event time rather than the import clock', async () => {
    const firstEventAt = Date.now() - 30 * 86_400_000;
    const secondEventAt = Date.now() - 10 * 86_400_000;
    const created = await appendJudgment(
      {
        commandId: 'cmd-backfill-create',
        topic: 'topic-backfill',
        summary: 'historical card created',
        recordKind: 'commitment',
        work: { operation: 'create', set: { title: 'Historical work', status: 'pending' } },
        eventDatetime: firstEventAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    const commitmentId = created.work!.commitmentId;
    await appendJudgment(
      {
        commandId: 'cmd-backfill-revise',
        topic: 'topic-backfill',
        summary: 'historical card completed',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId,
          expectedRevision: 1,
          set: { status: 'done' },
        },
        eventDatetime: secondEventAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const before = readWork(getAdapter(), { commitmentId, asOf: firstEventAt - 1 }, access);
    const between = readWork(getAdapter(), { commitmentId, asOf: firstEventAt + 1 }, access);
    const after = readWork(getAdapter(), { commitmentId, asOf: secondEventAt + 1 }, access);
    expect(before.items).toEqual([]);
    expect(between.items[0]).toMatchObject({ revision: 1, values: { status: 'pending' } });
    expect(after.items[0]).toMatchObject({ revision: 2, values: { status: 'done' } });
  });

  it('exposes source event time in commitment history and assignment validity', async () => {
    const firstEventAt = 1_757_000_000_000;
    const secondEventAt = firstEventAt + 60_000;
    const importAt = 1_758_000_000_000;
    const created = await appendJudgment(
      {
        commandId: 'cmd-event-history-create',
        topic: 'topic-event-history',
        summary: 'historical create',
        recordKind: 'commitment',
        work: { operation: 'create', set: { title: 'Initial' } },
        eventDatetime: firstEventAt,
        recordedAt: importAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );
    await appendJudgment(
      {
        commandId: 'cmd-event-history-revise',
        topic: 'topic-event-history',
        summary: 'historical revise',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId: created.work!.commitmentId,
          expectedRevision: 1,
          set: { title: 'Updated' },
        },
        eventDatetime: secondEventAt,
        recordedAt: importAt,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter(), embedder: null }
    );

    const assignments = getAdapter()
      .prepare(
        'SELECT revision, applies_from, created_at FROM commitment_assignments WHERE commitment_id = ? ORDER BY revision'
      )
      .all(created.work!.commitmentId) as Array<{
      revision: number;
      applies_from: number | null;
      created_at: number;
    }>;
    expect(assignments).toEqual([
      { revision: 1, applies_from: firstEventAt, created_at: importAt },
      { revision: 2, applies_from: secondEventAt, created_at: importAt },
    ]);

    const history = readWork(
      getAdapter(),
      { commitmentId: created.work!.commitmentId, history: 'all' },
      access
    ).items[0].history!;
    expect(history.map((revision) => revision.eventDatetime)).toEqual([
      firstEventAt,
      secondEventAt,
    ]);
  });

  it('a commitment that did not exist at asOf is absent, not empty', async () => {
    const commitmentId = await createCommitment('cmd-future', { title: 'Later work' });

    const page = readWork(
      getAdapter(),
      { commitmentId, asOf: assignmentCreatedAt(commitmentId, 1) - 1 },
      access,
      { adapter: getAdapter() }
    );

    expect(page.items).toEqual([]);
  });

  it('pages by task id and reports what the page does not cover', async () => {
    for (let index = 0; index < 5; index += 1) {
      await createCommitment(`cmd-page-${index}`, { title: `Work ${index}` });
    }

    const first = readWork(getAdapter(), { limit: 2 }, access);
    expect(first.items).toHaveLength(2);
    expect(first.coverage).toMatchObject({ returned: 2, total: 5, complete: false });
    expect(first.coverage.reasons).toContain('more commitments follow this page');
    expect(first.nextCursor).not.toBeNull();

    const second = readWork(getAdapter(), { limit: 2, cursor: first.nextCursor! }, access);
    expect(second.items.map((item) => item.values.title)).toEqual(['Work 2', 'Work 3']);

    const last = readWork(getAdapter(), { limit: 10 }, access);
    expect(last.coverage).toMatchObject({ returned: 5, total: 5, complete: true });
    expect(last.coverage.reasons).toEqual([]);
    expect(last.nextCursor).toBeNull();
  });

  it('counts only commitments whose head record is visible to the caller', async () => {
    await createCommitment('cmd-mine', { title: 'Mine' });
    await createCommitment('cmd-theirs', { title: 'Theirs' }, otherAccess.scopes, otherAccess);

    const page = readWork(getAdapter(), {}, access);

    expect(page.items.map((item) => item.values.title)).toEqual(['Mine']);
    expect(page.coverage.complete).toBe(true);
    expect(page.coverage.reasons).toEqual([]);
    expect(page.coverage.total).toBe(1);
  });

  it('rejects a malformed page request instead of guessing', () => {
    const adapter = getAdapter();
    expect(() => readWork(adapter, { limit: 0 }, access)).toThrow(/limit/);
    expect(() => readWork(adapter, { limit: 1000 }, access)).toThrow(/limit/);
    expect(() => readWork(adapter, { cursor: 'not-a-cursor' }, access)).toThrow(/cursor/);
    expect(() => readWork(adapter, { asOf: -1 }, access)).toThrow(/asOf/);
    expect(() => readWork(adapter, { commitmentId: 'a', rowId: 1 }, access)).toThrow(/not both/);
  });
});
