import { afterEach, describe, expect, it, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import {
  MessageRouter,
  type AgentLoopClient,
  type ReactiveEnvelopeConfig,
} from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentLoopOptions, GatewayToolInput } from '../../src/agent/types.js';
import { makeAuthorityHarness } from '../envelope/fixtures.js';

function makeReactiveEnvelopeConfig(): ReactiveEnvelopeConfig {
  return {
    projectRefsFor: () => [{ kind: 'project', id: '/project/reactive' }],
    rawConnectorsFor: () => ['telegram'],
    memoryScopesFor: () => [{ kind: 'channel', id: 'telegram:tg:1' }],
    reactiveBudgetSeconds: 30,
  };
}

function makeRouterHarness(agentLoop: AgentLoopClient): {
  router: MessageRouter;
  sessionStore: SessionStore;
} {
  const db: SQLiteDatabase = new Database(':memory:');
  const sessionStore = new SessionStore(db);
  const { authority } = makeAuthorityHarness(db);
  const router = new MessageRouter(
    sessionStore,
    agentLoop,
    createMockMamaApi([]),
    {},
    makeReactiveEnvelopeConfig(),
    authority
  );
  return { router, sessionStore };
}

describe('Reactive Main envelope tool path', () => {
  let sessionStore: SessionStore | undefined;

  afterEach(() => {
    sessionStore?.close();
    sessionStore = undefined;
  });

  it('passes signed envelope from MessageRouter into AgentLoopOptions for text and content runs', async () => {
    const seen: { run?: AgentLoopOptions; runWithContent?: AgentLoopOptions } = {};
    const fakeAgentLoop: AgentLoopClient = {
      async run(_prompt: string, options?: AgentLoopOptions) {
        seen.run = options;
        return { response: 'ok' };
      },
      async runWithContent(_content, options?: AgentLoopOptions) {
        seen.runWithContent = options;
        return { response: 'ok' };
      },
    };
    const harness = makeRouterHarness(fakeAgentLoop);
    sessionStore = harness.sessionStore;

    await harness.router.process({
      source: 'telegram',
      channelId: 'tg:1',
      userId: 'u:1',
      text: 'hello',
    });
    await harness.router.process({
      source: 'telegram',
      channelId: 'tg:2',
      userId: 'u:2',
      text: 'hello with content',
      contentBlocks: [{ type: 'text', text: 'hello with content' }],
    });

    expect(seen.run?.envelope).toBeDefined();
    expect(seen.run?.envelope?.signature).toBeDefined();
    expect(seen.run?.envelope?.scope.allowed_destinations).toEqual([
      { kind: 'telegram', id: 'tg:1' },
    ]);
    expect(seen.runWithContent?.envelope).toBeDefined();
    expect(seen.runWithContent?.envelope?.signature).toBeDefined();
    expect(seen.runWithContent?.envelope?.scope.allowed_destinations).toEqual([
      { kind: 'telegram', id: 'tg:2' },
    ]);
  });

  it('out-of-scope send becomes agent-visible tool failure when AgentLoop context carries envelope', async () => {
    let capturedOptions: AgentLoopOptions | undefined;
    const fakeAgentLoop: AgentLoopClient = {
      async run(_prompt: string, options?: AgentLoopOptions) {
        capturedOptions = options;
        return { response: 'ok' };
      },
    };
    const harness = makeRouterHarness(fakeAgentLoop);
    sessionStore = harness.sessionStore;
    await harness.router.process({
      source: 'telegram',
      channelId: 'tg:1',
      userId: 'u:1',
      text: 'hello',
    });

    const executionContext = buildAgentToolExecutionContext(capturedOptions);
    const executor = new GatewayToolExecutor({ mamaApi: createMockMamaApi([]) });
    executor.setTelegramGateway({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendSticker: vi.fn().mockResolvedValue(true),
    });

    const result = await executor.execute(
      'telegram_send',
      { chat_id: 'tg:OTHER', message: 'leak' } as GatewayToolInput,
      executionContext ?? undefined
    );

    expect(result).toMatchObject({
      success: false,
      code: 'destination_out_of_scope',
      envelope_hash: capturedOptions?.envelope?.envelope_hash,
    });
    expect(result.error).toContain('destination_out_of_scope');
  });
});
