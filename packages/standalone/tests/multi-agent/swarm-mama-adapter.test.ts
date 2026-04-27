/**
 * Tests for Swarm MAMA Adapter
 */

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMamaApiAdapter } from '../../src/multi-agent/swarm/swarm-mama-adapter.js';

describe('SwarmMamaAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMamaApiAdapter', () => {
    it('creates a valid MamaApiClient', () => {
      const adapter = createMamaApiAdapter({ suggest: vi.fn() });

      expect(adapter).toBeDefined();
      expect(typeof adapter.search).toBe('function');
    });

    it('calls mama-core suggest with JSON search options', async () => {
      const suggest = vi.fn().mockResolvedValue({
        query: 'authentication strategy',
        results: [
          {
            id: 'decision_1',
            topic: 'auth',
            decision: 'Use session tokens',
            reasoning: 'Keeps browser auth simple',
            outcome: 'ONGOING',
            similarity: 0.91,
          },
        ],
      });
      const adapter = createMamaApiAdapter({ suggest });

      const results = await adapter.search('authentication strategy', 3);

      expect(suggest).toHaveBeenCalledWith('authentication strategy', {
        format: 'json',
        limit: 3,
        threshold: 0.6,
        useReranking: false,
      });
      expect(results).toEqual([
        {
          id: 'decision_1',
          topic: 'auth',
          decision: 'Use session tokens',
          reasoning: 'Keeps browser auth simple',
          outcome: 'ONGOING',
          similarity: 0.91,
        },
      ]);
    });

    it('uses default limit of 5 when no limit is specified', async () => {
      const suggest = vi.fn().mockResolvedValue({ query: 'database choice', results: [] });
      const adapter = createMamaApiAdapter({ suggest });

      await adapter.search('database choice');

      expect(suggest).toHaveBeenCalledWith(
        'database choice',
        expect.objectContaining({ limit: 5 })
      );
    });

    it('returns an empty array with an explicit warning when suggest is unavailable', async () => {
      const adapter = createMamaApiAdapter({});

      const results = await adapter.search('test query');

      expect(results).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        '[SwarmMamaAdapter] mama-core suggest() not available'
      );
    });

    it('exercises the production dynamic require fallback path', async () => {
      const suggest = vi.fn().mockResolvedValue({
        query: 'test query',
        results: [],
      });
      const requireFromTest = createRequire(import.meta.url);
      const nodeModule = requireFromTest('node:module') as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
      };
      const originalLoad = nodeModule._load;
      const loadSpy = vi
        .spyOn(nodeModule, '_load')
        .mockImplementation((request: string, parent: unknown, isMain: boolean): unknown => {
          if (request === '@jungjaehoon/mama-core/mama-api') {
            return { suggest };
          }

          return originalLoad(request, parent, isMain);
        });
      const adapter = createMamaApiAdapter();

      const results = await adapter.search('test query');

      expect(results).toEqual([]);
      expect(
        loadSpy.mock.calls.some(([request]) => request === '@jungjaehoon/mama-core/mama-api')
      ).toBe(true);
      expect(suggest).toHaveBeenCalledWith('test query', {
        format: 'json',
        limit: 5,
        threshold: 0.6,
        useReranking: false,
      });
    });

    it('returns an empty array with an explicit warning when search fails', async () => {
      const error = new Error('embedding disabled for tests');
      const adapter = createMamaApiAdapter({
        suggest: vi.fn().mockRejectedValue(error),
      });

      const results = await adapter.search('test query');

      expect(results).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('[SwarmMamaAdapter] Failed to search MAMA:', error);
    });
  });
});
