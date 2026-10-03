import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../../src/cli/commands/init.js';
import { runSecret } from '../../src/cli/commands/secret.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';
import { loadConfig } from '../../src/runtime/config.js';
import { loadConnectorConfig } from '../../src/connectors/config-loader.js';

let home: string;
let root: string;
const fixtureSecrets = {
  MAMA_TELEGRAM_TOKEN: 'fixture-telegram',
  MAMA_SLACK_TOKEN: 'fixture-slack',
  MAMA_SLACK_APP_TOKEN: 'fixture-slack-app',
  MAMA_CHATWORK_TOKEN: 'fixture-chatwork',
  MAMA_TRELLO_KEY: 'fixture-key',
  MAMA_TRELLO_TOKEN: 'fixture-trello',
  MAMA_NOTION_TOKEN: 'fixture-notion',
  MAMA_DISCORD_TOKEN: 'fixture-discord',
  MAMA_TELEGRAM_SOURCE_TOKEN: 'fixture-telegram-source',
};

function prompt(
  answers: string[],
  hidden: string[],
  tty = [true, true],
  timezoneAnswer?: string,
  jevAnswer = 'n'
) {
  const output: string[] = [];
  const adapter: PromptAdapter = {
    stdinIsTTY: tty[0],
    stdoutIsTTY: tty[1],
    text: async (label) => {
      if (label.startsWith('Owner timezone')) return timezoneAnswer ?? '';
      if (label.startsWith('Use Jev (TypeSafe)')) return jevAnswer;
      if (!answers.length) throw new Error('Unexpected visible prompt');
      return answers.shift()!;
    },
    secret: async () => {
      if (!hidden.length) throw new Error('Unexpected secret prompt');
      return hidden.shift()!;
    },
    write: (line) => {
      output.push(line);
    },
  };
  return { adapter, output, answers, hidden };
}

function minimal(backend = 'codex', launch = 'n') {
  return [backend, 'fixture-model', '100', '101', '', 'n', 'n', 'n', launch];
}

function options(adapter: PromptAdapter) {
  return {
    prompt: adapter,
    home,
    cliPath: join(home, 'package', 'cli.js'),
    nodePath: process.execPath,
    findExecutable: (name: string) => join(home, 'bin', name),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-init-'));
  root = join(home, '.mama');
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'dev.db'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('owner-only onboarding', () => {
  it('writes the timezone selected during onboarding', async () => {
    const p = prompt(
      minimal(),
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN],
      [true, true],
      'America/Los_Angeles'
    );
    await runInit(options(p.adapter));
    const config = loadConfig({ home });
    expect(config.timezone).toBe('America/Los_Angeles');
    // 10 minutes without progress or an hour in all (owner, 2026-10-03); Jev stays off
    // unless the owner chooses it.
    expect(config.agent).toMatchObject({ timeout: 600_000, max_turn_ms: 3_600_000 });
    expect(config.jev.enabled).toBe(false);
    expect(existsSync(join(root, 'jev-key'))).toBe(false);
  });

  it('turns Jev on when the owner chooses it and keeps its key in its own 0600 file', async () => {
    const p = prompt(
      minimal(),
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, 'fixture-jev-key'],
      [true, true],
      undefined,
      'y'
    );
    await runInit(options(p.adapter));
    expect(loadConfig({ home }).jev).toMatchObject({
      enabled: true,
      keyFile: join(root, 'jev-key'),
    });
    expect(readFileSync(join(root, 'jev-key'), 'utf8')).toBe('fixture-jev-key\n');
    expect(statSync(join(root, 'jev-key')).mode & 0o777).toBe(0o600);
    for (const file of ['config.yaml', 'auth.env', 'start.sh'])
      expect(readFileSync(join(root, file), 'utf8')).not.toContain('fixture-jev-key');
    expect(p.output.join('\n')).not.toContain('fixture-jev-key');
    expect(p.output.join('\n')).toContain('Jev is on');
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('refuses init and secret set without both TTYs %j', async (...tty) => {
    const p = prompt([], [], tty);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/TTY/);
    await expect(
      runSecret(['set', 'MAMA_TELEGRAM_TOKEN'], { home, prompt: p.adapter })
    ).rejects.toThrow(/TTY/);
    expect(existsSync(root)).toBe(false);
  });

  it('refuses existing config before prompting or changing auth.env', async () => {
    mkdirSync(root);
    writeFileSync(join(root, 'config.yaml'), 'existing');
    writeFileSync(join(root, 'auth.env'), '# untouched\n');
    const p = prompt([], []);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/config.yaml.*exists/);
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe('existing');
    expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# untouched\n');
  });

  it.each(['claude', 'codex'])(
    'writes a loadable secret-free config and executable start script for %s',
    async (backend) => {
      const p = prompt(minimal(backend), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      await runInit(options(p.adapter));
      const config = loadConfig({ home });
      expect(config.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(config.agent.backend).toBe(backend);
      expect(config.agent.model).toBe('fixture-model');
      expect(config.telegram).toMatchObject({
        enabled: true,
        owner_chat_id: '100',
        owner_user_ids: ['101'],
        allowed_chats: ['100'],
        polling: true,
      });
      expect(config.telegram).not.toHaveProperty('token');
      expect(loadConnectorConfig(join(root, 'connectors.json'))).toMatchObject({
        ok: true,
        enabledNames: [],
      });
      for (const file of ['auth.env', 'config.yaml', 'connectors.json']) {
        expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      }
      expect(statSync(join(root, 'start.sh')).mode & 0o777).toBe(0o700);
      expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist'))).toBe(
        false
      );
      // Codex must log in to the managed home the owner runtime reads, not the default one.
      expect(p.output.join('\n')).toContain(
        backend === 'claude'
          ? 'claude auth login'
          : `CODEX_HOME='${join(root, '.codex')}' codex login`
      );
      expect(p.answers).toEqual([]);
      expect(p.hidden).toEqual([]);
    }
  );

  it('sets up a Discord owner gateway in init without enabling a source connector', async () => {
    const p = prompt(
      ['codex', 'fixture-model', '100', '101', '', 'y', 'channel_test', 'user_test', 'n', 'n', 'n'],
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, 'fixture-discord-owner']
    );
    await runInit(options(p.adapter));
    const config = loadConfig({ home });
    expect(config.discord).toMatchObject({
      enabled: true,
      owner_channel_id: 'channel_test',
      allowed_channels: ['channel_test'],
      owner_user_ids: ['user_test'],
    });
    expect(readFileSync(join(root, 'auth.env'), 'utf8')).toContain(
      "MAMA_DISCORD_TOKEN='fixture-discord-owner'"
    );
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).not.toContain('fixture-discord-owner');
  });

  it('sets up Slack bot and Socket Mode credentials for an owner gateway', async () => {
    const p = prompt(
      ['codex', 'fixture-model', '100', '101', '', 'n', 'y', 'channel_test', 'user_test', 'n', 'n'],
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, 'fixture-slack-owner', 'fixture-slack-app-owner']
    );
    await runInit(options(p.adapter));
    const config = loadConfig({ home });
    expect(config.slack).toMatchObject({
      enabled: true,
      owner_channel_id: 'channel_test',
      allowed_channels: ['channel_test'],
      owner_user_ids: ['user_test'],
    });
    const auth = readFileSync(join(root, 'auth.env'), 'utf8');
    expect(auth).toContain("MAMA_SLACK_TOKEN='fixture-slack-owner'");
    expect(auth).toContain("MAMA_SLACK_APP_TOKEN='fixture-slack-app-owner'");
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).not.toContain('fixture-slack-owner');
  });

  it('wires every selected connector, tunnel environment and opt-in launchd without leaking credentials', async () => {
    const p = prompt(
      [
        'claude',
        'fixture-model',
        '100',
        '101',
        'slack,chatwork,trello,kagemusha,calendar,notion,discord,telegram',
        'channel-a,channel-b',
        'room-a',
        'board-a',
        'source-a',
        'calendar',
        'channel-discord',
        'chat-telegram',
        'n',
        'n',
        'y',
        'https://access.example.test',
        'fixture-audience',
        'viewer.example.test',
        '',
        'y',
      ],
      Object.values(fixtureSecrets)
    );
    await runInit(options(p.adapter));
    const loaded = loadConnectorConfig(join(root, 'connectors.json'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Generated connector config was rejected');
    expect(loaded.config.slack.auth.tokenName).toBe('MAMA_SLACK_TOKEN');
    expect(loaded.config.chatwork.auth.tokenName).toBe('MAMA_CHATWORK_TOKEN');
    expect(loaded.config.trello.auth.tokenName).toBe('MAMA_TRELLO_TOKEN');
    expect(loaded.config.notion.auth.tokenName).toBe('MAMA_NOTION_TOKEN');
    expect(loaded.config.discord.auth.tokenName).toBe('MAMA_DISCORD_TOKEN');
    expect(loaded.config.telegram.auth.tokenName).toBe('MAMA_TELEGRAM_SOURCE_TOKEN');
    expect(loaded.config.trello.channels['board-a']).toEqual({ role: 'hub', boardId: 'board-a' });
    expect(Object.keys(loaded.config.slack.channels)).toEqual(['channel-a', 'channel-b']);
    expect(loaded.config.calendar.auth.cli).toBe('gws');
    expect(loaded.config.discord.channels['channel-discord']).toEqual({
      role: 'hub',
    });
    const auth = execFileSync('/bin/sh', ['-c', '. "$1"; env', 'sh', join(root, 'auth.env')], {
      env: { HOME: home },
      encoding: 'utf8',
    });
    for (const [name, value] of Object.entries(fixtureSecrets)) {
      expect(auth.includes(`${name}=${value}\n`)).toBe(true);
    }
    const generatedToken = auth
      .split('\n')
      .find((line) => line.startsWith('MAMA_AUTH_TOKEN='))!
      .slice('MAMA_AUTH_TOKEN='.length);
    expect(/^[a-f0-9]{64}$/.test(generatedToken)).toBe(true);
    const publicFiles = ['config.yaml', 'connectors.json', 'start.sh'].map((file) =>
      readFileSync(join(root, file), 'utf8')
    );
    const plist = join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist');
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    for (const text of [...publicFiles, readFileSync(plist, 'utf8'), ...p.output]) {
      for (const value of [...Object.values(fixtureSecrets), generatedToken])
        expect(text.includes(value)).toBe(false);
    }
    expect(p.output.join('\n')).toContain('launchctl bootstrap');
    expect(p.output.join('\n')).toContain('gws auth login');
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
    // Execute the generated script with a harmless daemon substitute; no real CLI or network.
    mkdirSync(join(home, 'package'));
    writeFileSync(
      join(home, 'package', 'cli.js'),
      `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.HOME + '/launch-result.json', JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH,
        issuer: process.env.MAMA_CF_ACCESS_ISSUER, audience: process.env.MAMA_CF_ACCESS_AUD,
        host: process.env.MAMA_VIEWER_HOSTNAMES,
        tokenLoaded: !!process.env.MAMA_TELEGRAM_TOKEN, authLoaded: !!process.env.MAMA_AUTH_TOKEN
      }));
    `
    );
    execFileSync(join(root, 'start.sh'), [], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
    const result = JSON.parse(readFileSync(join(home, 'launch-result.json'), 'utf8'));
    expect(result).toMatchObject({
      argv: ['daemon'],
      cwd: realpathSync(root),
      issuer: 'https://access.example.test',
      audience: 'fixture-audience',
      host: 'viewer.example.test',
      tokenLoaded: true,
      authLoaded: true,
    });
    expect(result.path.split(':')).toContain(join(home, 'bin'));
    expect(readdirSync(join(root, 'runtime'))).toEqual([]);
  });

  it('prompts for the fields needed by the restored Google, vault, and project sources', async () => {
    const vaultPath = join(home, 'fixture-vault');
    const p = prompt(
      [
        'codex',
        'fixture-model',
        '100',
        '101',
        'gmail,drive,sheets,notion,obsidian,claude-code,imessage',
        'folder-fixture',
        'spreadsheet-fixture',
        'Records!A1:B1',
        '',
        vaultPath,
        'project-fixture',
        'Fixture Project',
        'chat-fixture-1',
        'n',
        'n',
        'n',
        'n',
      ],
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, fixtureSecrets.MAMA_NOTION_TOKEN]
    );
    await runInit(options(p.adapter));
    const loaded = loadConnectorConfig(join(root, 'connectors.json'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Generated connector config was rejected');
    expect(loaded.config.gmail?.channels.inbox).toMatchObject({ role: 'hub' });
    expect(loaded.config.drive?.channels['folder-fixture']).toMatchObject({
      role: 'hub',
      folderId: 'folder-fixture',
    });
    expect(loaded.config.sheets?.channels.spreadsheet).toMatchObject({
      spreadsheetId: 'spreadsheet-fixture',
      sheetRange: 'Records!A1:B1',
    });
    expect(loaded.config.notion?.channels.workspace?.name).toBe('Notion workspace');
    expect(loaded.config.obsidian?.channels.vault?.vaultPath).toBe(vaultPath);
    expect(loaded.config['claude-code']?.channels['project-fixture']?.name).toBe('Fixture Project');
    expect(loaded.config.imessage?.channels['chat-fixture-1']).toMatchObject({ role: 'hub' });
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
  });

  it('does not overwrite an existing launch agent', async () => {
    const dir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'com.mama.server.plist'), 'existing');
    const p = prompt(minimal('codex', 'y'), ['fixture-telegram']);
    await expect(runInit(options(p.adapter))).rejects.toThrow(/plist.*exists/);
    expect(readFileSync(join(dir, 'com.mama.server.plist'), 'utf8')).toBe('existing');
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('leaves no partial setup after a cancelled hidden prompt', async () => {
    const p = prompt(['codex', 'fixture-model'], []);
    p.adapter.secret = async () => {
      throw new Error('Input cancelled');
    };
    await expect(runInit(options(p.adapter))).rejects.toThrow(/cancelled/);
    expect(existsSync(root)).toBe(false);
  });
});

describe('secret rotation', () => {
  it.each(['MAMA_NOTION_TOKEN', 'MAMA_DISCORD_TOKEN', 'MAMA_TELEGRAM_SOURCE_TOKEN'])(
    'stores the enabled connector credential %s by its MAMA name',
    async (name) => {
      const p = prompt([], ['fixture-secret']);
      await runSecret(['set', name], { home, prompt: p.adapter });
      expect(readFileSync(join(root, 'auth.env'), 'utf8')).toContain(`${name}='fixture-secret'`);
    }
  );

  it('replaces only the chosen name atomically, preserves literal shell characters and lists names only without a TTY', async () => {
    mkdirSync(root);
    writeFileSync(
      join(root, 'auth.env'),
      "# retained\nexport MAMA_SLACK_TOKEN='fixture-old'\nexport MAMA_AUTH_TOKEN='fixture-other'\n",
      { mode: 0o644 }
    );
    const before = statSync(join(root, 'auth.env')).ino;
    const secret = 'fixture\'$() `literal` \\"#value';
    const p = prompt([], [secret]);
    await runSecret(['set', 'MAMA_SLACK_TOKEN'], { home, prompt: p.adapter });
    expect(statSync(join(root, 'auth.env')).ino).not.toBe(before);
    expect(statSync(join(root, 'auth.env')).mode & 0o777).toBe(0o600);
    const value = execFileSync(
      '/bin/sh',
      ['-c', '. "$1"; printf %s "$MAMA_SLACK_TOKEN"', 'sh', join(root, 'auth.env')],
      { encoding: 'utf8', env: { HOME: home } }
    );
    expect(value === secret).toBe(true);
    expect(
      readFileSync(join(root, 'auth.env'), 'utf8').includes("MAMA_AUTH_TOKEN='fixture-other'")
    ).toBe(true);
    const listing = prompt([], [], [false, false]);
    await runSecret(['list'], { home, prompt: listing.adapter });
    expect(listing.output).toEqual(['MAMA_AUTH_TOKEN', 'MAMA_SLACK_TOKEN']);
    expect(readdirSync(join(root, 'runtime'))).toEqual([]);
  });

  it.each(['MAMA_CF_ACCESS_ISSUER', 'PATH', 'NOT_ALLOWED', 'MAMA_SLACK_TOKEN=bad'])(
    'rejects names outside the secret allowlist %#',
    async (name) => {
      const p = prompt([], []);
      await expect(runSecret(['set', name], { home, prompt: p.adapter })).rejects.toThrow(
        /Allowed secret names/
      );
      expect(existsSync(root)).toBe(false);
    }
  );

  it.each(['', 'fixture\nextra', 'fixture\0extra'])(
    'rejects blank or multiline values without changing the file %#',
    async (value) => {
      mkdirSync(root);
      writeFileSync(join(root, 'auth.env'), '# retained\n');
      const p = prompt([], [value]);
      await expect(
        runSecret(['set', 'MAMA_TELEGRAM_TOKEN'], { home, prompt: p.adapter })
      ).rejects.toThrow(/nonblank.*single line/);
      expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# retained\n');
    }
  );
});
