import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
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
