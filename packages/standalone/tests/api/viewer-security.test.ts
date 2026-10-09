import { EventEmitter } from 'node:events';
import { randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createViewerServer, type ViewerServerOptions } from '../../src/api/viewer-server.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { createOutboundEventRecorder } from '../../src/api/security-events.js';

const transport = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: IncomingMessage, res: ServerResponse) => void),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: (handler: typeof transport.handler) => {
    transport.handler = handler;
    return Object.assign(new EventEmitter(), {
      listen: (_options: unknown, callback: () => void) => callback(),
      address: () => ({ port: 3847 }),
      close: (callback: () => void) => callback(),
    });
  },
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync), readSync: vi.fn(real.readSync) };
});
const roots: string[] = [];
let audit: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const dispatch = vi.fn();

beforeEach(() => {
  const home = fs.mkdtempSync(join(tmpdir(), 'viewer-security-home-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_VIEWER_OWNER_EMAILS', '');
  vi.stubEnv('MAMA_AUTH_TOKEN', '');
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', '');
  vi.stubEnv('MAMA_CF_ACCESS_AUD', '');
  vi.stubEnv('MAMA_VIEWER_HOSTNAMES', '');
  audit = vi.spyOn(console, 'info').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dispatch.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function serve(options: Partial<ViewerServerOptions> = {}) {
  const server = createViewerServer({
    timeZone: createTimeZoneSetting('Asia/Seoul'),
    dispatch,
    ownerAccess: {} as never,
    ...options,
  });
  await server.start();
}
function request(
  path = '/api/runtime/status',
  headers: IncomingMessage['headers'] = {},
  remoteAddress = '127.0.0.1',
  method = 'GET',
  rawHeaders?: string[]
) {
  return new Promise<{ status: number; body: string; headers: Record<string, string> }>(
    (resolve) => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headersSent: false,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
          this.headers[name.toLowerCase()] = value;
        },
        writeHead(status: number) {
          this.statusCode = status;
          this.headersSent = true;
          return this;
        },
        end(body = '') {
          this.emit('finish');
          this.emit('close');
          resolve({ status: this.statusCode, body, headers: this.headers });
        },
      });
      transport.handler!(
        {
          url: path,
          method,
          headers: { host: 'localhost', ...headers },
          rawHeaders:
            rawHeaders ??
            Object.entries({ host: 'localhost', ...headers }).flatMap(([name, value]) => [
              name,
              String(value),
            ]),
          socket: { remoteAddress },
        } as IncomingMessage,
        response as unknown as ServerResponse
      );
    }
  );
}
function auditRow() {
  expect(audit).toHaveBeenCalledTimes(1);
  return JSON.parse(String(audit.mock.calls[0]![0]).replace(/^\[viewer\] /, ''));
}

describe('viewer request security', () => {
  it('does not grant cross-origin browser reads to a different loopback port', async () => {
    await serve({ getRuntimeStatus: () => ({ running: true }) as never });
    for (const origin of ['http://localhost:9876', 'http://127.0.0.1:9876']) {
      const response = await request('/api/runtime/status', { origin });
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it.each([
    'attacker.invalid',
    'localhost.attacker.invalid',
    'localhost@attacker.invalid',
    'localhost/anything',
    'localhost\\anything',
    'localhost:bad',
    'localhost:65536',
    'localhost:',
    'localhost:0',
    '[::1',
    '::1',
    '[::1]:bad',
    '[::1]:65536',
    '127.1',
    '2130706433',
    '0x7f000001',
    'localhost,attacker.invalid',
    ' localhost',
    '',
    ['localhost', 'attacker.invalid'],
  ])('rejects unapproved or malformed authority before auth %#', async (host) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await serve({
      getRuntimeStatus: () => {
        throw new Error('must not run');
      },
    });
    const response = await request('/api/runtime/status', {
      host: host as string,
      'cf-access-jwt-assertion': 'synthetic',
    });
    expect(response.status).toBe(421);
    expect(fetcher).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects duplicated Host headers even when Node exposes only the first', async () => {
    await serve();
    expect(
      (
        await request('/health', {}, '127.0.0.1', 'GET', [
          'Host',
          'localhost',
          'Host',
          'attacker.invalid',
        ])
      ).status
    ).toBe(421);
  });
  it.each([
    'localhost',
    'LOCALHOST:3847',
    'localhost.',
    '127.0.0.1:3847',
    '[::1]',
    '[0:0:0:0:0:0:0:1]:3847',
  ])('allows loopback authorities %#', async (host) => {
    await serve();
    expect((await request('/health', { host })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });
  it('accepts only exact comma-separated configured authorities', async () => {
    vi.stubEnv('MAMA_VIEWER_HOSTNAMES', ' viewer.invalid, second.invalid ');
    await serve();
    expect((await request('/health', { host: 'VIEWER.invalid:443' })).status).toBe(200);
    expect((await request('/health', { host: 'second.invalid' })).status).toBe(200);
    expect((await request('/health', { host: 'sub.viewer.invalid' })).status).toBe(421);
  });
  it('checks Host on static, health and OPTIONS routes as well', async () => {
    await serve();
    for (const [path, method] of [
      ['/', 'GET'],
      ['/health', 'GET'],
      ['/api/runtime/status', 'OPTIONS'],
    ]) {
      expect((await request(path, { host: 'attacker.invalid' }, '127.0.0.1', method)).status).toBe(
        421
      );
    }
  });
  it('logs one token audit record without queries or token values', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve({ getRuntimeStatus: () => ({ running: true }) as never });
    const response = await request(`/api/runtime/status?secret=${token}`, {
      'cf-ray': '0123456789abcdef-TST',
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(200);
    expect(auditRow()).toMatchObject({
      method: 'GET',
      path: '/api/runtime/status',
      status: 200,
      cfRay: '0123456789abcdef-TST',
      identity: 'token',
    });
    expect(JSON.stringify(audit.mock.calls).includes(token)).toBe(false);
  });
  it('logs failed remote authentication once and never trusts the unsigned email', async () => {
    await serve();
    expect(
      (
        await request('/api/runtime/status?private=true', {
          'cf-ray': '0123456789abcdef-TST',
          'cf-access-authenticated-user-email': 'fixture@invalid',
        })
      ).status
    ).toBe(401);
    expect(auditRow()).toMatchObject({ status: 401, identity: 'anonymous' });
    expect(JSON.stringify(audit.mock.calls).includes('fixture@invalid')).toBe(false);
    audit.mockClear();
    expect((await request('/api/runtime/status', {}, '192.0.2.2')).status).toBe(401);
    expect(auditRow()).toMatchObject({ status: 401, identity: 'anonymous' });
  });
  it('uses a short hash only after JWT signature and claims verification', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://127.0.0.1:19010';
    vi.stubEnv('MAMA_CF_ACCESS_ISSUER', issuer);
    vi.stubEnv('MAMA_CF_ACCESS_AUD', 'fixture');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] }),
      }))
    );
    const email = 'fixture@invalid';
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({ iss: issuer, aud: 'fixture', exp: Date.now() / 1000 + 120, email })}`;
    const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
    await serve({ getRuntimeStatus: () => ({ running: true }) as never });
    expect(
      (
        await request('/api/runtime/status', {
          'cf-ray': '0123456789abcdef-TST',
          'cf-access-jwt-assertion': assertion,
          'cf-access-authenticated-user-email': 'forged@invalid',
        })
      ).status
    ).toBe(200);
    expect(auditRow().identity).toBe(
      `access:${createHash('sha256').update(email).digest('hex').slice(0, 12)}`
    );
    expect(JSON.stringify(audit.mock.calls).includes(email)).toBe(false);
    expect(JSON.stringify(audit.mock.calls).includes(assertion)).toBe(false);
  });
  it.each([
    ['/health', 'GET'],
    ['/', 'GET'],
    ['/api/runtime/status', 'OPTIONS'],
  ])('audits public tunnelled routes without closing them %#', async (path, method) => {
    await serve();
    const response = await request(path, { 'cf-ray': '0123456789abcdef-TST' }, '127.0.0.1', method);
    expect(response.status).toBeLessThan(400);
    expect(auditRow()).toMatchObject({
      path,
      method,
      status: response.status,
      identity: 'anonymous',
    });
  });
  it('preserves ordinary content hashes and rejects non-protocol ray values', async () => {
    const hash = 'a'.repeat(64);
    await serve();
    await request(`/api/${hash}`, { 'cf-ray': 'fixture.invalid' });
    expect(auditRow()).toMatchObject({ path: `/api/${hash}`, cfRay: '[invalid]' });
  });
  it('audits a tunnel Host rejection once without authenticating it', async () => {
    await serve();
    await request('/health', { host: 'fixture.invalid', 'cf-ray': '0123456789abcdef-TST' });
    expect(auditRow()).toMatchObject({ status: 421, identity: 'anonymous' });
  });
  it('constrains attacker-controlled audit fields', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve();
    await request(`/api/${token}?secret=${token}`, { 'cf-ray': `${token}\nforged=1` });
    const output = String(audit.mock.calls[0]?.[0]);
    expect(output.includes(token)).toBe(false);
    expect(output.includes('\n')).toBe(false);
    expect(output.length).toBeLessThan(1500);
  });
  it('uses recallable credential shapes in audit paths and complete key blocks in errors', async () => {
    const credential = 'gh' + 'p_' + 'b'.repeat(30);
    const keyBody = 'synthetic-key-material';
    const key = '-----BEGIN ' + 'PRIVATE KEY-----\n' + keyBody + '\n-----END ' + 'PRIVATE KEY-----';
    await serve({
      getRuntimeStatus: () => {
        throw new Error(`diagnostic ${key}`);
      },
    });
    await request(`/api/${credential}`, { 'cf-ray': '0123456789abcdef-TST' });
    expect(JSON.stringify(audit.mock.calls).includes(credential)).toBe(false);
    await request();
    expect(JSON.stringify(errors.mock.calls).includes(keyBody)).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).toContain('diagnostic');
  });
  it('returns a generic internal error and logs safe diagnostic metadata', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    await serve({
      getRuntimeStatus: () => {
        throw Object.assign(
          new Error(
            `internal fixture detail ${token} https://fixture.invalid /private/synthetic/config.yaml`
          ),
          { code: 'EACCES' }
        );
      },
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.includes(token)).toBe(false);
    expect(response.body.includes('internal fixture detail')).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls).includes(token)).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).toContain('EACCES');
    expect(JSON.stringify(errors.mock.calls)).toContain('internal fixture detail');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('fixture.invalid');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('/private/synthetic');
  });
  it('redacts Basic authorization and quoted secret fields while retaining diagnostics', async () => {
    const basic = Buffer.from('synthetic-user:synthetic-password').toString('base64');
    const password = randomBytes(18).toString('hex');
    await serve({
      getRuntimeStatus: () => {
        throw new Error(
          `diagnostic Authorization: Basic ${basic} payload={"password":"${password}"}`
        );
      },
    });
    const result = await request();
    expect(result.status).toBe(500);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged.includes(basic)).toBe(false);
    expect(logged.includes(password)).toBe(false);
    expect(logged).toContain('diagnostic');
  });
  it('also hides internal action failures wrapped as viewer HTTP errors', async () => {
    dispatch.mockResolvedValue({
      status: 'failed',
      error: {
        kind: 'execution_failed',
        code: 'INTERNAL_DETAIL',
        message: 'internal storage diagnostic',
      },
    });
    await serve();
    const result = await request('/api/operator/tasks');
    expect(result.status).toBe(502);
    expect(result.body).not.toContain('internal storage diagnostic');
    expect(JSON.parse(result.body).message).toBe('Internal server error');
    expect(JSON.stringify(errors.mock.calls)).toContain('internal storage diagnostic');
  });
});

describe('bounded daemon log reads', () => {
  function logFile(content: string) {
    const root = fs.mkdtempSync(join(tmpdir(), 'viewer-log-'));
    roots.push(root);
    const path = join(root, 'daemon.log');
    fs.writeFileSync(path, content);
    return path;
  }
  it('reads only a bounded tail from a large file and preserves complete UTF-8 lines', async () => {
    const logPath = logFile('old line\n'.repeat(150000) + '\uCCAB\uC9F8\r\n\uB458\uC9F8\n');
    await serve({ logPath });
    const wholeFile = vi.mocked(fs.readFileSync).mockClear();
    const reads = vi.mocked(fs.readSync).mockClear();
    const result = await request('/api/logs/daemon?limit=2');
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.lines).toEqual(['\uCCAB\uC9F8', '\uB458\uC9F8']);
    expect(body.truncated).toBe(true);
    expect(wholeFile.mock.calls.some(([path]) => path === logPath)).toBe(false);
    expect(
      reads.mock.results.reduce((sum, item) => sum + Number(item.value), 0)
    ).toBeLessThanOrEqual(256 * 1024);
  });
  it('honors the viewer tail parameter and does not read unchanged files', async () => {
    const logPath = logFile('one\n\ntwo\r\nthree\n');
    await serve({ logPath });
    expect(JSON.parse((await request('/api/logs/daemon?tail=2')).body).lines).toEqual([
      'two',
      'three',
    ]);
    const reads = vi.mocked(fs.readSync).mockClear();
    expect(
      JSON.parse((await request(`/api/logs/daemon?since=${Date.now() + 10000}`)).body).lines
    ).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });
  it('keeps reading within the byte ceiling to return nonempty lines separated by blanks', async () => {
    await serve({ logPath: logFile('first\n' + '\n'.repeat(20000) + 'last\n') });
    const body = JSON.parse((await request('/api/logs/daemon?limit=2')).body);
    expect(body.lines).toEqual(['first', 'last']);
  });
  it('reports truncation instead of returning a partial oversized line', async () => {
    await serve({ logPath: logFile('x'.repeat(500000) + '\nlast\n') });
    const body = JSON.parse((await request('/api/logs/daemon?limit=2')).body);
    expect(body.lines).toEqual(['last']);
    expect(body.truncated).toBe(true);
  });
});

function securityPath() {
  return join(process.env.HOME!, '.mama', 'logs', 'security-events.jsonl');
}
function securityRows() {
  return fs
    .readFileSync(securityPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
let accessIssuerPort = 21000;
function signedAccess(email: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = `https://127.0.0.1:${accessIssuerPort++}`;
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', issuer);
  vi.stubEnv('MAMA_CF_ACCESS_AUD', 'fixture');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] }),
    }))
  );
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({ iss: issuer, aud: 'fixture', exp: Date.now() / 1000 + 120, email })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const tunnel = { 'cf-ray': '0123456789abcdef-TST', 'cf-ipcountry': 'KR' };

describe('security events and owner alerts', () => {
  it('records public tunnel access, local refusals and every scanner fingerprint once', async () => {
    await serve();
    await request('/health?private=true', tunnel);
    await request('/api/runtime/status', {}, '192.0.2.2');
    await request('/health', { host: '192.0.2.2' });
    dispatch.mockResolvedValue({
      status: 'failed',
      error: { kind: 'denied', code: 'DENIED', message: 'Denied' },
    });
    await request('/api/operator/tasks');
    for (const path of [
      '/.env',
      '/.git/config',
      '/wp-login.php',
      '/phpmyadmin',
      '/.aws/credentials',
      '/config',
      '/server-status',
      '/mama-memory.db',
    ])
      await request(path, tunnel);
    const rows = securityRows();
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 4).map((row) => [row.class, row.status, row.identity])).toEqual([
      ['public_asset', 200, 'anonymous'],
      ['auth_failed', 401, 'anonymous'],
      ['host_rejected', 421, 'anonymous'],
      ['auth_failed', 403, 'anonymous'],
    ]);
    expect(rows[0]).toMatchObject({
      method: 'GET',
      path: '/health',
      cfRay: tunnel['cf-ray'],
      country: 'KR',
      time: expect.any(String),
    });
    expect(rows.slice(4).every((row) => row.class === 'probe')).toBe(true);
    expect(fs.statSync(securityPath()).mode & 0o777).toBe(0o600);
  });
  it('records a served asset fetched without credentials as public_asset and does not alert', async () => {
    const sendToOwner = vi.fn(async (_text: string, _key: string) => {});
    await serve({ securityEvents: { sendToOwner } });
    const result = await request('/viewer/manifest.json', { ...tunnel });
    expect(result.status).toBeLessThan(400);
    expect(securityRows().map((row) => row.class)).toEqual(['public_asset']);
    expect(sendToOwner).not.toHaveBeenCalled();
  });

  it('classifies an anonymous tunnel 404 as request failure, not failed authentication', async () => {
    await serve();
    const result = await request('/missing-static-resource', tunnel);
    expect(result.status).toBe(404);
    expect(securityRows()[0].class).toBe('request_failed');
  });
  it('records token owner access and forged headers even with a valid token', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    const sendToOwner = vi.fn(async (_text: string, _key: string) => {});
    await serve({
      securityEvents: { sendToOwner },
      getRuntimeStatus: () => ({ running: true }) as never,
    });
    await request('/api/runtime/status', { ...tunnel, authorization: `Bearer ${token}` });
    expect(sendToOwner).not.toHaveBeenCalled();
    await request('/api/runtime/status', {
      ...tunnel,
      authorization: `Bearer ${token}`,
      'cf-access-jwt-assertion': 'invalid',
    });
    await request('/health', { 'cf-access-authenticated-user-email': 'fixture@invalid' });
    expect(securityRows().map((row) => row.class)).toEqual([
      'owner_access',
      'forged_access_header',
      'forged_access_header',
    ]);
    expect(sendToOwner).toHaveBeenCalledTimes(1);
    // Each alert's idempotency key names the security event it reports.
    const alertKeys = sendToOwner.mock.calls.map(([, key]) => key);
    const rows = securityRows() as Array<{ class: string; eventId?: string }>;
    expect(alertKeys).toEqual(
      rows
        .filter((row) => row.class !== 'owner_access')
        .slice(0, 1)
        .map((row) => `viewer-security:${row.eventId}`)
    );
    expect(fs.readFileSync(securityPath(), 'utf8')).not.toContain(token);
    expect(fs.readFileSync(securityPath(), 'utf8')).not.toContain('fixture@invalid');
  });
  it.each([undefined, ' FIXTURE@INVALID ', 'other@invalid', ''])(
    'hashes verified emails and only observes unknown identities (%s)',
    async (owners) => {
      if (owners === undefined) delete process.env.MAMA_VIEWER_OWNER_EMAILS;
      else vi.stubEnv('MAMA_VIEWER_OWNER_EMAILS', owners);
      const email = 'fixture@invalid';
      const assertion = signedAccess(email);
      const sendToOwner = vi.fn(async () => {});
      await serve({
        securityEvents: { sendToOwner },
        getRuntimeStatus: () => ({ running: true }) as never,
      });
      expect(
        (await request('/api/runtime/status', { ...tunnel, 'cf-access-jwt-assertion': assertion }))
          .status
      ).toBe(200);
      const unknown = owners === 'other@invalid' || owners === '';
      expect(securityRows()[0]).toMatchObject({
        class: unknown ? 'unknown_identity' : 'owner_access',
        identity: `access:${createHash('sha256').update(email).digest('hex').slice(0, 12)}`,
      });
      expect(sendToOwner).toHaveBeenCalledTimes(unknown ? 1 : 0);
      const contents = fs.readFileSync(securityPath(), 'utf8');
      expect(contents).not.toContain(email);
      expect(contents).not.toContain(assertion);
    }
  );
  it('alerts once per class per ten minutes and reports suppressed paths', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const sendToOwner = vi.fn(async (_text: string, _key: string) => {});
    await serve({ securityEvents: { sendToOwner } });
    await request('/api/report', tunnel);
    await request('/api/report', tunnel);
    await request('/health', { ...tunnel, 'cf-access-jwt-assertion': 'invalid' });
    await request('/api/runtime/status', tunnel);
    expect(sendToOwner).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-09-27T00:09:59Z'));
    await request('/api/runtime/status', tunnel);
    expect(sendToOwner).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-09-27T00:10:00Z'));
    await request('/api/runtime/status', tunnel);
    expect(sendToOwner).toHaveBeenCalledTimes(3);
    const text = sendToOwner.mock.calls[0]![0];
    // Whether ko-KR writes the day period as "AM" or in Korean depends on the Node release's ICU.
    for (const value of ['auth_failed', '/api/report', '401', ' 9:00:00', '(Asia/Seoul)', 'KR'])
      expect(text).toContain(value);
    expect(text).not.toContain(tunnel['cf-ray']);
    expect(sendToOwner.mock.calls[2]![0]).toContain('Suppressed since previous alert: 3');
    expect(securityRows()).toHaveLength(6);
    expect(securityRows().map((row) => row.suppressedSinceLastAlert)).toEqual([0, 1, 0, 2, 3, 3]);
  });
  it('logs one failed send and never schedules a retry', async () => {
    const secret = randomBytes(24).toString('hex');
    const sendToOwner = vi.fn(async () => {
      throw new Error(secret);
    });
    await serve({ securityEvents: { sendToOwner } });
    await request('/api/runtime/status', tunnel);
    await request('/api/runtime/status', tunnel);
    expect(sendToOwner).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.stringify(errors.mock.calls)).toContain('security_alert_failed');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(secret);
    expect(securityRows()).toHaveLength(2);
  });
  it('records in replay mode without sending alerts', async () => {
    const sendToOwner = vi.fn(async () => {});
    await serve({ securityEvents: { replay: true, sendToOwner } });
    await request('/.env', tunnel);
    expect(securityRows()[0].class).toBe('probe');
    expect(sendToOwner).not.toHaveBeenCalled();
  });
  it('records authenticated non-success responses without mislabelling them as owner access', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    const sendToOwner = vi.fn(async () => {});
    await serve({
      securityEvents: { sendToOwner },
      getRuntimeStatus: () => {
        throw new Error('fixture');
      },
    });
    const headers = { ...tunnel, authorization: `Bearer ${token}` };
    expect((await request('/api/missing', headers)).status).toBe(404);
    expect((await request('/api/runtime/status', headers)).status).toBe(500);
    dispatch.mockResolvedValue({
      status: 'failed',
      error: { kind: 'denied', code: 'DENIED', message: 'Denied' },
    });
    expect((await request('/api/operator/tasks', headers)).status).toBe(403);
    expect(securityRows().map((row) => row.class)).toEqual([
      'request_failed',
      'request_failed',
      'request_failed',
    ]);
    expect(sendToOwner).toHaveBeenCalledTimes(1);
  });
  it('keeps recording while a send is pending and does not launch duplicate sends', async () => {
    let finish!: () => void;
    const sendToOwner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await serve({ securityEvents: { sendToOwner } });
    await Promise.all([
      request('/api/runtime/status', tunnel),
      request('/api/runtime/status', tunnel),
    ]);
    expect(securityRows()).toHaveLength(2);
    expect(sendToOwner).toHaveBeenCalledOnce();
    finish();
  });
  it('preserves the response and alerts if the event file cannot be written', async () => {
    const sendToOwner = vi.fn(async () => {});
    await serve({ securityEvents: { path: process.env.HOME, sendToOwner } });
    expect((await request('/api/runtime/status', tunnel)).status).toBe(401);
    expect(sendToOwner).toHaveBeenCalledOnce();
    expect(JSON.stringify(errors.mock.calls)).toContain('security_event_write_failed');
  });
  it('keeps credentials and emails out of event paths', async () => {
    const token = randomBytes(24).toString('hex');
    vi.stubEnv('MAMA_AUTH_TOKEN', token);
    const email = 'fixture@invalid';
    await serve();
    await request(`/api/${encodeURIComponent(email)}/${token}?secret=${token}`, {
      ...tunnel,
      'cf-access-authenticated-user-email': email,
    });
    const contents = fs.readFileSync(securityPath(), 'utf8');
    expect(contents).not.toContain(email);
    expect(contents).not.toContain(token);
    expect(contents).not.toContain('?');
  });
});

describe('security events API', () => {
  it('stores and serves only principal, host and time for a member refusal, even with extra input fields', async () => {
    const path = join(process.env.HOME!, 'member-security.jsonl');
    const sent: string[] = [];
    const recorder = createOutboundEventRecorder({
      path,
      timeZone: createTimeZoneSetting('UTC'),
      sendToOwner: async (text) => {
        sent.push(text);
      },
    });
    const event = {
      principalId: 'fixture-member',
      host: 'upload.example:443',
      time: '2026-10-09T00:00:00.000Z',
    };
    recorder.record({
      ...event,
      class: 'outbound_connect',
      tool: 'sandbox proxy',
      summary: 'MEMBER_CONTENT_SENTINEL',
      sendsData: null,
      modelRunId: 'MEMBER_CONTENT_SENTINEL',
      callId: 'MEMBER_CONTENT_SENTINEL',
      command: 'MEMBER_CONTENT_SENTINEL',
      url: 'https://upload.example/MEMBER_CONTENT_SENTINEL?q=MEMBER_CONTENT_SENTINEL',
      body: 'MEMBER_CONTENT_SENTINEL',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.split('\n')).toEqual([
      'Member connection refused by the sandbox proxy',
      'Member: fixture-member',
      'Host: upload.example:443',
      `Time: ${new Date(event.time).toLocaleString('ko-KR', { timeZone: 'UTC' })} (UTC)`,
    ]);
    // A repeat to the same host within the window is stored but grouped into that alert.
    recorder.record(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(fs.readFileSync(path, 'utf8')).toBe(`${JSON.stringify(event)}\n`.repeat(2));
    await serve({ securityEvents: { path } });
    const response = await request('/api/security/events');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).events).toEqual([event, event]);
    expect(response.body).not.toContain('MEMBER_CONTENT_SENTINEL');
  });
  it('drops a partial oversized first line and limits reads to 256 KiB', async () => {
    await serve();
    await request('/api/runtime/status', tunnel);
    const line = fs.readFileSync(securityPath(), 'utf8');
    fs.writeFileSync(securityPath(), 'x'.repeat(500000) + '\n' + line);
    const reads = vi.mocked(fs.readSync).mockClear();
    const response = await request('/api/security/events?limit=2');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).events).toHaveLength(1);
    expect(JSON.parse(response.body).truncated).toBe(true);
    expect(
      reads.mock.results.reduce((sum, item) => sum + Number(item.value), 0)
    ).toBeLessThanOrEqual(256 * 1024);
  });
  it('requires owner auth and bounds both row count and file reads', async () => {
    await serve();
    await request('/api/runtime/status', tunnel);
    const path = securityPath();
    const line = fs.readFileSync(path, 'utf8');
    fs.writeFileSync(path, line.repeat(4000));
    const wholeFile = vi.mocked(fs.readFileSync).mockClear();
    const reads = vi.mocked(fs.readSync).mockClear();
    const response = await request('/api/security/events?limit=2');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).events).toHaveLength(2);
    expect(JSON.parse(response.body).truncated).toBe(true);
    expect(wholeFile.mock.calls.some(([file]) => file === path)).toBe(false);
    expect(
      reads.mock.results.reduce((sum, item) => sum + Number(item.value), 0)
    ).toBeLessThanOrEqual(256 * 1024);
    for (const limit of ['0', '-1', '2001', '1.5', 'NaN'])
      expect((await request(`/api/security/events?limit=${limit}`)).status).toBe(400);
    expect((await request('/api/security/events', tunnel)).status).toBe(401);
    expect((await request('/api/security/events', {}, '192.0.2.2')).status).toBe(401);
  });
  it('returns an empty list before the first security event', async () => {
    await serve();
    const result = await request('/api/security/events');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).events).toEqual([]);
    expect(fs.existsSync(securityPath())).toBe(false);
  });
});
