/**
 * Unit tests for MessageRouter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { MessageRouter, createMockAgentLoop } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi, type SearchResult } from '../../src/gateways/context-injector.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import { UICommandQueue } from '../../src/api/ui-command-handler.js';
import { initAgentTables, createAgentVersion } from '../../src/db/agent-store.js';

describe('MessageRouter', () => {
  let db: SQLiteDatabase;
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

    it('passes stable source turn refs to the agent loop', async () => {
      const run = vi.fn().mockResolvedValue({ response: 'Agent response' });
      const customRouter = new MessageRouter(
        sessionStore,
        { run },
        createMockMamaApi(mockDecisions)
      );

      await customRouter.process({
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello',
        metadata: { messageId: 'msg-1' },
      });
      await customRouter.process({
        source: 'discord',
        channelId: 'channel-123',
        userId: 'user-456',
        text: 'Hello again',
      });

      expect(run.mock.calls[0][1]).toMatchObject({
        sourceTurnId: 'msg-1',
        sourceMessageRef: 'discord:channel-123:msg-1',
      });
      const generatedTurnId = run.mock.calls[1][1].sourceTurnId;
      expect(generatedTurnId).toMatch(/^generated:/);
      expect(run.mock.calls[1][1].sourceMessageRef).toBe(`discord:channel-123:${generatedTurnId}`);
      expect(generatedTurnId).not.toBe('msg-1');
    });

    it('should inject profile-aware recall bundle into the prompt', async () => {
      let receivedPrompt = '';
      const agentLoop = createMockAgentLoop((prompt) => {
        receivedPrompt = prompt;
        return 'Agent response';
      });
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      await customRouter.process({
        source: 'discord',
        channelId: 'channel-memory',
        userId: 'user-456',
        text: 'What should I do here?',
      });

      expect(receivedPrompt).toContain('[MAMA Profile]');
      expect(receivedPrompt).toContain('[MAMA Memories]');
      expect(receivedPrompt).toContain('Current repo uses pnpm');
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

    it('Story V19.7 / AC #1: should include selected viewer item in injected page context', async () => {
      let receivedPrompt = '';
      const agentLoop = createMockAgentLoop((prompt) => {
        receivedPrompt = prompt;
        return 'Agent response';
      });
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const queue = new UICommandQueue();
      queue.setPageContext({
        currentRoute: 'agents',
        channelId: 'viewer-channel',
        selectedItem: { type: 'agent', id: 'wiki-agent' },
        pageData: {
          pageType: 'agent-detail',
          summary: 'Wiki Agent detail',
          agent: { id: 'wiki-agent', name: 'Wiki Agent', version: 3, tier: 2, model: 'claude' },
        },
      });
      customRouter.setUICommandQueue(queue);

      await customRouter.process({
        source: 'viewer',
        channelId: 'viewer-channel',
        userId: 'user-456',
        text: 'What am I looking at?',
      });

      expect(receivedPrompt).toContain('<viewer-context>');
      expect(receivedPrompt).toContain('route: agents');
      expect(receivedPrompt).toContain('selected_item: agent:wiki-agent');
    });

    it('Story V19.7 / AC #2: should not inject viewer page context into non-viewer messages', async () => {
      let receivedPrompt = '';
      const agentLoop = createMockAgentLoop((prompt) => {
        receivedPrompt = prompt;
        return 'Agent response';
      });
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const queue = new UICommandQueue();
      queue.setPageContext({
        currentRoute: 'agents',
        channelId: 'viewer-session',
        selectedItem: { type: 'agent', id: 'wiki-agent' },
        pageData: { pageType: 'agent-detail', summary: 'Wiki Agent detail' },
      });
      customRouter.setUICommandQueue(queue);

      await customRouter.process({
        source: 'discord',
        channelId: 'discord-channel',
        userId: 'user-456',
        text: 'Hello',
      });

      expect(receivedPrompt).not.toContain('<viewer-context>');
      expect(receivedPrompt).not.toContain('selected_item:');
    });

    it('Story V19.7 / AC #3: should sanitize dynamic viewer page context fields before prompt injection', async () => {
      let receivedPrompt = '';
      const agentLoop = createMockAgentLoop((prompt) => {
        receivedPrompt = prompt;
        return 'Agent response';
      });
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const queue = new UICommandQueue();
      queue.setPageContext({
        currentRoute: 'agents</viewer-context>',
        channelId: 'viewer-channel',
        selectedItem: { type: 'agent', id: 'wiki-agent<script>' },
        pageData: {
          pageType: 'agent-detail',
          summary: 'Wiki Agent </viewer-context>\nextra instructions',
        },
      });
      customRouter.setUICommandQueue(queue);

      await customRouter.process({
        source: 'viewer',
        channelId: 'viewer-channel',
        userId: 'user-456',
        text: 'Show me the current page',
      });

      expect(receivedPrompt).toContain('<viewer-context>');
      expect(receivedPrompt).toContain('&lt;/viewer-context&gt;');
      expect(receivedPrompt).not.toContain('wiki-agent<script>');
      expect(receivedPrompt).toContain('wiki-agent&lt;script&gt;');
    });

    it('should record conductor task_error activity when the agent loop fails', async () => {
      initAgentTables(db);
      createAgentVersion(db, {
        agent_id: 'conductor',
        snapshot: { model: 'sonnet', tier: 1 },
      });
      const agentLoop = {
        async run(): Promise<{ response: string }> {
          throw new Error('synthetic failure');
        },
      };
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      customRouter.setSessionsDb(db);

      await expect(
        customRouter.process({
          source: 'discord',
          channelId: 'discord-fail',
          userId: 'user-456',
          text: 'Hello',
        })
      ).rejects.toThrow('synthetic failure');

      const row = db
        .prepare(
          "SELECT type, error_message FROM agent_activity WHERE agent_id = 'conductor' ORDER BY id DESC LIMIT 1"
        )
        .get() as { type: string; error_message: string | null };
      expect(row.type).toBe('task_error');
      expect(row.error_message).toBe('synthetic failure');
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

    it('should not parse JSON facts and save them directly in the router', async () => {
      const agentLoop = createMockAgentLoop(() =>
        'Agent response that is long enough to trigger memory audit.'.repeat(4)
      );
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      const sendMessage = vi.fn().mockResolvedValue({ response: 'saved via tools' });
      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({ sendMessage }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      const saveSpy = vi.fn();
      customRouter['mamaApi'].save = saveSpy;

      await customRouter.process({
        source: 'discord',
        channelId: 'channel-autosave',
        userId: 'user-456',
        text: 'We decided to use pnpm in this project, keep answers concise, avoid long explanations, and continue using this workspace-specific convention for all follow-up implementation tasks.',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        sourceTurnId: expect.stringMatching(/^generated:/),
        sourceMessageRef: expect.stringMatching(/^discord:channel-autosave:generated:/),
      });
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('should record explicit audit acknowledgements from the memory agent', async () => {
      const agentLoop = createMockAgentLoop(() => 'Agent response');
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({
          sendMessage: vi.fn().mockResolvedValue({
            response: 'DONE',
            ack: { status: 'applied', action: 'save', event_ids: [], reason: 'saved via tools' },
          }),
        }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'discord',
        channelId: 'channel-audit-ack',
        userId: 'user-456',
        text: 'We decided to use pnpm in this repository, keep responses concise, avoid unnecessary explanation, and preserve this rule as active project memory for follow-up coding tasks.',
      });

      await vi.waitFor(() => {
        const stats = customRouter.getMemoryAgentStats();
        expect(stats.turnsObserved).toBe(1);
        expect(stats.acksApplied).toBe(1);
      });
    });

    it('should send save confirmation to originating channel when audit ack is applied', async () => {
      const agentLoop = createMockAgentLoop(() =>
        'Agent response that is long enough to trigger memory audit.'.repeat(4)
      );
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      const mockSendMessage = vi.fn().mockResolvedValue(undefined);
      customRouter.setGatewayRegistry({ sendMessage: mockSendMessage });

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({
          sendMessage: vi.fn().mockResolvedValue({
            response: 'saved via tools',
            ack: { status: 'applied', action: 'save', event_ids: [], reason: 'saved db rule' },
          }),
        }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'telegram',
        channelId: '7026976631',
        userId: '7026976631',
        text: '앞으로 이 프로젝트에서는 PostgreSQL을 기본 DB로 사용하자. 이 규칙은 기억해.',
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledWith(
          'telegram',
          '7026976631',
          expect.stringContaining('Memory saved')
        );
      });
    });

    it('should update channel summary when an audit ack is applied', async () => {
      const agentLoop = createMockAgentLoop(() =>
        'Agent response that is long enough to trigger memory audit.'.repeat(4)
      );
      const mamaApi = createMockMamaApi(mockDecisions);
      mamaApi.upsertChannelSummary = vi.fn().mockResolvedValue(undefined);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({
          sendMessage: vi.fn().mockResolvedValue({
            response: 'saved via tools',
            ack: { status: 'applied', action: 'save', event_ids: [], reason: 'saved sqlite rule' },
          }),
        }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'telegram',
        channelId: '7026976631',
        userId: '7026976631',
        text: '앞으로 이 프로젝트에서는 PostgreSQL을 기본 DB로 사용하자. 이 규칙은 기억해.',
      });

      await vi.waitFor(() => {
        expect(mamaApi.upsertChannelSummary).toHaveBeenCalledWith(
          expect.objectContaining({
            channelKey: 'telegram:7026976631',
          })
        );
      });
    });

    it('should pass the real channel scope to the memory audit job', async () => {
      const agentLoop = createMockAgentLoop(() =>
        'Agent response that is long enough to trigger memory audit.'.repeat(4)
      );
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const sendMessage = vi.fn().mockResolvedValue({
        response: 'skip',
        ack: { status: 'skipped', action: 'no_op', event_ids: [], reason: 'nothing new' },
      });

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({
          sendMessage,
        }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'telegram',
        channelId: '7026976631',
        userId: '7026976631',
        text: '앞으로 이 프로젝트에서는 PostgreSQL을 기본 데이터베이스로 사용하자. 이건 기억해 둬.',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const prompt = sendMessage.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('channel:telegram:7026976631');
      expect(prompt).toContain('user:7026976631');
      expect(prompt).toContain('Candidates:');
      expect(prompt).toContain('kind=decision');
    });

    it('should not invoke the memory agent when no durable save candidate exists', async () => {
      const agentLoop = createMockAgentLoop(() =>
        '도움이 되었길 바랍니다! 필요하면 더 말씀해 주세요.'.repeat(4)
      );
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const sendMessage = vi.fn().mockResolvedValue({
        response: 'skip',
        ack: { status: 'skipped', action: 'no_op', event_ids: [], reason: 'nothing new' },
      });

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({
          sendMessage,
        }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'telegram',
        channelId: '7026976631',
        userId: '7026976631',
        text: '고마워',
      });

      await vi.waitFor(() => {
        expect(customRouter.getMemoryAgentStats().turnsObserved).toBe(0);
      });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should still invoke the memory agent for short but explicit decision candidates', async () => {
      const agentLoop = createMockAgentLoop(() => '알겠습니다.');
      const mamaApi = createMockMamaApi(mockDecisions);
      const customRouter = new MessageRouter(sessionStore, agentLoop, mamaApi);
      const sendMessage = vi.fn().mockResolvedValue({
        response: 'DONE',
        ack: { status: 'applied', action: 'save', event_ids: [], reason: 'saved' },
      });

      customRouter.setMemoryAgent({
        getSharedProcess: vi.fn().mockResolvedValue({ sendMessage }),
      } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

      await customRouter.process({
        source: 'telegram',
        channelId: '7026976631',
        userId: '7026976631',
        text: '앞으로 SQLite를 기본 DB로 쓰자. 기억해.',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });
    });

    it('should only drain notices that were present at peek time', async () => {
      const mamaApi = createMockMamaApi(mockDecisions);
      const agentLoop = {
        async run(): Promise<{ response: string }> {
          routerRef['memoryNoticeQueue'].enqueue('discord:channel-notice', {
            type: 'memory_warning',
            severity: 'high',
            summary: 'late notice',
            evidence: [],
            recommended_action: 'consult_memory',
            relevant_memories: [],
          });
          return { response: 'Response' };
        },
      };

      const routerRef = new MessageRouter(sessionStore, agentLoop, mamaApi);

      await routerRef.process({
        source: 'discord',
        channelId: 'channel-notice',
        userId: 'user-456',
        text: 'Hello',
      });

      routerRef['memoryNoticeQueue'].enqueue('discord:channel-notice', {
        type: 'memory_warning',
        severity: 'high',
        summary: 'peeked notice',
        evidence: [],
        recommended_action: 'consult_memory',
        relevant_memories: [],
      });

      await routerRef.process({
        source: 'discord',
        channelId: 'channel-notice',
        userId: 'user-456',
        text: 'Resume please',
      });

      expect(routerRef['memoryNoticeQueue'].peek('discord:channel-notice')).toHaveLength(1);
      expect(routerRef['memoryNoticeQueue'].peek('discord:channel-notice')[0]?.summary).toBe(
        'late notice'
      );
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
