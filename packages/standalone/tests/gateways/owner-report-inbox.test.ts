/**
 * TG-05/TG-06: owner-report inbox snapshot - the bounded pending projection a
 * verified owner turn consumes (design Decisions 4-6).
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';
import { OwnerReportInbox } from '../../src/gateways/owner-report-inbox.js';

const OWNER_CHAT = '777001';
const OWNER_TARGET = { source: 'telegram' as const, channelId: OWNER_CHAT };

describe('OwnerReportInbox', () => {
  let db: SQLiteDatabase;
  let store: TelegramReportContextStore;
  let inbox: OwnerReportInbox;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TelegramReportContextStore(db);
    inbox = new OwnerReportInbox(store);
  });

  afterEach(() => {
    db.close();
  });

  function deliver(deliveryId: string, text: string, channelId = OWNER_CHAT): void {
    store.reserve({
      deliveryId,
      target: { source: 'telegram', channelId },
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text,
      payloadIdentity: 'k'.repeat(64),
    });
    store.markDelivered(deliveryId, '2026-08-06T10:15:00.000Z');
  }

  it('returns null when no delivered-pending report exists', () => {
    expect(inbox.snapshot(OWNER_TARGET)).toBeNull();
  });

  it('snapshots pending reports as a Projection V1 block with their delivery IDs', () => {
    deliver('d-1', 'first report');
    deliver('d-2', 'second report');

    const snapshot = inbox.snapshot(OWNER_TARGET);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe('v1');
    expect(snapshot?.text).toContain('<recent_owner_reports projection="v1">');
    expect(snapshot?.text).toContain('first report');
    expect(snapshot?.text).toContain('second report');
    expect(snapshot?.deliveryIds).toEqual(['d-1', 'd-2']);
  });

  it('excludes consumed events and reports from other targets', () => {
    deliver('d-mine', 'my report');
    deliver('d-other', 'other chat report', '999999');
    db.prepare(
      "UPDATE telegram_report_context_events SET disposition = 'consumed_turn' WHERE delivery_id = ?"
    ).run('d-mine');

    expect(inbox.snapshot(OWNER_TARGET)).toBeNull();
  });

  it('never surfaces reports that are reserved but not yet delivered', () => {
    store.reserve({
      deliveryId: 'd-undelivered',
      target: OWNER_TARGET,
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text: 'not yet sent',
      payloadIdentity: 'l'.repeat(64),
    });

    expect(inbox.snapshot(OWNER_TARGET)).toBeNull();
  });

  describe('historyBlock (fresh-session restoration, design Decision 7)', () => {
    function seedReceipt(ref: string, projectionText: string, deliveryIds: string[]): void {
      db.prepare(
        `INSERT INTO telegram_report_context_receipts
           (source_message_ref, session_id, delivery_ids, projection_version,
            projection_text, projection_hash, final_response_sha256, committed_at)
         VALUES (?, 'sess-1', ?, 'v1', ?, ?, ?, '2026-08-06T12:30:00.000Z')`
      ).run(ref, JSON.stringify(deliveryIds), projectionText, 'n'.repeat(64), 'o'.repeat(64));
    }

    it('returns an empty string when no restored turn carries a receipt', () => {
      expect(inbox.historyBlock(OWNER_TARGET, [{ user: 'hello', bot: 'hi', state: 'final' }])).toBe(
        ''
      );
    });

    it('emits committed projections for final restored turns in turn order', () => {
      seedReceipt('telegram:777001:9001', 'projection block one', ['d-1']);
      seedReceipt('telegram:777001:9002', 'projection block two', ['d-2']);

      const block = inbox.historyBlock(OWNER_TARGET, [
        { user: 'q1', bot: 'a1', state: 'final', sourceMessageRef: 'telegram:777001:9001' },
        { user: 'q2', bot: 'a2', state: 'final', sourceMessageRef: 'telegram:777001:9002' },
      ]);

      const shaOf = (ref: string) => createHash('sha256').update(ref, 'utf8').digest('hex');
      expect(block).toBe(
        `<recent_owner_report_history projection="v1">\n` +
          `[before_turn source_message_ref_sha256=${shaOf('telegram:777001:9001')}]\n` +
          `projection block one` +
          `\n\n` +
          `[before_turn source_message_ref_sha256=${shaOf('telegram:777001:9002')}]\n` +
          `projection block two` +
          `\n</recent_owner_report_history>`
      );
    });

    it('excludes provisional turns and turns without receipts', () => {
      seedReceipt('telegram:777001:9001', 'committed projection', ['d-1']);
      seedReceipt('telegram:777001:9999', 'uncommitted turn projection', ['d-9']);

      const block = inbox.historyBlock(OWNER_TARGET, [
        { user: 'q1', bot: 'a1', state: 'final', sourceMessageRef: 'telegram:777001:9001' },
        { user: 'q2', bot: '', state: 'provisional', sourceMessageRef: 'telegram:777001:9999' },
        { user: 'q3', bot: 'a3' },
      ]);

      expect(block).toContain('committed projection');
      expect(block).not.toContain('uncommitted turn projection');
    });

    it('keeps only the newest receipts that fit five normal receipts, never slicing one', () => {
      const turns = [];
      for (let index = 1; index <= 7; index += 1) {
        const ref = `telegram:777001:${9000 + index}`;
        seedReceipt(ref, `projection number ${index}`, [`d-${index}`]);
        turns.push({
          user: `q${index}`,
          bot: `a${index}`,
          state: 'final' as const,
          sourceMessageRef: ref,
        });
      }

      const block = inbox.historyBlock(OWNER_TARGET, turns);

      expect(block).not.toContain('projection number 1');
      expect(block).not.toContain('projection number 2');
      for (let index = 3; index <= 7; index += 1) {
        expect(block).toContain(`projection number ${index}`);
      }
    });
  });
});

describe('historyBlock legacy V2 merge (design Decision 8)', () => {
  let db: SQLiteDatabase;
  let inbox: OwnerReportInbox;

  beforeEach(() => {
    db = new Database(':memory:');
    inbox = new OwnerReportInbox(new TelegramReportContextStore(db));
  });

  afterEach(() => {
    db.close();
  });

  function seedLegacy(
    deliveryId: string,
    consumedAt: string,
    text: string,
    channelId = OWNER_CHAT
  ): void {
    db.prepare(
      `INSERT INTO telegram_report_legacy_restorations
         (delivery_id, target, channel_key, delivered_at, consumed_at,
          restoration_text, legacy_projection_hash, payload_identity)
       VALUES (?, ?, ?, '2026-08-03T11:54:37.222Z', ?, ?, ?, ?)`
    ).run(
      deliveryId,
      JSON.stringify(['telegram', channelId]),
      `telegram:${channelId}`,
      consumedAt,
      JSON.stringify(text),
      't'.repeat(64),
      'u'.repeat(64)
    );
  }

  function seedReceipt2(ref: string, committedAt: string, projectionText: string): void {
    db.prepare(
      `INSERT INTO telegram_report_context_receipts
         (source_message_ref, session_id, delivery_ids, projection_version,
          projection_text, projection_hash, final_response_sha256, committed_at)
       VALUES (?, 'sess-1', ?, 'v1', ?, ?, ?, ?)`
    ).run(
      ref,
      JSON.stringify(['d-n']),
      projectionText,
      'v'.repeat(64),
      'w'.repeat(64),
      committedAt
    );
  }

  it('merges an eligible legacy restoration before newer receipts with the legacy grammar', () => {
    seedLegacy('legacy-1', '2026-08-03T12:11:32.262Z', 'legacy prefix body');
    seedReceipt2('telegram:777001:9001', '2026-08-05T09:00:00.000Z', 'newer projection');

    const block = inbox.historyBlock(
      OWNER_TARGET,
      [{ user: 'q', bot: 'a', state: 'final', sourceMessageRef: 'telegram:777001:9001' }],
      '2026-08-06T12:00:00.000Z'
    );

    const legacyIndex = block.indexOf('[legacy_v2_consumed delivery_sha256=');
    const receiptIndex = block.indexOf('[before_turn source_message_ref_sha256=');
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    expect(block).toContain('consumed_at=2026-08-03T12:11:32.262Z]');
    expect(block).toContain('legacy prefix body');
    expect(legacyIndex).toBeLessThan(receiptIndex);
  });

  it('drops a legacy restoration more than 30 days after consumption', () => {
    seedLegacy('legacy-old', '2026-07-01T00:00:00.000Z', 'stale legacy body');

    const block = inbox.historyBlock(
      OWNER_TARGET,
      [{ user: 'q', bot: 'a', state: 'final' }],
      '2026-08-06T12:00:00.000Z'
    );

    expect(block).toBe('');
  });

  it('scopes legacy restorations to the exact target', () => {
    seedLegacy('legacy-other', '2026-08-03T12:11:32.262Z', 'other chat legacy', '999999');

    const block = inbox.historyBlock(
      OWNER_TARGET,
      [{ user: 'q', bot: 'a', state: 'final' }],
      '2026-08-06T12:00:00.000Z'
    );

    expect(block).toBe('');
  });
});
