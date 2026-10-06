import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { appendObservationVersion } from '../../src/knowledge/observations.js';
import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { createNode, currentIdentityRevision } from '../../src/registry/store.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }] as MemoryScopeRef[],
};

describe('Story R1: knowledge.queryGraph over real adapter', () => {
  let dbPath = '';
  let knowledge: Knowledge;

  beforeAll(async () => {
    dbPath = await initTestDB('graph-roundtrip');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
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
    db.prepare('DELETE FROM registry_ref_assignments').run();
    db.prepare('DELETE FROM registry_scope_bindings').run();
    db.prepare('DELETE FROM registry_aliases').run();
    db.prepare('DELETE FROM registry_nodes').run();
    db.prepare('DELETE FROM observation_versions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('round-trips appendJudgment into a timeline node', async () => {
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Roundtrip Item',
      scopes: ACCESS.scopes,
    });
    const first = await knowledge.appendJudgment(
      {
        commandId: 'cmd-roundtrip-1',
        topic: 'roundtrip-topic',
        summary: 'roundtrip judgment',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const page = knowledge.queryGraph(
      { seeds: [{ kind: 'registry', id: itemId }], view: 'timeline', history: 'all' },
      ACCESS
    );

    expect(page.nodes.some((node) => node.ref.id === first.recordId)).toBe(true);
    expect(page.edges.map((edge) => edge.relation)).toContain('mentions');
    const record = page.nodes.find((node) => node.ref.id === first.recordId);
    expect(record?.data.kind).toBe('memory');
    if (record?.data.kind === 'memory') {
      expect(record.data.topic).toBe('roundtrip-topic');
      expect(record.data.stateAtSnapshot).toBe('current');
      expect(record.data.work).toBeNull();
      expect(record.data.content.complete).toBe(true);
    }
    expect(page.snapshot.identityRevision).toBe(currentIdentityRevision(getAdapter()));
  });

  it('browses visible edges in bounded pages without losing isolated roots', async () => {
    // Each write gets its own millisecond: the page probe counts an unseen edge written in the
    // same millisecond as the last visible one, and would point at an empty page.
    vi.useFakeTimers({ toFake: ['Date'] });
    let clock = Date.now();
    const tick = () => vi.setSystemTime((clock += 5));
    onTestFinished(() => vi.useRealTimers());
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Visible work',
      scopes: ACCESS.scopes,
    });
    for (const number of [1, 2]) {
      tick();
      await knowledge.appendJudgment(
        {
          commandId: `cmd-browse-${number}`,
          topic: `browse-${number}`,
          summary: `evidence ${number}`,
          recordKind: 'judgment',
          links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
          scopes: ACCESS.scopes,
        },
        ACCESS
      );
    }
    const otherAccess = { ...ACCESS, scopes: [{ kind: 'project' as const, id: 'other' }] };
    const otherId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Hidden work',
      scopes: otherAccess.scopes,
    });
    tick();
    await knowledge.appendJudgment(
      {
        commandId: 'cmd-browse-hidden',
        topic: 'hidden',
        summary: 'other principal evidence',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: otherId } }],
        scopes: otherAccess.scopes,
      },
      otherAccess
    );

    tick();
    const first = knowledge.queryGraph({ view: 'browse', limit: 1 }, ACCESS);
    expect(first.edges).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    expect(first.nodes).toHaveLength(2);
    const second = knowledge.queryGraph(
      { view: 'browse', limit: 1, cursor: first.nextCursor! },
      ACCESS
    );
    expect(second.edges).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.edges, ...second.edges].map((edge) => edge.id)).size).toBe(2);
    expect([...first.nodes, ...second.nodes].some((node) => node.ref.id === otherId)).toBe(false);
  });

  it('browses memory-to-observation evidence without a registry seed or another connector grant', async () => {
    const observed = appendObservationVersion(getAdapter(), {
      source: 'trello',
      sourceType: 'card',
      sourceId: 'browse-card',
      sourceEntityId: 'browse-card',
      channel: 'trello:board-1',
      author: 'owner',
      bodyLocation: { kind: 'raw', connectorName: 'trello', revisionSourceId: 'browse-card' },
      producerVersionId: 'browse-card',
      contentHash: 'hash-browse-card',
      sourceAt: null,
      observedAt: 1_700_000_000_000,
      memoryScopeKind: 'project',
      memoryScopeId: 'scope-test',
      projectId: 'scope-test',
    });
    await knowledge.appendJudgment(
      {
        commandId: 'cmd-browse-observation',
        topic: 'source judgment',
        summary: 'what the card says',
        recordKind: 'judgment',
        links: [
          {
            relation: 'derived_from',
            target: { kind: 'observation', id: observed.observationId! },
          },
        ],
        scopes: ACCESS.scopes,
      },
      { ...ACCESS, connectors: ['trello'] }
    );

    const granted = knowledge.queryGraph({ view: 'browse' }, { ...ACCESS, connectors: ['trello'] });
    expect(granted.edges.map((edge) => edge.relation)).toEqual(['derived_from']);
    expect(granted.nodes.map((node) => node.ref.kind)).toEqual(
      expect.arrayContaining(['memory', 'observation'])
    );
    const denied = knowledge.queryGraph({ view: 'browse' }, { ...ACCESS, connectors: ['slack'] });
    expect(denied.edges).toEqual([]);
  });

  it('marks a mechanical legacy import as code provenance instead of an agent judgment', async () => {
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Imported item',
      scopes: ACCESS.scopes,
    });
    const receipt = await knowledge.appendJudgment(
      {
        commandId: 'cmd-import-provenance',
        topic: 'imported-item',
        summary: 'preserved historical attribution',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        scopes: ACCESS.scopes,
      },
      { ...ACCESS, agentId: 'backfill-agent', edgeSource: 'code' }
    );
    expect(
      getAdapter()
        .prepare('SELECT source, agent_id FROM twin_edges WHERE subject_id = ?')
        .get(receipt.recordId)
    ).toMatchObject({ source: 'code', agent_id: 'backfill-agent' });
  });

  it('history current omits a replaced record that history all keeps', async () => {
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'History Item',
      scopes: ACCESS.scopes,
    });
    const first = await knowledge.appendJudgment(
      {
        commandId: 'cmd-history-1',
        topic: 'history-topic',
        summary: 'first view',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        scopes: ACCESS.scopes,
      },
      ACCESS
    );
    const second = await knowledge.appendJudgment(
      {
        commandId: 'cmd-history-2',
        topic: 'history-topic',
        summary: 'revised view',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        replaces: [{ id: first.recordId, reason: 'new evidence' }],
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const all = knowledge.queryGraph(
      { seeds: [{ kind: 'registry', id: itemId }], view: 'timeline', history: 'all' },
      ACCESS
    );
    expect(all.nodes.map((node) => node.ref.id)).toEqual(
      expect.arrayContaining([first.recordId, second.recordId])
    );

    const current = knowledge.queryGraph(
      { seeds: [{ kind: 'registry', id: itemId }], view: 'timeline', history: 'current' },
      ACCESS
    );
    expect(current.nodes.map((node) => node.ref.id)).toContain(second.recordId);
    expect(current.nodes.map((node) => node.ref.id)).not.toContain(first.recordId);
    // The current view is complete: a replaced record is absent because it no
    // longer stands, not because the page was truncated.
    expect(current.coverage.complete).toBe(true);
  });

  it('reports the resolved identity of a merged registry node', async () => {
    const survivorId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Merge Survivor',
      scopes: ACCESS.scopes,
    });
    const memberId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Merge Member',
      scopes: ACCESS.scopes,
    });

    const receipt = knowledge.correctIdentity(
      {
        commandId: 'cmd-merge-1',
        expectedRevision: currentIdentityRevision(getAdapter()),
        reason: 'duplicate node',
        operation: 'merge',
        survivorId,
        memberIds: [memberId],
      },
      ACCESS
    );
    expect(receipt.identityRevision).toBeGreaterThan(0);

    const page = knowledge.queryGraph(
      { seeds: [{ kind: 'registry', id: memberId }], view: 'detail', history: 'all' },
      ACCESS
    );
    const member = page.nodes.find((node) => node.ref.id === memberId);
    expect(member?.resolvedRef).toEqual({ kind: 'registry', id: survivorId });
  });

  it('hydrates an observation ref only under the connector grant', async () => {
    const indexed = appendObservationVersion(getAdapter(), {
      source: 'trello',
      sourceType: 'card',
      sourceId: 'card-rt-1',
      sourceEntityId: 'card-1',
      channel: 'trello:board-1',
      author: 'owner',
      bodyLocation: { kind: 'raw', connectorName: 'trello', revisionSourceId: 'card-rt-1' },
      producerVersionId: 'card-rt-1',
      contentHash: 'hash-card-rt-1',
      sourceAt: null,
      observedAt: 1_700_000_000_000,
      memoryScopeKind: 'project',
      memoryScopeId: 'scope-test',
      projectId: 'scope-test',
    });
    const observationId = indexed.observationId;
    expect(observationId).toBeTruthy();

    const granted = knowledge.queryGraph(
      {
        seeds: [{ kind: 'observation', id: observationId! }],
        view: 'detail',
        history: 'all',
      },
      { ...ACCESS, connectors: ['trello'] }
    );
    const observation = granted.nodes.find((node) => node.ref.id === observationId);
    expect(observation?.data.kind).toBe('observation');
    if (observation?.data.kind === 'observation') {
      expect(observation.data.connector).toBe('trello');
      expect(observation.data.sourceId).toBe('card-rt-1');
    }

    expect(() =>
      knowledge.queryGraph(
        {
          seeds: [{ kind: 'observation', id: observationId! }],
          view: 'detail',
          history: 'all',
        },
        { ...ACCESS, connectors: ['slack'] }
      )
    ).toThrow();
  });

  it('finds a seed by alias and lists overview roots without a name', async () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Searchable Alpha',
      scopes: ACCESS.scopes,
    });

    const searched = knowledge.queryGraph(
      { search: { text: 'Searchable Alpha', kinds: ['registry'] }, view: 'detail' },
      ACCESS
    );
    expect(searched.nodes.map((node) => node.ref)).toContainEqual({
      kind: 'registry',
      id: nodeId,
    });

    const overview = knowledge.queryGraph({ view: 'overview' }, ACCESS);
    expect(overview.nodes.map((node) => node.ref)).toContainEqual({
      kind: 'registry',
      id: nodeId,
    });
  });

  it('treats a hyphenated search name as text while preserving its registry alias hit', () => {
    const nodeId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Item-2026',
      scopes: ACCESS.scopes,
    });

    const page = knowledge.queryGraph({ search: { text: 'Item-2026' }, view: 'detail' }, ACCESS);
    expect(page.nodes.map((node) => node.ref)).toContainEqual({ kind: 'registry', id: nodeId });
  });

  it('keeps nonadjacent legacy memory terms discoverable through free-text graph search', () => {
    const adapter = getAdapter();
    adapter
      .prepare(
        `INSERT INTO decisions(id,topic,decision,reasoning,confidence,created_at,updated_at,status)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        'mem-fts-terms',
        'alpha unrelated beta',
        'separate terms',
        'source',
        0.8,
        1,
        1,
        'active'
      );
    adapter
      .prepare('INSERT INTO memory_scopes(id,kind,external_id) VALUES(?,?,?)')
      .run('scope-fts-terms', 'project', 'scope-test');
    adapter
      .prepare('INSERT INTO memory_scope_bindings(memory_id,scope_id,is_primary) VALUES(?,?,1)')
      .run('mem-fts-terms', 'scope-fts-terms');
    expect(
      adapter
        .prepare(
          `SELECT d.id FROM decisions_fts JOIN decisions d ON decisions_fts.rowid = d.rowid
           WHERE decisions_fts MATCH ?`
        )
        .all('"alpha" AND "beta"')
    ).toHaveLength(1);
    const page = knowledge.queryGraph(
      { view: 'detail', search: { text: 'alpha beta', kinds: ['memory'] } },
      ACCESS
    );
    expect(page.nodes.map((node) => node.ref.id)).toContain('mem-fts-terms');
  });

  it('answers an unresolvable spelling with an empty page, not an error', () => {
    // The registry_lookup contract: an empty result is the signal to put.
    for (const view of ['detail', 'neighbors', 'timeline'] as const) {
      const page = knowledge.queryGraph(
        { view, search: { text: 'Nobody Named This', kinds: ['registry'] } },
        ACCESS
      );
      expect(page.nodes).toHaveLength(0);
      expect(page.coverage.reasons).toContain('search_no_match');
    }

    // A query with no anchor at all stays malformed.
    expect(() => knowledge.queryGraph({ view: 'neighbors' }, ACCESS)).toThrow(/seed/);
    expect(() => knowledge.queryGraph({ view: 'detail' }, ACCESS)).toThrow(/seed/);
  });

  it('lists each visible alias once however many admitted scopes bind it', () => {
    const wideScopes = [
      { kind: 'project' as const, id: 'scope-test' },
      { kind: 'channel' as const, id: 'ops' },
      { kind: 'global' as const, id: 'system' },
    ];
    const nodeId = createNode(getAdapter(), {
      kind: 'person',
      name: 'Scoped Person',
      aliases: ['Scoped'],
      scopes: wideScopes,
    });
    const page = knowledge.queryGraph(
      { view: 'detail', seeds: [{ kind: 'registry', id: nodeId }] },
      { ...ACCESS, scopes: wideScopes }
    );
    const node = page.nodes.find((n) => n.ref.id === nodeId);
    expect(node?.data.kind).toBe('registry');
    if (node?.data.kind === 'registry') {
      const aliases = node.data.visibleAliases;
      expect(aliases).toEqual([...new Set(aliases)]);
      expect(aliases).toContain('Scoped Person');
      expect(aliases).toContain('Scoped');
    }
  });

  it('walks neighbors in the requested direction only', async () => {
    const itemId = createNode(getAdapter(), {
      kind: 'item',
      name: 'Direction Item',
      scopes: ACCESS.scopes,
    });
    const judgment = await knowledge.appendJudgment(
      {
        commandId: 'cmd-direction-1',
        topic: 'direction-topic',
        summary: 'direction judgment',
        recordKind: 'judgment',
        links: [{ relation: 'mentions', target: { kind: 'registry', id: itemId } }],
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const inbound = knowledge.queryGraph(
      {
        seeds: [{ kind: 'registry', id: itemId }],
        view: 'neighbors',
        direction: 'in',
      },
      ACCESS
    );
    expect(inbound.nodes.map((node) => node.ref.id)).toContain(judgment.recordId);

    const outbound = knowledge.queryGraph(
      {
        seeds: [{ kind: 'registry', id: itemId }],
        view: 'neighbors',
        direction: 'out',
      },
      ACCESS
    );
    expect(outbound.edges).toHaveLength(0);
  });
});
