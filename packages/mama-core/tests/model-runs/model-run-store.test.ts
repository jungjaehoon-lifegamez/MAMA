import { readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import {
  beginModelRun,
  commitModelRun,
  failModelRun,
  getModelRun,
} from '../../src/model-runs/store.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const TEST_DB = join(os.tmpdir(), `test-model-run-store-${randomUUID()}.db`);

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

function tableSql(db: Database.Database, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

describe('Story M2.2: Model Run Ledger', () => {
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
    describe('AC #1: model run schema', () => {
      it('creates model_runs with a primary-key model_run_id and migration version 033', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        expect(tableExists(db, 'model_runs')).toBe(true);
        expect(tableSql(db, 'model_runs')).toMatch(/model_run_id\s+TEXT\s+PRIMARY\s+KEY/i);

        const row = db
          .prepare('SELECT version, description FROM schema_version WHERE version = 33')
          .get() as { version: number; description: string } | undefined;
        expect(row?.version).toBe(33);
        expect(row?.description).toContain('model runs and tool traces');

        db.close();
      });

      it('rejects model run statuses outside the supported lifecycle', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        db.prepare(
          `
            INSERT INTO model_runs (model_run_id, status, created_at)
            VALUES (?, ?, ?)
          `
        ).run('mr_running', 'running', Date.now());

        expect(() =>
          db
            .prepare(
              `
                INSERT INTO model_runs (model_run_id, status, created_at)
                VALUES (?, ?, ?)
              `
            )
            .run('mr_invalid', 'paused', Date.now())
        ).toThrow(/CHECK constraint failed|constraint failed/i);

        db.close();
      });

      it('indexes model runs by envelope, status, and agent recency', () => {
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        applyAll(db);

        expect(indexExists(db, 'idx_model_runs_envelope_hash')).toBe(true);
        expect(indexExists(db, 'idx_model_runs_status_created')).toBe(true);
        expect(indexExists(db, 'idx_model_runs_agent_created')).toBe(true);

        db.close();
      });
    });

    describe('AC #2: model run lifecycle helpers', () => {
      it('begins and reads a model run with compact input refs', async () => {
        const run = await beginModelRun({
          model_run_id: 'mr_store_begin',
          model_id: 'gpt-5.4',
          model_provider: 'openai',
          agent_id: 'agent-main',
          instance_id: 'instance-1',
          envelope_hash: 'env_store',
          input_refs: {
            source: 'discord',
            channel_id: 'channel-1',
            source_turn_id: 'turn-1',
          },
          created_at: 1_000,
        });

        expect(run).toMatchObject({
          model_run_id: 'mr_store_begin',
          model_id: 'gpt-5.4',
          model_provider: 'openai',
          agent_id: 'agent-main',
          instance_id: 'instance-1',
          envelope_hash: 'env_store',
          status: 'running',
          created_at: 1_000,
          completed_at: null,
        });
        expect(run.input_refs).toEqual({
          source: 'discord',
          channel_id: 'channel-1',
          source_turn_id: 'turn-1',
        });

        await expect(getModelRun('mr_store_begin')).resolves.toMatchObject({
          model_run_id: 'mr_store_begin',
          status: 'running',
        });
      });

      it('rejects invalid input refs before inserting a model run row', async () => {
        await expect(
          beginModelRun({
            model_run_id: 'mr_invalid_input_refs_json',
            input_refs_json: 'not json',
          })
        ).rejects.toThrow(/Invalid model_runs\.input_refs_json/);
        await expect(getModelRun('mr_invalid_input_refs_json')).resolves.toBeNull();

        await expect(
          beginModelRun({
            model_run_id: 'mr_non_object_input_refs_json',
            input_refs_json: '"not an object"',
          })
        ).rejects.toThrow(/model_runs\.input_refs_json/);
        await expect(getModelRun('mr_non_object_input_refs_json')).resolves.toBeNull();

        const circular: Record<string, unknown> = {};
        circular.self = circular;
        await expect(
          beginModelRun({
            model_run_id: 'mr_circular_input_refs',
            input_refs: circular,
          })
        ).rejects.toThrow(/Invalid model_runs\.input_refs/);
        await expect(getModelRun('mr_circular_input_refs')).resolves.toBeNull();
      });

      it('commits a model run and persists the completion summary', async () => {
        await beginModelRun({
          model_run_id: 'mr_store_commit',
          agent_id: 'agent-main',
          created_at: 2_000,
        });

        const committed = await commitModelRun('mr_store_commit', 'saved two memories');

        expect(committed.status).toBe('committed');
        expect(committed.completion_summary).toBe('saved two memories');
        expect(committed.completed_at).toEqual(expect.any(Number));
        await expect(getModelRun('mr_store_commit')).resolves.toMatchObject({
          status: 'committed',
          completion_summary: 'saved two memories',
        });
      });

      it('marks a model run failed with a compact error summary', async () => {
        await beginModelRun({
          model_run_id: 'mr_store_fail',
          agent_id: 'agent-main',
          created_at: 3_000,
        });

        const failed = await failModelRun('mr_store_fail', 'tool execution failed');

        expect(failed.status).toBe('failed');
        expect(failed.error_summary).toBe('tool execution failed');
        expect(failed.completed_at).toEqual(expect.any(Number));
      });

      it('fails loud when persisted status is outside the supported lifecycle', async () => {
        await initDB();
        const adapter = getAdapter();
        adapter.prepare('PRAGMA ignore_check_constraints = ON').run();
        adapter
          .prepare(
            `
              INSERT INTO model_runs (model_run_id, status, created_at)
              VALUES (?, ?, ?)
            `
          )
          .run('mr_corrupt_status', 'paused', 5_000);
        adapter.prepare('PRAGMA ignore_check_constraints = OFF').run();

        await expect(getModelRun('mr_corrupt_status')).rejects.toThrow(/model_runs\.status/);
      });
    });
  });
});
