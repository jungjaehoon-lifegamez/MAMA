import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';
import { applyMigrationsThrough } from '@jungjaehoon/mama-core/test-utils';

import {
  createVNextBootstrapApiServer,
  createVNextBootstrapPrimaryOperatorRuntime,
  createVNextPrimaryOperatorRuntime,
} from '../../src/cli/commands/start.js';
import {
  buildConnectorEventIngressPreview,
  createConnectorEventIngressPreviewProvider,
} from '../../src/operator-vnext/connector-event-ingress.js';
import { createConnectorIngressMigrationDryRunProvider } from '../../src/operator-vnext/connector-ingress-migration-dry-run.js';
import { ensureVNextOperatorSchema } from '../../src/operator-vnext/schema.js';
import {
  buildVNextBootstrapPlan,
  startVNextBootstrapRuntime,
  type VNextBootstrapRuntimeStatus,
} from '../../src/runtime-vnext/bootstrap.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { isVNextWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';

const AUTH_TOKEN_ENV = 'MAMA_AUTH_TOKEN';

function makeStatus(): VNextBootstrapRuntimeStatus {
  return {
    enabled: true,
    mode: 'bootstrap',
    source: 'env',
    startedAtMs: 1234,
    primaryOperator: {
      kind: 'primary_operator',
      status: 'prepared',
      mode: 'manual_batch',
      ingress: 'not_wired',
      cursorName: 'operator:primary',
      connector: 'manual',
      advancedThroughSeq: 0,
    },
    executedStartupSteps: [
      'config_read',
      'db_initialization',
      'primary_operator_schema',
      'primary_operator_runtime',
      'api_server_health',
      'manual_status_endpoints',
    ],
  };
}

function insertRawEvent(db: SQLiteDatabase, sourceId: string): string {
  const eventIndexId = connectorEventIndexId('slack', sourceId);
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    'slack',
    'message',
    sourceId,
    `slack:C-ROLL:${sourceId}`,
    'C-ROLL',
    'synthetic-user',
    null,
    `synthetic public rollout event ${sourceId}`,
    1710000001000,
    '2026-03-09',
    1710000001000,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 2),
    '2026-07-02T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  );
  return eventIndexId;
}

describe('STORY-VNEXT-PR1-BOOTSTRAP-API: vNext bootstrap API security', () => {
  const originalAuthToken = process.env[AUTH_TOKEN_ENV];

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env[AUTH_TOKEN_ENV];
    } else {
      process.env[AUTH_TOKEN_ENV] = originalAuthToken;
    }
  });

  describe('AC: vNext status endpoints keep public health separate from authenticated API', () => {
    it('keeps /health unauthenticated but protects /api status routes for tunneled requests', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus());

      const health = await request(apiServer.app)
        .get('/health')
        .set('cf-connecting-ip', '203.0.113.10');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'ok', runtime: 'vnext' });

      const unauthenticated = await request(apiServer.app)
        .get('/api/vnext/status')
        .set('cf-connecting-ip', '203.0.113.10');
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).toMatchObject({
        error: true,
        code: 'UNAUTHORIZED',
      });

      const authenticated = await request(apiServer.app)
        .get('/api/status')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');
      expect(authenticated.status).toBe(200);
      expect(authenticated.body).toMatchObject({
        ok: true,
        runtime: 'vnext',
        primary_operator: {
          kind: 'primary_operator',
          status: 'noop',
          reason: 'vNext primary operator runtime is exposed as primary_operator_runtime.',
        },
        primary_operator_runtime: {
          kind: 'primary_operator',
          status: 'prepared',
          mode: 'manual_batch',
          ingress: 'not_wired',
          cursor_name: 'operator:primary',
          connector: 'manual',
          advanced_through_seq: 0,
        },
      });
      expect(authenticated.body.primary_operator).not.toHaveProperty('cursorName');
      expect(authenticated.body.primary_operator).not.toHaveProperty('advancedThroughSeq');
      expect(authenticated.body.primary_operator_runtime).not.toHaveProperty('cursorName');
      expect(authenticated.body.primary_operator_runtime).not.toHaveProperty('advancedThroughSeq');
    });

    it('serves the Today dashboard from vNext projection slots in bootstrap mode', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const status = makeStatus();
      status.primaryOperator.advancedThroughSeq = 9;
      const apiServer = createVNextBootstrapApiServer(status);

      const response = await request(apiServer.app)
        .get('/api/report')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'vnext',
        projection: {
          projection_version: 1,
          status: {
            total: 1,
            live: 1,
            issueCount: 0,
          },
        },
      });
      expect(response.body.projection.today[0]).toMatchObject({
        situation_id: 'vnext_primary_operator',
        freshness: 'live',
        verification_state: 'verified',
        evidence_count: 1,
        evidence_refs: [],
        owner_hint: null,
      });
      expect(response.body.projection.today[0].evidence_refs).not.toContain('operator:primary:9');
      expect(response.body.slots.map((slot: { slotId: string }) => slot.slotId)).toEqual([
        'briefing',
        'vnext-status',
        'vnext-today',
        'vnext-evidence',
      ]);
    });

    it('creates a primary operator runtime bound to the manual cursor', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('operator:primary', 5, null, 1710000000000);

      const primaryOperator = createVNextPrimaryOperatorRuntime(db);
      const runtimeStatus = makeStatus();
      runtimeStatus.primaryOperator = primaryOperator.status;
      const apiServer = createVNextBootstrapApiServer(runtimeStatus);

      expect(primaryOperator.status).toEqual({
        kind: 'primary_operator',
        status: 'prepared',
        mode: 'manual_batch',
        ingress: 'not_wired',
        cursorName: 'operator:primary',
        connector: 'manual',
        advancedThroughSeq: 5,
      });

      const result = await primaryOperator.processBatch(
        [{ seq: 6, sourceRef: { kind: 'raw', connector: 'manual', id: 'event-6' } }],
        () => ({
          status: 'no_update',
          reason: 'manual event did not change canonical state',
          scopeKey: 'operator:primary',
        })
      );

      expect(result).toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 6,
      });
      expect(primaryOperator.status.advancedThroughSeq).toBe(6);
      expect(
        db
          .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
          .get('operator:primary')
      ).toEqual({ last_change_seq: 6 });

      const statusResponse = await request(apiServer.app)
        .get('/api/vnext/status')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.primary_operator_runtime).toMatchObject({
        cursor_name: 'operator:primary',
        advanced_through_seq: 6,
      });

      db.close();
    });

    it('wires source-linked wiki publishing into the bootstrap primary operator runtime', () => {
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);

      try {
        const primaryOperator = createVNextBootstrapPrimaryOperatorRuntime(db, {
          enabled: true,
        });

        expect(isVNextWikiPublishAdapter(primaryOperator.wikiPublishAdapter)).toBe(true);
        const result = primaryOperator.wikiPublishAdapter?.publish({
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'bootstrap source-linked runtime artifact',
              sourceRefs: [{ kind: 'raw', connector: 'manual', id: 'event-bootstrap-wiki' }],
            },
          ],
        });

        expect(result).toEqual({ pagesPublished: 0, artifactsStored: 1 });
        expect(db.prepare('SELECT path, source_refs_json FROM wiki_artifacts').get()).toEqual({
          path: 'projects/mama.md',
          source_refs_json: JSON.stringify(['raw:manual:event-bootstrap-wiki']),
        });
      } finally {
        db.close();
      }
    });

    it('prepares the source-linked wiki adapter through the bootstrap startup runner', async () => {
      const db = new Database(':memory:');
      const plan = buildVNextBootstrapPlan({
        enabled: true,
        mode: 'bootstrap',
        source: 'env',
      });
      const apiServer = {
        start: async () => {},
        stop: async () => {},
      };

      try {
        const handles = await startVNextBootstrapRuntime(plan, {
          openDatabase: () => db,
          initializeOperatorSchema: ensureVNextOperatorSchema,
          createPrimaryOperator: (database) =>
            createVNextBootstrapPrimaryOperatorRuntime(database, plan),
          createApiServer: () => apiServer,
        });

        expect(handles.primaryOperator.wikiPublishAdapter).toBeDefined();
        expect(isVNextWikiPublishAdapter(handles.primaryOperator.wikiPublishAdapter)).toBe(true);
        expect(handles.status.primaryOperator).toEqual(handles.primaryOperator.status);
      } finally {
        db.close();
      }
    });

    it('marks primary operator runtime degraded after a failed batch', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      ensureVNextOperatorSchema(db);
      const primaryOperator = createVNextPrimaryOperatorRuntime(db);
      const runtimeStatus = makeStatus();
      runtimeStatus.primaryOperator = primaryOperator.status;
      const apiServer = createVNextBootstrapApiServer(runtimeStatus);

      const result = await primaryOperator.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        () => ({
          status: 'no_update',
          reason: 'should not run',
          scopeKey: 'operator:primary',
        })
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        failedSeq: 1,
      });
      expect(primaryOperator.status).toMatchObject({
        status: 'degraded',
        lastBatchStatus: 'partial_failure',
        failedSeq: 1,
      });

      const idleResult = await primaryOperator.processBatch([], () => ({
        status: 'no_update',
        reason: 'idle batches do not resolve failures',
      }));
      expect(idleResult).toMatchObject({
        status: 'idle',
        advancedThroughSeq: 0,
      });
      expect(primaryOperator.status).toMatchObject({
        status: 'degraded',
        lastBatchStatus: 'idle',
        failedSeq: 1,
      });

      const statusResponse = await request(apiServer.app)
        .get('/api/vnext/status')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.primary_operator_runtime).toMatchObject({
        status: 'degraded',
        last_batch_status: 'idle',
        failed_seq: 1,
      });

      db.close();
    });

    it('serves authenticated dry-run connector ingress previews without committing', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 38);
      const eventIndexId = insertRawEvent(db, 'msg-1');
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressPreviewProvider: (input) =>
          buildConnectorEventIngressPreview({
            rawAdapter: db,
            operatorDb: db,
            ...input,
          }),
      });

      const response = await request(apiServer.app)
        .get('/api/vnext/ingress/preview?connector=slack&channel=C-ROLL&limit=5')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        mode: 'dry_run',
        preview: {
          cursorName: 'connector:slack:channel:C-ROLL',
          connector: 'slack',
          channel: 'C-ROLL',
          advancedThroughSeq: 0,
          events: [
            {
              seq: 1,
              sourceRef: {
                kind: 'raw',
                connector: 'slack',
                id: eventIndexId,
                source_id: 'msg-1',
                channel_id: 'C-ROLL',
              },
              eventIndexId,
              sourceTimestampMs: 1710000001000,
              sourceId: 'msg-1',
              channel: 'C-ROLL',
            },
          ],
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('rejects connector ingress preview when the provider is not configured', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus());

      const response = await request(apiServer.app)
        .get('/api/vnext/ingress/preview?connector=slack&channel=C-ROLL')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_preview_unavailable',
      });
    });

    it('returns 400 for connector ingress preview requests outside the configured channel', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressPreviewProvider: createConnectorEventIngressPreviewProvider({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C-ROLL',
        }),
      });

      const response = await request(apiServer.app)
        .get('/api/vnext/ingress/preview?connector=slack&channel=C-OTHER')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_preview_invalid_request',
      });

      db.close();
    });

    it('serves authenticated connector ingress migration dry-run reports without committing', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 38);
      const eventIndexId = insertRawEvent(db, 'msg-1');
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressMigrationDryRunProvider: createConnectorIngressMigrationDryRunProvider({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C-ROLL',
        }),
      });

      const response = await request(apiServer.app)
        .get('/api/vnext/ingress/migration-dry-run?connector=slack&channel=C-ROLL&limit=5')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        mode: 'dry_run',
        dry_run: {
          mode: 'dry_run',
          status: 'ready',
          cursorName: 'connector:slack:channel:C-ROLL',
          connector: 'slack',
          channel: 'C-ROLL',
          advancedThroughSeq: 0,
          candidateCount: 1,
          highestCandidateSeq: 1,
          requiresOperatorDecision: true,
          durableWrites: {
            commits: 0,
            cursors: 0,
            noUpdates: 0,
          },
          candidates: [
            {
              seq: 1,
              eventIndexId,
              sourceRef: {
                kind: 'raw',
                connector: 'slack',
                id: eventIndexId,
                source_id: 'msg-1',
                channel_id: 'C-ROLL',
              },
              readiness: 'requires_decision',
            },
          ],
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_cursors').get()).toEqual({
        count: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM operator_no_updates').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('returns 400 for non-positive or fractional migration dry-run limits', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressMigrationDryRunProvider: createConnectorIngressMigrationDryRunProvider({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C-ROLL',
        }),
      });

      for (const limit of ['0', '-1', '0.5']) {
        const response = await request(apiServer.app)
          .get(`/api/vnext/ingress/migration-dry-run?connector=slack&channel=C-ROLL&limit=${limit}`)
          .set('cf-connecting-ip', '203.0.113.10')
          .set('authorization', 'Bearer vnext-status-token');

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          ok: false,
          code: 'vnext_ingress_migration_dry_run_invalid_request',
          error: 'limit must be a positive integer',
        });
      }

      db.close();
    });
  });
});
