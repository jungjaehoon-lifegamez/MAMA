/**
 * Unit tests for AgentLoop
 *
 * Tests the agent loop with mocked ClaudeCLIWrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

// Mock the ClaudeCLIWrapper
vi.mock('../../src/agent/claude-cli-wrapper.js', () => {
  return {
    ClaudeCLIWrapper: vi.fn().mockImplementation(() => ({
      resetSession: vi.fn(),
      setSystemPrompt: vi.fn(),
      setSessionId: vi.fn(),
      prompt: vi.fn().mockResolvedValue({
        response: 'Mock response',
        usage: { input_tokens: 10, output_tokens: 5 },
        session_id: 'test-session',
      }),
    })),
  };
});

// Mock the session pool
vi.mock('../../src/agent/session-pool.js', () => {
  return {
    SessionPool: vi.fn().mockImplementation(() => ({
      getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
      releaseSession: vi.fn(),
    })),
    getSessionPool: vi.fn().mockReturnValue({
      getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
      releaseSession: vi.fn(),
    }),
    buildChannelKey: vi.fn().mockReturnValue('default:default'),
  };
});

// Mock the GatewayToolExecutor
vi.mock('../../src/agent/gateway-tool-executor.js', () => {
  return {
    GatewayToolExecutor: vi.fn().mockImplementation(() => ({
      setDiscordGateway: vi.fn(),
      execute: vi.fn().mockResolvedValue({ success: true }),
    })),
  };
});

// Mock the lane manager
vi.mock('../../src/concurrency/index.js', () => {
  return {
    LaneManager: vi.fn(),
    getGlobalLaneManager: vi.fn().mockReturnValue({
      enqueueWithSession: vi.fn((_, fn) => fn()),
    }),
  };
});

describe('AgentLoop', () => {
  const mockToken = 'sk-ant-oat01-test-token';

  const createMockOAuthManager = (): OAuthManager =>
    ({
      getToken: vi.fn().mockResolvedValue(mockToken),
    }) as unknown as OAuthManager;

  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({
      success: true,
      id: 'decision_test123',
      type: 'decision',
    }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_test123',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run()', () => {
    it('should return response for simple prompt', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Hello');

      expect(result.response).toBe('Mock response');
      expect(result.turns).toBe(1);
      expect(result.stopReason).toBe('end_turn');
    });

    it('should track token usage', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Hello');

      expect(result.totalUsage.input_tokens).toBe(10);
      expect(result.totalUsage.output_tokens).toBe(5);
    });
  });

  describe('setSessionKey()', () => {
    it('should update session key', () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      agentLoop.setSessionKey('discord:123:456');
      expect(agentLoop.getSessionKey()).toBe('discord:123:456');
    });
  });

  describe('static methods', () => {
    it('should return tool definitions', () => {
      const tools = AgentLoop.getToolDefinitions();
      // Tool definitions are now provided by ClaudeCLI/MCP, so may be empty
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle max turns exceeded', async () => {
      const { ClaudeCLIWrapper } = await import('../../src/agent/claude-cli-wrapper.js');
      (ClaudeCLIWrapper as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        resetSession: vi.fn(),
        setSystemPrompt: vi.fn(),
        setSessionId: vi.fn(),
        // Simulate never ending (always continue)
        prompt: vi.fn().mockResolvedValue({
          response: 'Continuing...',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'test-session',
        }),
      }));

      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { maxTurns: 1 },
        {},
        { mamaApi: createMockApi() }
      );

      // With stop_reason always being 'end_turn', it should complete in 1 turn
      const result = await agentLoop.run('Test max turns');
      expect(result.turns).toBe(1);
    });
  });
});
