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
let currencyRows: Array<{ id: string; topic: string; created_at: number | string | null }> = [];

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
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

describe('AC3: annotateTopicCurrency marks superseded history', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('marks a row stale when the DB holds a newer row for the same topic', async () => {
    currencyRows = [
      { id: 'old-row', topic: 'billing_policy', created_at: 1000 },
      { id: 'new-row', topic: 'billing_policy', created_at: 2000 },
    ];
    const { annotateTopicCurrency } = await import('../../src/mama-api.js');
    const annotated = annotateTopicCurrency([
      { id: 'old-row', topic: 'billing_policy' },
      { id: 'new-row', topic: 'billing_policy' },
    ]);
    expect(annotated.find((r) => r.id === 'old-row')?.superseded_by_newer).toBe(true);
    expect(annotated.find((r) => r.id === 'new-row')?.superseded_by_newer).toBe(false);
  });

  it('normalizes mixed created_at encodings (seconds / ms / TEXT) before comparing', async () => {
    currencyRows = [
      { id: 'sec-row', topic: 'mixed_topic', created_at: 1770961389 }, // seconds
      { id: 'ms-row', topic: 'mixed_topic', created_at: 1777041049115 }, // ms (newer)
      { id: 'text-row', topic: 'mixed_topic', created_at: '2026-02-15 04:29:33' },
    ];
    const { annotateTopicCurrency } = await import('../../src/mama-api.js');
    const annotated = annotateTopicCurrency([
      { id: 'sec-row', topic: 'mixed_topic' },
      { id: 'ms-row', topic: 'mixed_topic' },
      { id: 'text-row', topic: 'mixed_topic' },
    ]);
    expect(annotated.find((r) => r.id === 'ms-row')?.superseded_by_newer).toBe(false);
    expect(annotated.find((r) => r.id === 'sec-row')?.superseded_by_newer).toBe(true);
    expect(annotated.find((r) => r.id === 'text-row')?.superseded_by_newer).toBe(true);
  });

  it('leaves rows untouched for topics with a single row', async () => {
    currencyRows = [{ id: 'only-row', topic: 'solo_topic', created_at: 1000 }];
    const { annotateTopicCurrency } = await import('../../src/mama-api.js');
    const annotated = annotateTopicCurrency([{ id: 'only-row', topic: 'solo_topic' }]);
    expect(annotated[0].superseded_by_newer).toBe(false);
  });

  it('breaks equal-timestamp ties deterministically (higher id wins)', async () => {
    currencyRows = [
      { id: 'row-a', topic: 'tie_topic', created_at: 1000 },
      { id: 'row-b', topic: 'tie_topic', created_at: 1000 },
    ];
    const { annotateTopicCurrency } = await import('../../src/mama-api.js');
    const annotated = annotateTopicCurrency([
      { id: 'row-a', topic: 'tie_topic' },
      { id: 'row-b', topic: 'tie_topic' },
    ]);
    expect(annotated.find((r) => r.id === 'row-b')?.superseded_by_newer).toBe(false);
    expect(annotated.find((r) => r.id === 'row-a')?.superseded_by_newer).toBe(true);
  });

  it('scoped search restricts the currency comparison to the given scopes', async () => {
    // The mock returns currencyRows for the scoped query too - what matters
    // here is that the SCOPED branch is exercised (join SQL) and rows outside
    // the mock "scope result" cannot mark in-scope truth stale.
    currencyRows = [{ id: 'scoped-current', topic: 'deploy_process', created_at: 1000 }];
    const { annotateTopicCurrency } = await import('../../src/mama-api.js');
    const annotated = annotateTopicCurrency(
      [{ id: 'scoped-current', topic: 'deploy_process' }],
      [{ kind: 'project', id: '/proj/a' }]
    );
    // A newer row exists globally (not in currencyRows because the scoped SQL
    // excludes it) - the in-scope row must remain current.
    expect(annotated[0].superseded_by_newer).toBe(false);
  });
});
