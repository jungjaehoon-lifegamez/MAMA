/**
 * TG-05/TG-06: durable turns and report consumption finalize atomically
 * (design Decision 6). The event/receipt tables, not copied text in
 * messenger_sessions.context, are authoritative.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';

const OWNER_CHAT = '777001';
const SOURCE_REF = 'telegram:777001:9001';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('SessionStore report receipts', () => {
  let db: SQLiteDatabase;
  let sessions: SessionStore;
  let reports: TelegramReportContextStore;
  let sessionId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    sessions = new SessionStore(db);
    reports = new TelegramReportContextStore(db);
    sessionId = sessions.getOrCreate('telegram', OWNER_CHAT).id;

    reports.reserve({
      deliveryId: 'd-1',
      target: { source: 'telegram', channelId: OWNER_CHAT },
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text: 'first report',
      payloadIdentity: 'i'.repeat(64),
    });
    reports.markDelivered('d-1', '2026-08-06T10:15:00.000Z');
  });

  afterEach(() => {
    db.close();
  });

  function receiptInput(overrides: Partial<{ finalResponse: string }> = {}) {
    return {
      sessionId,
      sourceMessageRef: SOURCE_REF,
      finalResponse: overrides.finalResponse ?? 'the model reply',
      committedAtIso: '2026-08-06T12:30:00.000Z',
      receipt: {
        deliveryIds: ['d-1'],
        projectionVersion: 'v1',
        projectionText: '<recent_owner_reports projection="v1">\n...\n</recent_owner_reports>',
        projectionHash: 'h'.repeat(64),
      },
    };
  }

  it('stores a telegram user turn as provisional and excludes it from prompt formatting', () => {
    sessions.appendMessage(
      sessionId,
      { role: 'user', content: 'why did you say that?', timestamp: 1 },
      { sourceMessageRef: SOURCE_REF }
    );

    const history = sessions.getHistory(sessionId);
    expect(history[0]).toMatchObject({
      user: 'why did you say that?',
      sourceMessageRef: SOURCE_REF,
      state: 'provisional',
    });
    expect(sessions.formatContextForPrompt(sessionId)).toBe('New conversation');
  });

  it('finalizes the provisional turn, inserts the receipt, and consumes selected events atomically', () => {
    sessions.appendMessage(
      sessionId,
      { role: 'user', content: 'why did you say that?', timestamp: 1 },
      { sourceMessageRef: SOURCE_REF }
    );

    sessions.finalizeTurnWithReportReceipt(receiptInput());

    const turn = sessions.getHistory(sessionId)[0];
    expect(turn).toMatchObject({
      bot: 'the model reply',
      state: 'final',
      finalResponseSha256: sha256('the model reply'),
    });

    const receipt = db
      .prepare('SELECT * FROM telegram_report_context_receipts WHERE source_message_ref = ?')
      .get(SOURCE_REF) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      session_id: sessionId,
      delivery_ids: JSON.stringify(['d-1']),
      projection_version: 'v1',
      final_response_sha256: sha256('the model reply'),
    });

    const event = db
      .prepare(
        'SELECT disposition, consumed_by_ref FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('d-1') as { disposition: string; consumed_by_ref: string };
    expect(event.disposition).toBe('consumed_turn');
    expect(event.consumed_by_ref).toBe(SOURCE_REF);
  });

  it('replays the exact same finalization as a no-op', () => {
    sessions.appendMessage(
      sessionId,
      { role: 'user', content: 'why did you say that?', timestamp: 1 },
      { sourceMessageRef: SOURCE_REF }
    );
    sessions.finalizeTurnWithReportReceipt(receiptInput());

    sessions.finalizeTurnWithReportReceipt(receiptInput());

    const receipts = db
      .prepare('SELECT COUNT(*) AS n FROM telegram_report_context_receipts')
      .get() as { n: number };
    expect(receipts.n).toBe(1);
  });

  it('rejects a replay with a different final response as a conflict', () => {
    sessions.appendMessage(
      sessionId,
      { role: 'user', content: 'why did you say that?', timestamp: 1 },
      { sourceMessageRef: SOURCE_REF }
    );
    sessions.finalizeTurnWithReportReceipt(receiptInput());

    expect(() =>
      sessions.finalizeTurnWithReportReceipt(receiptInput({ finalResponse: 'another reply' }))
    ).toThrow(/conflict/i);
  });

  it('throws when no provisional turn matches the source message reference', () => {
    expect(() => sessions.finalizeTurnWithReportReceipt(receiptInput())).toThrow(
      /provisional turn/i
    );
  });

  it('consumes only the selected events and leaves later deliveries pending', () => {
    reports.reserve({
      deliveryId: 'd-2',
      target: { source: 'telegram', channelId: OWNER_CHAT },
      mode: 'digest',
      occurrence: { kind: 'digest' },
      text: 'second report',
      payloadIdentity: 'j'.repeat(64),
    });
    reports.markDelivered('d-2', '2026-08-06T12:20:00.000Z');
    sessions.appendMessage(
      sessionId,
      { role: 'user', content: 'why did you say that?', timestamp: 1 },
      { sourceMessageRef: SOURCE_REF }
    );

    sessions.finalizeTurnWithReportReceipt(receiptInput());

    const later = db
      .prepare('SELECT disposition FROM telegram_report_context_events WHERE delivery_id = ?')
      .get('d-2') as { disposition: string };
    expect(later.disposition).toBe('pending');
  });
});
