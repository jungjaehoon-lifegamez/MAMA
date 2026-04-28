import { afterEach, describe, expect, it, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import {
  MessageRouter,
  type AgentLoopClient,
  type ReactiveEnvelopeConfig,
} from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import type { AgentLoopOptions } from '../../src/agent/types.js';
import { makeAuthorityHarness } from '../envelope/fixtures.js';
import { buildChannelKey, SessionPool, setSessionPool } from '../../src/agent/session-pool.js';

type CapturedRun = {
  prompt: string;
  options?: AgentLoopOptions;
};

function makeReactiveEnvelopeConfig(): ReactiveEnvelopeConfig {
  return {
    projectRefsFor: (message) => [{ kind: 'project', id: `/project/${message.source}` }],
    rawConnectorsFor: (message) => (message.source === 'system' ? [] : [message.source]),
    memoryScopesFor: (message) => [
      { kind: 'channel', id: `${message.source}:${message.channelId}` },
      { kind: 'user', id: message.userId },
    ],
    reactiveBudgetSeconds: 30,
  };
}

function makeMessage(source: NormalizedMessage['source']): NormalizedMessage {
  return {
    source,
    channelId: `${source}:channel:${Math.random().toString(36).slice(2)}`,
    userId: `${source}:user`,
    text: `hello from ${source}`,
  };
}

describe('reactive envelope issuance', () => {
  let sessionStore: SessionStore | undefined;
  let sessionPool: SessionPool | undefined;

  afterEach(() => {
    sessionStore?.close();
    sessionStore = undefined;
    sessionPool?.dispose();
    sessionPool = undefined;
    setSessionPool(new SessionPool());
  });

  it('fails at construction when envelope config and authority are not paired', () => {
    const db: SQLiteDatabase = new Database(':memory:');
    sessionStore = new SessionStore(db);
    const agentLoop: AgentLoopClient = {
      async run() {
        return { response: 'ok' };
      },
    };
    const { authority } = makeAuthorityHarness(db);

    expect(
      () =>
        new MessageRouter(
          sessionStore!,
          agentLoop,
          createMockMamaApi([]),
          {},
          makeReactiveEnvelopeConfig()
        )
    ).toThrow(/ReactiveEnvelopeConfig provided without EnvelopeAuthority/);

    expect(
      () =>
        new MessageRouter(sessionStore!, agentLoop, createMockMamaApi([]), {}, undefined, authority)
    ).toThrow(/EnvelopeAuthority provided without ReactiveEnvelopeConfig/);
  });

  it.each([
    {
      source: 'telegram' as const,
      envelopeSource: 'telegram',
      allowedDestinations: [{ kind: 'telegram', id: expect.stringMatching(/^telegram:channel:/) }],
    },
    {
      source: 'slack' as const,
      envelopeSource: 'slack',
      allowedDestinations: [{ kind: 'slack', id: expect.stringMatching(/^slack:channel:/) }],
    },
    {
      source: 'discord' as const,
      envelopeSource: 'discord',
      allowedDestinations: [{ kind: 'discord', id: expect.stringMatching(/^discord:channel:/) }],
    },
    {
      source: 'viewer' as const,
      envelopeSource: 'viewer',
      allowedDestinations: [{ kind: 'webchat', id: expect.stringMatching(/^viewer:channel:/) }],
    },
    {
      source: 'mobile' as const,
      envelopeSource: 'viewer',
      allowedDestinations: [{ kind: 'webchat', id: expect.stringMatching(/^mobile:channel:/) }],
      expectedPlatform: 'cli',
      expectedRoleName: 'chat_bot',
    },
    {
      source: 'system' as const,
      envelopeSource: 'watch',
      allowedDestinations: [],
      expectedPlatform: 'cli',
      expectedRoleName: 'chat_bot',
    },
  ])(
    'builds, persists, and passes a signed envelope for $source messages',
    async ({ source, envelopeSource, allowedDestinations, expectedPlatform, expectedRoleName }) => {
      const db: SQLiteDatabase = new Database(':memory:');
      sessionStore = new SessionStore(db);
      const { authority, store } = makeAuthorityHarness(db);
      const captured: CapturedRun[] = [];
      const agentLoop: AgentLoopClient = {
        async run(prompt: string, options?: AgentLoopOptions) {
          captured.push({ prompt, options });
          return { response: 'ok' };
        },
      };
      const router = new MessageRouter(
        sessionStore,
        agentLoop,
        createMockMamaApi([]),
        {},
        makeReactiveEnvelopeConfig(),
        authority
      );
      const message = makeMessage(source);

      await router.process(message);

      expect(captured).toHaveLength(1);
      const envelope = captured[0].options?.envelope;
      expect(envelope).toBeDefined();
      expect(envelope?.signature).toBeDefined();
      expect(envelope?.source).toBe(envelopeSource);
      expect(envelope?.channel_id).toBe(message.channelId);
      expect(envelope?.trigger_context).toEqual({ user_text: message.text });
      expect(envelope?.scope.allowed_destinations).toEqual(allowedDestinations);
      expect(store.getByHash(envelope!.envelope_hash)?.instance_id).toBe(envelope?.instance_id);

      if (expectedPlatform) {
        expect(captured[0].options?.agentContext?.platform).toBe(expectedPlatform);
      }
      if (expectedRoleName) {
        expect(captured[0].options?.agentContext?.roleName).toBe(expectedRoleName);
      }
    }
  );

  it('defers envelope persistence until a busy session can proceed', async () => {
    const db: SQLiteDatabase = new Database(':memory:');
    sessionStore = new SessionStore(db);
    sessionPool = new SessionPool();
    setSessionPool(sessionPool);
    const { authority } = makeAuthorityHarness(db);
    const buildAndPersist = vi.spyOn(authority, 'buildAndPersist');
    const agentLoop: AgentLoopClient = {
      async run() {
        return { response: 'ok' };
      },
    };
    const router = new MessageRouter(
      sessionStore,
      agentLoop,
      createMockMamaApi([]),
      {},
      makeReactiveEnvelopeConfig(),
      authority
    );
    const message: NormalizedMessage = {
      source: 'telegram',
      channelId: 'tg:busy',
      userId: 'u:busy',
      text: 'queued hello',
    };
    const channelKey = buildChannelKey(message.source, message.channelId);
    sessionPool.getSession(channelKey);
    let queued = false;

    await router.process(message, {
      onQueued() {
        queued = true;
        expect(buildAndPersist).not.toHaveBeenCalled();
        sessionPool!.releaseSession(channelKey);
      },
    });

    expect(queued).toBe(true);
    expect(buildAndPersist).toHaveBeenCalledTimes(1);
  });

  it('releases the session lock when reactive envelope construction fails', async () => {
    const db: SQLiteDatabase = new Database(':memory:');
    sessionStore = new SessionStore(db);
    sessionPool = new SessionPool();
    setSessionPool(sessionPool);
    const { authority } = makeAuthorityHarness(db);
    vi.spyOn(authority, 'buildAndPersist').mockImplementation(() => {
      throw new Error('synthetic envelope failure');
    });
    const agentLoop: AgentLoopClient = {
      async run() {
        return { response: 'ok' };
      },
    };
    const router = new MessageRouter(
      sessionStore,
      agentLoop,
      createMockMamaApi([]),
      {},
      makeReactiveEnvelopeConfig(),
      authority
    );
    const message: NormalizedMessage = {
      source: 'telegram',
      channelId: 'tg:envelope-fail',
      userId: 'u:envelope-fail',
      text: 'hello',
    };
    const channelKey = buildChannelKey(message.source, message.channelId);

    await expect(router.process(message)).rejects.toThrow('synthetic envelope failure');

    expect(sessionPool.peekSession(channelKey).busy).toBe(false);
  });
});
