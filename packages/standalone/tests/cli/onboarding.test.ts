import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { defaultToolsRoot } from '../../src/cli/commands/tools.js';
import { runInit, type InitOptions } from '../../src/cli/commands/init.js';
import { runSecret } from '../../src/cli/commands/secret.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';
import { loadConfig } from '../../src/runtime/config.js';
import { loadConnectorConfig } from '../../src/connectors/config-loader.js';
import { defaultRoots, prepareRoot } from '../../src/cli/runtime/default-roots.js';
import { initStatePath, readInitState } from '../../src/cli/runtime/init-state.js';
import { acquireInstallLock, daemonControlPaths } from '../../src/cli/runtime/daemon-control.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

let home: string;
let root: string;
let memberRoot: string;
let toolsRoot: string;
const OWNER_ID = '7123';
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
      if (!answers.length) throw new Error(`Unexpected visible prompt: ${label}`);
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

/** backend, model, common group, owner id, both folders, then no source, messenger or tunnel. */
function minimal(backend = 'codex') {
  return [backend, 'fixture-model', '-100', OWNER_ID, memberRoot, toolsRoot, '', 'n', 'n', 'n'];
}

const probeOk = (command: string, args: string[]) =>
  ({
    status: 0,
    stdout: args[0] === '--version' ? '9.9.9' : args[0] === 'auth' ? '{"loggedIn":true}' : '',
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  }) as never;

function options(adapter: PromptAdapter, overrides: Partial<InitOptions> = {}) {
  const started: Array<Record<string, string>> = [];
  const value: InitOptions = {
    prompt: adapter,
    home,
    platform: 'linux',
    user: 'fixture',
    uid: process.getuid!(),
    findExecutable: (name: string) => join(home, 'bin', name),
    installToolkit: async () => {},
    probeRun: probeOk,
    telegramCall: async (_token, method) =>
      method === 'getMe'
        ? { ok: true, result: { id: 9001, can_read_all_group_messages: true } }
        : { ok: true, result: { status: 'administrator' } },
    startService: async (viewer) => {
      started.push(viewer);
    },
    daemonStatus: async () => ({
      state: 'running',
      reply: { ok: true, status: { stage: 'running' } },
    }),
    health: async () => true,
    pollMs: 1,
    ...overrides,
  };
  return Object.assign(value, { started });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mama-init-')));
  root = join(home, '.mama');
  memberRoot = `${home}-members`;
  toolsRoot = `${home}-tools`;
  mkdirSync(memberRoot, { mode: 0o700 });
  mkdirSync(toolsRoot, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'dev.db'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of [home, memberRoot, toolsRoot]) rmSync(path, { recursive: true, force: true });
});

describe('default folders', () => {
  it('puts each account in its own folder outside HOME', () => {
    // macOS keeps a Shared folder beside the home folders.
    expect(defaultRoots({ platform: 'darwin', home: '/srv/homes/person', user: 'person' })).toEqual(
      {
        memberRoot: '/srv/homes/Shared/mama-person/members',
        toolsRoot: '/srv/homes/Shared/mama-person/tools',
      }
    );
    expect(defaultRoots({ platform: 'linux', user: 'person' })).toEqual({
      memberRoot: '/var/lib/mama/person/members',
      toolsRoot: '/var/lib/mama/person/tools',
    });
    expect(defaultRoots({ platform: 'win32', user: 'person' })).toBeUndefined();
    expect(defaultRoots({ platform: 'darwin', user: '../person' })).toBeUndefined();
    expect(defaultToolsRoot('darwin', '/srv/homes/person')).toMatch(
      /^\/srv\/homes\/Shared\/mama-.+\/tools$/
    );
  });

  it('refuses a folder another account owns or can write, and creates nothing on Linux', () => {
    expect(() =>
      prepareRoot(memberRoot, { platform: 'linux', uid: process.getuid!() + 1 })
    ).toThrow(/belongs to another account/);
    chmodSync(memberRoot, 0o770);
    expect(() => prepareRoot(memberRoot, { platform: 'linux' })).toThrow(
      /written by other accounts/
    );
    chmodSync(memberRoot, 0o700);
    expect(() => prepareRoot(join(memberRoot, 'missing'), { platform: 'linux' })).toThrow(
      /installer creates it once: sudo install -d/
    );
    prepareRoot(join(memberRoot, 'made'), { platform: 'darwin', ownParent: true });
    expect(statSync(join(memberRoot, 'made')).mode & 0o777).toBe(0o700);
  });
});

describe('mama init', () => {
  it.each(['claude', 'codex'])(
    'checks, writes, registers the owner, installs the tools and starts the service (%s)',
    async (backend) => {
      const p = prompt(minimal(backend), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      const order: string[] = [];
      const o = options(p.adapter, {
        installToolkit: async () => {
          order.push('toolkit');
        },
      });
      const startService = o.startService!;
      o.startService = async (viewer) => {
        order.push('service');
        await startService(viewer);
      };
      await runInit([], o);
      expect(order).toEqual(['toolkit', 'service']);
      const config = loadConfig({ home });
      expect(config.agent).toMatchObject({
        backend,
        model: 'fixture-model',
        timeout: 600_000,
        max_turn_ms: 3_600_000,
      });
      expect(config.member_root).toBe(memberRoot);
      expect(config.tools_root).toBe(toolsRoot);
      expect(config.telegram).toMatchObject({
        enabled: true,
        owner_chat_id: '-100',
        allowed_chats: ['-100'],
        polling: true,
      });
      expect(config.telegram).not.toHaveProperty('token');
      expect(config.jev.enabled).toBe(false);
      expect(o.started).toEqual([{}]);
      expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
      expect(readInitState(root)).not.toHaveProperty('pendingOwner');
      for (const file of ['auth.env', 'config.yaml', 'connectors.json'])
        expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      // Init no longer writes the launch files; the service step does, through mama service.
      expect(existsSync(join(root, 'start.sh'))).toBe(false);
      expect(p.output.join('\n')).toContain('MAMA is running');
      expect(p.output.join('\n')).not.toContain('register-owner');
      expect(p.answers).toEqual([]);
      expect(p.hidden).toEqual([]);
      const database = await openCoreDatabase({ path: config.database.path });
      try {
        const repo = createPrincipalRepository(database.adapter);
        const owner = repo.resolveByExternal('telegram', 'private', OWNER_ID);
        expect(owner?.kind).toBe('member');
        expect(repo.listRoles(owner!.principalId).map(({ role }) => role)).toContain('owner');
      } finally {
        await database.close();
      }
    }
  );

  it('refuses a missing, old or signed-out backend before writing anything', async () => {
    for (const [probe, message] of [
      [undefined, /not on this PATH/],
      [
        (_c: string, args: string[]) =>
          ({ ...probeOk(_c, args), stdout: args[0] === '--version' ? '0.1.0' : '' }) as never,
        /older than/,
      ],
      [
        (_c: string, args: string[]) =>
          ({
            ...probeOk(_c, args),
            stdout: args[0] === '--version' ? '9.9.9' : '{"loggedIn":false}',
          }) as never,
        /not signed in.*claude auth login/,
      ],
    ] as const) {
      const p = prompt(minimal('claude'), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      await expect(
        runInit(
          [],
          options(p.adapter, {
            ...(probe === undefined
              ? { findExecutable: () => undefined }
              : { probeRun: probe as InitOptions['probeRun'] }),
          })
        )
      ).rejects.toThrow(message);
      expect(existsSync(root)).toBe(false);
    }
  });

  it('refuses a token Telegram rejects before writing anything', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(
      runInit(
        [],
        options(p.adapter, { telegramCall: async () => ({ ok: false, error_code: 401 }) })
      )
    ).rejects.toThrow(/Telegram refused the bot token/);
    expect(existsSync(root)).toBe(false);
  });

  it.each(['100', '0', '-0', 'group', '-100abc', '-01'])(
    'refuses a non-group Telegram common destination before writing setup: %s',
    async (chatId) => {
      const answers = minimal();
      answers[2] = chatId;
      const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      await expect(runInit([], options(p.adapter))).rejects.toThrow(
        /group or supergroup.*negative.*private chats.*personal intake/
      );
      expect(existsSync(root)).toBe(false);
    }
  );

  it('refuses a member folder inside HOME before writing anything', async () => {
    const answers = minimal();
    answers[4] = join(home, 'members');
    const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/must not overlap HOME/);
    expect(existsSync(root)).toBe(false);
  });

  it('continues a failed setup from its last finished step without asking again', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(
      runInit(
        [],
        options(p.adapter, {
          installToolkit: async () => {
            throw new Error('fixture toolkit failed');
          },
        })
      )
    ).rejects.toThrow(/toolkit setup failed.*mama init again/);
    expect(readInitState(root)?.done).toEqual(['config', 'owner']);
    const again = prompt([], []);
    const o = options(again.adapter);
    await runInit([], o);
    expect(again.output.join('\n')).toContain('continuing setup: done so far: config, owner');
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(o.started).toEqual([{}]);
    // A finished setup is not run again.
    await expect(runInit([], options(prompt([], []).adapter))).rejects.toThrow(
      /already set up here/
    );
  });

  it('waits for the boot and says where to look when it does not finish', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    let asked = 0;
    await expect(
      runInit(
        [],
        options(p.adapter, {
          daemonStatus: async () => {
            asked += 1;
            return asked < 3
              ? { state: 'stopped', holder: null }
              : { state: 'running', reply: { ok: true, status: { stage: 'owner_runtime' } } };
          },
          bootTimeoutMs: 50,
        })
      )
    ).rejects.toThrow(/last stage: owner_runtime.*mama logs/);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit']);
    const healthless = prompt([], []);
    await expect(
      runInit([], options(healthless.adapter, { health: async () => false }))
    ).rejects.toThrow(/does not answer \/health/);
  });

  it('refuses while something else holds the install', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    mkdirSync(root, { mode: 0o700 });
    const held = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      await expect(runInit([], options(p.adapter))).rejects.toThrow(/daemon/);
    } finally {
      held.release();
    }
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('sets up from MAMA_INIT_* variables without a terminal, and names a missing one', async () => {
    const p = prompt([], [], [false, false]);
    const env = {
      MAMA_INIT_BACKEND: 'codex',
      MAMA_INIT_MODEL: 'fixture-model',
      MAMA_TELEGRAM_TOKEN: fixtureSecrets.MAMA_TELEGRAM_TOKEN,
      MAMA_INIT_COMMON_CHAT_ID: '-100',
      MAMA_INIT_MEMBER_ROOT: memberRoot,
      MAMA_INIT_TOOLS_ROOT: toolsRoot,
      MAMA_INIT_TIMEZONE: 'Asia/Tokyo',
    };
    await expect(runInit(['--non-interactive'], options(p.adapter, { env }))).rejects.toThrow(
      /needs MAMA_INIT_OWNER_TELEGRAM_ID/
    );
    expect(existsSync(root)).toBe(false);
    await runInit(
      ['--non-interactive'],
      options(p.adapter, { env: { ...env, MAMA_INIT_OWNER_TELEGRAM_ID: OWNER_ID } })
    );
    const config = loadConfig({ home });
    expect(config.timezone).toBe('Asia/Tokyo');
    expect(config.member_root).toBe(memberRoot);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(p.output.join('\n')).not.toContain(fixtureSecrets.MAMA_TELEGRAM_TOKEN);
  });

  it('writes the timezone selected during onboarding', async () => {
    const p = prompt(
      minimal(),
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN],
      [true, true],
      'America/Los_Angeles'
    );
    await runInit([], options(p.adapter));
    expect(loadConfig({ home }).timezone).toBe('America/Los_Angeles');
  });

  it('turns Jev on when the owner chooses it and keeps its key in its own 0600 file', async () => {
    const p = prompt(
      minimal(),
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, 'fixture-jev-key'],
      [true, true],
      undefined,
      'y'
    );
    await runInit([], options(p.adapter));
    expect(loadConfig({ home }).jev).toMatchObject({
      enabled: true,
      keyFile: join(root, 'jev-key'),
    });
    expect(readFileSync(join(root, 'jev-key'), 'utf8')).toBe('fixture-jev-key\n');
    expect(statSync(join(root, 'jev-key')).mode & 0o777).toBe(0o600);
    for (const file of ['config.yaml', 'auth.env', initStatePath(root)])
      expect(readFileSync(file.startsWith('/') ? file : join(root, file), 'utf8')).not.toContain(
        'fixture-jev-key'
      );
    expect(p.output.join('\n')).not.toContain('fixture-jev-key');
    expect(p.output.join('\n')).toContain('Jev is on');
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('refuses init and secret set without both TTYs %j', async (...tty) => {
    const p = prompt([], [], tty);
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/TTY/);
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
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/config.yaml.*exists/);
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe('existing');
    expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# untouched\n');
  });

  it('sets up a Discord owner gateway in init without enabling a source connector', async () => {
    const answers = minimal();
    answers.splice(7, 1, 'y', 'channel_test', 'user_test');
    const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN, 'fixture-discord-owner']);
    await runInit([], options(p.adapter));
    expect(loadConfig({ home }).discord).toMatchObject({
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
    const answers = minimal();
    answers.splice(8, 1, 'y', 'channel_test', 'user_test');
    const p = prompt(answers, [
      fixtureSecrets.MAMA_TELEGRAM_TOKEN,
      'fixture-slack-owner',
      'fixture-slack-app-owner',
    ]);
    await runInit([], options(p.adapter));
    expect(loadConfig({ home }).slack).toMatchObject({
      enabled: true,
      owner_channel_id: 'channel_test',
      allowed_channels: ['channel_test'],
      owner_user_ids: ['user_test'],
    });
    const auth = readFileSync(join(root, 'auth.env'), 'utf8');
    expect(auth).toContain("MAMA_SLACK_TOKEN='fixture-slack-owner'");
    expect(auth).toContain("MAMA_SLACK_APP_TOKEN='fixture-slack-app-owner'");
  });

  it('wires every selected connector and the tunnel settings without leaking credentials', async () => {
    const p = prompt(
      [
        'claude',
        'fixture-model',
        '-100',
        OWNER_ID,
        memberRoot,
        toolsRoot,
        'slack,chatwork,trello,calendar,notion,discord,telegram',
        'channel-a,channel-b',
        'room-a',
        'board-a',
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
      ],
      Object.values(fixtureSecrets)
    );
    const o = options(p.adapter);
    await runInit([], o);
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
    // The tunnel settings reach the service step, which writes them into start.sh.
    expect(o.started).toEqual([
      {
        MAMA_CF_ACCESS_ISSUER: 'https://access.example.test',
        MAMA_CF_ACCESS_AUD: 'fixture-audience',
        MAMA_VIEWER_HOSTNAMES: 'viewer.example.test',
      },
    ]);
    const auth = execFileSync('/bin/sh', ['-c', '. "$1"; env', 'sh', join(root, 'auth.env')], {
      env: { HOME: home },
      encoding: 'utf8',
    });
    for (const [name, value] of Object.entries(fixtureSecrets))
      expect(auth.includes(`${name}=${value}\n`)).toBe(true);
    const generatedToken = auth
      .split('\n')
      .find((line) => line.startsWith('MAMA_AUTH_TOKEN='))!
      .slice('MAMA_AUTH_TOKEN='.length);
    expect(/^[a-f0-9]{64}$/.test(generatedToken)).toBe(true);
    const publicFiles = ['config.yaml', 'connectors.json'].map((file) =>
      readFileSync(join(root, file), 'utf8')
    );
    for (const text of [...publicFiles, readFileSync(initStatePath(root), 'utf8'), ...p.output]) {
      for (const value of [...Object.values(fixtureSecrets), generatedToken])
        expect(text.includes(value)).toBe(false);
    }
    expect(p.output.join('\n')).toContain('gws auth login');
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
    expect(readdirSync(join(root, 'runtime')).sort()).toEqual(
      expect.arrayContaining(['init-state.json'])
    );
  });

  it('prompts for the fields needed by the restored Google, vault, and project sources', async () => {
    const vaultPath = join(home, 'fixture-vault');
    const p = prompt(
      [
        'codex',
        'fixture-model',
        '-100',
        OWNER_ID,
        memberRoot,
        toolsRoot,
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
      ],
      [fixtureSecrets.MAMA_TELEGRAM_TOKEN, fixtureSecrets.MAMA_NOTION_TOKEN]
    );
    await runInit([], options(p.adapter));
    const loaded = loadConnectorConfig(join(root, 'connectors.json'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Generated connector config was rejected');
    expect(loaded.config.gmail?.channels.inbox).toMatchObject({ role: 'hub' });
    expect(loaded.config.drive?.channels['folder-fixture']).toMatchObject({
      role: 'hub',
      folderId: 'folder-fixture',
    });
    expect(loaded.config.obsidian?.channels.vault?.vaultPath).toBe(vaultPath);
    expect(loaded.config['claude-code']?.channels['project-fixture']?.name).toBe('Fixture Project');
    expect(loaded.config.imessage?.channels['chat-fixture-1']).toMatchObject({ role: 'hub' });
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
  });

  it('no longer offers the Kagemusha bridge, which a fresh install cannot use', async () => {
    const answers = minimal();
    answers[6] = 'kagemusha';
    const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/Choose connectors from/);
    expect(existsSync(root)).toBe(false);
  });

  it('leaves no partial setup after a cancelled hidden prompt', async () => {
    const p = prompt(['codex', 'fixture-model'], []);
    p.adapter.secret = async () => {
      throw new Error('Input cancelled');
    };
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/cancelled/);
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
