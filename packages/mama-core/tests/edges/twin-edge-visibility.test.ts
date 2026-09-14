import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import {
  assertTwinRefsVisible,
  listVisibleTwinEdgesForRefs,
} from '../../src/edges/ref-validation.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

type ScopeKind = 'project' | 'user' | 'channel' | 'global';

function insertScopedMemory(
  id: string,
  kind: ScopeKind,
  externalId: string,
  status = 'active'
): void {
  const adapter = getAdapter();
  const scopeId = `scope_${kind}_${externalId}`;
  adapter
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, created_at, updated_at, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, `topic-${id}`, `decision-${id}`, `reasoning-${id}`, 0.8, 1_000, 1_000, status);
  adapter
    .prepare(
      `
        INSERT OR IGNORE INTO memory_scopes (id, kind, external_id)
        VALUES (?, ?, ?)
      `
    )
    .run(scopeId, kind, externalId);
  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary)
        VALUES (?, ?, 1)
      `
    )
    .run(id, scopeId);
}

function insertOpaqueObjectEdge(id: string, objectKind: 'entity' | 'report'): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO twin_edges (
          edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
          confidence, source, reason_text, content_hash, created_at
        )
        VALUES (?, 'mentions', 'memory', 'mem-alpha', ?, ?, 1, 'code', 'opaque object', ?, 1_000)
      `
    )
    .run(id, objectKind, `${objectKind}-1`, Buffer.alloc(32, id.length));
}

function insertRegistryNode(
  id: string,
  createdAt: number,
  options: { mergedInto?: string } = {}
): void {
  const adapter = getAdapter();
  adapter
    .prepare(
      `
        INSERT INTO registry_nodes (id, kind, name, merged_into, created_at, updated_at)
        VALUES (?, 'item', ?, ?, ?, ?)
      `
    )
    .run(id, `name-${id}`, options.mergedInto ?? null, createdAt, createdAt);
}

describe('Story M3.1: Twin Edge Visibility', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('twin-edge-visibility');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #5: endpoint visibility is fail-closed for scoped refs', () => {
    it('rejects memory refs with statuses excluded from normal context recall', () => {
      insertScopedMemory('mem-stale', 'project', 'alpha', 'stale');

      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'memory', id: 'mem-stale' }], {
          scopes: [{ kind: 'project', id: 'alpha' }],
        })
      ).toThrow(/not visible/i);
    });

    /**
     * A registry ref must have existed at the requested `as_of`, the same rule memory, raw
     * and observation refs obey. The entity branch this replaced applied it; the registry
     * branch that replaced it did not, so a packet could cite a node created after the
     * boundary it was compiled against.
     */
    it('rejects a registry node created after the requested as_of', () => {
      insertRegistryNode('reg-late', 5_000);

      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'registry', id: 'reg-late' }], {
          asOfMs: 1_000,
        })
      ).toThrow(/not visible/i);

      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'registry', id: 'reg-late' }], {
          asOfMs: 9_000,
        })
      ).not.toThrow();
    });

    it('rejects a registry node created before the requested window start', () => {
      insertRegistryNode('reg-early', 1_000);

      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'registry', id: 'reg-early' }], {
          startMs: 5_000,
        })
      ).toThrow(/not visible/i);
    });

    /**
     * Merging redirects identity; it does not retire the node. The graph projection keeps the
     * ORIGINAL ref and resolves the current one beside it, so a merged-away node stays citable.
     * A first version of this fix excluded `merged_into IS NOT NULL` and broke that contract -
     * agent-graph.test.ts caught it. Pinned here so the exclusion is not reintroduced.
     */
    it('keeps a merged-away registry node citable as an original ref', () => {
      insertRegistryNode('reg-survivor', 1_000);
      insertRegistryNode('reg-merged', 1_000, { mergedInto: 'reg-survivor' });

      expect(() =>
        assertTwinRefsVisible(
          getAdapter(),
          [
            { kind: 'registry', id: 'reg-merged' },
            { kind: 'registry', id: 'reg-survivor' },
          ],
          {}
        )
      ).not.toThrow();
    });

    it('applies the as_of bound to a batch of registry refs', () => {
      insertRegistryNode('reg-ok', 1_000);
      insertRegistryNode('reg-future', 5_000);

      expect(() =>
        assertTwinRefsVisible(
          getAdapter(),
          [
            { kind: 'registry', id: 'reg-ok' },
            { kind: 'registry', id: 'reg-future' },
          ],
          { asOfMs: 2_000 }
        )
      ).toThrow(/not visible/i);

      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'registry', id: 'reg-ok' }], {
          asOfMs: 2_000,
        })
      ).not.toThrow();
    });

    it('keeps report endpoints unscoped-only', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      insertOpaqueObjectEdge('edge_report_object', 'report');

      const unscoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        {}
      );
      expect(unscoped.map((edge) => edge.edge_id)).toEqual(['edge_report_object']);

      // A report endpoint carries no scope of its own, so a scoped read drops it.
      const scoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        { scopes: [{ kind: 'project', id: 'alpha' }] }
      );
      expect(scoped.map((edge) => edge.edge_id)).toEqual([]);
    });
  });
});
