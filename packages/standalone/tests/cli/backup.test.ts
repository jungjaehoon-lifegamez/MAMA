import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import { runBackup } from '../../src/cli/commands/backup.js';
import { serviceFile } from '../../src/cli/commands/service.js';
import { verifyArchive, type BackupManifest } from '../../src/cli/runtime/backup.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  InstallBusyError,
} from '../../src/cli/runtime/daemon-control.js';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) {
    // Sealed skill folders are read-only; open them again so the temp tree can go.
    for (const sealed of [join(path, 'skills', '.versions', 'demo-1')]) {
      if (existsSync(sealed)) chmodSync(sealed, 0o755);
    }
    rmSync(path, { recursive: true, force: true });
  }
});

function file(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

/** A stopped install with one of everything a backup keeps, skips or keeps only on request. */
function install(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mama-backup-'));
  const members = mkdtempSync(join(tmpdir(), 'mama-backup-members-'));
  const tools = mkdtempSync(join(tmpdir(), 'mama-backup-tools-'));
  roots.push(home, members, tools);
  const root = join(home, '.mama');
  mkdirSync(root, { recursive: true });
  file(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      member_root: members,
      tools_root: tools,
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: { enabled: false },
      ...config,
    })
  );
  const db = new Database(join(root, 'memory.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (72);');
  db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('kept');");
  db.close();
  chmodSync(join(root, 'memory.db'), 0o600);
  mkdirSync(join(root, 'connectors', 'chat'), { recursive: true });
  const raw = new Database(join(root, 'connectors', 'chat', 'raw.db'));
  raw.exec("CREATE TABLE raw_items (id TEXT); INSERT INTO raw_items VALUES ('fixture-item');");
  raw.close();
  file(join(root, 'connectors', 'poll-state.json'), '{}');
  file(join(root, 'downloads', 'telegram', '1_attachment.txt'), 'attachment');
  file(join(root, 'workspace', 'files', 'report.md'), 'report');
  file(join(root, 'workspace', '.tmp', 'scratch'), 'scratch');
  file(join(root, 'runtime', 'owner-message-ledger.json'), '{}');
  file(join(root, 'runtime', 'session-credential'), 'per-boot', 0o600);
  file(join(root, 'runtime', 'measurements', 'run.json'), '{}');
  file(join(root, 'owner-policy.md'), 'policy');
  file(join(root, 'start.sh'), '#!/bin/sh\n', 0o700);
  file(join(root, 'auth.env'), "export MAMA_TELEGRAM_TOKEN='fixture'\n", 0o600);
  file(join(root, 'jev-key'), 'fixture-key', 0o600);
  file(join(root, '.codex', 'auth.json'), '{}', 0o600);
  file(join(root, '.codex', 'sessions', 'thread.jsonl'), '{}');
  file(join(root, 'logs', 'daemon.log'), 'boot stage=config\n');
  file(join(root, 'legacy-notes', 'old.md'), 'old');
  file(join(members, 'person-a', 'workspace', 'notes.md'), 'notes');
  file(join(members, 'person-a', '.codex', 'auth.json'), '{}', 0o600);
  file(join(members, 'person-a', 'runtime', 'session-credential'), 'per-boot', 0o600);
  const sealed = join(tools, 'skills', '.versions', 'demo-1');
  file(join(sealed, 'SKILL.md'), 'skill', 0o444);
  chmodSync(sealed, 0o555);
  symlinkSync(join('.versions', 'demo-1'), join(tools, 'skills', 'demo'));
  return { home, root, members, tools, configPath: join(root, 'config.yaml') };
}

async function entries(archive: string): Promise<string[]> {
  const names: string[] = [];
  await tar.t({ file: archive, onReadEntry: (entry) => names.push(entry.path.replace(/\/$/, '')) });
  return names;
}

async function manifestOf(archive: string): Promise<BackupManifest> {
  let text = '';
  await tar.t({
    file: archive,
    onReadEntry: (entry) => {
      if (entry.path === 'manifest.json') entry.on('data', (chunk: Buffer) => (text += chunk));
      else entry.resume();
    },
  });
  return JSON.parse(text) as BackupManifest;
}

describe('mama backup', () => {
  it('writes one verified archive of what the install reads, 0600 under backups/', async () => {
    const installed = install();
    const lines: string[] = [];
    const archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: (line) => lines.push(line),
      now: () => new Date('2026-10-16T05:00:00Z'),
    });
    // Archived paths are physical (macOS keeps temp folders behind /private).
    const root = realpathSync(installed.root);
    expect(archive).toBe(join(root, 'backups', 'mama-backup-20261016-050000.tar.gz'));
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(archive)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(archive))).toEqual(['mama-backup-20261016-050000.tar.gz']);

    const names = await entries(archive);
    expect(names[0]).toBe('manifest.json');
    for (const kept of [
      'database',
      'root/config.yaml',
      'root/owner-policy.md',
      'root/start.sh',
      'root/connectors/chat/raw.db',
      'root/connectors/poll-state.json',
      'root/downloads/telegram/1_attachment.txt',
      'root/workspace/files/report.md',
      'root/runtime/owner-message-ledger.json',
      'members/person-a/workspace/notes.md',
      'skills/demo',
      'skills/.versions/demo-1/SKILL.md',
    ]) {
      expect(names).toContain(kept);
    }
    for (const left of [
      'root/memory.db',
      'root/memory.db-wal',
      'root/auth.env',
      'root/.codex/auth.json',
      'root/runtime/session-credential',
      'root/runtime/measurements/run.json',
      'root/workspace/.tmp/scratch',
      'root/logs/daemon.log',
      'root/legacy-notes/old.md',
      'members/person-a/.codex/auth.json',
      'members/person-a/runtime/session-credential',
      // Backend sessions are a cache, and their homes hold logins.
      'root/.codex/sessions/thread.jsonl',
      'root/.codex',
      'credentials/auth.env',
      'credentials/jev-key',
    ]) {
      expect(names).not.toContain(left);
    }

    const manifest = await manifestOf(archive);
    expect(manifest).toMatchObject({
      format: 'mama-backup',
      version: 1,
      schemaVersion: 72,
      includesSecrets: false,
      includesLogs: false,
      roots: {
        root,
        // Config reads member_root and tools_root as physical paths.
        members: realpathSync(installed.members),
        skills: join(realpathSync(installed.tools), 'skills'),
        database: join(installed.root, 'memory.db'),
      },
    });
    expect(manifest.databases).toEqual(['database', 'root/connectors/chat/raw.db']);
    // As written and as they really are: restore rewrites both.
    expect(manifest.configured).toMatchObject({
      root: { configured: installed.root, physical: root },
      member_root: { physical: realpathSync(installed.members) },
      tools_root: { physical: realpathSync(installed.tools) },
    });
    expect(lines.join('\n')).toContain('left out, not read by this version: legacy-notes');
    expect(lines.join('\n')).toContain('left out as credentials: auth.env');

    // Extracted, modes, symlinks and the database come back as they were.
    const out = mkdtempSync(join(tmpdir(), 'mama-backup-out-'));
    roots.push(out);
    await tar.x({ file: archive, cwd: out });
    expect(statSync(join(out, 'skills', '.versions', 'demo-1', 'SKILL.md')).mode & 0o777).toBe(
      0o444
    );
    expect(lstatSync(join(out, 'skills', 'demo')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, 'skills', 'demo'))).toBe(join('.versions', 'demo-1'));
    expect(statSync(join(out, 'root', 'start.sh')).mode & 0o777).toBe(0o700);
    chmodSync(join(out, 'skills', '.versions', 'demo-1'), 0o755);
    // The copy keeps the database's mode, not the umask SQLite created it under.
    expect(statSync(join(out, 'database')).mode & 0o777).toBe(0o600);
    const copy = new Database(join(out, 'database'), { readonly: true });
    expect(copy.prepare('SELECT body FROM notes').get()).toEqual({ body: 'kept' });
    copy.close();
  });

  it('carries credentials and logs only when asked', async () => {
    const installed = install();
    const archive = await runBackup(['--include-secrets', '--logs'], {
      home: installed.home,
      configPath: installed.configPath,
      write: () => {},
    });
    const names = await entries(archive);
    for (const kept of [
      'credentials/auth.env',
      'credentials/codex-auth.json',
      'credentials/jev-key',
      'log-file',
      'root/logs',
    ]) {
      expect(names).toContain(kept);
    }
    // A person's Codex login is a copy of the owner's that MAMA makes again.
    expect(names).not.toContain('members/person-a/.codex/auth.json');
    expect((await manifestOf(archive)).includesSecrets).toBe(true);
  });

  it('treats a config.yaml that holds a credential as one', async () => {
    const installed = install({
      slack: { enabled: false, bot_token: 'fixture-inline-value' },
    });
    const lines: string[] = [];
    let archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: (line) => lines.push(line),
      now: () => new Date('2026-10-16T05:00:00Z'),
    });
    expect(await entries(archive)).not.toContain('root/config.yaml');
    expect(lines.join('\n')).toContain('config.yaml (it holds a credential)');
    archive = await runBackup(['--include-secrets'], {
      home: installed.home,
      configPath: installed.configPath,
      write: () => {},
      now: () => new Date('2026-10-16T05:01:00Z'),
    });
    expect(await entries(archive)).toContain('root/config.yaml');
  });

  it('refuses while anything holds the install, and a folder the agents read', async () => {
    const installed = install();
    const options = { home: installed.home, configPath: installed.configPath, write: () => {} };
    const lock = acquireInstallLock(daemonControlPaths(installed.root), 'daemon');
    try {
      await expect(runBackup([], options)).rejects.toBeInstanceOf(InstallBusyError);
    } finally {
      lock.release();
    }
    // Only <root>/backups is denied to the agents: no other destination, not even through a link.
    await expect(runBackup(['--out', installed.home], options)).rejects.toThrow(/Usage/);
    const elsewhere = mkdtempSync(join(tmpdir(), 'mama-backup-elsewhere-'));
    roots.push(elsewhere);
    symlinkSync(elsewhere, join(installed.root, 'backups'));
    await expect(runBackup([], options)).rejects.toThrow(/is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('leaves nothing behind and releases the install when it fails', async () => {
    const installed = install();
    rmSync(join(installed.root, 'memory.db'));
    rmSync(join(installed.root, 'memory.db-wal'), { force: true });
    rmSync(join(installed.root, 'memory.db-shm'), { force: true });
    await expect(
      runBackup([], { home: installed.home, configPath: installed.configPath, write: () => {} })
    ).rejects.toThrow();
    expect(readdirSync(join(installed.root, 'backups'))).toEqual([]);
    acquireInstallLock(daemonControlPaths(installed.root), 'daemon').release();
  });

  it('passes twice over a WAL database a killed writer left, without its shared-memory file', async () => {
    const installed = install();
    // A writer killed mid-run leaves the database with its -wal and -shm beside it.
    const live = join(installed.root, 'workspace', 'agent.sqlite');
    const writer = new Database(live);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('in-wal');");
    const left = join(installed.root, 'workspace', 'left.sqlite');
    for (const end of ['', '-wal', '-shm']) copyFileSync(live + end, left + end);
    writer.close();
    const options = { home: installed.home, configPath: installed.configPath, write: () => {} };
    const first = await runBackup([], { ...options, now: () => new Date('2026-10-16T05:00:00Z') });
    await runBackup([], { ...options, now: () => new Date('2026-10-16T05:01:00Z') });
    const names = await entries(first);
    expect(names).toContain('root/workspace/left.sqlite-wal');
    expect(names).not.toContain('root/workspace/left.sqlite-shm');
  });

  it('stores hard links whole, a linked workspace where it is, and config paths where they are', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'mama-backup-ws-'));
    roots.push(elsewhere);
    const installed = install();
    const root = installed.root;
    file(
      join(root, 'mama-mcp-config.json'),
      JSON.stringify({ mcpServers: { mama: { env: { MAMA_SESSION_CREDENTIAL_PATH: '/x' } } } })
    );
    writeFileSync(
      installed.configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(installed.configPath, 'utf8')),
        agent: {
          backend: 'claude',
          model: 'fixture',
          max_turns: 10,
          timeout: 1000,
          tools: { mcp_config: join(root, 'mama-mcp-config.json') },
        },
        jev: {
          enabled: false,
          keyFile: join(root, 'connectors', 'jev-key'),
          vocabFile: join(root, 'vocab.json'),
        },
      })
    );
    file(join(root, 'connectors', 'jev-key'), 'fixture-key', 0o600);
    file(join(root, 'vocab.json'), '{}');
    file(join(elsewhere, 'files', 'moved.md'), 'moved');
    rmSync(join(root, 'workspace'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'workspace'));
    file(join(elsewhere, 'one.txt'), 'same');
    linkSync(join(elsewhere, 'one.txt'), join(elsewhere, 'two.txt'));
    const lines: string[] = [];
    // tar names a hard link by the first name it saw, relative to where it runs: run from above
    // the temp tree, where it would otherwise write a link entry.
    const cwd = process.cwd();
    process.chdir(realpathSync(tmpdir()));
    let archive: string;
    try {
      archive = await runBackup([], {
        home: installed.home,
        configPath: installed.configPath,
        write: (line) => lines.push(line),
      });
    } finally {
      process.chdir(cwd);
    }
    const types = new Map<string, string>();
    await tar.t({ file: archive, onReadEntry: (entry) => types.set(entry.path, entry.type) });
    expect(types.get('workspace/one.txt')).toBe('File');
    expect(types.get('workspace/two.txt')).toBe('File');
    const names = [...types.keys()].map((name) => name.replace(/\/$/, ''));
    for (const kept of ['workspace/files/moved.md', 'jev-vocab']) {
      expect(names).toContain(kept);
    }
    // MAMA's own MCP entry is written again at boot; the file goes only with credentials.
    expect(names).not.toContain('root/mama-mcp-config.json');
    expect(names).not.toContain('root/connectors/jev-key');
    expect(names).not.toContain('root/workspace');
    expect(lines.join('\n')).not.toMatch(/not read by this version: .*(workspace|mama-mcp-config)/);
  });

  it('withholds a file that carries a credential: an MCP env token, a start.sh export, a Claude login', async () => {
    const installed = install();
    file(
      join(installed.root, 'runtime', 'mama-mcp-config.json'),
      JSON.stringify({ mcpServers: { other: { env: { SERVICE_TOKEN: 'fixture-inline' } } } })
    );
    // Assigned under the script's set -a, without export, it still reaches the daemon.
    file(join(installed.root, 'start.sh'), "#!/bin/sh\nMAMA_TELEGRAM_TOKEN='fixture'\n", 0o700);
    file(join(installed.members, 'person-a', 'claude-config', '.credentials.json'), '{}', 0o600);
    const lines: string[] = [];
    const archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: (line) => lines.push(line),
    });
    const names = await entries(archive);
    expect(names).not.toContain('credentials/mcp-config.json');
    expect(names).not.toContain('root/start.sh');
    expect(lines.join('\n')).toMatch(/mama-mcp-config\.json \(servers besides MAMA's\)/);
    expect(names).not.toContain('members/person-a/claude-config/.credentials.json');
    expect(lines.join('\n')).toMatch(/start\.sh \(it holds a credential\)/);
  });

  it('refuses a kept file or source folder that is a link, and says why a config file is unreadable', async () => {
    const installed = install();
    const options = { home: installed.home, configPath: installed.configPath, write: () => {} };
    const elsewhere = mkdtempSync(join(tmpdir(), 'mama-backup-linked-'));
    roots.push(elsewhere);
    file(join(elsewhere, 'raw.db'), '');
    symlinkSync(elsewhere, join(installed.root, 'connectors', 'linked'));
    await expect(runBackup([], options)).rejects.toThrow(/linked is a symlink/);
    rmSync(join(installed.root, 'connectors', 'linked'));
    // A linked logs/ is fine until logs are asked for.
    rmSync(join(installed.root, 'logs'), { recursive: true });
    symlinkSync(elsewhere, join(installed.root, 'logs'));
    await expect(runBackup([], options)).resolves.toMatch(/mama-backup-/);
    await expect(
      runBackup(['--logs'], { ...options, now: () => new Date('2026-10-16T06:00:00Z') })
    ).rejects.toThrow(/logs is a symlink/);
    file(join(installed.root, 'connectors.json'), '{ "chatwork": ');
    await expect(runBackup([], options)).rejects.toThrow(/connectors\.json cannot be parsed/);
  });

  it('archives a wiki that sits in a folder the workspace walk leaves out', async () => {
    const installed = install({
      wiki: { enabled: true, vaultPath: 'WORKSPACE/.tmp', wikiDir: 'wiki' },
    });
    const config = JSON.parse(readFileSync(installed.configPath, 'utf8'));
    config.wiki.vaultPath = join(installed.root, 'workspace', '.tmp');
    writeFileSync(installed.configPath, JSON.stringify(config));
    file(join(installed.root, 'workspace', '.tmp', 'wiki', 'daily.md'), 'page');
    const archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: () => {},
    });
    const names = await entries(archive);
    expect(names).toContain('wiki/daily.md');
    expect(names).not.toContain('root/workspace/.tmp/wiki/daily.md');
  });

  it('tightens an existing folder and clears what an interrupted backup left', async () => {
    const installed = install();
    const folder = join(installed.root, 'backups');
    mkdirSync(join(folder, '.staging-1-1'), { recursive: true });
    writeFileSync(join(folder, 'mama-backup-old.tar.gz.partial'), 'half');
    chmodSync(folder, 0o755);
    const archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: () => {},
    });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual([basename(archive)]);
  });

  it('finds an archive whose content does not match its manifest', async () => {
    const installed = install();
    const archive = await runBackup([], {
      home: installed.home,
      configPath: installed.configPath,
      write: () => {},
    });
    const manifest = await manifestOf(archive);
    await expect(verifyArchive(archive, manifest)).resolves.toBeUndefined();
    const altered: BackupManifest = {
      ...manifest,
      entries: manifest.entries.map((entry) =>
        entry.path === 'root/owner-policy.md' ? { ...entry, sha256: '0'.repeat(64) } : entry
      ),
    };
    await expect(verifyArchive(archive, altered)).rejects.toThrow(
      /root\/owner-policy.md changed while archived/
    );
    await expect(
      verifyArchive(archive, {
        ...manifest,
        entries: [...manifest.entries, { path: 'root/gone.md', type: 'file', mode: 0o644 }],
      })
    ).rejects.toThrow(/root\/gone.md is missing/);
    await expect(
      verifyArchive(archive, {
        ...manifest,
        entries: manifest.entries.filter((entry) => entry.path !== 'root/owner-policy.md'),
      })
    ).rejects.toThrow(/root\/owner-policy.md is not in the manifest/);
    await expect(
      verifyArchive(archive, {
        ...manifest,
        entries: manifest.entries.map((entry) =>
          entry.path === 'root/start.sh' ? { ...entry, mode: 0o600 } : entry
        ),
      })
    ).rejects.toThrow(/root\/start.sh has another mode/);
    expect(readFileSync(archive).length).toBeGreaterThan(0);
  });
});

describe('mama backup --restart', () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
  });

  /** A systemd unit that runs; each systemctl call is recorded with the backups present then. */
  function systemd(root: string) {
    // launchd is asked only on macOS; this test's service manager is the recorded systemctl.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const calls: string[] = [];
    const run = vi.fn((command: string, args: string[]) => {
      const backups = existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')) : [];
      calls.push(`${command} ${args.join(' ')} [${backups.join(',')}]`);
      const state = args.includes('is-active');
      return {
        status: 0,
        stdout: state ? 'active\n' : '',
        stderr: '',
        signal: null,
        pid: 1,
        output: [],
      } as never;
    });
    return { calls, run };
  }

  it('refuses without a service to start it again, before stopping anything', async () => {
    const installed = install();
    const { run } = systemd(installed.root);
    await expect(
      runBackup(['--restart'], {
        home: installed.home,
        configPath: installed.configPath,
        platform: 'linux',
        run,
        write: () => {},
      })
    ).rejects.toThrow(/--restart starts MAMA again through its service, and none is installed/);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops through the service, backs up, and starts it again, also after a failed backup', async () => {
    const installed = install();
    const { calls, run } = systemd(installed.root);
    const options = {
      home: installed.home,
      configPath: installed.configPath,
      platform: 'linux' as const,
      run,
      write: () => {},
      settleMs: 1,
    };
    file(serviceFile(options), '[Unit]\n');
    const archive = await runBackup(['--restart'], options);
    expect(calls).toEqual([
      'systemctl --user is-active mama.service []',
      'systemctl --user stop mama.service []',
      `systemctl --user start mama.service [${basename(archive)}]`,
    ]);

    calls.length = 0;
    rmSync(join(installed.root, 'memory.db'));
    await expect(runBackup(['--restart'], options)).rejects.toThrow(/Backup failed/);
    expect(calls.at(-1)).toMatch(/^systemctl --user start mama\.service /);
  });
});
