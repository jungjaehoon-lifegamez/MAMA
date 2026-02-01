/**
 * Unit tests for GatewayToolExecutor
 */

import { describe, it, expect, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { AgentError } from '../../src/agent/types.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

describe('GatewayToolExecutor', () => {
  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({
      success: true,
      id: 'decision_test123',
      type: 'decision',
      message: 'Decision saved',
    }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_test123',
      type: 'checkpoint',
      message: 'Checkpoint saved',
    }),
    listDecisions: vi.fn().mockResolvedValue([
      {
        id: 'decision_recent',
        topic: 'recent_topic',
        decision: 'Recent decision',
        created_at: '2026-01-28',
        type: 'decision',
      },
    ]),
    suggest: vi.fn().mockResolvedValue({
      success: true,
      results: [
        {
          id: 'decision_1',
          topic: 'auth',
          decision: 'Use JWT',
          similarity: 0.85,
          created_at: '2026-01-28',
          type: 'decision',
        },
      ],
      count: 1,
    }),
    updateOutcome: vi.fn().mockResolvedValue({
      success: true,
      message: 'Outcome updated',
    }),
    loadCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      summary: 'Session summary',
      next_steps: 'Next steps',
      open_files: ['file1.ts'],
    }),
  });

  describe('execute()', () => {
    it('should throw error for unknown tool', async () => {
      const executor = new GatewayToolExecutor({ mamaApi: createMockApi() });

      await expect(executor.execute('unknown_tool', {})).rejects.toThrow(AgentError);
      await expect(executor.execute('unknown_tool', {})).rejects.toMatchObject({
        code: 'UNKNOWN_TOOL',
      });
    });
  });

  describe('save tool', () => {
    it('should save decision', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_save', {
        type: 'decision',
        topic: 'auth_strategy',
        decision: 'Use JWT',
        reasoning: 'JWT provides stateless auth',
        confidence: 0.8,
      });

      expect(mockApi.save).toHaveBeenCalledWith({
        topic: 'auth_strategy',
        decision: 'Use JWT',
        reasoning: 'JWT provides stateless auth',
        confidence: 0.8,
        type: 'user_decision', // MCP 'decision' maps to mama-api 'user_decision'
      });
      expect(result).toMatchObject({ success: true, type: 'decision' });
    });

    it('should save checkpoint', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_save', {
        type: 'checkpoint',
        summary: 'Session summary',
        next_steps: 'Next steps',
        open_files: ['file1.ts'],
      });

      expect(mockApi.saveCheckpoint).toHaveBeenCalledWith(
        'Session summary',
        ['file1.ts'],
        'Next steps',
        [] // recentConversation (empty when no sessionStore)
      );
      expect(result).toMatchObject({ success: true, type: 'checkpoint' });
    });

    it('should return error for missing decision fields', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_save', {
        type: 'decision',
        topic: 'auth',
        // missing decision and reasoning
      });

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('requires'),
      });
    });

    it('should return error for missing checkpoint summary', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_save', {
        type: 'checkpoint',
        // missing summary
      });

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('requires'),
      });
    });

    it('should return error for invalid save type', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_save', {
        type: 'invalid_type',
      } as unknown);

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('Invalid save type'),
      });
    });
  });

  describe('search tool', () => {
    it('should search with query', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_search', {
        query: 'authentication',
        limit: 5,
      });

      expect(mockApi.suggest).toHaveBeenCalledWith('authentication', { limit: 5 });
      expect(result).toMatchObject({ success: true });
    });

    it('should return recent items without query', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_search', {});

      expect(mockApi.listDecisions).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toMatchObject({ success: true });
    });

    it('should filter by type', async () => {
      const mockApi = createMockApi();
      (mockApi.suggest as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        results: [
          { id: '1', type: 'decision', topic: 'a' },
          { id: '2', type: 'checkpoint', summary: 'b' },
          { id: '3', type: 'decision', topic: 'c' },
        ],
        count: 3,
      });
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_search', {
        query: 'test',
        type: 'decision',
      });

      expect(result).toMatchObject({
        success: true,
        count: 2,
      });
    });
  });

  describe('update tool', () => {
    it('should update outcome', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_update', {
        id: 'decision_123',
        outcome: 'success',
        reason: 'Worked well',
      });

      expect(mockApi.updateOutcome).toHaveBeenCalledWith('decision_123', {
        outcome: 'SUCCESS',
        failure_reason: 'Worked well',
      });
      expect(result).toMatchObject({ success: true });
    });

    it('should normalize outcome to uppercase', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      await executor.execute('mama_update', {
        id: 'decision_123',
        outcome: 'failed',
      });

      expect(mockApi.updateOutcome).toHaveBeenCalledWith('decision_123', {
        outcome: 'FAILED',
        failure_reason: undefined,
      });
    });

    it('should return error for missing id', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_update', {
        outcome: 'success',
      } as unknown);

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('requires: id'),
      });
    });

    it('should return error for missing outcome', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_update', {
        id: 'decision_123',
      } as unknown);

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('requires: outcome'),
      });
    });

    it('should return error for invalid outcome', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_update', {
        id: 'decision_123',
        outcome: 'invalid' as 'success',
      });

      expect(result).toMatchObject({
        success: false,
        message: expect.stringContaining('Invalid outcome'),
      });
    });
  });

  describe('load_checkpoint tool', () => {
    it('should load checkpoint', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });

      const result = await executor.execute('mama_load_checkpoint', {});

      expect(mockApi.loadCheckpoint).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        summary: 'Session summary',
        next_steps: 'Next steps',
        open_files: ['file1.ts'],
      });
    });
  });

  describe('static methods', () => {
    it('should return valid tools', () => {
      const tools = GatewayToolExecutor.getValidTools();
      expect(tools).toEqual([
        'mama_search',
        'mama_save',
        'mama_update',
        'mama_load_checkpoint',
        'Read',
        'Write',
        'Bash',
        'discord_send',
      ]);
    });

    it('should check valid tool names', () => {
      expect(GatewayToolExecutor.isValidTool('mama_save')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('mama_search')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('mama_update')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('mama_load_checkpoint')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('Read')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('Write')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('Bash')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('discord_send')).toBe(true);
      expect(GatewayToolExecutor.isValidTool('invalid')).toBe(false);
      // Old names should be invalid
      expect(GatewayToolExecutor.isValidTool('save')).toBe(false);
      expect(GatewayToolExecutor.isValidTool('search')).toBe(false);
    });
  });
});
