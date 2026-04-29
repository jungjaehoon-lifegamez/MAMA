import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop } from '../../src/agent/agent-loop.js';
import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import type { AgentContext, MAMAApiInterface } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';

type TraceAwareApi = MAMAApiInterface & {
  saveWithTrustedProvenance: ReturnType<typeof vi.fn>;
  beginModelRun: ReturnType<typeof vi.fn>;
  commitModelRun: ReturnType<typeof vi.fn>;
  failModelRun: ReturnType<typeof vi.fn>;
  appendToolTrace: ReturnType<typeof vi.fn>;
};

function createMockOAuthManager(): OAuthManager {
  return { getToken: vi.fn().mockResolvedValue('token') } as unknown as OAuthManager;
}

function createAgentContext(): AgentContext {
  return {
    source: 'discord',
    platform: 'discord',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['*'],
      systemControl: false,
      sensitiveAccess: false,
    },
    session: {
      sessionId: 'discord:session',
      channelId: 'channel-1',
      userId: 'user-1',
      startedAt: new Date(),
    },
    capabilities: ['*'],
    limitations: [],
    tier: 2,
    backend: 'claude',
  };
}

function createApi(): TraceAwareApi {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'public_save', type: 'decision' }),
    saveWithTrustedProvenance: vi
      .fn()
      .mockResolvedValue({ success: true, id: 'trusted_save', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'checkpoint_1' }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_agent_loop',
      status: 'running',
    }),
    commitModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_agent_loop',
      status: 'committed',
    }),
    failModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_agent_loop',
      status: 'failed',
    }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_agent_loop',
      model_run_id: 'mr_agent_loop',
      tool_name: 'mama_save',
    }),
  };
}

describe('Story M2.2: AgentLoop Model Run Context', () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let promptSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'mama-agent-loop-model-run-'));
    process.env.HOME = tempDir;
    promptSpy = vi.spyOn(PersistentCLIAdapter.prototype, 'prompt');
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

  describe('Acceptance Criteria', () => {
    describe('AC #1: tool-capable run owns a model run', () => {
      it('begins a model run and forwards its id into gateway memory writes', async () => {
        promptSpy
          .mockResolvedValueOnce({
            response:
              '```tool_call\n' +
              JSON.stringify({
                name: 'mama_save',
                input: {
                  type: 'decision',
                  topic: 'agent_loop_model_run',
                  decision: 'AgentLoop owns model run ids',
                  reasoning: 'Gateway memory writes need model-run provenance',
                },
              }) +
              '\n```',
            usage: { input_tokens: 10, output_tokens: 5 },
          })
          .mockResolvedValueOnce({
            response: 'Done',
            usage: { input_tokens: 3, output_tokens: 2 },
          });

        const api = createApi();
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          {},
          {},
          { mamaApi: api, envelopeIssuanceMode: 'off' }
        );

        await agentLoop.run('save this decision', {
          source: 'discord',
          channelId: 'channel-1',
          agentContext: createAgentContext(),
          cliSessionId: 'cli-session-1',
          resumeSession: true,
          sourceTurnId: 'turn-1',
          sourceMessageRef: 'discord:channel-1:turn-1',
        });

        expect(api.beginModelRun).toHaveBeenCalledOnce();
        expect(api.beginModelRun.mock.calls[0][0]).toMatchObject({
          agent_id: 'chat_bot',
          model_provider: 'claude',
          input_refs: {
            source: 'discord',
            channelId: 'channel-1',
            entrypoint: 'agent_loop',
            sourceTurnId: 'turn-1',
            sourceMessageRef: 'discord:channel-1:turn-1',
            cliSessionId: 'cli-session-1',
          },
        });
        expect(api.saveWithTrustedProvenance).toHaveBeenCalledOnce();
        const [, options] = api.saveWithTrustedProvenance.mock.calls[0];
        expect(options.provenance.model_run_id).toBe('mr_agent_loop');
        expect(api.appendToolTrace).toHaveBeenCalledWith(
          expect.objectContaining({
            model_run_id: 'mr_agent_loop',
            tool_name: 'mama_save',
            execution_status: 'completed',
          })
        );
        expect(api.commitModelRun).toHaveBeenCalledWith('mr_agent_loop', 'agent_loop completed');
        expect(api.failModelRun).not.toHaveBeenCalled();
      });

      it('waits for audited autosaves before committing the parent model run', async () => {
        promptSpy
          .mockResolvedValueOnce({
            response:
              '```tool_call\n' +
              JSON.stringify({
                name: 'report_publish',
                input: {
                  slots: {
                    summary: '<p>Dashboard says SQLite remains the default database.</p>',
                  },
                },
              }) +
              '\n```',
            usage: { input_tokens: 10, output_tokens: 5 },
          })
          .mockResolvedValueOnce({
            response: 'Done',
            usage: { input_tokens: 3, output_tokens: 2 },
          });

        let saveResolved = false;
        const api = createApi();
        api.saveWithTrustedProvenance.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          saveResolved = true;
          return { success: true, id: 'autosave_1', type: 'decision' };
        });
        api.commitModelRun.mockImplementation(async () => {
          expect(saveResolved).toBe(true);
          return { model_run_id: 'mr_agent_loop', status: 'committed' };
        });
        const agentLoop = new AgentLoop(
          createMockOAuthManager(),
          {},
          {},
          { mamaApi: api, envelopeIssuanceMode: 'off' }
        );
        agentLoop.setReportPublisher(vi.fn());

        await agentLoop.run('publish report', {
          source: 'discord',
          channelId: 'channel-1',
          agentContext: createAgentContext(),
          cliSessionId: 'cli-session-1',
          resumeSession: true,
        });

        expect(api.saveWithTrustedProvenance).toHaveBeenCalled();
        expect(api.commitModelRun).toHaveBeenCalledWith('mr_agent_loop', 'agent_loop completed');
      });
    });
  });
});
