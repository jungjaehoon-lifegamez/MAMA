import { mkdtempSync, rmSync } from 'node:fs';
import { request, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionDispatcher } from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { verifiedCfAccessEmail } from '../../src/api/cf-access.js';
import { createReportStore } from '../../src/api/report-handler.js';
import {
  createViewerServer,
  REPORT_STREAM_LIMIT,
  type ViewerServer,
} from '../../src/api/viewer-server.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

vi.mock('../../src/api/cf-access.js', async (original) => ({
  ...(await original<typeof import('../../src/api/cf-access.js')>()),
  verifiedCfAccessEmail: vi.fn(),
}));

let home: string;
let viewer: ViewerServer | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'viewer-report-stream-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_AUTH_TOKEN', '');
  vi.stubEnv('MAMA_CF_ACCESS_ISSUER', '');
  vi.stubEnv('MAMA_CF_ACCESS_AUD', '');
  vi.stubEnv('MAMA_VIEWER_HOSTNAMES', '');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await viewer?.stop();
  viewer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('report streams on a real socket', () => {
  it('keeps no stream for a tunnel client that left during Access verification', async () => {
    const reportSseClients = new Set<ServerResponse>();
    viewer = createViewerServer({
      timeZone: createTimeZoneSetting('UTC'),
      dispatch: (async () => {
        throw new Error('report streams run no action');
      }) as unknown as ActionDispatcher,
      ownerAccess: {} as JudgmentAccess,
      reportStore: createReportStore(),
      reportSseClients,
      port: 0,
      securityEvents: { path: join(home, 'security-events.jsonl') },
    });
    await viewer.start();

    // More dropped clients than the limit: a leaked slot each would refuse the owner below.
    for (let index = 0; index < REPORT_STREAM_LIMIT; index++) {
      let left!: () => void;
      const clientLeft = new Promise<void>((resolve) => (left = resolve));
      viewer.server!.once('connection', (socket) => socket.once('close', () => left()));
      let verifying!: () => void;
      const verificationStarted = new Promise<void>((resolve) => (verifying = resolve));
      // The signing-key fetch outlasts the client: verification ends after its connection closed.
      vi.mocked(verifiedCfAccessEmail).mockImplementationOnce(async () => {
        verifying();
        await clientLeft;
        return 'owner@fixture.invalid';
      });
      const client = request({
        host: '127.0.0.1',
        port: viewer.port,
        path: '/api/report/events',
        headers: { 'cf-ray': '0123456789abcdef-TST', 'cf-access-jwt-assertion': 'fixture' },
      });
      client.on('error', () => {});
      client.end();
      await verificationStarted;
      client.destroy();
      await clientLeft;
    }

    const status = await new Promise<number>((resolve, reject) => {
      const owner = request(
        { host: '127.0.0.1', port: viewer!.port, path: '/api/report/events' },
        (response) => {
          resolve(response.statusCode!);
          owner.destroy();
        }
      );
      owner.on('error', reject);
      owner.end();
    });
    expect(status).toBe(200);
    // The owner's stream was the only one kept, and it goes when its client does.
    await vi.waitFor(() => expect(reportSseClients.size).toBe(0));
  });
});
