import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type {
  AgentContext,
  GatewayToolInput,
  GatewayToolResult,
  MAMAApiInterface,
} from '../../src/agent/types.js';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import type { MetricsStore, MetricRecord } from '../../src/observability/metrics-store.js';
import { makeSignedEnvelope } from './fixtures.js';

const { securityWarnMock } = vi.hoisted(() => ({
  securityWarnMock: vi.fn(),
}));

vi.mock('@jungjaehoon/mama-core/debug-logger', () => ({
  DebugLogger: vi.fn().mockImplementation(() => ({
    warn: securityWarnMock,
  })),
}));

type AuditRow = {
  id: number;
  type: string;
  input_summary: string | null;
  execution_status: string | null;
  envelope_hash: string | null;
  requested_scopes: string | null;
  envelope_scopes_snapshot: string | null;
  scope_mismatch: number;
};

type MetricsStoreMock = Pick<MetricsStore, 'record'> & {
  record: ReturnType<typeof vi.fn<[MetricRecord], void>>;
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

function createMetricsStore(): MetricsStoreMock {
  return {
    record: vi.fn(),
  } as MetricsStoreMock;
}

function createTelegramContext(channelId = 'abc', allowedPaths?: string[]): AgentContext {
  return {
    source: 'telegram',
    platform: 'telegram',
    roleName: 'chat_bot',
    role: {
      allowedTools: ['*'],
      systemControl: false,
      sensitiveAccess: false,
      allowedPaths,
    },
    session: {
      sessionId: `telegram:${channelId}`,
      channelId,
      userId: 'user-1',
      startedAt: new Date(),
    },
    capabilities: ['*'],
    limitations: [],
    tier: 2,
    backend: 'claude',
  };
}

function readGatewayToolRows(db: Database): AuditRow[] {
  return db
    .prepare(
      `SELECT id, type, input_summary, execution_status, envelope_hash,
              requested_scopes, envelope_scopes_snapshot, scope_mismatch
       FROM agent_activity
       WHERE type = 'gateway_tool_call'
       ORDER BY id ASC`
    )
    .all() as AuditRow[];
}

function parseScopes(value: string | null): Array<{ kind: string; id: string }> {
  return value ? (JSON.parse(value) as Array<{ kind: string; id: string }>) : [];
}

function createExecutorHarness(options?: {
  mamaApi?: MAMAApiInterface;
  metricsStore?: MetricsStoreMock;
  envelopeIssuanceMode?: 'off' | 'enabled' | 'required';
}): {
  db: Database;
  executor: GatewayToolExecutor;
  mamaApi: MAMAApiInterface;
  metricsStore: MetricsStoreMock;
} {
  const db = new Database(':memory:');
  initAgentTables(db);
  const mamaApi = options?.mamaApi ?? createMAMAApi();
  const metricsStore = options?.metricsStore ?? createMetricsStore();
  const executor = new GatewayToolExecutor({
    mamaApi,
    metricsStore: metricsStore as unknown as MetricsStore,
    envelopeIssuanceMode: options?.envelopeIssuanceMode ?? 'enabled',
  });
  executor.setSessionsDb(db);
  return { db, executor, mamaApi, metricsStore };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('Story M1R: memory scope mismatch audit logging', () => {
  let previousWorkspace: string | undefined;
  let previousHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    previousWorkspace = process.env.MAMA_WORKSPACE;
    previousHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'mama-scope-audit-'));
    process.env.MAMA_WORKSPACE = join(tempDir, 'workspace');
    process.env.HOME = tempDir;
    mkdirSync(process.env.MAMA_WORKSPACE, { recursive: true });
    securityWarnMock.mockClear();
  });

  afterEach(() => {
    if (previousWorkspace === undefined) {
      delete process.env.MAMA_WORKSPACE;
    } else {
      process.env.MAMA_WORKSPACE = previousWorkspace;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records in-scope mama_save writes without mismatch alarms', async () => {
    const { db, executor, mamaApi, metricsStore } = createExecutorHarness();
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
      },
    });

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'scope',
        decision: 'in scope',
        reasoning: 'uses the channel scope',
        scopes: [{ kind: 'channel', id: 'telegram:abc' }],
      },
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.save).toHaveBeenCalledOnce();
    const [row] = readGatewayToolRows(db);
    expect(row).toMatchObject({
      input_summary: 'mama_save',
      envelope_hash: envelope.envelope_hash,
      scope_mismatch: 0,
      execution_status: 'completed',
    });
    expect(metricsStore.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'envelope_scope_mismatch' })
    );
    expect(securityWarnMock).not.toHaveBeenCalled();
    db.close();
  });

  it('logs out-of-scope mama_save writes but still allows the write to proceed', async () => {
    const { db, executor, mamaApi, metricsStore } = createExecutorHarness();
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
      },
    });

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'scope',
        decision: 'out-of-scope decision payload secret',
        reasoning: 'uses global system scope',
        scopes: [{ kind: 'global', id: 'system' }],
      },
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.save).toHaveBeenCalledOnce();
    const [row] = readGatewayToolRows(db);
    expect(row.scope_mismatch).toBe(1);
    expect(parseScopes(row.requested_scopes)).toEqual([{ kind: 'global', id: 'system' }]);
    expect(parseScopes(row.envelope_scopes_snapshot)).toEqual([
      { kind: 'channel', id: 'telegram:abc' },
    ]);
    expect(metricsStore.record).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'envelope_scope_mismatch',
        value: 1,
        labels: expect.objectContaining({
          source: 'telegram',
          channel_id: 'abc',
          tool: 'mama_save',
        }),
      })
    );
    expect(securityWarnMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(securityWarnMock.mock.calls)).not.toContain(
      'out-of-scope decision payload secret'
    );
    db.close();
  });

  it('treats omitted memory scopes as forensic mismatch without injecting synthetic scopes', async () => {
    const { db, executor, mamaApi } = createExecutorHarness();
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      scope: {
        project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
      },
    });

    const result = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'scope',
        decision: 'omitted scopes',
        reasoning: 'keeps existing save semantics',
      },
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      }
    );

    expect(result).toMatchObject({ success: true });
    expect(mamaApi.save).toHaveBeenCalledWith(
      expect.not.objectContaining({
        scopes: expect.any(Array),
      })
    );
    const [row] = readGatewayToolRows(db);
    expect(row.scope_mismatch).toBe(1);
    expect(parseScopes(row.requested_scopes)).toEqual([]);
    expect(parseScopes(row.envelope_scopes_snapshot)).toEqual([
      { kind: 'channel', id: 'telegram:abc' },
    ]);
    db.close();
  });

  it('covers each memory-mutating tool and uses effective scopes for derived ingest paths', async () => {
    const cases: Array<{
      toolName: 'mama_save' | 'mama_update' | 'mama_add' | 'mama_ingest';
      input: GatewayToolInput;
      assertWrite: (api: MAMAApiInterface) => void;
      expectedRequestedScope?: { kind: string; id: string };
    }> = [
      {
        toolName: 'mama_save',
        input: {
          type: 'decision',
          topic: 'scope',
          decision: 'save out-of-scope',
          reasoning: 'global scope request',
          scopes: [{ kind: 'global', id: 'system' }],
        },
        assertWrite: (api) => expect(api.save).toHaveBeenCalledOnce(),
        expectedRequestedScope: { kind: 'global', id: 'system' },
      },
      {
        toolName: 'mama_update',
        input: {
          id: 'decision_1',
          outcome: 'success',
        } as unknown as GatewayToolInput,
        assertWrite: (api) => expect(api.updateOutcome).toHaveBeenCalledOnce(),
      },
      {
        toolName: 'mama_add',
        input: { content: 'remember this from the telegram channel' },
        assertWrite: (api) => expect(api.ingestMemory).toHaveBeenCalledOnce(),
        expectedRequestedScope: { kind: 'channel', id: 'telegram:abc' },
      },
      {
        toolName: 'mama_ingest',
        input: {
          content: 'remember this direct ingest',
          scopes: [{ kind: 'global', id: 'system' }],
        },
        assertWrite: (api) => expect(api.ingestMemory).toHaveBeenCalledOnce(),
        expectedRequestedScope: { kind: 'channel', id: 'telegram:abc' },
      },
    ];

    for (const item of cases) {
      const { db, executor, mamaApi, metricsStore } = createExecutorHarness();
      const envelope = makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'abc',
        scope: {
          project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'channel', id: 'telegram:other' }],
          allowed_destinations: [{ kind: 'telegram', id: 'abc' }],
        },
      });

      const result = await executor.execute(item.toolName, item.input, {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      });

      expect(result).toMatchObject({ success: true });
      item.assertWrite(mamaApi);
      const [row] = readGatewayToolRows(db);
      expect(row).toMatchObject({
        input_summary: item.toolName,
        scope_mismatch: 1,
        envelope_hash: envelope.envelope_hash,
      });
      if (item.expectedRequestedScope) {
        expect(parseScopes(row.requested_scopes)).toContainEqual(item.expectedRequestedScope);
      } else {
        expect(parseScopes(row.requested_scopes)).toEqual([]);
      }
      expect(metricsStore.record).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'envelope_scope_mismatch' })
      );
      db.close();
    }
  });

  it('audits report_publish autosave through the same gateway envelope context', async () => {
    const { db, executor, metricsStore } = createExecutorHarness();
    executor.setReportPublisher(vi.fn());
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      tier: 2,
      scope: {
        project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'dashboard_slot', id: 'daily' }],
      },
    });

    const result = await executor.execute(
      'report_publish',
      { slots: { daily: '<h1>Daily</h1>' } } as unknown as GatewayToolInput,
      {
        agentId: 'dashboard',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      }
    );
    await flushMicrotasks();

    expect(result).toEqual({
      success: true,
      message: 'Dashboard updated: daily (1 slots)',
    });
    const rows = readGatewayToolRows(db);
    expect(rows.map((row) => row.input_summary)).toEqual(['report_publish', 'mama_save']);
    expect(new Set(rows.map((row) => row.envelope_hash))).toEqual(
      new Set([envelope.envelope_hash])
    );
    const autosave = rows.find((row) => row.input_summary === 'mama_save');
    expect(autosave).toMatchObject({ scope_mismatch: 1 });
    expect(parseScopes(autosave!.requested_scopes)).toEqual([{ kind: 'global', id: 'system' }]);
    expect(metricsStore.record).toHaveBeenCalledTimes(1);
    expect(securityWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('scope mismatch'),
      expect.objectContaining({ parent: 'report_publish' })
    );
    db.close();
  });

  it('audits wiki_publish autosave through the same gateway envelope context', async () => {
    const { db, executor, metricsStore } = createExecutorHarness();
    executor.setWikiPublisher(vi.fn());
    const envelope = makeSignedEnvelope({
      source: 'telegram',
      channel_id: 'abc',
      tier: 2,
      scope: {
        project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
        allowed_destinations: [{ kind: 'dashboard_slot', id: 'wiki' }],
      },
    });

    const result = await executor.execute(
      'wiki_publish',
      {
        pages: [{ path: '/wiki/a.md', title: 'A', type: 'entity', content: 'A page' }],
      } as unknown as GatewayToolInput,
      {
        agentId: 'wiki',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      }
    );
    await flushMicrotasks();

    expect(result).toEqual({
      success: true,
      message: 'Wiki published: 1 pages',
    });
    const rows = readGatewayToolRows(db);
    expect(rows.map((row) => row.input_summary)).toEqual(['wiki_publish', 'mama_save']);
    expect(new Set(rows.map((row) => row.envelope_hash))).toEqual(
      new Set([envelope.envelope_hash])
    );
    const autosave = rows.find((row) => row.input_summary === 'mama_save');
    expect(autosave).toMatchObject({ scope_mismatch: 1 });
    expect(parseScopes(autosave!.requested_scopes)).toEqual([{ kind: 'global', id: 'system' }]);
    expect(metricsStore.record).toHaveBeenCalledTimes(1);
    expect(securityWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('scope mismatch'),
      expect.objectContaining({ parent: 'wiki_publish' })
    );
    db.close();
  });

  it('off issuance mode allows reactive contexts without an envelope for save/search/read', async () => {
    const { db, executor, mamaApi } = createExecutorHarness({ envelopeIssuanceMode: 'off' });
    const readPath = join(tempDir, 'readable.txt');
    writeFileSync(readPath, 'visible');
    const agentContext = createTelegramContext('abc', [join(tempDir, '**')]);

    const saveResult = await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'off-mode',
        decision: 'save works',
        reasoning: 'issuance disabled',
      },
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext,
        executionSurface: 'model_tool',
      }
    );
    const searchResult = await executor.execute(
      'mama_search',
      { query: 'off-mode' },
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext,
        executionSurface: 'model_tool',
      }
    );
    const readResult = await executor.execute(
      'Read',
      { path: readPath } as unknown as GatewayToolInput,
      {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext,
        executionSurface: 'model_tool',
      }
    );

    expect(saveResult).toMatchObject({ success: true });
    expect(searchResult).toMatchObject({ success: true });
    expect(readResult).toMatchObject({ success: true, content: 'visible' });
    expect(JSON.stringify([saveResult, searchResult, readResult])).not.toContain(
      'envelope_missing'
    );
    expect(mamaApi.save).toHaveBeenCalledOnce();
    expect(mamaApi.suggest).toHaveBeenCalledOnce();
    db.close();
  });

  it('denies report_publish and wiki_publish under tier 3 with tier metadata after tool rename', async () => {
    const tools: Array<'report_publish' | 'wiki_publish'> = ['report_publish', 'wiki_publish'];

    for (const toolName of tools) {
      const { db, executor } = createExecutorHarness();
      executor.setReportPublisher(vi.fn());
      executor.setWikiPublisher(vi.fn());
      const envelope = makeSignedEnvelope({
        source: 'telegram',
        channel_id: 'abc',
        tier: 3,
        scope: {
          project_refs: [{ kind: 'project', id: process.env.MAMA_WORKSPACE! }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'channel', id: 'telegram:abc' }],
          allowed_destinations: [{ kind: 'dashboard_slot', id: 'blocked' }],
        },
      });
      const input =
        toolName === 'report_publish'
          ? ({ slots: { blocked: 'blocked' } } as unknown as GatewayToolInput)
          : ({
              pages: [{ path: '/wiki/a.md', title: 'A', type: 'entity', content: 'A page' }],
            } as unknown as GatewayToolInput);

      const result = (await executor.execute(toolName, input, {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'abc',
        agentContext: createTelegramContext(),
        envelope,
      })) as GatewayToolResult & {
        code?: string;
        tier_required?: number;
        allowed?: boolean;
      };

      expect(result).toMatchObject({
        success: false,
        code: 'tier_violation',
        tier_required: 2,
        allowed: false,
        envelope_hash: envelope.envelope_hash,
      });
      db.close();
    }
  });
});
