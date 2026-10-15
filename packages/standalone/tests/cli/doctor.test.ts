import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { compareVersions, probeBackend } from '../../src/cli/runtime/backend-probe.js';
import { runDiagnostics, type Check } from '../../src/cli/runtime/diagnostics.js';
import { systemdUnitPath } from '../../src/cli/runtime/systemd-service.js';
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
    })
  );
  return { home, root, node, configPath: join(root, 'config.yaml') };
}

/** The commands doctor runs, answering as given; anything else is not found. */
function host(
  options: { version?: string; loggedIn?: boolean; sqlite?: boolean; sandbox?: boolean } = {}
) {
  return vi.fn((command: string, args: string[], _env?: NodeJS.ProcessEnv) => {
    if (args[0] === '--version')
      return result(0, `${options.version ?? '2.1.299'} (Claude Code)\n`);
    if (args[0] === 'auth') {
      return result(0, JSON.stringify({ loggedIn: options.loggedIn ?? true, email: 'a@b.test' }));
    }
    if (args[0] === '-e') return options.sqlite === false ? result(1) : result(0, 'v22.13.0');
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
    expect(by.backend).toMatchObject({
      status: 'fail',
      detail: 'claude 2.1.200 is older than 2.1.299',
    });
    by = byName(await runDiagnostics({ ...base(install()), run: host({ loggedIn: false }) }));
    expect(by.backend).toMatchObject({ status: 'fail', fix: 'claude auth login' });
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
          channels: { family: { role: 'hub', feedName: 'Family Calendar' } },
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
      status: 'fail',
      detail: 'stuck at boot stage owner_runtime',
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

  it('starts each source in the service environment, as boot does, unless offline', async () => {
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
    expect(process.env.MAMA_CHATWORK_TOKEN).toBeUndefined();
    let by = byName(await runDiagnostics(base(installed)));
    // Chatwork reads its token from the daemon's environment, which auth.env provides.
    expect(by['source chatwork']).toBeUndefined();
    expect(by['source kagemusha']).toMatchObject({
      status: 'fail',
      detail: 'does not start; boot stops at the connectors stage',
    });
    expect(process.env.MAMA_CHATWORK_TOKEN).toBeUndefined();
    by = byName(await runDiagnostics({ ...base(installed), offline: true }));
    expect(by['source kagemusha']).toBeUndefined();
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

  it('warns about a log past 50 MB', async () => {
    const installed = install();
    writeFileSync(join(installed.root, 'logs', 'daemon.log'), '');
    truncateSync(join(installed.root, 'logs', 'daemon.log'), 51 * 1024 * 1024);
    const checks = await runDiagnostics(base(installed));
    expect(checks.find((check) => check.name === 'logs')).toMatchObject({
      status: 'warn',
      detail: 'daemon.log is 51 MB',
    });
  });

  it('writes a report from names and codes only, whatever the log and the install hold', async () => {
    const installed = install({
      config: { 'Client Project Alpha': true },
      connectors: {
        ical: {
          enabled: true,
          pollIntervalMinutes: 30,
          channels: { family: { role: 'hub', feedName: 'Family Calendar' } },
          auth: { type: 'none' },
        },
      },
    });
    const secrets = [
      TOKEN,
      '9876543210',
      'Confidential Client Name',
      'Family Calendar',
      'MAMA_ICAL_URL_FAMILY',
      'F07ABCDEF',
      'C05XYZ',
      '/Volumes/ClientDrive',
      'user:pass',
      'principal_5b55fixture',
      'Client Project Alpha',
      'Urgent',
      'client_name',
      'members-outside',
      installed.home,
    ];
    writeFileSync(
      join(installed.root, 'logs', 'daemon.log'),
      [
        'boot stage=config',
        'boot stage=isolation',
        'boot stage=connectors failed error=Error: iCal feed Family Calendar has no secret',
        'turn failed error=Error: boot stage=client_name failed earlier',
        '[PollingScheduler] poll failed for connector sheets Error: duplicate row identity Confidential Client Name',
        'iCal feed Family Calendar has no MAMA_ICAL_URL_FAMILY secret',
        'Slack file F07ABCDEF does not belong to observation room C05XYZ',
        'turn failed reason=Claude CLI exited 1: /Volumes/ClientDrive/plan.pdf ENOENT',
        `[Telegram] send failed to ${CHAT} with token ${TOKEN} via https://user:pass@api.example.test/x status 502`,
        'principal_5b55fixture claimed input failed',
        '[Urgent] continued message line that failed',
      ].join('\n')
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
    expect(report).toContain('and 1 it ignores');
    expect(report).toContain('enabled sources: ical');
    expect(report).toContain('boot stage=connectors failed');
    expect(report).toContain('connector sheets');
    expect(report).toContain('ENOENT');
    expect(report).toContain('HTTP 502');
    expect(report).toContain('fail source ical: 1 secret(s) it needs are not set');
    for (const secret of secrets) expect(report).not.toContain(secret);
  });
});
