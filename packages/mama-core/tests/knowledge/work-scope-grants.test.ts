import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type JudgmentAccess, type Knowledge } from '../../src/knowledge/index.js';
import { createNode } from '../../src/registry/store.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const shared = { kind: 'project', id: 'scope-shared' };
const hidden = { kind: 'project', id: 'scope-hidden' };
const own = { kind: 'user', id: 'principal-reader' };
const owner: JudgmentAccess = {
  principalId: 'principal-writer',
  agentId: 'agent-writer',
  scopes: [shared, hidden, own],
};
const reader: JudgmentAccess = {
  principalId: 'principal-reader',
  agentId: 'agent-reader',
  scopes: [own],
  readScopes: [shared],
};

describe('work scopes and read grants', () => {
  let dbPath: string;
  let knowledge: Knowledge;
  beforeAll(async () => {
    dbPath = await initTestDB('work-scope-grants');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
  });
  beforeEach(() => {
    for (const table of [
      'commitment_assignments',
      'commitments',
      'judgment_commands',
      'command_bindings',
      'twin_edges',
      'memory_events',
      'memory_scope_bindings',
      'memory_scopes',
      'embeddings',
      'decisions',
      'registry_ref_assignments',
      'record_actors',
      'registry_scope_bindings',
      'registry_aliases',
      'registry_nodes',
    ])
      getAdapter().prepare(`DELETE FROM ${table}`).run();
  });
  afterAll(async () => cleanupTestDB(dbPath));

  function create(commandId: string, scopes = [shared]) {
    return knowledge.createWork(
      { commandId, topic: 'scope-test', summary: commandId, set: { title: commandId }, scopes },
      owner
    );
  }
  function bindings(recordId: string) {
    return getAdapter()
      .prepare(
        `SELECT s.kind, s.external_id AS id
      FROM memory_scope_bindings b JOIN memory_scopes s ON s.id = b.scope_id
      WHERE b.memory_id = ? ORDER BY b.is_primary DESC, b.rowid`
      )
      .all(recordId);
  }
  async function board() {
    const outside = await create('hidden-first', [hidden]);
    const first = await create('shared-first');
    const unbound = await create('unbound', []);
    const second = await create('shared-second');
    await create('hidden-last', [hidden]);
    return { outside, first, unbound, second };
  }

  it('fills pages from visible heads and counts only granted and unbound commitments', async () => {
    await board();
    const first = knowledge.readWork({ limit: 2 }, reader);
    expect(first.items.map((item) => item.values.title)).toEqual(['shared-first', 'unbound']);
    expect(first.coverage).toEqual({
      returned: 2,
      total: 3,
      complete: false,
      reasons: ['more commitments follow this page'],
    });
    const last = knowledge.readWork({ limit: 2, cursor: first.nextCursor! }, reader);
    expect(last.items.map((item) => item.values.title)).toEqual(['shared-second']);
    expect(last.coverage).toEqual({ returned: 1, total: 3, complete: true, reasons: [] });
    expect(last.nextCursor).toBeNull();
  });

  it('opens granted work by id and row id with its chain and hides other ids like missing ids', async () => {
    const { first, outside } = await board();
    await knowledge.reviseWork(
      {
        commandId: 'shared-revision',
        commitmentId: first.commitmentId,
        summary: 'shared update',
        set: { status: 'done' },
        scopes: [shared],
      },
      owner
    );
    const page = knowledge.readWork({ commitmentId: first.commitmentId, history: 'chain' }, reader);
    expect(page.items[0]?.chain?.map((entry) => entry.summary)).toEqual([
      'shared-first',
      'shared update',
    ]);
    expect(knowledge.readWork({ rowId: page.items[0].rowId, history: 'chain' }, reader)).toEqual(
      page
    );
    const missing = knowledge.readWork({ commitmentId: 'missing' }, reader);
    expect(knowledge.readWork({ commitmentId: outside.commitmentId }, reader)).toEqual(missing);
    const outsideRow = knowledge.readWork({ commitmentId: outside.commitmentId }, owner).items[0]
      .rowId;
    expect(knowledge.readWork({ rowId: outsideRow }, reader)).toEqual(missing);
  });

  it('preserves the full board and pagination for a caller with all scopes', async () => {
    await board();
    const titles: unknown[] = [];
    let cursor: string | undefined;
    for (const returned of [2, 2, 1]) {
      const page = knowledge.readWork({ limit: 2, ...(cursor ? { cursor } : {}) }, owner);
      expect(page.coverage).toEqual({
        returned,
        total: 5,
        complete: returned === 1,
        reasons: returned === 1 ? [] : ['more commitments follow this page'],
      });
      titles.push(...page.items.map((item) => item.values.title));
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(titles).toEqual([
      'hidden-first',
      'shared-first',
      'unbound',
      'shared-second',
      'hidden-last',
    ]);
  });

  it('traverses granted commitments through a graph query', async () => {
    const { first, second } = await board();
    const link = knowledge.appendLink(
      {
        commandId: 'shared-edge',
        from: first.recordRef as { kind: 'memory'; id: string },
        to: second.recordRef,
        relation: 'builds_on',
        reason: 'earlier evidence',
      },
      owner
    );
    const graph = knowledge.queryGraph(
      { view: 'neighbors', seeds: [first.recordRef], maxDepth: 1 },
      reader
    );
    expect(graph.nodes.map((node) => node.ref.id).sort()).toEqual(
      [first.recordRef.id, second.recordRef.id].sort()
    );
    expect(graph.edges.map((edge) => edge.id)).toContain(link.edgeId);
  });

  it('finds a readable memory match that more hidden matches outrank', async () => {
    for (let index = 0; index < 26; index += 1) {
      await create(`alpha-alpha-alpha-hidden-${index}`, [hidden]);
    }
    const readable = await create('alpha-readable');
    const graph = knowledge.queryGraph(
      { view: 'detail', search: { text: 'alpha', kinds: ['memory'] } },
      reader
    );
    expect(graph.nodes.map((node) => node.ref.id)).toEqual([readable.recordRef.id]);
  });

  it('admits read grants in registry overview, alias search and child hydration', () => {
    const root = createNode(getAdapter(), {
      kind: 'item',
      name: 'Shared anchor',
      aliases: ['anchor'],
      scopes: [shared],
    });
    const child = createNode(getAdapter(), {
      kind: 'item',
      name: 'Shared child',
      parentId: root,
      scopes: [shared],
    });
    createNode(getAdapter(), { kind: 'item', name: 'Hidden anchor', scopes: [hidden] });
    expect(
      knowledge.queryGraph({ view: 'overview' }, reader).nodes.map((node) => node.ref.id)
    ).toEqual([root]);
    const detail = knowledge.queryGraph(
      { view: 'detail', search: { text: 'anchor', kinds: ['registry'] } },
      reader
    );
    expect(detail.nodes.map((node) => node.ref.id)).toEqual([root]);
    expect(detail.nodes[0].data).toMatchObject({
      visibleAliases: expect.arrayContaining(['anchor']),
      visibleChildren: expect.arrayContaining([expect.objectContaining({ id: child })]),
    });
  });

  it('allows judgment citations into read grants but refuses replacements and amendments', async () => {
    const target = await create('cited-work');
    const saved = await knowledge.appendJudgment(
      {
        commandId: 'citation',
        topic: 'scope-test',
        summary: 'cite shared evidence',
        recordKind: 'judgment',
        links: [{ relation: 'builds_on', target: target.recordRef }],
      },
      reader
    );
    expect(bindings(saved.recordId)).toEqual([own]);
    expect(
      await knowledge.appendJudgment(
        {
          commandId: 'citation',
          topic: 'scope-test',
          summary: 'cite shared evidence',
          recordKind: 'judgment',
          links: [{ relation: 'builds_on', target: target.recordRef }],
        },
        reader
      )
    ).toEqual(saved);
    await expect(
      knowledge.appendJudgment(
        {
          commandId: 'replacement',
          topic: 'scope-test',
          summary: 'replace',
          recordKind: 'judgment',
          replaces: [{ id: target.recordRef.id, reason: 'correction' }],
        },
        reader
      )
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
    await expect(
      knowledge.appendJudgment(
        {
          commandId: 'amendment',
          topic: 'scope-test',
          summary: 'amend',
          recordKind: 'judgment',
          amends: [{ target: { kind: 'memory', id: target.recordRef.id }, outcome: 'success' }],
        },
        reader
      )
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
  });

  it('allows standalone link endpoints, evidence and corrected edges in read grants', async () => {
    const first = await create('first-link-end');
    const second = await create('second-link-end');
    const linked = knowledge.appendLink(
      {
        commandId: 'read-link',
        from: first.recordRef as { kind: 'memory'; id: string },
        to: second.recordRef,
        relation: 'builds_on',
        evidenceRefs: [second.recordRef],
        reason: 'shared evidence',
      },
      reader
    );
    const corrected = knowledge.appendLink(
      {
        commandId: 'read-correction',
        from: first.recordRef as { kind: 'memory'; id: string },
        to: { kind: 'edge', id: linked.edgeId },
        relation: 'contradicts',
        reason: 'new evidence',
      },
      reader
    );
    expect(corrected.replayed).toBe(false);
  });

  it('keeps narrower bindings on a revision without scopes and remains visible to a granted reader', async () => {
    const item = await create('narrow-item');
    const revised = await knowledge.reviseWork(
      {
        commandId: 'narrow-revision',
        commitmentId: item.commitmentId,
        summary: 'keep sharing',
        set: { title: 'revised' },
      },
      { ...owner, defaultScopes: [own] }
    );
    expect(bindings(revised.recordRef.id)).toEqual([shared]);
    expect(
      knowledge.readWork({ commitmentId: item.commitmentId }, reader).items[0]?.values.title
    ).toBe('revised');
  });

  it('refuses an omitted-scope revision when any existing binding is outside write authority', async () => {
    const item = await create('partially-writable', [shared, hidden]);
    await expect(
      knowledge.reviseWork(
        {
          commandId: 'denied-revision',
          commitmentId: item.commitmentId,
          summary: 'cannot write all bindings',
          set: { title: 'changed' },
        },
        { ...reader, scopes: [own, shared] }
      )
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(
      knowledge.reviseWork(
        {
          commandId: 'read-only-revision',
          commitmentId: item.commitmentId,
          summary: 'read grant is insufficient',
          set: { title: 'changed' },
        },
        reader
      )
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(knowledge.readWork({ commitmentId: item.commitmentId }, owner).items[0].revision).toBe(
      1
    );
  });

  it('keeps an unbound head unbound when revising without scopes', async () => {
    const item = await create('unbound-item', []);
    const revised = await knowledge.reviseWork(
      {
        commandId: 'unbound-revision',
        commitmentId: item.commitmentId,
        summary: 'still unbound',
        set: { title: 'open revision' },
      },
      owner
    );
    expect(bindings(revised.recordRef.id)).toEqual([]);
    expect(
      knowledge.readWork(
        { commitmentId: item.commitmentId },
        { ...reader, scopes: [], readScopes: [] }
      ).items
    ).toHaveLength(1);
  });

  it.each(['appendJudgment', 'reviseWork'] as const)(
    'refuses an explicit-scope revision through %s with only a read grant on the target',
    async (path) => {
      const item = await create('explicit-read-only');
      const command = {
        commandId: 'explicit-denied',
        commitmentId: item.commitmentId,
        summary: 'read authority cannot rebind work',
        set: { title: 'changed' },
        scopes: [own],
      };
      const write =
        path === 'reviseWork'
          ? knowledge.reviseWork(command, reader)
          : knowledge.appendJudgment(
              {
                commandId: command.commandId,
                topic: 'scope-test',
                summary: command.summary,
                recordKind: 'commitment',
                scopes: command.scopes,
                work: { operation: 'revise', commitmentId: item.commitmentId, set: command.set },
              },
              reader
            );
      await expect(write).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
      expect(knowledge.readWork({ commitmentId: item.commitmentId }, owner).items[0].revision).toBe(
        1
      );
    }
  );

  it('inherits the current bindings after an asynchronous embedding yields', async () => {
    const item = await create('concurrent-item');
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const embedding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = appendJudgment(
      {
        commandId: 'after-embedding',
        topic: 'scope-test',
        summary: 'append to the current head',
        recordKind: 'commitment',
        work: {
          operation: 'revise',
          commitmentId: item.commitmentId,
          set: { title: 'after embedding' },
        },
      },
      owner,
      {
        adapter: getAdapter(),
        embedder: {
          embed: async () => {
            started();
            await embedding;
            return null;
          },
        },
      }
    );
    await ready;
    try {
      await knowledge.reviseWork(
        {
          commandId: 'concurrent-rebind',
          commitmentId: item.commitmentId,
          summary: 'change sharing during embedding',
          set: { title: 'new head' },
          scopes: [hidden],
        },
        owner
      );
    } finally {
      release();
    }
    const written = await pending;
    expect(bindings(written.recordId)).toEqual([hidden]);
    expect(written.work?.revision).toBe(3);
  });

  it('replays an omitted-scope revision after another revision changes head bindings', async () => {
    const item = await create('replay-item');
    const command = {
      commandId: 'replay-revision',
      commitmentId: item.commitmentId,
      expectedRevision: 1,
      summary: 'first revision',
      set: { title: 'first revision' },
    };
    const first = await knowledge.reviseWork(command, owner);
    expect(bindings(first.recordRef.id)).toEqual([shared]);
    await knowledge.reviseWork(
      {
        commandId: 'rebind-revision',
        commitmentId: item.commitmentId,
        summary: 'change binding',
        scopes: [hidden],
        set: { title: 'later revision' },
      },
      owner
    );
    expect(await knowledge.reviseWork(command, owner)).toEqual(first);
    await expect(
      knowledge.reviseWork({ ...command, summary: 'different' }, owner)
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(knowledge.readWork({ commitmentId: item.commitmentId }, owner).items[0].revision).toBe(
      3
    );
  });

  it.each(['judgment', 'commitment'] as const)(
    'binds a new %s only to defaultScopes when scopes are omitted',
    async (recordKind) => {
      const saved = await knowledge.appendJudgment(
        {
          commandId: 'default-new',
          topic: 'scope-test',
          summary: 'default write',
          recordKind,
          ...(recordKind === 'commitment'
            ? { work: { operation: 'create' as const, set: { title: 'default item' } } }
            : {}),
        },
        { ...owner, defaultScopes: [own] }
      );
      expect(bindings(saved.recordId)).toEqual([own]);
    }
  );

  it('refuses a default outside write scopes even if it has a read grant', async () => {
    await expect(
      knowledge.appendJudgment(
        {
          commandId: 'default-denied',
          topic: 'scope-test',
          summary: 'invalid default',
          recordKind: 'judgment',
        },
        { ...reader, defaultScopes: [shared] }
      )
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });

  it('preserves the all-write-scopes default when defaultScopes is absent', async () => {
    const saved = await knowledge.appendJudgment(
      {
        commandId: 'default-absent',
        topic: 'scope-test',
        summary: 'existing default',
        recordKind: 'judgment',
      },
      owner
    );
    expect(bindings(saved.recordId)).toEqual([shared, hidden, own]);
  });
});
