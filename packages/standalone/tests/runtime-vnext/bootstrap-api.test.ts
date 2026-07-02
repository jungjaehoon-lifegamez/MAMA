import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  createVNextBootstrapApiServer,
  createVNextPrimaryOperatorRuntime,
} from '../../src/cli/commands/start.js';
import { ensureVNextOperatorSchema } from '../../src/operator-vnext/schema.js';
import type { VNextBootstrapRuntimeStatus } from '../../src/runtime-vnext/bootstrap.js';
import Database from '../../src/sqlite.js';

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

describe('STORY-VNEXT-PR1-BOOTSTRAP-API: vNext bootstrap API security', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env.MAMA_AUTH_TOKEN;
    } else {
      process.env.MAMA_AUTH_TOKEN = originalAuthToken;
    }
  });

  describe('AC: vNext status endpoints keep public health separate from authenticated API', () => {
    it('keeps /health unauthenticated but protects /api status routes for tunneled requests', async () => {
      process.env.MAMA_AUTH_TOKEN = 'vnext-status-token';
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

    it('creates a primary operator runtime bound to the manual cursor', async () => {
      process.env.MAMA_AUTH_TOKEN = 'vnext-status-token';
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

    it('marks primary operator runtime degraded after a failed batch', async () => {
      process.env.MAMA_AUTH_TOKEN = 'vnext-status-token';
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

      const statusResponse = await request(apiServer.app)
        .get('/api/vnext/status')
        .set('cf-connecting-ip', '203.0.113.10')
        .set('authorization', 'Bearer vnext-status-token');
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.primary_operator_runtime).toMatchObject({
        status: 'degraded',
        last_batch_status: 'partial_failure',
        failed_seq: 1,
      });

      db.close();
    });
  });
});
