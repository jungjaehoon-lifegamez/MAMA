/**
 * Route contract for the unified Viewer.
 *
 * /viewer is the ONE public shell: `/` redirects there, the temporary `/ui`
 * SPA route is gone (404), and the operator bundle is served from
 * /viewer/operator/*. Uses the MAMA_VIEWER_DIR env override so the test never
 * reads a real user directory or a build artifact.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGraphHandler } from '../../src/api/graph-api.js';

function createMockRes() {
  return {
    _status: 0,
    _body: '' as string | Buffer,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      for (const [k, v] of Object.entries(headers ?? {})) {
        this._headers[k.toLowerCase()] = v;
      }
    },
    end(body?: string | Buffer) {
      this._body = body ?? '';
    },
  };
}

async function requestGraph(pathname: string, method = 'GET') {
  const handler = createGraphHandler({});
  const req = {
    method,
    url: pathname,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  } as IncomingMessage;
  const res = createMockRes();
  const handled = await handler(req, res as unknown as ServerResponse);
  return { handled, status: res._status, headers: res._headers, body: res._body };
}

describe('viewer route contract', () => {
  let viewerDir: string;

  beforeEach(() => {
    viewerDir = join(
      tmpdir(),
      `mama-viewer-route-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(viewerDir, 'operator'), { recursive: true });
    writeFileSync(join(viewerDir, 'viewer.html'), '<!doctype html><div id="app"></div>');
    writeFileSync(join(viewerDir, 'operator', 'operator.js'), 'export const operator = 1;');
    writeFileSync(join(viewerDir, 'operator', 'operator.css'), '.operator{display:block}');
    process.env.MAMA_VIEWER_DIR = viewerDir;
  });

  afterEach(() => {
    delete process.env.MAMA_VIEWER_DIR;
    rmSync(viewerDir, { recursive: true, force: true });
  });

  it('redirects / to /viewer', async () => {
    const res = await requestGraph('/');
    expect(res.handled).toBe(true);
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/viewer');
  });

  it('serves /viewer as the public shell', async () => {
    const res = await requestGraph('/viewer');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('no longer serves the temporary /ui route', async () => {
    const res = await requestGraph('/ui');
    expect(res.status).not.toBe(200);
    expect(res.status === 404 || res.handled === false).toBe(true);
  });

  it('no longer serves /ui assets', async () => {
    const res = await requestGraph('/ui/assets/app.js');
    expect(res.status).not.toBe(200);
    expect(res.status === 404 || res.handled === false).toBe(true);
  });

  it('serves the operator bundle from /viewer/operator/operator.js', async () => {
    const res = await requestGraph('/viewer/operator/operator.js');
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(String(res.body)).toContain('operator');
  });

  it('serves the operator stylesheet from /viewer/operator/operator.css', async () => {
    const res = await requestGraph('/viewer/operator/operator.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('answers HEAD for the operator bundle', async () => {
    const res = await requestGraph('/viewer/operator/operator.js', 'HEAD');
    expect(res.status).toBe(200);
  });

  it('404s a missing operator asset', async () => {
    const res = await requestGraph('/viewer/operator/gone.js');
    expect(res.status).toBe(404);
  });

  it('never serves files above the operator root for traversal attempts', async () => {
    // WHATWG URL parsing normalizes dot segments before routing, so this never
    // reaches the operator route; the in-route resolve() guard is
    // defense-in-depth for any non-normalizing caller. Either way: no 200.
    const res = await requestGraph('/viewer/operator/../viewer.html');
    expect(res.status).not.toBe(200);
  });

  it('tolerates a trailing slash in MAMA_VIEWER_DIR', async () => {
    process.env.MAMA_VIEWER_DIR = `${viewerDir}/`;
    const res = await requestGraph('/viewer/operator/operator.js');
    expect(res.status).toBe(200);
  });

  it('preserves the existing /viewer/js module route', async () => {
    mkdirSync(join(viewerDir, 'js'), { recursive: true });
    writeFileSync(join(viewerDir, 'js', 'app.js'), 'console.log(1);');
    const res = await requestGraph('/viewer/js/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });
});
