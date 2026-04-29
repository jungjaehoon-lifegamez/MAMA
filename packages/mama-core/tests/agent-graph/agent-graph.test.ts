import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { normalizeEntityLabel } from '../../src/entities/normalization.js';
import { createEntityNode, attachEntityAlias } from '../../src/entities/store.js';
import {
  attachEntityAliasWithEdge,
  getGraphNeighborhood,
  resolveEntity,
} from '../../src/agent-graph/index.js';

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

async function seedAlias(entityId: string, label: string, aliasId: string): Promise<void> {
  const normalized = normalizeEntityLabel(label);
  await attachEntityAlias({
    id: aliasId,
    entity_id: entityId,
    label,
    normalized_label: normalized.normalized,
    lang: normalized.script === 'Hang' ? 'ko' : normalized.script === 'Jpan' ? 'ja' : 'en',
    script: normalized.script,
    label_type: 'alt',
    source_type: 'fixture',
    source_ref: 'fixture:m6',
    confidence: 0.95,
    status: 'active',
  });
}

describe('Story M6.1: agent graph and entity resolution core', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('agent-graph-core');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM entity_lineage_links').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM memory_scopes').run();
    adapter.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: multilingual aliases resolve to one visible canonical entity', () => {
    it('resolves Korean, English, and Japanese labels to the same scoped entity', async () => {
      await createEntityNode({
        id: 'entity_person_jaehoon',
        kind: 'person',
        preferred_label: 'Jaehoon Jung',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      await seedAlias('entity_person_jaehoon', '\uC815\uC7AC\uD6C8', 'alias_jaehoon_ko');
      await seedAlias('entity_person_jaehoon', '\u30B8\u30A7\u30D5\u30F3', 'alias_jaehoon_ja');

      for (const label of ['Jaehoon Jung', '\uC815\uC7AC\uD6C8', '\u30B8\u30A7\u30D5\u30F3']) {
        const resolved = resolveEntity(getAdapter(), {
          label,
          scopes: [{ kind: 'project', id: 'alpha' }],
        });
        expect(resolved.entity?.id).toBe('entity_person_jaehoon');
      }

      const outsideScope = resolveEntity(getAdapter(), {
        label: '\uC815\uC7AC\uD6C8',
        scopes: [{ kind: 'project', id: 'beta' }],
      });
      expect(outsideScope.entity).toBeNull();
      expect(outsideScope.candidates).toHaveLength(0);
    });
  });

  describe('AC #2: graph traversal applies edge filters and as_of', () => {
    it('returns only visible entity edges matching edge_filters before as_of', async () => {
      insertScopedMemory('mem-visible-old', 'project', 'alpha');
      insertScopedMemory('mem-visible-new', 'project', 'alpha');
      insertScopedMemory('mem-hidden-beta', 'project', 'beta');
      await createEntityNode({
        id: 'entity_project_alpha',
        kind: 'project',
        preferred_label: 'Project Alpha',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });

      insertEdge({
        edgeId: 'edge_old_mentions',
        edgeType: 'mentions',
        subjectKind: 'entity',
        subjectId: 'entity_project_alpha',
        objectKind: 'memory',
        objectId: 'mem-visible-old',
        createdAt: 1_000,
      });
      insertEdge({
        edgeId: 'edge_new_mentions',
        edgeType: 'mentions',
        subjectKind: 'entity',
        subjectId: 'entity_project_alpha',
        objectKind: 'memory',
        objectId: 'mem-visible-new',
        createdAt: 2_000,
      });
      insertEdge({
        edgeId: 'edge_hidden_beta',
        edgeType: 'mentions',
        subjectKind: 'entity',
        subjectId: 'entity_project_alpha',
        objectKind: 'memory',
        objectId: 'mem-hidden-beta',
        createdAt: 900,
      });
      insertEdge({
        edgeId: 'edge_blocks',
        edgeType: 'blocks',
        subjectKind: 'entity',
        subjectId: 'entity_project_alpha',
        objectKind: 'memory',
        objectId: 'mem-visible-old',
        createdAt: 800,
      });

      const graph = getGraphNeighborhood(getAdapter(), {
        ref: { kind: 'entity', id: 'entity_project_alpha' },
        depth: 1,
        scopes: [{ kind: 'project', id: 'alpha' }],
        edge_filters: { edge_types: ['mentions'] },
        as_of_ms: 1_500,
      });

      expect(graph.edges.map((edge) => edge.edge_id)).toEqual(['edge_old_mentions']);
      expect(graph.nodes).toEqual([
        { kind: 'entity', id: 'entity_project_alpha' },
        { kind: 'memory', id: 'mem-visible-old' },
      ]);
    });
  });

  describe('AC #3: alias writes are atomic with alias_of edge provenance', () => {
    it('rolls back the alias row when the alias_of edge cannot be written', async () => {
      await createEntityNode({
        id: 'entity_person_alias_target',
        kind: 'person',
        preferred_label: 'Alias Target',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });

      expect(() =>
        attachEntityAliasWithEdge(getAdapter(), {
          entity_id: 'entity_person_alias_target',
          label: 'Broken Alias',
          label_type: 'alt',
          confidence: 2,
          source_type: 'agent',
          source_ref: 'model_run:mr_alias',
          agent_id: 'worker-m6',
          model_run_id: 'mr_alias',
          envelope_hash: 'env_alias',
          scopes: [{ kind: 'project', id: 'alpha' }],
        })
      ).toThrow(/confidence/i);

      const aliasCount = getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM entity_aliases WHERE label = ?')
        .get('Broken Alias') as { count: number };
      expect(aliasCount.count).toBe(0);
    });

    it('writes an active alias and an alias_of edge in one transaction', async () => {
      await createEntityNode({
        id: 'entity_person_alias_ok',
        kind: 'person',
        preferred_label: 'Alias OK',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });

      const result = attachEntityAliasWithEdge(getAdapter(), {
        entity_id: 'entity_person_alias_ok',
        label: '\uC815\uC7AC\uD6C8',
        label_type: 'alt',
        source_type: 'agent',
        source_ref: 'model_run:mr_alias_ok',
        agent_id: 'worker-m6',
        model_run_id: 'mr_alias_ok',
        envelope_hash: 'env_alias_ok',
        edge_idempotency_key: 'alias-edge-key',
        scopes: [{ kind: 'project', id: 'alpha' }],
      });

      expect(result.alias).toEqual(
        expect.objectContaining({
          entity_id: 'entity_person_alias_ok',
          label: '\uC815\uC7AC\uD6C8',
          normalized_label: '\uC815\uC7AC\uD6C8',
          confidence: 1,
          status: 'active',
        })
      );
      expect(result.edge).toMatchObject({
        edge_type: 'alias_of',
        subject_ref: { kind: 'entity', id: 'entity_person_alias_ok' },
        object_ref: { kind: 'entity', id: 'entity_person_alias_ok' },
        source: 'agent',
        model_run_id: 'mr_alias_ok',
        envelope_hash: 'env_alias_ok',
        relation_attrs: expect.objectContaining({
          alias_id: result.alias.id,
          label: '\uC815\uC7AC\uD6C8',
        }),
      });
    });
  });
});
