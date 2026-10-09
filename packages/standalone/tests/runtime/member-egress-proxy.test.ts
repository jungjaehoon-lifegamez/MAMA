import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMemberEgressProxy, type EgressProxy } from '../../src/runtime/egress-proxy.js';
import { createOutboundEventRecorder } from '../../src/api/security-events.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { createViewerServer, type ViewerServer } from '../../src/api/viewer-server.js';

const proxies: EgressProxy[] = [];
const roots: string[] = [];
let viewer: ViewerServer | undefined;
afterEach(async () => {
  await viewer?.stop();
  viewer = undefined;
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
function exchange(port: number, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const reply: Buffer[] = [];
    socket.on('connect', () => socket.write(data));
    socket.on('data', (chunk) => reply.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(reply)));
    socket.on('error', reject);
  });
}

describe('member egress refusals (TCP binding)', () => {
  it.each(['http', 'socks'] as const)(
    'attributes two members and sends exactly one minimal event per %s refusal',
    async (protocol) => {
      const root = mkdtempSync(join(tmpdir(), 'member-proxy-'));
      roots.push(root);
      vi.stubEnv('HOME', root);
      vi.stubEnv('MAMA_AUTH_TOKEN', '');
      vi.stubEnv('MAMA_VIEWER_HOSTNAMES', '');
      const path = join(root, 'security.jsonl');
      const sent: string[] = [];
      const recorder = createOutboundEventRecorder({
        path,
        timeZone: createTimeZoneSetting('UTC'),
        sendToOwner: async (text) => {
          sent.push(text);
        },
      });
      for (const principalId of ['fixture-member-a', 'fixture-member-b']) {
        proxies.push(await startMemberEgressProxy(principalId, recorder.record));
      }
      expect(proxies[0].httpProxyPort).not.toBe(proxies[1].httpProxyPort);
      expect(proxies[0].socksProxyPort).not.toBe(proxies[1].socksProxyPort);
      const host = Buffer.from('upload.example');
      const sentinel = 'MEMBER_PROXY_SENTINEL';
      const http = Buffer.from(
        `POST http://upload.example:443/${sentinel}?q=${sentinel} HTTP/1.1\r\nHost: upload.example\r\nContent-Length: ${sentinel.length}\r\nX-Command: curl ${sentinel}\r\n\r\n${sentinel}`
      );
      const socks = Buffer.concat([
        Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]),
        host,
        Buffer.from([1, 187]),
        Buffer.from(
          `POST /${sentinel}?q=${sentinel}\r\nX-Command: curl ${sentinel}\r\n\r\n${sentinel}`
        ),
      ]);
      const before = Date.now();
      const replies = await Promise.all(
        proxies.map((proxy) =>
          exchange(
            protocol === 'http' ? proxy.httpProxyPort : proxy.socksProxyPort,
            protocol === 'http' ? http : socks
          )
        )
      );
      replies.forEach((reply) =>
        protocol === 'http'
          ? expect(reply.toString()).toMatch(/^HTTP\/1.1 403/)
          : expect([...reply]).toEqual([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0])
      );
      const log = readFileSync(path, 'utf8');
      const events = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect(sent).toHaveLength(2);
      expect(events.map((event) => event.principalId).sort()).toEqual([
        'fixture-member-a',
        'fixture-member-b',
      ]);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(['host', 'principalId', 'time']);
        expect(event.host).toBe('upload.example:443');
        expect(Date.parse(event.time)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(event.time)).toBeLessThanOrEqual(Date.now());
      }
      for (const event of events)
        expect(
          sent.some((text) =>
            text.includes(`Member: ${event.principalId}\nHost: upload.example:443`)
          )
        ).toBe(true);
      expect(log + sent.join('')).not.toContain(sentinel);
      viewer = createViewerServer({
        port: 0,
        host: '127.0.0.1',
        dispatch: vi.fn(),
        ownerAccess: {} as never,
        timeZone: createTimeZoneSetting('UTC'),
        logPath: join(root, 'daemon.log'),
        securityEvents: { path, timeZone: createTimeZoneSetting('UTC') },
      });
      await viewer.start();
      const response = await fetch(`http://127.0.0.1:${viewer.port}/api/security/events`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body).events).toEqual(events);
      expect(body).not.toContain(sentinel);
    }
  );
});
