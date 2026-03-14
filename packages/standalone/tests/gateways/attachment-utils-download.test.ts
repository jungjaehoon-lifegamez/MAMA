import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lookupMock = vi.fn();
const httpsRequestMock = vi.fn();
const httpRequestMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

vi.mock('node:https', () => ({
  request: httpsRequestMock,
}));

vi.mock('node:http', () => ({
  request: httpRequestMock,
}));

function queueRequestResponse(
  mock: typeof httpsRequestMock,
  response: {
    statusCode: number;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }
) {
  mock.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
      setTimeout: (_ms: number, _callback: () => void) => void;
    };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        headers: Record<string, string>;
      };
      res.statusCode = response.statusCode;
      res.headers = response.headers || {};
      callback(res);
      if (response.body) {
        res.emit('data', Buffer.from(response.body));
      }
      res.emit('end');
    };
    req.destroy = () => undefined;
    req.setTimeout = () => undefined;
    return req;
  });
}

describe('downloadFile SSRF guards', () => {
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'mama-attachment-download-'));
    process.env.HOME = testHome;
    lookupMock.mockReset();
    httpsRequestMock.mockReset();
    httpRequestMock.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    const { flushSecurityMonitor, resetSecurityMonitorForTests } =
      await import('../../src/security/security-monitor.js');
    await flushSecurityMonitor();
    resetSecurityMonitorForTests();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.unstubAllGlobals();
    await rm(testHome, { recursive: true, force: true });
  });

  it('blocks DNS results that resolve to loopback IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('private/reserved IP "127.0.0.1"');
  });

  it('blocks DNS results that resolve to IPv6 loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('loopback/internal IPv6 "::1"');
  });

  it('blocks IPv6-mapped IPv4 loopback addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('private/reserved IP "127.0.0.1"');
  });

  it('blocks hex-form IPv4-mapped IPv6 loopback addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('private/reserved IP "127.0.0.1"');
  });

  it('blocks carrier-grade NAT IPv4 literals', async () => {
    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(downloadFile('https://100.64.10.20/payload.txt', 'payload.txt')).rejects.toThrow(
      'private/reserved IP "100.64.10.20"'
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://192.0.2.10/payload.txt',
    'https://198.51.100.20/payload.txt',
    'https://203.0.113.30/payload.txt',
    'https://224.0.0.1/payload.txt',
    'https://255.255.255.255/payload.txt',
  ])('blocks additional reserved IPv4 literals: %s', async (url) => {
    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(downloadFile(url, 'payload.txt')).rejects.toThrow('private/reserved IP');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('uses manual redirect handling for successful downloads', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    queueRequestResponse(httpsRequestMock, {
      statusCode: 200,
      body: new Uint8Array([1, 2, 3]),
    });

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    const localPath = await downloadFile('https://example.com/file.bin', 'file.bin');

    expect(localPath).toContain('.mama/workspace/media/inbound/');
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: {},
    });
    expect(typeof httpsRequestMock.mock.calls[0]?.[1]?.lookup).toBe('function');
  });

  it('blocks HTTP redirects during download', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    queueRequestResponse(httpsRequestMock, {
      statusCode: 302,
      headers: { location: 'http://127.0.0.1/secret' },
    });

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(downloadFile('https://example.com/file.bin', 'file.bin')).rejects.toThrow(
      'Blocked redirect while downloading attachment: 302'
    );
  });
});
