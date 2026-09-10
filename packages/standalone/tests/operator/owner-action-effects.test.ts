import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import {
  OwnerActionEffectLedger,
  type OwnerActionContext,
} from '../../src/operator/owner-action-effects.js';
import { OwnerEventEffectLedger } from '../../src/operator/owner-event-effects.js';
import { applyOwnerActionEffectsMigration } from '../../src/db/migrations/owner-action-effects.js';

const databases: SQLiteDatabase[] = [];
const directories: string[] = [];
const context: OwnerActionContext = {
  ownerScope: 'owner:test-project',
  occurrenceKey: 'request:42',
  modelRunId: 'mr-first',
  envelopeHash: 'envelope-first',
};
const retry: OwnerActionContext = {
  ...context,
  modelRunId: 'mr-retry',
  envelopeHash: 'envelope-retry',
};
const intent = { destination: 'test-owner', text: 'observed result' };
function open(path = ':memory:') {
  const database = new Database(path);
  databases.push(database);
  return { database, ledger: new OwnerActionEffectLedger(database, () => 1000) };
}
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Story TG-04/TG-06: owner action receipts independent of input path', () => {
  it('AC: only the originating run can release a transmitting no-effect reservation', () => {
    const { ledger } = open();
    ledger.begin(context, 'preflight', 'slack_send', intent);
    expect(() => ledger.releaseUnstarted(retry, 'preflight', 'slack_send')).toThrow(
      /current unstarted/
    );
    ledger.releaseUnstarted(context, 'preflight', 'slack_send');
    expect(ledger.inspect(context, 'preflight', 'slack_send')).toBeNull();
    expect(ledger.begin(retry, 'preflight', 'slack_send', intent).state).toBe('execute');
    ledger.confirm(retry, 'preflight', 'slack_send', { messageId: 'confirmed' });
    expect(() => ledger.releaseUnstarted(retry, 'preflight', 'slack_send')).toThrow(
      /current unstarted/
    );
    expect(ledger.inspect(context, 'preflight', 'slack_send')?.state).toBe('confirmed');
  });

  it('settles an identical receipt while another connection is committing it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-effect-race-'));
    directories.push(directory);
    const path = join(directory, 'effects.db');
    const { database, ledger } = open(path);
    database.pragma('journal_mode = WAL');
    ledger.begin(context, 'race', 'telegram_send', intent);
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const Db = require(workerData.module);
      const db = new Db(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE owner_action_effects SET status = 'confirmed', result_json = ? WHERE action_key = 'race'").run(JSON.stringify({ messageId: 'same' }));
      parentPort.postMessage('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);
    `,
      {
        eval: true,
        workerData: { path, module: createRequire(import.meta.url).resolve('better-sqlite3') },
      }
    );
    const exited = once(worker, 'exit');
    try {
      await once(worker, 'message');
      expect(() =>
        ledger.confirm(retry, 'race', 'telegram_send', { messageId: 'same' })
      ).not.toThrow();
      await exited;
    } finally {
      await worker.terminate();
    }
  });
  describe('AC: one stable action executes once across model attempts', () => {
    it('reserves before execution and reconciles an unfinished retry', () => {
      const { ledger } = open();
      expect(ledger.begin(context, 'summary', 'telegram_send', intent)).toMatchObject({
        state: 'execute',
      });
      expect(ledger.begin(retry, 'summary', 'telegram_send', intent)).toMatchObject({
        state: 'reconcile',
        intent,
      });
      ledger.confirm(context, 'summary', 'telegram_send', { deliveryId: 'delivery-1' });
      expect(ledger.begin(retry, 'summary', 'telegram_send', intent)).toMatchObject({
        state: 'confirmed',
        result: { deliveryId: 'delivery-1' },
      });
    });

    it('rejects changed payload or kind instead of creating another effect', () => {
      const { ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      expect(() =>
        ledger.begin(retry, 'summary', 'telegram_send', { ...intent, text: 'different' })
      ).toThrow(/intent|payload/i);
      expect(() => ledger.begin(retry, 'summary', 'drive_upload', intent)).toThrow(/kind|bound/i);
    });

    it('supports distinct logical actions without a one-action-per-kind ceiling', () => {
      const { ledger } = open();
      ledger.begin(context, 'first-file', 'Write', { path: 'exports/one.md', contentHash: 'one' });
      expect(
        ledger.begin(context, 'second-file', 'Write', {
          path: 'exports/two.md',
          contentHash: 'two',
        })
      ).toMatchObject({ state: 'execute' });
    });
  });

  describe('AC: ambiguous effects never become permission to replay', () => {
    it('keeps a shell effect reconcile-only after unknown settlement', () => {
      const { ledger } = open();
      ledger.begin(context, 'command', 'Bash', { commandHash: 'opaque-command-hash' });
      ledger.markUnknown(context, 'command', 'Bash', 'transport interrupted');
      expect(
        ledger.begin(retry, 'command', 'Bash', { commandHash: 'opaque-command-hash' })
      ).toMatchObject({ state: 'reconcile' });
    });

    it('persists an unfinished effect across closing and reopening the database', () => {
      const directory = mkdtempSync(join(tmpdir(), 'mama-owner-effects-'));
      directories.push(directory);
      const path = join(directory, 'effects.db');
      const first = open(path);
      first.ledger.begin(context, 'upload', 'drive_upload', {
        fileHash: 'file-one',
        destination: 'folder-one',
      });
      first.database.close();
      databases.splice(databases.indexOf(first.database), 1);
      const second = open(path);
      expect(
        second.ledger.begin(retry, 'upload', 'drive_upload', {
          fileHash: 'file-one',
          destination: 'folder-one',
        })
      ).toMatchObject({ state: 'reconcile' });
    });
  });

  describe('AC: receipt identity and owner namespaces remain immutable', () => {
    it('does not expose an occurrence from another owner namespace', () => {
      const { ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      expect(
        ledger.inspect({ ...context, ownerScope: 'other-owner' }, 'summary', 'telegram_send')
      ).toBeNull();
    });

    it('rejects fabricated confirmation and replacement of a confirmed receipt', () => {
      const { ledger } = open();
      expect(() =>
        ledger.confirm(context, 'missing', 'telegram_send', { deliveryId: 'invented' })
      ).toThrow();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      ledger.confirm(context, 'summary', 'telegram_send', { deliveryId: 'first' });
      expect(() =>
        ledger.confirm(retry, 'summary', 'telegram_send', { deliveryId: 'second' })
      ).toThrow(/receipt|result|confirm/i);
    });

    it('returns the same receipt for a repeated identical confirmation', () => {
      const { ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      ledger.confirm(context, 'summary', 'telegram_send', { deliveryId: 'first', b: 1, a: 2 });
      expect(() =>
        ledger.confirm(retry, 'summary', 'telegram_send', { a: 2, deliveryId: 'first', b: 1 })
      ).not.toThrow();
      expect(ledger.inspect(retry, 'summary', 'telegram_send')).toMatchObject({
        state: 'confirmed',
        result: { deliveryId: 'first', a: 2, b: 1 },
      });
    });

    it('treats key order as the same intent and a nested change as a conflict', () => {
      const { ledger } = open();
      ledger.begin(context, 'upload', 'drive_upload', {
        destination: 'folder-one',
        meta: { b: 1, a: [1, { y: 2, x: 1 }] },
      });
      expect(
        ledger.begin(retry, 'upload', 'drive_upload', {
          meta: { a: [1, { x: 1, y: 2 }], b: 1 },
          destination: 'folder-one',
        })
      ).toMatchObject({ state: 'reconcile' });
      expect(() =>
        ledger.begin(retry, 'upload', 'drive_upload', {
          meta: { a: [{ x: 1, y: 2 }, 1], b: 1 },
          destination: 'folder-one',
        })
      ).toThrow(/intent|payload/i);
    });

    it('keys effects by occurrence, so the same action key on another occurrence executes', () => {
      const { ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      expect(
        ledger.begin(
          { ...context, occurrenceKey: 'request:43' },
          'summary',
          'telegram_send',
          intent
        )
      ).toMatchObject({ state: 'execute' });
      // A different attempt id on the same occurrence still reconciles the original.
      expect(
        ledger.begin({ ...retry, workOrderAttemptId: 7 }, 'summary', 'telegram_send', intent)
      ).toMatchObject({ state: 'reconcile' });
    });

    it('refuses blank or non-string host identities and a bad attempt id', () => {
      const { ledger } = open();
      const cases: Array<Partial<Record<keyof OwnerActionContext, unknown>>> = [
        { ownerScope: '' },
        { ownerScope: '   ' },
        { occurrenceKey: '' },
        { modelRunId: ' mr ' },
        { envelopeHash: undefined },
        { ownerScope: 42 },
        { workOrderAttemptId: 0 },
        { workOrderAttemptId: 1.5 },
      ];
      for (const override of cases) {
        expect(() =>
          ledger.begin({ ...context, ...override } as OwnerActionContext, 'k', 'Bash', {})
        ).toThrow(/owner action/);
      }
      expect(() => ledger.begin(context, '', 'Bash', {})).toThrow(/actionKey/);
      expect(() => ledger.begin(context, 'k', ' ', {})).toThrow(/effectKind/);
      expect(() => ledger.begin(context, 'k', 'Bash', [] as never)).toThrow(/plain JSON object/);
      expect(() => ledger.begin(context, 'k', 'Bash', { f: () => 1 } as never)).toThrow(
        /JSON-representable/
      );
      expect(ledger.pending(context).items).toEqual([]);
    });
  });

  describe('AC: unknown is an observation, never permission', () => {
    it('refuses markUnknown on a missing or confirmed effect and keeps kind binding', () => {
      const { ledger } = open();
      expect(() => ledger.markUnknown(context, 'missing', 'Bash', 'x')).toThrow(/not reserved/i);
      ledger.begin(context, 'command', 'Bash', { commandHash: 'h' });
      expect(() => ledger.markUnknown(context, 'command', 'Write', 'x')).toThrow(/bound/i);
      ledger.markUnknown(context, 'command', 'Bash', 'transport interrupted');
      // An unknown effect whose real outcome is later proven can still confirm...
      ledger.confirm(retry, 'command', 'Bash', { exitCode: 0 });
      expect(ledger.inspect(context, 'command', 'Bash')).toMatchObject({
        state: 'confirmed',
        result: { exitCode: 0 },
      });
      // ...but a confirmed receipt is never demoted back to unknown.
      expect(() => ledger.markUnknown(retry, 'command', 'Bash', 'late doubt')).toThrow(
        /confirmed receipt/i
      );
      expect(ledger.begin(retry, 'command', 'Bash', { commandHash: 'h' })).toMatchObject({
        state: 'confirmed',
      });
    });

    it('inspect refuses a kind mismatch and stays scoped to the owner namespace', () => {
      const { ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      expect(() => ledger.inspect(context, 'summary', 'drive_upload')).toThrow(/bound/i);
      expect(() =>
        ledger.confirm({ ...context, ownerScope: 'other-owner' }, 'summary', 'telegram_send', {
          deliveryId: 'stolen',
        })
      ).toThrow(/not reserved/i);
      expect(ledger.inspect(context, 'summary', 'telegram_send')).toMatchObject({
        state: 'reconcile',
      });
    });
  });

  describe('AC: bounded pending read for the retry handler', () => {
    it('lists unsettled effects with paging, without intent bodies, per owner namespace', () => {
      let tick = 0;
      const database = new Database(':memory:');
      databases.push(database);
      const ledger = new OwnerActionEffectLedger(database, () => 1000 + tick++);
      ledger.begin(context, 'a-send', 'telegram_send', { secret: 'do not list' });
      ledger.begin(context, 'b-write', 'Write', { path: 'exports/one.md' });
      ledger.begin(context, 'c-shell', 'Bash', { commandHash: 'h' });
      ledger.begin(context, 'd-done', 'drive_upload', { fileHash: 'f' });
      ledger.confirm(context, 'd-done', 'drive_upload', { fileId: 'x' });
      ledger.markUnknown(retry, 'c-shell', 'Bash', 'interrupted');
      ledger.begin({ ...context, ownerScope: 'other-owner' }, 'z', 'Bash', { commandHash: 'z' });

      const first = ledger.pending(retry, { limit: 2 });
      expect(first).toEqual({
        items: [
          {
            actionKey: 'a-send',
            effectKind: 'telegram_send',
            state: 'transmitting',
            originModelRunId: 'mr-first',
          },
          {
            actionKey: 'b-write',
            effectKind: 'Write',
            state: 'transmitting',
            originModelRunId: 'mr-first',
          },
        ],
        nextCursor: { createdAt: expect.any(Number), actionKey: 'b-write' },
      });
      ledger.confirm(context, 'a-send', 'telegram_send', { deliveryId: 'confirmed-between-pages' });
      const second = ledger.pending(retry, { limit: 2, cursor: first.nextCursor! });
      expect(second).toEqual({
        items: [
          {
            actionKey: 'c-shell',
            effectKind: 'Bash',
            state: 'unknown',
            originModelRunId: 'mr-first',
          },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify([first, second])).not.toContain('do not list');
      expect(ledger.pending({ ...context, ownerScope: 'other-owner' }).items).toHaveLength(1);
      expect(() => ledger.pending(context, { limit: 0 })).toThrow(/limit/);
      expect(() => ledger.pending(context, { cursor: { createdAt: NaN, actionKey: 'a' } })).toThrow(
        /cursor/
      );
    });
  });

  describe('AC: additive migration, idempotent open, legacy receipts untouched', () => {
    it('rejects a same-column table that omitted receipt identity constraints', () => {
      const { database } = open();
      const schema = database
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'owner_action_effects'")
        .get() as { sql: string };
      database.exec('DROP TABLE owner_action_effects');
      database.exec(
        schema.sql.replace(/,\s*PRIMARY KEY \(owner_scope, occurrence_key, action_key\)/, '')
      );
      expect(() => applyOwnerActionEffectsMigration(database)).toThrow(/primary key|constraint/i);
    });

    it('prevents raw SQL from replacing or deleting a confirmed receipt', () => {
      const { database, ledger } = open();
      ledger.begin(context, 'immutable', 'telegram_send', intent);
      ledger.confirm(context, 'immutable', 'telegram_send', { messageId: 'original' });
      expect(() =>
        database.exec(
          "UPDATE owner_action_effects SET result_json = '{}' WHERE action_key = 'immutable'"
        )
      ).toThrow(/immutable/i);
      expect(() =>
        database.exec("DELETE FROM owner_action_effects WHERE action_key = 'immutable'")
      ).toThrow(/immutable/i);
    });
    it('applies idempotently and leaves owner_event_effects rows and schema alone', () => {
      const database = new Database(':memory:');
      databases.push(database);
      const legacy = new OwnerEventEffectLedger(database, () => 500);
      legacy.begin(7, 'telegram-delivery', 'telegram_send', { chatId: 'c', deliveryId: 'd' });
      const legacySchemaBefore = database
        .prepare(`SELECT sql FROM sqlite_master WHERE name = 'owner_event_effects'`)
        .get();

      applyOwnerActionEffectsMigration(database);
      applyOwnerActionEffectsMigration(database);
      const ledger = new OwnerActionEffectLedger(database, () => 1000);
      new OwnerActionEffectLedger(database, () => 1000);
      ledger.begin(context, 'summary', 'telegram_send', intent);

      expect(
        database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'owner_event_effects'`).get()
      ).toEqual(legacySchemaBefore);
      expect(legacy.inspect(7, 'telegram-delivery', 'telegram_send')).toMatchObject({
        state: 'reconcile',
      });
      expect(database.prepare(`SELECT COUNT(*) AS n FROM owner_event_effects`).get()).toEqual({
        n: 1,
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'owner_action_effects'`
          )
          .get()
      ).toEqual({ n: 1 });
      // The legacy integer batch key is not an owner occurrence: nothing leaked across.
      expect(
        ledger.inspect({ ...context, occurrenceKey: '7' }, 'telegram-delivery', 'telegram_send')
      ).toBeNull();
    });

    it('records the originating run for audit and the settling run on confirmation', () => {
      const { database, ledger } = open();
      ledger.begin(context, 'summary', 'telegram_send', intent);
      ledger.confirm(retry, 'summary', 'telegram_send', { deliveryId: 'first' });
      expect(
        database
          .prepare(
            `SELECT origin_model_run_id, origin_envelope_hash, settled_model_run_id, status
               FROM owner_action_effects WHERE owner_scope = ? AND occurrence_key = ? AND action_key = ?`
          )
          .get(context.ownerScope, context.occurrenceKey, 'summary')
      ).toEqual({
        origin_model_run_id: 'mr-first',
        origin_envelope_hash: 'envelope-first',
        settled_model_run_id: 'mr-retry',
        status: 'confirmed',
      });
    });
  });
});

describe('interrupted native run does not poison replay', () => {
  const occurrence = 'owner-report:digest:interrupted';
  const ctx: OwnerActionContext = { ...context, occurrenceKey: occurrence };
  it('allows replay when the only non-confirmed row is the native_run marker', () => {
    const { ledger, database } = open();
    ledger.begin(ctx, 'native-run:abc', 'native_run', { admitted: true });
    ledger.markUnknown(ctx, 'native-run:abc', 'native_run', 'native turn did not finish cleanly');
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(false);
    expect(ledger.hasUnsettledEffects(occurrence)).toBe(false);
    // Replay admits a new marker under the new run id and leaves the old observation.
    const next: OwnerActionContext = { ...ctx, modelRunId: 'mr-replay', envelopeHash: 'env-replay' };
    expect(ledger.begin(next, 'native-run:def', 'native_run', { admitted: true }).state).toBe(
      'execute'
    );
    expect(
      database
        .prepare(
          "SELECT status FROM owner_action_effects WHERE action_key = 'native-run:abc'"
        )
        .get()
    ).toEqual({ status: 'unknown' });
  });
  it('stays blocked when a real effect of the interrupted run is unproven', () => {
    const { ledger } = open();
    ledger.begin(ctx, 'native-run:abc', 'native_run', { admitted: true });
    ledger.markUnknown(ctx, 'native-run:abc', 'native_run', 'native turn did not finish cleanly');
    ledger.begin(ctx, 'bash:1', 'Bash', { command: 'printf x' });
    ledger.markUnknown(ctx, 'bash:1', 'Bash', 'shell outcome unknown');
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(true);
    expect(ledger.hasUnsettledEffects(occurrence)).toBe(true);
  });
  it('does not block replay on a confirmed delegation spawn observed as native_tool', () => {
    const { ledger } = open();
    ledger.begin(ctx, 'native-run:abc', 'native_run', { admitted: true });
    ledger.confirm(ctx, 'native-run:abc', 'native_run', { completed: true });
    ledger.begin(ctx, 'native:spawn', 'native_tool', { toolName: 'Agent' });
    ledger.confirm(ctx, 'native:spawn', 'native_tool', { success: true });
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(false);
    expect(ledger.hasUnsettledEffects(occurrence)).toBe(false);
    // A non-delegation native tool under the same occurrence still blocks.
    ledger.begin(ctx, 'native:bash', 'native_tool', { toolName: 'Bash' });
    ledger.confirm(ctx, 'native:bash', 'native_tool', { success: true });
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(true);
  });
  it('treats a native_tool row without a tool name as a real, unproven effect', () => {
    const { ledger } = open();
    ledger.begin(ctx, 'native:anon', 'native_tool', {});
    ledger.markUnknown(ctx, 'native:anon', 'native_tool', 'completion observed without start');
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(true);
    expect(ledger.hasUnsettledEffects(occurrence)).toBe(true);
  });
  it('stays blocked on a confirmed external send', () => {
    const { ledger } = open();
    ledger.begin(ctx, 'native-run:abc', 'native_run', { admitted: true });
    ledger.confirm(ctx, 'native-run:abc', 'native_run', { completed: true });
    ledger.begin(ctx, 'send:1', 'telegram_send', intent);
    ledger.confirm(ctx, 'send:1', 'telegram_send', { messageId: 'm-1' });
    expect(ledger.hasUnsafeReplayEffects(occurrence)).toBe(true);
    expect(ledger.hasUnsettledEffects(occurrence)).toBe(false);
  });
});
