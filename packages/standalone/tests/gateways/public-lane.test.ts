import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const telegramSeams = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void> | void>(),
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue({ file_path: 'synthetic.jpg', file_size: 4 }),
    getStickerSet: vi.fn().mockResolvedValue({ stickers: [] }),
  },
}));

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      telegramSeams.handlers.set(event, handler);
    }),
    catch: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    botInfo: { id: 123, username: 'test_bot' },
    api: telegramSeams.api,
  })),
}));

vi.mock('../../src/memory/memory-logger.js', () => ({
  getMemoryLogger: vi.fn(() => ({ logMessage: vi.fn() })),
}));

vi.mock('../../src/gateways/telegram-media.js', () => ({
  downloadTelegramMedia: vi.fn(),
  pruneTelegramMediaRoot: vi.fn().mockResolvedValue(undefined),
}));

import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import type { AgentContext, AgentLoopOptions } from '../../src/agent/types.js';
import { getRoleManager, resetRoleManager, RoleManager } from '../../src/agent/role-manager.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { createMockMamaApi, type MamaApiClient } from '../../src/gateways/context-injector.js';
import { MessageRouter, PUBLIC_LANE_SYSTEM_PROMPT } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'mama-public-lane-'));
const testMamaHome = join(testHome, '.mama');

beforeAll(() => {
  mkdirSync(join(testMamaHome, 'briefs'), { recursive: true });
  writeFileSync(join(testMamaHome, 'SOUL.md'), '# Synthetic private persona\n', { mode: 0o600 });
  process.env.HOME = testHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(testHome, { recursive: true, force: true });
});

function publicMessage(channelId: string, text: string): NormalizedMessage {
  return {
    source: 'telegram',
    channelId,
    userId: 'public-user',
    text,
    principal: {
      class: 'external',
      lane: 'public',
      canonicalId: 'telegram:global:public-user',
      consoleEligible: false,
    },
    metadata: {
      chatType: 'supergroup',
      historyContext: 'PRIVATE CHANNEL HISTORY MUST NOT APPEAR',
      messageId: `message-${text}`,
    },
  };
}

function ownerMessage(channelId: string, text: string): NormalizedMessage {
  return {
    source: 'telegram',
    channelId,
    userId: 'owner-user',
    text,
    principal: {
      class: 'owner',
      lane: 'owner',
      canonicalId: 'telegram:global:owner-user',
      consoleEligible: true,
    },
    metadata: { chatType: 'private', messageId: `owner-${text}` },
  };
}

function poisonMamaApi(): MamaApiClient & {
  search: ReturnType<typeof vi.fn>;
  recallMemory: ReturnType<typeof vi.fn>;
  loadCheckpoint: ReturnType<typeof vi.fn>;
  listDecisions: ReturnType<typeof vi.fn>;
} {
  const base = createMockMamaApi([]);
  return {
    ...base,
    search: vi.fn().mockResolvedValue([
      {
        id: 'private-decision',
        topic: 'private-memory',
        decision: 'PRIVATE DECISION MUST NOT APPEAR',
        similarity: 1,
      },
    ]),
    recallMemory: vi.fn().mockResolvedValue({
      profile: {
        static: [{ summary: 'PRIVATE PROFILE MUST NOT APPEAR' }],
        dynamic: [],
        evidence: [],
      },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'private', scope_order: [], retrieval_sources: [] },
    }),
    loadCheckpoint: vi.fn().mockResolvedValue({
      id: 1,
      timestamp: Date.now(),
      summary: 'PRIVATE CHECKPOINT MUST NOT APPEAR',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
  };
}

type CapturedCall = {
  prompt: string;
  options: AgentLoopOptions;
};

function captureLoop(calls: CapturedCall[]) {
  return {
    run: vi.fn(async (prompt: string, options?: AgentLoopOptions) => {
      if (!options) throw new Error('missing agent options');
      calls.push({ prompt, options });
      return { response: `response-${calls.length}`, modelRunId: `run-${calls.length}` };
    }),
  };
}

describe('Task 7: safe public lane', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    resetRoleManager();
    getRoleManager({ rolesConfig: DEFAULT_ROLES });
    telegramSeams.handlers.clear();
    vi.clearAllMocks();
    telegramSeams.api.sendMessage.mockResolvedValue({ message_id: 1 });
    sessionStore = new SessionStore(new Database(':memory:'));
  });

  afterEach(() => {
    sessionStore.close();
    resetRoleManager();
  });

  it('uses one fixed prompt with zero injections on fresh and resumed public turns', async () => {
    const calls: CapturedCall[] = [];
    const mamaApi = poisonMamaApi();
    const router = new MessageRouter(sessionStore, captureLoop(calls), mamaApi, {
      backend: 'codex',
      implicitMemoryRecall: true,
      implicitLegacyContextSearch: true,
    });
    const enhance = vi.fn().mockResolvedValue({
      agentsContent: 'PRIVATE AGENTS MUST NOT APPEAR',
      rulesContent: 'PRIVATE RULES MUST NOT APPEAR',
      keywordInstructions: 'PRIVATE KEYWORD MUST NOT APPEAR',
      skillContent: 'PRIVATE SKILL MUST NOT APPEAR',
    });
    const triggerMemoryAgent = vi.fn().mockResolvedValue(undefined);
    (router as unknown as { promptEnhancer: { enhance: typeof enhance } }).promptEnhancer = {
      enhance,
    };
    (
      router as unknown as {
        triggerMemoryAgent: typeof triggerMemoryAgent;
      }
    ).triggerMemoryAgent = triggerMemoryAgent;

    const channelId = `public-minimal-${Date.now()}`;
    await router.process(publicMessage(channelId, 'first public turn'));
    await router.process(publicMessage(channelId, 'second public turn'));

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options.systemPrompt)).toEqual([
      PUBLIC_LANE_SYSTEM_PROMPT,
      PUBLIC_LANE_SYSTEM_PROMPT,
    ]);
    expect(calls.map((call) => call.prompt)).toEqual(['first public turn', 'second public turn']);
    expect(calls[0]?.options.agentContext).toMatchObject({
      roleName: 'public_lane',
      role: {
        allowedTools: [],
        blockedTools: expect.arrayContaining(['*']),
        maxTurns: 4,
        systemControl: false,
        sensitiveAccess: false,
      },
    });
    expect(calls[1]?.options.resumeSession).toBe(true);
    expect(enhance).not.toHaveBeenCalled();
    expect(mamaApi.search).not.toHaveBeenCalled();
    expect(mamaApi.recallMemory).not.toHaveBeenCalled();
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
    expect(mamaApi.listDecisions).not.toHaveBeenCalled();
    expect(triggerMemoryAgent).not.toHaveBeenCalled();
    for (const call of calls) {
      expect(`${call.options.systemPrompt}\n${call.prompt}`).not.toMatch(
        /Recent Channel Messages|MAMA Memory|PRIVATE |operator-report|system-reminder/i
      );
    }
  });

  it('rebuilds a replacement public session from only the fixed policy and public history', async () => {
    const calls: CapturedCall[] = [];
    const mamaApi = poisonMamaApi();
    const router = new MessageRouter(sessionStore, captureLoop(calls), mamaApi, {
      backend: 'codex',
      implicitMemoryRecall: true,
      implicitLegacyContextSearch: true,
    });
    const channelId = `public-rebuild-${Date.now()}`;
    const ownerSession = sessionStore.getOrCreate('telegram', channelId, 'owner-user');
    sessionStore.updateSession(ownerSession.id, 'PRIVATE OWNER TURN', 'PRIVATE OWNER RESPONSE');

    await router.process(publicMessage(channelId, 'public history turn'));
    await router.process(publicMessage(channelId, 'request replacement'));

    const rebuilt = await calls[1]?.options.freshSessionSystemPrompt?.();
    expect(rebuilt).toContain(PUBLIC_LANE_SYSTEM_PROMPT);
    expect(rebuilt).toContain('public history turn');
    expect(rebuilt).toContain('response-1');
    expect(rebuilt).not.toMatch(
      /Recent Channel Messages|MAMA Memory|PRIVATE |operator-report|system-reminder/i
    );
    expect(mamaApi.search).not.toHaveBeenCalled();
    expect(mamaApi.recallMemory).not.toHaveBeenCalled();
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('gives the public role no direct, parsed, native, or nested Code-Act tool path', async () => {
    const role = DEFAULT_ROLES.definitions.public_lane;
    const roleManager = new RoleManager();
    const context: AgentContext = {
      source: 'telegram',
      platform: 'telegram',
      roleName: 'public_lane',
      role,
      session: {
        sessionId: 'public-session',
        channelId: 'public-channel',
        userId: 'public-user',
        startedAt: new Date(),
      },
      capabilities: [],
      limitations: [],
      tier: 3,
      backend: 'claude',
    };
    const executor = new GatewayToolExecutor({ envelopeIssuanceMode: 'off' });
    executor.setAgentContext(context);

    for (const [toolName, input] of [
      ['mama_search', { query: 'parsed tool_call' }],
      ['code_act', { code: 'mama_search({ query: "nested" })' }],
    ] as const) {
      await expect(executor.execute(toolName, input)).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Permission denied'),
      });
    }
    await expect(
      executor.execute('mcp__code-act__code_act', {
        code: 'mama_search({ query: "native" })',
      })
    ).rejects.toThrow('Unknown tool');

    const sandbox = new CodeActSandbox();
    new HostBridge(executor, roleManager).injectInto(sandbox, 1, role);
    expect(sandbox.getRegisteredFunctions()).toEqual([]);
    expect(roleManager.isToolAllowed(role, 'anything')).toBe(false);
  });

  it('keeps the Telegram owner prompt, memory hook, and full tool role unchanged', async () => {
    const calls: CapturedCall[] = [];
    const mamaApi = poisonMamaApi();
    const router = new MessageRouter(sessionStore, captureLoop(calls), mamaApi, {
      backend: 'codex',
      implicitMemoryRecall: true,
      implicitLegacyContextSearch: true,
    });
    const enhance = vi.fn().mockResolvedValue({
      agentsContent: 'OWNER AGENTS INJECTION',
      rulesContent: 'OWNER RULES INJECTION',
      keywordInstructions: 'OWNER KEYWORD INJECTION',
      skillContent: 'OWNER SKILL INJECTION',
    });
    const triggerMemoryAgent = vi.fn().mockResolvedValue(undefined);
    (router as unknown as { promptEnhancer: { enhance: typeof enhance } }).promptEnhancer = {
      enhance,
    };
    (
      router as unknown as {
        triggerMemoryAgent: typeof triggerMemoryAgent;
      }
    ).triggerMemoryAgent = triggerMemoryAgent;

    await router.process(ownerMessage(`owner-regression-${Date.now()}`, 'owner status'));

    expect(calls[0]?.options.agentContext).toMatchObject({
      roleName: 'owner_console',
      role: { allowedTools: DEFAULT_ROLES.definitions.owner_console.allowedTools },
    });
    expect(calls[0]?.options.systemPrompt).toContain('OWNER AGENTS INJECTION');
    expect(calls[0]?.options.systemPrompt).toContain('OWNER RULES INJECTION');
    expect(calls[0]?.options.systemPrompt).toContain('OWNER KEYWORD INJECTION');
    expect(calls[0]?.prompt).toContain('OWNER SKILL INJECTION');
    expect(calls[0]?.prompt).toContain('PRIVATE PROFILE MUST NOT APPEAR');
    expect(enhance).toHaveBeenCalledOnce();
    expect(mamaApi.recallMemory).toHaveBeenCalledOnce();
    expect(triggerMemoryAgent).toHaveBeenCalledOnce();
  });

  it('routes a mentioned Telegram group non-owner through the gateway to public_lane', async () => {
    const calls: CapturedCall[] = [];
    const router = new MessageRouter(sessionStore, captureLoop(calls), createMockMamaApi([]), {
      backend: 'codex',
    });
    const mediaRoot = await mkdtemp(join(tmpdir(), 'mama-public-gateway-'));
    const gateway = new TelegramGateway({
      token: 'synthetic-token',
      turnProcessor: router,
      config: { allowedChats: ['-7010'], ownerUserIds: ['9001'] },
      mediaRoot,
      messageLedgerPath: join(mediaRoot, 'ledger.json'),
      fetchImpl: vi.fn(),
    });
    await gateway.start();

    try {
      const handler = telegramSeams.handlers.get('message');
      expect(handler).toBeTypeOf('function');
      await handler!({
        message: {
          message_id: 7,
          date: 1_700_000_000,
          chat: { id: -7010, type: 'supergroup', title: 'Synthetic' },
          from: {
            id: 7010,
            is_bot: false,
            first_name: 'Synthetic',
            username: 'synthetic-public',
          },
          text: '@test_bot status',
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.agentContext).toMatchObject({
        roleName: 'public_lane',
        role: { allowedTools: [], blockedTools: expect.arrayContaining(['*']) },
      });
      expect(calls[0]?.options.systemPrompt).toBe(PUBLIC_LANE_SYSTEM_PROMPT);
    } finally {
      await gateway.stop();
      rmSync(mediaRoot, { recursive: true, force: true });
    }
  });
});
