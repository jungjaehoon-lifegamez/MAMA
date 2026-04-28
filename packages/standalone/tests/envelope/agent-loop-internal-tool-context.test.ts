import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type { AgentContext, MAMAApiInterface } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';
import { makeSignedEnvelope } from './fixtures.js';

const {
  persistentPromptMock,
  gatewayExecuteMock,
  postProcessInBackgroundMock,
  preCompactProcessMock,
  updateTokensMock,
} = vi.hoisted(() => ({
  persistentPromptMock: vi.fn(),
  gatewayExecuteMock: vi.fn(),
  postProcessInBackgroundMock: vi.fn(),
  preCompactProcessMock: vi.fn(),
  updateTokensMock: vi.fn(),
}));

vi.mock('../../src/agent/persistent-cli-adapter.js', () => ({
  PersistentCLIAdapter: vi.fn().mockImplementation(() => ({
    prompt: persistentPromptMock,
    setSessionId: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../../src/agent/session-pool.js', () => ({
  SessionPool: vi.fn().mockImplementation(() => ({
    getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    updateTokens: updateTokensMock,
    releaseSession: vi.fn(),
  })),
  getSessionPool: vi.fn().mockReturnValue({
    getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    updateTokens: updateTokensMock,
    releaseSession: vi.fn(),
  }),
  buildChannelKey: vi.fn((source: string, channelId: string) => `${source}:${channelId}`),
}));

vi.mock('../../src/agent/gateway-tool-executor.js', () => ({
  GatewayToolExecutor: vi.fn().mockImplementation(() => ({
    setAgentContext: vi.fn(),
    execute: gatewayExecuteMock,
  })),
}));

vi.mock('../../src/agent/post-tool-handler.js', () => ({
  PostToolHandler: vi.fn().mockImplementation(() => ({
    processInBackground: postProcessInBackgroundMock,
  })),
}));

vi.mock('../../src/agent/pre-compact-handler.js', () => ({
  PreCompactHandler: vi.fn().mockImplementation(() => ({
    process: preCompactProcessMock,
  })),
}));

function createMockOAuthManager(): OAuthManager {
  return { getToken: vi.fn().mockResolvedValue('token') } as unknown as OAuthManager;
}

function createMockApi(): MAMAApiInterface {
  return {
    save: vi.fn(),
    saveCheckpoint: vi.fn(),
    listDecisions: vi.fn(),
    suggest: vi.fn(),
    updateOutcome: vi.fn(),
    loadCheckpoint: vi.fn(),
  };
}

function createAgentContext(): AgentContext {
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['*'],
      systemControl: false,
      sensitiveAccess: false,
    },
    session: {
      sessionId: 'telegram:session',
      channelId: 'tg:1',
      userId: 'user-1',
      startedAt: new Date(),
    },
    capabilities: ['*'],
    limitations: [],
    tier: 2,
    backend: 'claude',
  };
}

function createExecutionOptions() {
  const envelope = makeSignedEnvelope({
    agent_id: 'chat_bot',
    source: 'telegram',
    channel_id: 'tg:1',
  });
  return {
    source: 'telegram',
    channelId: 'tg:1',
    agentContext: createAgentContext(),
    envelope,
    cliSessionId: 'cli-session-1',
    resumeSession: true,
  };
}

describe('AgentLoop internal tool context propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateTokensMock.mockReturnValue({ totalTokens: 10, nearThreshold: false });
    preCompactProcessMock.mockResolvedValue({
      unsavedDecisions: [],
      compactionPrompt: '',
      warningMessage: '',
    });
    gatewayExecuteMock.mockResolvedValue({ success: true, results: [], count: 0 });
  });

  it('passes active execution context to PostToolHandler background work', async () => {
    persistentPromptMock
      .mockResolvedValueOnce({
        response:
          '```tool_call\n{"name":"Write","input":{"path":"src/api.ts","content":"export function test() {}"}}\n```',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        response: 'Done',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const options = createExecutionOptions();
    const agentLoop = new AgentLoop(
      createMockOAuthManager(),
      { postToolUse: { enabled: true } },
      {},
      { mamaApi: createMockApi() }
    );

    await agentLoop.run('write a file', options);

    const contractSearchCall = gatewayExecuteMock.mock.calls.find(
      (call) => call[0] === 'mama_search'
    );
    expect(contractSearchCall?.[2]).toEqual(
      expect.objectContaining({
        agentContext: options.agentContext,
        source: 'telegram',
        channelId: 'tg:1',
        envelope: options.envelope,
        executionSurface: 'reactive_internal',
      })
    );

    const writeCall = gatewayExecuteMock.mock.calls.find((call) => call[0] === 'Write');
    expect(writeCall?.[2]).toEqual(
      expect.objectContaining({
        agentContext: options.agentContext,
        source: 'telegram',
        channelId: 'tg:1',
        envelope: options.envelope,
        executionSurface: 'model_tool',
      })
    );

    expect(postProcessInBackgroundMock).toHaveBeenCalledWith(
      'Write',
      { path: 'src/api.ts', content: 'export function test() {}' },
      expect.anything(),
      expect.objectContaining({
        agentContext: options.agentContext,
        source: 'telegram',
        channelId: 'tg:1',
        envelope: options.envelope,
        executionSurface: 'reactive_internal',
      })
    );
  });

  it('passes active execution context to PreCompactHandler when compaction check runs', async () => {
    updateTokensMock.mockReturnValue({ totalTokens: 9000, nearThreshold: true });
    persistentPromptMock.mockResolvedValueOnce({
      response: 'Done',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const options = createExecutionOptions();
    const agentLoop = new AgentLoop(
      createMockOAuthManager(),
      { preCompact: { enabled: true } },
      {},
      { mamaApi: createMockApi() }
    );

    await agentLoop.run('near threshold', options);

    expect(preCompactProcessMock).toHaveBeenCalledWith(
      ['near threshold'],
      expect.objectContaining({
        agentContext: options.agentContext,
        source: 'telegram',
        channelId: 'tg:1',
        envelope: options.envelope,
        executionSurface: 'reactive_internal',
      })
    );
  });

  it('passes active execution context through Code-Act HostBridge tool calls', async () => {
    persistentPromptMock
      .mockResolvedValueOnce({
        response: '```js\nmama_search({ query: "contracts" })\n```',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        response: 'Done',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const options = createExecutionOptions();
    const agentLoop = new AgentLoop(
      createMockOAuthManager(),
      { useCodeAct: true },
      {},
      { mamaApi: createMockApi() }
    );

    await agentLoop.run('use code act', options);

    expect(gatewayExecuteMock).toHaveBeenCalledWith(
      'mama_search',
      { query: 'contracts' },
      expect.objectContaining({
        agentContext: options.agentContext,
        source: 'telegram',
        channelId: 'tg:1',
        envelope: options.envelope,
        executionSurface: 'code_act',
      })
    );
  });
});
