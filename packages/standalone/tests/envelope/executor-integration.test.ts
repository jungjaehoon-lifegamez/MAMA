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
    });
    expect(result).not.toHaveProperty('envelope_hash');
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

  it('issues an envelope-bound capability for a discovered Drive child folder and rejects forgery', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
    const driveTools = {
      findFolder: vi.fn().mockResolvedValue({
        folderId: 'folder-child',
        path: 'project/output',
        traversedFolderIds: ['drive-root', 'folder-project', 'folder-child'],
      }),
      upload: vi.fn().mockResolvedValue({ fileId: 'uploaded-1', name: 'translated.png' }),
    };
    (
      executor as unknown as {
        driveTools: typeof driveTools;
      }
    ).driveTools = driveTools;
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_drive_capability',
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram', 'drive'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [
          { kind: 'telegram', id: 'tg:OWN' },
          { kind: 'drive', id: 'folder-project' },
        ],
      },
    });
    const executionContext = {
      agentId: 'worker',
      source: 'telegram',
      channelId: 'tg:OWN',
      envelope,
      executionSurface: 'model_tool' as const,
      agentContext: {
        source: 'telegram',
        platform: 'telegram' as const,
        roleName: 'owner_console',
        role: { allowedTools: ['drive_find_folder', 'drive_upload'] },
        session: {
          sessionId: 'session-drive-capability',
          channelId: 'tg:OWN',
          userId: 'owner',
          startedAt: new Date(),
        },
        capabilities: [],
        limitations: [],
      },
    };

    const found = await executor.execute(
      'drive_find_folder',
      { driveId: 'drive-root', path: 'project/output' } as GatewayToolInput,
      executionContext
    );
    const capability = (found as { destinationCapability?: string }).destinationCapability;
    expect(capability).toMatch(/^drivecap_/);

    const uploaded = await executor.execute(
      'drive_upload',
      {
        localPath: '/workspace/project-a/translated.png',
        folderId: 'folder-child',
        destinationCapability: capability,
      } as GatewayToolInput,
      executionContext
    );
    const forged = await executor.execute(
      'drive_upload',
      {
        localPath: '/workspace/project-a/secret.png',
        folderId: 'folder-child',
        destinationCapability: `${capability}-forged`,
      } as GatewayToolInput,
      executionContext
    );

    expect(uploaded).toMatchObject({ success: true });
    expect(driveTools.upload).toHaveBeenCalledTimes(1);
    expect(forged).toMatchObject({ success: false, code: 'destination_capability_invalid' });
  });

  it('denies a resolved Drive folder that is not below a configured destination', async () => {
    const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
    const driveTools = {
      findFolder: vi.fn().mockResolvedValue({
        folderId: 'other-child',
        path: 'other/child',
        traversedFolderIds: ['drive-root', 'other-parent', 'other-child'],
      }),
    };
    (executor as unknown as { driveTools: typeof driveTools }).driveTools = driveTools;
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['drive'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'drive', id: 'configured-folder' }],
      },
    });

    const result = await executor.execute(
      'drive_find_folder',
      { driveId: 'drive-root', path: 'other/child' } as GatewayToolInput,
      {
        agentId: 'owner_console',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
        agentContext: {
          source: 'telegram',
          platform: 'telegram',
          roleName: 'owner_console',
          role: { allowedTools: ['drive_find_folder'] },
          session: {
            sessionId: 'session-drive-denied',
            channelId: 'tg:OWN',
            startedAt: new Date(),
          },
          capabilities: [],
          limitations: [],
        },
      }
    );

    expect(result).toMatchObject({ success: false, code: 'destination_out_of_scope' });
    expect(result).not.toHaveProperty('destinationCapability');
  });

  it('rejects mama_search requested scopes outside the envelope before calling MAMA API', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_search_scope',
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      {
        query: 'contracts',
        scopes: [{ kind: 'project', id: 'beta' }],
      } as GatewayToolInput,
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
      code: 'memory_scope_out_of_scope',
    });
    expect(result).not.toHaveProperty('envelope_hash');
    expect(mamaApi.suggest).not.toHaveBeenCalled();
  });

  it('defaults mama_search query scopes to the active envelope scopes', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelopeScopes = [{ kind: 'project' as const, id: 'alpha' }];
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: envelopeScopes,
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { query: 'contracts' } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.suggest).toHaveBeenCalledWith(
      'contracts',
      expect.objectContaining({ scopes: envelopeScopes })
    );
  });

  it('defaults empty mama_search query scopes to the active envelope scopes', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelopeScopes = [{ kind: 'project' as const, id: 'alpha' }];
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: envelopeScopes,
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { query: 'contracts', scopes: [] } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.suggest).toHaveBeenCalledWith(
      'contracts',
      expect.objectContaining({ scopes: envelopeScopes })
    );
  });

  it('defaults mama_search recent-list scopes to the active envelope scopes', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelopeScopes = [{ kind: 'project' as const, id: 'alpha' }];
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: envelopeScopes,
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute('mama_search', { limit: 3 } as GatewayToolInput, {
      agentId: 'worker',
      source: 'telegram',
      channelId: 'tg:OWN',
      envelope,
      executionSurface: 'model_tool',
    });

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.listDecisions).toHaveBeenCalledWith({ limit: 3, scopes: envelopeScopes });
  });

  it('defaults empty mama_search recent-list scopes to the active envelope scopes', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelopeScopes = [{ kind: 'project' as const, id: 'alpha' }];
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: envelopeScopes,
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { limit: 3, scopes: [] } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.listDecisions).toHaveBeenCalledWith({ limit: 3, scopes: envelopeScopes });
  });

  it('rejects mama_search without scopes when the active envelope has no memory scopes', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_empty_memory_scopes',
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: [],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      { query: 'contracts' } as GatewayToolInput,
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
      code: 'memory_scope_out_of_scope',
    });
    expect(result).not.toHaveProperty('envelope_hash');
    expect(mamaApi.suggest).not.toHaveBeenCalled();
  });

  it('passes envelope-defaulted mama_recall scopes to recallMemory without active-context widening', async () => {
    const previousWorkspace = process.env.MAMA_WORKSPACE;
    process.env.MAMA_WORKSPACE = '/derived/workspace';
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelopeScopes = [{ kind: 'project' as const, id: 'alpha' }];
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: envelopeScopes,
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    try {
      const result = await executor.execute(
        'mama_recall',
        { query: 'contracts' } as GatewayToolInput,
        {
          agentId: 'worker',
          source: 'telegram',
          channelId: 'tg:OWN',
          envelope,
          executionSurface: 'model_tool',
          agentContext: {
            source: 'telegram',
            platform: 'telegram',
            roleName: 'memory_agent',
            role: { allowedTools: ['mama_*'] },
            session: {
              sessionId: 'session-recall-scope',
              channelId: 'tg:OWN',
              userId: 'user-1',
              startedAt: new Date(),
            },
            capabilities: [],
            limitations: [],
          },
        }
      );

      expect(result).toMatchObject({ success: true });
      expect(mamaApi.recallMemory).toHaveBeenCalledWith(
        'contracts',
        expect.objectContaining({ scopes: envelopeScopes, includeProfile: true })
      );
    } finally {
      if (previousWorkspace === undefined) {
        delete process.env.MAMA_WORKSPACE;
      } else {
        process.env.MAMA_WORKSPACE = previousWorkspace;
      }
    }
  });

  it('rejects mama_load_checkpoint under a scoped envelope', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelope = makeEnvelope({
      envelope_hash: 'envhash_checkpoint_scope',
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute('mama_load_checkpoint', {} as GatewayToolInput, {
      agentId: 'worker',
      source: 'telegram',
      channelId: 'tg:OWN',
      envelope,
      executionSurface: 'model_tool',
    });

    expect(result).toMatchObject({
      success: false,
      code: 'scoped_checkpoint_unsupported',
    });
    expect(result).not.toHaveProperty('envelope_hash');
    expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
  });

  it('checks role permission before envelope scope membership for mama_search', async () => {
    const mamaApi = makeMAMAApi();
    const executor = new GatewayToolExecutor({ mamaApi });
    const envelope = makeEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: 'alpha' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: 'alpha' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
      },
    });

    const result = await executor.execute(
      'mama_search',
      {
        query: 'contracts',
        scopes: [{ kind: 'project', id: 'beta' }],
      } as GatewayToolInput,
      {
        agentId: 'worker',
        source: 'telegram',
        channelId: 'tg:OWN',
        envelope,
        executionSurface: 'model_tool',
        agentContext: {
          source: 'telegram',
          platform: 'telegram',
          roleName: 'read_only_without_mama',
          role: { allowedTools: ['Read'] },
          session: {
            sessionId: 'session-permission-first',
            channelId: 'tg:OWN',
            startedAt: new Date(),
          },
        },
      }
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Permission denied'),
    });
    expect(result).not.toMatchObject({ code: 'memory_scope_out_of_scope' });
    expect(mamaApi.suggest).not.toHaveBeenCalled();
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
    });
    expect(result).not.toHaveProperty('envelope_hash');
    expect(result.error).toContain('tier_violation');
    expect(mamaApi.save).not.toHaveBeenCalled();
  });
});
