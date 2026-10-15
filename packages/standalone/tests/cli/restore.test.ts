import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import { runBackup } from '../../src/cli/commands/backup.js';
import { runRestore } from '../../src/cli/commands/restore.js';
import {
  journalPath,
  removeTree,
  rewriteDatabase,
  rewritePaths,
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
  vault: string;
  configPath: string;
}

/** A YAML config as people write it: `~` paths, a split wiki, a comment. */
function yamlConfig(install: Omit<Install, 'configPath'>, database: string): string {
  return [
    '# owner settings',
    'version: 1',
    `member_root: ${install.members}`,
    `tools_root: ${install.tools}`,
    'agent:',
    '  backend: claude',
    '  model: fixture',
    '  max_turns: 10',
    '  timeout: 1000',
    'database:',
    `  path: ~/.mama/${database}`,
    'logging:',
    '  level: info',
    '  file: ~/.mama/logs/daemon.log',
    'telegram:',
    '  enabled: false',
    'wiki:',
    '  enabled: true',
    `  vaultPath: ${install.vault}`,
    '  wikiDir: wiki',
    '',
  ].join('\n');
}

/** An install whose state names its own paths, as a daemon writes them. */
function source(home = temp('a')): Install {
  const members = join(temp('a-members'), 'members');
  const tools = temp('a-tools');
  const vault = temp('a-vault');
  mkdirSync(members);
  const root = join(home, '.mama');
  const install = { home, root, members, tools, vault, configPath: join(root, 'config.yaml') };
  file(install.configPath, yamlConfig(install, 'mama-memory.db'));
  const attachment = join(root, 'downloads', 'telegram', '1_note.txt');
  const memberAttachment = join(members, 'person-a', 'downloads', 'telegram', '2_note.txt');
  const db = new Database(join(root, 'mama-memory.db'));
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
  // An agent's link to somewhere outside, by absolute path.
  symlinkSync('/usr/bin', join(root, 'workspace', 'files', 'outside'));
  file(join(root, 'runtime', 'owner-message-ledger.json'), '{"from":"a"}');
  file(join(root, 'owner-policy.md'), 'policy from a');
  file(join(root, 'start.sh'), '#!/bin/sh\n# a\n', 0o700);
  file(join(root, 'auth.env'), "export MAMA_TELEGRAM_TOKEN='a-token'\n", 0o600);
  file(join(vault, 'wiki', 'daily.md'), 'page from a');
  const sealed = join(tools, 'skills', '.versions', 'demo-1');
  file(join(sealed, 'SKILL.md'), 'skill', 0o444);
  chmodSync(sealed, 0o555);
  symlinkSync(join('.versions', 'demo-1'), join(tools, 'skills', 'demo'));
  return install;
}

/** A fresh install elsewhere, with its own credentials, start.sh and file names. */
function target(home = temp('b')): Install {
  const members = join(temp('b-members'), 'members');
  const tools = temp('b-tools');
  const vault = temp('b-vault');
  mkdirSync(members);
  const root = join(home, '.mama');
  const install = { home, root, members, tools, vault, configPath: join(root, 'config.yaml') };
  file(install.configPath, yamlConfig(install, 'memory.db'));
  file(join(root, 'auth.env'), "export MAMA_TELEGRAM_TOKEN='b-token'\n", 0o600);
  file(join(root, 'start.sh'), '#!/bin/sh\n# b\n', 0o700);
  file(join(root, 'owner-policy.md'), 'policy from b');
  file(join(root, 'runtime', 'report-schedule-state.json'), '{"from":"b"}');
  return install;
}

async function backupOf(install: Install): Promise<string> {
  return runBackup([], { home: install.home, configPath: install.configPath, write: () => {} });
}

function options(install: Install) {
  return { home: install.home, configPath: install.configPath, write: () => {} };
}

function leftovers(path: string): string[] {
  return existsSync(path)
    ? readdirSync(path).filter((name) => name.startsWith('.mama-restore-'))
    : [];
}

function attachmentPaths(database: string): string[] {
  const db = new Database(database, { readonly: true });
  const rows = db.prepare('SELECT payload_json FROM mailbox_inputs ORDER BY id').all() as {
    payload_json: string;
  }[];
  db.close();
  return rows.map((row) => JSON.parse(row.payload_json).input.attachments[0].path as string);
}

describe('mama restore', () => {
  it("restores the backup's settings with this install's places, and the files where they say", async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    const lines: string[] = [];
    await runRestore([archive], { ...options(b), write: (line) => lines.push(line) });

    const config = yaml.load(readFileSync(b.configPath, 'utf8')) as {
      member_root: string;
      tools_root: string;
      database: { path: string };
      wiki: Record<string, unknown>;
    };
    expect(config.member_root).toBe(b.members);
    expect(config.tools_root).toBe(b.tools);
    expect(config.database.path).toBe('~/.mama/memory.db');
    expect(config.wiki).toMatchObject({ enabled: true, vaultPath: b.vault, wikiDir: 'wiki' });
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from a');
    expect(readFileSync(join(b.vault, 'wiki', 'daily.md'), 'utf8')).toBe('page from a');
    expect(existsSync(join(b.root, 'mama-memory.db'))).toBe(false);

    // What the backup did not hold stays this install's own.
    expect(readFileSync(join(b.root, 'auth.env'), 'utf8')).toContain('b-token');
    expect(readFileSync(join(b.root, 'start.sh'), 'utf8')).toContain('# b');
    expect(readFileSync(join(b.root, 'runtime', 'report-schedule-state.json'), 'utf8')).toBe(
      '{"from":"b"}'
    );

    // The database went where the restored config opens it, with its paths moved.
    const paths = attachmentPaths(join(b.root, 'memory.db'));
    expect(paths).toEqual([
      join(b.members, 'person-a', 'downloads', 'telegram', '2_note.txt'),
      join(b.root, 'downloads', 'telegram', '1_note.txt'),
    ]);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    const db = new Database(join(b.root, 'memory.db'), { readonly: true });
    expect(
      db.prepare('SELECT operator_ingest_seq AS seq FROM connector_event_index').get()
    ).toEqual({ seq: 41 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([
      { name: 'renumber' },
    ]);
    db.close();
    // The raw store's hash covers its metadata: it keeps the path it recorded.
    const raw = new Database(join(b.root, 'connectors', 'chat', 'raw.db'), { readonly: true });
    const metadata = raw.prepare('SELECT metadata FROM raw_items').get() as { metadata: string };
    expect(JSON.parse(metadata.metadata).attachments[0].path).toBe(
      join(a.members, 'person-a', 'downloads', 'telegram', '2_note.txt')
    );
    raw.close();

    // Links come back as recorded, absolute ones too; sealed skills keep their modes.
    expect(readlinkSync(join(b.root, 'workspace', 'files', 'outside'))).toBe('/usr/bin');
    expect(readlinkSync(join(b.tools, 'skills', 'demo'))).toBe(join('.versions', 'demo-1'));
    expect(statSync(join(b.tools, 'skills', '.versions', 'demo-1')).mode & 0o777).toBe(0o555);

    for (const folder of [
      b.root,
      b.members,
      join(b.tools, 'skills'),
      join(b.vault, 'wiki'),
      join(b.root, 'runtime'),
    ]) {
      expect(leftovers(folder)).toEqual([]);
    }
    expect(readdirSync(join(b.root, 'backups'))).toEqual([]);
    expect(lines.join('\n')).toContain("this install's own credentials were kept");
  });

  it('rewrites each stored path once, with the new home inside the old one', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target(join(a.home, 'nested-home'));
    await runRestore([archive], options(b));
    const paths = attachmentPaths(join(b.root, 'memory.db'));
    expect(paths[1]).toBe(join(b.root, 'downloads', 'telegram', '1_note.txt'));
    expect(paths.some((path) => path.includes('nested-home/nested-home'))).toBe(false);
    expect(
      rewritePaths('{"p":"/h/.mama/x","q":"/h/.mamax"}', [
        ['/h/.mama', '/h/n/.mama'],
        ['/h', '/h/n'],
      ])
    ).toBe('{"p":"/h/n/.mama/x","q":"/h/n/.mamax"}');
  });

  it('puts every folder, file and database back when a switch fails part way', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    file(join(b.root, 'downloads', 'telegram', 'b.txt'), 'b download');
    file(join(b.root, 'connectors', 'poll-state.json'), '{"b":1}');
    file(join(b.members, 'person-a', 'notes.md'), 'b member');
    const db = new Database(join(b.root, 'memory.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec("CREATE TABLE b (v TEXT); INSERT INTO b VALUES ('b');");
    const wal = readFileSync(join(b.root, 'memory.db-wal'));
    db.close();
    writeFileSync(join(b.root, 'memory.db-wal'), wal);
    // member_root refuses new names, so the members' switch fails after the root's switched.
    chmodSync(b.members, 0o555);
    try {
      await expect(runRestore([archive], options(b))).rejects.toThrow(/put back as it was/);
    } finally {
      chmodSync(b.members, 0o755);
    }
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from b');
    expect(readFileSync(join(b.root, 'downloads', 'telegram', 'b.txt'), 'utf8')).toBe('b download');
    expect(readFileSync(join(b.root, 'connectors', 'poll-state.json'), 'utf8')).toBe('{"b":1}');
    expect(readFileSync(join(b.members, 'person-a', 'notes.md'), 'utf8')).toBe('b member');
    expect(readFileSync(join(b.root, 'memory.db-wal')).equals(wal)).toBe(true);
    const back = new Database(join(b.root, 'memory.db'), { readonly: true });
    expect(back.prepare('SELECT v FROM b').get()).toEqual({ v: 'b' });
    back.close();
    expect(existsSync(journalPath(b.root))).toBe(false);
    for (const folder of [b.root, b.members, join(b.root, 'runtime')]) {
      expect(leftovers(folder)).toEqual([]);
    }
  });

  it('resolves a journal left mid-switch, and finishes one that had committed', () => {
    const b = target();
    mkdirSync(join(b.root, 'backups'), { recursive: true });
    const destination = join(b.root, 'owner-policy.md');
    const aside = join(b.root, '.mama-restore-x-old-owner-policy.md');
    const sibling = join(b.root, '.mama-restore-x-owner-policy.md');
    const step = { destination, sibling, aside, companionEnds: [], existed: true };
    // Crashed after the copy took the name, before the journal said so.
    renameSync(destination, aside);
    file(destination, 'restored');
    writeFileSync(
      journalPath(b.root),
      JSON.stringify({ id: 'x', committed: false, steps: [{ ...step, state: 'switching' }] })
    );
    expect(rollBack(b.root)).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe('policy from b');
    expect(leftovers(b.root)).toEqual([]);
    // Crashed after committing, before the set-aside copy was cleared.
    renameSync(destination, aside);
    file(destination, 'restored');
    writeFileSync(
      journalPath(b.root),
      JSON.stringify({ id: 'x', committed: true, steps: [{ ...step, state: 'switched' }] })
    );
    expect(rollBack(b.root)).toBeNull();
    expect(readFileSync(destination, 'utf8')).toBe('restored');
    expect(existsSync(aside)).toBe(false);
    expect(existsSync(journalPath(b.root))).toBe(false);
    // A failure inside switchUnits is rolled back at once.
    file(join(b.root, 'backups', 'staged'), 'staged');
    let calls = 0;
    expect(() =>
      switchUnits(
        b.root,
        [{ staged: join(b.root, 'backups', 'staged'), destination }],
        'y',
        (from, to) => {
          calls += 1;
          if (calls === 2) throw new Error('fixture rename refused');
          renameSync(from, to);
        }
      )
    ).toThrow(/fixture rename refused/);
    expect(readFileSync(destination, 'utf8')).toBe('restored');
    expect(existsSync(journalPath(b.root))).toBe(false);
    expect(leftovers(b.root)).toEqual([]);
  });

  it('refuses while held, while a journal is open, and without a place for what it holds', async () => {
    const a = source();
    const archive = await backupOf(a);
    const b = target();
    const lock = acquireInstallLock(daemonControlPaths(b.root), 'daemon');
    try {
      await expect(runRestore([archive], options(b))).rejects.toThrow(/already running/);
    } finally {
      lock.release();
    }
    mkdirSync(join(b.root, 'backups'), { recursive: true });
    writeFileSync(journalPath(b.root), JSON.stringify({ id: 'x', committed: false, steps: [] }));
    await expect(runRestore([archive], options(b))).rejects.toThrow(/--rollback/);
    await runRestore(['--rollback'], options(b));
    const config = yaml.load(readFileSync(b.configPath, 'utf8')) as Record<string, unknown>;
    delete config.wiki;
    writeFileSync(b.configPath, yaml.dump(config));
    // The backup has its wiki on; this install has no place for it.
    await expect(runRestore([archive], options(b))).rejects.toThrow(/wiki/);
    expect(readFileSync(join(b.root, 'owner-policy.md'), 'utf8')).toBe('policy from b');
  });

  it('reads the manifest as untrusted: links with entries beneath, names no backup keeps, credentials it did not take', () => {
    const configured = {
      root: { configured: '/h/.mama', physical: '/h/.mama' },
      workspace: { configured: '/h/.mama/workspace', physical: '/h/.mama/workspace' },
    };
    const manifest = (entries: unknown[], includesSecrets = false) =>
      ({
        format: 'mama-backup',
        version: 1,
        databases: [],
        includesSecrets,
        configured,
        entries,
      }) as unknown as BackupManifest;
    const entry = (path: string) => ({ path, type: 'file', mode: 0o644, sha256: '0'.repeat(64) });
    const folder = (path: string) => ({ path, type: 'dir', mode: 0o755 });
    const link = (path: string, target: string) => ({ path, type: 'symlink', mode: 0o777, target });
    const refused = [
      [folder('root'), link('root/workspace', '.')],
      [folder('workspace'), link('workspace/x', '.'), entry('workspace/x/y')],
      [folder('root'), entry('root/backups')],
      [folder('root'), entry('root/auth.env')],
      [folder('root'), folder('root/runtime'), entry('root/runtime/daemon.token')],
      [entry('credentials/auth.env')],
      [link('workspace', '/etc')],
      [entry('root/../../etc/passwd')],
      [entry('database'), entry('database/x')],
    ];
    for (const entries of refused) {
      expect(() => validateManifest(manifest(entries))).toThrow(/archive manifest/);
    }
    expect(() =>
      validateManifest(
        manifest([folder('root'), folder('root/workspace'), link('root/workspace/a', '/usr/bin')])
      )
    ).not.toThrow();
    expect(() => validateManifest(manifest([entry('credentials/auth.env')], true))).not.toThrow();
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
  });
});
