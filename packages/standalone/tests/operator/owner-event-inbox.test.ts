/**
 * The inbox exists so a owner-event agent crash can never lose an event batch:
 * rows are durable, claims are leases, and an unacked claim returns to
 * pending. Per-event dedupe turns redelivery after a cursor rollback into
 * a no-op - including PARTIAL redelivery under a different batch boundary.
 * eventIds (identity) and lines (display) are independent fields, never
 * zipped positionally.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { OwnerEventInbox } from '../../src/operator/owner-event-inbox.js';

const batch = (n: number) => ({
  channelKey: `chat C${n}`,
  eventIds: [`evt_${n}a`, `evt_${n}b`],
  lines: [`line ${n}a`, `line ${n}b`],
  activations: [],
});

describe('OwnerEventInbox', () => {
  let db: SQLiteDatabase;
  let inbox: OwnerEventInbox;
  let now: number;
  beforeEach(() => {
    db = new Database(':memory:');
    now = 1_000;
    inbox = new OwnerEventInbox(db, () => now);
  });

  it('enqueue -> claim -> ack is the happy path, oldest first', () => {
    inbox.enqueue(batch(1));
    inbox.enqueue(batch(2));
    const a = inbox.claimNext();
    expect(a?.channelKey).toBe('chat C1');
    expect(a?.lines).toEqual(['line 1a', 'line 1b']);
    inbox.ack(a!.id);
    expect(inbox.claimNext()?.channelKey).toBe('chat C2');
  });

  it('a killed owner-event turn loses nothing: unacked claim replays', () => {
    inbox.enqueue(batch(1));
    const a = inbox.claimNext();
    expect(a).not.toBeNull();
    // owner-event agent dies here - no ack. Lease expires:
    const replayed = inbox.replayStale(0);
    expect(replayed).toBe(1);
    now += 60_000;
    const again = inbox.claimNext();
    expect(again?.eventIds).toEqual(['evt_1a', 'evt_1b']);
    expect(again?.attempts).toBe(1);
  });

  it('full redelivery is dropped; PARTIAL redelivery keeps only unseen identity', () => {
    expect(inbox.enqueue(batch(1))).not.toBeNull();
    expect(inbox.enqueue(batch(1))).toBeNull(); // cursor rollback, same batch
    // cursor stayed behind, a new event joined the redelivered batch:
    const wider = {
      channelKey: 'chat C1',
      eventIds: ['evt_1a', 'evt_1b', 'evt_1c'],
      lines: ['line 1a', 'line 1b', 'line 1c'],
      activations: [],
    };
    expect(inbox.enqueue(wider)).not.toBeNull();
    const first = inbox.claimNext()!;
    inbox.ack(first.id);
    const second = inbox.claimNext()!;
    expect(second.eventIds).toEqual(['evt_1c']); // e1a/e1b never run twice
    // Display lines stay whole - they are an excerpt, not paired with ids.
    expect(second.lines).toEqual(['line 1a', 'line 1b', 'line 1c']);
  });

  it('lines and eventIds are independent: a batch larger than its display excerpt stores both faithfully', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `evt_${i}`);
    const lines = ['line 15', 'line 24']; // bounded excerpt, e.g. last N
    expect(
      inbox.enqueue({ channelKey: 'chat C1', eventIds: ids, lines, activations: [] })
    ).not.toBeNull();
    const row = inbox.claimNext()!;
    expect(row.eventIds).toHaveLength(25); // identity covers the WHOLE batch
    expect(row.lines).toEqual(lines); // display is exactly what was handed in
    expect(row.lines.filter((l) => l === '')).toEqual([]); // never padded
  });

  it('a batch failing 5 times parks as dead, never spins forever - and retry says so', () => {
    inbox.enqueue(batch(1));
    for (let i = 0; i < 4; i++) {
      const c = inbox.claimNext()!;
      expect(inbox.retry(c.id, `fail ${i}`)).toBe('pending');
      now += 43_200_000;
    }
    const last = inbox.claimNext()!;
    expect(inbox.retry(last.id, 'fail 4')).toBe('dead');
    expect(inbox.claimNext()).toBeNull();
    expect(inbox.depth().dead).toBe(1);
  });

  it('retry returns a claim to pending with the error recorded', () => {
    inbox.enqueue(batch(1));
    const a = inbox.claimNext()!;
    inbox.retry(a.id, 'agent run failed');
    expect(inbox.depth()).toEqual({ pending: 1, claimed: 0, dead: 0 });
    now += 60_000;
    expect(inbox.claimNext()?.attempts).toBe(1);
  });

  it('backs off an unreceipted model turn instead of burning five retries immediately', () => {
    const backedOff = new OwnerEventInbox(db, () => now);
    backedOff.enqueue(batch(1));
    const first = backedOff.claimNext()!;
    expect(backedOff.retry(first.id, 'no durable receipt')).toBe('pending');

    expect(backedOff.claimNext()).toBeNull();
    now += 59_999;
    expect(backedOff.claimNext()).toBeNull();
    now += 1;
    expect(backedOff.claimNext()?.attempts).toBe(1);
  });

  it('replayStale applies the SAME poison cap as retry - a lease-expiring batch cannot re-pend forever', () => {
    inbox.enqueue(batch(1));
    for (let i = 0; i < 4; i++) {
      inbox.claimNext();
      expect(inbox.replayStale(0)).toBe(1);
      now += 43_200_000;
    }
    inbox.claimNext();
    const terminal = inbox.replayStaleDetailed(0); // 5th expiry parks it
    expect(terminal).toMatchObject({
      replayed: 1,
      newlyDead: [{ id: 1, channelKey: 'chat C1', eventIds: ['evt_1a', 'evt_1b'] }],
    });
    expect(inbox.claimNext()).toBeNull();
    expect(inbox.depth().dead).toBe(1);
  });

  it('housekeeping: acked rows age out after 7 days, live rows survive', () => {
    inbox.enqueue(batch(1));
    inbox.enqueue(batch(2));
    const a = inbox.claimNext()!;
    inbox.ack(a.id);
    const eightDays = Date.now() + 8 * 86_400_000;
    const housekeeping = inbox.replayStaleDetailed(60_000, eightDays);
    expect(housekeeping.newlyDead).toEqual([
      expect.objectContaining({ channelKey: 'chat C2', status: 'dead' }),
    ]);
    const acked = db
      .prepare(`SELECT COUNT(*) AS n FROM owner_event_inbox WHERE status = 'acked'`)
      .get() as { n: number };
    expect(acked.n).toBe(0);
    // batch 2 was pending for 8 days - stale-parked as dead, visibly, so a
    // shadow-mode backlog cannot detonate as months of replays on enable.
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 1 });
  });

  it('housekeeping: the dedupe table keeps a 30-day horizon, not forever', () => {
    inbox.enqueue(batch(1));
    const count = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM owner_event_inbox_events`).get() as { n: number }).n;
    expect(count()).toBe(2);
    inbox.replayStale(60_000, now + 29 * 86_400_000);
    expect(count()).toBe(2); // inside the horizon
    inbox.replayStale(60_000, now + 31 * 86_400_000);
    expect(count()).toBe(0); // aged out - far wider than any redelivery gap
  });

  it('durably carries the complete matched trigger contract with the source batch', () => {
    inbox.enqueue({
      channelKey: 'chatwork:C1',
      eventIds: ['evt-feedback'],
      lines: ['- [id:evt-feedback] client: feedback arrived'],
      activations: [
        {
          triggerId: 'trigger-feedback',
          kind: 'feedback relay',
          memoryQuery: 'feedback relay policy',
          procedure: [
            { action: 'translate', description: 'Translate feedback into Korean.' },
            { action: 'deliver', description: 'Deliver it to the owner.' },
          ],
          requiredEvidence: ['current_message', 'feedback_attachment'],
        },
      ],
    });

    expect(inbox.claimNext()?.activations).toEqual([
      {
        triggerId: 'trigger-feedback',
        kind: 'feedback relay',
        memoryQuery: 'feedback relay policy',
        procedure: [
          { action: 'translate', description: 'Translate feedback into Korean.' },
          { action: 'deliver', description: 'Deliver it to the owner.' },
        ],
        requiredEvidence: ['current_message', 'feedback_attachment'],
      },
    ]);
  });

  it('uses a fresh owner-event journal instead of replaying legacy Conductor shadow rows', () => {
    db.exec(`
      CREATE TABLE conductor_inbox (
        id INTEGER PRIMARY KEY,
        channel_key TEXT NOT NULL,
        event_ids_json TEXT NOT NULL,
        lines_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO conductor_inbox VALUES
        (1, 'legacy:C1', '["legacy-event"]', '["legacy"]', 'pending', 0, 1);
    `);

    expect(inbox.claimNext()).toBeNull();
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
  });
});
