/**
 * Update Outcome Tool Test
 * Story M1.5: Outcome & audit log module migration
 *
 * AC: update_outcome tool updates decision outcomes with proper validation
 */

import { describe, it, expect, beforeAll } from 'vitest';

describe('Story M1.5: Update Outcome Tool', () => {
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
      // Story 3.1: enum removed for case-insensitive support
      expect(props.outcome.description).toContain('case-insensitive');
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

    it('should reject invalid outcome value with "Did you mean" hint', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'INVALID',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('outcome');
      expect(result.message).toContain('SUCCESS');
      expect(result.message).toContain('FAILED');
      expect(result.message).toContain('PARTIAL');
      // Story 3.1: "Did you mean...?" hint
      expect(result.message).toContain('Did you mean');
    });

    // Story 3.1: Case-insensitive outcome tests
    it('should accept lowercase outcome (success)', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'success', // lowercase
      });

      // Will fail because decision doesn't exist, but validation passes
      // Check that it gets past validation to the "not found" error
      expect(result.message).not.toContain('outcome must be');
    });

    it('should accept mixed case outcome (Success)', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'Success', // mixed case
      });

      expect(result.message).not.toContain('outcome must be');
    });

    it('should accept lowercase failed with failure_reason', async () => {
      const result = await updateOutcomeTool.handler({
        decisionId: 'decision_test_123',
        outcome: 'failed', // lowercase
        failure_reason: 'Test failure reason',
      });

      // Validation passes, fails on DB lookup
      expect(result.message).not.toContain('outcome must be');
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
      expect(updateOutcomeTool.description).toContain('real-world validation');
    });

    it('should explain when to use and evidence types', async () => {
      const { updateOutcomeTool } = await import('../../src/tools/update-outcome.js');

      // Story 3.2: Updated description with WHEN TO USE and EVIDENCE TYPES
      expect(updateOutcomeTool.description).toContain('WHEN TO USE');
      expect(updateOutcomeTool.description).toContain('deployment');
      expect(updateOutcomeTool.description).toContain('EVIDENCE TYPES');
      expect(updateOutcomeTool.description).toContain('file_path');
    });
  });
});
