import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import {
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
});
