import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConnectorConfig } from '../../src/connectors/config-loader.js';
import { loadConfig } from '../../src/runtime/config.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('W1 real owner configuration shape', () => {
  it('loads the owner YAML and connector JSON without validating retired fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'w1-real-config-'));
    roots.push(root);
    const configPath = join(root, 'config.yaml');
    const connectorsPath = join(root, 'connectors.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(
      configPath,
      [
        'version: 1',
        'agent:',
        '  backend: codex',
        '  model: placeholder-model',
        '  max_turns: 10',
        '  run_token_budget: 100',
        '  timeout: 1000',
        '  tools:',
        '    gateway: ["*"]',
        '    mcp: ["mcp__placeholder__*"]',
        '    mcp_config: ~/state/mcp-config.json',
        '  effort: high',
        '  cline_command: placeholder-cline',
        '  cline_provider: placeholder-provider',
        'database:',
        '  path: ~/state/memory.db',
        'logging:',
        '  level: info',
        '  file: ~/state/daemon.log',
        'roles:',
        '  definitions: {}',
        '  sourceMapping: {}',
        'use_claude_cli: true',
        'enable_auto_kill_port: false',
        'prompt: {}',
        'timeouts: {}',
        'gateway_tuning: {}',
        'io: {}',
        'metrics: {}',
        'token_budget: {}',
        'scheduling:',
        '  jobs: []',
        'multi_agent: {}',
        'os_operator:',
        '  full_report_hours: 24',
        'telegram:',
        '  enabled: true',
        '  owner_chat_id: "-100123456789"',
        '  os_report_chat_id: 999999999',
        '  allowed_chats: ["-100123456789"]',
        'wiki:',
        '  enabled: true',
        '  vaultPath: ~/wiki',
        '  wikiDir: ~/wiki/pages',
        'conductor:',
        '  enabled: false',
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      connectorsPath,
      JSON.stringify({
        'claude-code': {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
        chatwork: {
          enabled: true,
          pollIntervalMinutes: 5,
          historicalBackfill: true,
          channels: { room: { role: 'hub' } },
          auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
        },
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { channel: { role: 'hub' } },
          auth: { type: 'token', tokenName: 'MAMA_SLACK_TOKEN' },
        },
        telegram: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'MAMA_TELEGRAM_SOURCE_TOKEN' },
        },
        kagemusha: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { room: { role: 'hub' } },
          auth: { type: 'none' },
        },
        gmail: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'cli' },
        },
        calendar: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'cli' },
        },
        drive: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'cli' },
        },
        sheets: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'cli' },
        },
        trello: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { board: { role: 'hub' } },
          auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' },
        },
      }),
      'utf8'
    );

    const config = loadConfig({ path: configPath, home: root });
    const connectors = loadConnectorConfig(connectorsPath);

    expect(config).toMatchObject({
      version: 1,
      agent: {
        backend: 'codex',
        model: 'placeholder-model',
        effort: 'high',
        max_turns: 10,
        timeout: 1000,
        run_token_budget: 100,
        tools: { mcp_config: join(root, 'state/mcp-config.json') },
      },
      telegram: {
        enabled: true,
        owner_chat_id: '-100123456789',
        allowed_chats: ['-100123456789'],
      },
    });
    expect(connectors).toMatchObject({
      ok: true,
      enabledNames: ['chatwork', 'slack', 'kagemusha', 'trello'],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored in W1'));
    const warningText = warn.mock.calls.flat().join(' ');
    expect(warningText).toContain('roles');
    expect(warningText).not.toContain('gmail');
    expect(warningText).not.toContain('calendar');
    expect(warningText).toContain('historicalBackfill');
    expect(warningText).not.toContain('agent.max_turns');
    expect(warningText).not.toContain('placeholder-telegram-token');
  });
});
