/**
 * Delta-bench retrieval repair (2026-07-19): topic-anchored recall.
 *
 * Story: a query that IS a topic string must surface that topic's own rows,
 * and consumers must be able to tell current truth from superseded history.
 * Before the repair: topicHit@5 57.5% / currentPresent@5 50% on the real
 * dev-DB corpus; after: 82.5% / 77.5% (eval/delta-bench in memorybench).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();

let decisionRows: Array<Record<string, unknown>> = [];
const currencyRows: Array<{ id: string; topic: string; created_at: number | string | null }> = [];

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateEnhancedEmbedding: generateEmbeddingMock,
  isForceTier3Enabled: () => false,
}));

vi.mock('../../src/db-manager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    initDB: vi.fn(async () => {}),
    getAdapter: vi.fn(() => ({
      prepare(sql: string) {
        return {
          all: (..._args: unknown[]) => {
            if (sql.includes('FROM memory_scope_bindings')) {
              return [];
            }
            if (sql.includes('WHERE topic IN') || sql.includes('d.topic IN')) {
              return currencyRows;
            }
            if (sql.includes('FROM decisions')) {
              return decisionRows;
            }
            return [];
          },
          get: (..._args: unknown[]) => undefined,
        };
      },
    })),
    insertDecisionWithEmbedding: vi.fn(),
    ensureMemoryScope: vi.fn(async () => 1),
    vectorSearch: vectorSearchMock,
    fts5Search: vi.fn(async () => []),
  };
});

function decisionRow(id: string, topic: string, decision: string, created_at: number) {
  return {
    id,
    topic,
    decision,
    reasoning: 'reasoning text',
    confidence: 0.8,
    created_at,
    updated_at: created_at,
    trust_context: null,
    kind: 'decision',
    status: 'active',
    summary: decision,
  };
}

describe('AC1: topicAffinityBoost math', () => {
  it('scores exact topic match > all-tokens-in-topic > partial > none', async () => {
    const { topicAffinityBoost, getLexicalQueryTokens } = await import('../../src/memory/api.js');
    const tokens = getLexicalQueryTokens('operator report cadence');
    const exact = topicAffinityBoost('operator_report_cadence', tokens, 'operator report cadence');
    const partial = topicAffinityBoost(
      'operator_console_design',
      tokens,
      'operator report cadence'
    );
    const none = topicAffinityBoost('billing_policy', tokens, 'operator report cadence');
    expect(exact).toBeGreaterThan(2);
    expect(partial).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(partial);
    expect(none).toBe(0);
  });

  it('returns 0 for empty token lists instead of a spurious boost', async () => {
    const { topicAffinityBoost } = await import('../../src/memory/api.js');
    expect(topicAffinityBoost('any_topic', [], 'query')).toBe(0);
  });
});

describe('AC2: topic-anchored recall ranks the topic own rows above body-text noise', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    generateEmbeddingMock.mockResolvedValue(new Float32Array(8));
    vectorSearchMock.mockResolvedValue([]);
    decisionRows = [
      // Newer noise: mentions the query tokens only in the body text.
      decisionRow(
        'noise-1',
        'unrelated_launch_notes',
        'The operator report cadence discussion moved to another channel this week.',
        4000
      ),
      decisionRow(
        'noise-2',
        'another_meeting_log',
        'We talked about the operator report cadence briefly and postponed it.',
        3000
      ),
      // The queried topic's own rows (older than the noise).
      decisionRow(
        'target-old',
        'operator_report_cadence',
        'Reports go out weekly on Mondays.',
        1000
      ),
      decisionRow('target-new', 'operator_report_cadence', 'Reports go out daily at 08:00.', 2000),
    ];
  });

  it('puts operator_report_cadence rows at the top for the topic query', async () => {
    const { recallMemory } = await import('../../src/memory/api.js');
    const bundle = await recallMemory('operator report cadence', {
      limit: 2,
      includeProfile: false,
    });
    const topics = bundle.memories.map((m: { topic: string }) => m.topic);
    expect(topics[0]).toBe('operator_report_cadence');
    expect(topics[1]).toBe('operator_report_cadence');
  });
});
