import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createVNextBootstrapApiServer } from '../../src/cli/commands/start.js';
import type { VNextBootstrapRuntimeStatus } from '../../src/runtime-vnext/bootstrap.js';

function makeStatus(): VNextBootstrapRuntimeStatus {
  return {
    enabled: true,
    mode: 'bootstrap',
    source: 'env',
    startedAtMs: 1234,
    primaryOperator: {
      kind: 'primary_operator',
      status: 'noop',
      reason: 'test',
    },
    executedStartupSteps: [
      'config_read',
      'db_initialization',
      'api_server_health',
      'manual_status_endpoints',
      'primary_operator_placeholder',
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
        },
      });
    });
  });
});
