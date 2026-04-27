import { afterEach, describe, expect, it } from 'vitest';
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

  afterEach(() => {
    sessionStore?.close();
    sessionStore = undefined;
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
      allowedDestinations: [],
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
});
