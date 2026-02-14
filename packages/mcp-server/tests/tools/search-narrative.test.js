/**
 * Tests for search_narrative MCP tool
 *
 * Story 2.2: Narrative Search/Expansion
 * Tests semantic search with link expansion
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initTestDB,
  cleanupTestDB,
  isEmbeddingsAvailable,
  createMockToolContext,
} from '@jungjaehoon/mama-core/test-utils';
import { saveDecisionTool } from '../../src/tools/save-decision.js';
import { searchNarrativeTool } from '../../src/tools/search-narrative.js';

// Test database path (set by initTestDB)
let testDbPath;

// Check if embedding model is available (preloaded by globalSetup)
const embeddingsAvailable = await isEmbeddingsAvailable();

// Mock tool context
const mockContext = createMockToolContext();

describe('search_narrative MCP Tool', () => {
  beforeAll(async () => {
    // Initialize isolated test database (handles cleanup, env var, and init)
    testDbPath = await initTestDB('search-narrative');

    // Insert test decisions using save tool
    const testDecisions = [
      {
        topic: 'authentication_strategy',
        decision: 'Use JWT with refresh tokens for authentication',
        reasoning: 'JWT allows stateless authentication while refresh tokens provide security',
        evidence: JSON.stringify(['RFC 7519', 'OWASP best practices']),
        alternatives: JSON.stringify(['Session-based auth', 'OAuth2 only']),
        risks: 'Token theft if not properly secured',
        confidence: 0.9,
      },
      {
        topic: 'password_hashing',
        decision: 'Use bcrypt for password hashing with cost factor 12',
        reasoning: 'bcrypt is battle-tested and resistant to GPU attacks',
        evidence: JSON.stringify(['Security audit results', 'Performance benchmarks']),
        confidence: 0.95,
      },
      {
        topic: 'database_choice',
        decision: 'Use PostgreSQL for primary database',
        reasoning: 'Need ACID compliance and complex queries',
        evidence: JSON.stringify(['Load testing results', 'Team expertise']),
        confidence: 0.85,
      },
    ];

    for (const decision of testDecisions) {
      await saveDecisionTool.handler(decision, mockContext);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  afterAll(async () => {
    // Clean up test database (handles close, cleanup files, and env var)
    await cleanupTestDB(testDbPath);
  });

  describe('Input Validation', () => {
    it('should reject empty query', async () => {
      const result = await searchNarrativeTool.handler({ query: '' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
    });

    it('should reject invalid depth', async () => {
      const result = await searchNarrativeTool.handler({ query: 'test', depth: 3 }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('depth must be between 0 and 2');
    });

    it('should reject invalid limit', async () => {
      const result = await searchNarrativeTool.handler({ query: 'test', limit: 0 }, mockContext);
      expect(result.success).toBe(false);
      expect(result.message).toContain('limit must be between 1 and 20');
    });

    it('should reject invalid mode', async () => {
      const result = await searchNarrativeTool.handler(
        { query: 'test', mode: 'invalid' },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('mode must be full, summary, or minimal');
    });

    it('should reject invalid threshold', async () => {
      const result = await searchNarrativeTool.handler(
        { query: 'test', threshold: 1.5 },
        mockContext
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('threshold must be between 0.0 and 1.0');
    });
  });

  describe.skipIf(!embeddingsAvailable)('Semantic Search', () => {
    it('should find decisions by semantic search', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'authentication security',
          limit: 5,
          mode: 'full',
        },
        mockContext
      );

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Search Results');
      expect(result._data).toBeDefined();
      expect(result._data.results.length).toBeGreaterThan(0);
    });

    it('should respect limit parameter', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'database or authentication',
          limit: 1,
        },
        mockContext
      );

      expect(result._data.results.length).toBeLessThanOrEqual(1);
    });

    it('should return empty results for unrelated query', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'completely unrelated topic that definitely does not exist',
          threshold: 0.9,
        },
        mockContext
      );

      expect(result.content[0].text).toContain('No decisions found');
    });
  });

  describe.skipIf(!embeddingsAvailable)('Output Modes', () => {
    it('should format results in full mode', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'authentication',
          mode: 'full',
          limit: 1,
        },
        mockContext
      );

      expect(result._data).toBeDefined();
      const narrative = result._data.results[0].narrative;
      expect(narrative).toHaveProperty('decision');
      expect(narrative).toHaveProperty('reasoning');
      expect(narrative).toHaveProperty('evidence');
      expect(narrative).toHaveProperty('alternatives');
      expect(narrative).toHaveProperty('risks');
      expect(narrative).toHaveProperty('confidence');
    });

    it('should format results in summary mode', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'authentication',
          mode: 'summary',
          limit: 1,
        },
        mockContext
      );

      expect(result._data).toBeDefined();
      const narrative = result._data.results[0].narrative;
      expect(narrative).toHaveProperty('decision');
      expect(narrative).toHaveProperty('reasoning');
      expect(narrative).toHaveProperty('evidence');
      expect(narrative).not.toHaveProperty('alternatives'); // Not in summary
    });

    it('should format results in minimal mode', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'authentication',
          mode: 'minimal',
          limit: 1,
        },
        mockContext
      );

      expect(result._data).toBeDefined();
      const narrative = result._data.results[0].narrative;
      expect(narrative).toHaveProperty('topic');
      expect(narrative).toHaveProperty('decision');
      expect(narrative).not.toHaveProperty('reasoning'); // Not in minimal
      expect(narrative).not.toHaveProperty('evidence'); // Not in minimal
    });
  });

  describe.skipIf(!embeddingsAvailable)('Link Expansion', () => {
    it('should return no links when depth=0', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'authentication',
          depth: 0,
          limit: 1,
        },
        mockContext
      );

      expect(result._data).toBeDefined();
      expect(result._data.results[0].links).toEqual([]);
    });

    // Note: Link expansion tests require actual links in the test database
    // These would be added in a more comprehensive test setup
  });

  describe.skipIf(!embeddingsAvailable)('Metadata', () => {
    it('should include search metadata in response', async () => {
      const result = await searchNarrativeTool.handler(
        {
          query: 'test',
          depth: 1,
          limit: 5,
          mode: 'summary',
          threshold: 0.7,
        },
        mockContext
      );

      expect(result._data.metadata).toEqual({
        count: result._data.results.length,
        depth: 1,
        mode: 'summary',
        threshold: 0.7,
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle search errors gracefully', async () => {
      // This test ensures the tool doesn't crash on unexpected errors
      const result = await searchNarrativeTool.handler(
        {
          query: 'test query',
        },
        mockContext
      );

      // Should either succeed or return error message
      expect(result.content || result.message).toBeDefined();
    });
  });
});
