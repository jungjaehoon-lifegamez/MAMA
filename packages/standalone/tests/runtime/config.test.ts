import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, parseConfig, type W1Config } from '../../src/runtime/config.js';
import { validateDeliveryRoutes } from '../../src/cli/commands/daemon.js';

let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'report-config-'));
  vi.stubEnv('HOME', testHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(testHome, { recursive: true, force: true });
});

function validConfig(): W1Config {
  return {
    version: 1,
    timezone: 'Asia/Seoul',
    agent: {
      backend: 'codex',
      model: 'model-under-test',
      effort: 'high',
      max_turns: 30,
      timeout: 30_000,
      run_token_budget: 100,
      codex_home: '/tmp/codex-home',
      codex_cwd: '/tmp/codex-workspace',
      codex_sandbox: 'workspace-write',
      tools: { mcp_config: '/tmp/mcp.json' },
    },
    database: { path: '/tmp/mama-test.db' },
    logging: { level: 'info', file: '/tmp/mama-test.log' },
    telegram: {
      enabled: false,
      allowed_chats: ['chat-test'],
      owner_user_ids: ['owner-test'],
      polling: false,
    },
    discord: { enabled: false, allowed_channels: [], owner_user_ids: [] },
    slack: { enabled: false, allowed_channels: [], owner_user_ids: [] },
    delivery: { reports: 'telegram', notifications: 'telegram', security_alerts: 'telegram' },
    jev: {
      enabled: false,
      keyFile: '/tmp/jev-key',
      vocabFile: '/tmp/vocab.json',
    },
    reports: {
      full_report_hours: [8, 13, 18],
      reminder_start_hour: 9,
      reminder_end_hour: 21,
      daily_hour: 23,
    },
  };
}

describe('W1 runtime configuration', () => {
  it.each(['fixture-obsolete', '', null])(
    'rejects telegram.token without echoing it %#',
    (token) => {
      const path = join(testHome, 'config.yaml');
      const base = validConfig();
      writeFileSync(path, JSON.stringify({ ...base, telegram: { ...base.telegram, token } }));
      expect(() => loadConfig({ path })).toThrow(
        'run mama secret set MAMA_TELEGRAM_TOKEN and remove telegram.token'
      );
    }
  );

  it('does not include YAML source snippets in syntax errors', () => {
    const path = join(testHome, 'config.yaml');
    writeFileSync(path, 'telegram: [fixture-obsolete\n');
    let message = '';
    try {
      loadConfig({ path });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Cannot load config/);
    expect(message.includes('fixture-obsolete')).toBe(false);
  });
  it('defaults report hours and accepts custom KST hours through YAML without ignoring them', () => {
    const { reports, ...base } = validConfig();
    expect(parseConfig(base).reports).toEqual(reports);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = join(testHome, 'config.yaml');
    writeFileSync(
      path,
      JSON.stringify({
        ...base,
        reports: { full_report_hours: [0, 23], reminder_start_hour: 1, reminder_end_hour: 22 },
      })
    );
    expect(loadConfig({ path }).reports).toEqual({
      full_report_hours: [0, 23],
      reminder_start_hour: 1,
      reminder_end_hour: 22,
      daily_hour: 23,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(parseConfig({ ...base, reports: { full_report_hours: [] } }).reports).toEqual({
      ...reports,
      full_report_hours: [],
    });
  });

  it('defaults timezone to the machine zone and validates an explicit IANA zone', () => {
    const { timezone: _timezone, ...base } = validConfig();
    expect(parseConfig(base).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(parseConfig({ ...base, timezone: 'America/Los_Angeles' }).timezone).toBe(
      'America/Los_Angeles'
    );
    expect(() => parseConfig({ ...base, timezone: 'Invalid/Zone' })).toThrow(
      'timezone "Invalid/Zone" is not a valid IANA time zone'
    );
  });

  it.each([
    null,
    { full_report_hours: '8,13,18' },
    { full_report_hours: [24] },
    { full_report_hours: [-1] },
    { full_report_hours: [8.5] },
    { full_report_hours: ['8'] },
    { full_report_hours: null },
    { reminder_start_hour: -1 },
    { reminder_end_hour: 24 },
    { reminder_start_hour: 1.5 },
    { reminder_end_hour: null },
    { reminder_start_hour: 22, reminder_end_hour: 9 },
  ])('rejects invalid report hours: %j', (reports) => {
    expect(() => parseConfig({ ...validConfig(), reports })).toThrow(/reports/);
  });

  it('projects the approved YAML fields without retaining retired sections', () => {
    const parsed = parseConfig(validConfig());

    expect(parsed).toEqual(validConfig());
    expect(parsed).not.toHaveProperty('roles');
    expect(parsed).not.toHaveProperty('multi_agent');
  });

  it('reads the owner turn limit and still rejects invalid W1 fields', () => {
    expect(parseConfig({ ...validConfig(), multi_agent: {} })).toMatchObject(validConfig());
    expect(
      parseConfig({
        ...validConfig(),
        agent: { ...validConfig().agent, max_turns: 2 },
      })
    ).toMatchObject({ agent: { max_turns: 2 } });
    expect(() =>
      parseConfig({
        ...validConfig(),
        agent: { ...validConfig().agent, timeout: 0 },
      })
    ).toThrow(/agent\.timeout/);
  });

  it('polls Telegram when telegram.polling is absent, as the owner config has it', () => {
    const base = validConfig();
    const { polling: _polling, ...telegramWithoutPolling } = base.telegram;
    const parsed = parseConfig({ ...base, telegram: telegramWithoutPolling });
    expect(parsed.telegram.polling).toBe(true);
    expect(
      parseConfig({ ...base, telegram: { ...telegramWithoutPolling, polling: false } }).telegram
        .polling
    ).toBe(false);
  });

  it('requires an allowlisted owner chat when Telegram is enabled', () => {
    const base = validConfig();
    expect(() => parseConfig({ ...base, telegram: { ...base.telegram, enabled: true } })).toThrow(
      /telegram\.owner_chat_id is required/
    );
    expect(() =>
      parseConfig({
        ...base,
        telegram: { ...base.telegram, enabled: true, owner_chat_id: 'chat-other' },
      })
    ).toThrow(/telegram\.owner_chat_id must be listed in telegram\.allowed_chats/);
    expect(
      parseConfig({
        ...base,
        telegram: { ...base.telegram, enabled: true, owner_chat_id: 'chat-test' },
      }).telegram.owner_chat_id
    ).toBe('chat-test');
  });

  it('validates Discord and Slack owner destinations and delivery route names', () => {
    const base = validConfig();
    expect(() => parseConfig({ ...base, discord: { enabled: true } })).toThrow(
      /discord.owner_channel_id/
    );
    expect(() =>
      parseConfig({
        ...base,
        slack: { enabled: true, owner_channel_id: 'c', allowed_channels: ['c'] },
      })
    ).toThrow(/slack.owner_user_ids/);
    expect(
      parseConfig({
        ...base,
        discord: {
          enabled: true,
          owner_channel_id: 'c',
          allowed_channels: ['c'],
          owner_user_ids: ['u'],
        },
        delivery: { reports: 'discord', notifications: 'telegram', security_alerts: 'slack' },
      }).delivery
    ).toEqual({ reports: 'discord', notifications: 'telegram', security_alerts: 'slack' });
    expect(() =>
      parseConfig({
        ...base,
        delivery: { reports: 'email', notifications: 'telegram', security_alerts: 'telegram' },
      })
    ).toThrow(/delivery.reports/);
    expect(
      parseConfig({ ...base, delivery: { interrupted_notice: 'Interrupted; please resend.' } })
        .delivery
    ).toMatchObject({ reports: 'telegram', interrupted_notice: 'Interrupted; please resend.' });
    expect(() => parseConfig({ ...base, delivery: { interrupted_notice: ' ' } })).toThrow(
      /delivery.interrupted_notice/
    );
  });

  it('fails startup when a delivery route names a disabled or unconfigured messenger', () => {
    const base = validConfig();
    expect(() => validateDeliveryRoutes(base)).toThrow(/delivery.reports targets telegram/);
    const telegram = {
      ...base,
      telegram: { ...base.telegram, enabled: true, owner_chat_id: 'chat-test' },
    };
    expect(() => validateDeliveryRoutes(telegram)).not.toThrow();
    expect(() =>
      validateDeliveryRoutes({
        ...telegram,
        delivery: { ...telegram.delivery!, notifications: 'discord' },
      })
    ).toThrow(/delivery.notifications targets discord/);
    // The notice text is not a route: a configured notice must not fail startup.
    expect(() =>
      validateDeliveryRoutes({
        ...telegram,
        delivery: { ...telegram.delivery!, interrupted_notice: 'Interrupted; please resend.' },
      })
    ).not.toThrow();
  });

  it('loads YAML from an explicit path and fails on a missing required section', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-'));
    try {
      const path = join(root, 'config.yaml');
      writeFileSync(
        path,
        `version: 1\nagent:\n  backend: codex\n  model: test\n  max_turns: 20\n  timeout: 1000\ndatabase:\n  path: ${join(root, 'db.sqlite')}\nlogging:\n  level: info\n  file: ${join(root, 'mama.log')}\n`
      );
      expect(loadConfig({ path })).toMatchObject({
        version: 1,
        agent: {
          backend: 'codex',
          model: 'test',
          effort: 'medium',
          max_turns: 20,
          run_token_budget: 0,
        },
      });

      writeFileSync(
        path,
        `version: 1\nagent: {}\ndatabase:\n  path: ${join(root, 'db.sqlite')}\nlogging:\n  level: info\n  file: ${join(root, 'mama.log')}\n`
      );
      expect(() => loadConfig({ path })).toThrow(/agent\.backend/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves product-owned home-relative paths before the core boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-home-'));
    try {
      const path = join(root, 'config.yaml');
      writeFileSync(
        path,
        'version: 1\nagent:\n  backend: codex\n  model: test\n  max_turns: 20\n  timeout: 1000\ndatabase:\n  path: ~/.data/memory.db\nlogging:\n  level: info\n  file: ~/.data/mama.log\n'
      );
      expect(loadConfig({ path, home: root })).toMatchObject({
        database: { path: join(root, '.data/memory.db') },
        logging: { file: join(root, '.data/mama.log') },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supplies the owner-configured Jev key and vocabulary paths without reading either file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-config-jev-'));
    try {
      const parsed = parseConfig({ ...validConfig(), jev: undefined }, { home: root });
      expect(parsed.jev).toEqual({
        enabled: false,
        keyFile: join(root, '.mama/jev-key'),
        vocabFile: join(root, '.mama/backfill/vocab.json'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
