import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from '../../src/sqlite.js';
import { createApiServer } from '../../src/api/index.js';
import { initAgentTables, logActivity } from '../../src/db/agent-store.js';
import { CronScheduler } from '../../src/scheduler/index.js';

const TUNNEL_HEADERS = {
  'cf-connecting-ip': '198.51.100.7',
  'x-forwarded-for': '198.51.100.7',
};

function sqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function setActivityCreatedAt(db: Database, id: number, createdAt: string): void {
  db.prepare('UPDATE agent_activity SET created_at = ? WHERE id = ?').run(createdAt, id);
}

describe('M1R authenticated /api/envelope/status', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let db: Database;
  let scheduler: CronScheduler;

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'test-token';
    db = new Database(':memory:');
    initAgentTables(db);
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.shutdown();
    db.close();
    if (originalAuthToken === undefined) {
      delete process.env.MAMA_AUTH_TOKEN;
    } else {
      process.env.MAMA_AUTH_TOKEN = originalAuthToken;
    }
  });

  it('requires auth for tunneled requests and reports durable 24h mismatch count', async () => {
    const now = Date.now();
    const recentOne = logActivity(db, {
      agent_id: 'os_agent',
      agent_version: 1,
      type: 'gateway_tool_call',
      execution_status: 'completed',
      envelopeHash: 'env_recent_1',
      scopeMismatch: 1,
    });
    const recentTwo = logActivity(db, {
      agent_id: 'os_agent',
      agent_version: 1,
      type: 'gateway_tool_call',
      execution_status: 'completed',
      envelopeHash: 'env_recent_2',
      scopeMismatch: 1,
    });
    const older = logActivity(db, {
      agent_id: 'os_agent',
      agent_version: 1,
      type: 'gateway_tool_call',
      execution_status: 'completed',
      envelopeHash: 'env_old',
      scopeMismatch: 1,
    });
    logActivity(db, {
      agent_id: 'os_agent',
      agent_version: 1,
      type: 'gateway_tool_call',
      execution_status: 'completed',
      envelopeHash: 'env_match',
      scopeMismatch: 0,
    });
    setActivityCreatedAt(db, recentOne.id, sqliteTimestamp(new Date(now - 60_000)));
    setActivityCreatedAt(db, recentTwo.id, sqliteTimestamp(new Date(now - 23 * 60 * 60_000)));
    setActivityCreatedAt(db, older.id, sqliteTimestamp(new Date(now - 25 * 60 * 60_000)));

    const apiServer = createApiServer({
      scheduler,
      port: 0,
      db,
      envelope: {
        issuance: 'enabled',
        key_id: 'local-2026-04',
        key_version: 7,
      },
    });

    const unauthenticated = await request(apiServer.app)
      .get('/api/envelope/status')
      .set(TUNNEL_HEADERS);
    expect(unauthenticated.status).toBe(401);

    const authenticated = await request(apiServer.app)
      .get('/api/envelope/status')
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer test-token');
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toEqual({
      issuance: 'enabled',
      key_id: 'local-2026-04',
      key_version: 7,
      recent_mismatch_count_24h: 2,
    });

    const serializedBody = JSON.stringify(authenticated.body);
    expect(serializedBody).not.toContain('MAMA_ENVELOPE_HMAC_KEY_BASE64');
    expect(serializedBody).not.toContain('test-token');

    const localhostBypass = await request(apiServer.app).get('/api/envelope/status');
    expect(localhostBypass.status).toBe(200);
  });

  it('returns audit_db_unavailable when authenticated but sessions DB is absent', async () => {
    const apiServer = createApiServer({
      scheduler,
      port: 0,
      envelope: {
        issuance: 'required',
        key_id: 'local-2026-04',
        key_version: 8,
      },
    });

    const response = await request(apiServer.app)
      .get('/api/envelope/status')
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: true,
      code: 'audit_db_unavailable',
      message: 'Envelope audit database is unavailable.',
    });
  });
});
