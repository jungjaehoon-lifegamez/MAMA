/**
 * TG-05/TG-06: Telegram owner-report context inbox store.
 *
 * The messenger SQLite database is the single report-context authority
 * (design: docs/development/telegram-outbound-context-inbox-design.md, Decision 4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';

describe('TelegramReportContextStore', () => {
  let db: SQLiteDatabase;
  let store: TelegramReportContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TelegramReportContextStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('migration', () => {
    it('creates the report context event and receipt tables', () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_report_context_events', 'telegram_report_context_receipts') ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual([
        'telegram_report_context_events',
        'telegram_report_context_receipts',
      ]);
    });
  });

  describe('reserve()', () => {
    it('inserts the exact report as prepared_retryable and allocates a monotonic seq', () => {
      const first = store.reserve(artifact({ deliveryId: 'd-1' }));
      const second = store.reserve(artifact({ deliveryId: 'd-2' }));

      expect(first.state).toBe('prepared_retryable');
      expect(second.state).toBe('prepared_retryable');
      expect(second.seq).toBeGreaterThan(first.seq);
    });

    it('is idempotent for an identical replay of the same delivery ID', () => {
      const first = store.reserve(artifact({ deliveryId: 'd-1' }));
      const replay = store.reserve(artifact({ deliveryId: 'd-1' }));

      expect(replay.seq).toBe(first.seq);
      expect(replay.state).toBe('prepared_retryable');
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events')
        .get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('rejects a replay whose payload differs from the reserved report', () => {
      store.reserve(artifact({ deliveryId: 'd-1', text: 'original report' }));

      expect(() => store.reserve(artifact({ deliveryId: 'd-1', text: 'tampered report' }))).toThrow(
        /identity conflict/i
      );
    });
  });

  describe('markDelivered()', () => {
    it('transitions prepared_retryable to delivered with a pending context disposition', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));

      store.markDelivered('d-1', '2026-08-06T10:15:00.000Z');

      const row = db
        .prepare(
          'SELECT state, disposition, delivered_at FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as { state: string; disposition: string; delivered_at: string };
      expect(row.state).toBe('delivered');
      expect(row.disposition).toBe('pending');
      expect(row.delivered_at).toBe('2026-08-06T10:15:00.000Z');
    });

    it('is idempotent and keeps the original delivery time', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.markDelivered('d-1', '2026-08-06T10:15:00.000Z');

      store.markDelivered('d-1', '2026-08-06T11:00:00.000Z');

      const row = db
        .prepare('SELECT delivered_at FROM telegram_report_context_events WHERE delivery_id = ?')
        .get('d-1') as { delivered_at: string };
      expect(row.delivered_at).toBe('2026-08-06T10:15:00.000Z');
    });

    it('throws for an unknown delivery ID', () => {
      expect(() => store.markDelivered('missing', '2026-08-06T10:15:00.000Z')).toThrow(
        /unknown owner report delivery/i
      );
    });

    it('refuses to deliver a definitively rejected delivery without explicit reactivation', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      db.prepare(
        "UPDATE telegram_report_context_events SET state = 'prepared_definite_rejection' WHERE delivery_id = ?"
      ).run('d-1');

      expect(() => store.markDelivered('d-1', '2026-08-06T10:15:00.000Z')).toThrow(
        /cannot be marked delivered from state prepared_definite_rejection/i
      );
    });

    it('lets a reserve replay of a delivered row observe success without a new row', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.markDelivered('d-1', '2026-08-06T10:15:00.000Z');

      const replay = store.reserve(artifact({ deliveryId: 'd-1' }));

      expect(replay.state).toBe('delivered');
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events')
        .get() as { n: number };
      expect(count.n).toBe(1);
    });
  });

  describe('claimAttempt()', () => {
    const T0 = '2026-08-06T10:00:00.000Z';
    const T0_LEASE = '2026-08-06T10:05:00.000Z';
    const AFTER_LEASE = '2026-08-06T10:06:00.000Z';

    it('grants an attempt lease on a prepared_retryable row and counts the attempt', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));

      const lease = store.claimAttempt('d-1', 'worker-a', T0, T0_LEASE);

      expect(lease).not.toBeNull();
      const row = db
        .prepare(
          'SELECT attempt_owner, lease_until, attempt_count FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as { attempt_owner: string; lease_until: string; attempt_count: number };
      expect(row.attempt_owner).toBe('worker-a');
      expect(row.lease_until).toBe(T0_LEASE);
      expect(row.attempt_count).toBe(1);
    });

    it('excludes every other claim while a lease is live, including the same owner', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', T0, T0_LEASE);

      expect(
        store.claimAttempt('d-1', 'worker-b', '2026-08-06T10:01:00.000Z', T0_LEASE)
      ).toBeNull();
      expect(
        store.claimAttempt('d-1', 'worker-a', '2026-08-06T10:01:00.000Z', T0_LEASE)
      ).toBeNull();
    });

    it('refuses a claim before the scheduled next attempt time and grants it after', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', T0, T0_LEASE);
      store.scheduleRetry('d-1', 'worker-a', '2026-08-06T10:10:00.000Z');

      expect(
        store.claimAttempt(
          'd-1',
          'worker-b',
          '2026-08-06T10:07:00.000Z',
          '2026-08-06T10:12:00.000Z'
        )
      ).toBeNull();
      expect(
        store.claimAttempt(
          'd-1',
          'worker-b',
          '2026-08-06T10:10:00.000Z',
          '2026-08-06T10:15:00.000Z'
        )
      ).not.toBeNull();
    });

    it('lets an expired lease be reclaimed after restart', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', T0, T0_LEASE);

      const reclaimed = store.claimAttempt(
        'd-1',
        'worker-b',
        AFTER_LEASE,
        '2026-08-06T10:11:00.000Z'
      );

      expect(reclaimed).not.toBeNull();
      const row = db
        .prepare(
          'SELECT attempt_owner, attempt_count FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as { attempt_owner: string; attempt_count: number };
      expect(row.attempt_owner).toBe('worker-b');
      expect(row.attempt_count).toBe(2);
    });

    it('never grants an attempt on a delivered row', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.markDelivered('d-1', '2026-08-06T10:15:00.000Z');

      expect(
        store.claimAttempt('d-1', 'worker-a', AFTER_LEASE, '2026-08-06T10:11:00.000Z')
      ).toBeNull();
    });
  });

  describe('recovery listings', () => {
    const NOW = '2026-08-06T12:00:00.000Z';

    it('lists recoverable prepared_retryable rows in seq order and skips delivered rows', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.reserve(artifact({ deliveryId: 'd-2' }));
      store.reserve(artifact({ deliveryId: 'd-3' }));
      store.markDelivered('d-2', '2026-08-06T10:15:00.000Z');

      const recoverable = store.listRecoverable(NOW);

      expect(recoverable.map((r) => r.deliveryId)).toEqual(['d-1', 'd-3']);
    });

    it('skips rows waiting on a future retry and rows with a live lease', () => {
      store.reserve(artifact({ deliveryId: 'd-backoff' }));
      db.prepare(
        'UPDATE telegram_report_context_events SET next_attempt_at = ? WHERE delivery_id = ?'
      ).run('2026-08-06T13:00:00.000Z', 'd-backoff');

      store.reserve(artifact({ deliveryId: 'd-leased' }));
      store.claimAttempt('d-leased', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');

      store.reserve(artifact({ deliveryId: 'd-expired-lease' }));
      store.claimAttempt('d-expired-lease', 'worker-a', NOW, '2026-08-06T12:01:00.000Z');

      const recoverable = store.listRecoverable('2026-08-06T12:02:00.000Z');

      expect(recoverable.map((r) => r.deliveryId)).toEqual(['d-expired-lease']);
    });

    it('schedules a retry with a future attempt time and releases the holder lease', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');

      store.scheduleRetry('d-1', 'worker-a', '2026-08-06T12:01:00.000Z');

      const row = db
        .prepare(
          'SELECT next_attempt_at, attempt_owner, lease_until, state FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as {
        next_attempt_at: string;
        attempt_owner: string | null;
        lease_until: string | null;
        state: string;
      };
      expect(row.state).toBe('prepared_retryable');
      expect(row.next_attempt_at).toBe('2026-08-06T12:01:00.000Z');
      expect(row.attempt_owner).toBeNull();
      expect(row.lease_until).toBeNull();
    });

    it('refuses a retry schedule from a non-holder so a stale worker cannot reshape backoff', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');

      expect(() => store.scheduleRetry('d-1', 'worker-b', '2026-08-06T12:01:00.000Z')).toThrow(
        /does not hold the attempt lease/i
      );
    });

    it('moves a definite Telegram non-acceptance to prepared_definite_rejection with its reason', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');

      store.markDefiniteRejection('d-1', 'worker-a', 'bot blocked by owner chat');

      const row = db
        .prepare(
          'SELECT state, rejection_reason, attempt_owner, lease_until FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as {
        state: string;
        rejection_reason: string;
        attempt_owner: string | null;
        lease_until: string | null;
      };
      expect(row.state).toBe('prepared_definite_rejection');
      expect(row.rejection_reason).toBe('bot blocked by owner chat');
      expect(row.attempt_owner).toBeNull();
      expect(row.lease_until).toBeNull();
    });

    it('cancels only a proven definite rejection and records the operator action', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');
      store.markDefiniteRejection('d-1', 'worker-a', 'bot blocked');

      store.cancel('d-1', 'owner changed the report chat', '2026-08-06T14:00:00.000Z');

      const row = db
        .prepare(
          'SELECT state, cancel_reason, cancelled_at FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as { state: string; cancel_reason: string; cancelled_at: string };
      expect(row.state).toBe('cancelled');
      expect(row.cancel_reason).toBe('owner changed the report chat');
      expect(row.cancelled_at).toBe('2026-08-06T14:00:00.000Z');
    });

    it('refuses to cancel a retryable or delivered report', () => {
      store.reserve(artifact({ deliveryId: 'd-retryable' }));
      store.reserve(artifact({ deliveryId: 'd-delivered' }));
      store.markDelivered('d-delivered', '2026-08-06T10:15:00.000Z');

      expect(() => store.cancel('d-retryable', 'reason', NOW)).toThrow(
        /only a definite rejection/i
      );
      expect(() => store.cancel('d-delivered', 'reason', NOW)).toThrow(
        /only a definite rejection/i
      );
    });

    it('replays cancellation idempotently so crash cleanup converges', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');
      store.markDefiniteRejection('d-1', 'worker-a', 'bot blocked');
      store.cancel('d-1', 'owner changed the report chat', '2026-08-06T14:00:00.000Z');

      store.cancel('d-1', 'a different later reason', '2026-08-06T15:00:00.000Z');

      const row = db
        .prepare(
          'SELECT cancel_reason, cancelled_at FROM telegram_report_context_events WHERE delivery_id = ?'
        )
        .get('d-1') as { cancel_reason: string; cancelled_at: string };
      expect(row.cancel_reason).toBe('owner changed the report chat');
      expect(row.cancelled_at).toBe('2026-08-06T14:00:00.000Z');
    });

    it('reactivates a definite rejection back to retryable for the same delivery ID', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));
      store.claimAttempt('d-1', 'worker-a', NOW, '2026-08-06T12:05:00.000Z');
      store.markDefiniteRejection('d-1', 'worker-a', 'bot blocked');

      store.reactivate('d-1');

      const event = store.getEvent('d-1');
      expect(event?.state).toBe('prepared_retryable');
      expect(store.listRecoverable('2026-08-06T15:00:00.000Z').map((r) => r.deliveryId)).toContain(
        'd-1'
      );
    });

    it('refuses to reactivate anything but a definite rejection', () => {
      store.reserve(artifact({ deliveryId: 'd-1' }));

      expect(() => store.reactivate('d-1')).toThrow(/only a definite rejection/i);
    });

    it('classifies nonterminal and terminal delivery IDs for ledger pin reconciliation', () => {
      store.reserve(artifact({ deliveryId: 'd-retryable' }));
      store.reserve(artifact({ deliveryId: 'd-rejected' }));
      db.prepare(
        "UPDATE telegram_report_context_events SET state = 'prepared_definite_rejection' WHERE delivery_id = ?"
      ).run('d-rejected');
      store.reserve(artifact({ deliveryId: 'd-delivered' }));
      store.markDelivered('d-delivered', '2026-08-06T10:15:00.000Z');

      const { nonterminal, terminal } = store.listPinReconciliation();

      expect(nonterminal).toEqual(['d-retryable', 'd-rejected']);
      expect(terminal).toEqual(['d-delivered']);
    });
  });
});

function artifact(overrides: { deliveryId: string; text?: string; channelId?: string }): {
  deliveryId: string;
  target: { source: 'telegram'; channelId: string };
  mode: 'digest' | 'full';
  occurrence: Record<string, unknown>;
  text: string;
  payloadIdentity: string;
} {
  const text = overrides.text ?? 'owner report body';
  return {
    deliveryId: overrides.deliveryId,
    target: { source: 'telegram', channelId: overrides.channelId ?? '12345' },
    mode: 'full',
    occurrence: { hourKey: '2026-08-06T10' },
    text,
    payloadIdentity: `identity:${overrides.deliveryId}:${text}`,
  };
}
