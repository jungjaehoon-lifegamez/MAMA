/**
 * The channel re-keying repair.
 *
 * The dangerous half is not the UPDATE - it is the five other tables that join on the same
 * value. A repair that moved the index alone would leave every consumer cursor pointing at
 * a channel that no longer exists, and a consumer that cannot find its cursor starts from
 * the beginning: history intended to become readable would be redelivered as news instead.
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyRekey, buildPlan, carryDeltaCursors } from '../../scripts/backfill-channel-keys.js';

type Db = InstanceType<typeof Database>;

let db: Db;

const CONFIG = {
  chat: {
    enabled: true,
    channels: {
      C001: { name: 'general' },
      C002: { name: 'random' },
    },
  },
  board: {
    enabled: true,
    channels: {
      b1a2c3: { name: 'Production' },
      f9e8d7: { name: 'Production' },
    },
  },
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connector_event_index (
      event_index_id TEXT PRIMARY KEY, source_connector TEXT NOT NULL, channel TEXT,
      memory_scope_kind TEXT, memory_scope_id TEXT, operator_ingest_seq INTEGER
    );
    CREATE UNIQUE INDEX idx_seq
      ON connector_event_index(source_connector, COALESCE(channel, ''), operator_ingest_seq);
    CREATE TABLE connector_event_index_operator_seq_cursors (
      source_connector TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '',
      next_seq INTEGER NOT NULL, PRIMARY KEY (source_connector, channel)
    );
  `);
});

function event(id: string, connector: string, channel: string, seq?: number): void {
  db.prepare(
    `INSERT INTO connector_event_index
       (event_index_id, source_connector, channel, memory_scope_kind, memory_scope_id,
        operator_ingest_seq)
     VALUES (?, ?, ?, 'channel', ?, ?)`
  ).run(id, connector, channel, channel, seq ?? null);
}

describe('channel re-key plan', () => {
  it('moves a display name onto the configured key', () => {
    event('e1', 'chat', 'general');
    event('e2', 'chat', 'general');

    const plan = buildPlan(db, CONFIG);

    expect(plan.rekeys).toEqual([{ connector: 'chat', from: 'general', to: 'C001', events: 2 }]);
  });

  it('leaves rows that already carry the key', () => {
    event('e1', 'chat', 'C001');

    const plan = buildPlan(db, CONFIG);

    expect(plan.rekeys).toEqual([]);
    expect(plan.alreadyCanonical).toBe(1);
  });

  // An identity that has to be inferred is not an identity. Two channels sharing a display
  // name means the name never identified either of them.
  it('refuses to guess when a display name maps to two channels', () => {
    event('e1', 'board', 'Production');

    const plan = buildPlan(db, CONFIG);

    expect(plan.rekeys).toEqual([]);
    expect(plan.ambiguous).toEqual([{ connector: 'board', name: 'Production', candidates: 2 }]);
    expect(plan.unmatchedChannel).toBe(1);
  });

  // Two different facts that the first version printed as one. A channel of a DECLARED
  // connector that matches nothing was renamed or removed - the owner can act on that. A
  // connector the config never mentions is a different situation entirely, and reporting
  // both as "never given" hides the actionable one.
  it('separates an unknown connector from a channel that matches nothing', () => {
    event('e1', 'chat', 'renamed-or-removed');
    event('e2', 'other', 'anything');

    const plan = buildPlan(db, CONFIG);

    expect(plan.rekeys).toEqual([]);
    expect(plan.unmatchedChannel).toBe(1);
    expect(plan.unknownConnector).toBe(1);
  });

  it('skips a disabled connector rather than re-keying its history', () => {
    event('e1', 'chat', 'general');

    const plan = buildPlan(db, { chat: { ...CONFIG.chat, enabled: false } });

    expect(plan.rekeys).toEqual([]);
  });
});

describe('channel re-key application', () => {
  const rekey = { connector: 'chat', from: 'general', to: 'C001', events: 1 };

  // Two sequence streams becoming one must not hand out a number twice.
  it('merges sequence cursors to the higher watermark', () => {
    db.prepare(
      `INSERT INTO connector_event_index_operator_seq_cursors (source_connector, channel, next_seq)
       VALUES ('chat', 'general', 900), ('chat', 'C001', 12)`
    ).run();

    applyRekey(db, rekey);

    expect(db.prepare('SELECT * FROM connector_event_index_operator_seq_cursors').all()).toEqual([
      { source_connector: 'chat', channel: 'C001', next_seq: 900 },
    ]);
  });

  // Re-running the repair must be a no-op, not a second set of merges.
  it('is idempotent', () => {
    event('e1', 'chat', 'general');
    applyRekey(db, rekey);
    const after = db.prepare('SELECT * FROM connector_event_index').all();

    applyRekey(db, rekey);

    expect(db.prepare('SELECT * FROM connector_event_index').all()).toEqual(after);
    expect(buildPlan(db, CONFIG).rekeys).toEqual([]);
  });
});

describe('what the seam review found the first version missing', () => {
  const rekey = { connector: 'chat', from: 'general', to: 'C001', events: 1 };

  // memory_scope_id is the sixth carrier of the same value - equal to `channel` on every
  // channel-scoped row. Leaving it behind gives the row two names for its own channel and
  // makes the pre-grant readers disagree with the grant path about the same event.
  it('moves memory_scope_id with the channel', () => {
    event('e1', 'chat', 'general');

    applyRekey(db, rekey);

    expect(db.prepare('SELECT channel, memory_scope_id FROM connector_event_index').get()).toEqual({
      channel: 'C001',
      memory_scope_id: 'C001',
    });
  });

  // operator_ingest_seq is unique per (connector, channel), so merging two partitions
  // merges two 1..N sequences. One already-polled event in the target aborted the entire
  // repair on the unique index - after the backup message had printed.
  it('renumbers a merged partition instead of colliding', () => {
    event('e_target', 'chat', 'C001', 1);
    event('e_move_1', 'chat', 'general', 1);
    event('e_move_2', 'chat', 'general', 2);

    expect(() => applyRekey(db, rekey)).not.toThrow();

    const rows = db
      .prepare(
        `SELECT event_index_id, operator_ingest_seq FROM connector_event_index
          WHERE channel = 'C001' ORDER BY operator_ingest_seq`
      )
      .all() as Array<{ event_index_id: string; operator_ingest_seq: number }>;
    expect(rows.map((r) => r.event_index_id)).toEqual(['e_target', 'e_move_1', 'e_move_2']);
    // Relative order of the moving set survives; the numbers are distinct.
    expect(new Set(rows.map((r) => r.operator_ingest_seq)).size).toBe(3);
  });
});

describe('delta cursors, which are a file rather than a table', () => {
  const rekeys = [{ connector: 'chat', from: 'general', to: 'C001', events: 1 }];

  // The failure this whole script exists to prevent, and the first version walked into it:
  // an orphaned cursor does not error, it silently redelivers the whole partition.
  it('carries a cursor onto the canonical key', () => {
    const result = carryDeltaCursors({ 'chat\u0000general': 500 }, rekeys);

    expect(result.cursors).toEqual({ 'chat\u0000C001': 500 });
    expect(result.carried).toBe(1);
  });

  it('keeps the later cursor when both keys exist', () => {
    expect(
      carryDeltaCursors({ 'chat\u0000general': 900, 'chat\u0000C001': 100 }, rekeys).cursors
    ).toEqual({ 'chat\u0000C001': 900 });
    expect(
      carryDeltaCursors({ 'chat\u0000general': 100, 'chat\u0000C001': 900 }, rekeys).cursors
    ).toEqual({ 'chat\u0000C001': 900 });
  });

  it('leaves unrelated partitions untouched', () => {
    expect(carryDeltaCursors({ 'mail\u0000inbox': 7 }, rekeys).cursors).toEqual({
      'mail\u0000inbox': 7,
    });
  });
});
