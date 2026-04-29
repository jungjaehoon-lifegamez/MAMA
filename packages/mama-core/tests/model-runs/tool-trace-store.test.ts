import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { beginModelRun } from '../../src/model-runs/store.js';
import { appendToolTrace, listToolTracesForRun } from '../../src/model-runs/tool-trace-store.js';

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
  });
});
