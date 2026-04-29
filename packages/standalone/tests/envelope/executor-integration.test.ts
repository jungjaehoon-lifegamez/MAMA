import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolInput, MAMAApiInterface } from '../../src/agent/types.js';
import { makeEnvelope } from './fixtures.js';

function makeTelegramGateway() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(true),
  };
}

function makeMAMAApi(): MAMAApiInterface {
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
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_executor_integration',
      status: 'running',
    }),
    commitModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_executor_integration',
      status: 'committed',
    }),
    failModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_executor_integration',
      status: 'failed',
    }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_executor_integration',
      model_run_id: 'mr_executor_integration',
      tool_name: 'mama_load_checkpoint',
    }),
  };
}

describe('gateway-tool-executor envelope integration', () => {
  let previousFailLoud: string | undefined;
  let previousAllowLegacyBypass: string | undefined;

  beforeEach(() => {
    previousFailLoud = process.env.MAMA_ENVELOPE_FAIL_LOUD;
    previousAllowLegacyBypass = process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    delete process.env.MAMA_ENVELOPE_FAIL_LOUD;
    delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
  });

  afterEach(() => {
    if (previousFailLoud === undefined) {
      delete process.env.MAMA_ENVELOPE_FAIL_LOUD;
    } else {
      process.env.MAMA_ENVELOPE_FAIL_LOUD = previousFailLoud;
    }
    if (previousAllowLegacyBypass === undefined) {
      delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    } else {
      process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = previousAllowLegacyBypass;
    }
  });

  it('denies gateway tool calls without an envelope by default', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute(
      'mama_load_checkpoint',
      {},
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:1',
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({
      success: false,
      code: 'envelope_missing',
    });
    expect(result.error).toContain('without envelope');
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('denies missing execution context when issuance is enabled', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute('mama_load_checkpoint', {});

    expect(result).toMatchObject({
      success: false,
      code: 'envelope_missing',
    });
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('allows explicit non-reactive direct calls without an envelope', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute(
      'mama_load_checkpoint',
      {},
      {
        agentId: 'direct-test',
        source: 'viewer',
        channelId: 'direct',
        executionSurface: 'direct',
      }
    );

    expect(result).toEqual({ success: true });
    expect(mamaApi.loadCheckpoint).toHaveBeenCalledOnce();
  });

  it('denies explicit execution contexts that omit executionSurface', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute('mama_load_checkpoint', {}, {
      agentId: 'worker',
      source: 'telegram',
      channelId: 'tg:1',
    } as Parameters<GatewayToolExecutor['execute']>[2]);

    expect(result).toMatchObject({
      success: false,
      code: 'envelope_missing',
    });
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('allows missing-envelope execution only when the legacy bypass is explicit', async () => {
    process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = 'true';
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute(
      'mama_load_checkpoint',
      {},
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:1',
        executionSurface: 'model_tool',
      }
    );

    expect(result).toEqual({ success: true });
    expect(mamaApi.loadCheckpoint).toHaveBeenCalledOnce();
  });

  it('keeps fail-loud scoped to reactive execution surfaces', async () => {
    process.env.MAMA_ENVELOPE_FAIL_LOUD = 'true';
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    const result = await executor.execute(
      'mama_load_checkpoint',
      {},
      {
        agentId: 'direct-test',
        source: 'viewer',
        channelId: 'direct',
        executionSurface: 'direct',
      }
    );

    expect(result).toEqual({ success: true });
    expect(mamaApi.loadCheckpoint).toHaveBeenCalledOnce();
  });

  it('fails loud when an explicit gateway context has no envelope', async () => {
    process.env.MAMA_ENVELOPE_FAIL_LOUD = 'true';
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    await expect(
      executor.execute(
        'mama_load_checkpoint',
        {},
        {
          agentId: 'worker',
          source: 'telegram',
          channelId: 'tg:1',
          executionSurface: 'model_tool',
        }
      )
    ).rejects.toThrow(/without envelope/);
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('treats common truthy fail-loud env values as enabled', async () => {
    process.env.MAMA_ENVELOPE_FAIL_LOUD = '1';
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'enabled' });

    await expect(
      executor.execute(
        'mama_load_checkpoint',
        {},
        {
          agentId: 'worker',
          source: 'telegram',
          channelId: 'tg:1',
          executionSurface: 'model_tool',
        }
      )
    ).rejects.toThrow(/without envelope/);
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('rejects telegram_send to a destination outside envelope.allowed_destinations before gateway send', async () => {
    const gateway = makeTelegramGateway();
    const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
    executor.setTelegramGateway(gateway);
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_telegram',
      source: 'telegram',
      channel_id: 'tg:OWN',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'telegram_send',
      { chat_id: 'tg:OTHER_PROJECT', message: 'leak' } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({
      success: false,
      code: 'destination_out_of_scope',
      envelope_hash: 'envhash_telegram',
    });
    expect(result.error).toContain('destination_out_of_scope');
    expect(gateway.sendMessage).not.toHaveBeenCalled();
  });

  it('allows telegram_send when the destination is inside envelope.allowed_destinations', async () => {
    const gateway = makeTelegramGateway();
    const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
    executor.setTelegramGateway(gateway);
    const envelope = makeEnvelope({
      source: 'telegram',
      channel_id: 'tg:OWN',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'telegram_send',
      { chat_id: 'tg:OWN', message: 'safe' } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(gateway.sendMessage).toHaveBeenCalledWith('tg:OWN', 'safe');
  });

  it('rejects tier 3 write tools before calling MAMA API', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_tier3',
      tier: 3,
    });

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'auth',
        decision: 'Use explicit envelope enforcement',
        reasoning: 'Tier 3 must stay read-only',
      } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:1',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({
      success: false,
      code: 'tier_violation',
      envelope_hash: 'envhash_tier3',
    });
    expect(result.error).toContain('tier_violation');
    expect(mamaApi.save).not.toHaveBeenCalled();
  });
});
