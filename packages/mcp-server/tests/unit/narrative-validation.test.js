import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSaveDecisionTool } from '../../src/tools/save-decision.js';

describe('Narrative Input Validation', () => {
  let saveDecisionTool;
  let mamaMock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock for each test
    mamaMock = {
      save: vi.fn(),
      updateOutcome: vi.fn(),
      recall: vi.fn(),
    };

    // Inject mock using factory function
    saveDecisionTool = createSaveDecisionTool(mamaMock);
  });

  describe('save_decision tool', () => {
    it('should pass narrative fields to mama.save', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        reasoning: 'test_reasoning',
        evidence: ['file.js', 'log.txt'],
        alternatives: ['alt1', 'alt2'],
        risks: 'high risk',
      };

      // Story 1.1/1.2: save() now returns enhanced response object
      mamaMock.save.mockResolvedValue({ success: true, id: 'decision_123' });

      const result = await saveDecisionTool.handler(params);

      if (!result.success) {
        console.error('Test failed result:', result);
      }

      expect(result.success).toBe(true);
      expect(mamaMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test_topic',
          evidence: ['file.js', 'log.txt'],
          alternatives: ['alt1', 'alt2'],
          risks: 'high risk',
        })
      );
    });

    it('should handle missing optional narrative fields', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        reasoning: 'test_reasoning',
      };

      // Story 1.1/1.2: save() now returns enhanced response object
      mamaMock.save.mockResolvedValue({ success: true, id: 'decision_123' });

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      expect(mamaMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test_topic',
          evidence: undefined,
          alternatives: undefined,
          risks: undefined,
        })
      );
    });

    it('should fail if required fields are missing', async () => {
      const params = {
        topic: 'test_topic',
        decision: 'test_decision',
        // reasoning missing
      };

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation error');
    });

    it('should reject malformed contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'Add endpoint',
        reasoning: 'Needs to be added',
      };

      mamaMock.recall.mockResolvedValue({
        supersedes_chain: [],
      });

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(false);
      expect(result.message).toContain('contract decision seems malformed');
    });

    it('should accept well-formed contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'GET /users expects none, returns User[] defined in users.ts',
        reasoning: 'Represents API contract from users.ts and must be stable.',
      };

      mamaMock.recall.mockResolvedValue({
        supersedes_chain: [],
      });

      mamaMock.save.mockResolvedValue({ success: true, id: 'decision_456' });

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      expect(mamaMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'contract_get_users',
          decision: 'GET /users expects none, returns User[] defined in users.ts',
        })
      );
    });

    it('should skip duplicate contract decisions', async () => {
      const params = {
        topic: 'contract_get_users',
        decision: 'GET /users expects none, returns User[] defined in users.ts',
        reasoning: 'Same as existing contract.',
      };

      mamaMock.recall.mockResolvedValue({
        supersedes_chain: [
          {
            id: 'decision_existing',
            decision: 'GET /users expects none, returns User[] defined in users.ts',
          },
        ],
      });

      const result = await saveDecisionTool.handler(params);

      expect(result.success).toBe(true);
      expect(result.decision_id).toBe('decision_existing');
      expect(result.message).toContain('Duplicate contract');
      expect(mamaMock.save).not.toHaveBeenCalled();
    });
  });
});
