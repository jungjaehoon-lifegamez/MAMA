/**
 * TG-05 Slice J core: live/retained bounds, operator_archived, tombstone GC
 * (design Decisions 4-5). Prepared and pending-context records are never
 * automatically compacted; only consumed exact data is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';

const OWNER_CHAT = '777001';
const OWNER_TARGET = { source: 'telegram' as const, channelId: OWNER_CHAT };
const NOW = '2026-08-06T12:00:00.000Z';

describe('TelegramReportContextStore capacity core', () => {
  let db: SQLiteDatabase;
  let store: TelegramReportContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TelegramReportContextStore(db, {
      liveRowCapPerTarget: 3,
      retainedRowCapPerTarget: 4,
    });
  });

  afterEach(() => {
    db.close();
  });

  function reserveOne(deliveryId: string): void {
    store.reserve({
      deliveryId,
      target: OWNER_TARGET,
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text: `report ${deliveryId}`,
      payloadIdentity: 'z'.repeat(64),
    });
  }

  function consume(deliveryId: string): void {
    db.prepare(
      "UPDATE telegram_report_context_events SET disposition = 'consumed_turn', consumed_at = ? WHERE delivery_id = ?"
    ).run('2026-08-06T11:00:00.000Z', deliveryId);
  }

  it('fails a new reservation before any send when live capacity is full', () => {
    reserveOne('d-1');
    reserveOne('d-2');
    reserveOne('d-3');

    expect(() => reserveOne('d-4')).toThrow(/capacity_full/);
  });

  it('does not count consumed reports as live and frees capacity on consumption', () => {
    reserveOne('d-1');
    reserveOne('d-2');
    reserveOne('d-3');
    store.markDelivered('d-1', NOW);
    consume('d-1');

    expect(() => reserveOne('d-4')).not.toThrow();
  });

  it('compacts the oldest consumed exact records to identity tombstones under retained pressure', () => {
    for (const id of ['d-1', 'd-2', 'd-3']) {
      reserveOne(id);
      store.markDelivered(id, NOW);
      consume(id);
    }
    reserveOne('d-4');
    store.markDelivered('d-4', NOW);
    consume('d-4');

    // Retained cap is 4; the next reservation must first compact d-1.
    reserveOne('d-5');

    const oldest = db
      .prepare('SELECT text, tombstone FROM telegram_report_context_events WHERE delivery_id = ?')
      .get('d-1') as { text: string; tombstone: number };
    expect(oldest.tombstone).toBe(1);
    expect(oldest.text).toBe('');
    const pendingRow = db
      .prepare('SELECT text FROM telegram_report_context_events WHERE delivery_id = ?')
      .get('d-5') as { text: string };
    expect(pendingRow.text).toBe('report d-5');
  });

  it('never compacts prepared or pending-context records', () => {
    reserveOne('d-prepared');
    reserveOne('d-pending');
    store.markDelivered('d-pending', NOW);
    reserveOne('d-3');

    expect(() => reserveOne('d-4')).toThrow(/capacity_full/);
    const rows = db
      .prepare('SELECT delivery_id FROM telegram_report_context_events WHERE tombstone = 1')
      .all();
    expect(rows).toEqual([]);
  });

  it('archives only already-delivered pending rows through a sequence with an audit record', () => {
    reserveOne('d-1');
    reserveOne('d-2');
    store.markDelivered('d-1', NOW);
    const seq1 = store.getEvent('d-1')?.seq as number;

    const archived = store.archiveDelivered(OWNER_TARGET, seq1, 'owner', 'stale backlog', NOW);

    expect(archived).toEqual(['d-1']);
    const row = db
      .prepare(
        'SELECT disposition, archived_by, archived_reason, archived_at FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('d-1') as Record<string, string>;
    expect(row.disposition).toBe('operator_archived');
    expect(row.archived_by).toBe('owner');
    expect(row.archived_reason).toBe('stale backlog');
    // Undelivered rows are untouched.
    expect(store.getEvent('d-2')?.state).toBe('prepared_retryable');
    // Archived rows leave the pending projection.
    expect(store.listDeliveredPending(OWNER_TARGET)).toEqual([]);
  });

  it('reports live usage for the status surface', () => {
    reserveOne('d-1');
    store.markDelivered('d-1', NOW);
    reserveOne('d-2');

    const usage = store.liveUsage(OWNER_TARGET);

    expect(usage.rows).toBe(2);
    expect(usage.rowCap).toBe(3);
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.warn).toBe(false);
  });

  it('prunes only terminal tombstones older than the replay floor, oldest first', () => {
    for (const id of ['d-1', 'd-2']) {
      reserveOne(id);
      store.markDelivered(id, '2026-07-01T00:00:00.000Z');
      consume(id);
      db.prepare(
        'UPDATE telegram_report_context_events SET tombstone = 1, text = ? WHERE delivery_id = ?'
      ).run('', id);
    }
    reserveOne('d-fresh');
    store.markDelivered('d-fresh', NOW);
    consume('d-fresh');
    db.prepare(
      'UPDATE telegram_report_context_events SET tombstone = 1, text = ? WHERE delivery_id = ?'
    ).run('', 'd-fresh');

    const removed = store.pruneTombstones(NOW, { maxTombstones: 1 });

    // d-fresh is inside Telegram's seven-day replay floor - never pruned.
    const remaining = db
      .prepare(
        'SELECT delivery_id FROM telegram_report_context_events WHERE tombstone = 1 ORDER BY seq'
      )
      .all() as Array<{ delivery_id: string }>;
    expect(remaining.map((row) => row.delivery_id)).toContain('d-fresh');
    expect(removed).toBeGreaterThan(0);
  });
});
