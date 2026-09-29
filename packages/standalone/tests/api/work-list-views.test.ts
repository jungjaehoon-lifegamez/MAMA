import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type {
  CommitmentPage,
  CommitmentRevision,
  CommitmentView,
  JudgmentAccess,
  WorkRead,
} from '@jungjaehoon/mama-core/knowledge';
import {
  runWorkListView,
  workListActionRegistrations,
  type WorkListViewContext,
} from '../../src/api/work-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const access: JudgmentAccess = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [],
  actions: ['work.list'],
};

function revision(
  commitmentId: string,
  revisionNumber: number,
  values: Record<string, unknown>
): CommitmentRevision {
  return {
    revision: revisionNumber,
    operation: revisionNumber === 1 ? 'create' : 'revise',
    recordRef: { kind: 'memory', id: `memory-${commitmentId}-${revisionNumber}` },
    set: values,
    clear: [],
    eventDatetime: 1_700_000_000_000 + revisionNumber,
    createdAt: 1_700_000_000_000 + revisionNumber,
  };
}

function view(index: number, overrides: Partial<CommitmentView> = {}): CommitmentView {
  const commitmentId = `commitment-${index}`;
  const values = {
    title: `item-${index}`,
    description: `description-${index}`,
    status: index % 2 === 0 ? 'pending' : 'done',
    stage: `stage-${index % 2}`,
    project: `scope-${index % 2}`,
    priority: 'normal',
  };
  return {
    commitmentId,
    rowId: index,
    revision: 1,
    latestJudgmentRef: { kind: 'memory', id: `memory-${index}-1` },
    values,
    withdrawn: false,
    basis: [{ kind: 'memory', id: `memory-${index}-1` }],
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    ...overrides,
  };
}

function makeReader(initial: CommitmentView[]) {
  const state = { items: [...initial] };
  const readWork = vi.fn((query: WorkRead): CommitmentPage => {
    const wanted =
      query.commitmentId === undefined
        ? query.rowId === undefined
          ? undefined
          : state.items.find((item) => item.rowId === query.rowId)
        : state.items.find((item) => item.commitmentId === query.commitmentId);
    if (wanted !== undefined || query.commitmentId !== undefined || query.rowId !== undefined) {
      return {
        items: wanted === undefined ? [] : [query.history === 'all' ? withHistory(wanted) : wanted],
        nextCursor: null,
        coverage: { returned: wanted === undefined ? 0 : 1, total: 1, complete: true, reasons: [] },
      };
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const limit = query.limit ?? 100;
    const items = state.items.slice(offset, offset + limit);
    const nextCursor =
      offset + items.length < state.items.length ? String(offset + items.length) : null;
    return {
      items: query.history === 'all' ? items.map(withHistory) : items,
      nextCursor,
      coverage: {
        returned: items.length,
        total: state.items.length,
        complete: nextCursor === null,
        reasons: nextCursor === null ? [] : ['more commitments follow this page'],
      },
    };
  });
  return { state, readWork };
}

function withHistory(item: CommitmentView): CommitmentView {
  const values = item.values as Record<string, unknown>;
  return {
    ...item,
    history: item.history ?? [revision(item.commitmentId, 1, values)],
  };
}

function context(readWork: WorkListViewContext['knowledge']['readWork']): WorkListViewContext {
  return { knowledge: { readWork }, access, now: () => 1_700_000_100_000, timeZone: 'UTC' };
}

describe('progressive work.list views', () => {
  it('finds what happened in a span by event time, each item with its revisions there', async () => {
    const day = Date.parse('2026-09-10T00:00:00Z');
    const next = day + 86_400_000;
    const entry = (
      revisionNumber: number,
      eventDatetime: number | null,
      createdAt: number,
      summary: string
    ) => ({
      revision: revisionNumber,
      operation: 'revise' as const,
      eventDatetime,
      createdAt,
      status: 'in_progress',
      stage: 'Review',
      summary,
    });
    // Written a week later by a backfill, the first item still happened on the day.
    const reader = makeReader([
      view(1, {
        updatedAt: next + 7 * 86_400_000,
        chain: [
          entry(1, day - 1, next + 7 * 86_400_000, 'the day before'),
          entry(2, day + 3_600_000, next + 7 * 86_400_000, 'happened that day'),
        ],
      }),
      view(2, { chain: [entry(1, null, day + 7_200_000, 'no event time, written that day')] }),
      view(3, { chain: [entry(1, next, next, 'the next day')] }),
    ]);
    const result = (await runWorkListView(
      { view: 'items', eventSince: '2026-09-10T09:00:00+09:00', eventBefore: next },
      context(reader.readWork)
    )) as { tasks: Array<{ commitmentId: string; revisions: Array<{ summary: string }> }> };
    expect(reader.readWork.mock.calls[0]![0]).toMatchObject({ history: 'chain' });
    expect(
      result.tasks
        .map((task) => [task.commitmentId, task.revisions.map((revision) => revision.summary)])
        .sort()
    ).toEqual([
      ['commitment-1', ['happened that day']],
      ['commitment-2', ['no event time, written that day']],
    ]);
  });

  it('returns a bounded compact items page and keeps detail-only evidence out', async () => {
    const reader = makeReader(Array.from({ length: 30 }, (_, index) => view(index + 1)));

    const result = await runWorkListView({}, context(reader.readWork));

    expect(result).toMatchObject({ view: 'items', returned: 25, total: 30 });
    expect(result.tasks).toHaveLength(25);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.readVersion).toEqual(expect.any(String));
    expect(result.tasks[0]).toMatchObject({ commitmentId: 'commitment-1', title: 'item-1' });
    expect(result.tasks[0]).not.toHaveProperty('description');
    expect(result.tasks[0]).not.toHaveProperty('basis');
    expect(result.tasks[0]).not.toHaveProperty('history');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6_000);
  });

  it('reads a withdrawn commitment as cancelled whatever its last status value', async () => {
    // index 2 has status "pending"; withdrawn work is not open work.
    const reader = makeReader([view(2, { withdrawn: true }), view(4)]);

    const result = await runWorkListView({ view: 'pipeline' }, context(reader.readWork));

    expect(result).toMatchObject({ view: 'pipeline', total: 1 });
    expect(JSON.stringify(result)).not.toContain('commitment-2');
  });

  it('filters status, stage, project, and title or description before paging', async () => {
    const reader = makeReader([
      view(1, {
        values: {
          title: 'alpha',
          description: 'needle',
          status: 'pending',
          stage: 'stage-1',
          project: 'scope-1',
        },
      }),
      view(2, {
        values: {
          title: 'beta',
          description: 'other',
          status: 'done',
          stage: 'stage-0',
          project: 'scope-0',
        },
      }),
      view(3, {
        values: {
          title: 'gamma',
          description: 'other',
          status: 'pending',
          stage: 'stage-0',
          project: 'scope-0',
        },
      }),
    ]);

    expect(
      (
        await runWorkListView(
          {
            view: 'items',
            status: 'pending',
            stage: 'stage-1',
            project: 'scope-1',
            text: 'needle',
          },
          context(reader.readWork)
        )
      ).tasks.map((task) => task.commitmentId)
    ).toEqual(['commitment-1']);
  });

  it('filters to the items written at or after changedSince', async () => {
    const items = [
      view(1, { updatedAt: 100 }),
      view(2, { updatedAt: 200 }),
      view(3, { updatedAt: 300 }),
    ];
    const reader = makeReader(items);
    const result = await runWorkListView(
      { view: 'items', changedSince: 200 },
      context(reader.readWork)
    );
    expect(result).toMatchObject({ total: 2, returned: 2 });
    expect(
      (result.tasks as Array<{ commitmentId: string }>).map((task) => task.commitmentId)
    ).toEqual(['commitment-2', 'commitment-3']);
  });

  it("finds open items by deadline against the owner's today, and work that has not moved", async () => {
    // now is 2023-11-14 22:15 UTC; a closed item never matches a due filter.
    const dated = (index: number, deadline: string | null, status = 'pending', updatedAt = 100) =>
      view(index, {
        updatedAt,
        values: { title: `item-${index}`, status, ...(deadline === null ? {} : { deadline }) },
      });
    const reader = makeReader([
      dated(1, '2023-11-13'),
      dated(2, '2023-11-14'),
      dated(3, '2023-11-20', 'pending', 300),
      dated(4, null, 'pending', 300),
      dated(5, '2023-11-10', 'done'),
    ]);
    const ids = async (input: Record<string, unknown>) =>
      (
        (await runWorkListView({ view: 'items', ...input }, context(reader.readWork)))
          .tasks as Array<{
          commitmentId: string;
        }>
      ).map((task) => task.commitmentId);
    expect(await ids({ due: 'overdue' })).toEqual(['commitment-1']);
    expect(await ids({ due: 'today' })).toEqual(['commitment-2']);
    expect(await ids({ due: 'upcoming' })).toEqual(['commitment-3']);
    expect(await ids({ due: 'unscheduled' })).toEqual(['commitment-4']);
    expect(await ids({ changedSince: '1970-01-01T00:00:00.250Z' })).toEqual([
      'commitment-3',
      'commitment-4',
    ]);
    await expect(
      runWorkListView({ view: 'items', changedSince: 'today' }, context(reader.readWork))
    ).rejects.toThrow('work.list changedSince must be epoch milliseconds or an ISO time');
    expect(await ids({ changedBefore: 200 })).toEqual([
      'commitment-1',
      'commitment-2',
      'commitment-5',
    ]);
    await expect(
      runWorkListView({ view: 'items', due: 'late' }, context(reader.readWork))
    ).rejects.toThrow('work.list due must be one of overdue|today|upcoming|unscheduled');
  });

  it('counts an exact deadline later today as today, and restarts a due page after midnight', async () => {
    // now is 2023-11-14 22:15 UTC.
    const exact = (index: number, dueAt: string) =>
      view(index, { values: { title: `item-${index}`, status: 'pending', dueAt } });
    const items = [
      exact(1, '2023-11-14T23:00:00Z'),
      exact(2, '2023-11-15T01:00:00Z'),
      ...Array.from({ length: 3 }, (_, index) => exact(index + 3, '2023-11-14T23:30:00Z')),
    ];
    const reader = makeReader(items);
    const today = await runWorkListView(
      { view: 'items', due: 'today', limit: 2 },
      context(reader.readWork)
    );
    expect(today.total).toBe(4);
    const tomorrow = {
      knowledge: { readWork: reader.readWork },
      access,
      now: () => Date.parse('2023-11-15T00:10:00Z'),
      timeZone: 'UTC',
    };
    await expect(
      runWorkListView({ view: 'items', due: 'today', cursor: today.nextCursor }, tomorrow)
    ).rejects.toThrow('work.list cursor belongs to a different query');
  });

  it('continues a filtered items read from the cursor alone and refuses a different filter', async () => {
    const reader = makeReader(Array.from({ length: 80 }, (_, index) => view(index + 1)));
    const first = await runWorkListView(
      { view: 'items', status: ['pending'], limit: 25 },
      context(reader.readWork)
    );
    expect(first).toMatchObject({ total: 40, returned: 25 });
    const second = await runWorkListView(
      { view: 'items', limit: 25, cursor: first.nextCursor },
      context(reader.readWork)
    );
    expect(second).toMatchObject({ total: 40, returned: 15, nextCursor: null });
    await expect(
      runWorkListView(
        { view: 'items', status: ['done'], cursor: first.nextCursor },
        context(reader.readWork)
      )
    ).rejects.toThrow(/different query/);
  });

  it('rejects a cursor after the commitment read version changes', async () => {
    const reader = makeReader(Array.from({ length: 30 }, (_, index) => view(index + 1)));
    const first = await runWorkListView({}, context(reader.readWork));
    reader.state.items[0] = view(1, { values: { title: 'changed', status: 'pending' } });

    await expect(
      runWorkListView({ cursor: first.nextCursor }, context(reader.readWork))
    ).rejects.toThrow(/changed.*restart/i);
  });

  it('surfaces an incomplete commitment page instead of hiding scope gaps', async () => {
    const readWork = vi
      .fn()
      .mockReturnValueOnce({
        items: [],
        nextCursor: '1',
        coverage: {
          returned: 0,
          total: 2,
          complete: false,
          reasons: [
            'more commitments follow this page',
            "1 commitment(s) outside the caller's scopes",
          ],
        },
      })
      .mockReturnValueOnce({
        items: [],
        nextCursor: null,
        coverage: { returned: 0, total: 2, complete: true, reasons: [] },
      });

    await expect(runWorkListView({}, context(readWork))).rejects.toThrow(
      /incomplete|outside the caller/i
    );
  });

  it('returns up to four full records with basis, history, and code-point text continuation', async () => {
    const longText = 'x'.repeat(2_301);
    const reader = makeReader([
      view(1, {
        values: { title: 'one', description: longText },
        revision: 2,
        history: [revision('commitment-1', 1, { title: 'one' })],
      }),
    ]);

    const first = await runWorkListView(
      { view: 'detail', ids: ['commitment-1'], text_limit: 1_000 },
      context(reader.readWork)
    );
    const task = first.tasks[0]!;
    expect(first.missingIds).toEqual([]);
    expect(task).toHaveProperty('basis');
    expect(task).toHaveProperty('history');
    expect(task.description).toMatchObject({ total: 2_301, nextOffset: 1_000 });
    // The text fields are given once, as windows, not again inside values.
    expect(task.values).not.toHaveProperty('description');

    const second = await runWorkListView(
      { view: 'detail', ids: ['commitment-1'], text_offset: 1_000, text_limit: 2_000 },
      context(reader.readWork)
    );
    expect(second.tasks[0]!.description).toMatchObject({
      value: longText.slice(1_000),
      complete: true,
      nextOffset: null,
    });
  });

  it('gives the newest five revisions and twenty evidence refs, paging older revisions', async () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      revision('commitment-1', index + 1, { latestEvent: `event ${index + 1}` })
    );
    const basis = Array.from({ length: 30 }, (_, index) => ({
      kind: 'observation' as const,
      id: `obs-${index + 1}`,
    }));
    const reader = makeReader([view(1, { revision: 12, history, basis })]);
    const page = async (offset?: number) =>
      (
        await runWorkListView(
          {
            view: 'detail',
            ids: ['commitment-1'],
            ...(offset === undefined ? {} : { history_offset: offset }),
          },
          context(reader.readWork)
        )
      ).tasks[0]!;
    const first = await page();
    expect(first.history.map((entry: { revision: number }) => entry.revision)).toEqual([
      12, 11, 10, 9, 8,
    ]);
    expect(first).toMatchObject({ historyTotal: 12, historyNextOffset: 5, basisTotal: 30 });
    expect(first.basis).toHaveLength(20);
    expect(first.basis.at(-1)).toMatchObject({ id: 'obs-30' });
    const last = await page(10);
    expect(last.history.map((entry: { revision: number }) => entry.revision)).toEqual([2, 1]);
    expect(last.historyNextOffset).toBeNull();
  });

  it('registers work.list as the product progressive contract', () => {
    const registration = workListActionRegistrations({
      knowledge: { readWork: vi.fn() },
      timeZone: createTimeZoneSetting('UTC'),
    }).at(0)!;
    expect(registration.contract.name).toBe('work.list');
    expect(registration.contract.inputSchema.properties?.view?.enum).toEqual([
      'overview',
      'items',
      'detail',
      'pipeline',
    ]);
    expect(registration.contract.inputSchema.properties?.status).toMatchObject({
      oneOf: expect.arrayContaining([
        {
          type: 'string',
          enum: ['pending', 'in_progress', 'review', 'blocked', 'done', 'cancelled'],
        },
        {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: ['pending', 'in_progress', 'review', 'blocked', 'done', 'cancelled'],
          },
        },
      ]),
    });
    expect(registration.contract.summary).toContain('Find owner work by what the turn needs');
  });

  it('dispatches the current commitment reader under the caller access', async () => {
    const reader = makeReader([view(1)]);
    const registration = workListActionRegistrations({
      knowledge: { readWork: reader.readWork },
      timeZone: createTimeZoneSetting('UTC'),
    })[0]!;
    const result = await registration.exec({ view: 'items', limit: 1 }, {
      access,
      operationId: 'read-work-list',
    } as ActionContext);

    expect(result).toMatchObject({ view: 'items', returned: 1 });
    expect(reader.readWork).toHaveBeenCalledWith(expect.anything(), access);
  });

  it('ranks by normalized tokens: spaces, circled digits and underscores do not hide a title', async () => {
    const reader = makeReader([
      view(1, {
        updatedAt: 1_700_000_100_003,
        values: { title: 'Synthetic unrelated item', description: 'unrelated description' },
      }),
      view(2, {
        updatedAt: 1_700_000_100_001,
        values: {
          title: '[P] サンプルタワー⑥_SSR_イラスト1',
          description: 'Synthetic target description',
        },
      }),
    ]);
    const readContext = context(reader.readWork);

    const Japanese = await runWorkListView(
      { view: 'items', text: 'サンプルタワー SSR1' },
      readContext
    );
    expect(Japanese.tasks[0]).toMatchObject({
      commitmentId: 'commitment-2',
      title: '[P] サンプルタワー⑥_SSR_イラスト1',
    });
    expect(Japanese.tasks[0]!.score).toEqual(expect.any(Number));
    expect(Japanese.tasks).toHaveLength(1);

    // A name in another script shares no token: no match, so the agent searches in the title's script.
    const otherScript = await runWorkListView({ view: 'items', text: 'sanpurutawa' }, readContext);
    expect(otherScript.tasks).toEqual([]);

    const shortJapanese = await runWorkListView(
      { view: 'items', text: 'サンプルタワー' },
      readContext
    );
    expect(shortJapanese.tasks[0]).toMatchObject({
      commitmentId: 'commitment-2',
      title: '[P] サンプルタワー⑥_SSR_イラスト1',
    });
  });

  it('accepts multiple statuses as an OR filter in one read', async () => {
    const reader = makeReader([
      view(1, { values: { title: 'Synthetic pending', status: 'pending' } }),
      view(2, { values: { title: 'Synthetic review', status: 'review' } }),
      view(3, { values: { title: 'Synthetic done', status: 'done' } }),
    ]);

    const result = await runWorkListView(
      { view: 'items', status: ['pending', 'review'] },
      context(reader.readWork)
    );

    expect(result.tasks.map((task) => task.commitmentId)).toEqual(['commitment-1', 'commitment-2']);
    expect(reader.readWork).toHaveBeenCalledTimes(1);
  });

  it('refuses ids on a non-detail view before reading commitments', async () => {
    const reader = makeReader([view(1)]);

    await expect(
      runWorkListView({ view: 'items', ids: ['commitment-1'] }, context(reader.readWork))
    ).rejects.toThrow(/ids.*detail/i);
    expect(reader.readWork).not.toHaveBeenCalled();
  });
});
