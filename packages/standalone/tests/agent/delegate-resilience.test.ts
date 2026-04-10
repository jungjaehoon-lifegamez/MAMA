/**
 * Tests for delegate gateway tool resilience:
 * - Retry with backoff on busy/crash errors
 * - Max retries exceeded → error
 * - Channel history injection for fresh/restarted processes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegationManager } from '../../src/multi-agent/delegation-manager.js';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

// ---------------------------------------------------------------------------
// Mock config-manager so getConfig() returns a known busy_retry_ms value
// ---------------------------------------------------------------------------

vi.mock('../../src/cli/config/config-manager.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getConfig: () => ({
      timeouts: { busy_retry_ms: 1000 },
      io: {},
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentPersonaConfig> & { id: string }): AgentPersonaConfig {
  return {
    name: overrides.id,
    display_name: overrides.id,
    trigger_prefix: `!${overrides.id}`,
    persona_file: '',
    auto_respond_keywords: [],
    tier: 1,
    can_delegate: false,
    enabled: true,
    ...overrides,
  };
}

const conductor = makeAgent({ id: 'conductor', tier: 1, can_delegate: true });
const developer = makeAgent({ id: 'developer', tier: 2, can_delegate: false });
const allAgents = [conductor, developer];

// ---------------------------------------------------------------------------
// Mock channel-history module
// ---------------------------------------------------------------------------

const mockFormatForContext = vi.fn().mockReturnValue('');

vi.mock('../../src/gateways/channel-history.js', () => ({
  getChannelHistory: () => ({
    formatForContext: mockFormatForContext,
  }),
}));

// ---------------------------------------------------------------------------
// Retry / resilience tests
// ---------------------------------------------------------------------------

describe('delegate resilience — retry with backoff', () => {
  let executor: GatewayToolExecutor;
  let dm: DelegationManager;
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let mockGetProcess: ReturnType<typeof vi.fn>;
  let mockStopProcess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockSendMessage = vi.fn();
    mockGetProcess = vi.fn();
    mockStopProcess = vi.fn();

    const mockAgentProcessManager = {
      getProcess: mockGetProcess,
      stopProcess: mockStopProcess,
    } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager;

    dm = new DelegationManager(allAgents, new ToolPermissionManager());

    executor = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        listDecisions: vi.fn(),
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      },
    });

    executor.setAgentProcessManager(mockAgentProcessManager);
    executor.setDelegationManager(dm);
    executor.setCurrentAgentContext('conductor', 'discord', 'channel-123');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first attempt without retry', async () => {
    mockGetProcess.mockResolvedValue({
      sendMessage: mockSendMessage.mockResolvedValue({ response: 'Done.' }),
      getSessionId: () => 'existing-session',
    });

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(true);
    expect((result as { data: { response: string } }).data.response).toBe('Done.');
    expect(mockGetProcess).toHaveBeenCalledTimes(1);
  });

  it('retries after busy error and succeeds', async () => {
    mockGetProcess
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockRejectedValue(new Error('Process is busy')),
        getSessionId: () => 'session-1',
      })
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockRejectedValue(new Error('Process is busy')),
        getSessionId: () => 'session-1',
      })
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockResolvedValue({ response: 'Recovered!' }),
        getSessionId: () => 'session-1',
      });

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(true);
    expect((result as { data: { response: string } }).data.response).toBe('Recovered!');
    expect(mockGetProcess).toHaveBeenCalledTimes(3);
  });

  it('retries after crash error and succeeds', async () => {
    mockGetProcess
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockRejectedValue(new Error('Process exited with code 1')),
        getSessionId: () => 'session-1',
      })
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockResolvedValue({ response: 'Fresh process OK' }),
        getSessionId: () => 'session-2',
      });

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(true);
    expect((result as { data: { response: string } }).data.response).toBe('Fresh process OK');
    // Should have called stopProcess to clear the crashed process
    expect(mockStopProcess).toHaveBeenCalledWith('discord', 'channel-123', 'developer');
    expect(mockGetProcess).toHaveBeenCalledTimes(2);
  });

  it('returns error after MAX_RETRIES exhausted (busy)', async () => {
    const busyProcess = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Process is busy')),
      getSessionId: () => 'session-1',
    };
    mockGetProcess.mockResolvedValue(busyProcess);

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed after 3 attempts');
    expect(result.error).toContain('busy');
    expect(mockGetProcess).toHaveBeenCalledTimes(3);
  });

  it('returns error after MAX_RETRIES exhausted (crash)', async () => {
    const crashProcess = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Process exited with code 137')),
      getSessionId: () => 'session-1',
    };
    mockGetProcess.mockResolvedValue(crashProcess);

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed after 3 attempts');
    expect(result.error).toContain('exited with code');
    // Each crash should call stopProcess
    expect(mockStopProcess).toHaveBeenCalledTimes(3);
  });

  it('does not retry for non-retryable errors', async () => {
    mockGetProcess.mockResolvedValue({
      sendMessage: vi.fn().mockRejectedValue(new Error('Invalid JSON in response')),
      getSessionId: () => 'session-1',
    });

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed after 3 attempts');
    expect(result.error).toContain('Invalid JSON');
    // Only 1 attempt — non-retryable error breaks immediately
    expect(mockGetProcess).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Channel history injection tests
// ---------------------------------------------------------------------------

describe('delegate resilience — channel history injection', () => {
  let executor: GatewayToolExecutor;
  let dm: DelegationManager;
  let mockSendMessage: ReturnType<typeof vi.fn>;
  let mockGetProcess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSendMessage = vi.fn().mockResolvedValue({ response: 'Done.' });
    mockGetProcess = vi.fn();

    const mockAgentProcessManager = {
      getProcess: mockGetProcess,
      stopProcess: vi.fn(),
    } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager;

    dm = new DelegationManager(allAgents, new ToolPermissionManager());

    executor = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        listDecisions: vi.fn(),
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      },
    });

    executor.setAgentProcessManager(mockAgentProcessManager);
    executor.setDelegationManager(dm);
    executor.setCurrentAgentContext('conductor', 'discord', 'channel-123');
  });

  it('injects history when process has no sessionId (fresh process)', async () => {
    mockFormatForContext.mockReturnValue(
      '[Chat messages since your last reply - for context]\n- user: hello'
    );

    mockGetProcess.mockResolvedValue({
      sendMessage: mockSendMessage,
      getSessionId: () => undefined, // No session = fresh process
    });

    await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const sentPrompt = mockSendMessage.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('[Chat messages since your last reply');
    expect(sentPrompt).toContain('Fix bug');
  });

  it('does not inject history when process has existing session', async () => {
    mockFormatForContext.mockReturnValue(
      '[Chat messages since your last reply - for context]\n- user: hello'
    );

    mockGetProcess.mockResolvedValue({
      sendMessage: mockSendMessage,
      getSessionId: () => 'existing-session-id',
    });

    await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const sentPrompt = mockSendMessage.mock.calls[0][0] as string;
    // Should NOT contain history since session already exists
    expect(sentPrompt).not.toContain('[Chat messages since your last reply');
  });

  it('injects history on retry attempt even if session exists', async () => {
    mockFormatForContext.mockReturnValue(
      '[Chat messages since your last reply - for context]\n- user: context'
    );

    // First attempt: crash. Second attempt: success
    mockGetProcess
      .mockResolvedValueOnce({
        sendMessage: vi.fn().mockRejectedValue(new Error('Process exited with code 1')),
        getSessionId: () => 'session-1',
      })
      .mockResolvedValueOnce({
        sendMessage: mockSendMessage,
        getSessionId: () => 'session-2', // New session after crash
      });

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(result.success).toBe(true);
    // On retry (attempt > 0), history should be injected regardless of sessionId
    const sentPrompt = mockSendMessage.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('[Chat messages since your last reply');
  });

  it('proceeds without history when formatForContext returns empty', async () => {
    mockFormatForContext.mockReturnValue('');

    mockGetProcess.mockResolvedValue({
      sendMessage: mockSendMessage,
      getSessionId: () => undefined,
    });

    await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const sentPrompt = mockSendMessage.mock.calls[0][0] as string;
    // Should still contain the task but no history prefix
    expect(sentPrompt).toContain('Fix bug');
    expect(sentPrompt).not.toContain('[Chat messages');
  });
});
