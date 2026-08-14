/**
 * TG-05/TG-06: a verified owner turn consumes the pending report projection
 * exactly once, through one atomic turn/receipt commit (design Decision 6,
 * Turn data flow steps 5-8).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import { TelegramReportContextStore } from '../../src/gateways/telegram-report-context-store.js';
import { OwnerReportInbox } from '../../src/gateways/owner-report-inbox.js';
import { getRoleManager, resetRoleManager } from '../../src/agent/role-manager.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'mama-router-report-inbox-'));
const testMamaHome = join(testHome, '.mama');

beforeAll(() => {
  mkdirSync(testMamaHome, { recursive: true });
  mkdirSync(join(testMamaHome, 'briefs'), { recursive: true });
  writeFileSync(join(testMamaHome, 'SOUL.md'), '# Synthetic test persona\n', { mode: 0o600 });
  process.env.HOME = testHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

function processFixtureMessage(
  router: MessageRouter,
  message: NormalizedMessage
): ReturnType<MessageRouter['process']> {
  return router.process({
    ...message,
    principal: {
      class: 'owner',
      lane: 'owner',
      canonicalId: 'telegram:global:synthetic-owner',
      consoleEligible: false,
    },
  });
}

describe('MessageRouter owner-report inbox consumption', () => {
  let db: SQLiteDatabase;
  let sessionStore: SessionStore;
  let reportStore: TelegramReportContextStore;
  let ownerChat: string;
  let chatSequence = 0;

  beforeEach(() => {
    db = new Database(':memory:');
    sessionStore = new SessionStore(db);
    reportStore = new TelegramReportContextStore(db);
    ownerChat = `synthetic-owner-inbox-${process.pid}-${chatSequence++}`;
    resetRoleManager();
    getRoleManager().setTelegramTrust([ownerChat]);
  });

  afterEach(() => {
    resetRoleManager();
    sessionStore.close();
  });

  function deliver(deliveryId: string, text: string): void {
    reportStore.reserve({
      deliveryId,
      target: { source: 'telegram', channelId: ownerChat },
      mode: 'full',
      occurrence: { kind: 'scheduled_full' },
      text,
      payloadIdentity: 'm'.repeat(64),
    });
    reportStore.markDelivered(deliveryId, '2026-08-06T10:15:00.000Z');
  }

  function makeRouter(prompts: string[]): MessageRouter {
    return new MessageRouter(
      sessionStore,
      {
        run: vi.fn(async (prompt: string) => {
          prompts.push(prompt);
          return { response: 'Model reply about the report' };
        }),
      },
      createMockMamaApi([]),
      { backend: 'codex' },
      undefined,
      undefined,
      { ownerReportInbox: new OwnerReportInbox(reportStore) }
    );
  }

  it('prepends the pending projection once and finalizes turn, receipt, and consumption atomically', async () => {
    deliver('d-1', 'The deploy failed at step 3 - distinctive statement');
    const prompts: string[] = [];
    const router = makeRouter(prompts);

    await processFixtureMessage(router, {
      source: 'telegram',
      channelId: ownerChat,
      userId: ownerChat,
      text: 'why did you say that?',
      metadata: { chatType: 'private', messageId: '9001' },
    });

    expect(prompts[0]).toContain('<recent_owner_reports projection="v1">');
    expect(prompts[0]).toContain('distinctive statement');

    const sourceRef = `telegram:${ownerChat}:9001`;
    const receipt = db
      .prepare('SELECT * FROM telegram_report_context_receipts WHERE source_message_ref = ?')
      .get(sourceRef) as Record<string, unknown>;
    expect(receipt).toBeTruthy();
    expect(receipt.delivery_ids).toBe(JSON.stringify(['d-1']));

    const event = db
      .prepare(
        'SELECT disposition, consumed_by_ref FROM telegram_report_context_events WHERE delivery_id = ?'
      )
      .get('d-1') as { disposition: string; consumed_by_ref: string };
    expect(event.disposition).toBe('consumed_turn');
    expect(event.consumed_by_ref).toBe(sourceRef);

    const turn = sessionStore.getHistoryByChannel('telegram', ownerChat)[0];
    expect(turn).toMatchObject({
      state: 'final',
      sourceMessageRef: sourceRef,
      bot: 'Model reply about the report',
    });

    // The next continued turn must not receive the consumed report again.
    await processFixtureMessage(router, {
      source: 'telegram',
      channelId: ownerChat,
      userId: ownerChat,
      text: 'thanks',
      metadata: { chatType: 'private', messageId: '9002' },
    });
    expect(prompts[1]).not.toContain('<recent_owner_reports');
    const receipts = db
      .prepare('SELECT COUNT(*) AS n FROM telegram_report_context_receipts')
      .get() as { n: number };
    expect(receipts.n).toBe(1);
  });

  it('gives an unverified chat no inbox lookup even when reports are pending', async () => {
    deliver('d-1', 'owner only - distinctive statement');
    const prompts: string[] = [];
    const router = makeRouter(prompts);
    const strangerChat = `stranger-${process.pid}`;

    await processFixtureMessage(router, {
      source: 'telegram',
      channelId: strangerChat,
      userId: strangerChat,
      text: 'hello',
      metadata: { chatType: 'private', messageId: '9100' },
    });

    expect(prompts[0]).not.toContain('<recent_owner_reports');
    expect(prompts[0]).not.toContain('distinctive statement');
  });

  it('restores committed projections in a replacement conversation but never on resume', async () => {
    deliver('d-1', 'The deploy failed at step 3 - distinctive statement');
    const prompts: string[] = [];
    const optionsSeen: Array<{
      systemPrompt?: string;
      freshSessionSystemPrompt?: () => Promise<string>;
    }> = [];
    const router = new MessageRouter(
      sessionStore,
      {
        run: vi.fn(
          async (
            prompt: string,
            options?: { systemPrompt?: string; freshSessionSystemPrompt?: () => Promise<string> }
          ) => {
            prompts.push(prompt);
            optionsSeen.push(options ?? {});
            return { response: 'Model reply about the report' };
          }
        ),
      },
      createMockMamaApi([]),
      { backend: 'codex' },
      undefined,
      undefined,
      { ownerReportInbox: new OwnerReportInbox(reportStore) }
    );

    await processFixtureMessage(router, {
      source: 'telegram',
      channelId: ownerChat,
      userId: ownerChat,
      text: 'why did you say that?',
      metadata: { chatType: 'private', messageId: '9001' },
    });
    await processFixtureMessage(router, {
      source: 'telegram',
      channelId: ownerChat,
      userId: ownerChat,
      text: 'thanks',
      metadata: { chatType: 'private', messageId: '9002' },
    });

    // The resumed second turn must not replay the consumed report...
    expect(optionsSeen[1]?.systemPrompt ?? '').not.toContain('<recent_owner_report_history');
    // ...but an actual backend replacement rebuilds the committed history block.
    const freshPrompt = await optionsSeen[1]?.freshSessionSystemPrompt?.();
    expect(freshPrompt).toBeDefined();
    expect(freshPrompt).toContain('<recent_owner_report_history projection="v1">');
    expect(freshPrompt).toContain('distinctive statement');
  });

  it('surfaces a finalization conflict instead of reporting success', async () => {
    deliver('d-1', 'report body');
    db.prepare(
      `INSERT INTO telegram_report_context_receipts
         (source_message_ref, session_id, delivery_ids, projection_version,
          projection_text, projection_hash, final_response_sha256, committed_at)
       VALUES (?, 'other-session', ?, 'v1', 'text', ?, ?, '2026-08-06T09:00:00.000Z')`
    ).run(`telegram:${ownerChat}:9001`, JSON.stringify(['d-1']), 'p'.repeat(64), 'q'.repeat(64));
    const prompts: string[] = [];
    const router = makeRouter(prompts);

    await expect(
      processFixtureMessage(router, {
        source: 'telegram',
        channelId: ownerChat,
        userId: ownerChat,
        text: 'why did you say that?',
        metadata: { chatType: 'private', messageId: '9001' },
      })
    ).rejects.toThrow(/conflict/i);
  });
});
