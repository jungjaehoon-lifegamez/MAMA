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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runBackup } from '../../src/cli/commands/backup.js';
import { runRestore } from '../../src/cli/commands/restore.js';
import {
  journalPath,
  removeTree,
  rewriteDatabase,
  rollBack,
  switchUnits,
  validateManifest,
} from '../../src/cli/runtime/restore.js';
import type { BackupManifest } from '../../src/cli/runtime/backup.js';
import { acquireInstallLock, daemonControlPaths } from '../../src/cli/runtime/daemon-control.js';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) removeTree(path);
});

function file(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function temp(name: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `mama-restore-${name}-`)));
  roots.push(path);
  return path;
}

interface Install {
  home: string;
  root: string;
  members: string;
  tools: string;
  configPath: string;
}

function config(install: Omit<Install, 'configPath'>): string {
  return JSON.stringify({
    version: 1,
    member_root: install.members,
    tools_root: install.tools,
    agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
    database: { path: join(install.root, 'memory.db') },
    logging: { level: 'info', file: join(install.root, 'logs', 'daemon.log') },
    telegram: { enabled: false },
  });
}

/** An install with state that names its own paths, as a daemon writes them. */
function source(): Install {
  const home = temp('a');
  const members = temp('a-members');
  const tools = temp('a-tools');
  const root = join(home, '.mama');
  const install = { home, root, members, tools, configPath: join(root, 'config.yaml') };
  file(install.configPath, config(install));
  const attachment = join(root, 'downloads', 'telegram', '1_note.txt');
  const memberAttachment = join(members, 'person-a', 'downloads', 'telegram', '2_note.txt');
  const db = new Database(join(root, 'memory.db'));
  db.exec(`
    CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (72);
    CREATE TABLE mailbox_inputs (id TEXT, payload_json TEXT);
    CREATE TABLE connector_event_index (
      event_index_id TEXT, metadata_json TEXT, operator_ingest_seq INTEGER
    );
    CREATE TRIGGER renumber AFTER UPDATE OF metadata_json ON connector_event_index
    BEGIN
      UPDATE connector_event_index SET operator_ingest_seq = NULL
       WHERE event_index_id = NEW.event_index_id;
    END;
  `);
  db.prepare('INSERT INTO mailbox_inputs VALUES (?, ?)').run(
    'owner',
    JSON.stringify({ input: { attachments: [{ name: 'note', path: attachment }] } })
  );
  db.prepare('INSERT INTO mailbox_inputs VALUES (?, ?)').run(
    'member',
    JSON.stringify({ input: { attachments: [{ name: 'note', path: memberAttachment }] } })
  );
  db.prepare('INSERT INTO connector_event_index VALUES (?, ?, ?)').run(
    'event',
    JSON.stringify({ input: { attachments: [{ path: attachment }] } }),
    41
  );
  db.close();
  mkdirSync(join(root, 'connectors', 'chat'), { recursive: true });
  const raw = new Database(join(root, 'connectors', 'chat', 'raw.db'));
  raw.exec('CREATE TABLE raw_items (id TEXT, metadata TEXT)');
  raw
    .prepare('INSERT INTO raw_items VALUES (?, ?)')
    .run('item', JSON.stringify({ attachments: [{ path: memberAttachment }] }));
  raw.close();
  file(attachment, 'owner attachment');
  file(memberAttachment, 'member attachment');
  file(join(root, 'workspace', 'files', 'report.md'), 'report');
  file(join(root, 'runtime', 'owner-message-ledger.json'), '{"from":"a"}');
  file(join(root, 'owner-policy.md'), 'policy from a');
  file(join(root, 'start.sh'), '#!/bin/sh\n# a\n', 0o700);
  file(join(root, 'auth.env'), "export MAMA_TELEGRAM_TOKEN='a-token'\n", 0o600);
  const sealed = join(tools, 'skills', '.versions', 'demo-1');
  file(join(sealed, 'SKILL.md'), 'skill', 0o444);
  chmodSync(sealed, 0o555);
  symlinkSync(join('.versions', 'demo-1'), join(tools, 'skills', 'demo'));
  return install;
}

/** A fresh install elsewhere, with its own credentials and start.sh. */
function target(): Install {
  const home = temp('b');
  // One level down, so a test can make its parent refuse writes.
  const members = join(temp('b-members'), 'members');
  mkdirSync(members);
  const tools = temp('b-tools');
  const root = join(home, '.mama');
  const install = { home, root, members, tools, configPath: join(root, 'config.yaml') };
  file(install.configPath, config(install));
  file(join(root, 'auth.env'), "export MAMA_TELEGRAM_TOKEN='b-token'\n", 0o600);
  file(join(root, 'start.sh'), '#!/bin/sh\n# b\n', 0o700);
  file(join(root, 'owner-policy.md'), 'policy from b');
  file(join(root, 'runtime', 'report-schedule-state.json'), '{"from":"b"}');
  return install;
}

async function backupOf(install: Install): Promise<string> {
  return runBackup([], { home: install.home, configPath: install.configPath, write: () => {} });
}

function leftovers(path: string): string[] {
  return readdirSync(path).filter((name) => name.startsWith('.mama-restore-'));
}

describe('mama restore', () => {
  it('puts a backup onto another install, with its paths rewritten to that install', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    const lines: string[] = [];
    await runRestore([archive], {
      home: b.home,
      configPath: b.configPath,
      write: (line) => lines.push(line),
    });

    // Config came from the backup, pointing at this install's roots.
    const restored = JSON.parse(readFileSync(b.configPath, 'utf8'));
    expect(restored.member_root).toBe(b.members);
    expect(restored.tools_root).toBe(b.tools);
    expect(restored.database.path).toBe(join(b.root, 'memory.db'));
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from a');
    expect(readFileSync(join(b.root, 'runtime', 'owner-message-ledger.json'), 'utf8')).toBe(
      '{"from":"a"}'
    );
    // What the backup did not hold stays this install's own.
    expect(readFileSync(join(b.root, 'auth.env'), 'utf8')).toContain('b-token');
    expect(readFileSync(join(b.root, 'start.sh'), 'utf8')).toContain('# b');
    expect(readFileSync(join(b.root, 'runtime', 'report-schedule-state.json'), 'utf8')).toBe(
      '{"from":"b"}'
    );

    // Files sit at this install's paths; stored paths name them there.
    const db = new Database(join(b.root, 'memory.db'), { readonly: true });
    const payloads = db.prepare('SELECT payload_json FROM mailbox_inputs ORDER BY id').all() as {
      payload_json: string;
    }[];
    const paths = payloads.map(
      (row) => JSON.parse(row.payload_json).input.attachments[0].path as string
    );
    expect(paths).toEqual([
      join(b.members, 'person-a', 'downloads', 'telegram', '2_note.txt'),
      join(b.root, 'downloads', 'telegram', '1_note.txt'),
    ]);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    // The rewrite left the event's ingest sequence alone, and the trigger is back.
    expect(
      db.prepare('SELECT operator_ingest_seq AS seq FROM connector_event_index').get()
    ).toEqual({
      seq: 41,
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([
      { name: 'renumber' },
    ]);
    db.close();
    const raw = new Database(join(b.root, 'connectors', 'chat', 'raw.db'), { readonly: true });
    expect(
      JSON.parse(
        (raw.prepare('SELECT metadata FROM raw_items').get() as { metadata: string }).metadata
      ).attachments[0].path
    ).toBe(join(b.members, 'person-a', 'downloads', 'telegram', '2_note.txt'));
    raw.close();

    // The skill keeps its link and its sealed modes.
    expect(readlinkSync(join(b.tools, 'skills', 'demo'))).toBe(join('.versions', 'demo-1'));
    expect(statSync(join(b.tools, 'skills', '.versions', 'demo-1')).mode & 0o777).toBe(0o555);
    expect(statSync(join(b.tools, 'skills', '.versions', 'demo-1', 'SKILL.md')).mode & 0o777).toBe(
      0o444
    );

    // Nothing of the switch is left behind.
    for (const folder of [b.root, dirname(b.members), b.tools, join(b.root, 'runtime')]) {
      expect(leftovers(folder)).toEqual([]);
    }
    expect(readdirSync(join(b.root, 'backups'))).toEqual([]);
    expect(lines.join('\n')).toContain("this install's own credentials were kept");
  });

  it('puts everything back when one switch fails', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    // The members' parent refuses the rename, after the root's paths were switched.
    const parent = dirname(b.members);
    chmodSync(parent, 0o555);
    try {
      await expect(
        runRestore([archive], { home: b.home, configPath: b.configPath, write: () => {} })
      ).rejects.toThrow(/put back as it was/);
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from b');
    expect(JSON.parse(readFileSync(b.configPath, 'utf8')).member_root).toBe(b.members);
    expect(existsSync(join(b.root, 'memory.db'))).toBe(false);
    expect(existsSync(journalPath(b.root))).toBe(false);
    expect(leftovers(b.root)).toEqual([]);
    expect(readdirSync(join(b.root, 'backups'))).toEqual([]);
  });

  it('rolls back an interrupted switch from its journal', () => {
    const b = target();
    const staged = join(b.root, 'backups', 'staged-policy.md');
    file(staged, 'staged');
    mkdirSync(join(b.root, 'backups'), { recursive: true });
    switchUnits(b.root, [{ staged, destination: join(b.root, 'owner-policy.md') }], 'test');
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('staged');
    // Interrupted before finishing: the journal is still there.
    expect(existsSync(journalPath(b.root))).toBe(true);
    expect(rollBack(b.root)).toBe(1);
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from b');
    expect(existsSync(journalPath(b.root))).toBe(false);
    expect(leftovers(b.root)).toEqual([]);
  });

  it('refuses while held, after an interrupted restore, and without a place for what it holds', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    const options = { home: b.home, configPath: b.configPath, write: () => {} };
    const lock = acquireInstallLock(daemonControlPaths(b.root), 'daemon');
    try {
      await expect(runRestore([archive], options)).rejects.toThrow(/already running/);
    } finally {
      lock.release();
    }
    mkdirSync(join(b.root, 'backups'), { recursive: true });
    writeFileSync(journalPath(b.root), JSON.stringify({ id: 'x', steps: [] }));
    await expect(runRestore([archive], options)).rejects.toThrow(/--rollback/);
    await runRestore(['--rollback'], options);
    const noMembers = JSON.parse(readFileSync(b.configPath, 'utf8'));
    delete noMembers.member_root;
    writeFileSync(b.configPath, JSON.stringify(noMembers));
    await expect(runRestore([archive], options)).rejects.toThrow(/no member_root configured/);
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from b');
  });

  it('reads the manifest as untrusted', () => {
    const base = {
      format: 'mama-backup',
      version: 1,
      databases: [],
      configured: {},
    } as unknown as BackupManifest;
    for (const path of ['root/../../etc/passwd', '/etc/passwd', 'elsewhere/file', 'root//x']) {
      expect(() =>
        validateManifest({
          ...base,
          entries: [{ path, type: 'file', mode: 0o644, sha256: '0'.repeat(64) }],
        })
      ).toThrow(/may not/);
    }
    expect(() =>
      validateManifest({
        ...base,
        entries: [],
        configured: { root: { configured: 'relative', physical: '/x' } },
      } as unknown as BackupManifest)
    ).toThrow(/relative path/);
  });

  it('rewrites stored paths without firing update triggers', () => {
    const dir = temp('db');
    const path = join(dir, 'x.db');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE connector_event_index (event_index_id TEXT, metadata_json TEXT, seq INTEGER);
      CREATE TRIGGER renumber AFTER UPDATE OF metadata_json ON connector_event_index
      BEGIN UPDATE connector_event_index SET seq = NULL; END;
      INSERT INTO connector_event_index VALUES ('e', '{"path":"/old/root/f","other":"/old/rootx"}', 7);
    `);
    db.close();
    expect(
      rewriteDatabase(path, [['connector_event_index', 'metadata_json']], [['/old/root', '/new']])
    ).toBe(1);
    const after = new Database(path, { readonly: true });
    expect(
      after.prepare('SELECT metadata_json AS m, seq FROM connector_event_index').get()
    ).toEqual({
      m: '{"path":"/new/f","other":"/old/rootx"}',
      seq: 7,
    });
    after.close();
    expect(lstatSync(path).isFile()).toBe(true);
  });
});
