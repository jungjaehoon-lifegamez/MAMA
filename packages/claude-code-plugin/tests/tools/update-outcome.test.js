/**
 * Update Outcome Tool Test
 * Story M1.5: Outcome & audit log module migration
 *
 * AC: update_outcome tool updates decision outcomes with proper validation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDB, closeDB } from '../../src/core/db-manager.js';

// Test database path (isolated)
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `mama-test-update-outcome-${Date.now()}-${process.pid}.db`
);

describe('Story M1.5: Update Outcome Tool', () => {
  beforeAll(async () => {
    // Clean up any existing database files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Set test database path
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    // Initialize test database
    // Note: ES modules don't need cache clearing - vitest's fork mode provides isolation
    await initDB();
  });

  afterAll(async () => {
    await closeDB();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
    delete process.env.MAMA_DB_PATH;
  });
  describe('Tool exports', () => {
    it('should export updateOutcomeTool', async () => {
      const { updateOutcomeTool } = await import('../../src/tools/update-outcome.js');

      expect(updateOutcomeTool).toBeDefined();
      expect(updateOutcomeTool.name).toBe('update_outcome');
      expect(typeof updateOutcomeTool.handler).toBe('function');
    });

    it('should be included in createMemoryTools', async () => {
      const { createMemoryTools } = await import('../../src/tools/index.js');
      const tools = createMemoryTools();

      expect(tools.update_outcome).toBeDefined();
      expect(tools.update_outcome.name).toBe('update_outcome');
    });
  });

  describe('Tool schema validation', () => {
    it('should have correct input schema', async () => {
      const { updateOutcomeTool } = await import('../../src/tools/update-outcome.js');

      expect(updateOutcomeTool.inputSchema).toBeDefined();
      expect(updateOutcomeTool.inputSchema.type).toBe('object');
      expect(updateOutcomeTool.inputSchema.required).toEqual(['decisionId', 'outcome']);

      const props = updateOutcomeTool.inputSchema.properties;
      expect(props.decisionId).toBeDefined();
      expect(props.outcome).toBeDefined();
      expect(props.outcome.enum).toEqual(['SUCCESS', 'FAILED', 'PARTIAL']);
      expect(props.failure_reason).toBeDefined();
      expect(props.limitation).toBeDefined();
    });
  });

  describe('Tool validation (AC #1: outcome tracker APIs with parity)', () => {
    let updateOutcomeTool;

    beforeAll(async () => {
      const module = await import('../../src/tools/update-outcome.js');
      updateOutcomeTool = module.updateOutcomeTool;
    });

    it('should reject missing decisionId', async () => {
      const result = await updateOutcomeTool.handler({
        outcome: 'SUCCESS',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('decisionId');
    });

    it('should reject empty decisionId', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: '   ',
        outcome: 'SUCCESS',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('decisionId');
    });

    it('should reject missing outcome', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('outcome');
    });

    it('should reject invalid outcome value', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'INVALID',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('outcome');
      expect(result.message).toContain('SUCCESS');
      expect(result.message).toContain('FAILED');
      expect(result.message).toContain('PARTIAL');
    });

    it('should reject FAILED outcome without failure_reason', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'FAILED',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failure_reason');
      expect(result.message).toContain('required');
    });

    it('should reject FAILED with empty failure_reason', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'FAILED',
        failure_reason: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failure_reason');
    });

    it('should reject too long failure_reason', async () => {
      const longReason = 'x'.repeat(2001);
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'FAILED',
        failure_reason: longReason,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failure_reason');
      expect(result.message).toContain('2000');
    });

    it('should reject too long limitation', async () => {
      const longLimitation = 'x'.repeat(2001);
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'PARTIAL',
        limitation: longLimitation,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('limitation');
      expect(result.message).toContain('2000');
    });

    it('should handle non-existent decisionId gracefully', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_nonexistent_999',
        outcome: 'SUCCESS',
      });

      // Since DB might not be initialized, we expect either:
      // 1. "not found" error (if DB initialized)
      // 2. Generic failure (if DB not initialized)
      expect(result.success).toBe(false);
      expect(result.message).toContain('❌');
    });
  });

  describe('Tool description and guidance', () => {
    it('should provide clear outcome type descriptions', async () => {
      const { updateOutcomeTool } = await import('../../src/tools/update-outcome.js');

      expect(updateOutcomeTool.description).toContain('SUCCESS');
      expect(updateOutcomeTool.description).toContain('FAILED');
      expect(updateOutcomeTool.description).toContain('PARTIAL');
      expect(updateOutcomeTool.description).toContain('real-world results');
    });

    it('should explain use cases', async () => {
      const { updateOutcomeTool } = await import('../../src/tools/update-outcome.js');

      expect(updateOutcomeTool.description).toContain('USE CASES');
      expect(updateOutcomeTool.description).toContain('testing');
      expect(updateOutcomeTool.description).toContain('deployment');
      expect(updateOutcomeTool.description).toContain('feedback');
    });
  });
});
