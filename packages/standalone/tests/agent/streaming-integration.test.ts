/**
 * Integration tests for AgentLoop streaming functionality
 *
 * Tests the streaming behavior with ClaudeCLIWrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { MAMAApiInterface, ContentBlock } from '../../src/agent/types.js';

// Mock the ClaudeCLIWrapper
vi.mock('../../src/agent/claude-cli-wrapper.js', () => {
  return {
    ClaudeCLIWrapper: vi.fn().mockImplementation(() => ({
      resetSession: vi.fn(),
      setSystemPrompt: vi.fn(),
      setSessionId: vi.fn(),
      prompt: vi.fn().mockResolvedValue({
        response: 'Mock streaming response',
        usage: { input_tokens: 15, output_tokens: 10 },
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

describe('AgentLoop - Streaming Integration', () => {
  const mockToken = 'sk-ant-oat01-test-token';

  const createMockOAuthManager = (): OAuthManager =>
    ({
      getToken: vi.fn().mockResolvedValue(mockToken),
    }) as unknown as OAuthManager;

  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({ success: true, id: 'test', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'test', type: 'checkpoint' }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('API selection based on content type', () => {
    it('should handle text-only requests', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Hello, Claude!');

      expect(result.response).toBe('Mock streaming response');
      expect(result.turns).toBe(1);
    });

    it('should handle multimodal requests with images', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const content: ContentBlock[] = [
        { type: 'text', text: 'Describe this image:' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: 'base64data',
          },
        },
      ];

      const result = await agentLoop.runWithContent(content);

      expect(result.response).toBe('Mock streaming response');
    });

    it('should handle document-only requests', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const content: ContentBlock[] = [
        { type: 'text', text: 'Analyze this document:' },
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'pdfdata',
          },
        },
      ];

      const result = await agentLoop.runWithContent(content);

      expect(result.response).toBe('Mock streaming response');
    });
  });

  describe('backward compatibility', () => {
    it('should not break existing text-only workflow', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Simple text prompt');

      expect(result).toHaveProperty('response');
      expect(result).toHaveProperty('turns');
      expect(result).toHaveProperty('history');
      expect(result).toHaveProperty('totalUsage');
      expect(result).toHaveProperty('stopReason');
    });

    it('should work with run() method (string prompt)', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Test string prompt');

      expect(typeof result.response).toBe('string');
      expect(result.response).toBe('Mock streaming response');
    });
  });

  describe('token usage tracking', () => {
    it('should track tokens correctly', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('Track my tokens');

      expect(result.totalUsage).toEqual({
        input_tokens: 15,
        output_tokens: 10,
      });
    });
  });
});
