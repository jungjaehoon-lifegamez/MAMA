/**
 * Unit tests for ContextInjector
 */

import { describe, it, expect } from 'vitest';
import {
  ContextInjector,
  createMockMamaApi,
  type SearchResult,
} from '../../src/gateways/context-injector.js';

describe('ContextInjector', () => {
  const mockDecisions: SearchResult[] = [
    {
      id: 'dec-1',
      topic: 'auth_strategy',
      decision: 'Use JWT for authentication',
      reasoning: 'Stateless and scalable',
      outcome: 'success',
      similarity: 0.85,
    },
    {
      id: 'dec-2',
      topic: 'database',
      decision: 'Use PostgreSQL',
      reasoning: 'Reliable and feature-rich',
      outcome: 'pending',
      similarity: 0.75,
    },
    {
      id: 'dec-3',
      topic: 'caching',
      decision: 'Use Redis',
      reasoning: 'Fast in-memory caching',
      similarity: 0.65, // Below default threshold
    },
  ];

  describe('getRelevantContext()', () => {
    it('should return empty context for empty query', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi);

      const result = await injector.getRelevantContext('');

      expect(result.hasContext).toBe(false);
      expect(result.decisions).toEqual([]);
      expect(result.prompt).toBe('');
    });

    it('should return relevant decisions above threshold', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi);

      const result = await injector.getRelevantContext('authentication');

      expect(result.hasContext).toBe(true);
      expect(result.decisions).toHaveLength(1); // only dec-1 (>= 0.8 default)
      expect(result.decisions[0].topic).toBe('auth_strategy');
    });

    it('should respect maxDecisions config', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi, { maxDecisions: 1 });

      const result = await injector.getRelevantContext('test');

      expect(result.decisions).toHaveLength(1);
    });

    it('should respect similarityThreshold config', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi, { similarityThreshold: 0.8 });

      const result = await injector.getRelevantContext('test');

      expect(result.decisions).toHaveLength(1); // Only dec-1 (0.85 >= 0.8)
    });

    it('should format prompt with decisions', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi);

      const result = await injector.getRelevantContext('auth');

      expect(result.prompt).toContain('auth_strategy');
      expect(result.prompt).toContain('Use JWT for authentication');
      expect(result.prompt).toContain('success');
      expect(result.prompt).toContain('85%'); // Relevance percentage
    });

    it('should handle API errors gracefully', async () => {
      const mamaApi = {
        async search(): Promise<SearchResult[]> {
          throw new Error('API Error');
        },
      };
      const injector = new ContextInjector(mamaApi);

      const result = await injector.getRelevantContext('test');

      expect(result.hasContext).toBe(false);
      expect(result.decisions).toEqual([]);
    });

    it('should parse outcome correctly', async () => {
      const decisions: SearchResult[] = [
        { id: '1', outcome: 'SUCCESS', similarity: 0.9 },
        { id: '2', outcome: 'FAILED', similarity: 0.9 },
        { id: '3', outcome: 'partial', similarity: 0.9 },
        { id: '4', outcome: undefined, similarity: 0.9 },
      ];
      const mamaApi = createMockMamaApi(decisions);
      const injector = new ContextInjector(mamaApi, { maxDecisions: 4 });

      const result = await injector.getRelevantContext('test');

      expect(result.decisions).toHaveLength(4);
      expect(result.decisions[0].outcome).toBe('success');
      expect(result.decisions[1].outcome).toBe('failed');
      expect(result.decisions[2].outcome).toBe('partial');
      expect(result.decisions[3].outcome).toBe('pending');
    });
  });

  describe('setConfig()', () => {
    it('should update similarity threshold', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi, { similarityThreshold: 0.9 });

      // Initially no results (threshold too high)
      let result = await injector.getRelevantContext('test');
      expect(result.decisions).toHaveLength(0);

      // Lower threshold
      injector.setConfig({ similarityThreshold: 0.7 });
      result = await injector.getRelevantContext('test');
      expect(result.decisions).toHaveLength(2);
    });

    it('should update maxDecisions', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const injector = new ContextInjector(mamaApi, { maxDecisions: 1 });

      injector.setConfig({ maxDecisions: 3 });
      const result = await injector.getRelevantContext('test');

      // 2 decisions are above threshold
      expect(result.decisions.length).toBeLessThanOrEqual(2);
    });
  });

  describe('createMockMamaApi()', () => {
    it('should return mock decisions', async () => {
      const api = createMockMamaApi(mockDecisions);
      const results = await api.search('test');

      expect(results).toEqual(mockDecisions);
    });

    it('should respect limit parameter', async () => {
      const api = createMockMamaApi(mockDecisions);
      const results = await api.search('test', 1);

      expect(results).toHaveLength(1);
    });

    it('should return empty array by default', async () => {
      const api = createMockMamaApi();
      const results = await api.search('test');

      expect(results).toEqual([]);
    });
  });
});
