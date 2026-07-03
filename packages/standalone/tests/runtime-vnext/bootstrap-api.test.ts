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
import {
  commitConnectorIngressNoUpdateBatch,
  createConnectorIngressManualNoUpdateCommitProvider,
} from '../../src/operator-vnext/connector-ingress-manual-commit.js';
import {
  commitConnectorIngressMemoryBatch,
  createConnectorIngressManualMemoryCommitProvider,
} from '../../src/operator-vnext/connector-ingress-manual-memory-commit.js';
import { commitConnectorIngressWikiBatch } from '../../src/operator-vnext/connector-ingress-manual-wiki-commit.js';
import { createConnectorIngressMigrationDryRunProvider } from '../../src/operator-vnext/connector-ingress-migration-dry-run.js';
import { ensureVNextOperatorSchema } from '../../src/operator-vnext/schema.js';
import {
  buildVNextBootstrapPlan,
  startVNextBootstrapRuntime,
  type VNextBootstrapRuntimeStatus,
} from '../../src/runtime-vnext/bootstrap.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import {
  createWikiPublishAdapter,
  isVNextWikiPublishAdapter,
  MAX_WIKI_PAGE_CONTENT_CHARS,
} from '../../src/wiki-artifacts/wiki-publish-adapter.js';
import { resetSecurityMonitorForTests } from '../../src/security/security-monitor.js';

const AUTH_TOKEN_ENV = 'MAMA_AUTH_TOKEN';
const ADMIN_TOKEN_ENV = 'MAMA_ADMIN_TOKEN';
const LOCAL_PATH_PREFIX = ['', 'Users', ''].join('/');

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

function insertRawEvent(
  db: SQLiteDatabase,
  sourceId: string,
  options: { channel?: string; timestampMs?: number } = {}
): string {
  const channel = options.channel ?? 'C-ROLL';
  const timestampMs = options.timestampMs ?? 1710000001000;
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
    `slack:${channel}:${sourceId}`,
    channel,
    'synthetic-user',
    null,
    `synthetic public rollout event ${sourceId}`,
    timestampMs,
    new Date(timestampMs).toISOString().slice(0, 10),
    timestampMs,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 2),
    '2026-07-02T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z'
  );
  return eventIndexId;
}

function makeManualWikiPages(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    path: `projects/${prefix}-${index}.md`,
    title: `${prefix} ${index}`,
    type: 'entity',
    content: 'operator-authored wiki summary',
  }));
}

function makeManualMemory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: 'operator/manual-memory',
    kind: 'decision',
    summary: 'Manual reviewed memory should be committed.',
    details: 'The admin reviewed the connector event and approved this memory.',
    confidence: 0.82,
    scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
    ...overrides,
  };
}

function makeManualMemoryCommitBody(
  eventIndexId = 'synthetic-event-index-id',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    connector: 'slack',
    channel: 'C_PUBLIC_SYNTHETIC',
    expected_advanced_through_seq: 0,
    event_memories: [
      {
        event_index_id: eventIndexId,
        memories: [makeManualMemory()],
      },
    ],
    ...overrides,
  };
}

describe('STORY-VNEXT-PR1-BOOTSTRAP-API: vNext bootstrap API security', () => {
  const originalAuthToken = process.env[AUTH_TOKEN_ENV];
  const originalAdminToken = process.env[ADMIN_TOKEN_ENV];

  afterEach(() => {
    resetSecurityMonitorForTests();
    if (originalAuthToken === undefined) {
      delete process.env[AUTH_TOKEN_ENV];
    } else {
      process.env[AUTH_TOKEN_ENV] = originalAuthToken;
    }
    if (originalAdminToken === undefined) {
      delete process.env[ADMIN_TOKEN_ENV];
    } else {
      process.env[ADMIN_TOKEN_ENV] = originalAdminToken;
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
        errorMessage: 'Primary operator batch failed. Check local logs for details.',
      });
      expect(primaryOperator.status.errorMessage).not.toContain('slack');

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
        error_message: 'Primary operator batch failed. Check local logs for details.',
      });
      expect(statusResponse.body.primary_operator_runtime.error_message).not.toContain('slack');

      db.close();
    });

    it('serves authenticated dry-run connector ingress previews without committing', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
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
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
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

    it('requires admin auth for manual no-update ingress commits', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: (input) =>
          commitConnectorIngressNoUpdateBatch({
            rawAdapter: db,
            operatorDb: db,
            ...input,
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: [eventIndexId],
        });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: true,
        code: 'UNAUTHORIZED',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('fails closed when admin auth is not configured for manual no-update ingress commits', async () => {
      delete process.env[ADMIN_TOKEN_ENV];
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: () => {
          throw new Error('provider must not run without admin auth');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: ['synthetic-event-index-id'],
        });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: true,
        code: 'admin_token_required',
      });
    });

    it('requires admin auth before parsing malformed manual commit JSON bodies', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: () => {
          throw new Error('provider must not run for unauthorized malformed JSON');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('content-type', 'application/json')
        .send('{');

      expect(response.status).toBe(401);
      expect(response.type).toBe('application/json');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
    });

    it('sanitizes malformed manual commit JSON after admin auth succeeds', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: () => {
          throw new Error('provider must not run for malformed JSON');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .set('content-type', 'application/json')
        .send('{');

      expect(response.status).toBe(400);
      expect(response.type).toBe('application/json');
      expect(response.body).toEqual({
        ok: false,
        code: 'vnext_ingress_manual_commit_invalid_json',
        error: 'Invalid JSON request body.',
      });
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
    });

    it('serves admin-only manual no-update ingress commits with an allowlisted payload', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: (input) =>
          commitConnectorIngressNoUpdateBatch({
            rawAdapter: db,
            operatorDb: db,
            ...input,
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: [eventIndexId],
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        mode: 'manual_no_update_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 1,
        firstSeq: 1,
        lastSeq: 1,
        commits: [{ seq: 1, status: 'no_update', outcome: 'committed', cursorAdvanced: true }],
      });
      expect(JSON.stringify(response.body)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-user');
      expect(JSON.stringify(response.body)).not.toContain('author');
      expect(JSON.stringify(response.body)).not.toContain('title');
      expect(JSON.stringify(response.body)).not.toContain('metadata_json');
      expect(JSON.stringify(response.body)).not.toContain('source_locator');
      expect(JSON.stringify(response.body)).not.toContain('artifact_locator');
      expect(JSON.stringify(response.body)).not.toContain('source_cursor');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
      expect(db.prepare('SELECT DISTINCT status FROM vnext_operator_commits').all()).toEqual([
        { status: 'no_update' },
      ]);

      db.close();
    });

    it('serves admin-only manual wiki ingress commits with an allowlisted payload', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const store = new WikiArtifactStore(db);
      const wikiPublishAdapter = createWikiPublishAdapter({
        mode: 'vnext',
        store,
        now: () => new Date('2026-07-03T00:00:00.000Z'),
        nowMs: () => 1710000000000,
      });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: (input) =>
          commitConnectorIngressWikiBatch({
            rawAdapter: db,
            operatorDb: db,
            wikiPublishAdapter,
            ...input,
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: eventIndexId,
              pages: [
                {
                  path: 'projects/manual-wiki.md',
                  title: 'Manual Wiki',
                  type: 'entity',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        mode: 'manual_wiki_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 1,
        firstSeq: 1,
        lastSeq: 1,
        pagesStored: 1,
        commits: [{ seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
      });
      expect(JSON.stringify(response.body)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-user');
      expect(JSON.stringify(response.body)).not.toContain('metadata_json');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
      expect(store.getByPath('projects/manual-wiki.md')?.sourceRefs).toEqual([
        `raw:slack:${eventIndexId}`,
      ]);

      db.close();
    });

    it('serves admin-only manual memory ingress commits with an allowlisted payload', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 40);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: (input) =>
          commitConnectorIngressMemoryBatch({
            rawAdapter: db,
            operatorDb: db,
            ...input,
            saveMemory: async (_memory, options) => ({
              success: true,
              id: `memory-${String(options.provenance.gateway_call_id).split(':').pop()}`,
            }),
            createTrustedProvenanceCapability: () =>
              Object.freeze({
                __trustedProvenanceCapability: 'mama-core',
              }) as never,
            listMemoriesByGatewayCallId: async () => [],
            setMemoryStatus: async () => {},
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_memories: [
            {
              event_index_id: eventIndexId,
              memories: [
                {
                  topic: 'operator/manual-memory',
                  kind: 'decision',
                  summary: 'Manual reviewed memory should be committed.',
                  details: 'The admin reviewed the connector event and approved this memory.',
                  confidence: 0.82,
                  scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        mode: 'manual_memory_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 1,
        advancedThroughSeq: 1,
        firstSeq: 1,
        lastSeq: 1,
        memoriesSaved: 1,
        commits: [{ seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
      });
      expect(JSON.stringify(response.body)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-user');
      expect(JSON.stringify(response.body)).not.toContain('metadata_json');
      expect(JSON.stringify(response.body)).not.toContain('project_public_synthetic');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
      expect(db.prepare('SELECT changed_refs_json FROM vnext_operator_commits').get()).toEqual({
        changed_refs_json: JSON.stringify(['memory:memory-0']),
      });

      db.close();
    });

    it('requires admin auth for manual memory ingress commits', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run without admin auth');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token')
        .send(makeManualMemoryCommitBody());

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: true,
        code: 'UNAUTHORIZED',
      });
      expect(providerCalls).toBe(0);
    });

    it('fails closed when admin auth is not configured for manual memory ingress commits', async () => {
      delete process.env[ADMIN_TOKEN_ENV];
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run without admin auth');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .send(makeManualMemoryCommitBody());

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: true,
        code: 'admin_token_required',
      });
      expect(providerCalls).toBe(0);
    });

    it('returns unavailable when manual memory ingress commits are not configured', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus());

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(makeManualMemoryCommitBody());

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_unavailable',
        error: 'vNext manual memory ingress commit is not configured.',
      });
    });

    it('rejects manual memory ingress commits for the wrong configured channel', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 40);
      let saveCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: createConnectorIngressManualMemoryCommitProvider({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          saveMemory: async () => {
            saveCalls += 1;
            throw new Error('memory save must not run for wrong channel');
          },
          createTrustedProvenanceCapability: () =>
            Object.freeze({
              __trustedProvenanceCapability: 'mama-core',
            }) as never,
          listMemoriesByGatewayCallId: async () => [],
          setMemoryStatus: async () => {},
          nowMs: () => 1710000000000,
        }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(makeManualMemoryCommitBody('synthetic-event-index-id', { channel: 'C_OTHER' }));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(JSON.stringify(response.body)).not.toContain('C_PUBLIC_SYNTHETIC');
      expect(saveCalls).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('rejects manual memory API requests above the aggregate memory limit before provider execution', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when aggregate memories exceed the request limit');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(
          makeManualMemoryCommitBody('synthetic-event-index-id', {
            event_memories: [
              {
                event_index_id: 'synthetic-event-index-id',
                memories: Array.from({ length: 101 }, (_, index) =>
                  makeManualMemory({ topic: `operator/manual-memory-${index}` })
                ),
              },
            ],
          })
        );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(response.body.error).toMatch(/at most 100 total memories/i);
      expect(providerCalls).toBe(0);
    });

    it('sanitizes unexpected manual memory ingress commit failures', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          throw new Error('memory backend failed with synthetic-error-marker');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(makeManualMemoryCommitBody());

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_failed',
        error: 'vNext manual memory ingress commit failed.',
      });
      expect(JSON.stringify(response.body)).not.toContain('memory backend');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-error-marker');
    });

    it('allowlists provider-returned manual memory partial failures', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () =>
          ({
            ok: false,
            mode: 'manual_memory_commit',
            status: 'partial_failure',
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            requestedCount: 1,
            processed: 0,
            advancedThroughSeq: 0,
            firstSeq: 1,
            lastSeq: 1,
            memoriesSaved: 0,
            commits: [],
            failedSeq: 1,
            error: `${LOCAL_PATH_PREFIX}/private-memory.json raw synthetic public rollout event memory-private-id`,
            rawConnectorEvent: 'synthetic public rollout event msg-1',
            memoryIds: ['memory-private-id'],
            localPath: `${LOCAL_PATH_PREFIX}/private-memory.json`,
          }) as never,
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(makeManualMemoryCommitBody());

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        ok: false,
        mode: 'manual_memory_commit',
        status: 'partial_failure',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 1,
        processed: 0,
        advancedThroughSeq: 0,
        firstSeq: 1,
        lastSeq: 1,
        memoriesSaved: 0,
        commits: [],
        failedSeq: 1,
        error: 'Manual memory commit partially failed.',
      });
      expect(JSON.stringify(response.body)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(response.body)).not.toContain('memory-private-id');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);
    });

    it('accepts manual wiki content below the core wiki content limit through the API', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const validLargeContent = 'x'.repeat(MAX_WIKI_PAGE_CONTENT_CHARS - 1);
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: (input) => {
          providerCalls += 1;
          expect(input.eventPages[0]?.pages[0]?.content).toHaveLength(validLargeContent.length);
          return {
            ok: true,
            mode: 'manual_wiki_commit',
            status: 'committed',
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            requestedCount: 1,
            processed: 1,
            advancedThroughSeq: 1,
            firstSeq: 1,
            lastSeq: 1,
            pagesStored: 1,
            commits: [{ seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true }],
          };
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: 'synthetic-event-index-id',
              pages: [
                {
                  path: 'projects/manual-wiki.md',
                  title: 'Manual Wiki',
                  type: 'entity',
                  content: validLargeContent,
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        mode: 'manual_wiki_commit',
        pagesStored: 1,
      });
      expect(providerCalls).toBe(1);
    });

    it('accepts valid manual wiki payloads whose JSON encoding expands content bytes', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const validEscapedContent = '"'.repeat(MAX_WIKI_PAGE_CONTENT_CHARS);
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: (input) => {
          providerCalls += 1;
          expect(input.eventPages).toHaveLength(100);
          expect(input.eventPages[0]?.pages[0]?.content).toHaveLength(MAX_WIKI_PAGE_CONTENT_CHARS);
          return {
            ok: true,
            mode: 'manual_wiki_commit',
            status: 'committed',
            cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
            connector: 'slack',
            channel: 'C_PUBLIC_SYNTHETIC',
            requestedCount: 100,
            processed: 100,
            advancedThroughSeq: 100,
            firstSeq: 1,
            lastSeq: 100,
            pagesStored: 100,
            commits: [],
          };
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: Array.from({ length: 100 }, (_, index) => ({
            event_index_id: `synthetic-event-index-id-${index}`,
            pages: [
              {
                path: `projects/manual-wiki-${index}.md`,
                title: `Manual Wiki ${index}`,
                type: 'entity',
                content: validEscapedContent,
              },
            ],
          })),
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        mode: 'manual_wiki_commit',
        pagesStored: 100,
      });
      expect(providerCalls).toBe(1);
    });

    it('rejects manual wiki API requests above the aggregate page limit before provider execution', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when aggregate pages exceed the request limit');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: 'synthetic-event-index-id-1',
              pages: makeManualWikiPages(60, 'first'),
            },
            {
              event_index_id: 'synthetic-event-index-id-2',
              pages: makeManualWikiPages(41, 'second'),
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_wiki_commit_invalid_request',
      });
      expect(response.body.error).toMatch(/at most 100 total pages/i);
      expect(providerCalls).toBe(0);
    });

    it('requires admin auth for manual wiki ingress commits', async () => {
      process.env[AUTH_TOKEN_ENV] = 'vnext-status-token';
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: () => {
          throw new Error('provider must not run without admin auth');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: 'synthetic-event-index-id',
              pages: [
                {
                  path: 'projects/manual-wiki.md',
                  title: 'Manual Wiki',
                  content: 'operator-authored wiki summary',
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: true,
        code: 'UNAUTHORIZED',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('rejects manual wiki ingress commit requests that try to supply source refs', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when source refs are supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: 'synthetic-event-index-id',
              pages: [
                {
                  path: 'projects/manual-wiki.md',
                  title: 'Manual Wiki',
                  content: 'operator-authored wiki summary',
                  source_refs: ['raw:slack:synthetic-event-index-id'],
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_wiki_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual wiki ingress commit requests that try to supply page changed refs', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualWikiCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when page changed refs are supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-wiki-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_pages: [
            {
              event_index_id: 'synthetic-event-index-id',
              pages: [
                {
                  path: 'projects/manual-wiki.md',
                  title: 'Manual Wiki',
                  content: 'operator-authored wiki summary',
                  changed_refs: ['wiki_page:projects/caller-supplied.md'],
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_wiki_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual memory ingress commit requests that try to supply source refs', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when memory source refs are supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_memories: [
            {
              event_index_id: 'synthetic-event-index-id',
              memories: [
                {
                  topic: 'operator/manual-memory',
                  kind: 'decision',
                  summary: 'Manual reviewed memory should be committed.',
                  details: 'The admin reviewed the connector event and approved this memory.',
                  scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
                  source_refs: ['raw:slack:synthetic-event-index-id'],
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual memory ingress commit requests that try to supply root provenance', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when root provenance is supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send(
          makeManualMemoryCommitBody('synthetic-event-index-id', {
            provenance: { gateway_call_id: 'caller-spoofed' },
            gateway_call_id: 'caller-spoofed',
            agent_id: 'caller-spoofed-agent',
            model_run_id: 'caller-spoofed-model-run',
          })
        );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual memory ingress commit requests that try to supply source metadata', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when memory source metadata is supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_memories: [
            {
              event_index_id: 'synthetic-event-index-id',
              memories: [
                {
                  topic: 'operator/manual-memory',
                  kind: 'decision',
                  summary: 'Manual reviewed memory should be committed.',
                  details: 'The admin reviewed the connector event and approved this memory.',
                  scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
                  source: {
                    package: 'standalone',
                    source_type: 'caller-spoofed',
                  },
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual memory ingress commit requests that try to supply timeline or entity refs', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      let providerCalls = 0;
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualMemoryCommitProvider: () => {
          providerCalls += 1;
          throw new Error('provider must not run when memory timeline refs are supplied');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-memory-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_memories: [
            {
              event_index_id: 'synthetic-event-index-id',
              memories: [
                {
                  topic: 'operator/manual-memory',
                  kind: 'decision',
                  summary: 'Manual reviewed memory should be committed.',
                  details: 'The admin reviewed the connector event and approved this memory.',
                  scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
                  timeline_event: {
                    source_ref: 'raw:slack:caller-spoofed',
                    event_type: 'decision',
                    title: 'caller supplied timeline ref',
                  },
                  entity_observation_ids: ['entity-observation:caller-spoofed'],
                },
              ],
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_memory_commit_invalid_request',
      });
      expect(providerCalls).toBe(0);
    });

    it('rejects manual no-update ingress commit requests that try to supply changed refs', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: (input) =>
          commitConnectorIngressNoUpdateBatch({
            rawAdapter: db,
            operatorDb: db,
            ...input,
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: [eventIndexId],
          changedRefs: [{ kind: 'os_task', id: 'task-should-not-be-accepted' }],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_commit_invalid_request',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('rejects manual no-update ingress commits for the wrong configured channel', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const eventIndexId = insertRawEvent(db, 'msg-1', { channel: 'C_PUBLIC_SYNTHETIC' });
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: createConnectorIngressManualNoUpdateCommitProvider({
          rawAdapter: db,
          operatorDb: db,
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          nowMs: () => 1710000000000,
        }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_OTHER_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: [eventIndexId],
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_commit_invalid_request',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM vnext_operator_commits').get()).toEqual({
        count: 0,
      });

      db.close();
    });

    it('rejects unbounded manual no-update ingress commit batches before provider execution', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: () => {
          throw new Error('provider must not run for unbounded batches');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: Array.from({ length: 101 }, (_, index) => `synthetic-event-${index}`),
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_commit_invalid_request',
        error: 'event_index_ids must contain at most 100 items',
      });
    });

    it('sanitizes unexpected manual no-update ingress commit failures', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: () => {
          throw new Error('cursor backend failed with synthetic-error-marker');
        },
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: ['synthetic-event-index-id'],
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        ok: false,
        code: 'vnext_ingress_manual_commit_failed',
        error: 'vNext manual ingress commit failed.',
      });
      expect(JSON.stringify(response.body)).not.toContain('cursor backend');
      expect(JSON.stringify(response.body)).not.toContain('synthetic-error-marker');
    });

    it('returns conflict with a safe payload when a manual no-update commit partially fails', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const db = new Database(':memory:');
      applyMigrationsThrough(db as unknown as Parameters<typeof applyMigrationsThrough>[0], 39);
      const first = insertRawEvent(db, 'msg-1', {
        channel: 'C_PUBLIC_SYNTHETIC',
        timestampMs: 1710000001000,
      });
      const second = insertRawEvent(db, 'msg-2', {
        channel: 'C_PUBLIC_SYNTHETIC',
        timestampMs: 1710000002000,
      });
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack:channel:C_PUBLIC_SYNTHETIC', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit:preexisting-conflict',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
        2,
        2,
        'no_update',
        JSON.stringify([]),
        JSON.stringify(['raw:slack:conflicting-synthetic-event']),
        1710000000000
      );
      const apiServer = createVNextBootstrapApiServer(makeStatus(), {
        ingressManualNoUpdateCommitProvider: (input) =>
          commitConnectorIngressNoUpdateBatch({
            rawAdapter: db,
            operatorDb: db,
            ...input,
            nowMs: () => 1710000000000,
          }),
      });

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: [first, second],
        });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        ok: false,
        mode: 'manual_no_update_commit',
        status: 'partial_failure',
        processed: 1,
        advancedThroughSeq: 1,
        failedSeq: 2,
        error: 'Manual no-update commit partially failed.',
      });
      expect(JSON.stringify(response.body)).not.toContain('source refs');
      expect(JSON.stringify(response.body)).not.toContain(LOCAL_PATH_PREFIX);

      db.close();
    });

    it('rejects manual no-update ingress commits when the provider is not configured', async () => {
      process.env[ADMIN_TOKEN_ENV] = 'vnext-admin-token';
      const apiServer = createVNextBootstrapApiServer(makeStatus());

      const response = await request(apiServer.app)
        .post('/api/vnext/ingress/manual-no-update-commit')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-admin-token')
        .send({
          connector: 'slack',
          channel: 'C_PUBLIC_SYNTHETIC',
          expected_advanced_through_seq: 0,
          event_index_ids: ['event_missing_provider'],
        });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        ok: false,
        code: 'vnext_ingress_manual_commit_unavailable',
      });
    });
  });
});
