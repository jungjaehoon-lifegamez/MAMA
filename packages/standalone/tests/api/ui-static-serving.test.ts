/**
 * /ui static serving -- operator viewer SPA (public/ui, built by ui/).
 *
 * Uses the MAMA_UI_DIR env override so tests never depend on a real Vite build
 * artifact (and never read outside the temp fixture).
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

async function requestGraph(pathname: string) {
  const handler = createGraphHandler({});
  const req = {
    method: 'GET',
    url: pathname,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  } as IncomingMessage;
  const res = createMockRes();
  const handled = await handler(req, res as unknown as ServerResponse);
  return { handled, status: res._status, headers: res._headers, body: res._body };
}

describe('/ui static serving', () => {
  let uiDir: string;

  beforeEach(() => {
    uiDir = join(tmpdir(), `mama-ui-static-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(uiDir, 'assets'), { recursive: true });
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);');
    process.env.MAMA_UI_DIR = uiDir;
  });

  afterEach(() => {
    delete process.env.MAMA_UI_DIR;
    rmSync(uiDir, { recursive: true, force: true });
  });

  it('serves /ui as the SPA index.html', async () => {
    const res = await requestGraph('/ui');
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves /ui/ (trailing slash) as index.html', async () => {
    const res = await requestGraph('/ui/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves hashed assets with a js content type', async () => {
    const res = await requestGraph('/ui/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('SPA-falls back unknown /ui routes to index.html', async () => {
    const res = await requestGraph('/ui/triggers');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('does NOT fall back for missing assets -- real 404', async () => {
    const res = await requestGraph('/ui/assets/gone.js');
    expect(res.status).toBe(404);
  });

  it('never serves files above the ui root for traversal attempts', async () => {
    // WHATWG URL parsing normalizes dot segments before routing, so this never
    // reaches the /ui route (handled=false); the in-route resolve() guard is
    // defense-in-depth for any non-normalizing caller. Either way: no 200.
    const res = await requestGraph('/ui/../../etc/passwd');
    expect(res.status === 404 || res.handled === false).toBe(true);
    expect(res.status).not.toBe(200);
  });

  it('sets a script-src-self CSP on the SPA document', async () => {
    const res = await requestGraph('/ui');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('tolerates a trailing slash in MAMA_UI_DIR', async () => {
    process.env.MAMA_UI_DIR = `${uiDir}/`;
    const res = await requestGraph('/ui');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
