/**
 * T0.A: a truthful service/CLI operation can trace itself without a model run.
 *
 * Covers migration 071 on fresh and populated DBs (including an extra runtime
 * column + index a live database may carry), operation-origin append/list/scope
 * exclusion, the at-least-one-origin CHECK, the preserved legacy model path, and
 * a failed rebuild that rolls back without stamping a success version.
 *
 * Uses real migrations, the real DatabaseAdapter, and the real store - no mocks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { beginModelRun } from '../../src/model-runs/store.js';
import {
  appendToolTrace,
  appendOperationToolTrace,
  appendOperationToolTraceInAdapter,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
} from '../../src/model-runs/tool-trace-store.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const TEST_DB = join(os.tmpdir(), `test-tool-trace-origin-${randomUUID()}.db`);
const adapterDbPaths: string[] = [];

function cleanupDb(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${path}${suffix}`);
    } catch {
      // best effort
    }
  }
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, '').toLowerCase();
}

/** Build a real pre-071 database (schema stops at 070) with FK enforcement on. */
function seedPre071(path: string, seed: (db: Database.Database) => void): void {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  for (const file of migrationFiles().filter(
    (file) => Number.parseInt(file.slice(0, 3), 10) < 71
  )) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  seed(db);
  db.close();
}

function openAdapter(path: string): NodeSQLiteAdapter {
  adapterDbPaths.push(path);
  const adapter = new NodeSQLiteAdapter({ dbPath: path });
  adapter.connect();
  return adapter;
}

function columnInfo(
  db: { prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] } },
  table: string
): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function indexExists(
  db: { prepare: (sql: string) => { get: (...p: unknown[]) => unknown } },
  name: string
): boolean {
  return Boolean(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(name) as
        | { name?: string }
        | undefined
    )?.name
  );
}

describe('migration 071: operation-origin tool traces', () => {
  afterEach(() => {
    for (const path of adapterDbPaths.splice(0)) {
      cleanupDb(path);
    }
  });

  it('a fresh migration relaxes model_run_id, adds the origin columns, indexes and CHECK', () => {
    const path = join(os.tmpdir(), `test-071-fresh-${randomUUID()}.db`);
    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);

    const cols = columnInfo(adapter, 'tool_traces');
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has('operation_id')).toBe(true);
    expect(byName.has('actor_principal_id')).toBe(true);
    expect(byName.get('model_run_id')?.notnull).toBe(0);
    expect(indexExists(adapter, 'idx_tool_traces_operation_id')).toBe(true);
    // Legacy indexes survive the rebuild.
    expect(indexExists(adapter, 'idx_tool_traces_model_run_id')).toBe(true);
    expect(indexExists(adapter, 'idx_tool_traces_scope_recency')).toBe(true);
    expect(
      (
        adapter.prepare('SELECT version FROM schema_version WHERE version = 71').get() as
          | { version?: number }
          | undefined
      )?.version
    ).toBe(71);

    // The origin CHECK rejects a row with neither a model run nor an operation.
    expect(() =>
      adapter
        .prepare('INSERT INTO tool_traces (trace_id, tool_name, created_at) VALUES (?, ?, ?)')
        .run('no-origin', 'x', 1)
    ).toThrow(/constraint/i);
    adapter
      .prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)')
      .run('run-model', 'committed', 1);
    for (const [operationId, actorId] of [
      ['op:partial', null],
      ['op:partial', ''],
      [null, 'actor:partial'],
    ]) {
      expect(() =>
        adapter
          .prepare(
            `INSERT INTO tool_traces
             (trace_id, model_run_id, operation_id, actor_principal_id, tool_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            `invalid-${String(operationId)}-${String(actorId)}`,
            'run-model',
            operationId,
            actorId,
            'x',
            2
          )
      ).toThrow(/constraint/i);
    }

    adapter.disconnect();
  });

  it('running the migration twice is a no-op and never rebuilds a complete table', () => {
    const path = join(os.tmpdir(), `test-071-twice-${randomUUID()}.db`);
    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);
    const sqlBefore = (
      adapter
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'")
        .get() as { sql: string }
    ).sql;
    adapter.runMigrations(MIGRATIONS_DIR);
    const sqlAfter = (
      adapter
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'")
        .get() as { sql: string }
    ).sql;
    expect(sqlAfter).toBe(sqlBefore);
    adapter.disconnect();
  });

  it('a populated legacy table keeps its rows, extra runtime column and extra index', () => {
    const path = join(os.tmpdir(), `test-071-populated-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-legacy',
        'committed',
        1
      );
      // A column and index a runtime MetricsStore might have added out-of-band.
      db.exec('ALTER TABLE tool_traces ADD COLUMN runtime_note TEXT');
      db.exec('CREATE INDEX idx_tool_traces_runtime_note ON tool_traces(runtime_note)');
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, created_at, runtime_note) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('t-legacy', 'mr-legacy', 'legacy_tool', 'kept', 2, 'note-kept');
      // model_run_id was NOT NULL before 071.
      expect(columnInfo(db, 'tool_traces').find((c) => c.name === 'model_run_id')?.notnull).toBe(1);
    });

    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);

    const cols = columnInfo(adapter, 'tool_traces');
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('model_run_id')?.notnull).toBe(0);
    expect(byName.has('operation_id')).toBe(true);
    expect(byName.has('runtime_note')).toBe(true);
    expect(indexExists(adapter, 'idx_tool_traces_runtime_note')).toBe(true);
    expect(indexExists(adapter, 'idx_tool_traces_operation_id')).toBe(true);

    expect(
      adapter
        .prepare(
          'SELECT model_run_id, input_summary, runtime_note FROM tool_traces WHERE trace_id = ?'
        )
        .get('t-legacy')
    ).toEqual({ model_run_id: 'mr-legacy', input_summary: 'kept', runtime_note: 'note-kept' });
    expect(adapter.prepare('PRAGMA foreign_key_check(tool_traces)').all()).toEqual([]);
    adapter.disconnect();
  });

  it('a failed rebuild rolls back and never stamps version 71', () => {
    const path = join(os.tmpdir(), `test-071-fail-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-real',
        'committed',
        1
      );
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('t-real', 'mr-real', 'real_tool', 2);
      // A dangling FK, insertable only with enforcement off. The 071 rebuild
      // disables FK before BEGIN (so the DROP TABLE cannot CASCADE), rebuilds,
      // then runs foreign_key_check over the relevant FK graph; the dangling row
      // is detected there and forces a rollback of the whole reconcile transaction.
      db.pragma('foreign_keys = OFF');
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('t-ghost', 'mr-ghost', 'ghost_tool', 3);
    });

    const adapter = openAdapter(path);
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow();
    // No success stamp, and the pre-071 shape (model_run_id NOT NULL, no
    // operation_id) is intact - the rebuild left nothing partial behind.
    expect(
      adapter.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    const cols = columnInfo(adapter, 'tool_traces');
    expect(cols.find((c) => c.name === 'model_run_id')?.notnull).toBe(1);
    expect(cols.some((c) => c.name === 'operation_id')).toBe(false);
    expect(
      (adapter.prepare('SELECT COUNT(*) AS n FROM tool_traces').get() as { n: number }).n
    ).toBe(2);
    // FK enforcement is restored to its prior ON state even though the rebuild
    // rolled back (the toggle lives in a finally, not the transaction).
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    adapter.disconnect();
  });

  it('preserves a CASCADE child, full column constraints/default and triggers, and restores FK state', () => {
    const path = join(os.tmpdir(), `test-071-preserve-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      // Exactly the parent controller reproduction: an extra runtime column with
      // NOT NULL + DEFAULT, an ON DELETE CASCADE child, and a custom trigger.
      db.exec(
        "ALTER TABLE tool_traces ADD COLUMN runtime_note TEXT NOT NULL DEFAULT 'retained-default'"
      );
      db.exec(
        'CREATE TABLE trace_child (id TEXT PRIMARY KEY, trace_id TEXT REFERENCES tool_traces(trace_id) ON DELETE CASCADE)'
      );
      db.exec('CREATE TABLE trace_insert_audit (trace_id TEXT)');
      db.exec(
        'CREATE TRIGGER extra_trace_insert_audit AFTER INSERT ON tool_traces BEGIN INSERT INTO trace_insert_audit VALUES(NEW.trace_id); END'
      );
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-keep',
        'committed',
        1
      );
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at, runtime_note) VALUES (?, ?, ?, ?, ?)'
      ).run('t-keep', 'mr-keep', 'probe', 2, 'note-value');
      db.prepare('INSERT INTO trace_child (id, trace_id) VALUES (?, ?)').run(
        'child-keep',
        't-keep'
      );
    });

    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);

    // The CASCADE child was NOT deleted by the DROP TABLE (FK disabled first).
    expect(
      (adapter.prepare('SELECT COUNT(*) AS n FROM trace_child').get() as { n: number }).n
    ).toBe(1);
    // The extra column keeps its NOT NULL and its DEFAULT (next-write behavior),
    // not just its stored value.
    const runtimeNote = (
      adapter.prepare('PRAGMA table_info(tool_traces)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>
    ).find((c) => c.name === 'runtime_note');
    expect(runtimeNote?.notnull).toBe(1);
    expect(runtimeNote?.dflt_value).toBe("'retained-default'");
    // The custom trigger survives; the origin CHECK still lets model rows in.
    expect(indexExists(adapter, 'idx_tool_traces_operation_id')).toBe(true);
    expect(
      Boolean(
        adapter
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='extra_trace_insert_audit'"
          )
          .get()
      )
    ).toBe(true);
    expect(adapter.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // FK enforcement is restored to ON after a successful rebuild.
    expect(
      (adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    ).toBe(1);
    adapter.disconnect();
  });

  it('migrates a populated table carrying quoted columns (space, embedded quote, reserved word)', () => {
    const path = join(os.tmpdir(), `test-071-quoted-cols-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      // Three valid SQLite identifiers that MUST be emitted quoted in the
      // rebuild's INSERT/SELECT column list or they parse as bare tokens and
      // abort the migration (the exact F2-Q production reproduction).
      db.exec(
        'ALTER TABLE tool_traces ADD COLUMN "runtime note" TEXT NOT NULL DEFAULT \'kept-space\''
      );
      db.exec(
        'ALTER TABLE tool_traces ADD COLUMN "runtime ""q"" note" TEXT DEFAULT \'kept-quote\''
      );
      db.exec('ALTER TABLE tool_traces ADD COLUMN "select" TEXT DEFAULT \'kept-reserved\'');
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-q',
        'committed',
        1
      );
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at, "runtime note", "runtime ""q"" note", "select") VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('t-q', 'mr-q', 'probe', 2, 'space-val', 'quote-val', 'reserved-val');
    });

    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);

    const names = new Set(columnInfo(adapter, 'tool_traces').map((c) => c.name));
    expect(names.has('runtime note')).toBe(true);
    expect(names.has('runtime "q" note')).toBe(true);
    expect(names.has('select')).toBe(true);
    expect(names.has('operation_id')).toBe(true);
    // Row data for every quoted column was carried across the rebuild verbatim.
    expect(
      adapter
        .prepare(
          'SELECT "runtime note" AS a, "runtime ""q"" note" AS b, "select" AS c FROM tool_traces WHERE trace_id = ?'
        )
        .get('t-q')
    ).toEqual({ a: 'space-val', b: 'quote-val', c: 'reserved-val' });
    // The NOT NULL + DEFAULT on the space-named column is preserved (next-write).
    const spaceCol = (
      adapter.prepare('PRAGMA table_info(tool_traces)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
      }>
    ).find((c) => c.name === 'runtime note');
    expect(spaceCol?.notnull).toBe(1);
    expect(spaceCol?.dflt_value).toBe("'kept-space'");
    expect(
      (
        adapter.prepare('SELECT version FROM schema_version WHERE version = 71').get() as
          | { version?: number }
          | undefined
      )?.version
    ).toBe(71);
    adapter.disconnect();
  });

  it('inspects a quoted-name child table in the FK graph and aborts on its dangling reference', () => {
    const path = join(os.tmpdir(), `test-071-quoted-child-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      // A referencing child whose table name needs quoting. The FK-graph helper
      // must still inspect it (an identifier regex would skip it) so its dangling
      // reference is caught and the whole rebuild rolls back.
      db.exec(
        'CREATE TABLE "trace child" (id TEXT PRIMARY KEY, trace_id TEXT REFERENCES tool_traces(trace_id) ON DELETE CASCADE)'
      );
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-qc',
        'committed',
        1
      );
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('t-qc', 'mr-qc', 'probe', 2);
      // A dangling child row, insertable only with enforcement off. If the quoted
      // child were skipped by the graph check, this violation would pass unnoticed.
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO "trace child" (id, trace_id) VALUES (?, ?)').run(
        'orphan',
        't-missing'
      );
    });

    const adapter = openAdapter(path);
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).toThrow(/foreign key violations/i);
    // Rolled back: no version 71 stamp, pre-071 shape intact.
    expect(
      adapter.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    expect(columnInfo(adapter, 'tool_traces').some((c) => c.name === 'operation_id')).toBe(false);
    adapter.disconnect();
  });

  it('preserves already-present operation origin values and repairs a weak both-null CHECK', () => {
    const path = join(os.tmpdir(), `test-071-partial-${randomUUID()}.db`);
    seedPre071(path, (db) => {
      db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
        'mr-dual',
        'committed',
        1
      );
      // A partially-repaired table: origin columns already exist and model_run_id
      // is nullable, but the CHECK is WEAKENED to accept a both-null origin. The
      // stronger shape verification must reject it and rebuild - without dropping
      // the real operation_id/actor_principal_id values already stored.
      db.exec('DROP TABLE tool_traces');
      db.exec(`CREATE TABLE tool_traces (
        trace_id TEXT PRIMARY KEY,
        model_run_id TEXT,
        gateway_call_id TEXT,
        tool_name TEXT NOT NULL,
        input_summary TEXT,
        output_summary TEXT,
        execution_status TEXT,
        duration_ms INTEGER DEFAULT 0,
        envelope_hash TEXT,
        created_at INTEGER NOT NULL,
        failure_code TEXT,
        diagnostic_json TEXT,
        evidence_json TEXT,
        catalog_revision TEXT,
        owner_scope TEXT,
        project_id TEXT,
        channel_id TEXT,
        operation_id TEXT,
        actor_principal_id TEXT,
        CHECK (model_run_id IS NOT NULL OR 1),
        FOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)
      )`);
      // dual-origin row (real model run AND operation origin) + operation-only row.
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, operation_id, actor_principal_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('t-dual', 'mr-dual', 'op:dual', 'owner:runtime', 'x', 2);
      db.prepare(
        'INSERT INTO tool_traces (trace_id, model_run_id, operation_id, actor_principal_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('t-op', null, 'op:only', 'owner:runtime', 'y', 3);
      // Stamp 71 so the runner skips the loop and the repair pass must self-heal.
      db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(
        71,
        'weak pre-existing shape'
      );
    });

    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);

    // Both origin values were carried across the rebuild - never dropped.
    expect(
      adapter
        .prepare(
          'SELECT model_run_id, operation_id, actor_principal_id FROM tool_traces WHERE trace_id = ?'
        )
        .get('t-dual')
    ).toEqual({
      model_run_id: 'mr-dual',
      operation_id: 'op:dual',
      actor_principal_id: 'owner:runtime',
    });
    expect(
      adapter
        .prepare(
          'SELECT model_run_id, operation_id, actor_principal_id FROM tool_traces WHERE trace_id = ?'
        )
        .get('t-op')
    ).toEqual({ model_run_id: null, operation_id: 'op:only', actor_principal_id: 'owner:runtime' });
    // The invariant is re-established: a both-null-origin row is now refused,
    // where the weak CHECK previously admitted it.
    expect(() =>
      adapter
        .prepare('INSERT INTO tool_traces (trace_id, tool_name, created_at) VALUES (?, ?, ?)')
        .run('now-rejected', 'x', 4)
    ).toThrow(/constraint/i);
    adapter.disconnect();
  });
});

describe('operation-origin store append/list/scope', () => {
  const scope = { owner_scope: 'owner:runtime', project_id: 'project-op' };
  beforeEach(async () => {
    await closeDB();
    cleanupDb(TEST_DB);
    process.env.MAMA_DB_PATH = TEST_DB;
  });
  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    cleanupDb(TEST_DB);
  });

  it('appends a NULL-model operation trace surfaced only through its scope', async () => {
    const scoped = await appendOperationToolTrace({
      operation_id: 'op:source.search:1',
      actor_principal_id: 'owner:runtime',
      tool_name: 'source_search',
      ...scope,
      channel_id: 'channel-op',
      input_summary: 'op input',
      evidence_json: '{"result":"observed"}',
    });
    expect(scoped.model_run_id).toBeNull();
    expect(scoped.operation_id).toBe('op:source.search:1');
    expect(scoped.actor_principal_id).toBe('owner:runtime');

    // Read back exactly through the same host-derived scope.
    expect(await readToolTrace(scoped.trace_id, scope)).toEqual(scoped);
    expect((await listToolTraces(scope)).traces.map((t) => t.trace_id)).toContain(scoped.trace_id);
    // A per-run listing never returns an operation-origin row.
    expect(await listToolTracesForRun('op:source.search:1')).toEqual([]);

    // An unscoped operation trace is excluded from scoped discovery.
    const unscoped = await appendOperationToolTrace({
      operation_id: 'op:unscoped:1',
      actor_principal_id: 'owner:runtime',
      tool_name: 'source_search',
    });
    expect(unscoped.model_run_id).toBeNull();
    expect((await listToolTraces(scope)).traces.map((t) => t.trace_id)).not.toContain(
      unscoped.trace_id
    );
    expect(await readToolTrace(unscoped.trace_id, scope)).toBeNull();
  });

  it('appends through an already-owned real adapter without initializing another store', async () => {
    await initDB();
    const trace = appendOperationToolTraceInAdapter(getAdapter(), {
      operation_id: 'op:adapter-owned:1',
      actor_principal_id: 'owner:runtime',
      tool_name: 'work.list',
      execution_status: 'completed',
      ...scope,
    });
    expect(trace).toMatchObject({
      operation_id: 'op:adapter-owned:1',
      actor_principal_id: 'owner:runtime',
      model_run_id: null,
      tool_name: 'work.list',
    });
  });

  it('refuses an operation append missing either origin field', async () => {
    await expect(
      appendOperationToolTrace({
        operation_id: '',
        actor_principal_id: 'owner:runtime',
        tool_name: 'x',
      })
    ).rejects.toThrow(/operation_id/i);
    await expect(
      appendOperationToolTrace({
        operation_id: 'op:1',
        actor_principal_id: '',
        tool_name: 'x',
      })
    ).rejects.toThrow(/actor_principal_id/i);
  });

  it('keeps the legacy model-backed append and lists it by run, with a completed run allowed', async () => {
    const run = await beginModelRun({ agent_id: 'test', model_id: 'claude-opus-4-8' });
    const trace = await appendToolTrace({
      model_run_id: run.model_run_id,
      tool_name: 'mama_search',
      execution_status: 'completed',
    });
    expect(trace.model_run_id).toBe(run.model_run_id);
    expect(trace.operation_id).toBeNull();
    expect(trace.actor_principal_id).toBeNull();
    expect(await listToolTracesForRun(run.model_run_id)).toEqual([trace]);
  });

  it('the CHECK rejects a raw row with neither a model run nor an operation origin', async () => {
    await initDB();
    const adapter = getAdapter();
    expect(() =>
      adapter
        .prepare(
          'INSERT INTO tool_traces (trace_id, model_run_id, operation_id, actor_principal_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('raw-no-origin', null, null, null, 'x', 1)
    ).toThrow(/constraint/i);
  });

  it('stores an optional real causal model run on an operation trace and surfaces it by run', async () => {
    const run = await beginModelRun({ agent_id: 'test', model_id: 'claude-opus-4-8' });
    // operation_id + actor_principal_id stay required; model_run_id is optional
    // causal provenance for a completed run.
    const cited = await appendOperationToolTrace({
      operation_id: 'op:cite:1',
      actor_principal_id: 'owner:runtime',
      tool_name: 'source_search',
      model_run_id: run.model_run_id,
      ...scope,
    });
    expect(cited.operation_id).toBe('op:cite:1');
    expect(cited.actor_principal_id).toBe('owner:runtime');
    expect(cited.model_run_id).toBe(run.model_run_id);
    // Genuinely associated: the run's listing naturally includes it.
    expect((await listToolTracesForRun(run.model_run_id)).map((t) => t.trace_id)).toContain(
      cited.trace_id
    );

    // An operation with no causing run stays NULL and is excluded from the run.
    const uncited = await appendOperationToolTrace({
      operation_id: 'op:cite:2',
      actor_principal_id: 'owner:runtime',
      tool_name: 'source_search',
      ...scope,
    });
    expect(uncited.model_run_id).toBeNull();
    expect((await listToolTracesForRun(run.model_run_id)).map((t) => t.trace_id)).not.toContain(
      uncited.trace_id
    );
  });

  it('rejects an invalid causal model reference on an operation trace (real FK, no fake run)', async () => {
    await expect(
      appendOperationToolTrace({
        operation_id: 'op:cite:3',
        actor_principal_id: 'owner:runtime',
        tool_name: 'source_search',
        model_run_id: 'mr-does-not-exist',
        ...scope,
      })
    ).rejects.toThrow();
  });
});

describe('migration 071 raw SQL companion (applyAll/direct-exec path)', () => {
  function applyThroughRaw071(db: Database.Database): void {
    for (const file of migrationFiles().filter(
      (file) => Number.parseInt(file.slice(0, 3), 10) <= 71
    )) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
  }

  it('produces the same canonical origin shape as the dynamic adapter rebuild', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    applyThroughRaw071(raw);
    const rawSql = normalizeSql(
      (
        raw
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'")
          .get() as {
          sql: string;
        }
      ).sql
    );
    const rawCols = new Set(
      (raw.prepare('PRAGMA table_info(tool_traces)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    raw.close();

    const path = join(os.tmpdir(), `test-071-parity-${randomUUID()}.db`);
    const adapter = openAdapter(path);
    adapter.runMigrations(MIGRATIONS_DIR);
    const dynSql = normalizeSql(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'")
          .get() as { sql: string }
      ).sql
    );
    const dynCols = new Set(
      (adapter.prepare('PRAGMA table_info(tool_traces)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    adapter.disconnect();

    // Same columns, and both carry model_run_id nullable + the strong origin CHECK + FK.
    expect([...dynCols].sort()).toEqual([...rawCols].sort());
    for (const sql of [rawSql, dynSql]) {
      expect(sql).toContain('operation_id');
      expect(sql).toContain('actor_principal_id');
      expect(sql).toContain('referencesmodel_runs(model_run_id)');
      expect(sql).toContain('length(trim(operation_id))>0');
      expect(sql).toContain('length(trim(actor_principal_id))>0');
    }
  });

  it('fails loudly instead of silently dropping a noncanonical runtime column', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const file of migrationFiles().filter(
      (file) => Number.parseInt(file.slice(0, 3), 10) < 71
    )) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    db.exec("ALTER TABLE tool_traces ADD COLUMN runtime_note TEXT NOT NULL DEFAULT 'x'");

    const raw071 = readFileSync(join(MIGRATIONS_DIR, '071-service-operation-origins.sql'), 'utf8');
    // The guard must abort before any data is altered rather than drop the column.
    expect(() => db.exec(raw071)).toThrow();
    const cols = columnInfo(db, 'tool_traces');
    expect(cols.some((c) => c.name === 'runtime_note')).toBe(true);
    expect(cols.find((c) => c.name === 'model_run_id')?.notnull).toBe(1);
    expect(cols.some((c) => c.name === 'operation_id')).toBe(false);
    db.close();
  });

  function seedRawPre071(db: Database.Database): void {
    db.pragma('foreign_keys = ON');
    for (const file of migrationFiles().filter(
      (file) => Number.parseInt(file.slice(0, 3), 10) < 71
    )) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    db.exec(
      "INSERT INTO model_runs (model_run_id, status, created_at) VALUES ('mr','committed',1);" +
        "INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES ('trace','mr','probe',2)"
    );
  }

  function raw071(): string {
    return readFileSync(join(MIGRATIONS_DIR, '071-service-operation-origins.sql'), 'utf8');
  }

  it('aborts before dropping a custom unique index rather than silently losing it', () => {
    const db = new Database(':memory:');
    seedRawPre071(db);
    db.exec('CREATE UNIQUE INDEX custom_trace_tool_unique ON tool_traces(tool_name)');

    // Guard must fail BEFORE the DROP TABLE so the index (and its data) survive.
    expect(() => db.exec(raw071())).toThrow();
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='custom_trace_tool_unique'"
          )
          .get() as { n: number }
      ).n
    ).toBe(1);
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM tool_traces').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('aborts before dropping tool_traces when a child table references it (no CASCADE loss)', () => {
    const db = new Database(':memory:');
    seedRawPre071(db);
    db.exec(
      'CREATE TABLE child_trace (id TEXT, trace_id TEXT REFERENCES tool_traces(trace_id) ON DELETE CASCADE)'
    );
    db.prepare('INSERT INTO child_trace (id, trace_id) VALUES (?, ?)').run('child', 'trace');

    // The DROP TABLE in the canonical rebuild would CASCADE-delete the child row.
    // The guard must abort before any data is altered.
    expect(() => db.exec(raw071())).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM child_trace').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT count(*) AS n FROM tool_traces').get() as { n: number }).n).toBe(1);
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    db.close();
  });

  it('aborts instead of dropping already-present operation-origin column values', () => {
    const db = new Database(':memory:');
    seedRawPre071(db);
    // A partially-repaired table carrying real origin values this canonical path
    // does not copy. It must abort, not stamp success and drop the values.
    db.exec('ALTER TABLE tool_traces ADD COLUMN operation_id TEXT');
    db.exec('ALTER TABLE tool_traces ADD COLUMN actor_principal_id TEXT');
    db.prepare(
      "UPDATE tool_traces SET operation_id='op:kept', actor_principal_id='owner:runtime' WHERE trace_id='trace'"
    ).run();

    expect(() => db.exec(raw071())).toThrow();
    expect(
      db
        .prepare('SELECT operation_id, actor_principal_id FROM tool_traces WHERE trace_id = ?')
        .get('trace')
    ).toEqual({ operation_id: 'op:kept', actor_principal_id: 'owner:runtime' });
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    db.close();
  });

  // Build a real pre-071 DB whose tool_traces carries the canonical 17 columns
  // but one structural deviation the canonical INSERT/DROP path cannot preserve
  // (an embedded constraint or an extra outgoing FK). Everything else - column
  // set, the model_runs FK, the four 033/068 named indexes and a seeded row -
  // stays canonical so the abort is attributable to the single deviation.
  const CANONICAL_TOOL_TRACES_COLUMNS =
    'trace_id TEXT PRIMARY KEY,\n' +
    'model_run_id TEXT NOT NULL,\n' +
    'gateway_call_id TEXT,\n' +
    'tool_name TEXT NOT NULL,\n' +
    'input_summary TEXT,\n' +
    'output_summary TEXT,\n' +
    'execution_status TEXT,\n' +
    'duration_ms INTEGER DEFAULT 0,\n' +
    'envelope_hash TEXT,\n' +
    'created_at INTEGER NOT NULL,\n' +
    'failure_code TEXT,\n' +
    'diagnostic_json TEXT,\n' +
    'evidence_json TEXT,\n' +
    'catalog_revision TEXT,\n' +
    'owner_scope TEXT,\n' +
    'project_id TEXT,\n' +
    'channel_id TEXT';

  function seedRawPre071WithVariantToolTraces(
    db: Database.Database,
    bodyClauses: string,
    extraSetup?: (db: Database.Database) => void
  ): void {
    db.pragma('foreign_keys = ON');
    for (const file of migrationFiles().filter(
      (file) => Number.parseInt(file.slice(0, 3), 10) < 71
    )) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    db.exec('DROP TABLE tool_traces');
    if (extraSetup) {
      extraSetup(db);
    }
    db.exec(`CREATE TABLE tool_traces (\n${bodyClauses}\n)`);
    // Recreate the canonical 033/068 indexes so only the injected deviation differs.
    db.exec(
      'CREATE INDEX idx_tool_traces_model_run_id ON tool_traces(model_run_id, created_at DESC);' +
        'CREATE INDEX idx_tool_traces_gateway_call_id ON tool_traces(gateway_call_id);' +
        'CREATE INDEX idx_tool_traces_scope_recency ON tool_traces(owner_scope, project_id, created_at DESC, trace_id DESC);' +
        'CREATE INDEX idx_tool_traces_channel_recency ON tool_traces(owner_scope, project_id, channel_id, created_at DESC, trace_id DESC)'
    );
    db.exec(
      "INSERT INTO model_runs (model_run_id, status, created_at) VALUES ('mr','committed',1);" +
        "INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES ('trace','mr','probe',2)"
    );
  }

  it('aborts before rebuilding when a column carries an embedded CHECK constraint', () => {
    const db = new Database(':memory:');
    seedRawPre071WithVariantToolTraces(
      db,
      `${CANONICAL_TOOL_TRACES_COLUMNS.replace(
        'tool_name TEXT NOT NULL,',
        'tool_name TEXT NOT NULL CHECK (length(tool_name) > 0),'
      )},\nFOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)`
    );

    // The canonical rebuild would silently drop the CHECK. Fail before the DROP.
    expect(() => db.exec(raw071())).toThrow();
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM tool_traces').get() as { n: number }).n).toBe(1);
    // Schema (and thus the CHECK) is untouched: the constraint still bites.
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_traces'")
        .get() as { sql: string }
    ).sql;
    expect(/check\s*\(/i.test(tableSql)).toBe(true);
    expect(() =>
      db
        .prepare(
          'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at) VALUES (?,?,?,?)'
        )
        .run('bad', 'mr', '', 3)
    ).toThrow();
    db.close();
  });

  it('aborts before rebuilding when a table-level UNIQUE adds an extra auto-index', () => {
    const db = new Database(':memory:');
    seedRawPre071WithVariantToolTraces(
      db,
      `${CANONICAL_TOOL_TRACES_COLUMNS},\nUNIQUE (gateway_call_id),\nFOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id)`
    );
    const autoIndexes = () =>
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='tool_traces' AND sql IS NULL"
          )
          .get() as { n: number }
      ).n;
    // The UNIQUE constraint materialises a second sql-IS-NULL auto-index the
    // canonical rebuild does not recreate; it must not be silently dropped.
    expect(autoIndexes()).toBe(2);

    expect(() => db.exec(raw071())).toThrow();
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM tool_traces').get() as { n: number }).n).toBe(1);
    expect(autoIndexes()).toBe(2);
    db.close();
  });

  it('aborts before rebuilding when tool_traces carries an extra outgoing FK', () => {
    const db = new Database(':memory:');
    seedRawPre071WithVariantToolTraces(
      db,
      `${CANONICAL_TOOL_TRACES_COLUMNS},\n` +
        'FOREIGN KEY (model_run_id) REFERENCES model_runs(model_run_id),\n' +
        'FOREIGN KEY (gateway_call_id) REFERENCES gateway_refs(gateway_call_id)',
      (inner) => inner.exec('CREATE TABLE gateway_refs (gateway_call_id TEXT PRIMARY KEY)')
    );
    const fkCount = () =>
      (
        db.prepare("SELECT count(*) AS n FROM pragma_foreign_key_list('tool_traces')").get() as {
          n: number;
        }
      ).n;
    // Two outgoing FKs; the canonical rebuild re-emits only the model_runs FK and
    // would silently drop the second. Fail before altering data.
    expect(fkCount()).toBe(2);

    expect(() => db.exec(raw071())).toThrow();
    expect(
      db.prepare('SELECT version FROM schema_version WHERE version = 71').get()
    ).toBeUndefined();
    expect((db.prepare('SELECT count(*) AS n FROM tool_traces').get() as { n: number }).n).toBe(1);
    expect(fkCount()).toBe(2);
    db.close();
  });
});
