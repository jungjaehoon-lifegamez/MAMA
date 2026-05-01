import { describe, expect, it, vi } from 'vitest';

import type {
  ContextCandidate,
  ContextSourceReadResult,
} from '../../src/context-compile/source-readers.js';
import { compileContext } from '../../src/context-compile/compiler.js';
import type { ContextCompilerDeps } from '../../src/context-compile/compiler.js';

const EMPTY_RESULT: ContextSourceReadResult = {
  candidates: [],
  hidden: { total: 0, by_kind: {}, by_reason: {} },
  source_refs: [],
};

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
});
