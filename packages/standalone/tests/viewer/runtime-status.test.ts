/**
 * Contract for the authoritative runtime status surface.
 *
 * The System views used to assemble "what is running" from a stale client-side
 * model registry; the point of this route is that the answer comes from the
 * running daemon and from nowhere else. The tests therefore inject the
 * snapshot supplier (no real config, PID or connector credential is read)
 * and pin that the wire format is the snapshot verbatim.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApiServer, type RuntimeStatusSnapshot } from '../../src/api/index.js';
import { CronScheduler } from '../../src/scheduler/index.js';
import { projectRuntimeConnectors } from '../../src/cli/runtime/api-server-init.js';
import { renderRuntimeSnapshot } from '../../public/viewer/src/modules/system.js';

const TUNNEL_HEADERS = {
  'cf-connecting-ip': '198.51.100.7',
  'x-forwarded-for': '198.51.100.7',
};

const SNAPSHOT: RuntimeStatusSnapshot = {
  running: true,
  version: '9.8.7',
  backend: 'codex',
  model: 'gpt-test',
  startedAt: 1000,
  health: { score: 98, status: 'healthy' },
  connectors: [{ name: 'telegram', enabled: true, state: 'connected' }],
};

describe('GET /api/runtime/status', () => {
  const originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  let scheduler: CronScheduler;

  beforeEach(() => {
    process.env.MAMA_AUTH_TOKEN = 'test-token';
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    // The env restore must survive a scheduler that throws on shutdown: this
    // file shares a fork with the rest of the suite, so a leaked test token
    // would silently re-authenticate someone else's server.
    try {
      scheduler.shutdown();
    } finally {
      if (originalAuthToken === undefined) {
        delete process.env.MAMA_AUTH_TOKEN;
      } else {
        process.env.MAMA_AUTH_TOKEN = originalAuthToken;
      }
    }
  });

  function serverWith(snapshot: RuntimeStatusSnapshot | (() => RuntimeStatusSnapshot)) {
    return createApiServer({
      scheduler,
      port: 0,
      getRuntimeStatus: typeof snapshot === 'function' ? snapshot : () => snapshot,
    });
  }

  it('serves the injected snapshot verbatim', async () => {
    const response = await request(serverWith(SNAPSHOT).app).get('/api/runtime/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      running: true,
      version: '9.8.7',
      backend: 'codex',
      model: 'gpt-test',
      startedAt: 1000,
      health: { score: 98, status: 'healthy' },
      connectors: [{ name: 'telegram', enabled: true, state: 'connected' }],
    });
  });

  it('never leaks a stale registry default when runtime says Codex', async () => {
    const response = await request(serverWith(SNAPSHOT).app).get('/api/runtime/status');
    expect(JSON.stringify(response.body)).not.toContain('claude-sonnet-5');
  });

  it('does not pass supplier extras through to the wire', async () => {
    const noisy = {
      ...SNAPSHOT,
      // A supplier field that must never reach a browser.
      botToken: 'supplier-extra-value',
      entrypoint: '/opt/mama/dist/cli/index.js',
      packageJsonPath: '/opt/mama/package.json',
    } as unknown as RuntimeStatusSnapshot;

    const response = await request(serverWith(noisy).app).get('/api/runtime/status');
    expect(JSON.stringify(response.body)).not.toContain('supplier-extra-value');
    expect(response.body).not.toHaveProperty('entrypoint');
    expect(response.body).not.toHaveProperty('packageJsonPath');
  });

  it('reports health as null rather than fabricating a score', async () => {
    const response = await request(serverWith({ ...SNAPSHOT, health: null }).app).get(
      '/api/runtime/status'
    );

    expect(response.status).toBe(200);
    expect(response.body.health).toBeNull();
  });

  it('requires auth for tunneled requests', async () => {
    const response = await request(serverWith(SNAPSHOT).app)
      .get('/api/runtime/status')
      .set(TUNNEL_HEADERS);

    expect(response.status).toBe(401);
  });

  it('accepts a bearer token for tunneled requests', async () => {
    const response = await request(serverWith(SNAPSHOT).app)
      .get('/api/runtime/status')
      .set(TUNNEL_HEADERS)
      .set('Authorization', 'Bearer test-token');

    expect(response.status).toBe(200);
    expect(response.body.backend).toBe('codex');
  });

  it('is not mounted when the daemon supplies no snapshot', async () => {
    const apiServer = createApiServer({ scheduler, port: 0 });
    const response = await request(apiServer.app).get('/api/runtime/status');
    expect(response.status).not.toBe(200);
  });

  it('answers 503 instead of 500 when the supplier throws', async () => {
    const response = await request(
      serverWith(() => {
        throw new Error('boom');
      }).app
    ).get('/api/runtime/status');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('runtime_status_unavailable');
  });
});

describe('runtime connector projection', () => {
  it('lists only configured connectors and reports registration truth', () => {
    const result = projectRuntimeConnectors(
      {
        ok: true,
        config: {
          telegram: { enabled: true },
          slack: { enabled: true },
          discord: { enabled: false },
        },
        enabledNames: ['telegram', 'slack'],
      } as never,
      ['telegram']
    );

    expect(result).toEqual([
      { name: 'slack', enabled: true, state: 'unknown' },
      { name: 'telegram', enabled: true, state: 'connected' },
      { name: 'discord', enabled: false, state: 'disconnected' },
    ]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(
      projectRuntimeConnectors({ ok: true, config: {}, enabledNames: [] } as never, [])
    ).toEqual([]);
  });
});

describe('System views render runtime truth', () => {
  const systemSource = readFileSync(
    join(process.cwd(), 'public', 'viewer', 'src', 'modules', 'system.ts'),
    'utf8'
  );
  const viewerSource = readFileSync(join(process.cwd(), 'public', 'viewer', 'viewer.html'), 'utf8');

  it('reads runtime truth from the authoritative endpoint only', () => {
    expect(systemSource).toContain('/api/runtime/status');
    // The stale sources the System views used to blend in.
    expect(systemSource).not.toContain('/api/config');
    expect(systemSource).not.toContain('claude-sonnet-5');
  });

  it('renders "unavailable" for a null health score', () => {
    expect(systemSource).toContain('HEALTH_UNAVAILABLE');
    expect(systemSource).toMatch(/health\s*\?/);
  });

  it('renders the executing package version in Runtime', () => {
    const html = renderRuntimeSnapshot(SNAPSHOT);

    expect(html).toContain('Version');
    expect(html).toContain('9.8.7');
  });

  it('has loading, error-with-retry, and empty states', () => {
    expect(systemSource).toContain('mama-system-skeleton');
    expect(systemSource).toContain('data-retry');
    expect(systemSource).toContain('mama connector add');
    expect(systemSource).toContain('/api/runtime/status');
  });

  it('is the wiring viewer.html uses for both System views', () => {
    expect(viewerSource).toContain("from '/viewer/js/modules/system.js'");
    expect(viewerSource).toContain('renderRuntimeView(');
    expect(viewerSource).toContain('renderConnectorsView(');
    // The legacy blended-source connector loader is gone.
    expect(viewerSource).not.toContain('loadConnectorsList');
    expect(viewerSource).not.toContain('CONNECTOR_CATEGORIES');
  });
});

describe('Log viewer is polling-only', () => {
  const logViewerSource = readFileSync(
    join(process.cwd(), 'public', 'viewer', 'log-viewer.html'),
    'utf8'
  );

  it('offers no WebSocket subscription control', () => {
    expect(logViewerSource).not.toContain('wsBtn');
    expect(logViewerSource).not.toContain('new WebSocket');
    expect(logViewerSource).not.toContain("channel: 'logs'");
  });

  it('still polls the daemon log endpoint', () => {
    expect(logViewerSource).toContain('/api/logs/daemon');
    expect(logViewerSource).toContain('function startPolling()');
  });
});
