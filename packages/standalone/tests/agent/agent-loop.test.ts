/**
 * Unit tests for AgentLoop
 *
 * Tests the agent loop with mocked ClaudeCLIWrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop, getGatewayToolsPrompt } from '../../src/agent/agent-loop.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { AgentContext, MAMAApiInterface } from '../../src/agent/types.js';

const { laneManagerEnqueueWithSessionMock } = vi.hoisted(() => ({
  laneManagerEnqueueWithSessionMock: vi.fn((_, fn) => fn()),
}));

const persistentPromptMock = vi.fn().mockResolvedValue({
  response: 'Mock response',
  usage: { input_tokens: 10, output_tokens: 5 },
  session_id: 'test-session',
});
const gatewayExecutorSetAgentContextMock = vi.fn();
const gatewayExecutorSetCurrentAgentContextMock = vi.fn();
const gatewayExecutorClearCurrentAgentContextMock = vi.fn();
const gatewayExecutorSetUICommandQueueMock = vi.fn();
const gatewayExecutorSetSessionsDbMock = vi.fn();
const gatewayExecutorSetValidationServiceMock = vi.fn();
const gatewayExecutorSetRawStoreMock = vi.fn();

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

// Mock the PersistentCLIAdapter (used by default for claude backend)
vi.mock('../../src/agent/persistent-cli-adapter.js', () => {
  return {
    PersistentCLIAdapter: vi.fn().mockImplementation(() => ({
      prompt: persistentPromptMock,
      setSessionId: vi.fn(),
      close: vi.fn(),
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
      setAgentContext: gatewayExecutorSetAgentContextMock,
      setCurrentAgentContext: gatewayExecutorSetCurrentAgentContextMock,
      clearCurrentAgentContext: gatewayExecutorClearCurrentAgentContextMock,
      setUICommandQueue: gatewayExecutorSetUICommandQueueMock,
      setSessionsDb: gatewayExecutorSetSessionsDbMock,
      setValidationService: gatewayExecutorSetValidationServiceMock,
      setRawStore: gatewayExecutorSetRawStoreMock,
      execute: vi.fn().mockResolvedValue({ success: true }),
    })),
  };
});

// Mock the lane manager
vi.mock('../../src/concurrency/index.js', () => {
  return {
    LaneManager: vi.fn(),
    getGlobalLaneManager: vi.fn().mockReturnValue({
      enqueueWithSession: laneManagerEnqueueWithSessionMock,
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

  const createChatBotContext = (): AgentContext => ({
    source: 'telegram',
    platform: 'telegram',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['mama_search', 'mama_recall', 'mama_load_checkpoint', 'Read', 'telegram_send'],
      blockedTools: ['Bash', 'Write', 'mama_save'],
      systemControl: false,
      sensitiveAccess: false,
      model: 'claude-sonnet-4-6',
      maxTurns: 10,
    },
    session: {
      sessionId: 'telegram:session',
      channelId: '7026976631',
      userId: '7026976631',
      startedAt: new Date(),
    },
    capabilities: ['mama_search', 'mama_recall', 'mama_load_checkpoint', 'Read', 'telegram_send'],
    limitations: ['No Bash', 'No Write', 'No mama_save'],
    tier: 2,
    backend: 'claude',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    persistentPromptMock.mockClear();
    gatewayExecutorSetAgentContextMock.mockClear();
    gatewayExecutorSetCurrentAgentContextMock.mockClear();
    gatewayExecutorClearCurrentAgentContextMock.mockClear();
    gatewayExecutorSetUICommandQueueMock.mockClear();
    gatewayExecutorSetSessionsDbMock.mockClear();
    gatewayExecutorSetValidationServiceMock.mockClear();
    gatewayExecutorSetRawStoreMock.mockClear();
    laneManagerEnqueueWithSessionMock.mockClear();
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

    it('should not pass structural tool restrictions through the runner options', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Hello', {
        source: 'telegram',
        channelId: '7026976631',
        agentContext: createChatBotContext(),
      });

      const promptOptions = persistentPromptMock.mock.calls[0]?.[2];
      expect(promptOptions.allowedTools).toBeUndefined();
      expect(promptOptions.disallowedTools).toBeUndefined();
    });

    it('should avoid mutating shared gateway executor routing state during run setup', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Hello', {
        source: 'viewer',
        channelId: 'mama_os_main',
        agentContext: {
          ...createChatBotContext(),
          source: 'viewer',
          platform: 'viewer',
          roleName: 'os_agent',
          session: {
            ...createChatBotContext().session,
            channelId: 'mama_os_main',
          },
        },
      });

      expect(gatewayExecutorSetCurrentAgentContextMock).not.toHaveBeenCalled();
    });

    it('should not clear shared gateway executor routing state when agentContext is absent', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('First', {
        source: 'viewer',
        channelId: 'mama_os_main',
        agentContext: {
          ...createChatBotContext(),
          source: 'viewer',
          platform: 'viewer',
          roleName: 'os_agent',
        },
      });
      gatewayExecutorClearCurrentAgentContextMock.mockClear();

      await agentLoop.run('Second');

      expect(gatewayExecutorClearCurrentAgentContextMock).not.toHaveBeenCalled();
    });

    it('should route viewer frontdoor sessions through a dedicated viewer global lane', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { useLanes: true },
        {},
        { mamaApi: createMockApi() }
      );

      agentLoop.setSessionKey('viewer:mama_os_main:user-1');
      await agentLoop.run('Hello');

      expect(laneManagerEnqueueWithSessionMock).toHaveBeenCalledWith(
        'viewer:mama_os_main:user-1',
        expect.any(Function),
        'viewer'
      );
    });

    it('should route conductor audit sessions through a dedicated system global lane', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { useLanes: true },
        {},
        { mamaApi: createMockApi() }
      );

      agentLoop.setSessionKey('system:conductor-audit-123:system');
      await agentLoop.run('Audit');

      expect(laneManagerEnqueueWithSessionMock).toHaveBeenCalledWith(
        'system:conductor-audit-123:system',
        expect.any(Function),
        'system'
      );
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

  describe('runtime dependency proxies', () => {
    it('should forward ui command queue, sessions db, validation service, and raw store to the internal executor', () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );
      const uiCommandQueue = { getPageContext: vi.fn() };
      const sessionsDb = { prepare: vi.fn(), exec: vi.fn() };
      const validationService = { startSession: vi.fn(), finalizeSession: vi.fn() };
      const rawStore = { getRecent: vi.fn(), hasConnector: vi.fn() };

      agentLoop.setUICommandQueue?.(
        uiCommandQueue as unknown as import('../../src/api/ui-command-handler.js').UICommandQueue
      );
      agentLoop.setSessionsDb?.(sessionsDb as unknown as import('../../src/sqlite.js').default);
      agentLoop.setValidationService?.(
        validationService as unknown as import('../../src/validation/session-service.js').ValidationSessionService
      );
      agentLoop.setRawStore?.(
        rawStore as unknown as import('../../src/connectors/framework/raw-store.js').RawStore
      );

      expect(gatewayExecutorSetUICommandQueueMock).toHaveBeenCalledWith(uiCommandQueue);
      expect(gatewayExecutorSetSessionsDbMock).toHaveBeenCalledWith(sessionsDb);
      expect(gatewayExecutorSetValidationServiceMock).toHaveBeenCalledWith(validationService);
      expect(gatewayExecutorSetRawStoreMock).toHaveBeenCalledWith(rawStore);
    });
  });

  describe('static methods', () => {
    it('should return tool definitions', () => {
      const tools = AgentLoop.getToolDefinitions();
      // Tool definitions are now provided by ClaudeCLI/MCP, so may be empty
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  describe('system prompt helpers', () => {
    it('should expose the full gateway tools prompt', () => {
      expect(getGatewayToolsPrompt()).toContain('# Gateway Tools');
      expect(getGatewayToolsPrompt()).toContain('mama_search');
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
