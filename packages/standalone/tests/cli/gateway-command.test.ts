import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createGatewayCommand,
  gatewayTelegramDetectOwner,
  gatewayTelegramSet,
} from '../../src/cli/commands/gateway.js';
import { loadConfig, saveConfig } from '../../src/cli/config/config-manager.js';
import { DEFAULT_CONFIG } from '../../src/cli/config/types.js';

let home: string;
let originalHome: string | undefined;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchStub(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => response(body, status)) as unknown as typeof fetch;
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mama-gateway-command-'));
  process.env.HOME = home;
  const config = structuredClone(DEFAULT_CONFIG);
  config.telegram = { enabled: false };
  await saveConfig(config);
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('Story ONB-5: Telegram gateway setup is explicit and anchor-safe', () => {
  it('registers the agent-drivable gateway telegram command surface', () => {
    const command = createGatewayCommand();
    const telegram = command.commands.find((candidate) => candidate.name() === 'telegram');

    expect(telegram).toBeDefined();
    expect(telegram?.commands.some((candidate) => candidate.name() === 'detect-owner')).toBe(true);
  });

  it('reads a validated token from stdin and enables Telegram without printing the token', async () => {
    const output: string[] = [];
    const token = '123456:synthetic-token';
    const fetchImpl = fetchStub({ ok: true, result: { id: 123456 } });

    await gatewayTelegramSet({
      tokenStdin: true,
      readToken: async () => token,
      fetchImpl,
      writeOut: (line) => output.push(line),
    });

    const config = await loadConfig();
    expect(config.telegram).toMatchObject({ enabled: true, token });
    expect(output.join('\n')).not.toContain(token);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('lists unique private chat candidates without changing the allowlist', async () => {
    const output: string[] = [];
    const config = await loadConfig();
    config.telegram = { enabled: true, token: 'test-token' };
    await saveConfig(config);
    const fetchImpl = fetchStub({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'A' } } },
        { update_id: 2, message: { chat: { id: 111, type: 'private', first_name: 'A' } } },
        { update_id: 3, message: { chat: { id: -222, type: 'group', title: 'Ignored' } } },
        { update_id: 4, message: { chat: { id: 333, type: 'private', username: 'owner' } } },
      ],
    });

    await gatewayTelegramDetectOwner({ fetchImpl, writeOut: (line) => output.push(line) });

    expect(output.join('\n')).toContain('111');
    expect(output.join('\n')).toContain('333');
    expect(output.join('\n')).not.toContain('-222');
    expect((await loadConfig()).telegram?.allowed_chats ?? []).toEqual([]);
  });

  it('writes exactly the confirmed private chat id', async () => {
    const config = await loadConfig();
    config.telegram = { enabled: true, token: 'test-token', allowed_chats: ['999'] };
    await saveConfig(config);
    const fetchImpl = fetchStub({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Owner' } } },
      ],
    });

    await gatewayTelegramDetectOwner({ confirm: '111', fetchImpl, writeOut: () => {} });

    expect((await loadConfig()).telegram?.allowed_chats).toEqual(['111']);
  });

  it('translates Telegram 409 into the recovery instruction without a preflight daemon guard', async () => {
    const config = await loadConfig();
    config.telegram = { enabled: true, token: 'test-token' };
    await saveConfig(config);

    await expect(
      gatewayTelegramDetectOwner({
        fetchImpl: fetchStub({ ok: false, error_code: 409 }, 409),
        writeOut: () => {},
      })
    ).rejects.toThrow(
      'another consumer is polling this bot (daemon running?). Run: mama stop, then retry'
    );
  });
});
