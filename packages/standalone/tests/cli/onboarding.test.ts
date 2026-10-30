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
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { tmpdir } from 'node:os';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { defaultToolsRoot } from '../../src/cli/commands/tools.js';
import { runInit, type InitOptions } from '../../src/cli/commands/init.js';
import { runSecret } from '../../src/cli/commands/secret.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';
import type { OpenRun } from '../../src/cli/runtime/setup-page.js';
import { loadConfig } from '../../src/runtime/config.js';
import { loadConnectorConfig } from '../../src/connectors/config-loader.js';
import { defaultRoots, prepareRoot } from '../../src/cli/runtime/default-roots.js';
import { initStatePath, readInitState } from '../../src/cli/runtime/init-state.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  type DaemonControlReply,
} from '../../src/cli/runtime/daemon-control.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { startScript } from '../../src/cli/launch-files.js';

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
 * /bind in the common group, at once or (`bind()`) later. Codes the pairing step sends are kept,
 * so the owner can enter theirs.
 */
function fakeBot(options: { bindEarly?: boolean } = {}) {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const polls: Array<{ offset: string; timeout: string }> = [];
  const bindUpdate = {
    update_id: 2,
    message: {
      chat: { id: -100, type: 'supergroup' },
      from: { id: Number(OWNER_ID) },
      text: '/bind',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  };
  const updates: Array<{ update_id: number; message: Record<string, unknown> }> = [
    {
      update_id: 1,
      message: {
        chat: { id: Number(OWNER_ID), type: 'private' },
        from: { id: Number(OWNER_ID) },
        text: 'hello',
      },
    },
    ...(options.bindEarly === false ? [] : [bindUpdate]),
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
  return { call, sent, polls, code, bind: () => updates.push(bindUpdate) };
}
let telegram: ReturnType<typeof fakeBot>;

/** A form POST to the setup page, as the browser sends it; the page's reply. */
async function post(url: string, fields: Record<string, string>): Promise<string> {
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams(fields) });
  return await response.text();
}

/** What a page driver could not do (a refused connection, say); afterEach expects none. */
const driverFailures: unknown[] = [];

/**
 * The owner at the setup page: the opener stand-in reads the redirect file as the browser would.
 * The owner enters each token in turn, then each code (`sent` is the newest the bot sent them),
 * then runs `after`.
 */
function person(entries: { tokens?: string[]; codes?: string[]; after?: () => void } = {}): {
  openRun: OpenRun;
  opened: string[][];
  replies: string[];
  url: () => string;
} {
  const opened: string[][] = [];
  const replies: string[] = [];
  let url = '';
  return {
    opened,
    replies,
    url: () => url,
    openRun: async (command, args) => {
      opened.push([command, ...args]);
      url = /url=(http[^"]+)"/.exec(readFileSync(args[0]!, 'utf8'))![1]!;
      void (async () => {
        for (const token of entries.tokens ?? [fixtureSecrets.MAMA_TELEGRAM_TOKEN])
          replies.push(await post(url, { token }));
        for (const code of entries.codes ?? ['sent'])
          replies.push(await post(url, { code: code === 'sent' ? await telegram.code() : code }));
        entries.after?.();
      })().catch((error: unknown) => driverFailures.push(error));
      return { exit: Promise.resolve(0) };
    },
  };
}

/** The answers --non-interactive reads; the page takes the token and the code. */
function variables(backend = 'codex'): NodeJS.ProcessEnv {
  return {
    MAMA_INIT_BACKEND: backend,
    MAMA_INIT_MODEL: 'fixture-model',
    MAMA_INIT_MEMBER_ROOT: memberRoot,
    MAMA_INIT_TOOLS_ROOT: toolsRoot,
  };
}

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
    env: variables(),
    platform: 'linux',
    user: 'fixture',
    uid: process.getuid!(),
    // The backend is found; gws is not, and this machine's own tool folders are not looked in.
    findExecutable: (name: string) => (name === 'gws' ? undefined : join(home, 'bin', name)),
    toolDirectoryExists: () => false,
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
    daemonProbe: async () => ({
      state: 'running',
      reply: {
        ok: true,
        probe: { backend: 'codex', model: 'fixture-model', ms: 5, modelRunId: 'fixture-run' },
      },
    }),
    // This machine's own MAMA may hold the default port; the fixture sees every port free.
    portAnswers: async () => false,
    // No browser opens; the owner enters the token and the bot's code.
    openRun: person().openRun,
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
  expect(driverFailures.splice(0)).toEqual([]);
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
  /** The setup as the person's agent runs it: MAMA_INIT_* answers, the page for the rest. */
  function setup(overrides: Partial<InitOptions> = {}) {
    const p = prompt([], [], [false, false]);
    const o = options(p.adapter, overrides);
    return { p, o, run: () => runInit(['--non-interactive'], o) };
  }

  it.each(['claude', 'codex'])(
    'checks, writes, registers the owner, installs the tools and starts the service (%s)',
    async (backend) => {
      const order: string[] = [];
      const { p, o, run } = setup({
        env: variables(backend),
        installToolkit: async () => {
          order.push('toolkit');
        },
      });
      const startService = o.startService!;
      o.startService = async (viewer) => {
        order.push('service');
        await startService(viewer);
      };
      await run();
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
      expect(config.discord).toMatchObject({ enabled: false });
      expect(config.slack).toMatchObject({ enabled: false });
      expect(JSON.parse(readFileSync(join(root, 'connectors.json'), 'utf8'))).toEqual({});
      expect(o.started).toEqual([{}]);
      expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
      expect(readInitState(root)).not.toHaveProperty('pendingOwner');
      for (const file of ['auth.env', 'config.yaml', 'connectors.json'])
        expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      // Init no longer writes the launch files; the service step does, through mama service.
      expect(existsSync(join(root, 'start.sh'))).toBe(false);
      expect(p.output.join('\n')).toContain('MAMA is running');
      expect(p.output.join('\n')).not.toContain('register-owner');
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

  it('is run only with --non-interactive: bare mama init is a usage error', async () => {
    const { o } = setup();
    for (const args of [[], ['--interactive'], ['--non-interactive', 'extra']])
      await expect(runInit(args, o)).rejects.toThrow(
        /^Usage: mama init --non-interactive \| mama init --section </
      );
    expect(existsSync(root)).toBe(false);
  });

  it('refuses a missing, old or signed-out backend before writing anything or pairing', async () => {
    for (const [probe, message] of [
      [undefined, /claude is not on this PATH\. .*then run the install command again\./],
      [
        (_c: string, args: string[]) =>
          ({ ...probeOk(_c, args), stdout: args[0] === '--version' ? '0.1.0' : '' }) as never,
        /older than .*; update it, then run the install command again\./,
      ],
      [
        (_c: string, args: string[]) =>
          ({
            ...probeOk(_c, args),
            stdout: args[0] === '--version' ? '9.9.9' : '{"loggedIn":false}',
          }) as never,
        /claude is not signed in/,
      ],
    ] as const) {
      const { run } = setup({
        env: variables('claude'),
        ...(probe === undefined
          ? { findExecutable: () => undefined }
          : { probeRun: probe as InitOptions['probeRun'] }),
      });
      await expect(run()).rejects.toThrow(message);
      expect(existsSync(root)).toBe(false);
      expect(telegram.sent).toEqual([]);
    }
  });

  it.each(['claude', 'codex'] as const)(
    "names a signed-out %s's login with its full path, for the agent to run",
    async (backend) => {
      const { run } = setup({
        env: variables(backend),
        probeRun: ((command: string, args: string[]) => {
          return {
            ...probeOk(command, args),
            stdout: args[0] === '--version' ? '9.9.9' : '{"loggedIn":false}',
            status: args[0] === 'login' ? 1 : 0,
          } as never;
        }) as InitOptions['probeRun'],
      });
      const login =
        backend === 'claude'
          ? `'${join(home, 'bin', 'claude')}' auth login`
          : `CODEX_HOME='${join(root, '.codex')}' '${join(home, 'bin', 'codex')}' login`;
      await expect(run()).rejects.toThrow(
        `${backend} is not signed in. Run: ${login}, then run the install command again.`
      );
      // Codex refuses a CODEX_HOME that does not exist: MAMA's own is made for the named login.
      if (backend === 'codex') expect(statSync(join(root, '.codex')).mode & 0o777).toBe(0o700);
      expect(existsSync(join(root, 'config.yaml'))).toBe(false);
    }
  );

  it('checks the backend login as the daemon runs it, without secret-shaped variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-shell-key');
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    await setup({
      env: variables('claude'),
      probeRun: (command, args, env) => {
        seen.push(env);
        return probeOk(command, args);
      },
    }).run();
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('refuses a member folder under a folder other accounts can write', async () => {
    const open = `${home}-open`;
    mkdirSync(open, { mode: 0o777 });
    chmodSync(open, 0o777);
    try {
      const { run } = setup({
        env: { ...variables(), MAMA_INIT_MEMBER_ROOT: join(open, 'members') },
      });
      await expect(run()).rejects.toThrow(/Unsafe member_root ancestor/);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('starts the setup step over when an earlier init stopped while writing its files', async () => {
    // auth.env as a folder makes the write fail after the step record is written.
    mkdirSync(join(root, 'auth.env'), { recursive: true });
    await expect(setup().run()).rejects.toThrow();
    expect(readInitState(root)?.done).toEqual([]);
    rmSync(join(root, 'auth.env'), { recursive: true });
    // A Codex login made before init stays; only init's own files are removed.
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'auth.json'), '{}');
    const again = setup();
    await again.run();
    expect(again.p.output.join('\n')).toContain('that step starts over');
    expect(existsSync(join(root, '.codex', 'auth.json'))).toBe(true);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
  });

  it('checks the viewer port again before starting the service', async () => {
    let taken = false;
    let statusCalls = 0;
    const { o, run } = setup({
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
    await run();
    expect(o.started).toEqual([{ MAMA_API_PORT: '3848' }]);
  });

  it('reads no token or Telegram ID from the environment: the page and the bot name them', async () => {
    const { run } = setup({
      env: {
        ...variables(),
        MAMA_TELEGRAM_TOKEN: 'fixture-variable-token',
        MAMA_INIT_COMMON_CHAT_ID: '-555',
        MAMA_INIT_OWNER_TELEGRAM_ID: '999',
      },
    });
    await run();
    expect(loadConfig({ home }).telegram).toMatchObject({
      owner_chat_id: '-100',
      allowed_chats: ['-100'],
    });
    const auth = readFileSync(join(root, 'auth.env'), 'utf8');
    expect(auth).toContain(`MAMA_TELEGRAM_TOKEN='${fixtureSecrets.MAMA_TELEGRAM_TOKEN}'`);
    expect(auth).not.toContain('fixture-variable-token');
    const database = await openCoreDatabase({ path: loadConfig({ home }).database.path });
    try {
      const repo = createPrincipalRepository(database.adapter);
      expect(repo.resolveByExternal('telegram', 'private', OWNER_ID)).toBeTruthy();
      expect(repo.resolveByExternal('telegram', 'private', '999')).toBeFalsy();
    } finally {
      await database.close();
    }
  });

  it('pairs the owner by the code the bot sent and the common group by /bind, typing no ID', async () => {
    const { p, run } = setup();
    await run();
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
    const owner = person();
    const { run } = setup({
      env: { ...variables(), MAMA_INIT_MEMBER_ROOT: join(home, 'members') },
      openRun: owner.openRun,
    });
    await expect(run()).rejects.toThrow(/must not overlap HOME/);
    expect(existsSync(root)).toBe(false);
    // The page comes after every other answer, so the owner is not asked to pair for a setup that
    // stops.
    expect(owner.opened).toEqual([]);
    expect(telegram.sent).toEqual([]);
  });

  it('refuses a folder other accounts can write when it is named, before pairing', async () => {
    mkdirSync(memberRoot, { recursive: true });
    chmodSync(memberRoot, 0o777);
    await expect(setup().run()).rejects.toThrow(/written by other accounts/);
    expect(existsSync(root)).toBe(false);
    expect(telegram.sent).toEqual([]);
  });

  it('takes the tunnel from the viewer variables start.sh carries, and refuses a partial one', async () => {
    const tunnel = {
      MAMA_CF_ACCESS_ISSUER: 'https://access.example.test',
      MAMA_CF_ACCESS_AUD: 'fixture-audience',
      MAMA_VIEWER_HOSTNAMES: 'viewer.example.test',
    };
    for (const [env, message] of [
      [{ MAMA_VIEWER_HOSTNAMES: 'viewer.example.test' }, /needs MAMA_CF_ACCESS_ISSUER/],
      [{ ...tunnel, MAMA_CF_ACCESS_AUD: ' ' }, /needs MAMA_CF_ACCESS_AUD/],
      [
        { ...tunnel, MAMA_CF_ACCESS_ISSUER: 'http://access.example.test' },
        /must be an HTTPS origin/,
      ],
      [{ ...tunnel, MAMA_VIEWER_HOSTNAMES: 'https://viewer.example.test/' }, /one hostname/],
    ] as const) {
      const owner = person();
      await expect(
        setup({ env: { ...variables(), ...env }, openRun: owner.openRun }).run()
      ).rejects.toThrow(message);
      expect(owner.opened).toEqual([]);
    }
    const { o, run } = setup({
      env: {
        ...variables(),
        ...tunnel,
        MAMA_CF_ACCESS_ISSUER: 'https://access.example.test/',
        MAMA_VIEWER_OWNER_EMAILS: 'owner@example.test',
      },
    });
    await run();
    // The settings reach the service step, which writes them into start.sh.
    expect(o.started).toEqual([{ ...tunnel, MAMA_VIEWER_OWNER_EMAILS: 'owner@example.test' }]);
  });

  it('proves the backend with one real turn through the started daemon', async () => {
    const { p, run } = setup();
    await run();
    expect(p.output.join('\n')).toContain('codex (fixture-model) answered a real turn in 5 ms.');
  });

  it('says where to look when the backend does not answer, and checks again on a rerun', async () => {
    let answer: () => Promise<DaemonControlReply> = async () => ({
      state: 'running',
      reply: { ok: false, error: 'Not logged in · fixture backend' },
    });
    const { p, run } = setup({ daemonProbe: () => answer() });
    await expect(run()).rejects.toThrow(
      /did not answer a real turn: Not logged in · fixture backend\. .*then run the install command again\./
    );
    // Everything before the service step is kept; that step is done only once the check passes.
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit']);
    answer = async () => {
      throw new Error('The daemon did not answer within 660000 ms');
    };
    await expect(run()).rejects.toThrow(
      /MAMA did not answer the backend check \(The daemon did not answer within 660000 ms\)/
    );
    answer = async () => ({ state: 'stopped', holder: null });
    await expect(run()).rejects.toThrow(/MAMA stopped before its backend could be checked/);
    answer = async () => ({
      state: 'running',
      reply: { ok: true, probe: { backend: 'codex', model: 'fixture-model', ms: 9 } },
    });
    await run();
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(p.output.join('\n')).toContain('codex (fixture-model) answered a real turn in 9 ms.');
  });

  it('reports a toolkit that cannot be installed and still starts MAMA', async () => {
    const { p, o, run } = setup({
      installToolkit: async () => {
        throw new Error('fixture toolkit needs soffice');
      },
    });
    await run();
    expect(p.output.join('\n')).toMatch(
      /document tools could not be installed: fixture toolkit needs soffice.*mama tools install/
    );
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(o.started).toEqual([{}]);
  });

  it('continues a failed setup from its last step, beside a daemon still starting', async () => {
    await expect(setup({ health: async () => false }).run()).rejects.toThrow(
      /does not answer \/health/
    );
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit']);
    // The daemon the failed wait left starting holds the install; only the service step is left,
    // which writes nothing, so init does not need the lock. No page opens: the answers are in.
    const daemon = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      const owner = person();
      const again = setup({ openRun: owner.openRun });
      await again.run();
      expect(again.p.output.join('\n')).toContain(
        'continuing setup: done so far: config, owner, toolkit'
      );
      expect(owner.opened).toEqual([]);
      expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
      expect(again.o.started).toEqual([{}]);
    } finally {
      daemon.release();
    }
    // A finished setup is not run again; saying so is a status, so the command exits 0. The
    // install command run again on a set-up install ends here.
    const finished = setup();
    await finished.run();
    expect(finished.p.output.join('\n')).toContain(
      'MAMA is already set up here; mama doctor checks it, mama service restart restarts it and mama update updates it.'
    );
    expect(finished.o.started).toEqual([]);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
  });

  it("picks the next free viewer port when another account's MAMA has the default", async () => {
    const { o, run } = setup({ portAnswers: async (port) => port === 3847 });
    await run();
    expect(o.started).toEqual([{ MAMA_API_PORT: '3848' }]);
  });

  it('installs the service with mama service, warning when linger cannot be enabled', async () => {
    const calls: string[] = [];
    const { p, run } = setup({
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
    await run();
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
    let asked = 0;
    await expect(
      setup({
        daemonStatus: async () => {
          asked += 1;
          return asked < 3
            ? { state: 'stopped', holder: null }
            : { state: 'running', reply: { ok: true, status: { stage: 'owner_runtime' } } };
        },
        bootTimeoutMs: 50,
      }).run()
    ).rejects.toThrow(
      /last stage: owner_runtime.*mama logs.*running the install command again continues from here/
    );
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit']);
    await expect(setup({ health: async () => false }).run()).rejects.toThrow(
      /does not answer \/health/
    );
  });

  it('refuses when another init set up here while this one waited on its page', async () => {
    const owner = person();
    const { run } = setup({
      // A second init writes its record while this one's page is open.
      openRun: async (command, args) => {
        mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
        writeFileSync(initStatePath(root), JSON.stringify({ version: 1, done: [] }));
        return await owner.openRun(command, args);
      },
    });
    await expect(run()).rejects.toThrow(
      'Another mama init set up here meanwhile; run the install command again.'
    );
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('names the default port again when it is the free one, replacing the one start.sh carries', async () => {
    let statusCalls = 0;
    let phase: 'config' | 'service' = 'config';
    const { o, run } = setup({
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
    await run();
    expect(o.started).toEqual([{ MAMA_API_PORT: '3847' }]);
  });

  it('refuses while something else holds the install', async () => {
    mkdirSync(root, { mode: 0o700 });
    const held = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      await expect(setup().run()).rejects.toThrow(/daemon/);
    } finally {
      held.release();
    }
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('sets up from MAMA_INIT_* variables and the setup page, refusing a missing one before the page opens', async () => {
    const env = { ...variables(), MAMA_INIT_TIMEZONE: 'Asia/Tokyo' };
    delete env.MAMA_INIT_MODEL;
    const before = person();
    await expect(setup({ env, openRun: before.openRun }).run()).rejects.toThrow(
      /needs MAMA_INIT_MODEL/
    );
    // Refused before the owner pairs.
    expect(before.opened).toEqual([]);
    expect(telegram.sent).toEqual([]);
    expect(existsSync(root)).toBe(false);
    const { p, run } = setup({ env: { ...env, MAMA_INIT_MODEL: 'fixture-model' } });
    await run();
    const config = loadConfig({ home });
    expect(config.timezone).toBe('Asia/Tokyo');
    expect(config.member_root).toBe(memberRoot);
    expect(readInitState(root)?.done).toEqual(['config', 'owner', 'toolkit', 'service']);
    expect(p.output.join('\n')).not.toContain(fixtureSecrets.MAMA_TELEGRAM_TOKEN);
  });

  it('refuses existing config before opening the page or changing auth.env', async () => {
    mkdirSync(root);
    writeFileSync(join(root, 'config.yaml'), 'existing');
    writeFileSync(join(root, 'auth.env'), '# untouched\n');
    await expect(setup().run()).rejects.toThrow(/config.yaml.*exists/);
    expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe('existing');
    expect(readFileSync(join(root, 'auth.env'), 'utf8')).toBe('# untouched\n');
  });
});

describe('the setup page in mama init', () => {
  const setUp = (overrides: Partial<InitOptions> = {}) => {
    const p = prompt([], [], [false, false]);
    return {
      p,
      run: () =>
        runInit(['--non-interactive'], options(p.adapter, { env: variables(), ...overrides })),
    };
  };

  it('says each step in order, and keeps the URL and the token out of every line and reply', async () => {
    const owner = person();
    const { p, run } = setUp({ openRun: owner.openRun });
    await run();
    const steps = [
      /^setup page: opened in the browser from (.+)\/open\.html; it closes at \d\d:\d\d$/,
      /^bot token accepted for @fixture_bot$/,
      /send @fixture_bot a new private message .*enter it on the setup page\.$/,
      /^pairing code accepted$/,
      /^Add @fixture_bot to the group for common work/,
      /^setup page closed$/,
      /^Setup written\./,
    ];
    const at = steps.map((step) => p.output.findIndex((line) => step.test(line)));
    expect(
      at.every((index) => index >= 0),
      p.output.join('\n')
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const file = owner.opened[0]![1]!;
    expect(owner.opened).toEqual([['xdg-open', file]]);
    expect(p.output[at[0]!]).toContain(`from ${file};`);
    // The redirect file's folder goes with the page.
    expect(existsSync(file)).toBe(false);
    const nonce = new URL(owner.url()).pathname.slice(1);
    for (const text of [...p.output, ...owner.opened.flat()]) expect(text).not.toContain(nonce);
    for (const text of [...p.output, ...owner.replies])
      expect(text).not.toContain(fixtureSecrets.MAMA_TELEGRAM_TOKEN);
    expect(owner.replies.at(-1)).toContain('send /bind in that group');
    // The code the bot sent says where it goes.
    expect(telegram.sent[0]!.text).toMatch(
      /^Your MAMA pairing code: \d{6}\nEnter it on the setup page\.$/
    );
  });

  it('shows a token Telegram refuses on the page, and takes the next one', async () => {
    const owner = person({ tokens: ['fixture-refused', fixtureSecrets.MAMA_TELEGRAM_TOKEN] });
    const { p, run } = setUp({
      openRun: owner.openRun,
      telegramCall: async (token, method, params) =>
        token === 'fixture-refused'
          ? { ok: false, error_code: 401 }
          : await telegram.call(token, method, params),
    });
    await run();
    expect(owner.replies[0]).toContain(
      'Telegram refused the bot token; copy it again from BotFather.'
    );
    expect(owner.replies[0]).toContain('name="token"');
    expect(p.output).toContain('Telegram refused the bot token; copy it again from BotFather.');
    const auth = readFileSync(join(root, 'auth.env'), 'utf8');
    expect(auth).toContain(`MAMA_TELEGRAM_TOKEN='${fixtureSecrets.MAMA_TELEGRAM_TOKEN}'`);
    for (const text of [...p.output, ...owner.replies])
      expect(text).not.toContain('fixture-refused');
  });

  it('shows a token it could not check on the page, and takes it once Telegram answers', async () => {
    let down = true;
    const owner = person({
      tokens: [fixtureSecrets.MAMA_TELEGRAM_TOKEN, fixtureSecrets.MAMA_TELEGRAM_TOKEN],
    });
    const { run } = setUp({
      openRun: owner.openRun,
      telegramCall: async (token, method, params) => {
        if (down) {
          down = false;
          throw new TypeError('fetch failed');
        }
        return await telegram.call(token, method, params);
      },
    });
    await run();
    expect(owner.replies[0]).toContain(
      'could not reach Telegram (TypeError), so the token is unchecked; check the network, then enter it again on the setup page.'
    );
    expect(loadConfig({ home }).telegram).toMatchObject({ owner_chat_id: '-100' });
  });

  it('answers a token whose pairing then fails with the sentence and no form', async () => {
    // Telegram hands the bot's messages to one reader: another program already polls this bot.
    const owner = person({ codes: [] });
    const { run } = setUp({
      openRun: owner.openRun,
      telegramCall: async (token, method, params) =>
        method === 'getUpdates'
          ? { ok: false, error_code: 409 }
          : await telegram.call(token, method, params),
    });
    await expect(run()).rejects.toThrow(/Another program is reading this bot's messages/);
    await vi.waitFor(() => expect(owner.replies).toHaveLength(1));
    expect(owner.replies[0]).toContain('Another program is reading this bot&#39;s messages');
    expect(owner.replies[0]).toContain('This page has closed.');
    expect(owner.replies[0]).not.toContain('<form');
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
  });

  it('shows a wrong code on the page, and takes the right one', async () => {
    const owner = person({ codes: ['000000', 'sent'] });
    const { p, run } = setUp({ openRun: owner.openRun });
    await run();
    const wrong = 'That is not a code the bot sent; enter the code from its latest message.';
    expect(owner.replies[1]).toContain(wrong);
    expect(owner.replies[1]).toContain('name="code"');
    expect(p.output).toContain(wrong);
    expect(loadConfig({ home }).telegram).toMatchObject({ owner_chat_id: '-100' });
  });

  it('takes a /bind sent before the code is entered, and one sent after', async () => {
    // Before: the bot holds the /bind by the time the code is entered (the fixture's default).
    await setUp().run();
    expect(loadConfig({ home }).telegram).toMatchObject({ owner_chat_id: '-100' });
    rmSync(root, { recursive: true, force: true });
    // After: the page has closed when the /bind arrives.
    telegram = fakeBot({ bindEarly: false });
    const owner = person({ after: () => telegram.bind() });
    const { p, run } = setUp({ openRun: owner.openRun });
    await run();
    expect(loadConfig({ home }).telegram).toMatchObject({ owner_chat_id: '-100' });
    expect(p.output.indexOf('setup page closed')).toBeLessThan(
      p.output.findIndex((line) => line.startsWith('Setup written'))
    );
  });

  it('expires with nothing written when the code is not entered in time', async () => {
    const owner = person({ codes: [] });
    const { p, run } = setUp({ openRun: owner.openRun, setupPageMs: 1000 });
    await expect(run()).rejects.toThrow(
      /^the setup page expired at \d\d:\d\d; nothing was written$/
    );
    expect(p.output).toContain('bot token accepted for @fixture_bot');
    expect(p.output).toContain('setup page closed');
    expect(existsSync(join(root, 'config.yaml'))).toBe(false);
    expect(existsSync(join(root, 'auth.env'))).toBe(false);
    expect(existsSync(owner.opened[0]![1]!)).toBe(false);
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
    await runInit(['--non-interactive'], options(prompt([], [], [false, false]).adapter));
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
    expect(p.output.join('\n')).toContain(
      'Saved discord. Check the install with mama doctor, then start MAMA'
    );
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
    for (const folder of [root, join(root, 'runtime')])
      expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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
      /the bot is not in the common group: add the bot to the group.*token was not saved/
    );
    // Membership Telegram would not confirm is no better than none.
    const unknown = options(prompt([], ['fixture-telegram-2']).adapter, {
      telegramCall: async (_token, method) =>
        method === 'getMe'
          ? { ok: true, result: { id: 9002, username: 'fixture_bot_2' } }
          : { ok: false, error_code: 500 },
    });
    await expect(runInit(['--section', 'telegram'], unknown)).rejects.toThrow(
      /did not answer about the common group/
    );
    expect(secret('MAMA_TELEGRAM_TOKEN')).toBe('fixture-telegram');
  });

  it('refuses sources boot would refuse, and replaces an entry whatever its case', async () => {
    await setUp();
    // A vault holding the wiki would read MAMA's own wiki writes back as source changes.
    const before = readFileSync(join(root, 'connectors.json'), 'utf8');
    const vault = options(prompt(['obsidian', root], []).adapter);
    await expect(runInit(['--section', 'connectors'], vault)).rejects.toThrow(
      /connectors.json would be refused at boot: .*contains the configured wiki root/
    );
    expect(readFileSync(join(root, 'connectors.json'), 'utf8')).toBe(before);
    expect(readdirSync(join(root, 'runtime')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    writeFileSync(
      join(root, 'connectors.json'),
      JSON.stringify({
        Trello: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'board-0': { role: 'hub', boardId: 'board-0' } },
          auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' },
        },
      })
    );
    await runInit(
      ['--section', 'connectors'],
      options(prompt(['trello', 'board-1'], ['fixture-trello-key', 'fixture-trello']).adapter)
    );
    const saved = JSON.parse(readFileSync(join(root, 'connectors.json'), 'utf8')) as Record<
      string,
      { channels: object }
    >;
    expect(Object.keys(saved)).toEqual(['trello']);
    expect(Object.keys(saved.trello.channels)).toEqual(['board-1']);
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

  it.each(['claude', 'codex'] as const)(
    "runs a signed-out %s's own login on the terminal, then reads the login again",
    async (backend) => {
      await setUp();
      let signedIn = false;
      const ran: Array<{ command: string; args: string[]; codexHome: string | undefined }> = [];
      const probe = (command: string, args: string[]) =>
        ({
          ...probeOk(command, args),
          stdout:
            args[0] === '--version'
              ? '9.9.9'
              : args[0] === 'auth' && signedIn
                ? '{"loggedIn":true}'
                : '{"loggedIn":false}',
          status: backend === 'codex' && args[0] === 'login' && !signedIn ? 1 : 0,
        }) as never;
      const p = prompt([backend, 'fixture-model-2'], []);
      await runInit(
        ['--section', 'model'],
        options(p.adapter, {
          probeRun: probe as InitOptions['probeRun'],
          signIn: (command, args, env) => {
            ran.push({ command, args, codexHome: env.CODEX_HOME });
            signedIn = true;
            return 0;
          },
        })
      );
      expect(ran).toEqual([
        backend === 'claude'
          ? { command: join(home, 'bin', 'claude'), args: ['auth', 'login'], codexHome: undefined }
          : {
              command: join(home, 'bin', 'codex'),
              args: ['login'],
              codexHome: join(root, '.codex'),
            },
      ]);
      expect(p.output.join('\n')).toContain(`${backend} is not signed in; running: `);
      expect(readDoc().agent).toMatchObject({ backend, model: 'fixture-model-2' });
    }
  );

  it('offers the only backend on PATH as the answer Enter keeps', async () => {
    await setUp();
    const labels: string[] = [];
    const p = prompt(['', 'fixture-model-2'], []);
    const text = p.adapter.text;
    p.adapter.text = async (label) => {
      labels.push(label);
      return await text(label);
    };
    await runInit(
      ['--section', 'model'],
      options(p.adapter, {
        findExecutable: (name) => (name === 'codex' ? join(home, 'bin', name) : undefined),
      })
    );
    expect(labels[0]).toBe('Backend (claude|codex) [codex]');
    expect(readDoc().agent).toMatchObject({ backend: 'codex', model: 'fixture-model-2' });
  });

  it('sets up Slack bot and Socket Mode credentials for an owner gateway', async () => {
    await setUp();
    const p = prompt(
      ['y', 'channel_test', 'user_test'],
      ['fixture-slack-owner', 'fixture-slack-app-owner']
    );
    await runInit(['--section', 'slack'], options(p.adapter));
    expect(loadConfig({ home }).slack).toMatchObject({
      enabled: true,
      owner_channel_id: 'channel_test',
      allowed_channels: ['channel_test'],
      owner_user_ids: ['user_test'],
    });
    expect(secret('MAMA_SLACK_TOKEN')).toBe('fixture-slack-owner');
    expect(secret('MAMA_SLACK_APP_TOKEN')).toBe('fixture-slack-app-owner');
  });

  it('wires every selected connector without leaking credentials', async () => {
    await setUp();
    const sourceSecrets = Object.entries(fixtureSecrets).filter(
      ([name]) => name !== 'MAMA_TELEGRAM_TOKEN'
    );
    const p = prompt(
      [
        'slack,chatwork,trello,calendar,notion,discord,telegram',
        'channel-a,channel-b',
        'room-a',
        'board-a',
        'calendar',
        'channel-discord',
        'chat-telegram',
      ],
      sourceSecrets.map(([, value]) => value)
    );
    await runInit(['--section', 'connectors'], options(p.adapter));
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
    const auth = execFileSync('/bin/sh', ['-c', '. "$1"; env', 'sh', join(root, 'auth.env')], {
      env: { HOME: home },
      encoding: 'utf8',
    });
    for (const [name, value] of Object.entries(fixtureSecrets))
      expect(auth.includes(`${name}=${value}\n`)).toBe(true);
    const publicFiles = ['config.yaml', 'connectors.json'].map((file) =>
      readFileSync(join(root, file), 'utf8')
    );
    for (const text of [...publicFiles, readFileSync(initStatePath(root), 'utf8'), ...p.output])
      for (const [, value] of sourceSecrets) expect(text.includes(value)).toBe(false);
    expect(p.output.join('\n')).toContain('gws auth login');
    expect(p.answers).toEqual([]);
    expect(p.hidden).toEqual([]);
  });

  it('asks the fields the Google, vault, and project sources need', async () => {
    await setUp();
    const vaultPath = join(home, 'fixture-vault');
    const p = prompt(
      [
        'gmail,drive,sheets,notion,obsidian,claude-code,imessage',
        'folder-fixture',
        'spreadsheet-fixture',
        'Records!A1:B1',
        '',
        vaultPath,
        'project-fixture',
        'Fixture Project',
        'chat-fixture-1',
      ],
      [fixtureSecrets.MAMA_NOTION_TOKEN]
    );
    await runInit(['--section', 'connectors'], options(p.adapter));
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
    await setUp();
    const before = readFileSync(join(root, 'connectors.json'), 'utf8');
    await expect(
      runInit(['--section', 'connectors'], options(prompt(['kagemusha'], []).adapter))
    ).rejects.toThrow(/Choose connectors from/);
    expect(readFileSync(join(root, 'connectors.json'), 'utf8')).toBe(before);
  });

  it('refuses without a setup, beside a running MAMA, and for an unknown part', async () => {
    const p = prompt([], []);
    await expect(runInit(['--section', 'timezone'], options(p.adapter))).rejects.toThrow(
      /not set up here; run the install command first/
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
  it('refuses without both TTYs', async () => {
    for (const tty of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      await expect(
        runSecret(['set', 'MAMA_TELEGRAM_TOKEN'], { home, prompt: prompt([], [], tty).adapter })
      ).rejects.toThrow(/TTY/);
    }
    expect(existsSync(root)).toBe(false);
  });
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

describe('tools a source needs (install.md, PR 3)', () => {
  /** An executable `gws` in `folder` under this test's HOME. */
  function gwsIn(folder: string): string {
    const path = join(home, folder, 'gws');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
    return path;
  }
  /** A shell that finds the backend, and gws only at `gws`. */
  const shell = (gws?: string) => (name: string) =>
    name === 'gws' ? gws : join(home, 'bin', name);
  /** What the install command makes: start.sh will run ~/.mama/node on the ~/.mama/npm package. */
  const managed = () => ({
    nodePath: join(root, 'node', 'bin', 'node'),
    cliPath: join(
      root,
      'npm',
      'lib',
      'node_modules',
      '@jungjaehoon',
      'mama-os',
      'dist',
      'cli',
      'index.js'
    ),
  });
  /** A finished setup with no source, as the whole setup leaves it. */
  const setUp = () =>
    runInit(['--non-interactive'], options(prompt([], [], [false, false]).adapter));
  /** Gmail enabled with `mama init --section connectors`; what it printed. */
  async function enableGmail(overrides: Partial<InitOptions>): Promise<string> {
    const p = prompt(['gmail'], []);
    await runInit(['--section', 'connectors'], options(p.adapter, overrides));
    return p.output.join('\n');
  }
  /**
   * A setup stopped at the service step, with Gmail in connectors.json: the whole setup enables
   * no source, so a source there was enabled with --section (here written as that writes it).
   */
  async function stoppedWithGmail(auth: Record<string, unknown>): Promise<void> {
    await expect(
      runInit(
        ['--non-interactive'],
        options(prompt([], [], [false, false]).adapter, {
          findExecutable: shell(),
          startService: async () => {
            throw new Error('fixture: MAMA did not finish starting');
          },
        })
      )
    ).rejects.toThrow(/did not finish starting/);
    writeFileSync(
      join(root, 'connectors.json'),
      JSON.stringify({
        gmail: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { inbox: { role: 'hub' } },
          auth,
        },
      })
    );
  }
  const gwsAuth = { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' };

  it('the whole setup enables no source, so it names no tool', async () => {
    const p = prompt([], [], [false, false]);
    await runInit(['--non-interactive'], options(p.adapter, { findExecutable: shell() }));
    expect(p.output.join('\n')).not.toContain('gws');
  });

  it('--section connectors: gws missing names how to install it, with the managed Node on a script-made install', async () => {
    await setUp();
    const npm = await enableGmail({ findExecutable: shell() });
    expect(npm).toContain(
      [
        "gmail runs gws, which the service's PATH does not have. Install it with one of:",
        '  npm install -g @googleworkspace/cli',
        '  brew install googleworkspace-cli',
        'Then log in to gws with the scopes gmail needs:',
        '  gws auth login',
      ].join('\n')
    );
    const script = await enableGmail({ findExecutable: shell(), ...managed() });
    expect(script).toContain(
      [
        "gmail runs gws, which the service's PATH does not have. Install it:",
        '  PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/node/bin/npm install -g --prefix ~/.mama/npm @googleworkspace/cli',
        'Then log in to gws with the scopes gmail needs:',
        '  PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/npm/bin/gws auth login',
      ].join('\n')
    );
  });

  it('the install command run again after the service did not start names gws again', async () => {
    // The source names its tool in its own requirements; connectors.json's auth, here edited by
    // hand to a command MAMA has no methods for, is not what it runs.
    await stoppedWithGmail({ type: 'cli', cli: 'some-other-tool' });
    const again = prompt([], [], [false, false]);
    await runInit(['--non-interactive'], options(again.adapter, { findExecutable: shell() }));
    const output = again.output.join('\n');
    expect(output).toContain('continuing setup');
    expect(output).toContain("gmail runs gws, which the service's PATH does not have.");
    expect(output).toContain('running the install command again continues it.');
  });

  it('the install command run again reads a hand-edited connectors.json as boot does', async () => {
    await stoppedWithGmail(gwsAuth);
    // Boot reads names in any case and ignores the ones it does not know, whatever their value.
    const file = join(root, 'connectors.json');
    const { gmail: entry } = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ Gmail: entry, nonsense: { enabled: true }, other: null }));
    const again = prompt([], [], [false, false]);
    await runInit(['--non-interactive'], options(again.adapter, { findExecutable: shell() }));
    expect(again.output.join('\n')).toContain(
      "gmail runs gws, which the service's PATH does not have."
    );
  });

  it("--section connectors: gws on the shell's PATH only is carried into the start.sh to come, so only its login is named", async () => {
    await setUp();
    const output = await enableGmail({ findExecutable: shell(gwsIn('shell-bin')) });
    expect(output).toContain('Log in to gws with the scopes gmail needs: gws auth login');
    expect(output).not.toContain('Install it');
  });

  it("--section connectors: gws on the service's PATH only is logged in to as the service runs it", async () => {
    await setUp();
    // The managed prefix's bin is on start.sh's PATH (PR 2), not on the shell's.
    gwsIn('.mama/npm/bin');
    const output = await enableGmail({ findExecutable: shell(), ...managed() });
    expect(output).toContain(
      'Log in to gws with the scopes gmail needs: PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/npm/bin/gws auth login'
    );
    expect(output).not.toContain('Install it');
  });

  it('init --section connectors before start.sh exists reports without the backend on PATH', async () => {
    await setUp();
    expect(existsSync(join(root, 'start.sh'))).toBe(false);
    const p = prompt(['gmail'], []);
    await runInit(
      ['--section', 'connectors'],
      options(p.adapter, { findExecutable: () => undefined })
    );
    expect(p.output.join('\n')).toContain(
      "gmail runs gws, which the service's PATH does not have. Install it with one of:"
    );
  });

  describe('init --section connectors, against start.sh', () => {
    /** A finished setup whose start.sh's PATH names `folders` (and the system's). */
    async function setUp(folders: string[], node = join(home, 'node', 'bin', 'node')) {
      await runInit(['--non-interactive'], options(prompt([], [], [false, false]).adapter));
      writeFileSync(
        join(root, 'start.sh'),
        startScript({
          home,
          nodePath: node,
          cliPath: join(home, 'cli', 'index.js'),
          executablePaths: [join(home, 'bin', 'codex'), ...folders.map((f) => join(f, 'x'))],
          exists: () => false,
          viewer: {},
          logLevel: 'info',
        }),
        { mode: 0o700 }
      );
    }
    async function section(findExecutable: InitOptions['findExecutable']): Promise<string> {
      const p = prompt(['gmail'], []);
      await runInit(['--section', 'connectors'], options(p.adapter, { findExecutable }));
      return p.output.join('\n');
    }

    it('gws missing', async () => {
      await setUp([]);
      const output = await section(shell());
      expect(output).toContain(
        "gmail runs gws, which the service's PATH does not have. Install it with one of:\n  npm install -g @googleworkspace/cli"
      );
      expect(output).toContain(
        "MAMA's service does not start with gmail until gws is on its PATH. Once it is installed, run mama service install (it adds the folder gws went to), then start MAMA: mama service start"
      );
    });

    it("gws on the shell's PATH only: mama service install adds its folder", async () => {
      await setUp([]);
      const found = gwsIn('shell-bin');
      const output = await section(shell(found));
      expect(output).toContain(
        `gmail runs gws; this shell finds ${found}, but the service's PATH does not name ${dirname(found)}. mama service install adds it; mama service restart then applies it.`
      );
      expect(output).toContain(
        "MAMA's service does not start with gmail until gws is on its PATH."
      );
      expect(output).toContain('Log in to gws with the scopes gmail needs: gws auth login');
      expect(output).not.toContain('Install it');
    });

    it('a start.sh that does not parse is named, with the command that rewrites it', async () => {
      await setUp([]);
      writeFileSync(join(root, 'start.sh'), "#!/bin/sh\nexport PATH='/usr/bin\n", { mode: 0o700 });
      await expect(
        runInit(['--section', 'connectors'], options(prompt(['gmail'], []).adapter))
      ).rejects.toThrow(
        `${join(root, 'start.sh')} does not parse (unterminated single quote); mama service install --replace rewrites it`
      );
    });

    // Root reads a file whatever its mode.
    it.skipIf(process.getuid?.() === 0)(
      'a start.sh that cannot be read keeps its own error',
      async () => {
        await setUp([]);
        chmodSync(join(root, 'start.sh'), 0o000);
        try {
          await expect(
            runInit(['--section', 'connectors'], options(prompt(['gmail'], []).adapter))
          ).rejects.toThrow(/EACCES/);
        } finally {
          chmodSync(join(root, 'start.sh'), 0o700);
        }
      }
    );

    it("gws on the service's PATH", async () => {
      const found = gwsIn('tool-bin');
      await setUp([dirname(found)]);
      const output = await section(shell());
      expect(output).toContain(
        'Log in to gws with the scopes gmail needs: ~/tool-bin/gws auth login'
      );
      expect(output).not.toContain('Install it');
    });

    it('on a script-made install, in the managed prefix', async () => {
      const found = gwsIn('.mama/npm/bin');
      await setUp([dirname(found)], join(root, 'node', 'bin', 'node'));
      expect(await section(shell())).toContain(
        'Log in to gws with the scopes gmail needs: PATH="$HOME/.mama/node/bin:$PATH" ~/.mama/npm/bin/gws auth login'
      );
    });
  });
});
