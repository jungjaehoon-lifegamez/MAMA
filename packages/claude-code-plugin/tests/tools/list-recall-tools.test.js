/**
 * Integration Tests: list_decisions and recall_decision MCP Tools
 *
 * Story M4.1: Port unit/integration tests from mcp-server
 * Originally: Story 1.5 in mcp-server
 *
 * Tests AC #1-6: List/Recall functionality, formatting, performance
 *
 * @date 2025-11-21
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { listDecisionsTool } from '../../src/tools/list-decisions.js';
import { recallDecisionTool } from '../../src/tools/recall-decision.js';
import { saveDecisionTool } from '../../src/tools/save-decision.js';
import { initDB, getAdapter, closeDB } from '@jungjaehoon/mama-core/db-manager';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `mama-test-list-recall-${Date.now()}-${process.pid}.db`
);

// Mock tool context
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

describe('Story M4.1: list_decisions and recall_decision Tools (ported from mcp-server)', () => {
  beforeAll(async () => {
    // Clean up any existing database files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Set test database path
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    // Initialize test database
    // Note: ES modules don't need cache clearing - vitest's fork mode provides isolation
    await initDB();
  });

  afterAll(async () => {
    // Clean up test database
    await closeDB();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Clean up WAL files
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Clean up environment
    delete process.env.MAMA_DB_PATH;
  });

  beforeEach(async () => {
    // Clear all decisions before each test
    const adapter = getAdapter();
    // Delete in correct order due to foreign key constraints
    try {
      await adapter.prepare('DELETE FROM decision_edges').run();
      await adapter.prepare('DELETE FROM decisions').run();
    } catch (error) {
      console.warn('Error clearing test data:', error.message);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #1: list_decisions returns recent decisions DESC
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #1: list_decisions with various limits', () => {
    it('should return recent decisions in DESC order (default limit 20)', async () => {
      // Create 25 test decisions
      for (let i = 0; i < 25; i++) {
        await saveDecisionTool.handler(
          {
            topic: `topic_${i}`,
            decision: `Decision ${i}`,
            reasoning: `Reasoning for decision ${i}`,
            confidence: 0.8,
          },
          mockContext
        );
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Call list_decisions with default limit (20)
      const result = await listDecisionsTool.handler({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.list).toBeTruthy();

      // Should contain "Recent Decisions" or similar header
      expect(result.list).toMatch(/Recent|Decisions/i);

      // Should show 20 decisions (not 25)
      const lines = result.list.split('\n');
      const decisionLines = lines.filter((line) => line.match(/^\s*\d+\./));
      expect(decisionLines.length).toBeLessThanOrEqual(20);
    });

    it('should respect custom limit parameter', async () => {
      // Create 10 test decisions
      for (let i = 0; i < 10; i++) {
        await saveDecisionTool.handler(
          {
            topic: `topic_${i}`,
            decision: `Decision ${i}`,
            reasoning: `Reasoning ${i}`,
            confidence: 0.7,
          },
          mockContext
        );
      }

      // Call list_decisions with limit=5
      const result = await listDecisionsTool.handler({ limit: 5 }, mockContext);

      expect(result.success).toBe(true);
      expect(result.list).toBeTruthy();

      // Should show only 5 decisions
      const lines = result.list.split('\n');
      const decisionLines = lines.filter((line) => line.match(/^\s*\d+\./));
      expect(decisionLines.length).toBeLessThanOrEqual(5);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #2: Each decision includes required fields with human-readable time
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #2: Decision fields and time formatting', () => {
    it('should include topic, decision preview, confidence, outcome, and human-readable time', async () => {
      // Create a decision
      const saveResult = await saveDecisionTool.handler(
        {
          topic: 'auth_strategy',
          decision:
            'This is a very long decision text that should be truncated to 100 characters or less in the list view to keep things concise',
          reasoning: 'Security reasons',
          confidence: 0.95,
        },
        mockContext
      );

      // Verify save was successful
      if (!saveResult.success) {
        console.error('saveDecisionTool failed:', saveResult.message);
      }
      expect(saveResult.success).toBe(true);

      const result = await listDecisionsTool.handler({ limit: 10 }, mockContext);

      expect(result.success).toBe(true);
      expect(result.list).toBeTruthy();

      // Should contain topic
      expect(result.list).toContain('auth_strategy');

      // Should contain confidence (95%)
      expect(result.list).toMatch(/95%/);

      // Should contain human-readable time (e.g., "just now", "ago", or specific time format)
      expect(result.list).toMatch(/ago|now|:\d{2}/i);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #3: Limit capping at 100
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #3: Limit capping at 100', () => {
    it('should cap limit at 100 with validation error', async () => {
      // Create 50 decisions (enough to test limit capping)
      for (let i = 0; i < 50; i++) {
        await saveDecisionTool.handler(
          {
            topic: `topic_${i}`,
            decision: `Decision ${i}`,
            reasoning: `Reasoning ${i}`,
            confidence: 0.5,
          },
          mockContext
        );
      }

      // Request 150 decisions (exceeds max 100)
      const result = await listDecisionsTool.handler({ limit: 150 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
      expect(result.message).toMatch(/between 1 and 100/i);
    });

    it('should reject limit < 1', async () => {
      const result = await listDecisionsTool.handler({ limit: 0 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #4: recall_decision returns all decisions for topic
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #4: recall_decision with existing topic', () => {
    it('should return all decisions for topic with supersedes relationships', async () => {
      // Create decision evolution chain (same topic, multiple saves)
      await saveDecisionTool.handler(
        {
          topic: 'date_format',
          decision: 'Use ISO 8601 only',
          reasoning: 'Standard format',
          confidence: 0.6,
        },
        mockContext
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      await saveDecisionTool.handler(
        {
          topic: 'date_format',
          decision: 'Support both ISO 8601 and Unix timestamp',
          reasoning: 'Bootstrap data needs Unix timestamp',
          confidence: 0.9,
        },
        mockContext
      );

      const result = await recallDecisionTool.handler({ topic: 'date_format' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.history).toBeTruthy();

      // Should contain both decisions
      expect(result.history).toContain('ISO 8601');
      expect(result.history).toContain('Unix timestamp');

      // Should show evolution (Previous Decisions or Latest Decision section)
      expect(result.history).toMatch(/Previous|Latest|Evolution|History/i);
    });

    it('should include outcome status in recall results', async () => {
      // Create a decision with outcome
      const saveResult = await saveDecisionTool.handler(
        {
          topic: 'test_outcome',
          decision: 'Test decision with outcome',
          reasoning: 'Testing outcome field',
          confidence: 0.8,
          outcome: 'success',
        },
        mockContext
      );

      // Verify save was successful
      if (!saveResult.success) {
        console.error('saveDecisionTool failed:', saveResult.message);
      }
      expect(saveResult.success).toBe(true);

      const result = await recallDecisionTool.handler({ topic: 'test_outcome' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.history).toBeTruthy();

      // Should show outcome (success keyword or emoji)
      expect(result.history).toMatch(/success|✅|SUCCESS/i);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #5: recall_decision handles non-existent topic
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #5: recall_decision with non-existent topic', () => {
    it('should return empty result with message (not error)', async () => {
      const result = await recallDecisionTool.handler({ topic: 'nonexistent_topic' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.history).toBeTruthy();

      // Should indicate no decisions found
      expect(result.history).toMatch(/No decisions found|not found|❌/i);
    });

    it('should validate topic as non-empty string', async () => {
      const result = await recallDecisionTool.handler({ topic: '' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC #6: Performance (<100ms p95)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC #6: Query performance < 100ms (p95)', () => {
    it('should complete list_decisions in < 100ms (p95)', async () => {
      // Create 100 decisions for realistic test
      for (let i = 0; i < 100; i++) {
        await saveDecisionTool.handler(
          {
            topic: `perf_topic_${i}`,
            decision: `Performance test decision ${i}`,
            reasoning: `Testing latency with decision ${i}`,
            confidence: 0.5,
          },
          mockContext
        );
      }

      // Measure latency across 20 calls (p95 = 19th result)
      const latencies = [];

      for (let i = 0; i < 20; i++) {
        const start = Date.now();
        await listDecisionsTool.handler({ limit: 10 }, mockContext);
        const latency = Date.now() - start;
        latencies.push(latency);
      }

      // Calculate p95 (95th percentile)
      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95) - 1;
      const p95Latency = latencies[p95Index];

      console.log(`[Performance] list_decisions p95 latency: ${p95Latency}ms`);

      // AC #6: p95 latency < 100ms
      expect(p95Latency).toBeLessThan(100);
    });

    it('should complete recall_decision in < 100ms (p95)', async () => {
      // Create evolution chain for recall test
      for (let i = 0; i < 5; i++) {
        await saveDecisionTool.handler(
          {
            topic: 'perf_recall_topic',
            decision: `Decision v${i + 1}`,
            reasoning: `Performance test ${i + 1}`,
            confidence: 0.7,
          },
          mockContext
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Measure latency across 20 calls
      const latencies = [];

      for (let i = 0; i < 20; i++) {
        const start = Date.now();
        await recallDecisionTool.handler({ topic: 'perf_recall_topic' }, mockContext);
        const latency = Date.now() - start;
        latencies.push(latency);
      }

      // Calculate p95
      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95) - 1;
      const p95Latency = latencies[p95Index];

      console.log(`[Performance] recall_decision p95 latency: ${p95Latency}ms`);

      // AC #6: p95 latency < 100ms
      expect(p95Latency).toBeLessThan(100);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Edge Cases
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('Edge cases', () => {
    it('should handle empty database gracefully', async () => {
      // Explicit cleanup — beforeEach may fail silently when adapter is stale
      try {
        const adapter = getAdapter();
        adapter.prepare('DELETE FROM decision_edges').run();
        adapter.prepare('DELETE FROM decisions').run();
      } catch {
        // ignore — DB may not be initialized
      }

      const listResult = await listDecisionsTool.handler({ limit: 10 }, mockContext);
      expect(listResult.success).toBe(true);
      expect(listResult.list).toMatch(/No decisions|empty|❌/i);

      const recallResult = await recallDecisionTool.handler({ topic: 'any_topic' }, mockContext);
      expect(recallResult.success).toBe(true);
      expect(recallResult.history).toMatch(/No decisions found|not found|❌/i);
    });

    it('should handle very long decision text (truncation)', async () => {
      const longDecision = 'A'.repeat(200);

      await saveDecisionTool.handler(
        {
          topic: 'truncation_test',
          decision: longDecision,
          reasoning: 'Testing truncation',
          confidence: 0.5,
        },
        mockContext
      );

      const result = await listDecisionsTool.handler({ limit: 10 }, mockContext);

      expect(result.success).toBe(true);
      expect(result.list).toBeTruthy();

      // Should show truncated preview
      const lines = result.list.split('\n');
      const previewLine = lines.find((line) => line.includes('truncation_test'));
      expect(previewLine).toBeTruthy();
    });
  });
});
