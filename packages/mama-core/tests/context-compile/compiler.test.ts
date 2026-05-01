import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ContextCandidate,
  ContextSourceReadResult,
} from '../../src/context-compile/source-readers.js';
import { compileContext } from '../../src/context-compile/compiler.js';
import type { ContextCompilerDeps } from '../../src/context-compile/compiler.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

const EMPTY_RESULT: ContextSourceReadResult = {
  candidates: [],
  hidden: { total: 0, by_kind: {}, by_reason: {} },
  source_refs: [],
};

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-context-compiler-${randomUUID()}.db`);
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

function insertScopedDecision(
  adapter: DatabaseAdapter,
  input: {
    id: string;
    topic: string;
    summary: string;
    details: string;
    scopeId?: string;
  }
): void {
  const scopeId = input.scopeId ?? 'repo-a';
  const memoryScopeId = `scope_project_${scopeId}`;
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
      0.8,
      1_200,
      1_200,
      'decision',
      'active',
      input.summary,
      1_200
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

function candidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    ref: { kind: 'memory', id: 'mem-a' },
    title: 'Primary memory',
    excerpt: 'Use committed child model runs for context_compile.',
    score: 0.9,
    timestamp_ms: 1_000,
    source: 'memory',
    visible: true,
    support: {
      retrieval_source: 'hybrid_rrf',
      lexical_support: true,
      is_vector_only: false,
      confirmation_signals: ['lexical'],
      metadata_signals: [],
    },
    ...overrides,
  };
}

function compilerDeps(overrides: Partial<ContextCompilerDeps> = {}): ContextCompilerDeps {
  return {
    packetId: () => 'ctxp_test',
    now: () => 1_000,
    readMemoryCandidates: async () => EMPTY_RESULT,
    readRawCandidates: () => EMPTY_RESULT,
    readGraphCandidates: () => EMPTY_RESULT,
    ...overrides,
  };
}

describe('STORY-CC-B4: compileContext core assembly - AC1, AC2, AC3', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  it('returns a complete empty packet without storage writes', async () => {
    const insertContextPacket = vi.fn();
    const packet = await compileContext(
      {
        task: 'compile branch context',
        scopes: [{ kind: 'project', id: 'repo-a' }],
        max_tokens: 1_000,
      },
      {
        ...compilerDeps(),
        insertContextPacket,
      } as ContextCompilerDeps & { insertContextPacket: typeof insertContextPacket }
    );

    expect(packet).toMatchObject({
      packet_id: 'ctxp_test',
      task: 'compile branch context',
      selected_evidence: [],
      evidence_clusters: [],
      related_decisions: [],
      rejected_refs: [],
      rejected_summary: [],
      caveats: [],
      expansion_trace: expect.any(Array),
      retrieval_diagnostics: expect.any(Object),
      budget: {
        max_tokens: 1_000,
        used_tool_calls: 1,
      },
    });
    expect(packet.missing_context.length).toBeGreaterThan(0);
    expect(insertContextPacket).not.toHaveBeenCalled();
  });

  it('respects max_tool_calls by stopping before raw and graph readers', async () => {
    const readMemoryCandidates = vi.fn(async () => ({
      ...EMPTY_RESULT,
      candidates: [candidate()],
      source_refs: [{ kind: 'memory', id: 'mem-a' }],
    }));
    const readRawCandidates = vi.fn(() => EMPTY_RESULT);
    const readGraphCandidates = vi.fn(() => EMPTY_RESULT);

    const packet = await compileContext(
      {
        task: 'compile branch context',
        scopes: [{ kind: 'project', id: 'repo-a' }],
        max_tool_calls: 1,
      },
      compilerDeps({ readMemoryCandidates, readRawCandidates, readGraphCandidates })
    );

    expect(readMemoryCandidates).toHaveBeenCalledTimes(1);
    expect(readRawCandidates).not.toHaveBeenCalled();
    expect(readGraphCandidates).not.toHaveBeenCalled();
    expect(packet.budget.used_tool_calls).toBe(1);
  });

  it('cooperatively fails on deadline or abort signal before reading sources', async () => {
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          scopes: [{ kind: 'project', id: 'repo-a' }],
        },
        compilerDeps({ signal: aborted.signal })
      )
    ).rejects.toThrow(/aborted/i);

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          scopes: [{ kind: 'project', id: 'repo-a' }],
        },
        compilerDeps({ now: () => 2_000, deadlineMs: 1_000 })
      )
    ).rejects.toThrow(/deadline/i);
  });

  it('records token budget estimates and rejects over-budget evidence', async () => {
    const packet = await compileContext(
      {
        task: 'compile branch context',
        scopes: [{ kind: 'project', id: 'repo-a' }],
        max_tokens: 25,
      },
      compilerDeps({
        readMemoryCandidates: async () => ({
          ...EMPTY_RESULT,
          candidates: [
            candidate({ ref: { kind: 'memory', id: 'mem-short' }, excerpt: 'short' }),
            candidate({
              ref: { kind: 'case', id: 'case-long' },
              title: 'Long case',
              excerpt: 'very long case evidence '.repeat(80),
              source: 'graph',
            }),
          ],
          source_refs: [
            { kind: 'memory', id: 'mem-short' },
            { kind: 'case', id: 'case-long' },
          ],
        }),
      })
    );

    expect(packet.selected_evidence.map((item) => item.ref)).toEqual([
      { kind: 'memory', id: 'mem-short' },
    ]);
    expect(packet.rejected_refs).toContainEqual({ kind: 'case', id: 'case-long' });
    expect(packet.budget.max_tokens).toBe(25);
    expect(packet.budget.estimated_tokens).toBeLessThanOrEqual(25);
  });

  it('throws hard security errors before any source read', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          scopes: [{ kind: 'project', id: 'repo-a' }],
          connectors: ['discord'],
        },
        compilerDeps({
          readMemoryCandidates,
          boundary: {
            scopes: [{ kind: 'project', id: 'repo-a' }],
            connectors: ['slack'],
            project_refs: [{ kind: 'project', id: 'repo-a' }],
            tenant_id: 'default',
          },
        })
      )
    ).rejects.toThrow(/connector/i);

    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('rejects requested scopes when the boundary scopes are explicitly empty', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          scopes: [{ kind: 'project', id: 'repo-a' }],
        },
        compilerDeps({
          boundary: { scopes: [] },
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/scope/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('defaults omitted source read fields to the active boundary', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const readRawCandidates = vi.fn(() => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
      as_of: 2_000,
      range: { start_ms: 1_000, end_ms: 2_000 },
    };

    const packet = await compileContext(
      {
        task: 'compile branch context',
      },
      compilerDeps({
        boundary,
        readMemoryCandidates,
        readRawCandidates,
      })
    );

    expect(readMemoryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: boundary.scopes,
        connectors: boundary.connectors,
        project_refs: boundary.project_refs,
        tenant_id: 'default',
        as_of: 2_000,
        range: boundary.range,
      })
    );
    expect(readRawCandidates).toHaveBeenCalledTimes(1);
    expect(packet.scopes).toEqual(boundary.scopes);
  });

  it('clamps requested ranges to the active boundary range', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
      range: { start_ms: 2_000, end_ms: 3_000 },
    };

    await compileContext(
      {
        task: 'compile branch context',
        range: { start_ms: 1_000, end_ms: 4_000 },
        max_tool_calls: 1,
      },
      compilerDeps({
        boundary,
        readMemoryCandidates,
      })
    );

    expect(readMemoryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { start_ms: 2_000, end_ms: 3_000 },
      })
    );
  });

  it('preserves explicit empty project refs as a boundary narrowing', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const readRawCandidates = vi.fn(() => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    const packet = await compileContext(
      {
        task: 'compile branch context',
        project_refs: [],
      },
      compilerDeps({
        boundary,
        readMemoryCandidates,
        readRawCandidates,
      })
    );

    expect(readMemoryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: boundary.scopes,
        connectors: boundary.connectors,
        project_refs: [],
        tenant_id: 'default',
      })
    );
    expect(readRawCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        project_refs: [],
      })
    );
    expect(packet.scopes).toEqual(boundary.scopes);
  });

  it('preserves explicit empty scopes as a boundary narrowing', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const readRawCandidates = vi.fn(() => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    const packet = await compileContext(
      {
        task: 'compile branch context',
        scopes: [],
      },
      compilerDeps({
        boundary,
        readMemoryCandidates,
        readRawCandidates,
      })
    );

    expect(readMemoryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: [],
        connectors: boundary.connectors,
        project_refs: boundary.project_refs,
      })
    );
    expect(packet.scopes).toEqual([]);
  });

  it('rejects seed refs when explicit empty scopes remove readable scope access', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          scopes: [],
          seed_refs: [{ kind: 'memory', id: 'mem-known' }],
        },
        compilerDeps({
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/empty requested context scope/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('rejects seed refs when the envelope boundary has no readable memory scopes', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const boundary = {
      scopes: [],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          seed_refs: [{ kind: 'memory', id: 'mem-known' }],
        },
        compilerDeps({
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/empty requested context scope/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('rejects raw seed refs when explicit empty project refs remove project access', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          project_refs: [],
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: 'raw-known' }],
        },
        compilerDeps({
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/empty requested project ref/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('rejects raw seed refs when the envelope boundary has no raw connectors', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: [],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: 'raw-known' }],
        },
        compilerDeps({
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/connector/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();
  });

  it('preserves explicit empty connectors as a raw-read narrowing', async () => {
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);
    const readRawCandidates = vi.fn(() => EMPTY_RESULT);
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
    };

    await compileContext(
      {
        task: 'compile branch context',
        connectors: [],
      },
      compilerDeps({
        boundary,
        readMemoryCandidates,
        readRawCandidates,
      })
    );

    expect(readMemoryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        connectors: [],
        project_refs: boundary.project_refs,
      })
    );
    expect(readRawCandidates).not.toHaveBeenCalled();
  });

  it('uses the supplied adapter for default memory reads', async () => {
    const adapter = createAdapter();
    insertScopedDecision(adapter, {
      id: 'mem-adapter-owned',
      topic: 'context compile adapter isolation',
      summary: 'Adapter scoped memory should be selected from the compiler database.',
      details: 'The compiler must not fall back to the global mama-core database.',
    });

    const packet = await compileContext(
      {
        task: 'adapter isolation memory',
        scopes: [{ kind: 'project', id: 'repo-a' }],
        max_tool_calls: 1,
      },
      {
        adapter,
        packetId: () => 'ctxp_adapter_memory',
        now: () => 1_500,
      }
    );

    expect(packet.source_refs).toContainEqual({ kind: 'memory', id: 'mem-adapter-owned' });
    expect(packet.selected_evidence.map((item) => item.ref)).toContainEqual({
      kind: 'memory',
      id: 'mem-adapter-owned',
    });
    expect(packet.selected_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { kind: 'memory', id: 'mem-adapter-owned' },
          retrieval_diagnostics: expect.objectContaining({
            retrieval_source: 'context_compile_adapter',
          }),
        }),
      ])
    );
  });

  it('requires seed refs to be visible before trusting them as packet source refs', async () => {
    const adapter = createAdapter();
    const visibleRawId = upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'm-visible-seed',
      channel: 'C-eng',
      title: 'Visible seed',
      content: 'Visible seed raw context.',
      event_datetime: 1_200,
      source_timestamp_ms: 1_200,
      tenant_id: 'default',
      project_id: 'repo-a',
      memory_scope_kind: 'project',
      memory_scope_id: 'repo-a',
    }).event_index_id;
    const hiddenRawId = upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'm-hidden-seed',
      channel: 'C-other',
      title: 'Hidden seed',
      content: 'Hidden seed raw context.',
      event_datetime: 1_200,
      source_timestamp_ms: 1_200,
      tenant_id: 'default',
      project_id: 'repo-b',
      memory_scope_kind: 'project',
      memory_scope_id: 'repo-b',
    }).event_index_id;
    const oldRawId = upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'm-old-seed',
      channel: 'C-eng',
      title: 'Old seed',
      content: 'Out-of-window seed raw context.',
      event_datetime: 900,
      source_timestamp_ms: 900,
      tenant_id: 'default',
      project_id: 'repo-a',
      memory_scope_kind: 'project',
      memory_scope_id: 'repo-a',
    }).event_index_id;
    const boundary = {
      scopes: [{ kind: 'project' as const, id: 'repo-a' }],
      connectors: ['slack'],
      project_refs: [{ kind: 'project' as const, id: 'repo-a' }],
      tenant_id: 'default',
      as_of: 2_000,
    };
    const readMemoryCandidates = vi.fn(async () => EMPTY_RESULT);

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: hiddenRawId }],
        },
        compilerDeps({
          adapter,
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/visible/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();

    await expect(
      compileContext(
        {
          task: 'compile branch context',
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: oldRawId }],
          range: { start_ms: 1_000 },
        },
        compilerDeps({
          adapter,
          boundary,
          readMemoryCandidates,
        })
      )
    ).rejects.toThrow(/visible/i);
    expect(readMemoryCandidates).not.toHaveBeenCalled();

    const packet = await compileContext(
      {
        task: 'compile branch context',
        seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: visibleRawId }],
        max_tool_calls: 0,
      },
      compilerDeps({
        adapter,
        boundary,
        readMemoryCandidates,
      })
    );

    expect(packet.source_refs).toContainEqual({
      kind: 'raw',
      connector: 'slack',
      raw_id: visibleRawId,
    });
  });
});
