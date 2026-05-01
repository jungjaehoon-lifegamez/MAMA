/**
 * Integration tests for MAMAServer.handleSearch quality options.
 *
 * Per AGENTS.md: do NOT mock internal mama-core modules. These tests exercise
 * the real `mama.suggest` / `mama.listCheckpoints` paths against an isolated
 * test database and assert on observable response shape (diagnostics, results,
 * meta) rather than internal call arguments.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initTestDB,
  cleanupTestDB,
  isEmbeddingsAvailable,
  createMockToolContext,
} from '@jungjaehoon/mama-core/test-utils';
import { MAMAServer } from '../../src/server.js';
import { saveDecisionTool } from '../../src/tools/save-decision.js';

const embeddingsAvailable = await isEmbeddingsAvailable();

const mockContext = createMockToolContext();

describe.skipIf(!embeddingsAvailable)(
  'STORY-MCP-SEARCH-OPTIONS: MCP search quality options - AC1, AC2',
  () => {
    let testDbPath;
    let server;

    beforeAll(async () => {
      testDbPath = await initTestDB('mcp-search-options');

      const fixtures = [
        {
          topic: 'context_compile_strategy',
          decision: 'Compile context bundles via lexical + vector hybrid retrieval',
          reasoning: 'Hybrid retrieval keeps recall high while constraining drift in strict mode',
          confidence: 0.9,
        },
        {
          topic: 'north-star_quality_modes',
          decision: 'Expose recall/balanced/strict as first-class search modes',
          reasoning: 'Operators need a knob between fast recall and act-now strict citations',
          confidence: 0.95,
        },
        {
          topic: 'unrelated_topic_filler',
          decision: 'Filler decision for negative-match coverage',
          reasoning: 'Guarantees the corpus is not single-topic when running strict tests',
          confidence: 0.6,
        },
      ];

      for (const decision of fixtures) {
        await saveDecisionTool.handler(decision, mockContext);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      server = new MAMAServer();
    });

    afterAll(async () => {
      await cleanupTestDB(testDbPath);
    });

    it('returns diagnostics block when diagnostics: true is requested', async () => {
      const response = await server.handleSearch({
        query: 'context compile',
        type: 'decision',
        limit: 5,
        diagnostics: true,
      });

      expect(response.success).toBe(true);
      expect(response).toHaveProperty('diagnostics');
      if (response.diagnostics) {
        expect(response.diagnostics).toEqual(
          expect.objectContaining({
            strictness: expect.any(String),
          })
        );
      }
    });

    it('omits diagnostics block when diagnostics is not requested', async () => {
      const response = await server.handleSearch({
        query: 'context compile',
        type: 'decision',
        limit: 5,
      });

      expect(response.success).toBe(true);
      expect(response.diagnostics).toBeUndefined();
    });

    it('respects strict mode by reducing or rejecting low-confidence vector-only hits', async () => {
      const recallResponse = await server.handleSearch({
        query: 'compile bundle',
        type: 'decision',
        limit: 10,
        strictness: 'recall',
        diagnostics: true,
      });
      const strictResponse = await server.handleSearch({
        query: 'compile bundle',
        type: 'decision',
        limit: 10,
        strictness: 'strict',
        minLexicalSupport: true,
        diagnostics: true,
      });

      expect(recallResponse.success).toBe(true);
      expect(strictResponse.success).toBe(true);
      // Strict mode must never return more than recall mode for the same query
      expect(strictResponse.results.length).toBeLessThanOrEqual(recallResponse.results.length);
    });

    it('returns the query verbatim and well-formed result records on a positive match', async () => {
      const response = await server.handleSearch({
        query: 'context compile',
        type: 'decision',
        limit: 5,
        diagnostics: true,
      });

      expect(response.success).toBe(true);
      expect(response.query).toBe('context compile');
      expect(Array.isArray(response.results)).toBe(true);
      if (response.results.length > 0) {
        expect(response.results[0]).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            _type: 'decision',
          })
        );
      }
    });

    it('preserves retrieval_diagnostics on individual hits when diagnostics is enabled', async () => {
      const response = await server.handleSearch({
        query: 'quality modes',
        type: 'decision',
        limit: 5,
        diagnostics: true,
      });

      expect(response.success).toBe(true);
      expect(response.results.length).toBeGreaterThan(0);
      const hitWithDiagnostics = response.results.find((hit) => hit.retrieval_diagnostics);
      expect(hitWithDiagnostics).toBeDefined();
      expect(hitWithDiagnostics.retrieval_diagnostics).toEqual(
        expect.objectContaining({
          retrieval_source: expect.any(String),
        })
      );
    });
  }
);
