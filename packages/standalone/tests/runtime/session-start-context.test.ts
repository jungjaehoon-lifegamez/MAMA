import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { readSessionStartInput } from '../../src/runtime/session-start-context.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-start-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const database = await openCoreDatabase({ path: join(root, 'state.db') });
  cleanup.push(() => database.close());
  const raw = new RawStore(join(root, 'raw'));
  cleanup.push(() => raw.close());
  const chat = new ChatSources(raw, database.adapter, 'owner-test', 'agent-test');
  const add = (index: number, delivered = true, principal = 'owner-test') => {
    const store = new ChatSources(raw, database.adapter, principal, 'agent-test');
    const messageRef = `telegram:room-test:${index}`;
    store.saveOwnerMessage({
      id: messageRef,
      channelKey: 'room-test',
      occurredAt: index,
      text: `request ${index}`,
    });
    if (delivered)
      store.saveReply({
        messageRef,
        text: `<b>answer ${index}</b>`,
        occurredAt: index + 1,
        author: 'agent',
        deliveryVerified: true,
      });
    return messageRef;
  };
  return { chat, add };
}

describe('session start context', () => {
  it('reads a verified delivery revision after an unverified backfill reply', async () => {
    const f = await fixture();
    const messageRef = f.add(1, false);
    const reply = {
      messageRef,
      text: 'Recovered reply',
      occurredAt: 2,
      author: 'agent' as const,
      deliveryVerified: false,
    };
    f.chat.saveReply(reply);
    expect(f.chat.exchanges(1, 2)).toEqual([{ at: 1, owner: 'request 1', reply: null }]);
    f.chat.saveReply({ ...reply, occurredAt: 4, deliveryVerified: true });
    expect(f.chat.exchanges(1, 2)).toEqual([
      { at: 1, owner: 'request 1', reply: 'Recovered reply' },
    ]);
    expect(f.chat.recentExchanges('current')).toEqual([
      { at: 1, owner: 'request 1', answer: 'Recovered reply' },
    ]);
  });

  it('reads delivered chat older than seven days, excluding other principals and the current message', async () => {
    const f = await fixture();
    f.add(1);
    f.add(2, false);
    f.chat.saveReply({
      messageRef: 'telegram:room-test:2',
      text: 'Unverified model output',
      occurredAt: 3,
      author: 'agent',
      deliveryVerified: false,
    });
    f.add(3, true, 'member-test');
    const current = f.add(8);
    const now = 30 * 86_400_000;
    const records = [
      { topic: 'older', summary: 'old decision', created_at: 1_000 },
      { topic: 'newer', summary: 'new decision', created_at: 3_600_000 * 2 },
    ] as unknown as MemoryRecord[];
    const input = await readSessionStartInput({
      exchanges: f.chat.recentExchanges(current),
      records: async () => records,
      checkpoint: async () => ({
        summary: 'Mid full report',
        nextSteps: 'publish the board',
        createdAt: 3_600_000,
      }),
      now,
    });
    expect(f.chat.exchanges(2, 3)).toEqual([{ at: 2, owner: 'request 2', reply: null }]);
    expect(input.exchanges).toEqual([{ at: 1, owner: 'request 1', answer: '<b>answer 1</b>' }]);
    expect(input.checkpoint).toEqual({
      summary: 'Mid full report',
      nextSteps: 'publish the board',
      ageHours: (now - 3_600_000) / 3_600_000,
    });
    expect(input.decisions.map((record) => record.topic)).toEqual(['newer', 'older']);
  });

  it('carries only the latest ten delivered exchanges, oldest first', async () => {
    const f = await fixture();
    for (let i = 1; i <= 12; i++) f.add(i);
    expect(f.chat.recentExchanges('current').map((exchange) => exchange.at)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(f.chat.exchanges(4, 6)).toEqual([
      { at: 4, owner: 'request 4', reply: '<b>answer 4</b>' },
      { at: 5, owner: 'request 5', reply: '<b>answer 5</b>' },
    ]);
  });
});
