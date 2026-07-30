/**
 * The inbox exists so a conductor crash can never lose an event batch:
 * rows are durable, claims are leases, and an unacked claim returns to
 * pending. Per-event dedupe turns redelivery after a cursor rollback into
 * a no-op - including PARTIAL redelivery under a different batch boundary.
 * eventIds (identity) and lines (display) are independent fields, never
 * zipped positionally.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { ConductorInbox } from '../../src/operator/conductor-inbox.js';

const batch = (n: number) => ({
  channelKey: `chat C${n}`,
  eventIds: [`evt_${n}a`, `evt_${n}b`],
  lines: [`line ${n}a`, `line ${n}b`],
});

describe('ConductorInbox', () => {
  let db: SQLiteDatabase;
  let inbox: ConductorInbox;
  beforeEach(() => {
    db = new Database(':memory:');
    inbox = new ConductorInbox(db);
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

  it('a killed conductor loses nothing: unacked claim replays', () => {
    inbox.enqueue(batch(1));
    const a = inbox.claimNext();
    expect(a).not.toBeNull();
    // conductor dies here - no ack. Lease expires:
    const replayed = inbox.replayStale(0);
    expect(replayed).toBe(1);
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
    expect(inbox.enqueue({ channelKey: 'chat C1', eventIds: ids, lines })).not.toBeNull();
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
    expect(inbox.claimNext()?.attempts).toBe(1);
  });

  it('replayStale applies the SAME poison cap as retry - a lease-expiring batch cannot re-pend forever', () => {
    inbox.enqueue(batch(1));
    for (let i = 0; i < 4; i++) {
      inbox.claimNext();
      expect(inbox.replayStale(0)).toBe(1);
    }
    inbox.claimNext();
    inbox.replayStale(0); // 5th expiry parks it
    expect(inbox.claimNext()).toBeNull();
    expect(inbox.depth().dead).toBe(1);
  });

  it('housekeeping: acked rows age out after 7 days, live rows survive', () => {
    inbox.enqueue(batch(1));
    inbox.enqueue(batch(2));
    const a = inbox.claimNext()!;
    inbox.ack(a.id);
    const eightDays = Date.now() + 8 * 86_400_000;
    inbox.replayStale(60_000, eightDays);
    const acked = db
      .prepare(`SELECT COUNT(*) AS n FROM conductor_inbox WHERE status = 'acked'`)
      .get() as { n: number };
    expect(acked.n).toBe(0);
    // batch 2 was pending for 8 days - stale-parked as dead, visibly, so a
    // shadow-mode backlog cannot detonate as months of replays on enable.
    expect(inbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 1 });
  });

  it('housekeeping: the dedupe table keeps a 30-day horizon, not forever', () => {
    inbox.enqueue(batch(1));
    const count = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM conductor_inbox_events`).get() as { n: number }).n;
    expect(count()).toBe(2);
    inbox.replayStale(60_000, Date.now() + 29 * 86_400_000);
    expect(count()).toBe(2); // inside the horizon
    inbox.replayStale(60_000, Date.now() + 31 * 86_400_000);
    expect(count()).toBe(0); // aged out - far wider than any redelivery gap
  });
});
