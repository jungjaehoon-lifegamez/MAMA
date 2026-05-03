import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { MCPExecutor } from '../../src/agent/mcp-executor.js';
import type {
  GatewayToolExecutionContext,
  GatewayToolInput,
  MAMAApiInterface,
} from '../../src/agent/types.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { EnvelopeEnforcer } from '../../src/envelope/enforcer.js';
import type { ContextCompileService } from '../../src/agent/context-compile-service.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import {
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  insertContextPacket,
  type ContextPacket,
  type ContextPacketRecord,
} from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

const FIXED_NOW_MS = Date.parse('2026-04-30T09:00:00.000Z');

let testDbPath = '';

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    packet_id: 'ctxp_gateway_tool',
    task: 'compile context',
    scopes: [{ kind: 'project' as const, id: '/workspace/project-a' }],
    scope_hash: 'scope-hash',
    generated_at: new Date(FIXED_NOW_MS).toISOString(),
    source_refs: [
      { kind: 'memory' as const, id: 'mem-1' },
      { kind: 'raw' as const, connector: 'telegram', raw_id: 'raw-1' },
    ],
    selected_evidence: [],
    evidence_clusters: [],
    related_decisions: [],
    rejected_refs: [],
    rejected_summary: [],
    missing_context: [],
    caveats: [],
    expansion_trace: [],
    retrieval_diagnostics: {},
    budget: {
      used_tool_calls: 1,
      elapsed_ms: 5,
      estimated_tokens: 16,
    },
    ...overrides,
  };
}

function makePacketRecord(
  envelope = makeSignedEnvelope(),
  overrides: Partial<ContextPacketRecord> = {}
): ContextPacketRecord {
  const packet = makePacket(overrides.packet);
  return {
    packet_id: packet.packet_id,
    task: packet.task,
    packet_json: JSON.stringify(packet),
    packet,
    scope_json: JSON.stringify(packet.scopes),
    scopes: packet.scopes,
    scope_hash: packet.scope_hash,
    envelope_hash: envelope.envelope_hash,
    model_run_id: 'mr_context_child',
    agent_id: envelope.agent_id,
    input_snapshot_ref: `context_compile:${packet.packet_id}`,
    source_refs_json: JSON.stringify(packet.source_refs),
    source_refs: packet.source_refs,
    tenant_id: 'default',
    project_id: '/workspace/project-a',
    memory_scope_kind: 'project',
    memory_scope_id: '/workspace/project-a',
    created_at: FIXED_NOW_MS,
    ...overrides,
  };
}

function seedContextPacket(
  input: {
    envelope?: ReturnType<typeof makeSignedEnvelope>;
    parentModelRunId?: string;
    childModelRunId?: string;
    packetId?: string;
    commitChild?: boolean;
  } = {}
): void {
  const envelope = input.envelope ?? makeSignedEnvelope();
  const parentModelRunId = input.parentModelRunId ?? 'mr_parent_agent_loop';
  const childModelRunId = input.childModelRunId ?? 'mr_context_child';
  const packetId = input.packetId ?? 'ctxp_gateway_tool';
  const adapter = getAdapter();

  beginModelRunInAdapter(adapter, {
    model_run_id: parentModelRunId,
    agent_id: envelope.agent_id,
    instance_id: envelope.instance_id,
    envelope_hash: envelope.envelope_hash,
    input_snapshot_ref: 'agent-loop:turn-1',
    input_refs: { tool: 'agent.loop', turn_id: 'turn-1' },
  });
  beginModelRunInAdapter(adapter, {
    model_run_id: childModelRunId,
    agent_id: envelope.agent_id,
    instance_id: envelope.instance_id,
    envelope_hash: envelope.envelope_hash,
    parent_model_run_id: parentModelRunId,
    input_snapshot_ref: `context_compile:${packetId}`,
    input_refs: { tool: 'context_compile', packet_id: packetId },
  });
  if (input.commitChild !== false) {
    commitModelRunInAdapter(adapter, childModelRunId, `context_compile packet ${packetId}`);
  }
  insertContextPacket(
    adapter,
    makePacketRecord(envelope, {
      packet_id: packetId,
      model_run_id: childModelRunId,
      input_snapshot_ref: `context_compile:${packetId}`,
      packet: makePacket({ packet_id: packetId }),
    })
  );
}

function makeService(): ContextCompileService {
  return {
    compileAndPersistContext: vi.fn(async ({ input, modelRunId }) => ({
      packet: {
        ...makePacket(),
        task: input.task,
        scopes: input.scopes ?? [],
      },
      record: {} as Awaited<
        ReturnType<ContextCompileService['compileAndPersistContext']>
      >['record'],
      modelRunId: 'mr_context_child',
      parentModelRunId: modelRunId ?? null,
    })),
  };
}

function makeTraceApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'decision_plain' }),
    saveWithTrustedProvenance: vi
      .fn()
      .mockResolvedValue({ success: true, id: 'decision_context_packet' }),
    saveCheckpoint: vi.fn(),
    listDecisions: vi.fn(),
    suggest: vi.fn(),
    updateOutcome: vi.fn(),
    loadCheckpoint: vi.fn(),
    appendToolTrace: vi.fn().mockResolvedValue({}),
  } as unknown as MAMAApiInterface;
}

function makeContext(
  overrides: Partial<GatewayToolExecutionContext> = {}
): GatewayToolExecutionContext {
  return {
    agentId: 'worker',
    source: 'telegram',
    channelId: 'tg:1',
    envelope: makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'tg:1',
    }),
    executionSurface: 'model_tool',
    ...overrides,
  };
}

describe('STORY-B6: context_compile gateway tool surface', () => {
  beforeAll(async () => {
    testDbPath = await initTestDB('context-compile-tool');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM context_packets').run();
    adapter.prepare('DELETE FROM model_runs').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('dispatches through the shared context compile service with envelope-defaulted scopes and parent model_run', async () => {
    const service = makeService();
    const traceApi = makeTraceApi();
    const executor = new GatewayToolExecutor({
      mamaApi: traceApi,
      contextCompileService: service,
    });
    const context = makeContext({ modelRunId: 'mr_parent_agent_loop' });

    const result = await executor.execute(
      'context_compile',
      { task: 'compile context', max_tool_calls: 2 } as GatewayToolInput,
      context
    );

    expect(result).toMatchObject({
      success: true,
      packet_id: 'ctxp_gateway_tool',
      model_run_id: 'mr_context_child',
      parent_model_run_id: 'mr_parent_agent_loop',
    });
    expect(service.compileAndPersistContext).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: 'gateway',
        envelope: context.envelope,
        modelRunId: 'mr_parent_agent_loop',
        input: expect.objectContaining({
          task: 'compile context',
          scopes: [{ kind: 'project', id: '/workspace/project-a' }],
          max_tool_calls: 2,
        }),
      })
    );
    expect(traceApi.appendToolTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        model_run_id: 'mr_parent_agent_loop',
        tool_name: 'context_compile',
      })
    );
  });

  it('preserves machine-readable context_compile service error codes', async () => {
    const serviceError = new Error('invalid compile input') as Error & {
      code: string;
      details: Record<string, unknown>;
    };
    serviceError.code = 'context_compile_input_invalid';
    serviceError.details = { field: 'as_of' };
    const service: ContextCompileService = {
      compileAndPersistContext: vi.fn().mockRejectedValue(serviceError),
    };
    const executor = new GatewayToolExecutor({
      contextCompileService: service,
    });

    const result = await executor.execute(
      'context_compile',
      { task: 'compile context' } as GatewayToolInput,
      makeContext()
    );

    expect(result).toMatchObject({
      success: false,
      code: 'context_compile_input_invalid',
      error: expect.stringContaining('invalid compile input'),
      details: { field: 'as_of' },
    });
  });

  it('preserves explicit empty scopes for context_compile boundary narrowing', async () => {
    const service = makeService();
    const executor = new GatewayToolExecutor({
      contextCompileService: service,
    });

    const result = await executor.execute(
      'context_compile',
      { task: 'compile context', scopes: [] } as GatewayToolInput,
      makeContext()
    );

    expect(result).toMatchObject({
      success: true,
      packet_id: 'ctxp_gateway_tool',
    });
    expect(service.compileAndPersistContext).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          task: 'compile context',
          scopes: [],
        }),
      })
    );
  });

  it('rejects context_compile memory scopes outside the envelope before service execution and records audit mismatch', async () => {
    const service = makeService();
    const metricsStore = { record: vi.fn() };
    const executor = new GatewayToolExecutor({
      contextCompileService: service,
      metricsStore,
    });
    const context = makeContext();

    const result = await executor.execute(
      'context_compile',
      {
        task: 'compile context',
        scopes: [{ kind: 'project', id: '/workspace/project-b' }],
      } as GatewayToolInput,
      context
    );

    expect(result).toMatchObject({
      success: false,
      code: 'memory_scope_out_of_scope',
      envelope_hash: context.envelope?.envelope_hash,
    });
    expect(service.compileAndPersistContext).not.toHaveBeenCalled();
    expect(metricsStore.record).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'envelope_scope_mismatch',
        labels: expect.objectContaining({ tool: 'context_compile' }),
      })
    );
  });

  it('rejects context_compile connector and raw seed refs outside the envelope before service execution', async () => {
    const service = makeService();
    const executor = new GatewayToolExecutor({ contextCompileService: service });
    const context = makeContext();

    const connectorDenied = await executor.execute(
      'context_compile',
      { task: 'compile context', connectors: ['slack'] } as GatewayToolInput,
      context
    );
    expect(connectorDenied).toMatchObject({
      success: false,
      code: 'connector_out_of_scope',
    });

    const seedDenied = await executor.execute(
      'context_compile',
      {
        task: 'compile context',
        seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: 'raw-1' }],
      } as GatewayToolInput,
      context
    );
    expect(seedDenied).toMatchObject({
      success: false,
      code: 'connector_out_of_scope',
    });
    expect(service.compileAndPersistContext).not.toHaveBeenCalled();
  });

  it('requires an active context compile service and keeps MCPExecutor legacy/subset-only', async () => {
    const executor = new GatewayToolExecutor();
    const unavailable = await executor.execute(
      'context_compile',
      { task: 'compile context' } as GatewayToolInput,
      makeContext()
    );

    expect(unavailable).toMatchObject({
      success: false,
      code: 'context_compile_unavailable',
    });
    expect(MCPExecutor.isValidTool('context_compile')).toBe(false);
    const mcpExecutor = new MCPExecutor({ mamaApi: makeTraceApi() });
    await expect(mcpExecutor.execute('context_compile', { task: 'compile' })).rejects.toMatchObject(
      { code: 'UNKNOWN_TOOL' }
    );
  });

  it('treats context_compile as envelope-scoped but not a Tier 3 read-only Code-Act tool', () => {
    const envelope = makeSignedEnvelope();
    const tier3Envelope = makeSignedEnvelope({ tier: 3 });
    const enforcer = new EnvelopeEnforcer();

    expect(() =>
      enforcer.check(envelope, 'context_compile', {
        task: 'compile context',
        scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      })
    ).not.toThrow();
    expect(() =>
      enforcer.check(envelope, 'context_compile', {
        task: 'compile context',
        scopes: [{ kind: 'project', id: '/workspace/project-b' }],
      })
    ).toThrow(/memory_scope_out_of_scope/);
    expect(() =>
      enforcer.check(tier3Envelope, 'context_compile', {
        task: 'compile context',
        scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      })
    ).toThrow(/tier_violation/);

    const bridge = new HostBridge({ execute: vi.fn() } as unknown as GatewayToolExecutor);
    const tier2Names = bridge.getAvailableFunctions(2).map((fn) => fn.name);
    const tier3Names = bridge.getAvailableFunctions(3).map((fn) => fn.name);
    expect(tier2Names).toContain('context_compile');
    expect(tier3Names).not.toContain('context_compile');
    expect(tier3Names).toContain('mama_search');
    expect(tier3Names).not.toContain('mama_save');
  });

  it('denies direct gateway context_compile calls from Tier 3 envelopes', async () => {
    const service = makeService();
    const executor = new GatewayToolExecutor({
      contextCompileService: service,
    });

    const result = await executor.execute(
      'context_compile',
      { task: 'compile context' } as GatewayToolInput,
      makeContext({ envelope: makeSignedEnvelope({ tier: 3 }) })
    );

    expect(result).toMatchObject({
      success: false,
    });
    expect(String(result.error)).toContain('tier_violation');
    expect(service.compileAndPersistContext).not.toHaveBeenCalled();
  });

  it('derives trusted mama_save provenance from a committed context packet and ignores caller refs', async () => {
    const envelope = makeSignedEnvelope();
    seedContextPacket({ envelope });
    const traceApi = makeTraceApi();
    const executor = new GatewayToolExecutor({ mamaApi: traceApi });
    const context = makeContext({ envelope, modelRunId: 'mr_parent_agent_loop' });

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'context_packet_save',
        decision: 'Save should preserve packet provenance',
        reasoning: 'The gateway owns packet lookup and provenance refs',
        context_packet_id: 'ctxp_gateway_tool',
        source_refs: ['raw:attacker:spoofed'],
        provenance: { context_packet_id: 'ctxp_attacker' },
      } as unknown as GatewayToolInput,
      context
    );

    expect(result).toMatchObject({ success: true, id: 'decision_context_packet' });
    expect(traceApi.saveWithTrustedProvenance).toHaveBeenCalledOnce();
    const trustedOptions = vi.mocked(traceApi.saveWithTrustedProvenance).mock.calls[0][1];
    expect(trustedOptions.provenance).toMatchObject({
      context_packet_id: 'ctxp_gateway_tool',
      envelope_hash: envelope.envelope_hash,
      model_run_id: 'mr_parent_agent_loop',
      tool_name: 'mama_save',
    });
    expect(trustedOptions.provenance.source_refs).toEqual(
      expect.arrayContaining([
        `envelope:${envelope.envelope_hash}`,
        'memory:mem-1',
        'raw:telegram:raw-1',
      ])
    );
    expect(trustedOptions.provenance.source_refs).not.toContain('raw:attacker:spoofed');
  });

  it('rejects context packet save provenance unless the packet is committed and in the caller lineage', async () => {
    const envelope = makeSignedEnvelope();
    seedContextPacket({ envelope, commitChild: false });
    const uncommittedApi = makeTraceApi();
    const uncommittedExecutor = new GatewayToolExecutor({ mamaApi: uncommittedApi });

    const uncommitted = await uncommittedExecutor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'context_packet_uncommitted',
        decision: 'Uncommitted packets are not trusted',
        reasoning: 'Downstream saves require committed compile runs',
        context_packet_id: 'ctxp_gateway_tool',
      } as unknown as GatewayToolInput,
      makeContext({ envelope, modelRunId: 'mr_parent_agent_loop' })
    );

    expect(uncommitted).toMatchObject({
      success: false,
      code: 'context_packet_denied',
    });
    expect(uncommittedApi.saveWithTrustedProvenance).not.toHaveBeenCalled();

    const adapter = getAdapter();
    adapter.prepare('DELETE FROM context_packets').run();
    adapter.prepare('DELETE FROM model_runs').run();
    seedContextPacket({ envelope });
    beginModelRunInAdapter(adapter, {
      model_run_id: 'mr_unrelated_agent_loop',
      agent_id: envelope.agent_id,
      instance_id: envelope.instance_id,
      envelope_hash: envelope.envelope_hash,
      input_snapshot_ref: 'agent-loop:unrelated',
      input_refs: { tool: 'agent.loop', turn_id: 'unrelated' },
    });

    const unrelatedApi = makeTraceApi();
    const unrelatedExecutor = new GatewayToolExecutor({ mamaApi: unrelatedApi });
    const unrelated = await unrelatedExecutor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'context_packet_unrelated',
        decision: 'Unrelated model runs cannot reuse packets',
        reasoning: 'Packet provenance requires same run or parent child lineage',
        context_packet_id: 'ctxp_gateway_tool',
      } as unknown as GatewayToolInput,
      makeContext({ envelope, modelRunId: 'mr_unrelated_agent_loop' })
    );

    expect(unrelated).toMatchObject({
      success: false,
      code: 'context_packet_denied',
    });
    expect(unrelatedApi.saveWithTrustedProvenance).not.toHaveBeenCalled();
  });
});
