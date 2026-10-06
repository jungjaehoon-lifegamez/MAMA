import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import {
  NativeSessionUnavailableError,
  type IModelRunner,
  type PromptResult,
} from '../../src/runtime/drivers/types.js';
import { beginModelRun, commitModelRun, failModelRun } from '../../src/runtime/model-run-store.js';
import {
  createNativeSessionRunner,
  type NativeModelRunPort,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';

const migrations = join(__dirname, '../../db/migrations');
const fields = {
  input_tokens: 12,
  cache_read_input_tokens: 90,
  cache_creation_input_tokens: 7,
  output_tokens: 5,
  compaction_count: 1,
};
const unknownUsage = Object.fromEntries(Object.keys(fields).map((key) => [key, null]));

function database(version = 101) {
  const db = new Database(':memory:');
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()) {
    if (Number(file.slice(0, 3)) <= version) db.exec(readFileSync(join(migrations, file), 'utf8'));
  }
  return db;
}

function runner(db: Database.Database, prompt: IModelRunner['prompt']) {
  const pool = new SessionPool();
  const port: NativeModelRunPort = {
    begin: async () => beginModelRun(db, { model_run_id: 'run-usage' }).model_run_id,
    commit: async (...args) => {
      commitModelRun(db, ...args);
    },
    fail: async (...args) => {
      failModelRun(db, ...args);
    },
  };
  return {
    pool,
    native: createNativeSessionRunner({
      agent: { backendType: 'claude', reportsModelRuns: true, prompt } as IModelRunner,
      backend: 'claude',
      model: 'fixture-model',
      maxTurns: 10,
      isGatewayMode: true,
      runTokenBudget: 0,
      sessionPool: pool,
      turnPolicy: () => ({ channelKey: 'fixture-lane', systemLayers: [] }),
      executionContext: () => null,
      hostToolDefinitions: () => [],
      callTool: async () => ({ success: true }),
      modelRun: port,
    }),
  };
}

describe('per-run usage', () => {
  it.each([false, true])('records rejected prompt usage after session reset=%s', async (reset) => {
    const db = database();
    const error = Object.assign(new Error('fixture backend failure'), { usage: fields });
    let attempts = 0;
    const h = runner(db, async () => {
      if (reset && attempts++ === 0)
        throw new NativeSessionUnavailableError('fixture missing session');
      throw error;
    });
    try {
      await expect(h.native.runTurn([{ type: 'text', text: 'fixture' }])).rejects.toThrow(
        'fixture backend failure'
      );
      expect(db.prepare('SELECT * FROM model_runs').get()).toMatchObject({
        status: 'failed',
        token_count: 17,
        ...fields,
      });
    } finally {
      h.pool.dispose();
      db.close();
    }
  });

  it.each(['committed', 'failed'] as const)(
    'preserves usage on an identical %s replay and rejects changed usage',
    (status) => {
      const db = database();
      try {
        const id = beginModelRun(db, {}).model_run_id;
        const finish = status === 'committed' ? commitModelRun : failModelRun;
        const first = finish(db, id, 'fixture', 17, fields);
        expect(finish(db, id, 'fixture', 17, fields)).toEqual(first);
        expect(() => finish(db, id, 'fixture', 17, { ...fields, compaction_count: 2 })).toThrow(
          'different compaction_count'
        );
      } finally {
        db.close();
      }
    }
  );
  it('migrates a database at 100 and leaves existing usage NULL', () => {
    const db = database(100);
    try {
      db.prepare(
        "INSERT INTO model_runs (model_run_id, status, token_count, created_at) VALUES ('old', 'committed', 23, 1)"
      ).run();
      for (const file of readdirSync(migrations).filter((name) => name.startsWith('101-'))) {
        db.exec(readFileSync(join(migrations, file), 'utf8'));
      }
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: 101,
      });
      expect(db.prepare("SELECT * FROM model_runs WHERE model_run_id = 'old'").get()).toMatchObject(
        { token_count: 23, ...unknownUsage }
      );
    } finally {
      db.close();
    }
  });

  it.each(['success', 'error'] as const)(
    'records Claude %s stream cache usage and one compact boundary, then resets the next prompt',
    async (outcome) => {
      const proc = new PersistentClaudeProcess({
        sessionId: 'fixture-session',
        workspaceDir: '/tmp/fixture-workspace',
      });
      const child = new EventEmitter();
      Object.assign(child, { stdin: { writable: true, write: () => true } });
      const internal = proc as unknown as {
        process: EventEmitter;
        state: string;
        handleStdout(chunk: Buffer): void;
      };
      internal.process = child;
      internal.state = 'idle';
      const emit = (event: unknown) =>
        internal.handleStdout(Buffer.from(`${JSON.stringify(event)}\n`));
      const db = database();
      const h = runner(db, async () => {
        const pending = proc.sendMessage('fixture');
        emit({ type: 'system', subtype: 'compact_boundary' });
        emit({
          type: 'result',
          subtype: outcome,
          result: 'done',
          error: 'fixture backend failure',
          usage: fields,
        });
        return pending;
      });
      try {
        const turn = h.native.runTurn([{ type: 'text', text: 'fixture' }]);
        if (outcome === 'success') await turn;
        else await expect(turn).rejects.toThrow('fixture backend failure');
        expect(db.prepare('SELECT * FROM model_runs').get()).toMatchObject({
          status: outcome === 'success' ? 'committed' : 'failed',
          token_count: 17,
          ...fields,
        });
        const next = proc.sendMessage('next');
        emit({
          type: 'result',
          subtype: 'success',
          result: 'done',
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        expect((await next).usage).toMatchObject({
          input_tokens: 0,
          output_tokens: 0,
          compaction_count: 0,
        });
      } finally {
        h.pool.dispose();
        db.close();
      }
    }
  );

  it('keeps unreported token fields NULL on a completed prompt', async () => {
    const db = database();
    const h = runner(
      db,
      async () => ({ response: 'done', session_id: 'fixture', usage: {} }) as PromptResult
    );
    try {
      await h.native.runTurn([{ type: 'text', text: 'fixture' }]);
      expect(db.prepare('SELECT * FROM model_runs').get()).toMatchObject(unknownUsage);
    } finally {
      h.pool.dispose();
      db.close();
    }
  });

  it('passes measured usage through the fail port after a terminal prompt error', async () => {
    const db = database();
    const h = runner(
      db,
      async () =>
        ({
          response: '',
          session_id: 'fixture',
          usage: fields,
          terminalError: { code: 'HOST_TOOL_OUTCOME_UNCERTAIN', message: 'fixture terminal error' },
        }) as PromptResult
    );
    try {
      await expect(h.native.runTurn([{ type: 'text', text: 'fixture' }])).rejects.toThrow(
        'fixture terminal error'
      );
      expect(db.prepare('SELECT * FROM model_runs').get()).toMatchObject({
        status: 'failed',
        token_count: 17,
        ...fields,
      });
    } finally {
      h.pool.dispose();
      db.close();
    }
  });
});
