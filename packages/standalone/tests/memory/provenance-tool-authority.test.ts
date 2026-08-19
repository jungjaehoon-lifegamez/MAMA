/**
 * The authority checks on mama_provenance, at the tool boundary.
 *
 * The predicate is tested elsewhere against the real reader. What is tested here is the
 * layer above it: what the tool decides BEFORE any event is looked at. Both controls
 * below shipped in a first version that had neither - one denied nothing, the other
 * turned a missing envelope into a connector-wide grant - and neither had a test, which
 * is how they shipped.
 */
import { describe, it, expect, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolInput, MAMAApiInterface } from '../../src/agent/types.js';

const resolveLive = vi.fn();
vi.mock('../../src/memory/provenance-live.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/memory/provenance-live.js')>(
    '../../src/memory/provenance-live.js'
  );
  return {
    ...actual,
    resolveMemoryProvenanceLive: (...args: unknown[]) => resolveLive(...args),
  };
});

function createExecutor(
  channelGrantProvider?: () => Record<string, readonly string[]>
): GatewayToolExecutor {
  return new GatewayToolExecutor({
    mamaApi: {
      recallMemory: vi.fn(),
      search: vi.fn(),
      appendToolTrace: vi.fn().mockResolvedValue(undefined),
      beginModelRun: vi.fn().mockResolvedValue({ id: 'run_1' }),
      commitModelRun: vi.fn().mockResolvedValue({ id: 'run_1' }),
      failModelRun: vi.fn().mockResolvedValue({ id: 'run_1' }),
    } as unknown as MAMAApiInterface,
    channelGrantProvider,
  });
}

function agentContext(tier: 1 | 2 | 3) {
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName: 'test_role',
    role: { allowedTools: ['mama_provenance'], blockedTools: [] },
    session: { sessionId: 's1', channelId: 'c1', userId: 'u1' },
    capabilities: ['mama_provenance'],
    limitations: [],
    tier,
  };
}

function envelope(tier: 1 | 2 | 3, scope: Record<string, unknown>) {
  return {
    instance_id: 'env_1',
    source: 'telegram',
    trigger_context: { kind: 'message' },
    scope: {
      project_refs: [],
      raw_connectors: [],
      memory_scopes: [],
      allowed_destinations: [],
      ...scope,
    },
    tier,
    budget: { max_tool_calls: 10, max_ms: 60_000, max_tokens: 10_000 },
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    envelope_hash: 'hash_1',
  };
}

function call(executor: GatewayToolExecutor, context: Record<string, unknown>) {
  return executor.execute(
    'mama_provenance',
    { memory_id: 'mem_1' } as unknown as GatewayToolInput,
    { executionSurface: 'direct', ...context } as never
  );
}

describe('mama_provenance authority', () => {
  // Tier 3 is denied context_compile, its sanctioned path to raw connector data. Without
  // this, a Tier-3 agent reads the same events one citation at a time.
  it('denies Tier 3, from either designation source', async () => {
    for (const context of [
      { agentContext: agentContext(3) },
      {
        agentContext: agentContext(2),
        envelope: envelope(3, {
          raw_connectors: ['board'],
          memory_scopes: [{ kind: 'project', id: 'alpha' }],
        }),
      },
    ]) {
      resolveLive.mockClear();
      const result = await call(createExecutor(), context);
      expect(result).toMatchObject({ success: false, code: 'permission_denied_tier3' });
      // Denied before anything was read, not filtered afterwards.
      expect(resolveLive).not.toHaveBeenCalled();
    }
  });

  // No envelope means no connector grant, and no grant means NO raw events - never all
  // of them. The raw reader fails closed on this input and so must the tool.
  it('passes an empty connector grant when there is no envelope', async () => {
    resolveLive.mockClear();
    resolveLive.mockResolvedValue({
      memoryId: 'mem_1',
      status: 'unresolved',
      modelRunId: null,
      contextPacketId: null,
      events: [],
      unresolved: [],
      supports: [],
      reason: 'no_event_refs',
    });

    const result = await call(createExecutor(), { agentContext: agentContext(2) });

    expect(result).toMatchObject({ success: true });
    expect(resolveLive).toHaveBeenCalledTimes(1);
    const options = resolveLive.mock.calls[0]?.[1] as { connectors: string[] };
    expect(options.connectors).toEqual([]);
  });

  it('narrows to the envelope grant when there is one', async () => {
    resolveLive.mockClear();
    resolveLive.mockResolvedValue({
      memoryId: 'mem_1',
      status: 'unresolved',
      modelRunId: null,
      contextPacketId: null,
      events: [],
      unresolved: [],
      supports: [],
      reason: 'no_event_refs',
    });

    await call(createExecutor(), {
      agentContext: agentContext(2),
      envelope: envelope(2, {
        raw_connectors: ['board'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        project_refs: [{ id: 'p1' }],
      }),
    });

    const options = resolveLive.mock.calls[0]?.[1] as {
      connectors: string[];
      projectIds: string[];
    };
    expect(options.connectors).toEqual(['board']);
    // The reader filters project_id on the same window; dropping it made citation wider.
    expect(options.projectIds).toEqual(['p1']);
  });

  it('TG-03/TG-04 reuses one grant snapshot for provenance scopes and citation channels', async () => {
    resolveLive.mockClear();
    resolveLive.mockResolvedValue({
      memoryId: 'mem_1',
      status: 'unresolved',
      modelRunId: null,
      contextPacketId: null,
      events: [],
      unresolved: [],
      supports: [],
      reason: 'no_event_refs',
    });
    let grantSequence = 0;
    const channelGrantProvider = vi.fn(() => {
      grantSequence += 1;
      return grantSequence === 1 ? { board: ['alpha'] } : { board: ['beta'] };
    });
    const executor = createExecutor(channelGrantProvider);
    const context = {
      agentContext: agentContext(2),
      envelope: envelope(2, {
        raw_connectors: ['board'],
        memory_scopes: [{ kind: 'global', id: 'system' }],
      }),
    };

    const firstResult = await call(executor, context);
    const secondResult = await call(executor, context);

    expect(firstResult).toMatchObject({ success: true });
    expect(secondResult).toMatchObject({ success: true });
    expect(channelGrantProvider).toHaveBeenCalledTimes(2);
    expect(resolveLive.mock.calls[0]?.[1]).toMatchObject({
      scopes: [
        { kind: 'global', id: 'system' },
        { kind: 'channel', id: 'board:alpha' },
      ],
      channels: { board: ['alpha'] },
    });
    expect(resolveLive.mock.calls[1]?.[1]).toMatchObject({
      scopes: [
        { kind: 'global', id: 'system' },
        { kind: 'channel', id: 'board:beta' },
      ],
      channels: { board: ['beta'] },
    });
  });

  it('requires a memory id rather than resolving an empty handle', async () => {
    resolveLive.mockClear();
    const result = await createExecutor().execute(
      'mama_provenance',
      { memory_id: '  ' } as unknown as GatewayToolInput,
      { executionSurface: 'direct', agentContext: agentContext(2) } as never
    );
    expect(result).toMatchObject({ success: false });
    expect(resolveLive).not.toHaveBeenCalled();
  });
});
