import { describe, expect, it, vi } from 'vitest';

import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentContext, MAMAApiInterface } from '../../src/agent/types.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import Database from '../../src/sqlite.js';
import { makeSignedEnvelope } from './fixtures.js';

type ProvenanceAwareApi = MAMAApiInterface & {
  saveWithTrustedProvenance: ReturnType<typeof vi.fn>;
  ingestWithTrustedProvenance: ReturnType<typeof vi.fn>;
};

function createContext(): AgentContext {
  return {
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
  };
}

function createApi(): ProvenanceAwareApi {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'public_save', type: 'decision' }),
    saveWithTrustedProvenance: vi
      .fn()
      .mockResolvedValue({ success: true, id: 'trusted_save', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_1',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true, message: 'updated' }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true, id: 'public_ingest' }),
    ingestWithTrustedProvenance: vi.fn().mockResolvedValue({ success: true, id: 'trusted_ingest' }),
  };
}

function createEnvelope() {
  return makeSignedEnvelope({
    source: 'telegram',
    channel_id: 'abc',
    scope: {
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      raw_connectors: ['telegram'],
      memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
      allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
    },
  });
}

describe('Story M2.1: Gateway Memory Provenance Context', () => {
  it('threads trusted context into mama_save and ignores caller-supplied provenance', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const api = createApi();
    const executor = new GatewayToolExecutor({ mamaApi: api });
    executor.setSessionsDb(db);
    const envelope = createEnvelope();

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'gateway_trusted_provenance',
        decision: 'Gateway context chooses provenance',
        reasoning: 'Caller input cannot spoof envelope hash',
        provenance: { envelope_hash: 'attacker_env' },
      },
      {
        agentContext: createContext(),
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        envelope,
        executionSurface: 'model_tool',
        sourceTurnId: 'turn-1',
        sourceMessageRef: 'telegram:abc:turn-1',
      }
    );

    expect(result).toMatchObject({ success: true, id: 'trusted_save' });
    expect(api.save).not.toHaveBeenCalled();
    expect(api.saveWithTrustedProvenance).toHaveBeenCalledOnce();
    const [, options] = api.saveWithTrustedProvenance.mock.calls[0];
    expect(options.provenance).toMatchObject({
      actor: 'main_agent',
      agent_id: 'chat_bot',
      envelope_hash: envelope.envelope_hash,
      tool_name: 'mama_save',
      source_turn_id: 'turn-1',
      source_message_ref: 'telegram:abc:turn-1',
    });
    expect(options.provenance.envelope_hash).not.toBe('attacker_env');
    expect(options.provenance.gateway_call_id).toMatch(/^gw_/);

    const row = db
      .prepare(
        `SELECT gateway_call_id, details
         FROM agent_activity
         WHERE type = 'gateway_tool_call'
         LIMIT 1`
      )
      .get() as { gateway_call_id: string | null; details: string };
    expect(row.gateway_call_id).toBe(options.provenance.gateway_call_id);
    expect(JSON.parse(row.details).gateway_call_id).toBe(options.provenance.gateway_call_id);
    db.close();
  });

  it('threads trusted context into mama_ingest without trusting input provenance', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const api = createApi();
    const executor = new GatewayToolExecutor({ mamaApi: api });
    executor.setSessionsDb(db);
    const envelope = createEnvelope();

    const result = await executor.execute(
      'mama_ingest',
      {
        content: 'User prefers compact provenance.',
        scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        provenance: { gateway_call_id: 'attacker_gw' },
      },
      {
        agentContext: createContext(),
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        envelope,
        executionSurface: 'model_tool',
        sourceTurnId: 'turn-2',
        sourceMessageRef: 'telegram:abc:turn-2',
      }
    );

    expect(result).toMatchObject({ success: true, saved: 1 });
    expect(api.ingestMemory).not.toHaveBeenCalled();
    expect(api.ingestWithTrustedProvenance).toHaveBeenCalledOnce();
    const [, options] = api.ingestWithTrustedProvenance.mock.calls[0];
    expect(options.provenance.gateway_call_id).toMatch(/^gw_/);
    expect(options.provenance.gateway_call_id).not.toBe('attacker_gw');
    expect(options.provenance.envelope_hash).toBe(envelope.envelope_hash);
    db.close();
  });

  it('merges fallback agent context and model run id into trusted provenance', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const api = createApi();
    const executor = new GatewayToolExecutor({ mamaApi: api });
    executor.setSessionsDb(db);
    executor.setAgentContext({
      ...createContext(),
      roleName: 'memory_agent',
    });
    executor.setCurrentAgentContext('memory-agent-1', 'telegram', 'abc');
    const envelope = createEnvelope();

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'fallback_context_provenance',
        decision: 'Fallback context still identifies the actor',
        reasoning: 'Async context can omit agent fields while runtime fallback has them',
      },
      {
        envelope,
        executionSurface: 'model_tool',
        sourceTurnId: 'turn-with-fallback',
        sourceMessageRef: 'telegram:abc:turn-with-fallback',
        modelRunId: 'model-run-1',
      }
    );

    expect(result).toMatchObject({ success: true, id: 'trusted_save' });
    expect(api.saveWithTrustedProvenance).toHaveBeenCalledOnce();
    const [, options] = api.saveWithTrustedProvenance.mock.calls[0];
    expect(options.provenance.actor).toBe('memory_agent');
    expect(options.provenance.agent_id).toBe('memory-agent-1');
    expect(options.provenance.model_run_id).toBe('model-run-1');
    expect(options.provenance.envelope_hash).toBe(envelope.envelope_hash);
    expect(options.provenance.source_message_ref).toBe('telegram:abc:turn-with-fallback');
    db.close();
  });
});
