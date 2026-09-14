import { describe, expect, it } from 'vitest';
import { vectorSearch } from '../../src/knowledge/search.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';

/**
 * Until this module was split out of db-manager.ts, vectorSearch wrapped its
 * whole body in `catch { logError(...); return []; }`. A caller could not tell
 * "the corpus held nothing above the threshold" from "the search failed", and
 * every consumer - MCP search, the plugin hooks, recall - read the second as
 * the first. An empty result is now only ever the first.
 */

function adapterThatFails(failure: Error): DatabaseAdapter {
  return {
    vectorSearch: () => {
      throw failure;
    },
    prepare: () => {
      throw new Error('prepare should not be reached once the search itself failed');
    },
  } as unknown as DatabaseAdapter;
}

function adapterWithNoMatches(): DatabaseAdapter {
  return {
    vectorSearch: () => [],
    prepare: () => {
      throw new Error('prepare should not be reached when there are no candidate rows');
    },
  } as unknown as DatabaseAdapter;
}

describe('vectorSearch failure is not an empty result', () => {
  it('surfaces the adapter failure to the caller', async () => {
    const failure = new Error('no such table: embeddings');

    await expect(vectorSearch(adapterThatFails(failure), [0.1, 0.2], 5, 0.5)).rejects.toThrow(
      'no such table: embeddings'
    );
  });

  it('still returns an empty array when the corpus genuinely has no match', async () => {
    await expect(vectorSearch(adapterWithNoMatches(), [0.1, 0.2], 5, 0.5)).resolves.toEqual([]);
  });
});
