import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
let tempDir: string | null = null;

function cleanupTempDir(): void {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}

function migrationFilesThrough(version: number): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .filter((file) => Number(file.slice(0, 3)) <= version)
    .sort((left, right) => left.localeCompare(right));
}

function applyThrough(db: Database.Database, version: number): void {
  for (const file of migrationFilesThrough(version)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(indexName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function tableSql(db: Database.Database, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function triggerExists(db: Database.Database, triggerName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(triggerName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

describe('Story M2.1: Migration 032 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial migration recovery', () => {
      it('repairs a partially applied 032 migration when agent_id already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-032-'));
        const dbPath = join(tempDir, 'partial-032.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 31);
        setupDb.exec('ALTER TABLE decisions ADD COLUMN agent_id TEXT');
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        for (const column of [
          'agent_id',
          'model_run_id',
          'envelope_hash',
          'gateway_call_id',
          'source_refs_json',
          'provenance_json',
        ]) {
          expect(columnExists(db, 'decisions', column)).toBe(true);
        }
        expect(indexExists(db, 'idx_decisions_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_decisions_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_decisions_gateway_call_id')).toBe(true);
        expect(indexExists(db, 'idx_memory_events_memory_created')).toBe(true);

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 32').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(32);
        db.close();
      });
    });
  });
});

describe('Story T4: stamped registry identity migration recovery', () => {
  afterEach(cleanupTempDir);

  it('repairs partial 069 and 070 structures before dependent migrations run', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-identity-'));
    const dbPath = join(tempDir, 'partial-identity.db');
    const setupDb = new Database(dbPath);
    setupDb.pragma('foreign_keys = ON');
    applyThrough(setupDb, 68);
    setupDb.exec('ALTER TABLE decisions ADD COLUMN item_id TEXT');
    setupDb
      .prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
      .run(69, 'partial registry stamp');
    setupDb
      .prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
      .run(70, 'partial record stamp');
    setupDb.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    adapter.disconnect();

    const db = new Database(dbPath);
    expect(tableExists(db, 'registry_nodes')).toBe(true);
    expect(tableExists(db, 'registry_aliases')).toBe(true);
    expect(indexExists(db, 'idx_registry_aliases_node')).toBe(true);
    expect(columnExists(db, 'decisions', 'item_id')).toBe(true);
    expect(tableExists(db, 'record_actors')).toBe(true);
    expect(indexExists(db, 'idx_decisions_item')).toBe(true);
    expect(indexExists(db, 'idx_record_actors_person')).toBe(true);
    db.close();
  });

  it('repairs a stamped 069 database when registry_nodes exists but registry_aliases is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-missing-aliases-'));
    const dbPath = join(tempDir, 'missing-aliases.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 68);
    setup.exec(`
      CREATE TABLE registry_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES registry_nodes(id) ON DELETE SET NULL,
        merged_into TEXT REFERENCES registry_nodes(id) ON DELETE SET NULL,
        merge_reason TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO registry_nodes VALUES ('kept', 'item', 'kept', NULL, NULL, NULL, NULL, 1, 1);
      INSERT INTO schema_version(version, description) VALUES (69, 'partial');
    `);
    setup.close();
    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    expect(tableExists(adapter as unknown as Database.Database, 'registry_aliases')).toBe(true);
    expect(adapter.prepare("SELECT name FROM registry_nodes WHERE id='kept'").get()).toEqual({
      name: 'kept',
    });
    adapter.disconnect();
  });

  it('repairs populated evasive shapes and wrong canonical indexes without losing custom objects', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-malformed-identity-'));
    const dbPath = join(tempDir, 'malformed-identity.db');
    const setupDb = new Database(dbPath);
    setupDb.pragma('foreign_keys = ON');
    applyThrough(setupDb, 68);
    setupDb.exec(`
      CREATE TABLE registry_note_refs (id TEXT PRIMARY KEY);
      INSERT INTO registry_note_refs(id) VALUES ('note');
      CREATE TABLE registry_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
        name INTEGER NOT NULL,
        parent_id TEXT, merged_into TEXT, merge_reason TEXT, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK (note IS NULL OR note != 'forbidden'),
        UNIQUE (note, name),
        FOREIGN KEY (note) REFERENCES registry_note_refs(id)
      );
      CREATE TABLE registry_aliases (
        node_id TEXT NOT NULL REFERENCES registry_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
        alias TEXT NOT NULL, alias_display TEXT NOT NULL,
        scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (kind, alias, scope_kind, scope_id)
      );
      CREATE TABLE registry_scope_bindings (
        node_id TEXT NOT NULL REFERENCES registry_nodes(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
        scope_id TEXT NOT NULL,
        PRIMARY KEY (node_id, scope_kind, scope_id)
      );
      CREATE TABLE record_actors (
        record_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL, role TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, person_id, role),
        CHECK (position >= 0),
        UNIQUE (person_id, position)
      );
      ALTER TABLE decisions ADD COLUMN item_id TEXT;
      INSERT INTO registry_nodes
        (id, kind, name, parent_id, merged_into, merge_reason, note, created_at, updated_at)
        VALUES ('reg-preserved', 'item', 'preserved item', NULL, NULL, NULL, 'note', 1, 2);
      INSERT INTO registry_aliases
        (node_id, kind, alias, alias_display, scope_kind, scope_id, created_at)
        VALUES ('reg-preserved', 'item', 'preserved', 'Preserved', 'global', '*', '3');
      INSERT INTO decisions
        (id, topic, decision, confidence, created_at, updated_at)
        VALUES ('decision-preserved', 'topic', 'decision', 1, 1, 1);
      INSERT INTO record_actors
        (record_id, person_id, role, position, created_at)
        VALUES ('decision-preserved', 'reg-person', 'worker', 4, 5);
      CREATE INDEX idx_registry_custom_note ON registry_nodes(note);
      CREATE INDEX idx_registry_nodes_kind ON registry_nodes(name);
      CREATE INDEX idx_registry_nodes_parent ON registry_nodes(note);
      CREATE INDEX idx_registry_aliases_node ON registry_aliases(alias);
      CREATE INDEX idx_registry_aliases_scope ON registry_aliases(scope_id);
      CREATE INDEX idx_registry_scope_lookup ON registry_scope_bindings(node_id);
      CREATE INDEX idx_record_actors_person ON record_actors(role);
      CREATE TABLE registry_repair_audit (node_id TEXT);
      CREATE TRIGGER custom_registry_insert AFTER INSERT ON registry_nodes
        BEGIN INSERT INTO registry_repair_audit(node_id) VALUES (NEW.id); END;
      CREATE TABLE registry_external_child (
        node_id TEXT REFERENCES registry_nodes(id) ON DELETE CASCADE
      );
      INSERT INTO registry_external_child(node_id) VALUES ('reg-preserved');
      CREATE TABLE actor_external_child (
        record_id TEXT, person_id TEXT, role TEXT,
        FOREIGN KEY (record_id, person_id, role)
          REFERENCES record_actors(record_id, person_id, role) ON DELETE CASCADE
      );
      INSERT INTO actor_external_child(record_id, person_id, role)
        VALUES ('decision-preserved', 'reg-person', 'worker');
      INSERT INTO schema_version (version, description) VALUES (69, 'malformed registry');
      INSERT INTO schema_version (version, description) VALUES (70, 'malformed actors');
    `);
    setupDb.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    adapter.disconnect();

    const db = new Database(dbPath);
    const firstSchema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'registry_nodes'")
      .get() as { sql: string };
    expect(tableSql(db, 'registry_nodes')).toContain("kind IN ('item', 'person', 'client')");
    expect(tableSql(db, 'record_actors')).toContain('PRIMARY KEY (record_id, person_id, role)');
    expect(tableSql(db, 'record_actors')).toContain('DEFAULT 0');
    expect(indexExists(db, 'idx_registry_scope_lookup')).toBe(true);
    expect(
      db.prepare("SELECT name, note FROM registry_nodes WHERE id = 'reg-preserved'").get()
    ).toEqual({
      name: 'preserved item',
      note: 'note',
    });
    expect(
      db
        .prepare(
          "SELECT person_id, role, position FROM record_actors WHERE record_id = 'decision-preserved'"
        )
        .get()
    ).toEqual({ person_id: 'reg-person', role: 'worker', position: 4 });
    expect(indexExists(db, 'idx_registry_custom_note')).toBe(true);
    expect(triggerExists(db, 'custom_registry_insert')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM registry_external_child').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM actor_external_child').get()).toEqual({
      count: 1,
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO registry_nodes
           (id, kind, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('reg-invalid', 'item', 'invalid', 'forbidden', 1, 1)
    ).toThrow(/constraint/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO record_actors
           (record_id, person_id, role, position, created_at) VALUES (?, ?, ?, ?, ?)`
        )
        .run('decision-preserved', 'reg-other', 'worker', -1, 1)
    ).toThrow(/constraint/i);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();

    const second = new NodeSQLiteAdapter({ dbPath });
    second.connect();
    second.runMigrations(MIGRATIONS_DIR);
    second.disconnect();
    const reopened = new Database(dbPath);
    expect(
      (
        reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'registry_nodes'").get() as {
          sql: string;
        }
      ).sql
    ).toBe(firstSchema.sql);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM registry_external_child').get()).toEqual(
      {
        count: 1,
      }
    );
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });

  it('refuses an unsupported inline constraint before changing rows, children, schema or FK state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-inline-constraint-'));
    const dbPath = join(tempDir, 'inline.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 68);
    setup.exec(`
      CREATE TABLE registry_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
        name TEXT NOT NULL COLLATE NOCASE,
        parent_id TEXT, merged_into TEXT, merge_reason TEXT, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO registry_nodes VALUES ('kept', 'item', 'Kept', NULL, NULL, NULL, NULL, 1, 1);
      CREATE TABLE inline_child (
        node_id TEXT REFERENCES registry_nodes(id) ON DELETE CASCADE
      );
      INSERT INTO inline_child VALUES ('kept');
      INSERT INTO schema_version(version, description) VALUES (69, 'inline partial');
    `);
    const schemaBefore = tableSql(setup, 'registry_nodes');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/inline constraint/);
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='registry_nodes'")
          .get() as { sql: string }
      ).sql
    ).toBe(schemaBefore);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM registry_nodes').get()).toEqual({
      count: 1,
    });
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM inline_child').get()).toEqual({
      count: 1,
    });
    adapter.disconnect();
  });
});

describe('Story PR3B: migrations 072-074 structural recovery', () => {
  afterEach(cleanupTempDir);

  it('preserves populated observations, custom constraints, indexes, triggers, and FK children', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-observation-'));
    const dbPath = join(tempDir, 'observation.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 71);
    setup.exec(`
      CREATE TABLE observation_versions (
        observation_id TEXT PRIMARY KEY,
        source_connector TEXT NOT NULL,
        source_id TEXT NOT NULL,
        producer_version_id TEXT,
        body TEXT,
        body_location_json TEXT,
        author TEXT,
        source_at INTEGER,
        observed_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        note TEXT,
        CHECK ((body IS NOT NULL AND body_location_json IS NULL)
          OR (body IS NULL AND body_location_json IS NOT NULL)),
        CHECK (note IS NULL OR note <> 'forbidden'),
        UNIQUE (source_connector, source_id, note)
      );
      ALTER TABLE connector_event_index ADD COLUMN current_observation_id TEXT;
      INSERT INTO observation_versions VALUES
        ('obs-kept', 'synthetic', 'source-1', NULL, 'body', NULL, 'author', 1, 2,
         'hash', '{}', '{}', 'kept');
      CREATE INDEX observation_custom_note ON observation_versions(note);
      CREATE TABLE observation_audit (observation_id TEXT);
      CREATE TRIGGER observation_custom_trigger AFTER INSERT ON observation_versions
        BEGIN INSERT INTO observation_audit VALUES (NEW.observation_id); END;
      CREATE TABLE observation_child (
        observation_id TEXT REFERENCES observation_versions(observation_id) ON DELETE CASCADE
      );
      INSERT INTO observation_child VALUES ('obs-kept');
      INSERT INTO schema_version(version, description) VALUES (72, 'partial observation');
    `);
    setup.close();

    for (let pass = 0; pass < 2; pass += 1) {
      const adapter = new NodeSQLiteAdapter({ dbPath });
      adapter.connect();
      adapter.runMigrations(MIGRATIONS_DIR);
      adapter.disconnect();
    }

    const db = new Database(dbPath);
    expect(
      db.prepare("SELECT note FROM observation_versions WHERE observation_id='obs-kept'").get()
    ).toEqual({ note: 'kept' });
    expect(indexExists(db, 'observation_custom_note')).toBe(true);
    expect(triggerExists(db, 'observation_custom_trigger')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM observation_child').get()).toEqual({
      count: 1,
    });
    expect(() =>
      db
        .prepare(
          `INSERT INTO observation_versions
        (observation_id,source_connector,source_id,body,observed_at,content_hash,metadata_json,scope_json,note)
        VALUES ('obs-bad','synthetic','source-2','body',3,'hash-2','{}','{}','forbidden')`
        )
        .run()
    ).toThrow(/constraint/i);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      (
        db
          .prepare("SELECT * FROM pragma_foreign_key_list('connector_event_index')")
          .all() as Array<{
          from: string;
          table: string;
        }>
      ).some(
        (foreignKey) =>
          foreignKey.from === 'current_observation_id' &&
          foreignKey.table === 'observation_versions'
      )
    ).toBe(true);
    db.close();
  });

  it('refuses an unsupported observation inline constraint before later migration DDL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-observation-refuse-'));
    const dbPath = join(tempDir, 'observation-refuse.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 71);
    setup.exec(`
      CREATE TABLE observation_versions (
        observation_id TEXT PRIMARY KEY, source_connector TEXT NOT NULL, source_id TEXT NOT NULL,
        producer_version_id TEXT, body TEXT COLLATE NOCASE, body_location_json TEXT, author TEXT,
        source_at INTEGER, observed_at INTEGER NOT NULL, content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL, scope_json TEXT NOT NULL,
        CHECK ((body IS NOT NULL AND body_location_json IS NULL)
          OR (body IS NULL AND body_location_json IS NOT NULL))
      );
      ALTER TABLE connector_event_index ADD COLUMN current_observation_id TEXT
        REFERENCES observation_versions(observation_id);
      INSERT INTO observation_versions VALUES
        ('obs-kept', 'synthetic', 'source-1', NULL, 'body', NULL, NULL, NULL, 1, 'hash', '{}', '{}');
      INSERT INTO schema_version(version, description) VALUES (72, 'unsupported observation');
    `);
    const before = tableSql(setup, 'observation_versions');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/inline constraint/);
    expect(tableExists(adapter as unknown as Database.Database, 'registry_corrections')).toBe(
      false
    );
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='observation_versions'")
          .get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    adapter.disconnect();
  });

  it('refuses a populated incompatible correction table before graph migration DDL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-correction-refuse-'));
    const dbPath = join(tempDir, 'correction-refuse.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 72);
    setup.exec(`
      CREATE TABLE registry_corrections (command_id TEXT PRIMARY KEY);
      INSERT INTO registry_corrections VALUES ('command-kept');
      INSERT INTO schema_version(version, description) VALUES (73, 'incompatible corrections');
    `);
    const before = tableSql(setup, 'registry_corrections');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(
      /cannot safely repair populated incompatible table registry_corrections/
    );
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='registry_corrections'")
          .get() as { sql: string }
      ).sql
    ).toBe(before);
    expect(
      adapter.prepare('SELECT version FROM schema_version WHERE version=74').get()
    ).toBeUndefined();
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    adapter.disconnect();
  });

  it('refuses all-column weak stamped correction schemas before any mutation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-correction-weak-'));
    const dbPath = join(tempDir, 'correction-weak.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 72);
    setup.exec(`
      CREATE TABLE registry_identity_state (singleton INTEGER, revision INTEGER);
      CREATE TABLE registry_corrections (
        command_id TEXT, operation TEXT, expected_revision INTEGER, committed_revision INTEGER,
        principal_id TEXT, agent_id TEXT, origin TEXT, payload_json TEXT, reason TEXT,
        evidence_json TEXT, scope_json TEXT, receipt_json TEXT, created_at INTEGER
      );
      CREATE TABLE registry_ref_assignments (
        command_id TEXT, edge_id TEXT, endpoint TEXT, original_kind TEXT, original_id TEXT,
        resolved_node_id TEXT, committed_revision INTEGER, created_at INTEGER
      );
      CREATE INDEX idx_registry_ref_assignments_current
        ON registry_ref_assignments(edge_id, endpoint, committed_revision DESC);
      INSERT INTO schema_version(version, description) VALUES (73, 'weak correction shape');
    `);
    const before = tableSql(setup, 'registry_corrections');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/structurally incompatible/);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='registry_corrections'")
          .get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    expect(
      adapter.prepare('SELECT version FROM schema_version WHERE version=74').get()
    ).toBeUndefined();
    adapter.disconnect();
  });

  it('refuses an empty malformed correction table with custom objects and FK children', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-correction-objects-'));
    const dbPath = join(tempDir, 'correction-objects.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 72);
    setup.exec(`
      CREATE TABLE registry_corrections (command_id TEXT PRIMARY KEY);
      CREATE INDEX correction_custom_empty ON registry_corrections(command_id);
      CREATE TABLE correction_audit (command_id TEXT);
      CREATE TRIGGER correction_custom_empty_trigger AFTER INSERT ON registry_corrections
        BEGIN INSERT INTO correction_audit VALUES (NEW.command_id); END;
      CREATE TABLE correction_external_child (
        command_id TEXT REFERENCES registry_corrections(command_id)
      );
      INSERT INTO schema_version(version, description) VALUES (73, 'empty malformed correction');
    `);
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/cannot safely replace/);
    expect(indexExists(adapter as unknown as Database.Database, 'correction_custom_empty')).toBe(
      true
    );
    expect(
      triggerExists(adapter as unknown as Database.Database, 'correction_custom_empty_trigger')
    ).toBe(true);
    expect(tableExists(adapter as unknown as Database.Database, 'correction_external_child')).toBe(
      true
    );
    adapter.disconnect();
  });

  it('refuses an unsupported graph ref inline constraint before mutating the edge table', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-graph-refuse-'));
    const dbPath = join(tempDir, 'graph-refuse.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 73);
    const graphSql = tableSql(setup, 'twin_edges');
    setup.exec('DROP TABLE twin_edges');
    setup.exec(
      graphSql.replace('subject_kind TEXT NOT NULL', 'subject_kind TEXT COLLATE NOCASE NOT NULL')
    );
    setup
      .prepare(
        `INSERT INTO twin_edges
          (edge_id,edge_type,subject_kind,subject_id,object_kind,object_id,confidence,source,
           content_hash,created_at)
         VALUES ('edge-kept','mentions','memory','memory-1','raw','raw-1',1,'code',?,1)`
      )
      .run(Buffer.alloc(32));
    setup
      .prepare('INSERT INTO schema_version(version, description) VALUES (74, ?)')
      .run('incompatible graph');
    const before = tableSql(setup, 'twin_edges');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(
      /inline constraint on subject_kind/
    );
    expect(
      (
        adapter.prepare("SELECT sql FROM sqlite_master WHERE name='twin_edges'").get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM twin_edges').get()).toEqual({ count: 1 });
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    adapter.disconnect();
  });

  it('refuses an extra graph endpoint CHECK before mutating the edge table', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-graph-check-'));
    const dbPath = join(tempDir, 'graph-check.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 73);
    const graphSql = tableSql(setup, 'twin_edges');
    setup.exec('DROP TABLE twin_edges');
    setup.exec(
      graphSql.replace(
        "subject_kind IN ('memory', 'case', 'entity', 'report', 'edge')",
        "subject_kind IN ('memory', 'case', 'entity', 'report', 'edge') AND subject_kind <> 'report'"
      )
    );
    setup
      .prepare('INSERT INTO schema_version(version, description) VALUES (74, ?)')
      .run('extra endpoint check');
    const before = tableSql(setup, 'twin_edges');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/subject_kind/);
    expect(
      (
        adapter.prepare("SELECT sql FROM sqlite_master WHERE name='twin_edges'").get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    adapter.disconnect();
  });

  it('refuses stamped 072 when the observation body XOR is weakened with OR 1', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-observation-or-one-'));
    const dbPath = join(tempDir, 'observation-or-one.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 71);
    const migration = readFileSync(
      join(MIGRATIONS_DIR, '072-observation-versions.sql'),
      'utf8'
    ).replace(
      'OR (body IS NULL AND body_location_json IS NOT NULL))',
      'OR (body IS NULL AND body_location_json IS NOT NULL) OR 1)'
    );
    setup.exec(migration);
    const before = tableSql(setup, 'observation_versions');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/072|observation/i);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='observation_versions'")
          .get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    adapter.disconnect();
  });

  it('refuses stamped 073 without the aggregate authority check and nullable assignment target', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-correction-aggregate-'));
    const dbPath = join(tempDir, 'correction-aggregate.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 72);
    const migration = readFileSync(join(MIGRATIONS_DIR, '073-registry-corrections.sql'), 'utf8')
      .replace(/,\n {2}CHECK \(\n {4}\(origin = 'trusted'[\s\S]*?\n {2}\)\n\);/, '\n);')
      .replace(
        'resolved_node_id TEXT REFERENCES registry_nodes(id)',
        'resolved_node_id TEXT NOT NULL REFERENCES registry_nodes(id)'
      );
    setup.exec(migration);
    const beforeCorrection = tableSql(setup, 'registry_corrections');
    const beforeAssignments = tableSql(setup, 'registry_ref_assignments');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/073|correction/i);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='registry_corrections'")
          .get() as {
          sql: string;
        }
      ).sql
    ).toBe(beforeCorrection);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='registry_ref_assignments'")
          .get() as { sql: string }
      ).sql
    ).toBe(beforeAssignments);
    adapter.disconnect();
  });

  it('refuses stamped 074 with a conflicting table-level subject endpoint check', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-graph-table-check-'));
    const dbPath = join(tempDir, 'graph-table-check.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 73);
    const migration = readFileSync(
      join(MIGRATIONS_DIR, '074-work-graph-ref-kinds.sql'),
      'utf8'
    ).replace(
      'created_at INTEGER NOT NULL\n);',
      "created_at INTEGER NOT NULL,\n  CHECK(subject_kind <> 'observation')\n);"
    );
    setup.exec(migration);
    const before = tableSql(setup, 'twin_edges');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/074|subject_kind/i);
    expect(
      (
        adapter.prepare("SELECT sql FROM sqlite_master WHERE name='twin_edges'").get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    adapter.disconnect();
  });

  it.each([
    [
      'edge_type',
      "edge_type IN ('supersedes','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks'))",
      "edge_type IN ('supersedes','builds_on','debates','synthesizes','mentions','derived_from','case_member','alias_of','next_action_for','blocks') OR 1)",
    ],
    ['source', "source IN ('agent','human','code'))", "source IN ('agent','human','code') OR 1)"],
    [
      'confidence',
      'confidence >= 0.0 AND confidence <= 1.0)',
      'confidence >= 0.0 AND confidence <= 1.0 OR 1)',
    ],
    ['content_hash', 'CHECK(length(content_hash)=32)', 'CHECK(length(content_hash)=32 OR 1)'],
  ])('refuses stamped 074 with weakened %s constraint', (_field, before, after) => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-graph-weakened-'));
    const dbPath = join(tempDir, 'graph-weakened.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 73);
    const migration = readFileSync(
      join(MIGRATIONS_DIR, '074-work-graph-ref-kinds.sql'),
      'utf8'
    ).replace(before, after);
    setup.exec(migration);
    const stored = tableSql(setup, 'twin_edges');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/074|constraint/i);
    expect(
      (
        adapter.prepare("SELECT sql FROM sqlite_master WHERE name='twin_edges'").get() as {
          sql: string;
        }
      ).sql
    ).toBe(stored);
    adapter.disconnect();
  });

  it.each([
    ['wrong type', 'current_observation_id BLOB'],
    ['wrong nullability', "current_observation_id TEXT NOT NULL DEFAULT ''"],
    ['extra inline check', 'current_observation_id TEXT CHECK(length(current_observation_id) > 0)'],
  ])('refuses stamped 072 connector observation ref with %s', (_label, column) => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-observation-ref-shape-'));
    const dbPath = join(tempDir, 'observation-ref-shape.db');
    const setup = new Database(dbPath);
    applyThrough(setup, 71);
    const migration = readFileSync(
      join(MIGRATIONS_DIR, '072-observation-versions.sql'),
      'utf8'
    ).replace('current_observation_id TEXT\n  REFERENCES', `${column}\n  REFERENCES`);
    setup.exec(migration);
    const stored = tableSql(setup, 'connector_event_index');
    setup.close();

    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/072|current_observation_id/i);
    expect(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE name='connector_event_index'")
          .get() as { sql: string }
      ).sql
    ).toBe(stored);
    adapter.disconnect();
  });

  it('keeps the PR3A alias schema and preserves custom graph objects and FK children', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-correction-graph-'));
    const dbPath = join(tempDir, 'correction-graph.db');
    const setup = new Database(dbPath);
    setup.pragma('foreign_keys = ON');
    applyThrough(setup, 73);
    const aliasSql = tableSql(setup, 'registry_aliases');
    setup.exec(`
      CREATE INDEX registry_alias_custom_display ON registry_aliases(alias_display);
      CREATE TABLE registry_alias_audit (alias TEXT);
      CREATE TRIGGER registry_alias_custom_trigger AFTER INSERT ON registry_aliases
        BEGIN INSERT INTO registry_alias_audit VALUES (NEW.alias); END;
      ALTER TABLE registry_corrections
        ADD COLUMN custom_state TEXT CHECK (custom_state IS NULL OR custom_state <> 'bad');
      INSERT INTO registry_corrections
        (command_id,operation,expected_revision,committed_revision,principal_id,agent_id,origin,
         payload_json,reason,evidence_json,scope_json,receipt_json,created_at,custom_state)
        VALUES ('command-kept','add_alias',0,1,'principal','agent','trusted','{}','kept','[]',
          '[]','{}',1,'kept');
      UPDATE registry_identity_state SET revision=1 WHERE singleton=1;
      CREATE UNIQUE INDEX registry_correction_custom_state
        ON registry_corrections(custom_state);
      CREATE TABLE registry_correction_audit (command_id TEXT);
      CREATE TRIGGER registry_correction_custom_trigger AFTER INSERT ON registry_corrections
        BEGIN INSERT INTO registry_correction_audit VALUES (NEW.command_id); END;
      CREATE TABLE registry_correction_child (
        command_id TEXT REFERENCES registry_corrections(command_id) ON DELETE CASCADE
      );
      INSERT INTO registry_correction_child VALUES ('command-kept');
      INSERT INTO twin_edges
        (edge_id,edge_type,subject_kind,subject_id,object_kind,object_id,confidence,source,content_hash,created_at)
        VALUES ('edge-kept','mentions','memory','memory-1','raw','raw-1',1,'code',zeroblob(32),1);
      ALTER TABLE twin_edges ADD COLUMN custom_note TEXT;
      UPDATE twin_edges SET custom_note='kept' WHERE edge_id='edge-kept';
      CREATE INDEX twin_edges_custom_note ON twin_edges(custom_note);
      CREATE TABLE twin_edge_audit (edge_id TEXT);
      CREATE TRIGGER twin_edges_custom_trigger AFTER INSERT ON twin_edges
        BEGIN INSERT INTO twin_edge_audit VALUES (NEW.edge_id); END;
      CREATE TABLE twin_edge_child (
        edge_id TEXT REFERENCES twin_edges(edge_id) ON DELETE CASCADE
      );
      INSERT INTO twin_edge_child VALUES ('edge-kept');
      INSERT INTO schema_version(version, description) VALUES (74, 'partial graph refs');
    `);
    setup.close();

    for (let pass = 0; pass < 2; pass += 1) {
      const adapter = new NodeSQLiteAdapter({ dbPath });
      adapter.connect();
      adapter.runMigrations(MIGRATIONS_DIR);
      adapter.disconnect();
    }

    const db = new Database(dbPath);
    expect(tableSql(db, 'registry_aliases')).toBe(aliasSql);
    expect(indexExists(db, 'registry_alias_custom_display')).toBe(true);
    expect(triggerExists(db, 'registry_alias_custom_trigger')).toBe(true);
    expect(
      db
        .prepare("SELECT custom_state FROM registry_corrections WHERE command_id='command-kept'")
        .get()
    ).toEqual({ custom_state: 'kept' });
    expect(indexExists(db, 'registry_correction_custom_state')).toBe(true);
    expect(triggerExists(db, 'registry_correction_custom_trigger')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM registry_correction_child').get()).toEqual({
      count: 1,
    });
    expect(() =>
      db
        .prepare('UPDATE registry_corrections SET custom_state=? WHERE command_id=?')
        .run('bad', 'command-kept')
    ).toThrow(/constraint/i);
    expect(
      db.prepare("SELECT custom_note FROM twin_edges WHERE edge_id='edge-kept'").get()
    ).toEqual({
      custom_note: 'kept',
    });
    expect(indexExists(db, 'twin_edges_custom_note')).toBe(true);
    expect(triggerExists(db, 'twin_edges_custom_trigger')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM twin_edge_child').get()).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('Story PR3A: adapter cache rollback', () => {
  afterEach(cleanupTempDir);

  it.each(['top-level', 'nested'])(
    'restores vector/topic/status caches after %s rollback',
    (mode) => {
      tempDir = mkdtempSync(join(tmpdir(), 'mama-cache-rollback-'));
      const dbPath = join(tempDir, 'cache.db');
      const adapter = new NodeSQLiteAdapter({ dbPath });
      adapter.connect();
      adapter.runMigrations(MIGRATIONS_DIR);
      const insert = (id: string) =>
        adapter
          .prepare(
            `INSERT INTO decisions
           (id, topic, decision, confidence, status, created_at, updated_at)
           VALUES (?, ?, 'value', 1, 'active', 1, 1)`
          )
          .run(id, id).lastInsertRowid;
      const failing = () => {
        const rowid = Number(insert('rolled-back'));
        adapter.insertEmbedding(rowid, [1, 0]);
        throw new Error('rollback');
      };
      if (mode === 'top-level') {
        expect(() => adapter.transaction(failing)).toThrow('rollback');
        insert('replacement');
      } else {
        adapter.transaction(() => {
          expect(() => adapter.transaction(failing)).toThrow('rollback');
          insert('replacement');
        });
      }
      expect(adapter.vectorSearch([1, 0], 5)).toEqual([]);
      adapter.disconnect();
    }
  );

  it.each([
    ['top-level', 'COMMIT'],
    ['nested', 'RELEASE SAVEPOINT mama_nested_1'],
  ])('restores captured depth once after %s settlement failure', (mode, failingSql) => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-transaction-depth-'));
    const adapter = new NodeSQLiteAdapter({ dbPath: join(tempDir, 'depth.db') });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    const originalExec = adapter.exec.bind(adapter);
    const commands: string[] = [];
    let shouldFail = true;
    adapter.exec = (sql: string) => {
      commands.push(sql);
      if (shouldFail && sql === failingSql) {
        shouldFail = false;
        throw new Error('synthetic settlement failure');
      }
      originalExec(sql);
    };
    if (mode === 'top-level') {
      expect(() => adapter.transaction(() => undefined)).toThrow('synthetic settlement failure');
    } else {
      adapter.transaction(() => {
        expect(() => adapter.transaction(() => undefined)).toThrow('synthetic settlement failure');
      });
    }
    adapter.transaction(() => undefined);
    expect(commands.at(-2)).toBe('BEGIN TRANSACTION');
    expect(commands.at(-1)).toBe('COMMIT');
    adapter.disconnect();
  });

  it.each([
    ['top-level', 'COMMIT'],
    ['nested', 'RELEASE SAVEPOINT mama_nested_1'],
  ])('poisons the adapter when %s settlement succeeds but cleanup fails', (mode, settlementSql) => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-transaction-poison-'));
    const adapter = new NodeSQLiteAdapter({ dbPath: join(tempDir, 'poison.db') });
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    const originalExec = adapter.exec.bind(adapter);
    let throwAfterSettlement = true;
    adapter.exec = (sql: string) => {
      originalExec(sql);
      if (throwAfterSettlement && sql === settlementSql) {
        throwAfterSettlement = false;
        throw new Error('wrapper failed after settlement');
      }
    };
    const run = () => {
      if (mode === 'top-level') {
        adapter.transaction(() => undefined);
      } else {
        adapter.transaction(() => adapter.transaction(() => undefined));
      }
    };
    let failure: unknown;
    try {
      run();
    } catch (error) {
      failure = error;
    }
    const failureMessages = (error: unknown): string[] => {
      if (error instanceof AggregateError) {
        return error.errors.flatMap(failureMessages);
      }
      return [error instanceof Error ? error.message : String(error)];
    };
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failureMessages(failure)).toContain('wrapper failed after settlement');
    expect(failureMessages(failure).length).toBeGreaterThan(1);
    expect(adapter.isConnected()).toBe(false);
    expect(() => adapter.transaction(() => undefined)).toThrow('Database not connected');
  });
});

describe('Story M2.3: Migration 034 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial connector event scope migration recovery', () => {
      it('repairs a partially applied 034 migration when source_cursor already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-034-'));
        const dbPath = join(tempDir, 'partial-034.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 33);
        setupDb.exec('ALTER TABLE connector_event_index ADD COLUMN source_cursor TEXT');
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        for (const column of [
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
        ]) {
          expect(columnExists(db, 'connector_event_index', column)).toBe(true);
        }
        expect(indexExists(db, 'idx_connector_event_scope')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 34').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(34);
        db.close();
      });
    });
  });
});

describe('Story M2.4: Migration 039 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial connector operator sequence migration recovery', () => {
      it('repairs a partially applied 039 migration when operator_ingest_seq already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-039-'));
        const dbPath = join(tempDir, 'partial-039.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 38);
        setupDb.exec(`
          ALTER TABLE connector_event_index
            ADD COLUMN operator_ingest_seq INTEGER CHECK (
              operator_ingest_seq IS NULL OR operator_ingest_seq >= 1
            )
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        expect(columnExists(db, 'connector_event_index', 'operator_ingest_seq')).toBe(true);
        expect(tableExists(db, 'connector_event_index_operator_seq_cursors')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_scope_seq')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_cursor_order')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_ai')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_explicit_ai')).toBe(
          true
        );

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 39').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(39);
        db.close();
      });
    });
  });
});

describe('Story M2.5: Migration 062 duplicate-column recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: partial connector observation sequence migration recovery', () => {
      it('repairs a partially applied 062 migration when operator_observation_seq already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-062-'));
        const dbPath = join(tempDir, 'partial-062.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 61);
        setupDb.exec(`
          ALTER TABLE connector_event_index
            ADD COLUMN operator_observation_seq INTEGER CHECK (
              operator_observation_seq IS NULL OR operator_observation_seq >= 1
            )
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        expect(columnExists(db, 'connector_event_index', 'operator_observation_seq')).toBe(true);
        expect(tableExists(db, 'connector_event_index_observation_cursors')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_observation_seq')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_au')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_observation_seq_ai')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_observation_seq_au')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_observation_seq_explicit_ai')).toBe(
          true
        );

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 62').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(62);
        db.close();
      });

      it('repairs migration 062 when the observation cursor table already exists', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-062-cursor-'));
        const dbPath = join(tempDir, 'partial-062-cursor.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 61);
        setupDb
          .prepare(
            `INSERT INTO connector_event_index (
              event_index_id, source_connector, source_type, source_id, content,
              source_timestamp_ms, metadata_json, content_hash, indexed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'evt-partial-cursor',
            'kagemusha',
            'kanban_card',
            'task:partial-cursor',
            'pending',
            1_775_260_800_000,
            '{}',
            Buffer.alloc(32, 14),
            '2026-08-02T00:00:00.000Z',
            '2026-08-02T00:00:00.000Z'
          );
        setupDb.exec(`
          CREATE TABLE connector_event_index_observation_cursors (
            source_connector TEXT PRIMARY KEY,
            next_seq INTEGER NOT NULL CHECK (next_seq >= 1)
          );
          INSERT INTO connector_event_index_observation_cursors (source_connector, next_seq)
          VALUES ('kagemusha', 7)
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        expect(() => {
          adapter.connect();
          adapter.runMigrations(MIGRATIONS_DIR);
        }).not.toThrow();
        adapter.disconnect();

        const db = new Database(dbPath);
        expect(columnExists(db, 'connector_event_index', 'operator_observation_seq')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_observation_seq')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_observation_seq_ai')).toBe(true);
        expect(
          db
            .prepare(
              `SELECT next_seq FROM connector_event_index_observation_cursors
               WHERE source_connector = 'kagemusha'`
            )
            .get()
        ).toEqual({ next_seq: 7 });
        expect(
          db.prepare('SELECT version FROM schema_version WHERE version = 62').get()
        ).toMatchObject({ version: 62 });
        db.close();
      });

      it('preserves arrival-ordered observation ordinals while repairing a missing 062 trigger', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-062-ordering-'));
        const dbPath = join(tempDir, 'partial-062-ordering.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        applyThrough(setupDb, 62);

        const insert = setupDb.prepare(
          `INSERT INTO connector_event_index (
            event_index_id, source_connector, source_type, source_id, content,
            source_timestamp_ms, metadata_json, content_hash, indexed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        insert.run(
          'evt-arrival-first',
          'kagemusha',
          'kanban_card',
          'task:arrival-first',
          'arrived first with a later timestamp',
          2,
          '{}',
          Buffer.alloc(32, 1),
          '2026-08-02T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z'
        );
        insert.run(
          'evt-arrival-second',
          'kagemusha',
          'kanban_card',
          'task:arrival-second',
          'arrived second with an earlier timestamp',
          1,
          '{}',
          Buffer.alloc(32, 2),
          '2026-08-02T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z'
        );
        setupDb.exec('DROP TRIGGER trg_connector_event_index_observation_seq_ai');
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        expect(() => {
          adapter.connect();
          adapter.runMigrations(MIGRATIONS_DIR);
        }).not.toThrow();
        adapter.disconnect();

        const db = new Database(dbPath);
        expect(
          db
            .prepare(
              `SELECT event_index_id, operator_observation_seq
               FROM connector_event_index
               WHERE source_connector = 'kagemusha'
               ORDER BY event_index_id`
            )
            .all()
        ).toEqual([
          { event_index_id: 'evt-arrival-first', operator_observation_seq: 1 },
          { event_index_id: 'evt-arrival-second', operator_observation_seq: 2 },
        ]);
        expect(
          db
            .prepare(
              `SELECT next_seq
               FROM connector_event_index_observation_cursors
               WHERE source_connector = 'kagemusha'`
            )
            .get()
        ).toEqual({ next_seq: 3 });
        db.close();
      });
    });
  });
});

describe('Story M2.4: Legacy high schema-version structural recovery', () => {
  afterEach(cleanupTempDir);

  describe('Acceptance Criteria', () => {
    describe('AC #1: skipped feature migrations', () => {
      it('repairs provenance and connector structures when legacy schema_version is already newer', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-high-version-'));
        const dbPath = join(tempDir, 'legacy-high-version.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (58, 'Legacy branch migration ahead of provenance migrations');

          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE connector_event_index (
            event_index_id TEXT PRIMARY KEY,
            source_connector TEXT NOT NULL,
            channel TEXT
          );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        for (const table of [
          'model_runs',
          'tool_traces',
          'twin_edges',
          'agent_situation_packets',
          'agent_situation_refresh_leases',
          'context_packets',
          'vnext_operator_cursors',
          'vnext_operator_commits',
          'operator_no_updates',
          'worker_proposals',
          'operator_memory_commit_intents',
        ]) {
          expect(tableExists(db, table)).toBe(true);
        }
        for (const column of [
          'agent_id',
          'model_run_id',
          'envelope_hash',
          'gateway_call_id',
          'source_refs_json',
          'provenance_json',
        ]) {
          expect(columnExists(db, 'decisions', column)).toBe(true);
        }
        for (const column of [
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
          'operator_ingest_seq',
        ]) {
          expect(columnExists(db, 'connector_event_index', column)).toBe(true);
        }
        expect(tableExists(db, 'connector_event_index_operator_seq_cursors')).toBe(true);
        expect(indexExists(db, 'idx_model_runs_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_tool_traces_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_decisions_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_decisions_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_decisions_gateway_call_id')).toBe(true);
        expect(indexExists(db, 'idx_memory_events_memory_created')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_source_cursor')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_scope_seq')).toBe(true);
        expect(indexExists(db, 'idx_connector_event_index_operator_cursor_order')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_ai')).toBe(true);
        expect(triggerExists(db, 'trg_connector_event_index_operator_ingest_seq_explicit_ai')).toBe(
          true
        );
        expect(indexExists(db, 'idx_context_packets_scope_hash')).toBe(true);
        expect(indexExists(db, 'idx_vnext_operator_commits_cursor_seq')).toBe(true);
        expect(indexExists(db, 'idx_operator_no_updates_scope_created')).toBe(true);
        expect(indexExists(db, 'idx_worker_proposals_status_kind')).toBe(true);
        expect(indexExists(db, 'idx_operator_memory_commit_intents_cursor_created')).toBe(true);

        const row = db.prepare('SELECT version FROM schema_version WHERE version = 38').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(38);
        const operatorSeqRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 39')
          .get() as { version: number } | undefined;
        expect(operatorSeqRow?.version).toBe(39);
        const memoryIntentRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 40')
          .get() as { version: number } | undefined;
        expect(memoryIntentRow?.version).toBe(40);
        const memoryIntentClaimRow = db
          .prepare('SELECT version FROM schema_version WHERE version = 41')
          .get() as { version: number } | undefined;
        expect(memoryIntentClaimRow?.version).toBe(41);
        db.close();
      });

      it('upgrades existing migration 040 intent tables with the claim invariant', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-upgrade-040-'));
        const dbPath = join(tempDir, 'upgrade-040.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (40, 'Create operator memory commit intents');

          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );

          CREATE TABLE operator_memory_commit_intents (
            intent_id TEXT PRIMARY KEY,
            cursor_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
            memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
            memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
            source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
            status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
            claim_token TEXT,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
          );
          CREATE INDEX idx_operator_memory_commit_intents_cursor_created
            ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);

          INSERT INTO operator_memory_commit_intents (
            intent_id, cursor_name, idempotency_key, expected_memory_count,
            memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token,
            created_at_ms, updated_at_ms
          )
          VALUES
            (
              'intent:legacy-saving-without-claim',
              'connector:slack:channel:C_PUBLIC_SYNTHETIC',
              'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
              1,
              'sha256:legacy-saving-without-claim',
              '[null]',
              '["raw:slack:synthetic-event-index-id"]',
              'saving',
              NULL,
              1710000000000,
              1710000000000
            ),
            (
              'intent:legacy-pending-with-claim',
              'connector:slack:channel:C_PUBLIC_SYNTHETIC',
              'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
              1,
              'sha256:legacy-pending-with-claim',
              '[null]',
              '["raw:slack:synthetic-event-index-id"]',
              'pending',
              'claim:legacy',
              1710000000000,
              1710000000000
            );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();

        const db = new Database(dbPath);
        const sql = tableSql(db, 'operator_memory_commit_intents');
        expect(sql).toContain("(status = 'saving' AND claim_token IS NOT NULL)");
        expect(sql).toContain("(status != 'saving' AND claim_token IS NULL)");
        expect(
          db
            .prepare(
              `SELECT status, claim_token
               FROM operator_memory_commit_intents
               WHERE intent_id = 'intent:legacy-saving-without-claim'`
            )
            .get()
        ).toEqual({ status: 'pending', claim_token: null });
        expect(
          db
            .prepare(
              `SELECT status, claim_token
               FROM operator_memory_commit_intents
               WHERE intent_id = 'intent:legacy-pending-with-claim'`
            )
            .get()
        ).toEqual({ status: 'pending', claim_token: null });
        const row = db.prepare('SELECT version FROM schema_version WHERE version = 41').get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(41);
        db.close();
      });

      it('rejects partial operator memory intent tables when schema_version is already newer', () => {
        tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-partial-040-'));
        const dbPath = join(tempDir, 'partial-040.db');
        const setupDb = new Database(dbPath);
        setupDb.pragma('foreign_keys = ON');
        setupDb.exec(`
          CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            description TEXT
          );
          INSERT INTO schema_version (version, description)
          VALUES (58, 'Legacy branch migration ahead of operator memory intents');

          CREATE TABLE embeddings (
            rowid INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL
          );
          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL
          );
          CREATE TABLE memory_events (
            id INTEGER PRIMARY KEY,
            memory_id TEXT NOT NULL,
            topic TEXT,
            created_at INTEGER NOT NULL
          );

          CREATE TABLE operator_memory_commit_intents (
            intent_id TEXT PRIMARY KEY,
            cursor_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            expected_memory_count INTEGER NOT NULL,
            memory_payload_hash TEXT NOT NULL,
            memory_ids_json TEXT NOT NULL,
            source_refs_json TEXT NOT NULL,
            status TEXT NOT NULL,
            claim_token TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
        `);
        setupDb.close();

        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(
          /incompatible operator_memory_commit_intents table definition/i
        );
        adapter.disconnect();
      });
    });
  });
});

describe('TG-03/04/05: migration 068 runtime scope overlap recovery', () => {
  afterEach(cleanupTempDir);

  it('rolls back added columns and does not stamp 68 when index reconciliation fails', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-068-atomic-'));
    const dbPath = join(tempDir, 'runtime-068.db');
    const setupDb = new Database(dbPath);
    applyThrough(setupDb, 67);
    setupDb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(67);
    setupDb.exec('ALTER TABLE tool_traces ADD COLUMN project_id TEXT');
    setupDb.exec('ALTER TABLE tool_traces ADD COLUMN channel_id TEXT');
    setupDb.exec('CREATE TABLE idx_tool_traces_scope_recency (blocked TEXT)');
    setupDb.close();
    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow();
    adapter.disconnect();
    const db = new Database(dbPath);
    expect(columnExists(db, 'tool_traces', 'diagnostic_json')).toBe(false);
    expect(columnExists(db, 'tool_traces', 'project_id')).toBe(true);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
      version: 67,
    });
    db.close();
  });

  for (const alreadyStamped of [false, true]) {
    it(`reconciles existing MetricsStore columns with schema 68 stamped=${alreadyStamped}`, () => {
      tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-068-'));
      const dbPath = join(tempDir, 'runtime-068.db');
      const setupDb = new Database(dbPath);
      applyThrough(setupDb, 67);
      setupDb.exec('ALTER TABLE tool_traces ADD COLUMN project_id TEXT');
      setupDb.exec('ALTER TABLE tool_traces ADD COLUMN channel_id TEXT');
      setupDb
        .prepare('INSERT INTO schema_version (version) VALUES (?)')
        .run(alreadyStamped ? 68 : 67);
      setupDb
        .prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)')
        .run('existing-run', 'legacy', 1);
      setupDb
        .prepare(
          'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, project_id, channel_id, input_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          'existing-trace',
          'existing-run',
          'example',
          'existing-project',
          'existing-channel',
          'preserved summary',
          2
        );
      setupDb.close();

      for (let pass = 0; pass < 2; pass++) {
        const adapter = new NodeSQLiteAdapter({ dbPath });
        adapter.connect();
        adapter.runMigrations(MIGRATIONS_DIR);
        adapter.disconnect();
      }
      const db = new Database(dbPath);
      for (const column of [
        'diagnostic_json',
        'evidence_json',
        'catalog_revision',
        'owner_scope',
        'project_id',
        'channel_id',
      ]) {
        expect(columnExists(db, 'tool_traces', column)).toBe(true);
      }
      expect(indexExists(db, 'idx_tool_traces_scope_recency')).toBe(true);
      expect(indexExists(db, 'idx_tool_traces_channel_recency')).toBe(true);
      expect(
        db
          .prepare(
            'SELECT project_id, channel_id, input_summary, owner_scope, evidence_json FROM tool_traces WHERE trace_id = ?'
          )
          .get('existing-trace')
      ).toEqual({
        project_id: 'existing-project',
        channel_id: 'existing-channel',
        input_summary: 'preserved summary',
        owner_scope: null,
        evidence_json: null,
      });
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: 74,
      });
      db.close();
    });
  }

  // A database stamped 68 but missing the 068 diagnostic columns is a legacy
  // recovery state the runner must still carry all the way to the 071
  // operation-origin shape. The main loop skips version 68 (already stamped) and
  // reaches the in-loop 071 branch first, so the 068 prerequisite must be
  // repaired before the 071 rebuild. This pins that the partial-068 path reaches
  // the real 071 shape and preserves the row through two opens — merely skipping
  // 071 (or silently swallowing its failure) would make this red.
  it('partial-068 stamp still reaches the 071 operation-origin shape', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-migration-068-to-071-'));
    const dbPath = join(tempDir, 'runtime-068.db');
    const setupDb = new Database(dbPath);
    applyThrough(setupDb, 67);
    setupDb.exec('ALTER TABLE tool_traces ADD COLUMN project_id TEXT');
    setupDb.exec('ALTER TABLE tool_traces ADD COLUMN channel_id TEXT');
    setupDb.prepare('INSERT INTO schema_version (version) VALUES (?)').run(68);
    setupDb
      .prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)')
      .run('existing-run', 'legacy', 1);
    setupDb
      .prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, project_id, channel_id, input_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'existing-trace',
        'existing-run',
        'example',
        'existing-project',
        'existing-channel',
        'preserved summary',
        2
      );
    setupDb.close();

    for (let pass = 0; pass < 2; pass++) {
      const adapter = new NodeSQLiteAdapter({ dbPath });
      adapter.connect();
      adapter.runMigrations(MIGRATIONS_DIR);
      adapter.disconnect();
    }

    const db = new Database(dbPath);
    // The 071 origin columns must actually exist (skipping 071 leaves them out).
    expect(columnExists(db, 'tool_traces', 'operation_id')).toBe(true);
    expect(columnExists(db, 'tool_traces', 'actor_principal_id')).toBe(true);
    // model_run_id must be relaxed to nullable by the 071 rebuild.
    const modelRunColumn = (
      db.prepare('PRAGMA table_info(tool_traces)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === 'model_run_id');
    expect(modelRunColumn?.notnull).toBe(0);
    // The original row and its values survive the 068 repair + 071 rebuild.
    expect(
      db
        .prepare(
          'SELECT model_run_id, project_id, channel_id, input_summary, operation_id, actor_principal_id FROM tool_traces WHERE trace_id = ?'
        )
        .get('existing-trace')
    ).toEqual({
      model_run_id: 'existing-run',
      project_id: 'existing-project',
      channel_id: 'existing-channel',
      input_summary: 'preserved summary',
      operation_id: null,
      actor_principal_id: null,
    });
    const stamped = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number;
    };
    expect(stamped.version).toBeGreaterThanOrEqual(71);
    db.close();
  });
});
