import { describe, expect, it, vi } from 'vitest';

import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolInput, MAMAApiInterface } from '../../src/agent/types.js';
import {
  buildConnectorEventIngressPreview,
  resolveConnectorEventIngressConfig,
} from '../../src/operator-vnext/connector-event-ingress.js';
import { buildConnectorIngressMigrationDryRun } from '../../src/operator-vnext/connector-ingress-migration-dry-run.js';
import { resolveCommitAuthority } from '../../src/operator-vnext/commit-authority.js';
import { recordNoUpdate } from '../../src/operator-vnext/no-update-ledger.js';
import {
  buildVNextBootstrapPlan,
  shouldSkipVNextFanout,
} from '../../src/runtime-vnext/bootstrap.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import { countRows, makeOperatorVNextDb } from '../operator-vnext/fixtures.js';

function insertConnectorEvent(db: SQLiteDatabase): void {
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'event-index-1',
    'slack',
    'message',
    'msg-1',
    'slack:C-ROLL:msg-1',
    'C-ROLL',
    'synthetic-user',
    null,
    'synthetic rollout event',
    1710000001000,
    '2024-03-09',
    1710000001000,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 1),
    '2026-07-02T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  );
}

function makeTraceCapableMockApi(): MAMAApiInterface {
  const api = {
    save: vi.fn(),
    saveCheckpoint: vi.fn(),
    listDecisions: vi.fn(),
    suggest: vi.fn(),
    updateOutcome: vi.fn(),
    loadCheckpoint: vi.fn(),
    beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'model-run-vnext-test' }),
    commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'model-run-vnext-test' }),
    failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'model-run-vnext-test' }),
    appendToolTrace: vi.fn().mockResolvedValue({}),
  };
  return api as unknown as MAMAApiInterface;
}

describe('STORY-VNEXT-PR0: Architecture invariants', () => {
  it('keeps vNext startup allowlist-driven and legacy fanout-free', () => {
    const plan = buildVNextBootstrapPlan({
      enabled: true,
      mode: 'bootstrap',
      source: 'env',
    });

    expect(plan.allowedStartupSteps).toEqual([
      'config_read',
      'db_initialization',
      'primary_operator_schema',
      'primary_operator_runtime',
      'api_server_health',
      'manual_status_endpoints',
    ]);

    for (const fanout of [
      'dashboard_agent_interval',
      'wiki_agent_interval',
      'ledger_memory_compose',
      'obsidian_launch',
      'mcp_config_rewrite',
      'agent_config_mutation',
      'persona_write',
      'heartbeat_timer',
      'token_keepalive_timer',
      'conductor_audit',
      'message_router_autonomous_process',
      'connector_polling',
      'connector_mode',
    ] as const) {
      expect(shouldSkipVNextFanout(plan, fanout)).toBe(true);
    }
  });

  it('keeps explicit connector ingress previews dry-run only, not legacy polling', () => {
    const plan = buildVNextBootstrapPlan({
      enabled: true,
      mode: 'bootstrap',
      source: 'env',
    });
    const ingressConfig = resolveConnectorEventIngressConfig({
      MAMA_VNEXT_INGRESS_CONNECTOR: 'slack',
      MAMA_VNEXT_INGRESS_CHANNEL: 'C-ROLL',
    });
    const db = makeOperatorVNextDb();
    insertConnectorEvent(db);

    try {
      expect(ingressConfig).toEqual({
        enabled: true,
        connector: 'slack',
        channel: 'C-ROLL',
      });
      expect(shouldSkipVNextFanout(plan, 'connector_polling')).toBe(true);
      expect(shouldSkipVNextFanout(plan, 'connector_mode')).toBe(true);

      const preview = buildConnectorEventIngressPreview({
        rawAdapter: db,
        operatorDb: db,
        connector: 'slack',
        channel: 'C-ROLL',
      });
      expect(preview.events).toHaveLength(1);
      expect(preview.events[0]?.sourceRef).toMatchObject({
        kind: 'raw',
        connector: 'slack',
        id: 'event-index-1',
        source_id: 'msg-1',
        channel_id: 'C-ROLL',
      });

      const dryRun = buildConnectorIngressMigrationDryRun({
        rawAdapter: db,
        operatorDb: db,
        connector: 'slack',
        channel: 'C-ROLL',
      });
      expect(dryRun).toMatchObject({
        mode: 'dry_run',
        durableWrites: {
          commits: 0,
          cursors: 0,
          noUpdates: 0,
        },
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'vnext_operator_cursors')).toBe(0);
      expect(countRows(db, 'operator_no_updates')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('requires non-empty source ref metadata before durable vNext wiki and no-update writes', () => {
    const db = makeOperatorVNextDb();
    const wikiStore = new WikiArtifactStore(db);
    wikiStore.ensureSchema();
    const wikiPublisher = createWikiPublishAdapter({ mode: 'vnext', store: wikiStore });

    try {
      expect(() =>
        wikiPublisher.publish({
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'source-linked wiki page',
            },
          ],
        })
      ).toThrow(/source refs/i);

      expect(() =>
        recordNoUpdate(db, {
          noUpdateId: 'no-update-without-source',
          scopeKey: 'operator:primary',
          reason: 'no durable state changed',
          sourceRefs: [],
          idempotencyKey: 'connector:manual:seq:1-1',
          nowMs: 1710000000000,
        })
      ).toThrow(/source refs/i);

      expect(db.prepare('SELECT COUNT(*) AS count FROM wiki_artifacts').get()).toEqual({
        count: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM operator_no_updates').get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it('keeps workers as proposal producers while dashboard reports remain projections', () => {
    expect(
      resolveCommitAuthority({
        runtimeMode: 'vnext',
        toolName: 'report_publish',
        actor: { kind: 'primary_operator', agentId: 'operator:primary' },
      })
    ).toMatchObject({
      allowed: false,
      code: 'vnext_report_projection_only',
    });

    expect(
      resolveCommitAuthority({
        runtimeMode: 'vnext',
        toolName: 'wiki_publish',
        actor: { kind: 'worker', agentId: 'wiki-agent' },
      })
    ).toMatchObject({
      allowed: false,
      effect: 'proposal_required',
      code: 'vnext_worker_proposal_required',
    });

    expect(
      resolveCommitAuthority({
        runtimeMode: 'vnext',
        toolName: 'wiki_publish',
        actor: { kind: 'primary_operator', agentId: 'operator:primary' },
      })
    ).toMatchObject({
      allowed: true,
      effect: 'commit',
    });
  });

  it('prevents vNext wiki_publish from falling back to the legacy publisher at execution time', async () => {
    const legacyPublisher = vi.fn();
    const executor = new GatewayToolExecutor({
      mamaApi: makeTraceCapableMockApi(),
      vNextRuntimeEnabled: true,
    });
    executor.setWikiPublisher(legacyPublisher);

    await expect(
      executor.execute(
        'wiki_publish',
        {
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'legacy fallback should not receive this page',
            },
          ],
        } as GatewayToolInput,
        {
          agentId: 'operator:primary',
          source: 'viewer',
          channelId: 'default',
          executionSurface: 'direct',
        }
      )
    ).rejects.toThrow('vNext wiki_publish requires a vNext source-linked wiki artifact adapter');
    expect(legacyPublisher).not.toHaveBeenCalled();
  });

  it('allows primary operator vNext wiki_publish through a source-linked artifact adapter', async () => {
    const db = makeOperatorVNextDb();
    const wikiStore = new WikiArtifactStore(db);
    const vaultPublisher = vi.fn();
    const executor = new GatewayToolExecutor({
      mamaApi: makeTraceCapableMockApi(),
      vNextRuntimeEnabled: true,
      wikiPublishAdapter: createWikiPublishAdapter({
        mode: 'vnext',
        store: wikiStore,
        publisher: vaultPublisher,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        nowMs: () => 1710000002000,
      }),
    });

    try {
      const result = await executor.execute(
        'wiki_publish',
        {
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'source-linked vNext artifact',
              sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-vnext-publish' }],
            },
          ],
        } as GatewayToolInput,
        {
          agentId: 'operator:primary',
          source: 'viewer',
          channelId: 'default',
          executionSurface: 'direct',
        }
      );

      expect(result).toMatchObject({
        success: true,
        message: 'Wiki published: 1 pages',
        artifactsStored: 1,
      });
      expect(wikiStore.getByPath('projects/mama.md')).toMatchObject({
        path: 'projects/mama.md',
        sourceRefs: ['raw:slack:event-vnext-publish'],
      });
      expect(vaultPublisher).toHaveBeenCalledWith([
        expect.objectContaining({
          path: 'projects/mama.md',
          sourceRefs: ['raw:slack:event-vnext-publish'],
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects structurally compatible legacy wiki adapters in vNext executors', async () => {
    const legacyPublisher = vi.fn();
    const executor = new GatewayToolExecutor({
      mamaApi: makeTraceCapableMockApi(),
      vNextRuntimeEnabled: true,
      wikiPublishAdapter: createWikiPublishAdapter({
        mode: 'legacy',
        publisher: legacyPublisher,
      }),
    });

    await expect(
      executor.execute(
        'wiki_publish',
        {
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'legacy adapter should not receive this page',
            },
          ],
        } as GatewayToolInput,
        {
          agentId: 'operator:primary',
          source: 'viewer',
          channelId: 'default',
          executionSurface: 'direct',
        }
      )
    ).rejects.toThrow('vNext wiki_publish requires a vNext source-linked wiki artifact adapter');
    expect(legacyPublisher).not.toHaveBeenCalled();
  });
});
