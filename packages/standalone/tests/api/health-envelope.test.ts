import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApiServer } from '../../src/api/index.js';
import { CronScheduler } from '../../src/scheduler/index.js';

const ENVELOPE_MODES = ['off', 'enabled', 'required'] as const;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{32,}={0,2}/;

describe('Story M1R: Public /health envelope isolation', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'test-token';
  });

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env.MAMA_AUTH_TOKEN;
    } else {
      process.env.MAMA_AUTH_TOKEN = originalAuthToken;
    }
  });

  describe('AC: /health stays public and envelope-free', () => {
    it.each(ENVELOPE_MODES)(
      'keeps /health public and envelope-free when issuance is %s',
      async (issuance) => {
        const scheduler = new CronScheduler();
        try {
          const apiServer = createApiServer({
            scheduler,
            port: 0,
            envelope: {
              issuance,
              key_id: issuance === 'off' ? undefined : 'local-2026-04',
              key_version: issuance === 'off' ? undefined : 1,
            },
          });

          const response = await request(apiServer.app)
            .get('/health')
            .set('cf-connecting-ip', '198.51.100.7');

          expect(response.status).toBe(200);
          expect(Object.keys(response.body).sort()).toEqual(['status', 'timestamp']);
          expect(response.body.status).toBe('ok');
          expect(Number.isFinite(response.body.timestamp)).toBe(true);

          const serializedBody = JSON.stringify(response.body);
          expect(serializedBody).not.toContain('issuance');
          expect(serializedBody).not.toContain('key_id');
          expect(serializedBody).not.toContain('key_version');
          expect(serializedBody).not.toContain('envelope');
          expect(serializedBody).not.toContain('local-2026-04');
          expect(serializedBody).not.toMatch(LONG_BASE64_PATTERN);
        } finally {
          scheduler.shutdown();
        }
      }
    );
  });
});
