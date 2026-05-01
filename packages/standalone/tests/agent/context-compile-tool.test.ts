import { describe, expect, it, vi } from 'vitest';

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

function makePacket() {
  return {
    packet_id: 'ctxp_gateway_tool',
    task: 'compile context',
    scopes: [{ kind: 'project' as const, id: '/workspace/project-a' }],
    scope_hash: 'scope-hash',
    generated_at: '2026-04-30T09:00:00.000Z',
    source_refs: [{ kind: 'memory' as const, id: 'mem-1' }],
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
  };
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
    save: vi.fn(),
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

  it('treats context_compile as an envelope-scoped read tool in the enforcer and Code-Act bridge', () => {
    const envelope = makeSignedEnvelope();
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

    const bridge = new HostBridge({ execute: vi.fn() } as unknown as GatewayToolExecutor);
    const tier3Names = bridge.getAvailableFunctions(3).map((fn) => fn.name);
    expect(tier3Names).toContain('context_compile');
    expect(tier3Names).toContain('mama_search');
    expect(tier3Names).not.toContain('mama_save');
  });
});
