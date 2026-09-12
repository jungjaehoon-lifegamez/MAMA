import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { beginModelRun } from '../../src/model-runs/store.js';
import {
  appendToolTrace,
  listToolTracesForRun,
  listToolTraces,
  readToolTrace,
} from '../../src/model-runs/tool-trace-store.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const TEST_DB = join(os.tmpdir(), `test-tool-trace-store-${randomUUID()}.db`);

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

function applyAll(db: Database.Database): void {
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

describe('Story M2.2: Tool Trace Ledger', () => {
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    cleanupDb();
  });

  describe('Acceptance Criteria', () => {
    describe('AC #1: tool trace schema', () => {
      it('creates tool_traces with indexed model-run and gateway-call lookup fields', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        expect(tableExists(db, 'tool_traces')).toBe(true);
        expect(indexExists(db, 'idx_tool_traces_model_run_id')).toBe(true);
        expect(indexExists(db, 'idx_tool_traces_gateway_call_id')).toBe(true);

        db.close();
      });

      it('requires each trace to point at an existing model run', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        expect(() =>
          db
            .prepare(
              `
                INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at)
                VALUES (?, ?, ?, ?)
              `
            )
            .run('trace_missing_run', 'mr_missing', 'mama_save', Date.now())
        ).toThrow(/FOREIGN KEY constraint failed|constraint failed/i);

        db.prepare(
          `
            INSERT INTO model_runs (model_run_id, status, created_at)
            VALUES (?, ?, ?)
          `
        ).run('mr_existing', 'running', Date.now());
        db.prepare(
          `
            INSERT INTO tool_traces (trace_id, model_run_id, tool_name, created_at)
            VALUES (?, ?, ?, ?)
          `
        ).run('trace_existing_run', 'mr_existing', 'mama_save', Date.now());

        db.close();
      });

      it('stores summaries instead of full prompt or result payload columns', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        const columns = columnNames(db, 'tool_traces');
        expect(columns).toContain('input_summary');
        expect(columns).toContain('output_summary');
        expect(columns).not.toContain('input_json');
        expect(columns).not.toContain('output_json');
        expect(columns).not.toContain('prompt');
        expect(columns).not.toContain('result_payload');

        db.close();
      });
    });

    describe('AC #2: tool trace helpers', () => {
      it('appends a compact trace and lists traces by model run recency', async () => {
        await beginModelRun({
          model_run_id: 'mr_trace_helpers',
          agent_id: 'agent-main',
          envelope_hash: 'env_trace',
          created_at: 1_000,
        });

        const older = await appendToolTrace({
          trace_id: 'trace_older',
          model_run_id: 'mr_trace_helpers',
          gateway_call_id: 'gw_trace_1',
          tool_name: 'mama_search',
          input_summary: 'tool:mama_search',
          output_summary: 'ok',
          execution_status: 'success',
          duration_ms: 12,
          envelope_hash: 'env_trace',
          created_at: 2_000,
        });
        const newer = await appendToolTrace({
          trace_id: 'trace_newer',
          model_run_id: 'mr_trace_helpers',
          gateway_call_id: 'gw_trace_2',
          tool_name: 'mama_save',
          input_summary: 'tool:mama_save',
          output_summary: 'saved',
          execution_status: 'success',
          duration_ms: 20,
          envelope_hash: 'env_trace',
          created_at: 3_000,
        });

        expect(older).toMatchObject({
          trace_id: 'trace_older',
          model_run_id: 'mr_trace_helpers',
          gateway_call_id: 'gw_trace_1',
          tool_name: 'mama_search',
          input_summary: 'tool:mama_search',
          output_summary: 'ok',
          execution_status: 'success',
          duration_ms: 12,
          envelope_hash: 'env_trace',
          created_at: 2_000,
        });

        await expect(listToolTracesForRun('mr_trace_helpers')).resolves.toEqual([newer, older]);
      });

      it('does not insert a trace with a missing model run id', async () => {
        await expect(
          appendToolTrace({
            trace_id: 'trace_missing_model_run',
            model_run_id: '',
            tool_name: 'mama_save',
          })
        ).rejects.toThrow(/model_run_id/i);
      });

      it('fails loud when a persisted trace has invalid numeric fields', async () => {
        await initDB();
        const adapter = getAdapter();
        adapter
          .prepare(
            `
              INSERT INTO model_runs (model_run_id, status, created_at)
              VALUES (?, ?, ?)
            `
          )
          .run('mr_corrupt_trace', 'running', 1_000);
        adapter
          .prepare(
            `
              INSERT INTO tool_traces (
                trace_id, model_run_id, tool_name, duration_ms, created_at
              )
              VALUES (?, ?, ?, ?, ?)
            `
          )
          .run('trace_corrupt_numeric', 'mr_corrupt_trace', 'mama_search', 'slow', 'later');

        await expect(listToolTracesForRun('mr_corrupt_trace')).rejects.toThrow(
          /tool_traces\.duration_ms/
        );
      });
    });

    describe('AC #3: failure_code carries the thrower cause (S2 Task 0)', () => {
      // The thrower already emits a closed code (envelope_missing,
      // context_compile_scope_denied, ...) and the sanitizer preserves it -
      // the trace was the one place that dropped it, leaving only a digest.
      it('migration adds a nullable failure_code column', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);
        expect(columnNames(db, 'tool_traces')).toContain('failure_code');
        db.close();
      });

      it('round-trips failure_code through append and list', async () => {
        const run = await beginModelRun({ agent_id: 'test', source: 'watch' });
        const appended = await appendToolTrace({
          model_run_id: run.model_run_id,
          tool_name: 'context_compile',
          execution_status: 'failed',
          output_summary: 'gateway_tool_failed;sha256=abc;length=10',
          failure_code: 'envelope_missing',
        });
        expect(appended.failure_code).toBe('envelope_missing');
        const [listed] = await listToolTracesForRun(run.model_run_id);
        expect(listed.failure_code).toBe('envelope_missing');
      });

      it('a failure without a code stays NULL - no invented labels', async () => {
        const run = await beginModelRun({ agent_id: 'test', source: 'watch' });
        const appended = await appendToolTrace({
          model_run_id: run.model_run_id,
          tool_name: 'mama_search',
          execution_status: 'failed',
        });
        expect(appended.failure_code).toBeNull();
      });
    });
  });
});

describe('TG-03/04/05: scoped progressive tool evidence', () => {
  const scope = { owner_scope: 'owner:runtime', project_id: 'project-a' };
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    await beginModelRun({ model_run_id: 'mr_evidence' });
  });
  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    cleanupDb();
  });

  it('preserves exact JSON across reopen and leaves old summaries intact', async () => {
    const evidence_json = '{ "input": {"x":1}, "result": {"error":"bad argument"} }';
    const saved = await appendToolTrace({
      model_run_id: 'mr_evidence',
      tool_name: 'example',
      ...scope,
      channel_id: 'channel-a',
      input_summary: 'safe summary',
      diagnostic_json: '{"kind":"tool_contract"}',
      evidence_json,
      catalog_revision: 'v1',
    });
    await closeDB();
    expect(await readToolTrace(saved.trace_id, scope)).toEqual(saved);
    expect(saved.input_summary).toBe('safe summary');
    expect(saved.evidence_json).toBe(evidence_json);
    expect((await listToolTraces(scope)).traces[0].evidence_json).toBeNull();
    expect(await readToolTrace(saved.trace_id, { ...scope, project_id: 'other' })).toBeNull();
    expect(await readToolTrace(saved.trace_id, { ...scope, owner_scope: 'other' })).toBeNull();
    expect(await readToolTrace(saved.trace_id, { ...scope, channel_id: 'other' })).toBeNull();
  });

  it('paginates matching metadata deterministically without skipping timestamp ties', async () => {
    for (const trace_id of ['a', 'b', 'c']) {
      await appendToolTrace({
        trace_id,
        model_run_id: 'mr_evidence',
        tool_name: 'example',
        ...scope,
        created_at: 100,
      });
    }
    await appendToolTrace({
      trace_id: 'foreign',
      model_run_id: 'mr_evidence',
      tool_name: 'example',
      ...scope,
      project_id: 'other',
      created_at: 200,
    });
    const first = await listToolTraces({ ...scope, limit: 2 });
    expect(first.traces.map((t) => t.trace_id)).toEqual(['c', 'b']);
    expect(first.next_cursor).toBeTypeOf('string');
    const second = await listToolTraces({ ...scope, limit: 2, cursor: first.next_cursor! });
    expect(second.traces.map((t) => t.trace_id)).toEqual(['a']);
    expect(second.next_cursor).toBeNull();
    expect((await listToolTraces({ ...scope, tool_name: 'different' })).traces).toEqual([]);
  });

  it('retains nullable legacy fields and never includes unscoped records in discovery', async () => {
    const legacy = await appendToolTrace({ model_run_id: 'mr_evidence', tool_name: 'legacy' });
    expect(legacy.diagnostic_json).toBeNull();
    expect(legacy.evidence_json).toBeNull();
    expect((await listToolTraces(scope)).traces).toEqual([]);
    expect(await readToolTrace(legacy.trace_id, scope)).toBeNull();
    expect(await listToolTracesForRun('mr_evidence')).toEqual([legacy]);
  });

  it('upgrades pre-diagnostic rows without changing their summaries or granting scope', () => {
    const db = new Database(':memory:');
    for (const file of migrationFiles().filter(
      (file) => !file.startsWith('068-') && !file.startsWith('071-')
    )) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    db.prepare('INSERT INTO model_runs (model_run_id, status, created_at) VALUES (?, ?, ?)').run(
      'old-run',
      'legacy',
      1
    );
    db.prepare(
      'INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('old-trace', 'old-run', 'old-tool', 'unchanged', 2);
    db.exec(readFileSync(join(MIGRATIONS_DIR, '068-tool-trace-diagnostics.sql'), 'utf8'));
    expect(
      db
        .prepare(
          'SELECT input_summary, diagnostic_json, evidence_json, owner_scope FROM tool_traces'
        )
        .get()
    ).toEqual({
      input_summary: 'unchanged',
      diagnostic_json: null,
      evidence_json: null,
      owner_scope: null,
    });
    db.close();
  });

  it('fails explicitly on corrupted stored detail without returning malformed evidence', async () => {
    const row = await appendToolTrace({
      ...scope,
      model_run_id: 'mr_evidence',
      tool_name: 'example',
    });
    getAdapter()
      .prepare('UPDATE tool_traces SET evidence_json = ? WHERE trace_id = ?')
      .run('{invalid', row.trace_id);
    await expect(readToolTrace(row.trace_id, scope)).rejects.toThrow(/evidence_json.*malformed/);
    expect((await listToolTraces(scope)).traces[0].evidence_json).toBeNull();
  });

  it('filters detailed evidence before pagination so newer inspection metadata cannot displace it', async () => {
    await appendToolTrace({
      ...scope,
      trace_id: 'evidence-old',
      model_run_id: 'mr_evidence',
      tool_name: 'example',
      created_at: 1,
      evidence_json: '{"result":"observed"}',
    });
    for (let index = 0; index < 5; index++) {
      await appendToolTrace({
        ...scope,
        trace_id: `metadata-${index}`,
        model_run_id: 'mr_evidence',
        tool_name: 'experience_read',
        created_at: index + 2,
      });
    }
    const page = await listToolTraces({ ...scope, evidence_only: true, limit: 1 });
    expect(page.traces.map((trace) => trace.trace_id)).toEqual(['evidence-old']);
    expect(page.next_cursor).toBeNull();
    expect(
      (await listToolTraces({ ...scope, evidence_only: false, limit: 1 })).traces[0].trace_id
    ).toBe('metadata-4');
    // Runtime tool input still needs validation beyond the TypeScript caller contract.
    await expect(
      listToolTraces({ ...scope, evidence_only: 'true' as unknown as boolean })
    ).rejects.toThrow(/evidence_only/);
  });

  it('rejects malformed/non-object JSON and invalid scope/pagination explicitly', async () => {
    for (const value of ['{bad', '[]', 'null', '1', '']) {
      await expect(
        appendToolTrace({ model_run_id: 'mr_evidence', tool_name: 'example', evidence_json: value })
      ).rejects.toThrow(/evidence_json/);
    }
    await expect(listToolTraces({ ...scope, project_id: '' })).rejects.toThrow(/project_id/);
    await expect(listToolTraces({ ...scope, cursor: 'bad' })).rejects.toThrow(/cursor/);
    await expect(listToolTraces({ ...scope, limit: 101 })).rejects.toThrow(/limit/);
  });
});
