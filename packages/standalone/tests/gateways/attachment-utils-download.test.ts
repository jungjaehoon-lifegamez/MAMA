import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

describe('downloadFile SSRF guards', () => {
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'mama-attachment-download-'));
    process.env.HOME = testHome;
    lookupMock.mockReset();
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
    vi.stubGlobal('fetch', vi.fn());

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('private/reserved IP "127.0.0.1"');
  });

  it('blocks DNS results that resolve to IPv6 loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
    vi.stubGlobal('fetch', vi.fn());

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('loopback/internal IPv6 "::1"');
  });

  it('blocks IPv6-mapped IPv4 loopback addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    vi.stubGlobal('fetch', vi.fn());

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(
      downloadFile('https://attacker.example/payload.txt', 'payload.txt')
    ).rejects.toThrow('private/reserved IP "127.0.0.1"');
  });

  it('blocks carrier-grade NAT IPv4 literals', async () => {
    vi.stubGlobal('fetch', vi.fn());

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
    vi.stubGlobal('fetch', vi.fn());

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(downloadFile(url, 'payload.txt')).rejects.toThrow('private/reserved IP');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('uses manual redirect handling for successful downloads', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    const localPath = await downloadFile('https://example.com/file.bin', 'file.bin');

    expect(localPath).toContain('.mama/workspace/media/inbound/');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.bin', {
      headers: {},
      redirect: 'manual',
    });
  });

  it('blocks HTTP redirects during download', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'http://127.0.0.1/secret' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { downloadFile } = await import('../../src/gateways/attachment-utils.js');

    await expect(downloadFile('https://example.com/file.bin', 'file.bin')).rejects.toThrow(
      'Blocked redirect while downloading attachment: 302'
    );
  });
});
