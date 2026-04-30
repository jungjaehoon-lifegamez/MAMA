import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAMAServer } from '../../src/server.js';

const require = createRequire(import.meta.url);
const mama = require('@jungjaehoon/mama-core/mama-api');

describe('MCP search quality options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes strict search options through to mama.suggest', async () => {
    vi.spyOn(mama, 'suggest').mockResolvedValue({ results: [] });
    vi.spyOn(mama, 'listCheckpoints').mockResolvedValue([]);

    const server = new MAMAServer();
    await server.handleSearch({
      query: 'context compile',
      type: 'decision',
      limit: 3,
      threshold: 0.55,
      strict: true,
      strictness: 'strict',
      disableRecency: true,
      includeRelated: false,
      topicPrefix: 'north-star',
      minLexicalSupport: true,
      diagnostics: true,
    });

    expect(mama.suggest).toHaveBeenCalledWith(
      'context compile',
      expect.objectContaining({
        limit: 3,
        threshold: 0.55,
        strict: true,
        strictness: 'strict',
        disableRecency: true,
        includeRelated: false,
        topicPrefix: 'north-star',
        minLexicalSupport: true,
        diagnostics: true,
      })
    );
  });

  it('preserves diagnostics from mama.suggest in the search response', async () => {
    vi.spyOn(mama, 'suggest').mockResolvedValue({
      diagnostics: {
        candidate_counts: {
          vector: 1,
          lexical: 1,
          entity: 0,
          graph_expanded: 0,
          vector_only: 0,
          rejected_by_strictness: 0,
        },
        threshold: 0.45,
        strictness: 'balanced',
      },
      results: [
        {
          id: 'decision_diagnostic',
          topic: 'diagnostic topic',
          decision: 'Diagnostic decision',
          created_at: 1,
          retrieval_diagnostics: {
            lexical_support: true,
            is_vector_only: false,
          },
        },
      ],
    });
    vi.spyOn(mama, 'listCheckpoints').mockResolvedValue([]);

    const server = new MAMAServer();
    const result = await server.handleSearch({
      query: 'diagnostic topic',
      type: 'decision',
      diagnostics: true,
    });

    expect(result).toMatchObject({
      success: true,
      diagnostics: {
        threshold: 0.45,
        strictness: 'balanced',
      },
      results: [
        expect.objectContaining({
          id: 'decision_diagnostic',
          retrieval_diagnostics: expect.objectContaining({
            lexical_support: true,
          }),
        }),
      ],
    });
  });
});
