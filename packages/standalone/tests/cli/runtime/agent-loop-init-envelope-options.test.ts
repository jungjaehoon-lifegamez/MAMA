import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../../src/agent/index.js';
import type { AgentContext, AgentLoopOptions, ContentBlock } from '../../../src/agent/types.js';
import type { MAMAConfig } from '../../../src/cli/config/types.js';
import type { OAuthManager } from '../../../src/auth/index.js';
import type { MetricsStore } from '../../../src/observability/metrics-store.js';
import type { SQLiteDatabase } from '../../../src/sqlite.js';
import { makeSignedEnvelope } from '../../envelope/fixtures.js';
import { initMainAgentLoop } from '../../../src/cli/runtime/agent-loop-init.js';

function createConfig(): MAMAConfig {
  return {
    agent: {
      model: 'claude-sonnet-4-6',
      timeout: 1000,
      max_turns: 5,
      tools: {},
    },
    database: { path: ':memory:' },
    multi_agent: { agents: {} },
  } as unknown as MAMAConfig;
}

function createAgentContext(): AgentContext {
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName: 'chat_bot',
    role: { allowedTools: ['*'], systemControl: false, sensitiveAccess: false },
    session: {
      sessionId: 'telegram:session',
      channelId: 'tg:1',
      userId: 'user-1',
      startedAt: new Date(),
    },
    capabilities: ['*'],
    limitations: [],
    tier: 2,
  };
}

function createOptions(): AgentLoopOptions {
  return {
    userId: 'user-1',
    source: 'telegram',
    channelId: 'tg:1',
    systemPrompt: 'system',
    model: 'claude-sonnet-4-6',
    envelope: makeSignedEnvelope({ agent_id: 'chat_bot', source: 'telegram', channel_id: 'tg:1' }),
    agentContext: createAgentContext(),
    cliSessionId: 'cli-session-1',
    resumeSession: true,
  };
}

describe('Story M1R: initMainAgentLoop envelope options', () => {
  let previousHome: string | undefined;
  let tempHome: string;
  let runSpy: ReturnType<typeof vi.spyOn>;
  let runWithContentSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'mama-agent-loop-init-'));
    process.env.HOME = tempHome;
    runSpy = vi.spyOn(AgentLoop.prototype, 'run').mockResolvedValue({
      response: 'ok',
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
    });
    runWithContentSpy = vi.spyOn(AgentLoop.prototype, 'runWithContent').mockResolvedValue({
      response: 'ok',
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('AC: preserves envelope-bearing options', () => {
    it('preserves envelope-bearing options through run()', async () => {
      const { agentLoopClient } = initMainAgentLoop(
        createConfig(),
        { getToken: vi.fn() } as unknown as OAuthManager,
        {} as SQLiteDatabase,
        null as MetricsStore | null,
        'claude'
      );
      const options = createOptions();

      await agentLoopClient.run('hello', options);

      expect(runSpy).toHaveBeenCalledWith('hello', expect.objectContaining(options));
    });

    it('preserves envelope-bearing options through runWithContent()', async () => {
      const { agentLoopClient } = initMainAgentLoop(
        createConfig(),
        { getToken: vi.fn() } as unknown as OAuthManager,
        {} as SQLiteDatabase,
        null as MetricsStore | null,
        'claude'
      );
      const content: ContentBlock[] = [{ type: 'text', text: 'hello' }];
      const options = createOptions();

      await agentLoopClient.runWithContent?.(content, options);

      expect(runWithContentSpy).toHaveBeenCalledWith(content, expect.objectContaining(options));
    });
  });
});
