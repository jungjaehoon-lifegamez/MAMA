import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB, type DatabaseAdapter } from '../../src/db-manager.js';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import {
  beginModelRun,
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  failModelRunInAdapter,
  getModelRun,
  getModelRunInAdapter,
} from '../../src/model-runs/store.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();
const scopedAdapters = new Set<DatabaseAdapter>();

function tempDbPath(label: string): string {
  const path = join(os.tmpdir(), `test-model-run-adapter-${label}-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

function cleanupDb(path: string): void {
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

function createAdapter(path: string): DatabaseAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  scopedAdapters.add(adapter);
  return adapter;
}

describe('Story M5/M6: Adapter-scoped model run helpers', () => {
  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    for (const adapter of scopedAdapters) {
      adapter.disconnect();
    }
    scopedAdapters.clear();
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('Acceptance Criteria', () => {
    describe('AC #1: injected adapter isolation', () => {
      it('begins and reads model runs from the supplied adapter without touching the global DB', async () => {
        const globalPath = tempDbPath('global');
        const scopedPath = tempDbPath('scoped');
        process.env.MAMA_DB_PATH = globalPath;
        await initDB();
        const globalAdapter = getAdapter();

        const scopedAdapter = createAdapter(scopedPath);
        const run = beginModelRunInAdapter(scopedAdapter, {
          model_run_id: 'mr_scoped',
          agent_id: 'agent-scoped',
          envelope_hash: 'env_scoped',
          input_refs: { source: 'agent.situation', cache_key: 'cache_1' },
          created_at: 1_000,
        });

        expect(run).toMatchObject({
          model_run_id: 'mr_scoped',
          agent_id: 'agent-scoped',
          envelope_hash: 'env_scoped',
          status: 'running',
        });
        expect(getModelRunInAdapter(scopedAdapter, 'mr_scoped')).toMatchObject({
          model_run_id: 'mr_scoped',
          input_refs: { source: 'agent.situation', cache_key: 'cache_1' },
        });
        expect(getModelRunInAdapter(globalAdapter, 'mr_scoped')).toBeNull();
      });
    });

    describe('AC #2: adapter-scoped lifecycle', () => {
      it('commits and fails runs using the supplied adapter', () => {
        const scopedAdapter = createAdapter(tempDbPath('lifecycle'));
        beginModelRunInAdapter(scopedAdapter, {
          model_run_id: 'mr_commit_scoped',
          created_at: 2_000,
        });

        const committed = commitModelRunInAdapter(
          scopedAdapter,
          'mr_commit_scoped',
          'packet generated'
        );

        expect(committed).toMatchObject({
          model_run_id: 'mr_commit_scoped',
          status: 'committed',
          completion_summary: 'packet generated',
        });

        beginModelRunInAdapter(scopedAdapter, {
          model_run_id: 'mr_fail_scoped',
          created_at: 3_000,
        });

        const failed = failModelRunInAdapter(scopedAdapter, 'mr_fail_scoped', 'alias failed');

        expect(failed).toMatchObject({
          model_run_id: 'mr_fail_scoped',
          status: 'failed',
          error_summary: 'alias failed',
        });
      });
    });

    describe('AC #3: deterministic direct run idempotency', () => {
      it('returns an existing matching caller-supplied model run id instead of inserting a duplicate', () => {
        const scopedAdapter = createAdapter(tempDbPath('idempotent'));
        const input = {
          model_run_id: 'mr_direct_alias_env_entity_key',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_1',
            request_idempotency_key: 'alias-key',
          },
          created_at: 4_000,
        };

        const first = beginModelRunInAdapter(scopedAdapter, input);
        const replay = beginModelRunInAdapter(scopedAdapter, input);

        expect(replay).toEqual(first);
        const count = scopedAdapter
          .prepare('SELECT COUNT(*) AS count FROM model_runs WHERE model_run_id = ?')
          .get(input.model_run_id) as { count: number };
        expect(count.count).toBe(1);
      });

      it('rejects underspecified duplicate model run ids instead of binding to an existing run', () => {
        const scopedAdapter = createAdapter(tempDbPath('underspecified'));
        const input = {
          model_run_id: 'mr_direct_alias_existing',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_existing',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_existing',
            request_idempotency_key: 'alias-key-existing',
          },
          created_at: 5_000,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        expect(() =>
          beginModelRunInAdapter(scopedAdapter, {
            model_run_id: input.model_run_id,
            created_at: input.created_at,
          })
        ).toThrow(/idempotency discriminator|different/);
        expect(getModelRunInAdapter(scopedAdapter, input.model_run_id)).toMatchObject({
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_existing',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_existing',
            request_idempotency_key: 'alias-key-existing',
          },
        });
      });

      it('rejects conflicting deterministic replays and preserves the original row', () => {
        const scopedAdapter = createAdapter(tempDbPath('conflict'));
        const input = {
          model_run_id: 'mr_direct_alias_conflict',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_original',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_original',
            request_idempotency_key: 'alias-key-conflict',
          },
          token_count: 12,
          created_at: 6_000,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        for (const conflictingInput of [
          { ...input, envelope_hash: 'env_alias_changed' },
          { ...input, input_refs: { ...input.input_refs, entity_id: 'entity_changed' } },
          { ...input, status: 'failed' as const },
          { ...input, token_count: 13 },
          { ...input, created_at: 6_001 },
        ]) {
          expect(() => beginModelRunInAdapter(scopedAdapter, conflictingInput)).toThrow(
            /Model run already exists/
          );
        }

        expect(getModelRunInAdapter(scopedAdapter, input.model_run_id)).toMatchObject({
          model_run_id: input.model_run_id,
          envelope_hash: 'env_alias_original',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_original',
            request_idempotency_key: 'alias-key-conflict',
          },
          token_count: 12,
          created_at: 6_000,
        });
      });

      it('pins duplicate behavior through the legacy global begin helper', async () => {
        const globalPath = tempDbPath('legacy-global');
        process.env.MAMA_DB_PATH = globalPath;

        const input = {
          model_run_id: 'mr_legacy_duplicate',
          agent_id: 'agent-legacy',
          envelope_hash: 'env_legacy',
          input_refs: {
            tool: 'model.run',
            request_idempotency_key: 'legacy-key',
          },
          created_at: 7_000,
        };

        const first = await beginModelRun(input);
        await expect(beginModelRun(input)).resolves.toEqual(first);
        await expect(
          beginModelRun({
            ...input,
            envelope_hash: 'env_legacy_changed',
          })
        ).rejects.toThrow(/Model run already exists/);
        await expect(getModelRun(input.model_run_id)).resolves.toMatchObject({
          envelope_hash: 'env_legacy',
          input_refs: {
            tool: 'model.run',
            request_idempotency_key: 'legacy-key',
          },
        });
      });
    });

    describe('AC #4: terminal lifecycle safety', () => {
      it('does not allow a committed run to be failed later', () => {
        const scopedAdapter = createAdapter(tempDbPath('committed-terminal'));
        beginModelRunInAdapter(scopedAdapter, {
          model_run_id: 'mr_terminal_commit',
          created_at: 8_000,
        });

        const committed = commitModelRunInAdapter(
          scopedAdapter,
          'mr_terminal_commit',
          'packet generated'
        );

        expect(() =>
          failModelRunInAdapter(scopedAdapter, 'mr_terminal_commit', 'late failure')
        ).toThrow(/already committed/);
        expect(getModelRunInAdapter(scopedAdapter, 'mr_terminal_commit')).toMatchObject({
          status: 'committed',
          completion_summary: committed.completion_summary,
          error_summary: null,
          completed_at: committed.completed_at,
        });
      });

      it('does not allow a failed run to be committed later', () => {
        const scopedAdapter = createAdapter(tempDbPath('failed-terminal'));
        beginModelRunInAdapter(scopedAdapter, {
          model_run_id: 'mr_terminal_fail',
          created_at: 9_000,
        });

        const failed = failModelRunInAdapter(scopedAdapter, 'mr_terminal_fail', 'alias failed');

        expect(() =>
          commitModelRunInAdapter(scopedAdapter, 'mr_terminal_fail', 'late success')
        ).toThrow(/already failed/);
        expect(getModelRunInAdapter(scopedAdapter, 'mr_terminal_fail')).toMatchObject({
          status: 'failed',
          completion_summary: null,
          error_summary: failed.error_summary,
          completed_at: failed.completed_at,
        });
      });
    });
  });
});
