import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReportCommand, reportNowCommand } from '../../src/cli/commands/report.js';

let home: string;
let mamaHome: string;
let originalAuthToken: string | undefined;

function acceptedResponse(): Response {
  return new Response(JSON.stringify({ ok: true, status: 'accepted' }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-report-command-'));
  mamaHome = join(home, '.mama');
  originalAuthToken = process.env.MAMA_AUTH_TOKEN;
  delete process.env.MAMA_AUTH_TOKEN;
});

afterEach(() => {
  if (originalAuthToken === undefined) {
    delete process.env.MAMA_AUTH_TOKEN;
  } else {
    process.env.MAMA_AUTH_TOKEN = originalAuthToken;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('Story ONB-6: mama report now reaches confirmed delivery', () => {
  it('registers the report now command surface', () => {
    const command = createReportCommand();
    expect(command.commands.some((candidate) => candidate.name() === 'now')).toBe(true);
  });

  it('fails loudly before HTTP when the daemon is stopped', async () => {
    const fetchImpl = vi.fn();

    await expect(
      reportNowCommand({
        mamaHome,
        daemonRunning: async () => false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        writeOut: () => {},
      })
    ).rejects.toThrow('MAMA daemon is not running. Run: mama start');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts one authenticated request and finishes only after the marker exists', async () => {
    const output: string[] = [];
    process.env.MAMA_AUTH_TOKEN = 'synthetic-api-token';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-api-token');
      mkdirSync(join(mamaHome, 'state'), { recursive: true });
      writeFileSync(
        join(mamaHome, 'state', 'first-report.json'),
        JSON.stringify({ at: '2026-08-28T00:00:00.000Z', channel: 'telegram' })
      );
      return acceptedResponse();
    }) as unknown as typeof fetch;

    await reportNowCommand({
      mamaHome,
      daemonRunning: async () => true,
      fetchImpl,
      writeOut: (line) => output.push(line),
      maxWaitMs: 10,
      pollIntervalMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('first report delivery confirmed');
  });

  it('returns success with a still-generating message after the bounded wait', async () => {
    const output: string[] = [];

    await expect(
      reportNowCommand({
        mamaHome,
        daemonRunning: async () => true,
        fetchImpl: vi.fn(async () => acceptedResponse()) as unknown as typeof fetch,
        writeOut: (line) => output.push(line),
        maxWaitMs: 0,
        pollIntervalMs: 1,
      })
    ).resolves.toBeUndefined();

    expect(existsSync(join(mamaHome, 'state', 'first-report.json'))).toBe(false);
    expect(output.join('\n')).toContain(
      'report is still being generated — check Telegram shortly, or re-run: mama status'
    );
  });
});
