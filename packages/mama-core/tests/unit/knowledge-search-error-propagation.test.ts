import { describe, expect, it } from 'vitest';
import { fts5Search, vectorSearch } from '../../src/knowledge/search.js';
import { queryDecisionGraph } from '../../src/knowledge/graph-query.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';

/**
 * Until these modules were split out of db-manager.ts, three read paths
 * answered a failure with the same value a genuinely empty corpus produces.
 * A caller could not tell "nothing matched" from "the read did not run", and
 * every consumer - MCP search, the plugin hooks, recall - took the second for
 * the first.
 */

function failingAdapter(failure: Error, on: 'vectorSearch' | 'prepare'): DatabaseAdapter {
  return {
    vectorSearch: () => {
      if (on === 'vectorSearch') throw failure;
      return [];
    },
    prepare: () => {
      if (on === 'prepare') throw failure;
      return { get: () => undefined, all: () => [], run: () => undefined };
    },
  } as unknown as DatabaseAdapter;
}

function emptyCorpusAdapter(): DatabaseAdapter {
  return {
    vectorSearch: () => [],
    prepare: () => ({ get: () => undefined, all: () => [], run: () => undefined }),
  } as unknown as DatabaseAdapter;
}

function corruptRefinedFromAdapter(): DatabaseAdapter {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: () =>
        sql.includes('decision_edges')
          ? []
          : [{ id: 'decision-1', topic: 't', decision: 'd', created_at: 1, refined_from: '{oops' }],
      run: () => undefined,
    }),
  } as unknown as DatabaseAdapter;
}

describe('Story PR4C: a failed read is never reported as an empty one', () => {
  describe('AC #1: vectorSearch surfaces adapter failure', () => {
    it('rejects with the adapter error instead of resolving to []', async () => {
      const failure = new Error('no such table: embeddings');

      await expect(
        vectorSearch(failingAdapter(failure, 'vectorSearch'), [0.1, 0.2], 5, 0.5)
      ).rejects.toThrow('no such table: embeddings');
    });

    it('still resolves to [] when the corpus genuinely holds no match', async () => {
      await expect(vectorSearch(emptyCorpusAdapter(), [0.1, 0.2], 5, 0.5)).resolves.toEqual([]);
    });
  });

  describe('AC #2: fts5Search separates an absent table from a broken adapter', () => {
    it('rejects when the table lookup itself fails', async () => {
      const failure = new Error('database connection is closed');

      await expect(fts5Search(failingAdapter(failure, 'prepare'), 'anything', 5)).rejects.toThrow(
        'database connection is closed'
      );
    });

    it('resolves to [] when the FTS table is simply not there', async () => {
      await expect(fts5Search(emptyCorpusAdapter(), 'anything', 5)).resolves.toEqual([]);
    });
  });

  describe('AC #3: queryDecisionGraph reports unreadable ancestry', () => {
    it('names the decision instead of returning it with empty refined_from', async () => {
      await expect(queryDecisionGraph(corruptRefinedFromAdapter(), 'a-topic')).rejects.toThrow(
        /decision-1 has unreadable refined_from/
      );
    });
  });
});
