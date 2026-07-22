import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';

describe('TelegramMessageLedger', () => {
  it('remembers completed Telegram message IDs across gateway restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');

    new TelegramMessageLedger(path).record('7777:101');

    expect(new TelegramMessageLedger(path).has('7777:101')).toBe(true);
    expect(new TelegramMessageLedger(path).has('7777:102')).toBe(false);
  });

  it('does not suppress an entry after its bounded retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    let now = 1_000;
    const ledger = new TelegramMessageLedger(path, { ttlMs: 100, now: () => now });
    ledger.record('7777:101');
    now = 1_101;

    expect(ledger.has('7777:101')).toBe(false);
  });

  it('persists processing, ready response, and delivered phases across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const first = new TelegramMessageLedger(path);

    expect(first.claim('7777:201').claimed).toBe(true);
    expect(new TelegramMessageLedger(path).get('7777:201')).toMatchObject({
      state: 'processing',
    });

    first.markReady('7777:201', 'durable response');
    expect(new TelegramMessageLedger(path).get('7777:201')).toMatchObject({
      state: 'ready',
      response: 'durable response',
    });

    first.markDelivered('7777:201');
    expect(new TelegramMessageLedger(path).get('7777:201')).toMatchObject({
      state: 'delivered',
    });
    expect(new TelegramMessageLedger(path).get('7777:201')).not.toHaveProperty('response');
    expect(await readFile(path, 'utf8')).not.toContain('durable response');
  });

  it('does not grant a second execution claim for an in-progress message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const first = new TelegramMessageLedger(path);
    first.claim('7777:202');

    expect(new TelegramMessageLedger(path).claim('7777:202')).toMatchObject({
      claimed: false,
      entry: { state: 'processing' },
    });
  });

  it('refuses an oversized ledger without deleting possible undelivered work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    await writeFile(path, 'x'.repeat(8 * 1024 * 1024 + 1));
    const logs: string[] = [];

    expect(() => new TelegramMessageLedger(path, { log: (line) => logs.push(line) })).toThrow(
      'exceeds 8388608 bytes'
    );
    await expect(access(path)).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('message ledger rejected without modification');
    expect(logs[0]).toContain('exceeds 8388608 bytes');
  });

  it('persists confirmed inbound chunk progress for restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const ledger = new TelegramMessageLedger(path);
    ledger.claim('7777:203');
    ledger.markReady('7777:203', 'long response');
    ledger.markDeliveryProgress('7777:203', 2, false);

    expect(new TelegramMessageLedger(path).get('7777:203')).toMatchObject({
      state: 'ready',
      response: 'long response',
      nextChunkIndex: 2,
      deliveryUncertain: false,
    });
  });

  it('rejects a new oversized ready response without dropping existing ready responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const ledger = new TelegramMessageLedger(path, { maxEntries: 20 });
    const response = 'x'.repeat(1_000_000);
    for (let index = 0; index < 8; index += 1) {
      ledger.claim(`7777:${index}`);
      ledger.markReady(`7777:${index}`, response);
    }
    ledger.claim('7777:overflow');

    expect(() => ledger.markReady('7777:overflow', response)).toThrow(
      'Telegram message ledger exceeds its durable size limit'
    );

    const recovered = new TelegramMessageLedger(path, { maxEntries: 20 }).listUndelivered();
    expect(recovered.filter((entry) => entry.state === 'ready')).toHaveLength(8);
    expect(recovered.find((entry) => entry.key === '7777:overflow')).toMatchObject({
      state: 'processing',
    });
  });
});
