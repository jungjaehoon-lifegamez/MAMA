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
import { applyRekey, buildPlan } from '../../scripts/backfill-channel-keys.js';

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
      event_index_id TEXT PRIMARY KEY, source_connector TEXT NOT NULL, channel TEXT
    );
    CREATE TABLE connector_event_index_operator_seq_cursors (
      source_connector TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '',
      next_seq INTEGER NOT NULL, PRIMARY KEY (source_connector, channel)
    );
    CREATE TABLE connector_consumer_cursors (
      consumer TEXT NOT NULL, connector TEXT NOT NULL, channel_id TEXT NOT NULL,
      last_event_index_id TEXT NOT NULL, last_event_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (consumer, connector, channel_id)
    );
    CREATE TABLE connector_delta_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, connector TEXT NOT NULL, channel_id TEXT NOT NULL
    );
    CREATE TABLE connector_source_cursors (
      connector TEXT NOT NULL, channel_id TEXT NOT NULL, PRIMARY KEY (connector, channel_id)
    );
  `);
});

function event(id: string, connector: string, channel: string): void {
  db.prepare(
    'INSERT INTO connector_event_index (event_index_id, source_connector, channel) VALUES (?, ?, ?)'
  ).run(id, connector, channel);
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
    expect(plan.unconfigured).toBe(1);
  });

  it('leaves a channel the config never mentions exactly as it is', () => {
    event('e1', 'chat', 'never-configured');
    event('e2', 'other', 'anything');

    const plan = buildPlan(db, CONFIG);

    expect(plan.rekeys).toEqual([]);
    expect(plan.unconfigured).toBe(2);
  });

  it('skips a disabled connector rather than re-keying its history', () => {
    event('e1', 'chat', 'general');

    const plan = buildPlan(db, { chat: { ...CONFIG.chat, enabled: false } });

    expect(plan.rekeys).toEqual([]);
  });
});

describe('channel re-key application', () => {
  const rekey = { connector: 'chat', from: 'general', to: 'C001', events: 1 };

  it('moves every table that joins on the value', () => {
    event('e1', 'chat', 'general');
    db.prepare('INSERT INTO connector_delta_deliveries (connector, channel_id) VALUES (?, ?)').run(
      'chat',
      'general'
    );
    db.prepare('INSERT INTO connector_source_cursors (connector, channel_id) VALUES (?, ?)').run(
      'chat',
      'general'
    );

    applyRekey(db, rekey);

    expect(
      db.prepare('SELECT channel FROM connector_event_index WHERE event_index_id = ?').get('e1')
    ).toEqual({ channel: 'C001' });
    expect(db.prepare('SELECT channel_id FROM connector_delta_deliveries').get()).toEqual({
      channel_id: 'C001',
    });
    expect(db.prepare('SELECT channel_id FROM connector_source_cursors').get()).toEqual({
      channel_id: 'C001',
    });
  });

  // The failure this repair must not cause: a consumer whose cursor vanished starts over
  // and redelivers everything it has already reported.
  it('carries a consumer cursor across instead of stranding it', () => {
    event('e1', 'chat', 'general');
    db.prepare(
      `INSERT INTO connector_consumer_cursors
         (consumer, connector, channel_id, last_event_index_id, last_event_version, updated_at)
       VALUES ('awareness', 'chat', 'general', 'e1', 1, 100)`
    ).run();

    applyRekey(db, rekey);

    expect(db.prepare('SELECT * FROM connector_consumer_cursors').all()).toEqual([
      {
        consumer: 'awareness',
        connector: 'chat',
        channel_id: 'C001',
        last_event_index_id: 'e1',
        last_event_version: 1,
        updated_at: 100,
      },
    ]);
  });

  // When both cursors exist, only the further-along one may survive: adopting the older
  // one would move the consumer backwards, which is redelivery by another route.
  it('keeps the further-along cursor when two collide', () => {
    db.prepare(
      `INSERT INTO connector_consumer_cursors
         (consumer, connector, channel_id, last_event_index_id, last_event_version, updated_at)
       VALUES ('awareness', 'chat', 'general', 'e_new', 1, 500),
              ('awareness', 'chat', 'C001', 'e_old', 1, 100)`
    ).run();

    applyRekey(db, rekey);

    expect(db.prepare('SELECT * FROM connector_consumer_cursors').all()).toEqual([
      {
        consumer: 'awareness',
        connector: 'chat',
        channel_id: 'C001',
        last_event_index_id: 'e_new',
        last_event_version: 1,
        updated_at: 500,
      },
    ]);
  });

  it('does not move a consumer backwards when the target is already ahead', () => {
    db.prepare(
      `INSERT INTO connector_consumer_cursors
         (consumer, connector, channel_id, last_event_index_id, last_event_version, updated_at)
       VALUES ('awareness', 'chat', 'general', 'e_old', 1, 100),
              ('awareness', 'chat', 'C001', 'e_new', 1, 500)`
    ).run();

    applyRekey(db, rekey);

    expect(db.prepare('SELECT last_event_index_id FROM connector_consumer_cursors').get()).toEqual({
      last_event_index_id: 'e_new',
    });
  });

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
