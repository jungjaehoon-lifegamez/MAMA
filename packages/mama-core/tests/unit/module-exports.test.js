/**
 * Core Module Exports Test
 * Story M1.1: Verify all core modules export expected functions/classes
 *
 * AC: Each module still exports the same public functions/classes that
 * mcp-server consumers rely on.
 */

import { describe, it, expect } from 'vitest';

describe('Story M1.1: Core Module Exports', () => {
  describe('mama-api.js exports', () => {
    it('should export mama object with required methods', async () => {
      const mama = await import('../../src/mama-api.js');

      expect(mama.default).toBeDefined();
      expect(typeof mama.default.save).toBe('function');
      expect(typeof mama.default.recall).toBe('function');
      expect(typeof mama.default.list).toBe('function');
      expect(typeof mama.default.suggest).toBe('function');
      expect(typeof mama.default.updateOutcome).toBe('function');
    });
  });

  describe('embeddings.js exports', () => {
    it('should export generateEmbedding function', async () => {
      const embeddings = await import('../../src/embeddings.js');

      expect(embeddings.generateEmbedding).toBeDefined();
      expect(typeof embeddings.generateEmbedding).toBe('function');
    });
  });

  describe('decision-tracker.js exports', () => {
    it('should export learnDecision function', async () => {
      const tracker = await import('../../src/decision-tracker.js');

      expect(tracker.learnDecision).toBeDefined();
      expect(typeof tracker.learnDecision).toBe('function');
    });
  });

  describe('outcome-tracker.js exports', () => {
    it('should export required functions', async () => {
      const outcome = await import('../../src/outcome-tracker.js');

      expect(outcome.analyzeOutcome).toBeDefined();
      expect(outcome.markOutcome).toBeDefined();
      expect(typeof outcome.analyzeOutcome).toBe('function');
      expect(typeof outcome.markOutcome).toBe('function');
    });
  });

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

  describe('memory-store.js exports', () => {
    it('should export required functions', async () => {
      const store = await import('../../src/memory-store.js');

      expect(store.queryDecisionGraph).toBeDefined();
      expect(store.getDB).toBeDefined();
      expect(store.getAdapter).toBeDefined();
      expect(typeof store.queryDecisionGraph).toBe('function');
      expect(typeof store.getDB).toBe('function');
      expect(typeof store.getAdapter).toBe('function');
    });
  });

  describe('query-intent.js exports', () => {
    it('should export analyzeIntent function', async () => {
      const intent = await import('../../src/query-intent.js');

      expect(intent.analyzeIntent).toBeDefined();
      expect(typeof intent.analyzeIntent).toBe('function');
    });
  });

  describe('time-formatter.js exports', () => {
    it('should export formatTimeAgo function', async () => {
      const timeFormatter = await import('../../src/time-formatter.js');

      expect(timeFormatter.formatTimeAgo).toBeDefined();
      expect(typeof timeFormatter.formatTimeAgo).toBe('function');
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
