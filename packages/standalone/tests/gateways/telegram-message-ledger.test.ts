import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

describe('TelegramMessageLedger', () => {
  it('quarantines a corrupt shared ledger and fails startup instead of creating an empty one', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-ledger-corrupt-'));
    try {
      const path = join(root, 'ledger.json');
      writeFileSync(path, '{broken');
      expect(() => new TelegramMessageLedger(path)).toThrow(/ledger is corrupt/);
      expect(readdirSync(root).some((name) => name.includes('.corrupt-'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('erases one member DM and keeps the entries named to keep and every other DM', () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-erase-dm-'));
    try {
      const path = join(root, 'ledger.json');
      const ledger = new TelegramMessageLedger(path);
      const member = { deliveryTarget: 'telegram:12', payloadIdentity: 'a'.repeat(64) };
      ledger.claim('outbound:member', member);
      ledger.claim('file:erase:export', member);
      ledger.claim('outbound:other', { ...member, deliveryTarget: 'telegram:123' });
      expect(ledger.eraseTelegramDm('12', ['file:erase:export'])).toBe(1);
      const reopened = new TelegramMessageLedger(path);
      expect(reopened.get('outbound:member')).toBeNull();
      expect(reopened.get('file:erase:export')).not.toBeNull();
      expect(reopened.get('outbound:other')).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the delivered receipt when a regenerated payload has the same delivery key', () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-regenerated-'));
    try {
      const path = join(root, 'ledger.json');
      const first = new TelegramMessageLedger(path);
      const binding = { deliveryTarget: 'telegram:7', payloadIdentity: 'a'.repeat(64) };
      first.claim('outbound:report', binding);
      first.markDelivered('outbound:report');
      const log = vi.fn();
      const reopened = new TelegramMessageLedger(path, { log });
      expect(
        reopened.claim('outbound:report', {
          ...binding,
          payloadIdentity: 'b'.repeat(64),
          keepDeliveredOnPayloadChange: true,
        })
      ).toMatchObject({ claimed: false, entry: { state: 'delivered', ...binding } });
      expect(log.mock.calls.flat().join('\n')).toMatch(/payload.*identity.*key=outbound:report/);
      expect(new TelegramMessageLedger(path).get('outbound:report')?.payloadIdentity).toBe(
        binding.payloadIdentity
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads pre-trace outbound receipts without inventing ids or allowing a duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-ledger-'));
    try {
      const path = join(root, 'ledger.json');
      const binding = { deliveryTarget: 'telegram:7', payloadIdentity: 'a'.repeat(64) };
      writeFileSync(
        path,
        JSON.stringify({
          version: 3,
          entries: [
            {
              key: 'outbound:legacy',
              state: 'delivered',
              updatedAt: Date.now(),
              ownerId: 'previous-process',
              ...binding,
            },
          ],
        })
      );
      const ledger = new TelegramMessageLedger(path);
      expect(ledger.claim('outbound:legacy', binding)).toMatchObject({
        claimed: false,
        entry: { state: 'delivered' },
      });
      expect(ledger.get('outbound:legacy')?.idempotencyKey).toBeUndefined();
      expect(ledger.get('outbound:legacy')?.messageIds).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists completion and suppresses a repeated delivery after reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-ledger-'));
    try {
      const path = join(root, 'ledger.json');
      const first = new TelegramMessageLedger(path);
      const binding = {
        deliveryTarget: 'telegram:7',
        payloadIdentity: createHash('sha256').update('answer').digest('hex'),
      };
      expect(first.claim('telegram:7:11', binding).claimed).toBe(true);
      first.markReady('telegram:7:11', 'answer', 'html-v1');
      first.markDelivered('telegram:7:11');

      const reopened = new TelegramMessageLedger(path);
      expect(reopened.claim('telegram:7:11', binding)).toMatchObject({
        claimed: false,
        entry: { state: 'delivered' },
      });
      expect(reopened.listUndelivered()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['processing', 'delivered'])(
    'refuses a changed payload for a %s identity without opt-in',
    (state) => {
      const root = mkdtempSync(join(tmpdir(), 'mama-telegram-ledger-'));
      try {
        const ledger = new TelegramMessageLedger(join(root, 'ledger.json'));
        ledger.claim('outbound:answer', {
          deliveryTarget: 'telegram:7',
          payloadIdentity: createHash('sha256').update('first').digest('hex'),
        });
        if (state === 'delivered') ledger.markDelivered('outbound:answer');
        expect(() =>
          ledger.claim('outbound:answer', {
            deliveryTarget: 'telegram:7',
            payloadIdentity: createHash('sha256').update('second').digest('hex'),
          })
        ).toThrow(/binding mismatch/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('keeps a delivered receipt for new wording but refuses another destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-telegram-ledger-'));
    try {
      const ledger = new TelegramMessageLedger(join(root, 'ledger.json'), { log: () => {} });
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      ledger.claim('outbound:report', { deliveryTarget: 'telegram:7', payloadIdentity: hash('a') });
      ledger.markReady('outbound:report', 'a', 'html-v1');
      ledger.markDelivered('outbound:report');
      expect(
        ledger.claim('outbound:report', {
          deliveryTarget: 'telegram:7',
          payloadIdentity: hash('b'),
          keepDeliveredOnPayloadChange: true,
        })
      ).toMatchObject({ claimed: false, entry: { state: 'delivered' } });
      expect(() =>
        ledger.claim('outbound:report', {
          deliveryTarget: 'telegram:8',
          payloadIdentity: hash('a'),
          keepDeliveredOnPayloadChange: true,
        })
      ).toThrow(/binding mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
