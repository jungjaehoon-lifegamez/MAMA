/**
 * Core Module Exports Test
 * Story M1.1: Verify all core modules export expected functions/classes
 *
 * AC: Each module still exports the same public functions/classes that
 * mcp-server consumers rely on.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

describe('Story M1.1: Core Module Exports', () => {
  describe('mama-api.js exports', () => {
    it('should export mama object with required methods', async () => {
      const mama = await import('../../src/mama-api.js');
      const namedFunctionExports = [
        'save',
        'suggest',
        'saveMemory',
        'recallMemory',
        'list',
        'listCheckpoints',
        'updateOutcome',
        'buildProfile',
        'ingestMemory',
        'ingestConversation',
        'buildMemoryBootstrap',
        'createAuditAck',
        'recordMemoryAudit',
        'upsertChannelSummary',
        'getChannelSummary',
        'listOpenAuditFindings',
        'getMemoryProvenance',
        'listMemoriesByEnvelopeHash',
        'listMemoriesByGatewayCallId',
        'listMemoriesByModelRunId',
        'listMemoryEventsForMemory',
        'listRecentMemoryEvents',
        'beginModelRun',
        'beginModelRun',
        'commitModelRun',
        'commitModelRun',
        'failModelRun',
        'failModelRun',
        'getModelRun',
        'getModelRun',
        'appendToolTrace',
        'listToolTracesForRun',
        'saveCheckpoint',
        'loadCheckpoint',
        'recall',
        'expandWithGraph',
      ];
      const defaultFunctionExports = [
        ...namedFunctionExports.filter((exportName) => exportName !== 'listOpenAuditFindings'),
        'listAuditFindings',
      ];

      expect(mama.default).toBeDefined();
      for (const exportName of defaultFunctionExports) {
        expect(typeof mama.default[exportName]).toBe('function');
      }
      for (const exportName of namedFunctionExports) {
        expect(typeof mama[exportName]).toBe('function');
      }
    });
  });

  describe('package root model-run exports', () => {
    it('should export model run and tool trace helpers', async () => {
      const core = await import('../../src/index.js');

      expect(typeof core.beginModelRun).toBe('function');
      expect(typeof core.beginModelRun).toBe('function');
      expect(typeof core.commitModelRun).toBe('function');
      expect(typeof core.commitModelRun).toBe('function');
      expect(typeof core.failModelRun).toBe('function');
      expect(typeof core.failModelRun).toBe('function');
      expect(typeof core.getModelRun).toBe('function');
      expect(typeof core.getModelRun).toBe('function');
      expect(typeof core.appendToolTrace).toBe('function');
      expect(typeof core.listToolTracesForRun).toBe('function');
    });
  });

  describe('package root memory compatibility exports', () => {
    it('exposes no host edge rules: the agent states every link', async () => {
      const core = await import('../../src/index.js');
      expect(core.evolveMemory).toBeUndefined();
      expect(core.promoteMemoryStatus).toBeUndefined();
      expect(core.insertTwinEdge).toBeUndefined();
    });
  });

  describe('package root scope exports', () => {
    // The context-compile subsystem is gone. What the root still owes from it is scope
    // identity, which moved to memory/types with the type it canonicalizes.
    it('should export scope canonicalization', async () => {
      const core = await import('../../src/index.js');

      expect(typeof core.canonicalizeContextScopes).toBe('function');
    });

    it('should no longer expose the context-compile subpath', () => {
      const packageJson = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
      );

      expect(packageJson.exports['./context-compile']).toBeUndefined();
    });
  });

  describe('embeddings.js exports', () => {
    it('should export generateEmbedding function', async () => {
      const embeddings = await import('../../src/embedding/embedder.js');

      expect(embeddings.generateEmbedding).toBeDefined();
      expect(typeof embeddings.generateEmbedding).toBe('function');
    });
  });

  // decision-tracker.js stood here, and time-formatter.js below. W22 deleted
  // both: nothing outside the barrel imported them, and a module test that
  // imports a file only this test imports is checking that the file compiles.

  describe('decision-formatter.js exports', () => {
    it('should export formatting functions', async () => {
      const formatter = await import('../../src/decision-formatter.js');

      expect(formatter.formatRecall).toBeDefined();
      expect(formatter.formatList).toBeDefined();
      expect(typeof formatter.formatRecall).toBe('function');
      expect(typeof formatter.formatList).toBe('function');
    });
  });

  describe('relevance-scorer.js exports', () => {
    it('should export scoring functions', async () => {
      const scorer = await import('../../src/relevance-scorer.js');

      expect(scorer.calculateRelevance).toBeDefined();
      expect(scorer.selectTopDecisions).toBeDefined();
      expect(typeof scorer.calculateRelevance).toBe('function');
      expect(typeof scorer.selectTopDecisions).toBe('function');
    });
  });

  describe('db-manager.js exports', () => {
    it('should export required functions', async () => {
      const store = await import('../../src/db-manager.js');

      expect(store.getDB).toBeDefined();
      expect(store.getAdapter).toBeDefined();
      expect(typeof store.getDB).toBe('function');
      expect(typeof store.getAdapter).toBe('function');
    });
  });

  describe('knowledge read surface exports', () => {
    it('should export the decision read queries', async () => {
      const queries = await import('../../src/knowledge/index.js');

      for (const name of [
        'vectorSearch',
        'queryDecisionGraph',
        'querySemanticEdges',
        'fts5Search',
      ]) {
        expect(typeof queries[name]).toBe('function');
      }
    });
  });

  describe('debug-logger.js exports', () => {
    it('should export logging functions', async () => {
      const logger = await import('../../src/debug-logger.js');

      expect(logger.info).toBeDefined();
      expect(logger.error).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
    });
  });
});
