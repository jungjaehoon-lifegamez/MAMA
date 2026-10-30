import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { highestMigrationVersion, MIGRATIONS_DIR } from '@jungjaehoon/mama-core/db-manager';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { loadConnector } from '../../src/connectors/index.js';
import { compareVersions, probeBackend } from '../../src/cli/runtime/backend-probe.js';
import { runDiagnostics, type Check } from '../../src/cli/runtime/diagnostics.js';
import { systemdUnitPath } from '../../src/cli/runtime/systemd-service.js';
import {
  removeUpdateJournal,
  updatePaths,
  writeUpdateJournal,
} from '../../src/cli/runtime/update-journal.js';
import { runStatus } from '../../src/cli/commands/control.js';
import {
  readStartScript,
  shellWords,
  stableNodePath,
  startExports,
  startPathValue,
  startScript,
  versionedNodePath,
} from '../../src/cli/launch-files.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const roots: string[] = [];
beforeEach(() => {
  // launchctl print: not loaded.
  vi.mocked(spawnSync).mockReturnValue(result(113));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function result(status: number, stdout = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr: '', signal: null, pid: 1, output: [] } as never;
}

const TOKEN = '123456789:AAFixtureSecretTokenValueThatMustNotLeak';
const CHAT = '-1009876543210';
// The MAMA command start.sh runs: this package, which has better-sqlite3 installed.
const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

interface InstallOptions {
  node?: string;
  gone?: boolean;
  config?: Record<string, unknown>;
  connectors?: unknown;
  auth?: Record<string, string>;
  carried?: string[];
}

/** An install whose start.sh runs `node` (relative to the temp home, created unless `gone`). */
function install(options: InstallOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mama-doctor-'));
  roots.push(home);
  const root = join(home, '.mama');
  mkdirSync(join(root, 'logs'), { recursive: true });
  const node = join(home, options.node ?? 'node/bin/node');
  if (!options.gone) {
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, '');
  }
  writeFileSync(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      member_root: join(tmpdir(), 'mama-doctor-members-outside'),
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: { enabled: true, owner_chat_id: CHAT, allowed_chats: [CHAT], polling: false },
      ...options.config,
    })
  );
  if (options.connectors !== undefined) {
    writeFileSync(
      join(root, 'connectors.json'),
      typeof options.connectors === 'string'
        ? options.connectors
        : JSON.stringify(options.connectors)
    );
  }
  const auth = { MAMA_TELEGRAM_TOKEN: TOKEN, ...options.auth };
  writeFileSync(
    join(root, 'auth.env'),
    Object.entries(auth)
      .map(([name, value]) => `export ${name}='${value}'\n`)
      .join(''),
    { mode: 0o600 }
  );
  writeFileSync(
    join(root, 'start.sh'),
    startScript({
      home,
      nodePath: node,
      cliPath: CLI,
      executablePaths: ['/fixture/bin/claude'],
      viewer: {},
      logLevel: 'info',
      carried: options.carried ?? [],
    }),
    { mode: 0o700 }
  );
  return { home, root, node, configPath: join(root, 'config.yaml') };
}

/** The commands doctor runs, answering as given; anything else is not found. */
function host(
  options: {
    version?: string;
    loggedIn?: boolean;
    sqlite?: boolean;
    sandbox?: boolean;
    socat?: boolean;
  } = {}
) {
  return vi.fn((command: string, args: string[], _env?: NodeJS.ProcessEnv) => {
    if (args[0] === '--version')
      return result(0, `${options.version ?? '2.1.299'} (Claude Code)\n`);
    if (args[0] === 'auth') {
      return result(0, JSON.stringify({ loggedIn: options.loggedIn ?? true, email: 'a@b.test' }));
    }
    if (args[0] === '-e') return options.sqlite === false ? result(1) : result(0, 'v22.13.0');
    if (command.endsWith('/socat')) return result(options.socat === false ? 1 : 0);
    if (command === '/usr/bin/sandbox-exec' || command.endsWith('/bwrap')) {
      return result(options.sandbox === false ? 1 : 0);
    }
    return result(127);
  });
}

const getMe = (overrides: Record<string, unknown> = {}, member: unknown = 'member') =>
  vi.fn(async (_token: string, method: string) =>
    method === 'getMe'
      ? { ok: true, result: { id: 7, can_read_all_group_messages: true, ...overrides } }
      : member === null
        ? { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
        : { ok: true, result: { status: member } }
  );

const stopped = async () => ({ state: 'stopped' as const, holder: null });

function base(installed: { home: string; configPath: string }) {
  return {
    home: installed.home,
    configPath: installed.configPath,
    platform: 'darwin' as const,
    run: host(),
    findIn: (name: string) => `/fixture/bin/${name}`,
    telegramCall: getMe(),
    askStatus: stopped,
    portInUse: async () => false,
  };
}

const byName = (checks: Check[]) => Object.fromEntries(checks.map((check) => [check.name, check]));

describe('backend probe', () => {
  it('compares versions and reads the login without the account details', () => {
    expect(compareVersions('2.1.299', '2.1.299')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.299')).toBeGreaterThan(0);
    expect(compareVersions('2.0.9', '2.1.0')).toBeLessThan(0);
    expect(probeBackend('claude', '/x/claude', { run: host() })).toEqual({
      version: '2.1.299',
      minimum: '2.1.299',
      versionOk: true,
      loggedIn: true,
      problem: null,
    });
    expect(
      probeBackend('claude', '/x/claude', { run: host({ version: '2.1.200', loggedIn: false }) })
    ).toMatchObject({ versionOk: false, loggedIn: false });
    const codex = vi.fn((_c: string, args: string[], env?: NodeJS.ProcessEnv) =>
      args[0] === '--version'
        ? result(0, 'codex-cli 0.160.1\n')
        : result(env?.CODEX_HOME === '/managed/.codex' ? 0 : 1)
    );
    expect(
      probeBackend('codex', '/x/codex', { run: codex, codexHome: '/managed/.codex' }).loggedIn
    ).toBe(true);
  });

  it("asks with the daemon's environment: the service PATH and no credential variables", async () => {
    const installed = install({ carried: ["export CLAUDE_CODE_OAUTH_TOKEN='from-the-shell'"] });
    const run = host();
    await runDiagnostics({ ...base(installed), run });
    const auth = run.mock.calls.find(([, args]) => args[0] === 'auth');
    expect(auth?.[2]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(auth?.[2]?.PATH?.split(':')).toContain(dirname(installed.node));
    expect(auth?.[2]?.HOME).toBe(installed.home);
  });
});

describe('Node path and start.sh reading', () => {
  it('moves a Homebrew Cellar path to the opt link that survives upgrades', () => {
    const exists = (path: string) => path === '/opt/homebrew/opt/node/bin/node';
    expect(stableNodePath('/opt/homebrew/Cellar/node/25.8.0/bin/node', exists)).toBe(
      '/opt/homebrew/opt/node/bin/node'
    );
    expect(stableNodePath('/opt/homebrew/Cellar/node@22/22.13.0/bin/node', () => false)).toBe(
      '/opt/homebrew/Cellar/node@22/22.13.0/bin/node'
    );
    expect(stableNodePath('/usr/local/bin/node', exists)).toBe('/usr/local/bin/node');
    expect(versionedNodePath('/opt/homebrew/Cellar/node/25.8.0/bin/node')).toBe(true);
    expect(versionedNodePath('/srv/.nvm/versions/node/v22.13.0/bin/node')).toBe(true);
    expect(versionedNodePath('/opt/homebrew/opt/node/bin/node')).toBe(false);
  });

  it('reads words as sh does, including the quoting mama writes for an apostrophe', () => {
    expect(shellWords(`exec '/opt/it'"'"'s/node' "/a b/cli.js" daemon >> '/l' 2>&1`)).toEqual([
      'exec',
      "/opt/it's/node",
      '/a b/cli.js',
      'daemon',
      '>>',
      '/l',
      '2>&1',
    ]);
    expect(
      startPathValue(`"$HOME/.local/bin:\${HOME}/bin:~/x:/usr/bin:$PATH:$HOMEX/y"`, '/h')
    ).toEqual(['/h/.local/bin', '/h/bin', '/h/x', '/usr/bin', '$HOMEX/y']);
    expect(shellWords("export A='x'  # the owner's note")).toEqual(['export', 'A=x']);
    expect(shellWords('a#b')).toEqual(['a#b']);
    const reading = readStartScript("export MAMA_API_PORT='4000'\nexport X=\"a'b\"\n", '/h');
    expect(startExports(reading)).toEqual({ MAMA_API_PORT: '4000', X: "a'b" });
  });

  it('reads a Node path with an apostrophe from a generated start.sh', async () => {
    const installed = install({ node: "it's/bin/node" });
    const by = byName(await runDiagnostics(base(installed)));
    expect(by.node).toMatchObject({ status: 'ok', context: installed.node });
  });
});

describe('mama doctor', () => {
  it('names an unfinished update with the command that resolves it, and staging left before one', async () => {
    const installed = install();
    // An npm install: start.sh runs the package under a prefix's lib/node_modules.
    const prefix = join(installed.home, 'prefix');
    const scope = join(prefix, 'lib', 'node_modules', '@jungjaehoon');
    const packageRoot = join(scope, 'mama-os');
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@jungjaehoon/mama-os', version: '1.0.0' })
    );
    writeFileSync(join(packageRoot, 'dist', 'cli', 'index.js'), '');
    writeFileSync(
      join(installed.root, 'start.sh'),
      startScript({
        home: installed.home,
        nodePath: installed.node,
        cliPath: join(packageRoot, 'dist', 'cli', 'index.js'),
        executablePaths: ['/fixture/bin/claude'],
        viewer: {},
        logLevel: 'info',
      }),
      { mode: 0o700 }
    );
    expect(byName(await runDiagnostics(base(installed))).update).toBeUndefined();

    // An updater killed while it staged, before its journal.
    mkdirSync(join(scope, '.mama-update-1.1.0'));
    expect(byName(await runDiagnostics(base(installed))).update).toEqual({
      name: 'update',
      status: 'warn',
      detail: 'an interrupted mama update left its staging folder; the install runs as before',
      code: 'update.staging',
      // The package's real path: the folder npm names.
      context: join(realpathSync(scope), '.mama-update-1.1.0'),
      fix: 'the next mama update removes it',
    });

    // One killed after the swap: the previous CLI is set aside, and the command names it.
    const aside = join(scope, '.mama-os-1.0.0');
    mkdirSync(join(installed.root, 'runtime'), { recursive: true });
    writeUpdateJournal(updatePaths(installed.root).journal, {
      format: 'mama-update',
      phase: 'prepare',
      step: 9,
      from: '1.0.0',
      to: '1.1.0',
      prefix,
      registry: 'http://registry.fixture.test/',
      nodePath: installed.node,
      packageCli: join('dist', 'cli', 'index.js'),
      previousCli: join(aside, 'dist', 'cli', 'index.js'),
      failuresBefore: [],
      snapshot: null,
      snapshotStaging: null,
      schemaBefore: null,
      lastInputId: null,
      toolkitBefore: null,
      toolkitInstalled: false,
      copies: [],
      failure: null,
      startedAt: '2026-10-30T00:00:00.000Z',
    });
    mkdirSync(aside);
    const open = byName(await runDiagnostics(base(installed))).update;
    expect(open).toEqual({
      name: 'update',
      status: 'fail',
      detail:
        'the update from 1.0.0 to 1.1.0 is unfinished (prepare, step 9); the daemon stays stopped or held until it is resolved',
      code: 'update.open',
      fix: `'${installed.node}' '${join(aside, 'dist', 'cli', 'index.js')}' update --rollback`,
    });
    // mama status names it too while the daemon is stopped.
    const lines: string[] = [];
    expect(
      await runStatus([], {
        home: installed.home,
        configPath: installed.configPath,
        write: (line) => lines.push(line),
      })
    ).toBe(3);
    expect(lines).toContain(
      `update unfinished: 1.0.0 → 1.1.0 (prepare, step 9); resolve it with: ${open.fix}`
    );

    // A hold file left without its journal: start.sh exits at once, and nothing else said why.
    const { hold, journal } = updatePaths(installed.root);
    writeFileSync(hold, '1\n');
    removeUpdateJournal(journal);
    expect(byName(await runDiagnostics(base(installed))).update).toEqual({
      name: 'update',
      status: 'fail',
      detail:
        'an update hold file is in place with no update journal; start.sh exits at once, so the daemon does not start',
      code: 'update.hold',
      context: hold,
      fix: `rm ${hold}, then mama service start`,
    });
    lines.length = 0;
    await runStatus([], {
      home: installed.home,
      configPath: installed.configPath,
      write: (line) => lines.push(line),
    });
    expect(lines).toContain(
      `update hold file ${hold} is in place with no journal, so start.sh exits at once; remove it, then mama service start`
    );

    // A journal that does not parse is named, not a crash of mama status.
    writeFileSync(journal, '{not json');
    lines.length = 0;
    expect(
      await runStatus([], {
        home: installed.home,
        configPath: installed.configPath,
        write: (line) => lines.push(line),
      })
    ).toBe(3);
    expect(
      lines.some((line) => /^update journal cannot be read: .+; mama doctor names it$/.test(line))
    ).toBe(true);
  });

  it('passes a healthy install and exits 0', async () => {
    const installed = install();
    const by = byName(await runDiagnostics(base(installed)));
    expect(by.config.status).toBe('ok');
    expect(by.member_root.status).toBe('ok');
    expect(by.node).toMatchObject({ status: 'ok', detail: 'v22.13.0 loads SQLite' });
    expect(by.backend).toMatchObject({ status: 'ok', detail: 'claude 2.1.299, signed in' });
    expect(by.sandbox.status).toBe('ok');
    expect(by.telegram.status).toBe('ok');
    expect(by.daemon).toMatchObject({ status: 'warn', detail: 'stopped' });
    expect(by.service.status).toBe('warn');
    expect(by.port).toBeUndefined();
    expect(await runDoctor([], { ...base(installed), write: () => {} })).toBe(0);
  });

  it('fails on an old or signed-out backend, a gone Node, or one that cannot load SQLite', async () => {
    let by = byName(
      await runDiagnostics({ ...base(install()), run: host({ version: '2.1.200' }) })
    );
    // The detail carries versions a backend self-update changes; the code does not.
    expect(by.backend).toMatchObject({
      status: 'fail',
      detail: 'claude 2.1.200 is older than 2.1.299',
      code: 'backend.too_old',
    });
    by = byName(await runDiagnostics({ ...base(install()), run: host({ loggedIn: false }) }));
    expect(by.backend).toMatchObject({
      status: 'fail',
      fix: 'claude auth login',
      code: 'backend.signed_out',
    });
    by = byName(await runDiagnostics(base(install({ gone: true }))));
    expect(by.node).toMatchObject({ status: 'fail', detail: 'the Node start.sh runs is gone' });
    by = byName(await runDiagnostics({ ...base(install()), run: host({ sqlite: false }) }));
    expect(by.node.status).toBe('fail');
    by = byName(
      await runDiagnostics(base(install({ node: '.nvm/versions/node/v22.13.0/bin/node' })))
    );
    expect(by.node.status).toBe('warn');
  });

  it('checks that the bot is in the common group and can read it', async () => {
    const installed = install();
    const telegram = async (call: ReturnType<typeof getMe>) =>
      byName(await runDiagnostics({ ...base(installed), telegramCall: call })).telegram;
    expect(await telegram(getMe({}, 'member'))).toMatchObject({ status: 'ok' });
    expect(await telegram(getMe({}, 'left'))).toMatchObject({ status: 'fail' });
    expect(await telegram(getMe({}, null))).toMatchObject({ status: 'fail' });
    const limited = vi.fn(async (_token: string, method: string) =>
      method === 'getMe'
        ? { ok: true, result: { id: 7, can_read_all_group_messages: true } }
        : { ok: false, error_code: 429 }
    );
    expect(await telegram(limited)).toMatchObject({ status: 'warn' });
    expect(await telegram(getMe({ can_read_all_group_messages: false }, 'member'))).toMatchObject({
      status: 'warn',
    });
    expect(
      await telegram(getMe({ can_read_all_group_messages: false }, 'administrator'))
    ).toMatchObject({ status: 'ok' });
    expect(await telegram(vi.fn(async () => ({ ok: false })))).toMatchObject({
      status: 'fail',
      detail: 'Telegram refused the bot token',
    });
    // --offline makes no network call; the token's presence is still checked.
    const offline = getMe();
    await runDoctor(['--offline'], { ...base(installed), telegramCall: offline, write: () => {} });
    expect(offline).not.toHaveBeenCalled();
  });

  it('fails on secrets an enabled messenger or source needs, as boot would', async () => {
    const installed = install({
      config: {
        slack: {
          enabled: true,
          owner_channel_id: 'C1',
          allowed_channels: ['C1'],
          owner_user_ids: ['U1'],
        },
      },
      auth: { MAMA_SLACK_TOKEN: 'x' },
      connectors: {
        chatwork: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
        },
        ical: {
          enabled: true,
          pollIntervalMinutes: 30,
          channels: { family: { role: 'hub', feedName: 'fixture-feed-label' } },
          auth: { type: 'none' },
        },
      },
    });
    const by = byName(await runDiagnostics(base(installed)));
    expect(by.slack).toMatchObject({
      status: 'fail',
      detail: 'MAMA_SLACK_APP_TOKEN not set; boot stops at the messengers stage',
    });
    expect(by['source chatwork']).toMatchObject({
      status: 'fail',
      context: 'MAMA_CHATWORK_TOKEN',
      fix: 'mama secret set MAMA_CHATWORK_TOKEN',
    });
    expect(by['source ical']).toMatchObject({
      status: 'fail',
      detail: '1 secret(s) it needs are not set',
      context: 'MAMA_ICAL_URL_FAMILY',
    });

    const broken = install({ connectors: '{ not json' });
    expect(byName(await runDiagnostics(base(broken))).sources.status).toBe('fail');
  });

  it('fails on an unsafe tools_root, which boot refuses', async () => {
    const installed = install();
    // Outside HOME, as config requires, but writable by everyone.
    const tools = mkdtempSync(join(tmpdir(), 'mama-doctor-tools-'));
    roots.push(tools);
    chmodSync(tools, 0o777);
    writeFileSync(
      installed.configPath,
      JSON.stringify({
        version: 1,
        member_root: join(tmpdir(), 'mama-doctor-members-outside'),
        tools_root: tools,
        agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
        database: { path: join(installed.root, 'memory.db') },
        logging: { level: 'info', file: join(installed.root, 'logs', 'daemon.log') },
        telegram: { enabled: true, owner_chat_id: CHAT, allowed_chats: [CHAT], polling: false },
      })
    );
    expect(byName(await runDiagnostics(base(installed))).toolkit.status).toBe('fail');
  });

  it('reports a daemon that does not answer, one stuck in boot, and each source it polls', async () => {
    const installed = install();
    let by = byName(
      await runDiagnostics({
        ...base(installed),
        askStatus: async () => {
          throw new Error('control socket timed out');
        },
      })
    );
    expect(by.daemon).toMatchObject({ status: 'fail', context: 'control socket timed out' });
    by = byName(
      await runDiagnostics({
        ...base(installed),
        askStatus: async () => ({
          state: 'running',
          reply: { ok: true, status: { stage: 'owner_runtime', startedAt: Date.now() - 600_000 } },
        }),
      })
    );
    expect(by.daemon).toMatchObject({
      status: 'warn',
      detail: 'at boot stage owner_runtime for 10 min',
    });
    const checks = await runDiagnostics({
      ...base(installed),
      askStatus: async () => ({
        state: 'running',
        reply: {
          ok: true,
          status: {
            stage: 'running',
            startedAt: Date.now(),
            connectors: [
              { name: 'slack', healthy: true, lastPoll: '2026-10-16T01:00:00.000Z', error: null },
              { name: 'chatwork', healthy: false, lastPoll: null, error: 'Room 42: timeout' },
            ],
          },
        },
      }),
    });
    by = byName(checks);
    expect(by.daemon.status).toBe('ok');
    expect(by['source slack']).toMatchObject({ status: 'ok' });
    expect(by['source chatwork']).toMatchObject({
      status: 'warn',
      detail: 'unhealthy; last poll never',
      context: 'Room 42: timeout',
    });
  });

  it("checks the port start.sh gives the daemon, not this shell's", async () => {
    const used: number[] = [];
    const hosts: string[] = [];
    const installed = install({
      carried: ["export MAMA_API_PORT='4100'", "export MAMA_API_HOST='::1'"],
    });
    const by = byName(
      await runDiagnostics({
        ...base(installed),
        portInUse: async (port, host) => {
          used.push(port);
          hosts.push(host);
          return port === 4100;
        },
      })
    );
    expect(used).toEqual([4100]);
    expect(hosts).toEqual(['::1']);
    expect(by.port).toMatchObject({
      status: 'fail',
      detail: 'port 4100 is in use by another process',
    });
    const invalid = install({ carried: ["export MAMA_API_PORT='80'"] });
    expect(byName(await runDiagnostics(base(invalid))).port.status).toBe('fail');
  });

  it('reads systemd on Linux: the sandbox from the service PATH, a missing user manager as a warning', async () => {
    // The unit lives under the temp home, whatever XDG_CONFIG_HOME this machine sets.
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const installed = install();
    mkdirSync(dirname(systemdUnitPath(installed.home)), { recursive: true });
    writeFileSync(systemdUnitPath(installed.home), '');
    const service = async (stdout: string) =>
      byName(
        await runDiagnostics({
          ...base(installed),
          platform: 'linux',
          serviceRun: () => result(stdout === 'active' ? 0 : 3, stdout),
        })
      );
    let by = await service('active');
    expect(by.service).toMatchObject({ status: 'ok', detail: 'systemd (active)' });
    expect(by.sandbox.status).toBe('ok');
    expect((await service('failed')).service.status).toBe('fail');
    expect((await service('')).service.status).toBe('warn');
    by = byName(
      await runDiagnostics({
        ...base(installed),
        platform: 'linux',
        findIn: (name: string) => (name === 'socat' ? undefined : `/fixture/bin/${name}`),
        serviceRun: () => result(0, 'active'),
      })
    );
    expect(by.sandbox).toMatchObject({ status: 'fail', detail: "socat not on the service's PATH" });
  });

  it('starts each source in the service environment and asks whether its credentials work', async () => {
    const installed = install({
      auth: { MAMA_CHATWORK_TOKEN: 'from-auth-env' },
      connectors: {
        chatwork: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
        },
        kagemusha: { enabled: true, pollIntervalMinutes: 5, channels: {}, auth: { type: 'none' } },
      },
    });
    // Chatwork stays off the network: it reports the token it sees at start and is refused.
    const seen: (string | undefined)[] = [];
    const loadSource: typeof loadConnector = async (name, config, paths) =>
      name === 'chatwork'
        ? ({
            getAuthRequirements: () => [
              { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN', description: '' },
            ],
            init: async () => {
              seen.push(process.env.MAMA_CHATWORK_TOKEN);
            },
            authenticate: async () => false,
            dispose: async () => {},
          } as never)
        : loadConnector(name, config, paths);
    expect(process.env.MAMA_CHATWORK_TOKEN).toBeUndefined();
    let by = byName(await runDiagnostics({ ...base(installed), loadSource }));
    expect(seen).toEqual(['from-auth-env']);
    expect(process.env.MAMA_CHATWORK_TOKEN).toBeUndefined();
    expect(by['source chatwork']).toMatchObject({
      status: 'fail',
      detail: 'starts, but its credentials or sign-in are refused, so its polls fail',
      fix: 'mama secret set MAMA_CHATWORK_TOKEN',
    });
    expect(by['source kagemusha']).toMatchObject({
      status: 'fail',
      detail: 'does not start; boot stops at the connectors stage',
    });
    by = byName(await runDiagnostics({ ...base(installed), loadSource, offline: true }));
    expect(by['source kagemusha']).toBeUndefined();
    expect(by['source chatwork']).toBeUndefined();
  });

  it('fails a generated start.sh that no longer loads auth.env', async () => {
    const installed = install();
    const script = join(installed.root, 'start.sh');
    writeFileSync(
      script,
      readFileSync(script, 'utf8')
        .split('\n')
        .filter((line) => !line.endsWith("auth.env'"))
        .join('\n')
    );
    const by = byName(await runDiagnostics(base(installed)));
    expect(by['start.sh']).toMatchObject({ status: 'fail' });
    expect(by.telegram.status).toBe('fail');
  });

  it('reads auth.env as sh does: comments pass, broken quoting is a failure, not a crash', async () => {
    const installed = install();
    writeFileSync(
      join(installed.root, 'auth.env'),
      `export MAMA_TELEGRAM_TOKEN='${TOKEN}'  # the owner's bot\n`
    );
    expect(byName(await runDiagnostics(base(installed))).telegram.status).toBe('ok');
    writeFileSync(join(installed.root, 'auth.env'), `export MAMA_TELEGRAM_TOKEN='${TOKEN}\n`);
    const by = byName(await runDiagnostics(base(installed)));
    expect(by['auth.env']).toMatchObject({
      status: 'fail',
      context: 'line 1: unterminated single quote',
    });
    expect(by.telegram.status).toBe('fail');
    // Sourced under set -e, a line that is not an assignment runs as a command.
    writeFileSync(
      join(installed.root, 'auth.env'),
      `export MAMA_TELEGRAM_TOKEN='${TOKEN}'\nbroken command\n`
    );
    expect(byName(await runDiagnostics(base(installed)))['auth.env']).toMatchObject({
      status: 'fail',
      context: 'line 2 is not an assignment',
    });
  });

  it('reports a replay or backfill holding the install, not a stuck daemon', async () => {
    const installed = install();
    const by = byName(
      await runDiagnostics({
        ...base(installed),
        askStatus: async () => ({
          state: 'running',
          reply: {
            ok: true,
            status: { command: 'backfill', stage: 'replay', startedAt: Date.now() - 3_600_000 },
          },
        }),
      })
    );
    expect(by.daemon).toMatchObject({
      status: 'warn',
      detail: 'stopped; backfill holds the install (stage replay)',
    });
  });

  it('fails a start.sh the service cannot run, an address it cannot bind, a socat that does not run', async () => {
    const installed = install();
    chmodSync(join(installed.root, 'start.sh'), 0o600);
    let by = byName(await runDiagnostics(base(installed)));
    expect(by['start.sh']).toMatchObject({
      status: 'fail',
      detail: 'is not executable, so the service cannot run it',
    });
    by = byName(
      await runDiagnostics({
        ...base(installed),
        portInUse: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        },
      })
    );
    expect(by.port).toMatchObject({
      status: 'fail',
      detail: 'MAMA_API_HOST is not an address this machine can bind',
    });
    by = byName(
      await runDiagnostics({
        ...base(installed),
        platform: 'linux',
        run: host({ socat: false }),
        serviceRun: () => result(0, 'active'),
      })
    );
    expect(by.sandbox).toMatchObject({ status: 'fail', detail: 'socat does not run' });
  });

  it('gives up on a source that does not answer', async () => {
    const installed = install({
      auth: { MAMA_CHATWORK_TOKEN: 'x' },
      connectors: {
        chatwork: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'MAMA_CHATWORK_TOKEN' },
        },
      },
    });
    const stalled = (async () =>
      ({
        getAuthRequirements: () => [],
        init: async () => {},
        authenticate: () => new Promise<boolean>(() => {}),
        dispose: async () => {},
      }) as never) as unknown as typeof loadConnector;
    const by = byName(
      await runDiagnostics({ ...base(installed), loadSource: stalled, sourceTimeoutMs: 50 })
    );
    expect(by['source chatwork']).toMatchObject({
      status: 'fail',
      detail: 'could not be asked whether its credentials work',
      context: 'no answer within 0.05 s',
    });
  });

  it("holds the database's schema to what this version knows", async () => {
    const installed = install();
    let by = byName(await runDiagnostics(base(installed)));
    expect(by.schema).toMatchObject({
      status: 'ok',
      detail: 'no database yet; the first start creates it',
    });
    const highest = highestMigrationVersion(MIGRATIONS_DIR);
    const db = new Database(join(installed.root, 'memory.db'));
    db.exec('CREATE TABLE schema_version (source TEXT, version INTEGER)');
    db.prepare("INSERT INTO schema_version VALUES ('core', ?)").run(highest - 1);
    db.close();
    by = byName(await runDiagnostics(base(installed)));
    expect(by.schema.status).toBe('ok');
    expect(by.schema.detail).toContain(`core ${highest - 1} of ${highest}`);
    expect(by.schema.detail).toContain('the next start migrates it');
    const newer = new Database(join(installed.root, 'memory.db'));
    newer.prepare("INSERT INTO schema_version VALUES ('core', ?)").run(highest + 1);
    newer.close();
    by = byName(await runDiagnostics(base(installed)));
    expect(by.schema).toMatchObject({ status: 'fail', code: 'schema.newer' });
    expect(by.schema.detail).toContain(`core ${highest + 1} of ${highest}`);

    // A newer product schema counts the same as a newer core one.
    const product = new Database(join(installed.root, 'memory.db'));
    product.exec('DELETE FROM schema_version WHERE version > ' + String(highest - 1));
    product.prepare("INSERT INTO schema_version VALUES ('standalone', 99)").run();
    product.close();
    by = byName(await runDiagnostics(base(installed)));
    expect(by.schema).toMatchObject({ status: 'fail' });
    expect(by.schema.detail).toContain('standalone 99 of');

    // A source this version does not know is a later version's schema, as boot reads it.
    const later = new Database(join(installed.root, 'memory.db'));
    later.exec("DELETE FROM schema_version WHERE source = 'standalone'");
    later.prepare("INSERT INTO schema_version VALUES ('later', 2)").run();
    later.close();
    by = byName(await runDiagnostics(base(installed)));
    expect(by.schema).toMatchObject({ status: 'fail' });
    expect(by.schema.detail).toContain('later 2 of 0');
  });

  it('reports a database it cannot read, or one with no schema table yet, instead of failing', async () => {
    const installed = install();
    writeFileSync(
      join(installed.root, 'memory.db'),
      'not a database, only bytes that look like one'
    );
    let by = byName(await runDiagnostics(base(installed)));
    expect(by.schema).toMatchObject({ status: 'fail', detail: 'the database cannot be read' });
    expect(by.daemon).toBeDefined();
    rmSync(join(installed.root, 'memory.db'));
    const empty = new Database(join(installed.root, 'memory.db'));
    empty.exec('CREATE TABLE x (y TEXT)');
    empty.close();
    by = byName(await runDiagnostics(base(installed)));
    expect(by.schema.status).toBe('ok');
    expect(by.schema.detail).toContain('core 0 of');

    // A path the service cannot reach is not a fresh install.
    rmSync(join(installed.root, 'memory.db'));
    const locked = join(installed.root, 'locked');
    mkdirSync(locked);
    symlinkSync(join(locked, 'memory.db'), join(installed.root, 'memory.db'));
    chmodSync(locked, 0o000);
    try {
      by = byName(await runDiagnostics(base(installed)));
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(by.schema).toMatchObject({ status: 'fail', detail: 'the database cannot be read' });
  });

  it('warns about a log past its own cap', async () => {
    const installed = install();
    writeFileSync(join(installed.root, 'logs', 'daemon.log'), '');
    truncateSync(join(installed.root, 'logs', 'daemon.log'), 11 * 1024 * 1024);
    writeFileSync(join(installed.root, 'logs', 'crash.log'), 'x'.repeat(1024 * 1024 + 1));
    const checks = await runDiagnostics(base(installed));
    const logs = checks.filter((check) => check.name === 'logs');
    expect(logs).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: 'daemon.log is 11.0 MB, past its 10 MB cap',
      }),
      expect.objectContaining({ status: 'warn', detail: 'crash.log is 1.0 MB, past its 1 MB cap' }),
    ]);
    expect(logs[1]!.fix).toMatch(/start\.sh empties it at the next start/);
  });

  it('survives a daemon.log it cannot read', async () => {
    const installed = install();
    const log = join(installed.root, 'logs', 'daemon.log');
    writeFileSync(log, 'boot stage=config\n');
    chmodSync(log, 0o000);
    const lines: string[] = [];
    await runDoctor(['--report'], { ...base(installed), write: (line) => lines.push(line) });
    chmodSync(log, 0o600);
    expect(lines.join('\n')).toContain('recent errors: (daemon.log cannot be read)');
    expect(lines.join('\n')).toContain('warn logs: daemon.log cannot be read');
  });

  it('writes a report from names and codes only, whatever the log and the install hold', async () => {
    const installed = install({
      config: { fixture_unknown_setting: true },
      connectors: {
        ical: {
          enabled: true,
          pollIntervalMinutes: 30,
          channels: { family: { role: 'hub', feedName: 'fixture-feed-label' } },
          auth: { type: 'none' },
        },
      },
    });
    const secrets = [
      TOKEN,
      '9876543210',
      'fixture-cell-text',
      'fixture-feed-label',
      'MAMA_ICAL_URL_FAMILY',
      'fixture-file-ref',
      'fixture-room-ref',
      '/Volumes/fixture-volume',
      'user:pass',
      'principal_5b55fixture',
      'fixture_unknown_setting',
      'Urgent',
      'client_name',
      'ERR_FIXTURE_NAME',
      'members-outside',
      installed.home,
    ];
    writeFileSync(
      join(installed.root, 'logs', 'daemon.log'),
      [
        'boot stage=config',
        'boot stage=isolation',
        'boot stage=connectors failed error=Error: iCal feed fixture-feed-label has no secret',
        'turn failed error=Error: boot stage=client_name failed earlier',
        '[PollingScheduler] poll failed for connector sheets Error: duplicate row identity fixture-cell-text',
        'iCal feed fixture-feed-label has no MAMA_ICAL_URL_FAMILY secret',
        'Slack file fixture-file-ref does not belong to observation room fixture-room-ref',
        'turn failed reason=Claude CLI exited 1: /Volumes/fixture-volume/plan.pdf ENOENT',
        `[Telegram] send failed to ${CHAT} with token ${TOKEN} via https://user:pass@api.example.test/x status 502`,
        'principal_5b55fixture claimed input failed',
        '[Urgent] continued message line that failed',
        'reply failed: ERR_FIXTURE_NAME ECONNRESET',
      ].join('\n')
    );
    // A config that does not load is in the crash log, before the daemon writes its own.
    writeFileSync(
      join(installed.root, 'logs', 'crash.log'),
      "Error: EACCES: permission denied, open '/Volumes/fixture-volume/config.yaml'\n"
    );
    const lines: string[] = [];
    const code = await runDoctor(['--report'], {
      ...base(installed),
      run: host({ version: '2.1.200' }),
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const report = lines.join('\n');
    expect(report).toContain('config keys: version, member_root, agent, database, logging');
    expect(report).toContain('and 1 other top-level key(s) it ignores');
    expect(report).toContain('enabled sources: ical');
    expect(report).toContain('boot stage=connectors failed');
    expect(report).toContain('connector sheets');
    expect(report).toContain('ENOENT');
    expect(report).toContain('ECONNRESET');
    expect(report).toContain('HTTP 502');
    expect(report).toContain('EACCES');
    expect(report).toContain('fail source ical: 1 secret(s) it needs are not set');
    for (const secret of secrets) expect(report).not.toContain(secret);
  });
});

describe('doctor release check', () => {
  const at = '2026-10-30T01:00:00.000Z';
  const local = new Date(at).toLocaleString('sv-SE');
  const writeCheck = (root: string, state: Record<string, unknown>) =>
    writeFileSync(join(root, 'runtime', 'release-check.json'), JSON.stringify(state), {
      mode: 0o600,
    });

  it("reads only the daemon's file, with a network that throws", async () => {
    const installed = install();
    mkdirSync(join(installed.root, 'runtime'), { recursive: true });
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetch);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    try {
      let by = byName(await runDiagnostics({ ...base(installed), telegramCall: offline }));
      expect(by.release).toEqual({
        name: 'release',
        status: 'ok',
        detail: 'not checked yet; the running daemon checks once a day',
      });

      // This fixture's start.sh runs this checkout, so the update path is the git steps.
      writeCheck(installed.root, {
        checkedAt: at,
        current: '0.78.0',
        latest: '0.79.0',
        error: null,
      });
      by = byName(await runDiagnostics({ ...base(installed), telegramCall: offline }));
      expect(by.release).toMatchObject({
        status: 'warn',
        detail: `newer release 0.79.0 (checked ${local}); the daemon runs 0.78.0`,
      });
      expect(by.release.fix).toContain('git pull --ff-only');
      expect(by.release.fix).toContain(`'${CLI}' service install`);

      // The shareable report carries the detail, never the steps' paths.
      const lines: string[] = [];
      await runDoctor(['--report'], {
        ...base(installed),
        telegramCall: offline,
        write: (line) => lines.push(line),
      });
      expect(lines.join('\n')).toContain(`warn release: newer release 0.79.0 (checked ${local})`);
      expect(lines.join('\n')).not.toContain(CLI);

      writeCheck(installed.root, {
        checkedAt: at,
        current: '0.78.0',
        latest: null,
        error: 'ENOTFOUND',
      });
      by = byName(await runDiagnostics({ ...base(installed), telegramCall: offline }));
      expect(by.release).toMatchObject({
        status: 'warn',
        detail: `last check failed at ${local}: ENOTFOUND`,
      });

      writeCheck(installed.root, {
        checkedAt: at,
        current: '0.79.0',
        latest: '0.79.0',
        error: null,
      });
      by = byName(await runDiagnostics({ ...base(installed), telegramCall: offline }));
      expect(by.release).toMatchObject({
        status: 'ok',
        detail: `0.79.0 is current (checked ${local})`,
      });

      writeFileSync(join(installed.root, 'runtime', 'release-check.json'), '{"checkedAt":');
      by = byName(await runDiagnostics({ ...base(installed), telegramCall: offline }));
      expect(by.release).toMatchObject({
        status: 'warn',
        detail: 'the last release check cannot be read',
        fix: 'remove runtime/release-check.json; the daemon checks again within the hour',
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
