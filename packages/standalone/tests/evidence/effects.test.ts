/**
 * The ledger that makes `done` mean something.
 *
 * Before this, 1,471 workorders ran over ten days, 1,169 closed as `done`, and five
 * durable receipts existed. Every test here is one way that gap could reopen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  EffectWithoutCauseError,
  ensureEffectLedger,
  listEffects,
  payloadHash,
  recordEffect,
} from '../../src/evidence/effects.js';

let db: Database.Database;
let adapter: { prepare: (sql: string) => Database.Statement };

beforeEach(() => {
  db = new Database(':memory:');
  adapter = { prepare: (sql: string) => db.prepare(sql) };
  ensureEffectLedger(adapter as never);
});

afterEach(() => {
  db.close();
});

const base = {
  runId: 'mr_1',
  channelId: 'ch_abc',
  sourceEventIds: ['evt_1', 'evt_2'],
  kind: 'task_update' as const,
  targetType: 'task' as const,
  targetId: 'task_9',
  payload: { status: 'done' },
  atMs: 1_785_000_000_000,
};

describe('effect ledger', () => {
  it('records a change together with what caused it', () => {
    const id = recordEffect(adapter as never, base);
    expect(id).toBeGreaterThan(0);

    const [effect] = listEffects(adapter as never);
    expect(effect).toMatchObject({
      runId: 'mr_1',
      channelId: 'ch_abc',
      sourceEventIds: ['evt_1', 'evt_2'],
      kind: 'task_update',
      targetType: 'task',
      targetId: 'task_9',
    });
  });

  // The rule the whole table exists for.
  it('refuses a change that cannot name its cause', () => {
    expect(() => recordEffect(adapter as never, { ...base, sourceEventIds: [] })).toThrow(
      EffectWithoutCauseError
    );
    expect(() => recordEffect(adapter as never, { ...base, sourceEventIds: ['  ', ''] })).toThrow(
      EffectWithoutCauseError
    );
    expect(listEffects(adapter as never)).toHaveLength(0);
  });

  // Enforced by the schema, not by callers remembering. A future writer that bypasses
  // recordEffect must still be unable to store a causeless row.
  it('is enforced by the database, not only by the helper', () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, channel_id, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', NULL, '[]', 'task_update', 'task', 't1', 'h', 1)`
        )
        .run();
    expect(insert).toThrow();
  });

  it('rejects a kind or target outside the closed set', () => {
    const badKind = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', '["e1"]', 'invented_kind', 'task', 't1', 'h', 1)`
        )
        .run();
    const badTarget = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', '["e1"]', 'task_update', 'invented_target', 't1', 'h', 1)`
        )
        .run();
    expect(badKind).toThrow();
    expect(badTarget).toThrow();
  });

  // The ledger proves a change happened; it is not a copy of what was written. Storing the
  // payload would turn an audit table into a second store of the same content, with its
  // own retention and its own leak surface.
  it('stores a hash of the payload, never the payload', () => {
    recordEffect(adapter as never, {
      ...base,
      payload: { secretish: 'do-not-store-me' },
    });
    const serialized = JSON.stringify(listEffects(adapter as never));
    expect(serialized).not.toContain('do-not-store-me');
    expect(serialized).toContain(payloadHash({ secretish: 'do-not-store-me' }));
  });

  it('deduplicates repeated source events without dropping the cause', () => {
    recordEffect(adapter as never, { ...base, sourceEventIds: ['evt_1', 'evt_1', 'evt_2'] });
    expect(listEffects(adapter as never)[0]?.sourceEventIds).toEqual(['evt_1', 'evt_2']);
  });

  it('reads back by target so a report can project from effects', () => {
    recordEffect(adapter as never, base);
    recordEffect(adapter as never, {
      ...base,
      kind: 'report_update',
      targetType: 'report_slot',
      targetId: 'briefing',
      atMs: base.atMs + 1000,
    });

    expect(listEffects(adapter as never, { targetType: 'report_slot' })).toHaveLength(1);
    expect(listEffects(adapter as never, { targetId: 'task_9' })[0]?.kind).toBe('task_update');
    // Newest first: a projection reads the current state without scanning history.
    expect(listEffects(adapter as never)[0]?.targetId).toBe('briefing');
  });
});
