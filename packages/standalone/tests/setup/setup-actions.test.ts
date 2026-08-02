import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';

import type { IModelRunner } from '../../src/agent/model-runner.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import {
  createSetupActionExecutor,
  parseSetupActions,
  SETUP_ACTION_PROTOCOL,
} from '../../src/setup/setup-actions.js';
import { createSetupWebSocketHandler } from '../../src/setup/setup-websocket.js';
import { SETUP_SYSTEM_PROMPT } from '../../src/setup/setup-prompt.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baseConfig(): MAMAConfig {
  return {
    agent: {
      backend: 'claude',
      model: 'claude-sonnet-4-6',
      max_turns: 1,
      timeout: 1_000,
    },
    telegram: { enabled: false },
  } as MAMAConfig;
}

describe('TG-03/TG-04: backend-neutral setup host actions', () => {
  it('strips secret-bearing action tags from visible output and writes only approved files', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-actions-'));
    tempRoots.push(mamaHome);
    const executor = createSetupActionExecutor({ mamaHome, loadConfig: baseConfig });
    const parsed = parseSetupActions(
      'Saving now.\n<mama_setup_action>{"type":"write_file","name":"USER.md","content":"# Human"}</mama_setup_action>'
    );

    expect(parsed.visibleText).toBe('Saving now.');
    await expect(executor.execute(parsed.actions[0])).resolves.toMatchObject({ ok: true });
    expect(readFileSync(join(mamaHome, 'USER.md'), 'utf8')).toBe('# Human');
    await expect(
      executor.execute({ type: 'write_file', name: '../outside.md', content: 'nope' })
    ).resolves.toMatchObject({ ok: false, error: 'Unsupported setup file name' });
  });

  it('rejects an existing target symlink instead of following it outside ~/.mama', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-symlink-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'mama-setup-outside-')), 'outside.md');
    tempRoots.push(mamaHome, join(outside, '..'));
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(mamaHome, 'USER.md'));
    const executor = createSetupActionExecutor({ mamaHome, loadConfig: baseConfig });

    await expect(
      executor.execute({ type: 'write_file', name: 'USER.md', content: 'overwrite' })
    ).resolves.toMatchObject({ ok: false, error: 'Setup file target cannot be a symlink' });
    expect(readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('parses a valid action after a malformed response without retaining regex state', () => {
    expect(() => parseSetupActions('<mama_setup_action>{bad json}</mama_setup_action>')).toThrow(
      'valid JSON'
    );
    expect(
      parseSetupActions('<mama_setup_action>{"type":"mark_setup_complete"}</mama_setup_action>')
        .actions
    ).toEqual([{ type: 'mark_setup_complete' }]);
  });

  it.each([
    'save_integration_token("discord", { token: "secret" })\n✓ Saved',
    'update_config("discord.default_channel_id", "42")\nPerfect, configured.',
    '[validate token] ✓ Token is valid and saved.',
    '[mark_setup_complete] Setup complete.',
  ])('rejects legacy pseudo action output instead of exposing false success: %s', (response) => {
    expect(() => parseSetupActions(response)).toThrow(
      'Setup response used unsupported legacy action syntax'
    );
  });

  it('persists related config actions once and leaves shared config unchanged on failure', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-atomic-'));
    tempRoots.push(mamaHome);
    const config = baseConfig();
    const persistConfig = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    const executor = createSetupActionExecutor({
      mamaHome,
      loadConfig: () => config,
      persistConfig,
    });

    const results = await executor.executeBatch([
      { type: 'update_config', key: 'discord.enabled', value: true },
      { type: 'update_config', key: 'discord.default_channel_id', value: '42' },
    ]);

    expect(persistConfig).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      expect.objectContaining({ ok: false, error: 'disk unavailable' }),
      expect.objectContaining({ ok: false, error: 'disk unavailable' }),
    ]);
    expect(config.agent).toMatchObject({ backend: 'claude', model: 'claude-sonnet-4-6' });
    expect(config.discord).toBeUndefined();
  });

  it('refuses to persist a Discord token that the host cannot validate', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-discord-invalid-'));
    tempRoots.push(mamaHome);
    const config = baseConfig();
    const persistConfig = vi.fn(async () => undefined);
    const executor = createSetupActionExecutor({
      mamaHome,
      loadConfig: () => config,
      persistConfig,
      fetchImpl: vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    });

    await expect(
      executor.execute({ type: 'save_integration_token', platform: 'discord', token: 'invalid' })
    ).resolves.toMatchObject({ ok: false, error: 'Discord token validation failed' });
    expect(persistConfig).not.toHaveBeenCalled();
    expect(config.discord).toBeUndefined();
    await expect(
      executor.execute({ type: 'update_config', key: 'discord.token', value: 'bypass' })
    ).resolves.toMatchObject({ ok: false, error: 'Unsupported setup config key: discord.token' });
  });

  it.each([
    {
      platform: 'slack',
      action: {
        type: 'save_integration_token',
        platform: 'slack',
        bot_token: 'invalid-bot',
        app_token: 'invalid-app',
      },
      error: 'Slack token validation failed',
    },
    {
      platform: 'telegram',
      action: {
        type: 'save_integration_token',
        platform: 'telegram',
        token: 'invalid',
      },
      error: 'Telegram token validation failed',
    },
  ])('refuses to persist invalid $platform credentials', async ({ action, error }) => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-integration-invalid-'));
    tempRoots.push(mamaHome);
    const config = baseConfig();
    const persistConfig = vi.fn(async () => undefined);
    const executor = createSetupActionExecutor({
      mamaHome,
      loadConfig: () => config,
      persistConfig,
      fetchImpl: vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    });

    await expect(executor.execute(action)).resolves.toMatchObject({ ok: false, error });
    expect(persistConfig).not.toHaveBeenCalled();
  });

  it('validates both Slack credentials with the official endpoints before persisting', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-slack-valid-'));
    tempRoots.push(mamaHome);
    const config = baseConfig();
    const persistConfig = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const executor = createSetupActionExecutor({
      mamaHome,
      loadConfig: () => config,
      persistConfig,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      executor.execute({
        type: 'save_integration_token',
        platform: 'slack',
        bot_token: 'xoxb-valid',
        app_token: 'xapp-valid',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://slack.com/api/auth.test',
      expect.objectContaining({ headers: { Authorization: 'Bearer xoxb-valid' } })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/apps.connections.open',
      expect.objectContaining({ headers: { Authorization: 'Bearer xapp-valid' } })
    );
    expect(persistConfig).toHaveBeenCalledTimes(1);
  });

  it('reports earlier config actions as rolled back when a later action fails', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-rollback-'));
    tempRoots.push(mamaHome);
    const config = baseConfig();
    const persistConfig = vi.fn(async () => undefined);
    const executor = createSetupActionExecutor({
      mamaHome,
      loadConfig: () => config,
      persistConfig,
    });

    const results = await executor.executeBatch([
      { type: 'update_config', key: 'telegram.enabled', value: true },
      { type: 'unsupported_action' },
    ]);

    expect(results[0]).toMatchObject({
      ok: false,
      data: { rolled_back: true },
      error: expect.stringContaining('rolled back'),
    });
    expect(results[1]).toMatchObject({
      ok: false,
      error: 'Unsupported setup action: unsupported_action',
    });
    expect(persistConfig).not.toHaveBeenCalled();
    expect(config.telegram.enabled).toBe(false);
  });

  it('documents the canonical host-action schemas and Discord channel key', () => {
    expect(SETUP_ACTION_PROTOCOL).toContain('save_integration_token');
    expect(SETUP_ACTION_PROTOCOL).toContain('complete_onboarding');
    expect(SETUP_ACTION_PROTOCOL).toContain('discord.default_channel_id');
    expect(SETUP_SYSTEM_PROMPT).toContain('discord.default_channel_id');
    expect(SETUP_SYSTEM_PROMPT).not.toContain('discord.default_channel"');
    expect(SETUP_SYSTEM_PROMPT).not.toMatch(
      /\b(?:save_integration_token|update_config|validate_discord_token|mark_setup_complete)\s*\(/
    );
    expect(SETUP_SYSTEM_PROMPT).not.toMatch(
      /\[(?:validate token|save channel|mark_setup_complete)\]/i
    );
  });

  it.each(['claude', 'codex', 'cline'] as const)(
    'executes and confirms one real config mutation through the %s setup conversation',
    async (backend) => {
      const mamaHome = mkdtempSync(join(tmpdir(), `mama-setup-${backend}-`));
      tempRoots.push(mamaHome);
      const config = baseConfig();
      const persistConfig = vi.fn(async () => undefined);
      const actionExecutor = createSetupActionExecutor({
        mamaHome,
        loadConfig: () => config,
        persistConfig,
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => ({ ok: true }),
        })) as unknown as typeof fetch,
      });
      const wss = new EventEmitter() as WebSocketServer;
      const ws = new EventEmitter() as WebSocket & { terminate: ReturnType<typeof vi.fn> };
      let resolveAssistant = () => {};
      const assistantSent = new Promise<void>((resolve) => {
        resolveAssistant = resolve;
      });
      const browserMessages: string[] = [];
      ws.send = vi.fn((raw: string) => {
        browserMessages.push(raw);
        if (raw.includes('assistant_message')) resolveAssistant();
      });
      ws.close = vi.fn();
      ws.terminate = vi.fn();
      const prompt = vi
        .fn()
        .mockResolvedValueOnce({
          response:
            'Saving. <mama_setup_action>{"type":"save_integration_token","platform":"telegram","token":"secret-token","allowed_chats":["42"]}</mama_setup_action>',
        })
        .mockResolvedValueOnce({ response: 'Telegram was saved by the host.' });
      const runner = {
        backendType: backend,
        prompt,
        setSystemPrompt: vi.fn(),
        stop: vi.fn(),
      } as unknown as IModelRunner;
      const lifecycle = createSetupWebSocketHandler(
        wss,
        vi.fn(() => runner),
        () => actionExecutor,
        { allowedOrigins: ['http://127.0.0.1:3848'], consumeNonce: (nonce) => nonce === 'test' }
      );

      wss.emit('connection', ws, {
        url: '/setup-ws?nonce=test',
        headers: { origin: 'http://127.0.0.1:3848' },
      } as IncomingMessage);
      await Promise.resolve();
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'user_message', content: 'save it' })));
      await assistantSent;

      expect(config.telegram).toEqual({
        enabled: true,
        token: 'secret-token',
        allowed_chats: ['42'],
      });
      expect(persistConfig).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt.mock.calls[1]?.[0]).toContain('Trusted MAMA setup host action results');
      expect(browserMessages.join('\n')).not.toContain('secret-token');
      expect(browserMessages.join('\n')).not.toContain('Saving.');
      expect(browserMessages.join('\n')).toContain('Telegram was saved by the host.');
      await lifecycle.close();
    }
  );

  it('serializes rapid messages through one setup conversation lane', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-setup-queue-'));
    tempRoots.push(mamaHome);
    const actionExecutor = createSetupActionExecutor({ mamaHome, loadConfig: baseConfig });
    const wss = new EventEmitter() as WebSocketServer;
    const ws = new EventEmitter() as WebSocket & { terminate: ReturnType<typeof vi.fn> };
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const prompt = vi.fn(async (content: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (content === 'first') await firstGate;
      active -= 1;
      return { response: `done:${content}` };
    });
    let assistantMessages = 0;
    let resolveBoth = () => {};
    const bothSent = new Promise<void>((resolve) => {
      resolveBoth = resolve;
    });
    ws.send = vi.fn((raw: string) => {
      if (raw.includes('assistant_message')) {
        assistantMessages += 1;
        if (assistantMessages === 2) resolveBoth();
      }
    });
    ws.close = vi.fn();
    ws.terminate = vi.fn();
    const runner = {
      backendType: 'cline',
      prompt,
      setSystemPrompt: vi.fn(),
      stop: vi.fn(),
    } as unknown as IModelRunner;
    const lifecycle = createSetupWebSocketHandler(
      wss,
      vi.fn(() => runner),
      () => actionExecutor,
      { allowedOrigins: ['http://127.0.0.1:3848'], consumeNonce: (nonce) => nonce === 'queue' }
    );
    wss.emit('connection', ws, {
      url: '/setup-ws?nonce=queue',
      headers: { origin: 'http://127.0.0.1:3848' },
    } as IncomingMessage);
    await Promise.resolve();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user_message', content: 'first' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'user_message', content: 'second' })));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    releaseFirst();
    await bothSent;

    expect(prompt.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
    await lifecycle.close();
  });

  it('requires all persona files before completing autonomous onboarding', async () => {
    const mamaHome = mkdtempSync(join(tmpdir(), 'mama-onboarding-complete-'));
    tempRoots.push(mamaHome);
    const executor = createSetupActionExecutor({ mamaHome, loadConfig: baseConfig });

    await expect(
      executor.execute({ type: 'complete_onboarding', confirmed: true })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('IDENTITY.md') });
    for (const name of ['IDENTITY.md', 'USER.md', 'SOUL.md']) {
      await executor.execute({ type: 'write_file', name, content: `# ${name}` });
    }
    await expect(
      executor.execute({ type: 'complete_onboarding', confirmed: true })
    ).resolves.toMatchObject({ ok: true, data: { completed: true } });
    expect(existsSync(join(mamaHome, 'setup-complete.json'))).toBe(true);
  });
});
