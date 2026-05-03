import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { insertTwinEdge } from '../../src/edges/store.js';
import type { TwinEdgeRecord } from '../../src/edges/types.js';
import type { MemoryRecord, RecallBundle } from '../../src/memory/types.js';
import {
  readGraphCandidates,
  readMemoryCandidates,
  readRawCandidates,
  sourceRefsFromCandidates,
} from '../../src/context-compile/source-readers.js';
import type { ContextSourceReadInput } from '../../src/context-compile/source-readers.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-context-source-readers-${randomUUID()}.db`);
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

function input(overrides: Partial<ContextSourceReadInput> = {}): ContextSourceReadInput {
  return {
    task: 'compile branch context',
    scopes: [{ kind: 'project', id: 'repo-a' }],
    connectors: ['slack'],
    project_refs: [{ kind: 'project', id: 'repo-a' }],
    tenant_id: 'default',
    boundary: {
      scopes: [{ kind: 'project', id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project', id: 'repo-a' }],
      tenant_id: 'default',
    },
    limit: 10,
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-a',
    topic: 'Context compile',
    kind: 'decision',
    summary: 'Use a committed child model run for context compilation.',
    details: 'The gateway tool must never commit the parent run.',
    confidence: 0.9,
    status: 'active',
    scopes: [{ kind: 'project', id: 'repo-a' }],
    source: { package: 'mama-core', source_type: 'test' },
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

function recallBundle(memories: MemoryRecord[], extra: Record<string, unknown> = {}): RecallBundle {
  return {
    profile: { static: [], dynamic: [], evidence: [] },
    memories,
    graph_context: { primary: memories, expanded: [], edges: [] },
    search_meta: {
      query: 'compile branch context',
      scope_order: ['project'],
      retrieval_sources: ['test'],
    },
    ...extra,
  };
}

function insertScopedDecision(
  adapter: DatabaseAdapter,
  input: {
    id: string;
    topic: string;
    summary: string;
    details: string;
    scopeId?: string;
    timestampMs?: number;
  }
): void {
  const scopeId = input.scopeId ?? 'repo-a';
  const memoryScopeId = `scope_project_${scopeId}`;
  const timestampMs = input.timestampMs ?? 1_200;
  adapter
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, created_at, updated_at,
          kind, status, summary, event_datetime
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      input.topic,
      input.summary,
      input.details,
      0.75,
      timestampMs,
      timestampMs,
      'decision',
      'active',
      input.summary,
      timestampMs
    );
  adapter
    .prepare(
      `
        INSERT OR IGNORE INTO memory_scopes (id, kind, external_id)
        VALUES (?, ?, ?)
      `
    )
    .run(memoryScopeId, 'project', scopeId);
  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary)
        VALUES (?, ?, 1)
      `
    )
    .run(input.id, memoryScopeId);
}

describe('STORY-CC-B3: Context source readers - AC1, AC2, AC3', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('AC1: memory reader maps Branch A diagnostics and time filters', () => {
    it('maps retrieval diagnostics into support signals on memory candidates', async () => {
      const result = await readMemoryCandidates(input(), {
        recallMemory: async () =>
          recallBundle([
            memory({
              retrieval_diagnostics: {
                retrieval_source: 'hybrid_rrf',
                vector_similarity: 0.88,
                lexical_support: true,
                entity_support: false,
                scope_support: true,
                graph_source: 'expanded',
                is_vector_only: false,
                confirmation_signals: ['lexical'],
                metadata_signals: ['graph_expanded'],
                candidate_threshold_used: 0.45,
              },
            }),
          ]),
      });

      expect(result.candidates[0]).toMatchObject({
        ref: { kind: 'memory', id: 'mem-a' },
        support: {
          retrieval_source: 'hybrid_rrf',
          lexical_support: true,
          is_vector_only: false,
          graph_expanded: true,
          confirmation_signals: ['lexical'],
        },
      });
    });

    it('treats explicit empty scopes as no readable memory scope', async () => {
      const recallMemory = vi.fn(async () => recallBundle([memory()]));

      const result = await readMemoryCandidates(input({ scopes: [] }), {
        recallMemory,
      });

      expect(recallMemory).not.toHaveBeenCalled();
      expect(result).toEqual({
        candidates: [],
        hidden: { total: 0, by_kind: {}, by_reason: {} },
        source_refs: [],
      });
    });

    it('uses boundary scopes as defaults for direct exported memory reader calls', async () => {
      const recallMemory = vi.fn(async () => recallBundle([memory()]));

      await readMemoryCandidates(
        input({
          scopes: undefined,
          connectors: undefined,
          project_refs: undefined,
          tenant_id: undefined,
        }),
        { recallMemory }
      );

      expect(recallMemory).toHaveBeenCalledWith(
        'compile branch context',
        expect.objectContaining({
          scopes: [{ kind: 'project', id: 'repo-a' }],
        })
      );
    });

    it('fails loudly when the adapter is not a migrated memory database', async () => {
      const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() }) as unknown as DatabaseAdapter;
      adapter.connect();

      await expect(readMemoryCandidates(input(), { adapter })).rejects.toThrow(/decisions/i);
    });

    it('filters by range and as_of, dropping timestamp-missing candidates into aggregates only', async () => {
      const hiddenId = 'mem-hidden-missing-time';
      const hiddenExcerpt = 'this hidden excerpt must not leak';
      const result = await readMemoryCandidates(
        input({ range: { start_ms: 1_000, end_ms: 2_000 }, as_of: 1_500 }),
        {
          recallMemory: async () =>
            recallBundle([
              memory({ id: 'mem-visible', event_datetime: 1_200 }),
              memory({ id: 'mem-after-as-of', event_datetime: 1_800 }),
              memory({
                id: hiddenId,
                summary: hiddenExcerpt,
                details: hiddenExcerpt,
                created_at: 'not-a-date',
                updated_at: 'not-a-date',
              }),
            ]),
        }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'memory', id: 'mem-visible' },
      ]);
      expect(result.hidden).toMatchObject({
        total: 2,
        by_kind: { memory: 2 },
      });
      expect(JSON.stringify(result)).not.toContain(hiddenId);
      expect(JSON.stringify(result)).not.toContain(hiddenExcerpt);
    });

    it('clamps direct memory reads to the boundary as_of snapshot', async () => {
      const result = await readMemoryCandidates(
        input({
          as_of: 5_000,
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: ['slack'],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
            as_of: 1_500,
          },
        }),
        {
          recallMemory: async () =>
            recallBundle([
              memory({ id: 'mem-visible', created_at: 1_200, updated_at: 1_200 }),
              memory({ id: 'mem-future', created_at: 2_500, updated_at: 2_500 }),
            ]),
        }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'memory', id: 'mem-visible' },
      ]);
      expect(result.hidden.by_reason.time_boundary).toBe(1);
    });

    it('rejects malformed range boundaries instead of widening memory reads', async () => {
      await expect(
        readMemoryCandidates(input({ range: { start_ms: '1000' as unknown as number } }), {
          recallMemory: async () => recallBundle([memory({ event_datetime: 1_200 })]),
        })
      ).rejects.toThrow(/range\.start_ms/);
    });

    it('rejects malformed time filters before invoking custom memory recall', async () => {
      const recallMemory = vi.fn(async () => recallBundle([]));

      await expect(
        readMemoryCandidates(
          input({
            boundary: undefined,
            as_of: 'not-a-date',
          }),
          { recallMemory }
        )
      ).rejects.toThrow(/as_of/);

      expect(recallMemory).not.toHaveBeenCalled();
    });

    it('rejects empty time ranges before invoking custom memory recall', async () => {
      const recallMemory = vi.fn(async () => recallBundle([]));

      await expect(
        readMemoryCandidates(
          input({
            boundary: undefined,
            range: { start_ms: 2_000, end_ms: 1_000 },
          }),
          { recallMemory }
        )
      ).rejects.toThrow(/range/);

      expect(recallMemory).not.toHaveBeenCalled();
    });

    it('passes normalized time filters into custom memory recall options', async () => {
      const recallMemory = vi.fn(async () => recallBundle([]));

      await readMemoryCandidates(
        input({
          boundary: undefined,
          as_of: '2026-01-01T00:00:00.000Z',
          range: { start_ms: 1_000, end_ms: 2_000 },
        }),
        { recallMemory }
      );

      expect(recallMemory).toHaveBeenCalledWith(
        'compile branch context',
        expect.objectContaining({
          as_of: Date.parse('2026-01-01T00:00:00.000Z'),
          range: { start_ms: 1_000, end_ms: 2_000 },
        })
      );
    });

    it('ignores wiki-derived fused hits without concrete visible V0 source refs', async () => {
      const result = await readMemoryCandidates(input(), {
        recallMemory: async () =>
          recallBundle([], {
            fused_hits: [
              {
                source_type: 'wiki_page',
                source_id: 'wiki/context-compile.md',
                record: { source_locator: 'wiki/context-compile.md' },
                fused_rank_score: 0.8,
              },
            ],
          }),
      });

      expect(result.candidates).toEqual([]);
      expect(result.source_refs).toEqual([]);
    });

    it('uses the supplied adapter for default memory reads', async () => {
      const adapter = createAdapter();
      insertScopedDecision(adapter, {
        id: 'mem-adapter-owned',
        topic: 'context compile adapter isolation',
        summary: 'Adapter scoped memory should be read from this database only.',
        details: 'The context compiler must not fall back to the global mama-core DB.',
      });

      const result = await readMemoryCandidates(input({ task: 'adapter isolation memory' }), {
        adapter,
      });

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'memory', id: 'mem-adapter-owned' },
      ]);
      expect(result.candidates[0].support).toMatchObject({
        retrieval_source: 'context_compile_adapter',
        lexical_support: true,
      });
    });

    it('applies lexical filtering before the adapter recency limit', async () => {
      const adapter = createAdapter();
      for (let index = 0; index < 60; index += 1) {
        insertScopedDecision(adapter, {
          id: `mem-newer-unrelated-${index}`,
          topic: `newer unrelated ${index}`,
          summary: 'Recent operational note without the target phrase.',
          details: 'This row should not hide the older matching memory.',
          timestampMs: 10_000 + index,
        });
      }
      insertScopedDecision(adapter, {
        id: 'mem-older-exact-match',
        topic: 'needle exact context',
        summary: 'The relevant branch context lives in this older memory.',
        details: 'Older exact lexical matches must be ranked before the recency limit is applied.',
        timestampMs: 1_000,
      });

      const result = await readMemoryCandidates(
        input({ task: 'needle exact context', limit: 10 }),
        { adapter }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toContainEqual({
        kind: 'memory',
        id: 'mem-older-exact-match',
      });
    });

    it('applies time filtering before the adapter recency limit', async () => {
      const adapter = createAdapter();
      for (let index = 0; index < 60; index += 1) {
        insertScopedDecision(adapter, {
          id: `mem-newer-outside-window-${index}`,
          topic: `needle exact context newer ${index}`,
          summary: 'Newer exact matches are outside the requested snapshot.',
          details: 'They must not consume the adapter fetch window before time filtering.',
          timestampMs: 10_000 + index,
        });
      }
      insertScopedDecision(adapter, {
        id: 'mem-older-inside-window',
        topic: 'needle exact context',
        summary: 'The relevant branch context is older but inside the requested snapshot.',
        details: 'Time bounds must be applied before the adapter recency limit.',
        timestampMs: 1_000,
      });

      const result = await readMemoryCandidates(
        input({ task: 'needle exact context', as_of: 2_000, limit: 10 }),
        { adapter }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'memory', id: 'mem-older-inside-window' },
      ]);
    });
  });

  describe('AC2: raw and graph readers enforce visibility', () => {
    it('raw reader rejects connectors outside the envelope boundary', () => {
      const adapter = createAdapter();

      expect(() =>
        readRawCandidates(
          adapter,
          input({
            connectors: ['discord'],
            boundary: {
              scopes: [{ kind: 'project', id: 'repo-a' }],
              connectors: ['slack'],
              project_refs: [{ kind: 'project', id: 'repo-a' }],
              tenant_id: 'default',
            },
          })
        )
      ).toThrow(/connector/i);
    });

    it('raw reader returns visible connector events as concrete raw refs', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-visible',
        channel: 'C-eng',
        title: 'Visible raw event',
        content: 'Context compile discussion in Slack.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({ range: { start_ms: 1_000, end_ms: 2_000 } })
      );

      expect(result.candidates[0]).toMatchObject({
        ref: {
          kind: 'raw',
          connector: 'slack',
          source_id: 'm-visible',
          channel_id: 'C-eng',
        },
        title: 'Visible raw event',
      });
      expect(result.source_refs[0]).toMatchObject({
        kind: 'raw',
        connector: 'slack',
        source_id: 'm-visible',
      });
    });

    it('uses boundary connector, scope, project, and tenant defaults for direct raw reads', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-boundary-default',
        channel: 'C-eng',
        title: 'Boundary default raw event',
        content: 'Direct reader calls should inherit the boundary.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({
          connectors: undefined,
          scopes: undefined,
          project_refs: undefined,
          tenant_id: undefined,
        })
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        expect.objectContaining({
          kind: 'raw',
          connector: 'slack',
          source_id: 'm-boundary-default',
        }),
      ]);
    });

    it('raw reader uses source_timestamp_ms for temporal filters when event_datetime is missing', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-source-timestamp',
        channel: 'C-eng',
        title: 'Source timestamp raw event',
        content: 'Context compile raw evidence with only source timestamp.',
        event_datetime: null,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({ range: { start_ms: 1_000, end_ms: 2_000 } })
      );

      expect(result.candidates[0]).toMatchObject({
        ref: {
          kind: 'raw',
          connector: 'slack',
          source_id: 'm-source-timestamp',
        },
        timestamp_ms: 1_200,
      });
    });

    it('treats explicit empty project refs under a project boundary as no raw project access', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-cross-project',
        channel: 'C-eng',
        title: 'Hidden cross-project raw event',
        content: 'This raw event must not leak when project refs are narrowed to none.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-b',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({
          project_refs: [],
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: ['slack'],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
          },
        })
      );

      expect(result).toEqual({
        candidates: [],
        hidden: { total: 0, by_kind: {}, by_reason: {} },
        source_refs: [],
      });
      expect(JSON.stringify(result)).not.toContain('Hidden cross-project raw event');
    });

    it('raw reader does not require project refs when the boundary has none', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-projectless',
        channel: 'C-eng',
        title: 'Projectless raw event',
        content: 'Channel-scoped context without a project id.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        memory_scope_kind: 'channel',
        memory_scope_id: 'C-eng',
      });

      const result = readRawCandidates(
        adapter,
        input({
          scopes: [{ kind: 'channel', id: 'C-eng' }],
          project_refs: [],
          tenant_id: null,
          boundary: {
            scopes: [{ kind: 'channel', id: 'C-eng' }],
            connectors: ['slack'],
            project_refs: [],
            tenant_id: null,
          },
        })
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        expect.objectContaining({
          kind: 'raw',
          connector: 'slack',
          source_id: 'm-projectless',
        }),
      ]);
    });

    it('defaults explicit null tenant to the non-null boundary tenant', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-default-tenant',
        title: 'Default tenant raw event',
        content: 'This event is inside the tenant boundary.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-other-tenant',
        title: 'Other tenant raw event',
        content: 'This event must stay outside the tenant boundary.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'other',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({
          tenant_id: null,
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: ['slack'],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
          },
        })
      );

      expect(result.candidates.map((candidate) => candidate.title)).toEqual([
        'Default tenant raw event',
      ]);
    });

    it('intersects direct raw reads with the boundary time range', () => {
      const adapter = createAdapter();
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-visible-range',
        title: 'Visible range raw event',
        content: 'This event is inside the boundary range.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });
      upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-future-range',
        title: 'Future range raw event',
        content: 'This event is outside the boundary range.',
        event_datetime: 2_500,
        source_timestamp_ms: 2_500,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const result = readRawCandidates(
        adapter,
        input({
          range: { start_ms: 0, end_ms: 3_000 },
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: ['slack'],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
            range: { start_ms: 1_000, end_ms: 1_500 },
          },
        })
      );

      expect(result.candidates.map((candidate) => candidate.title)).toEqual([
        'Visible range raw event',
      ]);
    });

    it('omits raw source_id when connector_event_index has no concrete source id', () => {
      const adapter = createAdapter();
      const rawId = upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-will-be-empty',
        title: 'Raw event without source id',
        content: 'This event should not stringify an empty source id.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      }).event_index_id;
      adapter
        .prepare("UPDATE connector_event_index SET source_id = '' WHERE event_index_id = ?")
        .run(rawId);

      const result = readRawCandidates(adapter, input());

      expect(result.source_refs).toHaveLength(1);
      expect(result.source_refs[0]).toMatchObject({
        kind: 'raw',
        connector: 'slack',
        raw_id: rawId,
      });
      expect(result.source_refs[0]).not.toHaveProperty('source_id');
    });

    it('graph reader maps only visible twin-edge neighbors returned by the visibility API', () => {
      const visibleEdge = {
        edge_id: 'edge-visible',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-a' },
        confidence: 0.8,
        reason_text: 'Memory mentions the case.',
        created_at: 1_100,
      } as TwinEdgeRecord;

      const result = readGraphCandidates(
        createAdapter(),
        input({ as_of: 1_500 }),
        [{ kind: 'memory', id: 'mem-a' }],
        {
          listVisibleTwinEdgesForRefs: () => [visibleEdge],
        }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'case', id: 'case-a' },
      ]);
      expect(JSON.stringify(result)).not.toContain('edge-hidden');
    });

    it('uses boundary defaults for direct graph reader calls', () => {
      const visibleEdge = {
        edge_id: 'edge-visible',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-a' },
        confidence: 0.8,
        reason_text: 'Memory mentions the case.',
        created_at: 1_100,
      } as TwinEdgeRecord;
      const listVisibleTwinEdgesForRefs = vi.fn(() => [visibleEdge]);

      readGraphCandidates(
        createAdapter(),
        input({
          connectors: undefined,
          scopes: undefined,
          project_refs: undefined,
          tenant_id: undefined,
        }),
        [{ kind: 'memory', id: 'mem-a' }],
        { listVisibleTwinEdgesForRefs }
      );

      expect(listVisibleTwinEdgesForRefs).toHaveBeenCalledWith(
        expect.anything(),
        [{ kind: 'memory', id: 'mem-a' }],
        expect.objectContaining({
          scopes: [{ kind: 'project', id: 'repo-a' }],
          connectors: ['slack'],
          projectRefs: [{ kind: 'project', id: 'repo-a' }],
          tenantId: 'default',
        })
      );
    });

    it('graph reader keeps raw edge lookups in event-index id space', () => {
      const adapter = createAdapter();
      const rawId = upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-graph',
        channel: 'C-eng',
        title: 'Graph raw event',
        content: 'Graph raw context.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      }).event_index_id;
      const visibleEdge = {
        edge_id: 'edge-raw',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'raw', id: rawId },
        confidence: 0.8,
        reason_text: 'Memory mentions the raw event.',
        created_at: 1_300,
      } as TwinEdgeRecord;
      let refsSeenByGraph: unknown[] = [];

      const result = readGraphCandidates(
        adapter,
        input({ as_of: 1_500 }),
        [{ kind: 'raw', connector: 'slack', raw_id: rawId }],
        {
          listVisibleTwinEdgesForRefs: (_adapter, refs) => {
            refsSeenByGraph = [...refs];
            return [visibleEdge];
          },
        }
      );

      expect(refsSeenByGraph).toEqual([{ kind: 'raw', id: rawId }]);
      expect(result.candidates.map((candidate) => candidate.ref)).toContainEqual({
        kind: 'memory',
        id: 'mem-a',
      });
    });

    it('treats an explicit empty connector window as no raw graph expansion access', () => {
      const adapter = createAdapter();
      insertScopedDecision(adapter, {
        id: 'mem-raw-denied',
        topic: 'Context compile raw connector boundary',
        summary: 'Visible memory has a raw neighbor.',
        details: 'The raw neighbor must stay hidden when connectors are empty.',
      });
      const rawId = upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'm-raw-denied',
        channel: 'C-eng',
        title: 'Denied raw event',
        content: 'This raw event is outside the empty connector envelope.',
        event_datetime: 1_200,
        source_timestamp_ms: 1_200,
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      }).event_index_id;
      insertTwinEdge(adapter, {
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-raw-denied' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'code',
        reason_text: 'Memory mentions the raw event.',
      });

      const result = readGraphCandidates(
        adapter,
        input({
          connectors: [],
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: [],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
          },
        }),
        [{ kind: 'memory', id: 'mem-raw-denied' }]
      );

      expect(result.candidates).toEqual([]);
      expect(result.source_refs).toEqual([]);
    });

    it('graph reader excludes edges created before the requested range start', () => {
      const oldEdge = {
        edge_id: 'edge-old',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-old' },
        confidence: 0.8,
        reason_text: 'Old edge.',
        created_at: 900,
      } as TwinEdgeRecord;
      const freshEdge = {
        edge_id: 'edge-fresh',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-fresh' },
        confidence: 0.8,
        reason_text: 'Fresh edge.',
        created_at: 1_100,
      } as TwinEdgeRecord;

      const result = readGraphCandidates(
        createAdapter(),
        input({ range: { start_ms: 1_000, end_ms: 2_000 } }),
        [{ kind: 'memory', id: 'mem-a' }],
        {
          listVisibleTwinEdgesForRefs: () => [oldEdge, freshEdge],
        }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'case', id: 'case-fresh' },
      ]);
    });

    it('graph reader excludes edges created after the requested range end', () => {
      const inRangeEdge = {
        edge_id: 'edge-in-range',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-in-range' },
        confidence: 0.8,
        reason_text: 'In range edge.',
        created_at: 1_900,
      } as TwinEdgeRecord;
      const lateEdge = {
        edge_id: 'edge-late',
        edge_type: 'mentions',
        subject_ref: { kind: 'memory', id: 'mem-a' },
        object_ref: { kind: 'case', id: 'case-late' },
        confidence: 0.8,
        reason_text: 'Late edge.',
        created_at: 2_100,
      } as TwinEdgeRecord;

      const result = readGraphCandidates(
        createAdapter(),
        input({ range: { end_ms: 2_000 } }),
        [{ kind: 'memory', id: 'mem-a' }],
        {
          listVisibleTwinEdgesForRefs: () => [inRangeEdge, lateEdge],
        }
      );

      expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
        { kind: 'case', id: 'case-in-range' },
      ]);
    });

    it('graph reader treats explicit empty scopes as no graph expansion scope', () => {
      const listVisibleTwinEdgesForRefs = vi.fn(() => [
        {
          edge_id: 'edge-visible',
          edge_type: 'mentions',
          subject_ref: { kind: 'memory', id: 'mem-a' },
          object_ref: { kind: 'case', id: 'case-a' },
          confidence: 0.8,
          reason_text: 'Memory mentions the case.',
          created_at: 1_100,
        } as TwinEdgeRecord,
      ]);

      const result = readGraphCandidates(
        createAdapter(),
        input({ scopes: [] }),
        [{ kind: 'memory', id: 'mem-a' }],
        { listVisibleTwinEdgesForRefs }
      );

      expect(listVisibleTwinEdgesForRefs).not.toHaveBeenCalled();
      expect(result.candidates).toEqual([]);
      expect(result.source_refs).toEqual([]);
    });

    it('graph reader rejects requests outside the source boundary before querying edges', () => {
      const listVisibleTwinEdgesForRefs = vi.fn(() => [
        {
          edge_id: 'edge-visible',
          edge_type: 'mentions',
          subject_ref: { kind: 'memory', id: 'mem-a' },
          object_ref: { kind: 'case', id: 'case-a' },
          confidence: 0.8,
          reason_text: 'Memory mentions the case.',
          created_at: 1_100,
        } as TwinEdgeRecord,
      ]);

      expect(() =>
        readGraphCandidates(
          createAdapter(),
          input({ project_refs: [{ kind: 'project', id: 'repo-b' }] }),
          [{ kind: 'memory', id: 'mem-a' }],
          { listVisibleTwinEdgesForRefs }
        )
      ).toThrow(/Requested project ref is outside the context boundary/);
      expect(listVisibleTwinEdgesForRefs).not.toHaveBeenCalled();
    });
  });

  describe('AC3: public source refs contain only concrete V0 refs', () => {
    it('deduplicates visible source refs and omits hidden aggregate-only candidates', () => {
      const refs = sourceRefsFromCandidates([
        {
          ref: { kind: 'memory', id: 'mem-a' },
          title: 'Visible',
          excerpt: 'Visible excerpt',
          score: 0.9,
          timestamp_ms: 1_000,
          source: 'memory',
          visible: true,
          support: { confirmation_signals: [], metadata_signals: [] },
        },
        {
          ref: { kind: 'memory', id: 'mem-a' },
          title: 'Duplicate',
          excerpt: 'Duplicate excerpt',
          score: 0.8,
          timestamp_ms: 1_000,
          source: 'memory',
          visible: true,
          support: { confirmation_signals: [], metadata_signals: [] },
        },
        {
          ref: { kind: 'raw', connector: 'slack', raw_id: 'hidden-raw' },
          title: 'Hidden raw',
          excerpt: 'hidden raw excerpt',
          score: 0,
          timestamp_ms: null,
          source: 'raw',
          visible: false,
          hidden_reason: 'scope',
          support: { confirmation_signals: [], metadata_signals: [] },
        },
      ]);

      expect(refs).toEqual([{ kind: 'memory', id: 'mem-a' }]);
    });
  });
});
