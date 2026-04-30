import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import {
  buildAgentSituationPacketRecord,
  listVisibleAgentSituationSources,
} from '../../src/agent-situation/builder.js';
import type { AgentSituationEffectiveFilters } from '../../src/agent-situation/types.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

const EFFECTIVE_FILTERS: AgentSituationEffectiveFilters = {
  connectors: ['slack'],
  scopes: [{ kind: 'project', id: 'repo-a' }],
  project_refs: [{ kind: 'project', id: 'repo-a' }],
  tenant_id: 'default',
  as_of: null,
};

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-agent-situation-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

function cleanupDb(path: string): void {
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function createAdapter(): DatabaseAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

function seedFixture(adapter: DatabaseAdapter): void {
  adapter
    .prepare(
      `INSERT INTO connector_event_index (
        event_index_id, source_connector, source_type, source_id, source_locator, channel,
        author, title, content, event_datetime, event_date, source_timestamp_ms, metadata_json,
        artifact_locator, artifact_title, content_hash, indexed_at, updated_at, tenant_id,
        project_id, memory_scope_kind, memory_scope_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'raw-visible',
      'slack',
      'message',
      's1',
      'slack://c1/s1',
      'chan-1',
      'JH',
      'Deploy review',
      'Blocked until deploy review is complete',
      1_700,
      '2026-04-29',
      1_700,
      '{}',
      null,
      null,
      Buffer.alloc(32, 1),
      '2026-04-29T00:00:00.000Z',
      '2026-04-29T00:00:00.000Z',
      'default',
      'repo-a',
      'project',
      'repo-a'
    );
  adapter
    .prepare(
      `INSERT INTO connector_event_index (
        event_index_id, source_connector, source_type, source_id, source_locator, channel,
        author, title, content, event_datetime, event_date, source_timestamp_ms, metadata_json,
        artifact_locator, artifact_title, content_hash, indexed_at, updated_at, tenant_id,
        project_id, memory_scope_kind, memory_scope_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'raw-hidden-project',
      'slack',
      'message',
      's2',
      'slack://c2/s2',
      'chan-2',
      'JH',
      'Hidden',
      'Not in this project',
      1_800,
      '2026-04-29',
      1_800,
      '{}',
      null,
      null,
      Buffer.alloc(32, 2),
      '2026-04-29T00:00:00.000Z',
      '2026-04-29T00:00:00.000Z',
      'default',
      'repo-b',
      'project',
      'repo-b'
    );

  adapter
    .prepare('INSERT INTO memory_scopes (id, kind, external_id, created_at) VALUES (?, ?, ?, ?)')
    .run('scope-repo-a', 'project', 'repo-a', 1_000);
  adapter
    .prepare('INSERT INTO memory_scopes (id, kind, external_id, created_at) VALUES (?, ?, ?, ?)')
    .run('scope-repo-b', 'project', 'repo-b', 1_000);
  adapter
    .prepare(
      `INSERT INTO decisions (
        id, topic, decision, reasoning, confidence, user_involvement, status, kind, summary,
        created_at, updated_at, event_date, event_datetime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'mem-question',
      'deploy',
      'Should we ship this release?',
      'Needs human review?',
      0.45,
      'user',
      'active',
      'task',
      'Open deploy review question?',
      1_600,
      1_600,
      '2026-04-29',
      1_600
    );
  adapter
    .prepare(
      `INSERT INTO decisions (
        id, topic, decision, reasoning, confidence, user_involvement, status, kind, summary,
        created_at, updated_at, event_date, event_datetime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'mem-hidden',
      'hidden',
      'Hidden decision',
      'Other project',
      0.9,
      'user',
      'active',
      'fact',
      'Hidden fact',
      1_600,
      1_600,
      '2026-04-29',
      1_600
    );
  adapter
    .prepare(
      'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary, created_at) VALUES (?, ?, ?, ?)'
    )
    .run('mem-question', 'scope-repo-a', 1, 1_000);
  adapter
    .prepare(
      'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary, created_at) VALUES (?, ?, ?, ?)'
    )
    .run('mem-hidden', 'scope-repo-b', 1, 1_000);

  adapter
    .prepare(
      `INSERT INTO case_truth (
        case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'case-visible',
      'Release readiness',
      'blocked',
      JSON.stringify([{ kind: 'project', id: 'repo-a' }]),
      'low',
      '1970-01-01T00:00:01.500Z',
      '1970-01-01T00:00:01.000Z',
      '1970-01-01T00:00:01.000Z'
    );

  adapter
    .prepare(
      `INSERT INTO twin_edges (
        edge_id, edge_type, subject_kind, subject_id, object_kind, object_id, relation_attrs_json,
        confidence, source, agent_id, model_run_id, envelope_hash, reason_classification,
        reason_text, evidence_refs_json, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'edge-visible',
      'blocks',
      'memory',
      'mem-question',
      'raw',
      'raw-visible',
      '{}',
      0.6,
      'agent',
      'agent-a',
      'mr-a',
      'env-a',
      null,
      'Visible raw blocks memory answer',
      '[]',
      Buffer.alloc(32, 3),
      1_900
    );
}

describe('Story M5: Agent situation source readers and builder', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('AC #1: read-only envelope-effective source reads', () => {
    it('returns only visible raw, memory, case, and edge candidates', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      const sources = listVisibleAgentSituationSources(adapter, {
        effective_filters: EFFECTIVE_FILTERS,
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        limit: 10,
      });

      expect(sources.raw.map((row) => row.ref.id)).toEqual(['raw-visible']);
      expect(sources.memories.map((row) => row.ref.id)).toEqual(['mem-question']);
      expect(sources.cases.map((row) => row.ref.id)).toEqual(['case-visible']);
      expect(sources.edges.map((row) => row.ref.id)).toEqual(['edge-visible']);
    });

    it('enforces as_of across raw, memory, case, and edge source reads', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO decisions (
            id, topic, decision, reasoning, confidence, user_involvement, status, kind, summary,
            created_at, updated_at, event_date, event_datetime
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'mem-after-as-of',
          'future memory',
          'Future memory should be hidden',
          'After bounded worker view',
          0.9,
          'user',
          'active',
          'fact',
          'Future memory',
          1_750,
          1_750,
          '2026-04-29',
          1_750
        );
      adapter
        .prepare(
          'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary, created_at) VALUES (?, ?, ?, ?)'
        )
        .run('mem-after-as-of', 'scope-repo-a', 1, 1_000);
      adapter
        .prepare(
          `INSERT INTO case_truth (
            case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'case-after-as-of',
          'Future case',
          'active',
          JSON.stringify([{ kind: 'project', id: 'repo-a' }]),
          'high',
          '1970-01-01T00:00:01.750Z',
          '1970-01-01T00:00:01.750Z',
          '1970-01-01T00:00:01.750Z'
        );
      adapter
        .prepare(
          `INSERT INTO twin_edges (
            edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
            relation_attrs_json, confidence, source, agent_id, model_run_id, envelope_hash,
            reason_classification, reason_text, evidence_refs_json, content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'edge-after-as-of',
          'mentions',
          'memory',
          'mem-question',
          'case',
          'case-visible',
          '{}',
          0.9,
          'agent',
          'agent-a',
          'mr-a',
          'env-a',
          null,
          'Future edge should be hidden by as_of',
          '[]',
          Buffer.alloc(32, 4),
          1_750
        );

      const sources = listVisibleAgentSituationSources(adapter, {
        effective_filters: {
          ...EFFECTIVE_FILTERS,
          as_of: '1970-01-01T00:00:01.650Z',
        },
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        limit: 10,
      });

      expect(sources.raw.map((row) => row.ref.id)).toEqual([]);
      expect(sources.memories.map((row) => row.ref.id)).toEqual(['mem-question']);
      expect(sources.cases.map((row) => row.ref.id)).toEqual(['case-visible']);
      expect(sources.edges.map((row) => row.ref.id)).toEqual([]);
    });

    it('uses raw event_datetime rather than source_timestamp_ms for as_of visibility', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO connector_event_index (
            event_index_id, source_connector, source_type, source_id, source_locator, channel,
            author, title, content, event_datetime, event_date, source_timestamp_ms, metadata_json,
            artifact_locator, artifact_title, content_hash, indexed_at, updated_at, tenant_id,
            project_id, memory_scope_kind, memory_scope_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'raw-future-event-backfilled',
          'slack',
          'message',
          's3',
          'slack://c3/s3',
          'chan-3',
          'JH',
          'Future event backfill',
          'The event happened after the worker view cutoff',
          1_750,
          '2026-04-29',
          1_500,
          '{}',
          null,
          null,
          Buffer.alloc(32, 6),
          '1970-01-01T00:00:01.500Z',
          '1970-01-01T00:00:01.500Z',
          'default',
          'repo-a',
          'project',
          'repo-a'
        );

      const sources = listVisibleAgentSituationSources(adapter, {
        effective_filters: {
          ...EFFECTIVE_FILTERS,
          as_of: '1970-01-01T00:00:01.650Z',
        },
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        limit: 10,
      });

      expect(sources.raw.map((row) => row.ref.id)).not.toContain('raw-future-event-backfilled');
    });

    it('attributes a visible case to the visible scope when hidden scope_refs appear first', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO case_truth (
            case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'case-hidden-first',
          'Cross-scope case',
          'active',
          JSON.stringify([
            { kind: 'project', id: 'repo-b' },
            { kind: 'project', id: 'repo-a' },
          ]),
          'medium',
          '1970-01-01T00:00:01.600Z',
          '1970-01-01T00:00:01.000Z',
          '1970-01-01T00:00:01.000Z'
        );

      const sources = listVisibleAgentSituationSources(adapter, {
        effective_filters: EFFECTIVE_FILTERS,
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        limit: 10,
      });

      expect(sources.cases.find((row) => row.ref.id === 'case-hidden-first')?.scope).toEqual({
        kind: 'project',
        id: 'repo-a',
      });
    });

    it('throws when case scope_refs is corrupt instead of hiding the row', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO case_truth (
            case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'case-corrupt-scope-refs',
          'Corrupt case',
          'active',
          '{not-json',
          'medium',
          '1970-01-01T00:00:01.600Z',
          '1970-01-01T00:00:01.000Z',
          '1970-01-01T00:00:01.000Z'
        );

      expect(() =>
        listVisibleAgentSituationSources(adapter, {
          effective_filters: EFFECTIVE_FILTERS,
          range_start_ms: 1_000,
          range_end_ms: 2_000,
          limit: 10,
        })
      ).toThrow(/case_truth\.scope_refs/);
    });

    it('throws when case scope_refs JSON is not an array', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO case_truth (
            case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'case-object-scope-refs',
          'Object scope refs',
          'active',
          JSON.stringify({ kind: 'project', id: 'repo-a' }),
          'medium',
          '1970-01-01T00:00:01.600Z',
          '1970-01-01T00:00:01.000Z',
          '1970-01-01T00:00:01.000Z'
        );

      expect(() =>
        listVisibleAgentSituationSources(adapter, {
          effective_filters: EFFECTIVE_FILTERS,
          range_start_ms: 1_000,
          range_end_ms: 2_000,
          limit: 10,
        })
      ).toThrow(/case_truth\.scope_refs/);
    });

    it('throws when a visible case has no valid timestamp instead of treating it as epoch', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      adapter
        .prepare(
          `INSERT INTO case_truth (
            case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'case-invalid-timestamp',
          'Invalid timestamp',
          'active',
          JSON.stringify([{ kind: 'project', id: 'repo-a' }]),
          'medium',
          null,
          'not-a-date',
          'also-not-a-date'
        );

      expect(() =>
        listVisibleAgentSituationSources(adapter, {
          effective_filters: EFFECTIVE_FILTERS,
          range_start_ms: 0,
          range_end_ms: 2_000,
          limit: 10,
        })
      ).toThrow(/case_truth timestamp.*case-invalid-timestamp/);
    });

    it('does not let hidden recent case or edge rows starve older visible rows', () => {
      const adapter = createAdapter();
      seedFixture(adapter);

      for (let index = 0; index < 45; index += 1) {
        adapter
          .prepare(
            `INSERT INTO case_truth (
              case_id, title, status, scope_refs, confidence, last_activity_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            `hidden-case-${index}`,
            `Hidden case ${index}`,
            'active',
            JSON.stringify([{ kind: 'project', id: 'repo-b' }]),
            'high',
            new Date(1_950 - index).toISOString(),
            new Date(1_950 - index).toISOString(),
            new Date(1_950 - index).toISOString()
          );
        adapter
          .prepare(
            `INSERT INTO twin_edges (
              edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
              relation_attrs_json, confidence, source, agent_id, model_run_id, envelope_hash,
              reason_classification, reason_text, evidence_refs_json, content_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            `hidden-edge-${index}`,
            'mentions',
            'memory',
            'mem-hidden',
            'raw',
            'raw-hidden-project',
            '{}',
            0.9,
            'agent',
            'agent-a',
            'mr-hidden',
            'env-hidden',
            null,
            'Hidden edge',
            '[]',
            Buffer.alloc(32, 5),
            1_950 - index
          );
      }

      const sources = listVisibleAgentSituationSources(adapter, {
        effective_filters: EFFECTIVE_FILTERS,
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        limit: 10,
      });

      expect(sources.cases.map((row) => row.ref.id)).toContain('case-visible');
      expect(sources.edges.map((row) => row.ref.id)).toContain('edge-visible');
    });
  });

  describe('AC #2: deterministic packet assembly', () => {
    it('builds a packet without mutating truth tables or leaking hidden sources', () => {
      const adapter = createAdapter();
      seedFixture(adapter);
      const beforeCounts = {
        raw: adapter.prepare('SELECT COUNT(*) AS count FROM connector_event_index').get() as {
          count: number;
        },
        memory: adapter.prepare('SELECT COUNT(*) AS count FROM decisions').get() as {
          count: number;
        },
        caseTruth: adapter.prepare('SELECT COUNT(*) AS count FROM case_truth').get() as {
          count: number;
        },
        edges: adapter.prepare('SELECT COUNT(*) AS count FROM twin_edges').get() as {
          count: number;
        },
      };

      const packet = buildAgentSituationPacketRecord(adapter, {
        scope: EFFECTIVE_FILTERS.scopes,
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        focus: ['decisions', 'risks', 'open_questions'],
        limit: 7,
        effective_filters: EFFECTIVE_FILTERS,
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        model_run_id: 'mr-a',
        now_ms: 2_000,
      });

      expect(packet.source_coverage[0]).toMatchObject({
        connector: 'slack',
        memory_scope: { kind: 'project', id: 'repo-a' },
        raw_count: 1,
        memory_count: 1,
        case_count: 1,
        edge_count: 1,
      });
      expect(packet.briefing.open_questions).toContain('Open deploy review question?');
      expect(packet.ranked_items.map((item) => item.ref.id)).toContain('mem-question');
      expect(packet.top_memory_refs).toEqual(['mem-question']);
      expect(packet.pending_human_questions).toHaveLength(1);
      expect(packet.entity_clusters).toEqual([]);
      expect(packet.recommended_next_tools.map((tool) => tool.tool)).toContain('raw.searchAll');
      expect(packet.caveats.join(' ')).not.toMatch(/\bhidden\b|\bfiltered\b|\d+ .*outside/i);
      expect(JSON.parse(packet.envelope_effective_filters_json)).toEqual({
        as_of: null,
        connectors: ['slack'],
        project_refs: [{ kind: 'project', id: 'repo-a' }],
        scopes: [{ kind: 'project', id: 'repo-a' }],
        tenant_id: 'default',
      });

      expect(adapter.prepare('SELECT COUNT(*) AS count FROM connector_event_index').get()).toEqual(
        beforeCounts.raw
      );
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM decisions').get()).toEqual(
        beforeCounts.memory
      );
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM case_truth').get()).toEqual(
        beforeCounts.caseTruth
      );
      expect(adapter.prepare('SELECT COUNT(*) AS count FROM twin_edges').get()).toEqual(
        beforeCounts.edges
      );
    });

    it('counts edge coverage only for the connector and scope row that owns the edge endpoints', () => {
      const adapter = createAdapter();
      seedFixture(adapter);
      const filters: AgentSituationEffectiveFilters = {
        ...EFFECTIVE_FILTERS,
        scopes: [
          { kind: 'project', id: 'repo-a' },
          { kind: 'project', id: 'repo-b' },
        ],
        project_refs: [
          { kind: 'project', id: 'repo-a' },
          { kind: 'project', id: 'repo-b' },
        ],
      };

      const packet = buildAgentSituationPacketRecord(adapter, {
        scope: filters.scopes,
        range_start_ms: 1_000,
        range_end_ms: 2_000,
        focus: ['decisions', 'risks'],
        limit: 7,
        effective_filters: filters,
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        model_run_id: 'mr-a',
        now_ms: 2_000,
      });

      const repoBCoverage = packet.source_coverage.find(
        (coverage) => coverage.memory_scope.id === 'repo-b'
      );

      expect(repoBCoverage).toMatchObject({
        raw_count: 1,
        memory_count: 1,
        case_count: 0,
        edge_count: 0,
        last_seen: '1970-01-01T00:00:01.800Z',
      });
    });
  });
});
