import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import {
  buildOwnerEventTelegramIntent,
  buildOwnerEventEffectAuthority,
  OwnerEventEffectLedger,
} from '../../src/operator/owner-event-effects.js';
import type { OwnerEventBatch } from '../../src/operator/owner-event-inbox.js';

const claimedBatch: OwnerEventBatch = {
  id: 41,
  channelKey: 'chatwork:C1',
  eventIds: ['evt-a', 'evt-b'],
  lines: ['feedback'],
  activations: [
    {
      triggerId: 'feedback-trigger',
      kind: 'feedback relay',
      memoryQuery: 'feedback relay',
      requiredEvidence: ['current_message'],
      procedure: [
        { action: 'translate', description: 'Translate the feedback.' },
        { action: 'deliver', description: 'Deliver the translation.' },
      ],
    },
  ],
  status: 'claimed',
  attempts: 0,
  createdAt: 0,
};

describe('TG-03/TG-04/TG-06 host-issued owner-event effects', () => {
  it('derives exactly one immutable host key per external effect kind', () => {
    expect(buildOwnerEventEffectAuthority(claimedBatch)).toEqual({
      batchId: 41,
      effectKeys: {
        telegram_send: 'telegram-delivery',
        drive_upload: 'drive-upload',
      },
    });
  });

  it('keeps the same effect identities when no trigger procedure matched', () => {
    expect(buildOwnerEventEffectAuthority({ ...claimedBatch, activations: [] })).toEqual({
      batchId: 41,
      effectKeys: {
        telegram_send: 'telegram-delivery',
        drive_upload: 'drive-upload',
      },
    });
  });

  it('serializes one external effect occurrence before transmission and preserves confirmation', () => {
    const ledger = new OwnerEventEffectLedger(new Database(':memory:'), () => 1_000);

    expect(
      ledger.begin(41, 'drive-upload', 'drive_upload', { folderId: 'folder-original' })
    ).toEqual({ state: 'execute', intent: { folderId: 'folder-original' } });
    expect(
      ledger.begin(41, 'drive-upload', 'drive_upload', { folderId: 'folder-changed' })
    ).toEqual({
      state: 'reconcile',
      intent: { folderId: 'folder-original' },
    });

    ledger.confirm(41, 'drive-upload', 'drive_upload', {
      fileId: 'uploaded-1',
      name: 'translated.png',
    });
    expect(ledger.begin(41, 'drive-upload', 'drive_upload')).toEqual({
      state: 'confirmed',
      intent: { folderId: 'folder-original' },
      result: { fileId: 'uploaded-1', name: 'translated.png' },
    });
    expect(ledger.confirmedKinds(41)).toEqual(['drive_upload']);
    expect(ledger.begin(41, 'telegram-delivery', 'telegram_send')).toEqual({
      state: 'execute',
      intent: {},
    });
    expect(() => ledger.begin(41, 'drive-upload', 'telegram_send')).toThrow(/bound/i);
  });

  it('keeps an ambiguous transmitted effect in reconcile-only state', () => {
    const ledger = new OwnerEventEffectLedger(new Database(':memory:'), () => 1_000);
    expect(ledger.begin(41, 'drive-upload', 'drive_upload')).toEqual({
      state: 'execute',
      intent: {},
    });
    ledger.markUnknown(41, 'drive-upload', 'drive_upload', 'transport timeout');
    expect(ledger.begin(41, 'drive-upload', 'drive_upload')).toEqual({
      state: 'reconcile',
      intent: {},
    });
  });

  it('TG-06 builds one exact versioned Telegram intent before transmission', () => {
    expect(
      buildOwnerEventTelegramIntent({
        chatId: '7777',
        message: '  Hello 🌕\nsecond line  ',
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
      })
    ).toEqual({
      version: 1,
      chatId: '7777',
      variant: 'text',
      deliveryId: 'owner-event:41:telegram:telegram-delivery',
      message: '  Hello 🌕\nsecond line  ',
      filePath: null,
      stickerEmotion: null,
    });

    expect(() =>
      buildOwnerEventTelegramIntent({
        chatId: '7777',
        message: '   ',
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
      })
    ).toThrow(/message.*blank/i);
    expect(() =>
      buildOwnerEventTelegramIntent({
        chatId: '7777',
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
      })
    ).toThrow(/message.*file_path.*sticker_emotion/i);
  });

  it('TG-03/TG-06 resolves file intent once and normalizes sticker emotion', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mama-owner-effect-intent-'));
    const imagePath = join(workspace, 'translated.png');
    writeFileSync(imagePath, 'synthetic-image');
    const previousWorkspace = process.env.MAMA_WORKSPACE;
    process.env.MAMA_WORKSPACE = workspace;
    try {
      const fileInput = {
        chatId: '7777',
        message: ' exact caption ',
        filePath: imagePath,
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
      };
      const fileIntent = buildOwnerEventTelegramIntent(fileInput);
      expect(fileIntent).toEqual({
        version: 1,
        chatId: '7777',
        variant: 'image',
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
        message: ' exact caption ',
        filePath: realpathSync(imagePath),
        stickerEmotion: null,
      });
      rmSync(imagePath);
      expect(buildOwnerEventTelegramIntent(fileInput, fileIntent)).toEqual(fileIntent);
      expect(() =>
        buildOwnerEventTelegramIntent(
          { ...fileInput, filePath: join(workspace, 'different.png') },
          fileIntent
        )
      ).toThrow(/ENOENT/);
      expect(
        buildOwnerEventTelegramIntent({
          chatId: '7777',
          stickerEmotion: '  HAPPY ',
          deliveryId: 'owner-event:41:telegram:telegram-delivery',
        })
      ).toEqual({
        version: 1,
        chatId: '7777',
        variant: 'sticker',
        deliveryId: 'owner-event:41:telegram:telegram-delivery',
        message: null,
        filePath: null,
        stickerEmotion: 'happy',
      });
    } finally {
      if (previousWorkspace === undefined) delete process.env.MAMA_WORKSPACE;
      else process.env.MAMA_WORKSPACE = previousWorkspace;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('TG-06 rejects changed versioned Telegram intent but replays an exact receipt', () => {
    const ledger = new OwnerEventEffectLedger(new Database(':memory:'), () => 1_000);
    const intent = buildOwnerEventTelegramIntent({
      chatId: '7777',
      message: 'first translation',
      deliveryId: 'owner-event:41:telegram:telegram-delivery',
    });
    expect(ledger.begin(41, 'telegram-delivery', 'telegram_send', intent)).toEqual({
      state: 'execute',
      intent,
    });
    expect(ledger.begin(41, 'telegram-delivery', 'telegram_send', intent)).toEqual({
      state: 'reconcile',
      intent,
    });
    expect(() =>
      ledger.begin(41, 'telegram-delivery', 'telegram_send', {
        ...intent,
        message: 'rephrased retry',
      })
    ).toThrow(/intent.*mismatch/i);

    const receipt = {
      version: 1,
      deliveryId: intent.deliveryId,
      variant: 'text',
      state: 'delivered',
      payloadIdentity: 'a'.repeat(64),
      confirmedAt: 1_000,
    } as const;
    ledger.confirm(41, 'telegram-delivery', 'telegram_send', receipt);
    expect(ledger.begin(41, 'telegram-delivery', 'telegram_send', intent)).toEqual({
      state: 'confirmed',
      intent,
      result: receipt,
    });
  });

  it('TG-06 preserves legacy no-replay rows without inferring payloads', () => {
    const ledger = new OwnerEventEffectLedger(new Database(':memory:'), () => 1_000);
    expect(
      ledger.begin(41, 'telegram-delivery', 'telegram_send', {
        chatId: '7777',
        variant: 'text',
      })
    ).toMatchObject({ state: 'execute' });
    ledger.confirm(41, 'telegram-delivery', 'telegram_send', null);

    const versioned = buildOwnerEventTelegramIntent({
      chatId: '7777',
      message: 'new text must not be inferred as old text',
      deliveryId: 'owner-event:41:telegram:telegram-delivery',
    });
    expect(ledger.begin(41, 'telegram-delivery', 'telegram_send', versioned)).toEqual({
      state: 'confirmed',
      intent: { chatId: '7777', variant: 'text' },
      result: null,
    });
  });

  it('TG-06 deletes retained Telegram intent and receipt with its inbox batch', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE owner_event_inbox (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO owner_event_inbox (id) VALUES (?)').run(41);
    const ledger = new OwnerEventEffectLedger(db, () => 1_000);
    const intent = buildOwnerEventTelegramIntent({
      chatId: '7777',
      message: 'bounded body',
      deliveryId: 'owner-event:41:telegram:telegram-delivery',
    });
    ledger.begin(41, 'telegram-delivery', 'telegram_send', intent);
    ledger.confirm(41, 'telegram-delivery', 'telegram_send', {
      version: 1,
      deliveryId: intent.deliveryId,
      variant: 'text',
      state: 'delivered',
      payloadIdentity: 'b'.repeat(64),
      confirmedAt: 1_000,
    });

    db.prepare('DELETE FROM owner_event_inbox WHERE id = ?').run(41);

    expect(ledger.inspect(41, 'telegram-delivery', 'telegram_send')).toBeNull();
  });
});
