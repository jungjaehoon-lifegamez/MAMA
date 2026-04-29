import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import {
  assertTwinRefsVisible,
  assertTwinRefsVisibleToScopes,
  listVisibleTwinEdgesForRefs,
} from '../../src/edges/ref-validation.js';
import { insertTwinEdge } from '../../src/edges/store.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

type ScopeKind = 'project' | 'user' | 'channel' | 'global';

function insertScopedMemory(id: string, kind: ScopeKind, externalId: string): void {
  const adapter = getAdapter();
  const scopeId = `scope_${kind}_${externalId}`;
  adapter
    .prepare(
      `
        INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, `topic-${id}`, `decision-${id}`, `reasoning-${id}`, 0.8, 1_000, 1_000);
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

function insertScopedRaw(
  sourceId: string,
  kind: ScopeKind,
  scopeId: string,
  overrides: {
    source_connector?: string;
    project_id?: string;
    tenant_id?: string;
  } = {}
): string {
  return upsertConnectorEventIndex(getAdapter(), {
    source_connector: overrides.source_connector ?? 'slack',
    source_type: 'message',
    source_id: sourceId,
    content: `raw ${sourceId}`,
    event_datetime: 1_000,
    memory_scope_kind: kind,
    memory_scope_id: scopeId,
    project_id: overrides.project_id,
    tenant_id: overrides.tenant_id,
  }).event_index_id;
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
    it('rejects an edge endpoint when a raw object is outside the requested scope', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const betaRaw = insertScopedRaw('raw-beta', 'project', 'beta');

      expect(() =>
        assertTwinRefsVisibleToScopes(
          getAdapter(),
          [
            { kind: 'memory', id: 'mem-alpha' },
            { kind: 'raw', id: betaRaw },
          ],
          [{ kind: 'project', id: 'alpha' }]
        )
      ).toThrow(/not visible/i);
    });

    it('excludes edges whose subject or object endpoint is outside requested scopes', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const alphaRaw = insertScopedRaw('raw-alpha', 'project', 'alpha');
      const betaRaw = insertScopedRaw('raw-beta', 'project', 'beta');

      const visible = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: alphaRaw },
        source: 'code',
        reason_text: 'connector replay',
      });
      insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: betaRaw },
        source: 'code',
        reason_text: 'connector replay',
      });

      const scoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        { scopes: [{ kind: 'project', id: 'alpha' }] }
      );
      expect(scoped.map((edge) => edge.edge_id)).toEqual([visible.edge_id]);

      const unscoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        {}
      );
      // Matches existing mama-core read behavior: empty scopes mean no scope filter.
      expect(unscoped).toHaveLength(2);
    });

    it('excludes raw endpoints outside requested connector, project, and tenant visibility', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const visibleRaw = insertScopedRaw('raw-visible', 'project', 'alpha', {
        source_connector: 'slack',
        project_id: 'alpha',
        tenant_id: 'default',
      });
      const discordRaw = insertScopedRaw('raw-discord', 'project', 'alpha', {
        source_connector: 'discord',
        project_id: 'alpha',
        tenant_id: 'default',
      });
      const betaProjectRaw = insertScopedRaw('raw-beta-project', 'project', 'alpha', {
        source_connector: 'slack',
        project_id: 'beta',
        tenant_id: 'default',
      });
      const otherTenantRaw = insertScopedRaw('raw-other-tenant', 'project', 'alpha', {
        source_connector: 'slack',
        project_id: 'alpha',
        tenant_id: 'other-tenant',
      });

      const visible = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: visibleRaw },
        source: 'code',
        reason_text: 'connector replay',
      });
      for (const rawId of [discordRaw, betaProjectRaw, otherTenantRaw]) {
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-alpha' },
          object_ref: { kind: 'raw', id: rawId },
          source: 'code',
          reason_text: 'connector replay',
        });
      }

      const scoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        {
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          projectRefs: [{ kind: 'project', id: 'alpha' }],
          tenantId: 'default',
        }
      );
      expect(scoped.map((edge) => edge.edge_id)).toEqual([visible.edge_id]);

      expect(() =>
        assertTwinRefsVisibleToScopes(
          getAdapter(),
          [{ kind: 'raw', id: discordRaw }],
          [{ kind: 'project', id: 'alpha' }]
        )
      ).not.toThrow();
    });

    it('fails closed for raw endpoints missing project or tenant metadata when filters exist', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const nullProjectRaw = insertScopedRaw('raw-null-project', 'project', 'alpha', {
        source_connector: 'slack',
        tenant_id: 'default',
      });
      const nullTenantRaw = insertScopedRaw('raw-null-tenant', 'project', 'alpha', {
        source_connector: 'slack',
        project_id: 'alpha',
      });
      const visibleRaw = insertScopedRaw('raw-visible-required-fields', 'project', 'alpha', {
        source_connector: 'slack',
        project_id: 'alpha',
        tenant_id: 'default',
      });
      const visible = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: visibleRaw },
        source: 'code',
        reason_text: 'connector replay',
      });
      for (const rawId of [nullProjectRaw, nullTenantRaw]) {
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-alpha' },
          object_ref: { kind: 'raw', id: rawId },
          source: 'code',
          reason_text: 'connector replay',
        });
      }

      const scoped = listVisibleTwinEdgesForRefs(
        getAdapter(),
        [{ kind: 'memory', id: 'mem-alpha' }],
        {
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          projectRefs: [{ kind: 'project', id: 'alpha' }],
          tenantId: 'default',
        }
      );

      expect(scoped.map((edge) => edge.edge_id)).toEqual([visible.edge_id]);
      expect(() =>
        assertTwinRefsVisible(getAdapter(), [{ kind: 'raw', id: nullProjectRaw }], {
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          projectRefs: [{ kind: 'project', id: 'alpha' }],
          tenantId: 'default',
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

    it('recursively validates edge refs by checking the referenced edge endpoints', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const alphaRaw = insertScopedRaw('raw-alpha', 'project', 'alpha');
      const betaRaw = insertScopedRaw('raw-beta', 'project', 'beta');

      const innerVisible = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: alphaRaw },
        source: 'code',
        reason_text: 'connector replay',
      });
      const innerHidden = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: betaRaw },
        source: 'code',
        reason_text: 'connector replay',
      });

      expect(() =>
        assertTwinRefsVisibleToScopes(
          getAdapter(),
          [{ kind: 'edge', id: innerVisible.edge_id }],
          [{ kind: 'project', id: 'alpha' }]
        )
      ).not.toThrow();
      expect(() =>
        assertTwinRefsVisibleToScopes(
          getAdapter(),
          [{ kind: 'edge', id: innerHidden.edge_id }],
          [{ kind: 'project', id: 'alpha' }]
        )
      ).toThrow(/not visible/i);
    });

    it('does not mark a sibling branch cyclic when both branches share a nested edge', () => {
      insertScopedMemory('mem-alpha', 'project', 'alpha');
      const alphaRaw = insertScopedRaw('raw-alpha', 'project', 'alpha');

      const sharedNested = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'raw', id: alphaRaw },
        source: 'code',
        reason_text: 'connector replay',
      });
      const leftBranch = insertTwinEdge(getAdapter(), {
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'edge', id: sharedNested.edge_id },
        source: 'code',
        reason_text: 'left branch',
      });
      const rightBranch = insertTwinEdge(getAdapter(), {
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-alpha' },
        object_ref: { kind: 'edge', id: sharedNested.edge_id },
        source: 'code',
        reason_text: 'right branch',
      });
      const root = insertTwinEdge(getAdapter(), {
        edge_type: 'synthesizes',
        subject_ref: { kind: 'edge', id: leftBranch.edge_id },
        object_ref: { kind: 'edge', id: rightBranch.edge_id },
        source: 'code',
        reason_text: 'shared nested edge stays visible across sibling branches',
      });

      expect(() =>
        assertTwinRefsVisibleToScopes(
          getAdapter(),
          [{ kind: 'edge', id: root.edge_id }],
          [{ kind: 'project', id: 'alpha' }]
        )
      ).not.toThrow();
    });
  });
});
