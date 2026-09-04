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
  changeCoverage,
  ensureEffectLedger,
  listEffects,
  payloadHash,
  recordEffect,
  recordUnattributedChange,
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
  // recordEffect must still be unable to store a causeless row that claims a cause.
  it('is enforced by the database, not only by the helper', () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, channel_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', NULL, 'attributed', '[]', 'task_update', 'task', 't1', 'h', 1)`
        )
        .run();
    expect(insert).toThrow();
  });

  // The other direction of the same rule: a row cannot be filed as unexplained while
  // carrying an explanation, so the coverage count cannot be gamed downward either.
  it('will not store an unattributed row that carries a cause', () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', 'unattributed', '["evt_1"]', 'task_update', 'task', 't1', 'h', 1)`
        )
        .run();
    expect(insert).toThrow();
  });

  // "Non-empty array" is not the same as "names an event". Each of these satisfies the
  // length check and names nothing, and the helper's own filter is no defence against a
  // writer that inserts directly - which is what "enforced by the database" has to mean.
  it('rejects a cause list whose entries are not event ids', () => {
    const insert = (json: string) =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', 'attributed', 'event', ?, 'task_update', 'task', 't1', ?, 1)`
        )
        .run(json, 'a'.repeat(32));
    for (const json of ['[""]', '["   "]', '[null]', '[0]', '[{}]', '[[]]']) {
      expect(() => insert(json), json).toThrow(/non-empty event id/);
    }
    // An unbounded id would turn the cause column into a content channel - the one thing
    // hashing the payload was meant to prevent.
    expect(() => insert(JSON.stringify(['e'.repeat(201)]))).toThrow(/non-empty event id/);
    expect(() => insert('["evt_1"]')).not.toThrow();
  });

  it('rejects a receipt with no target or no payload hash', () => {
    const insert = (targetId: string, hash: string, createdAt: unknown) =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', 'attributed', '["evt_1"]', 'task_update', 'task', ?, ?, ?)`
        )
        .run(targetId, hash, createdAt);
    expect(() => insert('', 'a'.repeat(32), 1)).toThrow();
    expect(() => insert('  ', 'a'.repeat(32), 1)).toThrow();
    expect(() => insert('t1', '', 1)).toThrow();
    expect(() => insert('t1', 'a'.repeat(32), 'not-a-number')).toThrow();
  });

  it('rejects a kind or target outside the closed set', () => {
    const badKind = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', 'attributed', '["e1"]', 'invented_kind', 'task', 't1', 'h', 1)`
        )
        .run();
    const badTarget = () =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('mr_1', 'attributed', '["e1"]', 'task_update', 'invented_target', 't1', 'h', 1)`
        )
        .run();
    expect(badKind).toThrow();
    expect(badTarget).toThrow();
  });

  // The denominator. Two tables would have made "every effect names its cause" true by
  // construction and unfalsifiable - which is how 1,169 `done` rows coexisted with five
  // receipts and nobody noticed.
  it('counts what it could not explain next to what it could', () => {
    recordEffect(adapter as never, base);
    recordUnattributedChange(
      adapter as never,
      {
        runId: 'mr_1',
        kind: 'task_update',
        targetType: 'task',
        targetId: 'task_10',
        payload: { status: 'done' },
        atMs: base.atMs + 1,
      },
      'clock'
    );
    expect(changeCoverage(adapter as never)).toEqual({ attributed: 1, unattributed: 1 });
    expect(listEffects(adapter as never, { causeState: 'unattributed' })).toHaveLength(1);
    expect(listEffects(adapter as never, { causeState: 'attributed' })[0]?.sourceEventIds).toEqual([
      'evt_1',
      'evt_2',
    ]);
  });

  // A host-internal write is not made more honest by inventing a run id for it.
  it('accepts a change no model run produced', () => {
    recordEffect(adapter as never, { ...base, runId: null });
    expect(listEffects(adapter as never)[0]?.runId).toBeNull();
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

describe('cause_kind - the closed set (S2)', () => {
  it('attributed writes are kind=event; id-less writes carry the caller-stated kind', () => {
    recordEffect(adapter as never, base);
    recordUnattributedChange(
      adapter as never,
      { kind: 'task_update', targetType: 'task', targetId: 't2', payload: {}, atMs: 2 },
      'owner_message'
    );
    const kinds = listEffects(adapter as never).map((e) => e.causeKind);
    expect(kinds.sort()).toEqual(['event', 'owner_message']);
  });

  it('the DB rejects a kind that disagrees with its ids - both directions', () => {
    const insert = (kind: string, idsJson: string) =>
      db
        .prepare(
          `INSERT INTO evidence_effects
             (cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES (?, ?, ?, 'task_update', 'task', 't1', ?, 1)`
        )
        .run(kind === 'event' ? 'attributed' : 'unattributed', kind, idsJson, 'a'.repeat(32));
    // a clock that names events fabricates a schedule that responded to them
    expect(() => insert('clock', '["evt_1"]')).toThrow(/disagree/);
    // an event that names none fabricates attribution
    expect(() => insert('event', '[]')).toThrow(/disagree|json_array_length|CHECK/);
    expect(() => insert('card_transition', '[]')).not.toThrow();
  });

  it('migration backfills by DISCRIMINATOR, never blanket', () => {
    // OLD-shape ledger (pre-cause_kind), one row per historical origin.
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE evidence_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT, channel_id TEXT,
        cause_state TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        effect_kind TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE operator_temporal_effects (task_id INTEGER NOT NULL);
      INSERT INTO operator_temporal_effects (task_id) VALUES (7);
    `);
    const seed = old.prepare(
      `INSERT INTO evidence_effects
         (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
       VALUES (?, ?, ?, 'task_update', 'task', ?, '${'a'.repeat(32)}', 1)`
    );
    seed.run('mr_1', 'attributed', '["evt_1"]', '1'); //   -> event
    seed.run(null, 'unattributed', '[]', '7'); //          temporal join -> clock
    seed.run('mr_2', 'unattributed', '[]', '8'); //        scheduled run -> clock
    seed.run(null, 'unattributed', '[]', '9'); //          console/API   -> owner_message

    ensureEffectLedger({ prepare: (sql: string) => old.prepare(sql) } as never);

    const kinds = old
      .prepare(`SELECT target_id, cause_kind FROM evidence_effects ORDER BY id`)
      .all() as Array<{ target_id: string; cause_kind: string }>;
    expect(kinds).toEqual([
      { target_id: '1', cause_kind: 'event' },
      { target_id: '7', cause_kind: 'clock' },
      { target_id: '8', cause_kind: 'clock' },
      { target_id: '9', cause_kind: 'owner_message' },
    ]);
    old.close();
  });

  it('backfill without a temporal table: run-less rows are owner_message', () => {
    // A DB that never ran the temporal feature has no join table - the
    // discriminator's temporal branch must not fire, not crash.
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE evidence_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT, channel_id TEXT,
        cause_state TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        effect_kind TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    const seed = old.prepare(
      `INSERT INTO evidence_effects
         (run_id, cause_state, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
       VALUES (?, ?, ?, 'task_update', 'task', ?, '${'a'.repeat(32)}', 1)`
    );
    seed.run('mr_1', 'attributed', '["evt_1"]', '1');
    seed.run('mr_2', 'unattributed', '[]', '2');
    seed.run(null, 'unattributed', '[]', '3');

    ensureEffectLedger({ prepare: (sql: string) => old.prepare(sql) } as never);

    const kinds = old
      .prepare(`SELECT target_id, cause_kind FROM evidence_effects ORDER BY id`)
      .all() as Array<{ target_id: string; cause_kind: string }>;
    expect(kinds).toEqual([
      { target_id: '1', cause_kind: 'event' },
      { target_id: '2', cause_kind: 'clock' },
      { target_id: '3', cause_kind: 'owner_message' },
    ]);
    old.close();
  });
});

describe('ONE-MAMA-P3 Task 1 Step 0: widened closed sets', () => {
  it('AC #1 a file_export/file row inserts; an unknown kind still throws', () => {
    const id = recordUnattributedChange(
      adapter as never,
      {
        runId: 'mr_x',
        kind: 'file_export',
        targetType: 'file',
        targetId: 'sha256:abc',
        payload: { name: 'tasks.csv' },
        atMs: 1,
      },
      'owner_message'
    );
    expect(id).toBeGreaterThan(0);
    expect(() =>
      db
        .prepare(
          `INSERT INTO evidence_effects (cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('unattributed','clock','[]','not_a_kind','file','x','${'a'.repeat(32)}',1)`
        )
        .run()
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO evidence_effects (cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('attributed','event','[]','file_export','file','x','${'a'.repeat(32)}',1)`
        )
        .run()
    ).toThrow(/CHECK|disagree/);
  });

  it('AC #2 rebuilds a narrow installed ledger in place: rows, ids, created_at, triggers and indices survive', () => {
    const old = new Database(':memory:');
    // The 0.40.0 shape: current columns, narrow CHECK sets, triggers and indices present.
    old.exec(`
      CREATE TABLE evidence_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT, channel_id TEXT,
        cause_state TEXT NOT NULL CHECK (cause_state IN ('attributed', 'unattributed')),
        cause_kind TEXT NOT NULL CHECK (cause_kind IN ('event', 'owner_message', 'clock', 'card_transition')),
        source_event_ids_json TEXT NOT NULL CHECK (json_valid(source_event_ids_json)),
        effect_kind TEXT NOT NULL CHECK (effect_kind IN ('task_create','task_update')),
        target_type TEXT NOT NULL CHECK (target_type IN ('task')),
        target_id TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_evidence_effects_run ON evidence_effects(run_id, created_at DESC);
      INSERT INTO evidence_effects (id, run_id, cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
        VALUES (7, 'mr_1', 'attributed', 'event', '["evt_1"]', 'task_update', 'task', 't1', '${'a'.repeat(32)}', 1234),
               (9, NULL, 'unattributed', 'owner_message', '[]', 'task_create', 'task', 't2', '${'b'.repeat(32)}', 5678);
    `);
    const oldAdapter = { prepare: (sql: string) => old.prepare(sql) };
    ensureEffectLedger(oldAdapter as never);

    const rows = old
      .prepare(`SELECT id, target_id, created_at, cause_kind FROM evidence_effects ORDER BY id`)
      .all();
    expect(rows).toEqual([
      { id: 7, target_id: 't1', created_at: 1234, cause_kind: 'event' },
      { id: 9, target_id: 't2', created_at: 5678, cause_kind: 'owner_message' },
    ]);
    // widened: a memory_write and a run_budget_stop row insert
    recordEffect(oldAdapter as never, {
      runId: 'mr_2',
      sourceEventIds: ['evt_9'],
      kind: 'memory_write',
      targetType: 'memory',
      targetId: 'mem_1',
      payload: {},
      atMs: 2,
    });
    recordUnattributedChange(
      oldAdapter as never,
      {
        runId: 'mr_3',
        kind: 'run_budget_stop',
        targetType: 'run',
        targetId: 'mr_3',
        payload: {},
        atMs: 3,
      },
      'clock'
    );
    // invariants intact after the rebuild: attributed with no ids still throws; triggers exist
    expect(() =>
      old
        .prepare(
          `INSERT INTO evidence_effects (cause_state, cause_kind, source_event_ids_json, effect_kind, target_type, target_id, payload_hash, created_at)
           VALUES ('attributed','event','[]','task_update','task','x','${'a'.repeat(32)}',1)`
        )
        .run()
    ).toThrow();
    const triggers = old
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='evidence_effects' ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).toEqual([
      'evidence_effects_cause_shape',
      'evidence_effects_kind_shape',
    ]);
    const indexes = old
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='evidence_effects' AND name LIKE 'idx_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toEqual([
      'idx_evidence_effects_channel',
      'idx_evidence_effects_coverage',
      'idx_evidence_effects_run',
      'idx_evidence_effects_target',
    ]);
    // a second boot is a no-op
    const ddlBefore = old
      .prepare(`SELECT sql FROM sqlite_master WHERE name='evidence_effects'`)
      .get();
    ensureEffectLedger(oldAdapter as never);
    expect(
      old.prepare(`SELECT sql FROM sqlite_master WHERE name='evidence_effects'`).get()
    ).toEqual(ddlBefore);
    expect(old.prepare(`SELECT count(*) AS n FROM evidence_effects`).get()).toEqual({ n: 4 });
    old.close();
  });
});
