import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { compareVersions, probeBackend } from '../../src/cli/runtime/backend-probe.js';
import { redact, runDiagnostics } from '../../src/cli/runtime/diagnostics.js';
import {
  stableNodePath,
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
  vi.mocked(spawnSync).mockReturnValue({
    status: 113,
    stdout: '',
    stderr: '',
    signal: null,
    pid: 1,
    output: [],
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function result(status: number, stdout = ''): SpawnSyncReturns<string> {
  return { status, stdout, stderr: '', signal: null, pid: 1, output: [] } as never;
}

const TOKEN = '123456789:AAFixtureSecretTokenValueThatMustNotLeak';
const CHAT = '-1009876543210';
const MESSAGE = 'please send the confidential estimate';

/** An install whose start.sh runs `node` (relative to the temp home, created unless `gone`). */
function install(options: { node?: string; gone?: boolean; telegram?: boolean } = {}) {
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
      member_root: join(tmpdir(), 'mama-doctor-members'),
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram:
        options.telegram === false
          ? { enabled: false }
          : { enabled: true, owner_chat_id: CHAT, allowed_chats: [CHAT], polling: false },
    })
  );
  writeFileSync(join(root, 'auth.env'), `export MAMA_TELEGRAM_TOKEN='${TOKEN}'\n`, { mode: 0o600 });
  writeFileSync(
    join(root, 'start.sh'),
    startScript({
      home,
      nodePath: node,
      cliPath: '/fixture/cli.js',
      executablePaths: ['/fixture/bin/claude'],
      viewer: {},
      logLevel: 'info',
    })
  );
  writeFileSync(
    join(root, 'logs', 'daemon.log'),
    [
      'boot stage=config',
      'boot stage=isolation',
      `[Telegram] send failed Error: "${MESSAGE}" to chat ${CHAT}`,
      `poll failed Error: token ${TOKEN} rejected for owner@example.test at https://api.example.test/v1/rooms/42?key=abc`,
      `principal_5b55fixture claimed input`,
    ].join('\n')
  );
  return { home, root, node, configPath: join(root, 'config.yaml') };
}

/** A backend that answers --version and its login status as given. */
function backend(version: string, loggedIn: boolean) {
  return vi.fn((_command: string, args: string[]) => {
    if (args[0] === '--version') return result(0, `${version} (Claude Code)\n`);
    if (args[0] === 'auth')
      return result(0, JSON.stringify({ loggedIn, email: 'owner@example.test' }));
    return result(0);
  });
}

const getMe = (overrides: Record<string, unknown> = {}, admin = false) =>
  vi.fn(async (_token: string, method: string) =>
    method === 'getMe'
      ? { ok: true, result: { id: 7, can_read_all_group_messages: false, ...overrides } }
      : { ok: true, result: { status: admin ? 'administrator' : 'member' } }
  );

describe('backend probe', () => {
  it('compares versions and reads the login without the account details', () => {
    expect(compareVersions('2.1.299', '2.1.299')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.299')).toBeGreaterThan(0);
    expect(compareVersions('2.0.9', '2.1.0')).toBeLessThan(0);
    expect(probeBackend('claude', '/x/claude', { run: backend('2.1.299', true) })).toEqual({
      version: '2.1.299',
      minimum: '2.1.299',
      versionOk: true,
      loggedIn: true,
      problem: null,
    });
    expect(probeBackend('claude', '/x/claude', { run: backend('2.1.200', false) })).toMatchObject({
      versionOk: false,
      loggedIn: false,
    });
    const codex = vi.fn((_c: string, args: string[], env?: NodeJS.ProcessEnv) =>
      args[0] === '--version'
        ? result(0, 'codex-cli 0.160.1\n')
        : result(env?.CODEX_HOME === '/managed/.codex' ? 0 : 1)
    );
    expect(
      probeBackend('codex', '/x/codex', { run: codex, codexHome: '/managed/.codex' }).loggedIn
    ).toBe(true);
  });
});

describe('stable Node path', () => {
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
});

describe('start.sh PATH', () => {
  it('reads $HOME, ${HOME} and ~ as the home folder and drops $PATH', () => {
    expect(
      startPathValue("'$HOME/.local/bin:${HOME}/bin:~/x:/usr/bin:$PATH:$HOMEX/y'", '/h')
    ).toEqual(['/h/.local/bin', '/h/bin', '/h/x', '/usr/bin', '$HOMEX/y']);
  });
});

describe('mama doctor', () => {
  const findIn = (name: string) => `/fixture/bin/${name}`;

  it('passes a healthy install and names each check', async () => {
    const { home, configPath } = install();
    const checks = await runDiagnostics({
      home,
      configPath,
      platform: 'darwin',
      run: backend('2.1.299', true),
      findIn,
      telegramCall: getMe({ can_read_all_group_messages: true }),
    });
    const by = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(by.config.status).toBe('ok');
    expect(by.member_root.status).toBe('ok');
    expect(by.node.status).toBe('ok');
    expect(by.backend).toMatchObject({ status: 'ok', detail: 'claude 2.1.299, signed in' });
    expect(by.sandbox.status).toBe('ok');
    expect(by.telegram.status).toBe('ok');
    expect(by.daemon).toMatchObject({ status: 'warn', detail: 'stopped' });
    expect(by.service.status).toBe('warn');
  });

  it('fails on an old or signed-out backend, a gone Node, and a refused token; warns on a versioned Node', async () => {
    const versioned = install({ node: '.nvm/versions/node/v22.13.0/bin/node' });
    let checks = await runDiagnostics({
      home: versioned.home,
      configPath: versioned.configPath,
      platform: 'darwin',
      run: backend('2.1.200', true),
      findIn,
      telegramCall: vi.fn(async () => ({ ok: false })),
    });
    let by = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(by.node.status).toBe('warn');
    expect(by.backend).toMatchObject({
      status: 'fail',
      detail: 'claude 2.1.200 is older than 2.1.299',
    });
    expect(by.telegram).toMatchObject({ status: 'fail', detail: 'Telegram refused the bot token' });

    const gone = install({ gone: true });
    checks = await runDiagnostics({
      home: gone.home,
      configPath: gone.configPath,
      platform: 'darwin',
      run: backend('2.1.299', false),
      findIn,
      telegramCall: null,
    });
    by = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(by.node).toMatchObject({ status: 'fail', detail: `${gone.node} is gone` });
    expect(by.backend).toMatchObject({ status: 'fail', fix: 'claude auth login' });
    expect(by.telegram).toBeUndefined();
  });

  it('accepts privacy mode when the bot administers the common group, and warns otherwise', async () => {
    const { home, configPath } = install();
    const base = {
      home,
      configPath,
      platform: 'darwin' as const,
      run: backend('2.1.299', true),
      findIn,
    };
    let by = Object.fromEntries(
      (await runDiagnostics({ ...base, telegramCall: getMe({}, true) })).map((check) => [
        check.name,
        check,
      ])
    );
    expect(by.telegram.status).toBe('ok');
    by = Object.fromEntries(
      (await runDiagnostics({ ...base, telegramCall: getMe({}, false) })).map((check) => [
        check.name,
        check,
      ])
    );
    expect(by.telegram.status).toBe('warn');
  });

  it('warns about a log past 50 MB', async () => {
    const { home, root, configPath } = install({ telegram: false });
    truncateSync(join(root, 'logs', 'daemon.log'), 51 * 1024 * 1024);
    const checks = await runDiagnostics({
      home,
      configPath,
      platform: 'darwin',
      run: backend('2.1.299', true),
      findIn,
    });
    expect(checks.find((check) => check.name === 'logs')).toMatchObject({
      status: 'warn',
      detail: 'daemon.log is 51 MB',
    });
  });

  it('writes a report without tokens, chat ids, emails, paths, principals or message text, and exits 1 on a failure', async () => {
    const { home, configPath } = install();
    const lines: string[] = [];
    const code = await runDoctor(['--report'], {
      home,
      configPath,
      platform: 'darwin',
      run: backend('2.1.200', true),
      findIn,
      telegramCall: getMe({ can_read_all_group_messages: true }),
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const report = lines.join('\n');
    expect(report).toContain(
      'config keys: version, member_root, agent, database, logging, telegram'
    );
    expect(report).toContain('boot stage=isolation');
    for (const secret of [
      TOKEN,
      'AAFixtureSecretTokenValueThatMustNotLeak',
      '9876543210',
      MESSAGE,
      'owner@example.test',
      'principal_5b55fixture',
      '?key=abc',
      home,
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  it('reports each source as the running daemon last polled it, masked in the report', async () => {
    const { home, configPath } = install();
    const lines: string[] = [];
    const code = await runDoctor(['--report', '--offline'], {
      home,
      configPath,
      platform: 'darwin',
      run: backend('2.1.299', true),
      findIn,
      askStatus: async () => ({
        state: 'running',
        reply: {
          ok: true,
          status: {
            connectors: [
              { name: 'slack', healthy: true, lastPoll: '2026-10-16T01:00:00.000Z', error: null },
              {
                name: 'chatwork',
                healthy: false,
                lastPoll: null,
                error: `Room ${CHAT.slice(1)}: "${MESSAGE}"`,
              },
            ],
          },
        },
      }),
      write: (line) => lines.push(line),
    });
    const report = lines.join('\n');
    expect(code).toBe(0);
    expect(report).toContain('ok source slack: last poll 2026-10-16T01:00:00.000Z');
    expect(report).toContain('warn source chatwork: last poll never; Room <n>: "<text>"');
    expect(report).not.toContain(MESSAGE);
  });

  it('masks what a report line may carry', () => {
    expect(
      redact(`at ${'/home/u'}/x "secret words" 1234567 user@x.io principal_abc`, '/home/u')
    ).toBe('at ~/x "<text>" <n> <email> principal_<id>');
    // Stage names and error codes survive; the apostrophe in a word does not open a quote.
    expect(redact('boot stage=report_scheduler:route_unavailable', '/h')).toBe(
      'boot stage=report_scheduler:route_unavailable'
    );
    expect(redact("couldn't reach ERR_SOCKET_CONNECTION_TIMEOUT for the owner's room", '/h')).toBe(
      "couldn't reach ERR_SOCKET_CONNECTION_TIMEOUT for the owner's room"
    );
    expect(redact("said 'abc' then a1b2c3d4e5f6a7b8c9d0e1f2a3b4", '/h')).toBe(
      "said '<text>' then <token>"
    );
  });
});
