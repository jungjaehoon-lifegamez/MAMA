import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
type ModelRunAdapterForTest = Parameters<typeof beginModelRunInAdapter>[0];
type RunResultForTest = ReturnType<ReturnType<ModelRunAdapterForTest['prepare']>['run']>;

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

class FakeModelRunStatement {
  constructor(
    private readonly behavior: {
      get?: (...params: unknown[]) => object | undefined;
      run?: (...params: unknown[]) => RunResultForTest;
    }
  ) {}

  all(): object[] {
    return [];
  }

  get(...params: unknown[]): object | undefined {
    return this.behavior.get?.(...params);
  }

  run(...params: unknown[]): RunResultForTest {
    if (!this.behavior.run) {
      return { changes: 0, lastInsertRowid: 0 };
    }
    return this.behavior.run(...params);
  }

  finalize(): void {
    // fake statement does not hold native resources
  }
}

function modelRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_run_id: 'mr_fake',
    model_id: null,
    model_provider: null,
    prompt_version: null,
    tool_manifest_version: null,
    output_schema_version: null,
    agent_id: 'agent-fake',
    instance_id: null,
    envelope_hash: 'env_fake',
    parent_model_run_id: null,
    input_snapshot_ref: null,
    input_refs_json: JSON.stringify({ request_idempotency_key: 'fake-key' }),
    completion_summary: null,
    status: 'running',
    error_summary: null,
    token_count: 0,
    cost_estimate: null,
    created_at: 10_000,
    completed_at: null,
    ...overrides,
  };
}

describe('Story M5/M6: Adapter-scoped model run helpers', () => {
  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    vi.restoreAllMocks();
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

      it('replays matching deterministic ids when created_at was omitted', () => {
        const scopedAdapter = createAdapter(tempDbPath('no-created-at'));
        vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(10_050);
        const input = {
          model_run_id: 'mr_direct_no_created_at',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_no_created_at',
          input_refs: {
            tool: 'entity.alias',
            request_idempotency_key: 'alias-key-no-created-at',
          },
        };

        const first = beginModelRunInAdapter(scopedAdapter, input);
        const replay = beginModelRunInAdapter(scopedAdapter, input);

        expect(replay).toEqual(first);
        expect(replay.created_at).toBe(10_000);
      });

      it('allows partial deterministic replays when the stable envelope matches', () => {
        const scopedAdapter = createAdapter(tempDbPath('partial-envelope-replay'));
        const input = {
          model_run_id: 'mr_partial_envelope_replay',
          model_id: 'gpt-5.4',
          model_provider: 'openai',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_partial_replay',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_partial',
            request_idempotency_key: 'alias-key-partial',
          },
          token_count: 42,
          cost_estimate: 0.25,
          created_at: 4_250,
        };

        const first = beginModelRunInAdapter(scopedAdapter, input);
        const replay = beginModelRunInAdapter(scopedAdapter, {
          model_run_id: input.model_run_id,
          envelope_hash: input.envelope_hash,
        });

        expect(replay).toEqual(first);
      });

      it('allows partial deterministic replays when stable input refs are the discriminator', () => {
        const scopedAdapter = createAdapter(tempDbPath('partial-stable-input-ref-replay'));
        const input = {
          model_run_id: 'mr_partial_stable_input_ref_replay',
          model_id: 'gpt-5.4',
          model_provider: 'openai',
          agent_id: 'agent-alias',
          input_refs: {
            request_idempotency_key: 'alias-key-partial-stable-input-ref',
          },
          token_count: 42,
          cost_estimate: 0.25,
          created_at: 4_275,
        };

        const first = beginModelRunInAdapter(scopedAdapter, input);
        const replay = beginModelRunInAdapter(scopedAdapter, {
          model_run_id: input.model_run_id,
          input_refs: input.input_refs,
        });

        expect(replay).toEqual(first);
      });

      it('compares replay input refs canonically instead of by raw JSON text', () => {
        const scopedAdapter = createAdapter(tempDbPath('canonical-input-refs'));
        const input = {
          model_run_id: 'mr_canonical_input_refs',
          agent_id: 'agent-alias',
          input_refs_json:
            '{"request_idempotency_key":"alias-key-canonical","entity_id":"entity_1"}',
          created_at: 4_300,
        };

        const first = beginModelRunInAdapter(scopedAdapter, input);
        const replay = beginModelRunInAdapter(scopedAdapter, {
          ...input,
          input_refs_json:
            '{\n  "entity_id": "entity_1",\n  "request_idempotency_key": "alias-key-canonical"\n}',
        });

        expect(replay).toEqual(first);
        expect(() =>
          beginModelRunInAdapter(scopedAdapter, {
            ...input,
            input_refs_json:
              '{"request_idempotency_key":"alias-key-canonical","entity_id":"entity_changed"}',
          })
        ).toThrow(/different input_refs_json/);
      });

      it('preserves __proto__ as an own input ref key during canonical comparison', () => {
        const scopedAdapter = createAdapter(tempDbPath('canonical-proto-input-refs'));
        const input = {
          model_run_id: 'mr_canonical_proto_input_refs',
          input_refs_json: '{"__proto__":{"request_idempotency_key":"proto-key-original"}}',
          created_at: 4_400,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        expect(() =>
          beginModelRunInAdapter(scopedAdapter, {
            ...input,
            input_refs_json: '{"__proto__":{"request_idempotency_key":"proto-key-changed"}}',
          })
        ).toThrow(/different input_refs_json/);
      });

      it('replays matching begin input after the run reaches a terminal status', () => {
        const scopedAdapter = createAdapter(tempDbPath('terminal-replay'));
        const input = {
          model_run_id: 'mr_terminal_replay',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_terminal_replay',
          input_refs: {
            tool: 'entity.alias',
            request_idempotency_key: 'alias-key-terminal-replay',
          },
          created_at: 4_500,
        };

        beginModelRunInAdapter(scopedAdapter, input);
        const committed = commitModelRunInAdapter(scopedAdapter, input.model_run_id, 'done');

        expect(beginModelRunInAdapter(scopedAdapter, input)).toEqual(committed);
      });

      it('replays matching begin input after the run fails', () => {
        const scopedAdapter = createAdapter(tempDbPath('failed-terminal-replay'));
        const input = {
          model_run_id: 'mr_failed_terminal_replay',
          agent_id: 'agent-alias',
          envelope_hash: 'env_alias_failed_terminal_replay',
          input_refs: {
            tool: 'entity.alias',
            request_idempotency_key: 'alias-key-failed-terminal-replay',
          },
          created_at: 4_750,
        };

        beginModelRunInAdapter(scopedAdapter, input);
        const failed = failModelRunInAdapter(scopedAdapter, input.model_run_id, 'model failed');

        expect(beginModelRunInAdapter(scopedAdapter, input)).toEqual(failed);
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

      it('rejects empty input refs as an idempotency discriminator', () => {
        const scopedAdapter = createAdapter(tempDbPath('empty-input-refs'));
        const input = {
          model_run_id: 'mr_empty_input_refs',
          input_refs: {},
          created_at: 5_500,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        expect(() => beginModelRunInAdapter(scopedAdapter, input)).toThrow(
          /idempotency discriminator/
        );
      });

      it('rejects empty stable input ref values as idempotency discriminators', () => {
        const scopedAdapter = createAdapter(tempDbPath('empty-stable-input-ref-values'));
        const cases = [
          ['empty_string', ''],
          ['blank_string', '  '],
          ['empty_object', {}],
          ['empty_array', []],
        ] as const;

        for (const [label, requestIdempotencyKey] of cases) {
          const input = {
            model_run_id: `mr_empty_stable_input_ref_${label}`,
            input_refs: { request_idempotency_key: requestIdempotencyKey },
            created_at: 5_600,
          };

          beginModelRunInAdapter(scopedAdapter, input);

          expect(() => beginModelRunInAdapter(scopedAdapter, input)).toThrow(
            /idempotency discriminator/
          );
        }
      });

      it('rejects non-empty unstable input refs as idempotency discriminators', () => {
        const scopedAdapter = createAdapter(tempDbPath('unstable-input-refs'));
        const input = {
          model_run_id: 'mr_unstable_input_refs',
          input_refs: {
            tool: 'entity.alias',
            entity_id: 'entity_unstable',
          },
          created_at: 5_750,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        expect(() => beginModelRunInAdapter(scopedAdapter, input)).toThrow(
          /idempotency discriminator/
        );
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

      it('rejects explicitly replayed error summary conflicts for non-running begin rows', () => {
        const scopedAdapter = createAdapter(tempDbPath('error-summary-conflict'));
        const input = {
          model_run_id: 'mr_error_summary_conflict',
          envelope_hash: 'env_error_summary_conflict',
          input_refs: { request_idempotency_key: 'error-summary-conflict-key' },
          status: 'failed' as const,
          error_summary: 'original failure',
          created_at: 6_250,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        expect(() =>
          beginModelRunInAdapter(scopedAdapter, {
            ...input,
            error_summary: 'changed failure',
          })
        ).toThrow(/different error_summary/);
        expect(() =>
          beginModelRunInAdapter(scopedAdapter, {
            model_run_id: input.model_run_id,
            envelope_hash: input.envelope_hash,
            error_summary: 'changed failure without status',
          })
        ).toThrow(/different error_summary/);
      });

      it('rejects conflicts for every explicitly replayed stable begin field', () => {
        const scopedAdapter = createAdapter(tempDbPath('all-stable-field-conflicts'));
        const input = {
          model_run_id: 'mr_all_stable_field_conflicts',
          model_id: 'model-original',
          model_provider: 'provider-original',
          prompt_version: 'prompt-original',
          tool_manifest_version: 'tool-original',
          output_schema_version: 'schema-original',
          agent_id: 'agent-original',
          instance_id: 'instance-original',
          envelope_hash: 'env_all_stable_field_conflicts',
          parent_model_run_id: 'parent-original',
          input_snapshot_ref: 'snapshot-original',
          input_refs_json:
            '{"request_idempotency_key":"stable-field-key","entity_id":"entity_original"}',
          token_count: 12,
          cost_estimate: 0.12,
          created_at: 6_500,
        };

        beginModelRunInAdapter(scopedAdapter, input);

        for (const conflictingInput of [
          { ...input, model_id: 'model-changed' },
          { ...input, model_provider: 'provider-changed' },
          { ...input, prompt_version: 'prompt-changed' },
          { ...input, tool_manifest_version: 'tool-changed' },
          { ...input, output_schema_version: 'schema-changed' },
          { ...input, agent_id: 'agent-changed' },
          { ...input, instance_id: 'instance-changed' },
          { ...input, parent_model_run_id: 'parent-changed' },
          { ...input, input_snapshot_ref: 'snapshot-changed' },
          { ...input, cost_estimate: 0.13 },
        ]) {
          expect(() => beginModelRunInAdapter(scopedAdapter, conflictingInput)).toThrow(
            /Model run already exists/
          );
        }
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

      it('rethrows non-duplicate insert errors instead of treating them as replay success', () => {
        let selectCount = 0;
        const adapter: ModelRunAdapterForTest = {
          prepare(sql: string) {
            if (/FROM model_runs/i.test(sql)) {
              return new FakeModelRunStatement({
                get() {
                  selectCount += 1;
                  return selectCount === 1 ? undefined : modelRunRow();
                },
              });
            }
            if (/INSERT INTO model_runs/i.test(sql)) {
              return new FakeModelRunStatement({
                run() {
                  throw new Error('SQLITE_BUSY: database is locked');
                },
              });
            }
            throw new Error(`Unexpected SQL in fake adapter: ${sql}`);
          },
        };

        expect(() =>
          beginModelRunInAdapter(adapter, {
            model_run_id: 'mr_fake',
            agent_id: 'agent-fake',
            envelope_hash: 'env_fake',
            input_refs: { request_idempotency_key: 'fake-key' },
            created_at: 10_000,
          })
        ).toThrow(/SQLITE_BUSY/);
        expect(selectCount).toBe(1);
      });

      it('recovers matching duplicate insert errors by replaying the row inserted by a race', () => {
        let selectCount = 0;
        let insertCount = 0;
        const adapter: ModelRunAdapterForTest = {
          prepare(sql: string) {
            if (/FROM model_runs/i.test(sql)) {
              return new FakeModelRunStatement({
                get() {
                  selectCount += 1;
                  return selectCount === 1 ? undefined : modelRunRow();
                },
              });
            }
            if (/INSERT INTO model_runs/i.test(sql)) {
              return new FakeModelRunStatement({
                run() {
                  insertCount += 1;
                  throw new Error(
                    'SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed: model_runs.model_run_id'
                  );
                },
              });
            }
            throw new Error(`Unexpected SQL in fake adapter: ${sql}`);
          },
        };

        const replay = beginModelRunInAdapter(adapter, {
          model_run_id: 'mr_fake',
          agent_id: 'agent-fake',
          envelope_hash: 'env_fake',
          input_refs: { request_idempotency_key: 'fake-key' },
          created_at: 10_000,
        });

        expect(replay).toMatchObject({
          model_run_id: 'mr_fake',
          agent_id: 'agent-fake',
          envelope_hash: 'env_fake',
          input_refs: { request_idempotency_key: 'fake-key' },
          status: 'running',
        });
        expect(selectCount).toBe(2);
        expect(insertCount).toBe(1);
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
        expect(
          commitModelRunInAdapter(scopedAdapter, 'mr_terminal_commit', 'packet generated')
        ).toEqual(committed);
        expect(() =>
          commitModelRunInAdapter(scopedAdapter, 'mr_terminal_commit', 'changed summary')
        ).toThrow(/different completion_summary/);
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
        expect(failModelRunInAdapter(scopedAdapter, 'mr_terminal_fail', 'alias failed')).toEqual(
          failed
        );
        expect(() =>
          failModelRunInAdapter(scopedAdapter, 'mr_terminal_fail', 'changed failure')
        ).toThrow(/different error_summary/);
      });
    });
  });
});
