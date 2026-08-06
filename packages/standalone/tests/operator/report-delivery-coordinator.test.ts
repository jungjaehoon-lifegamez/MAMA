/**
 * TG-05/TG-06: single production boundary for all owner-report modes.
 *
 * The coordinator reserves durable context BEFORE any Telegram send, executes
 * exactly one send per attempt lease, and reports typed outcomes
 * (design Decision 1-2, docs/development/telegram-outbound-context-inbox-design.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';
import {
  ReportDeliveryCoordinator,
  type ReportDeliveryLease,
  type TelegramReportDeliveryControl,
  type TypedTelegramDeliveryOutcome,
} from '../../src/operator/report-delivery-coordinator.js';
import {
  pendingReportDeliveryPayloadIdentity,
  type PendingReportDelivery,
} from '../../src/operator/pending-report-store.js';

const OWNER_CHAT = '777001';
const NOW = '2026-08-06T12:00:00.000Z';

class FakeControl implements TelegramReportDeliveryControl {
  calls: string[] = [];
  outcome: TypedTelegramDeliveryOutcome = { kind: 'confirmed' };
  sendError: Error | undefined;
  storeStateAtRelease: string | undefined;

  constructor(private readonly db: SQLiteDatabase) {}

  async claimAndPin(binding: { deliveryId: string }): Promise<ReportDeliveryLease> {
    this.calls.push(`claimAndPin:${binding.deliveryId}`);
    return { deliveryId: binding.deliveryId };
  }

  async sendPinned(lease: ReportDeliveryLease): Promise<TypedTelegramDeliveryOutcome> {
    this.calls.push(`sendPinned:${lease.deliveryId}`);
    if (this.sendError) throw this.sendError;
    return this.outcome;
  }

  async releasePin(deliveryId: string): Promise<void> {
    this.calls.push(`releasePin:${deliveryId}`);
    const row = this.db
      .prepare('SELECT state FROM telegram_report_context_events WHERE delivery_id = ?')
      .get(deliveryId) as { state: string } | undefined;
    this.storeStateAtRelease = row?.state;
  }

  async reconcilePins(nonterminalIds: string[], terminalIds: string[]): Promise<void> {
    this.calls.push(`reconcilePins:${nonterminalIds.join(',')}|${terminalIds.join(',')}`);
  }
}

function delivery(
  overrides: Partial<{ deliveryId: string; channelId: string; text: string }> = {}
): PendingReportDelivery {
  const base = {
    mode: 'full' as const,
    text: overrides.text ?? 'owner report body',
    citedTriggerIds: ['t-1'],
    createdAtIso: '2026-08-06T11:59:00.000Z',
    deliveryId: overrides.deliveryId ?? 'd-1',
    occurrence: { kind: 'scheduled_full' as const, hourKey: '2026-08-06T11' },
    target: { source: 'telegram' as const, channelId: overrides.channelId ?? OWNER_CHAT },
  };
  return {
    ...base,
    payloadIdentity: pendingReportDeliveryPayloadIdentity(base),
  };
}

describe('ReportDeliveryCoordinator', () => {
  let db: SQLiteDatabase;
  let store: TelegramReportContextStore;
  let control: FakeControl;
  let coordinator: ReportDeliveryCoordinator;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TelegramReportContextStore(db);
    control = new FakeControl(db);
    coordinator = new ReportDeliveryCoordinator({
      store,
      control,
      ownerTarget: { source: 'telegram', channelId: OWNER_CHAT },
      executorId: 'executor-1',
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('reserves context, pins, sends, marks delivered, then releases the pin', async () => {
    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome).toEqual({ status: 'delivered' });
    expect(control.calls).toEqual(['claimAndPin:d-1', 'sendPinned:d-1', 'releasePin:d-1']);
    // Pin release happens only AFTER the delivered transition committed.
    expect(control.storeStateAtRelease).toBe('delivered');
    const row = db
      .prepare('SELECT state FROM telegram_report_context_events WHERE delivery_id = ?')
      .get('d-1') as { state: string };
    expect(row.state).toBe('delivered');
  });

  it('rejects a target that differs from the configured owner target before reservation', async () => {
    await expect(coordinator.deliverPrepared(delivery({ channelId: '999999' }))).rejects.toThrow(
      /owner-report target/i
    );

    const count = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
    expect(control.calls).toEqual([]);
  });

  it('rejects a payload identity mismatch before reservation', async () => {
    const tampered = { ...delivery(), payloadIdentity: 'forged' };

    await expect(coordinator.deliverPrepared(tampered)).rejects.toThrow(/payload identity/i);
    const count = db.prepare('SELECT COUNT(*) AS n FROM telegram_report_context_events').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('schedules a retry with design backoff on a retryable outcome and keeps the pin', async () => {
    control.outcome = { kind: 'retryable', detail: 'telegram 502' };

    const outcome = await coordinator.deliverPrepared(delivery());

    // First attempt -> 1 minute backoff (1m, 5m, 30m, 2h, 12h capped).
    expect(outcome).toEqual({
      status: 'retry_scheduled',
      nextAttemptAt: '2026-08-06T12:01:00.000Z',
    });
    expect(control.calls).not.toContain('releasePin:d-1');
    const row = db
      .prepare(
        'SELECT state, next_attempt_at FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('d-1') as { state: string; next_attempt_at: string };
    expect(row.state).toBe('prepared_retryable');
    expect(row.next_attempt_at).toBe('2026-08-06T12:01:00.000Z');
  });

  it('treats a thrown transport error as retryable', async () => {
    control.sendError = new Error('socket hang up');

    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome).toEqual({
      status: 'retry_scheduled',
      nextAttemptAt: '2026-08-06T12:01:00.000Z',
    });
    const row = db
      .prepare('SELECT state FROM telegram_report_context_events WHERE delivery_id = ?')
      .get('d-1') as { state: string };
    expect(row.state).toBe('prepared_retryable');
  });

  it('records a definite rejection as a nonterminal terminal-protocol state and keeps the pin', async () => {
    control.outcome = { kind: 'definite_rejection', reason: 'bot blocked' };

    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome).toEqual({ status: 'definite_rejection', reason: 'bot blocked' });
    expect(control.calls).not.toContain('releasePin:d-1');
    const row = db
      .prepare(
        'SELECT state, rejection_reason FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('d-1') as { state: string; rejection_reason: string };
    expect(row.state).toBe('prepared_definite_rejection');
    expect(row.rejection_reason).toBe('bot blocked');
  });

  it('converges an already-delivered replay without sending again', async () => {
    await coordinator.deliverPrepared(delivery());
    control.calls = [];

    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome).toEqual({ status: 'delivered' });
    // Crash between delivered-commit and unpin must converge: replay re-releases
    // the pin idempotently and never sends.
    expect(control.calls).toEqual(['releasePin:d-1']);
  });

  it('returns the recorded cancellation on a cancelled replay without sending', async () => {
    control.outcome = { kind: 'definite_rejection', reason: 'bot blocked' };
    await coordinator.deliverPrepared(delivery());
    store.cancel('d-1', 'owner changed the report chat', '2026-08-06T14:00:00.000Z');
    control.calls = [];

    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome).toEqual({ status: 'cancelled', reason: 'owner changed the report chat' });
    expect(control.calls).toEqual([]);
  });

  it('returns a typed capacity_full outcome instead of throwing when live capacity is exhausted', async () => {
    const tight = new TelegramReportContextStore(new Database(':memory:'), {
      liveRowCapPerTarget: 1,
    });
    const tightControl = new FakeControl(db);
    const tightCoordinator = new ReportDeliveryCoordinator({
      store: tight,
      control: tightControl,
      ownerTarget: { source: 'telegram', channelId: OWNER_CHAT },
      executorId: 'executor-1',
      nowIso: () => NOW,
    });
    tight.reserve({
      deliveryId: 'd-existing',
      target: { source: 'telegram', channelId: OWNER_CHAT },
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text: 'occupies the only live slot',
      payloadIdentity: 'q'.repeat(64),
    });

    const outcome = await tightCoordinator.deliverPrepared(delivery({ deliveryId: 'd-overflow' }));

    expect(outcome.status).toBe('capacity_full');
    expect(tightControl.calls).toEqual([]);
  });

  it('does not send while another executor holds a live attempt lease', async () => {
    store.reserve({
      deliveryId: 'd-1',
      target: { source: 'telegram', channelId: OWNER_CHAT },
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text: 'owner report body',
      payloadIdentity: delivery().payloadIdentity as string,
    });
    store.claimAttempt('d-1', 'other-executor', NOW, '2026-08-06T12:05:00.000Z');

    const outcome = await coordinator.deliverPrepared(delivery());

    expect(outcome.status).toBe('retry_scheduled');
    expect(control.calls).toEqual([]);
  });
});
