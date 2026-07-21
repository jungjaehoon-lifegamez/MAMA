/**
 * Unit tests for AgentLoop
 *
 * Tests the agent loop with mocked ClaudeCLIWrapper
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentLoop,
  getGatewayToolsPrompt,
  loadBackendAgentsMd,
  sanitizeLegacyCodexAgentsMd,
} from '../../src/agent/agent-loop.js';
import type { HostToolBridge, PromptOptions } from '../../src/agent/model-runner.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { AgentContext, AgentLoopOptions, MAMAApiInterface } from '../../src/agent/types.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import { summarizeReportToolUse } from '../../src/operator/report-run.js';
import { buildMemoryAuditAckFromAgentResult } from '../../src/memory/memory-agent-ack.js';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

interface CanonicalDeclarationParam {
  name: string;
  type: string;
  required: boolean;
}

interface CanonicalDeclaration {
  name: string;
  params: CanonicalDeclarationParam[];
  returnType: string;
}

function splitTopLevelParams(source: string): string[] {
  if (source.trim() === '') {
    return [];
  }

  const params: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  const depth = { angle: 0, brace: 0, bracket: 0, paren: 0 };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '<') depth.angle += 1;
    if (char === '>') depth.angle -= 1;
    if (char === '{') depth.brace += 1;
    if (char === '}') depth.brace -= 1;
    if (char === '[') depth.bracket += 1;
    if (char === ']') depth.bracket -= 1;
    if (char === '(') depth.paren += 1;
    if (char === ')') depth.paren -= 1;
    if (
      char === ',' &&
      depth.angle === 0 &&
      depth.brace === 0 &&
      depth.bracket === 0 &&
      depth.paren === 0
    ) {
      params.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  params.push(source.slice(start).trim());
  return params;
}

function parseDeliveredCodeActDeclarations(systemPrompt: string): CanonicalDeclaration[] {
  const generatedSection = systemPrompt.match(
    /<!-- MAMA_GENERATED_CODE_ACT_START -->[\s\S]*?```typescript\n([\s\S]*?)\n```[\s\S]*?<!-- MAMA_GENERATED_CODE_ACT_END -->/
  )?.[1];
  if (!generatedSection) {
    throw new Error(
      'Effective system prompt did not contain a generated Code-Act declaration block'
    );
  }

  return generatedSection
    .split('\n')
    .filter((line) => line.startsWith('declare function '))
    .map((line) => {
      const match = line.match(/^declare function ([A-Za-z0-9_]+)\((.*)\): (.*);$/);
      if (!match) {
        throw new Error(`Could not parse Code-Act declaration: ${line}`);
      }
      const [, name, rawParams, returnType] = match;
      const params = splitTopLevelParams(rawParams).map((param) => {
        const paramMatch = param.match(/^([A-Za-z0-9_]+)(\?)?: (.+)$/);
        if (!paramMatch) {
          throw new Error(`Could not parse Code-Act parameter: ${param}`);
        }
        return {
          name: paramMatch[1],
          type: paramMatch[3],
          required: paramMatch[2] !== '?',
        };
      });
      return { name, params, returnType };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

const { codexRuntimeProcessMock, laneManagerEnqueueWithSessionMock } = vi.hoisted(() => ({
  codexRuntimeProcessMock: vi.fn(),
  laneManagerEnqueueWithSessionMock: vi.fn((_, fn) => fn()),
}));

const persistentPromptMock = vi.fn().mockResolvedValue({
  response: 'Mock response',
  usage: { input_tokens: 10, output_tokens: 5 },
  session_id: 'test-session',
});
const persistentCLIAdapterOptionsMock = vi.fn();
const persistentSetSystemPromptMock = vi.fn();
const gatewayExecutorSetAgentContextMock = vi.fn();
const gatewayExecutorSetCurrentAgentContextMock = vi.fn();
const gatewayExecutorClearCurrentAgentContextMock = vi.fn();
const gatewayExecutorSetUICommandQueueMock = vi.fn();
const gatewayExecutorSetSessionsDbMock = vi.fn();
const gatewayExecutorSetValidationServiceMock = vi.fn();
const gatewayExecutorSetRawStoreMock = vi.fn();
const gatewayExecutorBeginRuntimeModelRunMock = vi.fn().mockResolvedValue({
  model_run_id: 'mr_agent_loop_mock',
  status: 'running',
});
const gatewayExecutorCommitRuntimeModelRunMock = vi.fn().mockResolvedValue({
  model_run_id: 'mr_agent_loop_mock',
  status: 'committed',
});
const gatewayExecutorFailRuntimeModelRunMock = vi.fn().mockResolvedValue({
  model_run_id: 'mr_agent_loop_mock',
  status: 'failed',
});
const gatewayExecutorExecuteMock = vi.fn().mockResolvedValue({ success: true });

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
    PersistentCLIAdapter: vi.fn().mockImplementation((options) => {
      persistentCLIAdapterOptionsMock(options);
      return {
        prompt: persistentPromptMock,
        setSystemPrompt: persistentSetSystemPromptMock,
        setSessionId: vi.fn(),
        close: vi.fn(),
      };
    }),
  };
});

vi.mock('../../src/multi-agent/runtime-process.js', () => {
  return {
    CodexRuntimeProcess: vi.fn().mockImplementation((options) => {
      codexRuntimeProcessMock(options);
      return {
        prompt: persistentPromptMock,
        setSystemPrompt: persistentSetSystemPromptMock,
        setSessionId: vi.fn(),
        stop: vi.fn(),
      };
    }),
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
      resetSession: vi.fn().mockReturnValue('fresh-test-session'),
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
      beginRuntimeModelRun: gatewayExecutorBeginRuntimeModelRunMock,
      commitRuntimeModelRun: gatewayExecutorCommitRuntimeModelRunMock,
      failRuntimeModelRun: gatewayExecutorFailRuntimeModelRunMock,
      execute: gatewayExecutorExecuteMock,
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
  const mockToken = 'synthetic-test-oauth-token';

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
      channelId: '5551000001',
      userId: '5551000001',
      startedAt: new Date(),
    },
    capabilities: ['mama_search', 'mama_recall', 'mama_load_checkpoint', 'Read', 'telegram_send'],
    limitations: ['No Bash', 'No Write', 'No mama_save'],
    tier: 2,
    backend: 'claude',
  });

  const createCodexContext = (): AgentContext => ({
    ...createChatBotContext(),
    backend: 'codex',
    role: {
      ...createChatBotContext().role,
      allowedTools: ['mama_search', 'telegram_send'],
      blockedTools: ['telegram_send'],
    },
  });

  const withOuterCodeAct = <T extends AgentContext>(context: T): T =>
    ({
      ...context,
      role: {
        ...context.role,
        allowedTools: [
          'code_act',
          ...context.role.allowedTools.filter((tool) => tool !== 'code_act'),
        ],
      },
    }) as T;

  beforeEach(() => {
    vi.clearAllMocks();
    codexRuntimeProcessMock.mockClear();
    persistentPromptMock.mockReset().mockResolvedValue({
      response: 'Mock response',
      usage: { input_tokens: 10, output_tokens: 5 },
      session_id: 'test-session',
    });
    gatewayExecutorSetAgentContextMock.mockClear();
    gatewayExecutorSetCurrentAgentContextMock.mockClear();
    gatewayExecutorClearCurrentAgentContextMock.mockClear();
    gatewayExecutorSetUICommandQueueMock.mockClear();
    gatewayExecutorSetSessionsDbMock.mockClear();
    gatewayExecutorSetValidationServiceMock.mockClear();
    gatewayExecutorSetRawStoreMock.mockClear();
    gatewayExecutorBeginRuntimeModelRunMock.mockClear();
    gatewayExecutorCommitRuntimeModelRunMock.mockClear();
    gatewayExecutorFailRuntimeModelRunMock.mockClear();
    laneManagerEnqueueWithSessionMock.mockClear();
    persistentSetSystemPromptMock.mockClear();
    persistentCLIAdapterOptionsMock.mockClear();
  });

  describe('Codex native gateway bridge', () => {
    const codexContext = createCodexContext;

    it('forwards a Codex runtime rejection to the external onError callback exactly once', async () => {
      const modelError = new Error('codex native bridge aborted');
      persistentPromptMock.mockImplementationOnce(async (_text: string, callbacks: unknown) => {
        const runtimeCallbacks = callbacks as { onError?: (error: Error) => void };
        runtimeCallbacks.onError?.(modelError);
        throw modelError;
      });
      const onError = vi.fn();
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt' },
        {},
        { mamaApi: createMockApi() }
      );

      await expect(
        agentLoop.run('fail', {
          source: 'telegram',
          channelId: '5551000001',
          agentContext: codexContext(),
          streamCallbacks: { onError },
        })
      ).rejects.toThrow('CLI error: codex native bridge aborted');

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(modelError);
    });

    it('keeps individual role-allowed native tools when Code-Act is disabled', async () => {
      let bridge: HostToolBridge | undefined;
      let nativeResult: Awaited<ReturnType<HostToolBridge['execute']>> | undefined;
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          nativeResult = await bridge?.execute({
            callId: 'native-call-1',
            name: 'mama_search',
            input: { query: 'status' },
          });
          return {
            response: 'Native search complete',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      gatewayExecutorExecuteMock.mockResolvedValueOnce({ success: true, results: ['found'] });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: false },
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: createCodexContext(),
        stopAfterSuccessfulTools: ['mama_search'],
      });

      expect(bridge?.tools.map((tool) => tool.name)).toEqual(['mama_search']);
      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'mama_search',
        { query: 'status' },
        expect.objectContaining({
          executionSurface: 'model_tool',
          modelRunId: 'mr_agent_loop_mock',
          source: 'telegram',
          channelId: '5551000001',
        })
      );
      expect(nativeResult).toMatchObject({ isError: false, stop: true });
      expect(result.response).toBe('Native search complete');
    });

    it('structurally disables outer code_act for Codex while preserving unrelated owner tools', async () => {
      let bridge: HostToolBridge | undefined;
      let effectivePrompt = '';
      const nativeResults: Array<Awaited<ReturnType<HostToolBridge['execute']>>> = [];
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          if (!bridge) throw new Error('missing native bridge');
          nativeResults.push(
            await bridge.execute({ callId: 'disabled-code-act', name: 'code_act', input: {} })
          );
          nativeResults.push(
            await bridge.execute({
              callId: 'enabled-owner-search',
              name: 'mama_search',
              input: { query: 'status' },
            })
          );
          return {
            response: 'Codex structural disable complete',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-disabled-code-act-thread',
          };
        }
      );
      gatewayExecutorExecuteMock
        .mockImplementationOnce(async (...args: unknown[]) => {
          const context = args[2] as { disallowedGatewayTools?: string[] };
          return context.disallowedGatewayTools?.includes('code_act')
            ? { success: false, error: 'code_act structurally disabled' }
            : { success: true };
        })
        .mockResolvedValueOnce({ success: true, results: ['found'] });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'Codex owner prompt.', useCodeAct: false },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('owner status', {
        source: 'telegram',
        channelId: 'owner-chat',
        agentContext: {
          ...createCodexContext(),
          roleName: 'owner_console',
          role: DEFAULT_ROLES.definitions.owner_console,
        },
      });

      expect(bridge?.tools.map((tool) => tool.name)).toContain('mama_search');
      expect(bridge?.tools.map((tool) => tool.name)).not.toContain('code_act');
      expect(effectivePrompt).not.toContain('native app-server tool called `code_act`');
      expect(nativeResults[0]).toMatchObject({ isError: true });
      expect(nativeResults[1]).toMatchObject({ isError: false });
      expect(gatewayExecutorExecuteMock).toHaveBeenNthCalledWith(
        1,
        'code_act',
        {},
        expect.objectContaining({
          disallowedGatewayTools: expect.arrayContaining(['code_act', 'mcp__code-act__code_act']),
        })
      );
    });

    it('structurally disables parsed Claude code_act paths while preserving direct tools', async () => {
      let effectivePrompt = '';
      persistentPromptMock
        .mockImplementationOnce(
          async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
            effectivePrompt = promptOptions?.systemPrompt ?? '';
            return {
              response: '```js\nmama_search({ query: "must not parse" })\n```',
              usage: { input_tokens: 10, output_tokens: 5 },
              session_id: 'claude-disabled-code-act-session',
              toolUseBlocks: [
                { id: 'disabled-code-act', name: 'mcp__code-act__code_act', input: { code: '1' } },
                {
                  id: 'enabled-owner-search',
                  name: 'mama_search',
                  input: { query: 'status' },
                },
              ],
            };
          }
        )
        .mockResolvedValueOnce({
          response: 'Claude structural disable complete',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-disabled-code-act-session',
        });
      gatewayExecutorExecuteMock
        .mockImplementationOnce(async (...args: unknown[]) => {
          const context = args[2] as { disallowedGatewayTools?: string[] };
          return context.disallowedGatewayTools?.includes('code_act')
            ? { success: false, error: 'code_act structurally disabled' }
            : { success: true };
        })
        .mockResolvedValueOnce({ success: true, results: ['found'] });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'claude', systemPrompt: 'Claude owner prompt.', useCodeAct: false },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('owner status', {
        source: 'telegram',
        channelId: 'owner-chat',
        agentContext: {
          ...createChatBotContext(),
          roleName: 'owner_console',
          role: DEFAULT_ROLES.definitions.owner_console,
        },
      });

      expect(effectivePrompt).not.toContain('- **code_act**');
      expect(effectivePrompt).not.toContain('Code-Act: Gateway Tool Execution via Sandbox');
      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(2);
      expect(gatewayExecutorExecuteMock).toHaveBeenNthCalledWith(
        1,
        'code_act',
        { code: '1' },
        expect.objectContaining({
          disallowedGatewayTools: expect.arrayContaining(['code_act', 'mcp__code-act__code_act']),
        })
      );
      expect(gatewayExecutorExecuteMock).toHaveBeenNthCalledWith(
        2,
        'mama_search',
        { query: 'status' },
        expect.any(Object)
      );
    });

    it('removes disabled code_act guidance from resumed Claude prompts', async () => {
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Resumed without Code-Act',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'claude-resumed-disabled-code-act-session',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'claude', systemPrompt: 'constructor prompt', useCodeAct: false },
        {},
        { mamaApi: createMockApi() }
      );
      const stalePrompt = [
        'Resumed owner prompt.',
        '- **code_act**(code) — stale gateway advertisement',
        '<!-- MAMA_GENERATED_CODE_ACT_START -->',
        '## Code-Act: Gateway Tool Execution via Sandbox',
        'You have an MCP tool called `code_act`.',
        '<!-- MAMA_GENERATED_CODE_ACT_END -->',
      ].join('\n');

      await agentLoop.run('owner status', {
        source: 'telegram',
        channelId: 'owner-chat',
        resumeSession: true,
        systemPrompt: stalePrompt,
        agentContext: {
          ...createChatBotContext(),
          roleName: 'owner_console',
          role: DEFAULT_ROLES.definitions.owner_console,
        },
      });

      expect(effectivePrompt).toContain('Resumed owner prompt.');
      expect(effectivePrompt).not.toContain('- **code_act**');
      expect(effectivePrompt).not.toContain('MAMA_GENERATED_CODE_ACT');
      expect(effectivePrompt).not.toContain('Code-Act: Gateway Tool Execution via Sandbox');
    });

    it('keeps computed code_act blocks on resumed Claude hybrid-MCP processes', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mama-claude-hybrid-mcp-'));
      const mcpConfigPath = join(tempDir, 'mcp.json');
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            'code-act': { command: 'node', args: ['code-act-server.js'] },
          },
        })
      );
      persistentPromptMock
        .mockResolvedValueOnce({
          response: '',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-hybrid-resumed-session',
          toolUseBlocks: [
            { id: 'disabled-code-act', name: 'mcp__code-act__code_act', input: { code: '1' } },
            {
              id: 'enabled-owner-search',
              name: 'mama_search',
              input: { query: 'status' },
            },
          ],
        })
        .mockResolvedValueOnce({
          response: 'Hybrid resume complete',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-hybrid-resumed-session',
        });
      gatewayExecutorExecuteMock
        .mockImplementationOnce(async (...args: unknown[]) => {
          const context = args[2] as { disallowedGatewayTools?: string[] };
          return context.disallowedGatewayTools?.includes('code_act')
            ? { success: false, error: 'code_act structurally disabled' }
            : { success: true };
        })
        .mockResolvedValueOnce({ success: true, results: ['found'] });

      try {
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          {
            backend: 'claude',
            systemPrompt: 'Claude hybrid owner prompt.',
            useCodeAct: false,
            disallowedTools: ['Bash'],
            toolsConfig: { gateway: ['*'], mcp: ['*'], mcp_config: mcpConfigPath },
          },
          {},
          { mamaApi: createMockApi() }
        );

        expect(persistentCLIAdapterOptionsMock).toHaveBeenCalledWith(
          expect.objectContaining({
            mcpConfigPath,
            disallowedTools: expect.arrayContaining([
              'Bash',
              'code_act',
              'mcp__code-act__code_act',
            ]),
          })
        );
        const processDisallowed = persistentCLIAdapterOptionsMock.mock.calls[0]?.[0]
          ?.disallowedTools as string[];
        expect(processDisallowed).not.toContain('mama_search');

        await agentLoop.run('owner status', {
          source: 'telegram',
          channelId: 'owner-chat',
          cliSessionId: 'existing-claude-hybrid-session',
          resumeSession: true,
          agentContext: {
            ...createChatBotContext(),
            roleName: 'owner_console',
            role: DEFAULT_ROLES.definitions.owner_console,
          },
        });

        expect(persistentPromptMock.mock.calls[0]?.[2]?.resumeSession).toBe(true);
        expect(gatewayExecutorExecuteMock).toHaveBeenNthCalledWith(
          1,
          'code_act',
          { code: '1' },
          expect.objectContaining({
            disallowedGatewayTools: expect.arrayContaining([
              'Bash',
              'code_act',
              'mcp__code-act__code_act',
            ]),
          })
        );
        expect(gatewayExecutorExecuteMock).toHaveBeenNthCalledWith(
          2,
          'mama_search',
          { query: 'status' },
          expect.any(Object)
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('advertises only outer code_act with projected native instructions when enabled', async () => {
      let bridge: HostToolBridge | undefined;
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Code-Act ready',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = {
        ...context.role,
        allowedTools: ['code_act', 'mama_search', 'mama_recall', 'telegram_send'],
        blockedTools: ['telegram_send'],
      };
      const policy = projectCodeActToolPolicy({ tier: 2, role: context.role });

      await agentLoop.run('search through code', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
        systemPrompt: 'caller prompt',
      });

      expect(bridge?.tools).toEqual([
        {
          type: 'function',
          name: 'code_act',
          description: expect.stringContaining('QuickJS'),
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              allowedTools: { type: 'array', items: { type: 'string' } },
              blockedTools: { type: 'array', items: { type: 'string' } },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      ]);
      expect(effectivePrompt).toContain('native app-server tool called `code_act`');
      expect(effectivePrompt).toContain(TypeDefinitionGenerator.generate(policy));
      expect(effectivePrompt).toContain('declare function mama_search');
      expect(effectivePrompt).not.toContain('declare function telegram_send');
      expect(effectivePrompt).not.toContain('mcp__code-act__code_act');
      expect(effectivePrompt).not.toContain('MCP transport');
    });

    it('keeps effective Claude and Codex Code-Act declarations identical to the injected owner surface', async () => {
      const effectivePrompts = new Map<'claude' | 'codex', string>();
      const outerBridges = new Map<'claude' | 'codex', HostToolBridge | undefined>();
      for (const backend of ['claude', 'codex'] as const) {
        persistentPromptMock.mockImplementationOnce(
          async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
            effectivePrompts.set(backend, promptOptions?.systemPrompt ?? '');
            outerBridges.set(backend, promptOptions?.hostToolBridge);
            return {
              response: `${backend} parity captured`,
              usage: { input_tokens: 10, output_tokens: 5 },
              session_id: `${backend}-parity-session`,
            };
          }
        );
      }

      const runtimeDisallowedTools = ['mama_save'];
      const ownerRole = {
        ...DEFAULT_ROLES.definitions.owner_console,
        allowedTools: [...DEFAULT_ROLES.definitions.owner_console.allowedTools, 'telegram_send'],
        blockedTools: [
          ...(DEFAULT_ROLES.definitions.owner_console.blockedTools ?? []),
          'mama_update',
        ],
      };
      const contextFor = (backend: 'claude' | 'codex'): AgentContext => ({
        ...createChatBotContext(),
        backend,
        roleName: 'owner_console',
        role: ownerRole,
        capabilities: [...ownerRole.allowedTools],
        limitations: [...ownerRole.blockedTools],
        tier: 2,
      });

      for (const backend of ['claude', 'codex'] as const) {
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          {
            backend,
            systemPrompt: 'Identical owner parity prompt.',
            useCodeAct: true,
            disallowedTools: runtimeDisallowedTools,
          },
          {},
          { mamaApi: createMockApi() }
        );

        await agentLoop.run('capture effective Code-Act surface', {
          source: 'telegram',
          channelId: `owner-parity-${backend}`,
          agentContext: contextFor(backend),
          systemPrompt: 'Identical owner parity prompt.',
          resumeSession: false,
        });
      }

      const claudePrompt = effectivePrompts.get('claude') ?? '';
      const codexPrompt = effectivePrompts.get('codex') ?? '';
      const claudeDeclarations = parseDeliveredCodeActDeclarations(claudePrompt);
      const codexDeclarations = parseDeliveredCodeActDeclarations(codexPrompt);

      expect(claudeDeclarations.length).toBeGreaterThan(5);
      expect(claudeDeclarations).toEqual(codexDeclarations);
      expect(claudePrompt).toContain('MCP tool called `code_act`');
      expect(claudePrompt).toContain('mcp__code-act__code_act');
      expect(claudePrompt).not.toContain('native app-server tool called `code_act`');
      expect(outerBridges.get('claude')).toBeUndefined();
      expect(codexPrompt).toContain('native app-server tool called `code_act`');
      expect(codexPrompt).not.toContain('mcp__code-act__code_act');
      expect(outerBridges.get('codex')?.tools).toEqual([
        {
          type: 'function',
          name: 'code_act',
          description: expect.any(String),
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              allowedTools: { type: 'array', items: { type: 'string' } },
              blockedTools: { type: 'array', items: { type: 'string' } },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      ]);

      const declaredNames = claudeDeclarations.map((declaration) => declaration.name);
      expect(ownerRole.allowedTools).toEqual(
        expect.arrayContaining(['mama_update', 'mama_save', 'telegram_send'])
      );
      expect(ownerRole.blockedTools).toContain('mama_update');
      expect(runtimeDisallowedTools).toContain('mama_save');
      expect(declaredNames).not.toContain('mama_update');
      expect(declaredNames).not.toContain('mama_save');
      expect(declaredNames).not.toContain('telegram_send');

      const ownerWorkflowNames = [
        'audit_findings_read',
        'board_read',
        'context_compile',
        'mama_recall',
        'report_request',
        'workorder_request',
        'workorder_status',
      ];
      expect(
        claudeDeclarations.filter((declaration) => ownerWorkflowNames.includes(declaration.name))
      ).toEqual([
        {
          name: 'audit_findings_read',
          params: [],
          returnType: '{ findings: unknown; message?: string }',
        },
        {
          name: 'board_read',
          params: [],
          returnType: '{ slots: Record<string, { html: string; updatedAt?: string | null }> }',
        },
        {
          name: 'context_compile',
          params: [
            { name: 'task', type: 'string', required: true },
            {
              name: 'scopes',
              type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
              required: false,
            },
            { name: 'connectors', type: 'string[]', required: false },
            { name: 'seed_refs', type: 'Array<Record<string, unknown>>', required: false },
            {
              name: 'range',
              type: '{ start_ms?: number; end_ms?: number }',
              required: false,
            },
            { name: 'as_of', type: 'string | number | null', required: false },
            { name: 'limit', type: 'number', required: false },
            { name: 'max_tool_calls', type: 'number', required: false },
            { name: 'max_ms', type: 'number', required: false },
            { name: 'max_tokens', type: 'number', required: false },
            {
              name: 'strictness',
              type: "'recall' | 'balanced' | 'strict'",
              required: false,
            },
          ],
          returnType:
            '{ packet_id: string; packet: Record<string, unknown>; model_run_id?: string; parent_model_run_id?: string | null }',
        },
        {
          name: 'mama_recall',
          params: [
            { name: 'query', type: 'string', required: true },
            {
              name: 'scopes',
              type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
              required: false,
            },
          ],
          returnType:
            '{ bundle: { profile: { static: Array<Record<string, unknown>>; dynamic: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }; memories: Array<Record<string, unknown>>; graph_context: { primary: Array<Record<string, unknown>>; expanded: Array<Record<string, unknown>>; edge_count: number } } }',
        },
        { name: 'report_request', params: [], returnType: '{ message: string }' },
        {
          name: 'workorder_request',
          params: [
            {
              name: 'kind',
              type: "'board' | 'wiki' | 'memory-curation'",
              required: true,
            },
          ],
          returnType: '{ message: string }',
        },
        {
          name: 'workorder_status',
          params: [],
          returnType:
            "{ data: { kinds: Array<{ workKind: 'board' | 'wiki' | 'memory-curation'; lastRunAt: number | null; lastStatus: 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled' | 'failed' | null; failedCount: number; lastFailureReason: string | null }> } }",
        },
      ]);

      const { GatewayToolExecutor: ActualGatewayToolExecutor } = await vi.importActual<
        typeof import('../../src/agent/gateway-tool-executor.js')
      >('../../src/agent/gateway-tool-executor.js');
      const actualExecutor = new ActualGatewayToolExecutor({ mamaApi: createMockApi() });
      const registryNames = HostBridge.getToolRegistry().map((tool) => tool.name);
      const inspectInjectedTypes = `({ ${registryNames
        .map((name) => `${JSON.stringify(name)}: typeof ${name}`)
        .join(', ')} })`;
      const executionContext = {
        agentContext: contextFor('codex'),
        agentId: 'owner_console',
        source: 'telegram',
        channelId: 'owner-parity-codex',
        executionSurface: 'model_tool' as const,
        disallowedGatewayTools: runtimeDisallowedTools,
      };
      const injectedResult = await actualExecutor.execute(
        'code_act',
        { code: inspectInjectedTypes },
        executionContext
      );
      expect(injectedResult.success).toBe(true);
      const injectedPayload = JSON.parse(String(injectedResult.message)) as {
        value: Record<string, string>;
      };
      const injectedNames = Object.entries(injectedPayload.value)
        .filter(([, type]) => type === 'function')
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      expect(declaredNames).toEqual(injectedNames);

      const narrowedResult = await actualExecutor.execute(
        'code_act',
        {
          code: inspectInjectedTypes,
          allowedTools: ['context_compile', 'mama_recall', 'board_read', 'workorder_request'],
          blockedTools: ['workorder_request'],
        },
        executionContext
      );
      expect(narrowedResult.success).toBe(true);
      const narrowedPayload = JSON.parse(String(narrowedResult.message)) as {
        value: Record<string, string>;
      };
      expect(narrowedPayload.value).toMatchObject({
        context_compile: 'function',
        mama_recall: 'function',
        board_read: 'function',
        workorder_request: 'undefined',
        mama_search: 'undefined',
      });
    });

    it('exposes outer code_act for the owner while keeping sensitive inner tools inaccessible', async () => {
      let bridge: HostToolBridge | undefined;
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Owner Code-Act ready',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-owner-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );
      const context: AgentContext = {
        ...createCodexContext(),
        roleName: 'owner_console',
        role: DEFAULT_ROLES.definitions.owner_console,
      };

      await agentLoop.run('owner status', {
        source: 'telegram',
        channelId: 'owner-chat',
        agentContext: context,
      });

      expect(bridge?.tools.map((tool) => tool.name)).toEqual(['code_act']);
      expect(context.role.allowedTools).toContain('code_act');
      for (const blocked of ['Bash', 'Write', 'delegate', 'save_integration_token']) {
        expect(effectivePrompt).not.toContain(`declare function ${blocked}`);
      }
    });

    it('removes outer code_act and stale guidance when a custom owner role does not allow it', async () => {
      let bridge: HostToolBridge | undefined;
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Custom owner without Code-Act',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-custom-owner-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'codex',
          systemPrompt: [
            'Custom owner prompt.',
            '',
            '<!-- MAMA_GENERATED_CODE_ACT_START -->',
            '## Code-Act: Gateway Tool Execution via Sandbox',
            'You have a native app-server tool called `code_act`.',
            '<!-- MAMA_GENERATED_CODE_ACT_END -->',
          ].join('\n'),
          useCodeAct: true,
        },
        {},
        { mamaApi: createMockApi() }
      );
      const context: AgentContext = {
        ...createCodexContext(),
        roleName: 'owner_console',
        role: {
          ...DEFAULT_ROLES.definitions.owner_console,
          allowedTools: ['mama_search'],
        },
      };

      await agentLoop.run('owner status', {
        source: 'telegram',
        channelId: 'custom-owner-chat',
        agentContext: context,
      });

      expect(bridge?.tools).toEqual([]);
      expect(effectivePrompt).toContain('Custom owner prompt.');
      expect(effectivePrompt).not.toContain('MAMA_GENERATED_CODE_ACT');
      expect(effectivePrompt).not.toContain('Code-Act: Gateway Tool Execution via Sandbox');
      expect(effectivePrompt).not.toContain('native app-server tool called `code_act`');
    });

    it('exposes no outer code_act or guidance when a run has no effective role', async () => {
      let bridge: HostToolBridge | undefined;
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'No role Code-Act denied',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-no-role-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'No-role prompt.', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('status', {
        source: 'cli',
        channelId: 'no-role',
      });

      expect(bridge?.tools).toEqual([]);
      expect(effectivePrompt).toContain('No-role prompt.');
      expect(effectivePrompt).not.toContain('MAMA_GENERATED_CODE_ACT');
      expect(effectivePrompt).not.toContain('Code-Act: Gateway Tool Execution via Sandbox');
      expect(effectivePrompt).not.toContain('native app-server tool called `code_act`');
    });

    it('keeps the native outer code_act bridge authoritative when legacy gateway ads are disabled', async () => {
      let bridge: HostToolBridge | undefined;
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          bridge = promptOptions?.hostToolBridge;
          return {
            response: 'Code-Act ready',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'codex',
          systemPrompt: 'base prompt',
          useCodeAct: true,
          toolsConfig: { gateway: [], mcp: [], mcp_config: '/tmp/unused.json' },
        },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('search through code', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: withOuterCodeAct(createCodexContext()),
      });

      expect(bridge?.tools.map((tool) => tool.name)).toEqual(['code_act']);
    });

    it('routes native outer code_act through GatewayToolExecutor with the full run context', async () => {
      let nativeResult: Awaited<ReturnType<HostToolBridge['execute']>> | undefined;
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          nativeResult = await bridge.execute({
            callId: 'native-code-act-1',
            name: 'code_act',
            input: {
              code: 'mama_search({ query: "status" })',
              allowedTools: ['mama_search'],
              blockedTools: [],
            },
          });
          return {
            response: 'Native Code-Act complete',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      gatewayExecutorExecuteMock.mockResolvedValueOnce({ success: true, message: 'found' });
      const envelope = makeSignedEnvelope({
        agent_id: 'code-act-worker',
        instance_id: 'inst_native_code_act',
      });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'codex',
          systemPrompt: 'base prompt',
          useCodeAct: true,
          disallowedTools: ['Write'],
        },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = {
        ...context.role,
        allowedTools: ['code_act', 'mama_search', 'Read'],
        blockedTools: ['Read'],
      };

      await agentLoop.run('execute code', {
        source: 'operator',
        channelId: 'report',
        sourceTurnId: 'turn-native-1',
        sourceMessageRef: 'telegram:message:42',
        modelRunId: 'mr_native_code_act',
        envelope,
        agentContext: context,
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(1);
      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'code_act',
        {
          code: 'mama_search({ query: "status" })',
          allowedTools: ['mama_search'],
          blockedTools: [],
        },
        expect.objectContaining({
          agentContext: expect.objectContaining({ role: context.role }),
          agentId: 'chat_bot',
          source: 'operator',
          channelId: 'report',
          envelope,
          executionSurface: 'model_tool',
          sourceTurnId: 'turn-native-1',
          sourceMessageRef: 'telegram:message:42',
          modelRunId: 'mr_native_code_act',
          backgroundTasks: expect.objectContaining({ register: expect.any(Function) }),
          disallowedGatewayTools: ['Write'],
        })
      );
      expect(nativeResult).toMatchObject({ isError: false });
    });

    it('routes Claude parsed JavaScript through the same GatewayToolExecutor code_act branch', async () => {
      persistentPromptMock
        .mockResolvedValueOnce({
          response: '```js\nmama_search({ query: "shared branch" })\n```',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
        })
        .mockResolvedValueOnce({
          response: 'Claude Code-Act complete',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
        });
      gatewayExecutorExecuteMock.mockResolvedValueOnce({ success: true, message: 'found' });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'claude', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('execute code', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: withOuterCodeAct(createChatBotContext()),
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(1);
      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'code_act',
        { code: 'mama_search({ query: "shared branch" })' },
        expect.objectContaining({ executionSurface: 'model_tool' })
      );
    });

    it('routes the Claude MCP compatibility name through canonical GatewayToolExecutor code_act', async () => {
      persistentPromptMock
        .mockResolvedValueOnce({
          response: '',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
          toolUseBlocks: [
            {
              id: 'claude-mcp-code-act-1',
              name: 'mcp__code-act__code_act',
              input: { code: 'mama_search({ query: "compatibility" })' },
            },
          ],
        })
        .mockResolvedValueOnce({
          response: 'Claude Code-Act complete',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
        });
      gatewayExecutorExecuteMock.mockResolvedValueOnce({ success: true, message: 'found' });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'claude', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('execute code', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: withOuterCodeAct(createChatBotContext()),
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'code_act',
        { code: 'mama_search({ query: "compatibility" })' },
        expect.objectContaining({ executionSurface: 'model_tool' })
      );
    });

    it('allows multiple different native tools within one maxTurns=1 Codex model turn', async () => {
      const nativeResults: Array<Awaited<ReturnType<HostToolBridge['execute']>>> = [];
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          nativeResults.push(
            await bridge.execute({ callId: 'call-1', name: 'mama_search', input: { query: 'one' } })
          );
          nativeResults.push(
            await bridge.execute({ callId: 'call-2', name: 'mama_recall', input: { query: 'two' } })
          );
          return {
            response: 'done',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', maxTurns: 1 },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = {
        ...context.role,
        allowedTools: ['mama_search', 'mama_recall'],
        blockedTools: [],
      };

      await agentLoop.run('search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(2);
      expect(nativeResults).toEqual([
        expect.objectContaining({ isError: false }),
        expect.objectContaining({ isError: false }),
      ]);
    });

    it('fails closed before the 51st native executor call at the emergency callback cap', async () => {
      let blocked: Awaited<ReturnType<HostToolBridge['execute']>> | undefined;
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          for (let index = 1; index <= 51; index += 1) {
            const result = await bridge.execute({
              callId: `call-${index}`,
              name: index % 2 === 0 ? 'mama_recall' : 'mama_search',
              input: { query: String(index) },
            });
            if (index === 51) blocked = result;
          }
          return {
            response: 'done',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', maxTurns: 1 },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = {
        ...context.role,
        allowedTools: ['mama_search', 'mama_recall'],
        blockedTools: [],
      };

      await agentLoop.run('search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(50);
      expect(blocked).toMatchObject({
        content: 'Native tool call budget exceeded emergency maximum turns (50)',
        isError: true,
        abort: true,
      });
    });

    it('fails closed before the fifteenth consecutive native call of the same tool', async () => {
      let blocked: Awaited<ReturnType<HostToolBridge['execute']>> | undefined;
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          for (let index = 1; index <= 15; index += 1) {
            const result = await bridge.execute({
              callId: `call-${index}`,
              name: 'mama_search',
              input: { query: String(index) },
            });
            if (index === 15) blocked = result;
          }
          return {
            response: 'done',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', maxTurns: 20 },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: codexContext(),
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledTimes(14);
      expect(blocked).toMatchObject({ isError: true, abort: true });
    });

    it.each([
      ['Markdown', '```tool_call\n{"name":"mama_search","input":{"query":"x"}}\n```'],
      ['JavaScript', '```js\nawait mama_search({ query: "x" });\n```'],
    ])('does not execute a literal %s tool block returned as Codex text', async (_kind, text) => {
      persistentPromptMock.mockResolvedValueOnce({
        response: text,
        usage: { input_tokens: 10, output_tokens: 5 },
        session_id: 'codex-thread',
      });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('return text', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: codexContext(),
      });

      expect(gatewayExecutorExecuteMock).not.toHaveBeenCalled();
      expect(result.response).toContain(text);
      expect(persistentPromptMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the Claude Markdown tool path working', async () => {
      persistentPromptMock
        .mockResolvedValueOnce({
          response: '```tool_call\n{"name":"mama_search","input":{"query":"x"}}\n```',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
        })
        .mockResolvedValueOnce({
          response: 'Claude tool complete',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'claude-session',
        });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'claude', systemPrompt: 'base prompt' },
        {},
        { mamaApi: createMockApi() }
      );

      const result = await agentLoop.run('search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: createChatBotContext(),
      });

      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'mama_search',
        { query: 'x' },
        expect.any(Object)
      );
      expect(result.response).toBe('Claude tool complete');
    });

    it('records native gather and write exchanges in report-auditable history exactly once', async () => {
      const onTurn = vi.fn();
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          await bridge.execute({ callId: 'gather-1', name: 'kagemusha_tasks', input: {} });
          await bridge.execute({
            callId: 'write-1',
            name: 'mama_save',
            input: { type: 'decision', topic: 'status' },
          });
          return {
            response: 'Final native report',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      gatewayExecutorExecuteMock
        .mockResolvedValueOnce({ success: true, tasks: [] })
        .mockResolvedValueOnce({ success: true, id: 'decision-1' });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt' },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = {
        ...context.role,
        allowedTools: ['kagemusha_tasks', 'mama_save'],
        blockedTools: [],
      };

      const result = await agentLoop.run('write report', {
        source: 'operator',
        channelId: 'report',
        agentContext: context,
        onTurn,
      });

      expect(
        result.history.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.map((block) =>
                block.type === 'tool_use'
                  ? `assistant:tool_use:${block.id}`
                  : block.type === 'tool_result'
                    ? `user:tool_result:${block.tool_use_id}`
                    : `${message.role}:${block.type}`
              )
            : []
        )
      ).toEqual([
        'user:text',
        'assistant:tool_use:gather-1',
        'user:tool_result:gather-1',
        'assistant:tool_use:write-1',
        'user:tool_result:write-1',
        'assistant:text',
      ]);
      expect(summarizeReportToolUse(result.history)).toMatchObject({
        gatherTools: ['kagemusha_tasks'],
        writeTools: ['mama_save'],
        all: ['kagemusha_tasks', 'mama_save'],
      });
      expect(onTurn.mock.calls.map(([entry]) => entry.role)).toEqual([
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(result.response).toBe('Final native report');
    });

    it('records a failed native mama_save so memory audit returns failed/save', async () => {
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          const bridge = promptOptions?.hostToolBridge;
          if (!bridge) throw new Error('missing native bridge');
          await bridge.execute({
            callId: 'save-failed',
            name: 'mama_save',
            input: { type: 'decision', topic: 'failed' },
          });
          return {
            response: 'Save failed honestly',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      gatewayExecutorExecuteMock.mockResolvedValueOnce({
        success: false,
        error: 'database rejected save',
      });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt' },
        {},
        { mamaApi: createMockApi() }
      );
      const context = codexContext();
      context.role = { ...context.role, allowedTools: ['mama_save'], blockedTools: [] };

      const result = await agentLoop.run('save memory', {
        source: 'system',
        channelId: 'memory',
        agentContext: context,
      });
      const ack = buildMemoryAuditAckFromAgentResult(result, 4, 4);

      expect(ack).toMatchObject({ status: 'failed', action: 'save' });
      expect(
        result.history.filter(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_use' && block.name === 'mama_save')
        )
      ).toHaveLength(1);
    });

    it('sanitizes the known installed Codex legacy protocol without overwriting custom content', () => {
      const tempHome = mkdtempSync(join(tmpdir(), 'mama-codex-agents-'));
      const previousHome = process.env.HOME;
      const mamaHome = join(tempHome, '.mama');
      const agentsPath = join(mamaHome, 'AGENTS.codex.md');
      const legacy = `# Codex Backend — Self-Awareness

User-authored preface must stay.

## Tool protocol

Gateway tools via \`tool_call\` JSON blocks:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

Do NOT use \`exec_command\` or \`apply_patch\` — those are Codex defaults but bypass MAMA's gateway. Tool calls are executed automatically; do not wrap in \`curl\` or \`Bash\`.

## Available gateway tools

\`mama_search\`, \`mama_save\`, \`mama_recall\`, \`mama_update\`, \`mama_load_checkpoint\`, \`discord_send\`, \`slack_send\`, \`Read\`, \`Write\`, \`Bash\`. Check the skill \`SKILL.md\` for skill-provided extras.

## Behavioural traits to know about yourself

User-authored behavioural guidance must stay.

## Custom Notes

Keep this appended customization exactly.
`;
      mkdirSync(mamaHome, { recursive: true });
      writeFileSync(agentsPath, legacy);
      process.env.HOME = tempHome;

      try {
        const loaded = loadBackendAgentsMd('codex');

        expect(loaded).toContain('native host tools');
        expect(loaded).not.toContain('```tool_call');
        expect(loaded).not.toContain('Gateway tools via `tool_call` JSON blocks');
        expect(loaded).not.toContain('## Available gateway tools');
        expect(loaded).not.toContain('`mama_search`, `mama_save`, `mama_recall`');
        expect(loaded).not.toContain("bypass MAMA's gateway");
        expect(loaded).toContain('User-authored preface must stay.');
        expect(loaded).toContain('User-authored behavioural guidance must stay.');
        expect(loaded).toContain('Keep this appended customization exactly.');
        expect(readFileSync(agentsPath, 'utf-8')).toBe(legacy);
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
        rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it('preserves custom lines and subheadings inside a legacy Tool Usage section', () => {
      const legacyWithCustomContent = `# Codex Backend Tool Rules

## Tool Usage

You are running on the Codex backend. Use gateway tools via \`tool_call\` JSON blocks.

CUSTOM INLINE RULE: keep this exact line.

### How to Call Tools

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

### User Custom Protocol Notes

Keep this custom subheading and body in the same order.

### Available Gateway Tools

- **mama_search**(query?, type?, limit?) — Search decisions in MAMA memory
- **mama_save**(type, topic?, decision?, reasoning?) — Save decision or checkpoint
- **Read**(path) — Read file

### Important

- Do NOT use \`exec_command\` or \`apply_patch\` — use gateway tools instead
- Tool calls are executed automatically. No need to use curl or Bash for these.

### Skills

Skills provide additional tools.
`;

      const sanitized = sanitizeLegacyCodexAgentsMd(legacyWithCustomContent);

      expect(sanitized).toContain('CUSTOM INLINE RULE: keep this exact line.');
      expect(sanitized).toContain('### User Custom Protocol Notes');
      expect(sanitized).toContain('Keep this custom subheading and body in the same order.');
      expect(sanitized.indexOf('CUSTOM INLINE RULE')).toBeLessThan(
        sanitized.indexOf('### User Custom Protocol Notes')
      );
      expect(sanitized.indexOf('### User Custom Protocol Notes')).toBeLessThan(
        sanitized.indexOf('### Skills')
      );
      expect(sanitized).toContain('native host tools');
      expect(sanitized).not.toContain('```tool_call');
      expect(sanitized).not.toContain('Use gateway tools via `tool_call` JSON blocks');
      expect(sanitized).not.toContain('### Available Gateway Tools');
      expect(sanitized).not.toContain('**mama_search**');
      expect(sanitized).not.toContain('use gateway tools instead');
      expect(sanitized).not.toContain('Tool calls are executed automatically');
    });

    it('returns non-legacy Codex agent content byte-for-byte unchanged', () => {
      const custom = `# Custom Codex Rules\r\n\r\n## Tool Usage\r\n\r\nUse only tools explicitly provided by the host.\r\n\r\n### Custom\r\n\r\nPreserve spacing, wording, and CRLF.\r\n`;

      expect(sanitizeLegacyCodexAgentsMd(custom)).toBe(custom);
    });
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
        channelId: '5551000001',
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

    it('binds envelope agent and instance ids to parent model runs', async () => {
      const envelope = makeSignedEnvelope({
        agent_id: 'worker',
        instance_id: 'inst_context_compile_parent',
      });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {},
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Compile context', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: createChatBotContext(),
        envelope,
      });

      expect(gatewayExecutorBeginRuntimeModelRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'worker',
          instance_id: 'inst_context_compile_parent',
          envelope_hash: envelope.envelope_hash,
        })
      );
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

    it('filters role-blocked gateway tools out of Code-Act declarations', async () => {
      const { PersistentCLIAdapter } = await import('../../src/agent/persistent-cli-adapter.js');
      const adapterMock = PersistentCLIAdapter as unknown as ReturnType<typeof vi.fn>;
      adapterMock.mockClear();

      new AgentLoop(
        createMockOAuthManager(),
        {
          systemPrompt: 'base prompt',
          useCodeAct: true,
          agentContext: {
            ...createChatBotContext(),
            role: {
              ...createChatBotContext().role,
              allowedTools: ['*'],
              blockedTools: ['mama_save'],
            },
          },
        },
        {},
        { mamaApi: createMockApi() }
      );

      const callOptions = adapterMock.mock.calls.at(-1)?.[0] as { systemPrompt?: string };
      expect(callOptions.systemPrompt).toContain('declare function mama_search');
      expect(callOptions.systemPrompt).not.toContain('declare function mama_save');
    });

    it('expands blocked-only roles before generating Code-Act declarations', async () => {
      const { PersistentCLIAdapter } = await import('../../src/agent/persistent-cli-adapter.js');
      const adapterMock = PersistentCLIAdapter as unknown as ReturnType<typeof vi.fn>;
      adapterMock.mockClear();

      new AgentLoop(
        createMockOAuthManager(),
        {
          systemPrompt: 'base prompt',
          useCodeAct: true,
          agentContext: {
            ...createChatBotContext(),
            role: {
              ...createChatBotContext().role,
              allowedTools: undefined as unknown as string[],
              blockedTools: ['mama_save'],
            },
          },
        },
        {},
        { mamaApi: createMockApi() }
      );

      const callOptions = adapterMock.mock.calls.at(-1)?.[0] as { systemPrompt?: string };
      expect(callOptions.systemPrompt).toContain('declare function mama_search');
      expect(callOptions.systemPrompt).not.toContain('declare function mama_save');
    });

    it('replaces a caller generic gateway catalog with the canonical run policy', async () => {
      const context = {
        ...createChatBotContext(),
        role: {
          ...createChatBotContext().role,
          allowedTools: ['code_act', 'mama_search', 'mama_save', 'Read'],
          blockedTools: ['mama_save'],
        },
        tier: 2 as const,
      };
      const policy = projectCodeActToolPolicy({
        tier: 2,
        role: context.role,
        disallowedTools: ['Read'],
      });
      persistentPromptMock
        .mockResolvedValueOnce({
          response: '```js\nmama_search({ query: "prompt parity" })\n```',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'test-session',
        })
        .mockResolvedValueOnce({
          response: 'Done',
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'test-session',
        });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'claude',
          systemPrompt: 'constructor prompt',
          useCodeAct: true,
          disallowedTools: ['Read'],
        },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
        systemPrompt: [
          '# Caller Persona',
          '',
          'Keep this instruction.',
          '',
          '---',
          '',
          '# Gateway Tools',
          '',
          'Call tools via JSON block:',
          '',
          '```tool_call',
          '{"name":"mama_save","input":{}}',
          '```',
          '',
          '- **mama_save**(...) — generic write advertisement',
          '- **Bash**(...) — generic shell advertisement',
        ].join('\n'),
      });

      const effectivePrompt = String(persistentPromptMock.mock.calls[0]?.[2]?.systemPrompt);
      const advertised = [...effectivePrompt.matchAll(/declare function ([A-Za-z0-9_]+)\(/g)]
        .map((match) => match[1])
        .sort();
      expect(effectivePrompt).toContain('Keep this instruction.');
      expect(effectivePrompt).not.toContain('# Gateway Tools');
      expect(effectivePrompt).not.toContain('Call tools via JSON block:');
      expect(effectivePrompt).not.toContain('generic shell advertisement');
      expect(effectivePrompt).toContain('## Code-Act: Gateway Tool Execution via Sandbox');
      expect(effectivePrompt).toContain(TypeDefinitionGenerator.generate(policy));
      expect(advertised).toEqual(policy.names);
      expect(gatewayExecutorExecuteMock).toHaveBeenCalledWith(
        'code_act',
        { code: 'mama_search({ query: "prompt parity" })' },
        expect.objectContaining({ executionSurface: 'model_tool' })
      );
    });

    it('replaces a stale trailing Codex Code-Act section with the current run projection', async () => {
      const context = {
        ...createChatBotContext(),
        backend: 'codex' as const,
        role: {
          ...createChatBotContext().role,
          allowedTools: ['code_act', 'mama_search'],
          blockedTools: [],
        },
        tier: 2 as const,
      };
      const policy = projectCodeActToolPolicy({ tier: 2, role: context.role });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'codex',
          systemPrompt: 'constructor prompt',
          useCodeAct: true,
        },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
        systemPrompt: [
          '# Caller Persona',
          '',
          'Keep this caller instruction.',
          '',
          '---',
          '',
          '## Code-Act: Gateway Tool Execution via Sandbox',
          '',
          'Stale caller guidance that must be replaced.',
          '',
          '```typescript',
          'declare function Bash(command: string): unknown;',
          'declare function Write(path: string, content: string): unknown;',
          'declare function mama_search(query?: string): unknown;',
          '```',
        ].join('\n'),
      });

      const effectivePrompt = String(persistentPromptMock.mock.calls[0]?.[2]?.systemPrompt);
      const advertised = [...effectivePrompt.matchAll(/declare function ([A-Za-z0-9_]+)\(/g)]
        .map((match) => match[1])
        .sort();
      expect(effectivePrompt).toContain('Keep this caller instruction.');
      expect(effectivePrompt).not.toContain('Stale caller guidance that must be replaced.');
      expect(effectivePrompt).not.toContain('declare function Bash');
      expect(effectivePrompt).not.toContain('declare function Write');
      expect(effectivePrompt).toContain(TypeDefinitionGenerator.generate(policy));
      expect(advertised).toEqual(policy.names);
    });

    it.each([
      {
        name: 'generic gateway catalog',
        staleSection: [
          '# Gateway Tools',
          '',
          'Call tools via JSON block:',
          '',
          '```tool_call',
          '{"name":"mama_save","input":{}}',
          '```',
          '',
          '- **mama_save**(...) — stale generic write advertisement',
        ].join('\n'),
      },
      {
        name: 'canonical Code-Act section',
        staleSection: [
          '## Code-Act: Gateway Tool Execution via Sandbox',
          '',
          'Stale canonical guidance.',
          '',
          '```typescript',
          'declare function Bash(command: string): unknown;',
          '```',
        ].join('\n'),
      },
    ])('preserves caller suffix bytes while replacing a legacy $name', async ({ staleSection }) => {
      const suffix = [
        '\n\n---\n\n',
        '## Custom Safety & Provenance',
        '',
        'KEEP  trailing spaces  ',
        'provenance-id: caller-owned\r\n',
      ].join('');
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Current policy used',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'constructor prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: withOuterCodeAct(createCodexContext()),
        systemPrompt: `# Caller Persona\n\n${staleSection}${suffix}`,
      });

      expect(effectivePrompt).not.toContain('Stale canonical guidance.');
      expect(effectivePrompt).not.toContain('stale generic write advertisement');
      expect(effectivePrompt).toContain(suffix);
      expect(effectivePrompt).toContain(
        `${suffix}\n\n---\n\n<!-- MAMA_GENERATED_CODE_ACT_START -->`
      );
    });

    it('wraps newly generated Code-Act instructions in explicit replacement boundaries', async () => {
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Done',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: withOuterCodeAct(createCodexContext()),
      });

      expect(effectivePrompt).toContain('<!-- MAMA_GENERATED_CODE_ACT_START -->');
      expect(effectivePrompt).toContain('<!-- MAMA_GENERATED_CODE_ACT_END -->');
    });

    it('combines normalized Code-Act policy with the caller session fingerprint', async () => {
      const fingerprints: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        persistentPromptMock.mockImplementationOnce(
          async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
            fingerprints.push(promptOptions?.sessionPolicyFingerprint ?? '');
            return {
              response: 'Done',
              usage: { input_tokens: 10, output_tokens: 5 },
              session_id: 'codex-thread',
            };
          }
        );
      }
      const run = async (
        allowedTools: string[],
        blockedTools: string[],
        tier: 1 | 2,
        callerFingerprint = 'caller-signature-v1'
      ) => {
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
          {},
          { mamaApi: createMockApi() }
        );
        await agentLoop.run('Search', {
          source: 'telegram',
          channelId: `policy-${fingerprints.length}`,
          sessionPolicyFingerprint: callerFingerprint,
          agentContext: {
            ...createCodexContext(),
            tier,
            role: {
              ...createCodexContext().role,
              allowedTools: ['code_act', ...allowedTools],
              blockedTools,
            },
          },
        });
      };

      await run(['mama_search', 'report_publish'], ['mama_save'], 2);
      await run(['report_publish', 'mama_search', 'mama_search'], ['mama_save'], 2);
      await run(['mama_search'], ['mama_save'], 2);
      await run(['mama_search', 'report_publish'], [], 2);
      await run(['mama_search', 'report_publish'], ['mama_save'], 1);
      await run(['mama_search', 'report_publish'], ['mama_save'], 2, 'caller-signature-v2');

      expect(fingerprints[0]).toBe(fingerprints[1]);
      expect(new Set(fingerprints).size).toBe(5);
      expect(fingerprints[0]).toContain('caller-signature-v1');
    });

    it.each([
      {
        label: 'explicit reset',
        resumeSession: false,
        freshSession: false,
        expected: [false, true],
      },
      {
        label: 'default resume',
        resumeSession: undefined,
        freshSession: false,
        expected: [true, true],
      },
      { label: 'fresh override', resumeSession: true, freshSession: true, expected: [false, true] },
    ])(
      'honors Codex first-turn resume policy: $label',
      async ({ resumeSession, freshSession, expected }) => {
        const seen: boolean[] = [];
        persistentPromptMock
          .mockImplementationOnce(
            async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
              seen.push(promptOptions?.resumeSession ?? true);
              return {
                response: '',
                usage: { input_tokens: 10, output_tokens: 5 },
                session_id: 'codex-thread',
                toolUseBlocks: [
                  {
                    id: 'code-act-call',
                    name: 'code_act',
                    input: { code: 'return 1;' },
                  },
                ],
              };
            }
          )
          .mockImplementationOnce(
            async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
              seen.push(promptOptions?.resumeSession ?? true);
              return {
                response: 'Done',
                usage: { input_tokens: 10, output_tokens: 5 },
                session_id: 'codex-thread',
              };
            }
          );
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          { backend: 'codex', systemPrompt: 'base prompt', useCodeAct: true },
          {},
          { mamaApi: createMockApi() }
        );

        await agentLoop.run('Search', {
          source: 'telegram',
          channelId: `resume-${resumeSession}-${freshSession}`,
          agentContext: withOuterCodeAct(createCodexContext()),
          resumeSession,
          freshSession,
        });

        expect(seen).toEqual(expected);
      }
    );

    it('regenerates constructor Code-Act declarations from the current run policy', async () => {
      let effectivePrompt = '';
      persistentPromptMock.mockImplementationOnce(
        async (_text: string, _callbacks: unknown, promptOptions?: PromptOptions) => {
          effectivePrompt = promptOptions?.systemPrompt ?? '';
          return {
            response: 'Current policy used',
            usage: { input_tokens: 10, output_tokens: 5 },
            session_id: 'codex-thread',
          };
        }
      );
      const context = {
        ...createChatBotContext(),
        backend: 'codex' as const,
        role: {
          ...createChatBotContext().role,
          allowedTools: ['code_act', 'mama_search'],
          blockedTools: [],
        },
        tier: 2 as const,
      };
      const policy = projectCodeActToolPolicy({ tier: 2, role: context.role });
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'codex',
          systemPrompt: [
            'Constructor caller content.',
            '',
            '---',
            '',
            '## Code-Act: Gateway Tool Execution via Sandbox',
            '',
            'Truncated stale guidance.',
            '',
            '```typescript',
            'declare function Bash(command: string): unknown;',
          ].join('\n'),
          useCodeAct: true,
        },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: context,
      });

      const advertised = [...effectivePrompt.matchAll(/declare function ([A-Za-z0-9_]+)\(/g)]
        .map((match) => match[1])
        .sort();
      expect(effectivePrompt).toContain('Constructor caller content.');
      expect(effectivePrompt).not.toContain('Truncated stale guidance.');
      expect(effectivePrompt).toContain(TypeDefinitionGenerator.generate(policy));
      expect(effectivePrompt).not.toContain('declare function Bash');
      expect(effectivePrompt).not.toContain('declare function Write');
      expect(advertised).toEqual(policy.names);
    });

    it.each([0, 4, Number.NaN, '2'])(
      'rejects invalid Code-Act run tier %s before runner or executor activity',
      async (tier) => {
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          {
            backend: 'claude',
            systemPrompt: 'constructor prompt',
            useCodeAct: true,
          },
          {},
          { mamaApi: createMockApi() }
        );

        await expect(
          agentLoop.run('Search', {
            source: 'telegram',
            channelId: '5551000001',
            agentContext: {
              ...createChatBotContext(),
              tier: tier as unknown as 1,
            },
            systemPrompt: 'caller prompt',
          })
        ).rejects.toThrow(/Invalid Code-Act tier/);

        expect(persistentPromptMock).not.toHaveBeenCalled();
        expect(gatewayExecutorExecuteMock).not.toHaveBeenCalled();
      }
    );

    it('preserves a caller generic gateway catalog when Code-Act is disabled', async () => {
      const genericCatalog = [
        '# Caller Persona',
        '',
        'Keep this instruction.',
        '',
        '---',
        '',
        '# Gateway Tools',
        '',
        'Call tools via JSON block:',
        '',
        '```tool_call',
        '{"name":"mama_search","input":{}}',
        '```',
        '',
        '- **mama_search**(...) — generic search advertisement',
      ].join('\n');
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        {
          backend: 'claude',
          systemPrompt: 'constructor prompt',
          useCodeAct: false,
        },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('Search', {
        source: 'telegram',
        channelId: '5551000001',
        agentContext: createChatBotContext(),
        systemPrompt: genericCatalog,
      });

      const effectivePrompt = String(persistentPromptMock.mock.calls[0]?.[2]?.systemPrompt);
      expect(effectivePrompt).toBe(genericCatalog);
      expect(effectivePrompt).toContain('# Gateway Tools');
      expect(effectivePrompt).toContain('Call tools via JSON block:');
      expect(effectivePrompt).not.toContain('declare function mama_search');
      expect(effectivePrompt).not.toContain('## Code-Act: Gateway Tool Execution via Sandbox');
    });

    it('passes explicit MCP config paths into single-agent Codex runtime sessions', () => {
      const options = {
        backend: 'codex',
        model: 'gpt-5.3-codex',
        systemPrompt: 'base prompt',
        mcpConfigPath: '/tmp/code-act-only.json',
      } as AgentLoopOptions & { mcpConfigPath: string };

      new AgentLoop(createMockOAuthManager(), options, {}, { mamaApi: createMockApi() });

      expect(codexRuntimeProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpConfigPath: '/tmp/code-act-only.json',
        })
      );
    });

    it('does not load the retired MCP transport for Codex Code-Act sessions', () => {
      const options = {
        backend: 'codex',
        model: 'gpt-5.3-codex',
        systemPrompt: 'base prompt',
        useCodeAct: true,
        mcpConfigPath: '/tmp/code-act-only.json',
      } as AgentLoopOptions & { mcpConfigPath: string };

      new AgentLoop(createMockOAuthManager(), options, {}, { mamaApi: createMockApi() });

      expect(codexRuntimeProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({ mcpConfigPath: undefined })
      );
    });

    it('routes Codex prompts with the stable source/channel key', async () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { backend: 'codex', model: 'gpt-5.4', systemPrompt: 'base prompt' },
        {},
        { mamaApi: createMockApi() }
      );

      await agentLoop.run('hello', { source: 'discord', channelId: 'channel-1' });

      expect(persistentPromptMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ sessionKey: 'default:default', resumeSession: true })
      );
    });

    it('restores the default system prompt when a message override is cleared', () => {
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { systemPrompt: 'default prompt' },
        {},
        { mamaApi: createMockApi() }
      );

      agentLoop.setSystemPrompt('override prompt');
      agentLoop.setSystemPrompt(undefined);

      expect(persistentSetSystemPromptMock).toHaveBeenNthCalledWith(1, 'override prompt');
      expect(persistentSetSystemPromptMock.mock.calls[1]?.[0]).toContain('default prompt');
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
