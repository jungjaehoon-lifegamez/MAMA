/**
 * W6 — the mailbox is durable intake, schedule, delivery and ack. Nothing else.
 *
 * Two questions, and the first one is what the correction was about.
 *
 * CONSUMER NEUTRALITY. A new non-MAMA consumer must be able to receive
 * something durably without importing `OwnerEvent` or a word from the trigger
 * loop's vocabulary. That is checked against the module's real export surface
 * and the real migration, not against a file path.
 *
 * THE MECHANISM. Per-ref dedupe (a partial redelivery must not re-run an
 * already-accepted ref), leases with a poison cap, mechanical coalescing, and
 * an ack that says only "the loop took it". Turn execution is the native
 * session's; nothing here retries a model or records an outcome.
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { Mailbox, isStimulusKind, type Stimulus } from '../../src/runtime/mailbox.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const MAILBOX_SOURCE = join(__dirname, '..', '..', 'src', 'runtime', 'mailbox.ts');

const openAdapters = new Set<DatabaseAdapter>();
const tempPaths = new Set<string>();

function freshDb(label: string): DatabaseAdapter {
  const path = join(os.tmpdir(), `mama-mailbox-${label}-${randomUUID()}.db`);
  tempPaths.add(path);
  const adapter = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  openAdapters.add(adapter);
  return adapter;
}

afterEach(() => {
  for (const adapter of openAdapters) {
    try {
      adapter.disconnect();
    } catch {
      // best effort
    }
  }
  openAdapters.clear();
  for (const path of tempPaths) {
    for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }
  tempPaths.clear();
});

const stimulus = (over: Partial<Stimulus> = {}): Stimulus => ({
  id: 'stim-1',
  kind: 'source_delta',
  principalId: 'principal-owner',
  channelKey: 'connector:channel-1',
  occurredAt: 1_000,
  ...over,
});

describe('the mailbox carries no consumer vocabulary', () => {
  it('upgrades a consumer-created pre-103 seen table without core migrations', () => {
    const path = join(os.tmpdir(), `mailbox-consumer-${randomUUID()}.db`);
    tempPaths.add(path);
    const db = new NodeSQLiteAdapter({ dbPath: path });
    db.connect();
    openAdapters.add(db);
    db.exec(
      "CREATE TABLE mailbox_seen (ref_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL DEFAULT 0); INSERT INTO mailbox_seen VALUES ('legacy-ref', 1)"
    );
    const mailbox = new Mailbox(db);
    mailbox.enqueue(stimulus({ refs: [{ refId: 'new-ref', observationRef: null }] }));
    expect(
      db.prepare('SELECT principal_id FROM mailbox_seen WHERE ref_id=?').get('new-ref')
    ).toEqual({ principal_id: 'principal-owner' });
    expect(db.prepare('SELECT * FROM mailbox_seen WHERE ref_id=?').get('legacy-ref')).toEqual({
      ref_id: 'legacy-ref',
      seen_at: 1,
      principal_id: null,
    });
    expect(() => new Mailbox(db)).not.toThrow();
  });

  it('its source names no OwnerEvent or procedure word', () => {
    const source = fs.readFileSync(MAILBOX_SOURCE, 'utf8');
    // The prose may say where the product's own inbox went; code may not.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n');
    for (const word of [
      'OwnerEvent',
      'ProcedureRef',
      'TriggerProcedureStep',
      'activation',
      'owner_event_inbox',
      'lines_json',
    ]) {
      expect(code).not.toContain(word);
    }
  });

  it('its exported names are the mechanism, not a consumer', async () => {
    const module = await import('../../src/runtime/mailbox.js');
    expect(Object.keys(module).sort()).toEqual([
      'Mailbox',
      'MailboxCorruptionError',
      'isStimulusKind',
    ]);
  });

  it('a row holds identity, principal, source, content, time, reply, coalesce and delivery state — and no work kind', () => {
    const db = freshDb('columns');
    const columns = (
      db.prepare(`PRAGMA table_info(mailbox_inputs)`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns.sort()).toEqual(
      [
        'acked_at',
        'attempts',
        'channel_key',
        'claimed_at',
        'coalesce_key',
        'created_at',
        'id',
        'kind',
        'last_error',
        'occurred_at',
        'payload_json',
        'preview_json',
        'principal_id',
        'reply_to',
        'retry_after',
        'status',
        'stimulus_id',
      ].sort()
    );
    // There is nowhere to write a semantic outcome, which is the point:
    // §4.4 forbids inventing acted/no_update/owner_question here.
    for (const forbidden of ['unresolved_reason', 'activations_json', 'outcome', 'task_id']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('the kind is one of the three a producer may state, and nothing else', () => {
    expect(isStimulusKind('owner_message')).toBe(true);
    expect(isStimulusKind('source_delta')).toBe(true);
    expect(isStimulusKind('scheduled')).toBe(true);
    expect(isStimulusKind('report')).toBe(false);
    expect(isStimulusKind(undefined)).toBe(false);

    const db = freshDb('kind');
    const mailbox = new Mailbox(db);
    expect(() => mailbox.enqueue(stimulus({ kind: 'report' as never }))).toThrow(
      /unknown stimulus kind/
    );
  });
});

describe('migration 086 carries the dedupe horizon and nothing else', () => {
  it('every seen event id survives, and no row is moved', () => {
    const path = join(os.tmpdir(), `mama-mailbox-transfer-${randomUUID()}.db`);
    tempPaths.add(path);
    // Run up to the legacy migration only, then seed it the way the live
    // database is seeded, then finish the run.
    const adapter = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
    adapter.connect();
    adapter.runMigrations(MIGRATIONS_DIR);
    openAdapters.add(adapter);

    // The legacy tables are still there: 081 is applied history and was not edited.
    const legacy = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'owner_event%'`)
      .all() as Array<{ name: string }>;
    expect(legacy.map((row) => row.name).sort()).toEqual([
      'owner_event_inbox',
      'owner_event_inbox_events',
    ]);

    // Seed the horizon as a live install has it, then re-run the migration the
    // way a later boot does. INSERT OR IGNORE makes the carry idempotent.
    for (const id of ['evt-a', 'evt-b', 'evt-c']) {
      adapter
        .prepare(`INSERT OR IGNORE INTO owner_event_inbox_events (event_id, seen_at) VALUES (?, ?)`)
        .run(id, 5_000);
    }
    // Replay the carry SQL itself: resetting later version stamps does not restore their schemas.
    adapter.exec(fs.readFileSync(join(MIGRATIONS_DIR, '086-the-mailbox-is-generic.sql'), 'utf8'));

    const carried = (
      adapter.prepare(`SELECT ref_id FROM mailbox_seen ORDER BY ref_id`).all() as Array<{
        ref_id: string;
      }>
    ).map((row) => row.ref_id);
    expect(carried).toEqual(['evt-a', 'evt-b', 'evt-c']);

    // A carried id is already durable, so the new door refuses it a second time.
    const mailbox = new Mailbox(adapter);
    expect(
      mailbox.enqueue(stimulus({ id: 'evt-a', refs: [{ refId: 'evt-a', observationRef: null }] }))
    ).toBeNull();
  });
});

describe('the mechanism', () => {
  it('dedupes per ref, so a partial redelivery stores only what is new', () => {
    const mailbox = new Mailbox(freshDb('dedupe'));
    const first = mailbox.enqueue(
      stimulus({ id: 's1', refs: [{ refId: 'e1', observationRef: 'obs-1' }] })
    );
    expect(first).not.toBeNull();

    // The producer's cursor failed to commit; the next tick redelivers e1 with e2.
    const second = mailbox.enqueue(
      stimulus({
        id: 's2',
        refs: [
          { refId: 'e1', observationRef: 'obs-1' },
          { refId: 'e2', observationRef: 'obs-2' },
        ],
      })
    );
    expect(second).not.toBeNull();

    const rows = [mailbox.claimNext(), mailbox.claimNext()];
    expect(rows[0]?.refs.map((ref) => ref.refId)).toEqual(['e1']);
    expect(rows[1]?.refs.map((ref) => ref.refId)).toEqual(['e2']);
    expect(mailbox.claimNext()).toBeNull();
  });

  it('a fully redelivered stimulus is a duplicate, not a second row', () => {
    const mailbox = new Mailbox(freshDb('duplicate'));
    expect(mailbox.enqueue(stimulus({ id: 'only' }))).not.toBeNull();
    expect(mailbox.enqueue(stimulus({ id: 'only' }))).toBeNull();
    expect(mailbox.depth().pending).toBe(1);
  });

  it('accepts the replay cap of 500 refs and rejects 501 before writing', () => {
    const mailbox = new Mailbox(freshDb('reference-cap'));
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        refId: `ref-${index}`,
        observationRef: `observation-${index}`,
      }));

    expect(mailbox.enqueue(stimulus({ id: 'five-hundred', refs: refs(500) }))).not.toBeNull();
    expect(mailbox.depth().pending).toBe(1);
    expect(() =>
      mailbox.enqueue(stimulus({ id: 'five-hundred-and-one', refs: refs(501) }))
    ).toThrow(/at most 500 refs/);
    expect(mailbox.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
  });

  it('coalesces two pending stimuli that state the same key, keeping both refs', () => {
    const mailbox = new Mailbox(freshDb('coalesce'));
    const first = mailbox.enqueue(
      stimulus({
        id: 's1',
        coalesceKey: 'connector:channel-1',
        preview: ['one'],
        refs: [{ refId: 'e1', observationRef: null }],
      })
    );
    const second = mailbox.enqueue(
      stimulus({
        id: 's2',
        coalesceKey: 'connector:channel-1',
        preview: ['two'],
        refs: [{ refId: 'e2', observationRef: null }],
      })
    );
    expect(second).toBe(first);
    expect(mailbox.depth().pending).toBe(1);

    const claimed = mailbox.claimNext();
    expect(claimed?.refs.map((ref) => ref.refId)).toEqual(['e1', 'e2']);
    expect(claimed?.preview).toEqual(['one', 'two']);

    // A claimed row is in flight: the next one opens its own row rather than
    // joining something the loop already holds.
    const third = mailbox.enqueue(
      stimulus({
        id: 's3',
        coalesceKey: 'connector:channel-1',
        refs: [{ refId: 'e3', observationRef: null }],
      })
    );
    expect(third).not.toBe(first);
  });

  it('a stimulus with no coalesce key never merges', () => {
    const mailbox = new Mailbox(freshDb('nocoalesce'));
    const a = mailbox.enqueue(stimulus({ id: 'a', refs: [{ refId: 'e1', observationRef: null }] }));
    const b = mailbox.enqueue(stimulus({ id: 'b', refs: [{ refId: 'e2', observationRef: null }] }));
    expect(a).not.toBe(b);
    expect(mailbox.depth().pending).toBe(2);
  });

  it('an unacked claim returns to pending, and a poisoned one parks dead and visible', () => {
    let now = 10_000;
    const mailbox = new Mailbox(freshDb('lease'), () => now);
    mailbox.enqueue(stimulus({ id: 'poison' }));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claimed = mailbox.claimNext();
      expect(claimed).not.toBeNull();
      expect(mailbox.retry(claimed!.id, `attempt ${attempt}`)).toBe('pending');
      now += 86_400_000; // past the backoff
    }
    const last = mailbox.claimNext();
    expect(last).not.toBeNull();
    expect(mailbox.retry(last!.id, 'final')).toBe('dead');
    expect(mailbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 1 });
  });

  it('ack records that the loop took it, and nothing about the work', () => {
    const mailbox = new Mailbox(freshDb('ack'));
    mailbox.enqueue(stimulus({ id: 'one' }));
    const claimed = mailbox.claimNext();
    mailbox.ack(claimed!.id);
    expect(mailbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    // ack takes exactly one argument: there is no outcome to pass it.
    expect(Mailbox.prototype.ack.length).toBe(1);
  });

  it('schedules a wake for this daemon, fires it once, and is idempotent', () => {
    let now = 1_000;
    const mailbox = new Mailbox(freshDb('schedule'), () => now);
    const id = mailbox.scheduleWake('connector:channel-1', 5_000);
    expect(mailbox.dueWakes()).toEqual([]);
    now = 5_000;
    expect(mailbox.dueWakes()).toEqual([{ id, channelKey: 'connector:channel-1', dueAt: 5_000 }]);
    expect(mailbox.markWakeFired(id)).toBe(true);
    expect(mailbox.markWakeFired(id)).toBe(false);
    expect(mailbox.dueWakes()).toEqual([]);
  });
});
