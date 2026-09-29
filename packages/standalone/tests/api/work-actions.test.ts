import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCatalog,
  createDispatcher,
  createKnowledge,
  type ActionContext,
} from '@jungjaehoon/mama-core';
import {
  minimalWorkActionRegistrations,
  runWorkListView,
  workListActionRegistrations,
} from '../../src/api/work-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const access: ActionContext['access'] = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['work.create', 'work.revise'],
  scopes: [{ kind: 'project', id: 'workspace-test' }],
};

describe('minimal work actions', () => {
  it('judges a date deadline against the configured local midnight', async () => {
    const knowledge = {
      readWork: vi.fn().mockReturnValue({
        items: [
          {
            rowId: 1,
            commitmentId: 'dated-work',
            revision: 1,
            latestJudgmentRef: null,
            values: { title: 'Dated work', status: 'in_progress', deadline: '2026-09-27' },
            withdrawn: false,
            createdAt: '2026-09-26T00:00:00Z',
            updatedAt: '2026-09-26T00:00:00Z',
          },
        ],
        nextCursor: null,
        coverage: { reasons: [] },
      }),
    };
    const view = await runWorkListView(
      { view: 'items' },
      {
        knowledge: knowledge as never,
        access,
        now: () => Date.parse('2026-09-27T06:30:00Z'),
        timeZone: 'America/Los_Angeles',
      }
    );
    expect(view).toMatchObject({ view: 'items', tasks: [{ temporal_state: 'date_upcoming' }] });
  });

  it('returns a capped, grouped open pipeline without a cursor and accepts a matching readVersion echo', async () => {
    const items = [
      {
        rowId: 1,
        commitmentId: 'item-open',
        revision: 2,
        latestJudgmentRef: null,
        values: {
          title: 'Open item',
          status: 'blocked',
          stage: 'Review',
          assignee: 'Owner',
          deadline: '2026-09-28',
          nextAction: 'Review the draft',
          waitingOn: 'Owner decision',
        },
        withdrawn: false,
        createdAt: '2026-09-26T00:00:00Z',
        updatedAt: '2026-09-27T01:00:00Z',
      },
      {
        rowId: 2,
        commitmentId: 'item-closed',
        revision: 1,
        latestJudgmentRef: null,
        values: { title: 'Closed item', status: 'done', stage: 'Review' },
        withdrawn: false,
        createdAt: '2026-09-26T00:00:00Z',
        updatedAt: '2026-09-27T01:00:00Z',
      },
    ];
    const knowledge = {
      readWork: vi.fn().mockReturnValue({ items, nextCursor: null, coverage: { reasons: [] } }),
    };
    const view = await runWorkListView(
      { view: 'pipeline' },
      {
        knowledge: knowledge as never,
        access,
        now: () => Date.parse('2026-09-27T00:00:00Z'),
        timeZone: 'UTC',
      }
    );
    expect(view).toMatchObject({
      view: 'pipeline',
      total: 1,
      fields: [
        'commitmentId',
        'title',
        'status',
        'assignee',
        'deadline',
        'latest_change',
        'latest_event',
      ],
      stages: [
        {
          stage: 'Review',
          count: 1,
          rows: [
            [
              'item-open',
              'Open item',
              'blocked',
              'Owner',
              '2026-09-28',
              Math.trunc(Date.parse('2026-09-27T01:00:00Z') / 1_000),
              null,
            ],
          ],
        },
      ],
    });
    const first = await runWorkListView(
      { view: 'items', limit: 1 },
      {
        knowledge: knowledge as never,
        access,
        now: () => Date.parse('2026-09-27T00:00:00Z'),
        timeZone: 'UTC',
      }
    );
    if (first.view !== 'items') throw new Error('expected items view');
    await expect(
      runWorkListView(
        { view: 'items', readVersion: first.readVersion },
        {
          knowledge: knowledge as never,
          access,
          now: () => Date.parse('2026-09-27T00:00:00Z'),
          timeZone: 'UTC',
        }
      )
    ).resolves.toMatchObject({ view: 'items' });
    await expect(
      runWorkListView(
        { view: 'items', cursor: '' },
        { knowledge: knowledge as never, access, timeZone: 'UTC' }
      )
    ).rejects.toThrow('omit cursor');
  });

  it('returns the whole open ledger as compact pipeline rows under 10k characters', async () => {
    const items = Array.from({ length: 70 }, (_, index) => ({
      rowId: index + 1,
      commitmentId: `item-${index + 1}`,
      revision: 1,
      latestJudgmentRef: null,
      values: {
        title: `Open item ${index + 1}`,
        status: 'in_progress',
        stage: 'Doing',
        assignee: 'Owner',
        deadline: '2026-09-30',
        latestEvent: 'A short update',
        sourceRefs: Array.from({ length: 10 }, (_, ref) => `obs-${index}-${ref}`),
      },
      withdrawn: false,
      createdAt: '2026-09-26T00:00:00Z',
      updatedAt: '2026-09-27T01:00:00Z',
    }));
    const knowledge = {
      readWork: vi.fn().mockReturnValue({ items, nextCursor: null, coverage: { reasons: [] } }),
    };
    const view = await runWorkListView(
      { view: 'pipeline', limit: 1 },
      { knowledge: knowledge as never, access, timeZone: 'UTC' }
    );
    expect(view.total).toBe(70);
    expect(JSON.stringify(view).length).toBeLessThan(10_000);
    expect(JSON.stringify(view)).not.toContain('sourceRefs');
    expect(view.fields).toEqual([
      'commitmentId',
      'title',
      'status',
      'assignee',
      'deadline',
      'latest_change',
      'latest_event',
    ]);
    expect(view.stages[0]?.rows[0]).toEqual([
      'item-1',
      'Open item 1',
      'in_progress',
      'Owner',
      '2026-09-30',
      Math.trunc(Date.parse('2026-09-27T01:00:00Z') / 1_000),
      'A short update',
    ]);
  });

  it('keeps the whole baseline when more than one hundred items are open', async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      rowId: index + 1,
      commitmentId: `item-${index + 1}`,
      revision: 1,
      latestJudgmentRef: null,
      values: { title: `Open item ${index + 1}`, status: 'in_progress', stage: 'Doing' },
      withdrawn: false,
      createdAt: '2026-09-26T00:00:00Z',
      updatedAt: '2026-09-27T01:00:00Z',
    }));
    const view = await runWorkListView(
      { view: 'pipeline' },
      {
        knowledge: {
          readWork: () => ({ items, nextCursor: null, coverage: { reasons: [] } }),
        } as never,
        access,
        timeZone: 'UTC',
      }
    );
    expect(view.total).toBe(101);
  });

  it('advertises and validates the same fifty item limit enforced by the runtime', async () => {
    const registration = workListActionRegistrations({
      knowledge: { readWork: () => ({}) } as never,
      timeZone: createTimeZoneSetting('UTC'),
    })[0]!;
    expect(registration.contract.inputSchema.properties?.limit).toMatchObject({ maximum: 50 });
    const dispatch = createDispatcher(
      createCatalog(
        workListActionRegistrations({
          knowledge: { readWork: vi.fn() } as never,
          timeZone: createTimeZoneSetting('UTC'),
        })
      )
    );
    const result = await dispatch(
      { action: 'work.list', input: { view: 'items', limit: 51 } },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
  });

  it('refuses sourceRefs that name no observation and names the ref', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: (id) => id === 'obs_known',
          knowledge: knowledge as never,
        })
      )
    );
    const refused = await dispatch(
      {
        action: 'work.create',
        operationId: 'operation-bad-ref',
        input: {
          topic: 'work-topic',
          summary: 'work-summary',
          sourceRefs: ['obs_known', 'obs_truncate'],
          set: { title: 'work-title' },
        },
      },
      { access }
    );
    expect(refused).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('unavailable observation: obs_truncate') },
    });
    expect(knowledge.createWork).not.toHaveBeenCalled();
  });

  it('accepts assignee and roles in create and revise patches', async () => {
    const knowledge = {
      createWork: vi.fn().mockResolvedValue({ commitmentId: 'commitment-test', revision: 1 }),
      reviseWork: vi.fn().mockResolvedValue({ commitmentId: 'commitment-test', revision: 2 }),
    };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );

    const created = await dispatch(
      {
        action: 'work.create',
        operationId: 'operation-create',
        input: {
          topic: 'work-topic',
          summary: 'work-summary',
          set: {
            title: 'work-title',
            assignee: 'assignee-test',
            roles: [{ role: 'reviewer-test', person: 'person-test' }],
          },
        },
      },
      { access }
    );
    expect(created.status).toBe('completed');
    expect(knowledge.createWork).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'operation-create',
        set: expect.objectContaining({ assignee: 'assignee-test', roles: expect.any(Array) }),
      }),
      access
    );

    const revised = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-revise',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          summary: 'clear the assignee after review',
          set: { assignee: null, roles: [] },
        },
      },
      { access }
    );
    expect(revised.status).toBe('completed');
    expect(knowledge.reviseWork).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'operation-revise',
        expectedRevision: 1,
        set: { assignee: null, roles: [] },
      }),
      access
    );
  });

  it('clears an existing field from the read view', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-work-actions-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      const knowledge = createKnowledge({ adapter: handle.adapter });
      const dispatch = createDispatcher(
        createCatalog(minimalWorkActionRegistrations({ observationExists: () => true, knowledge }))
      );

      const created = await dispatch(
        {
          action: 'work.create',
          operationId: 'operation-create-clear',
          input: {
            topic: 'work-topic',
            summary: 'track the assigned work',
            scopes: access.scopes,
            set: { title: 'assigned work', assignee: 'assignee-test' },
          },
        },
        { access }
      );
      expect(created.status).toBe('completed');
      const commitmentId = (created as { data: { commitmentId: string } }).data.commitmentId;

      const revised = await dispatch(
        {
          action: 'work.revise',
          operationId: 'operation-revise-clear',
          input: {
            commitmentId,
            expectedRevision: 1,
            summary: 'remove the assignee because the assignment ended',
            scopes: access.scopes,
            clear: ['assignee'],
          },
        },
        { access }
      );
      expect(revised.status).toBe('completed');

      const view = knowledge.readWork({ commitmentId }, access).items[0];
      expect(view.values).not.toHaveProperty('assignee');
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends a revision when expectedRevision is omitted and rejects a stale supplied revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-work-revise-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      const knowledge = createKnowledge({ adapter: handle.adapter });
      const dispatch = createDispatcher(
        createCatalog(minimalWorkActionRegistrations({ observationExists: () => true, knowledge }))
      );
      const created = await dispatch(
        {
          action: 'work.create',
          operationId: 'create-revisions',
          input: {
            topic: 'work-topic',
            summary: 'create item',
            scopes: access.scopes,
            set: { title: 'Revision item' },
          },
        },
        { access }
      );
      const commitmentId = (created as { data: { commitmentId: string } }).data.commitmentId;
      const append = (operationId: string, expectedRevision?: number) =>
        dispatch(
          {
            action: 'work.revise',
            operationId,
            input: {
              commitmentId,
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
              summary: 'record another change',
              scopes: access.scopes,
              set: { latestEvent: operationId },
            },
          },
          { access }
        );
      const first = await append('append-without-revision');
      expect(first).toMatchObject({ status: 'completed', data: { revision: 2 } });
      const stale = await append('stale-revision', 1);
      expect(stale).toMatchObject({ status: 'failed' });
      const second = await append('append-latest');
      expect(second).toMatchObject({ status: 'completed', data: { revision: 3 } });
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves omitted revisions inside the write transaction when two writes overlap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-work-revise-race-'));
    const handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    try {
      let blocking = false;
      let enteredCount = 0;
      let release!: () => void;
      let bothEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        bothEntered = resolve;
      });
      const knowledge = createKnowledge({
        adapter: handle.adapter,
        embedder: {
          async embed() {
            if (blocking) {
              enteredCount += 1;
              if (enteredCount === 2) bothEntered();
              await gate;
            }
            return null;
          },
        },
      });
      const dispatch = createDispatcher(
        createCatalog(minimalWorkActionRegistrations({ observationExists: () => true, knowledge }))
      );
      const created = await dispatch(
        {
          action: 'work.create',
          operationId: 'create-race-item',
          input: {
            topic: 'race topic',
            summary: 'create one item',
            scopes: access.scopes,
            set: { title: 'Race item' },
          },
        },
        { access }
      );
      const commitmentId = (created as { data: { commitmentId: string } }).data.commitmentId;
      blocking = true;
      const revise = (operationId: string) =>
        dispatch(
          {
            action: 'work.revise',
            operationId,
            input: {
              commitmentId,
              summary: 'record concurrent change',
              scopes: access.scopes,
              set: { latestEvent: operationId },
            },
          },
          { access }
        );
      const writes = [revise('race-left'), revise('race-right')];
      await entered;
      release();
      const results = await Promise.all(writes);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
      expect(
        results.map((result) => (result as { data: { revision: number } }).data.revision).sort()
      ).toEqual([2, 3]);
    } finally {
      await handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires revision history text from the caller', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );

    const result = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-revise-without-history',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          set: { assignee: 'assignee-test' },
        },
      },
      { access }
    );

    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
    expect(knowledge.reviseWork).not.toHaveBeenCalled();
  });

  it('requires an operation id for durable work commands', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );
    const result = await dispatch(
      { action: 'work.create', input: { topic: 'topic', summary: 'summary', set: {} } },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_COMMAND' } });
    expect(knowledge.createWork).not.toHaveBeenCalled();
  });

  it('rejects a replay work create without source event time before writing', async () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );

    const result = await dispatch(
      {
        action: 'work.create',
        operationId: 'operation-replay-missing-time',
        input: { topic: 'topic', summary: 'summary', set: { title: 'work' } },
      },
      { access, session: { replaySourceEndMs: 1_000 } }
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'REPLAY_EVENT_TIME_REQUIRED' },
    });
    expect(knowledge.createWork).not.toHaveBeenCalled();
  });

  it('rejects a replay work revise beyond the source ceiling before writing', async () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );

    const result = await dispatch(
      {
        action: 'work.revise',
        operationId: 'operation-replay-future-time',
        input: {
          commitmentId: 'commitment-test',
          expectedRevision: 1,
          summary: 'summary',
          eventDatetime: 1_001,
          set: { title: 'work' },
        },
      },
      { access, session: { replaySourceEndMs: 1_000 } }
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'REPLAY_EVENT_TIME_AFTER_CEILING' },
    });
    expect(knowledge.reviseWork).not.toHaveBeenCalled();
  });

  it('reads an offset ISO eventDatetime as epoch ms and names the allowed forms otherwise', async () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn().mockReturnValue({}) };
    const dispatch = createDispatcher(
      createCatalog(
        minimalWorkActionRegistrations({
          observationExists: () => true,
          knowledge: knowledge as never,
        })
      )
    );
    const revise = (eventDatetime: unknown, operationId: string) =>
      dispatch(
        {
          action: 'work.revise',
          operationId,
          input: {
            commitmentId: 'commitment-test',
            summary: 'summary',
            eventDatetime,
            set: { title: 'work' },
          },
        },
        { access }
      );

    expect(await revise('2026-01-01T09:30:00+09:00', 'operation-offset-time')).toMatchObject({
      status: 'completed',
    });
    expect(knowledge.reviseWork.mock.calls[0]![0]).toMatchObject({
      eventDatetime: Date.parse('2026-01-01T00:30:00Z'),
    });

    const local = await revise('2026-01-01 09:30', 'operation-local-time');
    expect(local).toMatchObject({ status: 'failed', error: { code: 'invalid_input' } });
    expect((local as { error: { message: string } }).error.message).toContain(
      'must match exactly one of: number, string, null (0 matched). Source event time as epoch milliseconds or an ISO time with its offset'
    );
    expect(knowledge.reviseWork).toHaveBeenCalledTimes(1);
  });

  it('describes the owner work contract fields and stable citation handles', () => {
    const knowledge = { createWork: vi.fn(), reviseWork: vi.fn() };
    const contracts = minimalWorkActionRegistrations({
      observationExists: () => true,
      knowledge: knowledge as never,
    }).map(({ contract }) => contract);
    const create = contracts.find((contract) => contract.name === 'work.create')!;
    const revise = contracts.find((contract) => contract.name === 'work.revise')!;
    const set = create.inputSchema.properties?.set;
    const roles = set?.properties?.roles;
    const role = roles?.oneOf?.find((variant) => variant.type === 'array')?.items;
    const files = set?.properties?.files;
    const file = files?.oneOf?.find((variant) => variant.type === 'array')?.items;

    expect(set?.properties?.stage?.description).toContain('stage');
    expect(set?.properties?.project?.description).toContain('project');
    expect(set?.properties?.lastEventTime?.description).toContain('source event time');
    expect(set?.properties?.files?.description).toContain('locator');
    expect(file?.properties?.hash?.description).toContain('hash');
    expect(role?.properties?.confirmed?.description).toContain('unconfirmed');
    expect(revise.inputSchema.properties?.commitmentId?.description).toContain('stable');
    expect(revise.inputSchema.properties).not.toHaveProperty('topic');
    expect(revise.inputSchema.required).not.toContain('topic');
    expect(create.inputSchema.properties?.sourceRefs?.description).toContain('observationRef');
  });
});
