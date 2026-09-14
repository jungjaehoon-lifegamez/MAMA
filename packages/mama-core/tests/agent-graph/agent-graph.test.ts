import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { getGraphNeighborhood, getGraphTimeline } from '../../src/agent-graph/index.js';
import {
  appendIdentityCorrection,
  readIdentityAssignments,
} from '../../src/registry/corrections.js';
import { createNode, currentIdentityRevision } from '../../src/registry/store.js';

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

function insertScopedRaw(input: {
  sourceId: string;
  connector: string;
  scopeKind: ScopeKind;
  scopeId: string;
  projectId?: string;
  tenantId?: string;
  eventDatetime?: number;
}): string {
  return upsertConnectorEventIndex(getAdapter(), {
    source_connector: input.connector,
    source_type: 'message',
    source_id: input.sourceId,
    content: `raw ${input.sourceId}`,
    event_datetime: input.eventDatetime ?? 1_000,
    memory_scope_kind: input.scopeKind,
    memory_scope_id: input.scopeId,
    project_id: input.projectId,
    tenant_id: input.tenantId,
  }).event_index_id;
}

function insertEdge(input: {
  edgeId: string;
  edgeType: string;
  subjectKind: string;
  subjectId: string;
  objectKind: string;
  objectId: string;
  createdAt: number;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO twin_edges (
          edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
          confidence, source, reason_text, content_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, 'code', 'fixture graph edge', ?, ?)
      `
    )
    .run(
      input.edgeId,
      input.edgeType,
      input.subjectKind,
      input.subjectId,
      input.objectKind,
      input.objectId,
      Buffer.alloc(32, input.edgeId.length),
      input.createdAt
    );
}

describe('Story M6.1: agent graph and entity resolution core', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-graph-core');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM registry_ref_assignments').run();
    adapter.prepare('DELETE FROM registry_corrections').run();
    adapter.prepare('DELETE FROM registry_aliases').run();
    adapter.prepare('DELETE FROM registry_scope_bindings').run();
    adapter.prepare('DELETE FROM registry_nodes').run();
    adapter.prepare('UPDATE registry_identity_state SET revision=0 WHERE singleton=1').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #2: graph traversal applies edge filters and as_of', () => {
    it('returns only visible entity edges matching edge_filters before as_of', async () => {
      insertScopedMemory('mem-visible-old', 'project', 'alpha');
      insertScopedMemory('mem-visible-new', 'project', 'alpha');
      insertScopedMemory('mem-hidden-beta', 'project', 'beta');
      const projectAlpha = createNode({
        kind: 'item',
        name: 'Project Alpha',
        scopes: [{ kind: 'project', id: 'alpha' }],
      });
      getAdapter()
        .prepare('UPDATE registry_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(500, 500, projectAlpha);

      insertEdge({
        edgeId: 'edge_old_mentions',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: projectAlpha,
        objectKind: 'memory',
        objectId: 'mem-visible-old',
        createdAt: 1_000,
      });
      insertEdge({
        edgeId: 'edge_new_mentions',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: projectAlpha,
        objectKind: 'memory',
        objectId: 'mem-visible-new',
        createdAt: 2_000,
      });
      insertEdge({
        edgeId: 'edge_hidden_beta',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: projectAlpha,
        objectKind: 'memory',
        objectId: 'mem-hidden-beta',
        createdAt: 900,
      });
      insertEdge({
        edgeId: 'edge_blocks',
        edgeType: 'blocks',
        subjectKind: 'registry',
        subjectId: projectAlpha,
        objectKind: 'memory',
        objectId: 'mem-visible-old',
        createdAt: 800,
      });

      const graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'registry', id: projectAlpha },
        depth: 1,
        scopes: [{ kind: 'project', id: 'alpha' }],
        edge_filters: { edge_types: ['mentions'] },
        as_of_ms: 1_500,
      });

      expect(graph.edges.map((edge) => edge.edge_id)).toEqual(['edge_old_mentions']);
      expect(graph.nodes).toEqual([
        { kind: 'registry', id: projectAlpha },
        { kind: 'memory', id: 'mem-visible-old' },
      ]);
    });

    it('rejects seed refs that are newer than as_of', async () => {
      // A memory seed, not a registry one: registry visibility does not apply
      // as_of at all (ref-validation resolves registry refs by scope only), so a
      // registry seed would not exercise the time boundary this asserts.
      insertScopedMemory('mem-future-seed', 'project', 'alpha');
      getAdapter()
        .prepare('UPDATE decisions SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(2_000, 2_000, 'mem-future-seed');

      expect(() =>
        getGraphNeighborhood(getAdapter(), {
          ref: { kind: 'memory', id: 'mem-future-seed' },
          depth: 1,
          scopes: [{ kind: 'project', id: 'alpha' }],
          as_of_ms: 1_000,
        })
      ).toThrow(/not visible/i);
    });

    // The seed's own identity node no longer appears as a timeline event. The
    // entity substrate emitted one from entity_nodes.created_at; registry nodes
    // have no such branch, and the design builds the item timeline from records
    // and observations instead. Recorded as a gap for the knowledge/graph-query
    // work, not papered over here.
    it('aggregates visible memory, case, raw, and edge events in graph timeline', async () => {
      insertScopedMemory('mem-timeline-alpha', 'project', 'alpha');
      const timelineAlpha = createNode({
        kind: 'item',
        name: 'Timeline Alpha',
        scopes: [{ kind: 'project', id: 'alpha' }],
      });
      getAdapter()
        .prepare('UPDATE registry_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(500, 500, timelineAlpha);
      const rawId = insertScopedRaw({
        sourceId: 'raw-timeline-alpha',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
        eventDatetime: 1_200,
      });
      getAdapter()
        .prepare(
          `
            INSERT INTO case_truth (
              case_id, title, status, scope_refs, created_at, updated_at
            ) VALUES (?, ?, 'active', ?, ?, ?)
          `
        )
        .run(
          'case-timeline-alpha',
          'Timeline Case',
          JSON.stringify([{ kind: 'project', id: 'alpha' }]),
          new Date(1_400).toISOString(),
          new Date(1_400).toISOString()
        );
      insertEdge({
        edgeId: 'edge_timeline_memory',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: timelineAlpha,
        objectKind: 'memory',
        objectId: 'mem-timeline-alpha',
        createdAt: 1_100,
      });
      insertEdge({
        edgeId: 'edge_timeline_raw',
        edgeType: 'derived_from',
        subjectKind: 'registry',
        subjectId: timelineAlpha,
        objectKind: 'raw',
        objectId: rawId,
        createdAt: 1_300,
      });
      insertEdge({
        edgeId: 'edge_timeline_case',
        edgeType: 'case_member',
        subjectKind: 'registry',
        subjectId: timelineAlpha,
        objectKind: 'case',
        objectId: 'case-timeline-alpha',
        createdAt: 1_500,
      });

      const timeline = getGraphTimeline(getAdapter(), {
        ref: { kind: 'registry', id: timelineAlpha },
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });
      const summary = timeline.events.map((event) => {
        const record = event as unknown as {
          kind: string;
          edge?: { edge_id: string };
          ref?: { id: string };
        };
        return {
          kind: record.kind,
          id: record.kind === 'edge' ? String(record.edge?.edge_id) : String(record.ref?.id),
        };
      });

      expect(summary).toEqual([
        { kind: 'memory', id: 'mem-timeline-alpha' },
        { kind: 'edge', id: 'edge_timeline_memory' },
        { kind: 'raw', id: rawId },
        { kind: 'edge', id: 'edge_timeline_raw' },
        { kind: 'case', id: 'case-timeline-alpha' },
        { kind: 'edge', id: 'edge_timeline_case' },
      ]);
    });
  });

  describe('PR3B current identity projection', () => {
    it('keeps original graph refs and projects assignment, revocation, and merge separately', () => {
      const scope = { kind: 'project' as const, id: 'graph-projection' };
      const trusted = {
        principalId: 'principal-graph',
        agentId: 'agent-graph',
        scopes: [scope],
        connectors: [],
      };
      const originalFrom = createNode({ kind: 'item', name: 'original from', scopes: [scope] });
      const originalTo = createNode({ kind: 'item', name: 'original to', scopes: [scope] });
      const assigned = createNode({ kind: 'item', name: 'assigned current', scopes: [scope] });
      insertEdge({
        edgeId: 'edge-projection',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: originalFrom,
        objectKind: 'registry',
        objectId: originalTo,
        createdAt: 1,
      });

      appendIdentityCorrection(
        getAdapter(),
        {
          commandId: 'projection-assigned',
          expectedRevision: currentIdentityRevision(),
          reason: 'explicit assignment',
          operation: 'assign_refs',
          parentId: originalFrom,
          assignments: [{ edgeId: 'edge-projection', endpoint: 'from', targetNodeId: assigned }],
          scopes: [scope],
        },
        trusted
      );
      let graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'registry', id: originalFrom },
        scopes: [scope],
        principal_id: trusted.principalId,
        agent_id: trusted.agentId,
      });
      expect(graph.edges[0]?.subject_ref).toEqual({ kind: 'registry', id: originalFrom });
      expect(graph.current_projection).toContainEqual({
        edge_id: 'edge-projection',
        endpoint: 'from',
        original_ref: { kind: 'registry', id: originalFrom },
        current_ref: { kind: 'registry', id: assigned },
      });

      const assignedSurvivor = createNode({
        kind: 'item',
        name: 'assigned survivor',
        scopes: [scope],
      });
      appendIdentityCorrection(
        getAdapter(),
        {
          commandId: 'projection-assigned-merge',
          expectedRevision: currentIdentityRevision(),
          reason: 'assigned identity merged',
          operation: 'merge',
          survivorId: assignedSurvivor,
          memberIds: [assigned],
          scopes: [scope],
        },
        trusted
      );
      graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'registry', id: originalFrom },
        scopes: [scope],
        principal_id: trusted.principalId,
        agent_id: trusted.agentId,
      });
      expect(graph.current_projection).toContainEqual({
        edge_id: 'edge-projection',
        endpoint: 'from',
        original_ref: { kind: 'registry', id: originalFrom },
        current_ref: { kind: 'registry', id: assignedSurvivor },
      });

      appendIdentityCorrection(
        getAdapter(),
        {
          commandId: 'projection-unresolved',
          expectedRevision: currentIdentityRevision(),
          reason: 'identity revoked',
          operation: 'assign_refs',
          parentId: originalFrom,
          assignments: [{ edgeId: 'edge-projection', endpoint: 'from', targetNodeId: null }],
          scopes: [scope],
        },
        trusted
      );
      graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'registry', id: originalFrom },
        scopes: [scope],
        principal_id: trusted.principalId,
        agent_id: trusted.agentId,
      });
      expect(graph.current_projection).toContainEqual({
        edge_id: 'edge-projection',
        endpoint: 'from',
        original_ref: { kind: 'registry', id: originalFrom },
        current_ref: null,
      });
      expect(readIdentityAssignments('edge-projection')[0]?.resolvedRef).toBeNull();

      const mergeFrom = createNode({ kind: 'item', name: 'merge from', scopes: [scope] });
      const mergeInto = createNode({ kind: 'item', name: 'merge into', scopes: [scope] });
      insertEdge({
        edgeId: 'edge-merge',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: mergeFrom,
        objectKind: 'registry',
        objectId: originalTo,
        createdAt: 2,
      });
      appendIdentityCorrection(
        getAdapter(),
        {
          commandId: 'projection-merge',
          expectedRevision: currentIdentityRevision(),
          reason: 'same identity',
          operation: 'merge',
          survivorId: mergeInto,
          memberIds: [mergeFrom],
          scopes: [scope],
        },
        trusted
      );
      getAdapter().prepare('DELETE FROM registry_scope_bindings WHERE node_id = ?').run(mergeInto);
      graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'registry', id: mergeFrom },
        scopes: [scope],
        principal_id: trusted.principalId,
        agent_id: trusted.agentId,
      });
      expect(graph.current_projection).toContainEqual({
        edge_id: 'edge-merge',
        endpoint: 'from',
        original_ref: { kind: 'registry', id: mergeFrom },
        current_ref: null,
      });
      expect(JSON.stringify(graph.current_projection)).not.toContain(mergeInto);
    });

    it('batches current identity assignment, merge, and visibility reads for 100 edges', () => {
      const scope = { kind: 'project' as const, id: 'graph-batch' };
      const anchor = createNode({ kind: 'item', name: 'batch anchor', scopes: [scope] });
      for (let index = 0; index < 100; index += 1) {
        const endpoint = createNode({
          kind: 'item',
          name: `batch endpoint ${index}`,
          scopes: [scope],
        });
        insertEdge({
          edgeId: `edge-batch-${index}`,
          edgeType: 'mentions',
          subjectKind: 'registry',
          subjectId: anchor,
          objectKind: 'registry',
          objectId: endpoint,
          createdAt: index + 1,
        });
      }
      const adapter = getAdapter();
      const originalPrepare = adapter.prepare.bind(adapter);
      let projectionQueries = 0;
      adapter.prepare = ((sql: string) => {
        if (
          sql.includes('FROM registry_ref_assignments assignment') ||
          sql.includes('WITH RECURSIVE registry_chain') ||
          sql.includes('SELECT DISTINCT node_id FROM registry_scope_bindings')
        ) {
          projectionQueries += 1;
        }
        return originalPrepare(sql);
      }) as typeof adapter.prepare;
      try {
        const graph = getGraphNeighborhood(adapter, {
          ref: { kind: 'registry', id: anchor },
          scopes: [scope],
          principal_id: 'principal-batch',
          agent_id: 'agent-batch',
          limit: 100,
        });
        expect(graph.edges).toHaveLength(100);
        expect(graph.current_projection).toHaveLength(200);
        expect(projectionQueries).toBe(5);
      } finally {
        adapter.prepare = originalPrepare;
      }
    });

    it('keeps total visibility queries bounded for 100 mixed current endpoints', async () => {
      const scope = { kind: 'project' as const, id: 'graph-mixed-batch' };
      const anchor = createNode({ kind: 'item', name: 'mixed batch anchor', scopes: [scope] });
      for (let index = 0; index < 100; index += 1) {
        const kind = index % 5;
        let objectKind: 'raw' | 'observation' | 'memory' | 'case' | 'registry';
        let objectId: string;
        if (kind === 0 || kind === 1) {
          const rawId = insertScopedRaw({
            sourceId: `mixed-raw-${index}`,
            connector: 'slack',
            scopeKind: 'project',
            scopeId: scope.id,
            eventDatetime: 1_000 + index,
          });
          if (kind === 0) {
            objectKind = 'raw';
            objectId = rawId;
          } else {
            objectKind = 'observation';
            objectId = (
              getAdapter()
                .prepare(
                  'SELECT current_observation_id FROM connector_event_index WHERE event_index_id = ?'
                )
                .get(rawId) as { current_observation_id: string }
            ).current_observation_id;
          }
        } else if (kind === 2) {
          objectKind = 'memory';
          objectId = `mixed-memory-${index}`;
          insertScopedMemory(objectId, scope.kind, scope.id);
        } else if (kind === 3) {
          objectKind = 'case';
          objectId = `mixed-case-${index}`;
          getAdapter()
            .prepare(
              `INSERT INTO case_truth
                 (case_id, title, status, scope_refs, created_at, updated_at)
               VALUES (?, ?, 'active', ?, ?, ?)`
            )
            .run(
              objectId,
              `Mixed case ${index}`,
              JSON.stringify([scope]),
              new Date(1_000 + index).toISOString(),
              new Date(1_000 + index).toISOString()
            );
        } else {
          objectKind = 'registry';
          objectId = createNode({
            kind: 'item',
            name: `Mixed item ${index}`,
            scopes: [scope],
          });
        }
        insertEdge({
          edgeId: `edge-mixed-${index}`,
          edgeType: 'mentions',
          subjectKind: 'registry',
          subjectId: anchor,
          objectKind,
          objectId,
          createdAt: 2_000 + index,
        });
      }
      const adapter = getAdapter();
      const originalPrepare = adapter.prepare.bind(adapter);
      let queryCount = 0;
      adapter.prepare = ((sql: string) => {
        queryCount += 1;
        return originalPrepare(sql);
      }) as typeof adapter.prepare;
      try {
        const graph = getGraphNeighborhood(adapter, {
          ref: { kind: 'registry', id: anchor },
          scopes: [scope],
          connectors: ['slack'],
          principal_id: 'principal-mixed-batch',
          agent_id: 'agent-mixed-batch',
          limit: 100,
        });
        expect(graph.edges).toHaveLength(100);
        expect(graph.current_projection).toHaveLength(200);
        expect(queryCount).toBeLessThanOrEqual(30);
      } finally {
        adapter.prepare = originalPrepare;
      }
    });

    it('batches recursive edge visibility with hidden and cyclic endpoints', () => {
      const scope = { kind: 'project' as const, id: 'graph-edge-recursive' };
      const hiddenScope = { kind: 'project' as const, id: 'graph-edge-hidden' };
      const anchor = createNode({ kind: 'item', name: 'recursive anchor', scopes: [scope] });
      const innerSubject = createNode({
        kind: 'item',
        name: 'recursive inner subject',
        scopes: [scope],
      });
      insertScopedMemory('recursive-visible-memory', scope.kind, scope.id);
      insertScopedMemory('recursive-hidden-memory', hiddenScope.kind, hiddenScope.id);
      insertEdge({
        edgeId: 'recursive-visible-inner',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: innerSubject,
        objectKind: 'memory',
        objectId: 'recursive-visible-memory',
        createdAt: 10,
      });
      insertEdge({
        edgeId: 'recursive-hidden-inner',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: innerSubject,
        objectKind: 'memory',
        objectId: 'recursive-hidden-memory',
        createdAt: 11,
      });
      insertEdge({
        edgeId: 'recursive-cycle-a',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: innerSubject,
        objectKind: 'edge',
        objectId: 'recursive-cycle-b',
        createdAt: 12,
      });
      insertEdge({
        edgeId: 'recursive-cycle-b',
        edgeType: 'mentions',
        subjectKind: 'registry',
        subjectId: innerSubject,
        objectKind: 'edge',
        objectId: 'recursive-cycle-a',
        createdAt: 13,
      });
      for (const [suffix, target] of [
        ['visible', 'recursive-visible-inner'],
        ['hidden', 'recursive-hidden-inner'],
        ['cycle', 'recursive-cycle-a'],
      ]) {
        insertEdge({
          edgeId: `recursive-outer-${suffix}`,
          edgeType: 'mentions',
          subjectKind: 'registry',
          subjectId: anchor,
          objectKind: 'edge',
          objectId: target,
          createdAt: 20,
        });
      }
      const adapter = getAdapter();
      const originalPrepare = adapter.prepare.bind(adapter);
      let queryCount = 0;
      adapter.prepare = ((sql: string) => {
        queryCount += 1;
        return originalPrepare(sql);
      }) as typeof adapter.prepare;
      try {
        const graph = getGraphNeighborhood(adapter, {
          ref: { kind: 'registry', id: anchor },
          scopes: [scope],
          principal_id: 'principal-recursive',
          agent_id: 'agent-recursive',
          as_of_ms: 2_500,
          limit: 100,
        });
        expect(graph.edges.map((edge) => edge.edge_id)).toEqual(['recursive-outer-visible']);
        expect(graph.current_projection).toContainEqual({
          edge_id: 'recursive-outer-visible',
          endpoint: 'to',
          original_ref: { kind: 'edge', id: 'recursive-visible-inner' },
          current_ref: { kind: 'edge', id: 'recursive-visible-inner' },
        });
        expect(
          graph.current_projection.filter(
            (projection) =>
              projection.original_ref.kind === 'edge' &&
              ['recursive-hidden-inner', 'recursive-cycle-a'].includes(projection.original_ref.id)
          )
        ).toEqual([]);
        expect(queryCount).toBeLessThanOrEqual(20);
      } finally {
        adapter.prepare = originalPrepare;
      }
    });

    it('rejects an unsupported root reference kind explicitly', () => {
      expect(() =>
        getGraphNeighborhood(getAdapter(), {
          ref: { kind: 'unknown', id: 'synthetic-unknown-ref' } as never,
        })
      ).toThrow(/unsupported|invalid/i);
    });

    it('rejects a raw root with a dangling current observation ref', () => {
      const rawId = insertScopedRaw({
        sourceId: 'dangling-graph-observation',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'graph-dangling',
      });
      const adapter = getAdapter();
      adapter.exec('PRAGMA foreign_keys = OFF');
      adapter
        .prepare(
          'UPDATE connector_event_index SET current_observation_id = ? WHERE event_index_id = ?'
        )
        .run('obs-missing-graph', rawId);
      adapter.exec('PRAGMA foreign_keys = ON');

      expect(() =>
        getGraphNeighborhood(adapter, {
          ref: { kind: 'raw', id: rawId },
          scopes: [{ kind: 'project', id: 'graph-dangling' }],
          connectors: ['slack'],
        })
      ).toThrow(/dangling current observation/i);
    });
  });
});
