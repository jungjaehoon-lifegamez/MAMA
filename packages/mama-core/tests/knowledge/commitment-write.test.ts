/**
 * The owner-work command surface, proved by reading back what it wrote.
 *
 * Every assertion goes write -> read through the two public functions. A test
 * that inspected `commitment_assignments` directly would pass on a writer whose
 * output no reader can fold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { createWork, readWork, reviseWork, withdrawWork } from '../../src/knowledge/commitments.js';
import type { ReviseWorkCommand } from '../../src/knowledge/commitments.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const access = {
  principalId: 'principal-work',
  agentId: 'agent-work',
  scopes: [{ kind: 'project' as const, id: 'scope-work' }],
};

const reviseTopicIsHostSupplied: ReviseWorkCommand = {
  commandId: 'type-check-revision',
  commitmentId: 'commitment-type-check',
  summary: 'record a change',
  // @ts-expect-error Revisions inherit the create record topic.
  topic: 'agent-supplied-topic',
};
void reviseTopicIsHostSupplied;

describe('knowledge/commitments: committing owner work', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('commitment-write');
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

  it('a created commitment is readable as the values it was given', async () => {
    const written = await createWork(
      {
        commandId: 'work-create',
        topic: 'connector-rollout',
        summary: 'Finish the connector rollout this week',
        set: {
          title: 'Finish the connector rollout',
          status: 'pending',
          priority: 'high',
          completionCriteria: 'every configured connector polls without error for 24h',
        },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    expect(written.revision).toBe(1);
    const view = readWork(getAdapter(), { commitmentId: written.commitmentId }, access).items[0];
    expect(view.values).toMatchObject({
      title: 'Finish the connector rollout',
      status: 'pending',
      priority: 'high',
    });
    // The record that states the work, not a separate row that could drift from it.
    expect(view.latestJudgmentRef).toEqual(written.recordRef);
  });

  it('writes eventDatetime to both the decision and assignment event columns', async () => {
    const eventDatetime = 1_757_000_000_000;
    const written = await createWork(
      {
        commandId: 'work-event-time',
        topic: 'event-time',
        summary: 'source-timed work',
        eventDatetime,
        recordedAt: 1_758_000_000_000,
        set: { title: 'Source-timed work' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    expect(
      getAdapter()
        .prepare('SELECT event_datetime FROM decisions WHERE id = ?')
        .get(written.recordRef.id)
    ).toEqual({ event_datetime: eventDatetime });
    expect(
      getAdapter()
        .prepare(
          'SELECT applies_from, created_at FROM commitment_assignments WHERE commitment_id = ? AND revision = 1'
        )
        .get(written.commitmentId)
    ).toEqual({ applies_from: eventDatetime, created_at: 1_758_000_000_000 });
  });

  it('the work and its record commit together or not at all', async () => {
    const adapter = getAdapter();
    await createWork(
      {
        commandId: 'work-atomic',
        topic: 'atomic',
        summary: 'one transaction',
        set: { title: 'Atomic' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    const records = adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    const commitments = adapter.prepare('SELECT COUNT(*) AS n FROM commitments').get() as {
      n: number;
    };
    expect(records.n).toBe(1);
    expect(commitments.n).toBe(1);
  });

  it('revising at a stale revision fails rather than overwriting an unseen change', async () => {
    const created = await createWork(
      {
        commandId: 'work-cas',
        topic: 'cas',
        summary: 'compare and set',
        set: { title: 'First' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    await reviseWork(
      {
        commandId: 'work-cas-2',
        summary: 'someone else got here first',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        set: { title: 'Second' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    await expect(
      reviseWork(
        {
          commandId: 'work-cas-3',
          summary: 'writing from a stale read',
          commitmentId: created.commitmentId,
          expectedRevision: 1,
          set: { title: 'Third' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/stale/i);

    // The losing write left nothing behind.
    const view = readWork(getAdapter(), { commitmentId: created.commitmentId }, access).items[0];
    expect(view.revision).toBe(2);
    expect(view.values.title).toBe('Second');
  });

  it('a revision that states nothing is refused', async () => {
    const created = await createWork(
      {
        commandId: 'work-empty',
        topic: 'empty',
        summary: 'nothing to revise',
        set: { title: 'Unchanged' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    await expect(
      reviseWork(
        {
          commandId: 'work-empty-2',
          summary: 'no fields',
          commitmentId: created.commitmentId,
          expectedRevision: 1,
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/set, clear, or link/i);
  });

  it('a revision may carry relations, and a links-only revision is still a revision', async () => {
    const adapter = getAdapter();
    const first = await createWork(
      {
        commandId: 'work-link-base',
        topic: 'link-base',
        summary: 'the earlier piece of work',
        set: { title: 'Earlier work' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    const second = await createWork(
      {
        commandId: 'work-link-second',
        topic: 'link-second',
        summary: 'this one continues it',
        set: { title: 'Later work' },
        links: [{ relation: 'builds_on', target: first.recordRef }],
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    // The edge's subject is the revision's own record, committed atomically.
    const edges = adapter
      .prepare('SELECT subject_kind, subject_id, object_kind, object_id, edge_type FROM twin_edges')
      .all() as Array<{
      subject_kind: string;
      subject_id: string;
      object_kind: string;
      object_id: string;
      edge_type: string;
    }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      subject_kind: 'memory',
      subject_id: second.recordRef.id,
      object_kind: first.recordRef.kind,
      object_id: first.recordRef.id,
      edge_type: 'builds_on',
    });

    // A revision that only states a relation still moves the head record.
    const revised = await reviseWork(
      {
        commandId: 'work-link-revise',
        summary: 'marking it as the thing the report must not block',
        commitmentId: second.commitmentId,
        expectedRevision: 1,
        links: [{ relation: 'mentions', target: first.recordRef }],
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    expect(revised.revision).toBe(2);

    const view = readWork(adapter, { commitmentId: second.commitmentId }, access).items[0];
    expect(view.latestJudgmentRef).toEqual(revised.recordRef);
    // Only the links the agent stated: the host adds no edge to the previous revision.
    const allEdges = adapter.prepare('SELECT COUNT(*) AS n FROM twin_edges').get() as {
      n: number;
    };
    expect(allEdges.n).toBe(2);
  });

  it('revisions inherit the create topic, and the host links none of them', async () => {
    const knowledge = createKnowledge({ adapter: getAdapter() });
    const created = await knowledge.createWork(
      {
        commandId: 'work-chain-create',
        topic: 'stable-work-topic',
        summary: 'created work',
        set: { title: 'Work history' },
        scopes: access.scopes,
      },
      access
    );
    const revised = await knowledge.reviseWork(
      {
        commandId: 'work-chain-revise',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        summary: 'first feedback',
        set: { feedback: 'first' },
        scopes: access.scopes,
      },
      access
    );
    const revisedAgain = await knowledge.reviseWork(
      {
        commandId: 'work-chain-revise-again',
        commitmentId: created.commitmentId,
        expectedRevision: 2,
        summary: 'second feedback',
        set: { feedback: 'second' },
        scopes: access.scopes,
      },
      access
    );

    const page = knowledge.queryGraph(
      {
        view: 'timeline',
        seeds: [created.recordRef, revised.recordRef, revisedAgain.recordRef],
        history: 'all',
      },
      access
    );
    expect(page.edges).toEqual([]);
    // The order of revisions is read from the commitment, not from edges.
    const history = knowledge.readWork(
      { commitmentId: created.commitmentId, history: 'all' },
      access
    ).items[0].history;
    expect(history?.map((revision) => revision.recordRef)).toEqual([
      created.recordRef,
      revised.recordRef,
      revisedAgain.recordRef,
    ]);
    const topicRows = getAdapter()
      .prepare('SELECT id, topic FROM decisions WHERE id IN (?, ?, ?) ORDER BY id')
      .all(created.recordRef.id, revised.recordRef.id, revisedAgain.recordRef.id) as Array<{
      id: string;
      topic: string;
    }>;
    expect(topicRows).toHaveLength(3);
    expect(topicRows.map((row) => row.topic)).toEqual([
      'stable-work-topic',
      'stable-work-topic',
      'stable-work-topic',
    ]);
  });

  it('a revision keeps a topic the caller supplies', async () => {
    const knowledge = createKnowledge({ adapter: getAdapter() });
    const created = await knowledge.createWork(
      {
        commandId: 'work-topic-create',
        topic: 'item-topic',
        summary: 'created work',
        set: { title: 'Topic choice' },
        scopes: access.scopes,
      },
      access
    );
    const revised = await knowledge.reviseWork(
      {
        commandId: 'work-topic-revise',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        topic: 'caller-topic',
        summary: 'revised with its own topic',
        set: { feedback: 'first' },
        scopes: access.scopes,
      },
      access
    );
    const row = getAdapter()
      .prepare('SELECT topic FROM decisions WHERE id = ?')
      .get(revised.recordRef.id) as { topic: string };
    expect(row.topic).toBe('caller-topic');
  });

  it('a link to a record the caller cannot see is refused', async () => {
    const created = await createWork(
      {
        commandId: 'work-link-missing',
        topic: 'link-missing',
        summary: 'pointing at nothing',
        set: { title: 'Pointing nowhere' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    await expect(
      reviseWork(
        {
          commandId: 'work-link-missing-2',
          summary: 'the target does not exist',
          commitmentId: created.commitmentId,
          expectedRevision: 1,
          links: [{ relation: 'builds_on', target: { kind: 'memory', id: 'no-such-record' } }],
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/reference/i);
  });

  it('refuses a withdraw that omits its revision at runtime', async () => {
    const created = await createWork(
      {
        commandId: 'work-withdraw-norev',
        topic: 'withdraw',
        summary: 'to be dropped',
        set: { title: 'Work to drop', status: 'pending' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    await expect(
      withdrawWork(
        {
          commandId: 'work-withdraw-norev-2',
          summary: 'dropped without a revision',
          commitmentId: created.commitmentId,
          scopes: access.scopes,
        } as unknown as Parameters<typeof withdrawWork>[0],
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow();
  });

  it('a withdrawn commitment keeps its values and refuses further revision', async () => {
    const created = await createWork(
      {
        commandId: 'work-withdraw',
        topic: 'withdraw',
        summary: 'no longer needed',
        set: { title: 'Dropped work', status: 'pending' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    const withdrawn = await withdrawWork(
      {
        commandId: 'work-withdraw-2',
        summary: 'the owner dropped it',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    expect(
      getAdapter()
        .prepare(
          `SELECT edge_type, object_id FROM twin_edges
           WHERE subject_kind = 'memory' AND subject_id = ?`
        )
        .all(withdrawn.recordRef.id)
    ).toEqual([]);
    expect(
      getAdapter().prepare('SELECT topic FROM decisions WHERE id = ?').get(withdrawn.recordRef.id)
    ).toEqual({ topic: 'withdraw' });

    const view = readWork(getAdapter(), { commitmentId: created.commitmentId }, access).items[0];
    expect(view.withdrawn).toBe(true);
    expect(view.values).toMatchObject({ title: 'Dropped work', status: 'pending' });

    await expect(
      reviseWork(
        {
          commandId: 'work-withdraw-3',
          summary: 'reviving it',
          commitmentId: created.commitmentId,
          expectedRevision: 2,
          set: { status: 'in_progress' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/withdrawn/i);
  });

  it('a resent command returns its original receipt instead of writing twice', async () => {
    const command = {
      commandId: 'work-replay',
      topic: 'replay',
      summary: 'sent twice',
      set: { title: 'Once' },
      scopes: access.scopes,
    };
    const first = await createWork(command, access, { adapter: getAdapter() });
    const second = await createWork(command, access, { adapter: getAdapter() });

    expect(second.commitmentId).toBe(first.commitmentId);
    expect(second.revision).toBe(1);
    expect(
      (getAdapter().prepare('SELECT COUNT(*) AS n FROM commitments').get() as { n: number }).n
    ).toBe(1);
  });

  it('history keeps each revision, so a correction does not erase what it corrected', async () => {
    const created = await createWork(
      {
        commandId: 'work-history',
        topic: 'history',
        summary: 'initial reading',
        set: { title: 'Ship on Tuesday', status: 'pending' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    await reviseWork(
      {
        commandId: 'work-history-2',
        summary: 'the owner corrected the date',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        set: { title: 'Ship on Thursday' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    const view = readWork(
      getAdapter(),
      { commitmentId: created.commitmentId, history: 'all' },
      access,
      { adapter: getAdapter() }
    ).items[0];

    expect(view.values.title).toBe('Ship on Thursday');
    expect(view.history?.map((revision) => revision.set.title)).toEqual([
      'Ship on Tuesday',
      'Ship on Thursday',
    ]);
    expect(view.basis).toHaveLength(2);
  });

  it('rejects a dueAt that is a bare date rather than an offset-bearing instant', async () => {
    // The live failure this guards: a stored '2026-09-19' folds fine but the
    // board's strict parse makes the whole row unreadable.
    await expect(
      createWork(
        {
          commandId: 'work-bad-dueat',
          topic: 'bad dueAt',
          summary: 'date-only in the instant slot',
          set: { title: 'x', dueAt: '2026-09-19' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/RFC 3339/);

    await expect(
      createWork(
        {
          commandId: 'work-bad-dueat-2',
          topic: 'bad dueAt',
          summary: 'no offset',
          set: { title: 'x', dueAt: '2026-09-19T00:00:00' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/RFC 3339/);
  });

  it('accepts an offset-bearing dueAt and reads the values back', async () => {
    const written = await createWork(
      {
        commandId: 'work-good-dueat',
        topic: 'dated work',
        summary: 'exact instant',
        set: { title: 'x', dueAt: '2026-09-19T00:00:00+09:00' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    const view = readWork(getAdapter(), { commitmentId: written.commitmentId }, access).items[0];
    expect(view.values.dueAt).toBe('2026-09-19T00:00:00+09:00');
  });

  it('rejects a deadline that is not a real calendar date', async () => {
    await expect(
      createWork(
        {
          commandId: 'work-bad-deadline',
          topic: 'bad deadline',
          summary: 'feb 30 does not exist',
          set: { title: 'x', deadline: '2026-02-30' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/ISO date/);

    await expect(
      createWork(
        {
          commandId: 'work-bad-deadline-2',
          topic: 'bad deadline',
          summary: 'not a date at all',
          set: { title: 'x', deadline: 'next friday' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/ISO date/);
  });

  it('rejects a malformed dueAt on revise, before the revision is read', async () => {
    const created = await createWork(
      {
        commandId: 'work-revise-dueat',
        topic: 'revise dueAt',
        summary: 'initial',
        set: { title: 'x' },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    await expect(
      reviseWork(
        {
          commandId: 'work-revise-dueat-2',
          summary: 'date-only in the instant slot',
          commitmentId: created.commitmentId,
          expectedRevision: 1,
          set: { dueAt: '2026-09-19' },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/RFC 3339/);

    const view = readWork(getAdapter(), { commitmentId: created.commitmentId }, access).items[0];
    expect(view.revision).toBe(1);
    expect(view.values.dueAt).toBeUndefined();
  });

  it('treats an explicit null date field as an absent statement, not a malformed one', async () => {
    const written = await createWork(
      {
        commandId: 'work-null-dates',
        topic: 'undated work',
        summary: 'no deadline stated',
        set: { title: 'x', dueAt: null, deadline: null },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );

    const view = readWork(getAdapter(), { commitmentId: written.commitmentId }, access).items[0];
    expect(view.values.title).toBe('x');
  });

  it('rejects an offset outside the deadline domain and stores a real one', async () => {
    await expect(
      createWork(
        {
          commandId: 'work-bad-offset',
          topic: 'bad offset',
          summary: 'not an integer',
          set: { title: 'x', deadlineOffsetMinutes: 9.5 },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/deadlineOffsetMinutes/);

    await expect(
      createWork(
        {
          commandId: 'work-bad-offset-2',
          topic: 'bad offset',
          summary: 'out of range',
          set: { title: 'x', deadlineOffsetMinutes: 999 },
          scopes: access.scopes,
        },
        access,
        { adapter: getAdapter() }
      )
    ).rejects.toThrow(/deadlineOffsetMinutes/);

    const written = await createWork(
      {
        commandId: 'work-good-offset',
        topic: 'offset work',
        summary: 'kst',
        set: { title: 'x', deadline: '2026-09-19', deadlineOffsetMinutes: 540 },
        scopes: access.scopes,
      },
      access,
      { adapter: getAdapter() }
    );
    const view = readWork(getAdapter(), { commitmentId: written.commitmentId }, access).items[0];
    expect(view.values.deadlineOffsetMinutes).toBe(540);
  });
});
