import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { appendObservationVersion } from '../../src/knowledge/observations.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { createNode, currentIdentityRevision } from '../../src/registry/store.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const scope = { kind: 'project', id: 'scope-a' };
const access = { principalId: 'principal', agentId: 'agent', scopes: [scope] };
let dbPath: string;
beforeAll(async () => {
  dbPath = await initTestDB('f3-graph');
});
afterAll(async () => cleanupTestDB(dbPath));
const knowledge = () => createKnowledge({ adapter: getAdapter(), embedder: null });
const node = (name: string, scopes = [scope]) =>
  createNode(getAdapter(), { kind: 'item', name, scopes });

function edge(id: string, from: string, to: string, at = 100) {
  getAdapter()
    .prepare(
      `INSERT INTO twin_edges (edge_id,edge_type,subject_kind,subject_id,object_kind,object_id,source,content_hash,created_at)
    VALUES (?,'mentions','registry',?,'registry',?,'agent',?,?)`
    )
    .run(id, from, to, Buffer.alloc(32), at);
}

describe('F3 graph reads', () => {
  it.each(['%', '_', '\\'])(
    'F3.4 matches literal observation metadata character %s',
    (character) => {
      const ids = [`needle${character}suffix`, 'needlesuffix'];
      const refs = ids.map(
        (id) =>
          appendObservationVersion(getAdapter(), {
            source: 'fixture',
            sourceId: id,
            body: 'evidence',
            contentHash: id,
            observedAt: 100,
            memoryScopeKind: scope.kind,
            memoryScopeId: scope.id,
          }).observationId
      );
      const page = knowledge().queryGraph(
        { view: 'detail', search: { text: ids[0], kinds: ['observation'] } },
        { ...access, connectors: ['fixture'] }
      );
      expect(page.nodes.map((n) => n.ref.id)).toEqual([refs[0]]);
    }
  );

  it('F3.5 filters recorded time before slicing and signals omitted timeline events', async () => {
    const root = node('timeline-root');
    const records: string[] = [];
    for (const time of [100, 200]) {
      const saved = await knowledge().appendJudgment(
        {
          commandId: `timeline-${time}`,
          topic: `timeline-${time}`,
          summary: 'timeline evidence',
          recordKind: 'judgment',
          links: [{ relation: 'mentions', target: { kind: 'registry', id: root } }],
        },
        access
      );
      records.push(saved.recordId);
      getAdapter()
        .prepare('UPDATE decisions SET event_datetime=?,created_at=? WHERE id=?')
        .run(time / 10, time, saved.recordId);
      getAdapter()
        .prepare('UPDATE twin_edges SET created_at=? WHERE subject_id=?')
        .run(time, saved.recordId);
    }
    const query = {
      seeds: [{ kind: 'registry' as const, id: root }],
      view: 'timeline' as const,
      history: 'all' as const,
      limit: 1,
    };
    const filtered = knowledge().queryGraph({ ...query, recordedRange: { start: 200 } }, access);
    expect(filtered.nodes.map((n) => n.ref.id)).toContain(records[1]);
    expect(filtered.nodes.map((n) => n.ref.id)).not.toContain(records[0]);
    expect(filtered.coverage.reasons).toContain('limit_reached');
    expect(knowledge().queryGraph(query, access).coverage.reasons).toContain('limit_reached');
    expect(knowledge().queryGraph({ ...query, limit: 4 }, access).coverage.reasons).not.toContain(
      'limit_reached'
    );
  });

  it('F3.12 does not hydrate a merged identity outside the caller scopes', () => {
    const foreign = { kind: 'project', id: 'scope-b' };
    const member = node('visible-member');
    const survivor = node('restricted-survivor', [foreign]);
    knowledge().correctIdentity(
      {
        commandId: 'merge-scopes',
        expectedRevision: currentIdentityRevision(getAdapter()),
        reason: 'duplicate',
        operation: 'merge',
        survivorId: survivor,
        memberIds: [member],
      },
      { ...access, scopes: [scope, foreign] }
    );
    // A later scope change removes the merged survivor from this caller.
    getAdapter()
      .prepare('DELETE FROM registry_scope_bindings WHERE node_id=? AND scope_id=?')
      .run(survivor, scope.id);
    const page = knowledge().queryGraph(
      { view: 'detail', seeds: [{ kind: 'registry', id: member }] },
      access
    );
    expect(page.nodes).toEqual([]);
    expect(JSON.stringify(page.nodes)).not.toContain('restricted-survivor');
  });

  it('F3.9 reports truncation when a disconnected search fills the frontier', () => {
    const root = node('frontier-root');
    const target = node('disconnected-target');
    getAdapter().transaction(() => {
      for (let i = 0; i < 1100; i++) edge(`fan-${i}`, root, node(`leaf-${i}`));
    });
    const page = knowledge().queryGraph(
      {
        view: 'paths',
        from: { kind: 'registry', id: root },
        to: { kind: 'registry', id: target },
        maxDepth: 3,
      },
      access
    );
    expect(page.edges).toEqual([]);
    expect(page.coverage.reasons).toContain('limit_reached');
  });

  it('F3.9 bounds edge rows scanned even when every candidate is hidden', () => {
    const root = node('edge-root');
    const target = node('edge-target');
    const hidden = node('hidden-endpoint', [{ kind: 'project', id: 'hidden-scope' }]);
    getAdapter().transaction(() => {
      for (let i = 0; i < 11000; i++) edge(`hidden-${i}`, root, hidden);
    });
    const db = getAdapter();
    const prepare = db.prepare.bind(db);
    let fetched = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (/SELECT \*\s+FROM twin_edges\s+WHERE/.test(sql)) {
        const all = stmt.all.bind(stmt);
        stmt.all = (...args: unknown[]) => {
          const rows = all(...args);
          fetched += rows.length;
          return rows;
        };
      }
      return stmt;
    });
    try {
      const page = knowledge().queryGraph(
        {
          view: 'paths',
          from: { kind: 'registry', id: root },
          to: { kind: 'registry', id: target },
        },
        access
      );
      expect(page.coverage.reasons).toContain('limit_reached');
      expect(fetched).toBeLessThan(11000);
    } finally {
      spy.mockRestore();
    }
  });
});
