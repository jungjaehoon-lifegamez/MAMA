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
import * as yaml from 'js-yaml';
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

/**
 * The new bot: nothing waits when setup starts; then the owner messages it privately and sends
 * /bind in the common group. Codes the pairing step sends are kept, so the terminal can type the
 * owner's.
 */
function fakeBot() {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const polls: Array<{ offset: string; timeout: string }> = [];
  const updates = [
    {
      update_id: 1,
      message: {
        chat: { id: Number(OWNER_ID), type: 'private' },
        from: { id: Number(OWNER_ID) },
        text: 'hello',
      },
    },
    {
      update_id: 2,
      message: {
        chat: { id: -100, type: 'supergroup' },
        from: { id: Number(OWNER_ID) },
        text: '/bind',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    },
  ];
  const call: NonNullable<InitOptions['telegramCall']> = async (_token, method, params = {}) => {
    if (method === 'getMe')
      return {
        ok: true,
        result: { id: 9001, username: 'fixture_bot', can_read_all_group_messages: true },
      };
    if (method === 'getChatMember') return { ok: true, result: { status: 'administrator' } };
    if (method === 'sendMessage') {
      sent.push({ chat_id: params.chat_id, text: params.text });
      return { ok: true, result: {} };
    }
    if (method === 'getUpdates') {
      polls.push({ offset: params.offset, timeout: params.timeout });
      if (params.offset === '-1') return { ok: true, result: [] };
      const pending = updates.filter((update) => update.update_id >= Number(params.offset ?? 0));
      if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, result: pending };
    }
    throw new Error(`unexpected Telegram call ${method}`);
  };
  // Each init run sends its own code; the terminal types the newest one not typed yet.
  let typed = 0;
  const code = async () => {
    for (;;) {
      const index = sent.findIndex((entry, at) => at >= typed && entry.chat_id === OWNER_ID);
      if (index >= 0) {
        typed = index + 1;
        return /(\d{6})/.exec(sent[index].text)![1];
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  return { call, sent, polls, code };
}
let telegram: ReturnType<typeof fakeBot>;

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
      if (label.startsWith('Pairing code')) return telegram.code();
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

/** backend, model, both folders, then no source, messenger or tunnel; pairing names the rest. */
function minimal(backend = 'codex') {
  return [backend, 'fixture-model', memberRoot, toolsRoot, '', 'n', 'n', 'n'];
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
    telegramCall: telegram.call,
    startService: async (viewer) => {
      started.push(viewer);
    },
    daemonStatus: async () => ({
      state: 'running',
      reply: { ok: true, status: { stage: 'running' } },
    }),
    health: async () => true,
    // This machine's own MAMA may hold the default port; the fixture sees every port free.
    portAnswers: async () => false,
    pollMs: 1,
    ...overrides,
  };
  return Object.assign(value, { started });
}

beforeEach(() => {
  telegram = fakeBot();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mama-init-')));
  root = join(home, '.mama');
  memberRoot = `${home}-members`;
  toolsRoot = `${home}-tools`;
  mkdirSync(memberRoot, { mode: 0o700 });
  mkdirSync(toolsRoot, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  // systemd's user units follow XDG_CONFIG_HOME when it is set (CI runners set it); the service
  // step must write under this test's HOME, never the runner's or a developer's real one.
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
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

  it('refuses a folder another account owns or can write, and names the one sudo step', () => {
    expect(() => prepareRoot(memberRoot, { uid: process.getuid!() + 1 })).toThrow(
      /belongs to another account/
    );
    chmodSync(memberRoot, 0o770);
    expect(() => prepareRoot(memberRoot)).toThrow(/written by other accounts/);
    chmodSync(memberRoot, 0o700);
    // A per-user folder this account owns: the subfolders are made here.
    prepareRoot(join(memberRoot, 'made'), { ownParent: true });
    expect(statSync(join(memberRoot, 'made')).mode & 0o777).toBe(0o700);
    // One it cannot create (as /var/lib/mama on Linux) names the per-user folder to make once.
    const locked = join(memberRoot, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    try {
      expect(() => prepareRoot(join(locked, 'person', 'members'), { ownParent: true })).toThrow(
        `Create ${join(locked, 'person')} for this account once: sudo install -d -o "$USER" -m 0700 ${join(locked, 'person')}`
      );
    } finally {
      chmodSync(locked, 0o700);
    }
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

  it('refuses when Telegram cannot be reached, so the token is never left unchecked', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(
      runInit(
        [],
        options(p.adapter, {
          telegramCall: async () => {
            throw new TypeError('fetch failed');
          },
        })
      )
    ).rejects.toThrow(/could not reach Telegram.*token is unchecked/);
    expect(existsSync(root)).toBe(false);
  });

  it('checks the backend login as the daemon runs it, without secret-shaped variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-shell-key');
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const p = prompt(minimal('claude'), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await runInit(
      [],
      options(p.adapter, {
        probeRun: (command, args, env) => {
          seen.push(env);
          return probeOk(command, args);
        },
      })
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('refuses a member folder under a folder other accounts can write', async () => {
    const open = `${home}-open`;
    mkdirSync(open, { mode: 0o777 });
    chmodSync(open, 0o777);
    try {
      const answers = minimal();
      answers[2] = join(open, 'members');
      const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
      await expect(runInit([], options(p.adapter))).rejects.toThrow(/Unsafe member_root ancestor/);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('starts the setup step over when an earlier init stopped while writing its files', async () => {
    // auth.env as a folder makes the write fail after the step record is written.
    mkdirSync(join(root, 'auth.env'), { recursive: true });
    const first = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(first.adapter))).rejects.toThrow();
    expect(readInitState(root)?.done).toEqual([]);
    rmSync(join(root, 'auth.env'), { recursive: true });
    // A Codex login made before init stays; only init's own files are removed.
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'auth.json'), '{}');
    const again = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await runInit([], options(again.adapter));
    expect(again.output.join('\n')).toContain('that step starts over');
    expect(existsSync(join(root, '.codex', 'auth.json'))).toBe(true);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
  });

  it('checks the viewer port again before starting the service', async () => {
    let taken = false;
    let statusCalls = 0;
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    const o = options(p.adapter, {
      // Free while the setup is written; taken by the time the service starts.
      portAnswers: async (port) => taken && port === 3847,
      installToolkit: async () => {
        taken = true;
      },
      daemonStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { state: 'stopped', holder: null }
          : { state: 'running', reply: { ok: true, status: { stage: 'running' } } };
      },
    });
    await runInit([], o);
    expect(o.started).toEqual([{ MAMA_API_PORT: '3848' }]);
  });

  it.each(['100', '0', '-0', 'group', '-100abc', '-01'])(
    'refuses a non-group Telegram common destination before writing setup: %s',
    async (chatId) => {
      const p = prompt([], [], [false, false]);
      const env = {
        MAMA_INIT_BACKEND: 'codex',
        MAMA_INIT_MODEL: 'fixture-model',
        MAMA_TELEGRAM_TOKEN: fixtureSecrets.MAMA_TELEGRAM_TOKEN,
        MAMA_INIT_COMMON_CHAT_ID: chatId,
        MAMA_INIT_OWNER_TELEGRAM_ID: OWNER_ID,
        MAMA_INIT_MEMBER_ROOT: memberRoot,
        MAMA_INIT_TOOLS_ROOT: toolsRoot,
      };
      await expect(runInit(['--non-interactive'], options(p.adapter, { env }))).rejects.toThrow(
        /group or supergroup.*negative.*private chats.*personal intake/
      );
      expect(existsSync(root)).toBe(false);
    }
  );

  it('pairs the owner by the code the bot sent and the common group by /bind, typing no ID', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await runInit([], options(p.adapter));
    const config = loadConfig({ home });
    expect(config.telegram).toMatchObject({ owner_chat_id: '-100', allowed_chats: ['-100'] });
    // The owner got the code; the group was told it is the common channel.
    expect(telegram.sent.map((entry) => entry.chat_id)).toEqual([OWNER_ID, '-100']);
    expect(p.output.join('\n')).toContain('send @fixture_bot a new private message');
    expect(p.output.join('\n')).toContain('send /bind in that group');
    // Held messages are dropped first, and every update init read is confirmed at the end, so
    // the daemon never takes the pairing messages.
    expect(telegram.polls[0]).toEqual({ offset: '-1', timeout: '0' });
    expect(telegram.polls.at(-1)).toEqual({ offset: '3', timeout: '0' });
  });

  it('refuses a member folder inside HOME before writing anything or pairing', async () => {
    const answers = minimal();
    answers[2] = join(home, 'members');
    const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/must not overlap HOME/);
    expect(existsSync(root)).toBe(false);
    // Pairing is the last question, so the owner is not asked to pair for a setup that stops.
    expect(telegram.sent).toEqual([]);
  });

  it('refuses a folder other accounts can write when it is named, before pairing', async () => {
    mkdirSync(memberRoot, { recursive: true });
    chmodSync(memberRoot, 0o777);
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(p.adapter))).rejects.toThrow(/written by other accounts/);
    expect(existsSync(root)).toBe(false);
    expect(telegram.sent).toEqual([]);
  });

  it('reports a toolkit that cannot be installed and still starts MAMA', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    const o = options(p.adapter, {
      installToolkit: async () => {
        throw new Error('fixture toolkit needs soffice');
      },
    });
    await runInit([], o);
    expect(p.output.join('\n')).toMatch(
      /document tools could not be installed: fixture toolkit needs soffice.*mama tools install/
    );
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(o.started).toEqual([{}]);
  });

  it('continues a failed setup from its last step, beside a daemon still starting', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    await expect(runInit([], options(p.adapter, { health: async () => false }))).rejects.toThrow(
      /does not answer \/health/
    );
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit']);
    // The daemon the failed wait left starting holds the install; only the service step is left,
    // which writes nothing, so init does not need the lock.
    const daemon = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      const again = prompt([], []);
      const o = options(again.adapter);
      await runInit([], o);
      expect(again.output.join('\n')).toContain(
        'continuing setup: done so far: config, owner, toolkit'
      );
      expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
      expect(o.started).toEqual([{}]);
    } finally {
      daemon.release();
    }
    // A finished setup is not run again.
    await expect(runInit([], options(prompt([], []).adapter))).rejects.toThrow(
      /already set up here/
    );
  });

  it("picks the next free viewer port when another account's MAMA has the default", async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    const o = options(p.adapter, { portAnswers: async (port) => port === 3847 });
    await runInit([], o);
    expect(o.started).toEqual([{ MAMA_API_PORT: '3848' }]);
  });

  it('installs the service with mama service, warning when linger cannot be enabled', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    const calls: string[] = [];
    const o = options(p.adapter, {
      startService: undefined,
      nodePath: '/srv/fixture/node',
      cliPath: '/srv/fixture/cli.js',
      portAnswers: async (port) => port === 3847,
      serviceRun: (command: string, args: string[]) => {
        calls.push([command, ...args].join(' '));
        const failed = command === 'loginctl';
        return {
          status: failed ? 1 : 0,
          stdout: command === 'systemctl' && args.includes('is-active') ? 'inactive\n' : '',
          stderr: '',
          pid: 1,
          output: [],
          signal: null,
        } as never;
      },
    });
    await runInit([], o);
    expect(calls[0]).toBe('loginctl enable-linger fixture');
    expect(calls).toEqual(expect.arrayContaining(['systemctl --user start mama.service']));
    expect(p.output.join('\n')).toContain('sudo loginctl enable-linger fixture');
    const script = readFileSync(join(root, 'start.sh'), 'utf8');
    expect(script).toContain("export MAMA_API_PORT='3848'");
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'mama.service'))).toBe(true);
    expect(script).toContain("exec '/srv/fixture/node' '/srv/fixture/cli.js' daemon");
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
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

  it('refuses when another init set up here while this one asked its questions', async () => {
    const answers = minimal();
    const p = prompt(answers, [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    const ask = p.adapter.text;
    p.adapter.text = async (label) => {
      // A second init writes its record while this one is still at its questions.
      if (label.startsWith('Folder for member workspaces')) {
        mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
        writeFileSync(initStatePath(root), JSON.stringify({ version: 1, done: [] }));
      }
      return ask(label);
    };
    await expect(runInit([], options(p.adapter))).rejects.toThrow(
      /Another mama init set up here meanwhile/
    );
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('names the default port again when it is the free one, replacing the one start.sh carries', async () => {
    const p = prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]);
    let statusCalls = 0;
    let phase: 'config' | 'service' = 'config';
    const o = options(p.adapter, {
      // While the setup is written 3847 is taken (3848 chosen); by the service step 3848 is taken.
      portAnswers: async (port) => (phase === 'config' ? port === 3847 : port === 3848),
      installToolkit: async () => {
        phase = 'service';
      },
      daemonStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { state: 'stopped', holder: null }
          : { state: 'running', reply: { ok: true, status: { stage: 'running' } } };
      },
    });
    await runInit([], o);
    expect(o.started).toEqual([{ MAMA_API_PORT: '3847' }]);
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
    answers.splice(5, 1, 'y', 'channel_test', 'user_test');
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
    answers.splice(6, 1, 'y', 'channel_test', 'user_test');
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
    answers[4] = 'kagemusha';
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

describe('mama init --section', () => {
  const readDoc = () =>
    yaml.load(readFileSync(join(root, 'config.yaml'), 'utf8')) as Record<string, unknown>;
  /** A value auth.env holds, read as start.sh reads it. */
  const secret = (name: string) =>
    new RegExp(`^export ${name}='([^']*)'$`, 'm').exec(
      readFileSync(join(root, 'auth.env'), 'utf8')
    )?.[1];

  /** A finished setup, as the sections find it. */
  async function setUp(): Promise<void> {
    await runInit([], options(prompt(minimal(), [fixtureSecrets.MAMA_TELEGRAM_TOKEN]).adapter));
  }

  it('changes only the part asked for, with its token in auth.env', async () => {
    await setUp();
    const before = readDoc();
    const p = prompt(['y', 'fixture-channel', 'fixture-user'], ['fixture-discord-token']);
    await runInit(['--section', 'discord'], options(p.adapter));
    const after = readDoc();
    expect(after.discord).toEqual({
      ...(before.discord as object),
      enabled: true,
      owner_channel_id: 'fixture-channel',
      allowed_channels: ['fixture-channel'],
      owner_user_ids: ['fixture-user'],
    });
    expect({ ...after, discord: before.discord }).toEqual(before);
    expect(secret('MAMA_DISCORD_TOKEN')).toBe('fixture-discord-token');
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).not.toContain('fixture-discord-token');
    expect(statSync(join(root, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(p.output.join('\n')).toContain('Saved discord. MAMA uses it from its next start');
  });

  it('sets up the sources named and keeps the others', async () => {
    await setUp();
    await runInit(
      ['--section', 'connectors'],
      options(prompt(['trello', 'board-1'], ['fixture-trello-key', 'fixture-trello']).adapter)
    );
    await runInit(
      ['--section', 'connectors'],
      options(prompt(['chatwork', 'room-1'], ['fixture-chatwork']).adapter)
    );
    const loaded = loadConnectorConfig(join(root, 'connectors.json'));
    expect(loaded.ok && Object.keys(loaded.config).sort()).toEqual(['chatwork', 'trello']);
    expect(secret('MAMA_TRELLO_TOKEN')).toBe('fixture-trello');
    expect(secret('MAMA_CHATWORK_TOKEN')).toBe('fixture-chatwork');
    expect(secret('MAMA_TELEGRAM_TOKEN')).toBe('fixture-telegram');
  });

  it('checks a new backend and model as init does, keeping the other agent settings', async () => {
    await setUp();
    const before = readDoc().agent as Record<string, unknown>;
    await runInit(
      ['--section', 'model'],
      options(prompt(['claude', 'fixture-model-2'], []).adapter)
    );
    expect(readDoc().agent).toEqual({ ...before, backend: 'claude', model: 'fixture-model-2' });
    const missing = prompt(['claude'], []);
    await expect(
      runInit(['--section', 'model'], options(missing.adapter, { findExecutable: () => undefined }))
    ).rejects.toThrow(/claude is not on this PATH/);
  });

  it('refuses an answer the setup would refuse, writing nothing', async () => {
    await setUp();
    const before = readFileSync(join(root, 'config.yaml'), 'utf8');
    await expect(
      runInit(['--section', 'timezone'], options(prompt([], [], [true, true], 'Mars/Base').adapter))
    ).rejects.toThrow(/not a valid IANA time zone/);
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe(before);
    await runInit(
      ['--section', 'timezone'],
      options(prompt([], [], [true, true], 'Asia/Tokyo').adapter)
    );
    expect(readDoc().timezone).toBe('Asia/Tokyo');
  });

  it('turns Jev on with its key file and off again, keeping the key', async () => {
    await setUp();
    await runInit(
      ['--section', 'jev'],
      options(prompt([], ['fixture-jev-key'], [true, true], undefined, 'y').adapter)
    );
    expect(loadConfig({ home }).jev).toMatchObject({ enabled: true });
    expect(statSync(join(root, 'jev-key')).mode & 0o777).toBe(0o600);
    await runInit(
      ['--section', 'jev'],
      options(prompt([], [], [true, true], undefined, 'n').adapter)
    );
    expect(readDoc().jev).toMatchObject({ enabled: false });
    expect(readFileSync(join(root, 'jev-key'), 'utf8')).toBe('fixture-jev-key\n');
  });

  it('checks a new bot token against the common group before saving it', async () => {
    await setUp();
    const refused = options(prompt([], ['fixture-telegram-2']).adapter, {
      telegramCall: async () => ({ ok: false, error_code: 401 }),
    });
    await expect(runInit(['--section', 'telegram'], refused)).rejects.toThrow(
      /refused the bot token/
    );
    expect(secret('MAMA_TELEGRAM_TOKEN')).toBe('fixture-telegram');
    await runInit(['--section', 'telegram'], options(prompt([], ['fixture-telegram-2']).adapter));
    expect(secret('MAMA_TELEGRAM_TOKEN')).toBe('fixture-telegram-2');
    expect(readDoc().telegram).toMatchObject({ owner_chat_id: '-100' });
  });

  it('keeps a hand-written config readable and refuses a change its delivery routes forbid', async () => {
    await setUp();
    const path = join(root, 'config.yaml');
    const doc = readDoc();
    doc.discord = {
      enabled: true,
      owner_channel_id: 'fixture-channel',
      allowed_channels: ['fixture-channel'],
      owner_user_ids: ['fixture-user'],
      file_delivery: false,
    };
    doc.delivery = { ...(doc.delivery as object), reports: 'discord' };
    // Written by hand: a comment at the end of a line, and a block MAMA does not read.
    writeFileSync(
      path,
      `${yaml.dump(doc)}legacy_block:\n  since: 2026-07-01 # kept from an older setup\n`
    );
    const handWritten = readFileSync(path, 'utf8');
    await expect(
      runInit(['--section', 'discord'], options(prompt(['n'], []).adapter))
    ).rejects.toThrow(/delivery\.reports targets discord.*set that route in config\.yaml/);
    expect(readFileSync(path, 'utf8')).toBe(handWritten);
    const p = prompt(['y', 'fixture-channel-2', 'fixture-user'], ['fixture-discord-token']);
    await runInit(['--section', 'discord'], options(p.adapter));
    expect(readDoc().discord).toEqual({
      enabled: true,
      owner_channel_id: 'fixture-channel-2',
      allowed_channels: ['fixture-channel-2'],
      owner_user_ids: ['fixture-user'],
      file_delivery: false,
    });
    expect(readDoc()).toHaveProperty('legacy_block');
    expect(p.output.join('\n')).toContain('its comments and layout were not kept');
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a new bot that is not in the common group, saving nothing', async () => {
    await setUp();
    const outside = options(prompt([], ['fixture-telegram-2']).adapter, {
      telegramCall: async (_token, method) =>
        method === 'getMe'
          ? { ok: true, result: { id: 9002, username: 'fixture_bot_2' } }
          : { ok: true, result: { status: 'left' } },
    });
    await expect(runInit(['--section', 'telegram'], outside)).rejects.toThrow(
      /the bot is not in the common group: add the bot to the group/
    );
    expect(secret('MAMA_TELEGRAM_TOKEN')).toBe('fixture-telegram');
  });

  it('checks a Codex login in the Codex home the daemon uses', async () => {
    await setUp();
    const doc = readDoc();
    doc.agent = { ...(doc.agent as object), codex_home: join(home, 'codex-elsewhere') };
    writeFileSync(join(root, 'config.yaml'), yaml.dump(doc));
    const homes: Array<string | undefined> = [];
    const probe = options(prompt(['codex', 'fixture-model'], []).adapter, {
      probeRun: (command, args, env) => {
        if (args[0] === 'login') homes.push(env?.CODEX_HOME);
        return probeOk(command, args);
      },
    });
    await runInit(['--section', 'model'], probe);
    expect(homes).toEqual([join(home, 'codex-elsewhere')]);
  });

  it('refuses without a setup, beside a running MAMA, and for an unknown part', async () => {
    const p = prompt([], []);
    await expect(runInit(['--section', 'timezone'], options(p.adapter))).rejects.toThrow(
      /not set up here; run mama init first/
    );
    await setUp();
    const held = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      await expect(runInit(['--section', 'timezone'], options(p.adapter))).rejects.toThrow(
        /already running here.*stop it first/
      );
    } finally {
      held.release();
    }
    await expect(runInit(['--section', 'folders'], options(p.adapter))).rejects.toThrow(
      /Choose a section: telegram, model/
    );
    await expect(runInit(['--section'], options(p.adapter))).rejects.toThrow(
      /mama init --section <telegram\|model/
    );
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
