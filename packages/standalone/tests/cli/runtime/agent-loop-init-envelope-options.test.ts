import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentLoopOptions, ContentBlock } from '../../../src/agent/types.js';
import type { MAMAConfig } from '../../../src/cli/config/types.js';
import type { OAuthManager } from '../../../src/auth/index.js';
import type { MetricsStore } from '../../../src/observability/metrics-store.js';
import type { SQLiteDatabase } from '../../../src/sqlite.js';
import { makeSignedEnvelope } from '../../envelope/fixtures.js';

const { runMock, runWithContentMock, setSessionKeyMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
  runWithContentMock: vi.fn(),
  setSessionKeyMock: vi.fn(),
}));

vi.mock('../../../src/agent/index.js', () => ({
  AgentLoop: vi.fn().mockImplementation(() => ({
    run: runMock,
    runWithContent: runWithContentMock,
    setSessionKey: setSessionKeyMock,
  })),
}));

vi.mock('../../../src/cli/runtime/utilities.js', () => ({
  syncBuiltinSkills: vi.fn(),
}));

vi.mock('../../../src/db/agent-store.js', () => ({
  getLatestVersion: vi.fn().mockReturnValue(null),
  upsertMetrics: vi.fn(),
}));

vi.mock('../../../src/api/index.js', () => ({
  insertTokenUsage: vi.fn(),
}));

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

describe('initMainAgentLoop AgentLoopClient envelope options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockResolvedValue({
      response: 'ok',
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
    });
    runWithContentMock.mockResolvedValue({
      response: 'ok',
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
    });
  });

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

    expect(runMock).toHaveBeenCalledWith('hello', expect.objectContaining(options));
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

    expect(runWithContentMock).toHaveBeenCalledWith(content, expect.objectContaining(options));
  });
});
