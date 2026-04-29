import { describe, expect, it, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { AgentError, type GatewayToolInput, type MAMAApiInterface } from '../../src/agent/types.js';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import { makeSignedEnvelope } from './fixtures.js';

type GatewayAuditRow = {
  agent_id: string;
  type: string;
  input_summary: string | null;
  execution_status: string | null;
  error_message: string | null;
  envelope_hash: string | null;
};

function createMAMAApi(): MAMAApiInterface {
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
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'test', scope_order: [], retrieval_sources: [] },
    }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true, id: 'ingested_1' }),
  };
}

function createTelegramGateway() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(true),
  };
}

function readGatewayToolRows(db: Database): GatewayAuditRow[] {
  return db
    .prepare(
      `SELECT agent_id, type, input_summary, execution_status, error_message, envelope_hash
       FROM agent_activity
       WHERE type = 'gateway_tool_call'
       ORDER BY id ASC`
    )
    .all() as GatewayAuditRow[];
}

describe('Story M1R: gateway tool execution audit ledger', () => {
  it('records successful gateway calls with envelope hash and completed status', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const executor = new GatewayToolExecutor({ mamaApi: createMAMAApi() });
    executor.setSessionsDb(db);
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { query: 'audit' },
      { agentId: 'chat_bot', source: 'telegram', channelId: 'abc', envelope }
    );

    expect(result).toMatchObject({ success: true });
    expect(readGatewayToolRows(db)).toEqual([
      expect.objectContaining({
        input_summary: 'mama_search',
        execution_status: 'completed',
        envelope_hash: envelope.envelope_hash,
      }),
    ]);
    db.close();
  });

  it('records gateway audit rows with merged fallback context when async context is partial', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const executor = new GatewayToolExecutor({ mamaApi: createMAMAApi() });
    executor.setSessionsDb(db);
    executor.setAgentContext({
      source: 'telegram',
      platform: 'telegram',
      roleName: 'chat_bot',
      role: {
        allowedTools: ['*'],
        systemControl: false,
        sensitiveAccess: false,
      },
      session: {
        sessionId: 'telegram:abc',
        channelId: 'abc',
        userId: 'user-1',
        startedAt: new Date(),
      },
      capabilities: ['*'],
      limitations: [],
      tier: 2,
      backend: 'claude',
    });
    executor.setCurrentAgentContext('fallback-chat-bot', 'telegram', 'abc');
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { query: 'audit' },
      {
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(readGatewayToolRows(db)).toEqual([
      expect.objectContaining({
        agent_id: 'fallback-chat-bot',
        input_summary: 'mama_search',
        execution_status: 'completed',
        envelope_hash: envelope.envelope_hash,
      }),
    ]);
    db.close();
  });

  it('records a generic gateway call row when envelope destination enforcement denies a tool', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const telegramGateway = createTelegramGateway();
    const executor = new GatewayToolExecutor({ mamaApi: createMAMAApi() });
    executor.setTelegramGateway(telegramGateway);
    executor.setSessionsDb(db);
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'own',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:own' }],
        allowed_destinations: [{ kind: 'telegram', id: 'own' }],
      },
    });

    const result = await executor.execute(
      'telegram_send',
      { chat_id: 'other', message: 'outside' } as unknown as GatewayToolInput,
      { agentId: 'chat_bot', source: 'telegram', channelId: 'own', envelope }
    );

    expect(result).toMatchObject({
      success: false,
      code: 'destination_out_of_scope',
      envelope_hash: envelope.envelope_hash,
    });
    expect(telegramGateway.sendMessage).not.toHaveBeenCalled();
    expect(readGatewayToolRows(db)).toEqual([
      expect.objectContaining({
        input_summary: 'telegram_send',
        execution_status: 'failed',
        envelope_hash: envelope.envelope_hash,
      }),
    ]);
    db.close();
  });

  it('records failed gateway calls while preserving the original AgentError contract', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const executor = new GatewayToolExecutor({ mamaApi: createMAMAApi() });
    executor.setSessionsDb(db);
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'dashboard_slot', id: 'daily' }],
      },
    });

    await expect(
      executor.execute('report_publish', {} as unknown as GatewayToolInput, {
        agentId: 'dashboard',
        source: 'telegram',
        channelId: 'abc',
        envelope,
      })
    ).rejects.toMatchObject({
      code: 'TOOL_ERROR',
      retryable: false,
    } satisfies Partial<AgentError>);

    expect(readGatewayToolRows(db)).toEqual([
      expect.objectContaining({
        input_summary: 'report_publish',
        execution_status: 'failed',
        envelope_hash: envelope.envelope_hash,
        error_message: expect.stringContaining('report_publish requires slots object'),
      }),
    ]);
    db.close();
  });
});
