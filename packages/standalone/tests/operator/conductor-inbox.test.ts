/**
 * The inbox exists so a conductor crash can never lose an event batch:
 * rows are durable, claims are leases, and an unacked claim returns to
 * pending. Per-event dedupe turns redelivery after a cursor rollback into
 * a no-op — including PARTIAL redelivery under a different batch boundary.
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

  it('full redelivery is dropped; PARTIAL redelivery keeps only unseen events', () => {
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
    expect(second.lines).toEqual(['line 1c']);
  });

  it('a batch failing 5 times parks as dead, never spins forever', () => {
    inbox.enqueue(batch(1));
    for (let i = 0; i < 5; i++) {
      const c = inbox.claimNext()!;
      inbox.retry(c.id, `fail ${i}`);
    }
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
});
