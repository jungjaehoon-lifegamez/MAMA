/**
 * Integration Tests: MAMA Commands Suite
 *
 * Story M3.1: MAMA Commands Suite
 * Tests for /mama-save, /mama-recall, /mama-suggest, /mama-list, /mama-configure
 *
 * @module tests/commands/mama-commands
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import for CommonJS modules
let mamaSaveCommand;
let mamaRecallCommand;
let mamaSuggestCommand;
let mamaListCommand;
let mamaConfigureCommand;

beforeAll(async () => {
  // Dynamic import CommonJS modules
  const mamaSave = await import('../../src/commands/mama-save.js');
  const mamaRecall = await import('../../src/commands/mama-recall.js');
  const mamaSuggest = await import('../../src/commands/mama-suggest.js');
  const mamaList = await import('../../src/commands/mama-list.js');
  const mamaConfigure = await import('../../src/commands/mama-configure.js');

  mamaSaveCommand = mamaSave.mamaSaveCommand;
  mamaRecallCommand = mamaRecall.mamaRecallCommand;
  mamaSuggestCommand = mamaSuggest.mamaSuggestCommand;
  mamaListCommand = mamaList.mamaListCommand;
  mamaConfigureCommand = mamaConfigure.mamaConfigureCommand;
});

describe('MAMA Commands Suite', () => {
  describe('/mama-save Command', () => {
    it('should save a decision successfully', async () => {
      const result = await mamaSaveCommand({
        topic: 'test_mama_save',
        decision: 'Test decision for mama-save command',
        reasoning: 'Testing the /mama-save command functionality',
        confidence: 0.9,
      });

      expect(result.success).toBe(true);
      expect(result.decision_id).toContain('decision_test_mama_save_');
      expect(result.topic).toBe('test_mama_save');
      expect(result.message).toContain('Decision Saved Successfully');
    });

    it('should fail without required fields', async () => {
      const result = await mamaSaveCommand({
        topic: 'test_topic',
        // missing decision and reasoning
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('usage');
    });

    it('should handle confidence validation', async () => {
      const result = await mamaSaveCommand({
        topic: 'test_confidence',
        decision: 'Test decision',
        reasoning: 'Test reasoning',
        confidence: 1.5, // Invalid: > 1.0
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('confidence must be');
    });

    it('should format success message correctly', async () => {
      const result = await mamaSaveCommand({
        topic: 'test_format',
        decision: 'Test decision',
        reasoning: 'Test reasoning',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Decision Saved Successfully');
      expect(result.message).toContain('/mama-recall');
      expect(result.message).toContain('/mama-suggest');
    });
  });

  describe('/mama-recall Command', () => {
    beforeEach(async () => {
      // Save a test decision to recall
      await mamaSaveCommand({
        topic: 'test_mama_recall',
        decision: 'Decision for recall test',
        reasoning: 'Testing recall functionality',
      });
    });

    it('should recall decision history for a topic', async () => {
      const result = await mamaRecallCommand({
        topic: 'test_mama_recall',
      });

      expect(result.success).toBe(true);
      expect(result.history).toBeDefined();
      expect(result.history.length).toBeGreaterThan(0);
      expect(result.message).toContain('Decision History');
    });

    it('should handle topic not found', async () => {
      const result = await mamaRecallCommand({
        topic: 'nonexistent_topic_12345',
      });

      expect(result.success).toBe(true); // Not an error, just empty
      expect(result.history).toEqual([]);
      expect(result.message).toContain('No Decisions Found');
    });

    it('should fail without topic parameter', async () => {
      const result = await mamaRecallCommand({});

      expect(result.success).toBe(false);
      expect(result.message).toContain('usage');
    });

    it('should include recall suggestions in output', async () => {
      const result = await mamaRecallCommand({
        topic: 'test_mama_recall',
      });

      expect(result.success).toBe(true);
      if (result.history.length > 0) {
        expect(result.message).toContain('Decision for recall test');
        expect(result.message).toContain('Testing recall functionality');
      }
    });
  });

  describe('/mama-suggest Command', () => {
    beforeEach(async () => {
      // Save test decisions for semantic search
      await mamaSaveCommand({
        topic: 'test_authentication',
        decision: 'Use JWT for authentication',
        reasoning: 'JWT provides stateless authentication',
      });

      await mamaSaveCommand({
        topic: 'test_database',
        decision: 'Use SQLite for local storage',
        reasoning: 'SQLite is lightweight and embedded',
      });
    });

    it('should find semantically similar decisions', async () => {
      const result = await mamaSuggestCommand({
        query: 'authentication',
      });

      expect(result.success).toBe(true);
      expect(result.suggestions).toBeDefined();
      // May or may not find results depending on embeddings availability (tier)
    });

    it('should fail without query parameter', async () => {
      const result = await mamaSuggestCommand({});

      expect(result.success).toBe(false);
      expect(result.message).toContain('usage');
    });

    it('should respect limit parameter', async () => {
      const result = await mamaSuggestCommand({
        query: 'test',
        limit: 2,
      });

      expect(result.success).toBe(true);
      if (result.suggestions.length > 0) {
        expect(result.suggestions.length).toBeLessThanOrEqual(2);
      }
    });

    it('should handle no results gracefully', async () => {
      const result = await mamaSuggestCommand({
        query: 'extremely_specific_query_that_wont_match_anything_12345',
      });

      expect(result.success).toBe(true);
      expect(result.suggestions).toEqual([]);
      expect(result.message).toContain('No Results Found');
    });
  });

  describe('/mama-list Command', () => {
    beforeEach(async () => {
      // Save multiple test decisions
      await mamaSaveCommand({
        topic: 'test_list_1',
        decision: 'Decision 1',
        reasoning: 'Reasoning 1',
      });

      await mamaSaveCommand({
        topic: 'test_list_2',
        decision: 'Decision 2',
        reasoning: 'Reasoning 2',
      });

      await mamaSaveCommand({
        topic: 'test_list_3',
        decision: 'Decision 3',
        reasoning: 'Reasoning 3',
      });
    });

    it('should list recent decisions', async () => {
      const result = await mamaListCommand();

      expect(result.success).toBe(true);
      expect(result.list).toBeDefined();
      expect(result.list.length).toBeGreaterThan(0);
      expect(result.message).toContain('Recent Decisions');
    });

    it('should respect limit parameter', async () => {
      const result = await mamaListCommand({ limit: 2 });

      expect(result.success).toBe(true);
      expect(result.list.length).toBeLessThanOrEqual(2);
    });

    it('should cap limit at 100', async () => {
      const result = await mamaListCommand({ limit: 200 });

      expect(result.success).toBe(true);
      expect(result.list.length).toBeLessThanOrEqual(100);
    });

    it('should use default limit of 20', async () => {
      const result = await mamaListCommand({});

      expect(result.success).toBe(true);
      expect(result.list.length).toBeLessThanOrEqual(20);
    });

    it('should handle empty database', async () => {
      // This test assumes database might be empty
      // Actual behavior depends on test execution order
      const result = await mamaListCommand();

      expect(result.success).toBe(true);
      expect(result.list).toBeDefined();
    });
  });

  describe('/mama-configure Command', () => {
    it('should show current configuration', async () => {
      const result = await mamaConfigureCommand({ show: true });

      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.modelName).toBeDefined();
      expect(result.config.embeddingDim).toBeDefined();
      expect(result.tier).toBeDefined();
      expect(result.tier.tier).toBeGreaterThanOrEqual(1);
      expect(result.tier.tier).toBeLessThanOrEqual(3);
      expect(result.message).toContain('MAMA Configuration');
    });

    it('should default to showing config', async () => {
      const result = await mamaConfigureCommand({});

      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.tier).toBeDefined();
    });

    it('should list supported models', async () => {
      const result = await mamaConfigureCommand({ listModels: true });

      expect(result.success).toBe(true);
      expect(result.models).toBeDefined();
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.message).toContain('Supported Embedding Models');
    });

    it('should detect tier correctly', async () => {
      const result = await mamaConfigureCommand({});

      expect(result.success).toBe(true);
      expect(result.tier.tier).toBeDefined();
      expect(result.tier.status).toBeDefined();
      expect(result.tier.features).toBeDefined();
    });

    it('should show tier status in message', async () => {
      const result = await mamaConfigureCommand({});

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/Tier [123]/);
    });

    it('should include fix instructions for degraded tiers', async () => {
      const result = await mamaConfigureCommand({});

      expect(result.success).toBe(true);
      if (result.tier.tier > 1) {
        expect(result.message).toContain('How to Fix');
      }
    });
  });

  describe('Command Integration', () => {
    it('should work in a complete workflow', async () => {
      // 1. Save a decision
      const saveResult = await mamaSaveCommand({
        topic: 'test_workflow',
        decision: 'Complete workflow test',
        reasoning: 'Testing end-to-end command integration',
        confidence: 0.85,
      });

      expect(saveResult.success).toBe(true);

      // 2. Recall the decision
      const recallResult = await mamaRecallCommand({
        topic: 'test_workflow',
      });

      expect(recallResult.success).toBe(true);
      expect(recallResult.history.length).toBeGreaterThan(0);

      // 3. Search for the decision
      const suggestResult = await mamaSuggestCommand({
        query: 'workflow test',
        limit: 5,
      });

      expect(suggestResult.success).toBe(true);
      // May or may not find depending on tier

      // 4. List should include the decision
      const listResult = await mamaListCommand({ limit: 20 });

      expect(listResult.success).toBe(true);
      expect(listResult.list.length).toBeGreaterThan(0);

      // 5. Configure should show status
      const configResult = await mamaConfigureCommand({});

      expect(configResult.success).toBe(true);
      expect(configResult.tier).toBeDefined();
    });
  });
});
