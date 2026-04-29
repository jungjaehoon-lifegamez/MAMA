import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import type { AgentContext, GatewayToolInput, MAMAApiInterface } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';
import { makeSignedEnvelope } from './fixtures.js';

function createMockOAuthManager(): OAuthManager {
  return { getToken: vi.fn().mockResolvedValue('token') } as unknown as OAuthManager;
}

function createMockApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'decision_1', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_1',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true, message: 'updated' }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true, id: 'ingested_1' }),
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_internal_context',
      status: 'running',
    }),
    commitModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_internal_context',
      status: 'committed',
    }),
    failModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_internal_context',
      status: 'failed',
    }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_internal_context',
      model_run_id: 'mr_internal_context',
      tool_name: 'mama_search',
    }),
  };
}

function createAgentContext(allowedPaths: string[]): AgentContext {
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['*'],
      systemControl: false,
      sensitiveAccess: false,
      allowedPaths,
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

function createExecutionOptions(tempDir: string) {
  const envelope = makeSignedEnvelope({
    agent_id: 'chat_bot',
    source: 'telegram',
    channel_id: 'tg:1',
  });
  return {
    source: 'telegram',
    channelId: 'tg:1',
    agentContext: createAgentContext([join(tempDir, '**')]),
    envelope,
    cliSessionId: 'cli-session-1',
    resumeSession: true,
  };
}

function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 120));
}

describe('Story M1R: AgentLoop internal tool context propagation', () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let executeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'mama-agent-loop-context-'));
    process.env.HOME = tempDir;
    promptSpy = vi.spyOn(PersistentCLIAdapter.prototype, 'prompt');
    executeSpy = vi.spyOn(GatewayToolExecutor.prototype, 'execute');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('AC: model and post-tool paths carry the correct surface', () => {
    it('passes active execution context through real GatewayToolExecutor and PostToolHandler', async () => {
      const writePath = join(tempDir, 'api.ts');
      promptSpy
        .mockResolvedValueOnce({
          response:
            '```tool_call\n' +
            JSON.stringify({
              name: 'Write',
              input: {
                path: writePath,
                content: 'export function test(id: string): string { return id; }',
              },
            }) +
            '\n```',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce({
          response: 'Done',
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      const options = createExecutionOptions(tempDir);
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { postToolUse: { enabled: true } },
        {},
        { mamaApi: createMockApi(), envelopeIssuanceMode: 'enabled' }
      );

      await agentLoop.run('write a file', options);
      await flushBackgroundWork();

      const calls = executeSpy.mock.calls as Array<
        [string, GatewayToolInput, { executionSurface?: string; envelope?: unknown } | undefined]
      >;
      const writeCall = calls.find((call) => call[0] === 'Write');
      expect(writeCall?.[2]).toEqual(
        expect.objectContaining({
          agentContext: options.agentContext,
          source: 'telegram',
          channelId: 'tg:1',
          envelope: options.envelope,
          executionSurface: 'model_tool',
        })
      );

      const reactiveCalls = calls.filter((call) => call[0] === 'mama_search');
      expect(reactiveCalls.length).toBeGreaterThan(0);
      expect(reactiveCalls[0][2]).toEqual(
        expect.objectContaining({
          agentContext: options.agentContext,
          source: 'telegram',
          channelId: 'tg:1',
          envelope: options.envelope,
          executionSurface: 'reactive_internal',
        })
      );
    });
  });

  describe('AC: pre-compact path carries the reactive internal surface', () => {
    it('passes active execution context to PreCompactHandler when compaction check runs', async () => {
      promptSpy.mockResolvedValueOnce({
        response: 'Done',
        usage: { input_tokens: 200_000, output_tokens: 5 },
      });
      const options = createExecutionOptions(tempDir);
      delete options.cliSessionId;
      delete options.resumeSession;
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { preCompact: { enabled: true } },
        {},
        { mamaApi: createMockApi(), envelopeIssuanceMode: 'enabled' }
      );

      await agentLoop.run('decided: use JWT tokens', options);

      const searchCall = executeSpy.mock.calls.find((call) => call[0] === 'mama_search');
      expect(searchCall?.[2]).toEqual(
        expect.objectContaining({
          agentContext: options.agentContext,
          source: 'telegram',
          channelId: 'tg:1',
          envelope: options.envelope,
          executionSurface: 'reactive_internal',
        })
      );
    });
  });

  describe('AC: Code-Act host bridge carries the code_act surface', () => {
    it('passes active execution context through Code-Act HostBridge tool calls', async () => {
      promptSpy
        .mockResolvedValueOnce({
          response: '```js\nmama_search({ query: "contracts" })\n```',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce({
          response: 'Done',
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      const options = createExecutionOptions(tempDir);
      const agentLoop = new AgentLoop(
        createMockOAuthManager(),
        { useCodeAct: true },
        {},
        { mamaApi: createMockApi(), envelopeIssuanceMode: 'enabled' }
      );

      await agentLoop.run('use code act', options);

      const codeActCall = executeSpy.mock.calls.find((call) => call[0] === 'mama_search');
      expect(codeActCall?.[2]).toEqual(
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
});
