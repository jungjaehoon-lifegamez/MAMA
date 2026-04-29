import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { normalizeEntityLabel } from '../../src/entities/normalization.js';
import { createEntityNode, attachEntityAlias } from '../../src/entities/store.js';
import {
  attachEntityAliasWithEdge,
  getGraphNeighborhood,
  getGraphTimeline,
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
    adapter.prepare('DELETE FROM connector_event_index').run();
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

    it('does not resolve preferred labels for entities created after as_of', async () => {
      await createEntityNode({
        id: 'entity_future_preferred_label',
        kind: 'project',
        preferred_label: 'Future Preferred Label',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(2_000, 2_000, 'entity_future_preferred_label');

      const historical = resolveEntity(getAdapter(), {
        label: 'Future Preferred Label',
        scopes: [{ kind: 'project', id: 'alpha' }],
        as_of_ms: 1_000,
      });
      expect(historical.entity).toBeNull();
      expect(historical.candidates).toHaveLength(0);

      const current = resolveEntity(getAdapter(), {
        label: 'Future Preferred Label',
        scopes: [{ kind: 'project', id: 'alpha' }],
        as_of_ms: 2_000,
      });
      expect(current.entity?.id).toBe('entity_future_preferred_label');
    });

    it('does not resolve aliases whose source refs are outside connector visibility', async () => {
      await createEntityNode({
        id: 'entity_alias_connector_filtered',
        kind: 'project',
        preferred_label: 'Alias Connector Filtered',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const discordRaw = insertScopedRaw({
        sourceId: 'raw-alias-discord',
        connector: 'discord',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const aliasInput = {
        entity_id: 'entity_alias_connector_filtered',
        label: 'Discord Only Alias',
        label_type: 'alt' as const,
        source_type: 'agent',
        source_ref: 'model_run:mr_alias_discord',
        agent_id: 'worker-m6',
        model_run_id: 'mr_alias_discord',
        envelope_hash: 'env_alias_discord',
        request_idempotency_key: 'alias-discord-key',
        source_refs: [{ kind: 'raw' as const, id: discordRaw }],
        scopes: [{ kind: 'project' as const, id: 'alpha' }],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      };

      attachEntityAliasWithEdge(getAdapter(), aliasInput);

      const hidden = resolveEntity(getAdapter(), {
        label: 'Discord Only Alias',
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });
      expect(hidden.entity).toBeNull();
      expect(hidden.candidates).toHaveLength(0);

      const visible = resolveEntity(getAdapter(), {
        label: 'Discord Only Alias',
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['discord'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });
      expect(visible.entity?.id).toBe('entity_alias_connector_filtered');
    });

    it('does not resolve observations whose raw provenance is outside project visibility', async () => {
      await createEntityNode({
        id: 'entity_observation_project_filtered',
        kind: 'project',
        preferred_label: 'Observation Project Filtered',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      insertScopedRaw({
        sourceId: 'raw-observation-beta',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'beta',
        tenantId: 'default',
      });
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_observations (
              id, observation_type, entity_kind_hint, surface_form, normalized_form,
              lang, script, context_summary, related_surface_forms, timestamp_observed,
              scope_kind, scope_id, extractor_version, embedding_model_version,
              source_connector, source_locator, source_raw_record_id, created_at
            ) VALUES (?, 'generic', 'project', ?, ?, 'en', 'Latn', ?, '[]', ?, 'project', ?,
              'history-extractor@v1', NULL, ?, NULL, ?, ?)
          `
        )
        .run(
          'obs_project_filtered',
          'Project Beta Codename',
          'project beta codename',
          'beta project observation',
          1_000,
          'alpha',
          'slack',
          'raw-observation-beta',
          1_000
        );
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_lineage_links (
              id, canonical_entity_id, entity_observation_id, source_entity_id,
              contribution_kind, run_id, candidate_id, review_action_id,
              status, capture_mode, confidence, created_at, superseded_at
            ) VALUES (?, ?, ?, NULL, 'seed', NULL, NULL, NULL, 'active', 'direct', 1, ?, NULL)
          `
        )
        .run(
          'lineage_project_filtered',
          'entity_observation_project_filtered',
          'obs_project_filtered',
          1_000
        );

      const hidden = resolveEntity(getAdapter(), {
        label: 'Project Beta Codename',
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });
      expect(hidden.entity).toBeNull();
      expect(hidden.candidates).toHaveLength(0);

      const visible = resolveEntity(getAdapter(), {
        label: 'Project Beta Codename',
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'beta' }],
        tenant_id: 'default',
      });
      expect(visible.entity?.id).toBe('entity_observation_project_filtered');
    });

    it('does not resolve observations missing raw provenance when project or tenant filters exist', async () => {
      await createEntityNode({
        id: 'entity_observation_missing_raw',
        kind: 'project',
        preferred_label: 'Observation Missing Raw',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_observations (
              id, observation_type, entity_kind_hint, surface_form, normalized_form,
              lang, script, context_summary, related_surface_forms, timestamp_observed,
              scope_kind, scope_id, extractor_version, embedding_model_version,
              source_connector, source_locator, source_raw_record_id, created_at
            ) VALUES (?, 'generic', 'project', ?, ?, 'en', 'Latn', ?, '[]', ?, 'project', ?,
              'history-extractor@v1', NULL, ?, NULL, ?, ?)
          `
        )
        .run(
          'obs_missing_raw',
          'Missing Raw Codename',
          'missing raw codename',
          'missing raw observation',
          1_000,
          'alpha',
          'slack',
          'raw-observation-missing',
          1_000
        );
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_lineage_links (
              id, canonical_entity_id, entity_observation_id, source_entity_id,
              contribution_kind, run_id, candidate_id, review_action_id,
              status, capture_mode, confidence, created_at, superseded_at
            ) VALUES (?, ?, ?, NULL, 'seed', NULL, NULL, NULL, 'active', 'direct', 1, ?, NULL)
          `
        )
        .run('lineage_missing_raw', 'entity_observation_missing_raw', 'obs_missing_raw', 1_000);

      const hidden = resolveEntity(getAdapter(), {
        label: 'Missing Raw Codename',
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });

      expect(hidden.entity).toBeNull();
      expect(hidden.candidates).toHaveLength(0);
    });

    it('surfaces merge-chain corruption while resolving candidates', async () => {
      await createEntityNode({
        id: 'entity_merge_cycle',
        kind: 'project',
        preferred_label: 'Merge Cycle Entity',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare('UPDATE entity_nodes SET merged_into = ? WHERE id = ?')
        .run('entity_merge_cycle', 'entity_merge_cycle');

      expect(() =>
        resolveEntity(getAdapter(), {
          label: 'Merge Cycle Entity',
          scopes: [{ kind: 'project', id: 'alpha' }],
        })
      ).toThrow(/merge_chain_cycle/i);
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
      getAdapter()
        .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(500, 500, 'entity_project_alpha');

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

    it('rejects seed refs that are newer than as_of', async () => {
      await createEntityNode({
        id: 'entity_future_seed',
        kind: 'project',
        preferred_label: 'Future Seed',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(2_000, 2_000, 'entity_future_seed');

      expect(() =>
        getGraphNeighborhood(getAdapter(), {
          ref: { kind: 'entity', id: 'entity_future_seed' },
          depth: 1,
          scopes: [{ kind: 'project', id: 'alpha' }],
          as_of_ms: 1_000,
        })
      ).toThrow(/not visible/i);
    });

    it('aggregates visible entity, memory, case, raw, and edge events in graph timeline', async () => {
      insertScopedMemory('mem-timeline-alpha', 'project', 'alpha');
      await createEntityNode({
        id: 'entity_timeline_alpha',
        kind: 'project',
        preferred_label: 'Timeline Alpha',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      getAdapter()
        .prepare('UPDATE entity_nodes SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(500, 500, 'entity_timeline_alpha');
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
        subjectKind: 'entity',
        subjectId: 'entity_timeline_alpha',
        objectKind: 'memory',
        objectId: 'mem-timeline-alpha',
        createdAt: 1_100,
      });
      insertEdge({
        edgeId: 'edge_timeline_raw',
        edgeType: 'derived_from',
        subjectKind: 'entity',
        subjectId: 'entity_timeline_alpha',
        objectKind: 'raw',
        objectId: rawId,
        createdAt: 1_300,
      });
      insertEdge({
        edgeId: 'edge_timeline_case',
        edgeType: 'case_member',
        subjectKind: 'entity',
        subjectId: 'entity_timeline_alpha',
        objectKind: 'case',
        objectId: 'case-timeline-alpha',
        createdAt: 1_500,
      });

      const timeline = getGraphTimeline(getAdapter(), {
        ref: { kind: 'entity', id: 'entity_timeline_alpha' },
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
        { kind: 'entity', id: 'entity_timeline_alpha' },
        { kind: 'memory', id: 'mem-timeline-alpha' },
        { kind: 'edge', id: 'edge_timeline_memory' },
        { kind: 'raw', id: rawId },
        { kind: 'edge', id: 'edge_timeline_raw' },
        { kind: 'case', id: 'case-timeline-alpha' },
        { kind: 'edge', id: 'edge_timeline_case' },
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
      const rawId = insertScopedRaw({
        sourceId: 'raw-alias-rollback',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      getAdapter()
        .prepare(
          `
            CREATE TEMP TRIGGER fail_alias_edge_insert
            BEFORE INSERT ON twin_edges
            WHEN NEW.edge_type = 'alias_of'
            BEGIN
              SELECT RAISE(ABORT, 'forced alias edge failure');
            END
          `
        )
        .run();

      expect(() =>
        attachEntityAliasWithEdge(getAdapter(), {
          entity_id: 'entity_person_alias_target',
          label: 'Broken Alias',
          label_type: 'alt',
          confidence: 0.8,
          source_type: 'agent',
          source_ref: 'model_run:mr_alias',
          agent_id: 'worker-m6',
          model_run_id: 'mr_alias',
          envelope_hash: 'env_alias',
          request_idempotency_key: 'alias-rollback-key',
          source_refs: [{ kind: 'raw', id: rawId }],
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          project_refs: [{ kind: 'project', id: 'alpha' }],
          tenant_id: 'default',
        })
      ).toThrow(/forced alias edge failure/i);

      const aliasCount = getAdapter()
        .prepare('SELECT COUNT(*) AS count FROM entity_aliases WHERE label = ?')
        .get('Broken Alias') as { count: number };
      expect(aliasCount.count).toBe(0);
      getAdapter().prepare('DROP TRIGGER fail_alias_edge_insert').run();
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
      const rawId = insertScopedRaw({
        sourceId: 'raw-alias-ok',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
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
        source_refs: [{ kind: 'raw', id: rawId }],
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
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
          source_refs: [{ kind: 'raw', id: rawId }],
        }),
      });
    });

    it('rejects agent alias writes without visible source refs', async () => {
      await createEntityNode({
        id: 'entity_person_alias_requires_sources',
        kind: 'person',
        preferred_label: 'Alias Requires Sources',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });

      expect(() =>
        attachEntityAliasWithEdge(getAdapter(), {
          entity_id: 'entity_person_alias_requires_sources',
          label: 'No Source Alias',
          source_type: 'agent',
          source_ref: 'model_run:mr_alias_no_source',
          agent_id: 'worker-m6',
          model_run_id: 'mr_alias_no_source',
          envelope_hash: 'env_alias_no_source',
          request_idempotency_key: 'alias-no-source-key',
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          project_refs: [{ kind: 'project', id: 'alpha' }],
          tenant_id: 'default',
        })
      ).toThrow(/source_refs/i);
    });

    it('persists visible alias source refs and rejects hidden source refs atomically', async () => {
      await createEntityNode({
        id: 'entity_person_alias_sources',
        kind: 'person',
        preferred_label: 'Alias Sources',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const slackRaw = insertScopedRaw({
        sourceId: 'raw-alias-slack-visible',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const discordRaw = insertScopedRaw({
        sourceId: 'raw-alias-discord-hidden',
        connector: 'discord',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });

      const result = attachEntityAliasWithEdge(getAdapter(), {
        entity_id: 'entity_person_alias_sources',
        label: 'Visible Source Alias',
        source_type: 'agent',
        source_ref: 'model_run:mr_alias_source_visible',
        agent_id: 'worker-m6',
        model_run_id: 'mr_alias_source_visible',
        envelope_hash: 'env_alias_source_visible',
        request_idempotency_key: 'alias-source-visible-key',
        source_refs: [{ kind: 'raw', id: slackRaw }],
        scopes: [{ kind: 'project', id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'alpha' }],
        tenant_id: 'default',
      });
      expect(result.edge.relation_attrs).toEqual(
        expect.objectContaining({
          source_refs: [{ kind: 'raw', id: slackRaw }],
        })
      );

      expect(() =>
        attachEntityAliasWithEdge(getAdapter(), {
          entity_id: 'entity_person_alias_sources',
          label: 'Hidden Source Alias',
          source_type: 'agent',
          source_ref: 'model_run:mr_alias_source_hidden',
          agent_id: 'worker-m6',
          model_run_id: 'mr_alias_source_hidden',
          envelope_hash: 'env_alias_source_hidden',
          request_idempotency_key: 'alias-source-hidden-key',
          source_refs: [{ kind: 'raw', id: discordRaw }],
          scopes: [{ kind: 'project', id: 'alpha' }],
          connectors: ['slack'],
          project_refs: [{ kind: 'project', id: 'alpha' }],
          tenant_id: 'default',
        })
      ).toThrow(/not visible/i);

      const hiddenCounts = getAdapter()
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM entity_aliases WHERE label = 'Hidden Source Alias') AS aliases,
              (SELECT COUNT(*) FROM twin_edges WHERE request_idempotency_key = 'alias-source-hidden-key') AS edges
          `
        )
        .get() as { aliases: number; edges: number };
      expect(hiddenCounts).toEqual({ aliases: 0, edges: 0 });
    });

    it('replays identical alias request keys and rejects changed canonical payloads', async () => {
      await createEntityNode({
        id: 'entity_person_alias_replay',
        kind: 'person',
        preferred_label: 'Alias Replay',
        status: 'active',
        scope_kind: 'project',
        scope_id: 'alpha',
        merged_into: null,
      });
      const rawId = insertScopedRaw({
        sourceId: 'raw-alias-replay',
        connector: 'slack',
        scopeKind: 'project',
        scopeId: 'alpha',
        projectId: 'alpha',
        tenantId: 'default',
      });
      const input = {
        entity_id: 'entity_person_alias_replay',
        label: 'Replay Alias',
        label_type: 'alt' as const,
        confidence: 0.9,
        source_type: 'agent',
        source_ref: 'model_run:mr_alias_replay',
        agent_id: 'worker-m6',
        model_run_id: 'mr_alias_replay',
        envelope_hash: 'env_alias_replay',
        request_idempotency_key: 'alias-replay-key',
        source_refs: [{ kind: 'raw' as const, id: rawId }],
        scopes: [{ kind: 'project' as const, id: 'alpha' }],
        connectors: ['slack'],
        project_refs: [{ kind: 'project' as const, id: 'alpha' }],
        tenant_id: 'default',
      };

      const first = attachEntityAliasWithEdge(getAdapter(), input);
      const replay = attachEntityAliasWithEdge(getAdapter(), input);

      expect(replay.alias.id).toBe(first.alias.id);
      expect(replay.edge.edge_id).toBe(first.edge.edge_id);
      expect(() => attachEntityAliasWithEdge(getAdapter(), { ...input, confidence: 0.7 })).toThrow(
        /conflicting/i
      );

      const counts = getAdapter()
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM entity_aliases) AS aliases,
              (SELECT COUNT(*) FROM twin_edges) AS edges
          `
        )
        .get() as { aliases: number; edges: number };
      expect(counts).toEqual({ aliases: 1, edges: 1 });
    });
  });
});
