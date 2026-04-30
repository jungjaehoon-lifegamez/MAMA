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
});
