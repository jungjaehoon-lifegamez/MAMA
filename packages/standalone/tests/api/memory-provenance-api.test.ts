import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mamaCore from '@jungjaehoon/mama-core';
import { closeDB } from '@jungjaehoon/mama-core/db-manager';
import {
  createTrustedProvenanceCapability,
  saveMemoryWithTrustedProvenance,
} from '@jungjaehoon/mama-core';
import { createApiServer } from '../../src/api/index.js';
import { CronScheduler } from '../../src/scheduler/index.js';

const TEST_DB = path.join(os.tmpdir(), `test-memory-provenance-api-${randomUUID()}.db`);
const TUNNEL_HEADERS = {
  'cf-connecting-ip': '198.51.100.42',
  'x-forwarded-for': '198.51.100.42',
};
const CLOUDFLARE_ACCESS_HEADERS = {
  'cf-connecting-ip': '198.51.100.43',
  'x-forwarded-for': '198.51.100.43',
  'cf-ray': 'ray-id',
  'cf-access-jwt-assertion': 'jwt-token',
  'cf-access-authenticated-user-email': 'operator@example.com',
};

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

async function seedMemory(): Promise<string> {
  const saved = await saveMemoryWithTrustedProvenance(
    {
      topic: 'admin_provenance_trace',
      kind: 'decision',
      summary: 'Traceable memory for admin API',
      details: 'Should expose compact provenance only.',
      scopes: [{ kind: 'project', id: 'repo:admin-api' }],
      source: {
        package: 'standalone',
        source_type: 'test',
        project_id: 'repo:admin-api',
      },
    },
    {
      capability: createTrustedProvenanceCapability(),
      provenance: {
        actor: 'main_agent',
        envelope_hash: 'env_admin_api',
        gateway_call_id: 'gw_admin_api',
        model_run_id: 'model_admin_api',
        tool_name: 'mama_save',
        source_refs: ['message:admin-api'],
      },
    }
  );
  return saved.id;
}

describe('Story M2.3: Admin memory provenance API', () => {
  const originalAdminToken = process.env.MAMA_ADMIN_TOKEN;
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  const originalServerToken = process.env.MAMA_SERVER_TOKEN;
  const originalDbPath = process.env.MAMA_DB_PATH;
  const originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
  let scheduler: CronScheduler;

  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
    process.env.MAMA_ADMIN_TOKEN = 'admin-token';
    process.env.MAMA_AUTH_TOKEN = 'normal-token';
    delete process.env.MAMA_SERVER_TOKEN;
    scheduler = new CronScheduler();
  });

  afterEach(async () => {
    scheduler.shutdown();
    await closeDB();
    cleanupDb();
    restoreEnv('MAMA_ADMIN_TOKEN', originalAdminToken);
    restoreEnv('MAMA_AUTH_TOKEN', originalAuthToken);
    restoreEnv('MAMA_SERVER_TOKEN', originalServerToken);
    restoreEnv('MAMA_DB_PATH', originalDbPath);
    restoreEnv('MAMA_FORCE_TIER_3', originalForceTier3);
  });

  describe('Acceptance Criteria', () => {
    describe('AC #1: admin token is the only accepted perimeter', () => {
      it('rejects missing, wrong, normal API, and Cloudflare-only credentials', async () => {
        const apiServer = createApiServer({ scheduler, port: 0 });

        const missing = await request(apiServer.app).get('/api/memory/provenance/mem-missing');
        expect(missing.status).toBe(401);

        const wrong = await request(apiServer.app)
          .get('/api/memory/provenance/mem-missing')
          .set('Authorization', 'Bearer wrong-token');
        expect(wrong.status).toBe(401);

        const normalApiToken = await request(apiServer.app)
          .get('/api/memory/provenance/mem-missing')
          .set('Authorization', 'Bearer normal-token');
        expect(normalApiToken.status).toBe(401);

        const cloudflareOnly = await request(apiServer.app)
          .get('/api/memory/provenance/mem-missing')
          .set(CLOUDFLARE_ACCESS_HEADERS);
        expect(cloudflareOnly.status).toBe(401);
      });

      it('returns a disabled response when MAMA_ADMIN_TOKEN is unset', async () => {
        delete process.env.MAMA_ADMIN_TOKEN;
        const apiServer = createApiServer({ scheduler, port: 0 });

        const response = await request(apiServer.app)
          .get('/api/memory/provenance/mem-missing')
          .set(TUNNEL_HEADERS)
          .set('Authorization', 'Bearer admin-token');

        expect(response.status).toBe(503);
        expect(response.body.code).toBe('admin_token_required');
      });
    });

    describe('AC #2: valid admin reads compact provenance without broad API privilege', () => {
      it('reads by memory id and gateway call id before normal /api auth', async () => {
        const memoryId = await seedMemory();
        const apiServer = createApiServer({ scheduler, port: 0 });

        const byId = await request(apiServer.app)
          .get(`/api/memory/provenance/${memoryId}`)
          .set('Authorization', 'Bearer admin-token');
        expect(byId.status).toBe(200);
        expect(byId.body.data).toMatchObject({
          memory_id: memoryId,
          topic: 'admin_provenance_trace',
          summary: 'Traceable memory for admin API',
          envelope_hash: 'env_admin_api',
          model_run_id: 'model_admin_api',
          gateway_call_id: 'gw_admin_api',
          tool_name: 'mama_save',
          scope_refs: [{ kind: 'project', id: 'repo:admin-api' }],
          legacy_caveats: [],
        });
        expect(JSON.stringify(byId.body)).not.toContain('Should expose compact provenance only');

        const byGateway = await request(apiServer.app)
          .get('/api/memory/provenance?gateway_call_id=gw_admin_api')
          .set('Authorization', 'Bearer admin-token');
        expect(byGateway.status).toBe(200);
        expect(byGateway.body.data).toEqual([
          expect.objectContaining({ memory_id: memoryId, gateway_call_id: 'gw_admin_api' }),
        ]);

        const unrelatedApi = await request(apiServer.app)
          .get('/api/envelope/status')
          .set(TUNNEL_HEADERS)
          .set('Authorization', 'Bearer admin-token');
        expect(unrelatedApi.status).toBe(401);
      });

      it('rejects caller-supplied scope narrowing query params', async () => {
        const apiServer = createApiServer({ scheduler, port: 0 });

        const response = await request(apiServer.app)
          .get('/api/memory/provenance?gateway_call_id=gw_admin_api&scope_id=repo:admin-api')
          .set('Authorization', 'Bearer admin-token');

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('scope_query_not_supported');
      });

      it('returns structured JSON when single-memory provenance lookup fails', async () => {
        const provenanceSpy = vi
          .spyOn(mamaCore, 'getMemoryProvenanceAudit')
          .mockRejectedValueOnce(new Error('database unavailable'));
        const apiServer = createApiServer({ scheduler, port: 0 });

        try {
          const response = await request(apiServer.app)
            .get('/api/memory/provenance/mem-broken-db')
            .set('Authorization', 'Bearer admin-token');

          expect(response.status).toBe(500);
          expect(response.body).toMatchObject({
            error: true,
            code: 'memory_provenance_error',
          });
        } finally {
          provenanceSpy.mockRestore();
        }
      });
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
