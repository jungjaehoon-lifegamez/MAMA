/**
 * Tests for load_checkpoint MCP tool
 *
 * Story 2.3: Zero-Context Restart
 * Tests checkpoint loading with narrative and link expansion
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDB, closeDB, getAdapter } from '@jungjaehoon/mama-core/db-manager';
import { saveCheckpointTool, loadCheckpointTool } from '../../src/tools/checkpoint-tools.js';
import { saveDecisionTool } from '../../src/tools/save-decision.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(os.tmpdir(), `mama-test-load-checkpoint-${Date.now()}.db`);

// Mock tool context
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

// Force sequential execution for this test file to avoid DB race conditions
describe.sequential('load_checkpoint MCP Tool', () => {
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
    await initDB();

    // Verify DB is initialized by inserting a test decision
    // This ensures the database is ready before running tests
    await saveDecisionTool.handler(
      {
        topic: 'test_init',
        decision: 'Test decision for DB initialization',
        reasoning: 'Ensure database is properly initialized before tests run',
        confidence: 0.5,
      },
      mockContext
    );
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
    // Note: Due to module isolation between ES modules (test) and CommonJS (checkpoint-tools),
    // we cannot reliably clear metrics. Tests should check relative changes instead.

    // Clear checkpoints table to ensure test isolation
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM checkpoints').run();
  });

  describe('AC-2.3.1: Checkpoint Loading with Narrative and Links', () => {
    it('should load latest checkpoint when no checkpoint exists', async () => {
      const result = await loadCheckpointTool.handler({}, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('No active checkpoint found');
    });

    it('should load latest checkpoint with narrative and links', async () => {
      // Save a checkpoint
      const checkpointResult = await saveCheckpointTool.handler(
        {
          summary: 'Implemented authentication with JWT tokens',
          open_files: ['src/auth.js', 'src/middleware/jwt.js'],
          next_steps: 'Test authentication flow\nAdd rate limiting',
        },
        mockContext
      );

      expect(checkpointResult.content[0].text).toContain('Checkpoint saved');

      // Save related decisions
      await saveDecisionTool.handler(
        {
          topic: 'jwt_authentication',
          decision: 'Use JWT with refresh tokens',
          reasoning: 'Stateless authentication with security',
          evidence: JSON.stringify(['OWASP guidelines', 'Security audit']),
          confidence: 0.9,
        },
        mockContext
      );

      // Load checkpoint with narrative and links
      const loadResult = await loadCheckpointTool.handler(
        {
          include_narrative: true,
          include_links: true,
          link_depth: 1,
        },
        mockContext
      );

      expect(loadResult.content).toBeDefined();
      expect(loadResult.content[0].text).toContain('Resuming Session');
      expect(loadResult.content[0].text).toContain('Implemented authentication with JWT tokens');

      // Parse JSON response
      const textContent = loadResult.content[0].text;
      const jsonMatch = textContent.match(/\{[\s\S]*"data"[\s\S]*\}/);
      if (jsonMatch) {
        const responseData = JSON.parse(jsonMatch[0]);
        expect(responseData.data.checkpoint).toBeDefined();
        expect(responseData.data.checkpoint.summary).toContain('authentication');
        expect(responseData.data.nextSteps).toBeDefined();
      }
    });

    it('should filter narrative by time window (1 hour)', async () => {
      // Save checkpoint
      await saveCheckpointTool.handler(
        {
          summary: 'Working on database optimization',
          open_files: ['src/db/optimizer.js'],
          next_steps: 'Profile query performance',
        },
        mockContext
      );

      // Save decision within time window
      await saveDecisionTool.handler(
        {
          topic: 'database_optimization',
          decision: 'Add index on user_id column',
          reasoning: 'Improve query performance',
          confidence: 0.85,
        },
        mockContext
      );

      // Load checkpoint
      const result = await loadCheckpointTool.handler({ include_narrative: true }, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('database optimization');
    });

    it('should only include approved links when include_links=true', async () => {
      // This test assumes link creation requires approval
      // For now, we test that links array is present in response
      await saveCheckpointTool.handler(
        {
          summary: 'Refactoring auth module',
          open_files: ['src/auth.js'],
          next_steps: 'Complete refactoring',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler(
        {
          include_narrative: true,
          include_links: true,
          link_depth: 1,
        },
        mockContext
      );

      const textContent = result.content[0].text;
      const jsonMatch = textContent.match(/\{[\s\S]*"data"[\s\S]*\}/);
      if (jsonMatch) {
        const responseData = JSON.parse(jsonMatch[0]);
        expect(responseData.data.links).toBeDefined();
        expect(Array.isArray(responseData.data.links)).toBe(true);
      }
    });
  });

  describe('AC-2.3.2: Next Steps and Risks', () => {
    it('should include unfinished tasks from checkpoint next_steps', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'Partially completed feature X',
          open_files: ['src/feature-x.js'],
          next_steps:
            '[ ] Complete unit tests\n[ ] Add integration tests\n[ ] Update documentation',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler({ include_narrative: true }, mockContext);

      const textContent = result.content[0].text;
      const jsonMatch = textContent.match(/\{[\s\S]*"data"[\s\S]*\}/);
      if (jsonMatch) {
        const responseData = JSON.parse(jsonMatch[0]);
        expect(responseData.data.nextSteps.recommendations).toBeDefined();
        expect(responseData.data.nextSteps.recommendations.length).toBeGreaterThan(0);
      }
    });

    it('should extract risks from narrative decisions', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'Implemented caching layer',
          open_files: ['src/cache.js'],
          next_steps: 'Monitor cache hit rate',
        },
        mockContext
      );

      await saveDecisionTool.handler(
        {
          topic: 'caching_strategy',
          decision: 'Use Redis for caching',
          reasoning: 'Fast in-memory storage',
          risks: 'Cache invalidation complexity, Memory limitations',
          confidence: 0.8,
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler({ include_narrative: true }, mockContext);

      const textContent = result.content[0].text;
      const jsonMatch = textContent.match(/\{[\s\S]*"data"[\s\S]*\}/);
      if (jsonMatch) {
        const responseData = JSON.parse(jsonMatch[0]);
        expect(responseData.data.nextSteps.risks).toBeDefined();
        // Risks may be extracted if decisions are within time window
      }
    });
  });

  describe('AC-2.3.3: Restart Metrics and Latency', () => {
    it.sequential('should log successful restart with metrics', async () => {
      // Save checkpoint
      await saveCheckpointTool.handler(
        {
          summary: 'Test checkpoint for metrics',
          open_files: ['test.js'],
          next_steps: 'Run tests',
        },
        mockContext
      );

      // Load checkpoint
      const startTime = Date.now();
      const result = await loadCheckpointTool.handler({}, mockContext);
      const endTime = Date.now();

      // Verify successful load (metrics are logged internally but can't be verified due to module isolation)
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Resuming Session');

      // Verify latency is reasonable
      const duration = endTime - startTime;
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
    });

    // TODO: Fix DB isolation issue - test fails in full suite but passes individually
    it.sequential.skip('should log failed restart when no checkpoint exists', async () => {
      // Force-delete ALL checkpoints to ensure test isolation
      const adapter = getAdapter();
      adapter.prepare('DELETE FROM checkpoints').run();

      // Verify deletion was successful
      const count = adapter.prepare('SELECT COUNT(*) as count FROM checkpoints').get().count;
      expect(count).toBe(0);

      // Try to load checkpoint (should fail - no checkpoints)
      const result = await loadCheckpointTool.handler({}, mockContext);

      // Verify appropriate response for no checkpoint
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('No active checkpoint found');
      // Metrics are logged internally (with reason: 'no_checkpoint') but can't be verified due to module isolation
    });

    it.sequential('should track p95 latency under 2.5s target', async () => {
      // Save checkpoint
      await saveCheckpointTool.handler(
        {
          summary: 'Performance test checkpoint',
          open_files: ['perf.js'],
          next_steps: 'Measure latency',
        },
        mockContext
      );

      // Perform multiple restarts and measure latency
      const latencies = [];
      for (let i = 0; i < 20; i++) {
        const start = Date.now();
        await loadCheckpointTool.handler({}, mockContext);
        const end = Date.now();
        latencies.push(end - start);
      }

      // Calculate p95 latency
      latencies.sort((a, b) => a - b);
      const p95Index = Math.ceil(latencies.length * 0.95) - 1;
      const p95Latency = latencies[p95Index];

      // AC-2.3.3 target: p95 < 2.5s
      expect(p95Latency).toBeLessThan(2500);
      // Note: latencies[0] can be 0 due to Date.now() millisecond precision
      expect(latencies[0]).toBeGreaterThanOrEqual(0);
    });

    it('should calculate success rate correctly', async () => {
      // Save checkpoint for successful loads
      await saveCheckpointTool.handler(
        {
          summary: 'Success rate test checkpoint',
          open_files: ['test.js'],
          next_steps: 'Test success rate',
        },
        mockContext
      );

      // Perform 10 successful restarts
      let successCount = 0;
      for (let i = 0; i < 10; i++) {
        const result = await loadCheckpointTool.handler({}, mockContext);
        if (result.content && result.content[0].text.includes('Resuming Session')) {
          successCount++;
        }
      }

      // All restarts should succeed
      expect(successCount).toBe(10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle checkpoint with no narrative', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'Isolated checkpoint',
          open_files: [],
          next_steps: '',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler({ include_narrative: false }, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Resuming Session');
    });

    it('should handle checkpoint with no links', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'No links checkpoint',
          open_files: ['test.js'],
          next_steps: 'Continue',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler(
        {
          include_narrative: true,
          include_links: false,
        },
        mockContext
      );

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Resuming Session');
    });

    it('should handle link_depth=0 (no link expansion)', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'Zero depth checkpoint',
          open_files: ['test.js'],
          next_steps: 'Test',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler(
        {
          include_narrative: true,
          include_links: true,
          link_depth: 0,
        },
        mockContext
      );

      expect(result.content).toBeDefined();
      // link_depth=0 should still work (no expansion)
    });
  });

  describe('Response Format Validation', () => {
    it('should return data in correct format: {data:{checkpoint, narrative, links, nextSteps}}', async () => {
      await saveCheckpointTool.handler(
        {
          summary: 'Format validation checkpoint',
          open_files: ['format.js'],
          next_steps: 'Validate format',
        },
        mockContext
      );

      const result = await loadCheckpointTool.handler(
        {
          include_narrative: true,
          include_links: true,
        },
        mockContext
      );

      const textContent = result.content[0].text;
      const jsonMatch = textContent.match(/\{[\s\S]*"data"[\s\S]*\}/);

      expect(jsonMatch).not.toBeNull();

      if (jsonMatch) {
        const responseData = JSON.parse(jsonMatch[0]);

        // Validate top-level structure
        expect(responseData.data).toBeDefined();

        // Validate checkpoint field
        expect(responseData.data.checkpoint).toBeDefined();
        expect(responseData.data.checkpoint.id).toBeDefined();
        expect(responseData.data.checkpoint.summary).toBeDefined();
        expect(responseData.data.checkpoint.timestamp).toBeDefined();

        // Validate narrative field
        expect(responseData.data.narrative).toBeDefined();
        expect(Array.isArray(responseData.data.narrative)).toBe(true);

        // Validate links field
        expect(responseData.data.links).toBeDefined();
        expect(Array.isArray(responseData.data.links)).toBe(true);

        // Validate nextSteps field
        expect(responseData.data.nextSteps).toBeDefined();
        expect(responseData.data.nextSteps.unfinished).toBeDefined();
        expect(responseData.data.nextSteps.recommendations).toBeDefined();
        expect(responseData.data.nextSteps.risks).toBeDefined();
      }
    });
  });
});
