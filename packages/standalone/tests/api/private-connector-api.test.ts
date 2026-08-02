import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApiServer } from '../../src/api/index.js';
import { registerKagemushaTaskRoute } from '../../src/cli/runtime/api-routes-init.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import { CronScheduler } from '../../src/scheduler/index.js';

const authHeader = 'Bearer test-auth-token';
const originalAuthToken = process.env.MAMA_AUTH_TOKEN;

afterEach(() => {
  if (originalAuthToken === undefined) {
    delete process.env.MAMA_AUTH_TOKEN;
  } else {
    process.env.MAMA_AUTH_TOKEN = originalAuthToken;
  }
});

describe('Story private connector isolation: API discovery boundary', () => {
  it('TG-01/TG-05/TG-06: returns no private catalog entry and 404s the private route when absent', async () => {
    process.env.MAMA_AUTH_TOKEN = 'test-auth-token';
    const loadResult: ConnectorConfigLoadResult = { ok: true, config: {}, enabledNames: [] };
    const policy = resolvePrivateConnectorPolicy(loadResult);
    const server = createApiServer({
      scheduler: new CronScheduler(),
      port: 0,
      connectorConfigLoadResult: loadResult,
      privateConnectorPolicy: policy,
    });
    registerKagemushaTaskRoute(server.app, policy, async () => {
      throw new Error('private task query must not load when the connector is absent');
    });

    expect(
      (await request(server.app).get('/api/connectors/status').set('Authorization', authHeader))
        .body.connectors
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'kagemusha' })]));
    await request(server.app)
      .get('/api/kagemusha/tasks')
      .set('Authorization', authHeader)
      .expect(404);
  });

  it('TG-01/TG-05/TG-06: registers the private route only for configured-enabled policy', async () => {
    process.env.MAMA_AUTH_TOKEN = 'test-auth-token';
    const loadResult: ConnectorConfigLoadResult = {
      ok: true,
      config: {
        kagemusha: {
          enabled: true,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'none' },
        },
      },
      enabledNames: ['kagemusha'],
    };
    const policy = resolvePrivateConnectorPolicy(loadResult);
    const server = createApiServer({
      scheduler: new CronScheduler(),
      port: 0,
      connectorConfigLoadResult: loadResult,
      privateConnectorPolicy: policy,
    });
    registerKagemushaTaskRoute(server.app, policy, async () => () => []);

    expect(
      (await request(server.app).get('/api/connectors/status').set('Authorization', authHeader))
        .body.connectors
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'kagemusha', enabled: true })])
    );
    await request(server.app)
      .get('/api/kagemusha/tasks')
      .set('Authorization', authHeader)
      .expect(200, { success: true, tasks: [], total: 0 });
  });

  it('TG-01/TG-05/TG-06: keeps a configured-disabled private connector visible without loading its route', async () => {
    process.env.MAMA_AUTH_TOKEN = 'test-auth-token';
    const loadResult: ConnectorConfigLoadResult = {
      ok: true,
      config: {
        kagemusha: {
          enabled: false,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'none' },
        },
      },
      enabledNames: [],
    };
    const policy = resolvePrivateConnectorPolicy(loadResult);
    const server = createApiServer({
      scheduler: new CronScheduler(),
      port: 0,
      connectorConfigLoadResult: loadResult,
      privateConnectorPolicy: policy,
    });
    registerKagemushaTaskRoute(server.app, policy, async () => {
      throw new Error('private task query must not load when the connector is disabled');
    });

    expect(
      (await request(server.app).get('/api/connectors/status').set('Authorization', authHeader))
        .body.connectors
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'kagemusha', enabled: false })])
    );
    await request(server.app)
      .get('/api/kagemusha/tasks')
      .set('Authorization', authHeader)
      .expect(404);
  });
});
