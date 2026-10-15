import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
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
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import { runBackup } from '../../src/cli/commands/backup.js';
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
    expect(archive).toBe(join(installed.root, 'backups', 'mama-backup-20261016-050000.tar.gz'));
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
      'root/.codex/sessions/thread.jsonl',
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
      'jev/key',
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
        root: installed.root,
        // Config reads member_root and tools_root as physical paths.
        members: realpathSync(installed.members),
        skills: join(realpathSync(installed.tools), 'skills'),
        database: join(installed.root, 'memory.db'),
      },
    });
    expect(manifest.databases.sort()).toEqual(['database', 'root/connectors/chat/raw.db']);
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
      'root/auth.env',
      'root/.codex/auth.json',
      'members/person-a/.codex/auth.json',
      'jev/key',
      'root/logs/daemon.log',
    ]) {
      expect(names).toContain(kept);
    }
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
    expect(lines.join('\n')).toContain('config.yaml (it holds 1 credential-shaped value(s))');
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
    await expect(
      runBackup(['--out', join(installed.root, 'workspace', 'files')], options)
    ).rejects.toThrow(/inside or holds the workspace/);
    await expect(runBackup(['--out', installed.members], options)).rejects.toThrow(/member_root/);
    expect(existsSync(join(installed.root, 'backups'))).toBe(false);
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
    expect(readFileSync(archive).length).toBeGreaterThan(0);
  });
});
