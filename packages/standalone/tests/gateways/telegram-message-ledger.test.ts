import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

  it('preserves TG-01/TG-06 outbound delivery bindings across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const key = 'outbound:report-1:text';
    const binding = {
      deliveryTarget: 'telegram:7777',
      payloadIdentity: 'a'.repeat(64),
    };
    const first = new TelegramMessageLedger(path);

    first.claim(key, binding);
    first.markDelivered(key);

    const restarted = new TelegramMessageLedger(path);
    expect(restarted.claim(key, binding)).toMatchObject({
      claimed: false,
      entry: { state: 'delivered', ...binding },
    });
    expect(() => restarted.claim(key, { ...binding, deliveryTarget: 'telegram:8888' })).toThrow(
      /delivery binding mismatch/i
    );
    expect(() => restarted.claim(key, { ...binding, payloadIdentity: 'b'.repeat(64) })).toThrow(
      /delivery binding mismatch/i
    );
  });

  it('TG-01/TG-06 migrates unbound V2 outbound work to safe versioned identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const readyKey = 'outbound:legacy-ready';
    const deliveredKey = 'outbound:legacy-delivered';
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        entries: [
          {
            key: readyKey,
            state: 'ready',
            updatedAt: 1_000,
            ownerId: 'legacy-owner',
            response: JSON.stringify({ version: 1, nextIndex: 1, uncertain: true }),
            nextChunkIndex: 0,
            deliveryUncertain: false,
          },
          {
            key: deliveredKey,
            state: 'delivered',
            updatedAt: 1_001,
            ownerId: 'legacy-owner',
          },
        ],
      })
    );
    const logs: string[] = [];
    const ledger = new TelegramMessageLedger(path, {
      now: () => 2_000,
      log: (line) => logs.push(line),
    });
    const binding = {
      deliveryTarget: 'telegram:7777',
      payloadIdentity: 'c'.repeat(64),
    };

    expect(ledger.claim(readyKey, binding)).toMatchObject({
      claimed: true,
      entry: { state: 'processing', ...binding },
    });
    expect(ledger.claim(deliveredKey, binding)).toMatchObject({
      claimed: true,
      entry: { state: 'processing', ...binding },
    });
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      version: number;
      entries: Array<{ key: string; state: string; deliveryTarget?: string }>;
    };
    expect(persisted.version).toBe(3);
    expect(
      persisted.entries.filter((entry) => entry.key.startsWith('outbound:legacy-unbound:'))
    ).toHaveLength(2);
    expect(
      persisted.entries.filter((entry) => entry.key.startsWith('outbound:legacy-unbound:'))
    ).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'delivered' })]));
    expect(persisted.entries.find((entry) => entry.key === readyKey)).toMatchObject(binding);
    expect(persisted.entries.find((entry) => entry.key === deliveredKey)).toMatchObject(binding);
    expect(logs).toContainEqual(expect.stringMatching(/migrated 2 unbound outbound entr/));
  });

  it('TG-01/TG-06 preserves a valid V2 ledger and fails closed when V3 persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const original = JSON.stringify({
      version: 2,
      entries: [
        {
          key: '7777:legacy-inbound',
          state: 'delivered',
          updatedAt: 1_000,
          ownerId: 'legacy-owner',
        },
        {
          key: 'outbound:legacy-ready',
          state: 'ready',
          updatedAt: 1_001,
          ownerId: 'legacy-owner',
          response: 'prepared response',
        },
      ],
    });
    await writeFile(path, original);
    await mkdir(`${path}.tmp`);
    const logs: string[] = [];

    expect(() => new TelegramMessageLedger(path, { log: (line) => logs.push(line) })).toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await readdir(root)).filter((entry) => entry.includes('.corrupt-'))).toHaveLength(0);
    expect(logs).toContainEqual(expect.stringMatching(/schema upgrade failed; preserved/));
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

describe('TelegramMessageLedger pinning (TG-05/TG-06)', () => {
  it('keeps a pinned delivered entry alive past the retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    let now = 1_000;
    const ledger = new TelegramMessageLedger(path, { ttlMs: 100, now: () => now });
    ledger.claim('outbound:pinned-report', {
      deliveryTarget: 'telegram:777001',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.pin('outbound:pinned-report');
    ledger.markDelivered('outbound:pinned-report');
    ledger.record('7777:unpinned');
    now = 1_201;

    expect(ledger.has('outbound:pinned-report')).toBe(true);
    expect(ledger.has('7777:unpinned')).toBe(false);
  });

  it('exempts pinned entries from delivered-entry eviction under the entry cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const ledger = new TelegramMessageLedger(path, { maxEntries: 2 });
    ledger.claim('outbound:pinned-report', {
      deliveryTarget: 'telegram:777001',
      payloadIdentity: 'a'.repeat(64),
    });
    ledger.pin('outbound:pinned-report');
    ledger.markDelivered('outbound:pinned-report');
    ledger.record('7777:evictable');
    ledger.record('7777:new');

    expect(ledger.has('outbound:pinned-report')).toBe(true);
    expect(ledger.has('7777:evictable')).toBe(false);
  });

  it('persists the pin across restarts and unpins idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    let now = 1_000;
    const first = new TelegramMessageLedger(path, { ttlMs: 100, now: () => now });
    first.claim('outbound:pinned-report', {
      deliveryTarget: 'telegram:777001',
      payloadIdentity: 'a'.repeat(64),
    });
    first.pin('outbound:pinned-report');
    first.markDelivered('outbound:pinned-report');

    now = 1_201;
    const second = new TelegramMessageLedger(path, { ttlMs: 100, now: () => now });
    expect(second.has('outbound:pinned-report')).toBe(true);

    second.unpin('outbound:pinned-report');
    second.unpin('outbound:pinned-report');
    second.unpin('outbound:never-existed');
    expect(second.has('outbound:pinned-report')).toBe(false);
  });

  it('refuses to pin an unclaimed key so a pin always covers a real delivery entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mama-telegram-ledger-'));
    const path = join(root, 'processed.json');
    const ledger = new TelegramMessageLedger(path);

    expect(() => ledger.pin('outbound:missing')).toThrow(/has not been claimed/i);
  });
});
