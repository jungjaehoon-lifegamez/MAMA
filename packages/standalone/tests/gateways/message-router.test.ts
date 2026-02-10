/**
 * Unit tests for MessageRouter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MessageRouter, createMockAgentLoop } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi, type SearchResult } from '../../src/gateways/context-injector.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

describe('MessageRouter', () => {
  let db: Database.Database;
  let sessionStore: SessionStore;
  let router: MessageRouter;

  const mockDecisions: SearchResult[] = [
    {
      id: 'dec-1',
      topic: 'test_topic',
      decision: 'Test decision',
      reasoning: 'Test reasoning',
      outcome: 'success',
      similarity: 0.85,
    },
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    sessionStore = new SessionStore(db);
    const agentLoop = createMockAgentLoop(() => 'Agent response');
    const mamaApi = createMockMamaApi(mockDecisions);
    router = new MessageRouter(sessionStore, agentLoop, mamaApi);
  });

  afterEach(() => {
    sessionStore.close();
  });

  describe('process()', () => {
    it('should process message and return response', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      };

      const result = await router.process(message);

      expect(result.response).toBe('Agent response');
      expect(result.sessionId).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should create session for new channel', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'new-channel',
        userId: 'user-123',
        text: 'Hi',
      };

      await router.process(message);

      const session = router.getSession('discord', 'new-channel');
      expect(session).not.toBeNull();
    });

    it('should reuse session for same channel', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      };

      const result1 = await router.process(message);
      const result2 = await router.process({ ...message, text: 'Hi again' });

      expect(result1.sessionId).toBe(result2.sessionId);
    });

    it('should return injectedDecisions array', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Tell me about tests',
      };

      const result = await router.process(message);

      // Context injection is currently disabled (TODO in message-router.ts)
      // So injectedDecisions will be empty until embedding server is enabled
      expect(result.injectedDecisions).toBeDefined();
      expect(Array.isArray(result.injectedDecisions)).toBe(true);
    });

    it('should update session history', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      };

      const result = await router.process(message);
      const history = sessionStore.getHistory(result.sessionId);

      expect(history).toHaveLength(1);
      expect(history[0].user).toBe('Hello');
      expect(history[0].bot).toBe('Agent response');
    });

    it('should pass system prompt to agent loop for new sessions', async () => {
      // Use unique channel ID to ensure new session (not resuming from session pool)
      const uniqueChannelId = `channel-systemprompt-${Date.now()}`;
      let receivedOptions: { systemPrompt?: string; resumeSession?: boolean } = {};
      const agentLoop = {
        async run(
          _prompt: string,
          options?: { systemPrompt?: string; resumeSession?: boolean }
        ): Promise<{ response: string }> {
          receivedOptions = options || {};
          return { response: 'Response' };
        },
      };

      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      await customRouter.process({
        source: 'discord',
        channelId: uniqueChannelId,
        userId: 'user-456',
        text: 'Hello',
      });

      // For new sessions: systemPrompt should be defined, resumeSession should be false
      // For resumed sessions: systemPrompt is undefined, resumeSession is true
      // With unique channel ID, this should always be a new session
      expect(receivedOptions.systemPrompt).toBeDefined();
      expect(receivedOptions.resumeSession).toBe(false);
      expect(typeof receivedOptions.systemPrompt).toBe('string');
      expect(receivedOptions.systemPrompt!.length).toBeGreaterThan(0);
    });

    it('should use resumeSession for subsequent messages to same channel', async () => {
      // Use unique channel ID for this test
      const uniqueChannelId = `channel-resume-${Date.now()}`;
      const receivedOptionsHistory: Array<{ systemPrompt?: string; resumeSession?: boolean }> = [];
      const agentLoop = {
        async run(
          _prompt: string,
          options?: { systemPrompt?: string; resumeSession?: boolean }
        ): Promise<{ response: string }> {
          receivedOptionsHistory.push({ ...options });
          return { response: 'Response' };
        },
      };

      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      // First message - should inject system prompt
      await customRouter.process({
        source: 'discord',
        channelId: uniqueChannelId,
        userId: 'user-456',
        text: 'Hello',
      });

      // Second message - should resume (with system prompt for safety)
      await customRouter.process({
        source: 'discord',
        channelId: uniqueChannelId,
        userId: 'user-456',
        text: 'Follow up',
      });

      // First message: new session with system prompt
      expect(receivedOptionsHistory[0].systemPrompt).toBeDefined();
      expect(receivedOptionsHistory[0].resumeSession).toBe(false);

      // Second message: resume session, but still includes system prompt
      // (ensures Gateway Tools and AgentContext are available even if CLI session was lost)
      expect(receivedOptionsHistory[1].systemPrompt).toBeDefined();
      expect(receivedOptionsHistory[1].resumeSession).toBe(true);
    });
  });

  describe('getSession()', () => {
    it('should return null for non-existent session', () => {
      const session = router.getSession('discord', 'nonexistent');
      expect(session).toBeNull();
    });

    it('should return session after processing', async () => {
      await router.process({
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      });

      const session = router.getSession('discord', 'channel-123');
      expect(session).not.toBeNull();
      expect(session!.channelId).toBe('channel-123');
    });
  });

  describe('clearSession()', () => {
    it('should clear session context', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      };

      const result = await router.process(message);
      expect(sessionStore.getHistory(result.sessionId)).toHaveLength(1);

      router.clearSession(result.sessionId);
      expect(sessionStore.getHistory(result.sessionId)).toHaveLength(0);
    });
  });

  describe('deleteSession()', () => {
    it('should delete session', async () => {
      const message: NormalizedMessage = {
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
      };

      const result = await router.process(message);
      router.deleteSession(result.sessionId);

      const session = router.getSession('discord', 'channel-123');
      expect(session).toBeNull();
    });
  });

  describe('configuration', () => {
    it('should use default config', () => {
      const config = router.getConfig();

      expect(config.similarityThreshold).toBe(0.7);
      expect(config.maxDecisions).toBe(3);
      expect(config.maxTurns).toBe(5);
      expect(config.maxResponseLength).toBe(200);
    });

    it('should accept custom config', () => {
      const customRouter = new MessageRouter(
        sessionStore,
        createMockAgentLoop(),
        createMockMamaApi(),
        {
          similarityThreshold: 0.8,
          maxDecisions: 5,
          maxTurns: 10,
          maxResponseLength: 500,
        }
      );

      const config = customRouter.getConfig();
      expect(config.similarityThreshold).toBe(0.8);
      expect(config.maxDecisions).toBe(5);
      expect(config.maxTurns).toBe(10);
      expect(config.maxResponseLength).toBe(500);
    });

    it('should update config', () => {
      router.setConfig({ similarityThreshold: 0.9 });

      expect(router.getConfig().similarityThreshold).toBe(0.9);
    });
  });

  describe('createMockAgentLoop()', () => {
    it('should return mock response', async () => {
      const agentLoop = createMockAgentLoop();
      const result = await agentLoop.run('test');
      expect(result.response).toBe('Mock response');
    });

    it('should use custom response generator', async () => {
      const agentLoop = createMockAgentLoop((prompt) => `Echo: ${prompt}`);
      const result = await agentLoop.run('Hello');
      expect(result.response).toBe('Echo: Hello');
    });
  });
});
