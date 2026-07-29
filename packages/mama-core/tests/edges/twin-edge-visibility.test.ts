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

function insertEntityNode(id: string, kind: ScopeKind, scopeId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO entity_nodes (
          id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at
        )
        VALUES (?, 'project', ?, 'active', ?, ?, NULL, 1_000, 1_000)
      `
    )
    .run(id, id, kind, scopeId);
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

    it('keeps report endpoints unscoped-only while entity endpoints use entity scope', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      insertEntityNode('entity-1', 'project', 'alpha');
      insertOpaqueObjectEdge('edge_entity_object', 'entity');
      insertOpaqueObjectEdge('edge_report_object', 'report');

      const unscoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        {}
      );
      expect(unscoped.map((edge) => edge.edge_id)).toEqual([
        'edge_entity_object',
        'edge_report_object',
      ]);

      const scoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        { scopes: [{ kind: 'project', id: 'alpha' }] }
      );
      expect(scoped.map((edge) => edge.edge_id)).toEqual(['edge_entity_object']);
    });
  });
});
