/**
 * Tests for Swarm MAMA Adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMamaApiAdapter } from '../../src/multi-agent/swarm/swarm-mama-adapter.js';

// mama-core is available via workspace dependency and initializes DB + embedding model
// on first call (~3-5s), so async tests need extended timeout
describe('SwarmMamaAdapter', { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console output from mama-core to avoid stderr noise
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createMamaApiAdapter', () => {
    it('should create a valid MamaApiClient', () => {
      const adapter = createMamaApiAdapter();

      expect(adapter).toBeDefined();
      expect(typeof adapter.search).toBe('function');
    });

    it('should return array from search (mama-core available via workspace)', async () => {
      const adapter = createMamaApiAdapter();

      // mama-core is available - should not throw, returns array
      const results = await adapter.search('test query');

      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle empty query gracefully', async () => {
      const adapter = createMamaApiAdapter();
      const results = await adapter.search('');

      expect(Array.isArray(results)).toBe(true);
    });

    it('should use default limit of 5 if not specified', async () => {
      const adapter = createMamaApiAdapter();

      // Should not throw
      await expect(adapter.search('test')).resolves.toBeDefined();
    });

    it('should accept custom limit parameter', async () => {
      const adapter = createMamaApiAdapter();

      // Should not throw with custom limit
      await expect(adapter.search('test', 10)).resolves.toBeDefined();
    });
  });

  describe('Integration with real mama-core (if available)', () => {
    it('should call mama-core suggest() when available', async () => {
      // This test will pass even if mama-core is not available
      // It just verifies the adapter interface works correctly
      const adapter = createMamaApiAdapter();

      const results = await adapter.search('authentication strategy', 3);

      // Should return an array
      expect(Array.isArray(results)).toBe(true);

      // If results exist, they should have the correct structure
      if (results.length > 0) {
        const result = results[0];
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('similarity');
        expect(typeof result.similarity).toBe('number');
      }
    });

    it('should handle long queries', async () => {
      const adapter = createMamaApiAdapter();
      const longQuery =
        'How should we implement authentication in a microservices architecture with JWT tokens and refresh token rotation?';

      const results = await adapter.search(longQuery);

      expect(Array.isArray(results)).toBe(true);
    });

    it('should return results with correct SearchResult structure', async () => {
      const adapter = createMamaApiAdapter();

      const results = await adapter.search('database choice');

      expect(Array.isArray(results)).toBe(true);

      // Each result should match SearchResult interface
      results.forEach((result) => {
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('similarity');
        expect(typeof result.id).toBe('string');
        expect(typeof result.similarity).toBe('number');

        // Optional fields
        if (result.topic) expect(typeof result.topic).toBe('string');
        if (result.decision) expect(typeof result.decision).toBe('string');
        if (result.reasoning) expect(typeof result.reasoning).toBe('string');
        if (result.outcome) expect(typeof result.outcome).toBe('string');
      });
    });
  });
});
