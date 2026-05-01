import { describe, expect, it } from 'vitest';

import type {
  ContextCandidate,
  HiddenCandidateAggregate,
} from '../../src/context-compile/source-readers.js';
import { applyContextCompilerPolicy } from '../../src/context-compile/compiler-policy.js';

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

function hidden(overrides: Partial<HiddenCandidateAggregate> = {}): HiddenCandidateAggregate {
  return {
    total: 0,
    by_kind: {},
    by_reason: {},
    ...overrides,
  };
}

describe('STORY-CC-B4: deterministic context compiler policy - AC1, AC2, AC3', () => {
  it('selects confirmed evidence, dedupes refs, and keeps hidden ids out of public summaries', () => {
    const result = applyContextCompilerPolicy({
      task: 'compile branch context',
      candidates: [
        candidate(),
        candidate({ title: 'Duplicate lower score', score: 0.3 }),
        candidate({
          ref: { kind: 'raw', connector: 'slack', raw_id: 'raw-a' },
          title: 'Raw support',
          excerpt: 'Slack thread confirms the same implementation boundary.',
          score: 0.8,
          source: 'raw',
        }),
      ],
      hidden: hidden({
        total: 2,
        by_kind: { raw: 1, memory: 1 },
        by_reason: { scope: 1, timestamp_missing: 1 },
      }),
      limit: 5,
      strictness: 'medium',
      max_tokens: 1_000,
    });

    expect(result.selected_evidence.map((item) => item.ref)).toEqual([
      { kind: 'memory', id: 'mem-a' },
      { kind: 'raw', connector: 'slack', raw_id: 'raw-a' },
    ]);
    expect(result.source_refs).toEqual(result.selected_evidence.map((item) => item.ref));
    expect(result.related_decisions).toContainEqual({
      memory_id: 'mem-a',
      title: 'Primary memory',
    });
    expect(result.rejected_summary).toContain('deduplicated duplicate candidates: 1');
    expect(result.caveats).toContain('hidden candidates omitted: 2');
    expect(JSON.stringify(result)).not.toContain('timestamp_missing:raw-hidden');
  });

  it('rejects vector-only candidates under high strictness', () => {
    const result = applyContextCompilerPolicy({
      task: 'compile branch context',
      candidates: [
        candidate({
          ref: { kind: 'memory', id: 'mem-vector-only' },
          title: 'Vector-only hit',
          score: 0.95,
          support: {
            retrieval_source: 'vector_search',
            is_vector_only: true,
            lexical_support: false,
            confirmation_signals: [],
            metadata_signals: ['graph_primary'],
          },
        }),
      ],
      hidden: hidden(),
      limit: 5,
      strictness: 'high',
      max_tokens: 1_000,
    });

    expect(result.selected_evidence).toEqual([]);
    expect(result.rejected_refs).toEqual([{ kind: 'memory', id: 'mem-vector-only' }]);
    expect(result.rejected_summary).toContain('strictness rejected vector-only candidates: 1');
  });

  it('truncates by token budget and records rejected refs without leaking excerpts', () => {
    const result = applyContextCompilerPolicy({
      task: 'compile branch context',
      candidates: [
        candidate({ ref: { kind: 'memory', id: 'mem-short' }, excerpt: 'short evidence' }),
        candidate({
          ref: { kind: 'case', id: 'case-long' },
          title: 'Long case',
          excerpt: 'long hidden-ish case excerpt '.repeat(80),
          score: 0.7,
          source: 'graph',
        }),
      ],
      hidden: hidden(),
      limit: 5,
      strictness: 'medium',
      max_tokens: 20,
    });

    expect(result.selected_evidence.map((item) => item.ref)).toEqual([
      { kind: 'memory', id: 'mem-short' },
    ]);
    expect(result.rejected_refs).toContainEqual({ kind: 'case', id: 'case-long' });
    expect(result.retrieval_diagnostics).toMatchObject({ truncated_by_tokens: true });
    expect(JSON.stringify(result.rejected_summary)).not.toContain('long hidden-ish');
  });
});
